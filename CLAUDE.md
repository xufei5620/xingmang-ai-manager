# CLAUDE.md

给 AI 编码 agent 的项目上下文。**动手改代码前先读完本文件。**

---

## 1. 这是什么项目

**星芒AI管理工具** — 面向 Windows 的 Electron 桌面客户端（Mac 适配进行中），是 AI API 中转服务商（`xm.solov.cc`）发给付费客户的配套软件。

**它解决的问题**：普通用户想用 Claude Code、Codex CLI 这类 AI 编程工具，得先装 Node.js、再用 npm 装 CLI、再手工编辑配置文件填 API Key 和 base URL——门槛太高。本工具把整条链路包成图形界面。

**商业定位**：不是通用工具。四个 CLI 的 base URL 全部硬编码指向 `xm.solov.cc`（2026-08-10 起中转与账号后端统一到同一 new-api 实例，原 `api.solov.cc` 退役），onboarding 填的是"安装授权码"。**它的价值 = 降低客户接入门槛、减少客服成本。这条链路断了，用户就退款。**

**管理对象**：Claude Code（`@anthropic-ai/claude-code`）、Codex CLI（`@openai/codex`）、Gemini CLI（`@google/gemini-cli`）、Grok CLI（`@xai-official/grok`），外加 Codex 桌面端。

**内置的两块新能力**（2026-08 集成）：
- **星芒账号**：对接 `xm.solov.cc`（第三方开源 QuantumNous/new-api 的生产实例）——注册/登录/找回密码/余额/用量/Key 管理/充值外链，登录后自动签发 CLI Key 并写进 CLI 配置。
- **无限画布**：vendored 的 infinite-canvas（MIT）静态构建，在独立隔离窗口运行，AI 画图/视频与 CLI 共用同一账号额度。

---

## 2. 技术栈与规模

Electron 43 + React 18 + TypeScript 5.7 + Vite 8 + vitest。**桌面端自身没有后端**；线上资产 = 静态更新目录 + 账号后端 `xm.solov.cc`（new-api 生产实例，实测 v1.0.0-rc.24，端点事实见 `docs/RECON-new-api.md`）。⚠️ **自动化测试绝不对生产实例发真实请求，一律 mock**。

**Windows 与 macOS 双平台**（macOS 支持已于 `ca592df` 合并）。

| | 源码 | 测试 |
|---|---|---|
| `electron/`（主进程，全部特权操作） | 63 个模块 | 60 个 |
| `src/`（渲染进程，纯 UI） | 62 个文件 | 25 个 |

约 6.3 万行（含测试），**1455 个 vitest 用例**（85 个文件；Linux 上实测 1278 过 / 177 因平台门控跳过，Windows 跳过的是另一批），`npm test` 还串带 scripts/e2e 下的 node --test 套件（79 例）。IPC：**90 个 invoke 通道**（另有 6 个画布宿主通道在 90 之外，见 I4 例外）。

**常用命令**（耗时都很短，应作为每次改动的硬门槛）：

```bash
npm run typecheck   # 三连检：渲染 tsconfig + 主进程 tsconfig + electron 测试 tsconfig
npm test            # vitest（electron+src）+ node --test（scripts/e2e）。Linux 实测 ~12s；Windows 实测 ~13s，Defender 实时扫描介入时可拖到 60~90s
npm run test:windows    # Windows 备用：关文件级并行 + 30s 超时，专治 Defender 引发的超时失败
npm run compile     # 清理 + vite build + tsc + 压缩。缺画布产物时优雅跳过（见 T13），照常通过
npm run dev         # 开发模式。predev 会先复制画布产物 + 全量编译一次主进程（消 electron 抢跑竞态）
npm start           # 直接跑已编译产物（需先 compile），免 dev server
npm run build:mac:dir   # macOS 本机 ad-hoc 签名解包应用
```

### ⚠️ 测试基线：Windows 是否全绿取决于机器环境

**动手前先在干净基线上跑一遍记下失败数**，改完对比。已知失败全部与环境相关，**不是你弄坏的**：

