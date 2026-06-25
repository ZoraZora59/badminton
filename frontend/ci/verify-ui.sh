#!/usr/bin/env bash
# DevTools UI/UX 验收一键脚本（本地）。
# 前置（仅一次手动）：微信开发者工具 → 设置 → 安全设置 → 开启「服务端口」，并保持已扫码登录。
# 运行：先在 backend/ 跑 `pnpm dev`（mock 后端 :3000），再执行：bash frontend/ci/verify-ui.sh
# 产物：/tmp/badminton-shots/*.png + 控制台 error 汇总。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> frontend/
API="http://127.0.0.1:3000/api"

curl -sf "$API/health" >/dev/null 2>&1 || { echo "❌ 本地后端未启动：请先在 backend/ 执行 pnpm dev"; exit 1; }
echo "✅ 本地 mock 后端在线"

# 临时把 API 指向本地后端构建（结束后自动还原）
cp src/config.ts /tmp/config.ts.bak
trap 'cp /tmp/config.ts.bak src/config.ts; echo "↩︎ 已还原 src/config.ts"' EXIT
sed -i '' "s#^export const API_BASE = .*#export const API_BASE = DEV_API;#" src/config.ts
echo "🏗  构建本地版 dist…"
pnpm build:weapp >/dev/null
grep -rl "127.0.0.1:3000" dist >/dev/null || { echo "❌ dist 未指向本地后端"; exit 1; }

# 注入 seed 局长(林丹丹)会话，让各页有真实数据
LIN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"mockOpenid":"seed_lin"}')
export LIN_TOKEN=$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['data']['token'])" "$LIN")
export LIN_USER=$(python3 -c "import sys,json;print(json.dumps(json.loads(sys.argv[1])['data']['user']))" "$LIN")

echo "📸 启动开发者工具自动化截图…（若报 http port，请先开启服务端口）"
node ci/automator-verify.cjs
