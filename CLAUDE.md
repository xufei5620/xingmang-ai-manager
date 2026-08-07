# CLAUDE.md

给 AI 编码 agent 的项目上下文。**动手改代码前先读完本文件。**

---

## 1. 这是什么项目

**星芒AI管理工具** — 面向 Windows 的 Electron 桌面客户端（Mac 适配进行中），是 AI API 中转服务商（`api.solov.cc`）发给付费客户的配套软件。

**它解决的问题**：普通用户想用 Claude Code、Codex CLI 这类 AI 编程工具，得先装 Node.js、再用 npm 装 CLI、再手工编辑配置文件填 API Key 和 base URL——门槛太高。本工具把整条链路包成图形界面。

**商业定位**：不是通用工具。四个 CLI 的 base URL 全部硬编码指向 `api.solov.cc`，onboarding 填的是"安装授权码"。**它的价值 = 降低客户接入门槛、减少客服成本。这条链路断了，用户就退款。**

**管理对象**：Claude Code（`@anthropic-ai/claude-code`）、Codex CLI（`@openai/codex`）、Gemini CLI（`@google/gemini-cli`）、Grok CLI（`@xai-official/grok`），外加 Codex 桌面端。

---

## 2. 技术栈与规模

Electron 43 + React 18 + TypeScript 5.7 + Vite 8 + vitest。**没有后端服务**，唯一线上资产是静态更新目录。

**Windows 与 macOS 双平台**（macOS 支持已于 `ca592df` 合并）。

| | 源码 | 测试 |
|---|---|---|
| `electron/`（主进程，全部特权操作） | 51 个模块 | 49 个 |
| `src/`（渲染进程，纯 UI） | 29 个文件 | 13 个 |

约 5 万行，**740 个测试用例**（62 个测试文件）。IPC：**70 个 invoke 通道**。

**常用命令**（耗时都很短，应作为每次改动的硬门槛）：

```bash
npm run typecheck   # 跑两套 tsconfig（渲染 + 主进程）
npm test            # ~15s
npm run compile     # 清理 + vite build + tsc + 压缩
npm run dev         # 开发模式
npm run build:mac:dir   # macOS 本机 ad-hoc 签名解包应用
```

> ℹ️ **测试基线**：Windows 上应全绿。**Linux 上当前有 1 个失败**（`macos-platform.test.ts` 的 darwin 专有用例未对 linux 门控），macOS 上应全绿。
> 改动前先在干净的 `main` 上跑一遍记下失败数，改动后对比，**不要引入新失败**。

### macOS 相关模块（新增）

- `electron/macos-platform.ts` — macOS 终端启动器与平台能力
- `electron/macos-codex.ts` / `macos-codex-app.ts` — Codex CLI 与桌面端的 macOS 实现
- `electron/macos-grok.ts` — Grok 的 macOS 安装
- `electron/platform-capabilities.ts` — 跨平台能力探测的统一抽象
- `src/platform-presentation.ts` — 渲染层的平台差异表达

**改跨平台代码前先读 `platform-capabilities.ts`**，它是判断"当前平台支持什么"的单一入口。

---

## 3. 模块地图

### `electron/` 主进程

**进程入口与 IPC 边界**
- `main.ts` (435) — 生命周期、`BrowserWindow` 安全策略（`sandbox:true` / `contextIsolation:true`）、`xingmang://` 协议注册、外链白名单、装配服务
- `ipc-contract.ts` (427) — **唯一的跨进程类型真相源**。`as const satisfies` 强制通道表与接口对齐
- `preload.ts` (195) — sandbox 桥接层。因 `sandbox:true` 无法 require 本地模块，**手工复制了一份通道表**
- `ipc.ts` (920) — 69 个处理器注册与参数校验

**命令执行与安全边界**（这里是本项目真正的复杂度所在）
- `command-runner.ts` (1020) — **全仓最关键模块**。`runCommand` 硬编码 `shell:false`；`trustedCommandEnvironment` 剥离 60+ 可注入环境变量并重建机器级 PATH；`findExecutable` 不调用 `where`/`which`/shell
- `security.ts` (171) — URL 策略。外链白名单要求 `href` **全等**匹配
- `windows-elevation.ts` (398) — 提权模式判定、可信命令断言、PowerShell 启动计划
- `windows-machine-paths.ts` (499) — 从注册表推导真实系统根 + ACL 校验
- `trusted-temp.ts` (498) — 受 ACL 保护的临时目录
- `managed-path-trust.ts` / `system-shell.ts`

**CLI 安装与运行时**
- `system-service.ts` (3300) — **最大模块**。前 1426 行是纯函数库（可直接单测），`createSystemService` 从 1427 行起是闭包工厂
- `tool-installation.ts` (449) / `node-runtime.ts` (1018) / `grok-installer.ts` (661) / `grok-update.ts` (161)
- `managed-cli.ts` / `managed-cli-paths.ts` / `native-cli-uninstall.ts` / `trusted-native-cli.ts`

