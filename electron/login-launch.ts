// 勾了「开机自动启动」的人几乎都是为了托盘里的东西（余额、加速、Codex 桌面端
// 联动），不是为了每天开机先看一眼首页。所以系统在开机时拉起的那一次，窗口留在
// 托盘里不弹；用户自己双击图标、从开始菜单或 Dock 打开时照常弹窗。

// Windows 的开机项是注册表 Run 键里的一条命令行，只有带上这个参数，程序才分得清
// 「系统开机拉起」和「用户自己点开」。macOS 13 起登录项走 SMAppService，不再能带
// 参数，那边改读系统给的登录启动标记。
export const loginLaunchArgument = '--launched-at-login'

export function hasLoginLaunchArgument(argv: readonly unknown[]): boolean {
  return argv.some((argument) => argument === loginLaunchArgument)
}

export interface LoginLaunchInput {
  platform: string
  argv: readonly unknown[]
  // app.getLoginItemSettings().wasOpenedAtLogin，只在 macOS 上有意义；读失败按
  // 「不是开机启动」处理，最坏也只是照旧弹一次窗口。
  wasOpenedAtLogin: () => boolean
}

export function resolveLoginLaunch(input: LoginLaunchInput): boolean {
  if (hasLoginLaunchArgument(input.argv)) return true
  if (input.platform !== 'darwin') return false
  try {
    return input.wasOpenedAtLogin() === true
  } catch {
    return false
  }
}

export interface InitialWindowRevealInput {
  launchedAtLogin: boolean
  // 托盘建不起来时用户就没有别的入口能找回窗口了，这时宁可照旧弹窗。
  trayAvailable: boolean
}

export function shouldRevealInitialWindow(input: InitialWindowRevealInput): boolean {
  return !input.launchedAtLogin || !input.trayAvailable
}
