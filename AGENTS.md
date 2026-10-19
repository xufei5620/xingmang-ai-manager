# AGENTS.md

给 AI 编码 agent 的项目上下文（Claude Code 经根目录 `CLAUDE.md` 的 `@AGENTS.md` 导入读到同一份）。**动手改代码前先读完本文件。**

<!--
维护约定（这段是 HTML 块注释，注入上下文前会被剥掉，不花 token）：
- 本文件是每个会话的固定前缀，改一个字就让所有人的提示缓存前缀失效，所以只放几乎不变的东西。
- 不要往这里写计数（多少个模块 / 用例 / 通道）和行号。计数会过期，行号会漂移。
  引用代码位置一律用符号名（函数名、常量名），grep 一次就到，且永不过期。
- 会随阶段变化的内容放第 10 节，或搬进 .claude/rules/（按路径触发）与 docs/（按需读）。
- 目标：控制在 280 行上下。官方建议 200 行，但第 4 节 I1-I15 与第 5 节 T1-T14
  占了一半篇幅，它们是这个仓库最不该丢的资产，不压缩。要加新内容，先想能不能放 docs/ 或 rules/。
-->

---

## 1. 这是什么项目

**星芒AI管理工具** — 面向 Windows 与 macOS 的 Electron 桌面客户端（Linux 在做），是 AI API 中转服务商星芒发给付费客户的配套软件。

**它解决的问题**：普通用户想用 Claude Code、Codex CLI 这类 AI 编程工具，得先装 Node.js、再用 npm 装 CLI、再手工编辑配置文件填 API Key 和 base URL——门槛太高。本工具把整条链路包成图形界面。

**商业定位**：不是通用工具。CLI 的 base URL 不让用户填，由登录的账号站点决定（`relay-sites.ts`）：星芒账号是 `xm.solov.cc`（new-api，2026-08-10 起中转与账号后端同一实例），历史账号是 `api.solov.cc`（sub2api，**仍在服役，没有退役**）。每个站点两条线路：线路1 是 CF 入口，线路2 是洛杉矶直连（`xm-direct` / `api-direct`），设置值和日志名仍叫 `primary` / `direct`；选「自动」时星芒账号先走线路2，历史账号先走线路1。主流程是登录星芒账号，登录后自动签发密钥写进工具（也能手动填密钥）。**它的价值 = 降低客户接入门槛、减少客服成本。这条链路断了，用户就退款。**

**管理对象**：Claude Code（`@anthropic-ai/claude-code`）、Codex CLI（`@openai/codex`）、Grok CLI（`@xai-official/grok`），外加 Codex 桌面端；另有三个外部桌面客户端 Claude Desktop、WorkBuddy、OpenCode（`external-client-*`，只管安装、配置和打开，不是 `ProviderId`）。Gemini CLI（`@google/gemini-cli`）2026-10-14 下线：界面不显示、不再装、不再改它的配置，老客户电脑上的不卸不删；代码里它仍是 `ProviderId`，挂在 `catalog.ts` 的退役名单 `retiredProviderIds` 上，「替每个工具做点什么」的地方一律走 `activeProviderIds`。

**内置的几块能力**：
- **星芒账号**（2026-08）：对接 `xm.solov.cc`（第三方开源 QuantumNous/new-api 的生产实例）——注册/登录/找回密码/余额/用量/Key 管理/充值，登录后自动签发 CLI Key 并写进 CLI 配置。历史账号站 `api.solov.cc` 走 sub2api（`sub2api-*`），两个账号域由 `realm-account*` 隔开。
- **无限画布 + AI 工作区**（2026-08）：本仓自研的节点式工作流编辑器（`canvas-v2/`，@xyflow/react 底座），在独立隔离窗口运行；AI 聊天与图像生成走主进程，与 CLI 共用同一账号额度。
- **线路自动切换与游戏加速**：客户端在线路1、线路2 之间自己切（`relay-route-controller.ts` / `relay-line-fetch.ts`）；游戏加速是本机 Mihomo 系统代理（`acceleration-*`，见 `docs/GLOBAL-ACCELERATION.md`）。

**技术栈**：Electron 43 + React 19（旧回滚界面隔离保留 React 18）+ TypeScript 5.7 + Vite 8 + vitest。**桌面端自身没有后端**；线上资产 = 静态更新目录 + 两个账号后端（`xm.solov.cc` 是 new-api 生产实例，版本会跟上游漂移；`api.solov.cc` 是 sub2api），new-api 端点事实见 `docs/RECON-new-api.md`。⚠️ **自动化测试绝不对生产实例发真实请求，一律 mock**。Windows 与 macOS 双平台；Linux（只出 deb）已能打包并在 CI 里真装真开，第一版功能已做完（不带加速），发布开关还关着，见 `docs/LINUX.md`。

---

## 2. 代码地图：改代码前必须知道的三条

完整模块地图（主进程按子系统、`electron/platform/`、renderer-v2、macOS / Linux 模块）在 `docs/MODULE-MAP.md`，找文件时再读。常驻要点只有三条：

- **跨进程通道有三套，各自一组「契约 + preload + 注册」**：主窗口业务通道 `ipc-contract.ts` + `preload.ts` + `ipc.ts`；主窗口系统设置与通知 `platform/contract.ts` + `platform/preload.ts` + `platform/ipc.ts`（`xingmang-platform:*`）；画布窗口 `canvas-contract.ts` + `canvas-preload.ts` + `canvas-window.ts`（`canvas-host:*`）。三个 preload 里的通道表都是 sandbox 约束下的有意重复（见 I7、T1）。
- **本项目的复杂度不在业务，在提权、可信路径与原子写入这套边界上**——`command-runner.ts` / `windows-elevation.ts` / `windows-machine-paths.ts` / `trusted-temp.ts` / `config-files.ts` / `config-files-context.ts`（见第 4 节）。
- **画布是全项目唯一运行第三方前端代码且有宿主桥的地方**（源码 `canvas-v2/`，产物 `dist-canvas/` 不入 git），全部 AI 调用都在主进程完成（见 I15、T13）。另一个加载外部网页的是充值的支付窗口 `payment-window.ts`，它不挂 preload（见 I15）。

