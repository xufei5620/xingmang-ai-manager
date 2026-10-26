# 模块地图 · 主进程：生命周期、诊断、提权、加速、更新

> 总述、三套跨进程通道和其他分册见 [`../MODULE-MAP.md`](../MODULE-MAP.md)。每个模块一句话，**一律以代码为准**；加了新模块在这里补一行。

## 进程入口、生命周期与窗口
- `main.ts` — **桌面主流程与装配中心，但不是进程入口**（入口是 `platform/entry.ts`，分流后经 `platform/desktop-entry.ts` 才 `require('../main')`，见总述）。管单实例锁、主窗口 `BrowserWindow` 安全策略（`sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` / `webviewTag:false` / `navigateOnDragDrop:false`，打包版关 devTools）、注册 `xingmang://` / `xingmang-canvas://` / `xingmang-asset://` 三个特权协议、导航与外链白名单（I12；主窗口与画布各一张表，故意不合并）、显卡兼容模式要在 ready 之前定、装配全部服务并调 `registerIpcHandlers`。全仓最大的接线文件：新逻辑写成独立模块（多数做成「不含 Electron 依赖、由宿主注入」）再在这里接。启动回调正按子系统拆进 `bootstrap/`（#1070 第 5 步）：拆出去的启动步骤只在启动回调里直接调用、要收拾的东西交回 main.ts 登记退出清理，启动时各步的先后由 `main.test.ts` 按源码钉住；读 main.ts 源码核对接线的测试经 `bootstrap/main-source.test-support.ts` 连同 `bootstrap/` 一起读
- `main-service-options.ts` — 把同一份 `CodexHomeContext`（用户主目录、`CODEX_HOME`、Codex 环境变量）一次派生成 system / sessions / backups / 扩展 / 诊断各服务的根路径，保证各服务对「Codex 配置在哪」答案一致；只有 `main.ts` 用
- `window-lifecycle.ts` — 点关闭时的决策：按「关闭行为」偏好缩到托盘 / 退出 / 询问（可「记住选择」），托盘不可用时不藏窗；退出前只问一句（有安装在跑就拦，或问要不要顺手装已下好的更新），选了装更新先置 quitting 再拉安装器，免得被自己再拦一遍
- `bootstrap/lifecycle.ts` — 退出清理清单：`main.ts` 只挂一个 `will-quit`，各处用 `quitCleanup.add(名字, 步骤)` 按登记先后排进来，退出时挨个跑、整个退出只跑一次；某一步抛错只记日志（`app.quit-cleanup.failed`，带步骤名），后面的照跑。顺序由 `main.test.ts` 按源码钉住（加速服务在独立加速进程之前），新加一步登记在它该在的位置，别再另挂 `will-quit`
- `bootstrap/ai-services.ts` — 按账号站点分开的 AI 工作区（#1070 第 5 步从 main.ts 原样搬出）：`createRealmBusinesses` 给星芒账号、历史账号各建一份聊天、画图、视频、画布运行、作品存储和缩略图，第一次用到那个站点才建，之后一直用这一份；画布运行的订阅挂在每个站点上，后建的站点也补挂。main.ts 用 `createRealmServiceDispatch` 把当前站点那份交出去。生成缩略图、缩小聊天里贴的截图都用 `nativeImage` 在主进程里做
- `bootstrap/acceleration.ts` — 本机加速的接线（#1070 第 5 步从 main.ts 原样搬出），按启动时建的先后三段：`createAccelerationRouting` 建下载线路（装 CLI、下 Node 时临时走加速，用一个只给下载用的网络分区，默认会话不动）和打开 Codex 桌面端时替他连一次的加速、启动线路，系统服务要用，所以最早建；`createAccelerationHost` 拿启动一开始读好的加速文件建宿主（辅助进程、内核、系统代理都归它管，各种失败的原因写进日志），建好马上把上次崩溃没改回的系统代理改回去，安装包里本该有的加速文件读坏了记成「文件坏了」，好让加速页叫客户去看杀毒软件；`createAccelerationServices` 建加速服务、时长快用完和加速中断的系统通知、加速页和托盘看到的那一套（软件替他在后台连的那一次在这套里看不见）。睡眠唤醒（只在有宿主时挂）和退出清理留在 main.ts
- `bootstrap/network-routes.ts` — 星芒自己连站点的几条路和两套线路（#1070 第 5 步从 main.ts 原样搬出）：`createNetworkRoutes` 建应用线路（`relay-route-controller.ts`）、代理软件不转发时改走的直连会话和只跟随系统代理的探测会话（`proxy-bypass.ts`）、按线路走的几种 fetch、工具线路（`tool-route-controller.ts`）和线路状态文件，建完就开始查应用线路；`startToolRouteFollowing` 在系统服务建好以后才挂上工具线路的监听、开始查工具线路，并在唤醒和网络恢复时两套一起重查。退出清理照旧由 main.ts 登记
- `bootstrap/diagnostics.ts` — 检查页和反馈报告（#1070 第 5 步从 main.ts 原样搬出）：`createDiagnostics` 交出 `diagnosticsService`（健康诊断、一键处理、连接自检、Codex 实测、诊断导出），它的 `attachFeedbackDescribers` 给反馈报告挂上「工具环境」「运行环境」「自检结果」三段，只读诊断和扫描上一次留下的结果，生成报告不重跑探测。导出和反馈报告都把本机写着的几把 Key 当敏感值剔掉（I13）
- `bootstrap/accounts.ts` — 两个账号站点的登录记录和账号客户端（#1070 第 5 步从 main.ts 原样搬出）：`createAccountStorage` 按系统能不能加密选登录记录的保管（Windows、macOS 不能加密就拒绝登录，Linux 只留本次运行），`createAccountClientFactory` 给 `createRealmAccountService` 建每个站点的客户端（星芒账号 new-api、历史账号 Sub2API），账号请求按线路走、经系统代理没走通时改直连重发。换账号、退出时各服务怎么收拾留在 main.ts
- `bootstrap/updates.ts` — 主程序自己的更新（#1070 第 5 步从 main.ts 原样搬出）：`createUpdateFeed` 开机定用包里那份还是直连那份更新目录（只有标准 Windows 正式版有直连那份，跟着星芒账号这会儿的线路选），Windows 上顺带装严格的代码签名校验；它的 `createUpdater` 在版本记录、待装记录读好以后建更新服务和更新目录上的服务状态文件监视器。打开时装、退出时装牵着窗口和退出流程，留在 main.ts
- `quit-blocking-tasks.ts` — 判断哪些排队任务值得在退出前拦一下：只有安装类（CLI、Node/Python/Git、Codex 桌面端、三个外部客户端），因为打断虽不留半成品（I11 原子替换）但白下；启动、卸载不拦。与 `install-keep-awake.ts` 认的是同一批，两边要一起改；另给自动更新算「退出时能不能装」
- `window-preferences.ts` — 窗口尺寸与缩放的纯函数：UI 设计宽度、自动缩放上下限（v4 起最低 0.9、用户 90% 再低一档但不低于 0.85）、按显示器工作区算初始位置、拔掉显示器后的找回坐标、窗口状态的解析；`app-settings.ts` 与 `platform/zoom.ts` 共用
- `window-presentation.ts` — 窗口外观与对用户的几句话：Windows/Linux 标题栏覆盖层高度与配色（legacy 36 高 vs v4 并进 44 高顶栏，`platform/renderer-v2.ts` 切到 v4）、启动失败的中文兜底句、资源右键菜单失败弹框、各平台窗口图标文件名
- `window-recovery.ts` — 窗口停在已拔掉的显示器上时挪回主屏居中（最大化的先还原再挪再最大化）；只在马上要显示时调，对隐藏窗口 `unmaximize()` 在 Windows 上会把它顺手显示出来
- `window-responsiveness.ts` — 页面卡死时弹「等待 / 重新加载」，页面自己缓过来就把弹框收回且绝不重载
- `renderer-crash-recovery.ts` — 页面进程被回收或崩溃后：一分钟内前两次自动重载，第三次改为问用户（画布窗口不问、停在空白等用户重开）；主窗口与 `canvas-window.ts` 共用
- `renderer-release.ts` — 主窗口缩在托盘里满 10 分钟就关掉界面进程省内存（`forcefullyCrashRenderer`，窗口本身留着），点托盘或别的入口叫出来时按原地址重新加载。界面没报告过忙闲（legacy 回滚版）、报告手上有事（聊天在生成、视频在做、工具在装、开着对话框）、主进程在退出 / 装东西 / 付款窗口开着时都不关；关着和重新加载那一会儿，托盘、系统通知、深链要的跳页先存着，新界面第一次报告时再发（`platform/renderer-delivery-bridge.ts` 给 platform 那边的「打开某页」用同一条路）。那一声「界面进程没了」由 `main.ts` 的崩溃处理认出来不当崩溃
- `released-renderer-watch.ts` — 界面关着时替它做两件后台事：每 10 分钟读一次余额（托盘、余额与花费提醒照旧），看缓存的公告，有界面没见过的新公告或者有充值活动（每天一次）就把界面叫醒，让它照旧弹公告
- `balance-alerts.ts` / `spend-spike.ts` — 「余额低于 5 美元」和「花费突然变多」两个系统通知（原来在界面里，搬到主进程界面关着也照常提醒）：每次读回余额都过一遍，花费突增掉够了再读一次用量核账；同一账号 6 小时内只提醒一次的记录写在 userData 的 `spend-spike-notified.json`
- `empty-balance-alert.ts` — 「当前账号余额是 $0」那条通知的判断和记录（主路卡点 F2，Codex 没有出错钩子，只能看余额）：钱包 ≤ 0 且确定没有能扣的订阅才算用完，订阅还没读到不下结论；同一账号同一次用完只说一次，记在 userData 的 `balance-empty-notified.json`，读到有钱就抹掉
- `display-compat.ts` — 显卡进程短时间内连崩几次（老集显、远程桌面、虚拟机）就记进 `display-crashes.log`，下次启动这一次自动改用不走显卡的兼容模式并告诉用户；必须在 app ready 之前决定
- `context-menu.ts` — 主窗口的编辑右键菜单（剪切/复制/粘贴/全选，照 Chromium 的 editFlags 置灰）；链接只给「复制链接」不给「打开」，免得绕开 `will-navigate` / `setWindowOpenHandler` 白名单（I12）
- `process-stream-errors.ts` — 吞掉 stdout/stderr 的 EPIPE：开发时关掉控制台后 Electron 往断管写日志不该把主进程打崩，其他错误照抛

