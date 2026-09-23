## 用户

- 没有以管理员身份打开软件时，开机不再为「确认是不是管理员」这一步等上几秒到十几秒，窗口出来得更快；电脑较慢或刚开机时也不会再因为这一步超时被当成管理员、装不了工具。

## 开发

- `resolveWindowsCliExecutionModeDetailed` 先用 `System32\whoami.exe /groups /fo csv /nh` 读当前令牌的强制完整性标签（`inspectCurrentWindowsIntegrityRid` / `parseWindowsMandatoryLabelRid`）：低于 High（S-1-16-12288）的令牌不可能是提升后的完整令牌，直接判 same-user，不再启动 PowerShell 编译 `Add-Type` 探测。High 及以上、标签读不出或 whoami 失败时照旧走原探测，原探测失败照旧从严按 trusted-only。主窗口创建前等的就是这一步，0.2.9 里已经如此（`main.ts` 在建窗口前 await 这个探测，探测上限 15 秒）。
