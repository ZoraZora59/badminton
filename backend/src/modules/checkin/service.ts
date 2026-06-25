import type { PrismaClient } from '@prisma/client';
import type { CheckinReq, ParticipantVM, SignupVM, AddGuestReq, UpdateGuestReq } from '@badminton/shared';
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

/**
 * 把每条「已报名」的 +1 带人物化成签到名单里的真实 Guest 行，归在带人者名下（broughtBySignupId）。
 * 幂等：按 plusOne 补足缺口、回收多余（带人者取消/减员）、不回灌局长改过的昵称/水平（只在 create 写默认值）。
 * 已经进入对阵（有 matchPlayers）的占位不删，避免破坏看板。
 */
export async function reconcilePlusOneGuests(prisma: PrismaClient, activityId: number): Promise<void> {
  const signups = await prisma.signup.findMany({
    where: { activityId, status: SignupStatus.SIGNED_UP },
    include: { user: true },
  });
  const wanted = new Map<number, number>(); // signupId -> plusOne
  for (const s of signups) if (s.plusOne > 0) wanted.set(s.id, s.plusOne);

  const existing = await prisma.participant.findMany({
    where: { activityId, isGuest: true, broughtBySignupId: { not: null } },
    include: { matchPlayers: { select: { id: true } } },
    orderBy: { id: 'asc' },
  });
  type GuestRow = (typeof existing)[number];
  const byBringer = new Map<number, GuestRow[]>();
  for (const g of existing) {
    const k = g.broughtBySignupId as number;
    const arr = byBringer.get(k);
    if (arr) arr.push(g);
    else byBringer.set(k, [g]);
  }

  // 1) 回收多余：带人者已取消/请假（不在 wanted）或 plusOne 减少 → 删掉超出的占位（仅删未进对阵的，从最新建的开始）
  for (const [bringerId, list] of byBringer) {
    const want = wanted.get(bringerId) ?? 0;
    const surplus = list.length - want;
    if (surplus <= 0) continue;
    const removable = list.filter((g) => g.matchPlayers.length === 0);
    const toDelete = removable.slice(-surplus).map((g) => g.id);
    if (toDelete.length) await prisma.participant.deleteMany({ where: { id: { in: toDelete } } });
  }

  // 2) 补足缺口：plusOne 比现有占位多 → 建带默认昵称/水平的占位
  for (const [bringerId, want] of wanted) {
    const s = signups.find((x) => x.id === bringerId);
    if (!s) continue;
    const have = (byBringer.get(bringerId)?.length ?? 0);
    const need = want - have;
    if (need <= 0) continue;
    const level = (s.perGameLevel as SkillLevel | null) ?? (s.user.defaultLevel as SkillLevel);
    for (let i = 0; i < need; i++) {
      const idx = have + i + 1;
      const name = want > 1 ? `${s.user.nickname}的朋友${idx}` : `${s.user.nickname}的朋友`;
      await prisma.participant.create({
        data: {
          activityId,
          userId: null,
          guestName: name,
          displayName: name,
          level,
          gender: Gender.UNKNOWN,
          isGuest: true,
          broughtBySignupId: bringerId,
        },
      });
    }
  }
}

/** 签到清单：报名名单（含签到状态/本场水平）+ 已加的临时球友（含 +1 带人物化的占位） */
export async function getCheckinList(prisma: PrismaClient, activityId: number): Promise<CheckinListVM> {
  await assertActivity(prisma, activityId);
  await reconcilePlusOneGuests(prisma, activityId);
  const signups = await getSignups(prisma, activityId);
  const guests = await prisma.participant.findMany({
    where: { activityId, isGuest: true },
    include: { user: true },
    orderBy: { id: 'asc' },
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

/** 编辑临时球友（含 +1 带人占位）的昵称/本场水平/性别 */
export async function updateGuest(
  prisma: PrismaClient,
  activityId: number,
  participantId: number,
  req: UpdateGuestReq,
): Promise<ParticipantVM> {
  await assertActivity(prisma, activityId);
  const p = await prisma.participant.findUnique({ where: { id: participantId } });
  if (!p || p.activityId !== activityId) throw Errors.notFound('球友不存在');
  if (!p.isGuest) throw Errors.conflict('只能编辑临时球友');
  const name = req.displayName?.trim();
  const updated = await prisma.participant.update({
    where: { id: participantId },
    data: {
      ...(name ? { displayName: name, guestName: name } : {}),
      ...(req.level ? { level: req.level as SkillLevel } : {}),
      ...(req.gender ? { gender: req.gender as Gender } : {}),
    },
    include: { user: true },
  });
  return toParticipantVM(updated);
}

/**
 * 移除临时球友。+1 带人占位被移除时，同步把带人者的 plusOne 减 1——
 * 既释放名额、又防止 reconcile 把它复活（语义即「贾大大其实少带了一个」）。
 * 已进对阵的占位不允许直接删，避免破坏看板。
 */
export async function removeGuest(prisma: PrismaClient, activityId: number, participantId: number): Promise<void> {
  await assertActivity(prisma, activityId);
  const p = await prisma.participant.findUnique({
    where: { id: participantId },
    include: { matchPlayers: { select: { id: true } } },
  });
  if (!p || p.activityId !== activityId) throw Errors.notFound('球友不存在');
  if (!p.isGuest) throw Errors.conflict('只能移除临时球友');
  if (p.matchPlayers.length > 0) throw Errors.conflict('该球友已进入对阵，无法移除');
  await prisma.$transaction(async (tx) => {
    if (p.broughtBySignupId) {
      const s = await tx.signup.findUnique({ where: { id: p.broughtBySignupId } });
      if (s && s.plusOne > 0) {
        await tx.signup.update({ where: { id: s.id }, data: { plusOne: s.plusOne - 1 } });
      }
    }
    await tx.participant.delete({ where: { id: participantId } });
  });
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
