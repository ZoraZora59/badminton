import { ActivityStatus, type ActivityVM } from '@badminton/shared';

/** 首页单列表可见的状态与优先级：进行中 → 报名中 → 已结束（已取消不进列表） */
const LIST_ORDER: Partial<Record<ActivityStatus, number>> = {
  [ActivityStatus.ONGOING]: 0,
  [ActivityStatus.SIGNUP]: 1,
  [ActivityStatus.FINISHED]: 2,
};

type Sortable = Pick<ActivityVM, 'status' | 'updatedAt'>;

/**
 * 首页球局列表排序真源。首页去掉「报名中/进行中/已结束」筛选栏后，
 * 由这个固定顺序替代 tab 切换：
 * - 优先级：进行中 → 报名中 → 已结束；已取消整条过滤掉（原来三个 tab 也取不到它）
 * - 组内按 `updatedAt` **倒序**：最近有状态变化（建局/开打/结束/编辑）的排最上面
 *
 * 不用 `startAt` 排是刻意的：按开打时间排会让「放了几周没人开打的僵尸局」
 * 靠日期赖在固定位置，而按变化时间排，久无动静的局会自然沉下去。
 */
export function sortHomeActivities<T extends Sortable>(list: readonly T[]): T[] {
  return list
    .filter((a) => LIST_ORDER[a.status] !== undefined)
    .slice()
    .sort((x, y) => {
      const diff = (LIST_ORDER[x.status] as number) - (LIST_ORDER[y.status] as number);
      if (diff !== 0) return diff;
      return changedAt(y) - changedAt(x);
    });
}

/**
 * 取「最近状态变化时间」的毫秒值。取不到就当 0 沉到组尾——
 * 老版本后端还没吐 `updatedAt` 时，直接 `new Date(undefined)` 会得到 NaN，
 * 让比较器返回 NaN、整个列表退化成随机顺序，比排到最后糟得多。
 */
function changedAt(a: Sortable): number {
  const t = new Date(a.updatedAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 「已结束」分隔线该插在排序后列表的第几项之前；
 * 返回 -1 表示不画线（列表为空、全是未结束、或全是已结束时都没必要多一条线）。
 */
export function finishedDividerIndex(sorted: readonly Pick<ActivityVM, 'status'>[]): number {
  const i = sorted.findIndex((a) => a.status === ActivityStatus.FINISHED);
  return i > 0 ? i : -1;
}
