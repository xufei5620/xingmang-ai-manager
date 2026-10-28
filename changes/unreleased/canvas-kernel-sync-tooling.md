## 开发

- 画布换内核的工具和门禁（#1393 的 1a，云端做的，内核本身还没同步进来）：
  `scripts/sync-canvas-kernel.mjs <xingmang-canvas 克隆> <tag>` 从 tag 的提交对象里把内核复制进 `canvas-v2/src`、`canvas-v2/shared`，
  删掉 tag 里没有的文件、统一成 LF，写出 `canvas-v2/KERNEL_SOURCE.json`（tag、提交号、每个文件的 sha256、本地补丁）；
  同一个 tag 跑两次没有任何差异，桌面自有的 `index.html`、`vite.config.ts` 等不碰。清单校验规则在 `scripts/canvas-kernel-source.cjs`，
  本地补丁要写理由、xingmang-canvas 那边的 issue 或 PR、14 天内到期，过期只警告。
- 新门禁 `scripts/verify-canvas-network-boundary.test.cjs`：画布源码和产物里不许出现 `/api/`，`fetch`、`XMLHttpRequest`、
  `WebSocket`、`EventSource`、`sendBeacon` 只许出现在登记过的地方（现在只有读本地音频素材的那一处）。凭据门禁扩到 `canvas-v2/shared`。
  这两道门禁的产物那一半以前在 CI 里从来没跑过（跑 `npm test` 的作业都在构建之前），现在 Windows 打包作业构建完跑一次，缺产物算失败。
  画布的 Vite 构建关掉了 modulepreload 兼容代码（Electron 原生支持，那段 `fetch` 永远走不到）。
- 画布窗口拦下自己发起的下载：画布和主窗口共用默认会话，下载会弹系统另存为、绕开原生保存框加原子写的保存通道（I15）；
  只拦画布窗口的，主窗口不受影响。`.github/CODEOWNERS` 加上 `canvas-v2/index.html`（CSP）和 `canvas-v2/KERNEL_SOURCE.json`。
