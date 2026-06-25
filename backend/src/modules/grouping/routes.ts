import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GroupMode, PlayType, RotationKind } from '@badminton/shared';
import { ok } from '../../lib/response';
import { currentUserId } from '../../plugins/auth';
import { Errors } from '../../lib/errors';
import { confirmGrouping, previewGrouping } from './service';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const PreviewBody = z.object({
  participantIds: z.array(z.number().int().positive()).min(2),
  playType: z.nativeEnum(PlayType),
  mode: z.nativeEnum(GroupMode),
  rotation: z.nativeEnum(RotationKind).optional(),
  courtCount: z.number().int().min(1).max(20),
  rounds: z.number().int().min(1).max(30),
  mixedDoubles: z.boolean().optional(),
  seed: z.number().int().optional(),
});

// 确认时回传 preview 产出的 schedule（结构化校验从宽，核心字段必校）
const ConfirmBody = z.object({
  schedule: z.object({
    settings: z.object({
      playType: z.nativeEnum(PlayType),
      mode: z.nativeEnum(GroupMode),
      rotation: z.nativeEnum(RotationKind).optional(),
      courtCount: z.number().int(),
      rounds: z.number().int(),
      mixedDoubles: z.boolean().optional(),
      seed: z.number().int().optional(),
    }),
    rounds: z.array(
      z.object({
        index: z.number().int(),
        byeParticipantIds: z.array(z.number().int()),
        matches: z.array(
          z.object({
            courtNo: z.number().int(),
            teamA: z.object({ participants: z.array(z.object({ id: z.number().int() })) }),
            teamB: z.object({ participants: z.array(z.object({ id: z.number().int() })) }),
          }),
        ),
      }),
    ),
    metrics: z.any(),
  }),
});

async function assertHost(app: FastifyInstance, activityId: number, userId: number) {
  const a = await app.prisma.activity.findUnique({ where: { id: activityId } });
  if (!a) throw Errors.notFound('活动不存在');
  if (a.hostId !== userId) throw Errors.forbidden('仅局长可操作');
}

export default async function groupingRoutes(app: FastifyInstance) {
  app.post('/activities/:id/grouping/preview', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    await assertHost(app, id, uid);
    const body = PreviewBody.parse(req.body);
    return ok(await previewGrouping(app.prisma, id, body));
  });

  app.post('/activities/:id/grouping/confirm', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = IdParam.parse(req.params);
    const { schedule } = ConfirmBody.parse(req.body);
    return ok(await confirmGrouping(app.prisma, id, uid, schedule as never));
  });
}
