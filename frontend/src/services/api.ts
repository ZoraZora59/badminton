import Taro from '@tarojs/taro';
import type { ApiResponse } from '@badminton/shared';
import { API_BASE, STORAGE_KEYS } from '../config';

export class ApiError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export function getToken(): string {
  return Taro.getStorageSync(STORAGE_KEYS.token) || '';
}
export function setToken(token: string): void {
  Taro.setStorageSync(STORAGE_KEYS.token, token);
}
export function clearToken(): void {
  Taro.removeStorageSync(STORAGE_KEYS.token);
  Taro.removeStorageSync(STORAGE_KEYS.user);
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export async function request<T>(method: Method, url: string, data?: unknown): Promise<T> {
  const token = getToken();
  // 非 GET 写操作即使无入参也要发 `{}`：微信默认 content-type=application/json，
  // 空体会触发 Fastify FST_ERR_CTP_EMPTY_JSON_BODY → 500（取消球局/请假/结束/候补转正等无 body 接口都受此影响）。
  const payload = method === 'GET' ? data : data ?? {};
  const res = await Taro.request({
    url: API_BASE + url,
    method,
    data: payload as Taro.request.Option['data'],
    header: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = res.data as ApiResponse<T> | undefined;
  if (res.statusCode === 401) {
    clearToken();
    throw new ApiError(body?.message || '登录已过期，请重试', 401);
  }
  if (!body || typeof body.code !== 'number') {
    throw new ApiError('网络异常，请稍后重试', -1);
  }
  if (body.code !== 0) {
    throw new ApiError(body.message || '请求失败', body.code);
  }
  return body.data;
}

export const http = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, data?: unknown) => request<T>('POST', url, data),
  patch: <T>(url: string, data?: unknown) => request<T>('PATCH', url, data),
  del: <T>(url: string, data?: unknown) => request<T>('DELETE', url, data),
};

/** 统一错误提示 */
export function toastError(e: unknown): void {
  const msg = e instanceof ApiError ? e.message : '操作失败';
  Taro.showToast({ title: msg, icon: 'none' });
}
