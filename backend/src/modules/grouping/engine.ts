import { GroupMode, PlayType, RotationKind, Gender } from '@badminton/shared';

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
  repeatPartnerPairs: number;
  repeatOpponentPairs: number;
  /** 混双约束下未能满足「一男一女」的队伍数（仅 mixedDoubles 双打时累计） */
  mixedViolations: number;
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

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function teamSizeOf(playType: PlayType): number {
  return playType === PlayType.DOUBLES ? 2 : 1;
}

// ============ 主入口 ============
export function generateSchedule(players: EnginePlayer[], settings: EngineSettings): EngineSchedule {
  const teamSize = teamSizeOf(settings.playType);
  const perCourt = teamSize * 2;
  const rng = mulberry32(settings.seed ?? 42);
  const N = players.length;

  // 每轮可开的场地数与轮空人数（恒定）
  const matchesPerRound = Math.min(settings.courtCount, Math.floor(N / perCourt));
  const playingPerRound = matchesPerRound * perCourt;
  const byeCount = N - playingPerRound;

  // 追踪状态
  const appearances = new Map<number, number>(players.map((p) => [p.id, 0]));
  const byeTally = new Map<number, number>(players.map((p) => [p.id, 0]));
  const partnerCount = new Map<string, number>();
  const opponentCount = new Map<string, number>();
  const genderOf = new Map<number, Gender>(players.map((p) => [p.id, p.gender]));
  const wantMixed = teamSize === 2 && !!settings.mixedDoubles;
  let mixedViolations = 0;

  const rounds: EngineRound[] = [];

  for (let r = 1; r <= settings.rounds; r++) {
    if (matchesPerRound === 0) {
      rounds.push({ index: r, matches: [], byes: players.map((p) => p.id) });
      continue;
    }

    // 1) 选轮空：优先让“轮空最少”的人休息（等价于让出场最多的人休息），保证休息/出场均衡
    const byIds = [...players].sort((a, b) => {
      const ba = byeTally.get(a.id)!;
      const bb = byeTally.get(b.id)!;
      if (ba !== bb) return ba - bb; // 轮空少者优先休息
      const aa = appearances.get(a.id)!;
      const ab = appearances.get(b.id)!;
      if (aa !== ab) return ab - aa; // 出场多者优先休息
      return rng() - 0.5;
    });
    const byes = byIds.slice(0, byeCount).map((p) => p.id);
    const byeSet = new Set(byes);
    const playing = players.filter((p) => !byeSet.has(p.id));
    byes.forEach((id) => byeTally.set(id, byeTally.get(id)! + 1));

    // 2) 组场
    let matches: EngineMatch[];
    const isAmericano = settings.mode === GroupMode.ROTATION && settings.rotation === RotationKind.AMERICANO;
    if (wantMixed) {
      // 混双：先按「一男一女」组队（尽量），再按模式分场（美式按少重复对手 / 其余按均衡）
      const ranking = rankingScore(playing, settings);
      const weightOf = new Map(playing.map((p) => [p.id, p.weight]));
      const teams = formMixedTeams(playing, ranking, partnerCount, genderOf, rng);
      matches = isAmericano
        ? pairTeamsByOpponent(teams, weightOf, opponentCount)
        : pairTeamsBalanced(teams, weightOf);
    } else if (isAmericano) {
      matches = formAmericano(playing, teamSize, matchesPerRound, partnerCount, opponentCount, rng);
    } else {
      // BALANCED 或 ROTATION/MEXICANO：按“排名”分场，强弱搭配，court 内两队均衡
      const ranking = rankingScore(playing, settings);
      matches = formByRanking(playing, teamSize, matchesPerRound, ranking, rng);
    }

    // 3) 记账
    for (const m of matches) {
      for (const id of m.teamA.ids) appearances.set(id, appearances.get(id)! + 1);
      for (const id of m.teamB.ids) appearances.set(id, appearances.get(id)! + 1);
      tallyPairs(m.teamA.ids, partnerCount);
      tallyPairs(m.teamB.ids, partnerCount);
      for (const a of m.teamA.ids) for (const b of m.teamB.ids) {
        opponentCount.set(pairKey(a, b), (opponentCount.get(pairKey(a, b)) ?? 0) + 1);
      }
      if (wantMixed) {
        if (sameKnownGender(m.teamA.ids, genderOf)) mixedViolations++;
        if (sameKnownGender(m.teamB.ids, genderOf)) mixedViolations++;
      }
    }
    rounds.push({ index: r, matches, byes });
  }

  return {
    rounds,
    metrics: computeMetrics(rounds, settings, appearances, byeCount, partnerCount, opponentCount, mixedViolations),
  };
}

