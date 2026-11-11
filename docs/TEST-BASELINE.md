# 测试基线：Windows 是否全绿取决于机器环境

> 从 `AGENTS.md` 第 2 节搬出（2026-09-18）。行号引用已换成符号名，其余内容未改。

**只有在 Windows 上、且怀疑基线不稳时**，才需要改动前先跑一遍记下失败数，改完对比；Linux / CI 直接跑改后的即可。已知失败全部与环境相关，**不是你弄坏的**：

| 平台 | 已知失败 | 原因 | Issue |
|---|---|---|---|
| **Windows** | **0** | 需要 `SeCreateSymbolicLinkPrivilege` 的 12 条（`safe-local-data` ×5、`runtime-log` ×2、`startup-log` ×2、`backups`、`path-identity`、`relocated-folders`）已按能力门控，没有该特权时跳过而非 EPERM 失败；原先那 5 条 5s 超时已随 `test:vitest` 的 `--testTimeout=30000` 消失 | **#40** |
| **macOS** | 0 | — | — |
| **Linux** | 0 | 原 `samePathIdentity` 误删缺陷已修复：launcher 文件清理现走 `terminal-launcher-files.ts` 的 `sameFileIdentity`（追加 size/nlink/mtime/ctime 比对，macOS 与 Linux 共用） | #2 已关闭 |

遇到超时类失败先原样复跑一遍 `npm test`（它已经是串行 + 30s 超时）。符号链接那 12 条默认跳过；想在本机真跑，开启 Windows 开发人员模式或以管理员身份运行即可，`electron/symlink-capability.test-support.ts` 会自动探测到。#40 已关闭；基线与上表不符请新开一个 issue（标 `area:test` 和对应的 `env:*`）。

## Node 版本：本机必须跟 CI 一致（22）

仓库根的 `.nvmrc` 钉的是 **22**，和 `quality` 工作流一致。用别的大版本**可能连测试都跑不完**。

已知一例（2026-10-08 本机实测）：**系统 Node v24.13.0 上，`fs.rmSync(目录, { recursive: true, force: true })`
删一个「中文名 + 非空」的目录会让进程当场 fail-fast abort**（`0xC0000409` STATUS_STACK_BUFFER_OVERRUN），
既不抛异常也不返回。表现是 `electron/provider-sessions.test.ts` 的 worker 无声死掉：

```
Error: [vitest-pool]: Worker forks emitted error.
Caused by: Error: Worker exited unexpectedly
 Test Files   (1)          ← 整个文件 43 条一条都没算进去
```

汇总行会少一个文件（`574 passed | 6 skipped` 但总数 `(581)`），而 vitest 退出码是 1 —— 哪怕 0 个失败。

- 触发条件要三样同时满足：中文名、目录非空、`recursive: true`。`café` 不崩，空的中文目录不崩，
  `unlink` + `rmdirSync` 不崩；三个盘都崩，不是盘的问题。
- **产品不受影响**：客户端跑在 Electron 43.6.0 自带的 Node **24.20.0** 上，同一个探测在它上面正常。
- **CI 不受影响**：固定 Node 22。
- 解法就是把本机 Node 换成 22。不要去改那条用例——它测的是「工作目录被删掉后还显不显示『接着聊』」，
  中文目录名正是客户的真实场景。

## CI 的 Windows 分片：丢导航，不是慢

本机基线之外还有一条只在 CI 上出现的：`quality` 工作流的 `windows-test (renderer-v2-browser-1)` 到
`(renderer-v2-browser-3)` 三片（2026-10-06 先拆两片、当天又拆三片，之前是一片 `renderer-v2-browser`）偶发单条用例红。
**判定方法是看形状，不是看名字**——挂的用例每轮都不一样，但形状固定：

| 指纹 | 含义 |
|---|---|
| `... did not finish installing within 90000ms after 3 navigations` | 三次导航都没把夹具挂起来 |
| `Timeout 30000ms exceeded` + 等的是夹具首个元素 | 还没接共享预算的套件，页面没挂上来 |
| `page.goto: net::ERR_NO_BUFFER_SPACE`，`duration_ms` 只有几十毫秒 | 用例体一行都没跑，socket 直接要不到 |

