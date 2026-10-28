> 统一审查报告的专项附件；固定源码基线为 c21be274，后续新增提交见 [最新增量复核](../latest-delta.md)。本页中的本地证据名称用于维护者对账，关键观察结果已在正文给出；完整受控材料不公开。

# 发布、更新、构建与测试流程复核

日期：2026-10-28。代码基线：`c21be2741af6674b2f422d9891b57fc3d2ba5b7b`。固定源码基线。

本专项只读源码、配置及测试，产物写在 `本地证据/xingmang-unified-audit-20261028`。没有修改产品、用户配置、注册表或服务器，没有启动安装、卸载、发布、上传、CI 或生产请求。主代理统一准备依赖、运行 typecheck/npm test；本文件不把旧测试结果算作本轮全套测试通过。

## 覆盖与证据范围

独占清单为 312 个文件、94,844 行；逐文件 SHA256 均与本轮 inventory 一致。`release-coverage.json` 记录每个路径的实际复核深度，不能把“文件已纳入清单”说成“所有行本轮重新通读”：

| 深度 | 文件数 | 实际含义 |
|---|---:|---|
| full-current | 26 | 本轮全文阅读 |
| reuse-full | 116 | 当前字节哈希等于旧快照，复用旧全文审阅 |
| reuse-text-identical | 5 | 原始哈希因换行不同；规范化换行后全文相同，复用旧审阅 |
| delta-plus-reuse | 1 | 旧全文审阅加本轮差异复核：Linux maintainer 补邮箱 |
| targeted-behavior | 8 | 测试结构及与问题、最新差异直接相关的测试正文 |
| targeted-structure | 154 | 测试/fixture 的导入、测试名称及关键调用索引；没有全文重读所有断言 |
| structured-data | 2 | 完整 JSON 解析及来源/类型核验 |

旧全文审阅基线是 `ffc0492263653aa5d7c085292892ab98d0e5ed3f`，旧证据目录为 `本地证据/xingmang-deep-audit-20261027-ffc04922`。当前变化与相关正文已重新核对。旧 `release-core-tests.log` 的 224 通过/2 跳过和 `release-installer-tests.log` 的 18 通过仅为历史证据；本轮完整测试结果由总报告单列。

额外 23 个下载页/随包文件由 root_docs 持有覆盖归属，本专项补审详情见 `本页下载页及随包文件补充段落` 和 `root-release-supplement-coverage.json`，不要与 312 个文件重复计数。

## 历史问题当前状态

| 旧编号 | 当前判断 | 优先级与界限 |
|---|---|---|
| 原 #7 | 仍存在，部分安装路径已有改善 | 更新忙碌判断仍只看安装队列，聊天/画布不在其中；不另算新问题 |
| D05 | 仍存在 | P2；升级后用户额外文件会进入下一次清理名单 |
| D23 | 仍存在 | P2；关闭自动更新后迟到检查仍可自动下载 |
| S01 | 条件性安全风险仍存在 | 高优先级；本地可写缓存的验证/使用间隙，不是远程投毒或 UAC 绕过 |
| T01 | 仍存在 | P2；开发影子目录可能仍写日常 Codex 配置 |
| T02 | 仍存在 | P2；发布校验在拒绝异常地址前已尝试请求；没有证实凭据泄露 |
| T03 | 仍存在 | P2，静态；下载页清单原地覆盖时断传，下载入口可能消失 |
| T04 | 仍存在 | P3；法律弹窗标题与迟到正文错配 |
| T05 | 仍存在 | P3；关闭邮箱验证后验证码栏仍显示 |

这九项对应的根因未在本轮基线修复。没有因旧证据仍可复用就声称真实安装、服务器配置、线上发布或三平台行为已重新实测。

## 原 #7：自动安装仍会忽略正在进行的聊天/画布工作

**当前位置**：`electron/main.ts:1555–1559`、`:1619`、`:2516`；`electron/auto-update-install.ts:210–215`。三处 busy 来源仍是 `resolveInterruptibleInstallTask(systemService.inspectInstallationQueue())`。安装队列为空时，聊天生成、画布生成并不使这个判断变忙。

**触发与影响**：已有验证好的更新，符合启动或空闲安装条件，而用户开始聊天/画布工作；检查仍可能把应用当作可安装并退出。现有延迟、通知、标准 Windows 账号限制和下载后等待确认改善了一部分路径，未补齐工作类型。

