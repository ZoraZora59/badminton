import type { PrismaClient } from '@prisma/client';
import type { BoardVM, MatchVM, SummaryVM, TodayRankRowVM } from '@badminton/shared';
import { ActivityStatus, GroupMode, MatchStatus, Team } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { matchInclude, roundInclude, toMatchVM, toRoundVM } from './mapper';

/** 对阵看板 */
export async function getBoard(prisma: PrismaClient, activityId: number): Promise<BoardVM> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  const rounds = await prisma.round.findMany({
    where: { activityId },
    include: roundInclude,
    orderBy: { index: 'asc' },
  });
  const roundVMs = rounds.map(toRoundVM);
  const firstUnfinished = roundVMs.find((r) => r.matches.some((m) => m.status !== MatchStatus.FINISHED));
  const currentRound = firstUnfinished?.index ?? (roundVMs.length ? roundVMs[roundVMs.length - 1].index : 0);
  return {
    activityId,
    status: activity.status as ActivityStatus,
    currentRound,
    totalRounds: roundVMs.length,
    rounds: roundVMs,
  };
}

async function loadMatchForHost(prisma: PrismaClient, matchId: number, hostId: number) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { ...matchInclude, round: { include: { activity: true } } },
  });
  if (!match) throw Errors.notFound('对局不存在');
  if (match.round.activity.hostId !== hostId) throw Errors.forbidden('仅局长可计分');
  return match;
}

/** 计分 / 改判：定胜负（羽毛球不允许平局） */
export async function scoreMatch(
  prisma: PrismaClient,
  matchId: number,
  hostId: number,
  scoreA: number,
  scoreB: number,
): Promise<MatchVM> {
  const match = await loadMatchForHost(prisma, matchId, hostId);
  if (scoreA === scoreB) throw Errors.badRequest('比分不能相同，需分出胜负');
  const winner = scoreA > scoreB ? Team.A : Team.B;
  await prisma.match.update({
    where: { id: matchId },
    data: { scoreA, scoreB, winner, status: MatchStatus.FINISHED },
  });

  // 本轮全部结束 → 轮次标记结束
  const siblings = await prisma.match.findMany({ where: { roundId: match.roundId } });
  if (siblings.every((m) => (m.id === matchId ? true : m.status === MatchStatus.FINISHED))) {
    await prisma.round.update({ where: { id: match.roundId }, data: { status: MatchStatus.FINISHED } });
  }

  const updated = await prisma.match.findUnique({ where: { id: matchId }, include: matchInclude });
  return toMatchVM(updated!, match.round.index);
}

/**
 * 拖拽换人（同一轮内交换两名参赛者）—— 算法给草稿，人拍板。
 * 支持两种：①两人都在场上 → 互换场地/队伍；②一人在场上、一人轮空 → 轮空者上场、场上者下场。
 */
export async function swapPlayers(
  prisma: PrismaClient,
  matchId: number,
  hostId: number,
  participantA: number,
  participantB: number,
): Promise<BoardVM> {
  const match = await loadMatchForHost(prisma, matchId, hostId);
  const roundId = match.roundId;
  const round = await prisma.round.findUnique({ where: { id: roundId } });
  if (!round) throw Errors.notFound('轮次不存在');
  const byes = Array.isArray(round.byeJson) ? (round.byeJson as number[]) : [];

  const mpA = await prisma.matchPlayer.findFirst({ where: { participantId: participantA, match: { roundId } }, include: { match: true } });
  const mpB = await prisma.matchPlayer.findFirst({ where: { participantId: participantB, match: { roundId } }, include: { match: true } });

  const finished = (mp: typeof mpA) => mp?.match.status === MatchStatus.FINISHED;
  if (finished(mpA) || finished(mpB)) throw Errors.conflict('已结束的对局不可换人');

  if (mpA && mpB) {
    // 两人都在场上：互换 (matchId, team)
    await prisma.$transaction([
      prisma.matchPlayer.update({ where: { id: mpA.id }, data: { matchId: mpB.matchId, team: mpB.team } }),
      prisma.matchPlayer.update({ where: { id: mpB.id }, data: { matchId: mpA.matchId, team: mpA.team } }),
    ]);
  } else if (mpA && byes.includes(participantB)) {
    // B 轮空 → 顶替 A；A 下场轮空
    const newByes = byes.filter((x) => x !== participantB).concat(participantA);
    await prisma.$transaction([
      prisma.matchPlayer.update({ where: { id: mpA.id }, data: { participantId: participantB } }),
      prisma.round.update({ where: { id: roundId }, data: { byeJson: newByes } }),
    ]);
  } else if (mpB && byes.includes(participantA)) {
    const newByes = byes.filter((x) => x !== participantA).concat(participantB);
    await prisma.$transaction([
      prisma.matchPlayer.update({ where: { id: mpB.id }, data: { participantId: participantA } }),
      prisma.round.update({ where: { id: roundId }, data: { byeJson: newByes } }),
    ]);
  } else {
    throw Errors.badRequest('参赛者不在本轮对阵或轮空名单中');
  }

  return getBoard(prisma, round.activityId);
}

