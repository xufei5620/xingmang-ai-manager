# 模块地图 · 主进程：IPC 边界、命令执行、配置、画布与平台层

> 总述、三套跨进程通道和其他分册见 [`../MODULE-MAP.md`](../MODULE-MAP.md)。每个模块一句话，**一律以代码为准**；加了新模块在这里补一行。

## IPC 边界与 URL 策略（主窗口那一套三件组）

- `ipc-contract.ts` — **主窗口业务通道的类型真相源**（另两套见总述）：`ipcInvokeChannels` / `ipcEventChannels` 两张通道表 + `XingmangApi` 接口，`as const satisfies` 让通道表和接口对齐。只许 `import type`；值导出只能来自零 Node 依赖的模块（现在是 `catalog.ts` 的 `providerIds` / `managedCliKeyProfiles` 和 `relay-sites.ts` 的一组站点常量），否则 Vite 会把 `node:fs` 打进渲染包（I6）。列在 CODEOWNERS 里，加通道要让 yoyo 看见（T1）
- `preload.ts` — 主窗口的 sandbox 桥，暴露 `window.xingmang`。sandbox 下不能 require 本地模块，所以**手抄了一份通道表**，用 `satisfies` 钉住契约类型，`preload.test.ts` 钉住内容；这份重复是有意的，别"消除"（I7、T1）
- `ipc.ts` — `registerIpcHandlers` 是主窗口业务通道的薄入口：建好 `registerTrustedHandler`（校验 sender URL、结构化日志、等账号、统一 dispose，I4），交给 `ipc/handlers/` 下各域注册，最后统一撤销。每条通道日志记什么、要不要等账号照 `ipc-channel-policy.ts` 那张表办（I3、I13）。`IpcRegistrationOptions`（main.ts 交进来的全部依赖）也定义在这里。`ipc.test.ts` 把实际注册的通道和契约排序比对，漏注册、多注册都会红
- `ipc/handlers/` — 主窗口业务通道的处理器，按域一个文件（#1070 第 7 步从 `ipc.ts` 原样搬出）：`system`（平台能力、本机检测）、`config`（工具配置读写、切换账号来源、补模板、查型号）、`external-clients`、`launch`（选工作目录、打开命令行工具和 Codex 桌面端，敏感目录提醒和试写都在这）、`tools`（Node.js、Python、Git、命令行工具和 Codex 桌面端的装卸与状态）、`window`（窗口、外链、网络设置、画布窗口）、`updates`、`sessions`、`settings`、`diagnostics`、`runtime-logs`（含反馈报告和「打开所在位置」）、`backups`、`extensions`、`account`（登录、会话、本机账号、公告、密码）、`acceleration`、`account-billing`、`account-usage`、`account-keys`（签发、写进工具、撤销）、`ai-chat`、`data-transfer`。每个文件导出一个 `register*Handlers(ctx)`；几个域都要用的（账号服务、签发包装、备份上下文、取密钥、导出记录、敏感剪贴板）在 `context.ts` 的 `createIpcHandlerContext` 里建一份，域文件之间不互相 import。入参一律用 `ipc/parsers/` 的手写 `parse*` 函数校验、出中文错误（I5，别换成 zod）
- `ipc/handler-log.ts` — 通道调用成功那一行日志的中文说法和字段（`ipcSuccessMessage` / `ipcLogDetail`），加速页轮询状态的去重键 `accelerationStateLogKey`；只给 `ipc.ts` 的包装用
- `ipc/parsers/` — 主窗口业务通道的入参解析，按域一个文件（#1070 第 6 步从 `ipc.ts` 原样搬出）：`common`（`requiredString` / `optionalString` / `optionalBoolean` / `stringArray`，对象判断用 `input-guards.ts` 的 `isRecord`）、`system`（窗口、诊断、更新、检测、渲染层报错）、`settings`、`extensions`（MCP、插件市场、Skill）、`tools`（命令行工具和 Codex 桌面端的安装、配置、启动，选工作目录）、`sessions`、`account`（登录注册、密码、协议）、`account-billing`（充值、订阅支付）、`account-usage`（用量、看板、任务）、`account-keys`（密钥增删改、写进工具）、`ai-chat`。只认已知字段、限长、拒 NUL，报错是能直接上屏的中文；路径、密钥、网址相关的几个在同目录的测试里直接钉住，其余经 `ipc.test.ts` 的处理器用例覆盖
- `ipc-channel-policy.ts` — 主窗口业务通道的策略表 `ipcChannelPolicies`：键是契约里的通道名，每条必填 `log`（成功、失败记不记，入参给不给日志）和 `account`（要不要等账号恢复、在不在账号工作里跑、跑完核不核对账号），可选 `label` 是日志里的中文名。漏一条、拼错一条是编译错（#1071 第 1 条）。`config:reveal-api-key`、记住密码两条通道和聊天记录读写都标了成功不记
- `security.ts` — URL 策略的单一来源：`isTrustedIpcSenderUrl`（IPC 发送方校验，主窗口、画布、platform 三套 handler 都用它，I4）、`isAllowedAppNavigationUrl`（窗口内导航）、`isAllowedExternalUrl`（外链白名单，只认 https 和 `ms-windows-store:`，要求 `href` **全等**，防 `xm.solov.cc.evil.com` 这类前缀绕过，I12）、`resolvePackagedApplicationFile`（`xingmang://` 与 `xingmang-canvas://` 共用的防穿越解析，I15）；另有 `hasDisallowedPackagedDebugSwitch`，打包版由 `platform/entry.ts` 在分出任何一支之前调用，拒绝 `--inspect` / `--remote-debugging-*` 和能让 Chromium 拉起命令的 `--gpu-launcher`、`--*-cmd-prefix`、`--browser-subprocess-path`；照 Chromium 的读法，单短横线和 Windows 上的斜杠写法同样拦。它是黑名单，残余风险写在源码注释里（#1065）
- `input-guards.ts` — 最基础的输入检查（`isRecord`、`isStringArray`、`filterStrings`、`isPromiseLike`），零依赖、渲染层也能值导入（I6）；只判断不出报错文案。新代码从这里取，旧文件里各自那份等拆分时（#1070）顺手换（#1071 第 3 条）

