/**
 * 分组引擎评测器
 *
 * 枚举 玩法 × 模式 × 混双/性别分布 × 权重分布 × 人数 × 场地 × 轮数 × seed，
 * 对每份赛程独立重算指标（不信任 engine.metrics），与组合下界比较，按 9 条验收标准判定，
 * 输出 Markdown 报告 + JSON（供下一轮对比 delta）。
 *
 * 用法（在 backend 目录；明细 JSON 每份约 5MB，放 .tmp/，不要提交）：
 *   pnpm exec tsx scripts/eval-engine.ts --out ../docs/engine-eval/round-4-final.md --json .tmp/round-4.json
 *   可选：--baseline .tmp/round-1.json   与上一次评测逐场景对比升降
 *         --quick                         少量 seed / 轮数，迭代时用
 *         --filter <正则>                 只跑 key 匹配的场景
 *         --engine <路径>                 评测另一份引擎实现（如 git show 出来的历史版本，放 .tmp/ 下）
 *         --variant nogap|norep|nofatigue 对照实验：关掉实力差 / 重复 / 体力软代价，验证取舍
 *         --label "第 N 轮"                报告标题后缀
 * 评测方法、验收口径与历次结果见 docs/engine-eval/README.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { GroupMode, PlayType, RotationKind, Gender } from '@badminton/shared';
import * as defaultEngine from '../src/modules/grouping/engine';
import type { EnginePlayer, EngineSchedule, EngineSettings } from '../src/modules/grouping/engine';

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name: string) => argv.includes(`--${name}`);
const OUT = opt('out', '.tmp/engine-eval-report.md')!;
const JSON_OUT = opt('json');
const BASELINE = opt('baseline');
const QUICK = flag('quick');
const LABEL = opt('label', '');
const FILTER = opt('filter'); // 只跑 key 匹配该正则的场景（迭代调参用）
const SEEDS_OPT = opt('seeds'); // 例：1,2,3
// 对照变体：nogap = 不看实力差（验证重复类失败是否因实力差取舍）；norep = 不看重复（验证实力差失败是否因重复取舍）；
// nofatigue = 不看连打软代价（验证混双违例是否因体力取舍）
const VARIANT = opt('variant');
// --engine <路径>：评测另一份引擎实现（如 git 历史版本），与当前版本用同一把尺子比较
const ENGINE_PATH = opt('engine');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engineMod: typeof defaultEngine = ENGINE_PATH ? require(path.resolve(ENGINE_PATH)) : defaultEngine;
const generateSchedule = (p: EnginePlayer[], s: EngineSettings, tuning?: unknown): EngineSchedule =>
  (engineMod.generateSchedule as (a: EnginePlayer[], b: EngineSettings, c?: unknown) => EngineSchedule)(p, s, tuning);
// 每个变体同时关掉「代价权重」与「多起点择优」里的对应目标，才算真正不看这项
const TUNING =
  VARIANT === 'nogap'
    ? { weights: { gap: 0, gapQuad: 0, spread: 0 }, qualityOff: ['gap'] }
    : VARIANT === 'norep'
      ? { weights: { partner: 0, opponent: 0, matchup: 0, four: 0, adjOpponent: 0, adjPartner: 0, adjFour: 0 }, qualityOff: ['repeat'] }
      : VARIANT === 'nofatigue'
        ? { weights: { streak: 0, streakSecond: 0, streakOver: 0 }, qualityOff: ['fatigue'] }
        : undefined;

// ---------------------------------------------------------------- 场景矩阵
type ModeLabel = 'BALANCED' | 'AMERICANO' | 'MEXICANO';
type WeightProfile = 'equal' | 'varied' | 'realistic';
type GenderProfile = 'none' | 'even' | 'uneven' | 'unknownMix';

interface Scenario {
  key: string;
  playType: PlayType;
  mode: ModeLabel;
  mixed: boolean;
  genderProfile: GenderProfile;
  weightProfile: WeightProfile;
  N: number;
  courts: number;
  rounds: number;
}

const SEEDS = SEEDS_OPT ? SEEDS_OPT.split(',').map(Number) : QUICK ? [1, 2] : [1, 2, 3, 4, 5];
const ROUNDS = QUICK ? [4, 8] : [4, 6, 8, 12];
const SINGLES_N = [4, 5, 6, 7, 8, 9, 10, 12];
const DOUBLES_N = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20];
const MODES: ModeLabel[] = ['BALANCED', 'AMERICANO', 'MEXICANO'];

function weightsOf(profile: WeightProfile, N: number): number[] {
  const varied = [6, 5, 4, 3, 2, 1];
  const realistic = [3, 3, 2, 4, 3, 2, 5, 3, 4, 2, 3, 6, 1, 3, 2, 4, 3, 4, 2, 5];
  return Array.from({ length: N }, (_, i) =>
    profile === 'equal' ? 3 : profile === 'varied' ? varied[i % varied.length] : realistic[i % realistic.length],
  );
}
function gendersOf(profile: GenderProfile, N: number): Gender[] {
  return Array.from({ length: N }, (_, i) => {
    if (profile === 'none') return Gender.UNKNOWN;
    if (profile === 'even') return i % 2 === 0 ? Gender.MALE : Gender.FEMALE;
    if (profile === 'uneven') return i % 5 === 0 || i % 5 === 1 || i % 5 === 3 ? Gender.MALE : Gender.FEMALE; // ≈60% 男
    // unknownMix：男女交替，每 5 人 1 个未知（Guest）
    if (i % 5 === 4) return Gender.UNKNOWN;
    return i % 2 === 0 ? Gender.MALE : Gender.FEMALE;
  });
}
function playersOf(s: Scenario): EnginePlayer[] {
  const ws = weightsOf(s.weightProfile, s.N);
  const gs = gendersOf(s.genderProfile, s.N);
  return ws.map((w, i) => ({ id: i + 1, weight: w, gender: gs[i] }));
}
function settingsOf(s: Scenario, seed: number): EngineSettings {
  return {
    playType: s.playType,
    mode: s.mode === 'BALANCED' ? GroupMode.BALANCED : GroupMode.ROTATION,
    rotation: s.mode === 'AMERICANO' ? RotationKind.AMERICANO : s.mode === 'MEXICANO' ? RotationKind.MEXICANO : undefined,
    courtCount: s.courts,
    rounds: s.rounds,
    mixedDoubles: s.mixed,
    seed,
  };
}

function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const push = (s: Omit<Scenario, 'key'>) =>
    out.push({
      ...s,
      key: `${s.playType}/${s.mode}/${s.mixed ? `mixed-${s.genderProfile}` : 'plain'}/${s.weightProfile}/N${s.N}/C${s.courts}/R${s.rounds}`,
    });
  for (const playType of [PlayType.SINGLES, PlayType.DOUBLES]) {
    const perCourt = playType === PlayType.DOUBLES ? 4 : 2;
    const Ns = playType === PlayType.DOUBLES ? DOUBLES_N : SINGLES_N;
    for (const N of Ns) {
      const maxCourts = Math.min(4, Math.floor(N / perCourt));
      for (let courts = 1; courts <= maxCourts; courts++) {
        for (const rounds of ROUNDS) {
          for (const mode of MODES) {
            for (const weightProfile of ['equal', 'varied', 'realistic'] as WeightProfile[]) {
              push({ playType, mode, mixed: false, genderProfile: 'none', weightProfile, N, courts, rounds });
            }
            if (playType === PlayType.DOUBLES) {
              for (const genderProfile of ['even', 'uneven', 'unknownMix'] as GenderProfile[]) {
                for (const weightProfile of ['equal', 'varied'] as WeightProfile[]) {
                  push({ playType, mode, mixed: true, genderProfile, weightProfile, N, courts, rounds });
                }
              }
            }
          }
        }
      }
    }
  }
  // 大规模场景（真实大局：多片场地、人多）：验证按规模收缩搜索预算后质量仍达标
  const LARGE: Array<[PlayType, number, number[], number[]]> = QUICK
    ? [
        [PlayType.DOUBLES, 26, [6], [12]],
        [PlayType.DOUBLES, 40, [9], [12]],
        [PlayType.SINGLES, 18, [8], [12]],
      ]
    : [
        [PlayType.DOUBLES, 24, [5, 6], [8, 12]],
        [PlayType.DOUBLES, 26, [6], [8, 12]],
        [PlayType.DOUBLES, 32, [7, 8], [8, 12]],
        [PlayType.DOUBLES, 40, [9, 10], [12]],
        [PlayType.DOUBLES, 50, [12], [12]],
        [PlayType.SINGLES, 16, [7, 8], [8, 12]],
        [PlayType.SINGLES, 21, [10], [12]],
      ];
  for (const [playType, N, courtsList, roundsList] of LARGE) {
    for (const courts of courtsList)
      for (const rounds of roundsList)
        for (const mode of MODES) {
          push({ playType, mode, mixed: false, genderProfile: 'none', weightProfile: 'realistic', N, courts, rounds });
          if (playType === PlayType.DOUBLES) {
            push({ playType, mode, mixed: true, genderProfile: 'uneven', weightProfile: 'realistic', N, courts, rounds });
          }
        }
  }
  return out;
}

// ---------------------------------------------------------------- 指标
interface Metrics {
  valid: boolean;
  invalidReason: string;
  N: number;
  teamSize: number;
  byeCount: number;
  rounds: number;
  appMin: number;
  appMax: number;
  appSpread: number;
  byeSpread: number;
  /** 任意一轮打完时的轮空次数差（取所有轮的最大值）：中途散场是否公平 */
  byeSpreadPrefix: number;
  maxStreak: number;
  streakLB: number;
  streakExcess: number;
  consecutiveByes: number;
  consecutiveByesAvoidable: boolean;
  partnerRepeats: number;
  maxPartnerCount: number;
  partnerLB: number;
  partnerExcess: number;
  partnerDiversity: number;
  opponentRepeats: number;
  maxOpponentCount: number;
  opponentLB: number;
  opponentExcess: number;
  opponentDiversity: number;
  sameMatchupRepeats: number;
  sameFourRepeats: number;
  /** 相邻两轮做对手的「两人对」次数（刚打完又碰上，体感最明显的重复） */
  backToBackOpp: number;
  /** 相邻两轮做搭档的次数 */
  backToBackPartner: number;
  mixedViolations: number;
  mixedLB: number;
  mixedLBNaive: number;
  mixedExcess: number;
  avgGap: number;
  maxGap: number;
  avgCourtSpread: number;
  ms: number;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** 运输问题最大流（Ford–Fulkerson，图很小）：遍 → 轮，见 computeMetrics 里混双下界的说明 */
