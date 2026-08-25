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
 * 3. 中途归队只进轮空名单、幂等，再由局长用已有的 swapPlayers 换上场。
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

describe('RS2 没人可顶：整场 PENDING 对局撤掉，其余队员回到轮空', () => {
  it('轮空名单为空时撤场，其余三人回轮空；已结束轮次不受影响', async () => {
    const host = await login(`rs${RUN}_h3`);
    const aid = await createActivity(host.token, '四个人打完就散');
    const [k1, k2, k3, k4] = await addGuests(host.token, aid, 4, '撤场球友');

    // 4 个人、每轮 1 片场 → 轮空名单恒为空，撤了人就凑不齐一场
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

    // 第 2 轮：整场撤掉，其余三人回轮空，k1 不在里面
    expect(ra2.matches.length).toBe(0);
    expect(byeIds(ra2).sort((a, b) => a - b)).toEqual([k2, k3, k4].sort((a, b) => a - b));
    expect(byeIds(ra2)).not.toContain(k1);
    // 撤掉的 Match 连带 MatchPlayer 一起没了（Cascade），没留孤儿行
    expect(await app.prisma.match.count({ where: { id: r2MatchId } })).toBe(0);
    expect(await app.prisma.matchPlayer.count({ where: { matchId: r2MatchId } })).toBe(0);

    // 看板同步：第 2 轮没有对局、三人轮空
    const board = res.body.data;
    expect(board.rounds[1].matches.length).toBe(0);
    expect(board.rounds[1].byeParticipantIds.length).toBe(3);

    // ——— 被撤空的轮次仍然是「将来」，还得能继续改 ———
    // 如果把「没有 PENDING 对局」当成历史跳过，第 2 轮就再也动不了：
    // 走掉的 k2 会永远挂在它的轮空名单里，看板一直显示他「在场上」，
    // 局长再点一次「TA 要走了」毫无反应；回来的 k1 也进不去。这两条都得钉死。
    const second = await api('POST', `/api/activities/${aid}/participants/${k2}/withdraw`, { token: host.token });
    expect(second.body.code).toBe(0);
    const [, rb2] = await dbRounds(aid);
    expect(byeIds(rb2).sort((a, b) => a - b)).toEqual([k3, k4].sort((a, b) => a - b));
    expect(byeIds(rb2)).not.toContain(k2);

    const back = await api('POST', `/api/activities/${aid}/participants/${k1}/rejoin`, { token: host.token });
    expect(back.body.code).toBe(0);
    const [rc1, rc2] = await dbRounds(aid);
    expect(byeIds(rc2)).toContain(k1);
    // 已结束的第 1 轮依旧一个字没动
    expect(rc1.matches[0].scoreA).toBe(21);
    expect(byeIds(rc1)).toEqual([]);
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
