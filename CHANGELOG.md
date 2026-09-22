# Changelog

> **仓库里有两份发版日志，用途不同，发版时都要更新：**
> - **[`release-notes.md`](release-notes.md)（根目录）** —— 面向用户。打包时写进更新清单并显示在客户端更新页，
>   见 `docs/RELEASING.md`。发版必更，覆盖 0.1.20 起的全部版本。
> - **本文件** —— 面向开发者的变更记录，没有程序消费者。
>
> **两份的未发布条目都不直接写在文件里**：每条 PR 在 `changes/unreleased/` 下放一个分片文件，
> 发版时 `npm run changelog:collect` 汇总进下面的 `## Unreleased` 段与 `release-notes.md` 的「未发布」段。
> 写法见 [`changes/unreleased/README.md`](changes/unreleased/README.md)。
>
> **0.1.13 ~ 0.2.5 的条目是 2026-09-19 从 git 历史回补的**（审查总表 P-14）：内容取自各版本提版提交的
> 说明与该区间的提交，日期取提版提交自身时区下的 `git log --date=short`。写得比同期 PR 粗，只求这段区间
> 不再是空白；要精确到改了哪一行请直接查对应提交。
>
> **0.1.14 ~ 0.1.20 没有条目**：这些版本号在本仓 `main` 的 `package.json` 历史里从未出现过
> （0.1.13 直接跳到 0.1.21），只有 `release-notes.md` 留下了 0.1.20 的用户条目。

## 0.2.9 - 2026-09-23

- A2 余项。`ToolStatus` 增加可选字段 `installTarget`：这个 CLI 装上去会落在哪个目录。未装时 `installDirectory` 为 null，而「复制路径」要回答的正是这一刻的问题。
- `electron/system-service.ts` 新增纯函数 `cliInstallTargetDirectory(provider, options)`，把 `installCli` 的落点选路重放一遍（托管 npm 布局优先，Grok 的 Windows 原生通道单列，其余落在当前 npm 全局根下），算不出来返回 null。`inspectCliTool` 里的 `resolveCliInstallTarget` 负责按平台与 `windowsExecutionMode` 决定传不传托管 prefix，并吞掉 ProgramData / HOME 解析失败——探测不该因为一个附带字段失败。
- `OperationFailure` 增加可选字段 `tool`，`perform(label, work, tool?)` 与卸载确认都会带上；目录本身由 `App.tsx` 在渲染那一刻用新的 `toolInstallDirectory(snapshot, tool)` 从当时的快照里取（`installDirectory ?? installTarget`），不缓存在失败对象里。
- `OperationActionId` 增加 `'copyPath'`，`actionIds` 收下「复制路径」；`operationErrorActions(failure, installDirectory)` 像过滤「重试」一样过滤它——没有目录就不出按钮。复制在对话框内部完成，不经 `onAction`，因此不会关掉对话框。
- `registry/errors.ts` 的 `permission` 条目改为 `{ title: '写不进安装目录', actions: ['复制路径', '查看日志'] }`，「以管理员身份重试」从目录里删除；`operation-error.test.ts` 加了一条断言钉住它不再出现。
- 路径只上屏、只进剪贴板：不拼进错误正文，不进 `runtime.jsonl`，不进诊断导出（I13）。
- A2：`src/renderer-v2/operation-error.ts` 补 `unsafeStorage` 分类、把 `backupIntegrity` 对齐 `backups.ts` 真正抛的「备份文件已损坏或被篡改」，新增 `operationFallbackActions()` 让 `errors.unknown` 的按钮落地。
- 新增 `undoFailed` 守卫：消息里出现「回滚/回退/撤回…失败」时一律不套目录文案，避免把安抚盖在 `ManagedNpmRollbackError` 这类句子上。
- 失败对话框从 `App.tsx` 抽成 `features/app/OperationErrorDialog.tsx`，可用 `renderToStaticMarkup` 直接断言标题与按钮。
- `operation-error.test.ts` 改成表驱动，16 类目录条目逐条给出样例消息或不可达原因（paymentClosed / paymentTimeout / noTray / unknown）。
- N4：`ToolKeyLimits` 增加 `toolKeyLimitReached`，到上限时换文案并加 `已到上限` 标记；未沿用 `errors.noBalance` 正文，因为「充值到账后立即恢复」对单工具上限是错的。
- 功能清单 A5（issue #68）：新增第四种系统通知 `cliUpdate`
  （`electron/platform/contract.ts`、`notifications.ts`），设置页的开关由
  `registry/business.ts` 的 `notificationOptions` 自动多出一行，默认开启。
- 角标数字与首页「N 个有更新」同源：`features/tools/update-notice.ts` 的
  `pendingToolUpdates` 复用 `ToolPresentation.updateAvailable`，更新检查失败
  （`updateCheck: 'failed'`）与镜像没有新包的 Codex 桌面端都不计入。
- 提醒抑制按「工具 + 目标版本」记在本机（`xingmang-v2-cli-update-notice`），
  重启后不会重念；用户更完某个工具后该工具从记录里消失，将来再出新版本会重新提醒。
- `parsePlatformPreferences` 改为按默认值补齐缺失的开关：旧版本写下的
  `platform-settings.json` 里没有 `cliUpdate`，若继续要求每个键都在，升级后连
  主题都读不出来；开关值不是布尔仍然拒绝。
- 功能清单 A6：`src/renderer-v2/registry/tools.ts` 新增 `firstRunHints`（`Record<ProviderId, ToolFirstRun>`，漏一个 CLI 是编译错）与 `ToolDef.firstRun` 可选字段；命令取各 CLI 的裸命令，与主进程 `resolveCliCommand`（argv 恒为空）真正启动的那条一致，`registry/tools.test.ts` 钉住两者相等。
- 命令与提示词的展示合成一个组件 `features/tools/FirstRun.tsx`，引导 ready 步（`features/auth/StartGuide.tsx`）与首页建议卡（`features/tools/Home.tsx`）共用；复制失败也有回音，避免按了没反应。
- 首页建议卡的关闭状态走 `features/tools/first-run-dismissal.ts` 的 localStorage 键，不新增主进程通道；读回来的内容按已知工具 id 校验，坏数据不会让首页白掉。Codex 桌面端是图形界面，没有命令，因此不参与。
- 功能清单 A7：`pages-maintenance.tsx` 的 `tutorialTopics` 补三章，内容逐条对照 `pages-management.tsx` 的真实表单字段、提示文案与各 CLI 的实际能力（技能导入仅 Codex / Gemini，插件市场仅 Codex，Gemini 的技能与插件可在页内开关）写成，并导出该常量。
- 新增 `pages-maintenance.test.ts`：钉住三章存在、章节标题与 `registry/pages.ts` 的页面名一致、每章四步且步骤字段非空、所有步骤跳转目标都是真实页面 id、章节 id 不重复。
- 功能清单 A8（关联 issue #69 ④）。`src/renderer-v2/features/shell/tour-state.ts` 把界面导览的状态（pending / seen）记在 localStorage，按账号分键；从没有记录的老账号一律当作不用播，升级上来不会凭空多出一段导览。
- `App.tsx`：引导完成时记 pending，导览看完或被关掉记 seen，回到首页时读 pending 决定是否重播；新增 `openGuide` / `replayTour` 两个动作传给设置页。
- `pages-maintenance.tsx`：两行入口收口到 `OnboardingSettingRows`，测试可以单独渲染断言；宿主没提供 `replayTour` 时不渲染那一行。
- 新增 `electron/acceleration-conflict.ts`：连接前只读地探测系统代理占用情况（Windows 走 `createWindowsSystemProxy` 新增的 `inspect()`，macOS 走 `/usr/sbin/scutil --proxy`），以及 Windows 上的 VPN 虚拟网卡名。macOS 的 utun 名对所有隧道一视同仁（iCloud 专线代理、接力都会建），据此判断 VPN 只会误报，所以那侧只判代理。
- 检测到冲突时 `startAcceleration` 直接返回带 `conflicts` 的状态，不写账本、不启内核、不动系统代理；渲染层据此给出提示与「仍然连接」，后者以 `ignoreConflicts` 重发同一次连接。契约里 `AccelerationConflictKind` 是封闭集合，探测细节（代理地址、网卡名）不跨 IPC、不进日志。
- 检测结果与用户的决定记进 `runtime.jsonl`：`acceleration.conflict.detected` / `acceleration.conflict.ignored`，沿用 `acceleration.start.failed` 的 stage 上报通道。
- 探测本身读不到时按无冲突放行，连接路径与检测存在前完全一致。
- 新增 `electron/acceleration-expiry-notice.ts`（纯函数 + 注入时钟/定时器，无 Electron 依赖，
  `acceleration-expiry-notice.test.ts` 覆盖）：订阅 `acceleration-service` 的 `onState`，
  按剩余时长排一个「剩 5 分钟」的检查点和一个到点检查点，到点去读一次状态让服务把新状态
  发出来，再据此判断发哪一条。
- **触发点放主进程而不是渲染层**：渲染层的 `features/acceleration/controller.ts` 把每秒计时
  与 15 秒轮询都挂在「窗口可见」上，窗口缩到托盘之后这两样都停着——而那正是时长用完的
  时候。后端自己的到期定时器（`acceleration-development-backend.ts` 的 `arm`/`stopSession`）
  停会话时不产出状态，没人去读就没人知道，所以那一次读由这个模块补。它**不自己停加速**，
  停止仍由后端定时器与渲染层负责。
- 「已断开」只认 `exhausted`：停止失败的会话停在 `stopping`、隧道可能还在，那时候说已断开
  是假话，改为有限次重读后收手（日志 `acceleration.expiry.unsettled`）。同一次连接的两条
  通知共用 `scope:connectedAt` 作去重键，重连换一个编号。
- `electron/platform/contract.ts` 把通知类型拆成两层：渲染层能自己请求的 `PlatformActivityKind`
  （install / balance / task / cliUpdate），以及多出 `acceleration` 的 `PlatformNotificationKind`
  （只进偏好集合，`platform/ipc.ts` 的 `notify-activity` 通道拒收它，渲染层无法绕过
  「亲眼看着连上」那层判断去弹通知）。`settings-store.ts` 与各处默认值补 `acceleration: true`，
  老配置文件缺这一项按开启读（同 cliUpdate 的做法）。
- `electron/platform/notifications.ts` 把固定文案分成渲染层活动与主进程两张表，新增
  `notifyHost(event, eventKey, onClick?)`，复用原来的开关判断、去重、四条上限与点按聚焦；
  新增 `electron/platform/host-notification-bridge.ts` 把 `install-system-api.ts` 建起来的通知
  服务转给 `main.ts`（两边互不 import，同 `runtime-log-bridge.ts` 的处境）。与日志桥不同的是
  **不缓冲**：晚到的「还剩 5 分钟」比不发更糟。
- `RendererNavigationTarget` 增加 `acceleration`，点通知直接落在游戏加速页；legacy 回滚界面
  没有这个页面（发通知的系统通知服务也只在 renderer-v2 下装起来），`src/App.tsx` 只跟着契约
  加一行忽略，行为不变。
- `acceleration-contract.ts` 新增封闭的失败原因集合 `accelerationFailureReasons` 与对应中文文案，
  连同 `withAccelerationReason` / `accelerationFailureReason` 两个工具。跨进程只传原因名，不传错误原文
  （与 `AccelerationStartFailureStage` 同一条 I13 约束）。
- `acceleration-development-worker.ts` 在失败应答里带上 `classifyAccelerationWorkerFailure` 归出来的原因；
  `acceleration-development-host.ts` 校验后挂到自己抛出的错误上。`acceleration-service.ts` 不再把所有后端
  失败收成 `BACKEND_FAILURE`，认不出的才保留原来那句话。
- `ensureReady` 里「准备辅助进程工作目录」与「拉起进程」原来共用一个 `try/catch`，errno 和原文一起吞掉：
  一台永远起不来的机器在 `runtime.jsonl` 里只剩「本机加速进程启动失败。」，定位只能靠反编译压缩产物数
  字节（2026-09-22 客户机）。现在两步各自接住，经新的 `onHelperFailure` 回调记到 `acceleration.helper.failed`，
  带上原因、errno 与底层错误；`ipc.ts` 的失败日志另加 `accelerationReason` 字段便于检索。
- `AccelerationView.tsx` 的错误条按 `operationLogPage` 的既有口径给出「查看日志」入口（加速没有 `tool`，
  永远落反馈页），落点规则不另写一份。
- 新增 `electron/acceleration-preference-store.ts`：按账号 scope 落一份
  `acceleration-preferences.json`（原子写、单文件、最多 64 个账号，超出时丢最久没动过的
  那几条）。记的是**用户亲手选的那一条**而不是上次实际连上的那条——选「智能分配」时后端
  自己挑出来的线路是后端的选择，不该被记成用户偏好，所以 `lineId: null` 是有效记录。
  读坏了一律降级成「从没选过」，绝不抛错：这份数据丢了最多是少记一次偏好，与免费时长账本
  不是一个量级。不入 `settings.json`，因为那份会整份交给渲染层（`electron/acceleration-preference-store.test.ts`）。
- `acceleration-contract.ts` 新增 `AccelerationPreference` / `AccelerationPreferenceUpdate` /
  `AccelerationPreferenceApi` 与 `isAccelerationLineId`；`acceleration-service.ts` 实现这两个
  方法并做入参校验（I5），**刻意不走它那条串行队列**：队列里排着的可能是一次十几秒的连接，
  界面点一下线路不该等它。新增 IPC 通道 `acceleration:get-preference` /
  `acceleration:save-preference`（按字段更新，线路与模式两处界面互不覆盖）。
- `tray-acceleration.ts` 与 `codex-desktop-acceleration.ts` 的 `connect` 多收一个当前状态，
  由宿主（`main.ts`）把记住的选择落到一次真正的连接上。模式只在状态明确报了
  `supportedModes` 且包含它时才跟着走，报不出就用标准模式：托盘与自动连接都是静默发起的，
  不能因为一份旧记录就替用户改系统网络设置（TUN 仍然不开）。
- 渲染层 `features/acceleration/lines-controller.ts` 在拿到第一份线路列表时套用记住的线路，
  之后的刷新沿用界面上的选择（偏好写入是异步的，再读一次会把刚选的那条弹回旧值）；
  记住的线路不在列表里就回退智能分配并清掉记录。`controller.ts` 同样在首次读状态后套用
  记住的模式，用户这次动过开关就不再套用。读写偏好失败一律吞掉，不影响连接与界面。
- `electron/windows-elevation.ts` 新增 `inspectWindowsElevationCapability()`，回答的是
  「这个账号能不能提权」，与既有的 `inspectCurrentWindowsProcessAdministrator()`（「现在
  是不是管理员在跑」）是两件事：UAC 过滤后的令牌里 `BUILTIN\Administrators` 仍在 Groups
  列表里（deny-only），所以普通进程也问得出组成员身份。按 SID `S-1-5-32-544` 比对，
  不受 Windows 显示语言影响；探测失败一律返回 `'unknown'`，绝不因此挡住安装或自检。
- 同一文件新增 `windowsElevationCancelledMessage` / `windowsElevationDeniedMessage` /
  `windowsStandardAccountAdvice` 三个纯函数，`node-runtime.ts` 的
  `nodeRuntimeElevationFailureMessage` 与 `codex-desktop-appx.ts` 新抽出的
  `codexDesktopElevationFailureMessage` 共用它们，退出码 1223（取消）与 740（没拿到权限）
  在拿到 `'standard'` 时换文案。两处只在这两个码上多花一次探测，探测在
  `CodexAppxInstallDependencies` 上可注入——单测不为一句文案真起一次 PowerShell。
- `diagnostics.ts` 的 `ADMINISTRATOR` 项加可注入的 `inspectElevationCapability`，
  只在 `platform === 'win32'` 且当前不是管理员时问；`details` 多一个 `canElevate`
  （`true` / `false` / 探不出来时 `null`）。macOS 走原路径，输出一个字没变。
- 渲染层新增 `src/renderer-v2/features/tools/elevation-notice.ts`：
  `elevatedInstallNotice` 是完整一句，`elevatedInstallShortNotice` 是首页工具行
  那一行小字放得下的短版，两者是所有出口的唯一文案来源。挂在四处：首页运行环境卡
  （Node.js）、首页 Codex 桌面端那一行、「安装卸载」页的运行环境行与工具行。
  Python 按当前用户装（`InstallAllUsers=0`）、四个 CLI 走 npm，都不提权，所以
  都没有这句；探测失败的行也不出这句（那时并不知道它装没装，同 A4）。
- 不做「以管理员身份重试」（已定不做），也不做免管理员的用户级 Node——那会撞
  `node-runtime.ts` 的受保护路径校验。第七批候选 4。
- 项目规矩改名到 `AGENTS.md`，根目录 `CLAUDE.md` 只留一行 `@AGENTS.md` 导入：Claude Code
  自 CLI v2.1.277 起支持直接读 `AGENTS.md`，但只在工作目录及其上层没有 `CLAUDE.md` 时才读，
  且 Bedrock、关闭遥测或版本偏低的会话读不到，所以按官方推荐保留导入式的 `CLAUDE.md` 外壳，
  Codex / Cursor 等其他 agent 工具则直接读 `AGENTS.md`。不用符号链接是因为 Windows 上
  git 会把它检出成一行普通文本文件。仓库内的引用一并改名（脚本注释与断言文案、`.claude/rules/`、
  `docs/`、`.github/` 模板、`.editorconfig`、主进程与渲染层注释），已发布的 `CHANGELOG.md`
  条目和引用 git 提交标题的行保留原名；`scripts/ci-change-scope.cjs` 的文档白名单两个文件名都收。
- 新增 `electron/install-cancellation.ts`：按操作名登记正在进行的安装，`cancel` 返回
  `{ cancelled, reason }`；不可中断的阶段调 `seal(原因)`，此时取消被拒绝并把中文原因回给渲染层。
  登记名与 `InstallationQueue` 的去重键一致，句柄在入队之前登记，排队等待中的安装也能取消。
- 新增两条 IPC 通道：`cli:cancel-install` 与 `desktop:cancel-install-codex`，各自紧跟对应的安装通道，
  `ipcInvokeChannels` 键顺序与 `ipc.ts` 注册顺序同步（T1）。
- CLI 侧：`executeNpm` 的每次 `executeCommand` 与 Grok 签名下载都带上 `signal`
  （`executeCommand` 本来就会在 Windows 上用 `taskkill /T /F` 连子进程树一起杀）；
  镜像回退循环在每次重试前检查取消，避免「点了取消只是换一条源接着下」；
  `replaceManagedNpmPrefixAtomically` 与 Grok 可执行文件替换两段 `seal`（I9、I11）。
  `grok-installer.ts` 的 `downloadLatestGrokBinary` 新增可选 `signal`，取消后不再试下一个镜像地址。
- Codex 桌面端：`downloadCodexDesktopPackage` 与 `downloadCodexDesktopPackageFromCandidates`
  新增可选 `signal`，取消后既不继续下载也不回落到上一版本；超时与取消在 catch 里分开判断，
  取消不会被说成「连接或下载超时」。`Add-AppxPackage` 与关闭运行中进程那一段 `seal`。
- 取消统一抛 `InstallCancelledError`，进度事件与 `runtime.jsonl` 都记成取消而不是失败。
- 渲染层：`useToolbox` 的 `run` 接受 `cancel` 回调并新增 `cancel(key)`，用户点过取消后吞掉那次拒绝，
  不再弹「安装工具没有完成」；首页工具行与「安装卸载」页在安装进行中显示「取消」。
- 下载与 npm 跟随系统代理的接线（#231、#238）未改动。
- `electron/network-failure.ts` 新增 `NetworkFailureReason` 的 `certDate` 一类，正则认 `ERR_CERT_DATE_INVALID` / `CERT_HAS_EXPIRED` / `CERT_NOT_YET_VALID` 与 OpenSSL 散句 `certificate has expired` / `certificate is not yet valid`，排在 `tls` 之前（`tls` 那条的 `ERR_CERT` 前缀会把日期类一起吞掉）；这几句同时从 `tls` 的正则里移走，两类各有归属。账号与更新两张表共用同一句文案——它说的是这台电脑，与连的是账号服务还是更新目录无关（第四批候选 4）。
- `src/renderer-v2/operation-error.ts` 新增 `certDate` 规则（同样只认 `classifyNetworkFailure`，不自写正则），排在 `tlsIntercepted` 之前、`timeout` 之前；`registry/errors.ts` 补一条目录文案「证书日期对不上」。裸 EPERM、EBUSY、`diskFull`、`tlsIntercepted` 的归类都没动。
- `electron/diagnostics.ts` 的 `XINGMANG_NETWORK` 在探测通过后，用这一次 HEAD 响应头里的 `Date` 与 `dependencies.now()` 比一次：差超过 `MAX_CLOCK_SKEW_MS`（5 分钟）返回 `warn` 并在 `details.clockSkewMinutes` 记下带符号的分钟数，没有 `Date` 头或解析不出来就完全不判。新增两个顶层纯函数 `clockSkewMs` 与 `clockSyncGuidance`（按 `platform` 给对时入口）。不新增任何请求。
- `src/renderer-v2/features/chat/browser-check.mjs` 的 `open()` 原先拿被测元素 `chat-composer-input` 当挂载等待，用的是 Playwright 默认的 30 秒，没接 `e2e/fixture-readiness.mjs`（#164 起的共享挂载预算）。Windows 冷跑撞上 30 秒就红，失败信息指向元素、看着像聊天页坏了（同一条用例 Linux 本地 12.6 秒通过）。现在改成先等 `#root > *` 挂上、用共享的 `fixtureReadyTimeoutMs`，挂载之后的断言一律保持 30 秒默认值。
- `scripts/ci-workflow-config.test.cjs` 的夹具等待门禁原先只核对一张手写清单，清单漏了谁就看不见谁——聊天夹具就是这么漏掉的。现在改为扫描 `e2e/` 与 `src/renderer-v2/` 下自己开页面的 `.mjs` 套件，每一个都必须落在「已接预算」或「已登记欠账」两张表之一，新增套件两边都不在就会红；已接预算的套件另外不许再写死 `timeout: <数字>`。门禁的判定抽成纯函数并补了自测（写死等待要红、没接预算要红）。
- 扫描顺带查出另外五份同样没接预算的浏览器套件，本 PR 不动它们，先登记进欠账表留待单独处理：`e2e/canvas-group-refresh.mjs`、`src/renderer-v2/features/acceleration/browser-check.mjs`、`src/renderer-v2/features/shell/announcement-persistence.browser-check.mjs`、`src/renderer-v2/features/shell/newapi-announcements.browser-check.mjs`、`src/renderer-v2/ui/browser-check.mjs`。
- 新增 IPC 通道 `extensions:ensure-marketplace`（`ensureProviderMarketplace`），主进程 `ProviderExtensionService.ensureMarketplace` 复用上一条 PR 的 `ensureClaudeOfficialMarketplace`，非 Claude 的 Provider 直接报错。通道在 `ipc-contract.ts` / `preload.ts` / `ipc.ts` 三处的位置一致（`ipc.test.ts` 的顺序断言对顺序敏感）。
- `pages-management.tsx`：Claude 的「市场」页签不再走 Codex 的市场列表分支，而是渲染 `plugin list --available` 的可装清单；未安装条目给一颗「安装」按钮，并且不再被画成「已停用」。市场状态的文案抽成纯函数 `officialMarketplaceNotice`，按 T7 用纯函数覆盖。
- `pages-maintenance.tsx`：教程「插件」一章改掉「插件市场仅 Codex」的旧说法，补上 Claude Code 的「添加官方市场」与 Git 前提；`pages-maintenance.test.ts` 钉住这句不再退化。
- `electron/provider-extensions.ts`：`mutate` 在 Claude 插件安装前调用 `ensureClaudeOfficialMarketplace`——先用 `claude plugin marketplace list --json` 判断官方市场是否在册（命令失败时回落到读 `~/.claude/settings.json` 的 `extraKnownMarketplaces`），缺失才跑 `claude plugin marketplace add anthropics/claude-plugins-official`，超时给 240 秒（CLI 自己的缓存刷新与 clone 各 120 秒，更短会把它的解释换成一条通用超时）。
- 市场缺失的根因：官方市场只在 `claude` 首次交互式启动时注册，而本软件一律非交互 spawn CLI，共用同一个 `~/.claude`。
- `marketplace add` 依赖 git，装前用注入式 `findExecutable('git')` 探测，缺失时抛出分平台的中文提示（Windows 指向 git-scm.com，macOS 指向 `xcode-select --install` 或 Homebrew），失败原因经 `registerTrustedHandler` 照旧落 `runtime.jsonl`。
- 新增 `ProviderCliInvocationOptions.extraEnvironment`，由 `isNetworkBoundExtensionMutation` 判定的出网操作（非 MCP 的 install / update）与市场添加带上代理变量；`main.ts` 用 `subprocessDownloadProxyEnvironment` + `resolveProxy('https://github.com/')` 接线，沿用 #231 的回环代理约束。命令解析仍用不带代理变量的基底环境。
- `ProviderExtensionsSnapshot` 新增可选的 `marketplace`（`name` / `registered` / `reason`），让界面能分辨「没有可装的」和「市场还没加进来」；仅 Claude 填充，其余 Provider 缺省即旧行为。
- `provider-extensions.test.ts`：更新钉死的安装断言，补「无市场先加市场」「已有市场不重复加」「缺 git 报错且不发命令」「列表命令失败回落用户设置」「快照市场状态」「代理只给出网命令」等用例。
- 第六批候选 6。新增 `electron/claude-status-line.ts` 与随包脚本
  `bundled-catalog/cli-status-line/xingmang-statusline.cjs`（随 `files` 进包、随
  `extraResources` 落到 asar 外——命令由外部 node 执行，读不了 asar 里的路径）。
  `saveProviderConfig` 新增可选参数 `claudeStatusLineCommand`，缺省 = 不写状态行；
  `system-service.ts` 在写 Claude 配置前解析一次托管 Node 的绝对路径，解析不到、脚本没
  随包拷进来、或路径里带 `"` `$` 反引号 `%` 这类 shell 元字符就不写。
- `merge` 路径只在 `statusLine` 缺省时写；已有的一律不动，唯一例外是本软件自己写过的那条
  （按脚本文件名认），软件换安装位置后把命令指回新路径，否则会变成一条指向旧路径的死命令。
  官方账号模板不写状态行。
- 脚本只读 Claude Code 从 stdin 递来的 JSON，不出网、不读任何配置文件、不碰 Key；
  字段名以 2.1.278 的真实入参为准（`docs/CLI-VERIFIED-VERSIONS.md` 记了抓到的原文与
  `used_percentage` 为 `null` 的坑）。
- 新增 `electron/cli-process-probe.ts`：更新与回滚前按这个 CLI **自己的 npm 包目录**匹配运行中的进程（Windows 走
  `Get-CimInstance Win32_Process`，由 `resolveWindowsPowerShellExecutable` 给出绝对路径并经 `trustedCommandEnvironment`
  净化，目标目录用环境变量 `XINGMANG_CLI_PROCESS_ROOT` 传入、只用 `.StartsWith`/`.IndexOf` 比较，不拼进脚本文本也不做正则；
  macOS 走 `/bin/ps -xo pid=,args=` 只列当前用户）。匹配进程镜像或命令行是否落在包目录内，所以 `node` 进程本身、
  同一个全局前缀下的其他 CLI、用户自己另装的一份都不会被算进来。命令行只在 PowerShell 里参与过滤，不跨进程边界（I13）。
- 检测只用来把话说对：命中只在安装对话框里多一行提醒，不拦更新；失败、超时、被拒都归 `unavailable`，写进 `runtime.jsonl`
  （`cli.running-processes.probe`）后照常继续。
- `src/renderer-v2/registry/errors.ts` 新增 `toolRunning`（「工具正在运行」），`operation-error.ts` 把 `EBUSY` / `ETXTBSY` /
  `resource busy or locked` / 「文件被占用」/「正被…占用」从 `installBlocked` 拆出来，排在 `permission` 之前；`installBlocked`
  只留真的在说杀毒软件的说法。顺带把 `codex-sessions.ts` 那句「会话文件正被其他程序占用」也从「杀毒」挪到这一类。
- `system-service.ts` 的 `installCliOperation` 在托管目录原子替换失败、以及所有 npm 源都失败时，调
  `describeOccupiedCliFailure` 重数一次进程：`EBUSY` / `ETXTBSY` 自己就足以改写成「文件被占用」；`EPERM` / `EACCES`
  两说，只有真数到这个工具的进程才改写，数不到就让「需要管理员权限」原样出去。`ManagedNpmRollbackError` 不改写，
  它的 `preserveTransaction` 与渲染层「不套安抚文案」都依赖原话。
- Grok 走原生更新通道，不做这项检测。同样没有覆盖的还有非 npm 来源（官方安装器 / PATH 其他来源）的安装，
  那些本来就不出 npm 更新按钮。
- 测试：`electron/cli-process-probe.test.ts` 在非 Windows 上真起两个进程验证「只认包目录里那一个、不认普通 node」；
  Windows 专有两条——占住文件句柄后对同名目录做更新路径里的 `rename`，断言归到 `toolRunning`（不钉 errno，
  目录改名遇到被持有的文件在 Windows 上可能报 `EBUSY` 也可能报 `EPERM`）；另一条跑真实 PowerShell 探测脚本。
  Linux 允许重命名含打开文件的目录，所以这两条在沙箱里 skip。
- CI 加 `cli-relay-probe` 作业（`scripts/probe-cli-relay.cjs`）：PR 改到
  `electron/cli-verified-versions.ts` 或 `docs/CLI-VERIFIED-VERSIONS.md` 时，装上名单钉住的那个
  Claude Code 版本，对 `relay-sites.ts` 里每个中转站点各跑一次 `claude -p` 最小请求，结论写进
  job summary。名单挡住的两次上游回归都是 CLI 自己发出的请求被第三方端点拒掉，`curl` 手搓的请求
  验证不了这一类，只能跑真的 CLI。探测密钥走仓库 secret `XINGMANG_CLI_PATROL_KEY`，只通过子进程
  环境变量交给 CLI、不进 argv，输出统一脱敏；secret 不存在时作业照常通过，但 summary 里写明
  「未在中转实测」。只有「400 类拒绝」判定版本不可用，401/403 与额度、5xx 分类报成探测自身故障。
  `scripts/ci-change-scope.cjs` 新增 `cliVersions` 输出驱动这个作业，`quality-gate` 接受它
  skipped、拒绝它变红。配套加 `scripts/probe-cli-relay.test.cjs`，并接进 `npm run test:scripts`。
- 同时建了每周一 01:00 UTC 的巡检例程：比对 npm latest 与名单，有新版就读上游 changelog 找网关
  相关回归，没回归开草稿 PR 抬版本、有回归改为加 `blocked`，一律不自动合并。运行方式与判定口径写进
  `docs/CLI-VERIFIED-VERSIONS.md`。
- `electron/config-files.ts` 写配置时关掉四个 CLI 自带的更新机制：Claude Code 的
  `settings.json` `env.DISABLE_AUTOUPDATER = '1'`，Gemini 的
  `general.enableAutoUpdate` / `general.enableAutoUpdateNotification`，Codex 的
  `check_for_update_on_startup`，Grok 的 `[cli] auto_update`。`reset` 与 `merge` 两条路都写，
  `merge` 只增改这几个键；切回官方账号不收回（CLI 仍由本软件装和更新）。
- 不写 Claude 的 `DISABLE_UPDATES`：那个连手动 `claude update` 也一起禁掉。
- 沙箱实测记在 `docs/CLI-VERIFIED-VERSIONS.md` 的「CLI 自己的更新机制」一节：Claude 与 Codex
  有 `claude doctor` / `codex doctor` 的前后对比，Gemini 与 Grok 只验到配置被接受，键名出自
  它们自己打包的文档与 settings schema。
- `electron/cli-verified-versions.ts` 扩到三个工具：`codex.recommended = 0.155.1` 并把
  `[0.155.0, 0.155.1)` 写进 `blocked`（上游 `rust-v0.155.0` 让新会话默认索要 detailed
  推理摘要，不支持的 provider 直接拒绝请求，次日 `rust-v0.155.1` 热修）；
  `gemini.recommended = 0.60.0`、`blocked` 留空（0.57~0.60 全是安全加固，未发现与
  第三方 base URL 相关的回归）。Grok 仍留空，行为不变。
- `CliVersionAdvice` 新增可选字段 `recommendedIsNewer`，由主进程比过版本号后给出；
  渲染层的 `recommendedVersionVerb` 据此在「更新到」和「回到」之间选词，首页副标题、
  行内按钮与菜单项三处共用，图标也跟着换。缺省保持旧文案。
- `scripts/probe-cli-relay.cjs` 从写死的 `claude` 改成按 `probeRunners` 表跑三个工具：
  Claude 走 `claude -p`、Codex 走 `codex exec`（配置与 `buildCodexRelayConfigTemplate` 同形，
  `wire_api = "responses"`）、Gemini 走 `gemini -p --skip-trust --approval-mode plan`。
  每个工具 × 每个站点一次真实请求，只有 400 类拒绝才判定版本不可用。