function maxDominantFlow(N: number, R: number, B: number, D: number, tgt: number): number {
  const total = R * B;
  const C = Math.ceil(total / N);
  const seg: number[][] = Array.from({ length: C }, () => new Array(R).fill(0));
  for (let r = 0; r < R; r++) for (let s = r * B; s < (r + 1) * B; s++) seg[Math.floor(s / N)][r]++;
  const capCycle = Array.from({ length: C }, (_, c) => ((c + 1) * N <= total ? D : Math.min(D, total - c * N)));
  const capRound = new Array(R).fill(Math.min(tgt, B, D));
  // 节点：0 = S，1..C = 遍，C+1..C+R = 轮，C+R+1 = T
  const V = C + R + 2;
  const cap: number[][] = Array.from({ length: V }, () => new Array(V).fill(0));
  const T = V - 1;
  for (let c = 0; c < C; c++) {
    cap[0][1 + c] = capCycle[c];
    for (let r = 0; r < R; r++) cap[1 + c][1 + C + r] = seg[c][r];
  }
  for (let r = 0; r < R; r++) cap[1 + C + r][T] = capRound[r];
  let flow = 0;
  for (;;) {
    const prev = new Array(V).fill(-1);
    prev[0] = 0;
    const queue = [0];
    while (queue.length && prev[T] === -1) {
      const u = queue.shift()!;
      for (let v = 0; v < V; v++) if (prev[v] === -1 && cap[u][v] > 0) {
        prev[v] = u;
        queue.push(v);
      }
    }
    if (prev[T] === -1) break;
    let aug = Infinity;
    for (let v = T; v !== 0; v = prev[v]) aug = Math.min(aug, cap[prev[v]][v]);
    for (let v = T; v !== 0; v = prev[v]) {
      cap[prev[v]][v] -= aug;
      cap[v][prev[v]] += aug;
    }
    flow += aug;
  }
  return flow;
}

