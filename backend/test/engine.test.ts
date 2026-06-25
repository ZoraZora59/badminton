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
});
