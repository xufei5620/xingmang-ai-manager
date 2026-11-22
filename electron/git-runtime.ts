// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * Git is optional for this product. On Windows the app installs it on request
 * (git-runtime-install.ts, a pinned Git for Windows for the current user); on
 * macOS it opens Apple's own Command Line Tools installer (macos-git-install.ts);
 * elsewhere it only explains how. It still changes what a customer gets. On native Windows Claude Code uses
 * the bash that ships with Git for Windows for its Bash tool; without it the CLI
 * falls back to the PowerShell tool, so every bash command written inside a
 * skill or a plugin fails (https://code.claude.com/docs/en/setup). Registering
 * the official plugin marketplace is a `git clone`, which is the one place this
 * repository already had to explain a missing Git (provider-extensions.ts, #277).
 *
 * 所以这一份文案是插件市场、首页运行环境、检查页三处共用的**唯一**来源：缺 Git
 * 时到底会发生什么、怎么装上，只在这里写一遍。
 *
 * 这个模块刻意零依赖（同 acceleration-contract.ts），渲染层可以直接引它，不必再
 * 抄一份中文提示。
 */

/** 只区分文案真正需要分叉的三种宿主。 */
export type GitHostPlatform = 'windows' | 'macos' | 'other'

/**
 * 主进程给的是 `process.platform`（win32 / darwin），渲染层手上是
 * `PlatformCapabilities.platform`（windows / macos）。两种写法都收在这里，
 * 免得调用方各自转换一次。
 */
export function gitHostPlatform(platform: string = process.platform): GitHostPlatform {
  if (platform === 'win32' || platform === 'windows') return 'windows'
  if (platform === 'darwin' || platform === 'macos') return 'macos'
  return 'other'
}

/**
 * Windows 官方下载页；外链白名单里也是这一条（I12 全等匹配）。2026-09-24 起首页
 * 改为代装，界面不再引导客户来这里，留着白名单只为不破坏已经存在的外链。
 */
export const gitWindowsDownloadUrl = 'https://git-scm.com/download/win'

/** Linux 上装 Git 的那一条命令；教程页和提示必须是同一个字符串。 */
export const gitLinuxInstallCommand = 'sudo apt install -y git'

/** 「怎么装上」这一句，句末不带标点，便于拼进更长的提示里。 */
export function gitInstallGuidance(platform: string = process.platform): string {
  const host = gitHostPlatform(platform)
  if (host === 'windows') return '请点击首页「运行环境」中的「安装 Git」，星芒将自动下载并安装，无需管理员权限'
  if (host === 'macos') return '请点击首页「运行环境」中的「安装 Git」，Mac 将弹出系统安装窗口，点击其中的“安装”即可'
  // Linux 只出 deb，装得上星芒的系统（Ubuntu、Debian、deepin、统信、麒麟）都用 apt。
  return `请打开「终端」，输入 ${gitLinuxInstallCommand} 并回车，提示输入密码时请输入开机密码（输入时屏幕不显示，输完后回车）`
}

/**
 * 缺 Git 时用户实际会遇到什么。Windows 上 Claude Code 没有 Git 自带的 bash 就退回
 * PowerShell，技能和插件里写的 bash 命令跑不起来；这件事用客户听得懂的话说，
 * 不出现 PowerShell、bash 这类词（yoyo 2026-09-24）。macOS 上 Claude Code 本来就用
 * 系统自带的 shell，没有这一条。
 */
export function gitMissingImpact(platform: string = process.platform): string {
  return gitHostPlatform(platform) === 'windows'
    ? 'Claude Code 的部分功能以及技能和插件中的部分命令将无法使用，首次安装官方插件市场也需要 Git'
    : '首次安装官方插件市场需要 Git，部分技能和插件中的命令也会用到 Git'
}

/** 运行环境行与检查页共用的整句提示。 */
export function gitMissingNotice(platform: string = process.platform): string {
  return `本机未找到 Git。${gitMissingImpact(platform)}。${gitInstallGuidance(platform)}。`
}

/**
 * 首页运行环境卡里、「安装 Git」按钮正上方那一段。按钮就在眼前，所以直接说「点「安装 Git」」，
 * 不再绕回「首页运行环境」；没有按钮的平台与整句提示相同。原来约 6 行橙字压在窄窄的右栏里，
 * 照 yoyo 2026-10-04 点过头的清单改短到两行左右；检查页那句完整说明不动。
 */
export function gitMissingHomeNotice(platform: string = process.platform): string {
  const host = gitHostPlatform(platform)
  if (host === 'windows') {
    return '缺少 Git 时，Claude Code 的部分功能及部分技能、插件将无法使用。请点击「安装 Git」自动安装，无需管理员权限。'
  }
  if (host === 'macos') {
    return '缺少 Git 时，将无法安装官方插件市场，部分技能、插件也将无法使用。请点击「安装 Git」，并在系统弹出的窗口中点击“安装”。'
  }
  return gitMissingNotice(platform)
}

/** 装完 Claude Code 之后那张卡下面的一行小字，短到能跟命令挤在一屏里。 */
export function gitMissingFirstRunHint(platform: string = process.platform): string {
  return `本机未安装 Git，建议先安装：${gitInstallGuidance(platform)}。`
}

/**
 * macOS 上点了「安装 Git」之后，按钮下面那一行（macos-git-install.ts 也拿它当进度文字）。
 * 苹果的窗口不回报结果，所以要说清楚：点「安装」的是客户，之后的检查由星芒来做。
 */
export const gitMacInstallWaitingHint = '请在系统弹出的窗口中点击“安装”。安装完成后，星芒将自动重新检查。'
