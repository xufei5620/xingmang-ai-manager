import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SYSTEM_ROOT_DEVICE_PATH = '\\\\?\\GLOBALROOT\\SystemRoot'

export interface WindowsMachinePaths {
  systemRoot: string
  system32: string
  programFiles: string
  programFilesX86: string | null
  programData: string
}

export interface WindowsMachinePathResolutionOptions {
  platform?: NodeJS.Platform
  sharedObjects?: readonly string[]
  resolveSystemRoot?: () => string
  resolveKnownFolders?: (systemRoot: string) => Partial<Pick<
    WindowsMachinePaths,
    'programFiles' | 'programFilesX86' | 'programData'
  >>
}

let cachedMachinePaths: WindowsMachinePaths | null = null
const programFilesAclCache = new Map<string, boolean>()

const TRUSTED_WINDOWS_OWNER_SIDS = new Set([
  'S-1-5-18', // LocalSystem
  'S-1-5-32-544', // BUILTIN\\Administrators
  // NT SERVICE\\TrustedInstaller
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
])

const WINDOWS_SID_PATTERN = /^S-\d(?:-\d+)+$/

export interface WindowsMachineAclEntry {
  ownerSid: string
  reparsePoint: boolean
  allowWriteSids: string[]
}

export interface WindowsMachineAclSnapshot {
  tokenSids: string[]
  entries: WindowsMachineAclEntry[]
}

export interface WindowsMachinePathTrustOptions {
  realpath?: (candidate: string) => string
  inspectProgramFilesAcl?: (
    candidate: string,
    root: string,
    machinePaths: WindowsMachinePaths,
  ) => unknown
}

function absoluteDirectory(value: string | null | undefined, label: string): string {
  const candidate = value?.trim()
  if (!candidate || candidate.includes('\0') || !path.win32.isAbsolute(candidate)) {
    throw new Error(`无法解析可信的 Windows ${label} 目录`)
  }
  return path.win32.normalize(candidate).replace(/[\\/]$/, '')
}

function systemRootFromObjectManager(): string {
  try {
    return fs.realpathSync.native(SYSTEM_ROOT_DEVICE_PATH)
  } catch {
    throw new Error('无法通过 Windows 系统设备路径解析真实 SystemRoot')
  }
}

function loadedSharedObjects(): readonly string[] {
  try {
    const report = process.report.getReport() as { sharedObjects?: unknown }
    return Array.isArray(report.sharedObjects)
      ? report.sharedObjects.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function deriveWindowsSystemRoot(
  options: Pick<WindowsMachinePathResolutionOptions, 'platform' | 'sharedObjects'> = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Windows 真实系统目录解析仅支持 Windows')
  const candidates = new Map<string, Set<string>>()
  for (const filePath of options.sharedObjects ?? loadedSharedObjects()) {
    if (!path.win32.isAbsolute(filePath)) continue
    const fileName = path.win32.basename(filePath).toLowerCase()
    if (fileName !== 'ntdll.dll' && fileName !== 'kernel32.dll') continue
    const system32 = path.win32.dirname(filePath)
    if (path.win32.basename(system32).toLowerCase() !== 'system32') continue
    const root = path.win32.dirname(system32)
    const key = root.toLowerCase()
    const modules = candidates.get(key) ?? new Set<string>()
    modules.add(fileName)
    candidates.set(key, modules)
    if (modules.has('ntdll.dll') && modules.has('kernel32.dll')) return path.win32.normalize(root)
  }
  throw new Error('无法从已加载的 Windows 核心模块解析真实系统目录')
}

function trustedSystemRoot(options: WindowsMachinePathResolutionOptions): string {
  try {
    return deriveWindowsSystemRoot(options)
  } catch {
    return systemRootFromObjectManager()
  }
}

function parseKnownFolders(output: string): Partial<Pick<
  WindowsMachinePaths,
  'programFiles' | 'programFilesX86' | 'programData'
>> {
  const parsed = JSON.parse(output.trim()) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  return {
    programFiles: typeof record.programFiles === 'string' ? record.programFiles : undefined,
    programFilesX86: typeof record.programFilesX86 === 'string' ? record.programFilesX86 : undefined,
    programData: typeof record.programData === 'string' ? record.programData : undefined,
  }
}

/** Uses the inbox PowerShell at the already resolved SystemRoot to call the
 * Windows Known Folder API. No process environment path is used as a trust root. */
function knownFoldersFromWindows(systemRoot: string): Partial<Pick<
  WindowsMachinePaths,
  'programFiles' | 'programFilesX86' | 'programData'
>> {
  const system32 = path.win32.join(systemRoot, 'System32')
  const powershell = path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!fs.existsSync(powershell)) return {}
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[pscustomobject]@{',
    '  programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)',
    '  programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)',
    '  programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)',
    '} | ConvertTo-Json -Compress',
  ].join('\n')
  try {
    return parseKnownFolders(execFileSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8',
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: system32,
        PSModulePath: '',
      },
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return {}
  }
}

function registryValue(systemRoot: string, key: string, name: string): string | null {
  const executable = path.win32.join(systemRoot, 'System32', 'reg.exe')
  try {
    const output = execFileSync(executable, ['query', key, '/v', name, '/reg:64'], {
      encoding: 'utf8',
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: path.win32.join(systemRoot, 'System32'),
      },
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    })
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return output.match(new RegExp(
      `^\\s*${escapedName}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`,
      'im',
    ))?.[1] ?? null
  } catch {
    return null
  }
}

