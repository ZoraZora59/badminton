import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Gender, SkillLevel } from '@badminton/shared';
import { ok } from '../../lib/response';
import { currentUserId } from '../../plugins/auth';
import { Errors } from '../../lib/errors';
import { addGuest, batchCheckin, getCheckinList, listParticipants, promoteWaitlist, selfCheckin } from './service';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const CheckinBody = z.object({
  items: z.array(
    z.object({
      signupId: z.number().int().positive(),
      checkedIn: z.boolean(),
      perGameLevel: z.nativeEnum(SkillLevel).optional(),
    }),
  ),
});
const GuestBody = z.object({
  guestName: z.string().min(1).max(20),
  level: z.nativeEnum(SkillLevel).optional(),
  gender: z.nativeEnum(Gender).optional(),
});

async function assertHost(app: FastifyInstance, activityId: number, userId: number) {
  const a = await app.prisma.activity.findUnique({ where: { id: activityId } });
  if (!a) throw Errors.notFound('活动不存在');
  if (a.hostId !== userId) throw Errors.forbidden('仅局长可操作');
}

export default async function checkinRoutes(app: FastifyInstance) {
  app.get('/activities/:id/checkin', { preHandler: app.authenticate }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return ok(await getCheckinList(app.prisma, id));
  });

  app.post('/activities/:id/checkin', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    await assertHost(app, id, uid);
    const body = CheckinBody.parse(req.body);
    return ok(await batchCheckin(app.prisma, id, body));
  });

  app.post('/activities/:id/checkin/me', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    const body = z.object({ checkedIn: z.boolean().optional() }).parse(req.body ?? {});
    return ok(await selfCheckin(app.prisma, id, uid, body.checkedIn ?? true));
  });

  app.post('/activities/:id/participants', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    await assertHost(app, id, uid);
    const body = GuestBody.parse(req.body);
    return ok(await addGuest(app.prisma, id, body));
  });

  app.get('/activities/:id/participants', { preHandler: app.authenticate }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return ok(await listParticipants(app.prisma, id));
  });

  app.post('/activities/:id/signups/:signupId/promote', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    const { signupId } = z.object({ signupId: z.coerce.number().int().positive() }).parse(req.params);
    await assertHost(app, id, uid);
    return ok(await promoteWaitlist(app.prisma, id, signupId));
  });
}
