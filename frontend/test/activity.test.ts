import { describe, it, expect } from 'vitest';
import { ActivityStatus } from '@badminton/shared';
import { finishedDividerIndex, sortHomeActivities } from '../src/utils/activity';

// ---------------------------------------------------------------------------
// 首页去掉「报名中/进行中/已结束」筛选栏后，列表顺序成了用户找局的唯一依据：
// 排错了就等于把「今晚要打的局」埋进历史里。这里逐条锁死排序契约。
// ---------------------------------------------------------------------------

type Row = { id: string; status: ActivityStatus; startAt: string };
const a = (id: string, status: ActivityStatus, startAt: string): Row => ({ id, status, startAt });
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('sortHomeActivities 首页单列表排序', () => {
  it('状态优先级：进行中 → 报名中 → 已结束', () => {
    const list = [
      a('fin', ActivityStatus.FINISHED, '2026-06-20T11:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-06-28T11:00:00.000Z'),
      a('ongoing', ActivityStatus.ONGOING, '2026-06-25T11:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['ongoing', 'signup', 'fin']);
  });

  it('未结束按开打时间由近及远：最快要打的排最上面', () => {
    const list = [
      a('远', ActivityStatus.SIGNUP, '2026-07-10T11:00:00.000Z'),
      a('近', ActivityStatus.SIGNUP, '2026-06-26T11:00:00.000Z'),
      a('中', ActivityStatus.SIGNUP, '2026-06-30T11:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['近', '中', '远']);
  });

  it('已结束按时间由新到旧：刚打完的排在历史区最上面', () => {
    const list = [
      a('上个月', ActivityStatus.FINISHED, '2026-05-20T11:00:00.000Z'),
      a('昨天', ActivityStatus.FINISHED, '2026-06-24T11:00:00.000Z'),
      a('上周', ActivityStatus.FINISHED, '2026-06-18T11:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['昨天', '上周', '上个月']);
  });

  it('多个进行中之间同样按开打时间由近及远', () => {
    const list = [
      a('晚', ActivityStatus.ONGOING, '2026-06-25T13:00:00.000Z'),
      a('早', ActivityStatus.ONGOING, '2026-06-25T11:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['早', '晚']);
  });

  it('已取消不进列表：和原来三个 tab 的可见集合保持一致', () => {
    const list = [
      a('cancelled', ActivityStatus.CANCELLED, '2026-06-26T11:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-06-28T11:00:00.000Z'),
    ];
    expect(ids(sortHomeActivities(list))).toEqual(['signup']);
  });

  it('不改动入参数组（后端返回的原始顺序仍可复用）', () => {
    const list = [
      a('fin', ActivityStatus.FINISHED, '2026-06-20T11:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-06-28T11:00:00.000Z'),
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
      a('fin', ActivityStatus.FINISHED, '2026-06-20T11:00:00.000Z'),
      a('ongoing', ActivityStatus.ONGOING, '2026-06-25T11:00:00.000Z'),
      a('signup', ActivityStatus.SIGNUP, '2026-06-28T11:00:00.000Z'),
    ]);
    expect(finishedDividerIndex(sorted)).toBe(2);
  });

  it('全是已结束：不画线（-1），避免列表顶部多一条无意义的线', () => {
    const sorted = sortHomeActivities([
      a('f1', ActivityStatus.FINISHED, '2026-06-20T11:00:00.000Z'),
      a('f2', ActivityStatus.FINISHED, '2026-06-18T11:00:00.000Z'),
    ]);
    expect(finishedDividerIndex(sorted)).toBe(-1);
  });

  it('全是未结束：不画线（-1）', () => {
    const sorted = sortHomeActivities([a('s', ActivityStatus.SIGNUP, '2026-06-28T11:00:00.000Z')]);
    expect(finishedDividerIndex(sorted)).toBe(-1);
  });

  it('空列表：不画线（-1）', () => {
    expect(finishedDividerIndex([])).toBe(-1);
  });
});
