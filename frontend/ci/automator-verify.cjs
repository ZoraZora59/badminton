/**
 * DevTools UI/UX 验收：用 miniprogram-automator 驱动微信开发者工具，
 * 注入 seed 局长(林丹丹)会话后逐页截图 + 收集 console error。
 * 仅本地验收用（dist 指向 127.0.0.1:3000 的 mock 后端）。
 *
 * 用法：LIN_TOKEN=.. LIN_USER='{...}' node ci/automator-verify.cjs
 */
const automator = require('miniprogram-automator');
const path = require('path');
const fs = require('fs');

const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PROJECT = path.resolve(__dirname, '../dist');
const OUT = '/tmp/badminton-shots';
fs.mkdirSync(OUT, { recursive: true });

const TOKEN = process.env.LIN_TOKEN || '';
const USER = JSON.parse(process.env.LIN_USER || '{}');

const consoleErrors = [];

async function shot(mini, name) {
  try {
    await mini.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`  📸 ${name}`);
  } catch (e) {
    console.log(`  ⚠️ screenshot ${name} failed: ${e.message}`);
  }
}

async function go(mini, url, name, waitMs = 900) {
  try {
    await mini.reLaunch(url);
    await new Promise((r) => setTimeout(r, waitMs));
    await shot(mini, name);
  } catch (e) {
    console.log(`  ⚠️ nav ${name} (${url}) failed: ${e.message}`);
  }
}

(async () => {
  console.log('[automator] launching DevTools…', PROJECT);
  const mini = await automator.launch({
    cliPath: CLI,
    projectPath: PROJECT,
    timeout: 60000,
  });
  console.log('[automator] launched.');

  // 收集 console error（业务 error 必须为 0）
  mini.on('console', (msg) => {
    if (msg.type === 'error') {
      consoleErrors.push(String(msg.args || msg.text || msg).slice(0, 300));
    }
  });

  // 注入局长会话
  try {
    await mini.evaluate(
      (token, user) => {
        wx.setStorageSync('badminton_token', token);
        wx.setStorageSync('badminton_user', user);
      },
      TOKEN,
      USER,
    );
    console.log('[automator] injected host session 林丹丹.');
  } catch (e) {
    console.log('[automator] inject failed:', e.message);
  }

  // 逐页截图
  await go(mini, '/pages/home/index', '01-home', 1400);
  await go(mini, '/pages/activity/index?id=1', '02-activity-detail-wall', 1400); // 8签+2候补 → 三类墙
  await go(mini, '/pages/activity/index?id=1&share=1', '03-activity-sharecard', 1600); // 分享卡自动弹
  await go(mini, '/pages/checkin/index?id=1', '04-checkin', 1400);
  await go(mini, '/pages/grouping/index?id=2', '05-grouping-step1-pick', 1400); // 向导①选人
  await go(mini, '/pages/board/index?id=2', '06-board', 1400);
  await go(mini, '/pages/summary/index?id=2', '07-summary', 1400);
  // 战报分享卡：点「生成战报分享卡」
  try {
    await mini.reLaunch('/pages/summary/index?id=2');
    await new Promise((r) => setTimeout(r, 1200));
    const page = await mini.currentPage();
    const btn = await page.$('.summary__share');
    if (btn) {
      await btn.tap();
      await new Promise((r) => setTimeout(r, 700));
      await shot(mini, '08-summary-sharecard');
    }
  } catch (e) {
    console.log('  ⚠️ summary sharecard:', e.message);
  }
  await go(mini, '/pages/profile/index', '09-profile', 1400);
  await go(mini, '/pages/me/index', '10-me', 1400);
  await go(mini, '/pages/create/index', '11-create', 1200);

  console.log('\n[automator] CONSOLE ERRORS =', consoleErrors.length);
  consoleErrors.forEach((e) => console.log('   ✖', e));

  await mini.close();
  console.log('[automator] done. shots in', OUT);
  process.exit(0);
})().catch((e) => {
  console.error('[automator] FATAL:', e && (e.message || e));
  process.exit(2);
});
