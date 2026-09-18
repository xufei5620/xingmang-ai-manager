# 2026-09-18 业务正确性与数据可靠性修复

## 当前修复：旧 CLI Key 被误报第三方配置（2026-09-19）

根因已确认：来源记录缺失即 unknown，扫描未读取当前账号加密密钥缓存；v1 account 来源记录仅绑定配置指纹、不绑定账号。上一轮已只读确认用户五行工具的四种 Key 全部属于当前 NewAPI 账号 36，本轮修复代码，不重写真实配置。

1. 已完成设计：主进程读取当前账号域+userId 的本机托管 Key，完整匹配 provider/Key/服务地址，返回独立 `configurationAccountMatched` 标记；账号、站点或 revision 变化丢弃旧结果。缺失/损坏缓存保守降级，无远端请求、无自动创建 Key。
2. 后端与 IPC 已实现：持久来源 v2 绑定账号、v1 无账号来源仅作 unknown；同次配置读取按完整 Key/provider/地址计算独立匹配结果，getConfig 仅读取当前登录域的本机缓存，切号/退出/跨域/revision 变化拒绝旧结果，缓存读失败不阻断配置显示。IPC 307 项、来源模块 21 项回归通过，服务层完整回归进行中。
3. 验收标准：旧 Key 匹配当前账号显示已配好；切号/退出/跨域/配置被改后不误认；手动来源优先；恢复显示不授予自动改写权限；getConfig 不写配置或来源文件；完整类型检查、相关单元/浏览器及构建通过。
4. 本机只读验证已完成：真实当前账号 solov:36 的 claude/codex/gemini/grok 均 matched=true，模拟其他账号及退出的服务上下文均 matched=false；前后配置文件哈希和来源文件列表/哈希一致，网络请求为 0。使用 `artifacts/key-account-audit-2026-09-18.ps1 -VerifyMatchingConfigs`，凭据仅经匿名 stdin 管道传递至只读服务验证脚本，不落盘、不输出、不放在命令参数中。
5. 前端修复已落地，回归进行中：匹配标记恢复账号显示，manual/官方优先；bootstrap 区分显示与持久授权，旧 Key 不因识别成功而自动重写。useToolbox 在 scope 变化同步清空 CLI 快照并拒绝旧扫描结果。完整类型检查第一轮通过。
6. 独立复核修正：保留当前 Key、仅更换模型时，来源 unknown 不应被写成 manual；现保留 unknown 的写保护语义与账号匹配显示，新增回归。用户明确勾选的切号同步入口改为单工具 explicit 调用，避免新版账号绑定拒绝旧 automatic 请求；19 项同步单元测试及 3 项业务浏览器回归通过。
7. 定向整合验收完成：IPC/来源/服务/配置执行器/前端模型/bootstrap 共 6 文件 474 项通过、30 项平台跳过；前端 23 个不同浏览器场景通过（含五个工具保留 Key 只改模型、切号/退出/旧响应及已有 WorkBuddy 回归），截图与报告在 `artifacts/renderer-account-match-verification-2026-09-19.md`。生产 `npm run compile` 通过，只有既有 chunk 大小提示。日志为 `artifacts/tool-account-owner-{unit,compile}.log` 和 `artifacts/account-switch-sync-browser.tap`。
8. 最终整合验收完成：7 文件 494 项单元测试通过、30 项平台跳过；`npm run typecheck` 最终通过（中间两次受另一轮 Claude Desktop 并行改动的旧测试接口影响，其更新完成后已通过，未撤销该并行工作）。21 个相关文件 UTF-8 无 BOM 与 `git diff --check` 通过。最终日志为 `artifacts/tool-account-owner-unit-final.log` 与 `artifacts/tool-account-owner-typecheck-final.log`。
9. 开发实例已更新并置前：精确核对后停止旧主进程 PID22900 与 watcher，后台 worker PID87660 自行退出；新 cmd PID81100、Electron PID70740，watch 0 错误、`http://127.0.0.1:5173/` 返回 HTTP200。原生 accessibility 实际读取到「神风呀」账号下 Claude Code、Codex CLI、Codex 桌面端、Gemini CLI、Grok CLI 五行均为「已配好」。原生截图接口报 `SetIsBorderRequired failed (0x80004002)`，实际窗口验收使用 accessibility，隔离浏览器截图已由前端验收。日志为 `artifacts/tool-account-owner-dev.stdout.log` / `.stderr.log`。未改写真实 Key、未切换真实账号、未发起生产模型请求；未提交、推送或发布安装包。

