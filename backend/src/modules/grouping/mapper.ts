import type { GroupingScheduleVM, GroupingSettings, ParticipantVM, RoundVM } from '@badminton/shared';
import { MatchStatus, Team } from '@badminton/shared';
import type { EngineSchedule } from './engine';

export function engineToScheduleVM(
  schedule: EngineSchedule,
  settings: GroupingSettings,
  pmap: Map<number, ParticipantVM>,
): GroupingScheduleVM {
  const rounds: RoundVM[] = schedule.rounds.map((r) => ({
    index: r.index,
    matches: r.matches.map((m) => ({
      id: `${r.index}-${m.courtNo}`,
      roundIndex: r.index,
      courtNo: m.courtNo,
      teamA: { team: Team.A, participants: m.teamA.ids.map((id) => pmap.get(id)!).filter(Boolean), strength: m.teamA.strength },
      teamB: { team: Team.B, participants: m.teamB.ids.map((id) => pmap.get(id)!).filter(Boolean), strength: m.teamB.strength },
      strengthGap: m.strengthGap,
      status: MatchStatus.PENDING,
      scoreA: null,
      scoreB: null,
      winner: null,
    })),
    byeParticipantIds: r.byes,
  }));
  return { settings, rounds, metrics: { ...schedule.metrics } };
}
