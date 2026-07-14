import { describe, it, expect } from 'vitest';
import { SkillLevel, LEVELS, DEFAULT_LEVEL, levelWeight, levelLabel } from '@badminton/shared';

// LEVELS 是分组平衡算法（levelWeight → EnginePlayer.weight）的直接输入，
// 这里锁定表结构与兜底行为，防止改文案/加档位时悄悄破坏权重语义。
describe('shared levels — 中羽分级表', () => {
  it('LEVELS 覆盖 L1~L6 且顺序一致', () => {
    expect(LEVELS).toHaveLength(6);
    expect(LEVELS.map((l) => l.level)).toEqual([
      SkillLevel.L1, SkillLevel.L2, SkillLevel.L3, SkillLevel.L4, SkillLevel.L5, SkillLevel.L6,
    ]);
  });

  it('权重严格单调递增（越大越强，平衡引擎依赖此序）', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].weight).toBeGreaterThan(LEVELS[i - 1].weight);
    }
  });

  it('每档都有非空 title 和 desc（选水平弹层必然展示）', () => {
    for (const l of LEVELS) {
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.desc.length).toBeGreaterThan(0);
    }
  });

  it('默认水平：DEFAULT_LEVEL=L2，且表中恰好这一档标了 default', () => {
    expect(DEFAULT_LEVEL).toBe(SkillLevel.L2);
    const defaults = LEVELS.filter((l) => l.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].level).toBe(DEFAULT_LEVEL);
  });
});

describe('shared levels — levelWeight / levelLabel', () => {
  it('levelWeight 与表中权重逐档一致', () => {
    for (const l of LEVELS) {
      expect(levelWeight(l.level)).toBe(l.weight);
    }
  });

  it('levelWeight 对未知值兜底为默认档权重', () => {
    // 现状语义：表里查不到时回退 DEFAULT_LEVEL(L2) 的权重，而不是抛错或返回 undefined
    const fallback = LEVELS.find((l) => l.level === DEFAULT_LEVEL)!.weight;
    expect(levelWeight('L99' as SkillLevel)).toBe(fallback);
    expect(levelWeight(undefined as unknown as SkillLevel)).toBe(fallback);
  });

  it('levelLabel 展示为「中羽 Lx」', () => {
    expect(levelLabel(SkillLevel.L3)).toBe('中羽 L3');
  });
});