**改跨平台代码前先读 `electron/platform-capabilities.ts`**，它是判断"当前平台支持什么"的单一入口。

**渲染层是两棵树，别改错**：`src/renderer-v2/` 是当前界面；`src/` 下除它以外的部分（含 `src/components/`、`src/pages/`、`src/App.tsx` 与 `src/*.ts`）加上 `tooling/legacy-renderer/` 是 **legacy 回滚版，已于 2026-09-19 冻结，只接受安全修复**（见 T14）。

---

## 3. 命令与硬门槛

```bash
npm run typecheck   # 四连检：根 tsconfig（src）+ 主进程 tsconfig + electron 测试 tsconfig + renderer-v2 tsconfig（不含 canvas-v2，它在 canvas:prepare 第一步自查）
npm test            # test:vitest + test:scripts + test:browser；test:vitest 的 `electron src` 按路径子串过滤，实际跑 electron/、src/（含 renderer-v2）和 canvas-v2/src，关文件级并行 + 30s 超时
npm run test:scripts    # 单跑 scripts/*.test.cjs（构建、CI、发布脚本）
npm run test:browser    # 单跑 e2e 里随 npm test 走的那几个浏览器套件（串行起 Chromium）
npm run test:v2     # renderer-v2 / platform 单测和浏览器业务回归；Windows required CI 拆开跑：单测那半已含在 test:vitest 里，浏览器那半分片跑
npm run compile     # 默认构建 renderer-v2 与对应 canvas token，再清理 + vite build + tsc + 压缩
npm run compile:legacy  # 显式构建 React 18 旧回滚界面（已冻结，只为回滚保留）
npm run dev         # 默认启动 renderer-v2；内部先构建 canvas-v2 + 全量编译一次主进程（消 electron 抢跑竞态）
npm run dev:legacy  # 显式启动 React 18 旧回滚界面（已冻结，只为回滚保留）
npm start           # 直接跑已编译产物（需先 compile），免 dev server
npm run build:mac:dir   # macOS 本机 ad-hoc 签名解包应用
npm run build:linux     # Linux 本地测试 deb（x64 + arm64，更新器关着；只能在 Linux 上跑）
```

**提交前必须两条都过**：`npm run typecheck` 和 `npm test`。动了 renderer-v2 的再加 `npm run check:v2` 和 `npm run test:v2`。

**测试基线**：三平台都应为 **0 失败**（#40）。Windows 上需要 `SeCreateSymbolicLinkPrivilege` 的 11 条用例，在没有该特权的机器（非管理员且未开开发人员模式）上会**自动跳过**——跳过不算失败，CI 的 runner 有该特权、照常执行。红了就是回归，不要再按「环境相关」放过。各平台明细与复核命令见 `docs/TEST-BASELINE.md`。

**云端容器跑浏览器用例**：容器预装的 Chromium 往往跟 `@playwright/test` 要的版本对不上，直接跑 `npm test` / `npm run test:v2`，浏览器套件会报 `Executable doesn't exist`。这是环境问题不是回归，**但也不算跑过**：设 `XINGMANG_E2E_CHROMIUM` 指向容器里那份 Chromium 重跑，门槛不变，同样要 0 失败。Claude Code 云端容器里的写法：

```bash
XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium npm test
XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium npm run test:v2
```

别的容器路径可能不同，到 `$PLAYWRIGHT_BROWSERS_PATH` 下找 `chromium` 那份。`npm test` 和 `test:v2` 里起浏览器的套件都认这个变量（`e2e/harness.mjs` 的 `launchFixtureBrowser`、各个 `browser-check.mjs` / `app-check.mjs`，以及 vitest 里的 `electron/codex-desktop-cdp.browser.test.ts`）；CI 不设它，用 Playwright 自己装的那份。

---

## 4. 关键不变量（破坏后不报错，只会静默变成漏洞）

> 这个代码库的复杂度不在业务，在 Windows 提权 / 可信路径 / 原子写入这套不变量上。几乎每一行防御代码都对应一个具体攻击。

**I1. 执行外部命令必须 `execFile`/`spawn` + argv 数组，永不 `shell:true`、永不拼字符串。**
输入包含用户选的工作目录、Skill 路径、MCP command/args——任何一处进 shell 就是命令注入。全仓 0 处 `shell:true` / `execSync`。
*违反后果*：用户建一个名为 `a&calc.exe` 的目录即可执行任意命令；提权下是管理员级 RCE。

**I2. 跨提权边界的执行必须用 `trustedCommandEnvironment()` + `trustedOnly:true`。**
`NODE_OPTIONS`、`PSModulePath`、`DOTNET_STARTUP_HOOKS`、`BROWSER`、`GIT_ASKPASS`、`LD_PRELOAD` 等 60+ 变量能让子进程在启动瞬间加载攻击者代码（清单见 `command-runner.ts` 的 `unsafeKeys` / `unsafePrefixes` 两张表）。
*注*：交互式终端启动走 `interactiveTerminalEnvironment`，它的净化基底**由调用方传入**——`trusted-only` 传 `trustedCommandEnvironment`，same-user 传 `commandEnvironment`（缺省值，未跨越完整性边界，无需收窄 PATH）。颜色层叠在基底之上，**不要把整个函数换成 `trustedCommandEnvironment`**，那会连 `TERM`/`FORCE_COLOR` 一起剥掉，终端变无色。

