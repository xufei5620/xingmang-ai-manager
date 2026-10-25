# 模块地图 · 当前界面 `src/renderer-v2/`

> 总述、三套跨进程通道和其他分册见 [`../MODULE-MAP.md`](../MODULE-MAP.md)。每个模块一句话，**一律以代码为准**；加了新模块在这里补一行。

> 路径都写相对 `src/renderer-v2/` 的。界面只在这棵树里改；`src/` 下其余部分是冻结的 legacy 回滚版（T14），这里一个文件都不许引它（门禁见文末「要点」）。

## 入口与外壳
- `main.tsx` — **渲染进程入口**：根目录 `index.html` 写的是旧界面的 `/src/main.tsx`，`vite.config.ts` 在没指定 legacy 时换成这里。按固定顺序引五份全局样式（tokens → components → shell → app → contrast 最后），第一帧先定浅色和平台（Mac 顶栏第一帧就要给红黄绿让位），挂上错误上报和「窗口在后台」标记；App 准备好之前替它回答主进程的关窗询问，免得关窗干等 15 秒超时。
- `App.tsx` — **新界面的总装配，持有全局状态**（默认导出 `RendererV2App`）：启动、登录态与账号作用域、登录后签 Key 写进工具、工具扫描、更新、开机提示、各种弹窗都由它编排。业务页（`pages-business`）、聊天、游戏加速三块用 `React.lazy` 按需加载，首页直接打包；去过的页只藏不卸（`hidden` + `inert`），切页不丢筛选和滚动。防迟到回包靠 `accountEpoch`、`bootstrapEpoch` 这类 useRef 计数器（T6）。
- `bridge.ts` — 取 `window.xingmang`（preload 暴露的主进程桥，类型是 ipc-contract 的 `XingmangApi`）；不在 Electron 里时返回 null，浏览器夹具据此换成假桥。
- `platform-api.ts` — 取第二座桥 `window.xingmangPlatform`（`electron/platform/contract`，只 `import type`），把系统深浅色、高对比度同步到根节点；用 revision 计数丢掉比推送更晚回来的初次读取。
- `types.ts` — 新界面自己的几个类型别名（`V2Bridge` 就是 `XingmangApi`、`V2Page`、主题、平台），全部从 ipc-contract 与 registry 只取类型。

## 跨页面共用的底座
- `business-common.tsx` — **各页共用的错误话术与数据钩子**：剥掉 Electron 包在 IPC 拒绝外面的「Error invoking remote method '通道名'」前缀和类名、路径换成占位词、Key 过 `electron/redaction-patterns` 打码再上屏（I13）；`useResource` 用 useRef 序号丢弃迟到的读取（T6），另有 `useOperation`、`ResultNotice`、相对时间与金额格式。和 legacy 的 `src/error-message.ts` 是两棵树各一份，有意重复（I6/I7 同理）。
- `operation-error.ts` — 把主进程一长句失败原话（npm/系统错误码、主进程自己写的句子）按先后规则认成 `registry/errors.ts` 里的一类，并配好下一步按钮（重试、看日志、找客服、重新登录、复制路径、去备份……）；同一句 EPERM 写配置和写安装目录出口不同，要调用方告诉它在写什么。
- `account-context.ts` — 账号作用域与站点判定：哪个账号算当前作用域（开机恢复中按正在恢复的那个算，恢复成功不用整页重来）、session 属于星芒账号还是历史账号、当前账号能不能用个人中心某个页签或落点。
- `account-switch-sync.ts` — 切换账号时「顺手把工具也换过去」：只挑原本连着旧账号、磁盘上地址仍是旧站某条已登记线路且凭据没被改过的工具，切完回报哪些工具还开着要重开。App 与 `SavedAccounts.tsx` 共用。
- `SavedAccounts.tsx` — 「切换账号」框：保存过的账号、切换时默认一起换走在用账号密钥的工具（自己填的密钥默认不动）、切过去才发现登录失效的给「重新登录这个账号」。文件里的 `card` 样式按它自己的注释眼下没有页面用。
- `external-link-fallback.tsx` — 公告、协议里的链接被主进程外链白名单拦下时的出路（I12，白名单不放宽）：只认 http(s) 且不带账号密码段的地址，复制给用户自己去浏览器打开；只看主进程给的错误码，不比对文案。
- `LocalAvatar.tsx` / `local-avatar.ts` — 本机头像：选图、裁剪、压成 256 见方的 PNG 按账号存进 localStorage；保存前比对的是最后一次真正上屏的账号，并发渲染被丢弃时也不会存到别的账号上。
- `AccountFilters.tsx` — 用量账单、异步任务那种「常驻几个框 + 展开筛选」的筛选条，以及展开按钮上「已生效几个」的计数。
- `calendar-time.ts` — 列表时间统一按本机日历写（「今天 14:20」「昨天 09:12」「9月28日」），按日历天差算、不按 24 小时；首页最近、记录、备份都照它。
- `app.css` / `business.css` / `extensions.css` — 页面级样式：`app.css` 管首页与工具配置弹窗（main.tsx 直接引），`business.css` 管个人中心、记录、检查等业务页（随 pages-business 一起懒加载），`extensions.css` 管外接工具、技能、插件和精选页。

