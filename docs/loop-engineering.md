# Loop Engineering · 报名签到闭环

> 本文先编制 v1 的第一个业务闭环：报名 / 候补 / 请假 / 签到。
> 目标不是重复用户故事，而是把「用户现场动作 → 系统状态 → 工程模块 → 验收证据 → 下一轮反馈」串起来。

关联基线：

- 产品范围：[`product-plan-v0.1.md`](./product-plan-v0.1.md)
- 用户故事：[`user-stories-v0.1.md`](./user-stories-v0.1.md) 的 E3 / E4
- 覆盖对账：[`validation.md`](./validation.md) 的 E3 / E4
- 架构映射：[`architecture.md`](./architecture.md) 的 Signup / Participant / API 映射

## 1. 闭环定义

报名签到闭环覆盖从球友点开活动到局长拿到可分组名单的过程：

```text
活动详情
  → 报名 / 满员候补 / +1 带人 / 取消 / 请假
  → 三类头像墙确认局况
  → 球友自助签到 或 局长批量勾签到
  → 候补补位 / 临时球友 / 本场水平确认
  → 生成分组输入 participants
```

闭环完成的定义：

- 球友知道自己当前状态：未报名、已报名、候补中、已请假、已签到。
- 局长能一眼看到已报名、候补、请假三类人，不需要回微信群数人头。
- 满员后新报名进入候补；有人取消或请假时，自动补位能按候补顺序转正。
- 到场名单能被局长确认，并能补临时球友、调整本场水平。
- 最终 `GET /activities/:id/participants` 只把已签到真人和 Guest 作为分组输入。
- 小程序内不出现支付、AA、费用结算等红线文案。

## 2. 角色与现场问题

| 角色 | 现场问题 | 闭环里要解决的事 |
|---|---|---|
| 球友 P | 点开链接后要立刻知道能不能打、排不排得上、到场后要不要找局长 | 报名、候补、请假、自助签到都在活动详情完成 |
| 局长 L | 现场最怕名单乱、候补没人管、没扫码的人进不了分组 | 三类头像墙、签到页、候补补位、Guest 和本场水平确认 |
| 临时球友 G | 现场来了但没微信扫码，仍要能参赛和计分 | 由局长在签到页添加 Guest，进入 Participant 池 |

## 3. 状态机口径

| 动作 | 前置状态 | 目标状态 / 结果 | 关键约束 |
|---|---|---|---|
| 报名 | 未报名 | `SIGNED_UP` 或 `WAITLIST` | 容量足够转正选；容量不足进候补 |
| +1 带人 | `SIGNED_UP` | 更新 `plusOne`，重新计算正选/候补 | 占位数按 `1 + plusOne` 计算；报名时只填数字、不强填名字 |
| +1 占位物化 | 进入签到页 | 按 `plusOne` 幂等生成归属带人者的 `Participant(isGuest=true, broughtBySignupId)` | 只补缺/回收多余，不回灌局长改过的昵称/水平；已进对阵的不删 |
| 编辑/移除 +1 占位 | 占位存在 | 改昵称/本场水平；移除时带人者 `plusOne -= 1` | 仅局长；移除即「少带一个」释放名额，避免 reconcile 复活 |
| 取消报名 | `SIGNED_UP` / `WAITLIST` | 删除报名记录 | 局长不能取消自己的默认报名；释放名额后触发自动补位 |
| 请假 | 已报名 | `LEAVE` | 仍保留在名单里给局长识别；释放名额后触发自动补位 |
| 自助签到 | `SIGNED_UP` | `checkedIn=true/false` | 请假者、候补者不能签到 |
| 局长勾签到 | 任意报名记录 | 更新 `checkedIn` 和 `perGameLevel` | 只有局长可批量操作 |
| 添加 Guest | 活动存在 | 新建 `Participant(isGuest=true)` | 只由局长操作，不绑定 openid |
| 候补补位 | `WAITLIST` | `SIGNED_UP` | 自动补位按容量判断；手动补位属于现场裁量，操作前要确认场地和人数 |
| 生成分组输入 | 签到确认后 | `Participant[]` | 已签到真人会被物化；Guest 直接进入输入池 |

## 4. 工程映射

### 后端

