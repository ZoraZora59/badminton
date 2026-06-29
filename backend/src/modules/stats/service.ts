import type { PrismaClient } from '@prisma/client';
import type { UserStatsVM, RecentMatchVM } from '@badminton/shared';
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
    recentMatches: [],
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
  const partnerAgg = new Map<number, Agg>(); // partnerUserId -> {games, wins}（同队搭档：最佳搭档 / 苦主都从这里取）
  const trendPairs: Array<{ at: number; pts: number }> = [];
  const matchRows: Array<{ at: number; row: RecentMatchVM }> = [];

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

    const partners: string[] = [];
    const opponents: string[] = [];
    for (const p of match.players) {
      if (myPartIds.has(p.participantId)) continue;
      if (p.team === myTeam) partners.push(p.participant.displayName);
      else opponents.push(p.participant.displayName);

      // 仅统计同队真人搭档；Guest（无 userId）与对手都不进跨局搭档聚合
      const otherUserId = p.participant.userId;
      if (otherUserId == null || p.team !== myTeam) continue;
      const a = partnerAgg.get(otherUserId) ?? { games: 0, wins: 0 };
      a.games += 1;
      if (iWon) a.wins += 1;
      partnerAgg.set(otherUserId, a);
    }

    matchRows.push({
      at: match.createdAt.getTime(),
      row: {
        matchId: match.id,
        playedAt: match.createdAt.toISOString(),
        result: iWon ? 'WIN' : 'LOSS',
        scoreFor,
        scoreAgainst,
        partners,
        opponents,
      },
    });
  }

  const totalGames = wins + losses;
  const winRate = totalGames ? Math.round((wins / totalGames) * 100) / 100 : 0;

  const bestPartnerId = pickTop(partnerAgg);
  // 苦主 = 和你一起输球次数最多的搭档；若与最佳搭档是同一人（搭档样本太少）则不展示
  const nemesisId = pickWorstPartner(partnerAgg, bestPartnerId);
  const refUserIds = [bestPartnerId, nemesisId].filter((x): x is number => x != null);
  const refUsers = refUserIds.length
    ? await prisma.user.findMany({ where: { id: { in: refUserIds } } })
    : [];
  const refMap = new Map(refUsers.map((u) => [u.id, u]));

  const trend = trendPairs.sort((a, b) => a.at - b.at).slice(-7).map((t) => t.pts);
  const recentMatches = matchRows.sort((a, b) => b.at - a.at).slice(0, 10).map((m) => m.row);

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
    recentMatches,
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

/**
 * 取「和你一起输球次数最多」者（与最佳搭档口径一致，都看次数）：按 losses 优先，其次 games。
 * 命中的就是最佳搭档时（如只有一个搭档样本）返回 null，避免同一人既是最佳又是苦主。
 */
function pickWorstPartner(agg: Map<number, Agg>, excludeId: number | null): number | null {
  let worstId: number | null = null;
  let worstLosses = -1;
  let worstGames = 0;
  for (const [id, a] of agg) {
    const losses = a.games - a.wins;
    if (losses > worstLosses || (losses === worstLosses && a.games > worstGames)) {
      worstLosses = losses;
      worstGames = a.games;
      worstId = id;
    }
  }
  return worstId != null && worstId !== excludeId ? worstId : null;
}