## pages-\*.tsx 业务页（全部经 `pages-business.tsx` 懒加载）
- `pages-business.tsx` — **业务页的懒加载入口**：App 用 `React.lazy` 只引它，它按页面 id 分发到下面几个文件，并把个人中心页签、教程主题、付款回跳这些跨页参数接下去。
- `pages-maintenance.tsx` — 只做转出（#1070 第 11 步拆开）：检查、反馈与客服、设置三页和它们共用的两个文件都搬了出去（下面五条），原来从这里 import 的地方不用改；`TutorialPage` 也从这里转出。
- `features/health/HealthPage.tsx` — 检查页（`HealthPage`：诊断分组、一键修复、连接检查，运行环境那几行的安装与换新版 Node.js）。
- `features/feedback/FeedbackPage.tsx` — 反馈与客服（`FeedbackPage`：留言反馈、运行日志、复制/导出反馈报告，右边的「找客服」卡）。
- `features/settings/SettingsPage.tsx` — 设置页（`SettingsPage`：外观显示、启动关闭、工具管理、网络加速、消息通知、备份迁移、隐私数据、版本更新八组，左栏搜索设置和快捷键弹窗）。
- `business-actions.ts` — 各业务页共用的 `BusinessActions` 参数类型，连同装工具的结果、「找客服」卡、点名要落的反馈页签几个类型（只有类型）。
- `features/tools/install-result.ts` — 装工具那几句结果、首页那份任务算不算这一行在装、「安装指南」落教程哪一章；检查页和扩展三页都用（扩展页经 `pages-maintenance` 拿，拆之前就这样）。
- `pages-management.tsx` — 只做转出（#1070 第 11 步拆开）：记录页、扩展三页和它们共用的两个文件都搬了出去（下面四条），原来从这里 import 的地方（`pages-business.tsx`、`pages-featured.tsx`、测试）不用改。
- `features/sessions/SessionsPage.tsx` — 记录页（`SessionsPage`：各工具会话、接着聊、归档）。
- `features/extensions/ExtensionsPage.tsx` — 扩展三页（`ExtensionsPage`：外接工具 MCP、技能、插件）：分得清「没有可装的」和「官方市场还没加进来」，Codex 插件目录由星芒代下；安装一律走主进程既有通道。下线的 Gemini 不列。
- `features/extensions/extensions-common.tsx` — 扩展三页和「星芒精选」页共用的判断、解析和卡片：列表怎么分组、每一行能点什么、添加连接时的检查与解析、要 Python 或 uv 时那句提示、精选条目的卡片和详情。
- `features/tools/provider-options.ts` — 记录页和扩展三页共用的工具选单：认不认这个工具（下线的 Gemini 不认）、按导航次序的选项、编号换名字。
- `pages-account.tsx` — 个人中心（`AccountPage`）：账号概览、充值订阅、用量账单、密钥管理（含「配置到工具」写 Key）、账号安全、邀请返利六个页签的装配；下线的 Gemini 不替它写 Key、不列它的额度。
- `pages-featured.tsx` — 「星芒精选」页：把随包精选清单摆成卡片，一次装进几个工具；装法和扩展页底下的精选是同一条路（不另开通道，主进程校验照样过一遍）。

## features/tools/ 首页、工具卡片与写 Key 链

首页本体与弹窗：
- `features/tools/Home.tsx` — **首页**：工具卡片、余额卡（近 7 天花费、还能用几天）、提示条、运行环境、最近对话、「试试第一条命令」。由 App 直接渲染，不懒加载。
- `features/tools/useToolbox.ts` — **首页数据与任务的总钩子**：扫描系统、读配置和外接客户端、安装/更新/卸载任务的进度与取消、装完发系统通知；用 `request`、`configRevision`、`desktopRevision` 等 useRef 计数器丢掉迟到回包（T6）。
- `features/tools/api.ts` — 首页的 IPC 封装：一次读取拆成 system / config / platform 三块，config 读失败只降级、不连坐整页；「最近对话」和余额用量按 60 秒缓存。
- `features/tools/model.ts` — 工具的展示模型：哪些工具上界面（注册表里的，不含下线的 Gemini）、装没装、来源是当前账号/官方/手填/被改过/未确认、能不能卸、能不能换成星芒装的；首页、配置框、引导的判定都从这里出。
- `features/tools/ConfigDialog.tsx` — 工具配置弹窗（v4 第 5 批）：三张来源卡、带说明的密钥下拉、模型行、两段折叠与行内重置；保存失败先说认得出的原因、原话跟在后面。
- `features/tools/OtherModelsDialog.tsx` — Codex「换用别家模型」小弹窗：沿用工具里现成那把当前账号密钥（主进程的沿用通道，不读出、不换 Key，I3），只问用哪个型号；来源不对时先一键改用当前账号（备份、写入、自检都在主进程）。
- `features/tools/ExternalClientDialog.tsx` — 接入外部桌面客户端（Claude Desktop、WorkBuddy、OpenCode）的配置弹窗：借哪个工具的密钥、选哪个型号，保存后跑一次可连接自检。
- `features/tools/OptionPicker.tsx` / `features/tools/dialog-parts.tsx` — 弹窗里的小零件：一项两行（名字 + 灰字）的下拉，让同名密钥分得开；单选卡片组；有未保存修改时先亮离开条的「取消」和离开链接。
- `features/tools/ToolConversationsDialog.tsx` — 卡片「…」里「接着之前的对话」：这个工具每个文件夹一行，每次打开现读，不用首页那份一分钟缓存。
- `features/tools/ManualUninstall.tsx` — 卸载没删干净时的手动清理框：显示能复制的命令和它对应的终端名；主进程记下了文件时才给「帮我清理」，删哪些永远由主进程定。
- `features/tools/UninstallGuide.tsx` — 星芒卸不了的桌面端（三个外接客户端、Mac 上的 Codex 桌面端）只给「去系统里怎么删」的指引。
- `features/tools/NodeReplaceDialog.tsx` / `features/tools/node-replace.ts` — 「换成新版 Node.js」：公司电脑换了证书、老 Node 不认本机证书时才提供（Windows、Linux 换得了；Mac 上代下的排在客户自己装的后面，换了也用不上），确认框与结果说法。
- `features/tools/RuntimeRestartDialog.tsx` — Node.js 装完 Windows 要重启（MSI 3010）时的框和常驻提醒：只给「现在重启」一颗按钮，焦点先落在说明上，防一次回车就重启。
- `features/tools/RuntimeInstallHint.tsx` / `features/tools/runtime-install-guide.ts` — 运行环境装法：Windows 由软件代装，Mac/Linux 的 Node.js 由软件准备，Python 在 Mac/Linux 只把命令讲清、让客户自己粘进终端（本程序从不代跑终端命令、在这两个平台从不提权）。
- `features/tools/FirstRun.tsx` / `features/tools/first-run-dismissal.ts` — 装好后的「试试第一条命令」卡（启动命令 + 一句中文提示词，剪贴板失败也有回音）和关掉后的本机记录（localStorage，读回一律当坏数据校验）。
- `features/tools/OfficialQuotaDialog.tsx` — ChatGPT 账号额度弹窗，首页卡片和配置弹窗共用这一个。

账号 → 工具写 Key 链：
- `features/tools/account-bootstrap.ts` — **登录后把当前账号的 Key 写进工具的那条链**：分「登录」「开机恢复」「点名重写」三档，只有点名重写会覆盖「我们写过、之后被改过」的配置，免得用户手改的配置下次开机被悄悄改回去；还管开机检测没跑完时首页摆的旧结果会不会被换掉、配置失败的话术。App 调度，首页与个人中心读结果。
- `features/tools/source-marker.ts` — 记下用户手选的「来源」（localStorage；同一站点的各条线路合用一个标记，线路自动切换时不丢，旧的按线路存的几份读到就迁移）；写不进去时配置本身照样已写进 CLI。
- `features/tools/key-selection.ts` — 配置框密钥下拉的规则：列哪几把（同组同名只留一把）、默认选哪把（别的站的 Key 不能「保持当前」）、手填密钥格式检查、掩码与分组那一行；分页读齐账号全部密钥。
- `features/tools/key-sync-failure.ts` — Key 同步失败的那半句原因：先脱敏（I13），认得出的说目录里的标题，「这个账号没开通对应工具」换成能照做的话，认不出的英文不上屏。
- `features/tools/online-resync.ts` — 没网时打开软件、签 Key 必然失败，网络回来自动补跑一次；只回答「这次失败是不是网络或证书造成的」「要不要补跑」，不碰 React、不发请求。
- `features/tools/backup-key.ts` — 恢复备份时标出备份里那把 Key 属于谁；主进程只给归属结论和账号名，从不给 Key 或摘要（I3）。
- `features/tools/connection-check.ts` — 可连接检查各层的中文名、「去处理」跳哪一页、哪些工具能一键重写 Key；层名表与 `electron/connection-check.ts` 是有意重复的字面量（主进程那份依赖 node:*，I6），用 `Record` 让漏键变编译错。

