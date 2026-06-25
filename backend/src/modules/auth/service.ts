import type { PrismaClient } from '@prisma/client';
import type { LoginResp } from '@badminton/shared';
import { DEFAULT_LEVEL } from '@badminton/shared';
import type { AppConfig } from '../../config';
import { code2session } from '../../lib/wechat';
import { signToken } from '../../lib/jwt';
import { toUserVM } from '../users/mapper';

/**
 * 登录：code2session 换 openid → upsert 微信账号 → 确保 1:1 关联的 User → 签 JWT。
 * 微信账号(WechatAccount) 与我们的 User 是两个实体，1:1 关联。
 */
export async function login(
  cfg: AppConfig,
  prisma: PrismaClient,
  body: { code?: string; mockOpenid?: string },
): Promise<LoginResp> {
  const session = await code2session(cfg, { code: body.code, mockOpenid: body.mockOpenid });

  // 1) upsert 微信账号
  const account = await prisma.wechatAccount.upsert({
    where: { openid: session.openid },
    create: {
      openid: session.openid,
      unionid: session.unionid ?? null,
      sessionKey: session.sessionKey ?? null,
    },
    update: {
      unionid: session.unionid ?? undefined,
      sessionKey: session.sessionKey ?? undefined,
    },
    include: { user: true },
  });

  // 2) 确保关联的 User 存在（1:1）
  let user = account.user;
  let isNew = false;
  if (!user) {
    user = await prisma.user.create({
      data: {
        wechatAccountId: account.id,
        nickname: '球友',
        avatarUrl: '',
        defaultLevel: DEFAULT_LEVEL,
      },
    });
    isNew = true;
  }

  // 3) 签 JWT
  const token = signToken(cfg, { userId: user.id });
  return { token, user: toUserVM(user), isNew };
}
