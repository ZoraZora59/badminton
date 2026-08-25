import { describe, it, expect } from 'vitest';
import { ActivityStatus } from '@badminton/shared';
import { finishedDividerIndex, sortHomeActivities } from '../src/utils/activity';

// ---------------------------------------------------------------------------
// 首页去掉「报名中/进行中/已结束」筛选栏后，列表顺序成了用户找局的唯一依据：
// 排错了就等于把「刚有动静的局」埋进历史里。这里逐条锁死排序契约。
// 排序口径是 updatedAt（最近状态变化时间）倒序，不是 startAt。
// ---------------------------------------------------------------------------

type Row = { id: string; status: ActivityStatus; updatedAt: string };
const a = (id: string, status: ActivityStatus, updatedAt: string): Row => ({ id, status, updatedAt });
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('sortHomeActivities 首页单列表排序', () => {
  it('状态优先级压过时间：进行中 → 报名中 → 已结束', () => {
    // 故意让「已结束」的变化时间最新，验证它仍然沉在最后
    const list = [
      a('fin', ActivityStatus.FINISHED, '2026-08-25T10:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-08-20T10:00:00.000Z'),
      a('ongoing', ActivityStatus.ONGOING, '2026-08-01T10:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['ongoing', 'signup', 'fin']);
  });

  it('报名中组内按状态变化时间倒序：最近有动静的排最上面', () => {
    const list = [
      a('上个月建的', ActivityStatus.SIGNUP, '2026-07-20T10:00:00.000Z'),
      a('刚刚改过', ActivityStatus.SIGNUP, '2026-08-25T09:00:00.000Z'),
      a('上周建的', ActivityStatus.SIGNUP, '2026-08-18T10:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['刚刚改过', '上周建的', '上个月建的']);
  });

  it('已结束组内同样按变化时间倒序：刚打完的排在历史区最上面', () => {
    const list = [
      a('上个月打完', ActivityStatus.FINISHED, '2026-07-20T12:00:00.000Z'),
      a('昨天打完', ActivityStatus.FINISHED, '2026-08-24T12:00:00.000Z'),
      a('上周打完', ActivityStatus.FINISHED, '2026-08-18T12:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['昨天打完', '上周打完', '上个月打完']);
  });

  it('多个进行中之间也按变化时间倒序', () => {
    const list = [
      a('先开的', ActivityStatus.ONGOING, '2026-08-25T09:00:00.000Z'),
      a('刚开的', ActivityStatus.ONGOING, '2026-08-25T11:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['刚开的', '先开的']);
  });

  it('僵尸局会自然沉下去：久无动静的报名中局排在最近建的局之后', () => {
    const list = [
      a('僵尸局', ActivityStatus.SIGNUP, '2026-06-28T10:00:00.000Z'),
      a('今天刚建', ActivityStatus.SIGNUP, '2026-08-25T08:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['今天刚建', '僵尸局']);
  });

  it('已取消不进列表：和原来三个 tab 的可见集合保持一致', () => {
    const list = [
      a('cancelled', ActivityStatus.CANCELLED, '2026-08-25T10:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-08-20T10:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['signup']);
  });

  it('变化时间完全相同时不炸、不丢条目', () => {
    const same = '2026-08-25T10:00:00.000Z';
    const list = [
      a('a', ActivityStatus.SIGNUP, same),
      a('b', ActivityStatus.SIGNUP, same),
    ];
    expect(ids(sortHomeActivities(list)).sort()).toEqual(['a', 'b']);
  });

  it('后端没吐 updatedAt 时不炸、不打乱其它条目（沉到组尾）', () => {
    const list = [
      { id: '缺字段', status: ActivityStatus.SIGNUP, updatedAt: undefined as unknown as string },
      a('新', ActivityStatus.SIGNUP, '2026-08-25T10:00:00.000Z'),
      a('旧', ActivityStatus.SIGNUP, '2026-08-01T10:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['新', '旧', '缺字段']);
  });

  it('不改动入参数组（后端返回的原始顺序仍可复用）', () => {
    const list = [
      a('fin', ActivityStatus.FINISHED, '2026-08-24T10:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-08-20T10:00:00.000Z'),
    ];
    sortHomeActivities(list);
    expect(ids(list)).toEqual(['fin', 'signup']);
  });

  it('空列表返回空', () => {
    expect(sortHomeActivities([])).toEqual([]);
  });
});

describe('finishedDividerIndex 「已结束」分隔位置', () => {
  it('未结束 + 已结束混排：线画在第一条已结束之前', () => {
    const sorted = sortHomeActivities([
      a('fin', ActivityStatus.FINISHED, '2026-08-24T10:00:00.000Z'),
      a('ongoing', ActivityStatus.ONGOING, '2026-08-25T10:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-08-20T10:00:00.000Z'),
    ]);
    expect(finishedDividerIndex(sorted)).toBe(2);
  });

  it('全是已结束：不画线（-1），避免列表顶部多一条无意义的线', () => {
    const sorted = sortHomeActivities([
      a('f1', ActivityStatus.FINISHED, '2026-08-24T10:00:00.000Z'),
      a('f2', ActivityStatus.FINISHED, '2026-08-18T10:00:00.000Z'),
    ]);
    expect(finishedDividerIndex(sorted)).toBe(-1);
  });

  it('全是未结束：不画线（-1）', () => {
    const sorted = sortHomeActivities([a('s', ActivityStatus.SIGNUP, '2026-08-20T10:00:00.000Z')]);
    expect(finishedDividerIndex(sorted)).toBe(-1);
  });

  it('空列表：不画线（-1）', () => {
    expect(finishedDividerIndex([])).toBe(-1);
  });
});
