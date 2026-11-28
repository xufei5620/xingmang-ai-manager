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

> 2026-11-17 起，每一次「重跑才过」都在 `docs/CI-RERUN-LEDGER.md` 记一行，同一条两周内第二次必须查根因、不许再重跑（yoyo 定的「记账」）。这一节和下面几节记的是查清了什么，那份记的是账。

同一天还有一条早就查清的：`upgrade-smoke` 的 `windows-upgrade (0.2.19)` 报「新版本没有记下『本次启动是更新后的第一次』」
（10-31 #1565、11-11 #1748）。是冒烟查得太早，`version.updated` 那行比 `last-run-version.json` 晚落盘；#1771 已经让它等最多 30 秒。
分支要是停在 #1771 之前的 main 上，重跑旧提交还可能红，先把分支合进最新 main。合了以后再红，报的会是「等了 30 秒…」，那才去查产品。

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

同一个毛病的另一处也修了：`electron/node-runtime.test.ts`「gives up at the ceiling and removes the partial package」
（Windows `vitest-1`，指纹 `expected 760000 to be 1800000`，10-26 #1413 红过一次）用的是它自己的 `driveChunkByChunk`，
每拨一格最多等 1 万轮让那一块落盘，等不满就接着拨。写盘慢时连着几格没算上进度，3 分钟没进展那道先到，报的是
「安装包下载超时」，时间却停在 76 万毫秒。本机让每 4 块里有一块写盘前卡 0.3 秒，旧写法红成
`expected 1040000 to be 1800000`，同一个形状。现在它也只数没有文件操作在进行的轮次（同一个 `fileOperationInFlight()`），
同文件里加了一条「磁盘连着忙 1.5 万轮，拨完第一格就不再拨」，旧写法上红成 `expected 80000 to be 40000`。
它没换成上面那个共用驱动：两边判断「该拨了」的条件不一样（这边看收到的字节数，那边看响应体在不在等下一块），
这条的断言又是正好 30 分钟，换驱动是另一件事，这里只改计数。

### 点击停在 `performing click action`：卡住时自己留现场（根因待下一次现场）

| 项 | 内容 |
|---|---|
| 第一次 | 11-11 PR #1756，quality run 42992280184：`e2e/v2-business.test.mjs` 的 adding a uvx connection without Python… 和 a uvx connection missing uv… 连着红，点 `getByTestId('mcp-add')` 超时 5 秒 |
| 第二次 | 11-20 PR #2003，quality run 44742552348：`e2e/v2-local-avatar.test.mjs` 第一条 crops a local image to a 256px PNG…，点「更换头像」超时 7 秒 |
| 第三次 | 11-20 PR #1949，quality run 44741601202：同一条头像用例，同样点「更换头像」超时 7 秒，比 #2003 早 5 分钟（13:24 对 13:29 UTC），不同的 runner |
| 第四次 | 11-20 PR #2011（只改主进程），quality run 44753304773：还是这条头像用例、同样超时 7 秒，14:31 UTC |
| 指纹 | 都在 `windows-test (renderer-v2-e2e)`；调用日志里按钮已找到、可见、可点、位置稳定、滚动完，最后一行停在 `performing click action` |
| 结论 | 四次日志都分不出是哪一半停了，根因没坐实；`e2e/click-stall.mjs` 让下一次自己留下分得清的现场 |

四次的共同形状：**一段大约 10 秒的卡顿，不只卡这一条**。11-11 两条用例各开各的页面，从 09:08:59.6 到 09:09:10.5
都点不动，过后同一颗 `mcp-add` 又点得动；11-20 #2003 那条卡满 7 秒，紧接着下一条（新开的页面）用了 5.1 秒，
同一套用例绿跑时是 1.0 秒，再往后三条都正常（0.8 秒左右）；#1949 那条整条 14.0 秒（打开页面就比平时慢，
再卡满 7 秒），下一条 2.2 秒；#2011 那条整条 12.0 秒，下一条 3.6 秒。

11-20 三次都是头像套件的第一条（新起的浏览器、冷的 Vite 缓存），都是点下去要开弹框的那一下，打开页面都比平时慢
（5–7 秒，平时 3 秒上下）。前两次合并出来的提交都在 main 65350f7（#1996）上，runner 镜像和 Chromium 版本跟
12:55 那次绿跑一样；同一个底子上的重跑和别的 PR 都绿过（#2003 重跑 44744907491、#1949 44748220311、main c83d18a
44742755802），#2011 只改了主进程，碰不到这个页面。所以不是哪一次合并必然带出来的，但 13:00 到 14:30 UTC 之间
跑完的 PR 里三次红在同一处，频率明显比之前高。

已经排除的：

- **不是页面没挂上、不是被挡住**：按钮找到、可见、可点、稳定，日志里没有 `[fixture] … lost navigation`；
  被挡住时 Playwright 会写「intercepts pointer events」并自己重试，这里没有。
- **不是这一步本来就慢**：抽 14 轮绿的 Windows 记录，MCP 那两条每次 0.9–2.7 秒；本机把 CPU 降到八分之一
  速度点 `mcp-add` 约 0.5 秒。头像那条绿跑整条 4.5 秒（含冷启动打开页面）。
- **不是整个浏览器停了**：11-11 第二条用例的页面恰好在卡顿中间打开，0.9 秒挂好，挂载等待一直在
  `page.evaluate`，「位置稳定」那一步还要页面连着出两帧，都过了，然后点击才卡住。浏览器接命令、页面跑脚本、
  出帧都还在。
- **不是 Vite 冷启动中途整页重载**：本机（Linux）清掉缓存冷启动连跑头像那条，挂载后没有收到过 full-reload，
  点击 70–90 毫秒。

剩下两种可能，指向不同的地方，只有卡顿当时取的东西分得开：