打开、模型与线路：
- `features/tools/recent-workspaces.ts` — 首页「打开」记住的文件夹、「接着聊」该接哪条会话、新建项目文件夹的文案；读回的会话页先去掉下线的 Gemini。
- `features/tools/recent-display.ts` — 首页「最近」那一行的时间、副标题与「接着聊」提示（写明会用哪个工具打开）。
- `features/tools/launch-notice.ts` — 打开工具之后的那句提醒（项目文件夹设置会盖过当前账号、Codex 中文没生效）、被用户拒绝的打开、「打开」排队时在等谁。
- `features/tools/model-check.ts` — 打开前主进程核过的模型：默认型号用不了且挑得出替代时问一句换不换，挑不出就照常打开让工具自己报错。
- `features/tools/model-filter.ts` — Codex 型号列表的显示过滤（藏掉写不对补丁格式的别家型号，已配上的不动）和「换用别家模型」的候选、保存检查。
- `features/tools/external-client-defaults.ts` / `features/tools/external-client-notice.ts` / `features/tools/external-model.ts` — 外接客户端：默认借哪把密钥、哪个型号放进哪家拿得准（Claude Desktop 只认 Claude 型号）、保存结果用什么颜色、Linux 上整行不列、「连好了没有」的统一认法。
- `features/tools/route-label.ts` — 首页工具行开头的线路标签（界面只叫线路1、线路2，不说在哪）和服务端切换、网络把线路2 劫持后改走线路1 的提示。
- `features/tools/chinese-runtime-choice.ts` / `features/tools/locale-status.ts` / `features/tools/codex-desktop-open.ts` — Codex 桌面端：打开前要不要问中文补丁、中文界面与文件夹权限的说明（Mac 版另写，星芒在 Mac 上不替人重开 Codex）、已开着时要不要给「重启 Codex」（只 Windows）。

安装与更新：
- `features/tools/runtime-readiness.ts` — 装命令行工具前的运行环境判定：按 `versionStatus` 而不是 `tooOld` 认 Node 版本（读不出版本的不能当成够新），排「先装 Node 再装工具」的步骤和进度说法。
- `features/tools/runtime-install-outcome.ts` — 把主进程装完运行环境带回的「要重启电脑」「PATH 要刷新」两个标记翻成一句话。
- `features/tools/restart-reminder.ts` — 「还差重启一次电脑」只记在内存里，故意不落盘（落盘分不清重启过没有）。
- `features/tools/install-stage-text.ts` — 安装进度那一行只说白话；源名、SHA-512、npm 英文输出只进日志。
- `features/tools/install-notice.ts` — 装完/更新完要不要发系统通知（人正看着窗口就不发）；聊天回答完、图片生成完要不要通知也用它判窗口在不在前台。
- `features/tools/elevation-notice.ts` — Windows 上真会弹管理员授权的两处安装（Node.js 机器级 MSI、Codex 桌面端 Appx）的提前说明。
- `features/tools/managed-switch.ts` — 「换成星芒装的」先定下版本号，确认框写出的就是装下去的那一版。
- `features/tools/update-notice.ts` — 工具有更新时的角标数与系统通知去重（本机记已通知过的版本）。
- `features/tools/uninstall-handoff.ts` — 以管理员身份运行时卸载会转交给普通权限窗口，这是预料中的一步，给中性提示而不是报错。
- `features/tools/rescan-change.ts` — 「重新检测」前后各取一份指纹，没变化就说一句「没有变化」。

首页小数据：
- `features/tools/week-spend.ts` — 余额卡「近 7 天花费」：按本机自然日一天查一次（后台按 UTC 分桶会把北京时间的一天切在中间），过完的天记下不再查。
- `features/tools/ttl-cache.ts` — 带有效期的单飞缓存：同一趟请求不重复发，作废时让还在飞的那趟结果不再写回（防迟到覆盖）。

## features/account/ 个人中心
- `features/account/AccountRecharge.tsx` — 充值订阅页与订单列表：充值档位、付款方式单选卡、等待支付结果、买套餐弹窗、付款结果提示。
- `features/account/recharge.ts` — 充值订阅页上由数据拼的话和算的数（付款结果文案、到账额度、套餐价格与期限、订阅开通后工具要不要换 Key）；纯函数，字以字表批07为准。
- `features/account/topup-tier.ts` / `features/account/topup-bonus.ts` — 充值档位卡：实付由服务端试算、客户端不自己乘比例（价格活动都在后台改）；「充 100 送 10」式的赠送换算（首页活动卡也用）。
- `features/account/payment-method-label.ts` — 后台没填渠道显示名时，把渠道代码（如 alipay）换成中文。
- `features/account/AccountOverview.tsx` — 账号概览：余额、订阅、近 7 天、密钥数、登录设备；和首页同源的数由外壳交下来，不另算。
- `features/account/account-center.ts` — 个人中心 v4 上由数据拼的话：近 7 天按本机零点一天一段读、密码规则（两种账号不同）、密钥到期选项、邀请返利文案；纯函数。
- `features/account/AccountSecurity.tsx` — 账号安全：改密码（框里还有密码时 Esc/点遮罩也先问，免得明文留在 React 状态里重开又被填回）、让登录设备下线；改完本机还登不登着两种账号不一样（T12）。
- `features/account/login-device-label.ts` — 把服务端回来的原始 User-Agent 在显示层认成大白话设备名，发出去和拿回来的原文都不动。
- `features/account/AccountProfileDialog.tsx` — 编辑资料（头像、显示名称；用户名和邮箱只读）。
- `features/account/AccountUsage.tsx` / `features/account/usage.ts` — 用量账单页：时间范围、花费趋势按本地日/本地周分段各问一次、按模型占比、调用明细的状态与快捷筛选、分页。
- `features/account/UsageDetails.tsx` / `features/account/usage-detail-view.ts` — 单条调用的计费明细弹窗和它的数字格式（Token × 单价 / 百万、分档条件、分组倍率）。
- `features/account/ToolKeyLimits.tsx` — 密钥页「各工具额度上限」：只列已有密钥的工具、可改上限；用光时照「只有把上限改大才放开」的真实语义说，不套「充值后恢复」。
- `features/account/ToolUsage.tsx` / `features/account/tool-usage.ts` — 各工具累计用量（从开始到现在的累计，不跟看板时间范围走，文案必须写「累计」）与占比。

