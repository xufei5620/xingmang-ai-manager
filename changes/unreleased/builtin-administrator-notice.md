## 用户

- 用系统自带管理员账号登录的 Windows 电脑（很多装机版系统默认就是这个账号），「检查」页「运行权限」不再一直提示「建议普通启动」，改成一句说明：这个账号本身就带管理员权限，软件已按平常方式运行，不用处理。

## 开发

- `electron/diagnostics.ts` 的 `ADMINISTRATOR` 检查：当前令牌是高权限、但启动探测成功且定为 `same-user`（TokenElevationType 为 default，即内置 Administrator 或关了 UAC）时改为 `pass`，details 带 `alwaysElevated: true`。这种账号没有普通启动可选，0.2.8 起就一直挂着 warn。只改检查页说法；`resolveWindowsCliExecutionModeDetailed` 的判定、写 Key 与搬盘的拦截条件都没动。启动探测失败、或确认是专门提权打开的（`trusted-only`），仍照旧提示普通启动。
