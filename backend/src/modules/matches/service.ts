import type { Prisma, PrismaClient } from '@prisma/client';
import type { BoardVM, MatchVM, SummaryVM, TodayRankRowVM } from '@badminton/shared';
import { ActivityStatus, GroupMode, MatchStatus, PlayType, Team } from '@badminton/shared';
import { Errors } from '../../lib/errors';
import { matchInclude, roundInclude, toMatchVM, toRoundVM } from './mapper';

/** 对阵看板 */
export async function getBoard(prisma: PrismaClient, activityId: number): Promise<BoardVM> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  const rounds = await prisma.round.findMany({
    where: { activityId },
    include: roundInclude,
    orderBy: { index: 'asc' },
  });
  const roundVMs = rounds.map(toRoundVM);
  const firstUnfinished = roundVMs.find((r) => r.matches.some((m) => m.status !== MatchStatus.FINISHED));
  const currentRound = firstUnfinished?.index ?? (roundVMs.length ? roundVMs[roundVMs.length - 1].index : 0);
  return {
    activityId,
    status: activity.status as ActivityStatus,
    // 局长身份随看板一起下发：前端判 isHost 不必再单独拉一次活动详情，
    // 少一条请求就少一次「那条挂了、局长静默变成围观视图、所有名单入口全没了」
    hostId: activity.hostId,
    currentRound,
    totalRounds: roundVMs.length,
    // 球馆真实场地号透传给看板：引擎里的 courtNo 恒为 1..N，展示层用 courtLabel() 翻成「5 号场」
    courtLabels: activity.courtLabels ?? null,
    rounds: roundVMs,
  };
}

async function loadMatch(prisma: PrismaClient, matchId: number) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { ...matchInclude, round: { include: { activity: true } } },
  });
  if (!match) throw Errors.notFound('对局不存在');
  return match;
}

/** 换人等排兵操作仍仅局长可做 */
async function loadMatchForHost(prisma: PrismaClient, matchId: number, hostId: number) {
  const match = await loadMatch(prisma, matchId);
  if (match.round.activity.hostId !== hostId) throw Errors.forbidden('仅局长可操作');
  return match;
}

/** 计分放开给全场：局长或本局任一参赛球友（含轮空者）都可录分/改判 */
async function loadMatchForScorer(prisma: PrismaClient, matchId: number, userId: number) {
  const match = await loadMatch(prisma, matchId);
  if (match.round.activity.hostId !== userId) {
    const participant = await prisma.participant.findFirst({
      where: { activityId: match.round.activityId, userId },
      select: { id: true },
    });
    if (!participant) throw Errors.forbidden('仅局长或本局球友可计分');
  }
  return match;
}

/** 计分 / 改判：定胜负（羽毛球不允许平局） */
export async function scoreMatch(
  prisma: PrismaClient,
  matchId: number,
  userId: number,
  scoreA: number,
  scoreB: number,
): Promise<MatchVM> {
  const match = await loadMatchForScorer(prisma, matchId, userId);
  if (scoreA === scoreB) throw Errors.badRequest('比分不能相同，需分出胜负');
  const winner = scoreA > scoreB ? Team.A : Team.B;
  await prisma.match.update({
    where: { id: matchId },
    data: { scoreA, scoreB, winner, status: MatchStatus.FINISHED },
  });

  // 本轮全部结束 → 轮次标记结束
  const siblings = await prisma.match.findMany({ where: { roundId: match.roundId } });
  if (siblings.every((m) => (m.id === matchId ? true : m.status === MatchStatus.FINISHED))) {
    await prisma.round.update({ where: { id: match.roundId }, data: { status: MatchStatus.FINISHED } });
  }

  const updated = await prisma.match.findUnique({ where: { id: matchId }, include: matchInclude });
  return toMatchVM(updated!, match.round.index);
}