## 命令执行与安全边界（本项目真正的复杂度在这里）

- `command-runner.ts` — **全仓最关键模块**，所有子进程从这里起：`runCommand` 只走 `execFile`/`spawn` + argv 数组、硬编码不开 shell（I1）；`trustedCommandEnvironment` 剥掉 `NODE_OPTIONS`、`PSModulePath`、`LD_PRELOAD` 这类几十个能让子进程启动即加载外来代码的变量并重建机器级 PATH，跨提权边界必须配 `trustedOnly:true` 用它（I2，只能加禁止项，T4）；`commandEnvironment` 是同用户路径的净化基底；`findExecutable` 不调 `where`/`which`/shell，`windowsSystemExecutable` 给系统程序绝对路径（I14）；`redactCommandText` 是日志脱敏第一层（I13）
- `trusted-temp.ts` — Windows 上受 ACL 保护的临时目录与安装包缓存根（`XingMangAI\InstallerCache`）：`createTrustedTemporaryDirectory` / `ensureTrustedDirectory` 建目录后用 icacls 或 PowerShell 收紧权限、核对属主，提权安装只从这里拿下载物，防低权限进程在下载与执行之间偷换文件
- `system-shell.ts` — 替主进程"打开网址 / 打开文件夹"：Windows 上不在（可能提权的）Electron 进程里直接 ShellExecute，而是用从可信 SystemRoot 定位的 `explorer.exe` + 可信环境转交给交互式外壳（I14、I2）；只有微软商店 URI 例外走 `shell.openExternal`。ipc、画布窗口、外部客户端、Codex 桌面端等都用它
- `trusted-native-cli.ts` — Windows 原生 CLI（`.exe`）的 Authenticode 签名核对与暂存：按工具钉发布者主体名，Grok 还钉签发 CA（X.AI LLC 与 X Corp. 两张证书都认，名单与 `scripts/sync-grok-cos.cjs` 的 SIGNERS 是同一份、改要两处一起改）；只认单链接普通文件，核过签名再算 sha256 放进受管目录。目前由 `grok-installer.ts` 使用
- `system-certificate-trust.ts` — 公司审计网关、杀软网页扫描会换掉 HTTPS 证书，Chromium 信系统证书库所以登录正常，Node 写的 npm 却装不上。这里只给同用户路径的子进程环境加 `NODE_USE_SYSTEM_CA=1`（用户自己设过就不动），并在仍失败时判断是哪种情况好给对下一步提示；`trustedCommandEnvironment` 会剥掉它，因为跨提权边界时当前用户的证书库是低权限一侧可写的（I2）
- `manual-redirect-fetch.ts` — 让 Electron `net.fetch` 的 `redirect:'manual'` 表现得和 undici 一样（返回不带正文的 3xx，并当场取消请求）。不包这一层时，安装包下载的第一跳重定向必定报 "Redirect was cancelled"，账号与中转请求也认不出强制门户、没法切线路（#1064）；`main.ts` 给它发出去的每个 Chromium 会话 fetch 都包了这一层（I10）
- `platform-capabilities.ts` — **判断"当前平台支持什么"的单一入口**（`platformCapabilitiesFor`）：Node/Python 由谁装、各 CLI 由谁装、要不要 Node、有没有加速、Codex 桌面端能不能装/开/卸等；Grok 按平台走哪条路装（`grokInstallStrategyFor`）也在这里；`processElevated` 不在这里算，由 `platform:get-capabilities` 通道叠上去。渲染层经这条通道拿结果，不自己猜平台。改跨平台代码前先读它

