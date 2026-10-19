// 首页检测的那一段（#1070 第 3 步，从 system-service.ts 的 createSystemService 原样搬来）：网络位置、Node / Python /
// Git 和四家命令行工具装没装、装的哪一版、有没有新版（npm 查最新版、Grok 查自己的版本清单），哪些工具正开着，
// Codex 官方账号的用量，整轮检测的合并、限流和落盘缓存，以及 Codex 首次设置检查。
//
// 各簇共用的那份在 system-service-context.ts；起 CLI 子进程的环境和 Codex 桌面端那两样探测由 createSystemService
// 传进来（SystemScanServiceDependencies）。这里只 import system-service.ts 的类型。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { MirrorPolicy } from './app-settings'
import { readBoundedUtf8File } from './bounded-file'
import { BoundedOperationQueue } from './bounded-operation-queue'
import { readBoundedResponseText } from './bounded-response'
import { activeProviderIds, cliCatalog, type ProviderId, retiredProviderIds } from './catalog'
import { readPackageManifestVersion } from './cli-native-package'
import {
  cliPackageDirectory as cliPackageDirectoryFromNpmRoot,
  managedCliPackageDirectory,
  probeRunningCliProcesses,
} from './cli-process-probe'
import { resolveCliRevertVersion } from './cli-update-history'
import { buildCliVersionAdvice, type CliVersionAdvice } from './cli-verified-versions'
import { isCodexDesktopExecutable } from './codex-desktop'
import { desktopUpdateFields } from './codex-desktop-service'
import { cleanCommandOutput, commandEnvironment, trustedCommandEnvironment } from './command-runner'
import { readCodexAuthTokens } from './config-files'
import { fetchGrokStableVersion } from './grok-update'
import { resolveLinuxGrokInstalledVersion } from './linux-grok'
import { isCommandLineToolsShimBacked, isMacOsCommandLineToolsShim } from './macos-command-line-tools'
import { ensureDarwinGrokAgentLink, resolveDarwinGrokCanonicalSelection } from './macos-grok'
import { managedNativeProviderRoot, managedNpmPrefix } from './managed-cli-paths'
import { classifyNetworkFailure, toolCertificateMessages } from './network-failure'
import { createNetworkLocationCache, reloadNetworkProxyConfiguration } from './network-location-cache'
import {
  maximumNpmRegistryResponseBytes,
  npmInstallRegistries,
  npmLatestQueryTimeoutMs,
  npmMirrorRegistry,
  npmPackageLatestUrl,
} from './npm-registry'
import type { OfficialChatGptAccount } from './official-account-usage'
import { grokInstallStrategyFor } from './platform-capabilities'
import { describeProbeFailure } from './probe-failure'
import { isPython312RuntimeVersion } from './python-runtime'
import {
  cliProcessProbeRoots,
  inspectRunningTools as inspectRunningToolsWith,
  type RunningToolsReport,
} from './running-tools'
import { toolCertificateFailureKind } from './system-certificate-trust'
import type {
  CliStatus,
  CodexSetupStatus,
  DesktopAppStatus,
  LatestVersionProbe,
  NetworkLocationStatus,
  NetworkRegion,
  SystemSnapshot,
  ToolStatus,
} from './system-service'
import { buildToolStatusFromSettled, scanReuseMs, type ServiceContext } from './system-service-context'
import { createSystemSnapshotCache } from './system-snapshot-cache'
import { classifyCliInstallDisplaySource, type CliInstallation, cliUninstallCapability } from './tool-installation'
import { isExactCliVersion, isNewerVersion, nodeVersionStatus } from './versions'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)
const npmLatestCacheTtlMs = 10 * 60_000
const npmLatestFailureCacheTtlMs = 2 * 60_000
export const networkLocationCacheTtlMs = 10 * 60_000
const networkLocationUrl = 'https://www.cloudflare.com/cdn-cgi/trace'
const networkLocationFallbackUrls = [
  'https://myip.ipip.net/',
  'https://ipapi.co/json/',
  'https://ipinfo.io/json',
] as const

const maximumGrokVersionMetadataBytes = 16 * 1024

/**
 * internal #20 (second-round darwin verification): every entry point that
 * decides whether to run a fresh install — the dashboard's per-card button,
 * "安装全部缺失项", and the maintenance page's batch action — gates purely on
 * `status.installed`, which has only ever come from the canonical `grok`
 * link (resolveDarwinGrokCanonicalSelection); `agent` has never been part of
 * that determination (see inspectCliTool below). So once grok reads as
 * installed, nothing user-reachable ever re-invokes ensureDarwinGrokAgentLink
 * for it again — the only thing that does is a fresh
 * runDarwinGrokPostInstallTransaction, which only runs when npm actually has
 * something to (re)install. Folding the same idempotent, non-destructive
 * ensure into every "is grok in place" probe means the very next scan or
 * update check repairs the gap on its own, regardless of how grok ended up
 * without its companion link — independent of, and in addition to, the
 * transaction every install/reinstall already runs.
 *
 * Best-effort by design: a failure here (permissions, a mid-scan uninstall,
 * a non-canonical install) must never turn a healthy "installed" status into
 * a false "not installed" — inspectCliTool's contract is to probe state, not
 * throw, so this swallows everything.
 */
async function ensureDarwinGrokAgentLinkQuietly(homeDirectory: string): Promise<void> {
  try {
    const selection = resolveDarwinGrokCanonicalSelection(homeDirectory)
    await ensureDarwinGrokAgentLink(homeDirectory, selection)
  } catch {
    // Best effort — see docstring above. The next successful probe, or an
    // explicit reinstall, gets another chance.
  }
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
    return typeof candidate === 'string' && isExactCliVersion(candidate.trim())
      ? candidate.trim()
      : null
  } catch {
    return isExactCliVersion(trimmed) ? trimmed : null
  }
}