/**
 * 「这一场刚被别人记完分」的统一提示。
 *
 * 看板是三片场地并行的：局长在改名单/换人时，别的场地随时可能正好点了保存比分。
 * 所有改 MatchPlayer / 删 Match 的写操作都必须把「目标对局仍是 PENDING」写进 SQL 的 WHERE 里
 * ——事务里的 findUnique 在 InnoDB 的 REPEATABLE READ 下读的是事务开始时的快照，
 * 再查一次也看不到刚提交的 FINISHED；只有条件写（deleteMany/updateMany）才走当前读并加锁。
 * 条件写影响行数为 0 = 抢跑了，整个事务回滚，让局长刷新后重来，绝不把已结束对局改掉。
 */
const RACED = () => Errors.conflict('这一场刚刚被记了比分，请下拉刷新看板后重试');

/**
 * 拖拽换人（同一轮内交换两名参赛者）—— 算法给草稿，人拍板。
 * 支持两种：①两人都在场上 → 互换场地/队伍；②一人在场上、一人轮空 → 轮空者上场、场上者下场。
 */
export async function swapPlayers(
  prisma: PrismaClient,
  matchId: number,
  hostId: number,
  participantA: number,
  participantB: number,
): Promise<BoardVM> {
  const match = await loadMatchForHost(prisma, matchId, hostId);
  const roundId = match.roundId;
  const round = await prisma.round.findUnique({ where: { id: roundId } });
  if (!round) throw Errors.notFound('轮次不存在');
  const byes = Array.isArray(round.byeJson) ? (round.byeJson as number[]) : [];

  const mpA = await prisma.matchPlayer.findFirst({ where: { participantId: participantA, match: { roundId } }, include: { match: true } });
  const mpB = await prisma.matchPlayer.findFirst({ where: { participantId: participantB, match: { roundId } }, include: { match: true } });

  const finished = (mp: typeof mpA) => mp?.match.status === MatchStatus.FINISHED;
  if (finished(mpA) || finished(mpB)) throw Errors.conflict('已结束的对局不可换人');

  if (mpA && mpB) {
    // 两人都在场上：互换 (matchId, team)。两次写都带 status=PENDING 守卫：
    // 上面那次 findFirst 到这里之间，任一场都可能刚被记完分，裸 update 会把已结束对局的人换掉。
    await prisma.$transaction(async (tx) => {
      const movedA = await tx.matchPlayer.updateMany({
        where: { id: mpA.id, match: { status: MatchStatus.PENDING } },
        data: { matchId: mpB.matchId, team: mpB.team },
      });
      if (movedA.count === 0) throw RACED();
      const movedB = await tx.matchPlayer.updateMany({
        where: { id: mpB.id, match: { status: MatchStatus.PENDING } },
        data: { matchId: mpA.matchId, team: mpA.team },
      });
      if (movedB.count === 0) throw RACED();
    });
  } else if (mpA && byes.includes(participantB)) {
    // B 轮空 → 顶替 A；A 下场轮空
    const newByes = byes.filter((x) => x !== participantB).concat(participantA);
    await prisma.$transaction(async (tx) => {
      const replaced = await tx.matchPlayer.updateMany({
        where: { id: mpA.id, match: { status: MatchStatus.PENDING } },
        data: { participantId: participantB },
      });
      if (replaced.count === 0) throw RACED();
      await tx.round.update({ where: { id: roundId }, data: { byeJson: newByes } });
    });
  } else if (mpB && byes.includes(participantA)) {
    const newByes = byes.filter((x) => x !== participantA).concat(participantB);
    await prisma.$transaction(async (tx) => {
      const replaced = await tx.matchPlayer.updateMany({
        where: { id: mpB.id, match: { status: MatchStatus.PENDING } },
        data: { participantId: participantA },
      });
      if (replaced.count === 0) throw RACED();
      await tx.round.update({ where: { id: roundId }, data: { byeJson: newByes } });
    });
  } else {
    throw Errors.badRequest('参赛者不在本轮对阵或轮空名单中');
  }

  return getBoard(prisma, round.activityId);
}

