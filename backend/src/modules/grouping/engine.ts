import { GroupMode, PlayType, RotationKind, Gender } from '@badminton/shared';

/**
 * 分组引擎（纯函数、可注入 seed、确定性）
 *
 * 目标优先级（与 docs/engine-eval 的验收口径一致）：
 *   1. 出场/轮空均衡（硬约束：任意一轮打完时人人轮空次数差 ≤ 1，中途散场也公平）
 *   2. 体力：连打不超过理论下界 ceil(N/轮空数)−1 再 +1，能避免时不连续两轮轮空
 *   3. 不出现完全相同的对阵；搭档在搭遍可搭档的人之前不重复；对手尽量均摊；相邻两轮少碰同一拨人
 *   4. 混双违例最少（男女不等时由「谁轮空」决定下界），且违例在同性别球友之间均摊
 *   5. 平衡/墨式：两边实力差尽量小（单场差 ≥ 4 明显加价）；美式只拦悬殊对局
 *
 * 流程（每个起点）：
 *   ① planRound 逐轮贪心（每轮若干起点 + 两两交换局部搜索）→ ② optimizeByes 轮空计划退火（可选）→ 按新轮空重排对阵
 *   → ③ annealSchedule 整份赛程模拟退火（对阵换位 + 轮空时机互换）→ ④ orderRounds 轮次排序（相邻两轮少重合）
 * 多个起点使用不同权重侧重（RESTART_PROFILES），用 scheduleQuality 按上面的优先级择优，同分再比未缩放的 totalCost。
 * 搜索预算按「轮数 × 上场位 × (上场位 + 轮空位)」收缩。线上（4 核）：常见规模（8–40 人、2–9 场、≤ 12 轮）0.05–0.3s，
 * 100 人 20 场 30 轮约 1s；分组预览在请求里同步执行，接口限制参赛者 ≤ 200 人。
 *
 * 评测与迭代记录见 docs/engine-eval/README.md，评测脚本 backend/scripts/eval-engine.ts。
 */

// ============ 引擎输入/输出（基于参赛者 id，纯数据，便于单测）============
export interface EnginePlayer {
  id: number;
  weight: number; // 水平权重（levelWeight）
  gender: Gender;
}

export interface EngineSettings {
  playType: PlayType;
  mode: GroupMode;
  rotation?: RotationKind;
  courtCount: number;
  rounds: number;
  mixedDoubles?: boolean;
  seed?: number;
  /** 墨式用：参赛者当前积分（live 重排时传真实积分；preview 缺省用水平权重） */
  standings?: Record<number, number>;
}

export interface EngineTeam {
  ids: number[];
  strength: number;
}
export interface EngineMatch {
  courtNo: number;
  teamA: EngineTeam;
  teamB: EngineTeam;
  strengthGap: number;
}
export interface EngineRound {
  index: number;
  matches: EngineMatch[];
  byes: number[];
}
export interface EngineMetrics {
  totalMatches: number;
  rounds: number;
  appearancesMin: number;
  appearancesMax: number;
  byePerRound: number;
  /** 重复搭档次数（同一对搭档第 2 次起每次计 1） */
  repeatPartnerPairs: number;
  /** 重复对手次数（同一对对手第 2 次起每次计 1） */
  repeatOpponentPairs: number;
  /** 混双约束下未能满足「一男一女」的队伍数（仅 mixedDoubles 双打时累计） */
  mixedViolations: number;
  /** 最长连续上场轮数（无轮空时等于总轮数） */
  maxConsecutivePlays: number;
  /** 完全相同的对阵（同两队）再次出现的次数 */
  sameMatchupRepeats: number;
  /** 同一对搭档最多搭了几次 */
  maxPartnerCount: number;
  /** 同一对对手最多遇了几次 */
  maxOpponentCount: number;
  /** 平均两队实力差 */
  avgStrengthGap: number;
}
export interface EngineSchedule {
  rounds: EngineRound[];
  metrics: EngineMetrics;
}

// ============ 确定性 PRNG（mulberry32）============
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 打散（确定性）。不要用 sort(() => rng()-0.5)：那不是合法比较器，结果依赖实现 */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 两人组合的数值键（id < 2^26 内无碰撞）
const PAIR_BASE = 1 << 26;
const pairKey = (a: number, b: number) => (a < b ? a * PAIR_BASE + b : b * PAIR_BASE + a);
const tri = (c: number) => (c * (c + 1)) / 2; // 已出现 c 次时再来一次的边际代价倍数：第 2、3、4 次出现分别 ×1、×3、×6

function teamSizeOf(playType: PlayType): number {
  return playType === PlayType.DOUBLES ? 2 : 1;
}

const isMale = (g?: Gender) => g === Gender.MALE;
const isFemale = (g?: Gender) => g === Gender.FEMALE;
/** 两人是否「同一已知性别」（混双违例：男男 / 女女；含 UNKNOWN 一律视作可搭配） */
function sameKnownGender(a: number, b: number, genderOf: Map<number, Gender>): boolean {
  const g0 = genderOf.get(a);
  const g1 = genderOf.get(b);
  return (isMale(g0) && isMale(g1)) || (isFemale(g0) && isFemale(g1));
}

// ============ 代价权重（按模式）============
export interface Weights {
  partner: number; // 重复搭档（每对，边际递增）
  opponent: number; // 重复对手（每对，边际递增）
  matchup: number; // 完全相同的对阵再次出现
  four: number; // 同 4 人再同场（拆法不同）
  mixed: number; // 混双违例（男男/女女）
  mixShare: number; // 混双违例在同性别球友之间均摊：某人第 k 次被分进同性队的边际代价 = mixShare·tri(k−1)
  gap: number; // 两队实力差（每权重单位，线性部分）
  gapKnee: number; // 实力差超过这个值后开始二次方加价（差 1 可接受，差 3 以上是"欺负人"）
  gapQuad: number; // 二次方系数
  spread: number; // 同场水平跨度（每权重单位，平衡模式希望相近水平同场）
  streak: number; // 连打达到理论下界那一轮的代价（下界之前不计：那是公平排布本来就要的节奏）
  streakSecond: number; // 连打超过下界 1 轮（评测容差内，但球友已明显累）
  streakOver: number; // 连打超过下界 +1 之后每轮的重罚（体力优先于其他软目标，含混双配齐）
  tally: number; // 轮空者已有轮空次数（轮空少的先歇）
  consecBye: number; // 上一轮刚歇过又歇
  coplay: number; // 轮空计划：两两同场次数偏离期望的平方（让大家同场机会均匀，少场地时尤其重要）
  adjOpponent: number; // 轮次排序：相邻两轮做对手的两人对
  adjPartner: number; // 轮次排序：相邻两轮做搭档
  adjFour: number; // 轮次排序：相邻两轮同 4 人同场
}

function weightsFor(teamSize: number, social: boolean, wantMixed: boolean): Weights {
  const common = { streak: 10, streakSecond: 50, streakOver: 250, tally: 100, consecBye: 150, coplay: 1, adjOpponent: 20, adjPartner: 60, adjFour: 40 };
  // 平衡：差 1 → 8，差 2 → 26，差 3 → 64，差 4 → 122，差 5 → 200（一次重复搭档 60、第二次再 +180）
  // 美式：差 3 → 6，差 4 → 18，差 5 → 50，差 6 → 102，差 8 → 266（社交为主，差 ≤ 3 几乎不管；差 ≥ 6 的一边倒对局要拦）
  const gap = social ? { gap: 2, gapKnee: 3, gapQuad: 10 } : { gap: 8, gapKnee: 1, gapQuad: 10 };
  if (teamSize === 1) {
    // 单打的「对手」就是全部阵容：再碰一次的代价（100）介于差 3 与差 4 之间（平衡）；美式（60）介于差 5 与差 6 之间
    return { ...common, ...gap, partner: 0, opponent: social ? 60 : 100, matchup: 0, four: 0, mixed: 0, mixShare: 0, spread: 0 };
  }
  return {
    ...common,
    ...gap,
    partner: 60,
    opponent: 15,
    matchup: 80,
    four: 20,
    mixed: wantMixed ? 300 : 0,
    mixShare: wantMixed ? 40 : 0,
    spread: social ? 0 : 2,
  };
}

/** 连续上场到第 s 轮时这一轮的体力代价；lb = 理论最短必然连打轮数 ceil(N/轮空数)−1 */
function streakStep(w: Weights, s: number, lb: number): number {
  if (s < lb) return 0;
  if (s === lb) return w.streak;
  if (s === lb + 1) return w.streak + w.streakSecond;
  return w.streak + w.streakSecond + w.streakOver;
}

/**
 * 逐轮轮空公平：维护 cum[p·R + k] = p 在第 0..k 轮的累计轮空数，要求 ∈ [⌊(k+1)·B/N⌋, ⌈(k+1)·B/N⌉]。
 * 「p 在 r1 歇、r2 打」与「q 在 r1 打、r2 歇」互换时，只有 [min, max) 这段轮次的累计数变化：p 与 q 一个 −1 一个 +1。
 */
class PrefixFair {
  readonly cum: Int16Array;
  private readonly lo: Int16Array;
  private readonly hi: Int16Array;
  constructor(N: number, private readonly R: number, B: number, isRest: (p: number, r: number) => boolean) {
    this.cum = new Int16Array(N * R);
    this.lo = new Int16Array(R);
    this.hi = new Int16Array(R);
    for (let k = 0; k < R; k++) {
      this.lo[k] = Math.floor(((k + 1) * B) / N);
      this.hi[k] = Math.ceil(((k + 1) * B) / N);
    }
    for (let p = 0; p < N; p++) {
      let c = 0;
      for (let k = 0; k < R; k++) {
        if (isRest(p, k)) c++;
        this.cum[p * R + k] = c;
      }
    }
  }
  /** p 原本 r1 歇 r2 打、q 原本 r1 打 r2 歇；互换后是否仍逐轮公平 */
  swapOk(p: number, q: number, r1: number, r2: number): boolean {
    const a = Math.min(r1, r2);
    const b = Math.max(r1, r2);
    const dp = r1 < r2 ? -1 : 1; // r1 在前：p 这段少歇一次
    const R = this.R;
    for (let k = a; k < b; k++) {
      const cp = this.cum[p * R + k] + dp;
      const cq = this.cum[q * R + k] - dp;
      if (cp < this.lo[k] || cp > this.hi[k] || cq < this.lo[k] || cq > this.hi[k]) return false;
    }
    return true;
  }
  applySwap(p: number, q: number, r1: number, r2: number): void {
    const a = Math.min(r1, r2);
    const b = Math.max(r1, r2);
    const dp = r1 < r2 ? -1 : 1;
    const R = this.R;
    for (let k = a; k < b; k++) {
      this.cum[p * R + k] += dp;
      this.cum[q * R + k] -= dp;
    }
  }
}

