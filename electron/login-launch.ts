// 勾了「开机自动启动」的人几乎都是为了托盘里的东西（余额、加速、Codex 桌面端
// 联动），不是为了每天开机先看一眼首页。所以系统在开机时拉起的那一次，窗口留在
// 托盘里不弹；用户自己双击图标、从开始菜单或 Dock 打开时照常弹窗。

// Windows 的开机项是注册表 Run 键里的一条命令行，只有带上这个参数，程序才分得清
// 「系统开机拉起」和「用户自己点开」。macOS 13 起登录项走 SMAppService，不再能带
// 参数，那边改读系统给的登录启动标记。
export const loginLaunchArgument = '--launched-at-login'

// Windows 开机项的名字默认取 AppUserModelId。桌面进程和卸载清理进程必须用同一个，
// 否则清理进程按名字删的是另一条，开机项原样留着。与 electron-builder 的 appId 一致。
export const windowsAppUserModelId = 'com.xingmang.ai.manager'

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

// 开机那一两分钟系统、杀毒、网盘、输入法都在抢资源。开机拉起时窗口本来就藏在托盘
// 里，工具检测（Windows 上要起好几段 PowerShell）、检查更新、账号 Key 初始化这几件
// 后台事都等到用户第一次点开窗口，或开机过了这么久再做。用户点开窗口后和现在一样。
export const loginQuietPeriodMs = 3 * 60_000

export type LoginQuietPeriodEnd = 'window-shown' | 'timeout'

export interface LoginQuietPeriodOptions {
  active: boolean
  durationMs: number
  onEnd?(reason: LoginQuietPeriodEnd): void
}

export interface LoginQuietPeriod {
  active(): boolean
  // 安静期结束时兑现；不在安静期里时立刻兑现。永不拒绝。
  whenOver(): Promise<void>
  end(reason: LoginQuietPeriodEnd): void
}

export function createLoginQuietPeriod(options: LoginQuietPeriodOptions): LoginQuietPeriod {
  let active = options.active
  let release: () => void = () => undefined
  const over = active ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  function end(reason: LoginQuietPeriodEnd) {
    if (!active) return
    active = false
    if (timer) clearTimeout(timer)
    timer = undefined
    release()
    options.onEnd?.(reason)
  }
  if (active) {
    timer = setTimeout(() => { end('timeout') }, Math.max(0, options.durationMs))
    // 定时器不该拖住退出：用户在安静期里从托盘退出时进程照常结束。
    timer.unref?.()
  }
  return {
    active: () => active,
    whenOver: () => over,
    end,
  }
}