- Codex 对自定义 model provider 不认 `OPENAI_API_KEY` 环境变量（对 0.155.1 实测：设了它
  请求里仍是 `auth.header_attached=false`），只读 `$CODEX_HOME/auth.json`，所以探测把它那份
  密钥以 0600 写进一次性临时 HOME、跑完即删；另外两个工具仍只走子进程环境变量，三条路径都不经 argv。
- `classifyProbe` 新增 `group` 一类：三个工具的托管 Key 各绑一个 new-api 分组
  （`catalog.ts` 的 `managedCliKeyProfiles`），一把只覆盖单一分组的巡检 Key 会被中转答成
  「当前分组下无可用渠道」，那是密钥问题不是版本问题，报告里直接说清要换什么样的 Key。
  仍然只用 `XINGMANG_CLI_PATROL_KEY` 这一个 secret，不新增第二个。
- `quality.yml` 的 `cli-relay-probe` 触发条件不变，步骤名与超时跟着三个工具调整（20 → 40 分钟）。
- `docs/CLI-VERIFIED-VERSIONS.md` 加了三家的覆盖表、Codex 这次的依据与链接、每个工具的探测形态，
  以及把每周巡检扩到 Codex / Gemini 的建议（routine 本身不在这个改动里）。
- `electron/system-service.test.ts` 里两条关于「已验证版本名单」的断言不再写死 `2.1.277`，改成从
  `cliVerifiedVersions.claude.recommended` 读，配套加了 `recommendedClaudeVersion()` 与
  `versionAboveRecommended()` 两个取值器。原先抬一次推荐版本就要跟着改一次测试，而「改测试迁就
  代码」恰恰是这份名单最不该养成的习惯。已装的 `2.1.276` 仍写死：它落在名单里那条
  2.1.275–2.1.277 的不兼容区间里，是历史事实，不会随巡检移动。行为无变化。
- `electron/config-files.ts`：Codex 中转模板去掉 `disable_response_storage`、`network_access`、
  `windows_wsl_setup_acknowledged` 三个顶层键。用 0.155.1 的二进制核对过：前两者在当前版本里
  一处都搜不到、功能连同键一起被删且无替代；`network_access` 只作为 `[sandbox_workspace_write]`
  的布尔字段存在，顶层那行从来没生效过（`codex doctor` 显示 `restricted network`，写成嵌套的
  `true` 才变 `enabled network`），所以只删不搬——搬过去等于替用户放开沙箱联网。
- 新增 `dropDeprecatedCodexConfigKeys`，在 `applyCodexRelayConfig`（合并写入）与
  `stripCodexRelayFromConfig`（切回官方账号）两条路径上清掉这三个键，且只清值与当年模板一致的
  那一份；用户改过值的、以及嵌套表里的 `sandbox_workspace_write.network_access` 都不动。用户
  自己的官方配置快照仍按原文保存，切回官方时原样还回去。
- `scripts/probe-cli-relay.cjs` 的 Codex 探测配置同步去掉 `disable_response_storage`，保持与
  客户装到的那一份同形。
- 新增 `electron/codex-desktop-acceleration.ts`：打开前的连接协调器。走的是与用户点「连接」
  完全相同的 `acceleration-service.startAcceleration`（完整连接、会改系统代理），**不是**
  `download-acceleration.ts` 的下载专用线路——桌面端是独立进程，只认系统代理。
  `active` / `connecting` / `stopping` 一律不动，`exhausted`、额度为 0、`unavailable`
  与读不到状态都跳过；15 秒预算，超时、失败、后端拒绝（冲突检测）全部收敛成一句日志，
  `ensureConnected` 永不抛错。同一时刻只连一次（连点两下「打开」共用同一个请求）。
  不含 Electron 依赖，可单测。
- `codex-desktop-service.ts` 增加可选 seam `prepareAcceleration`，在 macOS 与 Windows 两条
  拉起路径上、确认桌面端已安装之后、真正启动之前各调用一次；缺省不做，旧调用方行为不变。
- `system-service.ts` 仅做透传（`prepareCodexDesktopAcceleration`），`main.ts` 把它接到
  加速服务上（模式固定 `system-proxy`，不指定线路，沿用用户选过的那条）。IPC 契约与渲染层
  一行未动。
- `electron/codex-desktop-service.ts` 的镜像清单探测与 MSIX 下载此前一直用主进程全局 `fetch`
  （Node 的 undici，不读系统代理），而加速只接管系统代理，于是 Codex 桌面端的下载无论加速
  开关都走直连。PR #231 已经把 Grok 二进制、Node.js LTS 与 npm 子进程接回系统代理，这次把
  同一条注入点补给 Codex 桌面端：`createCodexDesktopService` 新增必填的 `downloadFetch`，由
  `system-service.ts` 传入主进程的 `net.fetch`（Chromium 网络栈，读系统代理）。
- 为避免同类回归再次静默发生，`probeCodexDesktopManifests`、`fetchCodexDesktopMirrorRelease`、
  `fetchCodexDesktopPreviousManifestCandidates`、`downloadCodexDesktopPackage` 与
  `CodexDesktopCandidateDownloadOptions.fetchImplementation` 一并去掉了 `= fetch` 默认值，漏传
  变成编译错误。
- 安装前先调一次 `reloadDownloadProxyConfig`（接 `session.defaultSession.forceReloadProxyConfig`），
  免得刚打开加速就点更新时 Chromium 还拿着接管前的代理配置；刷新失败只记为不生效，不影响安装。
- 新增纯函数 `describeCodexDesktopPrimaryMirrorSkip`：主源清单查询失败时排序会把备用源提到第一
  位，之前界面上只有一句「正在从镜像备用源下载」，现在把探测阶段的失败原因带进下载提示。
- `electron/codex-desktop-service.ts`：`inspectCodexDesktop` 原本用 `Promise.allSettled` 并发跑 `findCodexDesktopStartApp`（`Get-StartApps`）、`listCodexDesktopProcesses`（`Get-CimInstance Win32_Process`）、`inspectCodexDesktopPackage`（`Get-AppxPackage`）三条独立的 PowerShell，现在合成 `buildCodexDesktopCombinedProbeScript()` 一条脚本、一次输出 `{ startApps, processes, package }` 一份 JSON。三段查询文本由 `codexDesktopStartAppsQuery` / `codexDesktopProcessQuery` / `codexDesktopPackageProbeStatements` 与原来的独立脚本共用，不会各改各的。
- 段内失败仍然隔离：脚本里每段各自 `try/catch` 写 `startAppsError` / `processesError` / `packageError`，`parseCodexDesktopCombinedProbeJson` 把每段交回合并前那个解析函数（`parseStartAppsJson` + `selectCodexDesktopApp`、`parseWindowsProcessesJson`、`parseCodexDesktopPackageProbeJson`），一段失败不会把另外两段清空，也不会把「没看成」当成「确认没装」。
- 合并后 `ConvertTo-Json` 多嵌套一层，显式 `-Depth 6`；`$ErrorActionPreference = "Stop"` 只在放在最后的 Appx 段里设，前两段沿用默认的 `Continue`。
- 总超时 `codexDesktopCombinedProbeTimeoutMs = 24_000`，取三段旧预算（各 8 秒）之和——串行跑之后谁都不比合并前更紧，避免低配机上把装好的 Codex 桌面端误判成没装。整条脚本失败（超时、起不来进程）走 `buildCodexDesktopCombinedProbeFailure`，三段一起回退且 `detectionFailed` 照常亮起。
- `findCodexDesktopStartApp` / `listCodexDesktopProcesses` / `inspectCodexDesktopPackage` 三个函数本身保持不变，安装、卸载、等待进程退出等路径照旧调用它们；本次只换掉开机扫描那一处。
- `electron/codex-desktop-service.test.ts`：合并脚本形态（三段查询齐全、三段各自 catch、`-Depth 6`）、解析三段齐全 / 确认没装 / 三段各自失败 / 非 JSON / 空输出 / 整体超时，以及整体超时后 `buildCodexDesktopWindowsProbes` 仍报 `detectionFailed`；另有 `it.runIf(win32)` 真跑一次合并脚本、断言输出可解析且 Appx 段必有结论（只有 Windows CI 会执行）。
- `electron/command-runner.ts` 的 `errorMessage` 七句默认文案改中文（第八批候选 3）。`code` 字段没动，`system-service.ts` / `external-client-runtime.ts` / `workbuddy-installer.ts` / `node-runtime.ts` 里按 `code` 分支的翻译层不受影响。
- 「超时」二字刻意不用：`src/renderer-v2/operation-error.ts` 的 `networkFailure` 认这两个字，本地 CLI 卡住会被归成网络失败、套上「连不上星芒服务器」。`TIMED_OUT` 因此写成「命令执行时间过长，已中止」。
- `electron/provider-extensions.ts` 的 `errorDetail` 对 `CommandRunnerError` 追加 stderr（没有就用 stdout）最后三行、截 240 字；这两份输出在构造 `CommandRunnerError` 时已经过 `redactCommandText`（I13）。受益的是 MCP 配置 / MCP 列表 / Skill 目录 / 插件市场 / 远端版本这几处 `warnings`。
- `command-runner.test.ts` 新增一条门禁：`errorMessage` 的七条返回值必须都含中文，加一个 code 忘了翻译会当场红。几处用英文原句造 `CommandRunnerError` 的测试夹具一并改成实际会产生的中文。
- 第四批候选 5。`electron/tool-config-ownership.ts` 的 `ToolConfigOwnership` 新增 `changed`：所有权文件确实是本程序替当前账号写下的（v2 记录、`source: 'account'`、owner 对得上），但身份指纹对不上时返回它；其余判不准的一律照旧落回 `unknown`，`saveConfig` 里「来源未经确认就不自动改写」那道闸对 `changed` 同样关着，自动同步永远不覆盖被改过的配置。
- 渲染层 `features/tools/model.ts` 的 `ToolSource` 跟着加 `changed`，只收窄原先 `unknown` 的一角：排在本机手动标记与「密钥正是当前账号缓存里那把」之后，官方登录、指到别处的配置都不受影响；`connectionReady` 对它与 `unknown` 同样处理，行为不变。
- `features/tools/account-bootstrap.ts` 新增 `rewrite` 档：只有用户点名某个工具时才把被改动过的配置列为重写目标，并对主进程带上 `intent: 'explicit'`；`login` / `restore` 两档照旧跳过（新增 `changed` 这个 skip reason）。`App.tsx` 的 `rewriteAccountKeys` 只在点名工具时走这一档，整轮「一键修复」维持原样。
- 首页新增 `configChanged` 状态（`registry/status.ts`，warn 色）、`tool-<id>-rewrite-key` 按钮与「就用现在这份」菜单项；后者写的是配置对话框「自己填写密钥」同一个本机来源标记，改回星芒账号时自动清掉，没有新增 IPC 通道。
- 新增单测：所有权 store 七条（键被改 / 我们写的 base URL 被删 / 用户加的别的键不算改动 / 换账号或未登录不归因 / 自动写入仍被拒 / 显式写入可以收回 / 手动记录被改后仍是 unknown）、`sourceFor` 五条、bootstrap 计划两条、`Home` 三条，以及 `app-check.mjs` 两条浏览器用例。
- 候选 9：`electron/config-files.ts` 的 claude 分支在 `permissions` 里写 `deny: ['Artifact']`。
  `createPlans`（reset）直接写进模板；`createMergePlans`（merge）追加进已有 `deny` 数组、
  已有则不重复，用户自己写的 `deny` 项与 `permissions` 下其他键原样保留；
  `createOfficialAccountPlans`（切官方账号）只摘掉 `Artifact` 这一项，其余不动，
  `deny` 变空则连键一起删。
- 动机是 2.1.265~2.1.268 那次「第三方 Anthropic 兼容端点每轮请求 400」——上游 2.1.268 的
  修复原文说载体正是 Artifact 工具输入 schema 里的一段正则。这条 deny 是
  `electron/cli-verified-versions.ts` 版本名单之外的第二道保险。
- 验证方法（沙箱、claude-code 2.1.277、空 HOME、本地 HTTP 假接口抓请求体）：
  `permissions.deny` 不是只拦执行，而是把工具定义整条从请求体 `tools` 里摘掉——
  基线 25 个工具，`deny: ['Artifact', 'WebFetch', 'NotebookEdit']` 后剩 23 个，
  `WebFetch` 与 `NotebookEdit` 都不见了；`defaultMode: 'bypassPermissions'` 下同样生效，
  设置放 `~/.claude/settings.json` 有效。同一次抓包里 2.1.277 指向第三方端点时本来就
  没有发 `Artifact`（上游已按凭据来源把它挡掉），所以这条目前是保险而非现行修复。
- `electron-builder.config.cjs` 的 nsis 段新增 `include: 'installer.nsh'`，并新增 `build/installer.nsh`
  的 `customInstall`：electron-builder 自己的 `addDesktopLink` / `addStartMenuLink` 有两条会静默跳过的
  路径——更新器拉起的 `--updated` 安装会把 `keepShortcuts` 置为 true 而整段不执行，以及 perMachine 安装
  往公共桌面 `CreateShortCut` 失败时不检查返回值。兜底宏只在快捷方式缺失时创建，公共桌面写不进去就退回
  当前用户桌面，永不删除任何文件，`--updated` 的静默安装不进入这段逻辑。
- 新增 `scripts/windows-installer-shortcuts.test.cjs`（已接入 `npm run test:scripts`），钉住 nsis 配置里
  两个快捷方式开关与 `include` 名字、兜底脚本只增不删、以及切到 current 上下文后必须切回。
- A4：新增 `toolAvailability` 与 `updateCheckFailure` 两个纯函数（`src/renderer-v2/features/tools/model.ts`），把「探测失败 / 状态未读到 / 已安装 / 未安装」四态和 `buildCliStatus` 早就写好的两条更新检查失败原因映射成行上的文案，原因先过 `snapshotErrorMessage` 脱敏（I13）。
- `pages-maintenance.tsx` 的工具行改用 `features/tools/ToolStatusMeta.tsx` 的 `ToolStatusMeta` / `ToolStatusReason`，探测失败时版本位显示「版本未读到」而不是「未找到版本」。没有引入 broken 第三态（清单 §5）。首页工具行的 `detail` 在 A1 里已经带出 `detectionError`，未重做。
- `network-failure.ts`：`failurePatterns` 补一条 `intercepted`（`unexpected redirect` / `ERR_UNSAFE_REDIRECT` / `ERR_TOO_MANY_REDIRECTS`）。`redirect: 'error'` 下 undici 把 3xx 变成 `TypeError: fetch failed`，真正的原因只在 cause 的 `unexpected redirect` 里，此前这类失败一条都归不出来。
- `diagnostics.ts` 的 `XINGMANG_NETWORK`：自己 try/catch，用 `classifyNetworkFailure` 归类后返回 `state: 'fail'` + `networkFailureMessages[reason]`，`details` 只留 `{ endpoint, reason }`；HEAD 成功但 `content-type` 是 `text/html` 也判 `intercepted`；非 2xx 从「检查时发生错误」改为 `fail` 加一句说明网络通、问题在服务端；归不出类的异常仍走 `runIsolatedCheck` 的兜底。不新增网络请求。
- `DiagnosticsDependencies` 新增可选 `log`，由 `main.ts` 接到 `runtimeLog`（source `diagnostics`）。上游英文原文（`errorChainText` 展开 cause 链）只进 `runtime.jsonl`，不进会上屏也会被导出的报告（I3、I13）。
- `diagnostics.ts` 新增检查项 `PROVIDER_ENVIRONMENT_OVERRIDE`（标题「环境变量覆盖」，与 `PROXY_ENVIRONMENT` 并排）：只读注入的 `env`，大小写不敏感地扫 Claude / Codex / Gemini 的 12 个变量，有值报 `warn`，报告里只放变量名。`*_BASE_URL` 指向当前站点时降级为 `pass` 并注明「已指向当前账号」；`CODEX_HOME` 指到 `~/.codex` 默认位置时直接跳过——它是 `codex-home.ts` 自己注入进 `codexEnv` 的，不跳过会每次都给一条假警报。Grok 的同类变量本仓没实测过，按 T12 先不列。
- `pages-maintenance.tsx` 的 `diagnosticTarget` 加 `code.includes('ENVIRONMENT')`：新项虽然以 `PROVIDER_` 开头，「去处理」要落到设置页而不是首页。
- 文档：`docs/DUAL-REALM-DESKTOP-INTEGRATION.md` 的「登录与账号归属」一节按 main 上的实际逻辑重写。原文写的是
  「不显示平台选择器、主进程猜站、被拒后试另一站」，这套行为已被 #202（`ea544e2`，E-B2）取消：现在登录页有
  「账号来源」二选一（星芒账号 / 历史账号，默认星芒账号），`siteId` 永远显式传，明文密码只发给选中的那一个站，
  被拒即结束。同节补上注册只在星芒站、找回跟随来源、记住密码绑定来源、归属存 `realm-accounts-v2.dat` 的
  `realmId` 等当前事实，并与 `docs/RELIABILITY-AUTH-2026-09-18.md` 互相引用、各说各的范围。
- 文档：同一份文档「本地验证与边界」里 `automaticDetection: true` 那条标注为 2026-09-09 当时的记录，指向新一节。
- 文档：`docs/DUAL-REALM-IMPLEMENTATION.md` 的 D-01 说明原来只点名三个已删除模块，现在逐条给出它们当前对应的位置
  ——切换/登录/恢复在 `electron/realm-account-service.ts`，候选客户端桥接在 `electron/main.ts` 的 `createClient`
  工厂加 `electron/sub2api-relay-backend.ts`，能力投影在各后台自报的 `capabilities` 加
  `src/renderer-v2/account-context.ts`；表格里三个已删除模块的行也就地标了「已删除」。
- 新增 `electron/download-acceleration.ts`：下载临时加速协调器（按持有数计数、超时退化、
  只接受回环端点），与 `electron/download-proxy.ts` 的子进程代理过滤配套。不含 Electron
  依赖，可单测。
- `acceleration-development-backend.ts` 增加 `startDownloadRoute` / `stopDownloadRoute`：
  起内核但**不调用 `proxy.enable`**，因此不写系统代理、不进 `AccelerationState`，IPC 契约
  与渲染层一行未动。用户在下载期间点「连接」会接管同一个内核（同线路不重起），会话停止时
  若仍有下载持有内核则保留内核。`downloadRouteBillsFreeAllowance = false` 是计费开关；
  额度仍是门槛（用完不再起临时线路）。
- `main.ts` 用独立的内存分区 session（`xingmang-download-acceleration`）承载下载流量，
  租约生效时给它设回环代理，默认 session 不动；`resolveSubprocessProxyEnvironment` 在有
  临时线路时直接交出该端点。
- `system-service.ts` 把 `installCliOperation` 与 `installNodeRuntime` 整段包进
  `withDownloadAcceleration`，并让 `inspectNetworkRegion` 在加速生效时归约为 official-first
  （同时跳过区域探测）；用户钉死的 `mirrorPolicy` 优先级不变。
- T-B1：抽出 `e2e/harness.mjs`，把十四个浏览器套件各写一遍的「Vite dev server + Chromium +
  记录 pageerror 的 page」样板收进一处。此前 `XINGMANG_E2E_CHROMIUM` 的容器兜底（T-S5）与
  pageerror 采集（T-G3）都要逐个文件补，漏了也没人发现。
- T-B2：`v2-business.test.mjs`、`v2-local-avatar.test.mjs` 与
  `scripts/audit/v2-business-screenshots.mjs` 写死的首选端口（5191 / 5196）一律改成
  `port: 0`。`strictPort: false` 下写死端口只会在并行时静默换号，既没保障也没意义。
- T-B5：仓库仍不引入 `playwright.config`，改由 harness 导出默认视口与三档超时常量
  （断言 5 秒、图片类断言 7 秒、导航 30 秒），各套件不再各写一份数字。
- `scripts/ci-workflow-config.test.cjs` 跟着加门禁：`e2e/*.test.mjs` 不许再自己
  `chromium.launch()`（macos-dev-origin 例外，它驱动的是 Electron），harness 自身必须
  采集 pageerror、认容器变量、不写死端口。
- e2e 夹具的 Vite dev server 改为先向内核预约一个空闲端口、再用 `strictPort` 钉给 Vite。
  此前各处传的 `port: 0` Vite 并不认（`startServer` 把 0 当成「没配端口」），实测 8.1.5
  上三个 server 依次落在 5173 / 5174 / 5175，等于所有夹具都从同一个众所周知的端口起步，
  与本机的 `npm run dev` 抢同一段号。
- 八处各自 `createServer` 的夹具 server（`app-check` / `ui` / `auth` / `chat` /
  `acceleration` / 两个 shell 公告套件 / `macos-dev-origin`）统一改走
  `e2e/harness.mjs` 的 `createFixtureServer()`，端口一律从它返回的实际绑定结果取。
- `scripts/ci-workflow-config.test.cjs` 里按「内核分配端口」写的断言口径是错的，改成钉住
  预约 + `strictPort`，并扫描 `e2e/` 与 `src/renderer-v2/` 下新增的自起 Vite server；
  另加一条「连开八个夹具 server 不会拿到同一个端口」。画布套件按冻结约定登记为豁免。
- `src/renderer-v2/operation-error.ts` 分类表新增 `diskFull`（ENOSPC 及同类说法）与 `tlsIntercepted`（复用 `electron/network-failure.ts` 的 `classifyNetworkFailure` 归到 `tls` 的那一类），两条都排在 `permission` 与 `timeout` 之前；裸 EPERM 仍归 `permission`、EBUSY 仍归 `toolRunning` 不变。`registry/errors.ts` 补两条目录文案（候选 4）。
- `electron/network-failure.ts` 的 tls 正则补上 npm / OpenSSL 的散句写法（`self signed certificate`、`unable to get local issuer certificate`、`unable to verify the first certificate`、`certificate has expired`、`UNABLE_TO_GET_ISSUER_CERT`、`CERT_UNTRUSTED`），公司网关换证书时账号侧与安装侧的归类口径这才是同一份。
- 新增 `operationLogPage(failure)`：没有 `tool` 的失败（连接检查、写 Key、拉起终端）落 `feedback`；来自安装 / 卸载 / 更新的失败里，只有杀毒拦截、更新包校验和认不出的那几类落 `maintenance`，其余环境类（网络、证书、磁盘、权限、文件占用）同样落 `feedback`。`App.tsx` 的 `runOperationAction` 只查这张表（候选 8）。
- 新增 `electron/external-client-connection.ts`：外部客户端的连接自检。探测计划与收发、归因表
  和四个 CLI 共用一份 —— `connection-check.ts` 把结论拆成 `ConnectionProbeReport`（不含身份），
  `runConnectionProbe` 只管收发，`ConnectionProbePlan` 的 `provider`/`siteId` 换成 `name`，
  身份由 `runConnectionCheck` / `runExternalClientCheck` 各自贴上。
- 三个客户端都走只读模型清单探测：Claude Desktop 的网关地址是裸域拼 `v1/models`，
  WorkBuddy 与 OpenCode 写的是自带 `/v1` 的地址拼 `models`，落到同一个已实测端点，不花额度。
  无 `default` 分支的 switch 保证加第四个客户端时漏在这里是编译错。
- 密钥从客户端自己的配置文件读回来：`external-tool-config.ts` 拆出内部的 `inspectExternalTool`
  与 `resolveExternalToolProbeCredential`，`claude-desktop-config.ts` 拆出 `inspectGateway`
  与 `inspectGatewayCredential`；对外的 `inspectExternalToolConnection` / `inspectConnection`
  解构剥掉明文 Key 再返回（I3，同 `toNativeConfigSummary`）。只有确认归属当前账号的那一条才给密钥。
- `system-service.ts`：新增 `checkExternalClientConnection(tool, knownStatus?)` 与
  `getLastExternalClients()`；`configureExternalTool` 写完后复用同一条路自检，
  `ExternalClientConfigResult.connectionVerified` 由恒为 `false` 改成真实结果，新增 `connection`
  字段，两条成功文案去掉「未验证实际模型调用」。`knownStatus` 让保存后的复测不再多跑一轮
  Windows 上的 PowerShell 盘点。
- 新通道 `diagnostics:check-external-connection`（`ipc-contract.ts` / `preload.ts` / `ipc.ts` 三处
  同序，T1）；IPC 日志留 `tool` / `layer` / `ok` / `installed` / `siteId` / `status`，不留地址与密钥。
- `feedback-environment.ts` 的「工具与配置」段接上 `externalToolIds`，客户端三行只读上一次检测
  的快照，不为了生成报告再探测一轮。
- 渲染层：`connectionCheckView` 收 `ConnectionProbeReport`，CLI 与客户端共用同一种结果条；
  检查页只列已安装的客户端（`installed`），不给它们「重新写入 Key」；
  `ExternalClientDialog` 在保存成功的 Notice 里多一行自检结论。
- `electron/runtime-log.ts` 的 `RuntimeLogSnapshot` 增加 `currentProcessId` 与 `startedAt`，
  随现有 `runtime-logs:list` 快照返回，不新增 IPC 通道；条目 id 里本来就带写入进程的 pid，
  配上启动时间才能排除 pid 被系统复用的旧条目。
- 新增 `src/renderer-v2/features/app/runtime-log-filter.ts`：纯函数 `filterRuntimeLogs` /
  `isCurrentBootEntry` / `runtimeLogSourceOptions` / `formatRuntimeLogEntry`，表驱动单测覆盖
  来源、本次启动与组合条件。
- `pages-maintenance.tsx` 的 FeedbackPage 用上主进程早就算好、渲染层一直没读的
  `snapshot.sources`；单条复制走渲染层 `navigator.clipboard.writeText`，内容是主进程已脱敏
  的日志行，与反馈报告里的单行格式一致。
- 新增 `electron/feedback-environment.ts`（纯函数）拼这段文本，数据取自 `main.ts` 缓存的上一份
  `scanSystem` 快照与 `inspectProviderConfig`，不触发新的扫描或网络探测；配置按用户当前站点对账
  （同 `diagnosticsService.checkConnection`）。
- `RuntimeLogStore` 新增 `attachEnvironmentDescriber`，`captureFeedbackReport` 给这段读取 2 秒预算，
  超时或抛错都退回「未能读取」，报告照常生成。Grok 沿用 #287 的口径不标安装来源。
- 第五批候选 7：`electron/feedback-self-check.ts` 新增纯函数
  `buildFeedbackSelfCheckLines`，把最近一次 `DiagnosticsReport` 与最近一次连接自检
  拼成报告里的「最近一次自检」段；状态词沿用检查页结果条的 正常 / 需留意 / 待处理
  （`error` 与 `fail` 同列「待处理」），连接自检按归因层写「密钥有问题」这类说法，
  `unconfigured` 仍按「未配置」而不是失败。
- `runtime-log.ts` 把原先只服务「工具与配置」的限时取数抽成 `describeSectionLines`，
  新增 `attachSelfCheckDescriber`；两段各自计时，一段超时或抛错不影响另一段，
  都没接上时整段不出现。段落位置在「工具与配置」之后、「运行日志」之前。
- `main.ts` 接线：`latestDiagnostics` 直接复用（诊断导出本来就留着它），
  `diagnosticsService.checkConnection` 顺手把 `{ ok, layer, summary, checkedAt }`
  记进一张按 provider 的表——刻意不留 `endpoint` / `siteId` / `detail`，报告里不出现
  地址与站点名。结论再过一遍 `redactDiagnosticText`（与诊断导出同一份敏感值，I13）。
- 超过 24 小时的结果在时间后标「（较早）」；时间戳解析不出来时不猜，原样写出。
- `#265` 把夹具等待门禁改成扫描实际套件之后，查出另外四份浏览器套件仍拿被测元素当挂载等待、用的是 Playwright 默认的 30 秒：`src/renderer-v2/features/acceleration/browser-check.mjs`（等加速导航）、`features/shell/announcement-persistence.browser-check.mjs`（等公告按钮）、`features/shell/newapi-announcements.browser-check.mjs`（等 `before()` 里的解析器 import）、`ui/browser-check.mjs`（等组件检阅页标题）。Windows 冷跑撞上 30 秒时，失败都被报成那个元素没出现，看着像功能坏了。四份现在都先等挂载、用 `e2e/fixture-readiness.mjs` 的共享预算，挂载之后的断言一律保持原有超时。
- 挂载等待本身也收进 `e2e/fixture-readiness.mjs`，导出 `waitForFixtureMount()`：默认等 `#root` 出现首次提交，轮询放在 Node 侧——装了 `page.clock` 的页面定时器与 `requestAnimationFrame` 是暂停的，加速页夹具正是在导航前冻结了两者。`src/renderer-v2/testing/app-check.mjs` 原先自己写的那份轮询改为调用它，只保留自己那条「宿主全局装好了没有」的判定。
- 门禁跟着改两处：判定「接没接预算」现在认 `fixtureReadyTimeoutMs` 或 `waitForFixtureMount` 任一；「不许写死等待」收窄成只拒绝 >= 30000 的数字，因为短于 Playwright 默认值的超时是「要求某件事快点发生」的断言，与挂载等待正好相反（`ui/browser-check.mjs` 断言提示条 4 秒内消失就是这种）。两条都补了自测。
- 门禁的欠账表清空到只剩 `e2e/canvas-group-refresh.mjs`，按项目约定画布不动，原因写在表里。
- `src/renderer-v2/registry/tools.ts` 新增 `officialAccountNotes`（`Record<ProviderId, string | null>`，漏键是编译错），给官方来源挂一句按工具走的限制说明；`gemini` 的 `officialAccountNames` 改为「Google 企业版账号」。依据 google-gemini/gemini-cli discussion #27274：Google 自 2026-06-18 起不再服务个人账号，Gemini CLI 只剩企业版 Code Assist 与 API Key 两条路。
- 配置对话框在来源分段器下方直接渲染这句说明（`tool-source-note`），确认连接这一步在来源仍是官方时也带上（`guide-official-note`）。只改文案，官方来源的选择与保存逻辑不动；新装的 Gemini 默认来源仍是星芒账号（`sourceFor` 的 `missing` 回落到 `account`），浏览器用例钉住了这一点。
- 候选 4：新增零依赖的 `electron/git-runtime.ts`，把「缺 Git 会怎样 / 怎么装」的分平台中文文案收成唯一来源，`provider-extensions.ts` 的插件市场缺 Git 提示（#277）改为复用它，避免两处各写一份。PowerShell 退回那句只在 Windows 成立，macOS 不照抄。
- `system-service.ts` 的 `scanSystem` 增加 `inspectGit()`（版本号只保留数字段），`SystemSnapshot.runtime` 加 `git: ToolStatus`；探测失败按 A4 走 `buildToolStatusFromSettled` 归成「检测失败」，与「未安装」区分，且不连累 node/npm 探测。
- `diagnostics.ts` 增加 `RUNTIME_GIT` 检查项，缺失记 `warn`（Git 官方文档明说 optional）而非 `fail`，摘要用共用文案。
- 渲染层：首页运行环境卡（`features/tools/Home.tsx`）渲染 Git 行，缺失时给中文提示，Windows 额外给「下载 Git」按钮（落点 `git-scm.com/download/win`，已并入 `main.ts` 外链白名单 I12）；`FirstRun.tsx` 增加可选 `gitHint`，仅 Claude Code 且缺 Git 时显示；教程「开始使用」章补一句 Git 的作用。`ui/brand.tsx` 的运行环境图标表加入 Git。
- 新增 `src/renderer-v2/features/tools/ttl-cache.ts`：按时间复用结果的读缓存，并发的
  `read` 共用同一趟请求；`invalidate()` 同时让此刻在飞的那一趟作废，它晚回来时既不写回
  缓存也不挡住下一趟（「只认最后一次请求」）。失败不进缓存。
- `features/tools/api.ts` 的 `recent()` 改走这个缓存（`recentSessionsTtlMs` = 60 秒），
  并在 `install` / `uninstall` / `launch` 完成后自动作废；另外导出 `invalidateRecent()`。
- `App.tsx` 增加 `refreshRecent()`：作废缓存的同时递增 `recentRevision` 传给 `Home`，
  让正开着的首页立刻重读。调用点为首页「重新检测」、`syncAfterToolInstalled`
  （覆盖「安装卸载」页那条绕开 `toolsApi` 的安装路径）、账号 scope 变化，以及记录页
  「接着聊」——`SessionsPage` 新增可选的 `onResumed`，经 `BusinessPage` 的
  `onSessionResumed` 透到 `App`。
- 覆盖：`ttl-cache.test.ts` 6 条（命中、过期、并发共用、作废、作废中途的守卫、失败不缓存）、
  `api.test.ts` 新增 9 条、`testing/app-check.mjs` 一条浏览器用例（首页→记录页→首页
  不再读盘，点「重新检测」真去读）。
- `features/tools/api.ts` 的 `launch` 以前只把 mode 传给 `launchCodexDesktop`，
  CLI 分支直接把它丢了，所以工具箱那一层根本发不出 `resumeLast`。改成两侧各取自己
  认得的取值：codexDesktop 认 `'open' | 'restart'`，四家 CLI 认 `'new' | 'resumeLast'`；
  不点名 CLI 模式时仍按两个参数调 `launchCli`，线上行为与以前一致。
