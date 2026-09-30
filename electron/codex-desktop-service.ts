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
  selectCodexDesktopProcessesForPackage,
  stableInstallFamilyName,
  stopCodexDesktopProcesses,
  type CodexDesktopMirrorRelease,
  type CodexDesktopPackageEntry,
  type CodexDesktopPackageMetadata,
  type StartAppEntry,
  type WindowsProcessEntry,
} from './codex-desktop'
import {
  CommandRunnerError,
  trustedCommandEnvironment,
  windowsSystemExecutable,
  type CommandSpec,
  type runCommand,
} from './command-runner'
import {
  canLaunchManagedProvider,
  managedProviderLaunchBlockedMessage,
  type NativeConfigInspection,
} from './config-files'
import type { InstallationQueue } from './installation-queue'
import {
  InstallCancellationRegistry,
  InstallCancelledError,
  isInstallCancelledError,
  type InstallCancellationHandle,
  type InstallCancellationOutcome,
} from './install-cancellation'
import { buildMacosCodexAppLaunchPlan, probeMacosCodexRunning, type inspectMacosCodexApp, type MacosCodexAppInspection } from './macos-codex-app'
import { resolveSystemWingetExecutable, type SystemWingetResolution } from './node-runtime'
import { describeProbeFailure } from './probe-failure'
import { downloadWithResume, DownloadStalledError, type ResumableDownloadOptions } from './download-retry'
import { resolveWindowsExplorerExecutable } from './system-shell'
import {
  activateCodexDesktop as activateCodexDesktopDefault,
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
import { powerShellLiteral, resolveWindowsPowerShellExecutable } from './windows-elevation'
import { resolveWindowsMachinePaths } from './windows-machine-paths'
import { repairCodexDesktopGlobalState } from './codex-desktop-state'
import { addCodexDesktopPackage } from './codex-desktop-appx'
import {
  buildCodexDesktopInstallFailureMessage,
  classifyCodexDesktopInstallFailure,
  codexDesktopNoStoreNotice,
  codexDesktopTechnicalWords,
  isCodexDesktopInstallFailureMessage,
  isPlainCodexDesktopInstallMessage,
  type CodexDesktopInstallFailureReason,
} from './codex-desktop-install-failure'
import { codexDesktopKnownIssueLaunchSentence, resolveCodexDesktopKnownIssue } from './codex-desktop-known-issues'
import {
  buildPowerShellModuleImportStatement,
  inspectWindowsStoreAppLaunchContext,
  inspectWindowsStoreAvailability,
  readWindowsStoreAppLaunchContext,
  resolveStoreAppLaunchBlock,
  windowsStoreAppLaunchContextStatements,
  type StoreAppLaunchBlock,
  type WindowsStoreAppLaunchContext,
} from './windows-store-app-launch'

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
// 与官方版本清单里登记的 storeProductId 是同一个（parseCodexDesktopUpdateManifest 钉住）。
const codexDesktopStoreProductId = '9PLM9XGG6VKS'
const codexDesktopStoreInstallTimeoutMs = 15 * 60_000
const maximumCodexDesktopRedirects = 2
const minimumCodexDesktopPackageBytes = 10 * 1024 * 1024
const maximumCodexDesktopPackageBytes = 1_500 * 1024 * 1024
const maximumCodexDesktopManifestBytes = 1024 * 1024
const maximumCodexDesktopAppManifestBytes = 512 * 1024
const codexDesktopManifestRefreshParameter = 'xm_refresh'
const codexDesktopInstallKey = 'desktop:codex:install'
// 下载可以随时丢掉，Add-AppxPackage 不行：它中途被杀会留下一个装了一半的包，
// 之后既打不开也更新不了。这是拒绝取消时给用户看的原因。
const codexDesktopInstallSealReason = '正在安装 Codex 桌面端，这一步中断会留下装了一半的程序，请等它结束。'
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

// 判断本身在 windows-store-app-launch.ts，装之前的提醒（检查页、首页）用的是同一份。
export type CodexDesktopWindowsLaunchContext = WindowsStoreAppLaunchContext

// 客户会原样看到这几句话（失败对话框把后端原话放在最下面），所以只说他看得懂、
// 做得到的事。以前这里写着 wsreset.exe、AppModel、AppX、UAC，客户既不知道那是
// 什么，照着跑 wsreset 也几乎从来没用——它只清应用商店的缓存，不管已经装好的
// 程序为什么没起来。渲染层按开头那半句归类（operation-error.ts 的
// codexDesktopNotStarted），改开头要两边一起改。
export const codexDesktopNotStartedPrefix = 'Codex 桌面端没有打开'

/**
 * 失败时这一次到底等了多久、Codex 有没有被 Windows 拉起来过。缺省 = 旧的那句
 * 「等了将近一分钟」（调用方拿不到计时时照旧）。
 */
export interface CodexDesktopLaunchWaitOutcome {
  waitedSeconds: number
  /** Windows 交回过 Codex 的进程号，说明它起过、只是没等到窗口。 */
  processSeen: boolean
}

export function describeCodexDesktopLaunchFailure(
  context: CodexDesktopWindowsLaunchContext,
  outcome?: CodexDesktopLaunchWaitOutcome,
  knownIssueVersion?: string | null,
): string {
  const block = resolveStoreAppLaunchBlock(context)
  if (block === 'builtInAdministrator') {
    return `${codexDesktopNotStartedPrefix}：这台电脑正用 Windows 自带的「Administrator」账户登录，`
      + 'Windows 常常不让这个账户打开从应用商店装的软件。换一个普通账户登录电脑，再从星芒打开 Codex。'
  }
  if (block === 'uacDisabled') {
    return `${codexDesktopNotStartedPrefix}：这台电脑关掉了 Windows 的「用户账户控制」，`
      + 'Windows 在这种设置下常常打不开从应用商店装的软件。请联系客服，帮你把它打开后再试。'
  }
  // 装着的正是已知打不开的那一版：不用再叫客户去开始菜单自己分辨是谁的问题，
  // 直接说清楚，并给命令行版这条路（第十九批 7）。账户设置那两种更具体，先说它们。
  if (knownIssueVersion) {
    const waited = outcome
      ? `等了 ${outcome.waitedSeconds} 秒，${outcome.processSeen ? 'Codex 已经启动，但它的窗口一直没出来' : 'Codex 没有启动起来'}。`
      : '等了将近一分钟，没有等到它的窗口。'
    return `${codexDesktopNotStartedPrefix}：${waited}${codexDesktopKnownIssueLaunchSentence(knownIssueVersion)}`
  }
  if (!outcome) {
    return `${codexDesktopNotStartedPrefix}：等了将近一分钟，没有等到它的窗口。`
      + '先关掉所有 Codex 窗口，再点「重试」；还是不行，就在开始菜单里搜「Codex」直接点开，也打不开的话请联系客服。'
  }
  // 客户自己分不清是 Codex 起不来还是星芒没叫动它，只会一直点重试或找客服。
  // 从开始菜单直接开一次就能分清：那边也起不来，就是 Codex 这一版自己的问题。
  const what = outcome.processSeen
    ? 'Codex 已经启动，但它的窗口一直没出来'
    : 'Codex 没有启动起来'
  return `${codexDesktopNotStartedPrefix}：等了 ${outcome.waitedSeconds} 秒，${what}。`
    + '先关掉所有 Codex 窗口，再点「重试」。想知道是不是 Codex 自己的问题：在开始菜单里搜「Codex」直接点开，'
    + '也起不来的话就是 Codex 这一版自己的问题，不是星芒，可以等微软商店更新它，或先用 Codex CLI；'
    + '开始菜单里能打开、从星芒打不开，请联系客服。'
}

// 一键重置做不成时，客户自己在系统设置里点的是同一个按钮。
const codexDesktopResetManualHint = '没能自动重置 Codex 桌面端。可以自己重置：打开 Windows「设置 → 应用 → 已安装的应用」，'
  + '找到 Codex，点右边的「…」→「高级选项」→「重置」，再回星芒打开。'

/**
 * Reset-AppxPackage is the cmdlet behind Settings' "Reset" button: it deletes
 * the package's own per-user data (LocalState, caches) and leaves the install
 * and everything outside the package folder — ~/.codex, where the relay
 * configuration lives — untouched. The package name comes from the verified
 * Get-AppxPackage probe and is still passed as a literal, never interpolated.
 */
export function buildCodexDesktopResetScript(packageFullName: string): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "Stop"',
    `Reset-AppxPackage -Package ${powerShellLiteral(packageFullName)}`,
  ].join('; ')
}

/**
 * 重置失败时客户能做的只有一件事：去系统设置里点同一个按钮。Windows 10 2004 以前
 * 没有 Reset-AppxPackage，那种电脑的设置里也有「重置」，所以两种失败给同一个出口。
 */
export function describeCodexDesktopResetFailure(error: unknown): string {
  const record = error && typeof error === 'object' ? error as { killed?: unknown } : {}
  if (record.killed === true) return `重置 Codex 桌面端等了两分钟还没做完。${codexDesktopResetManualHint}`
  return codexDesktopResetManualHint
}

/** 等窗口满这么久还没出来，就多提一句「先去开始菜单看看」。 */
const codexDesktopLaunchStartMenuHintSeconds = 20

/**
 * 打开桌面端途中每隔几秒给客户看的那句话。以前这段最长近一分钟，界面上只有
 * 「打开中」三个字，客户不知道在等什么、还要等多久。
 */
export function describeCodexDesktopLaunchWait(
  stage: CodexDesktopLaunchWaitStage,
  elapsedSeconds: number,
): string {
  if (stage === 'preparing') return `正在准备打开 Codex 桌面端，已经等了 ${elapsedSeconds} 秒。`
  const head = `正在等 Codex 桌面端的窗口出现，已经等了 ${elapsedSeconds} 秒。Codex 第一次打开有时要一分钟`
  return elapsedSeconds >= codexDesktopLaunchStartMenuHintSeconds
    ? `${head}，可以先去开始菜单看看它有没有弹出来。`
    : `${head}。`
}

export type CodexDesktopLaunchWaitStage = 'preparing' | 'waiting-window'

export interface CodexDesktopLaunchProgress {
  elapsedSeconds: number
  message: string
}

export interface CodexDesktopLaunchHeartbeat {
  setStage: (stage: CodexDesktopLaunchWaitStage) => void
  elapsedSeconds: () => number
  stop: () => void
}

export const codexDesktopLaunchHeartbeatIntervalMs = 5_000

/**
 * 打开途中按固定间隔报一次「等了多久」。只报进度，不碰超时本身；stop 之后
 * 再也不发，免得失败框弹出来之后工具行又冒出一句「还在等」。
 */