// ============ 开打后的名单变更（老李 9 点得走 / 隔壁球友临时跑来）============
//
// 现场真实情况是：确认开打不等于阵容定稿。有人提前撤、有人中途到，赛程必须还能改。
// 这里的红线只有一条——**已经打完的对局一个字都不能动**：Match 对 Round 是 onDelete: Cascade，
// 战绩、今日榜、跨局个人统计全都挂在 FINISHED 的 Match 上，动了就是数据丢失。
// 所以下面所有操作都只碰「还没打的 PENDING 对局」和轮空名单。

/**
 * 轮次 + 对局 + 上场名单：名单变更要同时看「场上」和「轮空」两侧。
 * 按 courtNo 升序取，让「补哪一场空位」「先处理哪一场」这类挑选是确定性的、可测的。
 */
const rosterRoundInclude = {
  matches: { include: { players: true }, orderBy: { courtNo: 'asc' } },
} satisfies Prisma.RoundInclude;

/** 读某轮的轮空名单（byeJson 是 Json 列，脏数据一律当空处理） */
function byesOf(round: { byeJson: Prisma.JsonValue | null }): number[] {
  return Array.isArray(round.byeJson) ? ([...round.byeJson] as number[]) : [];
}

/**
 * 这一轮算不算「还没打的将来」——名单变更只允许动将来。
 *
 * 有 PENDING 对局当然算；**一场对局都没有的空轮次也算**：那是上一次「没人可顶 → 整场撤掉」
 * 留下的坑。若把空轮次当历史跳过，走掉的人会永远挂在它的轮空名单里，看板一直显示「在场上」，
 * 局长再点「TA 要走了」也毫无反应；回来的人同样进不去，等于人被卡死在一个改不动的轮次里。
 * 只有「有对局且全部 FINISHED」才是历史，一个字都不能动。
 */
function isUpcomingRound(round: { matches: Array<{ status: string }> }): boolean {
  return round.matches.length === 0 || round.matches.some((m) => m.status !== MatchStatus.FINISHED);
}

/** 开打后改名单的公共守卫：活动存在 + 仅局长 + 必须 ONGOING + 该球友属于本活动 */
async function assertRosterEditable(
  prisma: PrismaClient,
  activityId: number,
  participantId: number,
  hostId: number,
) {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  if (activity.hostId !== hostId) throw Errors.forbidden('仅局长可调整名单');
  if ((activity.status as ActivityStatus) !== ActivityStatus.ONGOING) {
    throw Errors.conflict('仅开打中的球局可以调整名单');
  }
  const participant = await prisma.participant.findFirst({
    where: { id: participantId, activityId },
    select: { id: true },
  });
  if (!participant) throw Errors.notFound('该球友不在本场活动里');
  return activity;
}

/**
 * 「谁先上」的统一口径：整场出场次数最少的优先，并列取 participantId 最小。
 * 顶替、补位、重开一场都用它——同样的输入永远同样的结果，才解释得清也测得了。
 */
function pickOrder(appearances: Map<number, number>) {
  return (a: number, b: number) => (appearances.get(a) ?? 0) - (appearances.get(b) ?? 0) || a - b;
}

/** 统计每个 participant 在整场（含已结束对局）出场多少次 */
function countAppearances(rounds: Array<{ matches: Array<{ players: Array<{ participantId: number }> }> }>) {
  const m = new Map<number, number>();
  for (const round of rounds) {
    for (const match of round.matches) {
      for (const player of match.players) m.set(player.participantId, (m.get(player.participantId) ?? 0) + 1);
    }
  }
  return m;
}

/**
 * 提前离场：把某人从**后续还没打的对局**里摘掉，历史一个字不动。
 *
 * 顶替者规则（必须确定性，否则不可测也不可解释）：从本轮轮空名单里挑
 * 「整场活动出场次数最少」的人，并列时取 participantId 最小者——
 * 既是「谁坐得久谁先上」的现场公平感，也保证同样的输入永远同样的结果。
 *
 * 挑不出顶替者时（4 人 1 片场是最常见的小局，轮空名单恒为空）：**留空位，不撤场**。
 * 现实里这就是「三缺一」——场子还在，谁回来谁补上。上一版在这里整场撤掉，结果是死路：
 * 本轮没有对局 → 换人入口不出现；重新分组被 confirmGrouping 的「记过分就不许重排」挡回 409；
 * 进行中状态下活动页主按钮只有「继续比赛看板」，回不到分组页。人回来了也开不了场。
 * 唯一还得整场撤掉的情况是**他所在的那一队会被摘成 0 人**（单打，或 1v2 里再走掉那个 1），
 * 那是真的没法打，其余队员回轮空等下一轮。
 */