**I3. API Key 明文永不随普通查询跨 IPC。**
`toNativeConfigSummary` 解构剥离 `apiKey`；明文仅走 `config:reveal-api-key`。**账号凭据同理**：`accessToken` / refresh cookie 在 IPC 契约里 0 处返回给渲染层（渲染层只拿登录态快照），加密落盘走 `account-session-store.ts`。
*违反后果*：用户一次"导出反馈"就把付费 Key 发到客服群。

*已登记的例外*：明文跨 IPC 只走这几条专用通道，全都在 `ipc-channel-policy.ts` 里标了成功不记日志（同 I13）：`config:reveal-api-key`；`account:reveal-key`（复制账号密钥时取一次明文）；`account:reset-password` 的返回值（服务端生成的新密码）与 `account:copy-reset-password` 的入参；「记住密码」的 `account:get-remembered-login` / `account:set-remembered-login`——这一对是**有意的产品取舍**（勾了就要看见填好的登录框，渲染层没别的途径拿到它），落盘由 `account-credential-store.ts` 以 `safeStorage` 加密。**只能是专用通道**，明文永不许搭普通查询（登录态快照、账号资料、诊断导出）的便车；新增一条要在这里登记。

**I4. 所有 `ipcMain.handle` 必须经 `registerTrustedHandler`。**
它统一做 sender URL 校验、结构化日志、dispose 注册。**两处例外，都只服务一个窗口、且校验比它更窄**：`canvas-host:*` 由 `canvas-window.ts` 的 `registerCanvasHandler` 注册（`assertTrustedCanvasSender` 只放行画布窗口自身的 sender，主窗口调会被拒）；`xingmang-platform:*` 由 `platform/ipc.ts` 的 `registerPlatformHandlers` 注册（`assertPlatformOwner` 只放行主窗口主框架）。两者都要自己补齐日志这一半：platform 侧走 `registerPlatformHandlers` 的 `log` 回调，由 `platform/runtime-log-bridge.ts` 接到 `runtimeLog`（handler 比 `RuntimeLogStore` 先注册，中间这段缓冲后补发）。新通道不许效仿，除非同样只服务一个隔离窗口。

**I5. IPC 入参一律视为敌意输入，必须显式校验。**
渲染进程虽是自家代码，但 XSS/依赖投毒后就是攻击面。`parseSessionId` 的 UUID 正则同时防路径穿越。
*违反后果*：`skills:uninstall` 收到 `../../../` 就删用户任意文件。

**I6. `ipc-contract.ts` 只能 `import type`，值导出只能来自无 Node 依赖的模块。**
`src/types.ts` 是 `export *`（值级别），Vite 会把它真的打进渲染 bundle。目前的值导出来自两个零依赖模块：`catalog.ts`（`providerIds`、`managedCliKeyProfiles`）和 `relay-sites.ts`（站点与线路表及几个纯函数）。
renderer-v2 还直接从一批 `electron/*` 模块导入运行时值。真正守这条边界的是门禁 `scripts/verify-renderer-boundary.test.cjs`：渲染层能值导入的主进程模块只能是它 `valueImportable` 名单上的，名单上的每个模块都不许依赖 Node；只被 `import type` 的放 `typeImportableOnly`。名单上的每个模块第一行都是同一句 `// @renderer-importable: …` 标记，门禁核对标记和名单完全一致、名单上模块值导入的主进程模块也都在名单上，所以光看文件头就知道它会进渲染层。要让渲染层值导入一个新的主进程模块，就是改这张名单、在旁边写明它为什么不碰 Node，再把门禁里那整行标记照抄到模块第一行。
*违反后果*：加一个 `export { xxx } from './system-service'` → Vite 尝试打包 `node:fs` → 构建失败，或更糟：主进程逻辑泄进渲染进程。

**I7. 三个 preload（`preload.ts`、`platform/preload.ts`、`canvas-preload.ts`）都是 sandbox 脚本，不能 import 本地运行时模块。**
这是每套通道表都被复制两份的**唯一原因**（契约里一份、preload 里一份字面量，由各自的测试钉住）。
*违反后果*：preload 加载失败 → `window.xingmang` undefined → 白屏，且打包版禁用了 devtools 难以排查。

**I8. 本地文件读写必须走 `safe-local-data` / `bounded-*` 系列。**
目标路径都在用户可写区，攻击者可放 symlink/junction/硬链接重定向写操作。检查点：`assertNoReparseComponents`、`nlink !== 1` 拒绝、`readBoundedUtf8File*`。

*已登记的例外*：「C 盘搬家」留下的联接（yoyo 2026-09-23 同意）。只在执行模式为 `same-user` 时，`relocated-folders.ts` 跟随用户主目录本身、其上级或其内部、指向本机盘符目录的联接，先换成实际位置再照原样严查。`trusted-only` 下一律拒绝——那正是本条要防的「中完整性进程放联接，诱导提权写入」。不要把跟随范围扩到主目录以外，也不要在 `trusted-only` 下放开。

**I9. 配置写入必须两阶段提交 + 备份 + 失败回滚。**
一次保存要同时改多个文件（Codex 是 `config.toml` + `auth.json`），写一半会让 CLI 处于不可用的混合状态。

**I10. 每次网络请求必须有：超时 + 响应体上限 + 重定向策略 + URL 校验。**
更新源、npm registry、镜像站、账号后端都是外部可控的。参考实现：`new-api-client.ts` 的 `performRequest`（四件齐 + 重定向三重拒绝，防带着 Authorization 跳去别的主机）。
*违反后果*：镜像站一次重定向就能把安装源换成任意主机。

**I11. 安装/卸载/启动类操作必须过 `InstallationQueue`。**
这些操作会原子替换机器级目录，并发会互相看到半完成状态。同 key 复用同一 Promise，双击天然幂等。

