import fs from 'node:fs'
import type { App } from 'electron'
import { accelerationProxyJournalPath } from './acceleration-development-host'
import { windowsAppUserModelId } from './login-launch'
import { removeWindowsLoginItem } from './platform/system-service'
import { createWindowsSystemProxy } from './platform/windows-system-proxy'

// 卸载程序拉起这一支时，桌面进程和加速辅助进程都已经被它强行结束，辅助进程
// 来不及把系统代理改回去；系统代理还指着本机一个已经没人监听的端口，整台电脑
// 上不了网，而「下次启动本程序再恢复」那条路，软件卸掉以后就不存在了。

// 退出码按位记。卸载程序只把它写进详情，从不因此中止卸载：还原不了的代理、
// 删不掉的开机项，都不值得让用户卡在一个卸不掉的软件上。
export const uninstallCleanupExitCodes = {
  proxyNotRestored: 1,
  loginItemRemains: 2,
  timedOut: 4,
  unsupported: 8,
} as const

// 单次 PowerShell 放宽到 45 秒：卸载时 PowerShell 往往是冷启动，第一次编译
// WinInet 互操作代码在 CI runner 上实测超过辅助进程用的 15 秒。
const proxyCommandTimeoutMs = 45_000
// 还原最多是：等系统代理锁 12 秒，再加三次 PowerShell。正常几秒就完；
// 这个上限只防卸载界面一直停在「正在清理」。
const defaultTimeoutMs = 150_000

// 没有记录就说明这台电脑上本程序从没接管过系统代理（或者已经还原干净），
// 不必再起 PowerShell 去拿锁。lstat 不跟随链接：记录位置被换成链接时照样交给
// 恢复代码，由它按 I8 拒绝并报出来，而不是在这里当成「没有记录」悄悄跳过。
export function hasProxyRecoveryRecords(journalPath: string): boolean {
  return [journalPath, `${journalPath}.lock`].some((file) => {
    try {
      fs.lstatSync(file)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT'
    }
  })
}

export interface UninstallCleanupDependencies {
  dataDirectory: string
  recoverProxy(journalPath: string): Promise<void>
  removeLoginItem(): boolean
  proxyRecordsExist?: (journalPath: string) => boolean
  timeoutMs?: number
  // 卸载程序不接 stderr，客户机上这里没人看；接上它的只有 CI 冒烟和客服手工排查。
  report?: (line: string) => void
}

// 只带错误链上的消息，不带堆栈：消息是本仓自己写的固定中文或 runCommand 已脱敏的
// 输出（I13），堆栈里是安装路径。
export function describeCleanupFailure(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  while (current instanceof Error && messages.length < 4) {
    messages.push(current.message.slice(0, 300))
    current = current.cause
  }
  return messages.length ? messages.join(' <- ') : '未知错误'
}

export async function runUninstallCleanup(dependencies: UninstallCleanupDependencies): Promise<number> {
  const codes = uninstallCleanupExitCodes
  let code = 0
  // 开机项在前：它是一次同步的注册表删除，不能因为后面的代理还原超时而被跳过。
  try {
    if (!dependencies.removeLoginItem()) code |= codes.loginItemRemains
  } catch (error) {
    code |= codes.loginItemRemains
    try { dependencies.report?.(`login item: ${describeCleanupFailure(error)}`) } catch { /* Reporting must not change the result. */ }
  }
  const journalPath = accelerationProxyJournalPath(dependencies.dataDirectory)
  if (!(dependencies.proxyRecordsExist ?? hasProxyRecoveryRecords)(journalPath)) return code
  // recover() is the same compare-and-swap the worker replays after a crash:
  // it writes the recorded original back only while every proxy field still
  // equals what acceleration applied, so a proxy the user or another tool set
  // since then is left alone and only our lease is given up.
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    Promise.resolve().then(() => dependencies.recoverProxy(journalPath)).then(() => 0, (error: unknown) => {
      try { dependencies.report?.(`proxy: ${describeCleanupFailure(error)}`) } catch { /* Reporting must not change the result. */ }
      return codes.proxyNotRestored
    }),
    new Promise<number>((resolve) => {
      timer = setTimeout(() => resolve(codes.proxyNotRestored | codes.timedOut), dependencies.timeoutMs ?? defaultTimeoutMs)
    }),
  ])
  clearTimeout(timer)
  return code | outcome
}

/** Runs before `ready`: nothing here needs a window, a session or the profile,
 *  and exiting before Chromium starts its helper processes keeps the uninstaller
 *  from waiting on files they hold open. */
export function startUninstallCleanup(
  app: Pick<App, 'isPackaged' | 'getPath' | 'setAppUserModelId' | 'getLoginItemSettings' | 'setLoginItemSettings'>,
  exit: (code: number) => void,
  report?: (line: string) => void,
): void {
  // A development build shares the login item's name with the installed app,
  // so running this from a checkout would switch off the real one's autostart.
  if (!app.isPackaged) {
    exit(uninstallCleanupExitCodes.unsupported)
    return
  }
  app.setAppUserModelId(windowsAppUserModelId)
  void runUninstallCleanup({
    // The same default the desktop process reads (main.ts managerDataDirectory);
    // neither process renames the app or passes a profile switch.
    dataDirectory: app.getPath('userData'),
    recoverProxy: (journalPath) => createWindowsSystemProxy({ journalPath, commandTimeoutMs: proxyCommandTimeoutMs }).recover(),
    removeLoginItem: () => removeWindowsLoginItem({ app, executablePath: process.execPath }),
    report,
  }).then(exit, () => exit(uninstallCleanupExitCodes.proxyNotRestored))
}
