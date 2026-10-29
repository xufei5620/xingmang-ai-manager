# 模块地图 · 主进程：CLI、桌面客户端与 macOS / Linux 平台

> 总述、三套跨进程通道和其他分册见 [`../MODULE-MAP.md`](../MODULE-MAP.md)。每个模块一句话，**一律以代码为准**；加了新模块在这里补一行。

## 工具清单与版本
- `catalog.ts` — **工具身份的单一定义源**：`providerIds`、`cliCatalog`（命令名、npm 包名）、各工具托管 Key 的分组与名字（`managedCliKeyProfiles`，历史账号那套后端另有一份）、写进配置的地址、配置目录名都在这里；下线的 Gemini CLI 在 `retiredProviderIds`，「替每个工具做点什么」一律走 `activeProviderIds`；新签密钥的「用户名-分组」命名（`buildAccountKeyName`）和 xm 站老分组名换新名的对照也在这。零依赖，是 `ipc-contract.ts` 唯一的值导出来源（I6），加第 5 个 CLI 从这里起步（T2）
- `cli-verified-versions.ts` — 四个 CLI 的推荐版本与已知坏版本区间：安装、更新默认装推荐版而不是 latest，因为这些 CLI 针对第三方地址的回归反复出现，客户一更新整条链路就断。零 Node 依赖，建议文案经 `ipc-contract.ts` 的类型进渲染层（I6）；名单怎么维护见 `docs/CLI-VERIFIED-VERSIONS.md`
- `cli-update-history.ts` — 每个工具最近一次更新「从哪版到哪版」，落盘在数据目录；更新后 14 天内首页多一个「退回更新前的版本」。读坏了当没记录，不挡别的
- `cli-model-defaults.ts` — 各工具新配时的默认型号、上一代、两站都已下架的型号三张表（Codex 默认 gpt-6-astra，gpt-5.5 在下架名单里）；服务状态文件的 `cliModels` 可以覆盖，读不到就用程序自带的。只 `import type`，渲染层老引导也引它
- `cli-model-hints-store.ts` — 把最近一次读成功的型号表记到本地 `cli-model-hints.json`（#1154 第 6 条），这次打开以后状态文件一次也没读成功过时用它；没写型号表的那次记成没有。读回来的内容用状态文件同一个解析器重新校验
- `versions.ts` — 版本号小工具：只认精确版本（拒 npm 范围、标签和像命令行参数的串）、Node.js 最低 20、新旧比较；主进程判断版本新旧只走这里的 `compareVersionNumbers`，更新器、上次运行记录、Node / Python 发布索引各自的认法是这里的几个 `parse*Version`（Codex 桌面端四段包版本除外，在 `codex-desktop.ts`）；零依赖，渲染层也直接引