## 启动失败与崩溃
- `startup-log.ts` — **最后一道日志**：正常日志栈起来之前的失败同步写进 `logs/startup-failure.log`（与运行日志同目录，免得被轮转冲掉）；只依赖 Node 内置模块和无依赖的 `redaction-patterns.ts`，因为它记录的失败可能正是 command-runner、safe-local-data 或 Electron 本身加载失败。`redactHomeDirectory`（含 Linux 的 /home、/media、/run/user 打码）定义在这里，`runtime-log.ts` 转导出（I13）
- `startup-failure.ts` — 启动出错时给小白看的弹框：按 errno 链分成磁盘满 / 被杀毒软件占着 / 安装不完整 / 其他，原文只在点「复制错误信息」时出去且先抹用户目录与密钥（I13）
- `unexpected-exit.ts` — 主进程未捕获异常时不弹 Electron 的英文框：记一笔、自动重开一次，下次打开用中文说明并给「复制给客服」；10 分钟内已重开过就不再重开，避免窗口一闪一闪
- `crash-report.ts` / `crash-reporter.ts` — 崩溃自动上报 Sentry。前者全是纯函数（DSN 校验只认 `*.ingest.sentry.io`、脱敏、事件与 envelope 构造、开关判定），后者负责发送（按会话去重限量、超时、拒绝重定向、读回包限量，I10）。没用 `@sentry/electron`；开关是 `AppSettings.crashReporting`，缺省开，环境变量可关

