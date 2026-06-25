import { useState, useCallback } from 'react';
import { View, Text, ScrollView, Button } from '@tarojs/components';
import Taro, { useRouter, useDidShow, useShareAppMessage } from '@tarojs/taro';
import { levelLabel, type UserStatsVM } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { toastError } from '../../services/api';
import { Avatar, Empty, PrimaryButton } from '../../components';
import './index.scss';

export default function Profile() {
  const router = useRouter();
  const queryId = Number(router.params.id);
  const isOther = Number.isFinite(queryId) && queryId > 0;

  const [stats, setStats] = useState<UserStatsVM | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const targetId = isOther ? queryId : (await ensureLogin()).id;
      const st = await api.getUserStats(targetId);
      setStats(st);
    } catch (e) {
      toastError(e);
    } finally {
      setLoaded(true);
    }
  }, [isOther, queryId]);

  useDidShow(() => {
    load();
  });

  useShareAppMessage(() => {
    const name = stats?.user.nickname ?? '我';
    const win = stats ? Math.round(stats.winRate * 100) : 0;
    return {
      title: `${name}的羽球战绩：${stats?.totalGames ?? 0} 局 · 胜率 ${win}%`,
      path: stats ? `/pages/profile/index?id=${stats.user.id}` : '/pages/profile/index',
    };
  });

  const user = stats?.user;
  const trend = stats?.trend ?? [];
  const trendMax = Math.max(1, ...trend);
  const bars = trend.length ? trend : [0, 0, 0, 0, 0, 0, 0];
  const isNewbie = !!stats && stats.totalGames === 0;

  return (
    <View className="profile">
      {/* 绿色 Hero */}
      <View className="profile__header">
        <View className="profile__blob" />
        <View className="profile__statusbar">
          {isOther ? (
            <View className="profile__back" onClick={() => Taro.navigateBack()}>
              <Text className="profile__back-arrow">‹</Text>
            </View>
          ) : null}
        </View>
        <View className="profile__hero">
          <Avatar name={user?.nickname} src={user?.avatarUrl} size={58} ring />
          <View className="profile__id">
            <Text className="profile__name">{user?.nickname ?? '—'}</Text>
            {user ? (
              <View className="profile__level">
                <Text className="profile__level-txt">{levelLabel(user.defaultLevel)} · 默认水平</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* 内容区 */}
      <ScrollView scrollY className="profile__body">
        <View className="profile__inner">
        {loaded && !stats ? (
          <Empty text="暂无战绩数据" hint="打几局，这里就会有你的高光时刻" />
        ) : isNewbie ? (
          <View className="profile__newbie">
            <Empty
              text={isOther ? 'TA 还没有记录局' : '还没打过记录局'}
              hint={isOther ? '打完计分后，战绩会沉淀在这里' : '报名一场球局，打完计分就有你的战绩'}
            />
            {!isOther ? (
              <View className="profile__newbie-cta">
                <PrimaryButton text="去报名球局" onClick={() => Taro.switchTab({ url: '/pages/home/index' })} />
                <View className="profile__newbie-gap" />
                <PrimaryButton text="发起球局" variant="outline" onClick={() => Taro.navigateTo({ url: '/pages/create/index' })} />
              </View>
            ) : null}
          </View>
        ) : (
          <>
            {/* 统计三宫格 */}
            <View className="profile__row">
              <View className="profile__stat">
                <Text className="profile__stat-num num">{stats?.totalGames ?? 0}</Text>
                <Text className="profile__stat-label">参赛局</Text>
              </View>
              <View className="profile__stat">
                <Text className="profile__stat-num num profile__stat-num--green">
                  {stats ? Math.round(stats.winRate * 100) : 0}%
                </Text>
                <Text className="profile__stat-label">胜率</Text>
              </View>
              <View className="profile__stat">
                <Text className="profile__stat-num num">{stats?.points ?? 0}</Text>
                <Text className="profile__stat-label">积分</Text>
              </View>
            </View>

            {/* 最佳搭档 / 苦主 */}
            <View className="profile__row">
              <View className="profile__mini">
                <View className="profile__mini-av profile__mini-av--partner">
                  <Avatar name={stats?.bestPartner?.displayName} src={stats?.bestPartner?.avatarUrl} size={34} />
                </View>
                <View className="profile__mini-info">
                  <Text className="profile__mini-label">最佳搭档</Text>
                  <Text className="profile__mini-name">{stats?.bestPartner?.displayName ?? '暂无'}</Text>
                </View>
              </View>
              <View className="profile__mini">
                <View className="profile__mini-av profile__mini-av--nemesis">
                  <Avatar name={stats?.nemesis?.displayName} src={stats?.nemesis?.avatarUrl} size={34} />
                </View>
                <View className="profile__mini-info">
                  <Text className="profile__mini-label">苦主</Text>
                  <Text className="profile__mini-name">{stats?.nemesis?.displayName ?? '暂无'}</Text>
                </View>
              </View>
            </View>

            {/* 积分趋势 */}
            <View className="profile__trend">
              <View className="profile__trend-head">
                <Text className="profile__trend-title">积分趋势</Text>
                <Text className="profile__trend-sub">近 {trend.length || 7} 局 ↗</Text>
              </View>
              <View className="profile__bars">
                {bars.map((v, i) => {
                  const h = Math.max(8, Math.round((v / trendMax) * 92));
                  const last = i === bars.length - 1;
                  return (
                    <View
                      key={i}
                      className={`profile__bar ${last ? 'profile__bar--on' : ''}`}
                      style={{ height: `${h}%` }}
                    />
                  );
                })}
              </View>
            </View>
          </>
        )}
        <View className="profile__pad" />
        </View>
      </ScrollView>

      {/* 分享（仅看自己时） */}
      {!isOther && stats ? (
        <View className="profile__footer">
          <Button className="profile__share" openType="share">
            分享我的战绩
          </Button>
        </View>
      ) : null}
    </View>
  );
}
