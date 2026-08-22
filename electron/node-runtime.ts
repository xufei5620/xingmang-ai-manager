import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runCommand,
  trustedCommandEnvironment,
  windowsSystemExecutable,
  type CommandResult,
  type RunCommandOptions,
} from './command-runner'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { isRegisteredTrustedManagedWindowsPath } from './managed-path-trust'
import {
  isTrustedWindowsMachinePath,
  pathWithinWindowsRoot,
  resolveWindowsMachinePaths,
  type WindowsMachinePaths,
} from './windows-machine-paths'
import {
  encodeWindowsPowerShellCommand,
  powerShellLiteral,
  resolveWindowsPowerShellExecutable,
  windowsPowerShellExecutable,
} from './windows-elevation'
import { minimumSupportedNodeVersion, nodeVersionStatus } from './versions'

export type NodeRuntimeNetworkRegion =
  | 'mainland-china'
  | 'outside-mainland-china'
  | 'unknown'

export type NodeRuntimeArchitecture = 'x64' | 'arm64'
export type NodeRuntimeSource = 'winget' | 'npmmirror' | 'official'
export type NodeRuntimeInstallPhase =
  | 'checking'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'complete'
  | 'error'

export interface NodeRuntimeInstallProgress {
  phase: NodeRuntimeInstallPhase
  source: NodeRuntimeSource | null
  message: string
  percent: number | null
  transferredBytes?: number
  totalBytes?: number | null
}

export interface NodeRuntimeInstallResult {
  installed: true
  action: 'installed' | 'unchanged'
  method: 'winget' | 'msi' | null
  source: NodeRuntimeSource | null
  version: string | null
  architecture: NodeRuntimeArchitecture
  /** The current app must restart to inherit the PATH written by the installer. */
  pathRefreshRequired: boolean
  /** Exit code 3010 means Windows requested a reboot to finish the MSI transaction. */
  systemRestartRequired: boolean
}

export interface NodeRuntimeRelease {
  version: string
  lts: string
  architecture: NodeRuntimeArchitecture
  fileName: string
}

export interface NodeRuntimeDownloadSource {
  id: Exclude<NodeRuntimeSource, 'winget'>
  label: string
  baseUrl: string
}

export interface NodeRuntimeProcessPlan {
  executable: string
  argv: readonly string[]
  timeoutMs: number
  acceptedExitCodes: readonly number[]
  env?: NodeJS.ProcessEnv
  trustedPaths?: readonly string[]
  trustedOnly?: boolean
  /** Runs the fixed system installer through a UAC broker. */
  elevation?: 'uac'
  /** Expected MSI digest rechecked inside the elevated broker immediately before install. */
  integritySha256?: string
}

export interface NodeRuntimeInstallPlan {
  signature: NodeRuntimeProcessPlan
  msi: NodeRuntimeProcessPlan
}

export interface SystemWingetResolution {
  executable: string | null
  reason: string | null
}

export interface SystemWingetPackage {
  name: string
  packageFamilyName: string
  installLocation: string
}

export interface WindowsRestartStatus {
  required: boolean
  reasons: string[]
}

export interface NodeRuntimeInstallerDependencies {
  fetch: typeof globalThis.fetch
  runProcess(plan: NodeRuntimeProcessPlan, signal?: AbortSignal): Promise<CommandResult>
  resolveWingetExecutable(signal?: AbortSignal): Promise<SystemWingetResolution>
  inspectInstalledNodeRuntime(signal?: AbortSignal): Promise<InstalledNodeRuntimeInspection>
  createTemporaryDirectory(): Promise<string>
  removeTemporaryDirectory(directory: string): Promise<void>
}

export interface InstallNodeRuntimeOptions {
  networkRegion: NodeRuntimeNetworkRegion
  architecture?: NodeJS.Architecture
  signal?: AbortSignal
  onProgress?: (progress: NodeRuntimeInstallProgress) => void
  preferWinget?: boolean
  temporaryDirectoryMode?: 'trusted-only' | 'same-user'
  dependencies?: Partial<NodeRuntimeInstallerDependencies>
}

export interface AuthenticodeSignature {
  status: string
  subject: string
}

export interface InstalledNodeRuntimeInspection {
  executable: string
  version: string
  signature: AuthenticodeSignature
}

const metadataTimeoutMs = 30_000
const downloadTimeoutMs = 10 * 60_000
const wingetTimeoutMs = 15 * 60_000
const installerTimeoutMs = 15 * 60_000
const maximumIndexBytes = 4 * 1024 * 1024
const maximumChecksumsBytes = 2 * 1024 * 1024
const maximumMsiBytes = 160 * 1024 * 1024
const minimumMsiBytes = 1024 * 1024
const appInstallerPackageName = 'Microsoft.DesktopAppInstaller'
const appInstallerPackageFamily = 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe'
const maximumNodeRedirects = 2
const nodeRedirectStatuses = new Set([301, 302, 303, 307, 308])

