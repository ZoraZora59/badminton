# 验证报告 · 覆盖对账与手动清单

> 原则：**覆盖要被证明，不是被假设。** 下表把每条 v1 用户故事映射到接口与自动化测试。
> 自动化：`pnpm --filter @badminton/backend test`（引擎单测 `test/engine.test.ts` + E1–E8 接口走查 `test/api.test.ts`，连真实 `badminton_dev`）。
> 图例：✅ 接口+自动化测试覆盖 · 🟡 接口已实现+前端页面有，自动化未专项断言 · ⚪ v1 可选/后置未做。
> UI 框架：全站已统一为「顶部小 header + 主体 + 底部常驻 tab」，详见 [`ui-framework-unification-2026-06-25.md`](./ui-framework-unification-2026-06-25.md)（含待真机验证项）。

## Loop Engineering 对账

| 闭环 | 覆盖用户故事 | 核心完成态 | 工程证据 | 体验证据 | 状态 |
|---|---|---|---|---|---|
| 报名签到闭环 | E3 / E4 | 球友完成报名、候补、请假、自助签到；局长完成三类名单确认、批量签到、候补补位、Guest、本场水平确认，并产出分组输入 `participants` | `backend/test/api.test.ts` 覆盖报名、满员候补、自动补位、请假、批量签到、自助签到、Guest、参赛者池；核心代码见 `signups` / `checkin` 模块 | `activity` 页三类头像墙与球友操作区；`checkin` 页签到清单、候补补位、Guest 和 LevelSheet；完整手动清单见本文「微信小程序手动验证清单」第 3、4 项 | ✅ |

详细编制见 [`loop-engineering.md`](./loop-engineering.md)。该闭环的接口覆盖和页面入口均已落地；每次发布前仍需用微信开发者工具或真机复验三类头像墙、自助签到、签到页和分组输入是否一致。

## E1 登录与个人资料
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-1.1 微信一键登录（openid 持久） | `POST /auth/login`（mock+wechat 两路） | api.test「E1 1:1」断言新建用户、WechatAccount↔User 1:1 | ✅ |
| US-1.2 维护昵称/头像/性别/默认水平 | `PATCH /users/me` | api.test 改昵称+默认水平并回读；前端 `me` 页 chooseAvatar+nickname 写入我们的 User | ✅ |
| US-1.3 我的报名历史/个人中心 | `GET /activities`（我参与的） | 前端 `home`/`me`；自动化未专项断言历史列表 | 🟡 |

## E2 建局与分享
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-2.1 建局表单 | `POST /activities` | api.test 建局→status=SIGNUP、局长默认报名；`create` 页（**开打/结束时间均必填，结束需晚于开打，默认开打+2h；`endAt` 模型/接口/分享卡早已支持，本次补上表单入口**） | ✅ |
| US-2.2 活动分享卡 | `GET /activities/:id/share-card` | **建局成功后自动弹出分享卡预览**（`ShareCard` 弹层：标题/时间/地点/已报-上限/CTA）；`activity` 页「分享球局」复用同卡；转发走 useShareAppMessage | ✅ |
| US-2.3 编辑/取消活动 | `PATCH /activities/:id`、`POST /activities/:id/cancel` | api.test 非局长取消被拒(403)；编辑接口已实现 | ✅ |
| US-2.4 首页三态卡 + 空态 | `GET /activities?status=` | `home` 页三态 Tab+卡片+空态；v1 不做口令/粘贴框，空态误导文案已移除（改为「分享给球友一起打」） | ✅ |

## E3 报名 / 候补 / 请假
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-3.1 报名/取消 | `POST /activities/:id/signups`、`DELETE …/signups/me` | api.test 报名=SIGNED_UP、取消触发补位 | ✅ |
| US-3.2 满员自动候补 + 自动补位 | 同上（service 内 autofill） | api.test p4 满员→WAITLIST，p3 取消→p4 自动转正；seed 活动2 = 8 正选+2 候补 | ✅ |
| US-3.3 带朋友 +1 | `POST …/signups {plusOne}` | 占位计数含 +1（capacity 计算）；`activity` 页「+1 带人」**点击弹确认选「带1人/带2人」**，名单头像与签到页显示「带 N 人」 | ✅ |
| US-3.4 请假 | `POST …/signups/me/leave` | api.test leave→LEAVE 并触发补位 | ✅ |
| US-3.5 头像墙三类名单 | `GET /activities/:id/signups` | `activity` 页**三区块头像墙**：已报名/候补/请假，各区块头像+昵称+人数，超 8 人折叠 +N，带人显示「+N」角标 | ✅ |

