## 用户

- Windows：这台电脑没有 Git 时，首页「运行环境」里点「安装 Git」，星芒会自动下载装好，不用再去官网找安装包，也不用管理员权限。下载先走国内镜像，不通再换官方地址，装之前会核对安装包和官方发布的一致。
- 缺 Git 时的说明改成了大白话，只讲会影响什么、点哪里装。

## 开发

- 新增 `electron/git-runtime-install.ts`：钉死 Git for Windows 2.55.0.5（`v2.55.0.windows.5`）与 x64 / arm64 安装包的 SHA-256，npmmirror 与 GitHub 发布两路按地区排序（同 Node.js），重定向只放行镜像与 GitHub 发布资源主机。普通权限下用 Inno Setup 静默参数加 `/DIR=%LOCALAPPDATA%\Programs\Git` 按当前用户安装；以管理员身份运行时不给 `/DIR`，避免系统 PATH 指向普通用户可写目录。
- 新 IPC `runtime:install-git` 与进度事件 `runtime:git-install-progress`（排在 `runtime:install-python` 之后），经 `InstallationQueue` 的 `runtime:git` 与下载加速。
- `command-runner.ts` 的兜底 PATH 补上两处 Git 的 `cmd` 目录，装完不用重开本软件就能被检测到、被从本软件打开的 Claude Code 找到。
- `git-runtime.ts` 的 Windows 文案改为指向「安装 Git」，面向客户的缺 Git 提示不再出现 PowerShell、bash、网址；macOS 行为不变。
