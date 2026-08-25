import type { Activity, PrismaClient, User } from '@prisma/client';
import type { ActivityVM, ActivityShareCardVM, CreateActivityReq, UpdateActivityReq } from '@badminton/shared';
import { ActivityStatus, SignupStatus } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { ActivityCounts, toActivityVM, toShareCardVM } from './mapper';

const hostInclude = { host: true } as const;

type ActivityWithHost = Activity & { host: User };

/**
 * 僵尸局自动收尾的缓冲时长：结束时间过去这么久还挂在「进行中」，就当作「打完各自散了，没人回来点结束」。
 *
 * 取 6 小时的理由：常见的晚场 20:00–22:00，拖堂加时、打完吃夜宵再看一眼手机，都还在这个窗口里，
 * 期间局长自己点「结束活动」或继续计分都不会被这条规则抢跑；而 6 小时之后基本不可能还在打，
 * 再挂着「进行中」就只是没人收尾。缓冲太短会误伤仍在进行的球局，太长（比如按天）则失去意义——
 * 首页把「进行中」永远排在最前，一个没收尾的局会一直霸占**每个参与者**首页的最上面。
 */
const AUTO_FINISH_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * 惰性收尾：读活动时顺手把「早该结束却还挂着进行中」的球局落到 FINISHED，返回按新状态修正过的行。
 *
 * 取舍：`endAt` 为 null 的老数据一律不动。没填结束时间就没有可靠基准（从 startAt 推要打多久纯属猜测），
 * 与其猜错把还在打的局判死，不如保持现状交给局长手动点「结束活动」。
 *
 * 幂等 + 并发安全：条件全部写在 updateMany 的 where 里，由数据库做原子条件更新。
 * 同一个活动被并发读取时，后到的那次只是影响 0 行，不会报错也不会重复写。
 * 批量做一次 updateMany，不在调用方的循环里逐个写库。
 */
async function autoFinishStale(prisma: PrismaClient, activities: ActivityWithHost[]): Promise<ActivityWithHost[]> {
  const deadline = new Date(Date.now() - AUTO_FINISH_GRACE_MS);
  const staleIds = activities
    .filter((a) => a.status === ActivityStatus.ONGOING && a.endAt !== null && a.endAt <= deadline)
    .map((a) => a.id);
  if (!staleIds.length) return activities;

  await prisma.activity.updateMany({
    where: { id: { in: staleIds }, status: ActivityStatus.ONGOING, endAt: { lte: deadline } },
    data: { status: ActivityStatus.FINISHED },
  });

  const staleSet = new Set(staleIds);
  return activities.map((a) => (staleSet.has(a.id) ? { ...a, status: ActivityStatus.FINISHED } : a));
}

/** 统计报名占位（含 +1）/候补/请假人数 + 头像墙预览 */
export async function getCounts(prisma: PrismaClient, activityId: number): Promise<ActivityCounts> {
  const signups = await prisma.signup.findMany({
    where: { activityId },
    include: { user: true },
    orderBy: { order: 'asc' },
  });
  let signedUpCount = 0;
  let waitlistCount = 0;
  let leaveCount = 0;
  const members: ActivityCounts['members'] = [];
  for (const s of signups) {
    if (s.status === SignupStatus.SIGNED_UP) {
      signedUpCount += 1 + s.plusOne;
      if (members.length < 6) members.push({ id: s.user.id, nickname: s.user.nickname, avatarUrl: s.user.avatarUrl });
    } else if (s.status === SignupStatus.WAITLIST) waitlistCount += 1 + s.plusOne;
    else if (s.status === SignupStatus.LEAVE) leaveCount += 1;
  }
  return { signedUpCount, waitlistCount, leaveCount, members };
}

export async function createActivity(
  prisma: PrismaClient,
  hostId: number,
  req: CreateActivityReq,
): Promise<ActivityVM> {
  const activity = await prisma.activity.create({
    data: {
      hostId,
      title: req.title,
      startAt: new Date(req.startAt),
      endAt: req.endAt ? new Date(req.endAt) : null,
      venue: req.venue,
      courtCount: req.courtCount,
      capacity: req.capacity,
      signupDeadline: req.signupDeadline ? new Date(req.signupDeadline) : null,
      playType: req.playType,
      // 建局不再设分组模式；不传时走 schema 列默认值 BALANCED
      ...(req.defaultMode !== undefined ? { defaultMode: req.defaultMode } : {}),
      mixedDoubles: req.mixedDoubles ?? false,
      remark: req.remark ?? null,
      status: ActivityStatus.SIGNUP,
      // 局长默认报名
      signups: { create: { userId: hostId, status: SignupStatus.SIGNED_UP, order: 0 } },
    },
    include: hostInclude,
  });
  const counts = await getCounts(prisma, activity.id);
  return toActivityVM(activity, counts, { currentUserId: hostId, mySignupStatus: SignupStatus.SIGNED_UP });
}