function gapCost(w: Weights, gap: number): number {
  const over = Math.max(0, gap - w.gapKnee);
  return w.gap * gap + w.gapQuad * over * over;
}

/** 择优质量函数里可以关掉的目标（仅评测对照实验用） */
export type QualityTerm = 'gap' | 'repeat' | 'fatigue';
const NO_TERMS_OFF: ReadonlySet<QualityTerm> = new Set();

/** 多起点的权重侧重（乘数） */
interface WeightScale {
  gap?: number;
  spread?: number;
  streak?: number;
}
const RESTART_PROFILES: WeightScale[] = [
  {}, // 默认
  {}, // 默认（不同轮空计划）
  { gap: 0.5, spread: 0, streak: 0.3 }, // 多样性优先：实力差、连打软代价让位于不重复
  { streak: 0 }, // 体力软代价放轻（只保留超下界 +1 的硬罚与连续轮空），小规模局才跑
];

function scaleWeights(w: Weights, f?: WeightScale): Weights {
  if (!f) return w;
  return {
    ...w,
    gap: w.gap * (f.gap ?? 1),
    gapQuad: w.gapQuad * (f.gap ?? 1),
    spread: w.spread * (f.spread ?? 1),
    streak: w.streak * (f.streak ?? 1),
    streakSecond: w.streakSecond * (f.streak ?? 1),
    // streakOver 始终保留：超过理论下界 +1 的连打是体力红线
  };
}

/**
 * 成品赛程质量（越小越好），用于多起点择优。口径与产品验收标准一致、按优先级分档：
 *  体力与公平（连打超过理论下界 +1、可避免的连续轮空）≫ 完全相同的对阵 ≈ 搭档超过下界 ≈ 混双违例
 *  ≈ 平衡模式单场实力差 ≥ 5 ≫ 对手超过下界 +1 ≈ 单场差 4 ≈ 平均差超 1 ≫ 重复总量与实力差总量（细分平手）；
 *  美式只对单场差 ≥ 6 的一边倒对局加价。
 * 下界：连打 ceil(N/轮空数)−1；某人搭档次数 ceil(出场/可搭档人数)；对手次数 ceil(对手位/(N−1))。
 */
function scheduleQuality(
  players: EnginePlayer[],
  settings: EngineSettings,
  rounds: EngineRound[],
  teamSize: number,
  byeCount: number,
  off: ReadonlySet<QualityTerm> = NO_TERMS_OFF,
): number {
  const useFatigue = !off.has('fatigue');
  const useRepeat = !off.has('repeat');
  const useGap = !off.has('gap');
  const N = players.length;
  const R = rounds.length;
  if (!R || rounds[0].matches.length === 0) return 0;
  const gender = new Map(players.map((p) => [p.id, p.gender]));
  const weight = new Map(players.map((p) => [p.id, p.weight]));
  const wantMixed = teamSize === 2 && !!settings.mixedDoubles;
  const balanceMode = !(settings.mode === GroupMode.ROTATION && settings.rotation === RotationKind.AMERICANO);
  let q = 0;

  // 体力：连打与连续轮空
  const lb = byeCount === 0 ? R : Math.min(R, Math.ceil(N / byeCount) - 1);
  const avoidConsec = byeCount > 0 && byeCount * 2 < N;
  const apps = new Map<number, number>(players.map((p) => [p.id, 0]));
  for (const p of players) {
    let s = 0;
    for (let r = 0; r < R; r++) {
      if (rounds[r].byes.includes(p.id)) {
        if (avoidConsec && r > 0 && rounds[r - 1].byes.includes(p.id)) q += 3000;
        s = 0;
      } else {
        s++;
        apps.set(p.id, apps.get(p.id)! + 1);
        if (useFatigue && byeCount > 0 && s > lb + 1) q += 5000;
      }
    }
  }

  // 重复与混双、实力差
  const partner = new Map<number, number>();
  const opponent = new Map<number, number>();
  const matchup = new Map<string, number>();
  const pk = (a: number, b: number) => (a < b ? a * PAIR_BASE + b : b * PAIR_BASE + a);
  let gapSum = 0;
  let gapOver = 0;
  let matches = 0;
  let violations = 0;
  for (const r of rounds)
    for (const m of r.matches) {
      matches++;
      const A = m.teamA.ids;
      const B = m.teamB.ids;
      if (teamSize === 2) {
        bump(partner, pk(A[0], A[1]));
        bump(partner, pk(B[0], B[1]));
        if (wantMixed) {
          if (sameKnownGender(A[0], A[1], gender)) violations++;
          if (sameKnownGender(B[0], B[1], gender)) violations++;
        }
      }
      for (const a of A) for (const b of B) bump(opponent, pk(a, b));
      const ka = [...A].sort((x, y) => x - y).join(',');
      const kb = [...B].sort((x, y) => x - y).join(',');
      bump(matchup, ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
      const sa = A.reduce((t, id) => t + weight.get(id)!, 0);
      const sb = B.reduce((t, id) => t + weight.get(id)!, 0);
      const g = Math.abs(sa - sb);
      gapSum += g;
      if (g > 3) gapOver += (g - 3) * (g - 3); // 差 4 → 1、差 5 → 4、差 6 → 9
    }
  if (useRepeat) for (const v of matchup.values()) if (v > 1) q += 2000 * (v - 1);
  q += 1500 * violations;
  if (wantMixed && violations > 0) {
    // 违例在同性别球友之间均摊：同一性别里被分进同性队的次数差超过 1 的部分加价
    const vc = new Map<number, number>(players.map((p) => [p.id, 0]));
    for (const r of rounds)
      for (const m of r.matches)
        for (const T of [m.teamA.ids, m.teamB.ids])
          if (T.length === 2 && sameKnownGender(T[0], T[1], gender)) T.forEach((id) => vc.set(id, vc.get(id)! + 1));
    for (const g of [Gender.MALE, Gender.FEMALE]) {
      const xs = players.filter((p) => p.gender === g).map((p) => vc.get(p.id)!);
      if (xs.length > 1) q += 300 * Math.max(0, Math.max(...xs) - Math.min(...xs) - 1);
    }
  }

  // 相邻两轮碰同一对手/搭档（刚打完又碰上）
  for (let r = 1; useRepeat && r < R; r++) {
    const prevOpp = new Set<number>();
    const prevPtn = new Set<number>();
    for (const m of rounds[r - 1].matches) {
      for (const a of m.teamA.ids) for (const b of m.teamB.ids) prevOpp.add(pk(a, b));
      for (const T of [m.teamA.ids, m.teamB.ids]) if (T.length === 2) prevPtn.add(pk(T[0], T[1]));
    }
    for (const m of rounds[r].matches) {
      for (const a of m.teamA.ids) for (const b of m.teamB.ids) if (prevOpp.has(pk(a, b))) q += 40;
      for (const T of [m.teamA.ids, m.teamB.ids]) if (T.length === 2 && prevPtn.has(pk(T[0], T[1]))) q += 150;
    }
  }

  const males = players.filter((p) => isMale(p.gender)).length;
  const females = players.filter((p) => isFemale(p.gender)).length;
  const eligible = (id: number) => {
    const g = gender.get(id);
    if (!wantMixed || (!isMale(g) && !isFemale(g))) return N - 1;
    return isMale(g) ? N - males : N - females;
  };
  const partnerMax = new Map<number, number>();
  const oppMax = new Map<number, number>();
  for (const [k, v] of partner) {
    const a = Math.floor(k / PAIR_BASE);
    const b = k % PAIR_BASE;
    for (const x of [a, b]) partnerMax.set(x, Math.max(partnerMax.get(x) ?? 0, v));
    if (useRepeat && v > 1) q += 30 * (v - 1);
  }
  for (const [k, v] of opponent) {
    const a = Math.floor(k / PAIR_BASE);
    const b = k % PAIR_BASE;
    for (const x of [a, b]) oppMax.set(x, Math.max(oppMax.get(x) ?? 0, v));
    if (useRepeat && v > 1) q += 8 * (v - 1);
  }
  for (const p of players) {
    const app = apps.get(p.id)!;
    if (!app || !useRepeat) continue;
    if (teamSize === 2) {
      const plb = Math.ceil(app / Math.max(1, eligible(p.id)));
      q += 1500 * Math.max(0, (partnerMax.get(p.id) ?? 0) - plb);
    }
    const olb = Math.ceil((app * teamSize) / Math.max(1, N - 1));
    q += 600 * Math.max(0, (oppMax.get(p.id) ?? 0) - olb - 1);
  }

  if (!useGap) {
    // 评测对照：不看实力差
  } else if (balanceMode) {
    const avg = gapSum / matches;
    q += 800 * Math.max(0, avg - 1) + 700 * gapOver + 4 * gapSum;
  } else {
    // 美式不追求势均力敌，但单场差 ≥ 6（如 L6+L5 打 L2+L1）是一边倒，按平方加价
    let blowout = 0;
    for (const r of rounds)
      for (const m of r.matches) if (m.strengthGap >= 6) blowout += (m.strengthGap - 5) * (m.strengthGap - 5);
    q += 400 * blowout + 1 * gapSum;
  }
  return q;
}

// ============ 跨轮状态 ============
interface State {
  appearances: Map<number, number>;
  byeTally: Map<number, number>;
  streak: Map<number, number>; // 当前连续上场轮数
  partnerCount: Map<number, number>;
  opponentCount: Map<number, number>;
  matchupCount: Map<number, number>;
  fourCount: Map<number, number>;
  /** 每人被分进同性队（混双违例）的次数 */
  violCount: Map<number, number>;
  gender: Map<number, Gender>;
  /** 对阵键进制 = 参赛人数 */
  K: number;
}

function newState(players: EnginePlayer[]): State {
  return {
    appearances: new Map(players.map((p) => [p.id, 0])),
    byeTally: new Map(players.map((p) => [p.id, 0])),
    streak: new Map(players.map((p) => [p.id, 0])),
    partnerCount: new Map(),
    opponentCount: new Map(),
    matchupCount: new Map(),
    fourCount: new Map(),
    violCount: new Map(),
    gender: new Map(players.map((p) => [p.id, p.gender])),
    K: Math.max(2, players.length),
  };
}

const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * 对阵键（数值）：内部 id 是 0..N−1 的下标，按 K 进制编码。
 * matchup = 两队各自排序后的「队伍键」再排序拼接；four = 同场全部人排序拼接。K ≤ 9490 时不超出安全整数。
 */
function matchupKeys(A: number[], B: number[], K: number): { matchup: number; four: number } {
  const team = (T: number[]) => (T.length === 1 ? T[0] : T[0] < T[1] ? T[0] * K + T[1] : T[1] * K + T[0]);
  const ta = team(A);
  const tb = team(B);
  const base = A.length === 1 ? K : K * K;
  const all = [...A, ...B].sort((x, y) => x - y);
  let four = 0;
  for (const x of all) four = four * K + x;
  return { matchup: ta < tb ? ta * base + tb : tb * base + ta, four };
}

// 每轮排布完成后记账（也是单轮代价函数的数据来源）
function record(st: State, matches: EngineMatch[], byes: number[]) {
  for (const id of byes) {
    bump(st.byeTally, id);
    st.streak.set(id, 0);
  }
  for (const m of matches) {
    for (const T of [m.teamA.ids, m.teamB.ids]) {
      for (const id of T) {
        bump(st.appearances, id);
        bump(st.streak, id);
      }
      for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) bump(st.partnerCount, pairKey(T[i], T[j]));
      if (T.length === 2 && sameKnownGender(T[0], T[1], st.gender)) {
        bump(st.violCount, T[0]);
        bump(st.violCount, T[1]);
      }
    }
    for (const a of m.teamA.ids) for (const b of m.teamB.ids) bump(st.opponentCount, pairKey(a, b));
    const k = matchupKeys(m.teamA.ids, m.teamB.ids, st.K);
    bump(st.matchupCount, k.matchup);
    bump(st.fourCount, k.four);
  }
}