export function startCodexDesktopLaunchHeartbeat(
  report: (progress: CodexDesktopLaunchProgress) => void,
  options: { intervalMs?: number; now?: () => number } = {},
): CodexDesktopLaunchHeartbeat {
  const now = options.now ?? Date.now
  const startedAt = now()
  let stage: CodexDesktopLaunchWaitStage = 'preparing'
  let stopped = false
  function elapsedSeconds(): number {
    return Math.max(0, Math.round((now() - startedAt) / 1000))
  }
  const timer = setInterval(() => {
    if (stopped) return
    const elapsed = elapsedSeconds()
    report({ elapsedSeconds: elapsed, message: describeCodexDesktopLaunchWait(stage, elapsed) })
  }, options.intervalMs ?? codexDesktopLaunchHeartbeatIntervalMs)
  timer.unref?.()
  return {
    setStage(next) { stage = next },
    elapsedSeconds,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
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

/**
 * Builds the official Codex Desktop deep link used by `codex app <path>` on
 * Windows. Opening only `shell:AppsFolder\...` starts the app without a
 * workspace, which leaves the Desktop permission picker disabled because the
 * conversation has no project context.
 */
export function buildCodexDesktopWorkspaceUrl(workspace: string): string {
  // Keep the path byte-for-byte as selected. Windows permits a trailing space
  // in a directory name when it is addressed through the extended path form;
  // trimming here would silently open a different workspace.
  const normalized = workspace
  if (
    !normalized.trim()
    || normalized.includes('\0')
    || normalized.length > 32_767
    || !path.win32.isAbsolute(normalized)
  ) {
    throw new Error('Codex Desktop 工作目录无效')
  }
  const url = new URL('codex://threads/new')
  url.searchParams.set('path', normalized)
  return url.href
}

/**
 * Builds the legacy Explorer plan for callers that only need to inspect the
 * encoded URL. Runtime launches must use AppModel activation directly; passing
 * this plan to Explorer can open the workspace folder when codex:// is not
 * registered by the installed package.
 */
export function buildCodexDesktopWorkspaceLaunchPlan(
  appUserModelId: string,
  workspace: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): CodexDesktopLaunchPlan {
  const plan = buildCodexDesktopLaunchPlan(appUserModelId, baseEnv)
  return {
    ...plan,
    args: [buildCodexDesktopWorkspaceUrl(workspace)],
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
  /** 网络断了一下、正要在同一条线路上接着下时为 true。 */
  resuming?: boolean
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

/**
 * 微软商店是 Codex 桌面端唯一的官方发行渠道，所以先交给系统自带的 winget 从商店装；
 * 装不上再退到国内镜像。winget 的路径只能来自 resolveSystemWingetExecutable
 * 校验过的 App Installer 包目录，这里再拦一次明显不对的值。
 */
export function buildCodexDesktopStoreInstallCommand(executable: string): CommandSpec {
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
      codexDesktopStoreProductId,
      '--exact',
      '--source',
      'msstore',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ],
  }
}

/** 把商店这一路失败的原因说成客户看得懂的半句话，放进「微软商店这次没装上（…）」。 */
export function describeCodexDesktopStoreFailure(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) return '安装没有完成'
  if (error.code === 'TIMED_OUT') return '等了很久还没装完'
  const exitCode = error.exitCode === null ? null : error.exitCode >>> 0
  if (exitCode === null) return '安装没有完成'
  // WinINet timeout, name resolution, connection and connection-reset failures.
  if ([0x80072ee2, 0x80072ee7, 0x80072efd, 0x80072efe, 0x80072eff].includes(exitCode)) return '连不上微软商店'
  // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE：商店那边还没有比本机更新的版本。
  if (exitCode === 0x8a15002b) return '商店里暂时还没有更新的版本'
  // APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND：这台电脑所在地区的商店查不到它。
  if (exitCode === 0x8a150014) return '商店里没找到 Codex 桌面端'
  // 认不出的退出码不上屏（客户看了也不知道做什么），原样进日志：见 codexDesktopStoreExitCode。
  return '商店那边没说原因'
}

/** 商店那一路的原始退出码，只写进日志，客服查的时候用。 */
export function codexDesktopStoreExitCode(error: unknown): string | null {
  if (!(error instanceof CommandRunnerError) || error.exitCode === null) return null
  return `0x${(error.exitCode >>> 0).toString(16)}`
}

/**
 * 商店那一路常常几分钟没有一行输出，进度条停在原地和卡死看上去一模一样。
 * 心跳按这个间隔把「已经等了多久」说出来，用户才知道该等还是该关。
 */
export const codexDesktopStoreHeartbeatMs = 15_000
// 离超时只剩这么久时改口成「最多再等 X 分钟」，让用户知道等待是有头的。
const codexDesktopStoreDeadlineNoticeMs = 3 * 60_000

// system-service 已经 import 本模块，反过来 import 它的 formatElapsedDuration
// 会成环，所以这里留一份同样写法的。
function formatCodexDesktopStoreElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

/**
 * 商店安装期间给用户看的那一行。只说大白话：不出现商店安装组件、软件源这些名字。
 * 超时后会自动换国内下载线路，所以临近超时时说「最多再等」而不是「失败」。
 */
export function buildCodexDesktopStoreWaitMessage(
  elapsedMs: number,
  percent: number | null,
  timeoutMs: number = codexDesktopStoreInstallTimeoutMs,
): string {
  const progress = percent === null ? '' : `（${percent}%）`
  if (elapsedMs < codexDesktopStoreHeartbeatMs) {
    return `正在从微软商店下载安装 Codex 桌面端${progress}，要等几分钟，请别关窗口`
  }
  const remainingMs = timeoutMs - elapsedMs
  if (remainingMs <= codexDesktopStoreDeadlineNoticeMs) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
    return `还在等微软商店${progress}，最多再等 ${minutes} 分钟；还不行星芒会自动换国内下载线路接着装，请别关窗口`
  }
  return `正在从微软商店下载安装 Codex 桌面端${progress}，已经等了 ${formatCodexDesktopStoreElapsed(elapsedMs)}。`
    + '商店有时要十来分钟，不用管它，请别关窗口'
}

/** 商店输出的进度条里带百分比时取最后一个，取不到就返回 null。 */
export function parseCodexDesktopStoreProgress(text: string): number | null {
  const matches = [...text.matchAll(/(\d{1,3})\s*%/g)]
  const last = matches.at(-1)
  if (!last) return null
  const value = Number(last[1])
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null
}

/**
 * 更新时商店这一路值不值得试：官方清单说有更新的版本，或者官方清单这次没读到
 * （商店本身就是官方源，读不到清单不代表商店没有新版）。
 */
export function shouldTryCodexDesktopStoreUpdate(
  installedVersion: string,
  officialVersion: string | null,
): boolean {
  if (!officialVersion) return true
  const comparison = compareWindowsPackageVersions(installedVersion, officialVersion)
  return comparison === null || comparison < 0
}

export function buildCodexDesktopPackageSources(
  architecture: 'x64' | 'arm64',
): CodexDesktopPackageSource[] {
  return [
    { label: '国内镜像', url: codexDesktopMirrorPackageUrls[architecture] },
    { label: '镜像备用源', url: codexDesktopMirrorFallbackPackageUrls[architecture] },
  ]
}

const codexDesktopPrimaryMirrorLabels = new Set(['国内镜像', '国内镜像上一版本'])

/**
 * 主源清单查询失败时，候选排序会安静地把备用源提到第一位，界面上只剩一句
 * 「正在从镜像备用源下载」。用户据此以为产品本来就不走主源，既看不出主源出了
 * 什么事，也无从判断该不该重试——把探测阶段记下的失败原因带到下载提示里。
 */
export function describeCodexDesktopPrimaryMirrorSkip(
  packageSource: CodexDesktopPackageSource,
  probeErrors: readonly string[],
): string | null {
  if (codexDesktopPrimaryMirrorLabels.has(packageSource.label)) return null
  for (const error of probeErrors) {
    const separator = error.indexOf('：')
    if (separator < 0) continue
    if (!codexDesktopPrimaryMirrorLabels.has(error.slice(0, separator))) continue
    const detail = error.slice(separator + 1).trim()
    // 带着 HTTP 状态码、SHA-256 这类词的原因客户看不懂，只说不可用；原话在清单探测的日志里。
    return detail && !codexDesktopTechnicalWords.test(detail) ? `国内镜像本次不可用（${detail}）` : '国内镜像本次不可用'
  }
  return null
}

/**
 * 一路下载尝试开始时给用户看的那半句话。第一路之后的尝试只可能是前一路没过
 * 校验；第一路就是备用源时，把探测阶段主源的失败原因带上。
 */
export function describeCodexDesktopDownloadAttempt(
  packageSource: CodexDesktopPackageSource,
  attemptIndex: number,
  previousFailure: string | null,
  probeErrors: readonly string[],
  store: string | null | Pick<CodexDesktopInstallAttempt, 'storeFailure' | 'storeUnavailable' | 'storeInstallerMissing'> = null,
): string {
  const storeNotice = describeCodexDesktopStoreNotice(typeof store === 'string' || store === null ? { storeFailure: store } : store)
  if (attemptIndex > 0 && previousFailure) return `${storeNotice}前一路镜像未通过校验，已改从${packageSource.label}下载`
  const primaryMirrorSkip = attemptIndex === 0
    ? describeCodexDesktopPrimaryMirrorSkip(packageSource, probeErrors)
    : null
  return primaryMirrorSkip
    ? `${storeNotice}${primaryMirrorSkip}，正在从${packageSource.label}下载`
    : `${storeNotice}正在从${packageSource.label}下载`
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
  fetchImplementation: typeof fetch,
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
  fetchImplementation: typeof fetch,
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
  fetchImplementation: typeof fetch,
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
  fetchImplementation: typeof fetch,
  cancelSignal?: AbortSignal,
  resumeOptions: Pick<ResumableDownloadOptions, 'wait' | 'idleTimeoutMs'> = {},
): Promise<CodexDesktopDownloadResult> {
  let total = 0
  let lastPercent = -1
  const percentOf = (transferred: number) => Math.min(100, Math.floor((transferred / total) * 100))
  try {
    const download = await downloadWithResume({
      targetPath: destination,
      fileMode: 0o600,
      maximumBytes: maximumCodexDesktopPackageBytes,
      oversizeMessage: `${source.label}返回的数据超过声明的安装包大小`,
      signal: cancelSignal,
      responseTimeoutMs: 20_000,
      idleTimeoutMs: 45_000,
      ...resumeOptions,
      request: (headers, signal) => fetchTrustedCodexDesktopResource(source.url, {
        headers: { Accept: 'application/vnd.ms-appx, application/octet-stream', ...headers },
        signal,
      }, fetchImplementation),
      acceptResponse: (response) => {
        if (!response.ok) throw new Error(`${source.label}返回 HTTP ${response.status}`)
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        if (
          !contentType.includes('application/vnd.ms-appx')
          && !contentType.includes('application/octet-stream')
          && !contentType.includes('binary/octet-stream')
        ) {
          throw new Error(`${source.label}返回的不是 MSIX 文件（Content-Type: ${contentType || '缺失'}）`)
        }
        const declared = Number(response.headers.get('content-length'))
        if (!Number.isSafeInteger(declared) || declared < minimumCodexDesktopPackageBytes) {
          throw new Error(`${source.label}返回的安装包大小无效`)
        }
        if (declared > maximumCodexDesktopPackageBytes) {
          throw new Error(`${source.label}返回的安装包超过 1.5 GB 安全上限`)
        }
        if (
          source.expectedContentLength !== undefined
          && declared !== source.expectedContentLength
        ) {
          throw new Error(
            `${source.label}返回的 Content-Length 与镜像清单不一致：应为 ${source.expectedContentLength} 字节，实际 ${declared} 字节`,
          )
        }
        if (!response.body) throw new Error(`${source.label}未返回安装包内容`)
        total = declared
        return declared
      },
      onProgress: (transferred) => {
        const percent = percentOf(transferred)
        if (percent === lastPercent) return
        lastPercent = percent
        onProgress({ transferred, total, percent })
      },
      onResume: (transferred) => {
        onProgress({ transferred, total, percent: percentOf(transferred), resuming: true })
      },
    })
    if (download.size !== total) {
      throw new Error(`${source.label}下载不完整：应为 ${total} 字节，实际 ${download.size} 字节`)
    }
    const sha256Base64 = download.sha256.toString('base64')
    if (
      source.expectedSha256Base64 !== undefined
      && sha256Base64 !== source.expectedSha256Base64
    ) {
      throw new Error(`${source.label}安装包 SHA-256 与镜像清单不一致，文件可能已损坏`)
    }
    return { transferred: download.size, total, sha256Base64 }
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined)
    // 取消和超时都会中止这次请求，但用户看到的原因必须分得开：靠 cancelSignal
    // 判断，而不是把两者都说成「下载超时」。reason 兜一层：本函数是导出的，调用方
    // 给的信号不一定带 reason，少了这一层就会 throw undefined。
    if (cancelSignal?.aborted) throw cancelSignal.reason ?? new InstallCancelledError()
    if (
      error instanceof DownloadStalledError
      || (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new Error(`${source.label}连接或下载超时`)
    }
    throw error
  }
}