const windowsRestartStatusScript = [
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  '$reasons = [System.Collections.Generic.List[string]]::new()',
  "$componentServicing = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'",
  "$windowsUpdate = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'",
  "if (Test-Path -LiteralPath $componentServicing) { [void]$reasons.Add('Windows 组件更新待重启') }",
  "if (Test-Path -LiteralPath $windowsUpdate) { [void]$reasons.Add('Windows Update 待重启') }",
  '[pscustomobject]@{ required = ($reasons.Count -gt 0); reasons = @($reasons) } | ConvertTo-Json -Compress',
].join('; ')

const sources: Record<Exclude<NodeRuntimeSource, 'winget'>, NodeRuntimeDownloadSource> = {
  npmmirror: {
    id: 'npmmirror',
    label: '国内镜像',
    baseUrl: 'https://npmmirror.com/mirrors/node/',
  },
  official: {
    id: 'official',
    label: 'Node.js 官方源',
    baseUrl: 'https://nodejs.org/dist/',
  },
}

const signatureScript = [
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop",
  "$signature = Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_NODE_MSI_PATH -ErrorAction Stop",
  "$subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
  '[PSCustomObject]@{ status = [string]$signature.Status; subject = [string]$subject } | ConvertTo-Json -Compress',
].join('; ')

const installedNodeSignatureScript = [
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop",
  "$signature = Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_NODE_EXE_PATH -ErrorAction Stop",
  "$subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
  '[PSCustomObject]@{ status = [string]$signature.Status; subject = [string]$subject } | ConvertTo-Json -Compress',
].join('; ')

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const appInstallerQueryScript = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  `$packages = @(Get-AppxPackage -Name '${appInstallerPackageName}' -ErrorAction Stop | Sort-Object Version -Descending)`,
  'if ($packages.Count -eq 0) {',
  '  try {',
  `    $packages = @(Get-AppxPackage -AllUsers -Name '${appInstallerPackageName}' -ErrorAction Stop | Sort-Object Version -Descending)`,
  '  } catch {',
  '    $packages = @()',
  '  }',
  '}',
  'if ($packages.Count -gt 0) {',
  '  $package = $packages[0]',
  '  [pscustomobject]@{',
  '    name = [string]$package.Name',
  '    packageFamilyName = [string]$package.PackageFamilyName',
  '    installLocation = [string]$package.InstallLocation',
  '  } | ConvertTo-Json -Compress',
  '}',
].join('\n')

export function parseSystemWingetPackage(value: string): SystemWingetPackage | null {
  const text = value.replace(/^\uFEFF/, '').trim()
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const packageFamilyName = typeof record.packageFamilyName === 'string'
    ? record.packageFamilyName.trim()
    : ''
  const installLocation = typeof record.installLocation === 'string'
    ? record.installLocation.trim()
    : ''
  if (!name || !packageFamilyName || !installLocation) return null
  return { name, packageFamilyName, installLocation }
}

export function parseWindowsRestartStatus(value: string): WindowsRestartStatus {
  const text = value.replace(/^\uFEFF/, '').trim()
  if (!text) throw new Error('Windows 待重启状态为空')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('Windows 待重启状态格式无效')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Windows 待重启状态格式无效')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.required !== 'boolean' || !Array.isArray(record.reasons)) {
    throw new Error('Windows 待重启状态格式无效')
  }
  const reasons = record.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
  return { required: record.required || reasons.length > 0, reasons }
}

/** Reads the fixed Windows reboot markers without touching user-controlled PATH. */
export async function inspectWindowsRestartRequired(signal?: AbortSignal): Promise<WindowsRestartStatus> {
  if (process.platform !== 'win32') return { required: false, reasons: [] }
  const machinePaths = resolveWindowsMachinePaths()
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable({ machinePaths }),
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedPowerShellCommand(windowsRestartStatusScript),
    ],
  }, {
    env: trustedCommandEnvironment(process.env, machinePaths, 'win32'),
    trustedOnly: true,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    signal,
  })
  return parseWindowsRestartStatus(result.stdout)
}

export function systemWingetCandidate(
  packageInfo: SystemWingetPackage,
  machinePaths: WindowsMachinePaths,
): string | null {
  if (
    packageInfo.name !== appInstallerPackageName
    || packageInfo.packageFamilyName !== appInstallerPackageFamily
    || packageInfo.installLocation.includes('\0')
    || !path.win32.isAbsolute(packageInfo.installLocation)
  ) return null
  const windowsAppsRoot = path.win32.join(machinePaths.programFiles, 'WindowsApps')
  const installLocation = path.win32.normalize(packageInfo.installLocation)
  if (!pathWithinWindowsRoot(installLocation, windowsAppsRoot)) return null
  if (!path.win32.basename(installLocation).toLowerCase().startsWith('microsoft.desktopappinstaller_')) {
    return null
  }
  return path.win32.join(installLocation, 'winget.exe')
}

