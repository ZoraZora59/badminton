import { describe, it, expect } from 'vitest';
import { GroupMode, PlayType, RotationKind, Gender } from '@badminton/shared';
import { generateSchedule, type EnginePlayer, type EngineSchedule, type EngineSettings } from '../src/modules/grouping/engine';

function makePlayers(weights: number[]): EnginePlayer[] {
  return weights.map((w, i) => ({ id: i + 1, weight: w, gender: Gender.UNKNOWN }));
}

function teamSize(pt: PlayType) {
  return pt === PlayType.DOUBLES ? 2 : 1;
}

/** 通用不变量：每轮每人至多出场一次、队伍人数正确、轮空与出场互补、场地号唯一 */
function assertValid(schedule: EngineSchedule, players: EnginePlayer[], settings: EngineSettings) {
  const N = players.length;
  const ts = teamSize(settings.playType);
  const perCourt = ts * 2;
  const expectedMatches = Math.min(settings.courtCount, Math.floor(N / perCourt));
  const expectedBye = N - expectedMatches * perCourt;

  for (const round of schedule.rounds) {
    const seen = new Set<number>();
    const courts = new Set<number>();
    for (const m of round.matches) {
      expect(m.teamA.ids.length).toBe(ts);
      expect(m.teamB.ids.length).toBe(ts);
      expect(courts.has(m.courtNo)).toBe(false);
      courts.add(m.courtNo);
      for (const id of [...m.teamA.ids, ...m.teamB.ids]) {
        expect(seen.has(id)).toBe(false); // 同一轮不重复出场
        seen.add(id);
      }
    }
    expect(round.matches.length).toBe(expectedMatches);
    expect(round.byes.length).toBe(expectedBye);
    // 轮空与出场互补、并集等于全体
    for (const b of round.byes) expect(seen.has(b)).toBe(false);
    expect(seen.size + round.byes.length).toBe(N);
  }
}

function appearances(schedule: EngineSchedule, players: EnginePlayer[]) {
  const m = new Map(players.map((p) => [p.id, 0]));
  for (const r of schedule.rounds)
    for (const match of r.matches)
      for (const id of [...match.teamA.ids, ...match.teamB.ids]) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m.values()];
}

/** 统计每人轮空次数（用于非整除人数的轮空公平性断言） */
function byeTally(schedule: EngineSchedule, players: EnginePlayer[]) {
  const m = new Map(players.map((p) => [p.id, 0]));
  for (const r of schedule.rounds) for (const b of r.byes) m.set(b, (m.get(b) ?? 0) + 1);
  return [...m.values()];
}

describe('grouping engine — 通用不变量', () => {
  const cases: Array<{ name: string; weights: number[]; settings: EngineSettings }> = [
    {
      name: 'balanced doubles 8人2场4轮',
      weights: [6, 5, 4, 3, 3, 2, 2, 1],
      settings: { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 4, seed: 1 },
    },
    {
      name: 'americano doubles 10人2场5轮(每轮2轮空)',
      weights: [4, 4, 3, 3, 3, 3, 2, 2, 1, 1],
      settings: { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 5, seed: 7 },
    },
    {
      name: 'singles balanced 6人3场3轮',
      weights: [6, 5, 4, 3, 2, 1],
      settings: { playType: PlayType.SINGLES, mode: GroupMode.BALANCED, courtCount: 3, rounds: 3, seed: 3 },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const players = makePlayers(c.weights);
      const schedule = generateSchedule(players, c.settings);
      assertValid(schedule, players, c.settings);
    });
  }
});

describe('grouping engine — 出场/轮空均衡', () => {
  it('10人2场双打跑5轮：每人恰好出场4次、轮空1次', () => {
    const players = makePlayers([4, 4, 3, 3, 3, 3, 2, 2, 1, 1]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 5, seed: 9 };
    const schedule = generateSchedule(players, settings);
    const apps = appearances(schedule, players);
    expect(Math.max(...apps) - Math.min(...apps)).toBeLessThanOrEqual(1);
    expect(apps.every((a) => a === 4)).toBe(true); // 10人*4 = 2场*2轮... 实际 40 出场名额 / 10人 = 4
    expect(schedule.metrics.byePerRound).toBe(2);
  });

  it('8人2场双打4轮：人人满勤无轮空', () => {
    const players = makePlayers([5, 5, 4, 4, 3, 3, 2, 2]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 3, rounds: 4, seed: 2 };
    const schedule = generateSchedule(players, settings);
    const apps = appearances(schedule, players);
    expect(apps.every((a) => a === 4)).toBe(true);
    expect(schedule.metrics.byePerRound).toBe(0);
  });
});

describe('grouping engine — 平衡模式：场内两队势均力敌', () => {
  it('4人一场 a>=b>=c>=d → {a,d} vs {b,c}，实力差最小', () => {
    const players = makePlayers([6, 4, 3, 1]); // 期望 {6,1}=7 vs {4,3}=7
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 1, rounds: 1, seed: 1 };
    const schedule = generateSchedule(players, settings);
    const m = schedule.rounds[0].matches[0];
    expect(m.strengthGap).toBe(0);
    expect(m.teamA.strength).toBe(m.teamB.strength);
  });
});

