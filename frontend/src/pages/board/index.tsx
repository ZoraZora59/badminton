import { useState, useCallback, useMemo } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';
import {
  MatchStatus,
  Team,
  type BoardVM,
  type RoundVM,
  type MatchVM,
  type ParticipantVM,
} from '@badminton/shared';
import { api } from '../../services/endpoints';
import { toastError } from '../../services/api';
import { Avatar, Tag, PrimaryButton, Empty, PageFrame } from '../../components';
import './index.scss';

export default function Board() {
  const router = useRouter();
  const id = Number(router.params.id);

  const [board, setBoard] = useState<BoardVM | null>(null);
  const [roundIdx, setRoundIdx] = useState(0);
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    try {
      const b = await api.getBoard(id);
      setBoard(b);
      // 首次进入定位到当前轮；返回刷新时保留用户已切换的轮次
      setRoundIdx((prev) => (touched ? Math.min(prev, b.rounds.length - 1) : Math.max(0, b.currentRound - 1)));
    } catch (e) {
      toastError(e);
    }
  }, [id, touched]);

  useDidShow(() => {
    load();
  });

  // 全量参赛者名表：用于把 byeParticipantIds 还原成名字
  const nameMap = useMemo(() => {
    const m = new Map<number, ParticipantVM>();
    board?.rounds.forEach((r) =>
      r.matches.forEach((mt) => {
        [...mt.teamA.participants, ...mt.teamB.participants].forEach((p) => m.set(p.id, p));
      }),
    );
    return m;
  }, [board]);

  if (!board) {
    return (
      <PageFrame title="对阵看板" activeTab="home">
        <View className="board">
          <View className="board__loading">
            <Text className="board__loading-txt">加载中…</Text>
          </View>
        </View>
      </PageFrame>
    );
  }

  const total = board.totalRounds || board.rounds.length;
  const round: RoundVM | undefined = board.rounds[roundIdx];
  const hasPrev = roundIdx > 0;
  const hasNext = roundIdx < board.rounds.length - 1;

  const finishedCount = board.rounds.reduce(
    (acc, r) => acc + r.matches.filter((m) => m.status === MatchStatus.FINISHED).length,
    0,
  );

  const byeNames =
    round?.byeParticipantIds.map((pid) => nameMap.get(pid)?.displayName ?? '球友').filter(Boolean) ?? [];

  const goPrev = () => {
    if (!hasPrev) return;
    setTouched(true);
    setRoundIdx((i) => i - 1);
  };
  const goNext = () => {
    if (!hasNext) return;
    setTouched(true);
    setRoundIdx((i) => i + 1);
  };

  const enterScoring = (m: MatchVM) => {
    Taro.navigateTo({ url: `/pages/scoring/index?matchId=${m.id}&activityId=${id}` });
  };
  const goSummary = () => {
    Taro.navigateTo({ url: `/pages/summary/index?id=${id}` });
  };

  const renderTeam = (participants: ParticipantVM[], align: 'left' | 'right') => (
    <View className={`court__team court__team--${align}`}>
      {participants.map((p) => (
        <View key={p.id} className="court__player">
          {align === 'left' ? (
            <>
              <Avatar name={p.displayName} src={p.avatarUrl} size={26} />
              <Text className="court__player-name">{p.displayName}</Text>
            </>
          ) : (
            <>
              <Text className="court__player-name">{p.displayName}</Text>
              <Avatar name={p.displayName} src={p.avatarUrl} size={26} />
            </>
          )}
        </View>
      ))}
    </View>
  );

  const renderStack = (participants: ParticipantVM[]) => (
    <View className="result__stack">
      {participants.map((p, i) => (
        <View key={p.id} className="result__stack-item" style={{ marginLeft: i === 0 ? 0 : '-7px', zIndex: 9 - i }}>
          <Avatar name={p.displayName} src={p.avatarUrl} size={24} ring />
        </View>
      ))}
    </View>
  );

  const switcherNode = (
    <View className="switcher">
      <View className={`switcher__arrow ${hasPrev ? '' : 'switcher__arrow--off'}`} onClick={goPrev}>
        ‹
      </View>
      <Text className="switcher__label">
        第 {roundIdx + 1} 轮 <Text className="switcher__total">/ 共 {total} 轮</Text>
      </Text>
      <View className={`switcher__arrow switcher__arrow--next ${hasNext ? '' : 'switcher__arrow--off'}`} onClick={goNext}>
        ›
      </View>
    </View>
  );

  return (
    <PageFrame title="对阵看板" activeTab="home" subHeader={switcherNode}>
      <View className="board">
        <View className="board__inner">
        {/* 本场结算入口（有已结束对局时） */}
        {finishedCount > 0 ? (
          <View className="board__summary" onClick={goSummary}>
            <Text className="board__summary-txt">本场结算</Text>
            <Text className="board__summary-arrow">›</Text>
          </View>
        ) : null}

        {/* 当前轮各场地 */}
        {round && round.matches.length > 0 ? (
          round.matches.map((m) => {
            const done = m.status === MatchStatus.FINISHED;
            const ongoing = m.status === MatchStatus.ONGOING;
            const aWin = m.winner === Team.A;
            const bWin = m.winner === Team.B;
            return (
              <View key={m.id} className={`court ${done ? '' : 'court--active'}`}>
                <View className="court__head">
                  <Text className="court__title">场地 {m.courtNo}</Text>
                  {done ? (
                    <Tag text="已结束" tone="muted" />
                  ) : ongoing ? (
                    <Tag text="● 进行中" tone="success" />
                  ) : (
                    <Tag text="待开始" tone="primary" />
                  )}
                </View>

                {done ? (
                  <View className="result">
                    {renderStack(m.teamA.participants)}
                    <Text className="result__score score">
                      <Text className={aWin ? 'result__num--win' : 'result__num--lose'}>{m.scoreA ?? 0}</Text>
                      <Text className="result__colon"> : </Text>
                      <Text className={bWin ? 'result__num--win' : 'result__num--lose'}>{m.scoreB ?? 0}</Text>
                    </Text>
                    {renderStack(m.teamB.participants)}
                  </View>
                ) : (
                  <>
                    <View className="court__vs">
                      {renderTeam(m.teamA.participants, 'left')}
                      <Text className="court__vs-label">VS</Text>
                      {renderTeam(m.teamB.participants, 'right')}
                    </View>
                    <PrimaryButton text="▶  进入计分" onClick={() => enterScoring(m)} />
                  </>
                )}
              </View>
            );
          })
        ) : (
          <Empty text="本轮暂无对局" hint="切换其它轮次看看" />
        )}

        {/* 轮空提示 */}
        {byeNames.length > 0 ? (
          <View className="bye">
            <Text className="bye__tag">轮空</Text>
            <Text className="bye__txt">{byeNames.join('、')} 本轮休息</Text>
          </View>
        ) : null}

        <View className="board__pad" />
        </View>
      </View>
    </PageFrame>
  );
}