function computeMetrics(players: EnginePlayer[], settings: EngineSettings, sc: EngineSchedule, ms: number): Metrics {
  const N = players.length;
  const teamSize = settings.playType === PlayType.DOUBLES ? 2 : 1;
  const perCourt = teamSize * 2;
  const matchesPerRound = Math.min(settings.courtCount, Math.floor(N / perCourt));
  const byeCount = N - matchesPerRound * perCourt;
  const R = settings.rounds;
  const ids = players.map((p) => p.id);
  const genderOf = new Map(players.map((p) => [p.id, p.gender]));
  const weightOf = new Map(players.map((p) => [p.id, p.weight]));
  const wantMixed = teamSize === 2 && !!settings.mixedDoubles;

  // ---- 不变量
  let valid = true;
  let invalidReason = '';
  if (sc.rounds.length !== R) {
    valid = false;
    invalidReason = `rounds.length=${sc.rounds.length} != ${R}`;
  }
  const played: boolean[][] = ids.map(() => Array(R).fill(false));
  const idx = new Map(ids.map((id, i) => [id, i]));
  for (const r of sc.rounds) {
    const seen = new Set<number>();
    const courts = new Set<number>();
    if (r.matches.length !== matchesPerRound && valid) {
      valid = false;
      invalidReason = `round ${r.index}: matches=${r.matches.length} != ${matchesPerRound}`;
    }
    for (const m of r.matches) {
      if ((m.teamA.ids.length !== teamSize || m.teamB.ids.length !== teamSize) && valid) {
        valid = false;
        invalidReason = `round ${r.index}: team size wrong`;
      }
      if (courts.has(m.courtNo) && valid) {
        valid = false;
        invalidReason = `round ${r.index}: duplicate courtNo ${m.courtNo}`;
      }
      courts.add(m.courtNo);
      for (const id of [...m.teamA.ids, ...m.teamB.ids]) {
        if ((seen.has(id) || !idx.has(id)) && valid) {
          valid = false;
          invalidReason = `round ${r.index}: player ${id} duplicated or unknown`;
        }
        seen.add(id);
        if (idx.has(id)) played[idx.get(id)!][r.index - 1] = true;
      }
    }
    for (const b of r.byes)
      if (seen.has(b) && valid) {
        valid = false;
        invalidReason = `round ${r.index}: bye ${b} also playing`;
      }
    if (seen.size + r.byes.length !== N && valid) {
      valid = false;
      invalidReason = `round ${r.index}: playing ${seen.size} + byes ${r.byes.length} != ${N}`;
    }
  }

  // ---- 出场 / 轮空 / 连续
  let byeSpreadPrefix = 0;
  {
    const run = ids.map(() => 0);
    for (let r = 0; r < R; r++) {
      played.forEach((row, i) => {
        if (!row[r]) run[i]++;
      });
      byeSpreadPrefix = Math.max(byeSpreadPrefix, Math.max(...run) - Math.min(...run));
    }
  }
  const apps = played.map((row) => row.filter(Boolean).length);
  const byes = apps.map((a) => R - a);
  const appMin = Math.min(...apps);
  const appMax = Math.max(...apps);
  let maxStreak = 0;
  let consecutiveByes = 0;
  for (const row of played) {
    let s = 0;
    for (let r = 0; r < R; r++) {
      if (row[r]) {
        s++;
        maxStreak = Math.max(maxStreak, s);
      } else {
        s = 0;
        if (r > 0 && !row[r - 1]) consecutiveByes++;
      }
    }
  }
  const streakLB = byeCount === 0 ? R : Math.min(R, Math.ceil(N / byeCount) - 1);
  // 半数以上的人轮空时，允许连续轮空换取对局多样性（否则只能两组死板交替）；
  // 混双男女不等时，若为了配齐一男一女，主导性别每轮要歇掉自己的一半以上，同理不适用
  let consecutiveByesAvoidable = byeCount * 2 < N;
  if (wantMixed && consecutiveByesAvoidable) {
    const Mc = players.filter((p) => p.gender === Gender.MALE).length;
    const Fc = players.filter((p) => p.gender === Gender.FEMALE).length;
    if (Mc !== Fc) {
      const D = Math.max(Mc, Fc);
      const need = Math.max(0, Math.ceil((2 * D - N + byeCount) / 2));
      if (Math.min(byeCount, need) * 2 >= D) consecutiveByesAvoidable = false;
    }
  }

  // ---- 搭档 / 对手 / 同阵容
  const partnerCount = new Map<string, number>();
  const opponentCount = new Map<string, number>();
  const matchupCount = new Map<string, number>();
  const fourCount = new Map<string, number>();
  const gaps: number[] = [];
  const spreads: number[] = [];
  let mixedViolations = 0;
  for (const r of sc.rounds) {
    for (const m of r.matches) {
      const A = [...m.teamA.ids].sort((a, b) => a - b);
      const B = [...m.teamB.ids].sort((a, b) => a - b);
      for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) partnerCount.set(pairKey(A[i], A[j]), (partnerCount.get(pairKey(A[i], A[j])) ?? 0) + 1);
      for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) partnerCount.set(pairKey(B[i], B[j]), (partnerCount.get(pairKey(B[i], B[j])) ?? 0) + 1);
      for (const a of A) for (const b of B) opponentCount.set(pairKey(a, b), (opponentCount.get(pairKey(a, b)) ?? 0) + 1);
      const ka = A.join(',');
      const kb = B.join(',');
      const mk = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      matchupCount.set(mk, (matchupCount.get(mk) ?? 0) + 1);
      const fk = [...A, ...B].sort((a, b) => a - b).join(',');
      fourCount.set(fk, (fourCount.get(fk) ?? 0) + 1);
      const sa = A.reduce((s, id) => s + weightOf.get(id)!, 0);
      const sb = B.reduce((s, id) => s + weightOf.get(id)!, 0);
      gaps.push(Math.abs(sa - sb));
      const ws = [...A, ...B].map((id) => weightOf.get(id)!);
      spreads.push(Math.max(...ws) - Math.min(...ws));
      if (wantMixed) {
        for (const T of [A, B]) {
          const [g0, g1] = [genderOf.get(T[0]), genderOf.get(T[1])];
          if ((g0 === Gender.MALE && g1 === Gender.MALE) || (g0 === Gender.FEMALE && g1 === Gender.FEMALE)) mixedViolations++;
        }
      }
    }
  }
  // 相邻两轮的对手/搭档重复
  let backToBackOpp = 0;
  let backToBackPartner = 0;
  {
    let prevOpp = new Set<string>();
    let prevPtn = new Set<string>();
    for (const r of sc.rounds) {
      const curOpp = new Set<string>();
      const curPtn = new Set<string>();
      for (const m of r.matches) {
        for (const a of m.teamA.ids) for (const b of m.teamB.ids) curOpp.add(pairKey(a, b));
        for (const T of [m.teamA.ids, m.teamB.ids]) if (T.length === 2) curPtn.add(pairKey(T[0], T[1]));
      }
      for (const k of curOpp) if (prevOpp.has(k)) backToBackOpp++;
      for (const k of curPtn) if (prevPtn.has(k)) backToBackPartner++;
      prevOpp = curOpp;
      prevPtn = curPtn;
    }
  }
  const sumRepeats = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + Math.max(0, v - 1), 0);
  const maxOf = (m: Map<string, number>) => (m.size ? Math.max(...m.values()) : 0);

  // 每人可选搭档数（混双下只能搭异性或 UNKNOWN）
  const eligiblePartners = (id: number) => {
    if (!wantMixed) return N - 1;
    const g = genderOf.get(id);
    if (g === Gender.UNKNOWN) return N - 1;
    return players.filter((p) => p.id !== id && p.gender !== g).length;
  };
  const distinctPartners = new Map<number, Set<number>>(ids.map((id) => [id, new Set()]));
  for (const k of partnerCount.keys()) {
    const [a, b] = k.split('-').map(Number);
    distinctPartners.get(a)!.add(b);
    distinctPartners.get(b)!.add(a);
  }
  const distinctOpponents = new Map<number, Set<number>>(ids.map((id) => [id, new Set()]));
  for (const k of opponentCount.keys()) {
    const [a, b] = k.split('-').map(Number);
    distinctOpponents.get(a)!.add(b);
    distinctOpponents.get(b)!.add(a);
  }
  let partnerLB = 0;
  let opponentLB = 0;
  const pdiv: number[] = [];
  const odiv: number[] = [];
  ids.forEach((id, i) => {
    const app = apps[i];
    if (app === 0) return;
    if (teamSize === 2) {
      const el = Math.max(1, eligiblePartners(id));
      partnerLB = Math.max(partnerLB, Math.ceil(app / el));
      pdiv.push(distinctPartners.get(id)!.size / Math.min(app, el));
    }
    const slots = app * teamSize;
    opponentLB = Math.max(opponentLB, Math.ceil(slots / Math.max(1, N - 1)));
    odiv.push(distinctOpponents.get(id)!.size / Math.min(slots, N - 1));
  });
  const maxPartnerCount = teamSize === 2 ? maxOf(partnerCount) : 0;
  const maxOpponentCount = maxOf(opponentCount);

  // ---- 混双下界（逐轮轮空公平约束下）
  // 设主导性别（人多的一方）D 人、每轮轮空 B 人、上场 P 人。某轮让 x 个主导性别轮空时，违例 ≥ max(0, t − x)，t = D − P/2。
  // 逐轮公平 ⇒ 轮空位按「一遍一遍」轮：第 c 遍覆盖第 (c·N, (c+1)·N] 个轮空位，每人每遍恰好一次（最后一遍可不满）。
  // 于是「每一遍能出多少个主导性别」→「分到各轮」是一个运输问题：遍 c 容量 D（末遍 min(D, 剩余位)），
  // 遍 c 与轮 r 的重叠位数为边容量，轮 r 容量 min(t, B, D)。最少违例下界 = R·t − 最大流。
  let mixedLB = 0;
  let mixedLBNaive = 0;
  if (wantMixed && byeCount > 0) {
    const M = players.filter((p) => p.gender === Gender.MALE).length;
    const F = players.filter((p) => p.gender === Gender.FEMALE).length;
    const D = Math.max(M, F);
    const P = N - byeCount;
    const tgt = Math.max(0, D - P / 2);
    mixedLBNaive = R * Math.max(0, tgt - byeCount);
    if (tgt > 0) mixedLB = R * tgt - maxDominantFlow(N, R, byeCount, D, tgt);
  } else if (wantMixed) {
    const M = players.filter((p) => p.gender === Gender.MALE).length;
    const F = players.filter((p) => p.gender === Gender.FEMALE).length;
    const U = N - M - F;
    mixedLB = R * Math.max(0, (Math.abs(M - F) - U) / 2);
    mixedLBNaive = mixedLB;
  }

  return {
    valid,
    invalidReason,
    N,
    teamSize,
    byeCount,
    rounds: R,
    appMin,
    appMax,
    appSpread: appMax - appMin,
    byeSpread: Math.max(...byes) - Math.min(...byes),
    byeSpreadPrefix,
    maxStreak,
    streakLB,
    streakExcess: Math.max(0, maxStreak - streakLB),
    consecutiveByes,
    consecutiveByesAvoidable,
    partnerRepeats: teamSize === 2 ? sumRepeats(partnerCount) : 0,
    maxPartnerCount,
    partnerLB,
    partnerExcess: teamSize === 2 ? Math.max(0, maxPartnerCount - partnerLB) : 0,
    partnerDiversity: teamSize === 2 ? mean(pdiv) : 1,
    opponentRepeats: sumRepeats(opponentCount),
    maxOpponentCount,
    opponentLB,
    opponentExcess: Math.max(0, maxOpponentCount - opponentLB),
    opponentDiversity: mean(odiv),
    sameMatchupRepeats: sumRepeats(matchupCount),
    backToBackOpp,
    backToBackPartner,
    sameFourRepeats: teamSize === 2 ? sumRepeats(fourCount) : 0,
    mixedViolations,
    mixedLB,
    mixedLBNaive,
    mixedExcess: Math.max(0, mixedViolations - mixedLB),
    avgGap: mean(gaps),
    maxGap: gaps.length ? Math.max(...gaps) : 0,
    avgCourtSpread: mean(spreads),
    ms,
  };
}

