import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/response';
import { currentUserId } from '../../plugins/auth';
import { cancelSignup, getSignups, requestLeave, signup } from './service';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const SignupBody = z.object({ plusOne: z.number().int().min(0).max(5).default(0) });

export default async function signupRoutes(app: FastifyInstance) {
  app.post('/activities/:id/signups', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    const { plusOne } = SignupBody.parse(req.body ?? {});
    return ok(await signup(app.prisma, id, uid, plusOne));
  });

  app.delete('/activities/:id/signups/me', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    await cancelSignup(app.prisma, id, uid);
    return ok({ cancelled: true });
  });

  app.post('/activities/:id/signups/me/leave', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    return ok(await requestLeave(app.prisma, id, uid));
  });

  app.get('/activities/:id/signups', { preHandler: app.authenticate }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return ok(await getSignups(app.prisma, id));
  });
}
