import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { App } from 'electron'
import { accelerationProxyJournalPath } from './acceleration-development-host'
import { trustedCommandEnvironment } from './command-runner'
import { windowsAppUserModelId } from './login-launch'
import { removeWindowsLoginItem } from './platform/system-service'
import { createWindowsSystemProxy } from './platform/windows-system-proxy'
import { removeSafeDataFile } from './safe-local-data'
import { uninstallClearLoginArgument } from './uninstall-cleanup-entry'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'
import { resolveWindowsMachinePaths } from './windows-machine-paths'

const execFileAsync = promisify(execFile)

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
  // 跑卸载的不是桌面上登录着的那个人，什么都没动（#498）。
  otherAccount: 32,
} as const

// 单次 PowerShell 放宽到 90 秒：卸载时 PowerShell 往往是冷启动，第一次编译
// WinInet 互操作代码在 CI runner 上实测超过辅助进程用的 15 秒，45 秒也被撞穿过
// （同一份清理有一次整段 55 秒通过，另一次第一条命令就超过 45 秒）。慢机器上
// 这里超时的代价是整台电脑断网，比卸载界面多停一会儿重得多。
const proxyCommandTimeoutMs = 90_000
// 还原最多是：等系统代理锁 12 秒，再加三次 PowerShell。正常一分钟以内；
// 这个上限只防卸载界面一直停在「正在清理」。
const defaultTimeoutMs = 300_000

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

// 卸载程序是整机安装的，一定带着管理员身份跑。普通账号卸载时要输别的管理员的
// 密码，这时卸载程序连同它拉起的这一支都以那个管理员的身份运行：注册表里的当前
// 用户、userData 全是那个管理员的，而不是坐在电脑前的这个人的（#498）。
//
// 这种情况下什么都不清，别人的数据原样不动，跟 0.2.9 完全不清代理时一样。
// 分不清的时候（问不出来、会话里没有桌面、有两个桌面主人）照旧清理：
// 代理还原本来就只在代理仍是加速写进去的那一份时才动，别的账号从没开过加速
// 就不会有恢复记录，清不到别人的东西；而把真正卸载的这个人的代理留在失效端口上，
// 是整台电脑断网。
export type UninstallAccountMatch = 'same' | 'other' | 'unknown'

// The desktop user is the owner of explorer.exe in this process's session.
// Over-the-shoulder UAC runs the uninstaller as the approving administrator
// but in the signed-in user's session, so the two SIDs differ exactly then.
// Only SIDs are compared: account names are localized and can be renamed.
const uninstallAccountProbeScript = [
  "$ErrorActionPreference='Stop'",
  '$session=[Diagnostics.Process]::GetCurrentProcess().SessionId',
  "'process=' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -eq 'explorer.exe' -and $_.SessionId -eq $session } | ForEach-Object { $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if ($owner.ReturnValue -eq 0 -and $owner.Sid) { 'desktop=' + $owner.Sid } }",
].join('; ')

// S-1-5-21-… for local and domain accounts, S-1-12-1-… for work or school ones.
const accountSidPattern = /^S-1-\d+(?:-\d+)+$/i

export function parseUninstallAccountProbe(output: string): UninstallAccountMatch {
  let processSid: string | null = null
  const desktopSids = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^(process|desktop)=(.+)$/.exec(line.trim())
    if (!match || !accountSidPattern.test(match[2])) continue
    const sid = match[2].toUpperCase()
    if (match[1] === 'process') {
      if (processSid !== null && processSid !== sid) return 'unknown'
      processSid = sid
    } else {
      desktopSids.add(sid)
    }
  }
  if (processSid === null || desktopSids.size !== 1) return 'unknown'
  return desktopSids.has(processSid) ? 'same' : 'other'
}

export async function inspectUninstallAccount(
  platform: NodeJS.Platform = process.platform,
  report?: (line: string) => void,
): Promise<UninstallAccountMatch> {
  if (platform !== 'win32') return 'unknown'
  try {
    // Same fixed resolver and scrubbed environment as every elevated probe
    // (I2, I14): this process holds an administrator token.
    const machinePaths = resolveWindowsMachinePaths()
    const { stdout } = await execFileAsync(
      resolveWindowsPowerShellExecutable({ env: process.env, machinePaths }),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', uninstallAccountProbeScript],
      {
        env: trustedCommandEnvironment(process.env, machinePaths),
        windowsHide: true,
        timeout: proxyCommandTimeoutMs,
        maxBuffer: 64 * 1024,
      },
    )
    return parseUninstallAccountProbe(stdout)
  } catch (error) {
    try { report?.(`account: ${describeCleanupFailure(error)}`) } catch { /* Reporting must not change the result. */ }
    return 'unknown'
  }
}

export interface UninstallCleanupDependencies {
  dataDirectory: string
  // 缺省 = 不问，照旧清理。
  inspectAccount?: () => Promise<UninstallAccountMatch>
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
  // 开机项、代理、登录记录全在当前用户名下，一样都不能碰别人的。
  if (dependencies.inspectAccount) {
    let match: UninstallAccountMatch = 'unknown'
    try {
      match = await dependencies.inspectAccount()
    } catch (error) {
      try { dependencies.report?.(`account: ${describeCleanupFailure(error)}`) } catch { /* Reporting must not change the result. */ }
    }
    if (match === 'other') {
      try { dependencies.report?.('account: uninstaller runs as another account than the desktop user; nothing cleaned') } catch { /* Reporting must not change the result. */ }
      return codes.otherAccount
    }
  }
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
  inspectAccount: () => Promise<UninstallAccountMatch> = () => inspectUninstallAccount(process.platform, report),
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
    inspectAccount,
    recoverProxy: (journalPath) => createWindowsSystemProxy({ journalPath, commandTimeoutMs: proxyCommandTimeoutMs }).recover(),
    removeLoginItem: () => removeWindowsLoginItem({ app, executablePath: process.execPath }),
    clearLoginRecords: argv.includes(uninstallClearLoginArgument) ? () => clearLoginRecords(dataDirectory, report) : undefined,
    report,
  }).then(exit, () => exit(uninstallCleanupExitCodes.proxyNotRestored))
}
