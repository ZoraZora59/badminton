import { useState, useCallback } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro';
import { ActivityStatus, type ActivityVM, type UserStatsVM } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { useUser } from '../../store/user';
import { toastError } from '../../services/api';
import { Avatar, Tag, Empty, Icon } from '../../components';
import { fmtCardTime } from '../../utils/format';
import './index.scss';

const TABS: { key: ActivityStatus; label: string }[] = [
  { key: ActivityStatus.SIGNUP, label: '报名中' },
  { key: ActivityStatus.ONGOING, label: '进行中' },
  { key: ActivityStatus.FINISHED, label: '已结束' },
];

export default function Home() {
  const user = useUser();
  const [tab, setTab] = useState<ActivityStatus>(ActivityStatus.SIGNUP);
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

  const signupCount = all.filter((a) => a.status === ActivityStatus.SIGNUP).length;
  const shown = all.filter((a) => a.status === tab);

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
        <View className="home__tabs">
          {TABS.map((t) => (
            <View key={t.key} className={`home__tab ${tab === t.key ? 'home__tab--on' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </View>
          ))}
        </View>

        <ScrollView scrollY className="home__list">
          {shown.length === 0 ? (
            <Empty text="这里还没有球局" hint="点右下角 + 发起新局，分享给球友一起打" />
          ) : (
            shown.map((a) => (
              <View key={a.id} className="card" onClick={() => Taro.navigateTo({ url: `/pages/activity/index?id=${a.id}` })}>
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
                    <Text className="card__count num">{a.signedUpCount}/{a.capacity}</Text>
                  </View>
                </View>
              </View>
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
