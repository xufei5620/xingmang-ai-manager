## 开发

- #1061 第 4 条（Grok 直接下，yoyo 2026-10-20「四条都放」）：Windows 装 Grok 去 xAI 那一路时，`x.ai/cli/stable` 和 Google 存储那份 stable 都查不到，点了名的版本（推荐版本、退回）照它直接下（`grok-update.ts` 的 `resolveGrokNamedVersion`、`grok-installer.ts` 的 `resolveXaiDownloadVersion`），不再整个安装失败。
- 放宽的只有一处：查不到 stable 时没法再按「点名的版本不超过 stable」封顶。版本号格式照旧只收 `x.y.z`；下载地址只在两个官方目录、`redirect: 'error'`、响应地址全等、Content-Type、Content-Length 和 1 MiB~512 MiB 范围、SHA-256、xAI 签名核对一条没动。没点名（打开了「总是装最新版」）查不到 stable 照旧报「Grok 官方版本查询失败」。存储桶那一路不变。
- 原因只进运行日志（`grok-stable.unavailable`），界面上不加字。只走 Windows（Grok 一键安装只有 Windows），不碰提权、安装路径和命令执行。
