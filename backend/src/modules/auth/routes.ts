import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/response';
import { login } from './service';

const LoginBody = z.object({
  code: z.string().optional(),
  mockOpenid: z.string().optional(),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req) => {
    const body = LoginBody.parse(req.body ?? {});
    const result = await login(app.config, app.prisma, body);
    return ok(result);
  });
}
