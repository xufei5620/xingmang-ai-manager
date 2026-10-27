// Windows 打包版带了白名单以外的开关时，platform/entry.ts 去掉它们重新打开一次
// （security.ts 的 resolvePackagedLaunchArguments，#1065）。重新打开的那个进程靠这个
// 环境变量认出自己：要是还带着不认识的开关，就直接退出，不会没完没了地重开。去掉的
// 是哪几个开关也跟着带过来，桌面起来以后写进运行日志：客户机上有我们没想到的正常
// 启动方式时，导出的日志里看得见，好补进白名单。
// 本文件不 import 任何东西：platform/entry.ts 在加载桌面模块之前就读它。
export const launchArgumentRelaunchEnvironmentKey = 'XINGMANG_RELAUNCHED_WITHOUT_SWITCHES'

const maximumNames = 8
// Only the switch names travel, never their values, and only in a shape that
// cannot carry a path or a sentence into the log.
const loggableSwitchName = /^[a-z0-9][a-z0-9._-]{0,39}$/

let relaunchedWithout: string[] | null = null

function loggableNames(names: readonly string[]): string[] {
  const shown = names.map((name) => loggableSwitchName.test(name) ? name : '?')
  return [...new Set(shown)].slice(0, maximumNames)
}

export function formatRelaunchedWithout(dropped: readonly string[]): string {
  const names = loggableNames(dropped)
  // An empty value is not a dependable environment variable on Windows.
  return names.length > 0 ? names.join(',') : '?'
}

/**
 * Reads the marker and removes it from `env` whether or not it was there, so
 * nothing this process starts later inherits it. Returns the dropped switch
 * names when this process is such a relaunch, or null.
 */
export function takeLaunchArgumentRelaunch(env: NodeJS.ProcessEnv): string[] | null {
  const value = env[launchArgumentRelaunchEnvironmentKey]
  delete env[launchArgumentRelaunchEnvironmentKey]
  relaunchedWithout = value === undefined ? null : loggableNames(value.split(','))
  return relaunchedWithout
}

/** What `takeLaunchArgumentRelaunch` found at startup, for the runtime log. */
export function launchArgumentsRelaunchedWithout(): readonly string[] | null {
  return relaunchedWithout
}