## 本地文件与有界读写（I8 / I10 的工具库，写本地数据和读网络响应一律走这里）

- `safe-local-data.ts` — 用户可写区里读写数据文件的统一入口：`assertNoReparseComponents` 逐级拒绝符号链接与目录联接，`ensureSafeDataDirectory` / `assertSafeDataFile` / `readSafeUtf8File*` / `writeAtomicSafe*`（临时文件 + 原子改名）/ `appendSafe*` / `renameWithTransientRetry*`（扛 Windows 杀软短暂占用）。路径先过 `relocated-folders.ts`：只在 same-user 模式下跟随「C 盘搬家」留下的联接，trusted-only 下一律拒绝（I8 已登记的例外）
- `bounded-file.ts` — 有上限地读文件、独占复制文件：要求单链接普通文件（`nlink === 1`），读前读后比对 dev/ino/大小/时间戳，路径校验期间被换掉就报错，防硬链接与 TOCTOU 重定向（I8）
- `bounded-directory.ts` — 有上限地列目录（`readDirectoryEntries*`），条目超过上限抛 `DirectoryEntryLimitError`，防被塞爆的目录拖垮主进程
- `bounded-response.ts` — 有上限地读 HTTP 响应体（`readBoundedResponseText/Bytes`），先看 content-length 再边读边数，超了就取消；I10 四件套里"响应体上限"那一件
- `redirect-allowlist-fetch.ts` — 逐跳跟随下载跳转（`fetchWithRedirectAllowlist`）：强制 `redirect: 'manual'`，第一跳、每个 Location、响应自报的地址都过调用方给的校验，响应地址还必须正好是这一跳，另管循环与次数上限；I10 四件套里"重定向策略"那一件。`fetchLandingWithRedirectAllowlist` 另交回答话的那一跳（生产下载用的 fetch 不填 `response.url`），续传可设 `beyondLimit: 'return'` 不跟跳转；客户看得到的报错可用 `messages` 沿用原话。Node 运行时、Mac 桌面端安装器、Codex 插件目录、Git 运行时、Claude Desktop MSIX、Grok 版本查询、AI 图片下载在用（图片那处传进来的 fetch 每一跳按主机挑：`imgen.x.ai` 走跟随代理的会话，其余先查 DNS 再钉住地址）；Codex 桌面端那份按 AGENTS 第 7 节不收
- `bounded-operation-queue.ts` — 有并发上限和排队上限、可取消（AbortSignal）的通用任务队列；图片生成（`ai-image-service.ts`）和首页扫描的探测子进程（`system-service.ts`）在用。注意它不是 I11 的 `InstallationQueue`，安装类操作不能拿它代替
- `schedule-timeout.ts` — 后台控制器默认用的延时器（`scheduleTimeout`，返回取消函数，计时器 `unref`）：应用线路、工具线路、系统代理复查、加速到期和中断提醒五处共用，测试各自注入假的；新控制器照用，别再抄一份（`schedule-timeout.test.ts` 钉住只此一份）
- `safe-storage-backend.ts` — `safeStorage.isEncryptionAvailable()` 只说明"能调"，不说明"有保护"：Linux 没有密钥环时 Chromium 退到 `basic_text`，密钥是编进程序里的常量。这里把这种情况认成 `plaintext` 并拒绝落盘，Linux 上改成只在本次运行内存里保存（`resolveCredentialPersistence`）。登录会话、记住密码、托管 CLI Key 缓存、聊天 Key 缓存、多账号保险箱都经它判断

## CLI 服务与首页扫描