## 诊断、日志与反馈
- `diagnostics.ts` — **「检查」页的总入口**：`runDiagnostics` 先建一份共用上下文（`diagnostics-context.ts`），再按固定次序把下面几类检查排起来同时跑（每项单独限时，超时或出错只算这一项，报告里的文字一律再脱敏一遍），收尾时做两处跨项调和（证书那项跟着网络那项、Node.js 那两项跟着有没有装命令行工具），再数各档多少项。报告的类型、`DiagnosticsDependencies`（缺省实现和测试替身的注入口）、检查页「打开文件夹」的名字也在这里。#1070 第 9 步把各类检查按类别拆进了下面几个 `diagnostics-*.ts`，它们只 import 这里的类型；原来从这里导出的名字照旧从这里转出，调用方不用改
- `diagnostics-context.ts` — 一键检测各类检查共用的那一份上下文（#1070 第 9 步从 `runDiagnostics` 开头原样搬出）：`createDiagnosticsContext` 把依赖解析成实际用的那一份（测试替身或缺省实现），先把各家工具配置读一遍（下线的 Gemini 也读，好在报告里遮掉它的 Key），给出脱敏用的 `sanitize` 和能复用首页扫描就不再探的 `inspectTool`；问工具装没装、是哪一版的缺省实现（Windows 上只跑可信的高完整性路径，I2、I14）、错误原因串、线路名也在这里。各类检查都只拿这一份；它只 import `diagnostics.ts` 的类型，免得两个文件互相 require
- `diagnostics-redaction.ts` — 检查报告的脱敏和导出（#1070 第 9 步从 `diagnostics.ts` 搬出）：`createDiagnosticsExport` / `redactDiagnosticText` 导出前替换已知 Key 值、密钥样式、URL 与用户目录，导出时邮箱半遮（I13）；各类检查在报告里写路径、网址用的 `pathForDisplay` / `safeUrlForDisplay` 也在这里
- `diagnostics-system-checks.ts` — 一键检测里「系统与权限」那几项（#1070 第 9 步从 `runDiagnostics` 原样搬出，`buildSystemChecks`）：星芒版本、操作系统（`operatingSystemSummary` 把内核号说成 Windows 11、macOS 15、Linux 发行版）、Windows ARM 电脑芯片、运行权限（是不是以管理员身份在跑、这个账号能不能提权，启动时那次探测没问出来时照实说）、打开工具用的命令窗口（Windows 的 PowerShell 只认固定解析器给的可信路径，I14；Linux 的终端程序）
- `diagnostics-tool-checks.ts` — 一键检测里「运行环境与工具」那几项（#1070 第 9 步从 `runDiagnostics` 原样搬出，`buildToolChecks`）：Node.js、它自带的安装组件、Python、Git、各家命令行工具和 Codex 桌面端装没装、是哪一版（Codex 桌面端单独探时用的 PowerShell 脚本先按名字导入模块），各家工具连接设置是不是连到当前账号（导出的报告里另写工具配置走的是哪条线路、Codex 后台常驻开没开）；一个命令行工具都没装时 Node.js 那两项降成「需留意」（`reconcileNodeRuntimeWithClis`）
- `diagnostics-network-checks.ts` — 一键检测里「网络与代理」那几项（#1070 第 9 步从 `runDiagnostics` 原样搬出）。`buildNetworkChecks`：星芒 AI 网络（向当前站点本来就回 JSON 的公开状态接口 `relayStatusProbeUrl` 发一次请求，认出断网、超时、门户拦截、服务端出错；「自动」先走的那条没查通就改查备用那条并报给线路那边；顺带拿 Date 头比一次系统时间）、安全证书（用跑工具的那个 Node.js 握手两次，见 `certificate-trust-probe.ts`）。`buildProxyChecks`：Clash Verge Rev 的全局接管模式（读配置限大小、YAML 限别名展开）、电脑里的代理设置（Windows 上看本机端口开没开、能不能一键清掉，另问 Chromium 星芒自己走不走系统代理）。两段分开是因为它们在报告里不挨着
- `diagnostics-storage-checks.ts` — 一键检测里「磁盘与文件夹」那几项（#1070 第 9 步从 `runDiagnostics` 原样搬出，`buildStorageChecks`）：磁盘空间（工具安装目录、软件数据目录所在的盘还剩多少，同一块盘只说一次）、「文档」文件夹能不能写（只在 Windows 上查，写不进时新项目和 AI 作品改放个人文件夹）、AI 作品保存位置、加速用的文件是否完好、文件夹位置（「C 盘搬家」留下的联接：普通权限运行时跟过去读写、只报一句搬到了哪块盘；管理员身份运行或搬到网络盘、共享位置的照 I8 不写，标红）
- `diagnostics-override-checks.ts` — 一键检测里「电脑里另外设过的设置」那几项（#1070 第 9 步从 `runDiagnostics` 原样搬出，`buildOverrideChecks`）：环境变量里另外设的工具地址和密钥（哪些会盖过当前账号、哪些指的就是当前账号用 `environmentAccountBaseUrls` 判；Mac 上连终端设置文件一起看，Windows 上用户级的能一键清掉，名单 `environmentOverrideNames` / `clearableEnvironmentOverrides` 给 `diagnostic-fixes.ts` 对照；写错被忽略的 `CODEX_HOME` 单独说）、项目文件夹里的设置（`workspace-config-overrides.ts`）、Codex 文件夹里的 `.env`、Claude Code 跑命令前问不问、个人文件夹里早先留下的项目说明和信任设置
- `runtime-log.ts` — 运行日志 `RuntimeLogStore`：`logs/runtime.jsonl` 带归档轮转、写入排队、写失败先缓存；每条按 key 名脱敏（apiKey/token/cookie…）+ `redactCommandText` + 截长（I13）；反馈报告头部的环境、自检、主机、账号几段由宿主注入描述函数拼进来；启动时把 `startup-log.ts` 攒下的失败并进来
- `redaction-patterns.ts` — **全仓唯一的密钥样式表**（Bearer、sk-、AIza、xai-、GitHub/GitLab 令牌、URL userinfo、带凭据的命令行参数与查询参数），日志、诊断、崩溃、反馈的脱敏都用它；故意零 import（startup-log、crash-report 记录别的模块失败时也要能用），渲染层也值引用（I13、I6）
- `request-diagnostics.ts` — 给一次账号请求的回应 / 错误挂上走的线路、HTTP 状态码、new-api 请求编号和 cf-ray，`ipc.ts` 记日志时取出来，给客服和服务端查单；挂在 WeakMap 上不改错误对象的样子，编号按白名单正则过滤（回应头外部可控），不带地址、令牌、Key（I13）
- `diagnostic-fixes.ts` — 「检查」页「点这里就好」的三个修复：把 Codex 文件夹里的 `.env` 改名留在原处、把主目录里星芒生成且没动过的 AGENTS.md 挪开、用 PowerShell 清掉用户级的工具环境变量覆盖（名单来自 `diagnostics-override-checks.ts`，整台电脑那份只报不改）；改名前过 I8 检查
- `feedback-environment.ts` — 反馈报告里「工具与配置」那段的纯函数：每个 CLI、外部客户端、运行时装没装、什么版本、怎么装的、配置是否指向当前账号、走哪条线路；只读已有快照、不触发扫描，不写 Key、地址和站点名（I13）
- `feedback-self-check.ts` — 反馈报告里「最近一次自检」那段的纯函数：只读内存里上一次「检查」页结果和连接自检，不重跑、不发请求，刻意不带 endpoint / siteId（I13）；三个状态词与检查页一致
- `broken-config-advice.ts` — 读不懂原配置、星芒没敢改时给客户的那句（哪里坏了、星芒没改、去配置窗口「高级」点「重置为初始状态」，会先备份）；`config-files.ts` 与 `codex-extensions.ts` 用
- `toml-error-location.ts` — TOML 解析错误只留「第 N 行附近」：`@iarna/toml` 的原文会引用 `api_key = "…"` 那几行，而错误会上屏、进日志和反馈导出（I13）；写 Key 与管 Codex 技能/MCP 两处共用这一条规则
- `cc-switch-leftover.ts` — 认出 CC Switch 留在 CLI 配置里的痕迹（密钥占位 `PROXY_MANAGED` 的本地代理接管，或装过它且配置里有来源未确认的 Key），只判断不改，改不改由用户在首页点；只看 `~/.cc-switch` 在不在，链接不算（I8）；`system-service.ts` 用

