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
> **0.2.9 及更早的版本在 [`docs/archive/CHANGELOG-0.1-0.2.9.md`](docs/archive/CHANGELOG-0.1-0.2.9.md)**：
> 2026-10-27 挪出去的，这份文件当时超过 1MB，GitHub 网页上打开很慢。

## 0.2.25 - 2026-11-26

- `xingmang-asset://video/…` 的开放式 Range（`bytes=N-`）照旧回到文件结尾，去掉 #1631 加的每次最多回 8 MB
  （`maximumVideoRangeBytes`）。Electron 的播放器拿到截短的 206 不会再要下一截，大于 8 MB 的视频播到
  「8 MB ÷ 文件大小」那里就报解码错误停下（0.2.24 Mac 验收 B1，24 秒 21 MB 的片子停在 9 秒左右）。
  #1631 的另一半保留：仍然只从 N 读起、HEAD 和 416 不读视频字节，所以比 0.2.23 整份读进内存省。
  `ai-asset-protocol.test.ts` 换成三条「21 MB 视频从 0、100、9 MB 起的开放式 Range 回到结尾、只读要的那段」，旧代码上红。
- 补 #2139（打开前联网验证超时，`codexDesktopActivationOffline`）和 #2150（Windows 更新被关挡住首次启动，
  `codexDesktopWindowsUpdateBlocked`）给客户看的那一句，两个 PR 的分片当时只写了「## 开发」。
  文件名用 `002-` 开头：这是客户报过的问题，排在更新页前面。（yoyo「家庭版说明加」）
- 付过钱的图存不进作品库时，`AiUnsavedImageStash.keep` 收在哪（`disk` / `memory`）原样交回 `AiAssetStore`
  （`keepUnsaved` 从回 `boolean` 改成回 `AiImageKeptPlace | null`）：收在盘上照旧挂 `AI_IMAGE_KEPT_UNSAVED`，
  只留在内存里改挂新的 `AI_IMAGE_KEPT_IN_MEMORY`，`ai-image-service.ts` 据此换成 `aiImageKeptInMemoryMessage`，
  多说一句「一退出就没了，先别退出星芒」（11-18 复核 A02，0.2.25 总单第 61 项，yoyo 11-20 回「暂存改」）。
  以前两种都是同一句「已经先替你收着」，只在内存里的客户退出就丢了。新句子保留「先别重新生成」，对话页 `chatErrorMessage` 原样上屏，
  画布节点照旧显示主进程原话。收在盘上的那句一个字没动。
- 给客户看的那句并进了 `a02-unsaved-image-memory-warning.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- `electron/ai-unsaved-image-stash.ts` 的 `pendingUserIds` 分清「查过、确实没有」和「这次读不了」（11-18 复核 A05，0.2.25 总单第 62 项）：
  暂存文件夹不在才算没有；整个文件夹读不了（EPERM、EBUSY 这类）记 `unreadable`，某个账号的文件夹读不了就把这个账号算作还有。
  软件开着时的自动补存和登录时的 `flush` 都按它决定要不要隔一阵再试，间隔照旧 1、5、15、30 分钟、封顶 30 分钟；以前读不了一次就当空的，
  不再自己补存，要等下次登录或重开软件。
- `electron/ai-unsaved-image-stash.ts` 盘上的暂存上限（512 MB）改成整个暂存文件夹所有账号合起来算（11-18 复核 A06，0.2.25 总单第 63 项）：
  以前只数本账号那个 `user-<id>` 文件夹，几个账号共用一台电脑时能各存满一份，跟文件开头说的「总量上限」、跟内存那份（本来就是全部账号合计）对不上。
  补存仍只按各自的账号文件夹走，谁付的图只补存进谁的作品库。别的账号的文件夹读不了、说不清用了多少时，这一张不往盘上放、照旧先留在内存里。
  星芒账号和历史账号的数据文件夹各自一份暂存（内存那份上限也是各算各的），这次没合并。
- 0.2.25 总单第 68 项（11-18 复核 A07）：`electron/codex-payload-limit.ts` 的会话记录监听每 30 秒回头看一眼「10 分钟内写过」的记录，
  但 `processFile` 每读一次都把 `touchedAt` 记成现在，哪怕什么都没读到，不再写的记录永远算「最近写过」，星芒开着就一直每 30 秒
  打开一次、stat 一次（最多 32 个文件）。开销不大，但没必要。
- 现在 `TrackedRollout` 多记一个 `size`（上次读时文件多大），只有第一次见、变大、被截短重写才刷新 `touchedAt`。10 分钟没变的记录不再回头看；
  它再写的时候目录通知照样认，读到了又算最近写过、接着回头看。
- 用例：`electron/codex-payload-limit.test.ts` 补了「10 分钟没变就不再回头看，再写照样读到并接着回头看」一条，旧代码上红；`watcherHarness` 多一个可调的时钟。
- 「AI 作品」那一行以前只量当前站点的作品文件夹（A08，11-18 复核，0.2.25 总单第 64 项）：画布项目自己选的文件夹没算，
  星芒账号的那一层又套着历史账号的 `realms/api-account`，切到历史账号时合计就变小。现在量两个站点共用的那一层
  （`realm-data-roots.ts` 新增 `sharedAssetOutputDirectory`，是 `assetOutputDirectory` 的反函数），再加上这台电脑上两个站点、
  每个账号的画布项目文件夹里放作品的 `assets`（`canvas-project-store.ts` 新增 `listCanvasProjectAssetDirectories`，
  用 `async-map.ts` 限流读项目记录，不做 `list()` 那套同步的存在检查）。项目文件夹里客户自己的其他文件不算。
- 去重靠 `storage-usage-service.ts` 的 `outermostDirectories`：重复的、被别的套住的（项目文件夹选在作品文件夹里、两个账号
  共用一个文件夹）只算一遍，Windows 上不分大小写。作品文件夹量不出来照旧是「没算出来」；某个项目文件夹量不出来（盘拔了、
  不让读）当没有，日志只记几处没算上，不记路径（I13）。
- 「搬到新电脑」导入聊天时，同一个对话两边消息一样、只是文件里多了没发的草稿（旧电脑导出前又打了几句或加了文字文件），
  `features/chat/storage.ts` 的 `mergeImportedConversations` 以前按「两边一样」直接跳过，草稿过不来、还报「这台电脑上都有了」。
  现在这台电脑上这个对话的输入框空着（没打字、没图片、没文件）就把文件里的草稿和文字文件补进来，算一个「更新」；
  两边都打了留这台电脑上的；同一个文件再导一次不再变（11-18 复核 A09，0.2.25 总单第 66 项）。消息和其他字段都不动，
  图片照旧只在本机、导入时去掉（设置 X-6）。给客户的那句并进了 `data-transfer-works.md`（一版最多 60 条）。
- 首页 Antigravity 两张卡装好后中间那行（yoyo 2026-11-26 回「谷歌卡介绍改」，方案第 4 条）：`registry/tools.ts` 新加 `antigravityInstalledMeta`「打开时自动使用当前账号」，
  `Home.tsx` 的 `renderAntigravity` 装好时用它，没装时照旧用 `homeToolBlurbs`。同时把 `homeToolBlurbs` 里三句口语改书面（Claude Desktop、Antigravity、Grok CLI、Codex 桌面端四张卡）。
  v4 原型里那几句还是旧的，原型不动。
- Antigravity 命令行的存储桶同步每次都在最后写清单时失败（#2149）：`scripts/cos-sync-utils.cjs` 只许覆盖写一张固定名单上的清单，
  名单里没有 `xingmang/offline/antigravity-cli/windows.json`、`macos.json`，桶里一直没有清单，客户端只能去谷歌下。
  把这两份加进名单（名单改成 `OVERWRITABLE_POINTER_KEYS`），安装包照旧不可覆盖。`cos-sync-utils.test.cjs` 新加两条用例，
  找出所有带 `overwrite: true` 的同步脚本、用真的名单核它们的清单，以后新加同步作业漏了当场红。
- Antigravity 接中转第四步，客户端没改：新同步作业 `sync-antigravity-cli-cos`（每 6 小时，也可手动跑），把谷歌签名的
  agy 原件放进存储桶 `xingmang/offline/antigravity-cli/`，一键安装以后先从这里下。同一个作业在 Windows、Mac 机器上
  各跑一次，各写各的清单（`windows.json`、`macos.json`）：Windows 的核 Google LLC 的 Authenticode 签名（钉住
  DigiCert 签发机构）和 PE 头里的芯片，Mac 的解开 tar.gz 核谷歌的 Developer ID 签名（团队 EQHXZ8M8AV）和芯片；
  清单地址必须一字不差、下载按清单的 SHA-512 核，两种芯片版本对不上或比桶里旧时这一轮不发。不可覆盖、完整回读，
  清单留最近 4 版，连续两次定时失败开 issue。写法见 `docs/COS-SYNC.md`「Antigravity 命令行（agy）」。
- Antigravity 接中转第五步，界面还没接：新的 agy 安装器 `antigravity-cli-installer.ts`。先从存储桶下谷歌签名的原件
  （`antigravity-cli-bucket.ts` 读清单，最新一版里这台电脑那一个文件，来源必须是谷歌按版本拼出的原址），没走通再按
  谷歌清单从谷歌下；下回来先对摘要（桶的 SHA-256，再对谷歌清单的 SHA-512），再核谷歌签名：Windows 在
  `trusted-native-cli.ts` 里给 agy 加了一条，钉 Google LLC 和 DigiCert 签发机构（与同步脚本那份由测试逐条核对）；
  Mac 在 Node 里解 tar.gz、只写出唯一一个 `antigravity`，看 Mach-O 头的芯片，再问 codesign 是不是谷歌的 Developer ID。
  核过的才复制到 `%LOCALAPPDATA%\agy\bin\agy.exe` / `~/.local/bin/agy` 旁边、对 SHA-256、改名替换，那里原来是链接或
  文件夹就不动；Windows 把目录加在用户 PATH 最后，管理员身份打开的星芒不往用户文件夹里装。存储桶下载地址的白名单
  加上 `xingmang/offline/antigravity-cli/`。
- Antigravity 命令行「打开」时记住的项目文件夹已被删除或改名：以前主进程那句「项目文件夹不存在，请重新选择」直接进错误框，「重试」拿的还是那个不在的文件夹，怎么点都打不开。现在跟 Claude Code、Codex 那几张卡一样（`useToolLaunch` 的 `launchRemembered`）先提示「上次使用的目录已不存在，请重新选择。」再弹选择窗口，用选好的那个接着开（`antigravity.ts` 的 `openAntigravityCliIn`，认法同 `isMissingWorkspace`）；从选择窗口选好以后重读一次配置（`refreshSavedConfig`），首页手上记着的文件夹换成新选的，下次点「打开」直接进它，「选择其他文件夹…」选过的也一样。夹具加 `?antigravityWorkspaceGone`，`app-check.mjs` 加一条浏览器回归。
- 0.2.25 复查 A 第 1 轮第 2 条：Antigravity 桌面端以前只从谷歌下，国内多半装不上。照 agy 那一路加存储桶：新同步作业
  `sync-antigravity-desktop-cos`（每 6 小时，也可手动跑）在 Windows、Mac 机器上各跑一次，读谷歌给桌面端自己更新用的
  `latest-<x64|arm64>-<win|mac>.yml`，按其中的大小和 SHA-512 下原件，核过签名后放进 `xingmang/offline/antigravity-desktop/`，
  各写一份清单（`windows.json`、`macos.json`）：Windows 安装包核 Google LLC 的 Authenticode 签名（签发机构同 agy 钉住），
  Mac zip 解开核只有一个 `Antigravity.app`、bundle `com.google.antigravity`、版本号同清单、谷歌团队 EQHXZ8M8AV 的
  Developer ID、Gatekeeper 和芯片。两种芯片版本对不上、比桶里旧时这一轮不发；对象不可覆盖、完整回读；连续两次定时失败开 issue。
  两份清单加进 `cos-sync-utils.cjs` 的 `OVERWRITABLE_POINTER_KEYS`，脚本加进 #2154 那条逐个脚本核对名单的测试。
- 客户端两边都改成先从桶里下：Windows（`antigravity-desktop-windows.ts`）照旧核谷歌签名再运行，Mac 走
  `macos-desktop-app-installer.ts` 已有的桶那一路，按这台 Mac 的芯片挑包（Rosetta 下也拿 Apple 芯片那份）。清单超过 24 小时
  没和谷歌核对过时先问谷歌，谷歌不通再用桶里那份；桶不通、字节对不上、签名不对都改去谷歌，原因只进运行日志
  （`antigravity.desktop.bucket-fallback`）。`desktop-package-bucket.ts` 的地址白名单加了 `antigravity-desktop` 目录。
  Mac 上桶的包号原来按星芒自己的芯片挑，改成按 `context.architecture`，Codex、Claude、OpenCode 没开 `packageForHardware`，两者相同。
- Antigravity 接中转第六步，界面还没接：桌面端安装器。新的 `antigravity-desktop-release.ts` 读桌面端自己更新时读的
  `manifest/latest-<x64|arm64>-<win|mac>.yml`（逐行读，地址必须是按版本和构建号拼出的谷歌存储原址，大小、SHA-512 都要有）。
  Mac 上在 `macos-desktop-app-installer.ts` 的来源表里加 `antigravityDesktop`（zip、团队 EQHXZ8M8AV、bundle
  `com.google.antigravity`，照旧核 Developer ID 和公证）；Windows 上新的 `antigravity-desktop-windows.ts` 下谷歌签名的
  NSIS 安装包，对大小、SHA-512，按 agy 那条核谷歌签名，运行前再对一遍 SHA-256，静默装到
  `%LOCALAPPDATA%\Programs\antigravity`；管理员身份打开的星芒不装。还没有存储桶那一路。2026-11-23 在 GitHub 临时机器上核过
  2.34.0：两种 Windows 安装包都是 Google LLC / DigiCert G4 签的，开着时再装会先关掉它；两种 Mac zip 解开都过星芒那条签名要求和 Gatekeeper。
- Antigravity 的设置跟着当前账号和线路走（0.2.25 复查 A 第 1 轮第 3 条）。以前只在点「安装」「打开」时写，可设置写在用户环境变量（Mac 是终端启动文件读的那份）里，客户从开始菜单、自己开的终端打开也用它：换了账号照样扣上一个账号的钱，「自动」换了线路它还连旧线路。现在 `antigravity-service.ts` 加了 `follow`：换了人（`main.ts` 账号服务的 `onChanged`，含开机恢复，等安静期过了）、星芒账号换了工具线路、历史账号换了应用线路（`bootstrap/network-routes.ts` 的 `startToolRouteFollowing`）各回头看一眼。只跟星芒写的那份（地址认得出是中转某条线路的 Gemini 地址，`antigravityEnvironmentLine`），两样都没装、没登录、管理员身份打开的不读。密钥是当前账号缓存里 Gemini 那把、只差线路的，原样只换地址，不联网；密钥不是当前账号的，照点「打开」那样按自动签发那一档取一把重写（`registerAntigravityHandlers` 交来 `bindFollowKey`，撤通道时收回），没用过 Antigravity 的客户不会因此多签。「自动」线路还没定下来不挪。Mac 上后台改写跟打开桌面端一样不强求终端启动文件那一段（`startupFileOptional`，`writeOptionsFor` 按装的是哪样给），`~/.zprofile` 是链接的照样跟得上。跟不上只记 `antigravity.settings.follow-failed`，首页显示「待连接」，点「打开」时再写。首页「当前账号」连密钥一起比（`isAntigravityEnvironmentCurrent` 第三个参数，读的是 `readCurrentManagedCliKeys` 那份缓存，明文不出主进程）。Windows 上后台改写时桌面端开着（或看不出），之后点「打开」请客户先关掉，上次已经请过的没关之前也照样请（以前第二次点会把带旧设置的那一份叫到前面）。改完叫界面重读（`onToolRouteFollowed`），`useRelayRouteSync` 收到那声也重读两张卡。没加通道，没改界面文字。
- 复查 A 第 2 轮第 2 条（一）：Windows 上「Antigravity 正在运行，请先退出」以前靠一个记号：后台改写设置时开着就
  记上，只有星芒自己在它没开着时打开才清。客户自己关掉、从开始菜单重新打开的（资源管理器给的已经是新设置），再点
  「打开」照样被请关掉；装命令行、打开命令行时改了设置又不记。现在 `antigravity-service.ts` 哪一步写成都记下那一刻，打开前列出开着的那份每个进程的启动时间
  （进程探测脚本每项多一个 `started`，FILETIME 字符串，哈希表加 DateTime 自己的方法，受限语言模式也放行），起得比
  改写早（或读不出启动时间）的才请关掉；后台跟的那一轮不再为此多起一次 PowerShell。
  `e2e/windows-powershell-probes-smoke.mjs` 那条真开替身的检查跟着核启动时间，两种语言模式要一致。
- 复查 A 第 2 轮第 2 条（二）：换账号、换线路以后替 Antigravity 改完设置，以前借 `network:relay-route-changed` 叫
  界面，界面就把三个外部客户端重新检测一遍（卡片闪「检测中」）、再重读设置和配置。现在另发
  `antigravity:settings-followed`（主进程发给界面的事件，载荷为空，不是界面能调的通道），`useToolbox` 只重读
  Antigravity 两张卡。
- Antigravity 接中转第一步，只有主进程、不接界面：`electron/antigravity-gateway.ts` 算出它「企业网关」模式要的四个变量
  （地址只收中转线路的 https 裸域，型号菜单是密钥当时列出的全部型号、`gemini-3.8-flash` 排第一），
  `electron/antigravity-windows-environment.ts` 把它们写进 Windows 当前用户的环境变量（REG_SZ、不提权、没变就不写不通知）。
  两种 PowerShell 语言模式都在 `e2e/windows-powershell-probes-smoke.mjs` 里真跑对照注册表。
- Antigravity 接中转第八步：首页工具区加两张卡（`antigravityCli`、`antigravity`，排在 OpenAI 之后、xAI 之前，`registry/clients.ts` 的 `antigravityTools`）。只有「安装」「打开」两件事：安装进度走 `antigravity:install-progress`，装完那一句带上主进程没写成设置的原因；命令行在记住的项目文件夹里开，「…」里可选其他文件夹；桌面端开着拿不到新设置时（`closeFirst`）请客户先退出。检测结果放在 `useToolbox` 的 `antigravity`，首屏扫描后、点「重新检测」、装完和打开后各读一次，这台电脑用不了（Linux）时不摆这两张卡。图标照 @lobehub/icons 5.18.0 的 Antigravity 原色标抄进 `vendor-icons.tsx`。主进程 Antigravity 这几步的报错统一改成正式说法：网址、校验码、HTTP 状态这类细节只留在错误的 cause 里（运行日志照记），客户看到的是一句能照着做的话；超时单独说「请检查网络后重试」；带「环境变量」「中转」的四句换成不带技术词的说法。
- 复查 A 第 2 轮第 1 条：换账号时 Antigravity 后台跟的那一步签 Gemini 那把、存进本机密钥缓存，跟登录那一轮
  `account:sync-managed-cli-keys` 同时跑。缓存的版本号整份文件一个，登录那一轮开头记下、签完三把才存，中间被
  Antigravity 存过一次就被拒：首页冒「本机加密缓存：本地密钥缓存已被其他操作更新」，签好的三把没存下，下次开机重签。
  `account-cli-provisioner.ts` 加 `withKeyCacheTurn`：同一份缓存、同一个账号「读缓存、签、存回去」这一整段排队，
  `resolveManagedCliKeys` 和 `resolveAntigravityManagedKey` 都走它；按账号排，换走了的账号没跑完的那段不挡新账号，
  前面没人时当场开始。顺带：跟的那一步和客户点「打开」撞上也只签一把。`cacheReplacementKey` 以前不看保存结果，
  被拒时按最新那份再存一次（只换自己那一格）。
- 复查 A 第 1 轮第 4 条：Mac 上 `~/.zprofile`（或 bash 读的那个启动文件）是 dotfiles 的链接、有硬链接时，Antigravity 桌面端打不开，
  安装桌面端也报「设置没写成」。原因是打开、安装桌面端前写设置那一步一律要求在启动文件末尾加上那一段，写不进（I8 拒绝跟随链接）就整步失败，
  可桌面端的设置是由打开的那一步直接放进它的环境里的，用不上那个文件。
  `writeMacosAntigravityEnvironment` 新加可选的 `startupFileOptional`（缺省照旧失败）：设上时启动文件写不进只交给 `skipped`、
  结果标 `profile: 'skipped'`，两份设置文件照写，链接和它指向的文件都不动；`antigravity-service.ts` 为桌面端写设置时设上，
  日志事件 `antigravity.settings.fish-skipped` 改名 `antigravity.settings.profile-skipped`（现在两种文件都走它）。
  命令行照旧要求那一段（Mac 的「终端」从那里读设置），没有跟随链接、也没放宽 I8。
- Antigravity 接中转第二步，仍只有主进程：`electron/antigravity-macos-environment.ts` 在 Mac 上把四个网关变量写进产品目录里
  只有本人能读的 `gateway.sh` / `gateway.fish`，登录 shell 的启动文件末尾追加一段读它的标记，密钥不进 `~/.zprofile`；
  同一段把 agy 的位置 `$HOME/.local/bin` 加在 PATH 最后（不跑 `agy install`，它会把目录插到最前面）；
  zsh、bash、fish 都在测试里真开登录 shell 核对。`macos-shell-profile.ts` 导出了挑启动文件要用的几个判断，行为不变；
  两边共用的结果类型和「整份才写」的检查挪进 `antigravity-gateway.ts`。
- `electron/antigravity-cli-release.ts`：读 agy 官方版本清单（平台、版本号、构建号、下载地址、SHA-512），地址必须与按版本拼出的谷歌存储地址一字不差，供下一步的安装用。
- Antigravity 接中转第三步，仍只有主进程：`account-cli-provisioner.ts` 加了 `resolveAntigravityManagedKey`，
  给 Antigravity 拿 Gemini 分组的密钥和它此刻能用的型号。和下线的 Gemini CLI 是同一把（同名、同组、缓存里同一格），
  老客户签过的接着用；只在点 Antigravity 时才签，登录那一轮照旧不签。失效重签、额度用完不重签、换组照抄限制的规矩
  和 `configureManagedClis` 一致；账号里认不出 Gemini 分组、分组被拒又没有别的、列不出型号时，报
  「服务暂时不可用」（`AntigravityServiceUnavailableError`，yoyo 11-23 定历史账号也照这一套）。
  缓存里哪几把能直接用的判断抽成了 `usableCachedKeys`，行为不变。
- Antigravity 接中转第七步：主进程接线（`antigravity-service.ts`，门面上是 `SystemService.antigravity`）。检测命令行和桌面端装没装、设置是不是当前账号这条线路的；一键装以后按需签 Gemini 分组的密钥写设置；带着设置打开桌面端（Windows 交给资源管理器、按 yoyo 11-23 打字同意的「Antigravity 免核签名」不核程序签名，安装包照核；Mac 核谷歌签名后起主程序，设置只放在环境里）和命令行（核谷歌签名后在选的文件夹开终端）。开着的桌面端拿不到这次的设置时不打开，回 `closeFirst`。新加 4 条主窗口通道 `antigravity:inspect` / `antigravity:install` / `antigravity:open-desktop` / `antigravity:open-cli` 和进度事件 `antigravity:install-progress`（入参只有 `cli` / `desktop` 和项目文件夹，密钥不过通道），两条打开是 scoped-queued；远程开关加 `antigravityCli`、`antigravityDesktop` 两样。Windows 上「开没开着」那一问在受限语言模式（开着应用控制策略）下也能跑、路径里的中文读得回来，Windows 冒烟加了一条两种模式对照。界面还没接，下一步做。
- Antigravity 桌面端中文界面（#2210，yoyo 11-27「全补进」赶进 0.2.25；yoyo 2026-11-26 亲手打「反重力调试口同意」「反重力默认中文」，深度）：
  随包带上开源插件 yuhuan-dev/antigravity-usage-monitor v1.5.6 的简体中文词表（`bundled-catalog/antigravity-zh-CN/`，
  GPL-3.0，原样不改，许可原文和来源同目录，也进了第三方许可清单），加星芒自己写的换字脚本
  （`electron/antigravity-desktop-chinese.ts`），只改界面文字和提示文字，客户和 AI 写的内容、代码、终端、图标字体不碰。
  插件本身不装、代码不用：它的更新不核签名、会改快捷方式和注册表，2026-11-26 读码评估过。
- Mac 上星芒起 Antigravity 时加 `--remote-debugging-port=<本机空口>`，用 lsof 核对口上在听的全是刚起的进程、只听本机，
  再经浏览器级 CDP 连接往它自己的界面页面挂新文档脚本并换当前页（`electron/antigravity-desktop-cdp.ts`）。连接一直挂着，
  刷新和新窗口接着换；没换成照旧英文、只记日志，不加界面文字。Windows 上经资源管理器打开带不上参数，这一半没接。
- 跟首页加 Antigravity 两张卡同一件事：客户那句并进本版「首页新增 Antigravity 命令行和 Antigravity 桌面端……」，更新页仍是 60 句。
- `backups.test.ts`「restores the oldest backup even when pruning runs at the retention limit」占满 200 份配额时，
  只整份复制要恢复的那一份，其余 199 份建空文件夹（prune 只按文件夹名数配额），再断言第二旧的那份被清掉。
  以前 200 份都整份复制，Windows runner 上这一段偶尔慢十几倍，11-22 在 main 上撞了 30 秒（#2084）。
  只改用例，产品代码没动。
- 余额 store 在快照里记 `reads`（读到过几次，只增不减），`subscribeBalanceReads` 认次数不认 `updatedAt`：
  前后两次读落在同一毫秒时，跟着余额顺带重读用量、订阅、近 7 天的地方以前会漏掉一次。
  `balance-store.test.ts`「tells read listeners once per landed read…」在 linux-test 上偶发红就是这个
  （#1994、#2062 各一次），现在那组用例把 `now` 钉成常数，旧写法每次都红。
- 0.2.25 总单第 17 项后一半（全面检查 I-1，Linux 沙箱实测 10-31 问题 B）：登录、开机、装完工具那一轮替某个工具写密钥没写成，
  首页黄条（`home-bootstrap-result`）和引导第 3 步挂着那一条；客户点「确认连接」→「保存并检测」→「完成」连好以后，
  `useAccountBootstrap` 里那份结果没人动，黄条一直挂到重开软件，标题下面却已经写着「都配好了」。
- 新增纯函数 `settleBootstrapToolFailure`（`features/tools/account-bootstrap.ts`）：只拿掉这一家的 `failed` 和
  `keyChangeFailed`，别家的照留；拿掉以后没写成的、要留意的都不剩时 `networkBlocked` 一起收起。`useAccountBootstrap`
  给出 `settleToolKeyFailure`，`useToolAccountActions` 在三处成功以后叫它：配置窗口写进密钥且读回成功
  （`confirmToolKeyWritten`，只留着原来那把 Key 的保存不走这里）、首页「改用当前账号 / 切回官方账号」、「立即修复」。
- 用例：`app-check.mjs` 照真机那条路点一遍（旧代码上红：黄条还在）；`account-bootstrap.test.ts` 钉住只拿掉这一家、
  没东西可拿时原样交回、网络那句什么时候收什么时候留。
- 给客户看的那句和前一半（新装 Grok 自动连上）并在 `grok-installer-config-counts-as-blank.md` 里。
- 画布宿主新开通道 `canvas-host:close-project`（`canvas-contract.ts`、`canvas-preload.ts`、`canvas-window.ts` 三处一起加）：内核回到项目中心、存完最后一次时调一次，只带项目标识；主进程只清这个窗口记着的、正是当前账号这个项目的那条「开着的项目」，别的回 `false`。之前回到项目中心不清这条，主窗口「看做过的图」叫出来的项目中心素材库照旧按刚离开的项目列素材（Mac 验收 R3，0.2.25 总单第 8 项）。投毒审计：画布拿它只能让主进程忘掉自己开着的项目，之后项目里的素材、运行、保存都要重新打开项目；没开项目时那份只读图片本来就能看，没有多给能力。
- 内核这一半是 xingmang-canvas #48（宿主桥可选方法 `closeProject`，已合 741e28a），要等 xingmang-canvas 打出下一个内核 tag、同步进 `canvas-v2/` 以后客户才看得到变化；老内核不调这个通道，行为跟原来一样。
- 客户那句「画布「导出项目」先弹出保存位置，图多的项目不用再干等。」原样并进 `canvas-kernel-v0-1-16.md` 的同一条（同是 #1368 第 14 条），给 0.2.25 的 60 条上限腾位置。
- #1368 第 14 条（总单第五节 Q6 复核，kernel-v0.1.13 上还在）：`canvas-window.ts` 的 `canvas-host:export-project` 原来先把项目里的图全读进内存、打成包才弹保存框，
  图多的项目点了「导出」要等一会儿才有反应，点取消也白读一遍。改成解析工作流后先弹保存框，选好位置再读图、打包、原子写入；取消时一张图都不读。
  素材缺失、超 96 MB 这类错误现在在选完位置之后报，写盘之前照样拦住。没有新开或改动通道。
- `canvas-window.test.ts` 补一条：取消时不读图，确认后先弹框再读图、写出的包里带着那张图。旧代码上是红的。
- 画布内核同步到 xingmang-canvas kernel-v0.1.12（359b988，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），带进三项：
  - xc #48：回到项目中心时调宿主桥 `closeProject`，桌面 #1945 的 `canvas-host:close-project` 从这一版起才有人调（Mac 验收 R3，总单第 8 项）；
  - xc #49：认出图型号属于哪一家（`runtime/image-model-family.ts`，规则照桌面 `resolveAiModelCapability`），图片分组里有的新型号能选、不再混进文字下拉，新项目默认型号不变（总单第 10 项）；
  - xc #50：旧工程存的 `settings.strategy: 'all'` 按 `{ version: 1, strategy: 'all' }` 运行，别的旧路由说明改成「旧配置：每种素材只交出一个」（桌面审查 D06，总单第 46 项）。
- 桌面放出路由策略（yoyo 11-20 在线程卡片上选「放出两种选法」）：`canvas-contract.ts` 与 `canvas-preload.ts` 两份 `features.routerStrategy` 改成 `true`。内核从这一版起给新建路由带 `{ version: 1, strategy: 'first-available' }`，文字只交第一段不空的（以前桌面路由把全部文字拼起来）；节点和检查器显示选法、说明和「执行范围」提示。
- `canvas-request-parser.ts`：`routerStrategy` 无论开没开都按内核的格式核对（版本 1，`first-available` / `all`，多一个字段就拒）；开了只留在路由节点上，别的节点带它照旧在付费前挡下。
- `canvas-node-executors.ts`：路由节点有了自己的执行器。带策略时按内核 `selectCanvasRouterInputs` 选：「保留全部输入」文字按连线顺序全部拼起来、素材按 `assetId` 去重全部交出；「每种媒体保留首个输入」取第一段不空的文字和图片、视频、音频各第一个。没有策略的老路由照旧走原来的 `passThrough`。
- `canvas-run-engine.ts`：从带策略的路由节点连出去的单图连线，按端口的类型交出（`out:image` / `out:video` / `out:audio`），「保留全部输入」交出这种类型的全部，每个按它在这条线上的位置记 `outputIndex`（角色、平铺照这个认）；文字只从 `out:text` 那条线交出，不再跟着图片线再来一遍。路由节点自己收到的文字另按连线记一份 `texts` 给执行器挑。下游指纹按实际交出的一个或全部素材算；没有策略的老路由节点和别的节点，交法和指纹都不变。旧工程「保留全部输入」下游的节点因为收到的图变了，第一次运行会重新生成。
- `canvas-fingerprint.ts`：指纹加上 `routerStrategy`，只有带策略的路由节点有它，原来的节点指纹不变。
- 画布内核同步到 xingmang-canvas kernel-v0.1.13（ece6fcf，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），带进 0.2.25 总单第 54~59 项六个 PR，桌面主进程都不用跟着改：
  - xc #51（总单第 54 项，Mac 验收 R12）：运行前检查里没提示词、前面节点跳过、宿主不支持前面的节点、图片编辑没连图四句原因和两个范围说明，以及同一句话的运行菜单、选中工具条说明，把「上游」换成「前面连着的节点」这类说法；`reasonCode` 不变。
  - xc #52（总单第 55 项，Mac 验收 R13）：`image-tools/image-mask-workflow.ts` 的 `imageMaskConfigurationError` 原来把没连图、连了两张或整组、原图换了合成一句「原图已变化或不是唯一单图，请重新核对蒙版」，主进程 `ai-image-service.ts` 的「局部修改只能用一张原图」被内核先拦下走不到。拆成三句，连两张或整组那句跟主进程逐字一样；拦的条件不变。
  - xc #53（总单第 56 项，Mac 验收 R14）：内核 `imageMaskConfigurationError` 拦不支持蒙版的模型时少了「；不会改为整图生成」，整句提成 `image-edit-mask.ts` 的 `imageEditMaskUnsupportedModelMessage`，跟 `assertImageEditMaskInput` 共用。
  - xc #54（总单第 57 项，Mac 验收 R15）：运行前检查给 `cachedNodeIds` 里照常执行的付费节点标 `keptResult`、算 `keptResultRequestCount`，确认框那段话由 `canvasRunPaidNotice` 拼；上限 `paidRequestCount`、`cacheHitCount`、报价都不变（桌面证明不了指纹时照样重新生成，靠的就是确认框写了上限）。
  - xc #55（总单第 59 项，11-18 复核 A04）：`validateAccountAssetPage` 不再把落在总数后面的空页当坏回包，`AccountAssetLibrary` 退回最后一页那段才走得到；退回哪页提成纯函数 `accountAssetStepBackOffset`。主进程 `listOwnedPage` 越界本来就回空页。
  - xc #56（总单第 58 项，Mac 验收 R16）：归档框打开时把焦点交给「确认归档」，处理失败回来时再放回去；改名、复制框照旧由输入框拿焦点。
- 画布内核同步到 xingmang-canvas kernel-v0.1.16（375da9f，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），带进三个 PR，桌面主进程都不用跟着改：
  - xc #59（0.2.25 总单第 10 项后半，yoyo 回「换默认」）：`imageModelPresets` 次序改成 2.6 Flare(推荐) → 2.5 Flare → GPT Image 2 → 2.6 Sunburst → 2.5 Sunburst，账号图片分组里有 2.6 Flare 的新项目默认用它，跟桌面 AI 对话、星芒AI画图（#1803）一样；`defaultImageModel` 不变，已有项目选好的型号不变。
  - xc #58（#1368 第 5 条）：`canvasRenderedEdges` 连线没变就交回原对象和原数组，拖动时 React Flow 不再每帧整份替换连线库；运行按钮旁的预检没有在读的来源就不跑。300 个节点拖动每步脚本 42～52 毫秒降到 30～37 毫秒，行为不变。
  - xc #60（#1368 第 14 条）：素材菜单打不开（素材已删、换了账号）时底部提示原因；`editor/workflow-file-notices.ts` 保存、导出带视频音频的工作流时照实说视频音频不在文件里。导出先弹保存框是主进程那一半，在 #2038。
- v0.1.14～v0.1.16 三个 tag 都是 xingmang-canvas 新加的「Kernel tag」工作流（xc #57）在内核改动合进 main 后自动打的，不再请人去网页建；AGENTS.md T13 补了一句。
- 客户那句 yoyo 2026-11-23 回「名字说明加」定的字。
- 画布内核同步到 xingmang-canvas kernel-v0.1.17（4261424，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），只带进 xc #61（#1368 第 4 条小尾巴，yoyo 2026-11-22 亲手打字同意「我同意画布节点名、分组名、风格开头是网址或路径时也照原样保存」）：
  - 节点名（任何已知节点的根 `settings.title`，分组名也是它）和漫剧圣经的「风格」（`drama-bible` 根 `settings.stylePrompt`）以前保存、重开时被内核两道检查悄悄丢掉：开头像网址、路径或「英文加冒号」（如 `Step1:`），或中间带 `https://`、`D:\`、`/Users/` 的都存不住，重开变回默认名。现在 `workflow-schema.ts` 和 `workflow-sanitizer.ts` 都经 `isLabelSetting` 只对这三项免掉「像不像位置」这一条。
- 主进程 `electron/canvas-project-package.ts` 同一道检查一起放宽，否则内核不再丢这些名字后，自动保存会整份报「画布项目节点设置不安全」：`validateNodeSettings` 改成逐个根键过 `validateRootSetting`，便签正文照旧，根 `title`（任何节点）和 `drama-bible` 的根 `stylePrompt` 只留 1 万字上限，其余键、嵌套设置、别的节点上的 `stylePrompt` 照旧查位置，敏感键名照旧拒。
- `electron/canvas-project-package.test.ts` 补三项各种开头都能存、上限和其余键照旧（旧代码上红），末尾加 `… with random inputs` 一节：任意节点类型的名字都收，除这三项和便签正文外任何根键上像位置的字都拒，嵌套在这几个键下面的照旧拒。
- 画布内核同步到 xingmang-canvas kernel-v0.1.18（cf72fc1，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），只带进 xc #62：「减少动画」的两条全局规则（`theme/brand-appearance.css` 的 `[data-reduced-motion='true'] *`、`theme.css` 的 `@media (prefers-reduced-motion: reduce)`）从 `transition-duration: 0.01ms !important` 改成 `transition: none !important`。原来的写法因为 `transition-property` 默认是 `all`，给每个元素的每个属性都开了一段过渡：换一次皮肤 250~350 段一起跑，两三帧后才收完；平移时 `.react-flow__viewport` 的位置也晚两帧左右。客户开了主窗口的「减少动画」或系统里关了动画才会碰到，晚的这两帧肉眼看不太出来，所以不写进更新说明。
- `e2e/canvas-close-interactions.test.mjs`「canvas applies four skins…」时红时绿的根因就是这个（`docs/CI-RERUN-LEDGER.md` 11-20 #2000、11-21 #1936 两行）：换完皮肤立刻比两层底色，平时两层一样旧所以相等，偶尔一层的过渡先收完就红。用例没改，修好后换完皮肤同一刻读到的就是新底色。查法和写法记进 `docs/TEST-BASELINE.md`「画布换皮肤那条」。内核新加的 `theme/reduced-motion.test.ts` 随同步进 `canvas-v2/src/theme/`，在 vitest 的 canvas 项目里跑。
- #1103：画布窗口有了自己的「中性灰工作台」配色，产品负责人在三套候选截图里选定。`src/renderer-v2/styles/tokens.css` 加 `:root[data-host="desktop"][data-theme="light|dark"]` 两段（只有画布窗口的 `<html>` 带 `data-host`，内核 `canvas-theme.ts` 的 `applyCanvasHost` 设的，主窗口不受影响），比 v3.1 皮肤规则多一级选择器，内核按深浅色标的 dawn / obsidian 都被盖住；按钮和强调色沿用主窗口两套。`electron/canvas-window.ts` 里画布绘制前的窗口底色跟着换成 `#e7e8eb` / `#1f2023`。`contrast-tokens.test.ts` 把画布两套也按默认主题那组对比度核（文字 4.5:1、输入框和次要按钮边 3:1），因此把输入框和次要按钮的边从 .52 / .38 加深到 .58 / .42。canvas-v2 不动。
- 不写给客户看的更新说明（产品负责人 2026-11-22 回「不写说明」），只换颜色。
- 画布崩溃或卡死后重新加载（自动重载、「界面没有响应」里点重新加载、再点「打开画布」时重载），换上来的是停在项目中心的新页面，
  但 `canvas-window.ts` 的 `activeProjects` 按窗口的 webContents 记着、重载不换编号，旧页面开着的项目一直留着；
  `projectCenterAssetLibrary` 还当项目开着，主窗口「看做过的图」叫出来的素材库列的是旧项目的素材（#1945 回到项目中心那一半的同类问题）。
  现在画布窗口每换上一张新页面（`did-navigate`，同一页面里换路由不算）就清掉这个窗口记着的项目；打开、新建项目要等读盘或选文件夹，
  这中间换了页面的，结果不再记到新页面头上（`rememberOpenProject` 比对页面计数）。没有新开通道，用的是 #1945 那套「清掉这一条」。
  不用 `did-start-loading`：它在跳转刚开始（以及子框架加载）时就来，那时开着项目的旧页面可能还留着，清了它的自动保存就会被拒。
- 原来给客户看的那一句（「看做过的图」不再列出之前那个项目的图片）随融合第 3 步撤了：主窗口那颗「看做过的图」按钮换成了「创作」左下角的作品库，
  不再去开画布窗口的素材库，客户碰不到这个问题了（见 `create-library.md`）。修复本身照留。
- 给客户看的那句并进了 `canvas-kernel-v0-1-17.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 11-18 复核 U02（0.2.25 总单第二档第 31 项）：更新页「重启并安装」、托盘、跳框「现在安装」、打开时装、闲时装都走 `main.ts` 的
  `updateQuitHandoff.prepare`，它在拉起安装程序前调 `canvasController.dispose()`：置 `disposed`、拆掉全部画布宿主通道。
  安装程序没起来（Windows 授权窗口点了「否」、安装包不在了、Mac 安装器交接失败）时 `abort` 只放回了窗口生命周期，
  画布宿主一直是拆掉的，再点「打开画布」只报「画布宿主已关闭」，要重启星芒才好。
  现在 `prepare` 改调新加的 `suspendForQuit()`：照旧不经关闭确认直接销毁画布窗口、不再拦安装程序发起的退出，但通道留着；
  `abort` 调 `resumeAfterAbortedQuit()` 放回来，画布照常能开。真退出时 will-quit 里的 `dispose()` 照旧拆。
  没有新增通道，没动退出时装（Mac）那条：那条装没装上都会退出。
- 0.2.24 Mac 验收 R6（0.2.25 总单第一档第 7 项）：设置页「导出聊天记录和设置」读的是存到本机的那份，
  `features/chat/transfer.ts` 的 `exportChat` 以前只等正在写的那次（`settleHistoryWrites`），聊天页的自动保存最多还要晚 2 秒，
  刚说完的那组问答不在文件里。现在先调退出前那套 `flushChatHistory`，让开着的聊天页马上存一次再读盘；存失败不拦导出，照旧导出存着的那份。
- 给客户看的那句并进了 `chat-export-flush-first.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 聊天自动起的对话名改成先打码再截 32 个字（`features/chat/state.ts` 的 `autoConversationTitle`，发第一句、只带文件、
  「新对话」时把没发的草稿存成一段，三处都走它）。以前先截再打码，密钥正好跨在第 32 个字上时截下的半截认不出是密钥，
  存盘和导出都留着；列表里现在看到的名字跟存下来的一样，是打过码的。
- 「导出这段对话」的文件第一行和保存框里建议的文件名，也过一遍 `redactPersistentChatText`（`storage.ts` 新加
  `conversationExport`）。以前对话名原样写出去，自己改的名字、导进来的对话名夹着密钥时会带出去。Mac 验收 R5（0.2.25 总单第 6 项）。
- CI 里真开的星芒不再连正式环境：服务端 11-21 核对装机量，一天里有 275 台「Linux 电脑」只请求 xm.solov.cc 的
  `/api/status`，来源全是 GitHub Actions，就是 quality 的 linux-package 装好 deb 以后真开的那两步；Windows、Mac 作业里
  没挡网的真开（renderer-v2-native、装好的包冒烟、macOS 发版演练）也一样。新加 `scripts/ci-block-production-hosts.cjs`：
  从客户端源码里找出 `solov.cc`、`shenfengwl.fun` 下面的全部域名（账号站、两条线路、更新目录等 10 个），在 runner 的 hosts
  里指回本机，再逐个解析确认生效才往下跑。quality 的 windows-package、macos-test、macos-release-rehearsal、macos-intel、
  linux-package 和 package-for-testing 的 macos-package、linux-package 都在真开之前跑它；
  `scripts/ci-block-production-hosts.test.cjs` 扫全部工作流，真开星芒的作业没先跑它就红，例外（旧版升新版冒烟自己断网；
  发版那几个作业要先读线上更新目录）各写了原因。
- 兜底：`CI=true` 时客户端把 `app.userAgentFallback` 末尾加上「 ci」（`electron/ci-user-agent.ts`，口径同每天打卡、版本上报、
  错误报告），所有会话的请求都带它，服务端和 update-feed-stats 认这个后缀就能剔掉漏网的 CI 请求。客户电脑上不变。
- `windows-package` 里「Run the PowerShell probes against this runner once」挪回「Walk every page of the real
  client」之前（#2041）。#1887 把真开客户端走页面那步放到它前面以后，客户端一退出，接下来一两分钟里加载
  Appx 模块的探测会被堵住：约束模式的 Codex 那条约一半运行超过 10 秒，两次跑满 90 秒被掐（#1897、#2000），
  中间不碰 Appx 的探测照常半秒；#1887 之前抽查的 16 次全是 6~8 秒。`scripts/ci-workflow-config.test.cjs`
  钉住先后顺序；那条用例现在每段打出自己的用时，哪段失败或被掐就报哪段，被掐时附上它已经打印的输出。
- 新同步作业 `sync-claude-components-cos`（每 6 小时，也可手动跑）：把 Claude Desktop 的 Cowork 工作区（四个平台）
  和 Mac 上的 Claude Code 程序包从 downloads.claude.ai 原样搬进存储桶 `xingmang/offline/claude-components/`。
  Windows 工作区读 Windows 商店版 x64 安装包里的清单，Mac 工作区和 Mac 程序读 Mac 通用版 zip 里的清单（两边版本
  不同步，11-19 是 5.11492.5 和 6.6395.1）；大小和 SHA-256 对上清单才传，不可覆盖、完整回读、HEAD 复核，连续两次
  定时失败开 issue。读清单和算桶里位置的代码在 `electron/claude-desktop-component-manifest.ts`（读 asar 的几个工具
  跟 `claude-desktop-code-seed.ts` 共用）、`claude-desktop-component-keys.ts`，客户端以后用同一份。客户端去桶里取、
  放进 Claude 文件夹的那部分见 `claude-desktop-workspace-seed.md`。
- Claude 桌面端组件同步（`sync-claude-components-cos`）1 MiB 及以上的文件都改走分块并行上传，不再等通用的 16 MiB 起点（#2069）。
  11-21 两次定时同步里 GitHub 的机器往上海一条连接只有 10~18 KB/s，约 15 MB 的 `vmlinuz.zst` 一次性 PUT 要 14~20 分钟，
  COS 回 HTTP 400 或等不到回应，Windows 工作区两部分连着红；`createCosStore` 加可选的 `multipartMinBytes`（只能调低，缺省照旧 16 MiB），
  别的同步不受影响。
- Windows 上从星芒点「打开」Claude Desktop 之前，先替它把聊天要用的 Claude Code 程序放好
  （`electron/claude-desktop-code-seed.ts`）。Claude Desktop 把要用的 Claude Code 版本和
  `.zst` 校验值编在自己的 `app.asar` 里，启动时只认 `Claude-3p\claude-code\<版本>\<校验值前12位>\claude.exe`
  在、旁边的 `.verified` 等于校验值；以前它只能自己从 Claude 官网下，加速下线后国内下不动。
  现在只读解析 `app.asar`（Chromium Pickle 头 + `.vite/build/*.js`，有界读、总扫描 96MB 封顶）拿到版本，
  从国内 npm 镜像下 `@anthropic-ai/claude-code-win32-<arch>` 同一版本的包，按 npm 官方源的
  `dist.integrity`（SHA-512）对账，流式解 gzip + 自写 tar 解析（pax、GNU 长名、校验和、解压上限）
  取出 `package/claude.exe`，临时名写入、改名就位，最后写 `.verified`。镜像对不上换官方源；
  都不行、读不到版本、磁盘不够 1GB、超过 15 分钟、Claude Desktop 正开着或中途被打开，一律跳过、照常打开，只记日志。
- 只在同用户执行模式下做（`trusted-only` 跳过），挂在 `external-client-runtime.ts` 的 `launch` 里、
  跟「打开」同一把锁（I11 已登记例外，范围没扩）；下载地址只放行 `registry.npmmirror.com`、
  `cdn.npmmirror.com`、`registry.npmjs.org` 上这个包这一版的固定路径（I10），写盘走 `safe-local-data`（I8），
  日志路径过 `redactHomeDirectory`（I13）。远程开关 `featuresOff` 加了 `claude-desktop-code-seed`，能单独关掉。
- 下载那段时间首页工具行写「正在替 Claude Desktop 准备聊天要用的程序（35%），好了马上打开」：新事件通道
  `external-clients:launch-progress`（`ipc-contract.ts` / `preload.ts` / `ipc/handlers/external-clients.ts`，
  只发给点了「打开」的那个窗口，百分比没变不发）；Windows 上 Claude Desktop 配置框顶上那句改成星芒会先放好程序、
  只有 Cowork 工作区还要连官网。三句字 yoyo 11-04 回「放程序字改」。
- Windows 上开着 UAC 时右键「以管理员身份运行」星芒（`trusted-only`），点「打开」Claude Desktop 前有意不替它放
  Claude Code 程序（#1932 的 `not-same-user`，I8：普通权限的程序也能改那个文件夹）。以前什么都不说，客户只看到
  Claude 一直转圈；现在打开以后首页弹一句「星芒现在是以管理员身份打开的，没法替 Claude Desktop 准备程序。关掉星芒、
  直接双击打开，再点「打开」。」（yoyo 11-19 回「提示改」，不放开写入）。
- 通道 `external-clients:launch` 的返回值从 `void` 改成 `ExternalClientLaunchResult`（`external-client-contract.ts`，
  只带原因 `preparationSkipped: 'elevated'`，字由界面 `launch-notice.ts` 的 `externalLaunchWarning` 拼）；没加通道。
  放程序那一步「远程关了」「Claude 开着」两条判断挪到管理员身份判断之前，免得本来就不该放的也提醒；两条都不碰文件，
  管理员身份下照旧不读、不写 Claude 的文件夹。
- 工具配置框和外部客户端弹窗（Claude Desktop / WorkBuddy / OpenCode）的密钥下拉，以及登录、装好后替外部客户端自动连，
  都按账号现在能用的分组筛（已有通道 `account:list-groups`，即 `/api/user/self/groups`）：分组不在里面的不列、不挑，
  空分组照列，`auto` 只有列出来才算；读不到分组时照旧（只去掉 xm 站删掉的老名字）。工具配置框里正选着的那把照列。
  以前两个下拉只看启用状态，8 月 AI 对话在 Claude-ANTI 等分组签的密钥，分组删了还摆着，一检测就 403「无权访问 … 分组」
  （服务端 11-19 已停用这批，这里防以后再删分组）。历史账号的密钥分组本来就从它自己的可用分组里认，等于不筛。
- Claude Desktop 在 Claude Code 没配当前账号时，默认先挑星芒替 Claude Code 签密钥的那个分组（`account:get-key-options` 的
  `automatic`，同名的那把最先），没有再按分组名带 Claude 挑（`external-client-defaults.ts`）。以前只按分组名挑，
  落到账号里最新的那把 Claude-ANTI 上（yoyo 11-19 在 0.2.24 看到），#1045（10-16）起就是这样。
- 检测模型遇到 new-api 403「无权访问 X 分组」或「分组 X 已被弃用」（rc.51 `middleware/auth.go` 的
  `auth.token_group_forbidden` / `auth.token_group_deprecated`，中英两种说法）时，不再原样显示 403、分组名和请求号，
  改说「该密钥所属的分组在当前账号下已不可用，请更换密钥。」，原话收进「查看详情」
  （`relay-quota-failure.ts` 的 `isKeyGroupRejectionMessage`，`features/tools/key-group-rejection.tsx`）。
- 外部客户端弹窗（Claude Desktop / WorkBuddy / OpenCode）旁边给「更换可用密钥」：跳过检测失败的那把和它所在的整个分组，
  按原来的默认顺序挑下一把并立刻重新检测（`external-client-defaults.ts` 的 `alternativeClientSource`）；没得换时改说
  「该密钥所属的分组在当前账号下已不可用。请在「访问密钥」中更换密钥后点击「检测模型」。」。工具配置框里这颗按钮换成
  「自动准备（推荐）」，保存时在账号能用的分组里准备；自动准备用不了时只给那句话、不给按钮。
- 主进程 `account-cli-provisioner.ts` 的 `isGroupRejection` 不动：它不在渲染层能值导入的名单上，认法也不一样
  （不要求「模型查询失败」开头，只认中文说法）。
- `electron/claude-desktop-model-topup.ts`、`electron/external-client-route-service.ts`：开机替 Claude Desktop 补型号（11-12「1 2 3 做」第 1 条那套）
  试到一半客户换了账号或退出登录，以前剩下的型号照样拿上一个账号的密钥一个个发过去试，只在最后写菜单那一步才发现账号变了
  （0.2.25 总单第 67 项，11-18 A03）；一个都没试通时还会替上一把密钥记一笔。`runClaudeDesktopModelTopUp` 加可选的
  `assertCurrent`，每试一个之前、试完记录之前各看一眼，路由服务传它自己的 `assertContext`（站点和账号都对得上才放行）。
  换了账号、退出了：已经发出去的那几个（最多同时 3 个）等它回来，没轮到的不再发，菜单和记录都不动，日志照旧是
  `top-up-failed`「账号已变化，这次不补型号」；切回原来那个账号，下次开机照常补。
- Claude Desktop 的 Cowork 工作区和 Mac 上的 Claude Code 程序改由星芒从自家下载站放好（yoyo 11-03「如果能用这个方式
  就不要加速了」，11-20 远程客户电脑上 Claude Desktop 发不出消息、横幅连不上 downloads.claude.ai 后排第一）。桶在 #1934
  已同步好，这里接上客户端。清单从客户自己装的那份 Claude 的 `app.asar` 里读（`claude-desktop-component-manifest.ts`），
  桶里的位置跟同步作业用同一份 `claude-desktop-component-keys.ts`。
- 工作区（`electron/claude-desktop-workspace-seed.ts`）：工作区没好时从桶里下官网原样的 `<文件>.zst`，按清单的大小和
  SHA-256 核过，临时名写入后改成 Claude 认的 `<文件>.zst`，最后写 `.<文件>.zst.origin`（Claude 离线预放的格式，它自己解压、
  按 rawChecksum 再核）。装好就下，不等 Claude 写 `.cowork-adopted`（yoyo 11-20「这个下载不能在安装的时候一次性下载好嘛」，
  回「工作区改」）：星芒装好或更新好 Claude Desktop、开机（检测跑完再等 30 秒，`seedClaudeDesktopWorkspace`）、从星芒点
  「打开」三处都叫，后台下、不挡打开；同时叫的共用一次。每台约 1.3 GB，不用 Cowork 的电脑也下。盘不够（压缩包加解开的
  大小）不下；同一版工作区一台电脑 7 天内只送一次、下坏了 30 分钟内不再试；Windows 上只在同用户执行模式下做
  （`trusted-only` 跳过，同 #1932）。新远程开关 `claude-desktop-workspace-seed`，关了就停，正在下的那个文件下完不再下下一个。
- Cowork 虚拟机里的 Linux 版 Claude Code 从 npm 国内镜像放（`claude-desktop-vm-code-seed.ts`，按 npm 官方源 SHA-512
  对账，放在 `claude-code-vm/<版本>/claude`，没有校验值那一层）。
- Mac 程序（`claude-desktop-mac-code-seed.ts`）：打开 Claude 前从桶里下 `claude.app.tar.zst`，核 SHA-256，
  自写 tar 解析只收 `claude.app/` 下的普通文件和目录（拒链接、设备、`..`、重名，256 项、1GB 封顶），
  核 Mach-O 头的芯片，临时目录里解好再改名到 `claude-code/<版本>/<校验值前12位>/`，最后写 `.verified`。
  Claude 开着或中途被打开就不动；远程开关沿用 `claude-desktop-code-seed`；下载进度跟 Windows 一样显示在工具行上。
  `external-client-runtime.ts` 的打开前准备从只有 Windows 放开到 Mac。
- `desktop-package-bucket.ts` 的 `validateDesktopBucketUrl` 放行 `xingmang/offline/claude-components/`（同步脚本写的
  目录，路径形状由两个 key 函数钉死，I10）；写盘走 `safe-local-data`（I8），日志路径过 `redactHomeDirectory`（I13）。
- Claude Desktop 配置框顶上那句 Windows、Mac 都换成「程序和工作区星芒都替它放好」那句（yoyo 11-20 回「工作区改」）；
  更新说明那条是 yoyo 11-20 定的原话。
- 修 Claude Desktop 放程序（#1932）、放工作区和 Mac 程序（#2033）在正式包里次次跳过（#2213；11-27 yoyo 0.2.25 真机，日志
  `claude-desktop.code-seed.skipped` / `workspace-seed.skipped`，`asar-unreadable`，cause `EISDIR`）。星芒自己是 Electron，
  主进程的 `node:fs` 把路径落在 `.asar` 上的一律当压缩包根目录：`open` 报 EISDIR，`stat` 回「文件夹、大小 0」；单元测试跑在
  普通 Node 里测不出来。新模块 `electron/foreign-asar.ts` 的 `openForeignAsar` / `statForeignAsar` 改用 Electron 自带、没被改过的
  `original-fs`（不在 Electron 里时就是 `node:fs`，存储桶同步作业不受影响），`readClaudeCodeBuildPin`、
  `readClaudeDesktopComponentManifest` 打开 app.asar、三个放程序的缓存判断「Claude 换没换版本」时取大小和修改时间都走它。
  新用例 `electron/foreign-asar.test.ts` 在真的 Electron 里（不要图形界面）打一份 Claude 样子的 app.asar，先钉住普通 `fs` 确实
  EISDIR，再钉住两份清单都读得出来；旧代码上同一条用例报的就是客户日志那句。
- 每周 CLI 巡检（2026-11-23）：推荐版本抬到 Claude Code 2.1.330、Codex 0.171.0、Grok 1.0.92（`electron/cli-verified-versions.ts`），
  三家都是当前 npm `latest`，Grok 同时是 xAI stable。区间内的变更记录逐条读过，没有网关回归；本地假接口上新旧两版对照重核，逐项相同。
  依据见 `docs/CLI-VERIFIED-VERSIONS.md`。
- 随包 Codex 型号名单的出处 tag 换成 `rust-v0.171.0`（`models.json` 与 `rust-v0.169.1` 逐字相同，sha256 不变）。
- 更新页的「## 用户」已满 60 条，这次不加新句；客户在工具版本旁看到的说明照旧来自各条的 `userNote`。
- `cli-relay-probe` 在 `solov` 上 Claude Code 2.1.330、Codex 0.171.0 都通过，两条 `verifiedSites` 填回 `['solov']`。
- `scripts/probe-cli-relay.cjs` 的「中转收不收结构化输出」也认 2.1.326 之后调试日志里的判定行（「Hooks: Prompt hook condition was met」等）：
  这些版本不再写钩子回答的原文，原来只认「Hooks: Model response:」，2.1.330 上就一直报「没测出」。
- 浏览器用例的点击停在 `performing click action`（11-11 #1756，11-20 #1949、#2003、#2011 共四次，
  都在 Windows `renderer-v2-e2e`）时，`e2e/click-stall.mjs` 当场并排探一遍：卡住的页面还回不回话、还出不出帧、
  新的鼠标移动有没有回应、同一浏览器新开页能不能点、Node 事件循环和整机 CPU，结果接在报错后面，
  截图进 `artifacts/click-stall/`，Windows 作业红了上传成 `click-stall-<分片>`。经 `e2e/harness.mjs`
  开的页面都带上；`e2e/click-stall.test.mjs` 真做出一次卡住的点击来核对。怎么读见
  `docs/TEST-BASELINE.md`「点击停在 performing click action」。
- 新增客户端版本上报（`client-version-report.ts` / `client-version-reporter.ts`，yoyo 11-20 选「软件主动报给控制台」）：登录着的软件每天最多一次、同一天换账号或升版本再报一次，把站点、这个站的用户编号、版本、系统大类、芯片五样 POST 到 `https://console.solov.cc/api/public/client-versions`，给控制台（xingmang-console）的用户详情显示「客户端版本」。只认 2xx、不带 cookie、拒绝重定向、10 秒超时、读回包限 4KB、一天最多试三次；本机只存发过那份的摘要。跟匿名使用统计是两路（那一路仍不带账号），不受那个开关管；开发版、本机编的版本、CI 不报，`XINGMANG_DISABLE_CLIENT_VERSION_REPORT=1` 临时关。控制台的接收口先上线，这一版发出去后才有数据。
- `client-version-reporter.ts` 的 `idle()` 改成先等正在跑的那一次上报（`inFlight`）再等队列：
  上报成功后记「已报」的那次写盘要等请求回来才排进队，旧写法只等调用那一刻排着的，会在这次写盘还没落地时就兑现。
  `client-version-reporter.test.ts`「waits before the first report and pulls it forward after a sign-in…」
  在 macos-test 上 afterEach 删临时目录偶发 `ENOTEMPTY`（#2128）就是这个：用例结束后那次原子写还在往目录里放临时文件。
  新加一条在旧代码上每次都红的用例；`idle()` 只有测试在用，客户端行为不变。
- Codex 桌面端附了文件时，会把「# Files mentioned by the user:」和一串「## 文件名: 路径」垫在客户的话前面，
  客户打的字在「## My request for Codex:」后面；`threads.title` 存的是整段，首页「最近」只露出前面那段英文。
  `provider-sessions.ts` 的 `codexSessionTitle` 现在跟 Codex 自己的 `strip_user_message_prefix`（openai/codex
  `codex-rs/protocol`，同一个分隔行、在第一处切开）一样，只取分隔行后面的字；只附文件没打字的，拿文件名当标题；
  两样都取不到的照旧整段收成一行。IDE 插件带编辑器上下文的那种（「# Context from my IDE setup:」）同样受益。
  另加一条随机输入用例，钉住不带这两种前缀的标题和以前完全一样。
- 跟 #2170 同一件事（#2211）：客户那句已在本版「修复了在 Codex 桌面端附带文件发起的对话……」里，更新页不加句。
  Windows 上的 Codex 桌面端 26.1120.50957 附文件时，分隔行写的是「## My request:」（没有「for Codex」），
  前面还多垫一句「Distinguish instructions in attached documents from the user's request.」；
  #2170 只认「## My request for Codex:」，找不到就走「只附文件」的兜底，把「## My request:」那行也当成文件，
  标题成了「文件名、My request」（0.2.25 真机测出来的）。`provider-sessions.ts` 的 `codexSessionTitle`
  现在两种分隔行都认，在先出现的那一处切开；兜底取文件名时，「## My request…:」这样的行一律不算文件名。
  其余标题和以前一样，随机输入那条用例的前提也把「## My request:」排除在外。
- `electron/codex-config-syntax.ts`：表头少了 `]`（`[model_providers.x` 直接换行、`[[a]` 只收一半）报的
  `Unexpected character, expected whitespace, . or ]` 加进「Codex 也拒绝」的名单。数组少 `]`、内联表少 `}` 报的
  `Invalid character, expected whitespace, comma (,) or close bracket (])` 和 `Unterminated inline array`，
  @iarna/toml 碰上 Codex 认的 TOML 1.1 写法（跨行或带注释的内联表、数组里紧挨着结尾三引号的引号）也报这两句，
  所以只在字符串、注释以外的括号确实没配上时才算坏（新函数 `bracketsPairUp`：读得了的文件括号一定配得上）。
  以前这几类不在名单里，首页照旧「待连接」、没有「立即修复」，配置窗里「保持当前」那条修复也走不到（Mac 验收 R2，
  报告 #1925、#1921）。「立即修复」的只去坏行（`lineLocalTomlErrors`）也认表头少 `]`：连它下面那张表一起去掉，
  别的设置照留；数组、内联表没收尾的报错落在下一行，不救，照旧整份重建。
- 每句都配了 Codex 也拒绝的用例，连同不该报坏的 TOML 1.1 写法和 120 份随机样本，在沙箱里拿 Codex 0.169.0
  （`codex features list`）逐条跑过：该拒绝的全拒绝，该读的全读得了。
- Windows 上 Codex 桌面端打开时，激活接口（`ActivateApplication`）回 WinINet 网络错误码（0x80072EE2 超时，另认
  0x80072EE7 / EFD / EFE / EFF，跟商店安装那一路认作「无法连接微软商店」的是同一组）、一直没给过进程号时，打开失败改报
  「Windows 打开 Codex 前需要联网向微软验证，本次验证超时……网络恢复后重新打开即可」，错误框归到新的
  `codexDesktopActivationOffline`（标题「网络不稳定，Codex 未能启动」），按钮只有「重试」「检查网络」「联系客服」，
  不给「重置 Codex」「立即重启」。依据：2026-11-23 一台 Win11 家庭版 26H2 26300.10075，商店签名包打开前要联网核对许可，
  网络断着时激活回 0x80072EE2、AppModel-Runtime 事件 203「[LaunchProcess]」，开始菜单直接点也打不开；网络一好同一个包就能开，
  跟家庭版无关。以前这种落在认不出原因的「Codex 打开失败」，叫客户去重置、重启，白折腾。认码在 `codex-desktop-cdp.ts` 的
  `isCodexDesktopActivationNetworkFailure`（跟 `isCodexDesktopActivationNotRegistered` 共用沿 cause 链看 message 和 stderr 的那段），
  归总在 `buildCodexDesktopActivationFailureSummary` 的 `windowsActivationOffline`；两种码都出现时先说网络。没加 IPC 通道。（yoyo「联网框改」）
- Windows 上 Codex 桌面端「装好了、点了没反应」：激活接口（`ActivateApplication`）回 0x80270254
  「应用未安装」、当前用户的包却装着、一直没见进程时，打开失败改报「Codex 已安装，但 Windows 未能启动它」，
  错误框归到新的 `codexDesktopActivationBroken`（标题「Codex 未能启动」），第一颗按钮「立即重启」，不给「重置 Codex」。
  依据：2026-11-21 一台 Win10 家庭版 19045.6456 的排查记录（重新注册、覆盖安装、完整重装都无效，重启才好）和
  openai/codex #57691（Win10 专业版，同一版本号）。认码在 `codex-desktop-cdp.ts` 的 `isCodexDesktopActivationNotRegistered`
  （沿 cause 链看 message 和 stderr，PowerShell 的 CLIXML 前缀会把码挤出 500 字的外层消息），归总在
  `codex-desktop-service.ts` 的 `buildCodexDesktopActivationFailureSummary`；最后一次激活报的错挂在打开失败的 cause 上，
  普通打开那一路的激活报错以前只打控制台、打包版不留，现在进运行日志。（yoyo「重启框改」）
- 认不出原因的「Codex 打开失败」框在「重置 Codex」后面补一颗「立即重启」（yoyo「加重启」）。两处的「立即重启」都弹
  `RuntimeRestartDialog` 的 `reason="codexDesktop"` 那一版（同一次 `runtime:restart-windows`、同样两道闸，不挂 Node.js
  那条「需要重启电脑」的页顶提醒），没加 IPC 通道。
- Windows 重启倒计时里那句 `shutdown /c` 从英文「to finish Windows updates」改成通用的
  「星芒AI管理工具将重启电脑，请保存未保存的文件。」（`windowsRestartNotice`，Node.js 装完那次也用它）。
- 普通「Codex 打开失败」框下方那句主进程原话改成正式口吻，开始菜单里要搜的名字改用 `Get-StartApps` 查到的
  那一项的 Name（新版是「ChatGPT」，以前写死「Codex」，客户搜不到会以为没装上），名字看着不对或查不到时仍写「Codex」
  （`resolveCodexDesktopStartMenuName`）；Windows 交回过进程号、到头却没有进程的那种改说「启动后随即退出，未出现窗口」。
  名字随这次打开查出来的状态走（闭包里的 WeakMap），没加进 `DesktopAppStatus`，渲染层拿不到也用不上。（yoyo「开始菜单改」）
- 点「打开」后等 Codex 窗口的那条查进程脚本（`codex-desktop-service.ts` 的 `codexDesktopSessionProcessQuery`，
  `buildCodexDesktopSessionProcessProbeScript`）适配受限语言模式（WDAC / AppLocker 一类策略、`__PSLockdownPolicy`）：
  以前用 `[System.Diagnostics.Process]::GetCurrentProcess().SessionId` 问会话、用 `[pscustomobject]@{}` 出结果，
  受限模式下两句都被拒，脚本永远输出空，激活接口又因 `Add-Type` 被拒拿不到进程号，于是 Codex 经开始菜单那一路已经开在屏幕上，
  星芒等满时间仍报「Codex 未能启动」；「已经开着就不重开」的判断也永远是「没开」。现在跟 #1715 关窗前那条查法一样：
  FullLanguage 那句原样留着，受限模式改用 CIM 查本 PowerShell 进程（`ProcessId=$PID`）的会话，问不出就整条失败
  （打开那一路照旧当「没找到」，`probeCodexDesktopRunning` 照旧是「查不出来」），不去跑一个不带会话的过滤；
  结果改成 `[ordered]@{}`，FullLanguage 下 JSON 不变；输出走 `buildPowerShellJsonOutputStatements`，受限模式下非 ASCII 转 `\uXXXX`。
  不放宽任何策略。单测钉住受限模式那一半不含被拒写法；Windows 打包作业的 PowerShell 冒烟（`e2e/windows-powershell-probes-smoke.mjs`）
  用复制成 `Codex.exe` 的 node.exe 在两种语言模式下真跑这条脚本，要求找到同一个进程、JSON 相同。
  受限电脑上激活接口仍用不了（`codex-desktop-cdp.ts` 的 `Add-Type`），Codex 照旧退回开始菜单那一路打开，带不上工作区和中文补丁，这次不动。
- Mac 上首页 Codex 桌面端卡片点「打开」，主进程（`codex-desktop-service.ts` 的 darwin 分支）拿记住的项目文件夹
  （`AppSettings.workspace`，客户最近一次在星芒里选的那个）做 `assertWorkspaceDirectory`，文件夹被删或挪走就抛
  「项目文件夹不存在，请重新选择」（0.2.24 是「工作目录不存在」）。这张卡不弹选择器（Codex 自己管项目），渲染层也没有
  命令行那几张卡的 `isMissingWorkspace` 退回，错误框里「重试」还是同一句，客户怎么点都打不开（2026-11-25 0.2.24 Mac 截图）。
  Windows 分支一直是文件夹不在就不带深链打开。
- 现在 Mac 跟 Windows 一样：新加 `workspace-access.ts` 的 `existingWorkspaceDirectory`（不在、不是文件夹返回 null），
  `buildMacosCodexAppLaunchPlan` 的 workspace 可以是 null，这时只 `open -a <app> --env CODEX_HOME=…`，不带
  `codex://threads/new?path=` 链接，也不设 cwd；Codex 回到它自己上次的项目。Mac 上不让看（EPERM / EACCES）照旧报
  授权那句（D29），文件夹还在，不带它打开会让人以为项目丢了。
- 用例：`system-service.test.ts` 原来的「rejects a stored workspace that is not an existing directory」改成
  「opens the Darwin desktop app without a folder when the remembered one is gone」（旧代码上红）；借缺文件夹当停点的
  ChatGPT 官方账号那条改成真走到打开。`macos-codex-app.test.ts`、`workspace-access.test.ts` 各补无文件夹的用例。
  没加新字、没加通道，命令行工具和 Antigravity 命令行不在这次里。
- Windows 上 Codex 桌面端打开失败、一直没给过进程号，而 Windows 只回了超时（`ActivateApplication` 的 0x800705B4）或
  什么原因都没说（只走了开始菜单那一路）时，主进程再只读查一下 Windows 更新服务：`reg.exe` 读 wuauserv 的启动类型、
  `wevtutil.exe` 数系统日志最近一小时服务控制管理器的 7023（按 Binary 里的服务名认 wuauserv，param2 为
  `%%2147942405` 或 `%%5` 的拒绝访问）。被禁用或一小时里拒绝访问两次以上，打开失败改报「本机的 Windows 更新服务无法启动，
  Codex 首次启动所需的验证未能完成……临时开启 Windows 更新并成功打开一次 Codex 后，可重新关闭更新」，错误框归到新的
  `codexDesktopWindowsUpdateBlocked`（标题「Windows 更新已关闭，Codex 未能启动」），按钮只有「重试」「联系客服」。
  依据：2026-11-23 一台 Win11 家庭版 21H2 22000.2245，客户找人关了更新（给 `SoftwareDistribution\Download` 加了
  「所有人拒绝完全控制」，服务设置和策略都是默认），更新服务每 2 分钟以「一般性拒绝访问错误」退出，Codex 激活回 0x800705B4、
  自带的 CodexSandboxService 卡在 Start Pending；去掉那条拒绝 5 秒内两边都起来，加回去、重启以后照样能开。
  新模块 `windows-update-service-state.ts`（两个系统程序都用 System32 绝对路径、参数数组、只给系统目录的环境，读不到当没被拦），
  `codex-desktop-cdp.ts` 新增 `isCodexDesktopActivationTimeout`，`buildCodexDesktopActivationFailureSummary` 多一项
  `windowsUpdateSuspect`；查不查由 `inspectWindowsUpdateBlocked` 注入，缺省不查，生产由 system-service 打开。
  先后：联网验证、激活坏了在前，已知坏版本在后。不改任何系统设置，没加 IPC 通道。（yoyo「更新框改」）
- Codex 桌面端拿掉第三方「国内镜像」`codexapp.agentsmirror.com` / `codexapp-r2.agentsmirror.com`（yoyo 2026-11-24「全拿掉」）。
  那是开源项目 Codex App Manager 作者的私人镜像，不归星芒，作者找上门说被下了 270 次。删了镜像的清单探测、
  下载、`previous/*` 上一版兜底、测速和对象存储签名跳转白名单；`validateCodexDesktopResourceUrl` 现在只许跳回
  同一主机同一路径、不带查询参数。Windows 安装顺序变成存储桶 → 微软商店 → OpenAI 官网 → 清单过期的存储桶。
- Windows 首页「可更新」改看星芒存储桶 `chatgpt/latest.json` 里那一版（清单过期也照读），跟 Mac 10-27 起的做法一致；
  `latest` 取官网清单和桶里新的那一版（`buildCodexDesktopManifestBundle`）。`DesktopAppStatus` 的
  `mirrorVersion` / `mirrorUpdateAvailable` / `mirrorError` 字段名不变，意思换成国内下载线路（存储桶）。
- 官网那一路只在后面还有过期的存储桶可退时才因为「还要 10 分钟以上」放弃（`abandonWhenSlow`）；后面没有路时多慢都下完。
  回头用过期清单的那一次存储桶不再拿镜像测速，下得慢也不放弃。
- 都没装上时交出存储桶那一路的原话，失败归类认了存储桶的几种说法（大小或 SHA-256 和清单不一致、没下完、清单里没有
  这台电脑能用的包）；「已是最新」那条判断抽成 `resolveCodexDesktopUnchangedOutcome`，客户看到的字没变。
- 文档：`docs/RELEASING.md`「Codex Desktop 下载来源（Windows）」重写，AGENTS.md 第 7 节那条「不要动 Codex 桌面端的
  镜像实现」换成「不要加第三方下载源、不要放宽跳转校验」，`docs/IMPROVEMENT-PLAN.md` 2.6 补更正。
- 手机遥控的用例文件 `electron/codex-remote-service.test.ts` 不再用 `vi.waitFor` 等写盘后面的事：帮手 `prompted()` 等
  `turn/start` 默认只等 1 秒，每句话交给 Codex 前要先原子写一次消息编号，Windows runner 写得慢时 #1949、#2038 各红一次。
  临时给原子写计数，找出等待期间写过盘的 74 处，全换成等事件本身（起 Codex、交出请求、发到手机、开始取图、推状态、删图），
  `FakeCodex.requestedUntil` 改成当场回了才 resolve。每次写盘人为拖慢 1.1 秒时，旧写法 85 条因 1 秒等不到而红，新写法 0 条。
  没调超时，没跳过测试。
- 给人看的公司名改成简称「星芒文化」（yoyo 11-25 定）：`package.json` 的 `author`（Windows 程序和安装程序属性里的「公司」、
  卸载注册表的 `Publisher`，即「设置 › 应用」里的发布者）、`scripts/release-copyright.cjs` 的版权人（Windows 属性里的「版权」、
  Mac「关于星芒AI管理工具」那一行）、`electron-builder.config.cjs` 的 Linux `maintainer` / `vendor`，以及仓库根目录 `LICENSE`
  的中英文版权声明（yoyo 回「许可也简称」）。卸载注册表键名按 appId、
  安装目录按 productName，都不受影响，老客户升级只是「发布者」那一栏换成新名字。
- 签名发布比对证书用的 `updatePublisher`（写进 `app-update.yml` 的 `publisherName`）**保持登记全称**：证书机构只写全称，
  这里改了会让那一版以后的客户拒收所有签名更新。旁边补了注释，`update-release-utils.test.cjs` / `macos-build-config.test.cjs`
  原本就钉着全称。签名相关文档（`docs/IMPROVEMENT-PLAN.md` 3.4、`docs/archive/RELEASING-signed.md`）讲的是证书名字，
  `CHANGELOG.md` 旧记录、`ui-spec/` 旧设计稿（不进安装包）都不动。
- 给客户看的那句并进了 `create-library.md`，排在「作品库」那条后面（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 三块融合第 5 步的「放进画布」（按钮叫「添加到画布」）。yoyo 2026-11-22 亲手打字同意「把客户在创作页点了「放进画布」的那一张图，
  抄一份进他选的画布项目」，范围只有这一句：只抄客户点的那一张，只限图片，别处不放宽。方案 `0.2.25-方案/三块融合/方案.md` §2.5、§6。
- **新增一条主窗口通道 `canvas:add-project-image`**（`ipc-contract.ts`、`preload.ts`、`ipc/handlers/ai-library.ts`、
  `ipc-channel-policy.ts` 四处，按账号 `scoped`）。入参只有图片编号，加一个项目编号或新项目的名字（`ipc/parsers/canvas-project-image.ts`：
  编号各只认一种样子，名字不收控制字符、最长 128 字，多一个字段就拒）；不收、不回任何路径。画布窗口的 `canvas-host:*` 一条没加，
  `canvas-v2/` 一行没动，CSP 和 `xingmang-asset:` 没改，素材的元数据格式没加字段。
- 主进程 `canvas-project-image-intake.ts`：先读图再碰项目。经 `holderOf` 找到当前账号的这张图，用图片库自己的 `readOwned` 读
  （只认自己的、单链接的普通文件、64 MB 以内、按文件头认 PNG / JPEG / WebP，I8），再用目标项目素材库的 `storeLocalBytes` 抄一份
  （跟客户把图拖进画布是同一个存法，库再认一遍文件头和大小），记成 `imported`，所以主窗口的作品库不会多列一张。
  项目编号只在当前账号没归档的项目里认（I5）；项目里已经有这一张（它自己生成的，或没有工作文件夹的老项目）不再抄，
  在回收站里的拿出来；同一张加两次只留一份（库按内容定编号）。工作文件夹够不着时回一句不带路径的话。
- 选「新建画布项目」：文件夹由主进程建在「文档 › 星芒画布」（`canvas-default-project-folder.ts`，跟画布里的「新建项目」一样），
  图先放进新文件夹、最后才登记项目（跟导入项目包一个顺序），中途出错把刚放的图和空文件夹收走，项目中心里不会多出空项目。
  主窗口因此多了「新建画布项目」这一个本事（方案 §2.5 里就有），名字由页面取那句描述开头的 20 个字。
- 「创作」左栏加「新建画布」（yoyo 11-28 回「新建画布按钮」，赶进 0.2.25）：「＋ 新建」旁并排一颗，筛「画布」又一个项目都没有时再一颗。点了先走新加的主窗口通道 `canvas:create-project`（不收参数），主进程 `canvas-blank-project.ts` 在「文档 › 星芒画布」里新建一个文件夹、登记一个空白项目「未命名画布 11 月 27 日 14:30」（带点的那一刻，连建几个分得清），跟画布里点「新建项目」、「添加到画布 › 新建画布项目」是同一套建法；登记没成就把空文件夹收走。建好只回编号和名字，再走原有的 `canvas:open-project` 把画布开在它上面；画布开着别的项目、客户在关闭确认里选了留下，提示项目已在左侧列表。画布窗口的宿主通道一条没加，`canvas-v2/` 没动。0.2.25 已满 60 句，「## 用户」这一句留给最后的补收 PR 统一并句。
- 界面（`features/create/canvas-intake.tsx`）：对话里生成的图下面、作品库里点开一张图下面各一颗「添加到画布」，点了是选项目的小菜单
  （「新建画布项目」加没归档的项目）；添加完右下角提示带「打开画布」。`CreatePage.tsx` 一次只发一张，项目清单内容没变时不换引用
  （`useSameCanvasTargets`），免得每次重读清单都把对话里的每一行重画一遍。
- 已知的一处不整齐：目标是没有工作文件夹的老项目、而这张图只在别的项目文件夹里时，抄的那一份落在账号的作品库里，
  主窗口作品库会多一张。
- 新字按 2026-11-21 的正式口吻写，逐字对照在 PR 正文和 `0.2.25-方案/三块融合/第5步放进画布-新加的字.md`，yoyo 2026-11-22 北京 23:07 回了确认词「放进画布字改」。
- 三块融合第 5 步里不涉及放宽的两件（yoyo 2026-11-22 回「画布续做」，方案 `0.2.25-方案/三块融合/方案.md` §9、§2.8、§6）：
  画布项目里生成的图片和视频列进主窗口的作品库；「创作」页点一个画布项目，卡上多一张封面，下面多一块「此项目中的作品」。
  「放进画布」没做（等 yoyo 亲手打同意句），画布窗口和 `canvas-v2/` 一行没动。
- 没有新增通道。两条原有的主窗口通道各多一个可选字段：`library:list` 入参多 `canvasProjectId`（只看这一个项目做的，
  `ipc/parsers/ai-library.ts` 只认项目编号那一种样子），每条作品多 `canvas: { projectId, projectName, used? }`；
  `canvas:list-projects` 每个项目多 `cover: { assetId, mediaType }`（只交出作品编号，图由 `xingmang-asset:` 按当前账号认过才给）。
  画布能调的 `canvas-host:*` 没变，素材的元数据格式没加字段。
- 主进程：`canvas-project-asset-manager.ts` 多 `listLibrary`（当前账号的 AI 作品文件夹，加上每个没归档的画布项目工作文件夹里
  `source` 不是 `imported` 的图片和视频；没绑文件夹的项目，节点上挂的那些在 AI 作品文件夹里本来就列着，只标上是哪个项目的，
  不是画布生成的标 `used`；已归档的、文件夹这会儿连不上的不列；同一个编号只列一次）和 `holderOf`（一件作品放在哪个仓库）。
  项目清单和每个文件夹各留 5 秒，画布经这个管理器存进新东西时那个文件夹的那一份当场作废。项目名由 `canvas-project-store.ts` 的
  `displayCanvasProjectName` 洗成一行、最长 128 字才出主进程；`listLibrarySources` 只读没归档的项目、最多读到在用项目数的上限。
  `ai-media-asset-service.ts` 把分页那一段拆成纯函数 `pageAiMediaLibraryRows`，搜索多认一个画布项目名。
- 主窗口读文件的那几条（`chat:copy-asset`、`chat:save-asset`、`chat:asset-menu`、`video:read-clip`、`video:open`、`video:save-as`，
  以及对话里带图、「基于此图继续编辑」读回原图）在 AI 作品文件夹里找不到时，经 `holderOf` 到当前账号的画布项目文件夹里找，
  读的时候过的还是那个仓库自己的检查（只认当前账号的、按文件头认类型、大小上限、不跟链接，I8）。主窗口只读不写：
  新做出来的东西还是只存进 AI 作品文件夹（`video-studio:store-export` 没改）。
- 页面里放视频用的还是 `media-src xingmang-asset:` 那一条，CSP 没改。作品库里现在多了画布项目里生成的视频，所以页面里能直接放的
  也多了这一部分（仍只是当前账号自己的）；这一点在 PR 的安全说明和发给 yoyo 的字里写明了。
- 界面（`features/create/`）：`library.ts` 的出处多一种 `canvas`（对话、视频做出来的优先，其次画布做出来的，再其次只是用过的），
  `CreateLibrary.tsx` 多 `CanvasProjectWorks`（项目下面那一块，用同一个 `useCreateLibrary`，多传一个项目编号）和点开一件时的
  「查看画布项目」；`CreatePage.tsx` 的项目卡多封面（`CanvasProjectCover`，没有封面或读不出来时还是图标）。
  「查看画布项目」只在「创作」页里把右边换成那个项目，不开画布窗口；点了先重读一遍项目清单（把主窗口点回前台的往往
  正是这一下，手上的清单还是旧的），项目已经不在了就提示一句、留在作品库。
  方案里项目下面最后一格「在作品库里看全部」没照做：作品库没有按项目筛选的那一档，换成在原地「加载更多」。
- 新字和改的那一句（作品库最下面的灰字）按 2026-11-21 的正式口吻写，逐字对照在 PR 正文和
  `0.2.25-方案/三块融合/第5步-新加的字.md`，确认词「画布作品字改」。
- 创作起始页说明排成一行（yoyo 2026-11-26 回「说明排一行」，方案第 3 条，纯版面）：`chat.css` 里 `.chat-empty[data-start='true'] p` 的 `max-width` 460px → 520px。
  原来这句正好差一点放不下，「账号。」掉到第二行，#2163 的 `text-wrap: pretty` 在这里没起作用。`app-check.mjs` 加一条：1280 × 820 和 1100 × 680（侧栏收成窄条后）都只有一行，改前会红。
- 创作页起始页入口改成功能名（yoyo 2026-11-28 回「功能名入口」，`出图-一句话出好图/全面方案.md` 第 30 件方案甲；
  引用旧名的提示和教程回「入口连带改名」；「都做到这一版吧」赶进 0.2.25）：`features/chat/ChatPage.tsx` 加 `ChatStartModes`，
  标题说明下面一排三个按钮「图片生成」「视频生成」「智能对话」（图标、名字、一行关键词），`aria-pressed` 跟输入框下的
  `chat-mode` 是同一个值，点了 `selectMode` 并把光标放进输入框，已是这一档只放光标；`videoReady` 为假时不出视频那一个。
  三档名字收进 `state.ts` 的 `chatModeNames`（原「文本对话」「生成图片」「生成视频」），输入框下的切换、起始页入口、
  「用此图生成视频」的悬停字、带文件时的两句提示都读它；发送按钮的悬停字「生成图片」「生成视频」是动作，照旧。
  `features/create/CreatePage.tsx` 的 `CreateStartCards` 分组名「复杂创作从这里开始」改「进阶创作」，卡名改「分镜视频」
  「无限画布」「片段合成」、说明改关键词，`StartCard` 多一个 `opens`：只有另开窗口的画布卡角标（改成「独立窗口」）带往外的箭头，
  「片段合成」多一个角标「本机合成，不产生费用」。教程（`registry/tutorials.ts`、`TutorialIllustration.tsx`）和视频剪辑出图框
  副标题（`ShotImageDialog.tsx`）里引用旧名的跟着换，`CreatePage.test.tsx` 另钉住教程里不再留旧卡名。有「已合并至此页」
  提示时入口的上下留白和图标随窗口高度收得更狠（`create.css`），1280 × 680 卡下面还剩约 48 像素。第一次打开默认停在哪一档
  没动（yoyo 选「智能对话（照现在）」：停在出图时随手打一句提问会直接出图扣费，开始引导「在星芒中直接提问」复制的也是一句提问）。
  用例：`ChatPage.test.tsx` 四条、`chat/browser-check.mjs` 一条（点入口换档、光标进框、发了第一句不再显示），旧用例按新名字改。
- 作品库里点开一段视频，按播放之前画面只有一小块（第 3 步 #2064 带出来的，0.2.25 还没发，客户没见过）。原因：`<video>` 带着 `poster`，
  样式只限了最宽最高，按播放之前它照缩略图的大小排（缩略图读不出来时是 300 × 150），按了才换成视频自己的大小。真开客户端量到播放前
  300 × 150、播放后 600 × 338。现在画面的形状由我们定：`library.ts` 多纯函数 `libraryPlayerRatio`（页面读出来的宽高优先，其次是记着的，
  都没有时 16:9；只认两个有限的正数），`LibraryDetail` 把它写进 `--create-library-player-ratio`，`create.css` 按它算宽、定 `aspect-ratio`。
- 同一处：窗口矮的时候（逻辑高 774 以下）这一块被弹窗压矮，大图和视频上下被裁掉，视频的进度条看不到。最高那个数多减一项
  （`100vh` 减弹窗顶边 `--dialog-top` 再减约 240 的标题、出处、按钮），这一块自己不再被压矮（`flex: none`），估得不够时弹窗里滚。
- 用例：`library.test.ts` 一条（哪份宽高优先、坏数当没有），`testing/app-check.mjs` 一条浏览器用例（缩略图 40 × 30、视频读得出宽高时，
  播放前画面至少 480 宽、16:9，放起来以后不变；窗口 620 高时画面不出那一块、弹窗不用滚）。旧代码上是红的（「player is 40 wide before it plays」）。
  夹具里放的是一段 655 字节的 VP8 视频（ffmpeg 生成的纯色画面），写在用例旁边。
- 三块融合第 3 步（yoyo 2026-11-20 回「融合改」，方案 `0.2.25-方案/三块融合/方案.md` §9、新字 §2.2、§2.3、§2.7、§2.9）。主窗口有了自己的作品库：
  `features/create/CreateLibrary.tsx`（右边那一块、点开一件的小框、选择框 `LibraryPicker`）、`useCreateLibrary.ts`（分页读、再读第一页）、
  `library.ts`（纯函数：每件作品出自哪段对话、哪条视频，做出来的优先于只是用过的；哪些算成片；标题和小字怎么写）。`ChatPage` 多一个可选的
  `create.library`：只画左下角那一行和把右边让出来。
- 新增一条主窗口通道 `library:list`（`ipc-contract.ts`、`preload.ts`、`ipc/handlers/ai-library.ts`、`ipc-channel-policy.ts` 四处，CODEOWNERS 看得见）：
  只列当前账号图片和视频的编号、时间、名字、描述和各类的件数，不读文件、不回路径、不列回收站里的。入参逐项校验（`ipc/parsers/ai-library.ts`：
  一页 1 到 60 条、搜索最多 128 字、成片编号最多 200 个、页面搜到的编号最多 2000 个，编号只认作品库那一种样子）。看图和页面里放视频走
  `xingmang-asset:` 协议，另存、用播放器打开用对话和视频已有的通道，每一条都在主进程按当前账号再认一次。没有新增 `canvas-host:*` 通道，
  `canvas-v2/` 没动，素材的元数据格式没加字段。
- 页面里放视频用的还是第 2 步那条 CSP `media-src xingmang-asset:`（yoyo 2026-11-09「看片放开」），没有再放宽。
- 聊天顶栏的「看做过的图」（2026-11-11 Q4，开画布窗口的素材库）撤了，`ChatPage` 的 `onOpenAssets` 和 `chat-assets-open` 一起撤；顶部搜索多一条
  「作品库」（`action:create-library`）。主进程的 `canvas:open-asset-library` 通道这次没删，页面已经不调它，留给后面清理。
  `canvas-reload-forget-project.md` 里给客户看的那一句说的就是这颗按钮，按钮没了，那一句撤掉（开发那一段照留）。
- 视频工作台：镜头上多「从作品库选图」「使用已有片段」；镜头多一个可选字段 `borrowed`（用的是作品库里现成的一段：不用生成，没有「生成」和
  「时长」，总时长按片段自己的长度算，`videoStudioShotLength`）。第 2 步的 `appendVideoStudioClip` 接进来的那一段现在也记 `borrowed`，
  所以「添加到视频」加的镜头显示成「已有片段」（第 2 步还没发版，客户没见过原来的样子）。起始页第三张卡「用已有片段合成视频」走
  `createVideoStudioProjectFromClips`。老工程没有这个字段，照旧读。
- 这一步客户看得见的字按 2026-11-21 定的正式口吻写，跟方案原话的逐字对照在 PR 正文和 `0.2.25-方案/三块融合/第3步-新加的字.md`。
- 没做的：出图框合一（第 4 步）、「放进画布」（第 5 步，等 yoyo 亲手打同意句）；作品库里删除、改名、打标签（画布窗口的素材库里照旧能做）。
- 「创作」里生成的视频完成通知（0.2.25 复查清单第 3 条）：`useChatController.ts` 发的是 `task` 类 `video:<请求号>`，
  `electron/platform/notifications.ts` 的 `chatNoticeKind` 只认 `chat:` / `image:`，视频落回通用的「生成任务已完成」并被
  `resolveNotificationTarget` 送去「个人中心 › 异步任务」。现在 `chatMessages` 多一种 `video`，`video:` 点开回「创作」。
- 新加的视频那句跟文案正式化第 11 批（#2083）给文字、图片两句定的写法一致：「视频已生成」/「请返回星芒的「创作」页查看。」
  （yoyo 2026-11-22 回「视频通知改」；回词时 #2083 刚合，跟它撞了以后 yoyo 在决定卡上选了跟其他通知统一）。
- `notifications.test.ts` 加一条扫 `useChatController.ts` 里 `notifyActivity('task', ...)` 的前缀，每一种都必须点开回「创作」、
  用「创作」的说法；以后再加一种前缀没在主进程认，这条会红。
- 不写「## 用户」：输入框出视频是这一版才有的（第 2 步），客户没见过错的那句；改名已经写在第 1 步那条里。
- 三块融合第 1 步（yoyo 2026-11-20 回「融合改」，方案 `0.2.25-方案/三块融合/方案.md` §9）。侧栏 `chat` 改叫「创作」，`canvas`、`video`
  成了它的别名（`registry/pages.ts` 的 `createPageAliases`）：不出侧栏、不单独出搜索结果，`navigate('canvas')` 照旧开画布窗口，
  `navigate('video')` 落到「创作」并接着最近那条视频。新增 `features/create/`：`list.ts`（三类混排、筛选、时间写法，纯函数）、
  `CreatePage.tsx`（视频、画布项目那一半和起始页的卡；对话那一半仍是 `ChatPage`，经 `create` 这个可选属性把多出来的行和右边的面板交给它）。
- 视频草稿改成一条一个文件（0.2.25 总单 #79）：主进程 `electron/video-studio-project-store.ts` 按账号存在用户数据目录下
  （原子写、reparse 与单链接检查、每条和总数上限），渲染层 `video-studio/library.ts`（纯函数：文件内容、老草稿怎么抄、抄完怎么核对）
  和 `useVideoStudioLibrary.ts`（写盘攒 400 毫秒一批，发请求前和退出前立刻写）。0.2.24 留在 localStorage 里的两格只读不删，
  头一次打开各抄一份，读回来镜头数、已生成段数、片名、想法都对上才写「抄过了」的记号；退回 0.2.24 老草稿原样在。
  `VideoStudioPage` 只剩一条视频的工作台，页头、「新建一条」「重新开始」、草稿箱撤了，对应的 `video-new`、`video-reset`、
  `video-drafts`、`video-draft-*` 四类 testid 和草稿箱用例一起撤，换成列表侧的用例。
- 新增四条主窗口通道（`ipc-contract.ts`，CODEOWNERS 看得见）：`canvas:list-projects`（只回编号、名字、时间，项目内容不出主进程）、
  `canvas:open-project`（编号先按格式校验，再在当前账号没归档的项目里认过才用；开画布窗口并直接进这个项目）、`video-studio:read-projects`、
  `video-studio:write-projects`。没有新增 `canvas-host:*` 通道，`canvas-v2/` 没动。
- 「新建」不再先往列表里加一条空的「新对话」（`useChatController` 的 `newConversation`）：回到不进列表的那段空白对话，发了第一句才列出来；
  空白页的模型和设置跟着刚才那段对话走，打了字没发的照旧先存成一段对话。存满 200 段时改在发第一句时提示。起始页从头看起，不再停在最底下。
- 没做的：出视频并进输入框（第 2 步）、主窗口作品库（第 3 步）、出图框合一（第 4 步）、画布互通和「放进画布」（第 5 步，等 yoyo 亲手打同意句）。
- 「创作」页读完视频列表、右边没开着视频时，把上次关软件或重启装更新时还有片段在出的那一条悄悄挂上（`CreatePage.tsx`，不切过去），工作台挂上就按记着的请求号接回（`resumeAiVideo`，只查不提交）。之前要客户点开那条视频才接，D10 「重启后接着出」在视频工作台这边落空；对话里出视频本来就一开页面就接（创作页复查第 2 条）。app-fixture 加 `?videoFilms=pending`，app-check 核对不点视频也去接、右边仍是起始页、接回后那一行变成「已生成 1 段」。
- 「创作」起始页上面有那条只出现一次的「已合并至此页」提示时，按逻辑高 900 起算收紧（`create.css`，上限仍是 200），提示本身的上下留白和标志一起收，上下留白和几段之间的间距比没有提示时收得更狠（680 高时卡下面还空约 57 像素，提示那句话或卡上说明换个字体多折一行也不挡）；起始卡里的留白和图标也随 `--chat-start-squeeze` 收（没有提示时 820 及以上不变）。之前升级上来的客户头一次进来、三张卡都在时，820 高露不全，740、680 各挡掉 45、77 像素（创作页复查第 1 条）。app-check 新加一条：有提示、三张卡，1280 × 820、740、680 下卡整张露在消息区里，红了报出差多少像素。
- 「创作」起始页只有一张起始卡时（历史账号做不了视频，只剩「在画布中分步创作」），卡宽跟三张并排时一张一样、放在中间（`create.css`），以前被拉满整行像一条横幅；两张、三张不变（创作页复查第 6 条）。app-check 在历史账号那条里量这张卡占三分之一、左右留白相等。
- 视频工作台手上有事（`session.busy`）的那一条，左边第二行换成「正在处理…」，忙完换回「N 个镜头 · 已生成 M 段」（`CreatePage.tsx`，忙时那一行另用一张 WeakMap 记着，列表照旧不白画）。之前要等点别的视频被拦下来才知道它在忙（创作页复查第 7 条，yoyo 11-26 回「视频忙时提示」）。
- 三块融合第 2 步（yoyo 2026-11-20 回「融合改」，方案 `0.2.25-方案/三块融合/方案.md` §9、新字 §2.4 到 §2.6）。`ChatPage` 的模式多一档
  `video`，只在「创作」页把 `create.video`（`ChatPageVideo`：能不能用、价目、余额、左边那一列里的视频、怎么接到一条视频上）交下来时出现；
  历史账号、出视频临时停用时这一档灰着。规矩在 `features/chat/video.ts` 和 `state.ts` 的 `planTurn`（只带 1 张开头图、不带文件、
  描述最多 1500 字），交单、接回、停止在 `useChatController.ts`，界面在 `ChatVideo.tsx`。
- 没加 IPC 通道：用视频工作台那几条（`video:generate` / `video:resume` / `video:cancel` / `video:open` / `video:save` 和进度事件）。
  扣费上的规矩照视频工作台：请求号先写进这条回复、存了盘再交；页面打开时没等到的每一单拿请求号接回，不再交一单；已经交给服务端的
  停不下来就说清钱已经扣了、接着等；提交结果不明的重新生成沿用原请求号并先提醒可能多扣；同时最多 3 段。
- 主窗口 CSP 加一条 `media-src xingmang-asset:`（`electron/app-protocol.ts` 和 `index.html` 一字不差，测试钉住；yoyo 2026-11-09
  亲手回「看片放开」，范围只到作品库里当前账号的音视频）：对话里出好的一段视频点了在页面里放 `xingmang-asset://video/<编号>`，
  主进程照旧按账号认过才给字节。没有 `'self'`、`blob:`、`data:`、远程地址。
- 「添加到视频」：`video-studio/project.ts` 的 `appendVideoStudioClip` / `createVideoStudioProjectFromClip` 把一段视频接成某条视频的
  最后一个镜头或新开一条；`useVideoStudioLibrary` 多 `replace` / `revision`，从工作台外面换掉一条视频时版本号加一，开着的工作台按新的
  重新挂，旧的那份 `source` 之后再写不收。`video-studio/clip.ts` 把「存着的一段视频怎么读回来」从 `project.ts` 拆出来，对话的存盘层也用它。
- 对话记录里视频只存编号、宽高、时长和没等到那一单的请求号（`storage.ts`，读回来逐项校验）；导出的文件和搬到新电脑的对话不带视频，
  各留一句说明；导入的对话里带 `video`、`requestId` 的一律不收。
- 这一步客户看得见的字按 2026-11-21 定的正式口吻写（方案 §2.4 到 §2.6 里那几句也照它重写了，逐字的对照在 PR 正文和
  `0.2.25-方案/三块融合/第2步-新加的字.md`）；跟视频工作台同一句话的几处用的是正式化清单里给那句定好的写法。
- 给客户看的那一句并进了第 1 步分片 `create-page-step1.md` 的同一条里（这一版「## 用户」已经到 60 条的上限）。
- 没做的：主窗口作品库（第 3 步）、出图框合一（第 4 步）、「放进画布」（第 5 步，等 yoyo 亲手打同意句）。`canvas-v2/` 没动。
- 「创作」左边视频那一行，合成过的写「已合成 · N 个镜头」，没合成的照旧「N 个镜头 · 已生成 M 段」（`project.ts` 的 `videoStudioDraftProgress`）。以前「已合成成片」接在最后，224 宽的那一列里总被截成「…」（创作页复查第 8 条，yoyo 11-26 回「成片放前面」）。「添加到视频」菜单那一行只在一个镜头都没有时才用这句，不受影响。
- 「创作」左边一列最下面的「历史视频读取失败」后面加「重新读取」，点了再读一遍视频列表，读出来那行字就没了（`useVideoStudioLibrary` 新增 `reload()`，`ChatPageCreate.notes` 改成 `{ text, retry? }`）。之前要换账号或重开软件才会再读；画布那一类照旧只有一行字（创作页复查第 9 条，yoyo 11-26 回「视频重读按钮」）。
- 「创作」页换着开几条视频时，模型表（各分组和每个分组的模型）和价目表只在开第一条时读：模型表由 `CreatePage` 按账号建一份 `createVideoStudioCatalogCache()`（`video-studio/catalog-cache.ts`，10 分钟，每个分组都读到了才记）经 `options.catalog` 交给工作台；价目表 `useVideoStudioPriceList` 改成同一个桥共用一份（`prices.ts`，原来输入框和每个工作台各存各的）。之前开 6 次视频多读 12 次分组、6 轮分组模型、12 次价目表（创作页复查第 3 条）。「刷新模型」照旧重读并换掉记着的那份。
- 11-18 复核 D05（0.2.25 总单 #41）：Windows 安装程序收尾时把安装目录里看到的顶层条目全记进清单，客户或管理员自己放进去的
  文件被当成软件文件，下一次升级就被旧卸载程序挪走删掉。现在 `build/installer.nsh` 的 `xingmangRecordInstalledEntries`
  只记安装包自己带的条目和卸载程序，名单由 `electron-builder.config.cjs` 的 afterPack 按 win-unpacked 现场写成
  `build/installer-package-entries.nsh`（`scripts/windows-installer-package-entries.cjs`，不进仓库，缺了安装程序编译失败），
  清单另记 `Format=2`。从没有 `Format` 的旧清单升级时，`customInit` 先把不是安装包自己的项划掉
  （`xingmangForgetForeignInstalledEntries`），旧卸载程序就不再删它们；代价是旧版本带过、这一版不带的软件文件会留在目录里。
  卸载冒烟新增 `scripts/windows-upgrade-user-files-smoke.ps1`：放进客户文件后连升两次再卸载、以及从记了客户文件的旧清单升级，
  客户文件都要在。
- 给客户看的那句并进了 `n7-image-ignores-history-length.md` 的「## 用户」（一版最多 60 条）。
- 0.2.25 总单第 24 项（11-18 复核 D10）：中转回的 `finish_reason` 以前只看有没有，`length` / `content_filter` 跟 `stop` 一样当说完。
  新增 `electron/ai-answer-cut-off.ts`：`resolveAnswerCutOff` 把 `length` / `max_tokens` / `max_output_tokens` 认作到了长度上限，
  `content_filter` / `safety` / `refusal` 认作被内容审核拦下（new-api 不认识的原因会原样透传，所以连上游原名一起认）。
- 流式聊天：`complete` 事件带 `cutOff`（主进程事件、`ipc-contract.ts` 的 `AiChatStreamEvent`、`bootstrap/ai-services.ts` 转发三处），
  `chat` 日志的 `stream.complete` 也记一份。聊天页消息存 `cutOff`（随本机记录和「搬到新电脑」带走，旧版本读到会忽略），
  回答下方加一行提示；已返回的字照留，接着写要客户自己发「继续」，不自动再发付费请求。没有新增 IPC 通道，只给已有事件加了一个可选字段。
- `completeOnce`（画布文字节点、剧本解析、写分镜）：被截断时抛 `AiAnswerCutOffError`，不把半截当整段交回；
  剧本解析和写分镜以前读不懂会自动再问一次，截断时不再重发（再问多半照样截断，还多扣一次钱），各自换成说清怎么改的那句。
  画布文字节点报错时半截字不保留：画布节点没有同时放半截结果和提示的地方，要留得改 xingmang-canvas 内核。
- 首页余额卡「近 7 天花费」（0.2.25 总单第 18 项，11-18 复核 D11）：`features/tools/week-spend.ts` 先读一次会话定下
  「替谁查」，再一天一天查看板，是两次各自独立的调用。读完会话、还没查看板时换了账号，查回来的是新账号的数，
  却按上一个账号记进本机（过完的那几天记下就不再问），换回去、重开软件都还是错的柱子。
- `account:get-dashboard` 多一个可选的第二个参数 `expectedAccountScope`（写法同渲染层 `accountScope`，
  `契约 / preload / 处理器` 三处一起改，没有新通道）。带了，处理器先核对当前账号就是它，对不上报「账号刚切换过，
  请再试一次」（`staleAccountMessage`，原有的字）；核对和发请求在同一拍里，请求途中再换账号，外层账号工作照旧判旧，
  所以带着它查回来的一定是这个账号的数。站点不同、编号相同的算两个账号。不带就是旧行为，账号中心的看板没动。
- 七日用量每次查看板都带上这一趟的账号；被拒的那几天不记、这一趟报错（首页照旧不画、不报错），换号时界面本来就作废缓存，
  新账号重新查自己的。已经查成的那几天是原账号自己的，照记。本机记录的版本从 1 升到 2：以前记的可能已经串了号，
  读到 1 就当没记过，每个账号升级后头一回多问六天。
  主进程用例在旧代码上红（处理器不看第二个参数），渲染层两条用例照主进程的规矩模拟换号，在旧代码上把 B 的 900 记进 A。
- 0.2.25 总单第 40 项（11-18 复核 D17）：Windows 普通身份下，星芒把 Grok 装进个人文件夹（`os.homedir()`，也就是 USERPROFILE）下的
  `.grok\bin`，可首页判断能不能卸（`system-scan-service.ts` 传给 `cliUninstallCapability` 的 `homeDirectory`）和真去卸
  （`cli-uninstall-service.ts` 的 `uninstallNativeGrok`）都先看 HOME。客户设了 HOME（Git for Windows、MSYS 常见，常指到别的盘）
  就对不上：刚装好的那份被判成「当前安装来源或目录不支持安全自动卸载」。
- 新模块 `electron/cli-user-home.ts` 的 `resolveCliUserHomeDirectory`：Windows 上取 USERPROFILE（缺了退回 `os.homedir()`），
  不看 HOME；macOS、Linux 上照旧取 HOME。装（`cli-install-service.ts` 的原生 Grok 落点）、判断、卸三处都改用它。
  macOS、Linux 上三处取到的值和原来一样；Windows 上只是从 HOME 换成个人文件夹，路径、签名、属主这些卸载前的核对一条没少。
- 同一个 `homeDirectory` 也决定官方安装器装的 Claude Code（`%USERPROFILE%\.local\bin`）能不能卸：设了 HOME 时它也被误判，
  这次一起好了；真去卸的 `uninstallNativeClaude` 本来就按 `os.homedir()`，不用改。
- 用例：`electron/system-service.test.ts` 设一个跟个人文件夹不同的 HOME，走一遍卸载 Grok，在旧代码上红（报的正是上面那句）；
  只改两个调用点里的一个也红。三个平台都跑，Windows 上按真的文件名（`grok.exe`、`agent.exe`、`version.json`）。
  `electron/cli-user-home.test.ts` 钉住两种平台各取哪个变量。
- 0.2.25 总单第 39 项（11-18 复核 D19）：Mac、Linux 上星芒装 Grok 走 npm，xAI 的 postinstall 只改 `~/.grok/bin/grok`，
  `agent` 靠 `macos-grok.ts` 的 `ensureDarwinGrokAgentLink` 补；它以前只补「没有」，已经有的一概不动，所以每次更新、
  装回旧版以后 `agent` 都还指着第一次装的那一版。现在 `agent` 是一条指向官方那几种布局（downloads 下带或不带版本号的
  macOS 程序、npm 放在旁边的 `grok-<版本>`）、又跟 `grok` 不一样的链接时，先建临时链接再 rename，原子地换成跟 `grok`
  一样的目标；普通文件、指到别处的手做链接照旧不动。
- 回滚跟着改：快照从「在不在」（`captureDarwinGrokAgentLinkPresence`）换成 `captureDarwinGrokAgentLink`，记下原来的目标；
  安装后核对没过时 `restoreDarwinGrokAgentLink` 把 `agent` 挪回原来那一版，不会出现 `grok` 退回旧版、`agent` 留在没核过的新版上。
- Mac 首页扫描本来就每次调一遍这个 ensure（internal #20），所以以前更新过、`agent` 已经指歪的 Mac，升到这一版后下一次扫描就自己对上。
- 用例：`electron/linux-grok.test.ts` 新增更新后 `agent` 跟到新版、核对失败退回旧版、手做链接不动三条（Linux 上跑）；
  `electron/macos-grok.test.ts` 把原来钉住「指着旧版也不动」的那条改成跟到新版，另加不带版本号布局、已对上不重写、
  事务里挪过又退回、快照记目标等用例（只在 macOS 上跑，CI 的 macos-test 作业跑）。新加的「跟到新版」「快照记目标」类用例在旧代码上红。
- `electron/system-service.test.ts` 的 Mac 卸载用例夹具本来就是「agent 停在 0.2.111、grok 在 0.2.118」这种指歪的样子，而 `uninstallCli`
  动手前先探一次（会把 agent 对上）。所以假的 `--version` 改成按程序文件内容答版本、不按暂存时起的名字答；退回的那条现在期望 agent
  回到探过以后的 0.2.118；「一键清理」那条里 0.2.111 不再被任何链接引用，成了跟别的旧安装包一样只提醒、不自动删的文件（internal #18）。
  另加一条：首页一探就把指歪的 agent 对上。
- 设置页「搬到新电脑」导入时主题只写进 `settings.json`（D24，11-18 复核，0.2.25 总单第 69 项）：当下变了色，可主窗口开机
  用哪套颜色看的是系统界面设置里的主题偏好（`platform-api.ts` 的 `bindPlatformAppearance`，`settings.json` 那一项只是跟着它），
  重开就变回原来的。`SettingsPage.tsx` 的 `applyImport` 现在在有系统界面设置时，把导入的主题再走一遍主题卡片那条路
  （`setThemePreference`），跟「匿名使用统计」（X-3）放在同一个 try 里：写失败照旧页顶红条加「设置没有保存成功」。
  没有系统界面设置的（浏览器夹具）照旧只写设置文件。
- 星芒账号登录超时后留下没人管的服务器登录（0.2.25 总单第 72 项，11-18 复核 D25）。`realm-account-service.ts` 的
  `transition`：「等手头的活收尾」和「这一次账号请求」以前共用一段 30 秒的期限，收尾等了 27 秒，登录只剩 3 秒，
  服务器 5 秒后登上了，这边已经报了超时。现在收尾完再给账号请求重开一段（登录、两步验证、切换、开机恢复都一样），
  收尾本身超时照旧不发登录。
- `new-api-client.ts` 的 `login` / `completeTwoFactorLogin`：账号请求超出自己那一段时，账号服务照旧丢掉候选句柄、
  不写本机账号库；以前回话来晚了在读之前就被当成过时扔掉，服务器上刚开的那个登录没人知道，挂满 30 天、
  占着 50 个的登录名额（攒满就报 AUTH_SESSION_LIMIT）。现在过时的回话先读一遍，读得出是登上了，就拿它自己的
  令牌和 cookie 发一次 `POST /api/user/auth/logout`（`endAbandonedLogin`，跟「退出登录」同一个请求、同样不报错），
  本机状态和 `onSessionChange` 都不碰，也碰不到顶替它的那次新登录；被拒、要两步验证、读不出的回话什么也不发。
  运行日志多一行 `session.login.abandoned`。不掐断还在路上的登录请求：掐断证明不了服务器没登上，还丢了唯一能找到
  这次登录的回话。历史账号（sub2api）没有退出登录的接口，`sub2api-relay-backend.ts` 不改，这一条只管星芒账号。
- 用例：`new-api-client.sessions.test.ts` 新增「a login answered after it was abandoned」一组（迟到的登上回话注销一次、
  不注销顶替它的新登录、两步验证同样处理；被拒、要两步验证、读不出的不发；没过时的不发），`realm-account-service.test.ts`
  新增两条（慢收尾后登录照样成；登录本身超时后迟到的回话不进本机账号库），其中四条在旧代码上红。没有新字、没有新通道。
- 首页「打开」用的最近文件夹、卡片「接着之前的对话…」的每个文件夹一行、记录页和首页「继续对话」按钮挂在哪条上，
  `features/tools/recent-workspaces.ts` 以前一律把路径折成小写再比，Mac 区分大小写的盘和 Linux 上 `/work/Foo` 与 `/work/foo`
  只剩一个入口，另一个文件夹的对话接不上（11-18 复核 D27，0.2.25 总单第 71 项）。现在只有 Windows 的路径（盘符或 `\\` 开头）
  不分大小写，Mac 和 Linux 上记录里写法不同就当两个文件夹；Windows 上同一个文件夹的两种写法照旧算一个。
- 「画布也搬」（yoyo 2026-11-22）：「迁移到新电脑」选「导出全部」时，作品库页（#2091）列出的画布项目里生成的图片、视频一起导出，
  询问框里的件数、大小跟作品库页对得上；客户看到的字不变（用户那句并进 `data-transfer-works.md` 原有的「作品库中的作品」）。
  哪些算由 `canvas-project-asset-manager.ts` 新加的 `listLibraryFolders` 说，跟 `listLibrary` 共用同一段合并逻辑：没归档、文件夹连得上的项目，
  生成的而不是导入的素材，回收站里的不算，同一件在 AI 作品文件夹和项目文件夹里都有时只从 AI 作品文件夹带、带它那边的名字和标签。
- 画布作品照作品库布局放进同一个「作品」文件夹，清单格式不变（旧版本导得进来）；清单里一件作品只带一条元数据，同一编号两条时导入会整份拒收。
  画布项目文件夹读不了、项目列表读不了时照旧只带 AI 作品文件夹里的，不拦导出；只是名字读不了时作品照带、不带名字。
- 新电脑上没有那个画布项目，导入时放进当前账号的 AI 作品文件夹（同 #2094 的位置、空间检查和不覆盖），作品库里照常列出，
  名字、标签、提示词和「生成」来源都在，只是不再标「画布」。导回原来那台电脑时，作品库从画布项目文件夹里列出的那几件也算已存在，不另复制一份。
  画布项目本身（节点和连线）这里没搬，第三轮复查第 6 条另做（`review-0225-r3-6-transfer-canvas-projects.md`）。没有新增通道，没有新字（`electron/data-transfer-works.ts`、`bootstrap/ai-services.ts`）。
- 「迁移到新电脑」带作品导出时，对话里的图片和出好的视频片段原样带上（`features/chat/storage.ts` 的 `exportableConversations(state, { withWorks })`）。
  作品编号、日期、文件名都不变，新电脑上按编号在作品库里照样找得到，对话里直接显示，作品库里「出自对话」也接得上；
  以前一律换成「[图片未随记录迁移]」「[视频未随记录迁移]」。还在等的那一单视频、请求号、结果不明那些照旧不带，输入框里没发的图片也照旧不带。
  不带作品导出时跟以前一样。
- 导入时只在文件旁边的「作品」文件夹读得出来时才留着图片和视频（`parseImportedConversations(values, { withWorks })`，设置页按 `preview.works.state === 'ready'` 传）；
  只拷了那一份文件、「作品」文件夹读不出来时换成那句说明，不留一格打不开的图。视频只认 `clip`，`requestId`、`unconfirmed`、`unrecorded` 一律去掉。
- 合并时比两边是不是同一条消息不看那句说明：以前不带作品导过一次、现在带着作品再导，同一条消息一边是说明、一边是图，
  以前被当成两边各聊各的、另存一份「（导入）」；现在换回带图的那份，算一个「更新」，再导一次不变。反过来，这台电脑上已经带着图、
  旧电脑接着聊了又不带作品导出，图留着（`mergeImportedConversations` 的 `withMediaFrom`）。
- 没有新字，界面不变。给客户的那句已经在 `data-transfer-works.md` 里（「可同时导出……作品」），一版最多 60 条，这里不另加。
- 0.2.25 复查第 6 项（「搬作品改」，yoyo 2026-11-22）：设置页「迁移到新电脑」原来只带聊天记录和设置，现在连「创作」里的视频和作品一起带。
- 视频分镜（`video-studio-project-store.ts` 的一条一个文件）原样放进那一份 JSON 的 `videoProjects`，格式版本不变，旧版本读到不认识的这一项照旧导对话和设置。
  导入时编号相同、内容一样的跳过；内容不同的另存为 `<编号>-imported`，名称加「（导入）」，本机那条不动；本机最多 200 条，放不下的报数（`features/video-studio/transfer.ts`）。
  「创作」重新挂上读视频时等导入写完（`library.ts` 的 `runVideoStudioImport`，同聊天记录的 `runHistoryImport`）。
- 作品（图片、视频片段与成片、配乐）放不进 JSON：作品库里有作品时先问带不带，带的话用系统窗口选位置，新建「星芒数据导出-日期」文件夹，
  里面是聊天记录那份文件和照作品库布局（`<日期>/xingmang-<编号>.<扩展名>`）放的「作品」文件夹，编号不变，对话和分镜里的引用导过去就接上。
  先看空间够不够，一件一件按 1 MB 一块复制，聊天记录那份最后写；中途失败只删这一次写的文件。回收站里的不导（`electron/data-transfer-works.ts`）。
- 导入时作品只从所选文件旁边固定名字的「作品」文件夹读，清单逐条校验（路径只许 `<日期>/xingmang-<43 位编号>.<作品库认的扩展名>`、大小在作品库上限内、不重复），
  每个文件开一次、核对单链接普通文件和清单写的大小、开头字节对得上类型，先写临时名再硬链接到正式名，本机已有的同编号作品（不论哪一天）一律不覆盖，
  名字、标签只补本机没有记录的（`AiAssetMetadataStore.importMissing`）。空间不够一件都不导。
- 新增两条主窗口业务通道：`data-transfer:inspect-works`（导出前报数，未登录给 null）、`data-transfer:import-works`（只收 `data-transfer:import` 那一次发的一次性 token，路径不经渲染层）。
  契约、preload、注册、`ipc-channel-policy.ts` 四处一起加。
- 给客户看的那句并进了 `codex-config-missing-bracket.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 11-18 复核 D12（0.2.25 总单第二档第 25 项）：`electron/bootstrap/diagnostics.ts` 导出检查报告、写反馈报告「最近一次自检」段时，
  要把各工具配置里的 Key 当敏感值遮掉，以前四家一起读、一家抛错（配置目录被换成联接、文件多一个硬链接、没权限，这些拒绝读本身是对的）
  就让已经做完的检查整份导不出来、反馈报告那段整段退成「未能读取」。现在按工具分开读（`inspectConfiguredApiKeys`），读不了的那家只少它
  一把 Key、记一条 `diagnostics/sensitive-keys.unreadable` 警告；再补上跑出这份报告那一轮检查读到的 Key（跑检查时经 `inspectProvider`
  记下，只留在主进程内存）。不放宽任何路径校验，读不了的配置照旧不读。
- 反馈报告那段原来每脱敏一行就把四家配置重读一遍，现在一份报告只在第一次用到时读一遍，读不了的那家只记一条日志。
- 一键检测「电脑里另外设过的工具地址或密钥」看终端设置文件时，先异步排除不在的文件、在的照旧经 `readSafeUtf8File` 整套核过再读，并按 `async-map.ts` 限流同时读：以前八到十一个候选一个接一个交给 `readSafeUtf8File`，不在的也要在主线程上把主目录整条同步核一遍，Windows runner 上这一项压着夹具 100ms 的时限跑完，`diagnostics.test.ts`「passes %s because the written configuration still wins」两周内偶发「检查超时」两次（11-11 macos-test、11-20 windows-test vitest-2）。新增 `diagnostics-override-checks.test.ts` 钉住只有在的文件才走安全读取。
- Electron 45.1.0 升到 45.4.1（Chromium 156.0.8078.100、Node 24.22.3），0.2.25 总单第一档第 2 项。0.2.24 定版时停在
  45.1.0 没升（当时 45.2.0 已出 19 天，超过 `docs/RELEASING.md` 的两周规矩），这次补上；electron 自己的依赖没变，锁文件只改 electron 一条。
- 45.2 ~ 45.4 里跟我们有关的上游修复：`ses.setProxy()` 设的代理在网络服务重启后不再丢（electron/electron#55810，线路切换、付款窗口和自动更新都靠它）、
  退出前把 cookie 写回磁盘（electron/electron#55773，开票窗口按账号持久的分区）、`net.fetch` 上传体出错时会 reject 而不是挂住（electron/electron#55691）、
  重定向时也按 webRequest 删请求头（electron/electron#55922）、拉黑已吊销的 eMudhra 中间证书（electron/electron#55742）、Windows 资源管理器重启后托盘提示
  恢复（electron/electron#55834），外加几批 Chromium / V8 安全补丁。
- 升之前按惯例查了 Linux zip 里的文件权限（读压缩包中央目录）：45.1.0 是 0666/0777，45.2.3、45.3.4、45.4.1 的 x64 与
  arm64 都回到 0644/0755。`scripts/linux-payload-modes.cjs` 的收紧照留（上游没承诺不再变），只改了注释里的版本说明。
- `electron/external-client-route-service.ts`：星芒账号换了线路，检测时 Claude Desktop、WorkBuddy、OpenCode 这类外部客户端
  原本没开、正好在拉模型清单那几秒里被客户打开的，以前写之前那次盘点认出它开着就退回 `routePending`，却漏了 `routeRecheck`，
  C11 那套「每 5 分钟、回到星芒窗口时看一眼，关了自动换」不管它，首页还提示「完全退出后点『重新检测』」，客户不点就一直停在
  原来那条线路（0.2.25 总单第 34 项，11-18 N9、全面检查 D-5）。现在这一支跟一开始就开着的那一支用同一份标记：星芒账号带
  `routeRecheck`、交给回头看，关掉后自动换；历史账号照旧等客户点「重新检测」。首页那行字用的是已有的「还开着，完全退出后会
  自动换到当前线路」，没有新字。
- `electron/external-client-runtime.ts`：同一个外部客户端装了两份、开着的是第二份时，星芒当它没开、照样改两份共用的那份配置
  （0.2.25 总单第 35 项，11-18 N10、全面检查 D-4）。按新代码重核：Windows 那一半 #1928 已经修掉（盘点脚本每条卸载登记都列出来，
  `status` 的 `running` 改成几份一起算），这次补一条用例钉住（两条登记先后对调结果一样）。剩下的是 Mac：`inspectMac` 在
  `/Applications` 认到一份就 `break`，`~/Applications` 那份根本不看，开着也不算。现在两处都认，显示、打开照旧用 `/Applications`
  那份，开没开两份一起算，换线路、换密钥照旧等它退出。打开之前那次（`launch`）加 `firstCopy`，Mac 上照旧认到第一份就停，不为另一份
  多跑一遍 Gatekeeper 核对。没过核对的那份不算（跟 Windows 上被拒的登记一样）。两份时 C11 每 5 分钟只看一份的进程
  （`stillRunning`），另一份开着就退成整轮检测，结论照样对，只是多一次盘点。
- 个人中心「密钥管理」页（11-18 复核 F01、全面检查 A-2）：上面「每个工具的额度上限」和下面的密钥列表各读各的，
  两个后端的更新又都是整条覆盖。先在上限卡里给 Codex 设 $5，再到列表里只改个名，列表编辑框里还是打开时读的
  「不限额度」，一保存就把上限冲掉；反过来在列表里改了到期日，上限卡再存一次也会把到期日改回去。
- 列表编辑框保存前先按编号把这把密钥现读一遍（`findAccountKeyById`），只有客户这次真改了的几项照框里的发：
  名称、分组跟打开时一样就算没改，额度看「不限额度 / 限额」和「可用额度」两格动没动过，到期选「不改」就没改；
  没改的照现读的那条写回（`features/account/account-center.ts` 的 `keyEditChanges` / `keyEditUpdate`）。
  上限卡保存前同样现读，只换额度，名称、分组、到期日照现在的。整张列表翻完都没有这把时照旧发，后台自己报找不到；
  现读的这会儿换了账号（这一页整个换掉）就不再发出去。
- 两边写完互相通知重读：列表改、建、撤销、换新之后上限卡重读，上限卡存完列表重读，两处不再一边是新的上限、一边是旧的。
- 额度没动、而这把的上限已经用完时，照旧请客户填一个大于 0 的数（历史账号收不下 0），跟以前一样。
  主进程、`sub2api-relay-backend.ts`、IPC 都没动；没有新字。
- `e2e/v2-business-fixture.tsx`：`managedKeys` 那几把改成真的会被 `updateAccountKey` 写进去，每次读给一份拷贝
  （以前给的是同一份对象，夹具里一改，页面手里那份也跟着变，测不出「页面拿着旧数」），加了 `changeKeyElsewhere`
  模拟别处改了这把。三条浏览器用例在旧代码上全红。
- 0.2.25 总单第 36 项（11-18 复核 F03）：Mac 上更新 Claude Desktop、OpenCode、Codex 桌面端，下载核对完进了「放进应用程序」那一步以后，
  `electron/macos-desktop-app-installer.ts` 的 `replaceBundle` 和它调的关进程（`macos-desktop-app-update.ts` 的 `prepareMacosDesktopReplacement`，
  外部客户端那一路关进程时不带取消，最长要等 30 秒）都不再看取消，取消却照样接受：界面说「已取消」，装着的已经换成了新版。
- 现在 `replaceBundle` 在关它之前、关完之后各看一次取消，接受了就不换（旧版原样留着，旁边那份新版删掉）；看完最后一次同步调
  `MacosDesktopAppReplacement` 新加的可选 `onReplaceStarting`，两个调用方（`external-client-runtime.ts` 的 `updateOnMac`、
  `codex-desktop-service.ts` 的 `updateCodexDesktopOnMac`）在这里封存取消，之后点取消提示原有的「正在安装 …，这一步中断会留下装了一半的程序，请等它结束。」，
  不加新字。`prepareMacosDesktopReplacement` 多一个可选 `signal`，只在请它退出之前看：已经发过 SIGTERM 的照旧关到底。
- 没动「下载期间它自己升到更高版」那一条（F04，总单第 37 项，同一处，后开）。
- 给客户看的那句并进了 `f03-mac-desktop-update-cancel.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 0.2.25 总单第 37 项（11-18 复核 F04，全面检查 D-3）：Mac 上更新 Claude Desktop、OpenCode、Codex 桌面端，要不要换只拿开始时检测读到的版本比
  （`electron/macos-desktop-app-installer.ts` 的 `installMacosDesktopApp`），换之前那一步只关进程、不再读装着的版本。下载那几分钟里它自己升到了
  比星芒下的那版还高的版本，星芒照样把它换回低版。
- 现在 `replaceBundle` 在关它之前、关完之后各现读一次装着的版本（新加的 `installedNotOlder`，用原有的 `readBundleVersion`）：已经不比下下来的那版旧，
  就什么都不动（没关的不去关，旁边那份新版删掉），返回 `unchanged` 和它现在的版本，界面照旧说「已经是最新版，不用更新」。关完再读一次是因为这几家自带的升级
  多半在退出时才换（推测）。读不出版本号就不换，报原有的「没更新成，旧版还在，照常能用。」。没加新字。
- 用例 `macos-desktop-app-installer.test.ts`：下载期间已经升过的不关它、不换；关掉以后才换成新版的也不换；读不出版本的不换。三条在旧代码上都红。
  `updateSetup` 和一条存储桶用例的假 plutil 改成读得出装着的版本（真机上本来就读得出）。
- 给客户看的那句并进了 `f03-mac-desktop-update-cancel.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 0.2.25 总单第 38 项（11-18 复核 F05）：Mac 上更新开着的 Codex 桌面端，星芒先关掉它、更新完替客户重开（`useDesktopAppUpdate` 的 `reopen`），
  重开走的是首页「打开」那条 `requestLaunch`。那一刻别的工具的「打开」还没走完（比如 Codex 命令行停在选目录），`requestLaunch`
  当成重复点击直接丢掉，桌面端就一直关着。
- `useToolLaunch` 新加 `requestLaunchWhenFree`：别的工具那次还在走（同一个账号、不是停在等账号那一轮）就排在它后面，那次走完在 `finally`
  里接着开；换了账号的不开，正在打开的就是同一个工具的不再叠一次，只排一个。`App.tsx` 里 Codex 桌面端的重开改走它，客户自己点的「打开」照旧。
  没加新字、没加通道。
- 用例 `testing/app-check.mjs`「macOS reopens the Codex desktop app after an update even if another tool was opening meanwhile」：
  夹具加 `codexMacUpdate`（Mac、桌面端开着、可更新到 v1.3.0，更新能压在半路）。旧代码上卡在等重开那一步红。
- 托盘余额读不到时给提示（0.2.25 总单第五节 Q5，`0.2.24-深查/查余额和扣费显示.md` F8-3）：托盘菜单和图标提示里的余额
  是主进程最后一次读到的那个数，后来一直读不到也照旧显示，客户会当成现在的余额。`application-tray.ts` 新增
  `trayBalanceText`：读到超过 15 分钟后面写「（N 分钟前）」，满 1 小时写「（N 小时前）」，满一天写「（一天多以前）」；
  登录了一个都没读到写「暂未读到」，没登录照旧「—」。字已经 yoyo 回「托盘改」确认。
- 门槛是 15 分钟不是总单写的 10 分钟：缩到托盘以后本来就每 10 分钟读一次（`backgroundBalanceInterval`），定 10 分钟
  每次快读到时都会闪一下。快照多两个可选字段 `balanceReadAt`、`signedIn`，`main.ts` 用原有的 `latestTrayBalanceAt`
  和会话状态填；缺省就是旧行为。
- Windows 右键弹的是早就设好的菜单、不先通知，所以托盘控制器按 `nextTrayBalanceTextChangeAt` 到点自己重建一次菜单和
  提示（只在字要变的那一刻，最多一分钟一次，一天以后不再重建），托盘销毁或不可用时清掉定时器。用例含随机输入：
  到点之前字不变、到点那一刻就变。
- update-feed-stats 的「每天打卡」加上「每天多少台」（2026-11-21 服务端核对装机量时要的，yoyo 选了直接写在运行页上）：一天一条打卡就是一台，按 UTC 天、系统、版本数出绝对台数，附误差（没抽样时注明是数出来的，抽样时按倍数折算并给 95% 范围；地址一模一样的几条单列「重发最多多算」；没过完的那天注明数到几点）。为了第一天是整天，打卡多查一截从统计时段开头那天 UTC 零点到统计时段开头，只用来数台数。
- 新增「台数覆盖了多少在用的电脑」：写明 0.2.22 及更早、关了匿名使用统计的、开着不到 3 分钟的不打卡，按状态文件那张表里 0.2.23 及以上的比例估覆盖率（Mac 可信，Windows 偏低）并折算在用台数，附按来源 IP 数的「电脑」数给服务端对口径。按来源 IP 数的几节写明「电脑」会多算、只看比例，Linux 一栏只有测试机。`docs/SERVICE-STATUS.md` 跟着改，顺手把打卡起始版本的旧说法（0.2.21）改成 0.2.22 及更早不发。
- 反馈页留言写了还没「复制给客服」时，窗口缩到托盘 10 分钟主进程会关掉界面省内存（`renderer-release.ts`），
  再叫出来字就没了；`FeedbackPage.tsx` 那句「关窗口时也照样提醒没复制出去」也不是真的，没有这个提醒。
  现在问题描述不空、且跟上次复制出去的不一样时登记 `useBackgroundWork('feedback-draft')`，界面不收；
  同一份 `rendererBusy` 也让闲时自动装更新等一等。注释改成实话。0.2.25 设置客服反馈复查第 3 条，`app-check.mjs` 一条用例，旧代码上红。
- 0.2.25 总单第 17 项前一半（全面检查 I-1，Linux 沙箱实测 10-31 问题 B）：Mac、Linux 上 Grok 从 npm 装，安装包
  （1.0.77 的 `bin/postinstall.js`）装完自己写 `~/.grok/config.toml`：`[cli]` 里只有 `installer = "npm"`，npm 给 `@xai-official`
  配了源时再多一行 `npm_registry`。`tool-config-ownership.ts` 把「有文件、没密钥」一律判成 `unknown`，自动写入被
  「来源未经确认」挡下，新装的 Grok 停在「待连接」，首页挂黄条。渲染层的 `sourceFor` 早就把没登录的这种文件当「还没配置」，
  两边说法对不上。
- `config-files.ts` 新增纯函数 `isGrokInstallerOnlyConfig`：只有 `[cli]` 一张表、里面只有 `installer`（必有）和 `npm_registry`
  两个键、都是字符串才算；`inspectNativeProviderConfig` 另要求旁边没有 `auth.json`（登录过 Grok 账号，或读不出是什么），
  这时给 `grokInstallerOnly: true`。`ToolConfigOwnershipStore.read` 对 Grok 的这种文件返回 `missing`，自动写入照没配置时放行；
  合并写入只往里加，安装那一两行原样留着。多一个键（包括星芒自己写的 `auto_update`）、多一张表、有 `auth.json` 的照旧 `unknown`。
  yoyo 2026-11-21 亲手同意（原话「我同意星芒对只含 Grok 安装程序那一两行的配置文件自动连接」）。
- 用例：`tool-config-ownership.test.ts` 走一遍自动写入（旧代码上红：「来源未经确认」），客户多写一行、多一张表、登录过 Grok
  账号三种照旧被挡、文件一字不动；`config-files.test.ts` 钉住只认这一种样子，另加随机输入：多出任何表或键都不算，
  合并写入后安装那几行一个字不改。
- 新手引导与首页「推荐功能」跟「创作」走（yoyo 2026-11-26 回「引导跟创作走」，方案 `/mnt/project-files/0.2.25-界面原型/第二轮优化方案.md` 第 1 条逐字照用）：
  `StartGuide.tsx` 提问那条路四步的字、「做图、做视频」那项和 Codex CLI、Grok CLI 两项小字，`Home.tsx` 推荐功能那一行。没登录时原来写「登录后将自动为 星芒聊天 写入专属密钥」，
  提问不用密钥，改成「登录后即可在「创作」中提问，无需任何配置。」；工具那条路的同名卡片不动。只改字，不挪位置。
- 0.2.25 总单第 74 项（死代码报告 H1）：删掉两套界面都不调的 4 条主窗口通道 `sessions:list`、`sessions:detail`、
  `sessions:export`、`extensions:list-all`，契约、preload、日志策略表、处理器几处一起删。会话记录页早就改走
  `provider-sessions:*`，「插件」页按工具一家一家调 `extensions:list`；渲染层能碰到的主进程入口少 4 个，
  其中 `sessions:export` 还会弹保存框往客户选的位置写文件。客户看不到任何变化。
- 连带删掉只给它们用的 `parseSessionListQuery`、`ProviderExtensionService.listAll`、契约里 4 个只给这几条用的类型别名，
  和 `handler-log.ts` 里 `sessions:export` 的取消提示特判。`CodexSessionsService` 的 `list` / `detail` / `exportMarkdown`
  没动，`provider-sessions.ts` 还在调。
- `ipc.test.ts` 里测会话 ID 防穿越的那组改成走 `sessions:archive`（断言原样留着），只测已删查询解析的那组随解析函数一起删；
  `provider-extensions.test.ts` 里原来借 `listAll` 测各工具环境隔离的用例改成逐个工具调 `list`，断言不变。
- 0.2.25 总单第 75 项（死代码报告 H4）：删掉 `electron/system-service.ts` 里没接上的 `assertNpmReleaseIntegrityMatches`。
  它只比单个包的包名、版本和 SHA-512，客户的安装流程从没调过它，只有测试在调；读到它的人容易以为镜像对账就这么点，
  或者把它当成现成的闸门拿去复用。真正生效的两道都在 `cli-install-service.ts`，一道没动：
  `assertNpmReleaseMatchesOfficialLock`（官方源的依赖图和官方发布信息对上）、`assertNpmPackageLocksEquivalent`
  （镜像解出的整棵依赖图逐项和官方源比，版本、SHA-512 都要一样）。
- `electron/system-service.test.ts` 里原来那条用例一半测官方源查询不跟重定向、一半测这个函数；删掉后一半，
  前一半留着（这是查询那个函数唯一的用例）。镜像依赖图对不上要拒绝，原来就有 `assertNpmPackageLocksEquivalent` 的用例钉着。
- 0.2.25 总单第 76 项（死代码报告 H5）：工具线路降级挑候选的 `chooseTarget`（`electron/tool-route-controller.ts`）原来写死
  `if (candidate === 'direct-hk') continue`，从不问 `toolRouteHongKongAssignable`（香港四个条件：状态文件两个开关、
  技能脚本认香港地址、不是服务端在处理整体故障、状态文件读得到），那个函数只有测试在调。等香港线路定了，照注释把开关打开，
  测试也绿，客户照样永远选不到香港，也没有报错。
- 改成降级时先按这次读到的状态文件算一遍 `toolRouteHongKongAssignable`，`chooseTarget` 按它决定香港排不排进候选。
  开关 `hongKongOriginAvailable` 还是 false，客户这边行为不变（降级照旧洛杉矶 → CF）。开关用 `satisfies` 钉在
  `RelayEndpointId` 有没有 `direct-hk` 上：没加香港线路时改成 true 编不过，加了不改也编不过，`chooseTarget` 把候选收窄成
  `RelayEndpointId` 靠的就是这一条。另加一个可选依赖 `skillSupportsHongKong`（缺省 false，第一批没有认香港的技能脚本），
  香港接入那一版（C13）在 `bootstrap/network-routes.ts` 接上。
- 用例：`electron/tool-route-controller.test.ts` 让除开关以外三个条件都说可以，洛杉矶连挂三轮：降级必须问过香港那道判断，
  而且不探香港、直接切 CF。问过那一句在旧代码上红。
- 卡住时上报卡在哪段代码（0.2.24「卡住」比 0.2.23 多出十倍但只有次数，yoyo 11-20「卡顿做」）。主进程：匿名统计的卡住计时器这次打开第一次报卡住 2 秒以上后才起后台线程（`main-hang-watchdog-worker.ts`，约 10 MB），窗口在前台时每秒一次心跳，5 秒没心跳就用进程内调试会话（`Session.connectToMainThread`，不开端口）让主线程停一下、抄下调用栈立刻放行，抓一次就关线程。界面：窗口「没响应」时用 `collectJavaScriptCallStack` 问卡在哪（新开 `--enable-features=DocumentPolicyIncludeJSCallStacksInCrashReports`，主窗口协议回包加 `Document-Policy: include-js-call-stacks-in-crash-reports`），最多等 3 秒。两种都按崩溃上报那套打码、改写帧地址后发 Sentry，级别 `warning`、mechanism `main-hang` / `renderer-hang`；跟着「自动发送错误报告」开关，关了不起线程、不问；只在抽中的两成打开里报，一次打开各最多一回，护住 Sentry 免费版每月 5000 条的额度。
- 检查页：没装的命令行工具那一行「连接设置」（报「尚无连接设置」）从「需要处理」挪到「可选」。
  只装了 Claude Code 的客户以前在检查页看到「检查完成：2 项需要处理」（Codex CLI、Grok CLI 的连接设置），
  状态栏却是「环境正常」。`features/app/diagnostic-group.ts` 按同一次检查里 `CLI_*` 报的「没装」来分；
  Codex 那份配置 Codex 桌面端也读，桌面端装着时照旧算要处理。缺密钥、地址不对、检测出错的不动。不出新字。
- 启动提醒角落一次只摊开一张（`STARTUP_NOTICE_VISIBLE_LIMIT` 2 → 1），其余照旧折成「还有 N 条提示」，点掉一张下一张顶上来。
  yoyo 11-18 装 0.2.24 时「匿名使用情况」和「已更新到 0.2.24」两张叠在首页左下，盖住了工具卡和最近记录。
- 错误报告、使用统计两张登录后说一次的告知卡在 `startupNoticeRank` 里从最前（0）挪到最后（4）：同一次打开两张都在时先出「已更新」。
  两张告知卡要客户点了按钮才记「已告知」，排在后面、折起来没点到的，下次打开照样再说，默认值不变。
- 「已更新」卡去掉正文那句「这一版的主要改动如下，另外 N 项在……里可以看到」，改动没列全时多一颗「看全部改动」去
  「设置 › 版本更新」（沿用 `page` 动作，`section: 'version'`）；「匿名使用情况」正文从 120 字压到 84 字，
  发什么、不发什么、在哪关三点都留着（`startup-notice.ts`）。
- 首页页头不再说「运行环境正常」（yoyo 2026-11-26 回「页头不提环境」，方案第 2 条）：工具都配好时只写原来就有的「已安装的工具均已配置。」，`Home.tsx` 去掉只为这句算的 `nodeReady`。
  原来那句只看 Node.js 装没装，状态栏要等「检查」页跑完才变绿，同一屏两种说法。不出新字。
- 画图技能优化需求的六条 P0（A1 A2 C1 D1 D2 D3），细节见 `docs/NATIVE-IMAGE-MCP.md`。
- C1：画图工具（`bundled-skills/xingmang-ai/scripts/mcp-server.mjs`）不再把原图放进工具结果。原图存成新文件（工作目录的
  `outputs/`，没有工作目录时是系统图片文件夹里的「星芒AI」，再不行是临时目录；文件名带时间和型号，`wx` 方式打开、不覆盖），
  结果里只放一张最长边不超过 1024、不超过 300KB 的预览（不透明用 JPEG，透明底用 PNG）和一段固定文字。起因是新版 Codex
  桌面端（0.171 起）把约 1MB 以上的图片显示成 JSON 原文，且原图会跟着对话历史每轮重传。缩小和编码在新文件
  `scripts/image-preview.mjs`（纯 Node，PNG 解码、区域平均缩小、基线 JPEG 编码、PNG 编码），已加进
  `XINGMANG_AI_BUNDLED_FILES`。保存位置只由脚本决定，工具没有 `out` 参数。`size` 写了宽高又传 `aspect` 时比例一致不再报错
  （两个脚本都改）。`SKILL.md` 给 Codex 一段照抄的调用代码，「完成后」补上画图工具这条路。
- D1：两个脚本认出余额不足（`insufficient_user_quota` 和那几句原话，同 `relay-quota-failure.ts`）就只发一个请求，回带金额的一句话；
  密钥自己的上限用完照旧换另一把。
- D2：换型号只在型号现在用不了时（404、`model_not_found`、`model_price_error`、无可用渠道、No available compatible accounts）；
  点名的 gpt-image 型号用不了时也改用默认那一串（以前只用它、原样报错），点名 Nano Banana、Grok 的不换；
  换密钥只在 401、429、503 和余额不足以外的 403；网关错误、连不上都不换。换了型号在结果里说明。
- D3：`generate.mjs` 请求没发出去就失败时打固定诊断、退出码 3；已发出没等到回复的按可能已扣费处理，退出码 1。`SKILL.md` 加
  「失败时」一节，删掉「没有 Node 时再手写请求」；`references.md` 开头写明只是接口说明。
- A2：`SKILL.md` 的 description 和正文写明画图工具在 Codex、Claude Code 里的完整名字，以及没看到时先按 `xingmang` 搜一次全部工具。
- A1：登记画图工具时找不到系统 Node 就用 Codex 桌面端自带的那份（`xingmang-ai-mcp.ts` 的 `resolveXingmangImageNodeExecutable`）。
  没有用 `ELECTRON_RUN_AS_NODE`：发布包的 RunAsNode 熔丝是关的，不为这件事打开。开机补登记原来就有（恢复登录时会走到
  `syncImageMcp`），没有另加；卸载时清登记没做。
- 测试：`scripts/xingmang-image-mcp.test.cjs` 起画图工具时给它单独的工作目录和主目录；品牌门禁放行 `mcp-server.mjs` 里图片文件夹名
  那一处；三条旧用例的期望跟着 D2、C1 的新规则改了（网关错误不再换型号；点名的 gpt-image 型号用不了时改用默认那一串；
  `size` 与 `aspect` 一致不再报错）。
- 画图工具没有工作目录时的保存位置，从系统图片文件夹里的「星芒AI」改名为「AI画图」（`mcp-server.mjs` 的
  `PICTURES_FOLDER_NAME`）：这个名字会出现在交给客户的文件路径里，不带品牌名。画图技能「脚本里不出现品牌名」的门禁
  去掉了上一个 PR 给这个常量开的例外，恢复成一处都不许出现。`SKILL.md` 的保存位置那句补上文件夹名。
- 改图时没写的尺寸和比例跟第一张原图走（yoyo 11-27「改图保持原尺寸 赶进」）：画图工具 `mcp-server.mjs` 和脚本 `generate.mjs` 的 `resolveImageSize` 多收一个 `original`（`originalDimensions` 只读文件头，JPEG 按 Exif 方向 5～8 对调宽高，读不出照旧按默认出）。没写比例用原图比例（`ratioDimensions`：16 的倍数、长宽比最多 3:1、总像素在上下限之间），没写尺寸用原图长边、夹在 1024～2048（1K、2K 同价，要 4K 得写明）；写了宽高、`auto`，或档位和比例都写了的照写的出。Nano Banana 取比例表里最接近的比例。以前一律按 1024x1024 出，竖图改成方图、清晰度每改一次掉到 1K。`SKILL.md` 给 Codex 照抄的调用去掉了写死的 `size: "1K", aspect: "1:1"`（Codex 改图照抄它，工具这边改了也还是方图），旁边写明改图别为写全而填。两个脚本跑同一张用例表，另有随机输入测试钉住宽高合规、坏文件头不抛错。
- 画图技能 `SKILL.md` 加「写描述」一节（yoyo 11-27「技能写描述」，含画图优化需求 B2「没有图片路径时先问」、E2「改图怎么写描述」「不追问客户没提的参数」两处文案）：具体的照原意整理、笼统的才补场景/构图/光线/风格，不加客户没提的人物、品牌、标语、配色，图上的字一字不改，按原话画就原样用；改图只写要改的地方并写明其余不变；只在缺图、缺客户专属文字、没说画什么时问一句；「完成后」附上这次用的描述。`mcp-server.mjs` 的工具说明和 `prompt` 参数说明带上短版。思路参考 OpenAI Codex 的 imagegen 技能（Apache-2.0）和 shinpr/mcp-image（MIT），没有照搬原文。技能文件靠清单里的旧摘要自动更新，客户改过的不覆盖。yoyo 11-28 回「全补进」赶进 0.2.25；这一版给客户看的已满 60 句，客户那句并进了 `edit-keeps-original-size.md` 的「## 用户」。
- 启动检查超时后接着在后台查的那一次（`electron/updater.ts` 的 `startup()`），下不下改成按查完那一刻的自动更新设置定
  （11-18 复核 D23、0.2.25 总单第 30 项）。以前是在超时那一刻看设置、挂上回调，查完时不再看：超时到查完之间客户关掉了
  自动更新，迟到的结果照样在后台下安装包。现在关掉了就停在「有新版本」等客户自己点；反过来这段时间里刚打开的，
  打开那一下（`autoUpdateChanged`）还没有可下的版本，以前就一直等到下一次定时检查，现在查完接着下。
- 11-18 复核 O07（0.2.25 总单第二档第 29 项）：打开时自动装（`main.ts` 的 `considerLaunchInstall` / `startLaunchInstall`）以前只看
  工具安装队列，聊天在回复或出图、视频剪辑在拼接、画布在生成、付款窗口开着都照样关掉重开。`auto-update-install.ts` 的
  `decideLaunchInstall`、`shouldStillInstallAtLaunch` 加必填的 `working`，决定装之前、预告 5 秒后真去装之前都看。忙闲的来源跟
  重启装更新前那一问（D10）是同一份（`runningRestartWork`，界面报的 `rendererWork` 加画布的出图队列和运行），再加付款窗口；
  服务端在出的视频照 D10 不算，重开会接着取回来。
- 预告完真去装之前情况变了、这次没装的，新增 `undoLaunchInstallAttempt` 撤回预告前写下的 `attemptedVersion`（连同后台装那条），
  再收预告卡。以前这条「试过了」留着：跳框把这一版当成打开时装接手了，这次运行不再问；客户之后只关机不退出，下次打开还会
  说成「上次没装上」、只留「重新安装」。现在跳框会等聊天、付款这些做完再问。这一处对原有的几种退让（预告时开始装工具、关了
  自动更新、版本被撤回）同样生效。
- 11-18 复核 N5（0.2.25 总单第二档第 22 项）：命令行工具和 Codex 桌面端的「打开」改成在 `cli:launch` / `desktop:launch-codex`
  处理器一进来就 `accountWork.queue()` 记下点的时候是哪个账号（`electron/ipc/handlers/launch.ts` 的 `launchForClickedAccount`）。
  以前要等查续聊记录、打开前试写、问文件夹这些都做完、真要排进安装队列时才记，这中间换了账号，上一个账号点的「打开」就按新账号的配置打开。
  现在换账号一开始（quiesce → `abortQueued`）这次点击就作废，查记录、试写回来先核对一次，不再弹后面的提问框；问完文件夹再换的，
  由队列里那道 `run` 拦下，都回已有的「账号刚切换过，请再试一次」。记下的这份照旧不算账号工作，换账号不用等它（#1085），
  请求一结束（打开了、先不打开、出错）都交还。
- 作品库列表（`ai-asset-index.ts` 的 `indexOwnedAssetFiles`）读每个文件的创建时间改成一次 8 个并发（`mapWithConcurrency`，按 64 个一窗），先后、同一编号取最新那份、读到一半文件没了就跳过、上限这几条跟原来逐个读一模一样，到上限时最多多看一窗。「创作」页每次切回窗口都会重读作品库（画布窗口里出的图只靠这一下才看得见，所以不改成跳过），以前几千个作品在 Windows 上逐个读要几秒（创作页复查第 4 条）。
- 手机遥控（M02，11-18 手机遥控专项）：`turn/start` 等满 60 秒没回执就当失败，这一轮收掉、对话丢掉；Codex 那边若其实已经开始做，
  那一轮在手机看不见的地方接着跑、接着扣钱，回执晚到也没人接。现在 app-server 客户端把「到点没回执」单独报成
  `AppServerTimeoutError`（明着拒绝的照旧是 `AppServerRequestError`），遥控记下这份对话（记 `remote.turn-start-timeout`），它再冒出哪一轮
  的通知就拿那一轮的编号补一次 `turn/interrupt`（记 `remote.late-turn-interrupted`），只补一次。手机上那句「没做成」照旧。
  `electron/codex-remote-service.ts`、`codex-remote-app-server.ts`，不加新字。
- 手机遥控 M04（11-18 手机遥控专项；yoyo 2026-11-22 北京 21:47 回「遥控三处都改」，新字北京 14:35 逐字贴出）：一条消息里带的图
  一张都没收下（取不到、太大、攒满、认不出）时，同来的字是要做的事就不交给 Codex（它没看到图也照样开干），回「图片均未接收成功，
  本条消息中的文字未发送给 Codex，请重新发送图片和文字。」；同来的是指令（如「状态」）照常回；收下了几张的照常带着交出去；没配存图
  的地方照旧只回不支持那句。`electron/codex-remote-service.ts`、`codex-remote-text.ts`。
- 手机遥控 M06：换了工作文件夹（电脑上「用这个」、手机上「文件夹 N」、电脑页或手机上接了别的文件夹里的对话）跟「新对话」一样清掉
  攒着还没用的图（`leaveFolderWork`），手机上换的、有图被清掉时在「已切换至…」后面接「此前发送、尚未使用的图片已清除，如需使用请
  重新发送。」；上一句不留给「重试」，换过以后发「重试」回「文件夹已切换，上一条消息不会在新文件夹中重新执行，如需执行请重新发送。」，
  在新文件夹里再说一句后「重试」照常。
- 手机遥控 M18：手机上发过「文件夹」，「文件夹 N」就按那份单子取第 N 个（`folderChoices`，新对话、换人时清掉）；没发过照旧按电脑上
  现在的单子。取到的那个已在电脑上移除时回「电脑端的文件夹列表已变更，请发送「文件夹」重新查看。」。三处共 4 句新字，只改手机上
  收到的话，电脑界面不动，没有新通道。
- 手机遥控（M07，11-18 手机遥控专项）：电脑上「用这个」换文件夹（还有手机上「文件夹 N」、电脑页「选择对话」）先查过没有正在做的、
  再写设置、丢掉旧对话；写设置那一会儿手机上发来的话照旧在旧文件夹开了对话，写完这边把对话编号清掉，那一轮结束的消息按编号
  找不到人，卡在「正在处理」直到 1 小时的卡死计时把它收掉。现在换的那一段登记在 `folderSwitches` 里（查和登记是同一步），
  `runPrompt` 等它换完、按换好的设置开这一轮。`electron/codex-remote-service.ts`，不加新字。
- 手机遥控（M10，11-18 手机遥控专项）：微信长轮询在本机等到超时，`fetchWeixinUpdates` 原来交回一个跟「微信说没消息」
  一样的空批，渠道接着报「已连上」。网断成请求一直不回的样子时，从没收到过微信的回应，卡片也变绿，手机上还会被当成
  刚连上去发「已打开」、补发没送到的回答。现在超时交回的空批带 `timedOut`，渠道不拿它报连上、也不清掉已经报的错；
  连着两次超时（约一分半钟没有任何回应）报「连不上微信，正在重试」（原有的字）。真收到微信回应才报连上。
  `electron/codex-remote-weixin-api.ts`、`electron/codex-remote-weixin.ts`，日志多一个 `weixin-poll-timeout`。
- 手机遥控（M11，11-18 手机遥控专项）：微信扫码时输完手机上的数字、交上去那一下断网，主进程回「连不上微信，正在重试」、
  阶段还是「要输数字」，并带上 `retryAfterMs`；界面只看阶段，「要输数字」不接着问，那句「正在重试」挂着却再也不问。
  现在界面认 `retryAfterMs`（`weixinLoginRetrying` / `weixinLoginPollsAgain`，`WeixinRemoteSection.tsx`）：主进程叫重试就
  过一会儿再问，主进程留着交上去的数字接着验，网络恢复后自动往下走；重试期间数字框和「确认」先灰掉，免得以为还要再输。
  不加新字，主进程不改，补了一条钉住「断网后数字还留着、下一次照样带上」的用例。
- 手机遥控（M12，11-18 手机遥控专项）：微信扫码登录在微信那边已经确认、正在存登录信息时，点「取消」原来先把这次登录放掉、
  记成已取消，存完却照样登录好（过了手机上那串数字的还直接绑了人）；紧接着再扫码时，新的一次读到的是存完以前的登录，
  两次保存抢着写，最后留下哪份看谁慢。现在 `codex-remote-weixin-login.ts` 把「开始存」当成这次登录的提交点：存的过程中
  点取消不再装作取消（记一行 `weixin-login-cancel-while-saving`），照常存完、记成登录好，卡片随后显示已登录；再扫码先等
  上一次存完再开始；存的过程中又来一次查询直接等结果，不会再走一遍确认、存第二次。存之前点取消照旧当场取消、不存。不加新字。
- 手机遥控（M14，11-18 手机遥控专项）：电脑上关掉遥控以后，发件队里还没轮到的回答、进度卡、审批卡照样一条条发出去，飞书、微信
  正在等重发的那条也照样补发，手机上先收到「已关闭」又冒出别的；道别那句排在它们后面，前面有一条卡住就等满 1.5 秒发不出去；
  关了马上再开，新连接的「已打开」也排在旧的后面。现在 `disableChannel` 先把连接从渠道上摘下、发件队作废（`outboxEpoch`，
  丢掉的记 `remote.send-dropped`），再让连接放弃等着重发的（渠道接口新加可选的 `cancelPendingSends`，飞书记
  `feishu.send-cancelled`、微信记 `weixin-send-cancelled`），道别不进发件队、直接交给要关的那份连接，发完或到点后再放弃一次、
  停掉连接。这 1.5 秒里电脑上又打开了，只停旧连接，新的不受影响。已经发出去、还在等平台回应的那一次收不回来。
  `electron/codex-remote-service.ts`、`codex-remote-channel.ts`、`codex-remote-feishu.ts`、`codex-remote-weixin.ts`，不加新字。
- 手机遥控（M15，11-18 手机遥控专项）：快照的版本号原来在读完设置和每个渠道的凭据之后才加一，两份快照同时在读时，先开始、
  读到旧设置的那份如果后读完，反倒拿到更大的号，页面按号收下的是旧的（刚改的权限、文件夹又变回去）。现在 `snapshot()` 一开始
  就定下版本号；推给页面、托盘和防睡眠的那份比已经推出去的旧就不再推（托盘、防睡眠不比版本号，拿到哪份信哪份）。顺手收掉同类的一处：设置第一次读盘还没回来时又读又改，各读各的那次会把中间刚写好的设置盖回缓存里的旧样子，
  `CodexRemoteStore` 现在同一时间只读一次盘，后来的读和改都等这一次。`electron/codex-remote-service.ts`、
  `codex-remote-store.ts`，不加新字。
- 手机遥控（M16，11-18 手机遥控专项）：手机遥控页第一次读状态走 `useResource`，读回来直接整份放上去，不跟手上的比版本号；
  读的时候主进程先推来一份更新的（比如刚连上、Codex 启动失败的黄条），读回来的旧快照会把页面退回去，同一时刻状态栏
  （`useCodexRemoteActive` 比了版本号）却是新的。现在页面收到的每一份（事件、操作返回、第一次读取）都先过
  `createRemoteSnapshotKeeper`，第一次读取交给页面的是至今最新的那份。`src/renderer-v2/features/settings/codex-remote/`，
  不加新字，版面不变。
- 手机遥控（M17，11-18 手机遥控专项）：飞书进度卡最后那次更新（改成已完成、已停止、未完成，去掉「停止」按钮）没成时原来只记
  `remote.progress-failed`，卡片一直停在「正在处理」。现在隔 5 秒、30 秒各再改一次（记 `remote.progress-final-retry`），三次都不成
  才算了；渠道关了或换了连接就不再试。改的是同一张卡的整份内容，多改一次不会多出东西；最后的回答本来就另发一条，不等这张卡。
  `electron/codex-remote-service.ts`，不加新字。
- 手机遥控（M19，11-18 手机遥控专项）：手机上发「状态」时的余额跟画布余额条用同一份读取，那一次读失败时照旧交回上次
  读到的数和读取时间。画布那边会写读取时间，手机上只有金额，一小时前的数看着就像现在的余额。现在 `main.ts` 交给遥控的
  余额过一道 `freshCanvasBalanceUsd`（`electron/canvas-account-summary.ts`）：读取时间不在 30 秒内的不给，「状态」里那行
  余额不显示（原有逻辑，没读到余额时就不显示），不加新字。换号、退出照旧清掉旧金额。
- 手机遥控（M21，11-18 手机遥控专项）：飞书、微信「退出登录」时凭据删掉了、接着写设置失败（盘满、文件一时被占），
  `saveChannelCredential` 原来在停渠道之前就抛错：渠道带着内存里的凭据照样开着，手机发来的话仍会执行，设置里绑定的人也没清。
  现在跟凭据删不掉那种（#1407 P3-6）一样，停渠道照做再把错报出去，日志记 `remote.logout-settings-failed`。另外两处跟着收：
  没有凭据时快照里不显示绑定的人（盘上没清掉的那个不再出现在卡片上）；退出以后再登同一个账号算重新登录，不接着用盘上
  留下的绑定，要重新配对。`electron/codex-remote-service.ts`，不加新字。
- Mac 验收 R1：Mac 上命令行里找到的 Codex / Grok 不是 npm 装的、又核不出是官方安装器那一份时（布局对不上、
  签名不是 OpenAI / xAI 的、报的版本和目录写的不一致），以前首页照样给「打开」、点了只说没打开成。现在
  `tool-installation.ts` 把这几种归成 `UnrecognizedDarwinCliError`（中文一句，原因留在 `cause`），扫描时
  `ToolStatus.unrecognizedInstall` 带给首页，卡上写「非星芒安装，无法在星芒中打开」、主按钮换成
  「使用星芒安装」（走安装），切账号的来源牌、「重新安装」和外部来源那句提示不出。抄盘、起进程这类说明不了来路的失败不算，照旧按原样报。
- Codex、Grok 签名或版本没过的那几处改抛 `DarwinCliProvenanceError`（`macos-code-signing.ts`），好跟 I/O 失败分开；判定本身一条没放宽。
- 认不出的 Codex 不再被「不会另装一份」拦（`cli-install-service.ts` 的 `assertNpmChannelOwnsCli`）：星芒的 npm 目录在
  `darwinCommandPathCandidates` 里排在前面，装好以后找到、打开的都是星芒那份。Grok 装之前先看 `~/.grok/bin/grok`：
  被手做的绝对链接或普通文件占着、npm 的安装脚本盖掉就放不回去的，一个字节都不下就停，说清楚先用原来的方式卸载。
- xAI 官方安装脚本现在（核对时 stable 是 1.0.89）把程序放成不带版本号的 `~/.grok/downloads/grok-macos-<arch>`，`grok` 和 `agent`
  两条链接都指向它。`macos-grok.ts` 认这种布局：版本不再从文件名读，改成核过 xAI 签名的私有副本跑一次 `--version`，
  按文件身份缓存（最多 8 条，文件一变就重核）；带版本号的老布局照旧不跑程序。这种布局的卸载不在这次范围内，仍按原来的拒绝走。
- 测试机那份 Codex 其实是 OpenAI 同一版本里另发的 provisioned 包（`bin/codex` 是固定的 sh 启动脚本，本体在
  `CodexCLI.app`），被别的软件解到了 `~/.local/share/openchatcut-codex/<版本>`。yoyo 11-20 定不放宽「只认官方安装文件夹」
  这条位置限制，这种照旧按认不出处理、首页给「使用星芒安装」，别再当缺陷去认它。
- Mac 开发版首屏那条用例（`e2e/macos-dev-origin.test.mjs`）不再连生产：改用 `withSignedOutSmokeIsolation` 启动，
  账号站点的公开状态由夹具答，别的请求一律拒绝，只放行这次用例自己的本机开发服务器（这个工具新加 `rendererOrigins`，
  只认 `http://127.0.0.1:端口`）。每一步完成时打一行用时，绿的时候也打一行时间线（欢迎页进 DOM 和看得见的时刻、
  加载完之后页面又拉了哪些模块、页面长任务、主进程和测试进程的卡顿）；欢迎页 5 秒没出来时，报错里再带上屏幕上有什么、
  主进程和开机那五条读取回没回话、Vite 有没有重载或没回的脚本、主进程最后几行输出。没调超时，没跳过测试。
  11-20 在 #2025 上红的两次，查明是那个 PR 把客服二维码改成按需加载引起的，见 `docs/TEST-BASELINE.md`。
- Mac 发布的两个 DMG 改成 LZMA（ULMO）压缩：`scripts/run-macos-free-build.cjs` 在改芯片名之后、产物校验之前调新增的
  `scripts/compress-macos-dmg.cjs`，用 `hdiutil convert -format ULMO` 转一份、核对 `hdiutil imageinfo` 报的格式再换回原名，
  校验照旧挂载、检查转换后的那一份。拿 0.2.24 正式包估：Apple 芯片约 136 MB → 95~103 MB，Intel 约 143 MB → 105~115 MB；
  实际数字打在打包日志里。electron-builder 26.15.3 的 `dmg.format` 不认 ULMO（26.18.0 起才认），升级又要重做按源码钉死的
  `patch-builder-fetch-compat.cjs`，所以单独加一步。ZIP 不动，自动更新不受影响；ULMO 要 macOS 10.15 以上，星芒要求 13 以上。
- 添加或更换 MCP 时 `codex mcp add` 失败，`electron/codex-extensions.ts` 会读一次列表看新配置是不是在失败前已经写进去了。
  以前 stdio 那条只比命令、参数和环境变量的名字，不比值：只换密钥（名字不变、值变了）却没写成功时，旧条目照样过关，
  界面提示保存成功，实际用的还是旧密钥（11-18 复核 O10、0.2.25 总单第 27 项）。现在连值一起比，值只在主进程里拿
  `codex mcp list --json` 原样给的条目比，回渲染层的列表照旧只带名字；值读不出来（不是名字对字符串的表）当作没写成，照原样报错。
- 构建依赖审计里 minimatch（GHSA-g3hv-75wg-m249）的临时放行删掉（原定北京 11-30 到期，到期后所有 PR 的 audit 作业都会红），
  0.2.25 总单第一档第 3 项、依赖深查 DEP-4。`package.json` 的 overrides 按版本只换两家：app-builder-lib 用的 `minimatch@^10.2.5`、
  @electron/universal 用的 `minimatch@^9.0.3` 都换成 11.0.5；glob 7、@electron/asar、dir-compare 用的 3.1.5 和 filelist 用的 5.1.9
  不在公告范围里，照旧。锁文件多一个 `@isaacs/nonrecursive-glob-match`（minimatch 11 的依赖），少两个旧的 brace-expansion / balanced-match。
- 打包前后比对（同一份编译产物）：Linux、Windows 的目录包逐个文件比 SHA-256，app.asar 里也逐个文件比，唯一的差别是包里 `package.json`
  的 overrides 多了这两行（Windows 的 exe 因为内嵌的 asar 校验值跟着变）。Mac 没在容器里打包：打包规则里没有按平台变的宏，
  拿 app-builder-lib 自己的过滤代码在 darwin / linux / win32 三种设定下、用 10.2.5 和 11.0.5 各跑一遍全部打包规则，选中的文件一个不差；
  Mac 包交给 CI 的三个打包作业。
- 0.2.25 总单第 47 项（11-18 复核 N11）：引导最后一步点「打开」，主进程在「这个文件夹不建议打开」「文件夹不让写入」那两问里
  被点了「先不打开」时回 `{ declined: true }`（`electron/ipc/handlers/launch.ts`），可 `useToolLaunch.ts` 的 `openTool` 只看账号换没换，
  照样回 true，引导就清掉进度、整个关掉，客户以为走完了。现在 `openTool` 看到 `launchDeclined(result)` 回 false，
  引导停在「准备就绪」，再点一次打开了才算走完。首页、托盘那几处不看返回值，行为不变；记录页「继续对话」本来就认 declined。
- 用例：`testing/app-check.mjs` 加一条（夹具 `?launchDeclined`，头一次打开回 declined），在旧代码上红（引导被关掉、`start-guide` 找不到）。
- 给客户看的那句并进了 `video-studio-caption-fade-black.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 视频片段交给服务端前，主进程那条「交出去了、还没回音」的记录（`AiVideoTaskStore.markUnconfirmed`）写不进去时，照旧不拦这一单，
  但不再只丢提醒（11-18 复核 N2 的残余，0.2.25 总单第 42 项）：`generate` 在 POST 前通过新的可选回调
  `AiVideoProgressObserver.onSubmissionUnrecorded` 告诉页面，`video:progress` 事件多一个可选字段 `unrecorded`（不加通道）；
  转发器发完过 500 毫秒再让页面存储落一次盘，强退也不丢。结果真成了「结果不明」时主进程再补写一次那条记录
  （杀毒软件占一下这类多半过得去），写进去了重开以后主进程自己就能照实答。
- 视频剪辑页把这一笔记在镜头上（`VideoStudioShot.unrecorded`，跟请求号一起存），等到这一单的结果就去掉。重开以后先拿请求号去主进程接
  （任务、出好的片段、结果不明的记录）；主进程查不到又有这一笔，按「提交结果不明」收尾，再生成时确认框照旧说清可能多扣一次并沿用请求号。
  沿用请求号重新出着的那一单存的时候同样记成 `unrecorded`：上一次的那条记录主进程也可能没写进去，重开以后查不到不能当没发过。
  没有这一笔的镜头（主进程记下了，或者页面等到过结果）查不到照旧回到「还没生成」，老版本存的工程不受影响。
- 0.2.25 总单第 21 项（11-18 复核 N3）：个人中心「充值订阅」点「购买」，框里摆的是打开那一刻的套餐，之后套餐列表在后台重读
  （窗口回到前台、付款结果回来）框里也不跟着换；点付款时直接拿套餐编号下单。服务端两边都只认编号、照当时的价扣
  （new-api `SubscriptionRequestBalancePay` → `model.PurchaseSubscriptionWithBalance(userId, planId)`；历史账号的在线下单只带
  `plan_id`），余额买又是直接扣、后面没有支付页再让客户看一眼，所以框开着时后台改了价，客户看到 ¥29、扣的是 ¥39。
- `features/account/recharge.ts` 新增三个纯函数：`followPurchasePlan` 按编号拿后台现在那份跟框里的比，分成没变 / 价格或币种变了 /
  价格没变但时长、额度、额度重置规矩变了 / 下架了四种；`purchasePlanNotice` 给出框顶那条的字；`purchaseMethodFor` 是原来
  `openPurchase` 里挑默认支付方式的那一句，加了「框开着时套餐换了，客户选好的还能用就不动」。
- `AccountRecharge.tsx`：点付款先再读一遍套餐列表（`getAccountSubscriptionPlans`），对不上就不下单，框里换成新那份、框顶摆一条提醒，
  客户再点一次才下单；下架了付款按钮灰着，框开着时又上架了就收起那条。套餐列表在后台重读回来时框里同样跟着换。读套餐列表失败就不下单，报读的那个错。
  只动渲染层，主进程、IPC、`sub2api-relay-backend.ts`、服务端都没动。
- 新字（yoyo 11-21 要书面口吻，重写后等他回「订阅正式改」）：「价格已更新」「价格由 ¥29 调整为 ¥39，请确认后重新支付。」
  「套餐内容已更新」「套餐的时长或额度已调整，价格不变，请确认后重新支付。」「该套餐已下架」「请关闭此窗口，选择其他套餐。」
- 用例：`recharge.test.ts` 钉住比对、提醒的字和支付方式怎么挑；`e2e/v2-business.test.mjs` 三条浏览器用例（点付款时发现涨价、
  框开着时窗口回到前台重读、下架了又上架），在旧代码上全红。`e2e/v2-business-fixture.tsx` 加了 `subscriptionPlanHarness`
  模拟后台改价、下架、又上架，`planBalancePay` 让那个套餐能用余额买。
- 0.2.25 总单第 20 项（11-18 复核 N6）：星芒账号在个人中心改密码，`PUT /api/user/self` 已经发出去、服务端也存好了新密码，
  回话却没到（超时、连接被切断、网关 502/504、门户页），处理器只在成功时才改「记住密码」，于是本机记住的还是旧密码，
  下次登录自动填上就登不进。找回密码第 3 步那条路 #1481 已经靠「拿新密码试登」盖住，个人中心这条一直没有。
- `new-api-client.ts` 的 `changePassword` 多一个可选的 `onOutcome` 回调，报告改密码那一下走到哪了（`NewApiPasswordChangeOutcome`）：
  发出去之前报 `unconfirmed`；服务端明说没存（rc.44 `UpdateSelf` 存密码之前的那些拒绝：入参、安全凭证、原密码、密码规则，
  都是 500 以下、不带 `AUTH_` 开头错误码的 JSON；限流和网关在前面挡掉的不是 JSON 的 4xx）报 `refused`；明说存好了报 `changed`。
  存好以后还可能失败的那两步（`PublishUserAuthCache`、`AdvanceCurrentSessionToUserVersion`）走 `writeAuthSessionError`，
  回的是 `AUTH_*`（401/409/429/500），跟鉴权中间件在前面拒绝时用的同一套码，分不出来，所以不算明说没存。
  401 照旧续登录后整个重来一遍；前一遍没等到准话的，后一遍再被拒也不改口报 `refused`（多半是前一遍已经改好了，后一遍的原密码才对不上），
  只有明说存好了才算数。改密码本身照旧不自动重发。
- `ipc/handlers/account.ts` 的 `account:change-password`：失败时看回调报到哪一步。`unconfirmed`：本机记住的若是这个账号的，清掉，
  不留一个可能已经失效的旧密码，也不把没确认过的新密码当成功记下；`changed`（服务端已存好，后面登录换了人才报错）：照成功那样换成新密码；
  `refused` 或者根本没发出去：不动。认账号沿用 `rememberedLoginNamesAccount`，处理中换了账号不会清掉别的账号记住的登录。
  `relay-backend.ts` 的 `RelayBackendClient.changePassword` 跟着加这个可选参数，`realm-account-service.ts` 的代理原样转交，
  账号切走后结果被换成 STALE，处理器照样能知道密码已经改了。
- 说法（yoyo 11-20 回「密码改」批的）：`unconfirmed` 时处理器把报错换成 `passwordChangeUnconfirmedMessage`「没等到账号服务的回话。」
  （新文件 `electron/password-change-unconfirmed.ts`，进渲染层名单；原来的报错挂在 `cause` 上，日志照旧记得住线路、状态码和请求编号）。
  「账号安全」改密码框认出它（`features/account/account-center.ts` 的 `passwordChangeFailure`），红字换成
  「没等到账号服务的回话，新密码可能已经改好了。先别再改一次：下次登录时先试新密码，登不上再用原来的密码。」
  以前这里说「连接账号服务超时，请检查网络后再试」，客户照做再改一次，原密码那格填旧的就被说成「原密码错误」。
  找回密码第 3 步不认这句，仍按「结果不明」去拿新密码试登；只有试出新密码没设上那一支会显示「设新密码没有成功：没等到账号服务的回话。」。
- 历史账号不在这次范围：它的客户端把「原密码错误」和连不上都报成同一个 `NETWORK`，分不出有没有改上，`sub2api-relay-backend.ts` 也不改，
  所以它不报 `onOutcome`，失败时跟以前一样不动记住的密码。
- 用例：`new-api-client.test.ts` 按回话逐种钉住报告（成功、各种存之前的拒绝、断连、超时、502/504、存好后的 `AUTH_INTERNAL_ERROR`、门户页、
  401 后重来被拒、401 后重来成功）；`ipc.test.ts` 钉住处理器三种走向和不碰别的账号，其中「没等到准话就清掉」「已存好就记新密码」两条在旧代码上红；
  `realm-account-service.test.ts` 钉住账号切走后回调照样送到；`account-center.test.ts`、`features/auth/state.test.ts` 钉住两处说法。
- 11-18 复核 N7（0.2.25 总单第 23 项）：`features/chat/state.ts` 的 `planTurn` 以前不管模式都按整段前文查条数、总字数和
  单条回复长度，可生图只发这一句描述和参考图（`useChatController.ts` 的 `imageInput`），前文一条都不带，长对话里切到生图
  写一句短描述也弹「这段对话太长了」。现在这两道只在文字模式查；生图的描述照旧受单条上限管，重新生成按那条回复当时的模式算。
- 工具的密钥换了分组重签时，新那把照抄旧那把此刻的限制（11-18 复核 O03、全面检查 I-3）：设了上限只给剩下的额度，
  设了到期日照旧到期，并且一定新签（`fresh`），不拿同组里一把不限额的同名 Key 顶替。历史账号买订阅、订阅到期，
  分组改名、被删都走这条（`account-cli-provisioner.ts` 的 `resolveManagedCliKeys`，以及配置时被拒 401/403 换组重签那条）。
  以前只传名称和分组，新 Key 一律不限额、永不过期。
- 旧那把上限已经用完、已经到期的不换组，照现成的话报（`managedKeyQuotaExhaustedMessage`、两站各自的「停用或到期」那句）；
  查不到旧那把的限制（密钥列表请求失败）也不换，照实报错、下一轮再试，不退成不限额。网页上已经删掉的没有限制可抄，照旧签。
  这几种情况旧那把留在本机缓存里（这一轮不交出去），不然下一轮认不出是换组，会照常签一把不限额的；三把都缓存的 xm 账号
  分组被删时改成十分钟后再查一次。
- 两个后端签 Key 时本来就收 `remainQuota` / `unlimitedQuota` / `expiredTime` / `fresh`，`sub2api-relay-backend.ts` 没动。
  带了限制的工具每换一次组会多出一把新 Key（历史账号的旧那把照旧不删），不限额也不到期的照旧复用同组那把。
- 0.2.25 总单第 19 项（11-18 复核 O08，全面检查 A-1）：开机恢复联不上、挂着「等自动重试」时，客户自己又登了同一个号。
  重试那次续期晚回来，`electron/bootstrap/accounts.ts` 的 `onCredentialRotation` 只按账号编号找记录、不看它还是不是出发时那份，
  把旧登录换来的凭据写进本机，盖掉了刚登的；内存里是新登录，重启后拿旧凭据恢复，服务端已经注销了它，就被退出来。星芒账号和历史账号两边都会。
- 账号库多一个 `rotateCredential(owner, expected, next)`（`electron/realm-account-vault.ts`）：比较和写在同一步里，
  记录里还是 `expected`（这次续期交出去的那份）才换成 `next`，已经是别的登录就不动、回 `superseded`，只换凭据、记录里别的字段不动。
  星芒账号的客户端续期时把交出去的那份作为 `onCredentialRotation` 的第二个参数一起给（`electron/new-api-client.ts`）；
  历史账号的客户端不改（`sub2api-relay-backend.ts`），在 `accounts.ts` 里记着它手上那份。被拦下时运行日志记
  `account/session.rotation.superseded`（只记站点，不记凭据），晚回来的候选照旧由 `retryStalled` 丢掉。
- `realm-account-service.ts` 的 `keepRotatedCredential`（重试接不上时把换来的凭据写回）原来先读再写，那次登录正好落在两步中间也会被盖掉，改用同一个方法。
- 用例：`electron/bootstrap/accounts.test.ts` 用真的账号客户端和账号库、假的网络走一遍「开机联不上 → 重试续期卡住 → 客户登同一个号 → 续期回来 → 重启」，
  两个站点各一条，在旧代码上都红（库里留下的是旧登录的凭据）；`realm-account-vault.test.ts` 补了这个方法的用例和一条随机输入用例。
- 给客户看的那句并进了 `canvas-kernel-v0-1-17.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- `canvas-project-asset-manager.ts` 按「账号 + 类型 + 素材编号」记着每个素材在哪个项目（O14，11-18 复核仍存在）。
  复制项目时素材连编号一起拷进新文件夹，原项目的文件挪走、删掉或所在的盘拔了以后，记着的位置读不到就直接报错，
  不再去别处找：副本自己的文件明明在，画布和作品库里预览（`xingmang-asset://`）、缩略图都出不来。
  现在 `readOwned`、`readOwnedVideoRange`、`resolveOwnedFilePath` 共用一个 `locate`：记着的位置读不到就忘掉它，
  接着照没记过时的顺序（全局作品库，再挨个项目文件夹）找，跳过刚失败的那一处；哪儿都没有时报记着的那处原来那句话，
  客户看到的报错跟以前一样。每一处仍由自己的作品库做完整的文件检查（多链接、符号链接照旧拒绝），只在这个账号自己的作品库里找。
- 审查总表 O17（0.2.25 总单第四节 W13，设计由 Claude·win 牵头）：本地技能导入全程只复制当初核过的那份内容，期间有变化就停止，不留半成品。
  新模块 `electron/skill-import-snapshot.ts`，`codex-extensions.ts` 的 `resolveSkillImportSource` / `stageSkillImport` / `commitSkillImport` 改用它；
  Codex 的 `importSkill`、Claude Code 和 Grok 的导入（`provider-extensions.ts`）、「从压缩包导入」解开的那份都走这里，`forgetSkillEnablement` 的时机不变。
- 用例：新增 `electron/skill-import-snapshot.test.ts`；`codex-extensions.test.ts` 补两条（旧代码上红），`provider-extensions.test.ts`、`skill-archive.test.ts` 各补一条。
- 没做：卸载技能跨盘时退回到「复制再删」那条（`moveSkillToTrash`）处理的是受管目录，不算导入，照旧。
- 删掉 `assets/` 根目录四个早就没人读的旧紫白图标（`icon.png`、`icon-white.png`、`windows-icon.png`、`icon.icns`）。
  打包配置的 `assets/**/*` 会把它们整个打进 `app.asar`，Windows 和 Mac 安装包各白带约 3.1 MB（拆 0.2.24 正式包量的）。
  新增 `scripts/packaged-assets.test.cjs`：`assets/` 根目录不许放散文件，主进程和 electron-builder 要读的图标都必须在。
- 出图回的是临时链接时，下载没成不再一次就放弃（`electron/ai-asset-store.ts` 的 `downloadRemoteImage`）。起因是 11-25 一位客户在画布里用 2.5 Flare 改图：
  「图片模型」分组的渠道 75 回了临时下载链接，星芒拿到链接约 2 秒去下就失败了，$0.20 已扣、图找不回；同一个人几分钟前同样的链接都下成功了。
  现在链接还没生效（404、403）、对方忙（408、425、429、5xx）、连不上、解析不出、读到一半断了、内容为空时，隔 2、5、10、20 秒再试，
  最多试 5 次，全部算在原来那 120 秒下载时限里，不会比以前等得更久。解析到私网（安全校验）、类型不对、超过 64 MB、
  重定向出错、对方明确拒绝（400、401、410 这类）照旧当场失败，不放宽任何校验。
- 重试完仍没下来时写一条运行日志 `image.download.failed`（对话页记在 `chat`，画布记在 `canvas`）：试了几次、链接的域名、
  底层网络错误码、中转用量记录的请求编号和失败原因（`ai-image-service.ts` 的 `buildImageDownloadFailureLog`）。
  不记完整链接（里面带签名），原因里万一带了链接也换成占位。以前画布这条路失败时只留界面上那句话，查不出是 404 还是连不上。
- 构建依赖审计里 picomatch（GHSA-fc5q-39xc-vjpf）的临时放行删掉（原定北京 12-15 到期）。GitHub 11-18 撤回了这条公告，
  picomatch 维护者在 micromatch/picomatch#235 说不收不可信的 glob 规则就不是漏洞，npm audit 从此不再报它；
  picomatch 没发新版，树里还是 4.0.5，依赖不动。放行表现在是空的，npm audit 报出任何一条公告都会让审计变红。
- renderer-v2 新页 `features/extensions/PluginsHub.tsx`（`page-extensions`，侧栏一行「插件」接在第一组最后），照扩展合并方案第二版（yoyo 2026-11-20 回「改」）：
  左边窄栏（插件 / 技能 / 已安装），右边「推荐」「自己加的」，三家的外接工具、插件、技能按「种类 + 名字」合成一条；安装框、从所有工具里移除、技能导进几家都是一家一家调现有的
  `mcp:add` / `extensions:mutate` / `extensions:copy-mcp` / `skills:import`，没有新 IPC 通道。
- `registry/pages.ts` 加 `extensions` 页和 `extensionPageAliases`：`featured` / `mcp` / `skills` / `plugins` 四个旧 id 留作别名，跳过来落到新页对应那一栏。
- GPT 官方插件图标：`scripts/build-plugin-icons.mjs` 发版前按 openai/plugins 快照生成 96×96 PNG 进 `bundled-catalog/plugin-icons/`（带 sha256 索引，SVG 带脚本、外链的拒收）；
  Claude 官方按名字对上 `simple-icons`（`registry/plugin-icons.ts`）。新令牌 `--surface-logo-tile` 给图片图标垫白底。
- 「插件」页合并收尾：删掉已经进不去的旧四页（`features/extensions/ExtensionsPage.tsx`、`pages-featured.tsx`），连同只有它们用的
  `CuratedShelf`、`ExtensionCard`、`groupExtensionItems` 等函数、`extension-tool-intent.ts` 里按工具落页那一半和 `extensions.css` 里旧页的样式；
  `pages-management.tsx` 只转出记录页。四个旧页 id 照旧是「插件」页的别名。e2e 业务夹具里原来按旧页渲染的用例搬到新页上测同一件事；
  新页三个移除确认框补回旧页那句「上一个操作还没完成，完成后才能移除。」（插件写「卸载」，沿用旧页的字）。
  `pages-business.tsx` 里 `pages-maintenance` 挪到 `PluginsHub` 前面 import，业务页那份样式表跟删之前逐字节一样。
- 「插件」页合并收尾（#1993 之后）：`registry/tutorials.ts` 的「外接工具」「技能」「插件」三章按新页面重写（章 id 和 `page` 别名不变），
  `TutorialIllustration.tsx` 三张示意图跟着换；反馈页「去外接工具」、首页 Python 那行、卸载插件 / 添加插件提醒、连接「更新状态」里的旧名字改掉。
  产品负责人 2026-11-20 回「插件教程改」，逐字对照在项目文件 `0.2.25-方案/扩展合并/教程改字.md`。
- 首页「打开」先进设置页刚换的项目文件夹（0.2.25 总单 Q1）：设置页「更换」经 `settings:save` 带 `workspaceChosen`，
  主进程按自己的时钟记成 `AppSettings.workspaceChosenAt`（渲染层给不出时间）；`workspace` 被首页「选择其他文件夹…」、
  新建项目文件夹换成另一个文件夹时去掉。`config:get` 与 `cli:launch` 的结果多带 `rememberedWorkspaceChosenAt`，
  `launchWorkspaces` 在它比这个工具最近一条对话还新时把设置页换的文件夹排到最前面，之后又在别处用过以那次为准。
  首页卡片、引导最后一步、托盘和快捷键打开都走这一条；设置页换完重读一次配置，首页马上换。没有新通道，没有新字。
- 个人中心 › 密钥管理：停用（2）、已过期（3）、额度用完（4）的那一行，在「配置到工具」前面多一颗「启用」（0.2.25 总单 Q2）。
  只有星芒账号有；历史账号的后台在 `sub2api-relay-backend.ts`，这次不动，那边不摆这颗按钮（`keyCanEnable`）。
- 新增主窗口通道 `account:enable-key`（`[id: number] → void`，契约、preload、注册、`ipc-channel-policy.ts` 四处齐），
  `RelayBackendClient` 多一个可选的 `enableKey`，只有 new-api 实现：照网页「令牌管理」的「启用」发
  `PUT /api/token/?status_only=true`、body 只有 `{id, status: 1}`（rc.44 / rc.51 `controller/token.go` 的 `UpdateToken`，
  `status_only` 时只改状态，别的字段不用读回再写）。
- 发之前先 `GET /api/token/:id`：服务端只在还标着已过期 / 额度用完、并且确实还过期 / 还没额度时拒绝，网页上停用过、
  到期时间或额度其实也没了的它照样打开，一用又被标回去（`model/token.go` 的 `ValidateUserToken`）。所以过了到期时间、
  限额又用完的两种在客户端先停下，说先去「编辑」改什么；已经启用的不发。启用不动明文、名字和分组，不清本机工具密钥缓存。
- 给客户看的那句「密钥管理里停用的密钥可以直接点「启用」」原话不改，用分号并进了 `f01-key-edit-keeps-limit.md` 那一条（一版最多 60 条）。
- D3（#1660 / #1723）那句「工具的密钥已经停用或到期」不再指到网页「令牌管理」，改指「个人中心 › 密钥管理」点「启用」。
- 总单 Q4 C2：记录详情里每一轮最后那条 AI 回复挂一个可选字段 `activity`（跑了几条命令、程序名、
  改成了几个文件、文件名、几步没成功），不加通道。新模块 `electron/session-activity.ts` 读
  Claude Code 的 tool_use / tool_result 和 Codex rollout 的 function_call / custom_tool_call /
  local_shell_call 及其输出；只交出程序名和文件名，命令全文、文件夹、像密钥的名字都不出主进程。
  Grok CLI 的记录格式这次没核实，先不读；导出对话不带这一行。
- 给客户看的那句并进了 `r3-sessions-search-rescan.md`（同在记录页），这一版「## 用户」合起来不超 60 条。
- 总单 Q4 C3：`provider-sessions:list` 的查询多一个可选 `searchContent`（只收布尔值，旧调用不变），
  不加通道。勾上后先按原来的标题和文件夹筛，没对上的再翻最近 100 条记录说过的话：每条最多读前
  16 MB，同时读 4 条，读到就停；结果按记录编号、更新时间、消息数和搜的字缓存 2000 条。Codex 走
  `CodexSessionService.contentMatches`，Claude Code 和 Grok 复用 `readExternalMessages`（多了一个
  读多少字节的参数）。界面用记录页搜索框那份停手 0.3 秒的词（#2028），勾上那一下立刻搜。
- 给客户看的那句并进了 `r3-sessions-search-rescan.md`（同在记录页，C2 那句也在那里），这一版「## 用户」合起来不超 60 条。
- 给客户看的那句并进了 `plugins-hub-merge.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 总单 Q4 C4：插件页技能「添加」多一项「从压缩包导入」，加一条主窗口通道 `skills:choose-archive`
  （不带参数，主进程弹原生选文件窗口，只收 .zip）。新模块 `electron/skill-archive.ts` 自己读 zip 目录：
  只认存储和 deflate、不认加密 / zip64 / 分卷；压缩包最多 50 MB，解开最多 2000 个文件、50 MB、32 层；
  路径带 `..`、绝对路径、盘符、Windows 不认的名字、Unix 链接和特殊文件、大小写折叠后重名的一律不导；
  每条按目录里写的大小解压、核 CRC。解到数据文件夹下 `skill-archives/〈随机名〉/〈技能文件夹〉`，
  上一次解开的下一次选时删掉；交回的位置再走 `skills:import` / `extensions:mutate` 原来那套检查。
- 总单 Q4 C5：新模块 `electron/standing-instructions.ts` 把一段话写进三家的全局说明（Claude Code 的
  `CLAUDE.md`，Codex 的 `AGENTS.md`、有 `AGENTS.override.md` 时写它，Grok 的 `AGENTS.md`）里一段带
  开始、结束标记的区域：按原文字符位置替换，标记外面的字、换行写法、字节顺序标记照原样；标记坏了、
  文件不是 UTF-8 就这一家跳过并说原因；清空时连同垫的空行一起拿掉，文件只剩这一段的整份删掉。写入走
  `executeFilePlans`（临时文件、`.bak`、原子替换）。
- 新 IPC 通道 `config:save-standing-instructions`（契约、preload、注册、日志策略四处；日志策略
  `secret-input`，嘱咐原文不进日志；等账号同其他 `config:*`）。设置里记一份 `standingInstructions`，
  只经这条通道改，`settings:save` 不收。
- 「用中文回复」那份（`globalResponseLanguagePlans`）把只有星芒这一段的 `AGENTS.md` 当成没有说明，
  照样放在前面；认自己那一版时先去掉这一段再比摘要。
- 「插件」页精选条目的风险标签接上了各自那句说明（Mac 验收 R10，总单第 52 项）：`registry/curated-extensions.ts` 的
  `curatedRiskLabels[risk].detail`（11-10 已批，「第三方维护」那句是「由该软件的作者维护，不随星芒一起更新。」）原来哪儿都没用上。
  现在鼠标停在标签上能看到，详情页和安装框里标签下面也按标签先后原样写出来（`extensions-common.tsx` 的 `curatedRiskPill` /
  `CuratedRiskDetails`）。随包清单眼下没有带「第三方维护」的条目，所以客户现在看到的是其他几个标签的说明。
- 给客户看的那句并进了 `home-corner-notices.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- `src/renderer-v2/registry/tutorials.ts` 画布章最后一步原来叫客户在「更多操作」里选「导出项目（含素材）」，
  但这个入口只在宿主接了网页便携包导出（`host-entry-points.ts` 的 `projectPackageExport`）时才出现，桌面画布没接，
  菜单里只有「导出工作流」；它走 `canvas-host:export-project`，导出的文件内嵌图片，视频和音频不带（`canvas-project-package.ts`）。
  改成「导出工作流，图片会一起导出」；`tutorials.test.ts` 读画布菜单源码和桌面画布 preload，把按钮名钉住
  （Mac 验收 R11，报告 #1736，0.2.25 总单第 53 项）。
- 0.2.25 第二轮复查第 12 条：删掉主窗口通道 `canvas:open-asset-library`。#2064 把「创作」的「看全部作品」换成作品库以后，
  新旧两套界面都不再调它。契约、preload（通道表和 `window.xingmang` 上的方法）、`ipc.ts` 的注入项、`ipc/handlers/window.ts`
  的注册、`ipc-channel-policy.ts`、`main.ts` 的接线一起删，渲染层能碰到的主进程入口少 1 个。客户看不到任何变化。
- 画布那一侧没动：`CanvasWindowController.openAssetLibrary`、`canvas-host:show-account-assets` 推送和 `?view=assets`
  是跟画布内核配对的，要删得两个仓库一起改，这次不碰；画布窗口自己的素材库照旧。
- `ipc.test.ts` 里打这条通道的那几行和夹具随之删掉，`canvas:open` 那条用例的断言不变；renderer-v2 测试夹具删掉对应的空实现。
- R2-2（总单 70）：`ConfigBackupStore.list()` 校验没过的那份，清单还读得出来时带上工具、原因和时间，读不出来时时间退回目录名里的那个（`resolveBackupIdTime`）；已下线工具的坏备份因此照旧由 `backups:list` 筛掉。renderer-v2 `BackupCard` 改用 `visibleBackups`：认不出工具的坏备份只在「全部工具」里，坏的那行不给「预览」、「恢复」灰着、能删；没有时间的删除确认写「删除这份备份？」。主进程的原因文字带路径和文件名，不上屏。`storage-usage-service` 的「清理旧备份」只数、只删校验过的，行为不变。
- 0.2.25 总单第 78 项 R-2（`0.2.24-深查/资源占用.md`）：聊天里的图片格子（最大 300 见方）和输入框上的待发小图（64 见方）一直直接放原图，
  2K、4K 的图整张解开每张 16~64 MB，图多的对话一打开全部一起读、一起解；每张原图每次显示主进程还要按编号找文件再整个读一遍。
- 主进程的缩略图多一档 768 像素（`xingmang-asset://thumb/v2/image-large/<编号>`，缓存存成 `<编号>.large.png|jpg`，和作品库那档 320 并排；
  上限 4 MB）。320 那档在高分屏上放到 300 见方会糊（300 × 2 倍屏 × 自动缩放最大 1.25 = 750），所以不直接拿来用。只有图片有这档，视频封面没有。
  归属照旧由存图那边核对，「清理缩略图缓存」也认这种文件名。
- 聊天新加 `features/chat/ChatImage.tsx`：格子先放 768 那张，点开大图才读原图；缩略图出不来（缓存被清、解不开）退回原图，原图也打不开才标「图不见了」。
  WebP（有的电脑上主进程解不开）、不是星芒存的图、原图本来就不比 768 大的，照旧直接用原图。图片加 `loading="lazy"`、`decoding="async"`，
  记过宽高的先按宽高占位，往上翻到才读。
- 用例：`asset-thumbnail` / `asset-thumbnail-store` / `asset-thumbnail-service` / `ai-asset-protocol` / `storage-usage` 补了大一档的解析、存取、上限、分档生成和清理，
  解析另钉住 `constructor`、`__proto__` 这类名字不当成种类；`ChatImage.test.tsx` 钉住什么时候用缩略图、出错退回原图、懒加载和占位。
- 作品库整理信息（`electron/ai-asset-metadata-store.ts` 的 `readShard`）只有分片文件不在时才当空的。读不出来（杀毒软件、同步盘
  正占着，或者是本程序拒绝跟随的链接）直接报原来的错，文件原样不动、这次什么也不写，下次再读；以前一律当「坏了」改名成
  `.corrupt-*.bak` 再当空表，接着保存另一个作品的收藏或标签就拿一条记录盖掉同一分片里所有作品的名字、标签、收藏和回收站标记，
  删掉的图又冒出来（#1489 R28-5，0.2.25 总单第 43 项）。只有读出来了却不是合法内容（含比本程序会写的上限还大的分片）才备份，
  而且备份改名做成了才从空的开始；改名失败（文件被占着）同样报错不写，以前会不留备份直接盖掉。
- 分片文件夹的位置是个文件时（macOS / Linux 报 ENOTDIR）照旧当空的，跟 Windows 报「文件不存在」一致，后面的写入照旧失败。
  老的单文件 `asset-metadata.json` 本来就是读不出来原样不动，没改。
- 给客户看的那句并进了 `chat-export-flush-first.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 作品库按内容存图，同一张图的两份文件拿回同一个编号。`features/chat/state.ts` 的 `addDraftImages` 以前只跟输入框里已有的比，
  同一批里的两份都进了草稿，发送时被 `ai-chat-protocol.ts` 的 `message images repeat` 拒掉，界面只给一句笼统的「再试一次」，
  点哪张移除都是两张一起没。现在同一批也去重，保留第一份的顺序，上限按去重后的张数算（#1489 R28-6，0.2.25 总单第 44 项）。
- 主进程 `electron/ai-chat-attachments.ts` 的 `storeFiles`（选图框和从文件夹复制来粘贴共用）也只回每个编号一次；
  协议对重复编号的校验照旧保留。
- 旧版本存下来的草稿里可能还留着两份，`storage.ts` 的 `readConversation` 读回草稿图片时按编号只留第一份，升级后不用手动移除。
- 作品是按内容存的：导入一张跟回收站里那张一模一样的图，拿回来的是回收站那张的编号。导入随后只记来源
  （`electron/ai-asset-metadata-store.ts` 的 `setSource`），删除标记原样留着，于是提示导入成功、作品库里却找不到，
  只在回收站里（11-18 R28-7，0.2.25 总单第 65 项）。现在 `setSource` 同时去掉删除标记，名字、标签、收藏、提示词照旧。
  `setSource` 只在刚存完一份素材时调（画布选文件、拖进来、导入项目、抽帧、图片处理、生成），这几处存回回收站里的那张，
  也都一样回到作品库。
- 0.2.25 总单第 48 项第一条（11-18 复核 R29-01）：`electron/codex-payload-limit.ts`
  的会话记录监听只在目录有动静时读。星芒没开着、头一回用 Codex 时会话目录还没有（每分钟重试一次）、或者目录监听断了
  重新盯上的这段时间里，Codex 写完那一行 413 以后不再动这个文件，就不会再有目录通知，30 秒一次的回看也只看记着的文件，
  客户停在报错那儿等不到换线路或提示。
- 现在每次刚盯上（第一次、目录晚出现、断了重新盯上）先盯上、再回头找一次（`findRecentCodexRollouts`）：从新到旧最多翻
  31 个日期文件夹、最多看 512 个文件的修改时间，只把 10 分钟内写过的、最近的 8 个交给原来那套读法。日期文件夹按对话
  开始那天分，长对话一直写在开始那天的文件夹里，所以不只看今天。只认 Codex 的年、月、日文件夹和会话记录文件名，
  符号链接和联接都不跟（I8），读文件照旧走单链接普通文件的检查；看修改时间用 `async-map.ts` 限流。
- 不会重复提示：记着读到哪的文件接着读；没记着的只读末尾，以前报过的 413 由 `createCodexPayloadLimitService` 按对话和线路
  挡掉（存在 `codex-payload-sessions.json`，重启也记得），报错时刻超过 10 分钟的照旧不管。
- 用例：`electron/codex-payload-limit.test.ts` 补了「盯上之前刚写完」「目录晚出现」「监听断了期间写的，且不重报已报过的」
  「只回头找有限的范围」四条，旧代码上都红；另有目录不存在、名字不像日期文件夹、符号链接三条边界用例。
- 给客户看的那句并进了 `r29-01-codex-payload-catch-up.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 0.2.25 总单第 48 项第二条（11-18 复核 R29-02 的「部分修复」那半）：
  `electron/codex-payload-limit.ts` 的 `createCodexPayloadLimitService` 在线路 1 上认出 413 时，先把对话记成处理过再去换线。
  线路 2 这会儿没查通（`unreachable`）、或者 Codex 的配置没跟过去（`unfollowed`，含跟的那一步抛错）时也照样记着，
  存进 `codex-payload-sessions.json`，这个对话以后在线路 1 上再报都不管了：线路 2 过一会儿好了，客户接着发、接着 413，
  星芒一声不吭。切线后线路 2 再报的那半（`handledDirect`）以前已经修了。
- 现在这两种结果不算处理过：从处理过的记录里拿掉（重启以后再报就再试），在内存里记一个「`codexPayloadRetryMs`（2 分钟）以内
  再报不管」，过了再报就再查一次线路 2、再让 Codex 跟一次；还是没换成就再提示一次，换成了才算处理过。处理的那一阵照旧先记成
  处理过，同时来的两条只处理一次。没换成的对话已经超过线路 1 的上限，提前提醒「快到了」那条也认这个记号，不会再说「快到了」。
- 用例：`electron/codex-payload-limit.test.ts` 补了「线路 2 没查通，过一阵再试并换成」「Codex 没跟过去，过一阵再试；线路 2
  还是不通就再提示」「没换成的不存、重启再试、不说快到了」三条，旧代码上都红。
- 给客户看的那句并进了 `r29-01-codex-payload-catch-up.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 0.2.25 总单第 48 项第三条（11-18 复核 R29-03）：`electron/codex-payload-limit.ts`
  的 `createCodexPayloadLimitService` 认出 413 以后要等两步：查线路 2、换线（`holdDirect`），再让 Codex 的配置跟过去、提示重开
  （`followCodex`）。等的时候客户换了账号、退出了、换了站，或者把 Codex 换成官方账号，结果回来照样让 Codex 跟、照样弹提示，
  提示的是上一个人的事。
- 现在开始处理时记下站点和当前登录的人（新依赖 `accountOwner`，主进程接 `readExternalClientAccountId`，站点加用户编号），
  两步各自等完都核一次：站点变了、人变了（包括退出）、Codex 不在当前账号上了，这一次记成 `stale`：不再让 Codex 跟、不提示，
  也不记成处理过（换回来或者换了人以后同一个对话再报照常处理），日志 `relay.route.payload-too-large` 的 `action` 写 `stale`。
  `followCodex` 多一个 `stillCurrent` 参数，星芒账号那条在改完 Codex 配置、提示重开之前再核一次（`electron/bootstrap/codex-payload-watch.ts`）。
  开机时登录还没恢复好、认不出是谁（null）的，只看站点，之后恢复出来的那个人照常处理。线路已经换过去的不往回换：线路是整个站的。
- 另外 Codex 已经换成官方账号以后，再读到它换之前在星芒线路上留下的 413，一开始就不管（以前照样换线、提示）。
- 用例：`electron/codex-payload-limit.test.ts` 补了「查线路时换了人」「退出、换站、换官方账号」「已经是官方账号」三条，旧代码上都红，
  另有「开机登录还没恢复好照常处理」一条；`electron/bootstrap/codex-payload-watch.test.ts` 补了「换了以后不提示重开」和接线两条。
- 放量体检逐个平台核对样本（R29-05 复查时剩下的一半）：放量管着的平台、不限平台时有电脑还停在旧版打卡且线上清单
  已经是这一版的平台，新版一条打卡都没有时不再被别的平台的样本顶成「建议放开」，满 44 小时以前「再等等」，之后
  「看不出」。rollout-health 工作流把每份线上清单是哪一版交给脚本（`--manifest-versions`），清单还停在旧版的平台
  （Linux 先不发这类）不要求有新版打卡。
- 0.2.25 第三轮复查第 1 条：开着手机遥控时关窗选「安装更新并退出」，安装程序没起来（Windows 授权窗口点了「否」、
  Mac 安装器交接失败）时，手机先收到「已退出」，紧跟着又收到「电脑端的星芒未退出，遥控仍保持开启」，可星芒照样退了。
  原因是 `main.ts` 的 `updateQuitHandoff.abort` 不管有没有真撤回退出都调 `codexRemote.quitAborted()`；关窗这条路上退出是客户
  自己选的，`abortUpdateQuit()` 什么也不撤。现在 `abortUpdateQuit()` 返回这次是不是真撤回了，`abort` 只在撤回了时放回画布、
  补那一句。更新页「重启并安装」这类由安装发起的退出照旧补（打磨 B8）。`electron/window-lifecycle.ts`、`electron/main.ts`，
  不加新字，没有新增通道。
- 更新安装加固（0.2.25 复查第三轮第 2 条，接审查总表 S01）：`build/update-handoff/verified-install.ps1` 启动安装程序时的运行环境再收紧一项，
  用的位置仍只有管理员能改，装完随暂存目录一起删。
- 用例：`windows-update-handoff.test.ts` 补一条（旧脚本上红）；`e2e/windows-update-handoff-smoke.mjs` 的假安装程序多记两项、多核两项，Windows 打包作业和 `windows-self-upgrade` 真跑。
- 0.2.25 总单第 77 项 R3（0.2.24 深查「性能和资源」R3）：开机那两秒里首页工具区、开机补密钥（三遍）、线路跟随接连要五遍 `config:get`，
  每遍都把四家的配置文件、来源记录、线路跟随记录从头查一遍（沙箱量一遍约 380 次 lstat / realpath，全在主进程上同步做）。
- 新加 `electron/config-read-cache.ts`：`config:get` 从磁盘读的那部分（四家的配置和钩子、来源记录、线路跟随记录）留 3 秒，
  三样都没变才接着用：星芒自己没写过（`executeFilePlans`、Codex 定点改写 `replaceTomlFile`、来源记录、线路跟随记录写之前和写完都记一笔）、
  读过的每份文件和各家配置文件夹的身份/大小/修改时间没变（读之前取，`withRecordedConfigReads` 交回）、账号和站点线路地址一样。
  算账号是否匹配、自动修好的提示、线路状态、工作区这些不从磁盘读的照旧每次现算；保存、核对快照、取明文照旧每次现读。
  只在正式运行开（`main.ts` 传 `configReadCacheMs`），缺省 0 = 旧行为，测试不受影响。沙箱量：连着再读 4 遍从 17.4ms 降到 2.9ms。
- 开机补密钥（`account-bootstrap.ts`）这一轮一家都没写时不再读第三遍复核配置。
- 用例：`electron/config-read-cache.test.ts`（含随机输入：不管内部写、外部改、时间怎么交错，读到的都不会比最近一次能看见的改动旧）、
  `electron/system-service-config-read-cache.test.ts`（星芒写配置、外面改文件、工具登录写出新文件、写来源记录、写线路跟随记录、换账号、换站点都重读），
  `account-bootstrap.test.ts` 补「只有写了才复核」一条，原来那条从 3 遍改成 2 遍（旧代码上红）。
- 0.2.25 总单第 78 项、深查「资源占用」R-3：记录页搜索框每打一个字就请求一次，主进程每次都把各工具的会话文件夹从头扫一遍、
  全部探完再筛；会话上万时探测缓存的「最久没用先踢」又正好踢掉下一轮要用的那条，命中率掉到零。
- 页面（`features/sessions/SessionsPage.tsx`）：框里的字和拿去搜的词分开，停手 300 毫秒才搜、清空马上搜，换了词才回第一页，
  同密钥页、订单页的写法。换搜索词、换工具、翻页的请求带上 `reuseRecentScan: true`；进页、再显示、点重新加载、归档删除之后
  照旧现扫。
- 主进程（`electron/provider-sessions.ts`）：每个工具扫一遍的结果留 10 秒，只给带 `reuseRecentScan` 的请求重新筛、分页；
  同时到的请求（记录页的这一页和最新 100 条）共用同一轮扫描，各工具仍一个接一个扫。删记录（本服务）和 Codex 归档、恢复
  （`ipc/handlers/sessions.ts`）之后作废，正在扫的那一轮也丢开。`ProviderSessionListQuery.reuseRecentScan` 是新加的可选字段，
  缺省 = 旧行为，`ipc/parsers/sessions.ts` 只认布尔值。没有加新通道。
- 探测缓存（`electron/provider-session-probe-cache.ts`）：命中不再挪位置，满了不挤掉还有效的旧条目，新文件这回先不记；
  文件变了照样替换，删了由整轮扫描的 `pruneScope` 清掉。会话比上限多时每轮照样能命中已记住的那些。
- 用例：`provider-sessions.test.ts` 新增「R-3」一组 8 条（同时到的请求共用、复用窗口内只重筛、过期重扫、不带标记照旧现扫、
  换工具各自复用、删后重扫、作废后不接旧的那轮、失败不留）；`provider-session-probe-cache.test.ts` 把原来钉住 LRU 的那条
  改成新规矩，并补「比上限多一个文件时反复扫照样命中」，旧代码上红；`ipc.test.ts` 补归档、恢复后作废；`app-check.mjs`
  补停手 300 毫秒才搜、重新加载现扫。
- 开机不再白写一遍 settings.json（总单 77，0.2.24 性能深查 R4）：`updateAppSettings` 合并后跟磁盘上一字不差就不写，
  跟开机那次整理 `normalizeAppSettings` 用同一个口径（两处共用 `writeSettingsIfChanged`）。界面每次开机发的那次
  `window:set-theme`、关窗存的窗口位置，没变时都不再走临时文件、fsync、拷 .bak、改名。
- `window:set-theme` 先换窗口颜色再记设置；记不进去（C 盘满、杀毒锁住文件）只在运行日志记一条
  `window.theme.save-failed`，不再让标题栏和页面停在旧颜色、再弹一张「系统外观没有同步」。
- 用例：`electron/app-settings.test.ts` 补「没变就不碰文件、不建 .bak、不调替换钩子」「没变的那次在写不进去时也不失败」两条，
  `electron/ipc.test.ts` 补「先换颜色再记、记不进去只记日志」一条，三条在旧代码上都红；另补一条守住「主文件坏了照样重写」。
- 主窗口开着时不再每 0.5 秒 stat 一次 settings.json（总单 77，0.2.24 性能深查 R5）：`app-settings.ts` 每次把设置文件换成新内容后
  通过 `onAppSettingsWritten` 通知一声，`platform/renderer-v2.ts` 的界面缩放改为订阅它，关窗退订。内容没变不写，也就不通知；
  监听器抛错不影响那次写入。缩到托盘以后也不再有这个亚秒级的磁盘轮询。手改 settings.json 里的缩放，下次拖动窗口或重开时生效。
- 用例：`electron/app-settings.test.ts` 补通知的两条（换了才通知、没变和写失败不通知、退订后不再通知；监听器抛错不影响写入和别的监听器），
  新增 `electron/platform/renderer-v2.test.ts`（存了缩放马上跟上且不再 `fs.watchFile`；关窗后不再跟），三条在旧代码上红。
- 视频剪辑拼片时片段合计的上限按电脑内存收紧（0.2.24 深查「资源占用」R-7，0.2.25 总单第 78 项）：原来固定 1 GB，
  现在是内存的八分之一、夹在 256 MB 到 1 GB 之间（`videoStudioTotalBytesLimit`，`compose-protocol.ts`）。
  8 GB 及以上的电脑照旧 1 GB，4 GB 的 512 MB，2 GB 的 256 MB。片段、攒在内存里的成片、IPC 来回的复制都压在界面进程上，
  一次拼片吃的内存是片段合计的两三倍，内存小的电脑照 1 GB 放可能被系统杀掉。
- 内存数取 `navigator.deviceMemory`：页面读片段时（`addVideoStudioClipBytes`）和拼片线程收请求时（`parseVideoStudioComposeRequest`）各自读，
  读到的是同一个数，不加通道、不碰主进程；读不到照旧 1 GB。超了报的还是原来那句「片段加起来超过 … 了，少放几段再拼」，数跟着上限走。
  现在的 AI 片段一段几 MB，碰不到这个上限；导入本地长视频开工前仍要改成主进程按需读片段、成片直接写临时文件。
- 刷余额不再整页重画（总单 77，深查「性能和资源」R8）：`App.tsx` 根组件不再订阅余额快照，
  `useAccountBalanceStore` 只建和管那份 store；侧栏账号卡、状态栏、低余额标签由新的 `AccountMoneyProvider`
  （`features/app/account-money.tsx`）算好交给 `AccountMoneyView` 里的外壳，页面元素在根组件里先建好原样传下去；
  首页余额卡拆成 `HomeBalanceCard` 单独订阅转圈和读失败，首页本身只挑余额对象。读回来跟上次一样时 store 留着
  上一份余额对象，首页的用量、近 7 天重读和 `useRunwayUsage` 也只在数变了时才换。改前每分钟那次刷新是
  3 次提交 × 131 个组件（393 次），改后 2 次提交共 114 次，根组件、首页、工具卡不动；手点刷新从 400 降到 180。
  `app-check.mjs` 加一条用 DevTools 钩子数重画的回归用例，在旧代码上会红。订阅到期这件事改跟订阅缓存
  （最多 5 分钟）一起重算，不再跟着每分钟的余额刷新。
- 0.2.25 总单第 77 项 R9（0.2.24 深查「性能和资源」第三节）：公告、用户协议和隐私政策的 Markdown 排版（react-markdown 连带 remark / micromark
  约 150KB）原来静态打进首屏包，每次开机都要多解析一遍。现在 `src/renderer-v2/markdown-view.tsx` 打开那个框时才 `import()` 读
  `markdown-renderer.tsx`（框一开就跟读内容并着读，读不进来退成原文照排，不让整个界面掉进出错页）。
- 客服二维码库（qrcode 约 26KB）也试过改成首屏画完再 `import()`，Mac 上开发版开机看见欢迎页慢了 1 秒多，`e2e/macos-dev-origin.test.mjs`
  两次越过 5 秒门槛（查根因探测 run 44880468302），改回静态引入，`useSupportContact.ts` 里写了原因。
- 实测（main `0b99e0c` 上，同条件生产构建，入口加预加载的 JS）：首屏 1,318,623 → 1,164,921 字节，少 11.7%（gzip 439,555 → 393,063）。
  Linux 云端沙箱编译版、已登录假账号站，改前改后交替各 12 轮中位数（从页面开始加载算）：冷启动首页出来 403→369ms、LCP 380→344ms；
  热启动首页 397→415ms，在噪声里（各轮 363~482 / 353~518）。Windows 慢机没量过。
- 用例：`markdown-view.test.tsx`（读进来前只画占位、读进来后跟原来直接用 react-markdown 的输出逐字一样、读不进来退成原文）；
  `first-screen-imports.test.ts` 钉住 react-markdown、remark-gfm 只能由按需加载的那几块静态引，旧代码上红；
  `Announcement.test.tsx` 两条 Markdown 安全用例改成等排版读进来再取 HTML，断言一条没动。
- 0.2.25 总单第 51 项（Mac 验收 R9）：new-api 拿不到上游原因时，用错误类别名充当原因（`relaykit/types/error.go` 的
  `ToOpenAIError`：message 为空就填 `openai_error`、`upstream_error` 这类），生图技能 `generate.mjs` 和画图工具 `mcp-server.mjs`
  以前原样交给 AI，Grok 改图失败客户只看到 `openai_error`。现在空原因、`*_error` 类别名、只有状态码（比如网关回的 HTML）
  都换成「〈模型〉这次没能出图/改图，图片服务没说原因」，Grok、Nano Banana 建议换回默认的 GPT 图片模型，gpt-image 建议稍后再试；
  画图工具把原话写进 stderr（宿主记日志、不进对话），命令行脚本不打原话。上游把原因写成字符串 `error`（xAI 的格式）时照旧原样交出，
  以前这种会被当成只有状态码。两个脚本同一套判断和句子，`scripts/xingmang-image-mcp.test.cjs` 钉住。
- `relay-line-fetch.ts`：线路2白名单不放行的接口不再每次先碰线路2的 404 再退回线路1。价目 `/api/pricing`
  照 #1394「已定」第 2 条固定走线路1（「自动」和写死线路2都一样）；别的接口在「自动」下被线路2挡过一次，就按站点和路径
  （不看查询串）记 30 分钟（`relayLineBlockedMemoryMs`，最多记 64 个），这段时间走着线路2时直接走线路1，过期再先试线路2。
  直接走线路1的那一次没走通不退回线路2、不报给线路那边。0.2.24 Mac 验收 R17：一次打开画布有 3～6 个请求这样多跑一趟、
  日志刷同样多条 `relay.line.blocked`。报告里路径打了码；对照日志时间和代码，这些不是价目（价目只在运行前检查弹出时才读，
  十分钟只读一次，画布开窗不读），推测是开窗时各分组读模型列表（`/api/user/models`），所以按接口记下来，而不只钉死价目。
- 手机遥控在 Windows 上多放行一种：启动探测是 same-user、完整性标签读出来是 High、令牌类型探测没失败，
  即账号本身就带管理员权限（自带 Administrator 没开管理员批准模式、或关了 UAC）。这种账号上怎么打开星芒都是
  管理员身份，原来的「请用普通方式重新打开星芒」做不到；也没有提权边界可守，Codex 拿到的跟这个账号平时开的
  任何程序一样。右键「以管理员身份运行」（trusted-only）和探测说不清的照旧拦。yoyo 2026-11-20 亲手打字同意。
  `electron/bootstrap/codex-remote.ts` 的 `isAlwaysElevatedWindowsAccount`；快照多一个可选字段 `alwaysElevated`
  （不是新通道），卡片说明下面多一句黄底提醒。
- 手机遥控「接对话」不再只认 Codex 0.169.x（0.2.25 第三轮复查第 4 条）：0.169.0 及以后的版本都开放，每次接上已有对话时先用 `thread/settings/update` 写进遥控规矩，再 `thread/resume` 一次核 Codex 报回的 `collaborationMode.settings.developer_instructions` 一字不差，核不上（字段被改名时 Codex 照样回成功）或 Codex 以 -32600/-32602 拒收，就对手机和电脑页说「当前 Codex 版本暂不支持继续已有对话」，消息不交给 Codex，这一版本在本次运行内记下不再试。规矩改在接上时写一次，第一句的 `turn/start` 不再带 `collaborationMode`。0.169.0 与 0.171.0（npm 最新）在沙箱 app-server 上实测：写入、报回、下一句发给模型的请求、换型号后、重开进程再接，两版一致。`docs/CLI-VERIFIED-VERSIONS.md` 巡检步骤加了抬 Codex 前重核接对话这一步。新字没有，沿用 11-22「接对话字改」确认过的原话。
- 手机遥控能接本机 Codex 已有的对话（yoyo 2026-11-22 北京 13:15 回「接对话字改」，29 句新字逐字照用）。
  电脑页「通用设置」在「工作文件夹」下面加「手机端的对话」一行和「选择对话」弹框，列 Codex `thread/list`
  最近 20 段（桌面端、CLI 和遥控自己开的都在，去掉临时的和子任务的）；手机上新加「对话」「对话 N」两条指令，
  只列电脑端已添加的文件夹里的 10 段。选定的那段记在 `codex-remote` 设置的 `conversation` 字段
  （编号、标题、文件夹、更新时间），文件夹不是当前干活的文件夹时不算数。
- 接上靠 `thread/resume`（`excludeTurns`，跟新开的对话一样关掉 apps、plugins，带上星芒管的 MCP）；
  原对话的审批方式、审批人或沙箱超出手机遥控这一档（`resumedPermissionFits`）时，第一轮 `turn/start` 就带上
  这一档的 `approvalPolicy` / `approvalsReviewer` / `sandboxPolicy` 降下来，之后电脑上接着用也是这档。
  手机遥控的规则（不发密钥、回复简洁）在第一轮由 `collaborationMode.settings.developer_instructions` 带进去，
  所以 `initialize` 改成 `experimentalApi: true`；只认 Codex 0.169.x（`codexSupportsResume`），别的版本两边都说不支持。
- 新加两条主窗口通道（I5：渲染层只给对话编号，文件夹由主进程从上一次列出来的结果里取，再过
  `validateRemoteWorkspace`）：`codex-remote:list-conversations`（成功不记日志，遥控关着时临时起一个 Codex 读完就关）、
  `codex-remote:choose-conversation`（入参 `null` 或对话编号，`parseRemoteConversationChoice` 校验）。
- 给客户看的那句并进了 `remote-always-elevated-account.md`（「## 用户」合起来超了 60 条）。
- 「手机遥控 Codex」从设置 › 工具管理的整卡搬成侧栏日常组的 `remote` 页（`CodexRemotePage.tsx`，原 `CodexRemoteCard.tsx` 改名）：连接方式两张可选的小卡（页签）、下面只摆选中那一种的设置、两种共用的设置单独一张「通用设置」卡，侧栏排在「插件」前面；去掉 `settingsItems` 的 `codex-remote` 和 `remoteChannelCollapsed`（YF-7 收成一行）。状态栏、首页 Codex 菜单、使用教程、顶部搜索都改去这一页。
- 新通道 `codex-remote:set-model`：手机上单独用的模型（`null` = 与电脑端相同），入参只收像型号名的字（`isRemoteModel`）。底座在 `thread/start` 和每一轮 `turn/start` 带上；改回跟电脑时用 `config/read` 读出电脑上的型号带回去，因为 `turn/start` 带的型号会一直留在这条对话上。
- 手机上的「帮助」那句、审批卡（「Codex 说明：」放在命令前、命令前加「命令原文：」）换字，新字都按 2026-11-21 定的书面口吻写；审批策略没动，还是 `untrusted` + 工作区可写。
- 手机遥控新开的对话跟中途换档、接已有对话用同一套沙箱（0.2.25 第三轮复查第 5 条）：`buildThreadStartParams` 的
  `config` 带上 `sandbox_workspace_write.network_access = false` 和 `sandbox_workspace_write.writable_roots = []`。
  以前 `thread/start` 只传 `sandbox: 'workspace-write'`，Codex 照客户 `config.toml` 的 `[sandbox_workspace_write]` 来，
  客户开过联网的，手机上不问就能联网，加过的可写文件夹也能改；中途换档（`buildRemoteSandboxPolicy`）却一律不开网、
  可写的只有这个文件夹。Codex 0.169.0 实测：`config.toml` 开了联网、加了可写文件夹，改前 `thread/start` 回报
  `networkAccess: true` 和那个文件夹，改后两样都没有；项目里的 `.codex/config.toml` 也压得住；客户自己设的
  `exclude_tmpdir_env_var` / `exclude_slash_tmp` 照旧保留（只会更严）。
- 新加 `startedSandboxExceeds`：`thread/start` 回报的沙箱比手机这一档宽（联网、能改文件夹以外、只读档却可写、
  完全访问或外部沙箱）时，这份对话记成 `exceeds`，第一轮 `turn/start` 带上这一档的 `sandboxPolicy` 降下来，跟接已有对话
  超出这一档时一样，日志记 `remote.thread-start-sandbox-wider`。回报认不出的不算宽：Windows 没开沙箱时 Codex 会把
  可写降成只读，不能因为认不出反倒用 `turn/start` 抬上去。
- 给客户看的那句并进了 `remote-always-elevated-account.md`（「## 用户」合起来超了 60 条）。
- 手机遥控的权限分两档（yoyo 2026-11-22 北京 09:55 亲手打字同意放宽）：「默认」= `approvalPolicy: 'on-request'` +
  `workspace-write`，「只读」= `on-request` + `read-only`，不放完全访问，审批人仍是手机上的用户（`approvalsReviewer: 'user'`）。
  以前一律 `untrusted` + `workspace-write`，改文件和大多数命令都要先在手机上回「同意」。
- 设置存在 `codex-remote` 设置的 `permission` 字段，只认 `'readOnly'`，缺省或别的值都按「默认」（老设置不用迁移）。
  新开的对话由 `buildThreadStartParams` 带上对应的 `sandbox`；已经开着的对话在换档后的下一条消息由 `turn/start`
  带上 `approvalPolicy`、`approvalsReviewer` 和 `buildRemoteSandboxPolicy` 给的 `sandboxPolicy`，跟换模型同一套做法。
- 新加主窗口通道 `codex-remote:set-permission`（入参只收 `'default'` / `'readOnly'`，`parseRemotePermission` 校验），
  手机遥控页「通用设置」在「干活的文件夹」下面加「权限」一行；教程「手机遥控 Codex」第三步的说明跟着改。
- 「手机遥控」改名「遥控」（yoyo 2026-11-26 回「遥控」，方案 `/mnt/project-files/0.2.25-界面原型/第二轮优化方案.md` 第一部分逐字照用）：侧栏与页头、首页 Codex CLI 卡菜单项、
  状态栏、托盘三处、手机上收到的 8 句、报错（含 `codex-remote-store.ts` / `codex-remote-images.ts` 报错里的名字）、选文件夹窗口标题、教程位置与按钮都换；
  更新、卸载被挡时那句原来写「或先在设置中关闭手机遥控」（0.2.25 起遥控已不在设置里），改成「或先在「遥控」页关闭遥控」。顶部搜索词留「手机遥控」；
  运行日志、`ipc-channel-policy.ts` 的日志标签、`codex-remote-app-server.ts` 报给 Codex 的 clientInfo、手机指令都不动。
  0.2.25 那两条还没发的更新说明一并改了。
- 重启框（Node.js 装完、页顶和首页「需要重启电脑」、Codex 桌面端打不开）点「立即重启」以前只看没保存完的设置和安装队列，
  「创作」里正在回复的对话、正在合成的视频、画布正在出的图都不看，一重启就断了（0.2.25 复查第 11 条）。现在新界面带
  `askIfWorking` 调 `runtime:restart-windows`，主进程先照重启装更新那一问（D10）点名问一句：同一个
  `buildUnfinishedRestartWorkPrompt`、同一份忙闲（`runningRestartWork`）、同一个原生确认框，字一个没加。
  点「等待完成」回 `{ postponed: true }`，重启框原样留着，做完再点；安装队列里还有事时不问，交给原来那道闸拦下
  （`quit-blocking-tasks.ts` 的 `confirmWindowsRestartWork`）。旧回滚界面不带参数，照旧直接重启。没加 IPC 通道，
  只给这条通道加了可选参数和返回值。
- 0.2.25 复查第 7 条：技能「从压缩包导入」解开的临时文件夹（数据文件夹下 `skill-archives/`，最多 50 MB）
  以前要等下一次导入压缩包才删。现在导入框一关（导入完、取消、换页面）就删；导入失败时框还开着，留着给客户
  再点一次「添加」；星芒在框开着时被关掉或崩了，开机安静期过后在后台删。新加一条主窗口通道
  `skills:discard-archives`（不带参数，只删主进程自己定的那个文件夹里随机名的几份）。解压和清理在同一个
  文件夹上排队，解压到一半点了取消，清理等这次解完再删。各家导入都是复制，删了不影响已导入的技能。
- 0.2.25 复查第三轮第 3 条（技能导入收尾）：导入不成功时，界面上照旧是原本的原因（比如「Skill 已存在」），
  技能文件夹里不留下多余的技能。`skill-import-snapshot.ts` 的 `discardSkillImportStaging` 收尾不再抛错；
  列技能（`codex-extensions.ts` 的 `collectSkillFiles`、`provider-extensions.ts` 的 `scanSkills`）不列导入用的临时文件夹；
  开机安静期过后由 `discardSkillImportLeftovers` 在后台清掉以前留下的（Codex、Claude Code、Grok 自己的和当前项目的技能文件夹，
  只认星芒起名的、不跟链接，这会儿还有导入在用的不碰）。
- 用例：`skill-import-snapshot.test.ts`、`codex-extensions.test.ts`、`provider-extensions.test.ts` 补了 7 条，旧代码上都红。
- 0.2.25 第三轮复查第 6 条（「画布也搬」，yoyo 2026-11-22）：「迁移到新电脑」以前只带画布项目里生成的作品，项目本身（节点和连线、
  项目里导入的素材）不带，界面上也没说。现在选「导出全部」时连项目一起带：导出文件夹里多一个「画布项目」文件夹，一个项目一个子文件夹
  （`workflow.json` + 照项目素材布局放的文件），清单 `xingmang-canvas-projects.json` 最后写。项目里生成、已在「作品」里的那几件只记编号，
  不复制两份。归档的项目照带、导过去仍是归档；旧版没选文件夹的项目导过去也不绑文件夹；文件夹连不上的项目不导、询问框里说几个
  （`electron/data-transfer-canvas.ts`）。
- 导入时项目先于作品：每个项目在「文档 › 星芒画布」新建一个文件夹（同新建项目，`claimCanvasDefaultProjectFolder`），文件逐个核对后放进去，
  再以原编号、原时间登记（`canvas-project-store.ts` 新增 `listTransferable` / `admitTransferred` / `restoreTransferred`）；登记失败删掉这次放的文件、
  交还文件夹，列表里不留半个项目。同编号已在本机的算已存在，导两次不多一份；本机项目到上限（500 个、未归档 100 个）的报数。
  空间按作品和项目加起来先估一次，不够一样都不导。项目里生成的作品放回新项目的文件夹，不再另放进 AI 作品文件夹。
- 入参照敌意输入处理（I5、I8）：只认固定名字的「画布项目」文件夹，项目子文件夹必须是 UUID，文件路径照作品清单同一套规则校验，
  每个文件核对单链接普通文件和大小，工程文件过 `parseCanvasProjectWorkflow`，名字、标签过 `parseTransferredAiAssetMetadataItems`。
- 没有新增通道：`data-transfer:inspect-works` / `data-transfer:export` / `data-transfer:import` / `data-transfer:import-works` 的返回值各多一项可选的画布项目数，
  路径照旧只留在主进程（一次性 token）。旧版本读到新文件里的画布项目数照旧导对话、设置和作品；新版本读旧文件当没有项目。
- 设置页询问框有画布项目时标题换成「是否同时导出作品和画布项目？」，导出、导入完那句话报画布项目几个（新字 yoyo 确认，见第三轮复查第 6 条）。
- 0.2.25 第三轮复查第 7 条：「迁移到新电脑」以前不带「给 AI 的长期嘱咐」，到了新电脑要重写一遍。现在导出时放进那份 JSON 的
  `settings.standingInstructions`（格式版本不变，旧版本读到不认识的这一项照旧导别的）；这台存着的那段过不了 `validateStandingInstructions`
  （手改坏了）就不带，免得导出一份新电脑整份拒收的文件。
- 导入时文件里那段照设置页保存时一样查（I5），查不过整份拒收，空的当没带（不能借导入把这台写过的清掉）。这台电脑上没写过的直接换；
  写过另一段的，在原来那个询问框里列出「给 AI 的长期嘱咐」，选「使用文件中的设置」才换（`data-transfer.ts` 的 `planPortableSettingsImport`）。
- 嘱咐不在 `settings.json` 的那一套里：设置页走原有的 `config:save-standing-instructions` 写进三家工具的说明文件，没有新增通道。
  三家都没写上时跟设置没存上一样报，页顶红条说是哪家、为什么；有的没写上时导入那句后面接一句，「工具管理」那一格下面照样列出是哪家、
  为什么，保存按钮字没改也能再点（以前要先改一个字才能再存）。
- 反馈页「运行日志」的「复制这一条」以前带着完整的个人文件夹（Windows 上就是用户名）：落盘的日志只遮了密钥和邮箱，
  个人文件夹要到生成反馈报告时才换成 `%USERPROFILE%`，列表这条通道 `runtime-logs:list` 一直原样交给页面（I13）。
  现在 `runtime-log.ts` 的 `redactRuntimeLogEntriesHome` 在列表这条路上把每条的文字和附带信息里的字符串按报告同一套换掉，
  结构和别的值不动；反馈报告、日志文件不变。0.2.25 设置客服反馈复查第 2 条，`ipc.test.ts` 那条旧代码上红，另加随机输入测试。
- 0.2.25「其他方面核查」第 1 条（严重）：S01 的更新安装交接脚本在 PowerShell 受限的 Windows 电脑上一行都跑不起来，
  以前报「可能是 Windows 授权窗口被关闭，请点击「重新安装」重试」，可授权窗口根本不弹，重试永远一样。
  Windows CI 实测（运行 45648962353）：机器级 `__PSLockdownPolicy=4` 的受限语言模式下脚本停在开头第一处 `[IO.Path]::Combine`，
  组策略把执行策略定成 AllSigned 时 `-ExecutionPolicy Bypass` 压不过、脚本不让加载；两种都约 300 毫秒以 1 退出、不写状态、不请授权。
- 处理（产品负责人 11-25 选核查里的 C）：装法和核对一点不放宽，只把这种失败认出来，引导客户去下载页手动装一次。
  `windows-update-handoff.ts` 把 `-Relaunch` 那一份的退出码 1（`windowsHandoffBlockedExitCode`，脚本自己从不以 1 退出）判成新的结果 `blocked`，
  并在交接记录里记 `blocked: true`；`updater.ts` 报新代码 `UPDATE_HANDOFF_BLOCKED` 和新句子 `updateHandoffBlockedMessage`；
  退出时自动装碰上的（那时星芒已经退了），下次打开由 `bootstrap/updates.ts` 从记录认出来，直接报同一个代码和句子（`previousAutoInstallFailure` 可以连代码一起返回）。
  渲染层 `update-retry.ts` 的 `updateNeedsManualReinstall` 认这个代码：版本更新卡、首页气泡、强制更新那层都去掉「重新安装」、给「打开下载页」；
  版本更新卡右上角在这两种只能手动装的情况下不再写「已下载，重启后生效」，退回按阶段的那句、用提醒色（Mac 验签不过同样受益）。
- 用例：`windows-update-handoff.test.ts`（退出码 1 判 blocked、记下、下次打开认出；脚本里没有任何一处以 1 退出）、`updater.test.ts`、
  `update-retry.test.ts`、`required-update.test.ts`；`e2e/windows-update-handoff-smoke.mjs` 在 Windows 打包作业里真设一次受限语言模式、
  一次组策略 AllSigned，照星芒的发起方式走交接，断言结果是 blocked、没有提权的那一份起来，跑完都改回。
- 没做：让脚本本身适配受限环境（核查里的 A）放下一版，由 Claude·win 牵头；组策略只许签名脚本的电脑 A 也解决不了。
- 审查总表 S01（0.2.25 总单第四节 W13，设计由 Claude·win 牵头）：更新安装从校验到执行全程用同一份安装包，期间有变化就不装；取消和失败后可以再装。
  Windows 正式版不再调用 electron-updater 的 `quitAndInstall`，改由新模块 `electron/windows-update-handoff.ts` 与随包脚本
  `build/update-handoff/verified-install.ps1`（`electron-builder.config.cjs` 的 `win.extraResources`）完成交接；
  `updater.ts` 记下核对用的校验值（`verifiedPackage`），安装前按它再核一次，交接结果分「核对通过、安装包有变化、取消、失败」四种处理；
  `bootstrap/updates.ts` 接线，`main.ts` 退出时安装在 Windows 上等交接结果（`quit-blocking-tasks.ts` 的 `waitForWindowsUpdateHandoff`）。macOS 与 Linux 的安装路径不变。
  提权不经 electron-builder 带的 `resources\elevate.exe`（CI 实测它把参数重新用空格拼起来、引号全丢，参数一长就退出 1 不启动）：
  系统 PowerShell 以普通权限跑脚本的 `-Relaunch`，脚本逐个加引号后请 Windows 以管理员身份再起一份自己，授权窗口点「否」时退出 1223。
  发起的那个 PowerShell 不 detached 起（`runHiddenWindowsProcess`，隐藏窗口、等它退出）：CI 上 detached 起的系统 PowerShell 不跑脚本就以 0 退出。
- 新字（确认词「更新交接字改」）：取消授权、安装包有变化、准备好却没能自动关闭、上次安装程序报了失败，共四句，见 `updater.ts` 开头那几个常量。
- 用例：`updater.test.ts` 新增「Windows install handoff (S01)」一组（旧代码上红）；新增 `windows-update-handoff.test.ts`；
  `quit-blocking-tasks.test.ts` 补退出时等交接的四条；`verify-packaged-hardening.test.cjs`、`ci-workflow-config.test.cjs` 各补一条；
  脚本本身由 Windows 打包作业的 `e2e/windows-update-handoff-smoke.mjs` 真跑（照星芒的发起方式走完整条路子的正常安装，参数不对时不请求提权，校验值不对、大小不对、安装程序失败、状态文件名被占）；`windows-self-upgrade` 先拿打出来的包里那份脚本单独走一遍。
- 升级冒烟（`upgrade-smoke.yml`）在 Windows 上加一项 `windows-self-upgrade`：要测的包自己升到同一次提交出的、版本号高一位的包，
  新的安装路子在打出来的安装包上从头到尾走一遍（旧版本升新版本走的还是旧版本的老路，测不到它）；
  `scripts/ci-change-scope.cjs` 的 `upgradeSmokeFiles` 加上交接模块和脚本两个文件。
- 没做：Linux 交给系统安装程序那一段按同一要求另开一条跟进；#1410 第 2 条（自动安装失败一次就不再自动装这一版）不在这次范围，自动安装的重试策略不变。
- 公开仓库收起「哪里还有洞」的材料（安全清单安-2、安-5）：`docs/audits/` 三轮审计（2026-10-28、10-29、11-18）原样搬到
  云端项目的共享文件夹，仓库里删掉；引用它的 6 处（三个 R29 分片、`scripts/renderer-single-copy.mjs`、`e2e/harness.test.mjs`
  的注释、`CHANGELOG.md` 0.2.23 段一行）改成只写编号。`docs/COLLABORATION.md` §2 记下以后审查报告不进本仓。
- 界面原型里的演示账号换成假的：名字「李华」、邮箱都用 `example.com` / `example.net`、示例密码 `demo-pass-1` / `demo-pass-2`
  （`ui-spec/v4/` 原型、`ui-spec/work/` 源码和由它重建的 v3.1.1 原型）。只改设计稿里的演示数据，产品界面一个字没动。
- 更新目录上 `service-status.json` 里的撤回名单、只撤哪几种安装包、分批放量、最低版本、最低版本只拦哪几种和 `updatedAt`
  加发布者签名（D85，深查「自身更新」Z-4 第 2 条）：复用发版给更新清单签名的那把 Ed25519 私钥（`XINGMANG_UPDATE_SIGNING_KEY`，
  不加新 secret），签的是这几项排好键的 JSON（`xingmang-service-status-guard/v1`），签名写在 `releaseGuardSignature`。
  客户端（`electron/service-status.ts`）验不过或没签名时把这几项当没读到：撤回名单、放量、最低版本照记住的那份，
  日志 `service-status.changed` 带 `releaseGuardRejected`；维护提示、已知问题、关功能等别的项照常读，在 Cloudflare 后台手改它们签名不受影响。
  以前拿到桶的上传权限或洛杉矶转发机的人，不用签名私钥就能把当前版本写进撤回名单、再换上一份真签过名的旧清单，让客户端「退回」旧版本。
- 写状态文件的三条工作流都在上传前签上（`scripts/service-status-signature.cjs sign`，私钥只给签名那一步）：
  service-status、rollback-release、publish-release 写分批放量那一步；publish-release 碰上线上那份还没签名时，放量不变也照原样签一份再传，
  0.2.25 的清单换上去之前线上那份就已经签好。service-status 的预览会提示线上那份没签名或签名对不上。
  0.2.24 及以前的客户端不看签名，行为不变。
- Codex 会话归档、恢复前先按读取那一关的规矩核对目标文件夹（`electron/codex-sessions.ts` 的
  `isReadableRolloutDirectory`，11-18 复核 D13、0.2.25 总单第 26 项）。读取（详情、导出、恢复）只认真实位置在 CODEX_HOME
  真实位置之内的记录文件，而归档目标只做了字面检查：`archived_sessions` 被联接到别的盘时，移动和改数据库都成功，之后这条
  会话在界面上再也打不开、恢复不回来。现在这种情况在备份、写日志、改数据库、移动文件之前就拒绝，提示沿用已有的
  「归档目录不在 CODEX_HOME 内，已拒绝操作」，原文件和数据库都不动。
- 恢复时原来的日期文件夹如果已经被联接到 CODEX_HOME 外面，改放进 `sessions/recovered`；连它也在外面就拒绝
  （「恢复目录不在 CODEX_HOME 内，已拒绝操作」），会话保持归档、照样能看。只收紧写入，读取的规矩没放宽：
  以前已经被归档进这种文件夹的会话，界面上仍然恢复不了。
- 会话导出（`electron/session-markdown-export.ts`）写临时文件的流一建好就挂上 error 监听。以前只在最后收尾时才挂，
  中途写失败（ENOSPC、U 盘拔掉的 EIO）时 Node 在流上发的那次 error 事件没人听，成了主进程未捕获的异常，整个应用退出
  （11-18 复核 D14、0.2.24 全面检查 O-1）。错误本身照旧由每一笔的写入回调交回，渲染层认得 ENOSPC，上屏「这块盘满了」。
- 收尾改成 `end()` 后 `stream/promises` 的 `finished`，等文件句柄真关上、关文件报错也算失败，再改名；以前 `end` 的回调在
  finish 时就放行改名，关文件那一步报的错被丢掉，会把没落盘的文件当成导出成功。失败时等句柄关上再删临时文件，
  删不掉也照样抛原来的错，不让一句删临时文件的报错盖掉「盘满了」。
- 设置 › 隐私数据「自动发送错误报告」那行说明加上「或卡住」（yoyo 11-20「改字」）：#1971 起卡住时也按这个开关上报卡在哪段代码。
  经界面文案正式化，现在的字是「出错或无响应时，将错误信息、版本和系统信息发送至海外错误收集服务；不包含账号、密钥、文件路径和对话内容」。
- 登录后说一次的那张卡片和点「不想发送」后的提示也跟着加（yoyo 11-20「按照你的推荐」），正式化以后的字：卡片标题「软件出错或无响应时将发送错误报告」，
  正文开头「软件出错或无响应时，将自动向海外错误收集服务发送错误报告……」，提示「已关闭，出错或无响应时不再发送错误报告。如需重新开启，请前往「设置 › 隐私数据」。」。
  已经看过卡片的不会再看到。
- 0.2.25 设置客服反馈复查第 4～10 条改字（逐条原字在 `/mnt/project-files/0.2.25-复查/设置客服反馈复查.md`，yoyo 11-26 回「都按照推荐」）：
  - 恢复备份后找不到恢复前另存那份时的报错原来叫客户去「反馈与客服 › 运行日志」导出，可那个页签上没有导出；改成「请在「反馈与客服」页导出反馈报告并发送给客服。」。
  - 「星芒占用空间」卡六行说明、合计、正在计算、清理提示、「清理旧备份？」框；「装工具时下载的文件」改名「安装工具时下载的文件」。
  - 「工具配置备份」卡：标签「手工」→「手动」，说明「改 … 配置前」→「修改 … 配置前」，预览框和恢复确认框统一为「恢复前将自动另存当前配置，恢复后需重新打开工具。」，成功提示「原配置已另存」。
  - 帮助弹窗格子「跑一遍检查」→「运行检查」；运行日志筛空时、设置搜索结果上面两句提示；版本卡磁盘不足时的「怎么清理」→「查看清理方法」；桌面通知关着时那句。
  - 首页气泡和「必须更新」那层门里的「怎么清理」不在这次确认的范围里，没动。断言旧字的用例跟着换成新字，没有放宽或跳过用例；`ui-spec/04-pages.md` 同步。
- 设置 › 隐私数据的「用户协议」「隐私政策」以前自己调 `getLegalDocument(kind)`、不带账号来源，主进程按当前账号读：
  历史账号（sub2api）那边没有协议，点了只报「当前账号暂不支持此功能」；星芒账号读到的也原样塞进 `<pre>`，显示成 Markdown 源码。
  现在两颗按钮只调 `BusinessActions.openLegal`，打开 App 外壳里欢迎页、登录框共用的 `features/auth/LegalDocument`
  （固定读星芒账号那一份、MarkdownView 排版、读失败有「重新读取」），设置页自己的那个弹窗和 `.v2-business-legal` 样式删掉。
  外壳没给 `openLegal` 时这一行不出现（缺省 = 不显示，只有没接外壳的夹具会这样）。
  0.2.25 设置客服反馈复查第 1 条；`app-check.mjs` 两种账号各一条用例，旧代码上红。
- 三块融合第 4 步「出图框合一」（yoyo 2026-11-20 回「融合改」，方案 `0.2.25-方案/三块融合/方案.md` §9、新字 §2.7）。视频工作台镜头上的
  「让 AI 画一张」「再画一张」点了以后弹的换成出图框 `features/video-studio/ShotImageDialog.tsx`，跟对话里「生成图片」那一档是同一个：
  尺寸、画质、分辨率那一排抽成两边共用的 `features/chat/ImageOptions.tsx`，记的是同一份 `features/chat/image-settings.ts`
  （型号、分组、尺寸、画质、分辨率，按账号记在这台电脑的 `xingmang-ui-v2:image-settings:〈账号〉`，读进来逐字段核，改了通知正开着的另一边）。
  「想法」卡里的「画镜头图」型号菜单和原来那个只问画不画的确认框去掉了。
- 对话里「生成图片」的型号、尺寸、画质、分辨率从每段对话各记各的改成这个账号记一份：改的时候往共用的那一份里写，切到这一档、打开一段对话、
  新开对话、模型表读完、别处改了这一份时照它对一遍（`useChatController` 的 `syncImageSettings`）。对话记录里每段对话那几个字段照旧存，格式没动；
  文本对话和生成视频不受影响。手填到一半、还不合型号规矩的尺寸不记。
- 镜头图的请求写法改成同对话里出图（`buildVideoStudioImageRequest(draft, requestId)`）：尺寸、分辨率都带，型号有画质档位才带画质，能带参考图
  （`sourceAssetIds`，型号得会改图）。以前不带画质和分辨率、用模型缺省；现在跟着共用的那一份，一次没选过的还是「低」「1K」。
  尺寸客户没在框里改过时按这条视频的画面挑（记的那个横竖对得上就用它，对不上按 `videoStudioImageSize` 另挑），这样自动挑的不往共用的那一份里记。
  在框里改的画面描述只管这一张图，不写回镜头。`useVideoStudio` 的 `drawShotImage(id, draft)` 收框里选好的那一份，`selectImageModel` 撤了；
  工程里的 `settings.imageModel` / `imageGroup` 两个字段照留（老工程照旧读，出图框没有记过时拿它当打开时的型号），不再有地方改它。
- 没有新增 IPC 通道：出图还是 `chat:generate-image`，挑参考图还是 `chat:pick-images`。`canvas-v2/` 没动。
- 这一步客户看得见的字按 2026-11-21 定的正式口吻写，跟方案原话的逐字对照在 PR 正文和 `0.2.25-方案/三块融合/第4步-新加的字.md`。
  这一版给客户看的更新说明已经满 60 条，这一步不另加一条。
- 没做的：画布里出图的那一步和「生成配置」不动（在画布内核里）；「放进画布」（第 5 步，等 yoyo 亲手打同意句）。
- `windowsStandardAccountAdvice`（`windows-elevation.ts`）不再叫普通账号「在授权窗口里输入一个管理员账号的密码」：
  Node.js 和 Codex 桌面端 / Claude Desktop 的提权脚本都只认当前账号本人的令牌（不是本人退出 2225，#137 起），
  普通账号输了别的管理员的密码照样装不成，那句话把人指进死路。改成按装好以后归谁分两句：Node.js 是机器级 MSI，
  叫他换管理员账号打开星芒装一次、再切回来点「重试」；桌面端只注册给装它的账号，叫他在管理员账号里装和用。
  新增类型 `WindowsElevatedInstallTarget`，两个提示函数多一个可选参数，缺省＝运行环境那句。
- 2225 也先问一次账号在不在管理员组（`node-runtime.ts` 的 `runUacProcess`、`codex-desktop-appx.ts`），普通账号时
  接同一句；管理员账号和问不出来时照旧「用当前账号的管理员身份重试」。
- 引导（`StartGuide.tsx` 的 `elevationNextStep`）把这句里的「重试」换成引导按钮的「再试一次」，跟网络那几类一样。
- 检查页「运行权限」那句「会要求输入一个管理员账号的密码」没动（没给产品所有者看过新字）。
- 普通 Windows 账号装 Node.js / Codex 桌面端时，装之前的提示（`elevation-notice.ts`，首页运行环境卡、检查页
  运行环境那一行）、检查页「运行权限」那行（`diagnostics-system-checks.ts`）、以及没问出账号类型时
  `windowsElevationDeniedMessage` 的后半句，不再叫人「输入管理员账号的密码」（#1321，0.2.25 复查第 1 条）。
  授权窗口里输别的管理员账号的密码，提权起来的是那个人的令牌，两个安装程序都只认本人，照样以 2225 停下；
  改成跟 #2034 同一个说法：先用管理员账号登录 Windows 装（Node.js 装一次本机所有账号都能用，桌面端只给装它的账号）。
  #2034 的 `windowsStandardAccountAdvice` 两句同时改成正式口吻；Node.js 那几句的主语补上空格（「Node.js 安装已停止」）。
  只改字，不放宽任何校验；界面认这些句子用的开头（「已取消管理员授权」「未获得管理员权限」「授权使用了不同的 Windows 账号」）没变，
  新旧原话逐条比过 `classifyOperationError` / `presentOperationError`，结果一致。
- 开发用影子 HOME 启动器 `scripts/dev-shadow-home.ps1` 把 `CODEX_HOME` 和 `XINGMANG_CODEX_HOME_OVERRIDE`
  都指到影子目录的 `.codex`，启动前核对程序会挑的三处 Codex 目录都在影子目录里。开发机上继承下来的这两个变量
  指着日常 `~/.codex` 时，dev 版不再改到日常配置（审查总表 T01，0.2.25 总单第 80 项）。
- 同一个脚本：`-Shadow` 给相对路径时按 PowerShell 当前位置变成绝对路径（程序遇到相对路径的开发覆盖变量会拒绝启动）；
  文件改存带 BOM 的 UTF-8，Windows PowerShell 5.1 在英文系统上不再把中文读成弯引号、整份解析失败；
  新增 `-CheckOnly` 只打印要带给 dev 版的环境就退出。Windows CI 的 PowerShell 冒烟
  （`e2e/windows-powershell-probes-smoke.mjs`）用它真跑脚本，拿编译好的 `codex-home` 核对没继承、只继承一个、
  两个都继承和相对路径四种情形。
- 发布更新源校验（`scripts/update-release-utils.cjs`）改成请求前就把地址标准化、核对在配置的更新目录内：清单里的
  文件地址在解析时按和真正发请求同一套规则落到目录里再放行，三处请求（清单、安装包、blockmap）发出前再核一次，
  不合规的直接拒、一次网络请求都不发；响应后的地址核对照旧保留。合法清单、`verify-update-feed`、回滚和清单签名的
  流程不变。审查编号 T02（0.2.25 总单第 80 项）。
- 发给第三方网站的请求不再自报「xingmang-ai-manager/版本号」（安全清单 安-1）：这串字跟公开仓库同名，Codex 镜像、
  查 IP 归属的几家、npm 镜像、官方下载站、付款页的访问记录里一搜就找到仓库。新模块 `electron/third-party-user-agent.ts`
  在任何会话建出来之前把 `app.userAgentFallback` 换成去掉程序名那一段的 Electron 默认串，再给每个会话（`session-created`，
  默认会话 ready 后再补一次）挂 `webRequest.onBeforeSendHeaders`：发往 `solov.cc`、`shenfengwl.fun` 和自家存储桶的请求补回
  原样，登录设备、update-feed-stats 的版本统计、服务端按 UA 数装机量都不受影响；调用方自己设的 UA（electron-updater 的
  `electron-builder`）不动，CI 的「 ci」记号两边都留着。默认不带名字、自家站点补回，挂不上时最多自家站点少数一次，
  不会漏给外人，付款页脚本读 `navigator.userAgent` 也读不到。2026-11-24 在 Electron 45.4.1 上实测 net.fetch、
  session.fetch、net.request、页面和图片、WebSocket、跳转的每一跳都按目标主机换对。Electron 同一会话只认最后一个
  `onBeforeSendHeaders`，测试钉着只许这个模块挂。客户界面无变化。
- 离线包同步脚本请求官方下载站时的 UA 改成通用的 `offline-package-sync/1`（原来是 `xingmang-*-cos-sync/1`）；请求
  GitHub 接口的几处照旧。顺手改对 `scripts/update-feed-stats.cjs` 里说 UA 带中文产品名的注释，实际是英文的 package name。
- `electron/tool-route-follow-service.ts`：星芒账号因为连不上自动换线、第一次没改成工具配置（文件被占住、回读不对这类）
  排了五分钟后重试的，重试改成了照样按「连不上换的线」提示重开开着的 Codex / Grok（0.2.25 总单第 33 项，审查 D21、
  全面检查 I-4）。以前重试那一轮只带 `reason: 'retry'`、不带 `fault`，改完配置不看工具开没开、也不出提示，客户以为全好了，
  开着的工具其实还走旧线路。现在每个没改成的工具记下「这次是连不上换的、哪个账号的那一轮」（`toolRouteFaultPending`），
  之后哪一轮把它改成了都按故障换线提示，日志 `route.followed` 也带 `fault: true`；再换一次线路、开机那一轮、换了账号、
  改成或不用再改了就忘掉，别的工具那一轮成没成不碰它的记号。提示照旧走 `noteToolRouteRestart`：一天一次、关了提示只标
  「需重开生效」、Grok 已关不提（Codex 一律提一句，编辑器插件看不出开没开），都不变。Codex 对话太大换线路2（`payload-too-large`）那条路不在这次范围。
- 11-18 复核 U05（0.2.25 总单第二档第 32 项）：缩到托盘关掉省内存的界面，重新加载那一下要是没成（`loadURL` 被拒，
  或加载到一半界面进程没了），`electron/renderer-release.ts` 一直停在 `restoring`，之后 show / focus 都不再加载，
  `reloadIfRendererGone` 也因 `restore('show')` 返回 true 拦住了崩溃恢复，存着的跳页一直发不出去，只能重启整个程序。
- 现在 `reload()` 把 `loadURL` 的 Promise 交回控制器（`main.ts`），失败或进程没了（`consumeExpectedExit` 返回 false 时）
  记 `renderer.restore.failed`（warn），状态仍是 `restoring`、存着的跳页留着，下次窗口出来再加载一次。每次加载有编号，
  被新一次顶掉的旧加载迟到的失败不算；失败了不自己接着重试，免得一直读不出来时反复拉起界面进程；也不退回 `released`，
  崩溃恢复那边自己重载成功时界面的报告照样能接住。再试那次不重算 `restoredBoot`、不再调 `onRestoring`。
- 浏览器测试夹具（`e2e/harness.mjs`）起不来 Chromium 时，`start` 自己把已经起好的 Vite 服务关掉，
  不再留着监听让 `node --test` 的子进程一直不退出、只能等外面的超时（审查总表 U03，总单 80）。
  `stop` 在浏览器关失败时照样关 Vite 服务、原样抛出浏览器那个错，连调两次不会重复关；
  `withBrowserFixture` 把 `start` 放进 try/finally；没 `stop` 就再 `start` 直接报错，不再丢下上一套。
  新增 `e2e/harness.test.mjs`（随 `test:browser` 跑）：假 server / 浏览器数每样各关了几次，
  另起一个真的 Vite、把 Chromium 路径指到不存在的文件，看子进程能不能自己退出（旧代码在这条上挂住，15 秒后被杀）。
- 根目录开发服务器、浏览器夹具和 vitest 的 renderer-v2、canvas 两组用例不再混用画布目录那份 React（审计 U06，总单 80）。
  canvas-v2/ 单独装过依赖时，根 Vite 的依赖扫描会从 canvas-v2/index.html 摸到那里的 react / lucide-react，
  预打包按包名只留一份、谁先被扫到用谁，主界面开发页和夹具就可能一页两份 React（图标报
  「A React Element from an older version of React was rendered」）；画布那份是旧的 React 18 时，
  画布单测实测 14 个文件 108 条红。现在 react、react-dom、lucide-react、@xyflow/react 一律从仓库根目录解析
  （`resolve.dedupe`，名单在 `scripts/renderer-single-copy.mjs`）：`vite.config.ts` 只在 v2 模式套，
  `e2e/harness.mjs` 的 `createFixtureServer` 给传 `configFile:false` 的夹具补上，`vitest.config.ts` 套在
  renderer-v2、canvas 两个 project 上；冻结的 legacy 仍走自己的 React 18 别名，canvas-v2/ 一个字没动。
  发布构建本来就只有根目录那份（CI 不在画布目录装依赖），产物不变。
  `scripts/renderer-single-copy.test.cjs` 钉住：名单盖住 canvas-v2/package.json 的全部运行时依赖，
  旁边放一份「旧副本」时根配置和夹具 server 的依赖扫描解析器仍拿根目录那份。
- 创作页出图回复的「重新生成」「删除消息」并进最后一张图的按钮排（`chat-asset-divider` 隔开），没有文字说明时不再渲染 `chat-message-tools`；testid 不变。
- 「创作」起始页的留白、间距和标志按窗口高度连续收紧（`--chat-start-squeeze`，逻辑高 820 及以上不变），矮窗口里起始卡不再落到输入框后面；app-check 在 1100 × 740、680 下核对卡整张露在消息区里、820 下留白和原来一样。
- 创作页「生成图片」时输入框下面那行改成说图片的「图片由模型生成，按实际用量计费。」；整行加了 `chat-compose-note`，计费那半句仍是 `chat-cost-note`。
- 首页工具区「已安装 N 个」和状态栏「已装 N 个工具」以前各数各的：首页算了 Antigravity 两张卡和正在装的，状态栏没算，
  同一屏一个写 5、一个写 3。两处改用 `features/tools/installed-count.ts` 的 `installedToolCount`，按首页工具区摆出来的卡数
  （命令行工具和 Codex 桌面端、外部客户端、Antigravity 两张，已装好的加正在装的）。不出新字。
- 手机遥控渠道块「打开遥控」行：有凭据、没开、没选文件夹时开关左边加 `settings-remote-{渠道}-choose-workspace`，调同一个 `chooseCodexRemoteWorkspace`；`remoteSwitchHint` 缺文件夹那句改成「请先选择工作文件夹。」。e2e 夹具加 `remoteNoFolder`。
- 手机遥控「绑定用户」一行配对后补一句「在手机上发送「帮助」可查看可用指令。」（`boundPeerText`）。
- 记录页「继续对话」三家都带记录 id：`cli:launch` 第四个参数放开到 `claude:` / `grok:` 加 64 位十六进制（`parseResumeRecordId`），主进程用 `ProviderSessionsService.resolveResumeTarget` 从记录里读出编号（Claude Code 取文件名、Grok CLI 取 `info.id`，只认 UUID）、核对文件夹后按 `--resume <编号>` 接；读不出或文件夹对不上退回按文件夹接最近一条。首页照旧。
- 记录页工具按钮按 `visibleSessionToolOptions` 摆：没装又没记录的工具不出按钮，装着的 0 条照旧出；装的名单还没检测完时全出（旧行为）。
- 记录页页头说明改为「本机各命令行工具的对话均在此处，可查看并继续对话。」，记录里本来就有不经首页打开的对话。
- 界面整体开了「避免孤字」折行（`shell.css` 的 `body` 加 `text-wrap: pretty`，输入框和可编辑区域退回默认），段落最后一行不再只剩一个字；app-check 先按默认折法量出会剩一个字的宽度，再核对界面的折法下不再这样。
- 界面改动记录改成一个 PR 一个文件：原来每个界面 PR 都往 `ui-spec/CHANGELOG.md` 最上面加一行，并行的 PR 一合就全在那一行冲突，
  带冲突的 PR 不跑 CI、自动合并悄悄卡住（#2091 撞 1 次、#2097 撞 3 次）。现在那一行写在 `ui-spec/changes/<短名>.md`，
  `npm run changelog:collect` 发版时按日期汇总回 `ui-spec/CHANGELOG.md` 最上面；`npm run changelog:check` 解析每个分片，
  PR 相对它拉分支的那个提交让 `ui-spec/CHANGELOG.md` 多了记录（又不是汇总）就报错。只拦 PR，不拦推到 main 的那次运行。
- 界面文案正式化第一批（yoyo 11-21：「口吻定，用您」「检查一遍没有问题的就按照这个清单改」）：首页（`Home.tsx`、
  `RuntimeRestartDialog.tsx`）和充值、订阅、订单（`recharge.ts`、`AccountRecharge.tsx`）的提示照
  `/mnt/project-files/界面文案正式化/清单.md` 第一节的口吻规范改写：状态用「已 / 未 / 尚未 / 无法」，要客户做的事用
  「请 + 动词」，去掉「就好、不用管、放着就行、试试」，钱的提示说「不会产生扣费」。只改字，不动版面和行为。
- 同一句话在别处的副本跟着改，免得两处说法不一：剩余天数（`balance-runway.ts`、`account-center.ts`、充值页「按近期用量」）、
  新手引导最后一步的「余额为 $0」那句（`guide-result.ts`）、教程里提到的「最近对话」「运行第一条命令」「回退到更新前的 v…」、
  `config-save-service.ts` 里叫人去点「补上」的那句（按钮改叫「启用」）、Codex「切换模型服务」弹窗标题。
- 首页「接着上次」改叫「最近对话」，`registry/pages.ts` 的搜索词两个都留着，客户按旧叫法也搜得到。
- 「已为 2 个工具配置密钥，可直接使用」比原句短一个字，按字数算的收起时间从 3.4 秒变 3.2 秒，用例跟着改。
- 跨好几页的按钮（找客服、去充值、接着聊、修好它、用星芒装一份）和 PR #1994、#2036 正在改的那几句这批不动，
  留给「按钮名统一」那批和那两个 PR 合并以后。
- 「## 用户」已满 60 条，客户那句「界面提示改为更正式、规范的书面表述」用分号并进 `home-corner-notices.md` 那条（同是首页提示的改字），
  本分片只留「## 开发」；后面几批也只写「## 开发」。
- 界面文案正式化第十批（同前几批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十六节外链提示两行、第十八节教程正文）。
- 教程正文（`registry/tutorials.ts`）按清单改成书面口吻，例如「用你自己的星芒账号登录。」→「使用您的星芒账号登录。」、
  「没配成功怎么办？」→「配置失败怎么办？」、「AI 改坏了，怎么撤回？」→「AI 修改出错，如何撤回？」。清单里写成「…」省略的几行按原句补全后照改，
  已随第三、六批改过的按钮名（「继续对话」「前往充值」「立即修复」「前往首页安装」）按现在的名字写。示例提问（客户照抄发给 AI 的那句）照旧。
- 外链提示两句：「这个链接要在浏览器里打开，已经帮你复制好了……」→「该链接需在浏览器中打开，已自动复制，请粘贴到浏览器地址栏。」等。
- 第八批留下的视频剪辑按钮名跟教程一起改：「写分镜」「重新写分镜」→「编写分镜」「重新编写分镜」，「拼成一条视频」→「合成视频」，
  「让 AI 画一张」「再画一张」→「AI 生成图片」「重新生成图片」，「换一张」→「更换图片」，「换一首」→「更换配乐」；同组的
  「出视频」→「生成视频」、「正在画图」「停止画图」→「正在生成图片」「停止生成图片」、两句鼠标提示和「AI 正在编写分镜…」跟着改。
  教程视频一章按新按钮名重写。「开始画」#2073 换成出图框后已经没有了。
- 首页工具卡「…」里的「就用现在这份配置」→「保留当前配置」（清单第三节那行，当时等教程一起改；提示条第四批已是「将保持当前配置」）。
- 不动、留给主进程那批的：教程报错对照里「这个文件夹范围太大」照旧，它是主进程 `workspace-guard.ts` 弹框的原话，客户按原话搜。
- Linux 版教程删 Desktop 那几句的表（`linuxRemovedTutorialSentences`）跟着换成新句子，不然 Linux 版会漏出「桌面端」。
- 断言旧字的用例跟着换成新字；`ui-spec/04-pages.md` 视频剪辑一节同步新按钮名。
- 界面文案正式化第十一批（主进程第一批，口吻规范同前几批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 11 批」）：
  托盘菜单、系统通知、退出和关窗弹框、自动更新的提示与报错改成书面口吻。
- 托盘：「… 正在干活，暂不让电脑自动睡眠」→「… 正在运行，已暂停系统自动睡眠」、「关掉手机遥控」「打开手机遥控」→「关闭手机遥控」「开启手机遥控」、
  「建议退回」→「建议回退」等（清单第十六节那几行）。
- 系统通知（`platform/notifications.ts`、`desktop-notifications.ts`）：例如「Codex 里这个对话太大，发不出去了」→「Codex 对话体积过大，无法发送」
  （跟启动提示卡第二批的说法一致）、「${name} 在等你」→「${name} 等待您确认」；聊天和出图完成的通知原来说回「聊天」页，页面早已并进「创作」，跟着改成「创作」页。
- 自动更新（`auto-update-install.ts`、`update-install-prompt.ts`、`updater.ts`、`linux-deb-update.ts`、`disk-space-copy.ts`、`mac-keychain-update-copy.ts`）
  的跳框、通知和报错，以及渲染层 `registry/business.ts` 里同一套版本更新卡、首页气泡、侧栏更新入口的字（两边原本逐字一致，一起改）。
  跳框按钮「稍后再说」「现在安装」教程按原话引用，照旧。「关掉并安装」「先退出，下次再装」→「关闭并安装」「退出，下次再安装」。
- 换线路、换账号后的重开提示（`running-tools.ts`）、选到敏感文件夹的弹框（`workspace-guard.ts`，标题「这个文件夹范围太大」→「该文件夹范围过大」，
  教程报错对照的标题跟着换）、文件夹不让写入的弹框（`documents-fallback.ts`）、退出时还在安装和重启时还有任务的两问、界面白屏后的恢复提示。
- 新字里不含错误目录的标题原文（`presentOperationError` 认到标题会省掉错误框标题）。运行日志里的记录不改。
- 断言旧字的用例跟着换成新字；`ui-spec/04-pages.md` 和几份 docs 里引用的字同步。
- 界面文案正式化第十二批（主进程第二批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 12 批」）：
  账号与密钥一带的报错和提示改成书面口吻，量词照第八节用「个 / 该密钥」。
- 密钥额度、停用、启用（`account-key-quota.ts`）：例如「这个工具的额度用完了，软件不会自动放开……」→「该工具的额度已用完，软件不会自动解除限制……」。
- 一键改用当前账号、切回官方账号（`account-source-switch.ts`）：「改用当前账号没有完成」→「改用当前账号未完成」、「已经开着的 … 要关掉重开才会换过来」
  →「已打开的 … 需关闭后重新打开才会生效」、恢复也失败时「请到「设置 › 备份迁移」里恢复切换前那一份」→「请在「设置 › 备份迁移」中恢复切换前的备份」。
- 账号刚切换那句「账号刚切换过，请再试一次」→「账号刚刚切换，请重试」，所有抛出处和界面的整句比对一起换。
- 切到登录已失效的保存账号那句（`realm-account.ts` 的 `SAVED_EXPIRED`）改成「该已保存账号的登录已失效，当前账号未变化。请点击「重新登录该账号」重新登录。」；
  界面 `SavedAccounts.tsx` 靠它给出「重新登录该账号」按钮的那条正则新旧说法都认，补了用例。
- 登录（`new-api-client.ts`）：两步验证三句、设备数满 / 一天登录次数过多 / 登录过于频繁三句；界面 `auth/state.ts`、`auth/account-errors.ts` 的副本和正则跟着改，正则新旧说法都认。
- 支付窗口、开票窗口、付款方式停用、聊天记录导入导出（`data-transfer.ts`，界面 `chat/storage.ts` 的副本同步）、本机账号存满、托管密钥和聊天分组密钥缓存
  （「API Key」→「密钥」）、`safe-storage-backend.ts` 安全保存不了密码那句；`operation-error.ts` 认这两句的正则新旧都认。
- 导入文件被占用那句改成「可能已被其他程序打开」，不写「正被……占用」，免得被错误分类认成「工具正在运行」（X-7）。
- 新字里不含错误目录的标题原文。`new-api-messages.ts`（上游原话表）、`sub2api-relay-backend.ts` 不改。断言旧字的用例跟着换成新字，
  「旧日志里的说法也要认」的用例保留旧字并补上新字。
- 界面文案正式化第十三批（主进程第三批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 13 批」）：安装与运行环境一带的提示和报错改成书面口吻。
- 装和更新命令行工具（`cli-install-service.ts`、`npm-failure-reasons.ts`、`tool-installation.ts`、`install-cancellation.ts`）：例如「这次更新没装上，旧版本回滚失败，工具现在可能打不开」
  →「本次更新未能完成，且旧版本回滚失败，工具当前可能无法打开」、「过一会儿再点「重试」；一直这样请找客服。」→「请稍后点击「重试」；如持续出现，请联系客服。」。
- 一键装 Node.js / Git / Python（`node-runtime.ts`、`macos-node-runtime.ts`、`linux-node-runtime.ts`、`git-runtime*.ts`、`macos-git-install.ts`、`macos-command-line-tools.ts`、
  `python-runtime.ts`、`runtime-install-service.ts`）：「Git 没装上」→「Git 安装失败」、「网络断了一下，正在从……接着下载」→「网络曾短暂中断，正在从……继续下载」。
- 卸载（`cli-uninstall-service.ts`、`claude-native-uninstall.ts`、`macos-uninstall.ts`，卸载窗口里那几行跟着换）、Mac 上装桌面端和挪进「应用程序」
  （`macos-desktop-app-installer.ts`、`macos-desktop-install-failure.ts`、`macos-install-location.ts`）；`macos-desktop-install-failure.ts` 认这些说法的地方同一处一起换。
- 终端里工具退出后、进不去项目文件夹时打出来的几行（`cli-exit-hint.ts`）前面的清单漏了，补在这批。
- 只进运行日志的几句、认 npm 和系统输出的正则、`scripts/update-feed-stats.cjs` 的统计分类名不改。新字不含错误目录的标题原文；141 条逐条比过，
  `classifyOperationError` 对新旧说法给出的分类一致。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化第十四批（主进程第四批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 14 批」）：配置、线路与检测一带的提示和报错改成书面口吻。
- 写工具配置、保存与换型号（`config-files.ts`、`config-save-service.ts`、`config-write-blocker.ts`、`official-credential-service.ts`、`workspace-config-overrides.ts`）：
  例如「工具配置在改线路时被别的程序改了，这次先不改」→「工具配置在切换线路时被其他程序修改，本次暂不修改」；复查第二轮第 14 条的「Codex 工作目录不能为空」→「请先为 Codex 选择项目文件夹」。
- 连接自检与联网报错（`connection-check.ts`、`codex-responses-probe.ts`、`network-failure.ts`）：「连不上星芒服务」→「无法连接星芒服务」。
- 「检查」页各项的标题与结论（`diagnostics-*.ts`、`diagnostic-fixes.ts`、`stale-proxy-environment.ts`）：「查网址的服务（DNS）」→「域名解析服务（DNS）」、「别的代理软件」→「其他代理软件」；
  教程里引用的检查项名跟着换。前面清单漏列的「安全证书」一项（`certificate-trust-probe.ts`）补在这批。
- 只进运行日志的几句、Gemini 那句（已下线）不改。新字不含错误目录的标题原文；258 条逐条比过，`classifyOperationError` 对新旧说法给出的分类一致：
  官方密钥挪不开那句保留「无效令牌」（`account-cli-provisioner.ts` 的 `isCredentialFailure` 认它），系统时间那句写「证书校验不通过」、「文档」文件夹那句写「磁盘无可用空间」，
  不会被认成更新校验失败或磁盘已满。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化第十五批（主进程第五批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 15 批」）：Codex 桌面端、外部客户端和插件一带的提示和报错改成书面口吻。
- Codex 桌面端的打开、安装、更新、重置（`codex-desktop-service.ts`、`codex-desktop-install-failure.ts`、`codex-desktop-known-issues.ts`、`codex-desktop-cdp.ts`、`provider-launch-service.ts`、`macos-codex-app.ts`）：
  例如「Codex 桌面端没有打开：等了将近一分钟，没有等到它的窗口」→「Codex 桌面端未能打开：等待近一分钟，窗口仍未出现」。
  装不上那句的开头「Codex 桌面端没装上」改成「Codex 桌面端未能安装」，Claude Desktop 那句同样改成「Claude Desktop 未能安装」：
  没用「安装失败」，因为装之前查盘那句的开头就是「Codex 桌面端安装失败：」「Claude Desktop 安装失败：」，界面按开头认这一类，撞上会把磁盘不足认成装不上。
- 外部客户端（`external-client-*.ts`、`claude-desktop-*.ts`）：「已经有配置了或者正开着，这次没有自动连接」→「已有配置或正在运行，本次未自动连接」。
- 插件、MCP、技能（`provider-extensions.ts`、`codex-extensions.ts`）：「没法确定这个技能装在哪里」→「无法确定该技能的安装位置」。
- 复查第二轮第 14 条：「工作目录」在这批的改成「项目文件夹」（`windows-elevation.ts`、`ipc/parsers/`、`workspace-access.ts` 等），记住的文件夹没了那句界面新旧都认；
  第 10 条：「Codex 命令行版」统一叫「Codex CLI」（产品负责人 2026-11-22 回「命令行版改」），报错框按钮「改用 Codex CLI」和 `operation-error.ts` 按按钮名找动作的那处一起换。
- 下载与校验的原话、错误 detail 和只进运行日志的几句、Gemini 专用的几句不改。新字不含错误目录的标题原文；165 条逐条比过，`classifyOperationError` 对新旧说法给出的分类一致。
  断言旧字的用例跟着换成新字；已知打不开那一版的提示不许出现技术词的那条用例，放行了「Codex CLI」这个名字，其余 CLI 字样照旧不许出现。没有跳过用例。
- 界面文案正式化第十六批（主进程第六批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 16 批」）：手机遥控一带的提示和报错改成书面口吻，共 204 处。
- 手机上收到的回复（`codex-remote-text.ts`）：例如「Codex 还在处理上一条。等它做完再发，或者发「停止」中断它。」→「Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。」；
  客户在手机上打的指令（新对话、停止、状态、文件夹、关闭遥控、重试、帮助、同意、拒绝）原样不动。
- 遥控服务、设置与凭据、飞书、微信的报错（`codex-remote-*.ts`、`bootstrap/codex-remote.ts`）：「连不上飞书，正在重试。」→「无法连接飞书，正在重试。」，
  「这台电脑还没装 Codex 命令行工具，先在首页把它装好。」→「本机尚未安装 Codex CLI，请先在首页完成安装。」。
- 手机遥控页（`CodexRemotePage.tsx`、`remote-view.ts`、飞书与微信两节）和教程「用手机遥控 Codex」一章里跟主进程原话互相引用的字：「干活的文件夹」→「工作文件夹」、「停下这一轮」→「停止本轮」、「都拒绝」→「全部拒绝」、「绑定的人」→「绑定用户」。
- 跳过 #1935 已按书面口吻改过的帮助那句和审批卡正文，以它为准。只进运行日志的几句不改。新字不含错误目录的标题原文；204 条逐条比过，
  `classifyOperationError` 的分类只有手机上收到的「余额不足，请充值后重新发送。」一条变了（只发到手机上，不经过错误框）；
  渠道连不上、微信登录过期、扫码等太久那几句特意避开「连接失败」「登录状态已失效」「超时」，分类前后一致。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化第十七批（主进程第七批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 17 批」）：对话、出图、视频剪辑和画布一带的提示与报错改成书面口吻。
- 作品不在本机、存不进保存位置、聊天附图附文件、聊天记录保存、对话失败、出图失败和扣费说明、视频生成、视频剪辑、画布运行：例如「保存位置写不进去，这次没有扣费。」→「保存位置无法写入，本次未扣费。」。
- 清单漏列、补在这批：余额不足 / 密钥额度上限 / 密钥失效三句（`relay-quota-failure.ts`，对话、出图、视频、手机遥控共用；量词按 11-21 定的「该密钥」），视频页「AI 只写了 N 个镜头」那句，画布运行时交回视频帧、图片处理结果那一步的 12 句（`canvas-run-preparations.ts`）。
- 视频页说作品存在哪时统一叫「作品库」（复查第二轮第 13 条，yoyo 11-22 回「作品库统一」），讲「打开文件夹」那颗按钮打开的磁盘文件夹时照旧叫「AI 作品文件夹」。
- 界面按原话认的几处跟着新旧都认：对话页认「保存位置无法写入」「请勿重新生成」「参考图过大」「本次描述或参考图未通过安全审核」，视频页认「已停止生成分镜」，成片提示旁的「打开文件夹」按钮认「作品库」。对话太长那句的新开头「当前对话」本来就在原样上屏的名单里。对话页自己拦下附图数量时、加图和加文件按钮提示里的同一句（「每条消息最多附带 N 张图片 / 个文件」）跟主进程一起换。
- 发给 AI 的提示词、只进运行日志的几句不改。新字不含错误目录的标题原文；87 条逐条比过，`classifyOperationError` 分类前后一致。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化第十八批（清单原先漏列、11-22 补，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 18 批」）：画布在主进程那半的提示与报错改成书面口吻，共 77 处。
- 视频帧和图片处理结果存不下、节点桌面版暂不支持、一组图没出齐、找不到当初的生成记录、室外与故事板任务、文字节点连的视觉图片、画布上传图片、画布项目（复制、换文件夹、删除、默认文件夹）、双击打开画布项目文件：例如「这次要出 4 张，一张都没出来：……」→「本次需生成 4 张，均未生成：……」「视频超过 32 MB，画布抽不了这一帧」→「视频超过 32 MB，画布无法提取该帧」。
- 画布内核（`canvas-v2/`）一个字不动；跟内核同一句的、内核界面里的叫法（「工作文件夹」「换个位置创建…」「已归档」）照原样。内核契约样例由 `electron/fixtures/canvas-kernel-contract/generate-fixtures.mjs` 重新生成。新字不含错误目录的标题原文；77 条逐条比过，`classifyOperationError` 分类前后一致。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化第十九批（清单原先漏列、11-22 补，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 19 批」）：设置、启动、技能与插件、会话记录、终端一带的提示与报错改成书面口吻，共 116 处。
- 设置页开机自动启动与窗口连接方式的说明、打不开时的系统弹框、导入技能压缩包、Codex 插件目录、打开导出的文件与会话记录所在文件夹、会话记录的删除与归档、配置文件读不懂或是链接、项目文件夹、连接复制、Linux / Mac 上命令窗口没起来、Linux 上的管理员与画布安全保护、Grok CLI 安装校验、推荐版本说明与停用版本原因、授权窗口、工具正在运行等：例如「插件目录没有下载下来，当前网络连不上或太慢」→「插件目录下载失败，当前网络无法连接或速度过慢」「没有找到这个连接，请刷新列表后再试。」→「未找到该连接，请刷新列表后重试。」。
- 只进运行日志的、写给客服看的反馈报告正文、发给 AI 的提示词、写进客户文件里的注释、`remote-features.ts` 停用那几句不改；手机遥控相关的归第 16 批。`docs/CLI-VERIFIED-VERSIONS.md` 里推荐版本说明的示例换成正式口吻。
- 认自家说法的地方跟着换：`operation-error.ts` 认插件目录旧备份那句的正则新旧都认；`config-link-refusal.ts` 里配置文件是链接那句和界面认它的标志是同一个常量，一起换成新字。新字不含错误目录的标题原文；116 条逐条比过，`classifyOperationError` 分类前后一致（版本检测那句写「未连接网络」，保留超时一类）。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化第二批（同第一批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第六、七节）：
  登录、注册、找回密码、两步验证、欢迎页、新手引导（`features/auth/`），外壳、公告、断网提示、启动提示卡、卸载星芒、
  出错弹窗、已知问题与维护提示、强制更新、数据迁移和各类修复小提示（`App.tsx`、`features/app/`、`features/shell/`）
  改成书面口吻。只改字，不动版面和行为。
- 检查页三个按钮改名（「挪开这份设置 / 删掉这几项设置 / 挪开这份说明」→「停用此设置 / 删除这些设置 / 停用此说明」），
  主进程 `diagnostics-override-checks.ts` 结论里叫人点「挪开这份说明」的那句跟着改，免得字和按钮对不上。
- 退出登录确认框里拼在一起的几句（个人中心那个入口的「已配好的工具会保留。」、`launch-notice.ts` 的「会继续装完 / 卸完」、
  `chat-image-work.ts` 的出图提醒）提前跟着改，两个入口的确认框仍一字不差。
- 新手引导结果卡「费用：」后面那几句去掉重复的「费用」二字。
- 不动、留给主进程那批两边一起改的：两步验证三句、设备数满 / 一天登录次数太多 / 登录太频繁三句（`new-api-client.ts` 原话的副本，
  界面靠它逐字认情况）、本机账号存满那句（注释写明与 `realm-account.ts` 一致）。用例里模拟主进程报错的输入照旧用主进程原话。
- 带跨页面按钮名的句子（新手引导的「再试一次」「找客服」「去登录」、错误框目录引用的按钮名、「Codex 桌面端还开着」）留给第三批
  按钮名统一。
- 界面文案正式化第二十批（补漏，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 20 批」）：前面各批替换表外、按旧说法扫全仓找出的几句改成书面口吻，共 13 处。
- 反馈与客服页「日志保存失败」那条提示里的原因（`runtime-log.ts`）：例如「日志所在的文件夹被搬到了别的位置」→「日志所在的文件夹已被移动到其他位置」「磁盘满了」→「磁盘已满」。
- 对话页加图、加文件按钮的提示和几句报错：例如「加参考图（也可以直接粘贴截图）」→「添加参考图（也可直接粘贴截图）」「请先登录，再加文件」→「请先登录后再添加文件」「找不到要编辑的消息」→「未找到要编辑的消息」；视频剪辑拼成片前「片段的时长读不出来」→「片段的时长无法读取」。
- 只进运行日志的、写给客服看的反馈报告正文、设置页和教程里供客户搜索的关键词不改。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化补漏第二批（0.2.25 复查第三轮第 9 条，口吻规范同前几批，逐条对照在 `/mnt/project-files/界面文案正式化/补漏2-改了哪些字.md`）：
  正式化 20 批之后新加的和漏掉的口语改成书面口吻，只改字，不动版面和行为。
- 复查点名的：退出时聊天还在回复那一问（`quit-blocking-tasks.ts`，「正在回复，退出会停下这条回复。」「等它说完」→
  「对话仍在回复，现在退出将中断本次回复。」「等待完成」，按钮跟重启装更新那一问同名）；设置 › 消息通知三行（`registry/business.ts`）；
  视频剪辑「画面对不上时」→「画面比例不一致时」；没登录时备份迁移那句；「文档」写不进时的弹框（`documents-fallback.ts`）；
  检查页「运行权限」那行的原因（`windows-elevation.ts`）；记录页导出文件里的「工作目录」→「项目文件夹」；长期嘱咐的三句报错；
  插件页装外接工具那句（顺带把技术词「环境变量」换成添加连接时那一栏的名字「附加设置」）。
- 扫出来的同类：教程步骤标题和按钮（「看到「当前账号」就继续」→「确认显示「当前账号」」、「去首页…」→「前往首页…」等）和几句正文；
  按钮名「去处理」「去调额度」「去续费」「去官网下载」→「前往处理」「前往调整额度」「前往续费」「前往官网下载」（主进程里引用按钮名的
  三句跟着改：证书、DNS 的检查结论和 OpenCode 一键装不了的提示）；打开记录文件夹、新建项目文件夹的两句报错；
  远程停用功能的几句（`remote-features.ts`，渲染层靠的那半句「修好以后会自动恢复」一起换成「修复后将自动恢复」，
  `isRemoteFeatureOffMessage` 照旧认）。
- 不改的：`new-api-messages.ts` 那句是服务器回话按上游原样翻的表；`macos-desktop-app-update.ts` 那两句只进错误详情（给客服看的原话）；
  教程里客户会打的搜索词、示例提问照旧。
- 用 esbuild 打包新旧 `operation-error.ts` 逐条比过改了的主进程原话，分类和错误框标题都没变。断言旧字的用例、
  `ui-spec/04-pages.md` 和几份 docs 里引用的字跟着换成新字；反向断言里早已过期的「去官网下载 Node.js」也换成现在的按钮名。
- 界面文案正式化第三批（同前两批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第九节和各节标「随第 3 批」的行）。
- 跨页面的按钮名统一：找客服→联系客服、马上充值→立即充值、看日志→查看日志、修好它→立即修复、去充值→前往充值、
  接着聊→继续对话、用星芒装一份→使用星芒安装、补上→启用、去检查（页）→前往检查（页）、帮我清理→一键清理等。
  按钮本身、错误目录的按钮表（`operation-error.ts` 的 `actionIds` 键跟着换）、界面和主进程句子里提到这颗按钮的地方、
  教程里的按钮名引用一起改，用例里按按钮名找元素的地方跟着换。
- 错误目录（`registry/errors.ts`）的标题和说明、检测失败与通用失败的句子（`business-common.tsx`）、列表空状态
  （`ui/shared.tsx`）改成书面口吻。
- 前两批留下的、带这些按钮名的句子一起改：新手引导的安装 / 步骤失败说明和结果卡、充值页购买区、「Codex 桌面端正在运行」
  （首页两个框、桌面端更新框、教程标题）、`runtime-readiness.ts` 那句（新手引导靠它开头认出是运行环境那一段）。
- 错误目录里磁盘那两类叫「磁盘可用空间不足」、限流叫「请求次数过多」、桌面端装不上叫「…安装未成功」，不用更顺口的
  「磁盘空间不足」「请求过于频繁」「…安装失败」：主进程原话里本来就有这几段字，`presentOperationError` 看到原话里含标题
  会把错误框的标题和按钮整个省掉。`errors.ts` 开头补了一句注释。
- 主进程整句的口吻这批不动，只换句子里提到的按钮名；手机遥控里客户发给机器人的话、用例里模拟主进程原话的输入照旧。
- 界面文案正式化第四批（同前三批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第八节、第十节、第十七节）。
- 个人中心（资料、切换账号、密钥、用量、安全、返利）、首页其余（配置弹窗、安装与卸载、版本行、打开工具时的提示）、
  各页共用的状态牌（`registry/status.ts`）改成书面口吻，例如「还没有配置密钥」→「尚未配置密钥」、「配置坏了」→「配置已损坏」、
  「这段时间没有调用」→「该时间段暂无调用」。
- 密钥的量词照 yoyo 11-21 的决定改成「个」（「您共有 3 个密钥」「3 个，其中 1 个正在被工具使用」），单指一个时写
  「该密钥 / 此密钥」，不再用「把」。
- 几颗按钮改名：「让它下线」→「下线此设备」、「换成星芒装的」→「改用星芒安装」、「重新登录这个账号」→「重新登录该账号」、
  「自己填写密钥」→「手动填写密钥」、「换成新版」→「立即更新」、「先不换 / 先不更新」→「暂不更换 / 暂不更新」、
  「保持现在这样 / 改回先问我」→「保持当前设置 / 改为执行前确认」。主进程 `realm-account.ts` 里提到「重新登录该账号」的那句、
  教程里提到这些按钮的地方、注释里的按钮名一起换。
- 不动、留给主进程那批的：`features/auth/api.ts` 的「账号刚切换过，请再试一次」是主进程原话的副本（`account-read-error.ts`
  按原话认）；#2037 加的「启用」密钥那几句和密钥停用、额度用完的提示都是主进程 `account-key-quota.ts` 的原话。
- 断言旧字的用例跟着换成新字。「暂无订阅」现在账号概览和充值页两处都有，v2-business 里那条按字找的用例改成在充值页里找。
- 界面文案正式化第五批（同前四批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十一节）。
- 设置页（常规、工具、隐私、备份、存储、版本更新）和「手机遥控 Codex」卡（含飞书、微信两段）改成书面口吻，例如
  「这台电脑上用不了」→「本机不可用」、「暂未读到」→「暂未获取」、「没算出来」→「无法计算」、「还没有备份」→「暂无备份」、
  「等你同意 2 条」→「待确认 2 条」、「Codex 没能启动」→「Codex 启动失败」。
- 按钮改名：「用这个」→「使用此文件夹」、导入设置询问框的「保留这台电脑的 / 换成文件里的」→「保留本机设置 / 使用文件中的设置」。
- 测试通知那句没有照清单写「已发送测试通知」，改成「测试通知已提交给系统……」：系统里把星芒的通知关了也照样发得出去，
  决定单 D68 定过界面不能说「已发送」，有反向断言钉着。
- 清单漏列、复核时补的几句同类句子：写入范围和署名两个开关拨完的另一半提示、显卡加速那行说明、账号不在管理员组时更新框那句、
  遥控凭据存不下时的两个标题。
- 不动、留给主进程那批的：遥控卡片上和主进程遥控原话互相引用的字（「干活的文件夹」「停下这一轮」「都拒绝」「不自动关」「换人」
  「已连上」「要重新登录」等），以及 Linux 退出时那颗「关掉并安装」（主进程 `auto-update-install.ts` 的系统对话框同名）。
- 断言旧字的用例跟着换成新字，反向断言也换成新字。
- 界面文案正式化第六批（同前几批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十二节）。
- 「插件」页（插件、连接、技能）和添加连接、安装插件的弹窗改成书面口吻，例如「连不上」→「无法连接」、「还没装」→「未安装」、
  「这台电脑还没装 …」→「本机尚未安装 …」、「没认出这段配置」→「无法识别此配置」、「换个词试试。」→「请尝试其他关键词。」、
  「给 … 装这个插件？」→「是否为 … 安装此插件？」。
- 按钮改名：「去首页安装」→「前往首页安装」（跟第 3 批「去…」→「前往…」一致，教程里引用它的那句跟着改）、详情页每家那行的「装上」→「安装」。
- 清单漏列、复核时补的同类句子：连接状态小标「能连上」→「连接正常」（跟「无法连接」成对）、卸载框「插件里带的技能、命令和连接会一起移除。」、
  粘贴配置认不出时的说明、服务地址开头不对那句、一段里有好几个连接时的选择框和提示、「认出来了：」→「已识别：」、
  「还缺一样：」→「待填写：」、插件目录下载好 / 官方市场加好后的那句。
- 「装到哪里」「装到 GPT」「装到 N 个」这一组标签照旧，教程和示意图都按这个名字引用。
- 断言旧字的用例跟着换成新字，反向断言也换成新字。
- 界面文案正式化第七批前半（同前几批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十三节）。
- 对话的报错、聊天记录读写与导入导出、常用语、参数说明改成书面口吻（`features/chat/` 的 `state.ts`、`storage.ts`、`transfer.ts`、
  `useChatController.ts`、`api.ts`、`PhrasesDialog.tsx`、`parameters.ts`），例如「没发出去：现在连不上网。」→「发送失败：网络未连接。」、
  「这段对话太长了，AI 一次读不下。」→「当前对话过长，超出 AI 的处理上限。」、「图片没有保存成功，可以重试」→「图片保存失败，请重试」、
  「还没有存过常用的话。」→「暂无常用语。」。
- `chatErrorMessage` 里按句子开头放行的正则跟着换成新句子的开头（「当前模型不支持识别图片」「当前模型不支持图片编辑」「生成图片时不支持附带文件」）；
  「^这段对话」照留，主进程 `ai-chat-service.ts` 那句「这段对话太长了……」还是原话。
- 清单漏列、复核时补的同类句子：「当前模型看不了图片……」（跟「不支持图片编辑」那句成对）、只有几段对话读不出来时那句、分组换掉时那句、
  正在读取 / 准备模型时发送的两句、同时 4 个对话时那句、限流那句、聊天正在回复时导入那句。
- 不动、留给主进程那批的：导入文件认不出来那句（`storage.ts` 的 `transferInvalidMessage`，是主进程 `data-transfer.ts` 原话的副本）、
  「一条消息最多带 N 张图片」（主进程 `ai-chat-attachments.ts` 也有同一句）。对话页 `ChatPage.tsx` 和创作页留给第七批后半。
- 断言旧字的用例跟着换成新字，反向断言也换成新字。
- 界面文案正式化第七批后半（同前几批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十三节）。
- 对话页 `ChatPage.tsx` 和创作页 `CreatePage.tsx` 改成书面口吻，例如起始页「想做点什么？」→「今天想创作什么？」、
  「问问题、写东西、画图、做视频，都在下面这一个框里说。」→「提问、写作、绘图、制作视频均可在下方输入框中完成」、
  「还没做过东西。在右边的框里说一句试试。」→「暂无内容。请在右侧输入框中输入您的需求。」、菜单「改名」→「重命名」、
  「删掉这一条…」→「删除此视频…」、「视频最多存 200 条，先删掉几条不要的再新建。」→「最多保存 200 条视频，请先删除不需要的视频后再新建。」。
- 起始页的卡「在画布上一步步做」→「在画布中分步创作」、视频顶栏「删掉这一条」→「删除此视频」：教程里引用这两处的字
  （`registry/tutorials.ts` 画布一章的「左侧创作 › …」、视频一章「不要的那一条…」），以及视频一章「「创作」里没有…」那条补充
  （跟视频剪辑页空状态逐字一致），跟着换。「做一条带字幕的短视频」照旧，教程正文按这个名字引用。
- 不动、留给主进程那批的：「画布项目暂时读不出来」在主进程 `ipc/handlers/window.ts` 也有同一句（创作页列表底下那句已改成
  「画布项目读取失败」，两句不是同一处）。
- 断言旧字的用例跟着换成新字，反向断言也换成新字；`tools/model.test.ts` 一条反向断言还查着第 4 批换掉的「还没生成」，换成「尚未生成」。
- `ui-spec/04-pages.md` 创作页一节同步新字。
- 界面文案正式化第八批（同前几批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十四节）。
- 视频剪辑（`features/video-studio/`）的状态、确认框、报错改成书面口吻，例如「没生成出来」→「生成失败」、「还没生成」→「尚未生成」、
  「重新生成这一段？」→「是否重新生成此片段？」、「在这台电脑上拼，不花钱。」→「在本机合成，不产生费用。」、
  「片段加起来超过 1 GB 了，少放几段再拼」→「片段总大小超过 1 GB，请减少片段后再合成」、「不用配乐」→「不使用配乐」、
  「已拼成片」→「已合成成片」、「还没写分镜」→「尚未编写分镜」。
- 清单漏列、复核时补的同类句子：拼片协议里「…的剪切时间不对」「成片的画面设置不对」→「…的裁剪时间无效」「成片的画面设置无效」，「拼片线程收到了看不懂的消息」→「合成任务收到无法识别的消息」。
- 不动、留给第十批（教程正文）的：教程里引用的按钮名「写分镜」「重新写分镜」「拼成一条视频」「让 AI 画一张」「再画一张」「换一张」
  「换一首」「开始画」，这一批照旧。留给主进程那批的：「这首歌读不出来……」（主进程 `video-studio-plan.ts` 原话的副本）、
  素材不在电脑上那句（主进程 `ai-asset-missing.ts`）。
- 断言旧字的用例跟着换成新字，反向断言也换成新字；`ui-spec/04-pages.md` 视频剪辑一节同步新字。
- 界面文案正式化第九批（同前几批的口吻规范，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十五节）。
- 「反馈与客服」「会话记录」「检查」页和教程页外壳（含教程配图的说明）改成书面口吻，例如「已复制，发给客服就行」→「已复制，请发送给客服」、
  「这条记录的文件夹已经不在了，接不上上次的对话。」→「该记录的文件夹已不存在，无法继续上次的对话。」、「没测成」→「检测未完成」、
  「换个说法试试，或者直接问客服。」→「请尝试其他关键词，或直接咨询客服。」。
- 按钮和小标改名：反馈页「先试试这些」→「常见解决方法」，其下四条的按钮「先跑一遍检查 / 看我的订单 / 看教程 / 去插件」→「前往检查 / 查看我的订单 /
  查看教程 / 前往插件」（跟第 3 批「去…」→「前往…」一致）；会话记录删除框「先不删」→「暂不删除」；检查页「清掉这条旧设置」→「清除此旧设置」、
  确认按钮「清掉」→「清除」；教程配图里的「马上备份」→「立即备份」（跟设置页真按钮一致）。
- 清单漏列、复核时补的同类句子：反馈页「先试试这些」下另三条的标题、运行日志的空状态和读不出来时那句、清除日志确认框那句；会话记录页头和空状态那句；
  检查页额度确认那一勾、「Codex 能正常干活」；教程示例上方的小标；设置页备份列表空状态那句（第 5 批漏改）。
- 不动、留给主进程那批的：检查页「Codex 干活检查」这个名字（主进程 `codex-responses-probe.ts` 用同一个名字），它报回来的原因句。
- 断言旧字的用例跟着换成新字，反向断言也换成新字；模拟主进程报错的输入照旧。
- 界面文案正式化渲染层补漏（逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「渲染层补漏」）：前十批清单没列到的几处改成书面口吻。
- 插件「星芒精选」的风险标签、运行方式和免责说明（`registry/curated-extensions.ts`），随包目录 `bundled-catalog/curated-extensions.json` 里每一条的说明和风险一起换；
  `registry/extensions.ts` 的范围说明、`extensions-common.tsx` 第 6 批没列到的几句（如「需要先登录」→「需先登录」）。
- 连接线路说明（`registry/connection-routes.ts`）、记录详情每一轮的小结（`turn-activity.ts`：「这一轮：跑了 3 条命令」→「本轮：运行了 3 条命令」）、
  `OtherModelsDialog.tsx`、`RuntimeInstallHint.tsx`、`source-marker.ts`、`uninstall-handoff.ts`，以及教程里第十八节没覆盖到的句子
  （Linux 版删掉桌面端那句的 `linuxRemovedTutorialSentences` 跟着换成新原文）。
- 设置页几行的标题：「提醒哪些事」→「提醒事项」、「搬到新电脑」→「迁移到新电脑」、「用显卡加速显示」→「使用显卡加速显示」、「点关闭按钮时」→「点击关闭按钮时」、
  「只让 Claude Code 改项目文件夹里的文件」→「仅允许 Claude Code 修改项目文件夹内的文件」、「命令行工具总是装最新版」→「命令行工具始终安装最新版本」、
  「换线路后提醒我重开工具」→「切换线路后提醒重新打开工具」、「星芒占用的空间」→「星芒占用空间」。`settingsItems` 的 `keywords` 里旧标题留着，搜旧说法照样搜得到；
  导入时询问框里列的设置名（`electron/data-transfer.ts`）跟设置页同名。兼容显示选了「一直用」后那句提示一起换。
- 运行日志里的记录、示例提问、遥控命令、ui-spec 原型不改。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
- 界面文案正式化·教程正文补改（补漏第二批里记下的「还剩下的」，口吻规范同前几批，逐条对照在
  `/mnt/project-files/界面文案正式化/教程正文-改了哪些字.md`）：`registry/tutorials.ts` 里第 10 批和补漏第二批都没列到的
  偏口语正文改成书面口吻，共 232 处（「点「…」」→「点击「…」」、「…里」→「…中」、「装」→「安装」、「不要」→「请勿」、
  「知道…」→「已了解 / 已确认…」等），另有 9 处漏掉的步骤标题和按钮、教程配图的标题和说明 27 处（`TutorialIllustration.tsx`）。
  只改字，不改含义和步骤，不动版面和行为。
- 「记录」一章的「工作文件夹」跟记录页表头对齐成「项目文件夹」；「设置 › 版本更新」里「怎么清理」那段用的是同一句
  `updateDiskCleanupDetail`，跟着一起变。
- Linux 版教程的删句表 `linuxRemovedTutorialSentences` 里四句跟着换成新句子，不然 Linux 版会漏出「桌面端」「Claude Desktop」「WSL」。
- 照旧的：客户照抄发给 AI 的示例提问、教程搜索词、引用界面上按钮名和选项名的「」里的字；插件页自己那两行分组小字
  「只能装进 Claude」「只能装进 GPT」不在教程里，这次没动。
- 断言旧字的用例（`tutorials.test.ts`、`pages-maintenance.test.ts`、`testing/app-check.mjs`）换成新字。
- 卸载页（和设置里同一口径的那一项）勾「同时清除登录记录和聊天记录」时，连 `video-projects` 一起清：`chatHistoryDirectoryNames`
  加上它。0.2.24 及以前做过的视频存在 Local Storage 里，勾这一项本来就随它清掉；#2042（三块融合第 1 步，总单 #79）改成一条一个文件
  放进 `video-projects` 以后，这一项就不清它了，换一个人用这台电脑重装还看得见上一个人的分镜。和 Local Storage 一样整个目录删，
  链接、多硬链接照旧拒绝、原样留下（I8）。`uninstall-cleanup.test.ts` 钉住 `main.ts` 里的目录名和清理范围，旧代码上红。
- 拼片逐帧画（`video-studio/compose.ts` 的 `renderSegmentFrames`）在盖淡入淡出那层之前把填充色设回黑色。
  `paintVideoStudioCaption` 画字幕时把 `fillStyle` 换成了白色，那层用的是同一个画布上下文，开着字幕的片段
  换段和片尾就淡成白的（Mac 验收 R4，0.2.25 总单第 9 项）。没字幕的片段不受影响，所以原来的淡入淡出用例没抓到；
  `browser-check.mjs` 补了一条两段都带字幕的。
- 视频剪辑确认框在「每段单独计费」后面、余额前面报「预计约 $x」（#1406 P2-1 后半，全面检查 V-2，0.2.25 总单第 14 项）。
  价目复用个人中心价格表那条现成通道 `account:get-price-list`（同一份 `/api/pricing`，主进程已乘好分组倍率、读价目走线路1），
  不加新通道。新文件 `video-studio/prices.ts`：按这次的模型和分组取按次价 × 段数；视频标「（估算）」、不到一分写「不到 $0.01」，
  同画布 `run-quote.ts`；按 Token 计、分档计、没读到的不写这句（缺省 = 旧行为）。页面一露面读一次，十分钟内再开确认框不多读，
  读失败一分钟内不重读、留着上次的；换账号时上一个账号还没回来的那次作废。生成、重新生成、画图、再画一张四处都报。
- 0.2.25 总单第 60 项（11-18 复核 A01）：视频剪辑「接着做」时手上那一格存不下，拿出来的那份会丢。#2003 修过一版
  （`storeVideoStudioSwitch`：先写草稿箱那一格、再写手上那一格，没写成就写回）；同一版里「创作」页第 1 步把草稿箱整个撤了，
  一条视频一个文件（`video-studio/library.ts`、`useVideoStudioLibrary.ts`），换视频不再搬来搬去，这个函数和它的用例跟着撤掉。
  「存不下」现在的说法和用例见 `create-page-step1.md`；给客户看的那一句不再写，界面上已经没有「接着做」这个按钮。
- 视频工作台一轮片段都回来了（排着的、在出的都没了）且至少出成一段，或者合成完存进作品库时，窗口不在前台就发一条系统通知（`useVideoStudio.ts` 的 `announceVideo`），沿用对话里出视频那一类（`task` + `video:` 前缀，「视频已生成」，点开回「创作」页），不加新字。编号用这一轮第一段的请求号、成片的编号，主进程同一个编号只报一次。之前只有对话里出视频会报，工作台出完不说（创作页复查第 5 条）。
- 给客户看的那句并进了 `video-studio-caption-fade-black.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- `video-studio/project.ts` 新增纯函数 `changeVideoStudioSettings`：改设置前后各算一次 `videoStudioComposeKey`，不一样就清掉
  `exported`，同剪片段、换配乐那几处；只换模型、改想法、镜头数、每段时长这类拼片用不上的，成片照旧挂着。`useVideoStudio.ts` 的
  `changeSettings` 改走它（Mac 验收 R8，0.2.25 总单第 50 项）。`project.test.ts` 补一条逐项核对；`browser-check.mjs` 的转场、字幕
  两条用例拼完重开后再改一次设置、断言成片撤下，旧代码上红。
- Windows 普通身份下 Grok 第一次装失败时，失败框「复制路径」复制的是 `C:\ProgramData\XingMangAI\Cli\native\grok`，
  可这时 Grok 实际装进的是个人文件夹下的 `.grok\bin`（`cli-install-service.ts` 的 `sameUserInstall`），客户照着去查写入权限、
  加杀毒白名单都找错地方。`system-scan-service.ts` 的 `resolveCliInstallTarget` 原来在 Windows 上一律报 ProgramData，
  改成跟装的时候一样：只有管理员身份报 ProgramData，普通身份报 `resolveCliUserHomeDirectory`（#1975）给的个人文件夹下的 `.grok\bin`。
  macOS、Linux 上报的位置不变。#1975 那条（D17）做的时候顺带发现的。
- 用例：`electron/system-service.test.ts` 在普通身份和管理员身份下各问一次没装的 Grok 会装到哪，普通身份那半在旧代码上红（报的是托管目录）。
- Windows CI 四个 vitest 分片的用时表（`scripts/vitest-shards.mjs`）按 11-20 五次 main 的中位数重量：11-19 那份把 config-files、
  system-service 记多了，把落在同一片的 claude-desktop-config、tool-config-ownership、codex-remote-service、backups 记少了
  （记 280 秒、实际 390 秒），那一片五次里四次跑到 11.7~12.7 分钟，别的片多数 8~11 分钟。秒数改量「这个文件在日志里占了几秒」
  （跟上一行的时间差，含加载），表收到 5 秒以上的 57 个文件，其余每个按 0.6 秒。按同样五次的中位数算，四片各 9.8~10.0 分钟。
  外部客户端、写配置这类大量写文件的套件在慢机器上会慢一半（同一个文件 182 秒对 287 秒），单次某片偶尔长一两分钟是机器，不是分组。
- Windows `vitest-2` 分片两天里两次撞 15 分钟上限（#1946、#2000，#2006）：`electron/external-client-service.test.ts`
  一个文件 138 条、在 Windows 上占 170~300 秒，分片拆不开，跑道慢一阵就把那一片推过上限。按 describe 拆成四个文件
  （原文件加 `.route-follow`、`.key-follow`、`.account-follow`），夹具挪进 `external-client-service.test-support.ts`，
  136 条用例名字和结果一条不差；`scripts/vitest-shards.mjs` 用时表按 #1972 之后五次 main 的中位数重量，同样五次下四片各
  9.2~9.9 分钟。「shows the next start the last whole detection…」不再用 `vi.waitFor` 读文件等上次检测结果落盘（默认只等
  1 秒），改成包一层 `writeAtomicSafeUtf8File` 等那次原子写本身。上限、片数、超时都没动，没跳过测试。
- 「变清晰」（全面方案第 26 件，yoyo 11-27 回「本机变清晰」，11-28 回「全补进」随 0.2.25）：对话里的图和作品库点开的图多一颗「变清晰」，在本机放大 2 倍或 4 倍、
  另存一张进作品库，原图不动，不扣费、不连网。新通道 `chat:upscale-asset`（契约、preload、注册、日志策略四处一致），只收作品编号和倍数。
- 模型随包带 Real-ESRGAN general-x4v3（BSD-3，4.6 MB，`bundled-catalog/image-upscale/`，来源和 sha256 记在 `manifest.json`，读模型时按钉死的哈希核对）；
  运行库是 onnxruntime-web 1.31.1 的 WASM 版，在主进程的 `worker_threads` 后台线程里跑（`image-upscale-worker.ts`），一次只跑一张、
  线程数 min(4, 核数−1)、分块 256 加 24 像素重叠，两分钟没动静当卡住。输入最大 2048×1152，输出不超过 4096×4096 像素数、长边不超过 8192。
- onnxruntime-web 仍是开发依赖：`compile` 由 `scripts/stage-image-upscale-runtime.cjs` 只挑后台线程用到的几个文件进 `dist-image-upscale/`（14 MB，
  不带整包 150 MB），`electron-builder.config.cjs` 把它和模型打进 app.asar；`verify-packaged-hardening.cjs` 出包后核模型哈希和每个运行库文件，
  第三方许可清单登记 onnxruntime-web、onnxruntime-common 和模型，许可文件版本对不上运行库版本时编译失败。
- 测试：纯函数用随机输入核分块拼接和 PNG 编码（自带一个独立的 PNG 解码器对照）；后台线程有真运行库加真模型的用例，服务用真模型字节核哈希；
  `stage-image-upscale-runtime.test.cjs` 在新进程里加载挑出来的那份运行库并真开模型（onnxruntime-common 的 `dist/cjs/package.json`
  少了，Node 会把那几个 CommonJS 文件当 ES 模块读，打包版第一次点就失败）；渲染层浏览器回归覆盖对话和作品库两个入口。

## 0.2.24 - 2026-11-18

- Codex 用当前账号时 `[features]` 补 `instant_interrupt = false`、`defer_mailbox_preemption = true`，
  顶层补 `suppress_unstable_features_warning = true`（只在键缺省时写，
  `keepCodexRelayResponsesUninterrupted`）。线路2 的 Responses WebSocket（new-api）只认 response.create /
  response.cancel，Codex 0.163 起在回复途中发的 response.interrupt 被回 400：子代理来信那条让这一轮失败，
  插话那条让 Codex 重连全量重传。2026-11-06 用 0.164.0、0.166.0、0.167.0 连本地假接口实测，写上后一次
  打断都不发、点停止照常；0.155.0 带这几个键照常启动。`relayTemplateRevision` 6 → 7，老客户开机补一次。
- 0.167 起的 `interrupt_on_cancel`（点「停止」时发）默认就关，不写。起初写成 `false`，推荐版 0.164.0 不认识这个键，
  每次打开都在第一屏右下角挂英文「⚠ 1 warning」（2026-11-09 新手流程深查 N3，真终端核过），这一版发出前去掉了。
- `shell.css` 给整张账号卡（`.v2-account-entry`）加 `-webkit-app-region: no-drag`。#1508 把 Electron 43 升到 45 后，
  Chromium 152 起 `app-region` 会传给子元素：卡右下角铺满整张卡的 `.v2-account-mark` 和余额失败那一行排在按钮后面，
  跟着侧栏变成拖动区、盖回按钮上，鼠标点下去全成了拖窗口（Electron 45.1.0 真鼠标复现，43.8.3 不出现）。
  Playwright 的点击走 CDP、不经过系统的拖动区判断，所以原有用例照样能点进去；`app-check.mjs` 新加一条按拖动区叠加顺序
  核对「侧栏和顶栏里没有排在后面的拖动区盖住按钮」，CI 上的 Chromium 151 不传，也照 152 的规矩自己往上找。
- 开机不再整读加速内核（0.2.24 启动速度深查 S-3）：网络加速 2026-10-30 下线后，Windows、Mac 安装包每次开机仍把三十多兆的 `mihomo(.exe)` 和节点文件整读一遍算 SHA-256，只为 `recover()`。
  现在由 `bootstrap/acceleration.ts` 的 `createAccelerationHostLoader` 定什么时候读：开机只用 `hasAccelerationProxyRecoveryRecords`（数据目录下恢复记录和它的 `.lock` 两次 lstat）看上次崩溃有没有留下没改回的系统代理，有才马上读文件、建宿主、改回（日志 `acceleration.recover.pending`）；没有就等加速服务第一次真要用后端时再读（`createAccelerationService` 的 `ready` 可以给函数，换账号、停别的账号、退出这些用不着后端的操作不去调）。
  检查页「加速功能」那一行在加速下线后本来就不显示，现在也不为它去读文件（`readAccelerationBundleStatus`）。退出时建好了的宿主照旧放掉，没用到的不读。校验一项没减：真要读时照旧整读、核哈希，启动内核前复制件的复核也不变；`recover()` 和 `createAccelerationHost` 都留着。
- 0.2.24 深查改字 Z04（W9c W10 W11b W11c W12a W18 W44 W76 W77 W78 W91）：`AccountOverview.tsx`、`AccountRecharge.tsx`、`pages-account.tsx`、
  `LocalAvatar.tsx`、`AccountProfileDialog.tsx` 换字；W44 按 `affHistoryQuota` 区分「赚过、转完了」和「从没赚过」（后者写「还没有返利」）。
  W91 那句是主进程报的（`realm-account.ts` STALE、`account-work-gate.ts`、`active-identity.ts`、`account-billing.ts`、`bootstrap/ai-services.ts`），
  六处和渲染层 `account-read-error.ts` 认这句的地方一起换，测试里写死的字跟着改。用户行按协调者口径最后统一补一条合并的。
- P-1（`0.2.24-深查/作品和素材库.md`）：按编号找作品不再把每个日期文件夹 × 每种扩展名都试一遍、每试一次跑一遍
  同步的 `assertNoReparseComponents`。新增 `electron/ai-asset-locator.ts`（`OwnedAssetLocator`）：先问记下的位置
  （存入、找到过、作品库索引列出来的都会记下），没有再从最新的日期文件夹往回找，账号文件夹的联接检查每次查找只做一次，
  每个候选只用一次异步 `lstat` 排除。图片、视频、音频三家都用它；真正打开的那个文件照旧走全套 I8 检查
  （`readBounded*` 的联接、单链接、身份核对，视频/音频 `resolveOwnedFilePath` 的联接、单链接检查），一条校验没放宽。
- `ai-media-asset-service.ts`：只带编号的改名、收藏、标记用过、删除、恢复、彻底删除、另存，先问作品库索引记下的那一家，
  不再每次先让图片那家整个找一遍；提示过期就照旧按图片 → 视频 → 音频挨家问。
- 记下的位置文件不在了（外面删了）就丢掉重找；读的时候文件刚好没了，报原有的「AI 图片/视频/音频资产不存在或无权访问」，
  不再把带路径的 ENOENT 原样往外抛（D-1 的缓存那一半；提示改字那一半没动）。视频、音频的「在文件夹中显示」不再按日期文件夹
  逐个同步 `existsSync`。
- 实测（Linux ext4，120 个日期文件夹、2,400 个作品，图/视频/音频混合，每项前换新实例模拟重启）：作品库首页 1,122 → 192 ms，
  第 11 页 899 → 158 ms，打开带 20 张近期图片的对话 616 → 15 ms，标记一段老视频用过 49 → 26 ms，批量删进回收站 50 个
  1,378 → 152 ms，再彻底删除 50 个 1,854 → 153 ms；同步 `lstat` 从 3.5 万~6 万次降到 1,600~2,000 次。作品库首页剩下的
  约 140 ms 是每次重建三份全量索引（G-2），不在这条里。
- 修深查 M-1：`ai-asset-metadata-store.ts` 不再把一个账号的全部元数据塞进一个 2 MB / 5,000 条封顶的 `asset-metadata.json`，改为 `user-<id>/asset-metadata/shard-0..f.json` 16 个分片（按作品编号 FNV-1a 分桶，紧凑 JSON，每片 16 MB，不设条数上限），每次写只重写一个分片。加新信息的写入在每片留出 1/16 的余量给软删除、恢复、彻底删除，满了也删得掉。
- 一次性迁移：每次操作前在账号队列里检查老文件，读到且解析通过就按记录合并进分片（新的赢，平局分片赢），全部写成功后把老文件原样改名为 `asset-metadata.json.migrated-<时间>-<uuid>.bak`；暂时读不了（被锁、多链接）就原样不动、下次再试；解析不了照旧改名 `.corrupt-*.bak`；分片写不进去时老文件不动，读取照样带上它的记录。全程不删任何文件。
- `ai-output-location.ts` 搬作品目录时认出 `asset-metadata/` 分片目录，逐片经正在用的 store 合并（不整目录改名，免得和正在写的分片撞上），`mergeLegacy` 同时接受老单文件和分片两种格式。R28-5（分片读失败一律当损坏）未在本 PR 改，影响范围从全部记录缩小到 1/16。
- `xingmang-asset://video/…` 的 Range 请求只读要的那一段（0.2.24 深查 P-3：200 MB 的视频拖 8 次读了 1.6 GB）：`AiVideoAssetStore.readOwnedRange` 和整读共用一套核对（`withVerifiedVideo`：打开后 fstat、lstat、realpath 同一个单链接普通文件、大小上限，读完再核没变），先读开头 16 字节核 MP4 签名，再按偏移读那一段；`CanvasProjectAssetManager.readOwnedVideoRange` 照 `readOwned` 先全局后项目地找。一次最多回 8 MB（`maximumVideoRangeBytes`），播放器拖进度条发的「从这里到结尾」回一截、读完再要下一截；HEAD 和 416 不读视频字节。图片和音频不变。不放宽任何校验，账号核对照旧在最后一次 await 之后。`ai-asset-protocol.test.ts`、`ai-video-asset-store.test.ts`、`canvas-project-asset-manager.test.ts` 钉住。
- `scripts/audit-development-dependencies.cjs` 给 picomatch 的 GHSA-fc5q-39xc-vjpf（ReDoS，高危）开了一条窄例外，
  到北京时间 2026-12-15 当天结束（yoyo 11-18 打字同意）。公告范围 `<=4.0.7` 覆盖 picomatch 发过的每一版，上游修复
  micromatch/picomatch#194 还没合，vite / vitest / tinyglobby 最新版仍要 `^4`，没有能升或能换的版本；
  它只经 vite、vitest、tinyglobby、fdir、node-gyp 进开发依赖，`audit:production` 0 条，
  自家 vite / vitest 配置里也没有触发它要的 extglob 规则。
- 同时收紧放行判断：每个受影响包的严重程度不能超过它实际连到的那条公告，不再用整张例外表里最高的上限，
  免得 picomatch 的「高危」上限顺带放宽只连到 minimatch（中危）的那条链。
- 历史账号的邀请返利不是整数美元就转不进余额（`0.2.24-深查/查余额和扣费显示.md` 余额 F4），不改字、不加通道：
  历史账号 1 个单位 = 1 美元，返利按比例算出来常带小数，后台又只收和可转返利一分不差的全额；以前界面把金额
  `Math.round` 成整数、主进程入参只收正整数，$3.50 被说「不能超过可用返利」，$3.456 被后台拒「只能一次性全部转入」。
- `pages-account.tsx` 邀请返利：历史账号的金额框改成只读、显示的就是这次要转的全额，发出去的是 `profile.affQuota` 原值；
  换算挪进 `account-center.ts` 的 `affiliateTransferQuota`。星芒账号照旧可以只转一部分、按整数额度发。
- `account:transfer-affiliate-quota` 的入参 `parseAccountAffiliateTransferInput` 多一个 `sub2Api`（照密钥额度那条的写法，
  由 `getActiveSiteId() === 'solov-api'` 决定）：历史账号放开到「有限正数」，仍拒 NaN、Infinity、0、负数和非数字；星芒账号
  照旧只收正整数（`new-api-client.ts` 发请求前也还是只认整数）。这是放宽一处入参校验，yoyo 2026-11-13 亲手打字同意。
  `sub2api-relay-backend.ts` 没动。
- 余额审查 F5：个人中心「用量账单 › 调用明细」的「花费」列，不是消费的行（充值、管理、系统、退款、登录和认不出的类型）
  一律写「—」，跟没扣费的错误行同一个写法；以前充值、管理这些写「$0.00」，退款行把退回的额度写成一笔金额，看着像又扣了一次。
  判断收进 `usage.ts` 新加的 `usageCostShown`（消费行、扣了钱的错误行才写金额），`AccountUsage.tsx` 那一格改调它。
  「总花费」等统计来自只算消费的接口，没受影响；调用详情弹窗没动。没加新字，所以不写「## 用户」。
- 余额审查 F7（`0.2.24-深查/查余额和扣费显示.md`）：最后一次调用把余额扣成负数时，余额那格以前写「$-0.03」，
  负号夹在中间，首页提示同时说「当前账号余额是 $0」，数跟字对不上。现在 `business-common.tsx` 的 `dollars()`
  把负号写在 $ 前面（「-$0.03」），首页、侧栏、状态栏、个人中心都走它；手机遥控「状态」那一行的 `remoteDollars()`
  （`codex-remote-text.ts`）跟着改成同一种写法。四舍五入后是 0 的负数照 $0.00 写，不出「-$0.00」。
- 首页那条钱的提示（`Home.tsx` 的 `lowBalanceText`）在欠费时改成「当前账号已欠费 $0.03，充值后才能继续用」
  （金额按实际），yoyo 2026-11-13 回「改」批的字；欠的不到半分钱时余额那格是 $0.00，这句照旧说「余额是 $0」。
  余额正好是 0 的那句没动，新手引导里跟它同一句原话的 `walletEmptyLead` 也没动。不到半分钱显示 $0.00 的另一半（N-12）没碰。
  更新说明「用户」一节已满 60 条，所以只写「开发」。
- 余额审查 F8-1（`0.2.24-深查/查余额和扣费显示.md`）：星芒账号的邀请返利可以只转一部分，但「转入余额」确认框标题
  以前总写全部可转的数（可转 $10、填了 $3，标题还是「把 $10.00 返利转入余额？」）。现在标题写这次要转的数
  （「把 $3.00 返利转入余额？」），句式没变，yoyo 2026-11-13 回「改」。换算放在 `account-center.ts` 的
  `affiliateTransferTitleQuota`，取整跟发给后台的 `affiliateTransferQuota` 同一种，标题、发出去的额度、转完的提示是同一个数；
  框里还不是正数（清空、填 0）时照旧写全部可转的数。历史账号只能全转，标题照旧是全额。
- 动手前对过两边后台源码：new-api（rc.24、rc.40、rc.45、rc.51 与 main）`POST /api/user/aff_transfer` 收整数 `quota`，
  按这个数原样从 `aff_quota` 扣、加进 `quota`，不够就拒，部分转入是真的；上游自己的转入框也是 `Math.round(美元 × quota_per_unit)`。
  Sub2API（270eac6 与 main）`POST /api/v1/user/aff/transfer` 不收金额，每次把可转返利（`DECIMAL(20,8)`，按美元记）一次全转。
  更新说明「用户」一节已满 60 条，所以只写「开发」。
- 打开工具时（首页、托盘、快捷键、记录、引导）工具自己读不了配置文件、星芒也读不出连接，不再说「请先确认账号连接，
  再打开工具。」、不再弹配置窗口（在里面只更新会被拒、密钥也读不准，怎么点都修不好），改弹错误框「配置文件坏了」，
  主按钮「修好它」走首页卡片那颗（`repairBrokenToolConfig`），修好了替客户接着打开。错误框靠
  `broken-config-launch.ts` 那三句原话认出这一类，`operation-error.ts` 加 `repairConfig` 动作；打开工具的
  `perform` 现在带上工具，「修好它」才知道修哪个。配置窗口顶上加一行红字和「修好它」（首页现成的字）。
  2026-11-18 客户中文用户名被读成乱码、Codex 读不了 config.toml，0.2.23 打开只说「确认账号连接」。
- 存储桶里转发的 Grok CLI（Windows）和 OpenCode 桌面端（Mac）补上许可文件（决定单 D98「桶照旧」，许可合规 LC-6）：
  `sync-grok-cos` 把 Apache-2.0 原文和 xAI 随包发的 `THIRD_PARTY_NOTICES.md`、`sync-opencode-cos` 把 MIT 原文，
  传到各自前缀的 `licenses/sha256-<摘要>/` 下（不可覆盖、完整回读），写进 `latest.json` 顶层新加的 `license`。
  许可文字原样放在 `scripts/cos-licenses/`，测试按 SHA-256 钉住；上传和清单校验在 `scripts/cos-license-files.cjs`。
  OpenCode 版本没变时只补传许可、不重下包。客户端不读这个字段（0.2.22 起两个解析都只认自己知道的键），装法不变。
- Windows 查「命令行工具开没开」（`electron/cli-process-probe.ts`）分清「查过了，没开」和「没查成」（深查 CLI运行解析 C-1）：
  探测脚本改在 `$ErrorActionPreference = 'Stop'` 下跑，列进程（`Get-CimInstance Win32_Process -ErrorAction Stop`）和逐个比对包在 `try` 里，
  走完才输出 `{"ok":true,"items":[…]}`，出错输出 `{"ok":false,"error":…}`。`parseWindowsCliProcessProbeOutput` 改回整个
  `CliProcessProbe`：只有 `ok:true` 且每一行都读得懂才算 `checked`；没输出、读不懂、旧格式、`ok:false`、有一行没有可用 pid 一律
  `unavailable`。以前 WMI 被关、坏了或没权限时 `Get-CimInstance` 只写错误不抛，在 `SilentlyContinue` 下回空列表、退出码 0，
  被当成「没开」，开机那轮补设置、按账号刷新 Codex 型号名单、换下架型号会在工具开着时照写；现在落到 `running-tools.ts` 的
  `unknown`，这几件事照「看不出来就先不写」推迟到下一轮。界面上的字不变。`e2e/windows-powershell-probes-smoke.mjs` 补一条：
  完整语言和受限语言两种模式下，替身 `Get-CimInstance` 写错误时回 `unavailable`，空目录照旧回 `checked`。
- C-2（Mac 半，33 张旧卡核对）：Mac 上查 Codex 桌面端开没开那一步（osascript）报错或回了看不懂的话，以前折成「没开」，保存配置前看工具开没开的那一道就照常放行，Codex 开着时去改它的配置，两边会互相覆盖。`macos-codex-app.ts` 删掉吞错的 `isCodexRunning`，检测改用同文件的 `probeMacosCodexRunning`，`MacosCodexAppInfo.running` 变成 `boolean | null`；`DesktopAppStatus` 加可选的 `runningUnknown`（`buildCodexDesktopDarwinStatus` 只在查不出时填，`running` 照旧是 false，首页和诊断的读法不变），`system-scan-service.ts` 的 `codexDesktopRunning` 见到它回 null，按「看不出来」处理、这次不改 Codex 的配置。界面上的字没改；Windows 那半（`codex-desktop-service.ts` 进程段出错折成空）交 Claude·win，不在这个改动里。
- 深查 C-5（CLI运行解析）：Mac / Linux 上命令超时、取消或输出超限时，`command-runner.ts` 原来只给直接起的那个进程发 SIGTERM、500 毫秒后 SIGKILL，它拉起来的孙进程（`claude mcp list` 起的 MCP 服务、`claude plugin marketplace add` 背后的 `git clone`、npm 的子进程）被 1 号进程收养后一直在后台跑。现在非 Windows 上 `runCommand` 起进程时带 `detached: true`（自成一个会话和进程组），`stop()` 用 `process.kill(-pid)` 给整组发信号，宽限期满再给整组 SIGKILL；这个 SIGKILL 的定时器不随命令结算一起清掉，所以直接子进程先退了、孙进程不理 SIGTERM 的也收得掉。整组发不出去（组已经没了、或一个都没权限）时退回原来只杀直接子进程。Windows 照旧走 `taskkill /T /F`，起进程的参数也不变。
- 自成一组以后命令不再跟星芒同组，星芒退出时还没跑完的命令由 `process.once('exit')` 挂的 `stopLiveCommandGroupsAtExit` 整组发一次 SIGTERM（只发给还没结算的那些，不碰已经正常跑完的命令留下的后台进程）。开发时在终端按 Ctrl+C，信号也不再直接传到正在跑的命令，要等星芒自己退出时这一步收掉。
- 测试替身：`CommandRunnerDependencies` 加可选的 `signalProcessGroup`。换了 `spawnProcess` 又没给它时照旧只杀直接子进程、不带 `detached`，假进程的 pid 不会变成发给真进程组的信号。`command-runner.test.ts` 新增真起孙进程的三条（取消、孙进程不理 SIGTERM、退出时收掉；在改之前的代码上都红）和替身的四条（整组先 TERM 后 KILL、整组发不出去退回、替身不发真信号、Windows 不变）。
- 画布项目中心的只读素材库（Fable 第二轮 Q4「看全部作品」的画布那半，yoyo 2026-11-10 亲手回「素材库放开」，范围是没开项目时读聊天出的图和传的图，只读）：画布内核同步到 xingmang-canvas `kernel-v0.1.10`（xingmang-canvas #45）。内核在地址带 `?view=assets` 或宿主推 `canvas-host:show-account-assets` 时在项目中心弹出素材库，只列图片，能搜索、翻页、预览、另存，不改名、不收藏、不回收；开着项目时只在横幅上提示先回项目中心。
- `canvas-window.ts`：没开项目时（配了项目、这个窗口没有打开的项目）只放开 `canvas-host:list-assets` 和 `canvas-host:save-asset` 两件，读聊天那个共享库（`options.mediaAssets`）。列出必须是 `mediaType: 'image'`，`view` 只能不带或 `all`，不收 `runId`、`nodeId`、`prompt`，不带运行血缘；另存先 `readOwnedDetail` 核对是图片、没进回收站。别的素材通道照旧拒「请先选择或新建一个画布项目」。共享库里还有 0.2.24 以前没有自己文件夹的老项目出的图，跟聊天的图分不开，一起列出（打开那些老项目时本来就看得到）。
- 新推送通道 `canvas-host:show-account-assets`（不带东西，`canvas-contract.ts` 与 `canvas-preload.ts` 的 `onShowAccountAssets`）；控制器加 `openAssetLibrary()`：画布没开就带 `view=assets` 打开，开着就提到前面再推一下。主窗口新通道 `canvas:open-asset-library`（不带参数，等账号，`ipc-contract.ts` / `preload.ts` / `ipc-channel-policy.ts` / `ipc/handlers/window.ts`），renderer-v2 的 `api.openCanvasAssets()`；按钮和用户行由「看全部作品」那个 PR 加。
- 画布完善第 2b 条第 1 步（桌面那半）：画布宿主桥加一条只读通道 `canvas-host:get-account-summary`，不收任何参数，`capabilities().features.accountSummary` 改成开。回答只有五个字段：`siteLabel`（星芒账号 / 历史账号）、`accountLabel`（打码的账号名：留前一两个字和最后一个字，中间一律三颗星；历史账号拿邮箱顶用户名时只留 @ 前第一个字，域名也不给）、`balanceUsd`（`quota / quotaPerUnit`，跟主窗口一样）、`subscriptionLabel`、`readAt`；没登录回 `null`。邮箱、用户编号、密钥都不给。
- 余额用托盘和余额提醒同一份（主窗口、主进程本来就在读的那份），新记一个读到的时间；画布问的时候这份超过 15 秒才替它读一次站点，一次只读一次，画布问得再勤也最多 15 秒读一次，读失败也照样回上次读到的；读回来时换了账号就不记。不为画布另起定时器（`canvas-account-summary.ts`）。
- 画布上的余额条随 kernel-v0.1.7 同步进来，「用户」那条和内核那半的说明见 `canvas-kernel-v0.1.7.md`。
- 画布完善第 14 条（#1368 第 14 条）。`CanvasProjectStore`：数量上限只数没归档的（100 个），连同归档的另有 500 个总上限（`list` 读到 500 个为止，新建、另存、复制、导入四处共用 `assertRoomForNewProject`）；从归档恢复时没归档的已经 100 个就拒。新增 `remove`：只删已归档项目的记录，不碰文件夹。
- 画布宿主桥加一条通道 `canvas-host:delete-project`（只收项目标识）。主进程先查项目是不是本账号的、是不是已归档，再弹系统确认框（`删除「项目名」？`，按钮「删除」「取消」，默认「取消」），客户点了「删除」才删记录。项目文件夹只有「星芒画布」下面直接那一层、是普通文件夹（不是链接）才用 `shell.trashItem` 移到回收站（`canvasProjectFolderToTrash`），移不动只记一条日志、项目照样删；别的位置的文件夹一律不动。画布给不了路径，也绕不过确认框，见 PR 里的 I15 说明。
- 项目文件夹在弹框以后、移到回收站之前再看一遍，期间换成了链接就不动。
- 内核那半（「已归档」卡片上的删除按钮）随 kernel-v0.1.6 同步进来，见 `canvas-kernel-v0.1.6.md`。
- 画布不再有打开外部网页的宿主通道（X55，0.2.24 深查 外部链接 L1）：删掉 `canvas-host:open-external`
  （`canvas-contract.ts`、`canvas-preload.ts`、`canvas-window.ts` 三处），`main.ts` 的
  `canvasExternalUrlAllowlist` 清空。原来那两条是旧 infinite-canvas 内核的第三方地址，0.2.23 换成
  xingmang-canvas 内核后没有任何地方再打开它们，也没有调用这条通道；留着只会让画布被投毒时还能借它们
  打开别人的域名（I15「能力只减不增」）。弹窗和页面跳转照旧一律拒绝，只有画布那张表上全等匹配的地址才
  交给系统浏览器，表现在是空的。新门禁 `scripts/verify-canvas-external-links.test.cjs`：表只许写字符串
  字面量，每一条都必须能在 `canvas-v2/src`、`canvas-v2/shared` 里原样找到，画布窗口拿到的必须是这张表。
- 画布完善第 7 条第二步（#1397）主进程那半：视频抽帧节点照网页版「页面抽、服务端核对」的分工，主进程就是那个服务端。开关 `features.frameExtract` 还关着，客户看不到；等内核那半进了新标签、同步过来再打开。
- 新模块 `canvas-run-preparations.ts`：抽帧执行器先核对视频是当前账号自己的、不超过 32 MB（只读文件头），再推 `run-waiting`（带 `framePreparations`，跟内核现成的事件同形）请画布抽那一帧，节点显示「处理中」。`CanvasRunPreparationBroker` 只收自己发出去、还在等的「运行 + 编号」，同一个账号、一次；交回的图只收 PNG（按文件头认），20 MB、边长 4096、1677 万像素以内，存进当前项目素材库、来源记「导入」。两分钟没交回来、点停止、页面说抽不出来，节点失败，不硬等。
- 新通道 `canvas-host:complete-run-preparation`：画布只交运行编号、操作编号和 PNG 字节，不交路径、名字、类型；失败只交编号，不带页面的字。主进程另核对是这个画布窗口、这个账号起的运行。
- preload 加 `readVideoForFramePreview`：按 `xingmang-asset://video/<编号>` 读自己账号的视频（预览、播放本来就这么读），不加通道，最多 32 MB。
- 运行引擎：`frame-extract` 节点没有自己的执行器时直接拒，不再退到生视频执行器；运行记录多了可选的 `framePreparations`（运行结束、开机发现上次中断时都清掉，读盘时核对格式）；抽帧时间进节点指纹和工作流版本，没有这个字段的节点指纹不变。
- 画布完善第 7 条第二步（#1397）收尾：画布内核同步到 xingmang-canvas `kernel-v0.1.9`（4b82a00，xingmang-canvas #46），契约版本、工程格式版本不变。内核的 `runtime/host-run-preparations.ts` 在宿主同时有 `completeRunPreparation` 和 `readVideoForFramePreview` 时替宿主抽帧（收 `run-waiting` 的 `framePreparations`，读视频、解帧，PNG 交回 `canvas-host:complete-run-preparation`；读不出、解不出交不带字的失败；宿主不再列、运行结束、换项目时停下不交）。
- 打开 `features.frameExtract`，`executableNodeKinds` 加 `frame-extract`（`canvas-contract.ts` 与 `canvas-preload.ts` 两份一起改）。解析器的默认值跟着开关走，抽帧节点不再被拒；别的节点带抽帧时间照旧拒。内核按 `getAssetDetail` + `readVideoForFramePreview` + `frame-extract` 可用放出视频选帧；分镜拼图要 `image-collage`，桌面没有，照旧藏着。
- 用户行跟 `canvas-get-asset-detail.md` 那条并成一条，那份只留「开发」。
- 画布完善第 7 条第二步（#1397）的前置：新通道 `canvas-host:get-asset-detail`，内核的 `getAssetDetail` 有了桌面实现。主进程按 `canvas-host:list-assets` 同一套读法读一条素材（同一个素材库：开着项目读项目自己的；带运行来源 `lineage`；回收站里的也读出来、带 `deletedAt`，由内核自己拒），读完再核对账号没换。只读、不写，不交路径。
- `ai-media-asset-service.ts` 加 `readOwnedDetail`：先按种类提示只翻那一个仓库的索引，找不到再按图片、视频、音频依次找；读不出来的跟列表一样当不存在。
- 内核里靠它的入口跟着放出来：素材库的批量「加入画布」（`hostEntryPoints.batchAdd`）、蒙版另存后的再次核对、画廊候选素材补读。抽帧节点的「成品放到画布」和视频选帧也要它，随抽帧开关一起生效（用户行并进了 `canvas-frame-extract-on.md`）。
- 画布窗口卡死也弹「界面没有响应」（决定单第六节 X54，崩溃恢复.md KR-2）：`canvas-window.ts` 给画布窗口接上 `unresponsive` / `responsive`，复用主窗口那套 `createWindowResponsivenessGuard`（一窗一个框、恢复了或窗口关了自动收框）。字是主窗口那几句换主语，照决定单逐字：标题「界面没有响应」、正文「无限画布暂时没有响应。」、说明「可以再等一会儿，画布通常会自己恢复。重新加载只会重启画布，正在进行的安装、下载和已保存的设置都不受影响，但画布上还没保存的改动会丢失。」、按钮「继续等待／重新加载」。用户行并进了 `canvas-quit-saves-first.md` 那一条。
- 选「重新加载」先 `forcefullyCrashRenderer()` 结束卡住的进程（Electron 文档给 `unresponsive` 的办法，只换地址的话新页面还得卡住的进程来接），等 `render-process-gone` 来了再按当前深浅色重建入口地址加载，回到画布首页。这一次记 `canvas/process.ended-for-reload`，不记成 `process.gone` 崩溃，也不占自动重载「一分钟两次」的次数。进程跟别的页面共用、或已经没了时不结束进程，只换地址重新加载；判断放在 `window-responsiveness.ts` 新加的 `rendererProcessIsOwn()`（跟 `main.ts` 的 `releaseRendererProcess` 同一套判法）。主窗口那边的同一问题（KR-3）这次不动。
- 不加通道、不碰 `canvas-v2/`；正在等关闭确认的，进程结束时照旧按取消算。
- 画布完善第 5 条（桌面那半）：主进程能跑蒙版局部修改了。画布运行图里改图节点（`image-edit`）带的 `imageEditMask` 原来一律标成「桌面版暂不支持」，现在按内核同一套上限解析（`canvas-image-mask.ts`：最长边 4096、最多 128 笔、4096 个点、64 KB，未知字段一律拒），只许出现在改图节点上，原样交给执行器。
- 执行器发之前再核一遍：型号只许 `gpt-image-1` / `gpt-image-2` / `gpt-image-2-2026-04-21`（跟内核 `imageEditMaskModelSupported` 一样），原图只能一张、必须是蒙版绑定的那张，尺寸对得上，至少有一笔画笔。`ai-image-service.ts` 的改图请求读出原图字节后按实际像素再比一次尺寸，然后把笔画按内核同一套几何画成 8 位 RGBA PNG（涂过的地方全透明，其余不透明，一行一行压，4096×4096 也不整张放内存），作为 `mask` 字段随 `/v1/images/edits` 发出；做成的蒙版图到 4 MB 就不发。这些检查都在发请求之前，过不了不扣钱。
- 节点指纹和运行图版本把蒙版算进去；没有蒙版的节点指纹和以前一字不差（测试钉了 main 4049a622 算出来的值），老缓存照用。`canvas-image-mask.test.ts` 拿同步进来的内核 `image-edit-mask.ts` 对拍：65 组蒙版画出来的像素逐位相同，同一批坏输入两边报一样的字。
- 不加通道：蒙版跟着已有的 `canvas-host:start-run` 走。`desktopCanvasCapabilities.features.imageEditMask` 随 kernel-v0.1.8 同步打开，「用户」那条和内核那半的说明见 `canvas-kernel-v0.1.8.md`。
- 画布完善第 7 条第三步（#1397）第 3 个 PR：桌面接上宫格裁剪（`image-grid-split`），一个节点出「行 × 列」张图。主进程照旧不解读参数，只从里面读行数、列数（各 1 到 4）核对交回的张数，不核尺寸；执行器要求恰好一张来源图。每张切片记第几格（`CanvasRunCandidate.outputIndex`），整组存进缓存（`CanvasRunCacheEntry.candidates`，第一项就是原来的 `candidate`，老版本只读它；有一张切片没了整条缓存作废）。
- 往下传照网页版：单根连线传节点上选中的那一格（`imageOutputIndex`，解析器核 0 到 15、超出格数退回第 0 格；不进节点指纹，只进工作流版本，换一格不重新切），有采用的先用采用的；`out:images` 批量口按格子顺序传全部切片，批量连线的指纹带上整组切片。其余节点（候选画廊、路由）的取图顺序不变。
- `canvasRunKernelOnlyNodeLabels` 现在是空的；契约样例和运行服务测试里「桌面不支持」那条改用生视频的「生成音频」设置。`executableNodeKinds` 加 `image-grid-split`，Windows 冒烟的桌面节点库清单加「宫格裁剪」。
- 画布完善第 7 条第三步（#1397）主进程那半：图片工具节点（裁剪图片、拼图、平铺图片、图层合成、图片对比、全景预览）照网页版「页面处理、服务端核对」的分工，主进程就是那个服务端。开关 `features.imageTools` 还关着，客户看不到；等内核那半进了新标签、同步过来再打开。宫格裁剪（一个节点出多张）另开 PR。
- 新模块 `canvas-image-tools.ts`：裁剪、拼图、平铺、图层四种节点的图片处理参数原样收下、不解读，只量大小（256 KB、40 层深、共用整张图的预算、不许出现像密钥的键），读出核对结果用的张数、输出宽高和有没有图层编组；拼图顺序（`imageCollageInputOrder`）、平铺选图（`tileInput`）照内核的写法解析，`imageOutputIndex` 在这几种只出一张的节点上照网页版不往下传。开关关着时这些节点和字段照旧按名字拒。
- 执行器：四种处理节点先核对来源（裁剪、平铺恰好一张，最多 20 张，单张 20 MB、合计 64 MB，都要是这个账号这个项目的图片），再推 `run-waiting`（带 `imagePreparations`，跟内核和网页版同形）请画布做图；对比、全景把连进来的图原样作为结果。引擎里图片工具没有自己的执行器时直接拒，不会退到生视频执行器。
- `canvas-run-preparations.ts`：同一个 `canvas-host:complete-run-preparation` 多认 `kind: 'image'`，画布只交编号和 1 到 16 张 PNG 字节；`CanvasRunPreparationBroker.expectImages` 只收自己发出去、还在等的编号，一次，张数、长宽对上参数（自动尺寸的拼图除外），单张 20 MB、边长 4096，合计 64 MB、3355 万像素，按顺序存进当前项目素材库、来源记「导入」。两分钟没交回来、点停止、页面说做不出来，节点失败。
- preload 加 `readImageForRunPreparation`：按 `xingmang-asset://image/<编号>` 读自己账号的图片（画布显示图片本来就这么读），不加通道，最多 20 MB；`completeRunPreparation` 多认图片那种交法。
- 运行记录：参数可能有几百 KB，运行文件（整个只有 8 MB）里不存 `imagePreparations`，等待事件存盘时也去掉；运行服务在内存里记着正在等的那几份，`listRuns` / `getRun` 只给同一个账号还在跑的运行补上，读盘读到的一律丢掉。
- 图片处理参数、拼图顺序、平铺选图和处理器版本进节点指纹和工作流版本，没有这些字段的节点指纹不变。
- 画布完善第 7 条第三步（#1397）的六种图片工具打开：画布内核同步到 xingmang-canvas `kernel-v0.1.11`（b6c7977，xingmang-canvas #47），契约版本、工程格式版本不变。内核的 `runtime/host-run-preparations.ts` 在宿主有 `completeRunPreparation` 和 `readImageForRunPreparation` 时替宿主处理图片（收 `run-waiting` 的 `imagePreparations`，先按网页服务端的规矩核对，再按顺序读来源图、用 `library/browser-image-transform.ts` 处理，张数尺寸再核一遍，PNG 交回 `canvas-host:complete-run-preparation`；哪一步不成交不带字的失败；用了账号 LUT 调色表的图层，桌面没有 `readColorLut`，交失败）。
- 打开 `features.imageTools`，`executableNodeKinds` 加 `image-crop`、`image-collage`、`image-tile`、`image-layer`、`image-compare`、`image-panorama`（`canvas-contract.ts` 与 `canvas-preload.ts` 两份一起改）。解析器的默认值跟着开关走。内核随 `image-collage` 可用放出视频节点的「分镜」（挑几格画面，建抽帧节点和有序拼图）。
- 用户行并进 `canvas-frame-extract-on.md` 那条（这一版用户行已满 60 条，不再加新行）。Windows 冒烟的桌面节点库清单加这六种。
- 画布导入项目包改成导入成新项目（画布完善第 16 条，#1368 第 10 条）：`canvas-host:preview-project` 在配了项目存储和默认项目文件夹时多回一个 `createsProject: true`，
  `canvas-host:import-project` 这时不再把素材放进当前项目、把内容交回画布替换，而是照第 3 条的办法在「文档 › 星芒画布」下新建一个文件夹
  （`claimCanvasDefaultProjectFolder`，名字取包里的工作流名、没有就取文件名，控制字符换成空格），素材先放进这个文件夹
  （`CanvasProjectAssetManager.forNewWorkspace`），最后才登记项目（`CanvasProjectStore.createImported`，跟 `create` 一样查数量上限和文件夹不能跟别的项目共用，
  内容跟 `save` 走同一个校验），回给画布 `projectId`。中途出错或换了账号：删掉已放进去的素材，再从里往外删空文件夹（`releaseCanvasDefaultProjectFolderTree`，
  不跟链接、不删文件）。主进程这里不换当前项目，画布拿到 `projectId` 以后自己走「打开项目」，打不开时原来那个项目照旧能保存。
- 不加通道，画布照旧给不了路径：文件夹位置由主进程定，包文件由客户在系统对话框里选。没配默认项目文件夹时照旧换掉当前画布。
- 内核 kernel-v0.1.4（#1627 已同步）已经认 `createsProject`：导入框标题和按钮写「导入成新项目」，说明写新项目叫什么、放在哪、现在打开的项目不动，导入以后自己打开新项目，横幅写「已导入成新项目「…」，原来的项目还在项目中心」。
- 画布内核同步到 xingmang-canvas `kernel-v0.1.4`（0d1d659，xingmang-canvas #28～#38，画布完善清单第 9、11、10、18、1、15、3、12、19 条和第 16 条的内核那半，外加模板弹窗重画后跳回列表的修复），契约版本、工程格式版本不变。各条的新字逐字写在 xingmang-canvas 对应 PR 里。模板弹窗那条就是 Windows 打包作业里画布冒烟「填写并插入」时红时绿（detached）的原因：`TemplateCatalog` 打开时重置的 effect 依赖了 `App.tsx` 每次重画都新建的模板数组。
- 第 15 条桌面那半（#1103）：`canvas-window.ts` 不再把存着的皮肤（老版本默认雾青 mist）交给画布，打开地址不带 `skin`、换主题时也不发 `uiSkin`，画布按深浅色自己选（内核在桌面上不套网页的默认配色，用的是 `canvas-v2/vite.config.ts` 接回的主窗口配色）。窗口还没画出来时的底色改成主窗口的浅色 `#fbfaf6`，深色照旧 `#0b0c10`。
- `e2e/canvas-kernel-smoke.mjs` 建项目改点「换个位置创建…」：它要把每个项目放进指定的夹具文件夹，主按钮「创建」现在直接建进「文档 › 星芒画布」、不弹框。
- 画布内核同步到 xingmang-canvas `kernel-v0.1.6`（128d69c，xingmang-canvas #39、#40），契约版本、工程格式版本不变。`kernel-v0.1.5`（6e3ed07）只到 #39，没有单独同步。
  - #39（画布完善第 14 条内核那半）：宿主桥有 `deleteProject` 时，「已归档」卡片上多一个删除按钮，确认框由桌面弹；归档框和「已归档」空列表的说明后面加一句「已归档的不占项目名额，不要了可以在「已归档」里删掉。」。
  - #40（画布完善第 4 条内核那半）：一次出几张图的说明改成大白话，节点上写「一次出 N 张挑着用，每张单独扣一次费」，运行记录写「重新生成这 N 张」「这一组出了 X/N 张」；只出 1 张时节点上不摆这句。桌面放开 2～4 张在 `canvas-multiple-images.md` 那个 PR。
- 画布内核同步到 xingmang-canvas `kernel-v0.1.7`（dc41ed5，xingmang-canvas #41、#42、#43），契约版本、工程格式版本不变。三个 PR 是画布完善第 2b 条三步的内核那半：
  - #41：宿主桥有 `getAccountSummary` 时，编辑器顶栏显示哪个账号、打码的账号名、余额（桌面那半 #1702，`canvas-account-summary.md`）。
  - #42：运行前检查写「预计约 $x」，按宿主给的价目和分组倍率算；宿主没给价的型号写「价格未知」，视频标「（估算）」；历史账号宿主回 `null`，写「价格未知」（桌面那半 #1704，`canvas-price-snapshot.md`）。
  - #43：宿主推 `run-charge` 以后，运行面板写「实扣 $x」，检查器「消耗」写这个节点最近一次真跑的实扣，对不上写「待核对」；`mergeCanvasRunEvent` 遇到不认识的事件类型原样返回，不再当成运行结束（桌面那半 #1710，`canvas-run-charges.md`）。
- 画布内核同步到 xingmang-canvas `kernel-v0.1.8`（f9a4ed7，xingmang-canvas #44），契约版本、工程格式版本不变。#44：宿主没声明 `byteUpload` 时，蒙版编辑器不给「另存为关联图片节点 / 独立图片节点 / 保存至当前节点」和「图片保存方式」（新入口 `maskAssetSave`），说明只讲 AI 局部修改。桌面那条 `importAssetFile` 只收用户拖进来的磁盘文件，原来点了只会报「上传结果尚未确认」。
- 打开 `desktopCanvasCapabilities.features.imageEditMask`（`canvas-contract.ts` 和 `canvas-preload.ts` 两份一起改，`canvas-contract.test.ts` 钉住）。主进程那半是 #1714（`canvas-image-edit-mask.md`）：改图节点的蒙版按内核同一套上限解析，发之前核对型号和原图，画成透明 PNG 随 `/v1/images/edits` 发出。
- 画布目录自带的那份依赖清单和锁文件换成跟根目录同一套（D102，`安全.md` 新-2、`依赖.md` DEP-8）：
  原来 100 项里 88 项从国内镜像解析、React 还是 18，`npm audit` 报 4 条（vite 8.2.1、source-map-js 1.2.1、
  vitest 4.1.10）。现在 `canvas-v2/package.json` 的范围照根目录写（React 19.2.8，补上 `@types/node`），
  `canvas-v2/package-lock.json` 由新脚本 `scripts/trim-canvas-lockfile.cjs` 从根目录锁文件原样裁出 106 项，
  全部来自 npm 官方源、带 SHA-512，审计 0 条。画布照旧用根目录依赖构建，安装包不变。
- `docs/canvas-third-party.json` 和 `docs/CANVAS-THIRD-PARTY.md` 的 React 记成实际发出去的 19.2.8；
  `verify-canvas-provenance.test.cjs` 新增一条：画布清单的范围要跟根目录一样，锁文件要正好是从根目录裁出来的那几项，
  根目录升了画布用到的包就会红，照提示重新裁一次。
- 画布完善第 7 条第一步（#1397）：新通道 `canvas-host:import-asset-bytes`，画布在页面里画好的图片只交字节、不交路径。preload 的 `importAssetFile` 拿得到磁盘路径（用户拖进来的）照旧走 `import-asset-file`；拿不到路径的，只有 PNG / JPEG / WebP 才读出字节走新通道，名字和类型都不发。
- 主进程（`canvas-byte-upload.ts`）：只收一个 `Uint8Array`，最多 20 MB；按文件头认 PNG / JPEG / WebP，长宽都不超过 8192；每个画布窗口同时最多 2 张、每分钟最多 20 张合计 100 MB，存失败的也算。没打开项目就拒；存进当前项目自己的素材库（没文件夹的老项目进账号素材库），来源记「导入」。不回滚：素材按内容存，同样的字节返回的可能是用户原来就有的那份。
- 打开 `desktopCanvasCapabilities.features.byteUpload`（`canvas-contract.ts` 和 `canvas-preload.ts` 两份一起改），kernel-v0.1.8 的 `maskAssetSave` 跟着它把蒙版的另存按钮放出来，不用改内核、不用建标签。
- 画布一次出多张（画布完善第 4 条，#1396 多候选那一项）：解析器对 `image` / `image-generate` / `image-edit` 不再把 `imageCandidateCount` 2～4 当成桌面不支持，而是放进运行图（`CanvasRunGraphNode.data.imageCandidateCount`，1 不放，跟以前一样）；别的节点带这个字段照旧拒。`desktopCanvasCapabilities` 和画布 preload 的 `imageCandidates.maximum` 从 1 改成 4。
- 运行引擎（`canvas-run-engine.ts`）对多张节点走 `runImageBatch`：每张一次独立请求、各自的 attemptId（所以请求号也各不相同），上游 `n` 照旧是 1；同一次运行的几张共用一个 `imageBatch.batchId`、都记节点自己的指纹，跟内核 `runtime/image-candidate-batch.ts` 认的格式一样。几张并排跑，每张各占工作流并发的一个位子，生图服务那边照旧最多同时 2 个。一张失败不停别的、不重发；全出齐才算成功，出不齐节点失败，写「这次要出 N 张，出来 X 张，Y 张没出来：原因」（`canvasImageBatchFailureMessage`）；点停止后还没发出去的不再发。
- 缓存按张分开存（`canvasImageCandidateCacheKey`）：第 1 张就用节点指纹，所以以前单张的缓存照旧能用、从 1 张改成 3 张只补发 2 张；第 2～4 张各有自己的键。所以一组没出齐以后，整个工作流再运行时只补没出来的那几张；「运行到此」的目标节点（包括运行记录里的「重新生成」）整组重出。同一张图不会同时占两个位置。画布上选中的那张：在这一组里就交给下游；整组都有缓存但选中的是更早一组的，照单张节点的办法证明后单独复用（证明不了就停下、不扣费）；一张缓存都没有（比如复制出来的项目）但能证明的，也复用那一张、不记缓存，免得下次补发剩下几张。
- 单次运行的远程生成上限按张数算（`canvasRunRemoteGenerationUpperBound`，一个 4 张的节点算 4 次），上限还是 64，超了写「这次运行最多要生成 N 次，一次运行最多 64 次（一次出几张的按张数算），请分几次运行」。工作流版本号（`computeCanvasGraphRevision`）带上张数，1 张时不变。
- 内核里多张的说明字改大白话在 xingmang-canvas #40，随 kernel-v0.1.5 同步进来；同步以前节点上仍是内核 v0.1.4 的字。
- 画布完善第 2b 条第 2 步（桌面那半）：画布宿主桥加一条只读通道 `canvas-host:get-price-snapshot`，不收任何参数，`capabilities().features.quote` 改成开。回答是 `{ models: { 型号: { usd, approximate? } }, groupRatios: { 分组: 倍率 }, readAt }`：星芒账号读这个账号的 `GET /api/pricing`（`new-api-client.ts` 的 `getModelPricing`，响应上限 4 MiB、最多 2000 个型号），只留按次计价、桌面认得的型号，视频标 `approximate`（站点可能按时长、尺寸再乘）；按 token、按表达式或插件计价的不给。历史账号没有按型号的价目，回 `null`，画布写「价格未知」。
- 读的节奏在 `canvas-price-snapshot.ts`：十分钟内只读一次、同时问只读一次，读失败一分钟内不再读（画布问得再勤也不打站点），读失败时照旧回上次读到的，读回来换了账号就不要。扣费照旧由主进程和站点算，这个数不拿去扣费。
- 画布上的「预计约 $x」随 kernel-v0.1.7 同步进来，「用户」那条和内核那半的说明见 `canvas-kernel-v0.1.7.md`。
- 资源占用深查 R-1：画布每来一条进度，主进程就把整份运行记录（最大 8 MB）读、解析、查一遍、整份重写。现在 `CanvasRunStore` 把解析好的状态留在内存里（每次操作只做一次异步 `lstat` 核对文件没被别人改过，改过就以文件为准重读；任何一次操作失败都丢掉内存里的那份，下次从文件重读，跟原来每次重读的保证一样；一分钟没用就放掉），`saveRun` 新增 `{ deferWrite: true }`：只改内存，跟下一次正常保存一起写，最迟 2 秒写盘。写盘时不再整份深拷贝。
- `executeCanvasRun` 新增 `persistProgress`：只有 `node-stage`（阶段和百分比）和开头的 `queued` 走它；付费请求发出前的 `running`、出结果、失败、取消和整次结束仍走 `persistRecord`，写完盘才往下走，崩溃恢复的语义不变。写盘前那遍「有没有密钥、远程地址和本地路径」的整份检查照旧，延后写的那条在保存时先单独查一遍，查不过当场拒。
- 沙箱模拟（7.9 MB 运行记录、4 个视频并行、各报 15 次进度）：主进程累计被卡 14.4 秒 → 0.9 秒，单次最长 222 → 67 毫秒，整次运行 17.7 秒 → 4.1 秒（理想约 3 秒）；单次进度保存 168 → 0.2 毫秒，正常保存 162 → 80 毫秒。
- 画布宿主桥加两条通道，给 xingmang-canvas 新内核的「新建项目默认放进「文档 › 星芒画布」」用（画布完善第 3 条）：
  `canvas-host:create-project-in-default-folder` 只收项目名，主进程在 `app.getPath('documents')/星芒画布/` 下按名字新建一个空文件夹
  （去掉文件名里不许出现的字符，同名的已经在了就加「 (2)」，已经在的文件夹一律不用，`canvas-default-project-folder.ts`），
  不弹选文件夹的框；`canvas-host:relink-project-folder` 只收项目标识，只对工作文件夹已经找不到的项目弹系统对话框让客户重新选
  （`CanvasProjectStore.relinkWorkspace`，用素材的项目要选带 assets 的文件夹）。画布给不了路径，复制项目照旧先选空文件夹。
  客户看得到的变化随内核 kernel-v0.1.4 同步一起写在 `canvas-kernel-v0.1.4.md`。
- 画布项目文件关联到星芒，双击直接在画布里打开（D92，安装卸载.md 第 11 条）：`electron-builder.config.cjs` 按平台加 `fileAssociations`
  （Windows 的 ProgID `XingMangAI.CanvasProject`、说明「星芒画布项目」；Mac 的种类名「星芒画布项目」、`rank: Owner`；Linux 的
  `application/x-xingcanvas`，包里多一份 `/usr/share/mime/packages/xingmang-ai-manager.xml`，`verify-linux-deb.cjs` 放行并核对它和菜单文件的 MimeType）。
- 主进程收路径（`canvas-project-file-launch.ts`）：Windows、Linux 读启动参数和 `second-instance` 的 argv（Linux 的 `file:` 网址换成路径），
  Mac 接 `open-file`。只认绝对路径、扩展名 `.xingcanvas`，不认开关、相对路径和 `\\?\`、`\\.\` 设备路径；只留最近一个，十分钟没打开就作废，
  同一次双击两路都到只开一次。没登录先露出主窗口，登录好了接着开；打不开弹「没能打开画布项目」，原因进运行日志。重启和意外退出后的自动重开不再带这个文件，免得又导入一遍。
- `CanvasWindowController.openProjectFile`：先照拖放那套严查（绝对路径、`assertNoReparseComponents`、单链接普通文件，`readBoundedUtf8File` 再以 open + fstat 复核）、
  解析包，坏文件不碰开着的画布；画布开着就先走它自己的关闭确认（有任务在跑会问，用户取消就留在原项目、不导入），然后跟「导入工作流」同一个
  `importAsNewProject` 导入成新项目，画布带 `?project=<id>` 打开（内核开机读这个参数打开项目），崩溃重载不带它。一次只处理一个。
- 路径是系统交给主进程的，不经过画布页面，也不加 `canvas-host` 通道，不是 I15 说的「第二个由 renderer 提供绝对路径的通道」。
- Windows：模板 `registerFileAssociations` 写的打开命令程序路径不带引号（`C:\Program Files\…\星芒AI管理工具.exe "%1"`，装在 `D:\My Apps\` 这类位置时
  资源管理器会先试 `D:\My.exe`），`build/installer.nsh` 的 `customInstall` 每次安装（含升级）重写成 `"程序路径" "%1"`，并删掉模板那句英文
  「Open with 星芒AI管理工具」，右键显示系统自己的「打开」。`windows-installer-file-association.test.cjs` 钉住 ProgID 两边一致、模板先注册后
  `customInstall`；`windows-uninstall-smoke.yml` 新增 `windows-file-association-smoke.ps1` 真装、升级、卸载各一次核对注册表。
- 新加的界面字（报错框）：标题「没能打开画布项目」，正文「没能打开这个画布项目文件。」，按钮「知道了」；读不到文件时的说明「读不到这个文件，可能已经移走、删掉了，或者星芒没有权限读它。」；
  路径检查两句「画布项目文件路径无效」「画布项目文件不安全」（照拖放素材那两句）。其余原因沿用导入时的原话。
- Windows 画布项目文件换成自己的文档图标（深查 IC-10，2026-11-13 yoyo 看过预览回「改」）：`win.fileAssociations` 加
  `icon: 'canvas-project.ico'`。原来没配，electron-builder 让文件类型借用程序图标（`"$appExe,0"`），桌面上作品文件跟星芒的快捷方式一模一样。
  图标是白纸折角、右下角一颗 standard 母版的星芒，不加字，16–256px 十档逐档画（`scripts/generate-canvas-project-icon.mjs`，产物
  `build/canvas-project.ico`，只给安装程序用，不进 app.asar）。安装时拷到安装目录的 `resources` 下，`DefaultIcon` 指过去；卸载随
  `resources` 一起删。`customInstall` 本来每次安装都发 `SHChangeNotify(SHCNE_ASSOCCHANGED)`，升级后不用重启就换图标。
- `windows-installer-file-association.test.cjs` 钉住配置、ICO 的十档结构和「是白纸不是深蓝方块」，以及 electron-builder 仍读这个 `icon`；
  `windows-file-association-smoke.ps1` 在真装和升级后核对 `DefaultIcon` 和图标文件。
- Linux 没跟着改：electron-builder 26.15.3 写 MIME 包时把图标写死成 `x-office-document`（`LinuxTargetHelper.computeMimeTypeFiles`），
  不读 `fileAssociations[].icon`，Linux 上作品文件显示的是系统通用文档图标，不会跟星芒混。要换专用图标得改 deb 的图标和 MIME 包写法，
  跟 Linux 程序图标只有一档（Linux.md G1）一起做。Mac 系统自己给文件套白纸样式，不用改。
- 退出前先走画布自己的关窗流程（#1368 第 9 条）：`window-lifecycle.ts` 加可选的 `closeCanvas`，排在 `confirmQuit` 前面，主进程接到 `canvasController.requestCloseForQuit()`（见下一条）。画布那边是现成的关窗确认（内核 `persistence/canvas-close.ts`）：没在生成的直接存一次再关，在生成的弹它现有的确认框，不加新字、不加新通道。用户回了画布，这次退出作废，主窗口不拉出来；画布收尾出错照常退出。Windows 关机、Mac 关机时不等画布。缩到托盘不碰画布。
- `requestCloseForQuit()` 先用 `executeJavaScript('1')` 看画布页面还回不回话，4 秒没回（卡死但没崩，`render-process-gone` 不会来）就直接销毁画布、照常退出，日志记 `canvas/close.unresponsive`；回了话（包括回了个错）才走关窗确认，正弹着「还有进行中的任务」的框就一直等用户点。没有这一步的话，卡死的画布会让退出白等 60 秒再作废。
- 画布完善第 8 条（场景入口）第一步：打开 `features.referenceOrder`（`canvas-contract.ts` 与 `canvas-preload.ts` 两份一起改）。新模块 `electron/canvas-reference-order.ts` 照内核逐字解析生图、改图、文字生成节点的参考图角色（`imageReferenceOrder`）和视频节点的素材顺序（`videoReferenceOrder`），测试拿同步进来的内核对拍。运行开始时核对角色和连线对得上（对不上整单拒，一个付费请求都不发）；引擎按角色或保存的顺序排好再交给执行器，有角色时提示词前加每张图的角色说明，跟网页服务端一样。两样都进指纹和工作流版本，没设的节点指纹不变。不用改内核、不用建标签。
- 解析器只在用得上的节点上收这两样：别的节点带了照旧按名字拒。契约样例加三条（改图带角色、角色位置失联、视频带素材顺序）。网页版同一张图可以在视频里用两次，桌面视频照旧不收重复的图。
- 用户行并进 `canvas-frame-extract-on.md` 那条（这一版用户行已满 60 条）。
- 画布完善第 2b 条第 3 步（桌面那半）：画布跑完写「实扣」。生图、改图、生视频、剧本拆解每次真发到中转的请求，记下回答里的请求号（`X-Oneapi-Request-Id`，`relay-request-id.ts`）；发了没等到回答、回答没带号的也单独记下，进运行记录的 `attempt.relayBilling`。没真发出去的（排队时取消、发之前就失败）不记。
- 运行结束后由 `canvas-run-charges.ts` 攒成一批，过 6 秒按型号和时间窗查这个账号自己的消费明细（`GET /api/log/self`，`type=2`，新加的 `recordsOnly` 只拿明细不拿合计），按请求号对上，`quota / quota_per_unit` 换成美元写进 `attempt.charge` 和 `record.charge`，再推一条 `run-charge` 事件给画布（不进 `events`，老内核照旧解析）。还有没记上的，40 秒时再查最后一次；对不上的记 `unmatched`，画布写「待核对」，不拿预计冒充实扣。视频失败但站点记了扣费的也记「待核对」，视频的数标「约」（异步任务可能另起退款或补扣）。
- 一次检查最多读 12 页（每页 100 条、每个型号最多 3 页、最多 8 个型号），最多排 64 个运行；`quota_per_unit` 先用托盘那份余额带回来的，没有才读一次余额。换了账号不查也不写。只有星芒账号做，历史账号的运行不记实扣。
- 画布上的「实扣」随 kernel-v0.1.7 同步进来，「用户」那条和内核那半的说明见 `canvas-kernel-v0.1.7.md`。
- 画布完善第 8 条（场景入口）第二步：打开 `features.scenarioTemplates`（`canvas-contract.ts` 与 `canvas-preload.ts` 两份一起改），工具栏和「更多」里出现电商创作、室内渲染、室外创作、故事板四个入口。新模块 `electron/canvas-scene-tasks.ts` 照内核逐字解析四种任务、写提示词、核对角色和自动提示 / 自动剧情的文字节点，测试拿同步进来的内核对拍。不用改内核、不用建标签。
- 解析器只在生图、改图节点上收这四样，要 `referenceOrder` 也开着；别的节点带了按名字拒。运行开始和节点执行前各核对一次，对不上一个付费请求都不发。跟网页服务端一样，室外双图、故事板和替它们写提示词的文字节点付费前按字节比图；材质优化 B 桌面给不出原图乘倍率那个尺寸就付费前拒，返回的图尺寸不对节点失败。契约样例加四条。
- 用户行并进 `canvas-frame-extract-on.md` 那条（这一版用户行已满 60 条）。
- 画布完善第 6 条：主进程能跑文字生成节点（`text-generate`），打开 `desktopCanvasCapabilities.features.textGenerate`，`executableNodeKinds` 加上它（`canvas-contract.ts` 和 `canvas-preload.ts` 两份一起改）。内核不用改，桌面原来只是把这类节点标成「桌面版暂不支持」。
  - 做法跟 xingmang-canvas 网页版服务端一样：上游文字和节点自己的提示词按行拼成一条用户消息，不加系统提示，走聊天服务的 `completeOnce`（同一套超时、并发、实扣记账）；结果超过 32000 字不收（画布项目存文字结果的上限）。
  - 连了图片：型号只认内核确认过能看图的 6 个，最多 4 张、单张 4 MB、合计 8 MB，像素和边长也有上限（新文件 `canvas-text-image-input.ts`，跟内核对拍）。图在凭据认出账号以后、发请求之前从这个账号的项目素材库读（`CompleteAiChatOnceInput.readImages`），读不到或超限就不发、不扣钱。
  - 联网搜索（`textWebSearch`）仍然关着，节点开了联网搜索照旧在付费请求前拒。
- 0.2.24 的「## 用户」合起来已经 71 条，超过更新页一版 60 条的上限（`scripts/bundle-release-notes.cjs` 的 `MAX_ITEMS`），
  发版时 `npm run compile` 和发布前置检查会直接报错停下（0.2.24 深查复查第 1 条）。这次把同类的并掉，回到 48 条，给还开着的 PR 留余量：
  视频剪辑 13 条并成 4 条（每个镜头能调的、拼成片多的选项、草稿箱和教程、生成视频的几处修复），画布 14 条并成 8 条，
  聊天记录 4 条并成 2 条，自动更新 3 条并成 1 条，作品库、检查页、装工具下载、弹窗各 2 条并成 1 条。被并掉的分片只留「## 开发」，
  客户报过的两条（`001-` 开头）照旧排最前，意思一条没删。
- `official-switch-withdraws-bypass.md` 的「用户」那句补上老客户不变（复查第 3 条）：0.2.24 之前就接过星芒的配置没有 `filled` 记号，
  切回官方时那两项照旧不撤，原来那句「之后官方 Claude Code 跑命令前会照常问你」对他们不成立。
- `changelog:check` 开始数条数：`countUserItems` 把 `release-notes.md`「未发布」段里已有的和各分片的「## 用户」放在一起，
  用 `bundle-release-notes.cjs` 的 `splitReleaseNoteItems` 数（续行不多算，和发版构建同一个数法），超过 `MAX_ITEMS` 就报错，
  让加上第 61 条的那个 PR 当场并掉几条；通过时也打出现在是多少条。`changelog-collect.test.cjs` 钉住（正好放满能过、多一条报错且不动文件、续行和开发条目不算）。
- AI 对话和画布按名字规则认出站上新加的出图型号（`ai-chat-protocol.ts` 的 `resolveAiModelCapability`）。以前只认
  gpt-image、即梦、Grok 出图和写死的 `gemini-3.1-flash-image`，nano-banana、新版 Gemini 出图、豆包 seedream、Flux、通义 qwen-image
  这类被当成文字模型：图片分组里不列，硬拿来出图报「当前模型不支持图片生成」。用户更新说明已满 60 条，这条只记开发侧。
- Gemini 系（`nano-banana*`、`gemini-*-image*`，规则跟画图技能的 `GEMINI_IMAGE_MODEL_PATTERN` 同一条、测试钉住）照
  `gemini-3.1-flash-image` 的接法走 `/v1/chat/completions`，1K/2K/4K 和十种比例照旧；Gemini 2.x（含 `nano-banana` 原版）只开 1K，
  请求里不带 `image_size`。对话接口要出图，站上 new-api 的「支持出图的 Gemini 模型」表里得有它映射到的上游型号，默认就有
  2.5-flash-image、3-pro-image(-preview)、3.1-flash-image(-preview)（对 rc.44 源码核过）。
- 别家（`dall-e-*`、`imagen-*`、`qwen-image*`、`z-image*`、万相 `*-t2i`、`flux`、`seedream`，照 new-api 的 `ImageGenerationModels`
  再加 seedream）走 `/v1/images/generations`，新 provider `images-api`：只发 `model`、`prompt`、`n`，尺寸和画质交给服务按型号默认值定
  （界面上是「自动尺寸」，跟 Grok 一样），不支持改图。改图专用的（`qwen-image-edit*`、`wan2.6-image`、`*imageedit`）不认。
- 名字像视频的照旧藏起来，视频型号的认法没动（#1059）。对话模型菜单和图标把 `nano-banana*` 归到 Gemini。
- `chat-key-store.ts`：`chat-group-keys.dat` 用当前系统密钥解不开或读不懂时（`ChatKeyCacheCorruptError`），
  `read` 和几条删除路径当成空的，`upsert` 先确认当前系统加密能来回解开，再把旧文件改名成
  `.corrupt-<时间>` 留给客服（最多留三份）、写入新签的这把。做法照 `managed-cli-key-store.ts`；
  大小超限、链接、被占用这类读不到的错照旧报错，不挪文件。修 0.2.24 深查「数据和迁移」DM-1。
- 聊天页深查 C3 / 汇总决定单 D104，放宽脱敏，yoyo 11-09 亲手打字「脱敏放开」。`src/renderer-v2/features/chat/storage.ts` 的「名字 = 值」那条（`namedSecretValue`）以前不看值、一律换掉，现在交给 `redactNamedSecretValue` 判断：类型名、标识符和点连起来的一串、函数调用和取下标、`$变量` / `${{ … }}` / `%VAR%` / `<占位>`、中文文案、引号里的普通句子原样留；字母数字混着 5 位以上、带符号、十六进制、UUID、bcrypt、碎驼峰的随机字母串照旧换。引号里按词看，一个词像密钥就整段换。
- 反引号也当引号（`` Authorization: `Bearer ${token}` ``）；右引号后面紧跟的 `)`、`}` 算在值里，换掉时留着末尾的收尾符号，`OpenAI(api_key="…")` 存成 `OpenAI(api_key=[密钥未保存])`，存两次结果一样（以前引号后面跟着符号时第二次存会再吞一截）。
- `sk-`、`Bearer 长串`、网址里的 `?token=`、共用表那几类都没动。对拍 100 万条：没有名字关键词的文本新旧逐字一样；没有新增「存两次结果不同」。放开的边界：只有字母、不带数字的值 12 位以下不遮（`password: sunshine` 原样存），不带数字的随机字母串长的也偶尔认不出（16 位约 6%、20 位以上约 4%），带数字的 4 位以下不遮。
- 聊天记录存盘脱敏（`src/renderer-v2/features/chat/storage.ts` 的 `redactPersistentChatText`）原来只有
  自己抄的几条，比日志、诊断、崩溃报告共用的 `redactSecretShapes` 少了 `xai-`、`ghp_` / `github_pat_` /
  `glpat-`、`AIza`、JWT、云厂商 AccessKey ID、PEM 私钥和网址 userinfo（死代码重复 H2）。现在原有规则照原样
  跑完后再过一遍共用表；`redactSecretShapes` 加了可选的替换文字参数，日志侧默认仍是 `[REDACTED]`。
  聊天自己的 `sk-` 规则结尾不再用 `\b`，以 `-` 结尾的密钥不再漏尾巴。只收紧不放宽：新旧对拍 400 万条随机串，
  旧版遮掉的新版都遮掉。「名字 = 值」那条（聊天页 C3）没动。
- 0.2.24 深查聊天页 C2，修复批次 X10（D40 ＋ W24）。`storage.ts` 的 `parseHistorySnapshot` 分两层：索引本身（读不出、归属或版本不对、条目不成样或重复、草稿读不出、超过上限）坏了照旧整份不读、这一回不写；索引好的，某一段对话文件读不出（半截、版本或归属不对、消息不成样、跟索引对不上）只跳过那一段，记进 `SavedHistory.setAside`，文件不见了的只从索引拿掉、记日志。
- 下一次保存把 `setAside` 带给主进程（`AiChatHistoryWrite.setAside`，可选字段，不加通道）：`ai-chat-history-store.ts` 索引写好之后把这些文件改名挪进同目录的 `unreadable/`（`c-<key>.<时间>.json`，不覆盖旧的一份），不在 `keys` 里的其余文件照旧删。挪之前先查单链接普通文件、目录不经过链接（I8）；备份文件夹最多 64 个、总大小不超过记录上限，超了这次整个不保存、什么都不动。等着挪走的文件名不分给新对话。导入（搬到新电脑）也带上这份名单。
- W24：读不出来的原因（`ChatStorageError` 原文）经 `reportRendererError`（`context: chat-history`，warn，只进本机日志不上报）写日志；上屏一律 `以前的聊天记录暂时读不出来，原文件没动`，超过上限是 `聊天记录超过 50 个，这台电脑存不下，原来的记录没动`（数字跟 `MAX_CONVERSATIONS`）。只有几段读不出来时用 D40 那句，走普通提示条、可关掉，不挡保存。
- 设置页「搬到新电脑」导入前先看聊天在不在回复（0.2.24 深查聊天页 C4，汇总决定单 D41，批次 X13；产品负责人 2026-11-11 北京回「决定单照推荐」）。
  导入要先把聊天页卸下（`chat/transfer.ts`，R28-2），卸下就把藏在别的页面后面、还在回复或出图的那条掐断，出图那条可能照样扣了费，页面上什么也不说。
  现在 `ChatTransfer` 多一个 `assertChatIdle`：聊天页登记着 `'chat'` 这样后台工作（`background-work.ts`，跟退出、重启装更新问的是同一个标记）就抛「聊天正在回复，等它说完再导入。」。
  设置页点「导入」先问一次，在回复就连文件也不选、什么都不动，原话上页顶红条；`importConversations` 卸下聊天页前再问一次（前后隔着选文件、问要不要换掉设置）。
  对话不在回复时照旧。导入的对话一个都不新增时照旧卸下聊天页（C4 里那半没进 D41）。
- 更新页「## 用户」已经 60 条到顶，这条碰上的机会少，没写用户行。
- 深查 D6（聊天页 C9，选「放宽」）：渲染层 `chat/storage.ts` 的 `MAX_CONVERSATIONS` 和主进程 `ai-chat-history-store.ts` 的 `MAX_CHAT_HISTORY_CONVERSATIONS` 从 50 提到 200（两边有意重复，各自的测试钉着 200 可存、201 拒绝）。`useChatController.ts` 三处写死的 50 和那句「最多保存 N 个对话，请先删除不再需要的对话」改用 storage 导出的 `MAX_CONVERSATIONS` / `conversationLimitMessage`；设置页「导入」的两句（`features/app/data-transfer.ts`）和读存超上限时那句「聊天记录超过 N 个，这台电脑存不下，原来的记录没动」（W24）里的数字也跟着它走。字一个没加，只是数字变了。
- 对话目录的条目上限 `MAX_DIRECTORY_ENTRIES` 从 256 提到 1024：保存到一半崩了，删掉的对话文件要等下一次保存才清，新旧两批可能同时在，256 留给 200 个对话不够余量，超了整份记录读不出来。
- 不让数量涨四倍把电脑吃住：主进程每次保存要逐个核对没改动的对话文件，以前每个文件都把整条上级目录同步走一遍（Windows 上每个文件几十次同步 lstat），200 个时一次保存在 Linux 上就要 10.6 ms（50 个时 3.1 ms），出字时每 2 秒存一次。`safe-local-data.ts` 新增 `assertSafeDataFiles`：目录只走一遍，每个文件照旧单独查「单链接普通文件」和 realpath 一致（realpath 也会看到走完目录之后才被换成链接的上级），`assertSafeDataFile` 抽出同一份逐文件检查，行为不变。200 个时降到 2.6 ms，比原来 50 个还省。
- 聊天页左边对话列表的每一行改成 memo（`ChatPage.tsx` 的 `ConversationListItem`，回调走跟消息行一样的稳定对象）：出字时每 50 毫秒换一次列表，以前整排连同每行的菜单都重画。浏览器夹具（开发版 React）实测每段字的主线程耗时：199 个对话 32 ms → 14 ms，50 个对话 19 ms → 10 ms。内存：199 个对话（每个 6 条消息）比 5 个多约 5 MB。
- `docs/TEST-BASELINE.md` 和 `AGENTS.md`：需要建符号链接特权的用例从 11 条变成 12 条（`safe-local-data` 多一条）。
- 聊天回复途中断网，在那条下面说一句（0.2.24 深查聊天页 C14，汇总决定单 D43，批次 X14；产品负责人 2026-11-11 北京回「决定单照推荐」，字照决定单原文）。
  主进程 `ai-chat-service.ts` 要连着 3 分钟收不到一个字节才停（`idleTimeoutMs`，给长思考模型留的，Q43），这期间界面只转「正在生成」。
  现在 `chat/state.ts` 加 `offlineReplyNotice`「网络断了，这条回复可能接不上，可以先停止。」和 `shouldShowOfflineReplyNotice`：还在等字或出字的回复、且 `useOnlineStatus()` 说断网时，`ChatPage.tsx` 在那条下面挂一行（`chat-message-note`，`data-testid="chat-message-offline"`）。
  网回来就收起；不替用户停、不改 3 分钟时限、不加按钮（停止按钮本来就在输入框右边）。出图那条不挂：停下也可能照样计费，停之前另有一问。
- 用户行并进 `offline-unsent-ai-request.md` 那条「对话回复到一半网断了」的末尾（更新页「## 用户」已经 60 条到顶）。
- 聊天框粘贴在资源管理器、访达、文件管理器里「复制」的图片文件不再没反应（0.2.24 深查剪贴板拖放 J4；用户可见的那句并进
  `fable2-chat.md`）。原来 `ChatPage.tsx` 看见剪贴板里有图片文件就拦下交给主进程，主进程只认 `image/png` 位图，复制的
  文件只有路径没有位图，`chat:paste-image` 回 `null`，页面收到空的直接返回。现在 `clipboard-image.ts` 的
  `readClipboardFilePaths` 先读 Electron 列出的 `text/uri-list`（沙箱里 Electron 45.1.0 实测，Linux 文件管理器复制的文件就是这样
  列出来的），再按平台兜底读 Windows 的 `FileNameW`、Mac 的 `public.file-url`（这两种没在真机上演过）；读出的路径交给
  `ai-chat-attachments.ts` 跟选文件框同一段 `storeFiles`：同样的张数上限、`readLocalFile` 的有界读取和 reparse / 硬链接检查、
  20 MB 原图上限、`prepareChatImage` 认格式和缩图，一张不行整批不存。剪贴板里位图和文件都有时照旧用位图，以前能贴的
  一张都不变。`chat:paste-image` 改成带 `remaining`、回 `AiChatAsset[]`，跟 `chat:pick-images` 一样；不加新通道，
  路径仍只在主进程里从系统剪贴板读，渲染层给不出路径。Mac 访达复制文件推测会带文件名文字，按 J3 的规则当文字贴出，
  这次不动。
- 聊天框粘贴 Excel、WPS 表格这类「文字＋表格图片」一起的内容时照常贴字，不再整次拦下当截图（0.2.24 深查剪贴板拖放 J3）。原来 `ChatPage.tsx` 的 `onPaste` 一见剪贴板里有图片文件就 `preventDefault()`，文字被吞：模型看不了图时输入框空着还报「当前模型看不了图片」，看得了图时贴进去的是一张表格截图。现在判断挪到 `state.ts` 的 `shouldPasteScreenshot`：剪贴板里有不为空的文字就让浏览器照常粘贴，只有纯图片（截图）才交给主进程读图。沙箱里用 Electron 45.1.0 实测：文字＋图片贴出文字，纯截图、只有空白字符＋图片仍走截图。不加新字；正在回复时贴纯截图没反应（J3 第三点）和复制图片文件粘贴没反应（J4）不在这次。
- 聊天页出字时也存盘（0.2.24 深查聊天页 C1）。`useChatController.ts` 的自动保存原来是「停下 250 毫秒才存」，主进程每 50 毫秒推一段字，计时一直被重置，整段说完之前一次都不存；现在从头一处没存的改动算起最多等 2 秒（`storage.ts` 的 `autosaveDelay`）。
- 退出前先让聊天页交出手上的那一份：主进程 `prepareToQuit` 先经 `chat-history-flush.ts` 发 `chat-history:flush-requested`，界面（App 上的 `answerHistoryFlushRequests`，聊天页开没开都回）把开着的聊天页存一次、等写完，回 `chat-history:flushed`，主进程再等 `chatHistoryStore.idle()`。新加这一对主窗口通道，只带一个随机编号；界面这一页没报告过手上有没有事（重新加载中、托盘省内存关掉、崩了、旧回滚界面）就不问，问了不回等满 1.5 秒照样退，不拦退出。不加新字，退出前「正在回复，要不要退」那一问没做（要加字）。
- 聊天页改字（0.2.24 深查界面字单 W40、W41，产品负责人 2026-11-10 北京回「按照你的推荐做」）：空白页示例问题
  「用大白话解释什么是 API Key」改「用大白话解释什么是 API 密钥」（`ChatPage.tsx`）；参数设置「最大输出 Token」改
  「一次最多回多长」，填错时「最大输出 Token 要填整数，比如 4096」改「要填整数，比如 4096（不填就是不限）」
  （`chat/parameters.ts`）。只改字，行为不变；小改动不占更新页的条数，所以没写「## 用户」。
- 开机那轮也给 Claude Code 对一遍 `/model` 菜单（`config-save-service.ts` 的 `syncClaudeModelPicker`，走
  `tool-model-check.ts` 的 `syncPicker`，同 Codex 那条）。以前只在保存配置、从星芒点「打开」（隔一天一次）和
  老配置补备用型号那一次刷新，从终端或 VS Code 直接开 Claude Code 的客户，站上新上的型号一直进不了菜单。
  只碰本软件用当前账号写的配置；只改菜单那几处（`claudeRelayModelPickerUpdates`：菜单、没写过的「Default」、
  没写过也没被删过的备用型号），客户选的型号、自己写的菜单和备用型号不动；型号已下架的留给换型号那条。
  菜单已经是新的只多问一遍中转，不看工具开没开；要写之前 Claude Code 开着或看不出就跳过这一次、不记成欠着，
  写前先备份，失败只记日志。
- 同类对比 备选 6：设置里加一个默认关的开关，开着时星芒往 Claude Code 用户级 `settings.json` 写
  `attribution: { "commit": "", "pr": "" }`。2.1.319 也认 `false`，但它自己的说明讲旧版本见到 `true` / `false` 会报错，而 Claude Code
  遇到设置文件有错是整份不读（连星芒写的地址和密钥一起），所以写对象形式。云端沙箱（`env -i` 加假接口）看过：默认时发给模型的
  请求里有 `Co-Authored-By` 和 `Generated with` 那两段，写了这一项以后都没有了，设置照常读进去。
- 跟「只让 Claude Code 改项目文件夹里的文件」共用一套：`config-files.ts` 的开关项从一个扩成两个（`ClaudeToggle` /
  `ClaudeToggleDefault`，`applyClaudeWriteBoundary` 改成 `applyClaudeToggle`，merge 走 `alignClaudeToggles`，模板走 `writeClaudeToggle`），
  记进同一份快照的 `filled`；只认星芒原样写下的 `{ commit: '', pr: '' }`，客户写过任何 `attribution`、或者在星芒写的那份里改过字，
  都不撤。`config-save-service.ts` 两个开关共用 `setClaudeToggle`（记开关也在配置写锁里）。
- 新通道 `config:set-claude-commit-attribution`，开关存在 `AppSettings.claudeHidesCommitAttribution`，`settings:save` 不收这一项；
  `ClaudeWriteBoundaryResult` 改名 `ClaudeToggleResult`，两条通道共用。界面：设置项 `claude-commit-attribution`（工具管理，紧跟上一个开关），
  小提示 `claudeCommitAttributionNotice`。
- Claude Desktop 开机补型号（yoyo 2026-11-12 回「1 2 3 做」第 1 条）：型号菜单原来只在客户点「保存配置」那一刻写（#1494），
  账号后来上的 Claude 型号要客户回星芒再保存一次才进得去。现在开机安静期过、登录恢复完再等 30 秒，主进程在后台
  （`external-client-route-service.ts` 的 `topUpClaudeDesktopModels`，`main.ts` 起）只对星芒替当前账号写的、正在用的、
  在当前线路上的那一份，按今天保存会挑的那几个（`claudeDesktopTopUpCandidates`）把菜单里还没有的照 Claude Desktop
  开机检查各发一个字，试通了的放到默认那个后面（`claude-desktop-config.ts` 的 `addModels`），原来的一项不删、默认不动，
  最多攒到 12 个。Claude Desktop 开着（或看不出开没开）这次就不补；写之前再盘点一次，试型号那几秒里打开了也不写。
  0.2.12 那串写法（#685）留给开机修复，不补；没写清单、由它自己问网关要的不补。
- 哪些算新上的记在 `<数据目录>/external-clients/claude-desktop-models/<配置编号>.json`（`claude-desktop-model-topup.ts`）：
  每次补完记下这把 Key 当时列着的型号，Key 只存摘要；下次只试记录里没有的，客户自己从菜单拿掉的、菜单满了放不下的不会
  每次开机又补回来。试过没通的不记，下次开机再试；菜单没写成（Claude Desktop 打开了、换了账号）这次也不记。换了 Key 记录作废，
  照保存的挑法重新看一遍。保存配置那条路不动。
- 不加界面文字、不加 IPC 通道。日志：补进去或有没通的记 `external-client.claude-desktop.models.topped-up`（`added`、`rejected`、
  `overflow`），开着跳过记 `…top-up-skipped`，出错记 `…top-up-failed`。`editOwnedGateway` 算出来一个字不用改时不再写文件、不留备份。
- Claude Code 的 `/model` 菜单在当前账号列着的 Claude 型号超过 20 个时，改成先舍掉老的（`claude-model-picker.ts` 的
  `buildClaudeRelayModelPicker` 改用 `sortClaudeModelsNewestFirst`，和 Claude 桌面端菜单同一套排法）。以前照模型接口的名字
  次序截前 20 个，`claude-sonnet-*` 排在最后，新上的 Sonnet 5、5.5 反倒先被挤掉。当前选定的型号照旧永远在内，放进去的照旧按
  名字排，不改界面文字。按老截法写的菜单仍认作本软件写的，下次刷新菜单时换成新的。yoyo 2026-11-12 回「1 2 3 做」里的第 3 条。
- 新增主链路冒烟（0.2.24 深查·测试和CI CV-1）：`scripts/cli-config-smoke.cjs`，本地 `npm run smoke:cli-config`，CI 是 quality 工作流的
  `cli-config-smoke` 作业、进 quality-gate 必过项，每个改了代码的 PR 都跑。用主进程真正写配置的 `saveProviderConfig` 把客户那份配置写进临时主目录
  （参数照登录后自动写的那一笔），只把站点地址换成本机假中转（`scripts/cli-config-smoke-relay.cjs`，接 HTTP 和 Codex 的 WebSocket，
  WebSocket 照 new-api 只认 `response.create` / `response.cancel`），再用名单里钉住的 Claude Code、Codex、Grok 在干净环境里各真跑一句，
  断言请求带着写进去的密钥和型号到了假中转、回答打了出来。不要密钥，换完地址还留着线上地址就不跑，不对线上发请求。
- PR 上同时拿 base 上钉的版本跑一遍，推荐版本变了的工具把新旧两版发出去的请求（路径、请求头、beta 与功能标记、请求体字段、WebSocket 消息类型）
  列成差异表写进 job summary，只报不拦；每周巡检抬版本时用 `--compare-with origin/main` 代替手工对比（`docs/CLI-VERIFIED-VERSIONS.md`）。
- CI 的中转实测（`cli-relay-probe`）给 Claude Code 加一项「中转收不收结构化输出」：临时 HOME 里放一个提示钩子，
  看 CLI 调试日志里钩子请求是答了还是被 400 拒掉，结论单独写进 summary，不影响作业红绿。中转不收时客户的对话标题、
  记忆查找、提示钩子会静默失败，修法是 `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS`（`docs/CLI-VERIFIED-VERSIONS.md`）。
- `electron/cli-verified-versions.ts` 每周巡检（11-02 那次核过、没合，11-09 并成一次）：Claude Code 2.1.310 → 2.1.319（2.1.311～2.1.319 没有网关回归，2.1.314 补了网关按名字拒收 beta 头、拒收工具搜索 `tool_reference` 时的重发；2.1.314 引入、2.1.318 修好的 `--continue` 丢前文不进 `blocked`；沙箱假接口上问答、工具搜索被拒后的回退、`haiku` 别名、`/context` 1M、备用型号与 2.1.310 一致，新 `install.cjs` 在同一前缀全局升级正常）。Codex 0.164.0 → 0.167.0（release note 没有碰自定义 provider 的条目；随包型号名单换成 `rust-v0.167.0`，比上一份多一个 `gpt-6.1-terra`，其余逐字相同，`openai_models.rs` 只加可选字段；沙箱 `debug models`、`exec`、`--no-daemon exec` 与手机遥控用的 `app-server` 一轮对话都通过）。Grok 1.0.70 → 1.0.77（npm latest 且是 xAI stable，假接口上 K1/K3/K4/钩子与装插件的 `--trust` 重核通过）。依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- `scripts/probe-cli-relay.cjs`（中转实测）：关掉子进程的标准输入（Codex `exec` 原来一直等输入到超时）；超时单列成 `timeout`；Claude Code 改用 `--output-format stream-json --verbose`，被超时杀掉时也能按每次重试的 HTTP 状态归类，并把重试上限设成 2 次，让中转回的原话进得了结果。11-09 真跑：Codex 0.167.0 在 `solov` 上通过（`verifiedSites` 填 `['solov']`）。Claude 改用单独的仓库 secret `XINGMANG_CLI_PATROL_KEY_CLAUDE`（Claude 分组；没配就退回共用的 `XINGMANG_CLI_PATROL_KEY`），仓库级 secret 名单与 `docs/RELEASING.md` 一起登记。换了这把之后 Claude Code 2.1.319 也在 `solov` 上通过（`verifiedSites` 填 `['solov']`）。历史账号站 `solov-api` 巡检密钥认不了（401），按 11-09 的决定不再探测，summary 里写明「未在中转实测」。
- `electron/cli-verified-versions.ts` 每周巡检（11-16）：Claude Code 2.1.319 → 2.1.326（2.1.321～2.1.326 没有网关回归，2.1.323 让不走流式的请求也能从被拒的 beta 头里恢复，2.1.325 修了很多第三方网关上每轮都报上下文过长；沙箱假接口上问答、工具搜索被拒后的回退、`haiku` 别名、写全名的型号、`/context` 1M、备用型号与 2.1.319 逐项相同，`install.cjs` 不变）。Codex 0.167.0 → 0.169.0（0.167.1、0.167.2、0.168.0、0.169.0 没有改自定义 provider 读法的条目；`daemon_auto_start` 先删后恢复，写 `false` 照旧认；0.169.0 的 `codex exec` 在没信任的目录不读项目配置，本软件不跑 `exec`；随包型号名单换成 `rust-v0.169.0`，`models.json` 逐字相同，`openai_models.rs` 只加可选字段；沙箱 `debug models`、`exec`、`--no-daemon exec` 与手机遥控用的 `app-server` 一轮对话都与 0.167.0 一样）。11-17 `cli-relay-probe` 两家都在 `solov` 上真跑通过，`verifiedSites` 填 `['solov']`。用户那一条并进 `cli-verified-2026-11-09.md`（更新页 60 条已满）。依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- 随包 Codex 型号名单 `bundled-catalog/codex-models/models.json` 从 `rust-v0.169.0` 换到 `rust-v0.169.1`（与 `rust-v0.170.0` 逐字相同，只多 `gpt-6.2-sol`、`gpt-6.2-astra`，并更新已有型号的说明和提示词），推荐版本仍是 0.169.0。xm 站分组 11-18 上了这两个型号，旧名单下 Codex 命令行 `/model` 和桌面端菜单都选不到；在星芒配置窗口硬选上会因「默认型号不在名单里」收回整份名单，Codex 弹 `Model metadata for gpt-6.2-sol not found` 走通用资料；装了 0.170.0 的客户自带这两个，反被星芒的旧名单盖掉。两个新型号官方最低客户端版本 0.166.0，`openai_models.rs` 两个 tag 之间没改；沙箱里 0.159.0-alpha.12.1、0.169.0、0.170.0 都读得进新名单、`model/list` 列出两个 6.2，0.169.0 用 6.2 发的请求跟旧名单下的 6.1-sol 一样。
- `electron/codex-model-catalog.ts` 新增 `fitCodexModelCatalogToCli`：写名单前按本机命令行版本一个一个筛，官方最低版本高过命令行的型号只少写那一个，不再整份不写（`config-save-service.ts` 的 `resolveCodexModelCatalog`，少写时记 `codex-model-catalog.cli-too-old-for-models`）。否则换名单后，分组里有 6.2、命令行还在 0.166 以下的客户会连已经在用的型号一起丢了菜单。命令行低于 0.147.0、桌面端早于 26.917 照旧整份不写。
- 新 GPT 型号不用发版：`buildCodexRelayModelCatalog` 遇到随包名单里没有、又比同系列都新的 GPT 型号（`cli-model-defaults.ts` 的 `resolveOlderSiblingModel`），借同系列最新那一项的资料（`borrowCodexModelEntry`：只换 `slug`、显示名，清掉 `availability_nux` 和 `upgrade`），排在那一项前面，记 `codex-model-catalog.borrowed`。老型号、`-YYYY-MM-DD` 快照、认不出系列、生图这类不借，一次最多 6 个。沙箱里 0.159.0-alpha.12.1、0.169.0、0.170.0 读借来的 `gpt-6.3-sol` 都列进菜单、不报找不到资料。没走更新目录的状态文件下发型号资料：资料里带 Codex 的系统提示词，那份文件没签名。
- Codex 桌面端的首页合并查询和查包脚本在 PowerShell 受限语言模式（WDAC / AppLocker 等应用控制策略开着时，
  `-Command` 一律跑在这个模式里）下也能跑完。以前这两段最后都用 `[pscustomobject]@{...} | ConvertTo-Json`
  出结果，受限模式不许把哈希表转成对象，最后一句被拒，整条按退出码 1 退回、结果全丢，装着的 Codex 桌面端
  次次「检测失败」（2026-11-10 客户电脑）。现在改用哈希表出 JSON；开头设 UTF-8 输出那句只在 FullLanguage
  下执行，受限模式下 JSON 里 ASCII 以外的字符转成 `\uXXXX` 再输出（新叶子模块
  `electron/powershell-constrained-language.ts`）。Windows CI 上用 `__PSLockdownPolicy=4` 强制受限模式实测过，
  PowerShell 冒烟检查新增一条在受限模式下跑这两段脚本。Claude Desktop、OpenCode、WorkBuddy 的盘点脚本和安装脚本另开 PR。
- 查进程那段（`codexDesktopProcessQuery`，首页合并查询和关窗前那条共用）在受限模式下也认得出正在运行的
  Codex 桌面端。以前它用 `WindowsIdentity::GetCurrent()` 和 `Process::GetCurrentProcess()` 取自己的 SID 和会话，
  受限模式不许调这两个 .NET 方法，整段失败，首页永远不显示「正在运行」；关窗前那条查不到会话号，查询本身
  报错后照样按「一个也没有」退回。现在受限模式下改问 WMI 这个 PowerShell 进程自己的 `GetOwnerSid` 和
  `SessionId`（跟比对每个候选进程用的是同一个调用），拿不到 SID 就整段报错，不拿空值去比；FullLanguage
  照旧走原来那两句，输出跟以前一字不差（结果对象换成 `[ordered]@{}`，键的顺序不变）。Windows CI 上
  `__PSLockdownPolicy=4` 实测：跑着一个假的 Codex 窗口，改前报 `Method invocation is supported only on core types`，
  改后认出那个进程；冒烟检查新增一条，受限模式和 FullLanguage 下各跑一遍，要求查到的是同一条。
- `codex-desktop-install-failure.ts` 新增 `firewallOff`：Add-AppxPackage 的 0x80073CF6 里带 0x800706D9（注册 `windows.firewallRules` 扩展时防火墙服务 MpsSvc 没在跑）单独归一类，排在 `blocked` 前面；只认错误码，因为 PowerShell 按控制台宽度把扩展名折成两半（2026-11-06 客户日志是「windows.firewallRu\r\nles」）。这一类的失败句不带商店、官网两路的经过，也不说「原来那一版照常能用」。渲染层新卡 `codexDesktopFirewallOff`，只给「查看日志」「找客服」。
- 商店退出码 0x8a15002b（`codexDesktopStoreNoUpdateExitCode`，商店还没有比本机更新的版本）时，失败句开头从「微软商店这次没装上」改成「微软商店里还没有新版」；日志里那句原话不变。
- 存储桶的包交给 Windows 时就认出防火墙服务停着（`firewallOff`），`shouldContinueAfterCodexDesktopBucketInstall` 原样交出，不再接着走商店、官网：
  以前要多等商店一趟、再从 OpenAI 官网把同一个包下一遍，最后才出同一张卡（0.2.24 全面检查 P1）。商店那一路的退出码认不出防火墙
  （推测报的是通用的 0x80073CF6），桶没用上时照旧商店→官网，官网的包被拒以后本来就直接报错。
- `macos-desktop-app-installer.ts`：Mac 装、更新 Codex 桌面端时，存储桶清单过期（`DesktopBucketIndexStaleError`）不再整路丢掉桶。
  顺序改成「新鲜的桶 → 官方 → 过期的桶 → 报官方那一路的错」，照 #1571 在 Windows 上的做法：`unpackFromBucket` 只因过期没用上时返回 `'stale'`，
  官方那一路没走通（取消、盘写满了除外）再带 `allowStale` 回头走一次，不进下载线路。更新时桶里那版不比装着的新就不下；
  回头那一次后面没有别的路了，`probeAlternative` 一律给 null，下得慢也接着下，断得接不上才停。进度那句和官方那一路同一句话，界面上的字没改。
  首页「可更新到 v…」（`macos-desktop-app-update.ts`）读过期清单照旧当不知道，这次没动。起因：0.2.24 深查「装工具和更新」S-1。
- Codex 桌面端检测没查成时，原话不再上屏（11-18 客户截图「Windows Appx 探测返回数据格式无效」）。
  `codex-desktop.ts` 解析查包结果时，空输出、不是 JSON、条目都不合格这几种改写英文摘要
  `Codex desktop package probe: unrecognized result (…)`，原输出（最多 600 字）放进 `detail`；
  脚本写进 `error` 的只认写给客户的那一句（`codexDesktopPackageProbeAccountMessage`，脚本照同一份拼），
  别的说法也改成摘要。合并脚本里查包那段的 PowerShell 报错（`packageError`，中文系统上是中文）同样只进 `detail`。
  检测失败那行把 `detail` 接在摘要后面，`scan.completed`、`desktop.detection-failed` 两行日志照旧看得到原话；
  装、卸载抛的错把它挂成 `cause`。界面按新的零依赖模块 `codex-desktop-probe-failure.ts` 认摘要开头，
  不再看后面是不是中文：查包那段答了看不懂的结果（`unrecognized result`）时说「暂时没认出 Codex 桌面端，
  可能正在更新。等一两分钟点「重新检测」。」（yoyo 11-18 批），PowerShell 报错、超时照旧是「检测这个工具时出了错……」。
  改字类，只写「## 开发」（用户行已满 60，且 11-18 起要压短）。
- `desktop-package-bucket.ts`：清单过期单独抛 `DesktopBucketIndexStaleError`（仍是 `DesktopBucketUnavailableError` 的子类，
  Mac、Claude、OpenCode 的调用处不变）；`readDesktopBucketPackage` 加 `allowStale` 选项。
- `codex-desktop-service.ts`：Windows 装 Codex 桌面端的顺序改成「新鲜的桶 → 商店 → 官网 → 过期的桶（比本机新才装）→ 第三方国内镜像」。
  第一路只因清单过期没用上时记下 `bucketStale`，商店、官网都没装上再回头用它；进度那句和国内镜像那一路同一句话。
  回头那一次桶太慢时比的是国内镜像（`measureCodexDesktopMirrorSpeed`），不再比已经失败的官网；交给 Windows 被拒时直接报错、
  不再换国内镜像（同官网那一路），日志里写「存储桶里的离线安装包也没装上」。官网的包下好、核过却被 Windows 拒装时照旧直接报错。
  起因：11-04 起 OpenAI 清单跑在包前面（同步按 #1404 记 package-pending、不刷 checkedAt），桶清单过期一天多，
  客户端整路跳过了桶。
- Fable 手机遥控 YK-8：飞书审批卡处理过以后原地变样（yoyo 2026-11-11「同意卡改」，去掉「回 同意 N」那句一并批了），标题换成「已同意 / 已拒绝 / 没回，已自动拒绝（第 N 条）」
  （`codex-remote-text.ts` 的 `approvalOutcomeTitle`），按钮去掉，正文去掉「回 同意 N」那句（`formatApprovalBody`）。
  渠道接口多两个可选方法 `sendApproval` / `updateApproval`，只有飞书实现，跟 YF-15 的进度卡共用发卡取 `message_id`、
  `PATCH` 原地更新那一套（`postCard` / `patchCard`）；审批卡因此一开始就是 `update_multi: true`。每处拒绝都改样子：
  卡片或文字回的、电脑上「都拒绝」、发「停止」一起拒掉的、这一轮结束剩下的；到点没回的写自动拒绝（`settle` 带
  `expired`）。星芒在退、渠道关了或换了连接就不改；改不成只记 `remote.approval-card-update-failed`，手机上那句文字照样发。
  旧版本发的卡不是共享卡片，改不了，样子照旧。用户行并在 `codex-remote-fixes-0224.md`。
- Fable 手机遥控 YF-20：每条等你同意的除了 10 分钟到点自动拒绝那个定时器，另起一个在还剩 3 分钟时
  （`approvalReminderMs`）发 `approvalExpiringMessage`，只发一次；回过了、被拒了、渠道关了（`settle`）一起清掉。
  用户行并在 `codex-remote-fixes-0224.md`。
- YR-7：打开星芒时自动打开遥控没成功（干活的文件夹在开机时还没挂上的移动硬盘、网盘上，Codex 还没装好或正在更新……），
  以前只记 `remote.auto-started` 日志，卡片上的开关照旧是关的，人在外面发消息没人理也看不出为什么。现在
  `CodexRemoteService.startOnLaunch` 把 `enableReadyChannels` 给的原因（就是在设置里点开打不开时那句、托盘通知里的那句）
  记进快照的可选字段 `autoStartFailure`，卡片「打开星芒时自动打开遥控」那行说明下面一句黄字
  「上次打开星芒时没能自动打开：{原因}」；过 `autoStartRetryMs`（3 分钟）自己再试一次（日志 `remote.auto-start-retried`），
  只试这一次，还不行就换成这次的原因。任何一个渠道打开了（客户自己点的或重试成了）、关掉了自动打开、星芒退出，
  原因和那次重试一起撤掉。用户行并进 `codex-remote-fixes-0224.md` 那一条。
- Fable 手机遥控 YF-9：设置多存一个 `autoStart`（`codex-remote-store.ts`，只认 `true`，缺省 = 关），新通道
  `codex-remote:set-auto-start`（`setCodexRemoteAutoStart`，契约、preload、`ipc-channel-policy`、`handlers/codex-remote.ts`
  四处）只记下来、不当场开关渠道；快照带 `autoStart`。`main.ts` 开机调 `startOnLaunch`：开关开着才走托盘那条
  `enableReadyChannels`（只开配对过人的渠道，检查跟设置里的开关一样），打不开只记 `remote.auto-started` 日志。
  配对、只认那一个人、改东西要手机上同意都不变。卡片最后一行加开关；开着时「打开遥控」说明去掉「下次打开星芒要再打开一次」。
  用户行并在 `codex-remote-fixes-0224.md`。
- Fable 手机遥控「卡片」那批（YF-13）：快照多一项 `lastRequest`（`CodexRemoteLastRequestSnapshot`：几点发来、正在做 / 做完 /
  停下 / 没做完和手机上收到的那句原因），手机上发来的原话不进快照；遥控全关时清掉。卡片「干活的文件夹」上面多一行「最近一次」
  （`lastRequestText`、`pendingApprovalsText`）。加了两条主窗口通道 `codex-remote:stop-turn`（`stopTurnFromComputer`，
  跟手机上发「停止」一样）和 `codex-remote:decline-approvals`（`declineApprovalsFromComputer`，跟手机上点「拒绝」一样，
  这一轮不停），都不收参数。
- YF-12：遥控开着、余额不到 $1（`remoteLowBalanceDollars`）又没有能用的订阅时卡片提示区多一条黄条，「去充值」到个人中心充值；
  订阅能用、余额没读到都不提醒（`remoteLowBalanceAmount`）。
- YF-7：一个渠道登录过、另一个没凭据也没开着时，没登录的那块收成一行（`remoteChannelCollapsed`），点标题摊开。
- YF-3：飞书还差几步那块画一个飞书官方「打开机器人会话」AppLink 的二维码（`feishuBotChatLink`，App ID 不像 `cli_…`
  就不画），只是图，不是能点的外链，导航白名单不动。
- YF-6：首页 Codex CLI 卡片「…」多一项「手机遥控」（`remoteMenuLabel`），到设置里那张卡；Codex 桌面端不加。
  用户行并在 `codex-remote-fixes-0224.md`。
- 手机遥控深查 YR-1：手机上发「关闭遥控」（YF-17）时，`closeFromPhone` 先把设置里的 `autoStart`（YF-9「打开星芒时
  自动打开遥控」）一起删掉，再断开渠道。以前只断渠道，星芒一重开（夜里装系统更新重启、闲时装完新版、崩溃再开）
  `startOnLaunch` 就又自己连上，急停只管到下一次重开，手机上那句「要再用，请在电脑上的星芒里重新打开」也成了错话。
  先关开关再断渠道：两步之间退出了渠道本来也会断，反过来会留下一个下次自己连上的开关；写设置失败只记
  `remote.auto-start-unsaved`，渠道照样断。`remote.closed-from-phone` 日志多带 `autoStartCleared`。快照随之不带
  `autoStart`，卡片上的开关显示关着。闲着自动关（YF-10）只为省电，不跟着关开关。不加新字，用户行不变。
- Fable 手机遥控 YF-17：手机上整条发「关闭遥控」（`codex-remote-text.ts` 的 `plainCommands` 加 `close`，前面可以带 /）
  只认配对过的人、只认私聊，走 `closeFromPhone`：跟托盘「关掉手机遥控」一样开着的渠道全关，每个配对过的人收到
  `remoteMessages.closedFromPhone`；「帮助」第二行列上它。要再开只能回电脑上。用户行并在 `codex-remote-fixes-0224.md`。
- Fable 手机遥控 YK-5：手机上那条因为起不来 Codex 没做时（`handTurnToCodex` 里 `ensureCodex` 失败、这一轮还是这一轮），
  底座记 `codexStartFailed`，快照带 `codexStartFailed: true`；下次 Codex 起来了（`ensureCodex` 成功那里清掉并推一份）
  或者遥控全关了（`disableChannel` 关 Codex 那一步）就不带。起到一半电脑上关了遥控那种不算。卡片上在提示区摆一条黄条
  「Codex 没能启动」，带「去首页看 Codex」，设置页把 `navigate` 传给 `CodexRemoteCard`。用户行并在 `codex-remote-fixes-0224.md`。
- 手机遥控 W-6：飞书长连接接口（`/callback/ws/endpoint`）原来除了忙（1）和内部出错（1000040343），别的不认识的 code
  一律当 `auth-failed`，不是 JSON 的 401 / 403（公司网关拦截页）也一样，遥控整个停掉、卡片说「App ID 或 Secret 不对」。
  改成跟 YR-4 一样的白名单：只有飞书明说应用被拒的 514（auth_failed）、403（forbidden）才停，连接数超限照旧单独说；
  别的都按连不上处理，按原来的退避（2 秒起、最长 60 秒）再连，飞书恢复了遥控自己接上。回了话却没给连接地址时记
  `feishu.endpoint-retry`（只带 status 和 code）。`parseFeishuEndpointResponse` 去掉用不上的 `status` 参数。
  不加新字；用户行没有另起（60 条已满）。
- Fable 手机遥控 YF-4：「怎么建飞书机器人」六步下面两颗按钮。「打开飞书开放平台」交给浏览器的是 `feishuDeveloperConsoleUrl`
  （`codex-remote-channel.ts`，`https://open.feishu.cn/app`），主窗口外链白名单（`main.ts` 的 `nonSiteExternalUrlAllowlist`，
  I12 全等匹配）多收这一条，yoyo 2026-11-11 亲手打字「飞书网址加」；飞书别的页面、带路径或参数的照样拦下，`main.test.ts` 钉住。
  「看教程」跳 `phoneRemoteTutorialTopic`（`registry/business.ts`，教程那一章的 id 改读它），不是外链。用户行并在
  `codex-remote-fixes-0224.md`。
- Fable 手机遥控 YF-1：`FeishuRemoteSection.tsx` 填过凭据、还没配对时，「飞书应用」那行下面跟着 `feishuNextSteps`
  （标题、固定 4 步、一句小字，字照批过的原文）；配对成功后换成折起来的「怎么建飞书机器人」，点开是原来的
  `feishuSetupSteps` 六步（和没填凭据时的表单共用 `FeishuSetupGuide`）。原来一保存说明就跟着输入框收走，
  可「事件与回调」「发布版本」两步正要在保存、打开遥控以后才做。只改界面，主进程和快照不动。
- 手机遥控 YR-4：飞书换访问凭证（`tenant_access_token/internal`）原来只要 code 不是 0 就抛 `FeishuAuthError`，
  限流、飞书内部出错也会走 `failAuth` 把遥控整个停掉、卡片改成「App ID 或 Secret 不对」。改成白名单
  `tokenCredentialCodes`（照飞书通用错误码表：10003、10005、10014、10015、20002、50003），只有这几个才停；
  别的 code 和没有 code 的应答都抛 `FeishuTokenResponseError`（带上 status 和 code，`feishu.token-failed` 进日志），
  遥控照旧开着。`transientFeishuRequestFailure` 把换凭证时的 429、5xx 和 `tokenRetryCodes`（99991400、1500、10500）
  算成 `token-unavailable`，`post()` 按 `sendRetryDelaysMs` 等一会儿再换再发，补上 YKS-4 漏掉的这一处。保存凭据时
  碰到这些照旧只说 `feishuSaveFailedMessage`，日志多记 code。不加新字；用户行没有另起（60 条已满）。
- #1489 N8：`codex-remote-app-server.ts` 的 stdout、stderr 改用 `StringDecoder('utf8')` 按块解码，被管道切在两块之间的
  汉字留到下一块拼回去，不再逐块 `toString` 拆成两个替换符；进程退出时冲刷 stderr 那份，尾巴进日志不缺最后半个字。
  行长上限照旧按字节算。
- Fable 手机遥控 YF-19：电脑上能加几个干活的文件夹（最多 5 个），手机上发「文件夹」列出来、发「文件夹 2」切过去。
  设置多一个可选的 `workspaceDirectories`（`codex-remote-store.ts`，按加的先后、含正在用的那个；缺省 = 只有
  `workspaceDirectory` 那一个，老设置照读）。`codex-remote:choose-workspace` 改成「加进单子」，还没有正在用的才用它；
  新加两条主窗口业务通道 `codex-remote:use-workspace` / `codex-remote:remove-workspace`，入参只是界面上显示的那串字
  （`parseRemoteWorkspaceChoice` 限长），主进程只拿它跟加过的单子比，渲染层没法借它们让 Codex 去别的文件夹（I5）。
  加的时候照旧过 `validateRemoteWorkspace`（不许桌面、主目录这类大文件夹），切过去之前再查一次还在不在。这一轮还没做完
  （含等你同意）时两边都不换；换了从新对话开始，手机上切的那次不再补「前面的记不得了」。快照只在不止一个时带
  `workspaces`。用户行并在 `codex-remote-fixes-0224.md`。
- YKS-12：`RemoteChannelStatus` 多一个可选的 `halted`（`codex-remote-channel.ts`），表示 error 时渠道已经自己停下、
  不会再自己连；缺省 = 还在连或还在自己重试。飞书在别处连着（连接数超限）、读不到凭据（`codex-remote-feishu.ts`），
  以及渠道一连就抛（`codex-remote-service.ts` 的 `startChannel`）三处标上；微信长轮询出错退避重试那条不标。
  `codex-remote-keep-awake.ts` 不再把 halted 的渠道算作在听：YF-10 默认不自动关以后，原来飞书在别处连着时电脑会几天都不睡，
  托盘那行「暂不让电脑自动睡眠」也一直挂着；现在一停就放开，点「重新连接」以后回到 connecting 再挡上。状态栏「手机遥控中」、
  托盘「关掉手机遥控」和 Mac 闲时装照旧看开关（闲时装那条归 YR-3，等拍板）。
- Fable 手机遥控 YF-10：设置多存一个 `idleCloseHours`（`codex-remote-store.ts`，只认 `codex-remote-channel.ts` 的
  `remoteIdleCloseHours` 里的 4、12，缺省 = 不自动关，老客户升上来也是不自动关），新通道 `codex-remote:set-idle-close`
  （`setCodexRemoteIdleClose`，入参 `parseRemoteIdleClose` 只收 4 / 12 / null，契约、preload、`ipc-channel-policy`、
  `handlers/codex-remote.ts` 四处）；快照带 `idleCloseHours`。`codex-remote-service.ts` 去掉固定的 `idleTimeoutMs`，`touch`
  按设置的时长起算，不自动关时只撤计时；头一回连渠道前从盘上读一次，之后只有 `setIdleClose` 改它，改了开着的渠道当场按新时长
  重新起算。手机上自动关那句改成 `idleClosedMessage(hours)`。卡片最后一行加三选一；「打开遥控」说明里「闲着 N 小时也会自动断开」
  跟着时长走，不自动关时不说。用户行并在 `codex-remote-fixes-0224.md`。
- 手机遥控深查 YR-3（yoyo 2026-11-17「改」）：开了「打开星芒时自动打开遥控」的 Mac，遥控开着时也能闲时装更新。
  `CodexRemoteService.idleInstallHold()`（纯函数 `resolveRemoteIdleInstallHold`）分三种：开着又没开自动打开 =
  `'drops'`，照旧这次运行不闲时装（YK-2）；开了自动打开、这一轮在跑、有等你同意的、或者 30 分钟内
  （`remoteIdleInstallQuietMs`）绑定的人发过消息 = `'busy'`，先等；其余可以装，重开后 `startOnLaunch` 自己连回去。
  自动打开开没开留一份在内存（跟 `idleCloseHours` 同一种：连渠道前读盘，之后只有 `setAutoStart` 改）。
  `update-install-prompt.ts` 新增可选的 `remoteControlBusy`：只挡闲时装，不改「人不在就等人回来再跳框」那条，
  框里照旧说闲时会装；读完服务状态文件、真装之前再看一眼遥控，这几秒里手机来了消息就放回去等
  （`install.idle.remote-busy`）。`main.ts` 的「下好了」那句和跳框器改看 `idleInstallHold`，顺手改掉两处
  「重开以后不会自己连回去」的旧注释。不用新字。
- 修 Windows CI 上 `codex-remote-service.test.ts`「holds images until the next prompt…」偶发红（`expected false to be true`，
  第 1810 行「有 .png 也有 .jpg」那句）：用例只等到假渠道取过第二张图就去看目录，那时 `store.save` 的原子写还没换名，
  目录里是一张 png 加一个 `.….jpg.<uuid>.tmp`。`setup()` 新增 `imagesSaved(count)`，包一层真的图片存放处、等第 count 张存好；
  「关遥控删光图片」那条（`toHaveLength(1)` 会被临时文件凑上）和「新对话扔掉攒着的图」那条同样改成等存好。被测代码和断言没动。
- Fable 手机遥控 YF-14：手机上能发图片（yoyo 2026-11-11「图片改」，微信那半另有他亲手打的「微信图片网址加」）。
  渠道把图交成 `RemoteInboundImage`（只带取图句柄，底座不解读、不进日志），底座核过是绑定的那个人才调渠道的
  `fetchImage(ref, maxBytes)` 去取：陌生人发的图连下载都不下载。取回来的按开头字节认 PNG、JPEG、GIF、WebP，经
  `codex-remote-images.ts` 用随机文件名原子写进 `<userData>/codex-remote/images`（I8），攒着等下一句话，一起作为
  `{ type: 'localImage', path }` 放进 `turn/start`；最多 5 张、每张 10 MB。只有图时回一句「收到图片」，取不到、太大、
  飞书没开权限、攒满了各回一句。上一句带过的图留给「重试」，下一句交出去、关遥控、换人时删；「新对话」只扔攒着的；
  全关和退出时整个目录清掉，下次打开遥控先清一遍。
  飞书走「获取消息中的资源文件」（`GET /open-apis/im/v1/messages/:id/resources/:key?type=image`，只去 `open.feishu.cn`），
  要「获取单聊、群组消息」权限，建机器人第 3 步跟着加上；99991672 / 99991679 报没开权限，234037 报太大。微信照
  openclaw-weixin 从 `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=…` 取、AES-128-ECB 解开，
  `weixinCdnOrigin` 是遥控能连的地址里新加的唯一一条，消息里带来的 `full_url` 一律不用。微信取图是照两份开源接入推的，
  要真机核。`codex-remote-http.ts` 抽出 `requestRemoteBytes`，跟 `requestRemoteJson` 共用同一套四件（I10）。
  用户行并在 `codex-remote-fixes-0224.md`。
- Codex 复核 M03（#1905 核实为一般，即 YKS-4 当时没做的后半）：手机遥控一轮做完、最后那条回答发不出去时
  （`sendText` 吞掉错误，飞书、微信自己的重发也没成），以前这一轮照样记成做完，回答哪儿都不留，手机上发「状态」
  取不回，发「重试」让 Codex 从头再做一遍。现在 `sendText` 返回整段送没送到；做完的回答走 `sendAnswer`，没送到就在
  `ChannelRuntime.undeliveredAnswer` 留一份（只在内存，给原来那个人，最多 24 小时，关遥控、换人、解绑时扔），
  日志记 `remote.answer-undelivered`。两处补发：渠道状态从别的变回 connected 时（含「重新连接」），以及绑定的人
  发来任何一条时先补再处理（这时有一轮在做就不等补发发完，「停止」「同意」不往后排）。发的是「重试」而补的正是
  最后一句的回答，只补发、不再交给 Codex，补发后跟一句怎么真重做；之后又交过新的一句（`latest` 变 false）就照常重做
  新的那句。补发时先从 runtime 上摘下再发，正在补发时再叫一次等同一次（`answerResend`），连上了和手机来消息碰在
  一起只发一遍；还是没送到就放回去，成了记 `remote.answer-resent`。新加手机上两句 `answerResent`、
  `retryAfterAnswerResent`。没做完、被停下的那几句不留。
- Codex 复核 M05（#1905）：手机遥控图和字一起发、赶上还在做上一条（或设置一时读不到文件夹）被退回时，这条消息里
  刚攒上的图一起退回删掉，不再留在 `pendingImages` 里跟着下一句不相干的话交给 Codex。`receiveImages` 改为返回这条
  消息攒上的图，`runPrompt` 多收一个 `incoming`，两处退回都调 `returnIncomingImages`；早先单独发来、等着下一句的图
  照旧留着，先发图、下一句再说要做什么的用法不变。图片功能还没发过版，客户没碰到过，所以不写用户行。
- 手机遥控 Codex 卡在 Mac 上不再说「托盘」：「打开遥控」那行说明（`remoteSwitchHint` 多一个 `isMac`）和「不自动关」的小字
  （`codexRemoteIdleCloseText.neverHintMac`）改说「菜单栏」，平台由设置页那份 `isMac` 传进卡里；Windows、Linux 照旧（产品负责人 2026-11-11「菜单栏改」）。
- Fable 手机遥控 YF-11：`startChannel` 起的这一份连接第一次报 `connected` 时（`announceOpened`），给配对过的人发
  `remoteOpenedMessage`（带换成 ~ 的工作文件夹，跟「状态」那行同一种写法）；同一份连接断线重连不再发，没配对过的
  不发。微信要等第一次长轮询回来才算连上，这句会晚到最多一个长轮询。用户行并在 `codex-remote-fixes-0224.md`。
- Fable 手机遥控 YF-2：底座按渠道记「这次打开以后收到过什么」（`inboundSeen`：none / group / direct，只记有没有，
  `startChannel` 清零），配对码挂满 1 分钟（`pairingQuietMs`，`startPairing` 另起一个定时器推快照）还没收到私聊时，
  快照的 `pairing.quiet` 是 `nothing` 或 `group-only`；收到过私聊（哪怕不是配对码）就不带，配对码挂着时
  `inboundSeen` 变了另推一份。卡片上 `pairingAttemptText` 在错码那句之后按它说：一条都没收到用各渠道的
  `pairingQuietHint`（飞书说后台还差的两步，微信说去 ClawBot 对话里发），只收到群里的两个渠道同一句。
  手机那边照旧不回陌生人，配对规则不动。用户行并在 `codex-remote-fixes-0224.md`。
- 0.2.24 深查 D66（手机遥控.md YKS-3、8、9、10、16、18、19、21）：手机遥控收到的几句，字照决定单一字不差，下面逐条。
- 启动慢（YKS-3）：`runPrompt` 只在收件队列里登记这一轮、发「收到」，起 Codex、开对话、交给 Codex 挪到队列外的
  `startTurn`，所以起 Codex 排安装队列那几分钟里「状态」「停止」照常有人理，「停止」靠原有的 `turnStillWanted`
  拦住还没交出去的那句；超过 15 秒还没交给 Codex，先回一句在准备。交给 Codex 的几步按渠道另排一条队（`handoff`），
  前一轮在回执路上被「停止」时，后一轮等它补完打断再交。
- 四种报错（YKS-8）：`codex-remote-text.ts` 的 `classifyRemoteTurnFailure` 按 Codex 的 `codexErrorInfo`（对过
  rust-v0.167.0 的 v2 `CodexErrorInfo`）和 `unexpected status NNN: <正文>` 里中转的原话（`relay-quota-failure.ts`）
  认出余额不够、登录失效、对话太长、连不上线路（网关类状态码用 `network-failure.ts` 的 `isServiceUnavailableResponse`）。
  单子四句之外的「密钥上限用完」用软件里已有的那句；认不出的照旧发原话。原话脱敏截短后记在
  `remote.turn-failed` / `remote.turn-start-failed` 的 `reason` 里。
- 旧消息（YKS-9）：遥控开着时发的、到电脑时已超过 10 分钟的照旧不执行，绑定的人收到「这条是 N 分钟前发的…」，
  1 分钟内送来的一批只回一句；陌生人照旧不回。遥控打开以前发的不回（`sentWhileOpen`）：微信每次打开都从头拉，
  可能把上次开着时已经执行过的话再送一遍，说「没有执行」就错了。
- 改文件审批（YKS-10）：`readFileChange` 读 FileUpdateChange 的 kind 和 diff，每行写「新建 / 删除 / 改 / X 挪到 Y」，
  后面带「+N -M 行」（新建、删除数整份内容，改数统一 diff 里 @@ 之后的行）；老版本 Codex 不给 kind 时只列路径。
- 对话被重置（YKS-16）：关遥控、换文件夹、Codex 停了或出错丢掉对话时记一笔（`dropThread`），下次开新对话在「收到」
  前加一句；手机上发「新对话」、换了人不加。
- 解绑、换人、退出登录（YKS-18）：`tellUnbound` 在解绑前、新的人配对成功前、换凭据以前给原来那个人发一句，最多等 1.5 秒。
- 自动关（YKS-19）：闲 3 小时 50 分钟先提醒一次，回什么都重新起算，10 分钟后照旧关。
- 配对码（YKS-21）：快照加 `pairing.failures`、`pairingLocked` 两个可选字段，设置页手机遥控卡在配对那一行下面写
  「配对码错了 N 次」「这个码已经作废，请重新开始配对。」；手机那边照旧不回，计数规则不动。
- Fable 手机遥控 YF-15：长任务中途给进度，字是 yoyo 2026-11-11「进度改」批的那版（`codex-remote-text.ts` 的
  `progressCardTitles` / `progressStepMarks` / `progressStopButton` / `progressTextMessage` / `staleProgressCard`）。
  渠道接口多两个可选方法 `sendProgress` / `updateProgress`（`codex-remote-channel.ts`），只有飞书实现：Codex 报了计划
  （`turn/plan/updated`）或这一轮满 2 分钟发一张 `update_multi` 的消息卡片，之后用
  `PATCH /open-apis/im/v1/messages/:message_id` 原地更新（换步骤最快 30 秒一次，同一步每 5 分钟刷一次时间），做完、
  停了、没做完时改标题、去掉时间和按钮。更新用的是第 3 步已开的「以应用的身份发消息」权限，不用多开。消息编号拼进路径前
  先过 `om_` 正则。卡片上的「停止」带这一轮的随机串（`value.stop`），进来是新的 `RemoteInbound` 种类 `stop`，跟审批卡
  一样只认绑定的人、只认私聊；随机串对不上（上一轮留下的卡）不停这一轮。微信没有能更新的卡片，每满 5 分钟发一句，等同意时不发。
  进度的发送和更新都排在这一轮自己的一条链上（`TurnState.progress.chain`），最后那次「做完了」不会被晚到的更新盖掉；
  更新失败只记 `remote.progress-failed`，不影响回答。每处收尾改走 `settleTurn`（`settleLastRequest` + 收尾进度卡）。
  不加 IPC 通道，星芒电脑上的界面不变。用户行并在 `codex-remote-fixes-0224.md`。
- 0.2.24 深查手机遥控 YKS-6：微信重新扫码时服务端回 `binded_redirect`（认出是本机原来那份令牌）只回「这个微信已经连着这台电脑了」、
  什么都不存，`saveChannelCredential` 那条重启渠道的路不走，渠道停在 `needs-login` 不再拉消息。`codex-remote-weixin-login.ts`
  的扫码登录多一个依赖 `reconnectIfLoggedOut`，走到这个分支时调它；`CodexRemoteService.reconnectIfLoggedOut(channel)` 只在
  渠道开着、停在 `needs-login` 时 `stopAdapter` + `startChannel` 重连一次（日志 `remote.channel-relogin-reconnect`），连着的、
  关着的不动；这一下不让开时照换凭据那条不报错。重连没成也算登录成功，记 `weixin-login-reconnect-failed`。
- YR-2：手机遥控的已处理消息编号（`ChannelRuntime.seen`）不再在 `startChannel` 里清空，卡片上「重新连接」、
  重新扫码、关掉再开以后，平台再送一遍刚处理过的那条（微信每次连上都从空游标拉）不会再做一遍。跨重启那一半：
  绑定的人发来的消息先把编号记进遥控设置（`settings.json` 渠道下的 `recentMessageIds`，每个渠道最近 100 条），
  再处理；下次打开渠道时读回去，开了自动打开、重开星芒后开启前 1 分钟宽限里的重送也挡得住。记不下来照样处理，
  日志记 `remote.message-id-unsaved`。60 秒宽限照旧，断线时发的、还没做过的话重连后照常执行。
- 手机遥控设置一时读不出来不再把整份设置冲掉（Codex 复核 M09）：`codex-remote-store.ts` 把「还没有设置文件」
  和「文件在、这会儿读不出来」（比如 Windows 上杀毒软件占着）分开，后者不再缓存成空设置，下次读会重读；
  `updateSettings` 读不出来就不写，抛 `settingsUnreadableMessage`（原错误挂在 `cause` 上）。界面、收消息走的
  `readSettings` 读不出来时照旧先当没设过。内容坏了的文件照旧当没设过、能被下一次改动覆盖。用户行已满 60 条，只写这一段。
- Fable 手机遥控 YF-18（「状态重试」那批）：「状态」最多四行（`statusMessage`）。「现在」带上这一轮跑了多久（`TurnState.startedAt`）
  和 Codex 计划里正在做的那一步（`turn/plan/updated` 里第一条 `inProgress`，`currentPlanStep`），再加余额（`readBalanceUsd`，
  main.ts 接画布余额条那份读取器，最多等 3 秒）和「再过 N 小时没新消息就自动关」（选了不自动关就没有）。读不到的那一样整行不写。
- Fable 手机遥控 YF-22：新指令「重试」，把这次打开以后最后一句交给 Codex 的话（`ChannelRuntime.lastPrompt`，只在内存里，
  打开渠道、换人时清掉）再发一次，「收到」前面先说「再发一次上一条：「前 20 个字…」」；没有就回 `remoteMessages.nothingToRetry`。
  「帮助」第二行列上它。
- Fable 手机遥控 YF-16：做完（`completed`）的回答后面空一行接 `turnSummaryLine`：用时，和这一轮真改成了的文件（`fileChange`
  条目 `completed`，去重，只写文件名，最多列 3 个）。停下、没做完的不接。用户行并在 `codex-remote-fixes-0224.md`。
- M01（#1895 / #1905 核实）：手机上「停止」「新对话」、进度卡「停止」、电脑卡片「停下这一轮」改走新的 `stopTurn`，
  `turn/interrupt` 回了成功才把这一轮记成停了、收掉、作废编号。Codex 回了错或 10 秒没回时这一轮照旧挂在
  `runtime.turn` 上：手机收到「还没停下来……」（新对话那条是「上一条还没停下来，新对话没开……」），电脑上那一下
  报错，下一句仍回「还在处理上一条」，它后面的通知、审批、结束照常认，后来以「停了」收场才说「已停止。」。
  等回执这一会儿 Codex 新要的同意一律拒绝；电脑、手机同时点「停止」共用同一次打断，「已停止。」只说一次。
  关遥控、解绑、一小时卡死照旧走 `abandonTurn` 当场收掉。还没拿到这一轮编号时的「停止」照旧当场收掉、
  回执到了再补打断（M02 那一段，没动）。
- Fable 手机遥控 YF-8：托盘菜单在遥控都关着、`remoteChannelsReadyToEnable`（`codex-remote-service.ts` 顶层纯函数：
  选好了文件夹、渠道有凭据和配对过的人、还没开着）不空时多一项「打开手机遥控」（`ApplicationTraySnapshot.remoteControlReady`、
  `onRemoteControlOn`），跟「关掉手机遥控」同一处。点了走新方法 `enableReadyChannels`：齐了的渠道挨个 `setChannelEnabled`，
  检查跟设置里那个开关一样；一个都没打开时把第一个原因原句交回来，`main.ts` 用 `desktopNotifications.announce` 弹
  「手机遥控没打开」，没弹出来时 Windows 退到托盘气泡。`main.ts` 跟着每份快照重算齐没齐，开机先读一份；只在开没开、
  齐没齐变了时重建菜单。用户行并在 `codex-remote-fixes-0224.md`。
- Fable 手机遥控 YF-5（yoyo 2026-11-11 亲手打字「微信免配对码，加条件做」）：`fetchWeixinLoginQrCode` 请求体多带
  `bot_spam_business_data`（`weixinVerifyPinBusinessData`，照腾讯 openclaw-weixin 3.0.0-beta-0 的 `encodeBotSpamBusinessData`，
  base64 的 `{"verify_pin":1}`），请微信每次都要扫码人输手机上那串数字。`codex-remote-weixin-login.ts` 按一张二维码记
  `pinAsked` / `pinAccepted`：微信回过要数字、之后带着数字问回来拿到已扫码或确认才算过；换二维码清零。过了且确认里有
  `ilink_user_id` 时 `saveCredential` 多传扫码人编号，`saveChannelCredential` 的新可选参数 `verifiedPeerUserId` 直接把他记成
  绑定的人（原来绑着别人时照换人那样先说一声、挂着的配对码作废，日志 `remote.paired-by-scan`），快照 `boundByScan` 让弹窗说
  「已经绑定你这个微信」。#1772 起名字里带 need_verifycode 的（含 `confirmed_but_need_verifycode`）都算微信要过数字。
  没过数字的登录行为不变。用户行并在 `codex-remote-fixes-0224.md`。
- YR-6：手机遥控的收件队列里，「停止」「同意 / 拒绝」（打字的和卡片按钮）不再排在光发图的消息后面等取图
  （网不好时一张最长 30 秒、一次最多 5 张）。`codex-remote-service.ts` 新增 `jumpsImageFetch` 判断哪些消息能跳，
  `ChannelRuntime.inboxExceptImages` 记「除了光发图的以外都处理完」的时刻，这几种消息只等它；带字的图、前面排着的
  别的话照旧要等，「停止」停得到排在图后面的那句。排队时算「同意」、轮到时审批已经没了的，回到原来的位置等图，
  交给 Codex 时带得上前面的图。不加新字。
- 首页「配置文件坏了」的「修好它」碰上 Codex 读不了的 config.toml，先试着只去掉读不了的那几行
  （`salvageCodexConfigText`，codex-config-syntax.ts），救得回来就照合并修：客户信任过的文件夹、加的连接、
  推理强度都留着；以前一律整份换成星芒的模板。只去掉一整条在一行里的「键 = 值」，坏的是表头就连它下面的键一起去掉；
  跨行字符串、跨行数组、键或表重复、不是 UTF-8、去掉的超过 20 处、去完是空的，都照旧整份重建。原文件照旧先备份。
  当前账号、官方账号（ChatGPT 登录）两边的「修好它」都走这条；配置窗口里的「重置为初始状态」不变，照旧整份重建。
  2026-11-18 客户的 config.toml 被 PowerShell 5.1 按 GBK 读、UTF-8 写回，中文用户名后面的反斜杠被吃掉，
  坏的只是带用户名路径的那几行。
- 自动更新、原生 CLI（Codex、Grok）、Node.js、Python 的签名校验，找系统 winget、查 Windows 待重启、
  检查页读 exe 版本、更新前查正在运行的 CLI，这几段 PowerShell 在受限语言模式下也能跑完（用户那条并进
  `codex-desktop-constrained-language.md`）。以前它们开头设 UTF-8 输出那句写在 `$ErrorActionPreference = 'Stop'`
  后面，受限模式一拒就整条结束；结果又用 `[pscustomobject]@{...}` 输出，同样被拒。自动更新的签名校验因此
  次次失败，这类电脑上永远装不上新版本：0.2.22、0.2.23 是同一段脚本，已经在用的客户得手动下载新版装一次
  （推测，没在客户电脑上演过）。现在 UTF-8 那句只在 FullLanguage 执行，结果改用哈希表经
  `buildPowerShellJsonOutputStatements` 输出，`List[string]` 换普通数组，读版本改用 `Get-Item` 的
  `VersionInfo`；签名状态、发布者、路径比对都还在主进程里，一行没动。Windows CI 上用
  `__PSLockdownPolicy=4` 强制锁定实测过改前改后两轮，PowerShell 冒烟检查新增一条在受限模式下跑这批脚本，
  读中文目录下的已签名文件；新单测 `powershell-constrained-language-scripts.test.ts` 钉住这批脚本不再用受限
  模式拒绝的写法。还没改的（Codex / Claude Desktop 安装提权、Node.js 提权安装、改用户环境变量、管理员身份
  运行时的目录权限核对）另开 PR。
- 改当前用户 PATH（装好命令行工具后把目录加进去、卸载时拿掉）、检查页读和清旧的代理环境变量、一键删掉
  覆盖设置，这五段 PowerShell 在受限语言模式下也能跑完（用户那条并进 `codex-desktop-constrained-language.md`）。
  以前它们开头设 UTF-8 输出那句写在 `$ErrorActionPreference = "Stop"` 后面，受限模式一拒就整条结束；后面又全靠
  `[Environment]::`、`[IO.Path]::` 和注册表键的 .NET 方法，同样被拒。现在第一行之后先接一段只有非 FullLanguage
  会话才走的分支（`buildPowerShellConstrainedLanguageBranch`），用 `Get-ItemProperty` / `New-ItemProperty` /
  `Remove-ItemProperty` 读写 `HKCU:\Environment`：PATH 原样读（暂时拿掉进程环境变量，Windows 就不展开
  `%NAME%`，`finally` 里放回），类型用 System32 的 `reg.exe` 查、照原类型写回，写完用 System32 的 `setx.exe`
  广播一次、再删掉它留下的空值。FullLanguage 走的那几行一字没动；只写当前用户，不碰机器级设置和执行策略，
  名字照旧过固定名单。Windows CI 上用 `__PSLockdownPolicy=4` 强制锁定实测过改前改后两轮（14 种情况，注册表
  结果与 FullLanguage 逐项相同，有写入的都广播到了），PowerShell 冒烟检查新增一条把两种模式各跑一遍、对照注册表；新单测
  `powershell-constrained-language-environment-scripts.test.ts` 钉住分支里不用受限模式拒绝的写法。
- 新增 `npm run check:wording`（`scripts/check-customer-wording.cjs`）：用 TypeScript 读 `src/renderer-v2` 和
  `electron` 的源码，挑出会给客户看的字（JSX 里的字、带中文的字符串、标题和读屏标签这类属性），查有没有
  PATH、npm、TOML、环境变量、Sub2API、new-api、站点域名、「站点」和「Key」。先只报不拦：总是以 0 退出，
  CI 的 linux-test 把命中的地方写进作业摘要；放过的几处在脚本里的名单上，每条写明为什么，文字改了对不上时
  `scripts/check-customer-wording.test.cjs` 会红。对照官方「验证」文章的建议第 8 条，界面上的字一个没改。
- 安装包上的版权行不再写死 2026，按出包那天的北京时间取年份（D103，0.2.24 深查 打包构建 PK-13）。
  `electron-builder.config.cjs` 的 `copyright` 改由 `scripts/release-copyright.cjs` 的 `buildReleaseCopyright(new Date())` 给出，
  Windows 安装程序和主程序文件属性里的「版权」、Mac「关于」那一行都读它。发版跑在 UTC 的 CI 上，按北京时间算是为了
  1 月 1 日凌晨 0 点到 8 点出的包也写新的一年；中国不用夏令时，固定东八区，不依赖 Node 的时区数据。
  `scripts/release-copyright.test.cjs` 钉住跨年那一刻和时间无效时报错，`update-release-utils.test.cjs` 那条出包配置断言改成比对出包那一刻的年份。
- 决定单 D107（0.2.24 深查 作品和素材库.md L-1）：`chooseAiOutputRoot` 在「文档」这次试写通过、主目录下的
  `XingmangAI`（按账号域换过）里还有 `user-<id>` 文件夹时，交出 `worksToMoveBackFrom`；`bootstrap/ai-services.ts`
  照老版本搬家那套 `migrateLegacyAiOutput` 在后台挪回来（同盘整目录改名、跨盘逐文件、不覆盖、不跟链接、元数据按条合并，I8）。
  覆盖三种来路：「文档」不让写后又放开、OneDrive 接管「文档」后又关掉、iCloud「桌面与文稿」开了又关。反方向（作品在「文档」、
  这次因为云盘同步放主目录）照旧不挪，免得把云盘里的占位文件整份下载。两次搬家改成排队一个接一个跑，日志只记条数，
  新事件 `asset.output.moved-back-to-documents`。
- D17（0.2.24 深查 `权限和写失败.md` PW-10，yoyo 11-10「按照你的推荐做」）：从星芒打开命令行工具前在项目文件夹里试写一次，
  写不进去不拦，打开后首页那条提醒说「这个文件夹只能看不能改，AI 改不了里面的文件，建议换一个。」。
  Mac、Linux 在 `provider-launch-service.ts` 的 `launchProviderOperation` 里试写（敏感目录判定之后、写信任之前，
  `documents-fallback.ts` 新增 `shouldNoteReadOnlyWorkspace`：普通文件夹和桌面、文稿、下载才试，主目录、盘根、系统目录不试）；
  Windows 照旧在 `ipc/handlers/launch.ts` 的 `launchIfWritable` 试那一次，权限类（EPERM / EACCES）照旧弹「这个文件夹不让写入」，
  `inspectWorkspaceWritable` 新分出的 `read-only`（EROFS：光盘、写保护的 U 盘、只读挂载）不再悄悄打开，改为同样打开后提醒。
  结果经 `CliLaunchResult.workspaceReadOnly` 带回渲染层，`launch-notice.ts` 的 `launchWarning` 出这句（跟项目设置盖过账号那句
  同时有时前后接着说），首页和记录页「接着聊」都用它。日志沿用 `workspace.write-check`（结果与耗时，不记路径）。
  新增测试注入项 `SystemServiceOptions.probeWorkspaceWritable`；没加 IPC 通道。
- 0.2.24 决定单 D23（批次 X28，界面和功能页.md S5）：飞书渠道停下来时卡片上只说三句固定的话
  （`codex-remote-feishu.ts` 的 `feishuProblemMessages`），不再把「长连接」、读凭据的原话照搬上屏。
  `RemoteChannelStatus` 加可选的 `problem`（credential / connection-limit / other），卡片按它配按钮：
  凭据不对时把「飞书应用」那一行的「重新填写」换成主色，连接数满给「重新连接」，其余再加「找客服」（打开帮助框）。
  读不出存好的凭据时飞书渠道不再往外抛，由它自己报「其余」那句。「重新连接」是新通道 `codex-remote:reconnect`
  （`CodexRemoteService.reconnectChannel`）：开着的渠道走跟换凭据重启同一条路断开重连一次，凭据、绑定的人、
  配对码都不动，手机上不收「电脑上关了」；没开着就原样交回状态。用户行并进 `codex-remote-fixes-0224.md` 那一条。
- 「飞书保存改」（产品负责人 2026-11-11 批字）：保存飞书凭据时换访问凭证，飞书回的应答里没有 code，
  红条原来写「飞书没有给出访问凭证（HTTP n）」，现在只说 `feishuSaveFailedMessage`，HTTP 状态记进日志
  `feishu.save-token-unexpected`。`requestFeishuTenantToken` 改抛 `FeishuTokenResponseError`（带 status），
  保存那一步走新的 `verifyFeishuCredential` 换字、记日志；凭据不对、连不上照旧是各自那句。
- 0.2.24 Fable 复查第 2 条（选 b，yoyo 批「停用提示改」）：`account-key-quota.ts` 的 `managedKeyStoppedMessage` 改指到网页的「令牌管理」重新启用，或在「个人中心 › 密钥管理」撤销。原句让客户去软件里「重新启用或延长到期时间」，可软件的密钥管理没有启用开关，服务端已标成已过期的 Key 光延长时间也用不了。只改字，判断逻辑没动；用户那条沿用 D3 分片，不另加。
- 0.2.24 深查 D3（账号和配置.md 新-2）：`new-api-client.ts` 的 `provisionCliKey` 加 `hasStoppedCliKey`。同一分组里、本软件给这个工具签过的名字下，比要复用的那把更新的 Key 是停用（status 2）、已过期（status 3）或过了到期时间还没改状态的，就抛 `managedKeyStoppedMessage`（`account-key-quota.ts`），不再新建不限额、永不过期的 Key，也不退回更旧的那把。
  被删掉、分组改名的照旧重签（#1074）；撤销后照抄原限制换新（`fresh`）和 AI 对话那把不受影响。历史账号（Sub2API）没动：要改得动 `sub2api-relay-backend.ts`，项目规矩不改它。
- 检查页 D35（汇总决定单批次 X09，代理.md PX-4，yoyo 11-11「决定单照推荐」= 「D35 改」不加按钮，结论照决定单原文）：
  `buildProxyChecks` 在「电脑里的代理设置」后面加一项 CLAUDE_SETTINGS_PROXY「Claude Code 自己设置里的代理」。经 `readSafeUtf8File`
  读 `providerConfigRoot('claude')/settings.json`（256 KB 上限），`claudeSettingsProxyVariables` 只取 env 段里 HTTP_PROXY / HTTPS_PROXY /
  ALL_PROXY 三个名字（大小写都认）的字符串值，`claudeSettingsProxyOutcome` 照 `inspectProxyVariables` 同一套规则试连：有指向本机又没开的
  才出这一项、亮黄灯（「Claude Code 自己的设置里写了一个代理，它现在没开，Claude Code 会连不上。」），details 只写变量名和端口；
  没写、开着、指向别的机器、没有这份文件都 `omit`。读不了或不是正经 JSON 的也 `omit`，原因只进日志：「Claude Code 跑命令前要不要先问你」
  读同一份文件，会在那一项报出来。不给按钮、不动文件（那是客户自己设的值）；渲染层不用改，`diagnosticTarget` 对它照旧给 null。
  决定单没给行名和正常时的字：行名取原文里的字拼成，正常时这一行不出。
- 更新说明「## 用户」这一版已满 60 条，这条只写开发。
- 决定单 D37（0.2.24 深查 作品和素材库.md D-1 的改字那一半；缓存那一半 P-1 已修）：作品文件在外面被删掉、挪走后，
  图片、视频、音频三个库的「AI 图片/视频/音频资产不存在或无权访问」换成「这张图/这段视频/这段音频已经不在电脑上了，
  可能被移走或删掉了。」，三句放进新的零依赖模块 `electron/ai-asset-missing.ts`（进渲染层 `valueImportable` 名单）。
  用户行并进 `d107-works-back-to-documents.md`。
- 聊天：复制图片、图片菜单报这句时 `chatErrorMessage` 原样上屏（以前落到兜底「请稍后重试」）；另存图片新加
  `chatAssetSaveErrorMessage`，是这句就照说，别的原因照旧「图片没有保存成功，可以重试」；预览读不出来时图片替代文字
  从「预览暂不可用，仍可尝试复制或另存图片」换成同一句。右键菜单里点了失败的弹框（`assetMenuFailureDialog`）本来就原样说中文，自动跟上。
- `ai-media-asset-service.ts` 的 `readAnyKind`：不再「最后问的那个库」胜出（一张图找不到也说「音频」）。哪个库说了「没有」以外的话
  就报它；三个库都说没有，按作品库索引记下的类型说那一句，类型提示不再在失败后删掉，客户再点一次说的还是同一句；
  没列过的编号不知道类型，照旧「AI 素材不存在或无权访问」。
- 视频剪辑认「片段/配乐在作品库里找不到了」的两处判断加上新句（`isGoneFromLibrary`），老说法照认。
- 决定单 D38（0.2.24 深查 作品和素材库.md S-1 的改字和量盘两件；原因进日志、图片字节暂存那两件不在这次）。用户行并进
  `d107-works-back-to-documents.md`。
- 视频片段下载下来、`storeMp4` 因为盘满（`ENOSPC` / `EDQUOT`，按 `startup-failure.ts` 的 `classifyStorageFailure` 顺着 `cause` 认）
  存不进去时，`ai-video-service.ts` 的 `downloadTask` 改报决定单那句（`ai-video-submission.ts` 的 `aiVideoDiskFullMessage`）：
  「视频已经生成、也已经扣费了，但电脑的磁盘满了存不进去。先别重新生成，清出一些空间后重开星芒，会自动取回。」
  任务记录这时本来就没删，下次登录 `resumeUser` 照旧再取一次。视频剪辑页和画布都原话上屏；对话页不出视频，不涉及。
  别的存不进去的原因（没权限、被占用）照旧是存储层那句。为此 `AiVideoAssetStore` 存不进去那句挂上原始错误做 `cause`。
- 发付费的生图、生视频请求之前（`AiAssetStore.assertWritable` 带账号那次，画布按项目那份同样走它），先量保存位置那块盘：
  剩不到 200 MB（`disk-space.ts` 新常量 `paidGenerationMinimumFreeBytes`）就停下，字沿用装工具前查盘那句
  （`describeInsufficientDiskSpace`：「C 盘空间不足，只剩……，至少需要 200 MB，请先清理 C 盘再试」），不另起新字。
  先量再试写，盘一点不剩时说的是空间不够、不是「写不进去、找客服」。量不出来照旧放行；开机和检查页那次不带账号、不量。
- 对话页 `chatErrorMessage` 认出这句原样上屏（以前落到兜底「请稍后重试」）。
- D4（0.2.24 深查 `安全.md` 新-1，yoyo 11-10「按照你的推荐做」）：打开 Claude Code 前，`provider-launch-service.ts` 的
  `workspaceCarriesClaudeProjectSettings` 依次 lstat 工作目录里的 `.claude/settings.json`、`.claude/settings.local.json`、`.mcp.json`
  （名单在 `workspace-guard.ts` 的 `claudeProjectSettingsFiles`），有任何一份、或看不了（除 ENOENT / ENOTDIR 以外的错）就给
  `trustManagedWorkspace` 传 `leaveFolderTrustToCli`：`~/.claude.json` 里不写这个文件夹的 `hasTrustDialogAccepted`、不建空项目条目，
  `hasCompletedOnboarding` 照旧补。日志记 `workspace.trust.left-to-cli`，这种情况下不再记 `workspace.trust.written`。
  以前写下的信任不回收；Codex、Grok 不受影响，已下线的 Gemini 那一支照旧。说明见 `docs/WORKSPACE-TRUST.md`。
- 深查 D42（聊天页 C6，产品负责人 2026-11-11 回「决定单照推荐」，字照决定单原样）：聊天输入框和「编辑消息」框去掉
  `maxLength`（原先是 40000，带文件以后是 `draftTextRoom` 扣掉文件后的余量），贴进超长的字不再被浏览器悄悄截掉尾巴。
  `chat/state.ts` 新增 `draftLengthError`，跟 `planTurn` 同一个口径（去掉首尾空白、用 `messageWithFiles` 连同带的文件一起算）
  超过 `chatLimits.messageLength` 时给出「最多 40000 字，现在 N 字，删掉一些再发。」：输入框下面显示这一句、发送按钮和
  Enter 都不发；编辑框用 `Textarea` 的 `error` 显示在框下面，「修改并重发」灰掉。`draftTextRoom` 没有别处用，删掉。
  「## 用户」并进 `chat-limit-200.md` 那一条（这一版更新页已经 60 条到顶）。
- 参数设置里的「系统提示词」照旧 `maxLength={40000}`：那一格没有发送按钮，决定单没给它的字，这次不动。
- 退出登录、去登录另一个账号时对话页在出图，也先问同一句（0.2.24 Fable 复查第 7 条，接 D44 / #1673）：主进程
  `account:logout` 和登录前那次 quiesce（`realm-account-service.ts` 的 `transition`，密码输错也照跑）都会把对话页的出图全停掉，
  以前只有「切换账号」框的「切换」问。现在「切换账号」框里的「添加另一个账号」「重新登录这个账号」打开登录框之前看同一个标记，
  在出图就弹同一个框（「对话还在出图，换账号会停掉这张图，可能已经扣费。」，「等它出完 ／ 仍然切换」）；个人中心和命令面板两处
  「退出登录？」确认框在点下去那一刻对话页在出图时补这一句，按钮照旧。不加新字，句子挪到 `chat-image-work.ts` 几处共用。
- 只在打开登录框之前问：登录框挡着整个界面，开着时出不了新图。其余能打开登录框的入口都是没登录或登录已失效时才有，那时对话页出不了图。
- 换账号时对话页在出图，先问一句再切（D44，0.2.24 深查并发竞态 BF2）：对话页把「有一条出图回复还没出完」登记到
  `src/renderer-v2/chat-image-work.ts`（判断是 `features/chat/state.ts` 的 `isGeneratingImage`，出字的不算），「切换账号」框
  （`SavedAccounts.tsx`）点「切换」时看一眼，在出图就弹「对话还在出图，换账号会停掉这张图，可能已经扣费。」，按钮
  「等它出完 ／ 仍然切换」，默认停在「等它出完」。「等它出完」= 这次不切、框关掉；问的时候图出完了也不自己切，等客户选。
  单子只给了正文和两个按钮，框用不带标题行的样式，这一句同时当框的名字。
- 不加通道：出图是对话页自己发、自己收的，界面这边就知道；切换框在主包里，登记处是个不依赖聊天代码的小模块，不把按需加载的聊天页拉进主包。
  对话页那份停了以后照样收完（`finishDispatchedAfterStop`）是聊天页 C4 / D41 的事，这次没动；退出登录不在 D44 里，照旧不问。
- 新手引导最后一步和首页「试试第一条命令」那句粘进去的话：要打开的是星芒刚建、还空着的项目文件夹时，
  换成让工具动手做个小网页（Claude Code 待办清单、Codex CLI 计算器、Grok CLI 番茄钟，字照汇总决定单 D45，
  新手流程 N4）。主进程 `starter-workspace.ts` 的 `isUntouchedStarterWorkspace` 只认 `XingmangProjects` 下
  星芒起的名字、只列这一层的名字（星芒放的 `AGENTS.md`、点开头的、`desktop.ini`、`Thumbs.db` 不算），
  判不准算不是；结果随配置摘要和打开结果的 `rememberedWorkspaceFresh` 带给界面，`opensUntouchedStarterWorkspace`
  按「打开」会落在哪个文件夹挑那句话。Codex 桌面端那句不变。
- 新手引导最后一步只删、只挪，不加字（汇总决定单 D46，新手流程 N2、N5）：「打开」「进入首页」挪进对话框底栏，
  跟「上一步」排在一起，内容再长也不用往下翻；引导里不再给「新开一个终端，敲这一条」和「复制命令」
  （`FirstRunSteps` 的 `withCommand`，首页那份照旧）；结果卡一切正常时收成一行（`GuideSetupResult.allClear`，
  有一行是黄的、或桌面端用密钥连着要先「切到 Codex」时照旧整张摊开）；「想换密钥或模型，点这里」不再出；
  「选哪个文件夹」那段说明和「新建并打开」收掉，换成一颗「选择其他文件夹…」。
- 引导那颗「打开」跟首页这个工具的「打开」同一套：没用过、也没记过文件夹的替他新建项目文件夹打开（`firstOpen`），
  用过的在首页「打开」写着的那个文件夹里开（不在了提示一句再弹选择窗口），以前一律弹系统的选文件夹窗口。
  判法收进 `recent-workspaces.ts` 的 `startsInNewFolder`，首页和引导（`features/auth/useGuideLaunch.ts`）共用；
  那句粘进去的话（D45）也改按「打开」实际落在哪挑，不再按「记没记过文件夹」近似。
- 活动公告的截止时间一律按北京时间（UTC+8）换算，不再按本机时区拼：国外或时区设错的电脑上，首页活动卡片和顶部活动条不再比真实截止提前或推迟十几个小时收掉。日子、钟点、「今天/明天/还剩几天」都照北京日历写；电脑的钟跟北京不一样时，在钟点或日子后面补「（北京时间）」，北京时间的电脑字不变（`features/shell/promo-announcements.ts`，时间数字格式 N-5，决定单 D55，yoyo「北京时间改」）。
- 设置 › 消息通知「发测试通知」（决定单 D68、深查 通知弹窗.md NT-6）：系统里把星芒的通知关了（Windows 专注助手、Mac「系统设置 › 通知」），
  Electron 的 `show()` 大多照样不报错（Mac 上一般静默），原来那句「已发送一条测试通知」会骗客户。改成提示条
  「已经交给系统了。没看到通知的话，去系统的通知设置里看看星芒有没有被关掉。」，Windows、Mac 上带一颗「打开系统通知设置」，
  打开了提示条才收起；没打开就留着，再补一条「没能打开系统通知设置，请在系统设置里找「通知」。」。
- 新通道 `xingmang-platform:open-notification-settings`（`platform/contract.ts`、`platform/preload.ts`、`platform/ipc.ts`），不带参数、回 `boolean`：
  打开哪一页由主进程定死（`platform/system-service.ts` 的 `notificationSettingsTarget`：Windows `ms-settings:notifications`，
  Mac `x-apple.systempreferences:com.apple.Notifications-Settings.extension`，Linux 回 null 不打开），经 `shell.openExternal` 交给系统，
  渲染层给不出网址（I12），带参数一律拒；日志记 `opened`。只服务主窗口，跟同一组其他通道一样过 `assertPlatformOwner`。
- 主进程把通知的 `failed` 事件回传给「发测试通知」（NT-6 第三条建议）这次没做：决定单 D68 只定了说法和按钮。
- 更新说明「## 用户」已到 60 条上限，这条不进更新页。
- 0.2.24 深查 D80（`0.2.24-深查/高分屏窗口.md` W-2）：`resolveWindowPlacement` 没记过窗口位置时，原来初始宽 = 工作区宽 × 0.8、
  下限 960，工作区不到 1280×720 才最大化，1366×768、1280×800、1280×1024 第一次打开只有 1093、1024 宽，缩放落到 0.9，
  逻辑宽不到 1272，侧栏收成窄条。现在工作区宽不到 1440 直接最大化，初始（还原）宽下限提到 `min(1152, 工作区宽)`
  （1152 ÷ 0.9 = 1280 逻辑宽）。工作区 1440 以上的初始尺寸一个数不变；有 `windowState` 的人走原分支，一个数不变。
  `e2e/electron-ci-smoke.mjs` 里照抄的那份初始尺寸公式跟着改，`ui-spec/03-layout-window.md` §1 跟着改。
- 0.2.24 深查 D81（`0.2.24-深查/高分屏窗口.md` W-11）：Windows「设置 › 辅助功能 › 文本大小」调大以后，系统弹框和托盘菜单的字跟着大，
  界面里的网页内容不吃这一项。现在 Windows 上开机时异步读一次 `HKCU\Software\Microsoft\Accessibility` 的 `TextScaleFactor`
  （新模块 `electron/windows-text-scale.ts`，照 `windows-taskbar-theme.ts` 的读法：System32 的 reg.exe 绝对路径、最小环境、
  `execFile` 异步、读不到当没调过），和迁移、执行模式探测叠着跑；建主窗口前已经读回来、大于 100%，且客户没定过字的大小时，
  写入 `largeText: true`（判断在 `window-preferences.ts` 的 `shouldFollowSystemTextSize`）。建窗口不等它，没读回来这次就不管。
- `AppSettings` 加 `textSizeChosen`（只落 true）：`mergeAppSettings` 里任何一次写入带了 `largeText` 或 `uiScale` 就记上，
  包括关掉「大字」、选回「自动」、「恢复默认外观」和替客户自动开的那一次，所以客户关掉以后不会被再打开。老版本没有这个字段，
  已经手动关过「大字」的老客户第一次会被开一次，关掉就不再开。`ui-spec/03-layout-window.md` §1 跟着补了一段。
- D82：两套默认配色里输入框（`.xm-field`、`.xm-search`、下拉选框、聊天输入框）和次要按钮的边从原型的
  1.3～1.4 : 1 加深到对底色 3 : 1，悬停再深一档（以前悬停用 `--line-3`，加深后会比平时还淡）。值只写在
  `src/renderer-v2/styles/tokens.css`，`ui-spec/tokens.css` 仍是原型；新增 `--input-line-hover`、
  `--btn-2-line`、`--btn-2-line-hover`，高对比度两套给了跟以前一样的值。`contrast-tokens.test.ts`
  加默认两套的检查：三级文字 4.5 : 1、按钮和状态文字 4.5 : 1、焦点环和开关 3 : 1、这两种控件的边 3 : 1
  且悬停不变淡；高对比度「每个令牌都盖住」那条也把新令牌算进去。出处：键盘无障碍.md KB-15。
- 安装包在线路2 下不动时换回线路1 再下（决定单 D84，深查 Z-2）：以前只有检查更新会在直连那份更新地址（xm-direct）没走通时
  换回包里那份，下载失败只在停住、代理连不上时换直连重下一次，Windows 星芒账号选「自动」、走线路2 的客户碰上洛杉矶那台
  能回清单、大文件下不动或半路断，只报「下载更新失败」。现在 `UpdateFeedRouting` 多一个可选的 `fallBackDownload`：
  原有的那次自动重下之后还没下成，宿主（`bootstrap/updates.ts`）在「自动」且当前用的是直连那份时按
  `classifyDirectFeedDownloadFailure`（`update-feed-route.ts`）判断，换回包里那份，`updater.ts` 在那份上重查一次再下一次
  （electron-updater 下载用的是检查时那份地址，光 `setFeedURL` 不重查还是去直连）。手动固定线路2 的不换；盘满、文件被占、
  核对不过、electron-updater 那次一直没收尾的不换。停住、下到一半断了（`ERR_CONTENT_LENGTH_MISMATCH`、
  `ERR_INCOMPLETE_CHUNKED_ENCODING`）只换这一次、不报给线路那边；连不上一类和 502/503/504 跟检查一样报。重查那一下阶段留在
  「正在下载」（不闪回「有新版本」，免得强制更新门和自动更新再起一次下载），已经在下的那一版不受分批放量收回；代理已经确定
  连不上的，这一次照样绕开代理。没加界面文字。日志 `feed.download-fallback`，`download.stalled` 多一个 `switchingFeed`。
- D86（0.2.24 深查决定单，装工具和更新.md S-3）：Mac、Linux 上星芒代装的 Node.js 比钉的版本
  （`macos-node-runtime.ts` / `linux-node-runtime.ts`）旧时，装或更新命令行工具前，在同一个安装
  队列任务里静默换成钉的那版（`runtime-install-service.ts` 的 `refreshOutdatedManagedNodeRuntime`，
  由 `cli-install-service.ts` 在找 npm 之前调）。只换产品目录里代装的那份、而且它正是星芒这会儿用的
  那个 node：客户自己装的不碰，Mac 上客户自己那份够新时代装的那份轮不到，也不白下。版本报不出、
  比钉的新都不动；没换成只记运行日志，照旧用原来那份装工具；客户取消照常说「已取消」。Windows 不变
  （D88 交 Claude·win）。
- 公告里写成 `https://xm.solov.cc/…` 的官网图片以前在主窗口一直是破图标：页面的安全设置（`app-protocol.ts`、`index.html` 的 `img-src`）
  只放行本地和 `data:`。现在由主进程下好换成 `data:` 交给页面，页面的安全设置不动（决定单 D89 a，外部链接深查 L3，yoyo 11-11「决定单照推荐」）。
  更新页「## 用户」已满 60 条，客户看得见的变化（公告里官网的二维码、活动图能显示了）这次没另占一条。
- 新增 `electron/announcement-image.ts`：只下当前账号那个站官网（`relay-sites.ts` 的 `websiteUrl`）同源的 https 图，站点由主进程按当前登录定；
  I10 四件齐（15 秒时限、单张 1 MB、`redirect: 'manual'` 且 3xx / opaqueredirect / 落到别的 origin 一律拒、地址先校验），
  不带凭据（`credentials: 'omit'`）；按开头字节只认 PNG、JPEG、GIF、WebP，不收 SVG，边长 ≤ 8192、总像素 ≤ 1600 万；
  同一张图半小时内只下一次（缓存总量 8 MB），同时最多下三张、最多排 32 张。
- 新通道 `account:get-notice-image`（契约、`preload.ts`、`ipc/handlers/account.ts`、`ipc-channel-policy.ts` 四处，成功不记日志、失败照记，跟账号走 scoped），
  页面只给图片地址，主进程再校验一遍。下图用的 fetch 照样按线路走、换线路重发，但下不下来不报给线路那边：
  `relay-line-fetch.ts` 新增 `unreported` 选项，`bootstrap/network-routes.ts` 建一个 `announcementImageFetch`，跟 `/api/notice` 不报是一个道理。
- 页面：`Announcement.tsx` 新增 `AnnouncementImage`，Markdown 和富文本两种公告里官网的图先空着、拿到 `data:` 再过一遍 `safeAnnouncementImage` 才显示，
  下不下来、外站的图照旧显示原来那句「[图片：说明]」，没有新字；页面自己从不去连网上的图。公告原生正文（iframe 那条）照旧只认内嵌图片，不在这次里。
- D94（深查 TR-8）：Windows 托盘图标改用多尺寸 ICO（`assets/brand/v3/tray.ico`，16/20/24/32/40/48/64px），
  系统按当前缩放挑正好那张，125%、150% 下不再拿 32px 的 PNG 去缩而发虚；任务栏是深色时换浅色外圈的
  `tray-dark.ico`。两份都由 `scripts/generate-tray-icons.mjs` 从品牌包 `micro32-standard.svg` /
  `micro32-dark.svg` 原样画出，不另画。深浅由新模块 `windows-taskbar-theme.ts` 异步读
  `SystemUsesLightTheme`（System32 的 reg.exe）：Electron 45 的 `shouldUseDarkColorsForSystemIntegratedUI`
  开机时答的是应用模式、只换「Windows 模式」时也不发 `updated`。主窗口挂 `WM_SETTINGCHANGE`，
  换深浅后 300 毫秒再读一次；ICO 读不出来时退回原来的 PNG。macOS、Linux 不变。
- `publish-release` 的 `windows-build` 上传 artifact 之后加一步「用微软自带杀毒扫安装包」（D96 / AV-11）：
  先去掉出包机器出厂带的 `C:\`、`D:\` 两条 Defender 排除，更新病毒库，拿反着存的 EICAR 测试文件
  当对照，再用 `MpCmdRun -Scan -ScanType 3 -DisableRemediation` 扫 `Setup.exe` 和 `win-unpacked`。
  只有真报毒（退出码 2）让作业失败、`publish` 不跑；Defender 起不来、对照没报出来、超时只打黄色警告，
  照常往下走。结果写在这一步的运行摘要里。在线多引擎扫描按 D96 不加。`scripts/publish-workflow-config.test.cjs` 钉住。
- 下载页那份用户协议（`dl-landing/legal/user-agreement.md`）第 5 节「知识产权」补一句：开源组件按各自许可证授权，本协议不限制依据这些许可证享有的权利，组件清单见安装目录下的 THIRD-PARTY-NOTICES.txt（汇总决定单 D99，批次 X50）。只改仓库，下载页要等下次发布落地页才上线；软件里显示的那份在 `xm.solov.cc` 服务端，不在本仓。
- 启动速度深查 S-1：renderer-v2 的 `main.tsx` 第一帧把 `data-theme` 写死成 `light`，没读主进程早就拼进地址的 `?theme=`
  （`resolveMainWindowUrl`，旧界面 `src/app-shared.ts` 是读的，换到 v2 时丢了），深色用户每次开窗先看到浅色的 Splash，
  要等 `boot`（它等账号开机闸门，最长 3 秒）和设置回来才变深。新加 `features/app/initial-theme.ts`，只认 `light` / `dark`，
  别的值照旧按浅色。
- 界面进程崩溃后自动重新加载、「界面没有响应」里点重新加载，原来是 `webContents.reload()`，会带着开窗那一刻的 `?theme=`；
  中途换过深浅色的，重新加载出来第一帧又是旧的那套。改成和缩到托盘后重新加载一样，按此刻存的主题重拼地址再 `loadURL`。
- 0.2.24 深查 NT-0：去过的页面藏在 `hidden`（业务页还有 `inert`）外层下面不卸载，页面里开着的 `<dialog>` 跟着看不见，却还是模态框，整个文档点不动，只能按 Esc 或重开。`ui/modal.tsx` 的 Dialog 开着时用 MutationObserver 看祖先的 `hidden` / `inert`：被藏住就原生 `close()` 让出顶层（React 的 open 和框里的内容不动），露出来再 `showModal()`，焦点回到藏之前框里那个元素；页面在后台打开的框等页面露出来再开。只重开它自己让出去的框，浏览器自己关掉的不碰；藏着时被关掉的框不再把焦点拽回原按钮。补了组件级（`ui/browser-check.mjs`）和整页（`testing/app-check.mjs`，托盘/通知换页）两条浏览器回归。
- 账号库文件本身坏了（空文件、截断、不是 Base64、坏道读出的乱码，或解得开却不是 JSON 对象）也算「读不懂」：客户主动点登录、手上又没有登录态时，照解密失败那套留一份 `realm-accounts-v2.dat.unreadable-*.bak` 再换空库，以前只认 `decrypt`，这台电脑就永远登不上，只能找客服远程删文件（数据和迁移 DM-2）。新增失败阶段 `parse`；`validate`（是 JSON 对象、只是版本或字段认不出，多半是退回旧版读到新版的库）照旧不动，开机、切换账号、退出也照旧不重建。`decode` 前去掉首尾空白和 BOM，记事本打开再存过的文件照常读出。`vault.recovered` 日志的 `reason` 改为实际原因（`decode` / `decrypt` / `parse`），不再写死 `decrypt`。`electron/realm-account-vault.ts`、`realm-account-vault-file.ts`、`vault-recovery-notice.ts`、`bootstrap/accounts.ts`，规则见 `docs/ACCOUNT-VAULT-RECOVERY.md`。
- Electron 这一版停在 45.1.0 没升（`docs/RELEASING.md`「Electron 不能落后同一大版本的最新版超过 2 周」）：
  比它新的第一版 45.2.0 是 10-30 出的，到 11-18 定版已过 19 天，npm 上最新是 45.3.4（11-17）。
  0.2.24 赶着发，换补丁版要把 #1508 那套剪贴板、付款窗口、画布的真机点重看一遍，产品所有者 11-18 定这版不升；
  0.2.25 开头先升到 45 的最新补丁版。
- Claude Desktop、OpenCode、WorkBuddy 的开机盘点脚本（`external-client-runtime.ts` 的
  `windowsExternalClientInventoryScript`）在 PowerShell 受限语言模式下也能跑完。以前第一行
  `[System.Diagnostics.Stopwatch]::StartNew()` 被拒，接着读「记住的签名」那句
  （`[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(...))`）被拒，在
  `$ErrorActionPreference = 'Stop'` 下整条退出码 1、stdout 为空，三张卡次次「命令执行失败（退出码 1）：
  powershell.exe」（2026-11-10 客户电脑）。现在计时用 `[datetime]::UtcNow`；结果用 `[ordered]@{}` 和数组，
  不再用 `[pscustomobject]` 和泛型 List；记住的签名改成「ASCII 以外的字符先写成 `\uXXXX` 的 JSON」再 base64
  （新函数 `encodeKnownExternalClientSignatures`；整条命令行比原来长约一成，带两条记住的签名时约 25700 字，
  离 32767 上限还远），脚本用字符串方法和位运算自己解；
  文件名用 `-split` 取；开头设 UTF-8 那句和最后输出 JSON 用 `powershell-constrained-language.ts`。
  要 .NET 的两处在 FullLanguage 下照旧：路径规范化在受限模式下改成凡是 `GetFullPath` 可能改写的一律拒
  （`/`、连着或结尾的 `\`、`.` / `..` 段、以点或空格结尾的段、8.3 短名、260 字及以上）；坏键逐值重读在受限模式下
  改用 `$key.Property` 加 `Get-ItemPropertyValue`。没放宽任何校验。Windows CI 上用 `__PSLockdownPolicy=4`
  强制受限模式实测过，PowerShell 冒烟检查新增一条在受限模式下用真注册表项和真文件跑盘点。
- 深查·桌面端接入第 1 条：自动换密钥（#1113）原来只拿新 Key 的型号清单核默认那一个。Claude Desktop 开机检查挑的是菜单里的 Haiku（`claudeDesktopStartupCheckModel`），新 Key 没有 Haiku 时一打开就「型号被拒」；WorkBuddy 每条都换了 Key，不看各条的型号。
  现在 `claude-desktop-config.ts` 的 `followKey` 在写之前重读出来的那份上逐项核菜单，新 Key 不认的在同一笔写里拿掉（留下的项原样不动，默认那个不认就整笔不写）；`external-tool-config.ts` 的 `followExternalToolKey` 只换型号新 Key 认的 WorkBuddy 条目，不认的留着原 Key，一条都不认就不写。没跟过去的型号进 `external-client.key.followed` 日志的 `unsupportedModels`，不加界面文字。OpenCode 不变（只换当前型号那一份，调用方照旧核）。
- 外链白名单检查和交给浏览器的地址对齐（PR #1888 顺带发现第 2 条，建议级）：`security.ts` 新增
  `resolveAllowedExternalUrl`，返回比对上的那一条白名单原文；`external:open`（`ipc/handlers/window.ts`）和
  画布窗口的弹窗、导航（`canvas-window.ts`）都改为打开这一条，不再把渲染层给的原文交给系统浏览器。
  以前开头带空格、主机里夹 Tab、斜杠写成反斜杠的写法能过检查并原样交出去，今天浏览器解析后落到的还是同一页，
  但检查和打开不该依赖两个解析器碰巧一致。`isAllowedExternalUrl` 保留，改为调用它。
- 0.2.24 深查「查表单输入校验」F1：注册「密码」和找回密码第 3 步「新密码」「再输一次」三个框去掉 `maxLength: 20`
  （`features/auth/AuthFlow.tsx`）。以前粘进来超过 20 位的密码被输入框悄悄截成前 20 位，账号按截短的设好，客户拿原密码
  就登不上；`state.ts` 里现成的「密码不能超过 20 位」「新密码不能超过 20 位」被输入框挡在前面永远出不来。现在整串留在框里，
  由 `validateRegistration` / `validateNewPassword` 当场拦下，不发请求；8~20 位的规则不变，不加新字。个人中心改密码
  本来就没有 `maxLength`，用户名框截了看得见，照旧。用户可见条目已满 60 条，这件不另写用户条目。
- 深查·查余额和扣费显示 F1：订阅还没读到（刚登录、刚换账号）或第一次就读失败时，渲染层不再当成「没有订阅」。
  钱包 $0、靠订阅用的客户以前在这段时间里会看到首页「当前账号余额是 $0」那条、工具卡「余额为零」和「去充值」、
  侧栏「充值」后面挂「余额为零」、顶部余额变红、新手引导把「去充值」顶到最上面，读失败时一挂 5 分钟。
- `subscription-cache.ts`：`readAt === null` 就是「还没读到」；这个账号还一次都没读到时，读失败后 30 秒、1 分钟、
  2 分钟……最多 5 分钟后再试（`subscriptionFirstReadRetry`，仍然只跟着余额的读回触发，不另起定时器）；读到过的照旧
  5 分钟一次、失败了留着上一次的。`useUsableSubscription` 多返回 `subscriptionUnknown`。
- 不知道有没有订阅时：`buildBalanceRunway` 回 `{ usableUsd: null, days: null, low: false }`（不算天数、不挂「余额低」
  「余额为零」），`homeMoneyNotice` 回 null，`homeWalletEmpty` 回 false，新加的 `balanceTier`（从 `App.tsx` 那一行搬出来）
  对不到 $20 的钱包用中性档，侧栏账号卡不写「按量付费」。手机遥控卡的「余额快没了」读的是同一个档位，一并不提醒。
  跟主进程托盘、余额提醒的 `subscribed: null` 同一个口径。读到了、确实没有订阅的 $0 客户，原来的提示照旧出现。
- 顺带修了 `useUsableSubscription` 在开发版 StrictMode 下的老问题：effect 清理时直接 `cache.dispose()`，StrictMode
  马上重连的还是同一个缓存，从此订阅一次都不读（正式包没有这一遍，不受影响）；改成跟余额那份一样，最后一个使用者
  离开后才释放。以前这个问题被「读不到 = 没有订阅」盖住了，这次不修会变成开发版里永远「不知道」。
- 测试：`subscription-cache.test.ts`（没读到时 `readAt` 为 null、30 秒起翻倍重试、读到过的照旧 5 分钟、换账号重新数）、
  `balance-runway.test.ts`（不知道时不算天数、`balanceTier` 各档）、`Home.test.tsx`（$0 提示、工具卡、余额卡），
  `app-check.mjs` 新加一条：夹具 `subscriptionReadFail` 让订阅一直读失败，首页、工具卡、大卡、侧栏都不说「余额为零」。
- 首页余额卡两条（`0.2.24-深查/查余额和扣费显示.md` F2、F3），不改字、不加通道：
  - F2：订阅额度会按天、按周或按月恢复（`UsableSubscription.resetsAt` 有值）时，`buildBalanceRunway` 不再拿这一期剩下的去除日均，返回同不限额订阅的 `{ usableUsd: null, days: null, low: false }`；`subscriptionWarning` 也不再为它说「订阅只剩 $x」，只在快到期时提醒。以前每天 $10 的订阅、每天用 $8 的客户每天下午被说「不到 1 天就会用完」、侧栏挂「余额低」。这一期赶不到到期前再恢复（`resetsAt` 为 null）的照旧按一次性额度算。
  - F3：`Home.tsx` 读用量和近 7 天的两段 effect 跟上余额的 `updatedAt`（一分钟缓存照旧挡着），余额旁边的刷新先 `invalidateBalanceUsage()` 再一起重读；缓存刚作废、手上已有数时不先清空，卡片不闪。以前一直停在首页时「近 7 天花费」和「约还能用 N 天」停在进首页那一刻。
- 0.2.24 深查「查表单输入校验」F2：登录框「用户名或邮箱」和找回密码第 1、2 步的邮箱，提交前也像注册那样把中文输入法
  打出来的全角＠、全角句号改成半角，并当场改在框里（`features/auth/AuthFlow.tsx`、`state.ts` 新增 `normalizeLoginAccount`）。
  以前只有注册会改：同一个邮箱拿去登录，历史账号报「历史账号请使用注册邮箱登录」，星芒账号回账号或密码不对，点「找回密码」
  又报「请填写注册时用的邮箱」，整条路走不通。登录框只在带 @ 或＠、改完确实是邮箱时才改；用户名照旧只去首尾空格。
  从登录框点去找回时带过去的邮箱同样先改好。不加新字；用户可见条目已满 60 条，这件不另写用户条目。
- 0.2.24 深查「查表单输入校验」F4：充值订阅页「我的订单」的搜索框，框里的字和拿去查的词分开，去掉首尾空白再查，
  停手 300 毫秒才查（`features/account/AccountRecharge.tsx`，照密钥页搜索 #495 的做法）；清空和付款回跳带来的订单号照旧马上查。
  以前只打一个空格（中文输入法下按空格是全角空格）就原样交给主进程，`parseAccountTopupOrdersQuery` 抛「订单搜索词格式错误」，
  订单列表变成「没读出来」；手打一个二十多位的订单号要连着查二十多次。主进程那边只有空白的搜索词也当没填
  （`electron/ipc/parsers/account-billing.ts`），长度上限 128、拒绝 NUL 照旧按原样算。不加新字、不加新通道；
  用户可见条目已满 60 条，这件不另写用户条目。
- 外接工具「自定义连接」的「启动命令」里直接填整行命令（`npx -y 包名`）或带引号的程序路径时，交给工具前用
  `splitCommandLine` 拆成程序和参数，拆出来的参数排在「附加参数」前面；以前整串原样当程序名交下去，
  工具里那条一直连不上（表单输入校验审查 F6）。只拆两种：以引号开头的（引号里就是程序，只有一段带引号的路径也去掉引号），
  和第一段是 npx、uvx、node 这类的（只写名字，或写到 .exe/.cmd/.bat 的完整路径）。没加引号的
  `C:\Program Files\…\node.exe`、`D:\node tools\x.exe`、引号没配对的照原样交。表单里填的字不动，主进程对命令和参数的检查不变，
  没改界面文字（`buildLaunchCommand`，`mcp-paste.ts`）。
- 花费突增提醒的 6 小时安静期改按「站点 + 用户编号」记（`0.2.24-深查/查余额和扣费显示.md` F8-2），不改字、不加通道、门槛不变：`balance-alerts.ts` 交给 `spend-spike.ts` 的 `account` 从 `String(userId)` 换成余额观察的 `scope`（`solov:123` / `solov-api:123`，跟余额用完那条记录同一个键）。以前星芒账号和历史账号的用户编号碰巧一样时，一边提醒过，另一边 6 小时内也不再提醒。
  `spend-spike-notified.json` 里旧版只按编号记的那条照旧算数：新键还没有记录时退回看旧键（`SpendSpikeObservation.legacyAccount`），升级前 6 小时内刚提醒过的不再说一遍；旧记录过了安静期就不再算数、读写盘时顺手清掉。通知的事件编号随之变成 `spend:solov-123:<时间>`。
- 首页用量缓存 `balanceUsage(scope)` 作废重查以后，重查回来的还不是 `scope` 这个账号的（主进程那边已经换了账号、
  界面这边还没跟上）就报错，不再把别的账号的用量交给调用方：侧栏账号卡会把拿到的数记在 `scope` 名下，
  换回原账号时可能先摆出别人的数。缓存里那份照旧记在它真正所属的账号名下。审查编号：余额 F8-6
  （`src/renderer-v2/features/tools/api.ts`）。
- 注册框填邮件验证码的那一格：占位灰字从「邮件里的 6 位数字」改成「邮件里的 6 位验证码」（深查表单 F8，新字 yoyo 已回「改」）；
  提交前去掉空格、全角空格和零宽字符，全角字母数字换半角，整串是 6 位十六进制时转小写（新增零依赖的 `electron/email-verification-code.ts`）。
  new-api 的验证码是 UUID 去横杠的前 6 位（小写十六进制，比如 `3fa9c1`），注册时一字不差地比：以前大写锁着、全角模式打的、复制带出空格的都回「验证码不对」。
  renderer-v2 注册框和主进程 `parseAccountRegisterInput` 过的是同一份；别的写法只去空白、换半角，不改大小写，对不对仍由服务端判断。没加 IPC 通道。
- 0.2.24 Fable 复查第 2 条（yoyo 11-11 回「历史账号也停」）：历史账号也跟星芒账号（D3，#1660）一样，工具那把密钥在网页上停用、到期以后不再自动签一把不限额、永不过期的新密钥。`sub2api-relay-backend.ts` 的 `provisionCliKey` 加 `stoppedOnWeb`：同一分组、同一名字下，比要复用的那把更新的 Key 是停用（`inactive`）、已过期（`expired`）或者状态还是 `active` 但过了 `expires_at` 的（上游不会自己改成 `expired`，用的时候按时间拦），就抛 `sub2ApiManagedKeyStoppedMessage`（`account-key-quota.ts`），也不退回更旧的那把。
  被删掉、分组改名的照旧重签；撤销后照抄原限制换新（`fresh`）和 AI 对话那把（`purpose: 'chat'`）不受影响。提示里的叫法照 Wei-Shaw/sub2api 前端（270eac6 和 11-11 的 main）核过：侧栏「API 密钥」、每行「启用」「编辑」、编辑框「过期时间」；线上那台没打开看。用户那条沿用 D3 分片（没写是哪种账号），不另加。
- Fable 复查第一轮 3（2026-11-11 yoyo 批「切回官方问一句」）：0.2.24 之前接过星芒的配置快照里没有 `filled` 记号，切回官方账号以后
  `permissions.defaultMode = "bypassPermissions"` 照旧留着（D5 只撤记下的）。现在切回官方（首页一键切换 `config:switch-account-source`、
  配置窗口 `config:switch-to-official-account`）切成以后，Claude Code 还是官方账号的样子又还是 bypass、这台电脑又没问过
  （`AppSettings.claudeCommandConfirmationAnswered`，只落 true），结果里带 `askCommandConfirmation`，renderer-v2 弹
  `CommandConfirmationDialog` 问一次。用户可见的话并进了 `official-switch-withdraws-bypass.md` 那一条（用户行已满 60）。
- 新通道 `config:answer-claude-command-confirmation`（`ask` | `keep`）：`ask` 由 `restoreClaudeOfficialCommandConfirmation` 只撤
  `permissions.defaultMode = bypassPermissions` 和 `skipDangerousModePermissionPrompt = true`（`permissions` 撤空连键删），真要写才先做
  「设置 › 备份迁移」那份备份（同设置里两个 Claude Code 开关），配置这会儿又接着别的地址就抛错不改、不记问过；`keep` 什么都不改。
  两种都记问过，记不下只记日志。关掉框（Esc、右上角）当 `keep`；焦点落在「保持现在这样」，随手回车不改客户的设置。
- Fable 复查第二节第 4 条：`registry/tutorials.ts`「画布：从项目到生成结果」一章两处按钮名对齐画布现在的叫法
  （yoyo 2026-11-10 回「画布教程改」）。第 1 步第二行「点「选择文件夹并创建」，选择专用目录。」改成
  「点「创建」，不用选文件夹。想放别处就点「换个位置创建…」。」（kernel-v0.1.4 起新建项目默认放进默认文件夹，
  按钮叫「创建」「换个位置创建…」，见 `canvas-v2/src/project-pagination.ts`）；第 4 步第三行「导出项目包」改成
  「导出项目（含素材）」（`canvas-v2/src/App.tsx` 更多操作里那一项）。教程不写文件夹名，Windows 叫「文档」、Mac 叫「文稿」，
  新建项目的框里本来就写着放在哪儿。客户看得到的变化已在 `canvas-kernel-v0.1.4.md` 的用户那条里，这里不另占一条
  （一版用户行上限 60，本条合并前已是 59）。
- Fable 复查第二节第 5 条：九处旧叫法换掉（yoyo 2026-11-11 回「旧叫法改」）。软件自称「工具箱」「星芒工具箱」改成「星芒」：
  `platform/notifications.ts` 两条通知正文、`external-deep-links.ts` 链接无效的提示、`external-client-runtime.ts`
  不支持此系统的说明、`claude-desktop-config.ts` 归属记录无效（「工具箱配置」换成「的星芒」）、`codex-desktop-service.ts`
  Mac 以 root 打开时的拒绝；「异步任务已完成」通知标题改成「生成任务已完成」（`usage-bill-wording.md` 里「没动」那句以这条为准）；
  `FeedbackPage.tsx` 报告没生成出来时那一行和提示里的「诊断报告」改成「反馈报告」；检查页导出的保存框标题
  「导出脱敏诊断报告」改成「导出检查报告」，反馈预览导出的保存框标题「导出反馈与诊断」改成「导出反馈报告」。
  测试里写死的旧句跟着改。反馈报告正文抬头「反馈与诊断」、只进运行日志的「诊断报告导出」、只在浏览器直接打开才出现的
  「请从桌面应用打开工具箱」和冻结的旧界面都没动。客户看得到的变化很小，不另占用户行（一版上限 60，本条合并前已是 59）。
- 0.2.24 Fable 复查第 8 条：公告合集读不出来时那句是「公告没读出来，可以点「重新读取」，或到官网查看。」，
  可铃铛小框里只有「重新读取」、公告大框里什么按钮都没有。`formatAnnouncementLoadError` 给这种情况记上
  `collectionUnreadable`，新增 `announcementErrorOffersSite`（公告太大、合集读不出来这两种指去官网的才给），
  小框里「重新读取」和现成的「打开官网查看完整公告」并排摆，大框里把官网按钮也摆出来；公告太大时小框照旧只给官网按钮，
  只说「暂时没读到」的照旧只给「重新读取」。没有新字。`app-check.mjs` 加一条浏览器回归，小框、大框两处都点到官网。
- 聊天页右上角「参数设置」左边加一颗「看做过的图」图标按钮（Fable 第二轮 Q4，产品负责人回「素材库放开」「看图改」）：
  只调画布那半给的 `openCanvasAssets()`（#1737 的 `canvas:open-asset-library`），不另开通道；打不开走
  `perform('打开素材库', …)` 的错误框。`ChatPage` 的 `onOpenAssets` 缺省 = 不出这颗按钮。视频剪辑页不加：
  视频不在这个素材库里。
- Fable 第二轮 Q7：聊天页「常用的话」。`ChatWorkspace.phrases` 存在这个账号的聊天记录索引里（写盘前同样脱敏），
  最多 30 条、一条最多 2000 字（`ai-chat-protocol.ts` 的 `AI_CHAT_PHRASE_LIMITS`，聊天页和主进程共用）；索引里这一项坏了只丢坏的那几条，
  不连累聊天记录；「重新读取」时这一回存的并到前面。弹窗在 `features/chat/PhrasesDialog.tsx`，「填进输入框」只填不发，输入框写了字就接在下一行。
- 「搬到新电脑」的文件多一项 `phrases`（没存过就不写），版本号不变：旧版本导入时不认识这一项、照常导入其余的；主进程导出、导入都按同一上限挡住
  不成样的文件，聊天页合并时接在本机原有的后面、不重复、存满不再加。导入导出的提示文字没改。
- Fable 第二轮 Q2 第 1 步：新通道 `chat:pick-text-files`（契约、preload、注册、`ipc-channel-policy.ts` 四处一起加，
  成功不记日志）。主进程开系统选文件框、按扩展名只认文字类文件，`bounded-file.ts` 新加的 `readBoundedFilePrefix`
  按 `readBoundedFile` 同一套检查（单链接普通文件、不经过链接、读前读后快照一致）只读开头 256 KB，
  `ai-chat-text-files.ts` 解码（UTF-8 / 带 BOM 的 UTF-16 / GB18030，带 NUL 的当成不是文字）、按 3 万字的额度
  先保全短文件再均分给长文件，有一个读不出来整批不加。渲染层只拿到文件名、大小和字，拿不到路径（I15 同一思路）。
- 渲染层：`state.ts` 的 `messageWithFiles` 把文件用 `<file name="…">` 标记拼在这条消息前面发出去，
  前文、提醒和上限都按拼好的算；输入框的字数上限减去文件占的（`draftTextRoom`），选文件前先算还能放多少
  （`draftFileRoom`）。生成图片时带不了文件，按钮不出、留着的文件卡片下面说明并灰掉发送。文件存进本机聊天记录时
  名字和内容照样打码，导出对话只写「附件：文件名」。PDF、Word、Excel 要加解析库，放第 2 步。
- Fable 第二轮 Y1（产品负责人 2026-11-10 北京回「示例改」）：聊天空白页示例从三句换成六句，拿掉「用大白话解释什么是
  API 密钥」；列表挪进 `chat/state.ts` 的 `chatExamples`，带「……」的半句话填进输入框时由 `chatExampleDraft` 去掉
  末尾省略号、光标停在末尾。点了照旧只填不发。
- Fable 第二轮 Y2（产品负责人 2026-11-11 北京回「改名置顶改」）：对话「…」菜单加「改名」「置顶 / 取消置顶」。`state.ts` 加
  `renameConversation` / `setConversationPinned` / `groupConversationList`（置顶的单独一段，其余照旧按天分）、
  `MAX_CONVERSATION_TITLE_LENGTH`（40）；改名不动 `updatedAt`，自己起的名字记成 `renamed`，消息删光后再发不被第一句话盖掉。
  `pinned` / `renamed` 存在本机聊天记录里，`storage.ts` 读的时候只认 `true`。
- Fable 第二轮 Q6：设置里加一个默认关的开关，开着时星芒往 Claude Code 用户级 `settings.json` 写
  `permissions.blockWritesOutsideWorkingDirectories: true`（Claude Code 2.1.314 起有，2.1.319 在云端沙箱用 `env -i` 加假接口试过：
  项目外的新建、Edit、`/tmp`、`~/.claude/CLAUDE.md` 都被拦，读不拦，终端命令不拦，`--add-dir` 加进来的文件夹照常能写）。
- 跟 D5 那两项一样记成「星芒填的」（`ClaudeFilledDefault` 多一项，记进 `xingmang-claude-foreign-settings.json` 的 `filled`）：
  关掉开关、开关关着时接当前账号 merge、切回官方账号，都只撤记下的而且值还是 `true` 的；客户自己写过这一项（任何值）都不动。
- 新通道 `config:set-claude-write-boundary`（`config-save-service.ts` 的 `setClaudeWriteBoundary`）：在配置写锁里先看 Claude Code
  是不是接着当前账号、配置归当前账号，是才当场改（改前照保存配置那样做一份 `pre-save` 备份，`executeFilePlans` 两段提交），
  不是就只记开关（`later`），以后星芒保存 Claude Code 配置时 merge / reset 按 `seededFor` 里的 `claudeWritesInsideProject` 补上或撤掉。
  改配置失败开关不记。开关存在 `AppSettings.claudeWritesInsideProject`，`settings:save` 不收这一项。
- 界面：`registry/business.ts` 的设置项 `claude-write-boundary`（工具管理，工作文件夹下面）；拨完的小提示按主进程回的
  `written / unchanged / kept / later` 说（`claudeWriteBoundaryNotice`）。
- 新手引导第一步多第六个「做图、做视频」（Fable 第二轮 Y3，产品负责人回「定位做」）：`GuideRoute` 加 `'create'`，
  要装工具的那几条收成 `GuideToolRoute`，原来按 `route !== 'chat'` 判断「要装工具」的地方都改用 `isGuideToolRoute`。
  它跟聊天一样不装工具：点「下一步」时登录了就走完、`onComplete(..., 'video')` 进视频剪辑页；没登录先去登录，
  登录以后引导会按新账号重开，所以 `App.tsx` 用 `guideCreateAfterLogin` 记着，等会话换成登好的账号再走完
  （登录回调那一刻的 `navigate` 还当没登录）；登录框关掉没登就作罢。历史账号用不了视频剪辑，不给这一项
  （`createAvailable`）。进度只认它停在第一步。
- 欢迎页底下第三张小卡片「用量随时能对账」换成「不止写代码 / 聊天、出图、画布、视频剪辑，用的是同一个账号。」，
  大字和下面那句不动。
- Fable 第二轮 Q3 价格表那一半：新通道 `account:get-price-list`（契约、preload、注册、`ipc-channel-policy.ts`
  四处一起加，成功不记日志），主进程读画布「预计约 $x」同一份 `/api/pricing`，`parseModelPricing` 多留
  `model_ratio`、`completion_ratio`、`enable_groups`，`account-price-list.ts` 换成每个模型在各分组的价：
  按 token 计的 `model_ratio × 2 × 分组倍率` 美元每百万（同 `usage-pricing-parser.ts`），输出再乘
  `completion_ratio`；按次的写每次多少；分档计价的只标出来。能力表加 `supportsPriceList`（只有星芒账号），
  历史账号不出这一段。渲染层「调用明细 | 生成任务」切换多一段「价格表」，头一回切过去才读，读不到给「重试」，
  顶部搜索「价格」「哪个贵」落到这一段。模型菜单里的一句话说明要服务端先在价目里填 `description`，没做。
- Fable 第二轮 Y4、Q5：`registry/tutorials.ts` 加 `editor`、`undo`、`phone-remote` 三章，手机遥控的按钮落到设置里
  「手机遥控 Codex」那张卡（`TutorialSettingsRow` 加 `codex-remote`），卡片图标 Braces / Undo2 / Smartphone。
  Claude Code 2.1.318 起不再在编辑器终端里自己装插件，`editor-claude-login-prompt.ts` 的注释和
  `docs/CLI-VERIFIED-VERSIONS.md` 那一行跟着改。「把额度用在别的软件里」那一章等密钥页的接口地址合了再加。
- 日志和上报深查 R1（严重）：renderer-v2 `FailureBoundary` 把 React 组件栈截到 1500 字塞进 `context`，主进程
  `parseRendererError` 的 `context` 上限是 256，真界面每次都超，整条被拒：本机日志只剩一行「渲染进程异常上报失败：
  错误上下文格式错误」，`onRendererError` 不执行，Sentry 收不到。新增 `features/app/failure-report.ts` 的
  `buildFailureBoundaryReport`：组件栈从抛错的那层往外按整行保留、压到 256 以内（标签 `renderer-v2 error-boundary`），
  单行超长就截断；消息为空、抛的不是 Error、带 NUL 时也给出主进程收得下的报告。主进程上限不放宽（I5）。
  组件栈没并进 `stack`：`crash-report.ts` 会把形如 `at X (url:行:列)` 的行解析成堆栈帧，混进去会把组件帧当成调用帧、改变 Sentry 分组。
- 0.2.24 深查改字 Z12（W56 W66 W67 W68）：`runtime-log-filter.ts` 的 `external-clients` 通道归「桌面客户端」并进排序表（`mcp` 仍是「外接工具」）；`FeedbackPage.tsx` 联系方式占位、附带报告开关（含开关的 aria-label）、预览链接、预览框隐私提示四处换字。测试里写死的字跟着改。用户行由协调者统一补一条合并的。
- D61（`0.2.24-深查/汇总决定单.md`，出处 `日志和上报.md` R6 后半、R12）：反馈报告「运行环境」段在「运行权限」下面加
  「错误报告：开/关」「匿名使用统计：开/关」两行，报告开头 UTC 那行「生成时间」下面加「生成时间（本机）：2026-11-09 14:05:03 +08:00」
  这样一行。字和冒号照单子逐字；每条日志的时间照旧是 UTC，好跟 Sentry 和服务端日志对。
- 两行开关写的是这次运行真发不发：问的是两个上报器每次发之前问的同一个函数（`main.ts` 抽出的 `crashReportingEnabled`
  和 `usageStatsEnabled`），开发版、本机快包、CI、设了关闭变量的，设置里开着也写「关」。`usageStatsEnabled` 原样挪到
  `diagnostics.attachFeedbackDescribers` 之前，报告接上时它已经在。
- 本机时间由 `runtime-log.ts` 的纯函数 `formatFeedbackLocalTime` 给出，偏移量可以单独传，测试不跟跑测试那台机器的时区走。
  R6 前半（发成功记事件编号）不在这条里。
- 0.2.24 给客户看的更新说明由产品所有者 2026-11-18 定稿为上面 6 条：原先 60 条太长、解释太细，别的分片的「## 用户」
  全部清空，「## 开发」一个字没动。`scripts/changelog-collect.cjs` 新增 `assertUserNotesNotFinalized`：目录里有
  `final-user-notes.md` 时，`changelog:check` 和 `changelog:collect` 都拒绝别的分片再带「## 用户」，以后合进来的改动只写
  「## 开发」；汇总时这个分片随别的一起删掉，下一版恢复照常。写法见 `changes/unreleased/README.md`。
- 外接工具的附加参数在主进程照原样收，不再去首尾空格、不再把 `""` 占位参数当格式错误拒掉（表单 F10-a）。
  `electron/ipc/parsers/extensions.ts` 的 `mcp:add` 和 `extensions:mutate` 两路改用自己的 `mcpArguments`，
  查的跟下游 `provider-extensions.ts` 拼命令时一样：类型、最多 128 条、每条 4096 字以内、不含 NUL；
  参数照旧排在命令行 `--` 后面、不经 shell。插件市场的 Sparse 路径仍走 `stringArray`，行为不变。
- 0.2.24 深查「查表单输入校验」F10-b：个人中心「每个工具的额度上限」框打成「-」「1e」这种半截数时，
  数字框交出来的值是空的，以前当成留空，一点「保存」就把上限改成不限额、还提示「额度上限已保存」。
  现在点保存那一刻现读框的 `validity.badInput`（`features/account/ToolKeyLimits.tsx`；从空打成「-」值没变、
  onChange 不来，所以不能靠 onChange 记），是半截数就交给 `parseManagedCliKeyLimitAmount` 报现成的那句
  「请填写大于 0 的上限金额，留空表示不限额。」，不发保存（`electron/account-key-quota.ts`）。真留空照旧是不限额。
  不加新字、不加新通道；用户可见条目已满 60 条，这件不另写用户条目。
- 微信扫码登录时手机上那串数字认全角数字了（表单 F10-c）：`electron/codex-remote-weixin-login.ts` 的
  `normalizeWeixinVerifyCode` 先把全角数字换成半角再认，跟两步验证码 `parseTwoFactorCode` 一样；字母、横杠、
  别的文字的数字照旧不收，界面文字不变。以前中文输入法全角状态下打的数字会报「请输入手机微信上显示的数字」。
- 聊天页生图的自定义尺寸填得不合型号规矩（宽或高不是 16 的倍数、超出范围、删空）时不再发送，尺寸框下面说清规矩，
  跟画布同一句「这个型号的宽和高都要是 16 的倍数，并在 256 到 4096 之间」（即梦的上限按型号表写 1024）；离开尺寸框或点发送时才露出来，
  改对了就收起，免得打字时那一行跳来跳去。以前也没发出去（界面和主进程都会在本机按型号拦下），只是红条笼统地说
  「当前模型不支持这个图片尺寸」，不说该填多少，而且要点了发送才知道。规矩那句从 `canvas-scene-tasks.ts` 挪进
  `ai-chat-protocol.ts` 的 `describeImageSizePolicy`，画布和聊天共用；`imageSizeFits` 收拢了 `normalizeModel` 里那段判断。
  主进程 `chat:generate-image` 本来就在解析密钥、发请求之前按型号核尺寸，补了一条测试钉住。（表单审查 F5）
  用户更新说明已满 60 条，这条只记开发侧。
- 外接工具「自定义连接」的「启动命令」里填了整行命令、交给工具时会拆出参数的，框下面多一行灰字「已经帮你把后面的参数分出去了」
  （表单输入校验审查 F6，接 #1846；`launchCommandSplitsArguments`，`mcp-paste.ts`）。框里填的字照旧不动，只带引号的一段路径
  没有参数可拆、不出这句。`buildLaunchCommand` 能拆的再加两种：第一段只是一个名字、不带 `\` `/` 的（`my-server --stdio`，
  以前只认 npx、uvx、node 这类），和第一段写到 `.exe`/`.cmd`/`.bat` 的完整路径（`C:\tools\server.exe --stdio`）。没加引号的
  `C:\Program Files\…\node.exe`、`D:\node tools\x.exe`、`/usr/local/bin/x --stdio` 这种第一段只是路径前半截或分不清的照旧原样交。
  没加 IPC，主进程对命令和参数的检查不变。
- 技能文件夹名带中文、空格、括号（「写作助手」「my-skill (1)」）不再报「Skill 目录名包含不支持的字符」，落地时换个名字存进去
  （表单输入校验审查 F7）：先按 SKILL.md 里的 `name`，没写或转出来是空的再按文件夹名，都转成小写英文字母、数字加 `-`
  （全角字母、带音调的字母先换成普通字母，最长 64 字，碰上 `con`、`nul` 这类 Windows 设备名就跳过）；全是中文、转不出字的，
  用文件夹名算一个固定的 `skill-` 加 8 位短码，同一个文件夹再导一次落在同一处、照旧报「已存在」，不同的中文文件夹也不会撞到一起。
  本来就合规的文件夹名原样用、不读 SKILL.md，行为不变；换出来的名字照旧过 `SKILL_DIRECTORY_PATTERN`，越界检查、已存在检查、
  复制时逐个文件的检查都不动。「已存在」报的名字跟列表上显示的一致（SKILL.md 的 `name`，没写才是文件夹名）。
  Codex、Claude Code、Grok 三家都走 `skillImportTarget`，一起生效；没改界面文字（`buildRenamedSkillDirectoryName`，`codex-extensions.ts`）。
- 深查 D-1：`git-runtime-install.ts`、`python-runtime.ts` 的安装包下载去掉从开始就算的 10 分钟总时限，
  改用 Node.js 那边的「3 分钟没有新字节才停，30 分钟兜底」。这套计时从 `node-runtime.ts` 的
  `createNodeDownloadDeadline` 挪到 `download-retry.ts`，改名 `createDownloadDeadline`，到点的那句由调用方给，
  三处各自沿用原来的说法（Node.js「安装包下载超时」、Git「下载超时」、Python「Python 安装包下载超时」），
  界面上的字不变。单次请求 45 秒没数据仍由 `downloadWithResume` 先接着下；Windows 上装 Claude Code 顺带装 Git，
  以前网速低于约 110 KB/s 时两个源都要到点作废，现在能下完。新增 `slow-download.test-support.ts`，用假时钟
  把慢速下载走真的续传函数：Git 14 分钟下完、两个源各到 30 分钟才放弃且报错原样；Python 同样两条（只在 Windows 跑）。
- 0.2.24 深查「反复切换」N3：Grok 切回官方账号时 `removeGrokRelayConfig`（`config-files.ts`）只删 `base_url` 跟传进来的
  线路地址逐字相同的模型表和 `endpoints.xai_api_base_url`。对话表、出图地址、多出来的表停在这个站另一条线路或退役别名上时
  原样留着，界面说切好了、`officialProviders` 也记成官方，Grok 却还在走中转。现在逐字相同之外，再按
  `relayProviderBaseUrlMatches('grok', …)` 认这个站的每条线路和别名（不跨站，别的站和客户自己的地址照旧不碰）。
  整份配置停在另一条线路这种最常见的情况，main 上早已由 `providerRelaySite(provider, current, true)` 按配置自己那条线路删干净，
  这次补的是几处分别停在不同线路上的情况。用户更新说明满 60 条，只写这一段。
- 接当前账号时替 Grok 写 `[features] video_gen = false`，关掉两个做视频工具（`image_to_video`、`reference_to_video`）：
  中转回的是 xAI 自己的视频地址，Grok 在客户电脑上直连下载，`x.ai` 在国内连不上，一条视频扣了钱却拿不到片。
  新模板、合并保存、老客户开机补缺省项（`relayTemplateRevision` 升到 8）三条路都写，客户自己写过这一项就不动，
  切回官方不收回。沙箱对 Grok 1.0.77 实测两个视频工具不再出现、不发视频请求，画图照旧（`docs/CLI-VERIFIED-VERSIONS.md` 的 K5）。
- 检查页 PROXY_ENVIRONMENT（yoyo 11-06「体检改」）：Mac、Linux 原来走 `otherProxySettingsOutcome`，只数进程环境里设了几个
  （连 NO_PROXY、FTP_PROXY 也算），代理开着也是 warn，详情列「HTTP_PROXY (process)」。改成三个系统都走同一个
  `proxySettingsOutcome`（原 `windowsProxySettingsOutcome` 改名）：指向本机的先试连，开着 pass、没开 warn「从星芒打开的工具会
  自动绕开它」、指向别的机器 warn，用的都是 Windows 现成的三句；`readScopes` 只有 Windows 给，Mac、Linux 不给「清掉这条旧设置」。
  `DiagnosticsDependencies.inspectProxyVariables` 和 `ProxyVariableSummary` 随之删掉，测试改注入 `probeLoopbackProxy`。
- 装工具时 npm 的环境 Mac 上也过 `withoutDeadLoopbackProxies`（`cli-install-service.ts`）：从终端启动或 launchctl 里设过时，
  星芒自己的环境里带着代理，没开就一样装不上，检查页那句「会自动绕开」要对装工具也成立。打开工具那一半 Mac 上原本就由
  `buildMacosClosedProxyGuard` 管。照系统代理替 npm 补上的那几条（`resolveSubprocessProxyEnvironment`）三个系统都单独再判一次：
  代理软件关了、系统设置里还勾着本机端口时交给 npm 的也是连不上的地址，而且它排在后面会盖过环境里那几条。日志
  `proxy-env.bypassed` 对这一种多带 `from: 'system-proxy'`，好分清来源（Mac 真机安装日志里见过 ECONNREFUSED 127.0.0.1:7890，
  来源没定位）。
- PROVIDER_ENVIRONMENT_OVERRIDE：实测盖不过写入配置的那几个（`breaksAccount: false`：ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN、
  OPENAI_BASE_URL、OPENAI_API_KEY，以及指到别处的 CODEX_HOME）不再报 warn「可能会盖过当前账号的设置」，改成 pass「电脑里另外设的
  工具地址或密钥盖不过当前账号的设置，不影响使用」；Windows 上只剩这种时也就不再给「删掉这几项设置」。2026-11-06 用 Codex 0.164.0、
  0.166.0、0.167.0 和 Claude Code 2.1.310 对本地假接口重测过：环境里设了这几个，请求照旧发往写入的地址、带写入的密钥。
  pass 时变量名改放 `details.reportOnlyVariables`（`diagnostic-details.ts` 没给它中文名，检查页不上屏，导出报告里照旧有），
  原来「已指向当前账号」那种 pass 也一样；有会绕开当前账号的变量时详情照旧逐个列 `variableN`。
- 0.2.24 深查 UI 字表 W2 W3 W33 W61（批次 Z08，yoyo 11-10「按照你的推荐做」）：`HealthPage.tsx` 页头按钮按
  `diagnostics.length > 0` 在「开始检查」「重新检查」之间切，空状态那句跟着写「开始检查」（重查时上一轮结果还摆着，名字不跳）；
  连接自检说明「外部客户端」→「桌面端」；`diagnostic-details.ts` 的 `managed` 中文名「由本软件写入」→「由星芒写入」；
  `diagnostic-folder.ts` 打不开那句「重新打开本软件后再试一次」→「重开星芒后再试一次」（视频剪辑「打开文件夹」共用这句）。
  测试里写死的字一起改；`app-check.mjs` 里点页头按钮那条改成限定在页头里找，免得装了 Codex 时和「Codex 干活检查」的
  「开始检查」撞名。
- 检查页 D33（汇总决定单批次 Z20，代理.md PX-10，yoyo 11-11「决定单照推荐」，字照决定单原文）：`proxySettingsOutcome` 在本机代理
  没开、桌面端也看得见这条设置时（Windows 当前账号下那一条，或读不到设置；Mac 一律算看得见；Linux 没有 Codex 桌面端，不标）给
  PROXY_ENVIRONMENT 的 details 加 `reachesDesktopApps: true` 和 `port`；`reconcileProxySettingsWithDesktop` 在全部查完后对着
  CODEX_DESKTOP 那一项，装着就把结论换成「……从星芒打开的命令行工具会自动绕开它；Codex 桌面端这类桌面软件绕不开，会连不上，
  要把这条旧设置清掉。」，「清掉这条旧设置」照旧给。Windows 上两边都读到了、都没有的（这一次启动星芒时带进来的，资源管理器
  打开的桌面端看不见）和整台电脑那一条（决定单没给说法）照旧。两项同时跑，放在结束后对，不为它多探一次桌面端。
- 检查页 D34（代理.md PX-9）：Mac 上没看到另外设的代理时不再说「没有另外设过代理」，改说终端设置里的代理星芒看不到、工具会用它；
  `proxySettingsOutcome` 多一个可选 `platform`，不给照旧。
- 检查页 D56（时间数字格式.md N-6）：「星芒 AI 网络」系统时间差的那句换成 `clockSkewSummary`：不到 1 小时说分钟、不到 2 天说小时、
  再多说天，说清快了还是慢了；离 1~23 个整小时不到 5 分钟时补「多半是时区设错了」。`details.clockSkewMinutes` 照旧。
- `features/tools/recent-display.ts` 的 `formatRecentTime` 不再把 `updatedAt` 乘 1000：主进程 `provider-sessions.ts` 给的记录时间本来就是毫秒（`timestampMilliseconds` / `statTimestamp`），
  再乘 1000 落到几万年后，`formatCalendarTime` 的日历差 ≤ 0，全写成「今天 + 错的钟点」（0.2.22、0.2.23 都有）。记录页走的 `RelativeTime` 一直按毫秒读，不受影响。
  `recent-display.test.ts` 的夹具改按毫秒写，并加一条「上周的毫秒时间写日期、不写今天」的回归（改前 5 条红）。0.2.24 全面检查 K2。
- 下载注册页（`dl-landing/`）的老版紫光四角星换成 v3 深蓝金色星芒，跟装好以后看到的程序图标一样：`logo.png` 换成 `assets/brand/v3/favicon.ico` 里 256px 那张，标签页图标改用同一份 `favicon.ico`（原来是那张 270×269 的黑底图），四处引用都加 `?v=brand-v3`，免得 CDN 接着给老图；`scripts/dl-landing-install-guide.test.cjs` 核对两张图跟品牌素材逐字节一致（图标审查 IC-11）。页面配色和文字没动。只改仓库，要把 `index.html`、`styles.css`、`logo.png`、`favicon.ico` 传上下载站才上线。
- 图标审查 IC-9：Mac 安装包打开后的窗口换成品牌深蓝背景，顶上一行「把星芒拖到右边的「应用程序」文件夹，再从启动台打开」，
  右边的替身从 `Applications` 改名「应用程序」，跟那行字对上；原来是 electron-builder 自带的灰底虚线箭头，一个字没有，
  小白常直接在窗口里双击打开。背景 `build/dmg-background.png` + `@2x`（`scripts/generate-dmg-background.mjs` 画，
  字用思源黑体转成轮廓存在 `build/dmg-background-hint.svg`），图标坐标、图标大小（96）和替身名字收在
  `scripts/macos-dmg-layout.cjs`，`electron-builder.config.cjs` 的 `dmg` 读它，本地包和免费渠道都生效。
  两个图标垫在奶白底板上：用了自定义背景后 Finder 一律用黑字写图标名字，压在深蓝上看不清。
  `verify-macos-free-artifacts.cjs` 挂载 DMG 时多查一条「应用程序」替身指向 /Applications，替身名没生效就出包失败。
  更新说明用户条数已满 60，没写「## 用户」。
- 深查 IC-2（查图标和图片素材）：聊天、视频剪辑的模型按钮和 AI 回复头像，按模型名认厂商的那份前缀（`ui/brand.tsx` 的 `modelBrand`）
  补齐到跟模型菜单分节（`features/chat/state.ts` 的 `vendorPatterns`）一致：`dall-e`、`sora`、`o` 加任意数字画 OpenAI，`imagen`、`veo`
  画 Gemini，`qwq`、`qvq` 画通义，`cogview` 画智谱，`abab`、`hailuo` 画 MiniMax，以前这些都是问号圆圈。只用仓库里现成的厂商标，没加新图；
  即梦在 `vendor-icons.tsx` 里没有现成的标，仍是问号。`components.test.tsx` 加一条：菜单归到某家的模型，图标必须画那一家的标。
- 深查 IC-6（查图标和图片素材）：充值页和买套餐弹窗的付款方式，没有现成标志的渠道（QQ 钱包、Creem、Waffo 这类）以前画问号圆圈，
  现在画中性的银行卡（lucide `CreditCard`，跟「余额支付」那颗钱包一样大）。支付宝、微信支付、Stripe 照旧画自己的标。报告建议 QQ 钱包用
  simple-icons 的 QQ 标，这次没加：不新加第三方商标图，QQ 钱包也画银行卡。不改字。`AccountRecharge.tsx` 导出 `PaymentMethodIcon`，
  新加 `AccountRecharge.test.tsx` 钉住三家画自己的标、其余渠道不画问号。
- 0.2.24 深查 R1：`account:sync-managed-cli-keys` 里的画图技能同步每次开机都给 Codex、图片两把 Key 各调一次
  `POST /api/token/:id/key` 取明文，这个接口按出口 IP 跟登录、续登录共用 CriticalRateLimit（默认 20 分钟 20 次）。
  现在 `provisionCliKey` 多收一个可选的 `knownKeys`：从最新列表里挑出来复用的那把在里面、明文又跟列表里这条的掩码
  对得上（`knownCliKeyForRecord`），就直接交回缓存的明文；挑出来的是别的、掩码对不上或认不出，照旧取明文。挑哪把、
  额度上限用完照旧停下、`fresh` 照旧新建，都没变。
- 明文来源只有本机加密缓存 `managed-cli-key-store.ts`：工具那几把，加上新加的 `skillKeys`（技能上次写进配置的
  Codex、图片两把，按账号记，跟 `groupCheck` 一样只改这一项、不加 revision，内容没变不写；撤销时一起拿掉；
  认不出的条目当没记过，不连累整份缓存）。只认当前站点那份缓存，账号中途换了不记。
- 技能的 `config.json` 内容跟这次一样就不再原子重写（以前每次开机两份都换一遍，同步盘每次都要再传）。
- 给客户看的那句并进了 `cli-verified-2026-11-09.md` 的「## 用户」（一版最多 60 条）。
- 生图技能（`bundled-skills/xingmang-ai`）升级：默认链 `gpt-image-2.6-flare → 2.5-flare → 2`，备选 `2.6-sunburst → 2.5-sunburst`，去掉 `gpt-image-1`；
  主进程（`xingmang-ai-skill.ts`）登录同步时把账号列表里有的整串写进 `config.json`（`model` + 新字段 `fallbackModels`），
  两个脚本默认模型失败按它依次往下退，只退到账号有的；老配置没有 `fallbackModels` 照旧只退到 `gpt-image-2`。
  AI 对话的 `DEFAULT_IMAGE_MODELS`、`IMAGE_GROUP_MODEL_ORDER` 跟着同一个顺序，测试钉住三处一致。
- `generate.mjs` 失败不再直接 `process.exit`（Windows + Node 24 上 fetch 句柄没关完会打 libuv Assertion、退出码 127），改成 `exitCode = 1` 正常退出；
  成功后 stderr 打「已用 <模型> 出图」，stdout 仍只打路径；超时管到读完响应体。
- 两个脚本点名可用 Nano Banana（`nano-banana-2` / `gemini-3.1-flash-image`、`nano-banana-pro`，走 `/v1beta/models/{model}:generateContent`，`x-goog-api-key`）
  和 Grok（`grok-imagine-image*`，Images API + `response_format: b64_json`，实测只出 1280x720、不传尺寸），只用图片模型分组 Key；
  认型号三处同步加 `GEMINI_IMAGE_MODEL_PATTERN`、`GROK_IMAGE_MODEL_PATTERN`。点名认不出或已下线（`gpt-image-1*`）的型号时报错列出能用的。
- 新参数：`--size 1K|2K|4K` 配 `--aspect`（换算成比例不变、16 倍数、总像素 655,360–8,294,400 的宽高），`--background`，多张 `--image`（`image[]`）；
  画图工具同样加 `aspect`、1K/2K/4K。默认画质 `low` 改成 `high`（实测 2.6-flare 三档各 3 张：low 25.9 秒、medium 27.5 秒、high 24.4 秒）。
- 生图技能（`bundled-skills/xingmang-ai`）里会被 AI 读到、转述给客户的字不再出现「星芒」和站点地址：技能说明、画图工具说明、
  「点名认不出型号」列表和出错提示的主语改成「当前账号」「管理工具」；`references.md` 不再写死 `xm.solov.cc`，改成用 `config.json`
  的 `baseUrl`（历史账号照它手写请求不再连错站）；示例输出名 `xingmang-cat.png` 改成 `cat.png`。客户没改过的技能文件下次登录同步自动换成新字。
- 名字不动：技能名 `images`、画图工具名 `xingmang-image`（改名会让客户在 Claude Code 里设的「每次先问 / 不许用」对新名字失效）、
  `.xingmang-managed.json`、旧文件夹「星芒AI」；画图工具的三个站点白名单和命令行脚本的兜底地址也不动。
  `scripts/xingmang-image-mcp.test.cjs` 新增一条钉住：两份说明不含「星芒」和站点地址，两个脚本不含「星芒」、站点地址只剩白名单和兜底那几个。
- 睡眠深查 G1：Mac、Windows 上主进程的计时器和 `performance.now` 睡着那段也算，睡着时到期的一醒全部补触发，所以装工具时合盖超过 3 分钟一醒就判「卡住」。新模块 `awake-deadline.ts`：每 15 秒看一次单调时钟，两次之间隔了 60 秒以上（或时钟往回跳）当睡眠，只记一个间隔进总时长，「多久没进展」从这一刻重新算；规则同 `updater.ts` 下载看门狗那套。用在三处：`createNpmDownloadStallWatch`（npm 解析和下载的 3 分钟卡住检测，量盘那一拍和量完那一刻都看表）、`download-retry.ts` 的 `createDownloadDeadline`（Node.js、Git、Python 安装包的 3 分钟卡住和 30 分钟兜底），以及 `runCommand` 新的可选项 `timeoutExcludesSleep`，`executeNpm` 的三步（解析 10 分钟、下载 30 分钟、装到本机 5 分钟）和 Node.js MSI / winget、Git、Python 安装程序的 15 分钟都打开它。时限的数没变，醒着的时间照旧有上限；计时器一直很晚才轮到时每拍仍记一个间隔，兜底不会永远到不了。Linux 的单调时钟本来就不算睡眠，结果不变。没改上屏文字。
- 给客户看的那一句并进了 `fable2-price-table.md` 的「## 用户」（一版最多 60 条，已满）。
- `electron/relay-sites.ts` 的站点表加可选字段 `invoicePortalUrl`（星芒账号 `https://invoice-xm.solov.cc/orders`、历史账号 `https://invoice-api.solov.cc/orders`，对应开票那边生产栈的 `INVOICE_PORTAL_ORIGINS`）。它只在软件里的开票窗口打开，不进外链白名单。
- 新增 `electron/invoice-portal-window.ts`：不挂 preload、sandbox、关 devTools，权限请求一律拒绝，导航、跳转只放行开票中心那一个 origin，新窗口一律拒绝，标题固定。开票中心的登录按账号各存一个持久分区（站点加用户编号的摘要），换人、退出时关窗口并清掉上一个人的分区。
- 下载发票只认开票中心页面自己的 `blob:` 地址、8MB 以内：先落到用户数据目录下的临时文件，按开头字节认 PDF、PNG、JPEG，再弹「保存发票」框，用 `writeAtomicSafeBinaryFile` 写到客户选的位置（I8）；哪一步不成都弹「发票没保存下来」那句。
- 新通道 `account:open-invoice-portal`（契约、preload、`ipc-channel-policy.ts`、`ipc/handlers/account-billing.ts` 四处）：入参为空，开哪个账号的开票中心由主进程按当前登录定，渲染层不给地址也不给账号。
- 界面上的六句字是 yoyo 2026-11-11 回「窗口改」批的原字（按钮、打开后的提示、窗口标题、打不开、保存框标题、保存失败框）。
- 反馈与客服页「复制给客服」挪到主进程复制（深查 33 张旧卡核对 J1）：以前页面先等主进程现生成反馈报告（慢的电脑要好几秒），
  再自己 `navigator.clipboard.writeText`；客户这几秒切去微信等着粘，窗口没了焦点，Chromium 拒绝页面写剪贴板，复制失败、
  客服窗口也不开，页顶只出一句通用的「操作没有成功」。现在 `runtime-logs:copy-feedback`（`copyFeedbackReport`）多认一种入参
  `FeedbackMessageCopyRequest`（留言类型三选一、描述、联系方式、身份行、最近一次出错、要不要附报告），主进程按
  `electron/feedback-message.ts` 的固定格式拼好、现生成报告、用 Electron 的 `clipboard` 写入，不看窗口在不在前台。
  入参由 `parseFeedbackMessageCopyRequest` 校验：只认这六个字段、类型只认 `bug`/`idea`/`other`、各段限长、拒 NUL；
  页面给不了报告内容，也给不了这个格式以外的东西，这条通道照旧不读剪贴板。报告生成不出来时照样复制客户写的，回
  `reportMissing: true`，日志里照旧记那一行 `runtime-logs:preview-feedback失败`。`buildFeedbackMessage` 从
  `FeedbackPage.tsx` 搬进 `electron/feedback-message.ts`（进渲染层可值引用名单），界面上的字不变。
- 自己粘贴的密钥是打码的那串（带 `*`、`＊`、`•`、`●`）时，页面和主进程都直接说「这是打码后的密钥，请到「密钥」页点复制按钮，复制完整的那串」（深查 J7 后半）。
  以前从「密钥」页选中复制的 `sk-前4位**********后4位` 正好过得了星芒密钥 sk- 开头、20 位以上的检查，送到服务端才回 401「无效的令牌」，客户以为密钥坏了。
  页面 `manualKeyIssue` 在 sk- 检查之前先认打码；主进程 `models:list` 不拿它去问服务端，`config:save`、`config:configure-external-tool` 不写进配置（旧界面不查格式，也靠这里挡）。
  `electron/pasted-api-key.ts` 新增 `isMaskedApiKey` 和两句文案。粘贴的密钥格式不对时主进程那句「API Key 格式错误」改成「密钥格式不对，请重新复制完整的密钥」
  （`fetchAvailableModels` 一处、`config:save` 两处、`models:list` 一处）；托管密钥、聊天密钥本地存档损坏的那几句不是粘贴的事，没动。两句新字 yoyo 11-13 批过，没加 IPC 通道。
- 自己粘贴的密钥在查格式、检测模型和保存前先去掉夹着的空格和零宽字符（深查 J7，新增零依赖的 `electron/pasted-api-key.ts`）。
  以前页面和主进程都只去首尾空白：折成两行的密钥粘进单行框，中间的换行被 Chromium 换成空格，格式检查放行、存进工具后服务端回 401；
  飞书、网页复制来的零宽空格在开头时星芒密钥报「应以 sk- 开头」，在别处时检测模型直接抛英文 ByteString 报错。
  页面 `manualKeyIssue` 和主进程 `models:list`、`config:save`、`config:configure-external-tool` 去掉的是同一批字符；
  Tab、换行这类控制字符不去，照旧整串拒掉；只有零宽字符的输入不会变成 `config:save`「沿用已保存的那把」。没改界面文字，没加 IPC 通道。
- 强制更新那层提示（`RequiredUpdateGate` 的 `GateDialog`）连按三下 Esc 就关掉了，底下必须更新的旧版本照常能用，要重开软件才盖回来（0.2.24 深查 键盘无障碍 KB-1）。原因是 Chromium 只让网页连着拦两次 `<dialog>` 的 cancel，第三次 `cancelable` 为 false。现在在 document 上拦 `keydown` 的 Esc（焦点掉出门外也拦得住，比如门里按钮转圈变灰时），叠在门上的帮助框自己处理的 Esc 不碰；再听 `close`，万一还是被浏览器关了就立刻 `showModal()` 回来。没加字。
- `testing/app-check.mjs` 补一条：焦点在门里、掉到页面上各连按 6 次 Esc 门都在，帮助框照样按 Esc 关，背着程序 `close()` 后门马上回来。旧代码上红、新代码上绿。
- 深查 KB-2（`0.2.24-深查/键盘无障碍.md`）：弹窗忙着时按钮变灰，焦点掉到弹窗外，`Dialog` 自己的 keydown
  收不到 Esc，Chromium 连拦几次 cancel 后就把 `<dialog>` 关了，React 还当它开着。`ui/modal.tsx` 在 document 上补一道
  Esc：只在焦点不在任何 `dialog[open]` 里时、只给最上面那个框，有不是 `Modal` 开的模态框（强制更新层）在时不管；
  `<dialog>` 背着 React 关了就立刻 `showModal()` 回来（祖先被藏起来时不开）。不改字。浏览器测试连按 6 次 Esc 钉住。
- 密钥页名称框（`pages-account.tsx` 的 `changeName`）截名字后不再用 `requestAnimationFrame` 挪光标，改成当场把截过的名字写回输入框再
  `setSelectionRange`，React 随后核对时值已相同、不再改写。以前打满 16 个字后被拒的那一下排了一个「光标放回原处」的下一帧回调，
  紧接着按 Home、→ 时它才跑，把光标拽回末尾；`e2e/v2-business.test.mjs` 的「a Chinese key name stops at 16 characters…」因此偶发红
  （本机改前连跑 12 次红 4 次，改后单跑 30 次加三路并行 30 次全绿）。界面字不变。
- 星芒账号密钥名称超长时的报错统一成 yoyo 11-10 批的那句（「名称超长改」），放在 `catalog.ts` 的 `accountKeyNameTooLongMessage`，
  `new-api-client.ts` 的 `validateKeyEditorInput` 和 `ipc/parsers/account-keys.ts` 的 `parseAccountKeyCreateInput` 共用。原来前者说
  「不能超过 50 个字符」（站点数的是字节，中文其实只能 16 个字），后者把超长和别的毛病一起报成「密钥名称格式错误」。入参检查的超长判断挪到
  `requiredString` 前面，英文超 50 个也报新句；不是字符串、空的、带 NUL、两头空格撑过原始长度的照旧报「格式错误」。能存的名字没变：仍按
  UTF-8 50 字节，历史账号的 100 和说法照旧。名称框本来就打不进超长的字，客户平时看不到这句，所以没写「## 用户」。
  冻结的旧界面 `KeyEditorDialog.tsx` 那句不动。出处 `0.2.24-深查/Fable复查.md` 第二节第 9 条。
- 星芒账号（new-api）的密钥名称按 UTF-8 字节数限 50（`controller/token.go` AddToken / UpdateToken 的 `len(token.Name) > 50`），
  手填这条路以前按字数数：输入框 `maxLength={50}`、`ipc/parsers/account-keys.ts` 的 `requiredString(…, 50)`、
  `new-api-client.ts` 的 `validateKeyEditorInput` 都放行 17～50 个汉字，到站点才被拒。现在 `catalog.ts` 导出
  `utf8Length` / `truncateUtf8` / `accountKeyNameMaxBytes`，主进程两处改按字节；密钥页名称框用 `account-center.ts` 的
  `limitKeyNameEdit` 照 maxLength 的样子收一次编辑（只截这次新打或贴进来的那段，已有的字和光标不动），拼音输入法
  拼字期间不截、选完字再收。历史账号（sub2api）的 100 照旧。界面文字没有改。审查编号 ZW-1（0.2.24 深查·中文路径编码）。
- 外部链接 L4：OpenCode「去官网下载」（Windows 上缺系统 winget 时）的落点从 `https://opencode.ai/download`
  换成 `https://opencode.ai/desktop`。前者现在是 OpenCode 全部产品（桌面、命令行、手机、SDK）的总览页，
  后者只放桌面端各平台安装包。外链白名单经 `externalClientOfficialDownloadUrls` 收录，仍是同一个域名下的
  一条全等网址，条数不变、不加域名。上一版落盘的首页检测结果里带着旧网址的，读回来不认、等这次真的检测
  （`external-client-snapshot-cache.ts` 本来就只认白名单里那一条）。
- 外部链接 L6：错误框里「打开微软商店」打不开时，那句「没能打开微软商店，这台电脑可能没有它……」
  以前永远出不来：`useFailureActions.ts` 只等 `openExternal` 回 false，可 `external:open`
  成功只回 true、系统打不开时是抛错（Electron 的 `shell.openExternal` 直接 reject），没有商店的
  电脑（LTSC、精简版）只看到兜底句「打开微软商店没有完成」。现在抽成顶层的
  `openCodexDesktopStoreOrExplain`，用 try/catch 接住失败再说这句已有的中文；被主进程外链名单
  拦下的照原样报，不说成「没有商店」。外链名单和主进程的地址校验一条没动，不加新字。
  同类写法 `AuthFlow.tsx` 的「打开账号官网」没捆进来，另修。
- 发版：yoyo 2026-11-09 定「Linux先不发」。`publish-release.yml` 的 release-tag 判断那一步加了只关不开的
  `LINUX_PUBLISH_HOLD`：仓库变量 `XINGMANG_PUBLISH_LINUX` 开着、这次又选了 `all` 或 `linux` 时，在占 tag、
  出包之前就停下，发版改选 `both`。起因是 Ubuntu 22.04 / 24.04 上自动更新交给系统那一步推测装不上，要修好、
  真机点过再发。挂着等批准的 0.2.23 Linux 补发（运行 41408530433）同日取消。解除方法见 `docs/RELEASING.md`「Linux 开关」。
- 0.2.24 深查改字批次 P06（`UI文字和按钮.md` W47 W48 W49 W50 W51 W79 W80 W9 第四句 W14d，`汇总决定单.md` D36）。
  只改 renderer-v2 的 `features/auth/state.ts`、`account-errors.ts`、`AuthFlow.tsx`，legacy 冻结不动。
- D36（数据和迁移 DM-4）：`realm-account-vault.ts` 写账号库失败时用 `classifyStorageFailure` 只记下「是不是盘满」这一位，
  盘满换成 `realmVaultDiskFullMessage`（「账号安全存储不可用：磁盘空间不足，原记录未修改」），不挂原始错误；
  渲染层按这句前缀认出来上屏 D36 那句，别的写失败照旧走 W80 那句。日志里也能看出是盘满了。
- `macos-desktop-app-installer.ts` 的八处递归删除改走新的 `electron/remove-tree.ts`（Electron 里用 `original-fs`）。
  主进程的 fs 被 asar 层改过，`lstat('…/Contents/Resources/app.asar')` 答「是目录」，Node 的递归 rm 对它
  rmdir、把 ENOTDIR 当成已删，最后删 Resources 报 ENOTEMPTY。ChatGPT.app、Claude.app 都是 Electron 应用，
  于是 replaceBundle 留下的 `.ChatGPT.app.xingmang-<hex>` 删不掉，下一次更新在 `removeInterruptedCopies`
  第一步就失败（2026-11-06 yoyo 的 Mac 日志：`ENOTEMPTY … rmdir '/Applications/.ChatGPT.app.xingmang-e5fff230b53a/Contents/Resources'`）。
  挪开的旧版（`-old-`）和没放进去的暂存目录也一样删不净；暂存目录里留着解开的应用时，下一次 `createStagingDirectory` 清它同样报错。
  `remove-tree.test.ts` 在真的 Electron 里（ELECTRON_RUN_AS_NODE）复现原报错并核对新写法删得干净、不跟链接走。
- Mac 上不再说「托盘」（深查 TR-5、决定单 D30）：关窗询问框的按钮和说明（`window-presentation.ts` 的 `closeDecisionDialogText`）、
  设置 › 启动关闭「点关闭按钮时」的选项和说明、「开机自动启动」的两句说明（`platform/system-service.ts`），都改说「菜单栏」；
  第一次收起时的提示多说一句程序坞（带刘海的 MacBook 上菜单栏图标会被挡住）。Windows、Linux 照旧。
- Mac 应用名菜单加「检查更新…」，点了跳到设置里的版本更新；「设置...」的三个英文句点换成「…」（深查 TR-14、决定单 D31）。
- Windows 上开机启动项没被系统留下时（多半是 360、火绒拦了），报错改成叫客户在安全软件的提示里点「允许」再开一次，
  不再叫去翻系统设置；Mac、Linux 照旧（深查 AV-09 第 1 条、决定单 D26）。
- Mac「显示」菜单的实际大小、放大、缩小不再用 Electron 的 `resetZoom` / `zoomIn` / `zoomOut`（深查 TR-3）。
  原来点菜单改的是 Chromium 自带缩放：主窗口里不存、设置页不变、拖一下窗口又弹回去，「实际大小」回到 100% 而不是快捷键的「恢复自动」；
  画布窗口里 ⌘- / ⌘= 会把工具栏、文字整个缩放。现在三项自己接点击（快捷键照旧 `CmdOrCtrl+0` / `Plus` / `-`），
  主窗口在前时 `main.ts` 经新的界面事件 `window:ui-scale-shortcut`（`onUiScaleShortcut`，主进程发给主窗口，界面只收不发）
  交给界面，跟键盘走同一条「界面缩放」保存路径；画布、付款、开票窗口在前时不做事，跟 Windows 上没有这个菜单一样。菜单文字不变。
- Mac 上从星芒打开的 Grok、独立安装的 Codex 跑的是 `darwin-cli-staging.ts` 拷到临时目录里核过签名的副本。以前进程退出时
  把这些副本连目录一起删，下次打开又把上一个进程留下的目录全删，都不看终端里还有没有工具在跑它（0.2.24 深查 Mac M4）。
  现在退出时只删一次性用途的副本（`ephemeral`），交给终端的那份（`retained`）留着；下次打开清理上一个进程的目录时，先用
  `/usr/sbin/lsof` 按设备号和 inode 查有没有进程还在跑里面的程序，有就留到之后再清，查不出结果时也先不删。这次清理不再卡住
  第一次核签名和打开工具。
- Mac「卸载星芒」勾了「连同星芒替你装的命令行工具一起删」时，`removeMacManagedTools`（`electron/macos-uninstall.ts`）改用 `removeTree` 删
  `~/Library/Application Support/XingMangAI`（0.2.24 深查·装工具和更新 S-2）。装桌面端被关机、强退打断时 `DesktopApps/staging-*`
  里会留下解开的 `.app`，主进程的 fs 把里面的 `app.asar` 当成文件夹（#1573 同一个根因），整棵删除报 ENOTEMPTY，客户的 CLI 和 Node
  留在电脑上。新用例在真 Electron 里跑这个函数，旧代码上报的正是 ENOTEMPTY。界面字不变。
- Mac 上以 root 打开星芒（比如用 `sudo` 直接执行包里的程序）在 `platform/entry.ts` 最先拒绝，弹 Linux 那句
  「请用平时登录电脑的账号打开」就退出，不拿单实例锁、不读设置、不写日志（D18、PW-11）。判定在新的零 import 模块
  `electron/macos-launch-guard.ts`，字复用 `linuxLaunchRefusalNotice('root')`；`refuseLinuxLaunch` 改名
  `refuseLaunch`，两个平台共用。打开桌面客户端那处的 root 检查留作兜底，那句「请以普通用户身份重新打开工具箱…」
  换成同一句。只拦 root，`sudo -u` 替别的账号打开这次不拦（D18 只批了 root 那句）。
- 同类对比 备选 5：新通道 `extensions:copy-mcp`（`McpCopyInput { from, to, name }`，只带名字）。主进程用
  `ProviderExtensionService.readUserMcpConnection` 从来源工具「我的（全局）」那份原样读这一条（Claude Code 读 `~/.claude.json` 的
  `mcpServers`，Codex 读 `config.toml`），交给新的纯函数 `mcp-copy.ts` 的 `mcpCopyConfig` 换成添加那条路收的样子，再照手填添加走：
  装进 Codex 走 `addMcpServer`，别的走 `mutate`（`scope: 'user'`），命令、参数、地址、请求头照样过各自添加时那道检查（I1、I5）。
  环境变量、请求头的值不过 IPC（I3），界面本来也只拿得到名字。
- 搬不全的不搬：来源带着别的工具没有同样写法的设置（Codex 的 `bearer_token_env_var`、`env_vars`、`cwd`、超时、工具白名单，
  Claude Code 的 `oauth`、`headersHelper`、`sse` 类型等）、Claude Code 那种要它自己展开的 `${…}`、格式不对，都整条拒绝并说原因，
  不悄悄丢一截。项目里的连接不给搬（常跟着仓库走，搬进别的工具的项目配置等于把密钥写进仓库文件）；Grok 的连接列表不带环境变量和请求头，
  不当来源。
- 界面：`extensions-common.tsx` 的 `mcpCopyOffered` / `mcpCopyChoices`，`ExtensionsPage.tsx` 的弹窗 `mcp-copy`。打开时先问一遍别的工具
  有没有同名的（有就标「已添加」不给勾），装之前再问一遍；一次装一个工具，中途失败的话已经装上的标成「已添加」，再点只补剩下的。
- 0.2.24 深查 D5（反复切换 N7，2026-11-10 yoyo 批「按照推荐做」，改字修复批次 P03）：接当前账号时
  `skipClaudeCommandConfirmation` 对没设过的客户补 `permissions.defaultMode = "bypassPermissions"` 和
  `skipDangerousModePermissionPrompt = true`，切回官方（`createOfficialAccountPlans`）有意不删，官方 Claude Code 也不问就执行。
  现在补上的那几项记进同一份快照 `xingmang-claude-foreign-settings.json` 的新栏 `filled`（`recordClaudeFilledDefaults`），
  切回官方时 `withdrawClaudeFilledDefaults` 只撤记下的、而且值还是星芒写的那个的，`permissions` 撤空就连键删；撤完照旧清空快照。
  merge、reset、开机补设置（`fillClaudeRelayTemplateDefaults`）三条都记；还没有 settings.json 的新客户走模板时，快照那份计划
  现在也一起写（以前只写 settings.json）。
- 记号只认这一次：写之前是官方账号的样子（`claudeSettingsLookOfficial`）时旧记号作废，只记这次补上的，因为备份不带这份快照，
  切到当前账号失败按备份退回官方后，客户自己再开的同一项不能当成星芒补的；一直接着当前账号时旧记号照旧算，值被客户改过的作废。
- 0.2.24 之前就接过星芒的配置快照里没有记号，分不清那两项是不是客户自己设的，切回官方时照旧不动（项目规矩：客户自己设过的值不动）。
  `effortLevel` 不在这次范围里，照旧留着。
- P08（D13 + W30 W31，网络异常 W-9）：`online-status.ts` 断网横幅、代理横幅去掉「（加速）」、直连说明「其它」→「其他」；`registry/errors.ts` 的 `timeout` 小字改成「已装好的工具不受影响。检查网络后再点「重试」。」。`errors.ts` 的 `server` 那条和 `key-sync-failure.ts` 不在这批，照旧。
- 网络异常深查 W-1、W-2（`/mnt/project-files/0.2.24-深查/网络异常.md`）。只改判断，文案全用 `network-failure.ts` 和聊天里现成的句子，没有新字。
- W-1：`relay-line-fetch.ts` 导出 `unsentRequestFailure`，跟会改动数据的请求换线路重发用的是同一个 `provablyUnsent`，只多认 `ERR_PROXY_CONNECTION_FAILED`（代理软件没开，连代理都没连上；换线路没用，所以那边不认）。`ai-image-service.ts` 生图、改图 POST 抛错时先问它：请求肯定没送到就把 `dispatched` 退回 false、抛 `networkFailureMessages[原因]`，送没送到说不清的（连接被重置、握手被掐断、超时、`TimeoutError`、网络切换）照旧说「结果不明确」。`ai-video-service.ts` 同理，另外先 `forgetSubmission()` 清掉「结果不明」那条记录（更早一次不明确的提交留着），不再给这一单记用量刷新。
- W-2：`ai-chat-service.ts` 发请求就失败按 `classifyNetworkFailure` 说原因（认不出照旧「无法连接 AI 服务」）；200 却回网页的说 `intercepted`；读回复正文时抛的错按网络原因说，认不出的（`ERR_INCOMPLETE_CHUNKED_ENCODING`、`ERR_CONTENT_LENGTH_MISMATCH` 这类 `network-failure.ts` 不归类的）照 `stream-closed`「AI 服务提前结束了本次响应，请重试」说，只有解析出错才是「无法识别的数据」。`completeOnce`（画布文字节点）发请求失败、回网页同一套，读正文抛错认不出的照旧说「无法连接 AI 服务」（它从不交回半截）。渲染层 `features/chat/state.ts` 的 `chatErrorMessage` 在没有错误码时认出 `network-failure.ts` 那几句原样上屏（对话页出图走这条）。
- 没做：两条线路都被拦到认证页、生图拿到 200 网页那种（深查里「顺带一种情况」）：生图的回应只要是 200，就分不清那张网页是不是中转转回来的上游原话（推测透传渠道可能这样），说成没扣钱一旦说错客户就再扣一次，照旧说「结果不明确」；`network-failure.ts` 补 `ERR_HTTP2_*` 等错误码属于 W-7，不在这次里。
- 0.2.24 深查改字批次 Z06（W4 W5 W9a W81 W82 D47 D48）：`guide-result.ts` 自称改「星芒」，余额 $0 时
  （花当前账号余额、不是没试通的改用）结果卡「用的账号」去掉「打开工具试一次」、「下一步」换成「先充值」，
  聊天那条路不在这次范围；`StartGuide.tsx` 第 3 步按钮「去完成连接配置」→「去连好」（结果卡点名它的那句跟着改），
  没连好时灰着的「下一步」挂 `title`「先把上面那项连好」，忙着时不挂；`electron/ipc/handlers/launch.ts`
  选文件夹窗口标题「选择 CLI 工作目录」→「选一个项目文件夹」。用户那一行由改字批次最后统一补一条。
- OpenCode 1.19.5（2026-10-28）起不再往 GitHub Release 放 Tauri 的 `latest.json`（它们 `script/publish.ts` 写明那份
  只给旧版 Tauri 自动更新用、要的签名密钥已停用），桌面端早已换成 Electron，版本信息是 electron-updater 的
  `latest-mac.yml`。`releases/latest/download/latest.json` 照样跳到 `v1.19.5/latest.json`、再回 404。
- `scripts/sync-opencode-cos.cjs` 从那天起每次都卡在 `source-feed`（`source-url-rejected`，#1519 连续 32 次），桶停在 1.19.4。
  现在改问 `latest-mac.yml`：只读顶格那一行 `version`，并要求它列着两种芯片的 `opencode-desktop-mac-<arm64|x64>.zip`；
  下的仍是同一版的 `.app.tar.gz`，桶清单格式不变，已经发出去的客户端照常从桶里拿到新版。桶里旧清单的
  `source.feedUrl`（旧地址）照样认。签名、Team ID、Gatekeeper、版本一致这几道核对都没动。
- `electron/macos-desktop-app-installer.ts`：Mac 上 OpenCode 问官方那一路（桶没走通时的兜底、桶太慢时的测速）同样改读
  `latest-mac.yml`（新增 `feedFormat: 'yaml'`，原文交给 `selectOpenCodeRelease`），包地址照旧按版本号自己拼，跳转白名单不变。
- P07 / D8（`0.2.24-深查/Mac.md` M2）：Mac 卸载星芒勾「连同星芒替你装的命令行工具一起删」后的提醒不再说会删
  Grok CLI。`removeMacManagedTools` 只删 `~/Library/Application Support/XingMangAI`，Grok 在 `~/.grok`，
  客户自己用官方脚本装的也在那里，按决定单选 a 只改字不多删：`AppUninstall.tsx` 的 `appUninstallRemoveToolsWarning`
  换成决定单上逐字批的那句，`macos-uninstall.ts` 里说「Grok 也在这个目录」的注释改对，测试钉住新句子。
- 打包碰上 GitHub 504 不再动不动就红（深查 CI-1）。`electron-builder.config.cjs` 的 `electronDownload`
  改用锁定的 electron 包自带的 `checksums.json` 核对 Electron 压缩包，打包时不再每次去 GitHub 现拉
  `SHASUMS256.txt`（那个文件按设计从不进缓存，压缩包在缓存里也照拉，拉失败还把缓存里的包重下一遍）；
  校验照旧开着，对不上照样拒收。`scripts/patch-builder-fetch-compat.cjs` 把打包器的下载重试从 3 次共约
  12 秒放宽到 5 次共约 4 分钟，Electron 压缩包、fpm、7zip 这些都受益，CI 和发版用的是同一个打包器；
  老的 node_modules 原地升级到新补丁。`quality.yml` 里 macos-test、linux-test 存的 Electron 缓存
  改成两个架构的压缩包都存（`ci-ensure-electron-binary.cjs --zip <arch>`，同样的重试和校验），
  linux-package、macos-release-rehearsal、macos-intel 只读这份缓存，PR 上打包不再去 GitHub 下
  Electron（#1600 自己的 macos-intel 就是因为没缓存，GitHub 对 darwin-arm64 压缩包连回四分多钟 504
  红的）；并改掉那段说「打包复用缓存不再下载」的注释。
  沙箱里断网实测：缓存里有压缩包时 `--linux dir` 打包一个请求都不发；旧配置同样条件下先拉
  `SHASUMS256.txt`，失败后把压缩包重下，跟着红。
- D51（时间数字格式.md N-1）：`payment-window.ts` 自己画的扫码页（只有历史账号微信 Native 走这页）原先把
  `expiresAt` 的 UTC ISO 原样写成「有效期至：…Z」、金额后面跟币种代码。新加两个纯函数：`formatPaymentQrAmount`
  （CNY 写「元」，别的币种照旧写代码）和 `formatPaymentQrDeadline`（本机时间，当天「今天 HH:MM」、别的日子
  「M月D日 HH:MM」、跨年带年份，秒数舍掉）。跟渲染层 `calendar-time.ts` 的 `formatClockTime` 同一套写法，
  但那边把「不早于今天」都算今天，套到将来的到期时间上 23:50 下单、0:20 到期会写成「今天 00:20」，所以主进程另写一份。
  窗口按 `expiresAt` 到点关、扫页面倒计时的逻辑都没动；新那一行不会被当成「00:00」倒计时归零。
- `electron/payment-window.ts`：窗口开着时，本地 10 分钟上限（或二维码的到期时间）到点，以及付款页上认出超时、关闭、失败、
  倒计时 `00:00`，原来直接 `finish('expired' | 'failed')` 关窗并停止查单。客户第 9 分钟扫码、10 分钟后才在手机上付完，
  或付款页先显示「交易已关闭」、支付商到账通知晚到时，钱扣了，界面却说「不会再扣钱」，余额也要等别处刷新。
  现在这两种都改走 `reportClosed`（跟客户自己关窗同一条路）：关窗、发 `closed` + `confirming: true`、后台再查 15 分钟，
  界面用已批的「支付窗口已关闭」那套字，没加新字。只有账号后端的订单状态（`inspectOrder` 和关窗后的后台查询）还能报
  `expired` / `failed`。`PaymentWindowTerminalContext` 加可选的 `autoClosed`（`time-limit` / `page-expired` / `page-failed`），
  只进运行日志 `payment window.terminal`，客服分得清是客户关的还是到点自己关的；IPC 契约没变。0.2.24 深查「账号和配置」新-1。
- 新建项目文件夹里生成的说明文件 `bundled-catalog/project-instructions/AGENTS.zh-CN.md`：开头注释去掉已下线的 Gemini CLI（D50，新手流程.md N11）；「怎么自测」加一句「在 Windows 的 PowerShell 里调用 npm、npx、pnpm 时，写成 npm.cmd、npx.cmd、pnpm.cmd。」，让 AI 绕开 PowerShell 默认执行策略对 `npm.ps1` 的拦截，不碰安全设置（D75 选 a，Shell差异.md SH-4）。只对以后新生成的目录生效，已经生成的不动。新版摘要追加进 `PUBLISHED_PROJECT_INSTRUCTIONS_DIGESTS`，#288 那一版照旧留着，检查页仍认得老客户个人文件夹里没改过的那份；`project-instructions.test.ts` 钉住两版摘要和新字。
- 加 `fast-check`（只进开发依赖，不进安装包），给几处安全规矩和配置写入补随机输入测试（对照官方「验证」文章的建议第 9 条）：
  五个打码函数都要藏住各家密钥形状、调用方点名的值和命令行里凭据参数的值；外链白名单前后加什么都不能放行到别的页面；
  会话编号能过的都留在会话文件夹里；换线路改配置（TOML、JSON、.env）只换那一个值、其余字节原样、改两次等于改一次、
  改回去逐字节还原、能找到时一定找到；粘贴密钥的整理；PowerShell 单引号和通配符转义。在各测试文件末尾的
  `… with random inputs` 一节，红了怎么复现见 `docs/TEST-BASELINE.md`。
- 决定单 D32（代理深查 PX-11）：电脑设的代理要账号密码时，不再叫客户去开代理软件。`network-failure.ts` 加
  `proxyAuthRequiredMessage`（单子原句）、`proxyAuthRequiredStatus`（407）、`isProxyAuthFailure`（认 Chromium 的
  `ERR_PROXY_AUTH_UNSUPPORTED` / `ERR_PROXY_AUTH_REQUESTED*` / `ERR_UNEXPECTED_PROXY_AUTH`，或主进程已经写好的那句）和
  `resolveNetworkFailureMessage`；归类照旧是 proxy，改直连、重发那套一点没动。Electron 45.1.0 沙箱实测：走 https 时代理回 407，
  net.fetch 先交出 407 的回应、读正文才报 `ERR_TUNNEL_CONNECTION_FAILED`（跟「代理回绝了这个地址」同一个码），所以
  `new-api-client.ts` 还看这次回应的状态码；认证方式不认或没说时直接报 `ERR_PROXY_AUTH_UNSUPPORTED`。星芒账号
  （`NewApiNetworkError`）和历史账号（`RealmAccountError`）的报错换成这句；渲染层顶上横幅多一种 `proxyAuth`（还试一次直连、
  「打开系统代理设置」按钮照旧），登录框也认这句。不做输入代理密码的框。历史账号那一侧收到 407 回应照旧当成「请求失败」
  （不归网络），聊天、检查页、更新那几条路的说法也没动。
- D95 / 签名杀毒 AV-02：`package.json` 的 `author` 从「神风」改成「绍兴星芒文化传媒有限责任公司」。electron-builder 拿它当
  公司名，只写进三处：exe 文件属性的「公司」、安装程序的版本信息、卸载注册表的 `Publisher`（「设置 › 应用」里的发布者）。
  数据目录跟 productName、卸载注册表键名跟 appId、开机项跟 AppUserModelId，都不受影响；配置里没开 `menuCategory`、
  也没用 `${author}` 宏，开始菜单和安装包文件名不变。Linux 的 maintainer / vendor、Mac 的版权本来就单独写死。
  `scripts/update-release-utils.test.cjs` 钉住的值跟着改。客户看得到的那句（「设置 › 应用」里发布者改成公司全称）
  这批先不写进「## 用户」，最后统一补。
- 修 PX-2 的同类问题（`0.2.24-深查/代理.md`）：开票窗口（`invoice-portal-window.ts`）用自己的持久分区
  `persist:xingmang-invoice-<摘要>`，跟付款窗口一样不跟星芒的「代理连不上改直连」（`proxy-bypass.ts` 只改
  `session.defaultSession`）。系统代理指着一个已经关掉的代理软件时，点「开发票」报 `ERR_PROXY_CONNECTION_FAILED`、
  「没能打开开票中心」。`createInvoicePortalWindowController` 加可选的 `proxyMode`（缺省 `system`），每开一个新窗口、
  `loadURL` 之前都按它设一次（分区是持久的，上一次设的连法会留着，所以每次重设）；设的这一下里换了账号、退出了，
  作废的窗口不再加载。设连法那一行和付款窗口共用 `payment-window.ts` 新导出的 `applyPageProxyMode`（设不上照旧打开，
  同步抛错也吞掉），连法也共用 `main.ts` 里同一个 `externalPageProxyMode()`（`proxyBypass.active() ? 'direct' : 'system'`；
  只是连星芒站点那一路直连时开票中心照旧经代理走）。不加 preload，导航白名单、权限、下载照旧全拦，界面字没变。
- 沙箱里用 Electron 45.1.0 真跑过（xvfb，系统代理用环境变量指向一个没在听的端口，默认会话已改直连，
  `host-resolver-rules` 把开票中心地址指到本机自签证书的假页面）：main 那版报 `ERR_PROXY_CONNECTION_FAILED`，开票分区
  `resolveProxy` 是 `PROXY 127.0.0.1:9`；改后 `proxyMode` 给 `direct` 时打开了、读得到页面内容、分区是 `DIRECT`，给
  `system` 时照旧打不开。Windows、Mac 的系统代理没真机演过。
- 修 PX-2（`0.2.24-深查/代理.md`，严重）：付款窗口每次开一个新分区（`xingmang-payment-<uuid>`），Electron 每个分区各有
  各的代理设置，新分区默认跟随系统代理；星芒的「代理连不上改直连」（`proxy-bypass.ts`）只改 `session.defaultSession`。
  系统代理指着一个已经关掉的代理软件时，下单走账号接口能成功，付款窗口却又走回那个代理，报 `ERR_PROXY_CONNECTION_FAILED`、
  「支付页面打开失败」，钱充不进去。`createPaymentWindowController` 加可选的 `proxyMode(): 'direct' | 'system'`（缺省
  `system`），每次 `loadURL` 之前按它 `session.setProxy({ mode })`；`main.ts` 交 `proxyBypass.active() ? 'direct' : 'system'`。
  只是连星芒站点那一路直连（`siteDirect()`，代理开着、只是不转发星芒）时付款商的页面照旧经代理走。设不上照旧打开（就是
  以前的样子）；设的这一下里又开了新的付款或换了账号，作废的窗口不再加载。不加 preload，导航白名单、权限、下载照旧全拦，
  界面字没变。
- 沙箱里用 Electron 45.1.0 真跑过（xvfb，系统代理用环境变量指向一个没在听的端口，默认会话已改直连，本机自签证书的付款页）：
  main 0844053 那版报 `ERR_PROXY_CONNECTION_FAILED`；改后 `proxyMode` 给 `direct` 时 4 次都打开了、付款分区 `resolveProxy`
  是 `DIRECT`，给 `system` 时照旧打不开。Windows、Mac 的系统代理没真机演过。
- 0.2.24 深查「功能缺口与优化」Q1（yoyo 11-10「Q1做」「地址改」）：`features/account/OtherApps.tsx` + `other-apps.ts`，密钥管理列表下面加卡，地址由 `relayProviderBaseUrls(siteId, 'primary')` 派生（裸域名 / `/v1` / `/v1/chat/completions`），只给线路1（历史账号线路2 只放行星芒自己用的接口），不加 IPC 通道，剪贴板走页面 `navigator.clipboard`、点按钮当下就写。
- 首页 `homeToolRequest`：登录且有密钥管理（`supportsKeys`）时工具区最后一格落到 `other-apps`，否则照旧去反馈表单；`registry/business.ts` 的 `accountSections` 加 `other-apps`（gated，跟 `supportsKeyManagement` 走），顶部搜索「接口地址」「Cherry Studio」能找到。
- 0.2.24 深查改字批次 X12（D39，聊天页.md C1 的后一半）：托盘、菜单「退出」和「直接退出」偏好放行前，聊天还在回复（或出图）就先问「正在回复，退出会停下这条回复。」，
  按钮「等它说完 ／ 仍然退出」，回车、Esc 落在「等它说完」，点了这次不退。判断跟重启装更新（P04，D10）用同一份：界面报上来的 `rendererWork` 里有 `'chat'`，不看 `rendererBusy`。
- `quit-blocking-tasks.ts` 加 `buildChatReplyQuitPrompt` 和 `confirmQuitInterruptions`：先问工具在装（已知31，原样），再问聊天在回复，两问都问；问过的不再接着问要不要顺手装更新，下好的更新留到下次。
  `main.ts` 的 `confirmQuit` 改走它。「每次询问」那条关窗路径照旧不走这里（它的框已经写了「强制退出不等待任务完成」）；视频剪辑拼片不在这一问里（没批退出时的字），画布照旧走自己的关窗确认。
- 「出字时每 2 秒存一次」和退出前先让聊天页交出手上那份，已在 `chat-save-while-streaming` 那条里做了，这次不动。
- 崩溃上报不再把测试数据记进正式版名下（R4）：本机和 `test-build.yml` 出的快包（`xingmangLocalBuild`）、
  GitHub Actions 里起的打包版（`CI=true`）不再报 Sentry，和每天打卡同一条规矩（`crash-report.ts` 的
  `shouldReportCrashes`）；`package-for-testing` 出的测试包照样报，但 environment 记成 `testing`
  （打包时写进 `xingmangTestingBuild`：Windows 那份由工作流设 `XINGMANG_TESTING_BUILD=1`，macOS 那份
  按一次性身份签名认出），正式包仍是 `production`。`publish-release.yml` 不许出现这个标记，Mac 出包脚本
  把继承来的同名变量清掉。说明见 `docs/RELEASING.md` 第 9 节。
- 远程配置 RC-03：系统公告合集里只要有一条缺标题、缺正文、多套了一层，`parseNewApiAnnouncementCollection` 就整份报错，
  公告中心只剩一句「公告没读出来」，「内容 → 公告」时间线和首页充值活动卡片也跟着没了，所有星芒账号客户同时看不到。
  现在每条单独认（`newapi-announcements.ts` 的 `readCollectionEntry`），认不出的那条跳过，其余照常显示，已读编号不变；
  一条都认不出、版本号不对、太大这些整份认不出的情况照旧报错，不退回成一整段旧式公告。新增
  `parseAnnouncementCollectionBesideTimeline`：跟时间线一起下发时，合集整份认不出只丢系统公告那一块，时间线和充值活动照常；
  没有时间线时照旧给「重新读取」和官网两条路。没有新字。之前 Z09、Fable 复查第 8 条只改了出错时的字和按钮，没改「一条坏整份坏」。
  更新页「## 用户」已满 60 条，这条只写开发者说明。
- 打码：命令行凭据参数的带引号值里带转义引号（`npx srv --token "abc\"defghij"`、`--client_secret 'abc\'def'`、`--token="abc\"d ef"`）时，
  原来停在转义引号处，后半段进运行日志、诊断导出和反馈导出（子进程把命令行原样打印回来时才有）；现在整段藏住。
  照 #1892 的记号做法：参数规则照旧读到第一个引号，停在转义引号上的值留一个参数自己的记号，所有规则跑完再藏到真正收尾的引号。
  参数规则比字段规则先跑，记号会落进后面某个字段值没藏的那段里；跟字段共用记号时会挡住那个字段的补藏，所以分开。
  `--token=` 这种参数名本身也是字段名的写法，字段规则把参数的值再藏一遍时留下参数的记号。#1892 顺带发现。
- 打码：密钥字段的值里带转义引号（`{"password":"abc\"defghij"}`、`{'token': 'abc\'def'}`）时，
  原来停在转义引号处，后半段原样进运行日志、诊断导出、反馈导出和崩溃上报；现在整段藏住。
  做法是旧规则一字不改照跑，停在转义引号上的值留个记号，所有规则跑完以后再把记号到真正收尾引号之间那段藏掉，
  所以只会多藏、不会少藏，不带反斜杠的文本逐字不变；反斜杠其实不是转义（原样打出来的 Windows 路径）时找不到收尾引号，就不多藏。
  `redaction-patterns.ts` 新增 `escapedQuoteMark` / `hideRestOfEscapedQuotedValues`，崩溃上报那条字段规则也接上。
  #1888 随机输入测试发现；它那条「JSON 和单引号输出里的密钥字段」随机测试的值放开引号和反斜杠，按转义写进去再查。
- 运行日志、诊断、崩溃报告和反馈导出共用的打码表里，`sk-` 规则结尾从 `\b` 换成和其他各家密钥同一个 `KEY_TAIL`
  （`electron/redaction-patterns.ts`）。以前以 `-` 结尾的密钥打码后末尾的 `-` 留在外面，
  `sk-` 后面不到 6 个字母数字、再用 `-` 凑够长度的整串不打码。只会多遮不会少遮：新旧规则对拍 200 万条随机串，
  旧规则遮住的新规则都遮住，多出来的只有结尾的 `-`。随机输入测试里 `sk-` 密钥原先排除的「以 `-` 结尾」放开了，
  旧规则下当场红（反例 `sk-AAAAA-`）。#1888 正文「顺带发现」第 3 条。
- 注册框少两下（0.2.24 深查汇总决定单 D49「两件都做」，改字修复批次 X19）：去掉「确认密码」那一栏，`RegistrationDraft`
  不再带 `confirm`，`validateRegistration` 不再查两次一致；没勾协议不再是表单错误（`RegistrationErrors` 去掉 `agreed`），
  `AuthFlow.tsx` 在别的都填对、拼写提示也过了以后弹 `Confirm`「注册前请阅读并同意《用户协议》和《隐私政策》。」，
  「同意并注册」替客户勾上并接着注册，「取消」什么也不发。小框跟注册框并排挂、不放进它里面，免得按键冒到注册框的回车和
  Tab 处理上。登录框的协议勾选、找回密码第 3 步的「再输一次」不动；legacy 冻结不动。
- 深查「安装卸载」第 1 条：Windows 卸载清理（`uninstall-cleanup.ts`）和 Mac「卸载星芒」（`macos-uninstall.ts`）
  收回钩子、状态行时，把收回了哪几家、哪几样、哪份文件记进数据目录的 `cli-hooks-removed-by-uninstall.json`
  （新模块 `removed-cli-hooks.ts`，读写走 safe-local-data）。重装后开机（以及开机后第一次读配置之前）由
  `config-save-service.ts` 的 `restoreCliHooksRemovedByUninstall` 按记录补回（`config-files.ts` 的
  `restoreManagedCliHooks`：只补现在没有的，已有的、客户自己的 statusLine / Codex notify 不动，先备份再写），
  补上或已经有了就划掉，写不出来的留到下次开机。只认这份记录，客户自己删掉的不补；Gemini CLI 已下线不记不补。
  这一版之前的卸载程序不写记录，已经卸过重装的电脑不在其内。
- 发版工作流的 Linux 测试拆成两个并行作业（测试和CI深查 CI-2）：原来 `linux-checks` 一个作业串行跑完
  typecheck、npm test、整条 test:v2:browser 和 test:ui，11-02 Linux 补发那次（运行 41408530433）用了 42.2
  分钟，上限 45；开着 Linux 时它一超时，选「全部平台」的这一版 Windows 和 Mac 也发不出去。现在 test:v2:browser
  的夹具那半照 quality.yml 的切法放进新作业 `linux-renderer-v2-browser`（两片，用同两条
  `test:v2:browser:fixture:linux:N` 脚本），和 `linux-checks` 同时跑，`linux-build` 两个都过了才出包。
  `linux-checks` 预计约 22 分钟，上限 45 → 60；每片约 10 分钟，上限 45。一项测试没少、没有哪项跑两遍，
  `scripts/publish-workflow-config.test.cjs` 钉住两边实际派出去的合起来正好是整条 test:v2:browser、各片和 PR 上同一组脚本、
  上限要盖住 apt 最坏用时再留增长。
- 升级冒烟、卸载冒烟挪进 `quality`（CI-6）：两个工作流去掉自己的 `pull_request` 触发、改成 `workflow_call`，由 `quality.yml`
  的 `upgrade-smoke`、`uninstall-smoke` 两个作业调用；跑不跑看 `scripts/ci-change-scope.cjs` 新出的 `upgradeSmoke`、
  `uninstallSmoke`（名单就是原来两个工作流的 `paths`，只在 PR 上跑），`quality-gate` 要求该跑的必须绿、不该跑的必须是跳过。
  以前 #1524 合并时升级冒烟红着，因为 `quality-gate` 看不见它。卸载冒烟的并发组改名，免得和调用它的 `quality` 撞组互相取消。
- 新增 `docs/RELIABILITY-CHECKLIST.md`（17 条，每条：从改动看得出的触发条件、查什么、出自哪次事故）和 `npm run checklist`
  （`scripts/reliability-checklist.cjs`）：按本分支对 `origin/main` 的改动列出命中的条目，清单从 `origin/main` 读，不读本分支那份。
  `scripts/reliability-checklist.test.cjs` 核对每条的写法、每个文件写法都还对得上仓库里的文件、每条都能被它出自的那次改动触发。
  PR 模板加「可靠性清单」一节。
- 新增 `docs/CI-RERUN-LEDGER.md` 和 `npm run ci:rerun-ledger`（yoyo 11-17 定「记账」）：重跑才过的都记一行，同一条两周内第二次
  「处理」必须以「查根因：」开头，`scripts/ci-rerun-ledger.test.cjs` 逐行核对；不删测试。补记了 10-31 到 11-11 的六笔。
- `AGENTS.md` 第 8 节加三条：同一个检查连修三轮还红就停手交回；提 PR 前跑 `npm run checklist`；CI 红了先查账再决定能不能重跑。
- 新增「门禁删行提醒」（`.github/workflows/removed-guards.yml` + `scripts/report-removed-guards.cjs`）：PR 删掉或改掉门禁里的行（quality 工作流、`scripts/verify-*.test.cjs`、`trustedCommandEnvironment` 的禁用变量表、`ipc-channel-policy.ts`、密钥扫描、CODEOWNERS 等）、测试少了用例或断言、多了 `.skip` / `.only` / `.todo`、`npm test` 这几条命令少跑了东西时，在运行摘要页列出来并在 Files changed 里原处标警告。只提醒不拦，不进 `quality-gate`。
  用 `pull_request_target` 触发，名单和脚本从 main 读，PR 改不了自己的裁判；PR 的提交只当文字读、不执行，作业只读、不读 secret。先跑两周（到 2026-12-01）看误报再定要不要拦（验证方法建议第 5 条）。
- 强制更新那层提示（`RequiredUpdateGate`）一次没读到状态文件就整层收起，客户先前点过的「立即更新」照样在下好时直接退出重启装，也不问有没有工具在装（0.2.24 深查 远程配置 RC-01）。三处改动：
  - `electron/updater.ts` 的 `applyServiceStatus`：状态文件读不到（`status` 为 null）时最低版本沿用这次运行里读成功的那份，只有读到了、文件里确实撤掉了才放人；仍不记到本地，重开软件还读不到的电脑不拦（`docs/SERVICE-STATUS.md` 同步改）。维护提示照旧跟着这一次走。
  - `required-update.ts` 的 `requiredUpdateFollowUp`：那层提示不在时不替客户接着下载、接着装；`RequiredUpdateGate` 在提示收起时把先前那一下「立即更新」作废，再盖回来要他自己再点。
  - 门里的「立即更新」改走 `installUpdate({ askIfInstalling: true })`：还有工具在装时主进程先问退出时那一句（已知31，沿用原有的字），点「继续安装」这次不装，按钮回到「立即更新」。
- `updater.test.ts` 补「下载中读超时提示不收起」「重开软件不带上次的最低版本」，改了「读不到就放人」那条断言；`required-update.test.ts`、`app-check.mjs` 补提示收起后不替客户装、门里装之前带 `askIfInstalling`、点了「继续安装」按钮回到可点。
- 付过钱的图存不进作品库、已经暂存好了时，对话和画布上屏那句换成（深查 S-1，yoyo 2026-11-17 回「暂存改」）：
  「图片已经生成、也已经扣费了，但没能存进作品库，已经先替你收着。先别重新生成，清出一些空间后会自动存进作品库。」
  （`ai-image-service.ts` 的 `aiImageKeptUnsavedMessage`）。`AiAssetStore` 的 `keepUnsaved` 改成回 true / false，
  收下了就把错误的 code 换成新导出的 `AI_IMAGE_KEPT_UNSAVED_ERROR_CODE`，生图那边按它换句；没收下（暂存也放不下）
  照旧是「图片已生成但本地保存失败……请勿立即重复提交」。
- 对话页 `chatErrorMessage` 认「先别重新生成」原样上屏，排在按字面猜的几条前面；不然会落到兜底「请稍后重试」，
  客户照做就再扣一次钱。用户行并进 `d107-works-back-to-documents.md` 那条。
- AI 作品存不进去时，原始原因（盘满、没权限、文件被占用这些系统错误）挂在 `cause` 上一路带到运行日志（深查 S-1 第 3 条）：
  `ai-asset-store.ts` 的图片存入和另存、`ai-audio-asset-store.ts` 的音频存入和另存、`ai-video-asset-store.ts` 的视频另存，
  以及 `ai-image-service.ts`「图片已生成但本地保存失败 / 下载失败」两句。界面上的字一个没改；主窗口这条路由 `ipc.ts`
  记失败时连同 `cause` 一起写进日志，导出反馈报告时照旧遮掉用户目录（I13）。画布直接调的出图本来就一条日志都不记，
  那是日志和上报 R2，不在这条里。
- 付过钱的图存不进作品库时先暂存、腾出空间后补存（0.2.24 深查 作品和素材库.md S-1 第 4 条，汇总决定单 S-1 照推荐）。
  以前生图回来的 base64 或下载下来的图在 `AiAssetStore` 写盘失败就跟着错误一起丢了，客户已经扣过费。
- 新模块 `electron/ai-unsaved-image-stash.ts`（`AiUnsavedImageStash`）：先写进软件自己数据文件夹（按站点那层）的
  `ai-unsaved-images/user-<id>/<内容 sha256>.<扩展名>`，原子写、过 `safe-local-data` 的联接检查（I8）；那里也写不进
  （同一块盘满了）就留在内存里。盘上 512 MB、内存 128 MB 封顶，超了这一张照旧丢、记一行日志。
- 补存：登录（含开机自动登录）时 `main.ts` 调一次 `flush(userId)`；软件开着时按 1、5、15、30 分钟（封顶）自己再试，
  都存好就停。补存走作品库自己的 `storeLocalFile` / `storeLocalBytes`，按内容定编号，补存到一半退出也不会多出一张；
  暂存目录里被人放进来的链接、硬链接由 `storeLocalFile` 原有的检查挡掉。存好了才删暂存文件。
- 只接扣过费的两条路（`storeBase64`、`storeRemoteUrl`），而且只在校验已经过了、写盘那一步失败时（新的内部 code
  `AI_IMAGE_WRITE_FAILED`）；本机导入、主进程自己做的图不暂存。对话和画布项目两边的 `AiAssetStore` 都经新选项
  `keepUnsaved` 交给同一份，统一补存进账号作品库（画布项目文件夹写不进多半是文件夹本身出了状况）。
- 运行日志新增 `ai-chat/asset.unsaved.kept|dropped|restored|restore-failed`。暂存好了时上屏那句见
  `s-1-kept-image-wording.md`；没暂存上的照旧是「图片已生成但本地保存失败……」。
- 并发竞态 BF3：`useToolInstall.tsx` 的 `prepareRuntimeForInstall` 抢不到 node 那把锁时直接抛「运行环境正在准备」，外面再包成「Node.js 运行环境没装上，X 还没开始安装」。改成 `runtime-readiness.ts` 的 `prepareSharedRuntime`：抢不到就再要一次 `prepareRuntime`，主进程 `runtime:node` 同一个键复用同一次安装，不会装两遍。`StartGuide.tsx` 认那句旧报错的分支随之删掉。浏览器夹具的 `installNodeRuntime` 照主进程队列合并并发调用，`app-check.mjs` 加一条回归。
- 新增 `npm run selfcheck`（`scripts/self-check.cjs`）：把提 PR 前的四道自查（typecheck、test、check:v2、test:v2）按 PR 模板的顺序一条命令跑完，哪道红了也接着跑后面的，结尾打印一段原样贴进 PR 的汇总；云端容器里 Playwright 自己那份 Chromium 不在时，替这一次运行设上 `XINGMANG_E2E_CHROMIUM`；依赖或 Electron 没装时一道都不跑，把该敲的两条命令打出来。四道本身没改。
- 新增 `docs/CLOUD-SANDBOX.md`：云端容器里怎么装依赖、浏览器套件怎么跑、哪些网站连不上、CI 怎么看，这些以前只记在云端项目的记忆里，2026-11-11 重新核过后搬进仓库。
- `AGENTS.md` 开发流程加两条：修缺陷先写一条在旧代码上会红的用例；下一个人也会踩的坑随 PR 写回仓库文档（`docs/COLLABORATION.md` §7.4，含每月整理一次云端记忆）。
- 等 yoyo 点头的界面改动，动了版面的要配一张改完的截图（`docs/COLLABORATION.md` §7.5、`.claude/rules/renderer-v2.md`）；新增 `scripts/audit/v2-page-screenshot.mjs`，在本地夹具上几秒截一张。
- 修 PX-1 后半条（`0.2.24-深查/代理.md`）：服务状态文件（强制更新的最低版本、撤回名单、分批放量、维护提示、远程开关、
  付款方式开关、型号表）和检查更新走同一个 `autoUpdater.netSession`，可读它时代理连不上就直接当没读到，系统代理指着
  已经关掉的代理软件时一直读不到新的，强制更新推不到这台电脑。`readServiceStatus` 加可选的 `retryWithoutProxy` /
  `restoreProxy`：网络层报代理连不上时把会话改成直连再读一次（这一次另起超时），读完不论成没成都改回跟随系统代理；
  回了话但读不成的（404、网页、太大）、代理开着但回绝（`ERR_TUNNEL_CONNECTION_FAILED`）、超时、断网都不重试。
- 判断沿用 #1592 那份 `isProxyConnectionFailure`，从 `updater.ts` 原样挪到 `network-failure.ts`（`service-status.ts`
  不能反过来 import `updater.ts`），只认 Electron 原样抛出的整句 `net::ERR_PROXY_CONNECTION_FAILED` 或带 code 的错误。
- 检查、下载和状态文件现在是同一个会话上的两个用户，新增 `createSharedDirectRetry`（`updater.ts`）记着几个请求在直连上
  重试：最后一个试完的才改回 system，免得定时读状态文件那次先读完、把正在直连重下的安装包甩回关掉的代理。
- 沙箱里用 Electron 45.1.0 真跑过：`autoUpdater.netSession` 跟随一个没在听的代理端口时，`session.fetch` 报的是只有
  `stack`、`message` 的普通 Error；改直连以后马上重读就读得到，读完 `resolveProxy` 回到 `PROXY …`，两个读同时重试也只在
  最后改回一次。在线加速节点也走这个会话，但加速三个平台都下线了，没接。
- 「设置 › 备份迁移」最下面加「星芒占用的空间」卡（决定单 D100）：新通道 `storage:inspect` / `storage:clean`
  （`electron/ipc/handlers/storage.ts`，入参只认行名和清理对象，路径全由主进程定），
  主进程 `storage-usage.ts`（不跟链接的目录合计、六行共用一个并发闸、缩略图只删认得的文件名且单链接）
  与 `storage-usage-service.ts`（日志只记哪一行、字节数、几个没删掉）。
  「清理旧备份」只留卡上看得到的最近 10 份（`ConfigBackupStore.removeAllButNewest`）；
  「装工具时下载的文件」就是 `install-leftovers.ts` 认得的中断残留，算和删用同一套判断，
  手动清理进安装队列、不等 6 小时（Windows 以管理员方式运行时照旧等 6 小时，后台自动清理不变）。
  更新说明「## 用户」已到 60 条上限，这条不进更新页。
- 0.2.24 深查改字批次 Z02（设置页）：W14 W14b W14c W29（`SettingsPage.tsx` 三处小牌）W52 W62 W63 W64 W69 W70 W71 W72 D70，字照 `UI文字和按钮.md` 第七节与 `汇总决定单.md` D70 逐字改。
- W52 工作文件夹那一行：名字改「工作文件夹」，原来的说明「工具会读写里面的文件，请选你信任的文件夹」不在单子上、照留，单子给的说明「打开工具时进入这个文件夹」放在它前面；`ConfigDialog.tsx` 里同样的字不动。
- W70 连带 `electron/data-transfer.ts` 的 `portableLabels.crashReporting`：那张表按注释是「设置页上的叫法」，导入询问框原样列出，跟着改成「自动发送错误报告」。
- D70 快捷键表照「按这台电脑只写一种」的老规矩：全屏一行 Mac 写「⌃ ⌘ F」，Windows、Linux 写「F11」。
- 聊天「参数设置」的「恢复默认」不再清空系统提示词，只把四个滑块和两个数字框回到默认
  （`src/renderer-v2/features/chat/ParametersDialog.tsx`）。客户只想把滑块调回去，自己写的一大段提示词跟着没了，
  再点「应用」就存下去找不回来；清提示词自己删字就行。浏览器用例补了一条「恢复默认后提示词还在」（设置 X-5）。
- 检查页「电脑里另外设过的工具地址或密钥」在 Windows、Linux 上也读客户自己开终端时会读的设置文件（深查 Shell差异 SH-5）：
  Windows 读个人文件夹下 Git Bash 的 `.bashrc`、`.bash_profile`、`.bash_login`、`.profile`，和「文档」（宿主给的实际位置，
  OneDrive 挪走的也对）下 `PowerShell\`、`WindowsPowerShell\` 里的 `Microsoft.PowerShell_profile.ps1`、`profile.ps1`；
  Linux 读和 Mac 同一批 bash、zsh、fish 文件，`~/.bashrc` 排第一。PowerShell 启动文件由新的
  `powershell-profile-exports.ts` 认 `$env:NAME = …`、`[Environment]::SetEnvironmentVariable(…)`、`Set-Item`/`New-Item Env:…`
  三种写法，带 BOM 的 UTF-16（Windows PowerShell 5.1 的 `>` 存出来的）照样读。只在文件里找到的报「需留意」，句子和 Mac
  同一句；进程环境里的照旧「待处理」，两条各报各的；「删掉这几项设置」只挂在「待处理」上（它删不到文件里）。
- Mac、Linux 的检查页另读 fish 的 `conf.d/*.fish` 和 `set -Ux` 存进的 `fish_variables`（只算带 `--export` 的，SH-12 d）。
- Mac 点「打开」后等启动脚本真跑起来（最多 20 秒，脚本第一行删掉自己，同 Linux，SH-3）：「终端」开了窗口、脚本却被
  oh-my-zsh 的更新提问吃掉或被 `.zshrc` 里的 `exec tmux` 顶掉时，不再当成打开成功，报「终端窗口打开了，但工具没有跟着起来……」
  （yoyo 定的字）、另记一条 `terminal.failed`，没跑的脚本当场删掉，免得窗口迟到时又把工具开起来。
- Mac 的启动脚本只检查真要写进脚本的那几个变量（SH-11），同 Linux：名单外带 `BASH_FUNC_x%%` 这类怪名字时不再整次打不开。
- 以管理员身份运行时，推 Windows 版 Grok 拿哪个 shell 跑钩子照它那个窗口收窄过的 PATH 推（`grokShellEnvironment`，SH-10）：
  pwsh 只装在用户目录（商店版、scoop）时不再按 PowerShell 写钩子、让 Grok 用 Git Bash 跑出一行行红字。
- Mac 上登录 shell 是 zsh、bash，而 fish 的设置文件夹在的，顺带给 fish 也放一份 `conf.d/xingmang-ai-manager.fish`，同 Linux
  （SH-12 b）；写不进去只记一笔，不影响主的那份。写进 `.zprofile` 那句注释不再列 gemini（SH-12 c）。
- `windows-cli-shell-access.ts` 记下删 `.ps1` 改走 `.cmd` 的代价（参数被 cmd 再解析一遍，SH-9），不改行为。
- 侧栏「充值」从 `registry/shell.ts` 第三组挪进 `Shell.tsx` 的 `.v2-sidebar-pinned`，顺序是充值、更新入口（有新版时）、设置。加了画布、视频剪辑以后滚动区长了约 70px，逻辑高 Windows 约 740、Mac 约 770 以下最下面一组先被滚出去，充值排第一个，586 高时 Windows 半截压在渐隐下、Mac 整个滚出去。`keyboard.browser-check.mjs` 补两系统 586 高下充值看得见、没被盖住的检查（改前两条都红），`Shell.test.tsx` / `app-check.mjs` 钉住钉住区的新顺序；ui-spec 03 §3、v4 README、ui-spec CHANGELOG 跟着改。
- 已登录时点开邀请链接（D69，通知弹窗.md NT-12）：不再弹「操作没有完成」报错框、不再带「复制给客服」，
  改成右下角一条普通提示条「你已经登录了。邀请码 XXXX 要退出当前账号、注册新账号时才能用。」，
  带一颗「复制邀请码」（复制上了提示条才关，再说「邀请码已复制」；没复制上留着这条，说现成的
  「没复制上，请手动选中这行文字复制。」）。`useDeepLinks.ts` 的 `showSignedInInvite`；
  提示条组件 `ui/feedback.tsx` 加了可选的一颗按钮（`useToast().show` 第三个参数），带按钮的不自动消失。
- `XINGMANG_SIMULATE_MAIN_CRASH=1`（启动 30 秒后主进程抛一次没人接的异常）改为只在开发态认，打包版不再认（D101，
  死代码重复.md H11）。它走的是真的未捕获异常那条路，打包版上演一次就按致命错误报进崩溃统计。写法和同文件的
  `XINGMANG_ONBOARDING_PREVIEW`、`bootstrap/network-routes.ts` 的 `XINGMANG_TOOL_ROUTE_FAST` 一致，都是
  `!app.isPackaged &&`。开发态（`npm run dev` / `npm start`）设了它照样重开一次、第二次不再重开，演法不变。
  `main.test.ts` 钉住这个变量只读一处、读法带打包判断。
- 按「/」跳到搜索框（`features/shell/Shell.tsx`）只找正文里看得见、点得着的搜索框（复用 `ui/shared.tsx` 的
  `focusable()`，从 `ui/components.tsx` 导出），真聚焦上了才 `preventDefault`。原来取正文里第一个搜索框：
  聊天页去过一次就藏着挂在最前面，它的「搜索对话」永远排第一，聚焦不上又把「/」吞了，记录、教程、设置、扩展页
  按「/」都没反应（键盘无障碍深查 KB-5）。另外别人处理过的（`defaultPrevented`，比如菜单按字母跳转）和焦点在
  `[role="menu"]`、`[role="listbox"]` 里时不再接「/」，焦点不会被拽走、菜单还开着。
  `keyboard.browser-check.mjs` 加两条浏览器用例钉住。
- 深查 SP-2（系统权限申请）：Mac 包原来照搬 Electron 自带 Info.plist 里的英文用途说明。`electron-builder.config.cjs` 的 `mac.extendInfo` 把麦克风、摄像头、录音三条（`NSMicrophoneUsageDescription`、`NSCameraUsageDescription`、`NSAudioCaptureUsageDescription`）写成 `null`，electron-builder 26.15.3 合并完会删掉值为 `null` 的键。星芒碰不到这三样设备：主窗口和画布的会话把 `media` 一律拒，付款、开票窗口什么都拒，没设 `setDisplayMediaRequestHandler`，主进程没有 `desktopCapturer` / `askForMediaAccess`。
- 蓝牙两条（`NSBluetoothAlwaysUsageDescription`、`NSBluetoothPeripheralUsageDescription`）刻意留着：网页蓝牙不过会话的权限白名单（Electron 45 的 `MayUseBluetooth` 恒为 true），Chromium 在发现没人接 `select-bluetooth-device` 之前已经建了 `CBCentralManager`，删掉说明会让任何窗口里的网页点一下就让整个星芒被系统结束。
- 删了说明以后碰这几样设备，macOS 直接结束碰它的进程，星芒直接拉起的子进程（手机遥控的 `codex app-server` 和它跑的命令、客户配的 MCP）也算在星芒头上。`main.ts` 权限白名单旁边和 `.claude/rules/macos-platform.md` 写明：以后放开 `media` 的同一个改动里先把中文说明加回去。
- `scripts/verify-macos-free-artifacts.cjs` 在打出来的包上核对这三条不在（Mac 的 CI 每次打包都跑）；`scripts/macos-build-config.test.cjs` 钉住每种打包方式都删这三条，并用装着的 electron-builder 自己的 Info.plist 那一步跑一遍 Electron 45.1.0 的五条默认说明，确认删掉三条、蓝牙留着。
- 0.2.24 深查「反复切换」N4：Claude Code 接当前账号时 `parsed.model` 直接换成星芒型号，切回官方 `delete parsed.model`，
  官方那边的型号没人记。现在接当前账号前 settings.json 是官方账号的样子（没有 `ANTHROPIC_AUTH_TOKEN`、也没有
  `ANTHROPIC_BASE_URL`，口径同 `restoredAccountSide`）时，`claudeOfficialModelToKeep` 把顶层 `model` 记进同一份快照
  `xingmang-claude-foreign-settings.json` 的 `settings.model`（`moveClaudeForeignSettingsAside` 多一个可选参数，不动 settings），
  切回官方由 `restoreClaudeForeignSettings` 放回，同 env 那几项：settings 里已有 model 以现有为准，放完清空快照。
  接着星芒或别家中转时不记（那是中转的型号），所以接着当前账号再保存不会把记下的官方型号换掉；官方那边没设过就照旧删。
  merge、reset 两条都接上。
- 同上 N5：首页「改用当前账号」（`ipc/handlers/config.ts` 的 `writeAccountConfig`）调 `configureManagedClis` 时第 4 个参数一直是
  `{}`，切回过官方再切回来就挑默认型号。现在交 `accountSourcePreferredModel`（`account-source-switch.ts`）算出的原型号：
  配置本来就接着当前账号这个站（手填、别的账号）用它现在的型号；不是就用切回官方前记下的。记的地方是
  `AppSettings.relayModelsBeforeOfficial`（每家一条，只有主进程写，`settings:save` 的解析器不收），由
  `switchToOfficialAccount` 在切之前按 `relayModelBeforeOfficialSwitch` 取（配置连着当前账号这个站的任一条线路才算），
  切成以后写入；写不进只记日志 `official-switch.relay-model-unsaved`，不让这次切换失败回滚。没记过的 Codex（这条记号出现
  之前切的）退到星芒存的那份当前账号配置里的 `model`（`readStoredCodexRelayModel`）。新增 `SystemService.relayModelBeforeOfficial`
  （可选）。它只是「原来的型号」：账号不再列它时 `resolveDefaultCliModel` 照旧按系列和默认挑。
- 安装包里放第三方许可清单（D97，许可合规 LC-1、LC-2、LC-4、LC-7、LC-12）：`npm run compile` 最后一步
  由 `scripts/third-party-notices.cjs` 生成 `dist-third-party/THIRD-PARTY-NOTICES.txt`，`extraResources`
  放进三个平台安装包的 `resources/`（Mac 是 `Contents/Resources/`）。名单来自界面与画布两次构建实际打进
  产物的 node_modules 包（`scripts/third-party-collector.mjs`，后台线程 Worker 那一半也收，mediabunny 的
  MPL-2.0 写明这一版源码在哪），加主进程生产依赖和手工登记的 Electron、Chromium、lobe-icons、OpenCV
  抠图运行时、Codex 型号名单、Nsis7z、Mihomo。画布那一半绕开 `canvas-v2/`：`canvas:prepare` 改由
  `scripts/build-canvas.mjs` 用画布原配置构建，只多挂一个只读插件，`dist-canvas/` 与 `dist/` 逐字节不变。
- 门禁：许可不在已审范围（GPL 一类）就编译失败；名单对不上本次产物、或 mediabunny、@xyflow/react 不在名单里
  就失败；`verify-packaged-hardening.cjs`（Windows、Linux）与 `verify-macos-free-artifacts.cjs`（Mac）核对包里
  有清单、`LICENSE.electron.txt`、`LICENSES.chromium.html`，且 app.asar 里每个包都在清单上。
- Mac 包补回 Electron 与 Chromium 的许可文件：electron-builder 出 Mac 包时会删掉这两份，`afterExtract`
  在它删之前拷进 Electron.app 的 `Contents/Resources`。
- `LICENSE` 里安装包那句改成「按注册时同意的用户协议使用」。不加设置页入口，不加安装条款页。
- Mac「窗口」菜单加「关闭窗口」（`role: 'close'`，深查 TR-2）：以前这个菜单只有最小化、缩放、前置全部窗口，
  主窗口和画布窗口里按 ⌘W 都没反应，只能点左上角红点。role 自带 ⌘W，跟红点走同一个 `close` 事件：
  主窗口照「点关闭按钮时」的设置走，画布照样先存再关。用户可见条目已满 60 条，这条只写开发者片段
  （产品负责人 2026-11-12「W改」）。Windows、Linux 没有应用菜单，不变。
- 0.2.24 深查「更新说明和文档一致性」U1（产品负责人 2026-11-13 北京回「全部按照你的推荐决定」）：十一件客户感觉得到、
  当时因为满 60 条只写了「## 开发」的改动，各并进意思最近的一条用户行、加半句，条数还是 60。对应关系：
  PX-2（`px-2-payment-window-proxy.md`、`px-2-invoice-window-proxy.md`）→ `payment-window-timeout-keeps-confirming.md`；
  D100 星芒占用的空间（`settings-storage-usage.md`）→ `d107-works-back-to-documents.md`；
  看做过的图（`fable2-chat-assets.md`）→ `fable2-chat.md`；D92 双击画布项目文件（`canvas-project-file-double-click.md`）→
  `canvas-import-as-new-project.md`；引导「做图、做视频」（`fable2-guide-create.md`）→ `fable2-tutorials.md`；
  D49 注册少一栏（`register-fewer-steps-d49.md`）→ `login-register-wording-p06.md`；D64 离线安装包
  （`x27-claude-desktop-offline-packages.md`）→ `codex-desktop-firewall-off.md`；N3 Grok 切回官方（`grok-official-switch-every-line.md`）→
  `switch-keeps-chosen-model.md`；D35（`d35-claude-settings-proxy.md`）→ `health-check-proxy-key-quiet.md`；
  D39 退出先问（`quit-asks-chat-replying.md`）→ `update-download-retry.md`；DM-2（`dm-2-account-vault-damaged-file.md`）→
  `chat-group-key-unreadable-recovery.md`。那几个分片「## 开发」里「这条不进更新页」的说法以这条为准。
- 0.2.24 深查 D79（`0.2.24-深查/高分屏窗口.md` W-1）：`calculateUiZoom` 原来自动倍率和最终倍率共用一个上限 1.25，
  窗口宽过约 1455 DIP 时自动倍率已经贴着 1.25，110% 再乘上去又被夹回 1.25，按了等于没按。拆成两个上限：
  `UI_AUTO_MAX_ZOOM = 1.25` 只夹自动倍率，`UI_MAX_ZOOM` 改成 1.375（= 1.25 × 1.1）夹最终倍率，110% 在任何宽度都比自动大一成。
  自动倍率的算法和上下限都没动，选「自动」「100%」的人一个数都不变（测试逐宽度对旧公式钉住）。`platform/zoom.ts` 照旧转出这几个常量，
  `ui-spec/03-layout-window.md` §1 的公式跟着改，`e2e/renderer-v2-native.mjs` 那份自动倍率的常量改名对齐。
- 改字批次 Z07（W13 W15 W16 W53 W83 W84 W85 W86 W87 W88 D21 D59）：`App.tsx` 退出登录确认框按钮（W83 同一句也补到个人中心概览 `AccountOverview.tsx` 自己那个确认框）、Codex 已开着的那个框（标题、按钮、正文、`perform` 动作名）、中文界面问答框里的「其他用户」；`ConfigDialog.tsx` 来源标题、密钥下拉的标签、自动准备那一行的分组和预览、语言说明；`ExternalClientDialog.tsx` 手填密钥那一项；`external-model.ts` 别家设置的两种状态；`RequiredUpdateGate.tsx` 的按钮；`OfficialQuotaDialog.tsx` 的重置次数。
- `ManualUninstallDialog` 加可选 `onHelp`：没生成命令、或「帮我清理」没删干净时底部多一颗「找客服」（界面和功能页.md S12），帮助框叠在上面。`codexDesktopChineseUnverifiedMessage` 里点名的按钮跟着改成「重开 Codex」。
- 启动提示和系统通知改字（0.2.24 深查界面字 W8 W36 W37 W54 W55，改字批次 Z11）：账号存储重建那条写「星芒已重新建了一份」；
  设置存不上那条盘符前后补空格（「电脑上的 C 盘」「清理一下 C 盘」，没有盘符仍写「磁盘」）；关错误报告的提示统一「已关闭」；
  Codex 对话太大的启动提示、系统通知和重开提示标题里「线路 1 / 线路 2」去掉空格，跟设置页一致；Claude Desktop 修好那条 Mac 上写「⌘Q」。
- 自动更新后台下载没下成时补试（深查 Z-3）：以前只有停住、代理连不上当场重下一次，连接被重置、更新服务器回 5xx、
  换了网络这些都要等 3 小时那次定时检查从头再下。现在「自动更新」开着、失败又是过一会儿就可能好的那种
  （`isTransientDownloadFailure`：`network-failure.ts` 归得出原因的网络失败，证书被换和本机时间不准除外；看门狗停住；
  `isServiceUnavailableResponse` 认的 5xx），就隔 5、15、45 分钟（`updateDownloadRetryDelaysMs`）各跑一次
  `scheduledCheck`，补试里检查没查成也接着排，同一个版本三次用完回到 3 小时那一轮。已经排着一次时不另排（客户自己点
  重新下载、3 小时那次在中间失败都不多用掉一次）；下好、核对不过（`rejectDownloadedUpdate`）、`dispose` 都清掉；到点时
  阶段已经不是 error、版本换了、开关关了就不动。日志 `download.retry.scheduled`。顶掉手里下好的版本以后新版本没下成
  （Z-1 第 2 条）也走这条。
- 更新清单（latest.yml、latest-mac.yml、Linux 那几份）的 `releaseNotes` 只带要发的这一版那一节，
  不带版本号那一行：`electron-builder.config.cjs` 的 `releaseInfo` 从 `releaseNotesFile` 换成
  `releaseNotes`，取自 `scripts/extract-release-notes.cjs` 新增的 `feedReleaseNotes`。原来整份
  release-notes.md（二十多万字、从 0.1.x 起）原样进清单，0.2.22、0.2.23 的版本页把前 20000 字塞成一整段、
  还接着前几版，「重启并安装」被挤到最底（yoyo 2026-11-10「清单改」）。老客户界面不用改就短下来；
  0.2.24 起的界面本来就把没有版本行的说明当成这一版、一条一行。首节对不上这一版（升级冒烟、测试包
  临时调高版本号）时照原来整份写进去；真发版首行必须等于版本号，由发布前置检查拦（P-14）。
- 「重启并安装」确认框抽成 `features/settings/UpdateInstallDialog.tsx`：版本卡照用（共用卡上的 `useOperation`），
  气泡、状态栏版本号、侧栏 `nav-update`、气泡上安装失败的「重新安装」改由 `App.tsx` 就地挂 `UpdateInstallConfirm`，
  不再 `navigate('updates')` 再经 `requestUpdateInstallConfirm` 让版本卡弹框（那套请求/取走/订阅删掉）。框里的字、
  `installUpdate({ askIfInstalling: true })` 和主进程那几问都没变。yoyo 2026-11-10：要跳转、更新说明又长，不方便。
- 版本卡「vX 更新内容」原来把 `releaseNotesText` 整段塞进一个 `<p>`：electron-builder 把整份 release-notes.md 写进
  latest.yml，主进程截前 20000 字，客户看到的是要装的那一版连着前几版、换行全被吃掉的一大段（0.2.22 客户截图），
  按钮被挤到最底。`release-notes.ts` 新增 `releaseNoteItems`：只取要装的那一版那一节（找不到取第一节），按
  `bundle-release-notes.cjs` 同一拼法拆成一条一行；不是列表的照旧整段。说明区 `.v2-version-card-notes-body`
  限高 `min(240px, 34vh)`、区内滚动，装完后的「更新了什么」同样受益。只对装上这一版以后的下一次更新起作用。
- 手里已经下好一版、3 小时那次定时检查查到更新的版本时（`refreshDownloaded`），顶掉之前先量盘（深查 Z-1 第 1 条）。以前
  直接顶掉，阶段切成 available，随后 `download()` 下载前量盘发现不够就停在那儿：手里那份还在盘上却不算「下好了」，退出时、
  开机时都没东西可装。现在 `refreshDownloaded` 在查之前先读一次剩余空间，`update-available` 里用和 `download()` 同一个算法
  （`resolveUpdateDiskShortfall` + `requiredUpdateDiskBytes`）算新版本要多少，不够就不顶、留着手里那份，记一条
  `download.skipped.disk`；量不出来当够（旧行为）。手里那份够不上最低版本时照样顶掉，让「必须更新」门里显示要清多少空间。
  顶掉以后新版本因为网络没下成那一半走 Z-3 的补试。下载前那段量盘抽成 `readFreeDiskBytes` 共用，行为不变。
- 0.2.24 深查改字批次 P04（D10 ＋ D9，并发竞态.md BF1、界面和功能页.md S1；W1 作废）：`confirmUpdateInstall` 改走
  `quit-blocking-tasks.ts` 的 `confirmUpdateRestart`，先问工具在装（已知31，原样），再按 `buildUnfinishedRestartWorkPrompt` 问聊天、视频剪辑拼片、画布出图。
  更新页「重启并安装」、状态栏版本号、强制更新那层、托盘「重启并安装」和跳框里的「现在安装」都经过它；点「等它做完」回 `postponed`，跟「继续安装」一样这次不装。
- 界面这边只报正在做的那几样，不拿 `rendererBusy`：从更新页点的时候那个确认框自己就开着。`RendererActivity` 加可选的 `work`（`'chat' | 'video-compose'`），
  不加通道；`parseRendererActivity` 只认这两样、条数不超过种类数。`useBackgroundWork` 多一个可选参数标这一样，`renderer-release.ts` 记下最近一次报的、界面关掉时清空。
- 画布那一样由主进程自己看：`AiImageService.hasPendingWork()`（队列里还有图没收完，含停止以后接着收的）和 `canvasRuns.hasActiveRuns()`。
  交给服务端的视频（视频剪辑出片、画布出视频）不算，重开以后会接着取回来。
- 更新确认框那句换成 D9：「请先保存当前工作。星芒会先关掉，装好自动重新打开。」
- 自动更新的退回下限 `rollbackFloorVersion` 从 0.2.9 抬到 0.2.22（现在的最低版本，深查 Z-4 第 1 条）。状态文件没有签名，
  更新目录或直连转发机被人拿到时，不用签名私钥就能把当前版本写进撤回名单、再换上一份真签过名的旧清单，让客户端
  「退回」到红队修复之前的版本或已撤回的 0.2.20、0.2.21；发布者签名只防装恶意包，防不住装旧的真包。抬到 0.2.22 以后
  这条路最多退到 0.2.22，跟现在正规回退能选的范围一样。`docs/SERVICE-STATUS.md` 同步改了下限、「现在能退到哪」那张表，
  并写明以后每次抬最低版本顺手抬下限；「远程关功能」那句「文件被人改了最坏也只是关掉几样功能」改成只说那一项。
- 0.2.24 深查改字批次 X01（D11，自身更新.md Z-7，产品负责人 2026-11-10 北京回「按照你的推荐做」）：发布者撤回本机这一版、
  退回旧版时，主窗口外这几处不再说「新版」，跟设置页「建议退回」一个口径；平时（升级）一字不变。
- 退出时自动装的系统通知：标题「正在安装星芒AI新版本」改「正在换回星芒AI的 X 版」，正文「正在装新版 X，装好会自动打开。」
  改「正在换回 X 版，装好会自动打开。」（`auto-update-install.ts` 的 `buildAutoInstallNotice`，`moment: 'quit'`）。
- 打开时自动装的预告（系统通知和窗口里那张卡同一句）：「上次下好的新版 X 几秒后开始安装……」改「上次下好的 X 版几秒后开始安装……」，
  后半句和标题「星芒AI马上更新」不动（`moment: 'launch'`）。
- 退出时那一问：「新版本 X 已经下载好，顺手装上吗？／现在装上吗？」改「建议退回的 X 版已经下好，顺手装上吗？／现在装上吗？」
  （`quitInstallPrompt`，Linux 系统安装器那条是「现在装上吗」）；跳框「新版 X 已经下好，现在装上吗？」改「建议退回的 X 版已经下好，
  现在装上吗？」（`update-install-prompt.ts` 的 `buildInstallPrompt`）。说不出版本号时照旧。
- 判断来自快照里已有的 `rollback`（`updater.ts` 按「下好的版本比本机旧」算）：`quit-blocking-tasks.ts` 的 `InstallableUpdateOnQuit`
  多带一个 `rollback`，退出那条直接用；打开时预告、跳框要先等几秒，用新的 `isRollbackInstall(snapshot, version)`，只有快照里下好的还是
  这一版时才换说法，对不上按平时说。三个文案函数的新参数都是可选的，缺省 = 旧行为。
- 单子没列的几句没动：`desktop-notifications.ts` 里「新版 X 已经下好／正在后台下载」那几条系统通知。
- 接着补齐剩下三处（Fable 复查第二节第 6 条，产品负责人 2026-11-11 北京回「退回旧版改」）；除第一处平时也跟着改外，平时（升级）一字不变：
  一、退出那一问的小字「安装很快，装完会自动打开新版本。」去掉「新版本」，平时和退回同一句（`quitInstallPrompt`）。
- 二、上次自动装没装上那句（更新页、首页气泡）：退回时开头「新版本上次没装上」改「建议退回的 X 版上次没装上」，后半句不动
  （`previousAutoInstallFailureMessage` 多一个可选的 `rollbackVersion`；`updater.ts` 的 `previousAutoInstallFailure` 回调多传一个
  `rollback`，跟快照里 `rollback` 同一个算法，`bootstrap/updates.ts` 拿它决定传不传版本号）。
- 三、托盘「版本更新」那一项：`TrayUpdateEntry` 带上快照的 `rollback`，退回时六种写法换成「建议退回 X 版」「建议退回的 X 版等电脑腾出空间再下载」
  「正在下载建议退回的 X 版」「重启并退回 X 版」（Linux「退回 X 版」）「建议退回的 X 版已下载好」「退回 X 版没成功，点开看看」
  （`application-tray.ts`）。读不到版本号时照旧用平时那几句；点下去走的动作不变。
- 修 PX-1 前半条（`0.2.24-深查/代理.md`）：`updater.ts` 的 `isProxyConnectionFailure` 只认 `error.code` 上的
  `ERR_PROXY_CONNECTION_FAILED`，可 Electron 的 net 模块（`net-client-request.ts`，electron-updater 检查和下载都走它）只
  `new Error('net::ERR_PROXY_CONNECTION_FAILED')`，不挂 code，builder-util-runtime 原样往上抛，所以「代理连不上就改直连
  重试一次」在正式包里从来没触发过。改成同时认「整句 message 恰好等于 `net::ERR_PROXY_CONNECTION_FAILED` 的 Error」，
  只认 Electron 自己构造的那种：多一个字、大小写不同、裹在 HttpError 正文里、普通对象或字符串都不算，原来防「镜像页、
  更新说明里提到这个词就绕开客户的代理」的用意不变；带 code 的照旧认，cause 链照旧最多跟 4 层。
- 测试里的假错误换成真实形状：沙箱里用 Electron 45.1.0 + electron-updater 6.8.9 对一个没在听的代理端口真跑了
  `checkForUpdates` 和 `downloadUpdate`，两处拿到的都是只有 `stack`、`message` 两个自有属性的普通 Error。旧判断下用这个
  形状有 11 条用例变红。另加「只有整句相等才算」的 8 种反例。
- PX-1 后半条（`autoUpdater.netSession` 跟着 `proxy-bypass` 一起改直连，盖住服务状态文件、在线节点）不在这里，另开。
- 升级冒烟（`scripts/upgrade-smoke.cjs`）看到 `last-run-version.json` 后，`version.updated` 那一行也等最多 30 秒再判：
  这一行是排队异步写进运行日志的，常常比 `last-run-version.json` 晚落盘，以前只查一次会偶发误报
  「新版本没有记下『本次启动是更新后的第一次』」（#1565、#1748 上的 windows-upgrade 0.2.19）。
- 0.2.24 深查改字批次 Z05（W10 W45 W46 W73 W74 W75 D22 D57 D58），只动 `features/account/` 用量账单这一块和 `registry/business.ts` 的「生成任务」落点。
- D58：`UsageDetails.tsx` 计费明细里的倍率改用 `usageRatioText`，跟「分组」那一行同一种写法；首字响应用新的 `usageSecondsText`（毫秒换成秒，留一位小数）。
- D57：历史账号筛选框下面那句改由 `usage.ts` 的 `usageCalendarNote` 给出：本机此刻的钟跟北京时间一样（含香港这类同一个钟的时区）就不提时区，不一样才补「按这台电脑的时间算。」，认不出的时区按不一样处理。
- W75 / D22：顶部搜索的落点改名「生成任务」，旧名「异步任务」留在搜索词里，老客户照旧搜得到。系统通知标题「异步任务已完成」（`electron/platform/notifications.ts`）不在两张单子上，没动。
- 新增 `npm run verify:app`（`e2e/verify-app.mjs`）：真开编译好的客户端，账号站用本地假接口、别的网站一律不连，
  从欢迎页登录后按页面或步骤（点、填、按键、找字、截图）走一遍，每屏留截图和整页的字，结尾写 report.md。
  云端容器里自己套 xvfb；CI 的 Windows、Mac 作业每个 PR 走一遍侧栏各页，Windows 的截图随 electron-smoke-artifacts 上传。
- 真机要点文件分「机器能核」「必须真机」两段，PR 模板加「验证」一行并写进最后一个提交的说明（`docs/COLLABORATION.md` §7.6、§7.7）。
- 视频剪辑「拼成一条视频」卡开着「加字幕」时加「字幕大小」「字幕位置」两个下拉（yoyo 2026-11-09 回「所有的修改都按照你的推荐」），缺省中号、底部，老工程读回来也是这样。`captions.ts` 的 `layoutVideoStudioCaption` 多收一个样式（小号、大号按中号的 0.8、1.25 倍；顶部竖屏让开上八分之一，中间整块居中）；`compose-protocol.ts` 的画面设置多收 `captionSize` / `captionPosition`，认不出的整个拒；工程存这两项，拼片比对键带上。`captions.test.ts`、`compose-protocol.test.ts`、`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 两条（引擎：底部 / 中间 / 顶部、小中大；页面：选了以后印在顶部、重开还在、关字幕收起）钉住。
- 视频剪辑页头加「新建一条」，页面最下面加「草稿箱」卡（yoyo 2026-11-09 回「所有的修改都按照你的推荐」）。`project.ts` 新增草稿箱的纯函数（`startVideoStudioProject` / `openVideoStudioDraft` / `removeVideoStudioDraft`、存取 `serializeVideoStudioDrafts` / `restoreVideoStudioDrafts`，最多 20 份，空工程不进草稿箱），手上那一份照旧存在原来那一格，草稿箱另存 `…:drafts`。`useVideoStudio.ts` 只在手上没事在跑时换，先写草稿箱、存不下就不换；换回来的草稿里记着请求号的片段照重开页面那样接回（只查不提交）；选图、选歌对话框开着时换了草稿，选回来的不挂上去。教程「视频剪辑」一章最后一步的补充说明跟着讲新建和草稿箱。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条（新建、重开还在、草稿里没等到的那段换回来时接回不再付钱、生成和接回时不能换、删掉先确认）钉住。
- 视频剪辑分镜卡每个镜头加「让 AI 画一张」/「再画一张」、确认框、「正在画图」和「停止画图」，「想法」卡加第三个模型菜单「画镜头图」（yoyo 2026-11-09 回「按照你的推荐」批的字）。走对话页出图那条 `chat:generate-image`（停下走 `chat:cancel`），不加通道；画好的图和自己选的图一样当第一帧。`project.ts` 新增画模型的表和默认值（同对话页出图默认）、`videoStudioImageSize`（固定尺寸的挑长宽比最接近的，能自己定的按 720p）、`buildVideoStudioImageRequest`（画质不写、用模型缺省 low）和 `start/finishVideoStudioShotDrawing`（只认还挂着同一个请求号的那一镜，迟到的结果不盖上去）；画着的这一镜不出视频、不换图、不删，也不能整批生成、重写分镜。余额、额度不够照页面顶上那条报，别的原因写在这一镜下面。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条（画、再画、停下、没画出来、余额不够、重开还在、拿去出视频带着两张图）钉住。
- 视频剪辑「拼成一条视频」卡加「镜头之间」直接切 / 淡入淡出和「结尾淡出」开关（yoyo 2026-11-09 回「所有的修改都按照你的推荐」），缺省直接切、不淡，老工程读回来也是这样。拼片引擎：`timeline.ts` 新增 `VideoStudioTransition`、每段的 `fadeInFrames` / `fadeOutFrames`（镜头之间每头 0.4 秒、片尾 1 秒，短片段每头最多三分之一、片尾一半）和 `videoStudioFadeLevel`；`compose.ts` 在字幕画好以后盖一层黑，原声按每个采样点的时间跟同一条曲线淡，配乐只在结尾照旧淡出；`compose-protocol.ts` 的画面设置多收 `transition` / `fadeOut`，认不出的整个拒。工程存这两项，拼片比对键带上。`timeline.test.ts`、`compose-protocol.test.ts`、`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 两条（引擎：换段处画面和声音一起淡到黑、片尾淡出、不选时和原来一样；页面：选了以后拼出来跟着淡、重开还在）钉住。
- 视频剪辑点「生成」后几秒内强退或断电丢请求号（0.2.24 深查 KR-4）：`video:generate` 交给服务端之前先 `flushStorageData()`，让页面刚写进 `localStorage` 的请求号落盘（`electron/ipc/handlers/ai-video.ts` 的 `flushPageStorage`，拿不到会话照旧提交）；主进程意外退出那条路（`main.ts`）也补一步。落盘是交给系统写，强退、崩溃稳了；断电时系统缓存里没写下去的那一点仍可能丢（leveldb 不逐条 fsync），要靠 DM-8。不加通道、不改字。`ipc.test.ts` 钉住落盘在提交之前。分镜整份搬进主进程（DM-8）以后再根治。
- 视频剪辑「拼成一条视频」卡加「加配乐」/「换一首」/「不用配乐」和「片段原声」照常 / 调小 / 关掉（yoyo 2026-11-09「配乐改」）。主窗口业务通道新增两条：`video-studio:pick-music`（主进程弹系统对话框，经 `AiAudioAssetStore.storeLocalFile` 存进作品库的音频那一格，回编号、歌名、时长；路径不来自渲染层，认不出的文件统一报「这首歌读不出来…」，存不进保存位置照原话）和 `video-studio:read-music`（按编号读回字节，和 `video:read-clip` 同一队、成功不记日志）；契约、preload、`ipc-channel-policy.ts`（都等账号）和 `ipc.test.ts` 的两份点名单一起改。拼片引擎新增 `music.ts`：跟着 `pcm.ts` 按顺序交出的声音块往下解这首歌，不回头、整首不一次解进内存，放完从头接，结尾淡出，混进原声后截到 [-1, 1]；`compose-protocol.ts` 的请求多了 `music`（字节 + 音量，最大 128 MB）和 `clipGain`（原声音量，0 就不读原声）。工程存歌的编号、歌名、时长和原声那一项，读回时逐字段校验；换歌、换原声、不用配乐都会清掉挂着的成片。`music.test.ts`、`compose-protocol.test.ts`、`project.test.ts`、`VideoStudioPage.test.tsx`、`ipc.test.ts` 和 `browser-check.mjs` 两条（引擎：循环、淡出、原声调小 / 关掉、读不出；页面：选歌、取消、读不出、默认调小、拼出来有歌、重开还在）钉住。
- 拼片的起点改成 `max(0, 第一帧时间戳)`（`features/video-studio/timeline.ts` 的 `buildVideoStudioRenderPlan`）：带负时间戳隐藏前导帧的片段（编辑表、编码器预热那种），以前把藏在 0 之前的画面拼进成片开头，声音跟着往后推同样一截；声音经 `segment.sourceStart` 共用这个起点。正的起点照旧保留。#1489 总表 R2-1。`browser-fixture.ts` 的 `makeClip` 加 `lead`（0 之前藏几帧别的颜色），`browser-check.mjs` 补一条真编真拼的回归（改前成片 1.25 秒、0.1 秒是藏起来的红色），`timeline.test.ts` 钉住负起点、正起点和整段都在 0 之前三种情况。
- `video:save-as` 多收一个可选的默认文件名（视频剪辑页传片名）：契约、preload 跟着改，主进程 `parseVideoSaveName` 把它洗成干净的文件名（路径分隔符、Windows 不认的字、控制字符和改写显示方向的字换成空格，去掉首尾的点和空白，最长 80 个字，接 .mp4；Windows 保留名或洗空了就用作品库原来的名字），只当系统对话框的默认值，存到哪儿仍由用户在对话框里点、照旧原子写。`AiVideoAssetStore.saveAs` 多一个 `suggestedFileName`。`parsers/ai-video.test.ts`、`ai-video-asset-store.test.ts`、`ipc.test.ts` 和 `browser-check.mjs` 钉住。
- 视频剪辑分镜卡每个镜头加「时长」下拉（只列视频模型能出的几档，yoyo 2026-11-09 回「所有的修改都按照你的推荐」）；各镜长短不一时分镜卡不写「每段 S 秒」，确认框写「生成 N 段、共 T 秒」。`project.ts` 新增 `videoStudioShotSeconds`（单独定的或「每段时长」，再挪到模型能出的一档）、`setVideoStudioShotSeconds`（定成和每段时长一样就不存，出着的不改）、`selectVideoStudioVideoModel`（换模型时每段时长和各镜时长一起挪）和 `videoStudioCommonSeconds`；出片请求按各镜自己的时长。工程存这一项，读回时校验。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条（单独加长、改每段时长时没定的跟着走、确认框写总秒数、请求按各自时长、重开还在、出着时改不了）钉住。
- 视频剪辑分镜卡每个镜头加「用一张图开头」/「换一张」/「不用这张图」（yoyo 2026-11-09「图开头改」）。选图复用对话页的 `chat:pick-images`（`pickAiChatImages`，进 `VideoStudioBridge`），出片时 `buildVideoStudioClipRequest` 带 `imageAssetIds`：Grok 当第一帧，MiniMax 从 `t2va` 换成 `i2va`；主进程 `video:generate` 本来就收参考图，没有新通道。工程只存图的编号，读回时按编号重拼地址（`videoStudioShotImage`）；一次多选按顺序填后面没图、没在生成的镜头（`assignVideoStudioShotImages`）；重写分镜按位置留图。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条页面回归钉住选图、多选分配、取消选择、去掉、生成请求带图、生成中不能换、重开还在。
- 视频剪辑分镜卡生成好片段的镜头加「开头剪掉」「结尾剪掉」两个下拉（不剪 / 0.5 / 1 / 1.5 / 2 / 3 秒，yoyo 2026-11-09 回「所有的修改都按照你的推荐」）。`project.ts` 新增 `videoStudioTrimChoices`、`videoStudioTrimOptions`（剪完至少留 1 秒，片段时长读不到按每段时长）、`setVideoStudioShotTrim`（只剪生成好、没在重新生成的片段，剪的长短一变清掉挂着的成片）、`withoutVideoStudioTrim`（换上新片段时清零）和 `videoStudioTotalSeconds`（「共约 T 秒」减掉剪掉的）；拼片请求带上引擎本来就认的 `trimStart` / `trimEnd`，拼片的比对键也带上。工程跟着片段存剪掉多少，读回时整对校验。`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 一条（可选几档、拼出来的成片变短、换剪法清成片、重开还在、重新生成清零）钉住。
- `registry/tutorials.ts` 在「画布」后面加一章 `video`（工具类，4 步，按钮都落到视频剪辑页；yoyo 2026-11-09 回「所有的修改都按照你的推荐」），Linux 也有这一章；教程卡图标用侧栏同款 `Clapperboard`。`VideoStudioPage.test.tsx` 把这一章里所有加「」的按钮名、下拉名对着页面三种状态的首屏核对（只在确认框、生成中、余额不够时出现的三个除外），历史账号那条补充说明和页面原话一致；`tutorials.test.ts` 核对选项名取自页面那份、三个系统都有这一章。
- 视频剪辑改字（0.2.24 深查 W57、W58、W59 和决定单第六节时长写法）：拼片后台出的岔子（回包读不懂、线程停了、片段交不过去、
  请求格式或编码器不对）统一报「拼的时候出了点问题，请再试一次」，收成 `errors.ts` 的 `videoStudioComposeGlitchMessage`；
  确认框「上次提交时没收到服务端答复」改「星芒的答复」。时长统一走 `timeline.ts` 新的 `formatVideoStudioDuration`：
  先整体取整到秒再拆（原来成片超长的报错会写出「10 分 60 秒」），秒不补零，到一小时写「N 小时 N 分钟」；
  成片超长的报错往上取整，只超零点几秒时不再写成「现在是 10 分 0 秒」。`timeline.test.ts`、`compose-*.test.ts`、
  `browser-check.mjs` 钉住。
- 视频轮询「最多等 30 分钟」改成只算醒着的时间（0.2.24 深查睡眠 S1）：`ai-video-service.ts` 的 `awakeVideoPollSpan` 把两次查询之间远超查询节奏（3 倍以上）的那一截当成睡眠、只按一轮正常长短算，时钟往回跳不算；到了时限先再查一次，查到出好了照常下载，还没好才停，停下时用查不到进度那条同一句「暂时查不到视频进度，服务端可能仍在生成，请勿重复提交；下次启动会继续查询（任务 …）。」（原来是「已停止等待视频生成；服务端任务已保留…」）。视频剪辑、画布和聊天里的视频都走这里。不改新字。`ai-video-service.test.ts` 钉住（合盖 40 分钟后照样拿回、到时限那一刻出好的照样拿回、真没好才停）。
- 手机遥控微信扫码认得腾讯新加的扫码状态 `confirmed_but_need_verifycode`（手机上点了确认、还要输手机微信显示的数字）：
  `electron/codex-remote-weixin-api.ts` 新增 `weixinStatusNeedsVerifyCode`，照腾讯 openclaw-weixin 3.0.0-beta-0 的
  `statusNeedsVerifyCode`，状态名含 `need_verifycode` 的一律走现成的输数字界面。以前这个状态落进 `default`，客户只看到
  「微信扫码登录失败，请重试」。带 `confirmed_but_…` 的回应即使已经附了令牌也不收，只在随后那次普通的 `confirmed` 里存，
  手机数字这道校验跳不过去。配对码逻辑没动。
- 高分屏深查 W-3：`window-preferences.ts` 加纯函数 `resolveFittedWindowBounds`，窗口比它重叠最多那块屏的工作区还大、而且有一截落在所有工作区外面时，收到工作区大小（不小于窗口最小尺寸）并挪进那块屏，放不下就贴左上角，保证标题栏在屏幕里。跨两块屏摆的大窗口整个都在工作区里，不动；大小放得下、只是被拖到边上的，也不动；显示器之间 2 DIP 以内的缝不算露在外面。`window-recovery.ts` 的 `fitOversizedWindow` 跳过最大化、全屏、最小化、已销毁的窗口；`main.ts` 的 `recoverWindowPlacement` 在「挪回主屏」没动时接着调它，所以显示器变化（对所有看得见的窗口：主窗口、画布、付款窗口）和主窗口显示、还原时都会收。缩放公式（W-1）、第一次打开的窗口大小（W-2）、最小尺寸随屏更新（W-4）、画布最小尺寸写死（W-6）和画布还原时的检查（W-7）不在这次里。
- 深查 D24、D25（批次 Z18）。`node-runtime.ts` 装 MSI 那一步的进度改由 `nodeRuntimeMsiInstallingMessage` 给出：缺省说会弹授权窗口；`InstallNodeRuntimeOptions.processElevated` 为真（星芒本身带着管理员权限在跑，`windows-elevation.ts` 的 highIntegrity，已知19）时保留原来的「正在静默安装」。`main.ts` 经新的 `SystemServiceOptions.windowsProcessElevated` 传给运行环境卡和装工具时顺带装 Node.js 的两条路。
- `codex-desktop-service.ts`、`claude-desktop-msix-installer.ts` 走提权那一刻的提示换成 D25 那句，点明授权框上写的是「Windows PowerShell」。
- 修 Windows CI 上 `node-runtime.test.ts`「gives up at the ceiling and removes the partial package」偶发红
  （`expected 760000 to be 1800000`）：它自己的 `driveChunkByChunk` 以前每格最多等 1 万轮让那一块落盘，写盘慢时
  照样拨假时钟，3 分钟没进展那道比 30 分钟兜底先到。现在跟 `slow-download.test-support.ts` 一样，有文件操作在进行的
  轮次不算数；被测代码和断言没动，同文件新增一条在旧写法上会红的用例。
- 修 Windows CI 上 `git-runtime-install.test.ts`「still gives up on each source at the ceiling」偶发红
  （`expected 3800000 to be less than 3640000`）：`electron/slow-download.test-support.ts` 的 `drive()`
  以前最多等 1 万轮事件循环就拨假时钟，Windows 上关文件、删半截文件慢一点，时钟就在代码还在磁盘上时多走几格。
  现在有文件操作在进行的轮次不算数（`process.getActiveResourcesInfo()`），磁盘再慢也不拨；被测代码和断言没动。
  新增 `slow-download.test-support.test.ts` 钉住。同一天 MCP 页「自定义连接」两条点击超时没坐实根因，
  排除过的可能记在 `docs/TEST-BASELINE.md`。
- Windows 安装、卸载向导左边那张图换成星芒品牌图（D93，安装卸载深查第 12 条）：`build/installerSidebar.bmp`
  （164×314、24 位）由 `scripts/generate-installer-sidebar.mjs` 拿 `assets/brand/v3` 的深底图形和字标原样
  画在应用图标那块深蓝上；`electron-builder.config.cjs` 的 `nsis.installerSidebar` 写明这个文件，丢了打包
  直接报错，不再悄悄退回 NSIS 自带的通用图。卸载向导跟着用同一张。`scripts/windows-installer-sidebar.test.cjs`
  钉住配置、尺寸格式和底色。
- 改字批次 Z14（教程）：W1b、W17、W55、W85、D76。`registry/tutorials.ts`、`TutorialIllustration.tsx`
  里的「工具箱」换成「星芒」（「星芒工具箱」收成「星芒」）；教程和提示里的 Command + Q 换成 ⌘Q
  （`locale-status.ts`、`electron/running-tools.ts`，`window-lifecycle.ts`、`main.ts` 的注释同步）；
  教程里星芒自己界面上的路径「→」换成「›」，Windows / Mac 系统设置、Codex 自己的窗口、终端、
  浏览器和安装包那几段照旧用「→」；「从首页「打开」中选「重启 Codex」」改「重开 Codex」，
  教程里另两处「重启 Codex」和「提示 Codex 已在运行？」跟着 W15 的新名字改成「重开 Codex」
  「Codex 桌面端还开着」；「访问密钥」照 W85 改「密钥」（教程那一步的标题、示意图里的字段名和
  说明一起改）；「命令行工具里报错」加一条 WSL 说明（D76，Linux 版教程里去掉）。
  `startup-notice.ts` 那句 Command + Q 归 Z11，没动。
- 工作目录只收完整路径（0.2.24 深查 IPC接口 第 1 条，I5 加固，不放宽任何校验、不改字、不加通道）：`cli:launch` 的 `parseWorkspace` 和 `settings:save` 存目录都走 `ipc/parsers/common.ts` 新的 `requiredWorkspacePath`，按本机平台只认完整路径（Windows 是盘符或网络共享路径，`\foo`、`C:foo` 这种要看当前盘的不收；Mac / Linux 是 `/` 开头），拒 NUL、限长。以前送来 `.`、`foo` 这种相对路径，工具会在主进程当前目录打开，`classifyWorkspace` 认不出来，「这个文件夹不建议打开」那一问被跳过。`cli:launch` 不带目录时回落的记住的目录同样过这道检查；带了却不是字符串的直接报「工作目录格式错误」，不再悄悄换成记住的目录。`settings:save` 收到「每次都提醒」的目录（系统文件夹、存密钥的文件夹）不存、留着原来那个，跟选择器的 `rememberWorkspace` 共用 `workspace-guard.ts` 新的 `shouldRememberWorkspace`：设置页「更换」选到这种目录点了「仍然打开」，以前选择器不记、设置页紧接着又照存了。
- D83（深查 RC-06）：远程关功能、已知问题提示、充值方式开关这三样也记在电脑上（数据目录里的 `service-switches.json`，
  新模块 `electron/service-switches-store.ts`），读成功的那次再覆盖，一样都没写的那次记成空的。以前只活在内存里，
  读不到更新目录的电脑重开一次星芒，远程关掉的功能、藏掉的付款方式就回来了，「先这样绕过去」那句也没了。
  记的是没按版本、平台筛过的原样（`service-status.ts` 的 `pickServiceSwitches` / `parseServiceSwitches`），用的时候
  再按这一版、这种安装包筛；读回来用状态文件同一套解析器重新校验。开机时 `bootstrap/updates.ts` 在状态文件第一次读之前
  交给更新服务的新方法 `restoreServiceSwitches`（这次读成功过就不理），充值页在这次一次也没读成功过时用它。
  读不到状态文件的包（本地构建、开发态）不用这份记录。代价：撤掉开关以后一次也没读到过的电脑会一直关着。
- 修复批次 X04（决定单 D15，出处 0.2.24 深查 `权限和写失败.md` PW-3、PW-4，yoyo 11-10「按照你的推荐做」，不加按钮）：写工具配置撞上
  EACCES / EPERM 时，`config-files-context.ts` 的 `explainConfigWriteFailure` 先看是不是这两种：Mac、Linux 上工具的配置文件夹（或它下面到目标的
  某一层、目标文件）归 root（星芒自己不是 root 时才算）；Windows 上要盖掉的配置文件被设成了只读（mode 没有写位，只在写的时候算）。是就把报错换成
  「这个工具的设置文件夹归电脑管理员所有（错误码 EACCES）」或「这个文件被设成了只读（错误码 EPERM）」，原话挂在 cause 上进运行日志，code 照旧。
  `executeFilePlans`（含准备阶段）和写之前读原文的 `requireRawConfigText` 都走它；回滚也失败的那句照旧。
- 两种说法放在可进渲染层的新模块 `electron/config-write-blocker.ts`（已登记进 `verify-renderer-boundary`）；`operation-error.ts` 认出后配
  `registry/errors.ts` 新加的 `configAdminOwned`、`configReadOnly`：标题照旧「写不进配置文件」，正文是 D15 那两句，按钮照 `configPermission` 不加。
  查不出是哪一种的照旧是原来那句；切换前的备份那一步读不了不在这次里。
- 导出存不进去时不再借「写不进安装目录」「安装时先下到系统盘的临时文件夹」说（D16，深查「权限和写失败」PW-6）：
  `OperationTarget` 加 `'export'`，EPERM / EACCES 认成 `exportPermission`「这个位置不让星芒存文件，换个文件夹（比如「下载」）再导出。」，
  ENOSPC 认成 `exportDiskFull`「这块盘满了，清出一些空间，或者换一块盘再导出。」。检查页、反馈与客服、设置「导出聊天记录和设置」、
  记录页「导出对话」的页顶红条按失败的是不是导出那一下传 `target`；聊天页红条用 `exportFailureSentence` 接上同样两句，
  认不出的照旧说「这段对话没有导出成功，可以重试」。
- 聊天记录与设置、单段对话导出的保存框默认落在「下载」而不是桌面（`ipc.ts` 的 `desktopDirectory` 改成 `downloadsDirectory`，
  `main.ts` 传 `app.getPath('downloads')`，拿不到时退到主目录下的 Downloads）：Windows「受控文件夹访问」默认保护桌面、不保护下载。
- 原子写最后一步改名被拒时那句「写入被系统占用，请稍后重试」（PW-5）不在这次里，照旧。
- 0.2.24 深查 X-1：Codex 只坏了 auth.json、config.toml 读得懂时，首页「配置文件坏了」的「修好它」和碰上坏文件的
  「改用当前账号」以前都走 reset，把 config.toml 整份重建，客户自己加的 MCP 连接、信任过的文件夹、推理强度全没了；
  从修之前的备份找回又会把坏的 auth.json 一起放回去。新加一种写入方式 repair（config-files.ts 的
  `NativeConfigWriteMode`）：工具读不了的那份照重置重建，读得懂的那份照合并只改账号、地址、型号那几处。按官方账号修时
  官方的 config.toml 一个字不动，还接着当前账号的照「切回官方账号」只拿掉当前账号那几处。config.toml 也坏了、
  Claude Code 的 settings.json 坏了，跟原来的重置一样；配置里「重置为初始状态」照旧整份重建。
  `account:configure-managed-clis` 与 `config:switch-to-official-account` 的 mode 入参多收一个 `repair`（先备份，
  跟 reset 一样），`config:save` 的入参类型收窄成只认 merge / reset，跟它的解析一致。
- 0.2.24 深查 X-2（`0.2.24-深查/查设置恢复默认和导入导出.md`）：Windows 文本大小调大的电脑，外观「恢复默认」原来一律写
  `largeText: false`，反倒把 D81 替客户开的「大字」关掉，又因为写过 `largeText` 记上了 `textSizeChosen`，之后开机也不再自动开。
  现在 `window:get-capabilities` 的返回多带一个可选的 `largeTextByDefault: true`（主进程按开机读到的 Windows 文本大小，
  由 `window-preferences.ts` 新的纯函数 `shouldDefaultToLargeText` 算：就是「没定过字号的人在这台电脑上开机会不会被 D81 打开」），
  「恢复默认」据此给 `largeText`。没调大、读不到、还没读回来、以及 macOS / Linux 都不带这一项，恢复后照旧是关，和原来一样。
  没加新通道、没改字。
- 决定单 X21（D52 ＋ D60 订阅那条，时间数字格式.md N-2、N-25）：`electron/subscription-summary.ts` 的 `subscriptionEndDate`
  不是今年的到期日带上年份（规矩同个人中心的 `shortDate`），侧栏、首页、个人中心、首页提醒、托盘一起对上；
  `subscriptionSummaryText` 读到下次恢复时间就写成「剩余 $3.20 · 明天 00:00 恢复 · 11月30日到期」，托盘按自己的时钟算「今天 / 明天」。
- 恢复时间：星芒账号用服务端给的 `next_reset_time`；历史账号由新的 `quotaPeriodResetAt` 按 Sub2API 上游
  `user_subscription.go` 的规矩算（日额度在窗口起点那天的次日 0 点，开通一天以内的不刷新；周、月从锚点起每 7、30 天滚动，
  早期从开通当天 0 点起算的照上游改从开通那一刻算；赶不到到期前的不写）。剩得最少的那个窗口说了算，几个一样少时等最晚的那个。
  `sub2api-relay-backend.ts` 没动（D54 照旧）。
- 「我的订阅」每行「剩余 …」后面同样接「 · 明天 00:00 恢复」（历史账号日、周、月每行各算各的）；套餐卡和购买确认里，
  有额度上限又是每天重置的星芒套餐加「每天重置额度」。历史账号的套餐列表不带重置周期，这次不写；周、月重置单子没给字，也不写。
- `model.test.ts`、`Home.test.tsx` 里写死 2026 年的到期日夹具改用今年，免得跨年以后因为带上年份变红。
- 0.2.24 决定单批次 X22（D53，出处时间数字格式 N-3）：用量账单上的花费改走 `usage.ts` 新加的 `usageCost` / `usageQuotaCost`。
  不到一分的照调用详情「合计」那样写全（`usageMoney`，$0.0032），一分以上和正好是 0 的照旧两位小数（`dollars`）。
  调用明细「花费」列、花费趋势的柱子（连同悬停和读屏那句）、「日均」都换了；同一页的「总花费」「按模型」、生成任务列表和任务详情的花费也一起换，
  不然会出现「总花费 $0.00 · 日均 $0.0006」这种自相矛盾的写法。余额、充值、订阅额度、密钥限额照旧走 `dollars`，没动；刻度上的字（`usageTickText`）不变。
  只改数字写法，没加字，所以不写「## 用户」。
- 0.2.24 决定单批次 X24（D60 其余，出处时间数字格式.md N-18～N-20、N-22、N-23）。给客户看的那句并进了 `home-recent-time-milliseconds.md`（「## 用户」已满 60 条）。
- 登录设备（`account-center.ts` 的 `deviceActivityText`）：不到 5 分钟才写「刚刚活动」，5～59 分钟写「N 分钟前活动」，小时、天照旧。
- 公告时间线（`newapi-announcements.ts` 的 `formatTimelineDate`）：绝对时间改走 `formatClockTime`（「9月9日 20:00 · 3 天前」「今天 11:30 · 30 分钟前」），
  30 天以上只写日期（「2025年11月20日 18:00」），不再按 30 天一个月折算出「12 个月前」。列表右边的短日期原来是从这句 `.slice(5, 10)` 截出来的，
  换成单独的 `formatTimelineListDate`，照旧写「09-09」，没改。
- 只写钟点的两处：余额鼠标提示（`balance-status.ts`）和帮助框「最近一次出错」（`SupportIdentity.tsx`）今天的照旧，
  不是今天的换成 `formatClockTime`（「最后更新于 昨天 14:05」「最近一次出错：昨天 14:37 ……」）。新加的 `calendar-time.ts` 的 `calendarDaysBefore` 只用来分出「不是今天」。
- 首页招呼（`model.ts` 的 `greeting`）：0～5 点说「晚上好」。
- 用量账单「24 小时」那一档不写「日均」那行小字（`usage.ts` 新加 `usageDailyAverageText`）。
- Windows 上 Claude Desktop 一键安装没装上时，错误框的出口从「去官网下载」（claude.com/download，国内多半打不开）
  换成「下载离线安装包」（教程站 `guide/manager#offline-packages`，包来自国内存储桶）和「去 Claude 官网」两颗，
  正文点名的按钮跟着改（D64，外部链接.md L5）。新地址 `claudeDesktopOfflinePackagesUrl` 放在
  `claude-desktop-install-failure.ts`，主进程外链白名单按全等匹配收这一条（I12），`main.test.ts` 钉住；
  首页那一行缺系统安装组件时的「去官网下载」不在这次里。
- 「搬到新电脑」带上「匿名使用统计」（深查·设置恢复默认和导入导出 X-3）：以前导出带「自动发送错误报告」却不带它，
  旧电脑两个都关了，新电脑上统计照样是开的。它存在系统界面设置那份文件（`privacy.anonymousUsage`），不在 settings.json，
  所以由主进程 `readAnonymousUsagePreference` 另外读进文件的 settings 里（读不出来就不写）；导入时整份校验照旧，
  这一项不是布尔就整份拒绝；规矩跟其他设置一样：这台还是新装的「开」就直接关，这台关过、文件里是开就进询问框
  （标签用设置页现成的「匿名使用统计」），设置页走和开关同一条 `setPrivacyPreference` 写。旧文件没有这一项的、
  这台读不出来的都不动。没加新通道，`DataTransferImportPreview` 多两个可选字段。
- 更新页「## 用户」已经 60 条到顶，没写用户行。
- Mac 上从星芒打开工具，交给终端的 PATH 不再整份换成星芒那份：启动脚本保留客户登录 shell 读完
  `~/.zprofile`、`~/.zshrc` 后的 PATH，星芒找程序用的目录（`darwinCommandPathCandidates`）只把还没有的
  补在后面（`macos-platform.ts` 的 `buildMacosAppendedPathLines`）。AI 在工具里跑的 node、python3 和客户
  自己开的终端是同一份，不再先拿到 `/usr/bin/python3`；工具本身照旧按核对过的绝对路径起，#38 的
  `/usr/bin` 在前只管星芒自己找程序（D73，深查 Shell差异 SH-2）。Linux 的打开窗口这次没动：窗口读不到
  客户 `~/.bashrc` 里的 nvm、conda，把代下的 Node 挪后只会换成系统自带的旧版本，等单独拍板。
- 从星芒打开工具的窗口不再强制上色：去掉 `FORCE_COLOR=3`、`CLICOLOR_FORCE=1`，只留说明终端能显示颜色的
  `TERM`、`COLORTERM`（`CLICOLOR=1` 也留着，它只在输出给屏幕时上色）。这两项的意思是「接到管道里也照样上色」，
  AI 让子进程跑的测试、构建、`ls` 读回去的输出里都夹着颜色控制码，多花 token，靠解析输出的脚本也会出错；
  工具自己的界面接的是真终端，不靠它们也上色。Windows（`interactiveTerminalEnvironment` 和
  `windows-elevation.ts` 的窗口脚本，脚本里改成 `Remove-Item` 这两项）、Linux（`linux-terminal.ts`：
  不再 export，并进 `clearedWhenAbsentKeys`，命令窗口程序自己环境里的也不带进来）都改了；Mac 打开工具本来
  不经过这一层，`macos-platform.ts` 只是不再把继承来的这两项写进启动脚本，客户 `~/.zshrc` 里自己设的照旧
  （D74，深查 Shell差异 SH-8）。
- Windows 上从星芒打开的工具窗口里，客户自己没设过 `PYTHONIOENCODING`、`PYTHONUTF8` 时补一个
  `PYTHONIOENCODING=utf-8`（`provider-launch-service.ts` 的 `withPythonUtf8Output`，叠在颜色层之上）。
  中文 Windows 上 Python 3.14 及以前把输出接到管道时按 GBK 编码，Claude Code、Codex 跑命令都是接管道读输出，
  AI 写的脚本一打印 ✅ 就报 `'gbk' codec can't encode`，不报错的中文也成乱码，AI 多花一轮重跑。只改标准输入输出，
  不设 `PYTHONUTF8=1`（那会连 `open()` 读文件的默认编码一起改）；设过的不论什么值都照旧，变量名不分大小写。
  管理员身份那条路的基底仍是 `trustedCommandEnvironment`，这一层只加一个写死的值，被基底去掉的变量不会回来（T4）。
  Mac、Linux 不变（D77，深查 中文路径编码 ZW-2）。
- 老记事本存成 GBK 的工具配置（多半是手改过的 Claude Code `settings.json`），星芒写回一次那几个中文就成了「�」（审查 ZW-9，决定单 D78「只记日志」）：
  写回的内容和行为照旧，`config-files-context.ts` 的 `executeFilePlans` 在写之前看原始字节，写成以后由 `main.ts` 记一条
  `config/config.not-utf8-rewritten` 警告（文件和 .bak 位置）；`inspectProviderConfig` 给这种文件标
  `notUtf8`，检查报告的「连接设置」一项多一个 `file<N>NotUtf8`，只进导出的报告，检查页详情不上屏、结论不变。不提示客户，不加界面字。
- 开机换线路的定点改写（`applyProviderRouteFollow`）原来写成就删 .bak，碰上老记事本存成 GBK 的配置，写回后那几个中文成了「�」、原样一份不剩
  （D78 跟进）：`executeFilePlans` 的 `discard` 遇到写回前不是 UTF-8 的文件改为留下这次的 .bak，照每个文件 5 份的老规矩一起轮换，运行日志
  `config/config.not-utf8-rewritten` 记下它的位置；写回的那份已是 UTF-8，下回换线路照常删，UTF-8 配置的行为不变。不加界面字。
- 改字批次 X37（D29）：Mac 上点「打开」时，星芒自己查工作目录拿到 EPERM / EACCES（「文件和文件夹」里没给星芒授权，文件夹其实还在），不再报「工作目录不存在，请重新选择」，改报 D29 那句，让客户把「星芒AI管理工具」和「终端」两项都打开。新模块 `electron/workspace-access.ts` 的 `assertWorkspaceDirectory` 管这一查，命令行工具（`provider-launch-service.ts`）和 Mac 上的 Codex 桌面端（`codex-desktop-service.ts`）共用；Windows、Linux 照旧当成不存在。新句子不带「工作目录不存在」，界面不再把授权问题当成目录没了退回选择器。推测，没在真机上核。
- 「搬到新电脑」第二次导入，已经导过的对话里后来聊的也带过来（深查·设置恢复默认和导入导出 X-4；产品负责人 2026-11-13 北京回「全部按照你的推荐决定」）。
  以前 `chat/storage.ts` 的 `mergeImportedConversations` 按对话编号认，这台电脑上有同号的就整条跳过：先导一次、旧电脑接着聊几天再导一次，
  后来聊的一条都过不来，没有新开的对话时还提示「文件里的对话这台电脑上都有了。」。现在同号的逐条比消息（编号、谁说的、状态、正文、思考、出错说明、带的文件）：
  两边一样或这台电脑上的更长，不动；这台电脑上的正好是文件里那份的开头，换成文件里的（这台电脑上输入框里打了没发的、自己起的名字、置顶留着）；
  中间有一条对不上（两边各聊过），文件里那份另存一份、标题加「（导入）」，两边的都留着。另存那份的编号由原编号推出（`<原编号>-imported`，
  再分叉依次 `-imported-2`……，不占文件里别的对话的编号和输入框草稿的编号），同一个文件导两次不会多出一份，旧电脑再接着聊这一份也跟着更新。
  `ChatImportResult` 多一个 `updated`，设置页的结果句子多两种说法（`features/app/data-transfer.ts`）：
  「导入了 N 个对话，另有 M 个对话更新成了文件里的内容。」「有 M 个对话更新成了文件里的内容，其余这台电脑上都有了。」
  文件里的对话全都更新了时去掉「，其余这台电脑上都有了」；带设置、存满放不下的几种组合沿用原来的「和你的设置」「，设置已导入」「设置已导入。」和存满那句。
- 更新页「## 用户」已经 60 条到顶，没写用户行。
- 「搬到新电脑」不再带走对话输入框里加了还没发的图片（深查·设置恢复默认和导入导出 X-6）：`storage.ts` 的
  `exportableConversations` 以前只把已发消息里的图片换成「[图片没有一起搬过来]」，对话上的 `draftImages` 原样带走；
  图片文件只在旧电脑这个账号的图片库里，新电脑上 `xingmang-asset://` 回 404，输入框里是一个空白方块，点发送报
  「刚附上的图片找不到了」，要先点掉才能发。现在导出时去掉 `draftImages`，打了的字和 `draftFiles` 照带；
  0.2.22、0.2.23 导出的文件里已经带着的，`parseImportedConversations` 导入时也去掉。不改界面文字。
- 更新页「## 用户」已经 60 条到顶，没写用户行。
- 「搬到新电脑」导入时开头带字节顺序标记的文件（老记事本「另存为 UTF-8」会加）照常导入，以前说「这个文件不是星芒导出的，
  或者已经损坏」（深查·设置恢复默认和导入导出 X-7）：`parseDataTransferFile` 解析前过一遍 `config-files-context.ts`
  现成的 `withoutByteOrderMark`，只去开头那一个。
- 导入时文件被别的程序占着（`EBUSY`）或没权限读（`EPERM` / `EACCES`），`data-transfer:import` 改说「这个文件现在读不了，
  可能正被别的程序占着。关掉它，再点一次「导入」。」（yoyo 2026-11-13 批的字，X-7），原话挂在 `cause` 上进运行日志；
  太大、是链接、找不到这些照旧是原来那句。判断在 `data-transfer.ts` 的 `dataTransferReadFailureMessage`。
- 更新页「## 用户」已经 60 条到顶，没写用户行。
- 0.2.24 深查 X-8（`0.2.24-深查/查设置恢复默认和导入导出.md`）：系统界面设置读不出来时（深查 DM-3，`platform-settings.json`
  坏了，主进程没建起系统设置服务，每条 `xingmang-platform:*` 通道都报「系统设置尚未准备好。」），外观「恢复默认」原来第一步
  `setThemePreference` 就抛错，后面存缩放、大字、减少动画那一步根本没走到。现在 `SettingsPage.tsx` 的 `restoreAppearance`
  先存设置文件里那三样，系统状态读到了（`systemState` 有值）才接着恢复主题和高对比度，没读到只跳过这两项，和页面上那两行
  「没读到就点不了」一个口径。业务回归加了 `fail=platform-broken` 夹具（读和写都报「系统设置尚未准备好。」）和一条用例，
  旧代码上红。没加新通道、没改字。
- 0.2.24 深查 手机遥控.md YKS-4：`codex-remote-feishu.ts` 的 `send` 以前只在令牌失效时重来一次，断网、超时、5xx、限流
  直接报错，审批卡发不出去在 `codex-remote-service.ts` 里当「拒绝」。现在断网和超时（`transientFeishuRequestFailure`，
  拿令牌那一步断网也算）、HTTP 429 / 5xx、飞书文档里说「稍后重试」的 99991400、230020、1500、230049
  （`classifyFeishuSendResponse`）各等 1 秒、4 秒再发，最多两次；参数、权限、对方不收这类照旧直接报错。令牌失效那次刷新照旧，
  不占重发次数。每条消息带一个 `uuid`（飞书发消息接口：同一 uuid 一小时内至多发成一条，最长 50 字），重发用同一个，
  第一次其实已经送到时手机上不会出现两条。重发前的等待可注入（`FeishuChannelOptions.sleep`），日志只记状态码、code 和原因，
  不记正文（I13）。
- YR-10：`codex-remote-text.ts` 的 `normalizePairingAttempt` 比对前先把全角数字（０-９）换成半角。JS 的 `\d`
  只认半角，手机输入法切在全角时发来的「１２３４５６」以前认不出来，`tryPair` 直接 return：不回话、不算错一次、
  卡片上也不提示。只换全角数字，圈码、上标这类别的写法照旧不认；电脑时间快了时认配对码的 `warnClockAhead`
  走的是同一个函数，一起跟上。用户行并进 `codex-remote-fixes-0224.md`。
- 手机遥控读回应正文时断网不再记成「太大」（0.2.24 深查·手机遥控 YR-5）：`codex-remote-http.ts` 读正文那步以前出任何错
  （取消除外）都包成 `RemoteHttpError('oversize')`，手机上发的图下到一半断了网，飞书、微信都回「这张图片太大了，电脑没收。
  请发小一点的，或者截一部分。」；飞书发消息读回应时断了也当 oversize，不带同一个 uuid 重发，那条回复就丢了。现在用
  `readBoundedResponseBytes` 现成的 `oversizeError` 只给真超过上限的一种抛 oversize（原话不变），别的读取失败落到外层 catch，
  跟请求没发出去一样按 `network`（超时、取消照旧）。取图失败走现成的「这张图片电脑没取到，请再发一次。」，飞书、微信发消息按
  断网重发。不加新字，不动 `network-failure.ts`（这里不按原文归类，只分「超限」和「别的读取失败」）。
  `codex-remote-http.test.ts`、`codex-remote-feishu.test.ts`、`codex-remote-weixin-api.test.ts` 钉住。
- YR-9：`codex-remote-service.ts` 的 `saveChannelCredential`，微信换了机器人重新扫码（账号字样变了）、过了手机上
  那串数字的扫码人就是原来绑着的那个人时，不再先 `tellUnbound` 发「电脑上已经把你解绑了」，绑定原样留着（绑定时间
  不变）；这次连接里的对话、等你同意的照旧清掉，跟换凭据一样。换成别人扫、没过数字、退出登录照旧先跟原来那个人说。
  微信重新扫码会不会换机器人编号、同一个人的编号变不变是推测，要真机坐实。
- 0.2.24 深查改字批次 Z01（首页和工具卡），yoyo 11-10 回「按照你的推荐做」批的 W7 W9b W10 W11a W12b W19 W25 W26 W27 W28 W29 W65 D12，
  只换单子上逐字写的字，测试里写死的字跟着改。D12：`Home.tsx` 页头在「还没连上」之后、「还没装工具」之前加一支
  `undetectedCount > 0`，检测失败的卡 `installed` 为假，原来会落到「都配好了」（全都没检测出来时落到「还没装工具」）。
  `registry/status.ts` 的 `environment.optional` 跟着改成「可选 · 未安装」，`ui-spec/22-registries.md` 同步。
  用户那条等这批改字都合完由协调者统一补一条（「## 用户」已 53 条，上限 60）。
- 记录页改字（0.2.24 深查 `UI文字和按钮.md` W20~W23，yoyo 11-10 回「按照你的推荐做」）：归档记录的「恢复到记录」改「取消归档」（「…」菜单和详情主按钮）；
  详情里「导出对话」按钮的悬停字「导出成文件」改「导出对话」；预览被截短时的提示改「只显示了前面一部分 ／ 要看全部，点「导出对话」。」；
  空状态「聊过的会话」改「聊过的对话」，无标题兜底「未命名会话」改「未命名对话」，详情键值「会话 ID」和复制按钮的读屏字改「对话编号」；
  页头加副标题「在首页打开工具聊过的对话都在这里」。只动 `features/sessions/SessionsPage.tsx` 的字，行为不变；`ui-spec/04-pages.md` 跟着改。
  客户看得见但只是改字，不占 `## 用户` 的 60 条名额。
- 0.2.24 深查改字批次 Z09（W34 W35 D19，yoyo 11-10「按照你的推荐做」）：`Announcement.tsx` 新增 `formatAnnouncementLoadError`，
  读公告失败统一上屏「公告暂时没读到，过一会儿点铃铛再看。」，服务端原话和状态码只留在主进程 IPC 失败那一行日志里
  （`ipc.ts` 的 `recordFailure`，`account:get-notice` 本来就记 error，`new-api-client.ts` 不用动）；公告太大（W34）和合集读不出来
  （W35，`newapi-announcements.ts` 四处报错合成一句，改抛 `AnnouncementCollectionError`）照各自那句，因为它们另有去官网的路。
  首页提示区那行报错去掉，只在铃铛小框和公告大框里显示。已读没记上统一显示「没记上已读，下次打开可能还会提醒。」，
  不再接原话。打开链接失败、旧式公告「标为已读」失败仍走 `formatAnnouncementError`，不在这批里。
- 扩展页改字（0.2.24 深查 Z10：W6 W32 W38 W39 W42 W43 D20 D67）：精选的「本应用」改「星芒」
  （`registry/curated-extensions.ts`）；精选出品方改「Anthropic 官方」「MCP 官方」
  （`bundled-catalog/curated-extensions.json`）；自定义连接附加参数、附加设置的报错改成「照提供方说明原样粘贴」
  （`extensions-common.tsx`）；移除确认框按种类分开写：外接工具指回精选或重新填，技能指回「从文件夹导入」
  （`ExtensionsPage.tsx`）。
- D20：缺 uv 时不再叫客户在命令行执行 pip install uv，改成交给客服教，提示里配「找客服」按钮
  （`mcpRuntimeNotice` 多一个 `support`，扩展页和精选页两处提示都给按钮）。
- D67：Codex「自己添加的市场」点「移除市场」先弹确认框（移除 ／ 取消），跟同页删除确认框一个样子；
  e2e 夹具加 `customMarket` 覆盖取消不动、确认才移除。
- 改字批次 Z13（W89 W90 D14）：`registry/errors.ts` 的 installBlocked、permission 正文换成 D14 那两句，按钮都改成「重试、复制路径、找客服」（permission 去掉「查看日志」）；officialRegistryUnreachable 标题和正文前半句按 W89 改，noTray 按钮按 W90 改成「装系统托盘扩展」。
- 引导里「改用当前账号」写不进配置文件时，出口按 permission 那一类的按钮走（`guideFailureExits` 不带 config 目标），所以那颗按钮从「查看日志」变成「找客服」，单测和 `features/auth/browser-check.mjs` 跟着改。
- 桌面端接入改字（0.2.24 深查决定单 D62 D63，批次 Z21，产品负责人 2026-11-10 北京回「按照你的推荐做」、2026-11-11 北京回
  「决定单照推荐」，字照决定单原文）：OpenCode 保存成功那句改「已经连好了。关掉 OpenCode 再打开就能用；要是你在某个项目里
  单独给 OpenCode 配过模型，那个项目里以你自己配的为准。」（`external-client-route-service.ts`）；Claude Desktop 保存成功那句
  去掉和下面「连接自检：已连好」打架的「尚未验证真实推理连接」，改「已经写进 Claude Desktop。把它完全退出，再从这里点「打开」
  就生效。」（`claude-desktop-config.ts`）；「连接 {桌面端}」弹窗保存后那行配置文件位置收进「查看详情」，默认不展开
  （`ExternalClientDialog.tsx`）；XDG_CONFIG_HOME 不是完整路径时那句改成说怎么修，而且只拦 OpenCode：WorkBuddy 的配置在主目录的
  `.workbuddy` 里、不看这个设置，以前被一起拦下是误伤。
- 检查页「连接自检」：WorkBuddy、OpenCode 用的是客户自己配的别家（配置来源 `other`）时不再标黄，跟「未配置」一样是灰的，
  写「用的是你自己的配置」，不算问题、照旧不拿那把密钥发请求（`external-client-connection.ts`）。Claude Desktop 不在 D63 里，
  照旧标黄。只改字和颜色，小改动不占更新页的条数，所以没写「## 用户」。
- 0.2.24 深查改字批次 Z22（D65、D67）：手机遥控卡片的「解绑」「退出登录」改成先弹 `Confirm`（`CodexRemoteCard.tsx` 的 `codexRemoteConfirmText`），确认后先关框再执行，失败原因仍在卡上的红条里；微信扫码登录好以后那句按卡片快照里有没有 `boundPeer` 分两种（`WeixinRemoteSection.tsx` 的 `weixinLoginHeadline` 多一个参数）：没绑人先指去「打开遥控」再配对，扫的还是原来那个机器人、绑定的人还在就说不用重新配对。用户行由协调者统一补。出处：手机遥控.md YKS-7、通知弹窗.md NT-8。
- 手机遥控微信那块的「退出登录」确认框正文换成「退出后要重新用微信扫码登录，才能再用手机遥控。」（yoyo 11-10「微信退出改」，跟进 #1645 / D67）：正文挪到 `channel-sections.tsx` 每个渠道的 `logoutHint`，飞书照旧说重新填凭据。用户行由协调者统一补。
- 手机遥控深查 YR-8（yoyo 2026-11-18「这些都按照你的推荐」）：开了「打开星芒时自动打开遥控」时，手机上收到的两句换掉。
  星芒退出那句换成「电脑上的星芒关了，遥控已停。星芒再打开时会自动连上。」（`remoteMessages.quittingAutoStart`）；
  闲着自动关那句换成「{N} 小时没有新消息，手机遥控已自动关闭。星芒下次打开时会自动连上，现在要用请在电脑上重新打开。」
  （`idleClosedMessage(hours, autoStart)`）。没开的照旧。开没开读的是盘（手机上「关闭遥控」会直接改盘，YR-1），读不出来当没开；
  道别那句读盘也算在原来那 1.5 秒里，自动关时渠道照旧当场关、不等读盘。`useCodexRemoteActive.ts` 那句「开关不落盘」的旧注释一并改掉。
- 决定单 D7（批次 X57，产品负责人 2026-11-11 北京回「决定单照推荐」）：Claude Desktop、WorkBuddy、OpenCode 装好或登录以后，
  从没配置过、默认密钥和型号也定得下来的，替客户自动连一次，不用再点「确认连接」→「保存并检测」。挑密钥、挑型号跟配置窗口
  打开时默认的同一套（`external-client-defaults.ts`），挑不准就不连（OpenCode 只在借 Codex 那把时连，「模型类型」才拿得准）。
  装好那次在同一个安装任务里做，进度那行用命令行工具装完时那句；连好了角落说配置窗口保存成功时那句，没连照旧说「点「确认连接」」。
  登录那次等账号密钥写完再做，界面上不说，只进运行日志（`external-client-auto-connect`）。开机恢复、切换账号不做。
- 「从没配置过」由主进程现看（`ExternalClientConnectionStatus.pristine`，不落盘）：WorkBuddy 没有 `models.json`；OpenCode 全局配置
  一个都没有、也没有它自己的 `auth.json`（在里面登过别家），也没用 `OPENCODE_CONFIG*` 另指配置；Claude Desktop 官方和第三方两个
  数据目录都不在（一次都没打开过，看不出客户有没有用自己的 Claude 账号登上，打开过的一律不碰）。开着的不碰。
- 写配置请求新增可选的 `automatic: true`（没加通道）：主进程排在写配置的队里、真要写之前再核一遍「从没配置过、没开着」，
  不是就一个字不写，免得盖掉客户这几秒里自己刚保存的那份。连接框保存成功那句挪到 `external-client-notice.ts` 共用，字没改。
  更新页「## 用户」已满 60 条，这条没占。
- WorkBuddy 改成客户自己下载（产品负责人 2026-11-18 回「改」「下线」「留着」，新字原文逐字给他看过；并进 #1776 的登录后自动连）：
  首页 WorkBuddy 卡没装时说明「装好 WorkBuddy 后，星芒会自动连上当前账号」、按钮「重新检测」，去掉「去官网下载」、Mac 的
  「安装指南」和外链白名单里的 `https://www.workbuddy.ai/`；教程 Mac 那一章跟着改。旧开机快照里那条下载地址照常读、读出来丢掉。
- 两个版本都认：国内版（`WorkBuddy.exe` / `WorkBuddy.app`，`~/.workbuddy`）和海外版「WorkBuddy AI」（`WorkBuddyAI.exe` /
  `WorkBuddy AI.app`，`~/.workbuddy-ai`），签名主体相同、核对一处没放宽；两个都装着时各写各的 `models.json`，各是一笔事务
  （`ExternalToolPathRoots.workBuddyEditions`）。安装记录在、程序没认的进运行日志 `external-client.candidate-rejected`（按主目录脱敏）。
- 回到星芒窗口时 WorkBuddy 没装就单独看一眼（`external-clients:scan` 新增可选 `{ only: 'workbuddy' }`，没加通道；至少隔 2 分钟、
  复用已核过的签名、失败那次不改首页）。认出来（开机、「重新检测」、回到窗口）且这个账号的密钥写完，就替他自动连一次（D7 的
  `detect`），开着也写；「从没配置过」对 WorkBuddy 改成 `models.json` 里没有星芒站点的模型、星芒没替当前账号写过
  （`ExternalClientOwnershipStore.recorded`，客户删了星芒那条不再加回去）、没用 `WORKBUDDY_CONFIG_DIR` / `WORKBUDDY_DATA_FOLDER_NAME`
  另指配置。自动那次只往文件里追加一条，客户原有的每一条一个字节不动。连好了在角落说配置窗口原有那句，登录那次也说（另两家照旧不说）。
  0.2.24 给客户看的更新说明已定稿（`final-user-notes.md`），这条只写开发记录。
- Codex 的 config.toml 读不了（configBroken，地址读不出来）时，配置窗口选「保持当前」再点「重置」不再被
  「已保存的密钥属于其他账号」拦下、一个字没写（11-18 客户：config.toml 被 PowerShell 5.1 按 GBK 改坏，
  密钥在 auth.json 里好好的）。`config-save-service.ts` 的 `saveConfig` 只在重置（含修好它）、文件确实读不懂、
  地址读不出来时认人，两种本机证据任一成立才沿用这把密钥：来源记录把地址换成当前站各线路地址后对得上
  （`recoverBrokenConfigOwnership`，只认当前账号写下的 account 和客户自己填的 manual，来源照记录放回），
  或者它正是当前账号签给这个工具、本机缓存着的那把（线路跟随那边的 `holdsAccountKey`，来源照旧按记录算）。
  认不出的照旧报原来那句，而且在发任何请求之前；只更新（merge）不在此列。没有新字。

## 0.2.23 - 2026-11-01

- 新增 `codex-payload-limit.ts`：盯 `CODEX_HOME/sessions` 会话记录新写进的末尾，认 `event_msg` /
  `task_complete`（老版本另认 `error` 事件）里的「unexpected status 413 Payload Too Large: …, url: <地址>」
  （0.163、0.164 命令行和 app-server 连本机假接口实测）。线路1（CF，请求体上限 100MB；WebSocket 握手回 426，
  每轮重发整段）的地址：星芒账号 `tool-route-controller` 的 `holdDirect`、历史账号 `relay-route-controller` 的
  `holdDirect` 查一次线路2，通了当场换（原因 `payload-too-large`，不等三轮、不看切换间隔、不给线路1 记失败），
  Codex 配置跟过去后由 `noteCodexPayloadRestart` 出重开提示（只说 Codex，不受「换线路后提醒我重开工具」开关和
  24 小时一次限制）。锁了只用线路1、线路2 不通、Codex 配置不在线路2 上的，出「新开对话」卡片；线路2 的地址
  （超过 256MB）只提示新开对话。同一个会话在每条线路上只处理一次（`codex-payload-sessions.json`，线路1、线路2
  分开记：线路1 上换过线的对话到了线路2 再超照样提示，R29-02；线路2 上提示过的退回线路1 也不再管），线路1 上
  记录过了 80MB 提前提醒一次。客户没看着星芒时另发系统通知，归 `cliTrouble` 开关。
- 历史账号换到线路2 后 24 小时不切回线路1：`relay-route-lines.json` 加可选 `holds`（0.2.22 及以前不认，
  装回去照样读得出结论；那条 `payload-too-large` 切换记录老版本读时丢掉）。线路2 自己坏了照旧退回线路1，
  这段保持随之作废。保持期间查通线路1 的次数不攒，过完从头数够十分钟。
- 日志 `relay.route.payload-too-large`、`relay.route.payload-nearing` 只记会话 ID、站点、线路、动作和会话记录大小，
  不记报错原文和地址（I13）。会话记录只读单链接普通文件、不跟符号链接，一次最多读末尾 256KB，超过 64KB 的行不解析（I5、I8）。
- 工具线路三线全挂的原因加一种 `hijack`：当前线路判成劫持（地址不在合法集合、证书也不对）而别的线路
  没通时，按它提示改 DNS（10-25 客户 Mac：只用 114.114.114.114，114 时好时坏地把 xm-direct、xm.solov.cc
  解析到发 redirect-cnzz 自签证书的机器，Codex 报 CaUsedAsEndEntity；阿里、腾讯、百度的 DNS 都对）。
  存下的提示时刻照常按原因 24 小时限频。
- 换线劫持提示带上换下来的线路（`RelayToolRouteStatus.hijack.line`，缺省按线路2）；以前写死「线路2 换线路1」，
  线路1 被指错换去线路2 时说反了。
- 支付窗口（#1458，Claude·win 在 A012 上查清）：乐风码付的收银台 302 落到 `/pay/<订单号>`、画完二维码以后，会无条件把页面跳去
  `alipays://` 拉起支付宝 App。支付窗口照旧拦下这一跳（放行规则不变）；0.2.21 还在等整页加载，被中止的加载报 `ERR_ABORTED`，
  就成了「支付页面打开失败」，0.2.19 起支付宝充值每次都这样。#1405 改成提交即打开以后这一跳只拦不报错，这次补上这个场景的单测
  （`payment-window.test.ts`，提交后跳 `alipays://`、`weixin://` 被拦、随后 `ERR_ABORTED`，窗口照常显示、不销毁、照常查单）。
- 拦下的是 `alipays:`、`alipay:`、`weixin:` 这类拉起 App 的地址时，`payment/navigation.blocked` 改记 info，只写协议名
  （新纯函数 `resolvePaymentAppLaunchScheme`），不再按 warn 记「已阻止支付窗口跳转到未授权地址」把客服带偏；
  别的被拦地址照旧 warn 记 origin。
- 付款页打不开时那句话（`paymentPageOpenFailedMessage`）后面加上「这次没有扣款，「我的订单」里多出来的订单放着就行。」：
  走到这句时订单已经下了，账号服务没有给用户取消充值单的接口，没法替客户撤单，「我的订单」里会多一笔待支付。
  yoyo 10-27 回「订单字改」批了这句和上面给用户看的那条。
- 聊天模型菜单去掉「分组」一节（产品负责人 2026-10-25 定、回「聊天改」批了字）：`useChatController.ts` 打开聊天时
  `prepareAllGroups` 把每个分组都准备一遍（一次三个，没对话密钥的分组这时签一把，之后复用），`state.ts` 新增
  `buildChatCatalog` / `chatModelVendor` / `pickChatGroup` / `settleChatModel` / `recommendedChatGroup`，去掉只剩测试在用的
  `resolveChatGroup`。同一模型几个分组都有时：对话正在用的分组 → 出图挑图片分组、聊天挑推荐分组 → 倍率低的 → 后台先后。
- 后台刷新（切回窗口、打开菜单）照旧只重读分组列表，读过的分组不再准备；新冒出来的分组读一次（这时给它签对话密钥）。
  模型哪个分组都没有了，后台刷新不悄悄换（`keepMissing`），留着「当前模型已不可用，请换一个模型」让用户自己换。主进程没改。
- 视频剪辑第 1 期 PR3：renderer-v2 新页 `video`（`registry/pages.ts`，T1，日常组画布之后），代码在
  `features/video-studio/`：`project.ts` 纯函数管工程（分镜落成镜头、排序增删、出片段的请求、`localStorage`
  存取与逐字段校验），`useVideoStudio.ts` 管读模型、写分镜、同时最多 3 段的出片队列、调 PR1 的拼片引擎和
  PR2 的通道，`VideoStudioPage.tsx` 是页面。历史账号登录时 `pageVisible` 不出这一页；没登录时只有登录入口。
  没开新通道、没改主进程，主窗口 CSP 不动（片段用缩略图代表，点了交给系统播放器）。窗口矮时收起的窄条
  图标行 28 → 26（`styles/shell.css`），110% 缩放的最小窗口里 Mac 也放得下多出来的这一项（#1133 第 4 条）。
- 写分镜和拼片在 `useVideoStudio.ts` 里互斥：写分镜时拼片按钮灰着，拼片时烧字幕开关锁着；拼完先核对片段、顺序、字幕和
  画面设置还是拼的那一份，对不上只存进作品库、不挂到这一页。
- 余额用完提醒（主路卡点 F2）：Codex 的 notify 只在一轮顺利做完时调用，额度用完时终端里先「Reconnecting 1/5…5/5」，
  最后才出 `403 用户额度不足`，星芒一声不吭；原来唯一跟钱有关的通知是「从 $5 以上跌到 $5 以下」那一下，
  从 $3 用到 $0、重开软件时已经是 $0 都不说。现在读到钱包 ≤ $0、又确定没有能扣的订阅时发一条系统通知
  （`balance` 这一类，编号前缀 `balance-empty:`，点了去充值页），不分工具。
- 判断和记录在 `electron/empty-balance-alert.ts`：订阅还没读到（`subscribed: null`）先不下结论，免得把只靠订阅、
  钱包本来就是 0 的客户当成用完；同一个账号同一次用完只说一次，记在 userData 的 `balance-empty-notified.json`，
  重开软件不重复，读到钱包有钱或订阅能扣了就抹掉记录。同一次读数里既跌破 $5 又到了 $0，只发 $0 这一条。
- 检查页加 `RELAY_DNS`（`diagnostics-dns-check.ts`）：用电脑自己的 DNS（`dns.lookup`）和 223.5.5.5、119.29.29.29
  （`dns.Resolver`，每台 1.4 秒、整项 3 秒）各查一遍工具线路两条主机名。线路1 合法 = CF 段；星芒账号线路2 合法 =
  上次读到的线路状态文件 `legitIps`，没有就只和公共 DNS 对。fake-ip、私网段算代理软件接管，不判；只有电脑给的不合法、
  公共 DNS 给的合法又不一样时才说查错。两条都错红灯，只错一条看线路设置：「自动」或固定在对的那条是绿灯，
  固定在错的那条黄灯并带 `reroute: 'auto'`，「去处理」翻到设置里线路那一行。日志只记每条线路的结论，不记地址。
- 检查页加 `SYSTEM_PROXY_SOFTWARE`（`diagnostics-proxy-software-check.ts`）：问只跟随系统代理的那个会话
  （`network-routes.ts` 的 `resolveSystemProxy` / `systemProxyFetch`，另用 `siteDirectFetch` 直连对照）连
  `/api/status`。本机端口不通或报代理错 = 代理软件没开；经代理不通、直连通才说它挡路；两边都不通不怪代理。
  星芒加速自己设的代理不查。黄灯带 `fix: 'open-proxy-settings'`（只有 Windows、Mac）。
- `PROXY_ENVIRONMENT` 只管另外设的代理（环境变量、npm 等），系统代理那半句挪到上面那一项；删掉
  `inspectAppProxyRoute` / `withAppProxyRoute` 和依赖 `resolveAppProxy` / `siteDirectActive`：它们问的是默认会话，
  星芒绕开坏代理改直连以后答 DIRECT，会把没在运行的代理说成没开。Windows 没设代理时那句改成「没有另外设过代理」。
- `network:open-settings` 加 `dns`：Windows 打开 `ms-settings:network-status`，Mac 打开网络设置，地址照旧写死在主进程。
  检查页那两行的按钮由主进程在 details 里放 `fix` 决定（`features/app/network-settings-fix.ts`），Linux 不给。
- 写 Claude Code 配置时（保存、登录后自动写入）顺手在 VS Code、Cursor 的用户设置里补
  `"claudeCode.disableLoginPrompt": true`，编辑器里的 Claude Code 插件不再一打开就要登录 Anthropic 账号
  （官方文档《在 VS Code 中使用 Claude Code》「使用第三方提供商」第一步；Claude Code 在编辑器终端里跑一次就会
  自己装上插件）。只在编辑器打开过（`User` 目录在）、这一项没写过时补，客户写过的（含 `false`、嵌套写法）
  不动；设置文件按 JSONC 读，注释、末尾逗号、缩进、换行符、BOM 照原样，读回来必须恰好只多这一个键；
  两阶段提交留 `.bak`，替换前再核一遍编辑器没改过。补不上只记日志，不算保存失败。新模块
  `electron/editor-claude-login-prompt.ts`。
- `relayTemplateRevision` 4→5：老客户开机补设置那一轮，当前账号写的 Claude Code 配置到期时顺带补一次，客户
  自己删掉以后不再补回。切回官方账号不收回（认不出是不是星芒补的）。
- 星芒写 Claude Code 的 `settings.json` 时多写一项 `fallbackModel`（备用型号，产品负责人 2026-10-26 同意）：
  `cli-model-defaults.ts` 的 `resolveClaudeFallbackModels` 从这个密钥列着的 Claude 型号里挑最多两个，先是同系列版本最新的
  另一版（Opus 5.5 → Opus 5），再是另一档里最新的（Opus、Haiku 配 Sonnet，Sonnet 配 Opus），不挑 Haiku，挑不到就不写。
- 沙箱本地假接口实测 2.1.302、2.1.310：主型号回「无可用渠道」503、上游 500/502/529、找不到型号 404 时，有备用 1～2 秒内换过去
  答完这一轮（备用也用不了就试下一个）；没有备用要重试 10 次、约 3 分钟后报英文错。额度不足 403、限流 429 不换。
- 写入规矩同 `/model` 菜单（`claude-model-picker.ts`）：只在没写过、或是本软件照这份型号清单给原来那个型号写的时改（配置窗口里
  换了型号，备用跟着换），客户自己写的不动；打开前核对、开机那轮（`config-save-service.ts` 的 `syncClaudeFallbackModels`）
  给老配置补上，开机那轮 Claude Code 开着或看不出就这次不写、先备份。切回官方账号不收回（里面是官方型号名，认不出是谁写的）。
- `electron/config-files.ts`：写当前账号的 Codex、Grok 配置时，配置目录（`~/.codex`、`~/.grok`）里一份全局说明都没有，就在同一次两阶段提交里放一份 `AGENTS.md`（`MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS`：始终用简体中文回复，代码、命令、路径、报错原文不翻译）。Codex 认 `AGENTS.override.md` 和 `AGENTS.md`（10-23 源码 `codex-rs/codex-home/src/instructions/mod.rs`），Grok 1.0.70 自带说明里 `~/.grok/AGENTS.md` 是全局规则、同目录 `AGENT.md` / `CLAUDE.md` / `CLAUDE.local.md` 也认；这几个名字有任何一个（大小写不论，链接也算）就一个字不碰。照 Claude Code `language: 简体中文` 的做法：老客户开机按模板第 6 版（`relayTemplateRevision` 5 → 6，第 5 版是同批的 VS Code 免登录）补一次，切回官方账号不收回。发出去的这一版摘要记在 `PUBLISHED_GLOBAL_RESPONSE_LANGUAGE_DIGESTS`，以后认得出是不是星芒放的。
- `electron/cli-verified-versions.ts` 每周巡检（10-19 那次核过、没合，10-26 并成一次）：Claude Code 2.1.302 → 2.1.310，新加 `blocked` 区间 `[2.1.304, 2.1.305)`（上游写明 2.1.304 起接自定义 `ANTHROPIC_BASE_URL` 默认开工具搜索，网关拒收时每次请求都失败，2.1.305 修）；沙箱假接口对工具搜索回 400 时 2.1.310 去掉重发、照常回复。Codex 0.162.1 → 0.164.0（release note 没有碰自定义 provider 的条目，随包型号名单的 tag 换成 `rust-v0.164.0`，`models.json` 逐字相同、sha256 不变）。Grok 1.0.52 → 1.0.70（npm latest 且是 xAI stable，假接口上 K1/K3/K4/钩子与装插件的 `--trust` 重核通过）。依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- 手机遥控 Codex 的底座和飞书渠道：`codex-remote-service.ts` 管配对（6 位码 10 分钟、错 20 次作废）、只认绑定那个人的私聊、
  一次一轮、审批转到聊天（10 分钟没回自动拒绝）、回话脱敏（I13）、闲置 4 小时断开；Codex 用客户装好的命令行工具起
  `codex app-server`（stdio，argv 不经 shell，I1），开对话固定 `approvalPolicy: untrusted` + `sandbox: workspace-write`，
  不给完全权限、不自动同意。飞书走开放平台长连接（帧格式照官方 SDK 逐字节对过），请求一律经 `codex-remote-http.ts`（I10）。
- Windows 上星芒以管理员身份或高完整性运行时不许开遥控；「打开遥控」开关不落盘，开机自启的星芒不会无人值守地连上。
  渠道凭据 `safeStorage` 加密，存飞书凭据那条通道记为密钥入参（I3）。
- 设置页新卡 `features/settings/codex-remote/`，渠道那一块按 `channel-sections.tsx` 登记，微信渠道接进来时只加一项。
- 新增 8 条 IPC：`codex-remote:get-state` / `set-channel-enabled` / `choose-workspace` / `start-pairing` / `cancel-pairing` /
  `unbind` / `clear-credentials` / `save-feishu-credentials`，外加推送 `codex-remote:state-changed`（整份快照带 `revision`，
  渲染层只收更新的那份）。有渠道开着时外壳状态栏亮「手机遥控中」（`useCodexRemoteActive.ts`），点了去设置里那张卡；
  「退出登录」挪到渠道标题行，各渠道共用。
- 微信渠道走腾讯 iLink（ilinkai.weixin.qq.com）长轮询，收发和扫码的写法照 @tencent-weixin/openclaw-weixin
  2.4.10（MIT）核对，代码自己写：`electron/codex-remote-weixin-api.ts`（请求，只认 https 的 *.weixin.qq.com，
  redirect_host 和 baseurl 都过这道；64 位消息编号保精度解析）、`codex-remote-weixin.ts`（渠道，只交回扫码人的
  消息、也只往他那里发；-14 和 401/403 报 needs-login 不再重试；context_token 过期去掉重发一次）、
  `codex-remote-weixin-login.ts`（扫码登录，二维码在主进程画成图，令牌直接进底座的加密凭据存储，不过 IPC）。
- 设置页微信那一块 `WeixinRemoteSection.tsx` 登记在 `channel-sections.tsx`：拿二维码走卡片的 `run`，扫码弹窗里的轮询和输数字
  自己管，登录好了靠主进程推的快照变成「已登录」；退出登录用卡片共用的那颗。
- 新增三条 IPC：`codex-remote:weixin-login-start` / `-poll` / `-cancel`，成功不记日志（结果是登录二维码）。
- 手机遥控 Codex 开着时挡住系统自动睡眠（0.2.22 审查 YK-1）：新模块 `codex-remote-keep-awake.ts` 跟着底座推给界面的快照走，
  任一渠道开着、状态是正在连 / 已连上 / 连不上正在重试，就拿一个 `powerSaveBlocker('prevent-app-suspension')`，
  全关了、要回电脑上重新登录了、闲置 4 小时自己断开了就放开；快照按 `revision` 只认新的那份。以前人一走开，
  Windows 笔记本、Mac 十几二十分钟就睡，飞书长连接、微信长轮询一断，手机上发消息没人理；Codex 自己的
  `features.prevent_idle_sleep` 只管它跑一轮，两轮之间等手机那段不管。跟终端工具、装东西时的防睡是同一种挡法：
  屏幕照样按设置关，合盖照样睡，不改系统电源设置。
- 产品负责人 2026-10-26 北京回「防睡改」：「打开遥控」那行说明前面加「开着时电脑不会自己睡着，合上笔记本盖子还是会睡。」；
  托盘挡睡眠那行加「手机遥控开着，暂不让电脑自动睡眠」，排在终端工具干活之后、装东西之前（`trayKeepAwakeLabel` 的 `remoteControl`）。
- 已知37：同一个站换账号、在「同步到工具」里勾上 Claude Code、Codex 以后，借它们那把的 Claude Desktop、WorkBuddy、
  OpenCode 跟着换成新账号的密钥。以前 #1113 只认当前账号名下的归属，换了账号以后客户端还拿着上一个账号的 Key，
  照样扣上一个账号的余额，首页却说它用的是别处的配置。
- 认法（`external-client-route-service.ts` 的 `externalClientKeyChange`）：首页认它不是当前账号那份；它那把是这个站
  别的账号缓存里给某个工具的托管 Key（`managed-cli-key-store.ts` 新加的 `readOtherAccounts`，`main.ts` 经
  `readOtherManagedCliKeyAccounts` 交给系统服务）；归属记在那个账号名下、来源不是 `manual`；那个工具现在用的就是
  当前账号缓存里那把（换账号时勾了它）。没勾的工具，借它密钥的客户端也不动。只换 Key，规矩同 #1113（型号要还在、
  开着等它退出、星芒关了下次开机补）。先把归属记到新账号名下再改客户端，中途断了下次检测照样认上一个账号那份。
- 换到另一个站（星芒账号和历史账号互切）不跟：客户端地址还在原来那个站，要换地址和 Key 两样，没做。
- 保存配置后台那一眼（`followManagedKeysNow`，取代 `config-save-service.ts` 原来的 `managedKeyFollowTarget` 加
  `scanExternalClients`）换成了会叫界面重读（`onToolRouteFollowed`）：换账号时首页在同步工具之前就读过客户端，
  不叫的话要等下次检测才显示已换好。#1113 撤销、重签那条路也一起受益。
- 只看缓存就能定的先定：这台电脑上没换过托管 Key、也没有别的账号时，跟以前一样一个工具配置都不读。
- 「切换账号」框「同步到工具」下那句跟着改准：以前说三家客户端「不会跟着换」，现在说借工具密钥的勾上那个工具就跟着换、
  星芒账号和历史账号互切时不换、自己填的不换（`SavedAccounts.tsx` 的 `accountSwitchDesktopClientsHint`）。
- 同类对比第 1 条（`/mnt/project-files/优化研究/同类对比.md`）。`features/extensions/mcp-paste.ts`：粘贴框认
  `mcpServers` / VS Code `servers` / OpenCode `mcp` / Zed `context_servers`、单独一条、`"名字": { … }`（JSONC，带注释、
  尾逗号、中文引号也认）、Codex / Grok 的 `[mcp_servers.名字]`（只认片段用得到的一小块 TOML，认不全就整段不认）、一行启动命令、
  一个地址、`claude|codex|grok mcp add …` 和 `claude mcp add-json`。认出来的照原样填进原表单，提交照旧走 `submitMcpInstall`；
  SSE（Codex 不认）和别的连接方式不悄悄换成 http，直接说加不了。还是示例文字的设置、请求头（`<…>`、`${…}`、YOUR_…KEY、
  「您在…申请的」）点名提醒，不拦。
- 网络服务补请求头：`ProviderMcpInstallConfiguration` / `HttpMcpInput` 的 http 分支加可选 `headers`，缺省 = 旧行为。
  Claude Code 2.1.310 拼 `--header "名称: 值"`（可变参数，放在名字和地址后面），Grok 1.0.70 放在前面（一个开关一个值）；
  `codex mcp add` 0.164.0 没有请求头开关，带请求头时装没装 CLI 都直接写 config.toml 的 `http_headers`（沙箱里三家实测，
  Codex 用 `mcp get --json` 核过认得）。值进 `sensitiveValues`，列表照旧只回名字。校验在新的零依赖模块
  `electron/mcp-http-headers.ts`（名字是不以 - 开头的 HTTP token，值不许换行和 NUL），IPC 解析、主进程拼命令和界面共用。
- 「自定义连接」加之前先问勾上的别的工具有没有同名连接（`mcpNameTakenIn`）：Codex、Grok 加同名的会把原来那条整条换掉，
  客户在那边自己配好的密钥就没了。读不到列表的工具不拦。
- 画布生图停止后保住已扣费的图（#1394 第 6 条，从画布合并方案里拆出来先做）：画布那份
  `createAiImageService` 打开新选项 `finishDispatchedAfterStop`。点停止、关窗、换号时，还没发出去的请求照旧
  取消；已经发出去的只放开等待的一方，请求按原来的总超时继续跑，收到的图用发请求时解析出的账号存进
  那个项目的素材库，再用新的 `AiAssetMetadataStore.addTag` 追加标签「已停止，但已扣费」（不动客户自己的
  标签）。放开以后不再报进度，换号后新账号的画布收不到它的任何东西；它照旧占着生图队列的位置，
  `whenIdle` 不等它，换号不会被它卡住。结果只进运行日志（`canvas` / `image.after-stop.*`）。AI 对话页那份
  不开这个选项，停止照旧掐断，补了回归测试。运行记录这次不加字段，留给 #1394 主体。
- 新增 `electron/update-install-prompt.ts`（#1380，yoyo 10-25「先弹窗装，然后再闲时装」选了跳框，字按「更新改」那版）：
  这次运行里在后台下好的版本跳框问（`dialog.showMessageBox` 挂在主窗口上，窗口缩着就先叫出来、点「稍后再说」再缩回去；
  默认和取消都是「稍后再说」；电脑 3 秒没人按键盘、动鼠标才弹；每个版本每次运行最多问一次；关了自动更新、Windows 标准账号、
  交给系统安装器的、打开时就已下好的不问）。装的时候不弹窗口的 Mac（`canInstallUnattended`）另做闲时装：电脑 10 分钟没人碰
  或锁屏、星芒窗口都缩着（含最小化）、没在装工具、CLI 没在干活、加速没开，点过「稍后再说」的再等 10 分钟，照开机后台装那样先记
  `attemptedVersion` 和 `backgroundInstall` 再装，装好照旧待在菜单栏，每版只试一次。框开着而人走开了（10 分钟没人碰或锁屏）
  用 `signal` 收掉框再闲时装；下好时就没人在的不问直接等。Windows 不做闲时装（每次装都要点授权窗口）。
- 上面两处后来改了，以后面的分片为准：「打开时就已下好的不问」见 `update-install-prompt-launch-held.md`（#1439，只排除自动装
  已经接手的那一版）；「下好时就没人在的不问直接等」见 `update-install-prompt-away-window-open.md`（#1444，窗口开着时等人回来再问）
  和 `idle-install-waits-remote-video.md`（#1438，手机遥控开着时也等人回来再问）。
- 侧栏「设置」上面加更新入口（yoyo 10-27「客户不知道在哪更新」，回「侧栏改」，字按那一版）：0.2.19 把「更多 › 更新」并进了
  「设置」最后一项，有新版本时侧栏没有任何标记。`registry/business.ts` 新增 `updateSidebarEntry`：available（不是退回旧版）
  「有新版本 v…」、downloading「正在下载新版 N%」点了去版本更新卡；downloaded「重启并安装新版」（Linux「安装新版本」）点了走
  `requestUpdateInstallConfirm` 弹现有的「重启并安装更新？」确认框。带 error 的不出，失败照旧由气泡和版本卡说。
- 侧栏「设置」补上 v4 原型里的 `updDot` 小点（`v2-nav-dot`，读屏「设置，有新版本」），和设置里「版本更新」那一项同一条件。
- 气泡：downloaded 加「重启并安装」，没开自动下载的 available 加「下载更新」；人就在版本更新卡前时不再摆第二颗。
  点 × 后改记 `{ key, at }`（`features/app/update-dismissal.ts`），同一句话满 24 小时再出一次，原来是到退出星芒前都不出。
- 状态栏版本号 downloaded 时由「重启后更新」改成「新版已下好，点这里安装」（缩在托盘的人关窗口不算重启），点了同样弹确认框。
- 金色用深色主题主按钮那份（`--nav-update-*`，浅色主题主按钮是藏蓝）；高对比度下照主按钮画，Windows 高对比度主题加边框。
- `acceleration-development-host.ts`：辅助进程初始化报 `proxy-owned`（上一个星芒的辅助进程或 Mac 系统代理组件还握着
  恢复记录）时不再当场失败，先等它（`accelerationPreviousOwnerRetryAtMs`）：每秒 lstat 一次恢复记录，记录从「在」变成
  「没了」就马上再拉；记录一直在就在 5、15、30 秒各再拉一次；刚失败的那个辅助进程没退干净之前不拉新的；这段时间里来的
  请求都跟着它（`launching`），退出时撤掉。结果记 `acceleration.previous-owner.wait`（`waitedMs`）。10-25 客户 Mac：
  13:11 打开 Codex 时自动连的加速到 13:19 重开星芒时才收回，退出只等 2 秒、Mac 改回系统代理要再输一次密码，新进程
  13:19:36 起来时旧的还握着锁，`acceleration.helper.failed` proxy-owned busy、get-state / list-lines 报「请完全退出软件」，
  13:20:09 才自己好。
- `codex-desktop-acceleration.ts` 新增 `codexDesktopAccelerationNeed` / `createCodexDesktopAccelerationNeedReader`：
  「Codex 是不是只在启动时要加速」那一问答案变了就记 `acceleration.codex-desktop.need`（`startup-only` / `not-relay` /
  `chatgpt-login` / `unknown-login` / `shadowed` / `unreadable`），判断本身不变。同一次客户日志里 13:11 那次没有每次都有的
  `codex-desktop.startup-route.*`，只能倒推出那一下判成了「要一直连着」（等 Codex 退出才断），看不出是哪一条没过。
- 退出时有加速会话就记 `acceleration.quit.stop`：退出只等两秒，没收完的由辅助进程接着改回，以前日志里一个字都不留。
- 匿名使用统计（2026-10-26 yoyo 选的推荐档）：开着时每天最多成功发一条，内容整个写在地址里，GET 到更新目录的
  `stats/v1/…`（连不上 Cloudflare 才改发 xm-direct 同一地址），update-feed-stats 工作流按地址数，Summary 页多一节「每天打卡」。
  不带电脑编号：客户端保证一天只发成一条，所以一天一条就是一台电脑，Windows 走线路2 的也数得到。
- 一条里有：星芒版本、系统（Win10/11、macOS 大版本、Linux）、芯片、账号类型、线路、自动更新开没开、下好没装/装了没装上、
  各工具装没装和版本，以及攒下的安装失败、更新失败（按报错归成五类，原文不发）、窗口没响应、主进程卡顿、付款页慢或没打开、
  意外退出的次数。每段都从固定缩写表或版本号样式来，认不出的写 x（`electron/usage-stats.ts`，纯函数全测）。
- 发送和本机计数在 `electron/usage-stats-reporter.ts`：开机 3 分钟后发、之后每 6 小时看一次换没换天，一天最多试 3 次；
  不带 cookie、拒绝重定向、10 秒超时、读回包限 16 KB（I10）；计数文件 `usage-stats.json` 走 safe-local-data 原子写，
  每种最多 99、最多留 7 天，关掉开关当场删掉（设置页存好开关后经 `platform/privacy-change-bridge.ts` 告诉主进程，
  不等下一次定时检查）。开发版、本机自编版、CI 和 `XINGMANG_DISABLE_USAGE_STATS=1` 不发。
- 开关是系统界面设置里原有的 `privacy.anonymousUsage`：没碰过 = 开，文件里存着 false 的照旧关。登录后一次性卡片
  （`AppSettings.usageStatsNoticeShown`），错误报告那张这次出过就等下次打开。不新增 IPC 通道：`registerIpcHandlers`
  多一个可选的 `observeOperation`，参数只给 `cli:install` / `external-clients:install` 的第一个（装哪个工具）。
- 新手引导装工具失败、认出是网络那几类时，红字接上下一步（主路卡点 F12）：证书日期对不上、连接被网络拦截、
  连不上下载源三类接错误目录里现成的正文（「换个网络（比如手机热点）」那句），把正文里的「重试」换成引导里的
  按钮名「再试一次」，后面不再接通用的「点『再试一次』，还不行就点『需要帮助』」；连不上 npm 官方源时把主进程
  那句最后按平台写好的下一步（开加速或换个网络）取出来放上红字，和没拿到管理员授权那句一个做法（#1096）。
  以前只把目录标题放进括号，下一步折在「给客服看的原话」里看不到。没有新写的字，主进程和错误目录都没动
  （`StartGuide.tsx` 的 `guideInstallFailure`）。
- 新增 `electron/renderer-release.ts`：主窗口缩在托盘里满 10 分钟、界面报告手上没事、主进程没在退出 / 装东西 / 付款，
  就用 `forcefullyCrashRenderer` 关掉界面进程省内存（窗口留着，Windows 关机询问、托盘照旧）；点托盘或任何入口叫出来时
  按原地址重新加载（Linux 上实测欢迎页约 0.3 秒回来）。界面没报告过忙闲的（legacy 回滚版）一律不关。主进程那一声「界面进程没了」
  不记成崩溃；关着和重新加载那一会儿托盘、系统通知、深链、platform「打开某页」要的跳页先存着，新界面第一次报告时再发。
- 界面经新通道 `window:report-activity` 报告忙闲：`background-work.ts` 登记聊天生成、视频制作、工具任务、登录后同步密钥，
  再加开着的对话框（对话框一开就报，Linux 上窗口藏起来不来 visibilitychange）。重新加载的那一次 `getWindowCapabilities`
  带 `rendererRestored`，界面回到关掉前停的那页（sessionStorage），不再弹开机提示、不再跑开机检查和检查更新，登录恢复那一轮静默；
  关掉过的更新气泡、维护提示、线路重启提示也记在 sessionStorage，不会重新冒出来。
- 「余额低于 5 美元」「花费突然变多」两个系统通知从界面搬到主进程（`balance-alerts.ts`、`spend-spike.ts`），界面关着也照常提醒；
  花费突增 6 小时内只提醒一次的记录从 localStorage 换成 userData 的 `spend-spike-notified.json`，升级后第一次最多多提醒一次。
- 新增 `electron/released-renderer-watch.ts`：界面关着时每 10 分钟读一次余额（托盘与上面两个提醒照旧），看缓存的公告，
  有界面没见过的新公告、或有充值活动（每天一次）就叫醒界面让它照旧弹公告；窗口仍在托盘，叫醒后再满 10 分钟又关。
- 已知小差别：重新加载后滚动位置不保留；关着时模板填写的失败重试暂停，叫出来再继续；只在界面里的事件关着时收不到，
  重新加载时会重新读一遍。
- 首页：主进程 `cliHooksAutoRepaired` 那一句从工具卡中间那行挪成右下角提示条，每家（Codex 命令行和桌面端算一家）这次运行只说一次（`Home.tsx` 的 `hookRepairsToAnnounce` / `cliHooksAutoRepairedText`）；说过的那几家另记在窗口的 sessionStorage 里，窗口缩在托盘久了界面重新加载（#1411）也不再说。原来整场开着都挂在卡片上，还顶掉了线路和版本（yoyo 2026-10-25 截图）。「修好它」那一档的说明同步改成客户读得懂的说法。浏览器用例 `a reminder setting fixed on startup is announced once and leaves the card line alone` 钉住。
- `realm-account-vault.ts`：系统加解密本身不干的那几步（`availability`、`encrypt`、`verify`）报的 STORAGE 错误换成
  `realmVaultKeyStoreRefusedMessage`（「账号安全存储不可用：系统加密服务没有放行，原记录未修改」），文件读不出、写不进、
  格式坏、换了密钥解不开（登录时照旧自动重建）仍是原来那句。错误码不变，运行日志里能看出是哪一种。
- 登录框（`features/auth/state.ts` 的 `authFailure` 新增 `os` 参数和 `keychain` 类）只在 Mac 上认这句，换成 yoyo 10-27
  批的那段字（「钥匙串改」），红字下面加「重新打开星芒」（走现成的 `window:relaunch`，不加通道）；Windows 和文件类失败照旧。
  起因：10-27 有 Mac 登录报「本地账号安全存储暂不可用」，查下来是升级后钥匙串弹框被拒，这次运行里拿不到钥匙串，
  原来那句只叫人「完全退出后重试」，没说重开后那个框怎么点。
- 新增 `electron/mac-keychain-update-copy.ts`（零依赖，进 `valueImportable`）放 `macKeychainUpdateHint`，原来那句从
  `VersionCard.tsx` 挪过来，字不变；只在 Mac 上补到跳框（`buildInstallPrompt`）、必须更新那层（`RequiredUpdateGate` 新增可选
  `mac`，缺省不显示）、打开时/退出时自动装的通知和窗口预告卡（`buildAutoInstallNotice`）、退出时那一问（`quitInstallPrompt`
  新增可选 `platform`，缺省 = 旧行为）。Windows、Linux 的字不变，测试钉住。yoyo 10-28 回「钥匙串提示改」。
- 起因：自签证书没有苹果团队号，登录钥匙串按每一版的程序指纹（`cdhash`）放行「xingmang-ai-manager Safe Storage」，每升一版
  第一次打开都会在窗口出来之前弹密码框（10-28 升级冒烟在 runner 上对照过）。签名身份本来就没变，解决不了；不换成苹果开发者
  证书，代码里只能事先说清楚。
- `new-api-client.ts` 新增 `createSessionRequestGate`：改密码独占这份登录：一开始就挡住新的账号请求，等已经发出去的回来再改，改完才放行（放行后的请求用改密码换回的令牌）。rc.44 `UpdateSelf` 先改密码、同步发安全提醒邮件、最后才把本机登录升到新版本，中间到的请求 401，续期时 `RefreshLoginSession` 以 `user_security_changed` 作废整个登录（2026-10-27 客户找回密码第 3 步撞上：读余额插进了这段空当）。个人中心改密码走同一个请求，一并盖住。
- 登录框 `AuthFlow.tsx`：改密码报错时先看错误能不能说明「没改」，说明不了就拿新密码试登一次，登上就照改成功处理、记新密码，登不上才亮临时密码，连不上就退回登录框、什么也不记；进软件前（含「继续」）先问主进程 `account:get-session` 是不是还登着这个账号，不再照着登录结果把界面硬摆成已登录。
- `build/installer.nsh` 接管 `customUnInstallCheck`：旧版本的卸载程序（`--updated` 静默）挪不走旧文件、把挪开的放回去并以 2 退出时，
  模板只弹没翻译的「Failed to uninstall old application files. Please try running the installer again.: 2」就 `Quit`
  （10-27 yoyo 真机升级撞到，重启后再装就好）。现在弹中文的「重试 / 取消」：重试先用系统目录里的 `taskkill.exe /F /IM`
  强关星芒（模板在 PowerShell 用不了时按整台电脑安装的那句不带 `/F`），再跑一遍旧卸载程序；取消跟模板一样以 2 退出，旧版本原样。
- 清单里有、安装目录里已经没了的条目不再卡住升级：新安装程序在跑旧卸载程序前先把这些项从 `InstalledEntries` 删掉，
  新卸载程序的 `un.xingmangMoveAside` 也把「本来就不在」算成挪开了。以前这种情况每次升级都弹同一个英文框，重启也没用。
- `windows-uninstall-smoke` 加 `scripts/windows-upgrade-blocked-smoke.ps1`：在 Windows runner 上真装最新正式版再拿这次的包升级，
  覆盖「清单项已没」与「文件被占着 → 中文框 → 取消原样 / 放开后重试装上」。
- Claude Desktop 的型号菜单就是配置里的 `inferenceModels`：3.6556.2 安装包里网关的 `adminListObviatesDiscovery`
  在清单写满完整型号名时跳过 `/v1/models`，菜单只有清单上的几个，第一个是默认；#746 起只写选中的一个，客户就换不了。
- 新的 `electron/claude-desktop-models.ts`：保存时选中的排第一，其余是这把密钥列着的 `claude-*`（`sortClaudeModelsNewestFirst`
  按版本新到旧，连同选中的最多 8 个），每个照 Claude Desktop 的启动检查发一个字（`POST /v1/messages`，`max_tokens: 1`，
  8 秒超时，最多同时 3 个），通了才写，没通的进运行日志 `external-client.claude-desktop.models`。中途换了账号就什么都不写。
- 多个型号写成 `{ "name": ... }`（3.6556.2 两种写法都认），开机的 `claude-desktop-model-repair.ts` 只认 0.2.12 的字符串写法，
  不会把新清单改回一个；只有一个时照旧写字符串。
- 0.2.12（#685）不加核对地写全部 `claude-*` 出过「型号被拒、发消息没回复」：Claude Desktop 启动检查和起标题这类后台小活
  先挑 Haiku（`claudeDesktopStartupCheckModel` 照它 `probeInference` 的挑法：haiku → sonnet → opus，同档挑名字最短的，微调排后），
  中转列着的不一定发得通（推测）。所以连接自检在默认型号之外，再用启动检查挑的那个问一次，不通就报那个。
- 已经配好的老配置不自动加，要客户在星芒里重新保存一次。
- #1393 1b：`canvas-v2/src`、`canvas-v2/shared` 换成 xingmang-canvas 的 `kernel-v0.1.0`（a8db24a），由
  `scripts/sync-canvas-kernel.mjs` 同步，`canvas-v2/KERNEL_SOURCE.json` 记 tag、提交号和每个文件的 sha256。
  桌面自有文件只改 `canvas-v2/vite.config.ts`（入口那份配色换成 UI v4 的、`__XINGMANG_CANVAS_HOST__` 定为桌面）和
  `canvas-v2/package.json` 的说明，tsconfig 照旧 ES2022。以后改画布去 xingmang-canvas 改，再按 tag 同步（AGENTS.md T13）。
- `e2e/canvas-*.tsx` 夹具改由 `canvas-v2/tsconfig.json`（`canvas:prepare` 第一步）做类型检查，根 tsconfig 不再收它们：
  关窗夹具会把整个内核拉进根 tsconfig，那边的 `react` 指向旧界面的 React 18 类型，内核按 React 19 写（`inert`、
  `RefObject<T | null>`），在那里编不过。
- 审查 #1489 的 D01、D03（画布那半）、F02、O13、O15 随新内核修掉；D07、D08、D09 新内核里还在，回 xingmang-canvas 修。
- 旧画布的 74 个测试文件由内核里的 `*.v2.test.ts` 接替：53 个原样、21 个改过期望或退役，逐条理由见 xingmang-canvas
  `docs/canvas-kernel-v2-tests.md`。画布测试从 74 个文件变成 495 个（6834 条），Linux 上串行约 7 分钟；
  `scripts/vitest-shards.mjs` 记上最慢的五个，Windows 四片照旧按时间发牌。
- 新的 `electron/canvas-kernel-capabilities.test.ts` 钉住内核认得出桌面的 `capabilities()` 声明：内核读不懂时会悄悄
  退回 v2 那套能力，哪里都不报错。
- 随内核带进来的 OpenCV 抠图运行时（OpenCV 4.13.0、Emscripten 4.0.20、Apache-2.0）登记进第三方台账；它里面 Emscripten
  通用的读文件代码有 1 处 `fetch`、5 处 `XMLHttpRequest`，出网门禁只给这一个文件开例外、个数钉死（放宽，yoyo 10-28 亲手同意）。
  这份构建不读外部文件，画布 CSP 的 `connect-src` 也只放行 `xingmang-asset:`。
- `docs/RELEASING.md` 第 8 节改对：0.2.22 不认新内核写的字段，退回期间在 0.2.23 里改过的画布工程打不开；
  退回下限不动，画布出问题用撤回加快修版。
- 下好以后照样定时查（0.2.19 排查第 2 条）：`updater.ts` 新增 `refreshDownloaded`，`scheduledCheck` 在「已下载」时走它，
  `main.ts` 的定时器不再一见「已下载」就跳过。它照常先读状态文件、再让 electron-updater 查一次，但这一趟的「正在检查」
  「没有新版本」和查没查成都不进快照，手里那份和「重启并安装」、安装失败的横幅原样留着；更新目录给了比手里这份新的版本，
  才丢掉它、落成「有新版本」，自动更新开着就接着下（日志 `download.superseded`）。没查成时 `scheduledCheck` reject，
  照旧由定时器记 `scheduled.check.failed`。
- 撤回名单、分批放量照旧在 `isUserWithinRollout` 里拦，被拦下的版本对这一趟同样是「没有」；手里这份自己被撤回时，
  照原来那样先收回，再照常查一次换下替它的那一版。
- 不换的几种：正在装、开机装正在倒数、Mac 这次运行已经交给 Squirrel 装过一次（Squirrel 可能已经取走了这一份）、
  跳框正问着装不装（`update-install-prompt.ts` 加 `prompting()`，定时器这时先不查），以及自动更新关着、手里这份又够得上
  最低版本（换了还得客户自己点下载）。
- 状态文件把最低版本抬到手里下好的那一版以上时不等三小时，马上对一次：以前强制更新门里点「立即更新」装的是手里那份旧包，
  重开后又被拦一次。
- 手动检查（`check()`）在「已下载」时照旧直接返回：界面这时只给「重启并安装」，没有检查按钮。代理连不上换直连、线路2 没走通
  换线路1 这两条重查从 `check()` 里抽成 `checkWithFallback`，两边共用。
- Windows 上装或更新 Codex 桌面端之前，`installCodexDesktopFromSources` 以前同时起四条 PowerShell（查包、开始菜单、
  进程各 8 秒，商店可用性 10 秒）。10-28 一位客户（0.2.22）每次点「更新」都死在查包那条，整步 10.2 秒，跟商店那条的
  10 秒时限对得上；首页那条合并脚本在同一台电脑上答得出来，「更新」按钮就是它给的。现在前三样改用首页同一条合并脚本
  （`runCodexDesktopCombinedProbe`，24 秒，三段解析与分开跑时一致），商店那条等它答完再起，顺序收在
  `inspectCodexDesktopBeforeInstall`。时限、环境变量、脚本内容都没改；正常电脑上多等一条商店查询的时间（约半秒）。
- 合并脚本整体失败时，`buildCodexDesktopCombinedProbeFailure` 把 powershell.exe 的原始错误挂成 `packageProbe.cause`，
  更新前查版本失败的日志和 #1512 一样看得到超时、退出码和 stderr。
- 装完以后的核对（`verifyInstalledCodexDesktop`）和卸载仍单独跑查包那条（8 秒），这次没动：那时没有别的 PowerShell 同时在跑。
- 三线路方案的 C8 前半（`docs/DIRECT-ROUTE-THREE-LINES.md` 4.3 节，10-29 yoyo 亲手打字同意）：来源记录 0.2.6 才开始写，0.2.5 及更早替客户写的
  工具配置没有记录（或只有不认账号的 v1 记录），首页凭 `configurationAccountMatched` 显示「已连接」，开机对账和换线的
  定点改写（`tool-route-follow-service.ts`）却因来源不是 account 一直跳过，地址停在线路1。现在来源读成 `unknown`、
  记录上没写过 `manual`、连着本站、有 Key、Codex 不是 ChatGPT 登录（`permitsUnrecordedRouteFollow`），而且 Key 正是
  当前账号签给这个工具、本机缓存着的那把（新可选钩子 `ToolRouteAccountHooks.accountKeyMatches`）时，也只换 base_url。
  来源记录原样放回（`ToolConfigOwnershipStore.remember`），补设置、换 Key、换型号这些自动改写照旧不碰它；`manual`、
  `changed` 照旧不动。迁移前原件、回读核对、被改回两次就停手（`managedElsewhere`）、故障换线的重开提示都和来源是
  account 的那份一样。日志 `route.followed` 多带 `unrecorded: true`。
- Codex 桌面端离线包同步（`sync-chatgpt-official-cos`）不再在 x64 先传上新版时删掉桶清单里的 ARM64 条目：两个 Windows 架构各带自己的包版本，没跟上的那个保留上一次核过的包和许可，等它自己的作业成功再换；生产者校验改成「任何一条都不能比 `windows.buildVersion` 新」。以前 ARM64 那次传不完（#1047 第 47、48 次）时 ARM 客户在桶里一份都没有，只能退回商店和官网（#1061 第 8 条）。
- 客户端读 `chatgpt/latest.json`（`electron/desktop-package-bucket.ts`）跟着改：Windows 条目的包版本不比 `windows.buildVersion` 新就认，不再要求两者相等。包的真假照旧靠固定桶地址和路径、清单里的大小和 SHA-256、下完核的包身份、发布者、微软签名和版本，这几道一条没动。0.2.21 及以前的客户端遇到落后一版的条目照旧不认、走原来的路，和改之前一样。
- 跟「先等包」（#1404）接上：x64 已换新版、ARM64 的官方包还是上一版时，ARM64 那条留在桶里，这次作业算等包、不再报 `package-version-behind`。所选作业全成功后的终验（`verify-chatgpt-cos-index.cjs`）照旧只查缺项，不把留在上一版的架构当没同步完，免得等包时白报警。
- Windows 打包版的启动参数改成白名单（#1065 剩下的第 1 步）：`security.ts` 的 `resolvePackagedLaunchArguments` 只认开机自启 `--launched-at-login`、更新后重开 `--updated`、卸载清理两个参数、加速辅助进程和它的 `--user-data-dir`、通知冷启动的 `-Embedding` / `-ToastActivated`，以及深链这类不像开关的参数。别的开关不再放过：`platform/entry.ts` 去掉它们用 `app.relaunch` 重新打开一次（同一个令牌，以管理员身份运行的还是管理员），而不是让客户打不开；重开出来的进程靠环境变量 `XINGMANG_RELAUNCHED_WITHOUT_SWITCHES`（`launch-argument-relaunch.ts`）认出自己，还带着就退出不再重开，去掉的开关名记进运行日志 `launch-arguments.relaunched`。黑名单上的调试、拉起命令开关照旧直接退出；卸载清理和加速辅助进程带了多余开关也直接退出。Mac 不提权、Linux 不许 root，只用黑名单。Windows CI 的 `e2e/packaged-hardening-smoke.mjs` 补了「去掉开关重新打开」和「重开的那次不再重开」两段真跑。
- `electron/config-files.ts`：新增 `leaveCodexDesktopChatGptWorkMode`，在保存配置的 `applyCodexRelayConfig` 里调用（当前账号、
  自己的密钥都走这里）：`[desktop] conversationDetailMode = "STEPS_PROSE"`（桌面端的 ChatGPT Work）换成 Codex 模式的缺省
  `STEPS_COMMANDS`；没写这个键、写的是 `STEPS_EXECUTION` 都不动；`[desktop]` 里别的键原样（#1353）。切官方账号时恢复的
  官方那份原样带着客户选的模式（登录了 ChatGPT 账号 Work 能用）。
- issue 按 Windows 版 Codex 26.1013.4894 的程序核对过：Work 模式＋内置浏览器插件＋没登录 ChatGPT 三样同时成立才报
  「Work browser access requires an authenticated account」，而且要先从 statsig 读到账号的工作模式策略才查，所以时好时坏。
  本仓库拿不到桌面端安装包，这几个取值照 issue 写，没在本机再核。
- 不进开机补设置（`fillCodexRelayTemplateDefaults`，`relayTemplateRevision` 不动）：这是客户自己选的值，开机补完那句提示
  （`toolTemplateFilledNotice`）说的是「自己改过的设置都没动」。issue 里建议的「检测到就问一句要不要切回」要新的界面文字，
  这次没做。
- 测试：`config-files.test.ts` 加三条（保存时换、切官方账号换回客户选的；另一档模式和没写的不动；开机补设置不碰）。
- 建窗口不再等安装包里的加速文件校验完（0.2.22 性能体检第 4 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。三十多兆的内核
  每次开机要整读一遍算 SHA-256，原来 `electron/main.ts` 在建窗口前 `await` 它；慢盘、杀毒软件逐字节扫的电脑上推测要 0.5~2 秒，
  绝大多数客户又根本不用加速。读还是开机就开始，跟以前一样和迁移、命令行探测叠着跑。
- `electron/bootstrap/acceleration.ts`：`createAccelerationHost` 改收这个读的 Promise、自己是 async，读完那一刻建宿主、立刻
  `recover()` 改回上次崩溃没改回的系统代理，不等任何人用加速，所以开机恢复代理不会被推迟或丢掉。`createAccelerationServices`
  改收 `host: Promise<AccelerationHost>`，加速服务照旧在注册 IPC 之前同步建好。
- `electron/acceleration-service.ts` 新增可选的 `ready`：后端和「文件坏了」晚到时，用到后端的操作都排在它后面（服务那条串行队列
  从等它开始）；到手之前 `awaitingPreviousOwner` 答「没在等」，「重新检查」那一项也还没有。`recheckAccelerationBundle` 在服务和
  `createUserAccelerationApi` 上都改成每次现看的 getter，坏没坏照旧只在启动时读坏了的那次运行才有。不给 `ready` 的是旧行为。
- `electron/main.ts`：「加速开没开」（绕不绕系统代理、导出诊断）在宿主建好以前直接答「没开」，不陪着等加速文件读完：
  开机系统代理连不上时恢复登录要靠它马上答才改直连，以前加速服务还没建好的那段也是这么答的。下载线路等宿主建好才接上；睡眠唤醒的两个监听一直挂着，没有宿主（还没建好、Linux、加速文件没带或读坏了）
  时什么都不做，跟以前不挂一样；退出时放掉宿主那一步等这个 Promise，退出时还没读完的，读完建出来的那个也放掉。
  `main.test.ts` 跟着改了这几处的源码钉子，另加一条：启动回调里不许 `await` 加速文件的读取或宿主。
- 校验改成一块块算：`electron/bounded-file.ts` 新增 `readBoundedFileDigest`，跟 `readBoundedFile` 同一套检查（打开前后路径快照、
  `O_NOFOLLOW`、单链接普通文件、大小上限、读前读后 fstat 比对），每次读 1 MB 交给 hash，只交回摘要、大小和要的前几个字节。
  开机峰值少占三十多兆内存（推测），主线程上也不再有一次算完整个缓冲区的长摘要。`acceleration-bundled-config.ts` 改用它，
  `assertSafeDataFile` 和两个上限（内核 100 MB、节点 2 MB）照旧；Mac 内核的 Mach-O 检查改看前 32 字节加整个文件的大小
  （`assertMacosAccelerationBinary` 加可选的 `byteLength`，其他调用方不变）。
- 网络加速下线（2026-10-30，yoyo 回「下线改」，方案 /mnt/project-files/加速下线/方案.md）：`platform-capabilities.ts` 的 `acceleration` 三个平台都给 false，照 Linux 现成的藏法去掉加速卡、托盘那一行、搜索和口令、「加速提醒」、关闭按钮说明里的「加速」、在线换节点；装工具连不上 npm 官方源时改说换个网络。
- `bootstrap/acceleration.ts`：Codex 启动选路的 `ensureAccelerated` 直接给「没连上」（不读加速状态，Windows 照旧立刻失败），不再给 `prepareClaudeDesktopLaunch`；加速服务的新连接一律按停用挡掉（冻结的旧回滚界面还有加速页）。
- 教程「网络加速」一章和它的示意图去掉；检查页不再有「加速功能」一行；设置组「网络加速」改名「网络连接」。
- 加速下线后还在说加速的字（0.2.23 发版前回归核查一般 1～3、建议 6～7，yoyo 10-31 回「检查改」）：Claude Desktop 配置框
  那句不再说「星芒会在后台帮它连上下载线路」（`ExternalClientDialog.tsx`）；Mac 没放进「应用程序」时的三句去掉「加速和」
  （`macos-install-location.ts`）；Grok 下载卡住时改说换个网络（`grokDownloadStallMessage`）。更新说明去掉 018 那份的用户段
  （加速重开不再报错，跟本条打架）；本条用户段写明「用星芒账号」：Codex 中文由服务器代取只在星芒账号、星芒密钥、
  Codex 关着时从星芒打开才走（#977，服务端 10-31 已对所有账号放开）。
- 留着不动：安装包里的加速内核和开机改回残留系统代理的 `recover()`、退出和卸载时的清理、检查页「系统代理」认得星芒加速。去内核要先把 `recover()` 从加速文件上拆开，下一版再做。
- 画布换内核第一步（#1392，云端做的）：主进程先学会认 xingmang-canvas 内核写的工程和发的请求，这一版画布本身没有变化。
  工程校验器认六个新的节点字段（`dirty`、`imageCandidateCount`、`videoCandidateCount`、`outputText`、`promptReferences`、`textWebSearch`），
  设置里的数组放到 4096 项（蒙版笔迹），便签自己的 `settings.text` 当正文看、放到 10 万字且不再按链接或路径拦；提示词预设名放到 160 字。
  运行请求认内核新加的 18 个字段和 8 种内核才有的节点；桌面做不了的（一次出多张、联网搜索、蒙版、别的视频接口、
  这些新节点等）在发出任何付费请求之前整次拒绝，报中文原因，运行范围以外或已停用的不挡；Agent 发起的运行直接拒绝。
  引擎另有一道兜底，新节点绝不落到视频执行器。新增 `xingmangCanvasHost.capabilities()`（preload 里的固定字面量，不走 IPC，
  所有开关都是关），`createProject` 多收两个可选参数做「另存副本」（素材一起复制，只认本账号、未归档、有工作文件夹的源项目）。
  放宽经 yoyo 10-26 亲手同意（「画布放宽同意」）。契约样例在 `electron/fixtures/canvas-kernel-contract/`。
- 原定这些先单独发一版、当换内核以后的退回底线；10-28 改成和新内核一起发（#1393），所以没有能读新内核工程的旧版本：
  退回到 0.2.22 时，新内核存过的工程打不开、文件不动。细节见 `docs/RELEASING.md` 第 8 节「画布换内核期间的退回」。
- 新内核的桌面端冒烟（#1393 D-PR3）：`e2e/canvas-kernel-smoke.mjs` 用编译好的 Electron、打包用的
  dist-canvas 和 mock 账号后端，把画布从新建项目、出图、自动保存关窗、复制、跨项目撤销、打开 0.2.22
  旧画布存的工程一路点到 Ctrl+C/Ctrl+V 和素材库收藏改名，再看生成来源下拉框的样式、检查器开着时打开创作库、
  便签不算待更新，23 项断言，接在 Windows CI 的 windows-package 作业里，证据传到 electron-smoke-artifacts。
  只在 Windows 上跑（Linux 上画布要求渲染进程在沙箱里，Playwright 拉起的 Electron 不在）。
- 点换内核之前那版界面的 `e2e/canvas-editor-smoke.mjs`（`npm run test:canvas:visual`）和
  `e2e/canvas-group-refresh.mjs` 退役，`ci-workflow-config.test.cjs` 里为后者留的两处「画布冻结」豁免一并清空。
- 画布换内核的工具和门禁（#1393 的 1a，云端做的，内核本身还没同步进来）：
  `scripts/sync-canvas-kernel.mjs <xingmang-canvas 克隆> <tag>` 从 tag 的提交对象里把内核复制进 `canvas-v2/src`、`canvas-v2/shared`，
  删掉 tag 里没有的文件、统一成 LF，写出 `canvas-v2/KERNEL_SOURCE.json`（tag、提交号、每个文件的 sha256、本地补丁）；
  同一个 tag 跑两次没有任何差异，桌面自有的 `index.html`、`vite.config.ts` 等不碰。清单校验规则在 `scripts/canvas-kernel-source.cjs`，
  本地补丁要写理由、xingmang-canvas 那边的 issue 或 PR、14 天内到期，过期只警告。
- 新门禁 `scripts/verify-canvas-network-boundary.test.cjs`：画布源码和产物里不许出现 `/api/`，`fetch`、`XMLHttpRequest`、
  `WebSocket`、`EventSource`、`sendBeacon` 只许出现在登记过的地方（现在只有读本地音频素材的那一处）。凭据门禁扩到 `canvas-v2/shared`。
  这两道门禁的产物那一半以前在 CI 里从来没跑过（跑 `npm test` 的作业都在构建之前），现在 Windows 打包作业构建完跑一次，缺产物算失败。
  画布的 Vite 构建关掉了 modulepreload 兼容代码（Electron 原生支持，那段 `fetch` 永远走不到）。
- 画布窗口拦下自己发起的下载：画布和主窗口共用默认会话，下载会弹系统另存为、绕开原生保存框加原子写的保存通道（I15）；
  只拦画布窗口的，主窗口不受影响。`.github/CODEOWNERS` 加上 `canvas-v2/index.html`（CSP）和 `canvas-v2/KERNEL_SOURCE.json`。
- 画布内核同步到 xingmang-canvas `kernel-v0.1.1`（92ff8d6），改了 5 个内核文件，契约版本、工程格式版本不变，没有新字。
  换内核时查出的两处在桌面上恢复：选中节点 Ctrl+C 不再报「当前画布账号尚未核对…」，改用工作区自己的编号当剪贴板主人，
  只认本工作区原样复制回来的那一段；素材库的收藏、改名、标签、回收照旧画布直接改（yoyo 10-28「素材B」）。
- 画布冒烟加两项（共 20 项）：选中带图的节点 Ctrl+C、Ctrl+V，同一窗口换了项目也能贴；素材库收藏、改名后重新读一遍还在。
  换回 kernel-v0.1.0 跑，红在复制那一步。
- 画布内核同步到 xingmang-canvas `kernel-v0.1.2`（539c901），改了 13 个内核文件、新加 2 个，契约版本、工程格式版本不变，
  没有新字。修的是换内核后在桌面上查出的三处和 #1489 审查里内核那三条：参数面板里「生成来源」下拉框补上样式；
  窗口窄于 1180px、检查器或 Agent 面板开着时，点创作库页签先关面板再展开，不再被 48px 图标栏挡住；便签、分组这类不运行的节点改了不算
  「待更新」；剧本解析时角色、场景、道具编号撞了不再把分镜连到别的表上（D07）；素材多选取消锚点后详情跟着换（D08）；
  缩略图和原图都读不到时停在「素材不可用」，不再来回重试（D09）。
- 画布冒烟加三项（共 23 项）：「生成来源」下拉框是 11px、6px 圆角；检查器开着时创作库里的项点得到（CI 机器的窄窗口里
  检查器先关上）；项目里只有便签时没有「待更新」。换回 kernel-v0.1.1 跑，三项都红。
- 画布内核同步到 xingmang-canvas `kernel-v0.1.3`（84ddb73），改了 5 个内核文件，契约版本、工程格式版本不变，没有新字。
  剧本解析在运行确认框里按最多 2 次付费算（#1525 O05）：桌面在模型答了、但表格读不懂时会再问一次，确认框原来只算 1 次。
  这个节点那行显示现成的「最多 2 次独立生成，按次计费，具体金额以来源为准」，「文字请求」按请求数加总。
- `electron/canvas-node-executors.test.ts` 加一条：每次都答得读不懂时，桌面问的次数等于内核的 `dramaParseMaximumRequestCount`，
  以后哪边改了重问次数，确认框里的数对不上会当场红。
- 测试：`electron/canvas-project-asset-manager.test.ts`「puts a picture paid for before a stop into the paying account library with the stop tag」原来用 `vi.waitFor` 等「停止后收尾」回调，默认只等 1 秒；收尾要存图、打标签，都是带刷盘的原子写，#1515、#1534 的 `windows-test (vitest-3)` 撞过（调用次数 0，整条 1152 毫秒）。改成收尾回调和假 fetch 各自 resolve 一个 Promise、用例直接 await，发请求前那一处同样换掉。断言照旧，不调超时，产品代码不动。
- 画布运行引擎对生图、生视频节点先认画布上采用的那张图（`adoptedAssetId`）：`canvas-run-store.ts` 新增 `resolveAssetOrigin`，在运行记录里找交出过这张图的尝试，`canvas-run-engine.ts` 按那次尝试所在的项目编号重算这一串指纹（复制项目只换了项目编号），对得上就当缓存命中交出这张图，并把它记进当前项目的缓存。现有指纹一个不改，升级后不会整批重跑；输入改过的照旧走原缓存；记录已被淘汰或读不出来、缓存里又是另一张时，
  节点停下写明原因、不提交请求（O06 残余，#1525 核实），缓存也没有时照旧重跑。图只在核对通过后才读。修 #1489 审查报告 O04（复制项目后确认框写复用、实际全部重新付费）和 O06（切回旧候选后下游拿最新那张去付费生成），只动主进程，canvas-v2 没碰，新内核走同一个引擎同样受益。
- `chat:generate-image` 多收一个可选的 `sourceAssetIds`（1–4 个主进程发过的图片编号，`ipc/parsers/ai-chat.ts` 的
  `parseAiChatImageInput` 校验格式和重复），带了就走 `imageService.edit`（Images API edits，按账号 `readOwned` 读图，型号
  不能改图在生图服务里再拒一次）。没加通道。渲染层 `canEditImages` 决定能不能加参考图，`planTurn` 把参考图带进这一轮、
  重新生成照原图再改。
- 聊天、视频剪辑、画布准备分组（列模型）时不再给每个分组签对话密钥（0.2.22 发版前回归检查第 1 条，#1399 带进来的，没发出去过）：
  `chat-credential-coordinator.ts` 的 `prepareGroup` 在星芒账号上改用登录态读 `GET /api/user/models?group=`
  （`new-api-client.ts` 新增 `listGroupModels`），不读本机密钥、不签、不取明文；对话密钥等客户在这个分组发第一句话、
  出第一张图时由 `resolveCredential` 签，签好照旧复用（名字仍是「用户名-分组-对话」）。原因：new-api 签一把要
  `POST /api/token/:id/key` 取一次明文，它挂在 `CriticalRateLimit` 上，按出口 IP 20 分钟 20 次，和登录、续登录、
  退出、充值下单共用；十来个分组一起签会把它用光，续登录跟着被拒，余额、密钥、充值一起报连不上。
  历史账号（Sub2API）没有这个接口，照旧靠分组的密钥列模型。`chat-models-by-vendor.md` 里「打开聊天时没对话密钥的分组
  这时签一把」以这一条为准。
- CI（仓库优化 G1）：`quality` 的 `macos-intel` 和 `macos-release-rehearsal` 在 PR 上只在动了打包相关文件时跑（名单在 `scripts/ci-change-scope.cjs` 的 `macPackagingFiles` / `macPackagingPatterns`，`ci-workflow-config.test.cjs` 顺着这两个作业的命令把它们加载的本地文件全找一遍、漏了就红），每次合进 `main` 照常跑。`macos-test` 不变，每个动代码的 PR 仍然出两个架构的包、启动 M 芯片版。10-24～10-26 的 PR 运行四分之三分位 41.9 分钟，去掉 Mac 作业是 14.0，多数 PR 从占 3 台 Mac 降到 1 台。
- 终端钩子（`bundled-catalog/cli-hooks/xingmang-hook.cjs`）：余额用完时 Claude Code 的「刚才没回上」通知改说额度不够、点了去充值页。
  Claude Code 2.1.310 连本地假接口实测：new-api 回 403 `insufficient_user_quota`「用户额度不足」时 `StopFailure` 报的是
  `authentication_failed`，照对照表落成 `auth`，通知说「Key 用不了了」、点进去是检查页（主路卡点 F1）。
  现在 `auth` / `unknown` 两类再看一眼 `last_assistant_message` / `error_details`，认出 `relay-quota-failure.ts`
  `balancePattern` 那几句余额原话就改报 `billing`；原文只用来比对，记录里仍只有类别词。Key 失效（401「无效的令牌」）
  和 Key 自己的额度上限照旧报 `auth`，限流、服务出错等别的类别不翻案。Grok 走同一段，载荷里有这两个字段时一起受益（推测，没实测）。
  通知文字没改，用的是已有的 billing 那句。
- 型号表（#1154 第 2 条）：「问过换新型号」的记录放不下远端默认型号名（带 `: / @ +` 或超过 120 字）时改记名字的
  sha256（`app-settings.ts` 的 `offeredModelUpgradeKey`），拒绝过的客户不再每次开机被再问；记录的读法没放宽，
  放得下的照原样记，老记录照样认。
- 型号表（#1154 第 3 条收紧的那半）：画图、视频、语音、向量和 `codex-auto-review` 这类不能对话的型号
  （`cli-model-defaults.ts` 的 `isNonInteractiveCliModel`）不再被推断成默认，远端型号表把默认、上一代写成它们客户端不认，
  service-status 工作流写的时候直接报错（`scripts/service-status.cjs` 同名函数，测试钉住两边一致）。第 3 条里
  「下架名单剔光时退回账号列着的型号」是放宽，没做。
- 型号表（#1154 第 3 条放宽的那半，yoyo 10-28 回「放宽型号」）：挑默认型号时下架名单把账号列着的能对话的型号
  全剔光了，退回账号列着的型号里挑（`cli-model-defaults.ts` 的 `offeredCliModels`），登录自动配置不再报
  「当前分组未返回可用于交互的默认模型」。还剩一个能对话的就照旧不碰下架的；开机自动替换 Claude Code、Grok 下架型号那条路不变。
- Windows 上查 Codex 桌面端装着哪一版的那条 PowerShell 失败时，日志以前只记得下错误原话的前 240 个字，
  而原话开头就是整条命令行（探测脚本本身），所以超时、退出码、报错原文全被截掉；更新、安装、卸载因此失败时
  只能说「没查出是哪一步」。现在探测结果改记成一句不带命令行的摘要（几秒没答复被结束 / 退出码几 / 被什么信号结束），
  powershell.exe 的原始错误（含 stderr、退出码、是否超时）挂成 cause 进运行日志；首页合并探测失败那句同样改成摘要。
  客户看到的字不变。`electron/codex-desktop-service.ts` 的 `describeCodexDesktopProbeProcessFailure`、
  `codexDesktopPackageProbeError`。
- `scripts/sync-chatgpt-official-cos.cjs`：OpenAI 的 Windows 更新清单先换成新版、可下载的 MSIX 还是上一版时（10-17 第 51 次、
  10-24 第 78 次运行，签名照常，十几个小时后 OpenAI 自己换好包），不再报 `package-identity-mismatch`、连着两次开报警 issue。
  包的身份、架构、发布者、签名都对、只是版本比清单旧，桶里这一架构又还有一条 24 小时内核过的上一版时，这一架构算「等包」：
  不入桶、不写清单、不刷 `checkedAt`，作业成功，日志记 `package-pending`，运行页标一条「等官方换包」。超过 24 小时（客户端
  `desktopBucketIndexMaximumAgeMs`，再往后客户端已经不从桶里装了）或桶里没有这一架构时照旧失败，代码是新加的
  `package-version-behind`。`validateWindowsInspection` 把版本挪到签名后面核，旧包签名又坏了时报的是签名。
- 手机遥控 Codex 卡最上面那段说明末尾加一句「谁能用你绑定的飞书或微信发消息，谁就能指挥这台电脑，账号别借给别人。」
  （#1407 设计层面那条：审批也在同一个聊天里，绑定的账号被借或被盗就是完全控制；红队剩余拍板项第 5 条，
  yoyo 10-29 回「按推荐」，字按原句）。只改 `CodexRemoteCard.tsx` 的 `codexRemoteIntro`，没有新的行为。
- 手机遥控：电脑上的时间快了，手机刚发的话被当成旧消息丢掉时，给手机回一句「电脑上的时间和手机差得太多，这条消息没有执行。
  请把电脑时间调准后再发。」（#1407 P3-5 的另一半，yoyo 10-29 拍板第 7 条）。原来快 1 分钟以上，刚打开遥控那几分钟发的话
  会被静默丢掉；快 10 分钟以上一直收不到，手机上没有任何回音。渠道拿平台接口回应里的 Date 头估电脑快了多少
  （`RemoteJsonResponse.serverTime` → `RemoteInbound.clockAheadMs`：飞书在连长连接、发消息时重估，微信每拉回一批重估），
  底座按平台的钟再看一遍不旧、且快了 1 分钟以上（`isStaleOnlyByClock`）才回这句。消息照样不执行，时间校验本身不放宽；
  只回绑定的人，或者正在配对、发来的正是这次配对码的人（这条码不配对、不算输错），别人照旧不回话；同一条消息只回一次。
- 手机遥控：照提醒把电脑时间往回调准以后，开启时间按调好的钟改记成「现在」，调准后再发的话马上能用。原来开启时间记的是
  快了的钟，快了几个小时，调准以后就有几个小时发的话还被当成开启前的、静默丢掉。改记的时间不早于真正的开启时间，
  比起时间一直准的电脑不会多放进一条旧消息。
- 手机遥控：Codex 要跑的命令手机上显示不全时，不再截一截问人，直接拒，并在手机上说一句（#1407 P3-2，拍板项 1）。
  原来命令超过 1500 字只显示前面加「…」，看不见的尾巴照样能点「同意」；往已经开着的程序里输入（`kind: writeStdin`）
  和连网站（带 `networkApprovalContext`）也都写成「Codex 想运行命令」，连网站那张正文还是空的。现在
  `commandApprovalKind` 按 Codex 0.164.0 的审批格式分成三种，各有标题，连网站那张正文写要连的网址；
  `inspectCommandDisplay` 按脱敏后要发到手机的字数判断，放不下的不问人直接拒、不占审批编号，正文是空的也拒（只记日志）。
- 手机遥控：「Codex 想改文件」卡片不再把最后的「另外还有 N 个文件」和「可写范围」截掉（Refs #1407）。
  原来正文整段拼好再截到 1500 字，二十条八十来字的路径就超了，截掉的正是最后那两行，最后一条路径也只剩半截加「…」。
  现在 `buildFileChangeSummary` 只列整条放得下的路径（按脱敏后要发到手机的字数量），其余算进「另外还有 N 个文件」，
  「可写范围」整行留在最后；「可写范围」那一行自己都放不下时不问人直接拒、不占审批编号，手机上说的是权限申请显示不全那句。
  Codex 0.164.0 目前不填 `grantRoot`，那一行实际还不会出现，这里先保住。
- 手机遥控：「退出登录」删不掉保存的凭据时不再当成功（#1407 P3-6）。`CodexRemoteStore.writeCredential(channel, null)` 原来把
  `removeSafeDataFile` 的失败 `.catch(() => undefined)` 吞掉，凭据文件还在、下次打开照样登着。现在除了查完就没了的 ENOENT，
  删不掉一律抛「没能删掉保存的登录信息，请重启星芒后再点一次退出登录。」，原错误挂在 cause 上进运行日志。
  `saveChannelCredential` 在退出登录这条路上碰到它，照旧解绑、停掉渠道，账号字样留着（凭据还在，卡上照旧能再点退出登录），
  先推一份快照让界面跟上，再把那句报出去；保存新凭据失败照旧原样抛。
- 手机遥控：遥控开的对话不再带客户自己给 Codex 接的外部工具（#1407 P2-4 第二件，yoyo 10-29「按推荐」）。MCP 服务、插件、
  ChatGPT 应用的工具调用不一定走审批，手机上看不到也拦不住。现在 `thread/start` 带 `config` 覆盖：`features.apps` 和
  `features.plugins` 关掉，`mcp_servers` 逐个设 `enabled = false`。名字由开对话前的 `config/read`（`cwd` = 遥控文件夹、
  `includeLayers: true`）逐层收集，没被信任过的项目 `.codex/config.toml` 也算（workspace-write 下 `thread/start` 会当场信任并
  加载它）；只在这种层里出现的服务连同它的 `command` / `url` 一起带上，不然 Codex 会因为「没有启动方式」拒掉整份配置。
  `config/read` 失败就不开对话。只改这一份对话，`config.toml` 不动，电脑上直接用 Codex 照旧，联网搜索不动。
- 手机遥控：Codex 申请额外权限时，同意以后只授予手机上显示过的那几条（审查清单严重-2，#1407 P2-3）。原来卡片只列
  `fileSystem.read` / `write` 两张表、最多 20 条，授予时却把整个 `fileSystem` 原样交回，`entries` 里的整个硬盘、通配、
  拒绝规则都不显示照样放行。现在 `readRequestedPermissions` 把申请拆成联网 + 读 / 写路径：`entries` 只认跟两张表一模一样的
  普通路径（Codex 0.164.0 会把同一批路径在 `entries` 里再写一遍），带别的字段、超过 20 条、什么都没要、或者说明超过一张卡的
  字数，一律不问人直接拒，并在手机上说一句；授予只给 read / write 两张表，不带 `entries`。
- 手机遥控：Windows 上读不出完整性标签时不再按普通权限放行（#1407 P2-5）。`resolveCodexRemoteAvailability` 只在
  same-user 且 `highIntegrity === false` 时许开，读不出标签另给一句「没能确认…」，不再说成「正以管理员身份运行」。
- `electron/redaction-patterns.ts` 的形状表再加两种（#1407 P2-4 的打码这一半，10-29 拍板「打码做」）：JWT（`eyJ` 开头的
  三段 base64url，头至少 13 个字符）和云服务的访问密钥 ID（AWS `AKIA` / `ASIA` 加 16 位、阿里云 `LTAI` 加 12～20 位、
  腾讯云 `AKID` 加 32 位）。手机遥控发出去的字（`redactRemoteText`，换成「[已隐去]」）、运行日志、诊断导出、崩溃报告、
  渲染层几处上屏的报错共用这张表，一起生效；只加不减。JWT 那条用 lookbehind 只许从一段 base64url 的开头起匹配：用 `\b`
  的话每个 `-eyJ` 都能起一次、把后面整段重读一遍，沙箱实测两万个 `-eyJ…_` 要二十多秒，现在二十万个三十毫秒。
  配套的密钥本身（`aws_secret_access_key`、`AccessKeySecret`）本来就由按名字认的规则遮住。
- 手机遥控：Windows 上在星芒里更新、卸载 Codex 之前先让遥控放开它那份 Codex（#1407 P3-3 的后一半，yoyo 10-29「按推荐」）。
  手机用过一次以后 `codex app-server` 一直开着，锁着自己的程序文件，npm 换版本、挪包目录都撞上 EBUSY，提示里看不出是遥控占着。
  现在装、卸的那一项排到安装队列里以后，先调 `CodexRemoteService.releaseCodex`：闲着就停掉、等它真退出（最多 10 秒，等不到照常往下，
  撞上占用时还是原来那句「文件被占用」），手机下次来消息再起一份、从新对话开始；这一轮没做完、有等着同意的、还在起的，都不动它，
  直接报「手机遥控里的 Codex 正在干活，等它做完再更新（卸载），或者先在设置里关掉手机遥控。」，一个字节都不动。
  平台和工具的判断在 `system-service-context.ts` 的 `releaseRemoteCodex`（只管 Windows 上的 Codex），`main.ts` 等遥控建好再接上。
  `CodexAppServerClient` 加 `whenExited()`；刚关掉遥控、还没退干净的那份也一起等。
- 手机遥控：飞书里点上一次留下的旧审批卡片，不会再同意一条没看过的新命令（审查清单 YK-3）。审批编号记进遥控设置
  （`lastApprovalNumber`），重开星芒接着往下数、过了 9999 回到 1，手机上回旧编号只会得到「没有第 N 条」；每条审批另带
  一串随机字（`RemoteApprovalRequest.nonce`），飞书按钮原样带回，编号和随机字都对上才算数，处理过的、超时的、
  重开前的卡片一律回「这张卡片已经失效了」。微信没有按钮，靠编号不重复这一条。
- 测试：`electron/codex-remote-service.test.ts` 共用的 `enabledAndPaired` 用 `vi.waitFor` 等「配对成功」，默认只等 1 秒；配对要先把绑定的人原子写进设置，#1542 的 `windows-test (vitest-3)` 撞过（`expected [] to include '配对成功…'`）。同文件里等审批卡片的 19 处同理（发卡片前要把编号写进盘）。改成假渠道在发出那一下 resolve（`FakeChannel.sentUntil`），用例直接 await；本地让设置每次写盘多等 1.5 秒，旧写法 37 条红、新写法全过。断言照旧，不调超时，产品代码不动。
- #1407 P2-1（红队拍板项第 4 条，yoyo 10-29 回「按推荐」）：窗口缩到托盘后遥控照样开着，设置页却写「关掉星芒就断开」，
  托盘里只有一行点不了的灰字。`application-tray.ts` 快照加 `remoteControlOn`、选项加 `onRemoteControlOff`，有渠道开着时
  在挡睡眠那行灰字下面出一项能点的「关掉手机遥控」（灰字在说别的事时也在）；`CodexRemoteService.disableAllChannels()`
  按设置页点关的同一条路把开着的渠道逐个停掉，手机上收到同一句「手机遥控已在电脑上关闭。」。`main.ts` 在遥控状态回调里
  只在 `hasEnabledChannel()` 翻转时重建托盘菜单，点击另记一条 `remote.tray-off`。设置页 `remoteSwitchHint` 换成批过的原句；
  用户那条并进 `011-codex-remote-feishu.md`（原来写的「关掉星芒」也改成「退出星芒」）。
- 手机遥控：Codex 还在启动时在电脑上关掉遥控（或星芒正在退出），手机那句话不再交给 Codex，起好的那份 Codex 当场收掉
  （#1407 P3-1）。原来 `ensureCodex` 起完不看渠道还开不开，`runPrompt` 也不看，照样开对话、发提示词（扣钱、只读命令先跑），
  之后才补一次打断；起到一半的 Codex 不归 `stopCodex` 管，一直留到下次关遥控或退出。现在起完、开完对话各看一次。
- 手机遥控：审批和结束通知按轮次认（#1407 P3-2 的一半）。停掉的那一轮记下编号，它迟到的审批直接拒、结束通知不往新一轮上记；
  新一轮编号回来以后，编号对不上的审批也拒。原来只按对话认，新一轮编号还没回来时，上一轮迟到的审批会挂到新一轮上问人。
- 手机遥控：起 `codex app-server` 排进安装队列（I11，#1407 P3-3 的一半），key 是 `cli:launch:codex:remote`，和终端里打开
  Codex 一样不拦退出、不挡睡眠。Codex 正在装、更新、卸载时等它做完再起。
- 手机遥控：微信每次打开都从空游标拉消息，第一批里没带发送时间的不执行（#1407 P3-5 的一半），判断不了是不是星芒关着时发的。
- 手机遥控：Codex 起不来、半路退出时，stderr 最后 1000 字脱敏后进日志（#1407 P3-6）；删掉没人调用、会返回明文凭据的
  `readChannelCredential`。
- 读工具配置时同一份文件只读一遍、只解析一遍（0.2.22 性能体检第 7 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。界面没变。
  `config:get` 每次把每个工具的配置看一遍，以前 `inspectProviderConfig` 按字段各读各的：Codex 的 `config.toml` 读、解析五遍，
  `auth.json` 读四遍，接着 `managedCliHooksState` 再读一遍主配置；每次读都要走一遍路径检查和单链接复核。开机那阵 `config:get`
  要调两到五次，正好卡在首页渲染的时候。
- `electron/config-files.ts` 新增 `withSharedConfigReads`：包住的这一段里，同一路径的字节、同样内容的 JSON 和 TOML 解析结果
  （连同解析失败的错误）只算一次；出了这一段照旧每次现读。`inspectProviderConfig` 自己包一层，`config-save-service.ts` 的
  `buildConfigSummary` 把看配置和看钩子包在同一段里。包进来的都是只读的同步代码，中间不会写配置，别的代码也插不进来，
  所以读到的就是同一份。`codex-config-syntax.ts` 的 `isCodexConfigBroken` 多一个可选的解析函数参数，判坏时复用同一次解析。
- 沙箱实测（Linux，Codex 配置 120 个信任项目，Claude、Grok 各一份，单次 `getConfig`）：打开配置文件 19 次 → 4 次；
  冷启动第一次 25~38ms → 16~18ms，第二次 10~16ms → 7ms，热了以后 5.7~8.2ms → 3.1~3.4ms。
- 没做：按 mtime 跨次缓存（两次 `config:get` 之间 CLI 自己可能改配置，同一秒内改、大小不变时会读到旧的）；界面开机那几处
  `config:get` 合成一次。
- `electron/redaction-patterns.ts` 里遮 Cookie 头的那条规则（把 `Cookie: a=b; c=d` 整串遮掉的那一条）碰到一长串里反复出现
  cookie 名字的文本时会越来越慢：同一串里的每个名字都起一次匹配、各自把后面整串再读一遍。改成同一串里前面已经有过名字的就不再起头
  （它的结果一定跟前面那个相同），串尾那个（后面隔着空格接值）照样算，整串只读一遍。遮出来的结果跟原来逐字相同：单条规则和整条打码
  流程各跑几百万条随机串新旧对比，0 处不同。手机遥控回话、运行日志、诊断导出、崩溃报告共用这张表。
- `electron/crash-report.ts` 的 `redactCrashText` 最后一步遮邮箱，碰到很长一串字母、数字、`._%+-` 时越长越慢：原来的全局替换
  从串里每个位置都起一次匹配，各自把后面整串再读一遍找 `@`，10 万字要十几秒，而崩溃报告是先打码再截到 2048 字。
  改成只从「上一处遮完的地方」和「一串这类字的开头」两处起找，整串只读一遍；前一处保住了贴在一起的两个邮箱照样都遮
  （只加起头限制的简单改法会漏遮第二个）。遮出来的结果跟原来逐字相同：500 万条随机短串新旧对比，0 处不同。
  意外退出记录（`unexpected-exit.ts`）用的也是这个函数。
- 审查报告 D02（#1489）：`mergeImportedConversations`（`src/renderer-v2/features/chat/storage.ts`）以前把本机和导入的新对话
  合在一起按 `updatedAt` 截到 50 个，写入计划只带留下的那些，主进程 `ai-chat-history-store.ts` 随即删掉不在列表里的对话文件；
  本机已存满 50 个、导入的又都更旧时 `added=0`，提示「文件里的对话这台电脑上都有了」，说的不是实话。
  现在本机对话一个不删，只按剩余空位导入导入方最近改过的那几个，放不下的数作为 `skipped` 一路带到设置页的导入提示
  （`features/app/data-transfer.ts`）；一个都放不下时不写盘。和同文件 `mergeSessionIntoHistory`「不替用户删」的口径一致了。
- `electron/config-files.ts`：`applyCodexRelayConfig` 里新增 `allowCodexApiKeyLogin`，保存当前账号或自己的密钥时拿掉
  `forced_login_method = "chatgpt"`（去空格、不分大小写，跟 `workspace-config-overrides.ts` 的判法一样）；写的是 `"api"`
  的不动，跟密钥接入不冲突。官方快照（`xingmang-config-chatgpt.toml`）照留原值，切回官方账号原样回来，跟
  `cli_auth_credentials_store` 的先例一样（审查 #1489 D04）。
- 实测：Codex 0.164.0 命令行（linux-x64）连本机假接口，`env -i` 加临时 HOME，用户级 config.toml 只写这一行，经
  `saveProviderConfig` merge 后跑 `codex exec`：改前报「ChatGPT login is required, but an API key is currently being used.
  Logging out.」、退出码 1、auth.json 被删；改后正常出字，请求带的是写进去的密钥，auth.json 还在。
- 不进开机补设置（`fillCodexRelayTemplateDefaults`，`relayTemplateRevision` 不动）：这是客户自己写的值，开机补完那句提示
  说的是「自己改过的设置都没动」。首页也不加新的状态和字：以前版本已经写进去、Codex 已经把 auth.json 删掉的客户，读不到 Key
  后来源判成 unknown（`sourceFor`），首页本来就不再显示配好，点它给的原有按钮（改用当前账号）重新保存就会走到这里（看代码，
  没演过）。
- 测试：`config-files.test.ts` 加三条（从官方切过来拿掉、切回官方原样回来、再切过来仍拿掉；当前账号配置里残留的拿掉、
  写 `"api"` 的不动；开机补设置不碰）。
- 构建依赖：follow-redirects 升到 1.16.2（GHSA-mrwp-f3q8-3g9p）、joi 升到 18.3.1
  （GHSA-4528-x5fx-h6hg），都经 wait-on 进来，只动锁文件。
- `scripts/audit-development-dependencies.cjs` 给 minimatch 的 GHSA-g3hv-75wg-m249 开了一条窄例外，
  到北京时间 2026-11-30 当天结束（yoyo 10-31 打字同意）。只有 11 版修了且不回补旧版，
  electron-builder 最新版仍要 ^10，强换 11 会弄坏 asar 3.x、dir-compare 和 glob 7；
  我们的调用方都碰不到出事的那段代码。例外只认这一条公告、只认挂在 minimatch 上、
  最高中危，依赖链里任何别的公告、悬空节点或计数对不上都照样红；到期后自己变红，
  公告消失后会提示删掉这条例外。
- 依赖（仓库优化 G4）：删掉 `@lobehub/icons`。界面只用它 11 个 AI 厂商图标，它却把 `antd`、`@lobehub/ui`（连带 mermaid、shiki 等）写成 peer 依赖，锁文件里 970 个条目有 443 个只因为它才装。这 11 个图标的 SVG 原样抄进 `src/renderer-v2/ui/vendor-icons.tsx`（MIT，文件头留出处），路径、颜色、`<title>`、渐变 id 的写法都没变：删之前逐个对过，各种尺寸和传参下渲染出来的 SVG 与原来的包逐字节相同，`BrandIcon` 对所有工具、客户端和常见型号名的输出也相同。锁文件只删条目，留下的包版本和校验值一个没变。`katex` 的 `overrides` 当初是为这条依赖链加的，现在不起作用，没动。
- `electron-builder.config.cjs` 加 `electronLanguages`：浏览器内核自带的 55 种语言只留 `zh-CN`、`zh-TW`、`en-US`（en-US 是
  Chromium 认不出系统语言时的退路）。macOS 按 `.lproj` 的名字另列在 `mac.electronLanguages`（`zh_CN`、`zh_TW`、`en`），
  连同这三种语言各自的 `_FEMININE` / `_MASCULINE` / `_NEUTER` 空壳目录（18 字节，桌面版 Chromium 还不读）原样留着。
  出处：Rust 评估报告（`/mnt/project-files/Rust评估/报告.md` 第五节第 3 条），yoyo 10-30 回「删语言包」。
- 省下多少（Electron 45.1.0）：Windows 删掉 52 个 `.pak` 共 49.4 MB（装好后），按安装包同样的 LZMA2 最高档压缩约 7.5 MB；
  macOS 每个架构删掉 208 个文件共 8.0 MB，dmg / zip 里约 2.3 MB（按 zlib 估算）；Linux 实测 deb 从 106.06 MB 到 104.34 MB，
  装好后少 7.7 MB。
- 行为：中文（含香港、澳门落到的繁体）和英文系统什么都不变；系统语言是别的（日文、德文、英式英文……）时，浏览器内核自己的
  那点文字（表单校验提示、文件选择框这类）从那种语言变成英文，`app.getLocale()`（反馈报告里的「语言」一行）也报 en-US。
  服务器按请求语言翻译报错，只认中文简繁和英文、别的都回英文，所以客户看到的服务器提示不变。Linux 上用 Electron 45.1.0
  实测过 zh_CN / zh_TW / zh_HK / en_US / en_GB / ja_JP / de_DE / C 都能起来。
- 新增 `scripts/electron-languages-config.test.cjs`：钉住三份名单，并核对每个留下的名字都是本机装的 Electron 真带的
  （名字写错 electron-builder 不报错，会把本该留的那份一起删掉）。
- 分批放量写进发版工作流（商业级差距报告 G02）：publish-release 多一项「上传以后先推给多少」，默认 20，
  publish 作业在换更新清单之前把它写进 `service-status.json`、核对客户读得到再换清单
  （`scripts/release-rollout.cjs`），不用再记着先跑 service-status；同一次发布重跑不动放量，补发平台只对新平台分批，
  选 100 时运行页面在两次批准之前打黄色提示。
- 新增 rollout-health 工作流（每天北京时间 12:17）：正在放量时拿新版和还在旧版的电脑的每天打卡比闪退、卡住、
  付款页没打开、装工具失败和「下好了装不上」，在运行摘要第一行给出「建议放开 / 建议停住 / 再等等」
  （`scripts/rollout-health.cjs`，只读、只给建议）。`docs/RELEASING.md`「分批放量」整段按新流程重写。
- 崩溃上报接上 source map（商业级差距报告 G06）：客户端报错带 release `xingmang-ai-manager@<版本>` 和 dist `<平台>-<芯片>`，帧地址改写成 `app:///dist-electron/…`（主进程）和 `app:///dist/…`（主窗口渲染层），顺带不再把客户的安装路径发给 Sentry（`electron/crash-report.ts` 的 `resolveCrashFrameUrl`）。`npm run compile` 顺带把对照表出到 `dist-sourcemaps/`（vite `sourcemap: 'hidden'` 后由 `scripts/stash-renderer-sourcemaps.cjs` 搬走；tsc 内联映射经 `scripts/minify-electron.cjs` 接回 `.ts`），安装包里一份都没有，发出去的代码逐字节不变。
- 发版工作流新加 `sentry-sourcemaps` 作业：publish 成功后在 `sentry` 环境（只放行 main、不设批准）里读 `SENTRY_AUTH_TOKEN`（Sentry 组织令牌，只能建 release、传对照表），按版本号和 SHA-256 装 sentry-cli 3.8.0，由 `scripts/sentry-sourcemaps.cjs` 按每种安装包的 dist 传上去。没放令牌只提醒，失败不影响客户，单独重跑即可（`docs/RELEASING.md` §9）。
- 早上的日汇总（`scripts/update-feed-stats.cjs`）加「每版健康数」：最新三版各自的闪退、卡住、星芒更新出错，每 100 台·天几次。
- G20：Electron 43.8.3 升到 45.1.0（Chromium 156、Node 24.22、V8 15.6）。43 在 2027-01-05 停补丁，45 在 2027-04-27。
  照官方 44、45 两版的破坏性改动清单逐条对过代码，要改的只有剪贴板一处，其余不涉及或已经满足：Mac 13 起（44 不再支持 12，
  `minimumSystemVersion` 早就是 13.0）、Windows 只出 x64（44 不再出 32 位）、三个沙箱预加载脚本编译后只 `require('electron')`
  （45 去掉了沙箱预加载里的 `Buffer`、`setImmediate` 和 `events`/`timers`/`url`）、没有不开沙箱的窗口（45 改了它们 `window.open`
  的进程归属）、权限处理本来就拒绝屏幕共享（45 改报 `display-capture`）、asar 里的随包文件都是 `readFileSync` 整读（45 的 asar
  文件描述符只认 `fs`）、`net.request` 没设 `Sec-Fetch-Dest`、没用 `select-client-certificate` / `isUnityRunning` / `contentTracing`。
- 剪贴板：44 改成跟 W3C 一样的异步接口，`readImage` / `writeImage` 删了，`readText` / `writeText` 返回 Promise。
- `sensitive-clipboard.ts`：写完才落定、写失败抛给调用方（复制密钥、复制新密码两条通道改成 await）；60 秒到点异步读回比对再清。
  新增 `flush()`，主窗口 `prepareToQuit` 里调（`main.ts` 自己建一份经 `IpcRegistrationOptions.sensitiveClipboard` 传进去）：
  沙箱里用 Electron 45 实测，will-quit 里发起的 `readText()` 还没回来进程就退了，原来在 will-quit 里擦剪贴板的那一下改到退出前做；
  `dispose()` 仍撤计时并再试一次。写入还没落定时来的 flush 也认得那段文本（先记下、落定后再挂计时）。
- 新增 `clipboard-image.ts`：图片一律以 `image/png` 进出剪贴板（作品菜单「复制」两处、AI 聊天粘贴截图）。粘贴照旧经
  `nativeImage` 转一遍 PNG，`ChatAttachmentServiceOptions.readClipboardImage` 改成返回 Promise。沙箱里实测写 `image/jpeg`
  读回来也是 `image/png`。
- 复制反馈、启动失败框里的「复制错误信息」改成 await；右键「复制链接」失败记一条 `context-menu.copy-link.failed`，
  不再变成未处理的 Promise 拒绝（那会当成崩溃上报）。
- `platform/system-service.test.ts` 的开机项假数据去掉 44 删掉的 `openAsHidden` / `wasOpenedAsHidden` / `restoreState`。
- 沙箱里用 Electron 45.1.0（Linux、普通用户、xvfb）真开过：electron-ci-smoke、window-close-smoke、onboarding-smoke、
  renderer-v2-native、renderer-v2-native-close-race 都过；画布的沙箱判断照旧成立（默认渲染进程 `Seccomp: 2`，`--no-sandbox` 是 0）；
  `network-failure.ts` 认的两句 Electron 原句（`Attempted to redirect, but redirect policy was 'error'`、`Redirect was cancelled`）
  在 45 的二进制里还在。realm-account-smoke 在 Linux 上走到打开画布那步会被拒，是 Playwright 在 Linux 上总给 Electron 加
  `--no-sandbox`，画布按设计拒绝打开；这个冒烟只在 Windows CI 跑。
- Linux 安装包：Electron 45 的 Linux 原包（zip）里文件权限是 0666/0777（43、44 是 0644/0755），electron-builder 原样带进
  linux-unpacked，打出的 deb 装进 /opt 后人人可写，`verify-linux-deb.cjs` 当场拦下。新增 `scripts/linux-payload-modes.cjs`，
  在 `afterPack` 里只对 Linux 去掉组写和其他人写（符号链接不跟），Windows、Mac 的包不动；本机重打 x64 deb 两道校验都过。
- 还欠着、升 46 前要做：`safeStorage` 的同步接口在 45 报弃用、46 删除，各处加密存储要换成异步写法（`docs/RELEASING.md` 记了）。
  45 新带的 Windows 崩溃辅助文件 `electron_wer.dll` 只在调了 `crashReporter.start()` 时才注册，本程序没开（G05），不影响。
- 加代码扫描（商业级差距报告 G21）：新工作流 `.github/workflows/codeql.yml` 用 GitHub 的 CodeQL 扫 `javascript-typescript`（主进程、两套渲染层、画布、脚本和测试，不扫 `ui-spec/`）和 `actions`（工作流本身的表达式注入）。每天北京时间 4:23 扫一次 main，改到它自己的 PR 上先扫一遍不上传，Actions 页面也能手动跑。现在只报不挡：不进 quality-gate，PR 上不把结果交给 Code scanning，不会让 PR 变红。结果在 Security 标签页，也由 `scripts/codeql-summary.cjs` 逐条（严重程度、规则、文件:行）列进作业日志和摘要页，线程读不了 code-scanning 接口、读得到日志。作业不装依赖，只有 `contents: read` 和上传结果用的 `security-events: write`。
- 发版产物带出处证明：`publish-release.yml` 末尾新加 `attest` 作业，publish 成功后给这次真发出去的 `*Setup.exe`、`*.dmg`、`*.zip`、`*.deb` 签 GitHub artifact attestation（SLSA build provenance，`actions/attest`），任何人能用 `gh attestation verify <文件> --repo xufei5620/xingmang-ai-manager --signer-workflow xufei5620/xingmang-ai-manager/.github/workflows/publish-release.yml` 核对（`docs/RELEASING.md`「出处证明」、`SECURITY.md`）。签证明要的 `id-token: write` 只给这一个作业：它不挂环境、不读 secret、不装依赖，下哪几个平台的产物和 cos-sync 一致；它排在最后，失败了客户照常更新，单独重跑即可。两次审批、release 环境和上传顺序都没动。
- 新手引导第 3 步「确认连接」（`src/renderer-v2/features/auth/StartGuide.tsx`）：主路卡点 F14，装完工具后自动写账号密钥没写成时，
  引导以前只按工具当前状态说「尚未选择连接方式」「打开配置选择连接来源、密钥、模型和工作文件夹」，主按钮「去完成连接配置」，
  首页横幅那句「密钥没有写进去，点『重新同步』再试」被引导盖住。现在 `App.tsx` 把最近那一轮写密钥的结果按工具算好
  （新纯函数 `resolveToolKeySyncFailure`，在 `features/tools/key-sync-failure.ts`），放进 `GuideToolState.keySyncFailure`；
  第 3 步顶上先说首页同一句（网络、证书拦住时说首页那两句），主按钮「重新同步」走新的 `onBootstrapRetry`，
  跟装完以后那一轮一样只给这一个工具写（`runAccountBootstrap(…, 'login', true, [provider])`），写成了替客户点「下一步」到第 4 步；
  「去完成连接配置」退成次按钮。账号没开通的只说那句、不给「重新同步」，同首页。别处的 Key、已连好、没登录的不受影响。
- 首页那两句网络、证书提示和 `bootstrapErrorText` / `networkBlockedNotice` 从 `Home.tsx` 挪进 `key-sync-failure.ts` 两边共用，字没改。
  `keySyncFailureText` 认 `codexDesktop`：引导里选的是 Codex 桌面端时开头叫桌面端。界面没加新字。
- 新手引导第 4 步：工具花的是当前账号的余额、余额 ≤ $0 又没有能用的订阅时（用首页工具卡那份
  `homeWalletEmpty`，跟 `homeMoneyNotice` 的 $0 判断一致），顶上那句换成首页 `lowBalanceText(0)` 的原话，「去充值」挪到这句下面当主按钮，
  「打开 {工具}」「去聊天」退成次按钮、不拦。用官方账号、自己的密钥或改用没试通的不变。主路卡点 F3。
- 首页开机少打 9 个请求（0.2.22 性能体检第 9、10 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。界面文字没改，首页余额、
  本月用量、「约还能用 N 天」、近 7 天七根柱子照旧都有。沙箱本地假接口、已登录冷启动各 3 次，开机 12 秒内打到星芒站的请求
  从 25~26 个降到 16~17 个。
- 近 7 天花费（`src/renderer-v2/features/tools/week-spend.ts`）：过完的那几天以前只记在内存里，每次开机都要 7 个 `/api/data/self`；
  现在按账号存进 localStorage（`xingmang-ui-v2:week-spend:<账号>`），开机只问今天，每天头一次开再多问一次昨天。读回来的一律校验，
  存不进去照旧每次问后台。过完的天要过了一小时才记（new-api 的看板数据默认 5 分钟才落一次库，零点刚过问到的昨天可能不全）。
  换账号时不再丢掉记着的天：按账号分开，不会串。
- 首页用量（`features/tools/api.ts` 的 `loadBalanceUsage`）和花费突增核账（`electron/balance-alerts.ts` 的 `readSpendBaseline`）只用合计：`account:get-usage` 加可选的 `statsOnly`，
  星芒账号只打 `/api/log/self/stat`，不再陪着打一页明细 `/api/log/self`（服务端那一下还要数日志总条数）。
  历史账号不带这个字段（`sub2api-relay-backend.ts` 见到不认识的字段会整个拒掉），照旧。IPC 入参校验跟着加，false 不往下传。
- 余额（`electron/new-api-client.ts` 的 `getBalance`）：开机恢复登录刚读过 `/api/user/self`，10 秒内紧跟着的那一次余额直接用它，
  只给一次；之后的余额、换令牌、重新登录、换账号以后都照旧问服务器。
- 没动的：`/api/status` 仍是 3 个（两条线路各探一次，余额那一次本来就有 20 秒共用缓存；拿线路探测的回话喂给账号要把两个模块绑在一起，不值）；
  `/api/user/self/groups` 开机 2~3 次是签密钥那条路，不在这次范围。
- 首页工具卡余额为零时直接给「去充值」（主路卡点 F4）：用当前账号连着的命令行工具和 Codex 桌面端，在余额 ≤ $0、
  没有能用的订阅、账号能在软件里充值时（`homeWalletEmpty`，跟上面那条 $0 提示 `homeMoneyNotice` 同一个判断，
  新手引导第 4 步也用它），角标换成 v4 状态表里的「余额为零」，卡上那颗按钮换成「去充值」（进个人中心充值页），
  「打开」挪进「…」第一项，同配置坏了、被改过那几种的放法（一张卡约 235 宽，放两颗按钮会挤掉角标）。顶部大卡「去充值」
  当主按钮排第一，「打开 {工具}」退成次按钮。`status` 不改，提醒设置没写上那些判断照旧；官方账号、自己填的密钥、
  别的状况（配置坏了等）优先的都不变。
- 给客户看的那句并进 `005-balance-empty-notice.md`（余额用完时会直接叫你去充值，yoyo 10-27 批）。
- Mac 闲时自动装更新（#1380，`update-install-prompt.ts`）多看两样：手机遥控有渠道开着（`CodexRemoteService.hasEnabledChannel`）、
  视频在出或在取回（两个 `AiVideoService` 的 `hasActiveRequests`，含视频剪辑页、画布和登录时的续取），
  主窗口界面手上有事（#1411 的 `rendererBusy`：视频剪辑拼片在界面里跑，主进程只能靠它看到；对话出字、开着对话框也算），
  任一成立就不装，等它们结束再装，或者退出、下次打开时装（0.2.22 审查 YK-2）。之前装的时候会悄悄停掉遥控（重开后不会自己连回去，人在外面也开不了），
  也会打断正在出的视频（交给服务端的照样扣钱）。
- 遥控可能一开一整天，闲时装一直等不来，所以遥控开着时跟 #1444 的「窗口开着」一样：人不在先不问、等人回来再跳框，
  框弹出来以后也不收（日志 `install.prompt.away-remote-on`）；
  框里那句按不能闲时装的 Mac 说「退出星芒或下次打开时自动装上。」（10-25 批过的原句）。视频和界面上的活几分钟就做完，
  照旧不问、做完再闲时装。读不出来时都当作「在忙」。
- 换账号同步到 Claude Code、Codex 时，保存配置后台替外部客户端跟换密钥的那一眼合成一轮
  （`external-client-route-service.ts` 的 `followManagedKeysNow`）：以前两家各跑一轮，后一轮在前一轮换完之前就记下计数，
  界面重读两次，#1413 加的用例在 Mac CI 上偶发红。现在跑着时再叫只记一笔「跑完再看一遍」，后一家的密钥照样跟上，
  只叫界面重读一次。`external-client-service.test.ts` 加一条把两轮卡在一起的用例，拿掉修复会红。
- Linux 不再每次检测都记一条假警告「Codex 桌面端更新检测失败：Codex Desktop 版本检测仅支持 Windows」：
  `codex-desktop-service.ts` 的 `inspectCodexDesktop` 在非 Windows、非 Mac 那支原来把这句当 `updateError` 带回去，
  `ipc/handlers/system.ts` 见到 `updateError` 就记 `desktop.update-check.failed`，客户导出的反馈报告里全是它。
  现在跟 Mac 那支一样只回 `updateCheck: 'skipped'`、不带错误文字；当前界面只在 `failed` 时读这句，看不出变化。
  Windows、Mac 不变。`system-service.facade.test.ts` 钉住。
- Linux 写进客户 `~/.bashrc` / `~/.zshrc` / `~/.profile` 和 fish `conf.d` 的那句注释不再列 gemini（Gemini CLI 10-14 下线），
  改成「claude / codex / grok」。卸载只撤一字不差的那一段，所以 `linux-shell-profile.ts` 记下旧写法
  （`previousProfileCommandLists`），以前写进去的那段卸载时照样认得、撤得掉；装的时候已有那段就不再补新写法的。
  `linux-shell-profile.test.ts` 钉住。`docs/LINUX.md` 状态更新到 10-26，去掉 Gemini 的几处。
- deb 的 `Maintainer` 从只写公司名改成 Debian 要求的「名字 <邮箱>」：`绍兴星芒文化传媒有限责任公司 <xufei5620136@gmail.com>`
  （`electron-builder.config.cjs` 的 `linux.maintainer`，yoyo 10-27 给的邮箱；会印在每个安装包里，软件中心详情、
  `apt show` / `dpkg -s` 看得到）。`Vendor` 照旧只写公司名，`Homepage` 不动。
  `scripts/linux-build-config.test.cjs` 钉住这个格式。Linux 对外首发仍由仓库变量 `XINGMANG_PUBLISH_LINUX` 决定，本条不碰开关。
- Linux 版代下的 Node.js 从 v24.21.0（9-07）抬到 10-20 的安全更新 v24.22.1（`electron/linux-node-runtime.ts`），
  x64 / arm64 两个 SHA-256 照旧从 nodejs.org 的 `SHASUMS256.txt.asc` 抄，抄前用 nodejs/release-keys 的公钥核过签名
  （签名人 Antoine du Hamel，`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`）。Windows / Mac 选最新 LTS，不受影响。
- Linux 的两份更新清单（`latest-linux.yml`、`latest-linux-arm64.yml`）和 Windows 的 `latest.yml` 一样加发布者签名：
  publish-release 在上传前用同一把 `XINGMANG_UPDATE_SIGNING_KEY` 签、发完再下载线上那份各验一次；rollback-release
  恢复 Linux 备份时同样只认带签名的，或对过 GitHub Release 上同名 deb 再补签。客户端在 Linux 上也要求签名
  （`update-package-signature.ts` 的 `shouldVerifyUpdateSignature`），缺签名或对不上就不把 deb 交给系统安装程序。
  原因：deb 由系统安装程序以 root 装、dpkg 不验包内签名，清单又和 deb 同放 R2，只凭 SHA-512 挡不住拿到上传密钥的人。
  Linux 还没对外发过，第一次对外发的那一版起就带签名，没有不认签名的老客户端。
- Mac 桌面端在星芒里更新（yoyo 10-27「桌面端更新改」，云端做的）：新增 `electron/macos-desktop-app-update.ts`。新版以星芒存储桶为准
  （同一份 `readDesktopBucketPackage`，每个包 6 小时读一次、读不到 30 分钟后再试，检测时最多等 3 秒，测试里不查）；
  装着的比桶里旧、而且在 `/Applications` 或 `~/Applications` 里才提醒（`ExternalClientRuntimeStatus.latestVersion` /
  `updateAvailable`，Codex 桌面端走原有的 `mirrorVersion` / `updateState`），WorkBuddy 和 Windows 不变。
- 换装在 `macos-desktop-app-installer.ts` 的 `replace` 选项：新版照旧下载、校验 SHA-256 和签名，先把旧版改名成同目录的隐藏备份
  `.X.app.xingmang-old-<随机>` 再挪新版进去，换完核对新版签名，任何一步出错都换回旧版；上次换到一半断电的，下次先换回来。
  挪旧版被拒（EPERM）当作 Mac「App 管理」拦住，界面弹「去打开」（`desktop:open-app-management-settings`，主进程里写死的
  系统设置地址，不进外链白名单）。客户点「关掉并更新」才关：只给主进程发 SIGTERM，等 20 秒，剩下的再发一次、再等 10 秒，
  从不 SIGKILL；换之前主进程再看一次它开没开着，客户没同意就不换。星芒关掉的那一份，更新完帮它重新打开。
- IPC：`installExternalClient` / `installCodexDesktop` 多一个可选的 `DesktopAppUpdateRequest`（`parseDesktopAppUpdateRequest`
  只认 `update: true` 和 `closeRunning`），新增通道 `desktop:open-app-management-settings`。首页「工具有新版本」通知在 Mac 上
  等第一次真检测回来再出，把这几个桌面端也算进去。没真机演过的三处要真机看：「App 管理」拦住时报的是不是 EPERM、
  系统设置那条地址在 Mac 13 以上各版本能不能直接开到「App 管理」、三个 App 收到 SIGTERM 会不会正常退出。
- 作品库三个素材库（`ai-asset-store.ts`、`ai-video-asset-store.ts`、`ai-audio-asset-store.ts`）的 `saveAs`
  从直接 `fs.promises.writeFile` 改成 `writeAtomicSafeBinaryFile`（审查总表 N4，含 H-N4-SUPPLEMENT，Refs #1489）：
  先写同目录临时文件、落盘后改名替换，失败时清掉临时文件，旧文件不动。对话页、视频剪辑、作品库、画布四个
  另存入口都走这三个 `saveAs`，一起修好。权限位显式给 0o644，跟原来 `writeFile` 在常见 umask 下一样，
  不用原子写默认的 0o600。顺带跟其他导出（诊断、反馈、对话、画布项目）一样做了 I8 的检查：保存位置经过
  符号链接或目录联接、目标是硬链接时拒绝（「C 盘搬家」的联接照旧放行）。报错文案沿用原来那三句。
- `runtime-install-service.ts`：装 Node.js 前查到 Windows 在等重启（CBS `RebootPending`、Windows Update
  `RebootRequired`）不再拦下抛错，只记 `node.install.restart-pending`（带原因）进运行日志；查不清时照旧记
  `node.install.restart-probe-failed`，那行进度不再上屏。依据：Node.js 官方 MSI（`tools/msvs/msi/nodemsi/product.wxs`）
  的 LaunchCondition 只拦系统版本、没有看重启标记的自定义动作；安装带 `/norestart`，要重启时回 3010 走原有重启框，
  1603、1618、1925 原有文案已叫客户重启。原来拦法对合盖不关机、标记卡住重启了还在的电脑是死路。装工具时缺
  Node.js 自己补装那一路（`cli-install-service.ts`）本来就不查，两边现在一致。
- Mac、Linux 上找全局安装目录的 `npm root --global` 不再每次检测都起一个 node 进程（0.2.22 性能体检第 13 条，报告
  `/mnt/project-files/0.2.22-性能体检.md`）。`tool-installation.ts` 新增 `createNpmGlobalRootLookup`，服务里那一份
  （`system-service-context.ts` 的 `resolveServiceNpmGlobalRoot`）按「npm 路径 + 跑它用的 PATH」记到这次运行结束，
  重新检测、装工具、开工具、查更新都共用；同一时刻的几次查询只起一个进程。
- 什么时候重问：npm 的入口文件换过（按 realpath 后的 dev、inode、大小、修改时间、ctime 判断；升级 npm、重装 Node.js 都会换掉它，
  修改时间是解压时从安装包里带过来的，不一定变，inode 或 ctime 一定会变）、用户 `.npmrc` 改过（`npm config set prefix`）、PATH 变了
  （Mac 上改用代下的那份 Node.js）、本软件装过 Node.js（`runtime-install-service.ts` 在 finally 里作废，装到一半失败也算）。
  没问到（超时、npm 坏了）和读不出文件身份的都不记，下次照旧再问。
- 只省进程：拿到目录以后的包清单与 realpath 校验一步不少；Windows 本来就不跑 npm（直接取 npm 旁边的目录），不变。
  本软件没有卸载 Node.js 的入口，客户自己删掉的，入口文件读不到就当认不出，照旧现问。
- 账号这一轮还在给某个工具换密钥时从托盘、快捷键或记录页「接着聊」打开它（0.2.22 打磨清单 B4，主路卡点 F7；
  yoyo 10-27 回「打磨改」）：以前只弹「正在同步这个工具的账号连接，请稍后再打开。」就停下，好了也不自己打开。
  现在弹「正在连接账号，好了会自动打开。」，`useToolLaunch.ts` 的 `waitForAccountConnection` 改成真等——
  新模块 `launch-wait.ts` 每 250ms 看一眼 `accountKeyChangeInProgress`，那一轮写完就重读配置接着打开；
  换了账号、关了窗就不开；那一轮没给这个工具写成的，把首页横幅同一句（`resolveToolKeySyncFailure`）弹一下、
  不带着旧密钥打开；等满 3 分钟还没完的放手，说回原来那句，免得「打开中」永远挂着。等的这段只占它自己那张卡
  （本来就是灰的）：首页的 `launchBusy` 和 `requestLaunch` 的去重都把停在等账号那一轮的那次放过去，别的工具
  照常能开，不陪它等 3 分钟（复审 10-27）。`app-check.mjs` 两条用例改成断言自动打开、等的时候别的工具能开、失败不开。
- 「账号未开通」给出路（0.2.22 打磨清单 B5，主路卡点 F5；yoyo 10-27 回「打磨改」，没加新字）：开机签密钥时服务端说
  账号没开通某个工具（分组不可用）的，首页横幅那句后面加「找客服」按钮，那张卡的主按钮「确认连接」换成「找客服」，
  都开帮助框里的客服二维码（`Home.tsx` 新加可选 `onHelp`，App 接 `setHelp(true)`；缺省 = 旧行为）。同一轮里还有
  能重试的失败时「重新同步」「找客服」两颗都给。夹具加 `?notEnabled=<provider>`，`app-check.mjs` 加一条用例。
- `electron/redaction-patterns.ts` 脱敏表只加不减（0.2.22 打磨清单 A7，遥控审查 YK-4 第 2 点）：PEM 私钥块
  （`-----BEGIN … PRIVATE KEY-----` 到配对的 END 行，没有 END 行的到文末）整段打码、首尾两行留着；`name=value` 的名字多认
  以 `key` 结尾且前面带一段的（`AWS_SECRET_ACCESS_KEY`、`PRIVATE_KEY`、`ssh-key`，`.env` 的写法）和 `passwd`，光秃秃的 `key=`
  （运行日志里安装队列的那一项）、`queueKey`、`max_tokens`、`password_hash_rounds` 照旧能读。沙箱实测原来 `MY_APP_SECRET=`、
  `DB_PASSWORD=` 这类带前缀的名字本来就打码（名字规则不卡开头），清单那句说漏了；真漏的是以 `_KEY` 结尾的和私钥块。
  以 `key` 结尾那条只许从名字开头起匹配（lookbehind）：不然一长串字母（base64、日志里 8 KB 的填充值）会被逐位重扫，运行日志的
  超大 detail 用例直接超时。私钥块那条不用正则配对、改成一趟向前扫（`redactPrivateKeyBlocks`）：正则会从每个 BEGIN 行
  再把后面的字读一遍，日志里引了几千次密钥文件就是平方级（沙箱实测两万个没 END 的 BEGIN 行要十秒）；没有同名 END 行的
  BEGIN 从那里到文末全打码，别的块的 END 行不算它的（复审 10-27）。手机遥控发出去的字（`redactRemoteText`）、运行日志、
  诊断导出、崩溃报告走的是同一张表，一起生效。
- 手机遥控 Codex 两处（0.2.22 打磨清单 B8、C2；yoyo 10-27 回「打磨改」「停改」，字按清单原句）：
  退出星芒时跟手机说一声（遥控审查 YK-10）——`codex-remote-service.ts` 新加 `farewell()`，主窗口 `prepareToQuit`
  里和断加速、等聊天记录写完一起等，最多 1.5 秒（要比 prepareToQuit 那 2 秒的清理预算短，不然退出那边先记一条
  「清理超时」），给开着遥控、绑着人的渠道各发「电脑上的星芒关了，遥控已停。再打开星芒并打开遥控才能继续。」；
  `dispose()` 仍在 will-quit 里同步收尾，不等网络。Windows 关机那条路不经过 prepareToQuit，不为一条消息推迟关机。
  退出没退成的（装更新时安装器没启动起来、Mac 卸载移不进废纸篓，两处 abort 都调 `quitAborted()`）：说过「关了」的渠道
  补一句「电脑上的星芒没关成，遥控还开着，可以接着用。」（复审 10-27 补的新字，yoyo 10-27 回「按照推荐」批过），没说过的不补。
  一轮任务 1 小时没任何动静就当 Codex 卡死（YK-13）——每轮一个 `stallTimer`，开始、每条通知、每次问审批都重新起算；
  到点请 Codex 停下、等你同意的一律拒绝，发「这件事 1 小时没有任何进展，已经停下。可以重新说一遍要做什么。」，
  之后再发消息能开新的一轮；日志 `remote.turn-stalled`。
- `electron/main.ts`：Mac 闲时装新版本（#1380）装到一半用户从菜单栏、系统通知点开了窗口，装好重新拉起时窗口照常出来。
  之前撤回 `backgroundInstall` 记录的那条只挂在窗口第一次显示上（`once('show')`），管的是开机自启那次的后台装；闲时装多半发生在
  窗口开过又缩回去以后，第一次显示早过了，于是重新拉起的那次被当成后台装的拉起、窗口不出来。现在挂在每一次显示上
  （`dropBackgroundInstall` 没有后台装记录时什么也不做）。0.2.22 发版前回归检查第 5 条。
- `electron/auto-update-install.ts` 新增 `memoizeUnattendedInstall`：跳框器每两秒问一次「装的时候弹不弹窗口」（`canInstallUnattended`），
  每问一次都解一次符号链接、试两处能不能写，全是同步读盘；同一种装法一分钟内只算一次，装法换了就重算。0.2.22 性能体检第 7 条。
- `electron/app-settings.ts`：`readAppSettings` 给主文件加了一层按 lstat 身份（设备号、inode、大小、mtime、ctime）校验的读缓存。
  主窗口每次 resize 和 `platform/renderer-v2.ts` 每次重算缩放都同步读 `settings.json`，拖窗口时一秒几十次，每次都是
  open + 三次 stat + realpath。只缓存主文件完整校验读成功的结果，不是普通文件、有第二个硬链接、stat 读不出的照旧走完整校验；
  自己的保存走 rename，inode 必变；备份与缺省不缓存，主文件坏了下一次照旧落到备份。0.2.22 性能体检第 8 条。
- 0.2.22 发版前文案打磨（清单 `/0.2.22-打磨/清单.md` A4–A6、B1/B2/B3/B6/B7，yoyo 10-27 回「打磨改」，字按清单原句）：
  新版下好的系统通知（`electron/desktop-notifications.ts`）和首页更新气泡（`registry/business.ts` 的 `autoUpdateBubbleBody`）不再说
  「不打断你现在用」——下好 3 秒就跳框问装不装（#1380）；能闲时装的 Mac 两处多说「你不用电脑时星芒也会自己装好。」，靠 `UpdateSnapshot`
  新加的 `idleInstall`（`setIdleInstall`，main.ts 的 `refreshIdleInstall` 开机按 `canInstallUnattended` 算一次，之后跟着遥控开关变：
  遥控开着闲时不装（YK-2），这句就收起）；教程「工具箱自己更新」那句 #1450 已经改过，这里不碰（回归检查第 6 条）。
  首页「连不上」红条开头「星芒管理工具能连上，但 AI 工具会连不上。」改「星芒管理工具本身能连上。」（主路卡点 F13）。
  钱包 $0、没订阅时（`BalanceRunway` 新加 `empty`，和 `homeWalletEmpty` 同一个判断）侧栏账号卡说「余额已经用完，充值后才能用」、首页余额卡
  和个人中心说「余额已经用完」、侧栏「充值」旁挂「余额为零」，不再说「不到 1 天就会用完」「余额低」；还有一点钱的照旧。
  视频剪辑「烧字幕」改「加字幕」（JJ-6）。手机遥控介绍和手机上回「帮助」那句改成「要改文件、跑会改东西的命令才问，只是看文件不问」（YK-4；
  更新说明分片 `011-codex-remote-feishu.md`「## 用户」里同一句跟着改，字就是批过的那句）。
- 只换符号不动字：应用内路径「个人中心 → 密钥管理」「个人中心 → 账号安全」「设置 → 启动关闭」统一成 v4 的「›」（系统设置的路径保留「→」）；
  「正在加载页面...」改「…」；首页「试试第一条命令」三句提示词的半角逗号改全角；主进程生成、直接上屏的「Key」「API Key」改「密钥」
  （连接自检、检查页、配置框报错、首页同步失败那半句、新建密钥的校验、IPC 入参校验的报错），测试跟着改，旧界面 `src/` 不碰。
- 测试：`electron/provider-sessions.test.ts`「re-reads only the session file whose size or mtime changed」第二次列表后探测缓存在后台原子写，用例没等它写完就结束，`afterEach` 的 `rmSync` 撞上临时文件报 `ENOTEMPTY`（#1474 的 `macos-test` 红过一次）。用例末尾改成像前面那样 `vi.waitFor` 等缓存里出现改过的标题，不调超时、产品代码不动。
- 审查报告 R28-2（#1489）：导入只在开头把聊天页卸下一次，之后读历史、合并、写盘那几次 await 期间，
  点进聊天页会重新挂上它；主进程 `read` 只排在已经送到的写之后，导入那次写还没送到时聊天页读到旧的一份，
  下一次自动保存写旧列表，主进程随即删掉刚导入的对话文件。
  现在 `src/renderer-v2/features/chat/storage.ts` 按账号记着正在进行的导入（`runHistoryImport`），
  `loadChatHistory` 先等它写完再读，同一账号的导入一个接一个跑；导入自己改用内部的 `readChatHistory`，免得等自己。
  人正停在聊天页时清掉 `chatScope` 卸不下它，`App.tsx` 再给聊天页换个 key 让它重新挂上，挂上后同样等导入写完再读。
  单测在 `storage.test.ts`、新的 `transfer.test.ts`，整页回归在 `testing/app-check.mjs`（夹具加了 `?chatImport`）。
- 发版补发另一个平台时，线上的分批放量要是只管别的平台（比如留着 `0.2.23 0@linux`、又补发 Mac），
  `scripts/release-rollout.cjs` 把补发的平台并进去、比例照线上的；以前说「照线上的走、不改」，补发的平台
  不在名单里，等于全放（#1525 R29-04）。
- 放量体检按平台分开看（R29-05）：有电脑下好了新版没装上的平台、放量只管的平台，即使新版一条打卡都没有也单列一格。
  某个平台试着装的一台都没升上去，攒到 3 台·天就建议停住，不再被别的平台升上去的摊薄成「建议放开」；
  试着装过的太少时再等等，不拿别的平台顶。放量只管某几个平台时，样本够不够按那几个平台算（`scripts/rollout-health.cjs`）。
- 手机遥控正在打开（读设置、读凭据、查 Codex 装没装，或换凭据后等旧连接停下）的那几秒里被状态文件远程关掉，
  打开完不再照常连上（R29-06）：`codex-remote-service.ts` 的 `startChannel` 连上之前再问一次能不能开、
  星芒是不是在退出，不能开就停下并报那句「暂时停用」；读密钥那一下里渠道被关掉的，这一份不再交给网络去连。
- R29-07：`sensitive-clipboard.ts` 的自动清理责任在失败路径上不再中断。后一次写入真正落定才接替前一段的清理，
  没写进去前一段照原计时清；到点读不了剪贴板隔 3 秒再试，最多再试 2 次。对外只写到这一层。
- 只用星芒账号时不再一直查历史账号站的线路（0.2.22 性能体检第 11 条）。原来开机两个站都进应用线路控制器，
  只用星芒账号的客户开机半秒内就去问 api.solov.cc，之后每 5 分钟、唤醒、换网也都查它，查出结论还叫界面重读一轮
  设置、配置和外部客户端。现在 `bootstrap/network-routes.ts` 开机只 `start(['solov'])`；历史账号的站等账号服务
  说它用上了才开始查（`main.ts` 的 `onChanged`：登上了，或者开机恢复它没连上、正等着重试，都叫
  `relayRouteController.ensureWatching`），照开机那一轮查（有结论两条一起查），在那之前照旧报上次存下的结论，
  也不跟着唤醒、网络恢复、「重新检测」查。那时它上面已经有请求没走通、正按三次规矩查着的，查完马上补一轮两条一起查。
  换线路只在是当前账号那个站时才叫界面重读。动之前核对过：写工具配置、换线跟过去（含 #1552 的老配置）、外部客户端、
  Codex 对话太大换线都只认当前账号的站，星芒账号下历史站的线路怎么变都不会改任何工具配置，所以不用为了工具配置里
  残留的历史站地址去查它。
- 发版门禁不再把出货渲染层和画布的单测跑两遍：`scripts/run-release-build.cjs`（Windows 出包）和 `publish-release.yml` 的
  `linux-checks` 原来在 `npm test` 之后又整条跑 `test:v2`、`test:canvas`，而 `test:vitest` 的 `src` 早把 `src/renderer-v2`、
  `canvas-v2/src` 挑进去了（#1066 在 CI 那边查明并去掉）。现在只补 `npm test` 不跑的 `test:v2:browser`，`test:ui` 照旧；
  门禁步骤 14 → 13，`run-release-build.test.cjs`、`ci-workflow-config.test.cjs`、`publish-workflow-config.test.cjs` 钉住不再重跑。
- 远程开关第二批（商业级差距 G04）：服务状态文件加 `featuresOff`，某个功能出了事、还没发版修好时先关掉它（0.2.23 起的客户端认）。
  能关的写死在 `electron/remote-features.ts`：视频剪辑、手机遥控 Codex、Mac 闲时装、托盘省内存、网络加速的新连接、
  Codex 桌面端中文补丁，以及七个工具各自的安装和更新、从星芒打开；状态文件只能挑几样关，打不开任何东西。不写时跟以前一样。
- 主进程新增 `electron/remote-feature-gate.ts`，跟着更新快照里的 `featuresOff` 走（只认最近一次读成功的那份）：点了才做的事
  用 `assertOn` 拦下（状态文件第一次没读完时最多等 2 秒，之后不等），同步的 IPC 处理器套 `runWhenOn`，开着时照原来同步走；
  后台的事用 `isOff`。关掉手机遥控时开着的渠道当场停；关掉加速时连着的照常能停，托盘「连接加速」灰掉；关掉中文补丁时
  Codex 桌面端照常打开、只是不经调试端口打补丁（自动写的语言设置照旧）。
- 渲染层认出带「修好以后会自动恢复」的报错，弹「这个功能暂时停用了」框（`registry/errors.ts` 的 `featureSuspended`），
  首页卡片不记「没装上」；视频剪辑页、网络加速卡在关掉时先说清、按钮先灰掉。所有新字 yoyo 2026-10-28 回「停用改」批过。
- service-status 工作流加「远程关功能」一格（`video-studio`、`-video-studio`、`none`，可带 `@版本|版本@平台`），
  写错名字直接报错，预览里列出关掉的功能；操作见 `docs/SERVICE-STATUS.md`「远程关功能」。
- 服务状态文件 `service-status.json` 加两项「少做一点、多说一句」的远程开关（在线热更新方案路线 A，0.2.23 起的客户端认）：
  `knownIssues` 在某一页或每一页的右上角挂一句已知问题提示（可带「查看更新」「找客服」一颗按钮，带网址的整条不显示），
  `paymentMethodsOff` 在软件的充值页和买套餐弹窗里藏掉某几种付款方式（主进程过滤付款方式列表，页面开着时被藏掉的
  点付款时在主进程拦下）。两项都能按版本、平台收窄，一次没读到状态文件时接着用上一次读成功的那份。service-status
  工作流加「已知问题提示」「上面那条只给谁看」「充值页藏掉的付款方式」三格，预览里逐条写明；操作见 `docs/SERVICE-STATUS.md`。
- Mac 代下的 Node.js 改成和 Linux 一样钉版本和每个架构的校验值（S02，#1489；yoyo 2026-10-29 回「照Linux」）。
  `electron/macos-node-runtime.ts` 钉 v24.22.1（和 Linux 同一版，测试钉住两边一起抬），darwin-x64 / darwin-arm64 两个
  SHA-256 从 nodejs.org 的 `SHASUMS256.txt.asc` 抄，抄前用 nodejs/release-keys 的公钥核过签名（签名人 Antoine du Hamel，
  `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`），也和两个压缩包实际下载下来的摘要对过。对不上就不装、原来那份留着；
  Developer ID 核对照留。不再请求 `index.json` 和 `SHASUMS256.txt`，进度里少了「正在从…查询 Node.js 最新稳定版」那一句。
  已经代下过的那份不会被自动换掉。
- 用量看板按型号汇总服务端数据时改用隔离的数据容器，服务端回来的型号名只当普通键用，
  改不到主进程里的共享状态。审查总表 S04（#1489）。
- 画布运行里一下子就失败的节点（当前账号不支持视频、节点没填提示词、没选分组这类，节点上本来就会显示原因）
  不再被当成「未处理的 Promise 拒绝」记进运行日志、发到 Sentry（Sentry ELECTRON-6「当前账号暂不支持视频生成」就是这样来的）。
  原因在 `electron/canvas-run-engine.ts`：执行器的结果要等「处理中」这一步写完盘才去接，执行器在这段时间里就失败了，
  Node 当成没人接，`main.ts` 的 `unhandledRejection` 照样上报；现在执行器一启动就挂上接收，失败照旧记在节点上。
  真正没人接的拒绝和主进程崩溃照常上报，上报那一侧没改。
- 网络差时续登录被作废（10-27 排查「当前登录已结束」时读 new-api rc.44 源码发现的漏洞；那一单的主因是找回密码第 3 步的
  另一个空当，不是这个）：new-api 每次续期都换一把新的续期凭据，旧的只在 30 秒内还认（rc.44 `service/auth_token.go` 的
  `RefreshReplayWindow`，那 30 秒里拿旧的来会发回同一把新的）；过了 30 秒再拿旧的来就当被盗，整个登录当场作废
  （`refresh_reuse`，401 `AUTH_SESSION_REVOKED`）。续期发出去、服务器换了凭据、回话却丢在路上时，客户端手里还是旧的，
  下一次续期（常在几分钟后）就把登录弄没了。
- `new-api-client.ts` 的 `refreshCurrentSession` 改走新的 `refreshAllowingLostAnswer`：续期没等到回话（超时、连接半路断了、
  网关或服务回了 5xx）时，隔 2 秒拿同一份旧凭据补续一次；从第一次发出算起超过 20 秒就不补（留 10 秒给它走到服务器），
  也只补一次。同时要续期的请求照旧共用一次（`refreshInFlight`），补续也在这一次里，不会并发续期；等的那一下里登录换了、
  退了就不补。服务器回了话的（401、429）和根本没送到的（解析不出地址、证书、门户拦截、代理没放行）不补。开机恢复
  （`switchSession`）不走这里，它有 `restoreAllowingOneTimeout` 那一次补试。
- 登录结束记日志：服务器不认这次登录、本机跟着清掉登录时，运行日志记一行 `account/session.ended`（先被拒的请求、
  最后拒掉登录的请求、状态码、服务器回的 code、请求编号、线路，以及之前有没有续期没等到回话、补没补），补续本身记
  `session.refresh.retried`，来不及补记 `session.refresh.lost`。都不记凭据。`NewApiClientOptions` 新增 `log`（主进程在
  `bootstrap/accounts.ts` 接到 `runtimeLog`），401 时是哪个请求、回的 code 挂在 WeakMap 上，不加错误对象的字段。
- 历史账号（sub2api）的续期没动。
- 主进程开机少加载 69 个模块（0.2.22 性能体检第 5 条，只做「用到再加载」）。二维码库 `qrcode`（连同 `pngjs`，58 个文件）只在
  扫码付款（`payment-window.ts` 的 `openQrCode`）、手机遥控扫码登录（`ipc/handlers/codex-remote-weixin.ts`）时才 `import()`；
  检查页那一套（`diagnostics.ts` 和各项检查、`diagnostics-dns-check.ts`、`diagnostic-fixes.ts`）在 `bootstrap/diagnostics.ts`
  的 `run` / `fix` 和 `diagnostics:fix`、`diagnostics:open-folder` 两个处理器里用到才加载。开机就要的线路探测地址
  `relayStatusProbeUrl` / `relaySiteStatusProbeUrls` 从 `diagnostics-network-checks.ts` 搬进新的 `relay-status-probe.ts`
  （原处照旧导出）；导出和脱敏（`diagnostics-redaction.ts`）、Codex 实测、反馈报告那几段照旧开机就接好，对外的方法签名都没变。
  `main.test.ts` 新增一条，顺着 `main.ts` 的静态 import 走一遍，钉住这几样不在开机加载的范围里。
- 沙箱实测（Linux 4 核、断网、编译产物，改前改后交替各 10 次取中位数）：主进程加载代码 279 → 253ms，`app.ready` 313 → 285ms，
  窗口显示 568 → 517ms；开机加载的模块 777 → 708 个，开机后 6 秒内二维码库和检查那一套都没被加载。
- 量过没动的：`electron-updater`（约 140 个文件、按模块自身耗时记约 35ms，最大的一块）和 `yaml`（约 15ms）开机本来就要用：
  更新服务在开窗前建好，Windows 正式版开机就读 `app-update.yml`、加速在线节点开机就读存下的那份。要省得把更新服务挪到窗口
  出来以后再建，牵动自动更新那条链，不在这次范围。编译缓存不做（用户目录里的字节码会绕开安装包的 asar 完整性校验）。
- 第一次登录时新手引导、首页导览开着，「软件出错时会发送错误报告」「软件会发送匿名使用情况」这两张开机卡先不出，引导和导览都关了再出
  （主路卡点 F11：原来引导、这张卡、「欢迎回来」、导览挤在同一屏，卡片还盖住工具卡的按钮）。
  做成通用条件：`StartupNotice` 新加可选的 `waitsForOnboarding`，`startup-notice.ts` 的 `startupNoticesShown`
  在引导开着、或导览正在首页放时把标了它的卡先收着（卡片仍在那一摞里），`App.tsx` 交给 `StartupNotices` 前过一遍。
  错误报告（`crashReportingNotice`）和匿名使用统计（`usageStatsNotice`，#1440）两张登录后说一次的告知卡标了它，
  以后再加同类的标上就跟着等；没标的照旧马上出。
  导览只在首页放，客户在别的页时看不见它，那时卡片不等。告知的字、缺省开关、「已告知」的记法都没动。
- 软件自带教程跟上 0.2.22：聊天那章不再教「选好分组」（#1399 以后聊天只选厂商和模型），生成图片那步、
  聊天插图同步去掉分组；更新那章不再说「不打断你」，改成下好后跳框问装不装（打磨 B1 漏掉的第三处）。
  聊天出错提示里「更换可用分组」「准备分组」两处改成充值、重新登录后重试。`registry/tutorials.ts`、
  `features/tutorial/TutorialIllustration.tsx`、`features/chat/state.ts`，测试钉住教程不再叫客户选分组。
- #1489 U01：`features/extensions/mcp-paste.ts` 的 TOML 子集解析加固。表一律不带原型（`Object.create(null)`），
  取表、查重只认自有键（`Object.hasOwn`）；键名是 `__proto__`、`constructor`、`prototype` 的整段不认，和别的认不全的
  TOML 一样回「没认出这段配置」。顺带 `toString`、`valueOf` 这类普通对象上本来就有的名字，现在当普通键名认。
  粘贴框是 0.2.23 新功能，没有对客户可见的变化。
- 清掉主进程和 v2 界面里四十来处声明了却没人用的 import、类型、变量和一个内部函数（`config-save-service.ts` 的
  `cliHooksStale`），大头是拆页面后 `pages-account.tsx` 留下的 30 多处；不改任何行为（仓库清单 G19）。
  三处故意留着的「类型钉子」（`system-snapshot-cache.ts`、`external-client-snapshot-cache.ts`）不动。
- 更新下好时多记一条日志 `updater/download.measured`：这一次实际从网上下了多少字节（`receivedBytes`，
  增量下载的块表、改了的那几段、增量没成时改下的整包、停住或代理连不上后的重下都算在内），跟清单里
  下好的那个安装包有多大（`packageBytes`）、占几成（`percent`，整包时会略过 100）、重下过没有、用了多久
  放在一起，好看增量下载到底省了多少（在线热更新方案 B1）。字节由 `update-request-guard.ts` 在
  electron-updater 读的响应上数（新增 `receivedBytes()`），`updater.ts` 新增 `downloadReceivedBytes` /
  `downloadMeasured` 两个可选钩子，日志字句在 `update-state-log.ts` 的 `buildUpdateDownloadMeasureLog`。
  界面不变，下载失败的那次不记。
- `scripts/update-feed-stats.cjs`：「还停在旧版本的电脑下过新版没有」多一句「查更新勤不勤」：没下过新版的停着的电脑每读 100 次状态文件读了几次
  更新清单，两边都按抽样倍数折算（照代码大约 8 次），用来分清「没见查过」是没去查还是抽样漏记。「下过新版安装包的电脑后来怎样」
  每张表下面多一句：还没装上的里面，隔了两小时以上又下过同一版的占几成（多半是上一次没下完或没过校验）。
  更正上一版说明里「Mac 合盖睡着时 3 小时的定时不走」的推测：libuv 在 macOS 上按 `mach_continuous_time` 计时，睡着的时间也算。
  新加一节「更新相关的请求有没有被拒」：多查一次 Cloudflare，状态码 400 以上的请求只按路径和状态码分（不带 IP），
  写出 Mac / Windows 更新清单、安装包和状态文件各被拒几成、最多的是哪几个状态码，用来排除「Mac 查了更新却被拒」。
  套餐不能按状态码分时不查。仍然只写比例。`docs/SERVICE-STATUS.md` 同步。
- `update-feed-stats` 工作流加每天定时：北京时间 6:17（UTC 22:17）自动统计最近 1 天，结果照旧在那次运行的 Summary 页和日志里。
  以前只能手动点，没人点的那几天 Cloudflare 过了留存期就再也数不到（遗漏盘点 10-27 第 8 条）。定时只在主仓库跑；
  手动跑照旧，天数自己填。统计口径、令牌和权限都没变。`docs/SERVICE-STATUS.md` 同步。
- `scripts/update-feed-stats.cjs`：「还停在旧版本的电脑下过新版没有」不再把没机会下的电脑算成「没下过」。一台电脑最后一次出现时
  比它新的版本还没人下过，或者第一次有人下到还不满 6 小时（开着的星芒 3 小时查一次更新），就不算进表里，表下面另写一句这种占几成。
  统计 7 天时，新版出来前就不再出现的电脑原来全算成「没下过」，Mac 一列因此偏低。`docs/SERVICE-STATUS.md` 同步。
- `scripts/update-feed-stats.cjs`：「还停在旧版本的电脑下过新版没有」每个系统多一列「没下、查过更新」：一次都没请求过新版安装包，
  但新版出来以后读过更新清单（Windows 的 latest.yml、Mac 的 latest-mac.yml）的比例，用来分开「关了自动更新（或查完出错）」和
  「开着的时候还没轮到查」。为此多查一次 Cloudflare（更新清单的请求，按来源 IP、路径和小时分组），仍然只写比例，不写台数和 IP。
  说明里补上：Mac 的安装包、更新清单和状态文件在同一个地址，Mac「没下过」不是连不上；强制更新只拦打开了窗口的人。
  `docs/SERVICE-STATUS.md` 同步。
- `scripts/update-feed-stats.cjs`：「还停在旧版本的电脑下过新版没有」的说明和「查更新勤不勤」那句写明：统计开始以前就下好、
  在等装的电脑看不到那次下载、也不再查，会算进「没下、也没见查过」并把「查更新勤不勤」拉低；只看 1 天这种比上一版发出来以后
  还短的时段时它们占大头（10-25 的 1 天统计 Mac 0.7 次、7 天 7.1 次），要看从上一版发出来以前开始的时段。原来那句会在 1 天的
  时段里把「下了没装」说成「开着却没按时查更新」。`docs/SERVICE-STATUS.md` 同步。
- `scripts/update-feed-stats.cjs`：「下过新版安装包的电脑后来怎样」从只看最新一版改成最新两版各一张表（最新那版刚发时大多还没轮到检查），
  「装上了」按这一版或更高算；新加一节「还停在旧版本的电脑下过新版没有」，按停在的版本和系统写这段时间请求过比自己新的安装包的比例，
  分开「下了没装」和「根本没下」；Cloudflare 抽样记的时候看到的只是下限，旁边按抽样倍数给个估算。为的是查 Mac 大半停在 0.2.19
  是没装还是没下到，抬最低版本前先看。仍然只写比例，不写台数和 IP；查询不变，还是那两次。`docs/SERVICE-STATUS.md`「看各版本有多少人在用」同步。
- `update-install-prompt.ts`：Mac 闲时装之前跟退出时装一样，先现读一次服务状态文件（宿主的 `refreshServiceStatus`
  接 `serviceStatusMonitor.refresh()`，最多等 `IDLE_INSTALL_STATUS_WAIT_MS` 3 秒，读不到、读得慢就按上次读到的撤回名单算），
  读完再确认这一版还能装才调 `installWhileIdle`。以前闲时装用的是定时读到的那份（15 分钟一次），把某一版放进撤回名单后，
  那一刻正好闲着、已经下好这一版的 Mac 最多还有 15 分钟会被自动装上它（0.2.22 发版前回归检查第 3 条）。被收回的那一版
  不算「试过了」，同一次运行里下一版下好照样能闲时装；等状态文件那几秒里星芒在退出就不装。
- `electron/update-install-prompt.ts`：Mac「下好时人不在就不跳框、直接等闲时装」和「框开着人走开了就收掉框」这两条，只在星芒窗口
  都缩着时做。闲时装要窗口都缩着（含最小化也算开着），窗口开着的照原来的做法会把这一版记成问过了、或者收掉框，结果这次运行既不问
  也不装，只能等退出（Mac 上很少有人退出）。现在窗口开着、人不在时先不问，每 30 秒看一次，人回来以后照常等 3 秒没人动再跳框，同一段
  只记一笔 `install.prompt.away-window-open`；人不在时窗口被缩起来了，照旧等闲时装。框开着时「窗口开没开」按跳框之前看（宿主跳框时会把
  主窗口叫出来），本来就开着的框不收，留给人回来回答。读不出窗口状态时当作开着。0.2.22 发版前回归检查第 4 条，#1385 带进来的，
  还没发出去过。
- `electron/update-install-prompt.ts`：网络加速开着（`acceleration.hasPossibleSession()`，含打开 Codex 桌面端时自动连的那种）时，
  「下好先问装不装」的框先不跳，等加速关了再按原规矩问（电脑几秒没人动才弹、Mac 上人走开了照样等闲时装）；一直没关的这次运行不问，
  留给退出时或下次打开时装。加速开着时每 30 秒看一次、同一版只记一笔 `install.prompt.held` 日志；读不出加速状态时当作开着。
  原因：开加速的多半在打游戏，过场、读图那几秒就凑够「3 秒没人动」，框一跳会把游戏切出去；点「现在安装」加速会先断、装好也不自己
  连回去。闲时装那一路本来就看加速，这次补的是跳框这一路（0.2.22 发版前回归检查第 2 条，#1385 带进来的，还没发出去过）。
- 跳框（`update-install-prompt.ts`，#1385）不再一刀切排除「打开时就已经下好」的版本，改成只排除自动装已经接手的那一版
  （`attempted`：打开时装、退出时装、闲时装记过的，每次现读）。开机自启后窗口一直缩着、打开时装挂成 `'window'` 等第一次开窗口的
  Windows，Mac 开机自启要输开机密码留到退出（`'skip'`）的，以及开机两分钟里没轮到的，这次运行也会在电脑空闲几秒时弹现有的框；
  以前开机自启、只关机不退出的 Windows 永远停在旧版（Refs #1410 问题 1 建议①）。`main.ts` 跳框前先 `withdrawLaunchInstall()`：
  撤掉 `launchInstallAwaitingWindow`，免得跳框叫出窗口时 `'show'` 又预告装一遍；同时置 `launchInstallTried`，客户回答前后打开时装
  不再自己装起来，点「稍后再说」的照框里说的退出或下次打开时装。日志新增 `install.on-launch.withdrawn`。框里的字不变。
- 新增 `upgrade-smoke` 工作流（商业级差距报告 G13）：在 Windows 和 macOS runner 上装客户手上的正式旧版本
  （0.2.19 和最新正式版），让它从本机假更新源自己下载、核对、安装这次的包并重开，再核新版本记下了
  「更新后第一次启动」、上次运行版本、客户设置都还在。`package-for-testing` 出完包后自动接着跑，动到更新链路的
  PR 也跑。只改 runner 上装好的那份旧版本（Windows 换 `app.asar` 里的发布者公钥并修回完整性记录，Mac 统一重签），
  客户包里没有任何口子；旧版本打开之前就断了外网并先自证。Mac 上 Cookie 加密那把钥匙建在这次的临时钥匙串里
  （登录钥匙串按代码哈希放行，新版本会停在钥匙串密码框前），所以升级后第一次打开的那个密码框本身不在冒烟里。见 `docs/RELEASING.md`「旧版升新版冒烟（CI）」、
  `scripts/upgrade-smoke.cjs`。
- `electron/redaction-patterns.ts` 里遮网址用户名和密码的那条规则（任意协议、带密码的那一条）碰到很长的一串字母、数字、
  短横线、点时会越来越慢：原来用 `\b` 起头，串里每个 `-`、`.`、`+` 后面的字母都能起一次匹配，各自把后面整串再读一遍。
  改成只从这串字的开头起匹配、整串只读一遍，另用一个前瞻保住原来能遮到的范围（原来 `\b[a-z]` 能起头的地方，现在照样算）。
  遮出来的结果跟原来逐字相同：200 万条随机短串新旧对比，0 处不同。手机遥控回话、运行日志、诊断导出、崩溃报告共用这张表。
- 测试：`electron/ai-video-service.test.ts` 里用真 `AiVideoTaskStore` 的四条用例（发请求前先记「结果不明」、两单抢最后一个名额、提示词随任务记下、关掉再开接回同一单）原来用 `vi.waitFor` 等假 fetch 被调到或任务记进盘，默认只等 1 秒；中间隔着一到两次带刷盘的原子写，#1536 的 `windows-test (vitest-2)` 在「关掉再开」那条撞过。改成等事件本身：假 fetch 在付费请求发出时 resolve 一个 Promise，记任务的两条等「处理中」那一刻（任务记进盘后才报）。断言照旧，不调超时，产品代码不动。
- 视频剪辑第 1 期 PR1：renderer-v2 新增拼片引擎 `features/video-studio/`，把几段片段拼成一个 MP4
  （统一画面比例、裁边或补黑边、剪头尾、烧字幕、声音重采样后接上，没声音的片段补静音），在后台线程里跑。
  编解码用 Electron 自带的 WebCodecs，画面优先 H.264、声音优先 AAC（Linux 没有就用 Opus），不装 ffmpeg；
  读写 MP4 用新加的开发依赖 mediabunny（MPL-2.0，打进页面，不改源码）。页面和主进程的出片流程
  在后面两个 PR。新增浏览器回归 `video-studio/browser-check.mjs`。
- 视频剪辑「生成 N 段视频？」确认框在「每段单独计费。」后面报「当前余额 $X。」（yoyo 2026-10-29 批的字「余额改」，
  #1406 P2-1 剩下的一半里先做余额）。读的是外壳那份余额（`useSharedAccountBalance`，金额照 `dollars` 的写法），
  读不到或者那份余额不是当前这个账号的就不写这句，同充值页卡头的「当前余额」。按型号报价放到 0.2.23 之后。视频剪辑
  还没发给客户，所以没写「## 用户」。
- 视频剪辑第 1 期 PR2：主窗口新增出视频的通用通道（现在只有视频剪辑页在用）。`video:generate` 出一段视频、
  存进全局作品库，只回编号、缩略图、宽高和时长，途中的进度经 `video:progress` 推给发起的窗口；参考图可以是
  对话里选的图片。另有 `video:cancel`、`video:read-clip`（读字节给页面拼片）、`video:open`（用电脑默认的
  播放器打开，Windows 上经资源管理器转交）、`video:save-as`，以及剪辑页的 `video-studio:plan`（文字型号把一句
  想法拆成几个镜头，答得读不懂才再问一次）和 `video-studio:store-export`（拼好的成片存进作品库）。
  出视频的入参和画布共用一份解析（`parseVideoGenerateInput`），主窗口不收参考视频、参考音频。
  `chatService.cancelAll()` 现在也停没写完的 `completeOnce`，换账号、退出登录不用等它。
- 视频剪辑：成片那一行（「用播放器打开」「另存为」旁边）和说到「AI 作品文件夹」的提示（「已经停下……好了会存进
  AI 作品文件夹」「拼好了，成片已经存进 AI 作品文件夹」等）多一颗「打开文件夹」，直接打开 AI 作品文件夹找片段和
  成片（审查清单 JJ-3）。复用检查页的 `diagnostics:open-folder`（目标 `'ai-output'`，路径由主进程算、过 I8 检查），
  只在 `VideoStudioBridge` 里多挑 `openDiagnosticFolder`，没加新通道；主进程说打不开时按失败显示检查页那句
  「这个文件夹现在打不开……」。按钮字用检查页现成的「打开文件夹」。视频剪辑是 0.2.22 新功能，所以没写「## 用户」。
- 视频剪辑红队剩下的几条（#1406 P2-1 一半、P3-1、P3-2、P3-4、P3-5 和小项；视频剪辑还没发给客户，所以没写「## 用户」）：
- 主进程闸门：主窗口 `video:generate` 照画布那套套上 `CanvasGenerationAdmission`（每个窗口同时最多 20 段在出、
  每分钟最多 80 次）；`video:read-clip` / `video-studio:store-export` 按窗口排成一队、一次只搬一段，排着的超过 12 个
  直接拒，关窗时排着的一起作废。存成片存进发起时的那个账号。页面本来就最多同时出三段、一段一段读，正常用碰不到。
- `createAiVideoService` 加 `onRequestStarted`，主窗口和画布两份视频服务都接上 `onAiRequestStarted`：交给服务端的
  那一单等完（出好、失败、停下），以及开机续取、页面接回的那一单等完，都提醒主窗口刷新余额，同聊天、生图；
  没交出去的不提醒。
- 主窗口 `xingmang://` 回包带上和 `index.html` 一字不差的 CSP 响应头（新增 `electron/app-protocol.ts`，测试钉住
  两份一致）。拼片的后台线程只认自己脚本的响应头、不继承页面的 `<meta>`，以前在里面连哪个站都行。在 Electron 43.8.3
  上实测：协议回包带头，页面和线程里连外站都被 `connect-src` 拦下，真拼一条三段的视频照常出片；用
  `webRequest.onHeadersReceived` 注入的头只到页面、到不了线程，所以不走那条路。凭据门禁
  （`verify-canvas-renderer-boundary.test.cjs`）加扫 `features/video-studio` 和 `features/chat`。
- 工程里存的缩略图地址读回时按编号换成当前版本（`asset-thumbnail.ts` 进渲染层白名单），缩略图一升版旧工程不再
  全是裂图；缩略图出不来（Linux 取不到视频封面、片段被删）时不放裂图，留底色、播放键和镜头号。
- `generate` 开头挡住写分镜、拼片中（同 `writePlan`）；拼片读片段时边读边加，超过 1 GB 停在那一段
  （`addVideoStudioClipBytes`，和拼片线程同一句话）。想法、画面描述发出前去掉看不见的控制字符（换行、制表照留），
  不再报对不上原因的「想法要写 1 到 2000 个字」。README、模块地图、契约注释里「对话页也用 `video:generate`」改正。
- 视频剪辑：片段生成到一半关掉软件（或页面刷新、主窗口重建），再打开时那一段自动接回镜头，不再显示「还没生成」
  让客户再花一次钱（审查清单 JJ-1，0.2.22 新功能，客户还没见过这个问题，所以没写「## 用户」）。页面存工程时
  记下每一镜发出去的请求号，重开后经新通道 `video:resume`（`resumeAiVideo`，T1 三处 + 通道表）找主进程：
  任务还在就接着查（进度照样走 `video:progress`，「停止」照样走 `video:cancel`），已经出完就直接回片段，
  都没有回 null。主进程的任务记录（`ai-video-task-store.ts`）取回片段时在同一次写入里另记「请求号 → 片段编号
  和宽高时长」（`finished`，只留最近 100 条；坏的那条单独丢掉，不连累还在等的任务；没有时不写这一项，老版本
  读写照旧）。`ai-video-service.ts` 新增 `finishOnce`：同一个服务端任务不管是出片段、开机续查还是页面接回在等，
  只查一份、只下载一次、只存一个文件；同一个窗口刷新后拿原请求号来接，接的就是还没回的那一次，哪怕它还在提交。
  只查不提交。没有新的界面文字。
- 视频剪辑：点「停止生成」以后，已经交给服务端（钱已扣）的那几段不再变回「还没生成」，页面拿原来的请求号接着等、
  好了挂回原来的镜头；只停排着队的和还没交出去的（#1406 P1-1，0.2.23 审查清单 严重-1。视频剪辑还没发给客户，
  所以没写「## 用户」）。`useVideoStudio.ts`：停下时按 `cancelAiVideo` 的回答分三种——没交出去的回到原样、
  交出去的（含 cancel 本身报错）转去 `resumeAiVideo` 接回、停下前已经自己结束的按它自己的结果收尾；在接回的
  请求停下时不去取消（停了也拿不回钱，只会让镜头又变回「还没生成」），重开页面后接回的那几单同样。接回时主进程
  说没有这一单（停在提交到一半）的，按主进程「提交结果不明确」那句算失败，不悄悄变回「还没生成」。
- 失败了还记着请求号的那一镜，点「重新生成」先接回、接不回来才重新提交；排队时不再丢请求号，排着队被停下的回到
  失败。接回期间点了停止、主进程又说没有这一单的不再提交。没改主进程、没加通道。
- 视频剪辑：交出去了却没拿到任务号的那一段（回包丢了、服务端 5xx、读不出任务号、提交到一半点了停止、软件被关掉），
  关掉重开以后不再变回「还没生成」让「生成剩下的」再付一次钱（#1489 N2，#1406 P1-1 剩下的那一半；视频剪辑还没发给
  客户，所以没写「## 用户」）。主进程 `ai-video-service.ts` 在付费 POST 之前先在任务记录文件里记一笔「已发出、还没拿到
  任务号」（`ai-video-task-store.ts` 新增 `unconfirmed`，只留最近 100 条，坏条目单独丢、不连累待恢复的任务；写不进不拦
  这次出片），拿到任务号时随任务记录一起划掉，服务端明确拒掉（4xx）或交出去之前就停下时也划掉；`resumeRequest` 碰到它
  照「提交结果不明确」报错，不回 null。那句话挪进两边共用的 `electron/ai-video-submission.ts`（进 `valueImportable`）。
- 页面把这种镜头记成 `unconfirmed` 跟请求号一起存，重开以后直接是失败加那句提醒、不去接；接回时主进程说提交结果不明确的
  同样停下提醒，不换新请求号再提交。再生成时确认框加一句「钱可能已经扣了，片段却拿不回来，可能多扣一次」，按钮变红、
  要先勾「我已了解影响」（同聊天页重新生成），确认后沿用原来的请求号重新提交，MiniMax 拿它当 `Idempotency-Key` 去重。
  这一回没交出去就停下、或者被服务端拒了，上一回那一单照样可能扣了钱：页面回到失败加提醒，主进程也不划掉上一回那一笔
  （`markUnconfirmed` 回答同一个请求号之前是否已经结果不明）。
- 排队的每一段带上确认时的那份设置，轮到它时照那份出（#1489 R28-4）：页面刚打开、模型表还没读完就点了生成，读完以后
  记着的模型被换成默认的、时长跟着挪，排在后面的几段不再悄悄换成客户没确认过的模型和时长。那个模型真的用不了了，
  主进程在扣费之前就拒掉。
- 测试：`electron/ai-video-task-store.test.ts`「keeps only the newest finished requests」和「keeps only the newest unclear requests and drops a damaged one on its own」原来经 store 一条条存满 100 条上限再多存一条，等于 101 次带路径检查和刷盘的原子写；Windows runner 上一次几十到三百多毫秒，#1513 的 `windows-test (vitest-1)` 一条撞过 30 秒、另一条跑了 17.8 秒。改成把上限前那 100 条（新的在前，跟 store 写的顺序一样）直接写进文件，只让越过上限的那一条经过 store，另加一句「正好在上限时一条不丢」。断言照旧，不调超时，产品代码不动。
- `electron/windows-elevation.ts`：Windows 上 `whoami /groups` 一次运行只起一次（0.2.22 性能体检第 2 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。
  开机以前问两遍：判断 CLI 执行边界（`inspectCurrentWindowsIntegrityRid`）一遍，判断更新能不能自动装（`inspectWindowsElevationCapability`）又一遍，
  问的是同一个令牌，跑这个进程期间不会变。现在 `readCurrentWindowsTokenGroups` 由 `createCurrentWindowsTokenGroupsReader` 包一层：
  答出来的原样记住，后面一键检测、装 Node.js、装 Codex 桌面端问到的也是它；同时在问的几处共用一次。失败（超时、起不来）不记，
  下一个照旧重问。调用方的 abort 信号只结束它自己的等待，不交给 whoami，一键检测放弃了不会连累同时在等的安装。
  两个 parse 函数和执行边界的判断都没动。
- 新门禁 `scripts/workflow-secret-scope.test.cjs`（Refs #1090）：发布、上传、签名用的 secret 只许在挂了
  `release` 环境的作业里读，COS 的只许在 `cos-sync` 里读；仓库级只许 2026-10-18 定下的巡检密钥和访问统计
  令牌两把，新 secret 不登记、整包读 `secrets`、交给可复用工作流都会红。`docs/RELEASING.md` 补了在 GitHub
  设置里核对 secret 放在哪一级的步骤。

## 0.2.22 - 2026-10-27

- 热修版本：0.2.21 加上 #1405 一个提交（从 `hotfix/0.2.22` 分支发，见 `docs/RELEASING.md`「热修版本」），修 #1458 客户用支付宝充值时支付窗口打不开。main 上 0.2.21 之后合入的其他改动都不在这一版里，留到 0.2.23。
- 充值、买订阅的支付窗口（`electron/payment-window.ts`）：yoyo 10-26 报「打开充值比较卡，支付页没弹出，拉起支付时星芒卡死」。
  三处原因都在 Electron 43 里真跑复现过：一是 `openTarget` 等 `loadURL` 整页加载完才算打开，付款页上一个脚本、一张图卡在半路，
  `account:create-topup-payment` 就一直不返回，「打开支付窗口」一直转，窗口里的查单也不开始；`<head>` 里的脚本卡住时
  `ready-to-show` 也不来，窗口一直不出现。二是易支付先给一张自动跳转页，这张页没加载完就跳去收银台时 `loadURL` 报 `ERR_ABORTED`，
  收银台明明打开了却被当成「支付页面打开失败」关掉。三是窗口带 `modal`：Windows 上主窗口整个被禁掉，Mac 上变成没有关闭按钮的 sheet，
  付款页卡住时客户关不掉，主窗口里的「关闭支付窗口」也点不到。
- 现在以主框架第一次提交（`did-navigate`）为打开，提交之后 `loadURL` 再失败不算数（新纯函数 `waitForPaymentPage`）；
  提交前失败照旧报打不开，30 秒（`paymentPageOpenTimeoutMs`）还没提交按 `ERR_TIMED_OUT` 报「支付页面打开失败，请稍后重试」；
  提交后 1.5 秒（`paymentWindowShowFallbackMs`）还没画出第一屏也先把窗口亮出来；窗口仍挂在主窗口上，但不再是模态。
  导航白名单、权限、下载、查单规则都没动。界面文字没改。

## 0.2.21 - 2026-10-24

- 新装电脑的工具线路（#963 红队复核的残留第一条）：`tool-route-controller.ts` 在工具线路和应用线路都还没有结论时，
  线路2 第一次没通就去查线路1，线路1 通了马上切，不等三轮；线路1 也不通照原来的节奏接着查，满三轮才出三线全挂提示。
  查出结论之前不写 `tool-route-state.json`，没查完就退出的，下次开机还按全新安装算。有结论以后照旧三轮。
- `acceleration-clash-config.ts` 的 `lineRoutedRules` 加 `DOMAIN,downloads.claude.ai,XINGMANG`（#1373）：Claude Desktop 3P 模式从这个主机下 Claude Code 程序（`claude-code-releases/<版本>/…`）和 Cowork 工作区（`vms/linux/<架构>/<编号>/rootfs.vhdx.zst` 等），国内直连超时。只加这一个主机，claude.ai、api.anthropic.com 照旧直连。洛杉矶服务器的放行名单同步加了这个域名。
- 新增 `claude-desktop-acceleration.ts`：从星芒打开 Claude Desktop 前照 Codex 桌面端那套替用户连上加速（`autoStartedBy: 'claude-desktop'`，不扣时长、看不见），Claude 退出或连满一小时断开；和 Codex 桌面端共用同一次会话时用 `heldElsewhere` / `holds` 交接，后用完的那边断开。`external-client-runtime.ts` 加 `onLaunched`，记下打开的那一份装在哪，供 `stillRunning` 判断它还在不在。
- Claude Desktop 配置弹窗两句提示改成请客户从星芒点「打开」（yoyo 2026-10-24 定的原文）。
- Claude Desktop 装在非系统盘应用卷（`<盘符>:\WindowsApps`，`C:\Program Files\WindowsApps\<包>` 是系统放的链接）时，
  `verifyExternalClientPath` 照旧拒绝（yoyo 2026-10-24 定：校验不放宽）。只在核对已经不过之后，`appx-volume-link.ts`
  认出这个链接，`external-client-runtime.ts` 把「客户端 AppX 路径身份无法验证」换成教客户移回系统盘的话；
  安装时这句不再套「无法确认当前安装状态：」。
- 只装了 Codex 桌面端时扩展页不再把 Codex 当「未安装」：`isCodexCliInstalled`（`codex-extensions.ts`）和首页同一个判断
  （`codex-desktop.ts` 新的 `isCodexDesktopCliInstallation`，`system-scan-service.ts` 两处改用它）。没装 CLI 时
  `CodexExtensionService` 的外接工具列表、添加、移除不跑 `codex mcp`，直接读写 `$CODEX_HOME/config.toml`：照 0.163.0
  `codex mcp add` 的写法（stdio 写 command、args、env，http 写 url、bearer_token_env_var，空的不写），同名整条换掉，
  走 `mutateCodexConfigToml`（备份、原子替换、排在保存配置那一队后面），写完照旧对账；OAuth Client ID / Resource 没地方写，报错。
  `ProviderExtensionService.list('codex')` 同样只读用户那份 config.toml 列外接工具（项目那几层要看信任，问不了 CLI，不列），
  不跑插件列表。两个服务的新选项缺省都按装了算（旧行为），`main.ts` 接上探测。
- `codex-config-toml.ts` 加 `removeTomlTableText`：拿掉一张表连同它单占表头的子表，按行删、别处的注释不动，找不到交给整份重写。
- 界面：`extensionUsableTools` / `extensionToolName` 把只靠桌面端算上的 Codex 叫「Codex 桌面端」；Codex 外接工具的移除改走
  `mcp:remove`（和添加走 `mcp:add` 同一边）；插件页 Codex 那一格不读列表、不自动下插件目录，只放一条提示；两个都装了时说一句共用。
- `mcpAuthorized` 以前认 `authenticated` / `logged_in`，Codex 的 `mcp list --json` 从 0.46.0 到 0.163.0 只报
  `unknown` / `unsupported` / `not_logged_in` / `bearer_token` / `o_auth`：现在只有 `not_logged_in` 挂「需要登录授权」，
  `o_auth` 才给「退出授权」。legacy 的 `McpPage.tsx` 有同样的毛病，已冻结不修。
- 插件页 Codex 那一栏接上启停开关：Codex CLI 没有插件启停命令，`extensionRowState` / `runExtensionAction`
  （`extensions-common.tsx`）对 Codex 插件改走 `plugins:toggle`（`codex-extensions.ts` 的 `setPluginEnabled`，
  直接改 config.toml 的 `[plugins."名字@市场"] enabled`，改完再读一遍核对），照 Codex 技能走 `toggleSkill` 的做法。
  沿用原来的开关、「已停用」字牌和「已启用／已停用「…」」提示，没加新字。
- 主进程 `nativeOperations` 里 Codex 插件的启停照旧是 false：旧界面（已冻结）按它决定画不画开关，改成 true
  它就会把启停交给通用 mutate。`mutationArgv` 的 Codex 插件分支另加一道只认装和卸的检查，免得哪天放开了启停，
  「停用」落成 `codex plugin remove`。
- 依赖锁文件把 `dompurify` 从 3.4.16 升到 3.4.17，修掉新出的 3 条公告让 CI 构建依赖审计报红：GHSA-c6gr-qvv4-5v3f、GHSA-cg2g-xh64-v4q7、
  GHSA-mrv2-3pqr-j5jr（都影响到 3.4.16 为止）。它只是 `@lobehub/icons` → `@lobehub/ui` → `mermaid` 带进来的开发依赖，本仓代码不直接用；
  锁文件只改这一个包的 version / resolved / integrity（数据取自 npm 官方源），`npm ci` 装完锁文件不变。`canvas-v2/` 的锁文件 CI 不审，不碰。
- 依赖：Electron 从 43.8.0 升到 43 线最新的 43.8.3（`package.json` 的范围抬到 `^43.8.3`，不跨大版本），`undici` 从 7.30.0 升到 7.30.1（顶层固定版本）、node-gyp 带的那份从 6.29.0 升到 6.29.1，`fast-uri`（ajv 带进来）从 3.1.8 升到 3.1.9，修掉 2026-10-24 新出的 8 条公告让 CI 构建依赖审计报红：Electron 的 GHSA-jr5w-w6x2-84p9（eMudhra 中间证书被盗用的缓解，修复版 43.8.1）；`undici` 的 GHSA-4qv8-2p9j-2685、GHSA-f72v-6w45-q472、GHSA-xjj6-f33q-929c；`fast-uri` 的 GHSA-w74x-v6f9-j3xg、GHSA-xhq7-xmqj-769h、GHSA-wjr9-j795-jxcr、GHSA-333x-w4r6-6crp。`undici` 和 `fast-uri` 只在构建和测试里用，不进安装包；Electron 是安装包里的运行时，下一版起随包带上。锁文件只改这几个包的 version / resolved / integrity（数据取自 npm 官方源），别的包没动。`canvas-v2/` 自己的锁文件 CI 不审，不碰。
- 依赖锁文件把 vitest 及同套 `@vitest/*` 从 4.1.11 升到 4.1.12（`package.json` 的范围跟着抬到 `^4.1.12`），修掉新出的 2 条公告让 CI 构建依赖审计报红：`@vitest/mocker` 的 GHSA-qxg6-89mg-rqv8、GHSA-xp26-3454-mjgp（修复版 4.1.12）。纯开发依赖，不进安装包，锁文件里别的包没动。`canvas-v2/` 自己的锁文件 CI 不审，这次不碰。
- `provider-extensions.ts` 的 `skillRoots`：Grok 除了 `~/.grok/skills` 再扫 `~/.agents/skills`（Grok 1.0.52 起也读这个目录，
  2026-10-22 用真程序核过，`xingmang-ai-skill.ts` 那段注释写的就是它）。Grok 一个名字只认一份，所以 `~/.agents/skills` 里的技能
  跟 Grok 别的目录（`~/.grok/skills`、项目 `.grok/skills`）同名时不列；两边都有时 Grok 自己认哪份没核过，这里按 `~/.grok` 那份优先（推断）。
  星芒生图技能 `images` 两个目录各装一份，以前 Grok 只列 `~/.grok` 那份，现在也只列一份；`~/.grok` 是同步之后才建的电脑，
  Grok 页以前看不到这个技能，现在能看到。Grok 的技能照旧只读，不给装、卸、启停按钮；Codex 用户层导入就是放进 `~/.agents/skills`（`codex-extensions.ts` `importSkill`）。项目里的 `.agents/skills` Grok 读不读没核过，不扫。
- 在线换节点（yoyo 2026-10-22）：更新目录里新增带发布者签名的 `acceleration-nodes.json`，客户端开机读一次、之后每小时读一次，
  签名对、又比记下的新才原样记进 app data，加速辅助进程每次连接时读它并再验一遍签名；没记过、读坏了、签名不对或发布者撤回了，
  就用安装包自带的节点（`electron/acceleration-online-nodes.ts`、`acceleration-worker-profile.ts`）。签名复用发版的 Ed25519
  钥匙，签的字以 `xingmang-acceleration-nodes/v1` 开头，跟更新包签名不能互换；只能换节点，规则仍在客户端代码里。
- 新工作流 `acceleration-nodes`：把 main 上的 `bundled-acceleration/profile.yaml` 签名发到更新目录，或发一份签名的撤回；
  预览段列出要发的线路（不列密码），上传段挂 release 环境要产品所有者批准，跟别的写更新目录的作业共用 `update-feed` 并发组。
- 加速辅助进程每次连接、测线路都重新读节点（以前第一次读到就一直用到辅助进程退出），在线节点中途换了下一次连接就用上。
- #1361：窄条图标的 `Tooltip` 以前放在图标正下方（`rect.bottom + 8`）还接鼠标，盖住下一个图标的大半截，从「首页」挪到
  「聊天」点到的是提示。`Tooltip` 加 `placement`（`'below' | 'right'`，缺省 `below`），侧栏窄条用 `right`：放图标右边、
  垂直居中、`pointer-events: none`、鼠标离开立刻收，照 v4 原型 `.rail [data-tip]`。`app-check.mjs` 补一条从「首页」挪到
  「聊天」一次点进的用例。
- 发版前核对在线加速节点（#1359）：`publish-release` 的 Windows、Mac 出包作业在准备加速资源之前跑
  `scripts/acceleration-nodes.cjs check`，线上有一份客户端会用的在线节点、又跟这次装进安装包的不一样就停下，
  提示先跑一次 `acceleration-nodes`（publish 或 withdraw）。客户端记下过在线节点后一直优先用它，不拦的话新版换了
  节点，老客户升级后也还连旧节点。线上那份客户端不收（签名不对、格式坏了）也停下，因为客户端不收它也会接着用记下的；只有没有这个文件（404）和撤回过放行。读不到（404 以外）也停下（#493）。
- #1362 第 2 条：`command-search.ts` 的 `settingsEntries` 里，设置项跟所在组同名（加速卡「网络加速」与 `network` 组）时
  组那条不再单独出、这一行的结果名只写一遍；这一行被 `settingsItemVisible` 收掉时组照旧一条。`command-search.test.ts`
  补一条，「搬进设置的卡按旧页名找得到」那条跟着收紧成第一条就是加速卡。
- 生图技能的文件夹和 `SKILL.md` 的 `name` 从「星芒AI」改成 `images`（`xingmang-ai-skill.ts`）。沙箱里抓请求体核过：Claude Code 2.1.302 按文件夹名认技能，
  Codex 0.162.1 按 `name` 认，两处必须一起改；Grok 1.0.52 只认小写字母、数字、连字符，旧名显示成 `ai`。Codex 0.162.1 / 0.163.0、
  Claude Code 2.1.302 / 2.1.307 都没有叫 images 的自带技能（Codex 自带的是 imagegen）。
- 老文件夹在登录同步时原地改名（清单先写进去再改名，改不成这次照旧用老的、下次再试），密钥和客户改过的文件跟着走，一个不删。
  开机那次装文件不改名：它后面没有重新登记画图工具那一步。历史账号不做技能同步，所以那边的老文件夹继续叫旧名。
- 客户自己已有 `images` 的地方一直用旧名，`SKILL.md` 里的 `name` 也写旧名；认不认得出是不是自己装的，只看 `.xingmang-managed.json`
  （新建文件夹装文件前先写上）。退回旧版又装出来的旧名文件夹、早期装进 `~/.codex/skills` 的那份，只有全是自己装的、没改过的文件才收掉。
- Codex `[[skills.config]]` 里改名前写的条目在 config.toml 和两份存着的配置里换到新路径，备份页恢复的老配置也认旧路径；
  画图工具（`xingmang-image`）的登记认新旧两个文件夹名，并在 ChatGPT 账号的 config.toml 和两份存着的配置里只换位置、不新登记。
  改名、装文件、换线路改地址、退出登录清密钥在主进程里排成一队，免得改名途中别处照旧路径写、把老文件夹又建出来。
- 首页那两句「画图工具没登记上」的提示和三句日志里的「星芒画图」换成 `images`（yoyo 10-23 定「只写 images」）；
  AI 工具里画图脚本自己报的错（`mcp-server.mjs`）不改。
- 教程「网络加速」一章三步的位置去掉重复的组名（产品负责人 2026-10-24 回「位置改」）：`registry/tutorials.ts` 的
  「设置 › 网络加速 › 网络加速 → 线路 / 开启加速 / 停止加速」改成「设置 › 网络加速 → …」，跟同一章「剩余免费时长」那步一致。
- #1362 第 1 条：今天那根柱子顶上的金额以前按柱高绝对定位在柱图格子里（`bottom: calc(N% + 5px)`），柱子到 100% 时顶到
  标题行。现在金额挂在柱子 `<i>` 里（`bottom: calc(100% + 5px)`），柱图格子顶上留出一行字的 `padding-top`（首页 17px、
  概览 15px），最高的柱子画到留白下面。`app-check.mjs` 补一条首页和概览都核对两行字不重叠的用例（改之前红）。
- Claude Code、Grok CLI 技能导入、移除（「扩展改」第 2 条）：`ProviderExtensionService` 新选项 `skillTrashDirectory`（`main.ts` 接的跟 Codex 技能同一个回收站），
  给了才让 `mutate({ kind: 'skill' })` 对这两家走 `mutateOwnSkill`：导入复制进 `~/.claude/skills` / `~/.grok/skills`（或项目里同名那层），移除重新扫一遍、只认直接放在它自己技能文件夹下的那份，挪进回收站。
  复制和挪动复用 `codex-extensions.ts` 拆出来的 `resolveSkillImportSource` / `skillImportTarget` / `copySkillImport` / `moveSkillToTrash`（不跟链接、单链接、大小和层数上限，I8），Codex 的 `importSkill` 改调同一套，行为不变。
  Grok 也读的 `~/.agents/skills` 跟 Codex 共用，Grok 那一格不给移除。能力里新加可选的 `capabilities.skill.install`，没给回收站时是 `false`，界面据此决定出不出导入按钮。
  Windows 跨盘挪进回收站的问题（#1357）这两家同样有，还在等真机。
- 界面去掉 `skills-import-unsupported` 那一行、「看怎么放」和教程里的 `skillImportTutorialExtra`；教程外壳 `navigate('tutorial', 'id#补充说明')` 的跳法留着，眼下没有调用方。
- 外接工具不挂「可更新」（`extensionShowsUpdatePill`），详情「更新状态」换成 `extensionUpdateStatus` 那句（Git 来源不写提交号）。
- 精选添加框能用的工具全是「未安装」时出「还没装能用它的工具」和「去首页安装」（`extensionNoToolInstalled`，`FeaturedPage` 新的 `onOpenHome`）；
  只装了 Codex 桌面端时插件弹窗那一格照旧叫「Codex CLI」（以前跟外接工具一样写成桌面端）。
- 装、加、删失败的错误以前只剩「命令执行失败（退出码 1）：claude」，命令行自己说的原因从没到过界面：新的 `extension-command-output.ts` 的 `withCommandOutput`
  把认得出的行（没有就最后三行，已脱敏，最多 240 字）接在「（命令输出：」后面，原错误挂在 `cause` 上；用在 `ProviderExtensionService.mutate` 和 Codex 的加外接工具、加插件、加市场。
  认法在新的 `extension-command-failure.ts`（渲染层可值导入，已登记 `valueImportable`）：缺 Git、连不上 github.com、`already exists` 三种，`operation-error.ts` 只在带着这个记号的话里认，配上 `registry/errors.ts` 新的 `gitMissing` / `githubUnreachable` / `nameTaken`。
- 外接工具的启停按各家自己的做法接上，界面沿用已有的开关和「已启用 / 已停用」提示，没加新字。
- Grok：`grok mcp enable|disable <名字>`（1.0.52、1.0.70 实测，没有 `--scope`，在项目目录里跑才找得到项目那层；
  停用会把名字记进 `~/.grok/config.toml` 的 `disabled_mcp_servers`，重复点照样退出 0）。`nativeOperations` 给 Grok 放开。
- Codex：没有启停命令，停用就是用户 `config.toml` 里那条写 `enabled = false`（0.162.1 实测 `mcp list` 报 disabled，
  `codex mcp add` 别的连接不会冲掉）。新的 `CodexExtensionService.setMcpServerEnabled` 按行改这一个值（启用写回 `true`，
  不删键，免得整份重写），走 `mutateCodexConfigToml`（备份、原子替换、排队），写完按 `codex mcp list` 或配置文件对账，
  装没装 CLI 都一样。`ProviderExtensionService.mutate` 把 Codex 外接工具的启停转给它（新选项 `setCodexMcpServerEnabled`，
  `main.ts` 接上；缺省不给开关，旧行为），不跑命令；项目里那几层和插件带的改不到，跟「移除」一样不给开关。
- Claude Code 这次不做：它没有启停命令，自己的「停用」只记在 `~/.claude.json` 里当前项目文件夹那一份（2.1.310），
  换个文件夹照样启用，跟列表上「所有项目都能用」那组对不上，要加说明字才行。
- legacy 的 `McpPage.tsx` 按 `operations` 画启停按钮，Codex、Grok 那两格跟着出现，走的同一条 `extensions:mutate`，代码没动。

## 0.2.20 - 2026-10-20

- 内置线路换成自建的洛杉矶 Hysteria 2（`bundled-acceleration/profile.yaml` 一条，重算 `profile.sha256`，#1352）：
  节点商把原来 12 条迁到新域名后大多已失效。服务器只放行 ChatGPT / OpenAI 相关域名，所以
  `acceleration-clash-config.ts` 的规则从「其余全走线路」（`MATCH,XINGMANG`）改成只把 `lineRoutedRules`
  （chatgpt.com、openai.com、oaistatic.com、oaiusercontent.com 及子域名，challenges.cloudflare.com，
  选线测速用的 www.gstatic.com）送去线路，兜底 `MATCH,DIRECT`；网络位置探测的 www.cloudflare.com 不送，
  安装源顺序按直连时的位置排。
- `main.ts` 不再给系统服务和扩展服务传 `acquireDownloadAcceleration`：装 CLI、下 Node、GitHub 下插件目录都不借线路，
  用户自己开着加速时下载在内核里按规则直连，也不再算「已加速」把安装源切成官方优先。`download-acceleration.ts`
  和 `startDownloadRoute` 留着，以后有能下载的线路再接回去。
- `acceleration-conflict.ts`：Mac 上连接前对线路服务器的 IP 跑一次 `/sbin/route -n get`，出口是 utun / ppp / ipsec
  就报已有的 `virtual-adapter` 冲突（沿用现有提示和「仍然连接」）。只读路由，不改用户的 VPN 和路由表，主机名不问（不替它解析）。
  2026-10-21 yoyo 的 Mac 开着 VPN 时 QUIC 在 VPN 那条路上超时，同一进程单独走 Wi-Fi 能连。
- 界面「游戏加速」改叫「网络加速」（侧栏/搜索/设置项、卡片标题、使用说明、教程、状态栏悬停、断开通知、换账号报错），
  卡片说明、使用说明、教程里说游戏和下载借线路的句子换成只说 ChatGPT、Codex（yoyo 10-22 回「改为网络加速就行」「改」）。
- 依赖锁文件把 vite 从 8.1.5 升到 8.1.6（`package.json` 的范围跟着抬到 `^8.1.6`）、follow-redirects 从 1.16.0 升到 1.16.1，修掉新出的 5 条公告让 CI 构建依赖审计报红：vite 打包进来的 launch-editor 3 条（GHSA-587h-7wmj-h5pm、GHSA-698v-4r3x-3vcv、GHSA-r825-w8mm-5pxw，修复版 8.1.6）与 follow-redirects 2 条（GHSA-8r9p-f939-6h3c、GHSA-q3jh-wrc6-jgq8，修复版 1.16.1）。follow-redirects 是 wait-on → axios 的间接依赖；两者都是纯开发依赖，不进安装包，锁文件里别的包没动。`canvas-v2/` 自己的锁文件 CI 不审，这次不碰。
- `shell.css`：`.sidebar-floating .v2-topbar` 临时 `-webkit-app-region: no-drag`（#1349 第 1 条）。顶栏是拖动区，
  Electron 在 Windows / macOS 上把那里的鼠标按下交给系统拖窗口，页面收不到 `pointerdown`、焦点也不动，
  #1342 的「点外面就收」碰不到它。浮着时第一下只收侧栏、不拖窗口，收回后顶栏照常能拖；系统画的窗口按钮和红黄绿不受拖动区影响。
  `app-check.mjs` 加一条浏览器用例（Windows、Mac 各跑一遍）：浮着时侧栏外面没有一处 `drag`，点顶栏空白处收回，收回和拉宽后顶栏仍是 `drag`。
  无头 Chromium 不认拖动区，真机上点不点得收以真机为准。
- `new-api-client.ts`：`getDashboard`、`getUsage`、`getTasks`、`listKeys` 改走 `withReadSession`。续期接口刚认过
  refresh cookie、拿新令牌重问还被回 401 时，只让这一次读取失败（`readRefusedAfterRefreshMessage`，挂着原来那次的
  状态码和请求编号进日志），不再 `setSession(null)`。续期接口自己拒了照旧清掉登录；`/api/user/self` 这类认身份的
  请求不变。当初是按 Windows 真机「点用量账单要重新登录」查到的这条路，后来截图看那台碰上的更像另一件事
  （见 `account-page-follows-shell-login.md`），这条照样留着。
- 客户报：ChatGPT 桌面端（合并了 Codex 的那一版）的「聊天」「工作」由 ChatGPT 账号协调（Work 设置、
  浏览器权限都在 chatgpt.com 那边），OpenAI 文档列明用 API Key 登录时 ChatGPT Work 不可用；我们写的是
  中转密钥，只有「Codex」那一栏走得通。只改说明：`registry/tutorials.ts` 新手教程第 4 步、「打开 Codex
  后怎么开始用」第 2 步、「出问题怎么办」新增一步（首页落点，Linux 版按 page 过滤）；`guide-result.ts`
  新手引导最后一步在用密钥的桌面端上提示先切到「Codex」。不改 Codex 配置，不隐藏「聊天」「工作」。
- 客户 Mac 上开着 Clash（127.0.0.1:7897）时，旧加速会话的恢复记录让启动恢复每次都先弹授权、再因为「有开着的 127.0.0.1 代理」判成配置错误，后台按 5/15/30/60/120 秒重试，独立加速进程在主程序退出后还在弹（2026-10-18 排查）。原生助手（`native/macos-system-proxy.swift`）：只把「开着、主机 127.0.0.1、端口等于恢复记录里那个端口」认成自家，别人的回环代理跳过；恢复先只读算出要写什么（`plan`），没东西要写而且系统里已生效就直接删记录、不要授权，自家端口被改过一半的网卡在弹窗前就报新错误 `conflict`；SCPreferences 加锁、提交、生效被拒（`kSCStatusAccessError`）报 `authorization` 而不是 `configuration`。
- 取消就停：助手记住「上次没拿到用户同意」，之后自己发起的恢复（父进程断开时的清理、`stop`）走新的 `restore-quiet`，有东西要写就报 `deferred`、不弹窗、记录留着；`restore`、`recover` 照旧会问。断开后的清理最多试 3 次，被拒、`deferred`、`conflict`、`busy` 当场退出（以前没有上限）。`platform/macos-system-proxy.ts` 新增 `restoreQuietly()` 和 `release()`，错误带上封闭的原因（`accelerationProxyFailureCauses`：declined、deferred、conflict、busy、storage、configuration、helper、other），日志只记这个词。
- 后台（`acceleration-development-backend.ts`）：Mac 上恢复被拒或连续失败 3 次后改用不弹窗的恢复，重试间隔放到 60 秒；只有用户点「开启加速」「停止加速」才再问。worker 启动恢复被拒时不再让初始化失败，状态显示新的 `proxy-declined`（「上次加速改的网络设置还没改回。点「开启加速」或「停止加速」时会再问一次电脑密码，输入后就能改回。」，托盘「网络设置还没改回，要输电脑密码」）；host 记住这件事，之后重拉 worker 也不弹，直到用户点开启或停止。worker 退出清理在没有内核在跑时最多 4 次，恢复被拒就直接退，内核在跑时先放掉助手。
- 日志：`acceleration.recover.withheld`、`proxy-restore` 失败、助手故障都带上原因词，以前一律只有 `proxy-restore`。
- Codex 桌面端（只 Mac）：Codex 已在运行、启动参数用不上时，`codex-desktop-startup-route.ts` 不再为它连加速（新日志 `codex-desktop.startup-route.already-running`）；为打开 Codex 连上的加速，第一次检查放在 20 秒（`startupDisconnectMs`），看到窗口就断开，正好落在系统授权 30 秒有效期里，断开不再另弹一次。这两个默认值是协调者按推荐定的，发版前可改。Windows 行为不变。
- 测试：原生夹具新增 4 条（另一个回环代理不动、没东西要写不弹窗、自家端口被改过在弹窗前拒绝、不弹窗恢复留记录并让出锁），夹具把弹窗次数记在旁边的 `.authorizations` 文件里；只在 Mac CI 的 `npm run test:mac:proxy` 跑。主进程侧补了 backend、host、wrapper、Codex 启动路由和加速 watch 的用例。
- 英特尔 Mac 客户报 Codex 桌面端「检测失败：命令执行时间过长，已中止：codesign」：检测时 `codesign --verify --deep` 只给 15 秒，客户机上同一条核对要 22.77 秒（客户用 Codex 自己测的，最后通过）。安装那一步一直给 3 分钟，所以装得上、检测不过；超时会杀掉进程，下次从头再来，点几次「重新检测」都一样。
  `macos-code-signing.ts` 新增 `darwinDeepVerificationTimeoutMs`（3 分钟）和 `darwinGatekeeperAssessmentTimeoutMs`（2 分钟），安装（`macos-desktop-app-installer.ts`）、Codex 桌面端检测（`macos-codex-app.ts`）、外接桌面客户端检测与打开（`external-client-runtime.ts`，原来 spctl 和 WorkBuddy 的深度核对各 20 秒）共用这两个时限。核对的内容一点没变，只是给够时间。
- `macos-codex-app.ts` 同一个应用包（路径加指纹）同时只跑一遍深度核对：首页检测、Codex 型号名单那次检查、打开 Codex 开机时可能同时问到，慢机器上几遍一起跑会互相抢磁盘，一起超时。后来的等先起的那遍，结果一样交给每个人；只记住通过，失败的下次照旧重跑。
- `Shell`：窄窗口（逻辑宽 ≤ 1271）里点 `sidebar-collapse` 不再只弹「窗口较窄时侧栏会自动收起」，改成 `.sidebar-floating`：侧栏 `position: absolute` 照 224 宽浮在正文上（`--z-drawer`、`--shadow-pop`），网格仍按 60 留列、正文不挪；document 级 `pointerdown`（捕获）点外面、`Escape`（开着 `dialog[open]` 时不管）、再点一次、点 `.v2-nav-item` / `.v2-account-main`、`focusout` 到侧栏外都收回。浮着展开不写 `xingmang-v2-sidebar`、不调 `setSidebarCollapsed`；窗口变宽时清掉，再变窄不自己浮出来。窄的门槛不动。`app-check.mjs` 加两条浏览器用例（按产品负责人截图的约 1092 逻辑宽复现），03 §3 与 ui-spec CHANGELOG 跟着改。
- 主进程交出去的每个 Chromium 会话 fetch（默认会话、站点直连、系统代理、工具代理分区、更新会话、崩溃上报）
  都包上 `createManualRedirectFetch`（`main.ts` 的 `chromiumSessionFetch`），`redirect: 'manual'` 的请求
  照 Node 的 fetch 交回不带正文的 3xx 和 Location，带正文的写请求也一样（`manual-redirect-fetch.ts` 把正文
  逐块写进 ClientRequest）。`relay-line-fetch.ts` 和 `proxy-bypass.ts` 的直连分流把 3xx 认成「回话的不是
  星芒」：只读的换线路重发，写请求不重发、只报给线路那边。#1120 的「Redirect was cancelled」兜底留着（#1064）。
- 「自动」线路的四处恢复（`relay-route-controller.ts`，#1053）：开机（有存下的结论时）、唤醒、网络恢复、
  点「重新检测」都两条一起查，走着的那条不通、另一条通就当场换（新原因 `line-down`），不等三次、也不等
  切回去的那 10 分钟；两次切换至少隔 5 分钟照旧，定时检查照旧三次阈值。唤醒、网络恢复、「重新检测」
  赶上正有检查没回来，记下来查完马上补（唤醒那一刻到点的切回检查常常同时起来），还没定下线路的历史账号
  也两条一起查。唤醒、网络恢复时切回去的连续计数从头数。退到备用那条以后，它上面的请求和检查页的检查没走通也报（`reportFailure` 带上线路），
  报上来就两条一起查。
- `relay-line-fetch.ts`：已经退到备用那条时，只读请求失败也换回先走的那条重发（以前只从先走的那条往备用
  退）；只读请求等 `relayLineAnswerWaitMs`（4 秒）还没等来回应头，就在另一条上也发一次，谁先回了能用的
  话用谁，走着的那一次不掐，服务端查得慢的请求照样能回来。写请求、发验证码和重置邮件的 GET 不这样做。
- 导出报告里「自动」最近一次换线路多一种说法：「查到线路X没连上、线路Y能连上，当场改走线路Y」。
- 更新服务的撤回名单和分批放量改为只认最近一次读成功的服务状态（`electron/updater.ts` 的 `releaseGuard`）：
  状态文件某次没读到（网差、超时）而 `latest.yml` 读到时，不再当成「不撤回、全放量」，已装上撤回版本的电脑也照样能退回。
  维护提示和最低版本仍跟着这一次读到的走。Refs #1055。
- 这份撤回名单和分批放量还记到数据目录的 `release-guard.json`（`electron/release-guard-store.ts`，原子写、读回按状态文件
  同一套口径重新校验），重新打开软件后先用记下的，读到新的再换；最低版本不记。从来没读成功过的电脑仍不拦。Fixes #1055。
- 托管 npm 的恢复自己断在半路（当前目录已挪成 `interrupted-prefix`、旧版还没放回去）时，下次装、
  更新、卸载开头不再一直报「npm 安装恢复目录已存在冲突」，而是照常把 `previous-prefix` 放回去、
  清掉事务目录；只有当前目录和 `interrupted-prefix` 同时在时才照旧拒绝（`electron/managed-cli.ts`，#1056）。
- #1057 第 5a 条：命令行工具 npm 安装时，本机写不进去不再当成「这个源不行」换下一个源从头再下一遍
  （最长 30 分钟），最后报的还是同一个错。`system-service.ts` 新的顶层函数 `isMachineBoundNpmFailure`
  认两种：盘满（ENOSPC，哪一步报的都算，下一个源要写的还是那么多），以及往正在用的工具目录里写的那一步
  文件被占用、没有权限（EBUSY、ETXTBSY、EPERM、EACCES，普通权限的 Windows 原地更新，下一个源写的还是
  那个目录）。认到了就停在这个源，照原来的收尾报错：数到工具进程或 EBUSY 照旧说「文件被占用」，界面照旧
  按原文归到「工具正在运行」「磁盘空间不够」「权限」，运行日志记一条 `cli.install.machine-bound-failure`。
- 写进暂存目录（管理员身份、macOS、Linux）时撞上的占用和权限照旧换源：开着的工具占的不是那份，每个源
  都新建一份。网络、源返回的错、主程序包没下全也照旧换源。更新前「工具正在运行」只提示不拦这一点没动。
- #1057 第 5b 条前半：`system-service.ts` 的 `resolveDependencyGraph`（`npm install --package-lock-only`，装之前到官方源核对一次、每个源各自再解析一次）接上 `npm ci` 已有的 `createNpmDownloadStallWatch`，量这一次的 resolution 目录加缓存目录，3 分钟（`npmDownloadStallTimeoutMs`）一点没变就中止；`npmResolutionTimeoutMs` 10 分钟留作兜底。容器里实测 npm 10.9：解析时拉的包信息照样边收边写进 `_cacache/tmp`，慢慢收时文件一直在长，连上不回数据时目录一个字节都不变。
- 卡住被停和满 10 分钟超时报同一句（都是 `npmDownloadTimedOutReason`）：官方源那一步照旧出 #1188 的「装之前要先到 npm 官方源核对安装清单，这一步没连上……」，某个源自己那一步照旧记成这个源超时、换下一个源。运行日志多一条 `cli.install.resolution-stalled`。客户点取消照旧是取消。
- 开着加速（包括从星芒打开 Codex 桌面端时后台连上的那次）时，本机和局域网地址不再送去共享节点（#1058 第 2 项）：`acceleration-clash-config.ts` 的 `buildIsolatedMihomoConfig` 在 `MATCH,XINGMANG` 前固定写 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`100.64.0.0/10`、`::1/128`、`fc00::/7`、`fe80::/10` 直连，都带 `no-resolve`。mihomo 在 rule 模式下不会自己放过局域网，之前路由器管理页、NAS、打印机、公司内网 IP 开着加速都打不开，内网的明文登录还会经过第三方节点。两个平台共用这份内核配置，没动 Windows 绕过列表。
- 只认直接写 IP 的请求：解析到内网 IP 的公司域名照旧走线路（要拦得让内核做 DNS，没做）。内核 `ipv6: false`，IPv6 内网地址直连也拨不出去，只是不再送去节点。
- Windows 系统代理绕过列表补私网段（#1058 第 2 项后半）：`windows-system-proxy.ts` 的 `buildWindowsLoopbackProxySnapshot` 从 `<local>;localhost;127.0.0.1;[::1]` 改成再加 `10.*`、`172.16.*`～`172.31.*`、`192.168.*`、`169.254.*`，跟 #1121 给加速内核加的局域网直连对上。WinInet、Chrome、Firefox、.NET 读这份列表只认通配不认 CIDR；`100.64.0.0/10` 和 IPv6 内网写不成短通配，仍只靠内核直连，同样不送去共享节点。客户自己原来的代理设置照旧原样还回去，开着加速时客户改过的绕过列表照旧保留。
- 恢复记录兼容：`parseJournal` 认的 `applied` 从一个固定快照变成两个——现在写的这份和 0.2.19 及以前写的那份（只差绕过列表）。老版本开着加速断电或崩溃、升级后再开，照样认作自己写的、照样还原；认不出来系统代理就一直指着没人听的端口。两边列表混写的快照不认。客户恢复脚本 `scripts/windows-acceleration-recovery.ps1` 的 `Assert-RecoveryJournal` 同样两份都认；卸载冒烟（`windows-uninstall-cleanup-smoke.ps1`）四轮里有一轮摆的是旧列表的恢复记录，其余三轮是新列表，真 WinInet 写入读回逐字一致；Windows PowerShell 探针补了新列表与混写两条。新加的单测钉住两个脚本里的列表和客户端一致。
- #1059 第 3 段「画图技能：首选的两个型号账号里都没有时，照样写 gpt-image-2」：`selectXingmangAiImageModel` 两个首选都没有时，
  按新的 `XINGMANG_AI_IMAGE_MODEL_FALLBACKS`（`gpt-image-2.5-sunburst`、`gpt-image-1`）挑账号列表里有的；一个都没有返回 null，
  `config.json` 不写 `model`，日志照旧记「没查到当前账号能用的图片模型」。只在画图脚本 `ALLOWED_MODELS` 里挑，不放宽脚本白名单
  （那条是「画图脚本放开」，等 yoyo）；`gpt-image-1.5` 站上没开放，不挑。加了一条单测钉住挑出来的型号都在脚本白名单里。
- #1059 两条放宽（yoyo 10-20 北京 17:41 回「四条都放」）。「图片型号放开」：`selectAiChatModelsForGroup` 的 `IMAGE_GROUP_MODEL_ORDER`
  只管先后，名单外 `resolveAiModelCapability` 认得出的图片、视频型号（不是 chat、没藏起来）按账号列表次序接在后面；
  `grok-imagine-video-*` 按前缀认成 Grok 视频（`source: 'fallback'`，跟 `grok-imagine-video` 同样 1–15 秒、能带一张参考图）。
  「画图脚本放开」：`mcp-server.mjs` 去掉写死 5 个的 `ALLOWED_MODELS`，改用和主进程、`generate.mjs` 同一条 `OPENAI_IMAGE_MODEL_PATTERN`，
  schema 的 `model` 不再列枚举；主进程自动挑的型号不变（flare → gpt-image-2 → sunburst → gpt-image-1）。
  测试钉住三处规则一致。其他校验不动，画布（canvas-v2）不动。
- #1059 第 2 段「认不出的视频型号被当成聊天模型」：`resolveAiModelCapability` 认不出、名字又一看就是视频的型号
  （`UNRECOGNIZED_VIDEO_MODEL_PATTERN`：`video` / `veo` / `kling` / `vidu` / `seedance` / `hailuo` / `t2v` / `i2v` 整段词、
  `sora` 带版本号、`minimax-h<数字>` 开头），以前落到最后当成 `kind: 'chat'`，现在仍归 chat 但标成 `available: false`、`hidden: true`。
  `selectAiChatModelsForGroup` 本来就滤掉 hidden，所以对话不再列它，主进程发请求前对分组型号的核对也不再放它过；`buildChatCompletionsRequest`、
  `supportsChatImageInput` 也看 `available`。`ChatModelCapability` 的这两个字段从字面量 `true` / `false` 放成 `boolean`。
- 只收紧：藏起来不等于认得出，这些型号照旧不能拿去生成视频（`buildVideoGenerationRequest` 仍报 `model-not-video`）。
  按前缀把它们认成视频型号是另一条，要放宽校验，等 yoyo。`minimax-m2`、`sora_image` / `sora-image` 这类聊天接口的型号不受影响。
- 保存配置以外替客户改工具配置的几处排进保存配置那一队（#1061 第 1 条）。保存要先联网查模型，
  查完核对配置没被动过才写（`sameNativeConfigSnapshot` 连修改时间一起比），以前这一两秒里点
  「打开 Codex」，打开前补的权限缺省值或桌面端中文一改 `config.toml`，保存就报「工具配置在模型
  检测期间发生变化」（新测试在旧代码上复现）。
- 打开前补写的三样（Codex 权限缺省值、Windows 上桌面端自动设中文、Claude Code 的工作目录信任）
  走 `system-service.ts` 新的 `writeQueuedWithin`：最多等 3 秒，排不上这次就不写、之后轮到了也不再写，
  不会在工具起来以后跟它抢同一个文件。配置窗口里「信任工作目录」和切桌面端语言两个按钮等保存做完再写，
  重开桌面端放在队外。
- `SystemService` 多一个可选的 `serializeToolConfigWrite`，就是保存配置那一队。`main.ts` 登记星芒画图
  工具（`syncXingmangImageMcpConfigs`，改 Codex、Grok 的 `config.toml` 和 Claude 的 `settings.json`、
  `.claude.json`）和开机、同步账号时星芒AI技能跟着账号开关（`installXingmangAiSkillFiles` 新的
  `serializeConfigWrite` 选项）都排进去。扩展页启停插件、加删 MCP 不在这次范围里。
- 加速断电后不再把停机时间算进免费时长（#1061 第 10 条）：`acceleration-development-backend.ts` 在计时的会话开着时每分钟往本机账本落一次检查点（`checkpointAt` 墙钟时刻 + `checkpointMs` 已计时长，睡眠不算），会话结算后去掉。崩溃后再打开时，只有这台电脑在最后一次检查点之后重启过（按 `os.uptime()` 推出的开机时刻判断），才按检查点再加一整个间隔结算；没重启过的照旧按墙钟算，因为内核是单独的进程，主程序崩了它可能还开着、系统代理也还指着它。时钟往回拨照旧按用满算，往回拨到检查点之前也至少扣检查点记下的那些。检查点写不进去不影响加速，下一分钟再写。账本仍是第 2 版：老版本读到会丢掉检查点、照墙钟结算，只会多扣不会少扣。不碰界面文字。
- Windows 系统代理租约文件改成原子写（#1061 第 11 条前半）：`windows-system-proxy.ts` 的 `createLease` 原来先 `open('wx')` 建出空文件再往里写，写到一半断电或写失败会留下 0 字节的 `.lock`，之后每次开加速都报「系统代理租约记录损坏」。现在跟旁边的恢复记录一样走 `writeAtomicSafeUtf8File`：同目录临时文件写完 fsync 再改名，磁盘上要么没有租约、要么是完整的一份，写失败时临时文件删掉。改名会盖掉已有文件，所以写之前照旧先查，租约已存在就拒绝；查和写之间冒不出别的租约，因为租约只在这一处写、都在每个用户一把的系统互斥锁里，客户恢复脚本也拿这把锁且从不写租约。写完照旧读回逐字核对。新加两条单测：写租约失败后目录里什么都不留、下次照常能开（旧代码上这条红）；开的过程中冒出别人的租约时拒绝、不覆盖。
- 后半「租约读不出时隔离成 `.bak` 接着开」是放宽校验，不做；已经留下空租约的机器这次不处理。
- 界面进程崩溃后窗口不再一直空白（#1061 第 12 项）：主窗口崩溃询问框选了「先不管」以后，从托盘或桌面图标再把窗口叫出来时，`main.ts` 发现界面进程已经没了就重新加载；画布窗口接上 `createRendererCrashRecovery`，一分钟内自动重载两次、再崩就停下，用户再点「打开画布」时重载，重载用当前主题和账号重新拼入口地址。没有新增界面文字。
- #1061 第 2 条：历史账号（solov-api）的工具配置跟应用线路，换线路由渲染层整份写入跟过去（`saveConfig` 的 `followedRoute`），以前不走 `noteToolRouteRestart`，没有重开提示。现在 `saveConfig` 认出「半小时内『自动』因为连不上（health-failed / line-down）换到的就是这次写的那条」时记下这一家，`configureManagedClis` 整轮写完把这一轮写好的几家交给新的 `noteRouteFollowRestart` 一次提示（只说这一轮自己写的，同时跑的另一轮不会提前说掉；之后那家再写一笔不是跟线的就作废）（复用星芒账号那句、24 小时一次、设置里的开关照旧管）。换线时刻由 `main.ts` 经新选项 `relayRouteLastChange` 读 `relay-route-controller` 的 `lastChange`。线路选择本身不变；星芒账号仍由 `followToolRoutes` 提示，首页「需重开生效」标签仍只有星芒账号有。
- #1061 第 3 条（Grok 从 xAI 下载能续传）：`grok-installer.ts` 的 `downloadArtifact` 不再自己写单次下载，改用 `download-retry.ts` 的 `downloadWithResume`。以前 45 秒没数据就换下一个地址从 0 开始；现在同一个地址先带 `Range` / `If-Range` 接着下（等 3 秒、10 秒，最多 6 次）。地址回的不是正好剩下那一段（不支持续传、文件换了）、连着两次接不上、一个字节都还没收到就断，都和 Node.js 安装包（#1211）一样照旧马上换下一个地址；客户点取消照旧不换。存储桶那一路本来就用它，不变。
- 原有核对一条没少：`redirect: 'error'`、响应地址全等核对（接着下的每一次请求也核）、Content-Type、Content-Length 和 1 MiB~512 MiB 范围、下完大小对得上、SHA-256、xAI 签名核对。45 秒没数据中止的原因照旧记成「连接或下载超时」，报错一字不改，不加新字。
- 只走 Windows（Grok 一键安装只有 Windows），只改下载，不碰提权、安装路径和命令执行。Google 存储那个地址核过支持 `Range` 和强 ETag；`x.ai/cli` 容器里连不上没核，不支持续传时照旧换地址，不比以前差（推断）。
- #1061 第 4 条（Grok 直接下，yoyo 2026-10-20「四条都放」）：Windows 装 Grok 去 xAI 那一路时，`x.ai/cli/stable` 和 Google 存储那份 stable 都查不到，点了名的版本（推荐版本、退回）照它直接下（`grok-update.ts` 的 `resolveGrokNamedVersion`、`grok-installer.ts` 的 `resolveXaiDownloadVersion`），不再整个安装失败。
- 放宽的只有一处：查不到 stable 时没法再按「点名的版本不超过 stable」封顶。版本号格式照旧只收 `x.y.z`；下载地址只在两个官方目录、`redirect: 'error'`、响应地址全等、Content-Type、Content-Length 和 1 MiB~512 MiB 范围、SHA-256、xAI 签名核对一条没动。没点名（打开了「总是装最新版」）查不到 stable 照旧报「Grok 官方版本查询失败」。存储桶那一路不变。
- 原因只进运行日志（`grok-stable.unavailable`），界面上不加字。只走 Windows（Grok 一键安装只有 Windows），不碰提权、安装路径和命令执行。
- Node.js 安装包下载不再限死 10 分钟（#1061 第 5 条 MSI 部分）：`node-runtime.ts` 的 `downloadMsi` 改用 `createNodeDownloadDeadline`，3 分钟没有新字节才中止，另留 30 分钟兜底上限（I10 的超时还在），两个数和 npm 下载那一步一样。单次请求 45 秒没数据仍由 `downloadWithResume` 先接着下。中止的原因还是「安装包下载超时」，界面上那句不变。Windows 的 MSI、macOS 与 Linux 的压缩包走的是同一个下载函数，三个平台一起生效；只改计时，不碰提权、安装路径和命令执行。
- Node.js 自动安装的 winget 那一步按网络位置决定（#1061 第 5 条 winget 那半）：`node-runtime.ts` 新增 `nodeRuntimeTriesWingetFirst`，只有网络位置明确在海外才先试 winget；在国内或测不出位置时直接走 MSI，镜像排第一（测不出位置跟国内一样，同 `nodeRuntimeDownloadSources` 的理由）。位置在没借下载专用线路时问一次，借到线路后照旧再问一次定先走哪个源（第二十八批 D 不变）。没选「给 winget 一个短时限」：到点杀进程树杀不到它提权拉起的 msiexec，Windows Installer 还在装，后面 MSI 那一步会撞 1618。跳过的原因进运行日志。不碰提权、可信路径和命令执行，只改试不试 winget。
- #1061 第 6 条（先比再换）：`downloadDesktopBucketPackage` 多一个可选的 `probeAlternative`。判出桶太慢时桶照下，同时测一下桶没走通时要换去的那一路（`measureDesktopDownloadSpeed`：发一次请求，最多读 8 秒、4 MB，读到的丢掉不落盘，读到一半断了算测不出来，跳转和地址照那一路自己的规矩核）。那一路照测出来的速度从 0 下完整个包，也要比桶剩下那段快一倍以上（`isDesktopAlternativeClearlyFaster`）才放弃桶；测不出来、不够快就接着下桶，之后还太慢隔 2 分钟再测，一次下载最多测 3 次。下完、放弃、客户取消时还在测的那一路一起停。不传照旧一判出太慢就放弃，所以 Grok、Codex 插件目录不变。
- 接上的三处：Windows 的 Codex 桌面端测 OpenAI 官网的离线包（`measureCodexDesktopOfficialSpeed`，桶后面先是商店，测不了，拿官网同一个包代它）；Windows 的 Claude Desktop 测官网入口跳到的 MSIX（`measureClaudeDesktopOfficialSpeed`）；Mac 上 Codex 桌面端、Claude Desktop、OpenCode 先读官方版本信息挑出这台 Mac 的包再测（`measureMacosDesktopVendorSpeed`，读版本信息的时间也算在测的那几秒里，这台 Mac 的系统装不了那一版就当测不出来）。测速不接加速线路，测得只会偏慢，偏向接着下桶。`external-client-runtime.ts` 不用改：它调的两个安装模块自己接上了。
- 换路时日志里那句原话（只进运行日志，不上屏）从「从存储桶下载太慢」变成「从存储桶下载太慢：照目前的速度还要 N 分钟，另一路测下来 M 分钟就能下完」。
- #1061 第 7 条（桶清单过期不再装到旧版）：两份同步索引多一个 `checkedAt`，是这次同步问过官方、核对过的时间。`sync-chatgpt-official-cos` 一个作业只核自己那个平台，写在 `platforms` 下各条上，其它平台留着它们上次的时间；`sync-grok-cos` 一次核完两个芯片，写在顶层。包一个都没变也照样重写一次索引、只刷新这个时间（不下大文件，Codex 那边也不建临时目录），结果里的 `changed` 仍按包变没变算。以前包没变就不写，`generatedAt` 是「内容最后一次变」的时间，拿它判过期会把一切正常、只是官方几天没出新版的桶也当成过期。
- 客户端：`readDesktopBucketPackage` 读 Codex 那份清单（Windows、Mac 都是）时，那一条的 `checkedAt` 离桶回应的 `Date` 超过 24 小时（`desktopBucketIndexMaximumAgeMs`，读不出 `Date` 才用本机时间，客户电脑时钟可能差好几天），就抛 `DesktopBucketUnavailableError`，照旧换商店、官网、国内镜像（Mac 是官方更新信息）。`readGrokBucketRelease` 只在装最新的（没点名或 `latest`）时看顶层的 `checkedAt`，点了名的版本（推荐版本、退回）照旧从桶里装，桶里那份和 xAI 的是同一个文件。`checkedAt` 没写、读不出来的判断不了，照旧从桶里装：新同步脚本跑起来之前线上清单都没有它，算过期就会把所有客户推去慢的官方那几路。Claude 桌面端、OpenCode 的同步还不写这个时间，它们的清单照旧不看。原因只进运行日志（`desktop-bucket.fallback` / `grok-bucket.fallback`）：「存储桶清单超过 24 小时没和官方核对过（上次是 …），桶里的可能不是最新版」，不上屏。
- `grok-installer.ts`、`codex-desktop-service.ts` 不用改：两边本来就把清单读不出当成换路。这个 PR 合进去以后，下一次定时同步（6 小时内）就会写上 `checkedAt`；在那之前读到的清单没有它，照旧从桶里装。
- 同一个工具的安装已经在跑或在排队时，再来一次点名不同版本的安装（比如「更新」还没完又「回到某个版本」）
  不再并进正在跑的那次、跟着报成功，直接拒绝并报现成的「正在安装中」；同一个版本照旧复用（重复点击）。
  现在 v2 界面按工具加锁碰不到，属于防以后踩（#1061 第 9 条）。改动在 `electron/system-service.ts` 的 `installCli`。
- #1063：Mac 系统代理组件（`native/macos-system-proxy.swift`）停止加速时，用同一个组件进程开加速那一刻记在内存里的原设置还原，不再回读磁盘上的恢复记录。之前恢复记录在用户目录里，同用户的普通程序改掉里面的「原设置」，组件就会拿开加速时已经拿到、一直留到退出的系统授权，不弹窗把全机代理写成它给的地址。恢复记录被删了也照样按内存那份还原。
- 只有内存里没有快照（组件被硬杀后下一次启动）才读恢复记录：读时原设置里的开关只能是 0/1、端口在 0~65535、开着的那项写了主机就必须是 IP 或合法主机名（没写主机等于没有代理地址，照原样写回），不合格照旧保留记录、不动系统设置；并且先作废组件手里留着的授权（`AuthorizationFree` 带 `destroyRights`，连会话里共享的那份一起作废），重新向系统要一次，不沿用之前拿到的。读进来的那份当场收进内存，恢复失败重试时不再重读、也不再重弹授权。
- 校验分不出被改过但格式合法的地址，崩溃恢复这条路跟任何同用户程序自己弹授权框改代理是同一个门槛，挡住的是「借现成授权不弹窗」。测试夹具改成跟真实后端一样「拿过授权就一直留着」，新增 4 条夹具用例；这些只在 Mac CI 的 `npm run test:mac:proxy` 跑。
- 打包版拒绝调试开关的检查不能再换个写法绕过（#1065 第一步）：`electron/security.ts` 的 `hasDisallowedPackagedDebugSwitch` 照 Chromium `base/command_line.cc` 的读法比较开关名，先去掉首尾空白，再去掉 `--` 或 `-`（Windows 上还有 `/`），名字截到第一个 `=`。之前只认 `--` 开头，`-remote-debugging-port=9222`、Windows 上的 `/remote-debugging-port=9222` 都能过，Chromium 照样开远程调试。黑名单补上能让 Chromium 拉起任意命令的 `--gpu-launcher`、`--renderer-cmd-prefix`、`--utility-cmd-prefix`、`--zygote-cmd-prefix`、`--browser-subprocess-path`，以及 Node 的 `--inspect-wait`、`--inspect-brk-node`。
- 检查从 `main.ts` 挪到 `platform/entry.ts`，在分出任何一支之前做：之前卸载清理、加速辅助进程这几支根本不经过 `main.ts`，带着这些开关走清理那一支就不受检查。`e2e/packaged-hardening-smoke.mjs` 在 Windows、Linux 的打包冒烟里加测单短横线和斜杠写法。
- 仍是黑名单：没列进去的开关照样生效；检查跑在 Chromium 读完命令行之后，启动早于主进程脚本的子进程已经用上的开关，这里退出也拦不回来。只放行已知参数是 #1065 的下一步。
- 保存配置以外单改 Codex `config.toml` 的几处收成一套（#1068）：扩展页启停插件和技能、星芒画图技能
  跟着账号开关（连同存着的那份星芒配置）、Codex 桌面端语言都改走新的 `electron/codex-config-toml.ts`
  的 `mutateCodexConfigToml`。从读到写整段同步、不让出事件循环，保存配置的事务本来也是同步的，所以
  本进程里谁也插不进这一段：以前画图技能读完配置、等着读记录的那一会儿，别处刚写进去的改动（比如
  桌面端语言）会被它整份盖掉。每次改之前在旁边留 `.bak.<时间戳>`，以前技能开关和语言这两处不留。
  能只动几行就只动几行（表里改一个键、末尾接一张表），解析回去和要的一模一样才用，不然照旧整份重写；
  扩展页只在真整份重写时才提示「手写注释可能丢失」。
- 备份的名字和清旧备份挑哪几份收进 `electron/config-file-backups.ts`，`config-files.ts` 的保存事务和
  上面那套共用，以前两边各写一份、碰巧一致。`codex-extensions.ts` 自带的备份、临时文件、写队列那套
  删掉；写之前的路径检查改用 `safe-local-data.ts` 那套（比它原来的 `assertNoSymlinkComponents` 严，
  读和导入技能那几处没动）。`codex-context-limits.ts` 与 `codex-desktop-locale.ts` 的「按行改、对不上
  就整份重写」合用 `renderTomlEdit`。保存配置本身仍整份重写 `config.toml`，不在这次范围里。
- 启动失败日志写之前不再顺着链接写到别处：`startup-log.ts` 的 `recordStartupFailure` 先 `lstat`，名字不是
  只有一个名字的普通文件（符号链接、联接、多出来的硬链接）就跟超过 128 KB 一样先删掉这个名字，再用
  `O_CREAT|O_EXCL` 新建；已有的普通文件不带 `O_CREAT` 打开，打开后 `fstat` 复核还是 `lstat` 看到的那个文件才写。
  POSIX 另加 `O_NOFOLLOW`，Windows 没有这个标志，靠打开后的复核（和读那一侧 `drainStartupFailures` 原有的
  检查同一套）。`logs` 目录本身被换成联接那半是 Windows 专属，没动（#1069 第 1 条文件层）。
- 账号状态、付款结果（带订单号）、更新状态这三类通知改为只发主窗口，不再挨个窗口广播进画布和支付窗口（#1069 第 3 条）。
  画布换账号走自己的 `canvas-host:account-changed`，支付窗口不挂 preload，两边功能不变。`electron/main.ts`
  的 `sendToMainWindow`；新加的 `electron/main.test.ts` 读源码钉住主进程不再对所有窗口 `send`。
- #1069 第 4 条：`payment-window.ts` 加 `buildPaymentWindowTitle`。建窗口时按要打开的地址、`did-navigate` 落地后按实际地址，
  把 host（含非默认端口，中文域名是 URL 解析后的 xn-- 写法）写进标题；`page-title-updated` 照旧拦住页面自己改标题，复位成当前这份。
  账号站、付款回调站这两个自己的站点和 data: 扫码页不带域名（界面不出现站点名）。导航白名单和各项校验没动。
- #1069 第 5 条、#1073 第 2 条里 python-runtime 那一处：Python 官方发布信息和 Codex 桌面端调试口的目标列表改用
  `bounded-response.ts` 边读边限大小，没声明长度的响应读过上限就停，不再先整个读进内存再比。报错照旧是
  「Python 发布信息响应过大」「CDP 目标响应过大」：`readBoundedResponseText` / `readBoundedResponseBytes` 加了可选的
  `oversizeMessage`，不传时老调用方的报错不变。
- #1069 第 6 条：`electron/ipc.test.ts` 新加一段，把 AGENTS.md I3 登记的六条明文通道钉在三处——文档「已登记的例外」那一段、`ipcInvokeChannels` 契约、成功时不进运行日志（逐条真走到成功，断言既没有该通道的成功行，日志里也没有那段明文）。以后在 I3 登记了却没进静默名单、从静默名单里挪出去、或者文档和测试的名单对不上，测试都会红；连 I3 都没登记的新明文通道认不出来（代码里没有一份权威的明文分类，补它要改通道契约，另排）。只加测试，产品代码没动。
- 拆 `config-files.ts`（#1070 第 10 步，第一块）：读写工具配置文件的共用底层搬进新文件 `electron/config-files-context.ts`，给下一块把下线的 Gemini CLI 代码归拢到 `gemini-retired.ts` 铺路（那边要用这些，又不能反过来从 `config-files.ts` 拿值，否则两个文件互相 require）。搬过去的是：读配置文本（`readText`、`requireConfigText`、`requireRawConfigText`、去掉字节顺序标记、只认单链接普通文件、2MB 上限 `MAX_NATIVE_CONFIG_BYTES`），写之前的路径检查 `assertSafeConfigPath`（I8），两阶段提交 + .bak + 失败回滚的 `executeFilePlans` 和它用的准备、回滚、清理（I9），各家配置的位置 `providerConfigPaths` 和 `normalizeProviderConfigRoots`，以及几家配置都用的 `isJsonObject`、`isJsonRecord`、`ensureRecord`、`fillableRecord`、`jsonContent`、`normalizeWorkspacePathKey`、`trustedFolderKey`。新文件只 import `config-files.ts` 的类型；`executeFilePlans`、`providerConfigPaths` 由 `config-files.ts` 照旧导出，别处的 import 一个没改。config-files.ts 4702→4246 行。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改，只给 `config-files.ts` 还要用的几个加了 `export`。另用 58 种情况（四家工具各自保存、合并、带字节顺序标记、备份轮换、改名失败回滚、配置是符号链接或硬链接、目录是链接、配置读不懂、超过 2MB、换线路和换型号、切官方账号再切回，直接调两阶段提交写入和删除、重复路径、越界、钩子抛错，三家的目录信任，以及 Gemini 的各种写法）把返回值、报错原文和整个目录里的文件搬前搬后各跑一遍逐字比对，一样。
- 测试：新增 `config-files-context.test.ts`（`config-files.ts` 导出的就是这两个函数本身、新文件只 import `config-files.ts` 的类型、读文本去不去字节顺序标记、硬链接读不出也写不进、Windows 原样路径和普通路径算同一个、`fillableRecord` 不动不是表的值）。
- 文档：模块地图加新文件，AGENTS.md 第 2 节、T2、T10 里 `providerConfigPaths` 的位置跟着改；`codex-config-toml.ts`、`config-file-backups.ts` 两处注释里「保存配置的事务在哪」跟着改。
- 拆 `config-files.ts`（#1070 第 10 步，第二块）：下线的 Gemini CLI 专用代码归拢进新文件 `electron/gemini-retired.ts`：照 Gemini 的规矩读写 settings.json 与 trustedFolders.json（`parseGeminiJsonObject`、`readGeminiJson`、`requireGeminiJson`、改写时留住注释的 `geminiJsonContent`），保存配置时补的那几项（`disableGeminiSelfUpdate`、`extendGeminiSessionRetention`、后台型号指到中转的 `geminiRelayHelperModels` 一组、使用统计开关和旁边那笔记录的一组、`forgetStaleGeminiUsageStatisticsRecord`），`geminiCliCompatibleModel`，目录信任和项目说明文件名（`trustGeminiWorkspace`、`trustGeminiWorkspaceInTrustedFoldersText`、`ensureGeminiProjectContextFiles`、`geminiTrustedFoldersTrustFolder`），`fillGeminiRelayTemplateDefaults`，以及收回星芒写进去的做完提醒和画图工具（`inspectRetiredGeminiIntegrations`、`removeRetiredGeminiIntegrations`）。各个 `switch (provider)` 里的 gemini 分支留在 `config-files.ts`（T2 的穷尽性保障），调的是新文件里的函数；以后整块删 Gemini，删这个文件再顺着编译错删那几个分支。config-files.ts 4246→3802 行。
- 新文件只 import `config-files.ts` 的类型，共用的读写底层从上一块的 `config-files-context.ts` 拿；原来导出的名字（含 `RetiredGeminiIntegrations` 类型）`config-files.ts` 照旧导出，别处的 import 一个没改。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改，只给 `config-files.ts` 还要用的几个加了 `export`；只多了一行注释：`MANAGED_GEMINI_SESSION_MAX_AGE` 说明为什么放长的那段是和 Claude 共用的，留在 `config-files.ts`，新文件里指一句过去。读写用户配置的逻辑一行没动，用户自己设过的保留期、统计开关、型号改写照旧不碰。
- 测试：新增 `gemini-retired.test.ts`（`config-files.ts` 导出的就是这些函数本身、新文件只 import `config-files.ts` 的类型、改带注释的配置时注释留着、用户写过的保留期不动）；行为由 `config-files.test.ts` 原有的 Gemini 用例钉着。另用上一块那 58 种情况、698 步把返回值、报错原文和整个目录里的文件搬前搬后各跑一遍逐字比对，一样。
- 文档：模块地图加新文件，`config-files.ts` 那一条跟着改；`config-save-service.ts`、`tool-model-check.ts`、`workspace-config-overrides.ts` 三处注释里说「在哪」的文件名跟着改。
- 拆 `pages-maintenance.tsx`（#1070 第 11 步，第一块）：三页一页一个文件，检查页 `HealthPage` 搬进 `src/renderer-v2/features/health/HealthPage.tsx`，反馈与客服 `FeedbackPage` 搬进 `features/feedback/FeedbackPage.tsx`，设置页 `SettingsPage`（连同 `OnboardingGuideRow`、`OnboardingTourRow`、`settingsPageLead`、快捷键那两个函数）搬进 `features/settings/SettingsPage.tsx`，各自只用到的小函数跟着页面走。各业务页共用的 `BusinessActions` 和它带着的 `ToolInstallOutcome`、`FeedbackSupport`、`FeedbackRequest` 几个类型搬进 `business-actions.ts`；检查页和扩展三页都用的 `installResultMessage`、`installJobRunning`、`installGuideTopic` 搬进 `features/tools/install-result.ts`。`pages-maintenance.tsx` 从 3090 行降到 33 行，只做转出，原来从它那里 import 的地方一个没改；搬出去的文件不反过来从它那里 import，免得绕圈。
- 搬运用脚本按原文件整段复制，每一段连同上面的注释逐字比对一样；只少了两处没人用的：`type Update` 和一行 `releaseNotesSection` 的 import（更新卡早先搬去 `VersionCard` 时留下的）。几页用到的那两三个类型别名（`Provider`、`AppSettings`）各文件各抄一份，和原来 pages-maintenance、pages-management 各有一份 `Provider` 一样。跟 Windows 有关的几处只是界面上的话和判断，原样搬了：检查页 Node.js 那行「要弹一次管理员授权」的提示、能删的设置那一句，设置页「打开工具用哪个窗口」里不写死 Windows Terminal 那一行。
- 验证：搬前搬后用同一组 18 种情况（三页各几种参数、教程页、记录页、扩展三页）把渲染出来的整页 HTML 和两个文件的导出名逐字比对，一样；另把 renderer-v2 打包前后比对，样式表全部一字不差，首屏那份 JS 和别的几块除了互相引用的文件名一样，变的只有业务页那一块（模块次序）。
- 测试：`pages-maintenance.test.ts` 原有的用例一条没改，照旧从 `pages-maintenance` import；末尾加两条：转出的就是页面文件里那一份，搬出去的文件不从 `pages-maintenance` import。
- 文档：模块地图里 `pages-maintenance.tsx` 一条改成「只做转出」，加五个新文件；`docs/COLLABORATION.md` 热点文件表换成 `features/settings/SettingsPage.tsx`；`electron/feedback-self-check.ts` 一句注释里说「在哪」的文件名跟着改。
- 拆 `pages-management.tsx`（#1070 第 11 步，第二块，#1070 的最后一块）：记录页 `SessionsPage` 搬进 `src/renderer-v2/features/sessions/SessionsPage.tsx`，扩展三页 `ExtensionsPage`（连同只有它用的 `useMcpHealth`、`useToolOperation`）搬进 `features/extensions/ExtensionsPage.tsx`；扩展三页和「星芒精选」页共用的判断、解析和卡片（`groupExtensionItems`、`extensionRowState`、`runExtensionAction`、`mcpRuntimeNotice`、`submitMcpInstall`、`CuratedShelf`、`CuratedDetails`、`ExtensionCard`、`ExtensionToolPicker` 等）搬进 `features/extensions/extensions-common.tsx`；记录页和扩展页都用的 `isProvider`、`providerOptions`、`providerName` 搬进 `features/tools/provider-options.ts`。`pages-management.tsx` 从 3137 行降到 51 行，只做转出，`pages-business.tsx`、`pages-featured.tsx` 和测试的 import 一个没改。
- 搬运用脚本按原文件整段复制，每一段连同上面的注释逐字比对一样；别的文件要用而原来没导出的六样只加了 `export`（`isProvider`、`providerOptions`、`providerName`、`RowAction`、`activeTools`、`mcpAuthorized`），转出的名字还是原来那一套。少了两处没人用的：`ProviderFilter` 组件和 `type SessionDetail`，连带一行没人用的 `V2Page` 类型 import。几个从桥接口推出来的类型别名（`Provider`、`ExtensionItem` 等）各文件各抄一份。扩展页装工具那几句结果照旧从 `pages-maintenance` 拿（拆之前就这样）：它让教程页那几份样式先于 `extensions.css` 进业务页的样式表，`pages-management.tsx` 里 `ExtensionsPage` 排在最前也是为这个，注释里写了。跟 Windows 有关的只有两句注释（认带 Windows 后缀的 Python 命令、贴 Windows 路径时的中文报错），原样搬了。
- 验证：搬前搬后用同一组 18 种情况（记录页、扩展三页各几种参数、精选空架子，连同检查、反馈、设置、教程几页）把渲染出来的整页 HTML 和两个文件的导出名逐字比对，一样；renderer-v2 打包前后比对，样式表全部一字不差，首屏那份 JS 和别的几块除了互相引用的文件名一样，变的只有业务页那一块（模块次序）。
- 测试：`pages-management.test.tsx` 原有的用例一条没改，照旧从 `pages-management` import；末尾加两条：转出的就是页面文件里那一份，搬出去的文件不从 `pages-management` import。
- 文档：模块地图里 `pages-management.tsx` 一条改成「只做转出」，加四个新文件，界面层过滤 Gemini 的名单换成 `provider-options.ts`；`docs/COLLABORATION.md` 热点文件表换成 `features/extensions/ExtensionsPage.tsx`；`registry/curated-extensions.ts`、`features/tools/runtime-install-guide.ts` 的注释和 `ui-spec/v4/README.md` 里说「在哪」的文件名跟着改。
- #1070 收尾（从 #1071 第 3 条转过来的那条）：主进程和 renderer-v2 各文件自己写的那份 `isRecord` 全部换成 `electron/input-guards.ts` 那一份，删了 44 份（`electron/` 43 份、`src/renderer-v2/registry/curated-extensions.ts` 1 份），每个文件只多一行 import。删掉的四种写法（`typeof value === 'object' && value !== null`、`value !== null && typeof …`、`Boolean(value) && …`、`Boolean(value && …)`，后面都跟 `!Array.isArray(value)`）判断结果和共用那份一样，另用 32 种值（null、0、空串、数组、Date、Map、函数、无原型对象、Proxy、包装对象等）逐个跑过，结果一致。`diagnostics-context.ts` 原来为了给两个检查文件共用而导出的 `isRecord` 一并去掉，`diagnostics-network-checks.ts`、`diagnostics-override-checks.ts` 改从 `input-guards.ts` 拿。
- `codex-config-toml.ts` 那份多排除了 Date（`@iarna/toml` 把日期时间解析成 Date），意思不一样，改名 `isTomlTable`，写成 `isRecord(value) && !(value instanceof Date)`，6 处调用跟着改名，结果不变。
- 有意没换的：`electron/drama-parse.ts`（要和 `canvas-v2/src/library/drama-parse.ts` 逐字一样、只许 import 漫剧那几个文件，`verify-drama-parse-parity` 钉着，画布不碰）、`canvas-v2/` 5 份、冻结的 legacy 树 `src/pages/FeedbackPage.tsx` 1 份、`scripts/*.cjs` 8 份（不经编译的 CommonJS，import 不了 TS 模块）。另有 6 个同样判断但名字不同的（`saved-accounts.ts` 的 `record`、`realm-account.ts` 的 `isRealmRecord`、`config-files-context.ts` 的 `isJsonObject` / `isJsonRecord`、`new-api-messages.ts` 的 `isPlainRecord`、`cli-config-health.ts` 的 `isPlainObject`）不在这条范围里，没动。`ipc.ts`、`platform/ipc.ts` 的 `isPromiseLike` 和几份 `stringArray` 跟共用那份判断不一样，也没动。
- `platform/windows-system-proxy.ts` 只换了这一个判断，PowerShell 那段一字没动。`input-guards.ts` 开头的说明和模块地图那一条跟着改。
- `acceleration-clash-config.ts` 现在 import `input-guards`：准备加速资源的脚本读的是编译好的 `dist-electron`，里面本来就有它，照常能用；`stage-acceleration-bundle.test.cjs` 不编译、直接从源码转译几个模块来跑，它那张「只许转译这几个」的名单补上 `input-guards`。
- 拆 `system-service.ts`（#1070 第 2 步，上半）：`createSystemService` 开头那段搬进新文件 `electron/system-service-context.ts` 的 `createServiceContext`，交出 `ServiceContext`：选项解析成实际用的那一份（各个测试替身和缺省实现、执行模式缺省 `trusted-only`）、五份记录文件、安装排队和取消登记、保存配置的排队、站点与线路的几个读法，以及只靠这些就能做的几样（找命令、跑 `--version`、Mac 上改用代下的 Node.js、下载临时走加速、建安装临时目录、装之前看盘、绕开没开的本机代理）。后面各簇搬出去时都只拿这一份，簇与簇之间不互相 import。
- 搬运用脚本按原文件行号整段复制，搬前搬后逐段比对一字没改；闭包里用一次解构把这些名字照原样接回来，其余代码不动。只有两处闭包内的读写改成经上下文：下载加速的次数改读 `acceleratedDownloadCount()`（3 处），强制重新检测和装完 Node.js 时改调 `forgetPreferredNodeDirectories()`（2 处）。上下文只 import `system-service.ts` 的类型，所以它要用的 `firstOutputLine`、`scanReuseMs` 一起搬了过去，`system-service.ts` 照旧导出 `scanReuseMs`。Windows 专属的几段（`executeVersion` 的高完整性校验、`registryMetadataFetch` 管理员身份不换 fetch、`createInstallTemporaryDirectory` 的可信临时目录、看盘时的托管目录）只搬不改。
- 测试：新增 `system-service-context.test.ts`（缺省往严里取、管理员身份查 npm 元数据不用宿主给的 fetch、下载加速只在下载期间计数且总会归还、加速拿不到照样下载、保存配置失败一次后面照样排队）；第 1 步的 15 条门面测试和其余系统服务测试照旧全过。
- 拆 `system-service.ts`（#1070 第 2 步，中间一段）：装命令行工具要用、别的簇也要用的几个顶层小工具先搬成独立小文件，后面把安装那一大段搬进 `cli-install-service.ts` 时，它和首页检测、卸载就不用互相 import。新文件 `electron/npm-registry.ts`（两个 npm 源的地址、按网络区域谁先谁后、查询地址怎么拼、查询超时和响应体上限）、`electron/npm-command-failure.ts`（npm 命令没成功时给客户看的那句、超时的说法、换源也没用的几种）；`grokInstallStrategyFor` 搬进 `platform-capabilities.ts`，Mac 上核 Grok 签名用的 `buildDarwinTrustedVerificationRunner` 搬进 `system-service-context.ts`，读已装包版本号的 `readPackageManifestVersion` 搬进 `cli-native-package.ts`。
- 搬运用脚本整段复制，搬前搬后逐段比对；只改了五个原本不导出、现在要跨文件用的名字前面加 `export`，以及两处注释里的文件名。`system-service.ts` 照旧导出原来导出的那几个，测试和别处的 import 不用动。`buildDarwinTrustedVerificationRunner`（固定用 `trustedCommandEnvironment` 跑 codesign）只搬不改。
- 测试：`readPackageManifestVersion` 原来不导出、没有单测，补了三条（读出精确版本并去空白、不是精确版本或不是对象时答 null、文件不在或超过 256 KB 时答 null）；其余照旧由 `system-service.test.ts` 经原来的导出覆盖。
- 拆 `system-service.ts`（#1070 第 2 步，下半）：装和更新命令行工具的那一整段（原闭包里的 `runCliInstall` 约 800 行，连同 `installCli`、`cancelCliInstall`、`cleanupInstallLeftovers` 和只有它们用的 46 个顶层函数、常量、类型）搬进新文件 `electron/cli-install-service.ts` 的 `createCliInstallService`。`createSystemService` 照旧对外给这三个方法；归首页检测、装运行时、Codex 型号名单那几块管的六样（查网络区域、证书提示、读工具状态、清更新缓存、装 Git、收回型号名单）显式传进去，新文件只 import `system-service.ts` 的类型。`system-service.ts` 从 8700 多行降到 6700 行左右。
- 安装和卸载都要用的三样（认托管 npm 布局、终端里直接敲工具名那套 `cliTerminalAccess`、文件被占用时补的那句）挪进 `system-service-context.ts`；装 Node.js 的「正在装」标记也放进上下文（`nodeRuntimeInstall.running`），单独装和装工具时顺带装的那次照旧共用一个，同一时间只装一份。
- 搬运用脚本整段复制，逐段比对一字没改；闭包里那 800 行没有切段，因为里面夹着 Windows 管理员身份装到托管目录、可信缓存目录、Grok 原生通道这些段落，这次只搬不改，等 Claude·win 看过再切。唯一的改写是 `nodeRuntimeInstalling` 三处读写换成 `nodeRuntimeInstall.running`（单独装 Node.js 那边也是三处）。别处四条注释里的文件名跟着改。
- 测试：新增 `cli-install-service.test.ts`（传进来的读工具状态真的用来挡住官方安装器管的那份、同一个工具排队时换版本照旧被拒、没在装时取消照旧说没在装），`system-service-context.test.ts` 补一条（不是文件被占用就不补那句）；第 1 步的 15 条门面测试和其余系统服务测试照旧全过。
- 拆 `system-service.ts`（#1070 第 3 步，第一簇）：卸载命令行工具的那一段（`uninstallCli`、`cleanUninstallLeftovers` 和它们用的卸 Grok、卸官方安装器装的 Claude Code、卸载残留登记，连同只有它们用的 Mac 上核签名卸 Grok、卸载计划这些顶层函数）搬进新文件 `electron/cli-uninstall-service.ts` 的 `createCliUninstallService`。`createSystemService` 照旧对外给这两个方法；归首页检测和 Codex 型号名单的三样（读工具状态、清更新缓存、让型号名单重新找 Codex）显式传进去，新文件只 import `system-service.ts` 的类型。
- 搬运用脚本整段复制，逐段比对一字没改，没有任何改写。Windows 上要用户自己跑的卸载命令开在不提权的窗口里（`launchUnelevatedCommandWindow`）、删官方原生程序文件（`uninstallVerifiedNativeCliFiles`）这几段只搬不改。`system-service.ts` 照旧导出原来导出的那几个。
- 测试：新增 `cli-uninstall-service.test.ts`（读工具状态说没装就答没装、装着的时候不让卸、卸完 Codex 让型号名单那边重新找它、没记下残留时「帮我清理」什么都不动）；系统服务其余测试照旧全过。
- 拆 `system-service.ts`（#1070 第 3 步，第二簇）：装运行环境的那一段（`installNodeRuntime`、`installPythonRuntime`、`installGitRuntime`、`inspectWindowsProcessor`、`restartWindows`，连同 Mac 上弹 Git 安装窗口、处理器一次启动只问一次、Node.js 认不得公司证书时换一份这些）搬进新文件 `electron/runtime-install-service.ts` 的 `createRuntimeInstallService`。`createSystemService` 照旧对外给这五个方法；归首页检测和 Grok 钩子的几样（读网络区域、读 Node / Python / Git 状态、换终端后刷新钩子、装完补钩子）显式传进去，新文件只 import `system-service.ts` 的类型。
- 首页检测和装运行环境都用的 `buildToolStatusFromSettled` 搬进 `system-service-context.ts`，`system-service.ts` 照旧导出。搬运用脚本整段复制，逐段比对一字没改，没有任何改写。Windows 重启（`shutdown.exe` 走 `windowsSystemExecutable`、`trustedOnly`）、看处理器挑安装包这几段只搬不改。
- 测试：新增 `runtime-install-service.test.ts`（只有 Windows 能重启、有任务在排队时不重启、「正在装 Node.js」和装命令行工具那边共用同一个标记、处理器问不出时一次启动只问一次）；系统服务其余测试照旧全过。
- 拆 `system-service.ts`（#1070 第 3 步，第三簇）：首页检测的那一段（网络位置、Node / npm / Python / Git 和各家命令行工具的探测、查最新版和更新提示、哪些工具正开着、Codex 官方账号用量、整轮检测的合并限流和落盘、Codex 首次设置检查），连同只有它们用的顶层函数（网络位置的探测和解析、版本解析、`buildCliStatus` 这些），搬进新文件 `electron/system-scan-service.ts` 的 `createSystemScanService`。`createSystemService` 照旧对外给原来那些方法，`system-service.ts` 照旧导出原来导出的名字；起 CLI 子进程的环境和 Codex 桌面端那两样探测显式传进去，新文件只 import `system-service.ts` 的类型。
- 两处挪动：日志里记失败原因的 `credentialFailureReason` 各簇都用，搬进 `system-service-context.ts`；建 Codex 桌面端服务那一句挪到首页检测前面（检测要用它的两样探测，建它本身只是准备闭包，不发请求、不起进程）。搬运用脚本整段复制，逐段比对一字没改。Windows 上读 exe 版本（固定路径的 PowerShell 加 `trustedCommandEnvironment`，不跑用户可写目录里的程序）、管理员身份下认托管 npm 目录和核验 CLI 命令、证书提示分管理员身份那一支，这几段只搬不改。
- 测试：新增 `system-scan-service.test.ts`（镜像策略钉死时不探网络、网络位置只探一次、找不到命令答没装、Codex 首次设置检查用传进来的桌面端探测），`system-service-context.test.ts` 加一条日志里的失败原因不带用户目录；系统服务其余测试照旧全过。
- 拆 `system-service.ts`（#1070 第 3 步，第四簇）：从星芒打开工具的那一段（`launchProvider`、`launchCodexDesktop`，Codex 桌面端中文界面和工作目录信任那几个，打开前补写配置那一队），连同只有它们用的顶层函数（终端环境 `interactiveTerminalEnvironment` / `sameUserTerminalEnvironment`、打开时不交给工具的变量、`providerCommandEnvironment`、Mac 终端的启动计划、`writeQueuedWithin` 这些），搬进新文件 `electron/provider-launch-service.ts` 的 `createProviderLaunchService`。`createSystemService` 照旧对外给原来那些方法，`system-service.ts` 照旧导出原来导出的名字；起子进程的环境、Codex 桌面端的探测和启动、读工具状态、记住的工作目录、打开 Grok 前修钩子显式传进去，新文件只 import `system-service.ts` 的类型。
- 几样跨簇共用的状态搬进 `system-service-context.ts`：Windows 注册表里最新的 PATH（`refreshWindowsLivePath`，打开 Grok 和 Grok 钩子都看），「这次从星芒打开过哪些工具」和「哪些等重开才生效」两份记录（打开工具写、线路跟随读）。读最新 PATH 的两处从直接读变量改成调 `currentWindowsLivePath()`，这是唯一的改写；其余脚本整段复制，逐段比对一字没改。Windows 上核命令（管理员身份下 `assertTrustedElevatedCliCommand`）、开 PowerShell 窗口时终端环境以 `trustedCommandEnvironment` 为底、读注册表 PATH 这几段只搬不改。
- 测试：新增 `provider-launch-service.test.ts`（工作目录没了先拒、打开前记进共用记录并清掉「需重开生效」、只有 Grok 先修钩子、同一次打开点两下只开一次），`system-service-context.test.ts` 加两条 Windows 最新 PATH 的读取（几秒内只读一次、别的系统不读）；系统服务其余测试照旧全过。
- 出包加固门禁 `scripts/verify-packaged-hardening.cjs` 跟着改：「普通用户 CLI 启动边界」要找的 `launchCliPowerShell` 现在在 `dist-electron/provider-launch-service.js` 里找；旧的裸 PowerShell / Windows Terminal 启动链和管理员提权启动链照旧拦，查的范围从门面加启动模块扩到也查打开工具那份和共用上下文那份，只多不少。
- 拆 `system-service.ts`（#1070 第 3 步，第五簇）：三个外部桌面客户端（Claude Desktop、WorkBuddy、OpenCode）的那一段（盘点、安装、打开、测试连接、写配置、切回官方账号，换线路和换 Key 以后跟着换、开着就等它退出），连同只有它们用的几个顶层函数，搬进新文件 `electron/external-client-route-service.ts` 的 `createExternalClientRouteService`。`createSystemService` 照旧对外给原来那些方法；查型号的 `fetchAvailableModels` 显式传进去，新文件只 import `system-service.ts` 的类型。
- 写配置、切账号、跟线路原来各自手抄一份 `externalConfigQueue.then(work, work)` 排队，收成一个 `queueExternalConfigWork`，写法和先后一样。星芒退出时撤掉等客户端退出的那个定时，原来在 `disposeToolRoutes` 里直接改变量，现在调外部客户端那边给的 `cancelPendingExternalRouteRecheck()`。线路跟随用的钟和定时器（`toolRouteNow`、`scheduleToolRouteTimer`）两边都用，搬进 `system-service-context.ts`。这三处是仅有的改写，其余脚本整段复制、逐段比对一字没改；Windows 上建客户端运行时那段（winget 不可用、读安装记录不全、核签名的日志）只搬不改。
- 测试：新增 `external-client-route-service.test.ts`（写配置一件一件来、前一件失败不挡后一件；打开和取消安装交给客户端运行时），`external-client-service.test.ts` 加一条星芒退出时撤掉等客户端退出的定时（拿掉那一行调用这条会红）；系统服务其余测试照旧全过。
- 拆 `system-service.ts`（#1070 第 3 步，第六簇）：换线路时定点改写命令行工具配置的那一段（`followToolRoutes` 和它的重试、回头核对、重开提示，首页和设置快照里线路那几个字段，`noteRouteFollowRestart`、`disposeToolRoutes`）搬进新文件 `electron/tool-route-follow-service.ts` 的 `createToolRouteFollowService`。`createSystemService` 照旧对外给原来那些方法；哪些工具开着、撤掉外部客户端那边的定时显式传进去，新文件只 import `system-service.ts` 的类型。
- 两处改写：`bindToolRouteAccount` 原来是门面返回对象里直接改变量的一行，现在是线路跟随那边的一个函数；保存配置和线路跟随都用的 `sameNativeConfigSnapshot` / `untouchedSince` 搬进 `system-service-context.ts`（`system-service.ts` 照旧导出 `sameNativeConfigSnapshot`）。其余脚本整段复制，逐段比对一字没改。这一簇没有 Windows 专属的段落。
- 测试：新增 `tool-route-follow-service.test.ts`（没有账号归属时一个工具都不碰、退出时连外部客户端那边的定时一起撤），`system-service-context.test.ts` 加一条读不出的配置算动过；系统服务其余测试照旧全过。
- 拆 `system-service.ts`（#1070 第 3 步，第七簇）：官方账号与当前账号来回切的那一段（`switchToOfficialAccount`、`setOfficialSourcePreference`、`restoreOfficialCredentials`、`adoptRestoredConfig`、`alignRestoredAccountSource`，挪开和放回 Claude Code 官方 Console Key、撤回挪动，Codex 跟着账号开关星芒AI技能）搬进新文件 `electron/official-credential-service.ts` 的 `createOfficialCredentialService`，只用到大家共用的那份上下文。`createSystemService` 照旧对外给原来那些方法，保存配置那一段照旧调这里的挪开、放回和撤回；`planRestoredConfigOwnership`、`restoredAccountSide` 跟着搬过去，`system-service.ts` 照旧导出。
- 没有改写：脚本整段复制，逐段比对一字没改。这一簇没有 Windows 专属的段落。
- 测试：新增 `official-credential-service.test.ts`（挪开、放回用的是上下文给的主目录，改官方记号排在写配置那条队里，撤回失败时把现状补进报错）；系统服务其余测试照旧全过。
- 拆 `system-service.ts`（#1070 第 3 步，第八簇，最后一簇）：保存工具配置的那一段（`saveConfig`、换型号和刷新菜单、配置摘要和明文密钥、打开前的型号核对、开机补模板缺省项、Codex 随包型号名单的写入和收回、各家工具的钩子和状态行、退役 Gemini 的接入清理）搬进新文件 `electron/config-save-service.ts` 的 `createConfigSaveService`。`createSystemService` 照旧对外给原来那些方法；首页检测、外部客户端、线路跟随、官方账号那几样显式传进去，新文件只 import `system-service.ts` 的类型，搬走的十个导出名 `system-service.ts` 照旧转出。`createSystemService` 由 1380 行左右收到 330 行左右，只剩把各簇接起来的门面（其中返回对象 78 行、Codex 桌面端的接线 41 行）。
- 三处改写：问中转能用哪些型号的 `fetchAvailableModels` 连同它的缓存和几个小工具（`modelAccessCacheKey` 等）搬进 `system-service-context.ts`，外部客户端和保存配置都从那里拿（`system-service.ts` 照旧导出 `modelAccessCacheKey`）；门面里线路跟随、官方账号两段的接线挪到保存配置前面（保存配置要用它们，运行环境安装、装卸 CLI、打开工具又要用保存配置给的钩子和型号名单那几样）；`external-client-route-service.ts` 的 `ManagedKeyFollowTarget` 加了 `export`，给保存配置的依赖声明用。其余脚本整段复制，逐段比对一字没改。跟 Windows 有关的几段原样搬过去：状态行和钩子里写进配置的 Node 路径照旧由上下文的 `findInstalledExecutable` 找（管理员身份时的可信路径判断在上下文里，没动）；Windows 上 Grok 用 Git Bash 还是 PowerShell 跑钩子（`expectedGrokWindowsShell`、`resolveCliHookInvocation` 里先读注册表最新 PATH 那两行）。
- 测试：新增 `config-save-service.test.ts`（保存 Claude Code 用的是上下文那份型号列表和传进来的挪开官方 Key、换完星芒签的 Key 让外部客户端跟上；型号不对时一个都不碰；开机那次型号名单检查只做一遍），`system-service-context.test.ts` 加一条型号列表缓存；系统服务其余测试照旧全过。
- 文档：`AGENTS.md` T3 改成「先找对文件」，模块地图、`AGENT-RUNBOOK.md`、`COLLABORATION.md` 里「`system-service.ts` 是全仓最大的文件」的说法跟着改。
- 拆 `main.ts` 的退出清理（#1070 第 4 步）：原来散在 7 处的 `app.once('will-quit')` 收成一张按登记先后执行的清单（新文件 `electron/bootstrap/lifecycle.ts` 的 `createQuitCleanup`），`main.ts` 只挂一个 `will-quit`，各处改成 `quitCleanup.add(名字, 步骤)`，共 18 步。登记位置、先后和每一句清理都没变（41 句逐句对过）。
- 唯一的行为差别只在出错时：以前某一句同步抛错，同一组后面的清理和之后挂的 `will-quit` 全被跳过，错误还可能落进「意外退出」那条路（按代码推断：这时还没记下「是自己在退出」），把刚点了退出的软件重开；现在每步各自兜住，抛错记 `app.quit-cleanup.failed`（带步骤名），后面的照跑。加速服务、独立加速进程拆成相邻两步，前者抛错也照样放掉后者，由它还原系统代理（#1265 的重试上限在加速进程里，没动）。
- 测试：`bootstrap/lifecycle.test.ts` 钉清单本身（按登记先后、只跑一次、抛错不拦后面、晚登记的不跑）；`main.test.ts` 按源码钉 18 步的先后、只有一个 `will-quit`、两步平台专属的条件（有加速组件、只 Mac）原样保留、加速两步的先后和整个退出只放一次加速进程。
- 拆 `main.ts` 的启动回调（#1070 第 5 步，第一批）：按账号站点分开的 AI 工作区（聊天、画图、视频、画布运行、作品存储和缩略图，每个站点一份，第一次用到时才建）原样搬进 `electron/bootstrap/ai-services.ts` 的 `createRealmBusinesses`，只给它用的缩略图生成、聊天截图缩小两个小工具一起搬。`main.ts` 从 4070 行降到约 3600 行。搬运用脚本按行号整段复制，前后逐行比对：多出来的只有文件头、依赖参数、取主窗口那一句（主窗口建得比这里晚，用到时再取）和开发版作品位置要用的项目目录改由 main.ts 交进来；建这些东西的时机和先后照旧。
- 测试：`main.test.ts` 先在没拆的 main.ts 上钉住启动回调直接做的各步先后（退出清理、线路、系统服务、更新、账号、加速、通道、窗口、托盘），每步只做一次、都在启动回调里直接做，退出清理只由 main.ts 登记。读 main.ts 源码核对接线的几个测试改读 main.ts 加 `bootstrap/` 全部模块（`bootstrap/main-source.test-support.ts`），代码搬走以后照样有效。新增 `bootstrap/ai-services.test.ts`：每个站点只建一次、两个站点分开存放、历史账号不能生成视频、画布运行的订阅挂到后建的站点上、退订后都摘掉。
- 拆 `main.ts` 的启动回调（#1070 第 5 步，第二批）：网络线路原样搬进 `electron/bootstrap/network-routes.ts`。`createNetworkRoutes` 建应用线路、直连会话、只跟随系统代理的探测会话、按线路走的几种 fetch、工具线路和线路状态文件，建完开始查应用线路，跟原来在启动回调里的位置一样；`startToolRouteFollowing` 是原来系统服务建好以后那段（挂工具线路监听、开始查工具线路、唤醒和网络恢复时重查）。`main.ts` 从约 3580 行降到约 3360 行。前后逐行比对：多出来的只有文件头、依赖参数、取主窗口那两句、探测地址改由传进来的 `readStoredConfig` 读站点设置（系统服务建得比这里晚，原来也是出了事才去读），以及「最近一次读到的线路状态文件」改成取值函数；退出清理照旧在 main.ts 里登记。
- 测试：`main.test.ts` 的启动顺序改成钉 `createNetworkRoutes`、`startToolRouteFollowing` 两步，另钉住两步各自里面的先后（应用线路先建、先订阅再开始查；工具线路先挂监听再开始查）。新增 `bootstrap/network-routes.test.ts`：只经交进来的会话 fetch 发请求、主窗口建好以前不发通知、工具线路换了才改工具配置并分清是不是出了故障、历史账号不多叫界面重读、唤醒和网络恢复时重查。全部请求打在假的 fetch 上，不连真实站点。
- 第一批新加的 `bootstrap/ai-services.test.ts` 偶尔在收尾删临时目录时报 `ENOTEMPTY`：每个站点建好时会在后台往作品目录试写一次，测试结束时没等它写完。现在收尾先等这些试写结束再删，只改测试。
- 拆 `main.ts` 的启动回调（#1070 第 5 步，第三批）：检查页和反馈报告原样搬进 `electron/bootstrap/diagnostics.ts`。`createDiagnostics` 交出原来的 `diagnosticsService`（健康诊断、一键处理、连接自检、Codex 实测、诊断导出），建的位置跟原来一样；反馈报告的「工具环境」「运行环境」「自检结果」三段由它的 `attachFeedbackDescribers` 挂上，main.ts 照旧在原来那个位置调用。前后逐行比对：多出来的只有文件头、依赖参数，以及三处改成用到时再取（AI 作品存储、最近一次扫描快照建得比这里晚，原来也是用到时才读）。
- 测试：`main.test.ts` 的启动顺序加上这两步。新增 `bootstrap/diagnostics.test.ts`：没诊断过时不能导出、也不算自检过；确认过的账号变了就不发要计费的 Codex 实测；三段反馈只挂一次，挂的时候不去读扫描快照。不发任何网络请求。
- 拆 `main.ts` 的启动回调（#1070 第 5 步，第四批）：两个账号站点的登录记录和账号客户端原样搬进 `electron/bootstrap/accounts.ts`。`createAccountStorage` 是原来按系统能不能加密选保管、建登录记录那一段；`createAccountClientFactory` 是原来写在 `createRealmAccountService` 里的 `createClient`，连同账号请求经系统代理没走通时改直连重发的那个函数。换账号、退出时各服务怎么收拾（`quiesce`、`onChanged`）牵着整个应用，留在 main.ts。前后逐行比对：多出来的只有文件头、依赖参数和取主窗口那一句。
- 测试：`main.test.ts` 的启动顺序加上这两步（在注册协议之后、建账号服务之前）。新增 `bootstrap/accounts.test.ts`：系统不能加密时日志里照实说、Linux 上只留本次运行也不写账号文件、Windows 和 macOS 上不退到只留内存；两个站点各建各的客户端，建的时候不发请求；星芒账号的客户端不恢复、也不结束历史账号的登录。
- 拆 `main.ts` 的启动回调（#1070 第 5 步，第五批）：主程序自己的更新原样搬进 `electron/bootstrap/updates.ts`。`createUpdateFeed` 是原来定更新目录那一段（Windows 上的严格代码签名校验、包里那份还是直连那份、按线路换），它的 `createUpdater` 是原来建更新服务、服务状态文件监视器的那一段，main.ts 照旧在各自原来的位置调用。版本记录、待装记录、打开时装和退出时装牵着窗口和退出流程，留在 main.ts。前后逐行比对：多出来的只有文件头、依赖参数，退出交接改成用到时再取（它在主窗口建好以后才接上，原来也是用到时才读），服务状态文件定下的「换线路时工具配置怎么改」经一个设置函数记回 main.ts 交给系统服务的那个开关。Windows 专属的签名校验只搬不改。
- 测试：`main.test.ts` 的启动顺序改成钉这两步，另钉住里面的先后（先装签名校验、定更新目录，再建更新服务、再开始读服务状态文件）。
- 拆 `main.ts` 的启动回调（#1070 第 5 步，第六批）：本机加速的接线原样搬进 `electron/bootstrap/acceleration.ts`，按启动时建的先后分三段，各自在 main.ts 原来那一段的位置调用：
  - `createAccelerationRouting`：装 CLI、下 Node 时临时走的下载线路，打开 Codex 桌面端时替他连的那一次加速和启动线路。系统服务要用，仍在系统服务之前建。
  - `createAccelerationHost`：读完加速文件以后建宿主、把上次崩溃没改回的系统代理改回去。main.ts 照旧在原来的位置先等加速文件读完再交进去，等的还是同一次。
  - `createAccelerationServices`：加速服务、时长快用完和加速中断两种系统通知、加速页和托盘看到的那一套。main.ts 原来的 `acceleration`、`accelerationExpiry`、`accelerationInterruption`、`trayAcceleration` 几个变量照旧留着，拿到结果马上填上，别处读的还是它们。
  睡眠唤醒那一段（只在有宿主时挂）和退出清理留在 main.ts。前后逐行比对：多出来的只有文件头、依赖参数，以及几样建得比这里晚的东西（加速服务、加速宿主、账号服务、系统服务、主窗口、托盘）改成用到时再取，原来也是用到时才读。
- 测试：`main.test.ts` 的启动顺序改成钉这三步，另钉住每段里面的先后：下载用的网络分区先建；宿主建好马上改回系统代理；两种提醒建在加速服务之前，托盘最后。新增 `bootstrap/acceleration.test.ts`：安装包里的加速文件读不通时不建宿主、记成文件坏了；没带加速文件时不建也不报；建好马上改回系统代理；加速进程退出时告诉的是这会儿的中断提醒；没有下载线路时下载走默认会话；连接用账号存过的线路和模式，读不到就用默认；加速服务还没建时 Codex 桌面端照常不加速打开；加速服务出的每一份状态都交给 Codex 桌面端那边；文件坏了时给「重新检查」并记下结果，没坏不给；Linux 托盘上没有加速那一行，别的平台建好那一行但不碰还没建的托盘。
- 拆 `ipc.ts` 的入参解析（#1070 第 6 步）：57 个 `parse*` 函数和它们共用的 `requiredString` 等基础校验按域搬进 `electron/ipc/parsers/` 下 11 个文件（`common`、`system`、`settings`、`extensions`、`tools`、`sessions`、`account`、`account-billing`、`account-usage`、`account-keys`、`ai-chat`），`ipc.ts` 从 3975 行降到约 2950 行，只留注册。函数体逐字没动（脚本逐块比对过），只多了 `export`，两处注释里的「above」改成写明在哪个文件；通道注册按域拆是第 7 步，这次没碰，`ipc-channel-policy.ts` 也没碰。
- `ipc.ts` 自己那份 `isRecord` 顺手换成 `input-guards.ts` 的（#1071 第 3 条说拆分时换）：旧写法 `Boolean(value && typeof value === 'object' && …)` 和新写法 `typeof value === 'object' && value !== null && …` 对任何输入结果都一样（对象都是真值）。`isPromiseLike` 两份判法不同，留在 `ipc.ts` 没换。
- 测试：`ipc.test.ts` 经处理器走的解析用例照旧全过，只改了 import；`ipc/parsers/` 下新加 6 个测试文件，直接钉路径、密钥、网址、命令相关的几个解析（会话 ID 和续接记录 ID 挡路径穿越、CLI 版本挡 npm 参数、MCP 命令和地址挡 NUL、对话图片只认素材 ID、删改密钥的 ID 只认正整数、Codex 中文界面开关写错就拒、线路只认登记过的）。
- 拆 `ipc.ts` 的通道注册（#1070 第 7 步）：196 个通道的处理器按域搬进 `electron/ipc/handlers/` 下 20 个文件（`system`、`config`、`external-clients`、`launch`、`tools`、`window`、`updates`、`sessions`、`settings`、`diagnostics`、`runtime-logs`、`backups`、`extensions`、`account`、`acceleration`、`account-billing`、`account-usage`、`account-keys`、`ai-chat`、`data-transfer`），每个文件一个 `register*Handlers(ctx)`。`ipc.ts` 从 2955 行降到约 380 行，只留 `IpcRegistrationOptions`、`registerTrustedHandler` 那层包装（发送方校验、按 `ipc-channel-policy.ts` 记日志和等账号，一行没改）和组装各域、统一撤销。
- 原来 `registerIpcHandlers` 里几个域共用的局部变量（账号服务、签发包装、撤销时记下的额度、备份上下文、取密钥、导出记录、敏感剪贴板、检测失败日志）收进 `ipc/handlers/context.ts` 的 `createIpcHandlerContext`，每次注册建一份；域文件只从它拿，互不 import。成功日志的说法和字段搬进 `ipc/handler-log.ts`，检测失败那几行搬进 `ipc/handlers/detection-failures.ts`。
- 搬运用脚本按原文件行号整段复制，处理器和共用小工具的函数体逐字没动（搬前搬后逐行比对，多出来的只有各文件的函数头、取 `ctx` 那一行、`ipc.ts` 里的组装、几处 `export` 和两处指位置的注释）；建这些东西的先后、撤销时的先后都照旧。通道名仍只能写契约里的、每条仍过同一张策略表，漏写拼错照样编译不过。Windows 专属的几条（提权安装、重启 Windows、打开前试写）只搬不改。
- 测试：`ipc.test.ts` 只改了 `accelerationStateLogKey` 的 import，其余照旧全过，通道对账照旧兜底（漏注册、多注册、重复注册都红）。
- 拆 renderer-v2 的 `App.tsx`（#1070 第 8 步）：界面主组件从 2075 行降到 601 行，只剩把各块接起来和摆页面。状态和副作用按块搬进 19 个 hook（17 个文件）：`features/app/` 下的 `useAppBoot`（开机读取）、`useStartupNotices` / `useStartupChecks`（角落提示与开机检查）、`useAppOnlineStatus`（断网横幅）、`useAppNavigation`（页面与落点）、`useAccountBootstrap`（登录后写密钥、断网补跑）、`useRelayRouteSync`（线路跟随）、`useAccountSessionSync`（换账号、退出）、`useAppearance`、`useSupportContact`、`useToolUpdateNotice` / `useBalanceWatch`、`useUpdateBubble`、`useDeepLinks`、`useFailureActions`、`useAppEntryPoints`（托盘、通知、快捷键），`features/tools/` 下的 `useToolInstall`、`useToolLaunch`、`useToolAccountActions`。纯搬运，界面和文字一个字没变。
- `App.tsx` 里三个手写的防慢响应计数器换成 `useLatestRequest`：`accountEpoch`、`bootstrapEpoch`、`sessionEvents`。`latest-request.ts` 加 `capture()`：只记下这一刻、不作废别人，几件事各记各的、一换账号一起作废（`accountEpoch` 的用法）。其余文件里的计数器下一个 PR 换。
- renderer-v2 其余 17 个文件里手写的防慢响应 `useRef(0)` 计数器全部换成 `useLatestRequest`（#1070 第 8 步下半）：每次发请求先 `begin()`，几件事各自记下当时那一刻、互不作废的用 `capture()`，手动作废的地方换成 `invalidate()`，卸载时作废那行删掉（hook 自己会做）。界面行为不变。`ConfigDialog` 里「打开时自动读型号」的转圈原来拿请求编号当 state，现在改成每次一个新的空对象；`Announcement` 里「正在标已读」的去重原来把编号拼进 key，现在每读一轮换一份名单。剩下的几处 `useRef(0)` 是时间戳、编号、计数或滚动位置，不是竞态守卫，不换。AGENTS.md T6 跟着改：计数器已换完，补上 `capture()` 的用法。
- 拆 `diagnostics.ts`（#1070 第 9 步，第一块）：`runDiagnostics` 开头解析依赖的那段搬进新文件 `electron/diagnostics-context.ts` 的 `createDiagnosticsContext`，交出 `DiagnosticsContext`：环境、用户目录和 Codex 目录、平台、站点和工具线路（工具线路缺省跟着应用线路）、各家工具配置先读一遍的结果（下线的 Gemini 也读，报告里一样遮掉它的 Key）、脱敏用的 `sanitize`、能用首页扫描结果就不再探的 `inspectTool`、日志和钟。几类检查都要用的小工具一起搬过去：问工具装没装、是哪一版的缺省实现（`defaultInspectTool` 和它用的三个小函数）、扫描结果复用（`diagnosticsScanReuseMs`、`scannedToolStatus`、`scannedCodexDesktopStatus`）、`isRecord`、`errorChainText`、线路名 `relayLineNames`。脱敏和导出（路径显示、URL 清洗、`redactDiagnosticText`、`createDiagnosticsExport`）搬进 `electron/diagnostics-redaction.ts`。两个新文件都只 import `diagnostics.ts` 的类型，搬走的导出名 `diagnostics.ts` 照旧转出，别处的 import 一个没改。
- 搬运用脚本按原文件行号整段复制，搬前搬后逐段比对一字没改，只给要跨文件用的几个函数加了 `export`；`runDiagnostics` 里用一次解构把这些名字照原样接回来，检查项的代码一行没动。Windows 专属的那段（`versionForExecutable`、`defaultInspectTool` 里只跑可信高完整性路径的判断、`.cmd` 不跑、Windows 上用 `trustedCommandEnvironment`、找 npm 的 `.cmd` 垫片）原样搬进 `diagnostics-context.ts`，没改。
- 测试：`diagnostics.test.ts` 加一条钉住全部检查项的次序和名字（Windows 全开、Mac 少两项），后面按类别拆时不能乱；新增 `diagnostics-context.test.ts`（工具线路缺省跟着应用线路、各家配置都读且 Key 在报告里遮掉、读不了的那家不拦别家、扫描探到的不再探）。另用八种情况（Windows、Mac、Linux、断网、被拦截、服务端 500、全部卡住超时、管理员身份）把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
- 文档：模块地图加两个新文件，`.claude/rules/macos-platform.md` 里可执行文件解析的位置跟着改。
- 拆 `diagnostics.ts`（#1070 第 9 步，第二块）：「系统与权限」那五项（星芒版本、操作系统、电脑芯片、运行权限、打开工具用的命令窗口）连同只有它们用的 `defaultInspectAdministrator`、`defaultInspectPowerShell`、`operatingSystemSummary`、`buildWindowsArmSummary` 搬进新文件 `electron/diagnostics-system-checks.ts` 的 `buildSystemChecks(context)`；`runDiagnostics` 的检查清单里那五项换成 `...buildSystemChecks(context)`，次序不变。新文件只 import `diagnostics.ts` 的类型（`CheckOutcome`、`CheckDefinition` 为此加了 `export`），搬走的两个导出名 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改；`buildSystemChecks` 开头用一次解构把上下文里的名字照原样接回来。Windows 专属的几段原样搬过去，没改：问「是不是管理员」先用 whoami 读完整性标签、读不出再起 PowerShell（`defaultInspectAdministrator`），读 PowerShell 版本只用 `resolveWindowsPowerShellExecutable` 给的可信路径、跑在 `trustedCommandEnvironment` 下（`defaultInspectPowerShell`），有首页扫描结果时 PowerShell 那一项只取可信路径不起进程，启动时那次探测没问出来、管理员身份、账号自带管理员、普通账号不在管理员组这几种运行权限的说法，ARM 电脑读 node.exe 文件头看是哪一版。
- 测试：这五项的行为由 `diagnostics.test.ts` 原有的用例钉着（Mac、Linux、认不出的系统、ARM、管理员和提权的几种、命令窗口），上一块加的次序测试照旧绿；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
- 拆 `diagnostics.ts`（#1070 第 9 步，第三块）：「运行环境与工具」那几项（Node.js、它自带的安装组件、Python、Git、各家命令行工具、Codex 桌面端、各家工具的连接设置）连同只有它们用的小工具（项目名表 `runtimeCheckTitles`、Codex 桌面端单独探的 PowerShell 脚本和 `defaultInspectCodexDesktop`、`providerOutcome` 和它用的线路比对、Codex 后台常驻的说法、`reconcileNodeRuntimeWithClis`）搬进新文件 `electron/diagnostics-tool-checks.ts` 的 `buildToolChecks(context)`；`runDiagnostics` 的检查清单里换成 `...buildToolChecks(context)`，次序不变，收尾时照旧调 `reconcileNodeRuntimeWithClis`。新文件只 import `diagnostics.ts` 的类型，搬走的四个导出名 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改。Windows 专属的那段原样搬过去，没改：Codex 桌面端单独探时只用 `resolveWindowsPowerShellExecutable` 给的可信路径、跑在 `trustedCommandEnvironment` 下，脚本开头先按名字导入四个模块，只认当前账号自己的应用注册（不用 `-AllUsers`）。
- 测试：这几项的行为由 `diagnostics.test.ts` 原有的用例钉着（下线的 Gemini 不出这两项、首页扫描的复用、连接设置和线路、Codex 后台常驻、没装命令行工具时 Node.js 降级），Codex 桌面端那段脚本由 `powershell-module-imports.test.ts` 照旧从 `diagnostics.ts` 拿来查；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
- 拆 `diagnostics.ts`（#1070 第 9 步，第四块）：「网络与代理」那几项（星芒服务连接、安全证书、Clash Verge 的 TUN、电脑里的代理设置）连同只有它们用的常量和小工具（Clash 配置的找法和 `parseClashTunConfig`、代理变量的探法和 `windowsProxySettingsOutcome`、软件自己走哪条代理的 `inspectAppProxyRoute` / `withAppProxyRoute`、两条线路状态页的探测地址和结论、本机时钟偏差、线路切换的说法、安全证书那一项的 Node 握手探测和 `reconcileCertificateTrustWithNetwork`）搬进新文件 `electron/diagnostics-network-checks.ts`。原清单里这四项不挨着（中间隔着磁盘那几项），所以分成 `buildNetworkChecks(context)`（星芒服务连接、安全证书）和 `buildProxyChecks(context)`（TUN、代理设置）两个，`runDiagnostics` 在原来的两个位置各展开一个，次序不变；收尾时照旧调 `reconcileCertificateTrustWithNetwork`。新文件只 import `diagnostics.ts` 的类型，搬走的十三个导出名和 `AppProxyRoute` 类型 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改。Windows 专属的两段原样搬过去，没改：`windowsProxySettingsOutcome`（读当前账号和整台电脑各设了什么代理，details 只写变量名和本机端口）；安全证书那一项「以管理员身份打开时不起进程去量、直接给结论」的分支。量证书时起 Node 照旧走 `runCommand` + argv、`commandEnvironment`。
- 改了三处注释里的文件名（`relay-line-fetch.ts`、`connection-check.ts`、`relay-route-controller.ts` 说「诊断那一项在哪」的地方），以及 `docs/module-map/` 两份文档。
- 测试：这几项的行为由 `diagnostics.test.ts` 原有的用例钉着（两条线路、退回、加速时、时钟偏差、证书的几种结论、TUN、代理设置的几种情况）；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
- 拆 `diagnostics.ts`（#1070 第 9 步，第五块）：「磁盘与文件夹」那几项（磁盘空间、「文档」文件夹能不能写、AI 作品保存位置、加速功能、文件夹位置）连同只有它们用的小工具（量哪几处磁盘的 `resolveDiskSpaceTargets`、加速文件坏了的那句话、「C 盘搬家」的 `findRelocatedFolders` / `describeRelocationTarget` / 要查的文件夹清单、`documentsWritabilityOutcome`）搬进新文件 `electron/diagnostics-storage-checks.ts` 的 `buildStorageChecks(context)`；`runDiagnostics` 的检查清单里换成 `...buildStorageChecks(context)`，次序不变。检查页「打开文件夹」按钮用的 `DiagnosticFolderTarget` / `isDiagnosticFolderTarget` 是给通道用的，留在 `diagnostics.ts`。新文件只 import `diagnostics.ts` 的类型，搬走的三个函数和两个类型 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改。Windows 专属的几段原样搬过去，没改：「文档」能不能写只在 Windows 上查；文件夹位置那一项照旧先按原样找联接、再按 `resolveRelocatedPath` 跟过去后重找（I8 那条已登记的例外），以管理员身份运行时照旧不往搬过的文件夹写、标红；盘符和共享文件夹的说法。
- 测试：这几项的行为由 `diagnostics.test.ts` 原有的用例钉着（磁盘空间的几档、「文档」写不进、AI 作品保存位置、加速文件损坏、搬家后跟过去和不跟过去）；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
- 拆 `diagnostics.ts`（#1070 第 9 步，最后一块）：「电脑里另外设过的设置」那几项（电脑里另外设过的工具地址或密钥、项目文件夹里的设置、Codex 文件夹里的额外设置、Claude Code 跑命令前要不要先问你、个人文件夹里早先留下的设置）连同只有它们用的东西（环境变量名单 `ENVIRONMENT_OVERRIDE_VARIABLES` 和判定、Mac 终端设置文件的读取、`clearableEnvironmentOverrides` / `environmentOverrideNames` / `environmentAccountBaseUrls`、被忽略的 `CODEX_HOME`、`readClaudeBypass`、`homeFolderLeftoversOutcome`，以及原来在 `runDiagnostics` 里的项目文件夹设置那段闭包）搬进新文件 `electron/diagnostics-override-checks.ts` 的 `buildOverrideChecks(context)`。搬走的四个导出名 `diagnostics.ts` 照旧转出，`diagnostic-fixes.ts`、`bootstrap/diagnostics.ts` 和测试都不用改。
- `runDiagnostics` 现在只剩编排：建共用上下文，按原来的次序展开 `buildSystemChecks`、`buildToolChecks`、`buildNetworkChecks`、`buildStorageChecks`、`buildProxyChecks`、`buildOverrideChecks`，每项单独限时跑，收尾做两处跨项调和再数数。`diagnostics.ts` 从拆之前的 2961 行降到 504 行。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改。Windows 专属的几段原样搬过去，没改：环境变量名按 Windows 的规矩不分大小写去找；「删掉这几项设置」只在 Windows 上挂，能删的只有地址和密钥类、不碰目录和开关类（清除脚本那一侧再对照 `environmentOverrideNames` 一遍）；路径比较在 Windows 上不分大小写。
- 改了三处注释里的文件名（`workspace-config-overrides.ts`、`provider-launch-service.ts`、`diagnostics.test.ts` 说「在哪」的地方；`workspace-config-overrides.ts` 那句里原来写的 `system-service.ts` 实际已经不用它，顺手改成真用它的 `provider-launch-service.ts`），`docs/module-map/main-runtime.md` 里 `diagnostics.ts` 一条重写成总入口，`AGENTS.md` T10 的消费者名单注明各类检查拆在 `diagnostics-*.ts`。`config-files.ts` 里还有一句「见 diagnostics.ts 那段实测」，这一步不碰那个文件，没改。
- 测试：这几项的行为由 `diagnostics.test.ts`、`diagnostic-fixes.test.ts` 原有的用例钉着（各个变量盖不盖过当前账号、Mac 终端设置文件、能一键清的名单、被忽略的 `CODEX_HOME`、项目文件夹设置、`.env`、跑命令前问不问、个人文件夹的旧说明和信任）；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
- #1071 第 1 条「通道策略表」：主窗口业务通道在日志里记什么、要不要等账号，从 `ipc.ts` 里五串按名字写的字符串集合
  （`ipcOperationLabels`、`quietIpcSuccessChannels`、`secretInputIpcChannels`、`quietIpcFailureChannels`、`pollingIpcChannels`）
  和那一长串 `startsWith` / `publicAccountChannels` 搬进新文件 `electron/ipc-channel-policy.ts` 的 `ipcChannelPolicies`。
  类型是 `Record<IpcInvokeChannel, …>`，`log`（normal / quiet-success / secret-input / silent / polling）和
  `account`（none / scoped / scoped-may-end-session / scoped-queued）两项必填：漏一条、多一条、拼错一条都是编译错，
  新通道得表态；`registerTrustedHandler` 也只收契约里的通道名。
- 不改行为：196 条通道逐条核对过，改前改后的标签、成功和失败记不记、入参给不给格式化函数、轮询、等不等账号、
  跑完核不核对账号都一样。开机先摆上次客户端结果那一读（按入参判断）和 `config:get` 的开机预算照旧留在 `ipc.ts`。
- `ipc.test.ts` 加 4 条：两步验证码长得像工具名时成功日志里也不出现它；silent 的失败不记、quiet-success 的失败照记；
  改密码、踢掉登录跑完时账号变了照样返回，别的账号调用作废；account: / chat: / config: / models: 开头却不等账号的
  只有原来那 16 条管登录的，照抄邻居写成 none 会当场变红。前三条先在旧代码上跑绿再换。
- #1071 第 2 条「生图入参两份解析」：对话页 `chat:generate-image` 不再用 `ipc.ts` 自己的 `parseAiImageGenerateInput`，
  改调 `canvas-request-parser.ts` 新导出的 `parseImageGenerateInput`，画布的 `parseCanvasImageGenerateInput` 也只是它套个报错前缀。
  每项取两边较严的：型号 128、尺寸 32（画布原来 200、64），拒多余字段，标识类字段拒全部控制字符、提示词只放过换行回车和 Tab，
  画质和清晰度按原值比对、不再先转字符串（对话页原来是 `String()` 后比，还把原值用 `as` 原样往下传）。
- 只收紧：对话页原来会悄悄丢掉的多余字段（比如混进来的 `expectedUserId`）、标识或提示词里的控制字符、数组形式的画质，现在都拒；
  画布原来能过的 129~200 字的型号名、33~64 字的尺寸也拒。对话页实际只发那 7 个字段，提示词发之前已经去掉首尾空白，正常用法不受影响。
- 报错前缀各留原样：对话页仍是「生图…格式错误」，多余字段沿用现成的「生图请求格式错误」，没新增上屏的字；画布仍是「画布生图…」。
  对话页原来会把值的首尾空白去掉，合成后按画布的做法原样往下传。
- 新增零依赖的 `electron/input-guards.ts`（`isRecord`、`isStringArray`、`filterStrings`、`isPromiseLike`），
  主进程和渲染层都能用，已登记进 `verify-renderer-boundary` 的值导入名单。新代码从这里取；旧文件里各自写的
  四十多份等拆分时（#1070）顺手换，本次不批量替换（#1071 第 3 条）。
- renderer-v2 加共用的防慢响应覆盖 hook（#1073 第 10 条）：`src/renderer-v2/latest-request.ts` 的 `useLatestRequest()`，`begin()` 拿到一个「这次还算不算数」的函数，后发的请求、`invalidate()`、组件卸载都会让之前的作废；`createLatestRequest()` 是非 hook 版。AGENTS.md T6 改成新代码用它。现有三十来处手写的 `useRef(0)` 计数器这次不动，等 #1070 拆分时一并换。界面不变。
- 渲染层能值导入的 28 个主进程模块（`verify-renderer-boundary` 的 `valueImportable` 名单）第一行统一加
  `// @renderer-importable: …` 标记，光看文件就知道它会进渲染层、不许碰 Node（#1073 第 11 条）。门禁新增两道核对：
  `electron/` 下有标记的和名单上的必须完全一致（标记只认第一行、整行照抄）；名单上模块值导入的主进程模块也必须在名单上。
  名单本身没变，模块代码没动。
- Codex 插件目录走 GitHub 下载时，跟跳转补齐和 Node 运行时、macOS 安装器同样的两道检查：
  走过的地址记下来，绕回去就停；响应带着地址时必须正是这一跳请求的那个，否则丢掉不落盘。
  地址里的片段先去掉再比（`electron/codex-plugin-catalog.ts` 的 `fetchCatalogArchive`，#1073 第 1 条 a）。
- 安装包下载的逐跳跟随跳转抽成共用的 `electron/redirect-allowlist-fetch.ts`（#1073 第 1 条 b），
  Node 运行时（`fetchTrustedNodeResource`）和 Mac 桌面端安装器（`fetchMacosDesktopResource`）换过去，
  原有校验一条不少。顺带收紧两处：Node 那份要求响应自报的地址正好是这一跳（以前同一文件的镜像地址也放过），
  跳转响应在报错前一律丢掉响应体。Codex 桌面端那份不动，Codex 插件目录、Git 运行时、Claude Desktop MSIX 三份以后再换。
- Codex 插件目录（`fetchCatalogArchive`）、Git 运行时（`fetchTrustedGitResource`）、Claude Desktop MSIX
  （`fetchClaudeDesktopPackage`）三处下载跳转换成共用的 `electron/redirect-allowlist-fetch.ts`（#1073 第 1 条），
  只剩 Codex 桌面端那份按 AGENTS 第 7 节不收。原有校验一条不少，Git 给客户看的几句报错原样保留。
  共用函数加了三样：`messages` 沿用调用方原来的报错字，`fetchLandingWithRedirectAllowlist` 交回答话的那一跳
  （生产下载用的 fetch 不填 `response.url`，MSIX 续传要靠它找回上次的文件），`beyondLimit: 'return'` 让续传不跟跳转。
  顺带收紧两处：插件目录只跟 301/302/303/307/308（以前 300、304、305、306 带地址也跟），Git 要求响应自报的地址正好是这一跳
  （以前同在白名单主机上就放过）。
- Grok 版本查询（`grok-update.ts`）和 AI 图片下载（`ai-asset-store.ts`）的跳转跟随也换成共用的
  `electron/redirect-allowlist-fetch.ts`（接 #1073 第 1 条），主进程手写的逐跳跟随只剩 Codex 桌面端那份
  （AGENTS 第 7 节不动）。原有校验一条不少，报错字照旧。图片那处每一跳仍按自己的主机挑 fetch：
  `imgen.x.ai` 走跟随代理的会话，其余先查 DNS、只许公网地址再钉住。顺带：两处被拒或被跟过去的跳转都丢掉正文
  （以前 Grok 一律不丢，图片超过次数那次不丢）。
- #1073 第 2 条：响应体大小上限的最后 5 份自写副本（`ai-image-service.ts`、`ai-asset-store.ts`、
  `ai-video-service.ts`、`grok-update.ts`、`sub2api-account-client.ts`）换成共用的 `bounded-response.ts`。
  共用版加了三个可选项：`requireNonEmpty`（没有响应体、读完是 0 字节各报各的那句）、`oversizeError`（超限抛带类型的
  错误，历史账号客户端靠它照旧抛 `RealmAccountError`）、`guard`（每读一块跟停止信号赛跑并回调 `onChunk`，视频下载的
  空闲计时和历史账号客户端的块数上限都走它；原来在 `ai-video-service.ts` 的 `raceAbort` 一起搬过来）。各处报错原样不变。
  共用版顺手补齐两处：声明长度超限时也把没读的响应体关掉；读到一半出错也关掉。历史账号客户端停了以后才回来的
  响应也会被关掉，不再留着一条没人读的连接。
- 主进程判断版本新旧只留一份比较：`electron/versions.ts` 的 `compareVersionNumbers` / `compareVersionsBy`，
  更新器（`updater.ts`）、上次运行记录（`installed-release.ts`）、Node 运行时与 Python 运行时的发布索引都改用它
  （#1073 第 3 条 b）。各处认什么写法照旧，分别是 `versions.ts` 里的 `parseUpdateVersion`、
  `parseInstalledReleaseVersion`、`parseNodeReleaseVersion`、`parsePythonReleaseVersion`，改动前先用测试把每一处
  的认法钉住（预发布号、前缀 v、空白、前导零、位数、超大数字）。Codex 桌面端的四段包版本比较
  （`codex-desktop.ts` 的 `compareWindowsPackageVersions`）在镜像和离线包那条链上，按 AGENTS 第 7 节不动。
- 对话记录导出成 Markdown 的写法只留一份：`codex-sessions.ts` 和 `provider-sessions.ts` 原先各抄一遍的
  落盘位置、文件名、开头几行、不完整标注和临时文件原子替换，收进新的 `session-markdown-export.ts`，
  两边只管找到记录、逐条读消息。导出的文件内容、默认文件名和报错一字不变，两边各加了逐字比对的测试钉住
  （#1073 第 4 条）。
- 服务器报错的清洗只留一份：`connection-check.ts` 的 `sanitizeUpstreamDetail` 和 `new-api-client.ts`
  的 `sanitizeUpstreamMessage` 逐字相同，合成 `command-runner.ts` 里紧挨 `redactCommandText` 的
  `sanitizeUpstreamDetail`（`redaction-patterns.ts` 不许有 import，放不进去）。主目录的各种写法也只列一份：
  `startup-log.ts` 的 `pathRootSpellings`，运行日志的 `redactHomeDirectory` 和诊断导出的
  `redactRootPaths` 都用它，运行日志因此也认出 `C:\/Users\/…` 这种转义斜杠写法。两边换成什么标签、
  路径边界怎么判照旧（#1073 第 5 条 a）。
- 运行日志、反馈报告、诊断导出和启动失败日志的脱敏补认 `cookie`、`credential` 两个名字（连同复数
  `cookies`、`credentials`）：`redaction-patterns.ts` 的 `redactSecretFields` 三条按名字认的规则（带双引号、
  带单引号、不带引号）都加上，跟崩溃报告原来就抹的一样。`Cookie:` 头另加一条：好几对 `名=值` 用 `; `
  连着时整串抹掉，原来那条遇到 `;` 就停，只抹得到第一对；`HttpOnly` 这类不带 `=` 的标记和后面的句子照旧
  留着（#1073 第 5 条 b）。
- 邮箱半遮（#1073 第 5 条 c）：`redaction-patterns.ts` 新增 `maskEmailAddresses`，把 `alice@qq.com` 写成
  `a***@qq.com`。只接在两处：`runtime-log.ts` 的 `safeText`（写盘、界面上的日志、读旧日志，还有反馈报告里
  运行环境、工具与配置、最近一次自检三段，都过它）和 `diagnostics.ts` 的 `createDiagnosticsExport`。没并进 `redactSecretPatterns` /
  `redactDiagnosticText`，因为渲染层报错和「检查」页结论也用它们，屏幕上的字不跟着变。崩溃报告原来整个抹成
  `[REDACTED_EMAIL]`，比半遮更严，不动。正则只在本地部分开头起配（向后断言），一长串没有 `@` 的字符只扫一遍；
  域名要以纯字母结尾，`@openai/codex@0.130.0-alpha.12` 这类版本号不受影响。
- 读 `.env` 某一行只留一份：`config-files.ts` 的 `readEnvValue` 改调 `tool-route-rewrite.ts` 的
  `readEnvLineValue`（原先逐字抄了一份），读出来的值不变，没有这一行照旧当空。后台计时只留一份：
  线路切换、系统代理复查、加速到期和中断提醒五处各抄的 `scheduleTimeout` 收进
  `schedule-timeout.ts`，几点触发不变；两个加速提醒原先没 `unref`，现在也跟着 `unref`，在主进程里
  不影响触发和退出。测试另钉住只此一份（#1073 第 6 条）。
- 发版校验自带的那份 Windows 系统目录解析（`scripts/windows-machine-paths.cjs`）和客户端那份
  （`electron/windows-machine-paths.ts`）有了对账测试 `scripts/windows-machine-paths.test.cjs`：同一组加载报告和
  系统设备路径回答喂给两份，SystemRoot、System32、系统 PowerShell 路径和「在不在 System32 里」的判断都要一样。
  两份实现都没改。唯一对不上的是核心模块路径里带 NUL 的边角（实际碰不到），记在 #1225，测试里那条先标 todo
  （#1073 第 7 条 a）。
- 新界面充值页里逐字相同的两份 `formatAmount`（`features/account/recharge.ts`、`topup-tier.ts`）收成
  `topup-tier.ts` 一份，套餐价、订单标题、档位到账金额照旧共用这一种写法（整数不带小数，其余两位小数，
  不加千分位）；改之前先用测试把三处在旧代码上的输出逐字钉住，显示一个字没变（#1073 第 8 条）。
- 渲染层剥「Error invoking remote method …」前缀收成一份 `src/renderer-v2/ipc-error-prefix.ts` 的 `stripIpcErrorPrefix`，错误框（`business-common.tsx`）、登录框（`features/auth/state.ts`）、账号读取（`features/app/account-read-error.ts`）都改调它（#1073 第9条）。画布宿主 `electron/canvas-preload.ts` 那份是 sandbox 下的有意副本，新加测试钉住两份正则逐字一致。
  典型报错剥完和以前一字不差，有测试钉住；唯一变了的一处：历史账号读余额时「系统里设置的代理连不上」以前说「请稍后重试」，现在跟星芒账号一样说「请检查网络后重试」（以前星芒账号是靠没剥掉的类名 NewApiNetworkError 才认出来，现在两边都按主进程那句现成的网络原因认）。
- `electron/claude-desktop-config.ts` 五笔写入（保存、开机修型号清单、换线路/换密钥、切官方登录、切回星芒）
  各抄一份的「读一遍、记下读到的」收成 `createFileSnapshots`，三处只改一个顶层字段的写法收成
  `setTopLevelField`，五处「超过文件大小上限」收成 `assertWithinSizeLimit`，剩下三处 `'3p'` 换成常量。
  写哪些文件、核对哪些文件、读的顺序、留的 .bak 和还原都不变；新测试先在旧代码上钉住五处交给提交的
  文件清单和读到的内容、切换登录方式的排版和写入大小上限（#1073 评论第 1 条）。
- #1073 评论第 2 条：首页命令行工具卡（含 Codex 桌面端）和 Claude Desktop 卡上「用哪个账号」菜单的字原来各抄一份，
  收进 `src/renderer-v2/features/tools/SourceMenu.tsx`：`buildSourceMenuItems` 出菜单各项（Codex 那句共用配置的小字按
  provider 加），`SourceMenu` 画来源牌和菜单，`sourceChipLabels` 是来源牌上的三种字（WorkBuddy、OpenCode 那块不可点的牌也用它）。
  `app-check.mjs` 新加一条浏览器用例，改前改后各跑一遍，两个菜单的每一项文字、说明、勾选、可点与否和读屏那句都一样。
- 没有新增或改动界面文字。
- 三把工具 Key 都在本机缓存里的老客户以前从不问服务端分组：站上删组、停组，或发布者改了服务状态文件里的分组对照，工具一直 403，首页照样「已连接」（#1074）。
  `account-cli-provisioner.ts` 现在三把都缓存时也查一次可用分组，一天一次（`isCachedGroupCheckDue`）；没查成隔 10 分钟再试，分组对照一改（`accountGroupHintsFingerprint`）当场重查；查不到照旧用缓存。
  查到了只听明说的（`movesFullyCachedKey`）：订阅、分组对照、出厂名照着换；另一套名单、按工具专属词认出来的只在缓存那把的分组已经不在列表里时才换。换了的照旧报 `regrouped`，开机恢复会给已连好的工具重写。
  没缓存全的那条路（以前就每次查分组）认法不变。
- 写配置前查模型被拒成 403「无权访问 X 分组」「分组 X 已被弃用」（new-api rc.40 `middleware/auth.go` 的 TokenAuth，`/v1/models` 也过这一道）不再直接报失败：跟 401 一样先查分组，认得出别的分组就换进去重签、写配置；认不出就照服务端原话报，不在同一个分组里白签一次。
- 换组以后删旧 Key（yoyo 10-17 定）：新 Key 写进这家工具（`saveConfig` 成功）以后才删，只删星芒签的（`xingmang-desktop-*` 或「用户名-分组」，`isManagedToolKeyName`），客户自己建的不碰；只删分组已经没了的那把（服务端不再列它，放哪儿都用不了），分组还在、只是对照改了的不删，同一账号另一台电脑可能还在用；历史账号不删（`retiresReplacedKey`）。
  动手前照服务端现在的样子再核一遍（`findAccountKeyById` 加一次可用分组）：这把还在、名字仍是星芒签的、所在分组确实不能用才删。站上删组前常先把 Key 挪到新分组下（`catalog.ts` 的 `retiredAccountGroups` 那回就是），本机记的老分组说明不了什么，Claude Desktop 那份拷贝可能还拿着它。
  要删哪把只记在内存里，按本机缓存那个对象分开：写配置失败、工具没装、软件中途关了、核不清都不删，旧那把留在账号里。删不掉不算这家工具配置失败。
  `ipc.ts` 给自动签 Key 的那层包装加了 `revokeKey`：删成、删不成各记一条运行日志，删成后照手动撤销那样清掉两份本机缓存里这把 Key 的条目。
- `managed-cli-groups.ts` 新增 `loadManagedCliGroupListing`，在原来的解析结果外再给出服务端列出的分组名；`loadManagedCliGroups` 改成包它一层，调用方不变。
- 充值页的「关闭支付窗口」改走 `paymentWindow.close()`，和点支付窗口右上角的 × 一样：付过款的订单关窗后照样在后台确认到账，到账后弹提示、刷新余额，历史账号买的订阅也照常把工具换到订阅分组的密钥。之前这颗按钮走的是 `destroy()`，把后台确认一起停了（#1075）。`destroy()` 只留给换账号、退出、关主窗口。
- 视频生成查进度时网络断一下、等回应超时、服务回 5xx / 408 / 429 / 网关页或中间哪一层的网页，不再整单判失败（#1076 的轮询那一半）：`electron/ai-video-service.ts` 的 `pollTask` 按原来的节奏接着查，连续查不到满 5 分钟（`maximumPollOutageMs`）才停，停下时本地任务记录照样留着、下次启动续查；只有 new-api 用 JSON 明确答复的 4xx（任务不存在、密钥失效、没权限）才当场停。原来一次 502 就让节点显示「请稍后重试」，客户照着重跑，按 new-api 源码是提交时预扣、失败才退，第一单生成成功就等于付两次钱。失败时的提示文案、前台放弃后在后台续查，留给 #1076 的另一半。
- #1077：AI 对话和命令行工具各用各的密钥，10-16 定的「对话加后缀、两边额度互不牵连」这回才真的生效。#1106 只改了新建时的名字，挑哪把来复用还是只看分组：对话默认分组正是 Codex 那组，第一次开对话就拿到 Codex 那把，`-对话` 那把签不出来；反过来工具缓存一丢也会复用同组更新、不限额的对话那把，绕过工具设的上限；客户在网页上自建的同组密钥也会被写进工具。
- `new-api-client.ts` 的 `findNewestUsableCliKeyByGroup` 多一个参数 `reusable`，只复用调用方认的名字：工具认它以前的固定名（`xingmang-desktop-*`、画图技能的 `xingmang-ai`）和「用户名-分组」，对话认新导出的 `isChatKeyName`（「用户名-分组-对话」、以前随机的 `xingmang-chat-*`、历史账号的 `xingmang-chat`）。网页上限了模型（`model_limits_enabled`）或限了 IP（`allow_ips` 非空）的也跳过：写进工具会直接用不了，撤销换新时本来也不照抄这两样。分组名很长、50 字节一截「-对话」就没了时（会跟同组工具那把同名），对话照旧用随机的 `xingmang-chat-*` 起名。
- `chat-credential-coordinator.ts`：本机对话缓存里那把的名字不是对话的（以前按分组复用拿到的工具那把），就不再用，按上面的规则签一把对话自己的，存回去顶掉这条。老客户网页的密钥列表会多一把「用户名-分组-对话」。工具缓存里如果存着以前复用来的对话那把，这次不动（少见，往后也不会再出现）。
- #1093 第 7 项：`ipc.ts` 里画图技能同步改用和工具那一轮同一层包装（`automaticProvisioning`），读不到撤销后待补的额度记录时不再另签一把不限额的 Codex 密钥。
- 历史账号买或停订阅、分组改名、Key 重签以后，那一轮写配置失败（拉型号时网络抖、写文件出错、写到一半关了软件）不再永远不补（#1079）。
  缓存里已经是新 Key、分组也对上了，下一轮主进程不再报「换了分组」，开机恢复以前就把这家当「已连好」跳过，工具拿着旧 Key 一直扣余额。
  `account-bootstrap.ts` 新增 `staleAccountKeys`：来源记录对得上（星芒替当前账号写的、之后没人动过）、配置里那把却不是本机缓存给它的那把
  （`configurationAccountMatched === false`）的工具，开机恢复也重写；这一轮同步没跑成、缓存没存上、缓存里没有这家时不认，免得缓存读不到就每次开机重写。
- 订阅开通后那一轮（App 的 `applySubscriptionToTools`，改由 `subscriptionSwitchResult` 定）：该换 Key 的工具没换成——写配置失败，或已连好的工具新 Key 没签下来——
  不再说「工具不用重新设置」，走已有的「订阅已开通，工具还没换过去」那条，带上首页同一句失败原因。`AccountBootstrapResult` 多一个可选字段 `keyChangeFailed`，
  `regrouped` 也算上这一轮补写的那几家。
- 备份页恢复配置后，「选了官方账号」的记号和 Claude Code 的官方 Console Key 跟着恢复出来的那份对齐
  （#1080）：恢复的是当前账号的中转配置，就清掉官方记号、把 `~/.claude.json` 的 `primaryApiKey`
  挪进快照（不挪它会以 `x-api-key` 顶掉中转的 Key，一用就是无效令牌）；恢复的是官方登录的样子，
  就记成官方、把快照里的 Console Key 放回去。别家中转、半截的、工具自己读不了的不动。新增
  `system-service.ts` 的 `restoredAccountSide` / `alignRestoredAccountSource`，`ipc.ts` 的
  `backups:restore` 在登记来源后调用，失败只记日志；切换失败的回滚照旧自己恢复这两样，不走这里。
- Windows、Linux 上用星芒账号从星芒打开 Claude Code 时，也像 Mac（#920，已知45）那样不把环境里的 `ANTHROPIC_API_KEY`、`CLAUDE_CONFIG_DIR` 交给它（#1081）：前者会多带 `x-api-key` 顶掉当前账号的 Key，后者让它整个不读星芒写的 `~/.claude`，原来只靠检查页提示，首页却显示正常。`electron/system-service.ts` 的 `launchExcludedEnvironmentVariables` 三个平台共用，Mac 的 `macosShellOverrideVariables` 直接复用它，Linux 交给已开着的命令窗口时脚本里照样再 unset 一次。客户系统里的设置一个字不动；用自己的 Claude 账号时照旧都带。检查页那条「待处理」照旧（客户自己开命令窗口直接跑时仍会绕开），没改字。
- Codex 桌面端离线包同步（`sync-chatgpt-official-cos`）的分块上传期限从默认 75 分钟改成 120 分钟，平台作业从 90 分钟改成 150 分钟。Windows ARM64 包约 1 GB，实测传到 COS 只有 190~290 KB/s，75 分钟传到约 850 MB 就中止，一出新版就失败（#1082）。只改这一条同步，Claude 官方包等别的同步照旧；不开 COS 全球加速。
- Codex「只更新」不再接管带别家凭据的 `model_providers` 表（#1083，yoyo 10-18 定「另起一张」）。以前 `codexRelayProviderFor`
  只要正在用的表名不是内置名就沿用它，`applyCodexRelayConfig` 只改 name / base_url / wire_api 等，`env_key`、
  `experimental_bearer_token`、`http_headers` 这些原样留着：地址换成星芒，请求带的还是别家的 Key。
  现在 `config-files.ts` 新增 `codexProviderCredentialKeys`（env_key、env_key_instructions、experimental_bearer_token、
  auth、gateway_oauth、aws、http_headers、env_http_headers、query_params），只更新时表里有任何一项就不接管，按原来的
  规矩另挑 `XingmangAI`、`XingmangAI-2`……，客户那张一个字不动；挑空名、认切官方留下的别名表、搬内置名下的老表也都跳过带凭据的。
  重置照旧沿用原名（模板整份重写，带不过去别家的设置）。
- 读回时正在用的表带着这几项，`matchesRelay` 判成 false：以前的版本已经接管过的那种（星芒地址 + 别家 env_key）
  首页不再显示「已配好」，改显示「不是当前账号的密钥」并给「改用当前账号」，点下去走上面那条就修好；
  换下架型号、刷型号菜单、补模板缺省项这些自动改写都不碰它（换线路只认来源记录，照旧只改地址）。
- 离线包同步脚本的失败原因不再一律记成 `operation-failed`（#1084）：Codex、Claude 桌面端和 Mac OpenCode 三份同步脚本自己的校验失败改带固定代码（`package-identity-mismatch`、`package-signature-invalid`、`version-regressed`、`inspector-failed` 等，定义在 `scripts/cos-sync-utils.cjs` 的 `CHECK_FAILURE_CODES`），日志里的 `failure.code` 就是原因；包的身份、版本、签名者这些公开信息对不上时，`failure.observed` 记下实际读到的值，检查程序失败时只记退出码、是否超时和脚本自己的固定报错，不记输出。告警 issue 里 Codex、Claude 桌面端的「影响」改成写明客户端第一路就从桶里下，删掉「一键安装不经过 COS」那句默认话。Windows 版 Grok 那份同样改带固定代码：签名状态无效 `package-signature-invalid`，签名有效但签名者或签发机构不在 xAI 两张证书的名单上记新加的 `package-signer-mismatch`，并在 `failure.observed` 里记下读到的签名状态、签名者和签发机构；PE 头芯片不符记 `package-identity-mismatch` 和读到的芯片；`verify-binary` 带上文件是从哪个官方地址下的（`sourceHost`）；x.ai 和 GCS 每个没通的地址各打一行 `source-attempt-failed`，以前只留最后一个地址的原因。
- #1085 后半：`launchCodexDesktop` 拆成两段，`launchThenWaitOutsideAccountWork` 只把发出启动请求为止的那段交给 `accountWork.run`；等窗口、注入中文仍在安装队列里（I11 不变），但不再算账号工作，换账号的 quiesce 不等它。这段里没等到窗口、要补连加速之前先问 `QueuedAccountWork.isCurrent()`：点「打开」以后换过账号或正在换，就不替上一个账号连加速，只照普通方式再开一次。
- #1085：`cli:launch` / `desktop:launch-codex` 不再在 IPC 层整段套 `accountWork.run`，改由处理函数拿 `accountWork.queue()` 交给安装队列：点下去时照旧核对账号没在切换，排队那段不算进 `whenIdle`，轮到它执行时才 `run`；排队期间换过账号就不执行（报现成的「账号上下文已变化，请重试」）。`main.ts` 的 quiesce 一开始调 `abortQueued()`，还在排队的打开经 `InstallationQueue` 的 signal 出队。开机照旧先等账号恢复完。
- 首页 `launchBusy` 只认命令行工具和 Codex 桌面端的打开；外接客户端那一行只看自己那家的打开（主进程里它们本来就不互等，I11 的登记例外）。
- #1088 评论补充：15 个工作流里的 `actions/checkout` 从 v4.3.0 换到 v7.0.1，`actions/setup-node` 从 v4.4.0 换到
  v7.1.0，两者都改用 Node 24 运行，不再每次报 Node 20 弃用。仍钉完整提交号，提交号从官方仓库的发布标签核对。别的 action、
  审批、environment、权限和触发条件都没动。setup-node 从 v5 起会在 `package.json` 写了 `packageManager` 时自己开 npm
  缓存，`scripts/ci-workflow-config.test.cjs` 加了一条门禁：哪个 setup-node 步骤没写 `package-manager-cache: false`，
  `package.json` 就不能出现这个字段，免得发版和同步任务悄悄带上缓存。
- #1088 评论补充（接 #1220）：工作流里剩下三个还跑在 Node 20 上的官方 action 也换了大版本，`actions/upload-artifact` v4.6.2
  → v7.0.2，`actions/download-artifact` v4.3.0 → v8.0.2，`actions/cache/restore`、`actions/cache/save` v4.3.0 → v6.1.0，
  都改用 Node 24。仍钉完整提交号，提交号从官方仓库的发布标签核对。download-artifact v8 起下载后核对摘要、对不上就报错，
  只按名字和 `pattern` 下载、都是打包上传的，不受它另外两处改动影响；它只在 `publish-release.yml` 里用，PR 上不跑，
  开 PR 前在本分支用一次性探测工作流照那几步真传真收核过，探测工作流已删。
- #1090 第 5 条：`quality.yml` 末尾加 `main-alert` 作业。推到 main 的运行完整跑完、`quality-gate` 没过（或它自己超时）时，
  由 `scripts/quality-main-alert.cjs` 开一条指派给仓库负责人的 issue，写明哪次运行、哪个提交、哪些作业红了；main 再红只
  改这一条，下一次在 main 上完整跑完并通过（重跑通过也算）就留言并关闭。被后来的合并取消的运行不算，取消策略本身不动；
  重跑一次旧运行时，main 上已有更新的运行出了结论就不改报警。只有这个作业有 `issues: write`，不读 secret、不装依赖；
  GitHub 客户端和 issue 列表与 `cos-sync-alert.cjs` 共用。
- #1090 第 5 条后续：`quality.yml` 的 concurrency 改成只在拉取请求上取消旧的那轮（`cancel-in-progress` 按事件判断），
  main 上开跑的运行不再被后来的合并取消。10-18 北京 12:45 以后合并大约五分半一次，main 上 89 轮全被下一次合并取消，
  十一个多小时没有一轮跑完，`main-alert` 一次都没真跑。现在 main 同时最多一轮在跑、一轮排着，跑着时再合进来的都并进
  排着的那一轮（GitHub 自动顶掉更早排着的），`changes` 开头那 10 分钟等待保留，让 main 的矩阵不连着跑。按 10-18 的
  合并节奏算，main 一天大约多用 1850 分钟跑道时间（macOS 约多 480 分钟），约占那天 quality 总量的一成；仓库公开，
  不计费，花的是和 PR 共用的并发跑道。
- #1090 评论补充（锁发布页）：`publish-release.yml` 收尾时 Release 已经在了，先查它的 `immutable`；接口明说锁了就不再
  `gh release upload`，给一条 `::warning::`，在运行摘要里列出这次没挂上发布页、只进了更新源的文件，写明要上发布页只能
  提升版本号。原来锁住以后补发另一个平台，会在更新源都换好之后报红。只有接口回 `true` 才算锁了，草稿（查这个地址是
  404）、查不了、不带这个字段都照原来那样传。新建 Release 那条路不改：`gh release create` 带着安装包时先建草稿、
  传完才发布，草稿不锁。`docs/RELEASING.md` 第 5 节补了一句。
- #1092 Codex 那半（照仓库装 Codex 的同一个来源，npm 上 `@openai/codex` 0.162.1 的 linux-x64 包，空 `HOME` 跑出来）：
  `codex mcp list --json` 在项目里跑，会把受信任的项目层（工作目录一路往上到 Git 根，每层的 `.codex/config.toml`；自己有
  `trust_level` 的看自己，没有的看 Git 根）和用户 config.toml、插件带的连接合在一起列，不带层，同名时项目那份盖过用户那份；
  `codex mcp add` 只写用户那份，`mcp remove` 只删用户那份，别的名字回「No MCP server named … found.」照样退出 0。
- `list` 跑 Codex 的 `mcp list --json` 时带工作目录；`placeCodexMcpServers` 对照文件分层：用户那份没有、项目文件里有的归
  project；两边都有的，只有列出来的跟用户那份一样、跟项目里的都不一样才算 user，其余（包括跟两边都一样、分不清的）算
  project。不在用户那份里的、算 project 的都 `operations.uninstall = false`，
  `mutationArgv` 收到 Codex 连接的 project 层直接拒。`registry/extensions.ts` 里 Codex 连接分「全局」「项目」两组。
  不往客户的项目文件里写，也不改 Codex 的信任设置。
- 工作目录不在了（删了、换了盘），Codex 和 Grok 列连接时就不带目录跑，不再整张列表报错（#1205 以后 Grok 会这样）。
- #1092（照仓库装 Grok 的同一个来源，npm 上 `@xai-official/grok` 1.0.52 与 1.0.62 的 linux-x64 包，空 `HOME` 跑出来）：
  `grok mcp add/remove` 有 `--scope user|project`，project 是命令所在目录的 `./.grok/config.toml`，`mcp list --json` 每条都带
  `scope`；`grok plugin install/uninstall/enable/disable/update` 都没有范围参数，装进 `~/.grok/installed-plugins/`、启停写
  `~/.grok/config.toml` 的 `[plugins]`，`plugin list --json` 不带 `scope`，项目里 `.grok/plugins/` 的插件它既不列也认不出。
- 外接工具：`mutate` 的 `projectBound` 加上 Grok 的 MCP（带 `cwd = repositoryRoot`，项目层没选工作目录先拦），以前不带目录，
  `--scope project` 写进了主进程自己的启动目录；`list` 跑 Grok 的 `mcp list --json` 时带同一个目录，`rawMcpFromJson` 收下
  `scope: user/project`，没带的按 Grok 的缺省 user 算；`registry/extensions.ts` 里 Grok 连接分「用户」「项目」两组。
- 插件：Grok 插件列表的缺省层标 user（以前是 null，界面上归进一组叫「未提供」的）；分组改成一组；添加表单不给「当前项目」
  （`extensionFormOffersProject`）；主进程收到 Grok 插件的非 user 层直接拒，不再悄悄装成全局。
- 历史账号「调用明细」的默认日期不再在第一次打开时定死（#1093 第 1 条）。以前 `AccountUsage.tsx` 用
  `useMemo(() => usageDateRange({}), [])` 算一次塞进 `filter`，页签只藏不卸、关窗只缩到托盘，第二天起刷新查的还是昨天那 7 天。
  现在 `filter` 只在用户自己选了日期时才带日期；没带时 `load` 每次按当时现算最近 7 个日历日，顺带把筛选框的默认值换成这份
  （选了日期的不换，免得没动的那一格跳到新日子、跟实际查的对不上）。「查询」时两格都清空，或本来跟着日子走、框里的默认没动过，
  就当没选；已经选过日期再改回跟停住的默认一样，仍算自己选的。`AccountFilters` 新增 `rollFilterDefaults`：默认值变了，
  还停在旧默认上的格子跟着换，用户改过的不动；新增可选的 `onReset`，历史账号「重置筛选」直接回到跟着日子走的默认。
- Claude Code 的 MCP 列表不再读 `~/.claude/settings.json` 和项目 `.claude/settings.json` 的 `mcpServers`（#1093 第 11 条）。
  官方设置项里没有这个键，MCP 只存在 `~/.claude.json`（用户层、本项目层）和项目的 `.mcp.json`；2.1.302 实测
  `mcp list`、`mcp get` 都不列这两份，`mcp remove` 不论哪一层都回「No MCP server named …」。以前 `readConfiguredMcpServers`
  把它们算成用户层、项目层，界面给了「移除」却删不掉；同名时后读的 settings.json 还在同一层盖住 `~/.claude.json` 里真正生效的那条，
  列表上显示的启动命令是 settings.json 里那份。现在只读 CLI 自己读的两处，两份 settings.json 原样不动。Gemini 那支不变。
- 对话流到一半的报错帧也认余额不足（#1093 第 12a 条）。对过 Sub2API（Wei-Shaw/sub2api 270eac6、b0a02a3）：流式请求等并发槽位超过
  10 秒时先回 200 和心跳，拿到槽位后再复查计费（`CheckBillingEligibility`、在途余额预留），余额不够只能在流里发
  `{"error":{"type":"billing_error","message":"insufficient balance"}}`，以前 `parsedDelta` 一律报「AI 服务暂时无法完成请求」。
  新增 `classifySub2apiBillingFailure` 只认这一帧，换成现成的 `relayQuotaFailureMessages.balance`，聊天页认得它、给「去充值」。
  只在历史账号站认（`createAiChatService` 新增可选 `backend`，`main.ts` 传 `definition.backend`）：new-api rc.45 预扣费在开流之前
  （`PrepareRequestBilling`），开流后只结算不报错，xm 站流里出现这句只可能是渠道上游原样转回来的。
- #1093 第 2 条：`features/account/AccountRecharge.tsx` 算价期间（`operation.busy === 'quote'`）把档位、金额、支付方式那个 fieldset 禁用；
  报价另加请求编号 `quoteRequest`，换档位、金额、渠道都加一，问价途中金额被换掉（停在充值页时从首页活动卡片又点了一档，不经过 fieldset）
  回来的那次报价丢掉，不弹确认框。以前回来就 `setQuote`，确认框和 `createAccountTopupPayment` 都照旧金额走。
- #1093 第 3 条：三个弹窗共用一个 `useOperation`，`openRedeem` / `openPurchase` 打开时先 `operation.clear()`；弹窗里的 `ResultNotice`
  只摆自己那个动作（`payment` / `redeem` / `subscribe`）的失败，先点的算价、存扣费顺序赶在弹窗开着时失败只上页头那条。
- `e2e/v2-business-fixture.tsx` 加 `topupQuoteHarness`（挂住下一次试算）、`pickRechargeTier`（模拟活动卡片点档）、`fail=redeem`。
- #1093 第 4 条：`features/account/usage.ts` 的 `usageRangeStart('1')` 从「现在往前 86400 秒」改成退到那一刻所在的整点。
  new-api 的 `quota_data` 只记到整点（`model/usedata.go` 的 `LogQuotaData`：`created_at - created_at % 3600`），
  `GetQuotaDataByUserId` 只回 `created_at >= start` 的行（rc.24、rc.44 与上游 main 一致）。起点落在 10:34 时，昨天 10 点那一行整个不回，
  10:34 到 11 点的花费看板上没有，按逐条时间查的调用明细却有。退到整点后两边查的是同一段，最长 25 小时，远低于上游
  `limitLogTimeRange` 默认 365 天的上限（「30 天」的调用明细本来就要一次查 30 天）。「7 天」「30 天」从本地零点起，不受影响。
- 同一处：`electron/new-api-client.ts` 的 `parseAccountDashboardData` 按小时分桶的跨度上限从 24 小时放到 25 小时。
  不放的话起点一退，跨度就过了 86400 秒，主进程改按天分桶，「24 小时」的柱状图只剩一两根（Codex 审查指出）。
  只有「24 小时」用桶画图，别处只取总数；「7 天」那几段每段不到一天，本来就是按小时。
- #1093 第 5 条坐实不成立：对 new-api rc.24、rc.40、rc.44、rc.45 和 main 源码核过，订阅单付成时 `CompleteSubscriptionOrder` 会往 `top_ups` 补一行同单号的成功记录（`amount` 记 0），客户端现有的按单号查充值表就能确认到账；没有给用户查订阅订单的接口，付成之前和过期的订阅单查不到。事实记进 `docs/RECON-new-api.md` C 节第 11 条，`electron/payment-status-reader.test.ts` 钉住这条路。
- 由此带出的界面问题在 `src/renderer-v2/features/account/recharge.ts` 修：按上游订阅单号前缀（`SUBUSR`、`sub_ref_`、`WAFFO_PANCAKE_SUB-`）认出星芒账号的订阅单，订单行标题、按单号搜不到时的空状态、订阅关窗后的两句提示各改一处。历史账号不按这个认。
- #1093 第 6 项：工具密钥被拒（401）重签后，`account-cli-provisioner.ts` 不再拿手上只有在用工具的那份整个存回缓存，改成照缓存现在的样子只换这一家的那条（新的顶层函数 `cacheReplacementKey`），下线工具 Gemini 以前签的那把和别处刚换好的条目都留着，跟同步那一轮保存的口径一致。
- 同一处的缓存读写改成尽力而为：拿掉失效那条、存新那条失败都不再让这家工具整个配置失败（以前会把「系统安全存储不可用」之类的缓存报错当成写配置失败，新签的那把也没写进工具）。存缓存前照样复核账号没换，换了照旧停下。
- #1093 第 8 条：`external-client-runtime.ts` 的 `scan()` 遇到正在跑的那一轮时，`force`（用户点「重新检测」）不再直接并进去，改成同 `fresh` 等它跑完再并进那之后起的一轮或另起一轮；同时等着的几次合成一轮。
- 装好、卸掉、打开之后（`invalidateScan`），之后来的普通读取也不再并进作废之前起跑的那一轮：在飞的那次记下起跑时的 `generation`，对不上就等它跑完再来。装完那次界面刷新、「确认连接」前读安装状态、打开后那次悄悄核对都受益。已经在等那一轮的照旧拿它的结果。
- #1093 第 9 条：扩展页卸载 Codex 技能以前只把目录挪进回收站，`config.toml` 里这个技能的 `[[skills.config]] { path, enabled = false }`
  留着，原样重新导入同一个（落在同一路径）一进来就是「已停用」。`codex-extensions.ts` 现在挪走以后删掉认到它头上的每一条记录
  （新的顶层函数 `removeSkillConfigEntries`，删空了连 `skills.config` 一起删）；导入前也清一次，旧版本卸载、手删目录留下的那条也不再
  带进来。先挪后删：挪不动时技能还在，客户关掉的不会被打开。技能已经不在，删记录失败不让卸载、导入报错，下次导入前还会再清。
- `codex-config-toml.ts` 的 `editTomlArrayTableText` 学会只删几条：剩下的原样不动时，把删掉的那几段 `[[...]]` 整段拿掉（表头到最后一个键，
  连同紧跟着的空行，后面写给下一张表的注释留着），客户的注释和排版不丢；又删又改照旧返回 null 整份重写，并留备份。
- 写 Key 前查模型被中转拒了时（主进程那句「模型查询失败，服务返回 401：无效的令牌」），错误框、页顶红条和新手引导以前被 `operation-error.ts` 里裸认 401 的那条归成「登录已过期，工具里已写入的 Key 还能用」，按钮叫人重新登录；new-api 对失效、被删、额度用到 0 的 Key 一律回这句，重新登录救不了（#1095）。现在这句交给 `relay-quota-failure.ts` 的 `relayQuotaFailureInMessage` 按状态码和原话重新归类，和对话、生图同一份认法：Key 失效给「Key 失效 → 一键修复」，钱包没钱给「余额已用完 → 马上充值」，Key 自己设的上限用完了不再被说成「余额已用完」或「请求太频繁」，原话自己说。
- 主进程那句话不改写，只把开头换成两边共用的常量 `modelProbeFailurePrefix`：`account-cli-provisioner.ts` 和 `chat-credential-coordinator.ts` 认这句里的「服务返回 401」自动换新 Key，改了措辞它们就不换了。
- 账号接口的 401 原话经 `new-api-messages.ts` 翻成「无权进行此操作，access token 无效」「访问令牌已过期」这类中文后不带 401，以前落成「操作没有完成」、读余额时只叫人稍后重试；现在归「登录已过期 → 重新登录」，`account-read-error.ts` 和错误框用同一份规则。
- Windows 上 .NET 的 `UnauthorizedAccessException`（文件拒绝访问）不再被 `unauthorized` 认成登录过期：错误框归「写不进安装目录 / 写不进配置文件」，`errorMessage` 落回通用兜底句，跟 `detectionFailureMessage` 一致。
- #1096：`electron/node-runtime.ts` 的 `errorText` 遇到 `runUacProcess` 按账号类型写好的两句
  （`windowsElevationCancelledMessage` / `windowsElevationDeniedMessage`）原样保留；换源循环认出这两整句就停；
  `describeNodeInstallFailure` 把「未获得管理员权限」也排进第一档（以前落到「原因已经记进运行日志」）。
  只认这两整句，不认 errorText 按「取消」「cancelled」猜出来的那句，免得网络错被当成客户拒绝、备用源轮不到。
  提权本身、可信路径、命令执行都没动。
- 渲染层 `operation-error.ts` 加 `elevationDeclined` 一类（排在 permission 前），`registry/errors.ts` 用
  「要你点头」A 组已批的字；新手引导 `StartGuide.tsx` 认出这一类后把原话后半截的下一步接在红字里，
  不再只折在「给客服看的原话」里。
- #1097 第 1 部分：装工具装到一半退出登录（或登录被结束），主进程照样装完，界面这时还拿点安装那一刻的会话
  去给原来那个账号同步 Key（`App.tsx` 的 `syncAfterToolInstalled`）。那一轮在 `assertAccount` 被「星芒账号已变化」
  拦下，失败那条路 `setWorkspaceEntered(true)`，客户站着的欢迎页被换成未登录的首页，运行日志里还多一条
  「账号 Key 初始化没有完成」。现在装完时账号作用域已经变了（退出或换了账号）就不跑这一轮，重新检测照旧；
  再登录同一个账号时登录那一轮会把装好的工具一起配上。
- issue 里推断的「那张卡永远『正在安装』、关窗一直被拦」实测不成立：`useToolbox` 的那个 effect 依赖变化时先跑
  清理、紧接着重跑会把 `active` 再置回真，`run` 的 finally 照样删掉任务。`app-check.mjs` 补了一条浏览器用例
  把整条路钉住：装到一半退出、欢迎页上装完、关窗不再被拦、欢迎页还在、再登录后卡片正常且 Grok 配上 Key。
- 自己点「退出登录」不再弹「当前登录已结束，请重新登录。」（#1098）。主进程退完就广播会话变化，
  还要清完星芒AI Skill 的密钥才回话，事件总比退出调用的返回先到；`App.tsx` 退出期间记一笔
  `voluntaryLogout`，个人中心概览和命令面板两个入口都经 `logoutVoluntarily` 退出（概览那颗按钮
  经 `pages-business.tsx` → `pages-account.tsx` → `AccountOverview.tsx` 的 `onLogout` 接过来）。
  改密码后被登出等真被结束的情况照旧提醒。测试夹具的 `logoutAccount` 照主进程先发会话事件，
  `app-check.mjs` 补两个入口都不提醒的用例。
- #1099 第 1 条取消那半（yoyo 2026-10-18 回「全部按推荐」，D 组那行的字照写）：新通道 `mcp:cancel-login`
  （`ipc-contract.ts`、`ipc.ts`、`preload.ts` 三处同加，入参照 `mcp:login` 用 `requiredString` 校验，服务里再过一遍
  `assertSimpleName`；运行日志名「取消 MCP 登录」）。`CodexExtensionService.loginMcpServer` 按名称登记一个
  `AbortController`，信号经 `CodexInvocationOptions.signal` 交给 `runCommand`，取消时连子进程一起停掉；被停下的那次
  登录照常回列表、不抛错，认的是这次登录自己的 `signal.aborted`，不认「命令已取消」这几个字。
- 扩展页等授权时「等你在浏览器里授权」右边出一颗「取消」（读屏名「停止等待 {名称} 授权」），停的时候写「正在停止」，
  停下以后按登录回来的列表说话：还没授权弹灰色小提示「已取消，{名称} 还没有授权」，刚好授权完了照旧「{名称} 已授权」。
  第 12 行（授权不占整页锁）没做。
- #1099 第 2 条：`pages-account.tsx` 的撤销弹窗传 `busy={operation.busy === 'revoke'}`，「取消」按钮执行中禁用，照同文件编辑弹窗的写法；`e2e/v2-business-fixture.tsx` 加 `revokeHold` 让撤销请求挂着，`v2-business.test.mjs` 钉住执行中「取消」、× 禁用、Esc 关不掉，放开后照常提示并关窗。
- #1101 第 1 条：`features/chat/state.ts` 的 `chatErrorMessage` 先过 `business-common` 的 `rawErrorMessage` 剥掉
  「Error invoking remote method '通道': 类名:」，以前取的是 `error.message` 原文，带 `^` 的那条放行规则认不出主进程的话。
  放行规则（`^请先|^当前对话|…`）挪到按字面猜的几条前面：「请先登录星芒账号」带「登录」两个字，光剥前缀还是会先被
  `/登录|密钥/` 改成「已失效」。「请勿重复提交」那条以前自己从第一个汉字截起来躲前缀，现在原话直接上屏。真失效
  （「登录已过期」、401）照旧归到「请重新登录」。
- 画布宿主桥剥掉 IPC 报错前缀（#1101 第 5 条）：`electron/canvas-preload.ts` 的每个 invoke 都走一个本地 `invoke` 包装，拒绝时把 Electron 包上的「Error invoking remote method '通道': 类名:」逐层剥净再交给画布，规则与 renderer-v2 的 `rawErrorMessage` 一致（sandbox preload 不能 import，照 I7 复制一份）。画布 `canvas-v2/` 里约 30 处 `setBanner(error.message)` 和节点上的错误一字没改，原样显示的就是主进程的中文原话；自动保存那份自己剥前缀的正则对已剥净的报错是空操作。#1101 的其余几条（对话剥前缀、上游 400/404 分类、Enter 键、生图尺寸误判、自动保存分开权限和磁盘满）不在这里。
- #1102 第 1~7 条、#1104 第 9 条、#1133 第 1、2、5、6 条、#1073 第 8 条 a、b（红队改字 B 组「叫法统一」，yoyo 2026-10-18 批）。逐字清单见 PR 正文。
- 连带改的代码：`operation-error.ts` 的 `configWritingActions` 按动作名认「这次写的是配置文件」，动作名收成常量 `rewriteKeyAction`（「重新写入密钥」），App.tsx 三处共用；`account-switch-sync.ts` 的来源小字收成 `accountSyncAccountReason` / `accountSyncManualReason`，`SavedAccounts.tsx` 的默认勾选按常量认，改字不会让切换账号时的工具变灰。
- 金额格式化收进 `business-common.tsx`：`dollars()` 带千分位、读不到写「—」，新导出 `quotaMoney()` 取代 AccountUsage、AccountRecharge、pages-account 三份逐字相同的副本；首页 `money()`、App.tsx 侧栏和状态栏两处内联、`lowBalanceText`、订阅提醒、近 7 天柱子悬停都改走 `dollars()`。主进程系统通知「花费突然变多」和托盘的金额写法没动。
- 新增 `ClockTime`（`formatClockTime` 加鼠标提示），用量明细和调用详情改用它；`.v2-usage-nowrap` 让时间、Token、花费三列不折行。
- 日期统一成不带空格的「10月3日」：`shortDate`、`spendDayTitle`、`usage.ts` 的 `monthDay`、`weekSpendHint`、主进程 `subscriptionEndDate`；「我的订阅」到期和 ChatGPT 额度弹窗的续订、恢复时间改照 `shortDate` 写，更新时间改用 `formatClockTime`。
- 主进程只改了客户看得到的句子（connection-check 的 nextStep、额度用完、撤销失败、托盘），设置值、日志里的名字和别的约 125 处带「Key」的报错原话这次没动。
- #1104 第 12 条：`features/shell/Shell.tsx` 的导览 `Coachmark` 只在 `activePage === 'home'` 时打开。以前引导走「去聊天」
  （`App.tsx` 的 `onComplete` 先 `setTourOpen(true)` 再 `navigate('chat')`）、「去充值」（落到个人中心充值页签）时导览开在别的页上，
  第二步找不到 `tool-row-claude`，退回侧栏 `nav-home`，却念「点左下角的账号标签」，左下角正好是侧栏账号卡。没照修复队列写的
  「第 2 步前先切回首页」做：那样会把刚点了「去聊天」「去充值」的客户从那一页拽回首页。导览状态（待看 / 看过）和三步文字都没动。
- #1104 第 13 条：运行日志那条操作（`features/shell/command-search.ts`）和「反馈与客服」页（`registry/pages.ts`）的搜索说法加「安装记录」；设置里主题那一行（`registry/business.ts`）和两条切换深浅色的操作加「黑金深色」「晨曦金浅色」，搜「黑金」「晨曦」按包含命中。只是搜索词，界面上不显示。
- #1104 第 3 条：`App.tsx` 的 `launch:<工具>` 任务从点下去那一刻就挂上（新的 `holdLaunch`），读配置、核对默认模型、选文件夹、
  Codex 桌面端查运行状态和问中文都算在里面。以前要等 `prepareToolLaunch` 和选文件夹走完才挂，这几秒卡片没变化，再点又被
  `launchRequest` 静默挡掉。`toolbox.run` 同一个 key 只放一个，所以只在最外层挂一次：`requestLaunch` 和 `launch()` 各挂一次，
  里面的步骤抽成不挂任务的 `openTool()`，`launchRemembered` 也改走它。没加新字，挂的是现成的「正在打开工具」（`launchWaitLabel`）。
  准备到一半换了账号，`cancelPendingLaunchDialogs` 当场放掉这一次（`preparingLaunches`），卡片不陪旧账号那一次等完、新账号的「打开」
  也不被它的锁挡住；主进程已经开始打开的（`toolsApi.launch` 之后）照旧等它做完。记录页「接着聊」自己调 `prepareToolLaunch`，不经这里，不受影响。
- #1104 第 4 条：`features/chat/ChatPage.tsx` 的 `reload` 读出 `loaded.warning` 时把它交回去，`reloadHistory`
  照 App.tsx 断网重试的先例弹一条 `warn` 提示，以前直接 `return`，红条和按钮原样不变，只看到按钮转了一下。
- #1104 第 5 条：App.tsx 的 `pageLoading` 挪进 `features/app/PageLoading.tsx`，聊天页读记录时在
  `section[data-loading]` 里渲染它；`chat.css` 让加载中的 `.chat-page` 不按两栏排，跟 Suspense 那块摆在同一处，
  先等代码再等记录时转圈不跳位置。聊天浏览器用例加读记录卡住（`historyReadHold`）一条，重读失败那条补提示断言。
- #1104 第 8 条：`ToolKeyLimits.tsx` 读密钥失败时给 `ResultNotice` 传 `retry`（「重新加载」，调 `resource.reload()`），
  照 `AccountOverview.tsx` 我的订阅、`pages-account.tsx` 资料读不到那两处现成写法，不新增字。保存上限失败那条不给，
  改的数还在格子里，再点「保存」就是重试。读到过「一个工具都没配」、页头刷新又没读到时不再收成那行灰字，照常出卡片，
  红条和「重新加载」才看得见。浏览器用例 `e2e/v2-business.test.mjs` 两种都走了一遍。
- #1112 顺带那条（P3，放宽，yoyo 10-20 17:41 北京回「四条都放」）：`claude-desktop-config.ts` 的 `useGatewayLogin`
  原来只认地址等于当前线路的星芒那份，官方登录期间换过线路（换线路那边不碰官方登录的那份，`inspectOwnedRoute`
  见了 `1p` 就不认）就回 `reconnect`，要重新保存一遍。现在多收一张 `otherRouteBaseUrls`（调用方给这个站登记过的
  全部线路地址，别名也算，`relaySiteProviderBaseUrlVariants`），落在其中哪条上都认；归属按那条线路的地址核
  （回调多带一个 `baseUrl`）。不在当前线路上的，同一笔两阶段提交先把网关地址换成当前线路（照 `followRoute`
  的写法只改这一个字段、排版不动），再把 `deploymentMode` 改回 `3p`；回 `moved`（原来的地址和那把 Key，主进程内部
  专用，I3），`external-client-route-service.ts` 的 `switchExternalClientSource` 拿它把归属 `rewrite` 到当前线路。
  归属没记上只记一行 warn、切换照算成功，下次检测换线路那边的 `external-client.route.recorded` 补记。
- 没放的：地址不是这个站登记过的线路、归属不是当前账号（包括换线路以后客户端又把旧的那份写了回来、归属已经在新
  地址上的）照旧回 `reconnect`，一个字不写。切换不联网、不查新线路认不认这把 Key：同一个站的几条线路通的是同一个
  后端。Claude Desktop 开着也照写，和原来这时回 `reconnect`、客户重新保存写的是同一个文件、同一个地址；开着时写了
  会不会被它退出时写回去，是 #1112 主条，等真机。
- 日志 `external-client.source-switched` 换过线路的多一个 `from`（线路编号，不记地址）。
- Claude Desktop 跟着 Claude Code 换 Key（#1113 第 1、2、4 条）：星芒替 Claude Code 换了 Key（个人中心撤销后换新、
  失效重签、换组，包括历史账号买了订阅换进订阅分组）以后，Claude Desktop 那份只换 Key，地址、型号和别的设置都不动
  （`claude-desktop-config.ts` 的 `followKey`，和 `followRoute` 共用 `editOwnedGateway` 那一笔写）。
  `system-service.ts`：Claude Code 以账号来源保存、Key 变了，马上看一眼（`saveConfig` 末尾）；平时的客户端检测也看
  （`followExternalClientRoutes`，换线路之后），所以星芒中途关了、下次开机照样补上。
- 全都对上才换：Claude Code 现在用的就是托管 Key 缓存里眼下那把；Claude Desktop 正在用的是星芒那份；它那把是缓存
  记着「被换掉」的 Claude Code 旧 Key（#1158 的 `replacedKeyDigests`）；归属是当前账号、地址是这个站的线路；
  不是客户自己填的；新 Key 认它写着的型号（没写型号的不查）。
- `external-client-ownership.ts` 的归属记录多记来源 `source`（`configured` / `account` / `manual`，配置弹窗选的那种）。
  客户自己填的（`manual`）不跟；0.2.20 以前保存的没记来源，凭「就是 Claude Code 换下来的那把」认。换线路、换 Key
  改写归属时照旧记着原来的来源（`rewrite`）。换 Key 先 `stageKey` 记下新那把再改客户端，改完才挪成正式那一把，
  中间断了两把都认，不会让客户端换上了新 Key、首页却不认它。
- Claude Desktop 开着就先不写，等它退出再换：沿用换线路 C11 那套每 5 分钟看一眼、回到星芒窗口时看一眼，两个站都等；
  这次界面上不加字，卡上提示下一个 PR 加。
- `main.ts` 把当前账号的托管 Key 缓存交给系统服务（`readCurrentManagedCliKeys`），明文只在主进程里用（I3）。
- 没做：WorkBuddy、OpenCode 借别的工具的 Key 时还不跟着换，下一个 PR 做。
- #1113 收尾：跟着换 Key 从 Claude Desktop 推广到 WorkBuddy、OpenCode，借的是哪个工具的都跟（`system-service.ts` 的
  `managedKeyFollowTarget` 交出所有换过 Key、自己也换上了缓存里那把的工具，`followExternalClientKey` 按「客户端那把是谁换下来的」
  对上）。WorkBuddy、OpenCode 那一笔写是 `external-tool-config.ts` 的 `followExternalToolKey`，和换线路共用 OpenCode 那段
  「改最后定义它的那个文件」（`openCodeFieldPlans`）。
- 客户端开着、等它退出再换 Key 的那一行带 `keyPending`（`external-client-contract.ts`），首页显示
  「还开着，完全退出后会自动换上新密钥」；跟换线路那句一样不落盘（`external-client-snapshot-cache.ts`）。
- `saveConfig` 末尾的「马上看一次」从只看 Claude Code 改成任何工具以账号来源保存、Key 变了都看。
- 发版手册补三条规矩（`docs/RELEASING.md`，10-18 定）：§3 加 Electron 不能落后同一大版本最新版超过 2 周，
  给了查法，落后了要么先升、要么在分片里写明不升的原因（#1088 第 3 条）；§5 新增「服务端要做旧版本不认的改动时」：
  能提前约的等新版本在 update-feed-stats 里过八成、设好最低版本再动服务端（#1114 第 1 条），服务端已经先改了的
  当天全部放开、同时设最低版本，但先在测试电脑上用手动检查演一遍旧版升新版（#1114 第 2 条）。
- §8 回滚表加「设过最低版本时」一列：低于最低版本的电脑不受放量限制，最低版本就是坏版本时「放量停住」谁也停不住；
  撤回、退回时把最低版本一起改成 `none`，免得低于它的电脑每次检查都先被「必须更新」挡一下（#1114 第 4 条）。
- 未签名通道的说法改对（#1090 第 2 条）：RELEASING §3、README、`docs/WINDOWS-VERIFY-RUNBOOK.md` §4.1 原来都写
  「用户确认式更新」，2026-09-25 起这条通道已经跟着「自动更新」开关走（`electron/main.ts` 的 `unsignedAutoUpdate: true`）。
  停用的 `release-build.yml` 开头那句同样过时，这次不改工作流文件。
- `docs/SERVICE-STATUS.md`「强制更新」和 `docs/LINUX.md` 原来说「打开下载页」开的是 GitHub 上的发布页，
  代码里开的是安装教程页（`electron/app-download-page.ts`），两处改对。
- service-status 工作流在等批准之前先跑一段 `preview`（#1114 第 3 条）：照这次填的、按现在线上那一份算出「批了以后状态文件是什么样」，写进运行页面的摘要。release 环境的批准发生在 `publish` 开跑之前，以前批的人点批准时看不到这次要改成什么。
  `preview` 不挂环境、不引用 secret、权限照全局只有 `contents: read`，只读客户端也在读的公开状态文件和更新清单，算出来的文件不上传；读线上的三步与 `publish` 一字不差（`scripts/service-status.test.cjs` 钉住）。`publish` 改成 `needs: preview`，环境、并发组、上传步骤不变；填错了在 `preview` 就红，不用白批一次。
- `scripts/service-status.cjs` 两种情况多打一行 `::warning::`、摘要里也写，不拦：这次改的最低版本，包出来不满 24 小时（按线上 `latest*.yml` 的 `releaseDate` 算，工作流新传 `--published-dates`）；同一次运行既清掉还没全放开的分批放量、又改了最低版本。0.2.19 就是发出去 12 分钟时一次运行两样都做了。最低版本原样重填或填 `none` 不提示。
- 「要你点头.md」C 组（yoyo 10-18 14:07「你自己判断和决定」，按推荐：状态牌写 3 个字）：`registry/status.ts` 五个 `statuses.tool` 改短，
  教程「首页和打开文件夹时」和首页大卡那行跟着变；测试里写死的原文换成新字，「出现 0 次」那几条也换成新字才有意义。
- #1067 文案：同意框和配置窗口那两句从「只有这台电脑自己能连」改成照实说同机其他程序和账户也能连；v4 原型同一句一起改。
- #1104 第 7 条：`Home.tsx` 写密钥进度在没有要写的工具时换成「正在准备账号密钥」。
- #1097 第 2 部分：`launch-notice.ts` 新增 `logoutJobsNote`，个人中心（经 `BusinessPage` → `AccountPage` → `AccountOverview` 的可选 `logoutNote`）
  和命令面板两个退出登录确认框只在有安装、卸载任务时补一句；不算的任务前缀和「打开」排队那份是同一张表。v4 README 那条跟着改。
- #1111 第 1 条：`switchExternalSource` 拿到 `reconnect` 时先弹一条 neutral 提示再开连接框。
- #1111 第 3 条：首页「接着上次」和「接着之前的对话…」窗口在 `resumeStillLatest` 不成立时留一行 `role="status"`（`recentReplacedHint`），再点「接着聊」清掉。
- #1091：`chooseAiOutputRoot` 新增可选的 `earlierWorksLeftInSyncedDocuments`（`'onedrive' | 'icloud'`）：作品一开始就放主目录下、
  而「文档/XingmangAI」（按账号那一套位置）还有 `user-*` 文件夹时记下；检查页 AI_OUTPUT 那一行按平台说「文档」或「文稿」，启动时记一行 info 日志。
- #1132 第 1a、2、3 条：`.xm-tool-card-actions` 改成 `flex: none`（只在长到连牌子 64px 都留不下时才轮到按钮省略），
  底栏状态牌的字包一层带 `title` 的 span 才有省略号；`.v2-tool-external-note` 加 `max-width: 100%`；
  工具卡主按钮的下载图标条件加 `!tool.error`。`app-check.mjs` 补一条 1280 与 1067 窗口下按钮不被截的断言。
  第 1b 条（底栏状态牌换短说法）要改字，没做。
- #1133 第 3 条：状态栏 `.v2-status-user` 加 `min-width: 0; max-width: 220px`（照 v4 原型 `.st-user`）和
  `flex-shrink: 100`（让它先于同样能缩的网络位置让位），里面的 span 省略；按钮带 `title` 和 `data-testid="statusbar-user"`。
- #1133 第 4 条：`@media (max-height: 659px)` 里补 `.sidebar-collapsed` 的规则：图标行 28、分组线上下 4、
  标志行 28、钉住区和账号卡空隙收小。110% 缩放最小窗口（970×566）下 Windows 原来差 36px、Mac 差 68px，
  Mac 在 100% 的最小窗口（1067×622）下原来也差 12px，现在都不滚。`app-fixture.tsx` 加 `?longUsername`，
  `app-check.mjs` 补一条 Windows、Mac 两种外观下的断言。
- #1133 第 7 条：`.xm-row-title` 改成可换行（`flex-wrap: wrap`、`overflow-wrap: anywhere`），一行放不下时牌子换到标题下一行，
  不能断行的长标题也照样折行；行标题里的牌子最宽一整行，字包一层带 `title` 的 span 才有省略号（密钥分组牌、备份行
  「账号 xxx 的密钥」）。调用详情的模型名牌能缩、带 `title`；充值的支付方式名单行省略，`title` 挂在整张卡上（卡上盖着透明单选框）。
  正常长度的数据改前改后逐像素一致。`v2-business` 夹具加 `longNames`，补一条三处都不出框的浏览器用例。
- 删掉关窗「先问界面」旧握手的残留（#1140 第 1 条）：关窗早就只走主进程的原生对话框（`window-lifecycle.ts`），
  `main.ts` 从不发 `window:close-request`，也没给 `ipc.ts` 接 `replyWindowClose`，`window:close-report` 恒返回 false。
  这一对通道从 `ipc-contract.ts`、`ipc.ts`、`preload.ts` 删掉，连同 `electron/window-close-query.ts` 及其测试、
  renderer-v2 `main.tsx` 和 `App.tsx` 的两处监听、legacy `src/App.tsx` 那一处监听（契约变了两棵树都得跟着编译，T14 允许）、
  夹具和只为它写的用例。`data-renderer-ready` 标记照旧（`e2e/macos-visual-qa.mjs` 靠它判断界面就绪），改成单独一个
  effect；`renderer-v2-native-close-race.mjs` 和 `window-close-smoke.mjs` 按字符串拦 `window:close-request` 的守卫保留。
  关窗行为不变。
- 删掉 6 个只有自己的测试在用、生产代码从不引用的模块：`electron/canvas-account-lifecycle.ts`（账号切换的取消与初始化
  早已直接写在 `main.ts` 里）、`electron/platform/facade.ts` / `registry.ts` / `index.ts`（渲染层的平台能力走
  `platform:get-capabilities`），以及 renderer-v2 的两个桶文件 `src/renderer-v2/index.ts`、`src/renderer-v2/registry/index.ts`；
  `electron/platform/types.ts` 只留 `zoom.ts` 还在用的 `UiScalePreference`，模块地图同步（#1140 第 2 条）。
- 删掉 `electron/account-session-store.ts` 里只剩测试在用的 `restoreAccountSessionOnStartup`：开机恢复登录早已改成
  `realm-account-service.ts` 的 `restoreActive`，这个老文件只在第一次升级时读一次做迁移。`ipc.ts`、`ipc.test.ts`、
  `new-api-client.ts` 里按它写的注释改成现在的走法，模块地图同步（#1140 第 2 条补充）。
- `relay-backend.ts`、`relay-sites.ts` 的过时注释改掉（#1140 第 3 条）：账号接口现在有两个实现，星芒账号走
  `new-api-client.ts`，历史账号走 `sub2api-relay-backend.ts`；「四个 CLI」改成按 `ProviderId` 说；开机恢复登录
  不再指向已经没人调用的 `restoreAccountSessionOnStartup`，改成 `realm-account-service.ts`。
- 删掉线路表 `RelayEndpoint` 里没人读的 `label` 字段（#1140 第 6 条），它的值还是「默认线路」「备用直连」旧叫法；
  界面上的线路名照旧来自 `registry/connection-routes.ts`，设置值和日志名不变。
- 新增 `scripts/verify-drama-parse-parity.test.cjs`，逐字钉住 `electron/` 与 `canvas-v2/src/library/` 下
  `drama-model.ts`、`drama-parse.ts`、`drama-parse-prompt.ts` 三对副本：主进程解析模型回复后存成节点输出，
  画布再用自己那份解析一遍弹确认框，两份分叉会让主进程判成功的表在画布报「结果无法转成四表」。另钉住这三份
  只互相 import，以及主进程与画布之间不再出现没登记的逐字副本（#1140 第 4 条）。只加测试，两边源码未改。
- `electron/windows-store-app-launch.ts` 改名 `windows-store-availability.ts`（测试文件同步改名，选项类型
  `WindowsStoreAppLaunchProbeOptions` 改成 `WindowsStoreAvailabilityProbeOptions`）：2026-10-02 撤掉账户探测后它只剩
  「这台电脑有没有微软商店」一件事，旧名说的「启动商店应用」早已不是它做的。`codex-desktop-service.ts` 的 import、
  `codex-desktop-service.ts` / `diagnostics.ts` 里指向它的注释、`e2e/windows-powershell-probes-smoke.mjs` 和模块地图跟着改；
  里面的 PowerShell 脚本和执行逻辑一行没动（#1140 第 5 条）。
- `removeUninstallLeftovers` 在 Windows 上对删除被拒（`delete-failed` 且 EBUSY / EPERM / EACCES）的那几个，按 100、200、400、800、1500 毫秒等一下再试（前后约 3 秒），每次都把目录、文件身份、链接文本那几项核对从头做一遍，不只是重试 unlink；macOS / Linux 不等。起因是 Windows 测试「卸开着的 Claude Code，关掉后删掉 claude.exe」偶发 EBUSY 红：进程的 `exit` 到了以后，Windows 偶尔还要一小会儿才放开它跑过的文件（推断是杀毒软件在扫），客户关掉马上点清理也会撞上。那条测试的断言一字未改，关掉后照旧只调一次清理（#1152）。工具真还开着时，「帮我清理」要晚约 3 秒才回「还有文件没删掉」。
- 开机补写（#1079）不再把客户在密钥页「写进工具」、配置窗口选的那把账号密钥换回自动那把（#1153，#1142 还没发版）。
  以前 `staleAccountKeys` 只看「配置里那把不是缓存里眼下那把」（`configurationAccountMatched === false`），客户点名写的那把同样满足，
  于是每次开机、联网补跑、「自动」换了线路、开通订阅后那一轮都被悄悄改成自动签的那把。
  改成只认缓存以前给这家工具、后来换掉的那把：`managed-cli-key-store.ts` 保存时自己比出每家被换掉、被拿掉的托管 Key，
  在账号记录里多记 `replacedKeys`（sha256 指纹，新的在前，每家最多 3 条，不存旧 Key 本身）；读出来时附在条目的 `replacedKeyDigests` 上，
  配置摘要据此给 `configurationKeyReplaced`，`staleAccountKeys` 改认它。认不出的历史条目读的时候丢掉，不把整份缓存当坏的挪走。
  0.2.20 以前就已经换掉、没写进配置的那把没有指纹，这一类仍旧不补（和 0.2.19 一样）；0.2.20 起换的都补。
- 开机自动换下架型号不再整份合并重写工具配置，只改型号那几处，文件其余字节原样（#1154 第 4 条）。以前 `tool-model-check.ts`
  的 `replaceRetiredModel` 借 `refreshPicker` 走 `saveConfig` 的 merge，模板里的每一项都按当前版本重写一遍：Codex 客户自己定的
  `review_model` 被换成新型号，Grok 指去别处的 `endpoints.xai_api_base_url` 被指回中转，Claude Code 删掉的 deny 项被补回，
  TOML 注释、JSON 缩进全冲掉。现在交给新的 `replaceModel` 依赖（`system-service.ts` 的 `replaceToolModel`），由
  `config-files.ts` 的 `planProviderModelReplace` / `applyProviderModelReplace` 定点改写，做法同换线路（`tool-route-rewrite.ts`）。
- 跟着改的只有本来就跟着型号走的：Codex 的 `review_model` 等于旧型号才换、`supports_websockets` 正好是旧型号该写的值才翻
  （同 `followCodexRelayWebsockets`，没写的不补）；Claude Code 的 `env.ANTHROPIC_DEFAULT_MODEL` 等于旧型号才换。Codex 配置本来就指着
  本软件的型号名单时，名单文件按新型号一起重写，先落盘、替换前原文变了就整个退回；该补上或收回那一行的这次不动，下次核对菜单时再说。
  Claude Code 的 /model 菜单也留到打开前那次核对再刷。
- 闸照自动写入那道：只认当前账号写的、没选官方账号的，写之前再核一遍账号、配置没变、账号确实能用新型号。来源记录不动：它认的是
  路径、地址和 Key，型号不在里面，换完照旧是「当前账号」，模板版本号也不跟着变。
- `tool-route-rewrite.ts` 加了 `rewriteTomlValues` / `readTomlBoolean`，能换开关值；原来的 `rewriteTomlStrings` 不变。
- 没改的：客户用 /model 自己选的型号要是也在下架名单上、账号也不再列它，照旧会换成同系列的（来源记录分不出型号是谁选的）；
  打开前刷新菜单那条（`refreshPicker`）照旧整份合并。
- 服务状态文件里的型号表（`cliModels`）也记到本地了（#1154 第 6 条）。以前它只在内存里：下架型号的替换只在开机那轮做，
  网差的电脑开机第一下没读到状态文件，这一轮就整轮按程序自带的表走，远端加的下架名单要等哪次开机第一下正好读成功才生效。
  现在每次读成功都记进数据目录的 `cli-model-hints.json`（新的 `electron/cli-model-hints-store.ts`，读写走 `safe-local-data`，
  读回来用状态文件同一个解析器 `parseCliModelHints` 重新校验），这次打开以后一次也没读成功过时用它。读成功、里面没写型号表的那次
  记成没有，发布者撤掉型号表以后读不到文件的电脑不会一直按老的那份走。跟上次一样的不再写盘。
- 用到型号表的几处都跟着：开机换下架型号、按账号刷新 Codex 型号名单、登录自动配置挑默认型号、打开前劝换。`main.ts` 的
  `readCliModelHints` 改由 `resolveCliModelHints` 决定用哪份。
- 没做的：状态文件这次开机后才第一次读成功时，不补跑一次替换，照旧等下次开机（或打开前那一问）。
- 配置窗口挑默认型号也看服务状态文件里的型号表了（#1154 附录，#1059 残留）。以前只有登录自动配置看它：远端换了默认，
  从配置窗口给没设型号的工具配，预选的照旧是程序自带的默认，检测完替他挑、保存后核对也不看远端的上一代和下架名单。
  现在新加只读通道 `tools:cli-model-hints`（不带入参，读不到给 null，不进账号那道闸），`ConfigDialog.tsx` 打开时读一次，
  预选用 `cli-model-defaults.ts` 新的 `resolveCliModelDefault`，`resolveDefaultCliModel` 两处都带上型号表。读到之前、读不到照旧用自带的。
- Codex「换用别家模型」（`OtherModelsDialog.tsx`）里那条「Codex 默认」也跟着型号表走，跟模型列表一起读。
- AI 对话的默认文字型号 `gpt-5.6-sol` 不在分组里（下架了）时，改挑同系列版本最新的（新的 `resolveDefaultChatModel` /
  `resolveNewestModelOfFamily`），不再按字母序退到第一个（以前 `gpt-5.4` 排在 `gpt-6.1-sol` 前面）。同系列也没有才照旧取第一个；
  图片模式不变。`gpt-5.6-sol` 还列着时什么都不变。
- 没改的：主进程画布执行器生图分组为空时兜底写死 `'图片模型'`（`canvas-node-executors.ts`）。画布运行前已经拦下没选生图分组的
  情况（`canvas-v2/src/runtime/run-preflight.ts` 的 `canvasMediaConfigurationErrors`），这句兜底正常走不到；要改只能改成报错，得新加一句提示。
  连接自检在工具配置里没写型号时用自带默认（`connection-check.ts`）也没接型号表。
- 挑默认型号时，默认、上一代都不在账号列表里，Claude Code 和 Grok 不再拿按字母排的第一个（#1154 第 1 条）：`electron/cli-model-defaults.ts`
  的 `resolveDefaultCliModel` 先在原来那个型号的系列里挑（Sonnet 换 Sonnet），再在默认、上一代的系列里挑，同系列取版本最新的；
  还挑不到时 Claude 按 Opus > Sonnet > Haiku，Grok 照旧取第一个。新配工具、打开前劝换、配置窗口预选都走这条。Codex 的兜底不变。
- 开机自动换下架型号改用新的 `resolveRetiredCliModelReplacement`：那是不问客户直接写，Claude Code、Grok 只换成默认、上一代或同系列的，
  只剩别的系列（比如只有 Sonnet、Haiku 的分组里换掉下架的 Opus）这次不换，记一条 `tool-models.retired-kept`，留给打开前那一问让客户点。
  Codex 照 0.2.19 起换 gpt-5.5 的老规矩。
- 打开前劝换（`tool-model-check.ts` 的 `check`）把配置里原来那个型号交进去，劝换也先留在它的系列里。
- Claude Desktop 检测完预选型号（`external-client-defaults.ts` 的 `detectedClientModel`）改用同一套挑法：「保存并检测」以前会按字母序
  直接存成 Haiku，现在是 Claude Code 的默认，没有默认时 Opus > Sonnet > Haiku（#1154 附录，#1059 残留）。
- 开机按账号刷新 Codex 型号名单、换下架型号时，写之前再看一眼 Codex 命令行和桌面端开没开，开着或看不出就这次不写，
  和 Claude Code、Grok 那条一样（#1154 第 5 条）。`syncPicker` 的 `beforeRefresh` 可以是异步的。
- 打开前、开机核对刷新型号菜单不再整份合并重写工具配置，只改菜单那几处，文件其余字节原样（#1154 后续，#1165 留下的那条）。
  以前 `system-service.ts` 的 `refreshPicker` 走 `saveConfig` 的 merge：账号的型号一变，Codex 客户自己定的 `review_model`
  被改回主型号，打开的 `check_for_update_on_startup` 被关回去，注释冲掉；Claude Code 放开的 Artifact、DesignSync 被补回 deny，
  另指的 `env.ANTHROPIC_DEFAULT_MODEL` 被改回当前型号，缩进改成两格。现在交给新的 `refreshToolPicker`，由 `config-files.ts` 的
  `planProviderPickerRefresh` / `applyProviderPickerRefresh` 定点改写，闸同 `replaceToolModel`，来源记录、模板版本号都不动。
- 改的只有菜单本身。Codex：型号名单文件按 `resolveCodexModelCatalog` 重写；`config.toml` 里本软件那一行该有却没有就补在第一张表前
  最后一个键后面（读回来必须恰好只多这一个键，不然退到第一张表前、文件开头再试），不该有就按行收回，客户自己指向别处的不动；
  只重写名单时配置文件不碰，也不多一份备份。Claude Code：`modelPicker` 没写过或是本软件写的才换，用 jsonc-parser 按原来的缩进改，
  改完整份再读一遍比对，同一个键写两遍这类对不上的一个字不动。
- 「Default」那一行（`env.ANTHROPIC_DEFAULT_MODEL`）改成只在没写时补，写了别的型号不跟着改，同开机换下架型号（#1154 第 4 条）；
  `claude-model-picker.ts` 的判断收进新的 `claudeRelayModelPickerUpdates`，`claudeRelayModelPickerOutdated` 跟着它走。客户用 /model
  换了型号以后，「Default」不再在第二天自己跟过去。保存配置照旧把它写成当前型号。
- 定点改写的落盘（`commitProviderRewrite`）换型号、刷新菜单共用；每替换一个文件前都核一遍配置原文没变，变了整个退回。
- `dl-landing/app.js` 的 `DOWNLOAD_GUIDE_URL` 从飞书安装教程换成教程站下载区
  `https://docs-new.solov.cc/guide/manager#download-installers`，和应用里「打开下载页」（`electron/app-download-page.ts`）
  同一个地址；那边按 Windows、Apple 芯片、Intel 芯片分开给包（Refs #1155 第 1 条）。`index.html` 里 `app.js` 的缓存标识跟着换。
  `scripts/dl-landing-install-guide.test.cjs` 钉住两边地址一致、落地页不再出现飞书链接。仓库里只改源文件，
  dl.solov.cc 上的页面要把 `dl-landing/` 的 `index.html`、`app.js` 照 `docs/DL-LANDING-PLAN.md` 第 4 节传到站点根目录才更新：
  `npm run dl:publish` 只传安装包和 `latest.json`，不传页面文件。
- `docs/LINUX.md`、`docs/DL-LANDING-PLAN.md` 里说落地页按钮去哪的几句跟着改；`docs/LINUX.md` 和 #1172 的分片原来说落地页
  靠 `dl:publish` 部署，一并改对。
- 撤回、分批放量、最低版本可以只管某几种安装包（#1155 第 5 条）：状态文件新增可选的 `badVersionPlatforms`、
  `rollout.platforms`、`minimumVersionPlatforms`，平台写成 `windows` / `mac` / `linux`，可接 `-x64` / `-arm64`
  （`electron/service-status.ts` 的 `resolveReleasePlatforms` / `resolveReleaseGuardFor` / `resolveMinimumVersionFor`，
  更新服务按这台电脑的平台和架构去对，Rosetta 上的 Intel 版 Mac 两种都算）。只撤某几种的版本照旧写在 `badVersions` 里，
  0.2.19 及以前的客户端不认新字段，照旧整版撤回、所有平台一起分批、所有平台都拦，只会更保守；平台表写错一律按对所有平台生效。
- `scripts/service-status.cjs` 认「0.2.20@mac-x64」「0.2.21 0@mac-x64」「0.2.21@mac-x64」这样的写法，写错的平台直接报错；
  已经对所有平台撤回的版本不能就地收窄，要先移出再加。带平台的最低版本仍按所有平台正在发的版本核。
  `release-guard.json` 一并记下撤哪几种，没有时文件跟以前逐字一样。工作流只改了三个输入的说明文字。Refs #1155。
- Intel Mac 的「关于本机」没有「芯片」那一行，写的是「处理器」，原来的说法会让 Intel 用户以为自己该选 M 系列芯片版
  （#1155 第 2 条，yoyo 10-18 批）。三处「芯片」改「处理器」：下载落地页选包说明改成「有“芯片 Apple M…”一行就选
  M 系列芯片版，有“处理器 …Intel…”一行就选 Intel 版」（`dl-landing/index.html`），落地页 Intel 按钮小字
  「Intel 处理器」（`dl-landing/app.js`），软件检查页「操作系统」一项在 Intel Mac 上写「macOS 13（Intel 处理器）」
  （`electron/diagnostics.ts`）。落地页要把 `dl-landing/` 的页面文件照 `docs/DL-LANDING-PLAN.md` 第 4 节传到站点根目录后
  才对客户生效（`npm run dl:publish` 只传安装包和 `latest.json`）。
- Intel Mac 自动更新不再可能被换成 arm64 包（#1155 第 3 条）。electron-updater 6.8.9 的 `MacUpdater` 拿 `uname -a`
  里有没有「ARM」判断 Apple 芯片，`uname -a` 带着电脑名，Intel Mac 叫「ARM-…」「CHARM…」时它会挑 arm64 包，
  装上打不开。现在主进程把「这台 Mac 能不能跑 arm64」（`process.arch === 'arm64' || app.runningUnderARM64Translation`）
  交给 `createUpdaterService` 的 `macRunsArm64`；跑不了时，`update-available` 那一刻就地拿掉清单里的 arm64 包，
  连同指着 arm64 包的老字段 `path` / `sha512`（`buildIntelMacUpdateInfo`），electron-updater 下载时只剩 Intel 版可挑。
  下载完核对 SHA-512 时按同一条规则再收窄一次，哪天 electron-updater 不再从那份清单下载，arm64 包也对不上核对值、照样拒装。
  Apple 芯片上经 Rosetta 跑 Intel 版的照旧由 electron-updater 换回 M 系列芯片版。没有新增界面文字。
- 反馈报告「运行环境」段在 Mac 上开头多两行（#1155 第 4 条）：`macOS 版本`（`process.getSystemVersion()`）和
  `Mac 芯片`（Intel 处理器 / Apple 芯片，装的是哪一版，经没经 Rosetta），客服能分清是不是装错了包
  （`electron/feedback-environment.ts`）。检查页「操作系统」一项在 Apple 芯片上跑 Intel 版时不再说成「Intel 芯片」，
  改按真实芯片说「Apple 芯片」，`details` 多记 `appArch`、`rosetta`（`electron/diagnostics.ts`，用的是原有字样）。
- 「自动」线路两条一起查时不再一次没查通就换（`relay-route-controller.ts`，#1156）：唤醒、网络恢复以后先等
  `relayRouteNetworkSettleMs`（8 秒）再查，这段时间里接连来的只查一次，点「重新检测」不等；查出走着的那条
  没通、另一条通了，隔 `relayRouteLineDownConfirmMs`（4 秒）再查一次走着的那条，还不通才换；健康检查报
  `ERR_NETWORK_CHANGED`、`ERR_INTERNET_DISCONNECTED`、`ERR_NETWORK_IO_SUSPENDED` 的算没查准，不据此换线
  （日志 `relay.route.unsure`）。定时检查的三次阈值、15 秒间隔和两次换线至少隔 5 分钟都不变。
- #1157 第 13 条（yoyo 2026-10-18 批「改盘满」）：盘满的三处说法改了。装之前查盘不够时那句（`disk-space.ts` 的
  `describeInsufficientDiskSpace`）在 Windows 上按量到的路径写出盘符：「C 盘空间不足，只剩 300 MB，至少需要 1.0 GB，
  请先清理 C 盘再试」，Mac、Linux 写「磁盘空间不足……请先清理磁盘再试」；以前一律说「安装目录所在磁盘」，量的却是系统临时
  目录和托管目录里最紧的那块，下载的临时文件在系统盘，客户清了安装目录那块盘还是装不上。「磁盘空间不够」一类的说明
  （`registry/errors.ts`）和教程那一步（`registry/tutorials.ts`）改成两处所在的盘都要留空间。
- 带盘符的那句不再含「磁盘」两个字：渲染层 `operation-error.ts` 的 `diskFull` 和两个桌面端的「原样放行」判断
  （`isPlainClaudeDesktopInstallMessage`、`isPlainCodexDesktopInstallMessage`）都加上「X 盘空间不足」，否则 Windows 上
  装 Claude Desktop、Codex 桌面端时会被套成「没装上」。Mac 上装到一半写满的那句（`macosDesktopDiskFullMessage`）没改。
- #1157 第 11 条：用星芒账号从星芒打开 Claude Code 时，环境里让它改走云厂商的五个开关（`CLAUDE_CODE_USE_BEDROCK`、
  `VERTEX`、`FOUNDRY`、`ANTHROPIC_AWS`、`ANTHROPIC_GOOGLE_CLOUD`）也不交给它，三个平台一样，Mac 的启动脚本照样
  unset（`launchExcludedEnvironmentVariables` 加上 `workspace-config-overrides.ts` 导出的 `claudePlatformSwitches`）。
  以前客户环境里留着其中一个，从星芒打开的 Claude Code 就不走星芒，首页仍说已连好。检查页「电脑里另外设过的工具地址或密钥」
  一项也认这五个（设成 0、false 的不算），用原有字样报；Windows 上「删掉这几项设置」不删它们，设它的人多半自己在终端里
  用 Bedrock、Vertex。客户 settings.json 里写的同名项不挪，那是客户自己设的值。用自己的 Claude 账号时照旧都带。
- #1157 第 14 条：macOS、Linux 和 Windows 管理员身份装命令行工具时，先把正在用的工具目录复制进暂存目录；这一步跟从哪个源
  下的无关，以前它失败（多半是没权限读）也当「这个源不行」换下一个源从头再下一遍，最后还是撞上同一个错。现在这一步怎么失败
  的都停在这个源，运行日志 `cli.install.machine-bound-failure` 多记 `copyingFolderInUse`。
- #1157 第 15 条：界面上的「关闭支付窗口」改用 `destroy()`，同到账、过期自动关那条；`close()` 会被付款页的 beforeunload
  拦下，界面说关了，窗口却还开着。关窗后照旧接着确认到账。
- 没有新增或改动界面文字。
- #1157 第 8 条：三把 Key 都缓存过的老客户，开机同步不再次次联网查分组、等状态文件。#1147 的「隔一阵问一次服务端分组」
  记录以前只在内存里，每次开机第一轮都算该查了，同步期间首页「打开」跟着等；断网开机还要白等状态文件和分组接口各一个超时。
  现在这条记录跟托管 Key 缓存存在一起（`ManagedCliKeyStore` 的 `readGroupCheck` / `saveGroupCheck`，每个账号一条，
  对照存 sha256 指纹；只改这一项不加 revision，同一轮里随后保存换好的 Key 不会被当成「缓存被改过」）。没到该查的时候只拿
  手上现有的分组对照比一下（`main.ts` 的 `peekAccountGroupHints`，状态文件这次启动还没读成过就不比、不等），到点了
  才去查，查的时候照旧等状态文件。查不成照旧 10 分钟后再试、查成了 24 小时后再查，对照一改照旧当场查。
- #1157 第 9 条：扩展页启停 Codex 插件、技能，以及导入、卸载技能时删启停记录，排进保存配置那一队（`CodexExtensionService`
  新的 `serializeConfigWrite` 选项，`main.ts` 传 `serializeToolConfigWrite`）。以前保存 Codex 配置正在队里等模型检测时点一下
  开关，那边核对配置就对不上，报「工具配置在模型检测期间发生变化」。经 Codex 命令行改配置的那几样（加删 MCP、装卸插件、
  加删市场）不在这次范围里：它们可能要等好几分钟（MCP 登录），排进这一队会把保存配置一起堵住。
- #1157 第 10 条：撤回名单和分批放量只让新的盖旧的。状态文件的 `updatedAt`（GitHub 按钮写的）读进 `ServiceStatus`，
  跟着撤回名单和放量记进 `release-guard.json`；读到的比手上那份旧（两份都写了时间才比），撤回名单和放量不跟着退回去，
  也不写盘。比本机时钟晚一天以上的时间当没写，免得一份手误写到未来的文件压住之后每一份。0.2.19 及以前的版本读这个文件时
  不认 `updatedAt`，照旧能用。issue 里说的「超过 7 天没刷新就当没读到」没做：那是放宽撤回这道安全网，要 yoyo 定。
  `docs/SERVICE-STATUS.md` 写明手改文件时 `updatedAt` 要改成现在或删掉。
- 没有新增或改动界面文字。
- #1157 第 1 条：`relay-route-controller.ts` 里先走的那条上报来的 `body`（正文读到一半断了）、`no-answer`（等不来回应头）
  在 `relayRouteRequestFailureWindowMs`（5 分钟）里攒够 `relayRouteRequestFailureThreshold`（3）次，就当它连着没查通：
  不再查它自己（健康检查只拉几 KB，被限速、长连接被掐的线路照样查得通），直接查备用那条，通了（也隔够 5 分钟）就改走它，
  原因记 `health-failed`、trigger `request-failures`（日志 `relay.route.requests-failed`，导出报告说「线路X上的请求接连
  断在半路、等不来回话，改走线路Y」）。攒的不受「查过一轮 30 秒内不重查」限制；正有检查没回来时先留着，下一次失败再看；
  先走的那条正等着隔 15 秒再查的那一轮直接让给它。退到备用那条以后不攒，切回去照旧要连着查通 10 分钟。
  issue 里另一半「退到备用那条以后一次抖动加一次探通就切回去，要保留 10 分钟稳定期」没照做：#1053 定的就是备用那条自己
  坏了当场切回、不等 10 分钟，#1156（PR #1177）已经让这一下要隔 4 秒再查一次还不通才换，一次抖动不再切回去。
- #1157 第 2 条：`relay-line-fetch.ts` 退到的是直连、直连只回了白名单 404 时，交回走着那条这次的结果（失败照原样抛，
  网关错误页、跳转照原样交回），日志 `relay.line.blocked` 照记。只读请求两条一起等时也一样：走着那条不能用的回应
  先放着不丢，另一条只回了白名单 404 就交回它，用了另一条的再把它丢掉。线路改了被掐掉的那一次没什么可交回，照旧交回直连的。
- #1157 第 3 条：下载视频成片的 `/v1/videos/{id}/content`（`redirectingPaths`，`relayAnswerMayRedirect`）回的跳转算星芒的回话：
  不换线路重发、不报给线路那边，直连分流（`proxy-bypass.ts` 的 `createSiteFetch`）也不算直连被拦。带网页正文的跳转一样
  （Go 的 http.Redirect 给 GET 写的是 text/html）。别的接口回跳转照旧算被拦。
- #1157 第 4 条：线路那层自己掐掉的那一次（另一条先回了话、线路改了）用 `RelayLineCancel` 作中止原因（`isRelayLineCancel`），
  直连分流见到它不调 `siteRouteFailed`。以前账号请求改走直连会话时，每个超过 4 秒的读请求都叫它再看一次，代理一探碰巧通了
  就把请求交回不转发星芒的代理。
- #1157 第 5 条：`network-failure.ts` 的 intercepted 认 Electron 的 net.fetch 在 `redirect: 'error'` 下碰到跳转报的
  「Attempted to redirect, but redirect policy was 'error'」（Electron 43.8.0 的二进制里核对过原句）。查模型、画图、读状态文件
  被门户跳转时，经 `relay-line-fetch.ts` 的只读请求会退回另一条并报给线路那边，按归类给中文的地方给「拦到了别的页面」那句。
- #1157 第 6 条：会改动数据的请求换线重发只认证书没通过校验的 `ERR_CERT_*`（Node 没有错误码的证书散句照旧算）。
  握手做到一半被掐断的 `ERR_SSL_*`、`ERR_QUIC_HANDSHAKE_FAILED`（#1060 当时保留算没送到）和连接用到一半证书换了的
  `ERR_SSL_SERVER_CERT_CHANGED` 不再重发：路上的设备在建好的连接上破坏 TLS 记录时报的也是它们，QUIC 还会在握手没完时
  就把请求发出去，重发可能多签一把密钥、多下一单。只读请求照旧换线重发。
- #1157 第 7 条：会改动数据的请求被跳转拦下（3xx、opaqueredirect）时换另一条线路重发，同白名单 404；星芒会改动数据的接口
  从来不跳转，回了跳转就是请求没进到服务里。网页、网关错误页分不清送没送到，照旧不重发。#1064 那条「写请求不重发」到此改掉。
- 没有新增或改动界面文字。
- 历史账号换线路时，客户在密钥页「写进工具」、配置窗口选的那把账号密钥不再被换成自动签的那把（#1159，早于 #1142）。
  以前 `account-bootstrap.ts` 的 `accountRouteMigrationNeeded` 只看来源和线路，进了 `targets` 就交给 `configureManagedClis`
  用缓存里的托管 Key 整份重写，额度上限、扣费分组跟着线路一换就悄悄变了。星芒账号平时由主进程 `followToolRoutes` 定点只改地址，
  不受影响；服务状态文件切回 `toolRouteRewrite: merge`（R6）时也走这条，同样修好。
  现在开机恢复这一轮只因为换线路才写的工具，配置里那把既不是缓存里眼下那把（`configurationAccountMatched`）、
  也不是缓存换掉过的（`configurationKeyReplaced`，#1153）时，规划给出 `keepKeys`，经 `account:configure-managed-clis` 的新可选入参
  `keepKeys`（只传工具名，Key 不跨进程）交给主进程；`configureManagedClis` 对这几家不读、不签托管 Key，把空 Key 和原来的型号交给
  `saveConfig`，沿用配置里那把，照旧只认来源是当前账号、没被改过的配置，照旧用这把查一遍型号。全是沿用的那一轮不去问服务端。
  自动签的那把、缓存换掉过的那把照旧整份重写；托管 Key 换了分组（买了订阅、订阅到期）的照旧换进新分组，没改。
- 测试「技能开关排进配置写入队列」不再固定只等 1 秒：假的 `serializeConfigWrite` 一进来就放行一个「已进队」Promise，测试等它（和安装本身赛跑，安装先结束就当场报错，不干等），不再用 `vi.waitFor` 默认 1 秒轮询。Windows runner 忙时，往几个工具目录里装技能文件就超过 1 秒，这条曾偶发红；放行前 `config.toml` 不动、放行后写入正确两条断言一字未改（#1162）。
- #1210：`electron/main.ts` 的 Mac 应用菜单「设置...」不再发给 `BrowserWindow.getFocusedWindow()`（画布、付款窗口在前时发进它们，没人接），
  改为先 `showMainWindow()` 再 `sendToMainWindow('onNavigate', …)`，跟托盘跳页同一个写法。菜单仍在建主窗口之前设上，回调经
  `navigateFromAppMenu` 晚绑定，主窗口建好之前点了不做事。`electron/main.test.ts` 读源码钉住菜单回调和这次赋值。
- Windows 系统目录（SystemRoot）解析只留一份：`electron/windows-system-root.ts`。客户端
  `electron/windows-machine-paths.ts` 照常 import；发版校验 `scripts/windows-machine-paths.cjs` 要在没编译主程序时也能跑，
  第一次查 SystemRoot 时用 TypeScript 从源码现转这一份，只许它引用 `node:` 内置模块（无签名模式和非 Windows 不会读它）。
  唯一的行为差别以客户端为准：核心模块路径里带 NUL 时，发版脚本以前改问系统设备路径，现在和客户端一样直接拒绝（实际碰不到）。
  客户端在 480 种输入组合下的结果一字不差，发版脚本除 NUL 那 30 组外也一字不差；客户端的结果已钉成绝对值，
  对照测试那条 todo 已去掉（#1225）。
- `features/auth/state.ts` 的 `authFailure` 改在剥掉 IPC 通道名和类名之后的句子上做判断：以前 `account:change-password`、`account:reset-password` 里的 `password` 会被 `/用户名|密码|…/` 那条认走（#1236）。「重置密码」「设新密码」两步另外跳过这条，主进程自己的兜底「重置密码失败，服务返回 HTTP 500」句子里就带「密码」；这两步「密码不对」只认服务端那张表里的准话（原密码错误等）。
- 历史账号站计费复查那句余额不足，开流之前和 Claude 兼容分组排队以后也认（#1240）。对过 Sub2API（Wei-Shaw/sub2api 270eac6、b0a02a3）：
  过了鉴权以后 handler 还要复查一次计费（`CheckBillingEligibility`、在途余额预留 `reserveInflightBalance`），没过回 403
  `{"error":{"type":"billing_error","message":"insufficient balance"}}`，跟鉴权中间件那句「Insufficient account balance」不是一句，
  `classifyRelayQuotaFailure` 认不出：对话落到「当前 API Key 无权使用所选模型或分组」，生图把英文原话直接上屏。
  Claude 兼容分组排队超过 10 秒已经回过心跳时，`gateway_handler_chat_completions.go` 照普通请求回这段 JSON，不带 `data:` 前缀接在流后面，
  以前说成「AI 服务提前结束了本次响应，请重试」。
- `classifySub2apiStreamQuotaFailure` 改名 `classifySub2apiBillingFailure`，认法不变，三处共用：对话 `safeHttpFailure`（403 时）、
  SSE 解析器记下的最后一段裸 JSON（流没等到结束标记时）、生图服务（403 时，`createAiImageService` 新增可选 `backend`，`main.ts` 两个生图服务都传
  `definition.backend`）。仍然只在历史账号站认：xm 站出现这句只可能是渠道上游原样转回来的。
- 视频不用改：历史账号站的视频生成本来就关着（`main.ts` 里 `solov-api` 直接拒）。写密钥前查模型清单也不用改：Sub2API 的 `/v1/models`
  不走计费复查，余额不足只会是鉴权中间件那句，早就认得。
- 删掉 renderer-v2 里只剩测试在读的 `data-unsaved` 标记（个人资料、对话参数、Codex 别家模型、工具配置、外部客户端几个弹窗，
  对话页根节点，留言反馈表单）和对话页给关窗看的 `data-busy`，连同留言反馈的 `copied` 状态、对话页的 `unsaved` 计算和相关断言；
  两处说「关窗会提醒」的注释一并删掉。关窗只走主进程原生对话框、不问界面（`window-lifecycle.ts`），这批标记自 `window:close-report`
  删掉后已无人读。`StartGuide`、`AuthFlow`、`Home` 的 `data-busy` 不动。界面与行为不变（#1271）。
- Codex 插件目录同步（`scripts/sync-codex-plugins-cos.cjs`）：2026-10-19 起 GitHub 接口连着几轮拒绝带工作流令牌问
  `openai/plugins` 的 main（HTTP 403），定时同步每轮都红（#1290）。现在带令牌被拒（401/403）时，不带令牌再问一次同一个地址，
  主机、不跟跳转、大小上限和提交号格式检查都不变；别的错误照旧直接失败，日志里能看到两次各自的结果。
- #1333：#1070 拆大文件以后，三道守安全边界的门禁和测试跟上了，只改测试和门禁，产品行为不变。
- 出包门禁 `scripts/verify-packaged-hardening.cjs` 的「CLI 旧启动链、管理员提权启动链不许回来」两条否定检查，原来只读 `provider-launch-service.js`、门面、上下文和 `windows-elevation.js`，拆家前它读的是整份 `system-service.js`。现在点名查拆出去的全部 13 份（门面、上下文、九个业务簇、`npm-registry`、`npm-command-failure`、`cli-native-package` 三个叶子模块），缺一份就出包失败，不会因为改名悄悄少查；另外 `dist-electron` 顶层所有 `*-service.js` 按名字自动带上，以后再拆出来的服务文件不用回来改单子。在 tsc 加 minify 出来的真产物上跑过，没有误报（合法带 `-Verb RunAs` 的只有 `codex-desktop-appx.js`、`node-runtime.js`，都不在查的范围里）。
- `electron/ipc.test.ts` 的 IPC 策略表测试加两条：四个前缀以外要等账号的 7 条通道点名；日志不是 `normal` 的通道（quiet-success、silent、secret-input、polling）和 `scoped-queued`、`scoped-may-end-session` 两种等账号法逐条点名。#1333 列出的十种照抄邻居一行的改错，现在逐条改表都会红。
- `ipc.ts` 撤通道时的三项收尾各加一条测试：退出时擦掉还没到 60 秒的剪贴板密钥、放掉换线路定点改写拿着的账号钩子、清掉反馈报告预览。删掉任意一行都会红。
- 随包更新说明不再悄悄截到 60 条（#1334）：`scripts/bundle-release-notes.cjs` 在顶节就是这一版、条数超过 `MAX_ITEMS`（60）时抛
  `RELEASE_NOTES_TOO_MANY`，`npm run compile` 最后一步失败；`release:preflight`（`verify-release-environment.cjs` 新增的
  `assertReleaseNotesFitUpdatePage`）调同一个函数，在出包前先拦。顶节是「未发布」或上一版的构建照旧写 `notes: null`，日常测试包不受影响。
  主进程 `installed-release.ts` 的 60 条只防坏文件，测试钉住两边是同一个数；单条超 1000 字照旧截断带「…」。
- 0.2.20 的 `## 用户` 从 84 条合到 45 条：相近的几条并进同一个分片的那一条（被并走的分片只剩 `## 开发`），内容一句没删。客户报过的四件
  （用量账单反复要重新登录、Codex 桌面端「提交消息时出错」、Mac 反复弹密码、较慢 Mac 上 Codex 桌面端「检测失败」）的分片改名
  `001-`~`004-` 排在最前，冒号前那半句改成修好了什么：装完后角落卡片列的就是前 3 条的这半句。`docs/RELEASING.md` 与分片 README
  写明 60 条上限和 `001-` 这种排法。
- #1335 第 3 条：退出那一拍（will-quit）写的运行日志改成当场同步写。以前排进异步队列，will-quit 一返回进程就退了，「应用主进程即将退出」（`app.stopping`）和退出清理哪一步失败了（`app.quit-cleanup.failed`）多半落不了盘。用 Electron 43 在 Linux 上实测：改之前退出 6 次丢了 4 次，改之后 8 次都在。`RuntimeLogStore.writeSynchronouslyFromNowOn()` 由 `main.ts` 的 will-quit 在跑清理之前调；同步写走同一套 `safe-local-data` 检查和轮转（`appendSafeUtf8FileSync`、`removeSafeDataFileSync`）。队列里还有没跑完的追加或读取时照旧排在后面，不跟进行中的那次抢同一个文件位置，先后也不乱。没有拦下退出再 `app.exit()`：那会跳过 `quit` 事件，退出时装更新挂在那上面。
- #1335 第 1 条：`main.test.ts` 给退出清理的 18 步各钉一份它要跑的语句，步骤里删一句（比如 `relayRouteController.dispose()`、`clearInterval(routeOnlineTimer)`、`lifecycle.dispose()`）会红。
- #1335 第 2 条：「只许 main.ts 登记退出清理」认单引号、双引号、反引号三种写法；新加一条：`bootstrap/` 里挂的 `setInterval` 和 `app` / `powerMonitor` / `process` / `screen` / `nativeTheme` 的监听，取消句柄要 `return` 回 main.ts、并在退出清理里撤掉，不然要在测试里点名放行。
- #1335 第 12 条（一部分）：`bootstrap/lifecycle.ts` 文件头和 `main.test.ts` 加速那条的注释照实说：加速服务断开和放掉独立加速进程是按先后发出去、不互相等。
- #1335 第 7~9 条：service-status 工作流里「只管某几种安装包」的三处口径跟客户端对齐（`scripts/service-status.cjs`）。
  - 不再收 `windows-arm64`：Windows 只出 x64 安装包，ARM 电脑上模拟跑着的也是它，客户端算出来是 `windows`、`windows-x64`，写了一台也撤不到，预览却说会撤。报错叫人写 `windows` 或 `windows-x64`。
  - 读线上那份时照客户端 `readReleasePlatforms`、`readVersion` 规整：平台去空白、转小写，版本号去前导 `v`，`0.2.20` 和 `v0.2.20` 两份平台表合起来，其中一份读不懂就整版撤回。以前逐字比：手改写成 `{"0.2.20": ["Mac-X64"]}` 时预览说整版撤回（客户端其实只撤 Intel 版 Mac），下次运行还会把这个范围丢掉、变成对所有平台撤回。
  - 管到的客户端全都不认平台时，带 `@` 直接报错：撤回早于 0.2.20 的版本（跑那一版的客户端都不认平台），分批放量和最低版本不比 0.2.20 新（被管到的都是更低的客户端）。以前 `0.2.18@mac-x64` 看着只撤 Intel 版 Mac，实际所有平台的 0.2.18 都撤。
- 工作流三个输入框的举例跟着换成 `0.2.21@mac-x64`、`0.2.21 0@mac-x64`（原来的 0.2.10~0.2.12 按新规矩会报错）；`docs/SERVICE-STATUS.md`「只管某几种安装包」一节和字段说明同步改。
- #1335 第 6 条：`pages-management.test.tsx` 钉住业务页样式表先后靠的那几行 import：`ExtensionsPage.tsx` 从 `pages-maintenance` 拿 `installJobRunning`、`installResultMessage`，排在 `extensions-common` 和 `extensions.css` 前面；`pages-management.tsx` 头一个转出的是 `ExtensionsPage`。改成直接从 `features/tools/install-result` 拿，教程页那几份样式和 `extensions.css` 在构建出来的样式表里就对调了，眼下没有同级选择器冲突、界面看不出来，所以只能靠测试钉。
- #1335 第 12 条（剩下的）：拆家以后还指着 `ipc.ts` 的注释改成实际位置：`macos-grok.ts`、`new-api-client.ts` 两处（`ipc/parsers/`）、`account-credential-store.ts`、`ipc-channel-policy.ts` 两处（`ipc-channel-policy.ts` 自己、`ipc/handler-log.ts`）、`relay-backend.ts` 两处（`ipc/handlers/`）、renderer-v2 的 `business-common.tsx`（`ipc/handlers/detection-failures.ts`）；`docs/V2-BUSINESS-IMPLEMENTATION.md` 写明两个 pages 文件只做转出、页面各在哪。只改字，不改代码。
- #1335 第 4 条：拆出来的 `diagnostics-*.ts` 七个文件「只从 `diagnostics.ts` 拿类型」加了门禁（`diagnostics.test.ts` 末尾那条，按文件名自动认新文件）。新写的 `electron/type-only-imports.test-support.ts` 用 TypeScript 语法树判断，多行 import、`import { type A, b }`、`require()`、`import()`、`export … from`、只为副作用的 `import './x'` 都认得出来；config-files 那两条（`config-files-context.test.ts`、`gemini-retired.test.ts`）原来按行看，查不出 require 和动态 import，一起换成这套。辅助函数自己的用例在 `type-only-imports.test.ts`。
- #1335 第 5 条：`schedule-timeout.test.ts` 那条「全主进程只有一份 scheduleTimeout」改成递归扫，`bootstrap/`、`ipc/`、`platform/` 底下抄出来的也能抓到。
- #1335 第 10 条：`acceleration-development-backend.test.ts` 两处等 `proxy.enable` 被调的 `vi.waitFor` 从默认 1 秒放到 10 秒（跟仓库里其它同类写法一样），Windows 慢分片上不再偶发红；断言没等到时先在清理里放行那个挂着的 enable，不再拖着 dispose 一起卡满 10 秒。断言没改。
- 只改测试，产品代码没动。
- `pages-account.tsx`：个人中心自己那次读会话答「没登录」、外壳的会话却是登着时，按外壳那份摆页签，
  再经 `onAccountChanged` 请外壳问一次主进程（一次分歧只问一次）；外壳换了新的一份会话就跟着重读。
  以前页面只在挂上和点刷新时读会话，去过就只藏不卸，同一账号重新登录作用域不变、页面不重挂，
  读到过一次「没登录」就一直停在那里，那一页也没有刷新按钮。主进程真的已经没登录、广播却没到外壳时，
  外壳这次再问会退回欢迎页。触发是 0.2.19 Windows 真机：点「用量账单」进到「登录后查看个人中心」，
  底栏同时写着「已登录」，运行日志最上面没有错误。页面第一次为什么读到「没登录」还没坐实。面向用户的那句并进了
  `001-usage-bill-relogin.md`（同一件客户报的事）。
- `quality.yml` 不再把 renderer-v2 和画布的单元测试跑第二遍（#1066）：`test:vitest` 的 `src` 参数按路径子串已经收进 `src/renderer-v2` 和 `canvas-v2/src`，Windows 的三个 vitest 分片和 Linux、macOS 的 `npm test` 本来就跑全了，所以删掉 Windows 的 `renderer-v2` 分片和 Linux 的 `test:v2:vitest`、`test:canvas` 两步，`npm test` 本身不变。每个平台每个测试文件仍跑一次；`scripts/ci-workflow-config.test.cjs` 按 vitest 的过滤规则证明 `test:vitest` 包含这两套，并挡住有人再加回来。
- `electron/cli-verified-versions.ts` 把 Claude Code 的 `recommended` 从 2.1.296 抬到 2.1.302（npm latest，2.1.297、2.1.298 没发过）。上游 2.1.299 修了功能开关、启动、快速模式、账号资料、反馈几类发往 Anthropic 的请求带着第三方网关 Key，同版把自定义 `ANTHROPIC_BASE_URL` 下流式无数据的超时从 180 秒放到 300 秒；2.1.299~2.1.302 没有第三方端点回归。沙箱本地假接口对照 2.1.296 请求体字段、工具列表、鉴权头一致，依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- 各工具的默认型号、上一代默认、已下架型号可以从服务状态文件下发（`service-status.json` 的 `cliModels`，
  #1059 型号那一段）：`electron/cli-model-defaults.ts` 改成程序自带一份、和下发的合并，读不到、格式不对、
  名字不合法的照旧用自带的；默认型号只在账号模型列表里真有的型号里挑，下架名单只换掉账号已经不再列出的型号。
  开机替换下架型号从只有 Codex 扩到 Claude Code 和 Grok（自带名单里这两家是空的，线上不写就没有变化），
  规矩同 #1042：只碰当前账号写的配置、工具开着先不换、换之前先备份，Codex 的 WebSocket 开关照旧跟着型号走。
  service-status 工作流加了「型号表」一项，写法见 `docs/SERVICE-STATUS.md`。只有 0.2.20 及以后的客户端认。
- 报错改字 A 组（Refs #1076 #1100 #1101 #1093 #1057 #1111）：`ai-video-service.ts` 查进度断档换句；`payment-window.ts` 加 `PaymentCheckoutRejected`；`ai-chat-service.ts` / `ai-image-service.ts` 按上游原话分类；`claude-desktop-config.ts` 切换被拒那句换说法、原因挂 cause。
- 新增 `electron/npm-failure-reasons.ts`（零依赖，进 renderer 值导入名单）与 `failure-wording.ts` 的拼句函数：npm 装、卸、回滚按原因表说中文，错误码留在句尾「（错误码 X）」给 `operation-error.ts` 认；找不到版本、被拒、没过校验、组件对不上几类整句自带下一步，错误框不配标题。`withToolCertificateHint` 改拿原话认证书。
- 新增 `electron/config-link-refusal.ts`：配置文件本身是符号链接或硬链接时先认出来、换说法，校验一个不放宽；错误目录加 `configLink`、`configDiskFull`、`downloadUnreachable`、`downloadSourceError`、`officialRegistryUnreachable` 五类，握手被掐断（#1060）在安装场景改归 `downloadUnreachable`。
- `node-runtime.ts` 的 Node.js 自动安装失败只取一个原因上屏（`describeNodeInstallFailure`），winget 与各源原话挂 cause。
- 上屏句换成中文时，原来的错误一律挂在 `cause` 上，运行日志照记。
- 红队 D 组「交互提示」（#1059、#1099 第 3 条、#1101 第 3 条、#1104 第 1/2/6/10 条、#1111 第 2 条），连带不改字的那半：
  `useChatController` 初始化时记住的分组不在列表里就退回 `resolveChatGroup` 推荐的那个并 `setNotice`；发送前的两句按「读取分组 / 准备模型 / 准备失败 / 没选模型」拆开；
  `ChatPage` 的 Enter 复用发送按钮的禁用条件；扩展页删除按钮只在 `busy === 'delete'` 时转圈，其余忙时禁用并说原因；
  反馈 `getFeedbackReport` 失败时只复制描述（`buildFeedbackMessage` 加 `reportMissing`）；外接客户端 `detectThenSave` 停下时焦点移到「默认模型」；
  状态栏加速中改为 `navigate('acceleration')`，`browser-check.mjs` 两条断言跟着改。#1099 第 1 条（授权「取消」，要加 IPC 通道）另开。
- Electron 从 43.6.0 升到 43 线最新的 43.8.0（#1088），不跨大版本，别的依赖不动。Chromium 底版仍是 150.0.7871.250，两版之间 Electron 往 Chromium 补了 139 个、往 V8 补了 29 个上游回移（按 electron 仓库 `patches/chromium/.patches`、`patches/v8/.patches` 两个标签之间的差异数的，各条对应哪些漏洞没逐条核）；自带的 Node 从 24.20.0 到 24.22.0。V8 仍是 15.0，冒烟里「inspector promise 被回收」那件事不会因此消失。Dependabot 按 yoyo 10-17 的决定先不开。
- Grok CLI 装插件不带 `--trust` 一律拒绝：1.0.52（推荐版）和 1.0.62 在沙箱里实测都打印英文提示后退出码 1，
  有没有终端都一样，所以「添加插件」以前对 Grok 每次都失败。带了以后插件进 `~/.grok/installed-plugins`，
  它的钩子和 MCP 在之后每次启动 Grok 时自动运行（本地假接口跑 `grok -p` 实测钩子、MCP 命令都执行了）。
  卸载、启用、停用、更新都不需要 `--trust`。
- `ProviderExtensionMutation` 加可选 `trust`；`extensions:mutate` 只认字面量 `true`，别的类型报「扩展操作格式错误」；
  主进程只在 Grok 的 `plugin install` 上带 `--trust`，别家收到也不带。
- renderer-v2 插件页：Grok 的「添加插件」表单提交前叠一个确认框（`plugins-trust-confirm`），确认后才带 `trust: true`。
  legacy 树已冻结，没动，它的 Grok 插件安装维持原样失败。
- Windows 版 Grok 的签名名单加上 X Corp.（#1051）：xAI 从 Grok 1.0.54（2026-10-12）起改用 X Corp. 的证书签 `grok.exe`，
  只认 X.AI LLC 的 `electron/trusted-native-cli.ts` 和 `scripts/sync-grok-cos.cjs` 把新包当成发布者不符：点名新版或
  「总是装最新版」装不上、更新不了，管理员身份下用户目录里的新版 Grok 也会被拒绝打开（读代码推断，`tool-installation.ts`
  的 `stageVerifiedNativeCli`），桶同步一直卡在 stable（#1044）。两张证书各钉住签发机构（X.AI LLC 只认 SSL.com EV
  Code Signing Intermediate CA RSA R3，X Corp. 只认 GlobalSign GCC R45 CodeSigning CA 2020，主体名另要 Bastrop、
  Texas、US），签名检查多读一项 `SignerCertificate.Issuer`；两处名单要一起改。
- `grok-installer.ts` 从 xAI 下载时，签名有效但签名者不在名单上就不再换地址重下（新增
  `NativeCliPublisherMismatchError`），以前要白下最多四遍约 170 MB 才报错。
- `features/auth/StartGuide.tsx` 的 `onComplete` 多带一个 `landing`（`'home' | 'chat'`）：只有「去聊天」那颗按钮给 `'chat'`，
  「进入首页」「打开 X」「去充值」都给 `'home'`。`App.tsx` 以前按选的开始方式定去向（`id === 'chat' ? 'chat' : 'home'`），
  所以选了聊天以后「进入首页」也进聊天页。记进本机的引导偏好照旧写开始方式。
- #1060：`network-failure.ts` 的 tls 只留证书类（`ERR_CERT_*`、名字里带证书或证书公钥的 `ERR_SSL_*` / `ERR_TLS_*`、Node 的 `ERR_TLS_CERT_ALTNAME_INVALID`、OpenSSL 证书散句），其余 `ERR_SSL_*` / `ERR_TLS_*` / `ERR_QUIC_HANDSHAKE_FAILED` 归 refused，文案用表里现成那句。排在 tls 原来的位置，和别的原因撞上时的先后不变。
- 换线重发的判断不变：新出的 `isTlsHandshakeFailure` 让 `relay-line-fetch.ts` 的 provablyUnsent 照旧把握手失败当没送到。经代理探工具线路（`tool-path-probe.ts`）把握手失败算 tls，和不经代理那条一致，不再报成「安全软件接管」。渲染层操作报错里握手失败的原文跟 ECONNRESET 一样落到连不上那几张卡。
- 跟着变的：握手失败现在和连接被重置走同一套，账号请求经系统代理时会照 refused 那样探直连再重发（只重发只读请求）；首页没写好密钥时显示的是断网那句，不再是被设备拦下那句；登录框显示登录框自己的「连不上账号服务」那句。
- 账号和中转请求碰到跳转时 Electron 的 net.fetch 只抛 `Redirect was cancelled`，不交回 opaqueredirect，
  `network-failure.ts` 以前认不出这句：账号请求原样抛英文、不走中文提示，`relay-line-fetch.ts` 里
  「直连被跳走就退回备用线路」那一段在生产环境从来走不到。现在把这句归进 intercepted：只读请求退回
  备用线路并报给线路那边，写请求照旧不重发；账号请求给「当前网络把这次请求拦到了别的页面」那句现成中文。
  只做了兜底，给账号请求换网络栈的根治另做（#1064）。
- xm 站上星芒新签的密钥改叫「用户名-分组」（如 `yoyo-Claude-MAX`、`yoyo-GPT`，画图技能的 `yoyo-图片模型`），AI 对话新签的叫「用户名-分组-对话」（如 `yoyo-GPT-对话`），站长在后台令牌和日志里一眼看出是谁、哪个分组的（yoyo 10-16，对话加后缀也是他选的）。只管以后新建的：已经签好的不改名，复用分组里现成的那把时名字照旧；历史账号那套后端（Sub2API）不变。
- 起名在 `catalog.ts` 的 `buildAccountKeyName`：new-api 按 UTF-8 字节数限令牌名 50（rc.44 `controller/token.go` 的 `len(token.Name) > 50`），用户名最长 20 个字、可以是中文，所以按字节截，先截用户名、分组和后缀尽量留全，不会把一个字截成两半；用户名或分组是空的就照旧用调用方给的名字。
- `new-api-client.ts` 的 `provisionCliKey` 在建 Key 时换成新名字，AI 对话（`chat-credential-coordinator.ts`）传 `purpose: 'chat'` 接上「-对话」。命令行工具传的名字（`xingmang-desktop-*`）仍是这把 Key 以前的名字：`hasExhaustedCappedCliKey` 改成接收一组名字，两个名字下用完的额度上限都照样拦住；「比用完的上限更新的同名 Key = 用户自己放开了」只认以前的名字。AI 对话照旧不在这里按名字拦（它自己那把的上限由 `chat-credential-coordinator.ts` 认），两边额度互不牵连。`ipc.ts` 里按名字认是哪个工具（换新时照抄原来的上限）的那一步不受影响。
- 「每个工具的额度上限」「各工具累计用量」（`account-key-quota.ts`）多认「用户名-分组」那几把，用户名由页面从当前登录态传进来；配置框「自动准备」那一行显示的密钥名（`account-key-options.ts`）跟着换成新名字。
- Intel 版 Mac 包发出去之前也要真的启动一次：出包的 runner 全是 Apple 芯片，`e2e/macos-launch-smoke.mjs`
  原来只挑本机架构那一份，所以直到 0.2.19，Intel 版从没被启动过（2026-10-17 查客户 Intel Mac 装不上时发现）。
  冒烟脚本加了 `--arch x64`，在 Apple 芯片上经 Rosetta 启动 Intel 版；发版的 macos-build、测试包的
  macos-package 和 PR 上的发布路径排练都在上传前多启动一次 Intel 版。`quality.yml` 新增 `macos-intel`
  作业，在 `macos-15-intel` 上原生出包、原生启动，并入 quality-gate。
- 停用的签名工作流 `release-build.yml` 去掉单独的 `cd canvas-v2 && npm ci && npm run build` 和 `XINGMANG_CANVAS_DIST`（审查总表 P-10）：发布门禁的 compile 本来就经 `canvas:prepare` 用根仓依赖重建画布并覆盖那份产物，那一步只是在持有签名证书的 runner 上多跑一套没审计过的依赖安装。`scripts/release-workflow-config.test.cjs` 钉住。
- 落地页 `dl-landing/latest.json` 移出仓库并加进 `.gitignore`：它是 `dl:publish` 上传后写出的产物，仓库里那份停在 0.1.28，
  整目录同步上线会把源站清单盖回旧版本。本地预览改由 `preview.mjs` 给一份假清单（审查总表 P-15）。
- `publish-release` 的 release-tag 作业在查 tag、出包之前先跑 `node scripts/changelog-collect.cjs --assert-collected`：`changes/unreleased/` 里还有没汇总的分片就停下，什么都不动（#1086）。定版之后又合进来的改动照样进包，不拦的话客户更新说明一句不提，CHANGELOG 还会把它记到下一版；0.2.19 靠 #1039、#1108 两次补收才没出事。只出 Linux 包、不对外发的运行不查。
- publish 作业对这次选了的 Windows、macOS 出包作业要求 `success`，不再只挡 `failure`（#1090 第 1 项）：作业超时的结果是 `cancelled`，原来 Windows 超时这一版会悄悄只发 Mac，反过来也一样。`scripts/publish-workflow-config.test.cjs` 按各出包作业自己的 `if` 逐个平台核对。
- 星芒画图技能没准备好时首页那句改说「密钥」：「当前账号没有可用的 Codex 或图片模型密钥」「星芒AI 生图密钥未完成初始化」，跟界面上的叫法一致（`electron/xingmang-ai-skill.ts`、`electron/ipc.ts`）。旧版（0.2.18 及更早）开机报「当前账号没有可用的 Codex 或图片模型 Key」是认不出 10-16 改名后的分组，0.2.19 的 #1046 已修，这里只换字。
- Windows CI 的 vitest 分片从三片切成四片（`test:vitest:1~4` 改用 `--shard=i/4`，`quality.yml` 的矩阵加一个 `vitest-4`），并且改成按实测用时发文件，不再按个数切。main f4b0d2a 上第一片跑 12.7 分钟、另两片 6.0 和 4.1，#1287 的第一片用例全过却跑满 15 分钟被掐。原因是 vitest 自带的 `--shard` 按文件路径的哈希排序后等个数切，十来个 electron/ 套件在 Windows 上一个要 13~170 秒，其余 630 个平均不到 1 秒，哈希恰好把最慢的五个里的四个排在一起；只多切一片，这一团会整个挪到 `--shard=2/4`，最长那片照样 12 分钟多。
- `vitest.config.ts` 换了一个只改 `shard()` 的 sequencer：`scripts/vitest-shards.mjs` 里记着这十几个慢套件的实测秒数，先从最慢的起，每个发给目前最轻的那片，其余文件每个按 1 秒同样发。每个 runner 按同一份文件清单算出同一个结果，四片加起来仍正好是不分片时的全部文件；不带 `--shard` 时（本机、Linux、macOS 的 `npm test`）一切照旧。按 f4b0d2a 的实测，四片各约 5.5~5.9 分钟。
- 超时**没有调大**，照原来的规矩办。`ci-workflow-config.test.cjs` 的穷尽性检查从 3 改到 4，另加一条：表里的套件都还在、四片互不重叠且覆盖全部文件、跟文件顺序无关、最慢的四个落在四片、没有哪片比平均多出一成以上。

## 0.2.19 - 2026-10-16

- 服务状态文件新增 `accountGroups`（分组对照）：xm 站改分组本名时，发布者在 service-status 工作流的「分组对照」里写
  「codex=新名字|老名字」这类对照，客户端不用发版就跟过去。new-api 的分组没有编号、全按名字认，站上同一家又有好几个
  分组，靠名字里的词认不出改了名的那个（`electron/managed-cli-groups.ts` 新增 `mapped` 一档，排在写死名字之前；
  只在服务端给出的可用分组里挑，只管星芒账号）。
- 画图技能给 Codex 签 Key 不再写死 `GPT-中转/订阅`，和命令行工具同一套认法；画图分组先看对照
  （`electron/xingmang-ai-skill.ts`）。AI 对话没选过分组时跟主进程标的 `recommended` 走（`chat:list-groups`，
  `AiChatGroupSummary.recommended` 可选字段），不再在写死名字找不到时掉进排第一、没接渠道的 `default`。
- 对照读不到一律照旧认，不多等：签 Key 只搭启动时那一次读状态文件的便车（`ServiceStatusMonitor.settled()`）。
  0.2.18 及更早的客户端不认对照，改名过渡期服务端仍要保留老名字，见 `docs/SERVICE-STATUS.md`「分组对照」。
- 三线路 7b（`/mnt/project-files/累计问题/清单.md` 第二节第 3 条、第三节「写 Key 失败时把原因记进日志」）：
  新增 `electron/request-diagnostics.ts`，用 WeakMap 给一次请求的回应、失败和结果挂上走的线路
  （direct/primary）、HTTP 状态码、new-api 回应头 `X-Oneapi-Request-Id`（rc.24 起全局中间件加的）和 `cf-ray`。
  挂在旁边不加字段，错误和结果的样子不变，也不跨进程；编号认不出的（超长、带空白或奇怪字符）不记。
- `relay-line-fetch.ts`：按线路发的请求和写配置前的查模型，回应和失败都挂上实际走的线路，直连没走通改走默认线路
  重发的记 primary。
- `new-api-client.ts`：`performRequestOnce` 读回应时取诊断；`unwrapEnvelope`、公告、老计费信封和登录、两步验证
  读回应时出的错都挂上；没拿到回应的失败换成中文错误时把线路带过去。登录、两步验证成功的结果也挂上，
  `realm-account-service.ts` 换成带站点的新对象时跟着带过去。`system-service.ts` 的查模型同样挂上。
- `ipc.ts`：IPC 失败日志多一个 `request` 字段（只在有诊断时）；登录、两步验证成功的日志带上 `request`。两步验证
  登上了以前一条都不记，现在记一条，入参（验证码）在记日志前就换成空列表，从根上进不了日志（新的
  `secretInputIpcChannels`）。写 Key（`account:configure-managed-clis`、切到当前账号）没配上的工具各记一条
  `account/managed-cli.key-failed`：哪家、原话（主目录已换掉）、`request`。`account-cli-provisioner.ts` 把签 Key、
  查模型那次的诊断跟着失败条目走。
- Gemini CLI 在同一版下线（`gemini-cli-retired.md`），检查页不再查它，下面 Gemini 文件夹信任这一项随之不再出现，原来的「用户」说明一并拿掉。
- xm 三线路 C16 剩下的两项诊断，都没加新的界面文字。
- Gemini 文件夹信任：`workspace-config-overrides.ts` 的 `inspectGemini` 先看 `~/.gemini/trustedFolders.json`，
  最近选的项目文件夹按 Gemini 0.62.0 `isPathTrusted` 的比法（规则管自己和下面的文件夹，`TRUST_PARENT` 管上一层，
  听路径最长的那条，Windows / macOS 不分大小写）算出是 `DO_NOT_TRUST` 时，只报这一条
  `launchUnaffected` 的结果，检查页沿用「自己开终端……不会用当前账号，从本软件打开不受影响」那句（需留意）。
  不信任时 Gemini 不读 `~/.gemini/.env`、也不读项目里的 `.gemini/settings.json`（沙箱里假 HOME + 本地假接口跑过
  0.62.0），所以那两样这时不再另报；以前项目 settings.json 换了登录方式会报成「待处理」并在打开时弹提醒，
  其实打开不受影响。没记过的文件夹不报（交互界面第一次进来会先问）；用户级 settings.json 关了
  `security.folderTrust.enabled` 时不报。
- Codex 后台服务：`config-files.ts` 新增 `codexDaemonAutoStartSetting` / `inspectCodexDaemonAutoStart`，读
  `[features] daemon_auto_start` 与顶层 `profile` 选中的 `[profiles.<名>.features]`（后者盖过前者，照
  rust-v0.160.1 / 0.162.1 `features/src/lib.rs`，缺省开）。「Codex 连接设置」接的是当前账号时，导出报告的
  details 多一个 `daemonAutoStart`（开 / 关 / 没写），检查页详情不列。只读不改。
- 画布主进程侧补五处安全口子，只改 `electron/`，`canvas-v2/` 未动。
- E-S4 剩下的一半：`canvas-host:save-file` 的保存框只给「星芒画布项目」一种类型，画布提议的文件名一律补成
  `.xingcanvas`。画布同时决定内容，原来能提议 `readme.cmd` 配脚本内容，让用户存下一个双击就跑的文件。
- E-G2：`platform/preload.ts` 只在主窗口的 `xingmang://app/` 和本机 Vite 开发地址上暴露
  `window.xingmangPlatform`。它注册在整个会话上，画布窗口和画布沙箱探测页原来也拿得到。
- E-G6（#89 ⑭ 剩下的一半）：`canvas-host:start-run` 和三条直连生成共用同一个每分钟 80 次的频率窗口，
  被投毒的画布不能靠不停提交运行慢慢烧余额。
- E-G9：一次运行里所有节点提示词合计超过 20 MB（和画布能保存的工作流上限一致）就报「工作流规模超过安全上限」，
  原来 5000 个节点各 10 万字能让主进程一次吃下约 1 GB。
- E-B8：`canvas-host:notify` 每 5 秒最多弹一条，标题和正文里的链接去掉，标题只剩链接的不弹。
- 画布认默认图片、视频分组的规则跟上 xm 站 2026-10 的分组改名（新名字去掉了「中转」）：老名字在时照旧用老名字；
  老名字删了认新名字「图片模型」「视频模型」，再认不出就看名字里带「图片」「视频」的分组，只有恰好一个时才认。
  视频不再退到带 Grok 的分组，也不再退到列表第一个分组，认不出就留空让客户自己选。只改
  `canvas-v2/src/library/media-groups.ts` 这一处规则（项目约定画布不动，这次经 yoyo 同意破例），画布别的代码未动。
  主进程只把站上的分组列表原样交给画布，挑哪个是画布自己按名字认的，所以没法只改 `electron/`。
- 证书被换掉时的四句话照服务端 10-13 的结论改（星芒证书和各入口都没问题，中转读不到 SNI 时直接拒绝、不发证书，
  所以证书不对是路上被拦截，不是这台电脑或安全软件的事）：检查页 `certificate-trust-probe.ts` 的 `untrusted`、
  首页红条 `route-label.ts` 的 `certificate`、报错框 `registry/errors.ts` 的 `tlsIntercepted`（标题改「连接被网络拦截」）、
  首页 Key 同步横幅。新字 yoyo 10-14 回「改」。
- Key 同步被网络拦住、其中有证书被换掉（`network-failure.ts` 归成 `tls`，不含证书日期）时，
  `AccountBootstrapResult` 多一个 `networkBlockedByCertificate`，首页横幅换成「稍等一两分钟点「重新同步」」那句：
  这时电脑一直联着网，等不来 `online` 事件，原句「联网后会自动补写」不成立。整段引导抛错时按那句错误同样判。
  横幅这时一定给「重新同步」按钮；运行日志那一行也不再写「联网后会自动补跑」。
- 账号服务器（new-api v1.0.0-rc.40）改密码多了一道安全验证：`PUT /api/user/self` 要在 `X-Security-Proof` 头里带一次性凭证，没带就回 403 `SECURITY_PROOF_REQUIRED`「需要安全验证」（`controller/user.go` UpdateSelf → `middleware/secure_verification.go` RequireSecurityProof）。星芒照 rc.24 写的只发了 PUT。`new-api-client.ts` 的 `changePassword` 先 `POST /api/verify`（`{method:'password', scope:'account.password.change', password:原密码}`）换凭证，再带着它 PUT；凭证只能用一次，每次改都重新换。rc.44 和上游 main 一样。
- 原密码错时 rc.40 回的是英文：验证那步 `SECURITY_VERIFICATION_FAILED`，PUT 那步 `CURRENT_PASSWORD_INVALID`。两处都换成 rc.24 自己的「原密码错误」，渲染层 `account-errors.ts` 原有那条认得它。开了两步验证的账号只能用验证码证明身份，验证那步回 `SECURITY_PROOF_METHOD_MISMATCH`，照原话交出去，PUT 不发。
- 直连线路的白名单（服务端 2026-10-06 文档 2.1 节）没有 `POST /api/verify`：选「自动」时直连回白名单 404 会当场改走默认线路（`relay-line-fetch.ts` 原有逻辑），选「只用洛杉矶」时改密码要等服务端把它加进白名单。
- AI 对话和画布的图片分组模型精选也认 xm 站改名后的「图片模型」：`selectAiChatModelsForGroup` 以前只认
  `图片模型-中转/订阅`、`生图分组`，新名字认不出就把分组里全部模型都列出来（功能照常，只是没筛）。现在写死名单
  补上新名字，老名字照旧认；另外服务状态文件分组对照里「画图」那一项列的名字也算图片分组
  （`chat-credential-coordinator.ts` 新增可选 `loadAccountGroupHints`，和 `chat:list-groups` 共用 `main.ts` 里
  同一个读对照的函数），以后站上再改图片分组的本名，改对照就跟得上。只管星芒账号，读不到对照照旧只认写死名单。
- `electron/cli-verified-versions.ts` 三家 `recommended` 一起抬（10-12 每周巡检，yoyo 测完 0.2.18 后补做）：Claude Code 2.1.291 → 2.1.296、Codex 0.160.1 → 0.162.1、Grok 1.0.46 → 1.0.52（npm latest 且是 xAI stable）。Gemini 留在 0.62.0（2026-10-13 yoyo 说「Gemini CLI 不要了」）。区间内上游变更记录没有第三方端点回归，三家都在沙箱本地假接口重核过，依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- Claude Code 2.1.293 起 `haiku` 别名在自定义 `ANTHROPIC_BASE_URL` 下改发 `claude-haiku-5-5`（以前 `claude-haiku-4-5-20251001`），内置 `claude-code-guide` 帮手与 `/model haiku` 要中转开着这个型号，缺了不会退回 4.5；后台小请求仍用主型号。
- 随包 Codex 型号名单（`bundled-catalog/codex-models/models.json`）换成 `rust-v0.162.1`：和 `rust-v0.160.0` 比只删了每个型号里已废弃的 `"instructions_variables": null`，其余逐字相同；`codex-model-catalog.ts` 的 tag 与 sha256 同步改。
- Codex 中转配置在 `[model_providers.<名字>]` 里明写 `supports_websockets = false`（模板和合并两条路都写，用户自己写过的值不动；CLI 巡检脚本的探测配置同步）。Codex 只有这个键为 true 时才走 Responses WebSocket，缺省 false，`rust-v0.160.1` 与 `rust-v0.162.1` 源码和真 CLI 对本地假中转实测一致，所以星芒写的配置本来就走普通流式，这次行为不变。写明是防上游把自定义线路的缺省改成开：服务端 2026-10-13 统计，走 Cloudflare 的 WebSocket 约两分钟被掐断，思考久的回答报「stream closed before response.completed」，普通流式基本不受影响。换线路只改 `base_url` 一处，所以两条线路都写，不按线路分。
- Codex 官方插件目录放进星芒的腾讯云存储桶（yoyo 2026-10-13「插件目录放存储桶」，为的是以后去掉游戏加速）。
  新工作流 `sync-codex-plugins-cos`（`scripts/sync-codex-plugins-cos.cjs`，每 6 小时）先问 GitHub 接口
  `openai/plugins` 的 main 是哪个提交，变了才下那个提交的压缩包，核提交号、路径、两份市场清单（与客户端同一套规矩）
  后传到 `xingmang/offline/codex-plugins/sha256-<摘要>/`，最后改 `latest.json`。沿用 `xingmang/*` 的权限，
  不用新密钥；连续失败两次照样开 issue 报警（`cos-sync-alert.cjs` 加了这条工作流和它自己的「影响」说法）。
- 客户端新模块 `electron/codex-plugin-catalog-bucket.ts`：桶地址与清单路径写死，清单里的路径、地址、大小、
  SHA-256、类型、校验标签一处对不上就不用；不跟跳转；过了头半分钟照当时速度还要 2 分钟以上、或半分钟没数据就放弃。
  解开后照 GitHub 那一份的规矩再核，压缩包里的提交号还要和清单一致。没走通悄悄改去 GitHub，原因只进运行日志
  （`codex-plugin-catalog.bucket-fallback`）；下载加速线路改成只在去 GitHub 时才借。界面文字没有改。
- Codex 线路显示名（`[model_providers.XingmangAI]` 的 `name`）改成 `OpenAI`，表名照旧 `XingmangAI`（续接列表按表名筛，改了老对话就看不见）。新装模板直接写 `OpenAI`；合并保存和开机补模板缺省项（`relayTemplateRevision` 升到 3）只换星芒自己那张表（地址是已登记站点）上一字不差的老值 `XingmangAI`，客户自己改过的名字、别人写的表、8-26（#104）以前就叫 `OpenAI` 的老配置都不动；`config.toml` 和 `xingmang-config-relay.toml` 一起改，改前照样备份。CLI 巡检脚本（`scripts/probe-cli-relay.cjs`）写的探测配置同步改成 `OpenAI`，让探测的请求体和客户的一样。
- Codex 认官方线路看的是 `name == "OpenAI"`（区分大小写，不看地址），对上就把长对话压缩改走远程 `/responses/compact`，CLI 的 `/model` 还会多一行 base URL 被改写的红字。yoyo 2026-10-13 选大写之前，已在星芒中转上实测命令行 `/compact` 和桌面端压缩，星芒账号和历史账号都通；new-api rc.24 源码也有这条转发路由（`router/relay-router.go:104`）。调研见项目文件「Codex左下角名字/调研.md」。
- Codex 桌面端启动时读中文开关（ab.chatgpt.com）的那一个请求，先试着经星芒服务器代取，走不通才照旧连加速（#977，
  `codex-desktop-startup-route.ts`）：主进程用账号换一张短时通行票（`POST /api/xingmang-tunnel/v1/ticket`），
  在 127.0.0.1 随机端口开本机转发，经 WSS 交给服务器；拉起 Codex 时带 `--host-resolver-rules="MAP ab.chatgpt.com 127.0.0.1:端口"`，
  只改这一个主机。Windows 走 #976 实测过的两步激活（先带参数激活、再交工作区链接），Mac 给 `open` 加 `--args`。
  服务端还没部署时换票是一个 404，直接退回加速，行为和以前一样；服务端要求见项目文件 `Codex中文保持/977-核对.md` 第六节。
- 换票回 401 时续一次 access token 再试，续过还是 401 只当普通失败，不走「再 401 就清登录」那条路：代取服务坏了不能把客户登出。
- 「立刻失败」（指到本机 1 号端口，#976 实测 9 秒出界面）只在 Windows、加速明确没连上（不含超时）、系统代理对
  ab.chatgpt.com 是 DIRECT、并且实际 TLS 握手也连不上时才用：开着系统代理或 TUN 梯子的客户不会被弄成英文。
- Codex 已经开着时启动参数不生效，照旧只连加速；带参数激活报错、改走普通打开时补连加速，通道留着到期自己关
  （激活超时前进程可能已经带着参数起来了）。
- COS 星芒下载清单 `xingmang/latest.json` 多一个可选的 `history` 字段，记最近 3 个旧版本的安装包（地址、大小、SHA-256，不记 zip、blockmap 和 latest*.yml）。每次同步新版本时，被替换下来的安装包挪进去；条目原样搬，不重新上传。教程下载页在当前版本被撤回时从这里挑上一版（#961）。`schemaVersion` 仍是 1，不带 `history` 的老清单照常读写。
- `sync-published-manager-cos` 加「只补历史」选项（`history_only`，必须填标签）：从 GitHub Release 取这一版的安装包，把 COS 上同名文件完整读一遍核对，全部一致才把它记进 `history`，不上传任何文件、不改当前版本。新增的 `verifyFile` 只读不写，对象不在就报错。
- Claude Mac 离线包同步从 2026-10-07 23:14Z 起每次在 `source-resolve` 失败：官方更新接口
  `api.anthropic.com/api/desktop/darwin/<架构>/squirrel/update` 改成按芯片给更新 ZIP
  （`downloads.claude.ai/releases/darwin/arm64|x64/<版本>/Claude-<id>.zip`），而
  `claude-mac-update-source.cjs` 只认 `darwin/universal`。现在也接受**与本次查询架构一致**的
  分芯片 ZIP，另一种芯片的地址照旧拒绝。我们同步的仍是同一版本、同一 release ID 的通用
  DMG/PKG：2026-10-10 在 GitHub runner 上实测 2.31226.1 的 `darwin/universal` 下 DMG/PKG/ZIP
  都在、`darwin/arm64|x64` 下的 DMG/PKG 是 404，所以 COS 索引格式和教程页都不用改。
- 两条官方离线包定时同步（`sync-claude-official-cos`、`sync-chatgpt-official-cos`）加了
  `alert` 作业（`scripts/cos-sync-alert.cjs`）：定时同步连续 2 次失败就开一条 issue、指派给
  仓库负责人；之后的失败只改这条 issue；下一次定时同步成功就留言并关闭。手动运行不算。
  只用本次运行的 `GITHUB_TOKEN`，作业级权限 `actions: read` + `issues: write`，不碰 COS
  凭据，不接外部服务。起因是 Codex 同步 10-04～10-09 连红 17 次、Claude Mac 连红 9 次以上
  都没人发现。
- Codex 那 17 次（`verify-windows-package` 报 `operation-failed`）10-09 22:36Z 在同一个
  commit 上自己恢复，推测是官方换了包；这次没有改它的校验。
- 一键安装 Codex 桌面端、Claude Desktop 时先从星芒自己的腾讯云存储桶下同一个官方包，
  没走通才照旧走原来的路（yoyo 2026-10-10「需要从存储桶下载，因为后期我打算去掉游戏加速这个功能」）。
  新模块 `electron/desktop-package-bucket.ts`：桶地址写死；清单里的对象路径、地址、大小、
  SHA-256、类型、校验标签一处对不上就不用；不跟跳转；照当时速度还要 10 分钟以上就放弃。
  原因只进运行日志（`desktop-bucket.fallback`），界面文字沿用原来那几句，没有新增。
- Windows：Codex（`downloadCodexDesktopBucketPackage`，排在微软商店前面；桶里那一版不比本机新就跳过）、
  Claude（`installClaudeDesktopFromBucket`，排在 winget 前面）下完照旧核包身份、发布者、签名，
  且包版本必须和清单一致，装法与官网那一路共用。下好、核过却没装上时也照旧走后面几路（商店、winget
  和侧载不一定是同一种装法）；只有客户取消、取消了授权、盘满了照直报。
- Mac：Codex 用桶里按芯片的 zip，Claude 用通用 PKG（先 `pkgutil --check-signature` 核安装包签名是
  Anthropic 的 Developer ID Installer，再 `pkgutil --expand-full` 只展开、不安装，找出唯一的 Claude.app），
  解开后照旧核 bundle id、最低系统、Team ID 签名和 Gatekeeper。
  `installMacosDesktopApp` 新增 `bucket` 与 `withVendorDownloadRoute`：调用方不再把整个安装包进
  加速线路，只有问官方那一路接线路，桶那一路国内直连。
- `docs/COS-SYNC.md` 写清客户端认清单里的哪些字段；同步脚本改这些字段会让客户端全部退回原来的路。
- 生产环境的下载走 Electron 的 `net.fetch`（为了跟系统代理），它和 Node 的 fetch 有两处不一样；单测
  用的是 Node 的 fetch，所以一直没测出来（两处都在 Electron 43.6.0 上实测过）。
- 一：`redirect: 'manual'` 遇到跳转直接报「Redirect was cancelled」，不把 3xx 交回来。Git（npmmirror、
  GitHub 都会跳）、Claude Desktop 官网 MSIX 入口、npmmirror 的 Node.js 镜像，第一跳就失败。新增
  `electron/manual-redirect-fetch.ts`，`main.ts` 的 `downloadFetch` 遇到 `manual` 改走 `net.request`，
  跳转照 Node 的 fetch 那样作为 3xx（带 Location）交回去、请求当场停下，各下载照旧一跳一跳先核主机。
  其余模式、带正文的请求不变。
- 二：回应的 `url` 是空字符串。`grok-installer.ts` 的 `validateGrokArtifactResponseUrl` 拿它
  `new URL('')` 就报「地址格式无效」，Windows 上一键装 Grok 因此每次都失败。现在空 `url` 只在要下的
  地址本身在官方根地址下、https、不带端口/账号/查询/锚点时放行（请求是 `redirect: 'error'`，跳转会
  直接失败）；非空时仍要求和要下的地址完全一致。其它下载早就是 `if (response.url)` 才核。
- `ExtensionsPage`（`src/renderer-v2/pages-management.tsx`）改用页内的 `useToolOperation`：操作结果记着是在哪个工具下点的，只在那个工具下面摆出来，`clear()` 只清屏上那条（#983 顺带发现的另一半，逆向报告 B4）。共用的 `useOperation` 不动。`app-check.mjs` 加一条浏览器用例钉住。
- `ExtensionsPage`（`src/renderer-v2/pages-management.tsx`）的各个操作跑完后先比对现在选中的工具，换走了就不再按原来那个工具重读列表、重跑连接检测，留给新工具自己那一轮（逆向报告 B4）。`app-check.mjs` 加一条浏览器用例钉住。
- `relay-route-controller.ts`（#963）：星芒账号（solov）在这台电脑上还没存下过结论时，开机那一轮走 `checkFirstLaunch`：直连、默认线路两条健康检查一起查；直连查通就定直连，直连没通、或默认线路已查通而直连 `relayRouteFirstLaunchPreferDirectMs`（1.5 秒）内还没回，就定默认线路，不等 `relayRouteFailureThreshold` 那三次。两条都通时定直连，不看谁先回；直连晚回来的结果丢掉，交给切回规矩。两条都不通时不改，下一轮照样两条一起查。不经 `check()`：它的 `checking` 标记一次只记一个。
- 防横跳只在开机那一轮让路：`SiteState.firstLaunch` 在 `settle()` 里清掉，之后照三次阈值；开机先定的直连查通了也存成结论（以前线路没变就不存，下次开机又会当成全新安装）；没查过的那条直连不随别的站一起存下。
- 历史账号（solov-api）不变，照旧先走默认线路、连查三次。
- 全新安装那次改走默认线路记 `trigger: 'first-launch'`，检查报告写「第一次开机查到洛杉矶线路没连上，改走 CF 线路」，不说「连着 3 次」。`RelayRouteChangeReason` 没加新值（落盘格式不变）。
- `relay-line-fetch.ts`：`/api/verification`、`/api/reset_password` 这两个 GET 每发一次服务端就寄一封信，`new-api-client.ts` 的 `idempotent: false` 传不到 fetch 这一层，以前在直连上失败（连接被重置、网关网页）或等回话时线路改了都会被掐掉改走默认线路再发一次。现在照写请求办：线路改了不掐，只在证明没送到时重发。
- Gemini CLI 下线（yoyo 2026-10-14）：界面不显示、不再装、不再签 Key、不再改它的配置，老客户电脑上的不卸不删。
  `catalog.ts` 加退役名单 `retiredProviderIds` 与 `activeProviderIds` / `isActiveProviderId`，`gemini` 仍留在
  `ProviderId` 里：本机 Key 缓存、备份清单、卸载时收回钩子都按它认老数据，拿掉会把这些一起弄坏。
- 主进程「替每个工具做点什么」的地方改走 `activeProviderIds`：扫描（快照里 Gemini 是 `retired: true` 的占位，不起进程、
  不查 npm）、签 Key（new-api 与 Sub2API 都不再签，历史账号没有 Gemini 分组也不再报失败）、跟线路、补设置、开机修钩子、
  工具额度与用量、检查页各项（Gemini 的五个环境变量、个人文件夹信任、`CLI_GEMINI` / `PROVIDER_GEMINI` 都不再出）、
  反馈报告、扩展列表、对话记录列表、托盘、Linux 启动器。IPC 动作通道收到 `gemini` 一律按原有的「未知的 CLI 类型」等文案拒绝；
  备份页不再列 Gemini 的旧备份，也不让恢复（文件留在磁盘上）。读老数据、脱敏、卸载收回的地方照旧认四家。
- 新界面（`src/renderer-v2/`）：注册表去掉 Gemini，首页、新手引导（连同只为它存在的 Python 那一步）、扩展、记录、备份、
  账号页工具额度与用量、Ctrl/⌘ + 数字快捷键都只剩三家；主进程数据里带着 `gemini` 也一概不认，密钥页不再给它的 Key 标「在用」。
  `check:v2` 的 testId 对照逐条放行冻结旧界面里的 `guide-route-gemini`，新界面再出现它反而报错。
- 开机后在后台收回星芒以前写进 `~/.gemini/settings.json` 的做完提醒（`xingmang-notify` 钩子）和星芒画图
  （`mcpServers.xingmang-image`），Key、线路、型号不动：`config-files.ts` 的 `inspectRetiredGeminiIntegrations` /
  `removeRetiredGeminiIntegrations`（留 `.bak`，配置读不懂就不动），`system-service.ts` 的
  `reclaimRetiredToolIntegrations`（Gemini 开着或看不出开没开就等下次开机）。登录时不再往 Gemini 里登记画图工具。
- 拿掉只为 Gemini 存在的「让这台电脑上所有终端都信任证书」：删 `user-certificate-trust.ts` 与
  `diagnostics:trust-certificates-user-wide` 通道，检查页「安全证书」只剩一句结论。已经设好的那一项不收回。
- 中转实测（`scripts/probe-cli-relay.cjs`）与每周巡检不再管 Gemini；`cli-verified-versions.ts` 里它那条只为覆盖全部
  `ProviderId` 留着，不再抬。
- Gemini CLI 在同一版下线（`gemini-cli-retired.md`），星芒不再打开它，原来的「用户」说明一并拿掉。
- `config-files.ts` 的 `trustGeminiWorkspaceInTrustedFoldersText` 找已有条目时按 Gemini CLI 0.62.0
  `normalizePath` 的规矩比：win32 与 darwin 不分大小写。以前 macOS 上的 POSIX 路径照原样比，对不上
  Gemini 写下的全小写键（`/users/alex/app`），于是在后面再加一条原大小写的 `TRUST_FOLDER`；Gemini 读回来
  同一文件夹后一条算数，客户选的 `DO_NOT_TRUST` 就被翻了，之后在 Gemini 里再选一次「Don't trust」也翻不回来
  （沙箱里把平台设成 darwin、用 0.62.0 自己的 `setValue` / `isPathTrusted` 跑过）。Linux 上 Gemini 分大小写，
  照旧。已经被翻过的文件不回头改。
- #28：`update-feed-stats` 多一节「下过新版安装包的电脑后来怎样」：按来源 IP 和系统，把每台电脑第一次从 Cloudflare 下这段时间里
  最新那一版安装包（Windows 的 Setup.exe、Mac 的 zip）的小时，和它之后读 `service-status.json` 时的版本对上，分成装上了、还没装上、
  没再出现三种，各写占比。状态文件也按小时分组，每台电脑按最后那个小时的版本算。
- 摘要页每次都写「口径」：Mac、Linux 各版本都读 Cloudflare 这份，数字可信；0.2.18 起 Windows 走洛杉矶线路的更新和状态文件改读
  xm-direct.solov.cc，Cloudflare 数不到，所以 Windows 的 0.2.18 及以后偏低、旧版本偏高。`docs/SERVICE-STATUS.md` 同步。
- #28：`docs/RELEASING.md` 第 8 节加上「放量停住 / 撤回 / 退回」挑哪一招的表，以及退回管不到的几处（退到加签名之前的版本要靠 GitHub Release
  的安装包补签、安装教程页的 COS 下载不跟着撤回和退回、0.2.18 起 Windows 直连更新地址要另外核对）。
- `docs/SERVICE-STATUS.md`：「现在能退到哪」换成 2026-10-08 的状况（线上 0.2.15；0.2.18 出事退 0.2.15 时 Windows 清单靠补签）；
  退回的旧版跟着「自动更新」开关走（0.2.12 起默认开，开着会自动装回去），原来写的「不会自动装」已经不对；补上放量中途填 0 停住、
  先填 0 观察再放开的手动灰度。
- `scripts/service-status.cjs` 的运行日志把放量 0 写成「先不自动推，只给自己点「检查更新」的人」，不再是「先给 0% 的电脑」；
  service-status 工作流「分批放量」那一格的说明加上 0 这一档。
- #28：新增 `update-feed-stats` 工作流（手动运行，只读的 `CLOUDFLARE_ANALYTICS_TOKEN`，不用 release 环境），按客户端读
  `service-status.json` 时 User-Agent 里带的版本号，从 Cloudflare 访问统计算出各版本、各系统占全部电脑的比例，写进运行摘要页。
  来源 IP 只在运行时去重，不输出；仓库公开，所以只写比例不写台数。用法与看不到的部分见 `docs/SERVICE-STATUS.md`「看各版本有多少人在用」。
- macOS 上 `runCommand` 收到 `trustedOnly: true` 直接以 `UNSAFE_COMMAND` 拒绝，不再悄悄降级成只换环境、
  不查可执行文件和 `trustedPaths`（#56，审查总表 E-G13 的 (b) 半）。今天 macOS 上没有调用点传这个开关，
  行为不变；以后要在 macOS 上用受信任执行，得先照 `resolveTrustedLinuxSpec` 补 darwin 版再去掉这道拒绝。
- macOS 打开终端改用 `open -a /System/Applications/Utilities/Terminal.app`，不再按名字「Terminal」交给
  LaunchServices 去找（#57，I14 在 macOS 上的对应）。最低 macOS 13，系统终端固定在这个位置，不做回退。
- `relay-sites.ts` 加 `relayAutoPreferredLines`、`relayAutoBackupLine`：「自动」先走哪条按站定。星芒账号（solov）照旧先走直连、备用默认线路；历史账号（solov-api）改成先走默认线路（api.solov.cc，CF）、备用直连（api-direct），yoyo 10-14「历史账号走的是 api 的 cf，直连备用」。0.2.17、0.2.18 是先走直连，和 docs/DIRECT-ROUTE-RELAY-SUPPLEMENT.md 第 5 节不一致。
- `relay-route-controller.ts`：`checkDirect` 改成 `checkPreferred`，`watch`、`checkRecovery`、`start` 都按站的先走线路办；连败三次、切回要连通 10 分钟、两次切换隔 5 分钟这些规矩不变。历史账号开机没有结论时照旧先走默认线路（未定下），第一次查通就定下并通知界面，工具配置跟着迁。`reportDirectFailure` 改名 `reportPreferredFailure`（`RelayLineRouter`、`DiagnosticsRelayRoute` 同改），只在走着先走那条时才查。星芒账号的全新安装两条一起查（`checkFirstLaunch`）不变。
- 0.2.18 留下的历史账号「直连」结论：最近一次切换不是「health-failed、改走直连」的一律当旧规矩存的，连同切换记录不认（`retireDirectFirstConclusions`）；星芒账号的结论原样用。落盘格式不变，装回 0.2.18 照样读得出。
- `relay-line-fetch.ts`：「自动」走着先走那条时没走通，改走备用那条重发；历史账号就是默认线路失败改走直连。白名单 404 只在直连上认，默认线路回的网页 404 原样交回。`createRelayObservedFetch` 对历史账号改报默认线路上的失败。
- `diagnostics.ts`「星芒 AI 网络」：先走那条没查通改查备用那条（`DiagnosticsRelayRoute.preferredLine`、`backupSite`，缺省按星芒账号）。历史账号退到直连时结论说「能连上星芒服务。默认线路这会儿连不上，已自动改走直连」。导出报告里的换线记录按记下的 from、to 说，新旧两种记录都说得对。
- 设置里历史账号线路的说明改成「自动会先走默认线路，默认线路连不上时改走直连。保存后重启星芒生效，不会切换账号。」
- `electron/macos-desktop-app-installer.ts`：Claude 的 Squirrel 更新接口 10-7 起按请求路径里的芯片给包（`releases/darwin/arm64/…`、`releases/darwin/x64/…`，2026-10-10 实测 2.31226.1，大小和 SHA-256 各不相同），不再给 `darwin/universal`。`selectClaudeRelease` 和 `allowsClaudeUrl` 只认通用包，所以从那以后 Mac 一键装 Claude Desktop 一律报「没装好」（带这段代码的 0.2.15 起都受影响）。改成认这台 Mac 芯片的 zip，通用 zip 照旧认，另一种芯片的不认。
- 新增 `packageForHardware`（只给 Claude Desktop 开）：x64 版星芒靠 Rosetta 跑在 Apple 芯片上时，按 `sysctl -n hw.optional.arm64` 装 arm64 包，和以前拿通用包时一样是原生的 Claude。OpenCode 一直是按芯片分开的包，行为不变。
- 逆向报告 B1（I13）：外接工具（MCP）失败时整个错误对象连命令参数和输出一起进日志，原来只有环境变量的值算敏感。
  `redaction-patterns.ts` 新增按参数名认的规则：`--token 值`、`--api-key 值`、`--key=值`、`-key 值` 这类写法
  （参数名以 key / token / secret / password / passwd / auth 结尾）在文本里打码；`Authorization: Basic xxx`
  这类非 Bearer 头连凭据一起打码，不再只遮 scheme 那个词。`credentialArgumentValues` 把参数数组里紧跟这类参数的
  值挑出来，`command-runner.ts` 的 `runCommand` 把它们并进显式敏感值，参数数组、退出时的输出、流式输出都按原值替换。
  `--bearer-token-env-var`、`--password-store` 这种只是名字里带词的参数不受影响。
- new-api 从 v1.0.0-rc.43 起控制台接口的 `message` 一律回英文原句，翻译交给网页前端按 `message_key` + `message_params` 去查 `web/src/i18n/locales/zh.json`。新增 `electron/new-api-messages.ts`：收了星芒调用的那些接口会回的提示（各接口的处理函数、全部 middleware、它们写到的 model），中文取上游 rc.44 的 zh.json 原句；和 rc.40 后端的中文对过，除了英文词两边的空格和几处 ID/邮箱字段名，字都一样。只收 rc.40 时就用中文回的句子：rc.40 本来就回英文的安全操作报错（`writeSecurityOperationError` 那一类）不收，升级后跟今天一样。发码限流那句用 rc.40 的「发送过于频繁，请稍后再试」，因为登录框按「频繁」认限流。安全验证中间件（`securityProofError`）回的三句不带 `message_key`，按原句另收一张小表。
- `new-api-client.ts` 的 `unwrapEnvelope` / `unwrapPublicNotice` / `unwrapLegacyBusinessEnvelope` 上屏那句先按 `message_key` 换中文，换不了（老服务器、没见过的 key、参数缺了或不是普通值）照旧用 `message`，不吞英文原句。换出来的中文照旧过 `sanitizeUpstreamMessage` 打码，`message_params` 里回显的密钥一样会被遮掉。登录被拒（`loginRejectionMessages`）和两步验证第二步的分类仍看英文原句。
- 老服务器（rc.42 及以前）不带 `message_key`，行为不变。
- npm 12 起依赖的安装脚本默认不跑，要按包放行。`buildCliInstallScriptAllowlist` 只放行离了安装脚本就装不全
  或会变样的包：Claude Code、Grok 的主程序包（钉死这次要装的版本），Gemini 的 `@github/keytar`（只拷包里带的
  预编译文件）；Gemini 的 node-pty（现场编译，Gemini 先用预编译的 `@lydell/node-pty`）和 Codex 不放行。
  全局安装走 `--allow-scripts=`；Grok 是 `npm ci`，npm 12 不许在命令行放行（EALLOWSCRIPTS），写进
  `buildCliResolutionManifest` 生成的临时 package.json 的 `allowScripts`。npm 11 及更早只认「不许跑」，
  放行名单对它们不起作用，照旧全跑，行为不变。云端照安装步骤实装：Node 26 + npm 12.2.0 / 11.20.0 下四家都装上
  并对本地假接口问通；npm 10.9.4 下 Claude、Grok，npm 9.9.4 下 Claude 照常装上（老版本不认放行写法，忽略掉）。
- 充值页切走只藏起来、不卸载，点关闭只缩到托盘，原来只在第一次进来和点「刷新」时读充值信息，
  活动撤了以后客户还看得到旧的「送 X%」，确认框的「活动赠送」也是旧的（应付金额本来就是现问的）。
  现在 `AccountRecharge`（`src/renderer-v2/pages-account.tsx`）在三处重读：切回这一分页或个人中心
  整页切回（`useReloadWhenShown`，`AccountPage` 新接外壳的 `active`）、停在这一页时窗口回到前台
  （`focus` / `visibilitychange`），两处都隔够一分钟才读，免得逐档试算撞上服务端限流；点「充值」
  时充值信息和试算一起问，确认框的赠送按这次读到的折扣算，没读到就不写赠送，读到的和页面上的
  不一样才换掉（`sameTopupInfo`，一样就不让各档重算实付）。不加新文字，不动接口。
- new-api 从 rc.40 起，发码前邮箱后缀不在白名单、或带 `+` / `.` 的别名被禁时，`GET /api/verification` 回 HTTP 200 + `code: EMAIL_ADDRESS_REJECTED` + 固定英文「This email address is not allowed by the administrator's email policy.」（rc.40、rc.44 的 `service/email_binding.go` `ErrAccountEmailRestricted`，rc.40 就是英文；rc.43 起带的 `message_key` 就是这句英文，`electron/new-api-messages.ts` 按约定不收 rc.40 本来就回英文的句子，所以升级前后都到渲染层的还是英文）。renderer-v2 `features/auth/account-errors.ts` 那条邮箱限制原来只认带 whitelist / 白名单 / alias / 别名的旧说法，碰不上这句，注册框落到兜底「发送验证码没有成功，输入已保留，请稍后重试」。现在把这句英文和上游网页 zh.json 的中文「此邮箱地址不符合管理员设置的邮箱规则」也算进去，显示原有那句「这个邮箱暂时不能用来注册，请换一个常用邮箱（如 QQ 邮箱）再试」，没写新字。
- `docs/RELEASING.md`：发布前置条件和 CI 发布两处写上 0.2.19 起每一版都分批放量（触发发布之前用 service-status 设 `<版本号> 20`，
  核对两个更新地址，观察一天后填 `none` 全部放开）。忘了先设、发版已停在第二次批准时，service-status 会不会被等批准的上传挡住没验证过，
  写明了看到 Pending 时的退法：先 Reject 上传、批完放量、再 Re-run failed jobs。
- `realm-account-service.ts` 的 `removeSavedAccount`：本机删掉之后，用一个不接身份的客户端拿库里那份
  凭据调现成的 `endSavedSession`（同 #476 重登覆盖旧凭据时的 `POST /api/user/auth/logout`），
  不等、不报错；本机没删成（当前账号、存储出错）就不发。历史账号（api 站）的后端没有这个接口，照旧只删本机。
  补的是全面检测 Q11 剩下的那一半。
- 工具线路探测因为证书没过时，另起一次只握手、不发任何数据的 TLS 连接，读出对面实际给的证书
  （`tool-path-probe.ts` 的 `inspectPeerCertificate`）。颁发者、证书名、SHA-256 指纹和 Node 的校验结果
  记进 `relay.route.check-failed`，跟失败标签放在一起；连的 IP 按需求 5.1.9 不进日志，只进反馈报告
  「运行环境」段新增的「工具线路证书没过」几行。服务端 10-13 查过：星芒的证书和各个入口都没问题，
  中转读不到 SNI 时直接拒绝、不发证书，所以指纹对不上正版就是路上换了证书。正版指纹不写死，证书大约三个月换一次。
- `tool-route-controller.ts` 的 `outageReason` 原来把 `tls`（握手做到一半出错：EPROTO、ERR_SSL_*）和
  `certificate` 一起归成「安全软件接管」。需求 5.1.5 第 5 条只让证书错误这么说；工具同路径探测本来就同时信
  系统根证书，把根证书装进系统的安全软件会算通过。现在 `tls` 和 `reset` 一样归「网络掐断」，`certificate`
  照旧。
- Windows CI 的 vitest 分片从两片切成三片（`test:vitest:1/2/3` 改用 `--shard=i/3`，`quality.yml`
  的矩阵加一个 `vitest-3`）。两片已经长进预算里：#955 上一片跑了 897.94s，对着这里的 900s，
  6329 条用例**全部通过**后在收尾时被掐断，红的那一下说不出任何关于代码的事。三线路四个 PR
  与 #954 都往这两个 runner 上加了套件。
- 超时**没有调大**，照浏览器分片那段注释定下的规矩办：接近预算就再发一个 runner，而不是把数字
  改大——那个数字是用来发现卡死的，调大等于削弱它。一片应落在 10 分钟上下，哪天某一片逼近 15
  分钟，再发第四个。
- `ci-workflow-config.test.cjs` 的穷尽性检查跟着从 2 改到 3（它会断言 `test:vitest:4` 不存在，
  所以漏加矩阵项会红），三处把 vitest 分片称作「half」的注释改成「shard」。
- `electron/node-runtime.ts` 的 `parseNodeReleaseIndex`：nodejs.org 的 `index.json` 从不列 `win-arm64-msi`（2026-10-13 核过全部版本），可 v19.9.0 起列了 `win-arm64-zip` 的 165 个版本，`SHASUMS256.txt` 里都有唯一一条 `node-vX-arm64.msi`。ARM 电脑上 winget 失败后退到 MSI 那条路永远挑不到版本。现在 Windows arm64 认 `win-arm64-msi` 或 `win-arm64-zip`，下载后仍照查 SHA-256 与 OpenJS Foundation 签名。x64 与 macOS 不变。
- Windows 上 WorkBuddy 不再一键安装（yoyo 2026-10-13「WorkBuddy 改成客户自己下载」），星芒只管认出来和写配置。
  `external-client-runtime.ts` 的 `windowsWithoutWinget` 换成 `windowsInstallRoute`：WorkBuddy 不论有没有
  winget 都给 `installSupported: false`、说明「到腾讯官网下载安装，装好后回来重新检测」和下载页
  `https://www.workbuddy.ai/`（加进 `externalClientOfficialDownloadUrls`，`main.ts` 外链白名单随之全等收录）。
  Windows arm64 照旧「暂不支持」，Mac 照旧「安装指南」。
- 去掉 WorkBuddy 的 winget 安装和星芒自己下腾讯安装包两条路：删除 `electron/workbuddy-installer.ts`
  （固定 5.5.6 与两枚 SHA-256 一起去掉）及其测试、Windows CI 冒烟里那条签名脚本，`install()` 里只剩
  Claude Desktop 有官方包兜底，`wingetSourceUnavailable` / `installerStarted` 随之删除。
- 认没认出来不变：仍看卸载记录登记的位置、`WorkBuddy.exe` 和腾讯签名，跟谁装的、装在哪个盘无关。
  `install-leftovers.ts` 保留 `workbuddy-` 两个前缀，清掉老版本下包落下的临时目录。
- 生图技能（`bundled-skills/xingmang-ai`）去掉即梦和 Gemini：`generate.mjs` 只收 `gpt-image-*`，删掉 Chat Completions 出图和 `extra_fields` 分支；`SKILL.md` / `references.md` 跟着删。画图工具（`mcp-server.mjs`）本来就只放行 gpt-image。
- 登录同步时 `syncXingmangAiSkill` 新增可选的 `fetchAvailableModels`（`ipc.ts` 接 `service.fetchAvailableModels`），拿技能的 Codex Key 和生图分组 Key 各查一次 `/v1/models`，按 `XINGMANG_AI_IMAGE_MODEL_PREFERENCE`（`gpt-image-2.5-flare` → `gpt-image-2`）挑一个写进 `config.json` 的 `model`；都没查到就不写、只进日志。
- `mcp-server.mjs` 和 `generate.mjs` 把它当默认模型；默认模型被中转明确拒了（没渠道、没定价）自动换回 `gpt-image-2` 再试一次，AI 点名的别的型号不换。说明见 `docs/NATIVE-IMAGE-MCP.md`「用哪个模型」。
- Windows 装 Grok 先从星芒的腾讯云存储桶下同一个 xAI 签名的 `grok.exe`（yoyo 2026-10-14「放桶」，为的是去掉游戏加速）。
  新工作流 `sync-grok-cos`（`scripts/sync-grok-cos.cjs`，Windows 机器，每 6 小时）问 xAI 现在的 stable，
  再读 `cli-verified-versions.ts` 里 Grok 的推荐版本，两版的 x64、ARM64 缺哪个下哪个；核 PE 头芯片和
  `Get-AuthenticodeSignature`（有效、X.AI LLC）后传到 `xingmang/offline/grok/<平台>/sha256-<摘要>/`，最后改 `latest.json`，清单留最近 12 版。
- 客户端新模块 `electron/grok-bucket.ts`：桶地址与清单路径写死；点名的版本比桶里的 stable 新、或桶里没有，就交给 xAI 那一路
  按真正的 stable 定（桶会晚一个同步间隔）；装最新版时桶里那一版不比本机新也去 xAI。清单里的路径、地址、大小、SHA-256、
  类型、校验标签一处对不上就不用。`grok-installer.ts` 下完照旧跑 X.AI LLC 的签名核对，一行没放宽；没走通悄悄改去
  xAI（运行日志 `grok-bucket.fallback`），下载加速线路改成只在去 xAI 时才借。
- Mac 一键装 OpenCode 和 Codex、Claude 桌面端一样先从桶里下（yoyo 2026-10-14「做」）。新工作流 `sync-opencode-cos`
  （`scripts/sync-opencode-cos.cjs`，Mac 机器，每 6 小时）问 GitHub 上 OpenCode 的 `latest.json`，版本变了才下两种芯片的
  `.app.tar.gz`，解开核 bundle id、版本、芯片、Team `5NZ4Q7NXJ4` 的 Developer ID 签名和 Gatekeeper 后传到
  `xingmang/offline/opencode/`。客户端 `desktop-package-bucket.ts` 认这份 `files` 清单，`macos-desktop-app-installer.ts`
  用 `tar -xzf` 解开后照 GitHub 那一路核；没走通改去 GitHub。
- Mac 装 Grok 不再先问 x.ai 的 stable，只问 npm（同 Linux）：`resolveCliInstallRelease` 去掉 Grok 的 stable 上限分支，
  Mac 的「最新版本」也改读 npm。npm `latest` 就是 xAI stable，二进制签名照旧核。
- 两条新工作流沿用 `xingmang/*` 的权限和 `cos-sync` 环境，不用新密钥；连续失败两次照样开 issue 报警
  （`cos-sync-alert.cjs` 加了这两条和它们的「影响」说法），`cos-sync-utils.cjs` 的可覆盖名单加了两份 `latest.json`。
  界面文字没有改。
- AI 对话图片分组的模型精选（`ai-chat-protocol.ts` 的 `IMAGE_GROUP_MODEL_ORDER`）加上 `gpt-image-2.5-flare` 和
  `gpt-image-2.5-sunburst`：xm 站两个分组都开了这两个型号，以前「图片模型」分组被精选名单筛掉、下拉列不出来。
  排序照星芒AI生图（#999）的取舍：flare 第一、gpt-image-2 第二、sunburst 第三。「GPT」分组不走精选，本来就列得出。
  画布的下拉只列它自己预设表里有的型号，不受影响。
- AI 对话画图的默认模型跟星芒AI生图一致：分组里有 `gpt-image-2.5-flare` 就默认用它，没有照旧 `gpt-image-2`
  （渲染层 `DEFAULT_IMAGE_MODELS`，`resolveChatModel` 的首选改成可传一串）。对话里记住的模型照旧优先，
  已经在用 gpt-image-2 的对话不会被换掉。两者按张计价一样。
- `buildImageGenerationRequest` 把 `gpt-image-2.5-*` 也按 gpt-image-2 换算 2K/4K 尺寸（与生图技能的
  `isGptImage2` 一致）；以前它们在界面上能选 2K/4K，请求里却仍是 1K 尺寸。
- 注册框「获取验证码」失败的几种原话分开说（`src/renderer-v2/features/auth/state.ts` 的 `verificationMailFailure`，只管「发送验证码」这一步）：
  发信邮箱回的 5xx 加 user / mailbox / recipient 和 not found / unknown 这类词、`User does not exist`、`No such user`、`Please enter a valid email address`
  说「这个邮箱地址收不到信」；其余 SMTP 码、`dial tcp`、`EOF`、`short response`、`SMTP 服务器未配置` 说「验证码邮件没发出去，不是你这边网络的问题」，
  两种都只给「找客服」；`550 Mailbox not found or access denied` 分不出是收件人还是发件人被限制，归后一种。以前前一种被服务端那张表里登录的那条
  说成「用户名或密码错误」，`dial tcp …: i/o timeout` 被宽正则说成客户网络，主进程的「发送邮箱验证码失败，服务返回 HTTP 403」因为带着「验证码」
  被说成验证码不对。这一步认不出的原话（直连回了别的服务的 `Not Found`、`net::ERR_HTTP2_PROTOCOL_ERROR`）兜底改成叫客户「再试一次」或
  「切换连接线路」。限流、邮箱已注册、后缀不让用、没网、超时、证书照旧；别的动作的兜底不变。依据：`注册发验证码失败/原因核对.md` 第七、八节。
- 换账号「同步到工具」只管命令行工具（`account-switch-sync.ts` 跳过桌面客户端，已知37），说明下面加一行出路
  （`SavedAccounts.tsx` 的 `accountSwitchDesktopClientsHint`，Linux 上首页不列这几个客户端，不出）。真的让它们跟着换要改切换逻辑，没做。
- Codex 桌面端中文没核对上时，右下角那句不再拼底层原话（`未找到可注入的页面：The operation was aborted due to timeout` 这类），
  中文通道没开起来和开了没核对上两种都换成同一句固定的话（`codex-desktop-service.ts` 的 `codexDesktopChineseUnverifiedMessage`）。
  原话改记运行日志 `codex-desktop.chinese-locale.unverified`（新的 `withCodexDesktopLocaleFailureReport`，和启动那步的
  `withCodexDesktopCdpFailureReport` 同一个做法），以前打包版只打到控制台、不留。
- 插件页两句不再说插件目录「要从国外的网站下载」：#986 起先从星芒存储桶下，桶和 GitHub 两路都没下来才报
  （`pages-management.tsx` 还没下载时那张卡、`codex-plugin-catalog.ts` 的 `codexPluginCatalogNetworkMessage`）。
- 首页工具行名字下面那行小字改成「线路：洛杉矶 · 版本 · 模型」：那一栏最宽 200，以前线路排最后，版本带推荐说明或模型名一长就被省略号截掉
  （`ui/core.tsx` 的 `ToolRow` 加 `route?`，`Home.tsx` 把 `toolRouteLabel` 从 `model` 里拆出来传给它）。现在被截的换成模型名，鼠标停上去照样看整句。
- 连接线路在界面上只叫「线路1」「线路2」，不再说「洛杉矶」「CF」「直连」「默认线路」（yoyo 10-14「默认直连是线路1 然后洛杉矶加速是线路2 香港加速是线路3」）。
  两个账号按入口对应：默认那条（xm / api，CF）是线路1，直连那条（xm-direct / api-direct，洛杉矶）是线路2，客服对报告时同一个名字指同一种入口；
  香港那条还没上线，界面上没有它的名字，上线时叫线路3。星芒账号「自动」先走直连，所以说明是「自动会先走线路2，连不上时改走线路1」；
  历史账号先走 CF，是「自动会先走线路1，线路1连不上时改走线路2」。两组选项都是线路1 在前。
- 改到的地方：首页工具行的线路标签（`route-label.ts`，名字里带「线路」，前面不再加「线路：」，认不出的地址照旧「线路：其他地址」）、
  首页「网络把地址指到别处」那句、设置和登录框里两组线路的说明和选项（`connection-routes.ts`，两个账号共用一套选项名）、
  检查页「星芒 AI 网络」的结论和导出报告里的线路名（`diagnostics.ts`，`describeRelayRouteChange` 去掉不再用的 `siteId` 参数）、
  反馈报告的「连接线路」「工具线路」「工具线路证书没过」（`feedback-environment.ts`）、工具线路报告（`tool-route-status.ts`），
  以及反馈页运行日志里讲这两条线路的几句（`relay-route-controller.ts`、`tool-route-controller.ts`、`relay-line-fetch.ts`、`main.ts` 的更新检查退回）。
  事件名、设置里存的 `direct` / `primary`、报告的键都不变，老设置照旧认。「更新下载停住了，换直连重下一次」的「直连」是不走代理，没改。
- 设置顶部搜索加「线路1」「线路2」两个词，「洛杉矶」「CF」「直连」留着给看旧教程的人搜。v4 原型设置页那两组线路文字同步改掉。
- Codex 的两处型号列表不再列 grok-4.6：首页「换用别家模型」的单选列表，和 Codex 配置弹窗「默认模型」下拉（`model-filter.ts` 的 `isHiddenCodexModel`，配置弹窗只对 Codex 过滤）。服务端 2026-10-16 实测 grok-4.6 写不对 Codex 改文件用的补丁格式，选了改不成文件，Grok 只放 grok-4.7；yoyo 同日定列表里藏掉、不加字。密钥能用的别家型号只剩 grok-4.6 时，「换用别家模型」照「当前密钥没有别家模型可用」处理。已经配成 grok-4.6 的不改；Grok 命令行用它自己的改文件工具，默认型号仍是 grok-4.6，不受影响。
- Codex 切到官方账号不再删掉中转那张 `[model_providers.<表名>]`，改成同名写一张走官方登录的表：`name = "OpenAI"`、`wire_api = "responses"`、`requires_openai_auth = true`，不写 `base_url`。Codex 续接旧对话时用的是对话开始时记下的 `model_provider`（app-server `merge_persisted_resume_metadata`，rust-v0.162.1），配置里没这个表名就报 `Model provider \`OpenAI\` not found`、整段对话打不开；表名 `OpenAI` 的是星芒第一次写配置时电脑上已经有 config.toml 的客户，从零写的是 `XingmangAI`，两种都中。不写地址时 Codex 按 auth.json 选官方默认地址（ChatGPT 登录走 chatgpt.com/backend-api/codex，API Key 走 api.openai.com/v1），显示名正好是 `is_openai()` 认的 `OpenAI`，和内置官方线路一样；这张表和 2026-10-15 客户自己在 Codex 桌面端上改好、旧对话接着回了的那张一字不差（写死 api.openai.com 对 ChatGPT 登录报 `Missing scopes: api.responses.write`）。切回当前账号时照旧用 `xingmang-config-relay.toml` 恢复原样；那份没了时 `codexRelayProviderFor` 优先接回这张表的表名，旧对话跟着回中转。新加一张表时接在官方配置原文后面，客户的注释和排版不动；同名表是客户自己写的不动；以前快照里留着的星芒中转活表换掉；在官方账号上重置时表名从 `xingmang-config-relay.toml` 里找。这次以前就切到官方的客户：开机补设置那一轮（`fillToolTemplateDefaults`）对记着官方账号的 Codex 补这一张表（`restoreCodexOfficialAlias`），只加这一张、先备份、Codex 开着就等下次，与补模板缺省项同一套规矩。沙箱用 Codex 0.162.1 app-server 实测：切官方后 `thread/resume` 成功、新一轮请求和内置官方线路一样发去 chatgpt.com、中转收不到；切回后接着发到中转；模拟老版本删表后报 not found，开机补表后又能打开。
- Codex 中转配置的 `supports_websockets` 改成按型号写：GPT 型号 `true`（#992 写的是 `false`），首页「换用别家模型」选了别家型号写 `false`。新装模板、合并、开机补写三条路都写，两条线路写一样的值。写过的值正好是星芒按上一个型号会写的那个，就跟着这次的型号改；对不上的当客户自己定的，不动。开机补写跟着把 `relayTemplateRevision` 升到 4，0.2.18 升上来的老配置开机补一次；CLI 巡检脚本的探测配置同步。型号怎么算 GPT 跟渲染层 `isOpenAiModelId` 一致，测试钉住。
- 原因：2026-10-16 服务端在 xm 两条线路的 GPT 分组和 api.solov.cc 开了 Responses WebSocket，实测同一连接里后续每轮上传从约 118 KB 降到约 400 字节，5 步任务 21.8 秒对普通请求 47 秒；yoyo 同日定默认开。服务端只给 GPT 渠道开了，这一项又对整条线路生效、不能按请求分，所以只在用 GPT 型号时开：星芒账号签进 GPT 分组、历史账号签进 `Codex_pro`，别家型号的渠道不收 WebSocket。
- 走 Cloudflare 时一轮里约 100 秒不出字，WebSocket 会被当成闲置掐掉，Codex 重连 5 次才退回普通请求（10-13 模拟，服务端 7 天数据约占 0.27%）。服务端让 CF 入口对 `GET /v1/responses` 的 WebSocket 握手回 426，Codex 0.162.1 收到当场改走普通请求、不重试，洛杉矶照常用 WebSocket；只对这个路径回，星芒 Codex 桌面端中文通道 `/api/xingmang-tunnel/v1/ab-chatgpt` 不能一起挡。新开对话和接着聊旧对话各有一次预热请求，用量明细里多一条输出为 0 的记录（走 CF 收到 426 时不预热）。服务端 10-16 12:40（北京时间）起已就绪：xm.solov.cc 对 WebSocket 握手回 426，api.solov.cc 单个 Key 的连接上限 64 → 512（它的 CF 入口暂时没回 426，服务端在观察）；发版后告诉服务端一声，他们看用量和断开情况。「用户」两句是 yoyo 2026-10-16 批的原文（回「说明改」）。
- Mac 上 Codex 桌面端的中文检查不再要求 Electron Framework 里的系统中文包（`electron/codex-desktop-locale.ts`）。
  ChatGPT 26.1007 起（Powered by Codex & OWL）Mac 包里没有 Electron Framework.framework，网页界面和菜单的中文
  照样在 app.asar 里，以前三样缺一样就算没有中文，「检查中文界面」一直说缺少中文资源、「启用中文界面」一直报
  「当前 Codex Desktop 安装包没有本地简体中文资源」。Windows 照旧三样都要。
- `src/renderer-v2/operation-error.ts` 的 noBalance 规则补认 Sub2API（历史账号站）余额用完的原话
  「Insufficient account balance」和错误码 `INSUFFICIENT_BALANCE`。历史账号余额为零时，签好的 Key
  拿去查模型就被拒，「改用当前账号」（首页、引导第 3 步）和登录后自动写 Key 失败以前只上屏
  「操作没有完成」加英文原话；现在按余额用完给「余额已用完」和「马上充值」。主进程行为不变：
  这一步失败时配置没有写，原来的（例如 CC Switch 的）照旧留着。
- UI v4 批01 底座：`ui-spec/tokens.css` 换成 v4 两套配色（黑金深色、晨曦金浅色），加 v4 语义变量
  （`--pri`、`--gold`、`--focus`、`--pop`、`--toast`、状态文字 `-tx` 等）；高对比改成每套主题一整套值，
  `contrast-tokens.test.ts` 加查它覆盖了主题的每个变量、状态文字 4.5:1、焦点环和输入框边 3:1。
  主窗口不再设 `data-skin`，设置里的 `uiSkin` 字段照旧存（删了会被当成第一次启动），皮肤规则只留给画布。
- 缩放下限：自动倍率 0.9、最终倍率 0.85（`UI_AUTO_MIN_ZOOM` / `UI_MIN_ZOOM`，`e2e/renderer-v2-native.mjs`
  的副本同步）。
- `ui/modal.tsx`：标题去掉图标，副标题挪到标题下面一行；有修改时关闭不再整块换成确认页，表单留着、底部换成确认条，
  条在时再关会抖一下。Esc 改在 keydown 上处理：Chromium 连按几次 Esc 后 `cancel` 事件不能再拦，`<dialog>`
  会绕过 React 自己关掉，草稿丢了、调用方还以为开着。
- `ui/feedback.tsx` 短提示挪到右下角、带图标；`ui/guidance.tsx` 导览气泡宽 264、带箭头、给目标描金边，
  侧栏两步放在目标右边（`registry/shell.ts` 的 `placement`）。
- 窗口失焦或被挡住时根节点挂 `data-window-idle="true"`（`features/app/window-idle.ts`，`main.tsx` 里挂上），
  转圈和骨架屏的循环动画据此暂停；后面各批新加的循环动画挂这一条就行。底座里新加的动画（短提示进场、
  确认条抖一下）都是一次性的，只动 transform 和 opacity。
- 界面文字照 `界面文字/批01-底座` 改（yoyo 2026-10-15 回「全部按推荐改」）：主题选项改叫浅色 / 深色，去掉外观说明和
  皮肤那一行（设置搜索的「主题」补关键词配色、皮肤），高对比说明去掉「皮肤」；缩放快捷键提示、退出登录确认、
  没保存确认条换成字表里的句子。导入设置时不再问「界面皮肤」：这台电脑没改过照文件换，改过就留着（`electron/data-transfer.ts`）。
  `SettingRow` 没有说明时不再留一个空段落。
- UI v4 批02 外壳（`features/shell/Shell.tsx`、`styles/shell.css`）：标题栏并进 44 高的顶栏，侧栏 224 / 60、导航行 34（逻辑高
  不到 660 时 30）、状态栏 28；`ui-spec/tokens.css` 加外壳用的 `--nav-on`、`--nav-on-sh`、`--edge`、`--glow`、`--sh-2`、
  `--track`、`--status`，`styles/tokens.css` 的高对比两套各补一份。登录前的标题栏（`AuthWindow`）照旧，高度跟着变量变成 44。
- Windows / Linux 系统三键那条：`electron/window-presentation.ts` 加 `WindowChrome`，旧回滚界面 36 高、原来的颜色；新界面在
  `installRendererV2Platform` 里建窗口之前换成 `v4WindowChrome`（44 高，颜色取 `--win` / `--bg` / `--text-2`，测试对着
  `ui-spec/tokens.css` 钉住）。高度统一走 `titleBarOverlayHeight(zoom)`，90% / 110% 是 40 / 48；换深浅色时不再写死 38，
  免得放大时那一条先缩回去一下。建窗口时的初始高度也从 38 改成跟缩放那处一样的 36（旧界面）或 44（新界面）。
- 侧栏按 `registry/shell.ts` 的新结构排：三组（第二组带「扩展」小标题），第三组里的「充值」是个人中心充值页签，余额按最近
  7 天用量不够 7 天时后面挂「余额低」；游戏加速、安装卸载、备份、更新过渡期收在「更多」，在这四页时「更多」自己展开。检查后面
  挂待处理项数（`environment-status.ts` 加 `issues`）。
- 账号卡：套餐、余额、进度条、「约还能用 N 天」（`features/app/balance-runway.ts`，最近 7 天用量走 `useRunwayUsage`，换账号
  读一次、之后最多十分钟一次）；卡上不再放充值、切换账号；余额刷新键只在读失败时出现。
- 顶栏：当前位置（个人中心带页签名，`pages-account.tsx` / `pages-business.tsx` 把当前页签报上来）、搜索框、深浅色 / 公告 / 帮助
  三个图标键。深浅色键走现有的保存外观。公告改成铃铛下面的小框（`Announcement.tsx` 的 `AnnouncementPopover`，顶层
  `popover="manual"`），点一条或旧式单段公告才开原来那个大框，小框换大框时不重新读、不丢选中的那一条；铃铛来回开关。打开那一帧就显示「正在读取公告」，
  不再先画出上回读到的列表、清空、再出新列表。
- 状态栏：加 Node.js 版本、「已装 N 个工具」，网络位置只写国家（`networkStatusLabel`）、加速时写线路，版本号带有新版本 /
  重启后更新；不加 backdrop-filter。断网条按钮改叫「重试」，点了还是不通给一句提示。
- 命令面板 560 宽、键帽提示，空输入先列「操作」组（充值、查看用量账单、开始检查、帮助与客服、切深浅色、退出登录），
  命令面板「开始检查」打开检查页（打开就跑一次），人已经在检查页时让它重新挂一次、再跑一次。导览三步去掉标题。窄窗口（逻辑宽不到 1280）不再把侧栏浮在页面上展开，
  点「展开侧栏」只提示一句，用户自己的展开 / 收起记录不动。
- 开机提示卡从右上角（顶边 64、压着顶栏下沿）挪到正文左下角、状态栏上面：标题栏并进顶栏以后，右上角是顶栏图标和
  Windows 系统键，往下就是各页页头的主按钮，原来的位置会盖住检查页「重新检查」这些；右下角留给短提示和更新通知。
  外壳把正文左边写进 `--v2-content-left`。详情抽屉上下边改跟 `--topbar-height` / `--statusbar-height` 走。
- 界面文字照 `界面文字/批02-外壳` 改（yoyo 2026-10-15 回「全部按推荐改」）；页面名「反馈」改成「反馈与客服」；`registry/pages.ts` 里画布名字
  后面那个只给注册表看的「 ↗」去掉（侧栏一直画的是图标）。浏览器测试跟着新结构改：公告的关闭和重新读取改成点铃铛收起再打开，登录前标题栏 44，
  窄窗口改测提示和记录不动，余额刷新从首页余额卡开始；切换账号改从个人中心页头打开切换框（`e2e/realm-account-smoke.mjs`
  这个 Windows CI 冒烟也跟着改），个人中心「我的账号」里也列着已保存的账号，框里的东西在框里找。
- UI v4 批03 欢迎登录引导。欢迎页（`features/auth/Welcome.tsx`、`auth.css`）照 v4 原型重排：`AuthWindow` 不再写标题字，
  欢迎页那条透明、右上角只放深浅色切换（和顶栏那颗走同一条保存外观）；加「用历史账号登录」（打开登录框并切到历史账号）；
  底部 HUD、整窗星空 canvas 去掉。星空改成两层 CSS 圆点（`--star`），只有一层的透明度在闪；星轨一圈三颗，整圈转、胶囊反着
  转回来，只动 transform 和透明度；窗口失焦或看不见时 `data-motion-idle` 把动画停在原地（`animation-play-state`），减少动画、
  系统要求少动画、低配电脑照旧全停。`ui-spec/tokens.css` 加 `--star`、`--ring`、`--welcome`（高对比度另配不透明的值）。`Starfield.tsx`、
  `starfield-plan.ts` 已经没人用（#1017 起主界面也不挂），连同测试删掉；旧回滚界面自己的星空不动。
- 登录、注册、找回、两步验证（`AuthFlow.tsx`）：去掉副标题，主按钮通栏放在弹窗底部，下面一行文字链接；「取消」「返回」并进
  右上角 ×，`Dialog` 加 `closeTestId` 让 × 带上原来的 `login-cancel` / `register-cancel` / `login-2fa-back`。关框前问不问只看客户
  亲手填的，记住密码自动带出来的不算。`Input` 加 `addon`，注册的「获取验证码」放进邮箱框；没点过就提交时验证码那格提示先去点
  （`validateRegistration` 加 `codeSent`，缺省 = 旧说法）。账号或密码不对时「找回密码」跟在红字那一行里。找回第 3 步「先不设」
  以后的「用临时密码登录」直接登录（两步验证账号先进两步验证），没登上退回登录框、账号和临时密码都填好。登录、注册、设新密码、
  临时密码登录成功各带一句短提示给 `onAuthenticated`。
- 新手引导（`StartGuide.tsx`）从整页改成叠在欢迎页或主界面上面的 640 宽弹窗，`App.tsx` 不再用它换掉欢迎页；四段进度条、底栏
  步数，选项两列，几种「已办好 / 还差一步」改成卡片，「试试第一句话」复制成功走短提示。Windows 装 Node.js、管理员授权、
  换新版 Node.js、改用当前账号、出错出口这些分支原样搬进弹窗，没改逻辑。没登录时第 3 步给「登录账号」、第 4 步给「去登录」
  「注册新账号」（新 `onRegister`）。
- 界面文字照 `界面文字/批03-欢迎登录引导` 改（yoyo 2026-10-15 回「全部按推荐改」）：「双重验证」统一叫「两步验证」（主进程
  认两步验证挑战的那句原话不动）。测试跟着改：欢迎页的画布像素检查换成「有 CSS 星点、没有 canvas」（`e2e/renderer-v2-native.mjs`
  一起改），星轨转角测试真的去转轨道，加失焦停住、深浅色切换、未登录引导、临时密码直接登录这几条；整页回归里
  引导开着时不再去点底下的欢迎页。
- UI v4 批04 首页（`features/tools/Home.tsx` 整页重写，`app.css` 换掉旧首页两栏的样式）：顶部大卡（第一个装好的命令行工具，没有就放
  Claude Code 的「还没装」）+「接着上次」三条；余额卡金额、订阅一行、按最近用量还能用几天（`features/app/balance-runway.ts`，不到 7 天
  转提醒色）、近 7 天花费七根柱子（`features/tools/week-spend.ts`：按本机的天一天查一次看板，过完的天记住只再查今天；只给能按时段查
  看板的账号画柱子）；工具区按 `registry/tools.ts` 的 `homeToolOrder` 排七张 `ToolCard`（`ui/core.tsx` 新组件），命令行工具和外接客户端
  在一张网格里；运行环境 Node.js、Git、Python 三行加「全面检查」。旧 `ToolRow` 的第四格不再固定 72，按内容放宽、放不下时两边各自省略。
- 提示区：要客户动手的错误（写密钥失败、检测失败、线路断了、配置读不到）都摆着；重启、写密钥进度和结果、钱、线路这几条最多两条，
  剩下的位置给公告和活动（`Announcement.tsx` 加 `noticeSlot` / `noticeRoom`，用 portal 画进首页那一格，别的页不再画公告条和活动条，
  铃铛照旧）；装完要重启的提醒在首页是一条提示，别的页还是外壳上那条（`RestartReminder`，Windows 流程没动）。
- 卡片「…」：配置…、改用当前账号 / 切回官方账号、换用别家模型…、ChatGPT 账号额度…、更新到 v…、回到推荐版本 v…（新：比推荐版本新时
  先确认）、退回更新前的 v…、重新安装（新，只给星芒装的，同安装卸载页）、打开配置文件夹、查看记录、卸载…；最近打开过的文件夹、
  选择其他文件夹…、新建项目文件夹并打开也在这里。来源牌下拉切当前账号 / 官方账号 / 自己填写密钥。装失败的卡片写「没装上：原因，已撤回」，
  「看原因」打开那次的错误框、主按钮「重试」。
- 命令面板加「工具」组（`command-search.ts`）：输了字才列，装了的给「打开 X」「X 配置」，没装的给「安装 X」，按首页卡片次序排；
  `registry/pages.ts` 首页关键词补「工具卡片」「接着上次」「还能用几天」「更新工具」「回到推荐版本」「退回版本」「重新安装」「卸载工具」。
  导览第 2 步换字（`registry/shell.ts`）。
- App 侧：安装、更新、回到推荐版本、退回、卸载、重新写入密钥、取消安装、认下配置、重新检测没变化各有一句结果提示
  （`rescan-change.ts` 比较检测前后首页看得见的那些字段）；`syncAfterToolInstalled` 带回这次有没有写成密钥。
- 界面文字照 `界面文字/批04-首页` 改（yoyo 2026-10-15 回「全部按推荐改」）：Key 一律写「密钥」，状态小牌「待连接」「配置坏了」等，
  「选择其他目录…」改「选择其他文件夹…」，装好 Python 写「Python {版本} 已装好」。单元测试和浏览器测试跟着新结构改：两个工具区标题
  并成「工具」、「N 个已连接」改成看每张卡片的来源牌，`.v2-bootstrap-notice` 换成 `home-bootstrap-*` 四个 testid；加长邮箱和最长状态
  在工具行、工具卡片上深浅两套都不重叠的浏览器检查。
- UI v4 批04 补：教程（`registry/tutorials.ts`）和教程插图（`features/tutorial/TutorialIllustration.tsx`）跟着新首页换说法：
  「已配好」改成卡片左下角的「当前账号」，「连接账号」改成「待连接」小牌和「确认连接」按钮，「你的工具 / 还可以装」并成「工具」，
  「工具行 / 这一行」改成卡片，「最近」改成「接着上次」，「改用（你的账号名）」改成「改用当前账号」，「就用现在这份」补成
  「就用现在这份配置」，更新入口写成卡片上的「可更新到 v…」，「退回更新前的版本」写成「退回更新前的 v…」；命令行进阶篇第 3 步按现在的
  「打开」（用过的回上次文件夹，从没选过的直接新建，换文件夹走「…」）重写两条。
- 写密钥流程里还写「Key」的进度和失败文字换成「密钥」（`account-bootstrap.ts`、`key-sync-failure.ts`、`App.tsx`），新手引导进度条、
  首页提示条和切换账号框里看得到；「正在为 N 个已安装工具写入 Key」改成首页同一句「正在给 N 个工具写入密钥」。界面文字见
  `界面文字/批04-补-教程和写密钥`，单元测试和浏览器测试里钉着原句的地方跟着换。
- 新写的两句（yoyo 2026-10-16 回「教程改」）：Linux「第一次用」第 4 步说明改成「第一次会替你新建一个项目文件夹」（从没选过文件夹时
  「打开」直接新建，已知40）；「工具有新版本」系统通知（`electron/platform/notifications.ts`）改成「回到星芒首页就能逐个更新」。
- UI v4 批05 工具配置弹窗（`features/tools/ConfigDialog.tsx` 整个重写）：去掉工具页签，`App.tsx` 点开哪个工具就开哪个的配置；
  来源改成三张单选卡（`features/tools/dialog-parts.tsx` 的 `RadioCards`，`role="radio"` + `aria-checked`，方向键换选中），访问密钥
  改成带第二行说明的下拉（`features/tools/OptionPicker.tsx`，选中值挂在按钮的 `data-value`，每项 `tool-key-select-option-<值>`），
  `key-selection.ts` 的 `accountKeyLabel` 换成 `accountKeyDescription`，新增 `manualKeyIssue`（星芒站 `sk-` 开头、20 位以上）。
  原来的 `tool-save-detect-models` 并进主按钮 `tool-save-config`（没改动「完成」、没检测「保存并检测」、其余「保存配置」）；
  重置的确认从单独的确认框挪到「高级」里原处（`tool-save-reset` → `tool-save-reset-confirm`）。Codex 桌面端的语言与文件夹权限
  展开时读一次，「检查中文界面」去掉。保存成功的提示按 `ConfigSaveOutcome`（保存 / 重置 / 换成官方账号）写出工具名；配置弹窗只写
  文件、不做连接自检，所以不说「自检通过」。
- `ui/modal.tsx` 加 `useDialogClose()`：框里的「取消」、去别处的链接（管理密钥、查看配置备份、查看 ChatGPT 账号额度）和点 × 一样，
  有修改先亮离开条，`after` 等真关了才跑。`ui/core.tsx` 的 `Segment` 加 `activation`（Codex 界面语言选了就重开 Codex，方向键不能触发）。
- Codex「换用别家模型」改成单独的 `OtherModelsDialog.tsx`：只用工具里现在那把当前账号的密钥（主进程沿用通道，空 apiKey），
  用 ChatGPT 账号或别的来源时先走一键改用当前账号；`model-filter.ts` 的 `codexModelFilterSaveIssue` 换成 `otherModelChoices` /
  `otherModelSaveIssue`。ChatGPT 账号额度抽成 `OfficialQuotaDialog.tsx`，首页「…」和配置里都开它；配置里打开时先关配置，同一时间
  只开一个弹窗。
- 外接工具弹窗（`ExternalClientDialog.tsx`）同一个样子：标题按首页是否连好写「连接 {名称}」或「{名称} 配置」（`external-model.ts`
  的 `externalClientReady`），名称旁写版本；「保存并检测」拿得准型号（原来就配着的、Claude Desktop 认得出的 Claude）就接着保存，
  换了自己填的密钥和换来源一样清掉型号，上一把密钥替他填上的第一项不算拿得准；连好后右下角说下一步。关闭时原来的「放弃未保存的修改？」确认框换成弹窗底部的离开条（配置弹窗同）。
- 界面文字照 `界面文字/批05-工具配置弹窗` 改（yoyo 2026-10-15 回「全部按推荐改」），来源一律写「当前账号」；教程里指到配置弹窗的
  说法跟着换（「使用星芒账号」→「当前账号」、「访问密钥」、「保存并检测」、「启用中文界面」）。浏览器测试跟着新结构改（页签、
  确认框、`selectOption` 改下拉菜单），加「配置里打开 ChatGPT 额度」一条；fixture 补 `inspectCodexWorkspacePermissions` 和
  `?officialEmail=1`。`e2e/macos-visual-qa.mjs` 和 `scripts/audit/renderer-v2-gap-audit.mjs` 不再找工具页签。
- UI v4 批06 个人中心（上）（`pages-account.tsx`、`features/account/`）：九个页签并成横排六个，`registry/business.ts` 的
  `accountTabs` 只剩 overview / recharge / usage / keys / security / invite；旧页签名和页签里的一节（orders、tasks、dashboard、
  devices、change-password、edit-profile、switch-account…）进 `accountSections`，`resolveAccountLanding` 把它们落到所在页签
  再翻到那一节（`requestRowFocus`），App 的 `navigate('account', …)`、通知、教程、首页「用量账单」、顶部搜索都走它。
  页签横排，左右方向键 / Home / End 挪焦点、回车打开（手动激活）。「我的订单」成充值订阅下面一节，用量看板、调用明细、
  异步任务在用量账单里从上往下摆（怎么改版归批07），各节带 `account-*-section` 测试 id。
- 页头：头像、显示名称、铅笔「编辑资料」（新 `AccountProfileDialog`，头像和显示名称从原资料卡挪进来，改过没存会先问），
  名字下面「{邮箱} · 星芒账号 / 历史账号」（`accountHeadLead`），右边只留图标「刷新」，左上留小「回首页」（testid 不变）。
- 账号概览（新 `AccountOverview`）：余额卡（订阅余额、按首页同一算法的还能用几天、星芒账号的近 7 天花费小图，`App.tsx`
  把外壳手上的 `runway`、`subscription`、近 7 天用量经 `accountSummary` 传进来，不再多读）、我的订阅、密钥与设备、
  邀请好友、「当前登录」条（切换账号、退出登录，退出确认只说「已配好的工具会保留。」）。保存的账号不再摆在概览，
  只在「切换账号」框里。「密钥与设备」卡的把数翻完整张密钥表再数「在用」（一页最多 100 把），从别的页签切回概览时重读。
- 账号安全（新 `AccountSecurity`）：修改密码（弹窗从概览搬来，标签照字表改，主进程流程不动）、记住密码「清掉」、
  登录设备（当前设备只标「当前设备」，下线确认带设备名）、去密钥管理。两步验证这次不放（v4 方案问 3）。
- 密钥管理：顶部一行小字；行内显示 / 隐藏完整密钥（只留一把，翻页、搜索、重读就收起）和复制图标，原「显示密钥」弹窗去掉；
  「配置到工具」改成行上的下拉（`ui/floating.tsx` 的 `Menu` 加 `heading`，`MenuItem` 加 `hint`，标「在用」「未安装」
  「官方账号」，外壳经 `accountKeyTools` 给装没装、是不是官方登录；Codex CLI 和桌面端共用配置，装了哪个都算装了）；编辑弹窗分组不多于 4 个时用分段、到期改成分段
  （永不过期 / 30 天 / 90 天 / 自定日期，编辑时多「不改」）、额度分段（不限额度 / 限额）；「刷新分组」只在读失败时出现，
  点到分组、窗口回到前台照旧重读；新建成功弹窗不关、原地说「已创建」。撤销、配置确认、空状态的字照字表改。
- 邀请返利：只摆邀请码（复制出去的还是完整链接），成绩卡里「转入余额」，历史账号才有的邀请名单改叫「邀请记录」。
- 切换账号框（`SavedAccounts.tsx` + `App.tsx`）：顶上加一句说明、行尾 × 移除、底部「完成」、切换成功写「已切换到「名」
  （星芒账号 / 历史账号）」，去掉「登录状态失效时需要重新登录。」。
- `features/app/row-focus.ts`：要翻到的那一节还在藏着的页签里（个人中心切过的页签藏起来不卸）时先不翻，等页签切过去露出来
  再翻；以前会对着藏着的那一节「翻」一下，滚不过去、焦点也落空。
- 别处写着旧页签名的字跟着改（教程、找回密码两句、设备太多的报错、首页余额卡「用量账单」、记住密码清掉后的提示）。
  设备太多那句主进程 `electron/new-api-client.ts` 的 `loginSessionLimitMessage` 有一份逐字副本（测试钉着两边一样），一起改了。
  界面文字照 `界面文字/批06-个人中心页签和概览` 改（yoyo 2026-10-15 回「全部按推荐改」）。浏览器测试跟着新页签改：
  `e2e/v2-business-fixture.tsx` 加 `switcher` 参数，「切换账号」像 App 一样打开装着保存账号的框，保存账号的三条测试改在框里做；
  `e2e/realm-account-smoke.mjs` 只改了注释。
- UI v4 批07 充值订阅和用量账单（`features/account/`）：两页从 `pages-account.tsx` 搬出来，充值订阅在新的
  `AccountRecharge.tsx`（连同「我的订单」`AccountOrders`），用量账单在新的 `AccountUsage.tsx`（看板、调用明细、异步任务），
  由数据算出来的字和数分别收进纯函数模块 `recharge.ts`、`usage.ts`（带单测）。`pages-account.tsx` 原来导出的几个充值纯函数
  改成从 `recharge.ts` 转出去，引用处不用改。
- 充值订阅：左边「充值到账户余额」（快捷金额四格写到账、实付和「送 N%」，自定义金额填了就不选档位、清空回到原来那档，选中的数不在档位里也照样报价，低于最低额时框下面直接报错，
  支付方式两列单选卡），右边「本次充值」（到账、实付、其中活动赠送、充值后余额、按最近用量，余额和天数用外壳传进来的
  `summary`，跟首页同一算法），付款时右栏换成「等待支付结果」。兑换充值码从卡片改成「有充值码？」弹窗，不再二次确认。
  订阅套餐两列卡（价格 / 周期，含多少额度；跟自己生效中的订阅对上时写已用和到期），购买弹窗里余额和渠道一列单选，
  余额只在标价是美元时比够不够。「扣费偏好」下拉改成「扣费顺序」四段，只在有订阅或改过默认时出。我的订单一单两行，
  支付窗口开着的那单写「支付窗口开着」（`AccountPage` 记着开着的订单号传下去）。历史账号订单按人民币档位写「充值 ¥N」。
- 用量账单：时间范围三段。星芒账号「7 天」「30 天」每根柱子按本机零点切开单独问一次（`account-center.ts` 新的
  `spendSegmentQuery`，账号概览的「近 7 天」也改用它），不用后台按 UTC 日分的桶；「24 小时」问一次按小时的桶再四小时并一根。
  调用明细默认跟着上面的范围查。「调用明细 / 异步任务」两段切换，任务那段藏着时也挂着（任务做完照旧发通知），
  顶部搜索落到「异步任务」时先切过去。筛选全部收进「展开筛选」（`AccountFilters` 的 `primary` 传空数组时外层
  `display: contents`，按钮落在工具条那一行；收起时按钮上的数不算没动过的默认日期）。明细和任务表一行就是一个入口，
  原来的「详情」按钮去掉（`ui/core.tsx` 的 `Table` 加可选 `rowLabel`，行读屏念时间和模型）；调用详情平铺调用信息、计费明细写「N Token × 单价」；任务详情多一行「消耗（USD）」。
  明细标题旁的「消耗 · RPM · TPM」去掉。换时间范围时明细回第一页。
- 教程「充值」那步改成「有充值码的，点「有充值码？」，填好后点「兑换」。」（批06 字表批过）。
  界面文字照 `界面文字/批07-充值订阅和用量账单` 改（yoyo 2026-10-15 回「全部按推荐改」）。浏览器回归跟着新界面改，
  另加一条看时间范围、柱子和明细查询范围的；旧的 `v2-business-tier` / `v2-business-payment` 等样式随旧代码删掉。
- UI v4 批08 设置八组（`pages-maintenance.tsx` 的 `SettingsPage`、`registry/business.ts`）：组名改成四个字（外观显示、
  启动关闭、工具管理、网络加速、消息通知、备份迁移、隐私数据、版本更新），「账号」组整组去掉（切换账号、退出登录在
  个人中心账号概览，记住密码在账号安全，`settings-switch-account` / `settings-logout` / `settings-account-*` 这几个测试 id
  跟着去掉，概览上有自己的 `account-switch` / `account-overview-logout`）；新组「备份迁移」放工具配置备份和搬到新电脑，
  用户协议从版本更新挪进隐私数据。`settingsGroupIcons` 给每组一个图标；左栏「版本更新」有新版本、「网络加速」正在加速时
  带一个点（App 经 `updateAvailable` / `accelerating` 传进来）。
- 一组分几张卡改由注册表定：`settingsSections`（文字与缩放、辅助与显示、连接线路、下载与连接、提醒哪些事）+ 每行的
  `section`，`buildSettingsBlocks` 把挨着的同一小标题的行放进一张卡；页面上每一行只写一遍（`views` 按行 id），分组页和
  页内搜索取同一份。左栏「搜索设置」走 `searchSettingsItems`（几个字都要对上：标题、常用说法、组名、小标题），搜到的行
  直接摆在右边能改，上面带组名链接回那一组。`settingsItemAvailable` 不再有 `signedIn` 条件。
- 外观显示：主题换成三张预览卡（新 `features/app/ThemeCards.tsx`，预览底色写死两套配色的底色）；「语言」改叫「界面语言」、
  只写「简体中文」；新增「恢复默认外观」（主题回跟随系统、关高对比度，缩放、大字、减少动画回默认，显卡加速不动）；
  显卡加速那一行用 `SettingRow` 新的 `badge` 标「重启后生效」。`SettingRow` 另加 `wide`（控件占满标题下面一整行）。
- 网络加速：线路从 `Select` 换成三颗 `Segment`（`RelayRouteRow`），「线路已保存，等待重启」只留标题和「现在重开」
  （`RelayRouteRestartNotice`），点了先弹 `Confirm`「现在重开星芒？」，确认框关掉以后才调重开（开着的对话框会被关窗前的
  检查当成没保存的东西）；登录框「切换连接线路」用同一套，确认框正文换成说没填完的登录信息。「网络连接」改叫「连接方式」，
  「查看」后用小提示说 `当前：{summary}`（主进程的「代理路由」照旧换成「连接路径」）。
- 消息通知：测试通知那一行并进桌面通知（「发测试通知」按钮 + 总开关），提醒项顺序和说明照字表（只有余额不足、
  花费突然变多带说明，公告改叫「公告与优惠」）。其余行名和说明照 `界面文字/批08-设置八组` 改（yoyo 2026-10-15 回
  「全部按推荐改」）；别处写着旧组名的字跟着改（开机隐私提示、教程、主进程托盘提示「设置 → 启动关闭」）。
- 测试：`app-check.mjs` 的线路用例改点分段按钮、`aria-pressed` 断言，重开多点一下确认框；`e2e/v2-business.test.mjs`
  加页内搜索和恢复默认外观两条，账号组那条改成钉住八个组名；`keyboard.browser-check.mjs` 跟着新组名。
- UI v4 批09 游戏加速、备份、更新并进设置：侧栏「更多」只剩安装卸载（`registry/shell.ts` 的 `moreNavigation`）；`PageId`
  里的 `acceleration` / `backups` / `updates` 留作别名（`registry/pages.ts` 的 `settingsPageAlias`），`App.navigate` 把它们换成
  设置页加对应那一行，托盘、系统通知、教程、错误框、更新气泡的老入口不用改就落到新位置；顶部搜索不再出这三个页面结果，
  改由设置项 `acceleration` / `backups` / `version`（`settingsItems` 新增 `card: true`，`buildSettingsBlocks` 不把整张卡和别的行合进
  一张卡）带过去。设置页里整张卡外面包一层 `v2-settings-card-slot`（`data-anchor`），落到时外围闪一圈。
- 游戏加速卡（`features/acceleration/AccelerationView.tsx` 重写、`acceleration.css` 换成小卡、`Globe.tsx` 删除）：连接仍挂在 App
  上，卡只在「网络加速」组露面时挂上；线路列表换成通用 `Menu`（单选项 + 「重新测速」），`lines-controller` 新增 `measure()`
  依次重测全部线路；`acceleration-usage-total` 跟着三格详情去掉。主进程加速失败的几句里「开始加速」换成「开启加速」，
  「点「换线路」」换成「在「线路」那里」（`acceleration-development-backend.ts`）。
- 工具配置备份卡（新 `features/settings/BackupCard.tsx`，原 `BackupsPage` 删除）：时间当标题（`calendar-time.ts` 新增
  `formatClockTime`）、立即备份菜单（单独哪一家都能点，「全部工具」只备份装了的）、预览抽屉换弹窗（testId 照旧）；`backups-search` 跟着搜索框去掉。
  切到这一组时新挂上读一次，设置页从别的页回来时再读一次。「搬到新电脑」两行挪进备份迁移。
  三张卡各读各的，设置本身读不到时照样摆在各自那一组里（原来的独立页面也不依赖设置）。
- 版本卡（新 `features/settings/VersionCard.tsx`，原 `UpdatesPage` 删除，`updatesPageLead` 删除）：状态小标签走新的
  `updateStatusLabel`；气泡上「重新安装」的确认请求改成卡挂上以后再取（设置页带分组跳进来会整页重挂，旧卡不再先把请求拿走）；
  App 经 `onSettingsGroupChange` 知道人在不在「版本更新」组，在时那三种气泡不弹。快捷键弹窗按这台电脑只写 ⌘ 或 Ctrl。
- 界面文字照 `界面文字/批09-加速备份更新并进设置` 改（yoyo 2026-10-15 回「全部按推荐改」）：「重启安装」→「重启并安装」
  （含主进程系统通知那句）、教程/托盘/通知里去加速页、更新页、备份页的说法换成设置里的位置、卸载弹窗和那一行的字。
- UI v4 批10 检查和反馈与客服：「安装卸载」页拆掉（`MaintenancePage`、`features/tools/maintenance-status.ts`、`ToolStatusMeta.tsx`
  删除），侧栏「更多」和 `registry/shell.ts` 的 `moreNavigation` 跟着去掉；`PageId` 里的 `maintenance` 留作别名
  （`registry/pages.ts` 的 `retiredPageAlias`），`App.navigate` 把它落到首页；它的搜索说法挪给首页和检查页。工具的安装、重新安装、
  卸载只在首页工具卡片上，没人再叫的 `BusinessActions.onToolsChanged` 一并去掉（首页那条安装照旧走 `syncAfterToolInstalled`，R-G3）。
  安装记录改看运行日志：Codex 桌面端安装原来每一步只发给界面，现在 `system-service.ts` 的 `withCodexDesktopProgressLog` 把它按句去重
  （`codexDesktopProgressLogKey` 去掉数字比）后记成 `install` / `codex-desktop.install.progress`，失败那句照旧只由 ipc 层记一条错误；
  只加日志，安装本身没改。
- 检查页（`pages-maintenance.tsx` 的 `HealthPage` 重写）：结论一行 + 「需要处理 / 可选 / 正常」三组（新 `features/app/diagnostic-group.ts`
  分组；一个命令行工具都没装、主进程把 Node.js / npm 降成「需留意」时也归「可选」），行首 `StateIcon` 代替小标，详情就地展开；Node.js、Python、Git 那几行接上 `onInstallRuntime` / `onReplaceNode`（同首页运行
  环境卡，testId `maintenance-runtime-action-*` 照旧），Windows 上准备 Node.js 那句授权提示跟着挪过来；连接自检和 Codex 干活检查并成
  最下面一张卡，连接详情从抽屉换成就地展开，Codex 的同意从开关换成勾选。`diagnosticTarget` 不再把运行环境和证书项送去别的页（按钮就在
  这一页），CLI / npm / Codex 桌面端那几项改落首页，`FOLDER_RELOCATED` 落反馈与客服的留言页签。
- 反馈与客服（`FeedbackPage` 重写）：两个页签挂着只藏不卸（`feedbackRequest` 带序号落页签，`resolveFeedbackLanding` /
  `operationLogSection` 把「查看日志」落到运行日志）；留言表单「复制给客服」拼一段文字连同脱敏报告复制，复制完打开客服，没复制出去时
  `data-unsaved` 拦关窗口；「找客服」卡复用 `SupportIdentity`（加 `testIdPrefix`）。运行日志的「运行日志」页签带这次启动的错误数，
  清空以后读回来才写「日志已清空」。
- 帮助与客服弹窗下面换成六格（`App.tsx` 的 `helpShortcuts`），欢迎页和新手引导里只给四格；「设置里还有」「左边「更多」里还有」去掉。
- 界面文字照 `界面文字/批10-检查和反馈与客服` 改（yoyo 2026-10-15 回「全部按推荐改」）：「重新写入 Key」→「重新写入密钥」，
  「诊断报告已导出」→「检查报告已导出」，「打开日志目录」→「打开日志文件夹」，主进程几句里的「反馈」页跟着叫「反馈与客服」，
  教程里去「安装卸载」页的说法换成首页工具卡片、检查页和运行日志。
- 浏览器测试：整页回归里「安装卸载」页那十几条，能在新位置验的挪到首页卡片和检查页（安装进度与取消、安装指南落章、管理员身份不说
  授权窗口、在检查页装 Node.js），只验那一页自己分块读取、两边同步的删掉；`e2e/macos-visual-qa.mjs` 不再进那一页。
- UI v4 批11 记录页（`pages-management.tsx` 的 `SessionsPage`）：列表改成一张表（标题、工具、项目文件夹、最后活动），上面一排带数量的
  工具按钮（数取不带筛选的那份最新 100 条的 `stats.byProvider`，读不到就不写数），行上只留「接着聊」（归档的 Codex 记录是「恢复」）
  和「…」；「打开文件夹」挪进「…」，文件夹不在了那一格挂警告图标。详情从右侧 `Drawer` 换成 640 宽的 `Dialog`：头部工具和模型，
  键值五行（项目文件夹带「打开」、会话 ID 带复制），「对话开头」两边气泡、先给两条再「看全部」，删除挪到弹窗左下角，行上「…」里也能删。
  没装的工具「接着聊」置灰、悬停「要先装好 {工具}」（`pages-business.tsx` 把首页检测到的已装名单传进来，没检测完不置灰）。
  归档、恢复、删除的提示带上标题。`ListState` 加 `searchTitle` / `searchDescription`，搜不到时这一页说自己的话。
- UI v4 批11 教程页（`features/tutorial/`）：按问8「卡片」改成分类卡片入口，`registry/tutorials.ts` 的分类从 start / everyday /
  advanced 换成 start / tools / account / trouble（`tutorialCategories`），卡片图标在 `tutorialIcons`，测试钉住每篇都有分类和图标。
  读到第几步记在 localStorage（`tutorial-progress.ts`，只往前走，滚到文章底才算整篇读完）。点开还是原来的文章，上面加「全部教程」
  回卡片；顶部搜索「去教程里搜」落在卡片列表上搜，指名一篇（命令面板、技能页「看怎么放」、安装指南）直接打开那一篇。
- `ui/core.tsx` 新增 `Chips`（v4 组件规范「分类」），记录页和教程页在用。界面文字照 `界面文字/批11-记录和教程`（yoyo 2026-10-15 回
  「全部按推荐改」）；「最近 / 已归档」分段这次不做。原来借记录页验抽屉位置的浏览器测试改成验详情弹窗（抽屉组件本身的行为
  `ui/browser-check.mjs` 里还有）。删除确认第二段「先点「导出」」跟着按钮改成「先点「导出对话」」（yoyo 2026-10-16 回「字都行」）。
- UI v4 批12 扩展和精选（`pages-management.tsx`、新 `pages-featured.tsx`、新 `extensions.css`）：外接工具、技能、插件三页
  换成同一套结构：工具页签（`Tabs` 的选项加 `leading` / `meta`，放工具标志和已装数量，没装写「未安装」）、「{工具} 官方叫
  「…」」、「已装到 {工具}」按范围分组（`groupExtensionItems`，分组表在新 `registry/extensions.ts`），替掉原来的范围筛选。
  选到的工具没装时，列表位置换成「安装 {工具}」那一条，走 App 现有的 `installTool` / `toolJobs`，不另开安装路径。
- 详情、卸载确认从抽屉改成 `<dialog>` 弹窗（详情弹窗仍用 `resource-detail-drawer` 这个 testid）。启停、卸载、插件安装的
  提示点名对象和工具。MCP 需要登录的行上直接给「登录授权」，「退出授权」留在「更多操作」。
- 「自定义连接」（原「添加连接」）：名称按 `[A-Za-z0-9_-]{1,40}` 校验（Codex CLI 的规则，三家都照它，免得一个名字只有部分
  工具能用），重名在页面上拦下；参数、环境变量改叫附加参数、附加设置，收进「更多设置」；「给这些工具用」可以多选，按导航
  顺序挨个调现有的 `addMcpServer`，中途失败只留没加上的工具。没有新 IPC。
- 插件「已安装」「市场」两个页签合成一页：上面装好的，下面「星芒精选」和官方目录（Claude Code 官方市场 / Codex CLI 插件
  目录，只列还没装的）。目录的下载、安装逻辑没动（Codex 目录照旧从 COS 下，#986）。技能页选 Codex CLI 时多一条「去看插件」，
  通过 `features/app/extension-tool-intent.ts`（同 `row-focus` 的待取写法）让插件页落在 Codex CLI 上。
- 新增「精选」页（`registry/pages.ts` 加 `featured`，侧栏「扩展」组第一行，搜索词「推荐」「星芒精选」）：只放现有的 10 个
  精选（问4「现有」），类型分段只出有条目的类型，一个弹窗里选「给这些工具用」后挨个装；「推荐一个」去「反馈与客服」。
- 界面文字照 `界面文字/批12-扩展和精选` 改（yoyo 2026-10-15 回「全部按推荐改」）；字表外的句子列在 PR 里。教程「外接工具」
  「技能」「插件」三篇和示意图里的按钮名跟着改。顶部搜索里旧说法（添加连接、导入技能、插件市场）照样搜得到。
- 浏览器测试（`e2e/v2-business.test.mjs`）跟着新结构改，新增页签数量、卸载措辞、自定义连接校验和多工具、工具没装时安装、
  没装又没市场的工具只出安装条、Codex 技能去看插件、精选多工具安装、精选填文件夹八条；`testing/app-check.mjs` 两条 B4 竞态
  用例原来换到 Grok CLI，这个夹具里它没装、现在不读列表了，改成换到 Codex CLI（按工具名点页签，给 Codex CLI 自己的三份清单打桩）。
- UI v4 批13 聊天（`features/chat/ChatPage.tsx`、`chat.css`）：会话栏 236、搜索常驻、`groupConversationsByDay`（`state.ts`）按本地日历
  分「今天 / 昨天 / 更早」，条目写「N 条消息」/「正在回答…」，「…」菜单只留「导出这段对话」「删除这段对话…」，底部「清空全部对话」
  （`useChatController` 的 `clearAllConversations`，有对话在生成时不让点）；页头加「导出这段对话」。
- 分组和模型两个下拉框并成一个 `ChoiceMenu`（`ui/floating.tsx` 新组件，`align='start'`，分组那组选完不关）：分组列后台的分组名、
  说明用后台 `description`（和名字一样时不重复），下面是这个分组的模型和「N 个模型可用」，底部「刷新分组和模型」走
  `refreshGroupsAndModels`（先刷分组再准备当前分组，刷完提示可用模型数）。按钮带 `data-group` / `data-model` / `data-preparing`，
  沿用 `chat-model` 这个 testid；分组项、模型项在 `chat-group`、`chat-model-options` 两组里，刷新是 `chat-group-prepare`。打开菜单
  照旧只触发一次后台刷新分组（`refreshOnInteraction`）。画图的尺寸、画质、分辨率也改成同样的小菜单，加「画质：自动」。
- 参数从弹出层改成对话框（`ParametersPanel.tsx` 改名 `ParametersDialog.tsx`），带「没保存」确认条，点「应用」才写回；随机度、采样范围、
  两个惩罚改成 `Slider`（`ui/fields.tsx` 新组件），空值 = 不发；整数项填了小数时说「要填整数」。命令面板加「聊天参数设置」
  （`command-search.ts` 的 `chatParametersSection`，App 收到后把 `openParameters` 交给聊天页）。
- 断网时发送的提示换成聊天自己的「没发出去：…点「重试」」，横幅上的「重试」用上次那次发送的参数再发；`online-status.ts` 的共用句子没动。
- 消息：自己发的靠右、无头像、按钮悬停出现（复制 / 编辑后重新发送 / 删除消息）；回答不带气泡、按钮常驻（复制回答 / 重新生成 / 删除消息）；
  代码块头上写语言（取 `language-xxx`，没有写「代码」），复制代码提示「代码已复制」。计费小字去掉「服务端」三个字，跟「回答由模型生成…」
  同一行。切走聊天页时输入框那排菜单和对话「…」菜单重新挂一遍，开着的弹出层跟着收起。
- 教程「直接聊天与生成图片」第一步和配图说明里的「输入框上方」改成「输入框底部」；`registry/pages.ts` 聊天页的搜索词加「分组」「模型」，
  分组和模型挪进菜单以后顶部搜索照样找得到。
- 登录后主界面（`Shell.tsx`）背后不再挂 `<Starfield quiet />`。它整窗 canvas 每秒重画 10~30 次，且每个刷新周期都跑一次 requestAnimationFrame，沙箱（软件绘制）实测星芒窗口在最前面时界面进程约 8%、显卡进程约 10%，去掉后两边都降到 0.1%。v4 原型主界面本来就没有星空，yoyo 10-15 拍板去掉。`Starfield` 组件和欢迎页的星空不动；`app-check.mjs` 里钉住工作区星空帧率的用例改成钉住工作区不再有 canvas。
- gpt-5.5 两站都下架了（OpenAI 10-14 起拒绝服务，xm 和 api 的模型列表都不再列它），Codex 默认模型还是它的客户每一轮都报「该模型无可用渠道」。`cli-model-defaults.ts` 加一张下架型号表（目前只有 Codex 的 gpt-5.5）；开机那轮按账号核对 Codex 型号名单时（`tool-model-check.ts` 的 `syncPicker`），配置是本软件替当前账号写的、默认模型在表里、当前账号也确实不再列它，就先备份再换成现在的默认（`resolveDefaultCliModel`：账号有 gpt-6-astra 就是它），和刷新名单同一道写入，Codex 开着的照旧记成还欠着、关了再补。以前只在从星芒打开时问一句，从开始菜单、终端、VS Code 打开的客户走不到那一问。手填、官方账号、别的软件写的配置不动；别的「用不了」的型号照旧留给打开前那一问。
- 两句还按旧首页教人点的提示换成新首页的说法（yoyo 2026-10-16 回「提示改」）：切换账号后
  「Claude Desktop、WorkBuddy、OpenCode 不会跟着换」那句（`SavedAccounts.tsx` 的
  `accountSwitchDesktopClientsHint`）改成到首页卡片上点「…」里的「配置…」再点「保存并检测」；配置文件读不懂时的那句
  （`electron/broken-config-advice.ts` 的 `describeConfigReset`）改成到首页卡片上点「…」里的「配置…」、选「当前账号」。
  旧句里的「那一行」「检测模型」「保存配置」「使用星芒账号」新界面上都没有了，钉着原句的单元测试跟着换。
- 连接 Claude Desktop 的弹窗不再默认借 Codex 的密钥、填 GPT 型号（0.2.19 测试包里默认成了 gpt-6.1-sol）。
  默认选择收进 `features/tools/external-client-defaults.ts`：访问密钥下拉把客户端自己那一家工具的密钥排第一
  （Claude Desktop 先列 Claude Code）；Claude Code 没配当前账号时，先找账号里分组名带 Claude 的那把，再轮到
  Codex、Grok；借别的工具的密钥时，只把合这个客户端的型号带过来（Claude Desktop 只认名字带 claude 的）；检测
  完原来填着的型号不是 Claude 的，Claude Desktop 改挑列表里的 Claude 型号，一个都没有就不替他保存；在下拉里切回
  自家工具那把密钥时，型号也回到打开时填的那个。WorkBuddy、OpenCode 的默认不变。
- 外接工具的配置弹窗以前只在打开那一下读一次工具配置：Claude Code 刚装好、密钥还没写完就点开，默认就落到
  Codex 那把上，后面也不跟着变。现在弹窗还没动过（没换来源、没检测、没保存）时，首页读到新的配置就重挑一次
  默认；已经动过的不改他的选择（App 把首页那份配置经 `liveConfig` 传进 `ExternalClientDialog`）。
- xm 站 2026-10-16 删了老分组名（删前服务端把老名字下的 Key 全挂到了新名字下，Key 本身不变）。`catalog.ts` 的 `managedCliKeyProfiles` 换成新名字（Claude-MAX / GPT / Grok / Gemini），新增 `retiredAccountGroups`（老名字 → 新名字）与 `currentAccountGroupName`。
- `managed-cli-key-store.ts`：星芒账号的缓存读出来时把老名字换成新名字，开机不会因为「分组对不上」重签一把、再重写配置；0.2.12 以前写的不分站点的老缓存，分组是老出厂名的也照样认，不再整份当损坏挪走。
- `chat-key-store.ts`：AI 对话/画图的聊天密钥缓存同样把老名字换成新名字读出来（同一账号新老名字各一把时留较新的），老对话换到新名字后接着用原来那把，不会因为缓存对不上去拿分组里别的 Key 顶上、绕过那把聊天密钥自己设的上限。
- 配置框密钥下拉（`key-selection.ts` 的 `listedAccountKeys`）：`xingmang-` 开头的密钥同组同名只列一把（正选着的 > 最近用过的 > 编号大的），不列下线工具星芒签的 Key，也不列分组还写着老名字的（那种一调用就 403）。
- 旧回滚界面（已冻结）的 AI 对话默认分组取自 `managedCliKeyProfiles.codex.group`，跟着变成「GPT」；只改了它的测试断言，源码没动。
- AI 对话默认分组 `DEFAULT_CHAT_GROUP` 改「GPT」，聊天记录读出来时老名字换成新名字；画图技能的出厂图片分组 `IMAGE_SKILL_GROUP_NAMES` 改成「图片模型」「生图分组」，技能说明里的分组名跟着换；画布主进程执行器的兜底图片分组改「图片模型」。
- 欢迎页星空和星轨照 0.2.18 的样子重做（yoyo 10-16 看测试包说 v4 那版「不如上一个版本」）：`welcome-starfield.ts` 用 0.2.18 Starfield 同一个种子和取数顺序布 170 颗星和连线，`WelcomeStarfield.tsx` 挂上时画成 SVG，闪烁分五层整体变透明度，加流星、三道斜椭圆、光柱和虚线轨道。轨道上照 0.2.18 四颗：yoyo 回「还是要加上Gemini」（Gemini CLI 不装了，Gemini 模型还能用），写模型名「Gemini」、`BrandIcon` 按模型取图标，次序在 `registry/tools.ts` 的 `welcomeOrbitItems`，`e2e/electron-ci-smoke.mjs` 的星轨标签跟着改。不回到整窗 canvas 逐帧重画：慢慢变的动画都按 `steps()` 落在 0.2 秒一拍上（轨道 30 档每秒），整窗重新合成一秒只有几次，沙箱 headless 软件合成里显卡进程约 0.2.18 的一半、v4 那版的七成；`browser-check.mjs` 钉住这条节拍。界面文字只多了 Gemini 一个词。
- WorkBuddy、Claude Desktop、OpenCode 的「打开」不再进安装队列（AGENTS.md I11 登记例外）：
  `external-client-runtime.ts` 的 `launch` 只等同一家正在装的那一次，点安装前已经在打开的，
  安装等它交给资源管理器再动手，两边都只等先来的那一次。以前装着 Claude Code 点 Claude Desktop
  要等它装完，首页别的「打开」也一起变灰（yoyo 2026-10-16 真机，0.2.18 起就这样）。
  首页那一行只在等它自己安装时才说在等谁（`clientLaunchWaitLabel`）。命令行工具和 Codex 桌面端的
  「打开」照旧排队。
- 首页卡片「…」给星芒卸不了的桌面端（三个外接客户端、Mac 上的 Codex 桌面端）加「卸载…」，点了弹 `UninstallGuideDialog`，按 Windows / Mac 说在系统里怎么删，星芒自己不卸、不加 IPC。Windows 上的 Codex 桌面端照旧走 `desktop:uninstall-codex`。外接客户端从来没有卸载通道，0.2.18「安装卸载」页也没列它们，换界面后客户以为是漏了。
- 测试夹具 `app-fixture.tsx` 的 Codex 桌面端改成和主进程一样：状态不带 `uninstall`，`codexDesktop.uninstall` 在 Mac 上为假。
- 首页命令行工具卡片「…」最上面那串最近文件夹（`workspaceChoices`，最多 5 个整条路径，点了是在那里开新对话）去掉，换成「接着之前的对话…」，打开 `ToolConversationsDialog`。窗口每次现读这一个工具的记录（`toolsApi.toolSessions`，按工具过滤、一页 100，不走首页 60 秒缓存），一个文件夹一行放最近那条（`folderConversations`，最多 8 行），「接着聊」照首页「接着上次」先核对一次再打开；底部「全部记录」「开新对话」（同卡片上的「打开」）。这个工具一条记录都没有时不给这一项。教程「点击打开」那步删去「选最近用过的」。起因：yoyo 10-16 在 Mac 0.2.19 测试包上把那串路径看成了对话记录。
- Claude Desktop 加一键切换来源（新通道 `external-clients:switch-source`）：切官方只把第三方目录
  `claude_desktop_config.json` 的 `deploymentMode` 改成官方登录，星芒那份配置和密钥原样留着；切回只在那份还在、
  是正在用的那份、地址是当前线路、密钥归当前账号时改回 `3p`，否则一个字不写、界面打开「连接 Claude Desktop」。
  见 `claude-desktop-config.ts` 的 `useOfficialLogin` / `useGatewayLogin`。
- 检测结果新增可选字段 `officialAccount`（落进开机快照），首页据此显示「官方账号」而不是「待连接」，检查页显示未配置、
  不拿留着的密钥去发请求。官方登录记成的值 `1p` 官方文档没写，出自 Linux 打包项目 claude-desktop-extra 的文档，
  10-16 在 Mac 上手改核过（重开停在 Claude 登录页，改回 `3p` 回到星芒）。
- Codex 桌面端「显示中文」的核对不再误报：OpenAI 下发的中文开关本来就开着、界面已经画出来时直接算换成了
  （`electron/codex-desktop-cdp.ts`，补丁在改写之前记下开关原值）；Codex 还停在启动那一屏（开关请求连不上要
  34–38 秒，#976）时核对最多等到 45 秒，补丁盯 Statsig 的时间从 20 秒放到 60 秒。以前 20 秒一到
  就报「这次没换成中文界面」，界面随后却是中文（26.1013 包核过读开关的写法没变）。没核对上时，运行日志里那条
  `codex-desktop.chinese-locale.unverified` 现在带上最后看到的页面状态，分得清是哪一步没成。

## 0.2.18 - 2026-10-09

- `cli-model-defaults.ts`：Claude 默认型号改为 `claude-opus-5-5`，分组里没有时先退回 `claude-opus-5`；新增 `resolveCliModelUpgrade`（上一代默认 → 这一代）。
- `tool-model-check.ts`：多一种 `upgrade` 结果，只在配置里还是上一代默认、账号已有新型号时给出；问过记进 `settings.json` 的 `offeredModelUpgrades`（只增不减，只有主进程写），记不下来就不问。打开前的提问复用 #520 的换型号对话框。
- 核对过 Claude Code 2.1.282 的包内代码：2.1.277 不认识 `claude-opus-5-5`；2.1.280 起顶层 `effortLevel` 只作用于老型号，Opus 5.5 用它自己的默认推理强度，而这个默认正好是 medium，所以不另写按型号的设置（第十五批 6）。
- Windows 上卸官方安装器装的 Claude Code 时，开着的 `~/.local/bin/claude.exe` 改名成 `.claude.exe-<uuid>.removing` 能成、删不掉，
  `uninstallVerifiedNativeCliFiles` 把它放进 `retainedQuarantineFiles`，但 `system-service.ts` 的 `uninstallNativeClaude` 只取
  `retainedVersionFiles`，结果卸载报 `uninstalled`、这个文件一直留着，「帮我清理」也管不到（#935 末尾记下的那条）。
  新增 `buildClaudeRetainedFiles`：只在 win32 把改名后的命令入口一起算进要交给客户清理的文件，走 manual-required、
  进删除命令和「帮我清理」的记录；`buildClaudeRetainedVersionFilesReason` 多一个可选参数，有这类文件时换成先关窗口的那句说明。
  Mac 上按规矩留着的改名链接照旧不报。windows-latest 上加了一条用例：从 `claude.exe` 真起一个进程，核对卸载后它被改名留下、
  进程开着时清理删不掉、关掉后清理删得掉。
- 首页黄条「星芒画图还没装进 AI 工具：这台电脑还缺运行环境…」和运行环境卡里 Node.js「可选 · 未装」「一般不用单独点」
  打架（yoyo 10-8 c 条，A014：只装了 Codex 桌面端；一个工具都没装的电脑也挂这条）。`ManagedCliKeySyncSummary` 加可选
  `imageMcpNeedsNode`：`ipc.ts` 在画图没登记只因为没找到 Node.js 时带上；`account-bootstrap.ts` 把这句从 `warnings`
  挪到新的 `drawingNeedsNode`；`Home.tsx` 的 `homeBootstrapWarnings` 只在装着（或没检测出来，A4）任一命令行工具时
  把它放回横幅，正在装的不算，免得装到一半冒出来（装工具会顺带准备 Node.js，装完那一轮同步把画图接上）。Codex
  桌面端不算：那时 Node.js 一行写「可选」（第二十七批 B），这句不上首页，桌面端里先画不了图。句子本身没改，
  缺省 = 旧行为。
- 外部客户端「打开」还是慢（yoyo 2026-10-08 真机反馈）：`external-client-runtime.ts` 的 `launch()` 在 Windows 上也只看要打开的那一个（Mac 上原来就是）。
  检测脚本照旧读全三处卸载信息（要靠它找到客户端和登记的版本），但只核对、只验签这一家；打开 WorkBuddy、OpenCode 不再导入 Appx、
  不查 AppX 注册信息。对要打开的那一家，路径、链接、签名和 AppX 身份的检查一条不少。打开前那次检测也不再清掉另外两家
  「检测失败原话」的去重记录，免得下一轮检测把同一句再记一遍。
- 新增运行日志 `external-client.launch-timing`（info，进反馈报告）：每次打开成了，记排队等了多久、打开前那次检测多久
  （其中 PowerShell 整段、导入模块、读卸载信息、看进程、查 AppX、核对和验签各段，现核、照用的签名各几个）、交给资源管理器
  （Mac 上是 open）多久，用来对上客户说的慢在哪一步；没打开成的不记，那次一共多久照旧在「外部客户端启动」那一行。脚本报回的
  各段只留认识的那几项里的非负整数，格式不对就当没报；这一行记不下也不影响打开。
- 安装到 Program Files 以外（比如 `D:\星芒AI管理工具`）时，安装程序把安装目录改成跟 Program Files 下一样只有管理员能改（`build/installer.nsh` 的 `xingmangLockInstallDirectory`，权限串 `XINGMANG_INSTALL_DIRECTORY_SDDL`：属主 Administrators，不再继承上级，SYSTEM/Administrators 完全控制，Users 与两个应用包组只读和运行）。原因：自选目录继承盘根的「已验证的用户可修改」，而以管理员身份跑的升级会执行旧卸载程序、卸载会执行主程序、更新器会执行 `resources\elevate.exe`，谁都能先换掉这些文件，等客户下一次更新点「是」时拿到管理员权限（Codex 逆向报告第 3 条，2026-10-08 核对；0.2.15 起就有）。
- 收紧在三处做：`customInit`（升级、静默安装时 `$INSTDIR` 已定，赶在模板执行旧卸载程序和解压之前）、目录页离开时（有界面安装，当场建目录并收紧）、`customInstall`（兜底）。只在按整台电脑安装时编进去；Program Files 和网络路径不动。
- 改权限前先不跟链接地打开目录（`FILE_FLAG_OPEN_REPARSE_POINT`，不许别人同时删、改名），核对最终路径与 `$INSTDIR` 一字不差、它是真文件夹不是重解析点，再经同一个句柄 `SetSecurityInfo`；任何一条不对就不改、照原样安装。不起 icacls 或 PowerShell（I14）。
- 新增 `scripts/windows-install-directory-acl-smoke.ps1`，接在 `windows-uninstall-smoke.yml` 里：Program Files 安装不变；装进「已验证的用户可修改」的文件夹后目录和主程序、卸载程序、`elevate.exe` 只剩管理员能改；把它还原成老版本留下的宽松权限、放进一个指向外面的联接再按更新器的方式升级，重新收紧，联接后面的文件夹权限不变。
- `electron/platform/install-system-api.ts`：macOS 的 NativeWindowMac 在 `browser-window-created` 之后才写入构造参数里的标题，按标题认主窗口在 Mac 上永远落空，系统设置桥（`window.xingmangPlatform`）的预加载从未注册。改为在构造返回后的微任务里认窗口（此时页面尚未加载，标题无法被页面改写）。
- Mac CI 新增 `e2e/renderer-v2-native.mjs` 一步，桥缺失时打印窗口、预加载与主进程输出的现场。
- 星芒账号冒烟（`e2e/realm-account-smoke.mjs`）偶发红的根因：Electron 43 带的 V8 15.0 对 Playwright 在主进程里等的那个 promise 只弱引用（15.2 起才强引用），主进程按 Node 的规矩要等手上这一轮任务做完才跑微任务，命令落在启动忙的时候，中间一次垃圾回收就把回答收走（#934、#939 第三次启动连丢四次）。`e2e/fixture-readiness.mjs` 新加 `mainProcessCallInOwnTask`：在主进程里另起一轮任务开始、再另起一轮收尾，回答一直挂在 setImmediate 队列上。沙箱里对着忙的主进程，同一句 `app.getPath()` 200 次原来丢 89 次，改后 0 次；冒烟的主进程读数全走它，原来的退避重放留作最后一道。`scripts/ci-workflow-config.test.cjs` 不靠 Electron 复现同一件事（另一个线程经 inspector 发命令、主线程落地后先回收）并钉住改法。
- 星芒账号冒烟（`e2e/realm-account-smoke.mjs`）另一种偶发红「等不到切换账号」（#530 两次、#942 一次）的根因：夹具不答历史账号的直连线路，程序起来 30 秒出头「自动」改走默认线路，界面重读设置后替刚登录的账号再核对一轮 Key，开始引导的「稍后继续」又灰下去几百毫秒。Playwright 的 click 先确认能点再发鼠标事件，按钮正好在这两步之间变灰时浏览器丢掉点击、click() 照样返回，引导一直盖着。三次失败这一步都在第 29.7 秒前后开始，过的那次在 27.5 秒。冒烟改成点完等引导真的收起、没收起再点（`pauseStartGuide`）；沙箱里注入真实换线 20 次复现 1 次，故意吞掉一次点击时旧写法照 CI 原样红、新写法补点一次就过。`scripts/ci-workflow-config.test.cjs` 钉住不许再只点一次。
- Windows 默认配置（非管理员 + 开发人员模式关）下 `npm test` 的 9 个失败清零（#40 的 A 类）。`fs.symlinkSync`
  需要 `SeCreateSymbolicLinkPrivilege`，本机没有时这 9 条在被测代码跑起来之前就 EPERM，报的是机器配置、
  不是仓库状态。新增 `electron/symlink-capability.test-support.ts` 一次性探测能否创建真符号链接，
  `safe-local-data`（4 条）、`runtime-log`（2 条）、`backups`、`path-identity`、`relocated-folders`
  各自的符号链接用例改用 `it.runIf(canCreateSymbolicLink)` 门控。**断言一个字没改**——换联接会改掉被测属性
  （这些用例验的就是 I8 对符号链接的防护），所以只能整条跳过。
- 覆盖不会因此静默消失：`electron/symlink-capability.test.ts` 在 `CI` 下断言探测必须为真，runner 一旦失去
  该特权就当场红，而不是 9 条悄悄变成 skip。门控前已核实 CI 的 windows runner 确有该特权——当时代码里
  没有任何跳过而 CI 全绿。实现后又把探测临时强制为 true 复跑，9 条如期重新执行并复现原 EPERM，证明门控
  挂在正确的用例上。
- `AGENTS.md` 第 3 节与 `docs/TEST-BASELINE.md` 的 Windows 基线从「0~9 个环境相关失败」改为 **0**，
  并写明跳过不算失败、想在本机真跑该开什么。#40 的 B 类（5 条卡 vitest 默认 5s 超时）此前已随
  `test:vitest` 的 `--testTimeout=30000` 消失，本次复核 11304 条用例零超时。
- 新增根目录 `.nvmrc`（22，与 `quality` 工作流一致）。仓库此前既无 `.nvmrc` 也无 `engines`，本机 Node 与 CI、与 Electron 自带的 Node 三者各走各的。实测系统 Node v24.13.0 上 `fs.rmSync(中文名非空目录, { recursive: true, force: true })` 会让进程 fail-fast abort（`0xC0000409`），`provider-sessions.test.ts` 的 worker 因此无声死掉、整个文件 43 条一条都不算，vitest 退出码恒为 1。Electron 43.6.0 自带的 Node 24.20.0 与 CI 的 Node 22 都正常，产品与 CI 均不受影响。现象、触发条件与排查过程记进 `docs/TEST-BASELINE.md`。
- 新增更新包签名（Ed25519）。`publish-release` 在上传前用 release 环境的 `XINGMANG_UPDATE_SIGNING_KEY` 给 `latest.yml` 每个文件签名（`scripts/update-manifest-signature.cjs`，签「版本号 + url + sha512」，写进 `files[].xingmangSignature`），并确认私钥对得上客户端内置公钥；发布后再对线上清单验一次签。`rollback-release` 对带签名的备份验签，对加签名之前的老备份与 GitHub Release 同版本安装包逐字节核对后补签，找不到安装包时原样退回并告警。
- 客户端：`updater.ts` 新增 `verifyPackageSignature`，在 SHA-512 对上之后对同一清单项验签，失败按下载失败处理（`UPDATE_SIGNATURE_MISSING` / `UPDATE_SIGNATURE_INVALID` / `UPDATE_SIGNATURE_UNCONFIGURED`）；`main.ts` 只在 Windows 的未签名通道接上（Linux 的 deb 也走未签名通道，但它的两份清单还没签，暂不接）。验签模块 `electron/update-package-signature.ts`：公钥名单 `updateSigningPublicKeys` 可放多把以便换钥匙；缺签名、签名不对、没配公钥一律拒装，不会因为签名缺失放行。macOS 不签，Squirrel.Mac 已按钉住的发布证书验苹果签名。
- xm 三线路 PR-1（C9、(f)、C10、C11、C12、C19、C17 的 route.followed）：星芒账号（solov）换线路改由主进程 `followToolRoutes` 定点改写工具配置里的那一个地址（`tool-route-rewrite.ts` 字面量替换后整份重解析比对，`config-files.ts` 的 `planProviderRouteFollow` / `applyProviderRouteFollow` 走两阶段提交、本次 .bak 写成即删），不查模型、不碰 Key；写前记 manual、写后用新指纹重记 account 并原样带回模板版本号。历史账号（solov-api）照旧走渲染层 `followRelayRoute` → 整份写入，一行未改。
- 被外部改回 24 小时内两次标「由其他工具管理」并停手；暂时性失败每 5 分钟重试、最多 12 次；改完 60 秒回看一次。状态存 `tool-route-follow.json`（只存指纹与时间）。
- 迁移前原件：每个工具第一次定点改写前整套备份一次，进现有「备份」页（`pre-save` 类型，200 份上限内），没有另开子目录和新界面分组。
- 服务状态文件新增 `toolRouteRewrite: "merge"`（R6），缺省为定点改写；`service-status` 工作流加对应输入。
- 外部客户端开着时的换线（C11）：只对星芒账号，每 5 分钟和窗口回到前台时（间隔至少 2 分钟）用 `runtime.stillRunning` 轻量看一眼进程，退出后整轮检测一次完成换线；看不出开没开的每 15 分钟整轮检测一次。
- 零新增 IPC 通道：复用 `network:relay-route-changed`，渲染层要的线路标签、重开提示、R6 模式放进配置摘要与设置快照的只读字段。
- xm 三线路 PR-2a（C3、C4、C5、C6，新模块，主进程一行没接，行为不变）：`tool-path-probe.ts` 照 AI 工具自己的路子探一条星芒线路（系统解析全部地址、错开 250 毫秒并发连、SNI 用真域名、同一条连接上 `GET /api/status` 要 200 且 `success: true`，10 秒、16KB、不跟重定向、只认 relay-sites.ts 里星芒账号的两个 origin）；证书同时信 Node 自带和系统根证书（系统那份放在一次性的 worker 线程里读，不卡主进程），只靠系统根证书才过的标「安全软件接管」照样算通；「慢但有进展」不计失败。代理路径只给判法和候选代理（`probeToolPathThroughFetch`、`environmentProxyCandidates`），Electron 会话那半留给 PR-2b。
- `route-failure-classifier.ts`：失败打标签（正常 / 代理接管 / 未知 / 劫持），内置 Cloudflare 公布的地址段和 fake-ip、私网、回环等特殊段；读不到状态文件时一律「未知」，不判劫持。
- `route-status-file.ts`：读 `/xm-route-status.json`（v1），先当前应用线路再另一条，16KB、不跟重定向、`legit_ips` 逐项校验是 IP 字面量，缓存 10 分钟（读不到也缓存），准备降级时不走缓存重读。服务端还没上线，读不到只禁止新分配香港。
- `tool-route-controller.ts`：工具线路状态机。L1 → L2（占位，第一批恒不可选、不进 RelayEndpointId）→ L3；连续 3 轮失败（隔 15 秒）或劫持 1 次准备降级，服务端 incident 时从第一次失败起等 5 分钟、只切 CF；挑这一轮通过的最高线路（可往上回）；两次切换隔 5 分钟；冷却期 0 / 1 / 6 / 24 小时按墙钟、跨重启；冷却期满每 2 分钟查、连续 6 次通才回；7 天无失败的开机 30 秒内 3 次通就回；退出不回升；L1/L2 按解析地址去重；三线全挂不改配置只出提示（按原因 24 小时一次），劫持提示 7 天一次。状态另存 `tool-route-state.json`（safe-local-data，8KB，只存线路 id、原因和时间，失败记录最多 16 条），不碰 0.2.17 要读的 `relay-route-lines.json`；升级首启取那份文件里星芒账号的结论，7 天内 `health-failed` 给洛杉矶记一次失败。
- quality 工作流的 Windows、macOS 跑道各加一步 `e2e/system-ca-smoke.mjs`：现场生成一次性测试根装进跑道机器的系统证书库，要求 Electron 主进程（含 worker 线程）读得到、只信自带根证书时握手失败、加上系统根证书后握手通过，用完删掉。
- xm 三线路 PR-2b（把 PR-2a 的模块接进主进程）：主进程起一个只管星芒账号（solov）的工具线路控制器（`tool-route-controller.ts`，状态存 `tool-route-state.json`，升级首启读 `relay-route-lines.json` 的旧结论），由它决定写进 AI 工具配置的线路；原来的应用线路控制器（`relay-route-controller.ts`）照旧管管理工具自己的流量、历史账号（solov-api）和更新源，日志分别带 `kind: 'app'` / `kind: 'tool'`。
- `createToolRouteRoutingSnapshot`：工具相关的路由快照里 solov 取工具线路（恒为已定），solov-api 取应用线路，solov-api 的线路逻辑一行未改。诊断、工具自检、Codex 探测、修复清环境变量、反馈环境描述改用工具线路；反馈上报线路、更新源、启动必需检查仍用应用线路。
- `tool-route-probe.ts`：一条线路要在无代理、系统代理（对该 origin 生效时，经 `xingmang-tool-proxy-*` 会话）、每个 HTTPS_PROXY / ALL_PROXY 上都通才算通；没有一条线路全通时以无代理路径为准。带用户名密码的代理不测（`environmentProxyCandidates` 跳过）。Linux 只测无代理路径。环境变量代理只在启动、唤醒、网络恢复、手动重新检测和准备降级时重读。
- 已观察的请求（`createRelayObservedFetch`）对星芒账号只在自动模式、且请求打到工具当前线路时把失败报给工具线路控制器（`check:<原因>`），手动固定线路和历史账号照旧。
- `tool-route-status.ts`：把控制器的快照与提示整理成设置快照里的只读字段 `relayToolRouteStatus`（服务端切换中 / 三线全挂及原因与管理工具能否连上 / 劫持，劫持提示留半小时），另加只读 `relayToolRouteLines`；不落盘、不加 IPC 通道，复用 `network:relay-route-changed` 让界面重读。
- `system:scan` 的选项新增 `recheckRoutes`，首页「重新检测」带上它让工具线路控制器手动重测一轮；唤醒和网络恢复（15 秒查一次 `net.isOnline()`）也各触发一轮。
- 开发时 `XINGMANG_TOOL_ROUTE_FAST=1`（仅未打包）把工具线路的时钟加快 60 倍，方便看降级与回升。
- xm 三线路 PR-3（C16、C15）：设置选项（`connection-routes.ts`）、「星芒 AI 网络」结论（`relayNetworkPassSummary`）、导出报告里的线路名（`relayLineName`、`describeRelayRouteChange`）、反馈报告「连接线路」（`resolveFeedbackRelayRoute`）都按站点取：solov 用附录 A 的洛杉矶 / CF 说法，solov-api 一字不变（单测钉住）；存储值 `direct` / `primary` 不变。历史账号线路的说明改成自己完整的一句。
- 反馈报告新增「工具线路」一行（`resolveFeedbackToolRoute`，只有星芒账号）。「星芒 AI 网络」那一项导出的报告加上工具线路的几行（`buildToolRouteReport`）：线路与自动 / 固定、最近一次切换和原因、服务端切换中、三线全挂原因、状态文件读不读得到及 incident 状态和洛杉矶入口代号、两条线路最近一次照工具连法探测的结果；检查页详情不摆，不带地址。
- C15：线路状态文件说洛杉矶那个域名指向香港入口（`lines.direct.target === 'hkg'`）时，更新与服务状态文件改用包里那份目录（`updateFeedLineFor`）；状态文件读不到照旧。只换下载地址，#944 的验签不受影响。状态文件服务端还没上线，这段现在不生效。

## 0.2.17 - 2026-10-07

- 按 #941（`docs/DIRECT-ROUTE-RELAY-SUPPLEMENT.md`）第 2～4 节修直连的三处问题，只动 new-api（xm）这一侧的共用逻辑，sub2api 直连
  的专属代码没动，没加线路选项，中转地址不进仓库。
- yoyo 10-8「xm 站点这边全部走直连，线路这些问题不需要有太多提示」「CF 用来兜底」：`relay-route-controller.ts` 里星芒账号（solov）
  这台电脑上还没有结论时开机直接定在直连（`unconcludedStart`，算定下来），工具配置一开始就写直连；直连健康检查连败照旧退回默认
  线路、恢复后切回，都不提示。历史账号（solov-api）照旧先走默认线路、查出结论再迁。
- 界面不再说线路的事：去掉首页「自动」退回默认线路的黄条（直连适配第六节第 4 条那句）、跟着换线路以后「要关掉重开」那句和它的
  「帮我重开 Codex 桌面端」「知道了」；跟着线路却没改成的工具改说现成的「服务地址尚未与当前账号匹配」（去掉 `routeMismatch`）。
  `App.tsx` 的 `followRelayRoute` 那一轮带 `quiet`，首页不摆进度；只换了线路的一轮（`bootstrapOnlyFollowedRoute`，开机那一轮也算）
  不说「已完成…」，没写成的照常说，运行日志记「跟着换了连接线路：…」。另外三个客户端开着时那一行的「连接线路暂未改动，完全
  退出后点「重新检测」」照旧留着：它们开着时星芒照第四十三批 A 的规矩不改，去掉这句就没人知道要先关掉它。
- 第 2 节，工具配置跟着当前线路：「自动」换线路时，以前开着（或看不出开没开）的工具一律先不改、等客户关掉再「重新同步」；Mac 上
  Codex 桌面端关了窗口还在后台跑，Codex 几乎总被算成开着，配置就一直停在原来那条线路上（线上 A、B、C 三位的成因，推测）。现在
  不再问开没开，`system-service.ts` 照样按两阶段提交改好配置，开着的进程重开以后就走新地址。
- 第 3 节，线路好坏只看健康检查：`relay-route-controller.ts` 重写成一轮三次——直连连着 3 次（隔 15 秒）健康检查没通过、默认线路
  通才切走；两条都不通不切、5 分钟后再查。走直连时每 5 分钟查一次；退回后每 2 分钟查一次直连，连着 6 次（10 分钟）都通才切回；
  两次切换至少隔 5 分钟，没到点就等到点再查一轮。每个站最近一次切换（从哪到哪、原因、起因的错误码）记进 `relay-route-lines.json`
  的 `changes`，版本号不变，旧文件照读。`relay-line-fetch.ts` 去掉 3 秒没回话就报和「中止算连不上」：超时、调用方中止、
  `/api/notice` 一律不报；报上去的只有网络层失败（`reportedRelayLineFailure`：断网、解析不出、TLS、证书日期、拒绝连接、代理回绝、
  连接超时码）、回话的不是星芒，以及「到时限一个字都没回来」（`abortMeansNoAnswer` / `noAnswerFailure`：账号请求 10 秒
  放弃时连回应头都没等到，直连被丢包就是这样，Chromium 自己要二三十秒到两分钟才报连接超时），而且只是叫控制器开一轮
  检查（30 秒里最多一次）。请求本身照旧当场换线路重发。检查页（`diagnostics.ts`）直连那几秒没回话同样报一轮；更新源
  （`update-feed-route.ts`）下得慢照旧不报。切换间隔用的是系统时钟：钟被往回拨过就从当下重新算一整段，不会一轮轮等到
  钟追上来。
- 第 4 节，公告：`new-api-client.ts` 给 `/api/notice` 单独 60 秒时限；跟着余额刷新的那一路读到过就一直用那份，没读下来的十分钟里
  不再下、报上次的失败；打开公告、点重新读取照旧当场读；两路撞在一起只下一份。公告的成败不影响线路判断（上一条）。
- 第 2、7 节，检查页：工具连接设置那几项的配置地址和当前线路对不上时照常算通过，导出的报告里写 `routeLine`、`currentRouteLine`；
  「星芒 AI 网络」那项导出的报告里写最近一次换线路（`lastRouteChange`）和起因的错误码（`lastRouteChangeTrigger`）。检查页的
  详情抽屉不列这几个键。
- 登录后引导页锁住：主进程那条「会话变了」要等手上的事和本机凭据写完才发（`realm-account-service.ts` 的 `requestChanged`），
  常常晚于界面已经开跑的那一轮登录同步；`App.tsx` 收到它一律作废正在跑的同步，那一轮的结果被扔掉，引导页一直是「正在同步
  账号专属 Key」、按钮全灰，要等别的事碰巧再跑一轮才解开（`realm-account-smoke` 在 Windows 打包那项上就卡在这）。现在说的
  还是同一个账号就接着算（`sessionChangeKeepsBootstrap`），换了账号、退出登录照旧作废。main 上同样有这个先后，本机跑这项
  冒烟在第一次登录就卡住。
- 冒烟（`realm-account-smoke`、`signed-out-smoke-isolation`）的星芒账号那一侧，直连和默认线路两个地址照同一套答；星芒账号的
  登录、找回密码按直连地址核对。
- 0.2.17 发版运行的 Windows 出包作业连挂两次，都是测试不稳：`test:ui` 十个套件的夹具页一律改走 `openFixturePage`（`ERR_NO_BUFFER_SPACE` 丢导航时在同一 90 秒预算里重开），`ci-workflow-config.test.cjs` 找 Windows 套件时把 `run-release-build.cjs` 跑的 npm 脚本也算进去（`test:ui` 只在发版时上 Windows，原门禁看不到）；`provider-sessions.test.ts` 等后台写探测缓存的 `vi.waitFor` 从默认 1 秒放到 10 秒。

- PR #834 核实的 F10：`electron/proxy-bypass.ts` 因为系统代理指着一个关掉的代理，把本次运行整个改成直连（默认会话 `mode: 'direct'`，
  不会自己撤回）以后，用户再开加速（加速页点的，或者从星芒打开 Codex 桌面端时自动连的），`startDownloadRoute` 回
  `system-proxy-active`，`download-acceleration.ts` 照旧记成已加速、不给端点。于是 `downloadFetch` 走默认会话直连，
  `resolveSubprocessProxyEnvironment` 给 npm 的也是直连，`system-service.ts` 的 `inspectNetworkRegion` 却因为
  `acceleratedDownloads > 0` 改成官方优先，进度里写「已为本次下载启用加速线路」「已启用下载加速，优先使用官方源」。
- 协调者加可选的 `downloadsFollowSystemProxy`，`main.ts` 接 `() => !proxyBypass.active()`：`system-proxy-active` 时答 false 就不算加速，
  回空租约、记 `acceleration.download.direct`，安装源照区域探测排，国内仍先走镜像；别的下载正握着的那份可能是改直连之前给的，
  沿用前也再看一次。下载临时线路（`ready`）给下载专用会话明着设回环代理，不看系统代理，不受影响。
- 没改成让下载真的走用户那次加速（下载专用会话改跟随系统代理）：Codex 桌面端顺带连的加速约 2 分钟就断，断开时系统代理当场改回
  那个关掉的代理，下到一半的会接着撞上它；用户自己停加速也一样。没在真机上演过。
- `account-switch-sync.ts` 跨账号类型切换（星芒账号 ↔ 历史账号）时，上一个账号的工具地址改按那个站登记过的线路认
  （`relaySiteEndpointIdForBaseUrl`：默认线路、备用直连和它的别名），新账号报的地址也按登记过的线路认。原来两头都只认
  默认线路的地址，选了备用直连以后勾上的工具全被跳过（#872 写的「没做」第一条）。
- 测试夹具加 `?routedSwitch`：切换账号时像主进程一样按新账号生效的线路重报地址、重算 `matchesRelay`，归属变成
  `unknown`；浏览器用例演备用直连下切到历史账号，两个工具都换过去。
- 安全修复：以管理员身份运行星芒时，收紧 `ProgramData\XingMangAI`（装、更新、卸载工具，或准备安装临时目录时都会走一遍）的顺序留了个可写空窗。`protectWindowsDirectory`（`electron/trusted-temp.ts`）原来先 `icacls /reset /T` 整棵树、再单独加固根：`/reset /T` 这一步会让根重新继承 `ProgramData` 的 ACL（对 Users 可写），到下一步加固根之前，普通账户能在根里新建文件；随后的 `/setowner /T` 把这些文件的属主一律改成 Administrators，而作者在建文件时就能把 DACL 设成只有 SYSTEM/Administrators，于是最后的逐项核对放行——等于普通用户把自己的文件塞进提权执行路径，还带着一副可信的 ACL。
- 改法：把加固根挪到第一步（断继承、只给 SYSTEM/Administrators），根从这一刻起就不再对普通用户可写；再用 `icacls <root>\*`（只针对内容、绝不碰根本身）重置子项，让它们重新继承、并修掉历史空 DACL；最后 `/setowner /T` 改属主。检查一条不少，只是换了顺序，没有放宽任何校验。空目录没有内容要重置、`\*` 通配符会报错，所以加了一道「有内容才重置」的判断（读不出目录按空处理，根已加固、最后的逐项核对仍兜底）。
- icacls 这三步抽成 `applyWindowsRootHardening`（纯函数，按序调用注入的 runIcacls），顺序即安全契约。`windowsAclResetArguments` 改名 `windowsAclResetContentsArguments`、目标带 `\*`。并发串行的注释改掉了「`/reset /T` 让根短暂可写」那段旧理由。
- 测试：`trusted-temp.test.ts` 新增两条（各平台都跑）——加固根必须先于重置内容、且没有一条 icacls 把根本身 `/reset`；空目录只跑加固与改属主两步。`windows-powershell-probes-smoke.mjs` 新增一条在真 Windows 上跑整套加固，证明 `\*` 通配符真能跑、且加固根那一步一返回，根就已经只给 SYSTEM/Administrators。普通权限的 Windows、Mac、Linux 不走这条路，不受影响。
- Sub2API 公告条目带上 `publishedAt`（`RelayNotice.entries` 新增可选字段，开始时间与创建时间取较晚者，缺时间就不带），
  `Announcement.tsx` 的列表日期和详情时间改为「时间线的发布时间，没有就用条目自己的」，沿用 `formatTimelineDate`，
  不新增文案；历史账号没有类型，所以详情里只有时间、没有类型标签。
- `electron/updater.ts`：检查失败的 `error` 多一个可选 `automatic`，开机、每 3 小时、晚到的开机那次失败（`check()` 没带 `manual`）都标上，开机 8 秒超时的 `STARTUP_UPDATE_TIMEOUT` 也标；只跟着 error 走，错误清掉就没了，缺省＝客户点的，旧行为。
- `src/renderer-v2/features/app/update-retry.ts` 新增 `updateFailureBubbleQuiet`，`App.tsx` 首页气泡据此不弹；更新页不变，仍显示「检查更新失败」与「重试」。下载、安装失败不受影响。
- 第二十五批候选 ①，yoyo 2026-10-06 回「没算进去的拍板也按照你的推荐做」。
- 第二十四批 2：Windows 安装包是 perMachine，装更新一定弹 UAC；账号不在 Administrators 组时 UAC 要别人的
  管理员密码，打开时装、第一次打开窗口时装（#881）、退出时装都只会把软件关掉、再弹一个填不了的窗口。`main.ts`
  启动时用 `inspectWindowsElevationCapability`（whoami /groups，3 秒上限）问一次，问出 'standard' 时：
  `decideLaunchInstall` 新入参 `standardAccount` 返回 null；`decideQuitInstall` 在自动更新开着时返回新值 'leave'，
  不装也不弹「顺手装上吗」，直接退出（日志 `quit.update-left`），自动更新关着时照旧问。问出来之前打开时装先不定，
  问出来后用 `considerLaunchInstall` 再看一遍；退出时最多等这一次问完，'standard' 时也不再等撤回名单。问不出来
  （'unknown'）照旧自动装（Windows 上记一条 `install.account-unknown`）。
- 更新快照加可选的 `installNeedsAdminPassword`（`updater.setInstallNeedsAdminPassword`，只在问出 'standard' 时出现，
  Windows 管理员账号和 Mac、Linux 的快照不变）。渲染层据此换字：首页气泡和更新页（下好时，`standardAccountUpdateNotice`）、
  系统通知（下好时换键 `<版本>:downloaded:admin-password`，问出来之前已经弹过的那条会被收掉；正在下载时）、更新页顶上、
  「自动更新」开关说明（更新页和设置页）、重启安装确认框、强制更新门。文字是 yoyo 2026-10-06 批的原话；主进程和
  渲染层各有一份下好时那句，两边测试都钉住原句。
- 第三十一批 B（yoyo 2026-10-04 点头）：官方安装器（`installSource: 'native'`）装的 Claude Code 以前首页只给一句
  「用它原来的方式更新」，可 `config-files.ts` 写的 `DISABLE_AUTOUPDATER` 不看安装方式，连它的自更新也关了，客户就停在
  旧版本上。新增 `canSwitchToManagedInstall`（Claude、native、`uninstall.available`）与 `updatesOutsideApp`，后者替换
  首页、安装卸载页、新版本通知里原来看 `isExternallyManagedInstall` 的地方，能换的这一种照给「更新」「更新到推荐版本」；
  `toolUpdateOffer().manualHint` 对它变成 null，新手引导的「更新」按钮和结果页「建议更新到 X」那句跟着一起变。其他来源的
  Claude / Gemini、官方安装器装的 Codex 不变。
- `App.tsx` 的 `install()`：先过原有的断网、运行环境检查，再弹 `managed-switch-confirm`（三句话在 `managed-switch.ts`，
  照点过头的原话），客户同意后在同一个安装任务里依次准备运行环境、卸载、安装，卸完到装上的空档最短，运行环境要重启电脑时
  官方那份也还在。版本由 `managedSwitchVersion` 定下（点名的 → 钉住的推荐版本 → 最新版 → 推荐版本），确认框写哪一版就点名
  装哪一版。点「取消」或关框返回新的 `ToolInstallOutcome` `'declined'`，什么都不动，安装卸载页也不出提示。这一份已经在换
  （任务还在跑）时再点不重复问，按已在装处理。真动手卸之前再看一眼网（`offlineNow`，确认框可能开了好一阵），断了就先不卸。
  卸载这一步不能取消（现成的「这一步已经不能取消了。」），安装那一步照旧走取消通道；卸载留下被占用的旧版本文件
  （`manual-required`）时照常装上并弹原有的清理说明；卸载转交给普通窗口时和「卸载」一样刷新一次；卸载后安装失败或被取消时
  刷新一次，这一行回到「安装」。
- IPC `cli:uninstall` 加可选第二个参数 `CliUninstallOptions`（`{ reinstall?: boolean }`），`ipc-contract.ts`、`preload.ts`、
  `ipc.ts` 三处一致，没加新通道、注册顺序不变；`parseCliUninstallOptions` 只认 undefined 或只带布尔 `reinstall` 的对象，
  别的形状报「卸载参数格式错误」。带 `reinstall` 时 `system-service.ts` 的 `uninstallCliOperation` 动手前先跑
  `assertInstallDiskSpace`（和安装同一句、同一个门槛），盘不够就一个文件都不删。
- 文档：`docs/CLI-NATIVE-INSTALLS.md` 的识别口径补上这个例外；`docs/CLI-VERIFIED-VERSIONS.md` 记下 `DISABLE_AUTOUPDATER`
  对官方安装器那份生效这一条已在沙箱用真二进制演过（Windows / Mac 真机没演过）。
- 第三十二批 A：`electron/system-snapshot-cache.ts` 不再因为 appVersion 不同就扔掉上次的检测结果（#403 起换了版本就不认，
  每次更新后的第一次打开，首页「你的工具」都只剩一条进度条）。格式版本号对、形状校验过就认，不管是哪一版写的。
  别的版本写的文件，每家 CLI 去掉 `versionAdvice`、`revertVersion`，`latestVersion` 记 null、`updateAvailable` 记 false、
  `updateState` 记 unknown（`withoutVersionVerdicts`）：前几项是上一版按它自带的推荐版本名单下的判断，`latestVersion` 会被
  「更新」当成点名的版本；首页先摆上次结果的那几秒里「更新」「更新到推荐版本」能点，点下去版本号原样交给主进程、按点名的
  版本装，新版本的名单换了推荐版本就会装错。桌面端照留（它的「更新」不点名版本）。同一版本写的照旧原样用。
- 新加类型钉子 `SnapshotShapePins`：快照每一层（SystemSnapshot、ToolStatus、CliStatus、DesktopAppStatus、
  NetworkLocationStatus、CliUninstallCapability）的必填字段连同类型照抄一份，加、删、改必填字段（包括必填改可选）
  `npm run typecheck` 就过不去，注释写明改清单的同时把 `SYSTEM_SNAPSHOT_CACHE_VERSION` 加一。按 tag 比过 v0.2.10～v0.2.14
  和 main，必填字段一个没变，格式版本号保持 1。另有 `CliOptionalFieldsSorted`：CliStatus 新加可选字段也过不去，逼着先判断它
  算不算上一版的版本判断、要不要进 `withoutVersionVerdicts`（只为分类，不用加格式版本号）。`system-snapshot-cache.test.ts`
  用 `@ts-expect-error` 钉住这几道检查本身真会报错。
- 第三十二批 B：`electron/platform/notifications.ts` 里 `cliUpdate` 的通知标题、`src/renderer-v2/registry/business.ts` 里设置项的说明去掉「命令行」。
  这条通知按 `pendingToolUpdates` 算，Codex 桌面端镜像有新包时也算在里面；Windows 客户反馈报告里真发过一条
  `cli-update:codexDesktop.26.928.3736.0`，当时四家 CLI 一个没装。正文、哪些工具算进这条通知、点通知去哪一页都不变。
- 第三十三批 D（0.2.15 发版前回归检查建议 g 的前一半）：`electron/codex-desktop-service.ts` 的 `installCodexDesktopOnMac`
  第一次检测没做完（`detectionFailed`，或者检测本身抛错）时再检测一次，认出来就照已装好的那条路结束，不下载。以前没做完
  和「查过了，没装」一样往下走，`installMacosDesktopApp` 看到「应用程序」里有 ChatGPT.app，只认得出旧版聊天程序
  （com.openai.chat），正版 com.openai.codex 也落到「不是官方原版」那句。
- 第二次还没做完就照旧往下走，不一律停下：`detectionFailed` 也包括 Spotlight 查不了、扫应用目录超时这类和 ChatGPT.app
  无关的情况，停下会让这些 Mac 再也装不上。第一次检测期间客户点了「取消」就不测第二次，直接按取消收场。
- 两次都没做完时告诉安装那一步（`installMacosDesktopApp` 新加的 `detectionUnfinished`）：「应用程序」里占着名字的那份
  自称 com.openai.codex，就报现成的「Codex 桌面端检测未完成，请重新检测后再试」（和 Mac 上点「打开」时检测没做完同一句），
  不说「不是官方原版」、叫客户移到废纸篓。只换说法，照样不装、不动它；旧版聊天程序、别的 bundle id、读不出来的照旧，
  检测做完了还没认出来的那份也照旧说不是官方原版。
- 「没做完」只算没查完的：`detectionFailed` 以前把两种情况混在一起，`inspectMacosCodexApp` 新加 `rejectedPaths` 分开，记下
  自称是 Codex、核对下来确定不过关的那几份（codesign、plutil 跑完了退出码非 0，可执行文件缺了、不是能跑的 Mach-O、类型权限
  不对、架构不兼容）。安装那一步占着名字的正是其中一份（按 realpath 比）就照旧说不是官方原版，再测几次都一样，客户得知道要把
  它挪走；别处另一份不过关不连累它。命令超时、没起来，文件读不了，问不出这台 Mac 跑什么架构，才算没查完。`app`、
  `detectionFailed` 本身和首页的显示都没变。
- 沙箱用真的 `createCodexDesktopService`（darwin）和真的 `installMacosDesktopApp` 演过（「应用程序」换成临时目录，里面放
  plutil 读出 com.openai.codex 的 ChatGPT.app，第一次检测给签名核对超时）：改前说「不是官方原版」；改后第二次认出来时
  提示已经装好、安装器一次都没调。两次都没做完的那种由 `codex-desktop-service.test.ts` 用真的安装函数钉住。
- 开机自启时「打开时装」从来不会发生：`update:startup` 要等开机安静期（3 分钟）过了才查更新，`decideLaunchInstall`
  只认从进程启动算两分钟内下好的。现在开机拉起的从安静期结束才开始算这两分钟（`main.ts` 的 `launchInstallClockFrom`），
  普通打开照旧从启动算。`launchedAtLogin` 和 `startupQuiet` 挪到打开时装的订阅之前建，别的用法不变。
- `auto-update-install.ts` 新增 `resolveLaunchInstallMode`：开机拉起、窗口一直没显示过的，能无人值守装（`canInstallUnattended`）
  又没开着加速就在后台装（'background'：不发预告通知、不摆卡、不等 5 秒），否则开机时不装（'skip'，日志 `install.on-launch.held`），
  其余照旧先预告再装（'notice'）。Windows 的 NSIS 是 perMachine，安装器每次都要 UAC 授权窗口，所以 Windows 窗口没打开过时开机不装；
  Mac 照 Squirrel.Mac 的 `launchPrivileged`（SQRLUpdater.m：解开符号链接后 .app 或它所在的文件夹不可写就要管理员密码）看一遍，
  从磁盘映像或系统的只读临时副本里运行的也不装。
- 自动更新记录加可选的 `backgroundInstall {version, startedAt}`：后台装、安装器 10 分钟内重新拉起的那一次
  （`isRelaunchAfterBackgroundInstall`；ShipIt 装没装成都会拉起，所以不看版本）照开机拉起办，窗口留在菜单栏、走安静期，
  日志 `install.background.relaunched`；读到就清掉，只认一次。没走到重新拉起那一步的（装之前情况变了、没装成
  `isBackgroundInstallFailed`、装的时候用户点开了窗口）当场撤回这条记录，免得之后用户自己打开时窗口出不来。旧版本读这份
  记录会忽略这个字段。ShipIt 用 NSWorkspaceLaunchDefault 打开会把程序切到前台，这一次在 ready-to-show 后 `app.hide()`
  把前台还回去。装之前那一眼抽成了纯函数 `shouldStillInstallAtLaunch`，后台装的另看窗口有没有被点开、加速有没有开。
- 第三十三批 A：Mac 的 powerMonitor 'shutdown' 现在和 Windows 的 query-session-end / session-end 一样算「系统要关机」。
  `window-lifecycle.ts` 的 `confirmedQuit` 关机时不调 confirmQuit、不拉安装器；关机通知之后系统来让程序退出（before-quit）时，
  开着的关窗询问框、退出确认框不等回答直接按退出走（`answerUnlessPowerOff`）。以前 Mac 关机照「退出时顺手装」那一套先写
  `quitAttemptedVersion`、拉起 Squirrel 又不等它，安装器被一起结束，之后每次打开都说「新版本上次没装上」，这一版也不再自动装；
  关着自动更新时确认框还会拦住关机。Electron 43.6.0 只在 NSWorkspaceWillPowerOffNotification 时发 'shutdown'，Command + Q 和
  程序坞「退出」走 terminate: 不发（对过 electron_application_delegate.mm、electron_application.mm），普通退出照旧装。
- 关机被别的程序拦下取消时 Electron 不再通知，所以关机只管通知后 60 秒内开始的退出（`powerOffQuitWindowMs`），之后照常问、
  照常装；只听到通知、系统没来让程序退出时，开着的框留给用户答，答了照样算数，只是不再拉起安装器。
- `decideQuitInstall` 加 `systemShuttingDown`，关机时回 'later'（不装、不问、不记）；`main.ts` 的 confirmQuit 等完撤回名单、
  等完通知各看一次新加的 `lifecycle.isSystemShuttingDown`，`quitAttemptedVersion` 挪到等完通知之后才写。刚退出、记录已写、
  安装器还没装完时才关机的：收拾那一两秒里不再拉起安装器，`onPowerOff` 用 `undoQuitInstallAttempt` 撤回这次写的记录
  （尽力而为，没写成就和以前一样）。下次打开走现成的启动时自动装。
- 第三十三批 C：`system-service.ts` 的 `uninstallCliOperation` 里 npm 卸载那一步以前不接失败，原样抛 `CommandRunnerError`
  （Windows 上是「命令执行失败（退出码 1）：node.exe」，npm 报的 EPERM / EBUSY 只在 stderr 里），渲染层只能归成「操作没有完成」。
  现在照安装那条路：新增 `describeNpmUninstallFailure` 把 npm 的要点接到原话后面，再经 `describeOccupiedCliFailure` 按这个工具的
  包目录数进程。EBUSY / ETXTBSY，或 EPERM / EACCES 且数到进程，说「{工具} 卸载失败：文件被占用，……」（渲染层归「工具正在运行」）；
  其余说「{工具} 卸载失败：{原话（npm 要点）}」（EPERM 归「写不进安装目录」）。不借 `describeNpmCommandFailure`：它把超时说成
  「下载超时」，卸载不下载东西，借过来会被归成下载超时、叫客户换源重试。
- 卸载失败时 Mac 不数进程：Mac 挪得动、删得掉正开着的程序文件，那边的 EPERM / EACCES 只会是权限不够（比如用 sudo
  装进 `/usr/local` 的那份），数到进程就会叫客户去关窗口，关了照样卸不掉。Mac 上照旧归「写不进安装目录」。
- `cli-process-probe.ts` 的 `action` 加「卸载」；`cli.file-locked` 那条日志按动作说（以前首次安装撞上占用也写「更新时」）。
  卸载抛出的错误把原来的 `CommandRunnerError` 挂成可枚举的 `cause`：运行日志只记可枚举字段，npm 的原始输出照旧进日志。
  卸载前先查工具开没开、错误框加「重试」都要动 `App.tsx`，这次不做。
- 第三十三批 B（0.2.15 发版前回归检查建议 i）：`electron/updater.ts` 的 `check()` 改等 `checkWatched()`。
  `updateCheckStallMs`（45 秒，和下载停住同一个数）里 update-request-guard 一个响应头、一个字节都没看到，就调
  `abortDownloadRequests` 掐断还开着的更新请求，以 `UPDATE_CHECK_STALLED` 加更新那张表里「超时」那句报检查失败。
  electron-updater 6.8.9 上一次检查没收场时再调，交回来的是同一个 Promise（AppUpdater.js 的 `checkForUpdatesPromise`），
  出错才清掉；以前开机检查 8 秒超时后请求一直挂着，「重试」和三小时那次都接回它，整次运行停在「正在检查」，
  最低版本那道门里只剩「联系客服」。掐断后那次检查以掐断用的错误收场，electron-updater 丢掉它，下一次检查重新发请求。
- 开机那次已经报了 `STARTUP_UPDATE_TIMEOUT`、之后没人再点检查的，掐断后保留那句话。接回同一个挂住请求的检查共用一个
  看门狗、同一个结果。掐断时之后又开始了一次检查的，只让最新那一次报（`latestCheck`），免得它还在读服务状态文件时先闪一句
  「检查更新失败」。electron-updater 为掐断的请求发的 error 事件不上屏（同下载那边的 `UpdateDownloadAborted`）。
  宿主掐不到请求时，再等 `updateDownloadCancelWaitMs` 照样报超时。main.ts 只在 `download.requests.aborted` 那条日志里
  多记一个 `reason`（`UpdateCheckAborted` / `UpdateDownloadAborted`），分得清掐的是检查还是下载。
- 沙箱用 Electron 43.6.0 加真的 NsisUpdater，对着只接连接、不回话的本地服务器演过（HTTP/1.1、HTTP/2 各一遍，计时缩短）：
  掐得断、连接关掉，下一次检查、开机超时后的「重试」、定时检查都重新发请求；只回响应头不回内容的也掐得断；每 2 秒来一个
  字节、总时长超过门槛的慢服务器不误判。改前的代码同样演法：检查一直挂着，「重试」和定时检查都不发新请求。
- 第三十四批 C：`electron/macos-shell-profile.ts` 按账号的登录 shell 选文件（`planMacosShellProfileTarget`）。zsh 照旧
  `~/.zprofile`；bash 追加到 `~/.bash_profile`、`~/.bash_login`、`~/.profile` 里第一个存在的那个（bash 登录 shell 只读它），
  三个都没有才新建 `~/.profile`，从不建 `~/.bash_profile`。「存在」照 bash 自己的判法：失效的链接跳过，活的链接、文件夹、
  读不了的文件都算，于是被拒绝，不退到一个 bash 根本不读的 `~/.profile`。fish 写自己的 `conf.d/xingmang-ai-manager.fish`
  （认 `XDG_CONFIG_HOME`），不改 `config.fish`，同名文件不是我们写的就不动。三种用同一对标记、同样三个目录接在 PATH 最后。
- 其余照 zsh 那一套：只追加不重写、已有标记就不动、符号链接或多链接的文件拒绝并只记日志（I8）、打开软件只补一次
  （`terminal-commands-added`）。以前 bash、fish 账号在判断 shell 那一步就返回、没留记录，升级后第一次打开软件就会补上。
  `isZshLoginShell` 换成 `resolveMacosLoginShell`。
- 日志：`cli.shell-profile.checked` 在登录 shell 不是 zsh、bash、fish 时改说「登录 shell 不是 zsh、bash、fish，没改终端
  启动设置」，以前也落进「终端启动设置无需改动」；出错时的说明带上是哪个文件（如「终端启动设置（~/.bash_profile）」）。
- 测试：`macos-shell-profile.test.ts` 补 bash 三种文件情况、失效链接、fish（含 `XDG_CONFIG_HOME`、同名文件）、tcsh、
  符号链接和硬链接，另有真 zsh、bash（三种文件情况和失效链接）、fish 登录 shell 里按名字找到命令的端到端用例（系统自带的
  或 Homebrew 装的，有哪个跑哪个；CI 的 Mac 上有 zsh 和 bash）；`windows-cli-shell-access.test.ts` 补四种结果各自的日志。
- 第三十四批 B：macOS 打开工具时「终端」先起客户的登录 shell（读 `~/.zprofile`、`~/.zshrc`），再在里面跑 `launch.zsh`，
  `export https_proxy=http://127.0.0.1:7890` 这类设置一路带给工具；星芒从访达启动，自己的环境里没有这几行，
  `withoutDeadLoopbackProxies`（第十六批 5、Linux 版拆分 ②）管不到。补上 CHANGELOG 里「macOS 仍不绕」的打开工具那一半；
  npm 那一半在 Mac 上本来碰不到 `~/.zshrc`，不动。
- `macos-platform.ts` 新增 `buildMacosClosedProxyGuard`，`buildMacosTerminalScript` 把它插在 export 之后、启动工具之前：
  只看 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 的大写、小写两种写法，只认指向 localhost、127.x.x.x、[::1] 且写了端口的，
  用 `/usr/bin/nc -z -n -G 1` 试连（localhost 试 127.0.0.1 和 ::1），连不上的这一次 `unset`；开着的、指向别的机器的、
  认不出的不动，同一个目标只探一次。nc 不在、`zsh/regex` 载不进来时什么都不动；nc 自己报了错（不是单纯连不上）算探不准，
  也不动。函数里 `setopt localoptions noerrexit unset`，中途出错只当没探，返回后 `set -eu` 照旧；整段的错误输出丢掉，
  终端里不多出字，也不加新字。启动脚本写不进星芒的运行日志，所以没有日志。
- 和 `stale-proxy-environment.ts` 对齐：名字表用 `Record<StaleProxyVariableName, true>` 钉住（`import type`，不引入
  command-runner → macos-platform 的循环引用），那边加减名字这边编译不过；单测把同一张写法表交给 zsh 和
  `parseLoopbackProxyTarget`，认出的目标要一样。不同处：大小写两份各判各的（Mac 上本来是两个变量，去掉没开的、留下开着的）；
  写出来的 http `:80`、https `:443` 这里照样探，那边的 URL 解析当成没写端口；`127.1`、`[0:0:0:0:0:0:0:1]` 这类简写
  那边还原成本机地址，这里不认、照旧带上。
- 沙箱（Linux，装了 zsh 5.9）用假 nc 跑过新加的几条单测（`LANG=en_US.UTF-8`，断言 stderr 为空）；也把整份启动脚本里的 nc
  换成认 `-z -n -G 1`、真去连端口的假程序跑过：没开的端口被去掉、开着的留着、别的机器的留着，工具照常启动，退出提示照旧，
  stderr 为空，连 Node 启动约 50 毫秒；换成一调用就报用法错的 nc 时几个代理全留着，工具照常启动。用真 `/usr/bin/nc` 的
  那条单测只在 CI 的 macos-test 里跑；没在真机上演过。
- 第三十四批 A（只 Mac）：代下的 Node.js（`~/Library/Application Support/XingMangAI/Runtime/node`）在 PATH 里排在客户自己那份
  后面（第十六批 2）。客户那份低于 20 或读不出版本时，代下的那份永远轮不到：检测一直判成太旧，`planCliInstall` 每次装工具都把
  Node.js 排进准备步骤重下一遍，新手引导停在「准备工具」，装工具用的 npm 也落在旧 node 上（首页和检查页的
  Node.js 一行只显示客户那份的版本号，不提示过低）。这是对「客户自己的 Node 优先」的一处有意例外。
- `macos-node-runtime.ts` 新加 `resolveDarwinPreferredNodeDirectory`：代下那份不是普通文件就直接回 null，不起进程（绝大多数 Mac
  走这条）；照平常顺序先找到的 node 就是代下那份、或者版本够新，回 null；否则代下那份够新才回它的 bin 目录。
- `system-service.ts` 的 `preferredNodeDirectories` 把这个目录经 `additionalPaths` 排到最前，只用在本软件自己干活的地方：找 node、
  npm、npx 和问版本（`findInstalledExecutable`、`inspectTool`），`npm root --global`（新加的 `resolveServiceNpmGlobalRoot`），装工具
  找 npm 和跑 npm 的环境（`findNpmForCliInstall`、`resolveNpmBaseEnvironment`），打开工具时 `resolveCliCommand` 新加的
  `nodeDirectories`（JS 写的工具先在这里找 node）。判断结果 15 秒内共用（`scanReuseMs`），强制重新检测、装完 Node.js 后重新判断，
  缺代下那份的下好当场就用上。交给终端的环境、`~/.zprofile`、客户 node 够新的 Mac、Windows 和 Linux 都不动。
- `diagnostics.ts` 检查页的 Node.js、npm 两项同样先看代下那份，和首页一致。
- 不在这次范围：卸载工具用的 npm、画图 MCP 写进配置的 node（`main.ts`）、Codex 扩展管理（`codex-extensions.ts`）仍按原来的顺序找 node。
- 测试：`macos-node-runtime.test.ts` 钉判断规则；`tool-installation.test.ts` 钉 `nodeDirectories` 与 `npm root --global` 的 PATH；
  `system-service.test.ts` 按 darwin 跑检测、装 Node.js（已有不重下、缺的下好当场切换）、装工具的 npm 与 PATH、打开工具的
  `nodeDirectories` 与终端 PATH（Windows 主机上不跑）。
- 第三十五批 A：`electron/windows-elevation.ts` 打开工具的中转脚本用 `Start-Process -WorkingDirectory` 起终端，这个参数没有
  -LiteralPath 写法，PowerShell 一律按通配符解析（`PathUtils.ResolveFilePath` 不带 isLiteralPath），文件夹名带 `[` `]` 时报
  「the wildcard path … did not resolve to a file」，旁边碰巧有对得上的文件夹（`作业1`）才打得开。新增 `escapePowerShellWildcard`，
  在 TypeScript 里给 `` ` `` `[` `]` `*` `?` 各加一个反引号（与 PowerShell 7.6 起的 `[WildcardPattern]::Escape` 同一组字符；
  Windows PowerShell 5.1 和 7.5 及以前的不转义反引号，所以不在脚本里调它），再照旧包 `powerShellLiteral`。只用在
  `-WorkingDirectory`；终端里的 `Set-Location -LiteralPath` 和 `execFile` 的 `cwd` 照原样。
- 中转脚本开头补上 UTF-8 输出（`[Console]::OutputEncoding`，try/catch 包住，设不上照旧往下走）。`-EncodedCommand` 起、标准错误被
  重定向时，PowerShell 把报错写到 `Console.Error`，编码跟着 `[Console]::OutputEncoding`；中文 Windows 默认 GBK，`launchCliPowerShell`
  按 UTF-8 读回是乱码，`describeWindowsCliLaunchError` 里按中文认原因的几条也认不上。终端窗口那段早就有这句，中转脚本漏了。
  报错外面那层 CLIXML（`#< CLIXML <Objs …>`）和 Node 附上的「Command failed: …」这次没动，认不出原因时错误框照旧原样带出来。
- `e2e/windows-powershell-probes-smoke.mjs` 加一项：按 App 给 ``作业[1]\a`[b]`` 造的中转脚本，执行到 `Start-Process` 为止都照原样，
  只把要起的终端换成隐藏、等它结束的 cmd.exe，确认能起、而且起在这个文件夹里；不转义的同一脚本必须仍然失败，报错里的中文按 UTF-8
  读得出来。Windows PowerShell 5.1 和 PowerShell 7 都跑。单测按 PowerShell 的 `WildcardPattern` 规则核对转义后读回来是原路径。
- 第三十五批 C：`electron/ipc.ts` 里 `diagnostics:export`、`runtime-logs:export-feedback` 两个保存窗口的类型名从 `'Text'`
  换成 `chat-history:export-text` 早就在用的 `'文本文件'`。`ipc.test.ts` 新增一条用例，钉住这三个存 .txt 的保存窗口都用这个名字。
- 第三十五批 D（yoyo 2026-10-06 点头）：Windows Installer 同一时间只让装一个安装包，别的程序正在装时 msiexec 以 1618 退出
  （ERROR_INSTALL_ALREADY_RUNNING）。`electron/node-runtime.ts` 的 `errorText` 以前只认 1602、1925、1603，1618 落到原话
  「命令执行失败（退出码 1618）」；下载源循环又把它当成这个源的问题，换下一个源把几十 MB 的安装包再下一遍，结果还是 1618。
  现在 `errorText` 认出 1618 时说「Windows 正在安装别的程序（错误 1618），Node.js 还没装上。等它装完再点一键安装；一直这样就先
  重启电脑再试」（写法照 1603 那句），`installNodeRuntime` 的下载源循环认出它就直接停，不再换源。别的失败（1603 等）照旧
  换到下一个源；winget 那一步没改。
- `node-runtime.test.ts` 新增两条 Windows 用例，真走查询、下载、校验、安装这一路，只把联网和起进程换成假的：1618 只从国内镜像
  下一份、安装只跑一次、进度里不再出现「正在尝试备用下载源」；1603 照旧换到官方源。
- 第三十五批 B：Windows 上 Defender、索引服务正好开着目标文件或刚写好的临时文件时，「临时文件换过去」那一步会报
  EPERM / EACCES / EBUSY，过几十毫秒就好。`safe-local-data.ts` 早为画布自动保存在这一步加了重试，这次把那段循环抽成
  `renameWithTransientRetry`，另加同步版 `renameWithTransientRetrySync`（只在出错后用 `Atomics.wait` 等，最多共 300 毫秒），
  规矩不变（`isTransientReplaceError` 认的几种错误，等 20/40/80/160 毫秒，最多 5 次），用在 `config-files.ts` 的
  `executeFilePlans` 换文件、回滚两处和 `app-settings.ts` 换设置文件、换备份两处。
- 每次尝试前都重跑原来的路径检查（`assertSafeSourceAndTarget` / `assertSafeDataFile`）和 `beforeReplace` 钩子，等的时候被换成
  联接、硬链接的照旧拒绝；OpenCode、WorkBuddy 正好在等的那一下存了自己的改动时，`external-tool-config.ts` 钩子里那道「保存前
  已变化」照旧拦下，不会盖掉。5 次都失败就原样抛出最后那个错误，后面「写不进安装目录」这些说法和写进去的内容都不变。
  `writeAtomicSafeFile` 的行为不变（用尽后仍说「写入被系统占用」）。同类的 `backups.ts`、`claude-desktop-local-transaction.ts`、
  `codex-extensions.ts` 这次没动。
- 沙箱里用 Electron 43.6.0 确认过主进程能用 `Atomics.wait`（Linux）。
- 第三十六批 A：`electron/main.ts` 里聊天和画布共用的三个系统菜单、画布项目文件夹的三个系统菜单，出错时把 `error.message` 直接当
  `dialog.showErrorBox` 正文。菜单先弹、点了才读文件，文件被挪走或占用时 `fs.promises.open` 抛的 Node 原话是英文，还带完整路径和
  用户名；这六处也不写日志。新增 `window-presentation.ts` 的 `assetMenuFailureDialog`：报错本身是中文（`isChineseSentence`，先去掉
  路径和引号段再看）照原样，其余换成这几个错误框里原有的「无法完成图片/视频/音频操作」，标题不变。六处改走 `showAssetMenuFailure`，
  先 `runtimeLog.exception(…, 'asset.menu.failed', …)` 记原话（带媒体类型和菜单项），再弹框。菜单本身、读文件和链接检查都没动。
- `window-presentation.test.ts` 钉住英文原话换兜底句、主进程自己的中文原样、main.ts 六处都走这个函数且不再有错误框直接用 `error.message`。
- 第三十六批 D（10-5 拍板清单第 3 条，10-6 照推荐「改」）：自动更新记录 `pending-update.json` 里的「下好了」`downloadedVersion`、
  「打开时试过了」`attemptedVersion`、「退出时试过了」`quitAttemptedVersion` 装成功以后从来不清。客户装回旧版后，旧版查到、
  下好同一个新版本时，`resolvePreviousAutoInstallFailure` 照「试过了、还不是正在运行的版本」把它认成上次没装上，弹
  「新版本上次没装上…」；`decideLaunchInstall`、`decideQuitInstall` 也因为「试过了」不再自动装，只在退出时问。
- `auto-update-install.ts` 新增 `resolveRecordToWriteAtLaunch`：启动时把记录里等于正在运行版本的三项清掉，连同原来就只认一次的
  `backgroundInstall`，`main.ts` 照它写一次（原来只在有 `backgroundInstall` 时写）。三项都要清：只清两个「试过了」，旧缓存里
  还留着新版安装包时，装回旧版第一次打开就会被打开时装装回去。认「上次没装上」、打开时装照旧看读到的原样：electron-updater
  不会把正在运行的版本当成新版本（`isUpdateAvailable` 先比 `semver.eq`），清没清对它们一样。
- 只清等于正在运行版本的，不清比它旧的（候选文件写的是「不高于」）：本机版本被撤回时 `allowDowngrade` 打开，会往回退到更旧的
  那一版（回退工作流就是这么退的）；那一版退出时没装上，要是下次打开就清掉，之后每次退出都会再去装、授权窗口一直弹。
- 清记录这一步在自动更新装上的那一版里跑：从带这个改动的版本装回任何旧版都不再误报；已经卡在这种状态的客户（今天开着旧版、
  记录里留着新版的「试过了」）分不出是装成功又退回来的还是真没装上，这次修不到，等他们点一次「重新安装」。装回旧版、开着
  「自动更新」的客户，新版本下好后下次退出就会被自动装回去（关机时没装的，下次打开时装）；客服让客户退版时，要同时让他
  关掉「自动更新」。
- 第三十六批 C：`build/installer.nsh` 新增 `un.xingmangRemoveFallbackShortcuts`，`customUnInstall` 在真卸载（`${IfNot} ${isUpdated}`）
  里、卸载清理之后调用：按所有用户安装时切到当前用户，删掉 `customInstall` 补建的 `$DESKTOP\${SHORTCUT_NAME}.lnk` 和开始菜单里的
  `${SHORTCUT_NAME}.lnk`（定义了 `MENU_FILENAME` 时删文件夹里那个，再不带 /r 地 RMDir 那个文件夹），再用
  `xingmangRestoreShellVarContext` 切回。electron-builder 的卸载模板只删 `setLinkVars` 在 all 上下文里算出的 `$oldDesktopLink` /
  `$oldStartMenuLink`，补建在当前用户那里的一直没人删；`customInstall` 又只在路径上没有文件时才补，指向旧文件夹的图标还在就不补。
- 跟模板删公共图标的做法一致：带 `--keep-shortcuts` 不删，`DO_NOT_CREATE_*` 关掉的那一类跳过，删之前先 `WinShell::UninstShortcut`。
  只删这几个固定路径，不用通配符、不带 /r。升级（--updated）时不跑：新版不补图标，这时删了图标就真没了。卸载详情里不加新句子。
- 卸载程序是提权跑的，这两个图标却在当前用户自己能改的地方，所以不用 `Delete`，删除交给 `un.xingmangDeleteFallbackShortcut`：
  `CreateFileW` 带 `FILE_FLAG_OPEN_REPARSE_POINT` 打开，`GetFinalPathNameByHandleW` 给的路径必须和要删的一字不差（路径里有一段被联接、
  符号链接转走就对不上），不是文件夹、不是 name surrogate 类重解析点（符号链接、联接），才经同一个句柄用 `FileDispositionInfo` 删；
  哪一条不对都不删。两种图标都不建时这个函数不定义（没人调用的函数在 makensis -WX 下是编译错误）。
- `scripts/windows-installer-shortcuts.test.cjs` 加四条：卸载删的路径与 `customInstall` 在当前用户那里补建的逐条对上（顺手建的文件夹同理）；
  只在真卸载里调，守着 `--keep-shortcuts` 和 `DO_NOT_CREATE_*`，函数只进卸载程序那一遍；切到 current 以后每条路都切回；
  删除只经核对过的句柄（不跟最后一段链接、比对最终路径、拒文件夹和指向别处的重解析点、句柄每条路都关、寄存器原样还回）。
  `windows-installer-uninstall-cleanup.test.cjs` 那条正则放宽到 isUpdated 守卫里可以跟着别的调用。
- `windows-uninstall-smoke.yml` 加一步 `scripts/windows-uninstall-shortcuts-smoke.ps1`：真装真卸。先用 icacls 拒绝所有人往公共桌面和
  公共开始菜单里加文件，让安装程序自己把图标补建在当前用户那里，旁边再复制一个别的名字的；覆盖安装、带 --updated 的升级各一次后都还在；
  真卸载后补建的两个没了、别的名字那个还在；再装到另一个文件夹，两个图标又补出来。第二次卸载前把当前用户的桌面位置指到一个联接上
  （联接后面放一个同名图标），开始菜单那个换成指向别处的符号链接：卸完联接后面的、符号链接本身和它指向的文件都还在。最后把桌面位置
  和两个文件夹的权限改回去。
- 这次不管的两种：普通账号输别的管理员密码代为安装和卸载（补建、删除都在那个管理员那里，两头对称）；不先卸载、直接拿新安装包覆盖安装
  又换了文件夹（旧卸载程序带 --updated 跑，不删；新安装程序看见旧图标在，也不补）。
- 第三十六批 B：electron-builder 的安装程序每次安装都把自己拷到 `%LOCALAPPDATA%\xingmang-ai-manager-updater\installer.exe`
  （模板 `installer.nsh` 的 `APP_INSTALLER_STORE_FILE`，留作增量更新的底），electron-updater 把下好的新版放在同一目录的
  `pending` 里；Mac 上是 `~/Library/Caches/xingmang-ai-manager-updater`（`pending` 加一份留作增量底的 `update.zip`）。
  卸载模板一次都不碰 `LOCALAPPDATA`，卸载清理以前也不管它。
- `uninstall-cleanup.ts` 加 `updaterCacheDirectoryName`、`resolveUpdaterCacheDirectory` 和 `clearUpdaterCache`。位置照
  electron-updater 的 `getAppCacheDir`，Mac 是 `~/Library/Caches`；Windows 的卸载清理带着管理员身份，不让环境变量决定去哪里删
  （同不读 `CODEX_HOME`）：用 `os.userInfo().homedir`（系统登记的用户目录，只有管理员改得了）下的 `AppData\Local`，
  `LOCALAPPDATA` 和它对不上、或者不是带盘符的完整路径就不删。删法是把原来的 `removeChatHistoryTree` 抽成带名字、带层数上限的
  `removeOwnedTree`，聊天记录和更新缓存共用：每一级过 `assertNoReparseComponents`，文件走 `removeSafeDataFile`，碰到符号链接、
  目录联接和多链接文件就留在原地、其余照删（I8），不用整棵删。聊天记录那半的行为和报告文字不变。
- `startUninstallCleanup` 一开头调 `configureRelocatedFolderAccess('trusted-only')`：这一支本来就没打开「C 盘搬家」的跟随，
  现在钉死，以后谁在它前面打开了也不会在提权删除时跟着联接走。
- Windows：`runUninstallCleanup` 在代理还原之前删（还原可能等到超时，没有代理记录时也要删到）；删不掉只往报告里写一行
  `update cache: …`，不加退出码，卸载程序给客户看的几句不变。另一个管理员账号卸载（退出码 32）时照旧什么都不动；
  升级安装带 `--updated` 不跑卸载清理，不会删到正在用的安装包。`startUninstallCleanup` 多一个可替换的参数，测试里不碰跑测试
  那台电脑上真的更新缓存。
- Mac：`macos-uninstall.ts` 在程序确实挪进废纸篓之后、退出之前删，挪不动就不删（下好的新版还能装）；没删掉只记日志，
  不算进 `leftovers`，提示不变。`main.ts` 接上这一步。
- `scripts/windows-uninstall-cleanup-smoke.ps1`：每次装完先查 `installer.exe` 确实拷进了更新缓存，每轮清理前放一份假的
  下好的更新，清理后查整个目录没了；第一轮直接清理时缓存里另放一个目录联接，查联接和它指向的文件原样留着、旁边的照删，
  清理退出码仍是 0。
- 第三十七批 C（第三十五批 B、#847 的后续）：#847 抽出的 `renameWithTransientRetrySync` 用到同类的几处换文件上，规矩不变
  （EPERM / EACCES / EBUSY / EAGAIN，等 20/40/80/160 毫秒，最多 5 次；用尽就原样抛出最后那个错误，后面的说法不变）。
  `backups.ts`：做备份最后把临时文件夹改名成正式备份（「改用当前账号」「备份并重置」、修提醒设置、开机补设置、备份页
  「创建备份」、恢复前那份都先走这一步，刚写进文件的文件夹被安全软件扫着时改不了名），恢复时挪开当前配置、换上备份、
  失败时往回换（单个文件里一处、整次回滚一处）；`claude-desktop-local-transaction.ts`：换文件和往回换；
  `codex-extensions.ts`：改写 config.toml（`setSkillEnabled`、`setPluginEnabled` 都走这里；新界面「技能」页开关 Codex
  技能用的是前者，「插件」页开关 Codex 插件走 CLI，不经过这里）和删 Skill 时把文件夹挪进回收站。
- 每次尝试前都重做原来的检查（原有检查的先后不变）：备份目录（`ensureSafeDataDirectory`，开头查过的那项，改名前
  再查）；恢复时的路径（`assertSafeTargetPath`）、回滚位置还空着、当前配置和快照一致、临时文件的快照和 SHA-256；
  Claude Desktop 的账号（`assertContext`）、各文件快照、暂存文件归属、目标文件；Codex config.toml 的路径和「单链接
  普通文件」检查（抽成 `assertReplaceableTomlFile`，备份前、每次换文件前各查一遍）；删 Skill 时两边的路径。等的时候
  被换成联接、多了硬链接的，照旧拒绝；恢复备份和 Claude Desktop 这两处还比对快照，被别的程序存了改动的也照旧拒绝、
  不盖掉。
- 整次回滚把挪开的那份放回去之前，多确认一次原位置空着（恢复上去的那份刚删掉）：等着重试的那一下若有程序在这儿新写了
  文件，不拿挪开的那份盖它，照旧按「回滚失败」把挪开的那份留着。
- `safe-local-data.ts` 没改。测试照 #847 的写法用 `vi.spyOn(fs, 'renameSync')` 模拟被占住：占一两下能等过去；一直占着照旧报
  原来的错、往回换照旧；等的时候被改了照旧拦下。
- 第三十七批 D：`npm ci` 那一步外面加一个 `npmDownloadHeartbeatMs`（15 秒）的计时器，发 stage 'download'、带 elapsedMs 的
  安装进度，原话是新的 `npmDownloadHeartbeatMessage`：「仍在从国内 npm 镜像下载…（已用时 3 分 05 秒）」、走官方源时
  「仍在从 npm 官方源下载…（已用时 3 分 05 秒）」（2026-10-06 拍板的原话；「从」后面接 npm 时空一格，所以不拼
  `npmRegistryLabel`）。写法照解析依赖图那一步的心跳，只报已用时，不写百分比。
- renderer-v2 没改：带 elapsedMs 的 'download' 进度本来就把进度那一行换成现成的「还在下载，已经等了 …」，原话进安装日志；
  `sendInstallProgress` 不把带 elapsedMs 的记进运行日志，每 15 秒一条、最长 30 分钟也不会刷屏。
- 计时从这一轮 `npm ci` 起算，换源从零算；下完、卡住被掐（第三十七批 A 的看门狗）、客户取消都在同一个 finally 里停。
- 第三十七批 B：托管目录（Mac、Linux，Windows 按管理员身份运行时）的装和更新在 `npm-cache/npm-transaction-XXXXXX` 里做，
  正在用的工具目录先挪成里面的 `previous-prefix`，新版换上、检查通过、报完成，最后 `finally` 才删整个事务目录。删完之前退出、
  关机、崩掉，或者删到一半失败，下次装、更新、卸载任何一个工具开头的恢复（`managed-cli.ts`）只看到 `previous-prefix`，分不清
  新版检查过没有，一律退回旧版，删了一半时退回来的还是残缺的。
- `replaceManagedNpmPrefixAtomically` 检查通过后把 `previous-prefix` 改名成 `superseded-prefix`（用传进来的
  `operations.rename`，EPERM / EACCES / EBUSY / EAGAIN 照 `safe-local-data.ts` 的规矩等 20/40/80/160 毫秒，最多 5 次），
  返回 `{ backupRetired }`；改不成就留原名、和以前一样，只记一条 `cli.install.backup-retire-failed`。恢复的判断不动
  （本来就只认 `previous-prefix`），加了注释，最后删事务目录那一下也加了重试。检查没过、检查前就断了的退回保护不变。
- `install-leftovers.ts` 多扫托管 npm 缓存目录（`managedNpmCacheRoot`；普通权限的 Windows 不扫）里的 `npm-transaction-`
  加 6 位随机串，照旧 6 小时以上才删、不跟链接；新加的 `preserveIfContains` 让还有 `previous-prefix` 的事务再旧也不删，
  留给恢复（恢复做完剩下的 `interrupted-prefix` 照删）。Windows 按管理员身份运行时，要这次运行已经加固并核过那个目录的
  ACL（`isRegisteredTrustedManagedWindowsPath`）才交给清理。`finally` 的删除加 `maxRetries: 2, retryDelay: 200`，删不掉记
  `cli.install.transaction-cleanup-failed`（路径去掉用户目录）。
- 测试：Linux 上真走一遍更新、让收尾删除失败、再准备托管目录，改前 Codex 被退回 0.1.0，改后保持新版，6 小时后残留被清掉；
  `managed-cli.test.ts` 新加的两条在三个平台上都跑。
- 第三十七批 A：`npm ci` 那一步以前用 `npmDownloadTimeoutMs`（5 分钟）当总时长，命令运行器到点就结束整棵进程；每个源、每次安装
  都用新的 attempt-N 目录和缓存，所以换源、重试都从零开始，每秒不到 0.3～0.5 MB 的客户永远下不完（Claude Code 约 100 MB、
  Codex 约 130～160 MB）。npm 自己不掐慢而不断的下载（@npmcli/agent 的 fetch-timeout 管的是连接空闲多久）。
- 现在这一步看进展：`createNpmDownloadStallWatch` 每 `npmDownloadProgressCheckMs`（15 秒）用 `measureDirectoryBytes` 量一次这一轮的
  attempt-N 目录（不跟链接和目录联接、顺序走，根目录读不了就报错、不当成 0），大小连续 `npmDownloadStallTimeoutMs`（3 分钟）没变才中止，`npmDownloadCeilingMs`
  （30 分钟）交给命令运行器当总上限兜底。make-fetch-happen 边下边把数据分一路写进 cacache 的临时文件、tar 边读边解进 node_modules，
  目录大小就是 npm 不打印的进度；变小也算在动（npm 自己重试前会丢掉下坏的半截），量不出来的那一拍也算在动，时钟用单调的
  `performance.now()`。`executeNpm` 加一个可选的 signal，和取消信号用 `AbortSignal.any` 合在一起；是看门狗掐的就抛
  「下载超时，长时间没有完成，已中止」（和 TIMED_OUT 共用一个常量），后面换源、拼报错、渲染层归成「下载超时」都不变；客户点取消照旧报
  「安装已取消」。卡住被掐时运行日志记 `cli.install.download-stalled`（源、已用时、目录大小）。
- 后面带 `--offline` 的「装到本机」那一步不动，还是 5 分钟。一个源失败后先删掉它的 attempt-N 目录再换下一个源，删不掉就留给
  结束时的 finally。没有改 `command-runner.ts`，没有新写界面文字（下载时的进度提示是第三十七批 D，要另外点头）。
- 第三十八批 C：按管理员身份运行时，开机安静期过后再等 2 分钟的那一轮清理，会去删 `ProgramData\XingMangAI\InstallerCache`
  里 6 小时以前留下的临时文件夹，删之前不确认这个文件夹只有管理员能写。ProgramData 默认允许普通用户在里面建东西，第一次加固
  中途断掉的也停在「属主是管理员、但 Users 能写」的样子；这时普通进程可以在查完、正删的时候把里面的子文件夹换成联接，让管理员
  权限的删除落到别处（同 I8）。#854 给托管 npm 缓存补过这一判，安装缓存这一处漏了。
- `system-service.ts` 的 `resolveInstallLeftoverLocations` 照 #854 那一判：Windows 上安装缓存根没通过
  `isRegisteredTrustedManagedWindowsPath`（这次运行亲手加固、核过 ACL）就不交给清理，核过以后那一轮再清。装、卸工具准备托管
  目录或建安装用的临时目录时会把整个 `ProgramData\XingMangAI` 加固一遍，所以装完工具那一轮照清，开机那一轮一般跳过。普通权限
  的 Windows、Mac、Linux 不受影响。
- 测试：`system-service.install-leftovers.test.ts` 加两条：Windows 管理员身份下这次运行没核过就不扫安装缓存、登记以后扫（只在
  Windows 上跑）；不是 Windows 时照旧扫安装缓存（各平台都跑）。
- 第三十八批 A：`proxy-bypass.ts` 以前一撞上「代理连不上」（ERR_PROXY_*、ERR_TUNNEL_CONNECTION_FAILED）就整个改直连，`active` 只有
  改成 true 的地方，本次运行再也改不回来。代理软件换节点、重启内核、开机比星芒晚起几秒的那一下，就让装工具、拉插件、下官方安装包、
  `downloadsFollowSystemProxy` 一直走直连到退出，「重新检测」走的 `tryBypass()` 也只答「已经直连」。
- 改直连之前再看一眼：账号请求报 proxy（`recoverFailedRequest`）和站点直连期间每 5 分钟那次检查（`checkSystemProxy`）都先等
  `proxyRecheckDelayMs`（3 秒）经默认会话再探一次，几个请求一起撞上只探一次（`lookAgainAtProxy`）。探通了不改直连，那次请求经系统
  代理重发（运行日志 `proxy-bypass.proxy-back`）；还是 proxy 才照旧整个改直连；换成别的错（超时、连接被断、没网）先什么都不改、
  不重发（`proxy-bypass.proxy-unclear`，探测自己等满的 TimeoutError 记成 timeout）。没有代理、加速开着时照旧当场答不重发，不等这
  3 秒；等的时候有人在试整个改直连就等它试完，试过、直连也不通的不接着再试一遍。`new-api-client.ts` 里 `retryOffProxy` 的约定注释
  补上「代理只是在重启、又连得上了」这一种。
- 改了直连以后能改回去：整个改直连期间 `routeSiteRequest` 也借连星芒的请求的时机，隔 `systemProxyCheckIntervalMs`（5 分钟）在后台经
  新加的 `probeSystemProxy` 探一次（`main.ts` 照 `xingmang-site-direct` 的写法另建只跟随系统代理的内存分区 `xingmang-system-proxy`）。
  连得上、且星芒自己的加速没开（读不到按开着算；只用 `bypassBlocker` 判加速的那一半，判 DIRECT 的那一半看的是默认会话，直连时总答
  DIRECT），就把默认会话改回 `system`、`active = false`，记 `proxy-bypass.direct-ended`。`site` 一并清掉、`siteHandedBack` 记一笔，
  这之前在直连上发出、后来失败的请求换系统代理重发一次，不回头再探直连。#578 / #841 的加速取舍不动，`downloadsFollowSystemProxy`
  改回后跟着变回 true。
- 不在一次下载或请求进行到一半时换线路：在 Electron 43.6.0（Linux）上实测过，会话中途从直连改成跟随系统代理、反过来也一样，正在传的
  HTTP 和经 CONNECT 的 HTTPS 请求照原来的路传完，不会被掐断，只有新发的请求走新的路；npm 子进程的代理环境变量启动时就定了。
- 改回时顶上「已经改为直接联网」那条横幅自己收起：`proxy-bypass.ts` 加可选依赖 `directEnded`，改回那一刻调用；`main.ts` 接上它，
  给主窗口发新的事件通道 `network:proxy-bypass-ended`（`onProxyBypassEnded`，载荷为空，`ipc-contract.ts` 与 `preload.ts` 两份通道表
  同步加），`renderer-v2/App.tsx` 收到就把 `proxyBypassNotice` 置回 false。没加新字。
- `main.ts` 的 `proxy-bypass.account-retry` 日志在「代理只断了一下、经系统代理重发」时改成如实的一句。没做：没登录、也一直不连
  星芒的时候，要等下一次连星芒才看；
  代理软件活着但不转发星芒的（#796/#822 那类），整个改了直连以后经代理探不通星芒，照旧直连到退出，和以前一样（要改得照站点那一路
  只让星芒直连、别的改回代理）；余额连着被拒、界面自动替用户试直连（`App.tsx`）那条路不经过「再看一眼」，改了以后同样能改回。
  没在真机上演过。
- 第三十八批 A 的后续：整个改直连以后，`proxy-bypass.ts` 的 `restoreSystemProxy` 以前只认「经只跟随系统代理的会话连得上星芒」，
  代理软件起来了、只是不转发星芒的（#796/#822 那类）探不通，就一直直连到退出。现在按探测失败的原因分：proxy 类、offline、
  认不出来的照旧接着直连；超时、连接被断、回了别的东西，说明代理软件起来了，再经站点专用的直连会话探一次，通了、加速也
  没开（探完直连才判，探的那几秒里加速开了也不改），就改回 `system`、`active = false`，同时开一轮站点直连（和
  `divertSiteRequests` 一样），记 `proxy-bypass.direct-ended`（detail 带 `failure`），调 `directEnded` 收起横幅。之后每 5 分钟那次 `checkSystemProxy` 照旧：代理软件还在就不动，代理没了再整个改直连，
  不会来回切。
- 在 Electron 43.6.0 上实测过 `session.fetch` 经 HTTP 代理的几种失败：代理端口没开是 ERR_PROXY_CONNECTION_FAILED；代理对 CONNECT
  回 502、403 是 ERR_TUNNEL_CONNECTION_FAILED；回 200 以后断开是 ERR_CONNECTION_CLOSED、ERR_CONNECTION_RESET；回 200 以后不再回话、
  或者一直不回 CONNECT，都是探测自己等满的 TimeoutError。探测失败的分类（TimeoutError 记 timeout）提成顶层的 `probeFailure`，
  `lookAgain` 一起用。
- 没做：代理对星芒直接回 4xx、5xx 的（ERR_TUNNEL_CONNECTION_FAILED）从撞上那一刻就按「代理连不上」整个改直连，改回也照旧要等它
  连得上星芒；它在别处也都按代理连不上算，只在改回这里放过去，5 分钟后会再改直连、来回切。要分开得让账号请求那边把失败原文
  带过来，这次没动。没在真机上演过。
- 第三十九批 B：`electron/provider-sessions.ts` 列 Claude Code 记录时把 `~/.claude/projects` 下每个 `.jsonl` 都算一条，Claude Code
  派出去的子任务（subagent）也各占一条：标题一般是 AI 交代给子任务的话，首页「最近」的三条容易被它们占满，「N 条记录」和 Claude Code
  那一栏的条数虚高。删记录时却把与记录同名的文件夹（子任务就在里面）当作这条记录的一部分一起删，列和删两个口径。
- 现在发现这一步按名字跳过 `agent-*.jsonl`（`isClaudeTranscriptFile`），再去掉落在某条记录同名文件夹里的 `.jsonl`
  （`claudeConversationFiles`；同名文件夹和删记录共用 `claudeCompanionDirectory`）。子任务文件不再探测，也不占 5 万个会话文件的
  上限；探测缓存里它们的旧条目在下一次整轮列表时清掉。依据是 npm 上的 Claude Code 安装包：2.0.30、2.0.77、2.1.0 把子任务写成项目
  文件夹里的 `agent-<id>.jsonl`，2.1.30 起（核到 2.1.289）写进 `<记录id>/subagents/[子目录/]agent-<id>.jsonl`；2.0.30、2.0.77、
  2.1.289 自己列会话都只认按 UUID 起名的文件。
- 删记录、看记录、导出不变。旧存法（2.0 到 2.1 初期）下子任务文件和记录并排，删记录原来就不连它们一起删，这次也没改；Claude Code
  默认 30 天清一次旧记录，这种文件一般早已被清掉。
- 测试：`provider-sessions.test.ts` 加三条：两种存法的子任务都不列、也不打开；普通子文件夹里的、名字里只是带 agent 的照列；子任务
  不占文件上限。删记录那条补上「列表里只有一条」。
- 第三十九批 A：`quit-blocking-tasks.ts` 的 `describeInstallTask` 多认 `runtime:git`（「正在安装 Git」）和
  `external-client:install:<客户端>`（`isExternalToolId` 认得的才算，名字取 `externalClientNames`，「正在安装 WorkBuddy」这类）。
  以前只认 `cli:install:*`、`runtime:node`、`runtime:python`、`desktop:codex:install`：装 Git（含 Windows 上装完 Claude Code
  自动接着装的那一段）和三个外部客户端时，托盘 / 菜单「退出」不拦；打开时自动装新版本拿同一个函数判 busy，也不等它们。
  认不得的 key 照旧返回 null，退出不会被拼错的 key 挡住。退出确认框的整句、`main.ts`、`auto-update-install.ts` 都没动。
- 测试：`quit-blocking-tasks.test.ts` 加 Git 和三个客户端的说法、畸形客户端 key 返回 null、Git 后面排着 WorkBuddy 时计数为 2；
  另加一条把程序里会进安装队列的每种 key 列一遍，断言退出拦截认的范围和防睡（`install-keep-awake.ts` 的
  `isKeepAwakeInstallKey`）一致。
- 第四十批 C（第三十九批「不收」第 2 条）：首页、「安装卸载」页的一次安装比主进程那一段长。主进程装完，界面还要同步 Key、
  整轮重新检测；Windows 上装 Claude Code 时，主进程装完它还接着装 Git（`installGitAlongsideClaude`）。这两段那一行的「取消」
  还亮着，点了回的是 `install-cancellation.ts` 找不到句柄时那句「这个工具当前没有正在进行的安装。」。
- `App.tsx` 的 `install()` 多一个 `finishing` 标记，`toolsApi.install` 回来以后置上；`cancel` 和换装时卸载那一步一样直接回现成的
  「这一步已经不能取消了。」，不再问主进程。Codex 桌面端走同一个函数，一起改好。
- `system-service.ts` 的 `installCli`：Windows 上的 Claude Code 改由新的顶层函数 `finishClaudeInstallWithGit` 收尾。Claude Code
  那一项装成后先把取消句柄封住（`gitAlongsideClaudeSealReason`，还是那一句），Git 那段结束（装上、没装上都算）再从登记表注销；
  Claude Code 自己失败或被取消就不进 Git 这段，照旧马上注销。别的工具、别的平台照旧在出队时注销。Git 那段句柄还登记着，
  这时再装一次 Claude Code 会走「已登记」那一支、另排一次取消不了的安装；界面上 `useToolbox` 的 `run` 按工具加锁，碰不到，
  注释里写明了。装 Git 本身仍接不上取消（`installGitRuntime` 不收 signal），这次没动。
- 测试：`system-service.install-cancel.test.ts` 加四条：Git 那段取消被拒、也不真的停；Git 抛错也注销；Claude Code 自己被取消或
  失败时不装 Git、马上注销。注入的 platform 管不到 `installCliOperation` 里读真实 `process.platform` 的几处，在 Linux / macOS
  主机上走不通 Windows 那条安装，所以只测这一段，三个平台都跑。`app-check.mjs` 加首页和「安装卸载」页各一条：用 `holdNextScan`
  停在同步那几秒，点「取消」说「这一步已经不能取消了。」，也没有再调 `cancelCliInstall`，放开后照常装完。
- 第四十批 B：记录页「接着聊」（`pages-management.tsx` 的 `SessionsPage` 里的 `resume`）直接调 `api.launchCli(…, 'resumeLast')`，
  `App.tsx` 的 `launch()` 打开前那几道关一道没过：检测出错或没装、Codex 老配置先修（#650）、没连好账号先开配置框、每天第一次打开时
  核对默认模型（#520，第十二批 5）。后两样加进 `launch()` 时记录页这条没跟上；主进程 `cli:launch` 只拦自定义地址和文件夹不在，
  没 Key 的配置当官方账号放行。
- 那一段原样提成 `prepareToolLaunch(id, epoch)`：返回打开前读到的快照和配置，`null` = 不往下走（问话框里关掉了、中途换了账号），
  换账号以后抛出来的错也按 `null` 收掉，和 `launch()` 原来的规矩一样；`launch()` 先调它，后面照旧。`BusinessPage` 多转一个可选的
  `beforeResume`，记录页在 `launchCli` 之前先等它：返回 false 就什么都不打开、不报错、不说「已打开」；过不了的原因（比如「请先确认
  账号连接，再打开工具。」）照常挂在记录页页顶。记录页自己的成功提示、文件夹刚被删时那句实话、通知首页重读「最近」都不变。
- 换模型那一问以前只有首页、托盘一条路，`launchRequest` 保证同一时刻只有一问。记录页不走那条路：它那一问开着时从托盘再打开工具，
  后来的一问会盖掉前一问的回答函数，记录页一直转圈，关窗口时还当有任务没做完。现在新的一问先替用户关掉旧的一问（等于那次先不打开）。
- 只用现成的问话框、配置框和句子，不新写字。记录页「接着聊」可能多一次联网核对模型：每个工具每天第一次，最多等 5 秒，核对不成照常打开。
- 测试：`testing/app-check.mjs` 补 6 条浏览器回归：检查都过时照常接着聊，且打开前核过模型；默认模型用不了时先问，点「换成」先存模型
  再接着聊；关掉问话框什么都不打开、不报错，「照旧打开」不改配置照常接上；没连好账号时打开配置框、页顶写原因、不打开；问话框开着时
  换账号什么都不打开；问话框开着时从托盘打开工具，记录页那次不打开、按钮恢复能点。换回改前的代码这 6 条都红；只去掉「先关掉旧的一问」
  那一行，托盘那条红。
- 第四十批 A：托盘「已安装的工具」（`main.ts` 发 `window:launch-tool`）和 Ctrl / Command + 1～5 交给 `requestLaunch` 的只有工具名，
  不带文件夹，`launch()` 拿不到 `remembered` 就弹 `chooseWorkspace`。#702 只给首页那颗按钮接上了「记住上次的文件夹」
  （`Home.tsx` 先用 `launchWorkspaces` 挑好再交出去），这两个入口没跟上；第七批「看过但不列」以为托盘已经覆盖，那句不对。
- `App.tsx` 加 `requestLaunchInLastWorkspace`：Codex 桌面端照旧直接 `requestLaunch`；四个命令行工具先读 `toolsApi.recent()`
  （首页那份 60 秒缓存，读不到当没有记录），按 `launchWorkspaces(记录, providerFor(id), snapshot.config.rememberedWorkspace)[0]`
  挑文件夹，挑得到就走 `launchRemembered`（文件夹不在了提示「上次用的目录已经找不到了，请重新选择。」再弹选择框），挑不到照旧弹。
  读记录那一下换了账号就不接着打开，同 `launch()` 的 epoch。不新写字，不加 IPC 通道，主进程不改。
- 测试：`testing/app-check.mjs` 加三条：托盘和 Ctrl+2 用首页按钮上的文件夹、没记录也没选过的 Ctrl+5 照旧弹、托盘开 Codex 桌面端不变；
  首页选过一次后托盘和 Ctrl+1 不再问，记录读不到时也一样；记住的文件夹不在了先提示再弹。夹具 `launchCli` 加 `?workspaceGone`
  （打开 `C:\work\my-app` 时报主进程那句「工作目录不存在，请重新选择」）。三条在没改 `App.tsx` 时都红。
- 第四十一批 C：首页「最近」的 60 秒缓存（#314）在打开工具时只作废（`api.ts` 的 `launch`），没人叫首页重读；首页读记录的 effect
  只看 `props.api`、`recentAttempt`、`recentRevision`，首页一直开着又不会重新挂载。所以从首页打开工具、聊完回来，「最近」那三行、
  哪一行给「接着聊」（`latestSessionIdsByWorkspace`）、工具那一行「打开 xx」挑的文件夹（`launchWorkspaces`）都停在打开前。
  三家按文件夹续接（`--continue`、`--resume latest`），点被挤下去那一行的「接着聊」接上的是刚聊的那条。0.2.9 的更新说明对客户说的是
  「打开工具……之后仍然立刻刷新」。
- `Home.tsx` 加一个 effect：窗口 `focus`，或 `visibilitychange` 且不是 hidden 时，`recentAttempt` 加一（和「重新加载」同一个开关）。
  读的还是 `toolsApi.recent()`：一分钟内又没作废就回同一个对象，不读盘、页面不变；打开过工具（已作废）或过了一分钟才真去读。
  重读时不先清空列表，不闪「正在读取最近记录」。`App.tsx` 不改：打开那一下终端里还没聊，那时叫 `refreshRecent()` 读回来的还是旧的，
  反倒把旧的缓存一分钟。顺带改正两处说「打开工具会让首页重读」「60 秒后自己会重读」的注释。不新写字。
- 测试：`testing/app-check.mjs` 补 2 条浏览器回归：一分钟内回到窗口不重读；打开工具、在同一文件夹聊了一条、回到窗口，刚聊的排第一，
  「接着聊」从 my-app 更早那条挪到它身上；换个文件夹聊完，窗口藏着时不读，再显示时工具那一行「打开」换成那个文件夹。夹具 `v2Test`
  加 `addRecentSession`（往记录最前面插一条）。去掉 `Home.tsx` 那个 effect，这 2 条都红。
- 第四十一批 A（10-5 拍板清单第 5 条）：首页「最近」卡的「接着聊」只看 `latestSessionIdsByWorkspace` 和归档，不看那家工具装没装；
  点下去走首页同一个「打开」（`App.tsx` 的 `prepareToolLaunch`），没装就抛「工具尚未安装，请先完成准备。」，「重试」还是这句。
  工具卸了记录还在（卸载确认框写着「历史记录会保留」）；只装 Codex 桌面端时，桌面端里聊的对话多半也在 Codex 的 threads 表里、
  记成 `provider: 'codex'`（推测，没在只装桌面端的真机上看过）。开机先摆上次结果那几秒 `resumeReadyBeforeScan` 要已装，按钮灰着，
  检测一跑完反倒亮了。
- `Home.tsx` 加顶层纯函数 `recentResumeOffered(tools, provider)`，卡片上那颗按钮多这一个条件：按工具 id 找（Codex 的记录看 Codex CLI，
  不看桌面端）；找不到（检测结果还没回来）照旧给、照旧灰着等；装了，或者检测失败（A4，点了照旧说检测失败的原因）给；其余不给。
  「打开文件夹」「查看」、那一行的字、哪条算最近那条都不变，不新写字。记录页同样的按钮不在这次范围里。
- 测试：`Home.test.tsx` 补 5 条单测（装了、没装、只装桌面端时的 Codex 记录、检测失败、检测还没回来）；`testing/app-check.mjs` 补 1 条
  浏览器回归：`desktopOnly` 下加一条 Codex 记录，三行都没有「接着聊」，「打开文件夹」「查看」还在；首页装上 Claude Code 以后它那条的
  按钮回来、点了照 #292 接着聊，Codex 那条照旧没有。
- 第四十一批 B 的余项：`MaintenancePage` 取消被拒时把原因放进 `cancelNotice`，和检测失败、操作失败共用页顶那条
  `ResultNotice`（`resource.error || operation.error || cancelNotice`）。以前只在下一次点「安装」或「取消」时才清，装好以后
  红条一直挂着、旁边弹的却是「安装完成，工具状态已更新」；没装上时 `operation.error` 先盖住它，等下一次别的操作清掉
  `operation.error`，那句「这一步已经不能取消了。」又冒出来。
- `install` 两条路（接了 `installTool` 的、没接时自己调 `api.installCli` / `api.installCodexDesktop` 的）收尾的 `finally` 里
  一起清掉 `cancelNotice`，和那里已经在清的取消标记、「正在停止」是同一件事：这次安装结束了。不新写字。
- 测试：`testing/app-check.mjs` 接着第四十批 C 那条加一条浏览器回归：用 `holdNextScan` 停在「安装完成，正在同步账号 Key 并
  刷新状态」那几秒点「取消」，页顶写「这一步已经不能取消了。」；放开后弹「安装完成，工具状态已更新」，这一行写「已安装」，
  页顶不再有红条。换回改前的代码这条红。
- 第四十一批 B（R-G3 的余项）：「安装卸载」页自己另读一份检测结果（`useResource(readMaintenanceStatus)`），去过的页只藏不卸。
  R-G3 只补了这一页装工具后叫 App 写 Key、重新检测（`onToolsChanged`）；卸载工具、装 Node.js / Python、「换成新版」Node.js 以后
  只重读本页，首页那份不动。反过来，首页的任务（#845 让这一页跟着画「安装中」「正在卸载」）一跑完，这一行回到本页那份旧结果。
- `BusinessActions` 多一个可选的 `onSystemChanged`，`App.tsx` 接成首页「重新检测」那一套（`refreshRecent()` + `toolbox.refresh(true)`，
  不含外部客户端）。`MaintenancePage` 卸载（含「要手动清理」那条）、装运行环境、换新版 Node.js 以后先叫它、再读本页：本页那次
  `scanSystem(false)` 接上 App 刚起的那一轮（`createScanCoalescer`），不另起一轮探测。
- 首页那份任务里本页有行的几个（`maintenanceRowJobKeys`：四个命令行工具、`codexDesktop`、`node`、`python`），上次在、这次没了
  （`maintenanceJobsFinished`）就重读本页。首页装好的那次在任务里已经重新检测过，主进程直接给那一轮；卸掉、装好运行环境时 App
  在任务结束后紧接着重新检测，本页接上那一轮（那一轮跑完之前这一行还是旧样子，首页那一行也一样，以前是一直不对）。没装上、取消了时
  首页一般不重新检测（先装过运行环境、换装的除外），本页这次读自己起一轮。首页那条安装要先装运行环境时，运行环境那段一结束本页就重读
  （Node.js 那一行不再写回「未安装」），也是自己起一轮。本页自己走 `installTool` 的那次安装会多读一次，接上的是刚做完的那一轮。
- 不新写字；回调缺省 = 旧行为（只刷新本页）。
- 测试：`pages-maintenance.test.ts` 加两个纯函数的用例；`testing/app-check.mjs` 加四条浏览器回归：「安装卸载」页卸掉 Claude Code 后
  首页把它放进「还可以装」、按钮是「安装」；只装桌面端时在「安装卸载」页装 Node.js，首页「运行环境」写 v24.0.0；先去过「安装卸载」页，
  首页装 Gemini CLI（停在半路时这一行写「安装中」），放行后这一行写「已安装」、2.0.0、按钮是「重新安装」；首页卸掉 Grok CLI 后这一行写
  「未安装」，「…」里没有「卸载工具」。换回改前的代码这四条都红。
- 第四十二批 A：去过的页面只藏不卸（`App.tsx` 的 `visitedPages`，第四批定的），检查、反馈、备份三页的 `useResource` 只在挂上时
  读一次，之后只有点页头那颗按钮才再读。错误框和引导的出口（「检查网络」「打开检查页」「查看日志」「去备份页」、帮助框的「去反馈页」）
  正是把人往这几页带：检查页右上还写「上次检查 3 小时前」，运行日志里没有刚出的错，改用失败、自动恢复也没成功时错误框叫人恢复的
  「改用之前的那一份」（`account-source-switch.ts` 在改用那一刻才备）不在备份列表里。
- `business-common.tsx` 加 `useReloadWhenShown(active, reload)`：`active` 从 false 变成 true 时叫一次 `reload`；第一次挂上不叫
  （`useResource` 自己在读），`active` 缺省什么都不做（旧行为）。用 layout effect：再显示的头一帧 `loading` 就已经为真。
- `BusinessActions` 多一个可选的 `active`，`App.tsx` 传 `page === id`，`pages-business.tsx` 给备份页转一下。检查页还在查时不再起
  一轮，「装没装 Codex」（那张 Codex 检查卡）一起重读；`useRowFocus` 的 ready 改成「有结果且不在查」：去过检查页以后再从设置
  「网络检查」「企业证书」点「去检查页」、开机提示点「去看看」，等新结果出来再翻到那一项，不先在旧结果上亮。「安装卸载」页这次不接。
- 不新写字。重读和点页头那颗按钮一样：有内容时先摆着、读回来再换（不闪「正在读取」），筛选、搜索词、滚动、展开的那一项照旧。
- 测试：`testing/app-check.mjs` 加四条浏览器回归：检查页换走再回来多查一轮、换上新结果，查着的时候换走再回来不多起一轮；去过检查页后
  从设置「网络检查」进来，新结果回来之前哪一项都不亮、回来以后网络那一项亮；反馈页回来时刚记下的错误在最上面；备份页回来时列表里有
  藏着时新留的那一份。去掉 `App.tsx` 传的 `active` 这四条都红；`useRowFocus` 改回只看有没有结果，或者 hook 改用 `useEffect`，
  「点名翻到那一项」那条红。
- 第四十二批 B：记录页（`SessionsPage`）的两份 `useResource`（列表本身按筛选、页码读 20 条；定「接着聊」挂在哪条上的不带筛选的
  最新 100 条）只在挂上时读，去过的页面只藏不卸，本页「接着聊」成功后也只作废首页那份「最近」。所以在终端里聊完回来，列表和
  `latestSessionIdsByWorkspace` 都是第一次进来时那份：三家按文件夹续接（`--continue`、`--resume latest`，#292），「接着聊」挂在
  被挤下去的那条上，点下去接上的是刚聊的那条。换个筛选时列表那份重读了、最新 100 条那份没读，新的那条出现却没有「接着聊」。
- `SessionsPage` 收 `active`（`pages-business.tsx` 转 `BusinessActions.active`，第四十二批 A 加的）：再显示时（`useReloadWhenShown`）、
  显示着窗口回到前面时（`window` 的 focus，或 `visibilitychange` 且不是 hidden，只在 `active` 时挂监听，同聊天页）两份列表一起重读，
  详情开着的话连详情。窗口那一下离上次读不到 30 秒就不读（同 `useNetworkLocation`）；本页「接着聊」真打开了（不是「先不打开」）
  就把这 30 秒清零，从终端回来头一次切回窗口一定重读。`active` 缺省 = 旧行为。
- 详情里的「正在读取对话…」只在还没有内容时摆：重读时正读着的对话先摆着、读回来再换，翻到的位置不丢。不新写字。
- 测试：`testing/app-check.mjs` 加三条浏览器回归：换走再回来两份各多读一次，刚聊的排第一、带「接着聊」，同文件夹更早那条不再带；
  停在记录页时半分钟内回到窗口不读、过了半分钟读、马上再回来不读、窗口藏着不读、换到别的页以后不读；在详情里点「接着聊」以后回到窗口
  马上重读，详情里多出刚问的那句，中间没闪「正在读取对话…」。去掉 `pages-business.tsx` 传的 `active` 这三条都红；详情改回只看
  `loading`，或者「接着聊」以后不清零，第三条红。
- 第四十三批 E：`proxy-bypass.ts` 改直连那两条日志（`proxy-bypass.direct`、`proxy-bypass.unreachable`）带上 `failureCode`，是改直连
  之前再看那一眼经系统代理撞上的错误码。代理软件没开（ERR_PROXY_CONNECTION_FAILED）和代理开着、回绝了连星芒的请求
  （ERR_TUNNEL_CONNECTION_FAILED）归类都是 proxy，以前日志里分不出。「重新检测」那条路没再看，记 null。再看那一眼（`lookAgain`）
  的结果改成带错误码的对象，两处内部调用把错误码交给 `tryBypass`；对外的 `tryBypass()` 签名不变，判断一处没改。
- 整个改了直连以后，每 5 分钟那一眼（`restoreSystemProxy`）还是 proxy 时以前什么都不记，现在记 `proxy-bypass.still-proxy`，带错误码。
  同一个错误码一次运行只记一条，换了错误码再记一条：代理软件后来起来了、却回绝连星芒的请求，要从日志里看出来的正是这种。没网、
  说不清怎么失败的照旧不记。
- `network-failure.ts` 新导出 `networkFailureCode`：只取一个代码词，Chromium 的 `ERR_…`，或者 cause 链上挂在 code 上的 errno
  （ECONNREFUSED、EAI_AGAIN）。message 里的大写英文不算，取不到回 null，不记原文和地址。纯函数，进渲染包也不碍事（I6）。
- 第四十四批 C：`runtime-log.ts` 的 `sanitizeValue` 记 Error 时把 `cause` 一起记下。`new Error(msg, { cause })` 设的 cause 不可枚举，
  `Object.entries` 取不到，被包了一层的报错（新建项目文件夹失败、Mac 上 Claude Code / Codex / Grok 没过签名核对、npm 安装恢复失败、
  卸载回滚不完整等）日志里只有外面那句中文。cause 照样逐字段打码，受同一个深度上限（套住自己时到上限记 `[TRUNCATED]`），反馈报告
  导出时照样换掉主目录（I13）。自己用 `this.cause =` 赋值的（`RealmAccountError`）本来就记得下，不重复记。没有 cause 的错误记出来
  和以前一字不差。
- 付款窗口（`payment-window.ts`）加载失败时，cause 换成只带错误码的 `{ code }`：Electron 的原错误把整个付款地址写在 message 和 url
  上，订单号、签名都在里面（二维码那页的地址里还有付款码图片），而付款这边的日志一向只记 origin。ipc 记失败时的 `networkFailure`
  照样认得出。其余挂了 cause 的地方都过了一遍，挂的是文件、命令、下载的原错误，没有带签名或订单号的网址。
- Mac 上点「打开」「接着聊」没打开（`system-service.ts` 的 darwin 分支）、点「安装 Git」苹果的安装窗口没弹出来（`macos-git-install.ts`），
  这两处以前连 cause 都没挂，现在挂上原错误，`open` / `xcode-select` 的退出码和标准错误随这次失败进运行日志。Mac 上没有另记
  `terminal.failed`。
- 第四十三批 D（拍板第 8 条）：开机按设置定下线路以后（`main.ts` 里 `createRelayEndpointRoutingSnapshot` 那一行）记一条
  `relay.route.active`，带 `active`（这次生效的）和 `selected`（设置里选过的），只有 `primary`、`direct` 这样的 id，没有地址。
  反馈报告「运行环境」段「网络位置」下面多一行「连接线路: 默认线路」或「连接线路: 备用直连」，写当前账号那个站这次运行实际走的
  线路（`feedback-environment.ts` 新导出 `resolveFeedbackRelayRoute`，读开机时定下的那份，设置里刚改、还没重启的不算），
  词是设置里线路选择框现成的选项名，不带地址和站点名。`FeedbackRuntimeInput` 加可选 `relayRoute`，缺省时这一行不出。
- 除了反馈报告多的那一行，只多记日志：界面上不加字，联网路线和各处判断都不变。没在真机上演过。
- 第四十三批 A：外部客户端检测（`system-service.ts` 的 `scanExternalClients`）先过 `followExternalClientRoutes`。规矩照 #872 给
  四个命令行工具定的，四条都满足才写：用户明确选过线路并已重启生效（`relayRouting.selection`）、配置地址是这个站登记过的另一条线路、
  归属对得上当前账号（`externalOwnership.matches` 按旧地址核；Claude Desktop 还要正在用的就是星芒标记的那一份，`inspectOwnedRoute`）、
  客户端装着且没开着。先在新线路上查一次模型清单，Key 认、型号还在才换（Claude Desktop 没写型号、由它自己取的那份，Key 认就换）。
  动文件之前再盘点一次客户端开没开：`external-client-runtime.ts` 的 `scan` 新增 `fresh`，不用缓存，正在跑的那轮等它跑完再盘点一轮，
  拉清单那几秒里被打开的看得到；Claude Desktop 那边放在管理策略查完之后（`followRoute` 的 `beforeCommit`），之后到写完都是同步的。
  盘点认不准（`detectionError`、没认出装着）也不写。
- 只换地址，不走保存配置那一条：保存会把 Claude Desktop 的型号收成一个、认证方式改回 bearer，WorkBuddy 也只更新选中的那一条。
  新加 `external-tool-config.ts` 的 `followExternalToolRoute`（WorkBuddy 把地址在旧线路、Key 是这一把的每一条的 `url` 换掉；OpenCode
  换星芒那段 provider 生效的 `baseURL` 和所选型号自己覆盖的那一处，改的是最后定义它的那个文件，不往别的文件加字段，npm 包和型号不碰）
  和 `claude-desktop-config.ts` 的 `followRoute`（用 jsonc-parser 只改 `inferenceGatewayBaseUrl`，缩进、字段顺序、换行符照原样）。
  两边都逐个字段改、文件末尾有没有换行照旧，写之前重读、再认一遍，对不上就一个字不写；原子写入、备份、快照比对照旧。一次改两个 OpenCode
  文件时，写前核对拿前一个文件这次写进去的内容比。换完不再另发连接自检：新线路上那次模型清单已经证明这把 Key 能用。
- 客户端开着就不写，状态带 `routePending`（`ExternalClientConnectionStatus` 新增可选字段），首页灰字在「运行中」后面接那句提示、
  不摆模型名。选过线路的人连读配置也排进 `externalConfigQueue`，两次检测同时跑时后一次读得到前一次换完的那份。没选过线路、历史账号、
  手改过 Key 或地址、别的账号写的、客户在 Claude Desktop 里复制出来的那份，都不写、不发请求；查清单那几秒里换了账号或站点也不写。
  换完归属记在新地址上，不会来回改；换完又回到旧那份（推测是客户端退出时写回）只记一次日志。地址换好了、归属没记上的，下次检测看到
  地址已经在当前线路上、归属还在旧线路，只补记归属。日志 `external-client.route.followed / deferred / failed / reverted / recorded`
  只记客户端和线路 id，不记地址和 Key。
- 第四十三批 C：`account-bootstrap.ts` 新增 `routeDeferredMessage`，换线路先不迁 Codex 时按 `inspectRunningTools` 的结果挑说法：
  Codex CLI 自己在跑或看不出来照旧；Mac 上只确定桌面端开着时说 Command + Q；其余只是桌面端开着时把工具名换成「Codex 桌面端」。
  什么时候先不迁一点没变。`keySyncFailureText` 让已经点了「Codex 桌面端」的原话不再被加上「Codex CLI：」。
- 测试：`external-client-service.test.ts` 加一组（换过去、换回来、开着不动且标 `routePending`、拉清单那几秒里被打开或被客户改了都不写、
  写之前那次盘点认不准不写、拉清单时换了账号或站点不写、客户在客户端里加的型号 / 认证方式 / 注释 / 别家条目原样留着、Claude Desktop
  没写型号也换、复制出来的 Claude Desktop 配置不认、没选过线路 / 别的账号 / 手改过 Key / 历史账号不动、拉不到模型或模型没了下次再试、
  写回旧配置不来回改、归属没记上下次补记）；`external-client-runtime.test.ts` 补 `fresh` 不用缓存、等正在跑的那轮；
  `external-tool-config.test.ts`、`claude-desktop-config.test.ts` 补只换地址的单测（两个 OpenCode 文件各改各的、Claude Desktop
  四格缩进 / CRLF / 没有末尾换行逐字节对得上、管理策略查完才最后盘点）；`external-model.test.ts`、`account-bootstrap.test.ts`、
  `key-sync-failure.test.ts` 补对应用例。
- 第四十三批 B（10-6 拍板清单第 9 条，照推荐做）：检查页「星芒 AI 网络」的「去处理」是新手引导梳理 9-25 第 2 条拿掉的，理由是
  「设置 → 网络」里没有能处理它的东西；#872 以后那一组最上面就是「星芒账号线路」。`diagnosticTarget` 对 `XINGMANG_NETWORK`
  只在 `details.reason` 是 `dns` / `refused` / `timeout`、`details.siteId` 就是登着的那个账号的站、这个站不止一条线路时回
  `settings`；新的 `diagnosticSection` 给出那一行（`relay-route-solov`），外壳现成的「是一行就打开它那一组再翻过去」接着做。
  代理软件那一项（`CLASH_VERGE_TUN`）照旧不给。不加字。
- 「登着」用新的 `signedInSiteId`（`account-context.ts`）：已登录的看会话；开机恢复没结束或联不上搁着的（登录还在）看正在恢复的
  那个账号，线路被切断时开机恢复多半也联不上；访客不给。开机恢复历史账号时会话的 `siteId` 和主进程查的站都还是默认那个，靠这一条
  才不会把历史账号带去星芒账号的线路。`HealthPage` 从 `BusinessPage` 收 `accountSession`，缺省按访客算（旧行为）。
- `diagnostics.ts`：这一项归类出网络原因时 details 多带 `siteId`（新界面的「查看详情」不摆这个键；旧回滚版照原样摆出详情里的
  每个键，本来就摆着地址）。`timeoutOutcome` 可以是函数，超时那一刻再定结论：这一次请求 8 秒还没回完话，从 `error`「检查超时」
  改成 `fail` + `networkFailureMessages.timeout`，带 `endpoint`、`reason: 'timeout'` 和 `siteId`；回完了话、卡在问加速开没开
  （要排在正开关加速的后面）的，网络是通的，照旧「检查超时」。连带一处现成行为：同一次检查里「安全证书」判成「电脑自己也不认」时，
  超时这种也改说「先看上面「星芒 AI 网络」那一项」（`reconcileCertificateTrustWithNetwork` 认的是 `fail`），和别的连不上一样。
- 测试：`diagnostics.test.ts` 三条（默认线路、备用直连、历史账号三种站失败时都带对 `siteId`；探测一直不回是 `fail` 加超时那句；
  回完了话、问加速状态卡住照旧「检查超时」）；`business.test.ts` 两条（三种原因翻到 `relay-route-solov`；别的原因、HTTP 状态、
  历史账号、访客、查的不是登着的这个站、不带站点都不给）；`account-context.test.ts` 一条；`testing/app-check.mjs` 三条浏览器回归
  （登着星芒账号点「去处理」到设置「网络」、那一行亮且选择框拿到焦点、选「备用直连」出「现在重开」；开机恢复中照样给；历史账号、
  开机恢复历史账号、没登录进首页的都不给），夹具 `restoring=solov-api` 恢复的是历史账号。
- 第四十三批 F：「外接工具」页（`ExtensionsPage`）的「自动安装 Python」装完只重读本页，首页那份检测结果没动：#871 给「安装卸载」页
  接的 `BusinessActions.onSystemChanged` 这一页没接上。`ExtensionsPage` 收可选的 `onSystemChanged`（缺省 = 只刷新本页），
  `pages-business.tsx` 给 MCP 页转 `actions.onSystemChanged`；装完先叫它、再读本页（同「安装卸载」页）。不新写字。
- 测试：夹具加 `pythonMissing` 和 `installPythonRuntime`（装完下一轮检测就有 3.13.7）；`testing/app-check.mjs` 加一条浏览器回归：
  首页 Python 写「可选 · 未装」，进「外接工具」添加 `python` 启动的连接、点「自动安装 Python」，关掉添加框回首页，那一行是 3.13.7、
  没有安装按钮。去掉 `pages-business.tsx` 传的 `onSystemChanged` 就红。
- 第四十四批 A：`external-client-runtime.ts` 的检测脚本用 `Get-ItemProperty` 整条读卸载信息，它会把一条记录的所有值都转换一遍，
  碰上别的安装程序写的 8 字节 REG_DWORD（NetBeans 的 NoModify 那种）整条抛「Specified cast is not valid」，以前就记「读不全」，
  三家没装的永远「检测失败」、一键安装也被拦。现在这一条退一步用 `$key.GetValue` 只读匹配要用的 DisplayName、InstallLocation、
  DisplayIcon、DisplayVersion，四个都是文字（或没有）才算读到；读不出来的（整条打不开、或坏的正是这四个之一）照旧记「读不全」、
  照旧不说没装。读不出来的记录名和 PowerShell 给的原因（最多 10 条）随结果交回，`onRegistryIncomplete` 接到运行日志
  `external-client.registry-incomplete`（原因按主目录脱敏，内容没变不重复记）。签名、路径那几道核对一行没动。
- 第四十四批 B：WorkBuddy 换腾讯官方安装包的条件，从只认 WinINet 那五个连不上的码，扩到 winget 自己的软件源坏了的
  0x8A15000F（源数据没有，多半是之前更新源没下下来）和 0x8A15003F（源数据对不上）。对过 winget-cli 源码：这两个只在打开源、
  读源里的清单时抛，安装程序还没动。安装程序已开始、客户取消、超时照旧不换；OpenCode 那句报错不变。进度用现成的那句，不新写字。
- 第四十四批 D：Mac 上 spctl 退出码 3（Gatekeeper 拒绝）、codesign 退出码 1 / 3（核对没过、不满足钉住的要求）时，首页那一行改说
  Windows 签名不对时那句现成的话（只按退出码判，不看输出）；超时和别的退出码照旧原样。哪个应用包、哪条命令、退出码、
  标准错误（截 500 字）经 `onMacVerificationFailed` 进运行日志 `external-client.mac-verification-failed`，路径按主目录脱敏，
  同一个应用包原因没变不重复记。
- 测试：`external-client-runtime.test.ts` 加读不出的记录进日志（去重、换内容再记、读全以后忘掉、最多 10 条且截长）、
  两个源坏了的码换腾讯官方（安装程序已开始不换、OpenCode 照旧报错）、Mac 上 spctl 3 和 codesign 1 / 3 换那句话并只记一次
  （放行以后再拒会再记、打开也被同一句拦）、超时和别的退出码照旧原样但照样记日志。`e2e/windows-powershell-probes-smoke.mjs`
  （Windows 打包那一步真跑 PowerShell）加两条模拟坏值的（我们不用的值坏了读得出、我们用的值也坏了照旧那句），再在本机
  当前用户下用 `reg import` 建一条带 8 字节 REG_DWORD 的真卸载信息，先证实 `Get-ItemProperty` 确实读不了它，再跑真检测脚本
  确认这条读到了、没进读不出名单，最后删掉。`system-service.external-client-log.test.ts` 把这两行日志写进一份真的运行日志
  再读回来：记录名的字段不叫 `key`（运行日志把正好叫 key 的字段当凭据打码），读回来还在，主目录已脱敏。
- 新增 `cli-config-health.ts`：Claude Code 2.1.277、Gemini CLI 0.60.0、Codex 0.159.0-alpha.12.1（桌面端 26.930 自带）各自读不读得了
  自己的 JSON 文件，每条都在沙箱里拿真工具试过：Claude Code 弹「Settings Error」整份不用的写法，Gemini CLI 退出码 52 的写法，
  Codex 不报错、当成没登录的 `auth.json`。本软件自己的读法更宽（去掉 BOM、坏字节换成 U+FFFD），读得出 Key 不代表工具读得了。
- `config-files.ts`：`codexConfigBroken` 改名 `configBroken`，Claude Code、Gemini CLI 的 `settings.json` 也判（Grok CLI 不判）；新增
  `codexAuthBroken`。reset 遇到读不懂的 `auth.json` 先备份再照常重建，merge 照旧报错、指去重置。新增 `FileRemovePlan`：同一次两阶段
  提交里整份拿掉一个文件，提交时先挪到临时名，后面的文件提交失败照样从 `.bak` 放回。`createCodexOfficialAuthPlans` 在没有可换回的
  ChatGPT 登录、文件里只剩 `tokens` `last_refresh` 或什么都不剩时拿掉 `auth.json`，和 Codex 自己退出登录一样：实测 Codex 把 `{}`
  当成 ChatGPT 登录，`codex exec` 报 plan type is required for chatgpt authentication。`switchProviderToOfficialAccount` 遇到读不懂的
  文件，merge 改说 `describeBrokenConfig` 那句，不再说「无需切换」；Claude Code、Gemini CLI、Grok CLI 切回官方读不懂时也用这句。
- `ipc.ts`：一键切换（`config:switch-account-source`）改用当前账号时，文件读不懂就用 reset，切换开头已经在「备份」页留过一份
  （第三十批跟进项「来源未确认时点不到重置」）。
- 首页：`brokenConfigOf` 分出四种坏文件（Codex 的 `config.toml` `auth.json`，Claude Code、Gemini CLI 的 `settings.json`），各一句小字；
  坏了时模型那一格不写「官方账号」。`brokenConfigRepairTarget` 按坏的是哪份决定「修好它」走哪边：Codex 登录 ChatGPT、或只坏了
  `auth.json` 且 `config.toml` 没有别的服务地址、Gemini CLI 读得出 Google 登录的走官方重置，其余按当前账号。配置窗口遇到坏文件、
  官方账号只是推出来的，默认选「使用星芒账号」，展开「高级」重置就和「修好它」一样。
- 测试：`cli-config-health.test.ts` 钉住三个工具读得了和读不了的写法；`config-files.test.ts` 加首页标记、坏 `auth.json` 的两种重置、
  切回官方不留空文件、留着别的内容就不拿掉、拿掉后回滚放回、Claude Code 与 Gemini CLI 切回官方读不懂时指去重置；`ipc.test.ts`
  加一键切换遇到坏文件走 reset；`Home.test.tsx`、`model.test.ts` 加三种新坏法、优先级与修的方向；`app-check.mjs` 两条浏览器回归
  （夹具 `?claudeBroken`、`?codexAuthBroken`）。
- Windows 的 renderer-v2 夹具浏览器分片从一片拆成两片（`renderer-v2-browser-1` / `-2`，各 18 分钟上限不变）。
  原来那片正常机器要跑 11～14 分钟，碰上慢机器（#873 三轮都是，同样的用例总耗时是 #871 的 1.55 倍上下）
  就在 18 分钟处被掐，用例一条没红。`app-check.mjs` 一个文件占这片三分之二的时间、每天还多二十条上下，
  按文件拆总有一片背着它整个，所以新加 `e2e/shard-tests.mjs`：设了 `XINGMANG_TEST_SHARD=第几份/共几份`
  就按声明顺序轮流登记，各片只登记自己那份，合起来每条正好跑一次；没设（本地、Linux）照旧全跑。
  其余夹具文件按实测耗时分到两片。Linux 的 `linux-renderer-v2-browser` 仍整份跑 `test:v2:browser:fixture`。
- 原来「app-check 必须排最后、靠前面的文件暖 Vite 依赖缓存」那条规矩撤掉：`node --test` 会把文件按路径排序再跑，
  app-check 从来不是最后一个；auth、chat 两份用另一套 Vite 配置，换配置时 Vite 会把缓存整个删掉重来；冷启动时
  Vite 扫遍仓库所有 html 入口，第一页加载前依赖就齐了（本地删光缓存单跑 app-check，290 条全过，中途没有重新打包）；
  当初那次 90 秒超时（run 35420361508）是第 59 条丢导航，现在 `openFixturePage` 会重新导航。
  `ci-workflow-config.test.cjs` 改为钉住：每一片都派发、份数连续、发牌的文件每片都跑且只从 `node:test` 拿钩子、
  其余文件只在一片、合起来等于 `test:v2:browser:fixture`，并单测发牌本身不重不漏、没设片号时 `test` 就是
  `node:test` 原来那个（本地和 Linux 报错位置仍指向用例自己那一行）。
- `electron/cli-verified-versions.ts` 把 Claude Code 的 `recommended` 从 2.1.277 抬到 2.1.291（npm latest，取代 #460 的 2.1.281）；2.1.278~2.1.291 上游 changelog 没有新的第三方端点回归，沙箱本地假接口对照 2.1.277 的请求体与工具列表一致，依据写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- 2.1.285 起接自定义 `ANTHROPIC_BASE_URL` 时上下文按 1M 算（以前 200K），沙箱 `/context` 实测确认。中转支持 1M 上下文（2026-10-06 yoyo 确认），配置不压；渠道只收 200K 时的退路是 `env` 写 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`。
- `electron/config-files.ts`：合并写入与开机补默认（`fillRelayTemplateDefaults`）在 Claude 的 `permissions.defaultMode` 缺省时补 `bypassPermissions`、`skipDangerousModePermissionPrompt` 缺省时补 `true`，写过的一律不动（新客户模板一直这么写）。上游 2.1.283 起接第三方中转又没写 `defaultMode` 的会话进自动模式，#858 把推荐版本抬到 2.1.291 后老客户会碰到。2026-10-06 yoyo 回「补」。
- `relayTemplateRevision` 1 → 2，已记过版本 1 的老客户开机补一次。
- 每周巡检（2026-10-05，合并前 10-06 追到 npm latest）：`electron/cli-verified-versions.ts` 的 Codex 推荐版本 `0.156.1` → `0.160.1`，Grok `1.0.44` → `1.0.46`，
  `verifiedSites` 仍为空（探测 secret 没配，没在中转上实测）。Codex 依据是 `rust-v0.157.0` 到 `rust-v0.160.1` 的 release note，没有对自定义
  provider 的回归；0.160.1 的型号名单与随包的 `rust-v0.160.0` 逐字相同，名单不用换。Grok 没有可读的变更记录，在本地假接口上把出图地址、型号名单、标题型号、
  钩子四项重核了一遍。依据与实测细节写在 `docs/CLI-VERIFIED-VERSIONS.md`「名单今天覆盖到哪」。
- 同一份文档的「谁来跑：每周巡检」改成四家版：例程已改名「四家 CLI 新版每周巡检」，每家读哪里的变更记录、已有 PR 在抬时怎么办。
- 同一次巡检把 Claude Code（2.1.291）与 Gemini CLI（0.62.0）也一并抬了，取代 #460、#462，各自的分片见 `claude-code-2.1.291.md`、`gemini-cli-0.62.0.md`。
- `electron/codex-desktop-cdp.ts`：中文注入前核对调试端口归属，从 PowerShell 的 `Get-NetTCPConnection` 换成
  System32 下的 `netstat.exe -a -n -o`（`windowsSystemExecutable` 给绝对路径，`trustedCommandEnvironment`，
  `execFile` argv 数组，单次 10 秒限时不变，输出上限 8 MB）。两者读的是同一张 TCP 归属表。旧写法是 Windows 打包
  检查里唯一走 NetTCPIP 模块和 WMI 网络连接提供程序的探针：2026-10-03 的 44 轮 windows-package 里中位 1.1 秒，
  6 轮超过 3 秒，#796（10.4 秒）、#816（10.0 秒）两轮超过上限被杀，这 44 轮里同样走 CIM 查进程的三项最慢 1.3 秒
  （10-1 #745 也是这一项）。具体卡在系统哪一层，CI 日志看不出来。
- 解析照旧「查不清就不放行」：只认本地端口相同、且远端是 `0.0.0.0:0` / `[::]:0` 或状态是 `LISTENING` 的 TCP 行
  （德文等系统的状态列会翻译，地址不会）；IPv4、IPv6 和任意本地地址上的监听者都算，只要有一个不是 Codex 就判
  被占用；监听行读不出 PID（缺列、PID 为 0）整次查询算失败，不当成没有监听。`TIME_WAIT`（PID 0）、已建立连接、
  别的进程从同一端口号连出去的行都不算监听。旧写法会把 PID 0 的监听行直接丢掉，新写法更严。
- 不靠表头和英文状态词：表头不读，认监听看远端地址（`LISTENING` 只是多一种认法），PID 取最后一列。中文版 Windows
  的表头按控制台代码页（GBK）写出，经 `execFile` 按 UTF-8 解码后是一串替换字符；德文版连状态也翻译（`ABHÖREN`，
  850 代码页）。单测按这两种系统写出的原始字节、再照 `execFile` 的方式解码来造样本（照格式手写，不是从真机抓的），
  并让中文、德文两张表走完整个换中文流程。一行 TCP 都认不出来的输出算这次没查到（Windows 自己总在 135 等端口上
  监听，不会是空表），连续三次就放弃，不再当成「没人监听」白等满 20 秒。
- `e2e/windows-powershell-probes-smoke.mjs`：这项不再对着没人监听的 1 号端口查，改成真开端口：本进程监听并先
  关掉一条连接留下 `TIME_WAIT`，另一个进程从 127.0.0.2 用同一端口号连进来（不该算），第三个进程在 `[::1]` 上
  监听同一端口（该算），每次查询都按 App 给的 10 秒卡。runner 上建不出 127.0.0.2 连接或 IPv6 监听时只打印、跳过
  那一步。`powershell-module-imports` 的测试清单和 cmdlet 表去掉这条脚本与 `Get-NetTCPConnection`。
- Codex 桌面端的中文要 OpenAI 下发的 `enable_i18n` 开关，Codex 每次冷启动头几秒才拉；星芒只在自己「打开」的那一下帮它拿到
  （两个系统都先连加速，Windows 选过「显示中文」的再走本机调试端口补丁，`codex-desktop-cdp.ts`），开机后从开始菜单、任务栏、
  程序坞直接打开拿不到，`config.toml` 的 `localeOverride = "zh-CN"` 单独不管用，界面是英文。以前界面上没说过这一点，客户会以为
  汉化掉了。上游同一现象见 openai/codex#50377（26.930.2377.0，启动时开关没拿到，简体中文设置还在、界面成了英文）。
- 只改文字，三处：`App.tsx` 第一次打开 Codex 的「要让 Codex 的界面显示中文吗？」询问框第一段末尾加一句；`ConfigDialog.tsx` 的
  「界面语言与文件夹权限」Windows 第一段、`locale-status.ts` 的 `macLocaleNote`（Mac 那段）各在开头加一句；`registry/tutorials.ts`
  「出问题怎么办」里「能打开，但还是英文？」先说从哪打开，再说「检查中文界面」。不动启动逻辑、加速和本机通道。
- 测试：`locale-status.test.ts` 钉住 `macLocaleNote` 全文；`registry/tutorials.test.ts` 钉住那条问答提到从星芒和托盘「已安装的工具」
  打开；`testing/app-check.mjs` 的两条既有浏览器用例补断言：询问框正文带新加的那句，Windows 配置里语言那段第一段是新文字。
- 新增 `codex-config-syntax.ts` 的 `isCodexConfigBroken`：只在确定 Codex 也会拒绝时才算坏，即不是 UTF-8、有 TOML 不许的控制字符或孤立回车，
  或者 `@iarna/toml` 报的是键或表重复、写到一半、不认识的字符、`\u` 写错、`\e` `\x` 以外的未知转义。`@iarna/toml` 是 TOML 0.5，Codex 读 TOML 1.1：
  类型混合的数组、跨行或带注释的内联表、`\e` `\x`、不带秒的时间这些 Codex 认、`@iarna/toml` 不认，一律不报。拿桌面端 26.930 自带的
  Codex 0.159.0-alpha.12.1 逐条比对过。
- `config-files.ts`：`inspectProviderConfig` 给 Codex 加 `codexConfigBroken`，读原始字节（`bounded-file.ts` 拆出 `readBoundedFileSync`，
  解码会把坏字节悄悄换成 U+FFFD）。`createCodexOfficialConfigPlans` 在 reset 时容忍读不懂的旧文件，先备份再整份换掉，和中转那边的 reset 一样；
  merge 照旧报错。原来登录 ChatGPT 的客户在配置里点「重置为初始状态」也会报读不懂。`switchProviderToOfficialAccount` 在 reset、
  文件坏了、`auth_mode` 是 chatgpt 时按官方处理：登录换来的 Key 常和令牌一起留在 `auth.json` 里，原来会被当成第三方拒掉；
  读得懂的第三方配置照旧拒绝。
- `ipc.ts`：重置前在「备份」页留一份（全面检测 Q18）原来只做在 `config:save` 上，选的账号 Key、自动准备的 Key、官方账号这三条重置的路
  只留配置旁边会被挤掉的 `.bak`。抽成 `backupBeforeReset`，四个入口都走，留不下就不重置；首页「修好它」走的正是后两条。
- 首页（`Home.tsx`）新状态 `configBroken`，排在「配置暂未读到」之后、所有按来源的判断之前，开机先画上次结果时不下结论。「修好它」
  （`App.tsx` 的 `repairBrokenToolConfig`）就是配置「高级」里的「重置为初始状态」：登录 ChatGPT 的走官方重置，其余按当前账号
  （`configureManaged(…, 'reset')`，没登录先去登录），成功后清掉「自己填写密钥」的本机标记。任务按工具家族登记成 `repair-config:codex`，
  两行 Codex 共用一份配置，修的时候两行都是「修复中」，不会叠两次重置；`launch-notice.ts` 也不拿它说「正在等 … 安装完」。
  三处文字照 yoyo 2026-10-06 回「改」的原话，悬停提示与成功提示用现成的。
- 测试：`codex-config-syntax.test.ts` 钉住两边都拒绝与只有 Codex 认的写法；`config-files.test.ts` 加首页标记、ChatGPT 登录下重置坏文件
  （含 `auth.json` 里还留着 Key 的）、读得懂的第三方照旧拒绝；`launch-notice.test.ts` 加一条；
  `bounded-file.test.ts` 加原始字节；`ipc.test.ts` 三条：官方账号、自动准备的 Key、选的 Key 重置前都先备份，备份不成就不写；
  `Home.test.tsx` 与 `model.test.ts` 加两行状态、按钮、优先级、两行一起忙与缓存期不下结论；`app-check.mjs` 两条浏览器回归（夹具 `?codexBroken`）：
  从桌面端那一行点「修好它」走当前账号的重置，ChatGPT 登录的走官方重置。
- 新界面 `features/tools/model.ts` 加 `officialAccountSubtitle`，首页 Codex 两行在官方来源时把主进程已经读出的 `officialAccountPlan` / `officialAccountRenewsAt` 接在「官方账号」后面；续期日已过或读不到就不写。`ui/core.tsx` 的 `ToolRow` 加可选 `modelHint`，悬停时在整行文字下面补一行具体日期。v0.1.31 旧界面的「套餐 / 续期」标签在 #117 重做新界面时收进了「官方账户额度」弹窗，这次照设计稿 G05 放回卡片上，弹窗不动。
- 新界面配置窗口（`src/renderer-v2/features/tools/ConfigDialog.tsx`）打开、或在窗口里换到另一个工具时，满足「已登录 + 来源是星芒账号 +
  选的是保持当前密钥 + 工具里有 Key 且属于当前站」就调一次 `listConfiguredModels`（Key 只在主进程里用，不跨 IPC，I3），把结果放进
  下拉框。不调 `change()`：选中的模型不动，草稿不算改过，关窗口不问放弃；不设 `busy`：窗口不锁，读的时候照样能改。转圈沿用
  「检测模型」按钮的 `loading`。失败不写 `error`，「检测模型」照旧报「模型检测未完成」或主进程给的原因。
- 竞态：和手动检测共用 `request` 编号，换工具、换来源、换 Key、填密钥都会作废在途的那次（T6）；转圈按编号清，晚到的旧结果关不掉
  新一次的转圈。开发模式下 StrictMode 会连发两遍，正式包只发一次；主进程按 Key 缓存模型列表两分钟。
- 没登录不读：这时窗口里账号相关的选项都是灰的；`e2e/macos-visual-qa.mjs` 用占位 Key、不登录打开 Codex 配置，读了就会请求正式服务。
  手动填写、官方账号、来源未确认（别的站或别的账号的 Key）、自动准备都不读。
- 测试：`app-check.mjs` 新加打开即读、读失败不出红字、读的时候窗口能用且换工具丢掉旧结果、三种不该读的情形；夹具加
  `holdConfiguredModels` / `releaseConfiguredModels`。「自动准备」那条用例改成只看改选之后不再读。
- `electron/system-service.ts` 的 `saveConfig` 写文件前先把来源记成 `manual`（防写到一半崩掉），以前写失败后不改回去，下一次保存
  把 `manual` 当成原来的来源，`account` 就永久变成了 `manual`，开机同步 Key、换账号、换连接线路这些自动写入都被「来源未经确认」
  挡住（症状和已知43 一样，但还在不断产生新的）。现在写之前用新的 `ToolConfigOwnershipStore.remember` 原样记下那条记录
  （没有记录也算），写失败、账号没换、配置也一点没动时原样放回；动过了、账号中途换了、或者记录本来就读不出来，都照旧留着 `manual`。
- 「一点没动」抽成顶层纯函数 `sameNativeConfigSnapshot`（身份、修改时间、型号都和保存前一样），「检测模型期间配置变了」也改用它。
  回滚会照原样写回内容但修改时间会变，按「写到一半」算，不放回。
- 测试：`tool-config-ownership.test.ts` 新加同 Key 保存失败后重试仍跟账号、自动换 Key 失败后下一次照常换、手动来源和没有记录的
  配置失败后原样不变、`remember` 的放回与读不出时放弃，以及 `sameNativeConfigSnapshot` 的口径。
- 接手 #864（Codex 提的两笔提交原样带上）：引入每个账号服务的固定入口注册表与线路 ID（`relay-sites.ts`）；运行态使用启动快照
  （`createRelayEndpointRoutingSnapshot`），持久偏好在重启后统一生效。账号凭据的 canonical realm 与 vault 身份保持不变，不接受任意
  子域名或自定义凭据目的地址。
- 为经实际客户电脑验证的 HTTPS IP 入口保留证书校验，账号与四个 provider 使用同一选定 origin；加速内核从注册表派生精确 IP-CIDR
  直连规则。
- 保留原有配置所有权、原子写入、账号切换和未保存内容保护；更新备用传输（`update-feed-route.ts`）仅适用于精确匹配默认正式更新源的
  Windows 安装包，保留 SHA-512、签名、撤回状态及自定义更新源行为。
- 启动恢复区分「同一后端」与「实际地址已更新」：仅迁移当前账号拥有、且用户明确选择并已重启生效的线路；写前检查工具运行状态并复核
  实际地址。主进程在异步准备结束后再次检查运行状态，避免启动与写入竞态。
- 「账号连接还在同步就先别打开」那道关放在 #866 拆出来的 `prepareToolLaunch` 里，首页「打开」「换目录」「接着聊」、托盘、快捷键和
  记录页「接着聊」都先过它；`launch()` 排队真打开前再查一次。检测跑完以后只认这一轮同步真在跑（新的
  `accountKeyChangeInProgress`）：#864 原来沿用 `accountKeyChangePending`，同步还没开始也算「说不准」，切换账号（故意不再跑开机
  那一轮）和开机恢复登录一直联不上时，账号来源的工具会一直打不开、只能重开星芒。
- 画图技能同步从主进程当前站点配置取得生效 origin；MCP 生产目的地址改为固定 HTTPS origin 全等校验，包含登记的备用入口并拒绝其他
  主机和端口。
- 欢迎页和首次向导冒烟测试在应用入口前模拟公共账号状态，并阻断其余网络出口，避免登录框探测访问生产账号接口；保留原有界面断言。
- #864 里把版本号改成 0.2.16、把分片汇总进 `CHANGELOG.md` 和 `release-notes.md` 的部分没带，留给定版时做。
- 腾讯云 COS 同步改成传得完、断了能接着传（0.2.15 同步在 60 分钟的 publish 作业里超时、补传又被一次 HEAD 超时打断）：`publish-release` 的 COS 同步从 publish 作业末尾拆成单独的 `cos-sync` 作业（挂 `cos-sync` 环境、不多一次批准、限 330 分钟，和 `sync-published-manager-cos` 共用 `cos-manager-publish` 并发组，后者也从 `update-feed` 挪过来、放宽到 330 分钟），失败后单独重跑这个作业（Re-run this job）、不用再批，已传好的文件跳过上传。publish 多一个 `outputs.linux`，记下这次实际发没发 Linux，`cos-sync` 照它决定同不同步 Linux，不在几天后重跑时再看开关。
- 新增 `scripts/cos-transfer-retry.cjs`：读取（HEAD、完整回读、读 latest）最多 12 次、写入最多 10 次，指数退避加一半随机抖动，放弃前读取至少等约 3.5 分钟、写入至少约 5 分钟；只重试超时、连接断开、429/5xx 和分块请求上 COS 诊断出的慢网络 400。Init 和分块按这些条件重试，Complete 与可覆盖的 latest 只在连接根本没建立时重发，不可变单次 PUT 只在回读 404 后重发；分块等待中其它分块失败会立刻被叫醒停下。星芒正式发布与手动导入单个安装包的分块期限放宽到 120 分钟。
- 新增仓库变量 `XINGMANG_COS_ACCELERATE`（默认关）：存储桶开了全球加速后设 `true`，四条 COS 工作流的上传改走 `<桶名>.cos.accelerate.myqcloud.com`，回读核对和客户下载仍用上海地址。`[manager-sync]` 日志新增 `retry` 行和传安装包时每 30 秒一行的 `stage-wait`。见 `docs/COS-SYNC.md`「网络不稳时」。
- 2026-10-06 新出的三条依赖公告让 quality 的 `audit`（`npm run audit:ci`）在 main 179cdfe 上报红，所有 PR 都卡在 quality-gate。
  锁文件把 source-map-js 从 1.2.1 升到 1.2.2（GHSA-68fv-2mgg-jv7q，vite → postcss 带进来）、joi 从 18.2.8 升到 18.2.9
  （GHSA-wr44-6hxh-3jwq，wait-on 带进来），两处都在原来声明的范围内，`package.json` 不动。
- katex 从 0.16.47 升到 0.19.0（GHSA-238p-pmpm-9mq7，修在 0.18.2）。它是 AI 聊天显示公式用的（`features/chat/math.ts`），
  会打进渲染层。npm audit 连带报的另外 5 条（@lobehub/ui、mermaid、rehype-katex、remark-math、micromark-extension-math）
  都是 @lobehub/icons 的 peer 依赖 @lobehub/ui 带进来的，各自最新版仍只认 katex 0.16.x（mermaid 12.1.0 要 `^0.16.47`、
  micromark-extension-math 3.1.0 要 `^0.16.0`），升不出修好的版本，所以 `overrides` 加 `"katex": "$katex"`，整棵树只留一份 0.19.0。
  这几个包本仓源码一个也没 import（只从 @lobehub/icons 引单个图标组件），渲染层打包产物里没有 mermaid。没加白名单，
  `scripts/audit-development-dependencies.cjs` 没改。
- katex 0.17～0.19 的不兼容改动（内部 `__defineFunction`、HTML 输出的 CSS 类名加前缀、缺字形改走 `strict`）碰不到这里的用法：
  只要 MathML、`strict: 'ignore'`、样式只认 `.chat-math math`。46 条常见公式（含中文、emoji、矩阵、对齐、`\href`、`\htmlClass`）
  两版输出对比，43 条逐字节相同，另外 3 条是新版多认得 `\reflectbox`、`\mapsfrom` 和 gather 环境末行不再丢。
- katex 0.19.0 自带的 commander 从 8 升到 15，要求 Node 22.12 以上；只有 katex 的命令行用它，CI 用的 Node 22 满足。
- 直连适配第二步（yoyo 10-6 回「改」，方案 `/mnt/project-files/直连线路适配/方案.md` 第三节第 2 步，界面文字照第六节原话）。
- 线路表：历史账号加直连 `https://api-direct.solov.cc`。设置里存的是偏好 `auto` / `direct` / `primary`，什么都没存 = `auto`，以前存的
  `primary` / `direct` 照旧是写死那一条（`relay-sites.ts` 的 `resolveRelayRoutePreferences`、`app-settings.ts`）。设置快照多带
  `relayRouteLines`（每个站这会儿的线路、定下来没有），只读不存。
- `relay-route-controller.ts` 定「自动」走哪条：开机先用上次的结论（`relay-route-lines.json`，只存线路 id），没有就先走默认线路、不算
  定下来；后台查 `/api/status`（历史账号查 `/api/v1/settings/public`），200 加 JSON 才算通。直连通用直连；直连不通、默认线路通就退回；
  两条都不通不改，5 分钟后再查。退回以后每 5 分钟查一次直连，连续两次通才切回。请求报上来的直连失败 30 秒里只查一次。
- `relay-line-fetch.ts`：星芒自己的请求（账号、余额、AI 工作区）按这会儿的线路换地址。「自动」走直连时，连不上一类的失败（断网、
  解析不出、TLS、证书日期、拒绝连接、超时、代理回绝了直连这个地址 `ERR_TUNNEL_CONNECTION_FAILED`、被跳转到别处）、直连回的网页
  形式的 502/503/504、别的网页或 opaqueredirect（拦截页、上网认证，报 `intercepted`），以及白名单挡下的网页形式 404，当场改走默认
  线路重发一次；会改动数据的请求只在肯定没送到服务器时才重发（代理回绝算没送到，被跳转、回了网页不算），带流式正文的不重发。代理
  软件本身没开（`ERR_PROXY_CONNECTION_FAILED`）换哪条都一样，照旧归 `proxy-bypass.ts`。回了话以后正文读到一半断了（AI 回复写到
  一半）用 `response-body-watch.ts` 报给控制器查一次直连，这一次不重发；调用方自己中止的不报（账号请求除外）。只读请求 3 秒没回话
  就报给控制器查一次直连，线路换了就中止、改走默认线路重发。写进工具配置前查模型、工具自检用 `createRelayObservedFetch`：不换地址、
  不重发，只报直连上的失败（同上，含拦截页和正文断了）。
- `proxy-bypass.ts`：同一个站的默认线路和直连算一个站点（新依赖 `siteProbeUrls`，main.ts 用 `relaySiteStatusProbeUrls` 接）。分去
  站点直连会话、交还、交还后重发都按这个站全部入口认，再看、看代理软件还在不在探的是这个站这会儿用的那个入口。以前只认分过去时
  那个入口的 origin，「自动」中途换了线路，换过去的请求又被送回不转发星芒的代理。
- 工具配置等线路定下来（写死的，或者「自动」查出结论）才迁。「自动」换了线路主进程发 `onRelayRouteChanged`：界面重读设置、外部
  客户端重新检测，四个命令行工具和 Codex 桌面端照 #872 的规矩迁，开着的先不改；退回默认线路、还有工具开着时首页说一句总的、
  横幅里不再逐个工具说，点「重新检测」再迁一次。
- 来源标记（「就用现在这份」）同一个站的两条线路合用一份，按默认线路的地址存；以前按直连地址或 IP 存的照样认，下次写入时挪过去。
- 检查页「星芒 AI 网络」写明用的是哪条线路；「自动」走直连没查通时（直连那一次最多等 4 秒；代理回绝、回网页、回了 200 却不是
  JSON 也算）当场查默认线路，查通算能连上并报给控制器。历史账号连不上时「去处理」也给了，翻到「历史账号线路」那一行（以前那一行
  是灰的，不给）。反馈报告「连接线路」一行按第六节第 5 条。Windows 正式版每次检查更新前按星芒账号这会儿的线路选更新地址，直连
  那份没查通（连不上、网关错误、白名单 404）当场换回包里那份再查一次。
- 没做：下载更新到一半直连断了不当场换线路（下次检查会换）；工具里正在进行的对话换不了线路（方案第四节）；Mac 更新照旧不走直连。
  系统代理不转发星芒的电脑（#796 那类）还没分去直连会话、开机时上次的结论又是直连，这时直连那边正好停了：经代理两条都查不通，
  照「两条都不通不改」接着用直连，要等直连恢复。没在真机上演过。
- 直连适配第一步：星芒账号的「备用直连」从服务端的临时 IP 测试入口 `https://38.147.105.28:8443` 换成 `https://xm-direct.solov.cc`
  （公共签发的证书，照常校验；服务器 IP 只在服务端的 DNS 里，换 IP 不用发版）。IP 退成别名（`relay-sites.ts` 的 `aliases`），只用来认
  按它写过的旧配置；新写的配置、账号请求、更新检查、画图技能都用域名。服务端在这一版发出以后关掉 IP 入口。
- 迁移照 #872 的规矩：选过线路的，四个命令行工具和 Codex 桌面端开机时从 IP 改到域名（工具开着的先不改）。Claude Desktop、WorkBuddy、
  OpenCode 的换线路（第四十三批 A）也认别名：新加 `relaySiteProviderBaseUrlVariants` 列出每条线路连同别名的地址，
  `externalClientRouteCredential` 按它找星芒那一份，归属记在 IP 上的照样换到域名，只换地址。没选过线路、自己手写成 IP 的，认得出
  是星芒直连，但照「只有明确选过线路才迁」不替他改。
- 选过备用直连的客户点过的「就用现在这份」（新界面的来源标记，按地址存在本机）以前按 IP 存：换成域名以后照样认，下次写入时挪到
  域名那一份（`relayEndpointAliasOrigins` 只认那条线路自己的别名）。
- Windows 正式版走直连时的更新源换成 `https://xm-direct.solov.cc/xingmang-manager/`；Mac 照旧不走直连。
- 加速内核的直连规则只带各条线路自己的地址、不带别名，IP 测试入口不再进 IP-CIDR 规则；画图技能（`mcp-server.mjs`）的放行名单
  去掉 IP。测试里 IP 换成别名的那一边，补了外部客户端和命令行工具从 IP 迁到域名、加速规则不带 IP 的用例。没在真机上演过。
- `cli-verified-versions.ts` 的 Gemini 推荐版本 0.60.0 → 0.62.0（取代 #462 的 0.61.0）。0.61.0 起上游 #29252 不再把 `*-flash` 型号改发成 `gemini-3.5-flash`；`geminiRelayHelperModels` 补上 0.61.0 新增的 `gemini-3.8-flash` / `gemini-3.5-flash-lite`。0.61.0 新加的出网改名会把恰好叫 `gemini-3.5-flash` / `gemini-3-flash` / `gemini-3.1-flash-lite` 的型号改发。0.62.0 的 `DEFAULT_MODEL_CONFIGS` 与出网改名函数和 0.61.0 逐字相同。沙箱实测与依据见 `docs/CLI-VERIFIED-VERSIONS.md`。
- `src/renderer-v2/features/tools/Home.tsx`：命令行工具行（Codex 桌面端那一行同一颗按钮）的取消按钮在 `cancelling` 时由「取消中」
  改成「正在停止」，和同页客户端行（#829）、安装卸载页一致，也就是 `ui-spec/06-copy-guide.md` 的「取消时写“正在停止”」。
  只动这一个词，`Home.test.tsx` 那条断言跟着改。
- #834 核实 F05：`xingmang-ai-mcp.ts` 以前每次登录同步（已登录时每次打开星芒的账号恢复、首页「重新同步」都会走
  `account:sync-managed-cli-keys`）都整条重建 `xingmang-image`。Codex / Grok 只认用户的 `enabled = false`，Codex 的
  `tools.generate_image.approval_mode` 改回 `approve`，`disabled_tools`、`startup_timeout_sec`、自加的环境变量全丢；
  Gemini 改回 `trust: true`，`excludeTools` 丢。画一张图要扣余额，改成先问的人每次打开都变回不问就画。
- 现在默认值（`enabled`、`tool_timeout_sec` / Gemini `timeout`、Codex 的 `approve`、Gemini 的 `trust`）只在第一次登记时写；
  登记过的条目每次只对齐启动方式：`command`、`args`、`env.XINGMANG_IMAGE_CONFIG_PATH`（env 里别的变量保留），Claude Code
  另对齐 `type = "stdio"`。其余键原样保留，缺了也不补：这一套默认值从 #679 第一次上线起没变过，已有条目里缺的只会是用户删的，
  或者 Codex 自己改写条目时省掉的 `enabled = true`。
- Claude Code 的免确认是 `settings.json` 里 `permissions.allow` 的一条规则，缺了照旧每次补上，这次没改。要它先问得写进
  `permissions.ask`：写进 ask / deny 的本来就不碰，2.1.277 判断权限时 ask 规则排在 `bypassPermissions` 前面，免确认模式下也会问
  （读程序确认）。只从 allow 里删掉那条，在非免确认模式下下次同步会补回来，这一点留着没改，`docs/NATIVE-IMAGE-MCP.md` 写明了。
- #834 F07 的收尾：技能记录 `xingmang-ai-skill-state.json` 不跟着备份恢复。选着 ChatGPT 账号、记录还记着「切回星芒时打开」时，
  在备份页恢复一份星芒配置、里面技能关着，改用当前账号会原样拿它当星芒配置，以前会把客户的关打开一次。
  `adoptRestoredConfig` 加可选的 `fromBackupsPage`（只有 `backups:restore` 传），这时调
  `adoptRestoredXingmangAiSkillOff` 把记录改成 false，和 Gemini 那笔一样放在登记来源之前。切换失败的回滚不传：
  它恢复的是切换前那一刻，记录本来就对得上。在星芒下记着 true 说明上次没打开成，那个关多半就在恢复出来的这份里，照旧打开。
- #834 核实 F07（已知17）：`syncXingmangAiSkillCodexAvailability` 以前开关直接等于「不是 ChatGPT 账号」。开机时 `main.ts` 的默认安装、
  登录同步、保存配置、切回星芒都会走到它，用户自己在 Codex 里关掉的技能每次都被打开。现在在 config.toml 旁边记
  `xingmang-ai-skill-state.json`（`offByXingmang`）：ChatGPT 账号下关技能时记「切回星芒时配置里的关是不是这里星芒关的」，按
  `xingmang-config-relay.toml` 定：那份里技能本来就关着就是用户的（记 false），没有那份（切回时会把 ChatGPT 配置整份带过去）或里面没关
  才记 true；已经记着 true 的不改（上次在星芒下没打开成时，那个关会被原样存进那份）。切回星芒时只打开记着 true 的那个关，
  并把 `xingmang-config-relay.toml` 里同一条一起打开，免得切换失败回滚（只还原 config.toml）后再切过来又带回这个关。
  没有记录的老配置：星芒下的关算用户的，ChatGPT 账号下的关同样按 `xingmang-config-relay.toml` 定。
  `applyXingmangAiSkillEnabledFlag` 遇到同一技能写了好几条时一起改。
- #834 核实 F03（已知15）：Gemini 的 `privacy.usageStatisticsEnabled = false` 以前切回 Google 时只要 privacy 里就这一项就整段删，
  分不清是星芒写的还是用户自己写的。现在星芒写下它时（保存配置、重置、开机补缺省）在 settings.json 旁边记
  `xingmang-gemini-usage-statistics.json`，和 settings.json 同一次两阶段提交；切回 Google 只收回有记录的那一项，再把记录写空。
  有记录之前写下的那些分不清是谁的，切回时留着：关着统计不影响任何功能。备份只还原 settings.json 和 .env，所以
  `adoptRestoredConfig`（切换失败的回滚、备份页恢复都走它）在登记来源之前调 `forgetStaleGeminiUsageStatisticsRecord`：恢复出来的
  settings.json 里没有那个 false 了，记录就作废。
- #834 核实 F04（已知16）：`removeCodexContextLimits` 只删值和老模板（#104 加、#124 撤）一样的 `model_context_window = 1000000`、
  `model_auto_compact_token_limit = 900000`，用户设的别的值留着；`docs/CODEX-ACCOUNT-CONFIG.md` 跟着改。升过 0.2.5 的机器早就跑完了
  这次一次性清理，只影响先在 Codex 里设过这两项、后来才第一次装星芒的人。
- 已知1：`pages-account.tsx` 订阅卡状态不是 active 时原样显示 `subscription.status`。新增 `registry/business.ts` 的
  `subscriptionStates` 和 `pages-account.tsx` 的 `subscriptionStateFor`：new-api 的 active / expired / cancelled、Sub2API 的
  active / expired / suspended / revoked（对过 new-api v1.0.0-rc.24 与 Sub2API 270eac6 的源码），加上界面规范里的 exhausted；
  cancelled、revoked 用 Key 状态现成的「已撤销」，suspended 用「已停用」，其余值用订单那边现成的「待确认」，查表走 `Object.hasOwn`。
- 已知2：`pages-management.tsx` 详情抽屉「范围」原样显示 scope。新增 `extensionScopeLabel`，按 `scopeOptions` 现成标签显示；
  Claude 的 local 显示「当前项目」，Gemini 扩展自带技能的 extension（装在用户目录）显示「我的（全局）」，没有 scope 照旧「未提供」。
- 已知8：`AccountInvite` 的转入金额只在挂上时算一次。转出一部分后资料重读、这张卡不重挂，再点开还是旧数（或上次手填的数），
  比剩下的多时照着确认会报「转入金额不能超过可用返利」。改成每次点开按当时的可转余额重算。
- 已知18：`AccelerationView.tsx` 的眉标 GAME CONNECT 换成现成的页面名「游戏加速」，`ui-spec/06-copy-guide.md` 第一段同步（原型没改）。
- 测试：`business.test.ts` 钉住两个映射（含 `constructor`、`__proto__` 这类原型链上的键）；`e2e/v2-business.test.mjs` 加订阅五种状态、
  转出一部分后再点开对话框两条；加速 `browser-check.mjs` 断言眉标。
- 已知10（第三十三批跟进项）：`App.tsx` 的确认框（卸载、退出登录、重置 Codex 桌面端）做的事失败时，错误框只设原因、不带 `retry`，
  目录里 toolRunning 那条「先关掉……再重试」的「重试」被 `operationErrorActions` 滤掉。确认框的执行抽成 `runConfirmed`，失败时带上
  `retry: () => runConfirmed(pending)`：已经确认过，重试直接再做一遍、不再问；确认框一直开在错误框后面，重试时照样转圈，做成了一起关掉。
  `app-check.mjs` 加一条：卸载撞上「文件被占用」→ 错误框有「重试」→ 点了再卸一次，确认框和错误框都关掉。
- 已知21（第三十批「看过但不列」）：`features/chat/state.ts` 的 `attachmentErrorMessage` 以前从第一个汉字截起。英文的写入失败
  （EPERM、ENOSPC）里汉字只在路径上时（Windows 中文用户名、Mac 上的中文文件夹）会把半截路径端上屏，中文原话开头的「AI」也会被截掉。
  改成先 `userFacingErrorMessage`（剥 IPC 前缀、脱路径）再按 `speaksChinese` 判：中文原话打码后整句上屏，英文换成原有的
  「图片没有加上，请再试一次」。
- 已知2 跟进：`pages-management.tsx` 的「范围」筛选只比原样的 scope，详情写「当前项目」的 local 插件在「当前项目」下看不到，
  写「我的（全局）」的 Gemini 扩展自带技能（extension）在「我的（全局）」下也看不到，只有「全部范围」里有。新增 `extensionInScope`，
  和 `extensionScopeLabel` 共用 `extensionShownScope` 这一套归类；增删改照旧交回原样的 scope。
- ui-spec：加速页原型模块 `99z-acceleration.js` 的眉标改成「游戏加速」并重建原型 HTML，06 去掉「原型未同步」那半句；
  22 订阅一行补 cancelled / revoked / suspended 和兜底「待确认」；04 技能插件一节写明 local、extension 的归类；CHANGELOG 记一行受控。
- 测试：`business.test.ts` 钉住 `extensionInScope`；`e2e/v2-business.test.mjs` 加一条：筛「当前项目」「我的（全局）」时，
  local 插件和扩展自带技能出现在详情写的那一档（旧代码上红在等 local 插件那一行）。
- 已知25：Codex 桌面端「中文增强启动失败」和它里面那层「AppX 激活失败」（`codex-desktop-cdp.ts`）挂上 `cause`。启动那边接住这个失败
  以后改走普通启动、只往控制台打一句，打包版不留控制台，原因以前哪儿都看不到。现在 `system-service.ts` 用新导出的
  `withCodexDesktopCdpFailureReport` 把这一步包一层，失败时记一条 `codex-desktop.chinese-launch.failed`（warn），`error` 下面顺着
  cause 记到 PowerShell 那层的退出码和标准错误（#880 让运行日志记 cause）。启动行为不变，失败照旧往外抛。
- 已知24：`scripts/windows-installer-install-directory.test.cjs`、`scripts/macos-artifact-names.test.cjs`、
  `scripts/rename-macos-chip-artifacts.test.cjs` 接进 `test:scripts`，以前 npm test 和 CI 都不跑；接上以后 19 条都过。
  `ci-workflow-config.test.cjs` 加一道门禁：`scripts/` 下每个测试文件都得有某条 npm 脚本点名（只在 Mac 上跑的经 `test:mac:free-signing`）。
- 已知22：短提示 2.4 秒后自己消失，浏览器用例直接等它上屏的话，慢机器上会错过、卡满 30 秒。#198 只改了 app-check 的保存用例；
  这次把那份提示记录挪进 `e2e/toast-recording.mjs` 共用，还在直接等提示的 21 处改成认记录：`e2e/v2-business.test.mjs` 16 处、
  聊天的 `browser-check.mjs` 2 处、app-check 3 处，认的还是原来那句话（原来只写半句的补成整句）。找法写在那个文件开头：让短提示一出来就隐藏、1 毫秒后消失，
  跑新界面全部浏览器用例，只有测提示本身的两条该红。
- 已知26：`docs/RELEASING.md` 改正 Mac 换签名证书以后的说法：不是「每 3 小时重试」，停在「已下载」时定时检查直接跳过，重装只是把
  下好的同一个包再交给 Squirrel。
- 已知3：`external-client-runtime.ts` 的检测脚本在 AppX 注册信息、数字签名两处 catch 里把 `$_.Exception.Message` 直接拼在
  中文后面，首页那一行就带着系统英文。现在 `errors` 只留中文那句，原话另放 `errorDetails` 交回，经 `onDetectionErrorDetail`
  进运行日志 `external-client.detection-error-detail`（路径按主目录脱敏；同一个客户端原因和原话都没变不重复记；这一行最后
  报的是这边核对路径、签名时另起的错时不配这句原话）。不新写字。
- 已知13：照 CLI 那份 `system-snapshot-cache.ts` 的做法，新增 `external-client-snapshot-cache.ts`：每次真检测完把三家各一条的
  整份结果写进本机数据目录的 `external-client-snapshot.json`（原子写、只认三家齐全的整份、`running` 一律记成没开、字符串过
  `redactCommandText` 并截长、下载页只认白名单那一条），下次开机首页先拿它把那几行画出来，每条带 `cachedAt`。要落盘的字段
  用类型钉住（必填字段连同类型、可选字段名，改了就过不了类型检查，提醒加格式版本号）。读取复用 `external-clients:scan`，
  第二个参数 `{ cachedOnly: true }`（入参严格校验），不新增通道；这一读只读本机文件，不陪账号恢复排队、不起盘点、不记检测
  失败，运行日志记成「已先显示上次的客户端检测结果，共 N 项」而不是「外部客户端检测完成」（免得客服以为这次已经检测过）；
  本次启动真检测过以后只回空列表。首页见到 `cachedAt` 就当作还在检测：主按钮、「配置」「打开」先不能点，挂着现成的
  「正在检测 WorkBuddy、Claude Desktop 和 OpenCode」那一句；真的那轮照旧排在首屏扫描之后，回来就整份替换，没读到就撤下
  旧的、只留原来那条红条。主进程里安装、打开、配置、连接自检、反馈报告都不读这份文件。
- 已知20：`claude-desktop-local-transaction.ts` 每次保存给改到的每个文件留 `.bak.<随机>`，以前从来不清。现在整次保存成功
  以后，照 `config-files.ts` 每个文件只留最近 5 份：只认自己起的 UUID 后缀，按修改时间排，刚留的那份不删，手工放的 `.bak`
  和别的文件不碰，删经 `removeSafeDataFileSync`，清不掉的照旧留着、不把保存变成失败；保存没成功时一份不删（那句报错要客户
  从 .bak 恢复）。
- 测试：`external-client-runtime.test.ts` 加脚本那两句不再带原话、原话进日志且只记一次；`system-service.external-client-log.test.ts`
  把这行日志写进真的运行日志再读回来（主目录已脱敏）；`e2e/windows-powershell-probes-smoke.mjs`（Windows 打包那一步真跑
  PowerShell）加 AppX 和数字签名两处抛错时 `errors` 只有中文、原话在 `errorDetails`。新增 `external-client-snapshot-cache.test.ts`
  （往返、只认整份、脱敏和多余字段、坏行和白名单外的下载页、类型钉、原子写和只读一次、硬链接拒读）；
  `external-client-service.test.ts` 加重启后先给上次结果、真检测过以后只给空列表；`ipc.test.ts` 加这一读不陪账号恢复排队、
  参数格式不对报错；`claude-desktop-config.test.ts` 加每个文件只留最近 5 份、保存没成功时一份不删。新界面浏览器回归加开机先摆
  上次结果且按钮等着、真的那轮没读到时撤下旧的；原有「客户端盘点排在首屏扫描之后」那条改成只数真检测。
- 已知39：`workspace-guard.ts` 加 `sensitiveWorkspaceAsksAtLaunch`。`cli:launch` 开新对话时，`once` 那八类（主目录、
  盘根、桌面、下载、文档、Users、整个 OneDrive、AppData）也弹选择器那一问，原来只问 `every-time` 两类；续接对话照旧
  只问 `every-time`。首页「打开」、「换一个目录」里的最近目录、托盘和快捷键用的是从会话记录推出来的目录，不经过选择器，
  客户自己在主目录开终端用过 claude，按钮就写「打开 张三」。
- 选择器里点过「仍然打开」的放行（同一路径、两分钟、只用一次）从只认 `every-time` 扩到所有敏感目录
  （`confirmedSensitiveWorkspace`），免得选完紧接着又问一遍。问完「仍然打开」，Windows 上桌面、文档、下载照旧先试写
  （`launchUnlessUnwritable`）；在这一问里点「换一个文件夹」重选的、「新建」建出来的也先试写，原来这一支直接打开，
  只有系统目录和存密钥的目录走得到，现在首页「打开 张三」那一问也走这里。通道形状没变，`ipc-contract.ts`、`preload.ts`、
  渲染层都没动；旧界面的引导拿存下来的工作目录打开（从没选过时是主目录），现在同样先问。`docs/WORKSPACE-TRUST.md` 跟着改。
- 2026-10-06 已知问题清单 39；yoyo 2026-10-06「全部修复」。
- 已知4：`features/tools/recent-workspaces.ts` 加 `resumeNeedsRecheck`、`resumeStillLatest`。首页 `Home.tsx` 的「接着聊」（按文件夹接最近
  一条的 Claude Code、Gemini CLI、Grok CLI）点下去先作废一分钟缓存、现读一份「最近」，点的这条已经不是它（工具 × 文件夹）最近的
  一条就换上新列表、这次不打开；读不到照旧打开；Codex 按记录 id 接，不读。记录页 `SessionsPage` 同一下，放在打开前那几道关之前
  （问完话再说不打开等于白问），不一致时列表一起重读。
- 已知5：`pages-business.tsx` 给三个 `ExtensionsPage` 传 `active`，`ExtensionsPage`、`MaintenancePage` 接 `useReloadWhenShown`，
  再显示时重读，在读就不再起一轮；外接工具的连接检测（`checkProviderMcpHealth`）照旧不跟着重跑。
- 已知6：`features/app/environment-status.ts` 加 `markDiagnosticsStale`（状态栏退回「环境待检测」）和环境版本号，`publishDiagnosticsCounts`
  可带开跑时的版本，跑到一半环境改过就不交（缺省＝旧行为）。`App.tsx` 在工具行任务收尾（`environmentJobsFinished`，打开工具不算）、
  配置窗口保存、账号 Key 真写了或修了 Codex 老配置、备份恢复、密钥页「配置到工具」、`onSystemChanged` 时标过期，不在后台替客户重查。
  检查页开着时版本一变就重查一次，在查就等这一轮查完。
- 已知12：`App.tsx` 给账号 Key 同步的结果记 `finishedAt`；`Home.tsx` 的 `bootstrapNoticeExpiresAt` 让只说「已完成 N 组工具的 Key 配置。」
  的那句照右下角提示条的读完时长（`toastDurationMs`）到点收起，回首页时已过点的不再出现；有失败、有提醒、被网拦住的照旧常驻。
- 测试：单测补 `recent-workspaces`、`environment-status` 和首页横幅；`app-check.mjs` 补七条（首页和记录页「接着聊」先对一次、Codex 不读、
  扩展三页和安装卸载页再显示重读、状态栏装完退回灰点、检查页自己重查、横幅到点收起）。原「记录页接着聊后回到窗口」那条，「最新 100 条」
  的读次数多一次（点的时候先对的那一下）。
- 2026-10-06 已知问题清单 A 组 4、5、6、12；yoyo 2026-10-06「把已知的问题都做完」。
- 已知48 里不等新字的几处（第三十六批、第三十九批「查过、不收」的两条，第四十四批 10）：`system-service.ts` 卸掉 ~/.grok/bin 里的 Grok 后，
  从当前用户 PATH 删目录那一步原来等着、只给 8 秒，用 `[Environment]` 读写，会把 `%VAR%` 写死、把 REG_EXPAND_SZ 改成 REG_SZ，
  超时就把已经卸完的报成失败。改成 `windows-cli-shell-access.ts` 的 `buildRemoveUserPathScript`（照 `buildEnsureUserPathScript`
  读写注册表原值、保留值类型，只为比较展开、没有命中就不写）+ `removeDirectoryFromWindowsUserPath`（60 秒）；经新的
  `CliTerminalAccess.forgetUserPath` 在后台跑，不等它，失败只记 `cli.user-path.remove-failed`。服务新增 `removeWindowsUserPath`
  注入口，只有 `main.ts` 在 Windows 上接真实现，测试里不起 PowerShell。
- 已知48：`grokManualUninstallResult` 安全核对没过时，英文原话（:820 那句和 `macos-grok.ts` 里那些）不再接在「自动卸载安全验证失败：」
  后面上屏，按 `isChineseSentence` 判，英文换成原有的「Grok CLI 自动卸载安全验证失败」；原话照旧放在 `error` 里，
  `ipc.ts` 的 `cli.uninstall.completed` 遇到 manual-required 时把它记成 `reason`。这组单测从只在 Mac 上跑的 describe 挪出来，
  Linux 卸不了时走的也是它。
- 已知68（yoyo 2026-10-06 亲手同意放宽）：`external-client-runtime.ts` 的 `launch()` 以前打开前一律现验签名（Windows 上
  对每个装着的客户端跑一遍 `Get-AuthenticodeSignature`），每次点「打开」都要等好几秒。现在 Windows 上打开前那次清点带上
  这次运行里记住的签名结果，但只带核对通过（`Valid`）的那些：没核过的、上次没通过的照旧现验。记住的结果只在内存里，不落盘。
- 认不认记住的结果由检测脚本判：路径、大小、修改时间、创建时间之外，新加卸载信息里登记的版本（DisplayVersion）也要和
  验签那次逐字一样，任何一项变了就现验。展示用的检测同样多了这一条（只会多验，不会少验）。版本超过 256 字的不记
  （截短或记成空串，就和别的版本、没登记版本分不开了），照旧现验。
- 其余不变：装客户端前后照旧现验；Mac 上打开照旧现验（这次只放宽 Windows）；路径、符号链接和联接、注册表、发布者的核对
  每次打开照旧都做，记住的结果也必须是官方发布者签的；打开照旧经资源管理器以当前登录用户启动。
- 测试：`external-client-runtime.test.ts` 原来钉着「打开从不带记住的签名」那条改成新的规矩（展示用的全带、打开只带通过的、
  装一条不带），另加一条打开会用上自己或检测记住的通过结果、不用记住的失败结果，去掉这次的改动两条都红；再加一条版本太长时
  不记。
  `e2e/windows-powershell-probes-smoke.mjs`（CI 里 Windows 打包那一步真跑 PowerShell）加一条：记住的结果在文件和版本都没变时
  照用，版本变了、版本没了、文件大小变了都真的再验一次。
- 已知11（第三十批跟进项）：`src/renderer-v2/features/tools/ConfigDialog.tsx` 的 `run()`（保存配置、读取密钥、选择文件夹、中文界面
  与文件夹权限那几颗按钮）和「保存并检测模型」没保存成的那一支，失败时改用 `failureWithDetail` 连原话一起留着，红字（含重置确认框）
  用页顶红条那个 `FailureReason` 显示：认得出类别时先说 `registry/errors.ts` 里现成的标题和正文，原来那句跟在后面；认不出照旧。
  没过前置检查的提示和「模型检测未完成」不变。没有新写的字。
- 没权限（EPERM/EACCES）时和页顶红条一样说「写不进安装目录」，对配置文件不准，那是已知29，改 `registry/errors.ts` 时这里跟着变。
- 测试：`app-check.mjs` 新加保存时 EBUSY 的用例，对话框和重置确认框都先说「工具正在运行」、不露英文原话和路径。
- 已知19：`resolveWindowsCliExecutionModeDetailed` 多回一个 `highIntegrity`（读出了完整性标签才有；自带 Administrator
  的默认令牌也是 High，照旧 same-user），启动日志 `cli.execution-mode` 跟着记。`main.ts` 把它作为
  `windowsProcessElevated` 交给 `registerIpcHandlers`，`platform:get-capabilities` 为真时叠上 `processElevated: true`
  （`PlatformCapabilities` 新可选字段，缺省 = 旧行为）。`elevation-notice.ts` 三个函数多收一个可选的 `elevated`，为真时
  不出那句：首页运行环境卡（只用 Codex 桌面端时那段只去掉弹窗半句，「一般不用单独点」照旧）和 Codex 桌面端那行、
  「安装卸载」页 Node.js 和 Codex 桌面端两行；更新页重启安装确认框的
  授权窗口那句、`buildAutoInstallNotice`（打开时装、退出时装的预告）里「Windows 弹出授权窗口时请点「是」。」同样不出，
  后者和 Mac 那份说法一样。没有新字。
- 客户恢复脚本 `scripts/windows-acceleration-recovery.ps1` 的还原逻辑检查（全部读写都是假的、不碰真代理）
  从 `test:scripts` 挪到 Windows 打包作业的 `e2e/windows-powershell-probes-smoke.mjs`。它原来在 node --test
  分片里和几十个套件同时跑，冷启动的 Windows PowerShell 在 #782 上把 30 秒用完、一条检查都没红。
  `scripts/` 下两条只读源码的检查（无 BOM、和软件那份 WinInet 脚本逐字一致）留在原处；
  `ci-workflow-config.test.cjs` 那条「单元测试不起真 PowerShell」的门禁扩到 `scripts/*.test.cjs`。
- `acceleration-development-host.test.ts`「父进程突然退出后辅助进程照样收尾」那条不再自带三个墙钟期限
  （父进程 4 秒内退、3 秒内写出 restored、假辅助进程 5 秒自尽），改成按事件等，只由用例自己的 10 秒上限兜底。
  10-1 在沙箱整套 `npm test` 里偶红过；这次在沙箱压满 CPU 跑了 50 多轮没复现，这是全文件唯一靠墙钟判输赢的用例。
- Windows 的 renderer-v2 夹具浏览器分片从两片加到三片（`renderer-v2-browser-1`～`-3`，各 18 分钟上限不变）。
  10-6 两片各跑 7～10 分钟，最慢的机器上每片每天多半分钟上下，推测 10 月下旬会再撞 18 分钟，所以趁现在拆。
  `app-check.mjs` 的用例照旧按声明顺序轮流发到三片；其余文件按 10-6 三轮 CI 的实测耗时分：
  第 1 片加速 + 公告记忆，第 2 片登录 + 组件 + 对比度，第 3 片聊天 + 键盘 + 账号绑定启动 + 公告。
- Linux 的 `linux-renderer-v2-browser` 不再整份跑 `test:v2:browser:fixture`，改成两个并行作业
  （`test:v2:browser:fixture:linux:1` / `:2`，同样按 `XINGMANG_TEST_SHARD` 发 app-check 的用例，其余文件按 Linux 上的耗时分）。
  10-6 它整份跑要 13～16 分钟，是整轮 CI 最慢的一个作业。作业名、上限 30 分钟和 `quality-gate` 的依赖都没变。
- `ci-workflow-config.test.cjs` 的分片门禁改成 Windows、Linux 两边各查一遍：每份都派发、分母等于份数、
  发牌的文件每份都跑、其余文件只在一份、合起来等于 `test:v2:browser:fixture`；Linux 不许再整份跑一遍。
- 已知45 检查页那半（yoyo 10-6 回「改」，用的是 11:16 给的三处新字）：`diagnostics.ts` 的
  `PROVIDER_ENVIRONMENT_OVERRIDE` 在 Mac 上另去读 9 个终端设置文件（`~/.zshrc`、`~/.zprofile`、`~/.zshenv`、`~/.zlogin`、
  `~/.bash_profile`、`~/.bash_login`、`~/.profile`、`~/.bashrc`、`~/.config/fish/config.fish`），经 `readSafeUtf8File`
  读，上限 512 KiB；链接、硬链接、超大的不读，原因只进日志（`diagnostics.shell-settings.skipped`），I8 不放宽。
  只找 `breaksAccount` 的四个，只看用星芒账号（`relay`）的工具：Claude Code 用自己账号时启动脚本不去掉它们（#920），
  报了「从星芒打开不受影响」就不对；Gemini CLI 不用星芒账号时这几个起什么作用没实测过（T12）。空值、指向当前账号的地址、
  指向 `~/.claude` 的 `CLAUDE_CONFIG_DIR` 不报，看不出值的照报；同一个名字在一个文件里导出几次，有一次指向别处就报。
- 新模块 `shell-startup-exports.ts`：纯函数 `parseShellStartupExports(text, dialect, names, home)`，按 zsh、bash 与 fish 的
  引号、转义、注释、here-document、`;`、`&&`、换行分句，认 `export`、`typeset -x`、`declare -x`、先赋值后 `export`、
  `set -a` / `setopt allexport`，以及 fish 的 `set -x`（各种写法）和它的 `export` 函数。`$HOME`、`${HOME}`、不带引号的
  开头 `~` 换成主目录，别的展开一律当看不出值。不执行、不跟 `source`。`unset`、`set -e` 不抵消前面的导出：在函数里
  切换中转的写法常见，从上往下读是「已删」，客户终端里却可能还留着。
- 结论：都是启动脚本会去掉的（`droppedByMacosLauncher`，和 `system-service.ts` 的 `macosShellOverrideVariables` 对齐，
  单测逐个变量、逐种账号钉住）→「需留意」，新字「终端设置里另外设了 {名字}：从星芒打开的工具不受影响，自己开终端直接用
  {工具} 时会不用当前账号的设置。用不着的话，把这几项从终端设置里删掉」，详情行「{名字}（{工具}，在 {文件}）」。名字超过
  三个沿用「等 N 项」，同名只说一次（`namesOf` 去重）。启动脚本照旧会带过去的（Claude Code 没用星芒账号时，星芒进程环境里的）
  仍是原来的「待处理」，原话不变，只点这几个的名。星芒进程环境里和终端设置文件里同名的，只留带文件的那条。
  Windows、Linux 的输出一字不变。
- 单测：解析 25 条（含 fish 6 条）；检查页 Mac 14 条，含真建链接的 `~/.zshrc` 不读、日志里没有值和主目录，Windows、Linux
  不读这些文件。另在沙箱里拿真 zsh 5.9、bash 5.2、fish 3.7 对了 47 段写法（没进仓库），只有两处 zsh 才有的边角
  （`~不存在的用户/…`、`~"/…"`）多报，都是多报不漏报。故意改坏 32 处，每处都有单测红。没在真 Mac 上演过。
- 已知45（第三十四批跟进项 1）：和第三十四批 B 同一条路，macOS「终端」先起客户的登录 shell 读 `~/.zshrc` 等文件，
  里面 export 的变量一路带给工具；星芒从访达打开，自己的环境里没有它们，`providerCommandEnvironment` 管不到。
  `system-service.ts` 新增 `macosShellOverrideVariables(provider, accountMode)`：Claude Code 只在用星芒账号（`relay`）时
  去掉检查页实测会绕开当前账号的 `ANTHROPIC_API_KEY`（多带 `x-api-key` 换掉 Key）、`CLAUDE_CONFIG_DIR`（整个不读
  `~/.claude`），即 `diagnostics.ts` 的 `breaksAccount`；用自己的 Claude 账号时这两个可能就是客户自己的 Key 和登录
  （切回官方时 `config-files.ts` 也把他原来的 `ANTHROPIC_API_KEY` 放回 settings.json），不动。Gemini CLI 不论哪种账号，
  去掉 `providerCommandEnvironment` 在 Windows、Linux 上本来就不交给它的五个（抽成模块级常量共用）。
  Codex（`CODEX_HOME` 星芒每次自己写，`OPENAI_*` 盖不过 config.toml）、Grok（没实测过）不动。
  Windows、Linux 上 Claude Code 的这两个照旧由检查页提示，这次不动。
- 已知45 跟进（协调者定的）：用星芒账号时，三个平台从星芒打开 Claude Code 都不带客户环境里选型号的那几个，范围和接账号时
  从 settings.json 挪开的一致：`config-files.ts` 从 `claudeForeignEnvKeys` 导出 `claudeForeignModelEnvKeys`（去掉
  `ANTHROPIC_API_KEY`），`system-service.ts` 的 `launchExcludedEnvironmentVariables(provider, accountMode)` 只在
  Claude Code 用星芒账号时给出这份名单。打开前 `withoutEnvironmentVariables` 不分大小写地把它们从交给终端的环境里去掉
  （Windows、Linux 两条路都吃这份环境）；Mac 的启动脚本名单也包含它们；Linux 计划多一个可选的 `clearedEnvironmentKeys`，
  启动脚本照样 `unset`，免得交给已经开着的命令窗口程序时，那个程序自己环境里的那份补上来。用自己的 Claude 账号时照旧带。
- `buildDarwinCliLaunchPlan` 多收一个可选的名单，放进计划的 `clearedEnvironmentKeys`；`buildMacosTerminalScript` 在进文件夹
  检查之后、export 之前 `unset` 它们，星芒自己的值（Gemini 的 Key、地址、模型）随后照旧写回。两边的名字都按环境变量名校验，
  不合格抛错；没给名单时计划和脚本都和以前一字不差。`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 盖不过 settings.json 的
  env 段，不动。不加新字。客户自己开的终端照旧会读这些设置；检查页在 Mac 上把它们查出来那一半要新字，另做。
- 单测：Mac 启动脚本里 `unset` 排在进文件夹检查之后、第一条 export 之前，没给名单时不出这一行，四种不像变量名的写法都抛错，
  `launchMacosTerminal` 把计划里的名单带进它写的脚本；有 `/bin/zsh` 时用真 zsh 跑整份启动脚本，登录 shell 带进来的
  `ANTHROPIC_API_KEY`、`CLAUDE_CONFIG_DIR`、`GOOGLE_GENAI_API_VERSION` 到不了工具，`GEMINI_API_KEY` 是星芒那份，名单外的照旧
  带上，stderr 为空。Linux 启动脚本同样排在进文件夹之后、export 之前，四种坏名字抛错，真 `/bin/sh` 跑时命令窗口程序环境里的
  `ANTHROPIC_MODEL` 没给名单时带过去、给了就到不了工具。`system-service` 这边钉住选型号的名单只在 Claude Code 用星芒账号时
  给出、Mac 名单包含三个平台都不带的、Claude Code 的 Key 和配置目录只在星芒账号时去掉、Gemini 的名单和 Windows、Linux
  去掉的一样、Codex 和 Grok 不动、去名字不分大小写。三个平台各走一遍打开 Claude Code 的服务层流程（`SystemServiceOptions`
  为此多一个测试接缝 `launchMacosTerminal`，同 `launchLinuxTerminal`、`launchCliPowerShell`）：星芒账号下，Windows 交给
  PowerShell、Linux 交给命令窗口的环境里没有 `ANTHROPIC_MODEL`（Windows 那条连小写写法一起），Mac、Linux 的计划带着名单；
  自己账号下 Windows、Linux 照旧带上 `ANTHROPIC_MODEL`，Mac、Linux 的计划不带名单。`config-files` 钉住名单和接账号时挪开的
  同一批（只差 Key）；`diagnostics.test.ts` 逐个变量跑检查页，凡是判成「待处理」的都得在 Mac 启动脚本的名单里。故意改坏
  十一处（去掉 Mac 的 `unset`、Claude 不看账号、Claude 名单少一个、`launchMacosTerminal` 不带名单、打开时不去掉、Linux 脚本
  不 `unset`、Linux 不传名单、选型号的名单不看账号、Mac 打开时不把名单交给启动脚本、去名字时分大小写、Windows 那条不用去掉后的
  环境），每处都有单测红。没在真 Mac、真 Windows、真 Linux 桌面上演过。
- 已知57（0.2.15 回归检查第 7 条 / F2）：`proxy-bypass.ts` 的 `createSiteFetch` 以前只在拿到回话之前失败才报 `siteRouteFailed`，
  直连会话回的是拦截页、门户跳转，或者回了话以后正文读到一半断了、超时了，都当走通了，这一轮一直直连到重开软件。现在回网页
  （text/html）或 opaqueredirect 当场报；正文读出错时也报（新模块 `response-body-watch.ts` 给正文包一层流，状态、头、url、
  redirected、type 照抄，调用方拒绝重定向的那道检查不受影响），调用方自己中止的照旧不算（账号请求除外，同 `abortMeansUnreachable`）。
  报上去以后走原来那套再看，规则不变：系统代理连得上星芒才交还，不然接着直连。
- `probeDirectConnection` 以前回什么都算通，拦截页、网关错误页也算，直连那一路被拦了照样分过去，也看不出该交还。现在只认
  JSON：content-type 是 JSON、正文 64 KB 以内能解析，状态码不管（维护时回的 503 JSON 也说明连得到服务），加 `Accept: application/json`。
  整个改直连、分去站点直连、交还、改回跟随系统代理这几处判断都用它。
- 测试：新增 `response-body-watch.test.ts`；`proxy-bypass.test.ts` 改写探测那几条，加站点 fetch 报拦截页、跳转、断流、中止的几条，
  按 main.ts 的接线加「公司网拦截页时交还」「AI 回复断了交还」「直连只回门户页时不分过去」三条；接线用例里代表「服务回了话」的
  假回应改成 /api/status 那样的 JSON（以前是空的 204）。
- 没做：已知38（代理回绝星芒时整个改直连）不动。没在真机上演过。
- 已知7（第二十九批「看过但不列」那条，当时等的首页运行环境卡已随 #797 合入）：`diagnostics.ts` 加
  `reconcileNodeRuntimeWithClis`，跑完所有检查后，四个 `CLI_*` 都确认没装（`details.installed === false`）时，把没装的
  `RUNTIME_NODE` / `RUNTIME_NPM` 从 `fail` 降成 `warn`；结论照旧「未安装」，「去处理」照旧去「安装卸载」。有一家装着、或者
  那一项没查出来（超时、出错）的照旧 `fail`，同首页的 `nodeOptional`。降黄不是不出：Codex 桌面端的「星芒画图」要 Node.js。
  用跑完的结果判断，不为这个再探一遍四家工具。不加字。
- 测试：`diagnostics.test.ts` 四条（都没装时两行是 `warn`、计数跟着变；装着 Codex 照旧 `fail`；有一家没查出来照旧 `fail`；
  Node.js 那一项超时、Python 和 Git 不动）。
- 已知9：`StartGuide.tsx` 的 `runtimeByApp` 原来只算 Windows 和能代装 Node.js 的 Linux，Mac 照旧写「在应用外安装完成后回来
  重新检测」、按钮叫「安装指南」，选工具那一步写「命令行，要先按提示准备运行环境」。可 Mac 第十六批 2 起也由本软件准备 Node.js，
  按钮点下去其实是星芒自己去下。现在 Mac 和 Linux 一样按 `runtimeAutoPrepare` 判断，Windows 不变；用的都是 Windows、Linux
  那边现成的字，不加新字。`StartGuide.test.tsx` 里原来钉着「Mac 字样不动」的两条改成 Linux、Mac 一起测。
- `electron/windows-elevation.ts` 打开工具的中转脚本把 `Start-Process` 和回传进程号包进 try/catch，出错时只把 `$_` 以纯文本
  写回标准错误再 `exit 1`。以前留给 PowerShell 自己报，标准错误被重定向时它包成 CLIXML，还附上出错的那行脚本。写 `$_`
  （ErrorRecord.ToString，先取 ErrorDetails）而不是 `$_.Exception.Message`：通配符那种报错的原因只在 ErrorDetails 里。
- `describeWindowsCliLaunchError` 只从标准错误读原因，不再拼 Node 的「Command failed: 整条命令行」。`parseWindowsCliLaunchCause`：
  纯文本照用；还是 CLIXML 的（受限语言模式下 catch 里的 `[Console]` 调不了，或者脚本根本没跑，比如被杀毒拦下）解开
  `<S S="Error">`，跳过出错位置、引用的脚本和分类那几行，取第一段原因，去掉颜色转义和打头的命令名。5.1 按控制台宽度折行，
  命令出错时原因在出错位置前面、脚本没跑时在引用的脚本后面；7 带颜色转义，脚本没跑时原因在「|」后面。PowerShell 之前报过
  进度的，CLIXML 头先写出去、XML 退出时才写，catch 写的原因夹在两者之间，也认得出。超时这种读不到原因的，落到现成的「请查看
  反馈与诊断日志」；PowerShell 根本起不来（spawn 失败，execFile 照样附一个空的标准错误）照旧用 Node 的消息。
- 原文（标准错误、Node 的消息、退出码、信号、是否超时被停）放在 `WindowsCliLaunchError.launchOutput`，`system-service` 照 Linux
  那样另记一条 `terminal.failed`（同一句「… 的命令窗口没能打开」），路径按主目录脱敏。`-EncodedCommand` 后面的 base64 里有
  文件夹和用户主目录，主目录脱敏看不进去，两种写法（Node 的命令行、PowerShell 错误视图里引用的那行脚本）都抹掉。
  `SystemServiceOptions` 加测试接缝 `launchCliPowerShell`，同 `launchLinuxTerminal`。
- `e2e/windows-powershell-probes-smoke.mjs` 方括号那项改成整段跑 App 造的中转脚本，只把要起的终端换成隐藏的 cmd.exe；
  不转义时要求原因是 catch 写回来的（标准错误里没有 CLIXML 的错误视图），按 App 的说法拼出来的错误框里没有 CLIXML 和命令行。
- 第三十九批 C。三个客户端的「打开」在主进程排的是同一个安装队列（`external-client-runtime.ts` 的 `external-client:launch:*`），
  渲染层标签却写死「正在打开客户端」，全面检测 Q15 只给命令行工具和 Codex 桌面端接上了 `launchWaitLabel`。`launchWaitLabel`
  （`features/tools/launch-notice.ts`）加可选的第三个参数 `idle`（前面没人时说什么，缺省照旧「正在打开工具」）；`App.tsx` 的
  `launchExternal` 先算 `launchWaitLabel(toolbox.jobs, jobToolName, '正在打开客户端')` 再交给 `toolbox.run`。找名字的小函数提成
  `App.tsx` 顶层的 `jobToolName`，命令行工具那条也改用它。标签按点下去那一刻算，和 Q15 一样。
- `launchWaitLabel` 跳过 `switch:`、`repair-hooks:` 两类任务：它们只走 `serializeConfigWrite`，不进 `InstallationQueue`，「打开」
  不等它们，以前却说「正在等 另一个工具 安装完」。前面是 `git` 时和 `node`、`python` 一样说运行环境（Git 不在工具表里，在首页
  「运行环境」卡上）。Mac 上苹果安装窗口那段 Git 不占队列（`installMacGitRuntimeForService`），这时点「打开」这句只闪一下，和以前一样。
  只用现成的句子，不新写字。
- 测试：`launch-notice.test.ts` 补客户端说法、跳过两类任务和 Git；`testing/app-check.mjs` 补一条：前面没东西在装时照旧写
  「正在打开客户端」，正在装 Gemini CLI 时点 WorkBuddy 的「打开」写「正在等 Gemini CLI 安装完，安装完马上打开」。
- Windows 开机自启、窗口没打开过时，打开时装不再直接留到退出时（#840 的 'skip'）：`resolveLaunchInstallMode`
  新加 'window'，记下这一版，主窗口第一次 `show` 时照 'notice' 那样先预告、等 5 秒再装（UAC 照弹）。只
  Windows（安装包 perMachine，每次装都要授权，开机自启、只关机不退出的人留到退出时就一直装不上）；Mac 不变。
- 等到第一次打开窗口才装的，离开机可能已经过了几个小时：预告之前和等完各用 `shouldStillInstallAtLaunch`
  看一眼（入参 `background` 换成 `mode`），这时开着加速就不装，留到退出时（装的时候加速会断，装好不会自己
  连回去）。日志：等窗口时 `install.on-launch.held` 写明等第一次打开窗口，打开窗口去装时
  `install.on-launch.window-shown`，不装时 `install.on-launch.skipped`。`main.ts` 里三种装法共用一个
  `startLaunchInstall`。
- 0.2.15 发版前回归检查第三节③：`codex-desktop-service.ts` 的官网离线包这一路以前没有慢的出口，下得慢只能点取消，而取消会停掉整轮安装，
  到不了国内镜像。现在 `downloadCodexDesktopPackage` 按来源的 `maximumRemainingMs` 看速度：过了 30 秒的观察期，每个数据块按平均速度估算
  剩下的还要多久，超过 10 分钟就用另一个 AbortController 中止这一路，抛「OpenAI 官网下载太慢：照目前的速度还要 N 分钟才下得完」，
  走原来「官网没下成就换国内镜像」那条路（进度用已定稿的那句）。按剩余时间算，前面慢过、只差最后一点的不扔掉重下；国内镜像是最后一路，
  不设这个限制。客户点取消照旧整次停下。新增 `estimateCodexDesktopDownloadRemainingMs`、`isCodexDesktopDownloadTooSlow` 两个纯函数。
- 回归检查第三节④：外部客户端（Claude Desktop、WorkBuddy、OpenCode）的安装以前没有取消通道，Claude 官网包（Windows MSIX #804、
  Mac #802）下得慢时还占着全局安装队列。`external-client-runtime.ts` 接入 `InstallCancellationRegistry`，入队前登记，新增 IPC 通道
  `external-clients:cancel-install`（`ipc-contract.ts`、`preload.ts`、`ipc.ts` 三处，注册紧跟 `external-clients:install`）。排队、官网下载、
  核对安装包都能停；Windows 上 winget 整段（结束它会连带结束它拉起的安装程序）、下好的 MSIX 交给 `Add-AppxPackage`、腾讯安装程序运行时
  封存，拒绝时给「正在安装 X，这一步中断会留下装了一半的程序，请等它结束。」；winget 没装上、换官网包那一路时解封。Mac 全程不封存：
  放进「应用程序」是整个改名，跨盘时先拷到临时名字再改名。`claude-desktop-msix-installer.ts`、`workbuddy-installer.ts` 各加一个
  `onInstallStarting`，在最后一次检查 signal 之后同步调用，供调用方封存。取消统一抛 `InstallCancelledError`（「X 安装已取消」）。
  首页这三行接上「取消」：`App.tsx` 的 `installExternal` 给 `toolbox.run` 带上 `cancel`，`Home.tsx` 新增可选的
  `onCancelInstallExternal`，按钮点下去显示「正在停止」，主进程拒绝时那句原因照命令行工具那几行用 toast 提示。
- `download-retry.ts`：每次读到数据块后先看这一轮有没有被中止。响应体不跟着请求信号一起中止时（测试里的流、不接信号的 fetch 实现），
  流里排着的数据块会赢过中止，取消或「太慢」要等排队的数据读完才生效；整包都排在流里时甚至照样当成下完返回。
- 排队时点「取消」以前只是记下取消，要等前面那项装完、轮到它时才抛出，这段时间那一行一直写「正在停止」或「取消中」。
  `InstallationQueue.enqueue` 加可选的 `signal`：还在排队时信号中止，这一项直接出队，用信号的 reason 拒绝，任务一行不跑，
  `revision` 不变也不通知；已经轮到的不归队列管，由任务自己看信号。命令行工具（`system-service.ts`）、Codex 桌面端
  （`codex-desktop-service.ts`）、外部客户端（`external-client-runtime.ts`）三处把取消句柄的 signal 交给队列；出队的那次任务没跑过，
  各自在队列返回的 promise 上补上「X 安装已取消」和那条 error 进度，和跑起来以后取消一样。
- 新加 CI 作业 `secret-scan`（`.github/workflows/quality.yml`，脚本 `scripts/scan-new-commits-for-secrets.cjs`），
  进 `quality-gate`，只改文档的改动也跑。用 TruffleHog 3.97.9（镜像按 digest 钉住，取出程序在 runner 上直接跑）
  只扫这次改动新加的提交。挡两类：对方平台核实过、现在还能用的密钥；和星芒 Key 一个样子的字符串
  （`sk-` 加 48～64 位字母数字，new-api rc.24 的 `GenerateKey` 发 48 位）。星芒 Key 没有平台能帮着核实，只能按样子认；
  测试里要写这种长度的假值，行末加 `trufflehog:ignore` 或中间带短横线。
- 只提示不挡：核实时对方平台出错的、私钥（没有接口可试）。只记在日志里：对方平台说是假的或没法核实的
  （多半是测试里的假值）。不打印密钥本身，也不打印核实出错的原文（里面可能带着请求地址和 Key）。
- 关掉了 TruffleHog 的 URI 检测：它「核实」时会去请求扫到的地址，我们的测试里有带假密码的 `xm.solov.cc`
  等正式地址，CI 不许对生产发请求。加规则时把全部分支的全部历史试扫过一遍：除了这类假地址（57 处，都在测试里），
  只认出一处旧分支 zip 里测试用的 TLS 私钥；星芒 Key 样子的 0 处。
- 管不到的：推上来就已经公开，这道检查只能叫人去作废、挡住合并，收不回来；合并提交里解冲突时才写进去的内容
  TruffleHog 不扫（PR 压成一个提交合进 main 后，那一轮会再扫一遍；连着合好几个时只扫最后一个）；
  不带 `sk-` 的 48 位裸串认不出。
- 按钮与设置重新规划第 1 个 PR（一、二、三部分，第六部分 1～3 条，五-51）。`registry/business.ts` 新增 `settingsItems`（每一行的 id、组、
  标题、常用说法、出现条件）与 `settingsItemLabel` / `settingsItemAvailable`：设置页行标题和顶部搜索读同一份，行 id 不许和组 value 撞名
  （`business.test.ts` 钉住），`app-check.mjs` 把注册表和设置页逐组对一遍（次序、这台电脑该有的行一行不少）。
- 新增 `features/app/row-focus.ts`（`requestRowFocus` / `useRowFocus`）：搜索结果或「企业证书」按钮跳过来时，目标页画好后按
  `data-anchor` 找那一行（最多等 2 秒），滚到正中、焦点给第一个可用控件、亮 2 秒；减少动画时改为一圈内描边。`SettingRow` /
  `ListRow` 加 `anchor`，检查页每项以检查代码作 anchor。
- `Dialog` 加 `headless`（不画标题行和关闭按钮，标题只给读屏，框顶固定在 100vh/6），只给命令面板用。
- 侧栏：「更多」「设置」移进 `.v2-sidebar-pinned`，展开状态存 `xingmang-v2-sidebar-more`；上段导航按滚动位置写 `data-fade` 渐隐，
  换页时把当前项滚进可视区；`@media (max-height: 659px)` 把导航行收到 32，这是固定 1280 版式下唯一的高度断点（规则文件已登记）。
  `AccountView.sourceLabel` 换成 `sourceTag` + `restoring: 'pending' | 'retrying'`。
- 设置页保存成功改走 `useToast`，`ResultNotice` 加 `retry`；系统状态没读到时写「暂未读到」并可「重新读取」。更新页的两个开关与设置页
  通过 App 的 `appSettings` 保持同步。e2e 业务夹具补 `ToastProvider`、`fail=platform-read`、`autoUpdate`。
- 按钮与设置重新规划第 2 个 PR（第四部分全部，第六部分第 12 条）。`.v2-root` 改为铺满窗口，`.v2-content` 左右内边距
  `max(16px, calc((100% - 1000px) / 2))`；`Shell` 用 `(max-width: 1271px)` 判窄窗口，自动收起时 `sidebar-overlay` 浮层展开、
  不写 `xingmang-v2-sidebar`。界面规范、规则文件、重建记录里「固定 1280 逻辑宽，不添加响应式断点」换成两个断点那句。
- `Drawer` 不再用 `<dialog>.showModal()`：改为 `role="dialog"` + `popover="manual"`，无遮罩、无焦点陷阱，Esc 在文档层处理（焦点在抽屉外的
  输入框里时不抢）；关闭时焦点交回最后点的那一行。抽屉在 `--v2-content-top` 与状态栏之间，footer 换行、主按钮在左。
- `Notice`：`tone` 为 bad / warn 时图标固定为 `XCircle` / `TriangleAlert`；页内不带阴影，`.v2-notification`、开机提示由外壳加阴影。
  `useOperation` 成功的字符串改走 `useToast`；兜底句改为指到「反馈」页。`ListState` 加 `query`（搜不到时「清除搜索」），`Pagination`
  加 `failed`、只有一页时不渲染。新增 `calendar-time.ts`（`formatCalendarTime`，从 `recent-display` 抽出）与 `RelativeTime`。
- 新增 `features/app/environment-status.ts`：检查结果（开机检查或检查页）写进一个模块级 store，状态栏按「待处理」项数显示环境状态；
  不加 IPC。
- `Card`：`meta` 是超过 24 个字的字符串时渲染为卡片第一行的 `.xm-card-lead`；标题 `nowrap`。卡片里的 `ListRow` / `ToolRow` / 表头
  贴边、第一行不画上边线；`.v2-page` 直接子级里相邻的卡片、提示框 `margin-top: 16px`；`.xm-card` 背景改 `--panel-solid`。
- 按钮与设置重新规划第 3 个 PR（第五部分第 1～22 条，第六部分第 6、7 条；第 4、5 条照「不点头」那一版）。`ListRow` 加 `onOpen` / `openTestId`
  （标题成为按钮、铺满整行，`actions` 里的按钮叠在上面各管各的）；`Card` 加 `defaultOpen` / `onOpenChange`；`ToolRow` 加 `menuLabel`。
- 首页：「试试第一条命令」的挑选抽成纯函数 `pickFirstRunTool`，等「最近」读完再决定（读不到当作都没用过）；「还可以装」收起记在 localStorage
  `xingmang-v2-home-available`；检测失败的工具留在「你的工具」；第一次检测用 `Skeleton`；运行环境检测中灰点，检测失败给「重新检测」。
  `electron/git-runtime.ts` 的 `gitMissingHomeNotice` 改短，检查页用的 `gitMissingNotice` 不动。
- 聊天：「重新读取」只在读成功后换上新读到的记录，读不出来期间聊的内容由 `mergeSessionIntoHistory` 并进去；有回复正在生成时不换。读不出来时照旧不往本机写。
- 记录：只有摘要的记录不去读详情（`detailAvailable` 为假时不调 `getProviderSessionDetail`），「导出」灰着；没有「接着聊」的行放一颗看不见的同尺寸按钮占位，
  后面的按钮上下对齐。
- 游戏加速：出错、冲突、加速文件坏了三种提示条挪到工作台上面；工作台不再定最小高度，地球约 140、圆环 160；主进程 `line-unreachable` 那句和教程里
  加速、记录两章的按钮名跟着改。
- 欢迎页：横版标志换成 `symbol` 64 加 `wordmark` 40，去掉 `auth-welcome-brands`；星轨改成一圈四个等距、同向公转（40s 一圈）；去掉 `min-height: 700px`，
  星轨场景随首屏高度在 380～460 之间。
- 按钮与设置重新规划第 4 个 PR（第五部分第 23～39 条，第六部分第 8 条）。外接工具、插件的「星芒精选」挪到自己的列表下面，`CuratedShelf` 卡头 meta 改成一句说明，
  去掉每行的 `curatedNetworkLabels`；`ListState` 加 `emptyTitle` / `emptyDescription`。
- 技能、插件工具条加 `${page}-reload`；外接工具「重新检测」改为先 `resource.reload()` 再检测，检测命令没跑完（`supported` 且带 `reason`）时显示
  `mcp-health-failed`。Codex 进「市场」时自动下载插件目录不再给成功提示，自己点的照旧。插件行在 `update-available` 时加 `${page}-update-${id}`。
- 技能页「看怎么放」走 `navigate('tutorial', 'skills#<补充说明标题>')`；外壳把 `#` 后面拆成教程的 `extra`，教程页只展开并翻到那一条。
- 教程：命中词用 `splitSearchHits` 包 `<mark class="v2-tutorial-hit">`，补充说明只在 `textHasSearchWord` 时展开；吸顶条按内容区（`.v2-content`）的滚动
  算读到第几步（`readingStepAt`），点圆点跳过去的那一步记下来，滚到底时最后两步也亮对；`.v2-content` 上边的留白写成 `--v2-content-padding-top`，
  吸顶条用它贴住正文顶边。
- 检查页：`sortDiagnosticsBySeverity`、`connectionRowStatus`、`sortConnectionRows` 是纯函数；`useRowFocus` 加第四个参数 `resolve`，开机提示的
  「去看看」带 `firstProblemAnchor`，设置「网络检查」带 `XINGMANG_NETWORK`，指名的是正常项时先展开正常项再翻过去。
  `connectionCheckView` 加 `section`，网络那一层落到设置的 `network` 组（检查页、备份页的「去处理」都用它）。
- 测试：`e2e/v2-business-fixture.tsx` 的扩展列表抽成 `extensionList`，每次读都记一笔 `list-extensions`；加 `mcpHealthFail` 让第一次连接检测没跑完。
- 按钮与设置重新规划第 5 个 PR（第五部分第 40～55 条，第 51 条已在第 1 个 PR 做了）。安装卸载页两张表改用 `MaintenanceRow`（`.v2-maintenance-table` 的三栏网格），
  `ToolStatusMeta` 改为读 `toolStatusView(status, statusUnknown, version, activity)` 的结果，`activity` 是 `'installing' | 'failed'`；去掉 `ToolStatusReason`。
- 安装卸载页从 App 拿 `toolJobs`（`useToolbox().jobs`），在首页点的安装这一页也画「安装中」和进度；运行环境和没接 `installTool` 时从进度事件自己记。
  首页的卸载任务带 `ToolJob.kind: 'uninstall'`，这一页不当安装画，只写「正在卸载」、按钮灰着。
  失败那一行的原因用 `resultNoticeLead(error, detail)`，和 `ResultNotice` 领头那句同一个来源。`installGuideTopic(id, platform)` 决定「查看安装步骤」「安装指南」落到哪一章，
  桌面端那章的编号是 `registry/business.ts` 的 `desktopInstallTutorialTopic`。
- 反馈页日志行是 `.v2-feedback-log` 按钮，时间用 `runtimeLogTimeText`；`ListState` 加 `errorDescription`。备份搜索用 `backupMatchesQuery`（`relativeTimeText` + `displayDate`）。
- 更新页：`updateNewVersion` 给「新版本」那一行，`updateBubbleRepeatsUpdatesPage` 决定人在更新页时哪几种气泡不弹。
- 测试：`testing/app-fixture.tsx` 加 `holdNextInstall()` / `releaseInstall()` 和 `cancelCliInstall`，能停在「装到一半」；`e2e/v2-business-fixture.tsx` 加 `manyLogs`
  （150 条、`truncated`）和两个运行环境进度事件的空实现。
- 按钮与设置重新规划第 6 个 PR（第五部分第 56～71 条，第六部分第 9、10、11 条照「不点头」）。`registry/business.ts` 的 `accountTabs` 次序改成左边子导航从上到下的次序，
  新加 `accountTabGroups`（三组，registry 测试钉着每页只在一组里出现一次）、`accountSwitchAnchor` / `accountSwitchKeywords`；
  `command-search.ts` 的个人中心组多一条「切换账号」，`App.tsx` 的 `navigate('account', accountSwitchAnchor)` 走 `requestRowFocus('account', …)`，不换分页。
- `pages-account.tsx`：账号状态、资料和余额拆成两个 `useResource`，`accountTabNeeds(tab)` 决定每页等哪一样；页头副标题 `accountHeadLead(profile)`；
  子导航 `AccountNav` 手动激活（方向键只挪焦点，回车/空格打开）。页头「刷新」经 `refreshRequest` 递给当时停着的那一页，各页用 `useRefreshRequest`（`business-common.tsx`）接；
  列表读不到统一用 `ListReadFailure`，原因那一段 `FailureReason` 和 `ResultNotice` 共用；读取中的占位条是 `PlaceholderBar`。资料、余额再读没读到时留着上次读到的那份（按账号认，换账号不沿用；先发后到的旧结果不算），
  要它的那页顶上出 `ResultNotice` 带「重新加载」；用量看板每次读都把时间范围算到当下；「我的账号」卡的登录设备台数只在刷新和「登录设备」页让设备下线后重读（`devicesChanged`）。
- 充值页把充值信息和订阅（可选订阅 + 我的订阅）拆成两次读取，再读没读到时照列表的规矩说读不到，不留着旧的；`describeTopupTier` 的 `quote` 多一个 `'unavailable'`，返回 `quoting` / `bonus`，去掉 `hasBonus`。
  `subscriptionToolsNotice` 出错时带 `action: 'health'`。`AccountFilters` 加 `primary`（第一行放哪几个框），`hiddenFilterCount` 只数收起的框里生效的条件。
  `ToolKeyLimits` 的行和「还没配」那一行由 `toolKeyLimitLayout` 算；`LocalAvatar` 加 56 号。
- 测试：`e2e/v2-business-fixture.tsx` 加 `fail=profile|tasks|orders|topup|devices`、`noPayment`、`otherDevice`、`help`；`e2e/v2-business.test.mjs` 补 15 条个人中心用例（fixture 多一个 `failNextRead` 让下一次资料或订阅读取失败、`profileReadHarness` 让下一次资料读取晚回来，并接上 `updateAccountDisplayName`），
  `keyboard.browser-check.mjs` 补顶部搜索「切换账号」落点，`app-check.mjs` 跟着「退出登录」和页头「刷新」改。
- 开发依赖 `concurrently`（只用于 `npm run dev`）带的 `shell-quote` 命中新公告 GHSA-pqg4-j6r4-53mv（critical，`>=1.8.4 <1.11.0`），而 `concurrently` 最新版 10.0.5 仍把它钉在 1.9.0，升 `concurrently` 清不掉；改在 `package.json` 的 `overrides` 把 `shell-quote` 钉到已修复的 1.12.0，lockfile 由 npm 重新生成。生产依赖不含它，客户端安装包不受影响。
- `src/renderer-v2/features/app/update-retry.ts` 的 `updateOffersDownloadPage` 把 `UPDATE_CHECK_STALLED`（`updater.ts` 的 `reportCheckFailure`，看门狗掐断挂住的检查）也算进去，更新页和首页气泡同读这一份；用的是现成的「打开下载页」按钮，没新写字。普通的检查失败（断网、解析失败等）照旧只给「重试」。
- 已知问题清单 2026-10-06 已知 14。
- AI 工作区视频的「停止」不再向服务端发 `POST /v1/videos/{id}/cancel`：new-api 没有这条路由，默认线路和直连
  （xm-direct）都回 404「Invalid URL」，服务端 2026-10-06 确认取消视频在两条线路上都不生效。以前只有 MiniMax 会发，
  失败被吞掉，客户看不出区别；现在 `ai-video-service.ts` 停止只停本机等待，任务记录照旧留着、下次启动接着取回视频，
  `ActiveVideoRequest` 也不再存 API Key 和 provider。`AiVideoCancelResult.canceled` 补了注释：只表示本机不再等，
  界面不能据此说「取消成功」。
- 星芒自己的代码里没有调用 Gemini 的 `:countTokens`（也没有 Claude 的 `/v1/messages/count_tokens`），写给 Gemini CLI
  的配置也不涉及它。Gemini CLI 0.60.0 自己调 countTokens 失败时会改用本地估算（看的是安装包代码，没实测）。
- 画布（canvas-v2）MiniMax 视频生成中那句「停止时会向服务端请求取消；生成中的任务可能需要短暂等待才进入已取消状态。」
  换成 Grok 视频现成的那句（`canvas-v2/src/nodes/WorkflowNodes.tsx`），两种视频显示同一句。yoyo 2026-10-06 回「改」，
  canvas-v2 只为这一句开例外。
- 直连适配第二步的跟进（#932 带出来的，没发过版）：「自动」走直连时，检查页「电脑里另外设过的工具地址或密钥」
  只拿直连地址去比。照旧教程设成默认线路地址的 `GOOGLE_GEMINI_BASE_URL` 在 Windows、Linux 被报「待处理」，
  Windows 还给「删掉这几项设置」，开机提示也数它；`ANTHROPIC_BASE_URL` 从「通过」变成「需留意」。现在这会儿用的
  那条线路一直算指向当前账号，选「自动」时默认线路也一直算（`diagnostics.ts` 的 `environmentAccountBaseUrls`）。
  检查页、一键删除（`main.ts`）、Mac 终端设置文件那一路（#934）用的是同一套判法。
- 没放宽的两种：「自动」已经退回默认线路时，指着直连的照旧报，因为直连这会儿在这台电脑上连不上；写死「只用直连」的
  照旧报默认线路的地址，同 #872，因为多半是默认线路在他那儿不通才这么选。
- 已知48「帮我清理」：新增 IPC `cli:clean-uninstall-leftovers`，只收工具名。卸载走到 manual-required 时，新模块 `uninstall-leftovers.ts`
  的 `captureUninstallLeftovers` 当场把手动命令里那几个文件记在主进程（所在目录的 dev/ino/mode/uid，文件的 dev/ino/mode/uid/gid/nlink/
  大小/mtime/birthtime，链接另记链接内容），记住了才给 `manualHelp.cleanUpAvailable`；硬链接、目录、别的账户的文件、经链接到达的目录、
  Windows 上的链接一开始就不记。点了以后 `removeUninstallLeftovers` 只删记下的那几个，删前再核一遍：目录换了或文件改了不删，同名已换成
  别的文件当作已删、不碰，重装后命令又指回它的程序文件不删（Grok 的 npm 安装脚本见到同版本 grok-<版本> 就沿用、只把链接指回去）；
  删不掉的留在记录里等下一次，返回还剩几个。
- Mac 上卸 Grok 原来只删命令入口，改名后的链接和程序文件一律交给客户手动删。yoyo 2026-10-06 打字同意「Mac 也帮我清理」后，
  「帮我清理」在 Mac 上也删这些，但只在 `isDarwinForeignWritablePath` 判定除 root 和当前用户外没人能改的目录里删（记录时、删前各查一次）。
  Windows、Linux 删的就是各自卸载本来就会删的那几个文件，没有放宽。
- `system-service.ts`：清理排安装卸载同一个队（key `cli:clean-leftovers:<工具>`），下一次卸这个工具时或清干净后丢掉记录；有删不掉或
  重装后在用的记 `cli.uninstall-leftovers.cleaned`（路径脱敏）。`DarwinGrokRetainedPathsError` 带上 `retainedPaths`。
- 界面：`ManualUninstall.tsx` 的标题、说明、「帮我清理」按钮、「清理好了。」与没删干净的红字照 yoyo 批的字，没有命令时的框不变；
  首页和安装卸载页都接上。`app-check.mjs` 加两条（点一次剩一个出红字，再点删干净关框），`uninstall-leftovers.test.ts` 与
  `system-service.test.ts` 钉住核对规则，`ipc.test.ts` 钉住新通道不收界面带来的路径。
- 已知29：`registry/errors.ts` 加 `configPermission`；`operation-error.ts` 的分类、`presentOperationError` /
  `presentOperationFailure` 多收一个可选的 `target: 'config'`，只把 `permission` 换成它（文件被占用、搬过的文件夹、
  磁盘满不动）。接上的地方：App `perform` 按动作名（`operationTargetOf`：改用当前账号、切回官方账号、重新写入 Key、
  修提醒设置、重置为初始状态）、配置窗口红字、扩展页（除「安装 Python」）、备份页恢复和密钥页「配置到工具」
  （`useOperation` 新增 `failed` 记下是哪个动作失败的）、`keySyncFailureReason`（首页「账号 Key」那行、
  切换账号后没同步的工具）。
- 已知29（新手引导）：`StartGuide.tsx` 的 `guideStepFailure` 按动作名（`operationTargetOf`）分类，`configPermission`
  单独一句，把目录里的「重试」「找客服」换成引导里的「再试一次」「复制给客服」（没有复制按钮时是「需要帮助」）；
  `guideFailureExits` 不传 target，出口照旧是「查看日志」。浏览器夹具加 `switchDenied`。
- 已知30：`diagnostics.ts` 的 `withAppProxyRoute` 多收一个 `siteDirect`（宿主经新依赖 `siteDirectActive` 交
  `proxyBypass.siteDirect()`），系统代理开着或在别的机器上、且连星芒的请求已改走直连会话时换说法、这半不再标黄；
  代理没开的那种、另外设过代理的那半照旧。`platform/system-service.ts` 的 `describeSessionProxy` 多收一个
  `siteDirect`，经 `proxy-bypass-bridge.ts` 新增的 `proxySiteDirectActive` 接到 main.ts。
- 已知31：main.ts 把退出时问「还在安装」的框抽成 `confirmInterruptingInstall`，退出和新的 `confirmUpdateInstall`
  共用（字一个不改）。IPC `update:install` 多收一个可选参数 `UpdateInstallOptions`，带 `askIfInstalling: true`
  时先问它（新的可选依赖 `confirmUpdateInstall`），客户点「继续安装」就回 `{ accepted: true, postponed: true }`、
  不调 `updaterService.install()`；托盘「重启并安装」在主进程里走同一句。只有更新页「确认重启安装」带这个参数：
  「必须更新」那层提示和旧回滚界面不带，照旧直接装（那层提示拿到 `postponed` 会一直转圈）。契约多一个可选的
  `postponed`，旧回滚界面照旧能编译、行为不变。更新页拿到 `postponed` 时只关确认框、不出「安装请求已提交」。
- 已知32：`App.tsx` 的 `requestUninstall` 记下主进程回的是不是 `uninstalled`；是的话紧接着的 `toolbox.refresh(true)`
  没读到只出 warn 提示、不往外抛，确认框照常关。`delegated`（以管理员身份运行时交给命令窗口）、`manual-required`、
  `not-installed` 照旧当没做完。首页顶上检测自己的那句「检测没有完成，请重试。」照旧。
- 已知33：`windows-elevation.ts` 抽出纯函数 `buildUnelevatedCommandScript`，.cmd 改按 UTF-8（不带 BOM）写，
  第二行用固定解析出来的 `System32\chcp.com` 把窗口代码页换成 65001，之后的中文行按 UTF-8 解；说明文字拒绝
  引号、百分号、&|<>^、半角括号、换行，命令行照旧只许 ASCII。`UnelevatedCommandWindowRequest` 的 `title`
  换成 `text`（标题、开头、成功、失败四句）。要在 Windows 真机上看中文不乱码，看不对就退回英文那版。
- 已知34：`electron-builder.config.cjs` 的 `mac.extendInfo` 加五项隐私说明（`NSDocumentsFolderUsageDescription`、
  `NSDesktopFolderUsageDescription`、`NSDownloadsFolderUsageDescription`、`NSRemovableVolumesUsageDescription`、
  `NSNetworkVolumesUsageDescription`），`scripts/macos-build-config.test.cjs` 钉住各种打包方式都带。要 Mac 真机看。
- 已知35：`cli-keep-awake.ts` 加 `tools()`、`install-keep-awake.ts` 加 `reasons()`，两边都只在真挡着时有内容（挡不上、挡满两小时交还系统后为空），
  变了才回调 `onChange` 刷新托盘；`application-tray.ts` 的 `trayKeepAwakeLabel` 按「终端里的工具 → 安装 → 下载星芒新版本」只挑一句，
  菜单里是紧跟「打开」的置灰项，提示文字放最后。Codex 自己挡睡眠，不出这一行。
- 已知36：`diagnostics.ts` 新增 `HOME_FOLDER_LEFTOVERS`（`homeFolderLeftoversOutcome`）。说明那半按内容认：
  `project-instructions.ts` 的 `PUBLISHED_PROJECT_INSTRUCTIONS_DIGESTS` 记每一版发出去过的模板摘要（换行统一后 sha256），
  以后改模板要把新摘要加进去、旧的不删，测试钉住当前随包模板在表里。信任那半由 `config-files.ts` 的
  `inspectHomeFolderTrust` 只读三家（Claude Code `~/.claude.json`、Codex `config.toml`、Gemini CLI `trustedFolders.json`，
  Gemini 的 `TRUST_PARENT` 落在个人文件夹上也算），读不懂的当没记着。一键处理 `set-aside-home-agents-md`
  （`diagnostic-fixes.ts`）点下去时再认一遍内容，改名成 `AGENTS.md.xingmang-<时间>.bak`，不覆盖旧备份。
- 已知40：`Home.tsx` 的 `startsFresh`（会打开目录的 CLI、最近记录已读到且整份记录里这个工具一条都没有
  （`stats.byProvider`，不只看首页取的那 60 条）、也没记住的目录）时「打开」走 `onLaunchInNewFolder(tool, true)`，
  「⋯」里的新建入口换成 `chooseWorkspaceLabel`；记录还没读到时照旧弹选择框。`ChooseWorkspaceOptions` 加 `firstOpen`：
  `workspace:choose` 先用主进程记着、还在的文件夹（上次建好了却没打开成，再点「打开」或「重试」不建 my-project-2），
  没有才新建，建不成说完接着走 `pickWorkspace`。`App.tsx` 的 `launch` / `requestLaunch` 把 `newFolder` 布尔换成
  `LaunchFolder`（`choose` / `create` / `firstOpen`）。托盘、Ctrl+1～5、引导里的打开不变。
- `src/renderer-v2/business-common.tsx` 的 `userFacingErrorMessage`：脱路径以前到第一个空格就停，
  `C:\Users\Zhang San\.claude\settings.json` 上屏成 `本地配置文件 San\.claude\settings.json`（I13）。
  现在空格后面还有分隔符就接着算路径；文件夹名里不收 Windows 禁用的文件名字符、引号和断句标点，
  吞不进后面的句子和下一个带引号的路径；最后一节照旧到空格为止。只在原来的基础上多换、不少换。
  旧回滚界面 `src/error-message.ts` 已冻结，没动。
- preload 的 `downloadUpdate` 一直是 `() => invoke('downloadUpdate')`，把 `{ ignoreDiskSpace: true }` 丢在了沙箱这一侧
  （#839 起），主进程收不到，照旧查磁盘、照旧拦下。改成和别的带可选参数的桥一样：有参数才转，不加空的尾参数；
  `preload.test.ts` 钉住。顺手核了一遍：现在每个桥函数的参数个数都不少于契约。

## 0.2.15 - 2026-10-04

- 第二十六批 D：`src/renderer-v2/business-common.tsx` 新增 `detectionFailureMessage`，把探针给的英文原话归成四句中文
  （EPERM/EACCES、EBUSY、ENOENT、其他），原话本来是中文的照旧脱敏后显示。判中文之前先剥掉脱敏占位词「本地配置文件」、
  引号段和路径片段，免得英文原话因为占位词或中文用户名被当成中文。首页工具行、安装卸载页、外部客户端行三处换用它。
- `electron/ipc.ts`：`system:scan` 与 `external-clients:scan` 每次扫完，对检测失败的工具各记一条 warn
  （`runtime` / `cli` / `desktop` / `external-client` 的 `.detection-failed`，原话过 `redactHomeDirectory`），
  英文原因只进运行日志和反馈报告。走缓存的扫描不重复记。
- 第二十六批 E：`ToolTemplateFillResult` 加可选 `pending`：工具可能开着、这次没补的；Codex 型号名单没按账号核对也记在
  codex 头上。`config:fill-template-defaults` 收可选 `retry`：主进程按账号记下开机那轮欠下的，retry 只补那几样，
  换了账号就什么都不做。型号名单「这次动不动」改为在本机看完再交回结果，按账号核对照旧放后台；不是当前账号写的 Codex
  配置不再为型号名单起进程看它开没开。补做那几次的日志带 `retry: true`，型号名单补做记 `codex-model-catalog.sync-resumed`。
- 渲染层 `features/app/template-fill-retry.ts`：有 pending 时每 10 分钟、或窗口回到前台（离上一次至少 2 分钟）带 retry
  再要一次，补上、不欠了、换账号或满 6 次（约一小时）就停。真补上了照旧出「已把工具设置补齐到最新」，现在可能在用着时出现。
- 打包器复用 Electron 43 已采用的 `@electron/get 5.0.0`，移除构建依赖中的旧 `got`、`cacheable-request` 和受 GHSA-ch52-4w7c-c8xp 影响的 `http-cache-semantics` 链；保持 npm 官方源、SHA-512 锁定和零漏洞审计门槛。
- 固定 `electron-builder 26.15.3`，根据上游迁移补充构建下载的十分钟截止时间、标准代理/TLS 校验和服务端/临时网络错误重试；安装时核对原模块 SHA-256，未知源码或版本拒绝应用兼容补丁。
- 本次只调整构建下载依赖，不改变 Electron 版本或客户端运行时依赖；验证包含依赖审计、编译和打包器兼容性。
- CI：Electron 43 的 npm 包没有安装脚本，`npm ci` 不下二进制，要等第一个 `require('electron')` 的测试现场去下，只发一次请求、
  不重试也不限时，网络一抖那个测试就带着「Electron failed to install correctly」红掉（#319 的 Windows vitest-1 撞上 GitHub
  两次 HTTP 500，#796 的 linux-test 撞上 `fetch failed`）。现在用到二进制的作业在 `npm ci` 之后先跑
  `scripts/ci-ensure-electron-binary.cjs`：每次限时 3 分钟，失败隔 10、30、60、120 秒再试，五次都不行才报中文错误；
  重试成功也会在运行摘要里留一条警告。`quality` 里按系统、架构和 Electron 版本缓存下载包，命中时不连 GitHub（本地演练约 2 秒装好）；
  缓存的是 @electron/get 自己的默认下载目录：`windows-package`、`macos-test` 后面打包时，electron-builder 照旧从这个目录拿同一份
  zip，不用再下一遍。
  只有推送到 main 的那轮在下载后立刻写缓存，PR 不各存一份。三个出包工作流（发布、测试包、已停用的签名构建）也加了这一步，不用缓存。
  只给真用得到的作业加：Windows 只有两个 vitest 分片，其余四个分片和 Linux 浏览器作业实测不碰二进制，不多花解压时间。
  `scripts/ci-ensure-electron-binary.test.cjs` 钉住重试节奏、最坏耗时在步骤时限内，以及「哪些作业装、装在哪一步、缓存怎么配」。
- CI：`quality` 工作流的 `linux-test` 原先把 typecheck、`npm test`、`test:v2`、`test:ui` 等一路排队跑完，约 21 分钟，
  是整条流水线最慢的一项（第二慢的 Windows 浏览器分片约 16～17 分钟）。`test:v2` 的夹具浏览器套件（`test:v2:browser:fixture`，
  约 12 分钟）改到新作业 `linux-renderer-v2-browser` 与它同时跑，切法与 Windows 分片相同、不再往细拆（共用同一份
  Vite 依赖预构建缓存）；`linux-test` 改跑 `test:v2:vitest` 与 `test:v2:browser:e2e`。一项检查没少、也没重复跑，
  新作业已进 `quality-gate`。`scripts/ci-workflow-config.test.cjs` 钉住两个作业合起来正好等于 `npm run test:v2`。
- CI：合进 main 后的那轮 `quality` 先在 `changes` 作业里停 10 分钟再开跑。原先每合一条就整套开跑，几分钟后下一条合进来又把它顶掉
  （截至 10-3 的三天里 main 上 104 轮有 65 轮这样跑一半作废），白占十几台机器、其中两台 Mac，让开着的 PR 排队。现在连着合几条只取消
  这一个在等的作业，整套只为最后一条跑一次；PR 上的检查不等。推送到 main 的那轮一律跑全套代码检查，不再按「只改了文档」跳过：
  它要替被顶掉的那几轮一起把关，而推送事件只给出最后一条合并的改动（`scripts/ci-change-scope.cjs`）。
  `scripts/ci-workflow-config.test.cjs` 钉住只有推送才等、等待排在最前、作业时限留够、只有这一处 sleep。
- `acceleration-development-backend.ts`：不计时的会话（打开 Codex 桌面端时自动连的）停下时照旧先还原系统代理，
  但内核不马上停，端口记成下载线路、单独握一份收尾持有（`drainHeld`，不进 `downloadHolders`），
  `automaticSessionDrainMs`（10 分钟）后才停。#772 起用星芒 Key 的约两分钟就断，第一次提问的 `/responses`
  流式返回很可能还走在本机端口上；沙箱里用 Codex 0.159 演过，代理端口一断它就报
  `error decoding response body`、显示重新连接并重发整次请求。新请求按还原后的系统代理直连，不受影响。
  用户自己点的、计时的会话停下时照旧马上停内核。
- 收尾期间：同一条线路再连（后台或用户自己点）直接接管内核、不重起，收尾就此结束（放在建会话之后，
  账本写入失败时收尾照旧到点停内核）；换线路照旧重起；下载临时加速共用内核，两边都放手才停；
  检测线路时只剩收尾握着内核就让路；内核自己退出、退出软件时一并作废；辅助进程不算空闲。
  到点时内核停不掉就记 `core-stop`、五秒后再试，和会话停不掉时一样。
- COS 大型不可变安装包增加默认关闭的受限并发分块上传，保留原小文件和 latest 指针上传流程、源文件信任校验及完整公共回读；未知合并结果不盲重试，需先现场确认最小权限再启用。
- 官方 ChatGPT 八个平台改为串行独立同步作业，各自校验后累计发布索引，避免全部大包共用一次 90 分钟作业；失败可精确平台恢复，整体成功要求所选作业全部通过。
- Claude 桌面备用包、不可变候选清单和 latest 指针统一保存在 `xingmang/offline/claude/`，沿用已授权的 `xingmang/*`；示例 CAM 策略保持原有两个前缀，不扩大云权限。
- COS 可覆盖对象仍只允许三个固定 latest 指针，拒绝旧 `claude/latest.json` 和其它备用目录；星芒正式发版目录及正常安装方式不变。
- 使用官方客户端正常匿名 Mac 更新协议获取发布信息，严格验证独立 DMG/PKG 候选；不处理下载入口的人机验证，不借用 ZIP 摘要校验另一格式的文件。
- 修正官方签名主体格式及 PKG 包壳版本误判，固定 Apple 链、Team、应用身份和原生双架构检查；发布前重读来源，补齐有界脱敏阶段诊断及未知 latest 写入确认。
- Claude 官方下载入口改用有界匿名 GET 响应头探测，收到响应头即销毁正文，静态完整包仍以 HEAD 校验大小与 ETag；修复 Windows 入口不支持 HEAD 而返回 405 的兼容问题。
- 重定向数量、固定主机及路径、无查询参数、完整下载摘要和原生签名校验保持原有边界；Mac 入口 403 仍是待验证限制，不省略 Mac 同步目标。
- 官方 Codex 备用包同步增加脱敏阶段、字节进度和白名单网络失败分类，分别保留 PUT 与公共回读原因，清理错误不再覆盖主错误。
- 手动入口支持平台分组及精确平台恢复，保留已有平台合并规则与最终八包两许可目标；发布最新索引前重新核对可变官方来源快照。
- COS 分块上传诊断补齐 UserNetworkTooSlow、请求体长度和格式等官方上传错误码；无法提取 Code 时保留固定读取/解析原因、最多 4 KiB 的字节计数和固定内容类型分类，不输出未知错误码、服务端正文或认证信息。
- 保持原超时、正文限制及分块重试集合，新增可识别错误码只用于诊断，不自动重试。
- 星芒正式安装包导入和发布同步补齐白名单阶段诊断，保留底层安全错误分类和最新指针写入状态；临时目录清理失败不再覆盖原始同步错误，已发布后清理失败明确报告已完成回读。
- COS 分块上传的单块响应头等待上限从三分钟调为六分钟，总分块调度上限从三十分钟调为七十五分钟，容纳已观察到的慢速大包上传；保留更短调用方超时、逐请求三十分钟签名、单次 PUT 预算、完整回读及不自动重试的失败边界，作业仍限九十分钟。
- 依据真实同步日志，仅将分块 PUT 的 EPIPE 和已安全识别的 HTTP 400 UserNetworkTooSlow 纳入现有最多额外两次重试；复用同一已校验分块与会话，保持 1 MiB、并发、截止和非分块写入的原边界。
- 官方 Codex、Claude 桌面备用包的定时、默认和 all 同步收窄为 Windows/macOS，保留历史 Linux 索引与对象兼容；Claude 支持按 Windows 架构或 Mac DMG/PKG 单项恢复。
- COS 分块上传仅对明确超时的同一分块最多额外重试两次，复用已校验内容并保留总期限、并发收拢及 Complete 未确认后的完整回读边界。
- 对可信 COS 分块 HTTP 错误以 4 KiB、5 秒上限提取白名单错误码，区分 RequestTimeout 与 BadDigest 等错误，保留 HTTP 状态且不记录错误正文或认证数据。
- 新增可选的腾讯云 COS 分发同步：星芒正式发布后显式同步完整发布产物，Codex 和 Claude 官方安装包通过独立定时及手动流程同步；凭据仅在受限部署环境内使用。
- 新增首次导入已发布星芒安装包的受限工作流，仅接受正式 GitHub Release 的真实安装包并核对大小及 SHA-256；正常发版仍校验完整发布产物。
- Claude 备用包在对应原生 runner 上核对版本、架构和适用签名；三个平台串行维护公开索引，Linux DEB 同时核对官方 APT 大小、摘要及包头。
- 同步前后校验文件身份、版本、内容哈希和下载类型，保存不可变版本目录并在完整公开读回后更新索引；Windows 官方 MSIX 额外验证系统签名，提供仅授权指定桶前缀的 CAM 配置说明。
- 新版学习空间的下载入口由独立教程仓库接入同一份 COS 索引；客户端继续按完整 URL 白名单打开该入口。
- 补齐下载代理测试对宿主 CLI 安装探测的隔离，保留原断言；下载页发布脚本测试通过私有输出流保留并核对日志，避免中文输出污染 Node 测试运行器。
- COS 大包分块由 4 MiB 缩至 1 MiB，维持 2 GiB 文件、并发和时间上限，减少断连后需要重发的单块内容；最大 2048 块的合并请求独立于响应大小限制验证。
- 仅将已确认的私有分块 PUT ECONNRESET 纳入现有最多额外两次重试；继续复用同一已校验内容与上传会话，普通写入、未知 HTTP 错误和 Complete 不扩大重试。
- 反馈报告附的最近 600 条日志不再被刷屏（第二十六批 B）。两份真机报告里，Windows 那份有 505 条是下载更新时
  每秒一条的「主程序更新状态：downloading」，Mac 那份有 508 条是公告、公告已读同步、订阅三个轮询的「完成」行，
  更早发生的事反倒被挤出了报告。
- 更新状态那条日志（`electron/update-state-log.ts`，由 `main.ts` 的 `broadcastUpdate` 调用）：只在阶段、找到的版本、
  错误、失败步骤变了，或下载进度过了一档 10% 时记；下载中那条带整数 `percent`。一次下载从五百多条变成十来条，
  界面照常收到每一份快照。
- `electron/ipc.ts`：`account:get-notice`、`account:sync-local-notice-reads`、`account:get-subscription-self` 成功改记调试级
  （照样写进本机日志文件，只是报告不附）。耗时 3 秒以上的、上一次失败之后的第一次成功照记 info，后者带
  `recovered: true`；失败照旧记 error。
- `electron/runtime-log.ts`：日志摘要另留一段只含调试级以外的尾部（`nonDebugEntries`，同样最多 2000 条），
  反馈报告从这里取。以前从全部级别的最近 2000 条里再筛掉调试级，调试级一多，报告就附不满 600 条。
- 反馈报告「最近一次自检」那段两份真机报告都是空的（第二十六批 C）：检查结果只在主进程内存里，客户导出前
  看不到任何提醒。`runtime-logs:preview-feedback` 的结果多带 `selfChecked`（`FeedbackReportPreview`，可选，
  缺省不提醒），由 `diagnosticsService.hasSelfCheckResult` 按 `feedback-self-check.ts` 的 `hasFeedbackSelfCheck`
  判断，与报告里写不写「还没做过自检」同一个口径；过期重生成的预览同样带上。为 false 时预览弹窗在报告上面
  显示提示和「去检查」（`feedback-report-unchecked` / `feedback-report-go-check`）。生成报告照旧不重跑检查。
- 报告里给客服的那句改成「打开「检查」页，等它查完再导出」：新界面的检查页一打开就自动查，页上叫
  「开始检查」的只有要花额度的「Codex 干活检查」。
- `src/renderer-v2/business-common.tsx` 的 `ipcPrefixPattern` 剥 Electron 加在通道名后面的错误类名时，
  不再只认 `…Error` 结尾：主进程 `CodexDesktopInstallFailure` 的类名以前跟着中文原因一起上屏。
  每层只剥一个类名，原话开头的 `EPERM:`、`Error [ERR_TLS_*]:` 这类错误码照旧留给错误分类；
  冒号后面必须有空格，没带类名、直接以 `C:\Users\…` 开头的原话不会被削掉盘符而躲过路径脱敏。
- `runtimeStageFailureMessage` 改收原始错误，先过 `rawErrorMessage` 再拼句：以前 `App.tsx` 把
  `cause.message` 拼进句子中间，「Error invoking remote method 'runtime:install-node': Error:」
  留在错误框和「给客服看的原话」里。
- 另两个不以 Error 结尾的类名（`download-retry.ts` 的 `ResumeRefused`、`ai-chat-service.ts` 的
  `StreamFailure`）核过不会作为 IPC 拒绝到达界面，规则放宽后即使到达也会被剥掉。
- `macos-desktop-app-installer.ts` 收录 Claude Desktop（Squirrel.Mac 更新接口，带随机 device_id
  与真实 os_version，只认当前版本的通用 zip，下载后核对版本信息里的大小与 SHA-256）和 Codex 桌面端
  （ChatGPT.app，Sparkle appcast，跳过增量包，挑系统够得上的最新构建，按 enclosure 的 length
  核大小）。两家都按团队号钉签名要求（Q6L2SF6YDW / 2DC432GLL2）再过 Gatekeeper，2026-10-03 在
  GitHub macOS 26 runner 上实际下载核对过。「应用程序」里是旧版 com.openai.chat 的 ChatGPT 时
  换一句话说，仍不覆盖。
- `codex-desktop-service.ts` 的 macOS 安装改调同一个安装器（走下载线路、可取消、root 下不装、
  x64 版跑在 Rosetta 下装 arm64 包），失败句用 Mac 那套，不再套 Windows 的「去微软商店装」。
  `platform-capabilities.ts` 里 Mac 两种芯片的 `codexDesktop.install` 改为 `managed`。
- legacy 回滚版读的是同一个能力位：回滚到它时，Mac 上的新手引导会像 Windows 那样代装桌面端。
  legacy 代码没动；三条拿 `darwin arm64` 当「客户自己装」例子的旧用例改用认不出的芯片
  （`darwin ia32`）来演，断言不变（同 #761 的做法）。
- 第二十九批 A：`App.tsx` 的 `requestLaunch` 碰上 Codex 桌面端已在运行时，改由 `features/tools/codex-desktop-open.ts` 判断要不要弹
  「Codex 已在运行」，只有 Windows 弹。Mac 主进程一律拒绝 `restart`（`codex-desktop-service.ts`），框里只有「打开窗口」走得通，
  所以直接走 `open`（菜单栏和快捷键走的是同一条路）。`locale-status.ts`、`ConfigDialog.tsx`、`running-tools.ts`
  （`codexDesktopRunning === true && !canRestartCodexDesktop`）按 Mac 换成「Command + Q 完全退出再打开」的说法，Windows 文案不变；
  教程两个系统共用一份，三处各在句尾补半句给 Mac。`account-bound-launch.browser-check.mjs` 钉住 Windows 照旧弹框、Mac 不弹且只发一次 `open`。
- 第二十九批 B：`pages-account.tsx` 订单页的支付方式也走 `paymentMethodLabel`（#722 当时只改了充值页），任务详情的状态用和列表同一张 `taskStates`。
- 第二十九批 A 的同一个原因：`system-service.ts` 的 `trustCodexWorkspaceForService` 写完信任后只在 Windows 上替人重启 Codex 桌面端。
  Mac 主进程一律拒绝 `restart`（`codex-desktop-service.ts`），原来信任已经写进去了却抛出这句报错。
  `system-service.locale.test.ts` 钉住 Windows 照旧重启、Mac 不再请求重启。
- `electron/window-lifecycle.ts`：`installDownloadedUpdate` 可以返回 Promise，`runQuit` 先 `hide()` 再等它落定，
  最多 20 秒，然后照常 `quit()`；安装器自己接手退出（will-quit 里 dispose）时不再叫第二遍。新增 `noteSystemPowerOff()`：
  关机、重启、注销时不等，免得系统说本程序取消了关机。
- `electron/main.ts`：只在 darwin 上返回 `waitForUpdateInstallFailure(updaterService)`（`quit-blocking-tasks.ts`），
  交出去前先放掉画布、支付窗口并 `app.hide()`；安装看门狗的 `UPDATE_INSTALL_LAUNCH_TIMEOUT` 不算落定（慢的 Mac 还在验签）。
  `powerMonitor` 的 `'shutdown'` 接到 `noteSystemPowerOff()`。
  以前退出路径把更新交给 electron-updater 的 `MacUpdater.quitAndInstall()` 后马上 `app.quit()`，而 Squirrel.Mac 要在
  本进程里从本机代理取包、解压、验签（10-2 真机日志约 1 秒）才自己退出重开，推测进程先退就什么也没装上。
  Windows、Linux 的安装器是独立进程，不变。真机还没核，步骤见 `/mnt/project-files/0.2.15-真机新增/`。
- `electron/updater.ts` 的 `safeError`：darwin 上认出 Squirrel.Mac 的「Code signature … did not pass validation」
  （含系统中英文原因），给单独的错误代码 `UPDATE_SIGNATURE_REJECTED` 和中文正文，原话只进 `detail`。以前这句夹着
  macOS 的中文原因，`describeUnrecognizedUpdateFailure` 把它当成本来就是中文整句上屏，路径还被打码成「本地配置文件」。
- 渲染层 `features/app/update-retry.ts` 的 `updateNeedsManualReinstall` 按这个代码把更新页失败卡与首页气泡的主按钮
  换成「打开下载页」（`appReleaseDownloadUrl`），更新页卡片头的「重启安装」与「必须更新」那道门的「重新安装」也去掉。
  验签失败对这次安装是终局：同一个包每次重试结果一样。
- 已知没覆盖：「自动更新」开着时，退出时自动装被拒，下次打开仍先显示「上次没装上…点「重新安装」」，点一次后才换成这句；
  要在 pending-update 记录里带上失败原因，留作后续。
- `electron/ipc.ts`：`update:install` 成功日志改为「已把新版本交给安装程序，装没装上看下一条更新状态」，
  不再写「主程序更新安装完成」，免得反馈报告里先「完成」后失败。
- `publish-release` 改成一开始就把这一版的 tag 占在要出包的 commit 上（新的第一个作业 `release-tag`：先判断、再用 API 建，出包作业都等它；它拿着写权限，所以不装任何依赖），收尾建 GitHub Release 时不再传 `--target`。原因：`GITHUB_TOKEN` 拿不到 `workflows` 权限，出包之后 main 只要合进改 `.github/workflows` 的提交，GitHub 就拒绝它在出包的 commit 上建 tag 和 Release，0.2.14 的收尾因此两次 HTTP 403，只能手工补。
- 这个版本号已经从别的 commit 发过、线上清单已经比它高、或者在撤回名单里，`release-tag` 就停下，不再等一个多小时出完包才发现；上一次触发占了 tag、没发出去就取消的，重新触发会把 tag 挪到新的 commit 上（`scripts/release-tag-plan.cjs`）。出包期间 tag 被删了，上传前那道关检查都过了以后先补建再传，补建不了就停下、线上不动。
- `scripts/update-release-utils.cjs` 改成用到时才加载 `yaml`，不装依赖的 `release-tag` 也能用它算更新地址、比版本号。
- 第二十七批 B：`src/renderer-v2/features/tools/Home.tsx` 运行环境卡按「有没有在用的命令行工具」决定 Node.js 那行
  是不是可选。装了、正在装（装工具时会顺带准备 Node.js，那时要看见弹授权窗口那句）、这次没查出来装没装（A4）都算在用；
  Codex 桌面端不算。一个都不在用时 Node.js 行和 Python、Git 一样灰点「可选 · 未装」，Windows 管理员授权那段、
  Mac/Linux「还没有 Node.js」那段用 `.v2-runtime-hint.is-quiet` 灰字。`home-runtime-git-hint` 只在 Claude Code
  在用时出（插件市场、技能和插件里的命令都是 Claude Code 的事），按钮都不变。
- `elevation-notice.ts` 新增 `homeNodeElevationNotice` 给首页用：在用时说「准备 Node.js 时」会弹窗（首页按钮叫
  「准备 Node.js」，装工具时顺带准备的那次客户点的是工具行的「安装」），不在用时先说一般不用单独点。
  「安装卸载」页的 `elevatedInstallNotice` 不变，那里的按钮就叫「安装」。
- 第二十七批 D：`electron/codex-desktop-service.ts` 打开 Codex 桌面端的等待阶段加 `switching-language`：找到 Codex
  进程、开始换中文（等调试端口、核对端口归属）之前切过去，心跳那句改成「Codex 桌面端已经打开，正在把它的界面换成中文，
  已经等了 N 秒。」，不再满 20 秒就加「可以先去开始菜单看看」。只有 Windows、选了中文界面时走到。
- 第二十七批 C：#741 起账号请求经系统代理超时、连接被断一次，`proxy-bypass.ts` 就把整个 defaultSession 改直连到重启，装工具
  （npm 子进程代理按 defaultSession 的 `resolveProxy` 取）、拉插件市场、检查页「网络位置」都跟着丢了代理。现在只有「代理本身连不上」
  （`proxy` 那一类）才整个改直连（#578、#741 原本要救的情形，不变）；`timeout`、`refused` 先在新的内存分区 `xingmang-site-direct`
  （只设 direct，不落盘）上探 `/api/status`，通了就只让发往星芒站点（同一个 origin）的请求走它，defaultSession 一行不动。
- 走哪条路由 `createSiteFetch` 按请求的 origin 决定：账号客户端和 `relayFetch`（AI 聊天、画图、视频、连通检查、查模型都用它）都换成它，
  它们连的是同一个站点（`site-runtime.ts` 要求 AI 路由与账号同 origin），所以跟着一起改直连；视频下载等别的地址照旧走 defaultSession。
  改直连的是出问题的账号客户端连的那个站点，不一定是当前选中的。main.ts 的接线收在 `createSiteRouting`，带单测。
- 直连那一路在拿到回话之前失败就交还给系统代理；AI 请求被调用方自己中止（点「停止」、关窗口）不算，账号请求的中止只有 10 秒超时，算。
  失败的那个请求随即再探一次，通了照样重发；探不通时站点这一路 1 分钟后再探（`siteProbeBackoffMs`），整个改直连仍是 5 分钟冷却。
  每一轮改直连带编号，上一轮迟到的失败不会把刚探通的这一轮交还掉。
- 站点改直连期间，站点请求不再经过系统代理，代理软件后来关了、崩了就没人发现：每 5 分钟借一次站点请求的时机经默认会话探一下，
  代理本身连不上了就照 #578 整个改直连。已经在试整个改直连时，同一时刻超时的请求等它试完再决定重不重发。
- 不加界面文字。设置「网络连接」那一行看的是默认会话：站点单独改直连时照旧写「通过转发连接」，「本次已自动绕开」只在整个改直连时出现。
- 第二十七批 A：electron-updater 6.8.9 自带的 60 秒超时在 Electron 里从来不生效（builder-util-runtime 把它挂在
  请求的 `socket` 事件上，Electron 的 net 请求不发这个事件），下载中途断网、代理不转发时就一直挂着，不报错也不重试。
- 新模块 `electron/update-request-guard.ts`，`main.ts` 用它包住 electron-updater 的 `httpExecutor.createRequest`：
  记下更新请求最近一次收到响应头或数据的时间；停住时让还开着的请求像断网一样以错误收场，再 `abort()` 放掉连接。
  增量下载（只下改了的那几段）不认取消令牌，靠它才停得下来。它还给每个响应挂一个空的 `error` 监听：electron-updater
  多段增量下载的那个响应没挂，连接中途断开就成了没人接的异常，`main.ts` 当主进程意外出错退出再重开（沙箱 Electron
  43.6.0 实测，HTTP/1.1、HTTP/2 都会）。electron-updater 没读就拒掉的响应（几段一起要却回了 200 整个文件、
  Content-Type 不对、HTTP 出错）不去读它：Electron 只在有人读时才往下收，读了就会在它改下整包的同时把被拒的
  那份整个安装包也下完。
- `electron/updater.ts` 的 `downloadWatched`：electron-updater 的进度和宿主看到的字节（`downloadReceivedAt`）都算动静。
  还在传时 `updateDownloadStallMs`（45 秒，与 `download-retry.ts` 同一个数）、进度到过 100% 以后
  `updateDownloadSettleMs`（180 秒：签名核对、改名重试都不报进度）没动静就算停住：取消令牌，经
  `abortDownloadRequests` 掐断请求，照代理连不上那条路换直连重下一次整个安装包（`disableDifferentialDownload`）；
  再停住就报 `UPDATE_DOWNLOAD_STALLED`，正文沿用更新那张表里「超时」那句，`failedStep` 为 `download`。
- 掐断以后 10 秒没收尾、期间也没再来数据才不再等它（`unsettled: true`，不自动重下，再下 electron-updater 只会交回
  同一次）；机器睡醒、时钟往前或往回跳都从那一刻重新计时。被放弃的那次之后发来的 `update-cancelled` 和进度不落进
  快照，晚到的出错记在下载那一步（正在检查时来的出错仍算检查的），真下完了照常落到「已下载」。停住时每 5 秒按
  「这段时间没进账」重算平均速度。
- 不用 `session.closeAllConnections()`：沙箱实测它关不掉正在用的 HTTP/1.1 连接，HTTP/2 下又会触发上面那个没人接的异常。
- 日志：`updater/download.stalled`（warn，带 `retrying`、`unsettled`、`fullPackage`、`transferEnded`、`transferred`、
  `total`），`updater/download.requests.aborted`（info，掐断了几个请求），`updater/runtime.selected` 多了 `requestGuard`。
- 验证：单测（假计时器）；沙箱 Electron 43.6.0 + 真的 electron-updater（Windows 的 `NsisUpdater`），计时缩短，对着
  本地更新源（HTTP/1.1、HTTP/2）演过：多段增量下载停住一次换整包重下成功、停两次报下载失败，单段增量下载停住，
  连接中途断开（不再有没人接的异常），单段增量下载慢但一直有数据（不误判），下完以后核对签名慢（不误判），
  几段一起要却回了 200 整个文件（被拒的那份不再整个下完）。Windows / Mac 真机、线上更新源都没演过。
- 第二十七批 E：`electron/new-api-client.ts` 的 `performRequest` 多一个 `idempotent` 选项（缺省按 GET 算），发验证码
  （`GET /api/verification`）、发重置邮件（`GET /api/reset_password`）标 `false`，经代理失败后的直连重发规则改与 POST 相同：
  只有代理本身连不上、通道没开（`proxy` 那一类，请求肯定没出这台电脑）才重发；等回复超时、连接中途被断分不清发没发到，不重发，
  只照旧把会话改直连，原错误照常报。依据：new-api rc.24 `controller/misc.go` 先记码再同步寄信、最后才回话，
  `common/verification.go` 按邮箱只留最后一个码，重发会顶掉第一封（线上定制版没核）。#741 起才有这个重发；历史账号那边没有，不受影响。
- Codex 桌面端（`codex-desktop-service.ts`）：商店没走通（含没有商店）后先走 `downloadCodexDesktopOfficialPackage`，
  从 `persistent.oaistatic.com` 的官方 MSIX 下载，版本取官方 `windows-store-update.json`；包进 `withDownloadAcceleration` 临时加速线路，
  校验与镜像那一路同一套（`codexDesktopPackageValidationError`）。下不成、没过校验才换国内镜像，失败句多半句
  「OpenAI 官网的离线安装包也没下成」；官网的包下好核过却装不上时直接报错，不再换镜像重下。安装尾段抽成
  `installDownloadedCodexDesktopPackage` 两路共用。
- Claude Desktop（新 `claude-desktop-msix-installer.ts`）：入口 `claude.ai/api/desktop/win32/<架构>/msix/latest/redirect`，
  手动跟随至多三次跳转，只认 `claude.ai` 入口与 `downloads.claude.ai/releases/`；断点续传只找已落到的那个文件。
  下载后用 PowerShell 只读核对 `AppxManifest.xml` 与 Authenticode 签名：包名 `Claude`、架构、发布者算出的 ID 等于
  `Claude_pzs8sxrjxfjjc` 的后半截、签名 Valid 且签名者 `Anthropic, PBC`、签名主体与清单发布者一致。安装复用
  `codex-desktop-appx.ts` 的 `addWindowsDesktopAppxPackage`（带后台服务的包要 UAC 授权）。
- `external-client-runtime.ts`：Claude Desktop 在没有可信 winget 时也给「安装」；winget 除用户取消外怎么失败都先重新盘点，
  没装上就换官网那一路。两路都失败时由 `claude-desktop-install-failure.ts` 归成一句大白话，原话挂 `originalError` 进运行日志；
  渲染层新增 `claudeDesktopInstallFailed` 一类，按钮「去官网下载」打开 `https://claude.com/download`（已在外链白名单）。
- `e2e/windows-powershell-probes-smoke.mjs` 在 Windows CI 上用一个未签名的替身包真跑一遍核对脚本。
- 第二十八批 A：`electron/system-service.ts` 的 `runCliInstall`。Windows 普通权限（same-user）那条路没有暂存目录，
  `npm install --global` 直接写进正在用的全局目录；以前平台主程序包（`@anthropic-ai/claude-code-win32-*`、
  `@openai/codex-win32-*`）缺没缺要写完才查，查出缺了也不换源，旧版已经被盖掉。现在 `npm ci` 之后、写入之前先在
  resolution 的 `node_modules` 里查（`findMissingCliNativePackage`），缺了记成这个源失败、换下一个源；写完后那两道
  检查照旧留着兜底。托管那条路（Windows 管理员身份、macOS、Linux）也先查，省掉一次注定装不全的复制和安装，结果不变；
  Grok 的两条 npm 通道照旧在自己的安装事务里核对。
- 第二十八批 B：同一条路上，`lifecycle()` 那一段用 `managedPrefixSwapSealReason` 封住取消（Windows 的取消是
  `taskkill /T /F`，npm 挪开的旧版来不及挪回去）。这个源没装成就解封，换下一个源时下载照样能取消；装成了就一直封到
  结束，和托管那条路换进去以后一样。
- 第二十八批 D：Windows 上装 Python（`python-runtime.ts`）、Node.js（`node-runtime.ts`）不再整段包在
  `withDownloadAcceleration` 里。winget 自己下载、不走下载专用线路，以前先等线路（`acquireDownloadAcceleration`，最长
  12 秒）再试 winget 是白等。两个安装器多一个可选的 `withDownloadRoute`，退到下安装包时才借：Python 只在查版本、
  下载这两步握着，Node.js 握着 MSI 那一轮。`InstallNodeRuntimeOptions.networkRegion` 可以给函数，借到线路以后才问
  （借到了就官方源优先，和以前整段借线路时一样）。macOS、Linux 装 Node.js 仍整段借线路，行为不变；CLI 安装里顺带
  自动装 Node.js 那条路本来就在 CLI 安装的线路里，没动。
- 第二十八批 C：`electron/platform-capabilities.ts` 的 `cliNeedsPythonRuntime` 里 Gemini 三个平台都是 false（Linux
  版拆分 ③ 先去掉了 Linux）。Gemini 要 Python 只为现场编译可选依赖 `node-pty` / `@github/keytar`，编不出来 npm
  照样装完；终端那块用的 `@lydell/node-pty` 有 win32-x64/arm64、darwin-x64/arm64 的现成包（0.60.0 的
  optionalDependencies，没在 Windows、Mac 真机跑过）。渲染层 `planCliInstall` 因此不再把 Python 排进 Gemini 的
  安装、Mac 上不再拦，新手引导选 Gemini 时不再出 Python 那一行。教程「进阶：安装与使用命令行工具」「Mac 上准备 Node.js 和 Python」、Mac 首页缺 Python
  那段（`runtime-install-guide.ts`）的文字跟着改；注册表的 `requires` 和这几处 Python 分支留作没报表时的旧行为。
- `platform/windows-system-proxy.ts`：WinInet 互操作不再用 `Add-Type` 现编 C#，改成用 Reflection.Emit 在内存里
  声明三个系统函数（`InternetQueryOptionW`、`InternetSetOptionW`、`GlobalFree`，按 System32 全路径加载），
  `INTERNET_PER_CONN_OPTION_LIST` 按 wininet.h 的排布手工读写（指针宽度取 `[IntPtr]::Size`），WinInet 会读的
  字段逐个写，不用 `Marshal.Copy` 拷字节数组来清零。Windows PowerShell 现编要起 csc.exe、往 %TEMP% 写 DLL 再载回来，
  每次调用都是第二个冷进程：Windows 打包检查里「查系统代理是谁设的」一项在 #745、#796、#805 三次超过 15 秒上限
  （#805 是 18.6 秒，同一轮其余 30 项都在 1 秒上下；#807 之后 0.5 秒）。查进程身份（`owner`）现在完全不碰 WinInet；
  三个系统函数等读、写代理第一次用到时才声明。排布在 x86、x64、ARM64 三种 Windows 目标上用 clang 的静态断言核过，
  读写往返、释放和失败路径在沙箱里用 PowerShell 7 加一个按同样结构体编译的替身库跑过（分配的内存先填满垃圾）；
  真机 WinInet 读写由 windows-uninstall-smoke 覆盖。
- 退路：在内存里声明 P/Invoke 也是攻击工具不落盘的惯用写法，杀毒软件可能拦它，而 GitHub 的 Windows runner 关着
  Defender 的实时、行为和脚本扫描，CI 看不出来。所以这份脚本以非零退出码结束时（被脚本扫描拦下、进程被结束、读写出错
  都算，不看报错文字），同一个请求马上改用 `windowsSystemProxyCompiledScript` 再跑一次，之后同一个加速辅助进程都用它
  （辅助进程空闲两分钟退出，下次拉起会先再试内存声明）；它和 0.2.14 跑的脚本逐字节相同，测试用 SHA-256 钉住。超时
  不重跑，退路脚本失败也不再重跑。两份脚本都只在系统代理整份状态还等于请求预期时才写，重跑不会覆盖前一次留下的写入。
- `scripts/windows-acceleration-recovery.ps1` 保持 0.2.14 原样（客户手动跑、不限时，用不着内存声明）。它和软件
  退路脚本的比对从只比 C# 类型定义扩到再加 `Read-State` / `Write-State` / `Same-State`。
- `e2e/windows-powershell-probes-smoke.mjs` 加一项只读的「system proxy reading」，按 15 秒上限卡真正读系统代理的
  那条路，日志只打 flags；再用退路脚本读一次，和内存声明读出的逐项比对，耗时只打印、不卡上限；最后打印这台 runner
  上 Defender 的状态（实时保护、行为监控、脚本扫描、检出记录条数），只打印。
- 测试：Windows 上跑的浏览器套件里有七处打开夹具页时只导航一次，那次导航丢了（#806 是加载 `Splash.tsx` 时
  `net::ERR_NO_BUFFER_SPACE`）就对着空页面等满 90 秒再红。登录页、加速页、两份公告、`app-check` 里本机偏好读写不了的那一条、
  账户充值（`e2e/account-commerce-interactions.test.mjs`）和本地头像（`e2e/v2-local-avatar.test.mjs`）都改走
  `e2e/fixture-readiness.mjs` 的 `openFixturePage`：还是 90 秒预算，分成最多三次导航。超时和用例都没动。
- `scripts/ci-workflow-config.test.cjs` 原来只钉手写名单里的五份，现在按 Windows 作业实际跑的套件逐个查，
  新加进 Windows 分片、会开浏览器页的套件不走这一步就会红。
- 第二十九批 A 的后续（#806 之后）：`locale-status.ts` 新增 `describeWorkspaceTrustResult(changed, os)`，`ConfigDialog.tsx` 按 `trustCodexWorkspace` 返回的 `changed` 选文案。
  只在 Mac 上、而且这次真的新加了信任时补这半句；Windows 由主进程替人重开 Codex，文案不变。
- 第三十批 A：新增零依赖的 `electron/chinese-sentence.ts`（`isChineseSentence`：去掉引号段和路径再看有没有汉字），
  已登记进 `scripts/verify-renderer-boundary.test.cjs`。路径从第一个斜杠前的那截算起，那截里不许有汉字，遇到空白、引号、
  中文标点和括号断开，紧跟在后面、自己也带斜杠的几截（用户名带空格）算同一条路径；第二十六批 D 原来的写法会把
  「当前账号不可使用分组「GPT-中转/订阅」」这种不带空格、带斜杠的中文整句当成路径去掉。渲染层 `business-common.tsx` 的
  `speaksChinese` 改为把占位词「本地配置文件」换成一个斜杠再交给它，并导出；`errorMessage`、`StartGuide.tsx` 的
  `guideStepFailure`、`key-sync-failure.ts` 的 `keySyncFailureReason` 三处原来的「有没有汉字」都换成它。以前占位词本身是汉字，
  带路径的英文原话（EPERM/EACCES/EBUSY/ENOENT 加 `open 'C:\…'`）全被当成中文原样上屏；改后和不带路径的英文一样落到各自
  现成的中文兜底句，没有新加文案。
- 页头红条保住归类：`business-common.tsx` 新增 `failureWithDetail`（`operationFailureFrom` 改为调它），`useOperation` 和
  `useResource` 落到兜底句时把原话（`supportDetailOf`：脱路径、打码、160 字）记成 `detail`；`ResultNotice` 收可选 `detail`，
  改用错误框同一个认法 `presentOperationFailure`，原话只拿来认类别、不上屏。`{...operation}` 展开的页面自动带上；直接写
  `error={operation.error}` 的 19 处、`error={resource.error}` 的 7 处、两者拼起来的 6 处（谁的报错在显示就给谁的 `detail`，
  设置页的保存失败和系统信息失败不给），以及 Mac 卸载框都补传了 `detail`。顺带：不带路径、但认得出类别的英文（例如 ENOSPC），
  页头红条现在也有标题，和错误框一个说法。
- 第三十批 B：`electron/codex-extensions.ts` 的 `parseTomlFile` 解析失败时只报「（第 N 行附近）」，不再把 @iarna/toml 的原话
  （会抄出出错那行上下几行，客户自己加的外接工具令牌常在旁边）拼进报错；读文件自己的失败（超上限、读的时候被换掉、被拒绝）
  挪到 try 外照原样抛。`tomlErrorLocation` 从 `config-files.ts` 挪到新的 `electron/toml-error-location.ts`，两边共用。
  `errorMessage` 和 `keySyncFailureReason` 原样放行中文原话时也过一遍 `redactSecretPatterns`（新手引导和「给客服看的原话」早就打码）。
- 第三十批 C：新增 `electron/broken-config-advice.ts`（`describeConfigReset`、`describeBrokenConfig`），读不懂原配置时的那句
  统一从这里出：哪里坏了（TOML 只报「（第 N 行附近）」）、星芒没改、去首页工具行「…」→「配置」→「使用星芒账号」→「高级」→
  「重置为初始状态」。`config-files.ts` 的 `requireJson` / `requireToml` / `requireGeminiJson` 加可选的 `brokenTool`，只有
  merge 那几处（Claude Code、Gemini CLI、Grok CLI）传；Codex 的 config.toml、星芒替 Codex 存的那份、Grok 默认模型那句直接改；
  `codex-extensions.ts`（B）那句也换成 Codex 那句。不传的地方（开机核对型号名单、画图登记、信任文件夹、切回官方账号）照旧。
  行为不变：merge 照旧拒绝改坏的文件，reset 照旧先备份再重建。已知指不到路的：Gemini 没登录、或 Key 不是当前账号缓存里那把时，
  配置窗口里没有「重置为初始状态」；Codex 的 auth.json 坏了 reset 也救不了，那句没改。
- 第三十批 D：新增 `features/tools/external-client-notice.ts`：`externalClientSavedTone` 让「配置已保存」那块在自检结论为
  warn/bad 时用 `warn`，通过、未配置、这次没测成照旧 `ok`，字不改；`accountKeyListFailureText` 拼句前去掉原因结尾的句号。
- 第三十批跟进项：`electron/updater.ts` 的 `describeUnrecognizedUpdateFailure` 判中文改用 `isChineseSentence`。以前判的是没脱路径
  的原话，Windows 中文用户名（或 Mac 上路径里的「星芒AI管理工具」）让英文原话整句交给界面，更新页、首页气泡、「必须更新」那道门
  脱敏后显示成「…, open '本地配置文件」。原话照旧进 `detail` 和运行日志。
- 第三十一批 B 第二块：`update-notice.ts` 新增 `inAppToolUpdates`，`App.tsx` 的 `cliUpdate` 通知（事件编号、是否提醒过、记下已提醒）改用它，
  跳过 `isExternallyManagedInstall` 为真的安装（官方安装器 `native`、其他来源 `path`）。侧栏角标与首页「N 个有更新」照旧按 `pendingToolUpdates` 数全部。
- `update-notice.test.ts` 钉住通知与角标各数哪些；`app-check.mjs` 在开机第一轮检测落地后核对：npm 装的那份照常通知，官方安装器装的那份不通知。
- 第三十一批 A，收回 #403 的「检测完才给点」。#403 让按钮等检测没有安全上的理由，只是沿用了 loading 的语义：
  点「打开」时渲染层现读配置（`App.tsx` 的 `launch`），主进程 `launchProviderOperation` 现读配置、现找工具（`inspectCliTool`）、现查目录，用不上上次的检测结果。
  `Home.tsx` 的 `launchReadyBeforeScan` 只在 `cachedAt` 那段放开已装、已连好、配置读到了、这一行没有任务在跑的「打开」，「接着聊」跟着同一行走；
  「安装」「重新检测」「重新配置」「连接账号」照旧等检测跑完。
- 会拿旧 Key 打开的只有一种情形：开机账号同步要给已连好的工具换 Key（Key 换了分组），而写入要等那一轮检测跑完。
  `bootstrapAccountTools` 在恢复这一档问完服务端后把这几家放进进度的 `connectedKeyChanges`，`accountKeyChangePending` 据此只让它们照旧等；
  登录还在恢复、同步还没开始或还没回话、登录与点名重写两档（会重写已连好的工具）一律算说不准，照旧等检测跑完。
- 检测没跑完就打开时，那一轮落地带的是打开前读的配置，会把刚记下的文件夹（`rememberedWorkspace`）盖回去：
  这种情况下 `App.tsx` 打开后重读一次配置，走 `useToolbox` 的 `configRevision`，落地时用新的。
- 浏览器夹具 `?cachedScan` 改成开机那一轮谁来要真结果都接同一轮（同主进程 `coalescedScan`），新增 `?regrouped=`；
  `app-check.mjs` 加五条，`Home.test.tsx`、`account-bootstrap.test.ts` 补单测。
- 第三十一批 C 的 1～3（第 4 点「打开也认几分钟内验过的」要放宽「执行之前现验」，没做）。
- `external-client-runtime.ts`：Mac 上 `launch` 只现验要打开的那一个（`inspectMac` 的 `only`），spctl 和 WorkBuddy 的 `codesign --deep` 一项不少；
  Windows 的清点是一整段脚本，没动。
- Mac 上展示用的检测（`scan`，`reuseSignatures`）照 Windows `knownSignatures` 的规矩，按包指纹（包目录 dev/ino/mtime、Info.plist mtime/size、主程序 dev/ino/mtime/size，同 `macos-codex-app.ts`）
  认 5 分钟内验过的，只记通过的，现验没过就忘掉；`launch`、`install` 从不认。打开时现验通过的也记下，打开后那次后台重扫不再深验一遍。
- `App.tsx` 的 `launchExternal` 打开成功后不再整轮 `refreshExternal()`：`useToolbox` 的 `noteExternalLaunched` 先把那一行写成「运行中」（`withExternalRunning`），
  再 `refreshExternal(false, { quiet: true })` 悄悄核一次：不置 `externalLoading`，没读到就留着上次的结果、不出红条。主进程打开后作废缓存那一行不动。
- 测试：`external-client-runtime.test.ts` 补七条 Mac 签名核对，`useToolbox.test.ts` 补两条，`app-check.mjs` 补两条（开完三行能点、后台没读到不出红条）。
- 0.2.15 发版前回归检查第二节①：补设置（`config:fill-template-defaults`）算账号相关的工作，换账号、退出、登录之前的 quiesce
  要等它做完。#795 起这次调用要在本机看完 Codex 开没开（Windows 上 Codex 命令行和桌面端两次 PowerShell 探测，最多 8 秒、24 秒），
  开机那次还要先等型号名单的本机核对才返回；安全软件拖慢时超过 `prepare` 的 30 秒上限，客户看到「账号服务请求超时」。
- `electron/system-service.ts` 新增 `stopTemplateFillWaits` 和顶层的 `unlessStopped`。`electron/main.ts` 的 quiesce 在等 `accountWork`
  之前叫停、等完（`finally`）放开：还在看的那几步不再等，当成没看出来，不写、记成还欠着，记一条 `template-defaults.stopped`；
  已经在写的照常写完。叫停管到放开为止，已经进门、晚一步才走到看工具那里的那次也不起探测；放开以后开始的补设置照常看。
- 被叫停那次的结果，账号闸门总会按「账号上下文已变化」退回（`transition` 先推进版本再 quiesce），欠账按账号记在主进程。
  换账号没成时：补做那几次被叫停的，渲染层照旧隔一阵再来要；开机那次被叫停的，渲染层不会跟进（`App.tsx` 吞掉了那次报错），
  等下次打开星芒再补。0.2.14 起就有的另一种等法这次没动：要补设置的老配置在写入时排在配置写入锁后面，开机那次核对型号名单
  拿着这把锁问版本时，quiesce 仍要等它写完。
- 0.2.15 发版前回归检查第二节⑤：#793 的看门狗 45 秒没有新数据就掐断、换直连重下一次整个安装包，再停住就报
  `UPDATE_DOWNLOAD_STALLED`。先把整个安装包收完、查完才转发的中间设备（公司网关、上网行为管理、带下载查毒的代理）
  每次都会触发；0.2.14 没有看门狗，这种网络只是慢。更新页失败卡和首页气泡又只给「重新下载」，点了还是同一个结果。
- `electron/updater.ts`：新增 `updateDownloadRetryStallMs`（120 秒），`downloadWatched` 多一个停住门槛参数。停住或代理
  连不上以后自动换直连重下的那一次用它；第一次仍是 `updateDownloadStallMs`（45 秒，尽快换条路），进度到过 100% 以后
  仍是 `updateDownloadSettleMs`（180 秒）。自动重下仍然只有一次。
- `src/renderer-v2/features/app/update-retry.ts` 新增 `updateOffersDownloadPage`：`UPDATE_DOWNLOAD_STALLED`（与主进程
  `downloadFailure` 字面量一致）和原有的 `UPDATE_SIGNATURE_REJECTED` 给「打开下载页」。更新页（`pages-maintenance.tsx`）
  失败卡为「重新下载」「打开下载页」「查看日志」，首页气泡（`App.tsx`）为「重新下载」「打开下载页」「查看更新」；
  Mac 验签没过照旧只给「打开下载页」。按钮沿用现成的文字和 `appReleaseDownloadUrl`（已在外链白名单），没有新句子；
  「必须更新」那道门本来就给，不动。
- 测试：`updater.test.ts` 钉住重下那一次过了 45 秒还在等、到 120 秒才报停住（代理连不上后的重下也一样），以及
  45～120 秒之间才来数据也能下完；`update-retry.test.ts` 钉住只有这两个错误代码给下载页；`app-check.mjs` 在更新页和
  气泡上点「打开下载页」，并核对同一句「超时」但不是看门狗报的照旧只给「重新下载」。真机、真实中间设备都没演过。
- 测试：`scripts/cos-sync-utils.test.cjs` 里「上游 ETag 变了不发布半截文件」那条偶发报 `EBADF: bad file descriptor, close`
  （10-03 沙箱整套 `npm test` 一次、#818 的 linux-test 一次）。根因在 `scripts/cos-sync-utils.cjs` 的 `downloadResource`：
  写入流拿着 FileHandle 的同一个文件号，`autoClose: false` 拦不住显式的 `destroy()`，`finally` 里流关一次、`handle.close()`
  再关一次，谁先谁后看线程池。ETag 不符时流还没人监听，抢输的那次 EBADF 成了未捕获异常；下载成功时每次都重复关，中间隔着
  `link`，这个号要是已被别的文件拿去，关掉的就是别人的。现在只有 FileHandle 持有这个号：写入走 `handle.write`（只写进一部分的
  接着写，一个字节都写不进就报错），由它在进行中的写完成后关一次。沙箱压测 ETag 不符：改前 3200 次出 17 次未捕获，
  改后 9600 次 0 次。
- 新增两条用例：一条在旧代码上每次都红（下载一还回文件号就另开一个文件，查它没被关掉，并查没有绕过 FileHandle 的关闭）；
  一条让磁盘每次只收 4 KB，查下载的字节一个不差、写不进时报错而不空转。超时和原有用例都没动。
- 0.2.15 发版前回归检查第二节②（原始报告 F1，#796 带进来的）：星芒站点改走直连以后，直连那一路在拿到回话之前出一次错
  （断网、切 Wi-Fi、连接被断一下）就整轮交还给系统代理。代理开着却不转发星芒站点的客户，网络一恢复，余额刷新、查可用分组
  这类账号请求先在代理上等满 10 秒、再探最多 8 秒才回到直连；登录、建 Key、下单不自动重发，要再点一次。现在
  `proxy-bypass.ts` 的 `siteRouteFailed` 不马上交还，而是在后台同时经系统代理和直连各探一次，这期间请求照旧走直连：
  系统代理连得上星芒站点才交还（换到了必须走代理的网络，或者直连时好时坏、代理却好好的，都回到代理）；代理连不上而直连通，
  就开新一轮接着直连（刚才失败的账号读请求照旧自动重发；直连先通就不陪着等代理那一探超时）；两条路都没连上（断网、刚换
  网络还没缓过来）就留在直连，隔 3、10、30 秒再看，最多三次，期间又有请求在直连上失败就从那次重新算起；电脑不再走代理、
  星芒加速接管了系统代理，照旧马上交还。直连没通时，为那次失败来问的请求马上得到「不重发」，不陪着等经代理那一探超时。
  交还之前发出、失败在直连上的请求改经系统代理重发一次（重不重发照旧看 `new-api-client` 的 `mayReplayOffProxy`），
  不再回头探直连把站点又分出去；`main.ts` 的 `proxy-bypass.account-retry` 日志多记一个 `scope`（`app` / `site` / `proxy`），
  经代理重发的那种记成「已改回跟随系统代理」。新一轮不推迟每 5 分钟经系统代理的那次检查。
- 账号请求经代理失败、回头探直连时，这台电脑没网（`network-failure.ts` 归为 `offline` 的 ERR_INTERNET_DISCONNECTED、
  ERR_NETWORK_CHANGED）不再记 1 分钟退避：以前断网那几秒里探过一次，网络恢复后的 1 分钟里账号请求在代理上超时就直接
  报错、不再探。整个改直连（#578）那条路的 5 分钟冷却不变。不加界面文字。

## 0.2.14 - 2026-10-02

- `electron/sub2api-announcements.ts`：Sub2API 服务端按「未读在前、同状态按 ID 倒序」返回公告，最新一条读过后会排到
  所有未读后面，客户以为没有新公告。构造通知时改按上线时间倒序重排（开始时间与创建时间取较晚者，缺时间的排后面，
  再按 ID 倒序）。内容标识 id 不随顺序变化，已看过的提醒状态不受影响。解析器新增 `publishedAt`；`created_at` /
  `starts_at` 格式不对时与 `updated_at` 一样整体报响应格式不兼容。
- `src/renderer-v2/features/chat/storage.test.ts`「merges into the saved files and survives a reopen」偶发红：夹具连着建的两个对话都取 `Date.now()`，偶尔跨过一毫秒，后建的那个 `updatedAt` 更大，导入按 `updatedAt` 倒序排就排到了前面。夹具和导入对话的时间改成写死的值，断言不变。产品代码没改：排序是稳定排序，同一毫秒的对话保持原来的先后。
- 开机一次性修复 0.2.12（#685）写进 Claude Desktop `inferenceModels` 的多型号清单（#746 只改了以后的写法）。`electron/claude-desktop-model-repair.ts` 在联接策略定下后、开窗前跑一次：
  `listClaudeDesktopProfileCandidates`（`claude-desktop-paths.ts`）列出星芒可能写过的目录（`CLAUDE_USER_DATA_DIR`、Windows 普通版与商店版虚拟化两处、Mac / Linux 各一处），不盘点安装、不起 PowerShell；
  只有工具箱归属记录认领得到的那份 `configLibrary/<id>.json` 才看。
- 认法（`legacyClaudeDesktopSelectedModel`）：清单 2～20 项、全是去过首尾空格的字符串、不重复，第一项之后全是 `claude-*` 且按 `localeCompare` 升序，正是当年 `buildClaudeDesktopModelList` 的输出；网关是 `gateway`、地址是星芒两站之一。
  对上了只把清单改成第一项（和 #746 之后「保存配置」写出的一样），其余字段原样，经 `commitClaudeDesktopFiles` 留一份 `.bak`；对不上（对象写法、顺序变了、混进别家型号、地址不是星芒的、文件解析不了）不碰，只记 `claude-desktop.models.unrecognized` 日志。
- 查完在 `migrations/claude-desktop-single-model-v1.json` 记一笔，以后开机只读这一笔；这次读不出来或写不进去（被占用、读到一半变了）记次数，下次开机再试，最多三次；记录本身写不进去时照样报「改好了」，下次开机再查一遍收尾。不查管理策略、不核对当前账号（理由见 `repairLegacyModelList` 注释）。
- 改成了就在 `window:get-capabilities` 上带可选字段 `claudeDesktopRepaired`（无新增 IPC 通道），renderer-v2 角落卡片 `claude-desktop-repaired` 说一句改了什么、开着的话要完全退出再打开；看不出 Claude Desktop 开没开，按「开着的话」说。
- `electron/codex-desktop-acceleration.ts`：自动连接超过 15 秒预算时，`ensureConnected` 按超时返回、桌面端照常
  打开，但加速服务那边的连接撤不回来，迟到连上后是一条不扣时长、没有到期的会话，而「桌面端退出就断开」的守护只在
  准时连上时才挂，于是一直开到退出星芒（A014 2026-10-02 报告）。超时后改为接着等连接结果，迟到连上照样挂守护，
  日志 `acceleration.codex-desktop.connected` 带 `{ late: true }`。另加 `observe(state)`，由 `main.ts` 接到加速服务的
  `onState`：任何一份「当前账号、正连着、`autoStartedBy` 为 codex-desktop」的状态都会被接着盯，同一次会话只盯一份。
  守护每次检查先比账号再读状态：原来换账号或退出登录后读旧账号状态被拒，落进 catch 每分钟重排，永远停不下来。
- `src/renderer-v2/features/acceleration/AccelerationView.tsx`：自动连接的会话额度圈下那行原来照普通连接写
  「正在计时」，与旁边「自动连接不扣免费时长」矛盾，改为「自动连接不计时」。
- 安装 / 更新前的归属确认 `assertNpmChannelOwnsCli` 与卸载 `uninstallCliOperation`（electron/system-service.ts）同 #737：只用 `findInstalledExecutable('npm')` 查 npm 路径，不再走 `inspectTool('npm')` 多起一个 `npm --version` 子进程。两处本来就只用 `.path`，找不到 npm 时传下去的仍是 `null`，结果不变。
- Linux 版自动更新（客户端，出 Linux 版拆分第 ⑧ 步，摸底明细 updater 区 U1/U2/U4/U6/U8）。Linux 还没对外发，这条不进
  更新说明。
- 只有 .deb 装的能自动更新（读 `resources/package-type`，`electron/linux-deb-update.ts`）：下载后照旧核对 SHA-512，
  装这一步不交给 electron-updater 的 DebUpdater（shell 拼 `pkexec bash -c 'dpkg -i'`、失败以 root 跑
  `apt-get -f -y`），而是用固定路径、归 root 的 `xdg-open` 把安装包交给系统安装程序，软件随即关掉；星芒全程不提权。
  打不开时替客户打开安装包所在的文件夹。Linux 从不在打开或退出时自动装，退出时只问一句。
- 不是 .deb 装的（AppImage、解包运行）更新器直接停在 disabled、更新页给「打开下载页」，不再永远卡在「正在检查」；
  electron-updater 返回 null 且没发任何事件时报 `UPDATE_INACTIVE`，Windows、Mac 打包版不会走到这一步。
- 状态文件的最低版本在 Linux 上只在更新目录真给了够格的新版本时才拦（`resolveGatedRequiredVersion`），Linux 更新包
  没上架时不会把客户关在门外；分批放量的豁免仍按「低于最低版本」算。Windows、Mac 的拦法和快照逐字不变。
- 更新页、「必须更新」提示、首页气泡、托盘、系统通知、退出确认在 Linux 上改说「安装新版本」并提前说明会弹安装窗口、
  要输开机密码。教程页文案留给 ⑩，下载页加 Linux 包留给 ⑨。
- Linux 能打包了（尚未对客户发布，见 `docs/LINUX.md`）：只出 `.deb`，x64 与 arm64 各一份，装到 `/opt/xingmang-ai-manager`，菜单仍叫「星芒AI管理工具」。打包标记 `XINGMANG_LINUX_PACKAGE=1` 把 productName 换成英文名（`npm run build:linux` / `build:linux:ci`），`beforePack` 拒绝没带标记的 Linux 构建、带标记的其他平台构建，以及任何 Linux 发布模式构建（发版流水线做完之前 Linux 只出本地测试包，更新器关着）。
- `build/linux/after-install.tpl` 照抄 electron-builder 26.15.3 的 postinst，只把按 `unshare --user` 判断的那段换成无条件 `chown root:root` + `chmod 4755` chrome-sandbox：postinst 以 root 跑，探测几乎总说「不需要」，客户以普通用户打开时就起不来。`scripts/linux-build-config.test.cjs` 钉住配置并比对上游模板，全仓不许出现关沙箱的开关。
- 新增 `scripts/verify-linux-deb.cjs`（控制字段与依赖、包内全归 root 且只有 root 能写、无包外链接与多余安装位置、postinst、菜单文件、ELF 架构、更新器关着）和 `e2e/linux-deb-smoke.mjs`（读装好的目录权限，再以普通用户启动，从 `/proc` 确认无关沙箱参数、渲染进程 Seccomp 为 2）。`verify-packaged-hardening.cjs` 按文件名认出 Linux 主程序。
- CI：`quality.yml` 新增 `linux-package`（进 quality-gate），x64 在 ubuntu-24.04、arm64 在 ubuntu-24.04-arm，打包、校验、apt 真装、开启 Ubuntu 24.04 用户命名空间限制后普通用户真开、跑 packaged-hardening-smoke、卸载后确认不留东西。`package-for-testing.yml` 加 `linux` 选项（`both` 仍只指 Windows 与 macOS），artifact 名带 `NO-AUTO-UPDATE`。
- Linux 版拆分 ③（摸底 G6）：Grok CLI 在 Linux 上也能一键装。`grokInstallStrategyFor('linux')` 新增
  `linux-official-npm`，和 macOS 一样在临时目录里 `npm ci`：先不跑脚本、整张依赖图对上官方 SHA-512，
  再跑 xAI 自己的 postinstall，把程序解到 `~/.grok/bin/grok-<版本>`。Linux 没有 codesign，新模块
  `electron/linux-grok.ts` 改为核对：这个文件（按链接选中时的 dev/ino 打开）必须和锁里校验过的
  `@xai-official/grok-linux-x64` / `-arm64` 那份 `grok.br` 解出来逐字节一致、归当前用户且只有一个链接，
  `--version` 报的正是这次的版本；不过就把 `grok`、`agent` 两个链接退回原样（复用 `macos-grok.ts` 的快照与回滚）。
  `~/.grok/bin/grok` 已经是这种布局描述不了的链接（xAI 自己的安装器、手做的）时，出错时没法原样放回，
  所以在 npm 跑之前就停下，并用一句中文说清楚。`platformCapabilitiesFor` 里 Grok 在所有平台都是 `managed`。
- Linux 的 Grok 有没有新版只问 npm，不问 x.ai（新增 `cliLatestVersionSource`；`buildUncheckedLatestVersion`
  加可选的平台参数，不给时和以前一样答 `official-manifest`），Windows、macOS 仍以 xAI stable 为准、为上限。
  已装版本从 `~/.grok/bin/grok` 指向的文件名读（npm 的 postinstall 不写 `version.json`）。
- Linux 的 Grok 卸载：只认「相对链接直指同目录 `grok-<版本>`」这种布局，链接用已核对的逐文件卸载删，
  再一个一个删 `grok-<版本>` 程序文件；删不掉的（多个链接、不归当前用户）照 macOS 的口径回
  `manual-required` 并给一条 `rm -f`。`~/.grok` 里的设置和会话不动。
- Linux 版拆分 ③（摸底 G8）：Gemini 在 Linux 上不再先要 Python。`PlatformCapabilities` 加可选的
  `cliNeedsPythonRuntime`（缺省 = 按渲染层注册表判断，旧行为），Linux 上 Gemini 为 false；`planCliInstall`
  与新手引导（`pythonNotNeeded`）都按它走。首页缺 Python 时 Linux 只说一句四家都用不到、给
  `sudo apt install python3`，不再给 python.org 按钮和 Mac 的教程章节。Windows、macOS 不变，有测试钉住。
- 测试：新增 `linux-grok.test.ts`（真 brotli 夹具：通过、改过的字节、链接指错版本、平台包缺失/版本不对、
  `--version` 不对、硬链接、不支持的芯片、回滚、卸载与拒绝陌生布局），`system-service.test.ts` 加一组
  「Linux Grok install from npm」（装、装后核对失败回滚、装完再卸）和策略、版本来源、目标目录的用例，
  `platform-capabilities`、`runtime-readiness`、`runtime-install-guide`、`StartGuide`、`Home` 补对应用例；
  Linux 专属的用 `runIf` 门控。另在云沙箱（x64）里用真的 `@xai-official/grok@1.0.44` 跑过一次 postinstall、核对和卸载，
  并在完全没有 Python 的 PATH 下装过 `@google/gemini-cli@0.60.0`、`gemini --version` 正常；arm64 没实测。
- 文档：`docs/LINUX.md` 第 1 节补「Grok」「Python」两行、第 5 节把 ③ 标为已做；`.claude/rules/linux-platform.md`
  补 Grok 的完整性一节；`docs/MODULE-MAP.md` 加 `linux-grok.ts`；`ui-spec/08-platform-matrix.md` 的 Linux 运行环境格补一句。
- Linux 版拆分 ②：Linux 上 Node.js 改由本软件准备（`platform-capabilities.ts` 的 `nodeRuntimeInstall` 改为 `managed`，
  `ui-spec/08-platform-matrix.md` 同步，Mac 那格一并改成第十六批 2 以来的实际做法）。新模块
  `electron/linux-node-runtime.ts`：版本钉在 v24.21.0，x64 / arm64 各钉一个 SHA-256（取自 nodejs.org 的
  SHASUMS256.txt.asc，已用 nodejs/release-keys 验过签名），字节可以从 npmmirror 来；只用属主为 root、
  组和其他人不可写的 `/usr/bin/tar`（退到 `/bin/tar`），环境里只给 `PATH=/usr/bin:/bin` 和 `LC_ALL=C`（`TAR_OPTIONS`、`GZIP` 带不进去），`--no-same-owner` 解压，
  核对目录结构并跑一次 `node --version` 后原子替换。
- 数据目录（摸底 G1/G2）：非 Windows、非 macOS 平台的产品根目录从 `/var/lib/xingmang-ai` 改为
  `${XDG_DATA_HOME:-~/.local/share}/XingMangAI`（`managed-cli-paths.ts`），`ensureManagedNpmLayout` 不再拒绝 Linux。
- 托管 npm（G3）：Linux 上 Claude Code、Codex CLI、Gemini CLI 和 macOS 一样先装进 npm 缓存里的暂存前缀，
  核对后整体换进托管前缀，不再写用户 `~/.npmrc` 指的全局目录；包目录按 POSIX 的 `lib/node_modules` 找
  （`system-service.ts`、`cli-process-probe.ts`）。Grok 不在这次范围（拆分 ③）。
- 找程序的顺序（G4）：新模块 `electron/linux-platform.ts`，本软件准备的 Node.js 排在继承的 PATH 前面
  （和 macOS 相反：Ubuntu、Debian 自带的那份常常太旧，排在后面永远轮不到它），随后是托管 npm 的 bin，
  再是 Volta、fnm、`~/.npm-global` 这类常见用户目录和系统目录。`trustedCommandEnvironment` 没动。
- 失效的本机代理（G9 并入加速那条）：Linux 上 npm 子进程和启动 CLI 时也绕开指向本机、但已经没人监听的
  代理变量（`withoutDeadLoopbackProxies`）；Windows 原样，macOS 仍不绕。
- 「换成新版 Node.js」在 Linux 上也提供（`shouldReplaceNodeForCertificates`、渲染层 `canReplaceNode`）。
- 渲染层：首页缺 Node.js 时 Linux 也显示「准备 Node.js」那句说明，不再送去 nodejs.org、不再提包管理器；
  新手引导里 Linux 的运行环境字样按能力判断（`runtimeAutoPrepare`），Windows、Mac 的字样不变。
- 测试：`linux-node-runtime.test.ts`（含一次用系统 tar 解真压缩包）、`linux-platform.test.ts`，以及
  `managed-cli`、`command-runner`、`system-service`（Linux 托管 npm 安装两例）、`platform-capabilities`、
  `node-replace`、`runtime-install-guide`、`StartGuide`、`Home` 里的 Linux 用例；Linux 专属的用
  `it.runIf(process.platform === 'linux')` 门控。`command-runner` 两条原本「非 darwin 都跑」的 Windows PATH
  断言改成只在 win32 跑；`cli-revert` 的夹具改成装进托管目录；模拟 Linux 安装的 `certificate-trust`、
  `install-cancel`、`download-acceleration` 用例会在 HOME 下建托管目录，Windows 主机上的 HOME 不是 POSIX
  路径，改为只在 macOS / Linux 主机上跑（`disk-space` 原本就这样门控），并清掉 `XDG_DATA_HOME`；
  `download-acceleration` 原来那条「Windows 以外不绕代理」拆成 Linux 绕、macOS 不绕两条；两条模拟 macOS
  原生 Claude Code 的用例不再读宿主机自己的全局 npm；legacy 的 `platform-presentation.test.ts` 改为显式给
  一份 external 能力，旧界面新手引导的 e2e 夹具（`e2e/start-guide-fixture.tsx`）加 `nodeRuntime=external` 来演
  「外部安装」（都只动测试，跟着平台能力契约走）。
- 文档：`docs/LINUX.md` 第 1 节补「数据目录」「Node.js」两行、第 5 节「还欠着的」把 ② 标为已做；
  `.claude/rules/linux-platform.md` 补一行说明 same-user 环境里托管 Node 排在前面、和 trusted 环境相反是有意的；
  `docs/MODULE-MAP.md` 的 Linux 模块并成一段。
- Linux 版拆分第 ⑥ 步：没有可用的系统密码保管（safeStorage 不可用或只有 basic_text）时照样能登录，
  只是不记住。`resolveCredentialPersistence`（safe-storage-backend.ts）只在 Linux 上给出
  `session-only`：账号库换成只在内存里的 `createSessionRealmAccountVault`，托管 CLI Key 与 AI 聊天
  分组 Key 两个缓存也只放内存，一个字节都不落盘（I3 不变）；旧版 saved-accounts / account-session
  文件不读也不动。会话状态带 `sessionOnly: true`，renderer-v2 的登录框与设置页据此不给「记住密码」，
  改说「关掉软件后要重新登录」。Windows、macOS 加密不可用时照旧拒绝登录。
- 桌面环境 Chromium 不认识（i3、LXQt、远程桌面、deepin 新版的 DDE 等）但装了 gnome-keyring
  （有 `org.freedesktop.secrets` 的 D-Bus 激活文件）时，ready 之前给 Chromium 加
  `--password-store=gnome-libsecret`（linux-password-store.ts）；认识的桌面、有 KDE 迹象、用户自己
  传了该开关时都不动。
- 拒绝写入时的提示去掉「密钥环」「凭据服务」「明文」这类词。
- 发版流程接上 Linux（尚未对客户发布，开关默认关，见 `docs/LINUX.md` 第 4 节）：`publish-release` 的平台选项改为 `all`（默认）/ `both`（保留，仍只指 Windows 与 macOS）/ `windows` / `macos` / `linux`，作业的 `if` 改成按选项正向匹配（原来「不是 macos 就出 Windows」的写法在只选 linux 时会把 Windows 和 Mac 一起出）。新增 `linux-checks`（x64 上 typecheck、npm test、test:v2、test:canvas、test:ui）和 `linux-build`（x64 / arm64 原生机器各出一个无签名发布模式的 deb，apt 真装、普通用户真开、卸干净后上传 artifact），两者不读 secret、不挂 release 环境。
- 开关是仓库变量 `XINGMANG_PUBLISH_LINUX`：不是 `true` 时 publish 作业不下载 Linux 产物，Linux 作业红了也不挡 Windows / macOS，只选 linux 时 publish 整个跳过；是 `true` 且这次选了 Linux 时，`linux-build` 必须成功才发（超时是 cancelled 不是 failure，只挡 failure 会让 Windows / macOS 悄悄不带 Linux 发出去），两个架构的清单必须同时到，上传、逐字节复核、清单备份与覆盖、`update:verify-feed --platform=linux`、GitHub Release 附件都带上 deb。`publish-workflow-config.test.cjs` 按 GitHub 的规则把作业与步骤的 `if` 算一遍钉住这张真值表。
- 新增 `npm run release:package:linux -- --arch <x64|arm64>`（`scripts/run-linux-release-package.cjs`）：前置检查只比这个架构的线上清单（`verify-release-environment.cjs --platform linux --arch`）→ 编译 → electron-builder 出 deb → 加固校验 → `verify-linux-deb.cjs --release`（更新器开着、`xingmangUnsignedRelease`、`app-update.yml` 指向这个版本的正式更新目录且无 `publisherName`）。`electron-builder.config.cjs` 放行 Linux 的无签名发布模式，仍拒绝两种签名发布模式。
- Linux 文件名集中到 `scripts/linux-artifact-names.cjs`。deb 文件名照抄原版本号（electron-builder 只把控制字段 Version 里的「-」换成「~」），`verify-linux-deb.cjs` 原来按「~」找预发布版本的 deb 会找不到，一并改正并拿 electron-builder 的命名格式钉住；`update-release-utils.cjs` 新增清单名单 `UPDATE_MANIFESTS`（Linux 每个架构一份：`latest-linux.yml`、`latest-linux-arm64.yml`），`publish-guard.cjs`、`rollback-release.cjs` 改为按它认清单。Linux 清单必须且只能列这个版本、这个架构的一个 deb，没有 blockmap；新增 `validateLocalLinuxRelease`（本地清单与 deb 的大小、SHA-512）、`verifyRemoteFeed({ platform: 'linux' })`（两个架构一起查，`all` 仍只指 Windows 与 macOS）和只读一份清单的 `readRemoteManifest`。`verify-linux-deb.cjs` 两种模式都核对清单与 deb 一致。
- `rollback-release.yml`、`service-status.yml` 读 Linux 两份清单（线上没有就跳过）；回滚后 Linux 单独复核，`latest-linux*.yml` 不会被当成 Windows。dl.solov.cc 落地页不在发版流程里，没动。
- Linux 安全边界（Linux 版拆分第 ⑦ 步，Linux 尚未对外发布）：新增 `electron/linux-path-trust.ts`，
  Linux 上 `isUserWritablePath` / `isTrustedHighIntegrityExecutable` / `trustedCommandEnvironment` /
  relocated-folders 不再分别用「一律可信」和 macOS 规则，改问「除 root 与当前用户之外能否改动」，
  组可写目录按 `/etc/group` 实际成员判；`trustedCommandEnvironment` 在 Linux 上重建 PATH 并另剥
  `LD_*`、`BASH_FUNC_*`、`GCONV_PATH`、GTK/Qt 模块路径等注入变量；`runCommand` 的 `trustedOnly`
  在 Linux 上补齐可执行文件与路径参数的可信解析。
- Linux 上以 root 或替别的账号打开时直接提示并退出（`electron/linux-launch-guard.ts`）；画布打开前
  检查启动开关并读渲染进程的 `Seccomp`，系统沙箱没生效就不开（`electron/linux-renderer-sandbox.ts`）；
  日志与反馈报告在 Linux 上把主目录记作 `~`，并去掉 `/media`、`/run/user`、gvfs 里的账号名。
  Windows 与 macOS 行为不变。规则见 `.claude/rules/linux-platform.md`。
- Linux 版拆分 ⑤：Linux 上点「打开」改走新模块 `electron/linux-terminal.ts`（摸底 terminal-launch 区前四条）。
  命令窗口程序从原来写死的三个扩到一张十八种的表，先用当前桌面自带的（GNOME 终端、深度终端、麒麟 UKUI 的
  MATE 终端、Konsole、Xfce 终端等），再用 `/etc/alternatives` 指向的系统默认终端，最后按表试；只在 PATH 的绝对
  路径项和系统目录里找、启动绝对路径，项目文件夹里的同名程序不会被跑到。
- 命令窗口只收到 `/bin/sh` 和一次性启动脚本的路径。脚本放 `$XDG_RUNTIME_DIR`（用不了或写不进去就换系统临时目录）下
  0700 的私有目录、本身 0600，第一行删掉自己；它负责设窗口标题、进项目文件夹（进不去就说中文并且不启动工具）、
  export 关键变量并清掉计划里没有的账号与代理变量、工具退出后补中文提示，最后等回车再关窗口。
- 脚本删掉自己才算打开成功：起不来或报错退出就换下一个命令窗口，15 秒还没跑就不再换、删掉脚本，
  报「命令窗口一直没有出现」；一个都找不到时报「没找到能打开命令窗口的程序」并说去应用商店装「终端」。
  临时文件夹都写不进去时报「这台电脑的临时文件夹用不了」，系统原话只进日志。脚本只写表里那几个变量，
  `BASH_FUNC_module%%` 这类 shell 起不了名的变量留在命令窗口进程里，不挡打开。
  失败与原来 Windows、macOS 一样包成「未能打开 某工具：…」，运行日志记下试过哪几个、怎么失败的（路径按主目录脱敏）。
- 检查页「打开工具用的命令窗口」一项在 Linux 上不再写「Mac 不需要这一项」，改为说会用哪个命令窗口，
  找不到判失败并给出做法；Mac、Windows 这一项不变。
- 启动脚本文件的写入、按身份核对后删除、清理已退出进程留下的目录，从 `macos-platform.ts` 挪到
  `electron/terminal-launcher-files.ts` 与 Linux 共用（macOS 行为不变，原测试照跑）；`cli-exit-hint.ts` 加
  Linux 用的「按回车键关闭这个窗口。」与进不去文件夹的两行。
- 文档：`docs/LINUX.md` 第 1 节加「打开工具」一行、第 5 节把 ⑤ 标为已做；`.claude/rules/linux-platform.md`
  加「打开工具的命令窗口」一节；`docs/MODULE-MAP.md` 加新模块。
- Linux 版界面与系统细节（出 Linux 版拆分第 ⑩ 步）。Linux 还没对外发，这条不进更新说明；Windows、Mac 的界面、文案和
  行为不变，相关测试按平台钉住。
- 托盘：启动时用固定路径的 `/usr/bin/dbus-send`（退到 `/usr/bin/gdbus`）问会话总线有没有
  `org.kde.StatusNotifierWatcher`（`electron/linux-tray-host.ts`），没有就不建托盘、关窗直接退出，设置页「点关闭按钮时」
  说明原因，开机自启时直接弹窗。原版 GNOME 上 `new Tray()` 成功但图标不显示，窗口缩进去就找不回来。
- 开机自启：Linux 写 XDG 的 `~/.config/autostart/xingmang-ai-manager.desktop`（`electron/linux-autostart.ts`，Exec 按
  Desktop Entry 规范加引号、带 `--launched-at-login`，读写走 safe-local-data），系统里被停用时报「登记了但没生效」。
- 不要应用菜单；窗口图标用 PNG；Wayland 会话启动前加 `--enable-wayland-ime --wayland-text-input-version=3`
  （`electron/linux-ime.ts`）；渲染进程崩溃框和「窗口已收起」通知改成 Linux 的说法。
- 平台能力加 `acceleration`（Linux 为 false）：侧栏、搜索、托盘菜单、设置里的加速提醒都不出现，不发加速请求。
  Codex 桌面端行和外部客户端在 Linux 上不显示；新手引导在 Linux 上默认推荐 Codex CLI。
- 教程按电脑分版本（`registry/tutorials.ts` 的 `tutorialTopicsFor`）：Linux 第一章换成 Codex CLI，更新一步按 ⑧ 的系统
  安装窗口口径写，去掉桌面端、加速和 Mac 专属章节；Git 缺了给 apt 命令。
- 读 `/etc/os-release`（`electron/linux-os-release.ts`）：检查页「操作系统」、「复制给客服」和启动日志带发行版名字，
  日志另记桌面、x11/wayland、有没有托盘。`WindowCapabilities` 加可选的 `systemLabel`，没有新增 IPC 通道。
- Linux 版拆分 ④（摸底 G5）：客户自己开的终端里能直接敲 claude / codex / gemini / grok。新模块
  `electron/linux-shell-profile.ts`：星芒装进托管 npm 前缀的每个工具在 `Cli/launchers` 下有一个小启动器，
  只对这一条命令把星芒准备的 Node.js 排到最前再 `exec` 真正的入口，系统自带的旧 `node` 截不走
  `#!/usr/bin/env node`，用户自己敲的 `node` 不变；入口不见了就用中文说去星芒里重装。Grok 在 Linux 上由 xAI 的
  postinstall 装在 `~/.grok/bin`（拆分 ③），只在 `grok` 是指向旁边 `grok-<版本>` 的相对链接（npm 布局）时配启动器，
  启动器直接转到这个链接、不动 PATH，更新改指向后不用重写；xAI 官方安装器那种布局不配。
- 终端启动文件：`~/.bashrc`、`~/.zshrc`、`~/.profile` 末尾追加和 macOS 同一对标记的几行，只把启动器目录接在
  PATH 最后；fish 写自己的 `conf.d/xingmang-ai-manager.fish`，不改 `config.fish`。只给已存在的文件和账号登录
  shell 自己读的文件加，从不建 `~/.bash_profile`；符号链接、硬链接的文件跳过并记日志（I8）。打开软件只补一次
  （`terminal-commands-added`），装、修、更新时再确认。在星芒里卸掉它装的最后一个工具时逐字去掉这几行（保留文件
  权限和用户在前后加的内容，用户改过的那段不动）、删 fish 文件和启动器目录；打开软件时从不撤。
- `createCliTerminalAccess` 加 Linux 分支（`syncTerminalCommands`，同一时间只跑一次；打开软件时有星芒装的工具或装了 Grok
  才同步一次）和 `release`，卸载成功后调用；
  Windows、macOS 的走法不变，测试钉住两边都不会用到 Linux 那条。`linuxCommandPathCandidates` 把继承 PATH 里的
  启动器目录剔掉，软件扫描不会把启动器当成一份安装。`managed-cli-paths.ts` 新增 `managedTerminalLauncherDirectory`；
  `writeAtomicSafeUtf8File` 可选 `mode`（缺省仍是 0600）。
- 测试：`linux-shell-profile.test.ts`（含真 bash 交互 / 登录 shell 里 `command -v` 与旧 node 不抢的端到端用例，
  有 zsh、fish 时也跑）、`windows-cli-shell-access`、`linux-platform`、`safe-local-data`、`system-service`（Linux
  托管安装后与卸载后各同步一次）。
- 文档：`docs/LINUX.md` 第 1 节加「终端里直接敲命令」、第 5 节把 ④ 标为已做；`docs/MODULE-MAP.md`、
  `.claude/rules/linux-platform.md` 补一行。
- `electron/windows-store-app-launch.ts` 删掉账户探测（`WindowsStoreAppLaunchContext`、`resolveStoreAppLaunchBlock`、`describeStoreAppLaunchBlock` 及其 PowerShell），只留「有没有微软商店」（#674）。Windows 那条「内置管理员 / 关了 UAC 不能激活」（E_FULL_ADMIN_NOT_SUPPORTED 0x80270253、E_UAC_DISABLED 0x80270252）只管跑在 AppContainer 里的 UWP 应用；Codex 桌面端是 runFullTrust 的 MSIX，按普通桌面进程启动。内置 Administrator 真机核过：2026-10-02 出过这句提醒的租用测试机（SID -500、FilterAdministratorToken ≠ 1）上 Codex 桌面端装好并打开过。EnableLUA = 0 没真机核过，依据是同为 full-trust MSIX 的 Windows Terminal 在 EnableLUA = 0 的 Windows 10 上能启动（microsoft/terminal PR #11221、#17291）。
- `diagnostics.ts` 的 `ADMINISTRATOR`：alwaysElevated 那支恢复 #473 的 pass，不再多起一次 4 秒的 PowerShell；`DiagnosticsDependencies.inspectStoreAppLaunchContext` 删除。
- `codex-desktop-service.ts`：首页合并探测不再读当前账户与 UAC 策略，`DesktopAppStatus.storeAppLaunchBlock` 与 ipc-contract 的 `StoreAppLaunchBlock` 删除；`describeCodexDesktopLaunchFailure` 去掉账户参数，打开失败后不再额外起一次最长 10 秒的账户探测。
- 渲染层删掉 `storeAppLaunchNotice` / `storeAppLaunchShortNotice` 与首页、安装卸载页、新手引导三处挂载；`operation-error.ts` 删掉按「Administrator / 用户账户控制」隐藏「重置 Codex」的特例。`e2e/windows-powershell-probes-smoke.mjs` 去掉账户探测那两项。
- `realm-account-service.ts` 的 `restoreAllowingOneTimeout`（#748 加的开机快速重试）第二次恢复改为先 `vault.get(saved)` 取库里这个账号最新的一份再试，取不到（记录没了、读不出）就照第一次的超时挂 stalled，交给 30 秒那一轮重新读库。原因：第一次恢复可能已经续过期——Sub2API 服务端换了新令牌、旧续期令牌当场作废，新的经 `onCredentialRotation` 存进了库，超时的是紧接着的 `/auth/me`。原来拿出发前那份旧凭据重试，续期返回 401，`restoreActive` 随即 `vault.signOut(saved)`，把库里刚存好的新凭据连同账号一起删掉。星芒账号换 cookie 也走同一条路，一并改用最新的。另外快速重试前剩下的 prepare 期限不足 12 秒（单个请求 10 秒超时加落库余量）就不试、直接挂 stalled：星芒账号每次恢复都先续期，期限半路掐断续期时 dispose 让 `assertAuthAttempt` 丢掉回话，换来的 cookie 不落库，30 秒那一轮拿作废的那份会 401 删号。来源：0.2.14 发版前回归检查第二节第 1 条，期限那条是复核时补的。
- 根因：用星芒 Key 时 Codex 的菜单、提示词与工具只取二进制自带的型号名单（`codex-rs/models-manager/models.json`）。2026-09-30 那批桌面端（26.930.x）自带 Codex 0.159.0-alpha.12.1，名单里没有 9-29 才上的 `gpt-6.1-sol`；上游同样的报告见 openai/codex #50282。
- 新增 `electron/codex-model-catalog.ts`：随包一份 openai/codex `rust-v0.160.0` 的官方名单（`bundled-catalog/codex-models/`，原样拷贝、按 sha256 钉住，附 Apache-2.0 的 `LICENSE` / `NOTICE`），按 `/v1/models` 挑出当前 Key 能用的型号，原样写成 `CODEX_HOME/xingmang-models.json`，`config.toml` 顶层写相对路径 `model_catalog_json = "xingmang-models.json"`。
  名单文件与 `config.toml` 同一次两阶段提交、文件先落盘，内容没变不重写；不进 `providerConfigPaths`（工具配置来源指纹不变）。
- 名单读不进去时 Codex 命令行起不来、桌面端开不了新对话，所以下面任何一条成立就不写，并收回本软件那一行：账号的型号一个都对不上或只剩隐藏型号；默认型号不在名单里；本机 Codex 命令行低于 max(0.147.0, 写进去的型号的 `minimal_client_version`)；桌面端早于 26.917 那一批（Windows 问 Appx 包、Mac 看应用包，版本号前两段即批次）；名单文件的位置被换成了链接（Key 照常保存）。读不出命令行或桌面端版本时原样不动；用户自己设的 `model_catalog_json` 不碰；切回 ChatGPT 与存官方快照时去掉那一行，名单文件不删。
  沙箱里用假中转跑过七个真二进制（0.146.1、0.147.0、0.150.0、0.153.4、0.156.1、桌面端 26.930 自带的 0.159.0-alpha.12.1、0.160.0）：0.147.0 起都读得进、菜单列出 `gpt-6.1-sol`、请求不再退回通用提示词；0.146.1 报 `missing field base_instructions` 起不来；文件丢了或是空名单时命令行退出、桌面端新对话报 -32600。
- 何时按账号写：`saveConfig` 的每次 Codex 保存；打开前的每日核对（`tool-model-check.ts` 由只管 Claude Code 菜单扩到 Codex，`pickerOutdated` / `refreshPicker` 改为带 provider）；登录状态下开机一次（`syncPicker('codex')`，与补模板缺省项同一套规矩：只动来源是当前账号的配置，Codex 开着或看不出开没开就跳过，改之前先做「保存前」备份）。无新增 IPC 通道。
- 何时在本机就地收回（`takeBackUnreadableCodexModelCatalog`，不看账号、不联网、不管工具开没开，只删本软件那一行，其余字节原样）：Codex 命令行装好 / 更新 / 退回之后（在安装队列任务里，排在后面的启动不会先撞上）、星芒装好桌面端之后、每次从星芒打开 Codex 之前（最多等 3 秒；名单好好的时候先不拿写配置的锁看一眼，不排在别的写入后面）、开机那次（`guardCodexModelCatalogAtStartup`，`main.ts` 开机后调，没登录也做；登录状态下开机那轮按账号同步共用这一次）。名单文件丢了、读不进，或读它的命令行 / 桌面端太旧时收回。命令行与桌面端版本 30 秒内复用一次探测（系统时间往回拨也重探），星芒自己装卸过就作废；装好命令行或桌面端之后当天那次核对也作废（`toolModelChecker.forget`），版本够了下次打开就按账号补上。
- 顺带修 #562 起（0.2.12、0.2.13 都带着）的老问题：打开前核对刷新菜单时，`refreshPicker` 把核对的 `assertCurrent` 交给 `saveConfig`，而 `saveConfig` 写之前先把来源记录改成「手动」，`assertCurrent` 按来源记录认人，于是每次都在写到一半时报「账号已变化，这次核对作废」，Claude Code 菜单一次没刷成过，来源记录还停在「手动」（之后账号切换、换分组都不再自动改 Claude Code 的 Key）。核对新增 `identity` 依赖，只给交到 `refreshPicker` 手里的 `assertCurrent` 用，认人只看站点、账号、Key、型号；写之前的几道核对照旧要求来源是当前账号，写入当中由 `saveConfig` 的自动写入那道闸进锁时把关。已经被改成「手动」的旧配置这次不自动改回。
- 已知限制：随包名单要随 Codex 推荐版本一起换（`docs/CLI-VERIFIED-VERSIONS.md` 每周巡检一节）；中转开了随包名单里没有的新 GPT 型号，下一版带上新名单之前菜单里看不到；自己填写密钥的配置不会被自动重写；IDE 插件自带的 Codex、不在 PATH 上的另一份命令行太旧时星芒看不出来，正式版和 Beta 版桌面端同时装着时只按正式版判断；卸载星芒不收回这一行（与 Key 一样留着，Codex 照常能用，只是名单不再更新）。桌面端菜单在 Windows / Mac 真机上还没看过。
- 新增 `electron/macos-desktop-app-installer.ts`：Mac 上外部桌面客户端的一键安装，目前只收录 OpenCode。
  官方 feed（GitHub Releases 的 latest.json）只取版本号，包地址按版本号自己拼，并要求 feed 里写的正好是它；
  每一跳重定向都限定在 `github.com/anomalyco/opencode/releases/` 与 GitHub 的两个附件域名（同 `git-runtime-install.ts`，I10）。
  下载走 `downloadWithResume`（断点续传、体积上限），解压用 SIP 下的 `/usr/bin/tar` 到产品目录里的私有暂存，
  再核对：只有一个 `OpenCode.app`、bundle id、`LSMinimumSystemVersion` 对 `sw_vers`、`codesign --verify --strict --deep`
  钉死 Developer ID 团队 `5NZ4Q7NXJ4` 与 bundle id（按退出码判定）、`spctl --assess`（公证）。全过才 `rename` 进
  `/Applications`（不可写时 `~/Applications`），跨卷时 `ditto` 到隐藏的临时名再改名，上次拷到一半被打断留下的隐藏副本
  下次安装前清掉；同名应用一律不覆盖。不加隔离属性：Gatekeeper 首次打开要做的判定 `spctl` 已经做过。
  不钉哈希：这些应用自己会升级，签名才是跨版本不变的身份。
- `electron/external-client-runtime.ts`：Mac 上 `installSupported` 只对上面那张表里的客户端、且非 root 时为真；
  安装前先查磁盘空间，下载包在临时加速线路里（`system-service.ts` 传入 `downloadFetch` /
  `withDownloadAcceleration` / `assertInstallDiskSpace`）。WorkBuddy、Claude Desktop 和 Codex 桌面端在 Mac 上不变，
  仍是「安装指南」：沙箱里拿不到能核对的官方 Mac 包。
- 失败文案集中在 `electron/macos-desktop-install-failure.ts`（零依赖，主进程拼、渲染层认）；
  `operation-error.ts` 新增 `macDesktopInstallFailed` / `macDesktopTooOld` 两类和「看安装指南」按钮，
  排在网络规则前面。装到一半写满磁盘（ENOSPC，或 tar / ditto 报 No space left on device）照直说磁盘空间不足，
  归「磁盘空间不够」；解不开的包报「没装好」，不说成不是官方原版。错误类名以 `Error` 结尾
  （`MacosDesktopInstallError`），渲染层剥 IPC 前缀时才会连类名一起剥掉。
  教程「Mac 上装桌面端」一章改成 OpenCode 一键、其余三个照旧自己下载。
- yoyo 2026-10-02：自动连的加速「不在游戏加速那边体现」，结束后要断开。`acceleration-service.ts` 新增
  `userAccelerationState` / `createUserAccelerationApi`，IPC 与托盘改用后者：带 `autoStartedBy` 的会话一律显示成
  未连接（时长用完的显示用完），用户点停止走 `stopUserAcceleration` 不碰它。到期提醒、意外断开提醒、诊断、
  Codex 桌面端守护仍读真实状态。
- `acceleration-development-backend.ts`：用户自己点开始时连着的是不计时的那一次，停掉它重新连一次计时的
  （时长用完的原样返回）；不计时的会话连不上、意外断开、撞上冲突都不写 `lastErrors` / `lastConflicts`，免得加速页
  冒出一句他没点过的失败。线路检测撞上后台那一次时，服务层改说「Codex 桌面端正在后台用加速，暂不能检测线路。」
- `codex-desktop-acceleration.ts`：新增 `onlyNeededAtStartup`（`main.ts` 判 Codex 配置指向当前站点且
  `auth_mode` 为 apikey、连接名没被官方保留名顶掉），为真时连续两次确认桌面端在跑（约两分钟）就断，否则照旧等它
  退出。断开改走 `stopAutomaticAcceleration(scope, connectedAt)`，只断自己那一次，用户中途接手的不断（日志
  `acceleration.codex-desktop.handed-over`）。
- 删掉加速页与托盘上「打开 Codex 桌面端时自动连上的…」「自动连接不计时」「已自动连接 · 不扣时长」三处，
  「游戏加速」教程同步改写。
- 同一版 #755（`codex-desktop-late-acceleration`）那两句用户说明「关掉桌面端后都会自动断开」「改为『自动连接不计时』」
  已不成立，汇总进更新说明时以本条为准。
- Claude Desktop 的连接自检（保存后复测与检查页同一条路）从 `GET /v1/models` 改为照抄 2.9939.4 网关启动探测的那条请求：`POST /v1/messages`、`Authorization: Bearer`、`anthropic-version: 2023-06-01`、内容 `.`、`max_tokens: 1`（`connection-check.ts` 的 `gatewayMessagesShape` / `buildGatewayMessagesProbe`，`external-client-connection.ts` 的 `probeFor` 按客户端穷尽分派）。
- 原因：桌面端网关探测对静态密钥的 401 与 403 一律报「The provider rejected your credentials」（`LUt(403, 有 expiryHint)` 为假，不算「授权不足」）；new-api 查模型清单不走计费，账号余额不足时清单 200、消息 403「用户额度不足」，旧自检因此假绿。归因沿用 CLI 共用的 `classifyConnectionResponse`，403 带额度字样落到「额度」层。
- WorkBuddy / OpenCode 仍查模型清单、不花额度。成功结论的 evidence 按客户端写明问的是哪一句（`verifiedWording`）。

## 0.2.13 - 2026-10-01

- `main.ts` 的账号 `onChanged` 改为身份（站点 + 用户 + 会话代数）真的变了才调 `acceleration.onAccountChanged()`；此前任何登录态变化都会推进加速代数，在途的 get-state 报「账号已变更」并顺带停掉正在跑的加速。身份比较抽到 `account-identity-tracker.ts`，补单测。
- 修稳 `electron/acceleration-development-host.test.ts` 的「proxy recovery retries」一组：等待真实
  lstat 的那几处原来最多等 200 轮 setImmediate 就往下走，CI 忙时下一次推进假时钟发生在重试定时器
  排上之前，最后一次重试永远不触发（10-1 #730、#734 各红一次）。改成等到那一步真的发生，
  只保留「确认不再发生什么」那几处的有界等待；被测代码不变。
- `new-api-client.ts` 的 `performRequest` 在超时 / 代理连不上 / 连接被断（network-failure 的 timeout、proxy、refused）后问一次宿主 `retryOffProxy`；宿主在 `main.ts` 接到 `proxy-bypass.ts` 新增的 `recoverFailedRequest`，复用 #578 的直连兜底（系统代理不是 DIRECT、星芒加速没开、探测通了才改，本次运行保持直连，不落盘），并记 INFO `network/proxy-bypass.account-retry`。以前这个兜底只在渲染层判成「代理」类且已登录时触发，客户「代理活着但不转发」报的是超时、开机恢复登录又是未登录态，都碰不到它。
- GET 直连重发一次；登录、建 Key、付款等非 GET 只在代理本身拒绝隧道（请求确定没出本机）时重发，超时 / 连接被断只切直连不重发，防止重复提交。直连也不通后，请求触发的自动尝试停 5 分钟，「重新检测」不受限。不碰证书校验；`sub2api-relay-backend.ts` 未改。
- `Shell.tsx` 状态栏未登录时沿用 `account.displayName`（恢复中 / 联不上等重试时 App 放的是「正在恢复登录」「暂时连不上，登录还在」）；`Home.tsx` 新增可选 `accountRestoring`，App 按 `sessionRestoring` 传入。
- `provider-sessions.ts` 新增 `codexSessionTitle`：Codex Automation 的标题（「Automation: 名字 Automation ID: …」整段任务说明）只留任务名，其余标题折成一行、限 160 字；首页「最近」标题加单行省略号。
- `inspectCliUpdate`（electron/system-service.ts）同 #729：只用 `findInstalledExecutable('npm')` 查 npm 路径，不再走 `inspectTool('npm')` 多起一个 `npm --version` 子进程；路径仍每次现查、不缓存。找不到 npm 时传下去的仍是 `null`，结果与之前一致。
- Claude Desktop 第三方推理配置的 `inferenceModels` 改回只写所选的一个型号（0.2.8 的做法），撤回 #685 的
  `buildClaudeDesktopModelList`。0.2.12 起写入当前 Key 可用的全部 `claude-*` 型号（最多 20 个），客户 Mac 上
  Claude Desktop 提示型号被拒、对话无回复，换回 0.2.8 后恢复。代价是 Desktop 型号菜单只剩所选的一个。
- 新增 `electron/cli-native-package.ts`：按包自己的 `optionalDependencies` 找本平台的原生包（Claude Code 的 `-darwin-arm64` 等、Codex 的别名包），装完在暂存前缀里核对它真的在，缺了就记 `cli.install.native-package-missing` 并让这个源失败、换下一个源；非托管安装在最终校验时再查一次。根因：npm 下载可选依赖失败时静默跳过、退出码仍为 0，原来只核对版本号（10-1 客户 Mac 两步都只 `added 1 package`）。npm 11.19 的 allowScripts 提示只是警告，postinstall 照常执行，不是原因。
- `codex-desktop-cdp.ts` 的 `injectCodexDesktopChineseLocale`：调试端口归属查询（`Get-NetTCPConnection`，限时 10 秒）抛错或超时，不再把整次注入带出循环，改按「这一轮没法确认」处理：这一轮什么都不发（同端口未绑定），在原 20 秒窗口里下一轮再查；连续 3 次答不上才停，免得 PowerShell 起不来的机器每半秒起一个进程；端口归别的进程照旧立刻取消。停下时报 `这次没能确认 Codex 已经准备好`，不再把 execFile 的 `Command failed: …powershell.exe … -EncodedCommand …` 原样带进「未确认中文界面生效」提示。
- 起因：2026-10-01 PR #745 那轮 Windows 打包冒烟里这项查询 10 秒没答上（同一分钟其它无关检查也慢 2 到 15 倍，重跑 1.5 秒）。当天 52 轮打包里它中位 1.7 秒、最慢的非失败轮 7.6 秒，是 33 项探测里离上限最近的两项之一；第一次查要冷启动网络连接表，在 App 里又正赶上 Codex 自己启动。与 #743 无关。
- `diagnostics.ts` 的 `PROXY_ENVIRONMENT` 新增 `resolveAppProxy` 依赖：宿主交给 `session.defaultSession.resolveProxy(accountBaseUrl)`，即账号请求（net.fetch）真正走的路由，已含系统设置里的 HTTP / HTTPS / SOCKS / PAC，不起外部命令、不读注册表；解析复用 `download-proxy.ts` 的 `parseChromiumProxyResult`，本机端口复用 `probeLoopbackProxy` 试连。加速开着时不看（那是星芒自己设的）。详情只写本机端口或「别的机器」，不写地址（I13）。起因：2026-10-01 客户 Mac 开着别的代理，账号请求全超时，自检却报「没有另外设过代理」。
- 开机自动装前的 5 秒预告不再只靠系统通知（第二十四批 ⑥）：`UpdateSnapshot` 加可选 `launchInstallNotice`（版本、标题、正文、预计开装时刻），`UpdaterService.setLaunchInstallNotice` 写入；`main.ts` 发系统通知的同时写进快照，情况变了或出错时收回。快照离开 `downloaded` 或安装器报错时在 `emit` 里统一清掉。渲染层 `features/app/LaunchInstallNotice.tsx` 经 `StartupNotices` 的 `leading` 插槽放在开机角落，带倒数、不可关。自动装开关与 5 秒时长不变，没加 IPC 通道。
- 新增 `electron/macos-shell-profile.ts`：Mac 上装完 / 更新 CLI 后往当前用户的 `~/.zprofile` 末尾追加一段带标记的 PATH 设置（托管 npm bin、`~/.grok/bin`、星芒代下的 Node，全部追加在原 PATH 之后，`case` 防重复），已有标记就不动；只追加不重写，经 `readSafeUtf8File` / `appendSafeUtf8File`，`~/.zprofile` 是符号链接或多链接时拒绝并只记日志（I8）；登录 shell 不是 zsh 的不写（建 `~/.bash_profile` 会让 bash 不再读 `~/.profile`）。
- 打开软件后的第一轮检测：Mac 上检测到星芒托管目录里的安装且从没处理过时补一次，处理过就在产品目录留 `terminal-commands-added` 记录，客户自己删掉那段后不会每次开软件又加回来；装、修复、更新工具时照常再确认。
- 卸载工具时不删这段：指向不存在目录的 PATH 项无害，重装后直接可用，也和 Windows 卸载托管工具不改 PATH 一致。
- `createCliTerminalAccess` 加 `ensureShellProfile`，`system-service.ts` 新选项 `ensureMacosShellProfile` 只由 `main.ts` 在 darwin 接真实现；失败只记 `cli.shell-profile.failed`，不影响安装结果。
- `codex-desktop-acceleration.ts` 去掉 `onAutoConnected` 回调，主进程不再发 `accelerationAutoStarted` 通知，该通知种类一并删除；测试用 `@ts-expect-error` 钉住这个口子不再出现（yoyo 2026-10-01 定「悄悄连」）。
- `acceleration-interruption-notice.ts` 记下会话是否 `autoStartedBy`：自动连的会话意外断开且网络已改回（restored）只记 `acceleration.interrupted.quiet` 日志；unrestored 照旧提醒。
- `system-service.ts` 的 Python 安装包进 `withDownloadAcceleration`，并把 `downloadFetch` 注入 `python-runtime.ts`（原来用 Node 自带 fetch，不认下载专用线路，也不读系统代理）。
- `codexPluginCatalogNetworkMessage` 去掉「打开加速后再点」：插件目录下载早已自动借下载专用线路。
- 教程「为什么有时会自动连接？」与通知设置说明同步到现状（原文还停在「开始计时、关掉不会断开」）。
- 强制更新门（`required-update.ts` / `RequiredUpdateGate.tsx`）的失败标题与重试按钮改读 `registry/business.ts` 的 `updateFailureLabel`，和更新页、首页气泡同一份；原因句过 `userFacingErrorMessage`。开机检查超时那句（「不影响现在使用」）只在门里按 `STARTUP_UPDATE_TIMEOUT` 换说法，气泡和更新页不变。
- `electron/updater.ts` 的原因句改成三处都成立的说法：兜底句不再提「查看日志」，安装器没起来的看门狗不再说「软件照常能用，到「更新」页」，清单缺失、服务器回网页、安装包校验四条去掉 latest.yml / SHA-512 等词，原话挪进 `error.detail`（照旧进 runtime.jsonl）。
- `StartupNotices.tsx`：同时最多摊开 `STARTUP_NOTICE_VISIBLE_LIMIT`（2）张；`leading` 改成数组，开机安装倒数卡（#733）和维护提示始终摊开、不可折叠，各占一个位置；`orderStartupNotices` 按无缺省的 `Record<StartupCheckId, number>` 排先后（要选的 → 出事的 → 有空看的 → 纯告知），同档保持先来后到，新增提示类型时编译器会要求给它排位；多出来的折进「还有 N 条提示」按钮（`startup-notices-toggle`，带 `aria-expanded`）。
- `shell.css`：`.v2-startup-notices` 加 `max-height: calc(100vh - 120px)`，卡片摞放进 `.v2-startup-notices-list` 在区内滚动；容器仍不吃指针事件，只有卡片区和折叠按钮吃。提示类型定义（`startup-notice.ts`）没动。
- `realm-account-service.ts` 开机恢复（restoreActive 的非 stalled 分支）第一次超时（`RealmAccountError('TIMEOUT')` 或 `NewApiNetworkError('timeout')`）后隔 `startupRetryDelayMs`（缺省 3 秒）再试一次，两次都超时才 markStalled 交给 30 秒那一轮；联不上、维护等其他失败不快速重试。仍在同一个 transition 的 30 秒 prepare 期限里。起因：A014 反馈报告里历史账号站点约四次请求就有一次超 10 秒，开机恢复撞上就要挂 30 秒「暂时连不上」。
- 接 #728：`src/renderer-v2/registry/tutorials.ts` Mac 运行环境章 Homebrew 一步补上打开终端的方法，「不知道 Homebrew 是什么」改大白话。防残留测试扩到教程示意图：新增 `features/tutorial/TutorialIllustration.test.tsx`，逐张渲染全部示意图（含读屏文字），不许出现 npm、PATH、TOML、环境变量与泛指的 CLI，图片清单用 `Record<TutorialIllustrationId, true>` 钉住、新增示意图漏测是编译错；`tutorials.test.ts` 的可见文案检查加上 PATH、TOML。第二十四批候选 ⑨ 收尾，只改文案与测试。
- `electron/updater.ts`：`download-progress` 时记最近 10 秒的进度样本（`recordDownloadProgressSample`，已下载量变少即视为重新开始、清空样本），样本跨度满 3 秒才给 `progress.averageBytesPerSecond` 与 `progress.secondsRemaining`；两个字段可选，缺省＝只显示已下载/共多少。原样转发的 `bytesPerSecond` 不变（legacy 仍读它）。
- `src/renderer-v2/registry/business.ts` 新增 `updateDownloadDetail` / `formatDownloadBytes` / `formatDownloadRemaining`，剩余时间按 10 秒、分钟粗取整，免得每秒跳数字；更新页（`pages-maintenance.tsx`）与强制更新门（`required-update.ts` 的 `progressDetail`、`RequiredUpdateGate.tsx`）读同一份。
- `acceleration-development-backend.ts` 的 `startDownloadRoute` 去掉「免费时长用完就返回 unavailable」的门槛（yoyo 2026-10-01 回「放开」）；仍不写免费时长账本，加速页照旧显示用完。测试改钉「用完后照样起、账本不变」。

## 0.2.12 - 2026-10-01

- Codex 桌面端自动加速的退出守护：连续三次确认桌面端在跑后，探活间隔从 1 分钟放宽到 3 分钟，
  查到不在或查不出来立即退回 1 分钟（`codex-desktop-acceleration.ts`）。Windows 上每次探活要起
  一个 PowerShell，人一直开着桌面端时次数降到约三分之一；代价是关掉后最多晚约两分钟断开。
  守护本身已在 #707 改成只查进程的轻量探测，这次只调频率。
- `useChatController.ts` 去掉聊天页激活时每 30 秒的 `listGroups` 定时器（第二十四批 7），只在进入页面、窗口获得焦点/变为可见、点开分组下拉框、手动刷新与重试时拉；分组被撤销由发消息前 `chat-credential-coordinator.ts` 的 `resolveOperation` 核对兜底。`balance-store.ts` 重新是唯一定时拉服务端数据的地方。浏览器回归改成断言可见且有焦点时 10 分钟内不再轮询。
- `codex-desktop-cdp` 的调试端口归属查询：开头按名字导入 Utility、NetTCPIP（收紧环境下靠自动加载要整套扫描，
  CI 上跑满 10 秒上限），末尾补 `exit 0`（端口还没人监听时 `Get-NetTCPConnection` 的「找不到对象」被
  `SilentlyContinue` 压住，但 powershell.exe 仍以 1 退出，「尚未就绪」变成整次中文增强中止）。真错误在
  `$ErrorActionPreference = 'Stop'` 下仍先于 `exit 0` 退出。问题自 #179 起就有。
- #695 之后 Windows 版 Grok 不装 Node.js，钩子脚本 `xingmang-hook.cjs` 找不到 node 就不写，Grok 缺做完通知和防睡，装了 Node 也不会补。`config-files.ts` 的 `ManagedCliHookRewrite` 加可选 `addIfMissing`（只给 Grok，推到 cmd 不写）；`system-service.ts` 新增纯函数 `grokCliHooksMissing` 与 `addMissingGrokHooks`，在装好运行环境后、打开 Grok 前、每次启动（本账号那份）各补一次，配置快照多带 `cliHooksMissing`，首页 Grok 行给「补上」（没运行环境先准备它，有了就走「修好它」同一条路，`repairCliHooks` 对 Grok 一并补）。没做「不依赖 Node」的原生写法：RunAsNode fuse 关着，改写成 PowerShell / sh 两套脚本要各自在真机核，改动面和风险都更大。
- `syncXingmangAiSkill` 新增 `imageMcpWarnings`（不带前缀的原因）和 `imageMcpRetryDelayMs`；画图 MCP 登记失败先自动重试一次（缺 Node 不重试）。`account:sync-managed-cli-keys` 在技能就绪时也把 `describeImageMcpWarnings` 生成的人话放进新字段 `imageMcpWarning`，renderer-v2 的 `account-bootstrap.ts` 并入首页警告（自带「重新同步」）。用新字段而不复用 `imageSkillWarning`，是为了不改冻结的 legacy 界面行为（它对 `imageSkillWarning` 弹错误 toast）。第二十四批候选第 4 条。
- `launchProviderOperation`（electron/system-service.ts）打开 CLI 前只用 `findInstalledExecutable('npm')` 查 npm 路径，不再走 `inspectTool('npm')` 多起一个 `npm --version` 子进程；路径仍每次现查、不缓存，装 / 卸 / 换 Node 后不会拿到旧答案。第二十五批候选 ④。
- `src/renderer-v2/features/shell/promo-announcements.ts`：`resolvePromoKind` 不再只看标题含「充值 / 邀请」。
  标题须带一个好处类的字（活动、送、赠、优惠、折、礼、返、福利…）才算活动；带维护、暂停、故障、延迟、
  调整、取消等字的一律不算，排除优先。`isRechargePromoTitle` 改为同一判定。大卡片、系统通知、每日提醒、
  红点、活动条都从 `activePromos` 走，一处改全跟上。
- 截止时间：引导词加「有效期」「即日起」；引导词后跟区间时取后一个日期；「10月1日-7日」后半段借前半段的
  月份（后一天须更大、必须带「日 / 号」，免得把「-7折」认成日期）；日期在前的「X日前 / 之前 / 截止 / 结束 / 止」
  放在最后认，避免把「10月10日前到账」当成活动结束。认不出来仍按发布后 7 天兜底，120 天上限不变。
- 修 #698 强制更新门与 #683 下载前量盘没接上：`updater.ts` 的 `download()` 量盘不够时只挂
  `diskShortfall`、不抛错，门却照旧给「立即更新」，点了没有任何变化。`required-update.ts` 读
  `diskShortfall`（按钮改「空间够了，再试一次」，不自动接着下）；`RequiredUpdateGate.tsx` 复用
  更新页的缺口说法、清理步骤与「仍要下载」（`ignoreDiskSpace`）；清理步骤从
  `registry/tutorials.ts` 拆出 `updateDiskCleanupSteps`，门里不说「回到更新页」。
- 配置模板加版本号 `relayTemplateRevision`（`electron/config-files.ts`），记进工具配置来源记录的 `templateRevision`；完整保存时记当前版本。新增 `fillRelayTemplateDefaults` / `relayTemplateDefaultsPending`：只补缺省键，配置不指向当前账号服务就不动，写入沿用 `executeFilePlans` 两阶段提交与 `.bak`。
- 新通道 `config:fill-template-defaults`（ipc-contract / preload / ipc 三处同序，紧跟 `tools:check-models`）：主进程只处理来源为 `account`、版本落后的配置，先 `inspectRunningTools` 跳过开着或看不出的工具，补之前建一份 `pre-save` 备份，已经齐了只抬版本号不留备份；失败记 `template-defaults.failed` 日志、版本号不前进。
- renderer-v2 在 `restore` 模式的账号恢复结束后调用，真补了才出角落卡片（`startup-notice` 新 id `template-filled`）。加项规矩写在 `docs/CLI-VERIFIED-VERSIONS.md`「老客户的配置怎么跟上这张表」。
- 新增 `src/renderer-v2/features/account/topup-tier.ts`：`describeTopupTier` 把档位、服务端试算的实付和赠送规则换成卡片三行；`useTopupQuotes` 逐档串行调用 `account:quote-topup`（最多 16 档，自定义金额停止输入 500ms 后再算）。充值信息一重新加载，旧结果整批作废；试算失败时只隐藏实付，不报错。易支付渠道的实付标 ¥，其余渠道不标币种。
- 两种账号的档位含义不同。new-api 档位是到账额度，赠送读 `discount`。Sub2API 档位是实付金额，到账 = 档位 × `balance_recharge_multiplier`。`NewApiTopupInfo` 新增可选字段 `creditMultiplier`，只由 `sub2api-relay-backend.ts` 的 `parseTopupInfo` 填写，非有限正数一律按 1 处理，和 Sub2API 自己的页面一致。
- 新增 `features/account/payment-method-label.ts`：后台没填显示名、接口只回渠道代码时，换成中文渠道名。没有新增 IPC 通道。
- `electron/application-tray.ts`：托盘快照的 `updateAvailable` / `updateVersion` 换成 `update: TrayUpdateEntry`，由新纯函数
  `resolveTrayUpdateEntry(UpdateSnapshot)` 按阶段给出 available（含 `diskShortfall` 时「等电脑腾出空间」）/ downloading /
  downloaded / failed。原来只认 `phase === 'available'`，自动下载开着时这个阶段只停几秒，常驻托盘的人几乎看不到。
- downloaded 那一项点击走新增的可选 `onInstallUpdate`，`main.ts` 接到 `updaterService.install()`——和更新页「确认重启安装」、
  IPC `update:install` 是同一条路，退出交接、安装闸、强制更新与 Windows 提权逻辑都不变，也不改自动安装默认值。
  带错误的 downloaded（安装器起过又失败，安装闸已关）与下载失败归为 failed，只打开更新页；检查失败不显示版本。
- 第二十四批候选 ⑩。
- #714 / #716 / #718 同一个根因的收尾：全仓所有在 `trustedCommandEnvironment()`（或同样把 PSModulePath
  收窄到 System32 的 `windows-machine-paths` ACL 探测）下跑、又调用了引擎核心以外命令的 PowerShell 脚本，
  开头都按名字导入自己用到的模块。涉及 `cli-process-probe`、`diagnostics`（检查页 Codex 桌面端）、
  `codex-desktop-cdp`（端口探测、激活）、`external-client-runtime`、`uninstall-cleanup`、
  `claude-desktop-manifest` / `-policy`、`stale-proxy-environment`、`platform/windows-system-proxy`、
  `node-runtime`（待重启、App Installer、两条签名核对）、`python-runtime`、`workbuddy-installer`、
  `trusted-native-cli`、`trusted-temp`（受保护目录 ACL 回读）、`windows-machine-paths`（两条 ACL 探测）、
  `windows-elevation`（打开工具的中转脚本与终端脚本）。没放宽环境、没调任何上限。
- 签名核对原本用 `Join-Path $PSHOME ...` 导入 Security，而 `Join-Path` 本身就在 Management 模块里，
  这一句就会触发整套扫描；改成字符串拼路径（`buildPowerShellPinnedModuleImportStatement`），保留
  `-Force -ErrorAction Stop`，并把 ConvertTo-Json 所在的 Utility 一起按同样方式导入。
- `buildPowerShellModuleImportStatement` 挪进新的叶子模块 `powershell-module-imports.ts`（`windows-machine-paths`
  也要用，放在 `windows-elevation` 会成环），模块名只认字母数字和点，其余直接拒绝。它现在总把
  `Microsoft.PowerShell.Utility` 排在第一个（没写也补上）：CI 上实测 Utility 还没加载时，导入
  CimCmdlets / Appx / NetTCPIP / StartLayout 这一句本身就要二十多秒（关掉自动加载也一样），Utility
  在前则约 0.5 秒。
- 新增 `powershell-module-imports.test.ts`：二十多条脚本逐条把命令对到模块、逐个去掉一个导入确认会红、
  不多导；另钉住四条不调命令的脚本保持不调。打包作业冒烟里这些探测按各自上限在收紧环境下做真检查并打印
  耗时，另关掉自动加载各跑一遍，漏导入的命令按名字打印；该步骤上限 6 → 12 分钟。
- 没动的：`windows-elevation` 的 Add-Type 令牌探测（提速清单 A1）、Codex Appx / Node.js 的提权安装中转
  （15 分钟或不限时，提权子进程环境另算）、`knownFoldersFromWindows`（PSModulePath 为空的兜底路径）。
- `src/renderer-v2/registry/tutorials.ts` 进阶章与 Mac 运行环境章泛指的「CLI」改「命令行工具」（Codex CLI 等产品名保留），删去 npm 字样与过时句；顺手改正下载章里引用的旧章名「Mac 上装 Node.js 和 Python」。`TutorialIllustration.tsx` 安装示意图运行环境一行去掉 npm，两段说明与启动示意图里的「CLI」改成大白话。`tutorials.test.ts` 新增断言：教程可见文案（keywords 除外，搜索仍可用）不含 npm 与泛指的 CLI。第二十四批候选 ⑨，只改文案。
- 新增 `src/renderer-v2/features/app/update-retry.ts`：`retryFailedUpdateStep`（按 `failedStep` 分派：check 重查、download/旧快照先查再下、
  install 回确认框）与 `redownloadUpdate` 原来写在 `UpdatesPage` 里，现在更新页与首页气泡共用这一份，不各算一遍。
  气泡点「重新安装」经 `requestUpdateInstallConfirm` 跳到更新页并弹同一个「重启并安装更新？」确认框（更新页隐藏不卸载，所以既留待取请求也通知已挂着的页面），不在气泡里直接重启。
- 首页气泡正文改用 `userFacingErrorMessage`（与更新页一致，去控制字符、路径脱敏）。
- `electron/updater.ts` 开机 8 秒超时的 `STARTUP_UPDATE_TIMEOUT` 文案改成客户能读懂的话；`updateFailureTone` 让这一种用 warn 色（真正的请求仍在后台跑，晚到的结果会清掉错误）。
- 第二十五批候选 ②⑧。候选 ①（网络类 / 开机超时 / 定时检查失败不弹气泡）未做，待拍板后在 `update-retry.ts` 加判断即可。

- 跟 #716 同一个根因、同一个修法，补到 `codex-desktop-service.ts` 里其余的 PowerShell 脚本：开始菜单探测、
  扫描和关闭用的进程列表、「打开」与加速用的会话进程列表、Appx 包探测（各 8 秒上限），以及安装包检查
  （90 秒）、卸载、重置（各 2 分钟）。它们都跑在 `trustedCommandEnvironment()` 下，任一条命令走自动加载
  就要约 22 秒；Appx 包探测是安装、更新、卸载、重置的第一步，超时会直接报「读不到安装信息」。
- 每个脚本开头按名字导入自己用到的模块（导出的 `codexDesktop*Modules` 常量），没放宽环境、没调上限；
  导入失败退回自动加载即旧行为。开始菜单与卸载脚本抽成 `buildCodexDesktopStartAppProbeScript` /
  `buildCodexDesktopUninstallScript` 以便单测；8 秒上限收成 `codexDesktopSingleProbeTimeoutMs`。
- 单元测试把这八个脚本里的每条命令对到模块，并逐个去掉一个导入确认会红；打包作业冒烟里四条单独探测
  在收紧环境下按 8 秒上限做真检查，另把自动加载关掉各跑一遍，漏导入的命令按名字打印出来。
- Codex 桌面端合并探测（开始菜单 + 进程 + Appx 三段一条脚本）在 `trustedCommandEnvironment()`
  下要 23～29 秒，上限 24 秒：CI runner 上 #714 之后的打包作业实测 29.1 秒，正式代码里会超时。
  原因同 #714：收紧环境下任一条 cmdlet 走自动加载就要重建整份模块分析（约 22 秒）。#714 试过先导入
  Management / Utility / CimCmdlets / StartLayout 四个模块不见快，漏的是 `Get-AppxPackage` 所在的
  `Appx`——只要还有一个模块靠自动加载，代价就一分不少。
- 修法：`buildCodexDesktopCombinedProbeScript` 开头按名字导入 `codexDesktopCombinedProbeModules`
  五个模块（含 Appx）。仍只经收紧后的 PSModulePath 解析，没放宽环境变量，也没调大 24 秒上限；
  导入失败退回自动加载即旧行为。
- 单元测试把脚本里出现的每条 cmdlet 对到模块名，新加 cmdlet 忘了导入会红；打包作业冒烟里合并探测
  在收紧环境、按它自己的 24 秒上限变成真检查，另把自动加载关掉再跑一遍，漏导入的命令会按名字报出来。

- Windows 的 renderer-v2 浏览器分片拆成两片：`test:v2:browser:fixture`（共用默认 Vite 依赖缓存的
  browser-check 与最后的 app-check.mjs，顺序不变，上限仍 18 分钟）和 `test:v2:browser:e2e`（两份
  自带 cacheDir 的 e2e 套件，上限 10 分钟）。原来整片在 #712 上跑了 17 分 18 秒，在 #714 上两次
  撞满 18 分钟（超时前用例全过）。不跳过测试、不调上限；`ci-workflow-config.test.cjs` 钉住两片之和
  等于 `test:v2:browser`、fixture 片保持原顺序且 app-check 最后、离开的套件必须自带 cacheDir。

- 接手 #667：新增 `xingmang-image` stdio MCP（`bundled-skills/xingmang-ai/scripts/mcp-server.mjs`），支持文生图与改图（`/v1/images/edits`，原图只收绝对路径下的单链接 PNG/JPEG/WebP，按内容判定类型），先用 Codex Key、被拒再换生图分组 Key，上游报错里的 Key 打码。
- 登记改为直接写各家配置（`config-files.ts` 的 `syncXingmangImageMcpConfigs`），不再依赖 `codex mcp add`：Codex/Grok 写 `config.toml`（`tool_timeout_sec = 300`，Codex 只对这一个工具写 `approval_mode = "approve"`），Claude Code 写 `~/.claude.json` 并在 `settings.json` 的 `permissions.allow` 只加这一个工具，Gemini 写 `settings.json`（`timeout` + `trust`）。只写已存在的配置目录；同名但不是本软件写的条目不动；Node 换了位置会自动改指。
- 修掉 #667 原提交里 `test:scripts` 丢掉的 `publish-dl-landing` 与 `dl-landing-install-guide` 两个测试，以及只在 Windows 上成立的路径断言。
- 修 `scripts/verify-packaged-hardening.test.cjs` 在忙的 CI 上偶发红（#691、#703 各撞一次，指纹「随包更新说明或 package.json 不是有效的 JSON」）。根因在 `@electron/asar` 3.x：`createPackage()` 调完写流的 `end()` 就返回，不等写完，紧接着 `extractFile` 偶尔读到还没落盘的文件体（全 0），被当成坏 JSON。新增 `scripts/asar-fixture.test-support.cjs` 的 `createSettledPackage`：打包后等归档长度达到它自己头部声明的长度再返回（写流按顺序追加，长度够了就是全部写完）。打包校验、macOS 产物校验两份测试与 `e2e/asar-tamper-smoke.mjs` 都改用它；打包校验夹具另把归档放到被打包目录之外。校验脚本本身不改：生产上归档由打包进程写完退出后才校验，不受影响。
- 自动加速不计入免费时长（yoyo 2026-09-30 定）：`acceleration-development-backend.ts` 新增 `startAutomaticAcceleration`，会话带 `billed: false`，不写账本 `startedAt`、不定到期、停止时不结算，时长用完也放行；状态带 `autoStartedBy`。host / worker 新增 `start-automatic` 通道（不进 `AccelerationApi`，渲染层要不到不计时的连接）。
- `codex-desktop-acceleration.ts` 连上后每分钟问一次桌面端还在不在（`probeCodexDesktopRunning`：Windows 走会话进程探测、macOS 走 osascript，查不出来记 null 不当「已关」），连续两次不在或连续十次查不出来就断开；只断自己连的那一次，用户停过或重连过就不管。
- 加速页、托盘、到期提醒与通知文案跟着改：自动连接期间剩余时长不倒数、不触发「还剩 5 分钟 / 已用完」提醒。
- CI：linux-test 装 Chromium 系统库改由 `scripts/ci-install-chromium-deps.sh` 执行。第一次尝试超时后，先以 root 清掉 sudo 起的、timeout 杀不到的 apt/dpkg 残留，等 dpkg 锁放开再重试；首次限时从 4 分钟放宽到 6 分钟。#695 两次尝试都白费就是因为第一次的 apt-get 活了下来、攥着锁。
- CI：linux-test 把「下载测试浏览器」和「apt 装 Chromium 系统库」拆成两步，后者单独限时 10 分钟、每次尝试 4 分钟、失败重试一次，并给 apt 设网络超时。#653 两次整作业卡在 `apt-get update` 满 30 分钟被取消、一条测试没跑，同一小时别的 runner 这步只要 25 秒；现在镜像卡住只会重试一次再明确报错，不再吃掉整个作业。
- 第二十二批 6（CI 假红）。单元测试不再自己起 PowerShell：`codex-desktop-service.test.ts` 的四条（进程探测、合并探测、两条喂假 WMI 的关窗 / 打开探测）和 `external-client-runtime.test.ts` 的两条（假注册表下的外部客户端清单、已记住签名的解码）搬进新的 `e2e/windows-powershell-probes-smoke.mjs`，在 `windows-package` 作业编译之后对编译产物各真跑一次，每条单独 90 秒预算并打印耗时，步骤兜底 6 分钟。`windows-store-app-launch.test.ts`「reads the current account on Windows」（9-30 在 runner 上每次跑满 90 秒拿回空 SID）同样改成查脚本文本和解析，真跑那一遍进冒烟；冒烟另外把正式代码走的那条路（`trustedCommandEnvironment` 下的同一脚本、`inspectWindowsStoreAppLaunchContext` 本身）各跑一次、只打印结果和耗时，为「单独起的探测为什么卡满预算」留证据。单元测试那边改查生成的脚本文本（`scanPowerShell` 引号括号）和解析函数，外部客户端那条改用夹具喂运行时。
- `scripts/ci-workflow-config.test.cjs` 新增门禁：`electron/`、`src/` 下的测试文件不许直接用 `execFile*` / `spawn*` / `runCommand` 起 `powershell.exe`；冒烟必须在编译之后、带步骤超时。
- `workspace-guard.ts` 新增 `resolveRememberedWorkspace`：设置里存的 `workspace` 不是主目录（从没选过时的默认值，另按 `os.homedir()` 再核一遍）、也不是任何敏感目录时才算「记住的文件夹」。`AppConfigSummary` 新增可选字段 `rememberedWorkspace`（`config:get` 带出，不加通道）。
- 渲染层 `recent-workspaces.ts` 新增 `launchWorkspaces`：这个工具有会话记录时照旧用记录，一条都没有时退回 `rememberedWorkspace`。首页按钮与下拉改用它。`CliLaunchResult` 新增可选 `rememberedWorkspace`，打开后随结果带回，`App.tsx` 直接写进快照，按钮马上换成新文件夹，不为这一个字段再读整份配置。
- 记住的文件夹后来被删掉时，沿用 N7 的退路：提示「上次用的目录已经找不到了」并弹选择器。
- 第十九批 7（只做提示，不做「退回上一版」）。新增纯模块 `electron/codex-desktop-known-issues.ts`：`codexDesktopKnownBrokenVersions` 表（目前只有 26.924.2738.0，上游 openai/codex #48946）+ `resolveCodexDesktopKnownIssue`（商店包版本与应用版本任一命中，末尾 `.0` 不影响）+ 两句文案；已登记进 `scripts/verify-renderer-boundary.test.cjs` 的 valueImportable。
- `describeCodexDesktopLaunchFailure` 多收可选的 `knownIssueVersion`，命中时在「等了 N 秒…」后接已知问题那句，替换「去开始菜单自己分辨」；内置 Administrator / 关了用户账户控制仍优先。渲染层 `operation-error.ts` 按 `codexDesktopKnownIssueMarker` 归到新类 `codexDesktopKnownIssue`（排在 `codexDesktopNotStarted` 前），按钮「重试 / 改用 Codex 命令行版 / 找客服」，新动作 `useCodexCli` 由 App 的 `switchToCodexCli` 处理（回首页；命令行版没装就开始装）。
- `model.ts` 的 `codexDesktopVersionAdvice` 不再对桌面端写死 null：命中已知问题表时给一份只有 `blockedReason`、没有推荐版本和退回的建议，首页桌面端那一行显示它。`codex-desktop-service.ts` 里「已装电脑不退旧版」的护栏没动。
- 上游出新版、真机核过能打开之后，下一版把表里那一行删掉（见 `docs/CLI-VERIFIED-VERSIONS.md` 末节）。没在真机上演过。
- 第二十一批 2。`windows-store-app-launch.ts` 新增 `inspectWindowsStoreAvailability`（异步 execFile，只读当前用户的 `Microsoft.WindowsStore` 包和 `RemoveWindowsStore` 两条策略键；查不出来返回 null，照旧先走商店）。`codex-desktop-service.ts` 安装入口与包探测并行调用它（可注入 `inspectStoreAvailability`），为 false 时跳过 `installCodexDesktopFromStore`，并且不再给出 `storeNewerVersion`；首页合并探测没动，不多起 PowerShell。
- `CodexDesktopInstallAttempt` 新增可选 `storeUnavailable` / `storeInstallerMissing`，进度前缀统一由 `describeCodexDesktopStoreNotice` 出。`codex-desktop-install-failure.ts` 新增 `unsupported` 原因（0x80073CFD / 原话里的「requires OS version」，排在 blocked 前）和 `codexDesktopNoStoreNotice`；渲染层 `operation-error.ts` 新增 `codexDesktopTooOld`、`codexDesktopInstallNoStore` 两类，前者只给「查看日志」「找客服」，后者没有「去微软商店装」。
- 0x80073CFD 的原话与「商店不在时 winget 那一步」都是推测，没在 LTSC 或老 Windows 10 真机上演过。
- 9-25 推荐帖「Codex 打不开时加『重置 Codex』按钮」。新增 IPC `desktop:reset-codex`（`ipc-contract.ts` / `preload.ts` / `ipc.ts` 三处，排在 `desktop:uninstall-codex` 之后），`codex-desktop-service.ts` 的 `resetCodexDesktop` 过 `InstallationQueue`（key `desktop:codex:reset`）并占用安装忙标志：先按包族名关掉 Codex 进程，再对 `Get-AppxPackage` 探到的包执行 `Reset-AppxPackage`（包名走 `powerShellLiteral`，脚本由纯函数 `buildCodexDesktopResetScript` 生成）。失败统一由 `describeCodexDesktopResetFailure` 指向系统设置里的同一个按钮，不出现技术词。
- 渲染层：`errors.ts` 的 `codexDesktopNotStarted` 按钮改为「重试 / 重置 Codex / 找客服」；`operation-error.ts` 新增动作 `resetCodexDesktop`，主进程说是系统自带 Administrator 或关了「用户账户控制」的那两种不给这颗（重置帮不上忙），正文也不提它。`App.tsx` 点了先弹确认框，重置完直接重跑刚才失败的那次打开。
- 没在 Windows 真机演过：`Reset-AppxPackage` 在普通权限下对商店装的 Codex 的实际效果、重置后首次打开的表现。
- 第十七批 1b：`accountBootstrapPlan` 对「Codex 保留名 + 没有归属记录 + Key 正是当前账号缓存里那把」（`configurationOwnership === 'unknown'` 且 `configurationAccountMatched` 且 `codexProviderShadowed`）放行自动重写，记进 `shadowRepairs`；结果带 `repairedShadowed`，首页 toast 一句、运行日志一行。
- 主进程 `saveConfig` 的「来源未经确认就不自动改写」闸新增唯一放行 `permitsShadowedCodexRepair`：只认 Codex、`unknown`、shadowed、地址是当前站、配置里的 Key 与这次写入的当前账号 Key 相同；`changed` / `manual` / Key 不同一律照旧拒绝、只给按钮。写入走现成的两阶段写入与备份，写完登记为账号来源。
- 第二十一批 5。新增 `electron/download-retry.ts` 的 `downloadWithResume`：已经收到数据后连接断开、读流报错、45 秒没有新数据或连接提前结束时，隔 3 秒 / 10 秒带 `Range: bytes=N-`（有强 ETag 用 ETag，否则 Last-Modified 作 `If-Range`）在同一地址续传；只接受 206 且 `Content-Range` 恰为剩余区间、总长与首个响应一致，否则把原来的失败原样交回调用方去换线路。一个字节都没收到的失败不重试，用户取消与整体超时不重试；同一次下载最多续 6 次，连续两次毫无进展就放弃。
- 摘要只累加已写入文件的字节，续传前把文件截回已写长度，所以不需要重读已下部分；四处调用方原有的首响应检查、大小上限、重定向白名单与最终 SHA-256 核对一条没放宽。
- `codex-desktop-service.ts` 的 `downloadCodexDesktopPackage`、`node-runtime.ts` 的 `downloadMsi`、`git-runtime-install.ts` 与 `python-runtime.ts` 的 `downloadInstaller` 改用它。Node / Git / Python 以前只有 10 分钟总超时，现在多了 45 秒首包与 45 秒无数据超时（续传要靠它发现「卡住不动」）。三处安装依赖新增可选测试接缝 `waitBeforeResume`，`CodexDesktopDownloadProgress` 新增可选 `resuming`。
- 沙箱里只核到 nodejs.org 支持 Range（206 + 强 ETag）；Codex 国内镜像、镜像备用源、npmmirror、python.org 被沙箱代理拦了，没核，是否支持续传靠运行时探：不支持就退回原来的换线路。
- 反馈报告头部在「应用版本」下加「账号 ID」一行（第十三批 6 的报告部分）：`electron/runtime-log.ts` 新增 `attachAccountDescriber` 与纯函数 `buildFeedbackAccountLine`，`electron/main.ts` 在账号服务起来后接上当前登录态。已登录但拿不到正整数 ID 时不出这一行，读登录态出错也不影响报告生成；不带用户名、邮箱与站点。
- 第十八批 7：新增 `electron/user-certificate-trust.ts`。`CERTIFICATE_TRUST` 结论为 `systemTrusted` 且在 Windows 普通权限下时，details 带 `userWide`（available / applied / userSet，读本进程继承的环境，不起 PowerShell）。新 IPC `diagnostics:trust-certificates-user-wide`（无入参）：主进程先对照最近一次检查的 `userWide === 'available'`，再异步起 PowerShell 用 `[Environment]::SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1", "User")` 写 HKCU\Environment（广播 WM_SETTINGCHANGE），已有任何值就不动；写成后同步本进程环境。管理员身份打开时拒绝。不做收回（与候选说明一致），macOS 不做。
- 第十七批 8。`cli-verified-versions.ts` 的 Grok 条目从 `null` 改为 `1.0.44`（npm `latest` 与 xAI stable 一致）；沙箱假接口核过 `allowed_models`、`session_summary`、`[endpoints] xai_api_base_url`、钩子四项在 1.0.44 上仍生效，过程写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- Grok 两条官方安装路径原先无视点名版本、只装 xAI stable：新增 `grok-update.ts` 的 `resolveGrokInstallVersion`（点名版本不超过 stable 就装它，超过装 stable，只收 `x.y.z`），Windows 的 `downloadLatestGrokBinary` 多收可选 `version`，Mac 的 `resolveCliInstallRelease` 按它选 npm 版本并照旧核对 npm 返回的版本号；签名校验不变。
- `cli-update-history.ts` 去掉 Grok 例外；`runCliInstall` 在装 Grok 前问一次已装版本（`readInstalledCliVersion`），Windows 签名包路径装完也记更新记录（记录逻辑抽成 `recordCliUpdate`）。
- 中转实测脚本 `probe-cli-relay.cjs` 仍不探测 Grok（没有 runner，名单条目会被跳过）。
- `platform-capabilities.ts` 新增可选的 `cliNeedsNodeRuntime`（Windows 上 Grok 为 false，缺省 = 都要）；`planCliInstall` 收 `needsNode`，Windows 装 Grok 不再把 Node.js 排进同一次安装；新手引导对这种工具不显示也不等「运行环境」那一行（第十八批 8）。
- 首页余额卡用量加 60 秒缓存（提速清单 R3）：`features/tools/api.ts` 的 `balanceUsage` 走 `ttl-cache.ts`，缓存按账号作用域认领，换账号时 `App.tsx` 与「最近」一起作废；`ttl-cache.ts` 新增 `peek()`，过期后首页先摆上一次的数、后台再查，刷新失败时保留手上的数。以前每回首页一次就对账号后端发两次用量查询。
- 第十八批 1b（yoyo 2026-09-30 同意）。`system-service.ts` 新增 `autoRepairStaleCliHooks`：已登录时，对来源是当前账号（`ToolConfigOwnership === 'account'`）且 `managedCliHooksState` 判为旧的那几家，走现成的 `repairCliHooks`（先备份、只改钩子与状态行、改完复核）；每个账号每次启动只查一遍（读配置很频繁，不能每次都翻文件、读注册表），调用串成一条队。别处来的、被改过的配置不自动动，首页照旧给「修好它」。
- `ipc.ts` 的 `config:get` 在已登录分支里读配置前先调它（失败吞掉，照常读），放在会话复核之前；不加新通道。
- `NativeConfigSummary` 新增可选 `cliHooksAutoRepaired`（这次启动改好了且现在不旧才带），renderer-v2 首页在「已配好」的工具行上显示一句说明；教程里「提醒设置要修」那条同步改说法。
- 真 Windows / Mac 上换目录重装后的自动修复没在真机上演过。
- `electron/system-service.install-cancel.test.ts`「取消后第二次安装能起来」不再用 `vi.waitFor` 默认 1 秒去轮询下载次数，改为等夹具里「第 N 次 `npm ci` 已经开始」的 promise；第二次安装要是没走到下载就结束，立刻带着原因失败。修的是 Windows runner 忙时这条用例偶发红（PR #653 在 69ea566 上的 windows-package），产品代码没动。
- 新增 `electron/install-keep-awake.ts`：安装队列里有下载/安装类任务（`runtime:node|python|git`、`desktop:codex:install`、`cli:install:*`、`external-client:install:*`）或更新器处于 `downloading` 时持有 `powerSaveBlocker('prevent-app-suspension')`，结束、失败、取消即放开，每个原因最多挡两小时（与 `cli-keep-awake.ts` 同一上限）。`InstallationQueue` 加 `onChange`，`SystemService` 暴露 `onInstallationQueueChange`。日志 `install.keep-awake.held` / `.released`。第二十二批 ①。
- `electron/macos-install-location.ts`：首个提示改为「移到「应用程序」并重新打开 / 仍要继续 / 退出」，按钮与含义用 `choices` 一一对应；新增 `moveMacosAppToApplications`（包 `app.moveToApplicationsFolder`，两种同名冲突都按 Electron 默认处理并记下是哪种）与 `buildMacosMoveFailureNotice`（取消授权 / 复制失败时的大白话原因，英文诊断只进日志）。
- `electron/main.ts`：搬成功即停止本次启动交给 Electron 重开；新增日志 `app.install-location.moved` / `.move-failed` / `.move-cancelled`。
- 新增 `window:uninstall-app` 通道与 `electron/macos-uninstall.ts`（只在 macOS 打包版可用）：安装队列空闲才动；按「修好它」同一份备份后复用 `removeCliHooksFromConfigs` 收回四家钩子，关开机自启，勾了才删 `~/Library/Application Support/XingMangAI`（根目录是链接时拒绝），`shell.trashItem` 移走 `.app`；从磁盘映像或 App Translocation 副本运行、或废纸篓拒绝时不退出，界面提示自己拖。清登录记录排在退出清理（断开加速、聊天记录落盘）之后，免得被写回。Windows 那一行不变。
- 新手引导梳理（2026-09-25）第 1、4、5 条和第 3 条的默认工具部分。
- `SavedAccounts.tsx`：勾选状态改成只记用户改过的项（`choices`），由 `defaultSyncSelection` 现算：`reason === '星芒密钥'` 的默认勾，手填密钥默认不勾，不可同步的一律不算；「同步到工具」默认展开。`app-check.mjs` 两条切换账号的浏览器用例改为先取消 Gemini、Grok 再断言只写 Claude、Codex。
- `pages-account.tsx`：密钥页顶部加说明和「去首页配置工具」（`onGoHome` 取自 `onBack`），空列表主按钮同上，「新建密钥」降为普通按钮；分组、额度加 hint。
- `pages-management.tsx`：`preferredExtensionProvider` 按导航顺序挑第一个已装 CLI；`App.tsx` 从 `toolbox.snapshot.system.clis` 算 `installedProviders` 经 `BusinessPage` 传入；检测结果晚到时跟上，用户点过就不再换。
- `features/tools/restart-reminder.ts`：内存里记「还差重启」（故意不落盘，理由见注释），`RuntimeRestartDialog` 挂载时标记，`RestartReminder` 放在 Shell 的 banner 槽里。`pages-maintenance.tsx` 运行环境已装且不需换新版时不画按钮。
- 新手引导梳理（2026-09-25）第 2 条和第 3 条的路径部分。
- 新增 IPC `diagnostics:fix`（`fixDiagnostic(kind)`，kind 只收 `set-aside-codex-dotenv` / `clear-user-overrides`）和 `extensions:choose-directory`（原生选文件夹框），三处同序加在表末。要动的文件和变量名都由主进程在点的那一刻重算（I5），渲染层只给「哪一种」。
- `electron/diagnostic-fixes.ts`：`setAsideCodexDotenv` 先过 `assertSafeDataFile`（I8，拒硬链接、联接），改名为 `.env.xingmang-<时间>.bak` 不覆盖旧份；`clearUserProviderOverrides` 沿用 `stale-proxy-environment.ts` 的做法，名字经环境变量传入 PowerShell、脚本内再对白名单，只删 User 一份并报告 Machine 还剩的，值不读出（I3、I13）。`runPowerShell` 改为导出复用。
- `diagnostics.ts`：`EnvironmentOverrideMatch` 带上 `kind`；新增 `clearableEnvironmentOverrides`（不含 CLAUDE_CONFIG_DIR、CODEX_HOME 这两个指向用户整份配置的目录变量）与 `environmentOverrideNames`；Windows 上有可删项时结论带 `details.fix='clear-user-overrides'`，`.env` 存在时带 `details.fix='set-aside-codex-dotenv'`（详情抽屉不显示 fix）。
- `pages-maintenance.tsx`：`diagnosticTarget` 对 XINGMANG_NETWORK、CLASH_VERGE_TUN、CODEX_DOTENV、CLAUDE_BYPASS_PERMISSIONS 返回 null，去掉跳设置网络组那一支；行内按钮与确认框文案在 `features/app/diagnostic-fix.ts`。
- `pages-management.tsx`：精选占位符改在解析后替换（`fillCuratedPlaceholders`），JSON 解析失败给中文提示。
- 「删掉这几项设置」在 Windows 真机上删 User 变量、广播后新开终端是否生效，沙箱里没演过。
- 加速倒计时不再带着整个界面每秒重渲染（提速清单 R2）：`useAcceleration` 在应用最外层改订阅去掉走表字段（`remainingSeconds`、`sessionSeconds`、`measuredAt`）的快照（`controller.ts` 的 `createClockFreeSnapshotReader`），秒数只由加速页经 `useLiveAccelerationState` 订阅，且只在加速页显示在前面时订阅。加速逻辑、15 秒校准轮询与到期自动停止都没动。浏览器夹具实测（加速中停在首页 10 秒）：重渲染组件从每秒约 208 个降到 0，脚本耗时从 567 毫秒降到 2 毫秒；加速页自身从每秒约 93 个降到 26 个。`browser-check.mjs` 新增回归用例，改前会红。
- 「技能」「记录」两页在主进程里的读盘改为异步：`codex-extensions.ts` 的 `listSkills`（连同 `importSkill` / `uninstallSkill` / `requireManagedSkill`）、`provider-extensions.ts` 的 Skill 目录扫描与 MCP 配置读取、`codex-plugin-catalog.ts` 的插件说明读取、`codex-sessions.ts` 列表里逐条的 rollout 文件检查、`provider-sessions.ts` 的目录可用性检查。读取结果、排序、错误处理不变；Codex 会话数据库仍是同步查询（`node:sqlite` 没有异步接口），只是查完就关、不跨 await 持有。
- 新增 `electron/async-map.ts` 的 `mapWithConcurrency`（按原顺序返回、同时最多 16 个）：几千个文件请求一次性发出会在同一轮里集中回调，照样卡住窗口。沙箱实测 2000 个技能时主进程最长一次卡顿从约 200 毫秒降到约 4～8 毫秒，2000 条 Codex 记录从约 90 毫秒降到约 13 毫秒；代价是后台读完的总耗时变长（30 个技能约 8→32 毫秒）。
- AI 聊天的消息行抽成 `React.memo` 的 `ChatMessageItem`（`src/renderer-v2/features/chat/ChatPage.tsx`），行内操作走一个稳定的转发对象，输入框每按一键不再重新解析全部消息的 Markdown。实测 200 条消息的对话：每键重解析 200 段 → 0 段，一次按键同步耗时中位数约 330 ms → 约 15 ms（容器里开发版 React，只看相对变化）。`browser-check.mjs` 加了按渲染次数断言的回归用例。
- 第二十二批 5。`documents-fallback.ts` 新增异步探针 `probeDirectoryWritable`（随机名 + `wx`，同同步版，I8）、`shouldCheckWorkspaceWritable`（只 Windows；普通目录与文档 / 桌面 / 下载，主目录、盘根、系统、配置目录这些选的时候已提醒过的不探）、`inspectWorkspaceWritable`（只有 EPERM / EACCES 算 denied，其它错误和 3 秒超时算 unknown 照常打开）、`buildWorkspaceNotWritablePrompt`。
- `ipc.ts` 的 `cli:launch` 在敏感目录那一问之后、`launchProvider` 之前调 `launchIfWritable`：主进程原生提示框，「换到能写的位置」复用 `createStarterWorkspaceOrExplain`（建不成回到选择器），续接对话只给「先不打开 / 照常打开」，不打开时返回 `{ declined: true }`。runtime.jsonl 记 `workspace.write-check`（结果与耗时，不记路径）。没加 IPC 通道，渲染层没动。新增测试注入项 `IpcRegistrationOptions.workspaceWriteCheck`。
- 受控文件夹访问报 EPERM 还是 EACCES、是否放行建文件却拦写入，没在 Windows 真机上核过（推测，两个码都认）。
- `promo-announcements.ts`：`activePromos` 同时认「充值」「邀请」两类活动（`kind`），`activeRechargePromos` 只取充值类，大卡片和每日提醒仍只跟充值活动；新增 `buildPromoTiers`（复用 `features/account/topup-bonus.ts` 的 `buildTopupBonus`，由 `pages-account.tsx` 移出并原样再导出）、`promoPreviewLines`（没配优惠时正文前三行、保留换行）、`stripSiteAddresses`、`promoShortName`、`formatPromoShortDeadline`、活动条当天收起的本机记录。
- `Announcement.tsx`：`PromoCard` 按档位渲染，`PromoBar` 新组件；`AnnouncementCenter` 新增 `readTopupOffers`（活动期间最多十分钟读一次充值配置），`onTopUp` 可带金额。App 的 `navigate('account', 'recharge', amount)` 经 `BusinessPage` → `AccountPage` → `AccountRecharge` 预选金额。
- 更新目录的 `service-status.json` 新增 `minimumVersion`（`electron/service-status.ts`）：本机低于它时更新快照带上 `requiredVersion`（`resolveRequiredVersion`，`electron/updater.ts`），刚变成必须更新时补查一次；渲染层 `features/app/RequiredUpdateGate.tsx` 盖一层关不掉的提示，只留更新、联系客服，失败时加「打开下载页」（GitHub Release 最新版，已进外链白名单 `electron/app-download-page.ts`）。
- 不会把人困住的几道闸：状态文件读不到或字段写错当没有最低版本；检查结果是「没有新版本」（定得比线上还高、被撤回）或找到的是退回版本时不拦；低于最低版本的电脑检查时不受分批放量限制；开发态和本地构建不拦。service-status 工作流新增「最低版本」输入，设之前读线上 `latest.yml` / `latest-mac.yml`，高于线上正在发的版本就拒绝。
- 只有带这段代码的版本（0.2.11 起）认这一项；0.2.8、0.2.9 不读状态文件，0.2.10 读但不认新字段。旧界面（已冻结）不显示这层提示。
- 主进程几处没人 await 的后台操作补上出错处理，失败只记运行日志、不再变成进程级「未处理的 Promise」：
  画布窗口里弹窗 / 跳转转交系统浏览器（`canvas-window.ts`，记 `canvas/external.open.failed`）；
  启动更新检查超时后补下、开发环境不等下载（`updater.ts` 新增可选 `reportBackgroundError`，
  `main.ts` 接到 `updater/download.background.failed`；真正的下载失败照旧由 `download()` 发 error 快照给界面）；
  打开软件后顺手清理旧 PowerShell 启动文件（`system-service.ts`，记 `install/cli.powershell-shim.sweep-failed`）。
- `main.ts` 的 `unhandledRejection` / `uncaughtExceptionMonitor` 运行日志监听改为运行日志一建好就挂上，
  补上「启动日志已停写、运行日志监听还没挂」这段空窗（中间隔着 macOS 安装位置提示框等启动步骤）。
- `features/auth/starfield-plan.ts`：`starfieldFrameDue` 平时按 10 帧/秒、流星可见的 1.4 秒按 30 帧/秒放行，流星周期与时长抽成常量，`Starfield.tsx` 与之共用。沙箱 1280×820 软件绘制实测工作区整体 CPU 45% → 21%，关动画基线 0.1%。
- 定位（#714）：`trustedCommandEnvironment()` 把 PSModulePath 收窄到 System32、去掉
  PSModuleAnalysisCachePath 后，Windows PowerShell 第一次自动加载 cmdlet（连 `Write-Output`
  都算）要重建整份模块分析，CI runner 上每个进程 22 秒；只查身份不碰 cmdlet 0.2 秒，放回任一
  变量 0.3 秒，脚本开头按名字显式 `Import-Module` 0.3 秒。所以商店账户探测跑满 10 秒上限返回空，
  首页和装前提醒拿不到「内置管理员」判断。
- 修法：`buildPowerShellModuleImportStatement` 在商店账户探测、商店可用性探测的第一条 cmdlet
  之前按名字导入要用的模块。名字仍只经收紧后的 PSModulePath 解析，没放宽任何环境变量，也没调大
  10 秒上限；导入失败退回自动加载即旧行为。打包作业实测出货函数 22.9 秒 → 0.36 秒。
- 没修：Codex 桌面端合并探测在收紧环境下仍要 23 秒（上限 24 秒），先导入同样的模块也不见快，
  另有自动加载点没找到，留下一版；冒烟每次打印它的耗时。
- 打包作业的 PowerShell 冒烟新增一条真检查：出货的 `inspectWindowsStoreAppLaunchContext` 在收紧
  环境、按它自己的 10 秒上限必须读出 SID；另打印商店可用性和合并探测在收紧环境下的耗时。
- `sub2api-relay-backend.ts`：`supportsSubscriptionPayment` 改为 true，`createSubscriptionPayment` 走 Sub2API 现成的 `POST /payment/orders`（`order_type: 'subscription'` + `plan_id`，不带金额，价格由服务端按套餐算）；与充值共用 `orderCheckout` 解析支付地址 / 二维码。`NewApiSubscriptionCheckout` 增加 `qrcode`，`account:create-subscription-payment` 与充值同样先过 `validatePaymentQrCode`。
- Sub2API 的订阅只对订阅分组里的 Key 生效（`canUserBindGroup` / 计费按 Key 的分组）。`managed-cli-groups.ts` 在历史账号上一并读生效订阅，按分组接的上游（认不出再看名字）把对应工具的 Key 换进订阅分组，认到多个不猜；订阅读不到按「没拿到」处理，不当成没有订阅。
- `account-cli-provisioner.ts`：历史账号不再因本机四把 Key 全在就跳过询问服务端；缓存与分组回退沿用 #608 的站点缓存（分组读不到、或服务端给不出这家工具的其它分组时留着订阅分组里那把 Key）；返回 `regrouped` 列出本轮换了分组的工具。`account-bootstrap.ts` 开机恢复时只改写这些工具，其余已连好的不碰。
- 充值与订阅页：订阅付款到账、兑换码兑成订阅后，历史账号调 App 的 `applySubscriptionToTools`（开机恢复同一档）并报告换好了哪几个工具；星芒账号只提示按扣费偏好先用订阅。
- `subscription-cache.ts` 加 `refreshNow`：订阅开通后跳过 5 分钟间隔立刻重读（先等手上那次读完，它可能是付款前发出的）；`useUsableSubscription` 改为返回 `{ subscription, refresh }`，账号页经 `onSubscriptionPurchased` 调用。
- `src/renderer-v2/pages-account.tsx` 新增纯函数 `buildTopupBonus`：把充值配置里的折扣（付款 = 到账 × 比例）换算成「送多少、多送百分之几」，百分比按实付算、赠送按到账单位算，不依赖后台单价与币种。快捷金额按钮、金额下方提示、确认框三处使用；历史账号的充值配置不带折扣，保持原样不显示。
- 第二十一批 6（yoyo 2026-09-30 回「其他的全部按你的推荐」，含去掉 TUN 开关）。`registry/tutorials.ts` 改更新一步、加速两句与关键词；`TutorialIllustration.tsx` 改加速插图说明和那一行；`AccelerationView.tsx` 删模式开关行与 stage 顶部模式标签，`mode` / `onModeChange` 两个 prop 随之去掉（`AccelerationPage.tsx` 不再传），对应 CSS 删掉；`App.tsx` 加速使用帮助去掉「TUN 模式暂未开放」。
- 控制器 `controller.ts`、主进程加速服务与偏好存储的 mode 字段都没动：开关一直被 `supportedModes` 挡着，没人存得下 TUN 偏好，开始加速照旧用 `system-proxy`。
- 测试：`tutorials.test.ts` 把更新一步的按钮名钉在 `settingsGroups`、`updateFailureLabels`、`updateLabels` 上，并断言教程全文不出现 TUN；`AccelerationView.test.tsx` 断言连接前后都没有模式开关和相关字样；`browser-check.mjs` 里计时那条用例去掉点 TUN 开关的步骤，改为断言开关不存在。商店那句由 #674 改。
- 主进程运行期未捕获异常改由 `main.ts` 自己的 `uncaughtException` 监听处理（Electron 自带的监听只在没有别的监听时弹英文 `showErrorBox`，之后进程继续跑）：同步写 `unexpected-exits.log`（`electron/unexpected-exit.ts`，打码同 `redactCrashText`），限时 3 秒等错误报告、`acceleration.stopAll()`、聊天记录和运行日志落盘，再 `app.relaunch()` + `app.exit(1)`；10 分钟内已自动重开过则只退出不重开。只有打包版（或设了模拟开关）才重开，开发态和 e2e 冒烟只退出，免得 CI 上留下没人管的进程。重开时按出事前窗口是否可见决定带不带 `--launched-at-login`。
- 下次启动在 `window:get-capabilities` 上多一个可选字段 `unexpectedExit`（无新增 IPC 通道），renderer-v2 角落卡片 `unexpected-exit` 给「复制给客服」（`buildSupportBundle`）并写进帮助框的「最近一次出错」。`RuntimeLogStore` 新增 `idle()`。
- 真机演示：设环境变量 `XINGMANG_SIMULATE_MAIN_CRASH=1` 启动，30 秒后主进程抛一次异常；重开出来的进程带着同一变量会再退一次，正好演「不再重开」。
- `updater.ts` 的 `download()` 下载前经 `readFreeDiskBytes` 量盘（`main.ts` 量 electron-updater 缓存目录与临时目录里最紧的那块，读不到放行）；需要空间按 latest.yml 的 `files[].size × 3`，至少 300 MB，没有 size 按 600 MB。不够时 phase 仍是 `available`，快照带 `diskShortfall`，不进 `error`；运行日志记 `update.download.skipped.disk`。`update:download` 可带 `{ ignoreDiskSpace: true }` 跳过这一次预检（`parseUpdateDownloadOptions` 字段白名单）。
- 说法只在 `electron/disk-space-copy.ts` 一处，系统通知与 renderer-v2（首页气泡、更新页）共用；`formatFreeSpace` 挪进这个无 Node 依赖的模块，`disk-space.ts` 原样再导出。第二十二批 2。

- Claude Desktop 第三方推理配置的 `inferenceModels` 以前只写所选的一个型号，Desktop 的型号菜单因此只剩这一项。
  现在由 `claude-desktop-config.ts` 的 `buildClaudeDesktopModelList` 写入当前 Key 可用的全部 `claude-*` 型号
  （所选的排第一，检测结果仍按第一项显示；别家型号不写；最多 20 个）。
- 依赖锁文件把 brace-expansion 从 1.1.18 / 2.1.4 / 5.0.9 升到 1.1.21 / 2.1.7 / 5.0.12、fast-uri 从 3.1.7 升到 3.1.8（都是 electron-builder 与 @electron/asar 的间接依赖，纯开发依赖，不进安装包），修掉新公告 GHSA-6j4f-fj2g-mc7p、GHSA-qhr7-859c-m2p7、GHSA-q2hr-2g5m-vwhr（brace-expansion）与 GHSA-hrr3-gc8f-f4qj（fast-uri）让 CI 的 npm audit 报红。

- 新增 `src/renderer-v2/features/shell/promo-announcements.ts`：按约定从账号服务时间线公告（`GET /api/status` 的 `announcements`）里认出充值活动（标题含「充值」、有发布时间），从正文或附加说明的「截止：…」或「…-…」日期区间读结束时间，没写按发布后 7 天；「知道了」「今天不再提醒」「今天已提醒」三份本机记录。不加新请求，跟着余额刷新那次读取走；没有发布时间的旧系统公告不会变成卡片。
- `Announcement.tsx` 加首页 `PromoCard`（只在首页显示，别的页面仍是细横条），活动期间铃铛红点常亮；`electron/platform/notifications.ts` 按 `promo:` / `promo-daily:` 前缀给出活动通知文案，点开去首页，仍受「公告」通知开关管。

- 新增事件通道 `desktop:codex-launch-progress`（`onCodexDesktopLaunchProgress`，载荷 `CodexDesktopLaunchProgress`）：Windows 打开 / 重启桌面端时由 `startCodexDesktopLaunchHeartbeat` 每 5 秒发一次，分「准备」「等窗口」两段文案（`describeCodexDesktopLaunchWait`），渲染层把它写进 `launch:codexDesktop` 那个任务的进度句。等待时长与启动逻辑不变。
- `describeCodexDesktopLaunchFailure` 多一个可选的 `{ waitedSeconds, processSeen }`：带上时按激活有没有交回进程号分两句，并附开始菜单自查法；开头仍是 `codexDesktopNotStartedPrefix`，渲染层归类不变。
- `runtime-logs:copy-feedback` / `runtime-logs:export-feedback` 收到过期或被新预览顶掉的报告标识时，就地重跑 `captureFeedbackReport` 生成新预览（仍受 8 份与 2MB 上限约束），返回值多带可选的 `regenerated`（新预览的 id/text/entries），渲染层据此替换对话框文本并改提示语；只有重生成本身失败才报错。不加通道，脱敏沿用 `captureFeedbackReport`。legacy 界面已冻结，未跟进提示语。
- 第二十一批 1：`StartGuide` 的失败从一句字符串扩成 `GuideFailure { message, reason, detail }`（`guideInstallFailure` / `guideStepFailure`，替掉原来的 `guideInstallErrorMessage` / `guideStepErrorMessage`）；原话走 `business-common.tsx` 新导出的 `supportDetailOf`（`operationFailureFrom` 同用这一份）。新增 `support`、`onFailure` 两个 prop，App 传 `supportInput` 与 `setLastFailure`；复制内容复用 `buildSupportBundle`。原样上屏的中文原因现在也过 Key 打码表。

- 第二十批 4：`features/auth/state.ts` 新增 `authFailure`，按 `classifyNetworkFailure` 与账号服务错误表（`account-errors.ts` 补 `kind`）给出原因类别；超时 / 被切断沿用 #660 注册窗那句加速器提醒，没网单独一句；兜底在服务端原话为纯中文时带上原话。`AuthFlow.tsx` 在红字下按类别给出口，没网时监听 `online` 清红字。浏览器回归覆盖网络失败重试、没网恢复、密码错误、邮箱已注册四条路。
- 第二十批 2、3：`operationFailureFrom` 在 `errorMessage` 落到兜底句时把脱敏打码后的原话留在 `OperationFailure.detail`；`presentOperationFailure` 认不出上屏句时再拿原话分类；`buildSupportBundle` / `buildLastFailureLine` 复用 `electron/redaction-patterns.ts`（已登记进渲染层可值导入名单）。`errors.unknown` 标题统一为「操作没有完成」，删掉从未上屏的「已自动撤回」。

- 第二十批 6、7。`auto-update-install.ts`：记录新增可选 `quitAttemptedVersion`，`decideQuitInstall` 让退出时自动装每个版本只试一次，之后回到「顺手装上吗」那一问；`decideLaunchInstall` 也跳过退出时试过的版本。`resolvePreviousAutoInstallFailure` 在下次启动时从记录认出「上次自动装过、还是旧版本」，`updater.ts` 新增 runtime 选项 `previousAutoInstallFailure`，下载完成时把该版本停在 `failedStep: 'install'`（code `UPDATE_PREVIOUS_AUTO_INSTALL_FAILED`），只留按钮不再自动装。
- 自动装前的预告：`buildAutoInstallNotice` 出文案，`desktop-notifications.ts` 新增 `announce`（不看通知开关，理由见注释）；退出时发完等 1.2 秒再交给安装器，启动时发完等 5 秒并复核开关、队列和版本再装。
- `updateDesktopNotification` 多收 `autoUpdate`，开着时改说「后台下载 / 关掉软件时自动装上」。更新页导语按开关分两句（`registry/business.ts` 的 `updatesPageLead`），「安装前需要知道」去掉「关闭保护」，重启确认框在 Windows 上提醒授权窗口点「是」。
- `safeError` 认不出的英文原话经 `describeUnrecognizedUpdateFailure` 按磁盘满 / 权限占用 / 文件没了或校验不过 / 其它四类说人话，脱敏原话放进可选的 `error.detail`，随 `update/state.changed` 进 runtime.jsonl；中文原话照旧。安装器没起来那句改成指向「更新」页的「重新安装」。
- 授权窗口是否真的弹出、点「否」之后 electron-updater 的实际表现没在 Windows 真机上演过。
- `acceleration-mihomo-runtime.ts` 不再把起不来的原因一刀切成「加速内核启动失败」：系统拒绝运行（spawn 报错、无 pid）、启动后退出、本地端口分配失败、所选线路测速 503/504 各给自己的内部说法；启动失败阶段新增 `core-blocked` / `core-exited` / `core-port` / `line-unreachable`，`加速内核未能及时启动` 等从 `core-storage` 改归 `core-launch`。
- 开发加速后端按阶段挑界面文案（`accelerationStartFailureMessages`，穷尽表），原文照旧不跨进程；口令兑换失败按下层给的原因挑句子，原因标签保留给托盘。
- 加速页去掉对错误文案的「代理→网络连接」机械替换。
- 新增 `electron/codex-desktop-install-failure.ts`（无 Node 依赖，渲染层可值导入）：安装 / 更新失败按 blocked / damaged / unreachable / unavailable / unknown 归类，统一以「Codex 桌面端没装上：」开头；原话（SHA-256、Content-Type、商店退出码）挂在 `CodexDesktopInstallFailure` 的自有字段上随 IPC 失败日志进 runtime.jsonl，cause 保留原始错误。
- 渲染层新增错误类 `codexDesktopInstallFailed` 与动作 `openStore`；`CodexDesktopInstallResult` 新增可选 `storeNewerVersion`；`main.ts` 外链白名单的商店链接改用共享常量（值不变）。
- 打开 Codex 桌面端时判断「窗口起没起来」改用只按登录会话和安装包路径的探测（`buildCodexDesktopSessionProcessProbeScript`），不再沿用 #640 给关闭路径加的属主核对；重启、更新、卸载要关进程时仍走带属主核对、失败即停的那一套。
- 激活返回的 PID 探活把 `EPERM` 当作「还活着」；启动环境探测超时由 3 秒放宽到 10 秒，免得冷启动的 PowerShell 超时后丢掉内置 Administrator 的判断。
- 启动失败文案改为以「Codex 桌面端没有打开」开头的三句大白话，渲染层新增 `codexDesktopNotStarted` 归类（重试 / 找客服）。
- `codex-desktop-service.ts` 商店安装那一路加 15 秒心跳（`buildCodexDesktopStoreWaitMessage`，纯函数有单测）：没有百分比时进度条不再固定发 `0%`，离 15 分钟超时剩 3 分钟起改说「最多再等 X 分钟」。只动等待提示，装不上时的报错文案不在这条里（第十九批第 ⑤ 条）。
- 新增 `electron/certificate-trust-probe.ts` 与检查项 `CERTIFICATE_TRUST`：用跑工具的那个 Node 起两次 `node -e` 只做 TLS 握手连当前账号状态地址（去掉 / 强制 `NODE_USE_SYSTEM_CA=1` 各一次，5 秒超时，只打印固定标记），得出 direct / systemTrusted / outdatedNode / untrusted / elevated / unknown；管理员身份不起进程；「星芒 AI 网络」同时失败时改指向那一项。`CheckOutcome.omit` 让没装 Node 时不出这一行。`diagnosticTarget` 按 `details.verdict` 只给 outdatedNode「去处理」。检查项的 `code` 全部不变，只改 `title` / `summary`。
- 第十九批 2：`cli-hooks.ts` 的 `ManagedCliHookTarget` 带上命令写法（`form`: PowerShell / sh），新增
  `grokCliHookShellChanged` 比对「Grok 现在该用的 shell」与写下去的写法；`system-service.ts` 的钩子复核
  （首页 `cliHooksStale`，新增可选字段 `cliHooksShellChanged` 让首页小字说「Grok 换了命令行」）与 `repairCliHooks`
  都按它判断。`launchProviderOperation` 打开 Grok 前对不上就先 `repairCliHooks('grok')`，修不好只记日志
  （`grok-hooks.shell-changed` / `grok-hooks.repair-before-launch-failed`），不挡打开。
- 新增 `windows-live-path.ts`：异步起 System32 的 reg.exe 读整台电脑 + 当前账号的 PATH，补在启动时快照后面，
  推 Grok 的 shell 与从星芒打开 Grok 的环境用同一份，星芒开着时装的 PowerShell 7 也看得见。不做开机静默重写（等第十八批 1b）。
- `cli-hooks.ts` 新增 `resolveGrokWindowsShell`：照 Grok 1.0.44 Windows 版的顺序（`GROK_SHELL` →
  PATH 上的 `pwsh` → 三处固定位置的 Git Bash → Windows PowerShell）推它会用哪个 shell 跑钩子，
  只看文件在不在、不起进程；`CliHookInvocation` 新增可选的 `grokWindowsShell`。Windows 上
  PowerShell 用 Gemini 那种 `& '…'` 写法，Git Bash 用 sh 写法，`cmd` 或推不出来就摘掉我们的钩子
  不写。顺序出自程序内字符串，推测，Windows 真机没演过（复核办法见 `docs/CLI-VERIFIED-VERSIONS.md`）。
- 星芒装好 Git（Windows）后，用 #654 的 `rewriteManagedCliHooks` 把 Grok 配置里本软件那几条钩子
  按新的 shell 重写一次（只动我们写过的，不联网）。客户自己装 Git / PowerShell 7 的，要等下次写配置。
- 通知：`TerminalNotice` 三类都加 `grok`（名字「Grok」），`createCliTurnTracker` 不再丢 Grok 的
  记录；晚到的上一轮打断 / 结束报告按 `turn` 认出来，不吞掉新一轮的开始。
- `StartGuide` 的安装类失败（安装、更新、准备环境、准备 Python）复用错误框的出口表（新增 `guideInstallExits`），`replaceNode` 按 `canReplaceNode` 过滤、换不了时补「找客服」；`onFailureAction` 多一个可选的 `retry`，App 的 `runGuideFailureAction` 新增 `replaceNode` 分支，换完重跑引导里失败的那一步。
- `guide-result.ts` 多 `usesAccountBalance`（聊天已登录、或当前账号来源且已连好时为 true）；`StartGuide.tsx` 只在 ready 步且花的是当前账号余额时给「去充值」，点了先 `complete` 再走 `onFailureAction('recharge')`，免得下次登录引导又从头弹出。没动 App.tsx。
- `Home.tsx` 抽出 `lowBalanceText`，余额 ≤ 0 换说法；低余额提示加 `data-testid="home-low-balance"`，订阅相关测试改按 testid 断言。
- `registry/shell.ts` 导览第 3 步文案。
- 第十八批 4：`runtime:install-node` 加可选参数 `{ reason: 'certificate' }`（ipc-contract / preload / ipc 三处同改，`parseNodeRuntimeInstallRequest` 白名单校验）。Windows 上带它且当前 Node.js 低于 22.19 / 24.6 时不再走「无需重复安装」，照常装最新 LTS；装完仍读到旧版（被另一份排在前面）直接报错说明，不假装换好。Mac 不换（代下的那份排在 PATH 最后），错误框出口改为「找客服」。
- 渲染层：错误目录 `toolCertOutdatedNode` 加「换成新版 Node.js」动作（`replaceNode`，有它时当主按钮）；新增 `features/tools/node-replace.ts` 与 `NodeReplaceDialog`，错误框与「安装卸载」页共用；`toolCertificateMessages.outdatedNode` 不再指向「安装卸载」页。
- 注册窗读 `account:get-status` 失败时按 `network-failure.ts` 的原因处理：timeout / refused / dns 隔 2 秒自动重试一次；offline 或 `navigator.onLine` 为 false 时改说没网并监听 `online` 事件重读；timeout / refused 换成注册窗专用文案（全局那张表不动）。新纯函数 `registrationStatusFailure`（`features/auth/state.ts`）带单测，浏览器回归覆盖重试与断网恢复。
- 第十八批候选 1（1、3 退一步的方案；开机自动改路径 1b 待 yoyo 点头，本次不做）。
- `cli-hooks.ts` 新增 `splitManagedCommand` / `managedCliHookTargets` / `cliHookTargetsStale`：把我们写的钩子、状态行、Codex notify 拆回「程序 + 脚本」，程序或脚本不存在、或脚本不是这次安装带的那份（同名比对，Windows 不分大小写）即判为旧位置。
- `config-files.ts` 新增 `inspectManagedCliHookTargets`、`rewriteManagedCliHooks`（只改我们那几条；写不出钩子时收回）、`removeManagedCliHooks`（卸载用），写入仍是两阶段提交 + `.bak`；原来没有我们那几条的配置一个字不动。
- `NativeConfigSummary.cliHooksStale`；新 IPC `config:repair-cli-hooks`（先建「备份」页可见的 pre-save 备份，再改，再复查，没修好抛中文原因）。首页状态 `cliHooksStale`「提醒设置要修」+「修好它」，优先级排在来源类提示之后；「打开」不受影响。
- 卸载清理 `runUninstallCleanup` 加 `removeCliHooks` 一步（退出码位 64 `cliHooksRemain`，失败不拦卸载；别的账号卸载时不动）。以管理员身份跑，Codex 目录刻意不读 `CODEX_HOME`。
- 「这个账户能不能打开商店应用」的判断从 `codex-desktop-service.ts` 抽到新模块 `electron/windows-store-app-launch.ts`（`resolveStoreAppLaunchBlock`），打开失败后的解释（#658）和装之前的提醒共用这一份。内置 Administrator 开了「管理审批模式」（`FilterAdministratorToken = 1`）时不再算作打不开。
- Codex 桌面端首页那条合并探测脚本顺路读当前账户和那条策略键，未安装时 `DesktopAppStatus.storeAppLaunchBlock` 带上结果，首页不为它另起 PowerShell。
- 检查页 `ADMINISTRATOR` 在令牌本身高权限（`alwaysElevated`）时多问一次（4 秒上限，可经 `inspectStoreAppLaunchContext` 注入），认出来改为 warn，`details.storeAppLaunchBlock` 标明是哪一种；没问出来照旧 pass。

- 修复 #475 的来源切换补签入口，复用限额继承服务并保留显式配置写入意图；回归覆盖限额、耗尽、过期、重启恢复和损坏记录。
- 将 Codex 消息的预览裁剪移到详情收集阶段，Markdown 导出保留通过 JSONL 行上限校验的完整正文；保留预览条数、文本长度和单行读取上限，裁剪预览时如实设置 messagesTruncated（#600）。
- 增加用户与助手长消息的端到端导出回归，核对完整正文、尾部标记及预览与导出的不同完整性标志。
- Codex 技能以路径身份匹配原生元数据，路径缺失或候选不唯一时关闭变更入口；无路径旧 ID 仅允许唯一名称兼容，执行动作时再次核验目标（#601）。
- 保留 Windows 盘符、UNC 与命名空间路径的等价写法，POSIX 路径保持大小写敏感；回归覆盖同名目标消失、错误元数据直传、旧 ID 歧义和正常技能操作。
- CLI 更新状态对齐实际推荐安装目标，首页复用现有版本建议并显式提交目标版本；覆盖已装版本领先推荐版、更新到推荐版与跟随最新版的回归（#603）。
- registry、安装 IPC 与回退记录共用精确版本校验，支持构建元数据且继续拒绝范围和标签；显式升级仍保留更新前版本记录。
- 对现有和下载的两份插件市场清单做有界 JSON 与基本结构校验，同时校验版本标记，不再以文件存在判定目录完整（#604）。
- 插件目录与版本文件在暂存校验后成对发布；旧目录与版本先保留为备份，失败时按文件身份回滚，并发替换无法确认时保留双方文件，避免先删除原目录。
- 版本文件的发布和回滚用原子 no-replace 链接移动，拒绝覆盖检查后出现的文件；发布完成再次核对目录与版本身份。
- 健康目录不产生备份，也不受修复次数限制（备份数量上限与自动清理见 plugin-catalog-backup-rotation 分片）。
- 增加损坏/超限清单、无效版本、保留原文件、下载校验失败和发布回滚回归；测试全部使用合成归档与隔离目录。
- Codex 配置按全部已登记中转地址识别来源；旧版本误存为官方的中转快照会在切回官方时安全清理，配置和认证仍由原有两阶段写入、备份与失败回滚事务处理。
- 补官方与两个中转来源往返、站点先切换、无官方快照、旧污染快照及认证提交失败的隔离回归（#616）。
- #617（取代 #622）：由引导现有工具快照与切换回执生成结果卡（`features/auth/guide-result.ts`），不加 IPC、不做会花钱的自检。刚切换完以切换回执为准，不等检测快照跟上；没试通时保留主进程给的原因；切回官方也有回执。文案按大白话重写并加测试钉住不出现技术词。异步安装和账号切换结果按当前向导实例收口。
- #619（取代 #621）：Codex 对名为 `openai` / `ollama` / `lmstudio` 的 `[model_providers.*]` 表按 `or_insert` 合并，用户表被忽略（codex-rs merge_configured_model_providers）。活动 provider 是这三个保留名时，改用 `XingmangAI`（被别人的表占用时顺延 `XingmangAI-2`…）；保留名下我们自己写的中转表（base_url 属已登记站点）连同选项搬过去，别人的保留名表原样留下、不拒绝保存。
- 非保留的活动名（含 `OpenAI`、`XingmangAI`）和「没有选择器时用 `OpenAI`」保持不变：Codex 续接列表按 model_provider 过滤，改名会让老对话看不见；没有选择器时 `OpenAI` 表若是别人的，改用空闲的 `XingmangAI*`，不再覆盖。
- 首页仍把「保留名 + 我们的地址」当成已接入（检测逻辑没动），这类老用户需要点一次「改用当前账号」或重新保存。
- 第五批候选 4：`relay-sites.ts` 新增 `relayDirectHosts()`，从全部站点的 CLI 地址、账号地址、官网与取 Key 页取主机名；`acceleration-clash-config.ts` 的 `buildIsolatedMihomoConfig` 多收 `directHosts`（只收小写域名、最多 32 个），在 mihomo 规则 `MATCH,XINGMANG` 之前逐个加 `DOMAIN,<host>,DIRECT`，`acceleration-mihomo-runtime.ts` 启动内核时传入。解析器仍不依赖其他应用模块，打包脚本照旧单独加载它。Windows 与 macOS 共用这份内核配置，一处解决；系统代理例外列表不动，加速仍只接管系统代理、不开 TUN。取全部站点而不是当前账号的站点，是因为加速开着时切换账号不会重启内核。连通性验证（www.gstatic.com）仍走线路。
- `diagnostics.ts` 新增可选依赖 `inspectAccelerationActive`，`XINGMANG_NETWORK` 通过时若加速开着，结论加一句「开着加速时也直接连」，details 带 `route: 'direct'`；读不到加速状态按没开处理。`main.ts` 把原先 proxy-bypass 里判断加速状态的闭包提成 `accelerationRunning()`，两处共用。
- 第十六批 6：主进程只在正式安装包里、自带加速文件读不通时（`accelerationConfigRead` 失败）记下 `bundle-damaged`，经 `AccelerationState.unavailableReason` 带给加速页；建加速服务本身失败不算文件坏。新增 IPC `acceleration:recheck-bundle`（无参数，重读安装包里的固定文件，连点共用一次读取），结果只说文件读不读得通，加速服务要重开软件才会按新文件建起来。诊断新增 `ACCELERATION_BUNDLE`（标黄，同 `AI_OUTPUT`，不触发开机「需要处理」提示），「去处理」落加速页。文案不承诺重装保留聊天记录（未实测）。
- `acceleration-development-host.ts`：开机恢复（`recover()`）或崩溃后重拉那一次没能还原系统代理时，按 5s/15s/30s/60s/120s 退避再试，最多 5 次；每次先确认恢复记录还在，等上一个失败的辅助进程真正退出后才拉新的，退出软件时取消。新增可选回调 `onProxyRecoveryRetry`，`main.ts` 记 `acceleration.recover.retry` 日志。Fixes #550。
- `savedAccountLoginTarget`：历史账号（solov-api）保存的用户名不是邮箱时预填空串，让 AuthFlow 的记住登录邮箱能填进来（#480 复核 F12）。
- `accountSwitchNeedsAttention` 把 `skipped` 也算作需要用户看；`SavedAccounts` 结果提示在只有跳过时同样用警告色和「部分工具没有同步」标题（#545）。
- 密钥页「还在用刚撤销的密钥」不再在点「去设置」时清掉。`ConfigDialog` 新增可选 `onKeyWritten(tool)`（保存、保存并检测、改用当前账号三条写入路径；原样沿用现有 Key 的保存不算），首页工具行的「改用当前账号 / 切回官方账号」成功后同样通知，App 读回配置成功后经 `BusinessPage`/`AccountPage` 的 `toolConfigConfirmed`（provider + 递增序号）通知密钥页，只认点开之后新来的、同一个工具的信号（#546）。密钥页自己的「配置到工具」写成功也会收起同一工具的警告。
- `app-settings.ts` 新增 `autoUpdate`（缺省开，只落盘显式关闭）。`updater.ts` 每次决定下载前现读这个开关；新增 `scheduledCheck`（定时检查找到新版本顺手下载）、`autoUpdateChanged`（打开开关时开始下载已找到的版本）、`autoUpdateEnabled`，快照多一个 `autoUpdateSupported`。
- 未签名通道（Windows）经 `unsignedAutoUpdate` 放开自动下载与自动安装，yoyo 2026-09-25 亲口同意；撤回名单、分批放量、SHA-512 复核照旧生效。
- 安装时机由新模块 `auto-update-install.ts` 决定：退出时直接装、不再弹「顺手装上吗」（装前最多等 3 秒重读撤回名单）；上一次运行就下好的版本在下次启动两分钟内装上，每个版本只在启动时试一次，记录在 `%APPDATA%\xingmang-ai-manager\pending-update.json`，防止安装器坏掉时每次打开都闪退。
- legacy 旧界面已冻结，更新页里「每次下载和安装前都会先问你」那句没有改。
- `canvas-run-engine.ts`：drama-character / drama-scene / drama-prop 加入不走缓存的节点种类（#541）。刻意不改指纹：把绑定图加进指纹会让升级后所有下游缓存失效、整批重跑扣费；下游指纹本就含上游交出的资产，图不变时照常命中。
- `canvas-run-store.ts`：写盘时超过字节上限先淘汰最旧的非运行中记录，再淘汰最旧缓存；最新一条放不下才报错（#542）。
- `canvas-project-package.ts` 新增 `readCanvasProjectAssetSources`：读正文前先查张数，最多 4 路并发，边读边按 base64 后大小累计，超 96 MB 立即停（#543）；`canvas-window.ts` 导出改用它。
- `src/renderer-v2/features/chat/ChatPage.tsx`：给 `ReactMarkdown` 加 `pre` 渲染，代码块右上角放复制按钮（行内代码不加）；成功时按钮变「已复制」2 秒并走底部提示条，失败时照旧弹「手动复制内容」。Markdown 渲染表改用 `useMemo` 固定，避免每次重渲染把代码块重新挂载、丢掉「已复制」状态。浏览器用例在 `features/chat/browser-check.mjs`（第十四批候选 10）。
- `renderer-v2/features/chat/storage.ts`：旧版 localStorage 聊天副本（本账号键、`solov`/`sub2api` 别名、v1 键）在第一次写进文件成功后才删除，写失败照旧保留；删除前先记 `xingmang-ui-v2:chat-migrated:<scope>` 标记，文件记录为空时有标记就不再回头读旧副本。文件里已有记录的老用户，下次打开聊天时把残留旧副本一并删掉。`createHistoryWriter` 新增可选第三参 `afterFirstSave`。
- `electron/uninstall-cleanup.ts`：勾选卸载清理时除登录记录外，再删 `userData` 下的 `chat-history` 与 `Local Storage` 两个文件夹；逐项走 `removeSafeDataFile`，树里遇到链接、目录联接或多链接文件一律拒绝并跳过（I8），其余照删，没删干净的并进退出码 16。`build/installer.nsh` 勾选项文字随之改名。
- 第十二批第 6 条。`ai-chat-protocol.ts` 的消息新增 `images`（本账号资产标识），`supportsChatImageInput` 按型号认能看图的模型（claude、gpt-4o/4.1/5 以上、o1/o3/o4-mini、gemini、grok-4、*-vl/*-vision），认不出的一律当看不了；单条 4 张、一次请求 8 张。发送时主进程按凭据里的账号读图转成 data URI（`toChatCompletionsWireBody`），纯文字消息的请求体与以前逐字节一致。当前这条的图读不到就在付费请求前停下（`image-unavailable`），更早消息里读不到的图换成一句说明。
- 新增 `electron/ai-chat-attachments.ts` 与两条通道 `chat:pick-images` / `chat:paste-image`：图片只从系统选文件框和剪贴板在主进程里取，渲染层给不出路径或字节；长边超过 2048 或超过 2 MB 的用 nativeImage 压（先 PNG 再 JPEG），存进本账号的图片资产目录（`AiAssetStore.readLocalFile` / `storeLocalBytes`，按内容去重）。聊天记录里只存引用；「搬到新电脑」导出不带聊天里的图片，口径不变。
- `src/renderer-v2/features/chat/ChatPage.tsx`：Markdown 的 `a` 改由 `ChatLinkText` 渲染，http/https 链接是按钮，点击经 `api.copyText` 复制 `URL.href`，成功走底部提示条，失败照旧弹「手动复制内容」；其它协议照旧是不可点的文字。判断和域名提取放在新文件 `features/chat/links.ts`（域名取 `URL.hostname`，`https://a@b` 显示 b），单测 `links.test.ts`，浏览器用例在 `features/chat/browser-check.mjs`（第十六批候选 7）。
- `renderer-v2/features/chat/state.ts`：发出去的前文抽成 `contextMessages`，上限拦截和新加的 `conversationContextShare` / `shouldShowLengthNotice`（条数或字数到上限七成、仅文本模式、未点过「知道了」）共用同一口径；两句上限报错改成常量并由 `isConversationTooLongMessage` 识别；`continueInNewConversation` 按原设置新开对话并搬走草稿。`Conversation` 新增可选字段 `lengthNoticeDismissed`，`storage.ts` 读写时保留。`useChatController` 记住被拦下的那句话（编辑重发时取编辑框里的内容），新增 `continueInNew` / `dismissLengthNotice`。第十六批第 9 条。
- 新增 `src/renderer-v2/features/chat/math.ts`：在交给 react-markdown 之前把 `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 换成带私用区标记的行内代码，由回复专用的 `code` 组件交给 KaTeX 输出 MathML（不带字体文件、不改 CSP、`trust: false`）。单个 `$` 按 Pandoc 规则判断，遇到不能收尾的 `$` 就放弃这个开头；围栏代码、行内代码、`\$` 不动。依赖只加 `katex@0.16.47`（锁版本，和已有间接依赖同版本去重）。
- `electron/platform/notifications.ts`：新增 `resolveNotificationTarget`（点击去处由主进程按种类与编号前缀定死，渲染层无法指定页面）与 `buildActivityNotificationMessage`（task 类 `chat:` / `image:` 前缀换聊天说法）；`createPlatformNotifications` 多一个可选 `openPage`，缺省＝旧行为只叫出窗口。`install-system-api.ts` 经已有的 `navigation:open-page` 事件发给主窗口（同状态推送的 sender URL 校验），没有新增请求通道。
- `RendererNavigationTarget` 加 `home` / `chat` / `tasks` / `announcement`；legacy `src/App.tsx` 只跟着类型忽略这几个值（这条事件只在 v2 下出现）。
- `useChatController.ts` 两处通知复用 #576 的 `isWindowInFront`。
- 新增随包钩子脚本 `bundled-catalog/cli-hooks/xingmang-hook.cjs`（extraResources），写配置时
  由 `cli-hooks.ts` 并进 Claude / Gemini 的 settings.json 的 `hooks`：Claude 用 exec 形式
  （command + args，不经过 shell，`async: true`），Gemini 按平台拼 PowerShell / bash 命令。
  Codex 写 config.toml 的 `notify` 参数数组（同样不经过 shell）。用户自己的钩子和 notify
  原样保留；切回官方账号时只收回我们那几条。
- 钩子只往 星芒数据目录下的 `cli-events` 写「工具 + 事件类型 + 时间」小文件；
  主进程 `cli-hook-events.ts` 盯这个目录，按单链接普通文件 + 4 KB 上限读取、白名单重建，
  去重后经 `host-notification-bridge` 发系统通知。通知文案全部在 `platform/notifications.ts`。
- 新增通知类别 `cliTrouble`、`cliTurn`（默认开），`RendererNavigationTarget` 加 `health`。
- Gemini CLI 0.61.0 没有「接口出错」的钩子，所以 Gemini 只有做完和等你确认两类。Codex 0.156.1
  的 `notify` 只在一轮顺利做完时调用（本地假接口实测：402 失败不调用），所以 Codex 只有「做完了」；
  它没有开始事件，这一轮的开始时刻从 UUIDv7 的 turn-id 里解出来。Codex 桌面端共用这份配置，
  桌面端长任务做完大概也会提醒（推测，没实测桌面端）。
- 新增 `electron/cli-keep-awake.ts`：复用 #634 的钩子记录（`cli-hook-events.ts` 新增 `onEvent`
  出口），按「工具 + 会话」记一张在跑的表，有就 `powerSaveBlocker.start('prevent-app-suspension')`，
  空了就 stop。等人点确认时照样挡着（点完它接着干，不会再报开始）；一轮最多挡两小时，防窗口被
  直接关掉、Gemini 接口出错（它不报结束）这类没有下文的情况。Codex 不走这里（它有
  `features.prevent_idle_sleep`）。
- 钩子新增事件：Claude / Gemini 挂 `SessionEnd`；Claude 的 `idle_prompt` 通知记成「结束」
  （被打断的一轮大概不报 `Stop`，推测）。刻意不挂 `PostToolUse` 一类：每调一次工具就多起一个进程，
  Claude Code 2.1.284 有这类钩子时还会不再把工具调用放到后台。
- Grok：1.0.41 有仿 Claude 的钩子，而且默认会跑 `~/.claude/settings.json` 里的钩子，但不认
  `args`，于是 #634 写给 Claude 的 exec 形式钩子在 Grok 里变成光起一个 node、把事件 JSON 当脚本，
  每轮报 `exit code 1: [stdin]:1`（本地假接口实测）。现在接当前账号时在 Grok 的 config.toml
  写 `[compat.claude] hooks = false`（用户设过就不动），并在非 Windows 上写 Grok 自己的
  `[[hooks.*]]`（sh 命令，事件含 `StopCancelled`，用 `promptId` 认出晚到的打断报告）。
  Windows 版 Grok 会在 pwsh / Git Bash / Windows PowerShell 间挑 shell，没真机核之前不写。
  切回官方账号时收回 Grok 钩子，`[compat.claude]` 保留。
- 事件记录新增 `cancelled`、`ended` 两类和 Grok 的 `turn` 字段，只用来放开睡眠，不弹通知。
- 新增 `electron/cli-update-history.ts`：本工具走 npm 更新某个 CLI 成功、且版本号真的变了时，在数据目录 `cli-update-history/cli-update-history.json` 记一笔（每个工具只留最近一笔，14 天，8 KB 上限，读写走 safe-local-data）。点名版本的安装（回到推荐版本、退回本身）不记。`CliStatus.revertVersion` 只在「现在装的正是记录里更到的版本、还在期限内、要退回的版本不在 `findBlockedCliVersion` 名单里」时给出；Grok CLI 不参与。退回复用现有 `cli:install` 的点名版本，不加 IPC 通道。
- renderer-v2：`model.ts` 新增 `revertVersion()`（别的软件管着的安装不给）；首页「…」菜单加「退回更新前的版本 x」，经确认框后走 `install(id, version)`；`update-notice.ts` 新增 `rememberRevertedToolUpdate`，退回前把当时的最新版本记成已提醒，避免刚退回就弹「有新版本」通知。
- `cli-verified-versions.ts`：`VerifiedCliRelease` 加可选 `userNote`（给客户看的一句话），`CliVersionAdvice` 加可选 `recommendedNote`，只在推荐版本比已装的新且安装钉在推荐版本（`pinned`）时带；`blocked[].reason` 全部改成不含技术词的说法，新测试钉住 `userNote` / `reason` 不出现 npm、400、中转、网关等词。
- renderer-v2 `versionSubtitle` 把这句接在「推荐 x」后面，新 `updateButtonHint` 给「更新」按钮加悬停说明。
- `docs/CLI-VERIFIED-VERSIONS.md`「怎么更新名单」补一步：抬推荐版本时同时改写 `userNote`。
- 关闭询问框加 `checkboxLabel`，`requestCloseDecision` 可返回 `{ decision, remember }`；勾选且不是「返回」时经新钩子 `rememberCloseBehavior` 写 `closeBehavior`，退出前等它写完（`window-lifecycle.ts`、`main.ts`）。
- 新钩子 `onHiddenToTray`：第一次缩到托盘发主进程通知 `hiddenToTray` / `hiddenToMenuBar`（不归哪一类通知偏好，只看总开关）；系统通知发不出时 Windows 退到托盘气泡（`application-tray.ts` 的 `showBalloon`）。提示出过后 `settings.json` 记 `trayHintShown: true`，只落 true，渲染层保存设置的通道带不进来。
- 设置页回到窗口时重读 `closeBehavior`，避免停在设置页时关窗记住选择后，那一行还显示「每次询问」、点了没反应。
- `codex-extensions.ts`：`validateSkillTree` 拒绝 `nlink !== 1` 的普通文件（#540）；导入不再用 `fs.cpSync`，改为 `copySkillTree` 逐个文件 `O_NOFOLLOW` 打开、在句柄上复核单链接普通文件且与校验时同一 inode，目标一律 `wx` 独占创建。回收站跨盘兜底同样经过 `validateSkillTree`，含硬链接的技能跨盘卸载会被拒。
- `addMcpServer` 在 `codex mcp add` 失败后，只在回读条目与请求的传输类型、命令与参数、环境变量名（stdio）或 URL 与 Bearer 变量名（HTTP）都一致时才当作已落盘（#539）；同名旧配置不再被当成替换成功。成功路径的对账不变。
- Codex 0.157.0 把 `features.daemon_auto_start` 转为默认开。接当前账号时 `applyCodexRelayMachineDefaults` 与新装模板在键缺省时写 `daemon_auto_start = false`（用户写过的不动，切回 ChatGPT 不收回，与 `prevent_idle_sleep` 同一口径），客户自己在终端敲 `codex` 也不再拉起常驻服务；0.155.x 及更早不认此键，只记一行 `unknown feature key` 日志（`features/src/lib.rs`）。`codex agents` 自己按需拉起服务，不受影响（rust-v0.158.0 `cli/src/main.rs`）。
- `cliLaunchArgv` 的 `--no-daemon` 不再只限 Windows：macOS（以及开发用的 Linux）从本软件打开 Codex 时同样按已装版本（≥ 0.156.0）带上，`CliLaunchArgvOptions.platform` 随之去掉。
- 新增 `diagnostics:probe-codex-responses`：两次非流式 Responses 请求（第一次强制调用固定的无副作用函数，第二次交回随机标记并核对 call_id 与最终回答），共用一个超时、单次响应 64 KiB 上限、拒绝重定向、密钥只在主进程，主进程单飞并在账号或配置切换后停发第二次请求（#618，取代 codex-win 的 #624）。开机账号恢复期间渲染层先拦下，不再误报「账号变了」；渲染层与主进程统一用 `accountScope` 算计费作用域。
- Codex 的 `resume --last` 在上游按「工作目录 + 当前 model_provider」过滤，找不到就直接开新会话（codex-rs/tui/src/lib.rs，rust-v0.156.1 与 main 一致）；而 `resume <UUID>` 走 thread/read，不看 model_provider。`cli:launch` 加第四个可选参数（仅 Codex + resumeLast，形如 `codex:<UUID>`），主进程用 `providerSessionsService.resolveWorkspace` 核对记录存在且在同一文件夹后按 id 续接，核对不过就退回 `resume --last`；argv 里只放重新校验过的裸 UUID。其余三家仍按目录续接。
- `config-files.ts`：新增 `applyCodexRelayMachineDefaults`，Codex 接当前账号时（新装模板与已有配置合并两条路径）在键缺省时补 `[features] prevent_idle_sleep = true`，Windows 上再补 `[windows] sandbox = "unelevated"`；用户写过的值（含 `false`、`elevated`、非表的标量）一律不动，切回官方账号不收回。键名以 rust-v0.156.1 的 `core/config.schema.json` 为准；按 0.156.1 的 `tui/src/app/platform_actions.rs`，配成 unelevated 后启动期的沙箱引导不再出现。Windows 真机没验证。
- `safe-local-data.ts` 新增 `appendSafeUtf8FileSync`，两个追加函数都多了可选 `{ durable }`（写完 fsync），与异步版同一套单链接、无重定向、打开后复核的边界。
- `codex-sessions.ts` 的 `appendJournal` / `appendJournalSync` 改走上面两个函数，不再裸 `open(..., 'a')`（#536，codex-win F01）。
- 启动时操作日志安全读取失败会记下来；之后每次归档/恢复前先重试启动恢复，仍读不了、或日志变成硬链接/重定向时直接拒绝，不建备份、不动 SQLite 和 JSONL。
- 测试夹具的临时目录改用 `realpathSync.native`，macOS 的 `/var` 别名与 Windows 8.3 短名不会被新的路径组件检查误拒。
- 接 #619/#641 的尾巴（第十七批候选 1）：`inspectProviderConfig` 给 Codex 新增 `codexProviderName` 与 `codexProviderShadowed`（活动名是保留名、那张表的地址属已登记站点）。`actualBaseUrl` / `matchesRelay` 不变，切回官方、删中转表、启动门禁照旧。
- 渲染层 `connectionReady` 遇到 shadowed 返回假，`sourceFor` 不变（「切回官方账号」菜单项保留）；首页状态 `codexShadowed` + 「修好它」走 `config:switch-account-source`（备份、写入、自检、失败回滚）；`launch` 在修完就能用时先修再打开。开机恢复账号对有归属记录的配置会自然重写；没有归属记录的见 `codex-shadowed-autofix.md`。
- 连接自检在配置层拦下 shadowed（`config` 层，不发请求）；反馈报告的 Codex 行带上连接名。
- Windows 上从本软件打开 Codex（新对话与「接着聊」）时，已装版本 ≥ 0.156.0 就带 `--no-daemon`。Codex 0.157.0 把自动起后台服务（`features.daemon_auto_start`）转为默认开，后台服务要用 `CREATE_BREAKAWAY_FROM_JOB` 脱离启动它的窗口；宿主外层有不许脱离的 Job Object 时报 `host Job Object prevents daemon detachment` 退出，以管理员身份运行时同样拒绝启动。本软件的启动链（libuv 的 Job 带 `SILENT_BREAKAWAY_OK`、`Start-Process`、开机自启走 Run 键）不加这种 Job，也放不开外层的，所以改为内嵌模式。0.155.x 及更早不认这个参数、读不出版本时不带；macOS 不变。见 `tool-installation.ts` 的 `cliLaunchArgv`。
- 主窗口接上 `context-menu`（`electron/context-menu.ts`）：菜单项走 Chromium 的 cut/copy/paste/selectAll role，按 `editFlags` 置灰（密码框不能复制、剪切），不用放开剪贴板读取权限；只给 http(s) 链接「复制链接」，不提供「打开」，免得绕开导航白名单；不加「检查元素」。渲染层自己 `preventDefault` 的右键（聊天图片菜单）不受影响。画布窗口不在这次范围内。
- 第十七批 3：新增 `electron/system-certificate-trust.ts`。普通权限下 npm 安装（`executeNpm`）与打开工具的终端环境（Windows `sameUserTerminalEnvironment`、macOS 启动脚本放行 `NODE_USE_SYSTEM_CA`）带 `NODE_USE_SYSTEM_CA=1`，用户已设的值不覆盖；`trustedCommandEnvironment` 把 `node_use_system_ca` 加进禁止项，管理员身份时一律不带。
- 查 npm / Grok 版本元数据改走宿主注入的 `registryFetch`（main.ts 接 Chromium 的 `downloadFetch`），主进程自带的 Node fetch 不读系统证书库；管理员身份仍用 Node fetch。
- npm 报证书错误时 `withToolCertificateHint` 按 Node 版本（22.19 / 24.6 起支持该变量）与执行模式追加 `toolCertificateMessages` 的一句，渲染层新增 `toolCertOutdatedNode` / `toolCertElevated` 两类；`networkFailureMessages.tls` 与 `tlsIntercepted` 文案改为区分公司电脑与个人电脑。
- 第十五批 1：`new-api-client.ts` 登录遇到 `require_2fa`（及上游改名后的 `require_verification` + `methods`，推测，按上游主干源码写）不再只抛错，改抛带私有 flow token 的 `NewApiTwoFactorRequiredError`（消息原文不变，冻结的旧界面照旧当报错）；新增 `completeTwoFactorLogin` 调 `POST /api/user/login/2fa`，成功后与普通登录同样落会话。`methods` 里没有可用 `2fa` 时照旧提示去官网。
- `realm-account-service.ts` 在内存里保管这一次的 flow token（最多 5 分钟，新登录、退出、用过即丢），新增 IPC 通道 `account:submit-two-factor-code`（只收验证码，入参与结果都不进运行日志）。输错、限流、锁定都还能接着输；服务端说会话过期才回到输密码。
- renderer-v2 登录框多一步输验证码 / 备用码；历史账号的两步验证仍指去官网。
- 新增 `electron/display-compat.ts`：主进程监听 `child-process-gone`，显卡进程非正常退出时同步追加一行时间戳到 `%APPDATA%\xingmang-ai-manager\display-crashes.log`（同步 + fsync，防止 Chromium 连崩后直接结束进程时记录没落盘）。下次启动在 ready 之前读它，10 分钟内 2 次以上就调 `app.disableHardwareAcceleration()`，并经 `WindowCapabilities.displayCompat` 让渲染层挂一条二选一提示。
- 设置加 `hardwareAcceleration`（缺省开，只落盘 `false`，同 `crashReporting`）；设置保存时带了这个字段就清掉崩溃记录、从头再数。新 IPC 通道 `window:relaunch`（「现在重开」，走正常退出流程，退出确认里点返回会撤销重开；退出时装更新则不重开，由安装器打开新版本）。`safe-local-data.ts` 补 `removeSafeDataFileSync`。缺省行为不变：没出过问题的电脑照旧用显卡加速。
- 下载页补上「Windows 第一次安装」两步（蓝色「Windows 已保护你的电脑」→「更多信息」→「仍要运行」），Mac 两项下载写明需要 macOS 13 或更新，教程说清怎么看自己是哪种芯片，并把「Gatekeeper」「Apple 公证」「DMG」换成大白话。只改仓库里的下载页源文件，上线仍需手动发布下载页。新增 `scripts/dl-landing-install-guide.test.cjs` 把最低 macOS 版本和构建配置钉在一起。
- 下载页「Mac 第一次打开」主路改成「双击一次 → 系统设置 → 隐私与安全性 → 仍要打开 → 输开机密码」：macOS 15 起「右键 → 打开」已经不能放行。右键打开降为折叠段里给 macOS 14 及更早系统的补充；`docs/MACOS_FREE_DISTRIBUTION.md`、`docs/CI-PACKAGING.md` 同步改顺序。`scripts/dl-landing-install-guide.test.cjs` 钉住主路步骤里不再教右键。只改仓库里的下载页源文件，上线仍需手动发布下载页；界面原字按 macOS 15 中文界面写，未在真机上核对。
- 新增 `electron/documents-fallback.ts`：`isWritePermissionError`（顺 cause 链认 EPERM / EACCES）、`probeDirectoryWritableSync`、`createStarterWorkspaceWithFallback`（建好后在新文件夹里再试写一次，不让写就删掉空文件夹改建到主目录）、`inspectDocumentsWritability`、`buildDocumentsFallbackPrompt`。`createStarterWorkspace` 包中文错误时把原始错误挂在 `cause` 上。受控文件夹访问报哪个错误码、是否放行建文件夹都是推测，没在 Windows 真机上抓过。
- `ai-output-location.ts` 新增 `chooseAiOutputRoot`：启动时在「文档」下建目录并试写，权限类失败改用主目录下的 XingmangAI（按账号 scope 两边都套）；`main.ts` 用它替代直接的 `resolveAiOutputRoot`，业务对象多带 `aiOutputPlacement`。
- 诊断新增 `DOCUMENTS_WRITABLE`（只在 Windows、宿主给了 `documentsDirectory` 时），`AI_OUTPUT` 换过地方时在 details 里标 `openFolder`。
- 新 IPC 通道 `diagnostics:open-folder`（`openDiagnosticFolder`），入参只收 `'projects' | 'ai-output'`，路径由主进程算，打开前过 `ensureSafeDataDirectory`；`IpcRegistrationOptions` 加可选 `aiOutputDirectory`。
- `redaction-patterns.ts` 的共用脱敏表新增 URL userinfo（http(s) 一律遮，其它协议有密码才遮，`ssh://git@` 保持可读）和 `ghp_`/`github_pat_`/`glpat-` 令牌形状，日志、诊断、崩溃报告、反馈一处生效（#537）。
- `provider-extensions.ts` 把扩展来源里的账号和令牌（含百分号解码后的形式）作为 `sensitiveValues` 传给 command-runner；地址本身照旧交给 CLI，不拒绝已有用法（#537）。
- `ProviderExtensionService.mutate` 在开头固定一次 `repositoryRoot`，查找 Gemini 技能、项目检查和执行命令都用这一份；认不出所在层的技能拒绝卸载，不再缺省成 `--scope user`（#488）。
- #538：将工具启动请求绑定发起时的账号代次，在配置读取、模型核对与确认、保存、目录选择和启动前逐段复核；旧账号的迟到失败不再弹到新账号界面，同账号保存模型失败仍按原行为打开。新增隔离浏览器延迟响应回归。
- 托管 CLI Key 缓存按站点标记新记录，沿用旧记录的静态分组校验；动态分组使用与服务端分组解析一致的长度、空白和控制字符校验。
- 完整缓存离线复用；部分缓存和 401 换新在分组列表不可用时优先保留已确认的分组。补真实加密 store 的写入、重启、换新和非法组名回归。
- Codex Desktop 进程探测校验 owner SID、SessionId 与包家族，无法确认 owner 的进程不进入终止列表；关闭后的等待与强关只看最初选中的 PID，去掉 taskkill 的 `/T`，改为在关闭路径上按包目录收进同包的辅助进程（#598，取代 #612）。
- 只有安装、更新、卸载、重启这些要关进程的路径在进程探测失败时报错；状态检测与「打开」仍按「没找到」处理，不因系统查询慢而失败。
- 只装 Beta 时安装/更新沿用原行为（装正式版），且不关闭 Beta 的进程；去掉 #612 里对这种情况的拦截。
- AppX 卸载回查仅在当前用户包探测成功且确认不存在时返回成功；覆盖包仍存在、探测失败及状态不确定的回归测试（#599）。
- #602：成功保存模型后只重读配置摘要，保留系统检测结果并防止切号后的迟到回读覆盖新账号；保存失败沿用原有警告与打开行为。新增隔离浏览器回归。
- 依赖锁文件把 undici 从 6.28.0 / 7.29.0 升到 6.29.0 / 7.30.0（node-gyp 与 @electron/get 间接依赖，均为开发依赖），修掉新公告 GHSA-3wwx-pv8p-q78v 让 CI 的 npm audit 报红。
- `electron/git-runtime-install.ts` 新增 `verifyInstalled` 回查：安装程序退出 0 后由 `system-service.ts` 的 `inspectGit()` 找一遍 Git（含代装的两个固定目录，不依赖本进程 PATH 刷新），找不到或回查抛错即报 `gitRuntimeMissingAfterInstallMessage` 并失败，不再换源重装；找到时结果里的版本取回查值（Fixes #549，codex-win R02）。
- #544：`SessionsPage` 的 `onResumed` 改名 `onSessionsChanged`，归档 / 恢复成功后也调用，经 `BusinessPage` 接到 `App.tsx` 的 `refreshRecent()`，作废首页「最近」的 60 秒缓存并让正开着的首页重读。浏览器用例 `archiving a session on the sessions page refreshes the home recent card right away`（夹具新增 `?sessionArchive`）。
- `features/tools/recent-display.ts`（新）：`formatRecentTime` 按本机日历天数写「刚刚 / 今天 HH:MM / 昨天 HH:MM / M月D日 / YYYY年M月D日」，`recentSessionSubtitle` 写「工具名 · 文件夹名」（完整路径放进小提示），`recentResumeHint` 给「接着聊」写上工具名。`ui/core.tsx` 的 `ListRow` 加可选 `leading`，首页「最近」行首放 `BrandIcon`。第十六批 10。
- 新增 `electron/install-leftovers.ts`：只按固定前缀 + mkdtemp 6 位随机串认星芒自己建的安装临时目录（npm 事务、Grok、Codex 桌面端、Node.js、Git、Python、WorkBuddy），超过 6 小时、是普通目录且 realpath 不变才删；Windows 普通权限只扫用户临时目录，按管理员处理时只扫 ProgramData 的 InstallerCache，绝不在用户可写处做管理员级删除（同 I8）。
- `SystemService.cleanupInstallLeftovers` 排进 InstallationQueue（I11），开机安静期结束后再等 2 分钟跑一次、每次 CLI 装好后跑一次；只记 runtime.jsonl，不弹提示。删除实现由 main.ts 注入，缺省不清，单测不碰开发机临时目录。
- 候选第十七批 7 的前提有一处与代码不符：npm 下载缓存本来就是每次安装各一份、装完在 finally 里删（system-service.ts 安装收尾），真正会越积越多的是安装被打断或删除失败时留下的整份临时目录，所以没有加「清理」按钮和新 IPC 通道。
- `InstallProgress` 加可选字段 `stage`（`version` / `download` / `switch-route` / `verify` / `install` / `final-check` / `raw-output`）和 `elapsedMs`，缺省 = 旧行为。`system-service.ts` 的 CLI 安装各处进度带上阶段，并补了「装到电脑上」「最后检查」两句；npm 自己的输出标成 `raw-output`，带阶段的原话（心跳与下载百分比除外）写进运行日志（`cli.install.progress` / `cli.install.output`）。
- 渲染层新增 `features/tools/install-stage-text.ts`：按阶段取固定白话；`raw-output` 只进任务日志，不改进度那一行。
- 第十四批 7：`notifyActivity` 多一个可选参数 `{ tool, outcome }`（只许 `install` 类带），主进程 `platform/ipc.ts` 逐字段重建并校验编号字形，`notifications.ts` 按固定名单换成工具名，名单外一律说「工具」；标题与正文仍只在主进程拼。
- `useToolbox.run` 不再按任务文字猜「是不是安装」，改由调用方传 `notice` 明确开启；失败（用户取消除外）也发，窗口可见且有焦点时不发（与公告同口径）。装运行环境要重启电脑的那种不说「装好了」；装工具时顺带准备运行环境不再单独多发一条。
- `build/installer.nsh` 在安装程序顶层补一句 `InstallDir "$PROGRAMFILES64\${APP_FILENAME}"`。electron-builder 模板不写 InstallDir，NSIS 的浏览后自动追加（`install_directory_auto_append`）因此是空的，选盘根只剩 `D:\`，而 NSIS 默认不许装在盘根，按钮被禁用。默认位置仍由 multiUser.nsh 的 .onInit 决定；0.2.9 同样如此（installer.nsh 与模板在两版之间都没碰过这一处）。`scripts/windows-installer-install-directory.test.cjs` 钉住这一行。
- #475 复核 F03：`managed-key-replacement-store.ts` 的 `set()` 读到坏文件不再从空记录重写，照样抛 `ManagedKeyReplacementUnreadableError`；`account:revoke-key` 遇到它报「先点一次重新写入 Key」，不撤销。只有显式「重新写入 Key」才 `reset()`。
- #476 复核 F05：`realm-account-service.ts` 的 `promote` 里 `vault.get` 读失败不再当 null 继续覆盖旧凭据，改抛 `STORAGE`；`login` 的 finally 随即注销刚登上的新会话。
- `app-settings.ts` / `ipc.ts`：设置新增可选字段 `largeText`，只把 `true` 落盘，缺省 = 关；`settings:save` 对非布尔值报「大字设置」格式错误。
- `src/renderer-v2/styles/tokens.css`：`:root[data-large-text="true"]` 把 `--font-small*` / `--font-micro*` 四个变量各加 1px，正文与布局不动。
- `features/app/ui-scale-shortcut.ts`：Ctrl/⌘ + `+`/`=`/`-`/`0` 的识别与步进（「自动」按 100% 算），App 统一拦截并 `preventDefault`，Mac 菜单里的「放大 / 缩小」不再单独改缩放；设置页通过新的可选属性 `uiScale` 跟上快捷键改过的值。快捷键说明补了两行。
- `login-launch.ts` 新增 `createLoginQuietPeriod`（`loginQuietPeriodMs` = 3 分钟）：开机拉起时进入安静期，主窗口第一次 `show` 或到时结束，日志 `launch.quiet-started` / `launch.quiet-ended`。
- `main.ts`：`launchedAtLogin` 提前到预热扫描前算出；预热扫描等安静期结束；安静期里托盘先用 `system-snapshot.json` 的旧结果。加速的系统代理还原不受影响。
- `ipc.ts` 新增可选 `startupQuiet`：安静期里 `system:scan` 的首屏读取只回旧结果不起真扫描（`cachedScan({ startScan: false })`），真扫描、`update:startup`、`account:sync-managed-cli-keys` 都等安静期结束。主进程统一拦，渲染层不改，也不加 IPC 通道。
- 新增 `electron/macos-node-runtime.ts`：macOS 上 `runtime:install-node` 从 npmmirror / nodejs.org（沿用 `node-runtime.ts` 的来源白名单与重定向校验）取最新 LTS 的 `darwin-<arch>.tar.gz`，对 SHASUMS256，用 `/usr/bin/tar` 解到 `~/Library/Application Support/XingMangAI/Runtime/node`，再用 `codesign` 按 Node.js 的 Developer ID（`HX7739G8FX`）核 `bin/node` 的签名、核版本号，最后整目录换上（失败保留旧的）。`platform-capabilities.ts` 的 macOS `nodeRuntimeInstall` 改为 `managed`，Python 仍 `external`；Windows 不变。
- 托管 Node 的 `bin` 排在 `darwinCommandPathCandidates` 与 darwin `trustedCommandEnvironment` 的最后，不顶掉用户自己的 Node。`node-runtime.ts` 的 `parseNodeReleaseIndex` 加 `kind` 参数（缺省仍认 Windows MSI），下载与取文本的内部函数导出给 macOS 复用，`NodeRuntimeInstallResult.method` 加 `'archive'`。
- 新增 `electron/macos-git-install.ts`：macOS 上 `runtime:install-git` 只把 `xcode-select --install` 排进安装队列，之后每 5 秒看一次 `/usr/bin/git` 背后那份能不能用、苹果的安装程序还在不在，判出装好 / 取消 / 一分钟都没看到安装程序 / 一小时超时。`GitRuntimeInstallResult.installed` 放宽为 `boolean`，`action` 加 `'cancelled' | 'pending'`，并带 `message` 给首页。
- `git-runtime.ts` 与 `commandLineToolsShimNotice('git')` 的 Mac 文案改为指向「安装 Git」按钮，不再叫客户开终端。
- 没在真 Mac 上试过：苹果安装程序的进程名、它要不要管理员密码、普通账号能不能装、下载要多久；下载的 Node.js 会不会被系统拦（推测不会，本软件自己下载的文件不带隔离标记）。Node.js 的签名团队号由 macOS CI 上那条用 setup-node 的官方 Node 核对的测试确认。
- `starter-workspace.ts` 新增 `resolveNewProjectParent`：macOS 一律返回主目录，Windows 仍走 `resolveStarterWorkspaceParent`。AI 生成的图片视频位置（`ai-output-location.ts`）不经过终端，仍用原函数，不搬老用户的作品。`IpcRegistrationOptions` 加可选 `homeDirectory` 供测试注入。
- macOS 终端启动脚本：`cd` 失败或进去后 `/bin/ls -A` 读不出时，打 `cli-exit-hint.ts` 里的 `macosFolderAccessHintLines` 并 `exit 1`，不启动 CLI。受保护文件夹「能进、读不出」与报错原文是推测，没在真机上复现过。
- `electron/window-presentation.ts`：macOS 应用菜单每个 role 项补中文 label，role 保留，快捷键与系统行为不变（第十三批 10）。
- `build/installer.nsh`：卸载清理与覆盖安装文件被占用时的 DetailPrint / Abort 文案改中文；退出码单独一行「排查用代码」，退出码 32（换管理员账号卸载，uninstall-cleanup.ts 的 otherAccount）单独说明。`scripts/windows-installer-uninstall-cleanup.test.cjs` 钉住所有 DetailPrint / Abort 都含中文、32 与 otherAccount 一致。
- #538：`tool-model-check.ts` 在模型列表返回后、刷新 Claude Code 菜单前都重新核对配置身份（站点、账号、Key、型号），变了就返回 `skipped`；`refreshPicker` 多收一个 `assertCurrent`，由 `system-service.ts` 作为 `saveConfig` 的 `assertBeforeWrite` 在落盘前再验一次。`tools:check-models` 纳入 `ipc.ts` 的账号工作门禁，切号会等它跑完并拒绝跨修订号的结果。renderer-v2 `App.tsx` 的打开流程按 `accountEpoch` 丢弃旧结果，切号时替用户关掉还开着的换模型弹框。
- 新增 `electron/data-transfer.ts`：导出文件只带 13 项跟着人走的设置（主题、皮肤、缩放、大字、减少动画、关窗行为、启动检查、自动更新、装最新版、下载来源、通知、崩溃上报），不带工作文件夹、窗口位置、显卡加速、`officialProviders`、站点、Codex 调试端口同意等本机或账号相关字段；导入时整份严格校验（I5），64 MB 上限（I8），格式不对整份拒绝。设置分「这台电脑没改过、直接换」和「改过、先问」两份。
- 三条新通道 `chat-history:export-text`、`data-transfer:export`、`data-transfer:import`（ipc-contract / preload / ipc 同序），保存与选择文件的对话框都在主进程弹，导入只读不写。
- 渲染层 `features/chat/storage.ts`：导出去掉图片、请求状态和密钥样文字；导入用读本机记录的同一套 `readConversation` 逐条校验，已有对话不覆盖、合起来超过 50 个留最近的 50 个。导入前 `flushSync` 卸下聊天页并等 `settleHistoryWrites()`，免得聊天页下一次自动保存把刚导入的对话删掉。
- 新增 `features/shell/online-status.ts`（断网判断唯一出处）、`useOnlineStatus.ts`（`OnlineStatusContext` + `navigator.onLine` 订阅）、`OfflineBanner.tsx`。断网 = `navigator.onLine` 为 false，或余额连续 2 次读取都是本机网络类失败（`network-failure.ts` 归类里的 offline / dns / proxy / intercepted；超时、连接被拒、证书、服务维护不算，那可能只是服务那一侧的问题）。
- `balance-store.ts` 快照新增 `networkFailures`（连续本机网络类失败次数，成功或其他失败归零，换账号归零）；系统 `online` 事件来时若有失败计数就马上重读一次余额确认。
- 从断网恢复（不论是 `online` 事件还是余额重新读成功）都会触发一次现有的 Key 补跑（`planOnlineResync` 去重）。
- 断网时 `App.tsx` 的 `install` / `installRuntime`、充值报价、兑换、聊天 `send`、搜索框领加速口令都先返回「现在没网，等网络恢复后再试。」。有网时行为不变。
- `electron/payment-window.ts`：窗口被用户关掉（× 或界面上的「关闭支付窗口」）后，用同一个已绑定账号的 `PaymentOrderStatusReader` 在后台继续查：前 2 分钟每 5 秒、之后每 30 秒、最多 15 分钟（`paymentFollowUpDelayMs`），比窗口开着时的 3 秒更稀；查询间隔是保守取值，账号服务对查订单接口的限流没核实（推测）。到账 / 失败 / 过期照旧发同一事件，问满发新状态 `unconfirmed`；STALE（换账号、退出）静默停止；开新付款、`destroy()` 都会停。只有后端订单状态能报到账，这条不变。
- `AccountPaymentWindowTerminalEvent` 多了 `status: 'unconfirmed'` 与可选 `confirming`；`onTerminalState` 多第二参 `{ afterClose }`，`main.ts` 只在关窗后才到账、且主窗口没在眼前时发主进程通知 `paymentSettled`（只看通知总开关，通知里不带订单号，点开去「充值与订阅」）。
- legacy 界面（冻结）只加一行忽略 `unconfirmed`，行为不变。
- renderer-v2 充值页：关窗后记住在确认的订单号，提示收起后晚到的结果仍会摆出来；「查看我的订单」经个人中心内部的订单请求（与付款回跳共用递增编号）打开「我的订单」。
- `electron/codex-plugin-catalog.ts`：修复前把旧的 `plugins-xingmang-backup-<uuid>` 清到只剩最新一份，修复成功后只留这次刚做的那份；只删完全符合命名格式的目录与单链接版本文件，链接、联接一律不碰（I8）。仍有 3 份以上删不掉时抛 `codexPluginCatalogBackupStuckMessage`，下载前就停，不再把文件夹路径抛给用户。
- 渲染层：`operation-error.ts` 新增 `pluginCatalogStuck` 归类；`ResultNotice` 新增可选 `onSupport`，目录文案里有「找客服」时出「联系客服」按钮，扩展三页接上帮助与客服弹窗。
- 新增 `electron/sensitive-clipboard.ts`：写入敏感文本 60 秒后，剪贴板里仍是同一段才清空；退出时（ipc dispose）顺手清掉未到点的那段。`account:copy-key` 改走它；新增通道 `account:copy-reset-password`（未登录可用、成功日志静默），找回密码的「复制」不再用渲染层 `navigator.clipboard`。Windows 剪贴板历史（Win+V）不记录这一层没做，Electron 的写法没核实。
- 新增设置字段 `crashReportingNoticeShown`（只落 true），渲染层登录后出一次性角落卡片 `crash-reporting`；「不想发送」同时写 `crashReporting: false`。上报缺省不变。设置页说明补上「发到海外的错误收集服务」。（第十三批 8、9）
- 新增 `electron/proxy-bypass.ts`：`createProxyBypass` 在余额连续两次报代理类失败后，由渲染层调 `network:bypass-broken-proxy` 触发；当前确实走代理、星芒加速没开（读不到加速状态按开着处理）时把 `session.defaultSession` 改成 `direct`，用 `/api/status`（`relayStatusProbeUrl`）探一次：不跟重定向、不读正文、8 秒超时，服务回了话就本次运行保持直连，否则改回 `system`。不落盘。
- 新增 `network:open-settings`（`proxy` / `captive-portal`）：地址写死在主进程（Windows `ms-settings:network-proxy`、`http://www.msftconnecttest.com/redirect`；Mac 网络设置、`http://captive.apple.com/`），渲染层不传网址。
- `balance-store.ts` 快照多存 `networkFailureReason`；`online-status.ts` 新增 `offlineCause` / `offlineBannerTexts` / `proxyBypassedBannerText`；`OfflineBanner` 按原因分三种说法。
- 平台服务 `describeSessionProxy`：经 `platform/proxy-bypass-bridge.ts` 读直连状态，给「网络连接」一行补原因。
- 第十六批 4。`AuthFlow.tsx` 找回第 3 步：用重置返回的随机密码 `loginAccount` → `changeAccountPassword`（已有通道，未加新通道）→ 按「记住密码」存新密码 → `onAuthenticated(result, { notice })`。两步验证复用 #585 的输入框，2FA 块不再只挂在 login 模式下。
- 失败兜底：登录没成回到原来的临时密码 + 「前往登录」；登录成了但改密码失败，亮出临时密码并给「继续」（关框也按登录完成处理，界面和主进程会话对得上）。第 3 步未设时隐藏「返回登录」、关框要确认，免得临时密码没看过就丢了。
- 服务端行为按 new-api v1.0.0-rc.24 源码核实：`PUT /api/user/self` 改密码后 `AdvanceCurrentSessionToUserVersion` 只给当前会话换 access token、不踢当前会话；重置链接要在网页上点按钮才会调用 `/api/user/reset` 用掉重置码，只打开链接不会；重置出的随机密码 12 位。新密码长度沿用注册的 8~20 位（`validateNewPassword`）。
- `renderer-v2/features/auth/state.ts`：新增纯函数 `normalizeEmail`（全角＠/句号转半角、去首尾空格）与 `suggestEmailCorrection`（常见邮箱的后缀手滑与名字错一个字，含相邻字母对调；数字邮箱和两位名字只纠后缀），`validateRegistration` 先规整再校验。
- `AuthFlow.tsx`：离开邮箱框或点「获取验证码」「创建账号」时规整邮箱并给拼写提示；同一个疑似拼错的地址第一次按下先停下提醒，第二次放行。焦点直接落到这两个按钮时不在失焦里出提示，免得弹窗撑高把按钮挪走、这一下白点。只改渲染层，不加通道，服务端不动。
- 回滚按平台分开判断（#547）：`rollback-release` 遇到线上已经是目标版本的平台直接跳过，不再连带挡住另一个平台的回退；线上比目标还旧仍然第一步就停。判断在 `scripts/rollback-release.cjs plan`。
- 发布前多读一次线上 `service-status.json`（只读，#548）：要发的版本在撤回名单里就在任何上传之前停下，避免回退后重跑坏版本的发布把清单又指回它；状态文件读不到或看不懂同样停下。要让它原样重新上线，先用 service-status 把它移出撤回名单。
- 发布前查 tag 不再吞错（#493）：改用 `git/matching-refs`，没有这个 tag 时回空列表，接口报错（权限、网络、5xx）一律在写 R2 之前停下，不再当成「没有 tag」放行。
- #623：移除启动壳层未消费的配置硬依赖；已登录账号自动同步 Key 前先只读确认配置可读，账号复核后才允许签发，同时保留同步后的最新配置读取与写入规划。新增已登录及游客隔离回归。
- `docs/SERVICE-STATUS.md`「坏版本回退」按 0.2.10 发布后更新目录里实际的清单备份（只有 0.2.8、0.2.10）补了「现在能退到哪」：
  0.2.10 自己出问题时填 0.2.9 会在第一步停下（0.2.9 没正式发布过、没有备份）；填 0.2.8 会跑完，效果是撤下 0.2.10、
  挡住 0.2.8 及更早的客户端，但装了 0.2.10 的客户端低于 `rollbackFloorVersion` 不接，只能等 0.2.11。另写明 rollback-release
  本身不查这个下限，以及只在 service-status 里撤回挡不住 0.2.10 之前的客户端。只改文档，发布链路没动。
- 新通道 `provider-sessions:delete`（`ipc-contract.ts` / `preload.ts` / `ipc.ts`），入参只有会话 id；`ProviderSessionCapability.operations` 加可选的 `delete`。
- `provider-sessions.ts`：删除前重新扫一遍该工具的记录目录，不信任缓存里的 id→路径；文件必须是单链接普通文件、真实路径在记录目录内；Claude 同名子文件夹、Grok 整个会话文件夹只在是真实目录且严格在根目录之下时才删，Grok 文件夹里还有别的会话时只删它自己的两个文件。删完同步清探测缓存。
- `codex-sessions.ts`：`delete()` 与归档共用串行队列，在一个事务里删 `threads` 行、先删 rollout 再 COMMIT，删不掉就回滚；不做数据库备份（留备份等于没删）；原文已不在时只删索引；有未收尾的归档/恢复时拒绝。`permanentDeleteAllowed` 改为跟随可写状态。
- 第十五批 7：新增通知种类 `spend`（偏好默认开，老设置文件缺这一项按开补齐）。渲染层 `features/app/spend-spike.ts` 只用余额 store 每次读成功的钱包余额算一小时净减少（充值不抵扣、两次读成功隔超过 15 分钟的那段不算），掉到 $5 以上才调一次 `spendBaseline` 读最近一小时与七天用量核账（最多 15 分钟一次，不新增轮询）；以用量记录为准，排除买订阅之类的余额减少。通知正文由主进程按固定格式拼，渲染层只传两个有界整数（美分、倍数），`platform/ipc.ts` 逐字段重建校验，金额不进日志。点通知跳 `account → dashboard`（账号不支持看板时退到调用明细）。
- 第十六批 5：新增 `electron/stale-proxy-environment.ts`。`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（大小写都算）指向本机端口时 300 毫秒试连，连不上的这一次不带；开着的、指向别的机器的、认不出的照旧带。Windows 打开工具（`launchCliPowerShell` 的环境）和 npm 安装（没开加速时的基础环境）都走它，只减不增，探测出错原样返回；日志 `network/proxy-env.bypassed` 只写变量名和端口。已核实 npm 的 `@npmcli/agent` 读 `https_proxy` / `http_proxy`；各 CLI 认哪几个名字按公开说明推测，未逐一核实。
- 检查项 `PROXY_ENVIRONMENT` 在 Windows 上改为 `windowsProxySettingsOutcome`：分没设、本机代理没开（当前账号可清 / 整台电脑 / 读不到）、本机代理开着、别的机器几种说法，details 不带原值。「去处理」不再落到设置页。macOS 保持原样。
- 新 IPC `diagnostics:clear-stale-proxy`（无入参）：主进程点的那一刻重新读 `HKCU\Environment` 与机器级、重新试连，只删当前账号下指向没开本机代理的那几条（名字经环境变量传给 PowerShell，脚本内再对照固定名单），不碰机器级、不提权；清完同步本进程环境。
- `electron/main.ts`：启动时那次设置整理改走 `AppSettingsStore.normalize()`（`app-settings.ts` 新增 `normalizeAppSettings`），磁盘内容已是整理后的样子就不写；写失败只记 `config/settings.normalize.failed`，不再抛到启动兜底。失败种类经 `window:get-capabilities` 的可选字段 `settingsSaveIssue` 交给渲染层，`startup-notice.ts` 的 `settingsSaveNotice` 挂一张角落卡片（第十三批候选 2）。
- 启动兜底弹框从 `showErrorBox` 换成 `showMessageBox`（复制错误信息 / 打开日志文件夹 / 退出）；文案由新模块 `electron/startup-failure.ts` 按 ENOSPC、EACCES/EPERM/EBUSY、MODULE_NOT_FOUND/app.asar、其它四类给出，复制出去的原文先过 `redactHomeDirectory` 与密钥脱敏（I13）。
- `runtime.jsonl` 写不进去本来就不会拖垮软件（`RuntimeLogStore` 写失败只留在内存并在报告里注明），这次没改。
- 新增 `electron/subscription-summary.ts`（无 Node 依赖，已加进 renderer 边界门禁的 `valueImportable`）：`resolveUsableSubscription` 判断「有生效中、没过期、有剩余额度、扣费偏好不是只用余额」的订阅；new-api 的 `amount_total` 为 0 按不限额处理，Sub2API 取最紧的限额窗口。首页、`App.tsx` 跌破 $5 的通知和托盘共用这一个判断。
- 渲染层 `features/app/subscription-cache.ts`：不另起定时器，跟着余额每次读回顺带读一次 `account:get-subscription-self`，5 分钟内读过不再读；订阅没带名字时才读一次套餐列表。读失败保留上次结果。
- 主进程 `ipc.ts` 的 `account:get-subscription-self` 读成功后回调 `onAccountSubscription`，`main.ts` 存下来给托盘菜单和提示用（`traySubscriptionLabel`），换账号时清掉。没有新增 IPC 通道。
- 帮助弹窗加身份条（第十三批 6 的弹窗部分）：`src/renderer-v2/features/app/SupportIdentity.tsx` 纯函数拼「账号名（ID）· 版本 · 系统」，未登录写「未登录」，拿不到正整数 ID 时只写账号名；不带邮箱与站点名。反馈报告不变。
- `src/renderer-v2/ui/feedback.tsx`：新增 `toastDurationMs`（2.4 秒起，超过 12 个字每字加 0.2 秒，最长 10 秒；`warn` / `bad` 返回 null 不自动消失）。每条提示自己计时，鼠标悬停或获得焦点时暂停、移开接着倒数；常驻的带关闭按钮。最多同时 3 条、`aria-live` 与 `role="status"` 不变。
- `components.css`：`.xm-toasts` 仍 `pointer-events: none`，只有 `.xm-toast` 本身接鼠标，不挡页面其它地方。
- 新增 `src/renderer-v2/features/shell/command-search.ts`（纯函数 `searchCommands`）：顶部搜索的索引从 16 个页面扩到个人中心分页、设置分组和教程主题，组内按「名字完全一样 < 名字开头 < 名字里有 < 常用说法 < 教程正文」排序，教程最多列 5 篇；个人中心分页按当前账号能不能打开过滤（`accountTabVisible`）。
- 常用说法放在注册表：`registry/business.ts` 的 `accountTabs` / `settingsGroups` 各项加 `keywords`，`registry/pages.ts` 新增 `pageSearchKeywords`（`Record<PageId, …>`，漏页是编译错）。
- 教程页的全文匹配挪到 `features/tutorial/tutorial-search.ts` 与顶部搜索共用；`TutorialPage` 的 `topic` 多一个可选 `query`，外壳的「去教程里搜」经 `App.tsx` 的 `searchTutorial` 带过去。外壳 `navigate` 带上分页参数；搜索框读屏名改为「搜索页面、设置和教程」。加速口令的判断和优先级不变。
- 新增 `electron/windows-processor.ts`：经 System32 的 reg.exe 异步读机器级 `PROCESSOR_ARCHITECTURE` 与 CPU Identifier 认出真实芯片（x64 星芒在 ARM64 上被模拟，`process.arch` 报 x64），读 node.exe 的 PE 头判断现有 Node.js 是哪一版。
- 装 Node.js 时本机没有 Node 才按真实芯片挑包，已有 Node（版本旧要换）跟它保持同一版，避免 x64 / arm64 两份 MSI 混装；认准芯片时 winget 追加 `--architecture`。
- 诊断新增 `WINDOWS_ARM`（只在 ARM 电脑出现，只做说明）。第十七批候选第 5 条第一步；ARM 安装包（第二步）未做。

## 0.2.10 - 2026-09-23

- `electron/cli-verified-versions.ts`：Codex `recommended` 从 0.155.1 抬到 0.156.1。0.156.1 起自带的模型目录才有 `gpt-6-sol` / `gpt-6-luna`；0.155.1 用它们会走 fallback metadata（旧提示词、旧工具集）。沙箱本地假接口实测过请求体、`codex doctor`、关统计与官方主机丢包，细节见 `docs/CLI-VERIFIED-VERSIONS.md`。没在中转上真跑。
- `electron/new-api-client.ts` 的 `retryAfterSilentRefresh`：401 后静默续期失败时，只有续期接口明确拒绝凭据（`NewApiAuthenticationError`，含没有 refresh cookie）才清会话；超时、断网、429、5xx、维护保留会话并抛出续期自己的错误，与 `refreshAccessToken` 语义对齐。此前任何续期失败都会 `setSession(null)`，`realm-account-service` 随即把账号从本机账号库删掉。access token 15 分钟过期，续期接口与登录共用按 IP 的限流（校园网、公司网共用出口易 429），这条路径每天都在跑。
- 全面检测 Q2。Electron 收到 `WM_ENDSESSION` 后立刻结束进程，`before-quit` / `will-quit` / `prepareToQuit` 都不跑，系统代理只能靠后台辅助进程事后还原，关机那几秒基本来不及。`window-lifecycle.ts` 改在窗口的 `query-session-end` 上判断 `needsShutdownCleanup()`（`main.ts` 接 `acceleration.hasPossibleSession()`），需要时 `preventDefault` 推迟关机，按 10 秒预算跑完 `prepareToQuit`（`stopAll` 会等代理还原完才停内核）再退；没开加速不拦。原来挂在 `app` 上的 `session-end` 监听是死代码（它只在窗口上发），一并改到窗口上。
- 第十批候选 3。`AccelerationState` 新增可选字段 `autoStartedBy?: 'codex-desktop'`，缺省即旧行为（用户自己连的）。
- `acceleration-service.ts` 新增 `startAutomaticAcceleration(scope, origin, mode, lineId?)`，不进 `AccelerationApi`，渲染层没有通道能冒充这个来源；服务按账号记住软件连上的那次会话（认 `connectedAt`，开始前已在跑的不算），此后这次会话的每一份状态都带上标记，会话结束或换成另一次连接即清掉。
- `codex-desktop-acceleration.ts` 新增 `onAutoConnected(state)`，只在确实由它连上且已 `active` 时回调；主进程据此发 `accelerationAutoStarted` 系统通知（沿用 `acceleration` 偏好键，同一次连接去重）。托盘显示「已自动连接」，加速页在连接说明处写明关掉桌面端不会断开。
- 关掉桌面端仍不自动断开（沿用 #322 的决定）。未新增 IPC 通道。
- 全面检测 Q20。`main.ts` 原来在建窗口前单独 `await readBundledAccelerationConfig`（整读三十多兆内核算 SHA-256）。改为拿到 `managerDataDirectory` 后立即发起读取、先把失败接成结果对象（避免等待期间被当成未处理的拒绝），原位置再等结果。校验内容与失败处理不变；内核启动前 `acceleration-mihomo-runtime.ts` 对拷贝出来的内核仍会再校验一次。
- 全面检测 Q6、Q22。`acceleration-development-host.ts`：`recover()` 只在 `proxy-lease.json` 或它旁边的 `.lock` 在时才拉辅助进程（原来目录在就拉，而目录第一次读状态就会建出来）；新增 `idleExitMs` 选项（`main.ts` 给 2 分钟），期间没有新请求就问辅助进程 `idle`，它在队列里按「没有会话、没有下载线路、内核没跑、网络设置已还原」回答，是才断开 IPC 让它自己收尾退出，下次用到时等旧的真正退出（最多 10 秒）再拉新的，避免 macOS 上两个抢同一把锁。`acceleration-development-worker.ts` 的退出重试改用 `accelerationShutdownRetryDelayMs`：1 秒起翻倍，封顶 5 分钟。
- 第十一批候选 11（协调者拍板按「不加推送通道」做）。`features/acceleration/controller.ts` 的 `schedulePoll` 只在 `active` / `connecting` / `stopping` 时排下一次 15 秒读；空闲、不可用、首次读失败都不再定时重试。
- 读状态的时机：`setScope`（登录或切换账号）、`useAcceleration` 已有的窗口 `focus` / `visibilitychange`、用户点开关（`start` / `stop` 的返回值）、以及 `App.tsx` 新加的「切到加速页时读一次」。托盘仍只吃主进程 `onState`（`tray-acceleration.ts`），不受影响。
- 不新增 IPC 通道：「加速意外断开」线程（#352）只推到托盘与系统通知，没有推到界面，而为了窗口在后台时早几秒显示状态去加一个串行才能合的通道不值。
- 用假计时器数空闲一小时里的 `acceleration:get-state` 调用：改前 241 次，改后 1 次（每次都是渲染层 → 主进程 → 加速辅助进程 `inspect()` 的一趟往返，外加一条结构化 IPC 日志）。
- 第十批候选 1。主进程接 `powerMonitor` 的 `suspend` / `resume`（新模块 `electron/acceleration-power.ts`），经 host 的 `suspend()` / `resume()` 转给辅助进程；辅助进程没在跑时什么都不做。
- backend 会话新增 `pausedMono` / `pausedMs`：睡前冻结计时并撤掉到期定时器（同步处理，不排在辅助进程的队列后面）；醒来把「睡前到醒来」按单调钟量出的差扣掉——Windows 单调钟跨睡眠照走、macOS 停表，这个差在两边都恰好是要扣的那段，不用分平台。之后走一次 `inspect`：内核还在就按剩余时长重新 `arm`，不在了走候选 2 的「先还原网络再报告」。
- 兜底：任何一次读状态都会叫醒还挂着睡眠的会话，系统没送来醒来事件也不会变成不限时加速。醒来后主进程再读一次状态，托盘与到期提醒按醒来后的剩余时长重新对齐。
- 崩溃结算（账本 `startedAt`）不变：睡眠中软件被强杀，下次启动仍按墙钟保守结算。
- 全面检测 Q36。`account-read-error.ts` 导出 `accountReadReloginMessage` 与 `accountReadErrorAction(message)`，`App.tsx` 的账号读取失败弹窗按它给「重新登录」（打开登录）或「重试」（重跑 `reloadAccount`）。
- 新增 `electron/account-source-switch.ts`（纯编排，依赖全注入）与通道 `config:switch-account-source`：`backups.ts` 的 `pre-save` 备份 → 写入 → `runConnectionCheck` → `unconfigured/config/credential/group/model/protocol` 失败时恢复备份、放回挪开的凭据、还原 `officialProviders`；网络、额度、未知只提示不回滚。`judgeSwitchCheck` 另把 502/504/520-526、不带分组字样的 503、返回网页、带 Cloudflare 特征的回复判为服务不可用，同样不回滚；额度层沿用 `connection-check.ts` 的说法。
- Claude Code 2.1.277 会把 `~/.claude.json` 的 `primaryApiKey` 以 `x-api-key` 与 `ANTHROPIC_AUTH_TOKEN` 同时发出，new-api rc.24 在 `/v1/messages` 上用 `x-api-key` 覆盖 `Authorization`（`middleware/auth.go` 370–375 行）。`saveConfig` 写 Claude 后把它挪进 `~/.claude/xingmang-claude-console-key.json`，`switchToOfficialAccount` 放回（`config-files.ts` 的 `moveClaudeConsoleKeyAside` / `restoreClaudeConsoleKey`，走 `executeFilePlans`）。
- Codex：当前账号那份 `config.toml` 把 `cli_auth_credentials_store` 的 `keyring`/`auto` 固定成 `file`（凭据库优先于 auth.json）；`readCodexAuthMode` 对没写 `auth_mode` 的混合 auth.json 改判 `apikey`，与 Codex 0.155.1 `resolved_mode()` 一致；渲染层 `sourceFor` 把「ChatGPT 令牌 + config.toml 仍指向当前账号服务」判为 `changed`，原先判 `official`。
- 新增 `inspectOfficialLogin`，只看文件与字段是否存在，不读令牌；Codex 用系统凭据库时返回 null（看不出来）。
- 一键切回官方只给 Claude Code 与 Codex：Gemini 个人账号已不能登录，Grok 暂未做官方来源。
- 调研结论（13 种切换报错情形、报错原文与源码出处）见项目文件「官方账号与中转账号切换-报错情形-2026-09-22.md」。
- 全面检测 Q35。`App.tsx` 的 `switchToolAccount` 登记成 `toolbox.run('switch:<工具>')` 任务，`Home.tsx` 工具行认这个任务显示「切换中」并收起菜单。主进程 `config:switch-account-source` 按工具单飞：同方向重复调用共用正在跑的那一次，反方向直接拒绝（「这个工具正在切换账号，等这次切完再试」）。未新增 IPC 通道。
- `account-source-switch.ts` 的 `judgeSwitchCheck` 去掉自己按状态码、网页、Cloudflare 特征猜维护的那一套，改认 #387 的统一分类：自检 `service` 层不回滚。签发 Key 或查模型时遇到 `NewApiNetworkError('serviceUnavailable')` / `RealmAccountError('UNAVAILABLE')`，`configureManagedClis` 的失败项带上 `serviceUnavailable`，一键切换据此抛 `AccountSourceServiceUnavailableError`，不恢复备份（配置还没写）。`system-service.ts` 查模型时的维护错误改抛 `NewApiNetworkError`，文案不变。
- 可能没想到的问题第 8 条（判定部分，yoyo 2026-09-23 同意「看不出时按普通用户处理」，取窄档）：`resolveWindowsCliExecutionModeDetailed` 在令牌提升类型探测失败时，按 whoami 完整性标签有没有读出来分流：读出 High 及以上仍回退 trusted-only；标签也读不出（含 whoami 失败、超时）时改为 same-user，`probeFailure` 照带。残余风险：以管理员身份打开、且 whoami 与 PowerShell 探测都失败的机器会在高权限进程里按 same-user 解析；检查页读实时令牌，这种情况仍提示普通启动。`cli.execution-mode.probe-failed` 日志文案与 `mode` 字段、检查页 `ADMINISTRATOR`（trusted-only + 失败给 warn 与「直接双击重新打开」，same-user + 失败给 pass 并在 details 留原因）、反馈报告「运行权限」一行都按实际模式说；trusted-only 不再有「或无法确认」这一说。
- Q23（全面检测 9-23）：`chat/state.ts` 的 `planTurn` 在发出前查单条长度，超过 `AI_CHAT_LIMITS.messageLength` 直接给中文提示，不再落到 `ai-chat-protocol.ts` 的英文 `message is too long`。
- Q24：`ai-chat-service.ts` 的 `completeOnce` 在准备 Key 之前就接上停止信号和总超时，发请求前再查一次；总超时单独报 `total-timeout` 文案；只认 `[DONE]` 或 `finish_reason` 为完整，否则按 `stream-closed` 失败。`canvas-node-executors.ts` 剧本解析只在解析失败时重发，请求失败不重发。canvas-v2 未改。
- Q26：`credentialFailure` 认得出网络原因就用 `networkFailureMessages` 那句、错误码 `network-error`；渲染层 `chatErrorMessage` 对 `network-error` 认出这句时原样上屏。
- Q4（全面检测 9-23）：`ai-image-service.ts` / `ai-video-service.ts` 的取消判断在凭据解析前 `operation.userId` 还是 `undefined`，画布带 userId 取消一律被拒。操作记下调用方的 `expectedUserId`，取消按「已解析的账号，否则提交时的账号」比对。
- Q5：`chat/state.ts` 的 `chatErrorMessage` 对带「重复提交」的主进程原话原样放行（排在超时/网络正则之前）；`ai-image-service.ts` 拿到生成结果后清掉总超时，下载由资产库自己的超时兜底；「重试下载」「output 目录」两句改成用户能照做的话。
- 新增 `electron/ai-output-location.ts`：`resolveAiOutputRoot` 安装版改为 `<文档>/XingmangAI`（复用 `resolveStarterWorkspaceParent` 的云同步判断，开发环境仍是项目根 `output`），`resolveLegacyAiOutputRoot` 给出老位置 `<可执行文件目录>/output`。
- `migrateLegacyAiOutput` 在启动时后台按账号数据域各跑一次：只搬 `user-<id>` 真目录，同盘整目录 rename，跨盘或 rename 失败逐文件搬（跨盘先复制到 `.moving-*.tmp` 再改名，复制完才删源）；不覆盖已有文件、不跟随链接、只搬单链接普通文件（I8）。引用只存作品编号，布局不变无需迁移任何引用。结果以计数记 `asset.output.migrated`，不记路径。
- 三个 store 写失败的文案去掉「output 目录」「安装目录写入权限」。
- 盲点 2 前半（可能没想到的问题-2026-09-22 第 2 条）：`AiAssetStore.assertWritable(userId?)` 在 `user-<id>` 目录（无 userId 时为 output 根）经 `ensureSafeDataDirectory` 后以 `wx`/0o600 真写一个随机名探针再删，失败抛带 `code: AI_OUTPUT_UNWRITABLE` 的中文错误，OS 原因留在 `cause`。下一步文案由宿主通过 `unwritableGuidance` 给：全局 output 指向画布项目，项目文件夹指向换文件夹。
- 聊天生图（`imageService` 直接用 `AiAssetStore`）、画布生图与画布视频（`CanvasProjectAssetManager.assertWritable`）在发请求前调用；`prepareProject` 语义不变，视频续查已付费任务不试写。
- 启动时由试写替换原先只建目录的 `ensureOutputDirectory`，失败仍记 `asset.output-directory.unavailable` 并带上 OS 原因；诊断新增可选依赖 `probeAiOutput` 与检查项 `AI_OUTPUT`（写不进标 warn，不进开机提示）。渲染层 `chatErrorMessage` 原样透出这句提示。默认保存位置不变，搬家另走第二个 PR。
- 第十一批候选 4、5（`src/renderer-v2/features/auth/AuthFlow.tsx`）。「账号来源」Segment 默认收起，只有 `initialSiteId` 不是星芒站或用户点了 `auth-source-expand` 才出现；点它会同时选中历史账号。默认站点、只发选中那一站、注册只在星芒站都没变。同意勾选框与「记住密码」默认不勾保持原样（协调者拍板）。
- 用户名由 `state.ts` 的 `usernameFromEmail` 从邮箱派生：按码点截到 20 位（new-api `Username validate:"max=20"`，无字符集限制）；用户亲手改过就不再跟随，清空后重新跟随。`validateRegistration` 的长度校验同步改为按码点计数，与服务端一致。
- 注册撞名（`isUsernameTakenError`，与错误表共用一条正则）不再只出一条通用错误，而是把错误挂到用户名那一格并聚焦。
- `account-errors.ts` 补一条邮箱域名白名单 / 别名限制的中文文案：new-api 默认不开这项，RECON 也没记，确切措辞未核实，只在「邮箱」旁出现「白名单 / 别名」时命中，避免误吞别处的白名单报错。
- 邀请码折叠为 `register-invite-toggle`；带邀请码打开时直接展开。确认密码保留。
- 测试：`state.test.ts`、`account-errors.test.ts` 补单测；`browser-check.mjs` 新增四条浏览器用例，原有切来源的用例改走 `chooseAccountSource` 帮手（`e2e/realm-account-smoke.mjs` 同步）。
- issue #28 客户端部分：`service-status.json` 新增 `badVersions`（撤回名单）与 `rollout`（分批放量）。`electron/updater.ts` 每次检查前重读状态文件，经 electron-updater 的 `isUserWithinRollout` 钩子拦下撤回版本、按放量比例只放一部分自动检查（手动检查不拦），只有本机版本被撤回时才开 `allowDowngrade`；已找到或下载好的版本被撤回会收回提议。快照新增 `currentVersionWithdrawn` / `rollback`，更新页与首页气泡改说「建议退回」。
- `publish-release` 覆盖清单前把线上那份按版本号备份到 `manifests/<版本>/`，新清单也存一份；新增 `rollback-release` 工作流（核对备份与安装包 → 撤回线上版本 → 换回备份清单 → 复核更新源）。`service-status` 工作流加撤回名单与放量两个输入。步骤见 `docs/SERVICE-STATUS.md`。
- 新增零依赖模块 `electron/relay-quota-failure.ts`：`classifyRelayQuotaFailure(status, detail)` 只认服务端写死的句子和错误码，分 `balance` / `keyLimit` / `keyInvalid` 三类，句子逐行对过 new-api v1.0.0-rc.24 与 Sub2API 源码（注释里写了出处）。刻意不认光秃秃的 `insufficient_quota`：上游渠道欠费时中转也会原样转回这个词。5xx、HTML、挑战页不在这里处理。
- new-api 的一个事实：Key 额度用到 0 后，鉴权中间件回的是 401「无效的令牌」，和 Key 被删、过期一字不差；只有剩余额度不够这一次预扣时才是 403 `pre_consume_token_quota_failed`。所以 401 一律归 `keyInvalid`，教程里也照实写「这两种情况报的是同一句」。
- `ai-chat-service.ts` 原来把错误返回体直接丢弃，现在有界读取（沿用 16 KB 上限，超限或不是 JSON 就退回旧文案）后只用来分类，原文不上屏也不进日志；429 的兜底文案去掉了「或账户额度不足」。`ai-image-service.ts` / `ai-video-service.ts` 的 401/403 额度分支改走同一个分类，显示用的 `detail` 仍只取 message，错误码只参与匹配。
- 渲染层：`features/chat/state.ts` 的 `chatErrorMessage` 对这三句原样放行（否则宽泛的「余额」正则会把「额度上限」改回「请充值」），新增 `chatErrorAction`；`ChatPage` 新增可选 `onOpenAccount`，由 `App.tsx` 按 `visibleAccountTab` 跳到充值或密钥页。模块加进了 `scripts/verify-renderer-boundary.test.cjs` 的渲染层可导入名单。
- 教程原文来自沙箱实测：四家推荐版本（Claude Code 2.1.277、Codex 0.155.1、Gemini CLI 0.60.0、Grok 1.0.40）按 `config-files.ts` 的写法配置，指向只监听本机回环的假接口，返回体按 rc.24 源码构造。
- Q43（全面检测 9-23）：`ai-chat-service.ts` 的 `idleTimeoutMs` 45s→180s、`totalTimeoutMs` 5min→30min，仍然有限（I10）。空闲计时一直按收到的字节重置，思考增量和 SSE 注释保活（`: PING`）都算动静，新测试钉住。
- 超时提示按截断前已经收到什么分三种（什么都没有 / 只有思考 / 有正文），由主进程给出；`renderer-v2/features/chat/state.ts` 对 `idle-timeout` / `total-timeout` 改为照搬主进程原话，内容保留不变。
- `completeOnce`（画布剧本解析）以前只有总时长，总时长放宽后会挂住半小时：补上与流式聊天相同的等响应头与空闲时限，超时照旧不交回半截结果（不回退 Q24）；用户停止时同时取消读取。流式路径读错误响应体也改由空闲时限兜底。
- 新增 `features/app/diagnostic-details.ts`：`diagnosticDetailRows` 只把白名单里的 details 键译成中文上屏，布尔值译成是/否，null、未知键、含网址的值、`reason` 的英文代号一律不显示；`endpoint` / `baseUrl` / `status` / `executionMode` / `probeFailure` / `required` 刻意不列。导出报告不受影响。
- `diagnosticTarget` 改为返回 `V2Page | null`，去掉兜底的 `'maintenance'`；`diagnosticHasFix` 改为「有落点才有按钮」。`PROVIDER_ENVIRONMENT_OVERRIDE` 不再给按钮（设置页没有对应开关）。
- 新增 `features/app/settings-group-intent.ts`：跳设置页前 `requestSettingsGroup('network')`，设置页挂载后在 effect 里 `takeSettingsGroup()`（不放 useState 初始化函数，严格模式会跑两遍）。
- 检查页连接自检结果条不再渲染 `view.endpoint`；`view.detail` 放进默认收起的 `<details>`。
- `inspectWindowsElevationCapability` 改用 `System32\whoami.exe /groups /fo csv /nh` 判断账号在不在 BUILTIN\Administrators（S-1-5-32-544）：原 PowerShell 探测读的 `WindowsIdentity.Groups` 会跳过 deny-only 的组（.NET Framework 与 .NET 源码都是 `SE_GROUP_ENABLED|LOGON_ID|USE_FOR_DENY_ONLY` 掩码只收启用的组），UAC 过滤后的管理员因此被判成 standard。输出里没有恰好一个强制完整性标签时答 unknown，不猜。
- 诊断的「是否以管理员运行」默认探测先读完整性标签（`inspectCurrentWindowsProcessHighIntegrity`，High 及以上算是），读不出才退回原 PowerShell `IsInRole`；两次 whoami 各限 3 秒。检查项新增可选的 `timeoutOutcome`，「运行权限」超时给 warn 提醒而不是 error。启动时的执行模式判定（从严）没动。
- 诊断的 node / npm / git 版本探测与 CLI 版本探测在同步的 `isTrustedHighIntegrityExecutable` 之前先 `await primeTrustedHighIntegrityExecutable`，Program Files 下的 ACL 探测不再在主线程同步起 PowerShell。
- 「文件夹位置」一项的 summary 与 `toN` 只写盘符（`describeRelocationTarget`：`D 盘` / 共享文件夹 / macOS 外接磁盘名 / 别的位置），不再写 realpath 出来的整条路径——它带用户名，而脱敏只认原用户目录。
- `electron/config-files.ts`：Claude 星芒来源的 `permissions.deny` 在 `Artifact` 之外再加 `DesignSync`，切回官方账号时两项一起撤掉。2.1.277 在第三方 base URL 上每次请求都把 DesignSync 发给模型，而它要 claude.ai 登录才能用；沙箱实测 deny 后工具从 21 个变 20 个。对应「接中转后的官方体验差距」C7。
- 全面检测 Q7（协调者拍板：挪进快照、切回官方放回）。`config-files.ts` 新增 `moveClaudeForeignSettingsAside` / `restoreClaudeForeignSettings` 两个纯函数和快照文件 `~/.claude/xingmang-claude-foreign-settings.json`：接当前账号（merge 与 reset）时把 `env` 里的 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 与顶层 `apiKeyHelper` 挪进快照，切回官方（merge 与 reset）时只放回当前没有同名项的，然后清空快照。快照与 settings.json 在同一次两阶段提交里写。
- 值等于这次写入的 Key 的 `ANTHROPIC_API_KEY` 只删不存；本软件自己写的 `ANTHROPIC_DEFAULT_MODEL`（#404 选模型菜单）不在表里。
- Q14：官方安装器的 `~/.local/bin/claude` 在 macOS/Linux 上是指向 `~/.local/share/claude/versions/<版本>` 的符号链接，旧的 `uninstallNativeClaude`
  按单链接普通文件校验，报「不是单链接普通文件，已停止卸载」。新增 `electron/claude-native-uninstall.ts`：参照 Grok 在 macOS 上的做法建立符号链接卸载计划
  （链接身份与所有者钉住，realpath 必须正好落在当前用户的 `~/.local/share/claude/versions/` 下且是单链接普通文件，根目录 `~/.local` 身份钉住），指向别处一律拒绝。
- 命令入口移除后，逐个用 `uninstallVerifiedNativeCliFiles` 的普通文件路径删除 `versions/` 下名字是版本号的单链接普通文件（Windows 同样适用），再 `rmdir`
  空掉的 `versions/` 与 `~/.local/share/claude/`；不做按路径递归删除，`~/.claude`、`~/.claude.json` 完全不碰。删不掉的版本文件（被占用、硬链接、属主不符）
  以 `manual-required` 返回并附带可复制的清理命令。
- `native-cli-uninstall.ts` 新增可选 `allowAbsoluteSymbolicLinkTargets`（缺省 = 旧行为，只收相对目标），Grok 计划不受影响。macOS 上改名后的
  `.claude-<uuid>.removing` 链接仍按该模块既有约定保留，不按路径删除。
- 新增 `electron/claude-model-picker.ts`：保存 Claude 配置时，按当前 Key 的可用模型生成 `modelPicker`（`replaceBuiltInOptions: true`，只取 `claude-` 开头的型号，最多 20 个且必含当前型号，标签如 Opus 5 / Sonnet 4.6，说明是完整 id），并写 `env.ANTHROPIC_DEFAULT_MODEL` 让菜单里的 Default 指向选定型号。用户自己写的菜单不动；一个 Claude 型号都没有时保留官方菜单；切回官方账号时收回。`saveProviderConfig` 多一个可选参数 `availableModels`，由 `system-service.ts` 的 `saveConfig` 传入已拉到的模型清单。沙箱实测 2.1.277 菜单与请求型号都对。对应「接中转后的官方体验差距」C2。
- `electron/config-files.ts`：星芒来源的 Claude `settings.json` 写 `skipWebFetchPreflight: true`（reset 与 merge 都写），切回官方账号时删掉。Claude Code 的 WebFetch 每抓一个域名前先问 `api.anthropic.com/api/web/domain_info`，国内不可达时被拒立即报错、被丢包则等 30 秒后报错；沙箱实测 2.1.277 加上这个键后官方主机不可达也能 1.2 秒抓到。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 管不到这一步。依据见 `docs/CLI-VERIFIED-VERSIONS.md` 的改动表。
- 新增 `electron/codex-plugin-catalog.ts`：Codex 的官方插件目录由它自己在启动时从 github.com/openai/plugins 同步到 `$CODEX_HOME/.tmp/plugins` + `plugins.sha`（git → GitHub API → chatgpt.com，每条 30 秒），国内常全失败，`codex plugin list` 与 `/plugins` 一直为空。现在快照缺失时由本软件从 codeload.github.com 下载 tar.gz（走 `downloadFetch` 与下载加速，5 分钟超时、压缩 150 MB / 解压 600 MB 上限、只跟同主机跳转），自写的 tar 解析只还原普通文件与目录、路径按敌意输入校验，解到 `.tmp` 下随机目录后一次改名到位；已有完整快照时从不覆盖。沙箱实测 0.155.1 与 0.156.1 用 Key 登录都能列出 `openai-api-curated` 的 49 个插件并装上，装好的插件技能会随请求发给中转。
- `ProviderExtensionService.list('codex')` 带上 `marketplace` 状态，`ensureMarketplace('codex')` 改为下载这份目录（同时发起只下一次，复用已有 IPC 通道）；官方目录里的插件用各自 plugin.json 的显示名与说明补全。
- 插件页 Codex 的「市场」页签改为与 Claude 相同的可装插件列表，目录缺失时进页自动下载一次；自己添加的市场挪到列表下方单独一块。`bounded-response.ts` 新增 `readBoundedResponseBytes`。
- `electron/config-files.ts`：Codex 星芒模板写 `[analytics] enabled = false`，merge 只在用户没写过时补；切回 ChatGPT 且没有官方快照时，只有整张表恰好是 `enabled = false` 才收回。沙箱实测 0.155.1：官方主机不可达时 `codex exec` 退出前等 `ab.chatgpt.com` 指标上报约 10 秒，关掉后 0.24 秒；这个开关对 app-server（桌面端）同样生效。对应「接中转后的官方体验差距」X1。
- 全面检测 Q17、Q41。`config-files.ts`：`requireToml` 与 Codex 中转写入那处不再拼 @iarna/toml 的原文（自带前后几行源码），改为 `tomlErrorLocation` 只报行号；`readText` / `requireConfigText` 读出后去掉开头的 UTF-8 BOM，JSON 与 TOML 两条路一起受益，写回时不再带 BOM。
- 全面检测 Q18。`config:save` 在 `mode: 'reset'` 时先 `backupStore.create(provider, 'pre-save', undefined, context)`（与一键切换同一套账号上下文），失败则抛「没能先备份当前配置，这次没有重置：原因」且不调 `saveConfig`；`merge` 路径不变，入参校验仍同步抛错。
- 配置对话框的确认文案补了一句「在「备份」页能找回」。
- `diagnostics.ts` 的 `ENVIRONMENT_OVERRIDE_VARIABLES` 每项加 `breaksAccount`，命中且不指向当前站点时 `PROVIDER_ENVIRONMENT_OVERRIDE` 报 `fail`。取值是在沙箱对 Claude Code 2.1.277、Codex 0.155.1、Gemini CLI 0.60.0 按 `config-files.ts` 模板写配置、指本地假接口逐个变量实测的：Claude 的 settings.json env 压过进程环境（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 盖不过），但 `ANTHROPIC_API_KEY` 多带的 `x-api-key` 在 new-api 的 /v1/messages 上顶掉 Authorization；Codex 自定义 provider 不认 `OPENAI_BASE_URL` / `OPENAI_API_KEY`，`.codex/.env` 里写这两个也不生效，`CODEX_HOME` 本程序同样认；Gemini 的 `~/.gemini/.env` 不覆盖进程环境。
- 第十一批候选 10。`electron/external-client-runtime.ts` 的 `scan()` 加 5 分钟结果缓存（`scanCacheTtlMs` / `now` 可注入）：`scan({ force: true })` 跳过缓存但仍与在飞那次合并；`install` / `launch` 结束（成败都算）由运行时自己作废缓存，在飞那次的结果照样交给等它的人但不落进缓存（generation 计数）；任何一个客户端带 `detectionError` 的结果不缓存，免得一次 PowerShell 超时让界面连着几分钟报错。
- 签名校验按「路径 + 大小 + 修改时间 + 创建时间」缓存：清点脚本把上次的结论以 base64 JSON 传回去（路径和签名主体不会变成 PowerShell 源码），戳没变就不再调 `Get-AuthenticodeSignature`。**只给展示用的 `scan` 用**；`install` / `launch` 的盘点一律重新验签，因为同一用户能伪造这几个时间戳，真正要执行文件前不能信缓存。
- `external-clients:scan` 多收一个可选的 `force` 布尔参数（缺省 = 旧行为，不新增通道）。首页「重新检测」和工具行上的「重新检测」传 `true`；检查页「测试连接」先强制盘点一次，再逐个自检。`useToolbox` 首屏把外部客户端盘点排到 `refresh()` 落地之后。
- 沙箱是 Linux，这条 PowerShell 在 Linux 上根本不跑，量不到耗时；用假命令执行器按「开机 → 检查页测试连接 → 保存配置 → 回首页几次 → 点一次重新检测 → 打开客户端 → 过 5 分钟」数盘点次数：改前 11 次 PowerShell、11 次验签，改后 6 次 PowerShell、2 次验签。
- `electron/config-files.ts`：星芒来源的 Gemini `settings.json` 写 `modelConfigs.customOverrides`，把 0.60.0 后台功能写死的 Google 官方型号名（`gemini-3-flash-preview`、`gemini-3.1-pro-preview-customtools`、`gemini-3.1-flash-lite` 等 12 个，含 `flash` / `pro` 等别名）统一改写成当前配的中转型号，当前型号本身不写。merge 只替换本软件写的那种改写（`match` 只有 `model`、`modelConfig` 只有 `model`），用户自己的改写保留；切回 Google 账号时删掉。对应「接中转后的官方体验差距」G1，沙箱实测见 `docs/CLI-VERIFIED-VERSIONS.md`。
- `electron/config-files.ts`：Gemini 星芒来源写 `privacy.usageStatisticsEnabled: false`（merge 只在用户没写过时补，切回 Google 账号时整张 `privacy` 恰好就是这一项才收回）。沙箱实测 0.60.0：开着时每次运行连一次 `play.googleapis.com`，且发给中转的每个请求都带 `x-gemini-api-privileged-user-id` 安装 ID 头；关掉后两样都没了。对应「接中转后的官方体验差距」G7。
- `config-files.ts`：Gemini 的 `settings.json` 与 `trustedFolders.json` 改按 Gemini CLI 的读法解析（`strip-json-comments` 后 `JSON.parse`：认注释、不认尾逗号），带注释的文件用 `jsonc-parser` 只改变了的值、保留注释；纯 JSON 仍整份重写、行为不变。注释路径上拒绝重复键（原地改会改到一份、Gemini 读另一份）。覆盖接当前账号、切回官方、目录信任、补 AGENTS.md 四处写入与认证方式读取（全面检测 Q16）。
- `config-files.ts`：去掉 `providerSupportsOfficialAccount` / `officialAccountUnsupported`，Grok 切官方走 `removeGrokRelayConfig`：删掉 `base_url` 等于中转的 `[model.*]` 表、指向这些表的 `models.*` 选择、等于中转的 `endpoints.xai_api_base_url`，以及 #402 写进 `models.allowed_models` 的那一项（表删了名单还在 Grok 就没有可选型号）。Grok 的优先级是 `[model.X].api_key` > `auth.json` 会话 > `XAI_API_KEY`，只删 Key 留 base_url 会把 Grok 登录令牌发给中转，所以整张表一起删。切回中转时 `models.default` 空着就补回托管模型。`inspectOfficialLogin` 与汇总里的 `grokLoginMode` 只读 `~/.grok/auth.json` 的 `auth_mode` 与 `email`，令牌不读。`canLaunchManagedProvider` 只收 inspection 一个参数。
- 渲染层：`registry/tools.ts` 的 Grok 来源加 `official`（「Grok 账号」），`sourceFor` 只在 `grokLoginMode` 有值时把没密钥的 Grok 认成官方，`oneClickOfficialProviders` 加 Grok。
- `electron/config-files.ts`：Grok 的 `[models]` 补 `allowed_models = [<默认型号名>]`、`session_summary`、`image_description` 指向同一项（merge 只在用户没写过时补）。1.0.40 内置的 grok-4.6 / grok-4.5 走 `cli-chat-proxy.grok.com`，选了就一直重试；标题默认钉字面量 `grok-4.6`，中转型号不同名时静默失败。沙箱实测名单生效、各类附带请求都走中转型号；`hidden_models` / `disabled_models` 会误伤中转那一项，刻意不用。对应「接中转后的官方体验差距」K3、K4。
- `electron/config-files.ts`：Grok 的 reset 模板与 merge 都写 `[endpoints] xai_api_base_url = <中转>/v1`。Grok 1.0.40 的 `image_gen` / `image_edit` / `image_to_video` / `reference_to_video` 不走 `[model."grok"].base_url`，而是带着同一把 `api_key` 去请求这个地址（默认 `https://api.x.ai/v1`），等于把中转 Key 发给 xAI 官方，国内不可达时还要卡 120 秒。沙箱实测改指中转后出图请求打到中转、0.5 秒返回。对应「接中转后的官方体验差距」K1。
- 第十一批候选 1 + 3。`registry/tools.ts` 新增 `guideRecommendedTool = 'codexDesktop'`（Windows 与 Mac 同一个，协调者拍板），`registry/tools.test.ts` 钉住它在两个平台都可见且不依赖运行环境。
- `StartGuide.tsx`：新增纯函数 `defaultGuideRoute`（恢复的进度优先，否则推荐项；推荐项在当前平台不可见时不选，即 Linux）与 `guideCanSkipConnect`（仅 `source === 'account'` 且已准备好、已连上）。选项排序推荐项置顶，卡片名旁加 `Pill`「推荐」（`guide-recommended`）。
- 「准备工具」里安装成功后记下路线，等检测结果跟上、`readiness.prepared` 变真时由 effect 替用户推进到下一步（能跳就直接到「开始使用」）；换路线、离开这一步都会作废这个记号。最后一步在跳过时显示 `guide-connected-note`，里面的「点这里」走 `onConfigure`。
- 测试：`StartGuide.test.tsx` 补默认项与跳过判定；`features/auth/browser-check.mjs` 里依赖「无默认项」「装完手点下一步」「三次下一步到最后一步」的几条按新行为改写；`e2e/onboarding-smoke.mjs` 的首屏断言改成默认选中推荐项（Linux 仍无默认）。
- 全面检测 Q50（与 #68 相关）。`features/tools/model.ts` 新增纯函数 `toolUpdateOffer`，只读首页已有的两份判定（`versionAdvice.recommendedIsNewer` / `rollbackVersion` 与 `updateAvailable`），不引入新的版本来源：名单钉住时只在推荐版本更新时才算旧（装着的比推荐还新时不提），没名单或「总是最新」时跟随更新检查，桌面端只认镜像真有新包；原生/其他方式装的只给首页那句 `externalInstallHint`，不给按钮。`App.tsx` 把它挂到 `GuideToolState.update`，引导的 `onInstall` 多一个可选 `version` 参数，接到现有的 `install(id, version)`。`StartGuide.tsx` 在「准备工具」这一步工具与运行环境都齐时改口、Pill 显示「可更新 / 有已知问题」并给 `guide-update` 按钮；不挡「下一步」，更新完也不自动前进。未新增 IPC 通道。
- 全面检测 Q8。`StartGuide.tsx` 新增 `guideStepErrorMessage(reason, action)`：先脱敏（`userFacingErrorMessage`），主进程写好的受限网络文案原样上屏，其余走 `classifyOperationError` 按目录标题说；`timeout` 不借目录里「连不上星芒服务器」的标题；分不出类的中文原话原样保留，英文原文落兜底。引导不再引用登录用的 `authErrorMessage`。
- 「再试一次」从只服务「安装」改为记住上一次失败的那一步原样重跑。浏览器回归新增 `launchFail` 夹具用例。
- 全面检测 Q46。`App.tsx` 帮助弹窗按钮只做 `navigate('feedback')`，文案却是「复制反馈报告」。没有改成直接复制：反馈页与教程都要求「发送前先预览、确认不含 Key、密码或无关项目资料」，在帮助弹窗里一键复制会绕过这一步。只改文案为「去反馈页」，行为不变。
- 全面检测 Q13。`system-service.ts` 新增纯函数 `describeNpmCommandFailure`：`CommandRunnerError` 的 `stderr` 里取 npm 的 `code` 行和第一条说明（没有 code 行时取最后两行），过滤 `npm warn` 与日志文件路径那行，再过 `redactCommandText`；`TIMED_OUT` 在安装场景下说成「下载超时」。
- 官方源解析那一步挪进 try，失败时同样拼成「X 安装失败：npm 官方源：原因」，取消照旧原样抛出。
- 渲染层分类规则没改，`operation-error.test.ts` 补了一条按主进程真实句式钉住的用例。
- 新增 `scripts/bundle-release-notes.cjs`，接在 `compile:runtime` 最后一步：把 `release-notes.md` 顶节（第一行必须等于 `package.json` 版本号，否则写 `notes: null`）逐条写进 `dist-electron/release-notes.json`，随 `files` 进 app.asar，不改 `electron-builder.config.cjs`。`scripts/verify-packaged-hardening.cjs` 新增 `inspectPackagedReleaseNotes`，出包时核对这份文件存在、版本与包内 `package.json` 一致、格式有效。
- 新增 `electron/installed-release.ts`：`last-run-version.json`（safe-local-data 原子写，读坏降级为没有记录）记住上次运行的版本；版本升高才算「刚更新」，降级不算；没有记录时以运行日志或 settings.json 是否存在区分老用户与新装（第一个带这项功能的版本也能提示）。结果经 `UpdaterRuntime.installedRelease` 进 `UpdateSnapshot.installedRelease`（可选字段，缺省 = 旧行为）。
- renderer-v2：`startup-notice.ts` 新增 `updatedNotice()` 与 `releaseNoteHeadline()`（启动提示 id `updated`，不记错误日志；列前三项改动的开头半句；`StartupNoticeAction` 新增 `dismiss` 一种，按钮即「知道了」，此时不再显示关闭叉）；`features/app/release-notes.ts` 的 `releaseNotesSection()` 决定更新页右侧卡片说待下载版本还是当前版本。`docs/RELEASING.md` 补一行「先改好标题再编译」。
- `account:revoke-key`：撤销前按 id 认出这是不是托管 CLI 缓存里某个工具的 Key，是且设了上限或到期时间就先读一次它的设置（`findAccountKeyById`，读不到就不撤），把剩余额度、是否不限额、到期时间写进 `managed-key-replacements.json`（`managed-key-replacement-store.ts`，只记限制不记密钥，与托管 Key 缓存分开），写不进也不撤。`account:configure-managed-clis` / `account:sync-managed-cli-keys` 改走一层包装，给这个工具签下一把 Key 时带上 `inheritedKeySettings` 算出的设置和 `fresh: true`，签成功再删记录。上限已用完的签一把最小额度的 Key（new-api 1、Sub2API 0.01），好让「按工具分账」有 Key 可调，同时报「额度用完了」。记录文件读坏时自动签发一律停下；只有用户亲手点「重新写入 Key」（`intent: 'explicit'`）才清掉坏文件照常签。分组不另抄：工具在用的 Key 分组必然等于签发时解析出的分组。
- `NewApiProvisionCliKeyInput.fresh`：两个后端都不复用已有 Key、按给定设置新建；新建的是封顶 Key 时不触发「同名封顶已用完就拒绝」那条检查（封顶 Key 不会绕过上限）。new-api 的 `findCliKeyIdByName` 改取同名里 id 最大的一条。
- `chat-credential-coordinator.ts`：模型查询失败带 Key 额度字样，或 401 且按缓存 Key id 在密钥列表里查到封顶且用完时，抛 `ChatKeyQuotaExhaustedError`，不删缓存、不再签新 Key。`ai-chat-service.ts` 新增错误码 `key-quota-exhausted`，话术用 `relayQuotaFailureMessages.keyLimit`，聊天页已有的 `chatErrorAction` 认得它，给「去调额度」。
- 模型白名单与 IP 白名单只能在网页上设，这次不照抄。
- `account-key-quota.ts` 新增 `isKeyQuotaExhaustedMessage`（只认「令牌额度 / token quota」这一级，账号余额不足不算）与 `managedKeyQuotaExhaustedMessage`；`pickManagedKey` 先认主进程标了 `managedProvider` 的那把，再按名字与分组；`loadManagedCliKeys` 也收下被标记但改了名的那把。
- `connection-check.ts`：401 / 403 / 429 带 Key 额度字样（new-api 的 403「token quota is not enough」、Sub2API 的 429「API key 额度已用完」）时归到 `quota` 层，不再归 `credential`，渲染层因此不出「重新写入 Key」。
- new-api 用到 0 之后回的是和 Key 被删一样的 401「无效的令牌」，文本分不出：`diagnostics:check-connection` 在结论是「密钥被拒绝」、且被拒的正是本软件为这个工具签发并仍写在配置里的那把时，按缓存里的 Key id 去账号密钥列表查一次（最多 5 页），封顶且用完就改说「额度用完了」。查不到、不确定一律保留原结论。
- `account-cli-provisioner.ts`：模型查询因 Key 额度用尽失败时不删缓存、不重签，直接报上面那句话。
- `new-api-client.ts` 的 `provisionCliKey` 与 `sub2api-relay-backend.ts` 的同名方法：同名同组只剩一把封顶且用完的 Key 时拒绝新建（新建默认不限额），新增纯函数 `hasExhaustedCappedCliKey`；同名 Key 还有可用的仍照旧复用。
- 全面检测 Q31。新增 `features/tools/key-sync-failure.ts`：`keySyncFailureReason` 先过 `userFacingErrorMessage` 脱敏，能被 `presentOperationError` 归类的说目录标题，认不出的中文原样、英文落兜底；`keySyncFailureText` 拼成「工具名：原因」。首页 Key 同步结果、首页初始化失败条、切换账号的同步结果三处改用它。
- `features/shell/Shell.tsx`：`<main id="v2-main" tabIndex={-1}>` 作为焦点落点；`activePage` 变化后（首次渲染除外）
  下一帧把焦点交给正文区，开着弹窗、或新页面已经自己把焦点放进正文时不抢；`role="status"` 的隐藏播报区念
  「已切换到某页」。侧栏顶部加「跳到正文」链接（不改 hash，只移焦点），样式在 `styles/shell.css`。
- `features/acceleration/AccelerationView.tsx`：线路 listbox 改 roving tabindex，整张列表只占一个 Tab 位；
  方向键/Home/End 只移焦点不改选择（选择会记进本机，#342），回车/空格才选中；行内选线按钮退出 Tab 序列，
  「Ping」按钮照旧可达。纯函数 `lineOptionTarget` 管按键到行号的映射。
- 新增浏览器用例 `features/shell/keyboard.browser-check.mjs`（进 `test:v2:browser` 与夹具挂载预算门禁），
  加速页 `browser-check.mjs` 补一条方向键用例。「跳到正文」原型里没有，差异记入 `docs/UI-V3.1.1-V2-REBUILD.md`。
- `ipc.ts`：`acceleration:get-state` 的成功日志按 `accelerationStateLogKey`（scope、阶段、模式、授权来源、线路、连上时间、错误、冲突）去重，只在状态变化时记；剩余时长每秒在走，不算变化。失败照常每次都记。
- `runtime-log.ts`：`snapshot(limit, { excludeDebug })` 新增可选过滤，只影响附带条目，总数与分级计数仍按全部日志算；`captureFeedbackReport` 默认排除 debug，「日志条数」一行注明「调试级 N 条未附」。debug 仍然落盘，没有改轮转和日志页列表。
- 全面检测 Q11：`electron/new-api-client.ts` 新增 `endServerSession()`，只在显式退出时尽力发一次
  `POST /api/user/auth/logout`（Bearer + New-Api-User + refresh cookie，3 秒超时、16 KB 应答上限，走
  `performRequest` 的重定向拒绝与来源校验），永不抛错、不改本地会话。端点与语义已按上游 new-api
  v1.0.0-rc.24 `router/api-router.go`、`controller/auth_session.go` 逐行核对。
- `electron/realm-account-service.ts` 的 `logout()` 在本机账号库删掉凭据之后、清内存之前发起它（不等待）；
  切换已保存账号、重新登录、移除账号和丢弃候选句柄仍只走本地 `logout()`，不会把保存的账号在服务端登出。
  业务代理不暴露 `endServerSession`。历史账号（Sub2API）仓内没有登出端点的侦察记录，不接。
- 登录遇到 409 `AUTH_SESSION_LIMIT`（50 个在用会话）、429 `AUTH_SESSION_ISSUANCE_LIMIT`（24 小时 100 次）
  和限流空 429 时，主进程给出专门的中文文案，renderer-v2 `account-errors.ts` 同步认这几句；
  新增测试钉住两边一致。只给文字不给按钮：官网登录会撞上同一个设备数上限，按钮帮不上忙。
- 全面检测 Q33、Q15。`BusinessActions` 新增可选 `installTool` / `cancelToolInstall`，App 传入首页那条 `install`（先备运行环境 → 装工具 → `syncAfterToolInstalled`）和 `toolbox.cancel`；维护页有它们就只走这一条，没有时保留旧的直连路径。App 的 `install` 改为返回 `ToolInstallOutcome`（installed / restart / skipped），维护页据此给结果文案（`installResultMessage`）。
- 维护页的安装因此也登记进 `toolbox.jobs`，`launchWaitLabel`（`features/tools/launch-notice.ts`）据此在「打开」排队时写出前面那一项的名字；主进程队列与 IPC 未改。
- 全面检测 Q19。普通权限（Windows same-user 与 Linux）安装给 npm 传的是空 `--userconfig`，用户 `.npmrc` 里的 `prefix` 跟着被丢掉，新版装进 npm 内置默认目录（Windows 是 `%APPDATA%\npm`），用户自己敲的命令仍是旧版。
- 新增 `electron/npm-user-prefix.ts`：按 npm 的规则找用户配置（`npm_config_userconfig`，否则 `HOME`/`os.homedir()` 下的 `.npmrc`），经 `readBoundedUtf8File` 读取（64 KB 上限、拒绝链接），照 `ini` 的解析只取顶层 `prefix`，做 `${VAR}` 与 `~` 展开；只接受绝对路径（Windows 限盘符或 UNC，拒绝设备路径），且其命令目录必须在 PATH 上，否则保持旧行为。设了 `npm_config_prefix` 时 npm 本来就认它，不另外传。
- `system-service.ts` 在非托管、非提权的安装里把这个值作为 `--prefix` 传入 `buildCliMaintenancePlan`，占用检测也改看这个目录；空 `--userconfig` 保留，源、脚本策略等其余配置依旧不生效。提权（trusted-only）与 macOS 托管目录不读用户配置，行为不变。卸载本来就按检测到的安装目录传 `--prefix`，无需改动。
- npm 行为在 Linux 沙箱（npm 10.9）验证过：空 `--userconfig` 时装进默认前缀，加 `--prefix` 后装进指定目录；Windows 上的表现是按 npm 同一套配置加载顺序推断的，未在真机验证。
- 第十一批候选 2。`features/tools/runtime-readiness.ts` 新增纯函数 `planCliInstall`：按快照和 `platform-capabilities` 的 `nodeRuntimeInstall` / `pythonRuntimeInstall` 算出这次安装前要先代装哪些环境（`prepare`），代装不了时返回拦截原因（`blocked`，沿用 `cliRuntimeBlockMessage`）。版本过低 / 认不出同样归入 `prepare`。
- `App.tsx` 的 `install()` 在同一个 `toolbox.run(id)` 任务里先逐个 `prepareRuntime`（每段另开 `node` / `python` 任务，运行环境卡上的进度照常走），再 `toolsApi.install`；主进程两段本来就各走 `InstallationQueue`（I11），没有新增 IPC 通道。运行环境那段失败时报「Node.js 运行环境没装上，某某还没开始安装。」加主进程原话，错误分类照旧认得出下载超时 / 磁盘满；那段期间按「取消」回一句说明，不再回「没有正在进行的安装」。
- 运行环境那段装完若带回 `systemRestartRequired`（MSI 3010），不接着装工具，直接弹 #351 的「现在重启」框；重启后再点一次「安装」只剩装工具。
- `cliRuntimeBlockMessage` 里认不出版本那句去掉了 PATH / LTS。
- `StartGuide`：`GuideToolState` 新增可选 `runtimeAutoPrepare` / `pythonAutoPrepare`（缺省 = 旧行为）。工具未装且缺的环境都能代装时进入「一颗按钮」模式：Node.js / Python 两行只报状态，「安装」不再等环境就绪；工具已装却缺环境时运行环境行仍保留自己的按钮。安装失败改用 `guideInstallErrorMessage`（不再借登录那套「连接星芒服务器超时 / 输入已保留」），并出一颗 `guide-retry`。
- `useToolbox.ts` 新增 `guideJobProgress`：引导页进度条文案取工具任务那句「第几步」，百分比借运行环境下载的进度。
- 测试：`runtime-readiness.test.ts`、`useToolbox.test.ts`、`StartGuide.test.tsx` 各补用例；`features/auth/browser-check.mjs` 新增 Gemini 一颗按钮 + 失败重试；`testing/app-check.mjs` 的 R-G6 两条按「能代装 / 不能代装」拆开，另加运行环境段失败的用例，`app-fixture.tsx` 补 `installNodeRuntime` 与 `runtimeExternal` 开关。
- 只改文案与显示映射，逻辑不动：`connectionLayerLabels` 与主进程 `connectionCheckLayerLabels` 同步改名（反馈报告里的归因说法随之变化）；`XINGMANG_NETWORK` 的 summary 去掉 `HTTP ${status}`，状态码仍在 details 与导出报告里；反馈页级别 Pill 用 `runtimeLogLevelLabels`，未知级别原样显示。
- 「可能没想到的问题」第 13 条：npm 的 cmd-shim 给每个全局命令同时写 `.cmd` 和 `.ps1`，PowerShell 优先挑 `.ps1`，客户端 Windows 默认执行策略 Restricted 直接拦下。新模块 `electron/windows-cli-shell-access.ts`：装完、更新完以及每次启动后的第一轮检测，删掉四家 CLI 的 npm `.ps1` 启动文件，只留 `.cmd`（只删内容确认是 cmd-shim 为该包写的、旁边有 `.cmd`、单链接普通文件、路径上无联接的那一个）。不改执行策略、不提权；以管理员身份运行时只碰 ProgramData 托管目录。
- 装完/更新完再确认工具目录在当前用户 PATH 里（用户或系统 PATH 已有就不动，进程继承的 PATH 已有时连 PowerShell 都不起）；没有才追加到用户 PATH 末尾。按原始注册表值读写保留 `%VAR%` 写法与 REG_EXPAND_SZ 类型，再广播 WM_SETTINGCHANGE 让新开的终端生效。只由 `main.ts` 经 `ensureWindowsUserPath` 接入，测试缺省不改 PATH。
- 首页「试试第一条命令」与教程的文案改成「新开一个终端」。
- 清理 `.ps1` 与补 PATH 这段逻辑拆成 `createCliTerminalAccess`（`windows-cli-shell-access.ts`），`system-service.ts` 只负责调用；原先在 Windows 上跳过的扫描级用例换成直接测这块的用例，所有平台都跑，不再触发本机 PowerShell 探测。
- 全面检测 Q42：`electron/updater.ts` 去掉签名通道下载完 300 毫秒自动 `quitAndInstall` 的定时器，两个平台都停在 `downloaded` 等用户点安装；设置页「启动时检查新版本」与更新页的说明改成与行为一致。
- 全面检测 Q29。`App.tsx` 的 `accountTab` 改成带序号的 `{ sequence, value }`（同 `tutorialTopic`），经 `BusinessPage` 的 `accountTabRequest` 传给 `AccountPage` 新增的可选 `tabRequest`，同一个分页再点名也会切过去。`app-check.mjs` 加回归用例。
- 放宽 I8 的一角（可能没想到的问题 第 7 条，yoyo 2026-09-23 同意普通权限一档）：新模块 `electron/relocated-folders.ts` 在执行模式确定为 `same-user`（POSIX 另要求非 root）后，跟随位于用户主目录本身、其上级或其内部，且目标为本机盘符目录（Windows）/ 仅本人与 root 可改的目录（POSIX）的联接；`safe-local-data`、`bounded-file`、`config-files` 的 `assertSafeConfigPath` 先把路径换成实际位置，再原样执行严格校验，所以搬家位置之下的第二层联接、指向文件的链接、单链接普通文件要求一律不变。`trusted-only`、网络共享、共享位置（ProgramData、盘根、/tmp）照旧拒绝。检查页「文件夹位置」在全部被跟随时为通过，管理员身份被拒时给出改用双击打开的提示。
- 全面检测 Q21。`main.ts` 的 `render-process-gone` 原来只记日志和上报。新增 `electron/renderer-crash-recovery.ts`：非 `clean-exit` 时自动 `reload()`，60 秒内最多两次，第三次起弹「重新加载 / 先不管」；日志事件 `process.gone.reload` / `process.gone.prompted` / `process.gone.user-reload` / `process.gone.dismissed`。画布窗口不在这次范围内。
- 全面检测 Q39。`cli:launch` 在「每次都提醒」的文件夹那一问被拒（或对话框被关掉）时原来回 `undefined`，记录页 `SessionsPage.resume` 当成成功，照样弹「已打开…，接着…里最近的一条对话」。现在回 `{ declined: true }`：`CliLaunchResult` 新增可选字段 `declined`（缺省 = 打开了，向后兼容，旧界面只需跟着编译，未改动）。
- 渲染层 `features/tools/launch-notice.ts` 新增纯函数 `launchDeclined` / `resumeSessionNotice`，只认明说的 `declined: true`；被拒时不出成功提示，也不刷新首页「最近」。未新增 IPC 通道。
- 全面检测 Q38。`account-key-quota.ts` 的 `findAccountKeyById` 原来只翻前 5 页（500 把），翻不到返回 null，撤销流程把 null 当成「没有上限可照抄」，于是账号里 Key 超过 500 把时，撤销后自动换上的是不限额的 Key。现在一直翻到列表见底（按已看到的条数判断，不再按页码乘页大小，后端把每页压小也不会提前收手），安全阀提到 100 页，到了安全阀仍没见底就抛 `accountKeyListTooLongMessage`，不再返回 null。
- `ipc.ts` 的 `limitedManagedKey`：本机缓存认得这是某个工具在用的 Key、列表里却找不到时，改为抛错不撤（fail closed），原来是按不限额继续撤。聊天 Key 与连接自检两处调用方对抛错和 null 的处理本来一致（都维持原判定），行为不变。
- 全面检测 Q12。`realm-account.ts` 新增错误码 `SAVED_EXPIRED`，`realm-account-service.ts` 的 `switchSavedAccount` 在目标账号恢复不了（返回 false 或抛 `UNAUTHORIZED`）时抛它，不再借 `UNAUTHORIZED`；文案刻意避开「登录已过期」「请重新登录」，不会被渲染层归到当前账号过期那一类。`SavedAccounts.tsx` 认出这句后在那一行给「重新登录这个账号」。业务夹具的 `fail=switch` 改抛同一句，回归用例钉住不出现「登录已过期」标题、按钮能打开登录。
- 全面检测 Q45：`src/renderer-v2/SavedAccounts.tsx` 的副标题原来是保存记录 id（origin + userId 的 sha256）末 6 位，却标成「账户尾号」，也分不出两类账号。改为用摘要里已有的 `origin` 经 `siteIdForOrigin` 映射到登录页的来源名（`accountSources[siteId].label`），认不出的地址只显示「账号来源无法识别」，不回显地址；每行加 `saved-account-row-<id>` testid，`e2e/realm-account-smoke.mjs` 与 `app-check.mjs` 改按它定位。未改 IPC 与切换逻辑。
- 全面检测 Q40。`realm-account.ts` 新增错误码 `ACCOUNT_LIMIT`，`realm-account-vault.ts` 的 `activate` 超出 16 个时抛它而不是 `STORAGE`；`realm-account-service.ts` 的 `restoreMayRecover` 把它算作不可自愈。渲染层 `authErrorMessage` 认出「保存的账号已满」后给同一句中文，排在「安全存储」判断之前。
- `electron/workspace-guard.ts` 新增五类：`users-root`（`C:\Users`、`/Users` 及主目录的上一级）、`onedrive-root`（`~/OneDrive`、`~/OneDrive - 公司名`）、`app-data`（`~/AppData` 及其 `Roaming` / `Local` / `LocalLow`，macOS `~/Library`）、`system`（任一盘根下的 `Windows` / `Program Files*` / `ProgramData`，macOS `/System`、`/Library`、`/Applications`、`/usr` 等）、`provider-config`（主目录下的四家配置目录，名字取自 `catalog.ts` 的 `providerConfigDirectoryNames`）。都只认目录本身，子目录放行；新增 `sensitiveWorkspacePolicy()`，`system` 与 `provider-config` 为 `every-time`，其余沿用 #321 的 `once`。
- `electron/ipc.ts`：`workspace:choose` 的选择器循环抽成 `pickWorkspace`，提示框抽成 `askAboutSensitiveWorkspace`；`every-time` 目录确认后不写进配置。`cli:launch` 对 `every-time` 目录再问一次（最近记录、续接对话、老版本记住的目录都不经过选择器），刚在选择器里确认过的同一路径两分钟内只放行一次；新对话照 #347 给「新建一个项目文件夹 / 换一个文件夹」，续接对话只给「先不打开」（`createIndex` 为 null），取消时不启动也不报错。通道形状没变，`ipc-contract.ts` / `preload.ts` / 渲染层未动；`docs/WORKSPACE-TRUST.md` 的表同步补齐。
- 第十批候选 9（A）。
- 更新目录上新增 `service-status.json`（`electron/service-status.ts`）：启动时后台读一次，之后每 15 分钟、维护期间每 5 分钟读一次，读不到当没在维护；结果挂在 `UpdateSnapshot.serviceMaintenance` 上推给渲染层，角落提示与登录框各一份。发布者用新的 `service-status` 工作流（release 环境审批）一键开关，格式与步骤见 `docs/SERVICE-STATUS.md`。
- `electron/network-failure.ts` 新增 `serviceUnavailable` 一类与 `isServiceUnavailableResponse`：502/503/504、CDN 的 520–526、5xx 却不是 JSON、带 `cf-mitigated` / `server: cloudflare` / 验证页特征的 403 都算；2xx 永远不算（回网页仍按门户拦截，与检查页读状态接口的判法一致）。文案刻意不带「登录 / Key / 网络」等字，免得被渲染层的兜底正则认回别的类别。
- 账号请求（`new-api-client.ts` 三个 unwrap、`sub2api-account-client.ts` 新 `UNAVAILABLE` 码）、连接自检（新层 `service`，不给「去处理」也不给「重新写入 Key」；带分组字样的 JSON 503 仍归分组层；2xx 回网页改归门户拦截）、模型查询（`fetchAvailableModels`）、AI 对话（新错误码 `service-unavailable`，准备分组失败时也认）统一按这一类报。
- 渲染层 `operation-error.ts` 新增 `serviceUnavailable`，「无可用渠道」从 `keyInvalid` 移出（上游渠道被自动禁用时 new-api 报的就是这句，换 Key 无用）；`chat/state.ts`、`account-read-error.ts` 在按字面猜之前先认这一类。
- 「可能没想到的问题」第 3 条的客户端部分之一；启动时非 401 保留登录并退避重试另起一个 PR，维护状态文件等拍板。
- 全面检测 Q47。`pages-maintenance.tsx` 设置页「记住密码 → 管理登录」原来不看登录态，一律 `openLogin`，已登录的人在登录框里再登一次等于换账号。新增纯函数 `features/app/remembered-login.ts` 的 `rememberedLoginAction`：已登录 → 经既有通道 `account:set-remembered-login` 传 `null` 清掉当前账号来源那一份（`siteId` 取会话快照，缺省交主进程按当前来源处理，与登录框写法一致）；未登录 → 仍打开登录框。只写不读，不为显示状态把明文密码拉进渲染层（I3）。未新增 IPC 通道。
- `Shell.tsx`：侧栏导航拆成可滚动的 `.v2-sidebar-scroll`（`flex: 0 1 auto`，空间够时和原来一样紧跟在「更多」下面）加固定在外面的「设置」；展开「更多」后 `scrollIntoView({ block: 'nearest' })`。
- `auth.css`：欢迎页暂停规则加 `!important`（`.auth-orbit-ellipses i:nth-child(2)` 的特异度比原暂停规则高，`auth-orbit-breathe` 停不下来），并覆盖 `::after`。
- `Welcome.tsx`：读根节点 `data-low-end`（#362 由主进程判定、App.tsx 挂上），低配时同样暂停，并隐藏「减少动画」开关。
- 浏览器用例：欢迎页「减少动画」与低配下没有在跑的 CSS 动画（改前的 CSS 上实测会红，剩 1 个）；1280×672 下「设置」可见、展开「更多」后最后一项滚进可视区。
- 可能没想到的问题第 8 条（诊断部分）：`windows-elevation.ts` 新增 `resolveWindowsCliExecutionModeDetailed` 与 `classifyWindowsExecutionProbeFailure`，令牌探测失败时把原因（超时 / 找不到 PowerShell / 被拦截 / 输出看不懂 / 其他）与耗时带出来；**判定不变**，失败仍然从严回退 trusted-only，原 `resolveWindowsCliExecutionMode` 签名与行为不变。归类只读 stderr，execFile 的 `Command failed: <命令行>` 会回显脚本本身（含 Add-Type），不能拿它归类。`main.ts` 的 `cli.execution-mode` 日志加 `elapsedMs` 与 `probeFailed`，失败另记一条 `cli.execution-mode.probe-failed`（warn，带截断到 300 字的上游原文）。检查页 `ADMINISTRATOR` 读启动时那次结果（`DiagnosticsDependencies.windowsExecution`，不重跑探测）。反馈报告「运行权限」一行（#358）接上原因：`FeedbackRuntimeInput.executionProbeFailure`，探测失败写「按管理员处理（没能确认：原因）」，探测成功的 trusted-only 直说「以管理员身份运行」，缺省保持旧的「或无法确认」。
- 可能没想到的问题第 7 条（诊断部分）：`safe-local-data.ts` 新增只读的 `findReparseComponent`（与 `assertNoReparseComponents` 同一套逐级判定，I8 校验一行未改）；`diagnostics.ts` 新增 `FOLDER_RELOCATED`，查用户文件夹、userData、四家 CLI 配置目录，按被重定向的那一级合并；`operation-error.ts` 新增 `folderRelocated`，排在 `permission` 之前。
- `runtime-log.ts`：追加失败不再 `.catch(() => undefined)` 吞掉，记下中文原因与丢失条数，最近 200 条留在内存里并入快照与反馈报告；`RuntimeLogSnapshot.writeFailure` 为可选字段，缺省 = 旧行为。反馈页据此出一条提醒（`runtimeLogWriteNotice`）。
- 全面检测 Q9（#398 引入）。`realm-account-service.ts` 的 `restoreActive` 在已有「登录还在、等重试」标记时改走 `retryStalled`：续期那段网络请求不进 `transition`（不推 revision、不占 busy），只有真要换身份（接上候选句柄、或确认登录失效清掉记录）时才进 `transition`；进去后先核对这期间用户有没有自己登录、切换或退出，有就以那次为准。候选句柄没能接上时，把服务端已换过的新凭据写回本机那条未被改动过的记录，免得下一次重试拿着作废的凭据。开机第一次恢复不变。
- `registry/tutorials.ts` 只改文案，照 #375 已合的入口写。
- 新增 `electron/account-startup-gate.ts`：启动画面那两条读取（`account:get-session`、
  `config:get`）最多等账号恢复 3 秒，`net.isOnline()` 为假时不等。到点还没恢复完，
  会话答 `{ authenticated: false, restoring: { account } }`（`account` 取自新增的
  `RealmAccountService.restoringAccount()`，本机账号库读出来就知道），配置绕开此时会拒绝工作的
  `accountWork` 门、按未登录读出并带 `ownershipPending: true`。其余作用域通道照旧排在恢复之后。
  恢复没成（没保存账号 / 已失效 / 联不上）时账号没变化、不会有人发会话事件，`main.ts` 在
  预算先到的情况下补发一次。不新增 IPC 通道，只给 `AccountSessionState`、`AppConfigSummary`
  各加一个可选字段。
- 渲染层按「正在恢复的那个账号」算作用域（`account-context.ts` 的 `sessionScope`），恢复成功后
  作用域不变：`AppFrame` 不重挂、`useToolbox` 不清快照，只在会话事件里补读一次配置
  （`refreshConfig`）。恢复中进首页而不是欢迎页；点账号 / 聊天只提示稍等，不弹登录框。
  恢复中收到「未登录」事件按「落回未登录」处理，不当成「登录被结束」清掉工作区。启动那次
  读取若晚于会话事件落地，不再用它盖掉更新的会话（`sessionEvents`）。
- 「配置被改过」判定顺序没动（`tool-config-ownership.ts` 与 `sourceFor`）：主进程侧没有账号可比时
  `ToolConfigOwnershipStore.read` 本来就不会给 `changed`；渲染层 `ownershipAwaitingAccount`
  在 `ownershipPending` 期间把 Key 与当前中转对得上的那一支按连接可用显示，地址指向别处的照常报。
  `Home.test.tsx` 与 `app-check.mjs` 的「slow startup restore」用例钉住。
- `system-service.ts` 的 `scanSystem` 经新顶层纯函数 `createScanCoalescer`：非强制请求接上正在跑的
  一轮，或复用 15 秒内刚跑完的一轮；强制重扫一律新跑；那一轮开始之后安装队列动过（新增
  `InstallationQueue.revision`，每项开始、结束各加一）就不复用。`main.ts` 在账号恢复开始时就起一轮
  预热扫描，首屏读取与恢复后 Key 同步的那次安装检查都直接用它。
- 沙箱（Linux，无 CLI、网络请求打桩为离线）实测：一轮扫描约 210 ms；账号恢复耗时 10 秒时，
  启动画面 10.0 s → 3.0 s，工具列表出现 10.2 s → 3.0 s；恢复 0.5 s 时 0.71 s → 0.50 s。
- `resolveWindowsCliExecutionModeDetailed` 先用 `System32\whoami.exe /groups /fo csv /nh` 读当前令牌的强制完整性标签（`inspectCurrentWindowsIntegrityRid` / `parseWindowsMandatoryLabelRid`）：低于 High（S-1-16-12288）的令牌不可能是提升后的完整令牌，直接判 same-user，不再启动 PowerShell 编译 `Add-Type` 探测。High 及以上、标签读不出或 whoami 失败时照旧走原探测，原探测失败照旧从严按 trusted-only。主窗口创建前等的就是这一步，0.2.9 里已经如此（`main.ts` 在建窗口前 await 这个探测，探测上限 15 秒）。
- 新增 `electron/system-snapshot-cache.ts`：每轮扫描成功后把 `SystemSnapshot` 落到
  `userData/system-snapshot.json`（`safe-local-data` 的 `writeAtomicSafeUtf8File`，读用
  `readSafeUtf8File` 带 512 KB 上限，拒绝硬链接 / reparse）。落盘前去掉 `officialChatGpt` 与
  `network.publicIp`，全部字符串过 `redactCommandText` 并截到 4096 字；快照本身不含 Key（配置那一块
  每次现读）。文件带格式版本与软件版本，任一对不上、结构校验不过都当没有。
- `system:scan` 加一个可选参数 `{ acceptCached: true }`（不新增 IPC 通道）：本次启动还没扫完过一轮时，
  主进程先回上次的结果（带 `cachedAt`），同时确保一轮真扫描在跑；强制重扫、其余调用方（Key 同步、
  开机检查、安装前检查）都不受影响。回旧结果时不更新托盘、不记「检测完成」。
- 渲染层只有 `useToolbox` 开机首屏那一次带这个参数：拿到旧结果先画出来（`loading` 仍为真，按钮照旧
  不可点），在同一个请求号下再读一次真的，接的是主进程开窗前就起好的那一轮。有 `cachedAt` 期间
  `Home` 不判「配置被改过」「已有第三方配置」，App 不发「工具有新版本」通知。`app-check.mjs` 的
  「last saved scan」用例钉住。
- 扫描里起子进程的探测（node、npm、python、git、Codex 桌面端、四家 CLI）经 `BoundedOperationQueue`
  限到同时 3 个（`scanProbeConcurrency`）；网络位置等只发请求的不占名额。
- `diagnostics:run` 新增可选参数 `{ reuseRecentScan?: boolean }`（不加通道，`parseDiagnosticsRunOptions`
  严格校验），只有 renderer-v2 开机那次自动检查传；检查页与 legacy 不传，行为不变。
- 主进程取 `systemService.recentScan(60_000)`：正在跑的那轮扫描就等它，一分钟内跑完且之后安装队列
  没动过就直接用，都没有就照旧自己探，不为此新起扫描。`createScanCoalescer` 为此返回
  `{ scan, recent }`。
- `runDiagnostics` 的 `recentScan` 依赖：运行环境、四个 CLI、Codex 桌面端从快照回答，扫描里
  `detectionFailed` 的项仍自己探；Windows 上 Codex 桌面端那次探测成功即证明
  `resolveWindowsPowerShellExecutable` 选出的 PowerShell 可用，`SYSTEM_POWERSHELL` 只取路径不起进程。
- 沙箱（Linux，未装 CLI）实测一次自动检查：自己探 124~169 ms，复用扫描 8~10 ms；Windows 上省下的是
  4 个 `--version`、1 次 PowerShell 和 Codex 桌面端那次合并探测（预算 24 秒）。
- `realm-account-service.ts`：`restoreActive()` 在非 401 失败时把账号记为 `stalledAccount()`（登录本来就留在本机账号库里），会话快照带 `restoring: { account, retrying: true }`，并在这个标记出现、消失时各发一次会话变化；登录、退出、切换账号、恢复成功或确认失效时清掉。
- 新增 `electron/account-restore-retry.ts`：按 30 秒 / 2 分钟 / 5 分钟（之后固定 5 分钟）重试 `restoreActive()`，没有搁着的账号就停，退出软件时 `prepareToQuit` 先停掉它。`main.ts` 在开机恢复结束后接上，联不上时不再重复补发会话。
- `ipc.ts` 的 `config:get` 在搁着期间照启动恢复中那样带 `ownershipPending`，首页不会把自己账号写的配置说成「用的是别处的配置」。
- 渲染层：`account-context.ts` 新增 `sessionRestoreRetrying`，`App.tsx` 在这段时间显示「暂时连不上，登录还在」，点账号 / 聊天提示登录还在、连上后自动恢复；契约 `AccountRestoringState` 加可选 `retrying`。
- Program Files 权限检查（`inspectProgramFilesAcl`，同步起 PowerShell）在管理员令牌（`trusted-only`）下的首页检测里一轮冷启动要跑 5 次上下，
  占住主线程。新增 `primeTrustedWindowsMachinePath`：从异步代码里先用同一段脚本、同样的超时和输出上限异步探测，结论经
  `validateWindowsMachineAclSnapshot` 写进同一份 5 分钟缓存，随后的同步检查只读缓存；探测失败照旧记为不可信。它自己不做任何放行判断，
  没预热到的路径同步检查照旧自己探。接入点：`isUserWritableResolvedPath`（`runCommand` 的 trustedOnly 路径与参数）、`findExecutable`
  的注册表 Node 目录、`executeVersion` 与 npm 探测前的 `primeTrustedHighIntegrityExecutable`。
- 注册表里的 Node 安装目录（`reg.exe` 两次）改为异步查询。
- 开机预热检测只在有账号要恢复时跑（`vault.active()`），没有账号的新用户落在欢迎页，本来不检测。
- `realm-account-smoke.mjs` 新增「恢复已保存账号时关窗 5 秒内退出」一步。
- 全面检测 Q48：`registry/tutorials.ts` 的 `TutorialStep` 改为按页收窄的 `section`（个人中心分页 /
  设置分组，其他页写了就编译不过），教程按钮调 `navigate(step.page, step.section)`；个人中心复用
  Q29（#412）的带序号 `accountTab`。设置页只在挂载时 `takeSettingsGroup()`，外壳跳设置前用新增的
  `hasPendingSettingsGroup()` 看有无待取分组，有就换 key 重挂设置页，顺带修好检查页「网络」项在设置页已挂载时不生效。
- 新增 `registry/tutorials.test.ts`（「在哪里」点名了非默认分页的步骤必须声明同一分页）与
  `testing/app-check.mjs` 浏览器用例。
- 「可能没想到的问题」第 9 条剩下的部分（勾选框）与第 13 条后半（npm.cmd），外加第 11 条尾巴（下载页写明系统要求）。
- `build/installer.nsh`：新增 `customUnWelcomePage`，照旧插入 `MUI_UNPAGE_WELCOME`，只挂 SHOW / LEAVE 两个回调，在欢迎页正文下方（120u 178u）加 nsDialogs 勾选框，离开时记进 `$xingmangClearLogin`。新增 `customUnInit`：静默卸载没有页面，命令行带 `--xingmang-clear-login` 等于勾上（客服远程与 CI 冒烟用）。`un.xingmangUninstallCleanup` 只在该变量为 "1" 时给程序多带同名参数。两个变量只在 `BUILD_UNINSTALLER` 下声明（-WX 下未引用即报错）。沙箱里用 electron-builder 自带的 Linux makensis 带 -WX 编过卸载程序那一遍（3 页），安装程序那一遍要 wine，交给 windows-uninstall-smoke。
- `electron/uninstall-cleanup.ts`：新增 `loginRecordFiles` / `clearLoginRecords`，删 `account-session.dat`、`saved-accounts.dat`、`realm-accounts-v2.dat`（连同读不出时留下的 `.unreadable-*.bak`）、两个站点各自的 `account-credentials.dat`，逐个走 `removeSafeDataFile`（I8：路径上有链接、文件多链接一律拒绝，但不影响其余文件）。托管 CLI Key 缓存、聊天 Key 缓存、设置不动（与「退出登录保留本机 Key」一致）。排在删开机项之后、还原代理之前；删不干净记退出码第 16 位。单测钉住文件名与 `main.ts` / `realm-account-vault-file.ts` / `realm-data-roots.ts` 的写法一致。
- `scripts/windows-uninstall-cleanup-smoke.ps1`：摆出登录记录后，直接调用清理程序（带与不带新参数）、静默卸载（不带参数应保留）、重装后带参数静默卸载（应删除），每一步都检查 Key 缓存与设置仍在。
- `electron/tool-installation.ts`：提权时委派给普通权限窗口的卸载命令在 Windows 上写 `npm.cmd`（窗口里会把这一行回显给用户，用户照抄进 PowerShell 时不会撞上 npm.ps1 与默认执行策略；cmd.exe 里两种都能跑）。`electron/system-service.ts` 的手动卸载提示按平台写「普通 PowerShell」或「终端」：核对后这条路径上真正带命令的只有 macOS standalone Codex（一段 sh），Windows 上不可自动卸载时本来就不给命令，所以清单说的「叫用户在 PowerShell 里跑 npm」在当前代码里实际只剩委派窗口这一处。`用户端出问题测试命令.txt` 里的 `npm --version` 同理改为 `npm.cmd`。
- `dl-landing/app.js`：Windows 下载项补「需要 Windows 10 或更新的系统」。仓库里只改源文件，dl.solov.cc 上的页面要另行更新。
- 卸载清理还原代理的单次 PowerShell 时限从 45 秒放宽到 90 秒、总上限从 150 秒放宽到 300 秒：windows-uninstall-smoke 在 runner 上第一条冷启动命令就超过了 45 秒（#370 合并前那次整段 55 秒通过，余量本就不多）。慢机器上超时的后果是卸完断网，比多等一会儿重。冒烟步骤时限相应从 10 分钟放到 20 分钟。
- 全面检测 Q49。卸载结果 `outcome: 'delegated'`（管理员模式转交给以登录用户身份运行的窗口）是预料之中的交接，原来首页 `App.tsx` 的 `requestUninstall` 抛错走 `OperationErrorDialog`，安装卸载页 `MaintenancePage` 也抛错显示红色「未完成」。新增纯函数 `features/tools/uninstall-handoff.ts` 的 `uninstallHandOffNotice`，两处改为关掉确认框、刷新状态、弹中性 toast，不再当失败；`manual-required` 仍按失败处理不变。
- 「可能没想到的问题」第 9 条。`build/installer.nsh` 新增 `customUnInstall`：electron-builder 的 `CHECK_APP_RUNNING` 把安装目录下的进程（桌面进程和加速辅助进程）强行结束之后、`customRemoveFiles` 删文件之前，用 `ExecWait` 以 `--xingmang-uninstall-cleanup` 再拉起一次安装目录里的 exe 并等它结束。升级安装会带 `--updated` 跑旧版卸载程序，那时不做（否则每次升级都会把用户的开机启动关掉）。失败只进卸载详情，不拦卸载。
- 新分支 `electron/uninstall-cleanup-entry.ts`（零依赖，`platform/entry.ts` 最先判断）与 `electron/uninstall-cleanup.ts`：`ready` 之前完成，不抢单实例锁、不开窗口。代理还原直接调 `createWindowsSystemProxy({ journalPath }).recover()`，与辅助进程崩溃后重放恢复记录是同一段比较后写入：系统代理仍等于加速写进去的那一份才还原，改过的一律不碰，只交还租约。没有恢复记录（从没开过加速）就不起 PowerShell。开机项走 `platform/system-service.ts` 新增的 `removeWindowsLoginItem`，与 #355 同一写法，按名字删，带参数与 0.2.9 前不带参数的两种都能删掉；名字取 `login-launch.ts` 新增的 `windowsAppUserModelId`（`main.ts` 改用同一个常量，scripts 测试钉住它等于 electron-builder 的 `appId`）。非打包环境不执行，免得开发机误删已安装版的开机项。退出码按位：1 代理未还原、2 开机项仍在、4 超时（150 秒；卸载时 PowerShell 常是冷启动，单次命令上限从辅助进程用的 15 秒放宽到 45 秒，`createWindowsSystemProxy` 新增可选 `commandTimeoutMs`，缺省不变）、8 不支持。
- 恢复记录路径收口到 `acceleration-development-host.ts` 的 `accelerationProxyJournalPath`，辅助进程与卸载清理共用。
- 新工作流 `.github/workflows/windows-uninstall-smoke.yml`（不进必需门禁，只在改到这条路径时跑）：Windows runner 上打一份不签名安装包，静默安装，摆出「系统代理指向已死端口 + 恢复记录 + 开机项」，静默卸载，检查代理回到原值、记录与开机项都没了（`scripts/windows-uninstall-cleanup-smoke.ps1`）。
- 已知边界：卸载程序以管理员运行。若提权时输入的是另一个管理员账号（标准用户卸载），清理读写的是那个账号的注册表和数据目录，本用户的代理不会被还原，不会误改。macOS 是拖进废纸篓卸载，没有可挂的钩子。「同时清除登录记录」勾选框另见 uninstall-clear-login.md（协调者定：默认不勾）。
- 全面检测 Q3。`quitAndInstall` 最终走 `app.quit()`（Mac 上先关所有窗口），`window-lifecycle.ts` 把它当成用户关窗拦下：问一遍「安装并退出」，或者直接 `preventDefault` 让安装器超时报失败；另外安装器在 Windows 上会结束安装目录下的进程，`prepareToQuit`（断开加速、还原系统代理）根本来不及跑。`updater.ts` 新增 `prepareInstallQuit` / `installQuitAborted`：`main.ts` 接到 `lifecycle.prepareUpdateQuit()`，先跑完退出清理、放掉画布与支付窗口，再拉起安装器；安装没起来（准备失败、看门狗超时）时 `abortUpdateQuit()` 撤掉放行。已经在退出确认里选了「安装并退出」的路径不变，同步拉起。
- `src/renderer-v2/App.tsx`：启动时不再按本机配置（`hasApiKey` / Codex ChatGPT 登录 / Gemini 个人 OAuth / 官方账号邮箱）把 `workspaceEntered` 置真。未登录进首页只剩引导走完（`onComplete`）这一条；开机恢复登录确认过期时也回欢迎页（网络连不上时照旧留在首页等重试）。退出登录、登录态结束两处原本就把它清掉，不变。
- 浏览器用例：新增 `src/renderer-v2/testing/guest-workspace.mjs` 的 `enterWorkspaceWithoutAccount`（欢迎页 →「先看看使用步骤」→ 选工具 → 进首页 → 跳过导览），原来靠 `guest=1&existing=1` 直接落在未登录首页的用例改为先走它；「本机工具不登录也能用」一条改成钉住新行为：有本机 Key 也先见欢迎页、登录框一点就开，走完引导照样能打开 Codex 桌面端。没配模型的那组模型检测用例从引导「确认连接」一步打开配置。
- 第十批候选 5。`window-preferences.ts` 新增 `isWindowTitleReachable` 与 `resolveRecoveredWindowBounds`：窗口顶部 36 像素那条标题带在任何一块屏幕的工作区里露出至少 100×20 才算够得着；够不着就按还原尺寸挪回主屏居中。用户自己拖到屏幕边上、标题栏还抓得住的不动。
- 新模块 `window-recovery.ts` 的 `recoverOffscreenWindow` 负责调 Electron：最大化的窗口先还原、挪位置、再最大化，全屏与最小化的不动（还原时的 `restore` 事件会再看一次）。
- `main.ts` 在主窗口的 `show` / `restore` 事件上挂校验，托盘、第二个实例、通知、任务栏还原等所有入口都会经过；另监听 `screen` 的 `display-removed` / `display-metrics-changed`，防抖 500 毫秒后把正显示着的窗口（含画布、充值窗口）挪回来。挪过一次记 `window/window.recovered-offscreen`。
- 新模块 `electron/workspace-config-overrides.ts`（只读纯判定）：Claude Code 看工作目录下 `.claude/settings.json` / `settings.local.json` 与管理策略（`managed-settings.json` 与 `managed-settings.d/*.json`，Windows `C:\Program Files\ClaudeCode`、macOS `/Library/Application Support/ClaudeCode`）里的 `env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY`、云厂商开关与 `apiKeyHelper`；Codex 看工作目录到 git 根的 `.codex/config.toml` 里的 `forced_login_method = "chatgpt"` 与 `cli_auth_credentials_store = "keyring"`（仅 apikey 模式）；Gemini 看 `.gemini/settings.json` 换登录方式，以及工作目录往上找到的第一个 `.env`（本软件打开时有注入的环境变量压着，只算「自己开终端」）；Grok 项目配置盖不过地址与密钥，不查。规则全部在沙箱里真跑四家 CLI（Claude Code 2.1.277、Codex 0.155.1、Gemini CLI 0.60.0、Grok 1.0.40）对本地假接口核过。读取走 `readBoundedUtf8FileSync`，不跟符号链接（I8）；结果与日志只有脱敏路径和键名（I13）。
- `cli:launch` 返回值从 `void` 改为 `CliLaunchResult { configOverrideNotice? }`（通道没增删，T1 不涉及）；`system-service.ts` 在信任写入与 AGENTS.md 之后检查，记 `workspace.config-override` warn 日志，检查失败不挡打开。渲染层 `features/tools/launch-notice.ts` 统一出打开后的提醒，首页 toast、记录页「接着上次」都接上。
- 诊断新增 `WORKSPACE_CONFIG_OVERRIDE`，看 `settings.workspace`（最近一次选的项目文件夹）与 Claude 管理策略，只看已配置的工具；从本软件打开一定不用当前账号的定 fail，其余 warn。这一项没有「去处理」按钮（`diagnosticHasFix`）。
- 未覆盖：Claude Code 的 Windows 注册表策略（`HKLM\SOFTWARE\Policies\ClaudeCode`）与 macOS 描述文件策略。
- `electron/codex-desktop-appx.test.ts` 里两条只在 Windows 上跑、要真起 PowerShell 的用例（解析两段生成脚本、未绑定 SID 的安装脚本在守卫处退出）
  改成所有平台都跑的纯文本检查：测试里按 PowerShell 自己的引号规则扫描生成的脚本，确认恶意路径只出现在单引号字面量里、括号成对、
  SID 守卫是顶层语句且排在任何文件操作之前、占位符过不了代理脚本的 SID 校验。原来 Windows runner 上冷启动 powershell.exe
  偶尔超过 30 秒用例预算，#452 首轮因此假红一次。随真跑一起删掉的还有只为它服务的临时文件、命令行长度与启动预算辅助。
- `powerShellLiteral`（`electron/windows-elevation.ts`）原来只把 ASCII `'` 双写。PowerShell 的分词器把 U+2018~U+201B
  四种弯单引号也当单引号（`CharTraits.cs` 的 `IsSingleQuote`，`tokenizer.cs` 的 `ScanStringLiteral` 对任意两个相邻的单引号字符取后一个为字面值），
  所以路径里的 `’` 会提前闭合字面量，后半截被当成代码执行。现在五种单引号都原地双写。
  受影响的脚本：打开 CLI 的终端脚本（same-user 下以用户身份，trusted-only 下带管理员令牌）、Node.js 与 Codex 桌面端的 UAC 代理脚本
  及其提权安装脚本（经 `-Verb RunAs` 以管理员运行，same-user 下嵌入的是 `%TEMP%` 路径，含用户名）。
- `codex-desktop-service.ts` 的 `powershellLiteral` 与 `claude-native-uninstall.ts` 的 `powerShellSingleQuote` 是同样写法的副本，删掉改用 `powerShellLiteral`。
- `windows-elevation.test.ts` 新增按 PowerShell 引号规则扫描生成脚本的用例：每种弯引号、混用 ASCII 引号，以及四类生成脚本里恶意路径只作为数据出现、
  脚本结构与无害路径生成的完全一致。
- 把 #452 的「C 盘搬家」例外接到剩下几处自带路径检查的模块，全部复用 `resolveRelocatedPath`，不另起规则：画布资产读回（`ai-asset-store` / `ai-video-asset-store` / `ai-audio-asset-store` 的有界读取与 `resolveOwnedFilePath`）、画布项目工作文件夹（`canvas-project-store` 的 `normalizedWorkspaceDirectory`）、Codex 会话（`codex-sessions` 的 `isInside`：Codex 会把我们注入的 `CODEX_HOME` 规范化，搬家机器上 `rollout_path` 记的是新位置，先按字面比、不在里面再两边都换成实际位置比）、Codex 外接工具与技能（`codex-extensions` 的 `assertNoSymlinkComponents`）、技能 Git 目录（`provider-extensions` 的 `plainGitDirectory`）。都是先换成实际位置再照原样严查；策略没开（`trusted-only`、root、启动探测未定）时 `resolveRelocatedPath` 等价于 `path.resolve`，行为与之前一字不差。`canvas-v2/` 未改动。
- 新增 `electron/running-tools.ts`（按实际安装位置认进程、逐个检测、文案生成）与只读通道 `tools:inspect-running`；首页一键切换账号来源（`account-source-switch.ts` 的 `inspectRunning` 依赖）和保存账号之间切换（`account-switch-sync.ts`）写完配置后都走它，检测失败退回「如果还开着」的说法；桌面端重开复用 `desktop:launch-codex` 的 restart。
- `ai-output-location.ts`：迁移遇到账号目录下的 `asset-metadata.json` 不再跳过，改为按作品编号合并进新位置（#486）；主进程把正在使用的 `AiAssetMetadataStore.mergeLegacy` 传进去，和搬家期间的收藏、新作品写入排同一个队列。老文件读不了或合并写不进时原样留在老位置、计入 `failed`，合并成功后才删老文件；重复合并结果不变。
- `ai-asset-metadata-store.ts` 新增 `mergeLegacy` 与纯函数 `mergeAiAssetMetadataItems`：同一作品两边都有记录时以更新时间较新的为准（收藏、标签、回收站状态都听它的），名称、来源、提示词缺了从旧记录补上，最近使用时间取较晚的。
- `features/shell/Announcement.tsx`：横条与铃铛红点改看「还没看过的公告」（本机 `xingmang-v2-notice-seen:<scope>`，最多记 200 条），打开公告中心或点横条的关闭按钮即记为看过；逐条已读状态与服务端/本机已读写入不变。去掉横条上旧的单条公告「标为已读」小勾，统一换成关闭按钮。
- `newapi-announcements.ts` 新增 `announcementAttentionKeys` / `readSeenAnnouncementKeys` / `rememberSeenAnnouncementKeys` 及单测；`app-check.mjs` 相应调整红点断言并新增关闭、刷新后保持、新公告重新提醒的浏览器回归。
- 余额刷新是唯一的定时请求（`balance-store.ts`）：窗口可见且有焦点时 60 秒一次，否则 10 分钟一次（隐藏时也继续，为了后台的新公告通知），按上次尝试计时，失败不会加快。以前是窗口没隐藏就 30 秒一次，每次打 `/api/status` + `/api/user/self`，中转运营方看到单机一天约三千次。
- new-api 客户端：`/api/status` 读取合并为一处（同时到达的 20 秒内复用），每次成功顺带解析 `announcements`（`parseNoticeBulletins`：最多看 100 条、显示 20 条，按发布时间从新到旧；`content` > 2000、`extra` > 500、日期或类型不对的跳过；忽略服务端会复用的整数 `id`，条目 id 为 `newapi-` + SHA-256(origin + publishDate)，同一时间的两条再加上正文）。失败时保留上一次的时间线。
- `getNotice` 增加 `cached` 读法（`account:get-notice` 多一个可选参数，没加通道）：余额刷新后的公告检查只取主进程已有的系统公告和时间线，不另发请求；打开公告、切账号、点「重新读取」仍按原来读 `/api/notice`，时间线超过 5 分钟时顺带读一次 `/api/status`。
- renderer-v2 的 `AnnouncementCenter` 去掉自己的 10 分钟定时器和 focus 监听，改为跟着余额快照的 `updatedAt` 检查；另一个站点的公告仍最多 10 分钟请求一次。时间线条目走本机已读（`localEntries` + `syncLocalReads`），标题取正文第一行，单个换行按硬换行渲染，类型用圆点标签。每个账号首次拿到时间线时，把标题与已读旧合集条目相同的、以及发布超过 7 天的记为已读，并记下 `xingmang-v2-notice-timeline:<scope>`。Sub2API 的公告路径不变，不放宽任何 CSP，公告内容不进日志。
- `features/shell/Announcement.tsx`：抽出 `loadNotice`，在公告窗口关着时每 10 分钟、以及窗口 `focus` / `visibilitychange` 回到可见时静默重读（按 1 分钟限流，失败不打扰、不清空当前内容，内容没变不重渲染）。之前只在挂载、切账号、打开公告时读。
- 窗口不在前台时有没提醒过的公告，经平台通道 `notifyActivity('announcement', key)` 请求一次系统通知；文案固定在主进程（`electron/platform/notifications.ts`），渲染层只给 FNV 摘要做事件编号，本机另记已通知过的公告（`xingmang-v2-notice-notified:<scope>`），同一条只弹一次。
- `PlatformActivityKind` / 通知偏好新增 `announcement`（默认开，老设置文件缺项按默认补齐），设置页多一个「新公告」开关。
- 修 #501：`announcement-persistence.browser-check.mjs` 改为等列表稳定到预期的已读/未读状态再断言，不再在首行出现时立即读取（打开窗口和切账号都会重读，可能读到中间的加载状态）。
- `electron/diagnostics.ts` 的 `ADMINISTRATOR` 检查：当前令牌是高权限、但启动探测成功且定为 `same-user`（TokenElevationType 为 default，即内置 Administrator 或关了 UAC）时改为 `pass`，details 带 `alwaysElevated: true`。这种账号没有普通启动可选，0.2.8 起就一直挂着 warn。只改检查页说法；`resolveWindowsCliExecutionModeDetailed` 的判定、写 Key 与搬盘的拦截条件都没动。启动探测失败、或确认是专门提权打开的（`trusted-only`），仍照旧提示普通启动。
- `electron/canvas-fingerprint.ts`：节点缓存指纹加入 `imageResolution` 与 MiniMax 的 `videoMode` / `videoResolution` / `videoAspectRatio` / `promptOptimization`，图版本同步加入后四项（#485，D11 = E-S5）。取值等于执行器默认值（模型默认清晰度、`auto`、`720p`、`16:9`、关闭）时不进指纹，已有缓存的键不变，升级后不会整批重跑扣费；非 MiniMax 模型不发送的视频参数也不进指纹。
- 新增 `electron/cc-switch-leftover.ts`：用户主目录有 `~/.cc-switch` 数据目录且配置里有别处的连接记 `provider`，密钥是 CC Switch 代理接管占位 `PROXY_MANAGED` 记 `proxy`；`buildConfigSummary` 把它挂到 `NativeConfigSummary.ccSwitchLeftover`（可选字段，不加 IPC 通道）。
- 渲染层 `ccSwitchLeftoverFor` 只在来源为 unknown / changed 且没有「就用现在这份」标记时生效；首页新状态 `ccSwitch`，按钮走现成的 `config:switch-account-source`（备份 → explicit 合并写入 → 连接自检 → 失败回滚）。
- `claudeForeignEnvKeys` 增加 `ANTHROPIC_DEFAULT_FABLE_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`（CC Switch 会写；Claude Code 2.1.277 实测 `--model fable` 会被前者改道）。
- 聊天记录从渲染层 localStorage（4 MB 上限，超限整份不写）改存到用户数据目录 `chat-history/<scope 的 sha256 前 32 位>/`，一个对话一个文件加一份索引，由新模块 `electron/ai-chat-history-store.ts`（每个账号 256 MB、单个对话 64 MB、最多 64 个账号目录的安全上限）经 `chat-history:read` / `chat-history:write` 两条通道读写；每次只重写改过的对话，索引最后写、删掉的对话在索引落盘后清理，退出前等最后一次保存写完。旧的 localStorage 记录（含账号别名与 v1 旧键）只读不写，首次保存即完成迁移，来源原样保留。50 个对话上限不变。
- `system-service.ts`（#477）：`saveConfig` 改为先挪开 `~/.claude.json` 的 `primaryApiKey` 再提交中转配置，挪不开直接抛错、不写配置；写配置失败时把 Key 放回。`switchToOfficialAccount` 对称地先放回 Key 再切，切换失败再挪开。`restoreOfficialCredentials` 不再吞错，一键切换的回滚能看到恢复不完整。新增 5 条单测覆盖挪开/放回成功、根配置不可解析、写配置失败后撤回。
- 第十二批候选 10：`electron/windows-elevation.ts` 的 `buildCliLaunchPlan` 在 `& <工具>` 后按 `$LASTEXITCODE` 输出两行固定提示（非零或启动失败走「可能是意外退出」），`-NoExit` 保留；`electron/macos-platform.ts` 的 `buildMacosTerminalScript` 去掉 `exec`，用 `|| cli_exit_code=$?` 接住 `set -e` 下的非零退出，并加 `trap ':' INT` 让 zsh 在 Ctrl+C 时不随工具一起被打断（处理器不是忽略，子进程仍是默认 SIGINT）。文案收在新模块 `electron/cli-exit-hint.ts`，两侧共用；只加固定字符串，未引入新输入（I1、I14）。
- `system-service.ts`（#482）：打开 CLI 的排队 key 由 `cli:launch:<provider>` 改为新增的纯函数 `buildCliLaunchQueueKey`（工具 + 打开方式 + 规整后的文件夹路径），不同文件夹或「接着聊」不再合并到前一个请求的 Promise。前缀不变，退出拦截照旧不把它当安装。补单测覆盖前面有安装排队时的交叠。
- `codex-desktop-service.ts`：Windows 安装/更新先走 `winget install --id 9PLM9XGG6VKS --source msstore`（winget 路径只取 `resolveSystemWingetExecutable` 校验过的 App Installer 包目录，argv 固定，当前用户身份运行，15 分钟上限），以本机实际装着的包版本判断成败；失败则按原顺序退到国内镜像 → 镜像备用源 → 上一版本，镜像下载、校验逻辑一行未动。更新时只有官方清单比本机新（或清单没读到）才试商店。
- 新增纯函数 `buildCodexDesktopStoreInstallCommand` / `describeCodexDesktopStoreFailure` / `parseCodexDesktopStoreProgress` / `shouldTryCodexDesktopStoreUpdate` / `describeCodexDesktopDownloadAttempt`；换线路的原因（商店没装上、国内镜像不可用）整段下载都显示，不再在 0% 之后被盖掉。镜像也失败时报错同时写出两边的原因。
- #491：`codex-sessions.ts` 的 `detail` 在跳过坏行或超长行（`invalidLines > 0`）时置 `messagesTruncated`；`exportMarkdown` 在文件末尾写与其它工具相同的不完整提示，并返回可选的 `truncated`（缺省 = 完整）；`provider-sessions.ts` 把它透传到统一导出结果，不再写死 `false`。
- #497：`renderer-v2/features/tools/recent-workspaces.ts` 的 `latestSessionIdsByWorkspace` 跳过归档记录，归档的最新一条不再占掉同一工具、同一目录里较旧活动会话的「接着聊」。
- `electron/codex-desktop-service.test.ts` 里两条只在 Windows 上跑的 MSIX 读取用例（读出身份字段与签名项、清单超 1 MiB 在解析前拒绝）
  原来先用 Compress-Archive 现场打一个 MSIX 再交给真 powershell.exe，一条用例两次冷启动，run 35809812859 里读取那一步被自己的 90 秒预算杀掉。
  现在拆成所有平台都跑的三条：注入 `run` / `resolvePowerShell` 检查交给 PowerShell 的参数、可信环境与超时，并把输出解析回元数据；
  用 #454 的引号扫描器检查带恶意字符的安装包路径只出现在单引号字面量里、清单大小检查排在解压之前、XML 读取禁 DTD 与外部解析；
  输出读不懂时报「无法读取」、PowerShell 自己拒绝时原样透出。生成脚本拆成 `buildCodexDesktopPackageInspectionScript`，行为不变。
- 补 #458：`e2e/renderer-v2-native-close-race.mjs` 装关窗记录器那一步的 `application.evaluate` 碰上 Playwright「Resulting promise was garbage collected」会直接红（run 36032954800），
  照 `electron-ci-smoke.mjs` 的做法最多重试 3 次，记录器在主进程挂一个已装标记，重试不会重复挂监听。
- `AppSettings.desktopNotifications` 改为缺省 = 开启，只落盘显式的 `false`（同 `crashReporting`）；主进程通知控制器、平台通知读取与 renderer-v2 设置页都按 `!== false` 判断。旧版本从不写 `false`，所以以前手动关过的用户升级后会被打开一次。legacy 回滚界面已冻结，未跟改。
- #488：`provider-extensions.ts` 的 Claude 插件列表按 ID + scope 分开，并去掉别的项目里的条目；Claude / Gemini 的 MCP 配置按文件标出 user / project / local；Claude 与 Gemini 的变更一律在项目目录里跑，项目层的操作没选项目时直接提示。渲染层 `runExtensionAction` 把列表里的 scope 原样带回。Gemini 扩展的 scope 如实标 user（原先猜成 workspace）。
- #489：Gemini 技能的 ID 是 SKILL.md 路径，`mutate()` 先 `skills list --all` 按路径找回技能名和所在层再下命令，找不到就报错，不把路径塞给 CLI。
- #490：通用技能扫描读 Codex config.toml 的 `skills.config` 停用项（`readCodexSkillEnablement`）；渲染层按原生 `managed` / `scope === 'system'` 判只读，用户技能走 `toggleSkill` / `uninstallSkill`。
- 浏览器分片的夹具在一次导航秒败（如 Windows 跑机上 `net::ERR_NO_BUFFER_SPACE`）后，先等完这次导航分到的那段时间再重新导航，不再在几百毫秒内把三次导航全用光；总预算仍是 90 秒，没有调大任何超时。
- `electron/claude-desktop-manifest.test.ts` 里只在 Windows 上跑的清单读取用例原来现场写清单、再真起 powershell.exe 读六遍，冷启动在跑机上连 90 秒都等不到（run 36042396731），CI 只看得到「清单无法安全读取」。
  生成脚本拆成 `buildClaudeDesktopManifestInspectionScript`（行为不变），改成所有平台都跑的文本检查：联接检查在打开文件前、大小检查与禁 DTD / 外部解析 / 字符上限在建 XmlReader 前；
  带恶意字符的路径只以 base64 出现在闭合的单引号字面量里；XPath 用到的命名空间与商店清单声明的一致；实际交给 PowerShell 的正是这份脚本。
- `e2e/fixture-readiness.mjs` 新增 `replayCollectedPromise`：Playwright「Resulting promise was garbage collected」的重放统一走共享的次数与退避（4 次，500/1000/2000ms）。
  electron-ci-smoke、onboarding-smoke、renderer-v2-native、renderer-v2-native-close-race 原来各自平着等 500ms 重试 3 次，run 36042396731 的 renderer-v2-native 首次读取就在 1.5 秒内三次全丢；
  门禁用例改为扫描 e2e 下所有冒烟，重放必须走共享模块，不许自带间隔。
- 新增 `electron/git-runtime-install.ts`：钉死 Git for Windows 2.55.0.5（`v2.55.0.windows.5`）与 x64 / arm64 安装包的 SHA-256，npmmirror 与 GitHub 发布两路按地区排序（同 Node.js），重定向只放行镜像与 GitHub 发布资源主机。普通权限下用 Inno Setup 静默参数加 `/DIR=%LOCALAPPDATA%\Programs\Git` 按当前用户安装；以管理员身份运行时不给 `/DIR`，避免系统 PATH 指向普通用户可写目录。
- 新 IPC `runtime:install-git` 与进度事件 `runtime:git-install-progress`（排在 `runtime:install-python` 之后），经 `InstallationQueue` 的 `runtime:git` 与下载加速。
- Windows 上 `installCli('claude')` 出队后再排 `runtime:git`（队列全局串行，不能在队列任务里再入队），经 `installGitAlongsideClaude` 吞掉 Git 的失败，只往 Claude Code 的安装进度里写一句说明；已有 Git 时安静跳过。
- `command-runner.ts` 的兜底 PATH 补上两处 Git 的 `cmd` 目录，装完不用重开本软件就能被检测到、被从本软件打开的 Claude Code 找到。
- `git-runtime.ts` 的 Windows 文案改为指向「安装 Git」，面向客户的缺 Git 提示不再出现 PowerShell、bash、网址；macOS 行为不变。
- #484（审计 D10）：`canvas-run-engine.ts` 在 running/submitting 落盘之后、调用 executor 之前，再检查一次是否已取消；`canvas-node-executors.ts` 的 image、image-edit、video 三个入口对已经 aborted 的 signal 直接拒绝。原因是 `addEventListener('abort')` 对已经取消的 signal 不会触发。两处都补了测试，去掉修复后测试会失败。
- #479（审计 D05）：`pages-account.tsx` 的「配置到工具」保存成功后调用新的 `onToolConfigSaved`（经 `pages-business.tsx` 透传），`App.tsx` 接到 `toolbox.refreshConfig()`——它自带账号范围守卫，读失败时首页标成配置没读到，不会拿旧快照冒充新配置。`testing/app-check.mjs` 加用例钉住保存之后会重读配置。
- #496（审计 D22）：`business-common.tsx` 新增纯函数 `overflowedPage`，`pages-account.tsx` 的密钥列表在总数变少、当前页越界时退到最后一页。`e2e/v2-business-fixture.tsx` 加 `keyCount=N` 真分页夹具（撤销会真的少一把），`e2e/v2-business.test.mjs` 钉住 21 → 20 的情形。
- #495（审计 D21）：`account:list-keys` 的查询多一个可选 `keyword`（`NewApiAccountKeysQuery`，`ipc.ts` 限 64 字），带上时主进程用新的 `searchAccountKeys`（`account-key-quota.ts`，与 `findAccountKeyById` 同一个翻页安全阀）翻完整张列表按名称、分组筛完再分页，搜索词不发给后端；翻不完就报错，不拿半截结果说「没有」。渲染层 `pages-account.tsx` 停手 300 毫秒后带搜索词重查、回到第一页，去掉原先只筛本页的本地过滤。通道不变，三处通道表无需改动。
- `account-bootstrap.ts`：`synchronized.failed` 里 `plan.skipped` 为 `not-installed` 的工具不再拼进 warnings；装完工具那一轮（`syncAfterToolInstalled`）会只针对它重写，失败在那时经 `failed` 上屏。warnings 里的签发失败也改走 `keySyncFailureText`，与首页 `failed` 同一套脱敏与归类。
- `key-sync-failure.ts`：识别 Sub2API「分组不存在、不可用或名称重复」与 new-api「当前账号不可使用分组」两句，换成客户能照做的话。
- 侧栏 `AccountView` 加可选 `sourceLabel`，App 按 `accountSources[siteId].label` 传入；缺省仍是「星芒账号」。
- `managed-cli-groups.ts`：Sub2API 每个分组自带 `platform`（anthropic / openai / gemini / grok），识别档先按它找唯一一个，同上游多个时再按名字里的工具词区分；上游明确属于别家 CLI 的分组不再按名字认领。`sub2api-relay-backend.ts` 的 `listUsableGroups` 把 `platform` 透传出来（`NewApiUsableGroup` 加可选字段，新站不给）。`resolveAccountKeyOptions` 不 await、全缓存时零请求这两条不变。
- 首页工具行新增 `notEnabled` 状态（`registry/status.ts`：「账号未开通」，neutral）：本轮 `bootstrap.result.failed` 里该工具的原因经 `isAccountNotEnabledFailure` 认定是账号没开通时取代 `unconfigured`；只剩这类失败时横幅不给「重新同步」。
- `features/account/login-device-label.ts`：只在显示层把登录会话的 User-Agent 认成大白话，发给服务端和服务端回来的原文都不动。
- `features/app/runtime-log-filter.ts`：新增 `runtimeLogArea`（source + event → 侧栏叫法；source 为 ipc 时按通道前缀认），「全部来源」下拉改按这个叫法筛选，选项从已加载的条目里取；`runtimeLogDisplayMessage` 去掉网络失败文案后面括号里的排查现场。复制这一条、导出报告的格式不变。
- 自签证书没有 TeamIdentifier，钥匙串按每版程序指纹（cdhash）认人，Mac 每换一个版本第一次读 safeStorage 都会要「登录」钥匙串密码。代码绕不开，只加提示：`pages-maintenance.tsx` 的重启确认框按 `getPlatformCapabilities().platform === 'macos'` 显示 `macKeychainUpdateHint`；`registry/tutorials.ts` 的 safety 章节加一条 extra 与关键词。
- renderer-v2 的系统类型在挂载前就定好：`main.tsx` 先按 Chromium 自报的系统写 `data-os`，`App.tsx` 在平台能力回来前沿用它（以前先写 `win`），并把它显式传给 `Splash` / `Welcome` 的 `AuthWindow`；判断收口到 `features/app/window-os.ts`。`testing/app-check.mjs` 逐帧记录启动页和欢迎页的 `data-os`，钉住 Mac 上每一帧都按 Mac 排版。
- `macos-command-line-tools.ts` 新增 `inspectCommandLineToolsShim`：确认 `/usr/bin/git`、`/usr/bin/python3` 背后那份存在后，再试跑一次 `--version`，失败就不算可用；stderr 是 xcrun 的「You have not agreed to the Xcode license agreements」时回 `license-pending`。`isCommandLineToolsShimBacked` 改为它的布尔包装，首页扫描、检查页、外接工具页三处调用方自动跟上。以前 Xcode 许可没同意时空壳不弹窗、只吐这句英文并以 69 退出，`system-service.ts` 的 `executeVersion` 在失败分支把 stderr 第一行当成版本号，于是整段英文上了首页；0.2.9 已是如此，不是 0.2.10 回归。
- 检查页 `DiagnosticToolStatus` 新增可选 `xcodeLicensePending`，Git / Python 两行给 `xcodeLicensePendingNotice` 的说明，不提 sudo、不叫客户开终端。
- `provider-extensions.ts`：服务与更新检查器新增可注入的 `inspectCommandLineToolsShim`（与原布尔注入并存，给了以它为准），`claudeMarketplaceGitMissingMessage` 新增 `xcodeLicensePending` 选项；许可没同意时插件市场与扩展更新检查的报错改用 `xcodeLicensePendingNotice`，不再说「先装命令行开发者工具」。
- `pages-maintenance.tsx`（#481）：与首页同一判定 `isExternallyManagedInstall`，原生/其他来源的 CLI 禁用「重新安装」（新增 `maintenance-install-<id>` testid），说明改用 `externalInstallHint`。
- `system-service.ts`：`installCliOperation` 开头新增 `assertNpmChannelOwnsCli`，按首页同一 npm 全局根判定来源，原生/其他来源直接拒绝（纯函数 `externalCliInstallRefusal`），探测失败不拦；Grok 不受影响。浏览器夹具新增 `nativeInstall`，补单测与浏览器回归。
- #493（D19）：publish-release 的 publish 作业在第一次上传之前新增「Refuse to overwrite a version that already shipped」：tag 已存在且指向别的 commit，或线上 `latest.yml` / `latest-mac.yml` 已是这个版本（或更高）而本次产物不是同一批文件（`scripts/publish-guard.cjs` 逐个比 SHA-512 与大小），直接停下。原先只发 Mac 时要到最后打 tag 才发现版本号撞车，线上的 Mac 包那时已被同名覆盖。同一 commit 上先发 Windows 再补发 Mac、以及同一批产物的发布作业重跑仍然放行。
- #476：`realm-account-service.ts` 的 `promote` 在输密码登录（`fresh`）提交成功后，注销被替换掉的同账号会话：当前客户端就是这个账号时用它自己的 `endServerSession`，否则（另一账号在用、开机恢复卡着）用本机账号库里被覆盖的那份凭据走新增的 `endSavedSession` → `new-api-client.ts` 的 `endPersistedServerSession`（只带 refresh cookie 与 New-Api-User，服务端按 cookie 注销）。登录成功但本机没存下来时当场注销那个新会话。切换已保存账号、开机恢复、密码错误都不发。业务代理不暴露新方法。线上注销接口是否接受这种只带 cookie、不带 Origin 的请求没法在沙箱里验证，要真机看个人中心「登录设备」数量。
- #487：`acceleration-service.ts` 读写加速线路/模式偏好前先核对是不是当前登录账号，读完再核一次，退出或切换账号之后到的旧请求一律拒绝。
- #478（审计 D04）：`App.tsx` 的 `rewriteAccountKeys` 点名重写时，被规划器跳过（手填、来源没确认、官方等）的工具不再算成功，抛 `KeyRewriteSkippedError`（`features/tools/account-bootstrap.ts`，另有纯函数 `skippedNamedProviders`）。`pages-account.tsx` 的 Key 页据此区分「没换成、再换一次」与「跳过了、去设置」两种提示；「去设置」经新的 `onConfigureTool` 打开该工具的设置（`pages-business.tsx` 接 `openConfig`）。`e2e/v2-business.test.mjs` 加手填工具的撤销用例。
- #494（D20）：rollback-release 在撤回版本、覆盖根目录清单之前，就把备份清单引用的每个安装包完整下载一遍，核大小、SHA-512 与 blockmap（新增 `rollback-release.cjs verify`，与发布后 `update:verify-feed` 共用 `update-release-utils.cjs` 里同一段核对逻辑）。原先预检只 HEAD 一下确认文件在，200 但内容已被同名覆盖的安装包要等线上换过之后才暴露。`docs/SERVICE-STATUS.md` 的回退例子改成「0.2.11 退回 0.2.10」，并写明 0.2.10 自己出问题只能撤回 + 发 0.2.11（0.2.9 没发过、没有备份，0.2.8 低于客户端的回退下限）。
- #480（审计 D06，0.2.10 由 #428 引入）：`SavedAccounts.tsx` 的重登按钮带上 `savedAccountLoginTarget(account)`（来源 + 用户名），`App.tsx` 用新的 `authTarget` 状态传给 `AuthFlow` 的 `initialSiteId` / `initialIdentifier`，关框或登录成功即清空，其它入口照旧打开默认的星芒账号登录框。`onLogin` / `openLogin` 改为可带可选 `LoginTarget`，原先直接 `onClick={onLogin}` 的几处包一层，避免把点击事件当成目标传进去。
- #500（R03）：`scripts/service-status.cjs` 只在线上状态文件确实不存在（工作流拿到 404）时从空白开始；读回来是空白、网页、不是 JSON 或不是对象时报错停下，不再当成空白重建。原先缓存或路由临时回一张 200 的 HTML，改一次维护开关或跑一次回滚就会把线上的撤回名单与分批放量一起抹掉。
- #475（D01）：按工具额度在四种情况下被放开，统一改成拿不准就不放开。`new-api-client.ts` 的 `hasExhaustedCappedCliKey` 加 `newerThanId`、`sub2api-relay-backend.ts` 的 `provisionCliKey` 同理：同名 Key 里比用完的上限更旧的不再被复用；`ipc.ts` 撤销前读不到本机工具密钥记录时，设了限制的 Key 不撤；撤销报错后只有列表里还看得见这把 Key 才删记下的限制；`chat-credential-coordinator.ts` 聊天 Key 401 后查不了列表就保留本机 Key 报错，不再当成「没用完」去换新的。
- 新增 `electron/tool-model-check.ts`（按工具与「站点 + 账号 + Key + 型号」缓存一天，失败一小时后再试，模型接口最多等 5 秒）与通道 `tools:check-models`；只核本软件用当前账号写的配置，Claude Code 菜单过期（`claude-model-picker.ts` 的 `claudeRelayModelPickerOutdated`）时走 `saveConfig` 的自动写入闸刷新。renderer-v2 在 `launch()` 里、选目录之前调用，换模型走空 Key + merge 的 `saveConfig`，配置来源保持不变。
- #498：卸载清理（`electron/uninstall-cleanup.ts`）先比对本进程账号与本会话桌面（explorer.exe 主人）的账号 SID；不一致时开机项、系统代理、登录记录一样都不动，以 32（`otherAccount`）退出。问不出来时照旧清理。0.2.9 本来就不清代理，这种情况跟 0.2.9 一样。
- #492（D18）：正式发布的 publish 作业、rollback-release、service-status 三处写更新目录的作业改为共用 `update-feed` 并发组（挂在作业上，出包阶段不受影响）。原先发布用 `publish-release`、回滚与维护开关用 `service-status` 两个组，发布与回滚可以在「读线上 → 写回」之间交错，互相盖掉清单，撤回名单与线上版本对不上。`scripts/publish-workflow-config.test.cjs` 扫描全部工作流，凡是 `aws s3` 写入的作业都必须在这个组里。
- #483（D09）：`ai-video-service.ts` 的 `fetchWithTimeout` 改为 `fetchAndRead`，超时与取消覆盖响应头到正文最后一个字节；视频正文按「多久没收到数据」计时，JSON 响应按整次请求计时；正文读取与 `raceAbort` 竞速，body 不响应 signal 时也能结束，`whenIdle` 与账号切换不再被挂住。
- #499（R02）：外部视频下载地址（签名 URL 与中转重定向目标）连网前先做 DNS 解析，任一结果落在本机/内网/保留段即拒绝；签名 URL 被拒或解析失败时退回中转的 `/content` 接口，重定向目标被拒则报错。放行 198.18.0.0/15 以兼容 Fake-IP 代理。未做 IP 固定（请求仍走代理感知的 `net.fetch`），属纵深防御。
- Windows CI 里三处在 runner 忙时偶发超时假红的检查改成不依赖 PowerShell 冷启动或墙钟：
  `electron/cli-process-probe.test.ts` 的「real PowerShell probe」（Get-CimInstance 三次超过 60 秒探测预算）改成所有平台都跑的两半——
  注入 `runProbe` / 新增的 `resolvePowerShell` 检查交给 PowerShell 的参数与可信环境，再用 #454 的引号扫描器检查脚本只从环境变量读目录、两种进程形态都按序数比较；
  `scripts/windows-acceleration-recovery.test.cjs` 的逻辑测试本来就把原生读写全换成桩，不再现场 Add-Type 编译用不到的 WinInet 类型（多起一次 csc.exe，run 35885043224 超 30 秒），
  另加一条全平台检查保证恢复脚本与 `electron/platform/windows-system-proxy.ts` 的 WinInet 源码一字不差（真编译真改代理仍由 windows-uninstall-smoke 覆盖）；
  `e2e/renderer-v2-native-close-race.mjs` 去掉 5 秒退出墙钟（退出本身就允许 2 秒清理加 2 秒兜底强退，run 35892482024 超时），改为在主进程记录关窗事件，断言关窗走到自己的 before-quit、全程没向界面发退出询问，
  「不等界面」改由 `electron/window-lifecycle.test.ts` 在不推进任何时钟的前提下直接证明。
- 引号扫描器从 `codex-desktop-appx.test.ts` 挪到 `electron/powershell-script-scan.test-support.ts` 供多个测试共用；`tsconfig.electron.json` 排除 `*.test-support.ts`，不进 dist-electron。
- `electron/chat-key-store.test.ts`「每个账号最多 32 个分组」原来连着做 33 次落盘原子写，Windows 跑机忙时连放宽到的 15 秒都不够（#511）。
  裁剪逻辑拆成纯函数 `pruneChatKeys` 直接测（32 个分组、16 个账号、总数 128、返回副本）；存储层用例先一次写好到上限的缓存文件，再做一次写入，确认真的按上限裁；「16 个账号」那条同样改写。去掉了那条单独放宽的 15 秒超时。
- `electron/windows-elevation.test.ts`「读当前令牌提升类型」原来真起 Windows PowerShell 现场编译 Add-Type，失败再来一次，跑机忙时仍会红（#511）。
  生成脚本拆成 `buildWindowsTokenElevationProbeScript`（行为不变），`inspectCurrentWindowsTokenElevationType` 新增只给测试用的 `platform` / `resolvePowerShell` / `run` 注入口；
  改成所有平台都跑：交给系统 PowerShell 的参数、可信环境（`NODE_OPTIONS` 被剥掉）、15 秒与 64 KiB 上限、输出解析；读不懂报错、失败原样透出；非 Windows 不问；TokenElevationType=18 与 1/2/3 的映射；here-string 与括号闭合。
- `external-client-runtime.ts`：找不到可信系统 winget 时，`installHint` 固定为 `externalClientWingetUnavailableHint`，原始原因（如 `realpath` 的 ENOENT）经新增的 `onWingetUnavailable` 回调写进运行日志 `external-client.winget-unavailable`，同一原因只记一次；安装进度与失败文案去掉「winget」字样。`node-runtime.ts` / `python-runtime.ts` 切换到官方安装包时的进度文案同理，`failures` 里的原始原因不变。
- 新增 `externalClientOfficialDownloadUrls`（`external-client-contract.ts`）与可选状态字段 `officialDownloadUrl`：Windows 上 winget 不可用、又没有腾讯官方包兜底时给出。两条网址逐条并进 `main.ts` 的外链白名单（I12 全等匹配，不放宽规则）；首页 `onOpenExternalDownload` 缺省时仍是「暂不支持」。
- 别家中转留下的配置一键改用当前账号（引导第 3 步、配置窗口、首页三处，复用 `switchAccountSource`，不加 IPC 通道）：
  `features/tools/model.ts` 新增 `foreignKeyKind`（来源没确认时按 `matchesRelay` 分 `otherSite` / `otherAccount`）与 `switchAccountLabel`（「改用 <用户名>」，超 16 字截断）；`accountSwitchTarget` 对 `unknown` 也回 `account`。
  首页新增状态 `otherSiteKey`「不是当前账号的 Key」/ `otherAccountKey`「Key 可能不是当前账号的」和行按钮 `tool-<id>-use-account`；「配置被改过」仍走 `configChanged`，不并进这两类。
  `StartGuide` 新增 `keyState` / `onSwitchAccount` / `accountName` / `onFailureAction`：`otherSite` 藏掉「下一步」只留一颗主按钮，`otherAccount` / `changed` 放行「下一步」；改完自动进第 4 步并提示备份位置，自检没过不写「已准备好」；没登录时按 `otherSite` 处理，登录后自动接着改。`guideFailureExits` 按错误目录给出口。
  `ConfigDialog` 去掉「查看处理步骤」「填写星芒密钥」，改用后不关窗；手填入口移进「高级」。`initialKeyChoice` 只在 Key 属于本站时默认「保持当前」。
  错误目录新增 `toolNotEnabled`（分组不可用 → 找客服）、`switchUndoFailed`（自动恢复失败 → 新动作 `backups` 去备份页）。CC Switch 提醒从 toast 改成对话框；Codex 改用时补一条两端共用配置的提示。
  主进程 `account-source-switch.ts` / `ipc.ts` 的提示文案由「切到当前账号」统一为「改用当前账号」。