| 平台 | 已知失败 | 原因 | Issue |
|---|---|---|---|
| **Windows** | **0~9（环境相关）** | 4 个需要 `SeCreateSymbolicLinkPrivilege`（未开发者模式且非管理员时 EPERM）；5 个可能卡 vitest 默认 5s 超时（真实磁盘两阶段提交 + Defender 实时扫描）。开发者模式开启且磁盘不忙的机器可以全绿（2026-08-08 本机 `npm test` 实测 0 失败、vitest 12.7s） | **#40** |
| **macOS** | 0 | — | — |
| **Linux** | 0 | 原 `samePathIdentity` 误删缺陷已修复：launcher 文件清理现走 `sameFileIdentity`（追加 size/nlink/mtime/ctime 比对，`macos-platform.ts:105` 起） | #2 已关闭 |

遇到超时类失败先用 `npm run test:windows` 复核；符号链接类失败开启 Windows 开发者模式即可消除。基线与上表不符请到 **#40** 报告。

> 云端/CI 容器提示：e2e 里 2 个 Playwright 布局用例要真浏览器，若容器预装的 Chromium 版本号与 `@playwright/test` 期望不符会报 "Executable doesn't exist"——环境问题不是回归，指个可用的 executablePath 复跑即绿（vitest 与 scripts 套件不受影响）。

> 改动前先跑一遍记下失败数，改动后对比，**不要引入新失败**。

### macOS 相关模块（新增）

- `electron/macos-platform.ts` — macOS 终端启动器与平台能力
- `electron/macos-codex.ts` / `macos-codex-app.ts` — Codex CLI 与桌面端的 macOS 实现
- `electron/macos-grok.ts` — Grok 的 macOS 安装
- `electron/darwin-path-trust.ts` / `darwin-cli-staging.ts` / `macos-code-signing.ts` — 路径信任判定、CLI 私有暂存、codesign/Team ID 校验
- `electron/platform-capabilities.ts` — 跨平台能力探测的统一抽象
- `src/platform-presentation.ts` — 渲染层的平台差异表达

**改跨平台代码前先读 `platform-capabilities.ts`**，它是判断"当前平台支持什么"的单一入口。

---

## 3. 模块地图

### `electron/` 主进程

**进程入口与 IPC 边界**
- `main.ts` (669) — 生命周期、`BrowserWindow` 安全策略（`sandbox:true` / `contextIsolation:true`）、`xingmang://` 与 `xingmang-canvas://` 协议注册、外链白名单、装配服务
- `ipc-contract.ts` (522) — **唯一的跨进程类型真相源**。`as const satisfies` 强制通道表与接口对齐
- `preload.ts` (231) — sandbox 桥接层。因 `sandbox:true` 无法 require 本地模块，**手工复制了一份通道表**
- `ipc.ts` (1220) — 90 个处理器注册与参数校验

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

**无限画布（新增，全项目唯一运行第三方前端代码的地方）**
- `canvas-window.ts` (376) — 独立 `BrowserWindow`，加固与主窗口同级（`sandbox`/`contextIsolation`/`nodeIntegration:false`/`webviewTag:false`/`navigateOnDragDrop:false`），拦 `will-navigate` 与 `setWindowOpenHandler`；注册 6 个 `canvas-host:*` 宿主通道（I4 的例外，见下）
- `canvas-protocol.ts` (62) — `xingmang-canvas://` 解析。穿越/根包含检查**全部委托**主窗口同款 `resolvePackagedApplicationFile`，SPA 回退用字面量 `'index.html'` 重走同一函数，**绝不手工拼路径**；与主窗口不共享 rendererRoot
- `canvas-preload.ts` (65) — 宿主桥只暴露 6 个能力（getAuthToken/saveFile/pickFile/notify/openExternal/downloadAsset,末者为画布 v2 媒体落盘新增,过了 I15 投毒问答:流式限 512MB + https-only + 原生对话框选路径），拿不到 `window.xingmang`
- `canvas-auth.ts` (51) / `canvas-ai-config.ts` (122) — 取 token 与配置注入（`JSON.stringify` 构造，不拼字符串）
- `dist-canvas/` 是构建产物**不入 git**：`scripts/copy-canvas-assets.mjs` 从兄弟仓 `xingmang-canvas/web/dist` 复制（可用 `XINGMANG_CANVAS_DIST` 覆盖），缺源时打警告跳过、`compile` 照常通过，画布窗口运行时报中文错误

