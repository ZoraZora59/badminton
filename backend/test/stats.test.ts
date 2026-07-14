import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { User, Participant } from '@prisma/client';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

/**
 * 跨局个人战绩单测（stats/service.getUserStats，经 GET /api/users/:id/stats 走通）。
 *
 * 口径背景：搭档统计近期连改 3 次（fe854e7 / 0eaf34d / 673605a），本文件把「当前实现语义」锁定为基线：
 * - bestPartner（最佳搭档）= 同队真人搭档中「共同胜场」最多者（wins 优先，其次 games）；
 * - nemesis（难兄难弟）= 同队真人搭档中「一起输球次数」最多者（losses 优先，其次 games）；
 *   若命中的与最佳搭档是同一人（搭档样本太少）则返回 null；
 * - Guest（participant.userId = null）与对手都不进搭档聚合，但会出现在 recentMatches 名单明细；
 * - trend = 按时间升序的最近 7 局己方得分；recentMatches = 最新在前、上限 10 条；
 * - 只统计 status=FINISHED 且 winner 非空的对局；winRate 四舍五入到两位小数。
 *
 * 造数走 prisma 直写（活动/参赛者/轮次/对局/matchPlayer），比走接口更精准可控。
 * 连接的是共享远程 dev 库：所有数据挂 RUN 命名空间自建用户/活动下，afterAll 逆序清理，只删自己建的。
 */

let app: FastifyInstance;
const RUN = Date.now();

// 自建数据 id 追踪（afterAll 逆序清理用）
const createdWechatIds: number[] = [];
const createdUserIds: number[] = [];
const createdParticipantIds: number[] = [];
const createdRoundIds: number[] = [];
const createdMatchIds: number[] = [];
let activityId = 0;

// 主角与配角
let uA: User; // 主角：12 场完赛 + 1 场 PENDING
let uB: User; // 最佳搭档（共同 3 胜 1 负）
let uC: User; // 难兄难弟（共同 1 胜 3 负）
let uD: User; // 全部 12 场都是对手的真人（用来证明对手不进搭档聚合）
let uX: User; // 场景 2 主角：只有一个搭档
let uY: User; // 场景 2 的唯一搭档
let uEmpty: User; // 从未参赛
let pA: Participant;
let pGuestPartner: Participant; // 同队 Guest 搭档（无 userId）
let pGuestOpp: Participant; // 对手侧 Guest
const GUEST_PARTNER_NAME = '临时小G';
const OPPONENT_D_NAME = '丁对手';

// A 的 12 场按时间顺序的 matchId（用于断言 recentMatches 的倒序与上限）
const matchIdsA: number[] = [];

// 固定基准时间（过去时刻），第 i 场 = base + i 分钟，保证排序确定
const BASE_AT = new Date('2026-07-01T12:00:00Z').getTime();
const at = (i: number) => new Date(BASE_AT + i * 60_000);

async function createUser(tag: string, nickname: string): Promise<User> {
  const account = await app.prisma.wechatAccount.create({ data: { openid: `stats${RUN}_${tag}` } });
  createdWechatIds.push(account.id);
  // avatarUrl 显式置 ''（与登录建户逻辑一致）；这也顺带覆盖 bestPartner.avatarUrl 的 `'' || null` 转换
  const user = await app.prisma.user.create({
    data: { nickname, avatarUrl: '', wechatAccountId: account.id },
  });
  createdUserIds.push(user.id);
  return user;
}

async function createParticipant(opts: { userId?: number; displayName: string; isGuest?: boolean }): Promise<Participant> {
  const p = await app.prisma.participant.create({
    data: {
      activityId,
      userId: opts.userId ?? null,
      displayName: opts.displayName,
      isGuest: opts.isGuest ?? false,
    },
  });
  createdParticipantIds.push(p.id);
  return p;
}

/** 造一场已结束对局：按比分自动判胜方，createdAt 显式指定以控制 trend/recentMatches 的取数顺序 */
async function createFinishedMatch(opts: {
  roundId: number;
  createdAt: Date;
  teamA: number[];
  teamB: number[];
  scoreA: number;
  scoreB: number;
}) {
  const match = await app.prisma.match.create({
    data: {
      roundId: opts.roundId,
      courtNo: 1,
      scoreA: opts.scoreA,
      scoreB: opts.scoreB,
      winner: opts.scoreA > opts.scoreB ? 'A' : 'B',
      status: 'FINISHED',
      createdAt: opts.createdAt,
    },
  });
  createdMatchIds.push(match.id);
  await app.prisma.matchPlayer.createMany({
    data: [
      ...opts.teamA.map((pid) => ({ matchId: match.id, participantId: pid, team: 'A' as const })),
      ...opts.teamB.map((pid) => ({ matchId: match.id, participantId: pid, team: 'B' as const })),
    ],
  });
  return match;
}