## CLI 安装、定位与运行环境
- `tool-installation.ts` — **认「这个工具装在哪、从哪装的、怎么起」的核心**：分清 npm 包与官方原生安装器（首页据此写「官方安装器」还是「其他来源」）、能不能卸、新开和续聊的启动参数；`resolveCliCommand` 在起进程前核原生可执行文件（Windows 走 `trusted-native-cli.ts` 的签名与暂存，Mac 走 codesign 加 `darwin-cli-staging.ts`）。npm 装、更新这一步本身在 `cli-install-service.ts`
- `cli-install-service.ts` — **装和更新 CLI 的那一整段**（#1070 第 2 步从 `system-service.ts` 原样搬出，`createSystemService` 照旧对外给 `installCli` / `cancelCliInstall` / `cleanupInstallLeftovers`）：找 npm（Windows 上没有就先装 Node.js）、按网络挑源、解析和下载卡住就换源、国内镜像下的包要和 npm 官方源的 SHA-512 一致、托管 npm 目录整体替换（换不回去时报 `ManagedNpmRollbackError`）、Grok 的 Windows 原生通道和 Mac / Linux 的签名核对、装完 Claude Code 顺带装 Git、记更新历史，以及取消和清理下了一半的东西。Windows 提权安装、可信路径那几段只搬不改
- `cli-uninstall-service.ts` — **卸载 CLI 的那一段**（#1070 第 3 步从 `system-service.ts` 原样搬出，`createSystemService` 照旧对外给 `uninstallCli` / `cleanUninstallLeftovers`）：按安装来源定卸法（npm 包、官方安装器装的 Claude Code、Grok 原生程序，Mac 上先核 xAI 签名再删）、要用户自己跑的卸载命令开在不提权的窗口里、卸完核对命令真的没了、记下删不掉的文件供「帮我清理」用（路径只由这里给，不收界面传来的）
- `runtime-install-service.ts` — **装运行环境的那一段**（#1070 第 3 步从 `system-service.ts` 原样搬出，`createSystemService` 照旧对外给 `installNodeRuntime` / `installPythonRuntime` / `installGitRuntime` / `inspectWindowsProcessor` / `restartWindows`）：Node.js 认不得公司证书时换一份、Windows 上看处理器挑安装包（一次启动只问一次）、Mac 上弹苹果自己的 Git 安装窗口（一次只弹一个），装完补 Grok 钩子；有安装、卸载、打开在排队时不发重启。真正下载和核签名在 `node-runtime.ts`、`python-runtime.ts`、`git-runtime-install.ts` 和 Mac / Linux 各自那份；重启那段（`shutdown.exe` 走固定系统路径）只搬不改
- `provider-launch-service.ts` — **从星芒打开工具的那一段**（#1070 第 3 步从 `system-service.ts` 原样搬出，`createSystemService` 照旧对外给 `launchProvider`、`launchCodexDesktop` 和 Codex 桌面端中文界面、工作目录信任那几个）：打开前在保存配置那一队里补写目录信任和项目说明（敏感目录不写）、给 CLI 配环境（哪些变量这次不交给工具：`launchExcludedEnvironmentVariables`、Mac 的 `macosShellOverrideVariables`）、Windows 上核命令后开 PowerShell 窗口（管理员身份时终端环境以 `trustedCommandEnvironment` 为底，见 I2 的 `interactiveTerminalEnvironment`）、Mac 开「终端」、Linux 挨个试终端。Windows 提权那几段只搬不改
- `installation-queue.ts` — **I11 的实现**：安装、卸载、启动这类会原子替换机器级目录的操作排成一队，同一个 key 复用同一个 Promise（双击天然幂等），还在排队的可以随信号直接出队。外部桌面客户端的「打开」是登记过的例外，见 `external-client-runtime.ts`
- `install-cancellation.ts` — 安装的「取消」：每次安装一个可中止的信号，但原子替换那几段会「封住」，封着时拒绝取消并给出能上屏的中文原因，不默默吞掉；用户取消抛 `InstallCancelledError`，不进异常日志
- `managed-cli-paths.ts` — **托管目录只在这里定**：Windows 是 `ProgramData\XingMangAI`（从可信机器路径取，不读环境变量），Mac 是 `~/Library/Application Support/XingMangAI`，Linux 是 `${XDG_DATA_HOME:-~/.local/share}/XingMangAI`；npm 前缀、缓存、原生包、终端启动器、`Runtime/node` 都从它派生
- `managed-cli.ts` — 建托管 npm 布局（prefix、cache、空 userconfig），目录走 `trusted-temp.ts` 的受保护建法；上一次 npm 事务做到一半被打断时先把旧 prefix 恢复回来
- `managed-path-trust.ts` — 只在 Windows 上登记「本软件自己建、上过 ACL 的托管根目录」，`command-runner.ts`、`trusted-temp.ts`、`node-runtime.ts` 据此放行其下路径；按真实路径再核一遍，防联接把子路径指到外面去（I8、I14）
- `npm-user-prefix.ts` — 普通权限安装只从用户 `.npmrc` 读回 `prefix` 一项（照 npm 的 ini 解析与路径展开），显式传 `--prefix`；其余配置仍被空 `--userconfig` 挡在外面，用户的 `.npmrc` 改不了源和脚本策略
- `cli-native-package.ts` — npm 下平台可选包失败时照样退出 0，Claude Code、Codex 就成了「版本读得出、根本起不来」；这里查出缺的是哪个平台包，给一句中文（Linux 版 Grok 也用）。读已装包 `package.json` 版本号的 `readPackageManifestVersion` 也在这里
- `npm-registry.ts` — 两个 npm 源（官方、国内镜像）的地址、按网络区域谁先谁后（`npmInstallRegistries`，区域不明时镜像优先）、查询地址怎么拼，以及查询的超时和响应体上限；装、查新版本、卸载共用
- `npm-command-failure.ts` — npm 命令没成功时挑出给客户看的那句：命令运行器的话后面接 npm 自己的要点（错误码、占用、权限），超时说成「下载超时」；`isMachineBoundNpmFailure` 判断换个源也没用的那几种（盘满、正在用的目录被占用）。要用 `command-runner`，所以不跟进渲染层的 `npm-failure-reasons.ts` 放一起
- `cli-process-probe.ts` — 更新、卸载撞上文件被占用时，查是不是这个工具自己的进程还开着（只认镜像或命令行落在它自己包目录里的进程，不按进程名），好让报错说「先关掉它的窗口」而不是「被杀毒拦了」；Windows 走 PowerShell/CIM，Mac 走 ps
- `node-runtime.ts` — **Windows 上代装 Node.js**：在海外 winget 优先，国内或测不出位置时不试 winget（#1061 第5条）；下安装包时按网络区域定先走国内镜像还是官方 MSI，核 SHASUMS 与 Authenticode 签名；要管理员时由普通权限的中转脚本钉住当前账号再弹 UAC，提权那一步把包拷进只有管理员能写的目录再核一遍才交给 msiexec。下载源和下载件 Mac/Linux 版复用（两边都钉版本和校验值，不读版本索引和校验清单），`resolveSystemWingetExecutable` 也给外部客户端和 Python 用
- `python-runtime.ts` — Windows 上代装 Python 3.12：winget 优先，退到 python.org 安装包时才借下载线路，核 Authenticode 签名与响应地址
- `git-runtime-install.ts` — Windows 上代装 Git for Windows：**钉死版本与 SHA-256**（官方摘要只写在 GitHub 发布说明里，从镜像取摘要等于让镜像自己作证），Inno Setup 按当前用户装、不弹 UAC；升级时改文件里那三个常量
- `git-runtime.ts` — 缺 Git 会怎样、怎么装的**唯一文案来源**，插件市场、首页运行环境、检查页三处共用（Windows 上缺它 Claude Code 的 Bash 工具会退成 PowerShell）；零依赖，渲染层直接引
- `install-leftovers.ts` — 开机过一会儿清掉安装中途被打断留下的临时目录（一个就是几十到几百 MB）：只认星芒自己 mkdtemp 的前缀加 6 位随机串、放了 6 小时以上的，客户文件和 npm 默认缓存不碰
- `install-keep-awake.ts` — 装工具、装 Codex 桌面端、准备 Node/Python/Git、后台下载新版本时挡住系统自动睡眠（关屏、合盖照旧），按安装队列的 key 判断；托盘那行「暂不让电脑自动睡眠」跟着变

