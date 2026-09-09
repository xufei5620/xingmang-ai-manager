# 模块地图

> 从 `CLAUDE.md` 第 3 节原样搬出（2026-09-09），内容未改。目的：让每个会话的固定上下文只装「改代码前必须知道的事」，模块清单按需再读。
> 行数、文件数是写入时的快照，以代码为准。

## macOS 相关模块

- `electron/macos-platform.ts` — macOS 终端启动器与平台能力
- `electron/macos-codex.ts` / `macos-codex-app.ts` — Codex CLI 与桌面端的 macOS 实现
- `electron/macos-grok.ts` — Grok 的 macOS 安装
- `electron/darwin-path-trust.ts` / `darwin-cli-staging.ts` / `macos-code-signing.ts` — 路径信任判定、CLI 私有暂存、codesign/Team ID 校验
- `electron/platform-capabilities.ts` — 跨平台能力探测的统一抽象
- `src/platform-presentation.ts` — 渲染层的平台差异表达

**改跨平台代码前先读 `platform-capabilities.ts`**，它是判断"当前平台支持什么"的单一入口。

## `electron/` 主进程

**进程入口与 IPC 边界**
- `main.ts` (669) — 生命周期、`BrowserWindow` 安全策略（`sandbox:true` / `contextIsolation:true`）、`xingmang://` 与 `xingmang-canvas://` 协议注册、外链白名单、装配服务
- `ipc-contract.ts` (522) — **唯一的跨进程类型真相源**。`as const satisfies` 强制通道表与接口对齐
- `preload.ts` (231) — sandbox 桥接层。因 `sandbox:true` 无法 require 本地模块，**手工复制了一份通道表**
- `ipc.ts` — 108 个处理器注册与参数校验

**命令执行与安全边界**（这里是本项目真正的复杂度所在）
- `command-runner.ts` (1120) — **全仓最关键模块**。`runCommand` 硬编码 `shell:false`；`trustedCommandEnvironment` 剥离 60+ 可注入环境变量并重建机器级 PATH；`findExecutable` 不调用 `where`/`which`/shell
- `security.ts` (172) — URL 策略。外链白名单要求 `href` **全等**匹配
- `windows-elevation.ts` (398) — 提权模式判定、可信命令断言、PowerShell 启动计划
- `windows-machine-paths.ts` (532) — 从注册表推导真实系统根 + ACL 校验
- `trusted-temp.ts` (494) — 受 ACL 保护的临时目录
- `managed-path-trust.ts` / `system-shell.ts`

**CLI 安装与运行时**
- `system-service.ts` (2901) — **最大模块**。前 1520 行是纯函数库（可直接单测），`createSystemService` 从 1521 行起是闭包工厂
- `tool-installation.ts` (628) / `node-runtime.ts` (1026) / `grok-installer.ts` (662) / `grok-update.ts` (161)
- `managed-cli.ts` / `managed-cli-paths.ts` / `native-cli-uninstall.ts` / `trusted-native-cli.ts`

**配置与数据**
- `config-files.ts` (879) — 四个 CLI 的配置读写，**两阶段提交 + .bak 备份 + 失败回滚**
- `app-settings.ts` (201) / `backups.ts` (891)
- `codex-sessions.ts` (1427) — Codex 会话权威源是 `~/.codex/state_5.sqlite` 的 `threads` 表；未知 schema 自动降级只读
- `provider-sessions.ts` (1199) — 四工具统一会话视图
- `codex-desktop.ts` (437) — 桌面端清单/包解析的纯函数层
- `codex-desktop-service.ts` (1427) — 桌面端探测、镜像下载、包校验与关停的服务层（从 system-service.ts 拆出）

**账号与计费（新增）**
- `new-api-client.ts` (1465) — **唯一对账号后端出网的模块**，I10 的参考实现：`performRequest` 超时 + 体积上限 + `redirect:'manual'` 且拒绝 3xx 且校验响应 origin（三重）+ 强制 https 拒内嵌凭据；上游文案 `redactCommandText` 脱敏 + 剥控制字符 + 截 300 字
- `account-session-store.ts` (201) — 登录 session 用 `safeStorage`（Windows 底层 DPAPI）加密落盘；损坏/解密失败静默降级为未登录，永不抛错
- `probe-failure.ts` (14) — 探测失败的可区分状态

**无限画布 + AI 工作区（全项目唯一运行第三方前端代码的地方）**

> 架构在 PR #85（2026-08-12）统一：**画布再也拿不到 API Key**。此前的做法是把 relay Key 注入画布 localStorage、由画布自己出网（`canvas-auth.ts` / `canvas-ai-config.ts` / `canvas-v2` 内的 relay 客户端），这三者已删除。现在全部 AI 调用都在主进程完成，画布只能经 `canvas-host:*` 通道请求。**改画布相关代码前先理解这条边界**：它是 I15 的兑现方式——被投毒的画布连 Key 都摸不到，因为它从来没有过。