**证据**：本轮重新核对主进程调用点及实际 busy 参数；旧复核状态保持。安装决策测试覆盖安装队列/设置/窗口状态，不足以证明聊天和画布受到保护。新发现 U02 的“安装失败后画布无法再打开”由画布专项单列，不是本项的重复描述。

**修复方案**：集中收集安装、聊天、图像、视频、画布的活动任务；在最后安装交接前再次核对，用户主动确认的退出路径保留明确选择。

**验收**：各类任务分别启动，更新就绪不自动退出；任务自然完成才重新决策；通知等待期间新任务到来要取消本次安装；主动确认安装仍可执行。

## D05：升级会把用户额外放入的文件纳入软件清理名单

**位置**：`build/installer.nsh:219–244` 枚举当前安装目录的所有顶层条目写入 manifest；`:778–779` 每次安装调用；`:553–581` 后续升级/卸载按这个 manifest 移走或删除。

**触发与影响**：用户或管理员在安装目录额外放文件，首次升级旧卸载器正确保留了它；新安装随后把它登记为软件文件。下一次升级/卸载就可能删除这个本来应该保留的文件。受保护的安装目录意味着通常需要相应写权限，不是普通网页任意删除文件。

**证据**：当前脚本字节与旧全文审阅相同。旧 `release-manifest-repro-results.json` 用实际 NSIS 记录指令的内存解释验证：首次保留的 foreign file 被加入下一次 removal targets，没有真实卸载/删除。当前 `scripts/windows-installer-install-directory.test.cjs:98–114` 只钉注册顺序和调用，没测两次升级后的名单成员。

**修复方案**：从打包器已知的交付文件生成 manifest，只记录软件实际拥有的文件；旧名单迁移保持未知用户文件不动，不再把整个安装目录扫描成软件所有物。

**验收**：安装后加一个额外文件和目录，连续升级两次再卸载，用户文件仍在；旧软件自己的文件照常清掉，失败回滚不丢原文件。

## D23：关掉自动更新，迟到结果仍会启动下载

**位置**：`electron/updater.ts:2031–2034`。挂晚到回调时读取一次 `autoDownload()`，回调真正运行时没有再读当前开关。

**触发与影响**：启动检查超时→用户关闭自动更新→旧检查返回“有新版”→开始下载。影响流量、磁盘与设置可信度；不把打断工作重复计入原 #7。

**证据**：本轮重读 `2017–2044`、`2060–2086` 和测试 `electron/updater.test.ts:190–252`；当前仍没有 ON→OFF 的迟到结果守卫。旧 `release-repro-results.json` 的 `lateDownloadAfterDisable` 为 `startupTimedOut=true`、`autoUpdateBeforeLateReply=false`、`downloadsAfterDisabled=1`，实际 service 配 mock 客户端，无真实下载。

**修复方案**：晚到回调运行时重新读取自动更新设置及生命周期；关闭开关时使旧自动下载意图作废，显式手动下载单独保留。

**验收**：迟到结果前关闭开关，下载次数为 0；手动点击或之后重新开启应按规则下载一次；dispose 后晚到结果无副作用。

## S01

此安全条目已纳入 [公开状态与验收目标](../security-status.md)。详细触发条件、定位与受控复现保留本地，按仓库安全策略不随公开 PR 发布。

## T01：开发影子目录没有覆盖 Codex 的专用目录变量

**位置**：`scripts/dev-shadow-home.ps1:38–45` 设置 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/npm prefix，但保留继承的 `CODEX_HOME` 和 `XINGMANG_CODEX_HOME_OVERRIDE`；`electron/codex-home.ts:63–75` 专用变量优先。

**触发与影响**：开发者已有这两个变量之一指向日常配置，然后使用影子启动脚本；界面以为在隔离环境，Codex 配置仍可能写到日常目录。这是开发隔离缺陷，不是所有普通客户默认触发。

**证据**：本轮全文重读脚本。旧 `platforms-shadow-home-result.json` 用真实目录解析函数和纯环境 mock 验证两种继承变量均选择日常目录；无真实用户文件写入。脚本已说明 app userData 不隔离，不把该已知设计再次算新问题。

**修复方案**：将两种 Codex 专用目录变量明确设置到影子目录；启动前用同一解析规则断言最终目录属于该影子根。

**验收**：无变量、分别继承两种变量、同时继承、含空格路径均落在影子目录；前后日常配置内容不变。

## T02

此安全条目已纳入 [公开状态与验收目标](../security-status.md)。详细触发条件、定位与受控复现保留本地，按仓库安全策略不随公开 PR 发布。

## T03/T04/T05：下载页三个旧问题