export async function resolveSystemWingetExecutable(
  signal?: AbortSignal,
): Promise<SystemWingetResolution> {
  if (process.platform !== 'win32') {
    return { executable: null, reason: '系统级 winget 检测仅支持 Windows' }
  }
  try {
    const machinePaths = resolveWindowsMachinePaths()
    const result = await runCommand({
      executable: resolveWindowsPowerShellExecutable({ machinePaths }),
      argv: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodedPowerShellCommand(appInstallerQueryScript),
      ],
    }, {
      trustedOnly: true,
      machinePaths,
      timeoutMs: 10_000,
      maxOutputBytes: 128 * 1024,
      signal,
    })
    const packageInfo = parseSystemWingetPackage(result.stdout)
    if (!packageInfo) {
      return { executable: null, reason: '未检测到系统级 Microsoft App Installer 包' }
    }
    const candidate = systemWingetCandidate(packageInfo, machinePaths)
    if (!candidate) {
      return { executable: null, reason: 'Microsoft App Installer 包身份或安装目录校验失败' }
    }
    const realInstallLocation = fs.realpathSync.native(packageInfo.installLocation)
    const realExecutable = fs.realpathSync.native(candidate)
    const windowsAppsRoot = path.win32.join(machinePaths.programFiles, 'WindowsApps')
    if (
      !pathWithinWindowsRoot(realInstallLocation, windowsAppsRoot)
      || !pathWithinWindowsRoot(realExecutable, realInstallLocation)
      || path.win32.basename(realExecutable).toLowerCase() !== 'winget.exe'
      || !fs.statSync(realExecutable).isFile()
    ) {
      return { executable: null, reason: '系统级 winget 真实路径校验失败' }
    }
    return { executable: realExecutable, reason: null }
  } catch (error) {
    return {
      executable: null,
      reason: `系统级 winget 解析失败：${errorText(error)}`,
    }
  }
}

function report(
  options: InstallNodeRuntimeOptions,
  progress: NodeRuntimeInstallProgress,
): void {
  options.onProgress?.(progress)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('操作已取消')
}

function errorText(reason: unknown): string {
  const candidate = reason as { message?: unknown; stderr?: unknown } | null
  const raw = [
    typeof candidate?.message === 'string' ? candidate.message : '',
    typeof candidate?.stderr === 'string' ? candidate.stderr : '',
    typeof reason === 'string' ? reason : '',
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  if (/\b1602\b|取消|cancell?ed|declined/i.test(raw)) return '已取消管理员授权，Node.js 尚未安装'
  if (/\b1925\b/i.test(raw)) {
    return 'Windows Installer 拒绝了机器级安装（错误 1925）。请在管理员授权提示中选择“是”；如果系统有待重启更新，请先重启电脑后再试'
  }
  if (/\b1603\b/i.test(raw)) {
    return 'Windows Installer 安装失败（错误 1603）。请先重启 Windows 完成挂起更新，再重新点击一键安装；如果仍失败，请检查系统安装权限'
  }
  if (raw) return raw
  return '未知错误'
}

function sourceUrl(baseUrl: string, relativePath: string): string {
  return new URL(relativePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
}

function semverParts(version: string): [number, number, number] | null {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) return null
  return [parts[0], parts[1], parts[2]]
}

function compareVersions(left: string, right: string): number {
  const leftParts = semverParts(left)
  const rightParts = semverParts(right)
  if (!leftParts || !rightParts) return 0
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

export function normalizeNodeRuntimeArchitecture(
  architecture: NodeJS.Architecture,
): NodeRuntimeArchitecture {
  if (architecture === 'x64' || architecture === 'arm64') return architecture
  throw new Error(`Node.js 自动安装暂不支持 ${architecture} 架构，仅支持 Windows x64/arm64`)
}

/**
 * Mirrors npmInstallRegistries: an unknown region means the region probe was
 * blocked, and the networks that block it are the same ones that cannot reach
 * nodejs.org. Falling back to the official source first stranded exactly the
 * users the mirror exists for. Both sources remain in the list, so the guess
 * only decides the order in which they are attempted.
 */
export function nodeRuntimeDownloadSources(
  region: NodeRuntimeNetworkRegion,
): [NodeRuntimeDownloadSource, NodeRuntimeDownloadSource] {
  return region === 'outside-mainland-china'
    ? [sources.official, sources.npmmirror]
    : [sources.npmmirror, sources.official]
}

export function parseNodeReleaseIndex(
  input: string,
  architecture: NodeRuntimeArchitecture,
): NodeRuntimeRelease | null {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > maximumIndexBytes) return null
  try {
    const value = JSON.parse(input) as unknown
    if (!Array.isArray(value)) return null
    const requiredFile = `win-${architecture}-msi`
    const releases: NodeRuntimeRelease[] = []
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      if (
        typeof record.version !== 'string'
        || !semverParts(record.version)
        || typeof record.lts !== 'string'
        || !record.lts.trim()
        || !Array.isArray(record.files)
        || !record.files.every((file) => typeof file === 'string')
        || !record.files.includes(requiredFile)
      ) continue
      releases.push({
        version: record.version,
        lts: record.lts.trim(),
        architecture,
        fileName: `node-${record.version}-${architecture}.msi`,
      })
    }
    releases.sort((left, right) => compareVersions(right.version, left.version))
    return releases[0] ?? null
  } catch {
    return null
  }
}