// ---------------------------------------------------------------- 验收标准
const CRITERIA = [
  { id: 'C1', name: '出场均衡', desc: '出场次数 max−min ≤ 1' },
  { id: 'C2', name: '轮空均衡', desc: '任意一轮打完时（含最后一轮）轮空次数 max−min ≤ 1，中途散场也公平' },
  { id: 'C3', name: '连续上场', desc: '最长连续上场 ≤ 理论下界 ceil(N/轮空数)−1 再 +1 容差（无轮空时不适用）' },
  { id: 'C4', name: '不连续轮空', desc: '轮空人数不到一半（2×轮空数 < N）时，无人连续两轮轮空' },
  { id: 'C5', name: '搭档不重复', desc: '（双打）任意两人搭档次数 ≤ ceil(出场/可选搭档数)，即搭遍所有人前不重复' },
  { id: 'C6', name: '对手少重复', desc: '任意两人对阵次数 ≤ ceil(对手位/(N−1)) + 1 容差' },
  { id: 'C7', name: '同阵容不重复', desc: '双打：完全相同的对阵（同两队）不出现第二次；单打：对手重复必须均摊（任意两人对阵次数 ≤ ceil(出场/(N−1))）' },
  { id: 'C8', name: '混双违例最少', desc: '（混双）违例队数 ≤ 逐轮轮空公平约束下的理论下界（运输问题最大流求得）' },
  { id: 'C9', name: '实力差可控', desc: '（平衡/墨式）平均两边实力差 ≤ 1.0 且最大 ≤ 3（权重 1–6，双打按两人之和）；美式仅参考' },
] as const;
type CriterionId = (typeof CRITERIA)[number]['id'];

