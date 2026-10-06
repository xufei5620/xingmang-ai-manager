## 用户

- 网慢的时候装或更新 Claude Code、Codex，下载那一步会每 15 秒告诉你已经等了多久，
  不再一句话停好几分钟不动、看着像卡死了。

## 开发

- 第三十七批 D：`npm ci` 那一步外面加一个 `npmDownloadHeartbeatMs`（15 秒）的计时器，发 stage 'download'、带 elapsedMs 的
  安装进度，原话是新的 `npmDownloadHeartbeatMessage`：「仍在从国内 npm 镜像下载…（已用时 3 分 05 秒）」、走官方源时
  「仍在从 npm 官方源下载…（已用时 3 分 05 秒）」（2026-10-06 拍板的原话；「从」后面接 npm 时空一格，所以不拼
  `npmRegistryLabel`）。写法照解析依赖图那一步的心跳，只报已用时，不写百分比。
- renderer-v2 没改：带 elapsedMs 的 'download' 进度本来就把进度那一行换成现成的「还在下载，已经等了 …」，原话进安装日志；
  `sendInstallProgress` 不把带 elapsedMs 的记进运行日志，每 15 秒一条、最长 30 分钟也不会刷屏。
- 计时从这一轮 `npm ci` 起算，换源从零算；下完、卡住被掐（第三十七批 A 的看门狗）、客户取消都在同一个 finally 里停。
