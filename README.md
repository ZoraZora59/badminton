# 来打我呀 · 羽毛球组局微信小程序

> 约球、分队、记分，一个小程序搞定。TypeScript 全栈单仓多工程。

`来打我呀` 面向业余羽毛球局：局长建局后分享给球友，球友报名/候补/签到，现场自动分队或轮转，打完记分并沉淀个人战绩。

主流程：

```text
建局 -> 分享 -> 报名/候补/签到 -> 分组排兵 -> 对阵看板/计分 -> 今日榜/战报 -> 个人累计战绩
```

## 当前状态

- 前后端 MVP 链路已经搭好：登录、建局、报名、候补、请假、签到、临时球友、分组预览/确认、计分、结算、个人战绩。
- 微信小程序页面已经覆盖产品方案中的 10 个业务页，视觉基调接近高保真稿。
- 后端测试覆盖引擎单测和 E1-E8 用户故事接口走查。
- 主要 UI/UX 体验项已落地：分享卡闭环、三类头像墙、自助签到、分组向导、点选换位、混双（建局阶段设置 + 引擎强制）、+1 带人确认；逐条状态见 [`docs/validation.md`](docs/validation.md)。

收尾打磨（非阻塞）：

- DevTools 偶发 `appServiceSDKScriptError timeout` 与 `scroll-view` padding 告警，待真机复验后清理。
- 少量装饰性 emoji 与底部按钮层级可继续打磨。

## 技术栈

| 层 | 选型 |
|---|---|
| 包管理 | pnpm workspace |
| 语言 | TypeScript |
| 前端 | Taro 3 + React 18，仅微信小程序 weapp |
| 后端 | Fastify 5 + Prisma 6 + MySQL 8 |
| 共享类型 | `@badminton/shared` |
| 鉴权 | 微信 `code2session` + JWT；本地支持 mock 登录 |
| 配置 | YAML 配置文件，不从环境变量读取业务/DB 配置 |
| 测试 | Vitest |

## 目录结构

```text
badminton-game/
├─ shared/      @badminton/shared，前后端共享类型、枚举、分级
├─ backend/     Fastify + Prisma，按业务域拆 modules
├─ frontend/    Taro React 微信小程序
├─ design/      高保真、线框图与色彩稿
├─ docs/        产品方案、架构、用户故事、验证与交接文档
├─ CLAUDE.md    Codex/Claude 共用协作说明主文件
└─ AGENTS.md    指向 CLAUDE.md 的软链接
```

## 文档入口

| 文档 | 用途 |
|---|---|
| [`docs/product-plan-v0.1.md`](docs/product-plan-v0.1.md) | 产品范围、红线、页面清单、主流程 |
| [`docs/user-stories-v0.1.md`](docs/user-stories-v0.1.md) | E1-E8 用户故事 |
| [`docs/architecture.md`](docs/architecture.md) | 技术架构、领域模型、API 映射 |
| [`docs/validation.md`](docs/validation.md) | 用户故事覆盖与当前实现状态 |
| [`docs/ui-ux-fidelity-handoff-2026-06-25.md`](docs/ui-ux-fidelity-handoff-2026-06-25.md) | UI/UX 还原度核验和整改清单 |
| [`design/`](design/) | 高保真设计稿、线框图与色彩稿 |
| [`CLAUDE.md`](CLAUDE.md) | AI 协作约束，`AGENTS.md` 软链到它 |

## 快速开始

前置：

- Node.js `>=20`
- pnpm `10.32.1`
- MySQL 可用配置写入 `backend/config/config.local.yml`

安装依赖：

```bash
pnpm install
```

构建共享类型：

```bash
pnpm build:shared
```

启动后端：

```bash
pnpm dev:backend
```

默认读取 `backend/config/config.local.yml`，本地服务地址为配置中的 `server.host/server.port`。真实配置文件被 `.gitignore` 排除，模板参考 `backend/config/*.example.yml`。

构建或监听小程序：

```bash
pnpm --filter @badminton/frontend build:weapp
pnpm --filter @badminton/frontend dev:weapp
```

用微信开发者工具打开：

```text
frontend/dist/
```

当前 AppID：

```text
wx11ee60a7b6ec3bd9
```

本地联调如果走 `http://127.0.0.1:3000`，需要在微信开发者工具中勾选“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”。

## 常用命令

| 目的 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 构建共享包 | `pnpm build:shared` |
| 后端开发 | `pnpm dev:backend` |
| 后端测试 | `pnpm test:backend` |
| 后端构建 | `pnpm --filter @badminton/backend build` |
| Prisma push | `pnpm --filter @badminton/backend db:push` |
| 写入 seed 数据 | `pnpm db:seed` |
| 前端类型检查 | `pnpm --filter @badminton/frontend typecheck` |
| 小程序构建 | `pnpm --filter @badminton/frontend build:weapp` |
| 小程序 watch | `pnpm dev:frontend` |

推荐回归组合：

```bash
pnpm build:shared
pnpm --filter @badminton/frontend typecheck
pnpm --filter @badminton/frontend build:weapp
pnpm --filter @badminton/backend build
pnpm test:backend
```

## 产品红线

v1 明确不做：

- 不碰钱：不做支付、AA、费用结算、收款等能力和文案。
- 不做球队/俱乐部：纯活动模型，不做成员体系、入队审批、俱乐部管理。
- 不做跨局排行榜和订阅消息：放到 v1.5 或后续。

技术硬约束：

- DB 时间存 UTC，展示按 `Asia/Shanghai`。
- 后端业务/DB 配置只读 YAML 文件，不从环境变量取值。
- 小程序前端当前只支持 weapp，不维护 Web/H5 版本。
- 业务共享类型优先放 `shared/`，前后端不要复制枚举或 DTO。

## AI 协作说明

本仓库使用同一份 AI 协作入口，避免 Codex 和 Claude 分叉：

```text
AGENTS.md -> CLAUDE.md
```

后续如果要改协作规则，只改 `CLAUDE.md`。Codex 会通过 `AGENTS.md` 读到同一份内容，Claude 会直接读 `CLAUDE.md`。

## Git 与产物

不要提交：

- `node_modules/`
- `frontend/dist/`
- `backend/dist/`
- `.tmp/`
- `.DS_Store`
- `backend/config/config.local.yml`
- `backend/config/config.prod.yml`
- 上传私钥、真实密钥、日志文件

开始任何改动前先看：

```bash
git status --short
```

当前仓库可能存在大量未跟踪文件，开发时不要随手 reset 或清理不属于本次任务的内容。
