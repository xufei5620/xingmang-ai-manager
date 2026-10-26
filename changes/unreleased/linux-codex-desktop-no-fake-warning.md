## 开发

- Linux 不再每次检测都记一条假警告「Codex 桌面端更新检测失败：Codex Desktop 版本检测仅支持 Windows」：
  `codex-desktop-service.ts` 的 `inspectCodexDesktop` 在非 Windows、非 Mac 那支原来把这句当 `updateError` 带回去，
  `ipc/handlers/system.ts` 见到 `updateError` 就记 `desktop.update-check.failed`，客户导出的反馈报告里全是它。
  现在跟 Mac 那支一样只回 `updateCheck: 'skipped'`、不带错误文字；当前界面只在 `failed` 时读这句，看不出变化。
  Windows、Mac 不变。`system-service.facade.test.ts` 钉住。
- Linux 写进客户 `~/.bashrc` / `~/.zshrc` / `~/.profile` 和 fish `conf.d` 的那句注释不再列 gemini（Gemini CLI 10-14 下线），
  改成「claude / codex / grok」。卸载只撤一字不差的那一段，所以 `linux-shell-profile.ts` 记下旧写法
  （`previousProfileCommandLists`），以前写进去的那段卸载时照样认得、撤得掉；装的时候已有那段就不再补新写法的。
  `linux-shell-profile.test.ts` 钉住。`docs/LINUX.md` 状态更新到 10-26，去掉 Gemini 的几处。