1. **鼠标事件没送到页面**：Playwright 点击先发一次鼠标移动，Chromium 要等页面处理完这次移动才回话。
   浏览器的输入通路或者出帧在那 10 秒里停了，就是这一种。
2. **点下去了，页面之后不回话**：点击打开弹框，弹框那一路在等某个整机共用的东西，页面主线程被占住，
   Playwright 收尾时问页面的那一句就一直等。

本机把这个指纹做出来过：页面在鼠标移到按钮上时占住主线程 4.5 秒，点击就停在同一行（`e2e/click-stall.test.mjs`）。

**现在卡住时会留下什么**：经 `e2e/harness.mjs` 开的页面（两个 e2e 套件都是），点击超时且调用日志停在
`performing click action` 时，`e2e/click-stall.mjs` 当场并排探一遍（每项最多等 3 秒），结果接在这条报错后面，
截图放进 `artifacts/click-stall/`，Windows 作业红了会以 `click-stall-<分片>` 上传：

```
click stall evidence, taken 7004ms after the click started (each probe waits at most 3000ms):
- page.evaluate on the stuck page: answered in 3ms (open dialogs 1, focused yes, visible, active element button)
- next animation frame on the stuck page: drawn in 17ms
- a new mouse move sent to the stuck page: acknowledged in 21ms
- screenshot of the stuck page: artifacts/click-stall/1763645354000-4321.png (40ms)
- a fresh page in the same browser: opened in 120ms, clicked in 15ms, click landed
- Node event loop: longest delay 22ms while the click waited
- runner CPU: 41% busy over 500ms
```

怎么读：

| 看到的 | 说明 | 往哪查 |
|---|---|---|
| `page.evaluate` 没回话，同一浏览器新开页点得动 | 这一页的主线程被占住，别的页面没事（第 2 种）：点下去以后弹框那一路在等东西 | 截图、`open dialogs` 看点击到没到；查弹框打开时同步等的东西（字体、剪贴板、焦点） |
| `page.evaluate` 回话、`open dialogs 0`，新鼠标移动或新开页的点击也没回话 | 页面活着，鼠标事件送不进去，而且整个浏览器都这样（第 1 种） | 浏览器输入通路；再看 `next animation frame`，没出帧就是出帧停了 |
| `page.evaluate` 回话、新开页点得动，只有卡住那次没回话 | 那一次的鼠标事件丢了，之后又好了 | 记下来，攒够几次再看规律 |
| 整机 CPU 接近 100%，或 Node 事件循环延迟上秒 | runner 自己被占满，或者测试进程自己卡了，先别怪浏览器 | runner 上同时在跑什么 |

再见这个指纹：先把报错后面这几行和截图贴进 `docs/CI-RERUN-LEDGER.md` 那一行（照规矩只重跑一次），按上表查，
查清后把这一节改成结论。别的套件（`src/renderer-v2/**/browser-check.mjs`、`app-check.mjs` 自己起浏览器，
不经 harness）想要同样的现场，给它开出来的任意一个页面调一次 `watchClickStalls(page)` 即可，一个进程装一次就够。

> 云端/CI 容器提示：`test:browser`、`test:v2:browser` 里的 Playwright 套件要真浏览器，若容器预装的 Chromium 版本号与 `@playwright/test` 期望不符会报 "Executable doesn't exist"——环境问题不是回归，但也不算跑过：按 `AGENTS.md` 第 3 节设 `XINGMANG_E2E_CHROMIUM` 指向容器那份 Chromium 重跑，照样要 0 失败（scripts 套件不受影响；vitest 里只有 `electron/codex-desktop-cdp.browser.test.ts` 和 `electron/antigravity-desktop-chinese.browser.test.ts` 起浏览器，它们也认这个变量）。Claude Code 云端容器里是 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium npm test`（`npm run selfcheck` 会自己设上，容器里别的坑见 `docs/CLOUD-SANDBOX.md`）；只复跑一条用例时用 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium node --test --test-name-pattern=<用例名> <套件文件>`。

> 底线：**不要引入新失败**。

## 本地绿、Windows 分片红的路径写法（2026-11-12，#1807）

云端容器和 Mac 上都过、到 Windows `vitest-*`（或 `windows-test (node)`）才红的，多半是下面几种写法，写用例时就避开：

- **把显示出来的路径写死成斜杠**。手机遥控、诊断这类按本机分隔符显示路径（`remoteDisplayPath`、`redactHomeDirectory`），Windows 上是 `~\projects\demo`。期望值用 `path.join('~', 'projects', name)` 拼，别写 `'~/projects/demo'`。
- **临时目录用 `fs.realpathSync` 取，又跟被测代码报回来的路径比**。Windows runner 的 `os.tmpdir()` 是短名 `C:\Users\RUNNER~1\…`，`fs.realpathSync`（JS 实现）不展开，卸载这类按真实路径核过目录的代码报回来的是长名 `C:\Users\runneradmin\…`，`toHaveBeenCalledWith` 就对不上（#1975）。要比路径的用 `fs.realpathSync.native`，Mac、Linux 上两者一样。
- **用 `@electron/asar` 按 `a/b/c` 读 app.asar 里套了两层以上的文件**。它按 `path.sep` 切路径，Windows 上 `bundled-catalog/image-upscale/x.onnx` 会被当成一个叫 `bundled-catalog/image-upscale` 的文件夹去找，报「was not found in this archive」；只套一层的 `dist-electron/main.js` 碰巧能过。交给 `extractFile` / `statFile` 前先 `relativePath.split('/').join(path.sep)`（`verify-packaged-hardening.cjs` 的 `archiveEntry`，#2217）。本地复现：让 asar 的 `lib/filesystem.js` 拿到 `path.win32`（用 `Module._load` 只替它换掉 `path`）。
- **服务里写死了 `platform: 'darwin'`，又拿真文件夹去撞路径规矩**。`codex-remote-service.test.ts` 的 `setup()` 缺省按 darwin 起服务；Windows 上真文件夹是 `C:\…`，按 darwin 的规矩不算绝对路径，「主目录不能当干活的文件夹」这类拦截根本不触发，用例期望的报错就不来。要验拦截的那条传 `setup({ platform: process.platform })`，跟直接测 `validateRemoteWorkspace` 那条一样按本机规矩。

