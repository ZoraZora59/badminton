/** 业务错误：携带统一响应包的 code 与 HTTP 状态 */
export class AppError extends Error {
  code: number;
  httpStatus: number;
  constructor(message: string, code = 1, httpStatus = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const Errors = {
  unauthorized: (msg = '未登录或登录已过期') => new AppError(msg, 401, 401),
  forbidden: (msg = '无权操作') => new AppError(msg, 403, 403),
  notFound: (msg = '资源不存在') => new AppError(msg, 404, 404),
  badRequest: (msg = '参数错误') => new AppError(msg, 400, 400),
  conflict: (msg = '状态冲突') => new AppError(msg, 409, 409),
};
