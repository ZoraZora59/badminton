import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ActivityStatus, GroupMode, MatchStatus, PlayType, SkillLevel, Team } from '@badminton/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

/**
 * 开打后名单可变更（withdraw / rejoin）。
 *
 * 现场真实痛点：确认开打之后阵容就锁死了，可「老李 9 点得走」「隔壁球友临时跑来」
 * 每场都在发生。这组用例锁的是三件事：
 * 1. 提前离场只动**还没打的 PENDING 对局**，已结束对局的 MatchPlayer 和比分一个字不改
 *    （战绩 / 今日榜 / 跨局统计全挂在 FINISHED 的 Match 上，Match 对 Round 又是 Cascade）；
 * 2. 顶替者选择必须**确定性**：整场出场次数最少者优先，并列取 participantId 最小；
 * 3. 没人可顶时**留空位、不撤场**（4 人 1 片场的小局轮空名单恒为空）——撤场是条死路：
 *    本轮没有对局 → 换人入口不出现，重新分组又被「记过分不许重排」挡回 409，人回来也开不了场。
 *    只有一队被摘成 0 人才真的撤场；
 * 4. 中途归队**优先补空位**，本轮没空位才进轮空名单，再由局长用已有的 swapPlayers 换上场。
 *
 * 造数策略：活动 / 参赛者走接口（和真实链路一致），但 grouping/confirm 直接回传
 * **手工编排的 schedule** 而不是 preview 的产物——顶替规则要断言到「选中的是谁」，
 * 必须精确控制每一轮谁在场上、谁轮空、谁出场了几次，引擎的随机排布做不到。
 * 断言一律回读数据库真实状态（round.byeJson / matchPlayer 行 / 比分），不只看状态码。
 */

let app: FastifyInstance;
const RUN = Date.now();
const createdUserIds: number[] = [];
const createdAccountOpenids: string[] = [];
const createdActivityIds: number[] = [];

interface Resp {
  status: number;
  body: { code: number; message: string; data: any };
}
async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Resp> {
  const res = await app.inject({
    method,
    url,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    payload: opts.body as object | undefined,
  });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

async function login(openid: string): Promise<{ token: string; userId: number }> {
  const r = await api('POST', '/api/auth/login', { body: { mockOpenid: openid } });
  expect(r.body.code).toBe(0);
  createdUserIds.push(r.body.data.user.id);
  createdAccountOpenids.push(openid);
  return { token: r.body.data.token, userId: r.body.data.user.id };
}

/** 建局（双打 1 片场），返回 activityId */
async function createActivity(token: string, title: string): Promise<number> {
  const created = await api('POST', '/api/activities', {
    token,
    body: {
      title,
      startAt: new Date('2026-08-08T19:00:00+08:00').toISOString(),
      venue: '测试馆',
      courtCount: 1,
      capacity: 8,
      playType: PlayType.DOUBLES,
      defaultMode: GroupMode.BALANCED,
    },
  });
  expect(created.body.code).toBe(0);
  const id: number = created.body.data.id;
  createdActivityIds.push(id);
  return id;
}

/** 批量加临时球友，返回 participantId 数组（创建顺序 = id 升序，顶替规则要靠它验「并列取最小 id」） */
async function addGuests(token: string, activityId: number, count: number, prefix: string): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    const r = await api('POST', `/api/activities/${activityId}/participants`, {
      token,
      body: { guestName: `${prefix}${i}`, level: SkillLevel.L2 },
    });
    expect(r.body.code).toBe(0);
    ids.push(r.body.data.id);
  }
  // 自增主键：后建的 id 一定更大，后面「并列取最小 id」的断言依赖这个前提
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  return ids;
}

interface DraftRound {
  index: number;
  bye: number[];
  matches: Array<{ courtNo: number; a: number[]; b: number[] }>;
}

/** 手工编排 schedule（confirm 的入参形状，见 grouping/routes 的 ConfirmBody） */
function draftSchedule(rounds: DraftRound[]) {
  return {
    settings: {
      playType: PlayType.DOUBLES,
      mode: GroupMode.BALANCED,
      courtCount: 1,
      rounds: rounds.length,
    },
    rounds: rounds.map((r) => ({
      index: r.index,
      byeParticipantIds: r.bye,
      matches: r.matches.map((m) => ({
        courtNo: m.courtNo,
        teamA: { participants: m.a.map((id) => ({ id })) },
        teamB: { participants: m.b.map((id) => ({ id })) },
      })),
    })),
    metrics: {},
  };
}

/** 确认开打 → 活动 ONGOING */
async function confirm(token: string, activityId: number, rounds: DraftRound[]) {
  const r = await api('POST', `/api/activities/${activityId}/grouping/confirm`, {
    token,
    body: { schedule: draftSchedule(rounds) },
  });
  expect(r.body.code).toBe(0);
  expect(r.body.data.status).toBe(ActivityStatus.ONGOING);
  return r.body.data;
}

