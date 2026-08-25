import { Fragment, useState, useCallback, useMemo } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, {
  useRouter,
  useDidShow,
  usePullDownRefresh,
  useShareAppMessage,
  useShareTimeline,
} from '@tarojs/taro';
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
import { useUser } from '../../store/user';
import { Avatar, Tag, PrimaryButton, Empty, PageFrame } from '../../components';
import './index.scss';

/** 「我的下一场」的三种形态；我不在这场比赛里（围观者 / 只组局不打的局长）时为 null */
type MyNextVM =
  | { kind: 'match'; roundIdx: number; match: MatchVM; partners: ParticipantVM[]; opponents: ParticipantVM[] }
  | { kind: 'bye'; roundIdx: number; next: { roundIdx: number; courtNo: number } | null }
  | { kind: 'done'; played: number }
  | null;

export default function Board() {
  const router = useRouter();
  const id = Number(router.params.id);
  const user = useUser();

  const [board, setBoard] = useState<BoardVM | null>(null);
  const [roster, setRoster] = useState<ParticipantVM[]>([]);
  const [roundIdx, setRoundIdx] = useState(0);
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    try {
      // 花名册要单独取：全程轮空的人不出现在任何对阵里，光靠 board 反查不出「我」是谁。
      // 它只服务于「我的下一场」和轮空名字，拉不到就降级回对阵反查，绝不能让看板本身打不开。
      const [b, ps] = await Promise.all([
        api.getBoard(id),
        api.listParticipants(id).catch(() => [] as ParticipantVM[]),
      ]);
      setBoard(b);
      setRoster(ps);
      // 首次进入定位到当前轮；返回刷新时保留用户已切换的轮次
      setRoundIdx((prev) => (touched ? Math.min(prev, b.rounds.length - 1) : Math.max(0, b.currentRound - 1)));
    } catch (e) {
      toastError(e);
    }
  }, [id, touched]);

  useDidShow(() => {
    load();
  });

  // 三片场地并行，别人计完分这边不会动：下拉即可刷新，不用退出去再进来
  usePullDownRefresh(async () => {
    await load();
    Taro.stopPullDownRefresh();
  });

  // 对阵看板可围观：转发/朋友圈带上活动 id，好友点开直接看排兵
  useShareAppMessage(() => ({
    title: board ? `对阵看板 · 第 ${board.currentRound}/${board.totalRounds} 轮，点我围观` : '对阵看板 · 点我围观',
    path: `/pages/board/index?id=${id}`,
  }));
  useShareTimeline(() => ({
    title: board ? `羽毛球对阵看板 · 第 ${board.currentRound}/${board.totalRounds} 轮` : '羽毛球对阵看板',
    query: `id=${id}`,
  }));

  // 全量参赛者名表：用于把 byeParticipantIds 还原成名字
  const nameMap = useMemo(() => {
    const m = new Map<number, ParticipantVM>();
    board?.rounds.forEach((r) =>
      r.matches.forEach((mt) => {
        [...mt.teamA.participants, ...mt.teamB.participants].forEach((p) => m.set(p.id, p));
      }),
    );
    // 轮空的人不在任何对阵里，没有花名册兜底，byeNames 只能显示成「球友」
    roster.forEach((p) => {
      if (!m.has(p.id)) m.set(p.id, p);
    });
    return m;
  }, [board, roster]);

  /**
   * 「我」在本场的 participantId。优先查花名册——全程轮空的人（单轮赛程且人数超过场地容量时必现）
   * 压根不出现在任何对阵里，只扫 matches 会把他当成围观者，而他恰恰是最需要知道自己上不上场的人。
   * 花名册拉不到时退回对阵反查，至少上过场的人不受影响。Guest 的 userId 为 null，不会误命中。
   */
  const myPid = useMemo(() => {
    if (!user) return null;
    const inRoster = roster.find((p) => p.userId === user.id);
    if (inRoster) return inRoster.id;
    if (!board) return null;
    for (const r of board.rounds) {
      for (const mt of r.matches) {
        const hit = [...mt.teamA.participants, ...mt.teamB.participants].find((p) => p.userId === user.id);
        if (hit) return hit.id;
      }
    }
    return null;
  }, [board, roster, user]);

  /**
   * 「我下轮打不打、几号场、跟谁」——整晚被问得最多的一句话。
   * 一次扫描同时收三样：已打完的场次、第一场未结束的我方对局、第一次轮空。
   * 轮空排在真实对局之前时给轮空卡，但必须把后面那场一起带上：
   * 卡片叫「我的下一场」，只说「这轮歇着」等于把问题答了一半。
   */
  const myNext = useMemo<MyNextVM>(() => {
    if (!board || myPid == null) return null;
    let played = 0;
    let firstMatch: Extract<MyNextVM, { kind: 'match' }> | null = null;
    let firstByeIdx = -1;
    for (let i = 0; i < board.rounds.length; i += 1) {
      const r = board.rounds[i];
      const mine = r.matches.find((mt) =>
        [...mt.teamA.participants, ...mt.teamB.participants].some((p) => p.id === myPid),
      );
      if (mine && mine.status === MatchStatus.FINISHED) {
        played += 1;
        continue;
      }
      if (mine) {
        if (!firstMatch) {
          const inA = mine.teamA.participants.some((p) => p.id === myPid);
          const ours = inA ? mine.teamA.participants : mine.teamB.participants;
          const theirs = inA ? mine.teamB.participants : mine.teamA.participants;
          firstMatch = {
            kind: 'match',
            roundIdx: i,
            match: mine,
            partners: ours.filter((p) => p.id !== myPid),
            opponents: theirs,
          };
        }
        continue;
      }
      // 本轮没我的对局：这一轮还没打完 + 我在轮空名单里 = 先歇一轮
      const roundDone = r.matches.length > 0 && r.matches.every((mt) => mt.status === MatchStatus.FINISHED);
      if (firstByeIdx < 0 && !roundDone && r.byeParticipantIds.includes(myPid)) firstByeIdx = i;
    }
    if (firstByeIdx >= 0 && (!firstMatch || firstByeIdx < firstMatch.roundIdx)) {
      return {
        kind: 'bye',
        roundIdx: firstByeIdx,
        next: firstMatch ? { roundIdx: firstMatch.roundIdx, courtNo: firstMatch.match.courtNo } : null,
      };
    }
    return firstMatch ?? { kind: 'done', played };
  }, [board, myPid]);

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

  const byeList =
    round?.byeParticipantIds.map((pid) => ({ pid, name: nameMap.get(pid)?.displayName ?? '球友' })) ?? [];

  /** 是不是「我」——我不在参赛名单里时恒为 false，全页高亮自动消失 */
  const isMe = (p: ParticipantVM) => myPid != null && p.id === myPid;
  const isMePid = (pid: number) => myPid != null && pid === myPid;

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
  const jumpRound = (i: number) => {
    setTouched(true);
    setRoundIdx(i);
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
        <View key={p.id} className={`court__player ${isMe(p) ? 'court__player--me' : ''}`}>
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
      {participants.map((p, i) => {
        const me = isMe(p);
        return (
          <View
            key={p.id}
            className={`result__stack-item ${me ? 'result__stack-item--me' : ''}`}
            style={{ marginLeft: i === 0 ? 0 : '-7px', zIndex: me ? 10 : 9 - i }}
          >
            <Avatar name={p.displayName} src={p.avatarUrl} size={24} ring />
          </View>
        );
      })}
    </View>
  );

  /** 赛程总览里的名字串：拆成节点渲染，才能把「我」单独标出来 */
  const renderSchedNames = (participants: ParticipantVM[]) =>
    participants.map((p, i) => (
      <Fragment key={p.id}>
        {i > 0 ? '/' : ''}
        <Text className={isMe(p) ? 'sched__name--me' : ''}>{p.displayName}</Text>
      </Fragment>
    ));

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

  // 「我的下一场」：整晚问得最多的一句话，放在页面最上面，我不在名单里就整块不渲染
  const mineNode = (() => {
    if (!myNext) return null;
    if (myNext.kind === 'done') {
      if (myNext.played <= 0) return null;
      return (
        <View className="mine">
          <View className="mine__deco" />
          <Text className="mine__label">我的今天</Text>
          <View className="mine__title">
            <Text className="mine__court">
              你今天打了 <Text className="mine__num num">{myNext.played}</Text> 场
            </Text>
          </View>
          <Text className="mine__hint">你的对局都打完了</Text>
        </View>
      );
    }
    if (myNext.kind === 'bye') {
      return (
        <View className="mine">
          <View className="mine__deco" />
          <Text className="mine__label">我的下一场</Text>
          <View className="mine__title">
            <Text className="mine__round" onClick={() => jumpRound(myNext.roundIdx)}>
              第 {myNext.roundIdx + 1} 轮 ›
            </Text>
            <Text className="mine__court">轮空休息</Text>
          </View>
          {myNext.next ? (
            <View className="mine__lines">
              <View className="mine__line">
                <Text className="mine__line-k">下一场</Text>
                <Text
                  className="mine__line-v"
                  onClick={() => myNext.next && jumpRound(myNext.next.roundIdx)}
                >
                  第 {myNext.next.roundIdx + 1} 轮 · 场地 {myNext.next.courtNo} ›
                </Text>
              </View>
            </View>
          ) : (
            <Text className="mine__hint">这轮不上场，场边歇一会儿</Text>
          )}
        </View>
      );
    }
    const { match, partners, opponents } = myNext;
    return (
      <View className="mine">
        <View className="mine__deco" />
        <Text className="mine__label">我的下一场</Text>
        <View className="mine__title">
          <Text className="mine__round" onClick={() => jumpRound(myNext.roundIdx)}>
            第 {myNext.roundIdx + 1} 轮 ›
          </Text>
          <Text className="mine__court">场地 {match.courtNo}</Text>
        </View>
        <View className="mine__lines">
          {partners.length > 0 ? (
            <View className="mine__line">
              <Text className="mine__line-k">搭档</Text>
              <Text className="mine__line-v">{partners.map((p) => p.displayName).join('、')}</Text>
            </View>
          ) : null}
          <View className="mine__line">
            <Text className="mine__line-k">对手</Text>
            <Text className="mine__line-v">{opponents.map((p) => p.displayName).join('、')}</Text>
          </View>
        </View>
        <View className="mine__btn" onClick={() => enterScoring(match)}>
          ▶  进入计分
        </View>
      </View>
    );
  })();

  return (
    <PageFrame title="对阵看板" activeTab="home" subHeader={switcherNode}>
      <View className="board">
        <View className="board__inner">
        {mineNode}

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
        {byeList.length > 0 ? (
          <View className="bye">
            <Text className="bye__tag">轮空</Text>
            <Text className="bye__txt">
              {byeList.map((b, i) => (
                <Fragment key={b.pid}>
                  {i > 0 ? '、' : ''}
                  <Text className={isMePid(b.pid) ? 'bye__me' : ''}>{b.name}</Text>
                </Fragment>
              ))}
              {' 本轮休息'}
            </Text>
          </View>
        ) : null}

        {/* 完整赛程总览：开赛前一屏不只有当前轮，球友可直接看每轮跟谁打、在哪片、哪轮休息 */}
        {board.rounds.length > 1 ? (
          <View className="sched">
            <View className="sched__head">
              <Text className="sched__title">完整赛程</Text>
              <Text className="sched__hint">点任意轮可切换查看</Text>
            </View>
            {board.rounds.map((r, i) => {
              const allDone = r.matches.length > 0 && r.matches.every((m) => m.status === MatchStatus.FINISHED);
              const anyLive = r.matches.some((m) => m.status === MatchStatus.ONGOING);
              const viewing = i === roundIdx;
              const byes = r.byeParticipantIds.map((pid) => ({ pid, name: nameMap.get(pid)?.displayName ?? '球友' }));
              return (
                <View
                  key={r.index}
                  className={`sched__round ${viewing ? 'sched__round--on' : ''}`}
                  onClick={() => jumpRound(i)}
                >
                  <View className="sched__round-head">
                    <Text className="sched__round-name">第 {i + 1} 轮</Text>
                    {allDone ? <Tag text="已打完" tone="muted" /> : anyLive ? <Tag text="● 进行中" tone="success" /> : null}
                  </View>
                  {r.matches.map((m) => {
                    const done = m.status === MatchStatus.FINISHED;
                    return (
                      <View key={String(m.id)} className="sched__match">
                        <Text className="sched__court num">场{m.courtNo}</Text>
                        <Text className="sched__names">
                          {renderSchedNames(m.teamA.participants)}
                          <Text className="sched__vs"> vs </Text>
                          {renderSchedNames(m.teamB.participants)}
                        </Text>
                        {done ? (
                          <Text className="sched__score num">
                            <Text className={m.winner === Team.A ? 'sched__score--win' : ''}>{m.scoreA ?? 0}</Text>
                            <Text className="sched__score-colon">:</Text>
                            <Text className={m.winner === Team.B ? 'sched__score--win' : ''}>{m.scoreB ?? 0}</Text>
                          </Text>
                        ) : m.status === MatchStatus.ONGOING ? (
                          <Text className="sched__live">●</Text>
                        ) : null}
                      </View>
                    );
                  })}
                  {byes.length > 0 ? (
                    <Text className="sched__bye">
                      轮空 ·{' '}
                      {byes.map((b, bi) => (
                        <Fragment key={b.pid}>
                          {bi > 0 ? '、' : ''}
                          <Text className={isMePid(b.pid) ? 'sched__name--me' : ''}>{b.name}</Text>
                        </Fragment>
                      ))}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        <View className="board__pad" />
        </View>
      </View>
    </PageFrame>
  );
}