- `system-service.ts` — **全仓最大、最容易撞车的模块**：`createSystemService` 之前是导出的纯函数区（可直接单测），之后是闭包工厂（内部函数不导出），新逻辑先写成顶层纯函数再在闭包里调（T3）。管首页扫描（Node/CLI/桌面端/网络位置）、CLI 卸载与回退、打开工具、一键修复等；`SystemSnapshot` 等类型也从这里导出。#1070 第 2、3 步正按簇把闭包搬成各自的服务文件（装和更新 CLI 已搬进 `cli-install-service.ts`，见 [`main-cli-clients.md`](./main-cli-clients.md)），搬走的导出名这里照旧转出
- `system-service-context.ts` — 系统服务各簇共用的那一份上下文（#1070 第 2 步从 `createSystemService` 开头原样搬出）：`createServiceContext` 把选项解析成实际用的那一份（测试替身或缺省实现，缺省往严里取：执行模式缺省 `trusted-only`），建几份记录文件、安装排队（I11 的 `InstallationQueue` 与取消登记）和保存配置的排队，外加只靠这些就能做的几样：找命令、跑 `--version`、下载临时走加速（计数决定安装源顺序）、建安装临时目录、装之前看盘、认托管 npm 布局、终端里直接敲工具名那套（`cliTerminalAccess`）、文件被占用时补一句（装和卸都用）；Mac 上核 Grok 签名的那个执行器（`buildDarwinTrustedVerificationRunner`，固定走 `trustedCommandEnvironment`）装和卸都用，也放这里。`system-service.ts` 正按簇把闭包搬成各自的服务文件，都只拿这一份上下文；它只 import `system-service.ts` 的类型，免得两个文件互相 require
- `system-snapshot-cache.ts` — 把上一次首页扫描结果留在本机，下次启动先画出首页、后台照常重扫。这份文件**只用来"先画个样子"**：主进程里任何要回答"装没装"的地方都不读它；别的版本写的文件照样认，但剥掉版本判断（`withoutVersionVerdicts`）
- `project-instructions.ts` — 打开工作目录时，若 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 一个都没有，就用随包模板生成一份 `AGENTS.md`（三个工具都读它），绝不覆盖、绝不追加；`PUBLISHED_PROJECT_INSTRUCTIONS_DIGESTS` 记着每一版模板的摘要，检查页靠它认出个人文件夹里那份还是星芒放的原样（已知36），改模板只能往表里加、不能删
- `manual-uninstall-visual-fixture.ts` — macOS 视觉验收专用的假快照（把 Codex/Grok 投影成「需要手动卸载」的样子），只在未打包且 `XINGMANG_E2E_MANUAL_UNINSTALL_FIXTURE=1` 时由 `main.ts` 启用，供 `e2e/macos-visual-qa.mjs` 截图；正式包里永远不生效

## 配置与备份

- `config-files.ts` — 各 CLI 配置文件的读写：**两阶段提交 + .bak 备份 + 失败回滚**（I9，Codex 一次要同时改 `config.toml` 和 `auth.json`）；`toNativeConfigSummary` 剥掉 `apiKey`，明文只走 `config:reveal-api-key`（I3）；切官方账号、路由跟随、钩子、状态行、工作区信任（字段实测见 `docs/WORKSPACE-TRUST.md`）、退役 Gemini 的清理也在这里。按 provider 分支的几个 `switch` **没有 default 分支**，是新增 provider 时的穷尽性保障，别重构成策略类（T2）；用户自己设过的值不动；改 `providerConfigPaths` 要顾及备份、诊断、启动前校验等消费者（T10）
- `config-file-backups.ts` — 配置文件旁边那份 `.bak.<时间戳>` 怎么起名、「每个文件只留最近 5 份」该删哪几份；`config-files.ts` 的保存事务和 `codex-config-toml.ts` 往同一个目录放、一起数，名字只能出自这里（#1068）
- `backups.ts` — 配置备份与恢复（手动 / 保存前 / 恢复前三种），`ConfigBackupStore` 在用户数据目录下按 manifest 存每个文件的原样与 sha256；v2 manifest 额外记 Key 的 sha256（`apiKeyDigest`），恢复前能告诉用户备份里那把 Key 是不是当前账号的、会不会恢复出一把已作废的 Key；必须兼容老版本留下的 v1 备份（T10）
- `config-directory.ts` — 「打开配置文件夹」前的校验：拒绝经过符号链接/联接的路径，免得资源管理器被引去攻击者指定的位置（I8）；刻意不替用户建目录，"还没生成"就如实说。只有 `ipc.ts` 用

## 会话

- `provider-sessions.ts` — 各 CLI 统一的对话记录视图（列表、详情、导出 Markdown、删除）：Codex 交给 `codex-sessions.ts`（权威源是 `~/.codex/state_5.sqlite`），Claude 读 `~/.claude/projects`，Grok 读 `~/.grok/sessions`；退役的 Gemini 不再列出（`listedProviderSessionProviders`），记录本身留在客户电脑上
- `provider-session-probe-cache.ts` — 会话列表的探测缓存：只存从每个会话文件里提取的标题、目录、时间、条数等元数据，**对话正文永不进缓存**；版本对不上整份丢弃重建，坏了就退回逐个读文件。只被 `provider-sessions.ts` 使用

## 扩展