/** 战绩接口免登录（他人战绩只读），不带 token 直接打 */
async function fetchStats(userId: number) {
  const res = await app.inject({ method: 'GET', url: `/api/users/${userId}/stats` });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.code).toBe(0);
  return body.data;
}

beforeAll(async () => {
  app = await buildApp(loadConfig('local'));
  await app.ready();

  // ---- 用户（真人：WechatAccount ↔ User 1:1）----
  uA = await createUser('a', '甲主角');
  uB = await createUser('b', '乙最佳');
  uC = await createUser('c', '丙难兄');
  uD = await createUser('d', OPPONENT_D_NAME);
  uX = await createUser('x', '戊独苗');
  uY = await createUser('y', '己唯一');
  uEmpty = await createUser('empty', '庚没打过');

  // ---- 活动 + 参赛者（含两个 Guest：一个同队搭档、一个对手）----
  const activity = await app.prisma.activity.create({
    data: {
      hostId: uA.id,
      title: `stats单测局_${RUN}`,
      startAt: new Date('2026-07-01T19:00:00+08:00'),
      venue: '测试馆',
    },
  });
  activityId = activity.id;

  pA = await createParticipant({ userId: uA.id, displayName: '甲主角' });
  const pB = await createParticipant({ userId: uB.id, displayName: '乙最佳' });
  const pC = await createParticipant({ userId: uC.id, displayName: '丙难兄' });
  const pD = await createParticipant({ userId: uD.id, displayName: OPPONENT_D_NAME });
  const pX = await createParticipant({ userId: uX.id, displayName: '戊独苗' });
  const pY = await createParticipant({ userId: uY.id, displayName: '己唯一' });
  pGuestPartner = await createParticipant({ displayName: GUEST_PARTNER_NAME, isGuest: true });
  pGuestOpp = await createParticipant({ displayName: '临时对手', isGuest: true });

  const round = await app.prisma.round.create({
    data: { activityId, index: 1, mode: 'BALANCED', playType: 'DOUBLES' },
  });
  createdRoundIds.push(round.id);

  // ---- A 的 12 场（时间升序）：搭档 B 3胜1负、搭档 C 1胜3负、搭档 Guest 0胜4负 ----
  // 对手恒为 D + 对手Guest：若对手泄漏进搭档聚合，D 会以 12 场碾压所有断言。
  // 己方得分设计成互不相同，便于精确断言 trend（最近 7 局 = 第 6~12 场）与 points 总和。
  const planA: Array<{ partner: number; scoreFor: number; scoreAgainst: number }> = [
    { partner: pB.id, scoreFor: 21, scoreAgainst: 10 }, // 1 胜
    { partner: pB.id, scoreFor: 21, scoreAgainst: 11 }, // 2 胜
    { partner: pB.id, scoreFor: 12, scoreAgainst: 21 }, // 3 负
    { partner: pB.id, scoreFor: 21, scoreAgainst: 13 }, // 4 胜
    { partner: pC.id, scoreFor: 21, scoreAgainst: 14 }, // 5 胜
    { partner: pC.id, scoreFor: 15, scoreAgainst: 21 }, // 6 负
    { partner: pC.id, scoreFor: 16, scoreAgainst: 21 }, // 7 负
    { partner: pC.id, scoreFor: 17, scoreAgainst: 21 }, // 8 负
    { partner: pGuestPartner.id, scoreFor: 18, scoreAgainst: 21 }, // 9 负
    { partner: pGuestPartner.id, scoreFor: 19, scoreAgainst: 21 }, // 10 负
    { partner: pGuestPartner.id, scoreFor: 5, scoreAgainst: 21 }, // 11 负
    { partner: pGuestPartner.id, scoreFor: 9, scoreAgainst: 21 }, // 12 负
  ];
  for (let i = 0; i < planA.length; i++) {
    const m = planA[i];
    const mySide = [pA.id, m.partner];
    const oppSide = [pD.id, pGuestOpp.id];
    // 奇偶交替站 A/B 队，覆盖 myTeam===Team.A / Team.B 两个取分分支
    const match = i % 2 === 0
      ? await createFinishedMatch({ roundId: round.id, createdAt: at(i + 1), teamA: mySide, teamB: oppSide, scoreA: m.scoreFor, scoreB: m.scoreAgainst })
      : await createFinishedMatch({ roundId: round.id, createdAt: at(i + 1), teamA: oppSide, teamB: mySide, scoreA: m.scoreAgainst, scoreB: m.scoreFor });
    matchIdsA.push(match.id);
  }

  // ---- 场景 2：X 只有一个搭档 Y，两场全输（不含 A，避免污染 A 的数字）----
  await createFinishedMatch({ roundId: round.id, createdAt: at(15), teamA: [pX.id, pY.id], teamB: [pD.id, pGuestOpp.id], scoreA: 10, scoreB: 21 });
  await createFinishedMatch({ roundId: round.id, createdAt: at(16), teamA: [pX.id, pY.id], teamB: [pD.id, pGuestOpp.id], scoreA: 11, scoreB: 21 });

  // ---- 干扰项：一场 PENDING（无比分/胜方）的对局，不应计入任何统计 ----
  const pending = await app.prisma.match.create({
    data: { roundId: round.id, courtNo: 2, status: 'PENDING', createdAt: at(20) },
  });
  createdMatchIds.push(pending.id);
  await app.prisma.matchPlayer.createMany({
    data: [
      { matchId: pending.id, participantId: pA.id, team: 'A' as const },
      { matchId: pending.id, participantId: pB.id, team: 'A' as const },
      { matchId: pending.id, participantId: pD.id, team: 'B' as const },
      { matchId: pending.id, participantId: pGuestOpp.id, team: 'B' as const },
    ],
  });
});

