# 部署说明（阿里云 · 宝塔）

## 拓扑

```
微信小程序  ──https──▶  badminton.zorazora.cn (nginx 443, 宝塔站点 + *.zorazora.cn 泛域名证书)
                              │  location ^~ /api/  → proxy_pass（宝塔 extension 配置）
                              ▼
              宝塔Node项目(PM2模式): badminton-backend (127.0.0.1:3010, Fastify, env=prod)
                              │
                              ▼
                    MySQL  127.0.0.1:3204  库 badminton（线上库·内网）
```

> 库分离：**本地/dev 用 `badminton_dev`**（user badminton_dev，公网 www.zorazora.cn:3204）；**线上/prod 用 `badminton`**（user badminton，内网 127.0.0.1:3204）。两套配置文件各自指向，互不影响。

## 宝塔面板统一管理（2026-08-24 迁移完成 · 红线）

服务器上所有项目必须由宝塔面板统一管理，**不允许影子服务**（自起进程自维护、手写 vhost、面板外的证书续期）。本项目三层均已面板化：

- **进程**：面板「网站 → Node项目」登记 `badminton-backend`（PM2 模式，启动文件 `dist/server.js`、参数 `--env=prod`、运行用户 root、内存上限 300M、开机自启）。底层仍是 root 的 pm2，`pm2 ls`/`pm2 restart badminton-backend` 照常可用；面板里也可启停。
- **站点**：面板「网站 → HTML项目」登记 `badminton.zorazora.cn`（根目录 `/www/wwwroot/badminton/public`），主配置 `/www/server/panel/vhost/nginx/html_badminton.zorazora.cn.conf` 由面板生成；`/api` 反代在 `/www/server/panel/vhost/nginx/extension/badminton.zorazora.cn/api_proxy.conf`（面板 include 体系，面板重新生成主配置不会丢）。已开强制 HTTPS（80→301）。
- **证书**：复用面板统一维护的 `*.zorazora.cn` 泛域名 Let's Encrypt 证书（面板自动续签，与同机其他站点共用一张）。**acme.sh 已整体退役**（域名条目与 crontab 均已移除），不要再单独为本域名签证书。
- 原手工 vhost 备份在服务器 `/root/badminton-migration-backup/`。

- 服务器：`ssh aliyun`（root@59.110.232.243，Alibaba Cloud Linux 8，宝塔托管）。
- 后端代码：`/www/wwwroot/badminton/`（`shared` + `backend` 两个 workspace；前端不部署在服务器，走小程序上传）。
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

> 2026-08-24 起 3、4 两步的产物已迁入宝塔面板管理（见上文「宝塔面板统一管理」）：进程改为面板 Node 项目托管（`ecosystem.config.js` 留档不再是启动真源）、手工 vhost 与 acme.sh 已退役。

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

> `pm2 restart badminton-backend` 与宝塔面板托管兼容（面板 PM2 模式底层就是 root 的 pm2，restart 保留 `--env=prod` 参数），已实测。也可在面板「网站 → Node项目」里重启。**不要**再 `pm2 delete` 后手工 `pm2 start` 新配置——那会绕开面板登记，重新制造影子服务。

## 数据库结构变更（schema 迁移 · 必读）

> ⚠️ dev / prod 两套库分离：本地 `pnpm --filter @badminton/backend db:push` 读 `config.local.yml`，**只改 dev 库 `badminton_dev`（公网 www.zorazora.cn:3204）**；线上 `badminton` 库只监听内网 `127.0.0.1:3204`，本地连不到。
> 上面「更新重新部署」标准流程**只 build + 重启，不建表/改列**。所以凡 `backend/prisma/schema.prisma` 有列/表变更，必须单独迁 prod 库。

**铁律：先迁 prod 库 → 再部署新代码。** 加可空列等向后兼容改动，先迁库对正在运行的旧代码无害；反过来先上代码、库里缺列，新查询会直接打挂线上。

**库口令只在服务器 `config/config.prod.yml`（gitignored），永远不要从本地连 prod、不要把口令写进任何入库文件或命令行历史。** 在服务器上迁：

```bash
# 方式 A（推荐）：Prisma 读服务器 config.prod.yml，幂等，列/索引命名与 schema 完全一致
ssh aliyun 'cd /www/wwwroot/badminton/backend && node scripts/prisma.mjs db push --env=prod'

# 方式 B：mysql 客户端做最小手术（明确的追加列/索引时用）
#   ssh aliyun，进 backend，从 config.prod.yml 的 database.url 解析连接串，口令用 MYSQL_PWD 传入、勿打印；
#   先查 information_schema 判存在（保证幂等），不存在再执行，例如：
#   ALTER TABLE `Participant` ADD COLUMN `broughtBySignupId` INT NULL;
#   CREATE INDEX `Participant_broughtBySignupId_idx` ON `Participant`(`broughtBySignupId`);
```

迁完再走「更新重新部署」。**收尾验证**：`/api/health` 返回 200；再用 Prisma 实查一次新列（`participant.findFirst({ select: { 新列: true } })`）不报错，确认生成的 client 与线上库已对齐。

## 小程序上线（待你在微信后台放行后一键完成）

**已上传**：`node ci/upload.cjs` 已成功上传「开发版 0.1.0」到微信（IP 白名单已由用户关闭）。代码已指向线上 API。重新构建+上传：

```bash
cd frontend && pnpm build:weapp && node ci/upload.cjs 0.1.0 "羽毛球小助手 v0.1"
```

> 注意：`@badminton/shared` 编译目标设为 **ES2017**，避免 `??`/`?.` 进入小程序包导致 WeChat 校验报「Unexpected token ?」；CI 上传 `setting.es6/es7=true` 兜底转译。

**最后一步（仅你能在微信后台做）—— request 合法域名：**
开发管理 → 开发设置 → 服务器域名，把 `https://badminton.zorazora.cn` 加入 **request 合法域名**（SSL 已就绪）。然后在「版本管理」把开发版设为**体验版**，扫码即可真机验证（连线上 `badminton` 库）。

> 真机/真实登录已就绪：线上 `auth.mode=wechat`，appId/secret 已配置，`wx.login` 的 code 会在后端经 `code2session` 换 openid。
