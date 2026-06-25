/**
 * 种子数据：在 badminton_dev 中构建一套贴合设计稿的演示数据。
 * 通过真实 service 逻辑生成（报名/候补/签到/分组/计分），保证数据自洽。
 * 运行：pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';
import { GroupMode, PlayType, RotationKind, Gender, SkillLevel } from '@badminton/shared';
import { loadConfig, resolveEnv } from '../src/config';
import { createActivity } from '../src/modules/activities/service';
import { signup } from '../src/modules/signups/service';
import { addGuest, batchCheckin, listParticipants } from '../src/modules/checkin/service';
import { confirmGrouping, previewGrouping } from '../src/modules/grouping/service';
import { getBoard, getSummary, scoreMatch } from '../src/modules/matches/service';

const cfg = loadConfig(resolveEnv());
const prisma = new PrismaClient({ datasources: { db: { url: cfg.database.url } } });

const AV = (n: string) => `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(n)}`;

interface SeedUser { nickname: string; openid: string; level: SkillLevel; gender: Gender }
const PEOPLE: SeedUser[] = [
  { nickname: '林丹丹', openid: 'seed_lin', level: SkillLevel.L3, gender: Gender.FEMALE },
  { nickname: '王小明', openid: 'seed_wang', level: SkillLevel.L4, gender: Gender.MALE },
  { nickname: '陈大锤', openid: 'seed_chen', level: SkillLevel.L3, gender: Gender.MALE },
  { nickname: '赵敏', openid: 'seed_zhao', level: SkillLevel.L2, gender: Gender.FEMALE },
  { nickname: '周杰', openid: 'seed_zhou', level: SkillLevel.L3, gender: Gender.MALE },
  { nickname: '李雷', openid: 'seed_li', level: SkillLevel.L3, gender: Gender.MALE },
  { nickname: '吴用', openid: 'seed_wu', level: SkillLevel.L4, gender: Gender.MALE },
  { nickname: '郑爽', openid: 'seed_zheng', level: SkillLevel.L2, gender: Gender.FEMALE },
  { nickname: '孙六', openid: 'seed_sun', level: SkillLevel.L1, gender: Gender.MALE },
  { nickname: '张三', openid: 'seed_zhang', level: SkillLevel.L2, gender: Gender.MALE },
];

async function clean() {
  await prisma.matchPlayer.deleteMany({});
  await prisma.match.deleteMany({});
  await prisma.round.deleteMany({});
  await prisma.participant.deleteMany({});
  await prisma.signup.deleteMany({});
  await prisma.activity.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.wechatAccount.deleteMany({});
}

async function makeUsers() {
  const ids: Record<string, number> = {};
  for (const p of PEOPLE) {
    const u = await prisma.user.create({
      data: {
        nickname: p.nickname,
        avatarUrl: AV(p.nickname),
        gender: p.gender,
        defaultLevel: p.level,
        wechatAccount: { create: { openid: p.openid } },
      },
    });
    ids[p.openid] = u.id;
  }
  return ids;
}

function nextSaturday(hour: number): Date {
  // 固定一个未来的周六，避免依赖运行时刻太多（仅演示）
  const base = new Date('2026-06-27T00:00:00+08:00'); // 周六
  base.setHours(hour, 0, 0, 0);
  return base;
}

async function main() {
  console.log(`[seed] env=${resolveEnv()} db=${cfg.database.url.replace(/:[^:@]*@/, ':****@')}`);
  await clean();
  const ids = await makeUsers();
  const hostId = ids['seed_lin'];

  // ===== 活动1：周六晚 · 高手羽你局（主演示，跑完整流程）=====
  const act = await createActivity(prisma, hostId, {
    title: '周六晚 · 高手羽你局',
    startAt: nextSaturday(19).toISOString(),
    endAt: nextSaturday(21).toISOString(),
    venue: '奥森羽毛球馆',
    courtCount: 3,
    capacity: 16,
    signupDeadline: nextSaturday(12).toISOString(),
    playType: PlayType.DOUBLES,
    defaultMode: GroupMode.BALANCED,
    remark: '自带球拍，提前 10 分钟到场热身。',
  });
  // 其余 9 人报名
  for (const p of PEOPLE.slice(1)) await signup(prisma, act.id, ids[p.openid], 0);
  // 一人请假（赵敏）→ 演示请假态
  // （保留赵敏报名，签到时不勾即可；这里改演示陈大锤请假）

  // 签到：勾 8 人到场（林/王/周/李/吴/郑/孙/张），并设本场水平；陈大锤、赵敏不到
  const signups = await prisma.signup.findMany({ where: { activityId: act.id }, include: { user: true } });
  const present = new Set(['seed_lin', 'seed_wang', 'seed_zhou', 'seed_li', 'seed_wu', 'seed_zheng', 'seed_sun', 'seed_zhang']);
  const openidOf = (userId: number) => PEOPLE.find((p) => ids[p.openid] === userId)!.openid;
  await batchCheckin(prisma, act.id, {
    items: signups.map((s) => ({
      signupId: s.id,
      checkedIn: present.has(openidOf(s.userId)),
    })),
  });
  // 加一个临时球友（无微信）
  await addGuest(prisma, act.id, { guestName: '临时-小白', level: SkillLevel.L2, gender: Gender.MALE });

  // 分组：智能平衡 双打 2 片场地 4 轮
  const participants = await listParticipants(prisma, act.id);
  const schedule = await previewGrouping(prisma, act.id, {
    participantIds: participants.map((p) => p.id),
    playType: PlayType.DOUBLES,
    mode: GroupMode.BALANCED,
    courtCount: 2,
    rounds: 4,
    seed: 42,
  });
  console.log(`[seed] 分组草稿：${schedule.rounds.length}轮 / 共${schedule.metrics.totalMatches}场 / 人均${schedule.metrics.appearancesMin}-${schedule.metrics.appearancesMax}场 / 每轮轮空${schedule.metrics.byePerRound}`);
  await confirmGrouping(prisma, act.id, hostId, schedule);

  // 计分：把第1、2轮的对局打完，制造今日榜数据
  const board = await getBoard(prisma, act.id);
  let scored = 0;
  for (const r of board.rounds.slice(0, 2)) {
    for (const m of r.matches) {
      const a = 21;
      const b = 15 + ((m.courtNo + r.index) % 6); // 15~20
      await scoreMatch(prisma, Number(m.id), hostId, a, b);
      scored++;
    }
  }
  const summary = await getSummary(prisma, act.id);
  console.log(`[seed] 已计分 ${scored} 场，今日榜 TOP1: ${summary.mvp?.displayName} (+${summary.mvp?.points})`);

  // ===== 活动2：周日上午 · 新手友谊赛（满员候补演示，capacity=8）=====
  const act2 = await createActivity(prisma, ids['seed_wang'], {
    title: '周日上午 · 新手友谊赛',
    startAt: new Date('2026-06-28T09:00:00+08:00').toISOString(),
    venue: '体育大学馆',
    courtCount: 2,
    capacity: 8,
    playType: PlayType.DOUBLES,
    defaultMode: GroupMode.ROTATION,
    remark: '新手友好，轮转个人积分赛。',
  });
  // 王小明(host)已占1，再报 9 人 → 8 满员，后续转候补
  for (const p of PEOPLE.filter((x) => x.openid !== 'seed_wang')) await signup(prisma, act2.id, ids[p.openid], 0);
  const counts2 = await prisma.signup.groupBy({ by: ['status'], where: { activityId: act2.id }, _count: true });
  console.log('[seed] 活动2 报名分布:', counts2.map((c) => `${c.status}:${c._count}`).join(' '));

  console.log('[seed] 完成 ✅ 活动1#%d（进行中，有今日榜）/ 活动2#%d（满员候补）', act.id, act2.id);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('[seed] 失败:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
