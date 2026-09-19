# 测试基线：Windows 是否全绿取决于机器环境

> 从 `CLAUDE.md` 第 2 节搬出（2026-09-18）。行号引用已换成符号名，其余内容未改。

**只有在 Windows 上、且怀疑基线不稳时**，才需要改动前先跑一遍记下失败数，改完对比；Linux / CI 直接跑改后的即可。已知失败全部与环境相关，**不是你弄坏的**：

| 平台 | 已知失败 | 原因 | Issue |
|---|---|---|---|
| **Windows** | **0~9（环境相关）** | 4 个需要 `SeCreateSymbolicLinkPrivilege`（未开发者模式且非管理员时 EPERM）；5 个可能卡 vitest 默认 5s 超时（真实磁盘两阶段提交 + Defender 实时扫描）。开发者模式开启且磁盘不忙的机器可以全绿（2026-08-08 本机 `npm test` 实测 0 失败、vitest 12.7s） | **#40** |
| **macOS** | 0 | — | — |
| **Linux** | 0 | 原 `samePathIdentity` 误删缺陷已修复：launcher 文件清理现走 `macos-platform.ts` 的 `sameFileIdentity`（追加 size/nlink/mtime/ctime 比对） | #2 已关闭 |

遇到超时类失败先原样复跑一遍 `npm test`（它已经是串行 + 30s 超时）；符号链接类失败开启 Windows 开发者模式即可消除。基线与上表不符请到 **#40** 报告。

> 云端/CI 容器提示：e2e 里 2 个 Playwright 布局用例要真浏览器，若容器预装的 Chromium 版本号与 `@playwright/test` 期望不符会报 "Executable doesn't exist"——环境问题不是回归，指个可用的 executablePath 复跑即绿（vitest 与 scripts 套件不受影响）。

> 底线：**不要引入新失败**。