## Windows 提权与可信路径（本项目真正的复杂度所在，见 AGENTS.md 第 4 节）
- `windows-elevation.ts` — **提权边界的核心之一**（I2、I14）：判定执行模式 `trusted-only` / `same-user`（完整性级别低于 High 直接 same-user；探测失败且标签也读不出时按 same-user，是 2026-09-23 的产品取舍）；由固定解析器给出 PowerShell 绝对路径（不查 PATH、不读 COMSPEC）；PowerShell 字面量转义（连弯单引号一起转，防路径提前闭合字面量）与 `-EncodedCommand` 编码；终端里启动 CLI 的启动计划、错误翻译、以普通权限开命令窗口。被二十多个模块引用
- `windows-machine-paths.ts` — **I14 的根**：从已加载的 ntdll/kernel32 路径与 `\\?\GLOBALROOT\SystemRoot` 推出真实 SystemRoot（不信环境变量），Program Files / ProgramData 从注册表读、读不到再问 PowerShell；`isTrustedWindowsMachinePath` 用 ACL 快照判定「低于 Administrator 的主体写不进来」，结论短时缓存并可异步预热（避免每次 trusted-only 执行都同步起 PowerShell）；`command-runner.ts` 重建机器级 PATH、`trusted-temp.ts` 等都靠它
- `relocated-folders.ts` — **I8 唯一登记的例外**「C 盘搬家」：只在 `same-user` 下跟随用户主目录本身、其上级或其内部、指向本机盘符目录（Mac/Linux 是只有 root 与本人能改的目录）的联接，换成实际位置后再照原样严查；`trusted-only` 和执行模式还没定时一律不跟。safe-local-data、bounded-file 等十多处读写都经它
- `path-identity.ts` — `sameLocalPathIdentity`：跨平台判断两个路径是不是同一个东西（Windows 逐级比 dev/ino/mode 且不分大小写，Mac 认 /var、/tmp、/etc 的 /private 别名）；可信路径、卸载、资产存储等二十多处用它而不是字符串比较
- `windows-cli-shell-access.ts` — 让客户自己的终端能直接敲 `claude`：删掉 npm 生成的 `.ps1` 启动文件（Windows 默认执行策略会拦它，删了 PowerShell 就落到 `.cmd`，不用放宽执行策略），只认 cmd-shim 指向本包的那份；装完把 npm 目录加进用户 PATH、卸空后撤掉。提权令牌下只碰管理员所有的托管目录，用户可写目录一律不动（I8）；Mac/Linux 的对应动作由宿主注入
- `windows-live-path.ts` — 读注册表里整台电脑 + 当前账号的 PATH（异步 reg.exe），拼出「现在新开终端会拿到的」PATH；只给推 Grok 跑钩子用哪个 shell、从星芒打开 Grok 时补新段用，不改 `process.env`，不进提权路径解析
- `windows-processor.ts` — 认出 ARM 版 Windows：x64 星芒在 ARM 上被模拟时 `process.arch` 和本进程环境变量都报 x64，只有注册表里机器级的那份说真话；另读 PE 头判断某个 exe 是哪种架构，据此选 Node.js 安装包架构；诊断与 `system-service.ts` 用
- `windows-store-availability.ts` — 问「这台电脑有没有微软商店」（LTSC、精简版、组策略关掉的都没有），只有确定没有时才跳过商店那条安装路；`codex-desktop-service.ts` 用。原名 `windows-store-app-launch.ts`，原先的「内置 Administrator / 关了 UAC 可能打不开」判断已于 2026-10-02 撤掉，文件头写了恢复它的前提

