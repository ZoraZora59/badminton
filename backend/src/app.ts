import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config';
import prismaPlugin from './plugins/prisma';
import authPlugin from './plugins/auth';
import errorHandler from './plugins/error-handler';
import { ok } from './lib/response';
import { Errors } from './lib/errors';

import authRoutes from './modules/auth/routes';
import userRoutes from './modules/users/routes';
import activityRoutes from './modules/activities/routes';
import signupRoutes from './modules/signups/routes';
import checkinRoutes from './modules/checkin/routes';
import groupingRoutes from './modules/grouping/routes';
import matchRoutes from './modules/matches/routes';

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: 'info', transport: undefined },
    ajv: { customOptions: { coerceTypes: true } },
  });

  // 容忍空 body 的 application/json：无入参的写接口（取消球局/请假/结束/候补转正等）客户端常只带
  // JSON 头不带体，Fastify 默认解析器会抛 FST_ERR_CTP_EMPTY_JSON_BODY → 500。
  // 空体解析为 undefined，非空才 JSON.parse，解析失败按 400 返回。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(Errors.badRequest('请求体 JSON 解析失败'), undefined);
    }
  });

  await app.register(errorHandler);
  if (config.cors.enabled) {
    await app.register(cors, { origin: true });
  }
  await app.register(prismaPlugin, { config });
  await app.register(authPlugin);

  // 健康检查
  app.get('/api/health', async () => {
    await app.prisma.$queryRaw`SELECT 1`;
    return ok({ ok: true, ts: new Date().toISOString() });
  });

  // 业务路由（统一 /api 前缀）
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(activityRoutes, { prefix: '/api' });
  await app.register(signupRoutes, { prefix: '/api' });
  await app.register(checkinRoutes, { prefix: '/api' });
  await app.register(groupingRoutes, { prefix: '/api' });
  await app.register(matchRoutes, { prefix: '/api' });

  return app;
}