// ============ 主入口 ============
const SCHEDULE_RESTARTS = 3; // 中等规模的整份赛程起点数（小规模跑满 RESTART_PROFILES，大规模收缩到 2/1）
const ROUND_RESTARTS = 4; // 小规模（上场位 ≤ 16）时每轮局部搜索的起点数；≤ 32 时 2 个，更大 1 个
// 模拟退火预算：迭代数 = (上场位 + 轮空位) × 轮数 × 系数，夹在上下限之间
const ANNEAL_ITERS_PER_SLOT = 60;
const ANNEAL_MIN_ITERS = 3000;
const ANNEAL_MAX_ITERS = 40000;
const ANNEAL_T0 = 40; // 初温 ≈ 一次重复搭档代价的 2/3
const ANNEAL_T1 = 0.5;
const ANNEAL_JOINT_SHARE = 0.3; // 有轮空时，三成动作用于「轮空时机互换」
const BYE_ANNEAL_ITERS_PER_CELL = 40;
const BYE_ANNEAL_MIN_ITERS = 2000;
const BYE_ANNEAL_MAX_ITERS = 30000;
const BYE_ANNEAL_T0 = 60;
const BYE_ANNEAL_T1 = 0.5;
const ORDER_ITERS_PER_PAIR = 60; // 轮次排序退火：迭代数 = 系数 × 轮数²，上限见下
const ORDER_MAX_ITERS = 6000;
const ORDER_WORK_BUDGET = 3_000_000; // 轮次排序：迭代数 × 单次评估量 的上限
const ORDER_T0 = 30;
const ORDER_T1 = 0.3;

/**
 * 评测/调参用的内部选项（线上调用不传），用于对照实验证明目标之间的取舍：
 * weights 覆盖基础代价权重（在各起点的侧重乘数之前生效）；qualityOff 同时从择优函数里拿掉对应目标。
 */
export interface EngineTuning {
  weights?: Partial<Weights>;
  qualityOff?: QualityTerm[];
}

export function generateSchedule(inputPlayers: EnginePlayer[], inputSettings: EngineSettings, tuning?: EngineTuning): EngineSchedule {
  // 内部一律用 0..N−1 的下标当 id（计数表可用紧凑的数值键），输出前再映射回真实参赛者 id
  const players: EnginePlayer[] = inputPlayers.map((p, i) => ({ id: i, weight: p.weight, gender: p.gender }));
  let standings: Record<number, number> | undefined;
  if (inputSettings.standings) {
    const known = inputPlayers.map((p) => inputSettings.standings![p.id]).filter((v): v is number => v != null);
    if (known.length) {
      // 积分只覆盖部分人（新来的 Guest、刚归队的人）时，缺的人按已知积分的中位数补：
      // 不能回退成水平权重（1–6），那和积分不是一个量纲，会被整体排到最后一片或第一片场地
      const sorted = [...known].sort((a, b) => a - b);
      const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      standings = {};
      inputPlayers.forEach((p, i) => (standings![i] = inputSettings.standings![p.id] ?? median));
    }
  }
  const settings: EngineSettings = { ...inputSettings, standings };
  const teamSize = teamSizeOf(settings.playType);
  const perCourt = teamSize * 2;
  const N = players.length;
  const matchesPerRound = Math.min(settings.courtCount, Math.floor(N / perCourt));
  const byeCount = N - matchesPerRound * perCourt;
  const baseSeed = settings.seed ?? 42;
  const qualityOff: ReadonlySet<QualityTerm> = new Set(tuning?.qualityOff ?? []);

  // 搜索预算按规模收缩：逐轮贪心每轮要试「上场位×上场位」与「上场位×轮空位」两类交换，大局靠整体退火兜底
  const P = matchesPerRound * perCourt;
  const work = settings.rounds * P * (P + byeCount);
  const scheduleRestarts = work <= 3000 ? RESTART_PROFILES.length : work <= 8000 ? SCHEDULE_RESTARTS : work <= 40000 ? 2 : 1;
  let best: { rounds: EngineRound[]; cost: number; quality: number } | null = null;
  for (let k = 0; k < scheduleRestarts; k++) {
    const rng = mulberry32(baseSeed + k * 7919);
    // 起点 0：逐轮贪心轮空 + 默认侧重；起点 1：轮空计划退火 + 默认侧重；起点 2：+ 多样性优先侧重；起点 3：+ 体力软代价放轻。
    // 各起点代价口径不同，最后统一用 scheduleQuality（与验收口径一致的质量函数）择优
    const profile = RESTART_PROFILES[k % RESTART_PROFILES.length];
    const built = buildSchedule(players, settings, teamSize, matchesPerRound, byeCount, rng, k > 0 || scheduleRestarts === 1, tuning, profile);
    const quality = scheduleQuality(players, settings, built.rounds, teamSize, byeCount, qualityOff);
    if (!best || quality < best.quality - 1e-9 || (Math.abs(quality - best.quality) <= 1e-9 && built.cost < best.cost)) {
      best = { ...built, quality };
    }
  }
  const internal = best!.rounds;
  const metrics = computeMetrics(players, settings, internal, byeCount, teamSize);
  const realId = (i: number) => inputPlayers[i].id;
  const rounds: EngineRound[] = internal.map((r) => ({
    index: r.index,
    byes: r.byes.map(realId),
    matches: r.matches.map((m) => ({
      courtNo: m.courtNo,
      teamA: { ids: m.teamA.ids.map(realId), strength: m.teamA.strength },
      teamB: { ids: m.teamB.ids.map(realId), strength: m.teamB.strength },
      strengthGap: m.strengthGap,
    })),
  }));
  return { rounds, metrics };
}

interface Ctx {
  players: EnginePlayer[];
  teamSize: number;
  perCourt: number;
  matchesPerRound: number;
  byeCount: number;
  totalRounds: number;
  genderOf: Map<number, Gender>;
  weightOf: Map<number, number>;
  wantMixed: boolean;
  isMexicano: boolean;
  lockCourts: boolean;
  w: Weights;
  settings: EngineSettings;
  /** 混双且男女人数不等时：人多的性别（其余情况 null）。其轮空额度按轮均摊，见 planRound */
  dominant: Gender | null;
}

function buildSchedule(
  players: EnginePlayer[],
  settings: EngineSettings,
  teamSize: number,
  matchesPerRound: number,
  byeCount: number,
  rng: () => number,
  planByes: boolean,
  tuning?: EngineTuning,
  profile?: WeightScale,
): { rounds: EngineRound[]; cost: number } {
  const isRotation = settings.mode === GroupMode.ROTATION;
  const isAmericano = isRotation && settings.rotation === RotationKind.AMERICANO;
  const isMexicano = isRotation && settings.rotation === RotationKind.MEXICANO;
  const wantMixed = teamSize === 2 && !!settings.mixedDoubles;
  const ctx: Ctx = {
    players,
    teamSize,
    perCourt: teamSize * 2,
    matchesPerRound,
    byeCount,
    totalRounds: settings.rounds,
    genderOf: new Map(players.map((p) => [p.id, p.gender])),
    weightOf: new Map(players.map((p) => [p.id, p.weight])),
    wantMixed,
    isMexicano,
    // 墨式只有拿到真实积分时才「按排名锁场地」；preview 无积分时退化为带轮换的平衡排布
    lockCourts: isMexicano && !!settings.standings && Object.keys(settings.standings).length > 0,
    w: scaleWeights({ ...weightsFor(teamSize, isAmericano, wantMixed), ...(tuning?.weights ?? {}) }, profile),
    settings,
    dominant: dominantGender(players, wantMixed, byeCount),
  };
  // ① 逐轮贪心：每轮在「轮空公平硬约束」内挑轮空与对阵，给后面的整体优化一个像样的起点
  const st = newState(players);
  const rounds: EngineRound[] = [];
  for (let r = 1; r <= settings.rounds; r++) {
    if (matchesPerRound === 0) {
      rounds.push({ index: r, matches: [], byes: players.map((p) => p.id) });
      continue;
    }
    const { matches, byes } = planRound(ctx, st, r, rng);
    record(st, matches, byes);
    rounds.push({ index: r, matches, byes });
  }

  // ② 轮空计划整体退火：保持每人轮空次数不变，只调整「什么时候歇」，再按新轮空重排对阵
  if (planByes && matchesPerRound > 0 && byeCount > 0 && settings.rounds >= 2) {
    const plan = optimizeByes(ctx, rounds.map((r) => r.byes), rng);
    const changed = plan.some((b, i) => b.length !== rounds[i].byes.length || b.some((id) => !rounds[i].byes.includes(id)));
    if (changed) {
      const st2 = newState(players);
      for (let r = 1; r <= settings.rounds; r++) {
        const { matches, byes } = planRound(ctx, st2, r, rng, plan[r - 1]);
        record(st2, matches, byes);
        rounds[r - 1] = { index: r, matches, byes };
      }
    }
  }

  // ③ 整份赛程退火：对阵换位 + 轮空时机互换
  annealSchedule(ctx, rounds, rng);
  // ④ 轮次排序：总次数不变，只让相邻两轮尽量不碰同一对手/搭档（体力代价一并守住）
  orderRounds(ctx, rounds, rng);
  // 多起点同分时用的代价：统一按未缩放的基础权重、对成品（排序之后）重算，各起点之间才可比
  const baseW = { ...weightsFor(teamSize, isAmericano, wantMixed), ...(tuning?.weights ?? {}) };
  return { rounds, cost: totalCost({ ...ctx, w: baseW }, rounds) };
}

