# 羽毛球小助手 · 系统架构与开发设计 v0.1

> 配套文档：[`product-plan-v0.1.md`](./product-plan-v0.1.md) · [`user-stories-v0.1.md`](./user-stories-v0.1.md) · 设计稿见 `design/`。
> 本文是工程落地的权威记录：技术选型、目录、数据模型、鉴权、配置、API、验证策略。

---

## 1. 技术选型（已锁定）

| 层 | 选型 | 说明 |
|---|---|---|
| 组织形式 | **单仓多工程**（pnpm workspace） | `shared` / `backend` / `frontend` 三个包 |
| 语言 | **TypeScript 全栈** | 前后端共享类型（`@badminton/shared`） |
| 后端框架 | **Fastify 4** | 轻量、TS 友好、插件化 |
| ORM / DB | **Prisma + MySQL 8** | 数据库独立（`badminton_dev`） |
| 鉴权 | **微信 `code2session` + JWT**，本地支持 **mock 登录** | 详见 §5 |
| 校验 | **Zod** | 入参校验 + 由 schema 反推类型 |
| 配置 | **YAML 配置文件**（`config.local.yml` / `config.prod.yml`），**不读环境变量取值** | 详见 §6 |
| 前端 | **Taro 3 + React + TS** | 仅微信小程序（weapp） |
| 测试 | **Vitest**（后端单测 + 接口集成测试） | 引擎纯函数单测 + HTTP 用户故事走查 |
| 部署 | 阿里云（线上不在本次验证范围） | 本地验证：后端跑在本机，连 `badminton_dev` |

前端框架味道选 **React**（与全栈 TS 一致、最成熟）。

---

## 2. 目录结构

```
badminton-game/
├─ design/                         高保真 + 线框/色彩（已有）
├─ docs/                           产品方案 / 用户故事 / 本架构文档
├─ shared/                         @badminton/shared —— 前后端共享类型与常量
│  └─ src/{enums,dto,levels}.ts
├─ backend/                        @badminton/backend —— Fastify + Prisma
│  ├─ src/
│  │  ├─ server.ts                 入口：装配置 + 监听
│  │  ├─ app.ts                    buildApp()：注册插件与路由（测试可复用）
│  │  ├─ config/index.ts           YAML 配置加载器（local/prod）
│  │  ├─ plugins/                  prisma / auth / error-handler 等 Fastify 插件
│  │  ├─ lib/                      jwt / wechat / response / errors / time / id
│  │  ├─ modules/                  业务模块（每模块含 routes + service + schema）
│  │  │  ├─ auth/ users/ activities/ signups/ checkin/
│  │  │  ├─ grouping/              对阵引擎 engine.ts（纯函数）+ routes/service
│  │  │  ├─ matches/ stats/
│  │  └─ types/
│  ├─ prisma/{schema.prisma,seed.ts}
│  ├─ config/{config.*.example.yml}   （真实 config.*.yml 不入库）
│  └─ test/
└─ frontend/                       @badminton/frontend —— Taro React 小程序
   ├─ src/{app.*,pages/,components/,services/,store/,styles/,types/}
   └─ config/                      Taro 构建配置
```

---

## 3. 领域模型（Prisma 实体）

> 红线：纯活动模型，**无球队/俱乐部**；**不碰钱**。用户按 **openid 持久**。
> 时间：DB 存 **UTC**，展示层转 `Asia/Shanghai`。

### 双实体 1:1（核心要求）

- **`WechatAccount`** — 微信生态身份：`openid`(唯一)、`unionid?`、`sessionKey?`、原始 `wxNickname?`/`wxAvatar?`。仅承载"微信给的东西"。
- **`User`** — 我们自己的用户实体：`nickname`、`avatarUrl`、`gender?`、`defaultLevel`、累计战绩字段。**业务只认 `User`**。
- 关系：`User.wechatAccountId` **唯一外键** → 1:1。微信资料变了不污染我们的用户主数据；将来可支持非微信登录而无需重构。

### 实体清单

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `WechatAccount` | openid✦, unionid, sessionKey, wxNickname, wxAvatar | 微信身份，1:1 → User |
| `User` | nickname, avatarUrl, gender, defaultLevel(L1–L6), createdAt | 应用用户；战绩走聚合查询 |
| `Activity` | hostId→User, title, startAt, endAt, venue, courtCount, capacity, signupDeadline, playType(双打/单打), defaultMode(平衡/轮转), remark, status | 状态 `SIGNUP→ONGOING→FINISHED/CANCELLED` |
| `Signup` | activityId, participantId, status(报名/候补/请假/已签到), perGameLevel, plusOne(int), order, checkedInAt | 满员自动候补；退出自动补位 |
| `Participant` | activityId, userId?(真人) **或** guestName(临时), level | 参赛占位身份；Guest 无 openid。报名/签到/分组/计分都引用它 |
| `Round` | activityId, mode, playType, index, status | 一"轮"赛程 |
| `Match` | roundId, courtNo, teamA[Participant], teamB[Participant], scoreA, scoreB, winner, status(待开始/进行中/已结束) | 一片场地一局；单打则每队 1 人 |
| `MatchPlayer` | matchId, participantId, team(A/B) | Match↔Participant 多对多落地 |

> `Participant` 把"真人 User"与"临时 Guest"统一成参赛实体，让分组/计分只依赖 `Participant`（参考 camping 的 actor 模型）。个人战绩跨局按 `User`（即 openid）聚合。