## 加速（Windows 与 macOS；只接管系统代理、不开 TUN。文件名里的 `development` 是历史名字，正式包也走这一套，链路见总述）
- `acceleration-service.ts` — **主进程里加速的唯一门面**：把后端包成按账号 scope 排队的服务，记住「这次是谁连的」（用户点的 vs 打开 Codex 桌面端时软件替他连的 `autoStartedBy`，后者不进 `AccelerationApi`，渲染层冒充不了），状态变化推给托盘与提醒；`createUserAccelerationApi` 是给 IPC 的那半边，看不见软件替他连的会话；Windows 关机时据 `hasPossibleSession` 推迟关机先还原代理
- `acceleration-contract.ts` — 加速的跨进程类型与常量单一来源（免费时长、到期提醒秒数、冲突种类、失败原因的封闭集合与中文文案、线路 id 校验）；失败与冲突只传封闭的枚举、文案由渲染层持有，细节进不了屏幕和日志（I13）；渲染层与 `ipc-contract.ts` 都引用，必须保持无 Node 依赖（I6）
- `acceleration-development-host.ts` — 主进程侧的辅助进程宿主：正式包用 `spawn(process.execPath, ['--xingmang-acceleration-worker', 独立 user-data-dir])` 拉起一个分离的 Electron 主进程（父进程没了它还能活到把系统代理还原，又不用开 RunAsNode 熔丝），开发版用 `fork`；环境走 `trustedCommandEnvironment` 并删掉 `ELECTRON_RUN_AS_NODE`（I2）；辅助进程被杀后自动重拉一次去还原、按退避重试、闲置自动退出；也读开发版的本机加速配置与恢复日志路径
- `acceleration-development-worker.ts` — 辅助进程本体（无导出，由 `platform/entry.ts` 在 worker 模式下 `require`，开发版被 fork）：持有 mihomo 内核与系统代理租约（`proxy-lease.json`），按队列串行执行，父进程 IPC 断开即还原代理，还原失败按退避重试；只在 win32/darwin 初始化
- `acceleration-development-backend.ts` — 加速的业务后端（在辅助进程里跑）：本机免费时长账本（按账号、单调钟计时、读坏要抛错，因为这是真金白银）、会话状态机、到期断开、睡眠冻结计时、下载专用线路的持有计数、连接失败归到封闭的阶段名（不带路径和代理细节跨进程，I13）；软件替用户连的那次不计时，停下后内核多留一会儿让正在流式返回的回复写完
- `acceleration-mihomo-runtime.ts` — 起停 mihomo 内核：把核过 SHA-256 的内核复制进私有会话目录再 spawn（`trustedCommandEnvironment`，I1/I2），生成隔离配置、随机控制端口与密钥，经内核探测线路可用性；会话目录清扫只碰本进程没在用的，读写都走 safe-local-data / bounded-*（I8）
- `acceleration-clash-config.ts` — 内置节点文件（Clash YAML）的解析与内核配置生成：只收内联 hysteria2 节点、拒绝别名和远程订阅，生成的配置 `tun` 关、IPv6 关、局域网与内网 IP 直连（#1058，不把内网流量送去海外节点）、星芒自己的站点直连；节点凭据只留在主进程侧，不进诊断与 IPC
- `acceleration-bundled-config.ts` — 正式包读 `resources/acceleration/` 里的清单、内核与节点：文件名是常量、SHA-256 要与 ASAR 内包元数据钉住的值一致才启用，读不通报「内置加速资源无效」（界面据此说「被杀毒软件隔离」）；外部清单单独存在不能开启加速
- `acceleration-worker-profile.ts` — 辅助进程每次连接前重新读节点：记在本机、签名对的在线节点优先，否则读安装包里的节点文件，核对完整性后再解析（防启动后被替换）
- `acceleration-online-nodes.ts` — 在线换节点：主进程开机读一次、之后每小时读一次更新目录里的 `acceleration-nodes.json`（超时、256 KB 上限、拒绝重定向，I10），用发版那把 Ed25519 钥匙验签（签的字有自己的开头，跟更新包的签名不能互换），比记下的新才原样写进 app data；辅助进程读的时候再验一遍。签名不对、比记下的旧都不收，撤回也要签名。发布脚本 `scripts/acceleration-nodes.cjs`、工作流 `acceleration-nodes.yml`
- `acceleration-binary.ts` — Mac 上 spawn 前核对内核是本机架构的 Mach-O 可执行文件（不收胖二进制、截断的加载命令表直接拒），打包脚本 `scripts/stage-acceleration-bundle.cjs` 也用
- `acceleration-electron-profile.ts` — 给辅助 Electron 进程一个独立的临时 user-data-dir（各自的 Local State / OSCrypt 密钥，不和桌面进程抢配置），用完只删自己那个并先核对目录身份
- `acceleration-worker-entry.ts` — 辅助进程启动开关 `--xingmang-acceleration-worker` 的识别：必须带父进程 IPC 通道且在 win32/darwin 才进 worker 模式，否则直接退出、绝不打开桌面；`platform/entry.ts` 最先调用
- `acceleration-conflict.ts` — 连接前只读检查别的代理软件、PAC、VPN 虚拟网卡是否占着系统代理（Windows 读 WinInet 标志与网卡名，Mac 跑 `/usr/sbin/scutil --proxy`），结论交给用户决定，不替他关
- `acceleration-preference-store.ts` — 按账号落盘用户在加速页亲手选的线路与模式（不是上次实际连上的那条），托盘「连接加速」和打开 Codex 桌面端时的自动连接都读它；读坏了就当没选过、绝不抛错
- `acceleration-expiry-notice.ts` — 免费时长快用完与到点自动断开各发一条系统通知：用户打游戏时窗口缩着、渲染层计时停了，所以放在主进程到点去读一次状态；不自己停加速，「已断开」只认 exhausted
- `acceleration-interruption-notice.ts` — 不是用户点的断开（内核自己退出、辅助进程被杀毒软件结束）时推托盘与页面到「已断开」并发通知；还原网络不在这里做，只说事实（确认停了才说「网络已恢复」）；软件悄悄替他连的那种断了且网络已改回，只记日志不提醒
- `acceleration-power.ts` — 睡眠与醒来：睡着的那段不计免费时长（Windows 单调钟睡眠照走、Mac 停表，两边相反），睡前冻结、醒来扣掉再看加速还在不在，不在就走意外断开那条路；不重连也不主动断开
- `download-acceleration.ts` — 下载期间的临时加速：装 CLI / 下 Node 前悄悄拉起内核只拿本机回环端口，不写系统代理；用户自己开着加速就不插手，起不来就按没加速继续，只接受回环端点（跨提权边界的 npm 子进程会拿到这个地址）；不计免费时长