## 卸载与残留清理
- `native-cli-uninstall.ts` — **原生安装 CLI 的共用删除器**：只删卸载计划里点名、且身份（目录、文件、链接文本与指向）和核对时完全一致的那几项，删不掉的先改名隔离；Claude 原生版和 Mac/Linux 的 Grok 都走它（I8）
- `claude-native-uninstall.ts` — 卸载 Anthropic 官方安装器装的 Claude Code（`~/.local/bin/claude` 指向 `~/.local/share/claude/versions`）：只认版本号命名的文件；Windows 上 claude.exe 还开着时改得了名删不掉，照实交代并给出手动命令。口径见 `docs/CLI-NATIVE-INSTALLS.md`
- `uninstall-leftovers.ts` — 卸载没删干净时的「帮我清理」（已知48）：卸载那一刻在主进程记下手动命令里的文件和所在目录的身份，点了以后只删记下的那几个、删前再核一遍；界面只交工具名不交路径（I5）。Mac 上只在除 root 和当前用户外没人能改的目录里删
- `uninstall-cleanup.ts` — **Windows 卸载程序的收尾一支**：卸载程序删文件前用专用参数再拉起本程序，把系统代理改回去（加速辅助进程已被强杀，代理还指着没人听的端口会让整台电脑断网）、删开机项、收回四家工具配置里的钩子和状态行，勾了就清登录与聊天记录；跑卸载的不是桌面登录的那个人就什么都不动，结果按位写进退出码，从不让卸载卡住
- `uninstall-cleanup-entry.ts` — 上面那支的入口判定和两个参数名（与 `build/installer.nsh` 由 scripts 测试钉成同一个值）；刻意零 import，`platform/entry.ts` 每次启动最先读它，决定走桌面还是走清理

## Grok（Windows 原生包）
- `grok-installer.ts` — **Windows 版 Grok 的安装**：下 xAI 签名的 `grok.exe`（x.ai 与 GCS 两个固定源，响应地址逐个核），过 Authenticode 发布者校验才进托管原生目录；替换带事务清单，被打断了下次能回滚或补完。Mac/Linux 的 Grok 走 npm，见 `macos-grok.ts` / `linux-grok.ts`
- `grok-update.ts` — 问 xAI 现在的 stable 版本（固定两个地址、限跳转、响应 1KB 上限，I10），装的版本以 stable 为上限（`resolveGrokInstallVersion`）
- `grok-bucket.ts` — Windows 装 Grok 先从星芒腾讯云存储桶下同一个 xAI 签名的 `grok.exe`（`scripts/sync-grok-cos.cjs` 定时同步），清单里的大小与 SHA-256 绑住下载，签名核对不变；读不到、没有这一版、对不上就悄悄换回 xAI

## 写进 CLI 配置的附加项：钩子、状态行、型号
- `cli-hooks.ts` — 往四家 CLI 配置里写「开始 / 做完 / 出错 / 等你」钩子的那几行：Claude Code 用不经 shell 的 exec 形式，Gemini、Grok 只收整条 shell 命令、要按平台加引号，Codex 用 notify 数组；路径里有引号、`$`、反引号、`%` 或换行就干脆不写，绝不把安装路径交给 shell 展开（I1 的同类）。认得出、收得回本软件写的那几行
- `cli-hook-events.ts` — 读钩子脚本丢进数据目录的小文件，决定弹不弹「终端里没回上 / 做完了 / 在等你」的系统通知；那个目录用户可写，文件一律当敌意输入：固定文件名格式、单链接有界读取（I8）、字段白名单重建（I5），文件里的字一个都不进通知
- `cli-keep-awake.ts` — 终端里 Claude Code / Gemini / Grok 正在跑一轮时挡住系统自动睡眠，做完、出错、退出就放开，最多挡两小时；信号就是上面那套钩子记录。Codex 用它自己的防睡开关，不走这里
- `claude-status-line.ts` — Claude Code 状态行：随包脚本的定位、命令拼装（两段路径都加引号，带 shell 元字符就不写）、「用户自己设过就不动」的判定
- `editor-claude-login-prompt.ts` — VS Code、Cursor 用户设置里的 `claudeCode.disableLoginPrompt`：写 Claude Code 配置时、开机补设置那一轮顺手补上，编辑器里的 Claude Code 插件就不再先要登录 Anthropic 账号；编辑器没打开过不建，客户写过的不动，设置文件按 JSONC 原样只插这一行，经 `config-files.ts` 同一套两阶段提交写入（I8、I9）
- `claude-model-picker.ts` — Claude Code 的 `/model` 菜单：接当前账号时按 Key 实际可用的模型生成 `modelPicker` 与 `ANTHROPIC_DEFAULT_MODEL`，认得出本软件写的菜单，切回官方时收回
- `codex-model-catalog.ts` — Codex（命令行与桌面端共用）的型号名单：随包官方名单（`bundled-catalog/codex-models`，按 sha256 钉住）按账号挑出能用的型号，写成 `CODEX_HOME/xingmang-models.json` 并在 `config.toml` 顶层指向它；这个文件坏了命令行起不来，所以本机命令行或桌面端太旧、默认型号不在名单里就不写，写了的收回
- `tool-model-check.ts` — 打开工具前每天核一次账号能用的型号：默认型号下架了交给界面问，Claude Code 菜单与 Codex 型号名单悄悄刷新；两站都下架的型号开机那轮直接换掉；核对失败绝不挡打开
- `cli-config-health.ts` — 判断 Claude Code、Gemini CLI 自己读不读得了 `settings.json`，Codex 读不读得了 `auth.json`（读不了时首页写「配置文件坏了」）。本软件自己的读法比这几个工具都宽，读得出 Key 不代表工具读得了；每条都拿真工具试过，没试过的写法不下结论
- `tool-config-ownership.ts` — 记每份工具配置「是不是本软件替当前账号写的」的指纹（account / manual / unknown / missing / changed）和写时用的模板版本；判不准一律落到 unknown，那一侧的路径都受「来源未确认就不自动改写」保护，开机补模板缺省项也只补自己写的

