## 用户

- 装 Codex 桌面端、Claude Desktop、OpenCode 时下载一时变慢，不再急着丢掉已下的部分换路重下：先比一比另一条路，确实快得多才换，不然接着下。

## 开发

- #1061 第 6 条（先比再换）：`downloadDesktopBucketPackage` 多一个可选的 `probeAlternative`。判出桶太慢时桶照下，同时测一下桶没走通时要换去的那一路（`measureDesktopDownloadSpeed`：发一次请求，最多读 8 秒、4 MB，读到的丢掉不落盘，跳转和地址照那一路自己的规矩核）。那一路照测出来的速度从 0 下完整个包，也要比桶剩下那段快一倍以上（`isDesktopAlternativeClearlyFaster`）才放弃桶；测不出来、不够快就接着下桶，之后还太慢隔 2 分钟再测，一次下载最多测 3 次。下完、放弃、客户取消时还在测的那一路一起停。不传照旧一判出太慢就放弃，所以 Grok、Codex 插件目录不变。
- 接上的三处：Windows 的 Codex 桌面端测 OpenAI 官网的离线包（`measureCodexDesktopOfficialSpeed`，桶后面先是商店，测不了，拿官网同一个包代它）；Windows 的 Claude Desktop 测官网入口跳到的 MSIX（`measureClaudeDesktopOfficialSpeed`）；Mac 上 Codex 桌面端、Claude Desktop、OpenCode 先读官方版本信息挑出这台 Mac 的包再测（`measureMacosDesktopVendorSpeed`，这台 Mac 的系统装不了那一版就当测不出来）。测速不接加速线路，测得只会偏慢，偏向接着下桶。`external-client-runtime.ts` 不用改：它调的两个安装模块自己接上了。
- 换路时日志里那句原话（只进运行日志，不上屏）从「从存储桶下载太慢」变成「从存储桶下载太慢：照目前的速度还要 N 分钟，另一路测下来 M 分钟就能下完」。