三项当前源码均与旧快照 SHA256 相同，故仍存在。完整位置、触发、修复方案与验收见本轮 `本页下载页及随包文件补充段落`：

- **T03**：发布脚本 `scripts/publish-dl-landing.cjs:653–656` 原地 SCP 覆盖活动 latest.json，失败清理只针对本地临时目录；清单坏掉时 app.js 的下载区为空。修为远端临时文件核对后原子换名，固定下载入口不依赖元数据成功。
- **T04**：`dl-landing/app.js:445–465` 请求没有代次守卫，旧正文可盖掉新弹窗。修为标题/内容绑定请求代次，关闭立即作废。
- **T05**：`dl-landing/index.html:130` 的 hidden 被 `styles.css:194–201` 的 display:grid 覆盖。修为明确的 `[hidden]` 样式并做 computed display 回归。

T03 为静态故障路径结论，本轮未做真实传输、服务器断网或浏览器展示测试；T04/T05 同样不是线上验证。

## U03：浏览器启动失败，测试辅助服务没有被关闭

**优先级**：P2，测试/开发流程，不是客户桌面运行故障。

**位置**：`e2e/harness.mjs:216–220` 先启动 Vite 服务再启动 Chromium；`:255–267` 在进入 try/finally 前就 await fixture.start，失败时不会进入 stop。

**触发与影响**：Chromium 缺失、文件损坏或 launch 失败时，测试报告失败但已开启的服务没有关闭；真实监听句柄可能让 npm test 持续存活，直到外部超时才结束。`e2e/account-commerce-interactions.test.mjs:9` 等使用此 helper，属于正常验证入口可达路径。

**当前实证**：`release-harness-start-failure-repro.cjs` 把实际 harness 放入 VM，只替换 Vite/browser/端口探测。`release-harness-start-failure-result.json`：serversStarted=1，serversClosed=0，browsersAttempted=1，testBody=0；真实服务、浏览器、网络请求均为 0。直接证明清理遗漏；真实 CI 挂起时长未测。

**修复方案**：start 自身在部分启动失败时回滚已取得资源；withBrowserFixture 把 await start 放入 try/finally。stop 在 browser.close 失败时也应保证 server.close，保留原始错误。

**验收**：模拟 Chromium launch 抛错，服务恰好关闭一次且测试主体不运行；测试主体抛错仍清理；浏览器关闭失败仍关服务；正常和重复 start/stop 无残留。

## U04：脚本生图在收到响应头后提前取消超时

**优先级**：P2，只影响随包 `generate.mjs` 脚本调用；当前 MCP 实现没有此缺口。

**位置**：`bundled-skills/xingmang-ai/scripts/generate.mjs:229–234`、`:260–264`、`:310–314`。三个路径都在 fetch 收到响应头后 clearTimeout，之后才读取响应体。

**触发与影响**：用户没有 MCP 或需要指定输出文件时走脚本；上游先发响应头，之后慢传或挂起，脚本失去应用层 300 秒总时限。慢传可让命令远超五分钟仍持续等待，最终只能依赖底层网络/外部命令超时或用户中断。32MB 体积上限不限制耗时。没有对真实付费调用做复现。

**当前实证**：`release-image-timeout-repro.cjs` 使用实际源码，假 fetch/流/计时器。JSON 生成、multipart 改图和图片下载三个 case 在响应体等待期 activeTimeouts=0；推进全部计时器后仍 pending，signal 未 abort。MCP 对照 `mcp-server.mjs:278–294` 保留一个 timer，推进后 abort 并返回超时错误。结果见 `release-image-timeout-result.json`，真实网络/生成均为 0。`scripts/xingmang-image-mcp.test.cjs:349–391` 现有脚本 helper 立刻 res.end，未覆盖慢响应体。

**修复方案**：把响应状态校验和完整 body 读取放在与 fetch 同一个 try/finally 中，全部读完或失败后才清 timer；读取失败/超限时取消 reader；避免超时后自动重提付费请求。

**验收**：三个路径分别模拟响应头及时返回、body 永不结束或缓慢分段返回，推进总预算后必须报超时并停止读取；预算内成功正常落盘；超限立即拒绝；MCP 的当前保护不得退化。

## 本次文档 PR 的验证流程与依赖前提

