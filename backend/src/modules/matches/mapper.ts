import { Prisma } from '@prisma/client';
import type { MatchVM, RoundVM } from '@badminton/shared';
import { MatchStatus, PlayType, SkillLevel, Team, levelWeight } from '@badminton/shared';
import { toParticipantVM } from '../checkin/mapper';

export const matchInclude = {
  players: { include: { participant: { include: { user: true } } } },
} satisfies Prisma.MatchInclude;

export const roundInclude = {
  matches: { include: matchInclude, orderBy: { courtNo: 'asc' } },
} satisfies Prisma.RoundInclude;

export type MatchWithPlayers = Prisma.MatchGetPayload<{ include: typeof matchInclude }>;
export type RoundWithMatches = Prisma.RoundGetPayload<{ include: typeof roundInclude }>;

export function toMatchVM(match: MatchWithPlayers, roundIndex: number): MatchVM {
  const a = match.players.filter((p) => p.team === Team.A);
  const b = match.players.filter((p) => p.team === Team.B);
  const strength = (rows: typeof a) => rows.reduce((s, r) => s + levelWeight(r.participant.level as SkillLevel), 0);
  const sA = strength(a);
  const sB = strength(b);
  return {
    id: match.id,
    roundIndex,
    courtNo: match.courtNo,
    teamA: { team: Team.A, participants: a.map((p) => toParticipantVM(p.participant)), strength: sA },
    teamB: { team: Team.B, participants: b.map((p) => toParticipantVM(p.participant)), strength: sB },
    strengthGap: Math.abs(sA - sB),
    status: match.status as MatchStatus,
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    winner: (match.winner as Team | null) ?? null,
  };
}

export function toRoundVM(round: RoundWithMatches): RoundVM {
  const bye = Array.isArray(round.byeJson) ? (round.byeJson as number[]) : [];
  return {
    index: round.index,
    // 本轮玩法透传给看板：有人中途离场后场上会**留空位**（2v2 变 1v2），
    // 前端要靠 playType 算出「这队本该几个人、现在缺几个」，才画得出那个待补的空位。
    playType: round.playType as PlayType,
    matches: round.matches.map((m) => toMatchVM(m, round.index)),
    byeParticipantIds: bye,
  };
}
