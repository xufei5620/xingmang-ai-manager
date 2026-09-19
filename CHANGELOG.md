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