## E4 签到与出勤
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-4.1 局长勾签到 | `POST /activities/:id/checkin` | api.test 批量签到=200；`checkin` 页 | ✅ |
| US-4.2 自助签到 | `POST /activities/:id/checkin/me` | 非局长在 `activity` 页「我已到场·签到」自助签到（可撤销）；局长 `checkin` 页可见结果并调整；api.test「E4.2」覆盖撤/签开关 + 请假者被拒 | ✅ |
| US-4.3 临时球友 Guest | `POST /activities/:id/participants` | api.test 加 Guest（isGuest=true，无 openid） | ✅ |
| US-4.4 确认/调整本场水平 | checkin `perGameLevel` | api.test 设本场水平；`checkin` 页点 LevelSheet | ✅ |
| US-4.5 候补补位 | `POST …/signups/:signupId/promote` | 自动补位已在 api.test 证明；`checkin` 页补位按钮用于局长现场手动补位，操作前需确认场地和人数 | ✅ |

## E5 双打分队分组 ★
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-5.1 从签到名单选人 | `GET /activities/:id/participants` | api.test 物化参赛者（真人+Guest）；`grouping` 向导**①选人步骤**默认全选、可点头像排除未上场者 | ✅ |
| US-5.2 智能平衡 | `POST …/grouping/preview {mode:BALANCED}` | engine.test 场内 {a,d}vs{b,c} 实力差最小；api.test 平衡预览 | ✅ |
| US-5.3 自动轮转 美式/墨式 | preview `{mode:ROTATION, rotation}` | engine.test 美式无自搭档+重复受控、墨式按 standings 配对 | ✅ |
| US-5.4 场地数/轮数/混双参数 | preview settings | engine.test 出场/轮空均衡；场地/轮数在 `grouping` 向导设置，**混双在建局阶段设置（仅双打）**，向导默认沿用建局的玩法/模式/场地数/混双；**轮数默认按活动时长估算（每轮约 15–20 分钟）并给区间提示，局长仍可手动调整** | ✅ |
| US-5.5 点选换位微调（算法给草稿，人拍板） | `POST /matches/:id/swap`（确认后）+ `grouping` 页草稿态本地交换 | api.test swap：场上↔轮空对调生效；**交互为「选中一人再点另一人(含轮空席)交换」，页面文案与之一致（不再出现"拖拽"误导）** | ✅ |
| US-5.6 场地×轮次看板预览 | preview 返回 rounds | api.test 校验 rounds/每轮场次/队伍人数/轮空数 | ✅ |
| US-5.7 混双约束（可选） | preview `mixedDoubles`（**建局阶段开启**） | 引擎按性别强制组队（一男一女，UNKNOWN 视作可搭配），不可满足时 `metrics.mixedViolations` 报违例队数、前端明确提示并可换位调整；engine.test「4男4女→0违例 / 6男2女→2违例 / 不开混双行为不变」 | ✅ |

## E6 对阵看板与计分
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-6.1 看板 + 轮空提示 | `GET /activities/:id/board` | api.test 确认后看板 totalRounds；`board` 页轮次切换+轮空 | ✅ |
| US-6.2 大字比分+大按钮计分定胜负 | `POST /matches/:id/score` | api.test 21:15→winner A、FINISHED；`scoring` 页 | ✅ |
| US-6.3 改判 | `PATCH /matches/:id/score` | api.test 改判翻盘；平局被拒(400) | ✅ |
| US-6.4 我今天打几场/下一场 | board（含每轮对阵） | `board` 可见各轮；未专门高亮「我的下一场」 | 🟡 |
| US-6.5 对局计时（可选） | — | v1 未做 | ⚪ |

## E7 结算与战报
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-7.1 今日榜（队制/个人制） | `GET /activities/:id/summary` | api.test rank≥2；`summary` 页随 mode 切换 | ✅ |
| US-7.2 本场 MVP | summary.mvp | api.test mvp 非空 | ✅ |
| US-7.3 战报分享卡 | summary 数据 | `summary` 页**战报分享卡预览**（`ShareCard` 弹层：活动名+日期+MVP+今日榜 TOP3），转发走 useShareAppMessage | ✅ |

## E8 个人战绩
| 故事 | 接口 | 测试/页面 | 状态 |
|---|---|---|---|
| US-8.1 累计战绩（局数/胜率/积分/最佳搭档/苦主/趋势） | `GET /users/:id/stats` | api.test totalGames=wins+losses；`profile` 页 | ✅ |
| US-8.2 分享战绩 | 同上 | `profile` 页分享 | ✅ |
| US-8.3 只读查看他人战绩 | `GET /users/:id/stats`（免登录） | `profile?id=` 只读 | ✅ |

## 红线核对
- 🔴 不碰钱：无任何支付/费用字段（建局表单、结算均无金额）；建局备注占位文案**及 seed 种子数据**均已去除「AA 现场结」等暗示付款措辞（DevTools 可视化验收时发现 seed remark 仍含 AA，已改为「自带球拍，提前 10 分钟到场热身」并重灌 dev 库），代码与种子全局无 AA/费用/付款文案。**展示层红线护栏**：`utils/format.ts#cleanRemark` 在前端剔除备注里含 AA/费用/付款/现场结/收费/元每人 等小句——即便线上脏数据仍含 AA，小程序也不会渲染（活动详情「自带球拍，AA 现场结。」→「自带球拍。」），已随版本上线，**彻底满足「小程序内不出现 AA」**。数据层另备一次性脚本 `backend/scripts/fix-prod-aa.ts`（`pnpm fix:aa --env=prod` 在服务器跑）做根因清理；线上 `badminton` 库凭证仅在服务器侧。
- 🔴 不做球队/俱乐部：纯活动模型，无成员管理/入队。
- ⏳ 跨局排行榜、订阅消息：v1.5 后置，未实现（符合范围）。

