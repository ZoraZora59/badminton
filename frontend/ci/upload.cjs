/**
 * 用 miniprogram-ci 上传小程序到微信（生成「开发版」，不自动发布到线上）。
 * 前置：先 `pnpm build:weapp` 生成 dist（已指向线上 API）。
 *
 * 版本号必须「递增、不重复」——本脚本强制执行：
 *   - 不传版本号：自动在 ci/version.json 记录的上次版本基础上 +1（patch）。
 *   - 传版本号：必须 > 上次版本（x.y.z），否则拒绝上传。
 *   - 上传成功后把本次版本写回 ci/version.json。
 * 用法：node ci/upload.cjs [version] [desc]
 *
 * 注意：若后台「代码上传密钥」开启了 IP 白名单，需放行当前出口 IP。
 */
const ci = require('miniprogram-ci');
const fs = require('fs');
const path = require('path');

const VERSION_FILE = path.resolve(__dirname, 'version.json');

function parseV(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function readLast() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

(async () => {
  const last = readLast();
  const lastP = parseV(last) || [0, 0, 0];

  let version = process.argv[2];
  if (version) {
    const vp = parseV(version);
    if (!vp) {
      console.error(`版本号格式应为 x.y.z，收到：${version}`);
      process.exit(1);
    }
    if (cmp(vp, lastP) <= 0) {
      console.error(`版本必须递增：传入 ${version} 不大于上次已上传的 ${last}。请用更大的版本号或不传（自动 +1）。`);
      process.exit(1);
    }
  } else {
    version = [lastP[0], lastP[1], lastP[2] + 1].join('.'); // 自动 bump patch
  }
  const desc = process.argv[3] || `羽毛球小助手 v${version}`;

  const project = new ci.Project({
    appid: 'wx11ee60a7b6ec3bd9',
    type: 'miniProgram',
    projectPath: path.resolve(__dirname, '../dist'),
    privateKeyPath: path.resolve(__dirname, 'private.wx11ee60a7b6ec3bd9.key'),
    ignores: ['node_modules/**'],
  });

  console.log(`[upload] 上次版本 ${last} → 本次 ${version}`);
  const res = await ci.upload({
    project,
    version,
    desc,
    // @badminton/shared 编译目标 ES2017（包内无 ?? / ?.）；es6/es7 兜底转译 + 压缩。
    setting: { es6: true, es7: true, minify: true, autoPrefixWXSS: true },
    onProgressUpdate: () => {},
  });

  // 成功后记录本次版本，保证下次继续递增
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version, uploadedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`UPLOAD OK · version=${version} · ${JSON.stringify(res)}`);
})().catch((e) => {
  console.error('UPLOAD FAIL:', e && (e.message || e.errMsg || JSON.stringify(e)));
  process.exit(1);
});
