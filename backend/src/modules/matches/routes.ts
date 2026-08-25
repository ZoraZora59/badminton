import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/response';
import { currentUserId } from '../../plugins/auth';
import {
  finishActivity,
  getBoard,
  getSummary,
  rejoinParticipant,
  scoreMatch,
  swapPlayers,
  withdrawParticipant,
} from './service';

const ActIdParam = z.object({ id: z.coerce.number().int().positive() });
const MatchIdParam = z.object({ id: z.coerce.number().int().positive() });
const RosterParam = z.object({
  id: z.coerce.number().int().positive(),
  pid: z.coerce.number().int().positive(),
});
const ScoreBody = z.object({ scoreA: z.number().int().min(0).max(99), scoreB: z.number().int().min(0).max(99) });
const SwapBody = z.object({ participantA: z.number().int().positive(), participantB: z.number().int().positive() });

export default async function matchRoutes(app: FastifyInstance) {
  // 看板
  app.get('/activities/:id/board', { preHandler: app.authenticate }, async (req) => {
    const { id } = ActIdParam.parse(req.params);
    return ok(await getBoard(app.prisma, id));
  });

  // 结算（今日榜 + MVP）
  app.get('/activities/:id/summary', { preHandler: app.authenticate }, async (req) => {
    const { id } = ActIdParam.parse(req.params);
    return ok(await getSummary(app.prisma, id));
  });

  // 收尾结束活动
  app.post('/activities/:id/finish', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = ActIdParam.parse(req.params);
    await finishActivity(app.prisma, id, uid);
    return ok({ finished: true });
  });

  // 计分
  app.post('/matches/:id/score', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = MatchIdParam.parse(req.params);
    const { scoreA, scoreB } = ScoreBody.parse(req.body);
    return ok(await scoreMatch(app.prisma, id, uid, scoreA, scoreB));
  });

  // 改判（同计分逻辑，允许覆盖）
  app.patch('/matches/:id/score', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = MatchIdParam.parse(req.params);
    const { scoreA, scoreB } = ScoreBody.parse(req.body);
    return ok(await scoreMatch(app.prisma, id, uid, scoreA, scoreB));
  });

  // 拖拽换人
  app.post('/matches/:id/swap', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id } = MatchIdParam.parse(req.params);
    const { participantA, participantB } = SwapBody.parse(req.body);
    return ok(await swapPlayers(app.prisma, id, uid, participantA, participantB));
  });

  // 提前离场：从后续没打的对局里摘掉，已打完的战绩不动
  app.post('/activities/:id/participants/:pid/withdraw', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id, pid } = RosterParam.parse(req.params);
    return ok(await withdrawParticipant(app.prisma, id, pid, uid));
  });

  // 中途归队：放进后续轮次的轮空名单，局长再用换人把他换上场
  app.post('/activities/:id/participants/:pid/rejoin', { preHandler: app.authenticate }, async (req) => {
    const uid = currentUserId(req);
    const { id, pid } = RosterParam.parse(req.params);
    return ok(await rejoinParticipant(app.prisma, id, pid, uid));
  });
}
