import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    config: AppConfig;
  }
}

/** 用 YAML 配置里的 database.url 构造 PrismaClient（运行时不依赖 DATABASE_URL 环境变量） */
export default fp(async function prismaPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const prisma = new PrismaClient({
    datasources: { db: { url: opts.config.database.url } },
  });
  await prisma.$connect();
  app.decorate('prisma', prisma);
  app.decorate('config', opts.config);
  app.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect();
  });
});