## 网络与代理
- `network-failure.ts` — **网络失败的唯一分类与中文文案**（离线、DNS、TLS、证书日期/系统时钟、代理、拒绝、超时、门户拦截、服务维护）：主进程抛错和记日志用它，渲染层用 `matchNetworkFailureMessage` 认出原句上屏，文案只有一份；进渲染包，永远不许依赖 node/electron（I6，门禁在 `scripts/verify-renderer-boundary.test.cjs`）
- `proxy-bypass.ts` — 系统代理指着一个已经不在或不转发星芒的代理时的兜底：先等几秒再看，还不通才把星芒自己的会话改直连，之后定期回看、代理恢复就改回；只让连星芒站点的请求（账号、余额、AI、连通检查）走专用直连会话，装工具、拉插件照旧跟随系统代理（#741）；回网页或 3xx 的算「被别人答了」（#1064）；只改本进程会话、不碰电脑代理设置、不落盘；星芒自己的加速开着时不插手
- `response-body-watch.ts` — 把回应正文包一层，读到一半出错时报给线路判断那一侧，同时原样保留 `url` / `redirected` / `type`（调用方靠它们拒绝被重定向的请求，I10，不照抄等于拆掉那道检查）
- `download-proxy.ts` — 把 Chromium 对某个 URL 解析出的代理（含 PAC）变成两种形状：给 Electron 网络栈的端点、给 npm 子进程的代理环境变量；主机名严格校验，跨进程的只收回环地址
- `download-retry.ts` — 大安装包（Codex 桌面端、Node.js、Git、Python、外部客户端）下到一半断了先在同一条线路续传：首个回应仍过调用方的校验、续传必须与声明的字节范围和总长完全一致、每个字节照旧进调用方事后核对的同一个 SHA-256；一个字节都没下到的、用户取消的不重试
- `network-location-cache.ts` — 合并并缓存「网络位置」（境内/境外，决定安装源顺序）的探测：显式刷新会让旧的在途结果作废重读；`system-service.ts` 用