## 看落盘的文件，要等写盘本身（2026-11-12）

`safe-local-data` 的原子写先写 `.<文件名>.<uuid>.tmp`，写完、刷盘再换名。用例要是等的是写盘之前的某一步（比如手机遥控的假渠道「取过图」`FakeImageChannel.fetched`），接着就去数目录，Windows 上写得慢时会数到临时文件：`codex-remote-service.test.ts`「holds images until the next prompt…」就这样红过（长度 2 对得上，「有 .jpg」那句 `expected false to be true`）。按长度等（`toHaveLength(1)`）也会被临时文件凑上。

- 写法：等存好本身。手机遥控的图用 `setup()` 返回的 `imagesSaved(count)`（第 count 张存好时 resolve），别的存放处照这个办法包一层 `save`。
- 等的东西前面排着几次原子写的，也别用 `vi.waitFor`：它默认只等 1 秒，每次写一两百毫秒，凑上五六次就过了。手机遥控每处理一句话都先把消息编号记进设置、每张图都存一次，「keeps at most five images waiting for the next prompt」等第二句回话前要写 7 次，11-18 #1929、11-20 main 和 #1940 在 Windows `vitest-2` 上各红一次（指纹：只等到「收到图片……」，「一次最多带 5 张图片，这张没收。」没到；慢的时候一句都没等到，`expected [] to deeply equal`）。手机上收到的话用假渠道的 `sentUntil(done)` 等发送本身，再照常断言全部内容。
- 被测代码自己不等落盘的（返回之后才写），等那次原子写本身。`scanExternalClients` 返回时上次检测结果还没写，`external-client-service.test.ts`「shows the next start the last whole detection…」原来用 `vi.waitFor` 读文件等，#2000 在 Windows `vitest-2` 上跑道慢一阵时就红了（指纹：1 秒出头 `ENOENT … external-client-snapshot.json`，#2006）。现在那个文件 `vi.mock('./safe-local-data')` 原样转给真的 `writeAtomicSafeUtf8File`，写完告诉一声：注册在触发之前，`const saved = atomicWrites.next(path.resolve(file), '要写进去的内容')`，触发后 `await saved`。本地复现：在 `external-client-snapshot-cache.ts` 的 `write` 里写盘前临时等 1.1 秒，旧写法当场红。
- 本地复现：在 `writeAtomicSafeFile` 的 `handle.writeFile` 后面临时加一句 `await new Promise((resolve) => setTimeout(resolve, 150))`，旧写法当场红。别提交这句。
- 被测代码给了 `idle()` 的，`idle()` 得连正在跑的那一次一起等（2026-11-23）。`client-version-reporter.ts` 发成功以后才把记「已报」的那次写盘排进队，原来的 `idle()` 只等调用那一刻排着的：假时钟下定时器触发的那一次，`idle()` 在它第二次写盘落地前就兑现了，用例结束后 afterEach 删临时目录时那次原子写还在往目录里放临时文件，macos-test 上偶发 `ENOTEMPTY`（#2128，「waits before the first report and pulls it forward…」）。修在产品代码：`idle()` 先等 `inFlight` 再等队列，用例不动。复现：`strace -f -qq -tt -o <文件> -e trace=openat,rename,rmdir npx vitest run electron/client-version-reporter.test.ts -t "pulls it forward"`，在输出里按临时目录名筛，旧写法第二次 `rename` 排在 afterEach 的 `rmdir` 之后，新写法两次 `rename` 都在前。`usage-stats-reporter.ts` 的 `idle()` 也只等队列，目前的用例没有在一次上报进行中调它。
- 手机遥控整个用例文件按这条清过一遍（2026-11-20）。起因是帮手 `prompted()` 用 `vi.waitFor` 等 `turn/start`，每句话交给 Codex 前要先原子写一次消息编号，#1949（「drops waiting images on a new conversation…」，`vitest-3`）、#2038（「reports how long the turn has run…」，`vitest-4`）在 Windows 上各红一次（指纹：`expected 0 to be greater than 0`，指着 `prompted()` 那行）。找法：临时给 `writeAtomicSafeFile` 计数，把用例里的 `vi.waitFor` 包一层，等到时看这段里写完过几次盘，有写盘的记下行号（不提交）；当时 74 处，全换成等事件本身：`prompted()` / `turnStarted(s, count)`（起 Codex、交出第 count 个 `turn/start`）、`s.codexSpawned`、`s.spawnAsked`、`codex.requestedUntil`、`channel.sentUntil`、`channel.fetchedUntil`、`s.stateUntil`（推给电脑窗口的状态）、`s.imagesRemoved`、`approvalCardsSent`。剩下的 `vi.waitFor` 等的那段里不写盘。每次写盘拖慢 1.1 秒对比：旧写法 85 条红，新写法 0 条。拖慢用的是 `setTimeout`，用了假时钟的那 31 条两边都会卡到 30 秒超时，那是拖慢办法的毛病，不算。往这个文件加用例时，手机发了话以后要等的，一律用这些。
- 换成等事件以后少了轮询白送的那几十毫秒，用例要是悄悄靠过它，本地当场就红，把它真正依赖的那件事也等上，别加 `setTimeout`。这次碰到三种：等到第二个 `thread/start` 就 notify 第三轮做完，那时第三个 `turn/start` 还没交出去，对不上编号（先 `requestedUntil('turn/start', 3)`）；等到「收到」就去点卸载，那时还没开始起 Codex（先 `s.spawnAsked(1)`）；假时钟下 `vi.waitFor` 每轮会把假时钟拨前 50 毫秒，三条十分钟自动拒绝的用例原来靠它让审批晚于这一轮开始，等事件后两者落在同一刻，第二次五分钟进度跟十分钟期限撞在同一下、排到「已自动拒绝」后面（用例里显式 `advanceTimersByTimeAsync(1_000)`，写明 Codex 过一会儿才问）。

