## 开发

- 开发依赖 `concurrently`（只用于 `npm run dev`）带的 `shell-quote` 命中新公告 GHSA-pqg4-j6r4-53mv（critical，`>=1.8.4 <1.11.0`），而 `concurrently` 最新版 10.0.5 仍把它钉在 1.9.0，升 `concurrently` 清不掉；改在 `package.json` 的 `overrides` 把 `shell-quote` 钉到已修复的 1.12.0，lockfile 由 npm 重新生成。生产依赖不含它，客户端安装包不受影响。