// 排名分：平衡=水平权重；墨式=积分(缺省回退水平权重)
function rankingScore(playing: EnginePlayer[], settings: EngineSettings): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of playing) {
    const live = settings.standings?.[p.id];
    m.set(p.id, settings.mode === GroupMode.ROTATION && settings.rotation === RotationKind.MEXICANO && live != null ? live : p.weight);
  }
  return m;
}

// 按排名分场：相近水平进同一场地，场内拆成均衡两队
function formByRanking(
  playing: EnginePlayer[],
  teamSize: number,
  matchesPerRound: number,
  ranking: Map<number, number>,
  rng: () => number,
): EngineMatch[] {
  const weightOf = new Map(playing.map((p) => [p.id, p.weight]));
  const sorted = [...playing].sort((a, b) => {
    const d = ranking.get(b.id)! - ranking.get(a.id)!;
    return d !== 0 ? d : rng() - 0.5;
  });
  const perCourt = teamSize * 2;
  const matches: EngineMatch[] = [];
  for (let c = 0; c < matchesPerRound; c++) {
    const chunk = sorted.slice(c * perCourt, c * perCourt + perCourt);
    matches.push(splitBalancedTeams(chunk, teamSize, weightOf, c + 1));
  }
  return matches;
}

// 把一组(perCourt)选手按水平拆成尽量均衡的两队
function splitBalancedTeams(
  chunk: EnginePlayer[],
  teamSize: number,
  weightOf: Map<number, number>,
  courtNo: number,
): EngineMatch {
  // chunk 已按排名降序
  let aIds: number[];
  let bIds: number[];
  if (teamSize === 1) {
    aIds = [chunk[0].id];
    bIds = [chunk[1].id];
  } else {
    // 4 人 a>=b>=c>=d → {a,d} vs {b,c} 使两队和最接近
    const [a, b, c, d] = chunk;
    aIds = [a.id, d.id];
    bIds = [b.id, c.id];
  }
  return makeMatch(courtNo, aIds, bIds, weightOf);
}

// 美式：尽量不重复搭档/对手
function formAmericano(
  playing: EnginePlayer[],
  teamSize: number,
  matchesPerRound: number,
  partnerCount: Map<string, number>,
  opponentCount: Map<string, number>,
  rng: () => number,
): EngineMatch[] {
  const weightOf = new Map(playing.map((p) => [p.id, p.weight]));
  // 打散（确定性）
  const pool = [...playing].sort(() => rng() - 0.5).map((p) => p.id);

  // 2.1 组队（doubles 才需要）
  let teams: number[][];
  if (teamSize === 1) {
    teams = pool.map((id) => [id]);
  } else {
    teams = [];
    const remaining = [...pool];
    while (remaining.length >= 2) {
      const x = remaining.shift()!;
      // 选与 x 搭档次数最少者
      let bestIdx = 0;
      let bestScore = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const score = partnerCount.get(pairKey(x, remaining[i])) ?? 0;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      const y = remaining.splice(bestIdx, 1)[0];
      teams.push([x, y]);
    }
  }

  // 2.2 配对成场：尽量不重复对手
  return pairTeamsByOpponent(teams.slice(0, matchesPerRound * 2), weightOf, opponentCount);
}

const isMale = (g?: Gender) => g === Gender.MALE;
const isFemale = (g?: Gender) => g === Gender.FEMALE;
/** 两人是否「同一已知性别」（混双违例：男男 / 女女；含 UNKNOWN 一律视作可搭配） */
function sameKnownGender(ids: number[], genderOf: Map<number, Gender>): boolean {
  if (ids.length !== 2) return false;
  const [g0, g1] = [genderOf.get(ids[0]), genderOf.get(ids[1])];
  return (isMale(g0) && isMale(g1)) || (isFemale(g0) && isFemale(g1));
}

/**
 * 混双组队：贪心地为每名选手挑「能形成一男一女(或含 UNKNOWN)」且历史搭档最少的队友。
 * 性别分布不足时退化为同性组队（由调用方计入 mixedViolations）。
 */
