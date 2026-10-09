# 测试基线：Windows 是否全绿取决于机器环境

> 从 `AGENTS.md` 第 2 节搬出（2026-09-18）。行号引用已换成符号名，其余内容未改。

**只有在 Windows 上、且怀疑基线不稳时**，才需要改动前先跑一遍记下失败数，改完对比；Linux / CI 直接跑改后的即可。已知失败全部与环境相关，**不是你弄坏的**：

| 平台 | 已知失败 | 原因 | Issue |
|---|---|---|---|
| **Windows** | **0** | 需要 `SeCreateSymbolicLinkPrivilege` 的 9 条（`safe-local-data` ×4、`runtime-log` ×2、`backups`、`path-identity`、`relocated-folders`）已按能力门控，没有该特权时跳过而非 EPERM 失败；原先那 5 条 5s 超时已随 `test:vitest` 的 `--testTimeout=30000` 消失 | **#40** |
| **macOS** | 0 | — | — |
| **Linux** | 0 | 原 `samePathIdentity` 误删缺陷已修复：launcher 文件清理现走 `macos-platform.ts` 的 `sameFileIdentity`（追加 size/nlink/mtime/ctime 比对） | #2 已关闭 |

遇到超时类失败先原样复跑一遍 `npm test`（它已经是串行 + 30s 超时）。符号链接那 9 条默认跳过；想在本机真跑，开启 Windows 开发人员模式或以管理员身份运行即可，`electron/symlink-capability.test-support.ts` 会自动探测到。基线与上表不符请到 **#40** 报告。

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

还没接 `openFixturePage` 的套件（`features/acceleration`、`features/shell` 等，它们接了挂载
预算但没接重试）遇到上表第二行的形状，仍然按原样重跑一次；连着两轮同一处才当真。

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

> 云端/CI 容器提示：e2e 里 2 个 Playwright 布局用例要真浏览器，若容器预装的 Chromium 版本号与 `@playwright/test` 期望不符会报 "Executable doesn't exist"——环境问题不是回归，指个可用的 executablePath 复跑即绿（vitest 与 scripts 套件不受影响）。

> 底线：**不要引入新失败**。