**扩展生态**
- `provider-extensions.ts` (1585) — 四工具统一的 MCP/Skill/Plugin 抽象
- `codex-extensions.ts` (1254) — Codex 专用。DTO 只暴露 env **变量名**不暴露值

**更新、诊断、工具库**
- `updater.ts` (451) / `update-signature.ts` (208)
- `diagnostics.ts` (868) / `runtime-log.ts` (340) / `models.ts`
- `catalog.ts`（provider 单一定义源）/ `versions.ts` / `installation-queue.ts` / `path-identity.ts`（跨平台路径身份比对）
- `safe-local-data.ts` / `bounded-file.ts` / `bounded-directory.ts` / `bounded-response.ts`

### `src/` 渲染进程

- `main.tsx` — 挂载 React + 全局错误上报
- `App.tsx` (1676) — **仍持有全部全局状态**。#30 的批 0-3 已把内嵌大组件全部搬出，但账号体系又把它喂大了：App() 本体（97 行起）50 个 `useState`、17 个 `useEffect`，页面切换是一条 14 分支三元链（1385 起）。**#30 未完结**
- `app-shared.ts` / `provider-meta.ts` / `navigation.ts` / `provider-registry.ts` — 共享底座：纯工具函数与空快照 / provider 视觉元数据 / 侧边栏页面清单 / **provider 身份与两种展示顺序的单一来源**（rank 表派生，见 T2）
- `styles.css` (7947) — **另一个巨型枢纽文件**
- `components/` — 通用件 `AppFrame` / `Sidebar` / `Toast` / `Dialog` / `ProviderTabs` / `RuntimeCell` / `StatusMark` / `StartupSplash` / `ErrorBoundary`；从 App.tsx 搬出的 `onboarding/`（含 `NodeInstallGuide`）、`config/`（`ConfigDialog` 等 4 件）、`dashboard/`（`Dashboard` / `CodexDesktopCard` / `NextStepsCard`）
- `components/account/`（16 件）— 账号体系全部 UI：`AccountCenterPage`(712，个人中心) / 登录 / 注册 / 找回密码 / 写 Key 确认弹窗 / `AccountArea`(侧边栏账号区)，纯逻辑拆在 `account-center.ts` / `account-errors.ts`(错误中文化) / `validation.ts`
- `components/welcome/WelcomePage.tsx` — 欢迎页（`startup-gate.ts` 决定老用户直进工作台）
- `pages/` — 12 个页面，最大的 `MaintenancePage`(992) `PluginsPage`(696) `McpPage`(594)
- **纯逻辑层（测试都打在这里）** — `scan-coordinator.ts` / `latest-request.ts` / `provider-extension-coordinator.ts` / `onboarding-flow.ts` / `onboarding-runtime.ts` / `startup-settings.ts` / `startup-gate.ts` / `account-provisioning.ts`(账号→写 Key 链) / `renderer-error-report.ts` / `error-message.ts` / `local-path-display.ts`
- `types.ts` — `export *` 转发 ipc-contract 的类型

---

## 4. 关键不变量（破坏后不报错，只会静默变成漏洞）

> 这个代码库的复杂度不在业务，在 Windows 提权 / 可信路径 / 原子写入这套不变量上。几乎每一行防御代码都对应一个具体攻击。

**I1. 执行外部命令必须 `execFile`/`spawn` + argv 数组，永不 `shell:true`、永不拼字符串。**
输入包含用户选的工作目录、Skill 路径、MCP command/args——任何一处进 shell 就是命令注入。全仓 0 处 `shell:true` / `execSync`。
*违反后果*：用户建一个名为 `a&calc.exe` 的目录即可执行任意命令；提权下是管理员级 RCE。

**I2. 跨提权边界的执行必须用 `trustedCommandEnvironment()` + `trustedOnly:true`。**
`NODE_OPTIONS`、`PSModulePath`、`DOTNET_STARTUP_HOOKS`、`BROWSER`、`GIT_ASKPASS`、`LD_PRELOAD` 等 60+ 变量能让子进程在启动瞬间加载攻击者代码（清单见 `command-runner.ts` 的 `unsafeKeys`(:244) / `unsafePrefixes`(:318) 两张表）。
*注*：交互式终端启动走 `interactiveTerminalEnvironment`，它的净化基底**由调用方传入**——`trusted-only` 传 `trustedCommandEnvironment`，same-user 传 `commandEnvironment`（缺省值，未跨越完整性边界，无需收窄 PATH）。颜色层叠在基底之上，**不要把整个函数换成 `trustedCommandEnvironment`**，那会连 `TERM`/`FORCE_COLOR` 一起剥掉，终端变无色。

