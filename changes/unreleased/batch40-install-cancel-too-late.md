## 用户

- 装好或更新好一个工具后、那一行写着「安装完成，正在同步账号 Key 并刷新状态」的那几秒，还有 Windows 上装好 Claude Code
  接着装 Git 的那一段，点「取消」现在直接说「这一步已经不能取消了。」，不再弹「这个工具当前没有正在进行的安装。」，工具照常装完。

## 开发

- 第四十批 C（第三十九批「不收」第 2 条）：首页、「安装卸载」页的一次安装比主进程那一段长。主进程装完，界面还要同步 Key、
  整轮重新检测；Windows 上装 Claude Code 时，主进程装完它还接着装 Git（`installGitAlongsideClaude`）。这两段那一行的「取消」
  还亮着，点了回的是 `install-cancellation.ts` 找不到句柄时那句「这个工具当前没有正在进行的安装。」。
- `App.tsx` 的 `install()` 多一个 `finishing` 标记，`toolsApi.install` 回来以后置上；`cancel` 和换装时卸载那一步一样直接回现成的
  「这一步已经不能取消了。」，不再问主进程。Codex 桌面端走同一个函数，一起改好。
- `system-service.ts` 的 `installCli`：Windows 上的 Claude Code 改由新的顶层函数 `finishClaudeInstallWithGit` 收尾。Claude Code
  那一项装成后先把取消句柄封住（`gitAlongsideClaudeSealReason`，还是那一句），Git 那段结束（装上、没装上都算）再从登记表注销；
  Claude Code 自己失败或被取消就不进 Git 这段，照旧马上注销。别的工具、别的平台照旧在出队时注销。Git 那段句柄还登记着，
  这时再装一次 Claude Code 会走「已登记」那一支、另排一次取消不了的安装；界面上 `useToolbox` 的 `run` 按工具加锁，碰不到，
  注释里写明了。装 Git 本身仍接不上取消（`installGitRuntime` 不收 signal），这次没动。
- 测试：`system-service.install-cancel.test.ts` 加四条：Git 那段取消被拒、也不真的停；Git 抛错也注销；Claude Code 自己被取消或
  失败时不装 Git、马上注销。注入的 platform 管不到 `installCliOperation` 里读真实 `process.platform` 的几处，在 Linux / macOS
  主机上走不通 Windows 那条安装，所以只测这一段，三个平台都跑。`app-check.mjs` 加首页和「安装卸载」页各一条：用 `holdNextScan`
  停在同步那几秒，点「取消」说「这一步已经不能取消了。」，也没有再调 `cancelCliInstall`，放开后照常装完。