## 只读核查：已有第三方配置的 Key 账号归属

2026-09-18 用户截图中的 Claude Code、Codex CLI、Codex Desktop、Gemini CLI、Grok CLI：读取当前配置后，在内存中计算 Key 完整 SHA-256，与本机加密托管密钥缓存比对；四种 Key 均完整匹配 NewAPI / `xm-account:36`，本机账号名称「神风呀」，当前登录账号也是该账号。对应 Key ID：Claude 26、Codex 38（CLI 与桌面共用）、Gemini 25、Grok 24。本机缓存匹配不代表此次在线验证有效性。

这些配置的 `ToolConfigOwnershipStore.read()` 均为 `unknown`，本机缺少匹配的 `tool-config-ownership` 来源记录，因此界面保守显示「已有第三方配置」；该标签不能独立证明是其他账号。此次仅诊断，不变更任何配置、Key、来源记录或账号登录状态，不调用远端接口，不输出完整 Key/会话凭据。只读脚本为 `artifacts/key-account-audit-2026-09-18.ps1` 和 `artifacts/tool-key-fingerprints-2026-09-18.cjs`，输出仅账号摘要、Key 元数据与指纹。

## 当前任务：搜索框隐藏口令赠送 10 分钟加速

用户要求在“搜索、打开、跳转”中输入神秘字符串，给用户增加 10 分钟加速时长。沿用现有按账号域+userId 隔离的本机加速账本；默认每账号在本机领取一次，输入完整口令后按 Enter/点击领取，普通搜索不变。口令：`XM-NEBULA-10M-7Q9K`（忽略首尾空白和英文大小写）。未登录提示登录，不改真实账号额度测试，不触碰系统代理作验收。

1. 已完成分析：Shell.tsx 为搜索入口；主进程 acceleration-service 验证当前账号并串行执行，host/worker 转发至本机账本；当前总量固定 1200 秒，必须同时调整持久化、计时和耗尽恢复，不能只修改页面数字。
2. 后端完成：账本升级 v2，按账号原子保存领取标记与 600 秒额度，兼容 v1 旧用量，所有启动/停止/恢复路径保留标记；活动连接只重排到期计时，增加 timer generation 防止已排队旧到期回调误停。57 项后端测试通过，未读取或兑换真实账号账本，未修改系统代理。
3. 验收标准：成功精确增加 600 秒、已用不清零；重启保留；同账号重复/并发仅一次；跨账号和两账号域隔离；切号后的旧请求不误写/不误提示；活跃会话延长到期、耗尽账号可再次启动；保存失败不误报到账；完整类型检查/构建、普通搜索键盘回归通过。
4. 主进程通道完成：共享契约、service 当前账号/epoch 校验、固定 600 秒返回校验、可信 IPC、sandbox preload 与 host/worker 转发已接通；不暴露任意加时参数、不记录口令。独立复核修复了返回 status 不能通过字符串转换放行数组的问题，并补回归；其余本次兑换通道无实质缺陷。
5. 搜索与页面完成：完整口令才显示领取操作，输入本身不兑换；Enter/点击提交、IME 防误提交、busy 防重、失败可重试、未登录提示。关闭/重开弹窗或切换账号会丢弃旧反馈。controller 使旧轮询失效并接受主进程状态，额度及规则文案同步显示 20→30 分钟；自动停止失败后领取到正余额，会重新启用到期停止。普通搜索键盘、Esc 清空再关闭及焦点恢复通过。
6. 最终代码验证完成：9 文件整组 499 项通过，后续控制器边界新增 1 项后其 controller/fixture 31 项全部通过，合计 500 个不同定向单元用例。最终完整加速浏览器 14/14 通过。`npm run typecheck`、`npm run compile`、26 个相关文件 UTF-8 无 BOM 及 `git diff --check` 通过；构建仅保留既有大 chunk 提示。日志为 `artifacts/acceleration-bonus-{unit,renderer-unit,browser,typecheck,compile}.log`；浏览器均为隔离 fixture，无真实领取、模型请求或代理启停测试。README 已写明操作与本机权益边界。未提交、推送、打包或发布。
7. 开发实例已更新：已核对旧 PID 与完整父链，停止开发 watcher/主进程；保留后台 worker（PID29752）由其断连恢复自行退出，已确认退出。新 `npm run dev` 后台 cmd PID45044、Electron 主进程 PID44832，`http://127.0.0.1:5173/` 返回 HTTP200。启动日志为 `artifacts/acceleration-bonus-dev.stdout.log` / `.stderr.log`；原有远端公告/用量超时仍有记录，不影响本次本机口令功能的隔离验收。真实账号未替用户领取，口令可留给用户实际使用；客户安装包仍需另行发布才包含此功能。