function knownFoldersFromTrustedSystem(systemRoot: string): Partial<Pick<
  WindowsMachinePaths,
  'programFiles' | 'programFilesX86' | 'programData'
>> {
  const powershell = knownFoldersFromWindows(systemRoot)
  if (powershell.programFiles && powershell.programData) return powershell
  const currentVersion = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion'
  const registry = {
    programFiles: registryValue(systemRoot, currentVersion, 'ProgramFilesDir') ?? undefined,
    programFilesX86: registryValue(systemRoot, currentVersion, 'ProgramFilesDir (x86)') ?? undefined,
    programData: registryValue(
      systemRoot,
      `${currentVersion}\\Explorer\\Shell Folders`,
      'Common AppData',
    ) ?? undefined,
  }
  return { ...registry, ...powershell }
}

/**
 * Resolves machine-owned Windows locations without trusting `process.env`.
 * SystemRoot comes from the Windows object manager and the remaining roots
 * come from the Known Folder API hosted by that resolved system PowerShell.
 */
export function resolveWindowsMachinePaths(
  options: WindowsMachinePathResolutionOptions = {},
): WindowsMachinePaths {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Windows 机器目录解析仅支持 Windows')
  const useCache = options.platform === undefined
    && options.sharedObjects === undefined
    && options.resolveSystemRoot === undefined
    && options.resolveKnownFolders === undefined
  if (useCache && cachedMachinePaths) return cachedMachinePaths

  const systemRoot = absoluteDirectory(
    (options.resolveSystemRoot ?? (() => trustedSystemRoot(options)))(),
    'SystemRoot',
  )
  const systemDrive = path.win32.parse(systemRoot).root
  const knownFolders = (options.resolveKnownFolders ?? knownFoldersFromTrustedSystem)(systemRoot)
  const result: WindowsMachinePaths = {
    systemRoot,
    system32: path.win32.join(systemRoot, 'System32'),
    programFiles: absoluteDirectory(
      knownFolders.programFiles ?? path.win32.join(systemDrive, 'Program Files'),
      'Program Files',
    ),
    programFilesX86: knownFolders.programFilesX86?.trim()
      ? absoluteDirectory(knownFolders.programFilesX86, 'Program Files (x86)')
      : null,
    programData: absoluteDirectory(
      knownFolders.programData ?? path.win32.join(systemDrive, 'ProgramData'),
      'ProgramData',
    ),
  }
  if (useCache) cachedMachinePaths = result
  return result
}

export const windowsMachinePaths = resolveWindowsMachinePaths

