import { useState, useCallback } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';
import { type MatchVM, type ParticipantVM } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { toastError } from '../../services/api';
import { Avatar, PageFrame } from '../../components';
import './index.scss';

/** 一队头像组（双打两人叠放，单打一人）+ 队名 */
function teamLabel(ps: ParticipantVM[]): string {
  return ps.map((p) => p.displayName).join(' · ') || '—';
}

export default function Scoring() {
  const router = useRouter();
  const matchId = router.params.matchId ?? '';
  const activityId = Number(router.params.activityId);

  const [match, setMatch] = useState<MatchVM | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [scoreA, setScoreA] = useState(0);
  const [scoreB, setScoreB] = useState(0);
  const [manual, setManual] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      await ensureLogin();
      const board = await api.getBoard(activityId);
      let found: MatchVM | null = null;
      for (const r of board.rounds) {
        const m = r.matches.find((x) => String(x.id) === String(matchId));
        if (m) {
          found = m;
          break;
        }
      }
      setMatch(found);
      if (found) {
        setScoreA(found.scoreA ?? 0);
        setScoreB(found.scoreB ?? 0);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setLoaded(true);
    }
  }, [activityId, matchId]);

  useDidShow(() => {
    load();
  });

  const onManualInput = (side: 'A' | 'B') => (e: { detail: { value: string } }) => {
    const raw = e.detail.value.replace(/[^\d]/g, '');
    const n = raw === '' ? 0 : Math.min(99, Number(raw));
    if (side === 'A') setScoreA(n);
    else setScoreB(n);
  };

  const tie = scoreA === scoreB;

  const submit = useCallback(
    async (kind: 'score' | 'rejudge') => {
      if (!match || submitting) return;
      if (tie) {
        Taro.showToast({ title: '比分不能相同，不能平局', icon: 'none' });
        return;
      }
      setSubmitting(true);
      try {
        if (kind === 'score') await api.score(match.id as number, scoreA, scoreB);
        else await api.rejudge(match.id as number, scoreA, scoreB);
        Taro.showToast({ title: kind === 'score' ? '已确认胜负' : '已改判', icon: 'success' });
        setTimeout(() => Taro.navigateBack(), 600);
      } catch (e) {
        toastError(e);
        setSubmitting(false);
      }
    },
    [match, scoreA, scoreB, tie, submitting],
  );

  if (!loaded) {
    return (
      <PageFrame title="场地 · 计分" activeTab="home">
        <View className="sc__state">
          <Text className="sc__loading">加载中…</Text>
        </View>
      </PageFrame>
    );
  }

  if (!match) {
    return (
      <PageFrame title="场地 · 计分" activeTab="home">
        <View className="sc__state">
          <Text className="sc__loading">未找到该场对局</Text>
        </View>
      </PageFrame>
    );
  }

  const aWin = scoreA > scoreB;
  const bWin = scoreB > scoreA;

  const renderAvatars = (ps: ParticipantVM[]) => (
    <View className="sc__avatars">
      {ps.map((p, i) => (
        <View key={p.id} className="sc__avatar-item" style={{ marginLeft: i === 0 ? 0 : '-8px', zIndex: 10 - i }}>
          <Avatar name={p.displayName} src={p.avatarUrl} size={28} ring />
        </View>
      ))}
    </View>
  );

  const footerNode = (
    <View className="sc__actions">
      <View className="sc__btn sc__btn--ghost" onClick={() => submit('rejudge')}>
        改判
      </View>
      <View className="sc__btn sc__btn--primary" onClick={() => submit('score')}>
        <Text className="sc__check">✓</Text>
        确认胜负
      </View>
    </View>
  );

  return (
    <PageFrame title={`场地 ${match.courtNo} · 计分`} activeTab="home" footer={footerNode} footerBare>
      <View className="sc__inner">
      {/* 大字比分区 */}
      <View className="sc__score-card">
        <View className="sc__team">
          {renderAvatars(match.teamA.participants)}
          <Text className="sc__team-name">{teamLabel(match.teamA.participants)}</Text>
          <Text className={`sc__score score ${aWin ? 'sc__score--win' : ''}`}>{scoreA}</Text>
        </View>
        <View className="sc__colon">:</View>
        <View className="sc__team">
          {renderAvatars(match.teamB.participants)}
          <Text className="sc__team-name">{teamLabel(match.teamB.participants)}</Text>
          <Text className={`sc__score score ${bWin ? 'sc__score--win' : ''}`}>{scoreB}</Text>
        </View>
      </View>

      {/* 大按钮 +1 / -1 */}
      <View className="sc__pads">
        <View className="sc__pad">
          <View className="sc__plus sc__plus--a" onClick={() => setScoreA((v) => Math.min(99, v + 1))}>
            +1
          </View>
          <View className="sc__minus" onClick={() => setScoreA((v) => Math.max(0, v - 1))}>
            −1
          </View>
        </View>
        <View className="sc__pad">
          <View className="sc__plus sc__plus--b" onClick={() => setScoreB((v) => Math.min(99, v + 1))}>
            +1
          </View>
          <View className="sc__minus" onClick={() => setScoreB((v) => Math.max(0, v - 1))}>
            −1
          </View>
        </View>
      </View>

      {/* 直接填比分 */}
      {manual ? (
        <View className="sc__manual">
          <Input
            className="sc__manual-input score"
            type="number"
            value={String(scoreA)}
            onInput={onManualInput('A')}
          />
          <Text className="sc__manual-colon">:</Text>
          <Input
            className="sc__manual-input score"
            type="number"
            value={String(scoreB)}
            onInput={onManualInput('B')}
          />
        </View>
      ) : (
        <View className="sc__manual-toggle" onClick={() => setManual(true)}>
          或 直接填比分
        </View>
      )}

      {tie ? <Text className="sc__hint">比分不能相同，需分出胜负</Text> : null}
      </View>
    </PageFrame>
  );
}