- `provider-extensions.ts` — 各 CLI 统一的 MCP / Skill / Plugin 抽象（`ProviderExtensionService`）：列出、安装、卸载、启停、查更新、MCP 健康检查，都是在主进程以 argv 数组调用各家 CLI 自己的子命令（MCP 的 command/args 来自用户输入，I1）；Claude 官方插件市场在没开过终端的电脑上不存在，这里替它注册（要 git，缺 git 时给能照做的提示）。Codex 专用部分在 `codex-extensions.ts` 和 `codex-plugin-catalog*.ts`

## 无限画布 + AI 工作区（全项目唯一运行第三方前端代码且有宿主桥的地方）

> 2026-08-12（PR #85）起**画布再也拿不到 API Key**：Key 只在主进程按账号和分组解析（`chat-credential-coordinator.ts`），全部 AI 调用、产物下载与落盘都在主进程完成，画布只能经 `canvas-host:*` 通道"请求"。这是 I15 的兑现方式：被投毒的画布连 Key 都摸不到，因为它从来没有过。给画布加任何能力前先回答"画布被供应链投毒后，这个能力能干什么"。画布源码在 `canvas-v2/`，`dist-canvas/` 是构建产物不入 git（T13）。

### 画布窗口与宿主桥
- `canvas-window.ts` — **画布窗口的总控**：独立 `BrowserWindow`，加固与主窗口同级（`sandbox` / `contextIsolation` / `webviewTag:false` / `navigateOnDragDrop:false`），拦 `will-navigate` 与 `setWindowOpenHandler`（I12）；用自己的 `registerCanvasHandler` + `assertTrustedCanvasSender` 注册全部 `canvas-host:*` 通道，只放行画布窗口自身（I4 的登记例外）；文件读写只走原生对话框，项目工作文件夹也由主进程弹框选；Linux 上打开前先确认渲染进程沙箱真的生效（`linux-renderer-sandbox.ts`），崩溃后自动恢复
- `canvas-contract.ts` — 宿主通道名 `canvasHostChannels` 与各通道入参/返回类型的单一来源（主进程侧），通道清单以它为准
- `canvas-preload.ts` — 画布的隔离 preload，暴露 `window.xingmangCanvasHost`，拿不到 `window.xingmang`。通道名是与 `canvas-contract.ts` 有意重复的字面量（I7），由测试钉死；OS 拖放进来的文件路径**只能**由这里的 `webUtils.getPathForFile(File)` 取得，是 I15 唯一的路径例外。由 `canvas-window.ts` 按文件路径加载
- `canvas-protocol.ts` — `xingmang-canvas://` 协议：穿越与根包含检查全部委托 `resolvePackagedApplicationFile`，SPA 回退也重走同一函数，绝不手工拼路径；与主窗口**不共享 rendererRoot**；CSP 由主进程响应头强制注入（`canvasSecurityResponseHeaders`，连接只放行 `xingmang-asset:`，I15）
- `canvas-request-parser.ts` — 画布全部入参的字段白名单校验（生图、改图、生视频、素材查询与改名、提示词预设、运行图等），运行图的提示词总量也有上限，防被投毒的画布用超大图拖垮主进程（I5、I15）。由 `canvas-window.ts` 使用；生图入参的 `parseImageGenerateInput` 另给对话页的 `chat:generate-image`（`ipc.ts`）用，两边同一套标准（#1071）
- `canvas-generation-admission.ts` — 按画布窗口限流直接生成请求（同时进行数与每分钟发起数），防画布刷请求刷额度

### 运行引擎（都在主进程）
- `canvas-run-contract.ts` — 画布运行的数据契约：节点种类（含漫剧节点）、运行范围、尝试与候选产物、事件时间线、运行记录
- `canvas-run-engine.ts` — DAG 执行引擎 `executeCanvasRun`：按依赖调度、按节点指纹命中缓存、记时间线；挑图、路由、输出和漫剧角色/场景/道具节点**不进缓存**（它们读用户当前绑定的图，换图后命中缓存会一直交出旧图，#541），也刻意不把绑定的图加进指纹，免得升级后全部下游缓存失效重复扣费
- `canvas-run-service.ts` — 运行的启动、取消与发布：同账号同窗口同项目的运行串行、节点加锁，限制并行运行数与单次运行的远程生成上限（防一次点击扣出大额费用），把事件推给画布窗口；推送失败不影响已落盘的运行，也不会重放付费节点
- `canvas-run-store.ts` — 按账号存运行记录、节点结果缓存与产物来源清单，有保留上限；账号初始化时对账素材（`reconcileAssets`）
- `canvas-node-executors.ts` — 把运行引擎的 text / image / video 节点接到主进程的文本补全、图片服务、视频服务上；漫剧解析节点用 `drama-parse-prompt.ts` 发提示、`drama-parse.ts` 校验结果
- `canvas-fingerprint.ts` — 节点指纹与图修订号：规范化 JSON 后算 sha256，指纹包含模型能力与上游交出的文字/产物，决定能不能命中缓存
- `canvas-asset-references.ts` — 查一个素材被哪些运行用作输入或候选，删除素材前给用户看引用

