# 小程序 UI/UX 还原度核验与整改 Handoff

核验日期：2026-06-25  
核验对象：羽毛球组局小程序「来打我呀」  
核验目标：对比产品方案、设计稿和微信开发者工具实际效果，列出开发整改清单。

## 1. 结论

当前实现已经具备主要页面骨架：首页、活动详情、发起活动、签到、分组、对阵、计分、结算、个人战绩、我的。视觉风格也基本贴近高保真稿的绿色运动主题、卡片布局和头像体系。

但产品闭环还没有完全达到方案描述，尤其是“分享卡”“签到到分组”“分组向导”“真实拖拽微调”“混双约束”这些关键体验点。部分文档状态标记为已完成，但实际 UI 只是原生分享、按钮文案或接口字段贯通，和用户可感知的产品能力仍有差距。

综合评估：

| 维度 | 还原度 | 说明 |
|---|---:|---|
| 视觉风格 | 约 75% | 绿色视觉、卡片、头像、战绩页基调已到位；emoji 图标、空态、分组页精细度仍偏 demo。 |
| 产品流程 | 约 65%-70% | 建局、报名、签到、分组、计分链路具备基础能力；分享卡、自助签到、分组向导、战报闭环不完整。 |
| 工程稳定性 | 中等 | typecheck/build/backend test 通过；DevTools 仍有 timeout error 和多条渲染告警。 |

## 2. 核验范围与证据

已核验材料：

- 产品方案：`docs/product-plan-v0.1.md`
- 用户故事与验收：`docs/user-stories-v0.1.md`、`docs/validation.md`
- 高保真设计稿：`design/羽毛球组局 · 高保真.dc.html`
- 线框与色彩稿：`design/羽毛球组局 · 线框图与色彩.dc.html`
- 微信开发者工具实际运行页面：首页、活动详情、签到、发起活动、战绩、我的

已执行验证命令：

```bash
pnpm --filter @badminton/frontend typecheck
pnpm --filter @badminton/frontend build:weapp
pnpm --filter @badminton/backend test
```

结果：以上命令均通过。

截图证据：

| 页面/证据 | 文件 |
|---|---|
| 高保真设计稿 | `.tmp/audit/design-hi-fi.png` |
| 线框与色彩稿 | `.tmp/audit/design-wireframe.png` |
| 首页 | `.tmp/audit/weapp-home.png` |
| 活动详情 | `.tmp/audit/weapp-activity.png` |
| 签到 | `.tmp/audit/weapp-checkin-mismatch.png` |
| 发起活动 | `.tmp/audit/weapp-create.png` |
| 战绩 | `.tmp/audit/weapp-profile.png` |
| 我的 | `.tmp/audit/weapp-me.png` |
| Console | `.tmp/audit/weapp-console.png` |

## 3. P0 必改项

### P0-1 分享卡没有形成真实产品闭环

产品方案要求：

- 建局后生成活动分享卡，群里转发拉人。
- 本场结算后生成战报分享卡，展示今日榜和 MVP。
- 方案位置：`docs/product-plan-v0.1.md` 第 71-80 行、第 142-144 行。

当前实现：

- 建局后只展示 toast「已生成分享卡」，随后跳到活动详情。
- 活动详情使用 `openType="share"` 原生转发，没有卡片预览或分享卡页面。
- 战报页按钮文案是「生成战报分享卡」，但实际也是原生分享。
- 已有 `getShareCard` 接口定义，但 UI 未使用。

源码位置：

- `frontend/src/pages/create/index.tsx:132`
- `frontend/src/pages/activity/index.tsx:43`
- `frontend/src/pages/activity/index.tsx:185`
- `frontend/src/pages/summary/index.tsx:30`
- `frontend/src/pages/summary/index.tsx:118`
- `frontend/src/services/endpoints.ts:42`

建议整改：

1. 新增活动分享卡预览弹层或页面，展示标题、时间、地点、报名人数、CTA。
2. 建局成功后进入分享卡预览，而不是只 toast。
3. 活动详情的“分享球局”复用同一张分享卡。
4. 结算页新增战报分享卡，至少展示今日榜 TOP 3、MVP、活动名、日期。
5. 如果暂时只支持原生分享，按钮文案不要写“生成分享卡”。

验收标准：

- 建局成功后用户能看到分享卡预览。
- 分享卡内容和产品方案一致。
- 战报页能看到战报卡预览或明确的战报分享结果。
- `docs/validation.md` 中 US-2.2、US-7.3 的状态应按真实完成度更新。

### P0-2 发起页出现 AA 文案，违反“不碰钱”红线

产品方案要求：

- v1 红线：不碰钱。
- 方案位置：`docs/product-plan-v0.1.md:36`

当前实现：

