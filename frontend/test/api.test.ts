import { describe, it, expect, beforeEach } from 'vitest';
import { request, setToken, getToken, ApiError } from '../src/services/api';
import { STORAGE_KEYS } from '../src/config';
import { requestCalls, __setNextResponse, __getStorage, __reset } from './mocks/taro';

// src/services/api.ts 里的 `import Taro from '@tarojs/taro'` 已由
// vitest.config.ts 的 alias 指到 test/mocks/taro.ts，这里直接 import 同一
// 模块实例来读取/操控 mock 状态。
// 注意：不断言 API_BASE 的具体值（有脚本会临时改它），只断言 url 以路径结尾。

beforeEach(() => {
  __reset();
});

describe('request 包装器', () => {
  it('非 GET 且未传 data → 底层收到 data:{}（Fastify 空 JSON body 500 回归保护）', async () => {
    // 微信默认 content-type=application/json，空体会触发
    // FST_ERR_CTP_EMPTY_JSON_BODY → 500；包装器必须兜底补 `{}`。
    await request('POST', '/activities/1/cancel');
    expect(requestCalls).toHaveLength(1);
    expect(requestCalls[0].method).toBe('POST');
    expect(requestCalls[0].url.endsWith('/activities/1/cancel')).toBe(true);
    expect(requestCalls[0].data).toEqual({});

    await request('DELETE', '/signups/1');
    expect(requestCalls[1].data).toEqual({});
  });

  it('GET 未传 data → 不注入 {}，保持 undefined（锁定现状）', async () => {
    await request('GET', '/activities');
    expect(requestCalls[0].data).toBeUndefined();
  });

  it('非 GET 显式传 data → 原样透传', async () => {
    await request('POST', '/activities', { title: '周六约球' });
    expect(requestCalls[0].data).toEqual({ title: '周六约球' });
  });

  it('已登录时带 authorization: Bearer 头', async () => {
    setToken('tk-abc');
    await request('GET', '/me');
    expect(requestCalls[0].header?.authorization).toBe('Bearer tk-abc');
  });

  it('HTTP 401 → 清 token/user 并抛 ApiError(401)', async () => {
    setToken('tk-expired');
    __setNextResponse({ statusCode: 401, data: { code: 401, message: '登录已过期', data: null } });

    await expect(request('GET', '/me')).rejects.toMatchObject({
      name: 'ApiError',
      code: 401,
      message: '登录已过期',
    });
    // token 与 user 两个 key 都要清掉
    expect(__getStorage(STORAGE_KEYS.token)).toBeUndefined();
    expect(__getStorage(STORAGE_KEYS.user)).toBeUndefined();
    expect(getToken()).toBe('');
  });

  it('HTTP 401 且 body 无 message → 用默认文案抛错', async () => {
    __setNextResponse({ statusCode: 401, data: undefined });
    await expect(request('GET', '/me')).rejects.toMatchObject({
      code: 401,
      message: '登录已过期，请重试',
    });
  });

  it('body.code !== 0 → 抛 ApiError 且携带 code/message', async () => {
    __setNextResponse({ statusCode: 200, data: { code: 1001, message: '名额已满', data: null } });

    let caught: unknown;
    try {
      await request('POST', '/activities/1/signup');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe(1001);
    expect((caught as ApiError).message).toBe('名额已满');
  });

  it('body 缺失或 code 非数字 → 抛 ApiError(-1) 网络异常', async () => {
    __setNextResponse({ statusCode: 200, data: undefined });
    await expect(request('GET', '/activities')).rejects.toMatchObject({
      code: -1,
      message: '网络异常，请稍后重试',
    });

    __setNextResponse({ statusCode: 200, data: { message: 'no code' } });
    await expect(request('GET', '/activities')).rejects.toMatchObject({ code: -1 });
  });

  it('code === 0 → 返回 data 字段', async () => {
    __setNextResponse({
      statusCode: 200,
      data: { code: 0, message: 'ok', data: { id: 7, title: '周六约球' } },
    });
    const data = await request<{ id: number; title: string }>('GET', '/activities/7');
    expect(data).toEqual({ id: 7, title: '周六约球' });
  });
});
