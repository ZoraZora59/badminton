import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Gender, SkillLevel } from '@badminton/shared';
import { ok } from '../../lib/response';
import { Errors } from '../../lib/errors';
import { currentUserId } from '../../plugins/auth';
import { toUserVM } from './mapper';
import { getUserStats } from '../stats/service';

const UpdateProfileBody = z.object({
  nickname: z.string().min(1).max(20).optional(),
  // 头像为 base64 data URL（参考 camping），可达数十 KB
  avatarUrl: z.string().max(200000).optional(),
  gender: z.nativeEnum(Gender).optional(),
  defaultLevel: z.nativeEnum(SkillLevel).optional(),
});

export default async function userRoutes(app: FastifyInstance) {
  // 当前登录用户
  app.get('/users/me', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const user = await app.prisma.user.findUnique({ where: { id: uid } });
    if (!user) throw Errors.notFound('用户不存在');
    return ok(toUserVM(user));
  });

  // 维护资料：打通微信头像/昵称，写入“我们自己的 User”
  app.patch('/users/me', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const body = UpdateProfileBody.parse(req.body ?? {});
    const user = await app.prisma.user.update({ where: { id: uid }, data: body });
    return ok(toUserVM(user));
  });

  // 他人战绩（只读）/ 自己战绩
  app.get('/users/:id/stats', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const stats = await getUserStats(app.prisma, id);
    return ok(stats);
  });

  // 公开资料
  app.get('/users/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) throw Errors.notFound('用户不存在');
    return ok(toUserVM(user));
  });
}
