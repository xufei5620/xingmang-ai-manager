# 可靠性清单：看改动挑检查

> 2026-11-17 起（对照官方「验证」文章的建议第 4 条）。每一条都写三件事：从改动里看得出来的**触发**条件、命中以后**查什么**、**出自**哪次事故或哪条规矩。
> 每次只查命中的那几条，通常三五条，一条都没命中是常态。

## 怎么用

1. **开 PR 前**跑 `npm run checklist`。它按本分支相对 `origin/main` 的改动（含没提交的），列出命中的条目。清单从 `origin/main` 读，不读本分支这份：改动不能改自己的裁判。先 `git fetch origin main`。
2. 命中的每一条照「查什么」查一遍。PR 正文「可靠性清单」那一节写命中了哪几条、每条怎么查的、哪条查不了（比如要真机，就写「没演过」并写进真机新增那份文件）。`npm run checklist -- --markdown` 打出能直接贴的那一段。
3. **复核 diff、合并的人**对着 PR 里贴的命中条目看；有疑问就在分支上自己跑一遍。本 PR 改了清单本身的，脚本会提示：新加或改过的条目按 main 上那份不会命中，要单独看。

其他用法：`--base <提交或分支>` 换比较的起点；`--from <提交或分支>` 换清单从哪里读；`--local` 读工作区这份（改清单本身时试触发用）。

## 怎么加一条、改一条

- 优先收真出过事的：客户报的、CI 漏过的、真机上才看到的，「出自」写事故和 PR 号。规矩类只收测试钉不住、又常被漏掉的。已经有测试或门禁钉死的不收。
- 编号 `R` 加两位数字，删掉的编号不再用。
- 触发的写法（`scripts/reliability-checklist.cjs` 按这几种写法读）：
  - `- 触发：文件 ` 后面跟反引号括起来的文件写法：改动的文件对上任何一个就算。
  - `- 触发：改动行含 ` 后面跟反引号括起来的正则：任何文件里加的或删的行对上任何一个就算。文档里也常提到这些词，所以一般跟下一种写法连用，圈定在代码文件里。
  - 两段写在同一行、中间用「，」隔开：文件对上，**并且**这些文件的改动行里有对上的。
  - 一条可以写几行「触发」，任一行对上就算命中。
- 文件写法：`*` 不跨目录，`**` 跨任意层，`!` 开头的是排除。正则按 JavaScript 写、区分大小写；里面不能有反引号，要用就写 `\x60`。
- `npm test` 里的 `scripts/reliability-checklist.test.cjs` 逐条核对：编号不重、三项齐全、正则编得过、每个文件写法至少对得上仓库里一个文件（文件改名、删掉以后触发悄悄失效，那里会红）。
- 每条写短。超过 30 条就修剪：每月 1 号整理那次顺带看，哪条已经有测试钉住了、哪条的事故已经不可能再出，列给 yoyo 看过再删。

---

### R01 拖动区盖住按钮（侧栏、顶栏、标题栏）

- 触发：文件 `src/renderer-v2/features/shell/**` `src/renderer-v2/styles/shell.css` `src/renderer-v2/features/auth/auth.css`
- 触发：文件 `src/**` `electron/**`，改动行含 `app-region` `AppRegion`
- 查什么：拖动区里加的装饰层、提示行、角标排在按钮后面时，用真鼠标点一次被它盖着的按钮：xvfb 起真 Electron、`frame:false` 窗口里 `xdotool mousemove x y click 1`，或打包版真机点。Playwright 的点击不经过系统的拖动区判断，CI 的 Chromium 151 也不继承 `app-region`；`src/renderer-v2/testing/app-check.mjs` 的 `windowDragOverControls` 只按 152 的规矩核对侧栏和顶栏。
- 出自：#1574（2026-11-08）。#1508 升到 Electron 45 后 `app-region` 会传给子元素，侧栏账号卡整张变成拖窗口的地方，点头像进不了个人中心。CI 全绿，yoyo 在 0.2.23 上点出来的。

### R02 付款窗口

- 触发：文件 `electron/payment-window.ts` `electron/security.ts`
- 查什么：真开一次付款页：窗口出来、能关、主窗口照常能点；付款页上某个资源卡住时「打开支付窗口」不能一直转；代理软件关着时也开一次。导航和外链白名单只许收紧，放宽要 yoyo 亲手打字同意（I12、I15）。
- 出自：0.2.22 热修 #1405（2026-10-26）：等整页加载完才算打开、易支付先跳一张页被当成打不开、模态窗口关不掉，客户用支付宝充值打不开（#1458）。#1823（PX-2）：代理软件关了付款页打不开。