## 托盘
- `application-tray.ts` — 系统托盘与右键菜单：账号、余额与订阅剩余、已装工具一键打开、加速一行、更新一项、「暂不让电脑自动睡眠」提示（已知35）；打开菜单时现读一次会过期的状态，不定时轮询；Linux 上有没有托盘由 `linux-tray-host.ts` 先问
- `tray-acceleration.ts` — 托盘里加速那一行状态与连接/断开动作的纯逻辑：不新增第二条连接逻辑（走加速页同一条路、用落了盘的线路偏好）、不新增轮询（剩余时长只按读到的时刻往前推算来显示）、失败不弹窗只换一句短原因

## 更新与发布
- `updater.ts` — **星芒自身更新的服务层**（包 electron-updater）：更新快照状态机（按检查/下载/安装哪一步失败说话）、强制最低版本与放量/撤回闸门、回退下限版本、下载前磁盘预检与停滞看门狗、改直连重试、失败原因中文化、Linux deb 交系统安装器；`UpdateSnapshot` 经 `ipc-contract.ts` 进渲染层，所以这里不许依赖 node:fs（T9）
- `update-package-signature.ts` — Windows 安装包没有 Authenticode，`latest.yml` 又和安装包同桶，拿到桶上传凭据就能连 SHA-512 一起换；所以每个清单条目再带发布者 Ed25519 签名（版本号也进签名，防旧包冒充新版），公钥钉在本文件、私钥只在 GitHub `release` 环境；发布脚本按两个标记读这张公钥表。只在未签名通道的 Windows 上启用（Linux deb 清单还没签）
- `update-signature.ts` — Windows 上替换 electron-updater 的签名校验：用固定路径的 PowerShell（I14）和 `trustedCommandEnvironment`（I2）严格比对 Authenticode 发布者 DN，只靠 CN 对上时记警告；`main.ts` 只在 win32 安装
- `update-package-digest.ts` — 下载完的更新包重算 SHA-512 与清单比对（base64 / hex 都认），同一个文件描述符读完、限大小；任何没法比对的情况都抛错，绝不把没验过的当成验过
- `update-feed-route.ts` — 更新源的线路：标准 Windows 正式版在账号走直连线路时改用直连镜像（同一批文件、同一份撤回清单），自定义源与通道不动，不从账号 URL 派生、不带凭据；配置文件读取限大小
- `update-request-guard.ts` — 从外面补 electron-updater 6.8.9 在 Electron 43 上的三个缺口（请求超时不生效、增量下载停住不认取消、多段回应没挂 error 监听会变成主进程未捕获异常）：跟踪每个请求、给看门狗打时间戳、需要时全部中止
- `auto-update-install.ts` — 「自动更新」下好的版本什么时候装：只在用户自己退出时、或下次刚打开时，每个版本各只自动试一次（先落盘「试过了」再装，防安装器起不来造成一开就关的死循环）；Windows 非管理员账号不自动装；记录读坏就当没有，最多少装一次
- `update-install-prompt.ts` — 这次运行里在后台下好的新版本先跳框问要不要现在装（默认按钮「稍后再说」，等几秒没人打字再弹，每个版本每次运行最多问一次）；没装的 Mac 在装的时候不弹窗口时，等电脑 10 分钟没人碰或锁屏、窗口都缩着、没在装工具、工具没在干活、加速没开时自己装，借打开时装那条「试过了」记录每版只试一次；不含 Electron 依赖
- `installed-release.ts` — 「这次启动是不是刚更新完 / 这一版改了什么」：记住上次运行的版本，升了就带一次性标记，更新说明读打包时写进的 `dist-electron/release-notes.json`（断网也能显示）；装回旧版不算更新
- `update-state-log.ts` — 更新状态那条日志只在阶段、版本、错误变了或下载进度跨过 10% 一档时才记，免得一次下载刷掉反馈报告里的几百条（第二十六批 B）
- `app-download-page.ts` — 星芒安装包手动下载页的唯一常量，自动更新走不通时给的退路；主进程外链白名单与渲染层都读它（I12 全等匹配），所以零运行时依赖

