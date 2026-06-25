import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ActivityStatus, GroupMode, MatchStatus, PlayType, SignupStatus, SkillLevel, Team } from '@badminton/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

let app: FastifyInstance;
const RUN = Date.now();
const createdUserIds: number[] = [];
const createdAccountOpenids: string[] = [];
let activityId = 0;

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

async function login(openid: string): Promise<{ token: string; userId: number; isNew: boolean }> {
  const r = await api('POST', '/api/auth/login', { body: { mockOpenid: openid } });
  expect(r.body.code).toBe(0);
  createdUserIds.push(r.body.data.user.id);
  createdAccountOpenids.push(openid);
  return { token: r.body.data.token, userId: r.body.data.user.id, isNew: r.body.data.isNew };
}

beforeAll(async () => {
  app = await buildApp(loadConfig('local'));
  await app.ready();
});

afterAll(async () => {
  // 清理本测试产生的数据（活动级联删除 signup/participant/round/match）
  if (activityId) await app.prisma.activity.deleteMany({ where: { id: activityId } });
  if (createdUserIds.length) {
    await app.prisma.activity.deleteMany({ where: { hostId: { in: createdUserIds } } });
    await app.prisma.participant.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.signup.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.prisma.wechatAccount.deleteMany({ where: { openid: { in: createdAccountOpenids } } });
  }
  await app.close();
});

describe('E1 登录与个人资料 + 双实体 1:1', () => {
  it('mock 登录创建用户，WechatAccount 与 User 1:1 关联，资料写入我们的 User', async () => {
    const host = await login(`t${RUN}_host`);
    expect(host.isNew).toBe(true);

    // 1:1 校验：微信账号 openid 指向同一个我们的 User
    const account = await app.prisma.wechatAccount.findUnique({
      where: { openid: `t${RUN}_host` },
      include: { user: true },
    });
    expect(account?.user?.id).toBe(host.userId);

    // 打通头像/昵称：写入“我们自己的 User”
    const patch = await api('PATCH', '/api/users/me', {
      token: host.token,
      body: { nickname: '林丹丹', avatarUrl: 'https://x/avatar.png', defaultLevel: SkillLevel.L4 },
    });
    expect(patch.body.code).toBe(0);
    const me = await api('GET', '/api/users/me', { token: host.token });
    expect(me.body.data.nickname).toBe('林丹丹');
    expect(me.body.data.defaultLevel).toBe(SkillLevel.L4);

    // 未登录 → 401
    const noauth = await api('GET', '/api/users/me');
    expect(noauth.status).toBe(401);
  });
});