2026-09-19 至 09-21 的 196 轮里这个分片 141 次完整跑挂了 14 次（9.9%）；同期十轮绿跑最慢的
用例 22.4 秒，超过 30 秒的一条都没有。**所以预算从来不是瓶颈，丢掉的是那一次导航。**
处置已经写进代码，不用再靠重跑：`e2e/fixture-readiness.mjs` 的 `openFixturePage()` 把 90 秒
总预算拆成最多三次导航共享一个截止时间，挂载没落地就重新导航并在 stderr 写明第几次、花了
多久、为什么。**不要调大 `XINGMANG_FIXTURE_READY_TIMEOUT_MS` 来回避这条**，绿跑用不到它的
四分之一，调大只会让真坏掉的夹具更晚红。

现在 renderer-v2 的各个浏览器套件（含 `features/acceleration`、`features/shell`）都已接上
`openFixturePage`。仍遇到上表第二行的形状，按原样重跑一次；连着两轮同一处才当真。

整步超时是另一回事：日志末尾是 `The action 'Run the renderer-v2-browser-N shard' has timed out
after 18 minutes.`，前面的用例全过。那是机器慢（#873 那三次，每条用例都按差不多同一个倍数变慢）
加上用例越写越多。处置是在 `package.json` 里多加一份 `test:v2:browser:fixture:N`、各份
`XINGMANG_TEST_SHARD` 的分母跟着改、`quality.yml` 的矩阵多派发一片，不是调大上限，也不是重跑了事。
Linux 的 `linux-renderer-v2-browser` 也是这样拆的（`test:v2:browser:fixture:linux:N`，按 Linux 上的实测耗时分文件），
它没有单设步骤上限，作业上限 30 分钟；逼近了同样多加一份。

### 顺带纠正一条流传已久的说法：CI 上的 Defender 与此无关