| 责任 | 文件 | 说明 |
|---|---|---|
| 报名、取消、请假、名单查询 | `backend/src/modules/signups/routes.ts` / `service.ts` | 处理 `SignupStatus`、容量、候补自动补位、三类列表排序 |
| 签到、Guest、候补补位、参赛者池 | `backend/src/modules/checkin/routes.ts` / `service.ts` | 处理局长批量签到、球友自助签到、Guest、`ensureParticipants` |
| 活动聚合状态 | `backend/src/modules/activities/mapper.ts` | 给活动详情提供 `signedUpCount`、`waitlistCount`、`leaveCount`、`mySignupStatus`、`myCheckedIn` |
| 共享类型 | `shared/src/dto.ts` / `shared/src/enums.ts` | `SignupVM`、`CheckinListVM`、`ParticipantVM`、`SignupStatus` |
| 自动化验收 | `backend/test/api.test.ts` | 覆盖报名、候补、补位、请假、签到、Guest、自助签到、参赛者池 |

### 前端

| 责任 | 文件 | 说明 |
|---|---|---|
| 活动详情与球友操作 | `frontend/src/pages/activity/index.tsx` | 展示三类头像墙；承载报名、取消、请假、+1、自助签到、分享入口 |
| 局长签到页 | `frontend/src/pages/checkin/index.tsx` | 批量勾签到、改本场水平、加 Guest、候补补位、进入分组 |
| 接口封装 | `frontend/src/services/endpoints.ts` | 统一封装 `signup`、`leave`、`selfCheckin`、`batchCheckin`、`promote` 等请求 |
| 红线文案过滤 | `frontend/src/utils/format.ts` | `cleanRemark` 兜底过滤历史脏备注里的钱相关文案 |

## 5. 验收证据

### 自动化

必须至少通过：

```bash
pnpm --filter @badminton/backend test
```

当前 E3 / E4 自动化覆盖点：

- capacity=4 时，局长默认报名，p1/p2/p3 正选，p4 满员进入候补。
- p3 取消后，p4 按候补顺序自动补位为正选。
- 局长不能取消自己的报名。
- p5 请假后状态为 `LEAVE`。
- 局长批量签到 host/p1/p2/p4，并写入本场水平。
- 非局长批量签到被拒绝。
- 普通球友可自助撤销 / 签到自己。
- 请假者自助签到被拒绝。
- 添加 Guest 后，`participants` 返回已签到真人 + Guest。

### 小程序手动验证

手动验证不只看接口，要在微信开发者工具或真机确认可感知体验：

1. 用局长账号建局，进入活动详情后看到自己在已报名名单。
2. 换普通账号报名，活动详情显示「已报名」状态，头像墙人数正确。
3. 把容量填满后继续报名，确认新用户进入「候补」区块。
4. 取消一个正选，确认候补自动补位，三类头像墙刷新正确。
5. 已报名用户执行「+1 带人」，确认：活动详情头像墙在带人者旁多出 N 个「XX带」虚位影位；进签到页后这些 +1 自动显形为「XX的朋友」占位行，可改名/改本场水平/移除（移除后「带 N 人」同步减 1）。
6. 已报名用户执行「请假」，确认进入请假区块，不能再自助签到。
7. 普通球友点击「我已到场 · 签到」，再撤销一次，局长签到页能看到同步结果。
8. 局长在签到页全选 / 取消全选、单人改本场水平、添加 Guest、候补补位。
9. 点击「确认参赛 · 去分组」后，分组页只出现已签到真人和 Guest。
10. 全流程页面不出现 AA、付款、费用、收款、结算等 v1 红线文案。

### 证据留存

- 自动化结果写入 `docs/validation.md` 的 E3 / E4 与测试结果区。
- UI 截图临时放 `.tmp/`，不要提交。
- 如果 DevTools 出现 `appServiceSDKScriptError timeout` 或切页残影，应在 `docs/ui-ux-fidelity-handoff-2026-06-25.md` 或后续 handoff 中单独记录，不用把它混进接口覆盖结论。

## 6. Done Definition

报名签到闭环可以标记为完成，必须同时满足：

- `docs/validation.md` 中 US-3.1 到 US-4.5 都有接口、页面和测试 / 手动验收依据。
- 后端测试通过，且 E3 / E4 覆盖点没有退化。
- 前端至少通过 `pnpm --filter @badminton/frontend typecheck` 和 `pnpm --filter @badminton/frontend build:weapp`。
- 微信开发者工具或真机走完「报名 → 候补 → 请假 → 自助签到 → 局长签到 → participants」链路。
- 截图或记录能证明三类头像墙、自助签到、签到页候补补位、Guest、本场水平调整都可被用户看见和操作。

## 7. 下一轮反馈

这一轮只编制报名签到闭环。下一轮建议按现场依赖顺序继续：

1. 分组 / 排兵 Loop：验证签到名单如何进入选人、模式、设置、看板和微调。
2. 计分 / 看板 Loop：验证对阵、录分、改判、今日榜的数据闭环。
3. 分享 / 战报 Loop：验证建局分享卡和赛后战报卡的增长闭环。
