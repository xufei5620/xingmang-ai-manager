import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runCommand,
  trustedCommandEnvironment,
  type CommandResult,
  type RunCommandOptions,
} from './command-runner'
import {
  parseAuthenticodeSignature,
  resolveSystemWingetExecutable,
  type AuthenticodeSignature,
  type NodeRuntimeProcessPlan,
  type SystemWingetResolution,
} from './node-runtime'
import { sameLocalPathIdentity } from './path-identity'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { windowsPowerShellExecutable } from './windows-elevation'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

export type PythonRuntimeArchitecture = 'x64' | 'arm64'
export type PythonRuntimeSource = 'winget' | 'python-org'
export type PythonRuntimeInstallPhase =
  | 'checking'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'complete'
  | 'error'

export interface PythonRuntimeInstallProgress {
  phase: PythonRuntimeInstallPhase
  source: PythonRuntimeSource | null
  message: string
  percent: number | null
  transferredBytes?: number
  totalBytes?: number | null
}

export interface PythonRuntimeInstallResult {
  installed: true
  action: 'installed' | 'unchanged'
  method: 'winget' | 'exe' | null
  source: PythonRuntimeSource | null
  version: string | null
  architecture: PythonRuntimeArchitecture
  pathRefreshRequired: boolean
}

export interface PythonRuntimeRelease {
  version: string
  releaseId: number
}

export interface PythonRuntimeInstallerAsset extends PythonRuntimeRelease {
  architecture: PythonRuntimeArchitecture
  url: string
  fileName: string
  fileSize: number
}

export interface InstalledPythonRuntimeInspection {
  executable: string
  version: string
  signature: AuthenticodeSignature
}

export interface PythonRuntimeInstallerDependencies {
  fetch: typeof globalThis.fetch
  runProcess(plan: NodeRuntimeProcessPlan, signal?: AbortSignal): Promise<CommandResult>
  resolveWingetExecutable(signal?: AbortSignal): Promise<SystemWingetResolution>
  inspectInstalledPythonRuntime(signal?: AbortSignal): Promise<InstalledPythonRuntimeInspection>
  createTemporaryDirectory(): Promise<string>
  removeTemporaryDirectory(directory: string): Promise<void>
}

export interface InstallPythonRuntimeOptions {
  architecture?: NodeJS.Architecture
  signal?: AbortSignal
  onProgress?: (progress: PythonRuntimeInstallProgress) => void
  preferWinget?: boolean
  temporaryDirectoryMode?: 'trusted-only' | 'same-user'
  dependencies?: Partial<PythonRuntimeInstallerDependencies>
}

const releaseIndexUrl = 'https://www.python.org/api/v2/downloads/release/?version=3&is_published=true'
const releaseFilesUrl = (releaseId: number) => (
  `https://www.python.org/api/v2/downloads/release_file/?os=1&release=${releaseId}`
)
const metadataTimeoutMs = 30_000
const downloadTimeoutMs = 10 * 60_000
const installerTimeoutMs = 15 * 60_000
const maximumReleaseIndexBytes = 512 * 1024
const maximumReleaseFilesBytes = 256 * 1024
const minimumInstallerBytes = 10 * 1024 * 1024
const maximumInstallerBytes = 80 * 1024 * 1024

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const signatureScript = [
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop",
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_PYTHON_FILE_PATH -ErrorAction Stop',
  "$subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
  '[PSCustomObject]@{ status = [string]$signature.Status; subject = [string]$subject } | ConvertTo-Json -Compress',
].join('; ')

const installedRuntimeInspectionScript = [
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$ErrorActionPreference = "Stop"',
  "$ProgressPreference = 'SilentlyContinue'",
  "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop",
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_PYTHON_FILE_PATH -ErrorAction Stop',
  "$subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
  '$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:XINGMANG_PYTHON_FILE_PATH).ProductVersion',
  '[PSCustomObject]@{ status = [string]$signature.Status; subject = [string]$subject; version = [string]$version } | ConvertTo-Json -Compress',
].join('; ')

function report(options: InstallPythonRuntimeOptions, progress: PythonRuntimeInstallProgress): void {
  options.onProgress?.(progress)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('操作已取消')
}

function errorText(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return '未知错误'
}