export async function listActivities(
  prisma: PrismaClient,
  userId: number,
  status?: ActivityStatus,
): Promise<ActivityVM[]> {
  // 只按「我参与的」过滤，status 不进 SQL：惰性收尾必须发生在按状态筛选之前。
  // 否则查 status=FINISHED 时，那些「早该结束却还挂 ONGOING」的行压根查不出来，
  // 既不会被收尾，也不会出现在「已结束」列表里——一条永远补不上的空洞。
  const rows = await prisma.activity.findMany({
    where: { OR: [{ hostId: userId }, { signups: { some: { userId } } }] },
    include: hostInclude,
    orderBy: { startAt: 'desc' },
  });
  // 先批量收尾，再进逐个取 counts 的循环——避免在循环里反复写库
  const finished = await autoFinishStale(prisma, rows);
  // 收尾之后再按状态筛，拿到的才是真实状态
  const activities = status ? finished.filter((a) => a.status === status) : finished;
  const result: ActivityVM[] = [];
  for (const a of activities) {
    const counts = await getCounts(prisma, a.id);
    const mine = await prisma.signup.findUnique({ where: { activityId_userId: { activityId: a.id, userId } } });
    result.push(
      toActivityVM(a, counts, {
        currentUserId: userId,
        mySignupStatus: (mine?.status as SignupStatus) ?? null,
      }),
    );
  }
  return result;
}

export async function getActivity(prisma: PrismaClient, id: number, currentUserId?: number): Promise<ActivityVM> {
  const row = await prisma.activity.findUnique({ where: { id }, include: hostInclude });
  if (!row) throw Errors.notFound('活动不存在');
  const [activity] = await autoFinishStale(prisma, [row]);
  const counts = await getCounts(prisma, id);
  let mySignupStatus: SignupStatus | null = null;
  let myCheckedIn = false;
  if (currentUserId != null) {
    const mine = await prisma.signup.findUnique({ where: { activityId_userId: { activityId: id, userId: currentUserId } } });
    mySignupStatus = (mine?.status as SignupStatus) ?? null;
    myCheckedIn = mine?.checkedIn ?? false;
  }
  return toActivityVM(activity, counts, { currentUserId, mySignupStatus, myCheckedIn });
}

async function assertHost(prisma: PrismaClient, id: number, userId: number) {
  const activity = await prisma.activity.findUnique({ where: { id } });
  if (!activity) throw Errors.notFound('活动不存在');
  if (activity.hostId !== userId) throw Errors.forbidden('仅局长可操作');
  return activity;
}

export async function updateActivity(
  prisma: PrismaClient,
  id: number,
  userId: number,
  req: UpdateActivityReq,
): Promise<ActivityVM> {
  const activity = await assertHost(prisma, id, userId);
  // 仅「报名中」可编辑：开打/结束后改时间·人数·场馆不合理，与前端编辑入口保持一致
  if (activity.status !== ActivityStatus.SIGNUP) throw Errors.conflict('仅报名中的球局可编辑');
  await prisma.activity.update({
    where: { id },
    data: {
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.startAt !== undefined ? { startAt: new Date(req.startAt) } : {}),
      ...(req.endAt !== undefined ? { endAt: req.endAt ? new Date(req.endAt) : null } : {}),
      ...(req.venue !== undefined ? { venue: req.venue } : {}),
      ...(req.courtCount !== undefined ? { courtCount: req.courtCount } : {}),
      ...(req.capacity !== undefined ? { capacity: req.capacity } : {}),
      ...(req.signupDeadline !== undefined
        ? { signupDeadline: req.signupDeadline ? new Date(req.signupDeadline) : null }
        : {}),
      ...(req.playType !== undefined ? { playType: req.playType } : {}),
      ...(req.defaultMode !== undefined ? { defaultMode: req.defaultMode } : {}),
      ...(req.mixedDoubles !== undefined ? { mixedDoubles: req.mixedDoubles } : {}),
      ...(req.remark !== undefined ? { remark: req.remark } : {}),
    },
  });
  return getActivity(prisma, id, userId);
}

export async function cancelActivity(prisma: PrismaClient, id: number, userId: number): Promise<ActivityVM> {
  await assertHost(prisma, id, userId);
  await prisma.activity.update({ where: { id }, data: { status: ActivityStatus.CANCELLED } });
  return getActivity(prisma, id, userId);
}

export async function getShareCard(prisma: PrismaClient, id: number): Promise<ActivityShareCardVM> {
  const activity = await prisma.activity.findUnique({ where: { id }, include: hostInclude });
  if (!activity) throw Errors.notFound('活动不存在');
  const counts = await getCounts(prisma, id);
  return toShareCardVM(activity, counts.signedUpCount);
}
