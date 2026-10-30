## 开发

- 主进程开机少加载 69 个模块（0.2.22 性能体检第 5 条，只做「用到再加载」）。二维码库 `qrcode`（连同 `pngjs`，58 个文件）只在
  扫码付款（`payment-window.ts` 的 `openQrCode`）、手机遥控扫码登录（`ipc/handlers/codex-remote-weixin.ts`）时才 `import()`；
  检查页那一套（`diagnostics.ts` 和各项检查、`diagnostics-dns-check.ts`、`diagnostic-fixes.ts`）在 `bootstrap/diagnostics.ts`
  的 `run` / `fix` 和 `diagnostics:fix`、`diagnostics:open-folder` 两个处理器里用到才加载。开机就要的线路探测地址
  `relayStatusProbeUrl` / `relaySiteStatusProbeUrls` 从 `diagnostics-network-checks.ts` 搬进新的 `relay-status-probe.ts`
  （原处照旧导出）；导出和脱敏（`diagnostics-redaction.ts`）、Codex 实测、反馈报告那几段照旧开机就接好，对外的方法签名都没变。
  `main.test.ts` 新增一条，顺着 `main.ts` 的静态 import 走一遍，钉住这几样不在开机加载的范围里。
- 沙箱实测（Linux 4 核、断网、编译产物，改前改后交替各 10 次取中位数）：主进程加载代码 279 → 253ms，`app.ready` 313 → 285ms，
  窗口显示 568 → 517ms；开机加载的模块 777 → 708 个，开机后 6 秒内二维码库和检查那一套都没被加载。
- 量过没动的：`electron-updater`（约 140 个文件、按模块自身耗时记约 35ms，最大的一块）和 `yaml`（约 15ms）开机本来就要用：
  更新服务在开窗前建好，Windows 正式版开机就读 `app-update.yml`、加速在线节点开机就读存下的那份。要省得把更新服务挪到窗口
  出来以后再建，牵动自动更新那条链，不在这次范围。编译缓存不做（用户目录里的字节码会绕开安装包的 asar 完整性校验）。
