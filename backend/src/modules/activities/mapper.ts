import type { Activity, User } from '@prisma/client';
import type { ActivityVM, ActivityMemberVM, ActivityShareCardVM } from '@badminton/shared';
import { ActivityStatus, GroupMode, PlayType, SignupStatus } from '@badminton/shared';

export interface ActivityCounts {
  signedUpCount: number;
  waitlistCount: number;
  leaveCount: number;
  members: ActivityMemberVM[];
}

export function toActivityVM(
  activity: Activity & { host: User },
  counts: ActivityCounts,
  ctx?: { currentUserId?: number; mySignupStatus?: SignupStatus | null; myCheckedIn?: boolean },
): ActivityVM {
  return {
    id: activity.id,
    hostId: activity.hostId,
    hostNickname: activity.host.nickname,
    title: activity.title,
    startAt: activity.startAt.toISOString(),
    endAt: activity.endAt ? activity.endAt.toISOString() : null,
    venue: activity.venue,
    courtCount: activity.courtCount,
    capacity: activity.capacity,
    signupDeadline: activity.signupDeadline ? activity.signupDeadline.toISOString() : null,
    playType: activity.playType as PlayType,
    defaultMode: activity.defaultMode as GroupMode,
    mixedDoubles: activity.mixedDoubles,
    remark: activity.remark,
    status: activity.status as ActivityStatus,
    createdAt: activity.createdAt.toISOString(),
    signedUpCount: counts.signedUpCount,
    waitlistCount: counts.waitlistCount,
    leaveCount: counts.leaveCount,
    members: counts.members,
    isHost: ctx?.currentUserId != null ? activity.hostId === ctx.currentUserId : undefined,
    mySignupStatus: ctx?.mySignupStatus ?? null,
    myCheckedIn: ctx?.myCheckedIn ?? false,
  };
}

export function toShareCardVM(activity: Activity & { host: User }, signedUpCount: number): ActivityShareCardVM {
  return {
    activityId: activity.id,
    title: activity.title,
    startAt: activity.startAt.toISOString(),
    venue: activity.venue,
    signedUpCount,
    capacity: activity.capacity,
    hostNickname: activity.host.nickname,
  };
}