**I3. API Key 明文永不随普通查询跨 IPC。**
`toNativeConfigSummary` 解构剥离 `apiKey`；明文仅走 `config:reveal-api-key`。**账号凭据同理**：`accessToken` / refresh cookie 在 IPC 契约里 0 处返回给渲染层（渲染层只拿登录态快照），加密落盘走 `account-session-store.ts`。
*违反后果*：用户一次"导出反馈"就把付费 Key 发到客服群。

**I4. 所有 `ipcMain.handle` 必须经 `registerTrustedHandler`。**
它统一做 sender URL 校验、结构化日志、dispose 注册。**唯一例外**：5 个 `canvas-host:*` 通道由 `canvas-window.ts` 的 `registerCanvasHandler` 注册——它做的是**更窄**的校验（`assertTrustedCanvasSender` 只放行画布窗口自身的 sender），主窗口调这些通道会被拒。新通道不许效仿，除非同样只服务一个隔离窗口。

**I5. IPC 入参一律视为敌意输入，必须显式校验。**
渲染进程虽是自家代码，但 XSS/依赖投毒后就是攻击面。`parseSessionId` 的 UUID 正则同时防路径穿越。
*违反后果*：`skills:uninstall` 收到 `../../../` 就删用户任意文件。

**I6. `ipc-contract.ts` 只能 `import type`，值导出只能来自无 Node 依赖的模块。**
`src/types.ts` 是 `export *`（值级别），Vite 会把它真的打进渲染 bundle。目前唯一值导出是 `providerIds`（来自零依赖的 `catalog.ts`）。
*违反后果*：加一个 `export { xxx } from './system-service'` → Vite 尝试打包 `node:fs` → 构建失败，或更糟：主进程逻辑泄进渲染进程。

**I7. `preload.ts` 是 sandbox 脚本，不能 import 本地运行时模块。**
这是通道表被复制两份的**唯一原因**。
*违反后果*：preload 加载失败 → `window.xingmang` undefined → 白屏，且打包版禁用了 devtools 难以排查。

**I8. 本地文件读写必须走 `safe-local-data` / `bounded-*` 系列。**
目标路径都在用户可写区，攻击者可放 symlink/junction/硬链接重定向写操作。检查点：`assertNoReparseComponents`、`nlink !== 1` 拒绝、`readBoundedUtf8File*`。

**I9. 配置写入必须两阶段提交 + 备份 + 失败回滚。**
一次保存要同时改多个文件（Codex 是 `config.toml` + `auth.json`），写一半会让 CLI 处于不可用的混合状态。

**I10. 每次网络请求必须有：超时 + 响应体上限 + 重定向策略 + URL 校验。**
更新源、npm registry、镜像站、账号后端都是外部可控的。参考实现：`new-api-client.ts` 的 `performRequest`（四件齐 + 重定向三重拒绝，防带着 Authorization 跳去别的主机）。
*违反后果*：镜像站一次重定向就能把安装源换成任意主机。

**I11. 安装/卸载/启动类操作必须过 `InstallationQueue`。**
这些操作会原子替换机器级目录，并发会互相看到半完成状态。同 key 复用同一 Promise，双击天然幂等。

**I12. 渲染进程导航与外链必须过白名单，外链要 `href` 全等匹配。**
刻意做全等而非前缀匹配，因为前缀匹配会被 `https://xm.solov.cc.evil.com` 绕过。画布窗口同样受此约束（`canvas-window.ts` 的 `will-navigate` / `setWindowOpenHandler` 都过白名单）；充值页 `/wallet` 已在白名单内。

**I13. 日志、诊断、导出必须脱敏。**
三层：`redactCommandText`（Bearer/sk-/api_key=）、`redactHomeDirectory`（路径→`%USERPROFILE%`）、`sanitizeValue`（按 key 名）。账号侧的 refresh cookie **值**也已并入 secrets 名单。