1. **文档过滤不是按目录一概豁免**：`scripts/ci-change-scope.cjs:4–10` 只认可名单中的根文档及 `docs/**/*.md`。JSON/CSV 放 docs 仍触发代码矩阵，所以机器清单留 H 目录，PR 只放报告 Markdown。
2. **两个特殊文档**：`docs/CANVAS-THIRD-PARTY.md` 明确要求代码检查；`docs/CLI-VERIFIED-VERSIONS.md` 触发真实 relay probe。本次报告不应无故改动这两份控制文档。变更范围无法确定时默认跑全部。
3. **纯 Markdown PR 仍跑的门禁**：quality.yml 的 changes 作业执行 `npm run changelog:check`（`:74–75`），secret-scan 作业和汇总 gate 继续执行；代码/打包作业按 scope 标为 skipped。`test`/quality-gate 会核验预期状态，不能把正常 skipped 说成测试通过。合并到 main 的 push 根据 `ci-change-scope.cjs:118–119` 始终跑代码矩阵。
4. **依赖准备**：根 `npm ci` 安装 React19 主工作区和 `tooling/legacy-renderer` React18；postinstall 的 `scripts/patch-builder-fetch-compat.cjs` 不应跳过。canvas 有自己的依赖准备。CI/.nvmrc 为 Node22，锁内 Vite 等要求至少 22.12；本机 Node24.13 满足 engines，但不与 CI 主版本相同。
5. **Electron/Chromium**：测试需要 Electron43.8.3 的完整 dist 与 path.txt；当前 Electron npm 包首次 require 可能触发下载，不应在离线复核时盲目执行下载准备脚本。浏览器测试须有匹配 Playwright1.62.0 的 Chromium，或经 `XINGMANG_E2E_CHROMIUM` 指向已存在的可用程序。找不到浏览器是验证未完成，不能按“环境原因”算通过。
6. **提交前门槛**：按 AGENTS 统一跑 `npm run typecheck`、`npm test`；本次未改 renderer-v2，不自动追加其界面变更门槛。统一结果见 [验证记录](../validation.md)，本专项没有重复启动全套测试、系统 smoke 或 secrets/发布脚本。

锁文件结构检查发现 527 个 package 条目、524 个远程来源均为 registry.npmjs.org HTTPS 且有 integrity，没有来源异常；这只是本地锁文件核验，不能代替联网漏洞扫描。证据为 `release-structured-data-result.json`。

## 修复顺序建议

先处理 S01 的受保护安装交接和 D05 的用户文件保留，再处理原 #7/U02 的安装退出工作保护；D23、U04 与发布原子替换随后完成。U03/T01/T02 为开发和发行流程修复，可独立成小 PR。T04/T05 可一起做下载页展示回归。每项只要求其明确触发的验收，最终仍遵守项目提交门槛。


# 下载页及随包文件补充复核

日期：2026-10-28，基线 `c21be2741af6674b2f422d9891b57fc3d2ba5b7b`。这 23 个路径仍归 root_docs inventory，本文件是 release 专项补充，不重复计入 release 的 312 文件覆盖。

`root-release-supplement-coverage.json` 记录当前 SHA256、实际行数与深度。23 个文件均与 `ffc0492263653aa5d7c085292892ab98d0e5ed3f` 旧快照字节相同。其中下载页 app/index/styles/preview 四个文件复用旧全文审阅并重新读取旧问题段落；15 个随包脚本、配置、说明本轮全文读取；models.json 完整解析并核对 README 固定哈希；logo 仅 PNG 头与字节身份核对；用户协议和 Apache LICENSE 仅来源/引用/字节身份，不作法律效力判断，也不声称全文审阅。

## T03：清单发布失败时可能没有下载按钮——仍存在

- **代码**：`scripts/publish-dl-landing.cjs:653–656` 把本地 latest.json 直接 scp 到活动路径；`:678–681` 失败清理只有本地临时目录。`dl-landing/app.js:341–367` 必须成功解析清单才填下载按钮；`index.html:52`、`:166` 初始下载容器为空。
- **触发**：上传 latest.json 已开始覆盖后断线；活动文件可能被截断或只写一部分。
- **影响**：访客能打开页，下载区却只提示稍后提供，注册后也没有下载按钮。当前真实按钮本身指向固定教程 URL（app.js:328），仍被清单加载成功门槛挡住。
- **证据边界**：当前生产脚本/消费者与旧审阅完全一致，重新阅读了失败分支；没有真实 scp、断网、发布或源站验证。判定 P2 静态故障路径。
- **方案**：远端唯一临时文件上传完成、内容核验后同目录原子改名；保留可恢复旧清单；固定下载入口先显示，版本元数据独立加载。
- **验收**：模拟传输中断、校验失败、换名前失败，旧活动清单保持有效；损坏清单时浏览器仍有可用的教程下载入口。

