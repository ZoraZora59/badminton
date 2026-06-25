import type { Participant, User } from '@prisma/client';
import type { ParticipantVM } from '@badminton/shared';
import { Gender, SkillLevel } from '@badminton/shared';

export function toParticipantVM(p: Participant & { user?: User | null }): ParticipantVM {
  return {
    id: p.id,
    activityId: p.activityId,
    userId: p.userId,
    isGuest: p.isGuest,
    displayName: p.displayName,
    avatarUrl: p.user?.avatarUrl ?? null,
    level: p.level as SkillLevel,
    gender: p.gender as Gender,
  };
}