## features/app/ 应用级状态、提示与设置零件

余额与账号读取：
- `features/app/balance-store.ts` — **软件里唯一按时去服务端拉数据的地方**：余额在用户看着时每分钟一次、被挡住或在后台每 10 分钟一次；公告、订阅、花费突增都搭它的车。连续几次本机网络失败也由它认出来，给断网横幅用。
- `features/app/balance-context.tsx` — 余额 store 的 React 接口：按账号作用域共用一份，StrictMode 重连时等最后一个使用者离开才释放；顺带给出当前能用的订阅。
- `features/app/subscription-cache.ts` — 订阅读取缓存：跟着余额读回顺带看、几分钟内读过不再读，刚买完订阅强制再读。
- `features/app/balance-runway.ts` — 「余额还能用多久」：按近 7 天用量算、订阅剩余也算进去；侧栏账号卡、侧栏「余额低」、首页、账号概览读同一个判断。
- `features/app/spend-spike.ts` — 「花费突然变多」提醒：只看余额每次读回的落差，掉够了再读一次用量核账才提醒；阈值写死，设置里只有开关。
- `features/app/account-read-error.ts` — 读账号失败时的说法与按钮：登录失效给「重新登录」（和错误框同一份规则），维护中不说成没网，过时的读取直接丢掉。

开机提示与更新：
- `features/app/startup-notice.ts` / `features/app/StartupNotices.tsx` — 开机时应用自己跑的后台检查（更新、诊断、外观……）与一次性告知的角落卡片：坏消息不许挡路（不弹模态），最多摊开两张、按「要你选 > 出事了 > 有空看 > 纯告知」排，其余折成一行；排序表是无缺省的 `Record`，加新提示必须给位置。
- `features/app/RequiredUpdateGate.tsx` / `features/app/required-update.ts` — 状态文件定了最低版本、本机低于它时盖住整个界面的那层：故意关不掉，只能更新或找客服，自动更新走不通时多一个「打开下载页」，磁盘不够时换成清理说明。
- `features/app/update-retry.ts` — 更新失败后「再来一次」的唯一走法（检查失败重查、下载失败先查再下、安装失败回到重启确认），版本卡与首页气泡共用。
- `features/app/release-notes.ts` — 版本卡上的「更新内容」说的是待下载的新版还是正在用的这一版。
- `features/app/LaunchInstallNotice.tsx` — 开机自动装上次下好的更新前的倒计时卡，是系统通知被吞时的兜底；不给「先不装」。
- `features/app/MaintenanceNotice.tsx` — 服务维护提示，固定补一句「不是你这边的问题、什么都不用改」，不提站点名。
- `features/app/template-fill-retry.ts` — 开机时因工具正开着没补成的设置，隔 10 分钟或回到前台再补，最多 6 次。

错误框与客服：
- `features/app/OperationErrorDialog.tsx` — 操作失败弹窗：按 `operation-error.ts` 的分类给出口，「复制路径」的目录由 App 从扫描快照解析，弹窗只负责显示和复制。
- `features/app/SupportIdentity.tsx` — 「复制给客服」那一行和失败包：账号名、账号 ID、版本、系统（Linux 带发行版），不写邮箱和站点名，原话再过一遍打码表（I13）。
- `features/app/error-report.ts` — 渲染进程错误上报给主进程：一阵连发只实时报第一条，窗口结束时补上次数。
- `features/app/FailureBoundary.tsx` — 渲染崩溃兜底：上报后换成「界面暂时没有打开」的启动画面，可以重试。
- `features/app/fallback-messages.ts` — 客服二维码生成失败、支付回跳读不到时给用户的那句话（不再静默吞掉，R-B7）。

检查页零件：
- `features/app/environment-status.ts` — 状态栏最左那一项与侧栏「检查」角标：开机检查和检查页都往这里报同一份计数，只数「待处理」。
- `features/app/diagnostic-group.ts` / `features/app/diagnostic-details.ts` — 检查页 v4 三组（需要处理 / 可选 / 正常）的归类，和「详情」表只挑看得懂的几项译成中文（站点地址、状态码、内部代号一律不上屏）。
- `features/app/diagnostic-fix.ts` / `features/app/diagnostic-folder.ts` / `features/app/stale-proxy.ts` / `features/app/certificate-trust.ts` — 检查页一行能不能「点这里就好」（主进程放了 fix 才给）、「打开文件夹」只传名字（路径主进程自己算）、清掉指向没开的本机代理的旧设置、安全证书那一项的代号。
- `features/app/runtime-log-filter.ts` — 反馈页运行日志：把 source / event（含 IPC 通道名）换成用户认得的分区，只看本次启动、筛选与格式化。

设置页零件：
- `features/app/RelayRouteSettings.tsx` / `features/app/AuthConnectionRoutes.tsx` — 连接线路设置（每种账号一行三选一，存好后提示重开生效）；登录前在登录框里也能改，改的只是本机线路偏好。
- `features/app/settings-queue.ts` — 设置保存排成一队串行提交，前一次失败不挡后一次。
- `features/app/ThemeCards.tsx` — 外观主题的三张预览卡（颜色写死，不跟当前主题变）。
- `features/app/AppUninstall.tsx` — 设置 › 版本更新里「卸载星芒」：Mac 给真卸载按钮（可连同星芒装的命令行工具一起删，删前备份配置），Windows/Linux 只说去哪儿卸。
- `features/app/data-transfer.ts` — 「搬到新电脑」导入导出的说法，以及把导入的设置交给保存队列的补丁。
- `features/app/remembered-login.ts` — 设置里「记住密码」那行该做什么：已登录只剩「清掉它」，没登录去登录框；Linux 没有系统密码保管时不给勾、说清这次关掉就要重登。
- `features/app/ui-scale-shortcut.ts` — Ctrl/⌘ 加减号与 0 缩放界面的按键识别与下一档倍率（输入法打字中不算）。

跨页跳转的「先放这儿、到了再取」：
- `features/app/settings-group-intent.ts` / `features/app/row-focus.ts` / `features/app/extension-tool-intent.ts` — 切页只传页面名，要落的设置分组、要翻到的那一行、扩展页要先选的工具先放在模块里，目标页挂上（或已挂着时经订阅收到）再取走，取走即清空。