- 发起活动备注占位文案是「自带球拍，AA 现场结…」。

源码位置：

- `frontend/src/pages/create/index.tsx:305`

建议整改：

- 改成不涉及费用的场景文案，例如「自带球拍，提前 10 分钟到场热身」。
- 全局搜索并移除 AA、费用、结算等暗示付款的文案。

验收标准：

- 小程序内不出现 AA、付款、费用结算等 v1 红线相关文案。

### P0-3 页面切换存在残影，Console 有 timeout error

现象：

- 微信开发者工具中多次出现页面路径已切换，但内容仍短暂停留旧页的情况。
- 活动详情到签到、首页到发起、首页到战绩均观察到 1-2 秒残影。
- Console 有 `Error: SystemError (appServiceSDKScriptError) timeout`。

证据：

- `.tmp/audit/weapp-checkin-mismatch.png`
- `.tmp/audit/weapp-console.png`

建议整改：

1. 真机复验是否复现。
2. 如果复现，检查页面跳转、`useDidShow` 拉取、loading 态、Taro 版本和基础库兼容。
3. 接口依赖页面增加明确 loading 或骨架屏，避免旧页面内容误导用户。
4. 清理 Console error，不能只依赖测试通过。

验收标准：

- 真机和 DevTools 切页不出现旧内容残留。
- Console 无业务 error。

## 4. P1 高优先级整改项

### P1-1 活动详情缺少三类头像墙

产品方案要求：

- 活动详情展示已报名、候补、请假三类名单头像墙。
- 方案位置：`docs/product-plan-v0.1.md:133`

当前实现：

- 只展示已报名头像墙。
- 候补和请假只展示数字，没有人员头像或名单。
- `docs/validation.md:29` 标记为已完成，但实际 UI 不完整。

源码位置：

- `frontend/src/pages/activity/index.tsx:82`
- `frontend/src/pages/activity/index.tsx:141`
- `frontend/src/pages/activity/index.tsx:162`

建议整改：

- 将报名名单拆成三个区块：已报名、候补、请假。
- 每类都展示头像、昵称、人数；人多时折叠为 `+N`。
- 候补和请假都支持局长现场识别具体人员。

验收标准：

- seed 数据包含候补/请假时，活动详情能直接看到具体人员。

### P1-2 自助签到未放开

产品方案要求：

- 签到支持局长勾选或球友自助。
- 方案位置：`docs/product-plan-v0.1.md:93`

当前实现：

- 当前页面主要是局长批量勾选。
- `docs/validation.md:35` 已标记自助签到未单独放开。

源码位置：

- `frontend/src/pages/checkin/index.tsx:211`

建议整改：

- 对普通球友增加“我已到场”入口。
- 局长视角保留批量勾选。
- 对已签到、请假、候补补位状态给出清晰状态标签。

验收标准：

- 非局长进入活动页时能自助签到。
- 局长能看到自助签到结果并可调整。

### P1-3 分组页缺少真实向导感

产品方案要求：

- 分组排兵流程：选人 → 选模式 → 设置 → 看板 → 拖拽微调。
- 方案位置：`docs/product-plan-v0.1.md:135`

当前实现：

- 分组接口直接使用全部 participants，没有明显选人步骤。
- 页面步骤条基本是静态完成态。

源码位置：

- `frontend/src/pages/grouping/index.tsx:73`
- `frontend/src/pages/grouping/index.tsx:173`

建议整改：

1. 拆成清晰的步骤式交互。
2. 第一步展示参赛者列表，支持勾选/排除。
3. 玩法选择给短说明，降低“智能平衡 / 美式 / 墨式”的理解成本。
4. 最后生成看板后再进入微调。

验收标准：

- 局长能明确选择哪些人参加分组。
- 每一步只有一个主要决策。
- 步骤条状态与真实进度一致。

### P1-4 拖拽微调实际是点选交换

产品方案要求：

- 所有模式都允许局长手动拖拽换人。
- 方案位置：`docs/product-plan-v0.1.md:111`

当前实现：

- 文案为“点两名选手互换位置”，不是拖拽。

源码位置：

- `frontend/src/pages/grouping/index.tsx:124`
- `frontend/src/pages/grouping/index.tsx:332`

建议整改：

- 如果短期不做拖拽，应把产品文案改成“点选换位”。
- 如果按方案实现，应支持拖拽选手到另一位置/轮空区。

验收标准：

- UI 交互方式和页面文案一致。
- 局长能直观调整上场、队友、对手、轮空。

### P1-5 混双开关有 UI，但引擎没有强制约束

产品方案要求：

- 智能平衡可选混双约束，按性别搭配。
- 方案位置：`docs/product-plan-v0.1.md:102`

当前实现：

