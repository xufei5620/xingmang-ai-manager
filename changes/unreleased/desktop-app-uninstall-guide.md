## 用户

- Claude Desktop、OpenCode、WorkBuddy 的卡片「…」里有了「卸载…」，Mac 上的 Codex 桌面端也有，点了会告诉你在系统里怎么删。

## 开发

- 首页卡片「…」给星芒卸不了的桌面端（三个外接客户端、Mac 上的 Codex 桌面端）加「卸载…」，点了弹 `UninstallGuideDialog`，按 Windows / Mac 说在系统里怎么删，星芒自己不卸、不加 IPC。Windows 上的 Codex 桌面端照旧走 `desktop:uninstall-codex`。外接客户端从来没有卸载通道，0.2.18「安装卸载」页也没列它们，换界面后客户以为是漏了。
- 测试夹具 `app-fixture.tsx` 的 Codex 桌面端改成和主进程一样：状态不带 `uninstall`，`codexDesktop.uninstall` 在 Mac 上为假。