export function parseNodeShasums(input: string, fileName: string): string | null {
  if (
    !input.trim()
    || Buffer.byteLength(input, 'utf8') > maximumChecksumsBytes
    || path.basename(fileName) !== fileName
  ) return null
  const matches = new Set<string>()
  for (const line of input.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?([^\s]+)$/.exec(line.trim())
    if (match && match[2] === fileName) matches.add(match[1].toLowerCase())
  }
  return matches.size === 1 ? [...matches][0] : null
}

export function parseAuthenticodeSignature(output: string): AuthenticodeSignature | null {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > 64 * 1024) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.status !== 'string' || typeof record.subject !== 'string') return null
    return { status: record.status.trim(), subject: record.subject.trim() }
  } catch {
    return null
  }
}

export function validateNodeAuthenticodeSignature(signature: AuthenticodeSignature): string | null {
  if (signature.status.toLowerCase() !== 'valid') return `安装包数字签名状态不是 Valid（${signature.status || '空'}）`
  const commonName = /(?:^|,)\s*CN=([^,]+)/i.exec(signature.subject)?.[1]?.trim()
  if (commonName !== 'OpenJS Foundation' && commonName !== 'Node.js Foundation') {
    return '安装包数字签名发布者不是 OpenJS Foundation 或 Node.js Foundation'
  }
  return null
}

type InstalledNodePathTrustCheck = (
  executable: string,
  machinePaths: WindowsMachinePaths,
) => boolean

function validateInstalledNodeExecutablePath(
  executable: string,
  machinePaths: WindowsMachinePaths,
  isTrustedPath: InstalledNodePathTrustCheck,
): void {
  const expectedInstallRoot = path.win32.join(machinePaths.programFiles, 'nodejs')
  if (
    !path.win32.isAbsolute(executable)
    || executable.includes('\0')
    || path.win32.basename(executable).toLowerCase() !== 'node.exe'
    || !pathWithinWindowsRoot(executable, expectedInstallRoot)
  ) {
    throw new Error('安装后的 Node.js 可执行文件不在预期的系统级安装目录')
  }
  if (!isTrustedPath(executable, machinePaths)) {
    throw new Error('安装后的 Node.js 可执行文件不在受信任的受保护路径')
  }
}

export function validateInstalledNodeRuntimeInspection(
  inspection: InstalledNodeRuntimeInspection,
  machinePaths: WindowsMachinePaths = resolveWindowsMachinePaths(),
  isTrustedPath: InstalledNodePathTrustCheck = isTrustedWindowsMachinePath,
): string {
  validateInstalledNodeExecutablePath(inspection.executable, machinePaths, isTrustedPath)
  const version = inspection.version.trim()
  const status = nodeVersionStatus(version)
  if (status === 'unknown') throw new Error('安装后的 Node.js 版本输出无效')
  if (status === 'too-old') {
    const minimum = minimumSupportedNodeVersion
    throw new Error(
      `安装后的 Node.js 版本 ${version} 低于最低要求 v${minimum.major}.${minimum.minor}.${minimum.patch}`,
    )
  }
  const signatureError = validateNodeAuthenticodeSignature(inspection.signature)
  if (signatureError) {
    throw new Error(`安装后的 Node.js 可执行文件${signatureError.replace(/^安装包/, '')}`)
  }
  return version
}

interface NodeResourceIdentity {
  family: 'official' | 'npmmirror'
  suffix: string
}

function nodeResourceIdentity(value: string): NodeResourceIdentity {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Node.js 下载响应地址无效')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('Node.js 下载重定向到了未经批准的 HTTPS 主机')
  }
  const rules: Array<{ origin: string; root: string; family: NodeResourceIdentity['family'] }> = [
    { origin: 'https://nodejs.org', root: '/dist/', family: 'official' },
    { origin: 'https://npmmirror.com', root: '/mirrors/node/', family: 'npmmirror' },
    { origin: 'https://cdn.npmmirror.com', root: '/binaries/node/', family: 'npmmirror' },
  ]
  const rule = rules.find((candidate) => (
    parsed.origin.toLowerCase() === candidate.origin
    && parsed.pathname.startsWith(candidate.root)
  ))
  if (!rule) throw new Error('Node.js 下载重定向到了未经批准的 HTTPS 主机')
  const suffix = parsed.pathname.slice(rule.root.length)
  if (!suffix || suffix.includes('\\') || /(?:^|\/)\.\.?($|\/)/.test(suffix)) {
    throw new Error('Node.js 下载重定向到了未经批准的资源路径')
  }
  return { family: rule.family, suffix }
}

