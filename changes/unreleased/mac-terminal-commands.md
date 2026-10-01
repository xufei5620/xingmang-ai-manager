## 用户

- Mac 上装好、修复或更新命令行工具后，自己新开的「终端」里也能直接敲 claude、codex、gemini、grok 启动了，和 Windows 一样；以前只能从星芒首页点「打开」。以前装过的，升级后打开一次星芒就会补上。

## 开发

- 新增 `electron/macos-shell-profile.ts`：Mac 上装完 / 更新 CLI 后往当前用户的 `~/.zprofile` 末尾追加一段带标记的 PATH 设置（托管 npm bin、`~/.grok/bin`、星芒代下的 Node，全部追加在原 PATH 之后，`case` 防重复），已有标记就不动；只追加不重写，经 `readSafeUtf8File` / `appendSafeUtf8File`，`~/.zprofile` 是符号链接或多链接时拒绝并只记日志（I8）；登录 shell 不是 zsh 的不写（建 `~/.bash_profile` 会让 bash 不再读 `~/.profile`）。
- 打开软件后的第一轮检测：Mac 上检测到星芒托管目录里的安装且从没处理过时补一次，处理过就在产品目录留 `terminal-commands-added` 记录，客户自己删掉那段后不会每次开软件又加回来；装、修复、更新工具时照常再确认。
- 卸载工具时不删这段：指向不存在目录的 PATH 项无害，重装后直接可用，也和 Windows 卸载托管工具不改 PATH 一致。
- `createCliTerminalAccess` 加 `ensureShellProfile`，`system-service.ts` 新选项 `ensureMacosShellProfile` 只由 `main.ts` 在 darwin 接真实现；失败只记 `cli.shell-profile.failed`，不影响安装结果。