---

## 4. 端到端流程 → API 映射（粗）

```
建局  POST /activities
分享卡 GET /activities/:id/share-card
报名  POST /activities/:id/signups          取消 DELETE …    候补/补位自动
签到  POST /activities/:id/checkin (批量勾)  加Guest POST …/participants
分组  POST /activities/:id/grouping/preview（引擎产出草稿，不落库）
      POST /activities/:id/grouping/confirm（落库 Round/Match）
      POST /matches/:id/swap（拖拽换人微调）
看板  GET  /activities/:id/board
计分  POST /matches/:id/score   改判 PATCH /matches/:id/score
结算  GET  /activities/:id/summary（今日榜 + MVP）
战绩  GET  /users/:id/stats（跨局聚合）  GET /users/me
```

统一响应包：`{ code, message, data }`，错误 `code≠0`。鉴权走 `Authorization: Bearer <jwt>`。

---

## 5. 鉴权设计（业内常见方式）

**真实流程（线上 / 真机）**
1. 小程序 `wx.login()` 拿 `code` → `POST /auth/login { code }`。
2. 后端用 `AppID + AppSecret` 调 `code2session` 换 `openid (+unionid, session_key)`。
3. `upsert WechatAccount(openid)`；若无关联 `User` 则建一个（默认昵称/头像/默认水平 L3），1:1 绑定。
4. 签发 **JWT**（含 `userId`），前端存 storage，后续请求带 `Bearer`。

**头像/昵称打通**（当前微信能力，非废弃的 getUserProfile）
- `<button open-type="chooseAvatar">` 拿临时头像 → 上传/落 `User.avatarUrl`。
- `<input type="nickname">` 拿昵称 → `User.nickname`。
- 写入的是 **我们的 `User`**（不是 WechatAccount.wxNickname），体现"两个实体"。

**本地 mock 登录**（`auth.mode: mock`）
- `POST /auth/login { mockOpenid? }` 跳过 `code2session`，直接 upsert 账号并发 JWT。
- 用于接口自动化测试与无真机的本地走查。线上配置 `auth.mode: wechat`。

---

## 6. 配置策略（不读环境变量取值）

- 后端只读 `backend/config/config.<env>.yml`；`<env>` 由**单一启动参数** `--env=local|prod`（默认 `local`）选择文件，**不从环境变量取任何业务/DB 配置值**。
- 入库的是模板：`config.local.example.yml`、`config.prod.example.yml`。真实 `config.local.yml`/`config.prod.yml` 被 `.gitignore`。
- 配置项：`server.{host,port}`、`database.url`、`jwt.{secret,expiresIn}`、`auth.{mode,appId,appSecret}`、`timezone`。

```yaml
# config.local.yml（本地验证：直连远程 dev 库）
server: { host: 0.0.0.0, port: 3000 }
database:
  url: "mysql://badminton_dev:****@www.zorazora.cn:3204/badminton_dev"
jwt: { secret: "dev-secret", expiresIn: "30d" }
auth: { mode: mock, appId: "", appSecret: "" }
timezone: Asia/Shanghai
```

---

## 7. 分组引擎（★ 差异化核心）

纯函数模块 `modules/grouping/engine.ts`，输入参赛者(含水平)+参数，输出多轮赛程草稿（不落库）。

- **玩法**：双打(2v2) / 单打(1v1) —— 决定每场每队人数。
- **模式**：
  - **平衡 Balanced**：按水平把每片场地两队配到实力尽量接近（最小化两队实力差）。
  - **轮转 Rotation**：
    - **美式 Americano**：每轮换搭档/对手、尽量不重复，个人积分累计。
    - **墨式 Mexicano**：按当前积分动态配对（强弱搭）。
- **共通目标**：出场次数均衡、尽量不重复搭档/对手、轮空(休息)均衡、可选混双(性别)约束。
- **可解释**：每场输出实力差等指标；**算法只给草稿，人可拖拽换人**（`swap` 接口）。
- 纯函数 + 确定性（可注入种子）→ 便于 Vitest 单测断言均衡性/无重复/轮空均衡。

---

## 8. 验证策略（本地）

1. **Prisma migrate** 到 `badminton_dev` → 证明 DB/schema 可用。
2. **种子数据** `seed.ts`：构造若干用户/Guest/活动/报名/签到。
3. **引擎单测**（Vitest）：均衡度、不重复、轮空均衡、单/双打、混双约束。
4. **接口集成测试**：`buildApp()` + inject，覆盖 E1–E8 主要接口。
5. **用户故事走查**：脚本按"建局→报名→候补补位→签到→分组→计分→结算→战绩"串起来打一遍真实 HTTP，断言关键状态。
6. **覆盖对账**：显式核对每条 v1 用户故事 → 对应接口/测试，证明覆盖（非假设）。
7. 小程序前端：保证可编译；运行态需微信开发者工具，提供**手动验证清单**。

---

## 9. v1 边界（与设计稿一致）

做：E1 登录/资料 · E2 建局/分享 · E3 报名/候补/请假 · E4 签到/出勤 · E5 分组(平衡+轮转,可拖拽) · E6 看板/计分 · E7 结算/战报 · E8 个人战绩。
不做（红线/后置）：不碰钱、不做球队、跨局排行榜/订阅消息（v1.5）。