## 当前任务：macOS 双 Dock 图标与 Codex Desktop 安装检测

### 客户机报告复核（2026-09-18 20:53:49 +08:00）

已收到并读取客户执行的诊断 v1；不重复执行此前修复。客户运行的是 9 月 16 日签名的星芒 0.2.5 安装包，本地 9 月 18 日修复尚未发布，不能把该报告视为新版验收。

- 双图标原因与后台 worker 路径吻合：PID21945 与子进程 PID21975 使用同一星芒 `.app`，两者 activationPolicy 均为 0；PID21975 又派生了 `macos-system-proxy`。Dock 只记录一个星芒应用路径。主进程与加速后台进程都注册为普通 Dock 应用，已有 `prohibited` 修复正针对这条路径。
- Codex 的当前安装有效：`/Applications/ChatGPT.app`，bundle ID `com.openai.codex`，版本 `26.915.31029`，可执行文件 `ChatGPT`、架构 `x86_64`；Spotlight 返回该路径，严格 OpenAI Developer ID requirement 验证通过，只有一个通过验证的 Codex 副本。
- 两个程序均为 x86_64，Intel 报告没有 `hw.optional.arm64`/`sysctl.proc_translated` 键是预期现象；CLT 已安装。不能把上一轮修复的 Rosetta、缺少 CLT、Spotlight 未索引当作此客户已证实的根因。`LSUIElement`/`LSBackgroundOnly` 缺省也不是安装错误。
- 旧 main@ccf1eab 源码已支持 `ChatGPT.app`，并已有 15 秒 deep codesign 超时与成功缓存；不能声称这次才兼容该文件名。现有 0.2.5 本地发布记录是 Windows 构建且 macFeedUnchanged=true，客户 Mac 包内部的确切源码尚未提取核对，不能仅凭版本号将它与该提交一一对应。报告中的签名检查以 30 秒为限，但没有单项耗时，无法判断原应用里的检测是否曾超时。当前两个配置文件已存在，报告也不能还原其创建前的应用状态或证明创建文件是安装识别的必要条件。
- 本轮补充：加强已有 Intel/ChatGPT.app 的回归，固定客户架构且不查询 ARM/Rosetta 键；在 `scan.completed.codexDesktop` 日志中补 `detectionFailed`/`detectionError`，避免反馈报告只留下 installed=false 而丢掉实际检测原因。若旧客户端仍复现，需要同一时刻应用内“重新检测”后的脱敏反馈报告，不能仅凭独立脚本宣称已查明漏检原因。
- 本轮验收：检测器 63 项通过、1 项 Darwin-only 跳过；IPC/日志 309 项通过；Electron 类型检查通过。日志为 `artifacts/macos-client-detector-customer.log`、`artifacts/macos-customer-feedback-logging.log`、`artifacts/macos-customer-feedback-typecheck.log`。本轮只修改检测器现有测试、两个日志字段及本记录，未更改客户配置、未重新安装任何客户端、未发布 Mac 包。

### 修复与本地验证记录

用户报告 macOS 两个星芒图标、已安装 Codex Desktop 显示未安装，手动补配置后显示变化。当前只有 Windows 开发环境；截图不能独立证明两个图标对应的进程，真机结果需要客户机只读诊断补充。