**配置与数据**
- `config-files.ts` (757) — 四个 CLI 的配置读写，**两阶段提交 + .bak 备份 + 失败回滚**
- `app-settings.ts` (196) / `backups.ts` (596)
- `codex-sessions.ts` (1374) — Codex 会话权威源是 `~/.codex/state_5.sqlite` 的 `threads` 表；未知 schema 自动降级只读
- `provider-sessions.ts` (1199) — 四工具统一会话视图
- `codex-desktop.ts` (437)

**扩展生态**
- `provider-extensions.ts` (1543) — 四工具统一的 MCP/Skill/Plugin 抽象
- `codex-extensions.ts` (1207) — Codex 专用。DTO 只暴露 env **变量名**不暴露值

**更新、诊断、工具库**
- `updater.ts` (386) / `update-signature.ts` (208)
- `diagnostics.ts` (795) / `runtime-log.ts` (342) / `models.ts`
- `catalog.ts`（provider 单一定义源）/ `versions.ts` / `installation-queue.ts`
- `safe-local-data.ts` / `bounded-file.ts` / `bounded-directory.ts` / `bounded-response.ts`

### `src/` 渲染进程

- `main.tsx` — 挂载 React + 全局错误上报
- `App.tsx` (2855) — **全部全局状态**。App() 本体 936 行，38 个 `useState`，15 个 `useEffect`，页面切换是一条 11 分支三元链（1069-1204）。内嵌四个大组件：`CodexOnboarding` / `Dashboard` / `ConfigDialog` / `CodexDesktopCard`
- `styles.css` (6027) — **另一个巨型枢纽文件**
- `components/` — `AppFrame` / `Sidebar` / `Toast` / `Dialog` / `ProviderTabs`
- `pages/` — 11 个页面，最大的 `PluginsPage`(696) `MaintenancePage`(686) `McpPage`(593)
- **纯逻辑层（测试都打在这里）** — `scan-coordinator.ts` / `latest-request.ts` / `provider-extension-coordinator.ts` / `onboarding-flow.ts` / `onboarding-runtime.ts` / `startup-settings.ts` / `error-message.ts` / `local-path-display.ts`
- `types.ts` — `export *` 转发 ipc-contract 的类型

---

## 4. 关键不变量（破坏后不报错，只会静默变成漏洞）

> 这个代码库的复杂度不在业务，在 Windows 提权 / 可信路径 / 原子写入这套不变量上。几乎每一行防御代码都对应一个具体攻击。

**I1. 执行外部命令必须 `execFile`/`spawn` + argv 数组，永不 `shell:true`、永不拼字符串。**
输入包含用户选的工作目录、Skill 路径、MCP command/args——任何一处进 shell 就是命令注入。全仓 0 处 `shell:true` / `execSync`。
*违反后果*：用户建一个名为 `a&calc.exe` 的目录即可执行任意命令；提权下是管理员级 RCE。

**I2. 跨提权边界的执行必须用 `trustedCommandEnvironment()` + `trustedOnly:true`。**
`NODE_OPTIONS`、`PSModulePath`、`DOTNET_STARTUP_HOOKS`、`BROWSER`、`GIT_ASKPASS`、`LD_PRELOAD` 等 60+ 变量能让子进程在启动瞬间加载攻击者代码（清单见 `command-runner.ts:208-281`）。
*注*：交互式终端启动当前仍用 `interactiveTerminalEnvironment`，这是**已知待修项**，不要在此基础上扩大范围。

**I3. API Key 明文永不随普通查询跨 IPC。**
`toNativeConfigSummary` 解构剥离 `apiKey`；明文仅走 `config:reveal-api-key`。
*违反后果*：用户一次"导出反馈"就把付费 Key 发到客服群。

**I4. 所有 `ipcMain.handle` 必须经 `registerTrustedHandler`。**
它统一做 sender URL 校验、结构化日志、dispose 注册。

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
更新源、npm registry、镜像站都是外部可控的。
*违反后果*：镜像站一次重定向就能把安装源换成任意主机。

**I11. 安装/卸载/启动类操作必须过 `InstallationQueue`。**
这些操作会原子替换机器级目录，并发会互相看到半完成状态。同 key 复用同一 Promise，双击天然幂等。

**I12. 渲染进程导航与外链必须过白名单，外链要 `href` 全等匹配。**
刻意做全等而非前缀匹配，因为前缀匹配会被 `https://api.solov.cc.evil.com` 绕过。

