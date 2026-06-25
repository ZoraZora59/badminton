import type { Signup, User } from '@prisma/client';
import type { SignupVM } from '@badminton/shared';
import { SignupStatus, SkillLevel } from '@badminton/shared';
import { toUserVM } from '../users/mapper';

export function toSignupVM(signup: Signup & { user: User }): SignupVM {
  return {
    id: signup.id,
    activityId: signup.activityId,
    user: toUserVM(signup.user),
    status: signup.status as SignupStatus,
    plusOne: signup.plusOne,
    perGameLevel: (signup.perGameLevel as SkillLevel | null) ?? null,
    checkedIn: signup.checkedIn,
    order: signup.order,
    createdAt: signup.createdAt.toISOString(),
  };
}
