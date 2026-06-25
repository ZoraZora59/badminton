import type { PrismaClient } from '@prisma/client';
import type { CheckinReq, ParticipantVM, SignupVM, AddGuestReq } from '@badminton/shared';
import { DEFAULT_LEVEL, Gender, SignupStatus, SkillLevel } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { getSignups } from '../signups/service';
import { toSignupVM } from '../signups/mapper';
import { toParticipantVM } from './mapper';

async function assertActivity(prisma: PrismaClient, activityId: number) {
  const a = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!a) throw Errors.notFound('活动不存在');
  return a;
}

export interface CheckinListVM {
  signups: SignupVM[];
  guests: ParticipantVM[];
}

/** 签到清单：报名名单（含签到状态/本场水平）+ 已加的临时球友 */
export async function getCheckinList(prisma: PrismaClient, activityId: number): Promise<CheckinListVM> {
  await assertActivity(prisma, activityId);
  const signups = await getSignups(prisma, activityId);
  const guests = await prisma.participant.findMany({
    where: { activityId, isGuest: true },
    include: { user: true },
  });
  return { signups, guests: guests.map(toParticipantVM) };
}

/** 批量勾签到 + 设本场水平 */
export async function batchCheckin(prisma: PrismaClient, activityId: number, req: CheckinReq): Promise<CheckinListVM> {
  await assertActivity(prisma, activityId);
  for (const item of req.items) {
    const s = await prisma.signup.findUnique({ where: { id: item.signupId } });
    if (!s || s.activityId !== activityId) continue;
    await prisma.signup.update({
      where: { id: item.signupId },
      data: {
        checkedIn: item.checkedIn,
        ...(item.perGameLevel ? { perGameLevel: item.perGameLevel } : {}),
      },
    });
  }
  return getCheckinList(prisma, activityId);
}

/** 球友自助签到：把自己的「已报名」记录标记为实到（局长无需逐个勾选） */
export async function selfCheckin(
  prisma: PrismaClient,
  activityId: number,
  userId: number,
  checkedIn: boolean,
): Promise<SignupVM> {
  await assertActivity(prisma, activityId);
  const existing = await prisma.signup.findUnique({
    where: { activityId_userId: { activityId, userId } },
    include: { user: true },
  });
  if (!existing) throw Errors.badRequest('你还没有报名本场活动');
  if (existing.status === SignupStatus.LEAVE) throw Errors.conflict('你已请假，如要参赛请先重新报名');
  if (existing.status === SignupStatus.WAITLIST) throw Errors.conflict('你在候补名单中，转正后才能签到');
  const row = await prisma.signup.update({
    where: { id: existing.id },
    data: { checkedIn },
    include: { user: true },
  });
  return toSignupVM(row);
}

/** 添加临时球友（无微信占位） */
export async function addGuest(prisma: PrismaClient, activityId: number, req: AddGuestReq): Promise<ParticipantVM> {
  await assertActivity(prisma, activityId);
  const p = await prisma.participant.create({
    data: {
      activityId,
      userId: null,
      guestName: req.guestName,
      displayName: req.guestName,
      level: (req.level as SkillLevel) ?? DEFAULT_LEVEL,
      gender: (req.gender as Gender) ?? Gender.UNKNOWN,
      isGuest: true,
    },
    include: { user: true },
  });
  return toParticipantVM(p);
}

/** 候补补位（局长手动把候补转正） */
export async function promoteWaitlist(prisma: PrismaClient, activityId: number, signupId: number): Promise<SignupVM[]> {
  await assertActivity(prisma, activityId);
  const s = await prisma.signup.findUnique({ where: { id: signupId } });
  if (!s || s.activityId !== activityId) throw Errors.notFound('候补记录不存在');
  if (s.status !== SignupStatus.WAITLIST) throw Errors.conflict('该记录不是候补状态');
  await prisma.signup.update({ where: { id: signupId }, data: { status: SignupStatus.SIGNED_UP } });
  return getSignups(prisma, activityId);
}

/**
 * 物化参赛者：为每个“已签到”的真人 signup 建/更新 Participant（取本场水平），
 * 再连同已加的 Guest 一起作为分组输入。
 */
export async function ensureParticipants(prisma: PrismaClient, activityId: number): Promise<void> {
  const checkedIn = await prisma.signup.findMany({
    where: { activityId, checkedIn: true, status: { not: SignupStatus.LEAVE } },
    include: { user: true },
  });
  for (const s of checkedIn) {
    const level = (s.perGameLevel as SkillLevel | null) ?? (s.user.defaultLevel as SkillLevel);
    await prisma.participant.upsert({
      where: { activityId_userId: { activityId, userId: s.userId } },
      create: {
        activityId,
        userId: s.userId,
        displayName: s.user.nickname,
        level,
        gender: s.user.gender,
        isGuest: false,
      },
      update: { level, displayName: s.user.nickname, gender: s.user.gender },
    });
  }
}

/** 分组输入：已签到真人 + Guest */
export async function listParticipants(prisma: PrismaClient, activityId: number): Promise<ParticipantVM[]> {
  await assertActivity(prisma, activityId);
  await ensureParticipants(prisma, activityId);
  const parts = await prisma.participant.findMany({
    where: { activityId },
    include: { user: true },
    orderBy: { id: 'asc' },
  });
  return parts.map(toParticipantVM);
}