## 后端自动化测试结果

```
pnpm --filter @badminton/backend test
  ✓ test/engine.test.ts (13 tests)  # +混双约束 3 例（满足/不满足/不开混双不变）
  ✓ test/api.test.ts (3 tests)      # E1 登录+1:1；E2–E8 完整走查（含 E4.2 自助签到）；R1 空 body 兜底
  Test Files  2 passed (2)
       Tests  16 passed (16)
```

种子数据：`pnpm db:seed` 生成「周六晚·高手羽你局」（进行中，含今日榜）与「周日上午·新手友谊赛」（8 正选+2 候补），人物对齐设计稿（林丹丹/王小明/陈大锤…）。

## 微信小程序手动验证清单

> 运行态需微信开发者工具（无法 headless）。后端先 `pnpm dev`，前端 `pnpm build:weapp` 后用开发者工具打开 `frontend/dist/`，本地设置勾「不校验合法域名」。

1. **登录/资料**：首次进入自动登录；「我的」页用 chooseAvatar 选头像、填昵称、选默认水平 → 保存 → 重进仍在（写入我们的 User）。
2. **建局 → 分享卡**：首页 + → 填表（玩法/默认模式/**混双开关仅双打可选**；备注占位无 AA/费用）→ 发布 → **进入活动详情自动弹出分享卡预览**（标题/时间/地点/玩法·混双·模式/已报-上限/「点我报名」）→ 转发给球友。
3. **三类名单/报名/候补/+1**：换账号点分享进入 → 报名；把人数填满验证「满员候补」；取消一人看候补自动补位；「+1 带人」弹确认选带1/2人；活动详情看到**已报名/候补/请假三区块头像墙**及「带 N 人」角标。
4. **自助签到**：非局长在活动详情点「我已到场·签到」（可撤销）；局长进签到页勾人/改本场水平/加临时球友（带人显示「带 N 人」）→ 「确认参赛 · 去分组」。
5. **分组向导**（玩法/模式/场地/混双默认沿用建局设置，可现场调整）：①选人（默认全选、可排除）→ ②玩法 → ③模式（带说明）→ ④设置（场地/轮数）→ 生成 → ⑤看板（赛程总览+各轮对阵，混双开启时看违例提示）→ 点选两人(含轮空席)换位 → 确认开打。
6. **看板/计分**：进行中场地「进入计分」→ 大按钮 +1/确认胜负 → 返回看板看比分 → 改判验证。
7. **结算/战报卡**：本场结算看今日榜+MVP → 「生成战报分享卡」弹出战报预览（活动名+日期+MVP+TOP3）→ 晒到群；「战绩」Tab 看累计局数/胜率/积分/趋势图（新用户显示空态+「去报名/发起球局」CTA）。

切真机登录：把 `backend/config/config.local.yml` 的 `auth.mode` 改为 `wechat`（appId/appSecret 已填）后重启后端。

## 线上部署验证（阿里云 · 宝塔）

后端已部署到阿里云并通过公网 HTTPS 验证（详见 [`deploy.md`](./deploy.md)）：

| 验证项 | 结果 |
|---|---|
| `GET https://badminton.zorazora.cn/api/health` | ✅ 200 |
| 免登录 `GET /api/activities/2/share-card` | ✅ 返回种子活动 |
| 鉴权 `GET /api/users/me`（prod JWT 签发） | ✅ 林丹丹 |
| `GET /api/activities` | ✅ count=2 |
| `GET /api/activities/2/board` | ✅ ONGOING · 4 轮 |
| `GET /api/activities/2/summary` | ✅ MVP=孙六 · 9 人榜 |
| `GET /api/users/:id/stats` | ✅ 2 局 · 胜率 0.5 |
| HTTP→HTTPS 301 跳转 | ✅ |

链路：nginx(443, Let's Encrypt) → 反代 `/api` → pm2 `badminton-backend`(127.0.0.1:3010, env=prod, auth=wechat) → MySQL 内网 127.0.0.1:3204 **库 badminton**（线上库，已 push schema + seed 数据）。验证用的是真正的线上 `badminton` 库，非 dev 库。本次混双特性新增的 `Activity.mixedDoubles` 列已通过 SSH 在线上库补齐（`tinyint(1) NOT NULL DEFAULT 0`，与 dev 一致），对旧代码向后兼容，待新代码部署后生效。

**小程序已上传**：`node ci/upload.cjs` 成功上传「开发版 0.1.0」（指向线上 API）。

**最后一步（仅你能在微信后台做）**：request 合法域名加 `https://badminton.zorazora.cn`，再把开发版设为「体验版」即可真机验证。