function judge(m: Metrics, s: Scenario): Record<CriterionId, boolean | null> {
  const isDoubles = m.teamSize === 2;
  const balanceMode = s.mode !== 'AMERICANO';
  return {
    C1: m.appSpread <= 1,
    C2: m.byeSpreadPrefix <= 1,
    C3: m.byeCount === 0 ? null : m.streakExcess <= 1,
    C4: m.byeCount === 0 ? null : m.consecutiveByesAvoidable ? m.consecutiveByes === 0 : null,
    C5: isDoubles ? m.partnerExcess === 0 : null,
    C6: m.opponentExcess <= 1,
    C7: isDoubles ? m.sameMatchupRepeats === 0 : m.opponentExcess === 0,
    C8: s.mixed ? m.mixedExcess === 0 : null,
    C9: balanceMode ? m.avgGap <= 1.0 && m.maxGap <= 3 : null,
  };
}

function score(m: Metrics, s: Scenario): number {
  if (!m.valid) return 0;
  let d = 0;
  if (m.appSpread > 1) d += 25;
  if (m.byeSpreadPrefix > 1) d += 15;
  d += Math.min(24, m.streakExcess * 8);
  if (m.consecutiveByesAvoidable && m.consecutiveByes > 0) d += 10;
  if (m.teamSize === 2) {
    d += Math.min(20, m.partnerExcess * 10);
    d += (1 - m.partnerDiversity) * 20;
  }
  d += Math.min(18, m.opponentExcess * 6);
  d += (1 - m.opponentDiversity) * 15;
  d += Math.min(20, m.sameMatchupRepeats * 5);
  d += Math.min(30, m.mixedExcess * 10);
  if (s.mode !== 'AMERICANO') d += Math.min(20, Math.max(0, m.avgGap - 1) * 10);
  else d += Math.min(10, Math.max(0, m.avgGap - 2) * 5);
  return Math.max(0, Math.round((100 - d) * 10) / 10);
}

// ---------------------------------------------------------------- 运行
interface ScenarioResult {
  scenario: Scenario;
  perSeed: Array<{ seed: number; m: Metrics; pass: Record<CriterionId, boolean | null>; score: number }>;
  worst: Metrics; // 各字段取最差（数值取 max，diversity 取 min）
  pass: Record<CriterionId, boolean | null>; // 所有 seed 都过才算过
  meanScore: number;
  minScore: number;
}

function worstOf(ms: Metrics[]): Metrics {
  const w = { ...ms[0] };
  const maxKeys: (keyof Metrics)[] = [
    'appSpread', 'byeSpread', 'byeSpreadPrefix', 'maxStreak', 'streakExcess', 'consecutiveByes', 'partnerRepeats', 'maxPartnerCount', 'partnerExcess',
    'opponentRepeats', 'maxOpponentCount', 'opponentExcess', 'sameMatchupRepeats', 'sameFourRepeats', 'backToBackOpp', 'backToBackPartner', 'mixedViolations', 'mixedExcess',
    'avgGap', 'maxGap', 'avgCourtSpread', 'ms',
  ];
  for (const k of maxKeys) (w as any)[k] = Math.max(...ms.map((m) => m[k] as number));
  w.partnerDiversity = Math.min(...ms.map((m) => m.partnerDiversity));
  w.opponentDiversity = Math.min(...ms.map((m) => m.opponentDiversity));
  w.valid = ms.every((m) => m.valid);
  w.invalidReason = ms.find((m) => !m.valid)?.invalidReason ?? '';
  return w;
}

