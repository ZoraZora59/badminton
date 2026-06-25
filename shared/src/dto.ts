import {
  ActivityStatus,
  Gender,
  GroupMode,
  MatchStatus,
  PlayType,
  RotationKind,
  SignupStatus,
  SkillLevel,
  Team,
} from './enums';

// ============ 统一响应包 ============
export interface ApiResponse<T = unknown> {
  /** 0 = 成功，非 0 = 业务/系统错误 */
  code: number;
  message: string;
  data: T;
}

// ============ 用户 / 鉴权 ============
export interface UserVM {
  id: number;
  nickname: string;
  avatarUrl: string;
  gender: Gender;
  defaultLevel: SkillLevel;
  createdAt: string; // ISO，UTC
}

/** POST /auth/login */
export interface LoginReq {
  /** 真实微信：wx.login 拿到的 code */
  code?: string;
  /** 本地 mock：可选指定 openid（不传则随机） */
  mockOpenid?: string;
}
export interface LoginResp {
  token: string;
  user: UserVM;
  /** 是否新建用户（首次登录） */
  isNew: boolean;
}

/** PATCH /users/me —— 打通微信头像/昵称，写入“我们自己的 User” */
export interface UpdateProfileReq {
  nickname?: string;
  avatarUrl?: string;
  gender?: Gender;
  defaultLevel?: SkillLevel;
}

// ============ 活动 ============
export interface ActivityMemberVM {
  id: number;
  nickname: string;
  avatarUrl: string;
}
export interface ActivityVM {
  id: number;
  hostId: number;
  hostNickname: string;
  title: string;
  startAt: string;
  endAt: string | null;
  venue: string;
  courtCount: number;
  capacity: number;
  signupDeadline: string | null;
  playType: PlayType;
  defaultMode: GroupMode;
  /** 混双约束：每队尽量一男一女（仅双打有意义，分组时强制约束）。建局阶段设置 */
  mixedDoubles: boolean;
  remark: string | null;
  status: ActivityStatus;
  createdAt: string;
  // 聚合
  signedUpCount: number;
  waitlistCount: number;
  leaveCount: number;
  /** 报名头像墙预览（前若干位正选用户） */
  members: ActivityMemberVM[];
  /** 当前用户视角 */
  isHost?: boolean;
  mySignupStatus?: SignupStatus | null;
  /** 当前用户是否已签到（仅自己已报名时有意义） */
  myCheckedIn?: boolean;
}

export interface CreateActivityReq {
  title: string;
  startAt: string;
  endAt?: string | null;
  venue: string;
  courtCount: number;
  capacity: number;
  signupDeadline?: string | null;
  playType: PlayType;
  /** 分组模式改为开打时（分组向导）选择，建局不再设置；缺省落库 BALANCED */
  defaultMode?: GroupMode;
  /** 混双约束（仅双打）。不传按 false 处理 */
  mixedDoubles?: boolean;
  remark?: string | null;
}
export type UpdateActivityReq = Partial<CreateActivityReq>;

/** GET /activities/:id/share-card */
export interface ActivityShareCardVM {
  activityId: number;
  title: string;
  startAt: string;
  venue: string;
  signedUpCount: number;
  capacity: number;
  hostNickname: string;
}

// ============ 报名 / 候补 / 请假 ============
export interface SignupVM {
  id: number;
  activityId: number;
  user: UserVM;
  status: SignupStatus;
  plusOne: number;
  perGameLevel: SkillLevel | null;
  checkedIn: boolean;
  order: number;
  createdAt: string;
}

export interface CreateSignupReq {
  plusOne?: number;
}

// ============ 参赛者（真人 / 临时 Guest，分组与计分的统一身份）============
export interface ParticipantVM {
  id: number;
  activityId: number;
  userId: number | null; // null = Guest
  isGuest: boolean;
  displayName: string;
  avatarUrl: string | null;
  level: SkillLevel;
  gender: Gender;
  /** 该 Guest 由某条报名的「+1 带人」物化而来；null = 局长现场加的散客 */
  broughtBySignupId: number | null;
}

/** POST /activities/:id/participants —— 加临时球友 */
export interface AddGuestReq {
  guestName: string;
  level?: SkillLevel;
  gender?: Gender;
}

