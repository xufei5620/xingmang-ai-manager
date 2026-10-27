# 星芒 AI 导航与引导改版方案（#67 / #69）

> **状态（2026-08-08）**：方案经产品所有者确认，末尾五条开放决策**全部按推荐锁定**；实施暂缓（先修问题），启动实施需产品所有者明确下令。
> 依据：issue #67、#69；代码版本 HEAD `6f57921`（`local/integration`）。仅调研，未改代码。
> 前置：#30 第一步（引导组件搬迁）在本 HEAD 已完成，两条均解锁；瓶颈仍是 `App.tsx`（serial-only）+ `styles.css`。

## 方案 A：导航 IA

### 1. 11 项去向对照

| 现项 | 现分组 | 去向 | 理由 |
|---|---|---|---|
| 工具概览 | 工作台 | **保留**·改组「使用」·作落地页承载 #69 任务卡 | 最高频，兼上手入口 |
| 会话管理 | 工作台 | **保留**·改组「使用」 | 日常高频 |
| MCP 管理 | 扩展 | **原位**·加 hover 解释 | 中频，术语需解释 |
| Skills 管理 | 扩展 | **原位**·加 hover 解释 | 同上 |
| Plugins/市场 | 扩展 | **原位**·加解释·文案改「插件市场」 | 「/市场」歧义 |
| 配置备份 | 系统 | **进「更多」** | 出问题才用 |
| 健康诊断 | 系统 | **进「更多」** | 排障低频 |
| 安装维护 | 系统 | **进「更多」**（任务卡[再装一个]直达） | 装完后低频 |
| 反馈与诊断 | utility | **进「更多」** | 极低频 |
| 检查更新 | utility | **进「更多」**（顶部升级铃保留直达） | 有被动提醒 |
| 设置 | utility | **进「更多」** | 低频 |
| 无限画布(新) | — | **新增**「使用」组·占位 | #21 留位 |
| 账号区(新) | — | **侧栏底部**·不入列表 | #67 硬约束 |

### 2. 侧边栏结构图

```
┌─────────────────────┐
│ 星芒AI     [升级铃]  │  brand（不变）
├─────────────────────┤
│ 使用                │
│  ▤ 工具概览  ← 当前  │
│  ▤ 会话管理         │
│  ▤ 无限画布 ·soon   │  #21 占位
│ 扩展                │
│  ▤ MCP 管理    (?)  │
│  ▤ Skills 管理 (?)  │
│  ▤ 插件市场    (?)  │
│  ▸ 更多             │  默认折叠，展开=备份/诊断/维护/反馈/更新/设置
├─────────────────────┤
│ [账号区] 见 3        │  sidebar-bottom（新）
├─────────────────────┤
│ 教程文档 / 官方网站  │  不变
│ [主题] [收起]       │  不变
└─────────────────────┘
```
首屏可见 7 项（3+3+更多）✓≤8。收起态：图标轨，「更多」变 kebab 弹层，账号区仅头像+tooltip。

### 3. 账号区三态（本条只做骨架，数据接 #18）

| 态 | 显示 | 点击 |
|---|---|---|
| 未登录 | 灰头像 +「登录 / 注册」+ 副行「登录后查看余额」 | 打开登录弹层 / xm.solov.cc |
| 已登录 | 头像 + 昵称 + 余额`¥xx` + [充值] | 头像→账号弹层(明细/退出)；充值→充值页 |
| 余额告警 | 余额转红 + 警示图标 + [充值]高亮 | 同上；阈值由 #18 定，本条留样式钩子 |

### 4. Hover 解释初稿

- **MCP**：让 AI 连接外部工具和数据（数据库、浏览器等），扩展它能干的事。
- **Skills**：可复用的技能包，把常用流程固化，让 AI 一步到位。
- **插件市场**：社区做好的扩展，一键安装给 CLI 加功能。

### 5. 实施面

`navigation.ts`：`NavigationItem` 加可选 `hint?`、`placeholder?`（向后兼容）；加 `canvas` 项；`group` 语义改任务视角。`Sidebar.tsx`：groupLabels 改、「更多」受控折叠、账号区骨架、`(?)`。`App.tsx`：`PageId` 加 `'canvas'`（三元链缺分支=编译报错，安全）、账号区骨架、`moreExpanded`。`app-settings.ts`：加 `sidebarMoreExpanded?`（折叠持久化，#67 验收）。`styles.css`：账号区/折叠/tooltip。**兼容**：可选字段 + `PageId` 靠编译器穷尽保障；账号区不入 `PageId`（符合硬约束）。规模：跨 5 文件约 200-300 行，serial-only。

## 方案 B：新手引导