**I14. Windows 系统可执行文件必须由固定解析器给出绝对路径，不查 PATH、不读 COMSPEC。**
*违反后果*：当前目录放一个 `powershell.exe` 就被提权执行。

**I15. 画布是运行第三方前端代码的隔离区，能力只减不增。**
画布窗口与主窗口**不共享 rendererRoot**、preload 只暴露 6 个能力、协议解析必须委托 `resolvePackagedApplicationFile`。给画布加任何新能力前先回答：**画布被供应链投毒后，这个能力能干什么？** 文件读写必须走原生对话框（用户选路径）+ `bounded-*`/原子写，外链必须过白名单。
*违反后果*：画布上游一次投毒 = 拿到你给它的一切；今天它连主进程 IPC 都摸不到。

---

## 5. 改动陷阱清单

**T1. 加/删/挪 IPC 处理器 → 注册顺序必须与 `ipcInvokeChannels` 键顺序完全一致。**
`ipc.test.ts:275` 的 `toEqual` **对顺序敏感**。⚠️ **两个 agent 并行加通道，即使 git 文本合并成功，CI 也会红。** 加通道属于必须串行的任务。
（`preload.ts` 的副本顺序**不需要**一致，它只做键查找。）

**T2. 给 `ProviderId` 加第 5 个 CLI → 改动点已收口，编译器/测试会带你走完。**

顺序：`catalog.ts:1/14/49` 三处 → `config-files.ts` 六个 `switch`（**无 `default` 分支 + 非 void 返回类型 = 穷尽性保障**，漏了是编译错）→ **`src/provider-registry.ts` 的两张 rank 表**（概览序 codex/claude/grok/gemini 与管理序 codex/claude/gemini/grok，两种顺序是有意为之、各自只定义一次；`Record<ProviderId, number>` 内联字面量，漏键/错键是编译错 TS2741/TS2353，`provider-registry.test.ts` 的覆盖断言在纯测试路径下也会红）→ 各类 `Record<ProviderId, X>` 映射表（`provider-meta.ts:20`、`ProviderTabs.tsx` 的 labels、`PluginsPage.tsx:82` 等，全是编译错）。

历史包袱：这里曾有 5 处编译器沉默点（各页面自写 provider 联合类型/字面量数组），已随 #32 全部收口进 registry。**新的展示顺序数组只能定义在 registry 里，不要在页面里写字面量**。遗留手工点：概览页 `Dashboard.tsx:164` 的「N/5 个已安装」分母仍是硬编码。

**T3. 改 `system-service.ts` → 先确认改的是 2901 行里的哪一半。**
前 1520 行是纯函数（全部 export、测试直接调用）；`createSystemService`（1521 行起）之后是闭包（内部函数不导出）。**新逻辑优先写成顶层纯函数**再在闭包里调用，否则无法单测。这是最容易撞车的文件。

**T4. 动 `trustedCommandEnvironment` → 只能加禁止项，不能加放行项。**
三张表是白名单式收紧，每条对应一个具体攻击。放行任何变量前，先在测试里写出"该变量为什么安全"。

**T5. 修跨平台问题 → macOS 的路径信任问的不是 Windows 那个问题，别照搬。**

Windows 问「**低于 Administrator 的主体能不能写这里**」，因为那边程序可能持有提权令牌。**macOS 上这条边界不存在**：本程序从不提权（`electron/` 下无 `sudo` / `AuthorizationExecuteWithPrivileges` / `osascript ... with administrator privileges`，`resolveWindowsCliExecutionMode` 非 win32 恒返回 `'same-user'`），它把 CLI 装进 `$HOME`。

所以 macOS 保留了问题的**形状**，只换掉可信集合的**成员**（见 `electron/darwin-path-trust.ts`）：

| 函数 | macOS 上的语义 |
|---|---|
| `isUserWritablePath` | 「**除 root 与当前用户之外**的主体能否改动它解析后的目标」——沿完整祖先链判定 |
| `isTrustedHighIntegrityExecutable` | 绝对路径 + 上面那条。管住 `diagnostics.ts:360/400` 两处 |
| `trustedCommandEnvironment` | 重建 PATH：固定机器目录在前，继承项在后，**每一项都过同一个判定**，首次出现优先 |

