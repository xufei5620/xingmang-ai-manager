## 用户

- Mac 上没有 Node.js 时，首页运行环境卡的按钮改成「准备 Node.js」：点一下，星芒会下载官方版本放在自己的文件夹里，不用开终端、不用输开机密码，也不影响电脑上别的软件。装命令行工具时缺 Node.js 也会自动先准备好。电脑上本来就有 Node.js 的，照旧用你自己的那份。
- Mac 上没有 Git 时，首页也有「安装 Git」按钮了：点了会弹出苹果自己的安装窗口，在里面点“安装”，装完星芒会自己再检查一次；在苹果窗口里点了取消，首页会说一声，需要时再点一次就行。
- 原来的 Homebrew 命令和官网下载挪进教程「Mac 上准备 Node.js 和 Python」，给想自己装的人。

## 开发

- 新增 `electron/macos-node-runtime.ts`：macOS 上 `runtime:install-node` 从 npmmirror / nodejs.org（沿用 `node-runtime.ts` 的来源白名单与重定向校验）取最新 LTS 的 `darwin-<arch>.tar.gz`，对 SHASUMS256，用 `/usr/bin/tar` 解到 `~/Library/Application Support/XingMangAI/Runtime/node`，再用 `codesign` 按 Node.js 的 Developer ID（`HX7739G8FX`）核 `bin/node` 的签名、核版本号，最后整目录换上（失败保留旧的）。`platform-capabilities.ts` 的 macOS `nodeRuntimeInstall` 改为 `managed`，Python 仍 `external`；Windows 不变。
- 托管 Node 的 `bin` 排在 `darwinCommandPathCandidates` 与 darwin `trustedCommandEnvironment` 的最后，不顶掉用户自己的 Node。`node-runtime.ts` 的 `parseNodeReleaseIndex` 加 `kind` 参数（缺省仍认 Windows MSI），下载与取文本的内部函数导出给 macOS 复用，`NodeRuntimeInstallResult.method` 加 `'archive'`。
- 新增 `electron/macos-git-install.ts`：macOS 上 `runtime:install-git` 只把 `xcode-select --install` 排进安装队列，之后每 5 秒看一次 `/usr/bin/git` 背后那份能不能用、苹果的安装程序还在不在，判出装好 / 取消 / 一分钟都没看到安装程序 / 一小时超时。`GitRuntimeInstallResult.installed` 放宽为 `boolean`，`action` 加 `'cancelled' | 'pending'`，并带 `message` 给首页。
- `git-runtime.ts` 与 `commandLineToolsShimNotice('git')` 的 Mac 文案改为指向「安装 Git」按钮，不再叫客户开终端。
- 没在真 Mac 上试过：苹果安装程序的进程名、它要不要管理员密码、普通账号能不能装、下载要多久；下载的 Node.js 会不会被系统拦（推测不会，本软件自己下载的文件不带隔离标记）。Node.js 的签名团队号由 macOS CI 上那条用 setup-node 的官方 Node 核对的测试确认。
