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
/**
 * 卡片时间：6月28日 周六 19:00
 * 必须带月日——首页一列球局里「这周六」和「下周六」只报星期会长得一模一样，
 * 用户点进去才知道点错了。
 */
export function fmtCardTime(iso: string): string {
  return `${fmtMonthDay(iso)} ${fmtWeekday(iso)} ${fmtHM(iso)}`;
}
/** 详情时间：6月28日 周六 19:00–21:00 */
export function fmtRange(startIso: string, endIso?: string | null): string {
  const head = `${fmtMonthDay(startIso)} ${fmtWeekday(startIso)} ${fmtHM(startIso)}`;
  return endIso ? `${head}–${fmtHM(endIso)}` : head;
}

/**
 * 首页问候语：按北京时间（固定 +8，和本文件其它时间函数同一口径，不看设备时区）
 * 分早上/上午/中午/下午/晚上/深夜六档。写死一句「下午好」的话，早上八点打开也是下午好，
 * 这是 App 第一屏第一行字。
 */
export function greetingText(now: Date = new Date()): string {
  const h = new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours();
  if (h < 5) return '夜深了，明早再开打';
  if (h < 9) return '早上好，热身走起';
  if (h < 11) return '上午好，约个下午局';
  if (h < 13) return '中午好，记得补水';
  if (h < 18) return '下午好，准备开打';
  if (h < 23) return '晚上好，球馆见';
  return '夜深了，明早再开打';
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
