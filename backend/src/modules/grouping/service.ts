import type { PrismaClient } from '@prisma/client';
import type { BoardVM, GroupingPreviewReq, GroupingScheduleVM, GroupingSettings, ParticipantVM } from '@badminton/shared';
import { ActivityStatus, GroupMode, PlayType, RotationKind, Team, levelWeight } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { toParticipantVM } from '../checkin/mapper';
import { getBoard } from '../matches/service';
import { generateSchedule, type EnginePlayer } from './engine';
import { engineToScheduleVM } from './mapper';

function perCourtOf(playType: PlayType) {
  return playType === PlayType.DOUBLES ? 4 : 2;
}

/** 生成对阵草稿（不落库） */
export async function previewGrouping(
  prisma: PrismaClient,
  activityId: number,
  req: GroupingPreviewReq,
): Promise<GroupingScheduleVM> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');

  const parts = await prisma.participant.findMany({
    where: { id: { in: req.participantIds }, activityId },
    include: { user: true },
  });
  if (parts.length !== req.participantIds.length) throw Errors.badRequest('参赛者列表含非法 id');
  const perCourt = perCourtOf(req.playType);
  if (parts.length < perCourt) throw Errors.badRequest(`参赛者不足，至少需要 ${perCourt} 人`);
  if (req.mode === GroupMode.ROTATION && !req.rotation) throw Errors.badRequest('轮转模式需指定 americano/mexicano');

  const players: EnginePlayer[] = parts.map((p) => ({
    id: p.id,
    weight: levelWeight(p.level as never),
    gender: p.gender as never,
  }));

  const schedule = generateSchedule(players, {
    playType: req.playType,
    mode: req.mode,
    rotation: req.rotation,
    courtCount: req.courtCount,
    rounds: req.rounds,
    mixedDoubles: req.mixedDoubles,
    seed: req.seed,
  });

  const pmap = new Map<number, ParticipantVM>(parts.map((p) => [p.id, toParticipantVM(p)]));
  const settings: GroupingSettings = {
    playType: req.playType,
    mode: req.mode,
    rotation: req.rotation,
    courtCount: req.courtCount,
    rounds: req.rounds,
    mixedDoubles: req.mixedDoubles,
    seed: req.seed,
  };
  return engineToScheduleVM(schedule, settings, pmap);
}

/** 确认开打：落库 Round/Match/MatchPlayer，活动转 ONGOING（重新确认会覆盖旧赛程） */
export async function confirmGrouping(
  prisma: PrismaClient,
  activityId: number,
  hostId: number,
  schedule: GroupingScheduleVM,
): Promise<BoardVM> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  if (activity.hostId !== hostId) throw Errors.forbidden('仅局长可确认分组');

  await prisma.$transaction(async (tx) => {
    // 覆盖旧赛程
    await tx.round.deleteMany({ where: { activityId } });
    for (const r of schedule.rounds) {
      const round = await tx.round.create({
        data: {
          activityId,
          index: r.index,
          mode: schedule.settings.mode,
          playType: schedule.settings.playType,
          rotation: schedule.settings.rotation ?? null,
          byeJson: r.byeParticipantIds,
        },
      });
      for (const m of r.matches) {
        const match = await tx.match.create({ data: { roundId: round.id, courtNo: m.courtNo } });
        const players = [
          ...m.teamA.participants.map((p) => ({ matchId: match.id, participantId: p.id, team: Team.A })),
          ...m.teamB.participants.map((p) => ({ matchId: match.id, participantId: p.id, team: Team.B })),
        ];
        await tx.matchPlayer.createMany({ data: players });
      }
    }
    await tx.activity.update({ where: { id: activityId }, data: { status: ActivityStatus.ONGOING } });
  });

  return getBoard(prisma, activityId);
}
