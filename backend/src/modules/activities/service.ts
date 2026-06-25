import type { PrismaClient } from '@prisma/client';
import type { ActivityVM, ActivityShareCardVM, CreateActivityReq, UpdateActivityReq } from '@badminton/shared';
import { ActivityStatus, SignupStatus } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { ActivityCounts, toActivityVM, toShareCardVM } from './mapper';

const hostInclude = { host: true } as const;

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
      defaultMode: req.defaultMode,
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
  const activities = await prisma.activity.findMany({
    where: {
      ...(status ? { status } : {}),
      OR: [{ hostId: userId }, { signups: { some: { userId } } }],
    },
    include: hostInclude,
    orderBy: { startAt: 'desc' },
  });
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
  const activity = await prisma.activity.findUnique({ where: { id }, include: hostInclude });
  if (!activity) throw Errors.notFound('活动不存在');
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