*已登记的例外*：WorkBuddy、Claude Desktop、OpenCode 三个桌面客户端的「打开」（`external-client-runtime.ts` 的 `launch`，2026-10-16 yoyo 真机报「装着 Claude Code 点 Claude Desktop 全卡住」）。它只读这一家自己的安装位置和签名、交给资源管理器（Mac 上是 `open`），别的工具装到一半碰不到它，开机盘点这三家本来也不排队；所以不进队列，只等同一家正在装的那一次，反过来点安装前已经在打开的，安装等它交出去再动手（两边都只等先来的那一次，不会互相等死）。命令行工具和 Codex 桌面端的「打开」照旧排队，它们读的正是安装会原子替换的目录。不要把这个例外扩到它们身上。

**I12. 渲染进程导航与外链必须过白名单，外链要 `href` 全等匹配。**
刻意做全等而非前缀匹配，因为前缀匹配会被 `https://xm.solov.cc.evil.com` 绕过。画布窗口同样受此约束（`canvas-window.ts` 的 `will-navigate` / `setWindowOpenHandler` 都过白名单）。充值不开外部浏览器：在个人中心下单，付款页由 `payment-window.ts` 的独立窗口打开（见 I15），`/wallet` 不在外链白名单里。

**I13. 日志、诊断、导出必须脱敏。**
三层：`redactCommandText`（Bearer/sk-/api_key=）、`redactHomeDirectory`（路径→`%USERPROFILE%`）、`sanitizeValue`（按 key 名）。账号侧的 refresh cookie **值**也已并入 secrets 名单。

**I14. Windows 系统可执行文件必须由固定解析器给出绝对路径，不查 PATH、不读 COMSPEC。**
*违反后果*：当前目录放一个 `powershell.exe` 就被提权执行。

**I15. 画布是运行第三方前端代码的隔离区，凭据永不下放，能力只减不增。**
画布窗口与主窗口**不共享 rendererRoot**、协议解析必须委托 `resolvePackagedApplicationFile`，且 `xingmang-canvas://` 的 CSP 必须由主进程响应头强制注入。**API Key 只在主进程按账号与分组解析，绝不进入渲染进程**（`chat-credential-coordinator.ts`）——这是 2026-08-12 架构统一（PR #85）的核心：画布发的是"请求"，不是"带着 Key 的请求"。给画布加任何新能力前先回答：**画布被供应链投毒后，这个能力能干什么？** 文件读写必须走原生对话框（用户选路径）+ `bounded-*`/原子写，外链必须过白名单，入参必须过 `canvas-request-parser.ts` 的字段白名单。唯一的文件路径例外是 OS 拖放：路径只能由隔离 preload 的 `webUtils.getPathForFile(File)` 取得，主进程仍须执行绝对路径、reparse、单链接普通文件校验，最终资产 store 再以 open + fstat 复核。宿主桥的通道清单以 `canvas-contract.ts` 的 `canvasHostChannels` 为准，已完成通道级投毒审计。**不得新增第二个由 renderer 提供绝对路径的通道。**
*违反后果*：画布上游一次投毒 = 拿到你给它的一切；今天它既摸不到主进程 IPC，也拿不到 Key。

支付窗口（`payment-window.ts`）是另一个加载外部网页的窗口，付款页来自支付商、不归我们控制。它守的是更严的一条：**不挂 preload**（页面拿不到任何宿主桥）、`sandbox` 加每次随机的 `partition`、权限请求与下载一律拒绝、导航和新窗口只放行白名单 origin。给它加 preload 或放宽导航前，先回答同一个问题：付款页被换掉以后，这个能力能干什么？

---

## 5. 改动陷阱清单

**T1. 加/删 IPC 通道 → 同一套的契约、注册、preload 三处必须一致。**
主窗口业务通道是 `ipc-contract.ts`、`ipc.ts`、`preload.ts`；处理器按域分在 `ipc/handlers/` 下，新通道加进它那个域的文件，`ipc.ts` 只管组装。`ipc.test.ts` 把实际注册的通道和 `ipcInvokeChannels` 排序后比对，漏注册、多注册、重复注册都会红；`preload.test.ts` 钉住 preload 里那份通道表副本。主窗口这套另有第四处 `ipc-channel-policy.ts`：每条通道要表态日志里记什么、要不要等账号，漏了是编译错。这几处都**不看先后顺序**，新通道放在哪一行都行，并行加通道不用排队。
另两套各自成组：`platform/contract.ts` 的 `platformChannels` + `platform/ipc.ts` + `platform/preload.ts`（`platform/ipc.test.ts`、`platform/preload.test.ts` 钉住）；`canvas-contract.ts` 的 `canvasHostChannels` + `canvas-window.ts` + `canvas-preload.ts`（`canvas-window.test.ts` 钉住）。
三个契约文件都列在 `.github/CODEOWNERS` 里：通道数就是渲染进程能碰到的主进程入口（I5），加通道要让 yoyo 看得见。

**T2. 给 `ProviderId` 加第 5 个 CLI → 改动点已收口，编译器/测试会带你走完。**

顺序：`catalog.ts` 的 `providerIds` / `cliCatalog` / `managedCliKeyProfiles` 三处 → `config-files.ts` 与 `config-files-context.ts`（`providerConfigPaths`）里的各个 `switch (provider)`（**无 `default` 分支 + 非 void 返回类型 = 穷尽性保障**，漏了是编译错）→ **`src/provider-registry.ts` 的两张 rank 表**（概览序 claude/codex/gemini/grok 与管理序 codex/claude/gemini/grok，差异只在头两位、是有意为之，各自只定义一次；`Record<ProviderId, number>` 内联字面量，漏键/错键是编译错 TS2741/TS2353，`provider-registry.test.ts` 的覆盖断言在纯测试路径下也会红）→ 各类 `Record<ProviderId, X>` 映射表（`provider-meta.ts` 的 `providers`、`ProviderTabs.tsx` 的 labels、`PluginsPage.tsx` 的来源标签等，全是编译错）。

