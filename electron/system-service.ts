import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type AppSettings, AppSettingsStore } from './app-settings'
import { cliCatalog, providerIds, type ProviderId } from './catalog'
import {
  defaultProviderConfigRoots,
  type ProviderConfigRoots,
} from './codex-home'
import {
  cleanCommandOutput,
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  isUserWritablePath,
  redactCommandText,
  runCommand,
  trustedCommandEnvironment,
  windowsSystemExecutable,
  type WindowsPackageManager,
} from './command-runner'
import {
  codexDesktopPackageValidationError,
  compareWindowsPackageVersions,
  parseCodexDesktopAppManifest,
  parseCodexDesktopMirrorManifest,
  parseCodexDesktopPackageMetadata,
  parseCodexDesktopPackagePath,
  parseCodexDesktopPackagesJson,
  parseCodexDesktopUpdateManifest,
  parseStartAppsJson,
  parseWindowsProcessesJson,
  selectCodexDesktopApp,
  selectCodexDesktopPackage,
  isCodexDesktopExecutable,
  stopCodexDesktopProcesses,
  type CodexDesktopPackageEntry,
  type CodexDesktopPackageMetadata,
  type CodexDesktopMirrorRelease,
  type StartAppEntry,
  type WindowsProcessEntry,
} from './codex-desktop'
import {
  inspectProviderConfig,
  saveProviderConfig,
  toNativeConfigSummary,
  type NativeConfigSaveMode,
  type NativeConfigSummary,
} from './config-files'
import { parseModelIds } from './models'
import {
  cliUninstallCapability,
  findNpmExecutable,
  resolveCliCommand,
  resolveCliInstallation,
  resolveNpmGlobalRoot,
  type CliInstallation,
  type CliUninstallCapability,
} from './tool-installation'
import { isNewerVersion, nodeVersionStatus, type NodeVersionStatus } from './versions'
import {
  installNodeRuntime as installNodeRuntimeLts,
  type NodeRuntimeInstallResult,
} from './node-runtime'
import { InstallationQueue } from './installation-queue'
import {
  assertTrustedElevatedCliCommand,
  launchCliPowerShell,
  launchUnelevatedCommandWindow,
  resolveWindowsPowerShellExecutable,
  type WindowsCliExecutionMode,
} from './windows-elevation'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { resolveWindowsExplorerExecutable } from './system-shell'
import { resolveWindowsMachinePaths } from './windows-machine-paths'
import { createManagedNpmCache, ensureManagedNpmLayout, type ManagedNpmLayout } from './managed-cli'
import { managedNativeProviderRoot, managedNpmPrefix } from './managed-cli-paths'
import { fetchGrokStableVersion } from './grok-update'
import { readBoundedUtf8File } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'
import { launchMacosTerminal, type MacosTerminalLaunchPlan } from './macos-platform'
import {
  inspectDarwinGrokVerifiedSelection,
  resolveDarwinGrokCanonicalSelection,
  runDarwinGrokPostInstallTransaction,
  verifyDarwinGrokUninstallPlan,
} from './macos-grok'
import { inspectMacosCodexApp, type MacosCodexAppInfo } from './macos-codex-app'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'
import { sameLocalPathIdentity } from './path-identity'
import {
  cleanupDownloadedGrokBinary,
  downloadLatestGrokBinary,
  installDownloadedGrokBinary,
  type DownloadedGrokBinary,
} from './grok-installer'

const execFileAsync = promisify(execFile)
const npmLatestCacheTtlMs = 10 * 60_000
const npmLatestFailureCacheTtlMs = 2 * 60_000
// Version checks run during the dashboard's initial scan. Keep each registry
// attempt bounded so an offline machine reaches the UI with an explicit
// "检查失败" state instead of appearing frozen for a minute or longer.
const npmLatestQueryTimeoutMs = 10_000
const maximumNpmRegistryResponseBytes = 256 * 1024
const maximumNpmPackageLockBytes = 16 * 1024 * 1024
export const networkLocationCacheTtlMs = 10 * 60_000
const codexDesktopLatestCacheTtlMs = 10 * 60_000
const codexDesktopLatestFailureCacheTtlMs = 30_000
const codexDesktopUpdateManifestUrl = 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json'
const codexDesktopMirrorManifestUrl = 'https://codexapp.agentsmirror.com/latest/manifest'
const codexDesktopMirrorPackageUrls = {
  x64: 'https://codexapp.agentsmirror.com/latest/win-x64',
  arm64: 'https://codexapp.agentsmirror.com/latest/win-arm64',
} as const
const codexDesktopMirrorHosts = new Set([
  'codexapp.agentsmirror.com',
  'codexapp-r2.agentsmirror.com',
])
const codexDesktopMirrorObjectStorageHost = 'fgws3-ocloud.ihep.ac.cn'
const codexDesktopMirrorObjectStoragePrefix = '/20830-codex'
const codexDesktopMirrorSignedQueryKeys = new Set([
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'response-content-disposition',
  'response-content-type',
  'X-Amz-Signature',
])
const codexDesktopRedirectStatuses = new Set([301, 302, 303, 307, 308])
const maximumCodexDesktopRedirects = 2
const npmOfficialRegistry = 'https://registry.npmjs.org'
const npmMirrorRegistry = 'https://registry.npmmirror.com'
const networkLocationUrl = 'https://www.cloudflare.com/cdn-cgi/trace'
const minimumCodexDesktopPackageBytes = 10 * 1024 * 1024
const maximumCodexDesktopPackageBytes = 1_500 * 1024 * 1024
const maximumCodexDesktopManifestBytes = 1024 * 1024
const maximumCodexDesktopAppManifestBytes = 512 * 1024
const maximumModelResponseBytes = 1024 * 1024
const modelAccessCacheMaxEntries = 32
const maximumRuntimeManifestBytes = 256 * 1024
const maximumGrokVersionMetadataBytes = 16 * 1024
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,126})?)?(?:\+[0-9A-Za-z](?:[0-9A-Za-z.-]{0,126})?)?$/

export type UpdateCheckStatus = 'checked' | 'failed' | 'skipped'
export type UpdateState = 'available' | 'latest' | 'unknown'
export type UpdateSource = 'npm' | 'native' | 'windows-appx' | 'official-manifest' | 'winget' | null

export interface VersionUpdateStatus {
  latestVersion: string | null
  updateAvailable: boolean | null
  updateSource: UpdateSource
  updateCheck: UpdateCheckStatus
  updateState: UpdateState
  updateCheckedAt: string | null
  updateError: string | null
}

export interface ToolStatus {
  installed: boolean
  version: string | null
  path: string | null
  installDirectory: string | null
  tooOld?: boolean
  versionStatus?: NodeVersionStatus
  uninstall?: CliUninstallCapability
}

export interface CliStatus extends ToolStatus {
  latestVersion: string | null
  updateAvailable: boolean
  updateSource?: UpdateSource
  updateCheck?: UpdateCheckStatus
  updateState?: UpdateState
  updateCheckedAt?: string | null
  updateError?: string | null
  uninstall: CliUninstallCapability
}

export interface DesktopAppStatus extends ToolStatus, Partial<VersionUpdateStatus> {
  appVersion: string | null
  mirrorVersion: string | null
  mirrorUpdateAvailable: boolean | null
  mirrorError: string | null
  running: boolean
}

export interface LatestVersionProbe {
  status: UpdateCheckStatus
  version: string | null
  source: 'npm' | 'native' | 'official-manifest'
  checkedAt: string
  error: string | null
}

/**
 * The color layer must sit on top of a caller-selected base. An elevated
 * terminal has to start from `trustedCommandEnvironment`, but that base cannot
 * be applied unconditionally: callers that stay at the current integrity level
 * would lose every user-writable PATH entry for no security gain. Sanitizing
 * after the color layer is not an option either, because the sanitizer strips
 * TERM/COLORTERM/FORCE_COLOR and would leave the terminal monochrome.
 */
export function interactiveTerminalEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  buildBaseEnvironment: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = commandEnvironment,
): NodeJS.ProcessEnv {
  const env = buildBaseEnvironment(baseEnv)
  const colorKeys = new Set([
    'term',
    'colorterm',
    'force_color',
    'no_color',
    'node_disable_colors',
    'clicolor',
    'clicolor_force',
  ])
  for (const key of Object.keys(env)) {
    if (colorKeys.has(key.toLowerCase())) delete env[key]
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.FORCE_COLOR = '3'
  env.CLICOLOR = '1'
  env.CLICOLOR_FORCE = '1'
  return env
}

/** Keeps service-level macOS launching bound to the command already verified by CLI resolution. */
export function buildDarwinCliLaunchPlan(
  command: { executable: string; argv: readonly string[] },
  workspace: string,
  env: NodeJS.ProcessEnv,
): MacosTerminalLaunchPlan {
  if (!path.isAbsolute(command.executable)) {
    throw new Error('macOS CLI executable must be an absolute resolved path')
  }
  if (!path.isAbsolute(workspace)) throw new Error('macOS workspace must be an absolute path')
  return { executable: command.executable, argv: [...command.argv], workspace, env }
}

export interface CodexDesktopLaunchPlan {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  windowsHide: boolean
}

/** Launches the AppsFolder URI through the canonical SystemRoot Explorer. */
export function buildCodexDesktopLaunchPlan(
  appUserModelId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): CodexDesktopLaunchPlan {
  if (!appUserModelId.trim() || appUserModelId.includes('\0') || appUserModelId.length > 2_048) {
    throw new Error('Codex Desktop 应用标识无效')
  }
  const machinePaths = resolveWindowsMachinePaths()
  const executable = resolveWindowsExplorerExecutable({ platform: 'win32', machinePaths })
  return {
    executable,
    args: [`shell:AppsFolder\\${appUserModelId}`],
    cwd: machinePaths.systemRoot,
    env: trustedCommandEnvironment(baseEnv, machinePaths),
    windowsHide: false,
  }
}

export interface DesktopLatestVersionProbe {
  status: 'checked' | 'failed'
  version: string | null
  source: 'official-manifest'
  checkedAt: string
  error: string | null
}

interface DesktopMirrorVersionProbe {
  version: string | null
  checkedAt: string
  error: string | null
}

export interface SystemSnapshot {
  checkedAt: string
  network: NetworkLocationStatus
  runtime: {
    node: ToolStatus
    npm: ToolStatus
    python: ToolStatus
  }
  clis: Record<ProviderId, CliStatus>
  desktopApps: {
    codex: DesktopAppStatus
  }
}

export interface CodexDesktopLaunchResult {
  restarted: boolean
  status: DesktopAppStatus
}

export type CodexDesktopInstallPhase =
  | 'downloading'
  | 'validating'
  | 'closing'
  | 'installing'
  | 'completed'
  | 'error'

export interface CodexDesktopInstallProgress {
  phase: CodexDesktopInstallPhase
  percent: number | null
  message: string
}

export interface CodexDesktopInstallResult {
  action: 'installed' | 'updated' | 'unchanged'
  previousVersion: string | null
  installedVersion: string | null
}

export type ToolUninstallResult =
  | {
      /** delegated：已交给以登录用户身份运行的窗口执行，结果需用户完成后刷新确认。 */
      outcome: 'uninstalled' | 'not-installed' | 'delegated'
      previousVersion: string | null
    }
  | {
      outcome: 'manual-required'
      previousVersion: string | null
      error: string
      manualHelp: {
        reason: string
        manualCommand: null
      }
    }

export interface CodexDesktopPackageSource {
  label: string
  url: string
  expectedContentLength?: number
  expectedSha256Base64?: string
}

export interface CodexDesktopDownloadProgress {
  transferred: number
  total: number
  percent: number
}

export interface CodexDesktopDownloadResult {
  transferred: number
  total: number
  sha256Base64: string
}

export interface CodexDesktopManifestSource extends CodexDesktopPackageSource {
  kind: 'official' | 'mirror'
}

function validateCodexDesktopMirrorObjectStorageUrl(parsed: URL, original: URL): boolean {
  if (parsed.hostname !== codexDesktopMirrorObjectStorageHost) return false
  if (parsed.pathname !== `${codexDesktopMirrorObjectStoragePrefix}${original.pathname}`) return false

  let expectedContentType: string
  let expectedFileName: string
  if (original.pathname === '/latest/manifest') {
    expectedContentType = 'application/json'
    expectedFileName = 'release-manifest.json'
  } else {
    const packageMatch = original.pathname.match(/^\/latest\/win-(x64|arm64)$/)
    if (!packageMatch) return false
    expectedContentType = 'application/vnd.ms-appx'
    expectedFileName = `Codex-Windows-${packageMatch[1]}.msix`
  }

  const entries = [...parsed.searchParams.entries()]
  const keys = new Set(entries.map(([key]) => key))
  if (
    entries.length !== codexDesktopMirrorSignedQueryKeys.size
    || keys.size !== entries.length
    || [...keys].some((key) => !codexDesktopMirrorSignedQueryKeys.has(key))
  ) {
    return false
  }

  const credential = parsed.searchParams.get('X-Amz-Credential') ?? ''
  const expires = Number(parsed.searchParams.get('X-Amz-Expires'))
  return parsed.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
    && /^[A-Za-z0-9]{8,128}\/\d{8}\/auto\/s3\/aws4_request$/.test(credential)
    && /^\d{8}T\d{6}Z$/.test(parsed.searchParams.get('X-Amz-Date') ?? '')
    && Number.isSafeInteger(expires)
    && expires >= 1
    && expires <= 3_600
    && parsed.searchParams.get('X-Amz-SignedHeaders') === 'host'
    && parsed.searchParams.get('response-content-disposition') === `attachment; filename="${expectedFileName}"`
    && parsed.searchParams.get('response-content-type') === expectedContentType
    && /^[a-f0-9]{64}$/i.test(parsed.searchParams.get('X-Amz-Signature') ?? '')
}

export function validateCodexDesktopResourceUrl(value: string, originalUrl: string): URL {
  let parsed: URL
  let original: URL
  try {
    parsed = new URL(value)
    original = new URL(originalUrl)
  } catch {
    throw new Error('Codex Desktop 下载地址格式无效')
  }
  const allowedHosts = codexDesktopMirrorHosts.has(original.hostname)
    ? codexDesktopMirrorHosts
    : new Set([original.hostname])
  const staticResource = !parsed.search
    && allowedHosts.has(parsed.hostname)
    && parsed.pathname === original.pathname
  const signedMirrorObject = codexDesktopMirrorHosts.has(original.hostname)
    && validateCodexDesktopMirrorObjectStorageUrl(parsed, original)
  if (
    parsed.protocol !== 'https:'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash
    || (!staticResource && !signedMirrorObject)
  ) {
    throw new Error('Codex Desktop 下载发生了不受信任的重定向')
  }
  return parsed
}

async function fetchTrustedCodexDesktopResource(
  sourceUrl: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
): Promise<Response> {
  const original = validateCodexDesktopResourceUrl(sourceUrl, sourceUrl)
  let current = original
  const visited = new Set<string>()
  for (let redirectCount = 0; redirectCount <= maximumCodexDesktopRedirects; redirectCount += 1) {
    if (visited.has(current.href)) throw new Error('Codex Desktop 下载发生了循环重定向')
    visited.add(current.href)
    const response = await fetchImplementation(current.href, { ...init, redirect: 'manual' })
    if (response.url) {
      const responseUrl = validateCodexDesktopResourceUrl(response.url, original.href)
      if (responseUrl.href !== current.href) {
        throw new Error('Codex Desktop 下载绕过了受限重定向策略')
      }
    }
    if (!codexDesktopRedirectStatuses.has(response.status)) return response
    if (redirectCount === maximumCodexDesktopRedirects) {
      throw new Error('Codex Desktop 下载重定向次数过多')
    }
    const location = response.headers.get('location')
    if (!location) throw new Error('Codex Desktop 下载重定向缺少 Location')
    await response.body?.cancel().catch(() => undefined)
    current = validateCodexDesktopResourceUrl(new URL(location, current).href, original.href)
  }
  throw new Error('Codex Desktop 下载重定向次数过多')
}

export function buildCodexDesktopPackageSources(
  architecture: 'x64' | 'arm64',
): CodexDesktopPackageSource[] {
  return [{ label: '国内镜像', url: codexDesktopMirrorPackageUrls[architecture] }]
}

/**
 * Mirror first, matching the package download, which is mirror-only. Reading
 * the version from the official manifest while the bytes can only come from the
 * mirror let the two disagree: the card could advertise a release the install
 * path had no way to fetch. Both endpoints stay in the list and both still go
 * through fetchTrustedCodexDesktopResource, so this only changes which is tried
 * first, never how either is validated.
 */
export function buildCodexDesktopManifestSources(
): CodexDesktopManifestSource[] {
  return [
    { kind: 'mirror', label: '国内镜像', url: codexDesktopMirrorManifestUrl },
    { kind: 'official', label: 'OpenAI 官方源', url: codexDesktopUpdateManifestUrl },
  ]
}

export async function fetchCodexDesktopMirrorRelease(
  architecture: 'x64' | 'arm64',
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexDesktopMirrorRelease> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetchTrustedCodexDesktopResource(codexDesktopMirrorManifestUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }, fetchImplementation)
    if (!response.ok) throw new Error(`返回 HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('application/json')) throw new Error('返回的不是 JSON 响应')
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
      throw new Error('响应超过 256 KB 安全上限')
    }
    if (!response.body) throw new Error('没有响应正文')

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      received += chunk.value.byteLength
      if (received > 256 * 1024) throw new Error('响应超过 256 KB 安全上限')
      chunks.push(chunk.value)
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
    const release = parseCodexDesktopMirrorManifest(text, architecture)
    if (!release) {
      throw new Error('schema、产品 ID、包身份、版本、架构、文件大小或 SHA-256 校验失败')
    }
    return release
  } catch (error) {
    const detail = error instanceof Error && error.name === 'AbortError'
      ? '连接或读取超时'
      : (error instanceof Error ? error.message : String(error))
    throw new Error(`国内镜像清单读取失败：${detail}`)
  } finally {
    clearTimeout(timeout)
  }
}

export async function downloadCodexDesktopPackage(
  source: CodexDesktopPackageSource,
  destination: string,
  onProgress: (progress: CodexDesktopDownloadProgress) => void,
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexDesktopDownloadResult> {
  const controller = new AbortController()
  const responseTimeout = setTimeout(() => controller.abort(), 20_000)
  let file: fs.promises.FileHandle | null = null
  try {
    const response = await fetchTrustedCodexDesktopResource(source.url, {
      headers: { Accept: 'application/vnd.ms-appx, application/octet-stream' },
      signal: controller.signal,
    }, fetchImplementation)
    clearTimeout(responseTimeout)
    if (!response.ok) throw new Error(`${source.label}返回 HTTP ${response.status}`)

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (
      !contentType.includes('application/vnd.ms-appx')
      && !contentType.includes('application/octet-stream')
      && !contentType.includes('binary/octet-stream')
    ) {
      throw new Error(`${source.label}返回的不是 MSIX 文件（Content-Type: ${contentType || '缺失'}）`)
    }

    const total = Number(response.headers.get('content-length'))
    if (!Number.isSafeInteger(total) || total < minimumCodexDesktopPackageBytes) {
      throw new Error(`${source.label}返回的安装包大小无效`)
    }
    if (total > maximumCodexDesktopPackageBytes) {
      throw new Error(`${source.label}返回的安装包超过 1.5 GB 安全上限`)
    }
    if (
      source.expectedContentLength !== undefined
      && total !== source.expectedContentLength
    ) {
      throw new Error(
        `${source.label}返回的 Content-Length 与镜像清单不一致：应为 ${source.expectedContentLength} 字节，实际 ${total} 字节`,
      )
    }
    if (!response.body) throw new Error(`${source.label}未返回安装包内容`)

    file = await fs.promises.open(destination, 'wx', 0o600)
    const reader = response.body.getReader()
    const sha256 = createHash('sha256')
    let transferred = 0
    let lastPercent = -1
    while (true) {
      const idleTimeout = setTimeout(() => controller.abort(), 45_000)
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } finally {
        clearTimeout(idleTimeout)
      }
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      transferred += chunk.value.byteLength
      if (transferred > total || transferred > maximumCodexDesktopPackageBytes) {
        throw new Error(`${source.label}返回的数据超过声明的安装包大小`)
      }
      sha256.update(chunk.value)
      await file.write(chunk.value)
      const percent = Math.min(100, Math.floor((transferred / total) * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        onProgress({ transferred, total, percent })
      }
    }
    if (transferred !== total) {
      throw new Error(`${source.label}下载不完整：应为 ${total} 字节，实际 ${transferred} 字节`)
    }
    const sha256Base64 = sha256.digest('base64')
    if (
      source.expectedSha256Base64 !== undefined
      && sha256Base64 !== source.expectedSha256Base64
    ) {
      throw new Error(`${source.label}安装包 SHA-256 与镜像清单不一致，文件可能已损坏`)
    }
    await file.sync()
    return { transferred, total, sha256Base64 }
  } catch (error) {
    const cause = error instanceof Error && error.name === 'AbortError'
      ? new Error(`${source.label}连接或下载超时`)
      : error
    await file?.close().catch(() => undefined)
    file = null
    await fs.promises.rm(destination, { force: true }).catch(() => undefined)
    throw cause
  } finally {
    clearTimeout(responseTimeout)
    await file?.close().catch(() => undefined)
  }
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function inspectCodexDesktopPackageFile(
  packagePath: string,
): Promise<CodexDesktopPackageMetadata> {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$archive = [System.IO.Compression.ZipFile]::OpenRead(${powershellLiteral(packagePath)})`,
    'try {',
    "  $manifestEntry = $archive.Entries | Where-Object { $_.FullName -ieq 'AppxManifest.xml' } | Select-Object -First 1",
    "  $signatureEntry = $archive.Entries | Where-Object { $_.FullName -ieq 'AppxSignature.p7x' } | Select-Object -First 1",
    "  if ($null -eq $manifestEntry) { throw 'MSIX 中缺少 AppxManifest.xml' }",
    `  if ($manifestEntry.Length -le 0 -or $manifestEntry.Length -gt ${maximumCodexDesktopManifestBytes}) { throw 'AppxManifest.xml 大小无效或超过 1 MiB 安全上限' }`,
    '  $stream = $manifestEntry.Open()',
    '  try {',
    '    $settings = [System.Xml.XmlReaderSettings]::new()',
    '    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit',
    '    $settings.XmlResolver = $null',
    `    $settings.MaxCharactersInDocument = ${maximumCodexDesktopManifestBytes}`,
    '    $reader = [System.Xml.XmlReader]::Create($stream, $settings)',
    '    try {',
    '      $manifest = [System.Xml.XmlDocument]::new()',
    '      $manifest.XmlResolver = $null',
    '      $manifest.Load($reader)',
    '    } finally { $reader.Dispose() }',
    '  } finally { $stream.Dispose() }',
    '  $identity = $manifest.SelectSingleNode(\'/*[local-name()="Package"]/*[local-name()="Identity"]\')',
    "  if ($null -eq $identity) { throw 'AppxManifest.xml 中缺少 Package/Identity' }",
    '  [pscustomobject]@{',
    '    name = [string]$identity.GetAttribute(\'Name\')',
    '    version = [string]$identity.GetAttribute(\'Version\')',
    '    architecture = [string]$identity.GetAttribute(\'ProcessorArchitecture\')',
    '    publisher = [string]$identity.GetAttribute(\'Publisher\')',
    '    hasSignature = ($null -ne $signatureEntry)',
    '  } | ConvertTo-Json -Compress',
    '} finally { $archive.Dispose() }',
  ].join('\n')
  const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env: trustedCommandEnvironment(),
    windowsHide: true,
    // The first inspection on a machine pays for loading the compression and
    // XML assemblies into a stripped environment, which measurably exceeds 30s
    // on a cold, contended host. Later inspections finish in well under a
    // second. This runs once per package during an install or update the user
    // is already waiting on, so bound it generously rather than failing a
    // healthy package as a timeout.
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  })
  const metadata = parseCodexDesktopPackageMetadata(stdout)
  if (!metadata) throw new Error('无法读取 Codex Desktop 安装包元数据')
  return metadata
}

