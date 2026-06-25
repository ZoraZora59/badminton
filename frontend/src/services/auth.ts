import Taro from '@tarojs/taro';
import type { UserVM } from '@badminton/shared';
import { api } from './endpoints';
import { getToken, setToken } from './api';
import { getUser, setUser } from '../store/user';

/** 启动时确保已登录：有缓存直接用，否则走 wx.login → 后端换 JWT */
export async function ensureLogin(): Promise<UserVM> {
  const cached = getUser();
  if (getToken() && cached) return cached;
  return doLogin();
}

/** 微信一键登录（mock 模式下后端忽略 code 用模拟 openid） */
export async function doLogin(): Promise<UserVM> {
  let code: string | undefined;
  try {
    const res = await Taro.login();
    code = res.code;
  } catch {
    code = undefined;
  }
  const resp = await api.login({ code });
  setToken(resp.token);
  setUser(resp.user);
  return resp.user;
}

/** 退出登录 */
export function logout(): void {
  Taro.removeStorageSync('badminton_token');
  setUser(null);
}
