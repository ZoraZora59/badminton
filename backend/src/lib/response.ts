import type { ApiResponse } from '@badminton/shared';

/** 成功响应包 */
export function ok<T>(data: T, message = 'ok'): ApiResponse<T> {
  return { code: 0, message, data };
}

/** 错误响应包 */
export function fail(message: string, code = 1): ApiResponse<null> {
  return { code, message, data: null };
}