export interface CodexSetupStatus {
  checkedAt: string
  runtime: {
    node: ToolStatus
    npm: ToolStatus
  }
  cli: ToolStatus
  desktop: DesktopAppStatus
}

export interface ConfigSavePayload {
  provider: ProviderId
  apiKey: string
  model: string
  mode: NativeConfigSaveMode
}

export interface AppConfigSummary {
  workspace: string
  providers: Record<ProviderId, NativeConfigSummary>
}

export interface CodexReadinessStatus {
  hasApiKey: boolean
  matchesRelay: boolean
}

export interface RendererMessageTarget {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export type CodexDesktopLaunchMode = 'open' | 'restart'

export interface UninstallVerifiedDarwinGrokInstallationOptions {
  homeDirectory: string
  installDirectory: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

export interface InspectVerifiedDarwinGrokPostInstallOptions {
  homeDirectory: string
  expectedVersion: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

/** Verifies and inspects only a private staged copy, then describes the bound canonical install. */
export async function inspectVerifiedDarwinGrokPostInstall(
  options: InspectVerifiedDarwinGrokPostInstallOptions,
): Promise<{ status: ToolStatus; installation: CliInstallation }> {
  const selection = resolveDarwinGrokCanonicalSelection(options.homeDirectory)
  return inspectDarwinGrokVerifiedSelection({
    homeDirectory: options.homeDirectory,
    selection,
    expectedVersion: options.expectedVersion,
    runCommand: options.runCommand,
    inspect: async (executablePath) => {
      const stats = await fs.promises.lstat(executablePath)
      if (
        !path.isAbsolute(executablePath)
        || executablePath === selection.executablePath
        || !stats.isFile()
        || stats.isSymbolicLink()
        || (stats.mode & 0o111) === 0
      ) {
        throw new Error('Grok postinstall inspection requires a private staged executable')
      }
      const installDirectory = fs.realpathSync(path.dirname(selection.canonicalLinkPath))
      return {
        status: {
          installed: true,
          version: options.expectedVersion,
          path: selection.executablePath,
          installDirectory,
        },
        installation: {
          commandPath: selection.canonicalLinkPath,
          installDirectory,
          packageRoot: null,
          npmPrefix: null,
          packageVersion: null,
          source: 'native',
        },
      }
    },
  })
}

/** Verifies the official link layout, then removes only the exact planned links. */
export async function uninstallVerifiedDarwinGrokInstallation(
  options: UninstallVerifiedDarwinGrokInstallationOptions,
) {
  const plan = await verifyDarwinGrokUninstallPlan({
    homeDirectory: options.homeDirectory,
    runCommand: options.runCommand,
  })
  if (!plan.expectedSymbolicLinks.grok || !plan.expectedSymbolicLinks.agent) {
    throw new Error('Grok automatic uninstall requires both grok and agent verified symbolic links; use the official manual uninstall instructions')
  }
  const result = await uninstallVerifiedNativeCliFiles({
    actualDirectory: options.installDirectory,
    expectedDirectory: plan.directory,
    expectedDirectoryIdentity: plan.directoryIdentity,
    fileNames: ['grok', 'agent'],
    label: 'Grok CLI',
    platform: 'darwin',
    expectedSymbolicLinks: plan.expectedSymbolicLinks,
    expectedSymbolicLinkIdentities: plan.expectedSymbolicLinkIdentities,
    expectedSymbolicLinkRootDirectory: plan.rootDirectory,
    expectedSymbolicLinkRootDirectoryIdentity: plan.rootDirectoryIdentity,
    expectedResolvedSymbolicLinkTargets: plan.expectedResolvedSymbolicLinkTargets,
    expectedOwnerUid: plan.expectedOwnerUid,
    removeDirectoryWhenEmpty: false,
  })
  const retainedProgramPaths = [...new Set([
    ...result.retainedQuarantineFiles,
    ...Object.values(plan.expectedResolvedSymbolicLinkTargets)
      .map((target) => target.path)
      .filter((filePath) => fs.existsSync(filePath)),
  ])]
  if (retainedProgramPaths.length > 0) {
    const displayedPaths = retainedProgramPaths.map((filePath) => (
      `~/.grok/${path.relative(plan.rootDirectory, filePath)}`
    ))
    throw new Error([
      'Grok CLI 命令入口已移除，但自动卸载未完整完成。',
      '为避免按路径删除时误删被替换的文件，以下程序路径仍保留，请人工确认后删除：',
      displayedPaths.join('；'),
    ].join(''))
  }
  return result
}

export function grokManualUninstallResult(
  previousVersion: string | null,
  error: unknown,
): Extract<ToolUninstallResult, { outcome: 'manual-required' }> {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500)
    || 'Grok CLI 自动卸载安全验证失败'
  return {
    outcome: 'manual-required',
    previousVersion,
    error: message,
    manualHelp: {
      reason: `自动卸载安全验证失败：${message}`,
      manualCommand: null,
    },
  }
}

export interface SystemService {
  readStoredConfig(): AppSettings
  writeStoredConfig(config: AppSettings): Promise<void>
  inspectCodexReadiness(previewOnboarding: boolean): CodexReadinessStatus
  getConfig(previewOnboarding: boolean): AppConfigSummary
  revealApiKey(provider: ProviderId, previewOnboarding: boolean): string
  saveConfig(
    payload: ConfigSavePayload,
    previewOnboarding: boolean,
  ): Promise<ReturnType<typeof saveProviderConfig>>
  scanSystem(forceRefresh?: boolean): Promise<SystemSnapshot>
  inspectCodexSetupStatus(): Promise<CodexSetupStatus>
  installNodeRuntime(target: RendererMessageTarget): Promise<NodeRuntimeInstallResult>
  installCli(provider: ProviderId, target: RendererMessageTarget): Promise<void>
  uninstallCli(provider: ProviderId): Promise<ToolUninstallResult>
  inspectCliUpdate(provider: ProviderId, forceRefresh?: boolean): Promise<CliStatus>
  installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult>
  uninstallCodexDesktop(): Promise<ToolUninstallResult>
  inspectCodexDesktopUpdate(forceRefresh?: boolean): Promise<DesktopAppStatus>
  launchProvider(provider: ProviderId, workspace: string): Promise<void>
  inspectCodexDesktop(): Promise<DesktopAppStatus>
  launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
  ): Promise<CodexDesktopLaunchResult>
  fetchAvailableModels(apiKey: string): Promise<string[]>
}

function firstOutputLine(stdout: string, stderr: string): string | null {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '') ?? null
}

export function parseLatestNpmVersion(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const candidate = typeof parsed === 'string'
      ? parsed
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).version
        : null
    return typeof candidate === 'string' && semanticVersionPattern.test(candidate.trim())
      ? candidate.trim()
      : null
  } catch {
    return semanticVersionPattern.test(trimmed) ? trimmed : null
  }
}

export function parseGrokLocalVersion(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    for (const key of ['version', 'stable_version']) {
      const value = record[key]
      if (typeof value === 'string' && semanticVersionPattern.test(value.trim())) {
        return value.trim()
      }
    }
  } catch {
    // Invalid or partially written metadata is ignored; the caller can use a
    // separately verified executable or report an unknown version.
  }
  return null
}

interface GrokLocalVersionOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  managedDirectory?: string | null
}

export async function readGrokLocalVersionForExecutable(
  executablePath: string,
  options: GrokLocalVersionOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    try {
      return resolveDarwinGrokCanonicalSelection(
        options.homeDirectory ?? os.homedir(),
        executablePath,
      ).version
    } catch {
      return null
    }
  }
  const executableDirectory = path.dirname(executablePath)
  const candidates = new Set<string>([
    // The managed installer writes metadata beside grok.exe. Keep this first so
    // an older xAI root-level version.json cannot override a completed update.
    path.join(executableDirectory, 'version.json'),
  ])
  if (path.basename(executableDirectory).toLowerCase() === 'bin') {
    candidates.add(path.join(path.dirname(executableDirectory), 'version.json'))
  }
  if (platform === 'win32') {
    const managedDirectory = options.managedDirectory === undefined
      ? managedNativeProviderRoot('grok')
      : options.managedDirectory
    if (managedDirectory) candidates.add(path.join(managedDirectory, 'version.json'))
  }
  candidates.add(path.join(options.homeDirectory ?? os.homedir(), '.grok', 'version.json'))

  for (const candidate of candidates) {
    try {
      const version = parseGrokLocalVersion(await readBoundedUtf8File(
        candidate,
        maximumGrokVersionMetadataBytes,
        'Grok version.json',
      ))
      if (version) return version
    } catch {
      // Continue through the bounded list of known metadata locations.
    }
  }
  return null
}

