# 部署说明（阿里云 · 宝塔）

## 拓扑

```
微信小程序  ──https──▶  badminton.zorazora.cn (nginx 443, Let's Encrypt)
                              │  location /api/  → proxy_pass
                              ▼
                    pm2: badminton-backend (127.0.0.1:3010, Fastify, env=prod)
                              │
                              ▼
                    MySQL  127.0.0.1:3204  库 badminton（线上库·内网）
```

> 库分离：**本地/dev 用 `badminton_dev`**（user badminton_dev，公网 www.zorazora.cn:3204）；**线上/prod 用 `badminton`**（user badminton，内网 127.0.0.1:3204）。两套配置文件各自指向，互不影响。

- 服务器：`ssh aliyun`（root@59.110.232.243，Alibaba Cloud Linux 8，宝塔托管）。
- 后端代码：`/www/wwwroot/badminton/`（`shared` + `backend` 两个 workspace；前端不部署在服务器，走小程序上传）。
- 进程：pm2 `badminton-backend`（`dist/server.js --env=prod`，端口 3010，仅监听 127.0.0.1，由 nginx 反代）。
- 站点：nginx vhost `/www/server/panel/vhost/nginx/badminton.zorazora.cn.conf`，证书 `/www/server/panel/vhost/cert/badminton.zorazora.cn/`（acme.sh 自动续期）。
- 配置：`/www/wwwroot/badminton/backend/config/config.prod.yml`（DB 内网 127.0.0.1:3204、`auth.mode=wechat` 真实 appId/secret、强 JWT secret）。**不入库**。

## 已完成的线上验证

- `https://badminton.zorazora.cn/api/health` → 200
- 免登录 `GET /api/activities/2/share-card` → 返回种子活动数据
- 鉴权走查（用 prod JWT 密钥为种子用户「林丹丹」签发 token，打公网 HTTPS）：
  `/users/me`✓ `/activities`(2)✓ `/board#2`(ONGOING,4 轮)✓ `/summary#2`(MVP 孙六, 9 人榜)✓ `/users/:id/stats`(2 局,胜率0.5)✓
- HTTP→HTTPS 301 跳转✓；nginx 改动经 `nginx -t` 校验、未影响同机其它站点。

## 首次部署做了什么（备查）

1. `rsync` `shared/`+`backend/` 到 `/www/wwwroot/badminton/`；建 workspace 根 `package.json`+`pnpm-workspace.yaml`（仅 shared+backend）。
2. `corepack enable` → pnpm 10；`pnpm install`（China 镜像）；`pnpm --filter @badminton/shared build`；`prisma generate`；`db push --env=prod`（库已与本地同源，幂等）；`pnpm build`（tsc→dist）。
3. `config/config.prod.yml`（内网 DB + wechat 鉴权）；`ecosystem.config.js`；`pm2 start && pm2 save`。
4. nginx vhost（80→443 跳转 + `/api` 反代 + `/.well-known` 供签发）；acme.sh 签发 Let's Encrypt 并安装证书、`nginx -s reload`。

## 更新重新部署（改完代码后）

```bash
# 本机仓库根
rsync -az --exclude node_modules --exclude dist --exclude '.git' \
  --exclude 'config.local.yml' shared backend -e ssh aliyun:/www/wwwroot/badminton/
ssh aliyun 'cd /www/wwwroot/badminton && pnpm install \
  && pnpm --filter @badminton/shared build \
  && cd backend && pnpm exec prisma generate && pnpm build \
  && pm2 restart badminton-backend'
```

## 小程序上线（待你在微信后台放行后一键完成）

**已上传**：`node ci/upload.cjs` 已成功上传「开发版 0.1.0」到微信（IP 白名单已由用户关闭）。代码已指向线上 API。重新构建+上传：

```bash
cd frontend && pnpm build:weapp && node ci/upload.cjs 0.1.0 "来打我呀 v0.1"
```

> 注意：`@badminton/shared` 编译目标设为 **ES2017**，避免 `??`/`?.` 进入小程序包导致 WeChat 校验报「Unexpected token ?」；CI 上传 `setting.es6/es7=true` 兜底转译。

**最后一步（仅你能在微信后台做）—— request 合法域名：**
开发管理 → 开发设置 → 服务器域名，把 `https://badminton.zorazora.cn` 加入 **request 合法域名**（SSL 已就绪）。然后在「版本管理」把开发版设为**体验版**，扫码即可真机验证（连线上 `badminton` 库）。

> 真机/真实登录已就绪：线上 `auth.mode=wechat`，appId/secret 已配置，`wx.login` 的 code 会在后端经 `code2session` 换 openid。
