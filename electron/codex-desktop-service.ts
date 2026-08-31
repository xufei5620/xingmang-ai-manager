import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AppSettingsStore } from './app-settings'
import type { ProviderId } from './catalog'
import {
  codexDesktopPackageValidationError,
  compareWindowsPackageVersions,
  parseCodexDesktopAppManifest,
  parseCodexDesktopMirrorManifest,
  parseCodexDesktopPackageMetadata,
  parseCodexDesktopPackagePath,
  parseCodexDesktopPackageProbeJson,
  parseCodexDesktopPackagesJson,
  type CodexDesktopPackageProbeSource,
  parseCodexDesktopUpdateManifest,
  parseStartAppsJson,
  parseWindowsProcessesJson,
  selectCodexDesktopApp,
  selectCodexDesktopPackage,
  stopCodexDesktopProcesses,
  type CodexDesktopMirrorRelease,
  type CodexDesktopPackageEntry,
  type CodexDesktopPackageMetadata,
  type StartAppEntry,
  type WindowsProcessEntry,
} from './codex-desktop'
import { commandEnvironment, trustedCommandEnvironment, windowsSystemExecutable, type runCommand } from './command-runner'
import {
  canLaunchManagedProvider,
  managedProviderLaunchBlockedMessage,
  type NativeConfigInspection,
} from './config-files'
import type { InstallationQueue } from './installation-queue'
import type { inspectMacosCodexApp, MacosCodexAppInspection } from './macos-codex-app'
import { describeProbeFailure } from './probe-failure'
import { resolveWindowsExplorerExecutable } from './system-shell'
import {
  activateCodexDesktopWithCdp as activateCodexDesktopWithCdpDefault,
  getAvailableLoopbackPort as getAvailableLoopbackPortDefault,
  injectCodexDesktopChineseLocale as injectCodexDesktopChineseLocaleDefault,
} from './codex-desktop-cdp'
import type {
  CodexDesktopLaunchMode,
  CodexDesktopLaunchResult,
  DesktopAppStatus,
  RendererMessageTarget,
  ToolUninstallResult,
  UpdateCheckStatus,
  UpdateSource,
  VersionUpdateStatus,
} from './system-service'
import type { resolveCliCommand } from './tool-installation'
import { resolveWindowsPowerShellExecutable, type WindowsCliExecutionMode } from './windows-elevation'
import { resolveWindowsMachinePaths } from './windows-machine-paths'

const execFileAsync = promisify(execFile)

