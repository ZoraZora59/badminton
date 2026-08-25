import { ActivityStatus, type ActivityVM } from '@badminton/shared';

/** 首页单列表可见的状态与优先级：进行中 → 报名中 → 已结束（已取消不进列表） */
const LIST_ORDER: Partial<Record<ActivityStatus, number>> = {
  [ActivityStatus.ONGOING]: 0,
  [ActivityStatus.SIGNUP]: 1,
  [ActivityStatus.FINISHED]: 2,
};

type Sortable = Pick<ActivityVM, 'status' | 'startAt'>;

/**
 * 首页球局列表排序真源。首页去掉「报名中/进行中/已结束」筛选栏后，
 * 由这个固定顺序替代 tab 切换：
 * - 优先级：进行中 → 报名中 → 已结束；已取消整条过滤掉（原来三个 tab 也取不到它）
 * - 未结束按开打时间由近及远（最快要打的在最上面）
 * - 已结束按开打时间由新到旧（刚打完的在最上面），整体沉到列表底部
 */
export function sortHomeActivities<T extends Sortable>(list: readonly T[]): T[] {
  return list
    .filter((a) => LIST_ORDER[a.status] !== undefined)
    .slice()
    .sort((x, y) => {
      const diff = (LIST_ORDER[x.status] as number) - (LIST_ORDER[y.status] as number);
      if (diff !== 0) return diff;
      const tx = new Date(x.startAt).getTime();
      const ty = new Date(y.startAt).getTime();
      return x.status === ActivityStatus.FINISHED ? ty - tx : tx - ty;
    });
}

/**
 * 「已结束」分隔线该插在排序后列表的第几项之前；
 * 返回 -1 表示不画线（列表为空、全是未结束、或全是已结束时都没必要多一条线）。
 */
export function finishedDividerIndex(sorted: readonly Pick<ActivityVM, 'status'>[]): number {
  const i = sorted.findIndex((a) => a.status === ActivityStatus.FINISHED);
  return i > 0 ? i : -1;
}