export async function withdrawParticipant(
  prisma: PrismaClient,
  activityId: number,
  participantId: number,
  hostId: number,
): Promise<BoardVM> {
  await assertRosterEditable(prisma, activityId, participantId, hostId);

  await prisma.$transaction(async (tx) => {
    const rounds = await tx.round.findMany({
      where: { activityId },
      include: rosterRoundInclude,
      orderBy: { index: 'asc' },
    });

    // 出场次数 = 该 participant 出现在多少个 Match 里（含已结束的）。
    // 随着本次改动实时增减：顶替上场 +1、被撤场 -1，后面几轮挑人才不会一直薅同一个人。
    const appearances = new Map<number, number>();
    const bump = (pid: number, delta: number) =>
      appearances.set(pid, Math.max(0, (appearances.get(pid) ?? 0) + delta));
    for (const round of rounds) {
      for (const match of round.matches) {
        for (const player of match.players) bump(player.participantId, 1);
      }
    }

    for (const round of rounds) {
      if (!isUpcomingRound(round)) continue; // 整轮打完了 = 历史，跳过
      const pendings = round.matches.filter((m) => m.status === MatchStatus.PENDING);

      let byes = byesOf(round);
      let byesChanged = false;

      // ① 本来就轮空 → 直接从轮空名单摘掉
      if (byes.includes(participantId)) {
        byes = byes.filter((id) => id !== participantId);
        byesChanged = true;
      }

      // ② 在本轮某个 PENDING 对局里 → 找人顶替，顶不了就撤场
      //    （理论上一人一轮只会出现在一场里，这里按数组处理，脏数据也能收敛）
      const mine = pendings.filter((m) => m.players.some((p) => p.participantId === participantId));
      for (const match of mine) {
        const row = match.players.find((p) => p.participantId === participantId);
        if (!row) continue;
        const onThisCourt = new Set(match.players.map((p) => p.participantId));
        // 已在同一场里的人不能当顶替者：MatchPlayer 有 @@unique([matchId, participantId])，
        // 盲目 update 会撞唯一键，直接把这种候选人跳过。
        const candidate = byes
          .filter((id) => !onThisCourt.has(id))
          .sort((a, b) => (appearances.get(a) ?? 0) - (appearances.get(b) ?? 0) || a - b)[0];

        if (candidate != null) {
          // 守卫 status=PENDING 写进 WHERE：上面那次 findMany 之后，这一场可能刚被别人记完分，
          // 裸 update 会把一条已结束对局的上场记录换成别人，战绩就记到不相干的人头上了
          const replaced = await tx.matchPlayer.updateMany({
            where: { id: row.id, match: { status: MatchStatus.PENDING } },
            data: { participantId: candidate },
          });
          if (replaced.count === 0) throw RACED();
          byes = byes.filter((id) => id !== candidate);
          byesChanged = true;
          bump(candidate, 1);
          bump(participantId, -1);
        } else if (match.players.some((p) => p.team === row.team && p.participantId !== participantId)) {
          // 没人可顶，但他那一队还剩人 → **只摘他这条上场记录，对局保留**（2v2 变 1v2）。
          // 空位由看板画出来（RoundVM.playType 告诉前端每队本该几个人），谁回来谁补上。
          // 同样带 status=PENDING 守卫：上面 findMany 之后这一场可能刚被记完分，
          // 裸 delete 会把一条已结束对局的上场记录抹掉，那人的战绩就凭空少一局
          const removed = await tx.matchPlayer.deleteMany({
            where: { id: row.id, match: { status: MatchStatus.PENDING } },
          });
          if (removed.count === 0) throw RACED();
          bump(participantId, -1);
        } else {
          // 他一走这队就 0 人（单打，或 1v2 里再走掉那个 1）→ 这场真打不了了：
          // 整场撤掉（PENDING 没有比分可丢），其余队员放回轮空等下一轮。
          // 同样带 status=PENDING 守卫——这里删的是整条 Match，级联带走 MatchPlayer，
          // 抢跑一旦发生就是把一场有比分的对局连同战绩删掉，是本模块唯一的不可逆写
          const removed = await tx.match.deleteMany({ where: { id: match.id, status: MatchStatus.PENDING } });
          if (removed.count === 0) throw RACED();
          const others = match.players
            .map((p) => p.participantId)
            .filter((id) => id !== participantId && !byes.includes(id));
          byes = byes.concat(others);
          byesChanged = true;
          for (const p of match.players) bump(p.participantId, -1);
        }
      }

      if (byesChanged) await tx.round.update({ where: { id: round.id }, data: { byeJson: byes } });
    }
    // 轮次多时事务里的往返也多，默认 5s 在远程库上偏紧，这里放宽一点
  }, { timeout: 20_000, maxWait: 10_000 });

  return getBoard(prisma, activityId);
}

