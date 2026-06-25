# 全站统一页面框架 · 方向变更与落地（2026-06-25）

> 本文记录一次**有意偏离原高保真稿**的框架级方向变更。原稿 `design/羽毛球组局 · 高保真.dc.html` 仍是各页内容与配色的参考，但「顶部/底部布局」以本文为准。

## 1. 背景与决策

原高保真稿是「三类页面、差异化布局」：

- tab 主页（首页/战绩/我的）：绿色 hero + 底部 tab；
- 活动详情：绿色 hero + 操作区，**无底部 tab**；
- 流程页（签到/分组/看板/计分/结算）：白色标题条 + 操作区，**无底部 tab**。

产品决策（知情后拍板）：改为**全站统一框架**，让「页面差异集中在主体，顶部/底部保持一致」，便于用户在任意页面快速切换到「我的/战绩」。

## 2. 统一框架定义

每个页面 = **顶部小 header（绿色）+ 可滚动主体 + 可选底部操作区 + 底部常驻 tab**。

由组件 `frontend/src/components/PageFrame` 提供：

| 槽 | 说明 |
|---|---|
| `title` | 顶部绿色小 header 标题（篇幅小、各页一致） |
| `back` / `onBack` | 左上角返回，默认 `goBack`（无上级回主页，见 §5） |
| `headerRight` | header 右侧操作槽 |
| `subHeader` | 固定在 header 下、主体上方、不随主体滚动的次级头部（步骤条/轮次切换） |
| `footer` / `footerBare` | 底部操作区，浮在 tab 栏正上方；`footerBare` 用页面背景、无白底分隔线 |
| `overlay` | 弹层/Modal，渲染在滚动区外避免被裁剪 |
| `activeTab` | 底部常驻 tab 高亮项；不传则不渲染（交给根 tab 页的 custom-tab-bar） |

主体内部由 PageFrame 用 `<ScrollView scrollY>` 包裹，页面只写主体内容。

## 3. 底部 tab 架构

视觉单元 `components/TabBar`（带图标 + 药丸选中态，对齐原高保真稿）被两处共用，全站一致：

- **根 tab 页（home/profile/me）**：`app.config` 开 `tabBar.custom: true`，由 `src/custom-tab-bar/index.tsx` 渲染 `TabBar fixed`，高亮由路由推导，`switchTab` 切页。
- **子页（非 tab 页）**：`PageFrame` 内联渲染 `components/BottomTab`（包装 `TabBar`，非 fixed，作为 flex 子元素），`switchTab` 跳回根 tab。

tab 高度统一 `--tabbar-h`（`styles/tokens.scss`）。

## 4. 各页落地映射

| 页面 | 顶部 | 主体 | 底部操作区 | 底部 tab |
|---|---|---|---|---|
| 活动详情 `activity` | 小 header（活动标题） | **绿色信息卡**（状态/时间/地点/玩法，下沉自原 hero）+ 报名名单 + 分享 | 局长/球友操作（`footerBare`） | BottomTab（高亮球局） |
| 签到 `checkin` | 小 header | 签到清单 + 候补 + Guest | 确认参赛·去分组 | BottomTab |
| 分组 `grouping` | 小 header + **步骤条 subHeader** | 5 步向导主体 | 上一步/下一步/生成/确认（随步骤） | BottomTab |
| 看板 `board` | 小 header + **轮次切换 subHeader** | 场地对局卡（操作在内容流） | 无固定 footer | BottomTab |
| 计分 `scoring` | 小 header（带动态场地号） | 大字比分卡 | 改判/确认胜负（`footerBare`） | BottomTab |
| 结算 `summary` | 小 header | 今日榜/MVP/排行 | 生成战报/结束活动 | BottomTab |
| 发起/编辑 `create` | 小 header（动态标题） | 表单 | 提交 | BottomTab |
| 首页/战绩/我的（tab 主页） | **保留绿色 hero 门面** | 各自内容 | — | custom-tab-bar |

tab 主页保留 hero 门面（小程序惯例 + 信息密度），其顶部风格本就统一、底部已由 custom-tab-bar 统一。

## 5. 返回逻辑

`utils/nav.ts` 的 `goBack()`：导航栈深 > 1 返回上一页，否则 `switchTab` 回首页——修复分享链接直达页面点返回时 `navigateBack:fail cannot navigate back at first page`。

## 6. 待真机验证（微信开发者工具/真机）

1. **custom-tab-bar 底部留白**：`tabBar.custom: true` 下，tab 主页内容与 home 浮动建局按钮是否被底部 tab 栏遮挡；若被遮需给 home/profile/me 的滚动主体补 `padding-bottom`、并把 fab 上移一个 `--tabbar-h`。若出现底部双倍空白则相反处理。
2. 各页顶部状态栏安全区、header 标题居中与超长省略。
3. 子页「操作区 + 常驻 tab」两层底部的间距与安全区。
4. 分组页步骤 5 的横向轮次条（ScrollView scrollX）嵌套在主体纵向 ScrollView 内的滚动表现。
5. 切页无旧页面残影、Console 无业务 error。

## 7. 涉及组件/文件

`components/PageFrame`、`components/TabBar`、`components/BottomTab`、`custom-tab-bar/`、`utils/nav.ts`、`styles/tokens.scss`（`--tabbar-h`）、`Icon`（新增 `grid`/`user`）。