## 打开工具：目录、覆盖与线路探测
- `workspace-guard.ts` — 判「打开」选的目录是不是主目录、盘根、桌面、下载、文档、系统目录或四家存 Key 的目录：选中它们等于给整台电脑写信任名单和 AGENTS.md，系统目录与存 Key 目录每次都拦。只看路径形状、不读磁盘，判不准按普通目录放行
- `workspace-config-overrides.ts` — 只看不改：找出项目文件夹里、公司下发的、会盖过当前账号地址或密钥的那几份配置（Claude 项目 env 与管理策略、Codex 强制登录方式、Gemini 换登录方式与文件夹信任），交给打开流程提醒、检查页列项；有界读、不跟链接（I8），结果只有路径和键名，值不出模块（I13）
- `tool-path-probe.ts` — 「工具同路径」探测：照命令行工具自己（跑在 Node 里，不是 Chromium）连星芒的样子查一条线路通不通，逐地址握手再问 `/api/status`，只靠系统根证书才过的标成「安全软件接管」；总时限、正文上限、不跟重定向、只去本站线路的 origin（I10）。线路选择（`tool-route-*`）用它
- `cli-exit-hint.ts` — 终端里 AI 工具退出后、进不去项目文件夹时打给用户看的那几行中文，Windows、macOS、Linux 共用一份
- `terminal-launcher-files.ts` — 「打开」CLI 用的一次性启动脚本的文件部分，macOS（`macos-platform.ts`）与 Linux（`linux-terminal.ts`）共用：脚本里可能带 Key，只写进本进程 mkdtemp 的私有目录、原子写，用完按身份（连大小、链接数、时间戳一起）核对再删，绝不误删同一路径上别人放的东西

## Codex：配置、会话与扩展
- `codex-home.ts` — 解析 `CODEX_HOME`（相对路径或带 NUL 的按没设处理并记下原因，进日志前先脱敏，I13）和各工具的配置根目录；备份、诊断、配置读写、卸载清理都从这里取（T10 的消费者）
- `codex-config-syntax.ts` — 判断 Codex 自己读不读得了 `config.toml`（读不了时桌面端停在「无法加载组织设置」，首页写「配置文件坏了」）。本软件用的 `@iarna/toml` 只懂 TOML 0.5、Codex 读 TOML 1.1，所以只认两边都拒绝的那几类，比对记录在文件头
- `codex-context-limits.ts` / `codex-config-migration.ts` — 一次性清掉 0.2.5 以前模板写进 `config.toml` 的两项上下文限制：只删值和当年模板一模一样的，客户自己改过的留着；完成记号按 CODEX_HOME 记在数据目录，从不为了记状态去新建 Codex 配置
- `codex-sessions.ts` — Codex 会话的权威源是 `CODEX_HOME/state_5.sqlite` 的 `threads` 表（只读打开）；认不出的 schema 写操作一律关掉，归档、删除带操作日志与备份
- `codex-config-toml.ts` — 保存配置以外单改 Codex `config.toml`（和存着的那份星芒配置）的统一入口 `mutateCodexConfigToml`：从读到写整段同步，本进程里谁也插不进来；改前留 `.bak`；能只动几行就只动几行，解析回去对不上才整份重写。扩展页启停插件和技能（卸载、导入技能时清掉它的启停记录，#1093 第 9 条）、星芒画图技能开关、桌面端语言在用（#1068）
- `codex-extensions.ts` — Codex 专用的 MCP / 插件 / 市场 / Skill 管理（经 Codex 自己的命令行）；DTO 只暴露 env **变量名**不暴露值（I3）
- `codex-plugin-catalog.ts` — 替 Codex 下官方插件目录快照（`$CODEX_HOME/.tmp/plugins`），国内它自己同步不下来；只在快照不存在时写，从不覆盖 Codex 自己的完整快照
- `codex-plugin-catalog-bucket.ts` — 插件目录先从星芒腾讯云存储桶下（`scripts/sync-codex-plugins-cos.cjs` 定时同步），读不到、对不上、太慢就换回 GitHub
- `codex-responses-probe.ts` — 检查页的 Codex 协议检查：用当前配置向中转发两次 Responses 请求，确认函数调用真的走得通；要花额度，所以先要用户勾选确认，同时点多次共用同一次，账号或配置中途变了就作废

## Codex 桌面端
- `codex-desktop-service.ts` — **桌面端的服务层（全仓最大的文件之一）**：探测、安装、更新、打开、重置、卸载。Windows 上安装顺序是星芒存储桶 → 微软商店 → OpenAI 官网离线安装包 → 国内镜像，每一路的地址与重定向都钉死、包身份与签名都核；Mac 上交给 `macos-desktop-app-installer.ts` 与 `macos-codex-app.ts`。从 `system-service.ts` 拆出
- `codex-desktop.ts` — 桌面端清单、包信息、开始菜单与进程列表解析的纯函数层，外加按包结束进程
- `codex-desktop-appx.ts` — Windows 上装 MSIX 的共用一步（Codex 和 Claude Desktop 都用）：先按当前用户 `Add-AppxPackage`，Windows 说带服务要管理员时再走一次 UAC 授权；产品标识只收字母，免得拼进提权脚本变成代码
- `codex-desktop-cdp.ts` — 打开桌面端时经本机回环端口的 CDP，把官方已经带着的中文资源显示出来（只打机制层的补丁，不替换 Codex 的资源）；端口只认回环、核对端口归属，防别的进程冒充
- `codex-desktop-locale.ts` — 读写 `config.toml` 里 `[desktop] localeOverride`（中文 / 跟随系统），并检查本机桌面端带没带全官方中文资源；客户自己设过的语言从不覆盖
- `codex-desktop-startup-route.ts` — 桌面端冷启动要向 `ab.chatgpt.com` 读一次界面开关，国内读不到就是英文加白屏半分钟（#977）：按「星芒服务器代取（两分钟通行票 + 本机端口 + 只改这一个主机的解析）→ 退回加速 → 当场失败不白屏」依次试；票只在主进程换、不交给 Codex、不进日志（I3、I13、I15）
- `codex-desktop-acceleration.ts` — 打开桌面端前悄悄替用户连上加速（桌面端只认系统代理）：不扣免费时长、用完就断、用户自己连的线路一律不碰、不在加速页和托盘上露面，连不上照常打开。不含 Electron 依赖
- `codex-desktop-state.ts` — 修 `.codex-global-state.json` 里权限选择器那一项：旧版写的是布尔值，新版界面拿到它就把权限选择禁掉；只改这一项，别的状态不动
- `codex-desktop-install-failure.ts` — 桌面端装不上 / 更新不了时客户看到的那句话（按原因分几类，原话只进日志），外加微软商店链接（外链白名单全等收录，I12）；主进程与渲染层共用，不许引 Node（I6）
- `codex-desktop-known-issues.ts` — 已知打不开的桌面端版本表：只提示并引到 Codex 命令行版，不给「退回上一版」（商店几小时就换回去）；上游修好、真机核过后删掉那一行。主进程与渲染层共用