// ============ 轮空计划退火：人人轮空次数不变，只调整轮空时机 ============
/**
 * 逐轮贪心决定轮空时只看眼前：混双男女不等时会先把多数性别歇满，少数性别到后面一口气连打；
 * 1 片场地时也可能让同一拨人反复同场。这里把整张「谁在哪轮歇」的表当整体优化：
 * 动作 = 选 p 在 r1 歇、r2 打，选 q 在 r1 打、r2 歇，两人互换这两轮的状态（人人轮空总次数不变；逐轮公平由 PrefixFair 检查）。
 * 目标 = 连打代价（见 streakStep）+ 连续轮空 + 每轮混双最少违例数 + 两两同场次数的方差。
 * 每轮混双最少违例数 = max(0, (|上场男 − 上场女| − 上场未知)/2)，与之后怎么组队无关，是可达下界。
 */
function optimizeByes(ctx: Ctx, byesByRound: number[][], rng: () => number): number[][] {
  const { players, byeCount, totalRounds: R, w, wantMixed, matchesPerRound, perCourt } = ctx;
  const N = players.length;
  const P = matchesPerRound * perCourt;
  const idx = new Map<number, number>(players.map((p, i) => [p.id, i]));
  const gd = players.map((p) => (isMale(p.gender) ? 1 : isFemale(p.gender) ? 2 : 0));
  const rest = new Uint8Array(N * R);
  byesByRound.forEach((b, r) => b.forEach((id) => (rest[idx.get(id)! * R + r] = 1)));
  const streakLB = Math.min(R, Math.ceil(N / byeCount) - 1);

  const runCost = (p: number): number => {
    let c = 0;
    let s = 0;
    for (let r = 0; r < R; r++) {
      if (rest[p * R + r]) {
        if (r > 0 && rest[p * R + r - 1]) c += w.consecBye;
        s = 0;
      } else {
        s++;
        c += streakStep(w, s, streakLB);
      }
    }
    return c;
  };

  // 每轮上场性别计数
  const cnt = new Int32Array(R * 3);
  for (let r = 0; r < R; r++) for (let p = 0; p < N; p++) if (!rest[p * R + r]) cnt[r * 3 + gd[p]]++;
  const viol = (r: number) => {
    if (!wantMixed) return 0;
    const U = cnt[r * 3];
    const M = cnt[r * 3 + 1];
    const F = cnt[r * 3 + 2];
    return Math.max(0, (Math.abs(M - F) - U) / 2);
  };

  // 两两同场次数（偏离期望越多越贵）
  const cop = new Int16Array(N * N);
  for (let r = 0; r < R; r++)
    for (let a = 0; a < N; a++) {
      if (rest[a * R + r]) continue;
      for (let b = a + 1; b < N; b++) if (!rest[b * R + r]) {
        cop[a * N + b]++;
        cop[b * N + a]++;
      }
    }
  const expected = (R * P * (P - 1)) / (N * (N - 1));
  const wCo = w.coplay;
  /** 切换 p 在 r 轮的上场状态，返回同场方差项的变化；调用前 rest 仍是旧状态 */
  const toggle = (p: number, r: number): number => {
    let d = 0;
    const toPlay = rest[p * R + r] === 1;
    for (let q = 0; q < N; q++) {
      if (q === p || rest[q * R + r]) continue;
      const c = cop[p * N + q];
      if (toPlay) {
        d += wCo * (2 * (c - expected) + 1);
        cop[p * N + q] = c + 1;
        cop[q * N + p] = c + 1;
      } else {
        d += wCo * (-2 * (c - expected) + 1);
        cop[p * N + q] = c - 1;
        cop[q * N + p] = c - 1;
      }
    }
    rest[p * R + r] = toPlay ? 0 : 1;
    cnt[r * 3 + gd[p]] += toPlay ? 1 : -1;
    return d;
  };

  const tally = new Int32Array(N);
  for (let p = 0; p < N; p++) for (let r = 0; r < R; r++) tally[p] += rest[p * R + r];
  const fair = new PrefixFair(N, R, byeCount, (pp, rr) => rest[pp * R + rr] === 1);
  const iters = Math.min(BYE_ANNEAL_MAX_ITERS, Math.max(BYE_ANNEAL_MIN_ITERS, BYE_ANNEAL_ITERS_PER_CELL * N * R));
  let bestRest = rest.slice();
  let cost = 0;
  let bestCost = 0; // 相对值即可
  const T0 = BYE_ANNEAL_T0;
  const T1 = BYE_ANNEAL_T1;
  const cand = new Int32Array(N);
  for (let it = 0; it < iters; it++) {
    const T = T0 * Math.pow(T1 / T0, it / iters);
    const p = Math.floor(rng() * N);
    if (tally[p] === 0 || tally[p] === R) continue;
    let r1 = Math.floor(rng() * R);
    while (!rest[p * R + r1]) r1 = Math.floor(rng() * R);
    let r2 = Math.floor(rng() * R);
    while (rest[p * R + r2]) r2 = Math.floor(rng() * R);
    let nc = 0;
    for (let q = 0; q < N; q++) if (q !== p && !rest[q * R + r1] && rest[q * R + r2]) cand[nc++] = q;
    if (!nc) continue;
    const q = cand[Math.floor(rng() * nc)];
    if (!fair.swapOk(p, q, r1, r2)) continue;

    const before = runCost(p) + runCost(q) + w.mixed * (viol(r1) + viol(r2));
    let d = 0;
    d += toggle(q, r1); // q: r1 打 → 歇
    d += toggle(p, r1); // p: r1 歇 → 打
    d += toggle(p, r2); // p: r2 打 → 歇
    d += toggle(q, r2); // q: r2 歇 → 打
    const after = runCost(p) + runCost(q) + w.mixed * (viol(r1) + viol(r2));
    d += after - before;
    if (d <= 0 || rng() < Math.exp(-d / T)) {
      cost += d;
      fair.applySwap(p, q, r1, r2);
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestRest = rest.slice();
      }
    } else {
      toggle(q, r2);
      toggle(p, r2);
      toggle(p, r1);
      toggle(q, r1);
    }
  }
  const out: number[][] = [];
  for (let r = 0; r < R; r++) {
    const b: number[] = [];
    // 保持原轮空名单里的顺序习惯：按参赛者输入顺序输出
    for (let p = 0; p < N; p++) if (bestRest[p * R + r]) b.push(players[p].id);
    out.push(b);
  }
  return out;
}

// ============ 回炉：整份赛程模拟退火（对阵换位 + 轮空时机互换）============
/**
 * 逐轮贪心看不见后面几轮。回炉把整份赛程当一个整体优化，两种动作：
 *  ① 同一轮里两个上场位互换（改搭档/对手/场地）；
 *  ② 轮空时机互换：p 在 r1 歇、r2 打，q 在 r1 打、r2 歇 → p 顶 q 在 r1 的位置，q 顶 p 在 r2 的位置。
 *     人人轮空总次数不变、逐轮公平由 PrefixFair 检查，谁和谁同轮上场可以随对阵质量一起调整。
 * 目标 = 对阵代价（搭档/对手/阵容重复、实力差、混双违例）+ 体力代价（连打、连续轮空），与多起点比较口径一致。
 * 代价口径与逐轮贪心一致：同一对搭档第 k 次出现的边际代价 = partner·tri(k−1)，对手同理，
 * 同阵容/同 4 人第 k 次出现的边际代价 = matchup/four·(k−1)。按 Metropolis 准则接受，全程记住最好的一份。
 */