## T04：法律弹窗显示错正文——仍存在

- **代码**：`dl-landing/app.js:445–459` 用共享标题/正文接收多个未设代次的异步请求；`:463–465` 关闭只设 hidden。
- **触发**：先开用户协议，未加载完就关掉并开隐私政策；隐私正文先完成，旧用户协议后完成。
- **影响**：弹窗标题是隐私政策，正文变成用户协议；无需服务端故障。P3，文档展示一致性问题。
- **方案**：请求绑定 kind/epoch，关闭和重新打开时作废旧请求；成功和错误回调都复核当前代次。
- **验收**：deferred fetch 控制相反完成顺序；标题、正文、错误必须属于最后打开的文档，关闭后旧请求不改变新弹窗。

## T05：不用验证码时仍显示验证码栏——仍存在

- **代码**：`dl-landing/index.html:130–137` 带 class=field 和 hidden；`app.js:544–549` 依后台开关更新 hidden；`styles.css:194–201` 的 display:grid 覆盖浏览器 hidden 样式，`:189–192` 只为其他元素补隐藏规则。
- **影响**：后台关闭邮箱验证后，访客仍看到验证码输入和获取按钮。提交校验/载荷已按开关跳过，不是验证码绕过漏洞。P3。
- **方案/验收**：给该行明确 `[hidden] { display:none }` 或统一隐藏契约；浏览器断言后台 false 时 computed display=none、true 时可见，并检查表单提交不要求关闭的验证码。

## U04：脚本生图的响应体超时缺口——本轮新增、已离线确认

`bundled-skills/xingmang-ai/scripts/generate.mjs:229–234`、`:260–264`、`:310–314` 在收到响应头后就清 300 秒定时器，随后 body 读取不受应用总预算控制。用户在 fallback 或需要指定输出路径时会走这个脚本，上游慢传可令命令远超五分钟等待；不将底层 HTTP 可能存在的其他超时说成永远无超时。

本轮全文读完 generate.mjs 和 mcp-server.mjs，并做纯 VM 实证：三条脚本路径等待 body 时没有活动超时，推进计时器后仍 pending；MCP 对照在 `mcp-server.mjs:278–294` 把 body 读取放在同一 try/finally，正常 abort。`release-image-timeout-repro.cjs` 和 `release-image-timeout-result.json` 保存证据。真实网络和生成次数均为 0。

**修复/验收**：fetch、状态处理、body 读取共用总预算，全部结束才清 timer；在生成、改图、下载三个路径分别测试响应头快而 body 慢/挂的情况；超时停止读取且不自动重提交付费请求。MCP 保持现有保护。完整说明见 `本页发布专项段落` 的 U04。

## 其他随包文件的核对

- `bundled-catalog/cli-hooks/xingmang-hook.cjs` 本轮全文读完：事件类型和会话编号白名单、输入体积上限、五秒输入超时、临时文件再改名。没有调用真实 CLI 或写用户事件目录。
- `bundled-catalog/cli-status-line/xingmang-statusline.cjs` 本轮全文读完：只读 stdin、展示 model/cwd/context，不出网不读 Key；没有将未验证的上游协议变化视为产品缺陷。
- `bundled-skills/xingmang-ai/scripts/mcp-server.mjs` 本轮全文读完：origin 限制、输入图片数量/尺寸/内容验证、手工拒绝重定向、响应体上限与总超时均核对。它在客户端外部进程中运行，不等于隔离画布的 IPC 能力。
- `bundled-catalog/curated-extensions.json` 本轮全文读取：10 项 catalog 的固定版本/marketplace commit、参数模板和提示边界已核对；没有在线检查 npm/GitHub 当前是否可下载，也没有实际安装第三方扩展。
- `bundled-catalog/codex-models/models.json` 实际 SHA256 为 `943ca7fe1d19ed019054158303f0dbbd80b3bef43b3aa425a71aa7cb3fb52c2b`，与随包 README 声明相同；没有在线校验上游 tag 或运行 Codex。
- `dl-landing/nginx/*.conf.example` 及 README 全文读完：均为占位模板，注册相关三个精确接口、其余 API 拒绝及 files/SPA 分流边界已读。本轮不能推断服务器真的装用了这些模板或已替换正确值。

未执行任何生成、MCP 启动、CLI hook、发布、SSH、nginx reload 或外网请求；没发现足够证据支持把其他猜测再列成新缺陷。
