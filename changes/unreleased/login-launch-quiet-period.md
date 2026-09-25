## 用户

- 开了「开机自动启动」后，电脑开机那几分钟星芒不再抢资源：工具检测、检查更新、账号 Key 准备都等你第一次点开窗口，或开机大约 3 分钟后再做。点开窗口后和以前一样。

## 开发

- `login-launch.ts` 新增 `createLoginQuietPeriod`（`loginQuietPeriodMs` = 3 分钟）：开机拉起时进入安静期，主窗口第一次 `show` 或到时结束，日志 `launch.quiet-started` / `launch.quiet-ended`。
- `main.ts`：`launchedAtLogin` 提前到预热扫描前算出；预热扫描等安静期结束；安静期里托盘先用 `system-snapshot.json` 的旧结果。加速的系统代理还原不受影响。
- `ipc.ts` 新增可选 `startupQuiet`：安静期里 `system:scan` 的首屏读取只回旧结果不起真扫描（`cachedScan({ startScan: false })`），真扫描、`update:startup`、`account:sync-managed-cli-keys` 都等安静期结束。主进程统一拦，渲染层不改，也不加 IPC 通道。
