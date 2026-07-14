// @tarojs/taro 的手写最小 mock（经 vitest.config.ts 的 resolve.alias 生效）。
// 只实现 src/services/api.ts 实际用到的 API：getStorageSync / setStorageSync /
// removeStorageSync / request / showToast。全部状态留在模块内存里，测试可
// 直接 import 本文件读取或操控（alias 与相对路径解析到同一模块实例）。

interface RequestOption {
  url: string;
  method?: string;
  data?: unknown;
  header?: Record<string, string>;
}

interface MockResponse {
  statusCode: number;
  data?: unknown;
}

/** 内存版微信同步存储 */
const storage = new Map<string, unknown>();

/** 每次 Taro.request 收到的完整入参（按调用顺序），供断言 */
export const requestCalls: RequestOption[] = [];

/** 每次 Taro.showToast 收到的入参，供断言 */
export const toastCalls: Array<{ title: string; icon?: string }> = [];

/** 默认返回：HTTP 200 + code=0 */
const DEFAULT_RESPONSE: MockResponse = {
  statusCode: 200,
  data: { code: 0, message: 'ok', data: null },
};

let nextResponse: MockResponse = DEFAULT_RESPONSE;

/** 设定下一次 Taro.request 的返回（statusCode + body） */
export function __setNextResponse(res: MockResponse): void {
  nextResponse = res;
}

/** 读取 mock 存储（绕过 Taro API，供断言用） */
export function __getStorage(key: string): unknown {
  return storage.get(key);
}

/** 重置全部 mock 状态，每个用例 beforeEach 调用 */
export function __reset(): void {
  storage.clear();
  requestCalls.length = 0;
  toastCalls.length = 0;
  nextResponse = DEFAULT_RESPONSE;
}

function getStorageSync(key: string): unknown {
  // 与微信真实行为一致：key 不存在时返回空串而不是 undefined
  return storage.has(key) ? storage.get(key) : '';
}

function setStorageSync(key: string, value: unknown): void {
  storage.set(key, value);
}

function removeStorageSync(key: string): void {
  storage.delete(key);
}

async function request(option: RequestOption): Promise<MockResponse> {
  requestCalls.push(option);
  return nextResponse;
}

function showToast(option: { title: string; icon?: string }): void {
  toastCalls.push(option);
}

const Taro = {
  getStorageSync,
  setStorageSync,
  removeStorageSync,
  request,
  showToast,
};

export default Taro;
