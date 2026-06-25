import { SkillLevel } from './enums';

export interface LevelDef {
  level: SkillLevel;
  /** 排序/平衡用的数值权重（越大越强） */
  weight: number;
  /** 标题，如「初阶」 */
  title: string;
  /** 一句话描述（选水平时必然读到，见设计稿⑩） */
  desc: string;
  /** 是否为默认水平 */
  default?: boolean;
}

/** 中羽业余分级 —— 与高保真设计稿⑩「选择水平·分级说明」逐字对齐 */
export const LEVELS: LevelDef[] = [
  { level: SkillLevel.L1, weight: 1, title: '新手', desc: '刚接触，发球/接发球不稳' },
  { level: SkillLevel.L2, weight: 2, title: '入门', desc: '能连续对拉多拍，规则熟悉' },
  { level: SkillLevel.L3, weight: 3, title: '初阶', desc: '会高远球/吊球，有基本步法', default: true },
  { level: SkillLevel.L4, weight: 4, title: '进阶', desc: '杀球有质量，能控落点、懂战术' },
  { level: SkillLevel.L5, weight: 5, title: '高阶', desc: '攻防转换快，多拍相持强' },
  { level: SkillLevel.L6, weight: 6, title: '高手', desc: '球队主力 / 接近专业水平' },
];

export const DEFAULT_LEVEL = SkillLevel.L3;

const WEIGHT_BY_LEVEL: Record<SkillLevel, number> = LEVELS.reduce((acc, l) => {
  acc[l.level] = l.weight;
  return acc;
}, {} as Record<SkillLevel, number>);

/** 水平 → 权重（平衡引擎用） */
export function levelWeight(level: SkillLevel): number {
  return WEIGHT_BY_LEVEL[level] ?? WEIGHT_BY_LEVEL[DEFAULT_LEVEL];
}

/** 展示名，如「中羽 L3」 */
export function levelLabel(level: SkillLevel): string {
  return `中羽 ${level}`;
}
