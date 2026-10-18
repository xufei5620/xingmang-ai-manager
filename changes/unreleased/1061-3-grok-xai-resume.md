## 用户

- 在 Windows 上装或更新 Grok CLI、要从 xAI 官方下载时，网络断一下或卡住不动，会从断开的地方接着下，不再换个地址从头下这 170 MB。

## 开发

- #1061 第 3 条（Grok 从 xAI 下载能续传）：`grok-installer.ts` 的 `downloadArtifact` 不再自己写单次下载，改用 `download-retry.ts` 的 `downloadWithResume`。以前 45 秒没数据就换下一个地址从 0 开始；现在同一个地址先带 `Range` / `If-Range` 接着下（等 3 秒、10 秒，最多 6 次）。地址回的不是正好剩下那一段（不支持续传、文件换了）、连着两次接不上、一个字节都还没收到就断，都和 Node.js 安装包（#1211）一样照旧马上换下一个地址；客户点取消照旧不换。存储桶那一路本来就用它，不变。
- 原有核对一条没少：`redirect: 'error'`、响应地址全等核对（接着下的每一次请求也核）、Content-Type、Content-Length 和 1 MiB~512 MiB 范围、下完大小对得上、SHA-256、xAI 签名核对。45 秒没数据中止的原因照旧记成「连接或下载超时」，报错一字不改，不加新字。
- 只走 Windows（Grok 一键安装只有 Windows），只改下载，不碰提权、安装路径和命令执行。Google 存储那个地址核过支持 `Range` 和强 ETag；`x.ai/cli` 容器里连不上没核，不支持续传时照旧换地址，不比以前差（推断）。
