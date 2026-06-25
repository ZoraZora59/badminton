import { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Picker } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';
import {
  PlayType,
  GroupMode,
  RotationKind,
  type ParticipantVM,
  type GroupingScheduleVM,
  type MatchVM,
  type MatchTeamVM,
} from '@badminton/shared';
import { api } from '../../services/endpoints';
import { toastError } from '../../services/api';
import { Avatar, Tag, PrimaryButton, Empty } from '../../components';
import './index.scss';

// 与建局页「场地数」上限保持一致（1-12），避免 picker indexOf 越界
const COURT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ROUND_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const clampCourt = (n: number) => Math.min(12, Math.max(1, n));

const STEPS = ['选人', '玩法', '模式', '设置', '看板'];

const MODE_DESC: Record<string, string> = {
  BALANCED: '按水平把每片场地两队配得势均力敌，适合水平参差、想打得公平。',
  AMERICANO: '每轮系统换搭档与对手、尽量不重复，个人积分累计，适合多认识人。',
  MEXICANO: '按当前积分动态配对、强弱搭配，越打越平衡刺激，适合个人天梯。',
};

export default function Grouping() {
  const router = useRouter();
  const id = Number(router.params.id);

  // 向导步骤 1..5
  const [step, setStep] = useState(1);

  // 参赛池 + 选人
  const [participants, setParticipants] = useState<ParticipantVM[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);

  // 设置
  const [playType, setPlayType] = useState<PlayType>(PlayType.DOUBLES);
  const [mode, setMode] = useState<GroupMode>(GroupMode.BALANCED);
  const [rotation, setRotation] = useState<RotationKind>(RotationKind.AMERICANO);
  const [courtCount, setCourtCount] = useState(3);
  const [rounds, setRounds] = useState(6);
  // 混双在建局阶段设置，这里只继承活动设置、不再提供开关
  const [mixedDoubles, setMixedDoubles] = useState(false);
  // 仅首次进入用建局设置初始化向导，之后不覆盖局长的现场调整
  const seededRef = useRef(false);

  // 赛程 / 微调
  const [schedule, setSchedule] = useState<GroupingScheduleVM | null>(null);
  const [activeRound, setActiveRound] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [seed, setSeed] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, activity] = await Promise.all([api.listParticipants(id), api.getActivity(id)]);
      setParticipants(list);
      // 默认全选参赛
      setSelected((prev) => (prev.size === 0 ? new Set(list.map((p) => p.id)) : prev));
      // 用建局设置作为向导默认值（玩法/模式/场地数/混双），仅首次
      if (!seededRef.current) {
        seededRef.current = true;
        setPlayType(activity.playType);
        setMode(activity.defaultMode);
        setCourtCount(clampCourt(activity.courtCount));
        setMixedDoubles(activity.mixedDoubles ?? false);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useDidShow(() => {
    load();
  });

  const pMap = useMemo(() => {
    const m = new Map<number, ParticipantVM>();
    participants.forEach((p) => m.set(p.id, p));
    return m;
  }, [participants]);

  const selectedList = useMemo(() => participants.filter((p) => selected.has(p.id)), [participants, selected]);
  const perCourt = playType === PlayType.DOUBLES ? 4 : 2;
  // 选人这步玩法还没选（在第 2 步），只卡「成局最小人数」=2（单打即可成局）。
  // 双打需 4 人/场：第 2 步有提示、生成赛程时再校验，避免 2 人单打局卡死在第 1 步。
  const canLeaveStep1 = selectedList.length >= 2;

  const toggleSelect = (pid: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });
  };

  const runPreview = useCallback(
    async (nextSeed: number) => {
      if (selectedList.length < perCourt) {
        Taro.showToast({ title: `参赛人数不足，至少 ${perCourt} 人`, icon: 'none' });
        return;
      }
      setGenerating(true);
      try {
        const sc = await api.previewGrouping(id, {
          participantIds: selectedList.map((p) => p.id),
          playType,
          mode,
          rotation: mode === GroupMode.ROTATION ? rotation : undefined,
          courtCount,
          rounds,
          mixedDoubles: playType === PlayType.DOUBLES ? mixedDoubles : false,
          seed: nextSeed,
        });
        setSchedule(sc);
        setActiveRound(0);
        setPicked(null);
        setStep(5);
      } catch (e) {
        toastError(e);
      } finally {
        setGenerating(false);
      }
    },
    [id, selectedList, perCourt, playType, mode, rotation, courtCount, rounds, mixedDoubles]
  );

  const onGenerate = () => {
    setSeed(1);
    runPreview(1);
  };
  const onRegenerate = () => {
    const next = seed + 1;
    setSeed(next);
    runPreview(next);
  };

  // 微调：本地在 schedule 中对调两名选手（队伍内 / 轮空名单）
  const swapInRound = (sc: GroupingScheduleVM, roundIdx: number, a: number, b: number): GroupingScheduleVM => {
    const round = sc.rounds[roundIdx];
    if (!round) return sc;
    const replace = (x: number) => (x === a ? b : x === b ? a : x);
    const mapTeam = (t: MatchTeamVM): MatchTeamVM => ({
      ...t,
      participants: t.participants.map((p) => (p.id === a ? pMap.get(b)! : p.id === b ? pMap.get(a)! : p)),
    });
    const newRound = {
      ...round,
      matches: round.matches.map((m): MatchVM => ({ ...m, teamA: mapTeam(m.teamA), teamB: mapTeam(m.teamB) })),
      byeParticipantIds: round.byeParticipantIds.map(replace),
    };
    const newRounds = sc.rounds.slice();
    newRounds[roundIdx] = newRound;
    return { ...sc, rounds: newRounds };
  };

  const onTapPlayer = (pid: number) => {
    if (!schedule) return;
    if (picked === null) {
      setPicked(pid);
      return;
    }
    if (picked === pid) {
      setPicked(null);
      return;
    }
    setSchedule(swapInRound(schedule, activeRound, picked, pid));
    setPicked(null);
    Taro.showToast({ title: '已换位', icon: 'none' });
  };

  const onConfirm = async () => {
    if (!schedule) return;
    setConfirming(true);
    try {
      await api.confirmGrouping(id, schedule);
      Taro.redirectTo({ url: `/pages/board/index?id=${id}` });
    } catch (e) {
      toastError(e);
      setConfirming(false);
    }
  };

  const round = schedule?.rounds[activeRound];
  const byeNames = (round?.byeParticipantIds ?? [])
    .map((bid) => pMap.get(bid))
    .filter((p): p is ParticipantVM => !!p);

  const mixedActive = playType === PlayType.DOUBLES && mixedDoubles;
  const mixedViolations = schedule?.metrics.mixedViolations ?? 0;

  const teamCells = (team: MatchTeamVM, side: 'a' | 'b') =>
    team.participants.map((p) => {
      const on = picked === p.id;
      return (
        <View
          key={p.id}
          className={`gp-court__cell gp-court__cell--${side} ${on ? 'gp-court__cell--on' : ''}`}
          onClick={() => onTapPlayer(p.id)}
        >
          <Avatar name={p.displayName} src={p.avatarUrl} size={20} />
          <Text className="gp-court__name">{p.displayName}</Text>
        </View>
      );
    });

  // 顶部步骤条（可回退到已完成步骤）
  const goStep = (target: number) => {
    if (target <= step) {
      setStep(target);
      setPicked(null);
    }
  };
  const stepBar = (
    <View className="gp__steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = step === n ? 'cur' : step > n ? 'done' : '';
        return (
          <View key={label} className="gp__step-wrap" onClick={() => goStep(n)}>
            <Text className={`gp__step ${state ? `gp__step--${state}` : ''}`}>
              {n}. {label}
            </Text>
            {i < STEPS.length - 1 ? <Text className="gp__sep">›</Text> : null}
          </View>
        );
      })}
    </View>
  );

  if (!loaded) {
    return (
      <View className="gp">
        {stepBar}
        <View className="gp__loading">
          <Empty text="加载参赛名单…" />
        </View>
      </View>
    );
  }

  return (
    <View className="gp">
      {stepBar}

      <ScrollView scrollY className="gp__scroll">
        <View className="gp__inner">
          {/* ===== 步骤 1：选人 ===== */}
          {step === 1 ? (
            participants.length === 0 ? (
              <View className="gp__gen">
                <Empty text="还没有已签到的参赛者" hint="先回签到页确认到场名单，再来分组" />
              </View>
            ) : (
              <>
                <View className="gp-step-head">
                  <Text className="gp-step-head__t">谁参加这次分组？</Text>
                  <Text className="gp-step-head__hint">默认全选，点头像可排除未上场的人</Text>
                </View>
                <View className="gp-pick">
                  {participants.map((p) => {
                    const on = selected.has(p.id);
                    return (
                      <View
                        key={p.id}
                        className={`gp-pick__item ${on ? 'gp-pick__item--on' : 'gp-pick__item--off'}`}
                        onClick={() => toggleSelect(p.id)}
                      >
                        <Avatar name={p.displayName} src={p.avatarUrl} size={40} ring={on} />
                        <Text className="gp-pick__name">{p.displayName}</Text>
                        {p.isGuest ? <Text className="gp-pick__guest">临时</Text> : null}
                        {on ? <View className="gp-pick__tick">✓</View> : null}
                      </View>
                    );
                  })}
                </View>
              </>
            )
          ) : null}

          {/* ===== 步骤 2：玩法 ===== */}
          {step === 2 ? (
            <>
              <View className="gp-step-head">
                <Text className="gp-step-head__t">选择玩法</Text>
                <Text className="gp-step-head__hint">已沿用建局设置，可按现场情况调整</Text>
              </View>
              <View className="gp-seg">
                <View
                  className={`gp-seg__item ${playType === PlayType.DOUBLES ? 'gp-seg__item--on' : ''}`}
                  onClick={() => setPlayType(PlayType.DOUBLES)}
                >
                  双打 <Text className="gp-seg__sub num">2v2</Text>
                </View>
                <View
                  className={`gp-seg__item ${playType === PlayType.SINGLES ? 'gp-seg__item--on' : ''}`}
                  onClick={() => setPlayType(PlayType.SINGLES)}
                >
                  单打 <Text className="gp-seg__sub num">1v1</Text>
                </View>
              </View>
              <Text className="gp-note">每片场地需要 {perCourt} 人，当前已选 {selectedList.length} 人。</Text>
            </>
          ) : null}

          {/* ===== 步骤 3：模式 ===== */}
          {step === 3 ? (
            <>
              <View className="gp-step-head">
                <Text className="gp-step-head__t">选择分组模式</Text>
                <Text className="gp-step-head__hint">已沿用建局设置，可按现场情况调整</Text>
              </View>
              <View className="gp-seg">
                <View
                  className={`gp-seg__item gp-seg__item--dark ${mode === GroupMode.BALANCED ? 'gp-seg__item--on-dark' : ''}`}
                  onClick={() => setMode(GroupMode.BALANCED)}
                >
                  智能平衡
                </View>
                <View
                  className={`gp-seg__item gp-seg__item--dark ${mode === GroupMode.ROTATION ? 'gp-seg__item--on-dark' : ''}`}
                  onClick={() => setMode(GroupMode.ROTATION)}
                >
                  自动轮转
                </View>
              </View>
              {mode === GroupMode.ROTATION ? (
                <View className="gp-seg gp-seg--sub">
                  <View
                    className={`gp-seg__item ${rotation === RotationKind.AMERICANO ? 'gp-seg__item--on' : ''}`}
                    onClick={() => setRotation(RotationKind.AMERICANO)}
                  >
                    美式 <Text className="gp-seg__sub">Americano</Text>
                  </View>
                  <View
                    className={`gp-seg__item ${rotation === RotationKind.MEXICANO ? 'gp-seg__item--on' : ''}`}
                    onClick={() => setRotation(RotationKind.MEXICANO)}
                  >
                    墨式 <Text className="gp-seg__sub">Mexicano</Text>
                  </View>
                </View>
              ) : null}
              <View className="gp-desc">
                <Text className="gp-desc__txt">
                  {mode === GroupMode.BALANCED ? MODE_DESC.BALANCED : MODE_DESC[rotation]}
                </Text>
              </View>
            </>
          ) : null}

          {/* ===== 步骤 4：设置 ===== */}
          {step === 4 ? (
            <>
              <View className="gp-step-head">
                <Text className="gp-step-head__t">场地与轮数</Text>
              </View>
              <View className="gp__settings">
                <Picker
                  mode="selector"
                  range={COURT_OPTIONS}
                  value={COURT_OPTIONS.indexOf(courtCount)}
                  onChange={(e) => setCourtCount(COURT_OPTIONS[Number(e.detail.value)])}
                >
                  <View className="gp-stat">
                    <Text className="gp-stat__k">场地</Text>
                    <Text className="gp-stat__v num">{courtCount}</Text>
                  </View>
                </Picker>
                <Picker
                  mode="selector"
                  range={ROUND_OPTIONS}
                  value={ROUND_OPTIONS.indexOf(rounds)}
                  onChange={(e) => setRounds(ROUND_OPTIONS[Number(e.detail.value)])}
                >
                  <View className="gp-stat">
                    <Text className="gp-stat__k">轮数</Text>
                    <Text className="gp-stat__v num">{rounds}</Text>
                  </View>
                </Picker>
              </View>
              {mixedActive ? (
                <Text className="gp-note">本局已开启混双（建局设置）：每队尽量一男一女，性别人数不足时生成后会提示无法满足的队伍。</Text>
              ) : null}
            </>
          ) : null}

          {/* ===== 步骤 5：看板 + 微调 ===== */}
          {step === 5 && schedule ? (
            <>
              <View className="gp-metrics">
                <View className="gp-metrics__cell">
                  <Text className="gp-metrics__v num">{schedule.metrics.rounds}</Text>
                  <Text className="gp-metrics__k">轮</Text>
                </View>
                <View className="gp-metrics__line" />
                <View className="gp-metrics__cell">
                  <Text className="gp-metrics__v num">{schedule.metrics.totalMatches}</Text>
                  <Text className="gp-metrics__k">总场次</Text>
                </View>
                <View className="gp-metrics__line" />
                <View className="gp-metrics__cell">
                  <Text className="gp-metrics__v num">
                    {schedule.metrics.appearancesMin === schedule.metrics.appearancesMax
                      ? schedule.metrics.appearancesMin
                      : `${schedule.metrics.appearancesMin}–${schedule.metrics.appearancesMax}`}
                  </Text>
                  <Text className="gp-metrics__k">人均场次</Text>
                </View>
                <View className="gp-metrics__line" />
                <View className="gp-metrics__cell">
                  <Text className="gp-metrics__v num">{schedule.metrics.byePerRound}</Text>
                  <Text className="gp-metrics__k">轮空/轮</Text>
                </View>
              </View>

              {/* 混双约束提示 */}
              {mixedActive ? (
                <View className={`gp-mixed ${mixedViolations > 0 ? 'gp-mixed--warn' : 'gp-mixed--ok'}`}>
                  <Text className="gp-mixed__txt">
                    {mixedViolations > 0
                      ? `混双：${mixedViolations} 队因性别人数不足无法满足男女搭配，可手动换位调整`
                      : '混双已满足：每队均为男女搭配'}
                  </Text>
                </View>
              ) : null}

              {/* 轮次 chips */}
              <ScrollView scrollX className="gp-rounds">
                {schedule.rounds.map((r, i) => (
                  <View
                    key={r.index}
                    className={`gp-rounds__chip ${i === activeRound ? 'gp-rounds__chip--on' : ''}`}
                    onClick={() => {
                      setActiveRound(i);
                      setPicked(null);
                    }}
                  >
                    <Text className="num">R{r.index + 1}</Text>
                  </View>
                ))}
              </ScrollView>

              <View className="gp-roundhead">
                <Text className="gp-roundhead__t">第 {activeRound + 1} 轮对阵</Text>
                <Text className="gp-roundhead__hint">选中一人再点另一人（含轮空席）即可换位</Text>
              </View>

              {/* 当前轮对阵卡 */}
              <View className="gp-court">
                {round && round.matches.length > 0 ? (
                  round.matches.map((m) => (
                    <View key={String(m.id)} className="gp-court__match">
                      <View className="gp-court__row">
                        <Text className="gp-court__court">场地 {m.courtNo}</Text>
                        {mode === GroupMode.BALANCED ? (
                          <Tag text={`实力差 ${m.strengthGap}`} tone="success" />
                        ) : null}
                      </View>
                      <View className="gp-court__teams">
                        <View className="gp-court__team">{teamCells(m.teamA, 'a')}</View>
                        <Text className="gp-court__vs num">VS</Text>
                        <View className="gp-court__team">{teamCells(m.teamB, 'b')}</View>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text className="gp-court__none">本轮无对阵</Text>
                )}
              </View>

              {/* 轮空名单 */}
              {byeNames.length > 0 ? (
                <View className="gp-bye">
                  <Text className="gp-bye__tag">轮空</Text>
                  <Text className="gp-bye__txt">本轮 {byeNames.length} 人休息</Text>
                  <View className="gp-bye__list">
                    {byeNames.map((p) => {
                      const on = picked === p.id;
                      return (
                        <View
                          key={p.id}
                          className={`gp-bye__item ${on ? 'gp-bye__item--on' : ''}`}
                          onClick={() => onTapPlayer(p.id)}
                        >
                          <Avatar name={p.displayName} src={p.avatarUrl} size={18} />
                          <Text className="gp-bye__name">{p.displayName}</Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              ) : null}
            </>
          ) : null}

          <View className="gp__scroll-pad" />
        </View>
      </ScrollView>

      {/* ===== 底部操作区（随步骤切换）===== */}
      <View className="gp__bar">
        {step > 1 && step < 5 ? (
          <View className="gp__bar-l">
            <PrimaryButton text="上一步" variant="outline" onClick={() => goStep(step - 1)} />
          </View>
        ) : null}

        {step === 1 ? (
          <View className="gp__bar-r">
            <PrimaryButton
              text={`下一步 · 已选 ${selectedList.length} 人`}
              onClick={() =>
                canLeaveStep1
                  ? setStep(2)
                  : Taro.showToast({ title: '至少选 2 人才能开始分组', icon: 'none' })
              }
            />
          </View>
        ) : null}

        {step === 2 || step === 3 ? (
          <View className="gp__bar-r">
            <PrimaryButton text="下一步" onClick={() => setStep(step + 1)} />
          </View>
        ) : null}

        {step === 4 ? (
          <View className="gp__bar-r">
            <PrimaryButton text={generating ? '生成中…' : '生成赛程'} disabled={generating} onClick={onGenerate} />
          </View>
        ) : null}

        {step === 5 ? (
          <>
            <View className="gp__bar-l">
              <PrimaryButton text={generating ? '重排中…' : '重新生成'} variant="outline" onClick={onRegenerate} />
            </View>
            <View className="gp__bar-r">
              <PrimaryButton text={confirming ? '提交中…' : '确认开打'} onClick={onConfirm} disabled={confirming} />
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}
