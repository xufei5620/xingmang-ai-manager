## 用户

- 在共用电脑安装、更新、卸载或重启 Codex 桌面端时，只识别并关闭当前 Windows 账户、当前会话和目标安装包的进程，避免其他账户或 Beta 版本干扰操作。仅安装 Beta 时，正式版更新入口会明确提示不支持。

## 开发

- Codex Desktop 进程探测校验 owner SID、SessionId 与包家族；无法确认 owner 的进程不进入终止列表。关闭后的等待与强关只检查最初选中的 PID，并移除 taskkill 的未核验子进程树选项。Stable 安装源不会把 Beta 当成更新目标（#598）。