1. 已完成定位：正式加速后台 worker 使用同一 Electron 可执行文件重新启动，绕过桌面入口与单实例锁，未设置 macOS 后台激活策略；存在产生额外 Dock 图标的明确路径。主界面已有单实例锁，不改为全局隐藏 Dock。
2. 已完成链路核对：macOS 安装检测检查 `.app`、可执行架构和 OpenAI 签名，不读取 `config.toml`/`auth.json`；文件缺失在配置读取中允许，不能宣称“缺配置直接判未安装”。待修正 Rosetta 下进程架构代替硬件架构、验证失败被当成不存在等问题，并补无配置仍已安装回归。
3. 后台修复完成：有效 IPC worker 在加载业务代码前设置 `app.setActivationPolicy('prohibited')`，普通桌面与 Windows 不变；worker/host 32 项定向测试通过。该调用处于可控制的最早 JS 入口，原生启动到 JS 前是否短暂闪现仍需 Mac 确认。macOS 打包和 hardening 共 20 项通过。
4. 前端验证完成：4 项浏览器回归通过，包含 macOS 访客无配置文件、无 CLI/Node/npm 仍显示已安装，下一步单独提示连接；验证未完成不显示未安装、不提供重复安装按钮。另验证已有工具访客打开和异步桌面状态保留，日志 `artifacts/macos-client-browser.log`。普通缺失文件没有发现需要修改的前端判断；真实配置读取错误会使整份快照失败，但不是“缺文件判未安装”，本次未扩大重构。
5. 检测器第一轮完成：修复 x64/Rosetta→ARM 和原生 ARM→Intel 兼容检测，权限/架构/签名失败保留为检测未完成；标准路径、Spotlight 后增加两 Applications 目录浅层查找（每目录 512 项、共享 2 秒新探测预算）。独立复核修正了首次 plutil 非零仍被吞为不存在的残余路径。61 项通过，仅真实 Darwin 系统命令一项平台跳过；Windows 仅模拟 fixture 的 POSIX 执行位，原检测器整组不再跳过。
6. 服务层独立验证：实际隔离配置目录不存在和手动写入两个空文件前后，安装状态均为 true；Darwin 服务组 16 项通过（其余被过滤或平台跳过），日志 `artifacts/macos-client-service.log`。完整 `npm run typecheck` 第一轮通过。
7. 最终检测修复完成：去除 `/usr/bin/lipo` 的运行时依赖（未安装 Xcode/CLT 的客户机可能由 shim 触发失败或安装提示）。新增 Mach-O 薄二进制/Universal 32/64 位双端序解析，最多 64 个 slice、约 4.4 KB 读取，检查表范围、切片越界/重叠/对齐、CPU/subtype、可执行类型和头部完整性；不执行候选，继续由严格 OpenAI 签名决定信任。独立复核通过。检测器及解析器最终 88 项通过、1 项真实 Darwin 命令平台跳过，证据 `artifacts/macos-client-detector.log`。
8. 只读诊断已完成：`scripts/macos-client-diagnostics.sh` 与 `docs/MACOS-CLIENT-DIAGNOSTICS.md` 提供 NSWorkspace/Dock/进程路径/架构/签名/配置元数据报告及可直接复制的快捷命令；不输出 Key、配置正文或进程参数。没有 CLT 时以系统 `file` 代替诊断用 `lipo`。Bash 与 JXA 语法、UTF-8 无 BOM/LF 检查通过；脚本仍未 Mac 真机运行，POSIX alarm 超时不能以 Windows MSYS 试验代替验收。
9. 最终本地验收完成：额外 worker/host/desktop-service/code-signing 4 文件 88 项通过、2 项平台跳过；加上检测器 88、Darwin 服务 16、打包约束 20 和浏览器 4，共 216 个不同定向检查通过。完整 `npm run typecheck`、`npm run compile`、14 个本轮相关文件 UTF-8 无 BOM 及差异检查通过。日志为 `artifacts/macos-client-{integration,service,packaging,browser,typecheck,compile}.log`。构建仅保留既有 bundle 大小提示。
10. 开发实例已精确核对旧 PID/路径及完整父链后重启：新 cmd PID85040、Electron PID62448，watch 0 错误，`http://127.0.0.1:5173/` 返回 HTTP200；日志 `artifacts/macos-client-dev.stdout.log` / `.stderr.log`。真实 Codex/WorkBuddy 未停止。源码修复完成，客户机是否命中 Rosetta、开发工具、索引或读权限路径仍需其诊断报告；Dock 实际表现和原生签名/LaunchServices 仍待 Mac 真机验收，不能据截图断言唯一原因。未提交、推送或发布，客户 Mac 的旧安装包不会因本地改代码而自动更新。

