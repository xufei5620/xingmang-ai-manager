import fs from 'node:fs'
import path from 'node:path'
import type { App } from 'electron'
import { accelerationProxyJournalPath } from './acceleration-development-host'
import { windowsAppUserModelId } from './login-launch'
import { removeWindowsLoginItem } from './platform/system-service'
import { createWindowsSystemProxy } from './platform/windows-system-proxy'
import { removeSafeDataFile } from './safe-local-data'
import { uninstallClearLoginArgument } from './uninstall-cleanup-entry'

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
  loginRecordsRemain: 16,
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

// 卸载页「同时清除登录记录」删的就是这几样：能让下一个用这台电脑的人重装后
// 直接进到这个账号的东西——当前登录态、本机保存的账号、记住的密码（两个站点
// 各一份）。本机 Key 缓存和 CLI 配置里的 Key 不在其内：退出登录也保留本机 Key，
// 这里跟它一致。名字与 main.ts、realm-account-vault-file.ts、realm-data-roots.ts
// 里的写法一一对应，uninstall-cleanup.test.ts 钉住。
const loginRecordFileNames = ['account-session.dat', 'saved-accounts.dat', 'realm-accounts-v2.dat', 'account-credentials.dat']
// 账号库读不出来时恢复代码留下的副本，里面同样是加密的登录态。
const unreadableVaultBackupPattern = /^realm-accounts-v2\.dat\.unreadable-[\w.-]+\.bak$/

export function loginRecordFiles(dataDirectory: string, entries: readonly string[]): string[] {
  return [
    ...loginRecordFileNames.map((name) => path.join(dataDirectory, name)),
    ...entries.filter((name) => unreadableVaultBackupPattern.test(name)).map((name) => path.join(dataDirectory, name)),
    path.join(dataDirectory, 'realms', 'api-account', 'account-credentials.dat'),
  ]
}

// Goes through removeSafeDataFile (I8): the uninstaller runs elevated, so a
// data directory or file swapped for a link must be refused, never followed.
// Every file is attempted even after one fails, so one refusal does not leave
// the rest of the login behind.
export async function clearLoginRecords(dataDirectory: string, report?: (line: string) => void): Promise<boolean> {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dataDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return true
    // Without a listing only the fixed names are tried; the backups stay.
    try { report?.(`login records: ${describeCleanupFailure(error)}`) } catch { /* Reporting must not change the result. */ }
  }
  let cleared = true
  for (const file of loginRecordFiles(dataDirectory, entries)) {
    try {
      await removeSafeDataFile(file, '登录记录')
    } catch (error) {
      cleared = false
      try { report?.(`login records: ${describeCleanupFailure(error)}`) } catch { /* Reporting must not change the result. */ }
    }
  }
  return cleared
}

export interface UninstallCleanupDependencies {
  dataDirectory: string
  recoverProxy(journalPath: string): Promise<void>
  removeLoginItem(): boolean
  // 只有卸载页勾了「同时清除登录记录」才给；缺省 = 保留登录，跟以前一样。
  clearLoginRecords?: () => Promise<boolean>
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
  // 也排在代理还原前面：还原可能一直等到超时，删登录记录不该跟着被跳过。
  if (dependencies.clearLoginRecords) {
    try {
      if (!await dependencies.clearLoginRecords()) code |= codes.loginRecordsRemain
    } catch (error) {
      code |= codes.loginRecordsRemain
      try { dependencies.report?.(`login records: ${describeCleanupFailure(error)}`) } catch { /* Reporting must not change the result. */ }
    }
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
  argv: readonly string[] = process.argv,
): void {
  // A development build shares the login item's name with the installed app,
  // so running this from a checkout would switch off the real one's autostart.
  if (!app.isPackaged) {
    exit(uninstallCleanupExitCodes.unsupported)
    return
  }
  app.setAppUserModelId(windowsAppUserModelId)
  // The same default the desktop process reads (main.ts managerDataDirectory);
  // neither process renames the app or passes a profile switch.
  const dataDirectory = app.getPath('userData')
  void runUninstallCleanup({
    dataDirectory,
    recoverProxy: (journalPath) => createWindowsSystemProxy({ journalPath, commandTimeoutMs: proxyCommandTimeoutMs }).recover(),
    removeLoginItem: () => removeWindowsLoginItem({ app, executablePath: process.execPath }),
    clearLoginRecords: argv.includes(uninstallClearLoginArgument) ? () => clearLoginRecords(dataDirectory, report) : undefined,
    report,
  }).then(exit, () => exit(uninstallCleanupExitCodes.proxyNotRestored))
}