function annealSchedule(ctx: Ctx, rounds: EngineRound[], rng: () => number): void {
  const { players, teamSize, perCourt, w, wantMixed, lockCourts, byeCount } = ctx;
  const N = players.length;
  const idx = new Map<number, number>(players.map((p, i) => [p.id, i]));
  const wt = players.map((p) => p.weight);
  const gd = players.map((p) => (isMale(p.gender) ? 1 : isFemale(p.gender) ? 2 : 0));
  if (!rounds.length || rounds.some((r) => r.matches.length === 0)) return;
  const R = rounds.length;
  const M = rounds[0].matches.length;
  const P = M * perCourt;
  const B = byeCount;
  // sl[r]：上场位 0..P-1；by[r]：轮空位 0..B-1；pos[r·N+p]：p 在 r 轮的位置（< P 上场，≥ P 为轮空位 P+k）
  const sl: Int32Array[] = [];
  const by: Int32Array[] = [];
  const pos = new Int32Array(R * N);
  rounds.forEach((r, ri) => {
    const a = new Int32Array(P);
    let k = 0;
    for (const m of r.matches) for (const id of [...m.teamA.ids, ...m.teamB.ids]) a[k++] = idx.get(id)!;
    const b = new Int32Array(B);
    r.byes.forEach((id, j) => (b[j] = idx.get(id)!));
    sl.push(a);
    by.push(b);
    for (let i = 0; i < P; i++) pos[ri * N + a[i]] = i;
    for (let j = 0; j < B; j++) pos[ri * N + b[j]] = P + j;
  });

  const partner = new Int32Array(N * N);
  const opponent = new Int32Array(N * N);
  const violCnt = new Int32Array(N);
  const matchup = new Map<number, number>();
  const four = new Map<number, number>();
  const pk = (a: number, b: number) => (a < b ? a * N + b : b * N + a);
  const NN = N * N;

  const local = (a: Int32Array, m: number): number => {
    const b = m * perCourt;
    let sA = 0;
    let sB = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < perCourt; k++) {
      const v = wt[a[b + k]];
      if (k < teamSize) sA += v;
      else sB += v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    let c = gapCost(w, Math.abs(sA - sB));
    if (w.spread) c += w.spread * (hi - lo);
    if (wantMixed) {
      const g0 = gd[a[b]];
      const g1 = gd[a[b + 1]];
      const g2 = gd[a[b + 2]];
      const g3 = gd[a[b + 3]];
      if (g0 !== 0 && g0 === g1) c += w.mixed;
      if (g2 !== 0 && g2 === g3) c += w.mixed;
    }
    return c;
  };

  // 计数增减（提到热循环外，避免每次调用都新建闭包）
  let acc = 0;
  let sgn: 1 | -1 = 1;
  const bumpArr = (arr: Int32Array, k: number, wgt: number) => {
    if (!wgt) return;
    if (sgn > 0) {
      const c = arr[k];
      acc += wgt * tri(c);
      arr[k] = c + 1;
    } else {
      const c = arr[k] - 1;
      arr[k] = c;
      acc -= wgt * tri(c);
    }
  };
  const bumpMap = (mp: Map<number, number>, k: number, wgt: number) => {
    if (!wgt) return;
    if (sgn > 0) {
      const c = mp.get(k) ?? 0;
      acc += wgt * c;
      mp.set(k, c + 1);
    } else {
      const c = (mp.get(k) ?? 1) - 1;
      if (c === 0) mp.delete(k);
      else mp.set(k, c);
      acc -= wgt * c;
    }
  };

  /** 把第 m 场的计数加上(sign=+1)或撤掉(sign=−1)，返回计数类代价的变化 */
  const apply = (a: Int32Array, m: number, sign: 1 | -1): number => {
    const b = m * perCourt;
    acc = 0;
    sgn = sign;
    if (teamSize === 2) {
      const a0 = a[b];
      const a1 = a[b + 1];
      const b0 = a[b + 2];
      const b1 = a[b + 3];
      bumpArr(partner, pk(a0, a1), w.partner);
      bumpArr(partner, pk(b0, b1), w.partner);
      if (wantMixed) {
        if (gd[a0] !== 0 && gd[a0] === gd[a1]) {
          bumpArr(violCnt, a0, w.mixShare);
          bumpArr(violCnt, a1, w.mixShare);
        }
        if (gd[b0] !== 0 && gd[b0] === gd[b1]) {
          bumpArr(violCnt, b0, w.mixShare);
          bumpArr(violCnt, b1, w.mixShare);
        }
      }
      bumpArr(opponent, pk(a0, b0), w.opponent);
      bumpArr(opponent, pk(a0, b1), w.opponent);
      bumpArr(opponent, pk(a1, b0), w.opponent);
      bumpArr(opponent, pk(a1, b1), w.opponent);
      const ta = pk(a0, a1);
      const tb = pk(b0, b1);
      bumpMap(matchup, ta < tb ? ta * NN + tb : tb * NN + ta, w.matchup);
      let q0 = a0;
      let q1 = a1;
      let q2 = b0;
      let q3 = b1;
      let t: number;
      if (q0 > q1) { t = q0; q0 = q1; q1 = t; }
      if (q2 > q3) { t = q2; q2 = q3; q3 = t; }
      if (q0 > q2) { t = q0; q0 = q2; q2 = t; }
      if (q1 > q3) { t = q1; q1 = q3; q3 = t; }
      if (q1 > q2) { t = q1; q1 = q2; q2 = t; }
      bumpMap(four, ((q0 * N + q1) * N + q2) * N + q3, w.four);
    } else {
      bumpArr(opponent, pk(a[b], a[b + 1]), w.opponent);
    }
    return acc;
  };

  // 体力代价：逐人逐轮（与 fatigueCost 同口径，轮空次数项在互换下恒定，故省略）
  const streakLB = B === 0 ? R : Math.min(R, Math.ceil(N / B) - 1);
  const runCost = (p: number): number => {
    let c = 0;
    let s = 0;
    for (let r = 0; r < R; r++) {
      if (pos[r * N + p] >= P) {
        if (r > 0 && pos[(r - 1) * N + p] >= P) c += w.consecBye;
        s = 0;
      } else {
        s++;
        c += streakStep(w, s, streakLB);
      }
    }
    return c;
  };

  let cost = 0;
  for (let r = 0; r < R; r++)
    for (let m = 0; m < M; m++) {
      cost += apply(sl[r], m, 1);
      cost += local(sl[r], m);
    }
  if (B > 0) for (let p = 0; p < N; p++) cost += runCost(p);
  const startCost = cost;
  let bestCost = cost;
  let bestSl = sl.map((a) => a.slice());
  let bestBy = by.map((a) => a.slice());

  const snapshot = () => {
    bestSl = sl.map((a) => a.slice());
    bestBy = by.map((a) => a.slice());
  };

  const iters = Math.min(ANNEAL_MAX_ITERS, Math.max(ANNEAL_MIN_ITERS, ANNEAL_ITERS_PER_SLOT * R * (P + B)));
  const T0 = ANNEAL_T0;
  const T1 = ANNEAL_T1;
  const jointOk = B > 0 && R >= 2 && !lockCourts;
  const fair = jointOk ? new PrefixFair(N, R, B, (pp, rr) => pos[rr * N + pp] >= P) : null;
  for (let it = 0; it < iters; it++) {
    const T = T0 * Math.pow(T1 / T0, it / iters);
    if (jointOk && rng() < ANNEAL_JOINT_SHARE) {
      // ② 轮空时机互换
      const r1 = Math.floor(rng() * R);
      const k1 = Math.floor(rng() * B);
      const p = by[r1][k1];
      let r2 = Math.floor(rng() * (R - 1));
      if (r2 >= r1) r2++;
      const i2 = pos[r2 * N + p];
      if (i2 >= P) continue; // p 在 r2 也歇
      const k2 = Math.floor(rng() * B);
      const q = by[r2][k2];
      const i1 = pos[r1 * N + q];
      if (i1 >= P) continue; // q 在 r1 也歇
      if (!fair!.swapOk(p, q, r1, r2)) continue; // 逐轮轮空公平
      const c1 = Math.floor(i1 / perCourt);
      const c2 = Math.floor(i2 / perCourt);
      const before = runCost(p) + runCost(q);
      let d = -local(sl[r1], c1) + apply(sl[r1], c1, -1) - local(sl[r2], c2) + apply(sl[r2], c2, -1);
      const doSwap = () => {
        const tp = sl[r1][i1];
        sl[r1][i1] = by[r1][k1];
        by[r1][k1] = tp;
        const tq = sl[r2][i2];
        sl[r2][i2] = by[r2][k2];
        by[r2][k2] = tq;
        pos[r1 * N + sl[r1][i1]] = i1;
        pos[r1 * N + by[r1][k1]] = P + k1;
        pos[r2 * N + sl[r2][i2]] = i2;
        pos[r2 * N + by[r2][k2]] = P + k2;
      };
      doSwap();
      d += apply(sl[r1], c1, 1) + local(sl[r1], c1) + apply(sl[r2], c2, 1) + local(sl[r2], c2);
      d += runCost(p) + runCost(q) - before;
      if (d <= 0 || rng() < Math.exp(-d / T)) {
        cost += d;
        fair!.applySwap(p, q, r1, r2);
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          snapshot();
        }
      } else {
        apply(sl[r1], c1, -1);
        apply(sl[r2], c2, -1);
        doSwap(); // 互换是对合，再换一次即还原
        apply(sl[r1], c1, 1);
        apply(sl[r2], c2, 1);
      }
      continue;
    }
    // ① 同轮上场位互换
    const ri = Math.floor(rng() * R);
    const a = sl[ri];
    const i = Math.floor(rng() * P);
    let j = Math.floor(rng() * (P - 1));
    if (j >= i) j++;
    if (Math.floor(i / teamSize) === Math.floor(j / teamSize)) continue;
    const ci = Math.floor(i / perCourt);
    const cj = Math.floor(j / perCourt);
    if (lockCourts && ci !== cj) continue;
    if (teamSize === 1 && ci === cj) continue;
    const two = ci !== cj;
    let delta = -local(a, ci) + apply(a, ci, -1);
    if (two) delta += -local(a, cj) + apply(a, cj, -1);
    let t = a[i];
    a[i] = a[j];
    a[j] = t;
    delta += apply(a, ci, 1) + local(a, ci);
    if (two) delta += apply(a, cj, 1) + local(a, cj);
    if (delta <= 0 || rng() < Math.exp(-delta / T)) {
      cost += delta;
      // pos 对同轮互换只需更新两人的位置
      pos[ri * N + a[i]] = i;
      pos[ri * N + a[j]] = j;
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        snapshot();
      }
    } else {
      apply(a, ci, -1);
      if (two) apply(a, cj, -1);
      t = a[i];
      a[i] = a[j];
      a[j] = t;
      apply(a, ci, 1);
      if (two) apply(a, cj, 1);
    }
  }

  if (bestCost < startCost - 1e-9) {
    rounds.forEach((r, ri) => {
      const ids = Array.from(bestSl[ri], (k) => players[k].id);
      const matches: EngineMatch[] = [];
      for (let m = 0; m < M; m++) {
        const b = m * perCourt;
        matches.push(makeMatch(0, ids.slice(b, b + teamSize), ids.slice(b + teamSize, b + perCourt), ctx.weightOf));
      }
      if (!lockCourts) matches.sort((x, y) => y.teamA.strength + y.teamB.strength - (x.teamA.strength + x.teamB.strength));
      matches.forEach((mm, k) => (mm.courtNo = k + 1));
      r.matches = matches;
      r.byes = Array.from(bestBy[ri], (k) => players[k].id);
    });
  }
}

// ============ 轮次排序：相邻两轮少碰同一拨人 ============
/**
 * 换轮次顺序不改变任何搭档/对手/阵容的总次数，只影响「刚打完又碰上」和轮空节奏。
 * 边权 = 两轮之间的共同对手对 × adjOpponent + 共同搭档 × adjPartner + 同 4 人同场 × adjFour；
 * 另加体力代价（连打阶梯 + 连续轮空），并要求排列后仍逐轮轮空公平；对排列做退火（交换两轮 / 翻转一段），原地改写 rounds 的顺序与 index。
 */
