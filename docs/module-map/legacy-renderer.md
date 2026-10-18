# 模块地图 · legacy 回滚界面（已冻结）

> 总述和其他分册见 [`../MODULE-MAP.md`](../MODULE-MAP.md)；当前界面在 [`renderer-v2.md`](./renderer-v2.md)。路径相对 `src/`。

> **`src/renderer-v2/` 以外的部分是 legacy 回滚版，2026-09-19 起冻结，只接受安全修复**（`R-S12`，yoyo 拍板）。新功能、界面调整与一般/建议级缺陷只在 `src/renderer-v2/` 做；代码与 `compile:legacy` / `dev:legacy` 不删，既有测试继续跑。完整口径见 `AGENTS.md` T14 与 `.claude/rules/legacy-renderer.md`。下面这张表因此是**存量地图**，不是待办清单。

- `main.tsx` — 挂载 React + 全局错误上报（只在 `XINGMANG_RENDERER=legacy` 时由 `index.html` 加载）
- `App.tsx` — **仍持有全部全局状态**。#30 的批 0-3 已把内嵌大组件全部搬出，但账号体系与 AI 聊天又把它喂大了：App() 本体数十处 `useState`，页面切换仍是一条长三元链。**#30 已随 legacy 冻结关闭（2026-09-19）**：这个文件不再拆，只在安全修复时改；等价的拆分问题在 v2 侧看 `pages-account.tsx` / `pages-maintenance.tsx` / `pages-management.tsx`
- `app-shared.ts` / `provider-meta.ts` / `navigation.ts` / `provider-registry.ts` — 共享底座：纯工具函数与空快照 / provider 视觉元数据 / 侧边栏页面清单 / **provider 身份与两种展示顺序的单一来源**（rank 表派生，见 T2）
- `styles.css` — **另一个巨型枢纽文件**（全局作用域、无模块化）
- `components/` — 通用件 `AppFrame` / `Sidebar` / `Toast` / `Dialog` / `ProviderTabs` / `RuntimeCell` / `StatusMark` / `StartupSplash` / `ErrorBoundary`；从 App.tsx 搬出的 `onboarding/`（含 `NodeInstallGuide`）、`config/`（`ConfigDialog` 等 4 件）、`dashboard/`（`Dashboard` / `CodexDesktopCard` / `NextStepsCard`）
- `components/account/`— 账号体系全部 UI：`AccountCenterPage`(个人中心) / 登录 / 注册 / 找回密码 / 写 Key 确认弹窗 / `AccountArea`(侧边栏账号区)，纯逻辑拆在 `account-center.ts` / `account-errors.ts`(错误中文化) / `validation.ts`
- `components/welcome/WelcomePage.tsx` — 欢迎页（`startup-gate.ts` 决定老用户直进工作台）
- `pages/` — 十余个页面（含 `AiChatPage`），最大的 `MaintenancePage` `PluginsPage` `McpPage`
- **纯逻辑层（测试都打在这里）** — `scan-coordinator.ts` / `latest-request.ts` / `provider-extension-coordinator.ts` / `onboarding-flow.ts` / `onboarding-runtime.ts` / `startup-settings.ts` / `startup-gate.ts` / `account-provisioning.ts`(账号→写 Key 链) / `renderer-error-report.ts` / `error-message.ts` / `local-path-display.ts`
- `types.ts` — `export *` 转发 ipc-contract 的类型
- `platform-presentation.ts` — 旧界面的平台差异：按平台能力给出展示文案与安装动作（`platformPresentation`、`performNodeRuntimeAction`、`performCliInstallAction`），能力探测失败时用一律关死的 `failClosedPlatformCapabilities`。改它会自动加载 `.claude/rules/macos-platform.md`；renderer-v2 不用它
