/**
 * DevTools UI/UX 验收门禁：用 miniprogram-automator 驱动微信开发者工具，
 * 注入 seed 局长(林丹丹)会话后逐页截图 + DOM 断言 + 一条真实报名回归路径。
 * 仅本地验收用（dist 指向 127.0.0.1:3000 的 mock 后端）。
 *
 * 门禁语义（对比旧版"截图器"）：
 *   - 业务 console error 数 > 0        → exit(1)
 *   - 任何 DOM/导航断言失败（累积清单）→ exit(1)
 *   - 脚本自身崩溃（DevTools 启动失败等）→ exit(2)
 *   - 全部通过                         → exit(0)
 *
 * 用法：LIN_TOKEN=.. LIN_USER='{...}' node ci/automator-verify.cjs
 * 前置：Node >= 18（依赖全局 fetch）；本地 mock 后端 :3000 在线；DevTools 已开服务端口。
 */
const automator = require('miniprogram-automator');
const path = require('path');
const fs = require('fs');

/* ═══════════════════ 硬编码契约常量区（seed / 环境变更需同步此处）═══════════════════ */

// —— 环境契约 ——
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'; // DevTools CLI 路径
const PROJECT = path.resolve(__dirname, '../dist');
const OUT = '/tmp/badminton-shots'; // 截图产物目录（verify-ui.sh 文档口径）
const API = process.env.VERIFY_API_BASE || 'http://127.0.0.1:3000/api'; // mock 后端
// 前端会话缓存键（frontend/src/config.ts STORAGE_KEYS，改键需同步）
const KEY_TOKEN = 'badminton_token';
const KEY_USER = 'badminton_user';

// —— seed 数据契约（backend/prisma/seed.ts，改 seed 需同步此处）——
// 注意：seed 的 clean() 用 deleteMany，MySQL 自增 id 不复位，活动 id 会随重跑漂移，
// 因此不写死 id，启动时经 API 按「标题」解析实际 id。
const SEED = {
  // 活动1「周六晚 · 高手羽你局」：capacity=16，10 人全员正选（无候补/请假），
  // 8 人签到 + 1 Guest = 9 人参赛，双打 2 片场地 4 轮 → 每轮 2 场、共 8 场，已计分前 2 轮。
  boardActivity: {
    title: '周六晚 · 高手羽你局',
    rounds: 4, // previewGrouping rounds=4
    matchesPerRound: 2, // courtCount=2，9 人双打每轮满排 2 场（1 人轮空）
  },
  // 活动2「周日上午 · 新手友谊赛」：capacity=8，host 王小明 + 9 人报名
  // → 正选 8（王小明/林丹丹/陈大锤/赵敏/周杰/李雷/吴用/郑爽）+ 候补 2（孙六/张三）+ 请假 0。
  fullActivity: {
    title: '周日上午 · 新手友谊赛',
    walls: { signed: 8, waitlist: 2, leave: 0 },
  },
  // 报名回归路径的第二身份：seed 普通球友张三（复用 seed 用户，避免 mock 登录
  // 在共享 dev 库新造 User 行；张三不是任何 seed 活动的局长）。
  secondIdentity: { mockOpenid: 'seed_zhang', nickname: '张三' },
};

// —— 页面 CSS 选择器契约（对应 frontend/src/pages/**，改 className 需同步）——
const SEL = {
  pageRoot: '.pf', // PageFrame 根节点（components/PageFrame）
  // 活动详情三类头像墙（pages/activity WallSection；空列表的区块不渲染）
  wallSection: '.wall-sec',
  wallTag: '.bm-tag', // 区块标题 Tag：已报名 / 候补 / 请假
  wallCount: '.wall-sec__count', // 文案形如「8 人」
  wallName: '.wall-sec__name', // 每个头像格的昵称（局长为「昵称·局长」）
  // 底部操作条按钮（components/PrimaryButton）：按 text 匹配「立即报名/取消报名」
  primaryBtn: '.bm-btn',
  // 对阵看板轮次切换（pages/board）
  boardSwitcherLabel: '.switcher__label', // 「第 N 轮 / 共 M 轮」
  boardSwitcherTotal: '.switcher__total', // 「/ 共 M 轮」（label 取不到文本时兜底）
  boardPrevArrow: '.switcher__arrow', // 首个匹配即左箭头
  boardNextArrow: '.switcher__arrow--next',
  boardCourt: '.court', // 当前轮每场对局一张卡
  // 战报分享卡入口（pages/summary）
  summaryShare: '.summary__share',
};