describe('grouping engine — 美式：尽量不重复搭档/对手', () => {
  it('8人2场双打3轮：无自搭档，重复搭档对数受控', () => {
    const players = makePlayers([3, 3, 3, 3, 3, 3, 3, 3]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 3, seed: 5 };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    // 每轮 4 对搭档，3 轮 12 对，理论可全不重复（C(8,2)=28）
    expect(schedule.metrics.repeatPartnerPairs).toBeLessThanOrEqual(2);
  });
});

describe('grouping engine — 墨式：按积分(standings)动态配对', () => {
  it('用 standings 决定排名，court1 应为积分前4', () => {
    const players = makePlayers([3, 3, 3, 3, 3, 3, 3, 3]);
    const standings: Record<number, number> = { 1: 100, 2: 90, 3: 80, 4: 70, 5: 60, 6: 50, 7: 40, 8: 30 };
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.MEXICANO, courtCount: 2, rounds: 1, seed: 1, standings };
    const schedule = generateSchedule(players, settings);
    const court1 = schedule.rounds[0].matches.find((m) => m.courtNo === 1)!;
    const ids = [...court1.teamA.ids, ...court1.teamB.ids].sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4]);
  });
});

describe('grouping engine — 混双约束', () => {
  const G = (gs: Gender[], weights?: number[]): EnginePlayer[] =>
    gs.map((g, i) => ({ id: i + 1, weight: weights?.[i] ?? 3, gender: g }));
  const M = Gender.MALE;
  const F = Gender.FEMALE;
  const teamGenders = (ids: number[], players: EnginePlayer[]) =>
    ids.map((id) => players.find((p) => p.id === id)!.gender);
  const isMixedTeam = (ids: number[], players: EnginePlayer[]) => {
    const [a, b] = teamGenders(ids, players);
    return !((a === M && b === M) || (a === F && b === F));
  };

  it('4男4女双打：开启混双时每队都是一男一女，无违例', () => {
    const players = G([M, M, M, M, F, F, F, F]);
    const settings: EngineSettings = {
      playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 4, seed: 11, mixedDoubles: true,
    };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    expect(schedule.metrics.mixedViolations).toBe(0);
    for (const r of schedule.rounds)
      for (const m of r.matches) {
        expect(isMixedTeam(m.teamA.ids, players)).toBe(true);
        expect(isMixedTeam(m.teamB.ids, players)).toBe(true);
      }
  });

  it('6男2女双打：混双无法完全满足时，报出违例队伍数', () => {
    const players = G([M, M, M, M, M, M, F, F]);
    const settings: EngineSettings = {
      playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 1, seed: 5, mixedDoubles: true,
    };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    // 4 队中至多 2 队能混双（女仅 2 人）→ 2 队违例
    expect(schedule.metrics.mixedViolations).toBe(2);
  });

  it('不开混双：保持原 {a,d}vs{b,c} 平衡行为不受影响', () => {
    const players = makePlayers([6, 4, 3, 1]); // 期望 {6,1} vs {4,3}
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 1, rounds: 1, seed: 1 };
    const schedule = generateSchedule(players, settings);
    expect(schedule.rounds[0].matches[0].strengthGap).toBe(0);
    expect(schedule.metrics.mixedViolations).toBe(0);
  });
});

describe('grouping engine — 边界', () => {
  it('人数不足一场：全员轮空', () => {
    const players = makePlayers([3, 3, 3]); // 双打需4人
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 2, seed: 1 };
    const schedule = generateSchedule(players, settings);
    expect(schedule.rounds.every((r) => r.matches.length === 0 && r.byes.length === 3)).toBe(true);
  });

  it('相同输入+相同seed → 确定性可复现', () => {
    const players = makePlayers([5, 4, 4, 3, 3, 2, 2, 1, 1, 1]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 4, seed: 42 };
    const a = JSON.stringify(generateSchedule(players, settings));
    const b = JSON.stringify(generateSchedule(players, settings));
    expect(a).toBe(b);
  });

  it('相同输入+不同seed → 排布不同', () => {
    // 10人2场6轮美式：排布空间足够大，seed:1 与 seed:2 理论上不会撞出同一份 schedule
    const players = makePlayers([5, 4, 4, 3, 3, 3, 2, 2, 1, 1]);
    const base: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 6 };
    const a = JSON.stringify(generateSchedule(players, { ...base, seed: 1 }));
    const b = JSON.stringify(generateSchedule(players, { ...base, seed: 2 }));
    expect(a).not.toBe(b);
  });
});