本文件上表里 Windows 那一行说的「Defender 实时扫描」讲的是 **yoyo 自己的 Windows 机器**，
对 GitHub 托管的 runner **不成立**。quality run 35548878416 在两个 Windows 作业里打印了
`Get-MpPreference`，实测 windows-latest 镜像**出厂就把整个 `C:\` 和 `D:\` 放进了 Defender
排除列表**。所以再给工作目录加排除项是纯仪式，已经试过并撤掉了（`ci-workflow-config.test.cjs`
有一条门禁钉住不许再长回来）。仓库里若干处「Defender 下冷启动慢」的注释对 CI 而言是民间
传说，排查 CI 不稳时不要从那里起手。

## CI 上重跑就过的两条（2026-11-11 查）

按规矩同一个失败只重跑一次；下面两条都是第一轮红、重跑一次绿，跟当时 PR 的改动无关。再见到
同样的指纹先对这里。

### 假时钟下载的「到点放弃」那条：已修

| 项 | 内容 |
|---|---|
| 用例 | `electron/git-runtime-install.test.ts` › Git download deadline › still gives up on each source at the ceiling |
| 指纹 | `windows-test (vitest-2)`，`expected 3800000 to be less than 3640000`（quality run 43011123157 第一轮，PR #1794） |
| 根因（本机复现过） | 见下 |

这条用假时钟把两段各 30 分钟的下载压成一两秒跑完。`electron/slow-download.test-support.ts` 的
`drive()` 只在被测代码「在等下一块数据」时把时钟拨 40 秒，别的时候（写盘、关文件、删半截文件、换源）
应该照真实时间等它做完。但以前这个「等」最多 10,000 轮事件循环，等不完就照样拨。Windows runner 上
关文件、删文件偶尔比这 1 万轮慢，时钟就在代码还在磁盘上时多走了 5 格（16 万毫秒），断言当然红。
本机让删半截文件慢 0.3 秒，就能稳定红出同一个形状。

修法：只有「没有文件操作在进行」的那些轮才算进 1 万轮（看 Node 的 `process.getActiveResourcesInfo()`
里有没有 `FSReqCallback`、`FSReqPromise`、`CloseReq`）。磁盘再慢也不会让假时钟走；1 万轮的上限只留给
它本来要管的那一种情况：被测代码在等别的假定时器。被测代码和断言都没动、时限没调大，红的那 16 万毫秒是
测试驱动自己拨出来的，所以这是修测试的写法，不是迁就代码。`electron/slow-download.test-support.test.ts`
钉住三件事：这三个名字（以后升 Node 改了名会在这里红，而不是悄悄变回偶发）、磁盘连着忙 1.5 万轮时钟也不走、
等自己的假定时器时钟照样走。用同一个驱动的 `python-runtime.test.ts` 两条（只在 Windows 上跑）一起受益。

同一个毛病还有一处没修：`electron/node-runtime.test.ts`「gives up at the ceiling and removes the partial package」
（指纹 `expected 760000 to be 1800000`）用的是它自己的 `driveChunkByChunk`，也是每块最多等 1 万轮就接着拨。
修它另开一个 PR，照这里的办法用 `fileOperationInFlight()` 只数磁盘闲着的轮次即可。

### MCP 页点「自定义连接」超时：没坐实

| 项 | 内容 |
|---|---|
| 用例 | `e2e/v2-business.test.mjs` 里 adding a uvx connection without Python… 和 a uvx connection missing uv… 两条，连着红 |
| 指纹 | `windows-test (renderer-v2-e2e)`，都是 `locator.click: Timeout 5000ms exceeded`，等的是 `getByTestId('mcp-add')`，调用日志停在最后一行 `performing click action`（quality run 42992280184 第一轮，PR #1756） |
| 结论 | 根因没坐实，没改代码 |

已经排除的：

- **不是页面没挂上**：两条都在 0.9 秒内挂好，按钮已经找到、可见、可点、位置稳定，日志里也没有
  `[fixture] … lost navigation`。
- **不是被别的东西挡住**：被挡住时 Playwright 会写「intercepts pointer events」并自己重试。这里是卡在点击
  本身：鼠标事件发出去以后，那一页一直没回应。
- **不是这一步本来就慢**：抽了 14 轮绿的 Windows 记录，这两条每次 0.9–2.7 秒，跟整套用例的中位数同比例，
  没有一次接近 5 秒；本机把 CPU 降到八分之一速度点这颗按钮也只要约 0.5 秒（开弹框那一下最长 0.4 秒），
  要再慢几十倍才撞得到 5 秒。
- **不是这颗按钮或这一页固定会卡**：同一轮里紧接着的 curated MCP install（同一页，也开弹框）1.7 秒过；
  9 秒后 the add dialogs name the tool they add to… 点的正是同一颗 `mcp-add`，也过了。

推测（没坐实）：两条用例各自新开的页面，在同一段大约 12 秒里点击都没回应，过后又好了，更像那台 runner
上浏览器的输入通路卡了一阵，不像页面代码的问题。再见同样指纹先按规矩重跑一次；如果同一处再红，或者别的
用例也停在 `performing click action`，就不是偶发，那时要抓现场：失败时截图，并在页面里跑一句
`page.evaluate(() => 1)` 看它还回不回应，分清是这一页卡住还是整个浏览器卡住。

> 云端/CI 容器提示：`test:browser`、`test:v2:browser` 里的 Playwright 套件要真浏览器，若容器预装的 Chromium 版本号与 `@playwright/test` 期望不符会报 "Executable doesn't exist"——环境问题不是回归，但也不算跑过：按 `AGENTS.md` 第 3 节设 `XINGMANG_E2E_CHROMIUM` 指向容器那份 Chromium 重跑，照样要 0 失败（scripts 套件不受影响；vitest 里只有 `electron/codex-desktop-cdp.browser.test.ts` 起浏览器，它也认这个变量）。Claude Code 云端容器里是 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium npm test`（`npm run selfcheck` 会自己设上，容器里别的坑见 `docs/CLOUD-SANDBOX.md`）；只复跑一条用例时用 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium node --test --test-name-pattern=<用例名> <套件文件>`。

> 底线：**不要引入新失败**。