- `features/tools/Home.tsx` 的「最近」卡复用 `latestSessionIdsByWorkspace`（#292 记录页
  用的同一个纯函数）判断哪一行能续接：续接参数是 CLI 按工作目录找最近一条、不按会话 id
  挑，所以按钮只长在每个（工具 × 目录）组合最近的那条上，归档过的记录不给按钮。
  判断依据是 `api.recent()` 取回的整份记录（60 条），不是卡片上显示的那 3 条。
- `App.tsx` 的 `launch` / `requestLaunch` / `launchRemembered` 把 CLI 模式透传下去；
  记住的目录已经不在时仍退回目录选择器开新对话（N7 的老行为）。
- Grok 在没有历史会话时会直接报错退出，这是 CLI 自己的行为，按 #292 的结论不加兜底。
- 图文教程集中到独立功能模块和内容注册表，配图使用主题自适应的本地操作示意，不包含真实用户数据或远端图片依赖。
- 新增 `electron/disk-space.ts`：`fs.statfs` 读剩余空间，目标目录还不存在时向上退到最近
  一级存在的目录再问；读不到一律返回 null（fail-open），不为一个查不到的数字拦下安装。
  另 `fs.stat` 取设备号，用来把同一块盘上的两处目录合成一条。
- `system-service.ts` 的 `installCliOperation` 在起任何子进程之前预检临时事务目录与托管
  目录两块盘，取更紧的那一块；低于 1 GB 抛出带「磁盘空间不足」的中文错误，由
  `src/renderer-v2/operation-error.ts` 已有的 `diskFull` 一类呈现，不新增分类。
  `codex-desktop-service.ts` 经新的 `assertInstallDiskSpace` 选项复用同一条门槛。
- `diagnostics.ts` 新增 `DISK_SPACE` 检查项：看 CLI 落点（托管目录）与主进程注入的
  `userDataDirectory`，同盘只报一条，低于 1 GB 记 `fail`、低于 2 GB 记 `warn`，
  `statfs` 读不到记 `warn`「未能读取」而不是失败。未新增 IPC 通道。
- 更新处于 `downloaded` 时的退出确认：`window-lifecycle.ts` 的 `confirmQuitWhileBusy` 改名为
  `confirmQuit`，返回值加 `'install-update'`，并新增可选的 `installDownloadedUpdate`；安装器在
  `quitting` 置位之后、`options.quit()` 之前拉起，免得它自己发出的退出又被这套流程拦一次。
- `quit-blocking-tasks.ts` 新增 `resolveInstallableUpdateOnQuit`：只认 `downloaded` 且无 `error`
  的非开发态快照——带 `error` 的 `downloaded` 说明安装器已经启动过并失败，`requestInstall` 不会
  再跑第二遍。`main.ts` 把「安装在跑」和「更新已下载」排进同一个回调，一次退出最多弹一个框。
- `updater.ts` 的 `autoInstallOnAppQuit` 保持 `false`，安装仍然只由用户点头触发。「每次询问」
  那条路径和 Windows 关机 / 注销（`session-end`）照旧不问，与 #331 一致。
- `src/renderer-v2/App.tsx`：把装完之后的 `syncAfterToolInstalled`（写账号 Key + 重新检测）
  挪进 `toolbox.run` 的同一个任务里。此前安装 IPC 一返回任务就结束，工具行随即回落到
  安装前的快照，在同步 Key 和两次重新检测跑完之前一直显示旧版本号并重新挂出「更新」
  按钮（yoyo 2026-09-20 Windows 真机反馈①，Codex 桌面端与四个 CLI 同一条路径）。
- `useToolbox` 的 `run` 现在把一个 `report(label)` 回调交给操作本身，长任务可以在途中
  改写工具行上那句话；进度事件那条既有通道不变。
- `src/renderer-v2/testing/app-fixture.tsx` 新增 `cliUpdate` 查询参数与
  `holdNextScan` / `releaseScan`，`app-check.mjs` 用它们钉住这一段：重新检测落地之前
  工具行不得放回「更新」按钮或旧版本号。
- `build/installer.nsh` 新增目录页守卫：顶层定义 `MUI_PAGE_CUSTOMFUNCTION_LEAVE`，在 `customHeader`
  里实现 `xingmangVerifyInstallDirectory`。它按 electron-builder `instFilesPre` 的同一条规则先补出
  真正会被写入的目录（不然选 `D:\Downloads` 会被误拒），目录里有本程序主 exe 或卸载程序时直接放行，
  否则非空就弹中文提示并 `Abort` 停在目录页。`electron-builder` 调 makensis 带 `-WX`，一旦将来目录页
  之前多出别的 MUI 页面把这个 define 吃掉，该函数会变成未引用函数让打包当场失败，守卫不会静默失效。
- `build/installer.nsh` 新增 `customRemoveFiles`，替换掉 electron-builder 默认的 `RMDir /r $INSTDIR`。
  `customInstall` 收尾时把安装目录的顶层条目写进注册表 `${INSTALL_REGISTRY_KEY}\InstalledEntries`
  （`Count` 最后写，写不全就当作没有清单），卸载时只删清单里的条目，最后用不带 `/r` 的 `RMDir` 收尾，
  目录里还剩别的东西就保留。更新器拉起的 `--updated` 路径仍复用上游的 `un.atomicRMDir` / `un.restoreFiles`
  做原子改名与失败还原，只是范围收窄到清单条目。读不到清单（老安装程序装的）时沿用旧做法。
- 新增 `scripts/windows-installer-install-directory.test.cjs`，钉住上面两条；
  `scripts/windows-installer-shortcuts.test.cjs` 里"永不删除"的断言收窄到 `customInstall` 一段。
- 第二批候选 1：把自检的密钥 / 分组层与目录里的 `keyInvalid` 都接到已有的重写路径上，
  不新做核对逻辑，也不改主进程的签发流程。旧队列项「本地 Key 与账号签发交叉核对」并入这条：
  服务端→本机的复用（`new-api-client.ts` 的 `findNewestUsableCliKeyByGroup`、
  `sub2api-relay-backend.ts` 的按名字 + 分组复用）与配置路径上的 401 自愈
  （`account-cli-provisioner.ts`）都已存在，缺的只是失效之后的下一步。
- `src/renderer-v2/features/tools/connection-check.ts`：`ConnectionCheckView` 加
  `action: 'rewrite-key' | null`，`credential` / `group` 两层在可重写时给 `action` 而不是
  `target`，并把正文换成与按钮一致的那句（主进程的 `nextStep` 仍是「到账号页看看」，
  按钮已把这件事端到面前时再让用户先跑一趟就自相矛盾）。新增 `rewritableKeyProviders()`，
  按 `sourceFor(...) === 'account'` 决定哪几个工具给得出按钮。
- `src/renderer-v2/pages-maintenance.tsx`：`BusinessActions` 加 `onRewriteKey` 与
  `rewritableKeys`；`ConnectionRowNotice` 按 `view.action` 渲染
  `health-connection-rewrite-<provider>`，重写成功才调用抽出来的 `loadConnections()` 重测，
  失败由页头的 `ResultNotice` 原样说出主进程的话。
- `src/renderer-v2/operation-error.ts`：`OperationActionId` 加 `'repair'`，`actionIds` 加
  「一键修复」。`src/renderer-v2/App.tsx`：`runAccountBootstrap` 把结论（`result` / `error`）
  回给调用方——它自己只把失败收进首页横幅，而按重写的人站在别的页面上；新增
  `rewriteAccountKeys(providers?)` 复用 `syncAfterToolInstalled` 那条同样的
  `runAccountBootstrap(userId, 'login', true, providers)`，失败原样抛出；
  `runOperationAction` 的 `repair` 分支对全部已配置工具跑同一条流程。
- 测试：`connection-check.test.ts` 钉住两层的 `action`、其余层仍跳页、来源不对时不给按钮，
  以及 `rewritableKeyProviders` 的三种来源；`operation-error.test.ts` 钉住 `keyInvalid`
  给的是 `repair` 而不是兜底的「找客服」；`testing/app-check.mjs` 三条浏览器用例分别钉住
  「密钥层点按钮 → `configureManagedCliKeys` 只带这个工具 → 自动重测变正常」、
  「重写失败 → 显示后端原话且结论不被刷掉」、「keyInvalid 的一键修复触发同一条重写」。
  夹具新增 `connectionCredential` 开关与 `window.v2Test.failMessage`。
- 修掉 `electron/system-service.test.ts` 的测试隔离问题：最新版探测的总预算
  （`settleLatestVersionProbes`）到点只是不再等，底下那批探测在丢掉结果之后仍会接着
  往备用源发请求——npm 的镜像→官方源那一跳要等满 10 秒，Grok 的 x.ai→GCS 那一跳同理，
  都落在用例结束之后，于是串进后面用例的 `vi.stubGlobal('fetch')` 桩里，让无关 PR 假红
  （2026-09-22 PR #326 的 Windows vitest 分片中过一次：三条 `/latest` 撞上一条断言
  「不该发请求」的安装用例）。
- 做法：预算到点时 abort 一个交给探测那侧的 `AbortController`。手里那次请求照旧跑完
  （它还可能给缓存留下有用的结果），但不再启动备用源；半途撂挑子攒出来的失败不写
  缓存，免得按失败 TTL 钉住让紧跟着的那次扫描连试都不试。超时时长、用户看到的结果
  都没动。`fetchGrokStableVersion` 新增可选 `abandonedSignal`，缺省即旧行为。
- 补了两条钉住的用例：离线预算那条用例在断言之后打掉挂住的请求并核对请求数不再增长
  （去掉实现里的守卫就会红），以及 `settleLatestVersionProbes` 只在预算真到点时
  abort 传入的控制器。
- 新增 `scripts/macos-artifact-names.cjs`，macOS 产物文件名收口到这一处：electron-builder 仍按 `${arch}` 打出构建名，发行名是 `XingMang-AI-Manager-<版本>-Apple-Silicon-arm64.*` 与 `…-Intel-x64.*`。架构后缀刻意保留——electron-updater 的 `MacUpdater.filterFilesForArch` 靠更新文件 URL 里是否含 `arm64` 子串分架构下载，`e2e/macos-launch-smoke.mjs` 与产物校验按 `-<架构>.zip` 结尾匹配，单测把这条钉住。
- 新增 `scripts/rename-macos-chip-artifacts.cjs`：在 `dist:mac:free` 的构建（含带加速线路时的分架构合并）之后、产物校验之前，把六个产物改成发行名并同步改写 `latest-mac.yml` 的 `files[].url` 与 `path`。改名全程只移动文件、不碰字节，摘要与体积原样成立；缺文件、目标名已存在、清单版本对不上都在移动任何文件之前失败。
- `verify-macos-free-artifacts.cjs`、`update-release-utils.cjs` 的 macOS 更新清单库存核对、`publish-dl-landing.cjs` 的安装包文件名都改读新模块；`merge-macos-free-artifacts.cjs` 合并的仍是改名前的构建名。
- electron-builder 的 `artifactName` 只有 `${arch}` 一个架构宏（`app-builder-lib/out/util/macroExpander.js`），没法把 arm64 映射成芯片名，而本机构建可能一次打两个架构，所以改名做成构建后的独立一步，而不是配置项。
- 第七批候选 3。`src/renderer-v2/pages-maintenance.tsx` 的 `tutorialTopics` 新增
  `mac-desktop-apps` 一章（共 12 章），章节 id 定义在 `registry/business.ts` 的
  `macDesktopTutorialTopic`，教程页与 `App.tsx` 共用，不写字面量。
- `TutorialPage` 新增可选 `topic` 入参（`{ sequence, id }`），`navigate(page, section)` 的第二参
  现在也服务教程页。页面挂上之后只是 hidden 不重新挂载，所以用 sequence 触发 effect，第二次
  跳转才接得住；跳转同时清空搜索框，避免目标章节被上次的关键词过滤掉。
- `App.tsx` 的 `install()` 遇到 `management === 'external'` 不再 `throw`：这不是一次失败。改为
  跳到该章 + 一条 toast，红色错误框不再出现。
- `features/tools/model.ts` 新增 `needsManualInstall(snapshot, tool)`；`Home.tsx` 据此把 macOS 上
  Codex 桌面端那颗按钮从「安装」改成「安装指南」，并把三个外部客户端在 macOS 上那颗禁用的
  「暂不支持」换成可点的「安装指南」。Windows arm64 的 WorkBuddy 仍是「暂不支持」——那是没有
  对应架构的安装包，教程救不了。
- 教程文案里四个客户端的名字从 `registry/clients.ts` 取，`pages-maintenance.test.ts` 与
  `Home.test.tsx` 各加断言钉住。
- `scripts/macos-release-keychain.cjs`：`security import` 报口令不对时，补上该查哪三件事。`security` 对「密码填错」「.p12 导出时没设密码」「base64 在传递中掉了字节」报的是同一句话，runner 上没有任何东西能把它们分开——2026-09-20 的正式发布为此白等了一轮审批。指引里不含密码本身，测试钉住了这一点；不提口令的错误原样透传。
- 新增 `electron/macos-install-location.ts`：纯函数按 `app.getAppPath()` 与
  `process.execPath` 判断是否从挂载卷根目录或 App Translocation 只读副本启动，
  仅在 darwin 且 `app.isPackaged` 时生效；装在移动硬盘子目录里的安装不算。
- `electron/main.ts` 在 `whenReady` 里、创建服务与窗口之前弹中文警告对话框
  （「退出」为默认，另有「仍要继续」），并把判定结果与用户选择写进 runtime.jsonl。
- 把已发布的 macOS 签名证书指纹填进 `scripts/macos-published-signing-identity.cjs` 的台账
  （`E42381A8…DB08`）。从这一刻起：发布用的证书必须就是它，签名预检与产物校验都会对账；
  这一张证书的 `CA:TRUE,pathlen:0`、`keyCertSign` 与 20 年有效期按 #247 的口径放行，
  其余检查一条不松。指纹是证书公开部分的哈希，不是机密。
- 新增 `scripts/macos-published-signing-identity.cjs` 作为已发布 macOS 签名身份台账。签名预检
  （`verify-macos-free-signing.cjs`）与产物校验（`verify-macos-free-artifacts.cjs`）都会拿本次发布用的
  证书跟台账里的 `PUBLISHED_CERTIFICATE_SHA256` 对账，不一致直接失败：期望指纹以前只来自发布时人工传入的
  `XINGMANG_MAC_SIGNING_SHA256`，传错一次就是全部已装 macOS 客户静默失去自动更新（Squirrel.Mac 按已装
  应用的指定要求验更新，而指定要求钉着叶证书 SHA-1）。
- 台账的 `LEGACY_PROFILE_EXEMPT_CERTIFICATE_SHA256` 按指纹放行已发布的那张旧证书的 `CA:TRUE,pathlen:0`、
  `keyCertSign` 与 7300 天有效期（2026-09-20 产品所有者的决定，理由是换证书会中断老用户的自动更新）。
  豁免只对这一张证书生效，其余 P-22 检查一条不放松：`CRL Sign` 仍拒、`CA:TRUE` 必须配 `pathlen:0`、
  EKU 仍必须只有 critical codeSigning、自签名与身份唯一性照旧、有效期只放宽到旧 profile 的上限。
- CI 的一次性临时签名路径（`--ci-temporary-signing`）通过 `publishedIdentity: false` 跳过连续性核对，也
  拿不到旧证书豁免。
- 口径写进 `docs/RELEASING.md` 2.2 与 `docs/MACOS_FREE_DISTRIBUTION.md`，含读取指纹的两条命令和换证书那天
  要清空豁免的收尾步骤。
- 把整条 macOS 正式发布路径搬到 PR 上排练。`publish-release.yml` 的 macos-build 挂
  `environment: release`，PR 上从来不跑，于是那条路唯一的验证机会就是真的发一次版，
  而每次都要产品所有者点一次批准。2026-09-20 连红四次，四次都是本可以在 PR 上就红
  的问题。
- 新作业 `macos-release-rehearsal` 与 `macos-test` 并行，用现场生成的一次性证书
  （profile 与已发布那张相同）走与发布作业**完全相同**的脚本：导入身份 → 带两个架构
  私有加速线路、按架构分两次构建再合并 → 发行名改写 → 产物校验 → 真的把包启动起来 →
  撤销并还原。不读任何 secret。
- 这一段此前在 PR 上一件都没跑过，因为 `macos-test` 里那条走的是一次性签名的自定义
  sign 钩子，而发布路径走的是 electron-builder 自己按 `CSC_NAME` 在 keychain 里找
  身份，外加 publishedIdentity 口径的签名预检与产物校验。
- `run-macos-free-build.cjs` 新增 `--rehearsal-identity <SHA-256>`：只把台账对账的
  对象换成那张一次性证书，其余一步不改。它不是「关掉连续性核对」的开关——指纹与登记的
  已发布证书相同时当场报错，而且 `publish-release.yml` 里不得出现这个开关，
  `publish-workflow-config.test.cjs` 钉着这一条。
- 顺带补上 `CSC_FOR_PULL_REQUEST`：electron-builder 在 pull_request 事件上默认整段
  跳过 macOS 签名，而且跳得很安静——包照样出，只是没签。不显式打开，这条排练会
  「通过」一个根本没签名的包，正好把它要验的东西验丢。
- 这条许可由新的 `XINGMANG_MAC_RELEASE_REHEARSAL=1` 带出来，而不是借用一次性签名
  那个标记：两者是不同的签名路径（一次性签名走自定义 `sign` 钩子，排练走
  electron-builder 自己按 `CSC_NAME` 找身份），借用会让 `electron-builder.config.cjs`
  分不清在验哪一条。新标记只接受精确的 0 或 1，与一次性签名互斥，只在免费分发模式
  下成立，且必须与 `CSC_FOR_PULL_REQUEST=true` 同时出现；它也进了构建模式变量清洗表，
  继承来的残留值决定不了出包方式。
- 修好正式发布 macOS 作业的签名身份导入，两个问题叠在一起。其一：
  `security add-trusted-cert` 不带 `-d` 走用户域，要过
  `com.apple.trust-settings.user` 授权，runner 上没有图形会话可以确认，命令一直挂着
  直到撞上脚本的 30 秒超时；改走 `sudo -n` + 管理员域，以 root 执行即通过。
- 其二：`-k` 的语义是「证书不在就装进这个 keychain」。原先指向 `System.keychain`，
  于是同一张证书在机器上有两份，`find-identity` 把同一个身份列两次，签名预检的
  「匹配项恰好一个」判成「不存在或存在选择歧义」。改成指向那个一次性 keychain，
  证书本来就在里面，不会多出一份。
- 撤销不再调用 `remove-trusted-cert`。在 runner 上实测它根本回不来（给 60 秒也挂着），
  而删掉一次性 keychain 之后信任设置就没有作用对象了，删 keychain 本身就是撤销。
- `-r` 的取值按证书的 `basicConstraints` 决定：CA 证书用 `trustRoot`，其余用
  `trustAsRoot`。
- 导入失败时把动过的东西全部放回去（还原 keychain 搜索列表、删 keychain、删状态
  文件），而不是只删 keychain。搜索列表停在一个已删除的 keychain 上，会让这台机器
  后面每一次 `codesign` 与 `find-identity` 都解析到不存在的东西。
- 收尾步骤把「keychain 已经不在了」当作完成而不是失败。它在工作流里是
  `if: always()`，之前会在导入失败之后再红一条，把真正的失败原因盖住。
- 新增 `npm run test:mac:release-keychain`，在 quality.yml 的 macOS 作业里跑。它用
  现场生成的一次性证书（profile 与已发布那张相同）走与发布作业完全相同的脚本，断言
  导入后身份恰好一个且真的能签、撤销正常退出、撤销后不留痕迹。
  `publish-release.yml` 的 macos-build 挂 `environment: release`，PR 上从来不跑，
  这条链路此前唯一的验证机会就是真的发一次版，而每次都要产品所有者点一次批准。
- 新增 `src/renderer-v2/features/tools/runtime-install-guide.ts`：按 `PlatformCapabilities`
  的 `nodeRuntimeInstall` / `pythonRuntimeInstall` 出按钮文案与中文步骤，`managed`（Windows）
  返回 null 保持旧行为，`external` 分 macOS（Homebrew + .pkg 两条路）与其他平台（包管理器）。
  首页与教程共用同一份 Homebrew 命令字符串，`pages-maintenance.test.ts` 钉住两处一致。
- 新增 `RuntimeInstallHint.tsx` 渲染步骤与可复制命令（剪贴板失败有回音，同 FirstRun）；
  `Home.tsx` 的运行环境卡按 external 能力插入这段提示，并在缺环境时多一颗「看教程」按钮，
  原官网按钮保留、文案改为「去官网下载 …」。`App.tsx` 的 `installRuntime` 未改动。
- `pages-maintenance.tsx` 的 `tutorialTopics` 新增 `runtime-mac` 章节（四步：看缺哪个、
  Homebrew、官网安装包、回来重新检测）。Windows 一侧文案与行为均未变。
- 新增 `electron/managed-cli-groups.ts`：从 `listUsableGroups()` 的结果里为四家 CLI 各挑一个
  分组，四档依次是「名单里的名字仍在」「命中另一套已知名单」「按工具专属词唯一认出」
  「退回写死名单」。认到多个、名字同时像两家工具、或命中公共分组（默认 / 生图 / 视频等）
  一律不认，退回名单后由原有的 `assertUsableGroup` 报「分组不可用」。
- `account-cli-provisioner.ts` 的签发与 401 自愈重签改用解析结果；四把 Key 都在本机缓存且
  分组名仍对得上时不发这次请求，离线启动的行为不变。
- `account-key-options.ts` 的「自动配置」分组改由调用方（`ipc.ts` 的 `account:get-key-options`）
  把解析结果传进来。刻意不在该函数内部 await：它从捕获账号与本地配置快照到第一次落盘读取
  之间必须保持同步，中间插一次网络等待会把账号切换的判定窗口拉宽。
- 服务端与两家后端都不用改，用的是账号页和聊天页本来就在用的同一个只读接口。
- 第六批候选 3 与 5。新增 `extensions:check-mcp-health` 通道与
  `ProviderExtensionService.checkMcpHealth()`：Claude Code / Gemini CLI 跑一次不带 `--json`
  的 `mcp list` 并解析它们自己打印的状态词，其余 Provider 直接回 `supported: false`。
  状态词取自 2026-09-22 沙箱里实跑的 claude 2.1.278 与 gemini 0.60.0 输出，测试用例原样钉住。
- 检测超时单列 `MCP_HEALTH_TIMEOUT_MS = 120s`：`claude mcp list` 会真的把每个 stdio 服务
  拉起来，且它自己对每个服务等满 30 秒，沿用 30 秒的通用超时会让整批落回「未检测」。
  也因为有这个代价，检测没有并进 `list()`——那一条在每次安装、卸载、开关之后都会重跑。
- `ProviderExtensionsSnapshot` 增加可选 `runtimes: { python, uv }`（`findExecutable` 探
  `python3` / `python` / `py` 与 `uvx` / `uv`），渲染层据此在添加连接与精选确认框里提示缺环境。
  缺 uv 时不假装装 Python 能解决，只在同时缺 Python 时才给安装按钮，复用既有的
  `runtime:install-python`，不新增安装通道。
- N6 第二步：`bundled-catalog/curated-extensions.json` 加 `kind: 'plugin'` 的五条（清单 `version` 2），
  新增 `install` 形态 `{type:'plugin', marketplace, plugin}` 与字段 `marketplaceCommit`。
  `curatedMarketplaceSources` 把清单能指向的市场限定在应用真会注册的官方那一个，插件名收窄到
  `[a-z0-9-]`；插件条目没写 `pinnedVersion` 也没写完整 40 位 `marketplaceCommit` 的会被解析层整条丢掉。
- `claude plugin install` 没有钉版本的开关（2.1.277 实测），所以确认框明写「安装的是官方市场当前的版本，
  我们复核过的是 <短 commit> 那一版」，并列出 `marketplace add` 与 `install` 两条命令。安装仍走
  `mutateProviderExtension`（`kind: 'plugin'`），市场在册由主进程 `ensureClaudeOfficialMarketplace`
  保证（#277），精选不新开通道。
- 入选与排除理由、钉不住版本的取舍、复核时重新取事实的命令写进 `docs/CURATED-EXTENSIONS.md`
  新增的「插件精选」一节。`security-guidance` 因 hooks 要 Python + bash 被排除。
- 新增随包清单 `bundled-catalog/curated-extensions.json`（构建期由渲染层 import，无新增 IPC、
  无服务端依赖），以及 `src/renderer-v2/registry/curated-extensions.ts`：逐字段校验后收窄成
  联合类型，校验不过的条目丢掉而不是抛错，由 `curated-extensions.test.ts` 当场报警。
- 清单字段与入选标准见新增的 `docs/CURATED-EXTENSIONS.md`，写法照 `docs/CLI-VERIFIED-VERSIONS.md`。
  首批五条的包名与版本 2026-09-21 在 npm registry 上逐条核对过。
- `pages-management.tsx` 删掉 `mcpQuickLinks`，改用 `CuratedShelf` + `CuratedDetails` +
  `curated-confirm` 二次确认框；安装仍走既有的单一提交路径，抽成 `submitMcpInstall`
  供手填表单与精选共用，主进程那侧的 `safeIdentifier` / argv 校验对两个入口同样生效。
- 带占位符的条目（本地文件的允许目录、记忆的 `MEMORY_FILE_PATH`）改为预填表单，
  `unresolvedInstallPlaceholders` 在提交前拦住没替换的 `{{key}}`，免得写进一条静默起不来的连接。
- 门禁：清单测试钉住 providers ⊆ providerIds、版本钉死、args 不含 `--trust` / `--scope`、
  risks 在枚举内、占位符与 inputs 一一对应、无凭据、文案不出现站点名。
- 功能清单 N7。最近目录由 `src/renderer-v2/features/tools/recent-workspaces.ts` 从已有的会话记录
  （`cwd`）推出来：按工具过滤、按最近使用排序、大小写不敏感去重、最多五个。不新增任何持久化，
  也没有新的主进程通道。
- `Home.tsx` 的「打开」在有记录时变成 split button，下拉走 `Menu`；`App.tsx` 的 `launch` 多一个
  可选的目录参数，省略时仍然弹选择器。目录已经不在时主进程抛的是「工作目录不存在」，
  `isMissingWorkspace` 认出这条就退回选择器，而不是把错误丢给用户。
- `features/tools/api.ts` 的 `recent()` 页大小从 3 改成 60：主进程本来就把全部会话读出来再切片，
  一页 3 条不够铺开四个工具的目录。首页「最近」卡仍然只显示 3 条。
- `tool-installation.ts`：新增 `nativeInstallBinDirectories`，在 PATH 之外叠加探测
  `~/.local/bin`（Windows 为 `%USERPROFILE%\.local\bin`）——Claude Code 与 Codex 的官方
  原生/独立安装器都把启动器放在这里，且 Windows 安装器常不写 PATH。新增
  `classifyCliInstallDisplaySource` 把内部的 `npm|native` 细分成 `npm|native|path`
  （原生安装器目录 vs PATH 上的其他来源），落点出处见 `docs/CLI-NATIVE-INSTALLS.md`。
- `system-service.ts`：`ToolStatus` 加可选 `installSource`，`inspectCliTool` 探到后写入。
- renderer-v2：`toolAvailability` 按来源出「已安装（官方安装器）/（其他来源）」标签；首页对
  非 npm 来源的安装隐藏「更新」「回到推荐版本」按钮，改用被动提示（`isExternallyManagedInstall`
  / `externalInstallHint`）。名单的推荐 / 阻断判断对原生版按版本号照常生效。
- T-G5：`e2e/renderer-v2-native.mjs` 与 `e2e/renderer-v2-native-close-race.mjs` 两条冒烟
  接进 quality.yml 的 windows-package 作业。两条都先修再接，不是直接接。
- 两条都不再假设 runner 的桌面够大：此前不写 `windowState`，`resolveWindowPlacement` 会在
  工作区小于 1280x720 的 runner 上把窗口最大化，而最大化的窗口在 Windows 上忽略
  `setContentSize`，三次改宽全部落空。现在写一份非最大化的窗口状态，改尺寸前再
  `unmaximize` 兜底，并断言真实拿到的内容宽度就是请求的宽度。
- 期望缩放改按 `electron/platform/zoom.ts` 的 `calculatePlatformZoom`（下限 0.7）算。真正
  给窗口写缩放的是平台层那条 resize 监听，它在 `queueMicrotask` 里注册、晚于 `main.ts` 的
  `applyPreferences`（下限 0.8），960 宽时两者给出 0.75 与 0.8 两个不同答案，最后写入的是
  平台层。新断言把这条「最后写入者」一并钉住。
- 两条都改走 `e2e/smoke-runtime.mjs`：此前每一个等待都没有超时，Electron 一卡住就是整个
  作业在上限处被取消、什么也不打印（#131 / #133 的老账）。
- `scripts/ci-workflow-config.test.cjs`：原先那条「native 冒烟必须留在 CI 之外」的门禁翻转
  成「两条都必须在 compile 之后跑、各带步骤上界」，两条也加进 `playwrightElectronSmokes`，
  未来新增的等待漏了 `withDeadline` 会当场红。
- `renderer-v2-native.mjs` 的主进程求值补上 `electron-ci-smoke.mjs` 那套重试：Playwright 走
  主进程的 Node inspector，V8 会在主进程繁忙时回收 inspector 的 promise 包装，Windows runner
  上会命中（quality run 35542609628 就这么丢了 1440 那一档，同一个 commit 上一轮还是绿的）。
  这里的求值全是读几何、截一帧、或设一个窗口可能已经是的尺寸，重放不改变任何东西；
  close-race 那条刻意不重试，它的求值驱动的是退出流程。
- 顺带把这条冒烟里的 ElectronApplication 句柄改名为 `application`，并在门禁里钉住这个命名：
  「不许出现没有上界的 `await application.evaluate(`」那两条断言是按名字写的，句柄叫别的名字
  就会从旁边绕过去——上面那次丢档正是这么发生的。
- `e2e/account-commerce-interactions.test.mjs` 的暗色 disabled 断言改成确定性的：控件背景带
  150ms 过渡，禁用之后立刻读拿到的还是上一帧的 focus 底色，这条断言此前从没真的看过
  disabled 状态，macOS runner 上偶尔读到真实值就当场红（本 PR 的 macos-test 第一轮即如此）。
  现在等过渡跑完再读，并把背景按祖先叠加成实际可见色——disabled 底是
  `rgba(255,255,255,.075)`，只看 `backgroundColor` 会把 255 误判成亮底。
- `electron/system-service.ts`：`scanSystem` 的四家最新版探测拆出三个顶层纯函数——`networkProbeSuggestsOffline`（网络位置探测 `region` 为 `unknown` 且带 error 才算离线，拿到 IP/国家代码的不算）、`buildUncheckedLatestVersion`（占位结果：已装的 `failed` + 中文原因，没装的照旧 `skipped`）、`settleLatestVersionProbes`（给一批探测套总预算，`budgetMs` 为 `null` 时等齐 = 联网时的老行为）。
- 判定离线时总预算 `offlineLatestVersionBudgetMs = 3_000`，到点先返回快照；超时的那几个 Promise 留在后台自己走完并写进既有 `npmLatestCache`，不重发也不加定时器。探测 reject 时仍保留原始原因，与改动前一致。
- 不改 IPC 契约，不改渲染层：`buildCliStatus` 对 `failed` 探测本来就不置 `updateAvailable`，`features/tools/model.ts` 的 `updateCheckFailure` 会直接把这句中文显示在版本列。
- `electron/system-service.test.ts`：纯函数四例 + 两个 `scanSystem` 集成用例（离线：永不返回的 npm 探测，断言 3 秒预算内返回且四家都是 `failed` + 中文原因；联网：网络位置探测成功、npm 探测比预算慢，断言仍等到 `checked`）。
- `src/renderer-v2/features/tools/online-resync.ts`（新增）：用 `electron/network-failure.ts` 的归类判断一次引导是不是被网络拦住（要求所有失败信号都是网络类，掺进 401 或分组问题就不算），并给出「联网后补跑一次」的纯状态机（每次离线→在线最多一次，补跑期间不重复排队，切号或退出登录即清空）。
- `account-bootstrap.ts`：`AccountBootstrapResult` 增加 `networkBlocked`，由 `syncError`、`syncManagedCliKeys` 的逐工具签发失败与逐工具配置失败三处信号算出；加密缓存与来源标记这类警告不参与判定。
- `App.tsx`：引导段每跑完一次就记下结论，并监听 `window` 的 `online` 事件按状态机补跑一次（仍走 `restore` 模式，已连接的工具照旧跳过），补跑再失败只写一行 `runtime.jsonl`，不弹任何对话框。
- `features/tools/Home.tsx`：网络类失败时横幅换成「当前网络不可用……联网后会自动补写 Key」，保留「重新同步」按钮。
- 新增 IPC 通道 `config:open-directory`（`openProviderConfigDirectory`）：主进程按
  `providerConfigRoot` 解析目录后交给 `externalShell.openPath`，与反馈页的
  `runtime-logs:open-directory` 同一条路径。三份通道表（`ipc-contract.ts`、`preload.ts`、
  `ipc.ts` 的注册顺序）同步（T1）。
