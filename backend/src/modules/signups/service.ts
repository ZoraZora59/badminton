import type { PrismaClient } from '@prisma/client';
import type { SignupVM } from '@badminton/shared';
import { ActivityStatus, SignupStatus } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { toSignupVM } from './mapper';

/** 当前占位人数（含 +1） */
async function occupantCount(prisma: PrismaClient, activityId: number): Promise<number> {
  const signed = await prisma.signup.findMany({
    where: { activityId, status: SignupStatus.SIGNED_UP },
    select: { plusOne: true },
  });
  return signed.reduce((s, x) => s + 1 + x.plusOne, 0);
}

/** 严格队列补位：依次把最早的候补转正，直到不再有人能补进 */
async function autofill(prisma: PrismaClient, activityId: number, capacity: number): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const occ = await occupantCount(prisma, activityId);
    const next = await prisma.signup.findFirst({
      where: { activityId, status: SignupStatus.WAITLIST },
      orderBy: { order: 'asc' },
    });
    if (!next) break;
    if (occ + 1 + next.plusOne <= capacity) {
      await prisma.signup.update({ where: { id: next.id }, data: { status: SignupStatus.SIGNED_UP } });
    } else break;
  }
}

async function loadActivity(prisma: PrismaClient, activityId: number) {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  return activity;
}

/** 报名 / 改 +1：满员自动进候补 */
export async function signup(
  prisma: PrismaClient,
  activityId: number,
  userId: number,
  plusOne: number,
): Promise<SignupVM> {
  const activity = await loadActivity(prisma, activityId);
  if (activity.status !== ActivityStatus.SIGNUP) throw Errors.conflict('活动已不在报名中');

  const existing = await prisma.signup.findUnique({
    where: { activityId_userId: { activityId, userId } },
  });

  // 计算占位（排除本人已占用的名额）
  const occ = await occupantCount(prisma, activityId);
  const selfOccupied = existing && existing.status === SignupStatus.SIGNED_UP ? 1 + existing.plusOne : 0;
  const need = 1 + plusOne;
  const fits = occ - selfOccupied + need <= activity.capacity;
  const status = fits ? SignupStatus.SIGNED_UP : SignupStatus.WAITLIST;

  let row;
  if (existing) {
    row = await prisma.signup.update({
      where: { id: existing.id },
      data: { plusOne, status },
      include: { user: true },
    });
  } else {
    const maxOrder = await prisma.signup.aggregate({ where: { activityId }, _max: { order: true } });
    row = await prisma.signup.create({
      data: { activityId, userId, plusOne, status, order: (maxOrder._max.order ?? 0) + 1 },
      include: { user: true },
    });
  }
  return toSignupVM(row);
}

/** 取消报名（从名单移除）→ 触发补位。局长不可取消。 */
export async function cancelSignup(prisma: PrismaClient, activityId: number, userId: number): Promise<void> {
  const activity = await loadActivity(prisma, activityId);
  if (activity.hostId === userId) throw Errors.forbidden('局长不能取消报名');
  const existing = await prisma.signup.findUnique({ where: { activityId_userId: { activityId, userId } } });
  if (!existing) throw Errors.notFound('未报名');
  await prisma.signup.delete({ where: { id: existing.id } });
  await autofill(prisma, activityId, activity.capacity);
}

/** 请假（保留在名单、标记不来）→ 释放名额触发补位 */
export async function requestLeave(prisma: PrismaClient, activityId: number, userId: number): Promise<SignupVM> {
  const activity = await loadActivity(prisma, activityId);
  const existing = await prisma.signup.findUnique({
    where: { activityId_userId: { activityId, userId } },
    include: { user: true },
  });
  if (!existing) throw Errors.notFound('未报名');
  const row = await prisma.signup.update({
    where: { id: existing.id },
    data: { status: SignupStatus.LEAVE },
    include: { user: true },
  });
  await autofill(prisma, activityId, activity.capacity);
  return toSignupVM(row);
}

/** 报名名单（头像墙）：报名 → 候补 → 请假 排序 */
export async function getSignups(prisma: PrismaClient, activityId: number): Promise<SignupVM[]> {
  await loadActivity(prisma, activityId);
  const rows = await prisma.signup.findMany({
    where: { activityId },
    include: { user: true },
    orderBy: [{ status: 'asc' }, { order: 'asc' }],
  });
  const rank: Record<string, number> = { SIGNED_UP: 0, WAITLIST: 1, LEAVE: 2 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || a.order - b.order);
  return rows.map(toSignupVM);
}
