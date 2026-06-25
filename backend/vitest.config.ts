import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false, // engine(纯) 与 api(连远程DB) 串行，避免并发污染
    pool: 'forks',
  },
});
