#!/usr/bin/env node
// Prisma CLI 包装器：从 config.<env>.yml 读取 database.url 注入 DATABASE_URL 后再执行 prisma。
// 目的：让数据库配置的唯一来源仍是 YAML 配置文件，而不依赖环境变量手工设置。
// 用法：node scripts/prisma.mjs <prisma args...> [--env=local|prod]
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
let env = 'local';
const passthrough = [];
for (const a of args) {
  if (a.startsWith('--env=')) env = a.slice('--env='.length);
  else passthrough.push(a);
}

const configPath = resolve(__dirname, `../config/config.${env}.yml`);
let cfg;
try {
  cfg = parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`[prisma wrapper] 无法读取配置 ${configPath}: ${e.message}`);
  process.exit(1);
}
const url = cfg?.database?.url;
if (!url) {
  console.error(`[prisma wrapper] config.${env}.yml 缺少 database.url`);
  process.exit(1);
}

// 用本地 node_modules/.bin/prisma（pnpm 不会把它放进 PATH），否则回退到 PATH 上的 prisma
const isWin = process.platform === 'win32';
const localBin = resolve(__dirname, `../node_modules/.bin/prisma${isWin ? '.cmd' : ''}`);
const prismaCmd = existsSync(localBin) ? localBin : 'prisma';

const res = spawnSync(prismaCmd, passthrough, {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
  cwd: resolve(__dirname, '..'),
  shell: isWin,
});
if (res.error) {
  console.error(`[prisma wrapper] 启动 prisma 失败: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