describe('grouping engine — 美式：重复对手受控', () => {
  it('8人等权重2场跑7轮：repeatOpponentPairs 有经验上限', () => {
    // 每轮 2 场 × 每场 4 对对手相遇 = 8 次，7 轮共 56 次；不同对手对最多 C(8,2)=28
    // → 理论下限 = 56 - 28 = 28 次重复。实测 seed=1 为 29（多 seed 实测 28~29），锁定 [28, 31]
    const players = makePlayers([3, 3, 3, 3, 3, 3, 3, 3]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 7, seed: 1 };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    expect(schedule.metrics.repeatOpponentPairs).toBeGreaterThanOrEqual(28);
    expect(schedule.metrics.repeatOpponentPairs).toBeLessThanOrEqual(31);
  });

  it('对照：同配置只跑2轮时重复对手接近 0', () => {
    // 2 轮仅 16 次对手相遇 < 28 对，理论可完全不重复；实测 seed=5 为 0（其余 seed 实测 0~3）
    const players = makePlayers([3, 3, 3, 3, 3, 3, 3, 3]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 2, seed: 5 };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    expect(schedule.metrics.repeatOpponentPairs).toBeLessThanOrEqual(2);
  });
});

describe('grouping engine — 混双×美式（pairTeamsByOpponent 分支）', () => {
  const G = (gs: Gender[]): EnginePlayer[] => gs.map((g, i) => ({ id: i + 1, weight: 3, gender: g }));
  const M = Gender.MALE;
  const F = Gender.FEMALE;

  it('4男4女美式混双2场4轮：不变量成立、无违例、每队一男一女、重复对手受控', () => {
    const players = G([M, M, M, M, F, F, F, F]);
    const settings: EngineSettings = {
      playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 4, seed: 7, mixedDoubles: true,
    };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    expect(schedule.metrics.mixedViolations).toBe(0);
    const genderOf = new Map(players.map((p) => [p.id, p.gender]));
    for (const r of schedule.rounds)
      for (const m of r.matches)
        for (const ids of [m.teamA.ids, m.teamB.ids]) {
          const gs = ids.map((id) => genderOf.get(id)!).sort();
          expect(gs).toEqual([F, M]); // 每队恰好一男一女
        }
    // 每轮 8 次对手相遇 × 4 轮 = 32 次；混双约束限制配对自由度，重复高于纯美式
    // 实测 seed=7 为 10（多 seed 实测 9~10），锁定上限 12
    expect(schedule.metrics.repeatOpponentPairs).toBeLessThanOrEqual(12);
  });
});

describe('grouping engine — 混双：UNKNOWN 性别（Guest 无性别是常态输入）', () => {
  const G = (gs: Gender[]): EnginePlayer[] => gs.map((g, i) => ({ id: i + 1, weight: 3, gender: g }));
  const M = Gender.MALE;
  const F = Gender.FEMALE;
  const U = Gender.UNKNOWN;

  it('3男3女2未知开混双：UNKNOWN 视作可任意搭配，无违例', () => {
    const players = G([M, M, M, F, F, F, U, U]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 3, seed: 3, mixedDoubles: true };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    expect(schedule.metrics.mixedViolations).toBe(0);
  });

  it('全 UNKNOWN 开混双：不算违例', () => {
    const players = G([U, U, U, U, U, U, U, U]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 3, seed: 3, mixedDoubles: true };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    expect(schedule.metrics.mixedViolations).toBe(0);
  });
});

describe('grouping engine — 非整除人数：轮空公平', () => {
  it('9人2场双打4轮：每人轮空次数差不超过1', () => {
    // 每轮 8 人上场、1 人轮空，4 轮共 4 人次轮空摊给 9 人 → 公平时 max-min<=1
    const players = makePlayers([5, 4, 4, 3, 3, 3, 2, 2, 1]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 2, rounds: 4, seed: 1 };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    const byes = byeTally(schedule, players);
    expect(Math.max(...byes) - Math.min(...byes)).toBeLessThanOrEqual(1);
  });
});

describe('grouping engine — 单打×美式', () => {
  it('6人3场单打5轮：不变量成立、每人出场5次、重复对手受控', () => {
    const players = makePlayers([6, 5, 4, 3, 2, 1]);
    const settings: EngineSettings = { playType: PlayType.SINGLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 3, rounds: 5, seed: 1 };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    const apps = appearances(schedule, players);
    expect(apps.every((a) => a === 5)).toBe(true); // 6人3场无轮空，人人满勤
    // 每轮 3 对对手 × 5 轮 = 15 次相遇 = C(6,2)，理论可全不重复；实测 seed=1 为 3，锁定上限 5
    expect(schedule.metrics.repeatOpponentPairs).toBeLessThanOrEqual(5);
  });
});

describe('grouping engine — 混双违例跨轮累计', () => {
  it('6男2女3轮：违例按队伍逐轮累计 → 每轮2队违例 × 3轮 = 6', () => {
    // 口径说明：mixedViolations 是「每轮每支同性队伍计 1」的跨轮累计值，
    // 不是去重后的队伍数（同一对男男组合打 3 轮会计 3 次）
    const G = (gs: Gender[]): EnginePlayer[] => gs.map((g, i) => ({ id: i + 1, weight: 3, gender: g }));
    const M = Gender.MALE;
    const F = Gender.FEMALE;
    const players = G([M, M, M, M, M, M, F, F]);
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 3, seed: 5, mixedDoubles: true };
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    expect(schedule.metrics.mixedViolations).toBe(6);
  });
});

