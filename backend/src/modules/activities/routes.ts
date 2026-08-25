import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ActivityStatus, GroupMode, PlayType } from '@badminton/shared';
import { ok } from '../../lib/response';
import { currentUserId } from '../../plugins/auth';
import {
  cancelActivity,
  createActivity,
  getActivity,
  getShareCard,
  listActivities,
  updateActivity,
} from './service';

const CreateBody = z.object({
  title: z.string().min(1).max(40),
  startAt: z.string().min(1),
  endAt: z.string().nullable().optional(),
  venue: z.string().min(1).max(60),
  courtCount: z.number().int().min(1).max(20),
  // 球馆真实场地编号，逗号分隔如 "5,6,12"；选填，不填/清空则看板回落成序号。
  // 刻意不校验格式：球馆可能给的是「A区3号」，只限总长度，避免往 Text 列灌大段文本
  courtLabels: z.string().max(200).nullable().optional(),
  capacity: z.number().int().min(2).max(100),
  signupDeadline: z.string().nullable().optional(),
  playType: z.nativeEnum(PlayType),
  // 分组模式改为分组向导阶段选择；建局不再传，缺省由 DB 列默认值(BALANCED)兜底
  defaultMode: z.nativeEnum(GroupMode).optional(),
  mixedDoubles: z.boolean().optional(),
  remark: z.string().max(200).nullable().optional(),
});
const UpdateBody = CreateBody.partial();
const IdParam = z.object({ id: z.coerce.number().int().positive() });

export default async function activityRoutes(app: FastifyInstance) {
  app.post('/activities', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const body = CreateBody.parse(req.body);
    return ok(await createActivity(app.prisma, uid, body));
  });

  app.get('/activities', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { status } = z.object({ status: z.nativeEnum(ActivityStatus).optional() }).parse(req.query ?? {});
    return ok(await listActivities(app.prisma, uid, status));
  });

  app.get('/activities/:id', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    return ok(await getActivity(app.prisma, id, uid));
  });

  app.patch('/activities/:id', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    const body = UpdateBody.parse(req.body);
    return ok(await updateActivity(app.prisma, id, uid, body));
  });

  app.post('/activities/:id/cancel', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    return ok(await cancelActivity(app.prisma, id, uid));
  });

  // 分享卡：打开分享链接即可看，不强制登录
  app.get('/activities/:id/share-card', async (req) => {
    const { id } = IdParam.parse(req.params);
    return ok(await getShareCard(app.prisma, id));
  });
}