export interface CodexDesktopCandidateDownloadResult {
  candidate: CodexDesktopManifestCandidate
  download: CodexDesktopDownloadResult
}

export interface CodexDesktopCandidateDownloadOptions {
  /**
   * 必填：主进程全局 fetch 是 Node 的 undici，不读系统代理，而加速只接管系统
   * 代理。默认成全局 fetch 会让镜像下载在开着加速时照样直连，这里留成必填项，
   * 让漏传变成编译错误而不是一条安静走直连的下载。
   */
  fetchImplementation: typeof fetch
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
  /** 用户点「取消」后中止下载，并且不再换下一路镜像重试。 */
  signal?: AbortSignal
}

export async function downloadCodexDesktopPackageFromCandidates(
  candidates: CodexDesktopManifestCandidate[],
  destination: string,
  options: CodexDesktopCandidateDownloadOptions,
): Promise<CodexDesktopCandidateDownloadResult> {
  const ranked = rankCodexDesktopMirrorCandidates(candidates)
  if (!ranked.length) throw new Error('国内镜像暂时没有可安装的 Codex Desktop 版本')

  const failures: string[] = []
  for (const [attemptIndex, candidate] of ranked.entries()) {
    const release = candidate.release
    const packageSource = candidate.packageSource
    if (!release || !packageSource) continue

    options.signal?.throwIfAborted()
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
        options.signal,
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
      // 取消要就地中断：继续 push 失败原因就等于换一路镜像接着下。
      options.signal?.throwIfAborted()
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(`${source.label}（${release.version}）：${detail || '校验失败'}`)
    }
  }

  throw new Error(`所有国内镜像均未通过完整校验：${failures.join('；') || '没有可用镜像'}`)
}

/**
 * The package path is the only outside value in the script, and it only ever
 * appears as a single-quoted PowerShell literal. The manifest's compressed
 * size is checked before anything decompresses or parses it.
 */