## 刚过零点那几分钟才红的时间写法（2026-11-12，#1809）

界面上「几点发来」这类时间，同一天只写 `14:05`，不是今天就带日期写成 `11 月 11 日 23:50`。用例里拿 `Date.now() - N 分钟` 造数据、再用 `/^\d\d:\d\d …/` 去对，在 runner 本地时间零点后的 N 分钟里就会红（`e2e/v2-business.test.mjs`「最近一次」那条 11-12 北京 08:00、UTC 零点红过）。要么断言里让日期那段可有可无（`(?:\d{1,2} 月 \d{1,2} 日 )?`），要么把造数据的时间钉在当天中午。复现：容器是 UTC，在 UTC 零点后几分钟内单跑那条就能看到。

## 装命令行工具的用例：夹具要连 PATH 一起换掉（2026-11-18）

装 CLI 之前，`cli-install-service.ts` 的 `assertNpmChannelOwnsCli` 按首页那套判定（`resolveCliInstallation`）看这台电脑上是不是已经有别处装的同一个工具，它照 `process.env.PATH` 找。夹具只换了 `HOME`、没换 `PATH` 时，跑测试那台机器上装着 Claude Code（云端容器自带 `/opt/node22/bin/claude`，开发机自己装过的也算），安装当场被拒成「这台电脑上的 Claude Code 不是通过本工具安装的…」，后面要测的那段走不到，等下载的用例拖满超时。`system-service.certificate-trust` / `disk-space` / `download-stall` / `install-cancel` 四个文件就这样在容器里红过 29 条；CI 的机器上没装这几个工具，一直是绿的，所以 CI 替你发现不了。

- 写法：起服务前 `vi.stubEnv('PATH', <夹具自己的 bin 目录>)`；夹具一个程序都不给的，建一个空目录指过去。上面四个文件和 `system-service.cli-revert.test.ts` 都是这样写的。
- 复现：本机没装 Claude Code 的，往 PATH 最前面加一个目录，里面放一个能执行的 `claude`（内容 `#!/bin/sh` 加 `echo 1.0.0` 就够），没换 PATH 的夹具当场红。11-18 验：旧写法的 `install-cancel` 13 条红 8 条，换了 PATH 的四个文件 57 条全过。

## 只让某一次写失败：按写的内容认，不按第几次（2026-11-18）

`codex-remote-service.test.ts`「still switches every channel off when turning off switching on at launch cannot be saved」在 main 上三平台必红过：#1898 用 `mockRejectedValueOnce` 让 `store.updateSettings` 失败一次，本意是让「清掉自动打开」那次写失败；#1902（YR-2）在处理绑定的人发来的话之前先写一次消息编号，那一次失败被它吃掉，轮到清自动打开时写成功了。两个 PR 各自绿，合在一起红。

- 写法：用 `mockImplementation` 先把 `mutate` 套在一份 `structuredClone` 出来的设置上看它改了什么，是要测的那次才抛错，其余照常调原来的 `updateSettings`。再补一句断言钉住场景（比如 `remote.message-id-unsaved` 没出现、盘上的值还是旧的），以后路径上再多一次写，用例也不会悄悄换成测别的。
- 真的要模拟「盘满了、所有写都失败」用 `mockRejectedValue`（不带 Once），那是另一种场景，别混着用。

## 测「最多 N 条」的用例：别经 store 存满（2026-11-18）

`safe-local-data` 的原子写每次都要逐级查路径、写临时文件、刷盘再换名。Windows runner 上平时几十毫秒一次，runner 慢的时候一次一百多到三百多毫秒（11-18 那次 `vitest-4` 的日志里，同一文件里只存几个对话的小用例折算下来每次 120~340 毫秒）。测上限的用例要是经 store 把 N 条存满，N 到一两百就会偶发撞 30 秒：`ai-video-task-store.test.ts`（#1516）、`ai-chat-history-store.test.ts`「keeps 200 conversations and still checks every one it did not rewrite」（11-18 在 #1897、#1921 上各红一次，平时八九秒）都是这样红的。