function semverParts(version: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
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

export function isPython312RuntimeVersion(version: string | null | undefined): boolean {
  return /^(?:Python\s+)?3\.12(?:\.|$)/i.test(version?.trim() ?? '')
}

export function normalizePythonRuntimeArchitecture(architecture: NodeJS.Architecture): PythonRuntimeArchitecture {
  if (architecture === 'x64' || architecture === 'arm64') return architecture
  throw new Error(`Python 自动安装暂不支持 ${architecture} 架构，仅支持 Windows x64/arm64`)
}

export function parsePythonReleaseIndex(input: string): PythonRuntimeRelease[] {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > maximumReleaseIndexBytes) return []
  try {
    const value = JSON.parse(input) as unknown
    if (!Array.isArray(value)) return []
    const releases: PythonRuntimeRelease[] = []
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const match = typeof record.name === 'string'
        ? /^Python (3\.12\.(?:0|[1-9]\d*))$/.exec(record.name.trim())
        : null
      const resource = typeof record.resource_uri === 'string' ? record.resource_uri.trim() : ''
      const resourceMatch = /^https:\/\/www\.python\.org\/api\/v2\/downloads\/release\/(\d+)\/$/.exec(resource)
      if (!match || !resourceMatch || record.pre_release === true || record.is_published !== true) continue
      const releaseId = Number(resourceMatch[1])
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0) continue
      releases.push({ version: match[1], releaseId })
    }
    releases.sort((left, right) => compareVersions(right.version, left.version))
    return releases
  } catch {
    return []
  }
}

export function parsePythonReleaseFiles(
  input: string,
  release: PythonRuntimeRelease,
  architecture: PythonRuntimeArchitecture,
): PythonRuntimeInstallerAsset | null {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > maximumReleaseFilesBytes) return null
  try {
    const value = JSON.parse(input) as unknown
    if (!Array.isArray(value)) return null
    const expectedName = architecture === 'arm64'
      ? 'Windows installer (ARM64)'
      : 'Windows installer (64-bit)'
    const suffix = architecture === 'arm64' ? '-arm64.exe' : '-amd64.exe'
    const fileName = `python-${release.version}${suffix}`
    const expectedUrl = `https://www.python.org/ftp/python/${release.version}/${fileName}`
    const expectedRelease = `https://www.python.org/api/v2/downloads/release/${release.releaseId}/`
    const matches = value.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
      const record = entry as Record<string, unknown>
      return record.name === expectedName
        && record.release === expectedRelease
        && record.url === expectedUrl
        && Number.isSafeInteger(record.filesize)
        && Number(record.filesize) >= minimumInstallerBytes
        && Number(record.filesize) <= maximumInstallerBytes
    }) as Array<Record<string, unknown>>
    if (matches.length !== 1) return null
    return {
      ...release,
      architecture,
      url: expectedUrl,
      fileName,
      fileSize: Number(matches[0].filesize),
    }
  } catch {
    return null
  }
}

export function validatePythonAuthenticodeSignature(signature: AuthenticodeSignature): string | null {
  if (signature.status.toLowerCase() !== 'valid') {
    return `数字签名状态不是 Valid（${signature.status || '空'}）`
  }
  const commonName = /(?:^|,)\s*CN=([^,]+)/i.exec(signature.subject)?.[1]?.trim()
  if (commonName !== 'Python Software Foundation') {
    return '数字签名发布者不是 Python Software Foundation'
  }
  return null
}

export function validatePythonResponseUrl(actual: string, expected: string): void {
  let actualUrl: URL
  let expectedUrl: URL
  try {
    actualUrl = new URL(actual)
    expectedUrl = new URL(expected)
  } catch {
    throw new Error('Python 下载响应地址无效')
  }
  const safe = (url: URL) => (
    url.protocol === 'https:'
    && url.hostname.toLowerCase() === 'www.python.org'
    && !url.port
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && url.pathname.startsWith('/ftp/python/')
    && !url.pathname.includes('\\')
    && !/(?:^|\/)\.\.?($|\/)/.test(url.pathname)
  )
  if (!safe(actualUrl) || !safe(expectedUrl) || actualUrl.href !== expectedUrl.href) {
    throw new Error('Python 下载重定向到了未经批准的资源')
  }
}