### 画布项目
- `canvas-project-store.ts` — 画布项目的本机存储（按账号一个项目一个 JSON，有项目数上限），每个项目可绑定一个用户在原生对话框里选的工作文件夹；复制项目时连素材一起有界复制
- `canvas-project-asset-manager.ts` — 按项目把素材分流：绑定了工作文件夹的项目，产物存进那个文件夹，否则存全局作品目录；两个站点账号的素材分开放，用户选了同一文件夹也不混
- `canvas-project-package.ts` — 项目导入导出包：导出时剔除凭据类字段、本机路径和远端 URL，导入时校验体积、素材数和 sha256，再把素材 id 重映射
- `canvas-prompt-preset-store.ts` — 画布提示词预设（按账号，有条数与体积上限），走 safe-local-data 原子写

### 漫剧（画布里的剧本分镜）
- `drama-model.ts` / `drama-parse-prompt.ts` / `drama-parse.ts` — 漫剧节点的数据模型与上限、给模型的"把剧本解析成角色/场景/道具/镜头表"系统提示、对模型输出的容错解析与校验（剥控制字符、截断、去重）。三者与 `canvas-v2/src/library/` 下同名文件逐字相同，主进程不 import 画布源码所以各留一份；`scripts/verify-drama-parse-parity.test.cjs` 钉住两边逐字一致（画布那份 `drama-parse-prompt.ts` 没有 import，只为两边一致而留）

### AI 服务（聊天、生图、生视频，与 CLI 共用同一账号额度）
- `ai-chat-protocol.ts` — AI 请求的协议层：端点（`/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits`、`/v1/videos`）、各种上限、型号能力表 `resolveAiModelCapability` 与请求体构造；聊天、生图、生视频、画布指纹和执行器都依赖它
- `ai-chat-service.ts` — 主进程的流式聊天：连接、空闲、总时长三道超时（长思考模型几分钟不出字也不截断，Q43），事件/输出/响应体都有字节上限，按窗口限并发；附图在主进程按账号读回转成 data URI；`completeOnce` 供画布文本节点用。Key 经 `chat-credential-coordinator.ts` 拿，渲染层只发"请求"
- `ai-image-service.ts` — 生图与改图（multipart `/v1/images/edits`）：用有界队列限并发、可取消，响应体有上限；发请求前先试写保存位置，写不进就在扣费之前停下
- `ai-video-service.ts` — 生视频：提交任务后退避轮询，完成后下载 mp4；下载前做 DNS 检查，拒绝回环、内网、链路本地等地址（只放行 Fake-IP 代理常用的 198.18.0.0/15），任务记进 `ai-video-task-store.ts`，重启或切回账号后能续上
- `ai-video-task-store.ts` — 按账号存进行中的视频任务（模型、分组、所属项目/运行/节点、提示词），有条数上限，供续任务和把提示词写回成品
- `ai-chat-history-store.ts` — AI 聊天记录的文件存储（用户数据目录 `chat-history/<scope 的 sha256 前 32 位>/`，一个对话一个文件 + 最后写的 `index.json`）。渲染层负责脱敏与格式校验，这里只做入参校验、按账号串行的原子写、单文件/总量/账号目录数上限（防被攻破的渲染层换 scope 写满磁盘）；对话数上限与渲染层 `storage.ts` 是有意重复
- `ai-chat-attachments.ts` — 聊天里附带的图片只从系统选文件框和剪贴板在主进程里取，渲染层给不出任何路径或字节（I15 同一思路）；太大的用 nativeImage 压到长边 2048、2 MB 以内，存进本账号的图片素材目录
- `chat-key-store.ts` — AI 聊天按分组签发的 Key 的本机缓存（`ChatKeyStore`）：`safeStorage` 加密落盘，`basic_text` 后端时拒绝落盘、只在本次运行内存里留；有账号数、每账号 Key 数上限，支持按账号/分组/Key 失效，并把退役分组名改成新名。由 `chat-credential-coordinator.ts`、`account-key-options.ts` 使用