- 写法：上限前那些条按 store 写的格式和顺序直接写进文件，只让要测的那几次保存经过 store；store 对每个没重写的文件做的检查（多一个硬链接、文件没了）照样走得到。「一次存满 N 条能不能收下」用解析函数单独断言，不用真写 N 次。
- 复现：在 `writeAtomicSafeFile` 的 `handle.writeFile` 后面临时加 `await new Promise((resolve) => setTimeout(resolve, 150))`，旧写法当场撞 30 秒。11-18 验：聊天记录那条旧写法 30091ms 超时，改完 399ms。别提交这句。
- 不是产品慢：客户用的时候一次保存只重写改过的那一两个对话加索引，一次写上百个只在「搬到新电脑」导入、头一回从旧的存法搬过来时各有一回。
- 上限只数名字的，占位别整份复制（11-22）：`backups.test.ts`「restores the oldest backup even when pruning runs at the retention limit」要先占满 200 份备份的配额。以前绕开了 store，但每份都 `cpSync` 整个备份文件夹再改清单，连同收尾删掉要多一万多次文件系统调用（容器里 strace 数的，是现在的五倍）。11-20 晚到 11-22 的 202 次 Windows 运行里它中位 1.6 秒，11 次 3~16 秒，一次 34 秒撞了 30 秒（main 运行 44965062250，#2084）；同一次运行里同一文件另外三条恢复用例都没超过 3.4 秒，慢的只是这一段复制。prune 只按文件夹名数配额、不读里面，所以只整份复制要恢复的那一份，其余 199 份建空文件夹，再断言第二旧的那份被清掉：证明占位确实算进了配额，不然清理没跑到上限它也照样过。
- 复现这一类（别提交）：`strace -f -qq -o /dev/null -e trace=<文件类系统调用> -e inject=<同一串>:delay_enter=3000 npx vitest run <文件> -t <用例名> --testTimeout=30000`，把每次文件系统调用拖慢 3 毫秒。11-22 验：备份那条旧写法 35 秒红（收尾删 200 份还撞了 10 秒的钩子时限），新写法 9 秒过。文件类系统调用用的是 `openat,mkdir,newfstatat,statx,rename,unlink,unlinkat,rmdir,sendfile,copy_file_range,getdents64,fsync,fdatasync,readlink`。

## 一键检测的用例报「检查超时」：时限管的是同一个主线程（2026-11-21）

`diagnostics.test.ts` 的夹具给每一项 `timeoutMs: 100`，从这一项开始跑算起。可所有检查挤在同一个主线程上，一项的时间里也算着别的项的同步读盘：Windows runner 上单跑一次整份检查就要 70~90 毫秒（日志里只跑一次 `runDiagnostics` 的用例都是这个数，Mac 上 6~20、云端容器 4 左右），哪一项最后跑完，哪一项就贴着线。「电脑里另外设过的工具地址或密钥」（`PROVIDER_ENVIRONMENT_OVERRIDE`）以前把八到十一个终端设置文件一个接一个交给 `readSafeUtf8File`，不在的也要先在主线程上把主目录整条逐级同步核一遍（每一级 `lstatSync` 加 `realpathSync`，后者又逐级 lstat），runner 的临时目录有六七级深。它于是总是最后一个，「passes %s because the written configuration still wins」那几条一次跑三个平台，11-11 在 macos-test、11-20 在 windows-test (vitest-2) 各红一次（指纹：`summary: 检查超时`、`reason: 单项检查超过 100ms`，红在哪个平台不固定）。

- 修法（不调时限）：先用 `fs.promises.lstat` 排除不在的文件，在的（是个链接也算在）照旧整套核过再读；候选按 `async-map.ts` 的 `mapWithConcurrency` 同时读，结果照原来的次序。`diagnostics-override-checks.test.ts` 钉住只有在的文件才走 `readSafeUtf8File`。
- 给检查页加新项时：别一个接一个地把一串候选文件交给 `readSafeUtf8File`。多半不在的先异步排除，读盘按 `mapWithConcurrency` 限流。
- 复现（别提交）：写一个 `.mjs`，把 `fs.lstatSync` / `statSync` / `existsSync` 包一层、每次空转 250 微秒，`realpathSync` 按路径级数空转，用 `NODE_OPTIONS="--import <它>"` 加载；再把 `TMPDIR` 指到一个六级深的目录（照 runner 的 `C:\Users\RUNNER~1\AppData\Local\Temp`），单跑 `diagnostics.test.ts`。11-21 验：250 微秒时旧写法红 3 条（含这一条），400 微秒红 30 条、几乎全是这一项；改完 250 微秒全过，400 微秒只剩一条整条 5 秒的测试级超时（直接跑 vitest 用的默认时限，`npm test` 是 30 秒）。

## Mac 开发版首屏那条欢迎页没出来：#2025 把客服二维码改成按需加载，页面多出一个 1 秒多的长任务（2026-11-21）

| 项 | 内容 |
|---|---|
| 用例 | `e2e/macos-dev-origin.test.mjs` › the configured macOS development origin renders the real Electron app（`macos-test` 的 `npm run test:mac:dev-origin`） |
| 11-20 两次 | PR #2025，run 44770306041（整条 12.8 秒）、44780691705（13.2 秒）：页面加载完以后欢迎页 5 秒没被看到，报错只有 `failedRequests=[]` |
| 这两次的根因 | #2025 把 `src/renderer-v2/features/app/useSupportContact.ts` 的 `import QRCode from 'qrcode'` 改成首屏画出来以后再 `import('qrcode')`。Mac runner 上页面主线程因此在首屏前后多出一个长任务，每轮 1.1~1.6 秒，编译后第一次 4.4 秒。Playwright 判断「看得见」要在页面主线程里跑一段脚本，长任务没完它就问不进去；有几轮长任务落在欢迎页画出来之前，欢迎页本身也跟着晚。冷的第一次再碰上机器忙，就过了 5 秒。#2025 已在它自己的 PR 里把这一处改回静态导入，Markdown 照样按需加载 |
| 11-18 那次 | PR #1896，quality run 44301446616：`test timed out after 30000ms`，各步自己的超时一个都没报。早于 #2025，跟它无关。当时用例还连生产、各步不打点，没有现场，根因没坐实；现在再出现，看最后打出的是哪一步就知道卡在哪 |

**怎么查出来的**（Mac 上的数字都来自 macos-15 runner 上的一次性探测工作流，照 `macos-test` 的顺序先跑 `test:browser`、`test:mac:release-keychain`、`test:mac:proxy`，每份代码先「编译再跑」几轮、再「直接跑」几轮）：

