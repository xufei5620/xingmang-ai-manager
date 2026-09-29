import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

/**
 * 「这个账户能不能打开从应用商店装的软件」要看的三样东西。Codex 桌面端是
 * Appx，走的是同一套规矩；打开失败后的解释（#658）和装之前的提醒（第十九批 6）
 * 共用这一份判断，别在别处再写一份。
 */
export interface WindowsStoreAppLaunchContext {
  userSid: string | null
  isBuiltInAdministrator: boolean
  uacEnabled: boolean | null
  filterAdministratorToken: boolean | null
}

/**
 * Windows 不让这个账户打开商店应用的两种已知情形：
 * - `builtInAdministrator`：系统自带的 Administrator（SID 以 -500 结尾），且没开
 *   「内置管理员的管理审批模式」（FilterAdministratorToken）。开了的话它和普通
 *   管理员一样能打开，不该吓人。
 * - `uacDisabled`：整台电脑关了「用户账户控制」（EnableLUA = 0），谁登录都一样。
 */
export type StoreAppLaunchBlock = 'builtInAdministrator' | 'uacDisabled'

export const emptyWindowsStoreAppLaunchContext: WindowsStoreAppLaunchContext = Object.freeze({
  userSid: null,
  isBuiltInAdministrator: false,
  uacEnabled: null,
  filterAdministratorToken: null,
})

function parseFlag(candidate: unknown): boolean | null {
  if (candidate === true || candidate === 1 || candidate === '1') return true
  if (candidate === false || candidate === 0 || candidate === '0') return false
  return null
}

/**
 * Reads the object the PowerShell statements below produce. Anything that is
 * not the expected shape degrades to "unknown" rather than guessing: an
 * unknown context only means the extra sentence is left out.
 */
export function readWindowsStoreAppLaunchContext(value: unknown): WindowsStoreAppLaunchContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...emptyWindowsStoreAppLaunchContext }
  }
  const record = value as Record<string, unknown>
  const userSid = typeof record.sid === 'string' && /^S-1-\d+(?:-\d+)+$/.test(record.sid)
    ? record.sid
    : null
  return {
    userSid,
    isBuiltInAdministrator: userSid?.endsWith('-500') ?? false,
    uacEnabled: parseFlag(record.uacEnabled),
    filterAdministratorToken: parseFlag(record.filterAdministratorToken),
  }
}

/**
 * Parses the standalone probe's stdout. Kept tolerant because PowerShell may
 * add a trailing newline or warning text when a policy value is unavailable.
 */
export function parseWindowsStoreAppLaunchContext(output: string): WindowsStoreAppLaunchContext {
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'))
  if (!jsonLine) return { ...emptyWindowsStoreAppLaunchContext }
  try {
    return readWindowsStoreAppLaunchContext(JSON.parse(jsonLine))
  } catch {
    return { ...emptyWindowsStoreAppLaunchContext }
  }
}

export function resolveStoreAppLaunchBlock(context: WindowsStoreAppLaunchContext): StoreAppLaunchBlock | null {
  if (context.isBuiltInAdministrator && context.filterAdministratorToken !== true) return 'builtInAdministrator'
  if (context.uacEnabled === false) return 'uacDisabled'
  return null
}

/**
 * PowerShell statements that leave the context in `$storeAppLaunchContext`.
 * Only reads the current identity and one HKLM policy key; never writes. The
 * Codex Desktop combined probe embeds the same statements so the home screen
 * learns this without a second process start.
 */
export function windowsStoreAppLaunchContextStatements(): string[] {
  return [
    '$storeAppIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$storeAppPolicy = Get-ItemProperty -LiteralPath "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -ErrorAction SilentlyContinue',
    '$storeAppUacEnabled = $null',
    '$storeAppFilterAdministratorToken = $null',
    'if ($null -ne $storeAppPolicy -and $null -ne $storeAppPolicy.EnableLUA) { $storeAppUacEnabled = [int]$storeAppPolicy.EnableLUA }',
    'if ($null -ne $storeAppPolicy -and $null -ne $storeAppPolicy.FilterAdministratorToken) { $storeAppFilterAdministratorToken = [int]$storeAppPolicy.FilterAdministratorToken }',
    '$storeAppLaunchContext = [pscustomobject]@{ sid = [string]$storeAppIdentity.User.Value; uacEnabled = $storeAppUacEnabled; filterAdministratorToken = $storeAppFilterAdministratorToken }',
  ]
}

export function buildWindowsStoreAppLaunchContextScript(): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    ...windowsStoreAppLaunchContextStatements(),
    '$storeAppLaunchContext | ConvertTo-Json -Compress',
  ].join('; ')
}

export interface WindowsStoreAppLaunchProbeOptions {
  timeoutMs?: number
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

/** Never throws: a failed probe returns the empty context. */
export async function inspectWindowsStoreAppLaunchContext(
  options: WindowsStoreAppLaunchProbeOptions = {},
): Promise<WindowsStoreAppLaunchContext> {
  if ((options.platform ?? process.platform) !== 'win32') return { ...emptyWindowsStoreAppLaunchContext }
  try {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildWindowsStoreAppLaunchContextScript(),
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      // A cold PowerShell start alone often takes longer than 3 seconds on the
      // slow machines this path is for; a timed-out probe silently dropped the
      // built-in Administrator explanation and showed the generic sentence.
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 64 * 1024,
      signal: options.signal,
    })
    return parseWindowsStoreAppLaunchContext(stdout)
  } catch {
    return { ...emptyWindowsStoreAppLaunchContext }
  }
}

/**
 * 检查页「运行权限」那一行在装之前就说的话。客户会原样看到，所以不出现
 * UAC、Appx、SID 这类词；「用户账户控制」是 Windows 设置里的原名，可以用。
 * 渲染层首页那句短的在 elevation-notice.ts，有意各写一份（electron 不给渲染层值导出，见 I6）。
 */
export function describeStoreAppLaunchBlock(block: StoreAppLaunchBlock): string {
  const common = '星芒和命令行工具都正常；但从微软商店装的软件（比如 Codex 桌面端）'
  return block === 'builtInAdministrator'
    ? `这台电脑用的是 Windows 自带的「Administrator」账户。${common}在这个账户下可能打不开。要用 Codex 桌面端，建议换一个普通账户登录电脑再装；也可以先用 Codex 命令行版`
    : `这台电脑关掉了 Windows 的「用户账户控制」。${common}在这种设置下可能打不开。要用 Codex 桌面端，请联系客服帮你把它打开后再装；也可以先用 Codex 命令行版`
}