⚠️ **两个最容易误读的点**：

1. **`isUserWritablePath` 在 macOS 上对 `~/.local/bin/node` 返回 `false`** —— 用户确实能写那个路径，但它不是「外部主体可达」。名字读起来像 `access(W_OK)`，实际不是。
2. **这不是同 uid 防御。** 能写 `~/.local/bin/node` 的攻击者同样能写 `~/.zshrc` 或装 LaunchAgent。它挡的是**跨主体**的写入路径（world-writable、他人属主、符号链接逃逸）。

**刻意不做**（各有理由，别当成遗漏顺手补）：不读 SIP 的 `SF_RESTRICTED` 标志、不读扩展 ACL —— Node 的 `fs` 两者都看不到（`fs.Stats` 无 `flags` 字段，`fs.chflags` 不存在，无 ACL API），只能每个组件 spawn 一次 `/usr/bin/stat` 或 `/bin/ls -lde`，而这是个同步热路径。也不做缓存：全链走一遍实测 ~11 µs，不值得，也就不继承 Windows 侧 `programFilesAclCache` 永不失效的陈旧信任隐患。

**gid 80（admin）算可信写入方**，因为 macOS 默认 sudoers 的 `%admin ALL=(ALL) ALL` 已让其等价 root。这是产品决策，不是推断 —— 程序读不到 `/etc/sudoers`（`0440 root`）。

**仍然欠着的**：`runCommand` 的 `trustedOnly` 在 POSIX 上只换环境，`trustedPaths` 被静默丢弃、可执行文件不做可信解析。今天 macOS 上传 `trustedOnly: true` 的调用点是 **0 个**，所以无实际影响，但**新增这类调用前必须先补上**。

**来源可信（codesign / Team ID）是与本条正交的另一条轴**，由 `macos-codex.ts` / `macos-grok.ts` / `macos-codex-app.ts` 和私有暂存负责，不在这三个函数的职责内。

**改跨平台代码前先读 `electron/platform-capabilities.ts`**，它是判断"当前平台支持什么"的单一入口。

**T6. 渲染进程加异步数据加载 → 必须用竞态守卫。**
三个现成工具：`scan-coordinator.ts`（扫描）、`latest-request.ts`（按 key 的页面数据）、`provider-extension-coordinator.ts`（切 provider）。直接 `await` 后 `setState` 会让慢响应覆盖新数据，切 tab 时 100% 复现。

**T7. 给 `src/` 加组件测试 → 当前没有 DOM 环境。**
仓库**没有 `vitest.config.ts`**，环境是默认的 `node`。src 下 25 个测试文件全部只测纯函数，没有一处 render。加 jsdom 是需要先与其他 agent 对齐的基础设施改动，**不要顺手做**。

**T8. electron 测试已纳入 typecheck（第三条 tsc），但 `tsconfig.electron.json` 的测试 exclude 千万别删。**
`npm run typecheck` 跑三段：根 tsconfig（src）、`tsconfig.electron.json`（主进程**产物**配置，仍 exclude 测试）、`tsconfig.electron.test.json`（纳入全部 electron 测试，自带 `noEmit: true`）。**基础配置的 exclude 是 dist-electron 不含测试产物的承重墙**——`npm run compile` 用的就是它，删掉 exclude = 测试代码进发布包。测试配置的 `rootDir: "."` 专为孤儿测试 `electron/onboarding-runtime.test.ts`（测的是 `src/onboarding-runtime.ts`）的跨目录 import 而设。

**T9. 给 `electron/` 加新模块 → 会被 typecheck 最多三遍。**
`tsconfig.electron.json` 与 `tsconfig.electron.test.json`（include 覆盖全部 electron 源码）必查；被 `ipc-contract.ts` 通过 `import type` 引用的还会进渲染 tsconfig 的程序图。三段都串在 `npm run typecheck` 里，跑这一条即可。

**T10. 改 `providerConfigPaths` 或配置格式 → 同时影响备份、恢复、诊断、启动前校验。**
消费者：`backups.ts`、`config-files.ts`、`diagnostics.ts`、`system-service.ts`、`main.ts`（启动前校验）。必须考虑老版本已产生的 `.bak` 与已有备份的兼容。