- 新增 `electron/config-directory.ts`：`assertOpenableConfigDirectory` 在交给外壳之前做
  reparse 与「普通目录」校验（I8，配置目录在用户可写区，一个联接就能让资源管理器打开别处），
  目录不存在时报中文「还没有生成」而不是 `ensureSafeDataDirectory` 那样顺手创建。
- `registerIpcHandlers` 多一个可选 `providerRoots`，`main.ts` 传入
  `rootedOptions.system.providerRoots`，Codex 因此跟随软件注入的 `CODEX_HOME` 而不是写死
  `~/.codex`；省略时按当前进程环境推一份，等于旧行为。
- 渲染层：`ToolPresentation` 多一个 `configDirectoryReady`（取主进程已有的
  `dataDirectoryExists`），纯函数 `configDirectoryMenuItem` 出菜单项文案与置灰状态，
  `Home.tsx` 的工具行菜单与 `App.tsx` 的 `perform('打开配置文件夹')` 接线。四个 CLI 与
  Codex 桌面端五行都有这一项。配置分区整块读失败时写「配置暂未读到」而不是「还没生成」——
  那一遍根本没读着目录状态，不能替它断言。
- 第六批候选 9：`src/renderer-v2/ui/fields.tsx` 的 `Input` 在 `password` 时按 `keydown` /
  `keyup` 的 `event.getModifierState('CapsLock')` 显示一行提示（`.xm-field-caps`，
  `data-testid` 为 `<字段 testId>-caps`），失焦即清空，不轮询也不新增 IPC；提示 id 会挂进
  输入框的 `aria-describedby`。文案放在 `ui/shared.tsx` 的 copy 表里。
  覆盖：`features/auth/browser-check.mjs` 两条（登录两种账号来源、注册两个密码框），
  `ui/components.test.tsx` 一条静态断言默认不出现。
- `electron/preload.ts` 的 `startAcceleration` 桥接只收三个参数，第四个 `ignoreConflicts`
  （用户对冲突提示按下的「仍然连接」）在过桥时被丢掉，主进程每次都按「没确认过」再拒一次。
  改为四个参数都转发，末尾可选参数按实际个数传、不补空位，与渲染层 `api.ts` 和主进程
  `acceleration:start` 的分支同一口径。`electron/preload.test.ts` 钉住四种调用形态逐个过桥。
- 新需求候选 5。新增零依赖模块 `electron/project-instructions.ts`：目录里三种说明文件
  （大小写不敏感）任一存在就不生成，否则把随包模板原子写成 AGENTS.md（走 safe-local-data，
  绝不覆盖、绝不追加）。模板独立成文件 `bundled-catalog/project-instructions/AGENTS.zh-CN.md`，
  经 electron-builder 的 `files` 与 `extraResources` 随包发出，`resolveProjectInstructionsTemplatePath`
  沿用 `resolveXingmangAiBundledSkillRoot` 的 packaged→resourcesPath、dev→appPath 解析法。
- Gemini CLI 默认只把 GEMINI.md 当项目说明，`config-files.ts` 新增
  `ensureGeminiContextFilenamesInSettingsText` / `ensureGeminiProjectContextFiles`：在用户级
  settings.json 的 `context.fileName` 里把 GEMINI.md 与 AGENTS.md 都补上，只补不删、已齐不写，
  形态读不懂时整份不动；写入走两阶段提交 + .bak + 回滚（I9）。
- 接线在 `system-service.ts` 的 `launchProviderOperation`，紧接 #284 的信任写入之后：生成项目
  说明对全部工具执行，Gemini 额外补 context.fileName；两步都不阻塞打开，失败只记 runtime.jsonl
  （原因过 redactHomeDirectory，I13）。`SystemServiceOptions` 多一个可选
  `projectInstructionsTemplatePath`，`main.ts` 传入。
- 「每个目录只生成一次」：`ProjectInstructionsStateStore` 把「已为该目录生成过」记在本应用
  数据目录的 `project-instructions/` 下，一个目录一个以路径摘要命名的小文件（沿用
  `ToolConfigOwnershipStore` 的写法，省掉一份会无限长的清单，也没有并发合并），**不往客户
  目录写任何标记文件**。客户删掉生成的 AGENTS.md 就是不想要，下次打开不再生成；记录损坏时
  也当成已生成过 —— 这个方向的代价只是少一份模板，反过来是擅自改动客户的目录。
- 修 `publish-release.yml` 的 macOS 出包作业漏了编译主进程：`prepare-acceleration-bundle.cjs` 用的是主进程里那套安全读写与内核校验，没有 `dist-electron` 就在第一秒报「请先编译主进程」。2026-09-20 的首次正式发布就红在这里——Windows 那半条有这一步，照抄到 macOS 时漏了。`scripts/publish-workflow-config.test.cjs` 补了一条断言：两个出包作业都必须在准备加速资源之前编译主进程（去掉修复后这条会红）。
- 正式发布工作流的收尾（打 tag、建 GitHub Release）改成「没有就建，有就补」。触发时
  `platforms` 可以只选一个平台，于是同一个版本可以分两次发——先发 Windows，之后补发
  macOS。原来的写法在第二次跑到这里会直接炸在「tag 已存在」上。
- 这一步排在上传产物与覆盖更新清单**之后**，所以它失败时线上已经是新版本了，作业却
  报红。「究竟发出去没有」是发布现场最不该需要人去猜的一件事。
- tag 已存在但指向别的 commit 时仍然直接失败并说清两个 SHA：那说明同一个版本号发过
  两份不同的产物，必须有人来看。**已发布的 tag 一律不移动**，移动它会让所有按 tag 取
  源码的人拿到和当初不同的东西。
- Release 已存在时只把这一次出的包挂上去（`--clobber`），正文不重写——发布者可能已经
  在上面补过话，补发一个平台不该把那些改动冲掉。两个 glob 都没匹配到文件时什么都不做，
  而不是让 `gh release upload` 空参数报错。
- `publish-workflow-config.test.cjs` 用打桩的 git 与 gh 真的把这段脚本跑起来，覆盖首次
  发布、同版本补发、tag 指向不一致、无产物四种情况。
- 正式发布收尾的打 tag 改走 GitHub API，不再 `git push` 一个新的 tag ref。作业里的
  `GITHUB_TOKEN` 是 GitHub App 令牌，推新 ref 会撞上「没有 `workflows` 权限就不许创建或
  更新 `.github/workflows/*`」这条服务端规则，而 `workflows` 不在 `GITHUB_TOKEN` 可以被
  授予的权限里，加不上。0.2.8 就是这样红在最后一步的：产物、两份更新清单与两个平台的
  `update:verify-feed` 全部完成之后，作业才在打 tag 上失败。
- tag 现在由 `gh release create --target <出包的 commit>` 顺手建出来，是轻量 tag。存在性
  判断也跟着换成 Git refs API，并补上附注 tag 的解引用——0.1.x 那批 tag 是 `git tag -a`
  推上去的，ref 指向 tag 对象而不是 commit，少解一层会把补发判成「同一个版本号发过两份
  不同的产物」而停掉。
- 新增「tag 已经在、Release 还没有」这一支的用例：0.2.8 的收尾正停在这两者之间。
- 新增 `.github/workflows/publish-release.yml`：整条正式发布搬到 Actions，两个平台都接入。填 `confirm_version` 与要发的平台 → 两个出包作业各自核对版本号、现场准备加速资源 → Windows 走 `release:build:unsigned` 的完整门禁，macOS 用**已发布的那张签名证书**出双架构包并启动一遍 → 按「安装包与 blockmap → 逐字节复核可从客户会用的地址下载 → 最后才覆盖 `latest.yml` / `latest-mac.yml`」的顺序传 R2 → 两个平台各跑一次 `update:verify-feed` → 给出包的 commit 打附注 tag 并建 GitHub Release。
  `docs/RELEASING.md` 要求的「针对当前版本的明确发布授权」实现为 `release` 环境的 required reviewers，一次发布停两次：读 `.p12` 的 macOS 出包作业一次，上传一次。第一次批准之后产物只在 Actions artifact 里，装机验收过了再批第二次。
- 新增 `scripts/macos-release-keychain.cjs` 与测试：把发布签名身份导入 runner 上的一次性 keychain，构建完原样撤销。密码一律走 `security -i` 的 stdin 不进 argv（本机用户 `ps -axww` 就能读到运行中进程的完整命令行）；`.p12` 落盘后先覆盖再删；用户 keychain 搜索列表的原始取值写进状态文件，撤销时照着还原而不是猜；只允许在一次性托管 runner 上跑。`find-identity -v` 要求的代码签名信任只在**用户域**、只针对 `codeSign` 策略补一条，撤销时删掉，不碰管理员域、不碰系统 keychain、不用 sudo。
- 新增 `scripts/publish-workflow-config.test.cjs` 钉住这条链路：上传顺序（两份清单必须最后，且只有一步能动它们）、两个平台的更新源都要端到端复核、`publish` 与 `macos-build` 挂 `environment: release` 且只有 `publish` 有写权限、Windows 出包作业不读任何 secret、macOS 出包作业只读签名那四个、工作流读的 secret 名与产品所有者建的八个字字相同、macOS 正式包不走 `--ci-temporary-signing`、签名 keychain 的撤销步骤带 `always()`、run 块里不做 `${{ }}` 文本替换（P-26）、凭据不回显、第三方 action 钉完整提交号。
- 新增 `scripts/extract-release-notes.cjs` 与测试：按版本号从 `release-notes.md` 切出一节给 GitHub Release 正文用；只允许取第一节（首行必须等于 `package.json` 版本，P-14），取到别的节或空节一律失败。
- `docs/CI-PACKAGING.md` 第 5 节从「待拍板的方案」改写成实际落地的流程，`docs/RELEASING.md` 第 5 节补「CI 发布」一节；两处的 secret 名字都改成 release 环境里实际配的那八个。
- `electron/quit-blocking-tasks.ts` 新增纯函数 `resolveInterruptibleInstallTask`，
  从 `InstallationQueue` 的快照里认出安装类任务（`cli:install:*`、`runtime:node`、
  `runtime:python`、`desktop:codex:install`）并给出中文说明；启动 CLI、打开桌面端和
  卸载被打断没有后果，不在拦截范围内。
- `window-lifecycle.ts` 新增可选的 `confirmQuitWhileBusy`（缺省 = 旧行为）：
  「直接退出」偏好与托盘 / 菜单「退出」在放行前调用它，「每次询问」那条路径不调用，
  因为它自己的对话框已经写了「强制退出不等待任务完成」。确认框抛错不否决退出。
- 同一改动里让 lifecycle 监听 `session-end`：Windows 关机 / 注销时直接放行，
  包括确认框已经弹出来之后才收到该事件的情况。
- `SystemService` 新增 `inspectInstallationQueue()` 暴露队列快照。第六批候选 8。
- `e2e/realm-account-smoke.mjs`：主进程求值撞上 V8 回收 inspector promise 时的重试，从固定
  500ms 三次改成带上限的指数退避（500/1000/2000，共四次，上限 4 秒）。次数与退避从
  `e2e/fixture-readiness.mjs` 统一引入，日志每行写明是第几次、等多久、已经等了多久，最终
  失败信息带上总退避时长。此前三次重试会全部落进 Windows runner 同一个忙窗口（run #236
  的三次落在 131.0/131.5/132.0s），额度用光就整个 `windows-package` 红。
- T-G8：这条冒烟的验收证据文件不再写死 `true` 与 `actualNetworkRequests: 0` /
  `generatedContent: false` 这类没有计数器支撑的常量。改成与另外三个证据产出脚本一致的
  `passedAssertions` 写法——每个名字由证明它的那一步记录，收尾断言记录到的名单与预期名单
  一致；数值部分全部从夹具读回（夹具答复数、拒绝数、被拦截的出网尝试、渲染层被拦的来源、
  生成类请求数、隔离探针轮数）。`scripts/ci-workflow-config.test.cjs` 的证据门禁加上这个
  脚本，并新增一条门禁钉住退避参数只能来自共享模块。数值按整条冒烟的三次应用启动累加
  ——每个实例都是新的 Electron 进程、夹具计数器从零开始，只在收尾读一次只会拿到最后一个
  实例的数，那正是 T-G8 要消掉的「看着像度量值其实不是」。
- 新增 `electron/network-failure.ts`：把 Chromium `net::ERR_*` 与 Node errno（含 `fetch` 的 cause 链）归到
  offline / dns / tls / proxy / refused / timeout / intercepted 七类，并给出唯一一份中文文案。模块零依赖，
  已加入 `scripts/verify-renderer-boundary.test.cjs` 的 `valueImportable`，渲染层直接复用同一份文案，两棵树
  不再各写一句。
- `new-api-client.ts` 的 `performRequest` 改抛 `NewApiNetworkError`（带 reason）：超时、传输失败按分类抛；
  跨源重定向、3xx 重定向与「HTTP 2xx 但不是 JSON」一律归为 intercepted——这三种正是门户认证页的形态。
- `sub2api-account-client.ts` 的传输失败把原始错误交给 `RealmAccountError`，归得出网络原因时替换兜底文案；
  HTTP 失败仍用原文案。
- `ipc.ts` 的失败日志新增 `networkFailure` 字段（归不出来时不写），runtime.jsonl 里可直接看出是哪一类。
- `src/renderer-v2/features/auth/state.ts` 的 `authErrorMessage` 在启发式之前先认这句话，避免宽正则把
  「证书被替换」说成「连接超时」。
- 「记录」页的 lead 一直写着「继续之前的对话」，但页面只有导出和归档，`launchCli` 也只接目录、
  argv 恒为空。这次把承诺兑现：`cli:launch` 加第三个可选参数 `mode`（`'new' | 'resumeLast'`，
  省略 = 旧行为），`ipc.ts` 的 `parseCliLaunchMode` 只认这两个字面量，别的一律抛
  「CLI 启动方式错误」——续接参数本身永远不从渲染层来（I5）。
- 参数映射是主进程里的纯函数 `cliResumeLastArgv`（`electron/tool-installation.ts`，无 default
  的穷尽 switch，加第五个 CLI 漏在这里是编译错，T2），`cliLaunchArgv` 把它接在解析出的入口
  argv 之后；`system-service.ts` 的 `launchProviderOperation` 三个平台分支共用它。
- 续接是 CLI 自己按工作目录找最近一条，不按会话 id 挑，所以按钮只长在每个（工具 × 目录）
  组合最近的那条记录上，点到的就是接上的。这一判断来自渲染层的纯函数
  `latestSessionIdsByWorkspace`（`features/tools/recent-workspaces.ts`），数据是记录页另取的一份
  不带过滤的最新记录（`pageSize: 100`，主进程一页上限）；更老的组合一个按钮都不给，宁可少给
  也不能给一颗点下去接到别处的按钮。
- 各家参数与「没有历史会话」时的行为，2026-09-22 在沙箱空 HOME 里按名单推荐版本用 `--help`
  与实跑核实：`claude --continue`（2.1.277，"in the current directory"）、`codex resume --last`
  （0.155.1，`--all` 才关掉 cwd 过滤）、`gemini --resume latest`（0.60.0）、`grok --continue`
  （1.0.40，"for the current working directory"）。
- 已知限制：前三家在没有历史时退回开新对话（Gemini 另打印一行
  "No previous sessions found for this project."），**Grok 会直接报错退出**
  `No session found for current directory`。按钮只出现在已有记录的那一行上，正常路径碰不到；
  记录被外部删掉后再点，Grok 那边会闪一个英文报错就关掉终端，这一版接受不另加一层。
- 测试：`tool-installation.test.ts` 钉四家参数与拼接顺序，`ipc.test.ts` 钉 `parseCliLaunchMode`
  拒绝任意字符串，`recent-workspaces.test.ts` 钉「同工具同目录只留最近一条」与 Windows 路径
  大小写，`e2e/v2-business.test.mjs` 两条钉记录页把 `resumeLast` 与记录里的 cwd 一起交给主进程、
  以及同一目录里更早的那条不给按钮。
- 按会话 id 挑选（`--resume <uuid>`）不在这一步，另算一条。
- `electron/provider-sessions.ts` 的 `ProviderSessionSummary` 加可选字段 `cwdExists`，
  由新的顶层纯函数 `annotateWorkspaceExistence` 在 `list()` **分页切片之后**填充：
  一页最多 100 条、重复目录只 stat 一次，全量列表上不做。判断条件与主进程真正打开工具
  的那一处（`system-service.ts` 的 `launchProviderOperation`）逐字对齐——跟随符号链接、
  只认目录、stat 失败一律当作不存在，否则界面会把一颗其实按得动的按钮置灰。
- 这个判断**不进**探测缓存（`provider-session-probe-cache.ts`）：缓存的指纹认的是会话
  文件本身，目录却可能下一秒被删掉或恢复，缓存住就会一直显示上一次的状态。首页那份
  60 秒缓存（#314）不用单独失效，目录状态跟着那一次列出走。
- `pages-management.tsx` 与 `features/tools/Home.tsx`：`cwdExists === false` 的行把
  「接着聊」置灰、换 title、加一枚「文件夹已不存在」的角标，行本身不隐藏。记录页详情
  抽屉里的「接着上次对话」同样处理。
- 记录页的 `resume` 另外接住列表出来之后目录才被删的那一瞬间：认出主进程那句
  「工作目录不存在」后换成一句人话并重读列表，让这一行跟着置灰。这里不退回目录选择器
  ——CLI 是按目录找回对话的，换个目录就接不上这条（同 #292 的结论）。
- `electron/runtime-log.ts`：`RuntimeLogStore` 给每个日志文件加一份解析缓存，键是「大小 + 修改时间 + inode」。
  已轮转的归档不会再变，命中就直接复用；当前文件每追加一行指纹就变，照常重读。缓存只在主进程内存里，
  键是固定的四个文件路径，天然有界；`clear()` 与轮转时清掉。
- 同时把逐行解析拆成顶层纯函数 `summarizeRuntimeLogFile`：计数与来源仍然全量统计，但只对最后 2000 条
  （`snapshot` 的上限）做 `sanitizeDetail`，并在解析过程中滚动丢弃更早的条目，未命中缓存那一次的
  耗时与峰值内存也一起降了。`snapshot()` 的返回语义不变。
- 运行环境两行改用 `features/tools/ToolStatusMeta` 的 `ToolStatusMeta` / `ToolStatusReason`，与工具行共用 A4 的 `toolAvailability`：探测失败 > 分区未读到 > 已安装 > 未安装，版本位缺失时按状态分别说「版本未读到」「未找到版本」。
- `ToolStatusReason` 的 `vendor` 参数改名 `lead`：这一格现在也承载运行环境行的那句说明，不再只有厂商名。
- 夹具新增 `runtimeDetectionFailed`（只让 Node.js 这一行的探针抛错，系统状态整块仍读得到），`app-check.mjs` 加一条浏览器回归，`ToolStatusMeta.test.tsx` 补运行环境行四态的 `renderToStaticMarkup` 断言。
- 第七批候选 8。新通道 `provider-sessions:open-directory` / `openProviderSessionDirectory`
  （三份表同步，T1）：入参只有会话 id，工作目录由主进程的
  `ProviderSessionsService.resolveWorkspace` 从会话索引里取，渲染层不传任意路径。
- 新模块 `electron/session-workspace.ts` 的 `resolveOpenableSessionWorkspace`：必须是绝对
  路径、跟随链接后必须是目录，否则不交给 `shell.openPath`（`cwd` 若被改成一个可执行文件，
  openPath 会去运行它）。刻意不照搬 `config-directory.ts` 的「拒绝任何 reparse 组件」——
  那是给我们自己写出来的配置目录定的规矩，用户的项目目录本来就可能落在联接下面，
  与旁边「接着聊」的目录判断（`workspaceDirectoryExists`）对齐。
- 渲染层：`pages-management.tsx` 记录行按钮走 `useOperation`，`Home.tsx`「最近」卡走
  `toolsApi.openSessionDirectory` + toast；两处都在 `cwdExists === false` 时置灰。
- 新增 `electron/provider-session-probe-cache.ts`：把 `ProviderSessionsService` 原本只在内存里的
  `probeCache` 落到 `userData/sessions/probe-cache.json`，键仍是会话文件的
  `size:mtimeMs:ino`（grok 另计 `summary.json` 的那一份），命中直接用缓存、变了才读前 512 KB。
- 缓存只存探测出来的元数据（标题、目录、模型、时间、条数、首条提问），不存任何对话正文；
  读回时逐字段校验并截断超长文本，版本号不符、JSON 损坏或读取失败一律整体作废后静默重建。
- 写入走 `safe-local-data` 的原子写，且在 `list()` 返回之后异步进行，不阻塞首页；
  条数上限沿用 10000 条 LRU，落盘另有 2 MB 上限，超出时丢最早的那些。
- 一次完整扫描某个 provider 目录后，会把该目录下已经不存在的会话从缓存里删掉。
- 沙箱实测：400 个约 208 KB 的 Claude 会话文件，第一次 `list()` 读 83112000 字节，
  第二次读 0 字节，缓存文件 271916 字节。
- 第五批候选 2 / 5 / 3（第一步）。
- `electron/config-files.ts` claude 分支：`createPlans` 模板写 `language: '简体中文'` 与
  `cleanupPeriodDays: 365`；`createMergePlans` 走 `ensureClaudeResponseLanguage` /
  `extendClaudeSessionRetention`，两者都只在键缺省时补，用户写过什么值都原样保留。
- `electron/config-files.ts` gemini 分支：模板写 `general.sessionRetention.maxAge = '365d'`；
  merge 走 `extendGeminiSessionRetention`，只在 `general.sessionRetention` 整段不存在时才补，
  已经有这一段（哪怕只写了 `enabled: false`）就整段不动。
- `createOfficialAccountPlans` 的 reset 模板把这三项一并写回：语言与保留期是用户偏好，切回
  官方账号不该悄悄回到 30 天自动删；merge 路径本来就只删中转那几个键，不受影响。
- `electron/diagnostics.ts`：`CLAUDE_BYPASS_PERMISSIONS` 标题改成「Claude 命令确认方式」，
  `readClaudeBypass` 多收一个来源参数。来源为 `account`（本软件替当前登录账号写的）时
  `state: 'pass'` 并给一句中性说明，其余（`manual` / `unknown` / `changed` / 宿主没给）照旧
  `warn`。来源由新的可选依赖 `readClaudeConfigOwnership` 提供，`electron/main.ts` 用
  `systemService.getConfig(false).providers.claude.configurationOwnership` 接上——判定要比对
  当前登录账号，诊断自己算不出来。不给这个依赖时行为与改动前一致。
- `src/renderer-v2/pages-management.tsx` 记录页 lead 补一句保留期。
- `docs/CLI-VERIFIED-VERSIONS.md` 新增「本软件替用户改了哪些 CLI 默认值」一节，把自更新、
  Artifact deny、命令确认、语言、两个保留期、IDE 模式、目录信任、说明文件名集中成一张表。
- 值的格式都是沙箱实测的：Claude Code 2.1.277 写 `language` 后，请求体系统提示里出现
  `# Language / Always respond in 简体中文.`（值被原样插进那段英文提示）；`cleanupPeriodDays`
  的 schema 是 `int().positive()`，写 0 会被拒，放长只能写大数。Gemini CLI 0.60.0 的
  `general.sessionRetention` 默认 `enabled: true` / `maxAge: "30d"`，且 `getDefaultsFromSchema`
  会递归补齐嵌套默认值——用户没配这一段时清理照样按 30 天跑。
- App.tsx 里三条启动期自动触发的路径（startupUpdate 拒绝、runDiagnostics 的结论与拒绝、
  bindPlatformAppearance 的 onError）不再走 setOperationError，改走新的
  features/app/startup-notice.ts + StartupNotices.tsx：按检查分组、同一个检查只留最新一条、
  逐条可关闭，容器 pointer-events: none 以免这条「不挡路」的提示自己挡路。
- 检查本身照跑、失败照样进 runtime.jsonl：主进程按通道记一条，渲染层再经
  reportRendererError 记一条写明是哪一次启动检查（context 为
  `renderer-v2 startup check: <id>`）。环境检查跑完只是结论需要看一眼，不计为错误。
- e2e/renderer-v2-native.mjs 在欢迎页和三次改窗宽之后各断言一次「没有阻塞对话框」，
  失败时把对话框正文写进失败信息与 result.json——PR #270 的 windows-package 正是被这个
  对话框挡住 30 秒，而日志里读不出是哪一步弹的。
- 夹具新增 diagnosticIssues / diagnosticsFail / updateCheckFail 三个开关与
  checkForUpdates、reportRendererError 两个 mock，覆盖「启动检查失败不弹框」与
  「手动检查失败照常报错」两侧。
- 开机（已登录）原本要跑三遍 `scanSystem`，其中两遍是强制：首屏 `useToolbox` 一遍（非强制）、`bootstrapAccountTools` 里一遍（`scanSystem(true)`）、Key 写完后 `App.tsx` 又 `refresh(true)` 一遍。现在降到两遍且都不强制。
- `useToolbox` 新增 `refreshConfig()`：只重读配置分区，不碰 `scanSystem`，也就不再起一轮探测子进程（Windows 上每遍光 Codex 桌面端就并发三个 powershell），不清主进程的 npm 最新版 / 网络位置 / 官方 ChatGPT 缓存。`App.tsx` 的 Key 同步收尾改走这条。
- 这条刷新不打断正在跑的扫描：照 `desktopRevision` 的既有套路加了 `configRevision` / `latestConfig`，让那遍扫描落地时用新配置顶替它开跑前读到的旧配置。首屏扫描已经失败、手上什么都没有时才回落到一次完整扫描（`planConfigRefresh`）。
- `bootstrapAccountTools` 的 `scanSystem(true)` 改成 `scanSystem()`：这份计划只读「装没装、探测有没有失败」，而安装状态从不缓存，force 清掉的几份缓存与它无关。
- 手动「重新检测」、装/卸工具、保存配置后的刷新仍是完整强制扫描，用户可见行为不变。
- `src/renderer-v2/features/tools/Home.tsx` 的 `renderExternal` 去掉了 `extraAction` 里的独立「配置」按钮，配置改由「…」菜单承担（`home-client-<tool>` 这个 testId 随之落到菜单项上，主按钮本身是「配置」时仍留在主按钮上）；菜单在主按钮已经是「配置」或「打开」时不再重复给同一项。四个 CLI 行本来就只有菜单入口，两类工具行至此一致。yoyo 2026-09-20 真机反馈第 ④ 条。
- 新增 `electron/tray-acceleration.ts`：托盘那一行状态与那一项动作的全部判断收在纯函数
  `buildTrayAccelerationEntry` 里，协调者 `createTrayAccelerationCoordinator` 负责缓存状态、
  发起连接/断开并把失败收成一句短话（`electron/tray-acceleration.test.ts`）。不含 Electron
  依赖，照 `codex-desktop-acceleration.ts` 的做法由宿主注入读状态与连接。
- 连接与断开复用加速页那条路（`acceleration-service` 的 `startAcceleration` / `stopAcceleration`），
  线路用「智能分配」、模式用标准模式：两者都是加速页上的当次选择，没有落盘，托盘读不到也
  不替用户猜，与打开 Codex 桌面端时自动连接同一口径。
- `acceleration-service.ts` 新增可选的 `onState` 回调，每产出一个状态就通知一次，托盘据此跟上
  加速页自己的连接与断开，不新增轮询；回调抛错不影响本次请求的结果。
- `application-tray.ts` 的快照多一个可选的 `acceleration` 字段（缺省则菜单里不出现这两行），
  并新增 `onMenuOpen`：菜单要弹出来时读一次会过期的状态（macOS 左键、其他平台右键），
  主窗口缩起来之后渲染层的 15 秒轮询是停的。
- 失败原因在托盘上另给一份短说法（按 `AccelerationFailureReason` 封闭集合穷尽，无 default
  分支），长句仍留在加速页；带路径或超长的错误原文一律退回通用说法（I13）。
- `pages-maintenance.tsx` 的 `tutorialTopics` 在 `start` 章首加一步文案，并相应改写该章 lead。跳过 Claude Code 首启向导（#284）连带跳过了它那页英文安全须知，这两句改由本教程用中文承担。
- `pages-maintenance.test.ts` 补一条断言钉住这两句，避免以后改教程时悄悄掉了。
- 第六批候选 7。`src/renderer-v2/pages-maintenance.tsx` 的 `tutorialTopics` 补三章
  （`sessions` / `acceleration` / `messages`），纯文案，沿用现有章节与步骤结构，没有新组件。
  每一句都对照已合进 main 的实现与 `changes/unreleased/` 分片核实：托盘加速开关（#326 未合）
  与站点名一律不写，TUN 只写界面上那句「暂未开放」。
- `pages-maintenance.test.ts` 新增四条：两章的标题与 `registry/pages.ts` 的页面名一致且各四步；
  「接着聊」的三条限制与「只存在这台电脑上 / 一年」写在章里；加速的 20 分钟与 10 分钟从
  `electron/acceleration-contract` 的 `accelerationTrialSeconds` / `accelerationBonusSeconds` 取，
  教程里写死别的数就会红；对照表里的提示标题从 `registry/errors.ts` 与 `registry/status.ts` 取，
  改文案不同步改教程会直接红。
- 窗口缩放公式合成一份。此前 `electron/window-preferences.ts` 的 `calculateUiZoom`（下限
  0.8）与 `electron/platform/zoom.ts` 的 `calculatePlatformZoom`（下限 0.7）是两份各自
  维护的实现，960 宽时分别算出 0.8 与 0.75；两者都挂在同一个窗口的 `resize` 与
  `did-finish-load` 上，谁生效取决于监听注册顺序。
- 实际生效的是平台层那份（下限 0.7），已用 xvfb 起真实 Electron 核实：`main.ts` 的
  `applyPreferences` 在 `BrowserWindow` 构造返回后同步注册，`platform/renderer-v2.ts` 的
  `apply` 在 `browser-window-created` 的 `queueMicrotask` 里注册，排在后面，最后写入的是它。
  实测 960 宽 → 0.75、1000 宽 → 0.7813，1024 宽及以上两份公式本来就一致。
- 现在 `platform/zoom.ts` 只转调 `calculateUiZoom` 并转出同一组常量，`UI_MIN_ZOOM` 统一为
  0.7。下限不是可调的观感偏好：`resolveWindowPlacement` 把最小宽钉在 960 DIP，
  960 / 1280 = 0.75，下限高于 0.75 会让渲染层拿不到 1280 的设计宽度，变成裁掉而不是缩放。
- renderer-v2（发布构建走的那条）缩放值不变。legacy 回滚构建不安装平台层，此前只有
  下限 0.8 那份生效，现在跟随统一后的 0.7，1024 DIP 以下的缩放会改按比例走——legacy
  从不进正式发布产物，付费客户看不到这条差异。
- 新增 `electron/platform/zoom.test.ts` 钉住：两处常量同值、下限为 0.7、320~3840 全宽段
  四种缩放偏好下两个入口结果逐一相等、最小宽窗口恰好缩放到 1280 设计宽。
  `electron/window-preferences.test.ts` 里 960 宽的两条过期期望（0.8 / 0.8）改为实际生效的
  0.75 / 0.7。
- 合入 #260 后同步两处现在已过期的注释：`e2e/renderer-v2-native.mjs` 里「main.ts 另有一份
  下限 0.8」那段，和 `scripts/ci-workflow-config.test.cjs` 里「window-preferences.ts 的
  下限是 0.8」那句。两处都改成「当时两份、现已合成一份」的口径，断言与门禁逻辑不动。
- 新增 `electron/window-responsiveness.ts`：把主窗口 `unresponsive` / `responsive` 的配对处理抽成注入式
  `createWindowResponsivenessGuard`，同一窗口同一时间只允许一个对话框，`responsive` 到达时用 `AbortSignal`
  关掉还开着的对话框且不触发重载，窗口销毁后也不再重载。`electron/main.ts` 的 `unresponsive` 处理由只记一条
  warn 改为额外弹出系统对话框（父窗口为主窗口，默认「继续等待」），选「重新加载」调 `webContents.reload()`；
  对话框弹出与用户选择各写一条 `runtime.jsonl`。单测见 `electron/window-responsiveness.test.ts`。
