import { ActivityStatus, SignupStatus, GroupMode, PlayType } from '@badminton/shared';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** UTC ISO → Asia/Shanghai 固定 +8（不依赖设备时区） */
function cn(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getTime() + 8 * 3600 * 1000);
}

export function fmtMonthDay(iso: string): string {
  const d = cn(iso);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
export function fmtWeekday(iso: string): string {
  return `周${WEEK[cn(iso).getUTCDay()]}`;
}
export function fmtHM(iso: string): string {
  const d = cn(iso);
  const h = `${d.getUTCHours()}`.padStart(2, '0');
  const m = `${d.getUTCMinutes()}`.padStart(2, '0');
  return `${h}:${m}`;
}
/** 卡片时间：周六 19:00 */
export function fmtCardTime(iso: string): string {
  return `${fmtWeekday(iso)} ${fmtHM(iso)}`;
}
/** 详情时间：6月28日 周六 19:00–21:00 */
export function fmtRange(startIso: string, endIso?: string | null): string {
  const head = `${fmtMonthDay(startIso)} ${fmtWeekday(startIso)} ${fmtHM(startIso)}`;
  return endIso ? `${head}–${fmtHM(endIso)}` : head;
}

export function activityStatusText(s: ActivityStatus): string {
  return { SIGNUP: '报名中', ONGOING: '进行中', FINISHED: '已结束', CANCELLED: '已取消' }[s];
}
export function signupStatusText(s: SignupStatus): string {
  return { SIGNED_UP: '已报名', WAITLIST: '候补', LEAVE: '请假' }[s];
}
export function modeText(m: GroupMode): string {
  return m === GroupMode.BALANCED ? '智能平衡' : '自动轮转';
}
export function playTypeText(p: PlayType): string {
  return p === PlayType.DOUBLES ? '双打' : '单打';
}

/** 头像首字 */
export function initial(name: string): string {
  return name ? name.trim().slice(0, 1) : '?';
}

/**
 * 红线护栏（不碰钱）：剔除备注里含「AA / 费用 / 付款 / 现场结 / 收费 / 元/人」等
 * 暗示付款的小句，保证「小程序内不出现红线文案」——即便历史/线上脏数据仍含 AA，
 * 展示层也不会渲染。按中文标点切句，仅丢弃命中红线的小句，保留其余正常内容。
 */
const REDLINE_RE = /AA|现场结|费用|付款|收费|算账|凑钱|￥|元\s*\/\s*人|人均.*?元/i;
export function cleanRemark(remark?: string | null): string {
  if (!remark) return '';
  const clauses = remark
    .split(/[，,。；;、\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((c) => !REDLINE_RE.test(c));
  return clauses.length ? `${clauses.join('，')}。` : '';
}
