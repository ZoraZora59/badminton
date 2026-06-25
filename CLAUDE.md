# 仓库协作说明

本文件是 Codex 和 Claude 共用的仓库级协作入口。`AGENTS.md` 应保持为指向本文件的软链接，不要维护两份内容。

## 交流与交付

- 使用中文沟通。
- 默认直接推进到可验证状态：先看现状，再改动，再运行相关验证，再说明结果。
- 不要只给泛化建议；代码任务需要尽量闭环到实现和验证。
- Review 或验收类任务先列问题，按严重度排序，给出文件位置、影响和整改建议。
- 如果发现产品方案、设计稿、文档和代码不一致，直接指出不一致来源，不要用实现反推需求。

## 每次开工先看

1. `git status --short`
2. `README.md`
3. 和任务相关的 `docs/` 文档
4. 涉及 UI/UX 时看 `design/` 和 `docs/ui-ux-fidelity-handoff-2026-06-25.md`
5. 涉及产品范围时看 `docs/product-plan-v0.1.md` 和 `docs/user-stories-v0.1.md`
6. 涉及架构、接口、数据模型时看 `docs/architecture.md`
7. 涉及验收状态时看 `docs/validation.md`

## Loop Engineering 约束

- 涉及报名、候补、请假、+1 带人、签到、候补补位、临时球友、本场水平、分组输入的任务，必须先读 `docs/loop-engineering.md` 和 `docs/validation.md` 的 Loop Engineering 对账及 E3/E4。
- 处理上述任务时，不能只按页面或接口拆分，必须按「报名签到闭环」判断影响范围：活动详情 -> 报名/候补/请假/+1 -> 三类头像墙 -> 自助签到/局长签到 -> 候补补位/Guest/本场水平 -> `participants` 分组输入。
- 完成这类任务后，交付说明必须写清：改动影响了闭环中的哪些节点、是否需要更新 `docs/validation.md`、跑了哪些验证；如果没有跑微信开发者工具或真机验证，要明确说明剩余风险。
- 不允许把“接口存在”直接等同于“体验闭环完成”；涉及用户可感知流程时，需要同时看页面入口、状态反馈、手动验收路径和截图证据。

## 项目事实

- 项目名：`来打我呀`
- 类型：羽毛球组局微信小程序
- 目标流程：建局 -> 分享 -> 报名/候补/签到 -> 分组排兵 -> 对阵看板/计分 -> 今日榜/战报 -> 个人累计战绩
- 组织形式：pnpm workspace 单仓多工程
- 前端：Taro 3 + React 18 + TypeScript，仅 weapp
- 后端：Fastify 5 + Prisma 6 + MySQL 8
- 共享包：`@badminton/shared`
- 配置：后端只读 `backend/config/config.<env>.yml`，不从环境变量取业务/DB 配置

## 产品红线

- v1 不碰钱：不要新增支付、AA、费用结算、收款、价格等能力或文案。
- v1 不做球队/俱乐部：保持纯活动模型，不引入成员体系、队伍审批、俱乐部管理。
- 跨局排行榜、订阅消息、圈子榜是后续范围，不要顺手实现。
- UI 文案要贴近羽毛球现场，不要出现和产品红线冲突的占位文案。

## 当前重点缺口

优先参考 `docs/ui-ux-fidelity-handoff-2026-06-25.md`。截至 2026-06-25，重点缺口包括：

- 活动分享卡、战报分享卡没有真实预览/生成闭环。
- 发起页备注占位文案出现 `AA`，违反不碰钱红线。
- 页面切换在 DevTools 中观察到旧内容残影，Console 有 `appServiceSDKScriptError timeout`。
- 活动详情缺少已报名/候补/请假三类头像墙。
- 自助签到未放开。
- 分组页缺少真实选人和向导流程。
- 拖拽微调实际是点两名选手互换。
- （已解决）混双移至建局阶段（仅双打），分组引擎按性别强制组队；分组向导沿用建局的玩法/模式/场地/混双配置。

## 常用命令

```bash
pnpm install
pnpm build:shared
pnpm --filter @badminton/frontend typecheck
pnpm --filter @badminton/frontend build:weapp
pnpm --filter @badminton/backend build
pnpm --filter @badminton/backend test
```

后端开发：

```bash
pnpm dev:backend
pnpm --filter @badminton/backend db:push
pnpm db:seed
```

前端开发：

```bash
pnpm dev:frontend
```

## 代码边界

### shared

- 前后端都要用的枚举、DTO、等级映射优先放 `shared/`。
- 修改共享类型后，至少运行 `pnpm build:shared`，再跑受影响的前后端检查。

### backend

- 业务按 `backend/src/modules/<domain>/` 拆分，尽量保持 routes/service/schema/mapper 的现有风格。
- 分组核心逻辑在 `backend/src/modules/grouping/engine.ts`，应保持纯函数、可注入 seed、可单测。
- 涉及引擎、报名、签到、计分、战绩等规则变化时，补或更新 `backend/test/`。
- 不要把真实密钥、真实 config、上传文件写入仓库。

### frontend

- 当前只支持微信小程序，不要引入 H5/Web 分支。
- 页面在 `frontend/src/pages/`，通用组件在 `frontend/src/components/`。
- UI 要优先贴近 `design/` 和已有 Taro/SCSS 风格。
- 能用统一图标或组件时，不要继续新增 emoji 风格图标。
- 表单、空态、主按钮文案要可执行，不能写不存在的入口。

### docs/design

- 产品范围变化要同步 `docs/product-plan-v0.1.md` 或补充新的 handoff 文档。
- 实现状态变化要同步 `docs/validation.md`，不要把“接口存在”标成“用户体验已完成”。
- UI/UX 验收要保留截图证据，临时截图放 `.tmp/`，不要提交。

## 验证策略

- 小范围文案或文档改动：检查 Markdown 和链接即可。
- 前端页面改动：至少跑 `typecheck` 和 `build:weapp`；关键体验用微信开发者工具或真机看一遍。
- 后端业务改动：至少跑 `pnpm --filter @badminton/backend test`。
- shared 类型改动：跑 `build:shared`，再跑前端 typecheck 和后端测试。
- 分组引擎改动：必须补引擎单测，覆盖均衡、轮空、重复搭档/对手、混双等受影响规则。

## Git 工作方式

- 开工和收尾都看 `git status --short`。
- 仓库可能有未跟踪或他人改动，不要使用 `git reset --hard`、`git checkout --` 清理不属于本次任务的内容。
- 不要提交 `node_modules/`、`frontend/dist/`、`backend/dist/`、`.tmp/`、`.DS_Store`、真实 config、日志、密钥。
- 提交信息使用简短中文。