v2 渲染层同样已收口，且**只有一套展示顺序**（v3.1.1 起，以 `registry/tools.ts` 的 `tools` 数组次序为准，`registry/tools.test.ts` 钉住；上面那两套顺序只服务已冻结的 legacy 树）：`src/renderer-v2/registry/tools.ts` 的 `ToolDef.id` 是 `ActiveProviderId | 'codexDesktop'`，`officialAccountNames` 是无 default 的 `Record<ActiveProviderId, string | null>`（下线的 Gemini 不在里面），npm 包名与配置目录名从 `catalog.ts` 派生，漏键是编译错，`registry/tools.test.ts` 另有覆盖断言（R-S11）。

历史包袱：这里曾有 5 处编译器沉默点（各页面自写 provider 联合类型/字面量数组），已随 #32 全部收口进 registry。**新的展示顺序数组只能定义在 registry 里，不要在页面里写字面量**。遗留手工点：概览页 `Dashboard.tsx` 的「N/5 个工具已安装」分母仍是硬编码。

**T3. 改系统服务 → 先找对文件，再确认改的是纯函数区还是闭包区。**
`createSystemService`（`system-service.ts`）已按 #1070 收成门面，只把各簇接起来；逻辑在各簇自己的 `*-service.ts`（装和更新 CLI、卸载、运行环境、首页检测、打开工具、外部客户端、线路跟随、官方账号、保存配置各一个，清单见 `docs/module-map/main-core-canvas.md` 的 `system-service.ts` 条），各簇共用的那份在 `system-service-context.ts`。每个文件里工厂函数之前是纯函数库（全部 export、测试直接调用），之内是闭包（内部函数不导出）。**新逻辑优先写成顶层纯函数**再在闭包里调用，否则无法单测。一簇要用另一簇的东西，由门面显式传进去（各自的 `*ServiceDependencies`），簇与簇之间不互相 import 值；服务文件只 import `system-service.ts` 的类型，搬走的导出名由 `system-service.ts` 照旧转出。共用的上下文是最容易撞车的地方。

**T4. 动 `trustedCommandEnvironment` → 只能收紧，不能放宽。**
`unsafeKeys` / `unsafePrefixes` 两张禁止表只能加不能减，每条对应一个具体攻击。第三张 `safeGitOverrides` 是放行表，但只放行几个固定值（让 git 不读系统和全局配置、不弹密码提示的那几个），往里加的只能是让子进程更保守的固定值。放行任何变量或值前，先在测试里写出"为什么安全"。

**T5. 修跨平台问题 → macOS 的路径信任问的不是 Windows 那个问题，别照搬。**
Windows 问「低于 Administrator 的主体能不能写这里」，因为那边程序可能持有提权令牌；**macOS 上本程序从不提权**，边界换成「除 root 与当前用户之外的主体能否改动它解析后的目标」。三个函数在 macOS 上的语义、两个最容易误读的点、刻意不做的事与仍然欠着的事，见 `.claude/rules/macos-platform.md`——改到 `electron/macos-*` / `darwin-*` / `platform-capabilities.ts` / `src/platform-presentation.ts` 时会自动加载。
**Linux 问的也是 macOS 那个问题，但组可写目录的判法不同**（按 `/etc/group` 的实际成员，不照搬 macOS 的 gid 0/80），另有拒绝 root 运行、画布沙箱检查，见 `.claude/rules/linux-platform.md`——改到 `electron/linux-*` / `platform-capabilities.ts` 时自动加载。

**T6. 渲染进程加异步数据加载 → 必须用竞态守卫。**
直接 `await` 后 `setState` 会让慢响应覆盖新数据，切 tab 时 100% 复现。renderer-v2 的写法：组件或 hook 里用 `src/renderer-v2/latest-request.ts` 的 `useLatestRequest()`——每发一次请求先 `const current = latest.begin()`，响应回来 `if (!current()) return`；换了账号或参数、不发新请求时 `latest.invalidate()`；卸载时它自己作废。几件事各自记下发起时的那一刻、互不作废，换账号或关窗时才一起作废的，用 `latest.capture()`：它不开始新请求，只记下这一刻。只在一个 effect 里发、随 effect 清理的请求，也可以用 effect 里的 `let current = true` 取消标记；纯逻辑的控制器里用 revision / epoch（`createLatestRequest()` 是同一套的非 hook 版）。v2 里原来手写的 `useRef(0)` 计数器已在 #1070 第 8 步全部换成这个 hook，剩下的几处 `useRef(0)` 是时间戳、编号或计数，不是竞态守卫；**新代码别再手抄计数器**。冻结的 legacy 树里另有 `src/scan-coordinator.ts` / `src/latest-request.ts` / `src/provider-extension-coordinator.ts` 三个工具（`src/latest-request.ts` 跟 v2 这份同名不同物），v2 不 import 它们。

**T7. 给 `src/` 加组件测试 → 用 `renderToStaticMarkup`，不要加 DOM 环境。**
仓库**有 `vitest.config.ts`**（三个 project：`legacy` 覆盖 `src/**` 与 `electron/**`、`renderer-v2`、`canvas`，都挂了 `@vitejs/plugin-react`，legacy 另把 React 别名指向 `tooling/legacy-renderer/`）。但三个 project **都没设 `environment`，跑的仍是默认的 `node`**，依赖里也没有 jsdom / happy-dom / @testing-library。现有 `src/**/*.test.tsx` 绝大多数走 `react-dom/server` 的 `renderToStaticMarkup`，断言渲染出的 HTML（`data-testid`、role、class），**零处 `render()`**。新组件测试照这个写法走。