function formMixedTeams(
  playing: EnginePlayer[],
  ranking: Map<number, number>,
  partnerCount: Map<string, number>,
  genderOf: Map<number, Gender>,
  rng: () => number,
): number[][] {
  const remaining = [...playing]
    .sort((a, b) => {
      const d = ranking.get(b.id)! - ranking.get(a.id)!;
      return d !== 0 ? d : rng() - 0.5;
    })
    .map((p) => p.id);
  const teams: number[][] = [];
  while (remaining.length >= 2) {
    const x = remaining.shift()!;
    const gx = genderOf.get(x);
    let bestIdx = 0;
    let bestPref = -1; // 1 = 可满足混双（非同性），0 = 同性
    let bestScore = Infinity; // 搭档历史次数，越小越好
    for (let i = 0; i < remaining.length; i++) {
      const y = remaining[i];
      const nonViolation = !sameKnownGender([x, y], genderOf) || (!isMale(gx) && !isFemale(gx));
      const pref = nonViolation ? 1 : 0;
      const score = partnerCount.get(pairKey(x, y)) ?? 0;
      if (pref > bestPref || (pref === bestPref && score < bestScore)) {
        bestPref = pref;
        bestScore = score;
        bestIdx = i;
      }
    }
    const y = remaining.splice(bestIdx, 1)[0];
    teams.push([x, y]);
  }
  return teams;
}

/** 已组好的队伍按实力降序相邻配对成场（court 内两队尽量势均力敌） */
function pairTeamsBalanced(teams: number[][], weightOf: Map<number, number>): EngineMatch[] {
  const withStrength = teams
    .map((ids) => ({ ids, strength: ids.reduce((s, id) => s + (weightOf.get(id) ?? 0), 0) }))
    .sort((a, b) => b.strength - a.strength);
  const matches: EngineMatch[] = [];
  for (let c = 0; c * 2 + 1 < withStrength.length; c++) {
    matches.push(makeMatch(c + 1, withStrength[c * 2].ids, withStrength[c * 2 + 1].ids, weightOf));
  }
  return matches;
}

/** 已组好的队伍按「最少重复对手」配对成场（美式轮转用） */
function pairTeamsByOpponent(
  teams: number[][],
  weightOf: Map<number, number>,
  opponentCount: Map<string, number>,
): EngineMatch[] {
  const matches: EngineMatch[] = [];
  const used = new Array(teams.length).fill(false);
  let courtNo = 1;
  for (let i = 0; i < teams.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let bestJ = -1;
    let bestScore = Infinity;
    for (let j = i + 1; j < teams.length; j++) {
      if (used[j]) continue;
      let score = 0;
      for (const a of teams[i]) for (const b of teams[j]) score += opponentCount.get(pairKey(a, b)) ?? 0;
      if (score < bestScore) {
        bestScore = score;
        bestJ = j;
      }
    }
    if (bestJ === -1) break;
    used[bestJ] = true;
    matches.push(makeMatch(courtNo++, teams[i], teams[bestJ], weightOf));
  }
  return matches;
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

function tallyPairs(ids: number[], counter: Map<string, number>) {
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const k = pairKey(ids[i], ids[j]);
      counter.set(k, (counter.get(k) ?? 0) + 1);
    }
}

function computeMetrics(
  rounds: EngineRound[],
  settings: EngineSettings,
  appearances: Map<number, number>,
  byeCount: number,
  partnerCount: Map<string, number>,
  opponentCount: Map<string, number>,
  mixedViolations: number,
): EngineMetrics {
  const apps = [...appearances.values()];
  const totalMatches = rounds.reduce((s, r) => s + r.matches.length, 0);
  let repeatPartnerPairs = 0;
  for (const v of partnerCount.values()) repeatPartnerPairs += Math.max(0, v - 1);
  let repeatOpponentPairs = 0;
  for (const v of opponentCount.values()) repeatOpponentPairs += Math.max(0, v - 1);
  return {
    totalMatches,
    rounds: settings.rounds,
    appearancesMin: apps.length ? Math.min(...apps) : 0,
    appearancesMax: apps.length ? Math.max(...apps) : 0,
    byePerRound: byeCount,
    repeatPartnerPairs,
    repeatOpponentPairs,
    mixedViolations,
  };
}