### 素材存储与读取
- `ai-asset-store.ts` — **图片素材的落盘与读取**（`AiAssetStore`）：按账号存进 `user-<id>/`，素材 id 由内容哈希派生；下载远端图片时只许公网地址、限重定向次数与超时、校验图片魔数（防 SSRF，I10）；提供复制、另存为、在文件夹中显示、右键菜单；`assertWritable` 让生成前先试写
- `ai-video-asset-store.ts` / `ai-audio-asset-store.ts` — 视频（mp4）与音频素材的落盘与读取，同样按账号、内容哈希定 id，读出时长宽高等元数据；音频只来自用户导入
- `ai-asset-index.ts` — 枚举一个账号的全部素材文件而不读任何媒体字节，替代以前"读全文件、最多 500 条"的做法，让搜索和排序面对的是完整结果、只为当前页补元数据
- `ai-asset-metadata-store.ts` — 素材的逻辑元数据（显示名、收藏、标签、最近使用、来源、生成时的提示词、回收站），每个账号文件夹一个 `asset-metadata.json`，有体积和条数上限；删除是逻辑删除
- `ai-media-asset-service.ts` — 素材库：把图片/视频/音频三个仓库和元数据合成一个可分页、可搜索、可按收藏/最近/回收站/标签/来源筛选的列表，"找相似"按提示词精确匹配；目前只交给画布窗口用（主窗口那套 IPC 不经过它）
- `ai-asset-protocol.ts` — `xingmang-asset://` 协议处理（image / video / audio / thumb）：每次都在最后一次 await 之后重新核对当前账号再返回，响应 `no-store`，支持单段 Range；主窗口（聊天图片）和画布都靠它显示素材，CSP 只放行这个 scheme
- `ai-output-location.ts` — AI 作品保存位置：安装版放「文档/XingmangAI」，「文档」被云盘同步或不让写时改用主目录下的 XingmangAI（`chooseAiOutputRoot`，试写与权限判定在 `documents-fallback.ts`），开发环境用项目下的 output；启动时把老版本放在安装目录旁 output 里的作品搬过来、合并元数据
- `ai-operation-lifecycle.ts` / `ai-operation-progress.ts` — AI 操作的观察钩子：开始/结束回调（用量统计用，观察失败绝不影响生成结果）与处理中/下载中/保存中的进度阶段

### 缩略图
- `asset-thumbnail.ts` / `asset-thumbnail-store.ts` / `asset-thumbnail-service.ts` — 素材缩略图：URL 格式与严格解析（版本号进 URL，升版即整代作废）、磁盘缓存（`<root>/user-<id>/<版本>/`，单张有上限）、生成服务（逐个串行解码免得卡主线程，同一素材的并发请求共用一次生成；视频封面只有 Windows 和 macOS 能取）

## `electron/platform/` 平台层

> **`platform/entry.ts` 才是程序真正的入口**（`package.json` 的 `main` 是 `dist-electron/platform/entry.js`），`main.ts` 是最后才被 `platform/desktop-entry.ts` require 进来的。这一层还自带一套**和 `ipc-contract.ts` / `preload.ts` / `ipc.ts` 无关的第二套 IPC 三件组**：`platform/contract.ts`（`xingmang-platform:*` 通道契约）+ `platform/preload.ts`（自带字面量通道表，暴露 `window.xingmangPlatform`）+ `platform/ipc.ts`（`registerPlatformHandlers` 注册，`assertPlatformOwner` 只放行主窗口主框架，I4 的登记例外）。改系统设置类通道（主题、高对比度、开机自启、通知偏好、代理状态）改的是这一套，不是主窗口那套；它只在新界面（renderer-v2）时安装。

### 入口
- `platform/entry.ts` — **程序入口**，在加载任何桌面模块之前按顺序分流：打包版带了调试或拉起命令的开关就直接退出（#1065）→ Linux 上以 root 或替别人运行就报一句原因后退出（Chromium 的缓存先指到临时目录，免得在客户主目录留下 root 文件）→ 卸载清理模式 → 加速辅助进程模式 → 都不是才 require `desktop-entry`。辅助进程不拿单实例锁、不开窗口、不注册渲染 IPC
- `platform/desktop-entry.ts` — 桌面进程入口：判定用新界面还是旧回滚界面（文件构建看产物里的 `renderer-v2.flag`，只有 dev server 才看环境变量），新界面时装上 `renderer-v2.ts` 与 `install-system-api.ts`，然后 require `../main`
- `platform/renderer-v2.ts` — 新界面的主窗口外观：建窗口前换成 v4 外框，按窗口宽度和用户的缩放偏好设缩放（监听 `settings.json` 变化），Windows 上同步标题栏按钮那一条的高度，F11 / ⌃⌘F 切全屏
- `platform/frame-navigation.ts` — 主窗口里子框架（iframe）的导航守卫：除 `about:blank` / `about:srcdoc` 外一律拦下，主框架导航仍交给 `security.ts` 的白名单（I12）；由 `main.ts` 装在主窗口上

