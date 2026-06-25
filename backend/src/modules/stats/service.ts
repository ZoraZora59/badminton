import type { PrismaClient } from '@prisma/client';
import type { UserStatsVM } from '@badminton/shared';
import { Team } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { toUserVM } from '../users/mapper';

interface Agg {
  games: number;
  wins: number;
}

/**
 * 跨局个人战绩（按 User / openid 聚合）。
 * 个人积分约定：累计「己方得分」(americano 习惯：得多少分算多少积分)。
 * 净胜分 = Σ(己方得分 - 对方得分)。
 */
export async function getUserStats(prisma: PrismaClient, userId: number): Promise<UserStatsVM> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound('用户不存在');

  const myParts = await prisma.participant.findMany({ where: { userId }, select: { id: true } });
  const myPartIds = new Set(myParts.map((p) => p.id));

  const empty: UserStatsVM = {
    user: toUserVM(user),
    totalGames: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    points: 0,
    bestPartner: null,
    nemesis: null,
    trend: [],
  };
  if (myPartIds.size === 0) return empty;

  const mps = await prisma.matchPlayer.findMany({
    where: { participantId: { in: [...myPartIds] }, match: { status: 'FINISHED', winner: { not: null } } },
    include: {
      match: { include: { players: { include: { participant: true } } } },
    },
  });

  let wins = 0;
  let losses = 0;
  let points = 0;
  const partnerAgg = new Map<number, Agg>(); // partnerUserId -> {games, wins}
  const nemesisAgg = new Map<number, Agg>(); // opponentUserId -> {games, wins(=他赢我的次数)}
  const trendPairs: Array<{ at: number; pts: number }> = [];

  for (const mp of mps) {
    const match = mp.match;
    const myTeam = mp.team as Team;
    const scoreFor = (myTeam === Team.A ? match.scoreA : match.scoreB) ?? 0;
    const scoreAgainst = (myTeam === Team.A ? match.scoreB : match.scoreA) ?? 0;
    const iWon = match.winner === myTeam;
    if (iWon) wins += 1;
    else losses += 1;
    points += scoreFor;
    trendPairs.push({ at: match.createdAt.getTime(), pts: scoreFor });

    for (const p of match.players) {
      if (myPartIds.has(p.participantId)) continue;
      const otherUserId = p.participant.userId;
      if (otherUserId == null) continue; // Guest 不进跨局聚合
      if (p.team === myTeam) {
        const a = partnerAgg.get(otherUserId) ?? { games: 0, wins: 0 };
        a.games += 1;
        if (iWon) a.wins += 1;
        partnerAgg.set(otherUserId, a);
      } else {
        const a = nemesisAgg.get(otherUserId) ?? { games: 0, wins: 0 };
        a.games += 1;
        if (!iWon) a.wins += 1; // 他赢我
        nemesisAgg.set(otherUserId, a);
      }
    }
  }

  const totalGames = wins + losses;
  const winRate = totalGames ? Math.round((wins / totalGames) * 100) / 100 : 0;

  const bestPartnerId = pickTop(partnerAgg);
  const nemesisId = pickTop(nemesisAgg);
  const refUserIds = [bestPartnerId, nemesisId].filter((x): x is number => x != null);
  const refUsers = refUserIds.length
    ? await prisma.user.findMany({ where: { id: { in: refUserIds } } })
    : [];
  const refMap = new Map(refUsers.map((u) => [u.id, u]));

  const trend = trendPairs.sort((a, b) => a.at - b.at).slice(-7).map((t) => t.pts);

  return {
    user: toUserVM(user),
    totalGames,
    wins,
    losses,
    winRate,
    points,
    bestPartner: bestPartnerId != null && refMap.has(bestPartnerId)
      ? { userId: bestPartnerId, displayName: refMap.get(bestPartnerId)!.nickname, avatarUrl: refMap.get(bestPartnerId)!.avatarUrl || null }
      : null,
    nemesis: nemesisId != null && refMap.has(nemesisId)
      ? { userId: nemesisId, displayName: refMap.get(nemesisId)!.nickname, avatarUrl: refMap.get(nemesisId)!.avatarUrl || null }
      : null,
    trend,
  };
}

/** 取出现次数最多者（按 wins 优先，其次 games） */
function pickTop(agg: Map<number, Agg>): number | null {
  let bestId: number | null = null;
  let best: Agg | null = null;
  for (const [id, a] of agg) {
    if (!best || a.wins > best.wins || (a.wins === best.wins && a.games > best.games)) {
      best = a;
      bestId = id;
    }
  }
  return bestId;
}