**I13. 日志、诊断、导出必须脱敏。**
三层：`redactCommandText`（Bearer/sk-/api_key=）、`redactHomeDirectory`（路径→`%USERPROFILE%`）、`sanitizeValue`（按 key 名）。

**I14. Windows 系统可执行文件必须由固定解析器给出绝对路径，不查 PATH、不读 COMSPEC。**
*违反后果*：当前目录放一个 `powershell.exe` 就被提权执行。

---

## 5. 改动陷阱清单

**T1. 加/删/挪 IPC 处理器 → 注册顺序必须与 `ipcInvokeChannels` 键顺序完全一致。**
`ipc.test.ts:222` 的 `toEqual` **对顺序敏感**。⚠️ **两个 agent 并行加通道，即使 git 文本合并成功，CI 也会红。** 加通道属于必须串行的任务。
（`preload.ts` 的副本顺序**不需要**一致，它只做键查找。）

**T2. 给 `ProviderId` 加第 5 个 CLI → 共约 17 个文件 35 个改动点，其中 5 处编译器完全沉默。**

*编译器会强制你改的（约 12 处，这部分设计是对的）*：`catalog.ts:1/14/49` 三处 → `config-files.ts` 六个 `switch`（**无 `default` 分支 + 非 void 返回类型 = 穷尽性保障**，漏了是编译错）→ 各类 `Record<ProviderId, X>` 映射表（`App.tsx:112`、`ProviderTabs.tsx:5`、`PluginsPage.tsx:82`）。

⚠️ *编译器抓不到的 5 处*：
- `src/App.tsx:161` — `dashboardProviderIds` 是独立字面量数组。与同文件 790 行「已安装 N 项」、857 行「一键安装全部」用的 catalog 派生数组不同步时，概览页会出现「已安装 3/5」但只画 4 张卡片
- `src/pages/MaintenancePage.tsx:26` — **另外定义了 `MaintenanceProviderId` 联合类型**，不从 `ProviderId` 派生
- `src/pages/BackupsPage.tsx:17` — 同上，`BackupProviderId`
  > 这两处最危险：`Record<ProviderId,X>` 赋给 `Record<MaintenanceProviderId,X>` 在 TS 里合法（多余键不触发 excess property check）。**结果是安装维护页和配置备份页完全看不到新 CLI，且零编译错误、零测试失败。**
- `src/pages/McpPage.tsx:377`、`src/pages/SkillsPage.tsx:279` — 直接写字面量数组
- `src/components/ProviderTabs.tsx:3` — `as const satisfies readonly ProviderId[]` 只校验「成员合法」，**不校验「覆盖完整」**

*根因*：规范顺序（catalog 是 claude/codex/grok/gemini）与展示顺序（UI 全是 codex/claude/gemini/grok）不一致，所以每个页面各自硬编码了一遍展示顺序。收口方案见 `docs/IMPROVEMENT-PLAN.md`。

**T3. 改 `system-service.ts` → 先确认改的是 3300 行里的哪一半。**
前 1426 行是纯函数（全部 export、测试直接调用）；`createSystemService` 之后是闭包（内部函数不导出）。**新逻辑优先写成顶层纯函数**再在闭包里调用，否则无法单测。这是最容易撞车的文件。

**T4. 动 `trustedCommandEnvironment` → 只能加禁止项，不能加放行项。**
三张表是白名单式收紧，每条对应一个具体攻击。放行任何变量前，先在测试里写出"该变量为什么安全"。

**T5. 修跨平台问题 → 功能已补齐，但安全边界还没有。**

macOS 的**功能**支持已经合并（`macos-platform.ts` / `macos-codex.ts` / `macos-grok.ts` / `platform-capabilities.ts`），Grok、Codex 桌面端等在 mac 上都能跑了。

⚠️ **但安全检查在 macOS 上仍然全部退化为 no-op**：
- `command-runner.ts:192` `isUserWritablePath` —— 非 win32 **恒返回 false**（= 认为没有路径是用户可写的）
- `isTrustedHighIntegrityExecutable` —— 非 win32 **恒返回 true**（= 认为所有可执行文件都可信）
- `trustedCommandEnvironment`（`:336`）—— 非 win32 走极简分支，不重建机器级 PATH

**所以 macOS 上「可信路径」这套防护等于不存在。** 这是已知欠账（Issue #16），改跨平台代码时不要在此基础上扩大范围。

**改跨平台代码前先读 `electron/platform-capabilities.ts`**，它是判断"当前平台支持什么"的单一入口。

**T6. 渲染进程加异步数据加载 → 必须用竞态守卫。**
三个现成工具：`scan-coordinator.ts`（扫描）、`latest-request.ts`（按 key 的页面数据）、`provider-extension-coordinator.ts`（切 provider）。直接 `await` 后 `setState` 会让慢响应覆盖新数据，切 tab 时 100% 复现。