**T11. 看到根目录出现 `\tmp\xingmang-managed-cli-*` 目录 → 那是已知 bug 的产物，直接删除，不要提交。**
`managed-cli.test.ts` 在非 Windows 平台每跑一次就泄漏若干个（见待办批次 0）。

**T12. 改账号对接 → 端点事实以 `docs/RECON-new-api.md` 为准，别按 new-api 文档想当然。**
关键事实已从 rc.24 tag 逐行核实（`GET /api/token/` 返回**掩码** key、改密码需 `original_password` 且改后本设备原地续 token、认证要 `Authorization` + `New-Api-User` 双头缺一不可）。渲染层与主进程各有一份密码长度等字面量是**有意重复**（electron 不 import src，同 I6/I7 的理由）。**自动化测试绝不对生产 `xm.solov.cc` 发真实请求**；真机验证由用户走。

**T13. 画布相关改动 → 分清三个仓/目录的职责，别把产物当源码。**
画布**源码**在兄弟仓 `xingmang-canvas`（不在本仓）；`dist-canvas/` 是 copy 脚本搬来的**构建产物**，不入 git、缺了不算坏（compile 照过、画布窗口报中文错误）。改画布行为 = 去兄弟仓改完重新构建，**不要**改 `dist-canvas/` 里的产物文件。云端/CI 环境没有兄弟仓属正常状态。

---

## 6. 代码约定

> **这些是从现有代码统计出来的事实，不是新规定。写出来的代码要和现有代码无缝。**

**格式**（仓库无 lint 配置，但一致性极高，请手工遵守）
- **行尾不加分号**（现有 0 个）
- **字符串用单引号**（单引号 5358 : 双引号 92）
- 缩进 2 空格
- **禁止 `as any` / `@ts-ignore` / `eslint-disable`**（现有各 0 处，别开这个头）

**函数与命名**
- **模块顶层一律用 `function` 声明，不用箭头函数**（现有 652 : 0）
- 导出函数的动词有固定语义：
  - `inspect*` — 探测状态，返回结构化结果，不抛错
  - `resolve*` — 解析出一个确定值，找不到返回 null
  - `build*` — 纯函数构造对象/计划，不产生副作用
  - `validate*` / `assert*` — 校验，失败抛错
  - `ensure*` — 幂等地保证某状态存在
  - `create*` — 工厂，返回服务对象

**语言**
- **面向用户的错误消息一律中文**（553 : 10）
- **测试名一律英文**（487/487）
- **注释**：深层安全/协议不变量用英文长注释，具体缺陷复盘和中文语境的业务约束用中文。**注释写"为什么"，不写"做什么"。**

范例（`command-runner.ts`）：
```ts
// CLI tools may treat these as executable selectors. For example, an
// elevated OAuth login must not launch a user-supplied BROWSER command.
```

**类型**
- 优先 `interface` 描述对象结构，`type` 用于联合与别名
- 新增字段优先设为可选（`field?:`），语义约定"缺省 = 旧行为"，保证向后兼容
- 用类型守卫而非断言

**测试**
- 文件名 `<模块名>.test.ts`，与源码同目录
- `describe` 描述模块，`it` 描述行为，**英文**
- 平台相关测试用 `it.runIf(process.platform === 'win32')` 门控（参考 `command-runner.test.ts` / `node-runtime.test.ts`）
- 新逻辑优先写成纯函数再测，不要为了测试去 mock 整个闭包
- **涉及 new-api 的测试一律注入 mock fetch，绝不对生产 `xm.solov.cc` 发真实请求**（铁律，见 T12）

---

## 7. 开发流程

**改动前**
1. 读本文件第 4、5 节（不变量与陷阱）
2. 确认你的任务对应哪个 Issue，在 Issue 上留言认领
3. 从最新 `main` 拉分支

**改动中**
- 一个 PR 只做一件事
- 涉及安全边界的改动，先在测试里写出"为什么安全"

**提交前（硬门槛，两条都要过）**
```bash
npm run typecheck
npm test
```
> Windows 上可能有环境相关的已知失败（#40），**请对比改动前后的失败数是否一致**，不要引入新失败。

**提交**
见 `docs/COLLABORATION.md` 的分支命名与 PR 规范。

