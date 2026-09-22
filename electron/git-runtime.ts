/**
 * Git is optional for this product, and deliberately so: the app never installs
 * it. It still changes what a customer gets. On native Windows Claude Code uses
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

/** Windows 官方下载页；外链白名单里也是这一条（I12 全等匹配）。 */
export const gitWindowsDownloadUrl = 'https://git-scm.com/download/win'

/** 「怎么装上」这一句，句末不带标点，便于拼进更长的提示里。 */
export function gitInstallGuidance(platform: string = process.platform): string {
  const host = gitHostPlatform(platform)
  if (host === 'windows') return `请到 ${gitWindowsDownloadUrl} 下载 Git 安装包装上`
  if (host === 'macos') return '请在「终端」里运行 xcode-select --install，或者用 Homebrew 执行 brew install git'
  return '请用系统的包管理器装上 Git'
}

/**
 * 缺 Git 时用户实际会遇到什么。PowerShell 那条只在 Windows 成立：macOS 上
 * Claude Code 本来就用系统自带的 shell，不会退回 PowerShell，照抄过去是假话。
 */
export function gitMissingImpact(platform: string = process.platform): string {
  return gitHostPlatform(platform) === 'windows'
    ? 'Claude Code 会改用 PowerShell 执行命令，技能和插件里写的 bash 命令会失败；第一次装官方插件市场也需要它'
    : '第一次装官方插件市场需要它，部分技能和插件里写的命令也会用到它'
}

/** 运行环境行与检查页共用的整句提示。 */
export function gitMissingNotice(platform: string = process.platform): string {
  return `这台电脑上没有找到 Git。${gitMissingImpact(platform)}。${gitInstallGuidance(platform)}。`
}

/** 装完 Claude Code 之后那张卡下面的一行小字，短到能跟命令挤在一屏里。 */
export function gitMissingFirstRunHint(platform: string = process.platform): string {
  return `这台电脑没有 Git，建议先装上：${gitInstallGuidance(platform)}。`
}