/** Accept only the exact resource on the official host or npmmirror's fixed CDN mapping. */
export function validateNodeResponseUrl(responseUrl: string, expectedUrl: string): void {
  const actual = nodeResourceIdentity(responseUrl)
  const expected = nodeResourceIdentity(expectedUrl)
  if (actual.family !== expected.family || actual.suffix !== expected.suffix) {
    throw new Error('Node.js 下载重定向到了未经批准的资源路径')
  }
}

export async function fetchTrustedNodeResource(
  url: string,
  init: RequestInit,
  fetchImplementation: typeof globalThis.fetch,
): Promise<Response> {
  nodeResourceIdentity(url)
  let current = url
  const visited = new Set<string>()
  for (let redirectCount = 0; redirectCount <= maximumNodeRedirects; redirectCount += 1) {
    if (visited.has(current)) throw new Error('Node.js 下载发生了循环重定向')
    visited.add(current)
    const response = await fetchImplementation(current, { ...init, redirect: 'manual' })
    if (response.url) validateNodeResponseUrl(response.url, current)
    if (!nodeRedirectStatuses.has(response.status)) return response
    if (redirectCount === maximumNodeRedirects) {
      throw new Error('Node.js 下载重定向次数过多')
    }
    const location = response.headers.get('location')
    if (!location) throw new Error('Node.js 下载重定向缺少 Location')
    await response.body?.cancel().catch(() => undefined)
    const next = new URL(location, current).href
    validateNodeResponseUrl(next, url)
    current = next
  }
  throw new Error('Node.js 下载重定向次数过多')
}

export function buildNodeRuntimeInstallPlan(
  msiPath: string,
  powershellExecutable = windowsPowerShellExecutable(),
  trustedOnly = true,
  machinePaths?: WindowsMachinePaths,
  integritySha256?: string,
): NodeRuntimeInstallPlan {
  if (integritySha256 !== undefined && !/^[a-f0-9]{64}$/i.test(integritySha256)) {
    throw new Error('Node.js 安装包 SHA-256 格式无效')
  }
  const roots = machinePaths ?? (process.platform === 'win32' ? resolveWindowsMachinePaths() : undefined)
  const signatureEnv = {
    ...trustedCommandEnvironment(process.env, roots, roots ? 'win32' : process.platform),
    XINGMANG_NODE_MSI_PATH: msiPath,
  }
  return {
    signature: {
      executable: powershellExecutable,
      argv: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedPowerShellCommand(signatureScript),
      ],
      timeoutMs: 60_000,
      acceptedExitCodes: [0],
      env: signatureEnv,
      trustedPaths: [msiPath],
      ...(!trustedOnly ? { trustedOnly: false } : {}),
    },
    msi: {
      executable: windowsSystemExecutable('msiexec.exe', process.env, 'win32', machinePaths),
      argv: ['/i', msiPath, '/qn', '/norestart', 'ADDLOCAL=ALL'],
      timeoutMs: installerTimeoutMs,
      acceptedExitCodes: [0, 3010],
      env: signatureEnv,
      trustedPaths: [msiPath],
      elevation: 'uac',
      ...(integritySha256 ? { integritySha256: integritySha256.toLowerCase() } : {}),
      ...(!trustedOnly ? { trustedOnly: false } : {}),
    },
  }
}

export function buildNodeRuntimeWingetPlan(executable: string): NodeRuntimeProcessPlan {
  if (
    !path.win32.isAbsolute(executable)
    || path.win32.basename(executable).toLowerCase() !== 'winget.exe'
    || executable.includes('\0')
  ) {
    throw new Error('系统级 winget 路径无效')
  }
  return {
    executable,
    argv: [
      'install',
      '--id',
      'OpenJS.NodeJS.LTS',
      '--exact',
      '--source',
      'winget',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ],
    timeoutMs: wingetTimeoutMs,
    acceptedExitCodes: [0],
  }
}

function verifiedNodeRuntimeWingetPlan(executable: string): NodeRuntimeProcessPlan {
  return {
    ...buildNodeRuntimeWingetPlan(executable),
    // The resolver immediately above this call validated the App Installer
    // package identity, real install root, canonical executable and basename.
    // Run it as the current user so WindowsApps ACL probing is not repeated by
    // the high-integrity generic command path.
    trustedOnly: false,
    env: trustedCommandEnvironment(),
  }
}