export function buildPythonRuntimeWingetPlan(executable: string): NodeRuntimeProcessPlan {
  if (
    !path.win32.isAbsolute(executable)
    || path.win32.basename(executable).toLowerCase() !== 'winget.exe'
    || executable.includes('\0')
  ) throw new Error('系统级 winget 路径无效')
  return {
    executable,
    argv: [
      'install',
      '--id',
      'Python.Python.3.12',
      '--exact',
      '--source',
      'winget',
      '--scope',
      'user',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ],
    timeoutMs: installerTimeoutMs,
    acceptedExitCodes: [0],
  }
}

export function buildPythonRuntimeInstallPlan(
  installerPath: string,
  powershellExecutable = windowsPowerShellExecutable(),
  trustedOnly = true,
  machinePaths?: WindowsMachinePaths,
): { signature: NodeRuntimeProcessPlan; installer: NodeRuntimeProcessPlan } {
  const roots = machinePaths ?? (process.platform === 'win32' ? resolveWindowsMachinePaths() : undefined)
  const env = {
    ...trustedCommandEnvironment(process.env, roots, roots ? 'win32' : process.platform),
    XINGMANG_PYTHON_FILE_PATH: installerPath,
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
      env,
      trustedPaths: [installerPath],
      ...(!trustedOnly ? { trustedOnly: false } : {}),
    },
    installer: {
      executable: installerPath,
      argv: [
        '/quiet',
        'InstallAllUsers=0',
        'PrependPath=1',
        'Include_launcher=1',
        'InstallLauncherAllUsers=0',
        'Include_pip=1',
        'Include_test=0',
        'Shortcuts=0',
      ],
      timeoutMs: installerTimeoutMs,
      acceptedExitCodes: [0],
      env,
      trustedPaths: [installerPath],
      ...(!trustedOnly ? { trustedOnly: false } : {}),
    },
  }
}

function verifiedPythonRuntimeWingetPlan(executable: string): NodeRuntimeProcessPlan {
  return {
    ...buildPythonRuntimeWingetPlan(executable),
    // `resolveSystemWingetExecutable` already tied this canonical path to the
    // protected Microsoft App Installer package. Re-running the generic ACL
    // heuristic against WindowsApps incorrectly rejects valid installations.
    trustedOnly: false,
    env: trustedCommandEnvironment(),
  }
}

async function readBoundedText(response: Response, maximumBytes: number, label: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${label}响应过大`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error(`${label}响应过大`)
  return text
}

async function fetchJsonText(
  url: string,
  maximumBytes: number,
  fetchImplementation: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Python 发布信息查询超时')), metadataTimeoutMs)
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetchImplementation(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Python 官方发布接口 HTTP ${response.status}`)
    if (response.url && response.url !== url) throw new Error('Python 发布信息重定向到了未经批准的地址')
    return await readBoundedText(response, maximumBytes, 'Python 发布信息')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function resolveLatestInstaller(
  architecture: PythonRuntimeArchitecture,
  dependencies: PythonRuntimeInstallerDependencies,
  signal?: AbortSignal,
): Promise<PythonRuntimeInstallerAsset> {
  const releases = parsePythonReleaseIndex(await fetchJsonText(
    releaseIndexUrl,
    maximumReleaseIndexBytes,
    dependencies.fetch,
    signal,
  ))
  if (releases.length === 0) throw new Error('Python 官方接口未返回可用的 3.12 稳定版本')
  for (const release of releases) {
    throwIfAborted(signal)
    const files = await fetchJsonText(
      releaseFilesUrl(release.releaseId),
      maximumReleaseFilesBytes,
      dependencies.fetch,
      signal,
    )
    const asset = parsePythonReleaseFiles(files, release, architecture)
    if (asset) return asset
  }
  throw new Error(`Python 官方接口未返回 Windows ${architecture} 的 3.12 安装包`)
}

