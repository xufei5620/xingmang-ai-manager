## 开发

- 复查 A 第 1 轮第 4 条：Mac 上 `~/.zprofile`（或 bash 读的那个启动文件）是 dotfiles 的链接、有硬链接时，Antigravity 桌面端打不开，
  安装桌面端也报「设置没写成」。原因是打开、安装桌面端前写设置那一步一律要求在启动文件末尾加上那一段，写不进（I8 拒绝跟随链接）就整步失败，
  可桌面端的设置是由打开的那一步直接放进它的环境里的，用不上那个文件。
  `writeMacosAntigravityEnvironment` 新加可选的 `startupFileOptional`（缺省照旧失败）：设上时启动文件写不进只交给 `skipped`、
  结果标 `profile: 'skipped'`，两份设置文件照写，链接和它指向的文件都不动；`antigravity-service.ts` 为桌面端写设置时设上，
  日志事件 `antigravity.settings.fish-skipped` 改名 `antigravity.settings.profile-skipped`（现在两种文件都走它）。
  命令行照旧要求那一段（Mac 的「终端」从那里读设置），没有跟随链接、也没放宽 I8。