### R03 写进工具配置的模板

- 触发：文件 `electron/config-files.ts` `electron/config-files-context.ts` `electron/codex-config-*.ts` `electron/tool-route-rewrite.ts`
- 查什么：一，客户自己设过的值不动：拿一份带自定义键的老配置走一遍保存和开机对账，前后对比只动了目标那几个键。二，模板变了要不要抬 `relayTemplateRevision`（老客户开机补一次）。三，用 tmux 开真终端，交互模式进一次 Codex 和 Claude Code，看第一屏有没有「⚠ N warnings」或英文提醒；`codex exec`、`claude -p` 看不到第一屏。
- 出自：#1572（2026-11-08）往 `[features]` 写了 `interrupt_on_cancel`，Codex 0.164 不认，第一屏右下角挂着「⚠ warnings」（11-09 新手流程深查，#1593 去掉）；`defer_mailbox_preemption = true` 不配 `suppress_unstable_features_warning = true` 会每开一个对话弹英文提醒。#1552：0.2.5 及更早写的配置没有来源记录，换线路一直跳过它们。

### R04 抬命令行工具的推荐版本

- 触发：文件 `electron/cli-verified-versions.ts` `docs/CLI-VERIFIED-VERSIONS.md`
- 查什么：交互模式开一次看第一屏（弹窗、英文提醒、warnings）；在本地假中转上把新旧两版发出去的请求对一遍（路径、请求头、请求体字段、WebSocket 消息类型），新冒出来的就是要到真中转上重点看的；`cli-relay-probe` 作业要绿；npm 上是 latest、不在坏版本区间；yoyo 回「合」才合。
- 出自：Codex 0.163 起回复途中发 `response.interrupt`，线路2 的中转只认 `response.create`、`response.cancel`，回 400，子代理做完的那一轮直接失败（#1572）。Claude Code 2.1.310 第一屏弹英文「Make auto mode your default permission mode?」，`claude -p` 测不到（11-09 新手流程深查）。

### R05 自动更新

- 触发：文件 `electron/updater.ts` `electron/auto-update-install.ts` `electron/installed-release.ts` `electron/update-*.ts` `electron/bootstrap/updates.ts`
- 查什么：升级冒烟（quality 里按改动自动跑，作业名 `upgrade-smoke / …`）全绿才合。再想一遍它测不到的：Mac 升级后第一次打开的钥匙串框（R07）、Intel Mac、Windows 普通账号、下好以后什么时候装（退出、打开 2 分钟内、点按钮、强制更新）、下好后还查不查更新的版本、代理软件关着时改直连（R10）。
- 出自：2026-10-27 查 0.2.19 一批电脑一直升不上去：下好后只在那四个时机装，下好后不再查新版。#1524（10-28）合并时升级冒烟红着，因为它当时不在必过检查里（测试和 CI 深查 CI-6，2026-11-17 起由 `quality-gate` 拦）。

### R06 落盘格式（账号、密钥、设置、备份）

- 触发：文件 `electron/*-store.ts` `electron/app-settings.ts` `electron/saved-accounts.ts` `electron/codex-home.ts` `electron/backups.ts` `electron/realm-account-vault*.ts`
- 查什么：拿老版本写下的文件（或照老格式手写一份）放进去：新版本读得出、不清空、不报错；读坏了停下报错，不从空记录重写；老备份恢复得了；新字段可选、缺省等于旧行为（AGENTS.md T10）。
- 出自：#560：额度记录读坏时从空记录重写，抹掉别的工具的记录。#1552：0.2.5 及更早写的工具配置没有来源记录，开机对账和换线路一直跳过，地址停在线路1。

### R07 Mac 签名身份、钥匙串

- 触发：文件 `electron-builder.config.cjs` `scripts/electron-fuse-hardening.cjs` `scripts/*macos*sign*` `scripts/macos-release-keychain*` `scripts/run-macos-free-build.cjs`
- 触发：文件 `electron/**/*.ts` `!electron/**/*.test.ts`，改动行含 `safeStorage`
- 查什么：升级后第一次打开会不会弹钥匙串密码框。Cookie 加密和 `safeStorage` 用登录钥匙串里的「xingmang-ai-manager Safe Storage」，按签名哈希放行，自签名每次升级哈希都变。升级冒烟把临时钥匙串设成默认，绕开了这个框，测不到；要在真 Mac 上从上一个正式版升上来看一次（交 yoyo）。
- 出自：2026-10-27 客户升级后钥匙串弹框被拒（#1476、#1521 补了怎么点的提示）。10-28 升级冒烟实测：钥匙留在登录钥匙串里，新版本卡在密码框，一行日志都没有。