## 当前任务：Codex Desktop MSIX 按需临时提权

用户报告 Codex 26.915.3509.0 安装返回外层 `0x80073CF6`、内层 `0x80073D28`，打包服务注册需要管理员。用户授权实现安装时临时 UAC，不要求提升整个星芒客户端。

1. 已完成：核实普通 `Add-AppxPackage` 当前无提权回退；下载哈希和包身份校验、安装后当前用户版本回验均已存在；历史版本回退仅发生在下载阶段。
2. 已完成：独立 `codex-desktop-appx.ts` 仅对明确的 `0x80073D28` 触发一次固定系统 PowerShell UAC，安装进度提示用户授权。SID 必须与原调用 Windows 用户相同；提权进程在 Program Files 创建仅 SYSTEM/Administrators 权限且属主为 Administrators 的副本，复制前复查清单长度，复制后复查 SHA-256并持有只读文件句柄安装，绑定已校验的身份/版本/架构/发布者字节，保留 Windows 强制签名验证。取消/不同用户/包变化/失败有明确提示，安装队列等待提权子进程真正结束，再由原调用进程回验当前用户版本；不降级、不反复提权、不提升主程序。
3. 已完成代码验收：新旧安装相关 3 文件 120 项通过，补充长度限制后受影响新模块 49/49 通过（合计121个不同测试）；打包权限门禁4/4通过。Windows真实PowerShell对两份脚本纯语法解析和未绑定SID退出2225通过，无安装或提权副作用。完整类型检查、生产编译、6个改动文件UTF-8无BOM及diff检查通过，README与RELEASING已更新。日志为 `artifacts/codex-appx-uac-{unit,final-unit,hardening,typecheck,compile}.log`。新开发实例已启动（cmd PID83404、Electron PID41616），5173返回HTTP200，启动日志为 `artifacts/codex-appx-uac-dev.stdout.log`；本机运行中的真实 Codex 未重装，未触发/点击真实 UAC，未提交或发布。报错机器的真实同用户 UAC 安装仍待使用新版实际验收，跨Windows用户授权明确拒绝。

## 当前任务：外部客户端切账号后误报已配好

根因：`describeExternalClient` 只验证当前站点地址和非空 Key，没有账号归属；前端 scope 已包含站点和 userId 并清理旧请求，重新扫描仍拿到错误的 configured=true。

1. 已完成：核实后端配置检测、主进程账号来源、前端切换与请求失效逻辑。
2. 已完成：主进程持久化账号关联，以站点+userId、客户端、地址和 Key 指纹匹配；WorkBuddy、Claude Desktop、OpenCode 只有关联当前账号才显示已配好。用户明确选择沿用“已有第三方配置”样式，缺失/未知归属均保留该状态及打开/配置入口；扫描不读取远端 Key，不自动覆盖实际客户端配置。旧配置不自动认领，当前四个 WorkBuddy 模型和 Key 未修改。
3. 已完成测试和构建：4 文件 162 项定向单测、11 项浏览器回归通过，涵盖同站点切账号、跨站点、退出、应用重启、外部改 Key、多个 WorkBuddy 模型分别归属、旧扫描晚返回。完整 `npm run typecheck`、`npm run compile` 通过；11 个相关文件 UTF-8 无 BOM、`git diff --check` 通过；独立代码复核未发现实质问题。证据为 `artifacts/external-account-ownership-unit.log`、`artifacts/external-account-ownership-typecheck.log`、`artifacts/external-account-ownership-compile.log`。新 `npm run dev` 已启动（cmd PID 83404、Electron PID 71928），watch 0 错误，5173 返回 HTTP 200，原生窗口可读取。重启后观察到 WorkBuddy 配置及新账号关联记录均于 19:31:43 更新，窗口显示已配好，符合显式保存后的状态；本轮工具未执行真实客户端配置保存，也未切换用户真实账号作验证。旧账号展示由隔离回归验收。

## 当前任务：WorkBuddy桌面配置路径错误