**T8. electron 测试已纳入 typecheck，但 `tsconfig.electron.json` 的测试 exclude 千万别删。**
`npm run typecheck` 跑四段：根 tsconfig（src）、`tsconfig.electron.json`（主进程**产物**配置，仍 exclude 测试）、`tsconfig.electron.test.json`（纳入全部 electron 测试，自带 `noEmit: true`）、`tsconfig.renderer-v2.json`。**基础配置的 exclude 是 dist-electron 不含测试产物的承重墙**——`npm run compile` 用的就是它，删掉 exclude = 测试代码进发布包。测试配置的 `rootDir: "."` 专为孤儿测试 `electron/onboarding-runtime.test.ts`（测的是 `src/onboarding-runtime.ts`）的跨目录 import 而设。

**T9. 给 `electron/` 加新模块 → 会被 typecheck 查多遍。**
`tsconfig.electron.json` 与 `tsconfig.electron.test.json`（include 覆盖全部 electron 源码）必查；被 `ipc-contract.ts` 通过 `import type` 引用的还会进渲染 tsconfig 的程序图。四段都串在 `npm run typecheck` 里，跑这一条即可。

**T10. 改配置位置或配置格式 → 同时影响读写、备份、恢复、诊断。**
配置根目录由 `codex-home.ts` 的 `providerConfigRoot` 给出，消费者：`config-files-context.ts`（`providerConfigPaths`，`config-files.ts` 照旧导出）、`backups.ts`、`diagnostics.ts`（各类检查拆在 `diagnostics-*.ts`）、`ipc/handlers/config.ts`（打开配置文件夹）、`workspace-guard.ts`，以及渲染层的 `src/renderer-v2/registry/tools.ts`（展示给用户看的配置位置）。目录名这一层已收口到 `catalog.ts` 的 `providerConfigDirectoryNames`，主进程的 `providerConfigRoot` 与渲染层注册表都读它，改目录名只改这一处（R-S11）。必须考虑老版本已产生的 `.bak` 与已有备份的兼容。

**T11. 看到根目录出现 `\tmp\xingmang-managed-cli-*` 目录 → 删掉，不要提交，当回归排查。**
泄漏源 `managed-cli.test.ts` 已改用 `os.tmpdir()` 并在 `afterEach` 清理，正常不会再出现。

**T12. 改账号对接 → 端点事实以 `docs/RECON-new-api.md` 为准，别按 new-api 文档想当然。**
关键事实已从 rc.24 tag 逐行核实（`GET /api/token/` 返回**掩码** key、改密码需 `original_password` 且改后本设备原地续 token（线上 rc.40 起还要先 `POST /api/verify` 换一次性凭证，放进 PUT 的 `X-Security-Proof` 头）、认证要 `Authorization` + `New-Api-User` 双头缺一不可）。渲染层（`features/auth/state.ts`）与主进程各有一份密码长度等字面量。legacy 树不 import electron，所以那边只能重复；renderer-v2 能值导入 `valueImportable` 名单上的主进程模块（I6），要合成一份就把常量放进名单上的零依赖模块。

**T13. 画布相关改动 → 分清源码与产物，且认清"执行发生在主进程"。**
画布**源码**在 `canvas-v2/`；`dist-canvas/` 是 `npm run canvas:prepare` 生成的**构建产物**，不入 git。改画布行为只改 `canvas-v2/`，**不要**改 `dist-canvas/` 里的产物文件。

另一半同样容易踩错：**`canvas-v2/` 里没有任何出网代码**。渲染层的执行器（`canvas-v2/src/engine/executors.ts`）只是把请求交给宿主桥，真正的 HTTP、凭据解析、产物落盘全在主进程（`ai-image-service.ts` / `ai-chat-service.ts` / `chat-credential-coordinator.ts`）。想加一种新的生成能力，**主进程那侧才是要动的地方**；在渲染层直接 `fetch` relay 会绕开 I15 的全部边界，PR #85 已经把那条老路径删掉了，不要重新长出来。

这条边界有自动门禁兜底：`scripts/verify-canvas-renderer-boundary.test.cjs` 扫描画布渲染层源码，出现 `Authorization:` / `Bearer ${` / `.apiKey` / `getAuthToken` 等模式即失败；`verify-canvas-provenance.test.cjs` 守第三方来源清单。两者都在 `npm test` 里。

**T14. 改渲染层 → legacy 树已冻结，只接受安全修复。**
yoyo 2026-09-19 就 `R-S12` 拍板：legacy 回滚版**保留但冻结**（三选一里的 b），不定退役日期，也不重排 #30。

- **冻结范围**：`src/` 下除 `src/renderer-v2/` 以外的全部源码（`App.tsx`、`components/`、`pages/`、`styles.css`、`src/*.ts` 纯逻辑层与它们的 `.test.ts`）+ `tooling/legacy-renderer/` + `compile:legacy` / `dev:legacy` 两条入口。注意 `vitest.config.ts` 里那个叫 `legacy` 的 project 同时覆盖主进程的 `electron/` 目录，**主进程不在冻结范围内**。
- **只接受安全修复**：违反第 4 节 I1–I15 的问题（命令注入、提权环境、凭据跨 IPC、路径穿越、IPC 入参未校验、日志未脱敏、导航白名单等）照常修。
- **不接受**：新功能、界面调整、一般/建议级缺陷、重构、补测试、为对齐 v2 行为而改 legacy。这些一律只在 `src/renderer-v2/` 做，legacy 侧的同类问题在审查清单里直接标「legacy 已冻结，不修」。
- **两棵树同时改**：只有安全修复和跨树的类型/契约变更（改 `electron/ipc-contract.ts` 后两侧都得跟着编译）才允许一个 PR 动两棵树；功能提交不许捎带 legacy。
- **不删代码、不改行为**：冻结不等于退役。`npm run compile:legacy` / `dev:legacy` 保持可用，legacy 的既有测试继续在 `npm test` 里跑，不许为省时间跳过。
- **例外要回去问**：如果 legacy 连构建或启动都不成立（`R-F1` 那一类「回滚版事实上不可用」），那是「冻结还有没有意义」的问题，回到 yoyo 那里重新拍板，不要自己在 legacy 上做功能性修复。