/**
 * 中途归队：让人（晚到的球友、刚加的临时球友、先前撤了又回来的人）重新进入后续轮次。
 *
 * **优先补空位**：有人提前走会在场上留下待补的位置（2v2 变 1v2），归队第一件事就是把它填上——
 * 不然「三缺一」永远缺着，人回来了却只能干坐轮空，和当初直接撤场一样开不了局。
 * 本轮没有空位才退回原行为：放进轮空名单，谁下场谁上场由局长用已有的 swapPlayers 拍板。
 * 幂等：已经在场上就跳过，已在轮空名单里也不会重复追加。
 */
export async function rejoinParticipant(
  prisma: PrismaClient,
  activityId: number,
  participantId: number,
  hostId: number,
): Promise<BoardVM> {
  const activity = await assertRosterEditable(prisma, activityId, participantId, hostId);
  const mixed = activity.mixedDoubles === true;

  await prisma.$transaction(async (tx) => {
    const rounds = await tx.round.findMany({
      where: { activityId },
      include: rosterRoundInclude,
      orderBy: { index: 'asc' },
    });
    // 重开一场时要挑人，口径与顶替/补位保持一致（出场少的先上）
    const appearances = countAppearances(rounds);
    const order = pickOrder(appearances);
    // 混双只在「补位/重开」时作为**偏好**：满足不了也要让人回得来，不能因为性别配不上就把人晾着
    const genders = mixed
      ? new Map(
          (await tx.participant.findMany({ where: { activityId }, select: { id: true, gender: true } })).map(
            (x) => [x.id, x.gender as string],
          ),
        )
      : new Map<number, string>();
    const known = (g?: string) => g === 'MALE' || g === 'FEMALE';
    /** 把 pid 放进这支队伍是否满足混双（队里已有异性、或双方性别未知都算不违例） */
    const mixOk = (pid: number, mates: number[]) =>
      !mixed ||
      mates.every((m) => {
        const a = genders.get(pid);
        const b = genders.get(m);
        return !known(a) || !known(b) || a !== b;
      });

    for (const round of rounds) {
      if (!isUpcomingRound(round)) continue; // 打完的轮次不动；被撤空的轮次仍算将来，人要能回得去
      // 只看还没打的对局：已结束那场里有他，说明这一轮他早就打过了，
      // 既不该再补进别的场（一轮打两场），也不该塞进轮空（轮空=这轮没上场）
      const onCourt = round.matches.some(
        (m) => m.status === MatchStatus.PENDING && m.players.some((p) => p.participantId === participantId),
      );
      const playedThisRound = round.matches.some(
        (m) => m.status === MatchStatus.FINISHED && m.players.some((p) => p.participantId === participantId),
      );
      if (onCourt || playedThisRound) continue;
      let byes = byesOf(round);

      // ① 先找本轮缺人的 PENDING 对局。挑选必须确定性，否则不可测也没法跟局长解释：
      //    场号小的先补；同一场里人少的那队先补，两队一样少取 A 队。
      //    开了混双时，优先挑「补进去不会变成同性搭档」的位置，实在没有再退回第一个空位。
      const teamSize = (round.playType as PlayType) === PlayType.DOUBLES ? 2 : 1;
      const slots: Array<{ matchId: number; team: Team; fits: boolean }> = [];
      for (const match of round.matches) {
        if (match.status !== MatchStatus.PENDING) continue;
        // MatchPlayer 有 @@unique([matchId, participantId])：已在这场里就不能再补进来，会撞唯一键
        if (match.players.some((p) => p.participantId === participantId)) continue;
        const idsOf = (t: Team) => match.players.filter((p) => p.team === t).map((p) => p.participantId);
        const a = idsOf(Team.A);
        const b = idsOf(Team.B);
        const shortA = a.length < teamSize;
        const shortB = b.length < teamSize;
        if (!shortA && !shortB) continue; // 这场满员
        let team: Team;
        if (shortA && shortB) team = b.length < a.length ? Team.B : Team.A;
        else team = shortA ? Team.A : Team.B;
        slots.push({ matchId: match.id, team, fits: mixOk(participantId, team === Team.A ? a : b) });
      }
      const slot = slots.find((x) => x.fits) ?? slots[0] ?? null;

      if (slot) {
        // 补人之前先用一次条件写把这场锁住：事务里的 findMany 在 REPEATABLE READ 下读的是旧快照，
        // 再查一遍也看不到别人刚提交的 FINISHED；只有 updateMany 走当前读并加行锁。
        // 这是一次 no-op 写（PENDING 写成 PENDING），只为拿锁和拿 count——
        // 已实测 Prisma + MySQL 的 updateMany 返回的是 matched 行数，值没变照样算 1，
        // 所以 count===0 只可能是「这一场刚被记了比分」，让局长刷新后重来。
        const locked = await tx.match.updateMany({
          where: { id: slot.matchId, status: MatchStatus.PENDING },
          data: { status: MatchStatus.PENDING },
        });
        if (locked.count === 0) throw RACED();
        await tx.matchPlayer.create({ data: { matchId: slot.matchId, participantId, team: slot.team } });
        appearances.set(participantId, (appearances.get(participantId) ?? 0) + 1);
        // 已经上场就不该还挂在轮空名单上（先前被撤走时可能留过一条）
        if (byes.includes(participantId)) {
          await tx.round.update({
            where: { id: round.id },
            data: { byeJson: byes.filter((id) => id !== participantId) },
          });
        }
        continue;
      }

      // ② 本轮没有空位（对局都满员，或整轮已被撤空）→ 先进轮空名单（幂等，不重复塞）
      let byesChanged = false;
      if (!byes.includes(participantId)) {
        byes.push(participantId);
        byesChanged = true;
      }

      /*
       * ③ 整轮一场对局都没有、而轮空席已经够开一场 → 就地重开一场。
       *
       * 这是「人回来了却开不了场」死路的最后一块。撤人时只有「某一队被摘成 0 人」才会整场撤掉，
       * 而拼车、两口子成对离场是球场上最常见的走人方式——只要那两人在某轮同队，那一轮就会被撤空。
       * 若不能重开，他们回来时会出现「4 个人全挂轮空、本轮 0 场对局、补无可补」，
       * 而重新分组又被防删比分的守卫挡住（只要记过一局就 409），这一轮等于永久报废。
       * 更糟的是同一次离场里，他们分属不同队的轮次能靠空位救回来、同队的那轮却报废，
       * 局长完全无法预期哪一轮救得回来。
       *
       * 只在「这一轮本来就没有任何对局」时重开，所以永远不会碰到已结束的数据：
       * isUpcomingRound 已经把「有对局且全部打完」的轮次挡在外面了。
       */
      const perCourt = teamSize * 2;
      if (round.matches.length === 0 && byes.length >= perCourt) {
        const picked = [...byes].sort(order).slice(0, perCourt);
        // 混双偏好：能凑出「每队一男一女」就按这个排，凑不出就按出场少的顺序交替分队
        let lineup = picked;
        if (mixed && teamSize === 2) {
          const males = picked.filter((id) => genders.get(id) === 'MALE');
          const females = picked.filter((id) => genders.get(id) === 'FEMALE');
          if (males.length >= 2 && females.length >= 2) lineup = [males[0], females[0], males[1], females[1]];
        }
        const created = await tx.match.create({ data: { roundId: round.id, courtNo: 1 } });
        await tx.matchPlayer.createMany({
          data: lineup.map((pid, i) => ({
            matchId: created.id,
            participantId: pid,
            // 双打按 A,A,B,B 分队（混双时上面已排成 男,女,男,女）；单打就是 A vs B
            team: i < teamSize ? Team.A : Team.B,
          })),
        });
        for (const pid of lineup) appearances.set(pid, (appearances.get(pid) ?? 0) + 1);
        byes = byes.filter((id) => !lineup.includes(id));
        byesChanged = true;
      }

      if (byesChanged) await tx.round.update({ where: { id: round.id }, data: { byeJson: byes } });
    }
  }, { timeout: 20_000, maxWait: 10_000 });

  return getBoard(prisma, activityId);
}

