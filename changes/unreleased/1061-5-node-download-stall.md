## 用户

- 网慢的时候一键安装 Node.js，不会再下到 10 分钟就被掐断、换个地方从头下：只要还在下就接着等，3 分钟一点数据都没有才换下载源。

## 开发

- Node.js 安装包下载不再限死 10 分钟（#1061 第 5 条 MSI 部分）：`node-runtime.ts` 的 `downloadMsi` 改用 `createNodeDownloadDeadline`，3 分钟没有新字节才中止，另留 30 分钟兜底上限（I10 的超时还在），两个数和 npm 下载那一步一样。单次请求 45 秒没数据仍由 `downloadWithResume` 先接着下。中止的原因还是「安装包下载超时」，界面上那句不变。Windows 的 MSI、macOS 与 Linux 的压缩包走的是同一个下载函数，三个平台一起生效；只改计时，不碰提权、安装路径和命令执行。
