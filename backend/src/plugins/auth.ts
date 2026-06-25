import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '../lib/jwt';
import { Errors } from '../lib/errors';

declare module 'fastify' {
  interface FastifyRequest {
    userId: number | null;
  }
  interface FastifyInstance {
    /** preHandler：要求已登录，注入 request.userId */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('userId', null);

  app.decorate('authenticate', async function (req: FastifyRequest) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw Errors.unauthorized();
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = verifyToken(app.config, token);
      req.userId = payload.userId;
    } catch {
      throw Errors.unauthorized();
    }
  });
});

/** 在已认证的处理器里取当前用户 id（无则抛 401） */
export function currentUserId(req: FastifyRequest): number {
  if (req.userId == null) throw Errors.unauthorized();
  return req.userId;
}