/** 本场结算：今日榜 + MVP */
export async function getSummary(prisma: PrismaClient, activityId: number): Promise<SummaryVM> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  const rounds = await prisma.round.findMany({ where: { activityId }, include: roundInclude, orderBy: { index: 'asc' } });
  const mode = (rounds[0]?.mode as GroupMode) ?? (activity.defaultMode as GroupMode);

  interface Acc {
    participantId: number;
    userId: number | null;
    displayName: string;
    avatarUrl: string | null;
    points: number;
    wins: number;
    losses: number;
    pointDiff: number;
  }
  const map = new Map<number, Acc>();
  const ensure = (pid: number, name: string, avatar: string | null, userId: number | null): Acc => {
    let a = map.get(pid);
    if (!a) {
      a = { participantId: pid, userId, displayName: name, avatarUrl: avatar, points: 0, wins: 0, losses: 0, pointDiff: 0 };
      map.set(pid, a);
    }
    return a;
  };

  for (const r of rounds) {
    for (const m of r.matches) {
      if (m.status !== MatchStatus.FINISHED || m.winner == null || m.scoreA == null || m.scoreB == null) continue;
      for (const mp of m.players) {
        const p = mp.participant;
        const acc = ensure(p.id, p.displayName, p.user?.avatarUrl ?? null, p.userId);
        const scoreFor = mp.team === Team.A ? m.scoreA : m.scoreB;
        const scoreAgainst = mp.team === Team.A ? m.scoreB : m.scoreA;
        acc.points += scoreFor;
        acc.pointDiff += scoreFor - scoreAgainst;
        if (m.winner === mp.team) acc.wins += 1;
        else acc.losses += 1;
      }
    }
  }

  const rows = [...map.values()].sort((a, b) => {
    if (mode === GroupMode.BALANCED) {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.pointDiff - a.pointDiff;
    }
    if (b.points !== a.points) return b.points - a.points;
    return b.pointDiff - a.pointDiff;
  });

  const rank: TodayRankRowVM[] = rows.map((a, i) => {
    const games = a.wins + a.losses;
    return {
      rank: i + 1,
      participantId: a.participantId,
      userId: a.userId,
      displayName: a.displayName,
      avatarUrl: a.avatarUrl,
      points: a.points,
      wins: a.wins,
      losses: a.losses,
      pointDiff: a.pointDiff,
      winRate: games ? Math.round((a.wins / games) * 100) / 100 : 0,
    };
  });

  return { activityId, mode, mvp: rank[0] ?? null, rank };
}

/** 结束活动（收尾） */
export async function finishActivity(prisma: PrismaClient, activityId: number, hostId: number): Promise<void> {
  const activity = await prisma.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw Errors.notFound('活动不存在');
  if (activity.hostId !== hostId) throw Errors.forbidden('仅局长可操作');
  await prisma.activity.update({ where: { id: activityId }, data: { status: ActivityStatus.FINISHED } });
}