function runScenario(s: Scenario): ScenarioResult {
  const players = playersOf(s);
  const perSeed = SEEDS.map((seed) => {
    const settings = settingsOf(s, seed);
    const t0 = performance.now();
    const sc = generateSchedule(players, settings, TUNING);
    const ms = performance.now() - t0;
    const m = computeMetrics(players, settings, sc, ms);
    return { seed, m, pass: judge(m, s), score: score(m, s) };
  });
  const worst = worstOf(perSeed.map((x) => x.m));
  const pass = {} as Record<CriterionId, boolean | null>;
  for (const c of CRITERIA) {
    const vals = perSeed.map((x) => x.pass[c.id]);
    pass[c.id] = vals.every((v) => v === null) ? null : vals.every((v) => v !== false);
  }
  const scores = perSeed.map((x) => x.score);
  return { scenario: s, perSeed, worst, pass, meanScore: mean(scores), minScore: Math.min(...scores) };
}

// ---------------------------------------------------------------- 报告
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const f1 = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));

function isExtreme(s: Scenario) {
  const perCourt = s.playType === PlayType.DOUBLES ? 4 : 2;
  const bye = s.N - Math.min(s.courts, Math.floor(s.N / perCourt)) * perCourt;
  return bye * 2 >= s.N;
}
function groupKey(s: Scenario) {
  return `${s.playType === PlayType.DOUBLES ? '双打' : '单打'}${s.mixed ? '·混双' : ''} / ${s.mode}${isExtreme(s) ? ' · 极端(≥半数轮空)' : ''}`;
}