## 手机遥控 Codex（设置 › 工具管理；只认配对过的一个人的私聊，命令要在聊天里点同意）
- `codex-remote-channel.ts` — 渠道（飞书、微信）和底座之间的接口：入站消息、出站文字与审批、渠道状态、`RemoteChannelDependencies`（主进程 fetch、凭据读写、日志、版本号），以及给界面的快照类型（带 `revision`，界面只收新的那份）。零依赖，在 `valueImportable` 名单上（I6），渲染层用它的 `remoteChannelIds`
- `codex-remote-http.ts` — 渠道请求平台开放接口的唯一出口：只许 HTTPS 和渠道给的那几个主机、超时、响应体上限、不跟跳转（I10），报错不带令牌和消息正文
- `codex-remote-text.ts` — 发到手机上的每一句话（帮助、配对成功、审批、断开）和脱敏：主目录换成 `~`、密钥和 Codex 自己的 Key 打码（I13）
- `codex-remote-app-server.ts` — 驱动 `codex app-server` 的 JSON-RPC 客户端（stdio，一行一条）：握手、开对话、发一轮、中断，Codex 反过来问的审批交给底座；退出时 stderr 只留尾巴
- `codex-remote-process.ts` — 起 `codex app-server`：可执行文件由 `resolveCodexCommand` 认过、argv 数组不经 shell（I1）；Windows 上停的时候用 System32 的 `taskkill /T` 连 Codex 跑起来的命令一起停（I14）
- `codex-remote-store.ts` — 遥控的设置（干活的文件夹、每个渠道绑定的人、上一条审批的编号）和渠道凭据（`safeStorage` 加密，Linux 没有密钥环时只记在内存）；「打开遥控」开关故意不落盘，每次打开星芒都是关的
- `codex-remote-service.ts` — **底座**：配对码（10 分钟、错 20 次作废）、只认绑定的那个人的私聊、一次只跑一轮、审批转到手机（10 分钟没回自动拒绝；编号重开星芒也接着数，卡片按钮另带只对这一条有效的随机串，旧卡片点了只回「已失效」）、发回的内容脱敏、闲置 4 小时断开、退出时全部收掉；开对话固定 `untrusted` + 工作区可写，不给完全权限，也不带客户自己接的 MCP 服务、插件和 ChatGPT 应用（开对话前用 `config/read` 逐层查出名字逐个停用，电脑上照旧）
- `codex-remote-keep-awake.ts` — 有渠道开着（在连、已连上、连不上正在重试）就挡住系统自动睡眠，全关了、要重新登录了、闲置断开了就放开（关屏、合盖照旧）；跟着底座推给界面的快照走，按 `revision` 只认新的那份。Codex 自己的防睡开关只管它跑一轮，两轮之间等手机那段靠这里
- `codex-remote-channels.ts` — 按渠道建适配器（无 default 的 switch，加渠道漏了是编译错）
- `codex-remote-feishu.ts` / `codex-remote-feishu-frame.ts` — 飞书渠道：长连接（开放平台的 WebSocket，帧格式照官方 SDK 逐字节对过）收私聊和卡片点击，开放接口发文字和带「同意 / 拒绝」按钮的卡片；App ID / App Secret 填错报「要重新登录」，不无限重试
- `codex-remote-weixin.ts` / `codex-remote-weixin-api.ts` — 微信渠道（实验功能）：腾讯 iLink 长轮询收消息、发文字，写法照 `@tencent-weixin/openclaw-weixin` 2.4.10 核对；只认 https 的 `*.weixin.qq.com`（跳转主机和登录给的地址都过这道），64 位消息编号保精度解析，只交回扫码人的消息、也只往他那里发；登录过期（-14、401/403）报「要重新登录」不再重试
- `codex-remote-weixin-login.ts` / `codex-remote-weixin-credential.ts` / `codex-remote-weixin-login-state.ts` — 微信扫码登录：二维码在主进程画成图（登录链接不出主进程），5 分钟一张、最多换 3 张、整体 8 分钟；手机上要输数字时停下来等；拿到的令牌直接进底座的加密凭据存储，不过 IPC。`-login-state.ts` 只有类型，界面 `import type` 它
- `bootstrap/codex-remote.ts` — 主进程接线：存储放 `<userData>/codex-remote`、渠道走主进程会话 fetch、用客户装好的 Codex 命令行工具；Windows 上星芒以管理员身份或高完整性运行时不许开（手机上点一下就是管理员级操作）
- 通道在 `ipc/handlers/codex-remote.ts` + `ipc/parsers/codex-remote.ts`（`codex-remote:*`，存飞书凭据那条记为密钥入参），状态变化经 `codex-remote:state-changed` 推给界面；微信扫码的三条（`codex-remote:weixin-login-start` / `-poll` / `-cancel`）在 `ipc/handlers/codex-remote-weixin.ts` + `ipc/parsers/codex-remote-weixin.ts`，成功不记日志

