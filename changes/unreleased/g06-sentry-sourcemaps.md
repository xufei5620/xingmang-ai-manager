## 开发

- 崩溃上报接上 source map（商业级差距报告 G06）：客户端报错带 release `xingmang-ai-manager@<版本>` 和 dist `<平台>-<芯片>`，帧地址改写成 `app:///dist-electron/…`（主进程）和 `app:///dist/…`（主窗口渲染层），顺带不再把客户的安装路径发给 Sentry（`electron/crash-report.ts` 的 `resolveCrashFrameUrl`）。`npm run compile` 顺带把对照表出到 `dist-sourcemaps/`（vite `sourcemap: 'hidden'` 后由 `scripts/stash-renderer-sourcemaps.cjs` 搬走；tsc 内联映射经 `scripts/minify-electron.cjs` 接回 `.ts`），安装包里一份都没有，发出去的代码逐字节不变。
- 发版工作流新加 `sentry-sourcemaps` 作业：publish 成功后在 `sentry` 环境（只放行 main、不设批准）里读 `SENTRY_AUTH_TOKEN`（Sentry 组织令牌，只能建 release、传对照表），按版本号和 SHA-256 装 sentry-cli 3.8.0，由 `scripts/sentry-sourcemaps.cjs` 按每种安装包的 dist 传上去。没放令牌只提醒，失败不影响客户，单独重跑即可（`docs/RELEASING.md` §9）。
- 早上的日汇总（`scripts/update-feed-stats.cjs`）加「每版健康数」：最新三版各自的闪退、卡住、星芒更新出错，每 100 台·天几次。