- Playwright 看到页面加载完，到它看到欢迎页，隔了多久（run 44880468302、44883260566）：
  - main：33~225 毫秒，编译后第一次 0.8 秒。
  - #2025 的底座 0b99e0c：27~198 毫秒，编译后第一次 0.7 秒。
  - #2025 原样：每轮 1.0~1.6 秒，编译后第一次 3.9~4.9 秒。更早一轮探测里真复现过一次 5 秒没看到（run 44877870419）。
  - #2025 只把 `useSupportContact.ts` 改回静态导入：39~486 毫秒，编译后第一次 0.8 秒，跟 main 一样。
- 页面自己记的时刻：四份代码都是加载完 0.1~0.4 秒就把欢迎页放进 DOM、有了尺寸。慢的是测试那头看到它。
- 三处卡顿一起记：主进程（每 50 毫秒打一次点）、测试进程（Vite 开发服务器和 Playwright 的轮询都在这个 node 进程里）、页面长任务。前两处每份代码都一样，都在 0.4 秒以内。只有 #2025 每轮多出一个 1.09~1.61 秒（冷的 4.39 秒）的页面长任务，Playwright 看到欢迎页的时刻就是这个长任务结束的时刻。
- 长任务里在干什么（run 44887090187）：抓到的那一轮，JS 采样里 qrcode.js 的 `renderToDataURL` 自己占了 1229 毫秒，`clearCanvas` 47 毫秒，也就是 `QRCode.toDataURL` 把二维码画到画布上、再 `canvas.toDataURL()` 编成图片那一步。别的几轮长任务早于采样开始，没抓到：开始采样的命令本身也要等页面主线程空出来。
- 为什么静态导入时同一步不慢：推测是时机不同，没核。静态导入时它在首屏第一次绘制之前就跑完，画布还是软件画布；按需加载时它落在首屏画出来之后，画布已经交给 GPU，`toDataURL` 要同步从 GPU 读回像素，CI 的 Mac 虚拟机没有真显卡，这一步就要一秒多。真机上大概不会这么慢，也没演过。
- Linux 上两份代码没差别（加载完到欢迎页都是 150~220 毫秒），本地复现不了。

**排除了什么**（都实测过）：

- 开机那五条读取慢（设置、平台能力、账号会话、更新状态、窗口能力）：Linux 上 0~2 毫秒回，Mac 上 0~14 毫秒。账号会话那条最多等账号恢复 3 秒（`account-startup-gate.ts`），新用户没有要恢复的账号，不用等。
- Vite 预构建缓存对不上、中途补预构建、整页重载：同一份缓存（14 个依赖），0 次重载。
- 生产网络慢、连不上、答得慢（以前这条用例真连 `xm.solov.cc` 两条线路）：Linux 上让请求 4 秒才被拒、或 0~1.5 秒才答，欢迎页照样在加载完后 16~180 毫秒出来。
- 主进程或测试进程卡住：见上，三份代码一样。

**改了什么**（不调超时、不跳过）：

- 用例不再连生产：改用 `e2e/signed-out-smoke-isolation.mjs` 的 `withSignedOutSmokeIsolation` 启动，两个账号站点的公开状态由夹具答，别的请求一律拒绝，只放行这次用例自己的本机开发服务器（新加的 `rendererOrigins`，只认 `http://127.0.0.1:端口`），用例最后用 `verifySignedOutSmokeIsolation` 核一遍。网络从此不是变量。
- 每一步完成时打一行 `# <步骤> at N ms`（`dev server ready`、`electron launched`、`first window`、`document loaded`、`welcome visible`、`electron closed`），撞上 30 秒总时限也照样打出来。
- 绿的时候也打一行 `# timeline: {…}`，时刻都是从用例开始算的毫秒：`renderer.welcome`（欢迎页进 DOM）、`renderer.welcomeShown`（有尺寸且 `checkVisibility()` 通过，就是 Playwright 说的看得见）、`renderer.lateRequests`（加载完之后页面又拉了哪些模块、各用多久）、`renderer.longTasks`（`[开始, 毫秒]`）、`mainProcessStalls`、`testProcessStalls`。攒几次就知道离 5 秒多远。
- 欢迎页 5 秒没被看到时，报错后面接一段 JSON：上面这些，再加 `visibleAfterMore`（再等 3 秒看是晚到还是根本没出来）、`screen`（页面上有哪些 `data-testid`、前 200 个字）、`mainProcess`（主进程多久回话）、`bootstrapReads`（开机那五条读取从页面再问一遍各自多久回）、`fixture`（`e2e/harness.mjs` 的 `observeFixtureBootstrap`：Vite 整页重载、补预构建、没回的脚本）、`failedRequests`、`mainOutput`（主进程最后 20 行输出）。

**下次再红怎么读**：

- `visibleAfterMore` 是「N ms later」，`renderer.longTasks` 里有一条结束时刻跟 Playwright 看到的时刻对得上：页面主线程被占住了，看那段时间拉了什么（`lateRequests`），再比一下这个 PR 改了首屏哪些导入。
- `renderer.welcome` 没有、`screen` 停在启动页（「正在准备星芒 AI」）、`bootstrapReads` 里有 `unanswered`：那一条读取卡在主进程。
- `mainProcess` 是 `unanswered`，或 `mainProcessStalls` 里有秒级的：主进程整个卡住。
- `testProcessStalls` 里有秒级的：测试进程自己卡住（Vite 转换或 Playwright 本身）。
- `fixture.fullReloads` 大于 0 或 `pendingScripts` 有东西：Vite。
- 打出了 `welcome visible`、没打出 `electron closed` 就撞了 30 秒：关窗卡住。

**给改首屏导入的人**：把首屏要用的东西挪到首屏画出来以后再做，Mac runner 上可能多出秒级的页面长任务，Linux 上看不出来；画布上的 `toDataURL` 这一类同步读像素的调用最明显。改了首屏的导入方式或先后，就在 PR 的 `macos-test` 日志里看一眼这条用例的 `# timeline`：`longTasks` 有没有多出秒级的一条。

