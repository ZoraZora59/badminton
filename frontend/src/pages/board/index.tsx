import { Fragment, useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, {
  useRouter,
  useDidShow,
  usePullDownRefresh,
  useShareAppMessage,
  useShareTimeline,
} from '@tarojs/taro';
import {
  ActivityStatus,
  MatchStatus,
  PlayType,
  Team,
  courtLabel,
  type BoardVM,
  type RoundVM,
  type MatchVM,
  type ParticipantVM,
} from '@badminton/shared';
import { api } from '../../services/endpoints';
import { toastError } from '../../services/api';
import { useUser } from '../../store/user';
import { Avatar, Tag, PrimaryButton, Empty, Icon, PageFrame } from '../../components';
import './index.scss';

/** 「我的下一场」的三种形态；我不在这场比赛里（围观者 / 只组局不打的局长）时为 null */
type MyNextVM =
  | {
      kind: 'match';
      roundIdx: number;
      match: MatchVM;
      partners: ParticipantVM[];
      opponents: ParticipantVM[];
      /** 我这一队还缺几个人（有人中途走了、轮空席又没人可顶时会留空位） */
      missing: number;
    }
  | { kind: 'bye'; roundIdx: number; next: { roundIdx: number; courtNo: number } | null }
  | { kind: 'done'; played: number }
  | null;

/**
 * 本轮每队「应该」有几个人。
 * 有人中途离场、轮空席又没人可顶时，后端保留对局、场上留一个空位（2v2 打成 1v2），
 * 所以「队里现在几个人」不再等于「这队该有几个人」，缺几个只能按玩法算。
 * playType 拿不到（前端先于后端上线）时不硬当双打——那会把单打的每一场都误标成「缺 1 人」，
 * 退回按本轮实际最多人的一队推断：宁可少画一个空位，也不凭空造缺口。
 */
function teamSizeOf(r: RoundVM): number {
  if (r.playType === PlayType.SINGLES) return 1;
  if (r.playType === PlayType.DOUBLES) return 2;
  let max = 0;
  r.matches.forEach((mt) => {
    max = Math.max(max, mt.teamA.participants.length, mt.teamB.participants.length);
  });
  return max;
}

/** 这一队缺几个人。已结束的对局恒为 0——历史就是那样打完的，别在回顾里凭空造缺口 */
function missingOf(m: MatchVM, onCourt: number, teamSize: number): number {
  if (m.status === MatchStatus.FINISHED) return 0;
  return Math.max(0, teamSize - onCourt);
}

export default function Board() {
  const router = useRouter();
  const id = Number(router.params.id);
  const user = useUser();

  const [board, setBoard] = useState<BoardVM | null>(null);
  const [roster, setRoster] = useState<ParticipantVM[]>([]);
  const [roundIdx, setRoundIdx] = useState(0);
  const [touched, setTouched] = useState(false);
  // 名单变动 / 换人：都是写操作，同一时间只允许一个在飞
  const [rosterOpen, setRosterOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [swapMode, setSwapMode] = useState(false);
  const [swapPick, setSwapPick] = useState<{ pid: number; name: string; matchId: number | null } | null>(null);

  const load = useCallback(async () => {
    try {
      // 花名册要单独取：全程轮空的人不出现在任何对阵里，光靠 board 反查不出「我」是谁。
      // 它只服务于「我的下一场」和轮空名字，拉不到就降级回对阵反查，绝不能让看板本身打不开。
      // 局长身份和场地编号都由 board 自带（hostId / courtLabels），不再多拉一次活动详情：
      // 那条请求一挂，局长就静默变成围观视图，所有编辑入口凭空消失。
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
            // 我这边缺人是「我」最该先知道的事：不然到了场上才发现三缺一
            missing: missingOf(mine, ours.length, teamSizeOf(r)),
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

  /**
   * 一轮算不算「还没打的将来」：有没打完的对局，或者一场对局都没有。
   * 空轮次是「没人可顶 → 整场撤掉」留下的坑，它仍属将来——若把它当历史，
   * 4 人 1 片场走掉一个之后全场就再没有「后续对局」，名单入口整块消失，
   * 局长既看不到谁走了、也没法把人换回来（开打后没有重新分组的入口）。
   */
  const isUpcomingRound = (r: RoundVM) =>
    r.matches.length === 0 || r.matches.some((mt) => mt.status !== MatchStatus.FINISHED);

  /** 全场赛程有没有打完——全打完了就没有「后续对局」可换，名单调整也就没有意义 */
  const hasPending = useMemo(() => !!board?.rounds.some(isUpcomingRound), [board]);

  /**
   * 花名册 + 「还在不在场上」。
   * 在场 = 还出现在某个没打完的对局里，或还挂在某个没打完轮次的轮空名单里；
   * 两处都找不到 = 已经被换下场（提前走了），可以「TA 回来了」把人放回轮空池。
   */
  const rosterRows = useMemo(() => {
    const active = new Set<number>();
    board?.rounds.forEach((r) => {
      // 一轮里只要还没打完，它的轮空名单就仍然是「等着上场的人」
      const roundOpen = isUpcomingRound(r);
      r.matches.forEach((mt) => {
        if (mt.status === MatchStatus.FINISHED) return;
        [...mt.teamA.participants, ...mt.teamB.participants].forEach((p) => active.add(p.id));
      });
      if (roundOpen) r.byeParticipantIds.forEach((pid) => active.add(pid));
    });
    return roster.map((p) => ({ p, active: active.has(p.id) }));
  }, [board, roster]);

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

  /**
   * 场地显示号：引擎里的 courtNo 恒为 1..N，球馆给的是「5、6、12 号场」。
   * 由 board 透传；没填时 courtLabel 自动回落成序号。
   */
  const cl = (courtNo: number) => courtLabel(board.courtLabels, courtNo);

  // 局长身份看板自带（hostId）；user 还没加载完 / 不是本人时一律按围观者渲染，编辑入口都不出现
  const isHost = !!user && board.hostId === user.id;
  // 已结束/已取消的球局改名单没有意义，入口整块不渲染，不留空壳按钮
  const canEditRoster = isHost && board.status === ActivityStatus.ONGOING;
  const roundOpen = !!round && round.matches.some((m) => m.status !== MatchStatus.FINISHED);
  // 当前轮每队应有几人：判断场上有没有空位要靠它（双打 2、单打 1）
  const roundTeamSize = round ? teamSizeOf(round) : 0;
  // 后端的 swap 只在同一轮内生效，所以本轮全打完了就不给换人
  const swapping = canEditRoster && swapMode && roundOpen;
  const leftCount = rosterRows.filter((r) => !r.active).length;

  const finishedCount = board.rounds.reduce(
    (acc, r) => acc + r.matches.filter((m) => m.status === MatchStatus.FINISHED).length,
    0,
  );

  const byeList =
    round?.byeParticipantIds.map((pid) => ({ pid, name: nameMap.get(pid)?.displayName ?? '球友' })) ?? [];

  /**
   * 全场还空着几个位子。人走了、轮空席又没人可顶时后端不撤场，位子留着等人回来补，
   * 局长在名单入口上就该看见「还差几个人」，而不是逐轮翻场地卡去数。
   */
  const openSlots = board.rounds.reduce((acc, r) => {
    const size = teamSizeOf(r);
    return (
      acc +
      r.matches.reduce(
        (s, m) =>
          s + missingOf(m, m.teamA.participants.length, size) + missingOf(m, m.teamB.participants.length, size),
        0,
      )
    );
  }, 0);

  /** 是不是「我」——我不在参赛名单里时恒为 false，全页高亮自动消失 */
  const isMe = (p: ParticipantVM) => myPid != null && p.id === myPid;
  const isMePid = (pid: number) => myPid != null && pid === myPid;

  const goPrev = () => {
    if (!hasPrev) return;
    setTouched(true);
    setSwapPick(null);
    setRoundIdx((i) => i - 1);
  };
  const goNext = () => {
    if (!hasNext) return;
    setTouched(true);
    setSwapPick(null);
    setRoundIdx((i) => i + 1);
  };
  const jumpRound = (i: number) => {
    setTouched(true);
    setSwapPick(null);
    setRoundIdx(i);
  };

  /** 写操作回来的就是新看板，直接换掉；花名册跟着重拉，避免「已离场」状态和看板对不上 */
  const applyBoard = async (vm: BoardVM) => {
    setBoard(vm);
    setRoundIdx((prev) => Math.max(0, Math.min(prev, vm.rounds.length - 1)));
    setSwapPick(null);
    const ps = await api.listParticipants(id).catch(() => null);
    if (ps) setRoster(ps);
  };

  /** 「TA 要走了」：会改后续赛程，必须先说清后果再动手 */
  const onWithdraw = async (p: ParticipantVM) => {
    if (acting) return;
    const res = await Taro.showModal({
      title: `${p.displayName} 要走了？`,
      content:
        '会把 TA 从后面还没打的对局里换下来，由轮空的球友顶上；没人可顶就先在场上留个空位，等有人回来补，对局不会被撤掉。已经打完的比分不受影响。',
      confirmText: '确认换下',
      cancelText: '再想想',
    });
    if (!res.confirm) return;
    setActing(true);
    try {
      await applyBoard(await api.withdrawParticipant(id, p.id));
      Taro.showToast({ title: '已换下场', icon: 'none' });
    } catch (e) {
      toastError(e);
    } finally {
      setActing(false);
    }
  };

  /** 「TA 回来了」：只是把人放回后续轮次的轮空池，不动已排好的对阵，不用二次确认 */
  const onRejoin = async (p: ParticipantVM) => {
    if (acting) return;
    setActing(true);
    try {
      await applyBoard(await api.rejoinParticipant(id, p.id));
      Taro.showToast({ title: '已回到轮空席', icon: 'none' });
    } catch (e) {
      toastError(e);
    } finally {
      setActing(false);
    }
  };

  /**
   * 本轮换人：选中一人，再点另一人（含轮空席）完成对调。
   * 后端只按「这一场对局所在的那一轮」处理，所以锚点用先选中那位所在的对局；
   * 两个都是轮空席时没有场上位置可换，直接提示。
   */
  const onTapPlayer = async (pid: number, name: string, matchId: number | null) => {
    if (!swapping || acting) return;
    if (!swapPick) {
      setSwapPick({ pid, name, matchId });
      return;
    }
    if (swapPick.pid === pid) {
      setSwapPick(null);
      return;
    }
    const anchor = swapPick.matchId ?? matchId;
    if (anchor == null) {
      Taro.showToast({ title: '至少选一个场上的人', icon: 'none' });
      return;
    }
    setActing(true);
    try {
      await applyBoard(await api.swap(anchor, swapPick.pid, pid));
      Taro.showToast({ title: '本轮已换人', icon: 'none' });
    } catch (e) {
      toastError(e);
      setSwapPick(null);
    } finally {
      setActing(false);
    }
  };

  const enterScoring = (m: MatchVM) => {
    Taro.navigateTo({ url: `/pages/scoring/index?matchId=${m.id}&activityId=${id}` });
  };
  const goSummary = () => {
    Taro.navigateTo({ url: `/pages/summary/index?id=${id}` });
  };

  /**
   * 场上的空位。人走了、轮空席又没人可顶时后端不再撤场，而是把位子留着——
   * 虚线圈 + 「空位」和活动详情里的「+1 影位」是同一套视觉语言，一眼看出这不是一场正常对局。
   * 空位没有 participantId，换人时点它什么也换不了，所以它永远不可点。
   */
  const renderSlots = (missing: number, align: 'left' | 'right') =>
    Array.from({ length: missing }, (_, i) => (
      <View key={`slot-${align}-${i}`} className="court__slot">
        {align === 'left' ? (
          <>
            <View className="court__slot-av">＋</View>
            <Text className="court__slot-name">空位</Text>
          </>
        ) : (
          <>
            <Text className="court__slot-name">空位</Text>
            <View className="court__slot-av">＋</View>
          </>
        )}
      </View>
    ));

  const renderTeam = (
    participants: ParticipantVM[],
    align: 'left' | 'right',
    matchId: number,
    missing: number,
  ) => (
    <View className={`court__team court__team--${align}`}>
      {participants.map((p) => (
        <View
          key={p.id}
          className={[
            'court__player',
            isMe(p) ? 'court__player--me' : '',
            swapping ? 'court__player--tap' : '',
            swapPick?.pid === p.id ? 'court__player--pick' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={swapping ? () => onTapPlayer(p.id, p.displayName, matchId) : undefined}
        >
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
      {renderSlots(missing, align)}
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

  /**
   * 赛程总览里的名字串：拆成节点渲染，才能把「我」单独标出来。
   * missing 是这队还缺的人数，用「空位」占住——一行里看得出这场是 1v2 还是 2v2。
   */
  const renderSchedNames = (participants: ParticipantVM[], missing: number) => (
    <>
      {participants.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 ? '/' : ''}
          <Text className={isMe(p) ? 'sched__name--me' : ''}>{p.displayName}</Text>
        </Fragment>
      ))}
      {Array.from({ length: missing }, (_, i) => (
        <Fragment key={`gap-${i}`}>
          {participants.length + i > 0 ? '/' : ''}
          <Text className="sched__gap">空位</Text>
        </Fragment>
      ))}
    </>
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
                  第 {myNext.next.roundIdx + 1} 轮 · 场地 {cl(myNext.next.courtNo)} ›
                </Text>
              </View>
            </View>
          ) : (
            <Text className="mine__hint">这轮不上场，场边歇一会儿</Text>
          )}
        </View>
      );
    }
    const { match, partners, opponents, missing } = myNext;
    return (
      <View className="mine">
        <View className="mine__deco" />
        <Text className="mine__label">我的下一场</Text>
        <View className="mine__title">
          <Text className="mine__round" onClick={() => jumpRound(myNext.roundIdx)}>
            第 {myNext.roundIdx + 1} 轮 ›
          </Text>
          <Text className="mine__court">场地 {cl(match.courtNo)}</Text>
        </View>
        <View className="mine__lines">
          {/* 我这边缺人时也要出「搭档」这一行：没搭档才更要说清是缺人，而不是让它整行消失 */}
          {partners.length > 0 || missing > 0 ? (
            <View className="mine__line">
              <Text className="mine__line-k">搭档</Text>
              <Text className="mine__line-v">
                {partners.map((p) => p.displayName).join('、')}
                {missing > 0 ? `${partners.length > 0 ? ' · ' : ''}还缺 ${missing} 人` : ''}
              </Text>
            </View>
          ) : null}
          <View className="mine__line">
            <Text className="mine__line-k">对手</Text>
            <Text className="mine__line-v">{opponents.map((p) => p.displayName).join('、')}</Text>
          </View>
        </View>
        {/* 缺人不拦着开打（三缺一也能打），但得让人知道这个坑谁来填 */}
        {missing > 0 ? (
          <Text className="mine__hint">
            {canEditRoster ? '你这边还缺人，在「有人要走 / 有人来了」里让球友归队即可补上' : '你这边还缺人，等球友归队会自动补上'}
          </Text>
        ) : null}
        <View className="mine__btn" onClick={() => enterScoring(match)}>
          ▶  进入计分
        </View>
      </View>
    );
  })();

  // 本场名单弹层（仅局长）：一行一个人，直接改「TA 要走了 / TA 回来了」
  const rosterNode =
    canEditRoster && rosterOpen ? (
      <View className="rsheet">
        <View className="rsheet__mask" onClick={() => setRosterOpen(false)} />
        <View className="rsheet__panel">
          <View className="rsheet__handle" />
          <View className="rsheet__head">
            <View className="rsheet__head-txt">
              <Text className="rsheet__title">本场名单</Text>
              <Text className="rsheet__sub">
                {!hasPending
                  ? '赛程已全部打完，改名单不再影响对局'
                  : openSlots > 0
                    ? `场上还空着 ${openSlots} 个位子，点「TA 回来了」就会补上去`
                    : '换下的人由轮空球友顶替，打完的比分不受影响'}
              </Text>
            </View>
            <View className="rsheet__close" onClick={() => setRosterOpen(false)}>
              ✕
            </View>
          </View>

          {rosterRows.length === 0 ? (
            <Empty text="没拉到本场名单" hint="关掉这里下拉刷新再试一次" />
          ) : (
            <ScrollView scrollY className="rsheet__list">
              {rosterRows.map(({ p, active }) => (
                <View key={p.id} className="rsheet__row">
                  <Avatar name={p.displayName} src={p.avatarUrl} size={32} />
                  <View className="rsheet__info">
                    <View className="rsheet__nameline">
                      <Text className={`rsheet__name ${isMe(p) ? 'rsheet__name--me' : ''}`}>{p.displayName}</Text>
                      {p.isGuest ? <Tag text="临时" tone="muted" /> : null}
                    </View>
                    <Text className={`rsheet__state ${active ? '' : 'rsheet__state--off'}`}>
                      {!hasPending ? '赛程已打完' : active ? '在场上' : '已离场'}
                    </Text>
                  </View>
                  {/* 全部打完就没有「后续对局」可改，这时不给按钮，避免点了什么都不会发生 */}
                  {hasPending ? (
                    <View
                      className={[
                        'rsheet__act',
                        active ? '' : 'rsheet__act--back',
                        acting ? 'rsheet__act--busy' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => (active ? onWithdraw(p) : onRejoin(p))}
                    >
                      {active ? 'TA 要走了' : 'TA 回来了'}
                    </View>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    ) : null;

  return (
    <PageFrame title="对阵看板" activeTab="home" subHeader={switcherNode} overlay={rosterNode}>
      <View className="board">
        <View className="board__inner">
        {mineNode}

        {/* 名单变动入口（仅局长）：「老李 9 点得走」「隔壁球友临时来了」都在这里改。
            全场都打完了就没有「后续对局」可动，入口整块收起，不给点了没反应的按钮 */}
        {canEditRoster && hasPending ? (
          <View className="rbar" onClick={() => setRosterOpen(true)}>
            <Icon name="users" size={16} color="#0b5e34" />
            <View className="rbar__body">
              <Text className="rbar__title">有人要走 / 有人来了</Text>
              <Text className="rbar__sub">
                {rosterRows.length === 0
                  ? '花名册没拉到，下拉刷新再试'
                  : `本场 ${rosterRows.length} 人${leftCount > 0 ? ` · ${leftCount} 人已离场` : ''}${
                      openSlots > 0 ? ` · 场上缺 ${openSlots} 人` : ''
                    }`}
              </Text>
            </View>
            <Text className="rbar__arrow">›</Text>
          </View>
        ) : null}

        {/* 本场结算入口（有已结束对局时） */}
        {finishedCount > 0 ? (
          <View className="board__summary" onClick={goSummary}>
            <Text className="board__summary-txt">本场结算</Text>
            <Text className="board__summary-arrow">›</Text>
          </View>
        ) : null}

        {/* 本轮换人（仅局长）：后端 swap 只在同一轮内生效，文案也只承诺本轮 */}
        {canEditRoster && roundOpen ? (
          <View className="swapbar">
            <View
              className={`swapbar__btn ${swapMode ? 'swapbar__btn--on' : ''}`}
              onClick={() => {
                setSwapMode((v) => !v);
                setSwapPick(null);
              }}
            >
              {swapMode ? '完成' : '本轮换人'}
            </View>
            <Text className="swapbar__hint">
              {swapMode
                ? swapPick
                  ? `已选 ${swapPick.name}，再点另一人完成对调`
                  : '点一名球友，再点另一人（含轮空席）对调'
                : '只调整本轮，不影响其它轮次'}
            </Text>
          </View>
        ) : null}

        {/* 当前轮各场地 */}
        {round && round.matches.length > 0 ? (
          round.matches.map((m) => {
            const done = m.status === MatchStatus.FINISHED;
            const ongoing = m.status === MatchStatus.ONGOING;
            const aWin = m.winner === Team.A;
            const bWin = m.winner === Team.B;
            // 场上空位：人走了没人顶，位子留着等人回来补（已结束的对局恒为 0）
            const missA = missingOf(m, m.teamA.participants.length, roundTeamSize);
            const missB = missingOf(m, m.teamB.participants.length, roundTeamSize);
            const missTotal = missA + missB;
            return (
              <View key={m.id} className={`court ${done ? '' : 'court--active'}`}>
                <View className="court__head">
                  <Text className="court__title">场地 {cl(m.courtNo)}</Text>
                  <View className="court__tags">
                    {missTotal > 0 ? <Tag text={`缺 ${missTotal} 人`} tone="warn" /> : null}
                    {done ? (
                      <Tag text="已结束" tone="muted" />
                    ) : ongoing ? (
                      <Tag text="● 进行中" tone="success" />
                    ) : (
                      <Tag text="待开始" tone="primary" />
                    )}
                  </View>
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
                      {renderTeam(m.teamA.participants, 'left', Number(m.id), missA)}
                      <Text className="court__vs-label">VS</Text>
                      {renderTeam(m.teamB.participants, 'right', Number(m.id), missB)}
                    </View>
                    {/* 缺人不拦着开打（三缺一照样能打、比分照记），但要说清这个坑怎么填：
                        局长点一下直接开本场名单；普通球友只是知道在等人，不给点不动的按钮 */}
                    {missTotal > 0 ? (
                      canEditRoster ? (
                        <View className="court__gap court__gap--act" onClick={() => setRosterOpen(true)}>
                          <Text className="court__gap-txt">
                            这场少 {missTotal} 人 · 让球友归队或把人换回来，位子会自动补上
                          </Text>
                          <Text className="court__gap-arrow">›</Text>
                        </View>
                      ) : (
                        <View className="court__gap">
                          <Text className="court__gap-txt">这场少 {missTotal} 人 · 位子留着，等球友归队补上</Text>
                        </View>
                      )
                    ) : null}
                    <PrimaryButton text="▶  进入计分" onClick={() => enterScoring(m)} />
                  </>
                )}
              </View>
            );
          })
        ) : round && round.byeParticipantIds.length > 0 ? (
          // 空轮次。现在缺人只留空位不撤场，只有「一队人被摘空」才会走到这里，少见但仍可达。
          // 写「暂无对局」等于没说，局长会以为是加载问题；直接讲清楚是人不够，以及怎么才能继续打
          <Empty text="本轮没排上对局" hint="场上人数不够开一场，等有人回来再打" />
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

        {/* 换人时轮空席要能点：让轮空的人顶替场上任意一位 */}
        {swapping && byeList.length > 0 ? (
          <View className="bye__picks">
            {byeList.map((b) => (
              <View
                key={b.pid}
                className={`bye__pick ${swapPick?.pid === b.pid ? 'bye__pick--on' : ''}`}
                onClick={() => onTapPlayer(b.pid, b.name, null)}
              >
                <Text className="bye__pick-name">{b.name}</Text>
              </View>
            ))}
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
              // 每轮玩法可能不同（这一轮双打、那一轮单打），缺几人要按各自那一轮算
              const size = teamSizeOf(r);
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
                        <Text className="sched__court num">场{cl(m.courtNo)}</Text>
                        <Text className="sched__names">
                          {renderSchedNames(m.teamA.participants, missingOf(m, m.teamA.participants.length, size))}
                          <Text className="sched__vs"> vs </Text>
                          {renderSchedNames(m.teamB.participants, missingOf(m, m.teamB.participants.length, size))}
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