/** Quotes one value for the Windows command line assembled by Start-Process. */
function windowsProcessArgument(value: string): string {
  if (!/[\s"]/.test(value)) return value
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')
  return `"${escaped}"`
}

export function buildNodeRuntimeUacBrokerScript(plan: NodeRuntimeProcessPlan): string {
  if (plan.elevation !== 'uac') throw new Error('未配置 UAC 安装计划')
  const argumentLine = plan.argv.map(windowsProcessArgument).join(' ')
  const integrityCheck = plan.integritySha256
    ? [
        `$expectedHash = ${powerShellLiteral(plan.integritySha256.toUpperCase())}`,
        `$actualHash = (Get-FileHash -LiteralPath ${powerShellLiteral(plan.argv[1])} -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()`,
        'if ($actualHash -ne $expectedHash) { exit 1603 }',
        "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop",
        `$signature = Get-AuthenticodeSignature -LiteralPath ${powerShellLiteral(plan.argv[1])} -ErrorAction Stop`,
        '$subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { \'\' }',
        '$commonName = [regex]::Match([string]$subject, \'(?:^|,)\\s*CN=([^,]+)\', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value.Trim()',
        "if ([string]$signature.Status -ne 'Valid' -or ($commonName -ne 'OpenJS Foundation' -and $commonName -ne 'Node.js Foundation')) { exit 1603 }",
      ].join('; ')
    : ''
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    integrityCheck,
    `$argumentLine = ${powerShellLiteral(argumentLine)}`,
    `$process = Start-Process -FilePath ${powerShellLiteral(plan.executable)} -ArgumentList $argumentLine -Verb RunAs -Wait -PassThru`,
    'if ($null -eq $process) { exit 1602 }',
    'exit $process.ExitCode',
  ].join('; ')
}

async function runUacProcess(plan: NodeRuntimeProcessPlan, signal?: AbortSignal): Promise<CommandResult> {
  if (process.platform !== 'win32') throw new Error('UAC 安装仅支持 Windows')
  if (plan.integritySha256 === undefined) throw new Error('UAC 安装计划缺少 MSI 完整性校验值')
  const machinePaths = resolveWindowsMachinePaths()
  const powershell = resolveWindowsPowerShellExecutable({ machinePaths })
  return runCommand({
    executable: powershell,
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodeWindowsPowerShellCommand(buildNodeRuntimeUacBrokerScript(plan)),
    ],
  }, {
    // The encoded command contains the already hash-checked MSI path, so no
    // user-controlled path is parsed as a PowerShell argument by the broker.
    // The broker itself is the fixed inbox PowerShell executable and remains
    // subject to the trusted system-path check.
    env: trustedCommandEnvironment(plan.env ?? process.env, machinePaths, 'win32'),
    trustedOnly: true,
    timeoutMs: plan.timeoutMs,
    acceptedExitCodes: plan.acceptedExitCodes,
    maxOutputBytes: 2 * 1024 * 1024,
    windowsHide: true,
    signal,
  })
}

async function defaultRunProcess(
  plan: NodeRuntimeProcessPlan,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (plan.elevation === 'uac') return runUacProcess(plan, signal)
  const options: RunCommandOptions = {
    timeoutMs: plan.timeoutMs,
    acceptedExitCodes: plan.acceptedExitCodes,
    maxOutputBytes: 2 * 1024 * 1024,
    windowsHide: true,
    signal,
    env: plan.env,
    trustedOnly: plan.trustedOnly ?? true,
    trustedPaths: plan.trustedPaths,
  }
  return runCommand({ executable: plan.executable, argv: plan.argv }, options)
}

export async function inspectInstalledNodeRuntime(
  signal?: AbortSignal,
): Promise<InstalledNodeRuntimeInspection> {
  throwIfAborted(signal)
  const machinePaths = resolveWindowsMachinePaths()
  const candidate = path.win32.join(machinePaths.programFiles, 'nodejs', 'node.exe')
  let executable: string
  try {
    executable = fs.realpathSync.native(candidate)
    if (!fs.statSync(executable).isFile()) throw new Error('不是普通文件')
  } catch (error) {
    throw new Error(`无法解析安装后的 Node.js 可执行文件：${errorText(error)}`)
  }
  validateInstalledNodeExecutablePath(executable, machinePaths, isTrustedWindowsMachinePath)

  const versionResult = await defaultRunProcess({
    executable,
    argv: ['--version'],
    timeoutMs: 15_000,
    acceptedExitCodes: [0],
  }, signal)
  const signatureResult = await defaultRunProcess({
    executable: resolveWindowsPowerShellExecutable({ machinePaths }),
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedPowerShellCommand(installedNodeSignatureScript),
    ],
    timeoutMs: 60_000,
    acceptedExitCodes: [0],
    env: {
      ...process.env,
      XINGMANG_NODE_EXE_PATH: executable,
    },
    trustedPaths: [executable],
  }, signal)
  const signature = parseAuthenticodeSignature(signatureResult.stdout)
  if (!signature) throw new Error('无法读取安装后的 Node.js 可执行文件数字签名')
  const inspection = {
    executable,
    version: versionResult.stdout.trim(),
    signature,
  }
  const version = validateInstalledNodeRuntimeInspection(inspection, machinePaths)
  return { ...inspection, version }
}

