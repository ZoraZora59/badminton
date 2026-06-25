// 前端运行时配置
// - 生产构建（pnpm build:weapp）：走线上 HTTPS 域名（已在阿里云部署，BT+nginx+pm2）。
// - 开发构建（pnpm dev:weapp）：走本机后端，微信开发者工具需勾选「不校验合法域名」。
// 线上域名需在小程序后台「开发管理 → 服务器域名 → request 合法域名」加入：https://badminton.zorazora.cn
const PROD_API = 'https://badminton.zorazora.cn/api';
const DEV_API = 'http://127.0.0.1:3000/api';

export const API_BASE = process.env.NODE_ENV === 'production' ? PROD_API : DEV_API;

export const STORAGE_KEYS = {
  token: 'badminton_token',
  user: 'badminton_user',
};