// =====================================================================================
// 评测回归：docs/engine-eval/README.md 里审计确认的 18 条缺陷（C0–C17），每条至少一个用例。
// 断言在 seed 1..5 上都要成立，阈值取自终版实测并留余量（理论下界见各用例注释）。
// =====================================================================================
describe('grouping engine — 评测回归（审计缺陷 C0–C17）', () => {
  const M = Gender.MALE;
  const F = Gender.FEMALE;
  const U = Gender.UNKNOWN;
  const SEEDS = [1, 2, 3, 4, 5];
  const PL = (ws: number[], gs?: Gender[]): EnginePlayer[] => ws.map((w, i) => ({ id: 1001 + i * 3, weight: w, gender: gs?.[i] ?? U }));
  const BAL = { mode: GroupMode.BALANCED };
  const AME = { mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO };
  const MEX = { mode: GroupMode.ROTATION, rotation: RotationKind.MEXICANO };
  const pk = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  /** 从赛程独立重算各项指标（不信任 engine.metrics） */
  function analyze(schedule: EngineSchedule, players: EnginePlayer[]) {
    const partner = new Map<string, number>();
    const opponent = new Map<string, number>();
    const matchup = new Map<string, number>();
    const partnersOf = new Map<number, Set<number>>(players.map((p) => [p.id, new Set()]));
    const lineups = new Set<string>();
    const gaps: number[] = [];
    let backToBackPartner = 0;
    let backToBackOpp = 0;
    let prevPtn = new Set<string>();
    let prevOpp = new Set<string>();
    for (const r of schedule.rounds) {
      const curPtn = new Set<string>();
      const curOpp = new Set<string>();
      const sides: string[] = [];
      for (const m of r.matches) {
        const A = [...m.teamA.ids].sort((a, b) => a - b);
        const B = [...m.teamB.ids].sort((a, b) => a - b);
        for (const T of [A, B])
          if (T.length === 2) {
            const k = pk(T[0], T[1]);
            partner.set(k, (partner.get(k) ?? 0) + 1);
            curPtn.add(k);
            partnersOf.get(T[0])!.add(T[1]);
            partnersOf.get(T[1])!.add(T[0]);
          }
        for (const a of A)
          for (const b of B) {
            const k = pk(a, b);
            opponent.set(k, (opponent.get(k) ?? 0) + 1);
            curOpp.add(k);
          }
        const key = [A.join('+'), B.join('+')].sort().join(' v ');
        matchup.set(key, (matchup.get(key) ?? 0) + 1);
        sides.push(key);
        gaps.push(m.strengthGap);
      }
      lineups.add(sides.sort().join(' | '));
      for (const k of curPtn) if (prevPtn.has(k)) backToBackPartner++;
      for (const k of curOpp) if (prevOpp.has(k)) backToBackOpp++;
      prevPtn = curPtn;
      prevOpp = curOpp;
    }
    // 连打 / 连续轮空
    let maxStreak = 0;
    let consecByes = 0;
    for (const p of players) {
      let s = 0;
      schedule.rounds.forEach((r, i) => {
        if (r.byes.includes(p.id)) {
          if (i > 0 && schedule.rounds[i - 1].byes.includes(p.id)) consecByes++;
          s = 0;
        } else {
          s++;
          maxStreak = Math.max(maxStreak, s);
        }
      });
    }
    const max = (m: Map<string, number>) => (m.size ? Math.max(...m.values()) : 0);
    const repeats = (m: Map<string, number>) => [...m.values()].reduce((t, v) => t + Math.max(0, v - 1), 0);
    return {
      partnerMax: max(partner),
      partnerRepeats: repeats(partner),
      opponentMax: max(opponent),
      opponentRepeats: repeats(opponent),
      sameMatchup: repeats(matchup),
      distinctLineups: lineups.size,
      minDistinctPartners: Math.min(...[...partnersOf.values()].map((s) => s.size)),
      maxGap: gaps.length ? Math.max(...gaps) : 0,
      avgGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0,
      gaps,
      maxStreak,
      consecByes,
      backToBackPartner,
      backToBackOpp,
    };
  }
  const run = (players: EnginePlayer[], s: Omit<EngineSettings, 'seed'>, seed: number) => {
    const settings = { ...s, seed } as EngineSettings;
    const schedule = generateSchedule(players, settings);
    assertValid(schedule, players, settings);
    return { schedule, a: analyze(schedule, players) };
  };

  it('C0 平衡双打水平各异：每轮阵容都不同、无完全相同的对阵、搭档轮换、实力差可控', () => {
    const players = PL([6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
    for (const seed of SEEDS) {
      const { a } = run(players, { playType: PlayType.DOUBLES, ...BAL, courtCount: 3, rounds: 8 }, seed);
      expect(a.distinctLineups).toBe(8); // 旧引擎：8 轮一模一样
      expect(a.sameMatchup).toBe(0);
      expect(a.partnerMax).toBeLessThanOrEqual(2); // 旧引擎：同一对搭档 6~7 次
      expect(a.minDistinctPartners).toBeGreaterThanOrEqual(6); // 旧引擎：每人只有 2 个搭档
      expect(a.maxGap).toBeLessThanOrEqual(3);
    }
    const eight = PL([6, 5, 4, 3, 3, 2, 2, 1]);
    for (const seed of SEEDS) {
      const { a } = run(eight, { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 6 }, seed);
      expect(a.distinctLineups).toBe(6);
      expect(a.sameMatchup).toBe(0);
      expect(a.partnerMax).toBeLessThanOrEqual(2);
      expect(a.maxGap).toBeLessThanOrEqual(3);
    }
  });

  it('C1 平衡单打：不再整晚打同一个人（6 人 5 轮 = 完整循环，无相邻轮再碰）', () => {
    const players = PL([6, 5, 4, 3, 2, 1]);
    for (const seed of SEEDS) {
      const { a } = run(players, { playType: PlayType.SINGLES, ...BAL, courtCount: 3, rounds: 5 }, seed);
      expect(a.distinctLineups).toBe(5);
      expect(a.opponentMax).toBe(1);
      expect(a.backToBackOpp).toBe(0);
    }
  });

  it('C2 墨式无积分预览：同样按轮换排布（不再与第 1 轮原样重复）；有积分时仍按积分锁场地（见上方墨式用例）', () => {
    const players = PL([6, 5, 4, 3, 3, 2, 2, 1]);
    for (const seed of SEEDS) {
      const { a } = run(players, { playType: PlayType.DOUBLES, ...MEX, courtCount: 2, rounds: 6 }, seed);
      expect(a.distinctLineups).toBe(6);
      expect(a.sameMatchup).toBe(0);
    }
  });

  it('C3 美式双打：8 人 7 轮搭档零重复（搭遍所有人），16 人 2 场 8 轮搭档零重复、对手 ≤ 2 次', () => {
    for (const seed of SEEDS) {
      const { a } = run(PL(Array(8).fill(3)), { playType: PlayType.DOUBLES, ...AME, courtCount: 2, rounds: 7 }, seed);
      expect(a.partnerRepeats).toBe(0);
      expect(a.opponentMax).toBeLessThanOrEqual(2);
      const big = run(PL([6, 5, 4, 3, 2, 1, 6, 5, 4, 3, 2, 1, 6, 5, 4, 3]), { playType: PlayType.DOUBLES, ...AME, courtCount: 2, rounds: 8 }, seed);
      expect(big.a.partnerRepeats).toBe(0);
      expect(big.a.opponentMax).toBeLessThanOrEqual(2);
    }
  });

  it('C4 体力：10 人 2 场 10 轮连打 ≤ 理论下界 4 + 1、无人连续两轮轮空、轮空次数人人相等', () => {
    const players = PL(Array(10).fill(3));
    for (const seed of SEEDS) {
      const { schedule, a } = run(players, { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 10 }, seed);
      expect(a.maxStreak).toBeLessThanOrEqual(5);
      expect(a.consecByes).toBe(0);
      const byes = byeTally(schedule, players);
      expect(Math.max(...byes) - Math.min(...byes)).toBe(0);
      expect(schedule.metrics.maxConsecutivePlays).toBe(a.maxStreak);
    }
    const six = PL([4, 4, 3, 3, 2, 2]);
    for (const seed of SEEDS) {
      const { a } = run(six, { playType: PlayType.DOUBLES, ...AME, courtCount: 1, rounds: 9 }, seed);
      expect(a.maxStreak).toBeLessThanOrEqual(3); // 下界 ceil(6/2)−1 = 2
      expect(a.consecByes).toBe(0);
    }
  });

  it('C5 混双轮空看性别：5 男 5 女 0 违例；5 男 4 女在「人人轮空一次」约束下违例 = 下界 4', () => {
    for (const seed of SEEDS) {
      const even = run(PL(Array(10).fill(3), [M, M, M, M, M, F, F, F, F, F]), { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 10, mixedDoubles: true }, seed);
      expect(even.schedule.metrics.mixedViolations).toBe(0);
      const odd = run(PL(Array(9).fill(3), [M, M, M, M, M, F, F, F, F]), { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 9, mixedDoubles: true }, seed);
      // 9 人 9 轮每人恰好轮空 1 次：4 轮必须让女生歇，那 4 轮场上 5 男 3 女 → 各 1 队男男
      expect(odd.schedule.metrics.mixedViolations).toBe(4);
    }
  });

  it('C6 墨式按积分锁场地 + 混双：场地 1 是积分最高的 2 男 2 女、每队一男一女（不是积分前四个男生挤一场）', () => {
    // 积分高者恰好权重低，模拟「低级别球友打出高分」
    const players: EnginePlayer[] = [1, 2, 3, 4]
      .map((w, i) => ({ id: i + 1, weight: w, gender: M }))
      .concat([1, 2, 3, 4].map((w, i) => ({ id: i + 5, weight: w, gender: F })));
    const standings: Record<number, number> = { 1: 100, 2: 90, 3: 80, 4: 70, 5: 60, 6: 50, 7: 40, 8: 30 };
    for (const seed of SEEDS) {
      const { schedule } = run(players, { playType: PlayType.DOUBLES, ...MEX, courtCount: 2, rounds: 1, mixedDoubles: true, standings }, seed);
      const court1 = schedule.rounds[0].matches.find((m) => m.courtNo === 1)!;
      expect([...court1.teamA.ids, ...court1.teamB.ids].sort((a, b) => a - b)).toEqual([1, 2, 5, 6]);
      expect(schedule.metrics.mixedViolations).toBe(0);
    }
  });

  it('墨式按积分锁场地 + 有人轮空：每片场地的积分都不低于下一片（轮空交换不能把低分的人换进前面的场地）', () => {
    const players = PL([6, 1, 1, 1, 6, 3, 3, 2, 6]); // id = 1001 + i·3
    const standings: Record<number, number> = {};
    players.forEach((p, i) => (standings[p.id] = 90 - i * 10));
    for (const rounds of [1, 3])
      for (const seed of SEEDS) {
        const { schedule } = run(players, { playType: PlayType.DOUBLES, ...MEX, courtCount: 2, rounds, standings }, seed);
        for (const r of schedule.rounds) {
          const courts = [...r.matches].sort((a, b) => a.courtNo - b.courtNo).map((m) => [...m.teamA.ids, ...m.teamB.ids].map((id) => standings[id]));
          for (let c = 0; c + 1 < courts.length; c++) expect(Math.min(...courts[c])).toBeGreaterThanOrEqual(Math.max(...courts[c + 1]));
        }
      }
  });

  it('墨式积分只覆盖部分人：缺积分的人按已知积分中位数参与排名，不会被水平权重挤到最后一片场地', () => {
    // 8 名老球友积分 25..60（L2），4 名 L6 新来的 Guest 没有积分记录
    const regulars = PL([2, 2, 2, 2, 2, 2, 2, 2]);
    const guests: EnginePlayer[] = [6, 6, 6, 6].map((w, i) => ({ id: 9001 + i, weight: w, gender: U }));
    const players = [...regulars, ...guests];
    const standings: Record<number, number> = {};
    regulars.forEach((p, i) => (standings[p.id] = 25 + i * 5));
    for (const seed of SEEDS) {
      const { schedule } = run(players, { playType: PlayType.DOUBLES, ...MEX, courtCount: 3, rounds: 1, standings }, seed);
      const lastCourt = schedule.rounds[0].matches.find((m) => m.courtNo === 3)!;
      const guestsOnLast = [...lastCourt.teamA.ids, ...lastCourt.teamB.ids].filter((id) => id > 9000).length;
      expect(guestsOnLast).toBeLessThan(4); // 旧口径：积分回退成权重 6，四个 Guest 必然整场挤在 3 号场
    }
  });

  it('C7 混双 UNKNOWN（Guest）当兜底通配而不是先被消耗：可配平时 0 违例（多 seed）', () => {
    for (const seed of SEEDS) {
      const a = run(PL(Array(9).fill(3), [M, M, M, M, F, F, F, F, U]), { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 4, mixedDoubles: true }, seed);
      expect(a.schedule.metrics.mixedViolations).toBe(0);
      const b = run(PL(Array(12).fill(3), [M, M, M, M, M, M, F, F, F, F, U, U]), { playType: PlayType.DOUBLES, ...BAL, courtCount: 3, rounds: 4, mixedDoubles: true }, seed);
      expect(b.schedule.metrics.mixedViolations).toBe(0);
    }
  });

  it('C8 混双平衡做强弱搭配：4 男 4 女同档 [6,5,4,3] 首轮两场实力差都为 0', () => {
    const players = PL([6, 5, 4, 3, 6, 5, 4, 3], [M, M, M, M, F, F, F, F]);
    for (const seed of SEEDS) {
      const { schedule } = run(players, { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 1, mixedDoubles: true }, seed);
      expect(schedule.metrics.avgStrengthGap).toBe(0);
      expect(schedule.metrics.mixedViolations).toBe(0);
    }
  });

  it('C9/C10 混双（美式/平衡）：不出现整场对阵原样重演', () => {
    for (const seed of SEEDS) {
      const ame = run(PL([6, 5, 4, 3, 6, 5, 4, 3], [M, M, M, M, F, F, F, F]), { playType: PlayType.DOUBLES, ...AME, courtCount: 2, rounds: 6, mixedDoubles: true }, seed);
      expect(ame.a.sameMatchup).toBe(0);
      expect(ame.a.distinctLineups).toBe(6);
      const bal = run(PL([6, 5, 4, 3, 2, 1, 6, 5, 4, 3, 2, 1], [M, M, M, M, M, M, F, F, F, F, F, F]), { playType: PlayType.DOUBLES, ...BAL, courtCount: 3, rounds: 8, mixedDoubles: true }, seed);
      expect(bal.a.sameMatchup).toBe(0);
      expect(bal.a.opponentMax).toBeLessThanOrEqual(3); // 旧引擎：同一对对手 8 轮碰 6 轮
    }
  });

  it('C11 美式单打：能排成完整循环赛时 0 重复（6 人 5 轮、8 人 7 轮）', () => {
    for (const seed of SEEDS) {
      expect(run(PL([6, 5, 4, 3, 2, 1]), { playType: PlayType.SINGLES, ...AME, courtCount: 3, rounds: 5 }, seed).a.opponentRepeats).toBe(0);
      expect(run(PL([6, 5, 4, 4, 3, 3, 2, 1]), { playType: PlayType.SINGLES, ...AME, courtCount: 4, rounds: 7 }, seed).a.opponentRepeats).toBe(0);
    }
  });

  it('C12 首轮全员并列时轮空抽签不偏向报名靠前的人（400 个 seed）', () => {
    const players = PL(Array(10).fill(3));
    const tally = new Map(players.map((p) => [p.id, 0]));
    for (let seed = 1; seed <= 400; seed++) {
      const s = generateSchedule(players, { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 1, seed });
      for (const id of s.rounds[0].byes) tally.set(id, tally.get(id)! + 1);
    }
    // 期望各 80 次；二项分布标准差 ≈ 8，放宽到 ±30
    for (const v of tally.values()) {
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(110);
    }
  });

  it('C13 性别失衡时违例 = 下界，且「男男队」在男生之间均摊', () => {
    const players = PL([6, 5, 4, 3, 2, 5, 4, 3], [M, M, M, M, M, F, F, F]);
    for (const seed of SEEDS) {
      const { schedule } = run(players, { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 6, mixedDoubles: true }, seed);
      expect(schedule.metrics.mixedViolations).toBe(6); // 场上恒为 5 男 3 女 → 每轮 1 队男男
      const mm = new Map(players.filter((p) => p.gender === M).map((p) => [p.id, 0]));
      for (const r of schedule.rounds)
        for (const m of r.matches)
          for (const T of [m.teamA.ids, m.teamB.ids]) if (T.every((id) => mm.has(id))) T.forEach((id) => mm.set(id, mm.get(id)! + 1));
      const counts = [...mm.values()];
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2); // 旧引擎：违例全压给最弱的男生
    }
  });

  it('C14 美式跨级混打：拦住一边倒的对局（差 ≥ 8 不出现，差 ≥ 6 每份赛程至多 1 场）', () => {
    const players = PL([6, 6, 5, 5, 2, 2, 1, 1]);
    for (const seed of SEEDS) {
      const { a } = run(players, { playType: PlayType.DOUBLES, ...AME, courtCount: 2, rounds: 6 }, seed);
      expect(a.maxGap).toBeLessThanOrEqual(7);
      expect(a.gaps.filter((g) => g >= 6).length).toBeLessThanOrEqual(1); // 旧引擎：约 20% 的场次差 ≥ 6，最大 10
    }
  });

  it('C15 metrics 与赛程重算一致（含新增的连打/同阵容/最多搭档/最多对手/平均实力差）', () => {
    const players = PL([5, 4, 4, 3, 3, 3, 2, 2, 1, 6, 3], [M, F, M, F, M, F, M, F, M, F, U]);
    for (const seed of SEEDS) {
      const settings: EngineSettings = { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 7, mixedDoubles: true, seed };
      const schedule = generateSchedule(players, settings);
      const a = analyze(schedule, players);
      expect(schedule.metrics.maxConsecutivePlays).toBe(a.maxStreak);
      expect(schedule.metrics.sameMatchupRepeats).toBe(a.sameMatchup);
      expect(schedule.metrics.maxPartnerCount).toBe(a.partnerMax);
      expect(schedule.metrics.maxOpponentCount).toBe(a.opponentMax);
      expect(schedule.metrics.repeatPartnerPairs).toBe(a.partnerRepeats);
      expect(schedule.metrics.repeatOpponentPairs).toBe(a.opponentRepeats);
      expect(schedule.metrics.avgStrengthGap).toBeCloseTo(a.avgGap, 2);
    }
  });

  it('C16 「重新生成」（换 seed）能给出不同赛程', () => {
    const players = PL([6, 5, 4, 3, 3, 2, 2, 1]);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++)
      seen.add(JSON.stringify(generateSchedule(players, { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: 2, rounds: 6, seed }).rounds));
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  it('C17 混双 4 男 4 女 2 场 4 轮：每人 4 次搭档各不相同', () => {
    const players = PL(Array(8).fill(3), [M, M, M, M, F, F, F, F]);
    for (const seed of SEEDS) {
      const { schedule, a } = run(players, { playType: PlayType.DOUBLES, ...BAL, courtCount: 2, rounds: 4, mixedDoubles: true }, seed);
      expect(a.partnerMax).toBe(1);
      expect(schedule.metrics.mixedViolations).toBe(0);
    }
  });

  it('轮次排序：8 人 2 场 8 轮，相邻两轮不重复搭档，相邻轮碰同一对手很少', () => {
    const players = PL(Array(8).fill(3));
    for (const seed of SEEDS) {
      const { a } = run(players, { playType: PlayType.DOUBLES, ...AME, courtCount: 2, rounds: 8 }, seed);
      expect(a.backToBackPartner).toBe(0);
      expect(a.backToBackOpp).toBeLessThanOrEqual(8); // 7 个相邻轮间隔 × 8 对对手 = 56 对里至多 8 对
    }
  });
});

describe('grouping engine — 随机参数矩阵：不变量与公平性', () => {
  const genders = [Gender.MALE, Gender.FEMALE, Gender.UNKNOWN];
  it('单打/双打/混双 × 三种模式 × 4–20 人 × 1–4 场 × 1/3/7 轮：结构合法、出场差 ≤ 1、轮空差 ≤ 1', () => {
    let cases = 0;
    for (const playType of [PlayType.SINGLES, PlayType.DOUBLES])
      for (const mode of ['BALANCED', 'AMERICANO', 'MEXICANO'] as const)
        for (const N of [4, 5, 7, 9, 12, 15, 20])
          for (const courtCount of [1, 2, 4])
            for (const rounds of [1, 3, 7]) {
              const mixed = playType === PlayType.DOUBLES && (N + courtCount + rounds) % 2 === 0;
              const players: EnginePlayer[] = Array.from({ length: N }, (_, i) => ({
                id: 50 + i * 11,
                weight: 1 + ((i * 7 + N) % 6),
                gender: genders[(i * 5 + rounds) % 3],
              }));
              const settings: EngineSettings = {
                playType,
                mode: mode === 'BALANCED' ? GroupMode.BALANCED : GroupMode.ROTATION,
                rotation: mode === 'AMERICANO' ? RotationKind.AMERICANO : mode === 'MEXICANO' ? RotationKind.MEXICANO : undefined,
                courtCount,
                rounds,
                mixedDoubles: mixed,
                seed: N * 31 + rounds,
              };
              const schedule = generateSchedule(players, settings);
              assertValid(schedule, players, settings);
              const apps = appearances(schedule, players);
              expect(Math.max(...apps) - Math.min(...apps)).toBeLessThanOrEqual(1);
              const byes = byeTally(schedule, players);
              expect(Math.max(...byes) - Math.min(...byes)).toBeLessThanOrEqual(1);
              // 逐轮公平：任何一轮打完就散场，大家的轮空次数差都 ≤ 1
              const running = new Map(players.map((pl) => [pl.id, 0]));
              for (const r of schedule.rounds) {
                for (const b of r.byes) running.set(b, running.get(b)! + 1);
                const v = [...running.values()];
                expect(Math.max(...v) - Math.min(...v)).toBeLessThanOrEqual(1);
              }
              expect(schedule.rounds.map((r) => r.index)).toEqual(Array.from({ length: rounds }, (_, i) => i + 1));
              cases++;
            }
    expect(cases).toBe(2 * 3 * 7 * 3 * 3);
  });

  it('有轮空的大局（100 人 20 场 30 轮 / 100 人 2 场 30 轮）也在秒级内完成', () => {
    for (const [N, courts] of [
      [100, 20],
      [100, 2],
    ]) {
      const players: EnginePlayer[] = Array.from({ length: N }, (_, i) => ({ id: i + 1, weight: 1 + (i % 6), gender: i % 3 === 0 ? Gender.FEMALE : Gender.MALE }));
      const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.BALANCED, courtCount: courts, rounds: 30, mixedDoubles: true, seed: 3 };
      const t0 = performance.now();
      const schedule = generateSchedule(players, settings);
      const ms = performance.now() - t0;
      assertValid(schedule, players, settings);
      expect(ms).toBeLessThan(3000); // 本机 150–600ms
    }
  });

  it('接口上限规模（80 人 20 场 30 轮）仍在秒级内完成且结构合法', () => {
    const players: EnginePlayer[] = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, weight: 1 + (i % 6), gender: i % 3 === 0 ? Gender.FEMALE : Gender.MALE }));
    const settings: EngineSettings = { playType: PlayType.DOUBLES, mode: GroupMode.ROTATION, rotation: RotationKind.AMERICANO, courtCount: 20, rounds: 30, mixedDoubles: true, seed: 3 };
    const t0 = performance.now();
    const schedule = generateSchedule(players, settings);
    const ms = performance.now() - t0;
    assertValid(schedule, players, settings);
    expect(ms).toBeLessThan(3000); // 本机约 350ms，CI/低配机器留足余量
  });
});
