import { Fragment, useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useDidShow, usePullDownRefresh, useShareAppMessage, useShareTimeline } from '@tarojs/taro';
import { ActivityStatus, type ActivityVM, type UserStatsVM } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { useUser } from '../../store/user';
import { toastError } from '../../services/api';
import { Avatar, Tag, Empty, Icon } from '../../components';
import { fmtCardTime } from '../../utils/format';
import { finishedDividerIndex, sortHomeActivities } from '../../utils/activity';
import './index.scss';

export default function Home() {
  const user = useUser();
  const [all, setAll] = useState<ActivityVM[]>([]);
  const [stats, setStats] = useState<UserStatsVM | null>(null);

  const load = useCallback(async () => {
    try {
      const me = await ensureLogin();
      const [list, st] = await Promise.all([api.listActivities(), api.getUserStats(me.id)]);
      setAll(list);
      setStats(st);
    } catch (e) {
      toastError(e);
    }
  }, []);

  useDidShow(() => {
    load();
  });

  usePullDownRefresh(async () => {
    await load();
    Taro.stopPullDownRefresh();
  });

  // 首页是约球入口：转发/朋友圈都落到首页，邀请好友一起约
  useShareAppMessage(() => ({
    title: '羽毛球小助手｜建局、报名、计分一条龙，一起来约球',
    path: '/pages/home/index',
  }));
  useShareTimeline(() => ({
    title: '羽毛球小助手｜建局、报名、计分一条龙，一起来约球',
  }));

  const signupCount = all.filter((a) => a.status === ActivityStatus.SIGNUP).length;
  // 去掉三态筛选栏，改为单列表：排序和「已结束」分隔位置由 utils/activity 统一决定
  const shown = useMemo(() => sortHomeActivities(all), [all]);
  const dividerAt = finishedDividerIndex(shown);

  const statusTag = (a: ActivityVM) => {
    if (a.status === ActivityStatus.SIGNUP)
      return a.signedUpCount >= a.capacity ? <Tag text="满员候补" tone="warn" /> : <Tag text="报名中" tone="success" />;
    if (a.status === ActivityStatus.ONGOING) return <Tag text="进行中" tone="success" />;
    if (a.status === ActivityStatus.CANCELLED) return <Tag text="已取消" tone="muted" />;
    return <Tag text="已结束" tone="muted" />;
  };

  return (
    <View className="home">
      {/* 绿色头部 */}
      <View className="home__header">
        <View className="home__statusbar" />
        <View className="home__greet">
          <View>
            <Text className="home__hi">下午好，准备开打 🏸</Text>
            <Text className="home__title">我的球局</Text>
          </View>
        </View>
        <View className="home__stats">
          <View className="home__stat">
            <Text className="home__stat-num num" style={{ color: '#d7f26b' }}>{signupCount}</Text>
            <Text className="home__stat-label">报名中</Text>
          </View>
          <View className="home__divider" />
          <View className="home__stat">
            <Text className="home__stat-num num">{stats?.totalGames ?? 0}</Text>
            <Text className="home__stat-label">累计参赛</Text>
          </View>
          <View className="home__divider" />
          <View className="home__stat">
            <Text className="home__stat-num num">{stats ? Math.round(stats.winRate * 100) : 0}%</Text>
            <Text className="home__stat-label">胜率</Text>
          </View>
        </View>
      </View>

      {/* 列表区 */}
      <View className="home__body">
        <ScrollView scrollY className="home__list">
          {shown.length === 0 ? (
            <Empty text="这里还没有球局" hint="点右下角 + 发起新局，分享给球友一起打" />
          ) : (
            shown.map((a, idx) => (
              <Fragment key={a.id}>
                {idx === dividerAt ? (
                  <View className="home__sep">
                    <View className="home__sep-line" />
                    <Text className="home__sep-txt">已结束</Text>
                    <View className="home__sep-line" />
                  </View>
                ) : null}
                <View className="card" onClick={() => Taro.navigateTo({ url: `/pages/activity/index?id=${a.id}` })}>
                  <View className="card__top">
                    <Text className="card__title">{a.title}</Text>
                    {statusTag(a)}
                  </View>
                  <View className="card__meta">
                    <View className="card__meta-item">
                      <Icon name="clock" size={13} color="#80878f" />
                      <Text className="card__meta-txt num">{fmtCardTime(a.startAt)}</Text>
                    </View>
                    <View className="card__meta-item">
                      <Icon name="pin" size={13} color="#80878f" />
                      <Text className="card__meta-txt">{a.venue} · {a.courtCount} 片</Text>
                    </View>
                  </View>
                  <View className="card__bottom">
                    <View className="card__wall">
                      {a.members.slice(0, 4).map((m, i) => (
                        <View key={m.id} className="card__wall-item" style={{ marginLeft: i === 0 ? 0 : '-9px', zIndex: 10 - i }}>
                          <Avatar name={m.nickname} src={m.avatarUrl} size={28} ring />
                        </View>
                      ))}
                      {a.signedUpCount > 4 ? <View className="card__more">+{a.signedUpCount - 4}</View> : null}
                    </View>
                    <View className="card__progress">
                      <View className="card__bar">
                        <View className="card__bar-fill" style={{ width: `${Math.min(100, Math.round((a.signedUpCount / a.capacity) * 100))}%` }} />
                      </View>
                      <Text className="card__count num">
                        {a.signedUpCount}/{a.capacity}
                        {a.waitlistCount > 0 ? ` · 候补 ${a.waitlistCount}` : ''}
                      </Text>
                    </View>
                  </View>
                </View>
              </Fragment>
            ))
          )}
          <View className="home__list-pad" />
        </ScrollView>
      </View>

      {/* FAB 发起新局 */}
      <View className="home__fab" onClick={() => Taro.navigateTo({ url: '/pages/create/index' })}>
        <Text className="home__fab-plus">＋</Text>
      </View>
    </View>
  );
}