## 外部桌面客户端：WorkBuddy / Claude Desktop / OpenCode
- `external-client-runtime.ts` — **三家客户端的探测、安装与打开**：Windows 用一段 PowerShell 盘点并核签名，Claude Desktop 装法是存储桶 → winget → 官网 MSIX，OpenCode 走 winget，WorkBuddy 一律让客户去官网自己下；Mac 交给 `macos-desktop-app-installer.ts` 并核 Developer ID。「打开」不排安装队列，是 I11 的登记例外（只等同一家正在装的那一次）
- `external-client-route-service.ts` — **三家客户端在系统服务里的那一段**（#1070 第 3 步从 `system-service.ts` 原样搬出，`createSystemService` 照旧对外给 `scanExternalClients`、`configureExternalTool`、`switchExternalClientSource` 这些）：盘点（合并、落盘先画首页）、安装、打开、测试连接，写配置前绕过缓存现查型号、核账号没换，Claude Desktop 切回官方账号或改用当前账号；换线路、换 Key 以后替当前账号写的那份跟着换，客户端开着就每 5 分钟看一眼进程、等它退出再换（星芒退出时撤掉这个定时）。写配置、切账号、跟线路改的是同一批文件，排同一个队（`queueExternalConfigWork`，原来手抄三份）
- `external-client-contract.ts` — 三家的共用类型、名字表、「去官网下载」网址（主进程外链白名单逐条全等收录，I12）和配置请求的入参校验（I5）；`ipc-contract.ts` 引它的类型
- `external-tool-config.ts` — WorkBuddy 与 OpenCode 的配置文件：找位置、合并，经 `config-files.ts` 同一套两阶段提交写入（I9）；换线路时只改星芒写的那几处地址，客户刚改过就一个字不写。Claude Desktop 不在这里，见 `claude-desktop-config.ts`
- `external-client-connection.ts` — 三家的连接自检：回读客户端自己的配置，用里面那把密钥问一次星芒（WorkBuddy、OpenCode 查模型清单不花额度，Claude Desktop 照它自己的样子发一个字）；客户端里真正发的对话本机测不到，结论照实说，不假绿
- `external-client-ownership.ts` — 记「这份客户端配置是替哪个账号写的」：只存地址加密钥的 sha256，是本机证据不是凭据库（I3）
- `external-client-snapshot-cache.ts` — 上一次三家的检测结果留在本机，下次启动先拿它画首页那几行；只用来「先画个样子」，主进程里要回答装没装、配给谁的地方都不读它
- `desktop-package-bucket.ts` — **星芒腾讯云存储桶的共用下载器**：Codex / Claude 桌面端和 Mac 版 OpenCode 的官方离线包都从这里先下，插件目录和 Grok 也借它的取法。桶地址是常量、对象 key 形状固定、拒一切重定向（I10），清单里的大小与 SHA-256 绑住下载，调用方照样核官方签名，桶被改了最多白下一次、装不进东西；同步脚本是 `scripts/sync-*-cos.cjs`
- `claude-desktop-config.ts` — Claude Desktop 的第三方推理（网关）配置：写 `configLibrary` 与 `claude_desktop_config.json`，「切回官方账号」只把 `deploymentMode` 改成 `1p`；输入里有 Key，绝不回传渲染层（I3）
- `claude-desktop-local-transaction.ts` — 上面那几份文件的事务写入：先写临时文件、留 `.bak.<随机>` 备份（每个文件只留最近 5 份）、失败回滚（I9），只清自己起名的备份
- `claude-desktop-paths.ts` — 定 Claude Desktop 的配置目录：由当前装着的那一份（和它的 MSIX 虚拟化设置）决定，不看遗留目录；测试用的主目录绝不继承真实 AppData
- `claude-desktop-manifest.ts` — 读微软商店版 Claude Desktop 的清单，判断它的配置目录有没有被 MSIX 虚拟化（决定实际写到哪）；PowerShell 脚本由纯函数生成，各平台都能按文本单测
- `claude-desktop-policy.ts` — 写配置前确认 Claude Desktop 没被组织策略（注册表或托管文件）接管推理设置；PowerShell 只带出策略的名字和类型，值里可能有 Key，不出来（I3、I13）
- `claude-desktop-models.ts` — 保存 Claude Desktop 配置时型号菜单里放哪几个：选中的排第一，其余 `claude-*` 按版本新到旧最多再试 7 个，照它的启动检查发一个字、通了才写；也照它的挑法算出启动检查用哪个型号，给连接自检多问一次。不含 Electron 依赖
- `claude-desktop-model-repair.ts` — 开机一次性修复：0.2.12 往 Claude Desktop 配置里写了一串型号，导致发消息没回复；只认星芒自己那份、只认那个写法，改回单个型号，最多试三次，查完记一笔以后不再读
- `claude-desktop-msix-installer.ts` — Windows 上 Claude Desktop 的离线 MSIX 一路（存储桶或 Claude 官网，官网只认 `claude.ai` 入口与 `downloads.claude.ai/releases/` 的逐跳重定向），PowerShell 只读核对包身份与 Anthropic 签名，再交给 `codex-desktop-appx.ts` 的共用安装（带服务的包走 UAC）
- `claude-desktop-acceleration.ts` — 从星芒打开 Claude Desktop 前悄悄替用户连上加速，好让它从 `downloads.claude.ai` 下得到 Claude Code 程序和 Cowork 工作区（#1373）：约束同 `codex-desktop-acceleration.ts`，Claude 退出或连满一小时就断，和 Codex 桌面端共用同一次会话时先用完的那边交给另一边（`heldElsewhere`）。不含 Electron 依赖
- `claude-desktop-install-failure.ts` — Claude Desktop 没装上时那句话（按原因分类，原话只进日志）和官网下载页地址（外链白名单全等收录，I12）；主进程与渲染层共用，不许引 Node