- `canvas-window.ts` — 独立 `BrowserWindow`，加固与主窗口同级（`sandbox`/`contextIsolation`/`nodeIntegration:false`/`webviewTag:false`/`navigateOnDragDrop:false`），拦 `will-navigate` 与 `setWindowOpenHandler`；注册 **43 个** `canvas-host:*` 宿主通道（41 invoke + 2 push，I4 的例外，见下）
- `canvas-protocol.ts` (62) — `xingmang-canvas://` 解析。穿越/根包含检查**全部委托**主窗口同款 `resolvePackagedApplicationFile`，SPA 回退用字面量 `'index.html'` 重走同一函数，**绝不手工拼路径**；与主窗口不共享 rendererRoot
- `canvas-preload.ts` — 宿主桥暴露 41 个 invoke 能力并接收 2 个主进程推送，拿不到 `window.xingmang`。通道名与 `canvas-contract.ts` 是有意重复的字面量（I7），由测试钉死
- `canvas-contract.ts` — 宿主通道名的单一真相源（主进程侧）
- `canvas-request-parser.ts` / `canvas-run-contract.ts` / `canvas-run-engine.ts` / `canvas-node-executors.ts` — 入参白名单校验、运行契约、DAG 运行引擎与节点执行器（**都在主进程**）
- `canvas-account-lifecycle.ts` / `canvas-fingerprint.ts` — 账号切换隔离与画布指纹
- `canvas-project-package.ts` / `canvas-prompt-preset-store.ts` — 项目导入导出（导出会清理凭据/本机路径/远端 URL）与提示词预设
- `ai-chat-service.ts` (770) / `ai-image-service.ts` (378) / `ai-chat-protocol.ts` / `ai-asset-store.ts` — 主进程侧的聊天流式、图像生成（`/v1/images/generations` 与 multipart 的 `/v1/images/edits`）、协议校验与产物落盘
- `chat-credential-coordinator.ts` (200) — **按分组按需签发并缓存 Key**（`xingmang-chat-*`）：命中缓存先验、失效自愈（被吊销就重签）、账号切换即失效。这是 2026-08-12 画布 503（令牌分组下无可用渠道）的根治方案
- `canvas-v2/` 是当前画布源码；`dist-canvas/` 是构建产物**不入 git**。`npm run canvas:prepare` 构建源码并由 `scripts/copy-canvas-assets.mjs` 复制（可用 `XINGMANG_CANVAS_DIST` 覆盖）。云端测试包与 CI 正式包都现场构建 `canvas-v2` 打入

**扩展生态**
- `provider-extensions.ts` (1585) — 四工具统一的 MCP/Skill/Plugin 抽象
- `codex-extensions.ts` (1254) — Codex 专用。DTO 只暴露 env **变量名**不暴露值

**更新、诊断、工具库**
- `updater.ts` (451) / `update-signature.ts` (208)
- `diagnostics.ts` (868) / `runtime-log.ts` (340) / `models.ts`
- `catalog.ts`（provider 单一定义源）/ `versions.ts` / `installation-queue.ts` / `path-identity.ts`（跨平台路径身份比对）
- `safe-local-data.ts` / `bounded-file.ts` / `bounded-directory.ts` / `bounded-response.ts`

## `src/` 渲染进程

- `main.tsx` — 挂载 React + 全局错误上报
- `App.tsx` (2009) — **仍持有全部全局状态**。#30 的批 0-3 已把内嵌大组件全部搬出，但账号体系与 AI 聊天又把它喂大了：App() 本体 56 处 `useState`，页面切换仍是一条长三元链。**#30 未完结，且在持续恶化**
- `app-shared.ts` / `provider-meta.ts` / `navigation.ts` / `provider-registry.ts` — 共享底座：纯工具函数与空快照 / provider 视觉元数据 / 侧边栏页面清单 / **provider 身份与两种展示顺序的单一来源**（rank 表派生，见 T2）
- `styles.css` (8413) — **另一个巨型枢纽文件**
- `components/` — 通用件 `AppFrame` / `Sidebar` / `Toast` / `Dialog` / `ProviderTabs` / `RuntimeCell` / `StatusMark` / `StartupSplash` / `ErrorBoundary`；从 App.tsx 搬出的 `onboarding/`（含 `NodeInstallGuide`）、`config/`（`ConfigDialog` 等 4 件）、`dashboard/`（`Dashboard` / `CodexDesktopCard` / `NextStepsCard`）
- `components/account/`（16 件）— 账号体系全部 UI：`AccountCenterPage`(712，个人中心) / 登录 / 注册 / 找回密码 / 写 Key 确认弹窗 / `AccountArea`(侧边栏账号区)，纯逻辑拆在 `account-center.ts` / `account-errors.ts`(错误中文化) / `validation.ts`
- `components/welcome/WelcomePage.tsx` — 欢迎页（`startup-gate.ts` 决定老用户直进工作台）
- `pages/` — 14 个页面（新增 `AiChatPage`），最大的 `MaintenancePage` `PluginsPage` `McpPage`
- **纯逻辑层（测试都打在这里）** — `scan-coordinator.ts` / `latest-request.ts` / `provider-extension-coordinator.ts` / `onboarding-flow.ts` / `onboarding-runtime.ts` / `startup-settings.ts` / `startup-gate.ts` / `account-provisioning.ts`(账号→写 Key 链) / `renderer-error-report.ts` / `error-message.ts` / `local-path-display.ts`
- `types.ts` — `export *` 转发 ipc-contract 的类型