describe('E2–E8 完整用户故事走查', () => {
  it('建局→报名/候补/补位/请假→签到/Guest→分组(平衡)→看板/计分/改判/换人→结算→战绩', async () => {
    const host = await login(`t${RUN}_h2`);
    const p1 = await login(`t${RUN}_p1`);
    const p2 = await login(`t${RUN}_p2`);
    const p3 = await login(`t${RUN}_p3`);
    const p4 = await login(`t${RUN}_p4`);
    const p5 = await login(`t${RUN}_p5`);

    // E2 建局（capacity=4，便于触发候补）
    const created = await api('POST', '/api/activities', {
      token: host.token,
      body: {
        title: '走查局',
        startAt: new Date('2026-07-04T19:00:00+08:00').toISOString(),
        venue: '测试馆',
        courtCount: 1,
        capacity: 4,
        playType: PlayType.DOUBLES,
        defaultMode: GroupMode.BALANCED,
      },
    });
    expect(created.body.code).toBe(0);
    activityId = created.body.data.id;
    expect(created.body.data.status).toBe(ActivityStatus.SIGNUP);
    expect(created.body.data.signedUpCount).toBe(1); // 局长默认报名

    // 分享卡（免登录）
    const card = await api('GET', `/api/activities/${activityId}/share-card`);
    expect(card.body.code).toBe(0);
    expect(card.body.data.capacity).toBe(4);

    // 报名中可编辑（局长）
    const edit = await api('PATCH', `/api/activities/${activityId}`, {
      token: host.token,
      body: { remark: '记得带水' },
    });
    expect(edit.body.code).toBe(0);
    expect(edit.body.data.remark).toBe('记得带水');

    // E3 报名：p1,p2,p3 进正选(共4)，p4 满员候补
    for (const p of [p1, p2, p3]) {
      const r = await api('POST', `/api/activities/${activityId}/signups`, { token: p.token, body: {} });
      expect(r.body.data.status).toBe(SignupStatus.SIGNED_UP);
    }
    const r4 = await api('POST', `/api/activities/${activityId}/signups`, { token: p4.token, body: {} });
    expect(r4.body.data.status).toBe(SignupStatus.WAITLIST);

    // p3 取消 → 候补 p4 自动补位
    const cancel = await api('DELETE', `/api/activities/${activityId}/signups/me`, { token: p3.token });
    expect(cancel.body.code).toBe(0);
    let signups = (await api('GET', `/api/activities/${activityId}/signups`, { token: host.token })).body.data;
    const p4row = signups.find((s: any) => s.user.id === p4.userId);
    expect(p4row.status).toBe(SignupStatus.SIGNED_UP); // 自动补位生效

    // 局长不能取消报名
    const hostCancel = await api('DELETE', `/api/activities/${activityId}/signups/me`, { token: host.token });
    expect(hostCancel.status).toBe(403);

    // p5 报名（此时满员→候补），随后请假演示
    await api('POST', `/api/activities/${activityId}/signups`, { token: p5.token, body: {} });
    const leave = await api('POST', `/api/activities/${activityId}/signups/me/leave`, { token: p5.token });
    expect(leave.body.data.status).toBe(SignupStatus.LEAVE);

    // E4 签到：勾 host,p1,p2,p4 到场 + 设本场水平
    signups = (await api('GET', `/api/activities/${activityId}/checkin`, { token: host.token })).body.data.signups;
    const present = new Set([host.userId, p1.userId, p2.userId, p4.userId]);
    const items = signups
      .filter((s: any) => present.has(s.user.id))
      .map((s: any) => ({ signupId: s.id, checkedIn: true, perGameLevel: SkillLevel.L3 }));
    const checkin = await api('POST', `/api/activities/${activityId}/checkin`, { token: host.token, body: { items } });
    expect(checkin.body.code).toBe(0);

    // 加临时球友（Guest，无微信）
    const guest = await api('POST', `/api/activities/${activityId}/participants`, {
      token: host.token,
      body: { guestName: '临时小白', level: SkillLevel.L2 },
    });
    expect(guest.body.data.isGuest).toBe(true);

    // 参赛者池（4 真人 + 1 Guest = 5）
    const parts = (await api('GET', `/api/activities/${activityId}/participants`, { token: host.token })).body.data;
    expect(parts.length).toBe(5);
    const guestCount = parts.filter((p: any) => p.isGuest).length;
    expect(guestCount).toBe(1);

    // 非局长不能批量签到他人
    const badCheckin = await api('POST', `/api/activities/${activityId}/checkin`, { token: p1.token, body: { items: [] } });
    expect(badCheckin.status).toBe(403);

    // E4.2 自助签到：普通球友可标记/撤销自己实到（先撤再签验证开关）
    const selfOff = await api('POST', `/api/activities/${activityId}/checkin/me`, { token: p1.token, body: { checkedIn: false } });
    expect(selfOff.body.data.checkedIn).toBe(false);
    const selfOn = await api('POST', `/api/activities/${activityId}/checkin/me`, { token: p1.token, body: {} });
    expect(selfOn.body.data.checkedIn).toBe(true);
    // 请假者不可自助签到
    const selfLeave = await api('POST', `/api/activities/${activityId}/checkin/me`, { token: p5.token, body: {} });
    expect(selfLeave.status).toBeGreaterThanOrEqual(400);

    // E5 分组：智能平衡 双打 1 片 2 轮（5人→每轮1场+1轮空）
    const preview = await api('POST', `/api/activities/${activityId}/grouping/preview`, {
      token: host.token,
      body: {
        participantIds: parts.map((p: any) => p.id),
        playType: PlayType.DOUBLES,
        mode: GroupMode.BALANCED,
        courtCount: 1,
        rounds: 2,
        seed: 42,
      },
    });
    expect(preview.body.code).toBe(0);
    const schedule = preview.body.data;
    expect(schedule.rounds.length).toBe(2);
    expect(schedule.rounds[0].matches.length).toBe(1);
    expect(schedule.rounds[0].matches[0].teamA.participants.length).toBe(2);
    expect(schedule.rounds[0].byeParticipantIds.length).toBe(1);

    // 确认开打 → 活动 ONGOING
    const confirm = await api('POST', `/api/activities/${activityId}/grouping/confirm`, {
      token: host.token,
      body: { schedule },
    });
    expect(confirm.body.code).toBe(0);
    expect(confirm.body.data.status).toBe(ActivityStatus.ONGOING);
    expect(confirm.body.data.totalRounds).toBe(2);

    // 开打后不可编辑（仅报名中可改，与前端编辑入口一致）
    const editOngoing = await api('PATCH', `/api/activities/${activityId}`, {
      token: host.token,
      body: { capacity: 8 },
    });
    expect(editOngoing.status).toBe(409);

    // E6 看板 + 计分 + 改判
    let board = (await api('GET', `/api/activities/${activityId}/board`, { token: host.token })).body.data;
    const m1 = board.rounds[0].matches[0];
    const score = await api('POST', `/api/matches/${m1.id}/score`, { token: host.token, body: { scoreA: 21, scoreB: 15 } });
    expect(score.body.data.winner).toBe(Team.A);
    expect(score.body.data.status).toBe(MatchStatus.FINISHED);

    // 改判：翻盘
    const rejudge = await api('PATCH', `/api/matches/${m1.id}/score`, { token: host.token, body: { scoreA: 18, scoreB: 21 } });
    expect(rejudge.body.data.winner).toBe(Team.B);

    // 平局应被拒
    const tie = await api('POST', `/api/matches/${m1.id}/score`, { token: host.token, body: { scoreA: 20, scoreB: 20 } });
    expect(tie.status).toBe(400);

    // 非局长不能计分
    const badScore = await api('POST', `/api/matches/${m1.id}/score`, { token: p1.token, body: { scoreA: 21, scoreB: 10 } });
    expect(badScore.status).toBe(403);

    // 换人：把第2轮的轮空者与场上某人对调（拖拽微调）
    board = (await api('GET', `/api/activities/${activityId}/board`, { token: host.token })).body.data;
    const r2 = board.rounds[1];
    const onCourt = r2.matches[0].teamA.participants[0].id;
    const byeId = r2.byeParticipantIds[0];
    const r2match = r2.matches[0].id;
    const swap = await api('POST', `/api/matches/${r2match}/swap`, {
      token: host.token,
      body: { participantA: onCourt, participantB: byeId },
    });
    expect(swap.body.code).toBe(0);
    const r2after = swap.body.data.rounds[1];
    const onCourtAfter = [
      ...r2after.matches[0].teamA.participants.map((p: any) => p.id),
      ...r2after.matches[0].teamB.participants.map((p: any) => p.id),
    ];
    expect(onCourtAfter).toContain(byeId); // 原轮空者已上场
    expect(r2after.byeParticipantIds).toContain(onCourt); // 原上场者轮空

    // E7 结算：今日榜 + MVP
    const summary = (await api('GET', `/api/activities/${activityId}/summary`, { token: host.token })).body.data;
    expect(summary.rank.length).toBeGreaterThanOrEqual(2);
    expect(summary.mvp).not.toBeNull();

    // E8 个人战绩（跨局聚合）：参与了对局的人 totalGames>=1
    const winnerRow = summary.rank[0];
    if (winnerRow.userId) {
      const stats = (await api('GET', `/api/users/${winnerRow.userId}/stats`)).body.data;
      expect(stats.totalGames).toBeGreaterThanOrEqual(1);
      expect(stats.wins + stats.losses).toBe(stats.totalGames);
    }

    // 收尾结束
    const finish = await api('POST', `/api/activities/${activityId}/finish`, { token: host.token });
    expect(finish.body.code).toBe(0);
    const finalDetail = (await api('GET', `/api/activities/${activityId}`, { token: host.token })).body.data;
    expect(finalDetail.status).toBe(ActivityStatus.FINISHED);

    // 结束后同样不可编辑
    const editFinished = await api('PATCH', `/api/activities/${activityId}`, {
      token: host.token,
      body: { title: '改不动了' },
    });
    expect(editFinished.status).toBe(409);
  });
});