改到冻结范围内的文件时 `.claude/rules/legacy-renderer.md` 会自动加载，内容与本条一致。

---

## 6. 代码约定

> **这些是从现有代码统计出来的事实，不是新规定。写出来的代码要和现有代码无缝。**

**格式**（仓库无 ESLint / Prettier；能机械判定的几条由 `scripts/verify-renderer-style.test.cjs` 门禁兜底，随 `npm test` 跑）
- **行尾不加分号**。唯一例外是照 ui-spec 原型抄下来的 v2 组件层与注册表——`src/renderer-v2/ui/`、`src/renderer-v2/registry/`、`gallery.tsx` / `gallery-entry.tsx` 通篇带分号，是既成事实（全量重排会摧毁 git blame，见第 7 节）。**门禁把带分号的写法锁在这几处**：改这些文件就跟随文件现状，其他任何地方（含 v2 的 `features/`、`pages-*.tsx`，以及主进程和 legacy 树）加行尾分号会红。不要为了统一风格去重排另一边。
- **字符串用单引号**
- 缩进 2 空格
- **禁止 `as any` / `@ts-ignore` / `eslint-disable`**（门禁钉住；`@ts-expect-error` 只许出现在测试里，用来钉住「这个调用本该编译不过」）
- 门禁不看 `canvas-v2/`：画布整体暂不改动，风格同理。

**函数与命名**
- **模块顶层一律用 `function` 声明，不用箭头函数**（门禁钉住，非测试文件 0 例外）。测试文件里 `const fixture = () => ({ … })` 这类夹具构造器不在约束内，是既有写法。`let` 声明的箭头函数插槽（夹具里把 Promise 的 resolve 暴露出去）也不在约束内。
- 导出函数的动词有固定语义：
  - `inspect*` — 探测状态，返回结构化结果，不抛错
  - `resolve*` — 解析出一个确定值，找不到返回 null
  - `build*` — 纯函数构造对象/计划，不产生副作用
  - `validate*` / `assert*` — 校验，失败抛错
  - `ensure*` — 幂等地保证某状态存在
  - `create*` — 工厂，返回服务对象

**语言**
- **面向用户的错误消息一律中文**
- **测试名一律英文**
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

## 7. 不要做的事

- ❌ **不要引入 Prettier / 大改格式** — 现有风格一致性已经很高，全仓重排会摧毁 git blame
- ❌ **不要引入 Redux / Zustand / Jotai / MobX** — `App.tsx` 的一堆 useState 里真正跨组件共享的只有少数几个（`snapshot/config/settings/theme/toast` + 账号态），props 深度 1-2 层；其余都是 `configOpen`、`logOpen` 这类局部 UI 开关。**正确解是拆组件，不是换状态方案。** 拆完仍嫌传得烦，最多加一个 Context
- ❌ **不要用 zod / valibot / ajv 替换 `ipc.ts` 用的手写 parse 函数（在 `electron/ipc/parsers/`）** — 它们产出的是能直接上屏的中文错误文案
- ❌ **不要开 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`** — 实测前者会新增近百条错误，抽查全是已被前置校验保护的下标访问，**零个真 bug**。现在的 `strict: true` 已经足够
- ❌ **不要顺手加 jsdom / happy-dom** — 组件测试已经有 `renderToStaticMarkup` 这条不需要 DOM 环境的路子（见 T7），换 DOM 环境是需要跨 agent 对齐的基础设施改动。`e2e/` 的套件已经是更高性价比的替代
- ❌ **不要把路由级 code-splitting / React.lazy 铺开** — JS 从本地磁盘加载且开了 `codeCache`，一般页面拆了收益为负。已有的例外：renderer-v2 `App.tsx` 对聊天、业务页、加速页三个重页面按需加载，首屏 JS 实测少约两成（README「启动性能状态」）；再加要拿同样的实测说话
- ❌ **不要引入 react-window / react-virtualized** — 最长的会话列表已在 SQL 层分页到每页 ≤100
- ❌ **不要给主进程上 bundler** — 会模糊信任链模块的边界，那是本项目的核心可审计资产
- ❌ **不要为了让测试在非 Windows 通过而改断言** — 用平台门控，否则会弱化对 Windows 行为的验证；画布边界门禁脚本同理，不要为了让它过而改断言
- ❌ **不要绕过 npm 官方源的 SHA-512 对账** — 那是防镜像投毒的核心设计
- ❌ **不要动 Codex 桌面端的镜像实现** — 那是全项目网络处理做得最对的一块
- ❌ **不要"消除" 三个 preload 里重复的通道表** — 那是 sandbox 约束下的有意重复（I7），主窗口那份被 `satisfies` 类型钉死、另两份由测试钉死，拼错当场就红
- ❌ **不要把 `config-files.ts` 的 `switch (provider)` 重构成策略类层级** — 无 `default` 分支正是新增 provider 时的穷尽性保障
- ❌ **不要给 API Key 加 DPAPI / keytar 加密存储** — 本程序的全部职责就是把 Key 写进 CLI 的明文配置文件，再加密一份攻击面一点没变。⚠️ 这条针对的是 **relay API Key 的"以加密求保护"**；两个已实装的例外别拆：登录 session token 用 `safeStorage` 加密（`account-session-store.ts`）是正确做法；`managed-cli-key-store.ts` 对托管 CLI Key 的 safeStorage 缓存（PR #81）**目的不是保护而是复用**——new-api 列表只回掩码 Key，无本地缓存则每次登录/切账号都要重新签发或走服务端 reveal，缓存消除的是服务端 token 堆积与限流面
- ❌ **不要在 legacy 树上做新功能、界面调整或一般缺陷修复** — 2026-09-19 已冻结，只接受安全修复，其余一律在 `src/renderer-v2/` 做（见 T14）。反过来也不要顺手删 legacy 代码或停掉它的测试，冻结不是退役
- ❌ **不要提交 `\tmp\xingmang-managed-cli-*` 目录**

---

## 8. 开发流程

**分工**（2026-10-10 起）：云端是主开发；Claude·win 只做真机验证、找问题、提 issue，不写功能代码，按 yoyo 触发；发版的两次批准、装机验收、业务取舍归 yoyo。细则见 `docs/COLLABORATION.md` §7。2026-10-17 起另一个云端项目「Claude-mac」与云端轮换开发，规矩相同（见 `docs/COLLABORATION.md` §1）。云端的两条硬要求：**断言仓库或线上状态之前，必须去读**；**Windows 专属的东西（第 4 节 I1~I15）不要盲设计**，由 yoyo 或 Claude·win 主导，云端可以审。

**改动前**：读第 4、5 节（不变量与陷阱）；从最新 `main` 拉分支。多人并行时在对应 Issue 上留言认领。

**改动中**：一个 PR 只做一件事；涉及安全边界的改动，先在测试里写出"为什么安全"。

**提交前**：`npm run typecheck` + `npm test` 两条都要过（见第 3 节）。

**写变更日志**：在 `changes/unreleased/` 下放一个分片文件（`## 用户` 进 `release-notes.md`，`## 开发` 进 `CHANGELOG.md`，写法见该目录 README），发版时 `npm run changelog:collect` 汇总。**不要直接改两份文件的「未发布」段**——并行 PR 都往那一段加行必冲突，而带冲突的 PR GitHub 不触发 CI，CI 会拒绝这种改动。