### 第二套 IPC 三件组（系统设置）
- `platform/contract.ts` — `xingmang-platform:*` 通道名 `platformChannels` 与 `XingmangPlatformApi`、偏好与状态类型；渲染层 `src/renderer-v2/platform-api.ts` 等只 `import type` 它。通知文案固定在主进程，渲染层只给事件编号与少量数字
- `platform/preload.ts` — 平台桥 preload，暴露 `window.xingmangPlatform`；sandbox 下不能 import，通道名是字面量副本（I7）。它被注册在整个 session 上，而画布窗口与主窗口共用默认 session，所以只在主窗口自己的文档（`xingmang://app` 或本机 dev server）的主框架里才露出桥，真正的闸门仍是主进程的 owner 校验（I15）
- `platform/ipc.ts` — `registerPlatformHandlers`：每个通道先过 `assertPlatformOwner`（发送方必须是主窗口的 webContents 和主框架、URL 可信且与窗口当前 URL 一致），入参逐项校验（I5），日志只按白名单记"切了哪个开关"、不记载荷（`summarizePlatformInvocation`，I13）；日志经 `log` 回调交给 `runtime-log-bridge.ts`
- `platform/install-system-api.ts` — 把这套系统设置服务装进进程：等标题为「星芒AI管理工具」、没有父窗口的那个窗口出现，就认定它是主窗口，在它的 session 上注册平台 preload、建设置存储、通知服务和 `PlatformSystemService`，状态变化只推给 URL 仍可信的主窗口；退出时全部撤掉

### 系统设置服务
- `platform/system-service.ts` — `PlatformSystemService`：主题与高对比度（`nativeTheme`）、开机自启（Windows/macOS 用登录项，Linux 用 XDG autostart）、只读的应用窗口代理状态、通知与隐私偏好、测试通知；另导出 `migrateLegacyWindowsLoginItem`（`main.ts` 启动时迁移旧登录项）和 `removeWindowsLoginItem`（卸载清理用）
- `platform/settings-store.ts` — 平台偏好文件 `userData/platform-settings.json` 的读写（走 safe-local-data 原子写）；老版本文件缺新的通知开关时按默认开启补齐，不当成坏文件，值类型不对才拒绝
- `platform/notifications.ts` — 系统通知：标题和正文全部由主进程按固定表拼（安装结果、余额、花费突增、CLI 更新、公告、加速、终端里 CLI 出错或做完、缩到托盘、支付到账），按 `事件:编号` 去重，按偏好开关，点击后叫回主窗口并跳到对应页

### 同进程转接口（`main.ts` 与 `install-system-api.ts` 互不 import，靠这几个小模块搭桥）
- `platform/runtime-log-bridge.ts` — 平台 handler 先于 `RuntimeLogStore` 注册，这里把早到的日志缓冲起来，等 `main.ts` 接上后补发（I4 要求的日志那一半）
- `platform/host-notification-bridge.ts` — 让 `main.ts` 一侧（加速快用完/已断开、终端事件）能发系统通知；**不缓冲**，没接上就如实返回 `unsupported`，因为晚到的"加速还剩 5 分钟"比不送更糟
- `platform/proxy-bypass-bridge.ts` / `platform/tray-availability-bridge.ts` — 把 `main.ts` 里"代理连不上已改直连 / 只对星芒改直连"和"托盘建没建出来"两个状态读给设置页；没接上时分别当作没绕过、不知道

### 系统代理（给加速用，不在主窗口里跑）
- `platform/windows-system-proxy.ts` — Windows 上开关当前用户的系统代理：经可信 PowerShell（固定路径 + `trustedCommandEnvironment` + `trustedOnly`，I2、I14）调 WinInet 改设置，先写恢复记录与租约，只在整体状态仍等于预期时才写；被拦时退到预编译脚本。加速辅助进程和卸载清理使用
- `platform/macos-system-proxy.ts` — macOS 上经随包原生组件（`dist-native/macos-system-proxy-<arch>`）改系统代理：组件先校验再按内容哈希复制到 `~/Library/Application Support/XingMangProxy/helpers`（避开「文稿」类隐私保护导致授权失败），子进程只给最小环境，断开时让组件自己恢复、从不强杀。加速辅助进程使用

### 外观与平台事实
- `platform/zoom.ts` — 平台层对缩放公式的叫法，**只能委托** `window-preferences.ts` 的 `calculateUiZoom`：两个应用缩放的地方同时监听同一批事件，各留一份公式会由监听注册顺序决定用户看到哪个
- `platform/types.ts` — 平台层的类型（缩放偏好）