- `electron/updater.ts`：`UpdateSnapshot` 增加可选字段 `failedStep`（`check` / `download` / `install`），检查、下载、安装、启动检查超时与安装包校验拒绝五条失败路径各自标注；安装包校验不过标成 `download`（本地那一份已不可信，要重来的是下载）。`emit` 统一让 `failedStep` 跟着 `error` 走，清错误的地方不必逐处补一句。
- `electron/updater.ts` 的 `safeError()` 先走 `classifyNetworkFailure()`，命中就用中文原因替换 electron-updater 的英文原文；原始 `code` 仍原样留在 `error.code` 里，`runtime.jsonl` 不丢线索。更新清单缺失、服务器回网页两条既有特判排在网络归类之后，不受影响。
- `electron/network-failure.ts` 增加 `updateNetworkFailureMessages`：同一套归类，换成「更新」这件事的主语——更新器连的是静态更新目录，不是账号服务，也不涉及输密码。
- `src/renderer-v2/registry/business.ts`：新增 `updateFailureLabels` / `updateFailureFallback` / `updateFailureLabel()`，更新页提示与首页浮动气泡读同一份文案；旧快照没有 `failedStep` 时走不分步骤的兜底。
- `src/renderer-v2/pages-maintenance.tsx` 的 `UpdatesPage`：失败提示的标题、按钮文字与重试动作都按 `failedStep` 取（检查失败重新检查，安装失败直接回到重启确认框，安装包已下好不必再下一遍），并挂上 `updates-failure-<step>` 标记。
- 测试：`updater.test.ts` 补三个阶段各一条、网络原因中文化、成功检查后清掉失败步骤、非网络失败保留既有中文诊断；`registry/business.test.ts` 钉住三步的标题与按钮映射及兜底；`network-failure.test.ts` 钉住更新文案不出现「账号」「密码」；`testing/app-check.mjs` 浏览器用例走完三个阶段并核对首页气泡同文。
- 新事件通道 `account:vault-recovered`（`XingmangEventContract.onAccountVaultRecovered`，载荷为空）。触发点是 `electron/main.ts` 里 `createFileRealmAccountVault` 的 `onRecovered`，也就是 `realm-account-vault-file.ts` 的 `recoverAtomic` 提交重建之后；恢复逻辑本身没动。
- `electron/vault-recovery-notice.ts` 的 `createVaultRecoveryNotifier` 把「记日志」和「通知界面」绑在一起：日志每次都写（仍带备份文件名），事件一个进程只发一次，免得用户刚关掉的提示再冒出来。事件不带备份文件名与任何账号内容（I3 / I13）。
- 渲染层复用 #274 的启动提示条：`StartupCheckId` 增加 `vault-recovered`，`startup-notice.ts` 新增 `vaultRecoveredNotice()`，`StartupNoticeAction` 改成「跳页」或「开登录」的联合类型，`App.tsx` 订阅事件并在按钮上 `setAuth('login')`。因为不是检查失败，不再额外写一条渲染层错误日志。
- Windows 的 `windows-test (renderer-v2-browser)` 分片在 2026-09-19 至 09-21 的 196 轮 quality 里，141 次完整跑挂了 14 次（9.9%）。逐条取日志后确认指纹只有一个：某一次开页面整个死掉——挂载等待吃满 90 秒、locator 在空文档上吃满 30 秒、或者 `page.goto` 69 毫秒就抛 `net::ERR_NO_BUFFER_SPACE`——而紧挨着的用例都是一两秒。同期十轮绿跑里最慢的用例 22.4 秒，没有任何一条超过 30 秒，也没有任何错误标记，所以这不是预算不够，是导航丢了。
- `e2e/fixture-readiness.mjs` 新增 `fixtureMountAttempts`（默认 3）、`fixtureMountSliceMs()` 与 `openFixturePage()`：90 秒总预算不变，改成分三次导航花掉，一次挂载没落地就重新导航并往 stderr 写明第几次。预算没有调大，用例没有跳过。`src/renderer-v2/testing/app-check.mjs`、`e2e/v2-business.test.mjs`、`e2e/maintenance-layout.test.mjs`、`src/renderer-v2/features/chat/browser-check.mjs`、`src/renderer-v2/ui/browser-check.mjs` 五个实际红过的套件接上，合起来覆盖那 14 次里的 13 次。#265 与 #270 给的是「挂载等待用共享预算」，这里补的是「丢了就重新导航」的另一半，两者叠在一起：`waitForFixtureMount` 负责怎么等，`openFixturePage` 负责等不到就重来。
- **一条负面结论**：曾试着在 `quality.yml` 的两个 Windows 作业里把工作目录排除出 Defender 实时扫描，run 35548878416 打印 `Get-MpPreference` 实测 windows-latest 镜像**出厂就已经把整个 `C:\` 和 `D:\` 放进排除列表**，这一步是纯仪式，已撤掉。仓库里若干处「Defender 下冷启动慢」的注释对托管 runner 不成立（对 yoyo 本机仍成立）。`scripts/ci-workflow-config.test.cjs` 留了一条门禁钉住这条排除步骤不许再长回来，并把实测写在注释里。
- `scripts/ci-workflow-config.test.cjs` 另补一条门禁：夹具导航次数必须 ≥2、单次预算必须大于绿跑实测的 22.4 秒上限、三次必须共享同一个截止时间（拿假 `page` 实测总耗时不越界），五个套件必须走 `openFixturePage`。另外把 `browserSuitesUnder()` 的发现条件从只认 `.goto(` 扩成也认 `openFixturePage(`——否则把导航交给共享重试的套件会悄悄从这条门禁的扫描里掉出去。
- `docs/TEST-BASELINE.md` 补上 CI 分片这一条的口径，与本机 Windows 基线分开写。
- 核实并记录：Windows 上给 MCP 写的 `npx` 命令不需要包 `cmd /c`。Claude Code 2.1.277 与
  Gemini CLI 0.60.0 的 MCP stdio 传输走 `cross-spawn`（按 `PATHEXT` 解析后自动转
  `cmd.exe /d /s /c`），Codex CLI 0.155.1 的 `rmcp-client/src/program_resolver.rs` 用
  `which` crate 解析成绝对路径，Grok CLI 1.0.40 内置文档写明它自己解析。四家的依据、
  复核办法与「什么时候可以推翻这条」写进 `docs/CURATED-EXTENSIONS.md`。
- 加两条回归门禁防止以后误「修」：`provider-extensions.test.ts` 钉住四家的 MCP 安装 argv
  里不出现 shell 包裹，`curated-extensions.test.ts` 钉住随包清单的 stdio 条目保持跨平台中立。
- `buildCliLaunchPlan`（`electron/windows-elevation.ts`）生成的可见终端脚本在 `Set-Location` 之前设 `$OutputEncoding` / `[Console]::OutputEncoding` / `[Console]::InputEncoding` 为无 BOM 的 UTF-8，与主进程自己那二十余处探测脚本写法一致。窗口用 `-NoProfile` 启动，用户 profile 里的编码设置不会生效，此前一直沿用系统代码页（简体中文是 936）。
- 不额外跑 `chcp 65001`：.NET 的这两个 setter 本身就会调 `SetConsoleOutputCP` / `SetConsoleCP`，与 `chcp` 等价，而在可能继承提权令牌的窗口里跑 `chcp` 等于按 PATH 查找系统可执行文件（I14）。整句包在 `try { … } catch { }` 里，设不上也只是维持原状，不会让用户点「打开」后 CLI 起不来。
- 第六批候选 2。新增用例 `switches the visible terminal to UTF-8 before the CLI starts`（`electron/windows-elevation.test.ts`）钉住两条赋值、异常兜底、无 `chcp`，以及它排在 `Set-Location` 与 CLI 调用之前。
- 新增 `electron/workspace-guard.ts`：纯函数 `classifyWorkspace` 判定「主目录 / 盘根与卷根 /
  桌面 / 下载 / 文档」五类敏感工作目录，Windows 与 macOS 大小写不敏感，认 OneDrive 的已知
  文件夹重定向（含简体中文的「桌面」「文档」「下载」与企业版的 `OneDrive - 公司名`），
  判不准时一律按普通目录放行。
- `workspace:choose`（`electron/ipc.ts`）选到这几类目录时先弹一次中文提示，「换一个文件夹」
  会把选择器再打开一次，「仍然打开」照常返回并记一条 `workspace.guard.accepted`（只记类别，
  不记路径，I13）；通道形状没有变化，渲染层与 `preload.ts` 不受影响。
- `launchProviderOperation`（`electron/system-service.ts`）对这几类目录跳过 `trustManagedWorkspace`
  与 `ensureProjectInstructions` 两段，记一条 `workspace.guard.skipped`；记住的目录（N7）走的是
  同一段，老用户已经记住的主目录再打开也不会补写。Gemini 的 `context.fileName` 属于用户级配置，
  不在跳过范围内。
- `config-files.ts` 新增 `trustManagedWorkspace`：Claude Code 写 `~/.claude.json` 的
  `projects["<路径>"].hasTrustDialogAccepted` 与顶层 `hasCompletedOnboarding`，Gemini CLI 写
  `~/.gemini/trustedFolders.json` 的 `{ "<路径>": "TRUST_FOLDER" }`。两家的字段都没有官方文档，
  形态是 2026-09-21 用空 HOME + 伪终端走完 Claude Code 2.1.277 与 Gemini CLI 0.60.0 的首启向导
  后 diff 出来的，方法和结论记在 `docs/WORKSPACE-TRUST.md`。
- 写入照 `trustCodexWorkspaceInConfigText` 的形态：纯函数出内容、`executeFilePlans` 出事务
  （两阶段提交 + `.bak` + 回滚，I9），路径过 `assertSafeConfigPath` / `assertNoReparseComponents`
  （I8）。已有条目一律不动，不改就完全不写。
- 调用点在 `system-service.ts` 的 `launchProviderOperation`，在解析 CLI 命令之前。写不进去
  （文件损坏、只读、主目录被重定向）不阻塞打开，只往 `runtime.jsonl` 记一条
  `workspace.trust.failed`，原因先过 `redactHomeDirectory`（I13）；为此 `SystemServiceOptions`
  多了一个可选的 `runtimeLog` 依赖，由 `main.ts` 传入。
- `requireConfigText` 多一个可选的字节上限参数：`~/.claude.json` 会随会话历史长，2MB 会误伤，
  这条路径用 16MB，与 `provider-extensions.ts` 读同一份文件时的上限一致。
- 私有函数 `normalizeCodexWorkspaceKey` 改名为 `normalizeWorkspacePathKey`，现在三家共用。
- `startupDiagnosticsIssues` 改收 `report.counts`，只把 `fail + error` 计入标题；只有 `warn` 时返回 null，同时有 `warn` 时正文补一句。`diagnostics.ts` 的级别判定没动。浏览器夹具新增 `diagnosticWarnings`，`diagnosticIssues` 改为计入 `fail`（第八批候选 2）。
- 第十批候选 2。内核退出：backend 新增 `onRuntimeInterrupted`（`notifyRuntimeExit` 与 `inspect` 两条路径都会报，停止失败也报），worker 转成只有事件名的 `runtime.exited` 诊断事件，host 新增 `onRuntimeExited`。
- 辅助进程被硬杀：host 记住收到过 `start` 的 worker，它不是本软件让它走的却退出了，就当场 `ensureReady()` 重拉一个（初始化即还原系统代理，不重连加速），结果经 `onHelperExited(recovered)` 报给主进程；重拉出来的 worker 没连过加速，再退出不会接着重拉。
- 新模块 `electron/acceleration-interruption-notice.ts`：收到上面两种报告后读一次状态（经服务 `onState` 推给托盘），读到会话确实停了才发「网络已恢复正常」，读不到或停不下来有限次重读后发「网络可能暂时连不上」；只提醒本次运行里看着连上的会话，同一次连接只提醒一次。通知沿用 `acceleration` 偏好键，新增 `accelerationInterrupted` / `accelerationInterruptedUnrestored` 两条主进程通知。
- 加速页上意外断开的那句改为「加速意外断开了，网络已恢复正常，可以重新连接。」。未新增 IPC 通道。
- 第八批候选 4。`electron/backups.ts`：v2 清单新增可选 `key`（Key 的 SHA-256 与当时签发它的账号 id / 用户名，旧版本读到直接忽略），摘要新增 `keyOwnership` / `keyAccountName`，从不带 Key 或摘要跨 IPC（I3）；`ConfigRestoreResult` 新增 `provider`。
- `electron/ipc.ts`：`backups:*` 按当前登录态只读已有的 Key 缓存，算出账号上下文传给备份库；`backups:restore` 成功后调用新的 `systemService.adoptRestoredConfig`，把恢复出来的配置登记为账号来源（Key 正是当前账号签发的那把）或手动来源（其余），首页不再误报 `changed`，自动写 Key 也不会覆盖它。登记失败只记日志，不影响恢复结果。
- 渲染层：`BackupsPage` 新增 `onRestored`（App 接到 `toolbox.refreshConfig()`）与恢复后的 `checkProviderConnection` 结果条；归属文案收口在 `features/tools/backup-key.ts`。没有新增 IPC 通道。
- 第十批候选 8。外链名单的逐字全等规则（I12）不动，也不做「同站放行」；只补拦下之后的出路。
- 新增零依赖模块 `electron/external-url-blocked.ts`：`external:open` 拒绝时改抛 `ExternalUrlBlockedError`，文案仍是「不允许打开该链接」。Electron 只把 `error.toString()`（`${name}: ${message}`）送过 IPC，其它属性全丢，所以错误名就是那个稳定的错误码；`isExternalUrlBlockedError` 同时认进程内的实例和过桥后带通道前缀的形状，不比对中文文案。不新增 IPC 通道、不改契约。
- 渲染层 `src/renderer-v2/external-link-fallback.tsx` 的 `openExternalOrCopy`：只有认出这个错误码、且链接是不带账号密码段的 http / https 时才复制（写剪贴板沿用 `navigator.clipboard.writeText`）并返回提示；其它协议照旧拦下、不复制，其它失败原样抛给调用方。剪贴板被拒时仍把地址摆出来。
- 接入两处：`features/shell/Announcement.tsx`（`AnnouncementCenter` 把包装后的 `openLink` 传给正文，Markdown、富文本与原生公告框三种渲染都走它）与 `features/auth/LegalDocument.tsx`（提示显示在正文上方，不再把整篇协议换成错误）。
- 测试：`external-url-blocked.test.ts`、`external-link-fallback.test.tsx`、`ipc.test.ts` 钉住过桥后的形状；`testing/app-check.mjs` 在浏览器里点公告链接，验证复制成功与剪贴板被拒两种提示。
- legacy 树未改，但主进程共用同一条通道：legacy 界面里被拦的链接报错前缀会从 `Error:` 变成 `ExternalUrlBlockedError:`，句子本身不变。
- 第八批候选 5、6。新通道 `exports:reveal-file` / `revealExportedFile`（三份表同步，T1，排在 `runtime-logs:export-feedback` 之后），经 `registerTrustedHandler`（I4）。入参是路径字符串，但**只认本进程最近 16 次导出写出的路径**：`diagnostics:export`、`runtime-logs:export-feedback`、`provider-sessions:export`、`sessions:export` 成功后把返回的 `outputPath` 记进 `ipc.ts` 闭包里的名单，取消的导出不记。渲染层给名单以外的路径一律拒绝，不会让资源管理器指向任意位置。
- 新模块 `electron/exported-file.ts` 的 `resolveRevealableExportedFile`：绝对路径、`lstat`（不跟随链接）后必须是普通文件，否则报「已经不在原来的位置了」/「不是导出的那个文件」。`showItemInFolder` 只选中不运行，所以不照搬 `config-directory.ts` 的 reparse 全路径拒绝。`registerIpcHandlers` 多一个可选注入 `revealInFolder`，缺省 `shell.showItemInFolder`。
- `RuntimeLogStore.captureFeedbackReport(limit, maxLength?)`：超过 `maxLength` 时按条从最旧的日志开始丢，头部加一行「日志已截断: …只保留最近 N 条」，并把「日志条数」行改成附最近 N 条；只有日志以外的部分就超限时才抛错，文案指向「打开日志目录」。`runtime-logs:preview-feedback` 传 `FEEDBACK_REPORT_MAX_LENGTH`（2,000,000，与原判断同一口径：UTF-16 长度）。
- 渲染层：`useOperation` 的成功回调可以返回 `{ text, revealPath }`，hook 多暴露 `revealPath`；`ResultNotice` 收可选的 `revealPath` + `onReveal`，两者都在且是成功态才出按钮，定位失败只在按钮旁边写一句、不顶掉成功提示。记录页「查看记录」在 `detailAvailable === false` 时带 `title` 说明，并加 `testId`。
- 第十批候选 4。新模块 `electron/login-launch.ts`：Windows 开机项带 `--launched-at-login` 参数，macOS 13 起登录项走 SMAppService 不能带参数，改读 `getLoginItemSettings().wasOpenedAtLogin`；读失败按普通启动处理。`shouldRevealInitialWindow` 只有「开机启动且托盘可用」才不弹首个窗口，托盘建不起来照旧弹（`application-tray.ts` 托盘中途失效时也会走 `onOpen` 兜底）。
- `main.ts` 的 `ready-to-show` 不弹时把最大化延到第一次 `show`（对隐藏窗口调 `maximize()` 会直接把它显示出来），并记一条 `window/launch.login-hidden` 便于排查「怎么没窗口」；`second-instance` 带着这个参数时不抢焦点。
- Windows 开机项按「路径 + 参数」整条比对：`platform/system-service.ts` 查询时把旧版不带参数的那条也认成已开启；新增 `migrateLegacyWindowsLoginItem` 在 `setAppUserModelId` 之后同名覆盖成带参数的一条，保留任务管理器里的禁用状态（`enabled` 取旧条目的 `executableWillLaunchAtLogin`），结果记 `main/login-item.migrated` 或 `login-item.migrate.failed`。
- 设置页「开机自动启动」的说明改成「开机后在托盘里待命，不弹窗口」。
- 新增 `electron/macos-command-line-tools.ts`：macOS 上 PATH 命中 `/usr/bin/git` 或 `/usr/bin/python3` 时，先以 argv 调 `/usr/bin/xcode-select -p`，并确认「开发者目录/usr/bin/同名命令」确实是文件，才去跑 `--version`；否则按未安装返回，不执行空壳。`system-service.ts` 的 `inspectTool` 与 `diagnostics.ts` 的 `defaultInspectTool` 都接上了这道判断，检查页 Git / Python 两行在这种情况下给出空壳说明（第八批候选 1）。Windows 与其他路径（Homebrew、python.org）不受影响。
- 第七批 5：渲染层接上 `installNodeRuntime` / `installPythonRuntime` 返回的 `systemRestartRequired`（MSI 3010）。文案在 `features/tools/runtime-install-outcome.ts`，首页（`App.tsx` 的 `installRuntime`）与「安装卸载」页共用；重启框 `features/tools/RuntimeRestartDialog.tsx` 只有一颗按钮、打开时焦点不在按钮上，发之前查渲染层未完成的业务操作。
- 主进程 `restartWindows` 在安装队列忙时拒绝发 `shutdown /r`，避免倒计时结束把正在原子替换的安装打断（I11）。`runtime:restart-windows` 通道此前注册了但没有调用方。
- `pathRefreshRequired` 不再提示用户重开：`command-runner.ts` 的 `commandEnvironment` 在继承 PATH 之后补上代装 Python 3.12 的目录与 `Scripts`（排最后，不顶掉用户自己的 Python）；Node.js 的固定目录本来就在 `defaultCommandPaths` 里。只影响同用户模式，`trustedCommandEnvironment` 不变。
- 新增零依赖的 `electron/redaction-patterns.ts`，`command-runner.ts`、`startup-log.ts`、`diagnostics.ts` 三份几乎相同的打码规则收口到这一张表；`crash-report.ts` 与 `updater.ts` 也改用同一套形状规则。只加不删：补上 `AIza…`（Google）、`xai-…`（Grok，20 位起步，避开 `@xai-official/grok` 包名）、查询参数 `key=`，`x-api-key` / `x-goog-api-key` 请求头由原有 `api[_-]?key` 规则覆盖并加测试钉住；`sk-` 在各处统一为大小写不敏感（原先只有诊断是）。
- `runtime-log.ts` 按字段名打码新增「名字恰好是 `key`」一项，`keyboard`、`cacheKey` 这类不受影响。
- 第十批候选 9（B）。
- `account:change-password` 在调用前记下当前站点与账号，成功后读「记住密码」：记住的登录名等于这个账号的用户名，或 vault 的登录提示把这个登录名指向同一账号（同一 realm、同一 userId），就用新密码覆盖；覆盖失败就清掉，不留一个必错的密码。
- `account:reset-password` 成功后，记住的登录名就是重置的邮箱，或两者的登录提示指向同一账号，就清掉那条记住的凭据。
- 认不出来的一律不动：改写或清掉另一个账号记住的密码比留一条旧的更糟。两处都在改密码 / 重置成功之后运行，自身失败一律吞掉，不把一次成功的修改变成报错；不写日志（I3 / I13）。
- `RealmAccountVault` / `RealmAccountService` 新增 `loginHintOwner(identifier)`，只返回 `{ realmId, userId }`，不含任何凭据。不新增 IPC 通道，记住的密码仍由 `account-credential-store.ts` 以 safeStorage 加密落盘。
- 新增 `electron/starter-workspace.ts`。`resolveStarterWorkspaceParent` 选上层目录：优先
  `app.getPath('documents')`；Windows 上文档路径带 `OneDrive` / `OneDrive - 公司名` 一段、或落在
  `OneDrive` / `OneDriveConsumer` / `OneDriveCommercial` 环境变量指的目录里，macOS 上 iCloud 云盘
  容器里有 `Documents`（「桌面与文稿」已打开），以及文档不存在、不是绝对路径时，一律退到用户主目录。
- `createStarterWorkspace` 在上层目录的 `XingmangProjects/` 里建 `my-project`、`my-project-2`……
  名字刻意用 ASCII、不带空格和括号（中文 Windows 上下游工具对非 ASCII / 括号路径的兼容没法逐个
  真机验证）。容器走 `ensureSafeDataDirectory`，候选名用不带 `recursive` 的 `mkdir` 抢（撞名即
  EEXIST 顺延，不先查后建），建成后 `assertNoReparseComponents` 复核整条路径（I8）；已有同名一律
  不复用，最多顺延到 99；上层目录不存在时不替用户建；新目录先过 `classifyWorkspace`，落进敏感
  名单就拒绝；系统错误的英文原文换成中文。
- `buildSensitiveWorkspacePrompt`（`electron/workspace-guard.ts`）多一个按钮与 `createIndex`，
  按钮顺序变为「新建一个项目文件夹 / 换一个文件夹 / 仍然打开」，「新建」是默认按钮（新手少做决定），
  直接关掉对话框（`cancelId`）仍等于「换一个文件夹」。`isOneDriveContainer` 改为导出。
- `workspace:choose`（`electron/ipc.ts`）处理新按钮：建好直接当作这次的工作目录返回，信任写入与
  AGENTS.md 生成照常；建不成弹一句中文说明再回到选择器。日志 `workspace.starter.created` /
  `workspace.starter.failed` 不记路径（I13）。「文档」位置由新的可选项
  `IpcRegistrationOptions.documentsDirectory` 注入，`main.ts` 传 `app.getPath('documents')`。
  通道形状没变，`preload.ts`、`ipc-contract.ts` 与渲染层都没动。

## 0.2.8 - 2026-09-20

- 加速连接与线路检测失败原本不留任何痕迹：`startAcceleration` 失败时返回带错误文案的状态而不是抛错，`ipc.ts` 因此把一次失败的连接记成 info 级的「完成」，而真实错误在 `connectionFailure()` 换成固定文案时就被丢掉了。2026-09-19 交给测试的 Mac 包加速起不来，日志里除了这条「完成」什么都没有。
- 新增 `AccelerationStartFailureStage` 封闭枚举与 `classifyAccelerationStartFailure()`，在 backend 里按失败阶段（`runtime` / `verify` / `ledger` / `proxy`）加错误文本归类，经 worker 的既有诊断通道送到主进程，由 `main.ts` 以 error 级写进 `runtime.jsonl`。
- 跨进程只传枚举成员，不传原始错误文本 —— 与 `onDiagnostic` 既有的「stage only」约束一致：运行时与原生代理助手抛出的错误可能带私有路径或代理细节（I13）。host 侧按枚举白名单过滤，未知 stage 直接丢弃。
- 行为不变：用户看到的文案、状态机、时长计费都没有改动，只增加日志。
- `bundled-acceleration/cores.json` 的两个 amd64 目标原本钉的是 mihomo 的 `amd64` 产物，那是 GOAMD64=v3 构建，要求 AVX/AVX2。Haswell（2013）之前的 Intel CPU 跑不了，Rosetta 2 也不提供 AVX，所以在 Apple 芯片上装 x64 包必然失败：内核一启动就退出，界面只说「加速连接失败」。2026-09-20 的 Mac 真机测试即是此因（`mihomo -v` 直接回 `This program can only be run on AMD64 processors with v3 microarchitecture support.`）。
- `win32-x64` 与 `darwin-x64` 改钉 `amd64-compatible`（GOAMD64=v1）资产，三处 SHA-256 与 zip 内文件名同步更新。arm64 不受影响。原设计（`docs/superpowers/specs/2026-09-14-macos-acceleration-design.md`）写的就是 `darwin-amd64-v1`，此次是把实现拉回设计。
- 两道哈希只证明拿到的是对账表钉的那一份，不证明那一份跑得起来。`prepare-acceleration-bundle.cjs` 在哈希对账之后新增 `assertPortableAmd64Core()`：v3 构建把运行时拒绝文案编进了二进制，按字节判定即可，不需要一台老 Intel 或 Rosetta 机器。另有单测钉住两个 amd64 目标必须是 `-compatible` 资产。
- 按产品策略将现有 12 条共享加速线路及 SHA-256 纳入 `bundled-acceleration`，Windows 和 macOS 资源准备配置省略 `profilePath` 时复用仓库节点，保留外部自定义配置及平台内核、许可、资源完整性校验。
- 新增 `scripts/prepare-acceleration-bundle.cjs`：按 `bundled-acceleration/cores.json` 钉住的版本从 Mihomo 上游取内核与同版本 GPL v3 正文，逐一核对资产、内核、许可三道 SHA-256 后交给
  `stage-acceleration-bundle.cjs` 生成资源目录；下载限定 GitHub 域名与 https，重定向逐跳复校（I10）。`package-for-testing` 两个平台的包因此都带上私有加速线路，
  `run-macos-free-build.cjs` 的「CI 临时签名不携带加速线路」限制随之取消。
- 新增手动触发的 `package-for-testing` 工作流：在 GitHub Actions 上直接出一份可安装的 Windows（走
  `release:build:unsigned` 的完整门禁）与 macOS 包并挂成 artifact，供发布者下载装机验收。macOS 侧由 runner
  现场生成的一次性身份签名，artifact 名字里已自曝身份。
- `scripts/run-macos-free-build.cjs` 新增 `--ci-keep-package`：只与 `--ci-temporary-signing` 同用，把演练
  产物留在 `release-free-ci-<版本>/` 交给 upload-artifact，签名材料与 keychain 搜索列表照旧清理；失败路径
  仍由 `runFreeMacBuild` 自己删掉未完成的输出。
- 新增 `scripts/package-workflow-config.test.cjs` 钉住这条链路的边界：工作流不读任何 secret、run 块里不做
  `${{ }}` 文本替换、第三方 action 钉完整提交号、macOS 侧与 quality 门禁跑的是同一条命令。
- 新增 `docs/CI-PACKAGING.md`：出包步骤、这两份包做不到的事，以及把加速线路、macOS 发布签名和整条发版
  搬上 GitHub 需要准备什么（后者只出方案，未实现）。
- `docs/RELEASING.md` 记录 2026-09-19 产品所有者的决定：推翻原来的「私有节点不得上传 GitHub」，三份加速
  资源改为直接提交进本仓库。构建入口「加速资源目录必须位于项目目录之外」那道检查不因此放松。
- 新增 `electron/download-proxy.ts`：解析 Chromium `session.resolveProxy` 的结果，产出下载用的代理端点，
  以及给包管理器子进程的 `HTTP(S)_PROXY` / `NO_PROXY`。只取列表首项（Chromium 自己会走的那条），
  无法识别的一律按直连处理。
- `createSystemService` 新增 `downloadFetch` 与 `resolveSubprocessProxyEnvironment` 两个注入点，`main.ts`
  分别接到 `net.fetch` 和 `session.defaultSession.resolveProxy`。Grok 二进制下载与 Node.js LTS 下载以前用
  全局 `fetch`（Node 自带网络栈不读系统代理），npm 子进程则完全没有代理变量，两条路都是直连出去。
- 子进程只接受**回环**代理：Windows 安装路径会跨提权边界执行 npm，而系统代理是普通用户可改的设置，
  把任意远端代理交给提权子进程等于让那个设置决定包从哪来。远端系统代理仍然作用于进程内的下载——
  那里由 Chromium 在本进程内终止连接，且每个产物都有签名与摘要校验。
- `scripts/verify-packaged-hardening.cjs` 新增 `assertNoDefaultAppFallback`：打包产物的 `resources/` 里不得
  残留 `default_app.asar`，那是 Electron 找不到应用归档时的回落入口，会自己开窗口。
- `build/entitlements.mac.adhoc.plist` 与它的 inherit 版现在用于**全部** macOS 构建（原先只用于 ad-hoc
  `--dir` 构建），即在 `allow-jit` 之外授予 `com.apple.security.cs.disable-library-validation`。
  hardened runtime 的 library validation 要求进程与它加载的每个库带同一个 team identifier，而该字段
  只有苹果签发的证书才有：没有它，这道校验分辨不出随包框架和任何别的框架，唯一效果是让包起不来
  （dyld：`mapping process and mapped file (non-platform) have different Team IDs`）。签名封印与 hardened
  runtime 的其余部分不变。`build/entitlements.mac.plist` 保留给 Developer ID，撤回步骤写在
  `docs/RELEASING.md` 第 2.1 节。
- 撤回本次发布周期内先前那次无效修法：`scripts/create-macos-free-signing-certificate.cjs` 的证书主题
  改回 `/CN=<名称>`，`scripts/verify-macos-free-signing.cjs` 去掉要求 `OU` 的
  `assertSigningCertificateTeamIdentifier`。带 OU 的证书签出来的包实测仍是 `TeamIdentifier=not set`，
  codesign 不会把自签证书的任何主题字段当作 team identifier。**因此没有因为这条而必须重新生成证书。**
- `scripts/verify-macos-free-artifacts.cjs` 不再写死一张 entitlements 允许清单，改为先读签名自己的
  `TeamIdentifier`（`parseCodesignTeamIdentifier`，唯一一行、失败即拒）再推导：没有 team identifier 时
  必须带 `disable-library-validation`，有时必须不带，两个方向都判失败；并核对每个 helper 与主可执行文件
  的 team identifier 一致。
- 新增 `e2e/macos-launch-smoke.mjs`，解压对应架构的 ZIP 并在隔离 HOME 与独立 user-data 下真正启动打包后的
  `.app`，进程自行退出即失败并打印 dyld 输出。`quality.yml` 的 macOS 作业（改用 `--ci-keep-package`）与
  `package-for-testing.yml` 的 macOS 作业都会跑它——2026-09-19 那份包通过了全部产物校验，**读产物的检查
  永远看不见启动期的失败**。
- 修复 `npm run release:build:unsigned` 里 `npm test` 必挂的一处环境继承：`scripts/macos-build-config.test.cjs`
  与 `scripts/update-release-utils.test.cjs` 有十处 spawn 直接摊开 `process.env`，把门禁自己设的
  `XINGMANG_UNSIGNED_RELEASE=1` 带给了加载 `electron-builder.config.cjs` 的子进程，配置于是在用例断言
  之前先抛「两种发布模式不能同时启用」，五条用例一起红。改成从一份删掉构建模式变量的环境出发，并加一条
  用例钉住这一点。`BUILD_MODE_ENVIRONMENT_NAMES` 随之从 `scripts/run-macos-free-build.cjs` 导出，
  并补进调试放行开关 `XINGMANG_ALLOW_UNSIGNED_RELEASE`（只加禁止项，不放宽 P-24 的清洗）。

## 0.2.7 - 2026-09-19

- 删除中转站点表里与主站点逐字段相同的 `sub2api` 别名条目，只保留 `resolveRelaySite` / `realmForExplicitSite` 里的 `'sub2api' → 'solov'` id 映射，老配置文件照常解析到同一站点；随之删掉 `site-runtime.ts` 里专为该别名写的一致性校验，并把显式账号边界（`requireRelaySite`、站点运行时、后端注册表）改为拒绝这个已退役的 id（D-10）。
- 在 `relay-sites.ts` 注明法律文档恒定指向主站、客服链接按账号分流是有意为之（同一份协议、两拨客服），并补测试钉住这一不对称（D-11，行为不变）。
- CI 覆盖方向不再与出货方向倒挂：出货的 renderer-v2 浏览器回归（`test:v2`）和画布单测（`test:canvas`）加进 linux 作业，旧回滚界面的 10 个 `test:ui` 套件从三个平台降到只在 linux 跑一遍，`test:canvas` 从最慢、最易因 Defender 超时失败的 Windows 作业移走。`scripts/ci-workflow-config.test.cjs` 新增断言钉住这两条（M-03）。
- `check:v2`（旧 testId 覆盖与 renderer-v2 运行时边界门禁）首次接进 CI：报告文件改为 `--report <目录>` 显式开启，不带参数时只打印计数摘要并按退出码判定，缺失的 testId 模式和越界导入直接打进日志。它此前每次运行都往 `docs/` 写三个带 `generatedAt` 时间戳的文件，必被「工作树干净」检查判死，因此从未进过 CI（T-S4）。
- 发版门禁（`npm run release:build` 与 `release:build:unsigned`）的「全部测试」补上 `test:v2`、`test:canvas` 和 `test:ui`。此前它只跑 `npm test`（即 `vitest run electron src`），对真正装到客户机器上的 renderer-v2 界面和画布是 0 覆盖，比 CI 的 Windows 作业还弱一档（《发版前检查清单》缺口 4，与 M-03 同根因）。
- 发版流水线签名链路加固：把签名证书导进 runner 根信任存储的步骤收窄到 `test_signing` 自签名构建，正式构建不再人为制造链信任，中间 CA 缺失、时间戳不可用这类只在干净 Windows 上暴露的缺陷不会再被 Authenticode 校验的「Valid」盖住；`windows-installer` 作业声明 `environment: release`，三个签名 secret 不再对任意分支可见（P-03、P-06）。
- 把落地页发布链路里的生产源站信息移出公开仓库：`scripts/publish-dl-landing.cjs` 不再内置源站 IP、SSH 端口、登录用户、密钥文件名与站点根目录，改为运行时从 `DL_LANDING_*` 环境变量、命令行参数或被 `.gitignore` 忽略的 `dl-landing.config.json` 读取，缺任何一项直接报错停住；`dl-landing/nginx/` 的三份配置改为带占位符的 `.conf.example` 模板，`docs/DL-LANDING-PLAN.md` 删去具体值（P-04）。
- legacy 渲染层补上根级 ErrorBoundary：`main.tsx` 经新的 `RootShell` 包住整棵树，Sidebar / ShellTopbar / 各弹窗 / `App()` 自身 state 与顶层 effect 抛错不再是白屏（打包版已禁用 devtools，此前只能杀进程）；崩溃面板在没有 toast 宿主时就地显示导出结果。同时把 `App.tsx` 账号切换器的 `accountBaseUrl!` 换成 `relaySiteAccountsOrigin()` 的显式回落（R-S10）。
- macOS 免费分发产物验证补上 DMG 与签名强度两处缺口：每个 `.dmg` 现在会以只读方式挂载，内部 `.app` 走与 ZIP 完全相同的签名、叶证书、`app-update.yml`、Info.plist 与 asar 校验，验证结束（含失败）一律卸载，指定要求与证书连续性断言也从两个 ZIP 扩到全部四个产物（P-08）；同时断言主可执行文件与 `Contents/Frameworks` 下每个 helper 都启用了强化运行时，且 entitlements 键集合精确等于允许清单（只有 `com.apple.security.cs.allow-jit`），签名配置被改弱不再三道关全绿（P-09）。
- 修复 renderer-v2 的错误展示既不剥 Electron 的 IPC 通道名前缀、也不脱敏绝对路径：`business-common.tsx` 新增 `rawErrorMessage` / `userFacingErrorMessage`（与 legacy `src/error-message.ts` 等价，两棵渲染树各留一份），`errorMessage` 改为先剥前缀再脱敏后判断语言与类别，并接受按场景的兜底文案；22 处直接把 `cause.message` 上屏的 v2 调用点改走它，补上 v2 侧此前缺失的单测（R-S7）。
- 修复非管理员（默认）启动时 Node.js 兜底 MSI 安装必然失败：暂存目录改用普通用户临时目录，提权脚本自行在 Program Files 下建立仅管理员可写的目录、复制安装包并在提权侧重新校验 SHA-256 与 Authenticode 后才交给 msiexec；补上授权取消、跨账号授权等退出码的中文提示（E-S7）。
- 无签名发布通道（`XINGMANG_UNSIGNED_RELEASE=1`）不再静默下载和安装更新：启动检查只提示发现的新版本，下载和安装都要用户在更新页确认。该通道缺少 `publisherName`，`electron-updater` 会直接跳过安装包签名校验，仓库里的严格 Authenticode 校验器因此从不被调用（审查总表 M-02）。
- 更新包下载完成后，主进程按更新清单里对应文件的 SHA-512 重新校验安装包，清单缺少该校验值、无法完成校验或校验不一致都拒绝安装并在更新页说明原因。校验读取的是打开后的同一个文件描述符，并拒绝存在多个硬链接的安装包。
- 更新页显示当前是否为未签名通道，`runtime.jsonl` 在启动时记录一条对应的警告。
- 新增 CLI 已验证版本名单（`electron/cli-verified-versions.ts`）：安装与更新默认装名单里的推荐版本而不是 npm latest，已装版本落在已知不兼容区间时在首页给出中文原因与「回到推荐版本」入口，设置里新增「命令行工具总是装最新版」开关（默认关）。名单首版只维护 Claude Code，其余三个 CLI 行为不变，维护方式见 `docs/CLI-VERIFIED-VERSIONS.md`。
- 首页工具行接上主进程已有的安装阶段文案、下载百分比与探测失败原因（A1）。
- 失败提示接入 `registry/errors.ts` 的中文文案与可执行按钮，保留后端原文供客服排查（A2）。
- 卸载需要手动清理时渲染 `manualHelp.manualCommand` 与复制按钮，兑现后端文案的承诺（A3）。
- 无签名 Windows 发布入口 `npm run release:build:unsigned` 改为与签名入口共用 `scripts/run-release-build.cjs` 的同一份门禁步骤表；此前它只做 `compile + electron-builder`，前置检查、类型检查、单测、冒烟、fuse 加固、ASAR 篡改、`latest.yml`/SHA-512/blockmap 一步都不跑（审查总表 M-01）。无签名模式下只跳过 Authenticode 签名主体比对，并在日志里打印跳过原因。
- 新增 `npm run release:verify:unsigned`：无签名模式下也能在本地校验 `latest.yml` 结构、文件大小、SHA-512 与 blockmap。
- 删除只认 legacy `.app-shell` 选择器的 `e2e/electron-smoke.mjs`；发布门禁改跑 CI 同样在跑的 `e2e/electron-ci-smoke.mjs`，并由 `scripts/ci-workflow-config.test.cjs` 钉住「门禁跑的冒烟脚本必须也在 Windows 必需作业里跑」。
- 修复 v2 聊天页每次渲染都把全部会话正文拼成大字符串重新搜索：过滤改为 `useMemo`，搜索框为空时不扫正文，非空时按会话对象缓存可搜索文本，流式输出只重扫被分片改动的那个会话（R-S5）。
- macOS 视觉验收脚本（`npm run test:mac:visual`）改用 renderer-v2 的 `data-testid`：此前脚本等待的 `.app-shell`、`.main-nav`、`.cli-card` 等选择器全部来自 legacy 界面，而 `npm run compile` 默认产出 renderer-v2，脚本第一步就固定超时 60 秒，macOS 的布局回归实际无人把关（审查总表 T-S3）。新版检查 v2 壳层分区、首页五个工具行、安装卸载页工具行，并用工具配置对话框做窄窗口下的弹窗几何检查。legacy 的「卸载帮助」按钮在 v2 里没有对应入口（v2 的手动清理弹窗只在真正执行卸载并收到 `manualHelp` 后才出现），相关断言无法平移，已在 PR 中说明。
- 设置页「主题」分组的切换控件补上 `settings-theme` 测试标识与无障碍名称。
- `electron/codex-desktop-appx.test.ts` 里两条 Windows 专有用例的 PowerShell 等待不再写死 15 秒：
  改成一个有界、可用 `XINGMANG_POWERSHELL_TEST_TIMEOUT_MS` 覆盖的预算（默认 90 秒），
  理由与 `e2e/fixture-readiness.mjs` 的夹具预算相同——冷启一次 Windows PowerShell 5.1
  不是这两条用例要断言的东西，而 #174 把六个作业放上同一台 runner 之后 15 秒不够用。
  断言一字未改。同时在超时被杀时把预算写进错误消息：`execFile` 只在子进程非零退出时追加
  stderr，超时杀掉时消息只剩一行 `Command failed`，此前要靠反推才能判断是哪一种失败。
- `electron/codex-desktop-appx.test.ts` 的两条 Windows 专有用例不再把生成的 PowerShell
  脚本塞进 `-EncodedCommand`：脚本与待解析的 JSON 现在写到临时目录，用
  `-ExecutionPolicy Bypass -File` 调用。解析用例原先的命令行约 28 KB（UTF-16LE 再 base64
  会把脚本放大 8/3），离 Windows 32767 的命令行上限只剩一点余量，在并行分片的 runner 上
  偶发起不来子进程；SID 门用例原先也有 9 KB。新增一条跨平台用例把最终命令行长度钉在
  cmd.exe 的 8191 以下。
- 未发布的变更日志条目改为分片：每条 PR 在 `changes/unreleased/` 下放一个自己的文件（`## 用户` 进
  `release-notes.md`，`## 开发` 进 `CHANGELOG.md`），发版时 `npm run changelog:collect` 汇总进两份文件的未发布段
  并删除分片；`npm run changelog:check` 只校验格式。并行 PR 因此不再抢同一段文本——而带冲突的 PR 算不出
  merge ref，GitHub 根本不会触发 `pull_request` 工作流，线程只能反复合 main 去抢一次 CI。
- `quality.yml` 的 `changes` 作业跑 `changelog:check`：它是唯一检出完整历史（能和 PR base 比对未发布段）
  且不因「纯文档改动」跳过的作业，而直接编辑 `CHANGELOG.md` 正是这种形状。发版汇总提交会同时删除分片，
  据此放行。
- quality 工作流的 Windows 作业从一个串行作业拆成并行分片，把每个 PR 的墙钟等待从约 27 分钟压到 10 分钟以内。
  原先 `test:windows`（约 11 分钟）与 `test:v2`（约 9 分钟）在同一台 runner 上前后跑，其余五台闲着。
- 新的 `windows-test` 是一个 `fail-fast: false` 的矩阵：`test:vitest` 的两个 `--shard` 半区、`test:node`、
  `test:v2:vitest`、`test:v2:browser`；`windows-package` 单独承担 typecheck、compile、三个 Electron
  冒烟与打包加固检查（这些步骤各自带 `timeout-minutes`，且彼此有先后依赖，所以不进矩阵）。
- `package.json` 把两条组合脚本拆出可分片的半区：`test:vitest`、`test:v2:vitest`、`test:v2:browser:1`、
  `test:vitest:1`、`test:vitest:2`。`npm test`、`npm run test:v2` 的行为与覆盖范围一字未改，
  本地照常用它们。没有跳过、禁用或重试任何用例，也没有调低任何超时。
- 新增一个只做汇总的 `test` 作业：把 Windows 各分片折回成一个同名检查，既让可能按名字要求 `test` 的分支保护继续
  成立，也让「被取消的矩阵」不会被读成通过（它自己判定改动范围，文档类改动时报成功而不是 skipped）。
  `quality-gate` 相应改为读 `test` 的结果。
- `windows-package` 不再装 Chromium：它的冒烟一律走 `_electron.launch`，用的是安装时落下的 Electron，不是下载的
  Chromium。`scripts/ci-workflow-config.test.cjs` 补了分片完备性门禁——vitest 半区必须逐个被矩阵派发，
  `test:v2:browser` 的两半合起来必须与整份文件清单逐文件相等且无重复，任何一半漏派发或漏文件都会红。
- 代价是 runner 并发槽位而不是分钟数：仓库是公开的，Actions 不计费；账号的并发作业上限由所有 open PR 共享，
  同时挂着二十多条 PR 时分片会排队而不是失败。排队不算执行时间，`timeout-minutes` 计的是执行时长，所以各作业
  的超时上限不需要因排队而调大。
- `test:v2:browser` 有意整份派发，不再往下拆：它的每个文件都用同一套 `configFile: false` 根目录建 Vite dev
  server，共享磁盘上同一份 `node_modules/.vite` 依赖预构建缓存，前面的文件替后面的文件把它捂热，而
  `app-check.mjs` 跑在最后、受益最大。拆到两台 runner 上之后 app-check 拿到的是冷缓存，跑到 NewAPI 公告合集
  那条用例时触发 Vite 重新预构建，把 90 秒的夹具挂载预算撑爆（run 35420361508）。门禁加了断言钉住这一点。
- 每个分片的命令各自带 `timeout-minutes`（约为实测耗时的两倍：vitest 半区 15 分、`test:node` 与
  `test:v2:vitest` 10 分、浏览器套件 18 分）。套件失速而不是失败时——#172 的 `test:v2` 就曾停滞 42 分钟、
  把整个 45 分钟的作业拖到上限被杀，日志里看不出是哪一步——现在只损失这一片，而且报得出是哪一片。
- E-B1：把 `realm-account-vault-file.ts` 已写对的「拒绝 safeStorage `basic_text` 后端」谓词
  提取为 `safe-storage-backend.ts`，`account-session-store.ts`、`account-credential-store.ts`、
  `saved-accounts.ts`、`chat-key-store.ts`、`managed-cli-key-store.ts` 五处统一改用；
  `main.ts` 的启动告警区分「不可用」与「明文后端」两种原因。
- E-G7：`ManagedCliKeyStore.save` 只在解密或校验失败（`ManagedCliKeyCacheCorruptError`）时隔离缓存，
  读取期文件变化、`nlink !== 1`、超限等瞬时失败改为抛给调用方，不再连坐其他账号的缓存 Key；
  `.corrupt-*` 副本最多保留 3 份。
- E-B5：`ChatKeyStore` 的 `remove` / `removeByKeyId` / `removeAccount` 把失效标记的清除挪进
  `finally`，并只清除本次写入的那一版，写盘失败不再让分组永久重签 Key。
- 修复账号来源切换后仍读主账号服务设置：`createAuthApi.getStatus` 改为按 `siteId` 取，`AuthFlow` 的状态 effect 依赖加上 `siteId`，切到历史账号时重新拉取；`turnstileCheckEnabled` 生效后「打开帮助」入口在登录态也可见（注册仍固定主账号服务，注册开关语义不变）（D-04）。
- D-05：`electron/sub2api-account-client.ts` 的 `keySummary` 把缺省的 `quota` 归一成 0
  （这个后端用 0 表示不限额），`Sub2ApiKeySummary.quota` 随之改成必填。此前同一把 Key
  在 `sub2api-relay-backend.ts` 的 `listKeys`（读成「限额 0」）与 `usable()`（读成「不限额」）
  两处被按相反语义解读。
- D-07：删掉已无生产调用方的 `findExistingCliKey`——`relay-backend.ts` 的接口声明、
  `new-api-client.ts` 与 `sub2api-relay-backend.ts` 两份实现、`findNewestCliKeyIdByNamePrefix`
  及各自的测试。同时订正 `relay-backend.ts` 四处指向已删除的 `buildCanvasTokenDependencies`
  的注释：画布的 Key 现在由主进程的 `chat-credential-coordinator.ts` 按分组签发（I15）。
- 渲染层「账号 origin → 站点 id」的映射收口到 `account-context.ts` 新导出的 `siteIdForOrigin()`：两个域名字面量只在该文件的
  `siteOrigins` 表里各出现一次，`accountOrigin()` 也改为读这张表，`account-switch-sync.ts`（`unchangedPreviousRelay` 两处 +
  两处已知 origin 的 `includes` 判断）与 `App.tsx`（账号切换回调）各自抄写的字面量改为调用它。此前加站点或改域名漏掉任何
  一处都不会编译报错，只会在运行时把账号算到错的站点上（D-09）。
- 未知 origin 返回 `null` 而不是回落成历史站点，调用方据此拒绝本地账号记录；对已知 origin 保持逐字匹配，与原来的
  `includes` 判断逐字等价，行为不变。
- D-12：`e2e/realm-account-smoke.mjs` 改用 `e2e/smoke-runtime.mjs`（逐步硬超时、全局预算、
  stderr 进度日志、收尾强杀残留 electron 进程），三十余处裸 `page.evaluate` /
  `application.evaluate` 全部包上截止时间，只读的主进程求值按「仅匹配 inspector promise
  被回收」重试，驱动退出的那一处不重试；夹具等待统一取 `e2e/fixture-readiness.mjs` 的
  `fixtureReadyTimeoutMs`，不再写死 30000/60000。
- 这条双站点端到端冒烟接进 quality 工作流的 Windows 作业（步骤 `timeout-minutes: 10`，
  脚本自身预算 8 分钟），并纳入 `scripts/ci-workflow-config.test.cjs` 的两条门禁清单，
  失败时的 PNG 与 result.json 随 smoke 产物上传。
- `electron/platform/macos-system-proxy.ts` 的 `prepareMacosProxyHelper` 每次调用都 `mkdtemp`
  出一份新的私有副本，全仓没有任何删除路径，`XingMangProxy/helpers` 无上限累积（审查总表 E-B11）。
  新增纯函数 `planMacosProxyHelperCleanup` 给出保留规则，`prepareMacosProxyHelper` 在校验通过、
  返回之前按它扫一遍缓存目录并删除退役副本：只认 `mkdtemp` 造出的 `<sha256>-` 前缀目录，
  跳过本次新建的那份，保留 mtime 最新的 2 份，且只删 24 小时以前的——authd 在每次授权时都会重新
  检查运行中 helper 的可执行文件，模块这一侧没有办法问系统「哪份副本还有进程在跑」，所以用时间当
  存活近似，避免删掉另一个仍持有恢复职责的实例正在运行的那份。目录列举走 `readDirectoryEntries`
  并设上限，逐项 `lstat`（不跟随符号链接），清理失败只 `console.warn` 一条经 `redactHomeDirectory`
  脱敏的信息并照常返回已验证的副本，绝不让清理失败挡住代理启动。
- E-B2：`realm-account-service.ts` 的 `login` 删掉双候选回退。站点现在只由调用方显式指定的
  `siteId`，或 `vault.preferredLoginSite(identifier)` 的确定性结果决定（都没有时回落 `solov`），
  一次登录只有一个后端拿到明文密码；原先邮箱标识符在第一个后端明确拒绝后会把同一份密码再 POST
  给第二个。后端自己的拒绝错误现在直接透出，不再被包成 `RealmAccountError('LOGIN_REJECTED')`。
- E-B15：`account:get-remembered-login` / `account:set-remembered-login` 传明文密码是有意的产品
  取舍（落盘走 `safeStorage`），在 CLAUDE.md 的 I3 下登记为显式例外，不改行为。
- E-B4：`electron/updater.ts` 的 `isProxyConnectionFailure` 改为只认结构化的
  `code === 'ERR_PROXY_CONNECTION_FAILED'`（含有界的 `cause` 链），不再把
  `code` / `message` / `description` 拼成一段文本做子串匹配——更新源返回的 HTML
  错误页或发行说明里出现这串字样，就足以把更新会话踢下用户配置的代理。
- E-B4：`UpdaterRuntime` 新增可选的 `restoreProxy`，`main.ts` 传入
  `setProxy({ mode: 'system' })`；direct 模式的作用域收窄到触发它的那一次请求，
  重试成功或失败都在 `finally` 里恢复。
- E-B3：删除 `electron/backend-registry.ts` 及其测试。`allowSub2Api` 分期开关全仓
  零调用者，真实装配走 `main.ts` 的 `createRealmAccountService`，这道闸门从未生效。
- E-B6：`tool-installation.ts` 的 `resolveCliCommand` 为 darwin 上 `source === 'native'` 的 claude
  补上来源校验（此前落到兜底分支零校验，而 codex / grok 在同一位置已做 Developer ID 校验）。
  新模块 `electron/macos-claude.ts` 复用 `darwinDeveloperIdVerificationArgv`，把信任交给 codesign
  的退出码，团队号 `Q6L2SF6YDW` 逐字节取自官方分发的二进制（`@anthropic-ai/claude-code-darwin-arm64`
  与 `-darwin-x64` 2.1.278 的 CodeDirectory teamID 与 CMS leaf
  `Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`），不是照文档抄的。
- 与 codex / grok 不同，这条路径**不做私有暂存**：那两者要在可变的版本链接树里绑定一次"选择"，
  而 native claude 解析后就是一个普通文件，校验的路径就是交给 spawn 的路径；剩下的竞态属于
  同 uid 主体，按 T5 不在 macOS 防御模型内，而该二进制有 200 MB 以上，每次会话复制一份代价过高。
  校验结果按文件身份（dev/ino/mode/size/ctime/mtime）缓存，避免每次解析都重新哈希整个二进制。
- 修复 E-G1：`command-runner.ts`、`diagnostics.ts`、`startup-log.ts` 三份独立的脱敏正则都漏掉了
  JSON 与 JS 对象写法的引号键——`\s*` 跨不过键名的收尾引号，`{"access_token":"…"}` 一类内容
  原样落进 `runtime.jsonl` 与反馈导出。三处同步补上两条按引号形态匹配的规则，只替换引号之间的
  值，脱敏后的 JSON 仍可解析；三个测试文件各加一条 JSON 形态断言。
- 修复 E-G4：`startup-log.ts` 的 `drainStartupFailures` 原先用 `readFileSync` 无界读取，
  既不查符号链接、也不查 `nlink`。现在先 `lstat` 要求普通文件、非符号链接、单链接且不超过该模块
  自身可能写出的体积，再以 `O_RDONLY | O_NOFOLLOW` 打开并用 `fstat` 复核 dev/ino 后才读，
  校验失败也照样清除该文件。全部用裸 `fs`，保持该模块只依赖 Node 内置模块的约束（I8）。
- `electron/platform/ipc.ts`：9 个 `xingmang-platform:*` 通道补上结构化审计日志（E-G10）。
  读取类记 `debug`、改机器状态类（开机自启、崩溃上报等）记 `info`，都带通道名、耗时与
  一份只含枚举值的参数摘要；被 `assertPlatformOwner` 拒掉的调用记 `warn` + `security`
  并带上发起页面的 URL；参数校验失败与服务抛错记 `error`，detail 里只有耗时与错误本身。
- 新增 `electron/platform/runtime-log-bridge.ts`：`desktop-entry.ts` 注册 platform handler
  的时刻早于 `main.ts` 建 `RuntimeLogStore`，这期间的日志先缓冲（上限 50 条，溢出时补一条
  计数），`main.ts` 建好 store 后一次性接管补发。
- E-G11：`electron/windows-machine-paths.ts` 的 Program Files ACL 探测结果不再永久缓存。
  缓存项带上时间戳并加了 5 分钟 TTL（与 `macos-codex-app.ts` 的深度签名校验缓存同量级），
  时钟回拨也按过期处理；长驻进程不会再按数小时前的旧结论放行 trusted-only 执行。
- E-B10：`electron/trusted-temp.ts` 在非 Windows 平台创建安装缓存根时，除符号链接与
  目录联接外还核对属主与权限位。属主是自己但权限偏松就收紧回 `0o700`；属主不是自己
  （同机其他账号抢先占用了 `os.tmpdir()` 下那个固定名字）就放弃这个可预测路径，改用
  `fs.mkdtemp` 现场生成随机名的根。
- Codex 桌面端中文注入前先按激活拿到的 PID 校验调试端口归属：新增 `resolveCodexDesktopCdpPortOwners`（`Get-NetTCPConnection -State Listen` 取 `OwningProcess`）与纯函数 `parseCodexDesktopCdpPortOwners` / `classifyCodexDesktopCdpPortOwnership`，端口未绑定则继续等待，出现非本进程的监听者则中止注入，拿不到 PID 一律不注入；端口分配的 TOCTOU 窗口因此不再可利用（E-G12）。
- `launchCodexDesktop` 改走 `installationQueue.enqueue`，键为 `desktop:codex:launch:<模式>:<是否中文>`：只靠 `codexDesktopInstalling` 布尔标志时，已入队但尚未开始的安装拦不住启动（E-B7）。
- E-G13：`electron/external-client-runtime.ts` 的 macOS `/bin/ps` 探测改为显式 `trustedOnly: false`，
  与同一分支另外三处对齐。POSIX 上 `runCommand` 对这个开关只换环境、可信路径校验被静默丢弃，
  留着 `true` 等于替 macOS 宣称一个它拿不到的保证。新增 darwin 用例断言该分支每次执行都带
  `trustedOnly: false`。
- R-G8：订正 `src/provider-registry.ts` 两处与 rank 表对不上的顺序注释（概览序实为
  claude/codex/gemini/grok，与管理序的差异在头两位而非 Gemini/Grok），并写明这两套顺序只服务
  已冻结的 legacy 树；renderer-v2 自 v3.1.1 起统一为单一顺序，`registry/tools.test.ts` 新增用例
  钉住 `tools` 数组次序与 `shortcutIndex`。
- E-B13、T-B7：核实后无需改动——CLAUDE.md 的计数与 `vitest.config.ts` 表述已随 #172 的瘦身一并
  订正，文件顶部的维护约定现在明令不写计数；本次只删掉该约定里自己残留的行数计数。
  `ipc.test.ts` 已有对 `ipcInvokeChannels` 全量且顺序敏感的 `toEqual`，通道总数断言严格弱于它，
  不再重复添加。
- `provider-extensions.ts` 的 `mcpInstallArgv` 在 gemini 分支补上 `--` 分隔符，与 codex / claude / 兜底三条对齐
  （审查总表 E-G3）。`@google/gemini-cli` 的 `mcp add` 用 `parserConfiguration({'unknown-options-as-args': true,
  'populate--': true})` 加一条 middleware 把 `argv['--']` 并回 `args`，所以分隔符放在 `<commandOrUrl>` 之后。
- 新增跨四个 provider 的回归测试，钉住「用户提供的以 `-` 开头的 MCP 参数一律落在 `--` 之后」。
- 加速会话目录（含明文节点口令与内核副本）改为每次启动前扫描清理：按 `session-<uuid>` 命名匹配、跳过本进程仍在使用的目录，逐个文件走与停止路径相同的 reparse / 单链接校验后删除，清不掉的留给下次而不阻塞启动，不使用 `fs.rm(recursive)`（E-G5）。
- `reserveLoopbackPorts` 改为持有监听直到 spawn 前一刻释放，把预留端口被本机其他进程抢占的窗口从"内核复制 + 校验"整段收窄到 spawn 本身；`awaitController` 之后新增 `/configs` 确认内核上报的 `mixed-port` 等于预留端口，不等则失败关闭（E-B16）。
- Codex 桌面端的中文运行时注入改为显式开关：只有用户点过「启用中文界面」才会在打开 Codex 时附带本机调试端口，`config.toml` 里的 `localeOverride = "zh-CN"`（本程序自动写入的默认值）不再被当作同意；配置里新增「跟随系统语言」可随时关闭（E-S3）。
- 升级后第一次打开 Codex 桌面端时，若此前没有明确选择过，会一次性询问是否启用中文界面并说明该端口，选过之后不再询问，老用户不会无声变回英文。
- `canvas-run-store.ts` 的 `stateContainsSecretOrPath` 原来扫整份序列化内容，而 `text` /
  `prompt` / `note` 执行器返回的就是用户敲进去的文本（`canvas-node-executors.ts:113`），
  原样进 `attempt.outputText`，于是 `/https?:\/\//i` 与 `/(?:[A-Za-z]:\\|file:\/\/)/i` 命中用户
  自己的内容，`writeState` 每次都抛，`canvas-run-engine.ts` 在付费生成之后才抛给用户；读路径同样
  把这种文件判为损坏并清空运行历史。新增 `stateScanSubject`，用 `JSON.stringify` 的 replacer 把自由
  文本字段（`outputText` / `errorMessage`）从被扫描的那份序列化里剔掉，写盘内容不变，资产引用、各类
  标识、`mimeType`、`taskId` 等结构化字段仍然拒收凭据、远端地址与本机路径；读路径改为先 `parseState`
  再对同一份投影断言。未对用户内容做脱敏改写——该字段会经 `storeCache` / `resolveCache` 喂给下游节点，
  改写它会让命中缓存与未命中缓存产出不同的提示词（审查总表 E-S6）。
- 收紧四处会静默放行的 e2e 断言（T-G2、T-G3、T-G4、T-G11），不改被测代码：
- T-G2：`e2e/account-commerce-interactions.test.mjs` 的多视口视觉检查，账号导航按钮加数量下限
  （空集合不再让 `every` 恒真）、表格末列固定失配从三元 fallback `true` 改为判负并限定在两个表格分区、
  删掉按定义恒真且从未被断言的 `bodyHasScrollableContent`。
- T-G3：新增 `e2e/page-errors.mjs`，12 个浏览器套件统一记录 `pageerror` 并在收尾断言为空
  （`v2-business.test.mjs` 原本只 `console.error`，CI 日志里会被淹掉）；
  `scripts/ci-workflow-config.test.cjs` 加门禁，新套件漏挂即红。
- T-G4：`e2e/maintenance-layout.test.mjs` 不再断言抄进测试的一份 markup 副本，改为挂 `MaintenancePage`
  真实渲染出来的行（新增 `e2e/maintenance-layout-fixture.html` / `.tsx`），组件结构改动后这些断言才会真的红。
- T-G11：`e2e/primary-views-interactions.test.mjs` 的「减少动画」断言原先选择器
  （`.welcome-orbit,.welcome-node`）在页面上一个元素都匹配不到、恒真；改成从页面本身读出所有仍在播放的
  装饰动画。据此发现 legacy 欢迎页 `data-motion-paused` 没有对应样式规则、两圈星轨照转，
  legacy 已冻结故按现状钉住并注明，等修复后该断言会主动变红提醒收紧。
- `e2e/account-commerce-interactions.test.mjs` 的 21 处 `page.goto` 统一走本文件的 `visit()`，
  挂载等待复用 `e2e/fixture-readiness.mjs` 的 `fixtureReadyTimeoutMs`，治整跑 `npm test` 时的偶发 30 秒超时；
  用例自己的断言仍用默认超时。
- `npm run dist:mac:free` 新增 `--acceleration-arm64` / `--acceleration-x64` 两个命令行开关：给出各架构的
  私有资源目录后，入口改为分两次单架构调用 electron-builder（各自只看到自己架构的资源目录），再把两次产物
  合并进同一个发布目录交给现有产物校验；不传参数时行为与此前完全一致，仍是一次 `--arm64 --x64` 构建。
- 开关只认命令行，不放松 P-24 的环境清洗：继承来的 `XINGMANG_ACCELERATION_BUNDLE_DIR` 仍会被删掉，只有
  显式给出、且 `manifest.json` 的 `platform` / `arch` 与目标架构相符的目录才会写回子进程环境，写反两个
  参数在构建开始前就被拒。两个架构必须同时提供，`--ci-temporary-signing` 与这两个开关互斥。
- 新增 `scripts/merge-macos-free-artifacts.cjs`：校验两个分架构输出目录（产物齐全、无越界产物、
  `latest-mac.yml` 确属该架构与该版本），把六个产物移入发布目录，合并出同时引用两份 ZIP 的
  `latest-mac.yml`（以 arm64 那份为底，只替换文件列表），再删掉分架构子目录；全部检查通过后才开始移动。
- `docs/RELEASING.md` 第 2 节、`docs/MACOS_FREE_DISTRIBUTION.md`、`docs/MACOS-VERIFY-RUNBOOK.md` 第 3 节与
  `docs/GLOBAL-ACCELERATION.md` 里「macOS 包带不了线路」的说法改为带开关的做法。
- macOS 免费分发构建脚本 `scripts/run-macos-free-build.cjs` 收口六条发版链路问题（P-18、P-19、
  P-24、P-25、P-34、P-39），并清掉 P-37 里那处永假的返回码判断。
- P-18：临时 keychain 口令与 P12 口令不再出现在 `security` 的命令行参数里，改为把整条子命令
  写进 `security -i` 的 stdin；同机 `ps -axww` 因此再也读不到它们。失败信息里的口令会被替换成
  `***`。同时拒绝在 `RUNNER_ENVIRONMENT` 不是 `github-hosted` 的 runner 上跑临时签名。
- P-19：注册 SIGINT / SIGTERM 处理，取消构建时先跑完同一套清理再把信号重新抛给自己，不再把
  用户域 keychain 搜索列表留在指向已消失的临时 keychain 的状态；解析结果为空或含相对路径时
  直接拒绝改动，恢复动作也不会再退化成会清空搜索列表的裸 `list-keychains -d user -s`。
- P-24：`BUILD_MODE_ENVIRONMENT_NAMES` 补上 `XINGMANG_UNSIGNED_RELEASE`、
  `XINGMANG_ACCELERATION_BUNDLE_DIR`、`XINGMANG_SIGNING_PUBLISHER`，免费分发包不会再因为环境
  残留而带上私有加速资源。
- P-25：本地 `dist:mac:free` 失败后自己删掉本次创建的输出目录（按创建时记录的 dev/ino 复核后
  再删），不必在发布压力下手工 `rm -rf`；调用方自带的空目录一律不删，只在报错里给出绝对路径。
  `scripts/update-release-utils.cjs` 的「输出目录不是空目录」文案同步说明该怎么处理。
- P-34：keychain 口令、P12 口令与临时输出目录名各取一份独立随机熵，任一泄露不再能推出另一个。
- P-39：`resolveMacosSecurityCommand` 的第二个参数不再被静默丢弃，它现在就是声明哪些参数是机密
  的通道。
- 修复 macOS 免费分发产物验证在真实构建上必然失败的回归：`hdiutil attach` 会改写被挂载
  镜像自身的时间戳，而 DMG 验证器挂载的正是按 identity 绑定的私有副本，随后的复核把验证
  自己造成的时间戳变化判成「发行文件私有副本 … 在验证期间已变更或被替换」。DMG 检查结束后
  改为重新基线化私有副本的 identity，前提是内容 SHA-256 与复制时一致、dev/ino/size 未变
  ——用一次完整的内容复核换掉一个由验证器自己盖上的时间戳，不是放松校验。ZIP 路径不挂载
  任何东西，仍走原本严格的 identity 复核。
- 回归自 #157 给 DMG 加挂载校验时引入，此前 DMG 只做哈希；因为真实打包那一步只在 push
  事件上跑，而近期 main 上的 push 运行被并发取消，直到现在才在 CI 上暴露。
- macOS 免费分发产物验证补上 Electron fuse 加固断言（P-17）：fuse 期望值抽成跨平台的
  `scripts/electron-fuse-hardening.cjs`，Windows 与 macOS 共用一份；macOS 侧直接读取
  `Electron Framework.framework/Versions/<版本>/Electron Framework` 的 fuse 线缆，
  不经 `Versions/Current` 符号链接，并校验二进制内的每一根线缆而非只看第一根。
- `verify-macos-free-artifacts.cjs` 解压前改用 `unzip -Z` 读取条目权限位，拒绝以符号链接
  充当目录、后续条目写穿过去的 ZIP（P-21）；清单解析在行不可解析或条目数与档头不一致时失败。
- 发行验证流程不再为已经落在私有目录里的 ZIP 再复制一份，四个产物的峰值临时占用减半（P-35）。
- 三处永假的 `result?.code` 兜底判断改成具名的 `assertCommandSucceeded` 契约断言，
  注入式 runner 若以非零退出码 resolve 而非 reject 会被当作失败（P-37）。
- `e2e/maintenance-layout.test.mjs` 改为整个文件共用一个 page：`browser.newPage()` 每次都新建
  BrowserContext，HTTP 缓存是空的，整张模块图要从 Vite dev server 重新取一遍，Windows runner 上
  好几个 e2e 文件并行跑时第二次冷开连 `fixtureReadyTimeoutMs`（90 秒）都不够（quality run
  35423428733：同一文件第一个用例 4.1 秒通过，第二个卡满 90 秒超时）。现在只在 `before` 里挂载
  一次，用例之间改视口宽度切换窄屏/宽屏分支。断言与超时预算都没有放宽。
- 功能 N2 扩展：`electron/connection-check.ts` 的分层归因从只支持 Claude Code 扩到四个
  provider。探测形态按工具收口在 `probeShape` 的穷尽 switch 里（无 default，加第五个 CLI
  是编译错）：Claude Code 保持原有的 `POST /v1/messages`（`max_tokens: 1`）不变，Codex /
  Grok / Gemini 走只读的 `GET …/models`，用各自配置文件里真正写着的 Key、base URL 与模型。
- 模型清单是按令牌分组过滤后的，所以「清单空」判分组层、「清单里没有这个模型」判模型层，
  无需为问出这两层去发一次计费的生成请求。失败侧（状态码 + 上游中英文关键词）四个工具共用
  同一张归因表。
- Gemini 的探测走 `/v1/models` 而不是它自己的 `/v1beta` 形态：本仓只实测过前者
  （`system-service.ts` 取模型清单用的就是它），令牌本身与协议无关，猜一个未实装的
  `/v1beta/models` 会把 404 误报成「服务上没有这个接口」（T12）。
- 新增 `unconfigured` 归因层，与 `config` 分开：没装没配不是故障，结果页显示为中性的
  「未配置」。`ConnectionCheckResult` 新增可选的 `evidence`，由主进程说明这次到底做了什么，
  渲染层不再照 provider 猜探测形态。
- `src/renderer-v2/pages-maintenance.tsx` 的连接自检卡片改为按工具分块（testId
  `health-connection-result-<provider>`），单个工具的 IPC 失败只影响它自己那一条；
  `connectionCheckView` 拆出 `statusLabel`，层名显示在工具名旁边不再塞进标题。
- 覆盖：`electron/connection-check.test.ts`（探测形态、清单归因、四工具共用失败表、Key 不
  外泄）、`src/renderer-v2/features/tools/connection-check.test.ts`、
  `src/renderer-v2/testing/app-check.mjs` 两条浏览器用例。
- N3：新增 `src/renderer-v2/features/account/tool-usage.ts`（纯函数汇总与文案）与
  `ToolUsage.tsx`（用量看板里的「按工具分账」卡片），数据复用 N4 已有的
  `resolveManagedCliKeyLimits`，不新增任何服务端接口。已用量是累计值而非本月值，文案据此写「累计已用」。
- 没有托管密钥的工具不计入占比分母，避免把未启用当成零消费；
  `e2e/v2-business-fixture.tsx` 新增 `managedKeys` 开关供浏览器用例使用。
- 密钥页新增「每个工具的额度上限」卡片（N4）：四把托管 CLI 密钥各自可单独封顶，显示已用与上限剩余。
  金额与两个账号后端额度单位的换算、托管密钥识别和更新入参构造收口到 `electron/account-key-quota.ts`
  （原 renderer-v2 的 `accountKeyQuota` 一并移入），走既有的 `account:list-keys` / `account:update-key`，
  不新增 IPC 通道。
- 四个浏览器测试夹具在 `page.goto` 之后补上等 `#root` 挂载再把 page 交给用例：
  `src/renderer-v2/features/auth/browser-check.mjs`、`e2e/v2-business.test.mjs`、
  `e2e/app-v3-interactions.test.mjs`、`e2e/renderer-v2-gap-audit.mjs`，预算复用 `e2e/fixture-readiness.mjs`
  的 `fixtureReadyTimeoutMs`，四者一并纳入 `ci-workflow-config.test.cjs` 的门禁清单。首屏要等 Vite
  按需转换模块图，Windows runner 冷跑常超过用例的默认超时，首条语句是 `count()` 这类不重试的断言时
  会读到空页面，表现为随机某条用例红。断言与各自的默认超时未改动。
- 删掉 `package.json` 的 `test:windows`（审查总表 `P-12`）。它当初的意义是「关文件级并行 + 30s 超时」，
  但那两个标志早就写进了 `test:vitest` 自己，于是它逐字等于 `npm test`。`scripts/run-release-build.cjs`
  里按平台二选一的三元、它上面那段解释差异的注释、`quality.yml` 的注释和 CLAUDE.md 命令表里的
  「Windows 备用」说法，描述的都是一个不存在的差异。发布门禁现在三平台同跑 `npm test`，
  `buildReleaseSteps` 不再需要 `platform` 入参。
- `test:node` 拆成 `test:scripts`（`scripts/*.test.cjs`）与 `test:browser`（随 `npm test` 走的两个
  浏览器套件），名字与内容对上（审查总表 `T-B6`）。`npm test` 的入口和覆盖范围不变，
  `quality.yml` 的 `node` 分片改为依次跑这两条。
- `test:browser` 补上 `--test-concurrency=1`（审查总表 `T-G10`）。这两个套件各自起一个 Chromium
  和一个 Vite dev server，并发跑没有换来墙钟（实测 31.4s 对 32.1s），只是把分片的峰值内存翻倍，
  在被 Defender 拖慢的 Windows runner 上这正是制造超时的方式；`test:v2:browser` 与 `test:ui`
  早就是串行的。
- `scripts/ci-workflow-config.test.cjs` 的分片完备性门禁改为从 `npm test` 自己的组成推导：
  新增一段而没有分片派发它会红，`test:windows` 复活也会红。
- P-16：`docs/RELEASING.md` 里两套互斥的发布方法拆开了。历史签名流程（`npm run release:build`、
  `release-build.yml` 的「CI 发布」配置与自签名验证、证书与固定发布者要求）整段移到
  `docs/archive/RELEASING-signed.md`，正文只留当前生效的无签名 Windows 流程与 macOS 流程，
  章节重新连号。原先从中间读会读到一份看起来是现行的签名手册，而它的篇幅是无签名那段的十几倍。
- P-13：发布手册补上打 tag 这一步。仓库到 0.2.6 为止没有任何 tag，本机产物无留存、CI 产物 30 天过期，
  过期后客户手上的安装包无法对应到 commit。新增的「发布后：给出货的 commit 打 tag」一节固定
  `v<版本号>` 附注 tag 的命令与三条约定，并列出 0.1.32 ~ 0.2.6 的候选 commit 供产品所有者核对后补打
  （版本号提升的 commit 未必是当时实际出包的 commit，所以只列候选、不代打）。
- 同一条矛盾在 `README.md` 里也订正了：开头段与「主程序更新」一节原本仍写着「正式发布需要 Authenticode 代码签名」、发布命令给的是 `npm run release:build`，现在改为当前的无签名入口与门禁描述，并指向归档文件。
- 发布前置检查（`scripts/verify-release-environment.cjs`）新增一条断言：`release-notes.md` 的第一行必须等于
  `package.json` 的版本号。electron-builder 的 `releaseInfo.releaseNotesFile` 把这份文件原样写进 `latest.yml`，
  客户端更新页显示的就是它；发版时忘了把「未发布」改成版本号，付费用户看到的第一行就是「未发布」，本次条目还会
  被读成上一个版本的内容，而打包、签名与 SHA-512 校验全都会通过。补上此前完全缺失的
  `scripts/verify-release-environment.test.cjs`（同时覆盖「远端版本必须低于本地」那条判定）（P-14）。
- 从 git 历史回补 `CHANGELOG.md` 里 0.1.13 ~ 0.2.5 共 18 个版本的条目，并把文件头的「已知断档，不回补」改成
  说明回补来源与日期口径；0.1.14 ~ 0.1.20 这几个版本号在 `main` 的 `package.json` 历史里从未出现过，另行注明（P-14）。
- P-20：`scripts/run-macos-free-build.cjs` 的 CI 临时签名路径不再把
  `verifyFreeMacSigningIdentity` 换成返回常量的桩。自签名断言、有效期、critical
  codeSigning EKU 唯一性、私钥身份与证书 SHA-1 一致性这四条真实发布唯一会跑的证书策略
  检查，现在每次 CI 演练都对真证书、真 `security` / `openssl` 输出跑一遍。
  `scripts/verify-macos-free-signing.cjs` 为此新增 `trustedIdentitiesOnly` 选项：
  演练用的一次性 keychain 刻意不写 Trust Settings，`find-identity -v` 会把 codesign
  实际锁定的那个身份过滤掉，所以只有这一层信任过滤放开，其余断言完全一致。
- P-20：`quality.yml` 的 macOS 打包门禁去掉 `if: github.event_name == 'push'`，改为每个
  PR 都跑，并给该步骤加上 12 分钟的步骤级超时。公开仓库的 Actions 不计费，原先省下的
  分钟数换来的是「PR 改坏 macOS 打包要合进 main 才暴露」。
- T-G5：`e2e/acceleration-profile-isolation-smoke.mjs` 与 `e2e/realm-vault-recovery-smoke.mjs`
  两个此前没有任何入口调用的冒烟接进 `windows-package` 作业（都在 `npm run compile`
  之后，各带步骤级超时）；smoke 产物上传的 glob 补上子目录。后者的 `cleanup()` 顺带修掉一个
  在 Windows 上必挂的守卫：`os.tmpdir()` 在 Windows 上给的是 8.3 短名，夹具目录因此永远不等于
  自己的 realpath，改为先把父目录 realpath 一次再建夹具。
- T-G5：`e2e/renderer-v2-native.mjs` 经 CI 实跑后判定不接。它断言窗口缩放等于
  `内容宽度 / 1280`（最小取到 960），而 `calculateUiZoom` 会把自动缩放钳在
  `UI_MIN_ZOOM = 0.8`，960 只可能得到 0.8；runner 的工作区又小于 1280×720，
  `resolveWindowPlacement` 会让窗口以最大化启动，Windows 上 `setContentSize` 随之失效。
  这两条都要先把脚本与产品行为对齐才谈得上接入，`ci-workflow-config.test.cjs`
  加了一条断言钉住「在对齐之前不要再把它加回去」。
- `.github/workflows/release-build.yml` 头部标注「已停用，保留待 CA 证书到手」。
- 打包配置里 `mac.notarize` 不再跟着 `XINGMANG_RELEASE` 变：唯一的发布工作流跑在 windows-latest，
  macOS 分发全走免费自签通道，全仓也没有任何 notarytool / stapler 实现，那条分支永远为假（审查总表 P-23）。
  改成固定 `false` 而不是删掉这一行——electron-builder 只在 `notarize` 显式为 `false` 时跳过公证，留空会让它
  在环境里碰巧存在 `APPLE_ID` / `APPLE_API_KEY` / `APPLE_KEYCHAIN_PROFILE` 时自动把 `.app` 送去 Apple 公证。
- 用 `XINGMANG_RELEASE=1` 构建 macOS 产物现在在 `beforePack` 阶段直接抛中文错误：Developer ID 签名却不公证的包
  打包全绿，装到客户机上却被 Gatekeeper 直接拒绝，这种只有装机用户看得见的失败宁可在出产物之前就红。
  `electron-builder.config.cjs` 的 `beforePack` 因此不再只在配置了私有加速资源时才存在。
- `docs/MACOS_DEVELOPMENT.md` 的「正式发布边界」原先声称 Developer ID 路线「配置 notarytool 凭据即可」，与代码不符，已订正。
- 落地页发布脚本 `scripts/publish-dl-landing.cjs` 加固三处（审查总表 P-27、P-28、P-29）：
  ssh/scp 现在带 `StrictHostKeyChecking=yes` 与运维自备的 `UserKnownHostsFile`，
  known_hosts 路径作为必填配置项（`DL_LANDING_KNOWN_HOSTS` / `--known-hosts` /
  `dl-landing.config.json` 的 `knownHosts`），放在仓库目录里会被拒绝；安装包 SHA-256 改成
  流式计算，不再把上百 MB 的包整个读进内存；`--yes` 生效前先用 `validateLocalRelease`
  比对同目录 `latest.yml` 的版本、大小、SHA-512 与 blockmap，另加可选的 `--checksums`
  逐个比对 CI 打印的 SHA-256，任一不通过就拒绝上传。
- `publishDlLanding`、`printPlan`、`main` 随之改为 async。操作步骤见
  `docs/DL-LANDING-PLAN.md` 新增的 7.1、7.2 两节。
- 新增 `.github/CODEOWNERS`，把 `.github/` 与 `scripts/` 两处高危路径指给仓库所有者，
  这两处的改动会自动请求审查（审查总表 P-30）。是否强制取决于分支保护里的
  「Require review from Code Owners」，默认未开启。
- 新增 `SECURITY.md`，说明支持版本范围、走 GitHub 私密漏洞报告入口提交、报告里该写什么、
  以及哪些问题不属于本仓库范围。
- 新增 `scripts/verify-renderer-boundary.test.cjs`，扫描 `src/` 全部非测试源码，钉住渲染层
  只能 import `electron/` 下的白名单模块（审查总表 R-B1）。vite.config.ts 的守卫有四个空档：
  只看 `src/` 前缀不管 `electron/`、`import type` 在进 `getModuleIds()` 之前已被擦除、只在
  `vite build` 生效、`renderer !== 'v2'` 直接 return；源码扫描不受这四条影响。
- 白名单分成 `valueImportable`（9 个，会进渲染 bundle，断言其值导入闭包零 `node:*` / `electron`
  依赖）与 `typeImportableOnly`（2 个，只允许 `import type`，一旦被值导入即失败）。同时禁止渲染层
  直接 import Node 内置模块或 `electron`、禁止 renderer-v2 反向 import 已冻结的 legacy `src/`。
- 门禁自带用例：用合成 import 断言拒绝/放行的边界，并钉住 `import { type A }`、`export { type H }`
  这类写法与打包器一样被判为纯类型。已纳入 `npm run test:scripts`（`npm test` 串带）。
- R-B3：删掉 `src/renderer-v2/ui/` 下 32 个只含一行转发的 `<Name>/index.ts` 空壳目录——代码里
  0 处 import，只是形式上满足设计包原稿「一个组件一个文件夹」的要求。`ui-spec/20-component-api.md`
  与 `src/renderer-v2/ui/README.md` 改为记录 v2 实际采用的集中式实现文件（`core` / `fields` /
  `modal` / `floating` / `feedback` / `brand` / `guidance` 经 `components.tsx` 汇总，由 `index.ts`
  导出），并说明原稿那条目录要求未被采用。
- R-B5：新增 `scripts/verify-renderer-style.test.cjs` 门禁（进 `npm run test:scripts`），用
  TypeScript AST 而非 grep 钉住 CLAUDE.md §6 里能机械判定的三条：行尾分号只许出现在照原型抄下来的
  `renderer-v2/ui/`、`registry/` 与 `gallery*.tsx`，其余目录连同主进程和 legacy 树一律不许；非测试
  文件的模块顶层不许用 `const` 箭头函数；不许 `as any` / `@ts-ignore` / `eslint-disable`，
  `@ts-expect-error` 只许出现在测试里。门禁自带合成源码的正反自检，避免退化成永绿空壳。
- 配合上面的门禁，把 23 处模块顶层 `const` 箭头函数改成 `function` 声明（`business-common.tsx`、
  `pages-account.tsx`、`pages-management.tsx`、`pages-maintenance.tsx`、`platform-api.ts`、
  `account-switch-sync.ts`、`features/tools/account-bootstrap.ts`、`ui/shared.tsx`、`ui/brand.tsx`、
  `ui/feedback.tsx` 与主进程的 `python-runtime.ts`），并把 `realm-account-service.test.ts` 里一处
  多行类型字面量拆成每行一个成员。纯形式改动，没有行为变化。
- CLAUDE.md §6 与 `.claude/rules/renderer-v2.md` 同步成上面两条的实际口径，不再声称全仓 0 处行尾分号。
- R-B9：`src/renderer-v2/types.ts` 把 `window.xingmang` 声明为可选，`features/auth/api.ts` 的
  `getAuthApi()` 改走 `bridge()`，取不到桥时抛中文错误；`main.tsx` 随之改成先取值再判空。
- R-B10：`LocalAvatar.tsx` 的 `keyRef` 与 `activeKey` 从渲染期赋值挪进 `useEffect`，
  `save()` 的「账号已变化」判定只看已提交的渲染；新增一条被丢弃渲染的浏览器回归用例。
- R-G16 ①：`ui/floating.tsx` 的 `Menu` 把 `label` 改成必填，删掉 `t('menu')`（「操作」）兜底与 `ui/shared.tsx` 里对应的文案键，缺名字变成编译错；补齐 `pages-account.tsx`、`SavedAccounts.tsx`、`pages-management.tsx`（市场/扩展/备份）、`pages-maintenance.tsx`（体检/安装卸载）共 7 处行级溢出菜单的可访问名称。
- R-G16 ②：`business-common.tsx` 的 `useOperation().execute` 改为泛型，`success` 可以是根据结果返回提示文案（或 `null` 表示不提示）的函数；`diagnostics:export`、`runtime-logs:export-feedback`、`provider-sessions:export` 三处按契约的 `… | null` 区分取消与成功，取消不再提示，成功带上落盘路径。
- R-G16 ③：`features/chat/ChatPage.tsx` 不再把模型输出的链接渲染成 `<a>` 去调 `external:open`（全等白名单必然拒绝），改成与旧界面一致的不可点标记；顺带从 `ChatBridge` 移除已无人使用的 `openExternal`。
- R-G16 ⑥：`features/app/error-report.ts` 拆出可单测的 `createRuntimeErrorReporter`，30 秒窗口内的重复失败不再被静默吞掉，窗口结束时补一条带重复次数的上报。
- R-G2：`src/renderer-v2/features/chat/storage.ts` 新增 `redactPersistentChatText`，在 `writeWorkspace` 序列化前对正文、思考、错误、标题、草稿、系统提示词和图片提示词脱敏，覆盖 `sk-`、`Bearer`、`api_key=`/`token=` 键值与查询参数、`blob:` 与内联 `data:` base64；参照旧 `src/ai-chat-state.ts` 重写，不跨树引用旧渲染层。
- 与旧实现的三处有意差异：不整条抹掉普通 http(s) 链接（v2 素材只存 `assetId`，运行时 URL 早已在持久化时剥离，抹链接只会白丢正文），改为只清理链接里的凭据参数；也不把任意超长字母数字块当成编码数据（会吞掉普通长文本）；同样不重新引入旧版 40,000 字单条与 120,000 字总量截断，v2 的无损存储是既有设计，超出 4 MB / 50 个对话仍按原样报错并保留上一份记录。
- R-G4：`renderer-v2/features/tools/ConfigDialog.tsx` 的 `markerWarning` 此前永远是空字符串，
  四处 `writeManualSourceMarker` 的返回值被丢弃。新增 `source-marker.ts` 的
  `applyManualSourceMarker`，写失败时返回给用户看的一句话，四处保存路径与
  `features/tools/account-bootstrap.ts` 的账号写入复核都接上它；前者走
  `App.tsx` 的 `finishConfigSave(warning)`，后者并进 bootstrap 的 `warnings`。
- R-G9：把 `account-bootstrap.ts` 的五条复核失败文案收口到 `configurationFailureMessages`，
  以「当前账号」为主语并去掉站点指向。legacy `src/account-provisioning.ts` 已冻结未动，
  两侧仍存在的差异记在 PR 说明里。
- R-G5：`src/renderer-v2/pages-account.tsx` 里 `refreshGroups` 的无参数 catch 改为
  `errorMessage(cause, '分组读取失败，请刷新后重试。')`，沿用 R-S7 那套脱敏入口。
  这是 v2 生产代码里最后一处把真实原因丢掉的 catch，而 `groupsError` 是保存密钥的硬门槛。
- R-G5：`src/renderer-v2/business-common.tsx` 的 `errorMessage` 补一条限流分支
  （`HTTP 429` / `too many requests` / `rate limit`），复用 registry 里既有的
  `errors.tooManyRequests`。此前服务端的英文限流原文会掉进通用兜底，被说成「请重试」。
- R-B6：同文件 `AccountRecharge` 的支付回调订阅改为只依赖 `api`，回调本身从 ref 取最新
  （与本文件 `refreshGroupsRef` 同一写法）。此前 `acceptPaymentTerminal` 的 useCallback
  依赖了每次渲染都新建的 `changed`，余额 store 每 30 秒 publish 就退订重订一次；
  把 `changed` 包成 useCallback 挡不住，因为 App.tsx 传下来的 `onAccountChanged`
  本身也是行内箭头。
- `e2e/v2-business.test.mjs` 增两条浏览器用例：分组失败按原因给不同文案（登录过期／限流／
  封禁／认不出时的兜底），以及多次重渲染只订阅一次支付回调且仍能结掉待支付订单。
  夹具的 `keyGroupsHarness.failNext` 现在接受错误原文，另导出 `paymentTerminalSubscriptions`
  与 `rerenderFixture`。
- `renderer-v2/features/auth/StartGuide.tsx` 补上旧版引导的 `official-login-required` 档：
  `GuideToolState` 新增可选 `officialLoginRequired`，由新导出的纯函数 `guideOfficialLoginRequired()`
  按 `ProviderConfigSummary.codexAuthMode` 判定（只有 Codex 能从配置里读出官方登录态），
  `resolveGuideReadiness` 据此不再把「配置里没有中转 Key」直接当作已连接；`App.tsx` 在拼
  `guideTools` 时填这一字段，连接步的文案与来源标签同步区分（审查总表 R-G7）。
- `renderer-v2/features/auth/state.ts` 的注册校验按服务端实际规则单向对齐：用户名去掉本地
  自加的 3 位下限（new-api `model.User` 只有 `validate:"max=20"`），确认密码区分「未填写」与
  「两次不一致」，`parseInviteCode` 改用旧版 `parseInviteAffCode` 的同一套判定（认 `aff=`、
  `/sign-up`、`/register`，不再要求协议头），并补上 `AffCode` 列宽 32 位的上限校验；
  长度常量与旧版 `src/components/account/validation.ts` 是 I6/I7 下的有意重复，注释互相引用
  （审查总表 R-G10）。旧版渲染层已冻结，本次不动。
- v2 渲染层的工具注册表收口类型：`registry/tools.ts` 的 `ToolDef.id` 从 `string` 改成
  `ProviderId | 'codexDesktop'`；npm 包名与配置目录名改为从 `electron/catalog.ts` 的
  `cliCatalog` 与新增的 `providerConfigDirectoryNames` 派生，主进程的 `providerConfigRoot`
  读的是同一张表（它是 CLAUDE.md T10 没记上的第 6 个 `providerConfigPaths` 消费者）；
  「官方账号」中文名从 `ConfigDialog.tsx` 的三元链改成无 default 的
  `officialAccountNames: Record<ProviderId, string | null>`；`account-switch-sync.ts` 的
  硬编码工具名数组换成 `catalog.ts` 的 `isProviderId`。加第五个 CLI 时漏掉任何一处现在
  都是编译错，不是界面上静默显示别家的账号名（R-S11）。
- 删掉 `ToolDef.keyWrite`：没有任何消费者，且已经把 grok 标成 `'env'`（实际写的是
  `config.toml`）。真正决定写哪种文件的是主进程的 `config-files.ts`（R-B12）。
- 补 `src/renderer-v2/registry/tools.test.ts` 钉住注册表 id 与两处派生字段；CLAUDE.md
  T2 / T10 与 `ui-spec/22-registries.md` 顺带订正。用户可见行为不变。
- legacy 回滚版（`src/` 下除 `src/renderer-v2/` 以外的源码 + `tooling/legacy-renderer/`）按 `R-S12` 的三选一方案 b 冻结：**只接受安全修复**，新功能、界面调整、一般与建议级缺陷、重构、补测试一律只在 `src/renderer-v2/` 做。不定退役日期、不删代码、不改行为，`compile:legacy` / `dev:legacy` 与 legacy 的既有测试照旧。
- 这条决定写进了 `CLAUDE.md`（第 2 节渲染层两棵树的边界、第 3 节两条 `:legacy` 命令注记、第 5 节新增陷阱 T14、第 7 节禁止项、第 10 节当前阶段）、`docs/MODULE-MAP.md`、`docs/UI-V3.1.1-V2-REBUILD.md`、`docs/AGENT-RUNBOOK.md`（领任务前置条件）、`docs/COLLABORATION.md`（串行改动 ④），并新增按路径自动加载的 `.claude/rules/legacy-renderer.md`。
- issue #30（拆 legacy `App.tsx`）随之关闭：它的目的是让多个 agent 并行改 legacy，冻结后这个目的不存在了；v2 侧三块大文件的拆分另行处理。
- 新界面对 Codex 桌面端的「可更新」判定重建为三态：`features/tools/model.ts` 新增 `codexDesktopUpdateKind`，
  `presentTools` 只在 `kind === 'installable'`（官方清单有新版**且** `mirrorUpdateAvailable === true`）时置
  `updateAvailable`。此前只读 `DesktopAppStatus.updateAvailable`，官方 MSIX 清单领先商店与国内镜像时，商店已
  更新到最新的用户会永远看到「更新」按钮和「N 个有更新」，而镜像没有包可装。legacy 的
  `src/codex-desktop-update.ts` 早已做过这个判定，v2 重写时没带过来；本次在 v2 内重建而非跨 renderer 引用
  legacy 文件，并补齐三态单测（R-S3）。
- R-S7b：`src/renderer-v2/business-common.tsx` 新增 `snapshotErrorMessage`，把主进程快照里的
  `detectionError` / `configurationError` 接到 R-S7（#160）的脱敏入口 `userFacingErrorMessage`；
  `features/tools/model.ts` 与 `features/tools/external-model.ts` 两个展示层改为经它取值，
  原有中文兜底文案（「工具检测没有完成」、版本/安装提示）不变。
- 工具页（renderer-v2）的一次读取从 `Promise.all` 改为 `Promise.allSettled`，对齐 legacy
  `scan-coordinator.ts` 的「部分成功也提交」：`createToolsApi().read()` 返回 `{ snapshot, failures }`，
  config 那一块读失败时用占位表降级而不再连坐整页（system / platform 缺失仍返回 null，那两块就是工具列表本身）；
  失败原因统一走 `business-common` 的 `errorMessage` 脱敏。`useToolbox` 新增 `failures`，`Home` 把分区失败
  作为 alert 展示并把工具行的连接状态标为 `configUnavailable`（而不是谎报「还没配 Key」）；`app-check.mjs`
  里原来一份两用的失败用例拆成 scanSystem（仍抛错 + toast）与 getConfig（降级 + 页内提示）两条（审查总表 R-S8）。
- `MaintenancePage`（renderer-v2）自己那条读取路径原来是两个串行 `await`，任一块失败就让 `useResource` 的 `data` 保持 null，页面退回全 undefined 的渲染并把「未安装」「尚未安装」当成结论显示出来。新增 `features/tools/maintenance-status.ts`：`readMaintenanceStatus()` 用 `Promise.allSettled` 分别结算 `scanSystem` 与 `getPlatformCapabilities`，返回 `{ snapshot, capability, failures }`，失败原因走 `business-common` 的 `errorMessage` 脱敏（沿用 R-S7）。页面按分区渲染提示，`statusUnknown` 时工具行的状态标为「状态未读到」、主按钮换成「重新检测」，运行环境行显示「状态未读到」而不是「尚未安装」。与 R-S8 给首页的修法同一套行为（审查总表 R-S8b）。
- R-S9：`src/renderer-v2/pages-account.tsx` 任务详情抽屉不再把 new-api 返回的上游 CDN 地址交给 `external:open`（I12 白名单是全等匹配，这个调用永远失败），主操作改为写剪贴板，抽屉里新增「结果链接」一行，并给该页的 `ResultNotice` 接上成功提示。
- R-S6：同文件「修改密码」对话框的取消、关闭、放弃与成功路径统一走 `closePassword()`，清掉三个密码 state 并 `operation.clear()`；`dirty` 由新的纯函数 `passwordFormDirty()` 判定，任一密码框有值就算未保存，不再只看请求是否进行中。
- `e2e/v2-business-fixture.tsx` 改为记录 `navigator.clipboard.writeText`（Chromium 未授权时会拒绝真实写入），完成态任务补上 `resultUrl`；`e2e/v2-business.test.mjs` 新增两条回归。
- `e2e/account-commerce-interactions.test.mjs` 的兑换码用例不再从 Node 侧等「正在兑换…」这个
  只存在约 120 毫秒的瞬时文案：现在把「点击提交、读取在途时的禁用态与文案、再点一次」放进同一个
  `page.evaluate` 任务里，用排空微任务等 React 刷新，请求在途的窗口不可能在往返途中关闭。
  断言内容不变（在途时按钮禁用且文案为「正在兑换…」，在途时的第二次提交不会再发一次请求），
  Windows `windows-test (node)` 分片上那条等满 30 秒的偶发超时由此消除。
- P-22：`scripts/create-macos-free-signing-certificate.cjs` 不再签发 20 年期、`CA:TRUE` 且带
  `keyCertSign` 的证书。改为十年期的终端证书（`basicConstraints=critical,CA:FALSE`、
  `keyUsage=critical,digitalSignature`），发布 Mac 把它标记为代码签名可信后，拿到 P12 的人
  也无法再签发链到可信锚的下级证书。有效期没有压得更短，是因为换证书会中断 Squirrel.Mac
  的更新连续性、全部老用户都要手动重装，只在临近到期或私钥泄露时才轮换。
  `verify-macos-free-signing.cjs` 增加断言钉死 basicConstraints、keyUsage 与 3650 天上限，
  旧证书会在发布预检处失败；轮换流程写进 `docs/MACOS_FREE_DISTRIBUTION.md`。自签名校验
  从 `openssl verify -CAfile` 换成 `node:crypto` 的 `X509Certificate.verify()`——前者问的是
  “这张证书能不能给自己签发”，非签发型证书本来就不能，macOS 的 LibreSSL 会直接报
  `unable to get local issuer certificate`。
- P-38：`scripts/macos-ephemeral-signing.cjs` 的签名重试只对钥匙串／文件系统争用类的瞬时
  失败重试，确定性失败（身份不存在、包格式不被接受等）第一次就抛出，不再白等三轮退避。
- P-36：`scripts/build-macos-system-proxy.cjs` 给 `xcrun swiftc` 加 10 分钟超时，并把超时、
  拉不起进程、被信号终止、非零退出四种失败分开报；同时拆成可测函数，非 macOS 上也能 require。
- P-31：`scripts/minify-electron.cjs` 改为两阶段——全部压缩进内存后再统一写回，中途失败不
  再在 `dist-electron` 留下压缩与未压缩混杂的半成品。
- P-33：`scripts/serve-update-feed.cjs` 在 `path.relative` 之外补上 `realpath` 复核，release
  目录里指向目录外的符号链接不再被当成可服务文件。
- 新增 `scripts/minify-electron.test.cjs`、`scripts/serve-update-feed.test.cjs`、
  `scripts/build-macos-system-proxy.test.cjs`，并接入 `npm test`。
- 新增 `electron/crash-report.ts`（纯函数：DSN 校验、脱敏、Sentry 事件与 envelope 构造、
  去重签名）与 `electron/crash-reporter.ts`（发送服务：按会话去重与限量、超时、重定向拒绝、
  429/413 后本会话停发），两者都带单测。
- 没有引入 `@sentry/electron`：它会把 `@sentry/node` 与 OpenTelemetry 一并带进生产依赖
  （实测 +90 MB，含用不到的 session replay），而 OTel 会全局改写 `http`/`fetch`，与 I10 的
  「每次网络请求都要有超时、体积上限、重定向策略、URL 校验」这条不变量相冲突；同时渲染层
  沙箱 + 严格 CSP 也接不了它的 renderer SDK（I7）。改为按 Sentry envelope 协议直接上报。
- 上报入口：主进程 `uncaughtExceptionMonitor` / `unhandledRejection`、窗口的
  `render-process-gone`，以及经 `runtime-logs:renderer-error` 回传的 renderer-v2 异常
  （`registerIpcHandlers` 新增可选 `onRendererError` 回调，没有新增 IPC 通道）。
- 新增设置项 `AppSettings.crashReporting`，缺省 = 开启，只有显式关闭才落盘；主进程每次上报
  前重新读 `settings.json`，关掉开关立即生效。环境变量 `XINGMANG_DISABLE_CRASH_REPORTING=1`
  可临时静音。
- 退掉 `electron/platform` 里从不生效的 `privacy.crashReports` 占位偏好，设置页那一行改由
  新设置项驱动；老的偏好文件读取时自动丢弃该字段，无需迁移。
- 打包版可用 `XINGMANG_CRASH_REPORT_TEST=1` 启动发一条自检事件，用来确认真机能连上后台，
  它同样受开关和「仅打包版」两道门控制。
- source map 上传需要 Sentry auth token，本次未做，补法写在 `docs/RELEASING.md`。
- `e2e/` 只保留真正会在 CI 或本地跑失败的东西（T-G5、T-G6、T-B4）：42 个脚本里有 18 个没有任何
  npm script 或工作流引用，逐个定性后分三路处置。8 个 UI v3.1.1 重建期的一次性证据生成器移到
  `scripts/audit/`（`prototype-reference-capture.cjs`、`prototype-reference-index.cjs`、
  `v2-business-screenshots.mjs`、`renderer-v2-evidence-index.mjs`、`renderer-v2-gap-audit.mjs`、
  `renderer-v2-component-surface-check.mjs`、`renderer-v2-baseline-scroll-audit.cjs`、
  `welcome-v3-visual.mjs`），目录 README 写清各自要什么；3 个 CI runner 给不出前提的脚本移到
  `scripts/manual-acceptance/`（`managed-bootstrap-smoke.mjs` 要真实账号口令且仅 Windows、
  `announcement-native-visual.mjs` 要本地真实公告附件、`canvas-window-smoke.mjs` 要已编译产物），
  前提与注意事项写进 `docs/MANUAL-ACCEPTANCE.md`。
- 删掉 `e2e/window-v3-smoke.mjs`：它等的是 legacy 的 `.app-shell` 选择器，而 `npm run compile`
  默认产出 renderer-v2，早已跑不通；它验的窗口几何与 960/1280/1440 缩放由
  `e2e/renderer-v2-native.mjs` 在 renderer-v2 上覆盖。
- 验收证据不再把行为写成字面常量（T-G8）：`onboarding-smoke.mjs`、`canvas-group-refresh.mjs`、
  `acceleration-profile-isolation-smoke.mjs`、`renderer-v2-native.mjs` 原先在结果 JSON 里直接写
  `loginBoundaryPreserved: true`、`workers: 2`、`dropdownPointerRefresh: 3` 这类常量，跑到一半失败
  也照样打印出来，看起来像"这条也过了"。改成只输出本次真正跑过的断言名（`passedAssertions`）
  与从被测对象读回来的计数，并在 `scripts/ci-workflow-config.test.cjs` 加门禁挡住回退。
- `scripts/ci-workflow-config.test.cjs` 的夹具就绪清单与 `docs/UI-V3.1.1-V2-REBUILD.md`、
  `docs/V2-BUSINESS-IMPLEMENTATION.md`、`ui-spec/work/README.md` 里的命令同步到新路径。
- `e2e/asar-tamper-smoke.mjs` 与 `e2e/packaged-hardening-smoke.mjs`（T-G9）：清理阶段不再
  用 `throw` 顶掉 `try` 里的真实失败原因。两处的 `finally` 改成收集清理问题、`console.error`
  输出，只有在断言本身没挂时才由清理问题决定退出码。此前「被篡改的 app.asar 仍然可以持续
  运行」这类安全断言失败，会在 CI 日志里被「未确认测试进程退出」替换掉。
- 审查总表 T-G1（`e2e/electron-smoke.mjs` 七个恒为 false 的死断言字段）经复核已随 M-01
  （#135）删除该文件一并消失，保存模式合并/重置与「改模型要重新校验才能保存」现由
  `npm run test:v2` 的 `app-check.mjs` 覆盖，无需另外改动。
- R-G3：`BusinessActions` 新增 `onToolsChanged`，`pages-maintenance.tsx` 的安装路径装完先回调 App 的 `syncAfterToolInstalled`
  （写账号 Key + `toolbox.refresh(true)`）再重读本页数据，与首页 `install()` 共用同一段收尾。
- R-G6：新增 `features/tools/runtime-readiness.ts`，`App.tsx` 的 `install()` 与 `guideTools.runtimeReady` 改按
  `versionStatus` 判定；版本串解析不出时 `tooOld` 为 false，只看 `tooOld` 会放行 legacy 已拦截的情形。
- R-B7：`App.tsx` 两处 `.catch(() => undefined)` 改为上屏——二维码失败走 `supportQrFallbackText`，
  deep link 读取失败走 `deepLinkReadErrorText`（新增 `features/app/fallback-messages.ts`，带重试）。
- R-B8：`onboardingPreview` query 开关加 `import.meta.env.DEV` 门（新增 `features/app/dev-preview.ts`），打包产物不再携带这条 UI 分支。
- renderer-v2 浏览器回归不再拿会自毁的 toast 当保存完成的同步点：`app-check.mjs` 在每个页面
  装一个 MutationObserver 记录所有 toast，`waitForSavedConfiguration` 与「配置保存成功」的
  否定断言改读这份记录。toast 出现 2400ms 后自删（`ui/feedback.tsx`），Windows runner 慢一拍
  就错过，grok 的保存用例因此偶发 30 秒超时而同组 gemini 2.5 秒通过。记录带消费游标，
  第二次保存不会被第一次留下的 toast 顶掉；断言与超时都没有放宽。
- `e2e/window-close-smoke.mjs` 的主进程夹具不再因为一次证据文件写失败就丢掉一条指令：控制循环改成「先执行动作、
  后写证据」。此前指令文件在动作执行前就已删除，而写证据的 `rename` 在 Windows 上被 Defender 挡一次就会抛出并跳过
  动作，下一拍找不到指令文件直接返回——这条指令既不执行也不回执、永不重试，冒烟只能超时报「命令未被回执」
  （#164 加的 try/catch 只防住主进程整体退出，注释里说的「下一拍重试」当时没有实现路径，#170 的 CI 上复现）。
- 证据文件的原子替换本身也补上有界重试（5 次、20ms 起的退避），并且 `persist()` 不再抛错：它同时挂在对话框、
  强制退出与 `will-quit` 三个钩子上，抛错会改变被测行为而不只是少一份证据。重试全部失败时状态标记为未发布，
  由控制循环在后续 tick 重发，保证「至多一次执行、必有回执」；失败本身记进证据文件新增的 `evidenceFailures`。
- 测试进程投递指令用的同一套「临时文件 + rename」也补上同样的有界重试（`publishAtomically()`）。它被 Defender 挡住时
  是直接抛错让整个场景失败，不算静默丢指令，但同样白烧一轮 Windows CI；重试全败仍然照原样抛出，不会被吞掉。
- 新增 `e2e/window-close-smoke-fixture.test.mjs`（并入 `npm test` 的 `test:node`）：把 `bootFixture` 的真实源码取出来在
  `vm` 里跑，注入 `rename` / `unlink` 的 EPERM，覆盖四种情形——瞬时写失败不丢回执、持续写失败仍只执行一次且随后补发
  回执、指令未能消费时留在盘上由下一拍执行、投递指令的 rename 被拒后重试成功且始终失败时仍然抛错。无需图形环境，Linux 与 Windows 都跑。断言与超时未作任何放宽。
- `scripts/ci-workflow-config.test.cjs` 的「浏览器套件必须记录 pageerror」门禁改成按是否 import `@playwright/test` 选取，
  而不是按文件名后缀：新增的这条夹具用例不开浏览器、没有 page 可监听。按 import 选比按文件名开白名单更严——真正的
  浏览器套件删掉监听器就会被这条门禁抓住。套件数量下限 15 保持不变。
- 浏览器夹具的「挂载完成」等待不再借用 Playwright 的 30 秒动作默认值，改为 `e2e/fixture-readiness.mjs` 的共享预算
  （默认 90 秒，`XINGMANG_FIXTURE_READY_TIMEOUT_MS` 可覆盖），六个 `test:ui` 套件与 `app-check.mjs` 共用；挂载之后的
  行为断言一律保持 30 秒默认值。Windows runner 上冷开一个页面比温启动慢一个数量级（quality #264 的
  `maintenance-pages-interactions.test.mjs` 一次 `openFixture` 超过 30 秒，同文件两条温启动用例各 0.4~0.7 秒），
  卡住的是挂载，报出来的却是它后面那条断言。
- `app-check.mjs` 的 `open()` 不再拿 `page.goto` 的 `load` 当夹具就绪，改为轮询夹具全局与已渲染的 root，并在
  `before` 里预热一次 Vite 依赖优化。Vite 发现新依赖会在 `load` 之后整页 reload，这正是
  `window.fixtureSupportQrCode is not a function`（quality #241）与首个参数化用例 30 秒超时、同组另外四个各
  2.3 秒（quality #284）的来源。轮询放在 Node 侧而不是页内，因为装了 `page.clock` 的页面定时器与 rAF 是暂停的。
- `e2e/window-close-smoke.mjs` 的主进程控制通道整体加 try/catch：命令文件读取与删除失败改为下一拍重试并记进
  证据文件（主进程只注册 `uncaughtExceptionMonitor`，此前抛出即终止，症状只剩「命令未被回执」）；`waitUntil`
  的默认预算 15 → 30 秒（`XINGMANG_SMOKE_COMMAND_TIMEOUT_MS` 可覆盖，仍然有界），应用已退出时立刻带退出码
  报错而不是耗完预算；并把主进程自己的 stdout/stderr 转发到日志。
- `scripts/ci-workflow-config.test.cjs` 补两条门禁，钉住上述夹具预算与关窗冒烟的容错，防止回退到裸默认值。
- `.github/workflows/release-build.yml` 不再把 `workflow_dispatch` 的输入直接插进 PowerShell 脚本正文（P-26）。
  `${{ inputs.confirm_version }}` / `${{ inputs.update_url }}` 是在 PowerShell 解析之前做的文本替换，含单引号的
  输入能闭合字符串字面量并执行后面的内容——而这台 runner 正是唯一能读到签名证书的地方。版本确认、自签名
  更新源拦截、产物校验和三步改为在 `env:` 里绑定后读 `$env:`，语义不变。
- `.github/workflows/quality.yml` 的 `audit` 作业去掉 `setup-node` 的 `cache: npm`（P-32）。这个作业从来不跑
  `npm ci`——`npm audit` 只读 `package-lock.json`——所以那份缓存没有恢复目标，只是每次多一次查表和上传。
- `linux-test` 新增一步 `npm run check:legacy`，第一次让回滚渲染层的构建链路进 CI（R-G12）。新脚本是
  `cross-env XINGMANG_RENDERER=legacy vite build --outDir dist-legacy`，不打包、不碰 `dist/`，产物已进 `.gitignore`；
  `vite.config.ts` 里那张 React 18 alias 表只在 `XINGMANG_RENDERER=legacy` 时生效，此前 `tooling/legacy-renderer/`
  的固定运行时腐坏、或 `src/` 长出 React 18 满足不了的 import，都要等到真的需要回滚那天才会暴露。Linux 上约 1 秒。
- `scripts/release-workflow-config.test.cjs` 与 `scripts/ci-workflow-config.test.cjs` 各补门禁：发布工作流的任何
  `run` 块不得再出现 `${{ inputs.* }}`；`audit` 作业不得声明依赖缓存；`check:legacy` 必须恰好在一个作业里跑，
  且不得退化成打包或写进 `dist/`。

## 0.2.6 - 2026-09-19

- 接入 WorkBuddy、Claude Desktop 和 OpenCode 的安装、配置与启动；Claude Desktop 改用原生第三方推理配置，补齐事务备份、Windows 虚拟化路径和手动配置就绪状态识别。
- 加固账号切换、工具配置归属与凭据隔离，补齐会话 vault 恢复，避免自动准备覆盖用户手动 Key。
- 修复长聊天记录持久化，完善 Sub2API 订阅、用量、时间筛选与能力展示，调整登录客服入口和首屏按需加载。
- 修复 Windows 加速代理恢复与后台 Electron 数据目录隔离，完善加速口令时长和 macOS Codex 安装位置、架构识别。
- 将 Codex 非 GPT 模型入口统一收纳到更多操作菜单，同步原型与交互回归测试。
- 完善 CI 改动范围识别与质量门禁，代码修改须通过 Windows、macOS、Linux 和依赖审计检查。

## 0.1.13 - 2026-08-12

- 版本号提到 0.1.13：线上更新源当时已经是 0.1.12，与 `package.json` 撞号——发布前置检查要求本地版本必须高于线上，而且已装线上 0.1.12 的用户永远收不到同号不同构建的内容。
- `release-notes.md` 按用户可感知的口径重写（登录先行、记住密码、协议内嵌、Key 管理、自选安装目录、账号来源切换、画布节点式工作流与图生图、503 修复、域名统一）。

## 0.1.21 - 2026-08-22

- 合入生产版无限画布工作流编辑器（`canvas-v2/`，@xyflow/react 底座）与媒体生成链路：节点交互、运行与资产生命周期、项目持久化、行业模板包。
- 账号托管 CLI Key 自愈、官方账号来源切换、Gemini API 模式与初始化失败后的逃生路径。
- 登录后自动完成环境初始化，并同步支付窗口终态与手动关闭。
- 0.1.3+ 的自动更新源迁移到新的 R2 域名；Codex 中转地址修正为 `/v1`。
- Windows 发布门禁改跑 `test:windows`（关文件级并行 + 30s 超时），躲开 Defender 引起的 5 秒超时；发布构建先安装 Playwright 的 chromium。

## 0.1.22 - 2026-08-23

- 同步 `xm.solov.cc` 当时的 GPT、Claude、Grok、Gemini 生产分组，修复托管 Key 缓存迁移与旧画布项目迁移。
- 画布图像节点修复运行确认时提示词重复写回导致无法生成的问题，提示词编辑上限提升到 10000 字符，保留 1K/2K/4K 清晰度选择。
- 修复网络位置备用接口超时与 IP 缺失显示，优化本地托管 Key 损坏后的自动重建提示。
- 依赖锁文件里全部解析地址统一回官方 npm registry，让依赖审计在各 CI runner 上结果一致。

## 0.1.23 - 2026-08-29

- 刷新工作台界面：更窄的侧栏、中文导航、更干净的概览卡片与按钮间距。
- 修正 Codex 已退出 ChatGPT 仍显示「已登录」、未登录仍提供额度刷新的问题；官方账号未写默认模型时改为提示在 Codex 窗口里选择；切换到 ChatGPT 账号后立即刷新额度。
- 新增官方 ChatGPT 开关与 `dl.solov.cc` 落地页。
- 发布链路修复：产物验证期间信任签名证书、保留 UTF-8 的 Authenticode 发布者名；冒烟用例改为定位 Codex CLI 卡片，并容忍概览窗口尺寸竞态与紧凑的 Windows 发布 runner。
- 本版首次合入（#105）因质量 CI 起不来被回滚，随后以 #106 重新发布。

## 0.1.24 - 2026-08-31

- 修复 macOS 上 Claude Code 的原生入口被错误交给 Node 执行的问题，按平台识别并直接启动 Mach-O / ELF 可执行文件，同时保留占位 CLI 的包装器兼容路径。
- 完善 Claude Code 原生可选依赖缺失时的中文诊断。
- 增强 Codex 桌面端首次安装回退与中文状态处理，补齐语言状态检测与首次初始化的稳定性测试。

## 0.1.25 - 2026-08-31

- 修复 Windows 上 Codex 桌面端 Appx 检测因 `Get-AppxPackage -AllUsers` 权限不足而误报初始化失败：当前用户已安装时直接复用本用户安装信息，不再触发跨用户查询；无法确认时给出明确的账户提示，避免重复安装。
- 本版因仓库 GitHub Actions 运行环境 startup_failure 未执行 CI，改由本地类型检查、定向 Electron 用例、Node/E2E 与真实 PowerShell 验证兜底。

## 0.1.26 - 2026-08-31

- 改进 Windows Codex 桌面端启动探测：兼容 AppX 激活后 WMI 进程信息延迟，减少已启动却误报失败的情况。
- 针对 Windows AppModel `0xC0EA0001`、内置 Administrator 与 UAC 环境输出可操作的中文故障提示。

## 0.1.27 - 2026-08-31

- 修复普通用户首次初始化时 Codex 桌面端检测被 `Get-AppxPackage -AllUsers` 权限拒绝阻断的问题，当前账户未安装时可继续进入下载流程。
- 增加 Codex 桌面端工作区权限检测与一键信任，恢复镜像安装环境下的「请求批准」能力。
- 更新下载页与 macOS 首次打开教程的缓存标识，下载入口统一指向当前发布说明页。

## 0.1.28 - 2026-09-03

- Codex 桌面端改为按当前用户检测并迁移启动方式：修复旧的开始菜单注册阻断下载、启动时误弹文件夹选择、权限选择器状态迁移。
- 内置星芒AI生图 Skill：登录后自动准备图片分组 Key 与本地配置，退出账号时清理敏感信息。
- 整理左侧导航，系统工具收纳为展开与收起状态都能用的二级菜单；改进画布项目新建流程与新增节点交互，并补齐小视口交互验证。

## 0.1.29 - 2026-09-03

- 生图 Skill 初始化兼容历史分组并避开可选目录的权限问题，初始化失败时给出可操作的中文提示。

## 0.1.30 - 2026-09-03

- 生图 Skill 鉴权优先复用软件已签发的 Codex Key，仅在鉴权、限流、分组不可用这类可安全重试的上游状态下回退到图片分组 Key。
- 已安装的官方 Skill 文件通过受管摘要自动升级，保留用户改过的说明、脚本与本地配置；官方 ChatGPT 与星芒中转账号切换时同步 Skill 开关。
- 更新开发依赖锁文件以消除已披露漏洞。

## 0.1.31 - 2026-09-04

- 汇总工作台、账户中心、初始化流程与无限画布的累计修复，补充 UI 与交互测试。
- 账户中心密钥表格改版：名称列按内容自适应，长密钥名称完整换行，保留表格按需滚动。
- 把平台相关的 CLI 解析拆进独立测试，macOS 与 Windows 分支互不干扰。

## 0.1.32 - 2026-09-08

- 按 UI v3.1.1 从零新增 `src/renderer-v2` 并接回完整业务链路，升级 React 19，把 v2 设为默认构建，同时保留显式的 legacy 回滚入口（`compile:legacy` / `dev:legacy`）。
- 补齐平台能力、聊天网络边界、公告与账号配置回归，并把新版测试纳入 CI。
- 修复聊天首响应超时与流式结束的兼容问题，统一 Electron 网络栈，诊断信息补充脱敏。
- 升级 Electron 并保持无签名发布；旧界面的工具箱页先按 v3.1.1 设计稿升级了一版。

## 0.2.1 - 2026-09-10

- 账号层改为按 realm 分站：严格站点选择、站点运行时注册表、身份归属快照、realm 隔离的加密持久化，以及后端中立的账号信封与 sub2api 用户 API 客户端；带 epoch 守卫的候选会话切换避免切号后旧请求误报错误。
- 登录后按工具分组准备专属 API Key，个人资料、余额、用量、订单、兑换码与邀请返利接入对应账号服务；聊天、画布与工具配置的分组支持实时刷新，配置界面显示当前密钥尾号及实际所属分组。
- 公告改为标题列表加单条富文本详情并自动同步已读，修复公告读取异常导致账号意外退出的问题。
- 修复扫码付款后支付窗口不自动关闭：持续核对订单，确认到账后关闭窗口并刷新余额与订单；拒绝带凭据的收款二维码载荷。

## 0.2.2 - 2026-09-12

- 保存工具配置时可选择保留自定义设置或备份后重置，完善 ChatGPT 账号与自动专属密钥两种保存方式。
- 修复 NewAPI 公告合集被整页展开的问题，改为标题列表、单篇富文本详情与按账号保存已读状态。
- 余额统一自动刷新：窗口可见时每 30 秒更新，切回窗口及消费完成后补刷，失败时保留上次金额。
- 补齐调用详情的令牌、分组、推理强度、Token 与缓存明细、精确费用及动态价格档位，并接入 Sub2API 费用拆分。
- 修复 macOS 上已安装 Codex 桌面端却因未安装 CLI 而无法打开的问题。

## 0.2.3 - 2026-09-14

- 接入本机游戏加速体验：线路选择、延迟检测与智能分配，加速组件与渲染层加速页一并落地。
- 修复 Codex 桌面端配置相关问题；Windows 篡改验证后的临时文件清理加重试，消除偶发失败。

## 0.2.4 - 2026-09-14

- 新增 macOS 游戏加速支持，适配 M 系列与 Intel，每账号在本机累计免费 20 分钟。
- 修复 Mac 加速组件从桌面目录启动时无法弹出系统授权的问题，完善网络设置生效确认、停止恢复与异常退出清理。
- 将「全球加速」统一更名为「游戏加速」，同步页面、使用帮助与网络连接提示。

## 0.2.5 - 2026-09-16

- Codex 新建与重置配置不再预设上下文窗口及自动压缩阈值，改由客户端和所选模型决定；更新后首次启动自动备份并清理现有 Codex 配置及账号来源快照中的这两个字段，成功后只记录一次。
- 关闭窗口时可选择缩到托盘或强制退出，移除退出检查失败弹窗；窗口状态保存或界面无响应不再阻止所选操作。
- 稳定原生退出与代理发布状态的验证用例。

## 0.1.12 - 2026-08-02

- API Key 输入框的小眼睛支持按需读取并显示本机配置中已保存的完整 Key；普通配置扫描仍只返回掩码，隐藏后清理渲染层中的明文状态。
- 主程序清单由 `requireAdministrator` 改为 `asInvoker`，日常启动不再弹出 UAC；诊断页将普通用户权限视为正常状态，手工以管理员身份运行时改为提示风险。
- Codex、Claude、Grok、Gemini 四个 CLI 改为当前用户 PowerShell 直接启动，打包门禁会拒绝重新引入 `RunAs`。Codex 桌面端继续通过 Explorer 使用当前桌面会话启动。
- 普通权限模式下，npm CLI 使用用户 npm 全局目录，Grok 使用 `%USERPROFILE%\.grok\bin`，安装事务也不再依赖 `ProgramData` ACL；手工以管理员身份运行时仍保留原有高完整性安全边界。
- Node.js 的 `winget` 失败兜底改为在用户临时目录下载，完成 SHA-256 与 Authenticode 双重校验后调用绝对路径的系统 `msiexec.exe`；主程序本身无需管理员权限，Windows Installer 可在安装操作发生时单独处理授权。
- 修复普通用户模式下 CLI 启动进程存在但没有可见窗口的问题；启动器现在通过不带 `RunAs` 的系统 PowerShell 代理创建普通可见终端，并在拿到真实终端进程 ID 后才报告打开成功。
- 适配 Codex Desktop 国内镜像迁移到中科院高能所对象云后的 AWS V4 签名跳转；仅放行固定域名、固定存储桶路径和完整签名字段，原有清单 SHA-256、文件大小、MSIX 身份与签名校验保持不变。

## 0.1.11 - 2026-07-26

- 修复卸载后重新安装 CLI 必定失败、报「高权限命令目标或输入文件位于用户可写目录，已阻止执行」的问题。提权执行会对命令行里的每个绝对路径做 realpath 校验，而 npm 缓存目录当时尚未创建（npm 自己创建它发生在校验之后），路径不存在同样被判为不可信。现已在执行前预先创建。
- 提权执行被拒时，错误信息会指出具体是哪个路径未通过校验，不再只给一句笼统结论。

## 0.1.10 - 2026-07-26

- 用户级 npm 安装的 CLI（Codex、Claude、Gemini）现在可以直接卸载，不再只显示「需手动卸载」。卸载改为交给一个以当前登录用户身份运行的命令窗口执行，包自带的卸载脚本因此拿不到管理员令牌，原有的提权风险不复存在。窗口中完成后回到安装维护页刷新即可。

## 0.1.9 - 2026-07-26

- 修复受保护目录加固存在并发竞态，导致 MCP、Skills、Plugins 间歇报「所有者不是管理员」的问题。加固过程中 `icacls /reset /T` 会让根目录短暂恢复为继承上级 ACL，此时并发进入的另一次调用会把这个中间状态判定为目录被抢占。MCP、Plugins 与环境扫描各自都会触发加固，并发是常态。现已按目录串行化。
- 属主探测失败不再与「属主不可信」共用同一条错误信息，改为单独报告并保留底层原因，避免故障定位时把两种情况混为一谈。

## 0.1.8 - 2026-07-26

- 修复受保护目录加固会把目录树内所有文件的访问控制列表清空的问题。`(OI)(CI)` 是容器继承标志，带着它的 `/grant:r` 在文件对象上会被丢弃，与 `/inheritance:r /T` 组合后每个文件都只剩空 DACL，连管理员都无法读取或删除，随后的 ACL 校验必然失败，表现为 MCP、Skills、Plugins 页全部报错。加固改为只在根目录授权、子项通过继承获得权限。
- 该问题自 0.1.4 起就存在，此前因受保护目录树内没有文件而未被触发；0.1.5 写入标记文件后开始显现，安装过原生 CLI 的机器也会命中。
- 升级会自动修复：加固前先对整棵树执行 `icacls /reset /T`，历史遗留的空 DACL 文件随之恢复，无需手工处理。
- ACL 校验相应调整：仅根目录要求断继承，子项按设计继承根的权限，其所有者与写入权限仍逐项校验。

## 0.1.7 - 2026-07-26

- 修复 0.1.6 仍会在 MCP、Skills、Plugins 页报「受保护目录子项」ACL 校验失败的问题。0.1.5 引入了一个只写不读的 `.xingmang-root` 标记文件，它建在加固完成之后、带着继承来的 ACL，导致下一次启动的递归 ACL 校验必然失败。该文件的读取逻辑此前已被移除，写入属于遗留死代码，现已删除。
- 升级路径修复：加固前会主动清理旧版本残留的 `.xingmang-root`，装过 0.1.5 或 0.1.6 的机器无需手工处理受保护目录。

## 0.1.6 - 2026-07-26

- 修复 0.1.5 的严重回归：受保护目录的属主校验会把应用自己在未提权模式下创建的托管根误判为被抢占，导致 MCP、Skills、Plugins 全部报错「受保护目录已被非管理员账户创建」。现在只有目录树内确实存在文件时才执行该校验——空目录没有可被高权限执行的载荷，加固过程会用 `/setowner` 夺回属主，可以安全接管。目录内已有文件时仍然拒绝，并给出更明确的处置说明。

## 0.1.5 - 2026-07-26

安全与数据完整性：

- 修复 `C:\ProgramData\XingMangAI` 受信执行根可被普通用户抢占创建的本地提权路径：目录已存在时先校验属主与写入 ACE，逐级创建时立即收紧 ACL，探测失败一律拒绝采信。
- 备份恢复失败时不再误删用户当前配置；回滚写回也失败时保留唯一副本并在错误信息中给出其路径。
- 备份保留策略不再删除正在恢复的那份备份。
- 会话导出改为写临时文件再原子替换，导出失败不会损坏用户已有的同名文件。
- 主进程新增权限白名单，渲染进程默认无法获取摄像头、麦克风等设备权限；生产 CSP 移除开发服务器来源。
- 修复 electron-builder 26 下打包因配置校验失败而无法进行的问题：`publisherName` 已由 `win` 迁移到 `publish` 配置。该字段决定 `app-update.yml` 是否携带预期发布者，缺失会让 electron-updater 整体跳过更新包验签，因此改为迁移而非删除，并显式声明 `win.verifyUpdateCodeSignature`。

稳定性：

- 修复安装或检测超时后子进程树未被终止、安装队列可能永久卡死的问题。
- 单个 CLI 探测异常不再导致整个环境检测失败。
- 配置文件超出体积上限时降级为警告并在界面提示，不再让整个 MCP 列表功能失效。
- 归档或恢复中断后残留的重复会话文件可以被正常恢复。
- 修复强制刷新后仍可能写入过期版本缓存的问题。
- 修复中文系统下 PowerShell 输出乱码导致失败原因不可读的问题。
- 修复 Codex 桌面端应用版本号始终读不出来的问题：清单位于 `app.asar` 内，Electron 归档层返回的 stat 每次都是新的 inode 且没有时间戳，原有的硬链接与 TOCTOU 校验在归档路径上永远无法通过。
- 修复未提权运行时，用户级 npm 安装的 CLI 被错误标记为「需手动卸载」的问题。该限制的实际风险是用管理员令牌执行用户可写目录里的卸载脚本，因此只在 `trusted-only` 模式下成立；`same-user` 模式下与用户自己在终端执行 `npm uninstall -g` 等价，现已放开。管理员模式（正式安装包）行为不变。

交互与体验：

- 修复后台检测完成会清空正在输入的 API Key 与已选模型的问题。
- 修复侧边栏切换主题后保存设置会把主题回退、以及清空设置页未保存草稿的问题。
- 环境检测进行中时安装教程弹窗可以正常关闭。
- 提示条不再被弹窗遮挡，长路径与长链接正常换行。
- 卸载失败时关闭确认弹窗并展示具体失败原因。
- 备份支持删除，并按保留上限自动清理。
- CLI 与桌面端启动增加重入保护，避免重复弹出工作目录选择。
- 错误信息统一剥离内部 IPC 通道名。

## 0.1.4 - 2026-07-25

- 修复 Codex Desktop 国内镜像官方 MSIX 发布者身份被误判的问题，同时保留产品、版本、架构、摘要和 Appx 签名校验。
- 主程序默认在启动页预检更新，发现新版本后显示下载进度，下载校验完成后自动安装并重启；用户可在设置中关闭启动预检。
- 启动更新检查超过 8 秒时先打开应用，原请求继续在后台运行，稍后发现新版本仍会自动完成下载、校验和重启安装。
- 正式包运行期间每 3 小时检查一次版本；定时检查只提示新版本，用户开始下载后自动完成校验和重启安装。
- 启动页只检测 Codex 配置，进入工具概览后再后台执行完整环境与 AI 工具检测。
- 修复维护页扫描完成后重复触发扫描导致列表持续停留在“检测中”的问题。
- 将离线版本查询超时收紧并保留具体失败原因，避免网络异常阻塞维护页。
- 修正发布脚本和文档中“未签名发布”的过时说明，正式发布统一要求有效 Authenticode 签名。
- 明确候选构建与线上发布的权限边界：构建不会上传，操作更新源必须获得当前版本的明确发布授权。

## 0.1.3 - 2026-07-25

- 新增五个 AI 工具的安装目录与数据目录识别，并为每个工具提供卸载功能。
- 单个工具的“检查更新”现在只检查当前工具；Grok 检测失败会显示具体原因。
- 完善 Codex Desktop 国内镜像清单校验、已安装版本与可下载版本比较，避免重复安装或降级。
- 修复刷新后残留旧配置、旧模型和目录状态的问题。

## 0.1.2 - 2026-07-25

- 产品品牌统一为“星芒AI”。
- 暗色主题、亮色主题和 Windows 程序图标统一使用黑底圆角新版图标。
- 保留原有应用 ID、用户数据目录和更新地址，确保旧版本可平滑升级。

## 0.1.1 - 2026-07-25

- 启用 Electron ASAR 完整性校验，并强制仅从 `app.asar` 加载应用代码。
- 关闭生产包的 RunAsNode、NODE_OPTIONS、CLI Inspector、远程调试和 DevTools 入口。
- 压缩 Electron 主进程与 preload 代码，增加逆向分析成本。
- 新增发布加固门禁，关键 fuse 或 ASAR 状态不符合要求时禁止发布。
- 该版本当时仍采用未签名分发方式，Windows 可能显示 SmartScreen 提示；当前正式发布策略已在 0.1.4 改为强制 Authenticode 签名。

## 0.1.0 - 2026-07-24

- 新增 Node.js、npm、Python、四套 AI CLI 与 Codex 桌面端环境检测、安装和启动。
- 新增首次 Codex 初始化、模型检测、五项原生配置、备份与恢复。
- 新增 SQLite 权威会话列表、JSONL 正文读取、搜索、统计、导出、归档和恢复。
- 新增 MCP、Skills、Plugins 与 Marketplace 管理。
- 新增健康诊断、CLI 批量维护、应用设置和亮暗主题。
- 新增 generic provider 主程序更新状态机与发布配置。
- 修复工具刷新时配置和模型状态未同步更新的问题。
- Grok CLI Windows 安装改用 xAI 官方 PowerShell 安装器。
- 移除原生系统弹窗并缩小侧边栏导航字号。
- 加固 IPC sender/payload 校验、固定 argv 命令执行、敏感信息脱敏、超时取消和事务写入。