// —— 发起页红线词（CLAUDE.md「v1 不碰钱」；扫描 .pf 的 outerWxml，含 placeholder）——
const REDLINE_WORDS = [
  // AA 用边界匹配，避免误伤 class 名/编码串里的连续字母
  { label: 'AA', re: /(?<![A-Za-z0-9])AA(?![A-Za-z0-9])/ },
  { label: '费用', re: /费用/ },
  { label: '支付', re: /支付/ },
  { label: '收款', re: /收款/ },
  { label: '付款', re: /付款/ },
  { label: '价格', re: /价格/ },
  { label: '结算', re: /结算/ }, // 发起页不应出现金钱结算文案（战报「本场结算」不在本页）
];

// —— console error 过滤口径：仍收集全部 msg.type === 'error'，
// 仅下列已知 DevTools 环境噪音不计入业务 error（docs/ui-ux-fidelity-handoff 已记录），
// 其余任何 error 都视为业务 error 并使门禁失败。——
const IGNORED_CONSOLE_ERROR_PATTERNS = [/appServiceSDKScriptError/];

/* ═══════════════════════════════ 常量区结束 ═══════════════════════════════ */

fs.mkdirSync(OUT, { recursive: true });

const TOKEN = process.env.LIN_TOKEN || '';
const USER = JSON.parse(process.env.LIN_USER || '{}');
const RUN = Date.now(); // 本次运行命名空间（临时建局标题带上，便于追踪残留）

const consoleErrors = [];
const failures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言：失败累积进清单（不中断后续检查），最终统一 exit(1) */
function check(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
  return !!cond;
}

/** 轮询直到 fn 返回真值（返回该值）或超时（返回 null）：对抗页面异步加载抖动 */
async function waitUntil(fn, tries = 10, interval = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 元素未就绪等瞬态错误：继续轮询 */
    }
    await sleep(interval);
  }
  return null;
}

/** 后端 API 调用（envelope: {code:0, data}），失败直接抛错 */
async function apiCall(method, pathname, { token, body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 0) {
    throw new Error(
      `API ${method} ${pathname} 失败: HTTP ${res.status} ${json ? JSON.stringify(json).slice(0, 200) : '(非 JSON 响应)'}`,
    );
  }
  return json.data;
}

async function shot(mini, name) {
  try {
    await mini.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`  📸 ${name}`);
  } catch (e) {
    console.log(`  ⚠️ screenshot ${name} failed: ${e.message}`);
  }
}

/** 导航 + 截图；导航失败计入门禁失败清单，返回当前 Page（失败返回 null） */
async function go(mini, url, name, waitMs = 900) {
  try {
    await mini.reLaunch(url);
    await sleep(waitMs);
    await shot(mini, name);
    return await mini.currentPage();
  } catch (e) {
    failures.push(`导航 ${name} (${url}) 失败: ${e.message}`);
    console.log(`  ❌ nav ${name} (${url}) failed: ${e.message}`);
    return null;
  }
}

/** 注入指定身份会话（写 storage，后续请求即用该 token） */
async function injectSession(mini, token, user, who) {
  await mini.evaluate(
    (keyToken, keyUser, t, u) => {
      wx.setStorageSync(keyToken, t);
      wx.setStorageSync(keyUser, u);
    },
    KEY_TOKEN,
    KEY_USER,
    token,
    user,
  );
  console.log(`[automator] injected session: ${who}`);
}