**探测时踩到的**（以后要在 Mac 上临时探测 Electron，照这几条）：

- 用脚本入口起 Electron（`electron.launch({ args: ['some-entry.cjs'] })`）却不调 `app.setAppPath`，应用名会变成 `Electron`，首窗一直不出来（Mac 上第一轮探测 9 次全是这样）。要包一层又要应用名照旧，照 `withSignedOutSmokeIsolation` 写一个带同名 `package.json` 的启动目录。
- Playwright 起的 Electron 不认 `NODE_OPTIONS=--require`，要预加载就放进启动参数：`['-r', hook, '.']`。
- 往 `bootstrap.cjs` 前面拼代码时自己补分号：下一行是 `(function …)(…)`，不补就被当成上一行的调用，整段不执行，症状也是首窗不出来。
- `ElectronApplication.evaluate(fn, arg)` 调 `fn` 时第一个参数是 electron 模块，`arg` 是第二个。
- 开发版首屏拉的模块超过资源计时缓冲的 250 条，晚到的进不去 `performance.getEntriesByType('resource')`，要用 `PerformanceObserver` 记。
- 要在用例里录性能追踪：Electron 的 `contentTracing.stopRecording()` 写出的是 protobuf，不是 JSON；用页面的 CDP 会话 `Tracing.start({ transferMode: 'ReturnAsStream', streamFormat: 'json' })`，再用 `IO.read` 读回来。
- 在 Mac 上连跑用一次性探测工作流（`docs/COLLABORATION.md` §3）。一次推送只认最后那个提交，探测提交要单独推；跑起来以后再推别的提交不影响它，它跑的是自己那个提交。用完删掉分支上的工作流文件。

## 按时间戳认「又来了一次」：快机器上同一毫秒落两次（2026-11-21）

`balance-store.ts` 的 `subscribeBalanceReads` 以前看 `snapshot.updatedAt`（`Date.now()` 毫秒）变没变来认「余额又读到一次」。`balance-store.test.ts`「tells read listeners once per landed read…」用真时钟、假 `read` 立刻回，前后两次读在快 runner 上落进同一毫秒，第二次就漏了（指纹：`expected "vi.fn()" to be called 2 times, but got 1 times`，指着「失败一次后再读一次」那行；11-21 在 linux-test 上 #1994、#2062 各红一次）。客户电脑上每次读余额都要过网络，两次落在同一毫秒几乎不会，但「每次都告诉一声」的约定确实没守住。

- 修法：store 在快照里记 `reads`（读到过几次，只增不减，换账号也不归零），`subscribeBalanceReads` 认它不认时间戳。`updatedAt` 照旧只管「多久以前读的」。
- 写法：要认「又发生了一次」的，数次数或给每次一个编号，别拿时间戳当编号；用例里的 store 能注入 `now` 的，钉成一个常数，同一毫秒就成了唯一情况，按时间戳认的写法每次都红。那个用例所在的分组现在就是这样钉的。

## 按文件修改时间排先后的用例：Windows 上一口气写的文件修改时间常常相同（2026-11-22，#2060）

`provider-sessions.test.ts`「only reads the most recent hundred sessions when searching what was said」在循环里连写 101 个记录文件，想让「最早那条」落在最近 100 条之外。记录的「最近」按文件修改时间和最后一条消息时间里晚的那个算，刚写的文件修改时间比消息里写的时间晚，排序其实全看修改时间。Linux 上修改时间到纳秒、逐个递增，次次绿；Windows runner 上一口气写出的文件修改时间常常一样，并列的按列目录的次序排，被挤出去的不是最早那条（指纹：`expected 1 to be +0`，11-22 在 windows-test (vitest-1) 上红）。

- 修法：每个文件写完用 `fs.utimesSync` 把修改时间钉成它最后一条消息的时间，先后只由用例自己定。
- 复现：在 Linux 上把这批文件的修改时间设成同一刻，就是同一个红。
- 写法：用例要靠「谁新谁旧」的，别指望连着写出来的文件修改时间不同，自己用 `utimesSync` 设好；同理别拿 `Date.now()` 当先后（见上一节）。

## 真开登录 shell 核 PATH：macOS 会先把 PATH 重排一遍（2026-11-23，#2142）

`antigravity-macos-environment.test.ts` 起登录 bash 时把 `~/.local/bin` 放在 PATH 最前，想核「已经在的原位不动」。Linux 上绿，macOS runner 上红（指纹：`expected { count: 1, last: true } to deeply equal { count: 1, last: false }`）：macOS 的 `/etc/profile`、`/etc/zprofile` 先跑 `path_helper`，把 `/etc/paths` 里的系统目录排到最前，继承来的目录挪到后面，轮不到我们那一段说话。

- 修法：登录 shell 里只核「有几个、最后一个是不是」这类重排改不了的；「原位不动」改成单独 `. 那一段` 核，不经过系统的启动文件。
- 写法：真开登录 shell 的用例别断言继承来的 PATH 的先后，系统启动文件（还有 runner 镜像自己加的目录）会动它；要断言我们写的那一段怎么改 PATH，就在 `/bin/sh` 里直接读那一段。

## 改了窗口尺寸立刻量版面：侧栏自动收起要等一拍（2026-11-25，#2168）