function orderRounds(ctx: Ctx, rounds: EngineRound[], rng: () => number): void {
  const R = rounds.length;
  if (R < 3 || rounds[0].matches.length === 0) return;
  const { players, byeCount, w, lockCourts } = ctx;
  if (lockCourts) return; // 墨式按积分锁场地时轮次顺序有意义，不动
  const N = players.length;
  const K = Math.max(2, N);
  const pk = (a: number, b: number) => (a < b ? a * K + b : b * K + a);
  // 每轮的对手对、搭档对、同场 4 人集合
  const oppSets: Set<number>[] = [];
  const ptnSets: Set<number>[] = [];
  const fourSets: Set<number>[] = [];
  for (const r of rounds) {
    const o = new Set<number>();
    const p = new Set<number>();
    const f = new Set<number>();
    for (const m of r.matches) {
      for (const a of m.teamA.ids) for (const b of m.teamB.ids) o.add(pk(a, b));
      for (const T of [m.teamA.ids, m.teamB.ids]) if (T.length === 2) p.add(pk(T[0], T[1]));
      if (m.teamA.ids.length === 2) {
        const q = [...m.teamA.ids, ...m.teamB.ids].sort((x, y) => x - y);
        f.add(((q[0] * K + q[1]) * K + q[2]) * K + q[3]);
      }
    }
    oppSets.push(o);
    ptnSets.push(p);
    fourSets.push(f);
  }
  const common = (x: Set<number>, y: Set<number>) => {
    let c = 0;
    for (const v of x) if (y.has(v)) c++;
    return c;
  };
  const W: number[][] = Array.from({ length: R }, () => new Array(R).fill(0));
  for (let i = 0; i < R; i++)
    for (let j = i + 1; j < R; j++) {
      const c = w.adjOpponent * common(oppSets[i], oppSets[j]) + w.adjPartner * common(ptnSets[i], ptnSets[j]) + w.adjFour * common(fourSets[i], fourSets[j]);
      W[i][j] = c;
      W[j][i] = c;
    }
  const idx = new Map<number, number>(players.map((pl, i) => [pl.id, i]));
  const rest: Uint8Array[] = rounds.map((r) => {
    const a = new Uint8Array(N);
    for (const id of r.byes) a[idx.get(id)!] = 1;
    return a;
  });
  const streakLB = byeCount === 0 ? R : Math.min(R, Math.ceil(N / byeCount) - 1);
  const prefLo = Array.from({ length: R }, (_, k) => Math.floor(((k + 1) * byeCount) / N));
  const prefHi = Array.from({ length: R }, (_, k) => Math.ceil(((k + 1) * byeCount) / N));
  /** 体力代价；排出来的顺序违反逐轮轮空公平时返回 Infinity（不接受） */
  const fatigue = (ord: number[]): number => {
    if (byeCount === 0) return 0;
    let c = 0;
    for (let p = 0; p < N; p++) {
      let s = 0;
      let rested = 0;
      for (let k = 0; k < R; k++) {
        if (rest[ord[k]][p]) {
          rested++;
          if (k > 0 && rest[ord[k - 1]][p]) c += w.consecBye;
          s = 0;
        } else {
          s++;
          c += streakStep(w, s, streakLB);
        }
        if (rested < prefLo[k] || rested > prefHi[k]) return Infinity;
      }
    }
    return c;
  };
  const adj = (ord: number[]) => {
    let c = 0;
    for (let k = 0; k + 1 < R; k++) c += W[ord[k]][ord[k + 1]];
    return c;
  };
  let ord = rounds.map((_, i) => i);
  let cost = adj(ord) + fatigue(ord);
  let best = ord.slice();
  let bestCost = cost;
  if (bestCost === 0) return;
  // 有轮空时每次评估要 O(N·R)，按总工作量收缩迭代数
  const perEval = byeCount === 0 ? R : N * R;
  const iters = Math.min(ORDER_MAX_ITERS, ORDER_ITERS_PER_PAIR * R * R, Math.floor(ORDER_WORK_BUDGET / perEval));
  for (let it = 0; it < iters; it++) {
    const T = ORDER_T0 * Math.pow(ORDER_T1 / ORDER_T0, it / iters);
    let i = Math.floor(rng() * R);
    let j = Math.floor(rng() * R);
    if (i === j) continue;
    if (i > j) [i, j] = [j, i];
    const cand = ord.slice();
    if (rng() < 0.5) [cand[i], cand[j]] = [cand[j], cand[i]];
    else cand.splice(i, j - i + 1, ...cand.slice(i, j + 1).reverse());
    const f = fatigue(cand);
    if (f === Infinity) continue;
    const c = adj(cand) + f;
    const d = c - cost;
    if (d <= 0 || rng() < Math.exp(-d / T)) {
      ord = cand;
      cost = c;
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = ord.slice();
      }
    }
  }
  const snapshot = rounds.slice();
  best.forEach((from, k) => {
    rounds[k] = { ...snapshot[from], index: k + 1 };
  });
}

/**
 * 成品赛程的完整代价（与各阶段同口径）：按轮次顺序逐场累加边际对阵代价（重复/实力差/混双），
 * 加体力代价与相邻两轮重合代价。只用于多起点在 scheduleQuality 同分时打破平手。
 */
function totalCost(ctx: Ctx, rounds: EngineRound[]): number {
  const { players, w } = ctx;
  const st = newState(players);
  let c = 0;
  for (const r of rounds) {
    for (const m of r.matches) {
      const slots = [...m.teamA.ids, ...m.teamB.ids];
      c += matchCostOf(ctx, st, slots, 0);
      record(st, [m], []);
    }
    record(st, [], r.byes);
  }
  c += fatigueCost(ctx, rounds);
  const pk = (a: number, b: number) => (a < b ? a * PAIR_BASE + b : b * PAIR_BASE + a);
  for (let i = 1; i < rounds.length; i++) {
    const prevOpp = new Set<number>();
    const prevPtn = new Set<number>();
    for (const m of rounds[i - 1].matches) {
      for (const a of m.teamA.ids) for (const b of m.teamB.ids) prevOpp.add(pk(a, b));
      for (const T of [m.teamA.ids, m.teamB.ids]) if (T.length === 2) prevPtn.add(pk(T[0], T[1]));
    }
    for (const m of rounds[i].matches) {
      for (const a of m.teamA.ids) for (const b of m.teamB.ids) if (prevOpp.has(pk(a, b))) c += w.adjOpponent;
      for (const T of [m.teamA.ids, m.teamB.ids]) if (T.length === 2 && prevPtn.has(pk(T[0], T[1]))) c += w.adjPartner;
    }
  }
  return c;
}

/** 轮空/体力代价（与 planRound 的位置代价同口径，从成品赛程重算，用于多起点比较） */
function fatigueCost(ctx: Ctx, rounds: EngineRound[]): number {
  const { players, byeCount, totalRounds, w } = ctx;
  const N = players.length;
  const streakLB = byeCount === 0 ? totalRounds : Math.min(totalRounds, Math.ceil(N / byeCount) - 1);
  const streak = new Map<number, number>(players.map((p) => [p.id, 0]));
  const tally = new Map<number, number>(players.map((p) => [p.id, 0]));
  let cost = 0;
  rounds.forEach((r, ri) => {
    const byes = new Set(r.byes);
    for (const p of players) {
      if (byes.has(p.id)) {
        cost += w.tally * tally.get(p.id)! + (ri > 0 && streak.get(p.id)! === 0 ? w.consecBye : 0);
        tally.set(p.id, tally.get(p.id)! + 1);
        streak.set(p.id, 0);
      } else if (r.matches.length) {
        const s = streak.get(p.id)! + 1;
        cost += streakStep(w, s, streakLB);
        streak.set(p.id, s);
      }
    }
  });
  return cost;
}

/** 混双且有轮空、男女人数不等时，人多的那一性别（需要多轮空一些才能让每队凑齐一男一女） */
function dominantGender(players: EnginePlayer[], wantMixed: boolean, byeCount: number): Gender | null {
  if (!wantMixed || byeCount === 0) return null;
  let M = 0;
  let F = 0;
  for (const p of players) {
    if (isMale(p.gender)) M++;
    else if (isFemale(p.gender)) F++;
  }
  if (M === F) return null;
  return M > F ? Gender.MALE : Gender.FEMALE;
}

// 排名分：墨式=积分(缺省回退水平权重)；其余=水平权重
function rankingOf(ctx: Ctx, playing: EnginePlayer[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of playing) {
    const live = ctx.settings.standings?.[p.id];
    m.set(p.id, ctx.isMexicano && live != null ? live : p.weight);
  }
  return m;
}

// ============ 选轮空起点：公平优先 → 连打长者先歇 → 混双按性别补齐 ============
/**
 * 1) 轮空次数少的先歇；
 * 2) 同一轮空次数层内：连续上场轮数长者先歇 → 出场多者先歇 → 随机；
 * 3) 混双：在同一层内按「让上场的人男女尽量对等」逐个挑性别。
 * 这只是局部搜索的起点；搜索阶段允许在「最终轮空差 ≤ 1 仍可达」的硬约束内继续调整。
 */
function initialByes(ctx: Ctx, st: State, rng: () => number, domCap: number): number[] {
  const { players, byeCount, wantMixed, dominant } = ctx;
  if (byeCount === 0) return [];
  let domTaken = 0;
  const isDom = (g?: Gender) => dominant !== null && g === dominant;
  const order = shuffle(players, rng).sort((a, b) => {
    const t = st.byeTally.get(a.id)! - st.byeTally.get(b.id)!;
    if (t !== 0) return t;
    const s = st.streak.get(b.id)! - st.streak.get(a.id)!;
    if (s !== 0) return s;
    return st.appearances.get(b.id)! - st.appearances.get(a.id)!;
  });

  let M = 0;
  let F = 0;
  let U = 0;
  for (const p of players) {
    if (isMale(p.gender)) M++;
    else if (isFemale(p.gender)) F++;
    else U++;
  }
  const excess = () => Math.max(0, Math.abs(M - F) - U);
  const remove = (g: Gender) => {
    if (isMale(g)) M--;
    else if (isFemale(g)) F--;
    else U--;
  };
  const excessAfter = (g: Gender) => {
    remove(g);
    const e = excess();
    if (isMale(g)) M++;
    else if (isFemale(g)) F++;
    else U++;
    return e;
  };

  const byes: number[] = [];
  let need = byeCount;
  let i = 0;
  while (need > 0 && i < order.length) {
    const tally = st.byeTally.get(order[i].id)!;
    let j = i;
    while (j < order.length && st.byeTally.get(order[j].id)! === tally) j++;
    const cls = order.slice(i, j);
    i = j;
    if (cls.length <= need || !wantMixed) {
      const take = cls.slice(0, need);
      for (const p of take) {
        byes.push(p.id);
        remove(p.gender);
        if (isDom(p.gender)) domTaken++;
      }
      need -= take.length;
      continue;
    }
    const remaining = [...cls];
    while (need > 0 && remaining.length) {
      let bestIdx = 0;
      let bestE = Infinity;
      const seenGender = new Set<Gender>();
      for (let k = 0; k < remaining.length; k++) {
        const g = remaining[k].gender ?? Gender.UNKNOWN;
        if (seenGender.has(g)) continue;
        seenGender.add(g);
        // 主导性别额度用完后不再优先让其轮空（把额度留给后面几轮，避免另一性别连打到底）
        const e = isDom(g) && domTaken >= domCap ? Infinity : excessAfter(g);
        if (e < bestE) {
          bestE = e;
          bestIdx = k;
        }
      }
      if (bestE === Infinity) bestIdx = 0; // 只剩主导性别可选
      const p = remaining.splice(bestIdx, 1)[0];
      byes.push(p.id);
      remove(p.gender);
      if (isDom(p.gender)) domTaken++;
      need--;
    }
  }
  return byes;
}

