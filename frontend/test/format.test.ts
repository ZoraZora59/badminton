import { describe, it, expect } from 'vitest';
import { cleanRemark, fmtRange, fmtCardTime } from '../src/utils/format';

// ---------------------------------------------------------------------------
// cleanRemark：「v1 不碰钱」红线在展示层的唯一防线。
// 逐分支锁定 format.ts 内 REDLINE_RE 的实际匹配集：
//   /AA|现场结|费用|付款|收费|算账|凑钱|￥|元\s*\/\s*人|人均.*?元/i
// 按中文标点切句后仅剔除命中红线的小句，其余保留并用「，」重连、句尾补「。」。
// ---------------------------------------------------------------------------
describe('cleanRemark 红线护栏', () => {
  describe('REDLINE_RE 各正则分支（每分支至少一例）', () => {
    it('AA（含 i 标志的小写 aa）', () => {
      expect(cleanRemark('AA制')).toBe('');
      expect(cleanRemark('aa制均摊')).toBe('');
    });
    it('现场结', () => {
      expect(cleanRemark('打完现场结一下')).toBe('');
    });
    it('费用', () => {
      expect(cleanRemark('费用另说')).toBe('');
    });
    it('付款', () => {
      expect(cleanRemark('记得付款')).toBe('');
    });
    it('收费', () => {
      expect(cleanRemark('本场收费')).toBe('');
    });
    it('算账', () => {
      expect(cleanRemark('结束后一起算账')).toBe('');
    });
    it('凑钱', () => {
      expect(cleanRemark('大家凑钱订场')).toBe('');
    });
    it('￥（全角人民币符号）', () => {
      expect(cleanRemark('￥30')).toBe('');
    });
    it('元/人（斜杠两侧允许空白）', () => {
      expect(cleanRemark('30元/人')).toBe('');
      expect(cleanRemark('30 元 / 人')).toBe('');
    });
    it('人均X元（人均…元，中间任意内容）', () => {
      expect(cleanRemark('人均30元')).toBe('');
      expect(cleanRemark('人均三十元')).toBe('');
    });
  });

  it('混合备注：只剔除红线小句，正常小句保留', () => {
    expect(cleanRemark('自带球拍，费用AA，欢迎新手')).toBe('自带球拍，欢迎新手。');
  });

  it('纯红线备注：全部小句被剔除，返回空串', () => {
    expect(cleanRemark('AA制，人均30元。')).toBe('');
  });

  it('无红线备注：内容保留（标点会被规整为「，」分隔 + 句尾「。」）', () => {
    // 注意：实现并非严格「原样返回」——切句后统一用「，」重连并补句号，
    // 这里锁定该现状语义。
    expect(cleanRemark('自带球拍，欢迎新手')).toBe('自带球拍，欢迎新手。');
    expect(cleanRemark('带好球拍。')).toBe('带好球拍。');
    // 空格不是切句符，整句视为一个小句
    expect(cleanRemark('自带球拍 欢迎新手')).toBe('自带球拍 欢迎新手。');
  });

  it('空串 / undefined / null 兜底返回空串', () => {
    expect(cleanRemark('')).toBe('');
    expect(cleanRemark(undefined)).toBe('');
    expect(cleanRemark(null)).toBe('');
  });

  it('现状锁定：「结算」「价格」不在 REDLINE_RE 匹配集内，不会被剔除', () => {
    // 与直觉不符但按实现现状锁定：REDLINE_RE 只含「现场结」「算账」，
    // 「结算」「价格」两词单独出现均不命中任何分支。若产品要求把它们
    // 纳入红线，应改 format.ts 的 REDLINE_RE 并同步更新本用例。
    expect(cleanRemark('活动结束后结算')).toBe('活动结束后结算。');
    expect(cleanRemark('球票价格另议')).toBe('球票价格另议。');
  });
});

// ---------------------------------------------------------------------------
// 时间格式化：UTC ISO 输入 → 固定 +8（Asia/Shanghai）输出，不依赖设备时区。
// ---------------------------------------------------------------------------
describe('fmtCardTime / fmtRange 固定 +8 输出', () => {
  it('fmtCardTime：不跨日（UTC 11:00 → 北京 19:00）', () => {
    expect(fmtCardTime('2026-06-27T11:00:00.000Z')).toBe('周六 19:00');
  });

  it('fmtCardTime：跨日边界（UTC 周六 17:30 → 北京 周日 01:30）', () => {
    expect(fmtCardTime('2026-06-27T17:30:00.000Z')).toBe('周日 01:30');
  });

  it('fmtRange：不跨日（含结束时间）', () => {
    expect(fmtRange('2026-06-27T11:00:00.000Z', '2026-06-27T13:00:00.000Z')).toBe(
      '6月27日 周六 19:00–21:00',
    );
  });

  it('fmtRange：结束时间缺省时只输出开始', () => {
    expect(fmtRange('2026-06-27T11:00:00.000Z')).toBe('6月27日 周六 19:00');
    expect(fmtRange('2026-06-27T11:00:00.000Z', null)).toBe('6月27日 周六 19:00');
  });

  it('fmtRange：跨日边界（北京 23:00 开打、次日 01:00 结束，头部仍按开始日）', () => {
    expect(fmtRange('2026-06-27T15:00:00.000Z', '2026-06-27T17:00:00.000Z')).toBe(
      '6月27日 周六 23:00–01:00',
    );
  });

  it('fmtRange：跨年边界（UTC 12-31 16:30 → 北京 1月1日 00:30）', () => {
    expect(fmtRange('2026-12-31T16:30:00.000Z')).toBe('1月1日 周五 00:30');
  });
});