async function downloadInstaller(
  asset: PythonRuntimeInstallerAsset,
  directory: string,
  options: InstallPythonRuntimeOptions,
  dependencies: PythonRuntimeInstallerDependencies,
): Promise<{ filePath: string; sha256: string }> {
  const filePath = path.join(directory, asset.fileName)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Python 安装包下载超时')), downloadTimeoutMs)
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  let file: fs.promises.FileHandle | null = null
  try {
    const response = await dependencies.fetch(asset.url, { redirect: 'error', signal: controller.signal })
    if (!response.ok) throw new Error(`Python 安装包下载失败：HTTP ${response.status}`)
    validatePythonResponseUrl(response.url || asset.url, asset.url)
    const declaredHeader = response.headers.get('content-length')
    const declared = declaredHeader === null ? null : Number(declaredHeader)
    if (declared !== null && Number.isFinite(declared) && declared !== asset.fileSize) {
      throw new Error('Python 安装包大小与官方发布信息不一致')
    }
    if (!response.body) throw new Error('Python 安装包响应没有可读取内容')
    file = await fs.promises.open(filePath, 'wx')
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let transferredBytes = 0
    while (true) {
      throwIfAborted(options.signal)
      const { done, value } = await reader.read()
      if (done) break
      transferredBytes += value.byteLength
      if (transferredBytes > asset.fileSize || transferredBytes > maximumInstallerBytes) {
        throw new Error('Python 安装包超过官方声明大小')
      }
      hash.update(value)
      await file.write(value)
      report(options, {
        phase: 'downloading',
        source: 'python-org',
        message: `正在下载 Python ${asset.version} 官方安装包`,
        percent: Math.min(100, (transferredBytes / asset.fileSize) * 100),
        transferredBytes,
        totalBytes: asset.fileSize,
      })
    }
    if (transferredBytes !== asset.fileSize) throw new Error('Python 安装包下载不完整')
    await file.sync()
    await file.close()
    file = null
    return { filePath, sha256: hash.digest('hex') }
  } catch (error) {
    await file?.close().catch(() => undefined)
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function inspectSignature(
  filePath: string,
  dependencies: PythonRuntimeInstallerDependencies,
  trustedOnly: boolean,
  signal?: AbortSignal,
): Promise<AuthenticodeSignature> {
  const plan = buildPythonRuntimeInstallPlan(filePath, windowsPowerShellExecutable(), trustedOnly).signature
  const result = await dependencies.runProcess(plan, signal)
  const signature = parseAuthenticodeSignature(result.stdout)
  if (!signature) throw new Error('无法解析 Python 文件数字签名')
  const signatureError = validatePythonAuthenticodeSignature(signature)
  if (signatureError) throw new Error(`Python 文件${signatureError}`)
  return signature
}

function localPythonExecutable(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim()
    || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe')
}

export async function inspectInstalledPythonRuntime(
  signal?: AbortSignal,
): Promise<InstalledPythonRuntimeInspection> {
  const expected = localPythonExecutable()
  const real = await fs.promises.realpath(expected).catch(() => null)
  if (!real || !sameLocalPathIdentity(expected, real)) throw new Error('未检测到 Python 3.12 当前用户安装')
  const stat = await fs.promises.stat(real)
  if (!stat.isFile()) throw new Error('Python 3.12 可执行文件不是普通文件')
  const inspectionResult = await defaultRunProcess({
    executable: windowsPowerShellExecutable(),
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedPowerShellCommand(installedRuntimeInspectionScript),
    ],
    timeoutMs: 60_000,
    acceptedExitCodes: [0],
    env: { ...process.env, XINGMANG_PYTHON_FILE_PATH: real },
  }, signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(inspectionResult.stdout.trim()) as unknown
  } catch {
    throw new Error('无法解析安装后的 Python 验证结果')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('安装后的 Python 验证结果无效')
  }
  const record = parsed as Record<string, unknown>
  const signature: AuthenticodeSignature = {
    status: typeof record.status === 'string' ? record.status : '',
    subject: typeof record.subject === 'string' ? record.subject : '',
  }
  const signatureError = validatePythonAuthenticodeSignature(signature)
  if (signatureError) throw new Error('安装后的 Python ' + signatureError)
  const version = typeof record.version === 'string' && isPython312RuntimeVersion(record.version)
    ? 'Python 3.12'
    : null
  if (!version) throw new Error('安装后的 Python 版本不是受支持的 3.12')
  return { executable: real, version, signature }
}

async function defaultRunProcess(
  plan: NodeRuntimeProcessPlan,
  signal?: AbortSignal,
): Promise<CommandResult> {
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

const defaultDependencies: PythonRuntimeInstallerDependencies = {
  fetch: globalThis.fetch,
  runProcess: defaultRunProcess,
  resolveWingetExecutable: resolveSystemWingetExecutable,
  inspectInstalledPythonRuntime,
  createTemporaryDirectory: () => createTrustedTemporaryDirectory('python-runtime'),
  removeTemporaryDirectory: (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
}

export async function installPythonRuntime(
  options: InstallPythonRuntimeOptions = {},
): Promise<PythonRuntimeInstallResult> {
  if (process.platform !== 'win32') throw new Error('Python 自动安装当前仅支持 Windows')
  const architecture = normalizePythonRuntimeArchitecture(options.architecture ?? process.arch)
  const dependencies: PythonRuntimeInstallerDependencies = {
    ...defaultDependencies,
    ...(options.temporaryDirectoryMode === 'same-user'
      ? { createTemporaryDirectory: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-python-runtime-')) }
      : {}),
    ...options.dependencies,
  }
  const failures: string[] = []
  throwIfAborted(options.signal)

  if (options.preferWinget !== false) {
    report(options, {
      phase: 'checking',
      source: 'winget',
      message: '正在检测受信任的系统级 Windows 程序包管理器',
      percent: null,
    })
    const winget = await dependencies.resolveWingetExecutable(options.signal).catch((error) => ({
      executable: null,
      reason: `系统级 winget 解析失败：${errorText(error)}`,
    }))
    if (winget.executable) {
      try {
        report(options, {
          phase: 'installing',
          source: 'winget',
          message: '正在以当前用户身份安装 Python 3.12',
          percent: null,
        })
        await dependencies.runProcess(verifiedPythonRuntimeWingetPlan(winget.executable), options.signal)
        const installed = await dependencies.inspectInstalledPythonRuntime(options.signal)
        report(options, {
          phase: 'complete',
          source: 'winget',
          message: `${installed.version} 安装完成`,
          percent: 100,
        })
        return {
          installed: true,
          action: 'installed',
          method: 'winget',
          source: 'winget',
          version: installed.version,
          architecture,
          pathRefreshRequired: true,
        }
      } catch (error) {
        failures.push(`winget：${errorText(error)}`)
        report(options, {
          phase: 'resolving',
          source: 'python-org',
          message: 'winget 安装或复检失败，正在切换到 Python 官方安装包',
          percent: null,
        })
      }
    } else {
      failures.push(`winget：${winget.reason || '未找到可安全执行的系统级 winget'}`)
    }
  }

  const temporaryDirectory = await dependencies.createTemporaryDirectory()
  try {
    report(options, {
      phase: 'resolving',
      source: 'python-org',
      message: '正在查询 Python 3.12 最新稳定安装包',
      percent: null,
    })
    const asset = await resolveLatestInstaller(architecture, dependencies, options.signal)
    const download = await downloadInstaller(asset, temporaryDirectory, options, dependencies)
    report(options, {
      phase: 'verifying',
      source: 'python-org',
      message: '正在校验 Python 官方安装包数字签名',
      percent: null,
    })
    const trustedOnly = options.temporaryDirectoryMode !== 'same-user'
    await inspectSignature(download.filePath, dependencies, trustedOnly, options.signal)
    if (await sha256File(download.filePath) !== download.sha256) {
      throw new Error('Python 安装包在签名校验后发生变化')
    }
    const stat = await fs.promises.stat(download.filePath)
    if (!stat.isFile() || stat.size !== asset.fileSize) throw new Error('Python 安装包在校验后发生变化')
    report(options, {
      phase: 'installing',
      source: 'python-org',
      message: `正在以当前用户身份静默安装 Python ${asset.version}`,
      percent: null,
    })
    const plan = buildPythonRuntimeInstallPlan(
      download.filePath,
      windowsPowerShellExecutable(),
      trustedOnly,
    )
    await dependencies.runProcess(plan.installer, options.signal)
    const installed = await dependencies.inspectInstalledPythonRuntime(options.signal)
    report(options, {
      phase: 'complete',
      source: 'python-org',
      message: `${installed.version} 安装完成`,
      percent: 100,
    })
    return {
      installed: true,
      action: 'installed',
      method: 'exe',
      source: 'python-org',
      version: installed.version,
      architecture,
      pathRefreshRequired: true,
    }
  } catch (error) {
    failures.push(`Python 官方安装包：${errorText(error)}`)
    report(options, {
      phase: 'error',
      source: 'python-org',
      message: 'Python 自动安装失败',
      percent: null,
    })
    throw new Error(`Python 3.12 自动安装失败：${failures.join('；')}`)
  } finally {
    await dependencies.removeTemporaryDirectory(temporaryDirectory).catch(() => undefined)
  }
}
