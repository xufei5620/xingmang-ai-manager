## 开发

- 深查 D-1：`git-runtime-install.ts`、`python-runtime.ts` 的安装包下载去掉从开始就算的 10 分钟总时限，
  改用 Node.js 那边的「3 分钟没有新字节才停，30 分钟兜底」。这套计时从 `node-runtime.ts` 的
  `createNodeDownloadDeadline` 挪到 `download-retry.ts`，改名 `createDownloadDeadline`，到点的那句由调用方给，
  三处各自沿用原来的说法（Node.js「安装包下载超时」、Git「下载超时」、Python「Python 安装包下载超时」），
  界面上的字不变。单次请求 45 秒没数据仍由 `downloadWithResume` 先接着下；Windows 上装 Claude Code 顺带装 Git，
  以前网速低于约 110 KB/s 时两个源都要到点作废，现在能下完。新增 `slow-download.test-support.ts`，用假时钟
  把慢速下载走真的续传函数：Git 14 分钟下完、两个源各到 30 分钟才放弃且报错原样；Python 同样两条（只在 Windows 跑）。