杂项：
- `features/app/api.ts` — App 启动与账号、设置、公告这一组 IPC 的封装（启动时并发读齐设置、平台能力、会话、更新状态、窗口能力）。
- `features/app/preferences.ts` — localStorage 读写的 try/catch 包装：读不到返回 null、写不进返回 false，不抛错。
- `features/app/window-os.ts` — 当前是 win / mac / linux：平台能力 IPC 回来之前先用根节点或 Chromium 自报的平台，免得 Mac 顶栏第一帧跳一下。
- `features/app/window-idle.ts` — 窗口在后台时给根节点挂 `data-window-idle`，components.css 据此暂停转圈、骨架屏这类循环动画。
- `features/app/dev-preview.ts` — 引导预览开关只认主进程给的「开发运行」判断，打包版即使 URL 被注入参数也进不去（R-B8）。

## features/auth/ 登录、注册与新手引导
- `features/auth/README.md` — 本目录约定：只有 `api.ts` 碰 `window.xingmang`；AuthFlow 只管认证、不碰 Key 明文，签 Key 写工具由父级 App 协调；记住密码只走专用 IPC（I3 登记的例外），不写 localStorage。
- `features/auth/AuthFlow.tsx` — 登录 / 注册 / 找回密码 / 两步验证的模态流程：星芒账号与历史账号两个来源（历史账号入口默认收起）、失败按类别在红字下给出口、没网时等网络回来只换提示。
- `features/auth/state.ts` — 认证表单的纯逻辑：全角＠与常见邮箱拼写纠正、找回码解析（邮件链接必须属于所选来源）、注册校验、失败分类与中文话术。
- `features/auth/account-errors.ts` — new-api 服务端报错的中文对照表（按内容子串匹配）；与 legacy 树里那份有意各留一份，服务端改了文案两边都要同步。
- `features/auth/api.ts` — 认证相关 IPC 的封装；找回密码给的临时密码经主进程写剪贴板，主进程 60 秒后清掉（渲染层做不到）。
- `features/auth/StartGuide.tsx` — 新手引导：选工具 → 准备环境 → 连接账号 → 完成；没有默认选择，按 Node → Python → CLI 解锁，步骤是否完成以父级回读的数据为准，来源不明必须用户明确处理。
- `features/auth/guide-progress.ts` / `features/auth/guide-result.ts` — 引导进度按账号作用域存 localStorage（停在下线 Gemini 的当读不出），以及最后一步「接好了」那张结果卡的说法。
- `features/auth/Welcome.tsx` / `features/auth/WelcomeStarfield.tsx` / `features/auth/welcome-starfield.ts` — 欢迎页与满屏星空：星点位置只算一次交给 SVG 画死，闪烁改成几层整体变透明度，由合成器做；低配电脑与窗口在后台时动画停住。
- `features/auth/Splash.tsx` / `features/auth/AuthWindow.tsx` — 启动画面（显示父级真实阶段、进度与失败）和登录前几屏共用的可拖动窗口条。
- `features/auth/LegalDocument.tsx` — 用户协议与隐私政策弹窗：Markdown 里的链接走外链兜底，图片只显示替代文字。
- `features/auth/useCooldown.ts` — 验证码的 60 秒冷却。
- `features/auth/index.ts` — 本目录统一出口，App 只从这里引。
- `features/auth/auth.css` — 欢迎页、星空、登录框和引导的样式（星空配色照 0.2.18 按深浅各定一份，高对比度另一套）。

## features/chat/ 桌面聊天（App 懒加载）
- `features/chat/README.md` — 聊天页约定：同账号内只藏不卸、换账号按 scope 重建并取消旧请求；记录存主进程文件，localStorage 只作旧版迁移来源；写盘前剥掉凭据与运行时负载。
- `features/chat/ChatPage.tsx` — 聊天页：会话栏、消息区、输入框（模式、分组和模型、画图选项、加图片）；等主进程把记录读回来才显示，避免空状态抢先自动保存覆盖记录。
- `features/chat/useChatController.ts` — 聊天控制器：分组准备、发送/停止/重试、编辑重发、图片生成与取消、断网后重发；后台刷新只动元数据，不换用户的模型和草稿、不签 Key、不悄悄替换被吊销的分组。
- `features/chat/state.ts` — 会话与消息的数据结构和纯操作：默认分组 `GPT`、默认对话与生图模型、每轮请求快照、失败话术（过打码表，I13）。
- `features/chat/storage.ts` — 聊天记录读写：经主进程按对话分文件写盘、每次只重写改过的；写盘前剥掉 `sk-`、`Bearer`、`api_key=` 与 `blob:`、内联 base64（I13）；旧 localStorage 记录只读迁移，文件里有了才删旧副本。
- `features/chat/transfer.ts` — 「搬到新电脑」里聊天记录那一半：导入前先同步卸下聊天页，免得它下一次自动保存把导入的对话又冲掉。
- `features/chat/api.ts` — 聊天 IPC 的封装；只复用 `electron/ai-chat-protocol` 里无 Node 依赖的模型能力与请求校验函数，不改协议。
- `features/chat/ParametersDialog.tsx` / `features/chat/parameters.ts` — 每个对话自己的参数对话框：点「应用」才写回，滑块没动过就是「默认」、请求里不带这一项。
- `features/chat/links.ts` / `features/chat/math.ts` — 模型输出里的链接从不打开、只给复制，host 按 URL 解析认（`xm.solov.cc@evil.example` 显示真去处，I12 同理）；公式渲染成 MathML，不带字体文件、关掉 `\href` 等命令，CSP 不用放宽。
- `features/chat/index.ts` — 本目录出口，App 懒加载时从这里取 `ChatPage`。
- `features/chat/chat.css` — 聊天页样式（消息最宽 684、输入框最宽 740，悬停才露出的按钮）。

