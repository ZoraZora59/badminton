import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { AuthMode } from '@badminton/shared';

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(3000),
  }),
  database: z.object({
    url: z.string().min(1, 'database.url 不能为空'),
  }),
  jwt: z.object({
    secret: z.string().min(1, 'jwt.secret 不能为空'),
    expiresIn: z.string().default('30d'),
  }),
  auth: z.object({
    mode: z.nativeEnum(AuthMode).default(AuthMode.MOCK),
    appId: z.string().default(''),
    appSecret: z.string().default(''),
  }),
  timezone: z.string().default('Asia/Shanghai'),
  cors: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** 从 argv 解析 --env（默认 local）。不从环境变量取业务/DB 配置值。 */
export function resolveEnv(argv: string[] = process.argv): 'local' | 'prod' {
  const arg = argv.find((a) => a.startsWith('--env='));
  const env = arg ? arg.slice('--env='.length) : 'local';
  if (env !== 'local' && env !== 'prod') {
    throw new Error(`未知环境 --env=${env}（仅支持 local | prod）`);
  }
  return env;
}

let cached: AppConfig | null = null;

export function loadConfig(env = resolveEnv()): AppConfig {
  if (cached) return cached;
  const path = resolve(__dirname, `../../config/config.${env}.yml`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(
      `无法读取配置 ${path}（请从 config.${env}.example.yml 复制并填值）: ${(e as Error).message}`,
    );
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`配置 config.${env}.yml 校验失败:\n${parsed.error.toString()}`);
  }
  cached = parsed.data;
  if (parsed.data.auth.mode === AuthMode.WECHAT && (!parsed.data.auth.appId || !parsed.data.auth.appSecret)) {
    // 仅警告：wechat 模式下缺 appId/appSecret 会导致登录失败
    // eslint-disable-next-line no-console
    console.warn('[config] auth.mode=wechat 但 appId/appSecret 为空，真实登录将失败');
  }
  return cached;
}

/** 测试用：重置缓存并以指定配置覆盖 */
export function __setConfigForTest(cfg: AppConfig): void {
  cached = cfg;
}
