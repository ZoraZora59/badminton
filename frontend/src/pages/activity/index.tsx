import { useState, useCallback, useRef } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useRouter, useDidShow, useShareAppMessage } from '@tarojs/taro';
import {
  ActivityStatus,
  SignupStatus,
  type ActivityVM,
  type SignupVM,
} from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { useUser } from '../../store/user';
import { toastError } from '../../services/api';
import { Avatar, Tag, PrimaryButton, Empty, ShareCard, Icon, PageFrame } from '../../components';
import { fmtRange, fmtMonthDay, cleanRemark, playTypeText, modeText } from '../../utils/format';
import './index.scss';

export default function Activity() {
  const router = useRouter();
  const id = Number(router.params.id);
  const wantShare = router.params.share === '1';
  const me = useUser();

  const [act, setAct] = useState<ActivityVM | null>(null);
  const [signups, setSignups] = useState<SignupVM[]>([]);
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // 建局后跳来带 share=1：仅自动弹一次分享卡
  const sharePrompted = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      await ensureLogin();
      const [a, s] = await Promise.all([api.getActivity(id), api.getSignups(id)]);
      setAct(a);
      setSignups(s);
      if (wantShare && !sharePrompted.current && a.status !== ActivityStatus.CANCELLED) {
        sharePrompted.current = true;
        setShareOpen(true);
      }
    } catch (e) {
      toastError(e);
    }
  }, [id, wantShare]);

  useDidShow(() => {
    load();
  });

  useShareAppMessage(() => ({
    title: act ? `${act.title}｜${fmtMonthDay(act.startAt)} ${act.venue} · 点我报名` : '羽毛球小助手',
    path: `/pages/activity/index?id=${id}`,
  }));

  /** 任意写操作后统一重新拉取 */
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        await load();
      } catch (e) {
        toastError(e);
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  /** 取消球局是不可逆操作，先二次确认再执行，避免误触 */
  const confirmCancel = useCallback(async () => {
    if (busy) return;
    const res = await Taro.showModal({
      title: '取消球局',
      content: '取消后球局立即关闭，已报名的球友会看到「球局已取消」，且无法恢复。确定取消吗？',
      cancelText: '再想想',
      confirmText: '取消球局',
      confirmColor: '#E64340',
    });
    if (!res.confirm) return;
    run(() => api.cancelActivity(id));
  }, [busy, run, id]);

  if (!act) {
    return (
      <PageFrame title="活动详情" activeTab="home">
        <View className="act__loading">
          <Empty text="加载中…" />
        </View>
      </PageFrame>
    );
  }

  const isHost = act.isHost ?? act.hostId === me?.id;
  const mine = act.mySignupStatus ?? null;
  const cancelled = act.status === ActivityStatus.CANCELLED;
  const finished = act.status === ActivityStatus.FINISHED;
  const ongoing = act.status === ActivityStatus.ONGOING;

  const signed = signups.filter((s) => s.status === SignupStatus.SIGNED_UP);
  const waitlist = signups.filter((s) => s.status === SignupStatus.WAITLIST);
  const leave = signups.filter((s) => s.status === SignupStatus.LEAVE);
  const full = act.signedUpCount >= act.capacity;

  // Hero 状态徽标文案
  let badge = '报名中';
  if (cancelled) badge = '已取消';
  else if (finished) badge = '已结束';
  else if (ongoing) badge = '进行中';
  else if (full) badge = '已满员';
  const heroBadge = isHost ? `${badge} · 局长是你` : badge;

  const actionsNode = isHost ? (
    <HostActions act={act} id={id} busy={busy} onCancel={confirmCancel} />
  ) : (
    <GuestActions act={act} mine={mine} full={full} busy={busy} run={run} id={id} />
  );

  const shareOverlay = (
    <ShareCard
      visible={shareOpen}
      onClose={() => setShareOpen(false)}
      forwardLabel="转发给球友 · 召集开打"
      tip="转发到群，球友点开卡片即可报名"
    >
      <View className="sc-act">
        <View className="sc-act__hero">
          <Text className="sc-act__brand">羽毛球小助手</Text>
          <Text className="sc-act__title">{act.title}</Text>
          <Text className="sc-act__host">局长 {act.hostNickname} 邀你来打球</Text>
        </View>
        <View className="sc-act__body">
          <View className="sc-act__row">
            <Icon name="clock" size={16} color="#16a34a" />
            <Text className="sc-act__row-txt num">{fmtRange(act.startAt, act.endAt)}</Text>
          </View>
          <View className="sc-act__row">
            <Icon name="pin" size={16} color="#16a34a" />
            <Text className="sc-act__row-txt">
              {act.venue} · {act.courtCount} 片场地
            </Text>
          </View>
          <View className="sc-act__count">
            <Text className="sc-act__count-n num">{act.signedUpCount}</Text>
            <Text className="sc-act__count-cap num">/ {act.capacity} 人已报名</Text>
          </View>
          {/* 预览里的主 CTA 仅为「球友看到的样子」示意：点它收起预览即可，不触发原生转发（转发走下方按钮）*/}
          <View className="sc-act__cta" onClick={() => setShareOpen(false)}>
            <Text className="sc-act__cta-txt">点我报名 · 加入球局</Text>
          </View>
        </View>
      </View>
    </ShareCard>
  );

  return (
    <PageFrame title={act.title} activeTab="home" footer={actionsNode} footerBare overlay={shareOverlay}>
      <View className="act__body">
        {/* 活动信息卡（状态 + 时间/地点/玩法，下沉自原绿色 Hero）*/}
        <View className="act__info">
          <View className="act__badge">{heroBadge}</View>
          <View className="act__meta">
            <View className="act__meta-row">
              <Icon name="clock" size={15} color="rgba(255,255,255,0.92)" />
              <Text className="act__meta-txt num">{fmtRange(act.startAt, act.endAt)}</Text>
            </View>
            <View className="act__meta-row">
              <Icon name="pin" size={15} color="rgba(255,255,255,0.92)" />
              <Text className="act__meta-txt">
                {act.venue} · {act.courtCount} 片场地
              </Text>
            </View>
            <View className="act__meta-row">
              <Icon name="court" size={15} color="rgba(255,255,255,0.92)" />
              <Text className="act__meta-txt">
                {playTypeText(act.playType)}
                {act.mixedDoubles ? ' · 混双' : ''} · {modeText(act.defaultMode)}
              </Text>
            </View>
          </View>
        </View>

        <View className="card">
          <View className="card__head">
            <Text className="card__title">报名名单</Text>
            <Text className="card__count num">
              {act.signedUpCount} <Text className="card__count-cap">/ {act.capacity}</Text>
            </Text>
          </View>

          {signed.length === 0 && waitlist.length === 0 && leave.length === 0 ? (
            <Empty text="还没有人报名" hint="把球局分享给球友，召集开打" />
          ) : (
            <>
              <WallSection title="已报名" tone="success" items={signed} hostId={act.hostId} />
              <WallSection title="候补" tone="warn" items={waitlist} hostId={act.hostId} />
              <WallSection title="请假" tone="muted" items={leave} hostId={act.hostId} />
            </>
          )}
        </View>

        {cleanRemark(act.remark) ? (
          <View className="card card--note">
            <Text className="card__note-label">局长留言</Text>
            <Text className="card__note-txt">{cleanRemark(act.remark)}</Text>
          </View>
        ) : null}

        {/* 分享卡入口：打开可见预览，再转发（替代原生 openType=share） */}
        {!cancelled ? (
          <View className="act__share-btn" onClick={() => setShareOpen(true)}>
            <Icon name="share" size={17} color="#16a34a" />
            <Text className="act__share-btn-txt">分享球局 · 召集球友</Text>
          </View>
        ) : null}
      </View>

    </PageFrame>
  );
}