## features/shell/ 外壳：侧栏、顶栏、状态栏、公告与断网
- `features/shell/Shell.tsx` — **外壳**：侧栏（账号卡、余额与还能用几天、导航）、顶栏（面包屑、顶部搜索、铃铛）、状态栏（环境、网络、余额、版本）、侧栏收起。
- `features/shell/command-search.ts` — 顶部搜索 / 命令面板：页面、工具（打开/安装/配置）、动作、个人中心落点、设置项和教程一起搜，当前账号用不上的页签不列，搜不到时把字带去教程页。
- `features/shell/Announcement.tsx` — 公告中心、首页充值活动卡与活动条：服务端下发的公告 HTML/CSS 自己清洗（标签与 CSS 白名单、链接和图片单独核对），放进只有 `allow-same-origin` 的 sandbox iframe；轮询跟着余额刷新走，不另起定时器。
- `features/shell/newapi-announcements.ts` — 解析 new-api 公告集合，按单条内容哈希记已读 / 已看 / 已通知（别的公告插入或重排不丢已读）。
- `features/shell/promo-announcements.ts` — 按约定从公告里认出充值和邀请活动（只提到充值的通知不算）、截止日期和档位，去掉站点地址；今天藏起的活动条按账号记一天。
- `features/shell/online-status.ts` / `features/shell/useOnlineStatus.ts` — **唯一的「现在是不是没网」判断**：只认本机这一侧的网络失败（服务端慢、证书、维护都不算），顶部横幅、余额文案和要联网的按钮都读它；`navigator.onLine` 只当触发信号。
- `features/shell/OfflineBanner.tsx` — 断网时窗口顶部唯一的那一条，网络回来自己收起。
- `features/shell/balance-status.ts` — 余额旁那几个字：断网说「没网」，其余没读到才说「更新失败」。
- `features/shell/network-controller.ts` / `features/shell/useNetworkLocation.ts` / `features/shell/network.ts` — 状态栏网络那一项：加速连上/断开这类真实路由变化时才重测出口国家与 IP，没确认恢复直连前保留旧结果；挂在外壳上，换页不丢；慢的全量扫描不覆盖新探测。
- `features/shell/tour-state.ts` — 首页三步界面导览的本机状态：只有引导完成或用户点「重看」才播，老用户升级不被拦。

## features/acceleration/ 游戏加速（设置 › 网络加速）
- `features/acceleration/useAcceleration.ts` — 加速连接的钩子，**挂在整个应用最外层**（托盘、到期提醒连着它，离开页面不断连）；外层只订阅不带走表的快照，秒数由卡片自己订阅，免得整个界面每秒重画。
- `features/acceleration/controller.ts` — 加速状态控制器：余额与连接时长以主进程为准、不累计本地时钟；给 `useSyncExternalStore` 的读法只在走表以外的字段变了才换快照。
- `features/acceleration/lines-controller.ts` — 线路名单与测速：同一时间只测一条、旧名单不覆盖新测速，记住的线路下线了退回智能分配并清掉记录；按账号 epoch 隔离。
- `features/acceleration/api.ts` — 加速 IPC 封装，偏好那两个方法可选（交互预览与旧宿主没有）。
- `features/acceleration/AccelerationPage.tsx` / `features/acceleration/AccelerationView.tsx` — 游戏加速卡：露面时读一次状态、开关、线路菜单、加速文件损坏时的检查与说法；`AccelerationPage` 由 App 懒加载。
- `features/acceleration/acceleration.css` — 游戏加速卡样式。

## features/settings/ 与 features/tutorial/
- `features/settings/VersionCard.tsx` — 设置 › 版本更新最上面的版本卡：当前版本、更新内容、下载进度与主按钮，撤回、要管理员密码、磁盘不够、失败几种提示；Windows 授权窗、Mac 钥匙串、Linux 系统安装窗口各有提前说明。
- `features/settings/BackupCard.tsx` — 设置 › 备份迁移的备份列表、预览与恢复，恢复后提醒回首页看或重开工具；下线的 Gemini 不列。
- `features/settings/codex-remote/CodexRemoteCard.tsx` — 设置 › 工具管理的「手机遥控 Codex」整卡：干活的文件夹、每个渠道一块（凭据、打开遥控、配对码与绑定的人）；`CodexRemotePanel` 只管按快照摆，取数和操作在外层。
- `features/settings/codex-remote/channel-sections.tsx` — 各渠道那一块的登记表（`Record<RemoteChannelId, …>`，主进程加渠道这里漏了是编译错）：标题、提示句和填凭据的组件。
- `features/settings/codex-remote/FeishuRemoteSection.tsx` — 飞书那一块：填 App ID / App Secret（附怎么建机器人的六步，只写字不放链接），填过了只显示 App ID。
- `features/settings/codex-remote/remote-view.ts` — 卡上几处说法的纯函数（状态小标签、绑定的人、开关说明）和按 `revision` 取新快照。
- `features/settings/codex-remote/useCodexRemoteActive.ts` — 外壳状态栏「手机遥控中」用的：有渠道开着就亮，点了到设置里那张卡。
- `features/tutorial/TutorialPage.tsx` — 教程页：分类按钮与搜索、两列卡片、文章与吸顶条、「读到第几步」；顶部搜索没结果时带字进来接着搜。
- `features/tutorial/TutorialIllustration.tsx` — 教程每一步的示意插图（用界面同款图标拼出来，不是截图），每种插图配标题与说明。
- `features/tutorial/tutorial-progress.ts` / `features/tutorial/tutorial-search.ts` — 教程卡上的「已完成 k / n 步」（只存本机 localStorage、只进不退，不为它开主进程通道）和教程页与顶部搜索共用的分词匹配、高亮。
- `features/tutorial/tutorial.css` / `features/tutorial/tutorial-illustration.css` — 教程页与插图样式。

## registry/ 注册表（页面只读这里；展示顺序与文案的唯一来源；通篇带分号）
- `registry/tools.ts` — **工具清单与展示顺序的唯一来源**（T2）：`tools` 数组次序就是界面次序，npm 包名与配置目录名从 `electron/catalog` 派生不另抄（R-S11）；官方账号名等用无 default 的 `Record<ActiveProviderId, …>`，加工具漏键是编译错；另有首页工具次序与简介、首次命令提示、欢迎页星轨上的工具。
- `registry/pages.ts` — 页面清单（id、名字、图标、分组）；并入设置的游戏加速/备份/更新和拆掉的安装卸载页留作别名，旧跳转照样落得到；顶部搜索用的常用说法。
- `registry/shell.ts` — 侧栏分组与次序、首页三步导览。
- `registry/business.ts` — 业务页的页签与分组：个人中心页签和落点、反馈页签、设置分组与可搜索的设置项、更新状态与失败文案、订单/订阅/密钥/任务状态、筛选字段、跨页共用的教程章节 id（不许再写成字面量）。
- `registry/tutorials.ts` — 全部教程内容（篇目、分类、步骤、按钮落点，按平台筛）；落点按页收窄类型，写错编译不过。
- `registry/errors.ts` — 错误目录：每类失败的标题、正文和按钮字，`operation-error.ts` 认出类别后从这里取。
- `registry/connection-routes.ts` — 连接线路的选项与保存补丁：只叫线路1/线路2，星芒账号「自动」先走线路2、历史账号先走线路1，按账号分开存，存下的值（direct / primary）不变。
- `registry/curated-extensions.ts` — 「星芒精选」：把随包 `bundled-catalog/curated-extensions.json`（构建期内联，不要服务端、不加 IPC）收窄成类型并按页面、工具筛；安装不另开通道，免得绕过主进程对命令与参数的校验。
- `registry/extensions.ts` — 扩展三页与精选页共用的字：这一类叫什么、各家官方怎么叫、已装列表按范围分组。
- `registry/clients.ts` — 外接客户端的种类标签与能借用哪个工具的 Key（不含下线的 Gemini）。
- `registry/status.ts` — 各类状态牌的字和语气色（工具、运行环境、密钥、订单、任务）。
- `registry/icons.ts` — 常用动作（打开、安装、刷新、配置……）的图标映射。

