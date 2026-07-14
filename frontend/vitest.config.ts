import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 前端单测配置：纯 node 环境跑 utils/services 层逻辑（不起小程序运行时）。
// '@tarojs/taro' 通过 alias 指向手写最小 mock（见 test/mocks/taro.ts），
// 只覆盖 services/api.ts 实际用到的 API，测试可直接 import mock 读取/操控状态。
export default defineConfig({
  resolve: {
    alias: {
      '@tarojs/taro': fileURLToPath(new URL('./test/mocks/taro.ts', import.meta.url)),
      // 与 tsconfig.json 的 paths（"@/*": ["src/*"]）保持一致
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