export function pathWithinWindowsRoot(candidate: string, root: string): boolean {
  if (!path.win32.isAbsolute(candidate) || !path.win32.isAbsolute(root)) return false
  const candidateKey = path.win32.normalize(candidate).replace(/[\\/]+$/, '').toLowerCase()
  const rootKey = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase()
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`)
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 256) return null
  const result = value.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 256)
  return result.length === value.length ? result : null
}

export function validateWindowsMachineAclSnapshot(value: unknown): value is WindowsMachineAclSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  const tokenSids = stringArray(snapshot.tokenSids)
  if (
    !tokenSids
    || tokenSids.length === 0
    || tokenSids.some((sid) => !WINDOWS_SID_PATTERN.test(sid))
    || !Array.isArray(snapshot.entries)
    || snapshot.entries.length === 0
    || snapshot.entries.length > 256
  ) {
    return false
  }
  return snapshot.entries.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const entry = value as Record<string, unknown>
    const allowWriteSids = stringArray(entry.allowWriteSids)
    return typeof entry.ownerSid === 'string'
      && TRUSTED_WINDOWS_OWNER_SIDS.has(entry.ownerSid)
      && entry.reparsePoint === false
      && allowWriteSids !== null
      && allowWriteSids.every((sid) => (
        WINDOWS_SID_PATTERN.test(sid)
        && TRUSTED_WINDOWS_OWNER_SIDS.has(sid)
      ))
  })
}

/** Shared owner/reparse probe: trusted-temp.ts reuses it for ProgramData managed
 * roots so the PowerShell inspection logic exists exactly once. */
export function inspectProgramFilesAcl(
  candidate: string,
  root: string,
  machinePaths: WindowsMachinePaths,
): unknown {
  const powershell = path.win32.join(
    machinePaths.system32,
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$target = [IO.Path]::GetFullPath($env:XINGMANG_TRUST_TARGET)',
    '$root = [IO.Path]::GetFullPath($env:XINGMANG_TRUST_ROOT).TrimEnd("\\")',
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$tokenSids = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })',
    '$writeMask = [long](2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288)',
    '$entries = @()',
    '$current = $target',
    'while ($true) {',
    '  $item = Get-Item -LiteralPath $current -Force',
    '  $acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $item.FullName',
    '  try { $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $ownerSid = [string]$acl.Owner }',
    '  $writeSids = @()',
    '  foreach ($rule in @($acl.Access)) {',
    '    if ([string]$rule.AccessControlType -ne "Allow" -or (([long]$rule.FileSystemRights -band $writeMask) -eq 0)) { continue }',
    '    try { $writeSids += $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $writeSids += [string]$rule.IdentityReference }',
    '  }',
    '  $entries += [pscustomobject]@{ ownerSid = $ownerSid; reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint); allowWriteSids = @($writeSids) }',
    '  $normalized = [IO.Path]::GetFullPath($item.FullName).TrimEnd("\\")',
    '  if ([StringComparer]::OrdinalIgnoreCase.Equals($normalized, $root)) { break }',
    '  $parent = [IO.Directory]::GetParent($item.FullName)',
    '  if ($null -eq $parent) { throw "Program Files ACL path escaped its root" }',
    '  $current = $parent.FullName',
    '}',
    '[pscustomobject]@{ tokenSids = @($tokenSids); entries = @($entries) } | ConvertTo-Json -Compress -Depth 5',
  ].join('\n')
  const output = execFileSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    env: {
      SystemRoot: machinePaths.systemRoot,
      WINDIR: machinePaths.systemRoot,
      PATH: machinePaths.system32,
      PSModulePath: path.win32.join(
        machinePaths.system32,
        'WindowsPowerShell',
        'v1.0',
        'Modules',
      ),
      XINGMANG_TRUST_TARGET: candidate,
      XINGMANG_TRUST_ROOT: root,
    },
    windowsHide: true,
    timeout: 8_000,
    maxBuffer: 512 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(output.trim()) as unknown
}

/** Owner/ACL probe for preexisting ProgramData managed roots.
 * Registration short-circuits later per-directory checks, so a root whose top
 * level looks trusted could smuggle attacker-owned descendants past hardening
 * unless the descendants are sampled before the root is first believed.
 *
 * Sampling stops at directories two levels down. A standard user can only place
 * files under this root by first owning a directory that grants them write
 * access, and every such directory sits at or above the managed layout depth
 * (XingMangAI\Cli\npm). Once those levels show no untrusted write ACE, the
 * hardening pass runs icacls with /inheritance:r /T, which strips explicit ACEs
 * deeper down as well. Walking the full tree instead would mean reading ACLs for
 * every file under the npm prefix - measured at ~67k entries on a machine with
 * the CLIs installed - which cannot finish inside any sane timeout. */
export function inspectWindowsDirectoryTreeAcl(
  root: string,
  machinePaths: WindowsMachinePaths,
): unknown {
  const powershell = path.win32.join(
    machinePaths.system32,
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$root = [IO.Path]::GetFullPath($env:XINGMANG_TRUST_ROOT)',
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$tokenSids = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })',
    '$writeMask = [long](2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288)',
    '$items = @(Get-Item -LiteralPath $root -Force) + @(Get-ChildItem -LiteralPath $root -Force -Recurse -Depth 2 -Directory)',
    'if ($items.Count -gt 512) { throw "受保护目录树条目数超过上限，拒绝采信: $root" }',
    '$entries = @()',
    'foreach ($item in $items) {',
    '  $acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $item.FullName',
    '  try { $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $ownerSid = [string]$acl.Owner }',
    '  $writeSids = @()',
    '  foreach ($rule in @($acl.Access)) {',
    '    if ([string]$rule.AccessControlType -ne "Allow" -or (([long]$rule.FileSystemRights -band $writeMask) -eq 0)) { continue }',
    '    try { $writeSids += $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $writeSids += [string]$rule.IdentityReference }',
    '  }',
    '  $entries += [pscustomobject]@{ ownerSid = $ownerSid; reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint); allowWriteSids = @($writeSids) }',
    '}',
    '[pscustomobject]@{ tokenSids = @($tokenSids); entries = @($entries) } | ConvertTo-Json -Compress -Depth 5',
  ].join('\n')
  const output = execFileSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    env: {
      SystemRoot: machinePaths.systemRoot,
      WINDIR: machinePaths.systemRoot,
      PATH: machinePaths.system32,
      PSModulePath: path.win32.join(
        machinePaths.system32,
        'WindowsPowerShell',
        'v1.0',
        'Modules',
      ),
      XINGMANG_TRUST_ROOT: root,
    },
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(output.trim()) as unknown
}

function trustedProgramFilesPath(
  candidate: string,
  root: string,
  machinePaths: WindowsMachinePaths,
  options: WindowsMachinePathTrustOptions,
): boolean {
  const realpath = options.realpath ?? fs.realpathSync.native
  let realCandidate: string
  let realRoot: string
  try {
    realCandidate = realpath(candidate)
    realRoot = realpath(root)
  } catch {
    return false
  }
  if (!pathWithinWindowsRoot(realCandidate, realRoot)) return false
  const key = `${path.win32.normalize(realRoot).toLowerCase()}\0${path.win32.normalize(realCandidate).toLowerCase()}`
  if (!options.inspectProgramFilesAcl && programFilesAclCache.has(key)) {
    return programFilesAclCache.get(key) === true
  }
  let trusted = false
  try {
    const snapshot = (options.inspectProgramFilesAcl ?? inspectProgramFilesAcl)(
      realCandidate,
      realRoot,
      machinePaths,
    )
    trusted = validateWindowsMachineAclSnapshot(snapshot)
  } catch {
    trusted = false
  }
  if (!options.inspectProgramFilesAcl) programFilesAclCache.set(key, trusted)
  return trusted
}

export function isTrustedWindowsMachinePath(
  candidate: string,
  machinePaths: WindowsMachinePaths = resolveWindowsMachinePaths(),
  options: WindowsMachinePathTrustOptions = {},
): boolean {
  if (!path.win32.isAbsolute(candidate) || candidate.includes('\0')) return false
  const realpath = options.realpath ?? fs.realpathSync.native
  if (pathWithinWindowsRoot(candidate, machinePaths.system32)) {
    try {
      return pathWithinWindowsRoot(realpath(candidate), realpath(machinePaths.system32))
    } catch {
      return false
    }
  }
  if (pathWithinWindowsRoot(candidate, machinePaths.programFiles)) {
    return trustedProgramFilesPath(candidate, machinePaths.programFiles, machinePaths, options)
  }
  if (machinePaths.programFilesX86 && pathWithinWindowsRoot(candidate, machinePaths.programFilesX86)) {
    return trustedProgramFilesPath(candidate, machinePaths.programFilesX86, machinePaths, options)
  }
  // ProgramData is writable by non-administrators in many installations.
  // App-owned paths become trusted only after their ACL has been hardened and
  // registered by trusted-temp.ts; a string prefix is never sufficient.
  return false
}
