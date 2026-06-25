import { useState, useCallback } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useRouter, useDidShow, useShareAppMessage } from '@tarojs/taro';
import { ActivityStatus, GroupMode, type ActivityVM, type SummaryVM, type TodayRankRowVM } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { toastError } from '../../services/api';
import { Avatar, Empty, PrimaryButton, ShareCard, Icon } from '../../components';
import { fmtMonthDay, fmtWeekday } from '../../utils/format';
import './index.scss';

export default function Summary() {
  const router = useRouter();
  const id = Number(router.params.id);
  const [data, setData] = useState<SummaryVM | null>(null);
  const [act, setAct] = useState<ActivityVM | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [s, a] = await Promise.all([api.getSummary(id), api.getActivity(id)]);
      setData(s);
      setAct(a);
    } catch (e) {
      toastError(e);
    }
  }, [id]);

  useDidShow(() => {
    load();
  });

  // ROTATION = 个人积分制（看积分）；BALANCED = 队制（看胜场）
  const isTeam = data?.mode === GroupMode.BALANCED;
  const modeLabel = isTeam ? '队制' : '个人积分制';

  const rankValue = (r: TodayRankRowVM) => (isTeam ? `${r.wins}胜` : `+${r.points}`);

  const mvp = data?.mvp ?? null;
  const rank = data?.rank ?? [];
  const top3 = rank.slice(0, 3);

  useShareAppMessage(() => ({
    title: act
      ? `${act.title} 今日战报${mvp ? ` · MVP ${mvp.displayName}` : ''}`
      : '今日战报',
    path: `/pages/summary/index?id=${id}`,
  }));

  const goHome = () => Taro.switchTab({ url: '/pages/home/index' });

  const onFinish = async () => {
    if (!id || finishing) return;
    const res = await Taro.showModal({
      title: '结束活动',
      content: '结束后将无法继续计分，确定结束本场活动吗？',
      confirmText: '结束活动',
      confirmColor: '#16A34A',
    });
    if (!res.confirm) return;
    setFinishing(true);
    try {
      await api.finishActivity(id);
      Taro.showToast({ title: '已结束', icon: 'success', duration: 1000 });
      // 整场流程已结束，回到主页（球局 tab）；switchTab 会清掉签到/分组/看板/结算这条页面栈
      setTimeout(goHome, 1000);
    } catch (e) {
      toastError(e);
      setFinishing(false);
    }
  };

  return (
    <View className="summary">
      <ScrollView scrollY className="summary__scroll">
        <View className="summary__inner">
          {/* MVP 卡 */}
          {mvp ? (
            <View className="mvp">
              <View className="mvp__deco" />
              <View className="mvp__avatar">
                <Avatar name={mvp.displayName} src={mvp.avatarUrl ?? undefined} size={48} />
              </View>
              <View className="mvp__info">
                <View className="mvp__tag">
                  <Icon name="trophy" size={13} color="#d7f26b" />
                  <Text className="mvp__tag-txt">本场 MVP</Text>
                </View>
                <Text className="mvp__name">{mvp.displayName}</Text>
              </View>
              <View className="mvp__score">
                <Text className="mvp__wins score">{mvp.wins}胜</Text>
                <Text className="mvp__pts">+{mvp.points} 分</Text>
              </View>
            </View>
          ) : null}

          {/* 今日榜标题 */}
          <View className="summary__head">
            <Text className="summary__head-title">今日榜</Text>
            <Text className="summary__head-mode">{modeLabel}</Text>
          </View>

          {/* 排行列表 */}
          {rank.length === 0 ? (
            <Empty text="本场还没有成绩" hint="完成计分后这里会生成今日榜" />
          ) : (
            <View className="rank">
              {rank.map((r, i) => (
                <View key={r.participantId}>
                  {i > 0 ? <View className="rank__sep" /> : null}
                  <View className={`rank__row ${r.rank > 3 ? 'rank__row--dim' : ''}`}>
                    <Text className={`rank__badge ${r.rank === 1 ? 'rank__badge--first' : ''} score`}>{r.rank}</Text>
                    <View className="rank__avatar">
                      <Avatar name={r.displayName} src={r.avatarUrl ?? undefined} size={30} />
                    </View>
                    <Text className="rank__name">{r.displayName}</Text>
                    <Text className={`rank__val score ${r.rank === 1 ? 'rank__val--first' : ''}`}>{rankValue(r)}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* 底部操作 */}
      <View className="summary__foot">
        <View
          className="summary__share bm-btn bm-btn--solid bm-btn--block"
          onClick={() => setShareOpen(true)}
        >
          <Icon name="share" size={16} color="#ffffff" />
          <Text className="summary__share-txt">生成战报分享卡</Text>
        </View>
        <View className="summary__foot-gap" />
        {act?.status === ActivityStatus.FINISHED ? (
          <PrimaryButton text="返回主页" variant="outline" onClick={goHome} />
        ) : (
          <PrimaryButton text="结束活动" variant="outline" disabled={finishing} onClick={onFinish} />
        )}
      </View>

      {/* 战报分享卡预览 */}
      <ShareCard
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        forwardLabel="晒战报到群"
        tip="转发战报，约下一场"
      >
        <View className="sc-rep">
          <View className="sc-rep__hero">
            <Text className="sc-rep__brand">来打我呀 · 今日战报</Text>
            <Text className="sc-rep__title">{act?.title ?? '今日球局'}</Text>
            {act ? (
              <Text className="sc-rep__date num">
                {fmtMonthDay(act.startAt)} {fmtWeekday(act.startAt)} · {modeLabel}
              </Text>
            ) : null}
            {mvp ? (
              <View className="sc-rep__mvp">
                <Avatar name={mvp.displayName} src={mvp.avatarUrl ?? undefined} size={40} ring />
                <View className="sc-rep__mvp-info">
                  <Text className="sc-rep__mvp-tag">🏆 本场 MVP</Text>
                  <Text className="sc-rep__mvp-name">{mvp.displayName}</Text>
                </View>
                <Text className="sc-rep__mvp-score score">
                  {mvp.wins}胜 · +{mvp.points}
                </Text>
              </View>
            ) : null}
          </View>
          <View className="sc-rep__list">
            <Text className="sc-rep__head">今日榜 TOP {top3.length}</Text>
            {top3.length === 0 ? (
              <Text className="sc-rep__head">本场暂无成绩</Text>
            ) : (
              top3.map((r) => (
                <View key={r.participantId} className="sc-rep__row">
                  <Text className={`sc-rep__rank score ${r.rank === 1 ? 'sc-rep__rank--first' : ''}`}>{r.rank}</Text>
                  <Text className="sc-rep__name">{r.displayName}</Text>
                  <Text className="sc-rep__val score">{rankValue(r)}</Text>
                </View>
              ))
            )}
          </View>
        </View>
      </ShareCard>
    </View>
  );
}