function normalizeRuntimeVersion(command: string, value: string | null): string | null {
  if (!value) return null
  const match = value.trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  if (!match) return null
  const version = match[0]
  const normalizedCommand = command.toLowerCase()
  if (normalizedCommand === 'node') return `v${version}`
  if (normalizedCommand === 'python' || normalizedCommand === 'python3' || normalizedCommand === 'py') {
    return `Python ${version}`
  }
  return version
}

async function readPackageManifestVersion(filePath: string, label: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readBoundedUtf8File(
      filePath,
      maximumRuntimeManifestBytes,
      label,
    )) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && semanticVersionPattern.test(version.trim())
      ? version.trim()
      : null
  } catch {
    return null
  }
}

async function readNpmPackageVersion(executable: string): Promise<string | null> {
  const executableDirectory = path.dirname(executable)
  const candidates = [
    path.join(executableDirectory, 'node_modules', 'npm', 'package.json'),
    path.join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'package.json'),
  ]
  for (const candidate of candidates) {
    const version = await readPackageManifestVersion(candidate, 'npm package.json')
    if (version) return version
  }
  return null
}

async function readWindowsExecutableProductVersion(
  executable: string,
  command: string,
): Promise<string | null> {
  if (process.platform !== 'win32' || path.extname(executable).toLowerCase() !== '.exe') return null
  try {
    const stats = await fs.promises.stat(executable)
    if (!stats.isFile()) return null
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$ErrorActionPreference = "Stop"',
      '$value = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:XINGMANG_VERSION_TARGET).ProductVersion',
      'if ($value) { [Console]::Out.Write([string]$value) }',
    ].join('; ')
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: {
        ...trustedCommandEnvironment(),
        XINGMANG_VERSION_TARGET: executable,
      },
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    })
    return normalizeRuntimeVersion(command, cleanCommandOutput(stdout))
  } catch {
    return null
  }
}

function isWindowsAppExecutionAlias(filePath: string | null): boolean {
  return process.platform === 'win32'
    && Boolean(filePath && /\\AppData\\Local\\Microsoft\\WindowsApps\\/i.test(filePath))
}

export type NetworkRegion = 'mainland-china' | 'outside-mainland-china' | 'unknown'

export interface NetworkLocationStatus {
  publicIp: string | null
  countryCode: string | null
  region: NetworkRegion
  checkedAt: string
  error: string | null
}

export function parseCloudflareNetworkLocation(
  input: string,
  checkedAt = new Date().toISOString(),
): NetworkLocationStatus {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > 32 * 1024) {
    return {
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt,
      error: '网络位置响应为空或超过安全上限',
    }
  }
  const fields = new Map<string, string>()
  for (const rawLine of input.split(/\r?\n/)) {
    const separator = rawLine.indexOf('=')
    if (separator <= 0) continue
    const key = rawLine.slice(0, separator).trim().toLowerCase()
    const value = rawLine.slice(separator + 1).trim()
    if (key && value && !fields.has(key)) fields.set(key, value)
  }
  const ipCandidate = fields.get('ip') ?? ''
  const publicIp = isIP(ipCandidate) ? ipCandidate : null
  const countryCandidate = (fields.get('loc') ?? '').toUpperCase()
  const countryCode = /^[A-Z]{2}$/.test(countryCandidate) ? countryCandidate : null
  const region: NetworkRegion = countryCode === 'CN'
    ? 'mainland-china'
    : countryCode ? 'outside-mainland-china' : 'unknown'
  return {
    publicIp,
    countryCode,
    region,
    checkedAt,
    error: publicIp || countryCode ? null : '网络位置响应缺少有效 IP 和国家代码',
  }
}

export function parseCloudflareNetworkRegion(input: string): NetworkRegion {
  return parseCloudflareNetworkLocation(input).region
}