## 托管密钥的分组与换新
- `managed-cli-groups.ts` — 给每个工具和画图挑账号里用哪个分组：xm 站分组只按名字认（没有编号），服务状态文件里的分组对照让站上改名时不用等发版；订阅分组、历史账号那套后端的平台字段也在这里判。签 Key、对话凭据、账号页都用它
- `managed-key-replacement-store.ts` — 撤销一把带额度上限或到期时间的 Key 之前，先把这些限制落盘，换上新 Key 再删；只记限制不记密钥，读坏了抛错停下（当没记过就会签出一把不限额的 Key）

## 外链、深链与更新通知
- `external-url-blocked.ts` — 外链被白名单拒绝时的错误类：IPC 只保留错误名，渲染层靠它认出「这条链接不让开」（I12）；零依赖，v2 渲染层直接引
- `external-deep-links.ts` — 解析系统交来的 `xingmang://` 深链（只认 pay、invite 两种，参数逐个白名单），存着最近一次等渲染层来取；绝不当导航地址加载（I12）
- `desktop-notifications.ts` — 星芒自身更新的系统通知（有新版、已下好、磁盘不够先不下），每个版本只说一次，点了回到窗口或更新页；Linux 交给系统安装器的那种另有说法

## Windows PowerShell 脚本辅助
- `powershell-module-imports.ts` — 主进程所有 PowerShell 脚本开头那句模块导入：在 `trustedCommandEnvironment()` 收窄后的环境里，任何一条命令靠自动加载都会触发 System32 全量模块扫描（每个进程二十多秒），所以按名先导入、`Microsoft.PowerShell.Utility` 永远排第一；模块名只收固定字面量（I2）
- `powershell-module-imports.test-support.ts` / `powershell-script-scan.test-support.ts` — 测试专用：按文本核对生成的 PowerShell 脚本每条命令都先导入了模块、用户数据只出现在单引号字面量里且括号闭合，不起真的 powershell.exe；`tsconfig.electron.json` 排除 `*.test-support.ts`，不进发布包

## macOS 相关模块（规则见 `.claude/rules/macos-platform.md`，改这些文件时自动加载）

> **改跨平台代码前先读 `platform-capabilities.ts`**（在 [`main-core-canvas.md`](./main-core-canvas.md)），它是判断「当前平台支持什么」的单一入口。

- `macos-platform.ts` — **Mac 上找命令与「打开」工具**：`darwinCommandPathCandidates` 定 node / npm / CLI 的查找顺序（本软件代下的 Node.js 排最后，客户自己的优先）；打开时写一次性启动脚本，交给固定路径的 `/System/Applications/Utilities/Terminal.app`（不按名字交给 LaunchServices，I14 在 Mac 上的对应），脚本里先摘掉指向已关闭本机端口的代理变量；启动脚本的文件部分在 `terminal-launcher-files.ts`
- `darwin-path-trust.ts` — Mac 的路径信任：问的是「除 root 和当前用户外，有没有别人能改它解析到的东西」，不是 Windows 那个问题；整条祖先链都查，属主压过权限位，admin 组（gid 80）按产品决定算可信。规则见 `.claude/rules/macos-platform.md`（T5）
- `darwin-cli-staging.ts` — 核过签名的 CLI 经已绑定的文件描述符拷进私有暂存目录、再核一遍才执行，堵住「核完到执行之间被换掉」；终端可能晚一点才真正执行，所以留存到显式释放或进程退出
- `macos-code-signing.ts` — Mac 上认可执行文件和应用来源的唯一办法：把钉 Team ID（和 bundle id）的 designated requirement 交给 codesign，只看退出码不看输出，因为 `codesign -dv` 的文字谁都能伪造
- `macos-claude.ts` / `macos-codex.ts` — 起原生安装的 `claude`（Anthropic Team ID）和 Codex 官方独立安装布局（`CODEX_HOME/packages/standalone/releases/…`，OpenAI Team ID）之前先核签名，Codex 再经私有暂存执行
- `macos-codex-app.ts` / `macos-executable-architectures.ts` — Mac 上探测、核对、打开 Codex 桌面端（钉 bundle id 与 OpenAI Team ID；深度签名核验另给更宽的时限并缓存一阵，超时降级成可重试而不是「没装」）；后者读 Mach-O / fat 头，认出可执行文件带哪几种架构
- `macos-grok.ts` — Grok 在 Mac 上的安装核对与卸载：npm 装完由它的 postinstall 把二进制解到 `~/.grok/bin`，这里核 xAI 签名、做规范链接与 `agent` 链接的快照和回滚；Linux 版直接复用这一套
- `macos-node-runtime.ts` — Mac 上代下 Node.js：和 Linux 钉同一版与每个架构的 SHA-256（S02），官方 tar 包再核 Node 的 Developer ID，解进产品目录 `Runtime/node`，不提权、不开终端；客户自己的 Node 太旧时，本软件自己干活才改用这一份
- `macos-command-line-tools.ts` — `/usr/bin/git`、`/usr/bin/python3` 在没装命令行开发者工具时只是空壳，一跑就弹苹果的安装框；探测前先问 `xcode-select` 背后那份在不在，免得每次开机弹两次
- `macos-git-install.ts` — 「安装 Git」在 Mac 上就是跑一次 `xcode-select --install`，下载与授权全交给苹果的窗口；之后定时看 Git 能不能用、安装程序还在不在，推断装好、取消还是超时
- `macos-shell-profile.ts` — 让客户自己开的终端也能直接敲 claude / codex / grok：往 `~/.zprofile`（或 bash 登录文件、fish 的 conf.d）末尾追加标记段，只追加不前置，客户自己装的照旧优先；客户删了那几行，开机不再补
- `shell-startup-exports.ts` — 认 `~/.zshrc` 这类终端设置文件导出了哪些变量（zsh、bash、fish 的写法），只解析、不执行、不跟 `source`；检查页在 Mac 上用它找会让工具绕开当前账号的那几个（已知45）
- `macos-desktop-app-installer.ts` / `macos-desktop-install-failure.ts` — Mac 上一键装桌面端（OpenCode、Claude Desktop，以及 Codex 桌面端的官方包 ChatGPT）：先从星芒存储桶（`desktop-package-bucket.ts`）下同一个官方包，没走通才问官方 feed（逐跳限定的重定向，feed 只能指向本模块自己会拼出的那个地址）；codesign 钉 Team ID 与 bundle id、spctl 核对公证，全过才放进「应用程序」（不是管理员就放 `~/Applications`）；失败的那几句话主进程与渲染层共用（I6）
- `macos-install-location.ts` — 认出是不是直接从磁盘映像或系统的随机隔离副本（App Translocation）里运行：那样加速内核一推出就被杀，提示搬进「应用程序」；纯路径判断，不用挂盘就能单测
- `macos-uninstall.ts` — 设置里「卸载星芒」的 Mac 版：先收回工具配置里指向 .app 的钩子与状态行，删开机项、托管工具和更新缓存，再把自己移进废纸篓并退出；安装队列有活时不卸（I11），Key 和工具设置照 Windows 的口径保留