**提交**：分支命名与 PR 规范见 `docs/COLLABORATION.md`。要借 GitHub Actions 临时跑一次探测（容器里做不到的核对），边界见同一份文档 §3 的「一次性探测工作流」：只读、不挂 environment、不读 secret、用完删分支。

---

## 9. 文档索引

按任务类型读，不必全读：

| 你要做什么 | 先读 |
|---|---|
| 领任务、提 PR | `docs/AGENT-RUNBOOK.md`、`docs/COLLABORATION.md` |
| 找文件、看模块职责 | `docs/MODULE-MAP.md` |
| 改账号 / 计费 | `docs/RECON-new-api.md`、`docs/ACCOUNT-PLAN.md`（**必读**） |
| 改画布 / AI 工作区 | `docs/RECON-canvas.md`、`docs/CANVAS-V2-PLAN.md`、`docs/AI-CHAT.md`、`docs/CANVAS-THIRD-PARTY.md`（**必读**；2026-08-12 起执行搬进主进程，早于该日期的描述以代码为准） |
| 改界面（renderer-v2） | `ui-spec/v4/README.md`（v4.0 基线），再按需看 `ui-spec/` 与 `docs/UI-V3.1.1-V2-REBUILD.md`（见第 10 节） |
| 改 macOS 相关 | `.claude/rules/macos-platform.md`（自动加载）、`docs/MACOS_DEVELOPMENT.md`、`docs/MACOS_FREE_DISTRIBUTION.md` |
| 改 Linux 相关 | `docs/LINUX.md` |
| 发版 | `docs/RELEASING.md` |
| 排查测试基线 | `docs/TEST-BASELINE.md` |
| 了解产品背景与优先级 | `docs/ROADMAP.md`、`README.md` |
| 已确认问题与修复计划 | `docs/IMPROVEMENT-PLAN.md` |

`HANDOFF.md` 是会话间交接快照，**时效性文档**：与本文件或代码冲突时以代码为准。任务索引在 GitHub Issue [#27](https://github.com/xufei5620/xingmang-ai-manager/issues/27)。

---

## 10. 当前阶段（易变，改这里不影响上面）

**界面改版 UI v4.0**（2026-10-14 yoyo 确认，取代 v3.1.1 的视觉和页面结构）：基线是 `ui-spec/v4/README.md` 与 `ui-spec/v4/星芒AI管理工具-v4原型.html`，在现有 `src/renderer-v2/` 上改，已接好的业务照用。做 `src/renderer-v2/` 或 `ui-spec/` 的工作时，`.claude/rules/renderer-v2.md` 会自动加载，里面是完整的实施约束；v3.1.1 阶段的实施状态见 `docs/UI-V3.1.1-V2-REBUILD.md`。

**legacy 回滚版已冻结**（2026-09-19，`R-S12`）：只接受安全修复，新功能与一般缺陷只在 `src/renderer-v2/` 做，代码与两条 `:legacy` 入口都不删。完整口径见 T14；#30（拆 legacy `App.tsx`）已按这条决定关闭。

**规模概览**（只为让你心里有数）：主进程与渲染层各有几百个 TS 文件，vitest 数千个用例，`npm test` 还串带 `scripts/` 与 `e2e/` 下的 node --test 套件；具体数字以 `ls` / 测试输出为准。IPC 通道数以 `ipc-contract.ts` 的 `ipcInvokeChannels` 为准，画布宿主通道以 `canvas-contract.ts` 的 `canvasHostChannels` 为准。