### 1. 新流程

```
启动(CLI未就绪)→onboarding
  ↓
第0步(新) 选工具「你想先用哪个？」  Codex/Claude/Gemini/Grok 四选一(单选)
  ↓ selected provider
第1步 授权   填授权码 → authorizeProvider(provider)
  ↓
第2步 环境   Node → 该 CLI  [仅 Codex 追加·桌面端(可选)]
  ↓
第3步 完成 → 进概览（任务卡接力）
```
非 Codex **不出现**桌面端步骤（#69 验收）。

### 2. 四选一改造（复用 > 重写，#69 硬约束）

- 新增 `ProviderPicker.tsx`（第0步，复用 `provider-meta.providers` 名/图标/色）。
- `CodexOnboarding` 泛化为 provider-aware 壳；Codex 分支保留桌面端逻辑。
- `onboarding-flow.ts` **只加不改**（现有测试全绿）：
  - `DEFAULT_MODELS: Record<ProviderId,string>`（泛化现常量）
  - `authorizeProvider(provider, rawApiKey, api)`（`authorizeCodex` 转调保留）
  - `prepareProviderEnvironment(provider, api, cb, caps)`—桌面端步骤 `if provider==='codex'`
  - `installNodeAndPrepareProviderEnvironment(provider, …)`、`buildDetectionFailureMessage(provider, status)`
- ⚠️ **风险点**：`getCodexSetupStatus`/`installCodexDesktop` 是 Codex 专用 IPC。非 Codex 建议走 `getCodexSetupStatus.runtime`（Node/npm 通用）+ `installCli(provider)` + scan 探测 `clis[provider].installed`，不套桌面端字段（见开放决策 4）。

### 3. 「下一步」任务卡·推导表

| 任务 | 完成判定 | 类型 |
|---|---|---|
| 装好首个 CLI | `installedCliCount≥1` | 快照可推导 |
| 首个 CLI 已配置星芒 | `config.providers[x].hasApiKey && matchesRelay` | config 可推导 |
| 打开终端试一下 [一键启动] | 无快照信号 → 会话内存态 | 不可推导 |
| 再装一个工具 [去维护] | `installedToolCount≥2` | 快照可推导 |
| 了解 MCP [去 MCP] | 无快照信号 → 会话内存态 | 不可推导 |

**卡片消失** = 全部**可推导**里程碑达成（首个 CLI 已装且已配置 且 `installedToolCount≥2`）。两个 nudge 任务的勾选走内存 `useState`（重启即清，**零持久化**），不参与消失判定。

### 4. 设置页「重新查看引导」

入口：`SettingsPage` 加一行「重新查看新手引导」+ [重新查看]。实现：`onReplayOnboarding?()` prop → App `() => setAppView('onboarding')`（复用现有 `appView`，**一行内存态，零持久化**）。**不复用 `XINGMANG_ONBOARDING_PREVIEW`**——它是 dev-only（`!app.isPackaged`+环境变量+需重启），非用户态机制。已配置用户重看时，`CodexOnboarding` 已容忍 `existingCodex.exists`（提示备份），可直接进。

### 5. 实施面

`onboarding-flow.ts`(+泛函+测试)、`CodexOnboarding.tsx`(泛化)、`ProviderPicker.tsx`(新)、`dashboard/NextStepsCard.tsx`(新，推导逻辑抽纯函数可测)、`App.tsx`(传 provider + 挂卡 + replay，serial-only)、`SettingsPage.tsx`(+行)。tooltip 与方案 A 共用。**依赖**：非 Codex 的 setup-status 链需先对齐/落主进程。规模：跨 6-7 文件约 400-500 行，serial-only。

## 留给拍板人的开放决策

1. **「开始使用」是否单列导航项？** 推荐**否**——概览即落地页且承载任务卡，单列会造空壳重复入口。
2. **画布先占位还是等 #21？** 推荐**先占位**（灰+·soon，点击提示即将上线）——锁定 IA，免 #21 再动导航，成本低。
3. **两个不可推导任务的完成 + 卡片重开口径？** 推荐**内存态标记**（零持久化）；消失=可推导里程碑全达成；设置页「重看」用 in-memory force-show——严守 #69 约束。
4. **非 Codex 引导的 setup-status 走哪条链？** 推荐复用 `runtime`(通用)+`installCli(provider)`+scan，不套桌面端字段；若需 `getProviderSetupStatus` 则先单开小 PR 落主进程——避免 Codex 专用 IPC 硬塞四工具。
5. **账号区未登录文案？** 推荐主「登录 / 注册」+ 副「登录后查看余额与充值」——中转商用户第一诉求是余额，未登录也要点出价值。
