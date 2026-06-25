import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { fail } from '../lib/response';

/** 统一错误 → { code, message, data:null } 响应包 */
export default fp(async function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { validation?: unknown }, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.httpStatus).send(fail(err.message, err.code));
      return;
    }
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      reply.status(400).send(fail(`参数校验失败: ${msg}`, 400));
      return;
    }
    // Fastify 自带校验错误
    if ((err as { validation?: unknown }).validation) {
      reply.status(400).send(fail(err.message, 400));
      return;
    }
    req.log.error(err);
    reply.status(500).send(fail('服务器内部错误', 500));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(fail(`接口不存在: ${req.method} ${req.url}`, 404));
  });
});