/** 读取活动详情页三类头像墙 → [{title:'已报名', count:8, names:[...]}] */
async function readWalls(page) {
  const secs = (await page.$$(SEL.wallSection)) || [];
  const walls = [];
  for (const sec of secs) {
    const tagEl = await sec.$(SEL.wallTag);
    const countEl = await sec.$(SEL.wallCount);
    const nameEls = (await sec.$$(SEL.wallName)) || [];
    const names = [];
    for (const n of nameEls) names.push(((await n.text()) || '').trim());
    walls.push({
      title: tagEl ? ((await tagEl.text()) || '').trim() : '',
      count: countEl ? parseInt(((await countEl.text()) || '').replace(/[^\d]/g, ''), 10) : NaN,
      names,
    });
  }
  return walls;
}

/** 在页面所有 PrimaryButton 里按文案精确找按钮（活动详情操作条按钮无独立 class） */
async function findButtonByText(page, text) {
  const btns = (await page.$$(SEL.primaryBtn)) || [];
  for (const b of btns) {
    if (((await b.text()) || '').trim() === text) return b;
  }
  return null;
}

/* ───────────── 断言块 1：活动详情三类头像墙（seed 满员活动） ───────────── */
async function assertFullActivityWalls(page) {
  console.log('[assert] 满员活动三类头像墙');
  if (!page) return;
  const expect = SEED.fullActivity.walls;
  const walls = await waitUntil(async () => {
    const w = await readWalls(page);
    return w.length > 0 ? w : null;
  });
  if (!check(!!walls, '头像墙区块渲染出来', '等待超时，页面可能未加载出报名名单')) return;
  const byTitle = (t) => walls.find((w) => w.title === t);
  const signed = byTitle('已报名');
  const waitlist = byTitle('候补');
  const leave = byTitle('请假');
  check(!!signed && signed.count === expect.signed, `已报名墙 ${expect.signed} 人`, `实际 ${signed ? signed.count : '(无区块)'}`);
  check(
    !!signed && signed.names.length === expect.signed,
    `已报名墙头像格 ${expect.signed} 个`,
    `实际 ${signed ? signed.names.length : '(无区块)'}`,
  );
  check(!!waitlist && waitlist.count === expect.waitlist, `候补墙 ${expect.waitlist} 人`, `实际 ${waitlist ? waitlist.count : '(无区块)'}`);
  // seed 无请假：WallSection 对空列表返回 null，不应渲染请假区块
  check(!leave, '请假墙不渲染（seed 请假 0 人）', `实际渲染了：${leave ? `${leave.count} 人` : ''}`);
}

/* ───────────── 断言块 2：对阵看板轮次/对局数（seed 分组契约） ───────────── */
async function assertBoard(page) {
  console.log('[assert] 对阵看板轮次与对局数');
  if (!page) return;
  const { rounds, matchesPerRound } = SEED.boardActivity;

  // 总轮数：读「第 N 轮 / 共 M 轮」标签
  const labelTxt = await waitUntil(async () => {
    const label = await page.$(SEL.boardSwitcherLabel);
    let t = label ? ((await label.text()) || '').trim() : '';
    if (!/共\s*\d+\s*轮/.test(t)) {
      const total = await page.$(SEL.boardSwitcherTotal);
      t = total ? ((await total.text()) || '').trim() : '';
    }
    return /共\s*\d+\s*轮/.test(t) ? t : null;
  });
  if (!check(!!labelTxt, '轮次切换器渲染出来', '未读到「共 M 轮」文案')) return;
  const totalRounds = parseInt(/共\s*(\d+)\s*轮/.exec(labelTxt)[1], 10);
  check(totalRounds === rounds, `共 ${rounds} 轮`, `实际 ${totalRounds} 轮`);

  // 归位到第 1 轮（进入时定位在 currentRound；越界 tap 是 no-op）
  for (let i = 0; i < rounds; i++) {
    const prev = await page.$(SEL.boardPrevArrow);
    if (prev) await prev.tap();
    await sleep(300);
  }
  // 逐轮点「下一轮」数每轮对局卡片数，汇总总场次
  let totalMatches = 0;
  for (let r = 0; r < totalRounds; r++) {
    const courts = (await page.$$(SEL.boardCourt)) || [];
    check(courts.length === matchesPerRound, `第 ${r + 1} 轮 ${matchesPerRound} 场对局`, `实际 ${courts.length} 场`);
    totalMatches += courts.length;
    if (r < totalRounds - 1) {
      const next = await page.$(SEL.boardNextArrow);
      if (next) await next.tap();
      await sleep(350);
    }
  }
  check(
    totalMatches === rounds * matchesPerRound,
    `全场共 ${rounds * matchesPerRound} 场对局`,
    `实际 ${totalMatches} 场`,
  );
  // 最后一轮时「下一轮」箭头应置灰（确认没有多出的轮次）
  const next = await page.$(SEL.boardNextArrow);
  const cls = next ? (await next.attribute('class')) || '' : '';
  check(cls.includes('switcher__arrow--off'), '最后一轮后无更多轮次', `next 箭头 class=${cls}`);
}

