import { buildApp } from './app';
import { loadConfig, resolveEnv } from './config';

async function main() {
  const env = resolveEnv();
  const config = loadConfig(env);
  const app = await buildApp(config);
  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    app.log.info(`[badminton] backend up on :${config.server.port} (env=${env}, auth=${config.auth.mode})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