/** 本场结算：今日榜 + MVP */
export async function getSummary(prisma: PrismaClient, activityId: number): Promise<SummaryVM> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  const rounds = await prisma.round.findMany({ where: { activityId }, include: roundInclude, orderBy: { index: 'asc' } });
  const mode = (rounds[0]?.mode as GroupMode) ?? (activity.defaultMode as GroupMode);

  interface Acc {
    participantId: number;
    userId: number | null;
    displayName: string;
    avatarUrl: string | null;
    points: number;
    wins: number;
    losses: number;
    pointDiff: number;
  }
  const map = new Map<number, Acc>();
  const ensure = (pid: number, name: string, avatar: string | null, userId: number | null): Acc => {
    let a = map.get(pid);
    if (!a) {
      a = { participantId: pid, userId, displayName: name, avatarUrl: avatar, points: 0, wins: 0, losses: 0, pointDiff: 0 };
      map.set(pid, a);
    }
    return a;
  };

  for (const r of rounds) {
    for (const m of r.matches) {
      if (m.status !== MatchStatus.FINISHED || m.winner == null || m.scoreA == null || m.scoreB == null) continue;
      for (const mp of m.players) {
        const p = mp.participant;
        const acc = ensure(p.id, p.displayName, p.user?.avatarUrl ?? null, p.userId);
        const scoreFor = mp.team === Team.A ? m.scoreA : m.scoreB;
        const scoreAgainst = mp.team === Team.A ? m.scoreB : m.scoreA;
        acc.points += scoreFor;
        acc.pointDiff += scoreFor - scoreAgainst;
        if (m.winner === mp.team) acc.wins += 1;
        else acc.losses += 1;
      }
    }
  }

  const rows = [...map.values()].sort((a, b) => {
    if (mode === GroupMode.BALANCED) {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.pointDiff - a.pointDiff;
    }
    if (b.points !== a.points) return b.points - a.points;
    return b.pointDiff - a.pointDiff;
  });

  const rank: TodayRankRowVM[] = rows.map((a, i) => {
    const games = a.wins + a.losses;
    return {
      rank: i + 1,
      participantId: a.participantId,
      userId: a.userId,
      displayName: a.displayName,
      avatarUrl: a.avatarUrl,
      points: a.points,
      wins: a.wins,
      losses: a.losses,
      pointDiff: a.pointDiff,
      winRate: games ? Math.round((a.wins / games) * 100) / 100 : 0,
    };
  });

  return { activityId, mode, mvp: rank[0] ?? null, rank };
}

/** 结束活动（收尾） */
export async function finishActivity(prisma: PrismaClient, activityId: number, hostId: number): Promise<void> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  if (activity.hostId !== hostId) throw Errors.forbidden('仅局长可操作');
  await prisma.activity.update({ where: { id: activityId }, data: { status: ActivityStatus.FINISHED } });
}