## ui/ 组件层（照 ui-spec 原型抄的，通篇带分号）
- `ui/README.md` — 组件层约定：按职责分文件、不做一个组件一个文件夹（R-B3）、组件拒收 className / style、Dialog 用原生 showModal、Menu/Popover 用原生 popover、Toast 时长规则；附浏览器检查命令。
- `ui/index.ts` / `ui/components.tsx` — 页面一律从 `ui/index.ts` 引组件；`components.tsx` 汇总七个职责文件，并转出共享上下文与图标注册表。
- `ui/core.tsx` — 基础件：Button、Pill、Card、ListRow（整行可点）、ToolRow / ToolCard（v4 首页工具卡，牌子可缩、按钮不叠字）、SessionRow、Segment、Chips、Tabs、Empty、Progress、Skeleton、Table、PageHead。
- `ui/fields.tsx` — 表单件：Input（密码框大写锁定提示、框内小按钮）、Select、Textarea、SearchInput、Switch、Slider（「没动过」和「选了默认值」分得开）。
- `ui/modal.tsx` — Dialog / Drawer / Confirm：有未保存修改时关窗不换页，底栏换成离开条、再点一次抖一下；`useDialogClose` 让里面的按钮走同一道关闭。
- `ui/floating.tsx` — Menu、Popover、ChoiceMenu（原生 manual popover，保留所属 Dialog 的 DOM 与焦点链）。
- `ui/feedback.tsx` — Notice 与 Toast：错误和警告固定图标，Toast 按字数算时长、警告与错误不自动消失。
- `ui/guidance.tsx` — Tooltip 与 Coachmark（导览气泡：箭头指着目标并描边，目标看不见时找下一个）。
- `ui/brand.tsx` — 工具与模型品牌图标、Logo、快捷键 Kbd。
- `ui/shared.tsx` — 组件层共用的类型（Tone、Size、BaseProps）、`cx`、文案与余额档位上下文、`useReducedMotion`、可聚焦元素查找。

## styles/ 全局样式
- `styles/tokens.css` — 设计令牌：开头 `@import` 了 `ui-spec/tokens.css`（换它就是换界面），再叠组件材质；v4 没有皮肤，主窗口只按 `data-theme` 上色。
- `styles/components.css` — `ui/` 组件的样式（结构值取自原型，颜色与字号取自令牌），含 `data-window-idle` 下暂停循环动画。
- `styles/shell.css` — 外壳布局：标题栏并进 44 高的顶栏、侧栏 224（收起 60）、状态栏 28、正文最宽 1000 在侧栏右边居中，登录前几屏只留窗口条。
- `styles/contrast.css` — 高对比度：应用内高对比和 Windows 高对比度主题两套；在 main.tsx 里最后引、每条带 `:root`，才压得过业务样式。

## testing/ 与浏览器回归（`npm run test:v2:browser` 用 Playwright 串行起 Chromium；都经 `e2e/harness.mjs` 起本地 Vite、拦掉一切非回环请求，不碰生产服务）
- `testing/app-fixture.tsx` / `testing/app.html` — **整个 App 的浏览器夹具**：用 URL 参数造出各种主进程状态（账号恢复中、线路、公告、加速、外接客户端……）的假 `window.xingmang`，挂真的 `RendererV2App`；大多数 browser-check 开的都是它。
- `testing/app-check.mjs` — 最大的整页浏览器回归，Windows CI 按分片跑（`e2e/shard-tests.mjs`）。
- `testing/acceleration-fixture.ts` — 加速预览用的假接口：不开 socket、不改系统网络，偏好只活在这一次预览里。
- `testing/guest-workspace.mjs` — 回归用的步骤：不登录，走「先看看使用步骤」进未登录首页。
- `testing/usage-fixture.ts` — 用量明细假数据，只给 `usage-detail-view` 的单测用。
- `features/tools/account-bound-launch.browser-check.mjs` — 钉住「换账号后，上一个账号迟到的配置读取、模型核对、文件夹选择、桌面端状态都不能启动工具或弹框」，是渲染层防竞态的回归。
- `features/shell/keyboard.browser-check.mjs` — 键盘可达：跳过链接、侧栏与命令面板切页后的焦点落点、命令面板落到设置项、矮屏时「设置」钉住。
- `features/shell/announcement-persistence.browser-check.mjs` / `features/shell/newapi-announcements.browser-check.mjs` — 公告已读状态跨浏览器重启、跨 origin 迁到主进程不丢，以及 new-api 公告集合解析的身份、去重与畸形输入。
- `features/acceleration/browser-check.mjs` — 游戏加速卡的交互回归（冻结时钟下演免费时长）。
- `styles/contrast.browser-check.mjs` — 用 Chromium 的 forced-colors 模拟查高对比度样式；具体某个 Windows 主题长什么样仍要人工看。
- `features/auth/browser-check.mjs` / `features/auth/browser-fixture.tsx` / `features/auth/browser-fixture.html` — 登录、注册、找回、引导的浏览器回归与它的假接口（可模拟人机验证、状态读取失败、登录失败、两步验证）；部分用例改开整页夹具。
- `features/chat/browser-check.mjs` / `features/chat/browser-fixture.tsx` / `features/chat/browser-fixture.html` — 聊天页回归与夹具，用 IndexedDB 冒充主进程的记录文件（跨 reload 存活、没有 localStorage 配额限制）。
- `ui/browser-check.mjs` — 组件层交互检查，开的是 `gallery.html`。

## gallery 组件检阅
- `gallery.html` / `gallery-entry.tsx` / `gallery.tsx` / `gallery.css` — 本地组件检阅页（`?theme=light|dark`、`?os=win|mac` 切换），`ui/browser-check.mjs` 跑在它上面；vite 只打包根目录 `index.html`，它不进产品。

## 要点