// ============ 单场代价（排布与回炉共用）============
function matchCostOf(ctx: Ctx, st: State, slots: number[], m: number): number {
  const { teamSize, perCourt, weightOf, genderOf, wantMixed, w } = ctx;
  const base = m * perCourt;
  let cost = 0;
  let sA = 0;
  let sB = 0;
  let wMin = Infinity;
  let wMax = -Infinity;
  for (let t = 0; t < 2; t++) {
    const off = base + t * teamSize;
    let s = 0;
    for (let k = 0; k < teamSize; k++) {
      const wt = weightOf.get(slots[off + k])!;
      s += wt;
      if (wt < wMin) wMin = wt;
      if (wt > wMax) wMax = wt;
    }
    if (t === 0) sA = s;
    else sB = s;
    if (teamSize === 2) {
      const a = slots[off];
      const b = slots[off + 1];
      const c = st.partnerCount.get(pairKey(a, b)) ?? 0;
      if (c) cost += w.partner * tri(c);
      if (wantMixed && sameKnownGender(a, b, genderOf))
        cost += w.mixed + w.mixShare * (tri(st.violCount.get(a) ?? 0) + tri(st.violCount.get(b) ?? 0));
    }
  }
  for (let x = 0; x < teamSize; x++)
    for (let y = 0; y < teamSize; y++) {
      const c = st.opponentCount.get(pairKey(slots[base + x], slots[base + teamSize + y])) ?? 0;
      if (c) cost += w.opponent * tri(c);
    }
  if (teamSize === 2 && st.matchupCount.size) {
    const K = st.K;
    const a0 = slots[base];
    const a1 = slots[base + 1];
    const b0 = slots[base + 2];
    const b1 = slots[base + 3];
    const ta = a0 < a1 ? a0 * K + a1 : a1 * K + a0;
    const tb = b0 < b1 ? b0 * K + b1 : b1 * K + b0;
    const mk = ta < tb ? ta * K * K + tb : tb * K * K + ta;
    let q0 = a0;
    let q1 = a1;
    let q2 = b0;
    let q3 = b1;
    let t: number;
    if (q0 > q1) { t = q0; q0 = q1; q1 = t; }
    if (q2 > q3) { t = q2; q2 = q3; q3 = t; }
    if (q0 > q2) { t = q0; q0 = q2; q2 = t; }
    if (q1 > q3) { t = q1; q1 = q3; q3 = t; }
    if (q1 > q2) { t = q1; q1 = q2; q2 = t; }
    const fk = ((q0 * K + q1) * K + q2) * K + q3;
    cost += w.matchup * (st.matchupCount.get(mk) ?? 0) + w.four * (st.fourCount.get(fk) ?? 0);
  }
  cost += gapCost(w, Math.abs(sA - sB));
  if (w.spread) cost += w.spread * (wMax - wMin);
  return cost;
}

// ============ 排布一轮：轮空 + 对阵一起做多起点两两交换局部搜索 ============
interface RoundPlan {
  matches: EngineMatch[];
  byes: number[];
}

function planRound(ctx: Ctx, st: State, roundIndex: number, rng: () => number, fixedByes?: number[]): RoundPlan {
  const { players, teamSize, perCourt, matchesPerRound: M, byeCount, totalRounds, weightOf, genderOf, wantMixed, lockCourts, w, dominant } = ctx;
  const N = players.length;
  const P = M * perCourt;
  const roundsLeft = totalRounds - roundIndex; // 本轮之后还剩几轮
  const isDom = (id: number) => dominant !== null && genderOf.get(id) === dominant;

  // ---- 轮空公平硬约束：最终人人轮空次数 ∈ {lo, hi}，且后续每轮仍凑得出 byeCount 个可轮空的人
  const totalByes = totalRounds * byeCount;
  const lo = Math.floor(totalByes / N);
  const hi = Math.ceil(totalByes / N);
  const tallyOf = (id: number) => st.byeTally.get(id)!;
  // 连打理论下界：前 ceil(N/轮空数)−1 轮的轮空人次不够让每人歇一次，必有人连打这么多轮
  const streakLB = byeCount === 0 ? totalRounds : Math.min(totalRounds, Math.ceil(N / byeCount) - 1);

  /**
   * 混双主导性别本轮轮空上限：把「在最终轮空差 ≤ 1 约束下主导性别还能轮空的人次」按剩余轮数均摊。
   * 每轮都按当前轮空次数重算，某轮被公平约束逼着多歇了几个主导性别，后面几轮自动收紧而不是直接归零。
   * 总违例只与主导性别轮空总人次有关、与分布无关，均摊既拿到最少违例，又不让另一性别连打到底。
   */
  let domCap = Infinity;
  if (dominant) {
    let domCapacity = 0;
    let othersNeed = 0;
    for (const p of players) {
      const t = tallyOf(p.id);
      if (isDom(p.id)) domCapacity += hi - t;
      else othersNeed += Math.max(0, lo - t);
    }
    const remainingByes = (roundsLeft + 1) * byeCount;
    const budget = Math.max(0, Math.min(domCapacity, remainingByes - othersNeed));
    domCap = Math.min(byeCount, Math.ceil(budget / (roundsLeft + 1)));
  }

  /**
   * 轮空公平硬约束（逐轮）：第 r 轮打完时，每人累计轮空次数 ∈ [⌊r·B/N⌋, ⌈r·B/N⌉]。
   * 等价于「没轮过一遍空的人之前，谁都不歇第二次」：局长任何时候结束活动，大家的上场次数差都 ≤ 1，
   * 整场结束时的 {lo, hi} 自然满足。本轮开始前人人已在上一轮的区间内，所以只需检查换进/换出的两个人（O(1)）。
   */
  const prefLo = Math.floor((roundIndex * byeCount) / N);
  const prefHi = Math.ceil((roundIndex * byeCount) / N);

  // ---- 位置代价：上场者按连打阶梯（streakStep）计，轮空者按已轮空次数与"刚歇过又歇"计
  const playCost = (id: number) => {
    const s = st.streak.get(id)! + 1; // 若本轮上场，连打会变成多少
    return streakStep(w, s, streakLB);
  };
  const restCost = (id: number) => w.tally * tallyOf(id) + (roundIndex > 1 && st.streak.get(id)! === 0 ? w.consecBye : 0);

  const matchCost = (slots: number[], m: number) => matchCostOf(ctx, st, slots, m);

  const sameTeam = (i: number, j: number) => Math.floor(i / teamSize) === Math.floor(j / teamSize);
  const courtOf = (i: number) => Math.floor(i / perCourt);

  /** slots[0..P) 为上场位（按场地/队伍连续排列），slots[P..N) 为轮空位 */
  const descend = (init: number[]): { slots: number[]; cost: number } => {
    const slots = [...init];
    const mc: number[] = [];
    for (let m = 0; m < M; m++) mc.push(matchCost(slots, m));
    let pos = 0;
    for (let i = 0; i < P; i++) pos += playCost(slots[i]);
    for (let i = P; i < N; i++) pos += restCost(slots[i]);
    let cost = mc.reduce((s, x) => s + x, 0) + pos;
    let domByes = 0;
    for (let i = P; i < N; i++) if (isDom(slots[i])) domByes++;

    let improved = true;
    while (improved) {
      improved = false;
      // (a) 上场位之间互换
      for (let i = 0; i < P; i++) {
        for (let j = i + 1; j < P; j++) {
          if (sameTeam(i, j)) continue;
          const ci = courtOf(i);
          const cj = courtOf(j);
          if (lockCourts && ci !== cj) continue;
          if (teamSize === 1 && ci === cj) continue; // 单打同场 A/B 互换无意义
          const a = slots[i];
          slots[i] = slots[j];
          slots[j] = a;
          const ni = matchCost(slots, ci);
          const nj = ci === cj ? 0 : matchCost(slots, cj);
          const delta = ni - mc[ci] + (ci === cj ? 0 : nj - mc[cj]);
          if (delta < -1e-9) {
            mc[ci] = ni;
            if (ci !== cj) mc[cj] = nj;
            cost += delta;
            improved = true;
          } else {
            slots[j] = slots[i];
            slots[i] = a;
          }
        }
      }
      // (b) 上场位 ↔ 轮空位互换（受逐轮公平硬约束）。轮空已由整体计划定死、或墨式按积分锁场地时跳过：
      //     锁场地时换进来的人会落在别人的场地位上，绕开「只许同场内调整」
      if (byeCount > 0 && !fixedByes && !lockCourts) {
        for (let i = 0; i < P; i++) {
          for (let j = P; j < N; j++) {
            const p = slots[i]; // 将要歇
            const q = slots[j]; // 将要上
            if (tallyOf(p) + 1 > prefHi || tallyOf(q) < prefLo) continue;
            const domDelta = (isDom(p) ? 1 : 0) - (isDom(q) ? 1 : 0);
            if (domDelta > 0 && domByes + domDelta > domCap) continue; // 主导性别轮空额度已用满
            slots[i] = q;
            slots[j] = p;
            const ci = courtOf(i);
            const ni = matchCost(slots, ci);
            const dpos = playCost(q) - playCost(p) + restCost(p) - restCost(q);
            const delta = ni - mc[ci] + dpos;
            if (delta < -1e-9) {
              mc[ci] = ni;
              pos += dpos;
              cost += delta;
              domByes += domDelta;
              improved = true;
            } else {
              slots[i] = p;
              slots[j] = q;
            }
          }
        }
      }
    }
    return { slots, cost };
  };

  // ---- 起点：轮空用公平贪心；上场部分用 排名切块 / 混双配对 / 少重复贪心 / 随机
  const byes0 = fixedByes ?? initialByes(ctx, st, rng, domCap);
  const byeSet0 = new Set(byes0);
  const playing = players.filter((p) => !byeSet0.has(p.id));
  const ids = playing.map((p) => p.id);
  const ranking = rankingOf(ctx, playing);
  let inits: number[][];
  if (lockCourts) {
    inits = [wantMixed ? rankChunkMixedInit(playing, ranking, rng) : rankChunkInit(playing, teamSize, ranking, rng)];
  } else {
    // 按模式把最像样的起点排前面，再按规模截断（上场位多时逐轮贪心很贵，靠后面的整体退火兜底）
    const social = ctx.settings.mode === GroupMode.ROTATION && ctx.settings.rotation === RotationKind.AMERICANO;
    const rank = rankChunkInit(playing, teamSize, ranking, rng);
    const greedy = greedyRepeatInit(ids, teamSize, st, rng);
    inits = social ? [greedy, rank] : [rank, greedy];
    if (wantMixed) inits.unshift(mixedPairInit(playing, weightOf, rng));
    const roundRestarts = P <= 16 ? ROUND_RESTARTS : P <= 32 ? 2 : 1;
    while (inits.length < roundRestarts) inits.push(shuffle(ids, rng));
    inits = inits.slice(0, roundRestarts);
  }

  let best: { slots: number[]; cost: number } | null = null;
  for (const init of inits) {
    const r = descend([...init, ...byes0]);
    if (!best || r.cost < best.cost - 1e-9) best = r;
  }

  // ---- 成场：court 1 = 总实力最强的一场（锁场地时保持排名顺序）
  const matches: EngineMatch[] = [];
  for (let m = 0; m < M; m++) {
    const base = m * perCourt;
    matches.push(makeMatch(0, best!.slots.slice(base, base + teamSize), best!.slots.slice(base + teamSize, base + perCourt), weightOf));
  }
  if (!lockCourts) matches.sort((x, y) => y.teamA.strength + y.teamB.strength - (x.teamA.strength + x.teamB.strength));
  matches.forEach((m, i) => (m.courtNo = i + 1));
  return { matches, byes: best!.slots.slice(P) };
}