- 前端传了 `mixedDoubles`。
- 后端 settings 有字段，但排阵逻辑没有使用该字段做强制配对。
- `docs/validation.md:49` 已说明字段贯通但未强制。

源码位置：

- `frontend/src/pages/grouping/index.tsx:267`
- `backend/src/modules/grouping/engine.ts:16`
- `backend/src/modules/grouping/engine.ts:70`

建议整改：

- 混双开关如果保留，需要在引擎中加入约束和不可满足时的提示。
- 如果 v1 暂不做，应弱化或隐藏开关，避免用户误判。

验收标准：

- 开启混双时，双打队伍尽量满足男女搭配。
- 人数或性别分布不足时，页面明确提示无法完全满足。

### P1-6 +1 带人缺少数量和身份确认

当前实现：

- 活动详情中 `+1 带人` 是一次点击直接报名。

源码位置：

- `frontend/src/pages/activity/index.tsx:319`

建议整改：

- 点击后弹出确认，允许选择带 1 人/2 人，或填写临时昵称。
- 活动详情名单中明确展示“某某带 1 人”。

验收标准：

- 局长能在活动详情和签到页识别被带来的临时成员。

## 5. P2 体验优化项

### P2-1 首页空态写了“粘贴链接加入”，但没有入口

当前实现：

- 首页空态提示“粘贴链接加入”，但没有粘贴框或口令入口。
- `docs/validation.md:20` 已标记为黄色。

源码位置：

- `frontend/src/pages/home/index.tsx:97`

建议整改：

- 要么新增输入/粘贴活动链接入口。
- 要么删掉该提示，只保留“发起新局”。

### P2-2 emoji 图标降低正式感

当前实现：

- 首页时间、地点、分享等多处使用 emoji。

源码位置：

- `frontend/src/pages/home/index.tsx:106`
- `frontend/src/pages/activity/index.tsx:188`

建议整改：

- 替换为统一线性图标或小程序图片资源。
- 图标风格与高保真稿保持一致。

### P2-3 新用户战绩页空数据状态偏弱

当前实现：

- 0 场时仍展示 0 数据和空柱状趋势。

源码位置：

- `frontend/src/pages/profile/index.tsx:47`

建议整改：

- 新用户状态单独设计：“还没打过记录局”。
- 给入口：“去报名球局”或“发起球局”。

### P2-4 底部主按钮层级需要统一

建议：

- 每页只保留一个最高优先级绿色实心按钮。
- 其他操作改为描边、文本或更多菜单。
- 活动详情局长视角建议主按钮为“开始签到/分组”，编辑/取消活动弱化。

### P2-5 表单控件更贴近现场组织者

建议：

- 场地数、人数上限使用 stepper 或常用选项。
- 报名截止给默认推荐值。
- 备注占位文案使用羽毛球现场语言，不涉及费用。

## 6. Console 与渲染告警

Console 中观察到：

- `Error: SystemError (appServiceSDKScriptError) timeout`
- `[Component] <scroll-view>: the padding property is not yet supported in webview rendering mode`
- `工具未校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书。`

建议：

1. 业务 error 必须消除。
2. `scroll-view` padding 告警建议改成内部容器 padding，避免真机渲染差异。
3. 合法域名告警如果仅本地调试可忽略；提交体验版前需要确认线上域名配置。

## 7. 建议开发拆分顺序

第一批，保证主链路不误导用户：

1. 修 AA 文案。
2. 修分享卡文案和真实预览闭环。
3. 处理页面切换残影与 Console error。

第二批，提升活动组织效率：

1. 活动详情三类头像墙。
2. 自助签到入口。
3. +1 带人确认与展示。

第三批，强化核心差异化能力：

1. 分组向导化。
2. 拖拽或点选换位交互统一。
3. 混双约束真实生效或下线开关。

第四批，视觉和细节打磨：

1. emoji 替换为统一图标。
2. 首页粘贴链接入口或文案调整。
3. 战绩空状态。
4. 表单控件和主按钮层级统一。

## 8. 回归验收清单

开发完成后建议按以下路径回归：

1. 新建一场活动，确认不会出现 AA/费用相关文案。
2. 建局成功后看到活动分享卡预览，并能转发。
3. 用多个用户或 seed 数据验证报名、候补、请假三类头像墙。
4. 普通球友进入活动后能自助签到。
5. 局长能添加临时球友、调整水平、确认参赛。
6. 分组前能选择参赛者，并能理解智能平衡、美式、墨式区别。
7. 生成分组后能调整人员位置，交互方式与文案一致。
8. 开启混双时，排阵结果符合混双约束；无法满足时有提示。
9. 计分后进入结算页，能看到今日榜、MVP 和战报分享卡。
10. DevTools Console 无业务 error，真机切页无旧页面残影。