后续模型补充已完成（2026-09-18）：按用户要求在真实 `.workbuddy/models.json` 加入 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.5`，沿用原 `gpt-6-astra` 的 Key 和地址。回读确认四个模型 ID 唯一，原模型完整保留，新增条目凭据/地址一致。通过现有事务 writer 分别备份，首份原始备份为 `models.json.bak.20260918110937143`；执行脚本为 `artifacts/add-workbuddy-models-2026-09-18.cjs`，日志不含 Key，未发起模型请求。重新进入 WorkBuddy 模型页或重启刷新。

用户截图及本机脱敏读取已确认：星芒将 `gpt-6-astra` 写入 `C:\Users\peaker\.codebuddy\models.json`（对象根），WorkBuddy桌面实际读取 `C:\Users\peaker\.workbuddy\models.json`（当前为空数组）。此前lite-wb运行时验证不能证明桌面端读取成功，“已配好”状态基于错误文件。

1. 已完成：核实本机正式 WorkBuddy 5.5.6 的 `app.asar`。默认全局路径为 `.workbuddy/models.json`，支持数组和对象根，UI 保存数组；模型 ID 不加 `custom-local:` 前缀。此前目录错误是直接原因，对象格式本身兼容。证据为 `artifacts/workbuddy-model-contract-2026-09-18/report.md`。已有文件监听可触发同步，已打开设置页需重新进入，不能保证所有外部写入场景都热更新。
2. 已完成：桌面配置写入和状态检测改为 `.workbuddy`，新增文件使用数组，保留原有模型/字段及对象格式；空数组、已有模型、旧路径不读取不误判、事务备份与服务整合两文件 95/95 通过。未改变 OpenCode 分层配置语义。
3. 文件迁移完成，原生 UI 验收受限：使用修复后的事务 writer 将用户已选择的 `gpt-6-astra` 写入 `C:\Users\peaker\.workbuddy\models.json`；原 Key/地址一致，`.codebuddy` 原文未变，原空数组备份为 `models.json.bak.20260918103301250`。回读确认根为数组、模型一条、检测 configured=true，无模型请求。WorkBuddy 当前已打开的设置页面有缓存；原生窗口激活返回 `failed to activate captured window`，截图恢复返回 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`，因此不能宣称桌面列表已验收，需重新进入设置或重启客户端刷新。迁移脚本在 `artifacts/migrate-workbuddy-desktop-config.cjs`，不输出 Key 且要求目标为空数组，不能重复覆盖现有文件。
4. 已完成：`npm run typecheck`、`npm run compile` 均通过，`git diff --check` 和 8 个改动文件 UTF-8 无 BOM 检查通过；客户端说明、README、历史实施记录和 lite 审计均纠正路径和证据范围。日志为 `artifacts/workbuddy-desktop-typecheck.log`、`artifacts/workbuddy-desktop-compile.log`。旧星芒开发实例已停止，`npm run dev` 新实例后台 cmd PID 71360、Electron PID 73404，watch 0 错误，`http://127.0.0.1:5173/` 返回 HTTP 200。启动日志为 `artifacts/workbuddy-desktop-dev.stdout.log`。未结束真实 WorkBuddy 会话、未调用生产模型、未提交或发布。仅真实桌面列表刷新验收仍受第 3 项原生工具故障限制。

## 后续任务：客服入口按账号来源分流

用户指定：首次打开/未登录/NewAPI 使用 `https://work.weixin.qq.com/kfid/kfc3ac7eece5344c034`；Sub2API 登录后使用 `https://work.weixin.qq.com/kfid/kfcffe6f62fdaa0ccf4`。二维码与浏览器按钮必须使用同一地址。

1. 已完成：共享地址解析绑定实际登录状态和账号来源，未登录时忽略残留的历史账号元数据；主进程白名单包含两条精确URL，legacy备用界面同步。
2. 已完成：当前界面使用对应客服二维码，账号切换时隐藏旧二维码，退出Sub2API恢复未登录客服；保留既有客服弹窗布局。
3. 已完成：地址/安全/IPC定向测试327通过、2跳过；完整 `npm run typecheck`、`npm run compile` 通过。4项客服浏览器回归验证二维码数据和跳转地址一致（未登录含残留来源、NewAPI、Sub2API、Sub2API退出）；fixture退出保留来源后，原有退出相关2项回归也通过。UTF-8无BOM及差异检查通过。
4. 已完成：开发实例已重启，主进程两条精确URL白名单生效，`http://127.0.0.1:5173/` 运行中，watch编译0错误。验证日志为 `artifacts/support-routing-unit.log`、`artifacts/support-routing-typecheck.log`、`artifacts/support-routing-compile.log`。未真实打开客服或发送消息，未提交、推送、发布。