### R08 PowerShell 脚本：受限语言模式

- 触发：文件 `electron/**/*.ts` `scripts/*.ps1` `!electron/**/*.test.ts`，改动行含 `Import-Module` `\$ErrorActionPreference` `Add-Type` `pscustomobject` `Start-Process` `\[[A-Za-z.]+\]::`
- 查什么：受限语言模式（ConstrainedLanguage，客户开着应用控制策略）下照样能跑：开头按名字导入用到的模块（Utility 放第一个，导入前别用 Join-Path 这类命令）；不用 `Add-Type`、`[X]::new()`、`[pscustomobject]@{}`、`[Environment]::`、`[IO.Path]::`；`$ErrorActionPreference='Stop'` 放在设 UTF-8 那句后面。Windows 打包作业跑的 `e2e/windows-powershell-probes-smoke.mjs` 有受限模式探针，新脚本照着加一条。单引号字符串走 `powerShellLiteral`，单元测试不起真 PowerShell。
- 出自：2026-11-10 客户 Windows 开着应用控制策略，首页四张卡和安装、更新脚本整条失败；#1711、#1716、#1730 分批改。

### R09 升 Electron

- 触发：文件 `package.json`，改动行含 `"electron":`
- 查什么：Chromium、Electron 的行为变化在 Playwright 夹具里不显形，真起 Electron（xvfb）看三处：拖动区里的按钮真鼠标点得进（R01）；窗口没焦点时页面写剪贴板会被拒（`Document is not focused`）；Chromium 的网络错误只剩整句 message、没有 `code`（R10）。
- 出自：#1508（2026-10-28，43 升 45）之后接连三件：侧栏账号卡点不进（#1574）；「复制给客服」等报告时切去别的窗口就复制不上（#1835）；更新的「代理连不上就改直连」从没触发过（#1592）。

### R10 联网请求与代理软件

- 触发：文件 `electron/**/*.ts` `!electron/**/*.test.ts`，改动行含 `session\.fetch` `net\.request` `net\.fetch` `setProxy` `ERR_[A-Z_]+`
- 触发：文件 `electron/network-failure.ts` `electron/proxy-bypass.ts`
- 查什么：系统代理指向一个没在听的端口（客户关了代理软件）时也能用，改直连再试一次；判断 Chromium 网络错误按整句 message，别按 `error.code`（Electron 45 的这类错误没有 code）；「服务暂时不可用」统一走 `network-failure.ts`。
- 出自：#1592（更新，PX-1）、#1613（服务状态文件）、#1823（付款页，PX-2）、#1832（开票中心）：代理软件一关就打不开，或者改直连那条路从没触发过。

### R11 IPC 通道

- 触发：文件 `electron/ipc-contract.ts` `electron/platform/contract.ts` `electron/canvas-contract.ts`
- 查什么：三处一致有测试钉着，另外几件测试管不到：入参当敌意输入校验（I5）；明文密钥、令牌不随普通查询过 IPC，新的明文通道要在 AGENTS.md I3 登记；给画布窗口加能力先回答「画布被投毒以后这个能力能干什么」（I15）；PR 通报里点出新通道，让 yoyo 看得见（三个契约文件在 CODEOWNERS 里）。
- 出自：AGENTS.md I3、I5、I15、T1。

### R12 客户看得见的字

- 触发：文件 `src/renderer-v2/**/*.tsx` `src/renderer-v2/**/*.ts` `!src/renderer-v2/**/*.test.*` `!src/renderer-v2/**/*fixture*` `!src/renderer-v2/testing/**` `!src/renderer-v2/features/video-studio/**`，改动行含 `['"\x60>][^'"\x60<>]*[一-鿿]`
- 查什么：改完的字逐字贴给 yoyo，等他回「改」再合（画布、视频剪辑除外），等字的 PR 先不开自动合并；动了版面的配一张截图（`scripts/audit/v2-page-screenshot.mjs`，写明是 Chromium 里截的）；不出现站点名、Sub2API、PATH、npm、TOML、环境变量这类词，「Key」叫「密钥」，主语用「当前账号」，跑一遍 `npm run check:wording` 看新字有没有命中。
- 出自：项目规矩，`docs/COLLABORATION.md` §7.5。

