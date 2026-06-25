// 共享枚举 —— 前后端唯一来源（single source of truth）

/** 性别（可选） */
export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  UNKNOWN = 'UNKNOWN',
}

/** 中羽业余分级 L1–L6（见 levels.ts 的文案与权重） */
export enum SkillLevel {
  L1 = 'L1',
  L2 = 'L2',
  L3 = 'L3',
  L4 = 'L4',
  L5 = 'L5',
  L6 = 'L6',
}

/** 活动状态：报名中 → 进行中 → 已结束 / 已取消 */
export enum ActivityStatus {
  SIGNUP = 'SIGNUP',
  ONGOING = 'ONGOING',
  FINISHED = 'FINISHED',
  CANCELLED = 'CANCELLED',
}

/** 玩法：双打 2v2 / 单打 1v1 */
export enum PlayType {
  DOUBLES = 'DOUBLES',
  SINGLES = 'SINGLES',
}

/** 分组模式：智能平衡 / 自动轮转 */
export enum GroupMode {
  BALANCED = 'BALANCED',
  ROTATION = 'ROTATION',
}

/** 轮转细分：美式 Americano / 墨式 Mexicano（仅 ROTATION 时有效） */
export enum RotationKind {
  AMERICANO = 'AMERICANO',
  MEXICANO = 'MEXICANO',
}

/** 报名状态：报名 / 候补 / 请假 */
export enum SignupStatus {
  SIGNED_UP = 'SIGNED_UP',
  WAITLIST = 'WAITLIST',
  LEAVE = 'LEAVE',
}

/** 对局状态：待开始 / 进行中 / 已结束 */
export enum MatchStatus {
  PENDING = 'PENDING',
  ONGOING = 'ONGOING',
  FINISHED = 'FINISHED',
}

/** 队伍标识 */
export enum Team {
  A = 'A',
  B = 'B',
}

/** 鉴权模式：真实微信 / 本地 mock */
export enum AuthMode {
  WECHAT = 'wechat',
  MOCK = 'mock',
}