## 设置与本地数据
- `app-settings.ts` — 应用设置 `settings.json` 的类型、默认值、解析、合并与原子写入（读写走 safe-local-data，I8）：主题、缩放、关闭行为、下载源顺序、线路偏好、Codex 汉化等；新字段遵守「缺省 = 旧行为」，启动时只在格式真变了才重写；被 main、ipc、system-service、画布窗口等十来处引用
- `data-transfer.ts` — 「搬到新电脑」导出/导入文件：当前账号的聊天对话 + 几项跟人走的设置，刻意不放 Key、密码、登录态、保存的账号、CLI 配置和本机路径；导入前给出逐项预览、版本更新的文件拒收
- `documents-fallback.ts` — 「文档」写不进去（受控文件夹访问、安全软件、Mac 上点了「不允许」，只认 EACCES/EPERM）时，新项目与 AI 作品改放到用户主目录；可写性靠真建一个随机名文件 `wx` 打开再删来判断，不跟预置的链接（I8）
- `starter-workspace.ts` — 替新手建工作文件夹：Windows 建在「文档/XingmangProjects/my-project」，文档被云盘同步或在 Mac 上时退到主目录；名字刻意用英文无空格，避免下游 CLI/npm/MCP 在中文或带括号的路径下出问题
- `disk-space.ts` / `disk-space-copy.ts` — 磁盘空间：前者 statfs 量剩余空间（目录不存在就往上退、同盘合并），定安装前门槛与检查页提醒线；后者是空间文案（无 Node 依赖，渲染层更新页与主进程系统通知读同一份说法）

## 工具库
- `running-tools.ts` — 换账号后哪几个 CLI / Codex 桌面端还开着（还拿着旧 Key 扣旧账号的钱），只对它们说「关掉重开」；渲染层直接用这里的文案函数，所以只许值引用 catalog 这类零依赖模块，真正的进程检测由调用方注入（I6）
- `active-identity.ts` — 主进程里的账号身份快照（站点、realm、userId、会话修订号）：发布结果或落盘前核对「还是不是发起时那个账号」，防止登出再登回同一用户后旧请求还能落地；不是 IPC 授权层，也只拷身份字段、不展开会话对象（免得以后带上令牌）
- `chinese-sentence.ts` — 判断一句报错本身是不是中文：先去掉引号内容和路径（中文用户名、「星芒AI管理工具.app」都在路径里）再看汉字；渲染层与 `updater.ts` 共用，所以零 import（I6）
- `async-map.ts` — 限并发的 `mapWithConcurrency`：目录扫描不用 `Promise.all` 一次发几千个 fs 请求，否则 libuv 一口气交回来照样卡住窗口；Codex 与四工具扩展扫描用
- `content-addressed-asset.ts` — 媒体资产的内容寻址 id（sha256 base64url，按输出根目录 + 账号 + 内容派生，跨账号不撞）；图片、视频、音频三个资产库共用
- `media-container-metadata.ts` — 不调外部程序、只解析字节读出 MP4/ISO-BMFF 的时长与分辨率和 WAV 时长，box 数量与边界都有上限；视频、音频资产库用
- `byte-range.ts` — 解析单段 HTTP `Range` 头，给 `xingmang-asset://` 协议回放视频音频（`ai-asset-protocol.ts`）用
- `symlink-capability.test-support.ts` — 测试专用：探测本机能否建真符号链接，I8 的链接防御用例据此门控；CI 上要求必须能建，丢了特权就红而不是静默跳过（#40）；`tsconfig.electron.json` 排除 `*.test-support.ts`，不进发布包