export function buildCodexDesktopPackageInspectionScript(packagePath: string): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$archive = [System.IO.Compression.ZipFile]::OpenRead(${powerShellLiteral(packagePath)})`,
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
}

export interface CodexDesktopPackageInspectionDependencies {
  /**
   * Tests stand in for powershell.exe here: its cold start on a busy CI runner
   * outlasted the budget, and what they check is what this module hands it and
   * what it makes of the answer. Production never passes these.
   */
  run?: (
    executable: string,
    argv: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
  ) => Promise<string>
  resolvePowerShell?: () => string
}

async function runPackageInspection(
  executable: string,
  argv: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
): Promise<string> {
  const { stdout } = await execFileAsync(executable, argv, {
    env: options.env,
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
  })
  return stdout
}

export async function inspectCodexDesktopPackageFile(
  packagePath: string,
  dependencies: CodexDesktopPackageInspectionDependencies = {},
): Promise<CodexDesktopPackageMetadata> {
  const run = dependencies.run ?? runPackageInspection
  const stdout = await run((dependencies.resolvePowerShell ?? resolveWindowsPowerShellExecutable)(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    buildCodexDesktopPackageInspectionScript(packagePath),
  ], {
    env: trustedCommandEnvironment(),
    // The first inspection on a machine pays for loading the compression and
    // XML assemblies into a stripped environment, which measurably exceeds 30s
    // on a cold, contended host. Later inspections finish in well under a
    // second. This runs once per package during an install or update the user
    // is already waiting on, so bound it generously rather than failing a
    // healthy package as a timeout.
    timeoutMs: 90_000,
    maxOutputBytes: 1024 * 1024,
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

const codexDesktopProbeScriptHeader = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'

function codexDesktopStartAppsQuery(): string {
  return "@(Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' } | Select-Object Name, AppID)"
}

export async function findCodexDesktopStartApp(): Promise<StartAppEntry | null> {
  const script = [
    codexDesktopProbeScriptHeader,
    `$apps = ${codexDesktopStartAppsQuery()}`,
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

type CodexDesktopProcessScope = 'roots' | 'all'

interface CodexDesktopProcessListOptions {
  processIds?: ReadonlySet<number>
  // Only paths that are about to terminate processes (install, update,
  // uninstall, restart) must fail closed. Status and launch paths keep the
  // old "nothing found" answer so a slow WMI query never breaks 打开.
  strict?: boolean
}

function codexDesktopProcessQuery(scope: CodexDesktopProcessScope, processIds?: ReadonlySet<number>): string {
  const targetIds = processIds
    ? `@(${[...processIds].filter((id) => Number.isSafeInteger(id) && id > 0).join(',')})`
    : '$null'
  // The close paths also take helpers that run from the same package
  // directory (bundled CLI, command runner, ripgrep). Without taskkill /T
  // they would otherwise keep files in the package open during replacement.
  const nameFilter = scope === 'roots' ? " AND (Name='ChatGPT.exe' OR Name='Codex.exe')" : ''
  const ownerTargets = scope === 'roots'
    ? String.raw`$pidFamilies = @{}
      foreach ($candidate in $candidates) { $pidFamilies[[int]$candidate.Process.ProcessId] = $candidate.PackageFamilyName }
      $toCheck = @($candidates | Where-Object {
        (-not $pidFamilies.ContainsKey([int]$_.Process.ParentProcessId)) -or
          ($pidFamilies[[int]$_.Process.ParentProcessId] -ne $_.PackageFamilyName)
      })`
    : '$toCheck = $candidates'
  return String.raw`& {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $targetIds = ${targetIds}
    $candidates = @(Get-CimInstance -ClassName Win32_Process -Filter "SessionId=$currentSessionId${nameFilter}" | ForEach-Object {
      $path = [string]$_.ExecutablePath
      # WMI can omit ExecutablePath for a normal user. The packaged app's
      # command line still carries the immutable WindowsApps path, so recover
      # only a strictly quoted Codex executable rather than trusting a name.
      if (-not $path -and @('ChatGPT.exe', 'Codex.exe') -contains ([string]$_.Name)) {
        $commandLine = [string]$_.CommandLine
        $candidate = [regex]::Match($commandLine, '(?i)"(?<path>[^"]*\\WindowsApps\\OpenAI.Codex(?:Beta)?_[^"]+\\[^"]+.exe)"')
        if ($candidate.Success) { $path = $candidate.Groups['path'].Value }
      }
      $package = [regex]::Match($path, '(?i)\\WindowsApps\\(?<name>OpenAI\.Codex(?:Beta)?)_\d+(?:\.\d+){3}_(?:x64|arm64|neutral)__(?<publisher>[A-Za-z0-9.]+)\\')
      if ($package.Success -and $null -ne $_.SessionId -and $_.SessionId -eq $currentSessionId -and ($null -eq $targetIds -or ($targetIds -contains [int]$_.ProcessId))) {
        $packageFamilyName = $package.Groups['name'].Value + '_' + $package.Groups['publisher'].Value
        [pscustomobject]@{ Process = $_; Path = $path; PackageFamilyName = $packageFamilyName }
      }
    })
    ${ownerTargets}
    @($toCheck | ForEach-Object {
      $candidate = $_
      $process = $candidate.Process
      if ($null -ne $process) {
        $owner = $null
        try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop } catch {}
        # Unknown ownership must never become a taskkill target.
        if ($null -ne $owner -and $owner.ReturnValue -eq 0 -and $owner.Sid -eq $currentSid) {
          [pscustomobject]@{ ProcessId = $process.ProcessId; ParentProcessId = $process.ParentProcessId; Name = $process.Name; ExecutablePath = $candidate.Path; OwnerSid = $owner.Sid; CurrentOwnerSid = $currentSid; SessionId = $process.SessionId; CurrentSessionId = $currentSessionId; PackageFamilyName = $candidate.PackageFamilyName }
        }
      }
    })
  }`
}

export const codexDesktopProcessCheckFailedMessage = '没能确认哪些 Codex 桌面端窗口需要先关掉，请稍等片刻再试'

export function buildCodexDesktopProcessProbeScript(
  scope: CodexDesktopProcessScope = 'roots',
  processIds?: ReadonlySet<number>,
): string {
  return [
    codexDesktopProbeScriptHeader,
    `$items = ${codexDesktopProcessQuery(scope, processIds)}`,
    '$items | ConvertTo-Json -Compress',
  ].join('; ')
}

export async function collectCodexDesktopProcesses(
  runProbe: (script: string, timeoutMs: number) => Promise<string>,
  scope: CodexDesktopProcessScope,
  options: CodexDesktopProcessListOptions,
): Promise<WindowsProcessEntry[]> {
  const script = buildCodexDesktopProcessProbeScript(scope, options.processIds)
  try {
    return parseWindowsProcessesJson(await runProbe(script, scope === 'roots' ? 8_000 : 60_000))
  } catch {
    if (options.strict) throw new Error(codexDesktopProcessCheckFailedMessage)
    return []
  }
}

export async function listCodexDesktopProcesses(
  scope: CodexDesktopProcessScope = 'roots',
  options: CodexDesktopProcessListOptions = {},
): Promise<WindowsProcessEntry[]> {
  if (process.platform !== 'win32') return []

  return collectCodexDesktopProcesses(async (script, timeoutMs) => {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return stdout
  }, scope, options)
}

/**
 * 「打开」只需要知道 Codex 的窗口在不在这个登录会话里，它从不关任何进程。
 *
 * The owner-checked probe above exists so a termination can never reach a
 * process we do not own; it pays one GetOwnerSid call per window and drops
 * every process whose owner cannot be confirmed. Launch detection inherited
 * that filter in #640, and a window that WMI would not attribute to us
 * (slow WMI, an elevated built-in Administrator token) then counted as
 * "nothing started" even while Codex sat on screen. Opening only needs
 * "some process of this package runs in my session": the session boundary
 * already keeps other signed-in users out, and the result is reduced to PIDs
 * so it cannot be handed to a close path by mistake.
 */
function codexDesktopSessionProcessQuery(): string {
  return String.raw`& {
    $currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    @(Get-CimInstance -ClassName Win32_Process -Filter "SessionId=$currentSessionId" | ForEach-Object {
      $path = [string]$_.ExecutablePath
      if (-not $path -and @('ChatGPT.exe', 'Codex.exe') -contains ([string]$_.Name)) {
        $commandLine = [string]$_.CommandLine
        $candidate = [regex]::Match($commandLine, '(?i)"(?<path>[^"]*\\WindowsApps\\OpenAI.Codex(?:Beta)?_[^"]+\\[^"]+.exe)"')
        if ($candidate.Success) { $path = $candidate.Groups['path'].Value }
      }
      if ($null -ne $_.SessionId -and $_.SessionId -eq $currentSessionId -and $path -match '(?i)\\WindowsApps\\OpenAI\.Codex(?:Beta)?_\d+(?:\.\d+){3}_(?:x64|arm64|neutral)__[A-Za-z0-9.]+\\') {
        [pscustomobject]@{ ProcessId = $_.ProcessId; ExecutablePath = $path }
      }
    })
  }`
}

export function buildCodexDesktopSessionProcessProbeScript(): string {
  return [
    codexDesktopProbeScriptHeader,
    `$items = ${codexDesktopSessionProcessQuery()}`,
    '$items | ConvertTo-Json -Compress',
  ].join('; ')
}

/** PIDs of this package's processes in the current session; see the query above. */
export function parseCodexDesktopSessionProcessIds(
  output: string,
  packageFamilyName: string | null,
): number[] {
  const trimmed = output.trim().replace(/^﻿/, '')
  if (!trimmed) return []
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return [] }
  const values = Array.isArray(parsed) ? parsed : [parsed]
  const processIds: number[] = []
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const processId = record.ProcessId
    const executablePath = record.ExecutablePath
    if (typeof processId !== 'number' || !Number.isSafeInteger(processId) || processId <= 0) continue
    if (typeof executablePath !== 'string') continue
    const entry = parseCodexDesktopPackagePath(executablePath)
    if (!entry) continue
    if (packageFamilyName !== null && entry.packageFamilyName.toLowerCase() !== packageFamilyName.toLowerCase()) continue
    processIds.push(processId)
  }
  return processIds
}

/**
 * 桌面端在这个登录会话里还有没有进程：true / false / null（查不出来）。
 *
 * 打开桌面端时软件替用户连上的加速不扣免费时长，所以桌面端一关就要断开，
 * 否则等于白送一条不限时的线路（codex-desktop-acceleration.ts 定时来问）。
 * 与上面那条「打开」用的探测不同，这里失败不能折成「没在跑」：一次 WMI 超时
 * 就把正在用的人断掉，比晚断一两分钟糟得多。
 */
export async function probeCodexDesktopRunning(platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  if (platform === 'darwin') return probeMacosCodexRunning()
  if (platform !== 'win32') return null
  let stdout: string
  try {
    ({ stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildCodexDesktopSessionProcessProbeScript(),
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    }))
  } catch {
    return null
  }
  return codexDesktopRunningFromProbeOutput(stdout)
}

/** 空输出就是一个都没有；读不懂的输出算「查不出来」。 */
export function codexDesktopRunningFromProbeOutput(output: string): boolean | null {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed) return false
  try { JSON.parse(trimmed) } catch { return null }
  return parseCodexDesktopSessionProcessIds(trimmed, null).length > 0
}

async function listCodexDesktopSessionProcessIds(packageFamilyName: string | null): Promise<number[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildCodexDesktopSessionProcessProbeScript(),
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    })
    return parseCodexDesktopSessionProcessIds(stdout, packageFamilyName)
  } catch {
    // Same contract as the status probe: a slow WMI never breaks 打开.
    return []
  }
}

async function waitForCodexDesktopSessionProcesses(
  timeoutMs: number,
  packageFamilyName: string | null,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let processIds = await listCodexDesktopSessionProcessIds(packageFamilyName)
  while (!processIds.length && Date.now() < deadline) {
    await delay(250)
    processIds = await listCodexDesktopSessionProcessIds(packageFamilyName)
  }
  return processIds
}

function codexDesktopPackageProbeStatements(): string[] {
  return [
    '$currentPackages = @()',
    '$currentError = $null',
    'try { $currentPackages = @(Get-AppxPackage -Name \'OpenAI.Codex*\' -ErrorAction Stop | Select-Object Name, Version, PackageFullName, PackageFamilyName, InstallLocation) } catch { $currentError = $_.Exception.Message }',
    // AppX registration is per user. An all-users query can report a package
    // registered for a different account, and normal users are often denied
    // that query altogether. Treat the current account as the only source of
    // truth so a package owned by another account cannot block first install
    // or produce an unlaunchable AppsFolder id.
    '$packages = $currentPackages',
    '$source = if ($currentPackages.Count -gt 0) { \'current-user\' } else { $null }',
    '$currentProbeSucceeded = $null -eq $currentError',
    '$confirmedAbsent = $currentProbeSucceeded -and $currentPackages.Count -eq 0',
    '$errorMessage = $null',
    'if ($null -ne $currentError) {',
    '  $errorMessage = \'读不到这台电脑上 Codex 桌面端的安装信息，请换成当初装它的那个 Windows 账户登录，再打开星芒重试。\'',
    '}',
    '$packageProbe = [pscustomobject]@{ packages = $packages; source = $source; confirmedAbsent = $confirmedAbsent; error = $errorMessage }',
  ]
}

export function buildCodexDesktopPackageProbeScript(): string {
  return [
    codexDesktopProbeScriptHeader,
    '$ErrorActionPreference = "Stop"',
    ...codexDesktopPackageProbeStatements(),
    '$packageProbe | ConvertTo-Json -Compress',
  ].join('; ')
}

/**
 * 开机扫描时这三段查询原本各起一个 powershell.exe。查询本身没变，只是串进
 * 同一条脚本里跑一次，省掉两次进程冷启动（低配机上每次 1~2 秒、常驻几十 MB）。
 *
 * Each segment carries its own try/catch so a single failure reports itself
 * instead of blanking the other two - that is what the three separate
 * processes used to give for free, and the install-state logic downstream
 * depends on telling "no package" apart from "could not look".
 */
/**
 * Every module the merged probe calls into. Runs under trustedCommandEnvironment(),
 * where one autoloaded cmdlet costs a full module analysis (about 22 s on the CI
 * runner, see buildPowerShellModuleImportStatement). The first attempt in #714
 * imported every module here except Appx and saw no gain, because
 * Get-AppxPackage alone still paid the whole autoload. The unit test maps each
 * cmdlet in the script to one of these names so a new one cannot slip past.
 */
export const codexDesktopCombinedProbeModules = [
  'Microsoft.PowerShell.Management',
  'Microsoft.PowerShell.Utility',
  'CimCmdlets',
  'StartLayout',
  'Appx',
] as const

export function buildCodexDesktopCombinedProbeScript(): string {
  return [
    codexDesktopProbeScriptHeader,
    buildPowerShellModuleImportStatement(codexDesktopCombinedProbeModules),
    '$startApps = $null',
    '$startAppsError = $null',
    `try { $startApps = ${codexDesktopStartAppsQuery()} } catch { $startAppsError = $_.Exception.Message }`,
    '$processes = $null',
    '$processesError = $null',
    `try { $processes = ${codexDesktopProcessQuery('roots')} } catch { $processesError = $_.Exception.Message }`,
    // 装之前提醒「这个账户打不开商店应用」（第十九批 6）要的就是这几样，顺路读掉，
    // 首页不必为它再起一次 PowerShell。只读当前身份和一条策略键。
    '$storeAppLaunchContext = $null',
    `try { ${windowsStoreAppLaunchContextStatements().join('; ')} } catch { $storeAppLaunchContext = $null }`,
    '$packageProbe = $null',
    '$packageError = $null',
    'try {',
    // 只有 Appx 这一段按原脚本在 Stop 下跑，放在最后一段，不影响前两段沿用
    // 默认的 Continue —— 那两段今天就是靠「出错只写 stderr、照常输出剩下的」
    // 拿到部分结果的。
    '$ErrorActionPreference = "Stop"',
    ...codexDesktopPackageProbeStatements(),
    '} catch { $packageError = $_.Exception.Message }',
    '[pscustomobject]@{ startApps = $startApps; startAppsError = $startAppsError; processes = $processes; processesError = $processesError; package = $packageProbe; packageError = $packageError; storeAppLaunch = $storeAppLaunchContext } | ConvertTo-Json -Compress -Depth 6',
  ].join('\n')
}

export interface CodexDesktopCombinedProbe {
  match: StartAppEntry | null
  processes: WindowsProcessEntry[]
  packageProbe: CodexDesktopPackageProbe
  /** 只在认出这个账户打不开商店应用时才有；没认出、没读到都不带。 */
  storeAppLaunchBlock?: StoreAppLaunchBlock
}

function codexDesktopProbeSegmentError(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 240) : null
}

function codexDesktopProbeSegmentJson(value: unknown): string {
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function failedCodexDesktopPackageProbe(error: string | null): CodexDesktopPackageProbe {
  return {
    value: null,
    error: error || '无法读取 Windows Appx 包信息',
    source: null,
    confirmedAbsent: false,
  }
}

/**
 * 把合并脚本的一份 JSON 拆回原来的三个结果结构。每段都交给合并前那个解析
 * 函数处理，所以同样的机器状态解析出来的结果与三条脚本时完全一致。
 */
export function parseCodexDesktopCombinedProbeJson(output: string): CodexDesktopCombinedProbe {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  let record: Record<string, unknown> | null = null
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>
      }
    } catch {
      record = null
    }
  }
  if (!record) {
    // 整条脚本没给出可解析的 JSON：三段都回到各自原有的失败取值（开始菜单
    // 为 null、进程为空、Appx 报格式或空输出），与合并前一条脚本失败时看到
    // 的结果一致。
    return {
      match: null,
      processes: [],
      packageProbe: parseCodexDesktopPackageProbeJson(trimmed),
    }
  }
  const startAppsError = codexDesktopProbeSegmentError(record.startAppsError)
  const processesError = codexDesktopProbeSegmentError(record.processesError)
  const packageError = codexDesktopProbeSegmentError(record.packageError)
  const storeAppLaunchBlock = resolveStoreAppLaunchBlock(readWindowsStoreAppLaunchContext(record.storeAppLaunch))
  return {
    ...(storeAppLaunchBlock ? { storeAppLaunchBlock } : {}),
    match: startAppsError
      ? null
      : selectCodexDesktopApp(parseStartAppsJson(codexDesktopProbeSegmentJson(record.startApps))),
    processes: processesError
      ? []
      : parseWindowsProcessesJson(codexDesktopProbeSegmentJson(record.processes)),
    packageProbe: packageError
      ? failedCodexDesktopPackageProbe(packageError)
      : parseCodexDesktopPackageProbeJson(codexDesktopProbeSegmentJson(record.package)),
  }
}

/** 合并脚本整体失败（超时、起不来进程）时三段共用的回退。 */
export function buildCodexDesktopCombinedProbeFailure(reason: unknown): CodexDesktopCombinedProbe {
  const message = reason instanceof Error ? reason.message.trim().slice(0, 240) : ''
  return {
    match: null,
    processes: [],
    packageProbe: failedCodexDesktopPackageProbe(message || null),
  }
}

/**
 * 三段串在一条脚本里跑，总预算不能再按单段的 8 秒算：一次冷启动加
 * Get-StartApps、Win32_Process 查询、Get-AppxPackage 三段串起来，低配机上
 * 比任何单段都慢。取三段旧预算之和，谁都不比合并前更紧 —— 宁可极端情况下多
 * 等，也不要把装好的 Codex 桌面端误判成没装。
 */
export const codexDesktopCombinedProbeTimeoutMs = 24_000

async function runCodexDesktopCombinedProbe(): Promise<CodexDesktopCombinedProbe> {
  try {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildCodexDesktopCombinedProbeScript(),
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: codexDesktopCombinedProbeTimeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return parseCodexDesktopCombinedProbeJson(stdout)
  } catch (error) {
    return buildCodexDesktopCombinedProbeFailure(error)
  }
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

export function assertCodexDesktopUninstalled(
  previousPackageFullName: string,
  remaining: CodexDesktopPackageProbe,
): void {
  if (!remaining.error && remaining.confirmedAbsent === true && !remaining.value) return
  if (remaining.value?.packageFullName === previousPackageFullName) {
    throw new Error('Windows 仍报告 Codex 桌面端 Appx 包存在，卸载未完成')
  }
  throw new Error('卸载命令已执行，但未能确认 Codex 桌面端已经移除。请重新检测安装状态后再试')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Signal 0 only asks whether the PID exists. On Windows libuv opens the
 * process with terminate rights to answer, so a packaged app that denies us
 * those rights reports EPERM while it is very much alive. Only ESRCH means
 * the process is gone.
 */
export function processExistsFromSignalError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EPERM'
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return processExistsFromSignalError(error)
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

export async function waitForCodexDesktopState(
  running: boolean,
  timeoutMs: number,
  packageFamilyName: string | null,
  originalProcessIds?: ReadonlySet<number>,
): Promise<WindowsProcessEntry[]> {
  const deadline = Date.now() + timeoutMs
  // Waiting for selected PIDs to exit belongs to a close path; waiting for a
  // launch to appear does not.
  async function list(): Promise<WindowsProcessEntry[]> {
    const listed = originalProcessIds === undefined
      ? await listCodexDesktopProcesses('roots')
      : await listCodexDesktopProcesses('all', { processIds: originalProcessIds, strict: true })
    return selectCodexDesktopProcessesForPackage(listed, packageFamilyName, originalProcessIds)
  }
  let processes = await list()
  while ((processes.length > 0) !== running && Date.now() < deadline) {
    await delay(250)
    processes = await list()
  }
  return processes
}

export async function terminateCodexDesktopProcesses(
  processes: WindowsProcessEntry[],
  packageFamilyName: string,
): Promise<void> {
  const targetProcesses = selectCodexDesktopProcessesForPackage(processes, packageFamilyName)
  const originalProcessIds = new Set(targetProcesses.map((entry) => entry.processId))
  const taskkill = async (processId: number, force: boolean): Promise<void> => {
    // /T would also terminate descendants that have not passed the owner,
    // session and package checks above.
    const args = ['/PID', String(processId)]
    if (force) args.push('/F')
    await execFileAsync(windowsSystemExecutable('taskkill.exe'), args, {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 8_000,
    })
  }

  await stopCodexDesktopProcesses(targetProcesses, {
    requestClose: (processId) => taskkill(processId, false),
    forceClose: (processId) => taskkill(processId, true),
    waitUntilStopped: (timeoutMs) => waitForCodexDesktopState(
      false, timeoutMs, packageFamilyName, originalProcessIds,
    ),
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
  /** 逐个镜像源的探测失败原因；一路镜像可用时 `mirror.error` 会是 null，但下载提示仍要说明主源怎么了。 */
  mirrorErrors: string[]
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
  /** 国内镜像比微软商店慢一步、这次没能更新到商店里的最新版时，商店那一版的版本号。 */
  storeNewerVersion?: string
}

/** 一次安装 / 更新途中记下的、失败时要说给客户和日志听的几件事。 */
export interface CodexDesktopInstallAttempt {
  storeFailure: string | null
  storeExitCode: string | null
  updating: boolean
  /** 这台电脑没有微软商店，这次没走商店。缺省 = 有商店或没查出来。 */
  storeUnavailable?: boolean
  /** 商店在，但装东西要用的那个系统组件不在（老 Windows 10 常见，推测）。 */
  storeInstallerMissing?: boolean
}

/**
 * 进度提示开头交代商店那一路怎么了的半句话。三种情形各说各的：没有商店就别再
 * 说「这次没装上」，那听起来像是还能再试。
 */
export function describeCodexDesktopStoreNotice(
  attempt: Pick<CodexDesktopInstallAttempt, 'storeFailure' | 'storeUnavailable' | 'storeInstallerMissing'>,
): string {
  if (attempt.storeUnavailable) return `${codexDesktopNoStoreNotice}，直接用国内线路装：`
  if (attempt.storeInstallerMissing) return '微软商店少一个安装组件，先用国内线路装：'
  return attempt.storeFailure ? `微软商店这次没装上（${attempt.storeFailure}），` : ''
}

/**
 * 安装 / 更新失败后抛给界面的那个错误。message 是大白话；detail 是原来那句带着
 * SHA-256、Content-Type、退出码的原话，作为自有字段挂着，ipc.ts 记失败时连同
 * error 一起写进 runtime.jsonl（sanitizeValue 会带上 Error 的自有字段）。cause 留着
 * 原始错误，network-failure.ts 顺着 cause 仍认得出是 DNS 还是证书。
 */
export class CodexDesktopInstallFailure extends Error {
  readonly detail: string
  readonly reason: CodexDesktopInstallFailureReason
  readonly storeExitCode: string | null

  constructor(message: string, options: { detail: string; reason: CodexDesktopInstallFailureReason; storeExitCode: string | null; cause: unknown }) {
    super(message, { cause: options.cause })
    this.name = 'CodexDesktopInstallFailure'
    this.detail = options.detail
    this.reason = options.reason
    this.storeExitCode = options.storeExitCode
  }
}

export function toCodexDesktopInstallFailure(error: unknown, attempt: CodexDesktopInstallAttempt): Error {
  const raw = error instanceof Error ? error.message : String(error)
  if (isPlainCodexDesktopInstallMessage(raw) || isCodexDesktopInstallFailureMessage(raw)) {
    return error instanceof Error ? error : new Error(raw)
  }
  const reason = classifyCodexDesktopInstallFailure(raw)
  const detail = attempt.storeUnavailable
    ? `${codexDesktopNoStoreNotice}，国内镜像也没装上：${raw}`
    : attempt.storeFailure ? `微软商店这次没装上（${attempt.storeFailure}），国内镜像也没装上：${raw}` : raw
  return new CodexDesktopInstallFailure(
    buildCodexDesktopInstallFailureMessage(reason, {
      storeTried: attempt.storeFailure !== null,
      storeUnavailable: attempt.storeUnavailable === true,
      updating: attempt.updating,
    }),
    { detail, reason, storeExitCode: attempt.storeExitCode, cause: error },
  )
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
  currentPackageProbeConfirmedAbsent = false,
): boolean {
  // Get-StartApps can retain a stale entry for a package that was removed or
  // registered for a different account. Once the current-user AppX probe has
  // completed successfully with no package, that entry is not installation
  // evidence and must not block the first-install path.
  return installedPackage === null
    && (startApp === null || currentPackageProbeConfirmedAbsent)
    && processes.length === 0
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
  installationQueue: InstallationQueue
  createInstallTemporaryDirectory: (
    label: string,
    options?: { baseDirectory?: string },
  ) => Promise<string>
  detectMacosCodexApp: typeof inspectMacosCodexApp
  executeCommand: typeof runCommand
  codexEnv: NodeJS.ProcessEnv
  store: AppSettingsStore
  inspectNativeProviderConfig: (provider: ProviderId) => NativeConfigInspection
  spawnDetached: (
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean },
  ) => Promise<void>
  /**
   * 装之前先看一眼安装盘还剩多少。缺省不检查（测试与旧调用方照旧），生产由
   * system-service 注入同一个预检，好让 CLI 与桌面端用同一条门槛和同一句话。
   */
  assertInstallDiskSpace?: (subject: string) => Promise<void>
  /**
   * 镜像清单探测与安装包下载用的 fetch。加速只接管系统代理，而主进程的全局
   * fetch 是 Node 的 undici，根本不读系统代理——Codex 桌面端的下载因此一直
   * 直连，开不开加速都一样。生产环境注入 Electron 的 `net.fetch`（走 Chromium
   * 网络栈，读系统代理），必填以保证这条路不会再退回直连。
   */
  downloadFetch: typeof fetch
  /**
   * 重新读取 Chromium 缓存的代理配置。刚打开加速就点更新时，Chromium 可能还
   * 拿着接管前的那份配置，于是第一次下载仍然直连。
   */
  reloadDownloadProxyConfig?: () => Promise<void>
  /**
   * 拉起桌面端之前先把加速连上。桌面端是独立进程，只认系统代理，所以这里要的
   * 是完整的「连接」而不是下载专用线路。缺省 = 不做（测试与旧调用方照旧）；
   * 实现永不抛错，连不上也必须照常打开（见 codex-desktop-acceleration.ts）。
   */
  prepareAcceleration?: () => Promise<void>
  /** 找系统自带的 winget（微软商店那一路用）。缺省 = 校验过包身份与目录的系统解析器。 */
  resolveStoreInstaller?: (signal?: AbortSignal) => Promise<SystemWingetResolution>
  /**
   * 这台电脑有没有微软商店：false 才跳过商店、直接走国内线路；null（没查出来）
   * 照旧先走商店。缺省 = windows-store-app-launch.ts 那条异步探测。
   */
  inspectStoreAvailability?: (signal?: AbortSignal) => Promise<boolean | null>
  /** Optional seams used by tests; production uses the constrained CDP module. */
  activateCodexDesktop?: typeof activateCodexDesktopDefault
  activateCodexDesktopWithCdp?: typeof activateCodexDesktopWithCdpDefault
  getAvailableLoopbackPort?: typeof getAvailableLoopbackPortDefault
  injectCodexDesktopChineseLocale?: typeof injectCodexDesktopChineseLocaleDefault
}

export interface CodexDesktopLaunchOptions {
  /** Enables the short-lived loopback CDP locale patch for a Chinese restart. */
  injectChinese?: boolean
  /**
   * Repairs the legacy Desktop permission-mode visibility atom after all
   * running processes have been closed and before the next launch.
   */
  repairPermissionModeVisibility?: boolean
}

export interface CodexDesktopService {
  inspectCodexDesktop(): Promise<DesktopAppStatus>
  inspectCodexDesktopUpdate(forceRefresh?: boolean): Promise<DesktopAppStatus>
  installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult>
  /** 中止正在进行的安装或更新;已经开始装 MSIX 时会被拒绝并给出原因。 */
  cancelCodexDesktopInstall(): InstallCancellationOutcome
  uninstallCodexDesktop(): Promise<ToolUninstallResult>
  /** 和 Windows「设置 → 应用 → 高级选项 → 重置」同一件事：只清 Codex 桌面端自己的应用数据。 */
  resetCodexDesktop(): Promise<void>
  launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
    launchOptions?: CodexDesktopLaunchOptions,
  ): Promise<CodexDesktopLaunchResult>
}

/**
 * Owns the two version-probe caches and the install/uninstall/launch busy
 * lock that the 12 Codex Desktop orchestration functions below share. All
 * dependencies on the host `createSystemService` closure (the desktop-app
 * verifier, the settings store, the shared installation queue) are
 * passed in explicitly rather than recreated here, so this factory has no
 * defaults of its own to keep in sync with `SystemServiceOptions`.
 */
export function createCodexDesktopService(options: CodexDesktopServiceOptions): CodexDesktopService {
  const {
    platform,
    installationQueue,
    createInstallTemporaryDirectory,
    detectMacosCodexApp,
    executeCommand,
    codexEnv,
    store,
    inspectNativeProviderConfig,
    spawnDetached,
    downloadFetch,
    reloadDownloadProxyConfig,
    prepareAcceleration,
    assertInstallDiskSpace,
    resolveStoreInstaller = resolveSystemWingetExecutable,
    inspectStoreAvailability = (signal?: AbortSignal) => inspectWindowsStoreAvailability(signal ? { signal } : {}),
    activateCodexDesktop = activateCodexDesktopDefault,
    activateCodexDesktopWithCdp = activateCodexDesktopWithCdpDefault,
    getAvailableLoopbackPort = getAvailableLoopbackPortDefault,
    injectCodexDesktopChineseLocale = injectCodexDesktopChineseLocaleDefault,
  } = options
  let codexDesktopInstalling = false
  const installCancellations = new InstallCancellationRegistry()
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
          mirrorErrors: [],
        }
        if (generation === codexDesktopManifestGeneration) {
          codexDesktopManifestCache = {
            expiresAt: Date.now() + codexDesktopLatestFailureCacheTtlMs,
            value,
          }
        }
        return value
      }

      const result = await probeCodexDesktopManifests(process.arch, downloadFetch)
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
        mirrorErrors,
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
    const [probeResult, mirrorResult] = await Promise.allSettled([
      runCodexDesktopCombinedProbe(),
      inspectCodexDesktopMirrorVersion(),
    ])
    // 开始菜单、进程、Appx 三段现在由一条 PowerShell 脚本一次跑完，段内失败
    // 已经在脚本里各自隔离，所以到这里三段都是「有结果」的；镜像版本仍是
    // 独立的一条，任一异常都不应连累其余已知结果。
    const combinedProbe = probeResult.status === 'fulfilled'
      ? probeResult.value
      : buildCodexDesktopCombinedProbeFailure(probeResult.reason)
    const {
      match,
      processes,
      packageProbe,
      mirrorProbe,
      detectionFailed,
      detectionError,
    } = buildCodexDesktopWindowsProbes(
      { status: 'fulfilled', value: combinedProbe.match },
      { status: 'fulfilled', value: combinedProbe.processes },
      { status: 'fulfilled', value: combinedProbe.packageProbe },
      mirrorResult,
    )
    const processPackage = selectCodexDesktopPackage(
      processes
        .map((entry) => parseCodexDesktopPackagePath(entry.executablePath))
        .filter((entry): entry is CodexDesktopPackageEntry => entry !== null),
    )
    // A process with a verified current-user SID and session remains useful
    // evidence when AppX enumeration fails. Prefer registered metadata.
    const processPackageAllowed = packageProbe.confirmedAbsent !== true
    const installedPackage = packageProbe.value ?? (processPackageAllowed ? processPackage : null)
    const targetProcesses = installedPackage
      ? selectCodexDesktopProcessesForPackage(processes, installedPackage.packageFamilyName)
      : []
    // A successful current-user AppX probe with no package is authoritative.
    // Windows may keep a stale StartApps registration after uninstalling the
    // package or when another account owns it; treating that entry as a valid
    // install creates an AppsFolder id that AppModel accepts but cannot run.
    const staleStartApp = packageProbe.confirmedAbsent === true
    if ((!match || staleStartApp) && !installedPackage) {
      return {
        installed: false,
        version: null,
        appVersion: null,
        mirrorVersion: mirrorProbe.version,
        mirrorUpdateAvailable: desktopMirrorUpdateAvailable(null, mirrorProbe.version),
        mirrorError: mirrorProbe.error,
        path: null,
        installDirectory: null,
        running: false,
        detectionFailed,
        detectionError,
        ...(combinedProbe.storeAppLaunchBlock ? { storeAppLaunchBlock: combinedProbe.storeAppLaunchBlock } : {}),
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
      running: targetProcesses.length > 0,
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

  /**
   * 先从微软商店装。成功返回装好的包；商店这一路走不通就返回原因，由调用方
   * 退到国内镜像。只有用户点了取消才抛错。
   */
  async function installCodexDesktopFromStore(
    target: RendererMessageTarget,
    previousVersion: string | null,
    packageFamilyName: string | null,
    cancellation?: InstallCancellationHandle,
  ): Promise<{ installed: CodexDesktopPackageEntry } | { failure: string; exitCode?: string | null; installerMissing?: boolean }> {
    const storeStartedAt = Date.now()
    sendCodexDesktopInstallProgress(target, {
      phase: 'downloading',
      percent: null,
      message: buildCodexDesktopStoreWaitMessage(0, null),
    })
    const resolution = await resolveStoreInstaller(cancellation?.signal)
    cancellation?.throwIfCancelled()
    if (!resolution.executable) return { failure: '这台电脑上的微软商店安装组件用不了', installerMissing: true }
    let command: CommandSpec
    try {
      command = buildCodexDesktopStoreInstallCommand(resolution.executable)
    } catch {
      return { failure: '这台电脑上的微软商店安装组件用不了', installerMissing: true }
    }
    if (previousVersion && packageFamilyName) {
      // 商店更新一个正开着的桌面端会失败或卡住；镜像那一路也是装之前先关。
      const processes = selectCodexDesktopProcessesForPackage(
        await listCodexDesktopProcesses('all', { strict: true }), packageFamilyName,
      )
      if (processes.length) {
        sendCodexDesktopInstallProgress(target, {
          phase: 'closing',
          percent: null,
          message: '正在关闭运行中的 Codex 桌面端',
        })
        await terminateCodexDesktopProcesses(processes, packageFamilyName)
      }
    }
    let commandFailure: string | null = null
    let commandExitCode: string | null = null
    let lastPercent: number | null = null
    function sendStoreWait(): void {
      sendCodexDesktopInstallProgress(target, {
        phase: 'downloading',
        percent: lastPercent,
        message: buildCodexDesktopStoreWaitMessage(Date.now() - storeStartedAt, lastPercent),
      })
    }
    const heartbeat = setInterval(sendStoreWait, codexDesktopStoreHeartbeatMs)
    try {
      await executeCommand(command, {
        // 解析器已经核过 App Installer 的包身份与真实目录（同 node-runtime、
        // external-client-runtime），这里按当前用户身份跑，不再走提权路径检查。
        env: trustedCommandEnvironment(),
        trustedOnly: false,
        windowsHide: true,
        timeoutMs: codexDesktopStoreInstallTimeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
        acceptedExitCodes: [0],
        ...(cancellation ? { signal: cancellation.signal } : {}),
        onOutput: (event) => {
          const percent = parseCodexDesktopStoreProgress(event.text)
          if (percent === null || percent === lastPercent) return
          lastPercent = percent
          sendStoreWait()
        },
      })
    } catch (error) {
      cancellation?.throwIfCancelled()
      commandFailure = describeCodexDesktopStoreFailure(error)
      commandExitCode = codexDesktopStoreExitCode(error)
    } finally {
      clearInterval(heartbeat)
    }
    // 不只看退出码：商店偶尔报错却已经装好，也可能报成功却没换版本。以本机实际
    // 装着的包为准（包身份与发布者由 selectCodexDesktopPackage 核过）。
    const installedProbe = await inspectCodexDesktopPackage()
    const installed = installedProbe.value
    if (installed) {
      const comparison = previousVersion
        ? compareWindowsPackageVersions(previousVersion, installed.version)
        : -1
      if (comparison !== null && comparison < 0) return { installed }
    }
    return { failure: commandFailure ?? '装完后没检测到新版本', exitCode: commandExitCode }
  }

  async function installCodexDesktopOperation(
    target: RendererMessageTarget,
    cancellation?: InstallCancellationHandle,
  ): Promise<CodexDesktopInstallResult> {
    const attempt: CodexDesktopInstallAttempt = { storeFailure: null, storeExitCode: null, updating: false }
    try {
      return await installCodexDesktopFromSources(target, attempt, cancellation)
    } catch (error) {
      if (isInstallCancelledError(error) || cancellation?.cancelled === true) throw error
      throw toCodexDesktopInstallFailure(error, attempt)
    }
  }

  async function installCodexDesktopFromSources(
    target: RendererMessageTarget,
    attempt: CodexDesktopInstallAttempt,
    cancellation?: InstallCancellationHandle,
  ): Promise<CodexDesktopInstallResult> {
    // 排队等待期间点的取消在这里生效：一个字节都不用下。
    cancellation?.throwIfCancelled()
    // 安装包有几百兆，磁盘快满时下到一半才失败最难受；读不到空间照常放行。
    await assertInstallDiskSpace?.('Codex 桌面端安装失败')
    if (platform === 'darwin') {
      throw new Error('macOS 上 Codex App 的安装由 Codex App 管理，请使用“打开”操作由已验证的 Codex CLI 完成安装或启动')
    }
    if (platform !== 'win32') throw new Error('Codex 桌面端安装目前仅支持 Windows')
    const architecture = process.arch === 'x64' || process.arch === 'arm64'
      ? process.arch
      : null
    if (!architecture) throw new Error(`Codex 桌面端不支持当前处理器架构 ${process.arch}`)

    const [currentProbe, startApp, runningProcesses, storeAvailable] = await Promise.all([
      inspectCodexDesktopPackage(),
      findCodexDesktopStartApp(),
      listCodexDesktopProcesses(),
      // 探测自己吞掉错误；这里再兜一层，查不出来就当不知道，照旧先走商店。
      inspectStoreAvailability(cancellation?.signal).catch(() => null),
    ])
    cancellation?.throwIfCancelled()
    attempt.storeUnavailable = storeAvailable === false
    if (currentProbe.error) throw new Error(currentProbe.error)
    const currentPackage = currentProbe.value
    const firstInstall = canAttemptCodexDesktopFirstInstallFallback(
      currentPackage,
      startApp,
      runningProcesses,
      currentProbe.confirmedAbsent === true,
    )
    if (!firstInstall && !currentPackage) {
      throw new Error('星芒看到了 Codex 桌面端，但读不到它装的是哪一版，请点「重新检测」后再试')
    }
    const previousVersion = currentPackage?.version ?? null
    attempt.updating = previousVersion !== null
    // 刚打开加速就点更新时，Chromium 可能还拿着接管前的代理配置。刷新失败不
    // 影响安装本身，下载至多回到刷新前那条路。
    if (reloadDownloadProxyConfig) {
      await reloadDownloadProxyConfig().catch(() => undefined)
    }
    invalidateCodexDesktopManifestCache()
    const manifestBundle = await inspectCodexDesktopManifestBundle()
    cancellation?.throwIfCancelled()
    if (attempt.storeUnavailable) {
      // 商店为主、镜像备用的规矩不变；只是这台电脑根本没有商店，空等那一步没有意义。
      sendCodexDesktopInstallProgress(target, {
        phase: 'downloading',
        percent: null,
        message: `${codexDesktopNoStoreNotice}，直接用国内线路${previousVersion ? '更新' : '装'} Codex 桌面端。`,
      })
    } else if (!previousVersion || shouldTryCodexDesktopStoreUpdate(previousVersion, manifestBundle.latest.version)) {
      const storeResult = await installCodexDesktopFromStore(
        target, previousVersion, stableInstallFamilyName(currentPackage), cancellation,
      )
      if ('installed' in storeResult) {
        invalidateCodexDesktopManifestCache()
        const installedVersion = storeResult.installed.version
        sendCodexDesktopInstallProgress(target, {
          phase: 'completed',
          percent: 100,
          message: previousVersion
            ? `Codex 桌面端已从 ${previousVersion} 更新到 ${installedVersion}`
            : `Codex 桌面端 ${installedVersion} 装好了`,
        })
        return {
          action: previousVersion ? 'updated' : 'installed',
          previousVersion,
          installedVersion,
        }
      }
      attempt.storeFailure = storeResult.failure
      attempt.storeExitCode = storeResult.exitCode ?? null
      attempt.storeInstallerMissing = storeResult.installerMissing === true
    }
    const mirrorCandidates = manifestBundle.mirrorCandidates
    const mirrorCandidate = mirrorCandidates[0] ?? null
    const newestRelease = mirrorCandidate?.release ?? null
    let previousCandidatesLoaded = false
    let installCandidates: CodexDesktopManifestCandidate[]
    let installProbeErrors: string[] = manifestBundle.mirrorErrors
    if (!newestRelease) {
      if (!firstInstall) {
        throw new Error(manifestBundle.mirror.error ?? '国内镜像暂时没有可安装的 Codex Desktop 版本')
      }
      const previousProbe = await fetchCodexDesktopPreviousManifestCandidates(architecture, downloadFetch)
      installCandidates = previousProbe.candidates
      installProbeErrors = previousProbe.errors
      previousCandidatesLoaded = true
      if (!installCandidates.length) {
        const detail = previousProbe.errors.join('；') || '没有可验证的上一版本清单'
        throw new Error(`当前镜像暂时不可用，上一版本也无法获取（${detail}），请使用微软商店完成首次安装`)
      }
      sendCodexDesktopInstallProgress(target, {
        phase: 'downloading',
        percent: 0,
        message: '这一版暂时下载不到，正在改装上一版 Codex 桌面端（0%）',
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
        // 没有商店的电脑上不提「去微软商店更新」：那颗按钮在这里打不开。
        const storeNewerVersion = !attempt.storeUnavailable && latestComparison === -1 && latest.version ? latest.version : null
        // 渲染层看到 storeNewerVersion 会给一颗「去微软商店装」按钮，这里只说清楚现状。
        const mirrorLagNotice = storeNewerVersion
          ? `；微软商店里已经有 ${storeNewerVersion}，国内下载线路还没跟上，可以去微软商店更新`
          : ''
        const result: CodexDesktopInstallResult = {
          action: 'unchanged',
          previousVersion,
          installedVersion: previousVersion,
          ...(storeNewerVersion ? { storeNewerVersion } : {}),
        }
        sendCodexDesktopInstallProgress(target, {
          phase: 'completed',
          percent: 100,
          message: comparison === 0
            ? `Codex 桌面端 ${previousVersion} 已是国内下载线路上最新的一版${mirrorLagNotice}`
            : `这台电脑上的 Codex 桌面端 ${previousVersion} 比国内下载线路上的还新，不用更新${mirrorLagNotice}`,
        })
        return result
      }
    }

    const temporaryDirectory = await createInstallTemporaryDirectory('codex-desktop')
    const packagePath = path.join(temporaryDirectory, `ChatGPT-${architecture}.msix`)
    try {
      // 换线路的原因以前只在 0% 那一刻出现，进度一动就被普通文案盖掉，用户只看得到
      // 「正在从镜像备用源下载」。每一路尝试开始时记下自己的说法，整段下载都带着。
      let attemptNotice: string | null = null
      const downloadWithProgress = (
        candidates: CodexDesktopManifestCandidate[],
        probeErrors: readonly string[],
      ): Promise<CodexDesktopCandidateDownloadResult> => downloadCodexDesktopPackageFromCandidates(candidates, packagePath, {
        fetchImplementation: downloadFetch,
        ...(cancellation ? { signal: cancellation.signal } : {}),
        onAttempt: (candidate, attemptIndex, previousFailure) => {
          const release = candidate.release
          const source = candidate.packageSource
          if (!release || !source) return
          attemptNotice = describeCodexDesktopDownloadAttempt(
            source,
            attemptIndex,
            previousFailure,
            probeErrors,
            attempt,
          )
          sendCodexDesktopInstallProgress(target, {
            phase: 'downloading',
            percent: 0,
            message: `${attemptNotice} Codex 桌面端 ${release.version}（0%）`,
          })
        },
        onProgress: (candidate, { percent, resuming }) => {
          const release = candidate.release
          const source = candidate.packageSource
          if (!release || !source) return
          sendCodexDesktopInstallProgress(target, {
            phase: 'downloading',
            percent,
            message: resuming
              ? `网络断了一下，正在从${source.label}接着下载 Codex 桌面端 ${release.version}（已下 ${percent}%）`
              : `${attemptNotice ?? `正在从${source.label}下载`} Codex 桌面端 ${release.version}（${percent}%）`,
          })
        },
        validatePackage: async (candidate) => {
          const release = candidate.release
          const source = candidate.packageSource
          if (!release || !source) throw new Error('镜像候选缺少安装元数据')
          sendCodexDesktopInstallProgress(target, {
            phase: 'validating',
            percent: null,
            message: '正在检查下载下来的安装包是不是完整的官方版',
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
        selected = await downloadWithProgress(installCandidates, installProbeErrors)
      } catch (error) {
        // 取消之后不再回落到上一版本：那是另一次完整下载。
        if (isInstallCancelledError(error)) throw error
        cancellation?.throwIfCancelled()
        if (!firstInstall) throw error
        if (previousCandidatesLoaded) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`上一版本安装包下载或校验失败（${detail}），请使用微软商店完成首次安装`)
        }
        sendCodexDesktopInstallProgress(target, {
          phase: 'downloading',
          percent: 0,
          message: '这一版没下载成功，正在改装上一版 Codex 桌面端（0%）',
        })
        const previousProbe = await fetchCodexDesktopPreviousManifestCandidates(architecture, downloadFetch)
        if (!previousProbe.candidates.length) {
          const detail = previousProbe.errors.join('；') || '没有可验证的上一版本清单'
          const currentDetail = error instanceof Error ? error.message : String(error)
          throw new Error(`当前版本和上一版本均无法获取（当前版本：${currentDetail}；上一版本：${detail}），请使用微软商店完成首次安装`)
        }
        try {
          selected = await downloadWithProgress(previousProbe.candidates, previousProbe.errors)
        } catch (previousError) {
          const currentDetail = error instanceof Error ? error.message : String(error)
          const previousDetail = previousError instanceof Error ? previousError.message : String(previousError)
          throw new Error(`当前版本和上一版本均安装失败（当前版本：${currentDetail}；上一版本：${previousDetail}），请使用微软商店完成首次安装`)
        }
      }
      const release = selected.candidate.release
      if (!release) throw new Error('镜像候选缺少安装元数据')

      cancellation?.throwIfCancelled()
      // 从这里开始就会动这台机器上的 Codex Desktop：先关掉正在跑的进程，
      // 再交给 Add-AppxPackage。中途中断会留下一个装了一半的包，所以封存。
      cancellation?.seal(codexDesktopInstallSealReason)
      const packageFamilyName = stableInstallFamilyName(currentPackage)
      const processes = packageFamilyName
        ? selectCodexDesktopProcessesForPackage(
          await listCodexDesktopProcesses('all', { strict: true }), packageFamilyName,
        )
        : []
      if (processes.length) {
        sendCodexDesktopInstallProgress(target, {
          phase: 'closing',
          percent: null,
          message: '正在关闭运行中的 Codex 桌面端',
        })
        if (packageFamilyName) await terminateCodexDesktopProcesses(processes, packageFamilyName)
      }
      sendCodexDesktopInstallProgress(target, {
        phase: 'installing',
        percent: null,
        message: `正在安装 Codex 桌面端 ${release.version}`,
      })
      await addCodexDesktopPackage(packagePath, {
        sha256Base64: release.sha256Base64,
        contentLength: release.contentLength,
        onElevationRequired: () => sendCodexDesktopInstallProgress(target, {
          phase: 'installing', percent: null,
          message: '此版本需管理员权限安装服务，请在 Windows 授权窗口中允许本次安装；取消将停止安装。',
        }),
      })
      const installedPackage = await verifyInstalledCodexDesktop(release.version)
      invalidateCodexDesktopManifestCache()
      const action = previousVersion ? 'updated' : 'installed'
      sendCodexDesktopInstallProgress(target, {
        phase: 'completed',
        percent: 100,
        message: previousVersion
          ? `Codex 桌面端已从 ${previousVersion} 更新到 ${installedPackage.version}`
          : `Codex 桌面端 ${installedPackage.version} 装好了`,
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
    cancellation?: InstallCancellationHandle,
  ): Promise<CodexDesktopInstallResult> {
    if (codexDesktopInstalling) throw new Error('Codex 桌面端正在安装或更新，请勿重复操作')
    codexDesktopInstalling = true
    try {
      return await installCodexDesktopOperation(target, cancellation)
    } catch (error) {
      // 取消是用户自己按的，不是安装失败：换成统一的中文文案，免得界面像出了故障。
      if (isInstallCancelledError(error) || cancellation?.cancelled === true) {
        const cancelled = new InstallCancelledError('Codex 桌面端安装已取消')
        sendCodexDesktopInstallProgress(target, { phase: 'error', percent: null, message: cancelled.message })
        throw cancelled
      }
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
    // 重复点击复用队列里的同一个 Promise，所以这里也不能再开一个取消句柄：
    // 后点的那次会把前一次的句柄挤掉，取消按钮就再也找不到正在跑的安装。
    if (installCancellations.has(codexDesktopInstallKey)) {
      return installationQueue.enqueue(
        codexDesktopInstallKey,
        () => installCodexDesktopOperationWithProgress(target),
      )
    }
    // 句柄在入队之前登记：排在别的安装后面等待时也要能取消。
    const cancellation = installCancellations.begin(codexDesktopInstallKey)
    return installationQueue.enqueue(
      codexDesktopInstallKey,
      () => installCodexDesktopOperationWithProgress(target, cancellation),
    ).finally(() => cancellation.release())
  }

  function cancelCodexDesktopInstall(): InstallCancellationOutcome {
    return installCancellations.cancel(codexDesktopInstallKey)
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
      const probe = await inspectCodexDesktopPackage()
      if (probe.confirmedAbsent === true && !probe.error) {
        return { outcome: 'not-installed', previousVersion: null }
      }
      const processes = await listCodexDesktopProcesses('all', { strict: true })
      if (probe.error && !processes.length) throw new Error(probe.error)
      const processPackage = selectCodexDesktopPackage(
        processes
          .map((entry) => parseCodexDesktopPackagePath(entry.executablePath))
          .filter((entry): entry is CodexDesktopPackageEntry => entry !== null),
      )
      const installedPackage = probe.value ?? processPackage
      if (!installedPackage) return { outcome: 'not-installed', previousVersion: null }
      const targetProcesses = selectCodexDesktopProcessesForPackage(
        processes, installedPackage.packageFamilyName,
      )
      if (targetProcesses.length) {
        await terminateCodexDesktopProcesses(targetProcesses, installedPackage.packageFamilyName)
      }
      const script = [
        '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        '$ErrorActionPreference = "Stop"',
        `Remove-AppxPackage -Package ${powerShellLiteral(installedPackage.packageFullName)} -ErrorAction Stop`,
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
      assertCodexDesktopUninstalled(installedPackage.packageFullName, remaining)
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

  async function resetCodexDesktopOperation(): Promise<void> {
    if (platform !== 'win32') throw new Error('只有 Windows 上的 Codex 桌面端可以一键重置')
    if (codexDesktopInstalling) throw new Error('Codex 桌面端正在安装、更新或卸载中')
    codexDesktopInstalling = true
    try {
      const probe = await inspectCodexDesktopPackage()
      const installedPackage = probe.value
      if (!installedPackage) {
        throw new Error(probe.confirmedAbsent === true
          ? '这台电脑上没找到 Codex 桌面端，先在首页点「安装」装好它。'
          : codexDesktopResetManualHint)
      }
      // Reset-AppxPackage stops the app itself, but a window that is still
      // closing can keep files in LocalState open and make the reset fail
      // half-way. Close the package's own processes first, the same way
      // uninstall does.
      const processes = await listCodexDesktopProcesses('all', { strict: true })
      const targetProcesses = selectCodexDesktopProcessesForPackage(
        processes, installedPackage.packageFamilyName,
      )
      if (targetProcesses.length) {
        await terminateCodexDesktopProcesses(targetProcesses, installedPackage.packageFamilyName)
      }
      try {
        await execFileAsync(resolveWindowsPowerShellExecutable(), [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          buildCodexDesktopResetScript(installedPackage.packageFullName),
        ], {
          env: trustedCommandEnvironment(),
          windowsHide: true,
          timeout: 2 * 60_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      } catch (error) {
        throw new Error(describeCodexDesktopResetFailure(error))
      }
    } finally {
      codexDesktopInstalling = false
    }
  }

  function resetCodexDesktop(): Promise<void> {
    return installationQueue.enqueue(
      'desktop:codex:reset',
      () => resetCodexDesktopOperation(),
    )
  }

  function sendCodexDesktopLaunchProgress(
    target: RendererMessageTarget,
    progress: CodexDesktopLaunchProgress,
  ): void {
    if (!target.isDestroyed()) target.send('desktop:codex-launch-progress', progress)
  }

  function sendCodexDesktopStatus(
    target: RendererMessageTarget,
    phase: 'stopped' | 'running',
    status: DesktopAppStatus,
  ): void {
    if (!target.isDestroyed()) target.send('desktop:codex-status-changed', { phase, status })
  }

  /**
   * 桌面端拉起来之前先连加速。它是独立进程，只跟着系统代理走，所以用户不点
   * 「连接」的时候它就是直连的——那正是界面语言回落成英文的那条路。连不上
   * 绝不能挡住打开，所以这里把最后一层异常也吃掉。
   */
  async function connectAccelerationBeforeLaunch(): Promise<void> {
    if (!prepareAcceleration) return
    try { await prepareAcceleration() }
    catch { /* 加速是加分项，不是「打开」的前置条件。 */ }
  }

  async function launchCodexDesktopOperation(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
    launchOptions: CodexDesktopLaunchOptions = {},
    heartbeat?: CodexDesktopLaunchHeartbeat,
  ): Promise<CodexDesktopLaunchResult> {
    if (codexDesktopInstalling) throw new Error('Codex 桌面端正在安装、更新或卸载中，请稍后再试')
    if (platform === 'darwin' && mode === 'restart') {
      throw new Error('macOS 不支持重启 Codex，请使用打开操作唤起现有应用')
    }
    const nativeConfig = inspectNativeProviderConfig('codex')
    if (!canLaunchManagedProvider(nativeConfig)) {
      throw new Error(managedProviderLaunchBlockedMessage('codex'))
    }
    if (platform === 'darwin') {
      // Desktop ships its own runtime. Requiring `codex app` here blocks a
      // valid app installation whenever the separate CLI/Node is absent.
      // Reuse the bundle/architecture/OpenAI-signature verifier and bind
      // LaunchServices to that exact app, rather than a PATH or bundle alias.
      const desktopApp = await inspectCodexDesktop()
      if (desktopApp.detectionFailed) throw new Error('Codex 桌面端检测未完成，请重新检测后再试')
      if (!desktopApp.installed || !desktopApp.path) {
        throw new Error('未检测到 Codex 桌面端，请先安装 Codex App 后重新检测')
      }
      const workspace = store.read().workspace
      try {
        if (!fs.statSync(workspace).isDirectory()) throw new Error('not a directory')
      } catch {
        throw new Error('工作目录不存在，请重新选择')
      }
      await connectAccelerationBeforeLaunch()
      await executeCommand(buildMacosCodexAppLaunchPlan(desktopApp.path, workspace, codexEnv.CODEX_HOME), {
        cwd: workspace,
        env: trustedCommandEnvironment(codexEnv),
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      })
      const status = await inspectCodexDesktop()
      if (status.running) sendCodexDesktopStatus(target, 'running', status)
      return { restarted: false, status }
    }
    if (platform !== 'win32') throw new Error('Codex 桌面端启动目前仅支持 Windows')

    const desktopApp = await inspectCodexDesktop()
    if (!desktopApp.installed || !desktopApp.path) {
      throw new Error('未检测到 Codex 桌面端，请先安装后重新检测')
    }
    const desktopAppPath = desktopApp.path
    const installedFamilyName = desktopApp.installDirectory
      ? parseCodexDesktopPackagePath(desktopApp.installDirectory)?.packageFamilyName ?? null
      : null
    const appIdFamilyName = /^(OpenAI\.Codex(?:Beta)?_[A-Za-z0-9.]+)!App$/i.exec(desktopAppPath)?.[1] ?? null
    const packageFamilyName = installedFamilyName ?? appIdFamilyName
    // Opening never closes anything, so an unknown family only widens which
    // of the user's own Codex windows count as "already running".
    if (!packageFamilyName && mode === 'restart') {
      throw new Error('没能确认要重启的是哪一个 Codex 桌面端，请重新检测后再试')
    }
    await connectAccelerationBeforeLaunch()
    const workspace = store.read().workspace
    let workspaceUrl: string | null = null
    try {
      if (fs.statSync(workspace).isDirectory()) workspaceUrl = buildCodexDesktopWorkspaceUrl(workspace)
    } catch {
      // Keep the legacy AppsFolder fallback available when the user has not
      // selected a workspace yet. The next launch can use the deep link once
      // the workspace is configured.
    }

    // Restart closes what it finds, so it keeps the owner-checked, fail-closed
    // list. Open closes nothing and only asks whether a window already runs.
    const existingProcesses = mode === 'restart'
      ? selectCodexDesktopProcessesForPackage(
        await listCodexDesktopProcesses('all', { strict: true }),
        packageFamilyName,
      )
      : []
    const alreadyRunning = mode === 'restart'
      ? existingProcesses.length > 0
      : (await listCodexDesktopSessionProcessIds(packageFamilyName)).length > 0
    const restarted = mode === 'restart' && existingProcesses.length > 0
    const repairPermissionState = async (): Promise<void> => {
      if (!launchOptions.repairPermissionModeVisibility || !codexEnv.CODEX_HOME) return
      try {
        const result = await repairCodexDesktopGlobalState(codexEnv.CODEX_HOME)
        if (result.changed) console.info('[codex-launch] 已迁移旧版权限选择器状态')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Codex Desktop 权限选择器状态修复失败：${message.slice(0, 500)}`)
      }
    }
    if (mode === 'restart') {
      try {
        // Restart without a known family already stopped above.
        if (packageFamilyName) await terminateCodexDesktopProcesses(existingProcesses, packageFamilyName)
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
      await repairPermissionState()
      sendCodexDesktopStatus(target, 'stopped', { ...desktopApp, running: false })
    }

    // An open action normally leaves an already-running Desktop untouched.
    // The caller only enables this path when the process probe confirmed that
    // no process is alive, so the state file cannot be overwritten from the
    // Desktop's in-memory legacy value while we migrate it.
    if (mode !== 'restart') await repairPermissionState()

    let activationProcessId: number | null = null
    const launchWithExplorer = async (): Promise<void> => {
      const launchPlan = buildCodexDesktopLaunchPlan(desktopAppPath)
      await spawnDetached(launchPlan.executable, launchPlan.args, {
        cwd: launchPlan.cwd,
        env: launchPlan.env,
        windowsHide: launchPlan.windowsHide,
      })
    }
    let workspaceLaunchDelivered = false
    const launchWithWorkspace = async (): Promise<void> => {
      if (!workspaceUrl) {
        await launchWithExplorer()
        return
      }
      // Do not pass codex:// to explorer.exe. If the mirror-installed package
      // has not registered the protocol handler, Explorer treats the query's
      // path as a normal folder and opens Documents instead of Codex. The
      // AppModel activation manager delivers the same URL directly to the
      // packaged app without exposing a shell window.
      const pid = await activateCodexDesktop(desktopAppPath, workspaceUrl)
      if (pid !== null) activationProcessId = pid
      workspaceLaunchDelivered = true
    }
    const launchFresh = async (): Promise<void> => {
      try {
        await launchWithWorkspace()
      } catch (error) {
        if (!workspaceUrl) throw error
        const message = error instanceof Error ? error.message : String(error)
        // Damaged or older Store registrations may reject arguments through
        // the AppModel activation manager even though plain AppsFolder
        // activation works. Do not retry the URL through Explorer: that is
        // precisely the path which can open the workspace as a folder.
        console.warn(`[codex-launch] 工作区参数激活不可用，回退 AppsFolder：${message}`)
        await launchWithExplorer()
      }
    }
    let cdpPort: number | null = null
    // The workspace deep link activates the app again and may report another
    // PID. Ownership of the debugging port belongs to the process that was
    // started with the flag, so keep that PID out of the later reassignment.
    let cdpActivationProcessId: number | null = null
    let activatedViaAppModel = false
    const needsFreshActivation = mode === 'restart' || !alreadyRunning
    const shouldInjectChinese = Boolean(launchOptions.injectChinese)
      && needsFreshActivation
    let chineseLocale: CodexDesktopLaunchResult['chineseLocale'] = launchOptions.injectChinese
      ? needsFreshActivation
        ? { status: 'failed', message: 'Codex 已打开，但中文增强启动未完成。请在配置中再次启用中文界面。' }
        : { status: 'restart-required', message: '中文设置已保存；当前 Codex 已在运行，请在配置中启用中文界面以重启并应用。' }
      : undefined
    if (needsFreshActivation) {
      try {
        if (shouldInjectChinese) {
          cdpPort = await getAvailableLoopbackPort()
          activationProcessId = await activateCodexDesktopWithCdp(desktopAppPath, cdpPort)
          cdpActivationProcessId = activationProcessId
          // CDP activation starts a fresh Electron process. The official
          // deep link then attaches the configured workspace to that process.
          await launchFresh()
        } else {
          await launchFresh()
        }
        activatedViaAppModel = shouldInjectChinese
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // CDP activation may be unavailable on a damaged Store registration
        // or an older Windows build. The ordinary AppModel/AppsFolder route
        // remains the safe fallback and never exposes a folder window.
        console.warn(`[codex-launch] 增强启动不可用，回退普通启动：${message}`)
        cdpPort = null
        cdpActivationProcessId = null
        try {
          await launchFresh()
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          throw new Error(`无法发送 Codex 桌面端启动请求：${fallbackMessage}`)
        }
      }
    } else {
      try {
        await launchFresh()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`无法发送 Codex 桌面端启动请求：${message}`)
      }
    }

    heartbeat?.setStage('waiting-window')
    let startedProcesses = await waitForCodexDesktopSessionProcesses(
      activatedViaAppModel || workspaceLaunchDelivered
        ? codexDesktopLaunchInitialWaitMs
        : codexDesktopLaunchFallbackWaitMs,
      packageFamilyName,
    )

    const processFromActivationPid = async (): Promise<number[]> => {
      if (activationProcessId === null || !await waitForProcessId(activationProcessId, 2_000)) return []
      return [activationProcessId]
    }
    if (!startedProcesses.length) startedProcesses = await processFromActivationPid()

    if (!startedProcesses.length && workspaceLaunchDelivered) {
      // COM activation can be unavailable for a per-user Store registration
      // while Explorer still knows how to activate the package. Retry only
      // the plain AppsFolder route; sending codex:// to Explorer can open the
      // selected workspace as a File Explorer window.
      cdpPort = null
      cdpActivationProcessId = null
      try {
        await launchWithExplorer()
        startedProcesses = await waitForCodexDesktopSessionProcesses(
          codexDesktopLaunchFallbackWaitMs, packageFamilyName,
        )
      } catch {
        // The common error below includes the same actionable launch context.
      }
    }
    // AppX activation returns the application PID even when WMI is slow or
    // temporarily unable to expose the packaged executable path. The first
    // PID check normally settles this; repeat after Explorer only in case the
    // process was still crossing the AppModel boundary at the first check.
    if (!startedProcesses.length) startedProcesses = await processFromActivationPid()
    if (!startedProcesses.length) {
      // 先停心跳再去探测账户设置：失败框弹出之前工具行不该再冒一句「还在等」。
      const waitedSeconds = heartbeat?.elapsedSeconds()
      heartbeat?.stop()
      const launchContext = await inspectWindowsStoreAppLaunchContext()
      throw new Error(describeCodexDesktopLaunchFailure(
        launchContext,
        waitedSeconds === undefined ? undefined : { waitedSeconds, processSeen: activationProcessId !== null },
        resolveCodexDesktopKnownIssue([desktopApp.version, desktopApp.appVersion]),
      ))
    }
    if (cdpPort !== null) {
      try {
        const injection = await injectCodexDesktopChineseLocale(cdpPort, {
          expectedProcessId: cdpActivationProcessId,
        })
        chineseLocale = { status: 'verified' }
        console.info(`[codex-locale] 已注入 Codex Desktop 中文运行时补丁（${injection.injectedTargets} 个页面）`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A failed enhancement must not leave a successfully launched client
        // looking broken. config.toml remains authoritative for future builds.
        console.warn(`[codex-locale] 中文运行时补丁未生效，保留已启动客户端：${message}`)
        chineseLocale = { status: 'failed', message: `Codex 已打开，但未确认中文界面生效：${message.slice(0, 300)}。可再次启用中文界面重试。` }
      }
    }
    const runningStatus = { ...desktopApp, running: true }
    sendCodexDesktopStatus(target, 'running', runningStatus)
    return { restarted, status: runningStatus, ...(chineseLocale ? { chineseLocale } : {}) }
  }

  /**
   * Launching replaces no machine-level directory itself, but it must not run
   * while one is being replaced. The busy flag alone only covers an install
   * that is already executing, so a launch could still slip in between the
   * enqueue and the first line of the install task and be killed moments later
   * (E-B7). Identical requests keep sharing one promise, so a double click
   * stays idempotent; a different mode or locale intent must not inherit
   * another launch's result.
   */
  function launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
    launchOptions: CodexDesktopLaunchOptions = {},
  ): Promise<CodexDesktopLaunchResult> {
    return installationQueue.enqueue(
      `desktop:codex:launch:${mode}:${launchOptions.injectChinese ? 'zh-CN' : 'default'}`,
      async () => {
        // 只有 Windows 这一路会等窗口等到近一分钟；macOS 交给系统打开，几秒就回来。
        const heartbeat = platform === 'win32'
          ? startCodexDesktopLaunchHeartbeat((progress) => sendCodexDesktopLaunchProgress(target, progress))
          : undefined
        try {
          return await launchCodexDesktopOperation(mode, target, launchOptions, heartbeat)
        } finally {
          heartbeat?.stop()
        }
      },
    )
  }

  return {
    inspectCodexDesktop,
    inspectCodexDesktopUpdate,
    installCodexDesktop,
    cancelCodexDesktopInstall,
    uninstallCodexDesktop,
    resetCodexDesktop,
    launchCodexDesktop,
  }
}
