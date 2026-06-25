/**
 * 一次性数据修复：去除活动备注里的「AA 现场结」等红线文案（不碰钱红线）。
 * 走 loadConfig 读取对应环境的 DB（线上库凭证只在服务器 config.prod.yml 里）。
 *
 * 在【服务器】上运行（那里有 config.prod.yml）：
 *   cd /www/wwwroot/badminton/backend
 *   pnpm exec tsx scripts/fix-prod-aa.ts --env=prod
 * 本地 dev 库自检：
 *   pnpm --filter @badminton/backend exec tsx scripts/fix-prod-aa.ts --env=local
 */
import { PrismaClient } from '@prisma/client';
import { loadConfig, resolveEnv } from '../src/config';

const SAFE = '自带球拍，提前 10 分钟到场热身。';
const AA_EXACT = '自带球拍，AA 现场结。';
const SENSITIVE = ['AA', '现场结', '费用', '付款', '算账'];

const cfg = loadConfig(resolveEnv());
const prisma = new PrismaClient({ datasources: { db: { url: cfg.database.url } } });

async function main() {
  // 1) 精确替换已知 seed AA 备注（最安全：只动这一种）
  const exact = await prisma.activity.updateMany({
    where: { remark: AA_EXACT },
    data: { remark: SAFE },
  });
  console.log(`[fix] 精确替换「${AA_EXACT}」→「${SAFE}」：${exact.count} 条`);

  // 2) 复查是否还有任何含敏感词的备注（这些需人工确认，不自动覆盖）
  const left = await prisma.activity.findMany({
    where: { OR: SENSITIVE.map((s) => ({ remark: { contains: s } })) },
    select: { id: true, title: true, remark: true },
  });
  if (left.length === 0) {
    console.log('[fix] ✅ 复查：再无 AA/现场结/费用/付款/算账 文案');
  } else {
    console.log('[fix] ⚠️ 仍有含敏感词的备注（请人工确认后处理）：');
    for (const a of left) console.log(`   #${a.id} ${a.title} :: ${a.remark}`);
  }
}

main()
  .catch((e) => {
    console.error('[fix] 失败：', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