- **入口链路**：根目录 `index.html` → `vite.config.ts` 的 `transformIndexHtml` 把 `/src/main.tsx` 换成 `/src/renderer-v2/main.tsx`（`XINGMANG_RENDERER` 不是 legacy 时）→ `main.tsx` 以 StrictMode 挂 `App.tsx` 的 `RendererV2App`。依据：`vite.config.ts`、`main.tsx`。
- **守这条边界的门禁**是 `scripts/verify-renderer-boundary.test.cjs`（随 `npm test` 的 test:scripts 跑）：`valueImportable` / `typeImportableOnly` 两张清单，清单外的 electron 模块、node 内置模块、`electron` 包一律红；renderer-v2 引 `src/` 下 legacy 文件也红；还会顺着清单里每个模块的值依赖一路查到底，确认没有 Node 依赖、走到的主进程模块也都在清单上（I6）；清单上的模块第一行都是同一句 `@renderer-importable` 标记，`electron/` 下有标记的和清单上的必须完全一致。它补的是 `vite.config.ts` 里 `generateBundle` 那道只在 `vite build` 时、只看 Rollup 留下的模块的检查。依据：两份文件的注释。
- **渲染层防竞态的写法**：v2 一处都没用 legacy 的 `src/scan-coordinator.ts`、`src/latest-request.ts`、`src/provider-extension-coordinator.ts`（门禁本来也禁止 v2 引 legacy 树）。实际用的是：① useRef 计数器——`business-common.tsx` 的 `useResource`（`sequence` 序号）、`App.tsx` 的 `accountEpoch` / `bootstrapEpoch` / `sessionEvents`、`features/tools/useToolbox.ts` 的 `request` / `externalRequest` / `configRevision` / `desktopRevision`；② effect 里的 `let current = true` 取消标记（如 `features/auth/LegalDocument.tsx`）；③ 纯控制器里的 revision / epoch（`platform-api.ts`、`features/acceleration/lines-controller.ts`、`features/shell/network-controller.ts`）；④ `features/tools/ttl-cache.ts` 作废时让在飞请求不写回；⑤ 账号作用域变了就按 scope 重建（聊天控制器）。回归由 `features/tools/account-bound-launch.browser-check.mjs` 钉住。AGENTS.md T6 点名的三个工具只适用于冻结的 legacy 树，总述里该改成指向这些写法。依据：上述文件。
- **两座桥、各功能自己包一层 api**：`window.xingmang`（`bridge.ts`，ipc-contract 的 `XingmangApi`）和 `window.xingmangPlatform`（`platform-api.ts`，平台层契约，只取类型）；IPC 调用按功能封在 `features/app/api.ts`、`features/auth/api.ts`、`features/chat/api.ts`、`features/tools/api.ts`、`features/acceleration/api.ts` 里，页面里另有直接用 bridge 的。依据：这几个 api.ts 与 `features/auth/README.md`。
- **账号 → 写 Key 是一条链**：`App.tsx` 调度 → `features/tools/account-bootstrap.ts`（登录/恢复/点名重写三档）→ `features/tools/source-marker.ts`（手选来源标记）、`features/tools/key-sync-failure.ts`（失败话术）、`features/tools/online-resync.ts`（网回来补跑）；切账号时另走 `account-switch-sync.ts` + `SavedAccounts.tsx`。AuthFlow 只管认证、不碰 Key。依据：各文件头注释与 `features/auth/README.md`。
- **余额是唯一的定时拉取**，公告轮询、订阅缓存、花费突增都搭它的车，断网判断也部分靠它：`features/app/balance-store.ts` → `balance-context.tsx` / `subscription-cache.ts` / `spend-spike.ts` / `features/shell/Announcement.tsx` / `features/shell/online-status.ts`。依据：`balance-store.ts`、`subscription-cache.ts`、`Announcement.tsx` 注释。
- **错误展示是一条链**：`business-common.tsx`（剥 IPC 前缀、路径脱敏、Key 打码，I13）→ `operation-error.ts`（归类）→ `registry/errors.ts`（文案）→ `features/app/OperationErrorDialog.tsx` + `features/app/SupportIdentity.tsx`（复制给客服）。依据：这几个文件的 import 与注释。
- **跨页落点统一是「模块里放一个待取槽」**：`features/app/settings-group-intent.ts`、`row-focus.ts`、`extension-tool-intent.ts`，以及 `update-retry.ts` 的安装确认请求；配合 App 「去过的页只藏不卸」使用。依据：这几个文件头注释。
- **本机存储**：localStorage 只放本机便利项，键名多用 `xingmang-ui-v2:` 前缀（引导进度、教程进度、首次命令卡、旧聊天记录、手选来源、头像、公告已读等），读写都包 try/catch（`features/app/preferences.ts` 及各模块自带的 storage 注入）；聊天记录与公告已读已迁到主进程，localStorage 只作迁移来源。依据：`features/chat/storage.ts`、`features/shell/newapi-announcements.ts`、`features/auth/guide-progress.ts`、`features/tutorial/tutorial-progress.ts`。
- **有意重复的字面量**：`features/tools/connection-check.ts` ↔ `electron/connection-check.ts`（层名）、`features/auth/account-errors.ts` ↔ legacy `src/components/account/account-errors.ts`、`business-common.tsx` ↔ legacy `src/error-message.ts`。理由都是 I6/I7（渲染层不能值引带 Node 依赖的模块、两棵树互不引用）。依据：各文件头注释。
- **下线的 Gemini 在界面层逐处过滤**，统一用 `electron/catalog` 的 `activeProviderIds` / `isActiveProviderId`：`features/tools/model.ts`、`features/tools/recent-workspaces.ts`、`features/settings/BackupCard.tsx`、`pages-account.tsx`、`features/tools/provider-options.ts`（记录页和扩展三页）、`features/auth/guide-progress.ts`、`registry/clients.ts`。依据：这些文件里的注释。
- **分号风格边界**：`ui/`、`registry/`、`gallery*.tsx` 带行尾分号，其余不带，由 `scripts/verify-renderer-style.test.cjs` 钉住（它的清单里点名了 `gallery.tsx`、`gallery-entry.tsx`）。依据：该脚本与 `.claude/rules/renderer-v2.md`。
- **`styles/tokens.css` 直接 `@import` 了 `ui-spec/tokens.css`**，改 ui-spec 的令牌就是改产品界面。依据：`styles/tokens.css` 第一行。
- **浏览器回归的夹具分三种**：整页夹具 `testing/app.html`（acceleration、shell 三个、tools、contrast、app-check、部分 auth 用例）、各功能自带夹具（auth、chat）、组件检阅页 `gallery.html`（ui）。`npm run check:v2` 另由 `e2e/renderer-v2-testid-inventory.cjs` 盘点 data-testid。依据：各 browser-check.mjs 里打开的路径、`package.json`。