const defaultDependencies: NodeRuntimeInstallerDependencies = {
  fetch: globalThis.fetch,
  runProcess: defaultRunProcess,
  resolveWingetExecutable: resolveSystemWingetExecutable,
  inspectInstalledNodeRuntime,
  createTemporaryDirectory: () => createTrustedTemporaryDirectory('node-runtime'),
  removeTemporaryDirectory: (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
}

async function consumeResponse(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  consume: (response: Response, maximumBytes: number) => Promise<string>,
): Promise<string> {
  throwIfAborted(signal)
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  try {
    const response = await fetchTrustedNodeResource(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    }, fetchImplementation)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await consume(response, maximumBytes)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function responseTextWithLimit(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new Error('服务器返回了空响应')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('服务器响应超过大小限制')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    received += value.byteLength
    if (received > maximumBytes) {
      await reader.cancel()
      throw new Error('服务器响应超过大小限制')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

async function fetchLimitedText(
  dependencies: NodeRuntimeInstallerDependencies,
  url: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return consumeResponse(
    dependencies.fetch,
    url,
    metadataTimeoutMs,
    maximumBytes,
    signal,
    responseTextWithLimit,
  )
}

async function downloadMsi(
  dependencies: NodeRuntimeInstallerDependencies,
  url: string,
  targetPath: string,
  options: InstallNodeRuntimeOptions,
  source: NodeRuntimeDownloadSource,
): Promise<{ sha256: string; size: number }> {
  let size = 0
  const hash = createHash('sha256')
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('安装包下载超时')), downloadTimeoutMs)
  try {
    throwIfAborted(options.signal)
    const response = await fetchTrustedNodeResource(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/octet-stream' },
    }, dependencies.fetch)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('服务器没有返回安装包内容')
    const declaredLengthHeader = response.headers.get('content-length')
    const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader)
    if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < minimumMsiBytes)) {
      throw new Error('服务器返回的安装包大小无效')
    }
    if (declaredLength !== null && declaredLength > maximumMsiBytes) {
      throw new Error('安装包超过 160 MB 安全限制')
    }
    const file = await fs.promises.open(targetPath, 'wx')
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        size += value.byteLength
        if (size > maximumMsiBytes) {
          await reader.cancel()
          throw new Error('安装包超过 160 MB 安全限制')
        }
        hash.update(value)
        await file.writeFile(value)
        report(options, {
          phase: 'downloading',
          source: source.id,
          message: `正在从${source.label}下载 Node.js LTS`,
          percent: declaredLength ? Math.min(99, (size / declaredLength) * 100) : null,
          transferredBytes: size,
          totalBytes: declaredLength,
        })
      }
    } finally {
      await file.close()
    }
    if (size < minimumMsiBytes) throw new Error('下载的安装包内容过小')
    if (declaredLength !== null && size !== declaredLength) throw new Error('安装包下载不完整')
    return { sha256: hash.digest('hex'), size }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function installFromSource(
  source: NodeRuntimeDownloadSource,
  architecture: NodeRuntimeArchitecture,
  temporaryDirectory: string,
  options: InstallNodeRuntimeOptions,
  dependencies: NodeRuntimeInstallerDependencies,
): Promise<NodeRuntimeInstallResult> {
  report(options, {
    phase: 'resolving',
    source: source.id,
    message: `正在从${source.label}查询最新 Node.js LTS`,
    percent: null,
  })
  const index = await fetchLimitedText(
    dependencies,
    sourceUrl(source.baseUrl, 'index.json'),
    maximumIndexBytes,
    options.signal,
  )
  const release = parseNodeReleaseIndex(index, architecture)
  if (!release) throw new Error(`${source.label}没有可用于 Windows ${architecture} 的有效 LTS 安装包`)
  const releaseDirectory = `${release.version}/`
  const checksums = await fetchLimitedText(
    dependencies,
    sourceUrl(source.baseUrl, `${releaseDirectory}SHASUMS256.txt`),
    maximumChecksumsBytes,
    options.signal,
  )
  const expectedSha256 = parseNodeShasums(checksums, release.fileName)
  if (!expectedSha256) throw new Error(`${source.label}校验清单中没有唯一、有效的 MSI SHA-256`)
  // Keep fallback downloads separate when a failed source leaves a partial file.
  const msiPath = path.join(temporaryDirectory, `${source.id}-${release.fileName}`)
  report(options, {
    phase: 'downloading',
    source: source.id,
    message: `准备下载 Node.js ${release.version} LTS`,
    percent: 0,
  })
  const download = await downloadMsi(
    dependencies,
    sourceUrl(source.baseUrl, `${releaseDirectory}${release.fileName}`),
    msiPath,
    options,
    source,
  )
  report(options, {
    phase: 'verifying',
    source: source.id,
    message: '正在校验安装包完整性和官方数字签名',
    percent: null,
  })
  if (download.sha256 !== expectedSha256) throw new Error('Node.js 安装包 SHA-256 校验失败')
  if (process.platform === 'win32' && !isRegisteredTrustedManagedWindowsPath(temporaryDirectory)) {
    throw new Error('Node.js 安装包暂存目录未通过受保护路径校验，已阻止 UAC 安装')
  }
  const plan = buildNodeRuntimeInstallPlan(
    msiPath,
    resolveWindowsPowerShellExecutable(),
    options.temporaryDirectoryMode !== 'same-user',
    undefined,
    expectedSha256,
  )
  const verifyMsiBeforeInstall = async () => {
    const stat = await fs.promises.stat(msiPath)
    if (!stat.isFile() || stat.size !== download.size) throw new Error('Node.js 安装包在校验后发生变化')
    if (await hashFileSha256(msiPath) !== expectedSha256) {
      throw new Error('Node.js 安装包在执行前 SHA-256 校验失败')
    }
    const signatureResult = await dependencies.runProcess(plan.signature, options.signal)
    const signature = parseAuthenticodeSignature(signatureResult.stdout)
    if (!signature) throw new Error('无法读取 Node.js 安装包数字签名')
    const signatureError = validateNodeAuthenticodeSignature(signature)
    if (signatureError) throw new Error(signatureError)
  }
  await verifyMsiBeforeInstall()
  report(options, {
    phase: 'installing',
    source: source.id,
    message: `正在静默安装 Node.js ${release.version} LTS`,
    percent: null,
  })
  await verifyMsiBeforeInstall()
  const installResult = await dependencies.runProcess(plan.msi, options.signal)
  return {
    installed: true,
    action: 'installed',
    method: 'msi',
    source: source.id,
    version: release.version,
    architecture,
    pathRefreshRequired: true,
    systemRestartRequired: installResult.exitCode === 3010,
  }
}

