import { describe, it, expect, beforeEach } from 'vitest';
import { loadScoreDraft, saveScoreDraft, clearScoreDraft } from '../src/services/scoreDraft';
import { __getStorage, __reset } from './mocks/taro';

// 计分草稿：锁屏/小程序被杀/onShow 重刷时，未提交的比分要能从本地缓存恢复。
// '@tarojs/taro' 已被 vitest alias 到 test/mocks/taro.ts（内存版同步存储）。

const KEY = 'badminton_score_drafts';
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  __reset();
});

describe('计分草稿本地暂存', () => {
  it('保存后可按 matchId 恢复比分', () => {
    saveScoreDraft(7, 11, 9);
    expect(loadScoreDraft(7)).toMatchObject({ scoreA: 11, scoreB: 9 });
    // number/string 形式的 matchId（路由参数是字符串）应指向同一条草稿
    expect(loadScoreDraft('7')).toMatchObject({ scoreA: 11, scoreB: 9 });
  });

  it('多场对局的草稿互不影响', () => {
    saveScoreDraft(1, 21, 15);
    saveScoreDraft(2, 5, 8);
    expect(loadScoreDraft(1)).toMatchObject({ scoreA: 21, scoreB: 15 });
    expect(loadScoreDraft(2)).toMatchObject({ scoreA: 5, scoreB: 8 });
  });

  it('提交成功后清除草稿，且不影响其它对局', () => {
    saveScoreDraft(1, 21, 15);
    saveScoreDraft(2, 5, 8);
    clearScoreDraft(1);
    expect(loadScoreDraft(1)).toBeNull();
    expect(loadScoreDraft(2)).toMatchObject({ scoreA: 5, scoreB: 8 });
  });

  it('超过 24 小时的草稿视为过期，读取返回 null 且落盘时被清理', () => {
    const t0 = 1_000_000;
    saveScoreDraft(1, 3, 2, t0);
    // 23 小时后仍可恢复
    expect(loadScoreDraft(1, t0 + 23 * HOUR)).toMatchObject({ scoreA: 3, scoreB: 2 });
    // 25 小时后过期
    expect(loadScoreDraft(1, t0 + 25 * HOUR)).toBeNull();
    // 过期后任一写操作会把过期项从存储里剔除
    saveScoreDraft(2, 1, 0, t0 + 25 * HOUR);
    const stored = __getStorage(KEY) as Record<string, unknown>;
    expect(stored['1']).toBeUndefined();
    expect(stored['2']).toBeDefined();
  });

  it('存储里是脏数据时不崩溃，按无草稿处理', () => {
    // 直接向底层塞坏数据：字符串、缺字段对象
    saveScoreDraft(9, 1, 1);
    const stored = __getStorage(KEY) as Record<string, unknown>;
    stored['bad'] = 'not-a-draft';
    stored['9'] = { scoreA: 'x' };
    expect(loadScoreDraft(9)).toBeNull();
    expect(loadScoreDraft('bad')).toBeNull();
  });
});
