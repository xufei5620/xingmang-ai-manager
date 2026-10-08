import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

/**
 * 这里只剩「这台电脑有没有微软商店」一件事。0.2.12 起曾按「系统自带的 Administrator
 * 账户 / 关了用户账户控制」提前说 Codex 桌面端「可能打不开」，2026-10-02 撤掉了：
 * Windows 不许这两种情形打开的是跑在沙盒里的那类商店应用（照片、计算器这些，
 * 报「无法使用内置管理员帐户打开」）；Codex 桌面端是整体信任（runFullTrust）的
 * 桌面程序，按普通程序启动。
 * - 自带 Administrator：真机核过。出过这句提醒的那台租用测试机（SID -500、没开
 *   管理员批准模式）上，Codex 桌面端照常装好、打开。
 * - 关了用户账户控制：推测，没真机核过。依据是同类的整体信任程序 Windows Terminal
 *   在 EnableLUA = 0 的 Windows 10 上能开（microsoft/terminal PR #11221、#17291）。
 * 原来那句提醒两种都没核过就说了。要再加回来，先在真机上看到 Windows 拒绝打开
 * Codex（事件里是 0x80270253 / 0x80270252）。
 */

function parseFlag(candidate: unknown): boolean | null {
  if (candidate === true || candidate === 1 || candidate === '1') return true
  if (candidate === false || candidate === 0 || candidate === '0') return false
  return null
}

export interface WindowsStoreAppLaunchProbeOptions {
  timeoutMs?: number
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

/**
 * 这台电脑有没有微软商店（第二十一批 2）。LTSC、网上的「精简版」系统里根本没有
 * 这个应用；公司也可能用组策略把它关掉。这两种电脑上先走商店只是空等一步，
 * 装不上时再给一颗「去微软商店装」也打不开。
 *
 * Only a definite answer turns the store route off: `false` when the current
 * user has no Microsoft.WindowsStore package or a RemoveWindowsStore policy is
 * set, `true` when the package is there, `null` for anything the probe could
 * not read - and `null` keeps the old store-first behaviour.
 */
export function readWindowsStoreAvailability(value: unknown): boolean | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (parseFlag(record.removedByPolicy) === true) return false
  return parseFlag(record.installed)
}

export function parseWindowsStoreAvailability(output: string): boolean | null {
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'))
  if (!jsonLine) return null
  try {
    return readWindowsStoreAvailability(JSON.parse(jsonLine))
  } catch {
    return null
  }
}

/**
 * Read-only: one current-user package query and the two policy keys the
 * "Turn off the Store application" group policy writes. A failed package
 * query stays `$null` rather than reading as "not installed".
 */
export function buildWindowsStoreAvailabilityScript(): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    buildPowerShellModuleImportStatement(['Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Appx']),
    '$storeInstalled = $null',
    'try { $storeInstalled = [bool](@(Get-AppxPackage -Name "Microsoft.WindowsStore" -ErrorAction Stop).Count -gt 0) } catch { $storeInstalled = $null }',
    '$storeRemovedByPolicy = $false',
    'foreach ($storePolicyPath in @("HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsStore", "HKCU:\\SOFTWARE\\Policies\\Microsoft\\WindowsStore")) {',
    '  $storePolicy = Get-ItemProperty -LiteralPath $storePolicyPath -ErrorAction SilentlyContinue',
    '  if ($null -ne $storePolicy -and $null -ne $storePolicy.RemoveWindowsStore -and [int]$storePolicy.RemoveWindowsStore -eq 1) { $storeRemovedByPolicy = $true }',
    '}',
    '[pscustomobject]@{ installed = $storeInstalled; removedByPolicy = $storeRemovedByPolicy } | ConvertTo-Json -Compress',
  ].join('\n')
}

/**
 * Never throws: a failed or timed-out probe answers `null`, which keeps the
 * store-first route. Runs asynchronously so it never blocks the main thread.
 */
export async function inspectWindowsStoreAvailability(
  options: WindowsStoreAppLaunchProbeOptions = {},
): Promise<boolean | null> {
  if ((options.platform ?? process.platform) !== 'win32') return null
  try {
    const pending = execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildWindowsStoreAvailabilityScript(),
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 64 * 1024,
      signal: options.signal,
    })
    // Nothing is ever piped in. Close stdin up front so a console host that
    // waits for input can never hold the probe until the timeout (seen once on
    // a CI runner with the account probe that used to live in this file).
    pending.child.stdin?.end()
    const { stdout } = await pending
    return parseWindowsStoreAvailability(stdout)
  } catch {
    return null
  }
}