/**
 * Installs Node.js LTS on Windows. winget is attempted first; a verified MSI
 * from the region-preferred source is used when winget is unavailable/fails.
 */
export async function installNodeRuntime(
  options: InstallNodeRuntimeOptions,
): Promise<NodeRuntimeInstallResult> {
  if (process.platform !== 'win32') throw new Error('Node.js 自动安装当前仅支持 Windows')
  const architecture = normalizeNodeRuntimeArchitecture(options.architecture ?? process.arch)
  const dependencies: NodeRuntimeInstallerDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  }
  throwIfAborted(options.signal)
  const failures: string[] = []
  if (options.preferWinget !== false) {
    report(options, {
      phase: 'checking',
      source: 'winget',
      message: '正在检测受信任的系统级 Windows 程序包管理器',
      percent: null,
    })
    let winget: SystemWingetResolution
    try {
      winget = await dependencies.resolveWingetExecutable(options.signal)
    } catch (error) {
      winget = { executable: null, reason: `系统级 winget 解析失败：${errorText(error)}` }
    }
    if (!winget.executable) {
      const reason = winget.reason || '未找到可安全执行的系统级 winget'
      failures.push(`winget：${reason}`)
      report(options, {
        phase: 'checking',
        source: 'winget',
        message: `已跳过 winget：${reason}，正在切换到经过校验的 MSI 安装包`,
        percent: null,
      })
    } else {
      try {
        await dependencies.runProcess(verifiedNodeRuntimeWingetPlan(winget.executable), options.signal)
        const installedRuntime = await dependencies.inspectInstalledNodeRuntime(options.signal)
        const result: NodeRuntimeInstallResult = {
          installed: true,
          action: 'installed',
          method: 'winget',
          source: 'winget',
          version: installedRuntime.version,
          architecture,
          pathRefreshRequired: true,
          systemRestartRequired: false,
        }
        report(options, {
          phase: 'complete',
          source: 'winget',
          message: 'Node.js LTS 安装完成，重启本程序后即可使用',
          percent: 100,
        })
        return result
      } catch (error) {
        const reason = errorText(error)
        failures.push(`winget：${reason}`)
        report(options, {
          phase: 'checking',
          source: 'winget',
          message: `系统级 winget 安装或安装后验证失败：${reason}，正在切换到经过校验的 MSI 安装包`,
          percent: null,
        })
      }
    }
  }

  const temporaryDirectory = await dependencies.createTemporaryDirectory()
  try {
    for (const source of nodeRuntimeDownloadSources(options.networkRegion)) {
      throwIfAborted(options.signal)
      try {
        const result = await installFromSource(
          source,
          architecture,
          temporaryDirectory,
          options,
          dependencies,
        )
        report(options, {
          phase: 'complete',
          source: source.id,
          message: `Node.js ${result.version ?? 'LTS'} 安装完成，重启本程序后即可使用`,
          percent: 100,
        })
        return result
      } catch (error) {
        failures.push(`${source.label}：${errorText(error)}`)
        if (options.signal?.aborted) throw error
        report(options, {
          phase: 'resolving',
          source: source.id,
          message: `${source.label}安装失败，正在尝试备用下载源`,
          percent: null,
        })
      }
    }
  } finally {
    await dependencies.removeTemporaryDirectory(temporaryDirectory).catch(() => undefined)
  }
  const message = `Node.js LTS 自动安装失败。${failures.join('；')}`
  report(options, { phase: 'error', source: null, message, percent: null })
  throw new Error(message)
}
