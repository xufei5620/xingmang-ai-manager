## 用户

- Windows 上在自己打开的 PowerShell 里敲 `claude`、`codex`、`gemini` 不再报「禁止运行脚本」，和命令提示符里一样直接就能用，不用改任何系统设置。装好或更新工具后新开一个终端即可。

## 开发

- 「可能没想到的问题」第 13 条：npm 的 cmd-shim 给每个全局命令同时写 `.cmd` 和 `.ps1`，PowerShell 优先挑 `.ps1`，客户端 Windows 默认执行策略 Restricted 直接拦下。新模块 `electron/windows-cli-shell-access.ts`：装完、更新完以及每次启动后的第一轮检测，删掉四家 CLI 的 npm `.ps1` 启动文件，只留 `.cmd`（只删内容确认是 cmd-shim 为该包写的、旁边有 `.cmd`、单链接普通文件、路径上无联接的那一个）。不改执行策略、不提权；以管理员身份运行时只碰 ProgramData 托管目录。
- 装完/更新完再确认工具目录在当前用户 PATH 里（用户或系统 PATH 已有就不动，进程继承的 PATH 已有时连 PowerShell 都不起）；没有才追加到用户 PATH 末尾。按原始注册表值读写保留 `%VAR%` 写法与 REG_EXPAND_SZ 类型，再广播 WM_SETTINGCHANGE 让新开的终端生效。只由 `main.ts` 经 `ensureWindowsUserPath` 接入，测试缺省不改 PATH。
- 首页「试试第一条命令」与教程的文案改成「新开一个终端」。
- 清理 `.ps1` 与补 PATH 这段逻辑拆成 `createCliTerminalAccess`（`windows-cli-shell-access.ts`），`system-service.ts` 只负责调用；原先在 Windows 上跳过的扫描级用例换成直接测这块的用例，所有平台都跑，不再触发本机 PowerShell 探测。
