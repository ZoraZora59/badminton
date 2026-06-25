import type {
  ActivityStatus,
  ActivityVM,
  AddGuestReq,
  BoardVM,
  CheckinListVM,
  CheckinReq,
  CreateActivityReq,
  GroupingPreviewReq,
  GroupingScheduleVM,
  LoginResp,
  MatchVM,
  ParticipantVM,
  SignupVM,
  SummaryVM,
  UpdateActivityReq,
  UpdateGuestReq,
  UpdateProfileReq,
  UserStatsVM,
  UserVM,
} from '@badminton/shared';
import { http } from './api';

/** 全部后端接口的类型化封装 —— 页面统一从这里调用 */
export const api = {
  // 鉴权
  login: (body: { code?: string; mockOpenid?: string }) => http.post<LoginResp>('/auth/login', body),

  // 用户
  getMe: () => http.get<UserVM>('/users/me'),
  updateMe: (body: UpdateProfileReq) => http.patch<UserVM>('/users/me', body),
  getUser: (id: number) => http.get<UserVM>(`/users/${id}`),
  getUserStats: (id: number) => http.get<UserStatsVM>(`/users/${id}/stats`),

  // 活动
  createActivity: (body: CreateActivityReq) => http.post<ActivityVM>('/activities', body),
  listActivities: (status?: ActivityStatus) =>
    http.get<ActivityVM[]>(`/activities${status ? `?status=${status}` : ''}`),
  getActivity: (id: number) => http.get<ActivityVM>(`/activities/${id}`),
  updateActivity: (id: number, body: UpdateActivityReq) => http.patch<ActivityVM>(`/activities/${id}`, body),
  cancelActivity: (id: number) => http.post<ActivityVM>(`/activities/${id}/cancel`),

  // 报名
  signup: (id: number, plusOne = 0) => http.post<SignupVM>(`/activities/${id}/signups`, { plusOne }),
  cancelSignup: (id: number) => http.del<{ cancelled: boolean }>(`/activities/${id}/signups/me`),
  leave: (id: number) => http.post<SignupVM>(`/activities/${id}/signups/me/leave`),
  getSignups: (id: number) => http.get<SignupVM[]>(`/activities/${id}/signups`),

  // 签到 / 参赛者
  getCheckin: (id: number) => http.get<CheckinListVM>(`/activities/${id}/checkin`),
  batchCheckin: (id: number, body: CheckinReq) => http.post<CheckinListVM>(`/activities/${id}/checkin`, body),
  selfCheckin: (id: number, checkedIn = true) => http.post<SignupVM>(`/activities/${id}/checkin/me`, { checkedIn }),
  addGuest: (id: number, body: AddGuestReq) => http.post<ParticipantVM>(`/activities/${id}/participants`, body),
  updateGuest: (id: number, pid: number, body: UpdateGuestReq) =>
    http.patch<ParticipantVM>(`/activities/${id}/participants/${pid}`, body),
  removeGuest: (id: number, pid: number) => http.del<{ ok: boolean }>(`/activities/${id}/participants/${pid}`),
  listParticipants: (id: number) => http.get<ParticipantVM[]>(`/activities/${id}/participants`),
  promote: (id: number, signupId: number) => http.post<SignupVM[]>(`/activities/${id}/signups/${signupId}/promote`),

  // 分组
  previewGrouping: (id: number, body: GroupingPreviewReq) =>
    http.post<GroupingScheduleVM>(`/activities/${id}/grouping/preview`, body),
  confirmGrouping: (id: number, schedule: GroupingScheduleVM) =>
    http.post<BoardVM>(`/activities/${id}/grouping/confirm`, { schedule }),

  // 看板 / 计分 / 结算
  getBoard: (id: number) => http.get<BoardVM>(`/activities/${id}/board`),
  getSummary: (id: number) => http.get<SummaryVM>(`/activities/${id}/summary`),
  finishActivity: (id: number) => http.post<{ finished: boolean }>(`/activities/${id}/finish`),
  score: (matchId: number, scoreA: number, scoreB: number) =>
    http.post<MatchVM>(`/matches/${matchId}/score`, { scoreA, scoreB }),
  rejudge: (matchId: number, scoreA: number, scoreB: number) =>
    http.patch<MatchVM>(`/matches/${matchId}/score`, { scoreA, scoreB }),
  swap: (matchId: number, participantA: number, participantB: number) =>
    http.post<BoardVM>(`/matches/${matchId}/swap`, { participantA, participantB }),
};