/** 三类名单区块：头像 + 昵称 + 人数，多于 8 人折叠为 +N；带人显示「+N」 */
function WallSection(props: { title: string; tone: 'success' | 'warn' | 'muted'; items: SignupVM[]; hostId: number }) {
  const { title, tone, items, hostId } = props;
  if (items.length === 0) return null;
  const MAX = 8;
  const shown = items.slice(0, MAX);
  const overflow = items.length - shown.length;
  return (
    <View className="wall-sec">
      <View className="wall-sec__head">
        <Tag text={title} tone={tone} />
        <Text className="wall-sec__count num">{items.length} 人</Text>
      </View>
      <View className="wall-sec__grid">
        {shown.map((s) => {
          const host = s.user.id === hostId;
          return (
            <View key={s.id} className="wall-sec__item">
              <View className="wall-sec__av">
                <Avatar name={s.user.nickname} src={s.user.avatarUrl} size={40} ring={host} />
                {s.plusOne > 0 ? <Text className="wall-sec__plus num">+{s.plusOne}</Text> : null}
              </View>
              <Text className="wall-sec__name">{host ? `${s.user.nickname}·局长` : s.user.nickname}</Text>
            </View>
          );
        })}
        {overflow > 0 ? (
          <View className="wall-sec__item">
            <View className="wall-sec__more">+{overflow}</View>
            <Text className="wall-sec__name"> </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** 局长操作：编辑 + 主操作（开始签到/分组 或 查看看板/结算）+ 取消 */
function HostActions(props: {
  act: ActivityVM;
  id: number;
  busy: boolean;
  onCancel: () => void;
}) {
  const { act, id, busy, onCancel } = props;
  const cancelled = act.status === ActivityStatus.CANCELLED;
  const finished = act.status === ActivityStatus.FINISHED;
  const ongoing = act.status === ActivityStatus.ONGOING;

  if (cancelled) {
    return (
      <View className="act__bar">
        <Text className="act__bar-tip">该球局已取消</Text>
      </View>
    );
  }

  let mainText = '开始签到 / 分组';
  let mainGo: () => void = () => Taro.navigateTo({ url: `/pages/checkin/index?id=${id}` });
  if (finished) {
    mainText = '查看结算';
    mainGo = () => Taro.navigateTo({ url: `/pages/summary/index?id=${id}` });
  } else if (ongoing) {
    mainText = '继续比赛看板';
    mainGo = () => Taro.navigateTo({ url: `/pages/board/index?id=${id}` });
  }

  return (
    <View className="act__bar">
      {/* 编辑入口仅在「报名中」开放：进行中/已结束不可改时间/人数/场馆 */}
      {!finished && !ongoing ? (
        <View
          className="act__icon-btn"
          onClick={() => Taro.navigateTo({ url: `/pages/create/index?id=${id}` })}
        >
          <Text className="act__icon">✎</Text>
        </View>
      ) : null}
      <View className="act__bar-main">
        <PrimaryButton text={mainText} onClick={mainGo} />
      </View>
      {!finished ? (
        <View className="act__icon-btn" onClick={() => !busy && onCancel()}>
          <Text className="act__icon act__icon--danger">✕</Text>
        </View>
      ) : null}
    </View>
  );
}

/** +1 带人：弹确认选择带 1/2 人 */
async function pickPlusOne(): Promise<number | null> {
  try {
    const res = await Taro.showActionSheet({ itemList: ['带 1 人', '带 2 人'] });
    return res.tapIndex + 1;
  } catch {
    return null; // 用户取消
  }
}

/** 球友操作：自助签到 / 报名 / +1 / 取消 / 请假，按当前报名态切换 */
function GuestActions(props: {
  act: ActivityVM;
  mine: SignupStatus | null;
  full: boolean;
  busy: boolean;
  id: number;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { act, mine, full, busy, id, run } = props;
  const cancelled = act.status === ActivityStatus.CANCELLED;
  const finished = act.status === ActivityStatus.FINISHED;
  const ongoing = act.status === ActivityStatus.ONGOING;

  if (cancelled) {
    return (
      <View className="act__bar">
        <Text className="act__bar-tip">该球局已取消</Text>
      </View>
    );
  }
  if (finished) {
    return (
      <View className="act__bar">
        <View className="act__bar-main">
          <PrimaryButton
            text="查看结算"
            variant="outline"
            onClick={() => Taro.navigateTo({ url: `/pages/summary/index?id=${id}` })}
          />
        </View>
      </View>
    );
  }
  if (ongoing) {
    return (
      <View className="act__bar">
        <View className="act__bar-main">
          <PrimaryButton
            text="进入比赛看板"
            onClick={() => Taro.navigateTo({ url: `/pages/board/index?id=${id}` })}
          />
        </View>
      </View>
    );
  }

  // 报名中
  if (mine === SignupStatus.SIGNED_UP) {
    const checkedIn = act.myCheckedIn ?? false;
    return (
      <View className="act__bar act__bar--col">
        {/* 主操作：自助签到 */}
        {checkedIn ? (
          <View className="act__checkin act__checkin--done" onClick={() => !busy && run(() => api.selfCheckin(id, false))}>
            <Icon name="check" size={16} color="#16a34a" />
            <Text className="act__checkin-txt">已到场签到 · 点此撤销</Text>
          </View>
        ) : (
          <View className="act__bar-main">
            <PrimaryButton text="我已到场 · 签到" disabled={busy} onClick={() => run(() => api.selfCheckin(id, true))} />
          </View>
        )}
        {/* 次操作 */}
        <View className="act__bar-row">
          <PrimaryButton text="请假" variant="outline" disabled={busy} onClick={() => run(() => api.leave(id))} />
          <PrimaryButton text="取消报名" variant="outline" disabled={busy} onClick={() => run(() => api.cancelSignup(id))} />
          <PrimaryButton
            text="+1 带人"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              const n = await pickPlusOne();
              if (n != null) run(() => api.signup(id, n));
            }}
          />
        </View>
      </View>
    );
  }
  if (mine === SignupStatus.WAITLIST) {
    return (
      <View className="act__bar">
        <View className="act__tag-wrap">
          <Tag text="候补中" tone="warn" />
        </View>
        <View className="act__bar-main">
          <PrimaryButton text="取消候补" variant="outline" disabled={busy} onClick={() => run(() => api.cancelSignup(id))} />
        </View>
      </View>
    );
  }
  if (mine === SignupStatus.LEAVE) {
    return (
      <View className="act__bar">
        <View className="act__tag-wrap">
          <Tag text="已请假" tone="muted" />
        </View>
        <View className="act__bar-main">
          <PrimaryButton text="重新报名" disabled={busy} onClick={() => run(() => api.signup(id))} />
        </View>
      </View>
    );
  }

  // 未报名
  return (
    <View className="act__bar">
      <View className="act__bar-main">
        <PrimaryButton
          text={full ? '加入候补' : '立即报名'}
          disabled={busy}
          onClick={() => run(() => api.signup(id))}
        />
      </View>
    </View>
  );
}