---

## 8. 不要做的事

- ❌ **不要引入 Prettier / 大改格式** — 现有风格一致性已经很高，全仓重排会摧毁 git blame
- ❌ **不要引入 Redux / Zustand / Jotai / MobX** — `App.tsx` 的 50 个 useState 里真正跨组件共享的只有少数几个（`snapshot/config/settings/theme/toast` + 账号态），props 深度 1-2 层；其余都是 `configOpen`、`logOpen` 这类局部 UI 开关。**正确解是拆组件，不是换状态方案。** 拆完仍嫌传得烦，最多加一个 Context
- ❌ **不要用 zod / valibot / ajv 替换 `ipc.ts` 的 15 个手写 parse 函数** — 它们产出的是能直接上屏的中文错误文案
- ❌ **不要开 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`** — 实测前者会新增 97 条错误，抽查全是已被前置校验保护的下标访问，**零个真 bug**。现在的 `strict: true` 已经足够
- ❌ **不要顺手加 jsdom / 组件测试设施** — 那是需要跨 agent 对齐的基础设施改动。`e2e/` 的约 2200 行套件已经是更高性价比的替代
- ❌ **不要做路由级 code-splitting / React.lazy** — 总共 340KB JS 从本地磁盘加载且开了 `codeCache`，收益为负
- ❌ **不要引入 react-window / react-virtualized** — 最长的会话列表已在 SQL 层分页到每页 ≤100
- ❌ **不要给主进程上 bundler** — 会模糊信任链模块的边界，那是本项目的核心可审计资产
- ❌ **不要为了让测试在非 Windows 通过而改断言** — 用平台门控，否则会弱化对 Windows 行为的验证
- ❌ **不要绕过 npm 官方源的 SHA-512 对账** — 那是防镜像投毒的核心设计
- ❌ **不要动 Codex 桌面端的镜像实现** — 那是全项目网络处理做得最对的一块
- ❌ **不要"消除" `preload.ts` 里重复的通道表** — 那是 sandbox 约束下的有意重复，且被 `satisfies` 类型钉死，拼错会当场编译报错
- ❌ **不要把 `config-files.ts` 的六个 switch 重构成策略类层级** — 无 `default` 分支正是新增 provider 时的穷尽性保障
- ❌ **不要给 API Key 加 DPAPI / keytar 加密存储** — 本程序的全部职责就是把 Key 写进 CLI 的明文配置文件，再加密一份攻击面一点没变。⚠️ 这条针对的是 **relay API Key**；登录 session token 用 `safeStorage` 加密（`account-session-store.ts`）是**正确做法、已实装**，两者别混
- ❌ **不要提交 `\tmp\xingmang-managed-cli-*` 目录**

---

## 9. 相关文档

**如果你是 AI agent，按这个顺序读：**

1. **`docs/ROADMAP.md`** — 总体规划：产品定位、技术选型、优先级。**先理解背景**
2. **本文件（CLAUDE.md）** — 代码架构、不变量、改动陷阱。**保命的**
3. **`docs/AGENT-RUNBOOK.md`** — **怎么领任务、怎么干活、怎么提 PR。要动手就看这个**
4. `docs/COLLABORATION.md` — 协作规范细则（分支/PR 格式、冲突规避、验证门槛）

**其他：**

- `docs/IMPROVEMENT-PLAN.md` — 已确认问题的完整清单与分批修复计划
- `docs/RECON-new-api.md` / `docs/ACCOUNT-PLAN.md` — new-api 端点实测事实（rc.24）与账号体系决策记录。**改账号代码前必读**
- `docs/RECON-canvas.md` / `docs/CANVAS-INTEGRATION-PLAN.md` — 画布侦察与四阶段集成记录（已完成）。**改画布相关前必读**
- `docs/RELEASING.md` — 发布流程
- `docs/MACOS_DEVELOPMENT.md` / `docs/MACOS_FREE_DISTRIBUTION.md` — macOS 开发与免费自签分发
- `HANDOFF.md` — 会话间交接快照，**时效性文档**：与本文件或代码冲突时以代码为准
- `README.md` — 产品说明与数据边界

**任务索引在 GitHub Issue [#27](https://github.com/xufei5620/xingmang-ai-manager/issues/27)。**
