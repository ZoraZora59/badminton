import { useState, useCallback } from 'react';
import { View, Text, ScrollView, Button } from '@tarojs/components';
import Taro, { useRouter, useDidShow, useShareAppMessage, useShareTimeline } from '@tarojs/taro';
import { levelLabel, type UserStatsVM } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { toastError } from '../../services/api';
import { Avatar, Empty, PrimaryButton } from '../../components';
import { goBack } from '../../utils/nav';
import './index.scss';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${m}-${day}`;
}

export default function Profile() {
  const router = useRouter();
  const queryId = Number(router.params.id);
  const isOther = Number.isFinite(queryId) && queryId > 0;

  const [stats, setStats] = useState<UserStatsVM | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showRecent, setShowRecent] = useState(false);

  const explainPartner = useCallback(() => {
    Taro.showModal({
      title: '最佳搭档',
      content: '和你同队并肩作战、一起赢球次数最多的队友。一起赢得越多，TA 越靠前。',
      showCancel: false,
      confirmText: '知道了',
    });
  }, []);
  const explainNemesis = useCallback(() => {
    Taro.showModal({
      title: '难兄难弟',
      content: '和你同队搭档、一起输球次数最多的人。可能只是配合还没磨合好，多打几场说不定就翻盘了。',
      showCancel: false,
      confirmText: '知道了',
    });
  }, []);

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
  useShareTimeline(() => {
    const name = stats?.user.nickname ?? '我';
    const win = stats ? Math.round(stats.winRate * 100) : 0;
    return {
      title: `${name}的羽球战绩：${stats?.totalGames ?? 0} 局 · 胜率 ${win}%`,
      query: stats ? `id=${stats.user.id}` : '',
    };
  });

  const user = stats?.user;
  const trend = stats?.trend ?? [];
  const recentMatches = stats?.recentMatches ?? [];
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
            <View className="profile__back" onClick={goBack}>
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
                <Text className="profile__level-txt">{levelLabel(user.defaultLevel)}</Text>
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

            {/* 最佳搭档 / 难兄难弟 */}
            <View className="profile__row">
              <View className="profile__mini" onClick={explainPartner}>
                <View className="profile__mini-av profile__mini-av--partner">
                  <Avatar name={stats?.bestPartner?.displayName} src={stats?.bestPartner?.avatarUrl} size={34} />
                </View>
                <View className="profile__mini-info">
                  <Text className="profile__mini-label">最佳搭档<Text className="profile__mini-q">?</Text></Text>
                  <Text className="profile__mini-name">{stats?.bestPartner?.displayName ?? '暂无'}</Text>
                </View>
              </View>
              <View className="profile__mini" onClick={explainNemesis}>
                <View className="profile__mini-av profile__mini-av--nemesis">
                  <Avatar name={stats?.nemesis?.displayName} src={stats?.nemesis?.avatarUrl} size={34} />
                </View>
                <View className="profile__mini-info">
                  <Text className="profile__mini-label">难兄难弟<Text className="profile__mini-q">?</Text></Text>
                  <Text className="profile__mini-name">{stats?.nemesis?.displayName ?? '暂无'}</Text>
                </View>
              </View>
            </View>

            {/* 积分趋势（点击展开近期对局） */}
            <View className="profile__trend" onClick={() => recentMatches.length && setShowRecent((s) => !s)}>
              <View className="profile__trend-head">
                <Text className="profile__trend-title">积分趋势</Text>
                {recentMatches.length ? (
                  <Text className="profile__trend-sub">
                    {showRecent ? '收起对局 ▲' : '看近期对局 ▼'}
                  </Text>
                ) : (
                  <Text className="profile__trend-sub">近 {trend.length || 7} 局 ↗</Text>
                )}
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

            {/* 近期对局明细 */}
            {showRecent && recentMatches.length ? (
              <View className="profile__matches">
                {recentMatches.map((m) => {
                  const win = m.result === 'WIN';
                  return (
                    <View key={m.matchId} className="profile__match">
                      <View className={`profile__match-tag ${win ? 'profile__match-tag--win' : 'profile__match-tag--loss'}`}>
                        {win ? '胜' : '负'}
                      </View>
                      <View className="profile__match-body">
                        <View className="profile__match-line">
                          <Text className="profile__match-vs">
                            {m.partners.length ? `我 / ${m.partners.join('、')}` : '我'}
                          </Text>
                          <Text className="profile__match-score num">{m.scoreFor} : {m.scoreAgainst}</Text>
                        </View>
                        <View className="profile__match-line profile__match-line--sub">
                          <Text className="profile__match-opp">vs {m.opponents.join('、') || '对手'}</Text>
                          <Text className="profile__match-date">{formatDate(m.playedAt)}</Text>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </>
        )}
        <View className={`profile__pad${!isOther && stats ? '' : ' profile__pad--bare'}`} />
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