/* ───────────── 断言块 3：发起页红线词扫描（v1 不碰钱） ───────────── */
async function assertCreateRedlines(page) {
  console.log('[assert] 发起页红线词');
  if (!page) return;
  const root = await waitUntil(() => page.$(SEL.pageRoot));
  if (!check(!!root, '发起页渲染出来', `未找到 ${SEL.pageRoot}`)) return;
  // outerWxml 含 placeholder 等属性，能扫到「备注占位文案出现 AA」这类历史问题
  const wxml = (await root.outerWxml()) || '';
  check(wxml.length > 0, '发起页 WXML 可读取');
  for (const w of REDLINE_WORDS) {
    check(!w.re.test(wxml), `发起页不含红线词「${w.label}」`);
  }
}

/* ───────────── 断言块 4：真实报名交互回归（幂等，跑完恢复现场） ─────────────
 * 流程：林丹丹经 API 临时建一个未满员局（标题带 RUN 命名空间）→ 注入张三会话
 * → 打开详情 tap「立即报名」→ 断言张三头像上墙 → tap「取消报名」→ 断言恢复
 * → finally 中由林丹丹取消该临时局。张三是 seed 既有用户，mock 登录不新造数据。 */
async function assertSignupRegression(mini, tempActId, zhang) {
  console.log('[assert] 报名/取消报名交互回归');
  await injectSession(mini, zhang.token, zhang.user, `${zhang.user.nickname}(第二身份)`);
  const url = `/pages/activity/index?id=${tempActId}`;
  const page = await go(mini, url, '12-regress-1-before', 1400);
  if (!page) return;
  const nick = zhang.user.nickname;

  // 初态：仅局长 1 人在已报名墙，张三不在
  const before = await waitUntil(async () => {
    const w = await readWalls(page);
    return w.length > 0 ? w : null;
  });
  if (!check(!!before, '临时局头像墙渲染出来')) return;
  const signed0 = before.find((w) => w.title === '已报名');
  check(!!signed0 && signed0.count === 1, '报名前：已报名墙仅局长 1 人', `实际 ${signed0 ? signed0.count : '(无区块)'}`);
  check(!!signed0 && !signed0.names.some((n) => n.includes(nick)), `报名前：${nick} 不在墙上`);

  // tap 立即报名 → 张三上墙
  const signupBtn = await waitUntil(() => findButtonByText(page, '立即报名'));
  if (!check(!!signupBtn, '「立即报名」按钮存在')) return;
  await signupBtn.tap();
  const after = await waitUntil(async () => {
    const w = await readWalls(page);
    const s = w.find((x) => x.title === '已报名');
    return s && s.names.some((n) => n.includes(nick)) ? w : null;
  });
  await shot(mini, '12-regress-2-signed');
  const signed1 = after && after.find((w) => w.title === '已报名');
  check(!!after, `报名后：${nick} 头像出现在已报名墙`);
  check(!!signed1 && signed1.count === 2, '报名后：已报名墙 2 人', `实际 ${signed1 ? signed1.count : '(未读到)'}`);

  // tap 取消报名 → 恢复初态
  const cancelBtn = await waitUntil(() => findButtonByText(page, '取消报名'));
  if (!check(!!cancelBtn, '「取消报名」按钮存在')) return;
  await cancelBtn.tap();
  const restored = await waitUntil(async () => {
    const w = await readWalls(page);
    const s = w.find((x) => x.title === '已报名');
    return s && s.count === 1 && !s.names.some((n) => n.includes(nick)) ? w : null;
  });
  await shot(mini, '12-regress-3-restored');
  check(!!restored, `取消后：${nick} 从已报名墙移除，恢复仅局长 1 人`);
}

