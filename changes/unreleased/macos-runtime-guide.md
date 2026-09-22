## 用户

- macOS 上缺 Node.js 或 Python 时，首页不再只甩一个英文官网链接：直接给中文步骤，
  Homebrew 一条命令可一键复制，也可以点按钮去官网下 .pkg 安装包，并写清装完回首页
  点「重新检测」。教程新增一节「Mac 上装 Node.js 和 Python」。命令仍由你自己在终端
  执行，星芒不代装、不要管理员密码。

## 开发

- 新增 `src/renderer-v2/features/tools/runtime-install-guide.ts`：按 `PlatformCapabilities`
  的 `nodeRuntimeInstall` / `pythonRuntimeInstall` 出按钮文案与中文步骤，`managed`（Windows）
  返回 null 保持旧行为，`external` 分 macOS（Homebrew + .pkg 两条路）与其他平台（包管理器）。
  首页与教程共用同一份 Homebrew 命令字符串，`pages-maintenance.test.ts` 钉住两处一致。
- 新增 `RuntimeInstallHint.tsx` 渲染步骤与可复制命令（剪贴板失败有回音，同 FirstRun）；
  `Home.tsx` 的运行环境卡按 external 能力插入这段提示，并在缺环境时多一颗「看教程」按钮，
  原官网按钮保留、文案改为「去官网下载 …」。`App.tsx` 的 `installRuntime` 未改动。
- `pages-maintenance.tsx` 的 `tutorialTopics` 新增 `runtime-mac` 章节（四步：看缺哪个、
  Homebrew、官网安装包、回来重新检测）。Windows 一侧文案与行为均未变。
