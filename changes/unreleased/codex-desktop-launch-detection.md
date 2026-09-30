## 用户

- Windows 上从星芒打开 Codex 桌面端，Codex 其实已经开了却报「没有创建进程」的情况修掉了；真打不开时，提示改成大白话，并给「重试」「找客服」两个按钮，不再让你去运行 wsreset.exe。

## 开发

- 打开 Codex 桌面端时判断「窗口起没起来」改用只按登录会话和安装包路径的探测（`buildCodexDesktopSessionProcessProbeScript`），不再沿用 #640 给关闭路径加的属主核对；重启、更新、卸载要关进程时仍走带属主核对、失败即停的那一套。
- 激活返回的 PID 探活把 `EPERM` 当作「还活着」；启动环境探测超时由 3 秒放宽到 10 秒，免得冷启动的 PowerShell 超时后丢掉内置 Administrator 的判断。
- 启动失败文案改为以「Codex 桌面端没有打开」开头的三句大白话，渲染层新增 `codexDesktopNotStarted` 归类（重试 / 找客服）。