/** 回读数据库：轮次 + 对局 + 上场名单，按 index / courtNo 升序 */
async function dbRounds(activityId: number) {
  return app.prisma.round.findMany({
    where: { activityId },
    include: { matches: { include: { players: true }, orderBy: { courtNo: 'asc' } } },
    orderBy: { index: 'asc' },
  });
}

const byeIds = (round: { byeJson: unknown }): number[] =>
  Array.isArray(round.byeJson) ? ([...round.byeJson] as number[]) : [];
const playerIds = (match: { players: Array<{ participantId: number }> }): number[] =>
  match.players.map((p) => p.participantId).sort((a, b) => a - b);
/** 某一队的上场名单（升序）——「留空位」要断言到具体哪一队少了人，不能只看总人数 */
const teamIds = (match: { players: Array<{ participantId: number; team: string }> }, team: Team): number[] =>
  match.players.filter((p) => p.team === team).map((p) => p.participantId).sort((a, b) => a - b);

beforeAll(async () => {
  app = await buildApp(loadConfig('local'));
  await app.ready();
});

afterAll(async () => {
  // 只删自己建的：活动级联删 participant/round/match/matchPlayer/signup
  if (createdActivityIds.length) {
    await app.prisma.activity.deleteMany({ where: { id: { in: createdActivityIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.activity.deleteMany({ where: { hostId: { in: createdUserIds } } });
    await app.prisma.participant.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.signup.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.prisma.wechatAccount.deleteMany({ where: { openid: { in: createdAccountOpenids } } });
  }
  await app.close();
});

describe('RS1 提前离场：后续轮次自动顶替，已结束对局一个字不动', () => {
  it('轮空者按「出场最少 → id 最小」顶上，历史比分与 MatchPlayer 原样保留', async () => {
    const host = await login(`rs${RUN}_h1`);
    const aid = await createActivity(host.token, '老李九点得走');
    const [g1, g2, g3, g4, g5, g6] = await addGuests(host.token, aid, 6, '离场球友');

    // 场地真实编号（局长填的「5 号场 / 6 号场」）：直接落库，验 getBoard 的透传
    await app.prisma.activity.update({ where: { id: aid }, data: { courtLabels: '5,6' } });

    // 编排三轮，让「出场次数」刻意不均：
    //   g1=3 场  g2=2 场  g3=3 场  g4=3 场  g5=1 场  g6=0 场
    await confirm(host.token, aid, [
      { index: 1, bye: [g5, g6], matches: [{ courtNo: 1, a: [g1, g2], b: [g3, g4] }] },
      { index: 2, bye: [g2, g6], matches: [{ courtNo: 1, a: [g1, g5], b: [g3, g4] }] },
      { index: 3, bye: [g5, g6], matches: [{ courtNo: 1, a: [g1, g2], b: [g3, g4] }] },
    ]);

    // 第 1 轮打完记分 → 变成历史
    const before = await dbRounds(aid);
    const r1MatchId = before[0].matches[0].id;
    const scored = await api('POST', `/api/matches/${r1MatchId}/score`, {
      token: host.token,
      body: { scoreA: 21, scoreB: 15 },
    });
    expect(scored.body.data.status).toBe(MatchStatus.FINISHED);

    // ——— g1 提前离场 ———
    const res = await api('POST', `/api/activities/${aid}/participants/${g1}/withdraw`, { token: host.token });
    expect(res.body.code).toBe(0);
    // 看板透传球馆真实场地号（BoardVM.courtLabels）
    expect(res.body.data.courtLabels).toBe('5,6');

    const after = await dbRounds(aid);
    expect(after.length).toBe(3);
    const [ra1, ra2, ra3] = after;

    // ① 已结束的第 1 轮：对局还在、比分没变、g1 的 MatchPlayer 原样保留
    expect(ra1.matches.length).toBe(1);
    expect(ra1.matches[0].id).toBe(r1MatchId);
    expect(ra1.matches[0].status).toBe(MatchStatus.FINISHED);
    expect(ra1.matches[0].scoreA).toBe(21);
    expect(ra1.matches[0].scoreB).toBe(15);
    expect(ra1.matches[0].winner).toBe(Team.A);
    expect(playerIds(ra1.matches[0])).toEqual([g1, g2, g3, g4].sort((a, b) => a - b));
    const g1Historic = ra1.matches[0].players.find((p) => p.participantId === g1);
    expect(g1Historic?.team).toBe(Team.A);
    expect(byeIds(ra1)).toEqual([g5, g6]); // 历史轮的轮空名单也不动

    // ② 第 2 轮：轮空池 [g2(2 场), g6(0 场)] → 出场最少的 g6 顶上（哪怕 id 更大）
    expect(playerIds(ra2.matches[0])).toEqual([g3, g4, g5, g6].sort((a, b) => a - b));
    expect(ra2.matches[0].players.find((p) => p.participantId === g6)?.team).toBe(Team.A); // 接的是 g1 的位置
    expect(byeIds(ra2)).toEqual([g2]); // 顶替者已从轮空移除

    // ③ 第 3 轮：轮空池 [g5, g6] 此时各 1 场 → 并列取 id 最小的 g5
    expect(playerIds(ra3.matches[0])).toEqual([g2, g3, g4, g5].sort((a, b) => a - b));
    expect(ra3.matches[0].players.find((p) => p.participantId === g5)?.team).toBe(Team.A);
    expect(byeIds(ra3)).toEqual([g6]);

    // ④ g1 不在任何 PENDING 对局里，也不在任何未打完轮次的轮空名单里
    const stillPending = await app.prisma.matchPlayer.count({
      where: { participantId: g1, match: { status: MatchStatus.PENDING, round: { activityId: aid } } },
    });
    expect(stillPending).toBe(0);
    expect(byeIds(ra2)).not.toContain(g1);
    expect(byeIds(ra3)).not.toContain(g1);

    // ⑤ 他打过的那场仍然计入今日榜（历史没被抹掉）
    const summary = (await api('GET', `/api/activities/${aid}/summary`, { token: host.token })).body.data;
    expect(summary.rank.map((r: any) => r.participantId)).toContain(g1);
  });

  it('本来就轮空的人离场：直接从轮空名单摘掉，场上一个人不动', async () => {
    const host = await login(`rs${RUN}_h2`);
    const aid = await createActivity(host.token, '轮空的人先撤');
    const [g1, g2, g3, g4, g5] = await addGuests(host.token, aid, 5, '轮空球友');

    await confirm(host.token, aid, [
      { index: 1, bye: [g5], matches: [{ courtNo: 1, a: [g1, g2], b: [g3, g4] }] },
    ]);

    const res = await api('POST', `/api/activities/${aid}/participants/${g5}/withdraw`, { token: host.token });
    expect(res.body.code).toBe(0);

    const [r1] = await dbRounds(aid);
    expect(byeIds(r1)).toEqual([]);
    expect(playerIds(r1.matches[0])).toEqual([g1, g2, g3, g4].sort((a, b) => a - b)); // 场上原封不动
  });
});

describe('RS2 没人可顶：先留空位，整队被摘空才撤场', () => {
  it('轮空名单为空时撤一人留空位；那队被摘空才整场撤掉，其余人回轮空；已结束轮次不受影响', async () => {
    const host = await login(`rs${RUN}_h3`);
    const aid = await createActivity(host.token, '四个人打完就散');
    const [k1, k2, k3, k4] = await addGuests(host.token, aid, 4, '撤场球友');

    // 4 个人、每轮 1 片场 → 轮空名单恒为空，撤了人就没人可顶
    await confirm(host.token, aid, [
      { index: 1, bye: [], matches: [{ courtNo: 1, a: [k1, k2], b: [k3, k4] }] },
      { index: 2, bye: [], matches: [{ courtNo: 1, a: [k1, k3], b: [k2, k4] }] },
    ]);

    const before = await dbRounds(aid);
    const r1MatchId = before[0].matches[0].id;
    const r2MatchId = before[1].matches[0].id;
    await api('POST', `/api/matches/${r1MatchId}/score`, { token: host.token, body: { scoreA: 21, scoreB: 18 } });

    const res = await api('POST', `/api/activities/${aid}/participants/${k1}/withdraw`, { token: host.token });
    expect(res.body.code).toBe(0);

    const [ra1, ra2] = await dbRounds(aid);

    // 已结束的第 1 轮：对局、比分、四个人的 MatchPlayer 全都在
    expect(ra1.matches.length).toBe(1);
    expect(ra1.matches[0].status).toBe(MatchStatus.FINISHED);
    expect(ra1.matches[0].scoreA).toBe(21);
    expect(ra1.matches[0].scoreB).toBe(18);
    expect(playerIds(ra1.matches[0])).toEqual([k1, k2, k3, k4].sort((a, b) => a - b));

    // 第 2 轮：**不撤场**，只在 A 队留一个空位（k1 走了，k3 还在），B 队原封不动
    expect(ra2.matches.length).toBe(1);
    expect(ra2.matches[0].id).toBe(r2MatchId);
    expect(teamIds(ra2.matches[0], Team.A)).toEqual([k3]);
    expect(teamIds(ra2.matches[0], Team.B)).toEqual([k2, k4].sort((a, b) => a - b));
    expect(await app.prisma.matchPlayer.count({ where: { matchId: r2MatchId } })).toBe(3); // 只少了 k1 那一行
    expect(byeIds(ra2)).toEqual([]); // 走掉的人不进轮空

    // 看板同步：第 2 轮那场还在、A 队只有 1 个人（前端据 playType 算出还缺 1 个）
    const board = res.body.data;
    expect(board.hostId).toBe(host.userId); // 看板自带局长身份
    expect(board.rounds[1].playType).toBe(PlayType.DOUBLES);
    expect(board.rounds[1].matches.length).toBe(1);
    expect(board.rounds[1].matches[0].teamA.participants.length).toBe(1);
    expect(board.rounds[1].matches[0].teamB.participants.length).toBe(2);

    // ——— A 队仅剩的 k3 也走了 → 这队 0 人，真打不了 → 整场撤掉 ———
    const second = await api('POST', `/api/activities/${aid}/participants/${k3}/withdraw`, { token: host.token });
    expect(second.body.code).toBe(0);
    const [rb1, rb2] = await dbRounds(aid);
    expect(rb2.matches.length).toBe(0);
    expect(byeIds(rb2).sort((a, b) => a - b)).toEqual([k2, k4].sort((a, b) => a - b));
    expect(byeIds(rb2)).not.toContain(k1);
    expect(byeIds(rb2)).not.toContain(k3);
    // 撤掉的 Match 连带 MatchPlayer 一起没了（Cascade），没留孤儿行
    expect(await app.prisma.match.count({ where: { id: r2MatchId } })).toBe(0);
    expect(await app.prisma.matchPlayer.count({ where: { matchId: r2MatchId } })).toBe(0);
    // 已结束的第 1 轮仍旧一个字没动
    expect(rb1.matches[0].scoreA).toBe(21);
    expect(playerIds(rb1.matches[0])).toEqual([k1, k2, k3, k4].sort((a, b) => a - b));

    const secondBoard = second.body.data;
    expect(secondBoard.rounds[1].matches.length).toBe(0);
    expect(secondBoard.rounds[1].byeParticipantIds.length).toBe(2);

    // ——— 被撤空的轮次仍然是「将来」，还得能继续改 ———
    // 如果把「没有 PENDING 对局」当成历史跳过，第 2 轮就再也动不了：
    // 走掉的 k2 会永远挂在它的轮空名单里，看板一直显示他「在场上」，
    // 局长再点一次「TA 要走了」毫无反应；回来的 k1 也进不去。这两条都得钉死。
    const third = await api('POST', `/api/activities/${aid}/participants/${k2}/withdraw`, { token: host.token });
    expect(third.body.code).toBe(0);
    const [, rc2] = await dbRounds(aid);
    expect(byeIds(rc2)).toEqual([k4]);
    expect(byeIds(rc2)).not.toContain(k2);

    const back = await api('POST', `/api/activities/${aid}/participants/${k1}/rejoin`, { token: host.token });
    expect(back.body.code).toBe(0);
    const [rd1, rd2] = await dbRounds(aid);
    expect(rd2.matches.length).toBe(0); // 空轮次没有对局可补
    expect(byeIds(rd2)).toContain(k1); // → 仍然只能先进轮空
    // 已结束的第 1 轮依旧一个字没动
    expect(rd1.matches[0].scoreA).toBe(21);
    expect(byeIds(rd1)).toEqual([]);
  });
});

describe('RS3 中途归队：进后续各轮轮空，幂等，再由局长换上场', () => {
  it('rejoin 进后续每一轮的轮空名单且不重复；rejoin → swap 链路可用', async () => {
    const host = await login(`rs${RUN}_h4`);
    const aid = await createActivity(host.token, '隔壁球友跑来了');
    const [h1, h2, h3, h4, h5] = await addGuests(host.token, aid, 5, '归队球友');

    await confirm(host.token, aid, [
      { index: 1, bye: [h5], matches: [{ courtNo: 1, a: [h1, h2], b: [h3, h4] }] },
      { index: 2, bye: [h5], matches: [{ courtNo: 1, a: [h1, h2], b: [h3, h4] }] },
      { index: 3, bye: [h2], matches: [{ courtNo: 1, a: [h1, h5], b: [h3, h4] }] },
    ]);

    const before = await dbRounds(aid);
    await api('POST', `/api/matches/${before[0].matches[0].id}/score`, {
      token: host.token,
      body: { scoreA: 21, scoreB: 19 },
    });

    // 开打后才到场的临时球友
    const late = (
      await api('POST', `/api/activities/${aid}/participants`, {
        token: host.token,
        body: { guestName: '临时赶到的老王', level: SkillLevel.L2 },
      })
    ).body.data.id as number;

    const rejoin = await api('POST', `/api/activities/${aid}/participants/${late}/rejoin`, { token: host.token });
    expect(rejoin.body.code).toBe(0);

    const afterRejoin = await dbRounds(aid);
    expect(byeIds(afterRejoin[0])).toEqual([h5]); // 已结束的第 1 轮不动
    expect(byeIds(afterRejoin[0])).not.toContain(late);
    expect(byeIds(afterRejoin[1])).toEqual([h5, late]); // 后续每一轮都进轮空
    expect(byeIds(afterRejoin[2])).toEqual([h2, late]);

    // 幂等：再来一次不会出现两次
    const again = await api('POST', `/api/activities/${aid}/participants/${late}/rejoin`, { token: host.token });
    expect(again.body.code).toBe(0);
    const afterTwice = await dbRounds(aid);
    expect(afterTwice[1].byeJson).toEqual([h5, late]);
    expect(byeIds(afterTwice[1]).filter((id) => id === late).length).toBe(1);
    expect(byeIds(afterTwice[2]).filter((id) => id === late).length).toBe(1);

    // 归队后局长用已有的换人把他换上场：h3 下、late 上
    const swap = await api('POST', `/api/matches/${afterTwice[1].matches[0].id}/swap`, {
      token: host.token,
      body: { participantA: h3, participantB: late },
    });
    expect(swap.body.code).toBe(0);

    const [, rb2] = await dbRounds(aid);
    expect(playerIds(rb2.matches[0])).toContain(late);
    expect(playerIds(rb2.matches[0])).not.toContain(h3);
    expect(byeIds(rb2)).toContain(h3);
    expect(byeIds(rb2)).not.toContain(late);

    // 已在场上的人再 rejoin 也是 no-op（不会被塞进轮空造成又在场上又轮空）
    const noop = await api('POST', `/api/activities/${aid}/participants/${late}/rejoin`, { token: host.token });
    expect(noop.body.code).toBe(0);
    const [, rc2] = await dbRounds(aid);
    expect(byeIds(rc2)).not.toContain(late);
  });
});

describe('RS4 名单变更的守卫：非局长 403 / 未开打 409 / 不属于本活动 404', () => {
  it('三种越权与非法入参都被挡住，且不留副作用', async () => {
    const host = await login(`rs${RUN}_h5`);
    const outsider = await login(`rs${RUN}_out`);

    // A 局：停在报名中（未开打）
    const signupAid = await createActivity(host.token, '还没开打的局');
    const [otherGuest] = await addGuests(host.token, signupAid, 1, '别人局的球友');

    // B 局：已开打
    const aid = await createActivity(host.token, '守卫局');
    const [n1, n2, n3, n4, n5] = await addGuests(host.token, aid, 5, '守卫球友');
    await confirm(host.token, aid, [
      { index: 1, bye: [n5], matches: [{ courtNo: 1, a: [n1, n2], b: [n3, n4] }] },
    ]);
    const snapshot = await dbRounds(aid);

    // 非局长 → 403
    const forbidden = await api('POST', `/api/activities/${aid}/participants/${n1}/withdraw`, {
      token: outsider.token,
    });
    expect(forbidden.status).toBe(403);
    const forbiddenRejoin = await api('POST', `/api/activities/${aid}/participants/${n5}/rejoin`, {
      token: outsider.token,
    });
    expect(forbiddenRejoin.status).toBe(403);

    // 活动不是 ONGOING → 409
    const notOngoing = await api('POST', `/api/activities/${signupAid}/participants/${otherGuest}/withdraw`, {
      token: host.token,
    });
    expect(notOngoing.status).toBe(409);
    const notOngoingRejoin = await api('POST', `/api/activities/${signupAid}/participants/${otherGuest}/rejoin`, {
      token: host.token,
    });
    expect(notOngoingRejoin.status).toBe(409);

    // participant 不属于该活动 → 404
    const wrongActivity = await api('POST', `/api/activities/${aid}/participants/${otherGuest}/withdraw`, {
      token: host.token,
    });
    expect(wrongActivity.status).toBe(404);
    const wrongActivityRejoin = await api('POST', `/api/activities/${aid}/participants/${otherGuest}/rejoin`, {
      token: host.token,
    });
    expect(wrongActivityRejoin.status).toBe(404);

    // 越权/非法调用没有落库副作用：对阵与轮空和调用前完全一致
    const after = await dbRounds(aid);
    expect(after.length).toBe(snapshot.length);
    expect(byeIds(after[0])).toEqual(byeIds(snapshot[0]));
    expect(after[0].matches.length).toBe(1);
    expect(playerIds(after[0].matches[0])).toEqual(playerIds(snapshot[0].matches[0]));
    // A 局也没被动过
    expect(await app.prisma.round.count({ where: { activityId: signupAid } })).toBe(0);
  });
});

describe('RS5 留空位 → 归队补空位 → 摘空才撤场（老李九点走、十点又回来）', () => {
  it('撤人只摘一行留空位；归队直接补进那个缺人的队；该队被摘空才整场撤掉', async () => {
    const host = await login(`rs${RUN}_h6`);
    const aid = await createActivity(host.token, '三缺一也得开场');
    const [e1, e2, e3, e4] = await addGuests(host.token, aid, 4, '空位球友');

    // 4 人 1 片场：轮空名单恒为空，撤谁都没人可顶
    await confirm(host.token, aid, [
      { index: 1, bye: [], matches: [{ courtNo: 1, a: [e1, e2], b: [e3, e4] }] },
      { index: 2, bye: [], matches: [{ courtNo: 1, a: [e1, e2], b: [e3, e4] }] },
    ]);

    const before = await dbRounds(aid);
    const r1MatchId = before[0].matches[0].id;
    const r2MatchId = before[1].matches[0].id;
    await api('POST', `/api/matches/${r1MatchId}/score`, { token: host.token, body: { scoreA: 21, scoreB: 15 } });

    /** 已结束的第 1 轮全量复核：比分、胜方、四条 MatchPlayer 及各自队伍，一个字都不许动 */
    const expectHistoryIntact = async () => {
      const [r1] = await dbRounds(aid);
      expect(r1.matches.length).toBe(1);
      expect(r1.matches[0].id).toBe(r1MatchId);
      expect(r1.matches[0].status).toBe(MatchStatus.FINISHED);
      expect(r1.matches[0].scoreA).toBe(21);
      expect(r1.matches[0].scoreB).toBe(15);
      expect(r1.matches[0].winner).toBe(Team.A);
      expect(teamIds(r1.matches[0], Team.A)).toEqual([e1, e2].sort((a, b) => a - b));
      expect(teamIds(r1.matches[0], Team.B)).toEqual([e3, e4].sort((a, b) => a - b));
      expect(await app.prisma.matchPlayer.count({ where: { matchId: r1MatchId } })).toBe(4);
      expect(byeIds(r1)).toEqual([]);
    };

    // ① 留空位：e1 走，没人可顶 → 对局还在，A 队只剩 e2，B 队原封不动
    const out = await api('POST', `/api/activities/${aid}/participants/${e1}/withdraw`, { token: host.token });
    expect(out.body.code).toBe(0);
    const [, ra2] = await dbRounds(aid);
    expect(ra2.matches.length).toBe(1);
    expect(ra2.matches[0].id).toBe(r2MatchId);
    expect(teamIds(ra2.matches[0], Team.A)).toEqual([e2]);
    expect(teamIds(ra2.matches[0], Team.B)).toEqual([e3, e4].sort((a, b) => a - b));
    expect(await app.prisma.matchPlayer.count({ where: { matchId: r2MatchId } })).toBe(3); // 只少一行
    expect(byeIds(ra2)).not.toContain(e1);
    expect(byeIds(ra2)).toEqual([]);
    await expectHistoryIntact();

    // ② 补空位：e1 回来 → 直接进那个缺人的 A 队，不再走轮空
    const back = await api('POST', `/api/activities/${aid}/participants/${e1}/rejoin`, { token: host.token });
    expect(back.body.code).toBe(0);
    const filled = await app.prisma.matchPlayer.findFirst({
      where: { participantId: e1, match: { roundId: (await dbRounds(aid))[1].id } },
    });
    expect(filled?.matchId).toBe(r2MatchId);
    expect(filled?.team).toBe(Team.A);
    const [, rb2] = await dbRounds(aid);
    expect(teamIds(rb2.matches[0], Team.A)).toEqual([e1, e2].sort((a, b) => a - b));
    expect(byeIds(rb2)).not.toContain(e1); // 补进对局的人不该同时挂在轮空名单
    expect(byeIds(rb2)).toEqual([]);
    expect(await app.prisma.matchPlayer.count({ where: { matchId: r2MatchId } })).toBe(4);
    await expectHistoryIntact();

    // ③ 再撤 e2 → A 队又剩 e1 一个（1v2，仍然留空位）
    const out2 = await api('POST', `/api/activities/${aid}/participants/${e2}/withdraw`, { token: host.token });
    expect(out2.body.code).toBe(0);
    const [, rc2] = await dbRounds(aid);
    expect(rc2.matches.length).toBe(1);
    expect(teamIds(rc2.matches[0], Team.A)).toEqual([e1]);

    // ④ 1v2 里那个 1 也走 → A 队 0 人，真打不了 → 整场撤掉，剩下两人回轮空
    const out3 = await api('POST', `/api/activities/${aid}/participants/${e1}/withdraw`, { token: host.token });
    expect(out3.body.code).toBe(0);
    const [, rd2] = await dbRounds(aid);
    expect(rd2.matches.length).toBe(0);
    expect(byeIds(rd2).sort((a, b) => a - b)).toEqual([e3, e4].sort((a, b) => a - b));
    expect(byeIds(rd2)).not.toContain(e1);
    expect(byeIds(rd2)).not.toContain(e2);
    expect(await app.prisma.match.count({ where: { id: r2MatchId } })).toBe(0);
    expect(await app.prisma.matchPlayer.count({ where: { matchId: r2MatchId } })).toBe(0);
    await expectHistoryIntact();

    // ⑤ 已结束那场仍然计入今日榜（历史没被这一串增删牵连）
    const summary = (await api('GET', `/api/activities/${aid}/summary`, { token: host.token })).body.data;
    expect(summary.rank.map((r: any) => r.participantId).sort((a: number, b: number) => a - b)).toEqual(
      [e1, e2, e3, e4].sort((a, b) => a - b),
    );
  });
});

describe('RS6 补空位的挑选规则：人少的队先补、并列取 A 队、满员才进轮空', () => {
  it('一次 rejoin 同时覆盖三种情形，且不动已满员对局的任何一行', async () => {
    const host = await login(`rs${RUN}_h7`);
    const aid = await createActivity(host.token, '空位怎么挑得说得清');
    const [m1, m2, m3, m4, m5] = await addGuests(host.token, aid, 5, '挑位球友');

    // 手工编排三种局面（confirm 不校验每队人数，正好用来造「有人中途走了」的现场）：
    //   第 1 轮 2v1 且 m5 正挂在轮空里 → 补 B 队（不能一律往 A 塞），补上后要从 byeJson 摘掉，
    //                                   否则看板会同时把他画在场上和轮空区
    //   第 2 轮 1v1 → 两队一样少，并列取 A 队
    //   第 3 轮 2v2 → 满员，没空位，只能进轮空（原行为不回归）
    await confirm(host.token, aid, [
      { index: 1, bye: [m5], matches: [{ courtNo: 1, a: [m1, m2], b: [m3] }] },
      { index: 2, bye: [], matches: [{ courtNo: 1, a: [m1], b: [m2] }] },
      { index: 3, bye: [], matches: [{ courtNo: 1, a: [m1, m2], b: [m3, m4] }] },
    ]);

    const before = await dbRounds(aid);
    const [b1, b2, b3] = before.map((r) => r.matches[0].id);

    const res = await api('POST', `/api/activities/${aid}/participants/${m5}/rejoin`, { token: host.token });
    expect(res.body.code).toBe(0);

    const after = await dbRounds(aid);
    const [ra1, ra2, ra3] = after;

    // ① 只有 B 队缺人 → 补进 B 队，并从轮空名单里摘掉（不能又在场上又轮空）
    expect(teamIds(ra1.matches[0], Team.B)).toEqual([m3, m5].sort((a, b) => a - b));
    expect(teamIds(ra1.matches[0], Team.A)).toEqual([m1, m2].sort((a, b) => a - b));
    expect(byeIds(ra1)).toEqual([]);

    // ② 两队一样少 → 并列取 A 队
    expect(teamIds(ra2.matches[0], Team.A)).toEqual([m1, m5].sort((a, b) => a - b));
    expect(teamIds(ra2.matches[0], Team.B)).toEqual([m2]);
    expect(byeIds(ra2)).toEqual([]);

    // ③ 满员 → 一行不动，只进轮空名单（原行为）
    expect(playerIds(ra3.matches[0])).toEqual([m1, m2, m3, m4].sort((a, b) => a - b));
    expect(await app.prisma.matchPlayer.count({ where: { matchId: b3 } })).toBe(4);
    expect(byeIds(ra3)).toEqual([m5]);

    // 三场的 Match 行本身都还在（补空位只增 MatchPlayer，不重建对局）
    expect(await app.prisma.match.count({ where: { id: { in: [b1, b2, b3] } } })).toBe(3);

    // 幂等：再来一次，既不会补出第二行，也不会在轮空里出现两次
    const again = await api('POST', `/api/activities/${aid}/participants/${m5}/rejoin`, { token: host.token });
    expect(again.body.code).toBe(0);
    const twice = await dbRounds(aid);
    expect(await app.prisma.matchPlayer.count({ where: { participantId: m5, matchId: b1 } })).toBe(1);
    expect(await app.prisma.matchPlayer.count({ where: { participantId: m5, matchId: b2 } })).toBe(1);
    expect(byeIds(twice[2]).filter((id) => id === m5).length).toBe(1);
  });
});

describe('RS7 同队走掉两个人：整场撤空之后，人回来还能就地重开一场', () => {
  it('两人成对离场 → 那队被摘空整场撤掉 → 两人归队后轮空席够 4 人，自动重开对局', async () => {
    const host = await login(`rs${RUN}_h7`);
    const aid = await createActivity(host.token, '两口子一起走');
    const [f1, f2, f3, f4] = await addGuests(host.token, aid, 4, '成对球友');

    // 4 人 1 片场：轮空席恒为空。f1/f2 同在 A 队 —— 拼车、两口子成对离场是球场上最常见的走人方式
    await confirm(host.token, aid, [
      { index: 1, bye: [], matches: [{ courtNo: 1, a: [f1, f2], b: [f3, f4] }] },
      { index: 2, bye: [], matches: [{ courtNo: 1, a: [f1, f2], b: [f3, f4] }] },
    ]);
    const before = await dbRounds(aid);
    const r1MatchId = before[0].matches[0].id;
    await api('POST', `/api/matches/${r1MatchId}/score`, { token: host.token, body: { scoreA: 21, scoreB: 17 } });

    /** 已结束的第 1 轮：重开对局绝不能碰到它 */
    const expectHistoryIntact = async () => {
      const [r1] = await dbRounds(aid);
      expect(r1.matches.length).toBe(1);
      expect(r1.matches[0].id).toBe(r1MatchId);
      expect(r1.matches[0].status).toBe(MatchStatus.FINISHED);
      expect(r1.matches[0].scoreA).toBe(21);
      expect(r1.matches[0].scoreB).toBe(17);
      expect(r1.matches[0].winner).toBe(Team.A);
      expect(await app.prisma.matchPlayer.count({ where: { matchId: r1MatchId } })).toBe(4);
    };

    // ① f1 走：A 队还剩 f2，留空位
    await api('POST', `/api/activities/${aid}/participants/${f1}/withdraw`, { token: host.token });
    // ② f2 也走：A 队被摘成 0 人 → 这场真的打不了，整场撤掉，f3/f4 回轮空
    await api('POST', `/api/activities/${aid}/participants/${f2}/withdraw`, { token: host.token });
    const [, emptied] = await dbRounds(aid);
    expect(emptied.matches.length).toBe(0);
    expect(byeIds(emptied).sort((a, b) => a - b)).toEqual([f3, f4].sort((a, b) => a - b));
    await expectHistoryIntact();

    // ③ f1 先回来：轮空席只有 3 人，还凑不齐一场，先在轮空席等着
    const back1 = await api('POST', `/api/activities/${aid}/participants/${f1}/rejoin`, { token: host.token });
    expect(back1.body.code).toBe(0);
    const [, waiting] = await dbRounds(aid);
    expect(waiting.matches.length).toBe(0);
    expect(byeIds(waiting).sort((a, b) => a - b)).toEqual([f1, f3, f4].sort((a, b) => a - b));

    // ④ f2 也回来：轮空席凑够 4 人 → 就地重开一场（这一步没有，这一轮就永久报废了）
    const back2 = await api('POST', `/api/activities/${aid}/participants/${f2}/rejoin`, { token: host.token });
    expect(back2.body.code).toBe(0);
    const [, reopened] = await dbRounds(aid);
    expect(reopened.matches.length).toBe(1);
    expect(reopened.matches[0].status).toBe(MatchStatus.PENDING);
    expect(reopened.matches[0].courtNo).toBe(1);
    expect(playerIds(reopened.matches[0])).toEqual([f1, f2, f3, f4].sort((a, b) => a - b));
    // 四人出场次数都是 1（都只打过第 1 轮），并列按 id 升序 → 前两个进 A、后两个进 B
    expect(teamIds(reopened.matches[0], Team.A)).toEqual([f1, f2].sort((a, b) => a - b));
    expect(teamIds(reopened.matches[0], Team.B)).toEqual([f3, f4].sort((a, b) => a - b));
    expect(byeIds(reopened)).toEqual([]); // 上场了就不该还挂在轮空席
    await expectHistoryIntact();

    // ⑤ 重开之后一切照常：这一场能正常记分，说明这一轮真的救回来了、不是个空壳
    const scored = await api('POST', `/api/matches/${reopened.matches[0].id}/score`, {
      token: host.token,
      body: { scoreA: 21, scoreB: 19 },
    });
    expect(scored.body.code).toBe(0);
    const [, done] = await dbRounds(aid);
    expect(done.matches[0].status).toBe(MatchStatus.FINISHED);
    expect(done.matches[0].winner).toBe(Team.A);
  });
});