export async function detectNetworkLocation(
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 2_500,
): Promise<NetworkLocationStatus> {
  const checkedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const response = await fetchImplementation(networkLocationUrl, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        publicIp: null,
        countryCode: null,
        region: 'unknown',
        checkedAt,
        error: `网络位置服务返回 HTTP ${response.status}`,
      }
    }
    const body = await readBoundedResponseText(response, 32 * 1024, '网络位置')
    return parseCloudflareNetworkLocation(body, checkedAt)
  } catch (error) {
    return {
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt,
      error: error instanceof Error && error.name === 'AbortError'
        ? '网络位置检测超时'
        : error instanceof Error && error.message.includes('安全上限')
          ? error.message
          : '无法连接网络位置服务',
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function detectNetworkRegion(
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 2_500,
): Promise<NetworkRegion> {
  return (await detectNetworkLocation(fetchImplementation, timeoutMs)).region
}

/**
 * An unknown region means the Cloudflare probe could not complete, and the
 * users whose network blocks that probe are overwhelmingly the ones who also
 * cannot reach registry.npmjs.org. Sending them to the official registry first
 * was exactly backwards.
 *
 * The costs are not symmetric. An overseas user wrongly routed to npmmirror
 * loses a few seconds to a CDN that still serves them; a mainland user wrongly
 * routed to the official registry cannot install at all. Both entries stay in
 * the list either way, so a wrong guess only changes which one is tried first.
 */
export function npmInstallRegistries(region: NetworkRegion): [string, string] {
  return region === 'outside-mainland-china'
    ? [npmOfficialRegistry, npmMirrorRegistry]
    : [npmMirrorRegistry, npmOfficialRegistry]
}

export function npmRegistryLabel(registry: string): string {
  return registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
}

/**
 * The dependency graph must be resolved against the official registry, and a
 * mirror cannot stand in for it. Measured on Windows, all four managed CLIs
 * resolve only 7-12 packages in 1-4s on a healthy connection, so a wait long
 * enough to notice means the connection to registry.npmjs.org is struggling,
 * not that there is a lot of work to do. Ten minutes is a ceiling for that
 * case rather than an expected duration; five was killing connections that
 * were slow but still making progress. npm prints nothing throughout, which
 * is why this step used to look like a hang.
 */
export const npmResolutionTimeoutMs = 10 * 60_000
export const npmDownloadTimeoutMs = 5 * 60_000
export const npmResolutionHeartbeatMs = 15_000

export function formatElapsedDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

export function npmResolutionStartMessage(registry: string): string {
  return registry === npmOfficialRegistry
    ? '正在从 npm 官方源解析完整依赖图并校验 SHA-512 完整性。这一步必须直连官方源，'
      + '镜像无法代替；网络受限时可能较慢，但不影响后续下载速度，请耐心等待'
    : `正在从${npmRegistryLabel(registry)}解析完整依赖图，准备与官方 SHA-512 对账`
}

export function npmResolutionHeartbeatMessage(registry: string, elapsedMs: number): string {
  return `仍在解析${npmRegistryLabel(registry)}的依赖图…（已用时 ${formatElapsedDuration(elapsedMs)}）`
}

export function npmPackageLatestUrl(registry: string, packageName: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/latest`
}

export function npmPackageVersionUrl(registry: string, packageName: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
}

export interface NpmPackageReleaseMetadata {
  name: string
  version: string
  integrity: string
}

export function parseNpmPackageReleaseMetadata(
  input: string,
  expectedPackageName: string,
): NpmPackageReleaseMetadata | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const dist = record.dist && typeof record.dist === 'object' && !Array.isArray(record.dist)
    ? record.dist as Record<string, unknown>
    : null
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity.trim() : ''
  if (name !== expectedPackageName || !semanticVersionPattern.test(version)) return null
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
  if (!match) return null
  try {
    if (Buffer.from(match[1], 'base64').length !== 64) return null
  } catch {
    return null
  }
  return { name, version, integrity }
}

export async function fetchNpmPackageReleaseMetadata(
  registry: string,
  packageName: string,
  version: string | 'latest',
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = npmLatestQueryTimeoutMs,
): Promise<NpmPackageReleaseMetadata> {
  const sourceLabel = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const endpoint = version === 'latest'
      ? npmPackageLatestUrl(registry, packageName)
      : npmPackageVersionUrl(registry, packageName, version)
    const response = await fetchImplementation(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${sourceLabel} HTTP ${response.status}`)
    const body = await readBoundedResponseText(
      response,
      maximumNpmRegistryResponseBytes,
      `${sourceLabel}包元数据`,
    )
    const release = parseNpmPackageReleaseMetadata(body, packageName)
    if (!release || (version !== 'latest' && release.version !== version)) {
      throw new Error(`${sourceLabel}返回的包名、版本或 SHA-512 完整性元数据无效`)
    }
    return release
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${sourceLabel}包元数据查询超时`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function assertNpmReleaseIntegrityMatches(
  trusted: NpmPackageReleaseMetadata,
  candidate: NpmPackageReleaseMetadata,
): void {
  if (
    candidate.name !== trusted.name
    || candidate.version !== trusted.version
    || candidate.integrity !== trusted.integrity
  ) {
    throw new Error('国内 npm 镜像的包名、版本或 SHA-512 完整性元数据与 npm 官方源不一致')
  }
}

/** Binds registry metadata to the exact direct package record npm resolved from the official registry. */
export function assertNpmReleaseMatchesOfficialLock(
  trustedRelease: NpmPackageReleaseMetadata,
  officialLock: string,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(officialLock) as unknown
  } catch {
    throw new Error('npm 官方 package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm 官方 package-lock.json 根结构无效')
  }
  const packages = (parsed as Record<string, unknown>).packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm 官方 package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  const rootDependencies = root && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, unknown>).dependencies
    : null
  const directVersion = rootDependencies && typeof rootDependencies === 'object' && !Array.isArray(rootDependencies)
    ? (rootDependencies as Record<string, unknown>)[trustedRelease.name]
    : null
  const directLocation = `node_modules/${trustedRelease.name}`
  const directEntry = packageEntries[directLocation]
  if (
    directVersion !== trustedRelease.version
    || !directEntry
    || typeof directEntry !== 'object'
    || Array.isArray(directEntry)
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖身份或版本与发布元数据不一致')
  }
  const record = directEntry as Record<string, unknown>
  if (
    record.version !== trustedRelease.version
    || record.integrity !== trustedRelease.integrity
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖版本或 SHA-512 与发布元数据不一致')
  }
}

function canonicalNpmPackageLock(
  input: string,
  packageName: string,
  version: string,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    throw new Error('npm package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm package-lock.json 根结构无效')
  }
  const lock = parsed as Record<string, unknown>
  const packages = lock.packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('npm package-lock.json 缺少根包')
  }
  const rootDependencies = (root as Record<string, unknown>).dependencies
  if (
    !rootDependencies
    || typeof rootDependencies !== 'object'
    || Array.isArray(rootDependencies)
    || (rootDependencies as Record<string, unknown>)[packageName] !== version
  ) {
    throw new Error('npm package-lock.json 没有锁定目标 CLI 的精确版本')
  }
  for (const [location, entry] of Object.entries(packageEntries)) {
    if (!location) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`npm package-lock.json 包记录无效：${location}`)
    }
    const record = entry as Record<string, unknown>
    const entryVersion = typeof record.version === 'string' ? record.version.trim() : ''
    const integrity = typeof record.integrity === 'string' ? record.integrity.trim() : ''
    const integrityMatch = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
    if (!semanticVersionPattern.test(entryVersion) || !integrityMatch) {
      throw new Error(`npm package-lock.json 包版本或 SHA-512 无效：${location}`)
    }
    if (Buffer.from(integrityMatch[1], 'base64').length !== 64) {
      throw new Error(`npm package-lock.json SHA-512 长度无效：${location}`)
    }
  }

  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'resolved')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return JSON.stringify(canonicalize(lock))
}

export function assertNpmPackageLocksEquivalent(
  officialLock: string,
  candidateLock: string,
  packageName: string,
  version: string,
): void {
  const official = canonicalNpmPackageLock(officialLock, packageName, version)
  const candidate = canonicalNpmPackageLock(candidateLock, packageName, version)
  if (candidate !== official) {
    throw new Error('npm 镜像的完整依赖图、版本或 SHA-512 与官方源不一致')
  }
}

export class ManagedNpmRollbackError extends Error {
  readonly preserveTransaction = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagedNpmRollbackError'
  }
}

export interface ManagedNpmReplaceOperations {
  rename(source: string, destination: string): Promise<void>
}

export async function replaceManagedNpmPrefixAtomically(
  activePrefix: string,
  stagedPrefix: string,
  transactionDirectory: string,
  verifyPromotedPrefix: () => Promise<void>,
  operations: ManagedNpmReplaceOperations = fs.promises,
): Promise<void> {
  const active = path.resolve(activePrefix)
  const staged = path.resolve(stagedPrefix)
  const transaction = path.resolve(transactionDirectory)
  const relativeStage = path.relative(transaction, staged)
  if (
    active === staged
    || path.parse(active).root.toLowerCase() !== path.parse(staged).root.toLowerCase()
    || relativeStage === ''
    || relativeStage === '..'
    || relativeStage.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeStage)
  ) {
    throw new Error('托管 npm 事务目录无效，未修改当前安装')
  }
  if (!fs.existsSync(active) || !fs.statSync(active).isDirectory()) {
    throw new Error('当前托管 npm 目录不存在，无法执行原子更新')
  }
  if (!fs.existsSync(staged) || !fs.statSync(staged).isDirectory()) {
    throw new Error('暂存 npm 目录不存在，无法执行原子更新')
  }

  const backup = path.join(transaction, 'previous-prefix')
  const rejected = path.join(transaction, 'rejected-prefix')
  await operations.rename(active, backup)
  let promoted = false
  try {
    await operations.rename(staged, active)
    promoted = true
    await verifyPromotedPrefix()
  } catch (error) {
    let rollbackError: unknown = null
    try {
      if (promoted && fs.existsSync(active)) await operations.rename(active, rejected)
      if (fs.existsSync(backup)) await operations.rename(backup, active)
    } catch (cause) {
      rollbackError = cause
    }
    if (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new ManagedNpmRollbackError(`托管 npm 更新失败，且旧版本回滚失败：${detail}`, { cause: error })
    }
    throw error
  }
}

export function modelAccessCacheKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

function safeRelayErrorMessage(value: string, apiKey: string): string {
  return redactCommandText(value, [apiKey])
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

export interface CliMaintenancePlan {
  kind: 'npm-install'
  executable: string
  argv: string[]
  windowsPackageManager: 'npm'
}

export type GrokInstallStrategy = 'windows-native' | 'darwin-official-npm' | 'external'

export function grokInstallStrategyFor(platform: NodeJS.Platform): GrokInstallStrategy {
  if (platform === 'win32') return 'windows-native'
  if (platform === 'darwin') return 'darwin-official-npm'
  return 'external'
}

export interface CliInstallReleaseOptions {
  fetchGrokStableVersion: () => Promise<{ version: string }>
  fetchNpmRelease: (
    registry: string,
    packageName: string,
    version: string | 'latest',
  ) => Promise<NpmPackageReleaseMetadata>
}

/** Selects the authoritative release before generating an npm dependency lock. */
export async function resolveCliInstallRelease(
  provider: ProviderId,
  grokStrategy: GrokInstallStrategy | null,
  options: CliInstallReleaseOptions = {
    fetchGrokStableVersion,
    fetchNpmRelease: fetchNpmPackageReleaseMetadata,
  },
): Promise<NpmPackageReleaseMetadata> {
  if (provider !== 'grok' || grokStrategy !== 'darwin-official-npm') {
    return options.fetchNpmRelease(npmOfficialRegistry, cliCatalog[provider].packageName, 'latest')
  }
  const stable = await options.fetchGrokStableVersion()
  const release = await options.fetchNpmRelease(
    npmOfficialRegistry,
    cliCatalog.grok.packageName,
    stable.version,
  )
  if (release.version !== stable.version) {
    throw new Error('Grok npm 发布版本与 xAI 官方稳定版本不一致')
  }
  return release
}

export function buildCliMaintenancePlan(
  provider: ProviderId,
  npmExecutable: string | null,
  npmPrefix: string | null = null,
  version = 'latest',
  verifiedLifecycleScripts = false,
  platform: NodeJS.Platform = process.platform,
): CliMaintenancePlan {
  if (provider === 'grok') {
    const strategy = grokInstallStrategyFor(platform)
    if (strategy === 'windows-native') {
      throw new Error('Grok CLI 必须使用 xAI 已签名二进制安装器')
    }
    if (strategy === 'external') {
      throw new Error('当前平台不支持 Grok CLI 一键安装')
    }
    if (!verifiedLifecycleScripts) {
      throw new Error('Grok CLI 生命周期脚本必须先通过完整性校验')
    }
  }
  if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
  if (platform === 'darwin' && provider !== 'grok' && !npmPrefix) {
    throw new Error('macOS 用户级 npm 前缀不能为空')
  }
  if (version !== 'latest' && !semanticVersionPattern.test(version)) {
    throw new Error('npm CLI 版本号格式无效')
  }
  if (provider === 'grok') {
    return {
      kind: 'npm-install',
      executable: npmExecutable,
      argv: ['ci', '--omit=dev'],
      windowsPackageManager: 'npm',
    }
  }
  return {
    kind: 'npm-install',
    executable: npmExecutable,
    argv: [
      'install',
      '--global',
      ...(npmPrefix ? [`--prefix=${npmPrefix}`] : []),
      ...(!verifiedLifecycleScripts ? ['--ignore-scripts'] : []),
      '--omit=dev',
      '--package-lock=false',
      `${cliCatalog[provider].packageName}@${version}`,
    ],
    windowsPackageManager: 'npm',
  }
}

export type CliUninstallPlan =
  | {
      kind: 'npm-uninstall'
      executable: string
      argv: string[]
      windowsPackageManager: 'npm'
      packageRoot: string
    }
  | { kind: 'grok-native' | 'claude-native' }

export function buildCliUninstallPlan(
  provider: ProviderId,
  installation: CliInstallation,
  npmExecutable: string | null,
): CliUninstallPlan {
  if (installation.source === 'npm' && installation.packageRoot) {
    if (!npmExecutable || !installation.npmPrefix) {
      throw new Error(`无法确定 ${cliCatalog[provider].name} 所属的 npm 和安装前缀`)
    }
    return {
      kind: 'npm-uninstall',
      executable: npmExecutable,
      argv: [
        'uninstall',
        '--global',
        `--prefix=${installation.npmPrefix}`,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        cliCatalog[provider].packageName,
      ],
      windowsPackageManager: 'npm',
      packageRoot: installation.packageRoot,
    }
  }
  if (provider === 'grok' && installation.source === 'native') return { kind: 'grok-native' }
  if (provider === 'claude' && installation.source === 'native') return { kind: 'claude-native' }
  throw new Error(`当前 ${cliCatalog[provider].name} 不是 npm 安装，无法确认安全卸载方式`)
}

function containsComparableVersion(value: string | null): boolean {
  return typeof value === 'string'
    && /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.test(value)
}

export function buildCliStatus(
  installed: ToolStatus,
  latest: LatestVersionProbe,
): CliStatus {
  const base = {
    ...installed,
    uninstall: installed.uninstall ?? {
      available: false,
      reason: installed.installed ? '未能确认当前安装是否可由本工具安全卸载' : null,
      manualCommand: null,
    },
    latestVersion: latest.version,
    updateAvailable: false,
    updateSource: latest.source,
    updateCheck: latest.status,
    updateState: 'unknown',
    updateCheckedAt: latest.checkedAt,
    updateError: latest.error,
  } satisfies CliStatus

  if (latest.status !== 'checked' || !latest.version) return base
  if (!installed.installed) return base
  if (!containsComparableVersion(installed.version)) {
    return {
      ...base,
      updateCheck: 'failed',
      updateError: '已安装 CLI 的版本号无法解析，不能判断是否有更新',
    }
  }
  if (isNewerVersion(installed.version, latest.version)) {
    return { ...base, updateAvailable: true, updateState: 'available', updateError: null }
  }
  if (isNewerVersion(latest.version, installed.version)) {
    const sourceName = latest.source === 'native' ? '原生更新源' : 'npm latest'
    return {
      ...base,
      updateCheck: 'failed',
      updateError: `已安装版本高于${sourceName}，可能来自其他分发通道，无法可靠比较`,
    }
  }
  return { ...base, updateAvailable: false, updateState: 'latest', updateError: null }
}

export function buildDesktopUpdateStatus(
  installedVersion: string | null,
  latest: DesktopLatestVersionProbe,
): VersionUpdateStatus {
  const base: VersionUpdateStatus = {
    latestVersion: latest.version,
    updateAvailable: null,
    updateSource: latest.source,
    updateCheck: latest.status,
    updateState: 'unknown',
    updateCheckedAt: latest.checkedAt,
    updateError: latest.error,
  }
  if (latest.status !== 'checked' || !latest.version) return base
  if (!installedVersion) {
    return { ...base, updateCheck: 'failed', updateError: '无法读取 Codex Desktop 已安装版本' }
  }
  const comparison = compareWindowsPackageVersions(installedVersion, latest.version)
  if (comparison === null) {
    return { ...base, updateCheck: 'failed', updateError: 'Codex Desktop 版本号格式无效' }
  }
  if (comparison < 0) {
    return { ...base, updateAvailable: true, updateState: 'available', updateError: null }
  }
  if (comparison === 0) {
    return { ...base, updateAvailable: false, updateState: 'latest', updateError: null }
  }
  return {
    ...base,
    updateCheck: 'failed',
    updateError: '已安装版本高于官方更新清单，无法确认当前发布通道状态',
  }
}

export function desktopMirrorUpdateAvailable(
  installedVersion: string | null,
  mirrorVersion: string | null,
): boolean | null {
  if (!mirrorVersion) return null
  if (!installedVersion) return true
  const comparison = compareWindowsPackageVersions(installedVersion, mirrorVersion)
  return comparison === null ? null : comparison < 0
}

function safeVersionCheckError(error: unknown, operation = 'npm latest'): string {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
  if (candidate?.name === 'AbortError') return `${operation} 查询超时`
  if (candidate?.code === 'TIMED_OUT') {
    return operation.startsWith('Grok')
      ? '连接 xAI 更新服务超时，请检查代理或网络后重试'
      : `${operation} 查询超时`
  }
  if (candidate?.code === 'SPAWN_FAILED') return `无法启动 ${operation} 查询`
  if (candidate?.code === 'EXIT_NON_ZERO') return `${operation} 查询失败`
  const message = typeof candidate?.message === 'string' ? candidate.message.trim() : ''
  return message.slice(0, 240) || `${operation} 查询失败`
}

function desktopUpdateFields(
  status: UpdateCheckStatus,
  error: string | null,
  source: UpdateSource,
): VersionUpdateStatus {
  return {
    latestVersion: null,
    updateAvailable: null,
    updateSource: source,
    updateCheck: status,
    updateState: 'unknown',
    updateCheckedAt: new Date().toISOString(),
    updateError: error,
  }
}

export interface SystemServiceOptions {
  /** Defaults to the restrictive mode so tests and non-main callers fail closed. */
  windowsExecutionMode?: WindowsCliExecutionMode
  platform?: NodeJS.Platform
  providerRoots?: ProviderConfigRoots
  codexEnv?: NodeJS.ProcessEnv
  inspectProviderConfig?: typeof inspectProviderConfig
  resolveCliCommand?: typeof resolveCliCommand
  resolveCliInstallation?: typeof resolveCliInstallation
  runCommand?: typeof runCommand
  macosCodexAppDetector?: typeof inspectMacosCodexApp
}

export function providerCommandEnvironment(
  provider: ProviderId,
  processEnv: NodeJS.ProcessEnv,
  codexEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return commandEnvironment(provider === 'codex' ? codexEnv : processEnv)
}

export function createSystemService(
  store: AppSettingsStore,
  serviceOptions: SystemServiceOptions = {},
): SystemService {
  const windowsExecutionMode = serviceOptions.windowsExecutionMode ?? 'trusted-only'
  const platform = serviceOptions.platform ?? process.platform
  const providerRoots = serviceOptions.providerRoots ?? defaultProviderConfigRoots()
  const codexEnv = serviceOptions.codexEnv
    ?? { ...process.env, CODEX_HOME: providerRoots.codexHome }
  const inspectNativeProviderConfig = (provider: ProviderId) =>
    (serviceOptions.inspectProviderConfig ?? inspectProviderConfig)(provider, providerRoots)
  const providerEnvironment = (provider: ProviderId): NodeJS.ProcessEnv =>
    providerCommandEnvironment(provider, process.env, codexEnv)
  const resolveVerifiedCliCommand = serviceOptions.resolveCliCommand ?? resolveCliCommand
  const resolveCliInstallationForService = serviceOptions.resolveCliInstallation ?? resolveCliInstallation
  const executeCommand = serviceOptions.runCommand ?? runCommand
  const detectMacosCodexApp = serviceOptions.macosCodexAppDetector ?? inspectMacosCodexApp
  const installing = new Set<ProviderId>()
  const installationQueue = new InstallationQueue()
  let nodeRuntimeInstalling = false
  let codexDesktopInstalling = false
  const npmLatestCache = new Map<string, { expiresAt: number; value: LatestVersionProbe }>()
  // 失效时递增，让失效前发起的在途查询放弃回写过期结果
  let npmLatestCacheGeneration = 0
  const grokLatestInFlight = new Map<string, Promise<LatestVersionProbe>>()
  let codexDesktopLatestCache: {
    expiresAt: number
    value: DesktopLatestVersionProbe
  } | null = null
  let codexDesktopMirrorCache: {
    expiresAt: number
    value: DesktopMirrorVersionProbe
  } | null = null
  const modelAccessCache = new Map<string, { expiresAt: number; models: string[] }>()
  let networkLocationCache: { expiresAt: number; value: NetworkLocationStatus } | null = null

  function createInstallTemporaryDirectory(
    label: string,
    options: { baseDirectory?: string } = {},
  ): Promise<string> {
    if (options.baseDirectory) {
      return createTrustedTemporaryDirectory(label, {
        platform,
        env: commandEnvironment(),
        baseDirectory: options.baseDirectory,
      })
    }
    if (process.platform === 'win32' && windowsExecutionMode === 'trusted-only') {
      return createTrustedTemporaryDirectory(label, options)
    }
    const safeLabel = label.replace(/[^a-z0-9-]/gi, '-')
    return fs.promises.mkdtemp(path.join(os.tmpdir(), `xingmang-${safeLabel}-`))
  }

  async function inspectNetworkLocation(): Promise<NetworkLocationStatus> {
    if (networkLocationCache && networkLocationCache.expiresAt > Date.now()) {
      return networkLocationCache.value
    }
    const value = await detectNetworkLocation()
    // A failed probe used to be retried every minute, costing another 2.5s
    // timeout each time on precisely the networks that are already slow. Now
    // that an unknown region routes to the mirror first — the safe default for
    // this product — there is nothing to regain by re-probing sooner. A manual
    // rescan still clears this cache outright via forceRefresh.
    networkLocationCache = { expiresAt: Date.now() + networkLocationCacheTtlMs, value }
    return value
  }

  async function inspectNetworkRegion(): Promise<NetworkRegion> {
    return (await inspectNetworkLocation()).region
  }

  /**
   * Tool discovery is deliberately not restricted to machine PATH entries.
   * npm global installs and the official Grok/Claude installers live under a
   * user's profile on Windows. Discovery is read-only; an explicitly elevated
   * process still blocks version execution from user-writable paths.
   */
  async function findInstalledExecutable(command: string): Promise<string | null> {
    return findExecutable(command, {
      env: commandEnvironment(),
      windowsPackageManagers: command.toLowerCase() === 'npm' ? ['npm'] : [],
    })
  }

  async function executeVersion(
    executable: string,
    args: string[],
    windowsPackageManager?: WindowsPackageManager,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): Promise<string | null> {
    try {
      const trustedOnly = platform === 'win32' && windowsExecutionMode === 'trusted-only'
      if (trustedOnly && !isTrustedHighIntegrityExecutable(executable)) return null
      const result = await executeCommand({ executable, argv: args, windowsPackageManager }, {
        env: trustedOnly ? trustedCommandEnvironment(baseEnv) : commandEnvironment(baseEnv),
        trustedOnly,
        timeoutMs: 8_000,
        maxOutputBytes: 1024 * 1024,
      })
      return firstOutputLine(result.stdout, result.stderr)
    } catch (error) {
      const candidate = error as { stdout?: string; stderr?: string }
      return firstOutputLine(candidate.stdout ?? '', candidate.stderr ?? '')
    }
  }

  async function inspectTool(command: string, args = ['--version']): Promise<ToolStatus> {
    const executable = await findInstalledExecutable(command)
    if (!executable) return { installed: false, version: null, path: null, installDirectory: null }
    let version = await executeVersion(
      executable,
      args,
      command.toLowerCase() === 'npm' ? 'npm' : undefined,
    )
    if (!version && command.toLowerCase() === 'npm') {
      version = await readNpmPackageVersion(executable)
    } else if (!version && !isWindowsAppExecutionAlias(executable)) {
      // Reading PE metadata through the trusted inbox PowerShell does not
      // execute a runtime found in a user-writable directory.
      version = await readWindowsExecutableProductVersion(executable, command)
    }
    return {
      installed: true,
      version,
      path: executable,
      installDirectory: path.dirname(executable),
    }
  }

  async function inspectNode(): Promise<ToolStatus> {
    const status = await inspectTool('node')
    if (!status.installed) return { ...status, tooOld: false, versionStatus: 'unknown' }
    const versionStatus = nodeVersionStatus(status.version)
    return { ...status, tooOld: versionStatus === 'too-old', versionStatus }
  }

  async function inspectCliTool(
    provider: ProviderId,
    npmExecutable?: string | null,
    npmGlobalRoot?: string | null,
    executablePath?: string | null,
  ): Promise<{ status: ToolStatus; installation: CliInstallation | null }> {
    const cliEnvironment = providerEnvironment(provider)
    const installation = await resolveCliInstallationForService(provider, {
      env: cliEnvironment,
      executablePath,
      npmExecutable,
      npmGlobalRoot,
      platform,
    })
    if (
      !installation
      || (provider === 'codex' && installation.source === 'native'
        && isCodexDesktopExecutable(installation.commandPath))
    ) {
      return {
        status: { installed: false, version: null, path: null, installDirectory: null },
        installation: null,
      }
    }
    const safeNativeCommand = installation.source === 'native' && provider !== 'grok'
      ? await resolveVerifiedCliCommand(provider, cliEnvironment, windowsExecutionMode, {
          darwinStagingRetention: 'ephemeral',
        }).catch(() => null)
      : null
    try {
      let version = installation.source === 'npm'
        ? installation.packageVersion ?? null
        : platform === 'darwin' && provider === 'codex' && safeNativeCommand?.verifiedDarwinStandalone
          ? safeNativeCommand.verifiedDarwinStandalone.version
          : safeNativeCommand
            ? await executeVersion(
                safeNativeCommand.executable,
                [...safeNativeCommand.argv, ...cliCatalog[provider].versionArgs],
                undefined,
                cliEnvironment,
              )
            : null
      if (provider === 'grok') {
        version = await readGrokLocalVersionForExecutable(installation.commandPath)
      }
      return { status: {
        installed: true,
        // Reading an npm package manifest avoids unnecessary CLI execution and
        // remains safe even when the app was manually started as administrator.
        version,
        path: installation.source === 'native'
          ? provider === 'grok'
            ? installation.commandPath
            : platform === 'darwin' && safeNativeCommand?.verifiedDarwinStandalone
              ? safeNativeCommand.verifiedDarwinStandalone.executablePath
              : safeNativeCommand?.executable ?? null
          : installation.commandPath,
        installDirectory: installation.installDirectory,
        uninstall: cliUninstallCapability(provider, installation, {
          managedNpmPrefix: (() => {
            try {
              return managedNpmPrefix()
            } catch {
              return null
            }
          })(),
          managedNativeDirectory: process.platform === 'win32' && provider === 'grok'
            ? managedNativeProviderRoot('grok')
            : null,
          homeDirectory: cliEnvironment.HOME?.trim() || os.homedir(),
          platform,
          verifiedDarwinStandalone: safeNativeCommand?.verifiedDarwinStandalone ?? null,
          windowsExecutionMode,
        }),
      }, installation }
    } finally {
      await safeNativeCommand?.release?.()
    }
  }

  async function inspectPython(): Promise<ToolStatus> {
    let fallback: ToolStatus | null = null
    for (const [command, args] of [
      ['python', ['--version']],
      ['python3', ['--version']],
      ['py', ['--version']],
    ] as const) {
      const result = await inspectTool(command, [...args])
      if (!result.installed) continue
      if (result.version) return result
      if (!isWindowsAppExecutionAlias(result.path)) fallback ??= result
    }
    return fallback ?? { installed: false, version: null, path: null, installDirectory: null }
  }

  async function findCodexDesktopStartApp(): Promise<StartAppEntry | null> {
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      "$apps = @(Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' } | Select-Object Name, AppID)",
      '$apps | ConvertTo-Json -Compress',
    ].join('\n')

    try {
      const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        env: trustedCommandEnvironment(),
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
      })
      return selectCodexDesktopApp(parseStartAppsJson(stdout))
    } catch {
      return null
    }
  }

  async function listCodexDesktopProcesses(): Promise<WindowsProcessEntry[]> {
    if (process.platform !== 'win32') return []

    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      "$items = @(Get-CimInstance Win32_Process | Where-Object { ([string]$_.ExecutablePath) -like '*\\WindowsApps\\OpenAI.Codex_*' -or ([string]$_.ExecutablePath) -like '*\\WindowsApps\\OpenAI.CodexBeta_*' } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)",
      '$items | ConvertTo-Json -Compress',
    ].join('; ')

    try {
      const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        env: trustedCommandEnvironment(),
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
      })
      return parseWindowsProcessesJson(stdout)
    } catch {
      return []
    }
  }

  async function inspectCodexDesktopPackage(): Promise<{
    value: CodexDesktopPackageEntry | null
    error: string | null
  }> {
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      // The packaged app is registered per user. The manager itself runs
      // elevated, so the current-user query can be empty even though the
      // Store package is installed for another Windows account. Prefer the
      // current user, then fall back to the read-only all-users view.
      "$packages = @(Get-AppxPackage -Name 'OpenAI.Codex*' | Select-Object Name, Version, PackageFullName, PackageFamilyName, InstallLocation)",
      "if ($packages.Count -eq 0) { $packages = @(Get-AppxPackage -AllUsers -Name 'OpenAI.Codex*' | Select-Object Name, Version, PackageFullName, PackageFamilyName, InstallLocation) }",
      '$packages | ConvertTo-Json -Compress',
    ].join('; ')

    try {
      const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        env: trustedCommandEnvironment(),
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
      })
      return {
        value: selectCodexDesktopPackage(parseCodexDesktopPackagesJson(stdout)),
        error: null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.trim().slice(0, 240) : ''
      return { value: null, error: message || '无法读取 Windows Appx 包信息' }
    }
  }

  async function inspectCodexDesktopAppVersion(
    installedPackage: CodexDesktopPackageEntry,
  ): Promise<string | null> {
    const manifestPath = path.join(
      installedPackage.installLocation,
      'app',
      'resources',
      'app.asar',
      'package.json',
    )
    try {
      // The manifest lives inside app.asar, and Electron's archive layer serves
      // those paths with synthetic stat data - a fresh inode on every call and
      // no timestamps. readBoundedUtf8File's link and TOCTOU guards can never
      // hold there, so they are replaced by the guarantees that do apply: the
      // archive sits under the system-protected WindowsApps directory, and
      // archive members cannot be redirected by a symlink.
      const stats = await fs.promises.stat(manifestPath)
      if (!stats.isFile() || stats.size > maximumCodexDesktopAppManifestBytes) return null
      const manifest = await fs.promises.readFile(manifestPath, 'utf8')
      return parseCodexDesktopAppManifest(manifest)
    } catch {
      return null
    }
  }

  async function inspectCodexDesktopLatestVersion(): Promise<DesktopLatestVersionProbe> {
    if (codexDesktopLatestCache && codexDesktopLatestCache.expiresAt > Date.now()) {
      return codexDesktopLatestCache.value
    }

    const checkedAt = new Date().toISOString()
    const errors: string[] = []
    let value: DesktopLatestVersionProbe | null = null
    for (const source of buildCodexDesktopManifestSources()) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8_000)
      try {
        const response = await fetchTrustedCodexDesktopResource(source.url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }, fetch)
        if (!response.ok) throw new Error(`返回 HTTP ${response.status}`)
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        if (!contentType.includes('application/json')) throw new Error('返回的不是 JSON 响应')
        const declaredLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
          throw new Error('更新清单响应过大')
        }
        if (!response.body) throw new Error('更新清单没有响应正文')
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let received = 0
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (!chunk.value?.byteLength) continue
          received += chunk.value.byteLength
          if (received > 256 * 1024) throw new Error('更新清单响应过大')
          chunks.push(chunk.value)
        }
        const manifestText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
        const version = source.kind === 'official'
          ? parseCodexDesktopUpdateManifest(manifestText)?.buildVersion ?? null
          : process.arch === 'x64' || process.arch === 'arm64'
            ? parseCodexDesktopMirrorManifest(manifestText, process.arch)?.version ?? null
            : null
        if (!version) throw new Error('schema、产品 ID、包身份或架构校验失败')
        value = {
          status: 'checked',
          version,
          source: 'official-manifest',
          checkedAt,
          error: null,
        }
        break
      } catch (error) {
        const message = error instanceof Error && error.name === 'AbortError'
          ? '查询超时'
          : (error instanceof Error ? error.message.trim().slice(0, 240) : '')
        errors.push(`${source.label}：${message || '查询失败'}`)
      } finally {
        clearTimeout(timeout)
      }
    }
    value ??= {
      status: 'failed',
      version: null,
      source: 'official-manifest',
      checkedAt,
      error: errors.join('；') || 'Codex Desktop 版本查询失败',
    }
    const ttl = value.status === 'checked'
      ? codexDesktopLatestCacheTtlMs
      : codexDesktopLatestFailureCacheTtlMs
    codexDesktopLatestCache = { expiresAt: Date.now() + ttl, value }
    return value
  }

  async function inspectCodexDesktopMirrorVersion(): Promise<DesktopMirrorVersionProbe> {
    if (codexDesktopMirrorCache && codexDesktopMirrorCache.expiresAt > Date.now()) {
      return codexDesktopMirrorCache.value
    }
    const checkedAt = new Date().toISOString()
    let value: DesktopMirrorVersionProbe
    if (process.arch !== 'x64' && process.arch !== 'arm64') {
      value = { version: null, checkedAt, error: `国内镜像不支持当前处理器架构 ${process.arch}` }
    } else {
      try {
        const release = await fetchCodexDesktopMirrorRelease(process.arch)
        value = { version: release.version, checkedAt, error: null }
      } catch (error) {
        value = {
          version: null,
          checkedAt,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    codexDesktopMirrorCache = {
      expiresAt: Date.now() + (value.version
        ? codexDesktopLatestCacheTtlMs
        : codexDesktopLatestFailureCacheTtlMs),
      value,
    }
    return value
  }

  async function inspectCodexDesktop(): Promise<DesktopAppStatus> {
    if (platform === 'darwin') {
      let app: MacosCodexAppInfo | null = null
      try {
        app = await detectMacosCodexApp()
      } catch {
        // A local application inspection failure must not block the system scan.
      }
      return {
        installed: app !== null,
        version: app?.version ?? null,
        appVersion: app?.version ?? null,
        mirrorVersion: null,
        mirrorUpdateAvailable: null,
        mirrorError: null,
        path: app?.path ?? null,
        installDirectory: app?.path ?? null,
        running: app?.running ?? false,
        ...desktopUpdateFields('skipped', null, null),
      }
    }
    if (platform !== 'win32') {
      return {
        installed: false,
        version: null,
        appVersion: null,
        mirrorVersion: null,
        mirrorUpdateAvailable: null,
        mirrorError: null,
        path: null,
        installDirectory: null,
        running: false,
        ...desktopUpdateFields(
          'skipped',
          'Codex Desktop 版本检测仅支持 Windows',
          null,
        ),
      }
    }
    const [match, processes, packageProbe, mirrorProbe] = await Promise.all([
      findCodexDesktopStartApp(),
      listCodexDesktopProcesses(),
      inspectCodexDesktopPackage(),
      inspectCodexDesktopMirrorVersion(),
    ])
    const processPackage = processes
      .map((entry) => parseCodexDesktopPackagePath(entry.executablePath))
      .find((entry): entry is CodexDesktopPackageEntry => entry !== null) ?? null
    // A running packaged app is conclusive evidence even when AppX
    // enumeration is scoped to another user. Prefer registered metadata, but
    // recover the same identity from WindowsApps' immutable path as fallback.
    const installedPackage = packageProbe.value ?? processPackage
    if (!match && !installedPackage) {
      return {
        installed: false,
        version: null,
        appVersion: null,
        mirrorVersion: mirrorProbe.version,
        mirrorUpdateAvailable: desktopMirrorUpdateAvailable(null, mirrorProbe.version),
        mirrorError: mirrorProbe.error,
        path: null,
        installDirectory: null,
        running: processes.length > 0,
        ...desktopUpdateFields(
          packageProbe.error && !processPackage ? 'failed' : 'skipped',
          packageProbe.error && !processPackage ? packageProbe.error : null,
          packageProbe.error ? 'windows-appx' : null,
        ),
      }
    }
    const appId = match?.appId
      ?? (installedPackage ? `${installedPackage.packageFamilyName}!App` : null)
    const appVersion = installedPackage
      ? await inspectCodexDesktopAppVersion(installedPackage)
      : null
    const update = installedPackage
      ? buildDesktopUpdateStatus(
          installedPackage.version,
          await inspectCodexDesktopLatestVersion(),
        )
      : desktopUpdateFields(
          'failed',
      packageProbe.error && !processPackage
        ? packageProbe.error
        : '检测到开始菜单入口，但无法读取 Codex Desktop 的 Appx 已安装版本',
          'windows-appx',
        )
    return {
      installed: true,
      version: installedPackage?.version ?? null,
      appVersion,
      mirrorVersion: mirrorProbe.version,
      mirrorUpdateAvailable: desktopMirrorUpdateAvailable(
        installedPackage?.version ?? null,
        mirrorProbe.version,
      ),
      mirrorError: mirrorProbe.error,
      path: appId,
      installDirectory: installedPackage?.installLocation || null,
      running: processes.length > 0,
      ...update,
    }
  }

  async function inspectLatestNpmVersion(
    packageName: string,
    networkRegion: NetworkRegion,
  ): Promise<LatestVersionProbe> {
    const cacheKey = `npm:${networkRegion}:${packageName}`
    const cached = npmLatestCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const generation = npmLatestCacheGeneration
    const checkedAt = new Date().toISOString()
    const query = async (registry: string): Promise<LatestVersionProbe> => {
      const sourceLabel = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), npmLatestQueryTimeoutMs)
      try {
        const response = await fetch(npmPackageLatestUrl(registry, packageName), {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`${sourceLabel} HTTP ${response.status}`)
        const body = await readBoundedResponseText(
          response,
          maximumNpmRegistryResponseBytes,
          sourceLabel,
        )
        const version = parseLatestNpmVersion(body)
        return version
          ? { status: 'checked', version, source: 'npm', checkedAt, error: null }
          : {
              status: 'failed',
              version: null,
              source: 'npm',
              checkedAt,
              error: `${sourceLabel} 返回了无法解析的版本号`,
            }
      } catch (error) {
        return {
          status: 'failed',
          version: null,
          source: 'npm',
          checkedAt,
          error: safeVersionCheckError(error, sourceLabel),
        }
      } finally {
        clearTimeout(timeout)
      }
    }
    const errors: string[] = []
    let value: LatestVersionProbe | null = null
    for (const registry of npmInstallRegistries(networkRegion)) {
      const result = await query(registry)
      if (result.status === 'checked') {
        value = result
        break
      }
      if (result.error) errors.push(result.error)
    }
    value ??= {
      status: 'failed',
      version: null,
      source: 'npm',
      checkedAt,
      error: errors.join('；') || 'npm 版本查询失败',
    }
    if (generation === npmLatestCacheGeneration) {
      const ttl = value.status === 'checked' ? npmLatestCacheTtlMs : npmLatestFailureCacheTtlMs
      npmLatestCache.set(cacheKey, { expiresAt: Date.now() + ttl, value })
    }
    return value
  }

  async function inspectLatestGrokVersion(): Promise<LatestVersionProbe> {
    const cacheKey = 'official:grok:stable'
    const cached = npmLatestCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existingProbe = grokLatestInFlight.get(cacheKey)
    if (existingProbe) return existingProbe

    const probe = (async (): Promise<LatestVersionProbe> => {
      const checkedAt = new Date().toISOString()
      try {
        const result = await fetchGrokStableVersion()
        return {
          status: 'checked',
          version: result.version,
          source: 'official-manifest',
          checkedAt,
          error: null,
        }
      } catch (error) {
        return {
          status: 'failed',
          version: null,
          source: 'official-manifest',
          checkedAt,
          error: safeVersionCheckError(error, 'Grok 官方版本'),
        }
      }
    })().then((value) => {
      // invalidate 会清空 in-flight 表，比对可拦住失效前发起的过期回写
      if (grokLatestInFlight.get(cacheKey) === probe) {
        npmLatestCache.set(cacheKey, {
          expiresAt: Date.now() + (value.status === 'checked'
            ? npmLatestCacheTtlMs
            : npmLatestFailureCacheTtlMs),
          value,
        })
      }
      return value
    })
    grokLatestInFlight.set(cacheKey, probe)
    try {
      return await probe
    } finally {
      if (grokLatestInFlight.get(cacheKey) === probe) grokLatestInFlight.delete(cacheKey)
    }
  }

  function invalidateCliUpdateCache(provider: ProviderId): void {
    npmLatestCacheGeneration += 1
    if (provider === 'grok') {
      for (const key of npmLatestCache.keys()) {
        if (key.startsWith('official:grok:')) npmLatestCache.delete(key)
      }
      grokLatestInFlight.clear()
      return
    }
    const packageSuffix = `:${cliCatalog[provider].packageName}`
    for (const key of npmLatestCache.keys()) {
      if (key.endsWith(packageSuffix) || key === cliCatalog[provider].packageName) {
        npmLatestCache.delete(key)
      }
    }
  }

  async function inspectCliLatestVersion(
    provider: ProviderId,
    installed: ToolStatus,
    networkRegion: NetworkRegion,
  ): Promise<LatestVersionProbe> {
    if (!installed.installed) {
      return {
        status: 'skipped',
        version: null,
        source: provider === 'grok' ? 'official-manifest' : 'npm',
        checkedAt: new Date().toISOString(),
        error: null,
      }
    }
    if (provider === 'grok') {
      return inspectLatestGrokVersion()
    }
    return inspectLatestNpmVersion(cliCatalog[provider].packageName, networkRegion)
  }

  async function inspectCliUpdate(
    provider: ProviderId,
    forceRefresh = false,
  ): Promise<CliStatus> {
    if (forceRefresh) invalidateCliUpdateCache(provider)
    const npm = await inspectTool('npm')
    const npmGlobalRoot = await resolveNpmGlobalRoot(npm.path, commandEnvironment())
    const { status } = await inspectCliTool(provider, npm.path, npmGlobalRoot)
    const networkRegion = provider !== 'grok' && status.installed
      ? await inspectNetworkRegion()
      : 'unknown'
    const latest = await inspectCliLatestVersion(provider, status, networkRegion)
    return buildCliStatus(status, latest)
  }

  async function scanSystem(forceRefresh = false): Promise<SystemSnapshot> {
    if (forceRefresh) {
      npmLatestCacheGeneration += 1
      npmLatestCache.clear()
      grokLatestInFlight.clear()
      codexDesktopLatestCache = null
      codexDesktopMirrorCache = null
      networkLocationCache = null
    }
    const [node, npm, python, codexDesktop, network] = await Promise.all([
      inspectNode(),
      inspectTool('npm'),
      inspectPython(),
      inspectCodexDesktop(),
      inspectNetworkLocation(),
    ])
    const npmGlobalRoot = await resolveNpmGlobalRoot(npm.path, commandEnvironment())
    // 单个 CLI 探测异常时降级为未安装，避免拖垮整份系统快照
    const cliProbes = await Promise.allSettled(
      providerIds.map((id) => inspectCliTool(id, npm.path, npmGlobalRoot)),
    )
    const cliResults: ToolStatus[] = cliProbes.map((probe) => (probe.status === 'fulfilled'
      ? probe.value.status
      : { installed: false, version: null, path: null, installDirectory: null }))
    const networkRegion = network.region

    const latestProbes = await Promise.allSettled(
      providerIds.map((id, index) => inspectCliLatestVersion(
        id,
        cliResults[index],
        networkRegion,
      )),
    )
    const latestVersions: LatestVersionProbe[] = latestProbes.map((probe, index) => (
      probe.status === 'fulfilled'
        ? probe.value
        : {
            status: 'failed',
            version: null,
            source: providerIds[index] === 'grok' ? 'official-manifest' : 'npm',
            checkedAt: new Date().toISOString(),
            error: probe.reason instanceof Error ? probe.reason.message : String(probe.reason),
          }
    ))
    const clis = Object.fromEntries(providerIds.map((id, index) => {
      const status = cliResults[index]
      return [id, buildCliStatus(status, latestVersions[index])]
    })) as Record<ProviderId, CliStatus>

    return {
      checkedAt: new Date().toISOString(),
      network,
      runtime: { node, npm, python },
      clis,
      desktopApps: { codex: codexDesktop },
    }
  }

  async function inspectCodexSetupStatus(): Promise<CodexSetupStatus> {
    const [node, npm, desktop] = await Promise.all([
      inspectNode(),
      inspectTool('npm'),
      inspectCodexDesktop(),
    ])
    const npmGlobalRoot = await resolveNpmGlobalRoot(npm.path, commandEnvironment())
    const { status: cli } = await inspectCliTool('codex', npm.path, npmGlobalRoot)
    return { checkedAt: new Date().toISOString(), runtime: { node, npm }, cli, desktop }
  }

  async function installNodeRuntimeOperation(target: RendererMessageTarget): Promise<NodeRuntimeInstallResult> {
    if (nodeRuntimeInstalling) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstalling = true
    try {
      return await installNodeRuntimeLts({
        networkRegion: await inspectNetworkRegion(),
        temporaryDirectoryMode: windowsExecutionMode,
        onProgress: (progress) => {
          if (!target.isDestroyed()) target.send('runtime:node-install-progress', progress)
        },
      })
    } finally {
      nodeRuntimeInstalling = false
    }
  }

  function installNodeRuntime(target: RendererMessageTarget): Promise<NodeRuntimeInstallResult> {
    return installationQueue.enqueue('runtime:node', () => installNodeRuntimeOperation(target))
  }

  function sendInstallProgress(
    target: RendererMessageTarget,
    provider: ProviderId,
    state: 'started' | 'output' | 'success' | 'error',
    message: string,
  ): void {
    if (!target.isDestroyed()) target.send('cli:install-progress', { provider, state, message })
  }

  async function findNpmForCliInstall(
    provider: ProviderId,
    target: RendererMessageTarget,
  ): Promise<string | null> {
    if (process.platform !== 'win32') {
      return findExecutable('npm', {
        env: commandEnvironment(),
        windowsPackageManagers: ['npm'],
      })
    }

    const trustedOnly = windowsExecutionMode === 'trusted-only'
    const findUsableNpm = () => findExecutable('npm', {
      env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
      windowsPackageManagers: ['npm'],
      trustedOnly,
    })
    let npmExecutable = await findUsableNpm()
    if (npmExecutable) return npmExecutable

    sendInstallProgress(
      target,
      provider,
      'output',
      `未检测到${trustedOnly ? '系统级' : '可用的'} Node.js/npm，正在自动安装 Node.js LTS`,
    )
    if (nodeRuntimeInstalling) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstalling = true
    try {
      await installNodeRuntimeLts({
        networkRegion: await inspectNetworkRegion(),
        temporaryDirectoryMode: windowsExecutionMode,
        onProgress: (progress) => {
          if (progress.message) sendInstallProgress(target, provider, 'output', progress.message)
        },
      })
    } finally {
      nodeRuntimeInstalling = false
    }
    npmExecutable = await findUsableNpm()
    if (!npmExecutable) {
      throw new Error('Node.js 安装完成后仍未检测到可用的 npm，请重启本程序后再试')
    }
    return npmExecutable
  }

  async function installCliOperation(provider: ProviderId, target: RendererMessageTarget): Promise<void> {
    const grokInstallStrategy = provider === 'grok' ? grokInstallStrategyFor(platform) : null
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装中`)
    installing.add(provider)
    const definition = cliCatalog[provider]
    let downloadedGrokBinary: DownloadedGrokBinary | null = null
    let managedNpmLayout: ManagedNpmLayout | null = null
    let managedNpmTransaction: string | null = null
    let preserveManagedNpmTransaction = false
    try {
      if (provider === 'grok') {
        if (grokInstallStrategy === 'external') {
          throw new Error('当前平台不支持 Grok CLI 一键安装')
        }
        if (grokInstallStrategy === 'windows-native') {
          const sameUserInstall = windowsExecutionMode === 'same-user'
          const installedBefore = await findInstalledExecutable(definition.command)
          sendInstallProgress(
            target,
            provider,
            'started',
            `正在从 xAI 官方下载并验证已签名的 Grok CLI ${installedBefore ? '更新' : '安装'}包`,
          )
          let lastReportedBucket = -1
          downloadedGrokBinary = await downloadLatestGrokBinary({
            createTemporaryDirectory: () => createInstallTemporaryDirectory('grok-binary'),
            onProgress: ({ percent, transferred, total }) => {
              const bucket = Math.floor(percent / 5)
              if (bucket === lastReportedBucket && percent !== 100) return
              lastReportedBucket = bucket
              sendInstallProgress(
                target,
                provider,
                'output',
                `Grok CLI 下载 ${percent}%（${Math.floor(transferred / 1024 / 1024)} / ${Math.floor(total / 1024 / 1024)} MiB）`,
              )
            },
          })
          sendInstallProgress(
            target,
            provider,
            'output',
            `xAI 签名与文件校验通过（${downloadedGrokBinary.version}，SHA-256 ${downloadedGrokBinary.sha256Hex.slice(0, 16)}…）`,
          )
          const installed = await installDownloadedGrokBinary(downloadedGrokBinary, sameUserInstall
            ? {
                managedRoot: path.join(os.homedir(), '.grok', 'bin'),
                protectInstallDirectory: false,
              }
            : {})
          invalidateCliUpdateCache(provider)
          const verification = await inspectCliTool(provider, null, null, installed.executablePath)
          if (
            !verification.installation
            || !verification.status.version
            || verification.status.version !== installed.version
            || path.resolve(verification.installation.commandPath) !== path.resolve(installed.executablePath)
          ) {
            throw new Error('Grok CLI 安装后验证失败：未识别到托管可执行文件或版本不一致')
          }
          sendInstallProgress(
            target,
            provider,
            'success',
            `${definition.name} ${installedBefore ? '更新' : '安装'}完成（${installed.version}）`,
          )
          return
        }
      }

      const npmExecutable = await findNpmForCliInstall(provider, target)
      let installPrefix: string | null = null
      if (process.platform === 'win32' && windowsExecutionMode === 'trusted-only') {
        managedNpmLayout = await ensureManagedNpmLayout()
      } else if (platform === 'darwin' && provider !== 'grok') {
        managedNpmLayout = await ensureManagedNpmLayout({
          platform: 'darwin',
          env: commandEnvironment(),
        })
      }
      managedNpmTransaction = await createInstallTemporaryDirectory('npm-transaction', {
        ...(managedNpmLayout ? { baseDirectory: managedNpmLayout.cacheRoot } : {}),
      })
      sendInstallProgress(target, provider, 'output', '正在从 npm 官方源校验最新版本和 SHA-512 完整性元数据')
      const trustedRelease = await resolveCliInstallRelease(provider, grokInstallStrategy)
      if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
      const networkRegion = await inspectNetworkRegion()
      // Derived from the routing rather than restated, so the line can never
      // claim one registry while npmInstallRegistries picks the other. That had
      // already happened once: the unknown branch still advertised the official
      // registry after the ordering moved to mirror-first.
      const [primaryRegistry] = npmInstallRegistries(networkRegion)
      const primaryLabel = primaryRegistry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
      const regionLabel = networkRegion === 'mainland-china'
        ? '检测到中国大陆网络'
        : networkRegion === 'outside-mainland-china'
          ? '检测到非中国大陆网络'
          : '未能识别网络区域，按国内网络处理'
      const action = `${regionLabel}，正在通过${primaryLabel}安装已校验版本 ${definition.packageName}@${trustedRelease.version}`
      sendInstallProgress(target, provider, 'started', action)
      const transaction = managedNpmTransaction
      const npmUserConfig = managedNpmLayout?.userConfig ?? path.join(transaction, 'npmrc')
      if (!managedNpmLayout) {
        const handle = await fs.promises.open(npmUserConfig, 'wx', 0o600)
        await handle.close()
      }
      /**
       * The dependency-graph resolution and the package download are timed
       * separately. Sharing one budget meant a slow official resolution ate the
       * time the download still needed, and a legitimately slow resolution was
       * being killed at five minutes as if it had hung.
       */
      const executeNpm = async (
        argv: string[],
        cwd: string,
        cache: string,
        timeoutMs = npmDownloadTimeoutMs,
      ) => {
        // 提权执行会对 argv 里的每个绝对路径做 realpath，路径不存在即判定为
        // 「位于用户可写目录」而拒绝。npm 自己会建缓存目录，但那发生在校验之后。
        await fs.promises.mkdir(cache, { recursive: true })
        const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
        return executeCommand({
          executable: npmExecutable,
          argv: [
            ...argv,
            `--cache=${cache}`,
            `--userconfig=${npmUserConfig}`,
            '--audit=false',
            '--fund=false',
          ],
          windowsPackageManager: 'npm',
        }, {
          env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
          trustedOnly,
          trustedPaths: managedNpmLayout
            ? [npmUserConfig, transaction]
            : undefined,
          cwd,
          timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          onOutput: ({ text }) => {
            const message = text.trim()
            if (message) sendInstallProgress(target, provider, 'output', message)
          },
        })
      }
      const createResolutionManifest = async (directory: string) => {
        await fs.promises.mkdir(directory, { recursive: true })
        const manifestPath = path.join(directory, 'package.json')
        const handle = await fs.promises.open(manifestPath, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({
            name: 'xingmang-cli-resolution',
            version: '1.0.0',
            private: true,
            dependencies: { [definition.packageName]: trustedRelease.version },
          }, null, 2)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      /**
       * npm emits nothing during `--package-lock-only`, so without a heartbeat
       * the window sits on one static line for minutes and users conclude the
       * app has hung. The ticker only reports elapsed time; it never guesses at
       * a completion percentage it cannot know.
       */
      const resolveDependencyGraph = async (
        registry: string,
        resolution: string,
        cache: string,
      ) => {
        sendInstallProgress(target, provider, 'output', npmResolutionStartMessage(registry))
        const startedAt = Date.now()
        const ticker = setInterval(() => {
          sendInstallProgress(
            target,
            provider,
            'output',
            npmResolutionHeartbeatMessage(registry, Date.now() - startedAt),
          )
        }, npmResolutionHeartbeatMs)
        try {
          await executeNpm([
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--omit=dev',
            `--registry=${registry}`,
          ], resolution, cache, npmResolutionTimeoutMs)
        } finally {
          clearInterval(ticker)
        }
      }

      const officialResolution = path.join(transaction, 'official-resolution')
      const officialCache = path.join(transaction, 'official-cache')
      await createResolutionManifest(officialResolution)
      await resolveDependencyGraph(npmOfficialRegistry, officialResolution, officialCache)
      const officialLock = await readBoundedUtf8File(
        path.join(officialResolution, 'package-lock.json'),
        maximumNpmPackageLockBytes,
        'npm 官方 package-lock.json',
      )
      assertNpmReleaseMatchesOfficialLock(trustedRelease, officialLock)
      const registries = npmInstallRegistries(networkRegion)
      const installErrors: string[] = []
      let installed = false
      let verification: Awaited<ReturnType<typeof inspectCliTool>> | null = null
      for (const [index, registry] of registries.entries()) {
        if (index > 0) {
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registries[0] === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}安装失败，正在切换${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'} ${registry}`,
          )
        }
        try {
          const attemptRoot = path.join(transaction, `attempt-${index}`)
          const resolution = path.join(attemptRoot, 'resolution')
          const cache = path.join(attemptRoot, 'cache')
          const attemptPrefix = managedNpmLayout
            ? path.join(attemptRoot, 'staged-prefix')
            : null
          await createResolutionManifest(resolution)
          await resolveDependencyGraph(registry, resolution, cache)
          const candidateLock = await readBoundedUtf8File(
            path.join(resolution, 'package-lock.json'),
            maximumNpmPackageLockBytes,
            `${registry === npmMirrorRegistry ? '国内镜像' : 'npm 官方'} package-lock.json`,
          )
          assertNpmPackageLocksEquivalent(
            officialLock,
            candidateLock,
            definition.packageName,
            trustedRelease.version,
          )
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}完整依赖图与官方 SHA-512 对账通过，正在下载校验包缓存`,
          )
          await executeNpm([
            'ci',
            '--ignore-scripts',
            '--omit=dev',
            `--registry=${registry}`,
            '--replace-registry-host=always',
          ], resolution, cache)
          if (managedNpmLayout && attemptPrefix) {
            await fs.promises.cp(managedNpmLayout.prefix, attemptPrefix, {
              recursive: true,
              force: false,
              errorOnExist: true,
            })
          }
          const plan = buildCliMaintenancePlan(
            provider,
            npmExecutable,
            attemptPrefix,
            trustedRelease.version,
            true,
            platform,
          )
          const lifecycle = () => executeNpm([
            ...plan.argv,
            '--offline',
            `--registry=${registry}`,
          ], resolution, cache).then(() => undefined)
          if (provider === 'grok' && grokInstallStrategy === 'darwin-official-npm') {
            verification = await runDarwinGrokPostInstallTransaction({
              homeDirectory: os.homedir(),
              lifecycle,
              verify: async () => {
                const inspected = await inspectVerifiedDarwinGrokPostInstall({
                  homeDirectory: os.homedir(),
                  expectedVersion: trustedRelease.version,
                  runCommand: (spec) => executeCommand(spec, {
                    env: commandEnvironment(),
                    timeoutMs: 8_000,
                    maxOutputBytes: 1024 * 1024,
                  }),
                })
                if (!inspected.installation || inspected.status.version !== trustedRelease.version) {
                  throw new Error(`${definition.name} 安装后服务验证失败，已恢复更新前版本`)
                }
                return inspected
              },
            })
          } else {
            await lifecycle()
          }
          installPrefix = attemptPrefix
          installed = true
          break
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          installErrors.push(
            `${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}：${redactCommandText(detail).replace(/\s+/g, ' ').trim().slice(0, 300) || '安装失败'}`,
          )
        }
      }
      if (!installed) {
        throw new Error(`${definition.name} 安装失败：${installErrors.join('；') || '所有 npm 源均不可用'}`)
      }
      invalidateCliUpdateCache(provider)
      const stagedManifest = installPrefix
        ? path.join(
            installPrefix,
            ...(platform === 'darwin' ? ['lib', 'node_modules'] : ['node_modules']),
            ...definition.packageName.split('/'),
            'package.json',
          )
        : null
      if (stagedManifest) {
        const stagedVersion = await readPackageManifestVersion(
          stagedManifest,
          `${definition.name} staged package.json`,
        )
        if (stagedVersion !== trustedRelease.version) {
          throw new Error(`${definition.name} 暂存安装验证失败：版本或 package.json 无效`)
        }
      }

      if (managedNpmLayout && managedNpmTransaction && installPrefix) {
        await replaceManagedNpmPrefixAtomically(
          managedNpmLayout.prefix,
          installPrefix,
          managedNpmTransaction,
          async () => {
            invalidateCliUpdateCache(provider)
            const promoted = await inspectCliTool(
              provider,
              npmExecutable,
              path.join(
                managedNpmLayout!.prefix,
                ...(platform === 'darwin' ? ['lib', 'node_modules'] : ['node_modules']),
              ),
            )
            if (
              !promoted.installation
              || promoted.status.version !== trustedRelease.version
              || !isManagedNpmInstallation(promoted.installation)
            ) {
              throw new Error(`${definition.name} 提交后验证失败，已恢复更新前版本`)
            }
            verification = promoted
          },
        )
      } else if (provider !== 'grok' || grokInstallStrategy !== 'darwin-official-npm') {
        const npmGlobalRoot = await resolveNpmGlobalRoot(npmExecutable, commandEnvironment())
        verification = await inspectCliTool(provider, npmExecutable, npmGlobalRoot)
      }
      const darwinGrokVerified = provider === 'grok' && grokInstallStrategy === 'darwin-official-npm'
      if (!darwinGrokVerified && (
        !verification?.installation
        || verification.status.version !== trustedRelease.version
        || (managedNpmLayout && !isManagedNpmInstallation(verification.installation))
      )) {
        throw new Error(`${definition.name} npm 命令已结束，但未在托管目录识别到有效安装和版本`)
      }
      sendInstallProgress(
        target,
        provider,
        'success',
        `${definition.name} 安装或更新完成（${verification!.status.version}）`,
      )
    } catch (error) {
      if (error instanceof ManagedNpmRollbackError) {
        preserveManagedNpmTransaction = error.preserveTransaction
      }
      const message = error instanceof Error ? error.message : String(error)
      sendInstallProgress(target, provider, 'error', message)
      throw error
    } finally {
      if (downloadedGrokBinary) await cleanupDownloadedGrokBinary(downloadedGrokBinary)
      if (managedNpmTransaction && !preserveManagedNpmTransaction) {
        await fs.promises.rm(managedNpmTransaction, { recursive: true, force: true }).catch(() => undefined)
      }
      installing.delete(provider)
    }
  }

  function installCli(provider: ProviderId, target: RendererMessageTarget): Promise<void> {
    return installationQueue.enqueue(`cli:install:${provider}`, () => installCliOperation(provider, target))
  }

  async function removeDirectoryFromUserPath(directory: string): Promise<void> {
    if (process.platform !== 'win32') return
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$target = [IO.Path]::GetFullPath($env:XINGMANG_REMOVE_PATH).TrimEnd("\\")',
      '$current = [Environment]::GetEnvironmentVariable("Path", "User")',
      '$next = @(($current -split ";") | Where-Object {',
      '  if (-not $_) { return $false }',
      '  try { [IO.Path]::GetFullPath($_).TrimEnd("\\") -ine $target } catch { $true }',
      '}) -join ";"',
      '[Environment]::SetEnvironmentVariable("Path", $next, "User")',
    ].join('\n')
    await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: { ...trustedCommandEnvironment(), XINGMANG_REMOVE_PATH: directory },
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    })
  }

  async function uninstallNativeGrok(installation: CliInstallation): Promise<void> {
    const cliEnvironment = commandEnvironment()
    const homeDirectory = cliEnvironment.HOME?.trim() || os.homedir()
    const userDirectory = path.resolve(homeDirectory, '.grok', 'bin')
    if (platform === 'darwin') {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory,
        installDirectory: installation.installDirectory,
        runCommand: async (spec) => {
          const result = await executeCommand(spec, {
            env: cliEnvironment,
            timeoutMs: 8_000,
            maxOutputBytes: 1024 * 1024,
          })
          return { stdout: result.stdout, stderr: result.stderr }
        },
      })
      return
    }
    const managedDirectory = process.platform === 'win32'
      ? path.resolve(managedNativeProviderRoot('grok'))
      : null
    const actualKey = path.resolve(installation.installDirectory).toLowerCase()
    const managed = Boolean(managedDirectory && actualKey === managedDirectory.toLowerCase())
    const expectedDirectory = managed ? managedDirectory! : userDirectory
    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: installation.installDirectory,
      expectedDirectory,
      fileNames: process.platform === 'win32'
        ? ['grok.exe', 'agent.exe', 'version.json']
        : ['grok', 'agent'],
      label: 'Grok CLI',
      platform: process.platform,
    })
    if (!managed) await removeDirectoryFromUserPath(result.directory)
  }

  async function uninstallNativeClaude(installation: CliInstallation): Promise<void> {
    const expectedDirectory = path.resolve(os.homedir(), '.local', 'bin')
    await uninstallVerifiedNativeCliFiles({
      actualDirectory: installation.installDirectory,
      expectedDirectory,
      fileNames: [process.platform === 'win32' ? 'claude.exe' : 'claude'],
      label: 'Claude Code',
      platform: process.platform,
      removeDirectoryWhenEmpty: false,
    })
  }

  function isManagedNpmInstallation(installation: CliInstallation): boolean {
    if ((platform !== 'win32' && platform !== 'darwin') || !installation.npmPrefix) return false
    const expected = managedNpmPrefix(commandEnvironment(), platform)
    return sameLocalPathIdentity(expected, installation.npmPrefix)
  }

  async function uninstallCliOperation(provider: ProviderId): Promise<ToolUninstallResult> {
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装、更新或卸载中`)
    installing.add(provider)
    try {
      const npmTool = await inspectTool('npm')
      const npmGlobalRoot = await resolveNpmGlobalRoot(npmTool.path, commandEnvironment())
      const initial = await inspectCliTool(provider, npmTool.path, npmGlobalRoot)
      if (!initial.status.installed || !initial.installation) {
        return { outcome: 'not-installed', previousVersion: null }
      }
      let current = initial
      const removedInstallations: string[] = []
      for (let attempt = 0; attempt < 8 && current.installation; attempt += 1) {
        const installation = current.installation
        const uninstall = current.status.uninstall
          ?? cliUninstallCapability(provider, installation, { platform, windowsExecutionMode })
        if (!uninstall.available) {
          throw new Error([
            uninstall.reason,
            uninstall.manualCommand ? `请在普通 PowerShell 中运行：${uninstall.manualCommand}` : null,
          ].filter(Boolean).join('；'))
        }
        if (uninstall.delegated) {
          // 包自带的卸载脚本位于用户可写目录，绝不能拿主进程的管理员令牌去跑。
          if (!uninstall.manualCommand) throw new Error('缺少可执行的卸载命令')
          await launchUnelevatedCommandWindow({
            commandLine: uninstall.manualCommand,
            title: `Uninstall ${cliCatalog[provider].packageName}`,
            machinePaths: resolveWindowsMachinePaths(),
          })
          return { outcome: 'delegated', previousVersion: initial.status.version }
        }
        const managedInstallation = isManagedNpmInstallation(installation)
        // isManagedNpmInstallation admits darwin, but the trusted resolution below is
        // Windows-only in effect: findExecutable drops additionalPaths on the trusted
        // branch, and the darwin trusted PATH is whatever the caller inherited — for a
        // Finder-launched build that is launchd's, which contains no npm. The managed
        // uninstall then failed to resolve npm at all. The sibling call twelve lines
        // below already gates on win32; this one now matches it.
        const npmExecutable = managedInstallation && platform === 'win32'
          ? await findExecutable('npm', {
              env: trustedCommandEnvironment(),
              windowsPackageManagers: ['npm'],
              trustedOnly: true,
            })
          : await findNpmExecutable(commandEnvironment(), [installation.commandPath])
            ?? npmTool.path
        const plan = buildCliUninstallPlan(provider, installation, npmExecutable)
        if (plan.kind === 'npm-uninstall') {
          const layout = managedInstallation ? await ensureManagedNpmLayout() : null
          const cache = layout ? await createManagedNpmCache(layout) : null
          try {
            const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
            await runCommand({
              executable: plan.executable,
              argv: layout && cache
                ? [
                    ...plan.argv,
                    `--cache=${cache}`,
                    `--userconfig=${layout.userConfig}`,
                    '--audit=false',
                    '--fund=false',
                  ]
                : plan.argv,
              windowsPackageManager: plan.windowsPackageManager,
            }, {
              env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
              trustedOnly,
              trustedPaths: layout && cache ? [layout.userConfig, cache] : undefined,
              timeoutMs: 2 * 60_000,
              maxOutputBytes: 4 * 1024 * 1024,
            })
          } finally {
            if (cache) await fs.promises.rm(cache, { recursive: true, force: true }).catch(() => undefined)
          }
          if (fs.existsSync(plan.packageRoot)) {
            throw new Error(`${cliCatalog[provider].name} 的 npm 包目录仍然存在，卸载未完成`)
          }
        } else if (plan.kind === 'grok-native') {
          try {
            await uninstallNativeGrok(installation)
          } catch (error) {
            if (platform === 'darwin') {
              return grokManualUninstallResult(initial.status.version, error)
            }
            throw error
          }
        } else {
          await uninstallNativeClaude(installation)
        }
        removedInstallations.push(installation.installDirectory)
        current = await inspectCliTool(provider, npmTool.path, npmGlobalRoot)
      }
      if (current.status.installed) {
        const removed = removedInstallations.length
          ? `已移除 ${removedInstallations.length} 个安装：${removedInstallations.join('；')}。`
          : '未移除任何安装。'
        const remaining = current.installation?.installDirectory ?? current.status.path ?? '未知目录'
        throw new Error(`${removed}仍检测到 ${cliCatalog[provider].name}：${remaining}`)
      }
      invalidateCliUpdateCache(provider)
      return { outcome: 'uninstalled', previousVersion: initial.status.version }
    } finally {
      installing.delete(provider)
    }
  }

  function uninstallCli(provider: ProviderId): Promise<ToolUninstallResult> {
    return installationQueue.enqueue(`cli:uninstall:${provider}`, () => uninstallCliOperation(provider))
  }

  function spawnDetached(
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { ...options, detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  function sendCodexDesktopInstallProgress(
    target: RendererMessageTarget,
    progress: CodexDesktopInstallProgress,
  ): void {
    if (!target.isDestroyed()) target.send('desktop:codex-install-progress', progress)
  }

  async function addCodexDesktopPackage(packagePath: string): Promise<void> {
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$ErrorActionPreference = \'Stop\'',
      `Add-AppxPackage -Path ${powershellLiteral(packagePath)} -ForceApplicationShutdown -ErrorAction Stop`,
    ].join('; ')
    try {
      await execFileAsync(resolveWindowsPowerShellExecutable(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        env: trustedCommandEnvironment(),
        windowsHide: true,
        timeout: 15 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    } catch (error) {
      const failure = error as { stderr?: unknown; message?: unknown }
      const stderr = Buffer.isBuffer(failure.stderr)
        ? failure.stderr.toString('utf8')
        : (typeof failure.stderr === 'string' ? failure.stderr : '')
      const message = stderr.trim()
        || (typeof failure.message === 'string' ? failure.message.trim() : '')
        || 'Windows 未返回错误详情'
      throw new Error(`Add-AppxPackage 安装失败：${message.slice(0, 2_000)}`)
    }
  }

  async function verifyInstalledCodexDesktop(
    expectedVersion: string,
  ): Promise<CodexDesktopPackageEntry> {
    const installedProbe = await inspectCodexDesktopPackage()
    if (!installedProbe.value) {
      throw new Error(installedProbe.error ?? '安装命令完成后仍未检测到 Codex Desktop')
    }
    const comparison = compareWindowsPackageVersions(installedProbe.value.version, expectedVersion)
    if (comparison === null || comparison !== 0) {
      throw new Error(
        `安装后检测到的版本 ${installedProbe.value.version} 与目标版本 ${expectedVersion} 不一致`,
      )
    }
    return installedProbe.value
  }

  async function installCodexDesktopOperation(
    target: RendererMessageTarget,
  ): Promise<CodexDesktopInstallResult> {
    if (platform === 'darwin') {
      throw new Error('macOS 上 Codex App 的安装由 Codex App 管理，请使用“打开”操作由已验证的 Codex CLI 完成安装或启动')
    }
    if (platform !== 'win32') throw new Error('Codex 桌面端安装目前仅支持 Windows')
    const architecture = process.arch === 'x64' || process.arch === 'arm64'
      ? process.arch
      : null
    if (!architecture) throw new Error(`Codex 桌面端不支持当前处理器架构 ${process.arch}`)

    const currentProbe = await inspectCodexDesktopPackage()
    if (currentProbe.error) throw new Error(currentProbe.error)
    const currentPackage = currentProbe.value
    const previousVersion = currentPackage?.version ?? null
    codexDesktopLatestCache = null
    codexDesktopMirrorCache = null
    const release = await fetchCodexDesktopMirrorRelease(architecture)
    if (previousVersion) {
      const comparison = compareWindowsPackageVersions(previousVersion, release.version)
      if (comparison === null) {
        throw new Error(`无法比较已安装版本 ${previousVersion} 与镜像版本 ${release.version}`)
      }
      if (comparison >= 0) {
        const latest = await inspectCodexDesktopLatestVersion()
        const latestComparison = latest.version
          ? compareWindowsPackageVersions(release.version, latest.version)
          : null
        const mirrorLagNotice = latestComparison === -1
          ? `；国内镜像当前仅提供 ${release.version}，微软商店官方最新为 ${latest.version}，可前往微软商店更新`
          : ''
        const result: CodexDesktopInstallResult = {
          action: 'unchanged',
          previousVersion,
          installedVersion: previousVersion,
        }
        sendCodexDesktopInstallProgress(target, {
          phase: 'completed',
          percent: 100,
          message: comparison === 0
            ? `Codex Desktop ${previousVersion} 已是国内镜像最新版${mirrorLagNotice}`
            : `当前 Codex Desktop ${previousVersion} 高于国内镜像版本 ${release.version}，无需更新${mirrorLagNotice}`,
        })
        return result
      }
    }

    const temporaryDirectory = await createInstallTemporaryDirectory('codex-desktop')
    const packagePath = path.join(temporaryDirectory, `ChatGPT-${architecture}.msix`)
    const source = {
      ...buildCodexDesktopPackageSources(architecture)[0],
      expectedContentLength: release.contentLength,
      expectedSha256Base64: release.sha256Base64,
    }
    try {
      sendCodexDesktopInstallProgress(target, {
        phase: 'downloading',
        percent: 0,
        message: `正在从${source.label}下载 Codex Desktop ${release.version}（0%）`,
      })
      const download = await downloadCodexDesktopPackage(source, packagePath, ({ percent }) => {
        sendCodexDesktopInstallProgress(target, {
          phase: 'downloading',
          percent,
          message: `正在从${source.label}下载 Codex Desktop ${release.version}（${percent}%）`,
        })
      })
      if (
        download.total !== release.contentLength
        || download.transferred !== release.contentLength
      ) {
        throw new Error(
          `国内镜像安装包字节数与清单不一致：应为 ${release.contentLength} 字节，实际 ${download.transferred} 字节`,
        )
      }
      if (download.sha256Base64 !== release.sha256Base64) {
        throw new Error('国内镜像安装包 SHA-256 与清单不一致，文件可能已损坏')
      }

      sendCodexDesktopInstallProgress(target, {
        phase: 'validating',
        percent: null,
        message: `正在校验${source.label}安装包的身份、版本、架构和签名`,
      })
      const metadata = await inspectCodexDesktopPackageFile(packagePath)
      const validationError = codexDesktopPackageValidationError(
        metadata,
        release.version,
        architecture,
      )
      if (validationError) throw new Error(validationError)
      if (metadata.version !== release.version) {
        throw new Error(
          `安装包版本 ${metadata.version} 与国内镜像清单版本 ${release.version} 不一致`,
        )
      }

      const processes = await listCodexDesktopProcesses()
      if (processes.length) {
        sendCodexDesktopInstallProgress(target, {
          phase: 'closing',
          percent: null,
          message: '正在关闭运行中的 Codex Desktop',
        })
        await terminateCodexDesktopProcesses(processes)
      }
      sendCodexDesktopInstallProgress(target, {
        phase: 'installing',
        percent: null,
        message: `正在安装 Codex Desktop ${release.version}`,
      })
      await addCodexDesktopPackage(packagePath)
      const installedPackage = await verifyInstalledCodexDesktop(release.version)
      codexDesktopLatestCache = null
      codexDesktopMirrorCache = null
      const action = previousVersion ? 'updated' : 'installed'
      sendCodexDesktopInstallProgress(target, {
        phase: 'completed',
        percent: 100,
        message: previousVersion
          ? `Codex Desktop 已从 ${previousVersion} 更新至 ${installedPackage.version}`
          : `Codex Desktop ${installedPackage.version} 安装完成`,
      })
      return { action, previousVersion, installedVersion: installedPackage.version }
    } finally {
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async function installCodexDesktopOperationWithProgress(
    target: RendererMessageTarget,
  ): Promise<CodexDesktopInstallResult> {
    if (codexDesktopInstalling) throw new Error('Codex 桌面端正在安装或更新，请勿重复操作')
    codexDesktopInstalling = true
    try {
      return await installCodexDesktopOperation(target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendCodexDesktopInstallProgress(target, { phase: 'error', percent: null, message })
      throw error
    } finally {
      codexDesktopInstalling = false
    }
  }

  function installCodexDesktop(
    target: RendererMessageTarget,
  ): Promise<CodexDesktopInstallResult> {
    return installationQueue.enqueue(
      'desktop:codex:install',
      () => installCodexDesktopOperationWithProgress(target),
    )
  }

  async function inspectCodexDesktopUpdate(forceRefresh = false): Promise<DesktopAppStatus> {
    if (forceRefresh) {
      codexDesktopLatestCache = null
      codexDesktopMirrorCache = null
    }
    return inspectCodexDesktop()
  }

  async function uninstallCodexDesktopOperation(): Promise<ToolUninstallResult> {
    if (platform === 'darwin') {
      throw new Error('macOS 上 Codex App 的卸载由 Codex App 管理，请在 Finder 的“应用程序”中移除 Codex App')
    }
    if (platform !== 'win32') throw new Error('Codex 桌面端卸载目前仅支持 Windows')
    if (codexDesktopInstalling) throw new Error('Codex 桌面端正在安装、更新或卸载中')
    codexDesktopInstalling = true
    try {
      const processes = await listCodexDesktopProcesses()
      const probe = await inspectCodexDesktopPackage()
      if (probe.error && !processes.length) throw new Error(probe.error)
      const processPackage = processes
        .map((entry) => parseCodexDesktopPackagePath(entry.executablePath))
        .find((entry): entry is CodexDesktopPackageEntry => entry !== null) ?? null
      const installedPackage = probe.value ?? processPackage
      if (!installedPackage) return { outcome: 'not-installed', previousVersion: null }
      if (processes.length) await terminateCodexDesktopProcesses(processes)
      const script = [
        '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        '$ErrorActionPreference = "Stop"',
        `Remove-AppxPackage -Package ${powershellLiteral(installedPackage.packageFullName)} -ErrorAction Stop`,
      ].join('; ')
      await execFileAsync(resolveWindowsPowerShellExecutable(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        env: trustedCommandEnvironment(),
        windowsHide: true,
        timeout: 2 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      const remaining = await inspectCodexDesktopPackage()
      if (remaining.value?.packageFullName === installedPackage.packageFullName) {
        throw new Error('Windows 仍报告 Codex 桌面端 Appx 包存在，卸载未完成')
      }
      codexDesktopLatestCache = null
      codexDesktopMirrorCache = null
      return { outcome: 'uninstalled', previousVersion: installedPackage.version }
    } finally {
      codexDesktopInstalling = false
    }
  }

  function uninstallCodexDesktop(): Promise<ToolUninstallResult> {
    return installationQueue.enqueue(
      'desktop:codex:uninstall',
      () => uninstallCodexDesktopOperation(),
    )
  }

  async function launchProviderOperation(provider: ProviderId, workspace: string): Promise<void> {
    const nativeConfig = inspectNativeProviderConfig(provider)
    if (!nativeConfig.hasApiKey || !nativeConfig.matchesRelay) {
      throw new Error('当前 CLI 不是星芒 AI 配置，请先保存星芒 AI 配置')
    }
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new Error('工作目录不存在，请重新选择')
    }

    const definition = cliCatalog[provider]
    const providerEnv = providerEnvironment(provider)
    const npmTool = await inspectTool('npm')
    const npmGlobalRoot = await resolveNpmGlobalRoot(npmTool.path, commandEnvironment())
    const { installation } = await inspectCliTool(provider, npmTool.path, npmGlobalRoot)
    if (!installation) throw new Error(`未检测到 ${definition.name}，请先安装`)

    if (platform === 'win32') {
      let command
      try {
        command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
        if (windowsExecutionMode === 'trusted-only') {
          assertTrustedElevatedCliCommand(command, definition.name)
        }
        await launchCliPowerShell({
          executable: command.executable,
          argv: command.argv,
          workspace,
          title: `${definition.name} · 星芒AI`,
          // The broker starts this terminal with Start-Process, so it inherits
          // the elevated token. Without the trusted base, NODE_OPTIONS and the
          // other injection variables would cross the integrity boundary and
          // run attacker code as administrator. assertTrustedElevatedCliCommand
          // only vets the executable path and cannot see the environment.
          env: interactiveTerminalEnvironment(
            providerEnv,
            windowsExecutionMode === 'trusted-only' ? trustedCommandEnvironment : commandEnvironment,
          ),
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`未能打开 ${definition.name}：${detail || '请查看反馈与诊断日志'}`)
      }
      return
    }

    if (platform === 'darwin') {
      try {
        const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode, {
          darwinStagingRetention: 'retained',
        })
        await launchMacosTerminal(buildDarwinCliLaunchPlan(command, workspace, providerEnv))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`未能打开 ${definition.name}：${detail || '请查看反馈与诊断日志'}`)
      }
      return
    }

    const environment = interactiveTerminalEnvironment(providerEnv)
    const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
    const terminals = [
      { command: 'x-terminal-emulator', args: ['-e', command.executable, ...command.argv] },
      { command: 'gnome-terminal', args: ['--', command.executable, ...command.argv] },
      { command: 'konsole', args: ['-e', command.executable, ...command.argv] },
    ]
    let terminal = terminals[0]
    for (const candidate of terminals) {
      if (await findExecutable(candidate.command, { env: environment })) {
        terminal = candidate
        break
      }
    }
    await spawnDetached(terminal.command, terminal.args, { cwd: workspace, env: environment })
  }

  function launchProvider(provider: ProviderId, workspace: string): Promise<void> {
    return installationQueue.enqueue(
      `cli:launch:${provider}`,
      () => launchProviderOperation(provider, workspace),
    )
  }

  function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  async function waitForCodexDesktopState(
    running: boolean,
    timeoutMs: number,
  ): Promise<WindowsProcessEntry[]> {
    const deadline = Date.now() + timeoutMs
    let processes = await listCodexDesktopProcesses()
    while ((processes.length > 0) !== running && Date.now() < deadline) {
      await delay(250)
      processes = await listCodexDesktopProcesses()
    }
    return processes
  }

  async function terminateCodexDesktopProcesses(processes: WindowsProcessEntry[]): Promise<void> {
    const taskkill = async (processId: number, force: boolean): Promise<void> => {
      const args = ['/PID', String(processId), '/T']
      if (force) args.push('/F')
      await execFileAsync(windowsSystemExecutable('taskkill.exe'), args, {
        env: trustedCommandEnvironment(),
        windowsHide: true,
        timeout: 8_000,
      })
    }

    await stopCodexDesktopProcesses(processes, {
      requestClose: (processId) => taskkill(processId, false),
      forceClose: (processId) => taskkill(processId, true),
      waitUntilStopped: (timeoutMs) => waitForCodexDesktopState(false, timeoutMs),
    })
  }

  function sendCodexDesktopStatus(
    target: RendererMessageTarget,
    phase: 'stopped' | 'running',
    status: DesktopAppStatus,
  ): void {
    if (!target.isDestroyed()) target.send('desktop:codex-status-changed', { phase, status })
  }

  async function launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
  ): Promise<CodexDesktopLaunchResult> {
    if (codexDesktopInstalling) throw new Error('Codex 桌面端正在安装、更新或卸载中，请稍后再试')
    if (platform === 'darwin' && mode === 'restart') {
      throw new Error('macOS 不支持重启 Codex，请使用打开操作唤起现有应用')
    }
    const nativeConfig = inspectNativeProviderConfig('codex')
    if (!nativeConfig.hasApiKey || !nativeConfig.matchesRelay) {
      throw new Error('Codex 当前不是星芒 AI 配置，请先保存星芒 AI 配置')
    }
    if (platform === 'darwin') {
      const command = await resolveVerifiedCliCommand(
        'codex',
        codexEnv,
        windowsExecutionMode,
        { darwinStagingRetention: 'ephemeral' },
      )
      try {
        if (!path.isAbsolute(command.executable)) {
          throw new Error('Codex CLI 命令未解析为绝对路径，已阻止启动')
        }
        const workspace = store.read().workspace
        try {
          if (!fs.statSync(workspace).isDirectory()) throw new Error('not a directory')
        } catch {
          throw new Error('工作目录不存在，请重新选择')
        }
        await executeCommand({
          executable: command.executable,
          argv: [...command.argv, 'app', workspace],
        }, {
          cwd: workspace,
          env: commandEnvironment(codexEnv),
        })
        return { restarted: false, status: await inspectCodexDesktop() }
      } finally {
        await command.release?.()
      }
    }
    if (platform !== 'win32') throw new Error('Codex 桌面端启动目前仅支持 Windows')

    const desktopApp = await inspectCodexDesktop()
    if (!desktopApp.installed || !desktopApp.path) {
      throw new Error('未检测到 Codex 桌面端，请先安装后重新检测')
    }

    const existingProcesses = await listCodexDesktopProcesses()
    const restarted = mode === 'restart' && existingProcesses.length > 0
    if (mode === 'restart') {
      try {
        await terminateCodexDesktopProcesses(existingProcesses)
      } catch (error) {
        const currentStatus = await inspectCodexDesktop()
        sendCodexDesktopStatus(
          target,
          currentStatus.running ? 'running' : 'stopped',
          currentStatus,
        )
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Codex 桌面端重启失败：${message}`)
      }
      sendCodexDesktopStatus(target, 'stopped', { ...desktopApp, running: false })
    }

    try {
      const launchPlan = buildCodexDesktopLaunchPlan(desktopApp.path)
      await spawnDetached(launchPlan.executable, launchPlan.args, {
        cwd: launchPlan.cwd,
        env: launchPlan.env,
        windowsHide: launchPlan.windowsHide,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`无法发送 Codex 桌面端启动请求：${message}`)
    }

    const startedProcesses = await waitForCodexDesktopState(true, 10_000)
    if (!startedProcesses.length) {
      throw new Error('已发送 Codex 桌面端启动请求，但未检测到窗口进程')
    }
    const runningStatus = { ...desktopApp, running: true }
    sendCodexDesktopStatus(target, 'running', runningStatus)
    return { restarted, status: runningStatus }
  }

  async function fetchAvailableModels(apiKeyInput: string): Promise<string[]> {
    const apiKey = apiKeyInput.trim()
    if (!apiKey) throw new Error('请先填写 API Key')
    if (/\r|\n/.test(apiKey)) throw new Error('API Key 格式错误')

    const now = Date.now()
    for (const [key, entry] of modelAccessCache) {
      if (entry.expiresAt <= now) modelAccessCache.delete(key)
    }
    const cacheKey = modelAccessCacheKey(apiKey)
    const cached = modelAccessCache.get(cacheKey)
    if (cached) {
      modelAccessCache.delete(cacheKey)
      modelAccessCache.set(cacheKey, cached)
      return [...cached.models]
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await fetch('https://api.solov.cc/v1/models', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: controller.signal,
      })
      const body = await readBoundedResponseText(response, maximumModelResponseBytes, '模型接口')
      if (!response.ok) {
        let detail = ''
        try {
          const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
          const message = parsed.error?.message ?? parsed.message
          if (typeof message === 'string') detail = safeRelayErrorMessage(message, apiKey)
        } catch {
          detail = ''
        }
        throw new Error(detail || `模型查询失败，服务返回 ${response.status}`)
      }

      let payload: unknown
      try {
        payload = JSON.parse(body) as unknown
      } catch {
        throw new Error('模型接口返回的不是有效 JSON')
      }
      const models = parseModelIds(payload)
      if (!models.length) throw new Error('当前 API Key 没有返回可用模型')
      while (modelAccessCache.size >= modelAccessCacheMaxEntries) {
        const oldestKey = modelAccessCache.keys().next().value as string | undefined
        if (!oldestKey) break
        modelAccessCache.delete(oldestKey)
      }
      modelAccessCache.set(cacheKey, {
        expiresAt: Date.now() + 2 * 60_000,
        models: [...models],
      })
      return [...models]
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('模型查询超时，请检查网络后重试')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  function buildConfigSummary(previewOnboarding: boolean): AppConfigSummary {
    const stored = store.read()
    const result = {
      workspace: stored.workspace,
      providers: Object.fromEntries(
        providerIds.map((id) => [id, toNativeConfigSummary(inspectNativeProviderConfig(id))]),
      ) as Record<ProviderId, NativeConfigSummary>,
    }
    if (previewOnboarding) {
      result.providers.codex = {
        ...result.providers.codex,
        actualBaseUrl: '',
        exists: false,
        hasApiKey: false,
        matchesRelay: false,
        apiKeyPreview: null,
        model: '',
        updatedAt: null,
        files: result.providers.codex.files.map((file) => ({ ...file, exists: false })),
      }
    }
    return result
  }

  function inspectCodexReadiness(previewOnboarding: boolean): CodexReadinessStatus {
    if (previewOnboarding) return { hasApiKey: false, matchesRelay: false }
    const codex = inspectNativeProviderConfig('codex')
    return { hasApiKey: codex.hasApiKey, matchesRelay: codex.matchesRelay }
  }

  function revealApiKey(provider: ProviderId, previewOnboarding: boolean): string {
    if (previewOnboarding) return ''
    return inspectNativeProviderConfig(provider).apiKey
  }

  async function saveConfig(payload: ConfigSavePayload, previewOnboarding: boolean) {
    const model = payload.model.trim()
    // An empty key is an explicit renderer sentinel: reuse the key already held by the main process.
    const apiKey = payload.apiKey.trim() || inspectNativeProviderConfig(payload.provider).apiKey
    if (!apiKey) throw new Error('请先填写 API Key')
    const availableModels = await fetchAvailableModels(apiKey)
    if (!availableModels.includes(model)) {
      throw new Error(`当前 API Key 不支持模型 ${model}，请重新检测并选择可用模型`)
    }
    if (previewOnboarding && payload.provider === 'codex') return { backups: [], files: [] }
    return saveProviderConfig(payload.provider, apiKey, payload.model, payload.mode, providerRoots)
  }

  return {
    readStoredConfig: () => store.read(),
    writeStoredConfig: (config) => store.write(config),
    inspectCodexReadiness,
    getConfig: buildConfigSummary,
    revealApiKey,
    saveConfig,
    scanSystem,
    inspectCodexSetupStatus,
    installNodeRuntime,
    installCli,
    uninstallCli,
    inspectCliUpdate,
    installCodexDesktop,
    uninstallCodexDesktop,
    inspectCodexDesktopUpdate,
    launchProvider,
    inspectCodexDesktop,
    launchCodexDesktop,
    fetchAvailableModels,
  }
}