## 当前任务与边界

基线 `main@ccf1eab`（0.2.5），工作区保留此前客户端、加载优化的未提交改动。用户要求修复列出的 8 项问题，自主测试调试、逐项记录，不重新开始此前已完成的 D 项安装工作。不进行生产付费操作，不输出或替换真实 Key，不提交、推送、发布代码。第 8 项授权范围包括 GitHub 主分支保护配置，执行前读取现有状态并保留回读证据。

## 分析与复核

项目为 Electron 主进程服务/IPC + React renderer-v2。普通开发和生产均使用 renderer-v2，不能只修 legacy 页面。账号服务已支持显式 siteId，但普通登录流程需要检查其呈现和找回路径。Sub2API 适配器复用 NewAPI DTO，源码已确认订阅 total/used 取同一个 usage 字段、能力声明过粗。聊天 storage 的通用 text() 默认截断 40,000 字符，与持久化写入不对称。工具来源存在 renderer localStorage 标记，需要将自动覆盖授权收回主进程。

复核维度：读写完整性、未知值语义、能力与实际方法一致、筛选/时间范围契约、账号域选择与隔离、配置所有权与并发、CI 必需检查实际触发。远端保护状态以本轮 API 读取为准，不直接沿用用户报告。

## 执行计划

| 项目 | 状态 | 实施与验收标准 | 负责人 |
| --- | --- | --- | --- |
| E1 长聊天存储 | 完成，模块验收通过 | 长文/思考/旧记录完整；4 MB/50 对话超限保留原文并阻止覆盖；37 单测+25 浏览器 | clients |
| E2 手动 Key 保护 | 完成，整合及独立复核通过 | 主进程持久化路径/端点/密钥指纹归属；缺失/损坏/外部修改保留；431 整合测试通过；拒绝后不误报成功，14 单测与10页面回归通过 | root / clients |
| E3 订阅额度 | 完成，模块验收通过 | 日/周/月分别表达，nullable 限额，不再将 usage 用作总额 | models |
| E4 操作与数据能力 | 完成，模块验收通过 | 查看/购买/余额支付/偏好及任务/趋势细分；看板明确累计汇总；331 单测+29 浏览器覆盖业务 | models |
| E5 筛选与时间 | 完成，模块验收通过 | Key ID/分组 ID/计费来源/模型/日期/时区完整映射；不支持明确拒绝；IPC 10 项与首页契约2项通过 | models |
| E6 双账号与找回 | 完成，模块及桌面验收通过 | 登录来源显式选择；凭据按域；找回正确域路由与官网兜底；87 单测+12 IPC+19 认证浏览器+1 App 场景，隔离 Electron 重启测试通过 | startup |
| E7 合入约束 | 工作流完成，远端权限阻塞 | quality-gate 对文档/代码均产生结果；18 项测试通过；打包资源和校验输入不可跳过；GitHub admin=false，PUT protection 返回404，尚未启用远端保护 | root |
| E8 整合验收 | 完成，保留明确环境限制 | 类型/构建/页面/隔离Electron通过；全量单测4项受Windows符号链接权限限制；UTF-8及差异检查通过；开发窗口已重启置前 | root |

## 分工约定与恢复规则

clients 修改聊天存储与对应 hook/测试；models 修改 Sub2API、共享业务 DTO/能力和账号业务页面；startup 修改认证/找回页面及账号服务；root 修改工具配置归属、自动配置执行器、CI/远端治理和整合。共享文件先协调，保留所有已有变更。每完成一项追加结果、测试命令与局限。恢复时先读本文件，仅继续未完成项。

## 验证结果

模块报告：`docs/RELIABILITY-CHAT-2026-09-18.md`、`docs/RELIABILITY-AUTH-2026-09-18.md`、`docs/reliability-sub2api-2026-09-18.md`。