/** 按排名降序切块，场内 a>=b>=c>=d → {a,d} vs {b,c}（单打 a vs b） */
function rankChunkInit(playing: EnginePlayer[], teamSize: number, ranking: Map<number, number>, rng: () => number): number[] {
  const sorted = shuffle(playing, rng).sort((a, b) => ranking.get(b.id)! - ranking.get(a.id)!);
  const slots: number[] = [];
  const perCourt = teamSize * 2;
  for (let c = 0; c * perCourt < sorted.length; c++) {
    const chunk = sorted.slice(c * perCourt, c * perCourt + perCourt);
    if (teamSize === 1) slots.push(chunk[0].id, chunk[1].id);
    else slots.push(chunk[0].id, chunk[3].id, chunk[1].id, chunk[2].id);
  }
  return slots;
}

/**
 * 墨式按积分锁场地 + 混双：按性别分别排名，每片场地取剩余积分最高的 2 男 2 女（不够时用未知性别补，再不够用剩余积分最高者），
 * 场内按「强男配弱女 vs 弱男配强女」摆位。只按个人积分切块会让积分前四恰好全是男生、整场男男对男男。
 */
function rankChunkMixedInit(playing: EnginePlayer[], ranking: Map<number, number>, rng: () => number): number[] {
  const byRank = shuffle(playing, rng).sort((a, b) => ranking.get(b.id)! - ranking.get(a.id)!);
  const males = byRank.filter((p) => isMale(p.gender));
  const females = byRank.filter((p) => isFemale(p.gender));
  const others = byRank.filter((p) => !isMale(p.gender) && !isFemale(p.gender));
  const slots: number[] = [];
  const courts = Math.floor(playing.length / 4);
  for (let c = 0; c < courts; c++) {
    const m = males.splice(0, 2);
    const f = females.splice(0, 2);
    const court = [...m, ...f];
    while (court.length < 4 && others.length) court.push(others.shift()!);
    while (court.length < 4) {
      // 某一性别用完：从剩余人里取积分最高的
      const pool = [males[0], females[0]].filter(Boolean).sort((a, b) => ranking.get(b.id)! - ranking.get(a.id)!);
      const pick = pool[0];
      (isMale(pick.gender) ? males : females).shift();
      court.push(pick);
    }
    const cm = court.filter((p) => isMale(p.gender));
    const cf = court.filter((p) => isFemale(p.gender));
    if (cm.length === 2 && cf.length === 2) slots.push(cm[0].id, cf[1].id, cm[1].id, cf[0].id);
    else {
      court.sort((a, b) => ranking.get(b.id)! - ranking.get(a.id)!);
      slots.push(court[0].id, court[3].id, court[1].id, court[2].id);
    }
  }
  return slots;
}

/** 混双起点：先男女配对，再让剩余的同性与 UNKNOWN 配，最后同性凑对；队伍按实力降序相邻成场 */
function mixedPairInit(playing: EnginePlayer[], weightOf: Map<number, number>, rng: () => number): number[] {
  const pool = shuffle(playing, rng).sort((a, b) => b.weight - a.weight);
  const males = pool.filter((p) => isMale(p.gender));
  const females = pool.filter((p) => isFemale(p.gender));
  const unknown = pool.filter((p) => !isMale(p.gender) && !isFemale(p.gender));
  const teams: number[][] = [];
  while (males.length && females.length) teams.push([males.shift()!.id, females.shift()!.id]);
  const rest = [...males, ...females];
  while (rest.length && unknown.length) teams.push([rest.shift()!.id, unknown.shift()!.id]);
  const tail = [...rest, ...unknown];
  while (tail.length >= 2) teams.push([tail.shift()!.id, tail.shift()!.id]);
  const strength = (t: number[]) => t.reduce((s, id) => s + weightOf.get(id)!, 0);
  teams.sort((a, b) => strength(b) - strength(a));
  const slots: number[] = [];
  for (const t of teams) slots.push(...t);
  return slots;
}

/** 少重复贪心起点：先按「搭档次数最少」组队，再按「对手次数最少」配场 */
function greedyRepeatInit(ids: number[], teamSize: number, st: State, rng: () => number): number[] {
  const pool = shuffle(ids, rng);
  let teams: number[][];
  if (teamSize === 1) teams = pool.map((id) => [id]);
  else {
    teams = [];
    const remaining = [...pool];
    while (remaining.length >= 2) {
      const x = remaining.shift()!;
      let bestIdx = 0;
      let bestScore = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const score = st.partnerCount.get(pairKey(x, remaining[i])) ?? 0;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      teams.push([x, remaining.splice(bestIdx, 1)[0]]);
    }
  }
  const used = new Array(teams.length).fill(false);
  const slots: number[] = [];
  for (let i = 0; i < teams.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let bestJ = -1;
    let bestScore = Infinity;
    for (let j = i + 1; j < teams.length; j++) {
      if (used[j]) continue;
      let score = 0;
      for (const a of teams[i]) for (const b of teams[j]) score += st.opponentCount.get(pairKey(a, b)) ?? 0;
      if (score < bestScore) {
        bestScore = score;
        bestJ = j;
      }
    }
    if (bestJ === -1) break;
    used[bestJ] = true;
    slots.push(...teams[i], ...teams[bestJ]);
  }
  return slots;
}

function makeMatch(courtNo: number, aIds: number[], bIds: number[], weightOf: Map<number, number>): EngineMatch {
  const strengthA = aIds.reduce((s, id) => s + (weightOf.get(id) ?? 0), 0);
  const strengthB = bIds.reduce((s, id) => s + (weightOf.get(id) ?? 0), 0);
  return {
    courtNo,
    teamA: { ids: aIds, strength: strengthA },
    teamB: { ids: bIds, strength: strengthB },
    strengthGap: Math.abs(strengthA - strengthB),
  };
}

// ============ 指标（从最终赛程重算，不依赖生成过程）============
function computeMetrics(
  players: EnginePlayer[],
  settings: EngineSettings,
  rounds: EngineRound[],
  byeCount: number,
  teamSize: number,
): EngineMetrics {
  const genderOf = new Map<number, Gender>(players.map((p) => [p.id, p.gender]));
  const wantMixed = teamSize === 2 && !!settings.mixedDoubles;
  const st = newState(players);
  let maxStreak = 0;
  let mixedViolations = 0;
  let gapSum = 0;
  let totalMatches = 0;
  for (const r of rounds) {
    record(st, r.matches, r.byes);
    for (const s of st.streak.values()) maxStreak = Math.max(maxStreak, s);
    for (const m of r.matches) {
      totalMatches++;
      gapSum += m.strengthGap;
      if (wantMixed) {
        if (m.teamA.ids.length === 2 && sameKnownGender(m.teamA.ids[0], m.teamA.ids[1], genderOf)) mixedViolations++;
        if (m.teamB.ids.length === 2 && sameKnownGender(m.teamB.ids[0], m.teamB.ids[1], genderOf)) mixedViolations++;
      }
    }
  }
  const apps = [...st.appearances.values()];
  const repeats = (m: Map<unknown, number>) => [...m.values()].reduce((s, v) => s + Math.max(0, v - 1), 0);
  const maxOf = (m: Map<unknown, number>) => (m.size ? Math.max(...m.values()) : 0);
  return {
    totalMatches,
    rounds: settings.rounds,
    appearancesMin: apps.length ? Math.min(...apps) : 0,
    appearancesMax: apps.length ? Math.max(...apps) : 0,
    byePerRound: byeCount,
    repeatPartnerPairs: repeats(st.partnerCount),
    repeatOpponentPairs: repeats(st.opponentCount),
    mixedViolations,
    maxConsecutivePlays: maxStreak,
    sameMatchupRepeats: repeats(st.matchupCount),
    maxPartnerCount: maxOf(st.partnerCount),
    maxOpponentCount: maxOf(st.opponentCount),
    avgStrengthGap: totalMatches ? Math.round((gapSum / totalMatches) * 100) / 100 : 0,
  };
}