## Linux 相关模块（规则见 `.claude/rules/linux-platform.md`；发布开关还关着，见 `docs/LINUX.md`）

- `linux-launch-guard.ts` — 拒绝以 root 或替别的账号运行（Linux 上本软件从不需要 root，没有「管理员模式」可退）；零 import，`platform/entry.ts` 查完打包版启动开关后最先调用
- `linux-path-trust.ts` — 路径信任判定：问 macOS 那个问题，但组可写目录按 `/etc/group`、`/etc/passwd` 的实际成员判（LDAP 这类查不清成员的组一律不信），解析后和字面两条链都走；规则见 `.claude/rules/linux-platform.md`
- `linux-renderer-sandbox.ts` — 画布打开前确认渲染进程的系统沙箱真的生效：启动参数里没有关沙箱的开关，且按画布的隔离设置起一个渲染进程读 `/proc/<pid>/status` 得到 `Seccomp: 2`（I15）
- `linux-platform.ts` — Linux 上找 node / npm / CLI 的目录顺序，不读 shell 启动文件（本软件的 Node.js 排在继承 PATH 前面，和 macOS 相反；终端启动器目录从继承 PATH 里剔掉，免得被扫成「已安装」）
- `linux-node-runtime.ts` — Linux 上代下 Node.js：钉版本与每个架构的 SHA-256，只用 root 所有的系统 tar 解进 `${XDG_DATA_HOME:-~/.local/share}/XingMangAI` 下的 `Runtime/node`，核对后原子替换（Linux 版拆分 ②）
- `linux-shell-profile.ts` — 客户自己开的终端里直接敲 claude / codex / grok：每个托管工具一个小启动器，`~/.bashrc` / `~/.zshrc` / `~/.profile` 末尾的标记段与 fish 的 conf.d 文件，卸掉最后一个时逐字撤掉（Linux 版拆分 ④）
- `linux-terminal.ts` — Linux 上「打开」工具：找命令窗口程序（按桌面、系统默认、再按表，只搜 PATH 里的绝对目录）、写一次性 sh 启动脚本、等脚本删掉自己才算打开；启动脚本文件的写入与清理和 macOS 共用 `terminal-launcher-files.ts`（Linux 版拆分 ⑤）
- `linux-grok.ts` — Grok 的 Linux 安装核对与卸载：没有 codesign，改为和 npm 官方锁校验过的平台包逐字节对账，再核版本；链接快照与回滚复用 `macos-grok.ts`（Linux 版拆分 ③）
- `linux-deb-update.ts` — Linux 上星芒自己怎么更新：只有用 .deb 装的才自动更新，下好的包交给这台电脑自己的软件包安装器去装；不用 electron-updater 的 DebUpdater（它从 PATH 找 pkexec、拼 shell 以 root 跑 dpkg），星芒从头到尾不提权
- `linux-password-store.ts` — Chromium 不认识的桌面（i3、LXQt、远程会话、deepin 新名字）会把 safeStorage 退成明文后端，登录就记不住；只在这时、且系统声明了 Secret Service 时改用 gnome-libsecret，已认识的桌面和 KDE 一律不换（换了会读不出以前加密的文件）
- `linux-tray-host.ts` — 启动时问会话总线有没有托盘接收方（`org.kde.StatusNotifierWatcher`），只跑固定路径的 dbus-send / gdbus（I1、I14）；没有就不建托盘、关窗直接退出（Linux 版拆分 ⑩）
- `linux-autostart.ts` — Linux 的开机自动启动：写 XDG autostart 里的 .desktop 文件，读写走 safe-local-data；用户在系统里停用了只报「登记了但没生效」，不替他改回来（Linux 版拆分 ⑩）
- `linux-ime.ts` — Wayland 会话下给 Chromium 开文字输入协议的启动开关，中文输入法才收得到输入；X11 会话不用管（Linux 版拆分 ⑩）
- `linux-os-release.ts` — 读 `/etc/os-release` 得到发行版名字，给检查页、复制给客服和启动日志；内容按不可信文本清洗、截短（Linux 版拆分 ⑩）
