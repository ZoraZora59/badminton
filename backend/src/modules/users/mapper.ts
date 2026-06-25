import type { User } from '@prisma/client';
import type { UserVM } from '@badminton/shared';
import { Gender, SkillLevel } from '@badminton/shared';

export function toUserVM(user: User): UserVM {
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    gender: user.gender as Gender,
    defaultLevel: user.defaultLevel as SkillLevel,
    createdAt: user.createdAt.toISOString(),
  };
}