const codexDesktopUpdateManifestUrl = 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json'
const codexDesktopMirrorManifestUrl = 'https://codexapp.agentsmirror.com/latest/manifest'
const codexDesktopMirrorFallbackManifestUrl = 'https://codexapp-r2.agentsmirror.com/latest/manifest'
// The historical route is intentionally separate from the normal probe. It
// is only consulted for a first install after the current mirror candidates
// have failed; an installed desktop app never falls back to an older build.
const codexDesktopMirrorPreviousManifestUrl = 'https://codexapp.agentsmirror.com/previous/manifest'
const codexDesktopMirrorFallbackPreviousManifestUrl = 'https://codexapp-r2.agentsmirror.com/previous/manifest'
const codexDesktopMirrorPackageUrls = {
  x64: 'https://codexapp.agentsmirror.com/latest/win-x64',
  arm64: 'https://codexapp.agentsmirror.com/latest/win-arm64',
} as const
const codexDesktopMirrorPreviousPackageUrls = {
  x64: 'https://codexapp.agentsmirror.com/previous/win-x64',
  arm64: 'https://codexapp.agentsmirror.com/previous/win-arm64',
} as const
const codexDesktopMirrorFallbackPreviousPackageUrls = {
  x64: 'https://codexapp-r2.agentsmirror.com/previous/win-x64',
  arm64: 'https://codexapp-r2.agentsmirror.com/previous/win-arm64',
} as const
const codexDesktopMirrorFallbackPackageUrls = {
  x64: 'https://codexapp-r2.agentsmirror.com/latest/win-x64',
  arm64: 'https://codexapp-r2.agentsmirror.com/latest/win-arm64',
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
const minimumCodexDesktopPackageBytes = 10 * 1024 * 1024
const maximumCodexDesktopPackageBytes = 1_500 * 1024 * 1024
const maximumCodexDesktopManifestBytes = 1024 * 1024
const maximumCodexDesktopAppManifestBytes = 512 * 1024
const codexDesktopManifestRefreshParameter = 'xm_refresh'
// First-run AppX startup can spend several seconds registering WebView and
// scanning the package. Keep the fast path responsive, but give the fallback
// enough time to observe a healthy process on a cold machine.
const codexDesktopLaunchInitialWaitMs = 12_000
const codexDesktopLaunchFallbackWaitMs = 33_000

export interface CodexDesktopLaunchPlan {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  windowsHide: boolean
}

export interface CodexDesktopWindowsLaunchContext {
  userSid: string | null
  isBuiltInAdministrator: boolean
  uacEnabled: boolean | null
  filterAdministratorToken: boolean | null
}

const emptyCodexDesktopWindowsLaunchContext: CodexDesktopWindowsLaunchContext = {
  userSid: null,
  isBuiltInAdministrator: false,
  uacEnabled: null,
  filterAdministratorToken: null,
}

/**
 * Parses the small JSON probe used after AppX activation fails. Keep this
 * parser tolerant because PowerShell may add a trailing newline or warning
 * text when a policy value is unavailable.
 */
export function parseCodexDesktopWindowsLaunchContext(
  output: string,
): CodexDesktopWindowsLaunchContext {
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'))
  if (!jsonLine) return { ...emptyCodexDesktopWindowsLaunchContext }
  try {
    const value = JSON.parse(jsonLine) as Record<string, unknown>
    const userSid = typeof value.sid === 'string' && /^S-1-\d+(?:-\d+)+$/.test(value.sid)
      ? value.sid
      : null
    const parseBoolean = (candidate: unknown): boolean | null => {
      if (candidate === true || candidate === 1 || candidate === '1') return true
      if (candidate === false || candidate === 0 || candidate === '0') return false
      return null
    }
    return {
      userSid,
      isBuiltInAdministrator: userSid?.endsWith('-500') ?? false,
      uacEnabled: parseBoolean(value.uacEnabled),
      filterAdministratorToken: parseBoolean(value.filterAdministratorToken),
    }
  } catch {
    return { ...emptyCodexDesktopWindowsLaunchContext }
  }
}

export function describeCodexDesktopLaunchFailure(
  context: CodexDesktopWindowsLaunchContext,
): string {
  const hints: string[] = []
  if (context.isBuiltInAdministrator) {
    hints.push('当前 Windows 账户是内置 Administrator（SID 以 -500 结尾）')
  }
  if (context.uacEnabled === false) hints.push('UAC 已关闭')
  if (hints.length) {
    return [
      'Windows 无法创建 Codex Desktop 进程（AppModel 常见错误 0xC0EA0001）',
      `${hints.join('，')}。`,
      '请先运行 wsreset.exe，再使用普通 Windows 账户重新安装或启动 Codex Desktop。',
    ].join('；')
  }
  return [
    'Windows 已接受 Codex Desktop 启动请求，但 AppModel 没有创建进程。',
    '这通常与 Microsoft Store 授权、AppX 状态或 UAC 策略有关，请先运行 wsreset.exe 后重试；如果仍失败，请使用反馈与诊断中的启动日志。',
  ].join('')
}

export interface CodexDesktopPackageProbe {
  value: CodexDesktopPackageEntry | null
  error: string | null
  source?: CodexDesktopPackageProbeSource
  /** False means the probe could not establish that the package is absent. */
  confirmedAbsent?: boolean
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
  kind: 'official' | 'mirror' | 'mirror-previous'
}

export interface CodexDesktopManifestCandidate {
  source: CodexDesktopManifestSource
  version: string
  release: CodexDesktopMirrorRelease | null
  packageSource: CodexDesktopPackageSource | null
}

interface CodexDesktopManifestProbeResult {
  candidates: CodexDesktopManifestCandidate[]
  errors: string[]
}

function validateCodexDesktopMirrorObjectStorageUrl(parsed: URL, original: URL): boolean {
  if (parsed.hostname !== codexDesktopMirrorObjectStorageHost) return false
  if (parsed.pathname !== `${codexDesktopMirrorObjectStoragePrefix}${original.pathname}`) return false

  let expectedContentType: string
  let expectedFileName: string
  if (/^\/(?:latest|previous)\/manifest$/.test(original.pathname)) {
    expectedContentType = 'application/json'
    expectedFileName = 'release-manifest.json'
  } else {
    const packageMatch = original.pathname.match(/^\/(latest|previous)\/win-(x64|arm64)$/)
    if (!packageMatch) return false
    expectedContentType = 'application/vnd.ms-appx'
    expectedFileName = `Codex-Windows-${packageMatch[2]}.msix`
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
  const originalRefresh = original.searchParams.get(codexDesktopManifestRefreshParameter)
  const trustedOriginalRefresh = /^\/(?:latest|previous)\/manifest$/.test(original.pathname)
    && codexDesktopMirrorHosts.has(original.hostname)
    && original.searchParams.size === 1
    && /^\d+-\d+$/.test(originalRefresh ?? '')
  if (original.search && !trustedOriginalRefresh) {
    throw new Error('Codex Desktop 下载地址包含不受信任的查询参数')
  }
  const staticQuery = !parsed.search
    || (trustedOriginalRefresh && parsed.search === original.search)
  const staticResource = staticQuery
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

export async function fetchTrustedCodexDesktopResource(
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
  return [
    { label: '国内镜像', url: codexDesktopMirrorPackageUrls[architecture] },
    { label: '镜像备用源', url: codexDesktopMirrorFallbackPackageUrls[architecture] },
  ]
}

export function buildCodexDesktopManifestSources(
): CodexDesktopManifestSource[] {
  return [
    { kind: 'mirror', label: '国内镜像', url: codexDesktopMirrorManifestUrl },
    { kind: 'mirror', label: '镜像备用源', url: codexDesktopMirrorFallbackManifestUrl },
    { kind: 'official', label: 'OpenAI 官方源', url: codexDesktopUpdateManifestUrl },
  ]
}

/**
 * Historical candidates are intentionally excluded from normal status checks.
 * The mirror service can publish a schema-compatible `/previous` route
 * without making every startup probe pay the extra network cost.
 */
export function buildCodexDesktopPreviousManifestSources(): CodexDesktopManifestSource[] {
  return [
    { kind: 'mirror-previous', label: '国内镜像上一版本', url: codexDesktopMirrorPreviousManifestUrl },
    { kind: 'mirror-previous', label: '镜像备用源上一版本', url: codexDesktopMirrorFallbackPreviousManifestUrl },
  ]
}

function packageSourceForManifest(
  source: CodexDesktopManifestSource,
  architecture: 'x64' | 'arm64',
  resolvedManifestUrl: string,
): CodexDesktopPackageSource | null {
  const resolved = new URL(resolvedManifestUrl)
  const sourcePath = new URL(source.url).pathname
  const route = (
    resolved.pathname.match(/^\/(latest|previous)\/manifest$/)
      ?? sourcePath.match(/^\/(latest|previous)\/manifest$/)
  )?.[1] as 'latest' | 'previous' | undefined
  if (!route) return null
  const packageUrls = route === 'previous'
    ? { primary: codexDesktopMirrorPreviousPackageUrls, fallback: codexDesktopMirrorFallbackPreviousPackageUrls }
    : { primary: codexDesktopMirrorPackageUrls, fallback: codexDesktopMirrorFallbackPackageUrls }
  if (resolved.hostname === new URL(codexDesktopMirrorFallbackManifestUrl).hostname) {
    return {
      label: route === 'previous' ? '镜像备用源上一版本' : '镜像备用源',
      url: packageUrls.fallback[architecture],
    }
  }
  if (resolved.hostname === new URL(codexDesktopMirrorManifestUrl).hostname) {
    return {
      label: route === 'previous' ? '国内镜像上一版本' : '国内镜像',
      url: packageUrls.primary[architecture],
    }
  }

  // The primary route can redirect to a signed object-store URL. That object
  // is an implementation detail of the route, so retain the originating
  // route's package endpoint. Cross-mirror redirects above are different: the
  // final mirror hostname determines which package endpoint owns the manifest.
  if (resolved.hostname === codexDesktopMirrorObjectStorageHost) {
    if (source.url === codexDesktopMirrorManifestUrl) {
      return { label: source.label, url: codexDesktopMirrorPackageUrls[architecture] }
    }
    if (source.url === codexDesktopMirrorFallbackManifestUrl) {
      return { label: source.label, url: codexDesktopMirrorFallbackPackageUrls[architecture] }
    }
    if (source.url === codexDesktopMirrorPreviousManifestUrl) {
      return { label: source.label, url: codexDesktopMirrorPreviousPackageUrls[architecture] }
    }
    if (source.url === codexDesktopMirrorFallbackPreviousManifestUrl) {
      return { label: source.label, url: codexDesktopMirrorFallbackPreviousPackageUrls[architecture] }
    }
  }
  return null
}

export function selectLatestCodexDesktopManifestCandidate(
  candidates: CodexDesktopManifestCandidate[],
): CodexDesktopManifestCandidate | null {
  let selected: CodexDesktopManifestCandidate | null = null
  for (const candidate of candidates) {
    if (!selected) {
      selected = candidate
      continue
    }
    const comparison = compareWindowsPackageVersions(selected.version, candidate.version)
    if (comparison === -1) selected = candidate
  }
  return selected
}

export function rankCodexDesktopMirrorCandidates(
  candidates: CodexDesktopManifestCandidate[],
): CodexDesktopManifestCandidate[] {
  const ranked = candidates
    .filter((candidate) => candidate.release !== null && candidate.packageSource !== null)
    .sort((left, right) => {
      const comparison = compareWindowsPackageVersions(left.version, right.version)
      return comparison === 1 ? -1 : comparison === -1 ? 1 : 0
    })
  const packageUrls = new Set<string>()
  return ranked.filter((candidate) => {
    const packageUrl = candidate.packageSource?.url
    if (!packageUrl || packageUrls.has(packageUrl)) return false
    packageUrls.add(packageUrl)
    return true
  })
}

export async function fetchCodexDesktopManifestCandidate(
  source: CodexDesktopManifestSource,
  architecture: 'x64' | 'arm64',
  fetchImplementation: typeof fetch,
  options: { retryAttempt?: number } = {},
): Promise<CodexDesktopManifestCandidate> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const requestUrl = options.retryAttempt === undefined
      || (source.kind !== 'mirror' && source.kind !== 'mirror-previous')
      ? source.url
      : (() => {
          const refreshed = new URL(source.url)
          refreshed.searchParams.set(
            codexDesktopManifestRefreshParameter,
            `${Date.now()}-${options.retryAttempt}`,
          )
          return refreshed.href
        })()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    }
    const response = await fetchTrustedCodexDesktopResource(requestUrl, {
      headers,
      signal: controller.signal,
    }, fetchImplementation)
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
    if (source.kind === 'official') {
      const manifest = parseCodexDesktopUpdateManifest(manifestText)
      if (!manifest) throw new Error('schema、产品 ID 或包身份校验失败')
      return {
        source,
        version: manifest.buildVersion,
        release: null,
        packageSource: null,
      }
    }

    const release = parseCodexDesktopMirrorManifest(manifestText, architecture)
    if (!release) throw new Error('schema、产品 ID、包身份、版本、架构、文件大小或 SHA-256 校验失败')
    return {
      source,
      version: release.version,
      release,
      packageSource: packageSourceForManifest(source, architecture, response.url || source.url),
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('查询超时')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function probeCodexDesktopManifests(
  architecture: 'x64' | 'arm64',
  fetchImplementation: typeof fetch = fetch,
  sources: CodexDesktopManifestSource[] = buildCodexDesktopManifestSources(),
): Promise<CodexDesktopManifestProbeResult> {
  const candidates: CodexDesktopManifestCandidate[] = []
  const errorsBySource = new Map<number, string>()
  const allIndexes = sources.map((_source, index) => index)

  const collect = (
    results: PromiseSettledResult<CodexDesktopManifestCandidate>[],
    indexes: number[],
  ): void => {
    results.forEach((result, resultIndex) => {
      const index = indexes[resultIndex]
      errorsBySource.delete(index)
      if (result.status === 'fulfilled') {
        candidates.push(result.value)
        return
      }
      const detail = result.reason instanceof Error ? result.reason.message : String(result.reason)
      errorsBySource.set(index, `${sources[index].label}：${detail || '查询失败'}`)
    })
  }

  const results = await Promise.allSettled(
    sources.map((source) => fetchCodexDesktopManifestCandidate(source, architecture, fetchImplementation)),
  )
  collect(results, allIndexes)

  // A mirror can be briefly inconsistent while its manifest and package are
  // being published. Retry only when no valid source of that kind exists, so
  // a healthy mirror is never delayed by an unrelated stale route.
  const availableKinds = new Set(candidates.map((candidate) => candidate.source.kind))
  const retryIndexes = allIndexes.filter((index) => (
    results[index].status === 'rejected'
    && !availableKinds.has(sources[index].kind)
  ))
  if (retryIndexes.length) {
    await delay(900)
    const retries = await Promise.allSettled(
      retryIndexes.map((index) => fetchCodexDesktopManifestCandidate(
        sources[index],
        architecture,
        fetchImplementation,
        { retryAttempt: 1 },
      )),
    )
    collect(retries, retryIndexes)
  }

  const errors: string[] = []
  allIndexes.forEach((index) => {
    const error = errorsBySource.get(index)
    if (error) errors.push(error)
  })
  return { candidates, errors }
}

export async function fetchCodexDesktopMirrorRelease(
  architecture: 'x64' | 'arm64',
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexDesktopMirrorRelease> {
  const sources = buildCodexDesktopManifestSources().filter((source) => source.kind === 'mirror')
  const result = await probeCodexDesktopManifests(architecture, fetchImplementation, sources)
  const selected = selectLatestCodexDesktopManifestCandidate(result.candidates)
  if (!selected?.release) {
    throw new Error(`国内镜像清单读取失败：${result.errors.join('；') || '没有可用镜像'}`)
  }
  return selected.release
}

/**
 * Reads the opt-in historical route used only by first-install recovery.
 * Returning all valid candidates lets the normal downloader keep its
 * manifest-bound source fallback and validation behavior.
 */
export async function fetchCodexDesktopPreviousManifestCandidates(
  architecture: 'x64' | 'arm64',
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexDesktopManifestProbeResult> {
  return probeCodexDesktopManifests(
    architecture,
    fetchImplementation,
    buildCodexDesktopPreviousManifestSources(),
  )
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

export interface CodexDesktopCandidateDownloadResult {
  candidate: CodexDesktopManifestCandidate
  download: CodexDesktopDownloadResult
}

export interface CodexDesktopCandidateDownloadOptions {
  fetchImplementation?: typeof fetch
  onAttempt?: (
    candidate: CodexDesktopManifestCandidate,
    attemptIndex: number,
    previousFailure: string | null,
  ) => void
  onProgress?: (
    candidate: CodexDesktopManifestCandidate,
    progress: CodexDesktopDownloadProgress,
  ) => void
  validatePackage?: (
    candidate: CodexDesktopManifestCandidate,
    packagePath: string,
  ) => Promise<void>
}

export async function downloadCodexDesktopPackageFromCandidates(
  candidates: CodexDesktopManifestCandidate[],
  destination: string,
  options: CodexDesktopCandidateDownloadOptions = {},
): Promise<CodexDesktopCandidateDownloadResult> {
  const ranked = rankCodexDesktopMirrorCandidates(candidates)
  if (!ranked.length) throw new Error('国内镜像暂时没有可安装的 Codex Desktop 版本')

  const failures: string[] = []
  for (const [attemptIndex, candidate] of ranked.entries()) {
    const release = candidate.release
    const packageSource = candidate.packageSource
    if (!release || !packageSource) continue

    await fs.promises.rm(destination, { force: true }).catch(() => undefined)
    options.onAttempt?.(candidate, attemptIndex, failures.at(-1) ?? null)
    const source: CodexDesktopPackageSource = {
      ...packageSource,
      expectedContentLength: release.contentLength,
      expectedSha256Base64: release.sha256Base64,
    }
    try {
      const download = await downloadCodexDesktopPackage(
        source,
        destination,
        (progress) => options.onProgress?.(candidate, progress),
        options.fetchImplementation,
      )
      if (download.total !== release.contentLength || download.transferred !== release.contentLength) {
        throw new Error(
          `${source.label}安装包字节数与镜像清单不一致：应为 ${release.contentLength} 字节，实际 ${download.transferred} 字节`,
        )
      }
      if (download.sha256Base64 !== release.sha256Base64) {
        throw new Error(`${source.label}安装包 SHA-256 与镜像清单不一致，文件可能已损坏`)
      }
      await options.validatePackage?.(candidate, destination)
      return { candidate, download }
    } catch (error) {
      await fs.promises.rm(destination, { force: true }).catch(() => undefined)
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(`${source.label}（${release.version}）：${detail || '校验失败'}`)
    }
  }

  throw new Error(`所有国内镜像均未通过完整校验：${failures.join('；') || '没有可用镜像'}`)
}

export function powershellLiteral(value: string): string {
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

export function desktopMirrorUpdateAvailable(
  installedVersion: string | null,
  mirrorVersion: string | null,
): boolean | null {
  if (!mirrorVersion) return null
  if (!installedVersion) return true
  const comparison = compareWindowsPackageVersions(installedVersion, mirrorVersion)
  return comparison === null ? null : comparison < 0
}

export async function findCodexDesktopStartApp(): Promise<StartAppEntry | null> {
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

export async function listCodexDesktopProcesses(): Promise<WindowsProcessEntry[]> {
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

export function buildCodexDesktopPackageProbeScript(): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "Stop"',
    '$currentPackages = @()',
    '$currentError = $null',
    'try { $currentPackages = @(Get-AppxPackage -Name \'OpenAI.Codex*\' -ErrorAction Stop | Select-Object Name, Version, PackageFullName, PackageFamilyName, InstallLocation) } catch { $currentError = $_.Exception.Message }',
    '$packages = $currentPackages',
    '$source = $null',
    'if ($currentPackages.Count -gt 0) { $source = \'current-user\' }',
    '$allUsersError = $null',
    'if ($currentPackages.Count -eq 0) {',
    '  try {',
    '    $packages = @(Get-AppxPackage -AllUsers -Name \'OpenAI.Codex*\' -ErrorAction Stop | Select-Object Name, Version, PackageFullName, PackageFamilyName, InstallLocation)',
    '    if ($packages.Count -gt 0) { $source = \'all-users\' }',
    '  } catch { $allUsersError = $_.Exception.Message }',
    '}',
    '$confirmedAbsent = $packages.Count -eq 0 -and $null -eq $currentError -and $null -eq $allUsersError',
    '$errorMessage = $null',
    'if ($null -ne $allUsersError) {',
    '  $errorMessage = \'当前用户未检测到 Codex Desktop，系统拒绝读取其他用户的安装信息。请使用安装 Codex Desktop 的 Windows 账户启动星芒 AI 管理工具。\'',
    '} elseif ($null -ne $currentError -and $packages.Count -eq 0) {',
    '  $errorMessage = \'无法读取 Codex Desktop 的 Windows Appx 安装信息，请使用安装该应用的 Windows 账户启动星芒 AI 管理工具后重试。\'',
    '}',
    '[pscustomobject]@{ packages = $packages; source = $source; confirmedAbsent = $confirmedAbsent; error = $errorMessage } | ConvertTo-Json -Compress',
  ].join('; ')
}

export async function inspectCodexDesktopPackage(): Promise<CodexDesktopPackageProbe> {
  const script = buildCodexDesktopPackageProbeScript()

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
    return parseCodexDesktopPackageProbeJson(stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message.trim().slice(0, 240) : ''
    return {
      value: null,
      error: message || '无法读取 Windows Appx 包信息',
      source: null,
      confirmedAbsent: false,
    }
  }
}

export async function inspectCodexDesktopAppVersion(
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

export async function addCodexDesktopPackage(packagePath: string): Promise<void> {
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

export async function verifyInstalledCodexDesktop(
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessId(processId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isProcessAlive(processId)) return true
    await delay(250)
  }
  return isProcessAlive(processId)
}

async function inspectCodexDesktopWindowsLaunchContext(): Promise<CodexDesktopWindowsLaunchContext> {
  if (process.platform !== 'win32') return { ...emptyCodexDesktopWindowsLaunchContext }
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$policy = Get-ItemProperty -LiteralPath "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"',
    '$uacEnabled = $null',
    '$filterAdministratorToken = $null',
    'if ($null -ne $policy.EnableLUA) { $uacEnabled = [int]$policy.EnableLUA }',
    'if ($null -ne $policy.FilterAdministratorToken) { $filterAdministratorToken = [int]$policy.FilterAdministratorToken }',
    '[pscustomobject]@{ sid = [string]$identity.User.Value; uacEnabled = $uacEnabled; filterAdministratorToken = $filterAdministratorToken } | ConvertTo-Json -Compress',
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
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    })
    return parseCodexDesktopWindowsLaunchContext(stdout)
  } catch {
    return { ...emptyCodexDesktopWindowsLaunchContext }
  }
}

export async function waitForCodexDesktopState(
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

export async function terminateCodexDesktopProcesses(processes: WindowsProcessEntry[]): Promise<void> {
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

const codexDesktopLatestCacheTtlMs = 10 * 60_000
const codexDesktopLatestFailureCacheTtlMs = 30_000

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

interface DesktopManifestProbeBundle {
  latest: DesktopLatestVersionProbe
  mirror: DesktopMirrorVersionProbe
  mirrorCandidate: CodexDesktopManifestCandidate | null
  mirrorCandidates: CodexDesktopManifestCandidate[]
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

export interface CodexDesktopWindowsProbes {
  match: StartAppEntry | null
  processes: WindowsProcessEntry[]
  packageProbe: CodexDesktopPackageProbe
  mirrorProbe: DesktopMirrorVersionProbe
  detectionFailed: boolean
  detectionError: string | null
}

/**
 * The mirror-version probe already surfaces its own failures through
 * `mirrorError`, independent of whether Codex Desktop is installed. Only the
 * three probes that determine `installed` (start-menu match, running
 * processes, registered Appx package) flip `detectionFailed` — otherwise a
 * mirror-manifest hiccup would hide an otherwise confidently known install
 * state behind a generic "detection failed" card.
 */
export function buildCodexDesktopWindowsProbes(
  matchResult: PromiseSettledResult<StartAppEntry | null>,
  processesResult: PromiseSettledResult<WindowsProcessEntry[]>,
  packageResult: PromiseSettledResult<CodexDesktopPackageProbe>,
  mirrorResult: PromiseSettledResult<DesktopMirrorVersionProbe>,
  checkedAt: string = new Date().toISOString(),
): CodexDesktopWindowsProbes {
  const packageProbeError = packageResult.status === 'fulfilled' ? packageResult.value.error : null
  const installDetectionFailures = [matchResult, processesResult, packageResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => describeProbeFailure(result.reason))
  const hasIndependentInstallEvidence = (matchResult.status === 'fulfilled' && matchResult.value !== null)
    || (processesResult.status === 'fulfilled' && processesResult.value.some((entry) => (
      parseCodexDesktopPackagePath(entry.executablePath) !== null
    )))
  if (packageProbeError && !hasIndependentInstallEvidence) installDetectionFailures.push(packageProbeError)
  return {
    match: matchResult.status === 'fulfilled' ? matchResult.value : null,
    processes: processesResult.status === 'fulfilled' ? processesResult.value : [],
    packageProbe: packageResult.status === 'fulfilled'
      ? packageResult.value
      : { value: null, error: describeProbeFailure(packageResult.reason) },
    mirrorProbe: mirrorResult.status === 'fulfilled'
      ? mirrorResult.value
      : { version: null, checkedAt, error: describeProbeFailure(mirrorResult.reason) },
    detectionFailed: installDetectionFailures.length > 0,
    detectionError: installDetectionFailures.length > 0 ? installDetectionFailures.join('；') : null,
  }
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

// Exported: also used by `buildDesktopAppStatusFromSettled`, which stays in
// system-service.ts alongside the other non-desktop `build*FromSettled`
// siblings.
export function desktopUpdateFields(
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

/**
 * A fallback that can install an older build is safe only when all local
 * discovery paths agree that Codex Desktop is absent. A start-menu entry or a
 * running packaged process is enough to block it when Appx enumeration could
 * not return version metadata.
 */
export function canAttemptCodexDesktopFirstInstallFallback(
  installedPackage: CodexDesktopPackageEntry | null,
  startApp: StartAppEntry | null,
  processes: WindowsProcessEntry[],
): boolean {
  return installedPackage === null && startApp === null && processes.length === 0
}

/**
 * Maps the injected macOS detector's settled result onto DesktopAppStatus.
 * inspectMacosCodexApp is itself designed to never throw and to already
 * distinguish "confirmed absent" from "could not confirm" via `detectionFailed`
 * (see macos-codex-app.ts), but the detector is caller-injectable
 * (`CodexDesktopServiceOptions.detectMacosCodexApp`), so a substitute that
 * does throw — as system-service.test.ts's darwin fixtures do to simulate
 * this exact failure — must still degrade to `detectionFailed: true` rather
 * than being misread as a confirmed "not installed".
 */
export function buildCodexDesktopDarwinStatus(
  result: PromiseSettledResult<MacosCodexAppInspection>,
): DesktopAppStatus {
  const inspection: MacosCodexAppInspection = result.status === 'fulfilled'
    ? result.value
    : { app: null, detectionFailed: true, detectionError: describeProbeFailure(result.reason) }
  const { app, detectionFailed, detectionError } = inspection
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
    detectionFailed,
    detectionError,
    ...desktopUpdateFields('skipped', null, null),
  }
}

export interface CodexDesktopServiceOptions {
  platform: NodeJS.Platform
  windowsExecutionMode: WindowsCliExecutionMode
  installationQueue: InstallationQueue
  createInstallTemporaryDirectory: (
    label: string,
    options?: { baseDirectory?: string },
  ) => Promise<string>
  detectMacosCodexApp: typeof inspectMacosCodexApp
  resolveVerifiedCliCommand: typeof resolveCliCommand
  executeCommand: typeof runCommand
  codexEnv: NodeJS.ProcessEnv
  store: AppSettingsStore
  inspectNativeProviderConfig: (provider: ProviderId) => NativeConfigInspection
  spawnDetached: (
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean },
  ) => Promise<void>
  /** Optional seams used by tests; production uses the constrained CDP module. */
  activateCodexDesktopWithCdp?: typeof activateCodexDesktopWithCdpDefault
  getAvailableLoopbackPort?: typeof getAvailableLoopbackPortDefault
  injectCodexDesktopChineseLocale?: typeof injectCodexDesktopChineseLocaleDefault
}

export interface CodexDesktopLaunchOptions {
  /** Enables the short-lived loopback CDP locale patch for a Chinese restart. */
  injectChinese?: boolean
}

export interface CodexDesktopService {
  inspectCodexDesktop(): Promise<DesktopAppStatus>
  inspectCodexDesktopUpdate(forceRefresh?: boolean): Promise<DesktopAppStatus>
  installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult>
  uninstallCodexDesktop(): Promise<ToolUninstallResult>
  launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
    launchOptions?: CodexDesktopLaunchOptions,
  ): Promise<CodexDesktopLaunchResult>
}

/**
 * Owns the two version-probe caches and the install/uninstall/launch busy
 * lock that the 12 Codex Desktop orchestration functions below share. All
 * dependencies on the host `createSystemService` closure (the CLI-launch
 * trust boundary, the settings store, the shared installation queue) are
 * passed in explicitly rather than recreated here, so this factory has no
 * defaults of its own to keep in sync with `SystemServiceOptions`.
 */
export function createCodexDesktopService(options: CodexDesktopServiceOptions): CodexDesktopService {
  const {
    platform,
    windowsExecutionMode,
    installationQueue,
    createInstallTemporaryDirectory,
    detectMacosCodexApp,
    resolveVerifiedCliCommand,
    executeCommand,
    codexEnv,
    store,
    inspectNativeProviderConfig,
    spawnDetached,
    activateCodexDesktopWithCdp = activateCodexDesktopWithCdpDefault,
    getAvailableLoopbackPort = getAvailableLoopbackPortDefault,
    injectCodexDesktopChineseLocale = injectCodexDesktopChineseLocaleDefault,
  } = options
  let codexDesktopInstalling = false
  let codexDesktopManifestCache: {
    expiresAt: number
    value: DesktopManifestProbeBundle
  } | null = null
  let codexDesktopManifestProbePromise: Promise<DesktopManifestProbeBundle> | null = null
  let codexDesktopManifestGeneration = 0

  function invalidateCodexDesktopManifestCache(): void {
    codexDesktopManifestCache = null
    codexDesktopManifestGeneration += 1
    codexDesktopManifestProbePromise = null
  }

  async function inspectCodexDesktopManifestBundle(): Promise<DesktopManifestProbeBundle> {
    if (codexDesktopManifestCache && codexDesktopManifestCache.expiresAt > Date.now()) {
      return codexDesktopManifestCache.value
    }
    if (codexDesktopManifestProbePromise) return codexDesktopManifestProbePromise

    const generation = codexDesktopManifestGeneration
    const pending = (async (): Promise<DesktopManifestProbeBundle> => {
      const checkedAt = new Date().toISOString()
      if (process.arch !== 'x64' && process.arch !== 'arm64') {
        const error = `Codex Desktop 更新源不支持当前处理器架构 ${process.arch}`
        const value: DesktopManifestProbeBundle = {
          latest: {
            status: 'failed',
            version: null,
            source: 'official-manifest',
            checkedAt,
            error,
          },
          mirror: { version: null, checkedAt, error },
          mirrorCandidate: null,
          mirrorCandidates: [],
        }
        if (generation === codexDesktopManifestGeneration) {
          codexDesktopManifestCache = {
            expiresAt: Date.now() + codexDesktopLatestFailureCacheTtlMs,
            value,
          }
        }
        return value
      }

      const result = await probeCodexDesktopManifests(process.arch)
      const latestCandidate = selectLatestCodexDesktopManifestCandidate(result.candidates)
      const mirrorCandidates = rankCodexDesktopMirrorCandidates(result.candidates)
      const mirrorCandidate = mirrorCandidates[0] ?? null
      const mirrorErrors = result.errors.filter((error) => !error.startsWith('OpenAI 官方源：'))
      const value: DesktopManifestProbeBundle = {
        latest: latestCandidate
          ? {
              status: 'checked',
              version: latestCandidate.version,
              source: 'official-manifest',
              checkedAt,
              error: null,
            }
          : {
              status: 'failed',
              version: null,
              source: 'official-manifest',
              checkedAt,
              error: result.errors.join('；') || 'Codex Desktop 版本查询失败',
            },
        mirror: mirrorCandidate
          ? { version: mirrorCandidate.version, checkedAt, error: null }
          : {
              version: null,
              checkedAt,
              error: mirrorErrors.join('；') || '国内镜像版本查询失败',
        },
        mirrorCandidate,
        mirrorCandidates,
      }
      if (generation === codexDesktopManifestGeneration) {
        const ttl = result.errors.length === 0
          ? codexDesktopLatestCacheTtlMs
          : codexDesktopLatestFailureCacheTtlMs
        codexDesktopManifestCache = { expiresAt: Date.now() + ttl, value }
      }
      return value
    })()
    codexDesktopManifestProbePromise = pending
    try {
      return await pending
    } finally {
      if (codexDesktopManifestProbePromise === pending) codexDesktopManifestProbePromise = null
    }
  }

  async function inspectCodexDesktopLatestVersion(): Promise<DesktopLatestVersionProbe> {
    return (await inspectCodexDesktopManifestBundle()).latest
  }

  async function inspectCodexDesktopMirrorVersion(): Promise<DesktopMirrorVersionProbe> {
    return (await inspectCodexDesktopManifestBundle()).mirror
  }

  async function inspectCodexDesktop(): Promise<DesktopAppStatus> {
    if (platform === 'darwin') {
      // A local application inspection failure must not block the system
      // scan, but it also must not silently read as "not installed" — see
      // buildCodexDesktopDarwinStatus.
      const [result] = await Promise.allSettled([detectMacosCodexApp()])
      return buildCodexDesktopDarwinStatus(result)
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
    const [matchResult, processesResult, packageResult, mirrorResult] = await Promise.allSettled([
      findCodexDesktopStartApp(),
      listCodexDesktopProcesses(),
      inspectCodexDesktopPackage(),
      inspectCodexDesktopMirrorVersion(),
    ])
    // 四个子探测彼此独立；任一异常都不应连累其余三个已知结果
    const {
      match,
      processes,
      packageProbe,
      mirrorProbe,
      detectionFailed,
      detectionError,
    } = buildCodexDesktopWindowsProbes(matchResult, processesResult, packageResult, mirrorResult)
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
        detectionFailed,
        detectionError,
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
      detectionFailed,
      detectionError,
      ...update,
    }
  }

  function sendCodexDesktopInstallProgress(
    target: RendererMessageTarget,
    progress: CodexDesktopInstallProgress,
  ): void {
    if (!target.isDestroyed()) target.send('desktop:codex-install-progress', progress)
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

    const [currentProbe, startApp, runningProcesses] = await Promise.all([
      inspectCodexDesktopPackage(),
      findCodexDesktopStartApp(),
      listCodexDesktopProcesses(),
    ])
    if (currentProbe.error) throw new Error(currentProbe.error)
    const currentPackage = currentProbe.value
    const firstInstall = canAttemptCodexDesktopFirstInstallFallback(currentPackage, startApp, runningProcesses)
    if (!firstInstall && !currentPackage) {
      throw new Error('已检测到 Codex Desktop，但无法读取已安装版本，请先重新检测环境')
    }
    const previousVersion = currentPackage?.version ?? null
    invalidateCodexDesktopManifestCache()
    const manifestBundle = await inspectCodexDesktopManifestBundle()
    const mirrorCandidates = manifestBundle.mirrorCandidates
    const mirrorCandidate = mirrorCandidates[0] ?? null
    const newestRelease = mirrorCandidate?.release ?? null
    let previousCandidatesLoaded = false
    let installCandidates: CodexDesktopManifestCandidate[]
    if (!newestRelease) {
      if (!firstInstall) {
        throw new Error(manifestBundle.mirror.error ?? '国内镜像暂时没有可安装的 Codex Desktop 版本')
      }
      const previousProbe = await fetchCodexDesktopPreviousManifestCandidates(architecture)
      installCandidates = previousProbe.candidates
      previousCandidatesLoaded = true
      if (!installCandidates.length) {
        const detail = previousProbe.errors.join('；') || '没有可验证的上一版本清单'
        throw new Error(`当前镜像暂时不可用，上一版本也无法获取（${detail}），请使用微软商店完成首次安装`)
      }
      sendCodexDesktopInstallProgress(target, {
        phase: 'downloading',
        percent: 0,
        message: '当前镜像不可用，正在尝试 Codex Desktop 上一版本（0%）',
      })
    } else {
      if (firstInstall) {
        installCandidates = mirrorCandidates
      } else {
        // `firstInstall === false` is derived from this same value, but keep
        // the explicit guard so future refactors cannot pass null to the
        // version comparator.
        if (!previousVersion) throw new Error('无法读取已安装的 Codex Desktop 版本')
        installCandidates = mirrorCandidates.filter((candidate) => {
          const comparison = compareWindowsPackageVersions(previousVersion, candidate.version)
          return comparison !== null && comparison < 0
        })
      }
    }
    if (previousVersion && newestRelease) {
      const comparison = compareWindowsPackageVersions(previousVersion, newestRelease.version)
      if (comparison === null) {
        throw new Error(`无法比较已安装版本 ${previousVersion} 与镜像版本 ${newestRelease.version}`)
      }
      if (comparison >= 0) {
        const latest = manifestBundle.latest
        const latestComparison = latest.version
          ? compareWindowsPackageVersions(newestRelease.version, latest.version)
          : null
        const mirrorLagNotice = latestComparison === -1
          ? `；国内镜像当前仅提供 ${newestRelease.version}，微软商店官方最新为 ${latest.version}，可前往微软商店更新`
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
            : `当前 Codex Desktop ${previousVersion} 高于国内镜像版本 ${newestRelease.version}，无需更新${mirrorLagNotice}`,
        })
        return result
      }
    }

    const temporaryDirectory = await createInstallTemporaryDirectory('codex-desktop')
    const packagePath = path.join(temporaryDirectory, `ChatGPT-${architecture}.msix`)
    try {
      const downloadWithProgress = (
        candidates: CodexDesktopManifestCandidate[],
      ): Promise<CodexDesktopCandidateDownloadResult> => downloadCodexDesktopPackageFromCandidates(candidates, packagePath, {
        onAttempt: (candidate, attemptIndex, previousFailure) => {
          const release = candidate.release
          const source = candidate.packageSource
          if (!release || !source) return
          const fallbackNotice = attemptIndex > 0 && previousFailure
            ? `前一路镜像未通过校验，正在切换${source.label}`
            : `正在从${source.label}下载`
          sendCodexDesktopInstallProgress(target, {
            phase: 'downloading',
            percent: 0,
            message: `${fallbackNotice} Codex Desktop ${release.version}（0%）`,
          })
        },
        onProgress: (candidate, { percent }) => {
          const release = candidate.release
          const source = candidate.packageSource
          if (!release || !source) return
          sendCodexDesktopInstallProgress(target, {
            phase: 'downloading',
            percent,
            message: `正在从${source.label}下载 Codex Desktop ${release.version}（${percent}%）`,
          })
        },
        validatePackage: async (candidate) => {
          const release = candidate.release
          const source = candidate.packageSource
          if (!release || !source) throw new Error('镜像候选缺少安装元数据')
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
              `安装包版本 ${metadata.version} 与${source.label}清单版本 ${release.version} 不一致`,
            )
          }
        },
      })
      let selected: CodexDesktopCandidateDownloadResult
      try {
        selected = await downloadWithProgress(installCandidates)
      } catch (error) {
        if (!firstInstall) throw error
        if (previousCandidatesLoaded) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`上一版本安装包下载或校验失败（${detail}），请使用微软商店完成首次安装`)
        }
        sendCodexDesktopInstallProgress(target, {
          phase: 'downloading',
          percent: 0,
          message: '当前版本镜像下载失败，正在尝试 Codex Desktop 上一版本（0%）',
        })
        const previousProbe = await fetchCodexDesktopPreviousManifestCandidates(architecture)
        if (!previousProbe.candidates.length) {
          const detail = previousProbe.errors.join('；') || '没有可验证的上一版本清单'
          const currentDetail = error instanceof Error ? error.message : String(error)
          throw new Error(`当前版本和上一版本均无法获取（当前版本：${currentDetail}；上一版本：${detail}），请使用微软商店完成首次安装`)
        }
        try {
          selected = await downloadWithProgress(previousProbe.candidates)
        } catch (previousError) {
          const currentDetail = error instanceof Error ? error.message : String(error)
          const previousDetail = previousError instanceof Error ? previousError.message : String(previousError)
          throw new Error(`当前版本和上一版本均安装失败（当前版本：${currentDetail}；上一版本：${previousDetail}），请使用微软商店完成首次安装`)
        }
      }
      const release = selected.candidate.release
      if (!release) throw new Error('镜像候选缺少安装元数据')

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
      invalidateCodexDesktopManifestCache()
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
      // Add-AppxPackage can keep a handle to the MSIX briefly after it has
      // completed. Waiting for Defender/WindowsApps to release that handle
      // blocks the IPC promise even though installation already succeeded.
      // Reclaim the temporary payload in the background so the onboarding
      // flow can advance immediately; a later launch will clean any residue.
      void fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
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
      invalidateCodexDesktopManifestCache()
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
      invalidateCodexDesktopManifestCache()
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
    launchOptions: CodexDesktopLaunchOptions = {},
  ): Promise<CodexDesktopLaunchResult> {
    if (codexDesktopInstalling) throw new Error('Codex 桌面端正在安装、更新或卸载中，请稍后再试')
    if (platform === 'darwin' && mode === 'restart') {
      throw new Error('macOS 不支持重启 Codex，请使用打开操作唤起现有应用')
    }
    const nativeConfig = inspectNativeProviderConfig('codex')
    if (!canLaunchManagedProvider(nativeConfig, 'codex')) {
      throw new Error(managedProviderLaunchBlockedMessage('codex'))
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
    const desktopAppPath = desktopApp.path

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

    const launchWithExplorer = async (): Promise<void> => {
      const launchPlan = buildCodexDesktopLaunchPlan(desktopAppPath)
      await spawnDetached(launchPlan.executable, launchPlan.args, {
        cwd: launchPlan.cwd,
        env: launchPlan.env,
        windowsHide: launchPlan.windowsHide,
      })
    }
    let cdpPort: number | null = null
    let activationProcessId: number | null = null
    const shouldInjectChinese = Boolean(launchOptions.injectChinese)
      && (mode === 'restart' || existingProcesses.length === 0)
    if (shouldInjectChinese) {
      try {
        cdpPort = await getAvailableLoopbackPort()
        activationProcessId = await activateCodexDesktopWithCdp(desktopAppPath, cdpPort)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // AppX activation arguments are not stable across Windows builds. The
        // existing Explorer path remains the safe fallback and still benefits
        // from the persisted config.toml locale override.
        console.warn(`[codex-locale] CDP 增强启动不可用，回退 Explorer：${message}`)
        cdpPort = null
        try {
          await launchWithExplorer()
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          throw new Error(`无法发送 Codex 桌面端启动请求：${fallbackMessage}`)
        }
      }
    } else {
      try {
        await launchWithExplorer()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`无法发送 Codex 桌面端启动请求：${message}`)
      }
    }

    let startedProcesses = await waitForCodexDesktopState(
      true,
      cdpPort !== null ? codexDesktopLaunchInitialWaitMs : codexDesktopLaunchFallbackWaitMs,
    )
    if (!startedProcesses.length && cdpPort !== null) {
      // COM activation can be unavailable for a per-user Store registration
      // while Explorer still knows how to activate the package. Retry through
      // the original path before reporting a launch failure.
      cdpPort = null
      try {
        await launchWithExplorer()
        startedProcesses = await waitForCodexDesktopState(true, codexDesktopLaunchFallbackWaitMs)
      } catch {
        // The common error below includes the same actionable launch context.
      }
    }
    // AppX activation returns the application PID even when WMI is slow or
    // temporarily unable to expose the packaged executable path. Treat a
    // still-alive activation PID as a successful launch; later status scans
    // can recover the full package metadata once Windows finishes indexing.
    if (!startedProcesses.length && activationProcessId !== null) {
      if (await waitForProcessId(activationProcessId, 2_000)) {
        startedProcesses = [{
          processId: activationProcessId,
          parentProcessId: 0,
          name: 'Codex.exe',
          executablePath: desktopApp.installDirectory
            ? path.join(desktopApp.installDirectory, 'app', 'ChatGPT.exe')
            : '',
        }]
      }
    }
    if (!startedProcesses.length) {
      const launchContext = await inspectCodexDesktopWindowsLaunchContext()
      throw new Error(describeCodexDesktopLaunchFailure(launchContext))
    }
    if (cdpPort !== null) {
      try {
        const injection = await injectCodexDesktopChineseLocale(cdpPort)
        console.info(`[codex-locale] 已注入 Codex Desktop 中文运行时补丁（${injection.injectedTargets} 个页面）`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A failed enhancement must not leave a successfully launched client
        // looking broken. config.toml remains authoritative for future builds.
        console.warn(`[codex-locale] 中文运行时补丁未生效，保留已启动客户端：${message}`)
      }
    }
    const runningStatus = { ...desktopApp, running: true }
    sendCodexDesktopStatus(target, 'running', runningStatus)
    return { restarted, status: runningStatus }
  }

  return {
    inspectCodexDesktop,
    inspectCodexDesktopUpdate,
    installCodexDesktop,
    uninstallCodexDesktop,
    launchCodexDesktop,
  }
}