`src/renderer-v2/testing/app-check.mjs`「the start cards sit fully above the composer in a short window…」（#2164 加的）把窗口从 1280 × 820 改成 1100 × 740、1100 × 680，每改一次立刻量起始页两张卡有没有落到输入框后面。宽不到 1272 时侧栏自动收成 60 宽，那是 `Shell.tsx` 的 `useNarrowWindow` 收到 `matchMedia` 回调再让 React 重画，比 `setViewportSize` 晚一拍；这一拍里窗口已经窄了、侧栏还是 224，正文窄约 160、卡高出约 20（容器里 740 高时量到卡底离输入框只剩 3 像素，侧栏收好以后是 63）。快机器上 680 那一下量的时候侧栏早收好了，慢 runner 上没收好，就量成两张卡都被挡（指纹：`680px tall`，`hidden` 实际 `[ 'create-card-video', 'create-card-canvas' ]`；11-25 在 #2166 的 linux-renderer-v2-browser (2)、#2168 的 windows-test (renderer-v2-browser-1) 各红一次）。

- 修法：只改高、宽留在 1280，侧栏不动，量到的就是纯 CSS 排出来的那一版。1366 × 768 的笔记本侧栏本来就是展开的，这也正是那条改动要守的情形。
- 写法：用例改窗口尺寸后要量版面的，别让尺寸跨过 1272 这条宽（或 660 这条高）；非跨不可的，先等侧栏到了该有的宽（`.v2-sidebar` 的宽是 60 或 224）再量，不要拿固定的毫秒数去等。

## 画布换皮肤那条：「减少动画」反倒给每个元素开了过渡（2026-11-26）

`e2e/canvas-close-interactions.test.mjs`「canvas applies four skins in both themes…」每换一套皮肤（都带 `reducedMotion: true`）就马上比 `.react-flow` 和 `.canvas-app` 两层的底色。画布内核「减少动画」的两条全局规则（`theme/brand-appearance.css` 的 `[data-reduced-motion='true'] *`、`theme.css` 的 `@media (prefers-reduced-motion: reduce)`）原来写 `transition-duration: 0.01ms !important`，`transition-property` 默认是 `all`，于是每个元素的每个属性都起一段 0.01ms 的过渡。容器里量过：换一次皮肤冒出 250~350 段过渡，两三帧后才收完，这期间 `getComputedStyle` 读到的是上一套甚至上上套的底色。平时两层一样旧，比出来相等就过了（其实没比到新皮肤）；偶尔一层先收完、另一层还没有，就红（指纹：`+ 'rgb(250, 247, 238)' - 'rgb(240, 246, 245)'`，晨曦浅色对雾青浅色；11-20 #2000、11-21 #1936 在 linux-test 上各一次，本机连跑几十次都没红）。

- 修法：在 xingmang-canvas 把两条规则改成 `transition: none !important`（xingmang-canvas #62），同步进 `canvas-v2/`。换完皮肤同一刻读到的就是新底色，一段过渡也没有；顺带平移时 `.react-flow__viewport` 的 `transform` 也不再晚两帧左右才画上。内核新加 `theme/reduced-motion.test.ts`，不许整页通配的规则再设 `transition-duration` 这几项。
- 看现场：换完皮肤后在页面里看 `document.getAnimations().filter((a) => a.transitionProperty === 'background-color')`，修之前有二三十个、`pending` 都是 `true`，修之后是空的。
- 写法：「减少动画」这类全局规则要关过渡就写 `transition: none`，别只改时长；用例换外观后要读计算样式的，先确认页面上没有在跑的过渡，别拿固定的毫秒数去等。

## 随机输入测试红了：是真问题，不是偶发红（2026-11-17）

`fast-check` 写的随机输入测试（各测试文件末尾 `… with random inputs` 那几节：打码、外链白名单、会话编号、换线路改配置、粘贴密钥整理、PowerShell 单引号和通配符转义）每次跑用不同的随机种子，同一条这次绿、下次红是可能的。红的那次是库碰巧造出了一个打破规矩的输入，**代码真有这个缺口**：不按「重跑就过」放过，也不许把生成器改窄躲过去。

- 报错里有 `{ seed: …, path: "…" }` 和缩到最小的反例 `Counterexample: …`。复现：把这两个值原样加进那条 `fc.assert` 的第二个参数（比如 `{ numRuns: 300, seed: -1936744136, path: '4462:0:1' }`），本地单跑那个文件，每次都红在同一个输入上；修好代码再把它们删掉。
- 生成器里刻意排除的输入，旁边都写了为什么（比如命令行参数名里不抽 `sk` 这一段，`--sk-api-key` 会先被密钥形状那条规则藏掉名字）。修那个缺口时先把排除去掉，旧代码当场红，就是 `AGENTS.md` 第 8 节「先写一条在旧代码上会红的用例」。带转义引号的密钥字段、结尾是 `-` 的 `sk-` 密钥原来也排除着，2026-11-17 都修好放开了；前者现在值里多抽引号和反斜杠，按 JSON 的写法转义后再查。
- 想多找几轮：临时把 `numRuns` 调到几万，加 `--testTimeout 900000` 单跑那个文件，别提交。CI 上每条控制在几百轮，整个文件一秒上下。
- 只有一种情况可以改生成器：反例根本不在那句话管的范围里，而代码对它的处理是有意的。这时先用一条手写例子把代码对这个输入的处理钉住，再在生成器里排除，旁边写明为什么。例子：`third-party-user-agent.test.ts` 那句是「认得出的自家地址一定拿到完整的那串」，标签生成器造出 `xn--a.solov.cc`（「xn--」开头却解不出国际化域名，`new URL` 报 `Invalid URL`），代码按认不出的网址当外人看，这是有意的；2026-11-24 把它钉进「unreadable address」那条，自家主机的生成器排除「xn--」开头的标签（#2153 的 macos-test 撞过一次）。造主机名的生成器都留意这一点：`ab--c`、能解出来的 `xn--fiqs8s` 都没事，解不出的 `xn--` 开头标签会让整个网址作废。
