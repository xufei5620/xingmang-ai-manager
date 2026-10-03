## 用户

- Windows 上没用管理员身份打开星芒时更新 Claude Code、Codex：网络不稳、主程序没下载完整的那一次，现在会自动换另一个下载源
  再下，正在用的旧版不会被动。以前可能把装不全的新版直接写进去，结果工具打不开。
- 同样的情况下，进度走到「正在安装到本机」时点「取消」，会提示等这一步做完，不再中途掐断（以前掐断会让工具打不开）。
  下载那一段照旧可以取消。
- Windows 上一键装 Python、Node.js 时，先直接用系统自带的应用安装组件，不再先等下载加速准备好（以前最多会白等十来秒）；
  它装不上、改下官方安装包时才用加速。
- 装 Gemini CLI 不再要求先装 Python：Windows 上不再顺带多装一个 Python，Mac 上没有 Python 也能直接装。
  首页运行环境里 Python 那一行和按钮还在，外接工具里个别连接用得上。

## 开发

- 第二十八批 A：`electron/system-service.ts` 的 `runCliInstall`。Windows 普通权限（same-user）那条路没有暂存目录，
  `npm install --global` 直接写进正在用的全局目录；以前平台主程序包（`@anthropic-ai/claude-code-win32-*`、
  `@openai/codex-win32-*`）缺没缺要写完才查，查出缺了也不换源，旧版已经被盖掉。现在 `npm ci` 之后、写入之前先在
  resolution 的 `node_modules` 里查（`findMissingCliNativePackage`），缺了记成这个源失败、换下一个源；写完后那两道
  检查照旧留着兜底。托管那条路（Windows 管理员身份、macOS、Linux）也先查，省掉一次注定装不全的复制和安装，结果不变；
  Grok 的两条 npm 通道照旧在自己的安装事务里核对。
- 第二十八批 B：同一条路上，`lifecycle()` 那一段用 `managedPrefixSwapSealReason` 封住取消（Windows 的取消是
  `taskkill /T /F`，npm 挪开的旧版来不及挪回去）。这个源没装成就解封，换下一个源时下载照样能取消；装成了就一直封到
  结束，和托管那条路换进去以后一样。
- 第二十八批 D：Windows 上装 Python（`python-runtime.ts`）、Node.js（`node-runtime.ts`）不再整段包在
  `withDownloadAcceleration` 里。winget 自己下载、不走下载专用线路，以前先等线路（`acquireDownloadAcceleration`，最长
  12 秒）再试 winget 是白等。两个安装器多一个可选的 `withDownloadRoute`，退到下安装包时才借：Python 只在查版本、
  下载这两步握着，Node.js 握着 MSI 那一轮。`InstallNodeRuntimeOptions.networkRegion` 可以给函数，借到线路以后才问
  （借到了就官方源优先，和以前整段借线路时一样）。macOS、Linux 装 Node.js 仍整段借线路，行为不变；CLI 安装里顺带
  自动装 Node.js 那条路本来就在 CLI 安装的线路里，没动。
- 第二十八批 C：`electron/platform-capabilities.ts` 的 `cliNeedsPythonRuntime` 里 Gemini 三个平台都是 false（Linux
  版拆分 ③ 先去掉了 Linux）。Gemini 要 Python 只为现场编译可选依赖 `node-pty` / `@github/keytar`，编不出来 npm
  照样装完；终端那块用的 `@lydell/node-pty` 有 win32-x64/arm64、darwin-x64/arm64 的现成包（0.60.0 的
  optionalDependencies，没在 Windows、Mac 真机跑过）。渲染层 `planCliInstall` 因此不再把 Python 排进 Gemini 的
  安装、Mac 上不再拦，新手引导选 Gemini 时不再出 Python 那一行。教程「进阶：安装与使用命令行工具」「Mac 上准备 Node.js 和 Python」、Mac 首页缺 Python
  那段（`runtime-install-guide.ts`）的文字跟着改；注册表的 `requires` 和这几处 Python 分支留作没报表时的旧行为。