### R13 账号后端对接

- 触发：文件 `electron/new-api-*.ts` `electron/sub2api-*.ts` `electron/realm-account*.ts` `!electron/**/*.test.ts`
- 查什么：端点、字段、请求头对照 `docs/RECON-new-api.md`，别按上游文档想当然；动手前先读两边后台的源码核实；测试一律注入假 fetch，不对线上账号站发真请求；`sub2api-relay-backend.ts` 不改，服务端不动。
- 出自：AGENTS.md T12：改密码要带 `original_password`，线上 rc.40 起还要先 `POST /api/verify` 换一次性凭证放进 `X-Security-Proof`；`GET /api/token/` 只回掩码的密钥。

### R14 提权、可信路径、原子写入

- 触发：文件 `electron/command-runner.ts` `electron/windows-elevation.ts` `electron/windows-machine-paths.ts` `electron/trusted-temp.ts` `electron/safe-local-data.ts` `electron/bounded-*.ts` `electron/relocated-folders.ts` `electron/config-files-context.ts`
- 查什么：照 AGENTS.md 第 4 节逐条对 I1、I2、I8、I9、I14；`unsafeKeys`、`unsafePrefixes` 只加不减；放宽任何一条要 yoyo 亲手打字同意；Windows 专属的设计由 yoyo 或 Claude·win 主导，云端只审（`docs/COLLABORATION.md` §7.2）。
- 出自：AGENTS.md 第 4 节：每一行防御代码对应一个具体攻击，破坏了不报错，只会静默变成漏洞。

### R15 安装程序、卸载

- 触发：文件 `build/installer.nsh` `electron/uninstall-cleanup*.ts` `electron/login-launch.ts` `electron-builder.config.cjs` `scripts/windows-installer-package-entries.cjs`
- 查什么：卸载冒烟（quality 里按改动自动跑，作业名 `uninstall-smoke / …`）全绿才合；卸载永远不删密钥，分不清是不是星芒装的工具不删；开着加速卸载要先还原系统代理。安装清单只记安装包自己带的顶层条目（打包时按 win-unpacked 现场列，别写死，也别改回「目录里看到的都记」），客户自己放进安装目录的文件升级、卸载都不动（D05）。
- 出自：yoyo 定的卸载规矩（不删密钥）；`docs/WINDOWS-ACCELERATION-RECOVERY.md`；卸载冒烟每一段的来历写在 `.github/workflows/windows-uninstall-smoke.yml` 开头。

### R16 测试里等落盘、等时间

- 触发：文件 `electron/**/*.test.ts` `src/**/*.test.ts` `src/**/*.test.tsx` `e2e/**` `scripts/*.test.cjs`，改动行含 `vi\.waitFor` `readdir` `useFakeTimers` `advanceTimersByTime` `Date\.now\(\)`
- 查什么：等的东西后面有真落盘（原子写）时，等写盘本身，别靠 `vi.waitFor` 默认的 1 秒，也别数目录（会数到 `.tmp`）；假时钟只在被测代码真在等的时候拨；拿 `Date.now()` 造的时间别撞上零点；期望的路径用 `path.join` 拼，别写死斜杠。本地复现写盘慢：在 `writeAtomicSafeFile` 写完后临时加 150 毫秒等待（别提交）。
- 出自：Windows CI 偶发红：#1540、#1551、#1827（等落盘）；#1798、#1801（假时钟）；#1809（零点）；#1807（路径分隔符）。详见 `docs/TEST-BASELINE.md`。

### R17 CI 工作流与门禁

- 触发：文件 `.github/workflows/**` `scripts/ci-change-scope.cjs`
- 查什么：新作业要不要进 `quality-gate`；按改动触发的作业，该跑却跳过要算红；被调用的工作流里 `github.workflow` 是调用方的名字，并发组别和调用方撞上；不读 secret 的作业不挂 environment。同一个 PR 里别放宽检查自己的那道门禁（删断言、删 gate 等的作业、删禁用表的行），放宽要 yoyo 亲手同意。
- 出自：#1524（2026-10-28）升级冒烟红着就合了：它是单独的工作流，`quality-gate` 看不见（CI-6）。
