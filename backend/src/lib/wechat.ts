import { AuthMode } from '@badminton/shared';
import type { AppConfig } from '../config';
import { AppError, Errors } from './errors';

export interface WechatSession {
  openid: string;
  unionid?: string;
  sessionKey?: string;
}

/**
 * 微信登录凭证校验：
 * - wechat 模式：调用 jscode2session 用 code 换 openid。
 * - mock 模式：跳过微信，直接用传入/生成的 openid（本地验证、接口自动化测试）。
 */
export async function code2session(
  cfg: AppConfig,
  opts: { code?: string; mockOpenid?: string },
): Promise<WechatSession> {
  if (cfg.auth.mode === AuthMode.MOCK) {
    const openid = opts.mockOpenid || `mock_${opts.code || Math.random().toString(36).slice(2, 10)}`;
    return { openid };
  }

  // wechat 模式
  if (!opts.code) throw Errors.badRequest('缺少 code');
  if (!cfg.auth.appId || !cfg.auth.appSecret) {
    throw new AppError('服务端未配置微信 appId/appSecret', 500, 500);
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', cfg.auth.appId);
  url.searchParams.set('secret', cfg.auth.appSecret);
  url.searchParams.set('js_code', opts.code);
  url.searchParams.set('grant_type', 'authorization_code');

  const resp = await fetch(url, { method: 'GET' });
  const json = (await resp.json()) as {
    openid?: string;
    unionid?: string;
    session_key?: string;
    errcode?: number;
    errmsg?: string;
  };
  if (json.errcode || !json.openid) {
    throw new AppError(`微信登录失败: ${json.errmsg || 'unknown'} (${json.errcode ?? '-'})`, 401, 401);
  }
  return { openid: json.openid, unionid: json.unionid, sessionKey: json.session_key };
}