/** PATCH /activities/:id/participants/:pid —— 编辑临时球友（含 +1 带人占位）的昵称/水平/性别 */
export interface UpdateGuestReq {
  displayName?: string;
  level?: SkillLevel;
  gender?: Gender;
}

/** POST /activities/:id/checkin —— 批量签到/取消签到 + 设本场水平 */
export interface CheckinReq {
  items: Array<{ signupId: number; checkedIn: boolean; perGameLevel?: SkillLevel }>;
}

/** GET /activities/:id/checkin —— 签到清单（报名名单 + 已加 Guest） */
export interface CheckinListVM {
  signups: SignupVM[];
  guests: ParticipantVM[];
}

// ============ 分组 / 对阵 ============
export interface GroupingSettings {
  playType: PlayType;
  mode: GroupMode;
  rotation?: RotationKind; // mode=ROTATION 必填
  courtCount: number;
  rounds: number; // 轮数
  mixedDoubles?: boolean; // 混双约束
  /** 确定性随机种子（测试/重排用） */
  seed?: number;
}

/** POST /activities/:id/grouping/preview */
export interface GroupingPreviewReq extends GroupingSettings {
  participantIds: number[];
}

export interface MatchTeamVM {
  team: Team;
  participants: ParticipantVM[];
  /** 队伍总实力（平衡指标用） */
  strength: number;
}
export interface MatchVM {
  /** 草稿态为临时 id（roundIndex-courtNo），确认后为 DB id */
  id: string | number;
  roundIndex: number;
  courtNo: number;
  teamA: MatchTeamVM;
  teamB: MatchTeamVM;
  /** 两队实力差（平衡模式展示「实力差 N」） */
  strengthGap: number;
  status: MatchStatus;
  scoreA: number | null;
  scoreB: number | null;
  winner: Team | null;
}
export interface RoundVM {
  index: number;
  matches: MatchVM[];
  /** 本轮轮空（休息）的参赛者 */
  byeParticipantIds: number[];
}
export interface ScheduleMetrics {
  totalMatches: number;
  rounds: number;
  /** 人均出场场次（min~max 展示为「4–5」） */
  appearancesMin: number;
  appearancesMax: number;
  /** 平均每轮轮空人数 */
  byePerRound: number;
  /** 重复搭档对数（越低越好） */
  repeatPartnerPairs: number;
  /** 重复对手对数 */
  repeatOpponentPairs: number;
  /** 混双约束下「无法满足男女搭配」的队伍数（0 = 全部满足；仅 mixedDoubles 时有意义） */
  mixedViolations: number;
}
export interface GroupingScheduleVM {
  settings: GroupingSettings;
  rounds: RoundVM[];
  metrics: ScheduleMetrics;
}

/** POST /activities/:id/grouping/confirm */
export interface ConfirmGroupingReq {
  schedule: GroupingScheduleVM;
}

/** POST /matches/:id/swap —— 拖拽换人微调 */
export interface SwapPlayersReq {
  participantA: number;
  participantB: number;
}

// ============ 看板 / 计分 ============
export interface BoardVM {
  activityId: number;
  status: ActivityStatus;
  currentRound: number;
  totalRounds: number;
  rounds: RoundVM[];
}

/** POST /matches/:id/score & PATCH（改判） */
export interface ScoreReq {
  scoreA: number;
  scoreB: number;
}

// ============ 结算 / 战绩 ============
export interface TodayRankRowVM {
  rank: number;
  participantId: number;
  userId: number | null;
  displayName: string;
  avatarUrl: string | null;
  /** 个人制：积分；队制：胜场 */
  points: number;
  wins: number;
  losses: number;
  pointDiff: number; // 净胜分
  winRate: number;
}
export interface SummaryVM {
  activityId: number;
  mode: GroupMode;
  mvp: TodayRankRowVM | null;
  rank: TodayRankRowVM[];
}

export interface UserStatsVM {
  user: UserVM;
  totalGames: number;
  wins: number;
  losses: number;
  winRate: number;
  points: number;
  bestPartner: { userId: number; displayName: string; avatarUrl: string | null } | null;
  nemesis: { userId: number; displayName: string; avatarUrl: string | null } | null;
  /** 近 N 局积分趋势（用于柱状图） */
  trend: number[];
}