describe('R1 无 body 写接口：空 JSON 体兜底', () => {
  it('POST /cancel 带 application/json 头但空 body 不应 500（FST_ERR_CTP_EMPTY_JSON_BODY）', async () => {
    const host = await login(`t${RUN}_emptybody`);
    const created = await api('POST', '/api/activities', {
      token: host.token,
      body: {
        title: '空体取消',
        startAt: new Date('2026-07-05T19:00:00+08:00').toISOString(),
        venue: '测试馆',
        courtCount: 1,
        capacity: 4,
        playType: PlayType.DOUBLES,
        defaultMode: GroupMode.BALANCED,
      },
    });
    expect(created.body.code).toBe(0);
    const aid = created.body.data.id;

    // 真实小程序客户端：content-type=application/json 但不带 body（默认解析器会 500）
    const res = await app.inject({
      method: 'POST',
      url: `/api/activities/${aid}/cancel`,
      headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.status).toBe(ActivityStatus.CANCELLED);
  });
});

describe('E3+「+1 带人」物化为可改名 / 可移除的参赛者', () => {
  it('报名带 +1 → 签到页自动显形（幂等）→ 改名/设水平 → 移除并回收 plusOne', async () => {
    const host = await login(`t${RUN}_plus_host`);
    const bringer = await login(`t${RUN}_plus_bringer`);

    const created = await api('POST', '/api/activities', {
      token: host.token,
      body: {
        title: '+1 物化测试',
        startAt: new Date('2026-07-06T19:00:00+08:00').toISOString(),
        venue: '测试馆',
        courtCount: 2,
        capacity: 8,
        playType: PlayType.DOUBLES,
        defaultMode: GroupMode.BALANCED,
      },
    });
    expect(created.body.code).toBe(0);
    const aid = created.body.data.id;

    // bringer 报名并带 1 人
    const su = await api('POST', `/api/activities/${aid}/signups`, { token: bringer.token, body: { plusOne: 1 } });
    expect(su.body.data.plusOne).toBe(1);

    // 活动详情身位口径含 +1：host(1) + bringer(1+1) = 3
    const act = await api('GET', `/api/activities/${aid}`, { token: host.token });
    expect(act.body.data.signedUpCount).toBe(3);

    // 打开签到 → +1 自动物化为归属 bringer 的 Guest
    let checkin = (await api('GET', `/api/activities/${aid}/checkin`, { token: host.token })).body.data;
    const bringerSignup = checkin.signups.find((s: any) => s.user.id === bringer.userId);
    const plusGuests = checkin.guests.filter((g: any) => g.broughtBySignupId === bringerSignup.id);
    expect(plusGuests.length).toBe(1);
    const guestId = plusGuests[0].id;
    expect(plusGuests[0].isGuest).toBe(true);
    expect(plusGuests[0].displayName).toContain('的朋友');

    // 幂等：再次打开签到不重复建
    checkin = (await api('GET', `/api/activities/${aid}/checkin`, { token: host.token })).body.data;
    expect(checkin.guests.filter((g: any) => g.broughtBySignupId === bringerSignup.id).length).toBe(1);

    // 局长改名 + 设本场水平
    const renamed = await api('PATCH', `/api/activities/${aid}/participants/${guestId}`, {
      token: host.token,
      body: { displayName: '老王', level: SkillLevel.L3 },
    });
    expect(renamed.body.data.displayName).toBe('老王');
    expect(renamed.body.data.level).toBe(SkillLevel.L3);

    // 改过的名字不被 reconcile 回灌
    checkin = (await api('GET', `/api/activities/${aid}/checkin`, { token: host.token })).body.data;
    expect(checkin.guests.find((g: any) => g.id === guestId).displayName).toBe('老王');

    // 非局长不能改 / 删
    const forbid = await api('PATCH', `/api/activities/${aid}/participants/${guestId}`, {
      token: bringer.token,
      body: { displayName: 'x' },
    });
    expect(forbid.status).toBe(403);

    // 移除 +1 → 带人者 plusOne 减 1、占位不再复活
    const del = await api('DELETE', `/api/activities/${aid}/participants/${guestId}`, { token: host.token });
    expect(del.body.code).toBe(0);
    const after = (await api('GET', `/api/activities/${aid}/checkin`, { token: host.token })).body.data;
    expect(after.guests.find((g: any) => g.id === guestId)).toBeUndefined();
    expect(after.signups.find((s: any) => s.user.id === bringer.userId).plusOne).toBe(0);

    await app.prisma.activity.deleteMany({ where: { id: aid } });
  });
});