/* ═══════════════════════════════ 主流程 ═══════════════════════════════ */
(async () => {
  if (!TOKEN || !USER || !USER.id) {
    console.error('[automator] 缺少 LIN_TOKEN / LIN_USER，请经 verify-ui.sh 运行（它会 mock 登录林丹丹注入）。');
    process.exit(1);
  }

  // 0) 启动 DevTools 前先经 API 解析 seed 活动实际 id（fail-fast，不依赖 DevTools）
  console.log('[automator] resolving seed activities via API…', API);
  const acts = await apiCall('GET', '/activities', { token: TOKEN });
  const findAct = (title) => acts.find((a) => a.title === title);
  const boardAct = findAct(SEED.boardActivity.title);
  const fullAct = findAct(SEED.fullActivity.title);
  if (!boardAct || !fullAct) {
    console.error(
      `[automator] seed 活动缺失（boardActivity=${boardAct ? boardAct.id : '未找到'} fullActivity=${fullAct ? fullAct.id : '未找到'}），` +
        'dev 库 seed 数据与 backend/prisma/seed.ts 契约不符，请与团队确认 seed 状态后再跑门禁。',
    );
    process.exit(1);
  }
  console.log(`[automator] seed ids: board=#${boardAct.id} full=#${fullAct.id}`);

  // 铸第二身份（seed 既有球友张三，不新造用户）+ 建临时回归局（结束时取消）
  const zhang = await apiCall('POST', '/auth/login', {
    body: { mockOpenid: SEED.secondIdentity.mockOpenid },
  });
  check(
    zhang.user.nickname === SEED.secondIdentity.nickname,
    `第二身份是 seed 球友「${SEED.secondIdentity.nickname}」`,
    `实际 ${zhang.user.nickname}`,
  );
  const startAt = new Date(RUN + 24 * 3600 * 1000);
  const tempAct = await apiCall('POST', '/activities', {
    token: TOKEN,
    body: {
      title: `UI门禁回归局 ${RUN}`, // RUN 命名空间：若清理失败可按标题定位残留
      startAt: startAt.toISOString(),
      endAt: new Date(startAt.getTime() + 2 * 3600 * 1000).toISOString(),
      venue: '自动化验收馆',
      courtCount: 1,
      capacity: 4, // 局长占 1，张三报名后 2/4 仍未满 → 按钮走「立即报名」分支
      playType: 'DOUBLES',
    },
  });
  console.log(`[automator] temp activity created: #${tempAct.id}`);

  let mini;
  try {
    console.log('[automator] launching DevTools…', PROJECT);
    mini = await automator.launch({
      cliPath: CLI,
      projectPath: PROJECT,
      timeout: 60000,
    });
    console.log('[automator] launched.');

    // 收集 console error（业务 error 必须为 0；口径见头部 IGNORED_CONSOLE_ERROR_PATTERNS）
    mini.on('console', (msg) => {
      if (msg.type === 'error') {
        consoleErrors.push(String(msg.args || msg.text || msg).slice(0, 300));
      }
    });

    // 注入局长会话
    await injectSession(mini, TOKEN, USER, `局长 ${USER.nickname || '林丹丹'}`);

    // 逐页截图 + 断言（活动 id 均为启动时解析的实际 id）
    await go(mini, '/pages/home/index', '01-home', 1400);
    const wallPage = await go(mini, `/pages/activity/index?id=${fullAct.id}`, '02-activity-detail-wall', 1400); // 8正选+2候补 → 三类墙
    await assertFullActivityWalls(wallPage);
    await go(mini, `/pages/activity/index?id=${fullAct.id}&share=1`, '03-activity-sharecard', 1600); // 分享卡自动弹
    await go(mini, `/pages/checkin/index?id=${boardAct.id}`, '04-checkin', 1400); // 林丹丹是该局局长
    await go(mini, `/pages/grouping/index?id=${boardAct.id}`, '05-grouping-step1-pick', 1400); // 向导①选人
    const boardPage = await go(mini, `/pages/board/index?id=${boardAct.id}`, '06-board', 1400);
    await assertBoard(boardPage);
    await go(mini, `/pages/summary/index?id=${boardAct.id}`, '07-summary', 1400);
    // 战报分享卡：点「生成战报分享卡」
    try {
      await mini.reLaunch(`/pages/summary/index?id=${boardAct.id}`);
      await sleep(1200);
      const page = await mini.currentPage();
      const btn = await waitUntil(() => page.$(SEL.summaryShare));
      if (check(!!btn, '战报页「生成战报分享卡」入口存在')) {
        await btn.tap();
        await sleep(700);
        await shot(mini, '08-summary-sharecard');
      }
    } catch (e) {
      failures.push(`战报分享卡流程异常: ${e.message}`);
      console.log('  ❌ summary sharecard:', e.message);
    }
    await go(mini, '/pages/profile/index', '09-profile', 1400);
    await go(mini, '/pages/me/index', '10-me', 1400);
    const createPage = await go(mini, '/pages/create/index', '11-create', 1200);
    await assertCreateRedlines(createPage);

    // 真实交互回归：张三报名 → 上墙 → 取消 → 恢复
    await assertSignupRegression(mini, tempAct.id, zhang);

    // 恢复现场：把会话切回局长（不留第二身份残留）
    await injectSession(mini, TOKEN, USER, `局长 ${USER.nickname || '林丹丹'}（恢复）`);
  } finally {
    if (mini) {
      try {
        await mini.close();
      } catch (e) {
        console.log('[automator] close DevTools failed:', e.message);
      }
    }
    // 清理：取消临时回归局（共享 dev 库，务必收尾；失败也计入门禁失败）
    try {
      await apiCall('POST', `/activities/${tempAct.id}/cancel`, { token: TOKEN });
      console.log(`[automator] temp activity #${tempAct.id} cancelled.`);
    } catch (e) {
      failures.push(`清理失败：临时局 #${tempAct.id} 未能取消（${e.message}），请按标题「UI门禁回归局 ${RUN}」手动取消`);
    }
  }

  // ═══ 汇总门禁结果 ═══
  const bizErrors = consoleErrors.filter((e) => !IGNORED_CONSOLE_ERROR_PATTERNS.some((re) => re.test(e)));
  const ignored = consoleErrors.filter((e) => IGNORED_CONSOLE_ERROR_PATTERNS.some((re) => re.test(e)));

  console.log(`\n[automator] CONSOLE ERRORS = ${consoleErrors.length}（业务 ${bizErrors.length} / 环境噪音忽略 ${ignored.length}）`);
  bizErrors.forEach((e) => console.log('   ✖', e));
  ignored.forEach((e) => console.log('   （忽略）', e));

  console.log(`\n[automator] 断言失败 = ${failures.length}`);
  failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));

  console.log(`[automator] shots in ${OUT}`);
  if (bizErrors.length > 0 || failures.length > 0) {
    console.error('[automator] ❌ 门禁未通过。');
    process.exit(1);
  }
  console.log('[automator] ✅ 门禁全绿。');
  process.exit(0);
})().catch((e) => {
  console.error('[automator] FATAL:', e && (e.message || e));
  process.exit(2);
});
