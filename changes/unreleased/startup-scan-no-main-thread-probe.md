## 用户

- 以管理员身份打开软件时，开机那几秒不会再因为后台检测工具而点不动、关不掉窗口。

## 开发

- Program Files 权限检查（`inspectProgramFilesAcl`，同步起 PowerShell）在管理员令牌（`trusted-only`）下的首页检测里一轮冷启动要跑 5 次上下，
  占住主线程。新增 `primeTrustedWindowsMachinePath`：从异步代码里先用同一段脚本、同样的超时和输出上限异步探测，结论经
  `validateWindowsMachineAclSnapshot` 写进同一份 5 分钟缓存，随后的同步检查只读缓存；探测失败照旧记为不可信。它自己不做任何放行判断，
  没预热到的路径同步检查照旧自己探。接入点：`isUserWritableResolvedPath`（`runCommand` 的 trustedOnly 路径与参数）、`findExecutable`
  的注册表 Node 目录、`executeVersion` 与 npm 探测前的 `primeTrustedHighIntegrityExecutable`。
- 注册表里的 Node 安装目录（`reg.exe` 两次）改为异步查询。
- 开机预热检测只在有账号要恢复时跑（`vault.active()`），没有账号的新用户落在欢迎页，本来不检测。
- `realm-account-smoke.mjs` 新增「恢复已保存账号时关窗 5 秒内退出」一步。
