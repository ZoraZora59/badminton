import { useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';
import {
  SignupStatus,
  SkillLevel,
  DEFAULT_LEVEL,
  levelLabel,
  type ActivityVM,
  type SignupVM,
  type ParticipantVM,
} from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { toastError } from '../../services/api';
import { Avatar, Tag, Empty, LevelSheet } from '../../components';
import './index.scss';

/** 本地签到草稿：以 signupId 为键，记录是否实到 + 本场水平（覆盖默认） */
interface Draft {
  checkedIn: boolean;
  level: SkillLevel;
}

export default function Checkin() {
  const router = useRouter();
  const id = Number(router.params.id);

  const [activity, setActivity] = useState<ActivityVM | null>(null);
  const [signups, setSignups] = useState<SignupVM[]>([]);
  const [guests, setGuests] = useState<ParticipantVM[]>([]);
  const [draft, setDraft] = useState<Record<number, Draft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 选水平弹层：正在编辑的 signupId（null = 关闭）
  const [sheetFor, setSheetFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureLogin();
      const [act, checkin] = await Promise.all([api.getActivity(id), api.getCheckin(id)]);
      setActivity(act);
      setSignups(checkin.signups);
      setGuests(checkin.guests);
      // 用服务端值初始化本地草稿（perGameLevel 缺省回落到报名人默认水平）
      const next: Record<number, Draft> = {};
      checkin.signups.forEach((s) => {
        next[s.id] = { checkedIn: s.checkedIn, level: s.perGameLevel ?? s.user.defaultLevel ?? DEFAULT_LEVEL };
      });
      setDraft(next);
    } catch (e) {
      toastError(e);
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useDidShow(() => {
    load();
  });

  // 正选名单（报名 + 不含请假/候补）= 可签到对象
  const roster = useMemo(() => signups.filter((s) => s.status === SignupStatus.SIGNED_UP), [signups]);
  const candidates = useMemo(() => signups.filter((s) => s.status === SignupStatus.WAITLIST), [signups]);

  const checkedCount = roster.filter((s) => draft[s.id]?.checkedIn).length;
  const allChecked = roster.length > 0 && checkedCount === roster.length;
  // 实到人数 = 勾选的正选 + 已加临时球友（Guest 默认到场）
  const goCount = checkedCount + guests.length;

  const toggle = (signupId: number) => {
    setDraft((d) => {
      const cur = d[signupId];
      if (!cur) return d;
      return { ...d, [signupId]: { ...cur, checkedIn: !cur.checkedIn } };
    });
  };

  const toggleAll = () => {
    const target = !allChecked;
    setDraft((d) => {
      const next = { ...d };
      roster.forEach((s) => {
        if (next[s.id]) next[s.id] = { ...next[s.id], checkedIn: target };
      });
      return next;
    });
  };

  const setLevel = (level: SkillLevel) => {
    if (sheetFor == null) return;
    setDraft((d) => {
      const cur = d[sheetFor];
      if (!cur) return d;
      return { ...d, [sheetFor]: { ...cur, level } };
    });
    setSheetFor(null);
  };

  const addGuest = async () => {
    try {
      // editable 弹层在部分基础库 / 类型定义中尚未声明，故按宽松形参调用并读取 content
      const res = (await Taro.showModal({
        title: '添加临时球友',
        editable: true,
        placeholderText: '球友昵称（无微信占位）',
        confirmText: '添加',
        cancelText: '取消',
      } as Taro.showModal.Option)) as { confirm: boolean; content?: string };
      if (!res.confirm) return;
      const name = (res.content || '').trim();
      if (!name) {
        Taro.showToast({ title: '请输入球友昵称', icon: 'none' });
        return;
      }
      const guest = await api.addGuest(id, { guestName: name, level: DEFAULT_LEVEL });
      setGuests((g) => [...g, guest]);
      Taro.showToast({ title: '已添加', icon: 'success' });
    } catch (e) {
      toastError(e);
    }
  };

  const promote = async (signupId: number) => {
    try {
      const updated = await api.promote(id, signupId);
      setSignups(updated);
      // 新晋正选默认勾选实到，沿用其默认水平
      setDraft((d) => {
        const next = { ...d };
        updated.forEach((s) => {
          if (!next[s.id]) next[s.id] = { checkedIn: true, level: s.perGameLevel ?? s.user.defaultLevel ?? DEFAULT_LEVEL };
        });
        return next;
      });
      Taro.showToast({ title: '已补位', icon: 'success' });
    } catch (e) {
      toastError(e);
    }
  };

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.batchCheckin(id, {
        items: signups.map((s) => ({
          signupId: s.id,
          checkedIn: draft[s.id]?.checkedIn ?? s.checkedIn,
          perGameLevel: draft[s.id]?.level ?? s.perGameLevel ?? s.user.defaultLevel ?? DEFAULT_LEVEL,
        })),
      });
      Taro.navigateTo({ url: `/pages/grouping/index?id=${id}` });
    } catch (e) {
      toastError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const renderSignup = (s: SignupVM) => {
    const isLeave = s.status === SignupStatus.LEAVE;
    const checked = !!draft[s.id]?.checkedIn;
    const level = draft[s.id]?.level ?? s.perGameLevel ?? s.user.defaultLevel ?? DEFAULT_LEVEL;
    const isHost = activity != null && s.user.id === activity.hostId;

    return (
      <View key={s.id} className={`ck-row ${isLeave ? 'ck-row--off' : ''}`}>
        {isLeave ? (
          <View className="ck-row__box" />
        ) : (
          <View className={`ck-row__box ${checked ? 'ck-row__box--on' : ''}`} onClick={() => toggle(s.id)}>
            {checked ? (
              <Text className="ck-row__tick">✓</Text>
            ) : null}
          </View>
        )}
        <Avatar name={s.user.nickname} src={s.user.avatarUrl} size={34} />
        <View className="ck-row__info">
          <View className="ck-row__nameline">
            <Text className="ck-row__name">{s.user.nickname}</Text>
            {s.plusOne > 0 ? <Tag text={`带${s.plusOne}人`} tone="accent" /> : null}
          </View>
          {isHost ? <Text className="ck-row__sub">局长</Text> : null}
        </View>
        {isLeave ? (
          <Tag text="请假" tone="warn" />
        ) : (
          <View className="ck-row__lv" onClick={() => setSheetFor(s.id)}>
            {levelLabel(level)} <Text className="ck-row__caret">▾</Text>
          </View>
        )}
      </View>
    );
  };

  const renderGuest = (g: ParticipantVM) => (
    <View key={`g-${g.id}`} className="ck-row">
      <View className="ck-row__box ck-row__box--on">
        <Text className="ck-row__tick">✓</Text>
      </View>
      <Avatar name={g.displayName} src={g.avatarUrl} size={34} />
      <View className="ck-row__info">
        <View className="ck-row__nameline">
          <Text className="ck-row__name">{g.displayName}</Text>
          <Tag text="临时" tone="accent" />
        </View>
      </View>
      <View className="ck-row__lv ck-row__lv--static">{levelLabel(g.level)}</View>
    </View>
  );

  const sheetSignup = sheetFor != null ? signups.find((s) => s.id === sheetFor) : undefined;
  const empty = signups.length === 0 && guests.length === 0;

  if (!loaded) {
    return (
      <View className="ck">
        <View className="ck__loading">
          <Empty text="加载中…" />
        </View>
      </View>
    );
  }

  return (
    <View className="ck">
      <ScrollView scrollY className="ck__body">
        <View className="ck__inner">
        <View className="ck__head">
          <Text className="ck__count">
            已到 <Text className="ck__count-n num">{goCount}</Text> / {roster.length + guests.length}
          </Text>
          {roster.length > 0 ? (
            <Text className="ck__all" onClick={toggleAll}>
              {allChecked ? '取消全选' : '全选'}
            </Text>
          ) : null}
        </View>

        {empty ? (
          <Empty text="还没有报名的球友" hint="先回活动详情邀请好友报名" />
        ) : (
          <>
            {roster.map(renderSignup)}
            {guests.map(renderGuest)}
            {signups.filter((s) => s.status === SignupStatus.LEAVE).map(renderSignup)}

            <View className="ck-add" onClick={addGuest}>
              <Text className="ck-add__plus">＋</Text>
              添加临时球友（无微信占位）
            </View>

            {candidates.length > 0 ? (
              <View className="ck-wait">
                <Text className="ck-wait__text">候补 {candidates.length} 人 · 可补位</Text>
                <Text className="ck-wait__btn" onClick={() => promote(candidates[0].id)}>
                  补位 ›
                </Text>
              </View>
            ) : null}
          </>
        )}
        <View className="ck__pad" />
        </View>
      </ScrollView>

      <View className="ck__footer">
        <View
          className={`ck__go ${submitting || goCount === 0 ? 'ck__go--disabled' : ''}`}
          onClick={confirm}
        >
          确认参赛 {goCount} 人 · 去分组 →
        </View>
      </View>

      <LevelSheetLazy
        visible={sheetFor != null}
        value={sheetSignup ? draft[sheetSignup.id]?.level ?? DEFAULT_LEVEL : DEFAULT_LEVEL}
        signup={sheetSignup}
        onConfirm={setLevel}
        onClose={() => setSheetFor(null)}
      />
    </View>
  );
}

/** 包一层以注入「为某人设本场水平」的标题 */
function LevelSheetLazy(props: {
  visible: boolean;
  value: SkillLevel;
  signup?: SignupVM;
  onConfirm: (l: SkillLevel) => void;
  onClose: () => void;
}) {
  const { visible, value, signup, onConfirm, onClose } = props;
  const title = signup ? `${signup.user.nickname} · 本场水平` : '本场水平';
  return <LevelSheet visible={visible} value={value} title={title} onConfirm={onConfirm} onClose={onClose} />;
}
