## 开发

- 已知25：Codex 桌面端「中文增强启动失败」和它里面那层「AppX 激活失败」（`codex-desktop-cdp.ts`）挂上 `cause`。启动那边接住这个失败
  以后改走普通启动、只往控制台打一句，打包版不留控制台，原因以前哪儿都看不到。现在 `system-service.ts` 用新导出的
  `withCodexDesktopCdpFailureReport` 把这一步包一层，失败时记一条 `codex-desktop.chinese-launch.failed`（warn），`error` 下面顺着
  cause 记到 PowerShell 那层的退出码和标准错误（#880 让运行日志记 cause）。启动行为不变，失败照旧往外抛。
- 已知24：`scripts/windows-installer-install-directory.test.cjs`、`scripts/macos-artifact-names.test.cjs`、
  `scripts/rename-macos-chip-artifacts.test.cjs` 接进 `test:scripts`，以前 npm test 和 CI 都不跑，接上前后各跑过都过。
  `ci-workflow-config.test.cjs` 加一道门禁：`scripts/` 下每个测试文件都得有某条 npm 脚本点名（只在 Mac 上跑的经 `test:mac:free-signing`）。
- 已知22：短提示 2.4 秒后自己消失，浏览器用例直接等它上屏的话，慢机器上会错过、卡满 30 秒。#198 只改了 app-check 的保存用例；
  这次把那份提示记录挪进 `e2e/toast-recording.mjs`，`e2e/v2-business.test.mjs` 和聊天的 `browser-check.mjs` 也改成认记录。
  找法：让短提示一出来就隐藏、1 毫秒后消失，跑新界面全部浏览器用例，红的就是还在直接等提示的。
- 已知26：`docs/RELEASING.md` 改正 Mac 换签名证书以后的说法：不是「每 3 小时重试」，停在「已下载」时定时检查直接跳过，重装只是把
  下好的同一个包再交给 Squirrel。
