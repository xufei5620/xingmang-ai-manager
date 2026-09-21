# 测试基线：Windows 是否全绿取决于机器环境

> 从 `AGENTS.md` 第 2 节搬出（2026-09-18）。行号引用已换成符号名，其余内容未改。

**只有在 Windows 上、且怀疑基线不稳时**，才需要改动前先跑一遍记下失败数，改完对比；Linux / CI 直接跑改后的即可。已知失败全部与环境相关，**不是你弄坏的**：

| 平台 | 已知失败 | 原因 | Issue |
|---|---|---|---|
| **Windows** | **0~9（环境相关）** | 4 个需要 `SeCreateSymbolicLinkPrivilege`（未开发者模式且非管理员时 EPERM）；5 个可能卡 vitest 默认 5s 超时（真实磁盘两阶段提交 + Defender 实时扫描）。开发者模式开启且磁盘不忙的机器可以全绿（2026-08-08 本机 `npm test` 实测 0 失败、vitest 12.7s） | **#40** |
| **macOS** | 0 | — | — |
| **Linux** | 0 | 原 `samePathIdentity` 误删缺陷已修复：launcher 文件清理现走 `macos-platform.ts` 的 `sameFileIdentity`（追加 size/nlink/mtime/ctime 比对） | #2 已关闭 |

遇到超时类失败先原样复跑一遍 `npm test`（它已经是串行 + 30s 超时）；符号链接类失败开启 Windows 开发者模式即可消除。基线与上表不符请到 **#40** 报告。

## CI 的 Windows 分片：丢导航，不是慢

本机基线之外还有一条只在 CI 上出现的：`quality` 工作流的 `windows-test (renderer-v2-browser)`
分片偶发单条用例红。**判定方法是看形状，不是看名字**——挂的用例每轮都不一样，但形状固定：

| 指纹 | 含义 |
|---|---|
| `... did not finish installing within 90000ms after 3 navigations` | 三次导航都没把夹具挂起来 |
| `Timeout 30000ms exceeded` + 等的是夹具首个元素 | 还没接共享预算的套件，页面没挂上来 |
| `page.goto: net::ERR_NO_BUFFER_SPACE`，`duration_ms` 只有几十毫秒 | 用例体一行都没跑，socket 直接要不到 |

2026-09-19 至 09-21 的 196 轮里这个分片 141 次完整跑挂了 14 次（9.9%）；同期十轮绿跑最慢的
用例 22.4 秒，超过 30 秒的一条都没有。**所以预算从来不是瓶颈，丢掉的是那一次导航。**
处置已经写进代码，不用再靠重跑：`e2e/fixture-readiness.mjs` 的 `openFixturePage()` 把 90 秒
总预算拆成三次导航，挂载没落地就重新导航并在 stderr 写明第几次；工作流在装依赖之前把工作
目录与 node/chrome 排除出 Defender 实时扫描。**不要调大 `XINGMANG_FIXTURE_READY_TIMEOUT_MS`
来回避这条**，绿跑用不到它的四分之一，调大只会让真坏掉的夹具更晚红。

还没接 `openFixturePage` 的套件（`src/renderer-v2/features/chat/browser-check.mjs`、
`src/renderer-v2/ui/browser-check.mjs` 等）遇到上表第二行的形状，仍然按原样重跑一次。

> 云端/CI 容器提示：e2e 里 2 个 Playwright 布局用例要真浏览器，若容器预装的 Chromium 版本号与 `@playwright/test` 期望不符会报 "Executable doesn't exist"——环境问题不是回归，指个可用的 executablePath 复跑即绿（vitest 与 scripts 套件不受影响）。

> 底线：**不要引入新失败**。