E2 基线 31 项通过，新增主进程来源持久化测试后 42 项通过。随后 system-service/IPC 整合首轮 425 通过、30 跳过、4 失败，失败均为 IPC mock 的 saveConfig 第四参数断言未更新，补充自动/显式来源断言后为 431 通过、30 跳过。完整 typecheck 已通过。独立复核未发现可复现的手动 Key 自动覆盖路径；另发现 bootstrap 会将保护性拒绝误报为配置成功，已修复：后端失败优先，成功必须同时具备后端成功结果、可用配置和主进程 account 归属。最终 bootstrap 单测14项及受影响页面回归10项通过；renderer 类型检查通过。来源记录绑定工具/实际文件路径/端点/密钥指纹/认证方式，落盘于主进程数据目录的 `tool-config-ownership/`，不保存明文密钥。

E8 全量结果：`node --test src/renderer-v2/testing/app-check.mjs` 86/86 通过；`npm run compile` 成功，保留现有大于 500 kB 的 bundle 提示。`npx vitest run electron src --no-file-parallelism --testTimeout=30000` 为 4357 通过、162 跳过、4 失败（322 个文件）。这 4 项都在未改动的 backups/path-identity/safe-local-data 安全测试中，创建 Windows 符号链接时发生 EPERM，测试尚未进入被测拒绝逻辑；不能据此声称全仓全绿。证据保存在 `artifacts/reliability-full-vitest.log`、`artifacts/reliability-app-browser.log`、`artifacts/reliability-compile.log`。

`npm run test:node` 全部成功（126 脚本 + 20 业务/布局 + 62 UI，共208项）。独立复核增加的2项CI回归另行通过。最后 bootstrap 修改后又执行10项受影响页面回归和生产编译，分别见 `artifacts/reliability-bootstrap-final-browser.log` 与 `artifacts/reliability-compile-final.log`，均成功。已检查103个改动文本文件，UTF-8 无 BOM、无替代乱码字符；`git diff --check` 无空白错误，只有既有 CRLF 转 LF 提示。

`node e2e/realm-account-smoke.mjs` 隔离 Electron 桌面回归通过：同邮箱同密码显式选择两站、错误密码与2FA不回退且保留会话、找回绑定来源、账号切换、画布账号事件、重启恢复、退出。3次启动的隔离目录和网络封锁自检成功，实际网络请求0，未生成付费内容。证据为 `output/realm-account-review/result.json`。测试实例已全部退出。

开发实例已使用最新源码重新执行 `npm run dev`，Vite 服务为 `http://127.0.0.1:5173/`，Electron 开发窗口已置前，watch 编译0错误。原生只读 accessibility 复核可见首页“你的工具”中的 WorkBuddy、Claude Desktop，以及“还可以装”中的 OpenCode；未在真实账号界面执行配置、付费或模型调用。开发进程保留给用户使用，日志为 `artifacts/reliability-dev.stdout.log` 和 `artifacts/reliability-dev.stderr.log`。

本轮代码修复与本地验收完成，远端保护保持 E7 阻塞状态。未提交、推送或发布；下一次恢复先读此表和具体模块报告，不重复 E1-E6 的已完成工作。仍需管理员凭据及工作流进入主线后才能完成远端保护启用；4项本机符号链接测试需具备相应Windows权限的运行环境验证。已遭旧版本覆盖且不存在副本的聊天内容无法恢复；Sub2API 尚未接入的趋势/任务/购买能力已如实禁用或标注。

E7 独立复核修正：CI 文档分类采用有限位置白名单。`docs/canvas-third-party.json`、校验使用的 `docs/CANVAS-THIRD-PARTY.md`、bundled skill Markdown、打包 assets、发布说明及 Git 配置均执行代码检查。新增回归后 `node --test scripts/ci-workflow-config.test.cjs` 18/18 通过。

E7 远端核实：main SHA仍为 ccf1eab2f59020bd9b38927375da8bfedf604f05，protected=false、rulesets=[]。凭据权限 push=true、admin=false、maintain=false。`PUT /repos/xufei5620/xingmang-ai-manager/branches/main/protection` 使用落盘 `docs/main-branch-protection.json`，GitHub HTTP 404，远端没有修改成功。需要具备仓库 Administration 写权限的凭据才能启用。工作流尚未提交/推送；必须先让 quality-gate 工作流进入主线，再应用该保护配置，不能先要求一个还不存在的检查。管理员同样受规则约束，没有配置自动化绕过。