afterAll(async () => {
  // 逆序清理：matchPlayer → match → round → participant → signup → activity → user → wechatAccount（只删自己建的）
  if (createdMatchIds.length) {
    await app.prisma.matchPlayer.deleteMany({ where: { matchId: { in: createdMatchIds } } });
    await app.prisma.match.deleteMany({ where: { id: { in: createdMatchIds } } });
  }
  if (createdRoundIds.length) await app.prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
  if (createdParticipantIds.length) await app.prisma.participant.deleteMany({ where: { id: { in: createdParticipantIds } } });
  // 本文件不走报名流程，signup 属兜底清理
  if (createdUserIds.length) await app.prisma.signup.deleteMany({ where: { userId: { in: createdUserIds } } });
  if (activityId) await app.prisma.activity.deleteMany({ where: { id: activityId } });
  if (createdUserIds.length) await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  if (createdWechatIds.length) await app.prisma.wechatAccount.deleteMany({ where: { id: { in: createdWechatIds } } });
  await app.close();
});

describe('跨局个人战绩 GET /api/users/:id/stats', () => {
  it('S1+S6: 最佳搭档按共同胜场、难兄难弟按一起输球次数；总场次/胜负/胜率舍入/累计积分', async () => {
    const stats = await fetchStats(uA.id);
    expect(stats.user.id).toBe(uA.id);

    // 12 场完赛全计入；PENDING 那场被 status=FINISHED 过滤
    expect(stats.totalGames).toBe(12);
    expect(stats.wins).toBe(4); // 第 1/2/4/5 场
    expect(stats.losses).toBe(8);
    expect(stats.wins + stats.losses).toBe(stats.totalGames);
    // winRate = round(4/12*100)/100 = 0.33（两位小数四舍五入，锁定现状）
    expect(stats.winRate).toBe(0.33);
    // points = 己方得分累计（americano 口径）：21+21+12+21+21+15+16+17+18+19+5+9
    expect(stats.points).toBe(195);

    // 最佳搭档 = B（共同 3 胜 > C 的 1 胜）
    expect(stats.bestPartner).not.toBeNull();
    expect(stats.bestPartner.userId).toBe(uB.id);
    expect(stats.bestPartner.displayName).toBe('乙最佳');
    // 用户 avatarUrl 为空串时，接口输出转成 null（'' || null，锁定现状）
    expect(stats.bestPartner.avatarUrl).toBeNull();

    // 难兄难弟 = C（一起输 3 场 > B 的 1 场），与最佳搭档不同人时正常展示
    expect(stats.nemesis).not.toBeNull();
    expect(stats.nemesis.userId).toBe(uC.id);
    expect(stats.nemesis.displayName).toBe('丙难兄');
  });

  it('S2: 唯一搭档既是最佳又是一起输最多 → 难兄难弟为 null，不与最佳撞同一人', async () => {
    const stats = await fetchStats(uX.id);
    expect(stats.totalGames).toBe(2);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(2);
    expect(stats.winRate).toBe(0);
    expect(stats.points).toBe(10 + 11);

    // 锁定现状：pickTop 无最低胜场门槛，唯一搭档即使 0 胜也算「最佳搭档」
    expect(stats.bestPartner).not.toBeNull();
    expect(stats.bestPartner.userId).toBe(uY.id);
    // 一起输最多的也是 Y，但与最佳搭档同人 → 难兄难弟让位为 null
    expect(stats.nemesis).toBeNull();

    // 小样本顺带锁定 trend / recentMatches 的方向：trend 时间升序、明细最新在前
    expect(stats.trend).toEqual([10, 11]);
    expect(stats.recentMatches.map((m: any) => m.scoreFor)).toEqual([11, 10]);
  });

  it('S3: 同队 Guest（无 userId）不进搭档聚合，但出现在对局明细 partners', async () => {
    const stats = await fetchStats(uA.id);
    // A 和 Guest 一起输了 4 场（比 C 的 3 场还多），若 Guest 进聚合难兄难弟就会易主；
    // 实际 Guest 无 userId 被排除，难兄难弟仍是 C，最佳搭档仍是 B
    expect(stats.bestPartner.userId).toBe(uB.id);
    expect(stats.nemesis.userId).toBe(uC.id);
    expect([stats.bestPartner.displayName, stats.nemesis.displayName]).not.toContain(GUEST_PARTNER_NAME);

    // Guest 仍出现在对局明细的同队名单里（明细展示与聚合口径分离，锁定现状）
    const latest = stats.recentMatches[0]; // 第 12 场：搭档正是 Guest
    expect(latest.partners).toEqual([GUEST_PARTNER_NAME]);
  });

  it('S4: 对手不进搭档聚合 —— 输给 D 12 次也不会让 D 成为难兄难弟', async () => {
    const stats = await fetchStats(uA.id);
    // D 在全部 12 场都是对手（8 场赢了 A）：若对手泄漏进聚合，D 会以 12 场碾压成难兄难弟
    expect(stats.bestPartner.userId).not.toBe(uD.id);
    expect(stats.nemesis.userId).not.toBe(uD.id);
    expect(stats.nemesis.userId).toBe(uC.id);

    // 明细里 D 恒在 opponents、从不在 partners
    for (const m of stats.recentMatches) {
      expect(m.opponents).toContain(OPPONENT_D_NAME);
      expect(m.partners).not.toContain(OPPONENT_D_NAME);
    }
  });

  it('S5: trend 取时间升序的最近 7 局，recentMatches 上限 10 条且最新在前', async () => {
    const stats = await fetchStats(uA.id);

    // 12 场只取最近 7 场（第 6~12 场）的己方得分，按时间升序（老→新）
    expect(stats.trend).toEqual([15, 16, 17, 18, 19, 5, 9]);

    // recentMatches：12 场截断到 10 条，最新在前（第 12 场 → 第 3 场）
    expect(stats.recentMatches).toHaveLength(10);
    const expectIds = [...matchIdsA].reverse().slice(0, 10);
    expect(stats.recentMatches.map((m: any) => m.matchId)).toEqual(expectIds);

    // 抽查最新一条的字段口径：第 12 场 A 输 9:21
    const latest = stats.recentMatches[0];
    expect(latest.result).toBe('LOSS');
    expect(latest.scoreFor).toBe(9);
    expect(latest.scoreAgainst).toBe(21);
    expect(new Date(latest.playedAt).getTime()).toBe(at(12).getTime());
    expect(latest.opponents).toHaveLength(2); // D + 对手 Guest

    // playedAt 严格递减（倒序无并列，因造数时间互不相同）
    const times = stats.recentMatches.map((m: any) => new Date(m.playedAt).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThan(times[i - 1]);
  });

  it('从未参赛的用户返回空战绩（不报错）', async () => {
    const stats = await fetchStats(uEmpty.id);
    expect(stats.totalGames).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.points).toBe(0);
    expect(stats.bestPartner).toBeNull();
    expect(stats.nemesis).toBeNull();
    expect(stats.trend).toEqual([]);
    expect(stats.recentMatches).toEqual([]);
  });
});