export function parseGrokLocalVersion(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    for (const key of ['version', 'stable_version']) {
      const value = record[key]
      if (typeof value === 'string' && isExactCliVersion(value.trim())) {
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
  if (platform === 'linux') {
    // npm 的 postinstall 不写 version.json，版本在 ~/.grok/bin/grok 指向的文件名里（Linux 版拆分 ③）。
    const version = resolveLinuxGrokInstalledVersion(options.homeDirectory ?? os.homedir(), executablePath)
    if (version) return version
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

function parseFallbackNetworkLocation(
  input: string,
  sourceUrl: string,
): { publicIp: string; countryCode: string } | null {
  const trimmed = input.trim()
  if (sourceUrl.includes('myip.ipip.net')) {
    const ip = trimmed.match(/(?:当前\s*IP|IP)\s*[:：]\s*([0-9a-f:.]+)/i)?.[1] ?? ''
    const publicIp = isIP(ip) ? ip : ''
    const countryCode = /中国|China/i.test(trimmed)
      ? 'CN'
      : /美国|United States|USA/i.test(trimmed)
        ? 'US'
        : /日本|Japan/i.test(trimmed)
          ? 'JP'
          : /新加坡|Singapore/i.test(trimmed) ? 'SG' : ''
    if (publicIp && countryCode) return { publicIp, countryCode }
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const ipCandidate = typeof record.ip === 'string' ? record.ip.trim() : ''
    const publicIp = isIP(ipCandidate) ? ipCandidate : ''
    const countryCandidate = typeof record.country_code === 'string'
      ? record.country_code
      : typeof record.country === 'string' ? record.country : ''
    const countryCode = countryCandidate.trim().toUpperCase()
    return publicIp && /^[A-Z]{2}$/.test(countryCode) ? { publicIp, countryCode } : null
  } catch {
    return null
  }
}

export async function detectNetworkLocation(
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 2_500,
): Promise<NetworkLocationStatus> {
  const checkedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  const fallbackProbe = async (): Promise<NetworkLocationStatus | null> => {
    // The primary Cloudflare probe can already consume its full timeout on
    // mainland networks. Give the fallback chain its own budget instead of
    // leaving the usable IPIP endpoint only a few hundred milliseconds.
    const deadline = Date.now() + Math.max(1_000, timeoutMs)
    for (const fallbackUrl of networkLocationFallbackUrls) {
      const remainingMs = Math.max(200, deadline - Date.now())
      const fallbackController = new AbortController()
      const fallbackTimeout = setTimeout(() => fallbackController.abort(), remainingMs)
      fallbackTimeout.unref?.()
      try {
        const fallbackResponse = await fetchImplementation(fallbackUrl, {
          method: 'GET',
          headers: { Accept: 'text/plain' },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: fallbackController.signal,
        })
        if (!fallbackResponse.ok) continue
        const fallbackBody = await readBoundedResponseText(fallbackResponse, 256, '备用网络位置')
        const location = parseFallbackNetworkLocation(fallbackBody, fallbackUrl)
        if (!location) continue
        return {
          publicIp: location.publicIp,
          countryCode: location.countryCode,
          region: location.countryCode === 'CN' ? 'mainland-china' : 'outside-mainland-china',
          checkedAt,
          error: null,
        }
      } catch {
        // Try the next provider within the shared fallback deadline.
      } finally {
        clearTimeout(fallbackTimeout)
      }
    }
    return null
  }
  try {
    const response = await fetchImplementation(networkLocationUrl, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      const fallback = await fallbackProbe()
      if (fallback) return fallback
      return {
        publicIp: null,
        countryCode: null,
        region: 'unknown',
        checkedAt,
        error: `网络位置服务返回 HTTP ${response.status}`,
      }
    }
    const body = await readBoundedResponseText(response, 32 * 1024, '网络位置')
    const primary = parseCloudflareNetworkLocation(body, checkedAt)
    // A Cloudflare response may contain `loc=CN` while omitting `ip` on
    // restricted/proxied networks. Treat that as partial data so the
    // fallback providers still get a chance to supply the missing address.
    if (primary.region !== 'unknown' && primary.publicIp) return primary

    // Some mainland networks can reach the relay but block Cloudflare's
    // trace endpoint. A tiny country-only fallback keeps mirror selection and
    // the dashboard location useful without sending a second request when the
    // primary probe already returned a valid country.
    return (await fallbackProbe()) ?? primary
  } catch (error) {
    const fallback = await fallbackProbe()
    if (fallback) return fallback
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
 * IMPROVEMENT-PLAN 2.4: a user-pinned mirror policy overrides the probed
 * region by reducing to the region that yields the desired order. Both
 * npmInstallRegistries and nodeRuntimeDownloadSources branch only on
 * 'outside-mainland-china' vs everything else, so this single reduction
 * covers every source-order decision without touching their signatures --
 * and a pinned policy lets install paths skip the region probe entirely,
 * which in a blocked network is itself the unreliable step.
 *
 * Deliberately NOT applied to the Codex desktop manifest: its bytes are
 * mirror-only, so the manifest must stay mirror-first regardless of policy
 * or the card can advertise a release the install path cannot fetch (see
 * buildCodexDesktopManifestSources).
 */
export function effectiveNetworkRegion(
  policy: MirrorPolicy | undefined,
  detected: NetworkRegion,
): NetworkRegion {
  if (policy === 'mirror-first') return 'mainland-china'
  if (policy === 'official-first') return 'outside-mainland-china'
  return detected
}

/**
 * 「有没有新版」去哪问。Windows 的 Grok 以 xAI 的 stable 清单为准；macOS 与 Linux 的 Grok 从
 * npm 装，也就问 npm：x.ai 和它的备用地址在国内大多连不上，Linux 第一版又没有加速，Mac 上
 * yoyo 2026-10-14 定了照 Linux 只问 npm（去加速）。不给平台时按 stable 清单答，和以前一样。
 */
export function cliLatestVersionSource(
  provider: ProviderId,
  platform?: NodeJS.Platform,
): 'npm' | 'official-manifest' {
  if (provider !== 'grok') return 'npm'
  const strategy = platform ? grokInstallStrategyFor(platform) : null
  return strategy === 'linux-official-npm' || strategy === 'darwin-official-npm' ? 'npm' : 'official-manifest'
}

export interface CliInstallTargetOptions {
  platform: NodeJS.Platform
  /** 当前 npm 全局根；探测不到时为 null。 */
  npmGlobalRoot: string | null
  /** 这一次安装会不会落进托管 npm 布局，落则给出它的 prefix，否则 null。 */
  managedNpmPrefix: string | null
  /**
   * Grok 不落在 node_modules 里：Windows 上走原生通道装进这个目录，Linux 上 npm 的
   * postinstall 把程序放进 ~/.grok/bin。
   */
  managedNativeRoot: string | null
}

/**
 * 还没装上的工具没有安装目录——目录要等安装那一步写完才存在。错误面板上的
 * 「复制路径」要回答的却是「它会装到哪」，用户拿这个路径去查写入权限或加进
 * 杀毒白名单。所以这里按 installCli 自己的选路重算一遍落点：托管布局优先，
 * Grok 的 Windows 原生通道单列，其余落在当前 npm 全局根下。
 *
 * 算不出来时返回 null，界面据此不出那颗按钮——一个猜出来的路径比没有更糟。
 */
export function cliInstallTargetDirectory(
  provider: ProviderId,
  options: CliInstallTargetOptions,
): string | null {
  const grokStrategy = provider === 'grok' ? grokInstallStrategyFor(options.platform) : null
  if (grokStrategy === 'windows-native' || grokStrategy === 'linux-official-npm') {
    return options.managedNativeRoot
  }
  const packageName = cliCatalog[provider].packageName
  if (options.managedNpmPrefix) {
    return managedCliPackageDirectory(options.managedNpmPrefix, packageName, options.platform)
  }
  return options.npmGlobalRoot ? cliPackageDirectoryFromNpmRoot(options.npmGlobalRoot, packageName) : null
}

function containsComparableVersion(value: string | null): boolean {
  return typeof value === 'string'
    && /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.test(value)
}

/** 离线时给四家 CLI 最新版探测的总预算：到点先出画面，不让首屏干等各自的超时。 */
export const offlineLatestVersionBudgetMs = 3_000

/** 预算到点仍未返回时，版本列上显示的那句话。 */
export const latestVersionUncheckedMessage = '当前可能没有网络，这次没有检查最新版本'

/**
 * 网络位置探测没能给出结果 = 这会儿八成没网。离线时每家 CLI 的最新版探测都会各自
 * 耗满自己的超时（npm 8 秒、Grok 清单 10 秒），首屏就卡在这上面十几秒，而本地已装
 * 版本其实一瞬间就读出来了。探测接口自己挂了却仍能上网时会误判，代价只是这一次不
 * 显示「有新版本」，下次扫描或手动刷新会补上。
 */
export function networkProbeSuggestsOffline(
  network: Pick<NetworkLocationStatus, 'region' | 'error'>,
): boolean {
  return network.region === 'unknown' && network.error !== null
}

/** 没检查最新版时的占位结果：未安装的照旧算 skipped，已装的算 failed 并带上原因。 */
export function buildUncheckedLatestVersion(
  provider: ProviderId,
  installed: boolean,
  checkedAt: string = new Date().toISOString(),
  platform?: NodeJS.Platform,
): LatestVersionProbe {
  const source = cliLatestVersionSource(provider, platform)
  return installed
    ? { status: 'failed', version: null, source, checkedAt, error: latestVersionUncheckedMessage }
    : { status: 'skipped', version: null, source, checkedAt, error: null }
}

/**
 * 给一批最新版探测套一个总预算。`budgetMs` 为 null 时等齐（联网时的老行为）；到点
 * 还没回来的项用占位结果顶上，那几个 Promise 仍会在后台自己走完并把结果写进缓存，
 * 这里不再等、也不重新发起——联网后靠下一次扫描或用户点刷新补上，不加定时器。
 *
 * 传入 `budgetExpired` 时，预算到点会顺手 abort 它。探测那侧据此知道「这一轮的结果
 * 已经没人要了」，手里那次请求照旧跑完（它可能给缓存留下有用的结果），但不再往备用
 * 源发新的请求——否则一批被丢弃的探测会在后台继续出网，在测试里还会串进后面的用例。
 */
export async function settleLatestVersionProbes(
  probes: readonly Promise<LatestVersionProbe>[],
  unchecked: readonly LatestVersionProbe[],
  budgetMs: number | null,
  budgetExpired?: AbortController,
): Promise<LatestVersionProbe[]> {
  const settled = probes.map((probe, index) => probe.then(
    (value) => value,
    (reason): LatestVersionProbe => ({
      ...unchecked[index],
      status: 'failed',
      error: reason instanceof Error ? reason.message : String(reason),
    }),
  ))
  if (budgetMs === null) return Promise.all(settled)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      budgetExpired?.abort()
      resolve('timeout')
    }, budgetMs)
    timer.unref?.()
  })
  try {
    return await Promise.all(settled.map(async (probe, index) => {
      const outcome = await Promise.race([probe, deadline])
      return outcome === 'timeout' ? unchecked[index] : outcome
    }))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 下线工具在快照里的占位：当作没装、没查过更新，不给卸载、不给推荐版本。 */
export function buildRetiredCliStatus(provider: ProviderId, platform?: NodeJS.Platform): CliStatus {
  return {
    ...buildCliStatus(
      { installed: false, version: null, path: null, installDirectory: null },
      buildUncheckedLatestVersion(provider, false, undefined, platform),
    ),
    retired: true,
  }
}

export function buildCliStatus(
  installed: ToolStatus,
  latest: LatestVersionProbe,
  versionAdvice?: CliVersionAdvice,
  revertVersion?: string | null,
): CliStatus {
  const base = {
    ...installed,
    ...(versionAdvice ? { versionAdvice } : {}),
    ...(revertVersion && installed.installed ? { revertVersion } : {}),
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
    // npm latest 变新并不代表推荐安装目标也变新；同版重装和退回推荐版
    // 都不是更新。latestVersion 仍保留真实上游版本供界面说明。
    if (versionAdvice?.pinned && versionAdvice.recommendedVersion
      && !isNewerVersion(installed.version, versionAdvice.recommendedVersion)) {
      return { ...base, updateAvailable: false, updateState: 'latest', updateError: null }
    }
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

export function buildNetworkLocationStatusFromSettled(
  result: PromiseSettledResult<NetworkLocationStatus>,
  checkedAt: string = new Date().toISOString(),
): NetworkLocationStatus {
  if (result.status === 'fulfilled') return result.value
  return {
    publicIp: null,
    countryCode: null,
    region: 'unknown',
    checkedAt,
    error: describeProbeFailure(result.reason),
  }
}

export function buildDesktopAppStatusFromSettled(
  result: PromiseSettledResult<DesktopAppStatus>,
): DesktopAppStatus {
  if (result.status === 'fulfilled') return result.value
  const error = describeProbeFailure(result.reason)
  return {
    installed: false,
    version: null,
    path: null,
    installDirectory: null,
    appVersion: null,
    mirrorVersion: null,
    mirrorUpdateAvailable: null,
    mirrorError: null,
    running: false,
    detectionFailed: true,
    detectionError: error,
    ...desktopUpdateFields('failed', error, null),
  }
}

/**
 * `inspectCliTool` cannot join a `Promise.allSettled` alongside the runtime
 * probes above it: it needs the npm probe's resolved path first. A rejection
 * here must still degrade exactly like the others — distinguishably failed,
 * never silently "not installed" — otherwise onboarding could offer to
 * reinstall a CLI that may already be working.
 */
export function buildCliToolStatusFromSettled(
  result: PromiseSettledResult<{ status: ToolStatus }>,
): ToolStatus {
  return result.status === 'fulfilled' ? result.value.status : buildToolStatusFromSettled(result)
}

/** 一轮扫描里同时在跑的探测子进程上限（见 createSystemService 里的 limitedProbe）。 */
export const scanProbeConcurrency = 3

/**
 * 非强制的扫描先看手上有没有现成的：正在跑的那一轮直接接上，刚跑完不久（`reuseMs`
 * 以内）的那一轮直接拿来用，而不是再起一整套探测子进程。主进程开窗前先起一轮预热，
 * 首页随后那次读取、账号恢复后 Key 同步那次检查就都用它；低配机器上两轮探测抢同一
 * 时刻的 CPU 与磁盘，比串着跑还慢。
 *
 * 两种情况不复用：调用方要求强制重扫（「重新检测」、装完工具、保存配置之后），以及
 * 那一轮开始之后安装队列动过——它可能是在工具装好之前探的，拿它回答「装完了吗」
 * 会答错。`revision` 就是安装队列的读数。失败的那一轮不留。
 */
export function createScanCoalescer<T>(options: { run(force: boolean): Promise<T>; revision(): number; reuseMs: number; now?(): number }) {
  const now = options.now ?? Date.now
  let sequence = 0
  let inFlight: { promise: Promise<T>; revision: number } | null = null
  let latest: { value: T; revision: number; sequence: number; at: number } | null = null
  /** 手上现成的一轮：正在跑的，或 `maxAgeMs` 以内跑完的；安装队列动过就都不算。没有就是 null，不会新起一轮。 */
  function recent(maxAgeMs: number): Promise<T> | null {
    const revision = options.revision()
    if (inFlight && inFlight.revision === revision) return inFlight.promise
    if (latest && latest.revision === revision && now() - latest.at <= maxAgeMs) return Promise.resolve(latest.value)
    return null
  }
  function scan(force: boolean): Promise<T> {
    const current = force ? null : recent(options.reuseMs)
    if (current) return current
    const revision = options.revision()
    const started = ++sequence
    const promise = options.run(force)
    const entry = { promise, revision }
    inFlight = entry
    function release() { if (inFlight === entry) inFlight = null }
    void promise.then((value) => {
      if (!latest || latest.sequence < started) latest = { value, revision, sequence: started, at: now() }
      release()
    }, release)
    return promise
  }
  return { scan, recent }
}

/** 首页检测要用、但归别处管的几样，由 createSystemService 传进来。 */
export interface SystemScanServiceDependencies {
  /** 起 CLI 子进程用的环境：Codex 带它自己的 CODEX_HOME，Gemini 去掉星芒管的那几个变量（providerCommandEnvironment）。 */
  providerEnvironment: (provider: ProviderId) => NodeJS.ProcessEnv
  /** Codex 桌面端的两样探测归 codex-desktop-service.ts 管。 */
  inspectCodexDesktop: () => Promise<DesktopAppStatus>
  inspectCodexDesktopUpdate: (forceRefresh?: boolean) => Promise<DesktopAppStatus>
}

export function createSystemScanService(context: ServiceContext, dependencies: SystemScanServiceDependencies) {
  const {
    store, serviceOptions, windowsExecutionMode, platform, providerRoots, runtimeLog, cliUpdateHistory,
    inspectNativeProviderConfig, resolveVerifiedCliCommand, resolveCliInstallationForService, executeCommand,
    inspectInstalledPythonRuntimeForService, registryMetadataFetch, acceleratedDownloadCount, installationQueue,
    inspectOfficialUsage, findInstalledExecutable, forgetPreferredNodeDirectories, nodeCommandDirectories,
    resolveServiceNpmGlobalRoot, executeVersion, cliTerminalAccess, credentialFailureReason,
  } = context
  const {
    providerEnvironment,
    inspectCodexDesktop,
    inspectCodexDesktopUpdate,
  } = dependencies

  const npmLatestCache = new Map<string, { expiresAt: number; value: LatestVersionProbe }>()
  // 失效时递增，让失效前发起的在途查询放弃回写过期结果
  let npmLatestCacheGeneration = 0
  const grokLatestInFlight = new Map<string, Promise<LatestVersionProbe>>()
  const networkLocationCache = createNetworkLocationCache({
    ttlMs: networkLocationCacheTtlMs,
    probe: async (forceRefresh) => {
      if (forceRefresh && serviceOptions.reloadNetworkProxyConfig) {
        await reloadNetworkProxyConfiguration(serviceOptions.reloadNetworkProxyConfig)
      }
      return detectNetworkLocation(serviceOptions.networkLocationFetch ?? fetch)
    },
  })
  let officialChatGptCache: { expiresAt: number; value: OfficialChatGptAccount | null } | null = null

  function inspectNetworkLocation(forceRefresh = false): Promise<NetworkLocationStatus> {
    return networkLocationCache.read(forceRefresh)
  }

  function refreshNetworkLocation(): Promise<SystemSnapshot['network']> {
    return inspectNetworkLocation(true)
  }

  async function inspectNetworkRegion(): Promise<NetworkRegion> {
    // 2.4：镜像策略被用户钉死时不再探测——直接归约到产生所需源顺序的
    // region。scanSystem 的网络状态卡片仍走真实探测（inspectNetworkLocation），
    // 展示保持诚实，这里只决定安装/版本检查的源顺序。
    const policy = store.read().mirrorPolicy
    if (policy) return effectiveNetworkRegion(policy, 'unknown')
    // 加速已经为这次下载起来了：线路本来就是为直连官方源准备的，再绕镜像
    // 没有意义。顺带省掉一次区域探测——网络受限时那一步本身最不可靠。
    if (acceleratedDownloadCount() > 0) return effectiveNetworkRegion('official-first', 'unknown')
    return (await inspectNetworkLocation()).region
  }

  async function inspectTool(command: string, args = ['--version']): Promise<ToolStatus> {
    const executable = await findInstalledExecutable(command)
    if (!executable) return { installed: false, version: null, path: null, installDirectory: null }
    // 没装命令行开发者工具的 Mac 上，/usr/bin/git 与 /usr/bin/python3 一跑就弹苹果的
    // 安装对话框；背后那份不在就当没找到，别每次扫描都把弹窗招出来。
    if (
      isMacOsCommandLineToolsShim(executable, platform)
      && !await isCommandLineToolsShimBacked(executable, { runCommand: executeCommand })
    ) {
      return { installed: false, version: null, path: null, installDirectory: null }
    }
    let version = await executeVersion(
      executable,
      args,
      command.toLowerCase() === 'npm' ? 'npm' : undefined,
      process.env,
      await nodeCommandDirectories(command),
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

  /**
   * npm 报「证书被换掉」时，说清是哪一种（system-certificate-trust.ts）。npm 已经带着
   * 「也信任这台电脑的证书」去跑、仍然失败的，原文不动，交给渲染层「连接被网络拦截」
   * 那条。Node 版本读 PATH 上的 node：npm 就是由它跑起来的。读不出版本就不下结论。
   */
  async function withToolCertificateHint(message: string, raw = message): Promise<string> {
    // 上屏那句只剩中文原因和错误码，拿 npm 的原话认（#1100 第1条连带 2）。
    if (classifyNetworkFailure(raw) !== 'tls') return message
    const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
    let nodeVersion: string | null = null
    if (!trustedOnly) {
      try { nodeVersion = (await inspectTool('node')).version } catch { nodeVersion = null }
    }
    const kind = toolCertificateFailureKind({ trustedOnly, nodeVersion })
    return kind ? `${message.replace(/。$/, '')}。${toolCertificateMessages[kind]}` : message
  }

  async function inspectNode(): Promise<ToolStatus> {
    const status = await inspectTool('node')
    if (!status.installed) return { ...status, tooOld: false, versionStatus: 'unknown' }
    const versionStatus = nodeVersionStatus(status.version)
    return { ...status, tooOld: versionStatus === 'too-old', versionStatus }
  }

  /**
   * 安装那一步的落点选择（installCli）在这里重放一遍，只为把「会装到哪」交给
   * 界面。ProgramData / ~/Library 这两条托管路径在个别机器上算不出来（缺少可信
   * 的 ProgramData、HOME 为空），那属于正常情况，吞掉后退回 null 即可——探测
   * 不该因为一个附带字段失败。
   */
  function resolveCliInstallTarget(provider: ProviderId, npmGlobalRoot: string | null): string | null {
    try {
      const managed = platform === 'win32'
        ? windowsExecutionMode === 'trusted-only' ? managedNpmPrefix() : null
        : provider !== 'grok' ? managedNpmPrefix(commandEnvironment(), platform) : null
      return cliInstallTargetDirectory(provider, {
        platform,
        npmGlobalRoot,
        managedNpmPrefix: managed,
        managedNativeRoot: provider !== 'grok'
          ? null
          : platform === 'win32'
            ? managedNativeProviderRoot('grok')
            : path.join(commandEnvironment().HOME?.trim() || os.homedir(), '.grok', 'bin'),
      })
    } catch {
      return null
    }
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
    const installTarget = resolveCliInstallTarget(provider, npmGlobalRoot ?? null)
    if (
      !installation
      || (provider === 'codex' && installation.source === 'native'
        && isCodexDesktopExecutable(installation.commandPath))
    ) {
      return {
        status: { installed: false, version: null, path: null, installDirectory: null, installTarget },
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
        if (platform === 'darwin') {
          await ensureDarwinGrokAgentLinkQuietly(cliEnvironment.HOME?.trim() || os.homedir())
        }
      }
      return { status: {
        installed: true,
        // Reading an npm package manifest avoids unnecessary CLI execution and
        // remains safe even when the app was manually started as administrator.
        version,
        // Grok 的安装/更新走原生通道（非 npm），首页对它保留朴素的「已安装」与既有
        // 更新按钮，不做来源标注；其余三个 CLI 的安装通道是 npm，标注来源后原生/其他
        // 来源装的那份才好挡住 npm 重装。
        installSource: provider === 'grok'
          ? undefined
          : classifyCliInstallDisplaySource(installation, {
              env: cliEnvironment,
              platform,
            }),
        path: installation.source === 'native'
          ? provider === 'grok'
            ? installation.commandPath
            : platform === 'darwin' && safeNativeCommand?.verifiedDarwinStandalone
              ? safeNativeCommand.verifiedDarwinStandalone.executablePath
              : safeNativeCommand?.executable ?? null
          : installation.commandPath,
        installDirectory: installation.installDirectory,
        installTarget,
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
      if (isPython312RuntimeVersion(result.version)) return result
      if (!isWindowsAppExecutionAlias(result.path)) fallback ??= result
    }
    if (platform === 'win32') {
      try {
        const inspected = await inspectInstalledPythonRuntimeForService()
        return {
          installed: true,
          version: inspected.version,
          path: inspected.executable,
          installDirectory: path.dirname(inspected.executable),
        }
      } catch {
        // The fixed current-user Python 3.12 location is an additional probe,
        // not a reason to turn a normal "not installed" result into a failure.
      }
    }
    if (fallback) return fallback
    return { installed: false, version: null, path: null, installDirectory: null }
  }

  /**
   * `git --version` 打印的是「git version 2.43.0.windows.1」，整行放进运行环境行里
   * 会把「Git」重复一遍，所以只留版本号；解析不出来时按其余运行环境的老规矩留空，
   * 由渲染层退回中性的「已安装」。探测本身抛错时不在这里吞掉，交给 scanSystem 的
   * allSettled 归成「检测失败」——缺 Git 与探不到 Git 对用户是两件事（A4）。
   */
  async function inspectGit(): Promise<ToolStatus> {
    const status = await inspectTool('git')
    if (!status.installed) return status
    return { ...status, version: normalizeRuntimeVersion('git', status.version) }
  }

  async function inspectLatestNpmVersion(
    packageName: string,
    networkRegion: NetworkRegion,
    budgetSignal?: AbortSignal,
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
        const response = await registryMetadataFetch(npmPackageLatestUrl(registry, packageName), {
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
      // 预算到点了：这一轮的结果已经被占位顶掉，没人会用。再往备用源发一次请求
      // 只是在后台空转（离线时它注定也要耗满自己的超时），停在这里等下一次扫描。
      if (budgetSignal?.aborted) break
    }
    value ??= {
      status: 'failed',
      version: null,
      source: 'npm',
      checkedAt,
      error: errors.join('；') || 'npm 版本查询失败',
    }
    // 预算到点后攒出来的失败不写缓存：写了会把这份可能还没试完备用源的结论
    // 按失败 TTL 钉住，让紧跟着的那次扫描连试都不试。查成了的照写不误。
    const abandoned = value.status !== 'checked' && budgetSignal?.aborted === true
    if (!abandoned && generation === npmLatestCacheGeneration) {
      const ttl = value.status === 'checked' ? npmLatestCacheTtlMs : npmLatestFailureCacheTtlMs
      npmLatestCache.set(cacheKey, { expiresAt: Date.now() + ttl, value })
    }
    return value
  }

  async function inspectLatestGrokVersion(budgetSignal?: AbortSignal): Promise<LatestVersionProbe> {
    const cacheKey = 'official:grok:stable'
    const cached = npmLatestCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existingProbe = grokLatestInFlight.get(cacheKey)
    if (existingProbe) return existingProbe

    const probe = (async (): Promise<LatestVersionProbe> => {
      const checkedAt = new Date().toISOString()
      try {
        const result = await fetchGrokStableVersion({ abandonedSignal: budgetSignal, fetchImpl: registryMetadataFetch })
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
      // invalidate 会清空 in-flight 表，比对可拦住失效前发起的过期回写；
      // 预算到点后攒出来的失败同样不写，理由与 npm 那边一样。
      const abandoned = value.status !== 'checked' && budgetSignal?.aborted === true
      if (!abandoned && grokLatestInFlight.get(cacheKey) === probe) {
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
      // macOS、Linux 的 Grok 问的是 npm（cliLatestVersionSource），下面那份也要清。
      if (cliLatestVersionSource(provider, platform) === 'official-manifest') return
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
    budgetSignal?: AbortSignal,
  ): Promise<LatestVersionProbe> {
    const source = cliLatestVersionSource(provider, platform)
    if (!installed.installed) {
      return {
        status: 'skipped',
        version: null,
        source,
        checkedAt: new Date().toISOString(),
        error: null,
      }
    }
    if (source === 'official-manifest') {
      return inspectLatestGrokVersion(budgetSignal)
    }
    return inspectLatestNpmVersion(cliCatalog[provider].packageName, networkRegion, budgetSignal)
  }

  /**
   * 进程检测要的是「用户实际在跑的那一份」装在哪，和启动工具时用的是同一套发现
   * （resolveCliInstallation），而不是安装流程里「npm 这次会装到哪」的那个推算：
   * 两者在用户自己改过 npm 全局目录、或同时装了两份时并不相同。npm 与它的全局
   * 目录对所有工具只算一次，只找路径、不跑任何工具的 --version。
   */
  async function inspectRunningTools(providers: readonly ProviderId[]): Promise<RunningToolsReport> {
    let npmLocation: Promise<{ npmExecutable: string | null; npmGlobalRoot: string | null }> | null = null
    function locateNpm() {
      npmLocation ??= (async () => {
        const npmExecutable = await findInstalledExecutable('npm')
        return { npmExecutable, npmGlobalRoot: await resolveServiceNpmGlobalRoot(npmExecutable) }
      })()
      return npmLocation
    }
    return inspectRunningToolsWith(providers, {
      probeRoots: async (provider) => {
        const { npmExecutable, npmGlobalRoot } = await locateNpm()
        const installation = await resolveCliInstallationForService(provider, {
          env: providerEnvironment(provider),
          npmExecutable,
          npmGlobalRoot,
          platform,
        })
        // 与 inspectCliTool 同一条排除：命令行找到的若是桌面端自带的 codex，那是
        // 桌面端的进程，下面单独问桌面端，别在这里再算一遍 Codex CLI。
        if (installation && provider === 'codex' && installation.source === 'native'
          && isCodexDesktopExecutable(installation.commandPath)) return []
        return cliProcessProbeRoots(installation, platform)
      },
      probe: (root) => probeRunningCliProcesses(root, { platform }),
      codexDesktopRunning: async () => {
        if (platform !== 'win32' && platform !== 'darwin') return false
        const status = await inspectCodexDesktop()
        if (status.running) return true
        return status.detectionFailed ? null : false
      },
      canRestartCodexDesktop: platform === 'win32',
    })
  }

  async function inspectCliUpdate(
    provider: ProviderId,
    forceRefresh = false,
  ): Promise<CliStatus> {
    if (forceRefresh) invalidateCliUpdateCache(provider)
    // 同「打开」那条路（launchProviderOperation）：检查更新只用得上 npm 在哪，
    // 用不上它的版本号，别为此多起一次 `npm --version`。路径照旧每次现查，不缓存。
    const npmPath = await findInstalledExecutable('npm')
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
    const { status } = await inspectCliTool(provider, npmPath, npmGlobalRoot)
    const networkRegion = cliLatestVersionSource(provider, platform) === 'npm' && status.installed
      ? await inspectNetworkRegion()
      : 'unknown'
    const latest = await inspectCliLatestVersion(provider, status, networkRegion)
    const settings = store.read()
    return buildCliStatus(status, latest, buildCliVersionAdvice(provider, status.version, {
      siteId: settings.relaySiteId,
      alwaysLatest: settings.alwaysInstallLatestCli === true,
    }), resolveCliRevertVersion(provider, cliUpdateHistory.read()[provider], status.version, Date.now(), settings.relaySiteId))
  }

  async function inspectOfficialChatGptAccount(forceRefresh: boolean): Promise<OfficialChatGptAccount | null> {
    if (forceRefresh) officialChatGptCache = null
    if (officialChatGptCache && officialChatGptCache.expiresAt > Date.now()) {
      return officialChatGptCache.value
    }
    const inspection = inspectNativeProviderConfig('codex')
    if (inspection.hasApiKey) {
      officialChatGptCache = { expiresAt: Date.now() + 45_000, value: null }
      return null
    }
    const value = await inspectOfficialUsage(readCodexAuthTokens(providerRoots), {
      fallback: {
        planLabel: inspection.officialAccountPlan,
        renewsAt: inspection.officialAccountRenewsAt,
      },
    })
    officialChatGptCache = { expiresAt: Date.now() + 45_000, value }
    return value
  }

  async function refreshOfficialChatGptUsage(): Promise<OfficialChatGptAccount | null> {
    return inspectOfficialChatGptAccount(true)
  }

  const snapshotCache = serviceOptions.systemSnapshotCacheFile && serviceOptions.appVersion
    ? createSystemSnapshotCache({
        filePath: serviceOptions.systemSnapshotCacheFile,
        appVersion: serviceOptions.appVersion,
        onWarning: (code, message) => runtimeLog?.log('warn', 'system', code, '上次检测结果没有读写成功', { error: message }),
      })
    : null
  let scanCompleted = false
  let scansStarted = 0
  let newestSaved = 0
  const coalescedScan = createScanCoalescer({
    run: async (force) => {
      const started = ++scansStarted
      const snapshot = await runScan(force)
      scanCompleted = true
      // 强制重扫与普通扫描可能交错完成，落盘只让后开始的那一轮覆盖先开始的。
      if (started > newestSaved) {
        newestSaved = started
        void snapshotCache?.save(snapshot)
      }
      return snapshot
    },
    revision: () => installationQueue.revision,
    reuseMs: scanReuseMs,
  })
  function scanSystem(forceRefresh = false): Promise<SystemSnapshot> {
    return coalescedScan.scan(forceRefresh)
  }
  async function cachedScan(options: { startScan?: boolean } = {}): Promise<SystemSnapshot | null> {
    if (scanCompleted || !snapshotCache) return null
    if (options.startScan !== false) void scanSystem(false).catch(() => undefined)
    const cached = await snapshotCache.load()
    // 读文件这几毫秒里真扫描可能已经回来了，那就不必再给旧的。
    return scanCompleted ? null : cached
  }
  // 低配机器上一轮扫描同时起十来个探测子进程（node、npm、python、git、PowerShell、
  // 四家 CLI 的 --version），CPU 与磁盘被挤满，整轮反而更慢，别的程序也跟着卡。
  // 起子进程的探测一次最多跑这么多个；网络位置这类只发请求的不占名额。
  const probeQueue = new BoundedOperationQueue({ maxActive: scanProbeConcurrency, maxQueued: 64 })
  function limitedProbe<T>(probe: () => Promise<T>): Promise<T> {
    return probeQueue.enqueue(() => probe()).promise
  }

  async function runScan(forceRefresh: boolean): Promise<SystemSnapshot> {
    if (forceRefresh) {
      npmLatestCacheGeneration += 1
      npmLatestCache.clear()
      grokLatestInFlight.clear()
      officialChatGptCache = null
      forgetPreferredNodeDirectories()
    }
    const [nodeResult, npmResult, pythonResult, gitResult, codexDesktopResult, networkResult, officialChatGptResult] = await Promise.allSettled([
      limitedProbe(inspectNode),
      limitedProbe(() => inspectTool('npm')),
      limitedProbe(inspectPython),
      limitedProbe(inspectGit),
      limitedProbe(() => inspectCodexDesktopUpdate(forceRefresh)),
      inspectNetworkLocation(forceRefresh),
      inspectOfficialChatGptAccount(forceRefresh),
    ])
    // 单个探测异常不再丢弃整份快照；失败项降级为可区分的「检测失败」状态
    const node = buildToolStatusFromSettled(nodeResult)
    const npm = buildToolStatusFromSettled(npmResult)
    const python = buildToolStatusFromSettled(pythonResult)
    const git = buildToolStatusFromSettled(gitResult)
    const codexDesktop = buildDesktopAppStatusFromSettled(codexDesktopResult)
    const network = buildNetworkLocationStatusFromSettled(networkResult)
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npm.path)
    // 单个 CLI 探测异常不能伪装成“未安装”，否则维护页会自动勾选并重装。
    const cliProbes = await Promise.allSettled(
      activeProviderIds.map((id) => limitedProbe(() => inspectCliTool(id, npm.path, npmGlobalRoot))),
    )
    const cliResults: ToolStatus[] = cliProbes.map(buildCliToolStatusFromSettled)
    // 老版本装的工具旁边还留着 .ps1 启动文件；每次打开软件后的第一轮检测顺手清掉，
    // 只动文件、不起 PowerShell，也不等它。Mac 上这一轮给以前装过、还没补终端设置的
    // 电脑补一次（只补一次，见 macos-shell-profile.ts）；Linux 同理，另外把小启动器
    // 和装着的工具对齐（linux-shell-profile.ts）。
    void cliTerminalAccess.sweepOnce(activeProviderIds.flatMap((provider, index) => {
      const probe = cliProbes[index]
      return probe.status === 'fulfilled' && probe.value.installation
        ? [{ provider, installation: probe.value.installation }]
        : []
    })).catch((error: unknown) => {
      // 没人等它，出错也不该变成进程级的未处理 Promise；留一行日志就够，下次打开软件会再清。
      runtimeLog?.log('warn', 'install', 'cli.powershell-shim.sweep-failed', '打开软件后顺手清理旧启动文件没有完成', {
        reason: credentialFailureReason(error),
      })
    })
    const networkRegion = network.region

    // 离线时四家探测会一个个耗满超时，首屏本地信息早就齐了却还在等；
    // 给整批一个总预算，到点先出画面（见 settleLatestVersionProbes）。
    const uncheckedLatest = activeProviderIds.map(
      (id, index) => buildUncheckedLatestVersion(id, cliResults[index].installed, undefined, platform),
    )
    const latestVersionBudgetMs = networkProbeSuggestsOffline(network)
      ? offlineLatestVersionBudgetMs
      : null
    const latestVersionBudget = latestVersionBudgetMs === null ? undefined : new AbortController()
    const latestVersions = await settleLatestVersionProbes(
      activeProviderIds.map((id, index) => inspectCliLatestVersion(
        id,
        cliResults[index],
        networkRegion,
        latestVersionBudget?.signal,
      )),
      uncheckedLatest,
      latestVersionBudgetMs,
      latestVersionBudget,
    )
    const scanSettings = store.read()
    const updateHistory = cliUpdateHistory.read()
    const scannedAt = Date.now()
    const clis = Object.fromEntries([
      ...activeProviderIds.map((id, index) => {
        const status = cliResults[index]
        return [id, buildCliStatus(status, latestVersions[index], buildCliVersionAdvice(id, status.version, {
          siteId: scanSettings.relaySiteId,
          alwaysLatest: scanSettings.alwaysInstallLatestCli === true,
        }), resolveCliRevertVersion(id, updateHistory[id], status.version, scannedAt, scanSettings.relaySiteId))] as const
      }),
      // 下线的工具不起进程、不问 npm，只给一格占位（CliStatus.retired）。
      ...retiredProviderIds.map((id) => [id, buildRetiredCliStatus(id, platform)] as const),
    ]) as Record<ProviderId, CliStatus>

    // A Microsoft Store install is outside the app's installer IPC. Once a
    // scan positively sees the desktop package again, treat that as the user's
    // manual opt-in and re-enable future managed installs.
    if (codexDesktop.installed && store.read().codexDesktopInstallDisabled) {
      await store.update({ version: 2, codexDesktopInstallDisabled: false })
    }

    return {
      checkedAt: new Date().toISOString(),
      network,
      runtime: { node, npm, python, git },
      clis,
      desktopApps: { codex: codexDesktop },
      officialChatGpt: officialChatGptResult.status === 'fulfilled' ? officialChatGptResult.value : null,
    }
  }

  async function inspectCodexSetupStatus(): Promise<CodexSetupStatus> {
    const [nodeResult, npmResult, desktopResult] = await Promise.allSettled([
      inspectNode(),
      inspectTool('npm'),
      inspectCodexDesktop(),
    ])
    // 三路探测彼此独立；任一异常都不应连累其余两个已知结果（同 scanSystem，见 317b34f）
    const node = buildToolStatusFromSettled(nodeResult)
    const npm = buildToolStatusFromSettled(npmResult)
    const desktop = buildDesktopAppStatusFromSettled(desktopResult)
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npm.path)
    // CLI 探测依赖上面 npm 探测的结果，只能顺序执行、无法并入 allSettled；
    // 同样降级为「检测失败」而非「未安装」，避免向导误判并对已在正常工作的 CLI 触发重装
    const [cliSettled] = await Promise.allSettled([inspectCliTool('codex', npm.path, npmGlobalRoot)])
    const cli = buildCliToolStatusFromSettled(cliSettled)
    return { checkedAt: new Date().toISOString(), runtime: { node, npm }, cli, desktop }
  }

  return {
    inspectNetworkRegion,
    refreshNetworkLocation,
    inspectTool,
    withToolCertificateHint,
    inspectNode,
    inspectCliTool,
    inspectPython,
    inspectGit,
    invalidateCliUpdateCache,
    inspectRunningTools,
    inspectCliUpdate,
    refreshOfficialChatGptUsage,
    coalescedScan,
    scanSystem,
    cachedScan,
    inspectCodexSetupStatus,
  }
}