function summaryTable(results: ScenarioResult[], baseline?: Record<string, any>): string {
  const groups = new Map<string, ScenarioResult[]>();
  for (const r of results) {
    const k = groupKey(r.scenario);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const head = `| 分组 | 场景数 | ${CRITERIA.map((c) => c.id).join(' | ')} | 全过 | 均分 | 最低分 |`;
  const sep = `|---|---|${CRITERIA.map(() => '---').join('|')}|---|---|---|`;
  const rows: string[] = [];
  const rate = (rs: ScenarioResult[], id: CriterionId) => {
    const applicable = rs.filter((r) => r.pass[id] !== null);
    if (!applicable.length) return '—';
    return pct(applicable.filter((r) => r.pass[id]).length, applicable.length);
  };
  const allPass = (r: ScenarioResult) => CRITERIA.every((c) => r.pass[c.id] !== false) && r.worst.valid;
  const delta = (k: string, field: string, cur: string) => {
    if (!baseline?.groups?.[k]) return cur;
    const prev = baseline.groups[k][field];
    return prev !== undefined && prev !== cur ? `${cur}（原 ${prev}）` : cur;
  };
  const groupsJson: Record<string, any> = {};
  for (const [k, rs] of [...groups.entries()].sort()) {
    const g: Record<string, string> = {};
    for (const c of CRITERIA) g[c.id] = rate(rs, c.id);
    g.all = pct(rs.filter(allPass).length, rs.length);
    g.mean = f1(mean(rs.map((r) => r.meanScore)));
    g.min = f1(Math.min(...rs.map((r) => r.minScore)));
    groupsJson[k] = g;
    rows.push(
      `| ${k} | ${rs.length} | ${CRITERIA.map((c) => delta(k, c.id, g[c.id])).join(' | ')} | ${delta(k, 'all', g.all)} | ${delta(k, 'mean', g.mean)} | ${delta(k, 'min', g.min)} |`,
    );
  }
  const total = results.length;
  const totalAll = results.filter(allPass).length;
  rows.push(
    `| **合计** | ${total} | ${CRITERIA.map((c) => rate(results, c.id)).join(' | ')} | **${pct(totalAll, total)}** | ${f1(mean(results.map((r) => r.meanScore)))} | ${f1(Math.min(...results.map((r) => r.minScore)))} |`,
  );
  (summaryTable as any).lastGroups = groupsJson;
  return [head, sep, ...rows].join('\n');
}

function scheduleText(players: EnginePlayer[], sc: EngineSchedule, mixed: boolean): string {
  const tag = (id: number) => {
    const p = players.find((x) => x.id === id)!;
    const g = mixed ? (p.gender === Gender.MALE ? '♂' : p.gender === Gender.FEMALE ? '♀' : '?') : '';
    return `${id}${g}(L${p.weight})`;
  };
  return sc.rounds
    .map((r) => {
      const ms = r.matches.map((m) => `C${m.courtNo} [${m.teamA.ids.map(tag).join('+')}] vs [${m.teamB.ids.map(tag).join('+')}] Δ${m.strengthGap}`);
      return `R${r.index}: ${ms.join(' | ')}${r.byes.length ? ` | 轮空: ${r.byes.join(',')}` : ''}`;
    })
    .join('\n');
}

function showcase(): string {
  const cases: Array<{ title: string; s: Omit<Scenario, 'key'>; seed: number }> = [
    { title: '双打·平衡·水平各异 8人2场4轮', s: { playType: PlayType.DOUBLES, mode: 'BALANCED', mixed: false, genderProfile: 'none', weightProfile: 'varied', N: 8, courts: 2, rounds: 4 }, seed: 1 },
    { title: '双打·美式·等水平 10人2场6轮（每轮2人轮空）', s: { playType: PlayType.DOUBLES, mode: 'AMERICANO', mixed: false, genderProfile: 'none', weightProfile: 'equal', N: 10, courts: 2, rounds: 6 }, seed: 1 },
    { title: '双打·墨式(无积分)·真实水平 12人3场6轮', s: { playType: PlayType.DOUBLES, mode: 'MEXICANO', mixed: false, genderProfile: 'none', weightProfile: 'realistic', N: 12, courts: 3, rounds: 6 }, seed: 1 },
    { title: '混双·平衡·4男4女 2场4轮', s: { playType: PlayType.DOUBLES, mode: 'BALANCED', mixed: true, genderProfile: 'even', weightProfile: 'varied', N: 8, courts: 2, rounds: 4 }, seed: 1 },
    { title: '混双·美式·5男4女 2场6轮（1人轮空）', s: { playType: PlayType.DOUBLES, mode: 'AMERICANO', mixed: true, genderProfile: 'even', weightProfile: 'equal', N: 9, courts: 2, rounds: 6 }, seed: 1 },
    { title: '单打·平衡·水平各异 6人3场5轮', s: { playType: PlayType.SINGLES, mode: 'BALANCED', mixed: false, genderProfile: 'none', weightProfile: 'varied', N: 6, courts: 3, rounds: 5 }, seed: 1 },
    { title: '单打·美式·等水平 7人3场6轮（1人轮空）', s: { playType: PlayType.SINGLES, mode: 'AMERICANO', mixed: false, genderProfile: 'none', weightProfile: 'equal', N: 7, courts: 3, rounds: 6 }, seed: 1 },
  ];
  return cases
    .map(({ title, s, seed }) => {
      const sc: Scenario = { ...s, key: title };
      const players = playersOf(sc);
      const settings = settingsOf(sc, seed);
      const out = generateSchedule(players, settings);
      const m = computeMetrics(players, settings, out, 0);
      const line = `出场 ${m.appMin}–${m.appMax} · 最长连打 ${m.maxStreak}(下界${m.streakLB}) · 搭档最多 ${m.maxPartnerCount}次(下界${m.partnerLB}) · 对手最多 ${m.maxOpponentCount}次(下界${m.opponentLB}) · 同阵容重复 ${m.sameMatchupRepeats} · 混双违例 ${m.mixedViolations}(下界${m.mixedLB}) · 平均实力差 ${f1(m.avgGap)}`;
      return `### ${title}（seed=${seed}）\n\n${line}\n\n\`\`\`\n${scheduleText(players, out, s.mixed)}\n\`\`\``;
    })
    .join('\n\n');
}

function failureTable(results: ScenarioResult[], limit: number): string {
  const rows = [...results]
    .filter((r) => !CRITERIA.every((c) => r.pass[c.id] !== false) || !r.worst.valid)
    .sort((a, b) => a.minScore - b.minScore)
    .slice(0, limit);
  if (!rows.length) return '（无失败场景）';
  const head = '| 场景 | 最低分 | 未过 | 出场 | 轮空差 | 连打(下界) | 连续轮空 | 搭档max(下界) | 对手max(下界) | 同阵容重复 | 混双违例(下界) | 实力差avg/max |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|';
  return [
    head,
    sep,
    ...rows.map((r) => {
      const w = r.worst;
      const failed = CRITERIA.filter((c) => r.pass[c.id] === false).map((c) => c.id).join(',') + (w.valid ? '' : ' INVALID');
      return `| ${r.scenario.key} | ${f1(r.minScore)} | ${failed} | ${w.appSpread <= 1 ? '✓' : `差${w.appSpread}`} | ${w.byeSpread} | ${w.maxStreak}(${w.streakLB}) | ${w.consecutiveByes} | ${w.maxPartnerCount}(${w.partnerLB}) | ${w.maxOpponentCount}(${w.opponentLB}) | ${w.sameMatchupRepeats} | ${w.mixedViolations}(${w.mixedLB}) | ${f1(w.avgGap)}/${w.maxGap} |`;
    }),
  ].join('\n');
}

function dimensionStats(results: ScenarioResult[]): string {
  const by = (pred: (r: ScenarioResult) => boolean) => results.filter(pred);
  const lines: string[] = [];
  const dim = (title: string, rs: ScenarioResult[], f: (w: Metrics) => number, fmt = f1) => {
    if (!rs.length) return;
    const xs = rs.map((r) => f(r.worst));
    lines.push(`- **${title}**：均值 ${fmt(mean(xs))}，最差 ${fmt(Math.max(...xs))}，为 0 的场景占 ${pct(xs.filter((x) => x === 0).length, xs.length)}`);
  };
  const withBye = by((r) => r.worst.byeCount > 0);
  dim('连续上场超出下界（streakExcess，有轮空场景）', withBye, (w) => w.streakExcess);
  dim('连续两轮轮空人次（可避免场景）', by((r) => r.worst.byeCount > 0 && r.worst.consecutiveByesAvoidable), (w) => w.consecutiveByes);
  const doubles = by((r) => r.scenario.playType === PlayType.DOUBLES);
  dim('搭档重复超出下界（partnerExcess，双打）', doubles, (w) => w.partnerExcess);
  dim('搭档重复总次数（partnerRepeats，双打）', doubles, (w) => w.partnerRepeats);
  dim('对手重复超出下界（opponentExcess）', results, (w) => w.opponentExcess);
  dim('同阵容重复次数（sameMatchupRepeats）', results, (w) => w.sameMatchupRepeats);
  dim('同 4 人再同场次数（sameFourRepeats，双打）', doubles, (w) => w.sameFourRepeats);
  dim('相邻两轮做对手的两人对（backToBackOpp，参考）', results, (w) => w.backToBackOpp);
  dim('相邻两轮做搭档（backToBackPartner，双打，参考）', doubles, (w) => w.backToBackPartner);
  {
    const perSlot = results.map((r) => r.worst.backToBackOpp / Math.max(1, (r.worst.rounds - 1) * Math.min(r.scenario.courts, Math.floor(r.scenario.N / (r.worst.teamSize * 2))) * r.worst.teamSize * r.worst.teamSize));
    lines.push(`- **相邻轮对手重复率**（backToBackOpp ÷ 相邻轮对手对总数）：均值 ${(mean(perSlot) * 100).toFixed(1)}%，最差 ${(Math.max(...perSlot) * 100).toFixed(1)}%`);
  }
  dim('混双违例超出下界（mixedExcess）', by((r) => r.scenario.mixed), (w) => w.mixedExcess);
  const modeAvgGap = (mode: ModeLabel) => by((r) => r.scenario.mode === mode && r.scenario.weightProfile !== 'equal');
  for (const mode of MODES) dim(`平均两队实力差（${mode}，非等水平场景）`, modeAvgGap(mode), (w) => w.avgGap);
  for (const mode of MODES) dim(`同场水平跨度（${mode}，非等水平场景，越小越"同水平同场"）`, modeAvgGap(mode), (w) => w.avgCourtSpread);
  const pd = doubles.map((r) => r.worst.partnerDiversity);
  const od = results.map((r) => r.worst.opponentDiversity);
  lines.push(`- **搭档多样性**（双打，1=搭遍能搭的人）：均值 ${f1(mean(pd))}，最差 ${f1(Math.min(...pd))}`);
  lines.push(`- **对手多样性**（1=遇遍所有人）：均值 ${f1(mean(od))}，最差 ${f1(Math.min(...od))}`);
  const ms = results.map((r) => r.worst.ms);
  lines.push(`- **耗时**：单份赛程最长 ${f1(Math.max(...ms))} ms，均值 ${f1(mean(ms))} ms`);
  return lines.join('\n');
}

function main() {
  const scenarios = FILTER ? buildScenarios().filter((s) => new RegExp(FILTER).test(s.key)) : buildScenarios();
  const t0 = Date.now();
  const results = scenarios.map(runScenario);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const invalid = results.filter((r) => !r.worst.valid);
  let baseline: any;
  if (BASELINE && fs.existsSync(BASELINE)) baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  let rev = 'unknown';
  try {
    rev = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {}

  const summary = summaryTable(results, baseline);
  const groups = (summaryTable as any).lastGroups;

  // 与基线逐场景对比
  let deltaSection = '';
  if (baseline?.scenarios) {
    const prev = new Map<string, any>(baseline.scenarios.map((s: any) => [s.key, s]));
    let improved = 0;
    let regressed = 0;
    const regressions: string[] = [];
    for (const r of results) {
      const p = prev.get(r.scenario.key);
      if (!p) continue;
      if (r.minScore > p.minScore + 0.05) improved++;
      else if (r.minScore < p.minScore - 0.05) {
        regressed++;
        if (regressions.length < 15) regressions.push(`  - ${r.scenario.key}: ${f1(p.minScore)} → ${f1(r.minScore)}`);
      }
    }
    deltaSection = `\n## 与基线对比（${path.basename(BASELINE!)}）\n\n- 提升 ${improved} 个场景，退步 ${regressed} 个场景（按最低分）\n${regressions.length ? `- 退步样例：\n${regressions.join('\n')}` : ''}\n`;
  }

  const md = `# 分组引擎评测报告${LABEL ? ` · ${LABEL}` : ''}

- 生成时间：${new Date().toISOString()} · 引擎版本：\`${rev}\` · 耗时 ${elapsed}s
- 场景数：${scenarios.length}（每场景 ${SEEDS.length} 个 seed：${SEEDS.join(',')}），轮数 ${ROUNDS.join('/')}，单打人数 ${SINGLES_N.join('/')}，双打人数 ${DOUBLES_N.join('/')}，场地 1–4
- 权重分布：equal(全 L3) / varied(L6→L1 循环) / realistic(以 L2–L4 为主夹杂 L1/L5/L6)；混双性别分布：even(男女交替) / uneven(≈60% 男) / unknownMix(男女交替 + 每 5 人 1 个未知)
- 判定口径：每个场景**所有 seed 都通过**才算该项通过；"最差"列取各 seed 中最差值
- 不变量违反（同轮重复出场/队伍人数错/轮空不互补）：**${invalid.length}** 个场景${invalid.length ? `（如 ${invalid[0].scenario.key}: ${invalid[0].worst.invalidReason}）` : ''}

## 验收标准

| 编号 | 名称 | 口径 |
|---|---|---|
${CRITERIA.map((c) => `| ${c.id} | ${c.name} | ${c.desc} |`).join('\n')}

综合分（0–100）：从 100 起扣——出场差>1 扣 25、轮空差>1 扣 15、连打超下界每轮扣 8（上限 24）、可避免的连续轮空扣 10、搭档超下界每次扣 10（上限 20）+ 搭档多样性缺口×20、对手超下界每次扣 6（上限 18）+ 对手多样性缺口×15、同阵容重复每次扣 5（上限 20）、混双违例超下界每队扣 10（上限 30）、平衡/墨式平均实力差超 1 每单位扣 10（上限 20）。

## 总览：各分组通过率

${summary}
${deltaSection}
## 分维度统计（取各场景最差 seed）

${dimensionStats(results)}

## 失败最严重的场景 Top 40

${failureTable(results, 40)}

## 样例赛程（人工目检）

${showcase()}
`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md);
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          rev,
          label: LABEL,
          seeds: SEEDS,
          groups,
          scenarios: results.map((r) => ({ key: r.scenario.key, minScore: r.minScore, meanScore: r.meanScore, pass: r.pass, worst: r.worst })),
        },
        null,
        1,
      ),
    );
  }
  const allPass = results.filter((r) => CRITERIA.every((c) => r.pass[c.id] !== false) && r.worst.valid).length;
  console.log(`scenarios=${scenarios.length} allPass=${allPass} (${pct(allPass, scenarios.length)}) invalid=${invalid.length} meanScore=${f1(mean(results.map((r) => r.meanScore)))} elapsed=${elapsed}s → ${OUT}`);
}

main();