**T7. 给 `src/` 加组件测试 → 当前没有 DOM 环境。**
仓库**没有 `vitest.config.ts`**，环境是默认的 `node`。9 个渲染测试全部只测纯函数，没有一处 render。加 jsdom 是需要先与其他 agent 对齐的基础设施改动，**不要顺手做**。

**T8. 改 `electron/*.test.ts` 的类型 → 它们不在任何 typecheck 范围内。**
`tsconfig.electron.json` exclude 了测试文件，根 tsconfig 只 include `src`。所以 electron 测试的类型错误只在运行时炸。（反之 `src/**/*.test.ts` **在**范围内。）
`electron/onboarding-runtime.test.ts` 是孤儿测试——它测的是 `src/onboarding-runtime.ts`。

**T9. 给 `electron/` 加新模块 → 可能被 typecheck 两遍，也可能一遍都不被检查。**
被 `ipc-contract.ts` 通过 `import type` 引用的模块会同时进入渲染 tsconfig 的程序图。改类型定义时两条命令都要跑（`npm run typecheck` 已串好）。

**T10. 改 `providerConfigPaths` 或配置格式 → 同时影响备份、恢复、诊断、启动前校验。**
消费者：`backups.ts`、`config-files.ts:249`、`diagnostics.ts:14`、`system-service.ts:3007`、`main.ts:342`。必须考虑老版本已产生的 `.bak` 与已有备份的兼容。

**T11. 看到根目录出现 `\tmp\xingmang-managed-cli-*` 目录 → 那是已知 bug 的产物，直接删除，不要提交。**
`managed-cli.test.ts` 在非 Windows 平台每跑一次就泄漏若干个（见待办批次 0）。

---

## 6. 代码约定

> **这些是从现有 2.9 万行代码统计出来的事实，不是新规定。写出来的代码要和现有代码无缝。**

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
> Mac/Linux 上测试当前有已知失败，**请对比改动前后的失败数是否一致**，不要引入新失败。

**提交**
见 `docs/COLLABORATION.md` 的分支命名与 PR 规范。

---

## 8. 不要做的事

- ❌ **不要引入 Prettier / 大改格式** — 现有风格一致性已经很高，全仓重排会摧毁 git blame
- ❌ **不要引入 Redux / Zustand / Jotai / MobX** — `App.tsx` 的 44 个 useState 里真正跨组件共享的只有 5 个（`snapshot/config/settings/theme/toast`），props 深度 1-2 层；其余都是 `configOpen`、`logOpen` 这类局部 UI 开关。**正确解是拆组件，不是换状态方案。** 拆完仍嫌传得烦，最多加一个 Context
- ❌ **不要用 zod / valibot / ajv 替换 `ipc.ts` 的 15 个手写 parse 函数** — 它们产出的是能直接上屏的中文错误文案
- ❌ **不要开 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`** — 实测前者会新增 97 条错误，抽查全是已被前置校验保护的下标访问，**零个真 bug**。现在的 `strict: true` 已经足够
- ❌ **不要顺手加 jsdom / 组件测试设施** — 那是需要跨 agent 对齐的基础设施改动。`e2e/` 的 1186 行 smoke 套件已经是更高性价比的替代
- ❌ **不要做路由级 code-splitting / React.lazy** — 总共 340KB JS 从本地磁盘加载且开了 `codeCache`，收益为负
- ❌ **不要引入 react-window / react-virtualized** — 最长的会话列表已在 SQL 层分页到每页 ≤100
- ❌ **不要给主进程上 bundler** — 会模糊信任链模块的边界，那是本项目的核心可审计资产
- ❌ **不要为了让测试在非 Windows 通过而改断言** — 用平台门控，否则会弱化对 Windows 行为的验证
- ❌ **不要绕过 npm 官方源的 SHA-512 对账** — 那是防镜像投毒的核心设计
- ❌ **不要动 Codex 桌面端的镜像实现** — 那是全项目网络处理做得最对的一块
- ❌ **不要"消除" `preload.ts` 里重复的通道表** — 那是 sandbox 约束下的有意重复，且被 `satisfies` 类型钉死，拼错会当场编译报错
- ❌ **不要把 `config-files.ts` 的六个 switch 重构成策略类层级** — 无 `default` 分支正是新增 provider 时的穷尽性保障
- ❌ **不要给 API Key 加 DPAPI / keytar 加密存储** — 本程序的全部职责就是把 Key 写进 CLI 的明文配置文件，再加密一份攻击面一点没变
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
- `docs/RELEASING.md` — 发布流程
- `README.md` — 产品说明与数据边界

**任务索引在 GitHub Issue [#27](https://github.com/peaker520/xingmang-ai-manager/issues/27)。**
