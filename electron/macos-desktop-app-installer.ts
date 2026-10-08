import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readBoundedResponseText } from './bounded-response'
import { CommandRunnerError, type CommandResult } from './command-runner'
import { downloadWithResume } from './download-retry'
import type { ExternalToolId } from './external-tool-config'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import {
  macosDesktopDiskFullMessage,
  macosDesktopDownloadFailedMessage,
  macosDesktopInstallErrorName,
  macosDesktopInstallFailedMessage,
  macosDesktopNameTakenMessage,
  macosDesktopNotOfficialMessage,
  macosDesktopSystemTooOldMessage,
  macosLegacyChatgptMessage,
} from './macos-desktop-install-failure'
import { managedProductRoot } from './managed-cli-paths'
import { ensureTrustedDirectory } from './trusted-temp'

/**
 * Mac 上一键装桌面端（yoyo 2026-10-02「macos不是可以下载离线包吗」）。以前 Mac 上这几行
 * 只有「安装指南」，下载、拖进「应用程序」都要客户自己来。
 *
 * 只收录核对过官方 Mac 包的客户端：下载地址、签名团队都实际下载核对过才进下面那张表。
 * 核对不了的（WorkBuddy 找不到能核对的 Mac 下载地址）继续走安装指南。Codex 桌面端
 * （yoyo 2026-10-03「mac我也希望能直接下载」）和 Claude Desktop 也在表里；Codex 桌面端在
 * Mac 上的官方包现在叫 ChatGPT，由 codex-desktop-service.ts 调这里，不走桌面客户端那一路。
 *
 * Trust chain, in order:
 * 1. The release feed and the package come only from the vendor's own release
 *    location, with every redirect held to the same allow-list (I10). The feed may only
 *    name the one package URL this module would have built for that version itself.
 * 2. The extracted bundle must satisfy a designated requirement pinned to the vendor's
 *    Apple Developer ID team and bundle identifier, decided by codesign's exit status
 *    (macos-code-signing.ts explains why its printed text proves nothing).
 * 3. Gatekeeper must accept it (spctl --assess), which is where notarization is checked.
 * Only then is it renamed into /Applications, or ~/Applications for a customer who is
 * not an administrator. No digest is pinned: these apps update themselves, so the
 * signature is the identity that stays the same from one release to the next. When the
 * feed itself declares the package's size or SHA-256 (Claude's declares both), the
 * download must match them before anything is unpacked.
 *
 * The quarantine flag is deliberately not set. The Gatekeeper decision it would trigger
 * on first launch is the one step 3 has already made, and keeping it would put the
 * "downloaded from the Internet" prompt in front of an app the toolbox just verified.
 */

export type MacosDesktopArchitecture = 'arm64' | 'x64'

/** 能一键装的：首页「桌面客户端」那几行，加上 Codex 桌面端。 */
export type MacosDesktopAppId = ExternalToolId | 'codexDesktop'

export interface MacosDesktopRelease {
  version: string
  url: string
  /** 版本信息里写的安装包大小；写了就要求下载下来的一个字节都不差。 */
  bytes?: number
  /** 版本信息里写的 SHA-256；写了就要求对得上。 */
  sha256?: string
  /** 版本信息里写的最低 macOS；下载之前先比，免得下完几百 MB 才说这台 Mac 装不了。 */
  minimumSystemVersion?: string
}

export interface MacosDesktopFeedContext {
  architecture: MacosDesktopArchitecture
  /** sw_vers 读到的系统版本；只有 feedNeedsSystemVersion 的来源才去读，其余是 null。 */
  systemVersion: string | null
}

interface MacosDesktopAppSource {
  /** 进度和失败提示里的名字，和首页那一行一致。 */
  name: string
  /** 「应用程序」里那个应用的名字（不带 .app），客户在访达里看到的就是它。 */
  applicationName: string
  bundleIdentifier: string
  /** Apple Developer team that signs the official build. */
  teamIdentifier: string
  feedUrl(context: MacosDesktopFeedContext): string
  /** json 先解析再交给 selectRelease，xml 原样交过去。 */
  feedFormat: 'json' | 'xml'
  /** 拼版本信息地址或挑包要用到这台 Mac 的系统版本。 */
  feedNeedsSystemVersion?: boolean
  archiveFormat: 'tar.gz' | 'zip'
  /** Hard ceiling on the package body; only there to stop a runaway download. */
  maximumArchiveBytes: number
  /** Picks this Mac's package from the parsed feed; null when the feed offers none. */
  selectRelease(feed: unknown, context: MacosDesktopFeedContext): MacosDesktopRelease | null
  /** Every URL the feed and the package may pass through, redirects included. */
  allowsUrl(url: URL): boolean
  /** 同名的旧版官方应用：名字被它占着时换这句话说，它不是冒牌货，只是旧了。 */
  legacyApplication?: { bundleIdentifiers: readonly string[], message: string }
}

export interface MacosDesktopAppProcess {
  executable: string
  argv: readonly string[]
  timeoutMs: number
}

export interface MacosDesktopAppInstallProgress {
  phase: 'downloading' | 'checking' | 'installing'
  message: string
  percent: number | null
}

export interface InstallMacosDesktopAppOptions {
  tool: MacosDesktopAppId
  architecture: string
  userHome: string
  /** 决定产品目录（HOME）；测试用它指到临时目录。 */
  environment: NodeJS.ProcessEnv
  fetch: typeof globalThis.fetch
  runProcess(plan: MacosDesktopAppProcess): Promise<CommandResult>
  onProgress?(event: MacosDesktopAppInstallProgress): void
  /** 系统的「应用程序」目录；只给测试换成临时目录。 */
  systemApplicationsDirectory?: string
  /** 测试接缝：下载断了以后等多久再接着下，缺省按真实时间等。 */
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>
  /**
   * 客户点了取消。下载和下一步都会停下，抛出的是原来那个错误（不换成大白话），好让调用方
   * 认出这是取消、不是装失败。runProcess 自己也要接上同一个信号。
   */
  signal?: AbortSignal
  /**
   * 调用方装之前的检测没做完、没核对出「应用程序」里有没有装好的那份。名字被占着、那份又自称就是
   * 这个应用（bundle id 对得上）时说 message，不说「不是官方原版……移到废纸篓」：它多半是客户装好的
   * 正版，只是没来得及核对。检测核对过、确定不过关的那几份（rejectedPaths，realpath）照旧说不是
   * 官方原版。只换说法，照样不装、不动它。
   */
  detectionUnfinished?: { message: string, rejectedPaths: readonly string[] }
}

export interface MacosDesktopAppInstallResult {
  version: string
  path: string
}

/**
 * 装不成时抛给界面的错误。message 是 macos-desktop-install-failure.ts 里那几句大白话；
 * detail 是原因原话，作为自有字段挂着，ipc.ts 记失败时会把它写进 runtime.jsonl
 * （同 CodexDesktopInstallFailure）。
 */
export class MacosDesktopInstallError extends Error {
  readonly detail: string

  constructor(message: string, detail: string, cause?: unknown) {
    super(message, { cause })
    this.name = macosDesktopInstallErrorName
    this.detail = detail
  }
}

const feedTimeoutMs = 30_000
const maximumFeedBytes = 512 * 1024
const maximumRedirects = 5
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const extractTimeoutMs = 10 * 60_000
const probeTimeoutMs = 30_000
// A first deep verification hashes every file of a bundle of several hundred MB.
const signatureTimeoutMs = 3 * 60_000
const gatekeeperTimeoutMs = 2 * 60_000
const copyTimeoutMs = 10 * 60_000
const stagingDirectoryName = 'DesktopApps'
const stagingPrefix = 'staging-'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * OpenCode 发版时在 GitHub Releases 放一份 latest.json，列出各平台的包；Mac 两种芯片
 * 各一个 .app.tar.gz。这里只取版本号，地址自己按版本号拼，再要求 feed 里写的正好是它。
 */
function selectOpenCodeRelease(feed: unknown, context: MacosDesktopFeedContext): MacosDesktopRelease | null {
  if (!isRecord(feed) || !isRecord(feed.platforms) || typeof feed.version !== 'string') return null
  const version = feed.version
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) return null
  const entry = feed.platforms[context.architecture === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64']
  const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-desktop-mac-${context.architecture}.app.tar.gz`
  return isRecord(entry) && entry.url === url ? { version, url } : null
}

/**
 * GitHub serves release files from its asset host behind a signed, short-lived query;
 * the same two hosts git-runtime-install.ts accepts for Git for Windows.
 */
function allowsOpenCodeUrl(url: URL): boolean {
  if (url.hostname === 'release-assets.githubusercontent.com' || url.hostname === 'objects.githubusercontent.com') return true
  return url.hostname === 'github.com' && url.pathname.startsWith('/anomalyco/opencode/releases/') && !url.search
}

/**
 * Claude 的 Mac 版和官方客户端一样问它自己的更新接口（Squirrel.Mac 的 JSON）。接口要一个
 * device_id：每次装都现编一个随机 UUID，不存、不复用，认不出是哪台 Mac。os_version 要带上：
 * 不带时它给的是 macOS 12 那一路的旧版（2026-10-03 实测，不带给 1.46388.4，带 13.0 以上给
 * 2.19675.0）。两种芯片拿到的是同一个通用包。
 */
function claudeFeedUrl(context: MacosDesktopFeedContext): string {
  const url = new URL(`https://api.anthropic.com/api/desktop/darwin/${context.architecture}/squirrel/update`)
  url.search = new URLSearchParams({ device_id: randomUUID(), os_version: context.systemVersion ?? '' }).toString()
  return url.href
}

/** 只认当前版本那一条，地址必须是那个版本的通用 zip，大小和 SHA-256 都得写着。 */
function selectClaudeRelease(feed: unknown): MacosDesktopRelease | null {
  if (!isRecord(feed) || typeof feed.currentRelease !== 'string' || !Array.isArray(feed.releases)) return null
  const version = feed.currentRelease
  if (!/^\d{1,4}\.\d{1,6}\.\d{1,6}$/.test(version)) return null
  const entries = feed.releases.filter((entry) => isRecord(entry) && entry.version === version)
  const update: unknown = entries.length === 1 && isRecord(entries[0]) ? entries[0].updateTo : null
  if (!isRecord(update) || update.version !== version) return null
  const packagePattern = new RegExp(`^https://downloads\\.claude\\.ai/releases/darwin/universal/${version.split('.').join('\\.')}/Claude-[0-9a-f]{40}\\.zip$`)
  if (typeof update.url !== 'string' || !packagePattern.test(update.url)) return null
  if (typeof update.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(update.sha256)) return null
  if (typeof update.size !== 'number' || !Number.isSafeInteger(update.size) || update.size <= 0) return null
  return { version, url: update.url, sha256: update.sha256, bytes: update.size }
}

/** The feed is a fixed API path that carries a query; the package host serves no query at all. */
function allowsClaudeUrl(url: URL): boolean {
  if (url.hostname === 'api.anthropic.com') return /^\/api\/desktop\/darwin\/(?:arm64|x64)\/squirrel\/update$/.test(url.pathname)
  return url.hostname === 'downloads.claude.ai' && url.pathname.startsWith('/releases/darwin/universal/') && !url.search
}

const chatgptPackageRoot = 'https://persistent.oaistatic.com/codex-app-prod/'

/** Sparkle 的 appcast，Apple 芯片和 Intel 各一份。 */
function chatgptFeedUrl(context: MacosDesktopFeedContext): string {
  return `${chatgptPackageRoot}${context.architecture === 'arm64' ? 'appcast.xml' : 'appcast-x64.xml'}`
}

function xmlAttribute(attributes: string, name: string): string | null {
  return new RegExp(`(?:^|\\s)${name}="([^"<>]*)"`).exec(attributes)?.[1] ?? null
}

/** 一个 <item> 里这个元素只许出现一次；出现两次就不知道该信哪个，整条不要。 */
function singleXmlElement(item: string, element: string, valuePattern: string): string | null {
  const matches = [...item.matchAll(new RegExp(`<${element}>\\s*(${valuePattern})\\s*</${element}>`, 'g'))]
  return matches.length === 1 ? matches[0][1] : null
}

/**
 * appcast 里一版一个 <item>：sparkle:version 是构建号，sparkle:shortVersionString 是界面上的
 * 版本号，enclosure 是完整安装包，sparkle:deltas 里是只给装着旧版的用的增量包（跳过）。
 * 挑构建号最大、这台 Mac 的系统够得上的那一版；一版都够不上就交出最新那一版，让下载前那道
 * 系统版本检查说清楚要升到多少。安装包地址必须正好是按版本号拼出来的那一个。
 */
function selectChatgptRelease(feed: unknown, context: MacosDesktopFeedContext): MacosDesktopRelease | null {
  if (typeof feed !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(feed)) return null
  const candidates: Array<{ build: number, release: MacosDesktopRelease }> = []
  for (const item of feed.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<item(?:\s[^<>]*)?>([\s\S]*?)<\/item>/g)) {
    const body = item[1].replace(/<sparkle:deltas(?:\s[^<>]*)?>[\s\S]*?<\/sparkle:deltas>/g, '')
    const build = singleXmlElement(body, 'sparkle:version', '\\d{1,9}')
    const version = singleXmlElement(body, 'sparkle:shortVersionString', '\\d{1,4}\\.\\d{1,6}\\.\\d{1,9}')
    if (!build || !version) continue
    const minimum = singleXmlElement(body, 'sparkle:minimumSystemVersion', '\\d{1,3}(?:\\.\\d{1,3}){0,2}')
    const url = `${chatgptPackageRoot}ChatGPT-darwin-${context.architecture}-${version}.zip`
    for (const enclosure of body.matchAll(/<enclosure\s([^<>]*?)\/?>/g)) {
      if (xmlAttribute(enclosure[1], 'sparkle:deltaFrom') !== null || xmlAttribute(enclosure[1], 'url') !== url) continue
      const bytes = Number(xmlAttribute(enclosure[1], 'length'))
      if (!Number.isSafeInteger(bytes) || bytes <= 0) continue
      candidates.push({ build: Number(build), release: { version, url, bytes, ...(minimum ? { minimumSystemVersion: minimum } : {}) } })
    }
  }
  candidates.sort((left, right) => right.build - left.build)
  const fits = candidates.find(({ release }) => !release.minimumSystemVersion || !context.systemVersion
    || !isMacosVersionBelow(context.systemVersion, release.minimumSystemVersion))
  return (fits ?? candidates[0])?.release ?? null
}

function allowsChatgptUrl(url: URL): boolean {
  return url.hostname === 'persistent.oaistatic.com' && url.pathname.startsWith('/codex-app-prod/') && !url.search
}

const openCodeFeedUrl = 'https://github.com/anomalyco/opencode/releases/latest/download/latest.json'

const sources: Partial<Record<MacosDesktopAppId, MacosDesktopAppSource>> = {
  // Checked 2026-10-02 by downloading v1.18.34 for both architectures: the feed below
  // and the package names it lists, the redirect to release-assets.githubusercontent.com,
  // bundle ai.opencode.desktop with LSMinimumSystemVersion 12.0, and the Developer ID
  // "Anomaly Innovations, Inc. (5NZ4Q7NXJ4)" on the main executable.
  opencode: {
    name: 'OpenCode',
    applicationName: 'OpenCode',
    bundleIdentifier: 'ai.opencode.desktop',
    teamIdentifier: '5NZ4Q7NXJ4',
    feedUrl: () => openCodeFeedUrl,
    feedFormat: 'json',
    archiveFormat: 'tar.gz',
    // v1.18.34 is 152 MB.
    maximumArchiveBytes: 640 * 1024 * 1024,
    selectRelease: selectOpenCodeRelease,
    allowsUrl: allowsOpenCodeUrl,
  },
  // Checked 2026-10-03 on a GitHub macOS 26 arm64 runner by downloading 2.19675.0: the feed
  // answers without a redirect, the zip comes straight from downloads.claude.ai and matches the
  // feed's size and SHA-256, it unpacks to exactly Claude.app (universal x86_64 + arm64), bundle
  // com.anthropic.claudefordesktop with LSMinimumSystemVersion 13.0, signed "Developer ID
  // Application: Anthropic PBC (Q6L2SF6YDW)" and notarized; the pinned requirement and
  // Gatekeeper both accept it.
  claudeDesktop: {
    name: 'Claude Desktop',
    applicationName: 'Claude',
    bundleIdentifier: 'com.anthropic.claudefordesktop',
    teamIdentifier: 'Q6L2SF6YDW',
    feedUrl: claudeFeedUrl,
    feedFormat: 'json',
    feedNeedsSystemVersion: true,
    archiveFormat: 'zip',
    // 2.19675.0 is 379 MB.
    maximumArchiveBytes: 1536 * 1024 * 1024,
    selectRelease: selectClaudeRelease,
    allowsUrl: allowsClaudeUrl,
  },
  // Checked the same day and way with 26.930.31730 for both architectures: both appcasts and
  // zips come straight from persistent.oaistatic.com, each zip matches its appcast length and
  // unpacks to exactly ChatGPT.app (thin arm64, thin x86_64), bundle com.openai.codex with
  // LSMinimumSystemVersion 13.0, signed "Developer ID Application: OpenAI OpCo, LLC
  // (2DC432GLL2)" and notarized; requirement and Gatekeeper accept both.
  codexDesktop: {
    name: 'Codex 桌面端',
    applicationName: 'ChatGPT',
    bundleIdentifier: 'com.openai.codex',
    teamIdentifier: '2DC432GLL2',
    feedUrl: chatgptFeedUrl,
    feedFormat: 'xml',
    feedNeedsSystemVersion: true,
    archiveFormat: 'zip',
    // 26.930.31730 is 689 MB on Apple silicon and 676 MB on Intel.
    maximumArchiveBytes: 2048 * 1024 * 1024,
    selectRelease: selectChatgptRelease,
    allowsUrl: allowsChatgptUrl,
    // OpenAI 旧版的聊天程序也叫 ChatGPT.app（Homebrew 的 chatgpt 已改指这个新包）。
    legacyApplication: { bundleIdentifiers: ['com.openai.chat'], message: macosLegacyChatgptMessage },
  },
}

/** 这台 Mac 上能不能一键装这个客户端：有核对过的官方包，并且是这两种芯片之一。 */
export function macosDesktopAppInstallable(tool: MacosDesktopAppId, architecture: string): boolean {
  return Boolean(sources[tool]) && (architecture === 'arm64' || architecture === 'x64')
}

function validateResourceUrl(source: MacosDesktopAppSource, value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('下载地址格式无效')
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !source.allowsUrl(url)) {
    throw new Error(`下载被重定向到了不认识的地址（${url.hostname}）`)
  }
  return url
}

/** Follows redirects one hop at a time so that every hop is held to the allow-list. */
export async function fetchMacosDesktopResource(
  tool: MacosDesktopAppId,
  url: string,
  init: RequestInit,
  fetchImplementation: typeof globalThis.fetch,
): Promise<Response> {
  const source = sources[tool]
  if (!source) throw new Error('这个客户端没有可核对的官方下载地址')
  let current = validateResourceUrl(source, url)
  const visited = new Set<string>()
  for (let redirects = 0; ; redirects += 1) {
    if (visited.has(current.href)) throw new Error('下载发生了循环重定向')
    visited.add(current.href)
    const response = await fetchImplementation(current.href, { ...init, redirect: 'manual' })
    // A fetch that followed redirects on its own would hide where the bytes came from.
    if (response.url && validateResourceUrl(source, response.url).href !== current.href) {
      throw new Error('下载绕过了受限的重定向策略')
    }
    if (!redirectStatuses.has(response.status)) return response
    await response.body?.cancel().catch(() => undefined)
    if (redirects >= maximumRedirects) throw new Error('下载重定向次数过多')
    const location = response.headers.get('location')
    if (!location) throw new Error('下载重定向缺少 Location')
    current = validateResourceUrl(source, new URL(location, current).href)
  }
}

async function fetchFeed(
  tool: MacosDesktopAppId,
  source: MacosDesktopAppSource,
  context: MacosDesktopFeedContext,
  fetchImplementation: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(feedTimeoutMs)
  const response = await fetchMacosDesktopResource(tool, source.feedUrl(context), {
    headers: { Accept: source.feedFormat === 'json' ? 'application/json' : 'application/xml' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }, fetchImplementation)
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`版本信息返回 HTTP ${response.status}`)
  }
  const text = await readBoundedResponseText(response, maximumFeedBytes, '版本信息')
  if (source.feedFormat === 'xml') return text
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MacosDesktopInstallError(macosDesktopInstallFailedMessage(source.name), '官方版本信息不是有效的 JSON')
  }
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 管理员（Mac 上第一个账号默认就是）能写 /Applications，放那里，访达侧边栏的「应用程序」
 * 就是它；不是管理员就放进自己的 ~/Applications，启动台照样能找到。首页检测这两处都看。
 */
async function resolveApplicationsDirectory(userHome: string, systemDirectory: string): Promise<string> {
  try {
    const stats = await fs.promises.lstat(systemDirectory)
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      await fs.promises.access(systemDirectory, fs.constants.W_OK)
      return systemDirectory
    }
  } catch {
    // Not an administrator, or no usable /Applications: fall through to ~/Applications.
  }
  const personal = path.posix.join(userHome, 'Applications')
  try {
    await fs.promises.mkdir(personal, { mode: 0o755 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stats = await fs.promises.lstat(personal)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${personal} 不是普通目录`)
  return personal
}

/** 上次被打断（关机、强退）留下的暂存目录，下次装之前清掉，免得一直占着几百 MB。 */
async function createStagingDirectory(environment: NodeJS.ProcessEnv): Promise<string> {
  const productRoot = managedProductRoot(environment, 'darwin')
  const parent = path.posix.join(productRoot, stagingDirectoryName)
  const directoryOptions = { platform: 'darwin' as const, env: environment }
  await ensureTrustedDirectory(productRoot, directoryOptions)
  await ensureTrustedDirectory(parent, directoryOptions)
  for (const entry of await fs.promises.readdir(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(stagingPrefix) || !entry.isDirectory()) continue
    await fs.promises.rm(path.posix.join(parent, entry.name), { recursive: true, force: true })
  }
  const staging = await fs.promises.mkdtemp(path.posix.join(parent, stagingPrefix))
  await fs.promises.chmod(staging, 0o700)
  return staging
}

function macosVersionParts(value: string): number[] | null {
  return /^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value) ? value.split('.').map(Number) : null
}

/** 读不出版本号时不下结论（返回 false），让后面的签名核对和 Gatekeeper 去决定。 */
export function isMacosVersionBelow(current: string, minimum: string): boolean {
  const left = macosVersionParts(current.trim())
  const right = macosVersionParts(minimum.trim())
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference < 0
  }
  return false
}

function rejectedByCheck(error: unknown): boolean {
  return error instanceof CommandRunnerError && error.code === 'EXIT_NON_ZERO'
}

/** 盘写满了：Node 自己报的 ENOSPC，或者 tar、ditto 在 stderr 里说的同一件事。 */
function isDiskFull(error: unknown): boolean {
  if (error instanceof CommandRunnerError) return /No space left on device/i.test(error.stderr)
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOSPC'
}

async function verifyExtractedBundle(
  source: MacosDesktopAppSource,
  extractDirectory: string,
  bundleName: string,
  runProcess: InstallMacosDesktopAppOptions['runProcess'],
  readSystemVersion: () => Promise<string>,
): Promise<string> {
  const entries = await fs.promises.readdir(extractDirectory)
  if (entries.length !== 1 || entries[0] !== bundleName) {
    throw new MacosDesktopInstallError(macosDesktopNotOfficialMessage, `压缩包内容不是单独一个 ${bundleName}：${entries.slice(0, 5).join('、')}`)
  }
  const bundle = path.posix.join(extractDirectory, bundleName)
  const stats = await fs.promises.lstat(bundle)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new MacosDesktopInstallError(macosDesktopNotOfficialMessage, `压缩包里的 ${bundleName} 不是普通目录`)
  }

  const info = await runProcess({
    executable: '/usr/bin/plutil',
    argv: ['-convert', 'json', '-o', '-', path.posix.join(bundle, 'Contents', 'Info.plist')],
    timeoutMs: probeTimeoutMs,
  })
  let plist: unknown
  try {
    plist = JSON.parse(info.stdout) as unknown
  } catch {
    throw new MacosDesktopInstallError(macosDesktopNotOfficialMessage, 'Info.plist 读不出来')
  }
  if (!isRecord(plist) || plist.CFBundleIdentifier !== source.bundleIdentifier) {
    throw new MacosDesktopInstallError(macosDesktopNotOfficialMessage, `bundle identifier 不是 ${source.bundleIdentifier}`)
  }
  if (typeof plist.LSMinimumSystemVersion === 'string') {
    const system = await readSystemVersion()
    if (isMacosVersionBelow(system, plist.LSMinimumSystemVersion)) {
      throw new MacosDesktopInstallError(
        macosDesktopSystemTooOldMessage(source.name, plist.LSMinimumSystemVersion),
        `这台 Mac 是 macOS ${system.trim()}，应用要求 ${plist.LSMinimumSystemVersion} 以上`,
      )
    }
  }

  try {
    await runProcess({
      executable: '/usr/bin/codesign',
      argv: darwinDeveloperIdVerificationArgv(source.teamIdentifier, bundle, { deep: true, bundleIdentifier: source.bundleIdentifier }),
      timeoutMs: signatureTimeoutMs,
    })
  } catch (error) {
    if (rejectedByCheck(error)) throw new MacosDesktopInstallError(macosDesktopNotOfficialMessage, `签名不是 ${source.teamIdentifier} 团队的 Developer ID`, error)
    throw error
  }
  try {
    await runProcess({ executable: '/usr/sbin/spctl', argv: ['--assess', '--type', 'execute', bundle], timeoutMs: gatekeeperTimeoutMs })
  } catch (error) {
    if (rejectedByCheck(error)) throw new MacosDesktopInstallError(macosDesktopNotOfficialMessage, 'Gatekeeper 没有放行（没有公证或签名已被吊销）', error)
    throw error
  }
  return bundle
}

/** 跨卷时先拷到「应用程序」里这个隐藏名字下（后面接 12 位十六进制），拷完再改名。 */
function copyNamePrefix(destination: string): string {
  return `.${path.posix.basename(destination)}.xingmang-`
}

/**
 * 上次跨卷拷到一半就被关掉（关机、强退）留下的隐藏副本：几百 MB，访达里看不见，也没有
 * 别的地方会清它。只认 placeBundle 自己起的那种名字，客户的东西碰不到。
 */
async function removeInterruptedCopies(destination: string): Promise<void> {
  const directory = path.posix.dirname(destination)
  const prefix = copyNamePrefix(destination)
  for (const entry of await fs.promises.readdir(directory)) {
    if (!entry.startsWith(prefix) || !/^[0-9a-f]{12}$/.test(entry.slice(prefix.length))) continue
    await fs.promises.rm(path.posix.join(directory, entry), { recursive: true, force: true })
  }
}

async function placeBundle(
  source: MacosDesktopAppSource,
  bundle: string,
  destination: string,
  runProcess: InstallMacosDesktopAppOptions['runProcess'],
): Promise<void> {
  const nameTaken = () => new MacosDesktopInstallError(macosDesktopNameTakenMessage(source.applicationName), `${destination} 在安装过程中出现了`)
  // rename 会把一个空目录直接顶掉，所以动手前再看一次：客户的东西一律不覆盖。
  if (await lstatOrNull(destination)) throw nameTaken()
  try {
    await fs.promises.rename(bundle, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  // 用户目录放在另一块盘上时 rename 过不去：先整个拷到旁边一个临时名字再改名，
  // 「应用程序」里任何时候都不会出现拷了一半的应用。
  const temporary = path.posix.join(path.posix.dirname(destination), `${copyNamePrefix(destination)}${randomBytes(6).toString('hex')}`)
  try {
    await runProcess({ executable: '/usr/bin/ditto', argv: [bundle, temporary], timeoutMs: copyTimeoutMs })
    if (await lstatOrNull(destination)) throw nameTaken()
    await fs.promises.rename(temporary, destination)
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 名字被同名应用占着时的那句话：认得出是旧版官方应用就照实说；调用方的检测没做完、那份又自称
 * 就是这个应用、也不是检测确定不过关的那几份，说检测没做完；其余一律当认不出来的那份。
 */
async function nameTakenError(
  source: MacosDesktopAppSource,
  destination: string,
  runProcess: InstallMacosDesktopAppOptions['runProcess'],
  detectionUnfinished: InstallMacosDesktopAppOptions['detectionUnfinished'],
): Promise<MacosDesktopInstallError> {
  const detail = `${destination} 已存在，但不是能核对的官方原版`
  const legacy = source.legacyApplication
  if (legacy || detectionUnfinished) {
    try {
      // Only the wording depends on this self-declared identifier; nothing is trusted or
      // removed because of it, so reading it without a signature check is fine.
      const identifier = (await runProcess({
        executable: '/usr/bin/plutil',
        argv: ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.posix.join(destination, 'Contents', 'Info.plist')],
        timeoutMs: probeTimeoutMs,
      })).stdout.trim()
      if (legacy?.bundleIdentifiers.includes(identifier)) return new MacosDesktopInstallError(legacy.message, `${destination} 是旧版应用 ${identifier}`)
      if (detectionUnfinished && identifier === source.bundleIdentifier
        && !detectionUnfinished.rejectedPaths.includes(await fs.promises.realpath(destination))) {
        return new MacosDesktopInstallError(detectionUnfinished.message, `${destination} 自称是 ${identifier}，装之前的检测没做完，没核对它是不是官方原版`)
      }
    } catch {
      // Unreadable: fall back to the general wording.
    }
  }
  return new MacosDesktopInstallError(macosDesktopNameTakenMessage(source.applicationName), detail)
}

export async function installMacosDesktopApp(options: InstallMacosDesktopAppOptions): Promise<MacosDesktopAppInstallResult> {
  const source = sources[options.tool]
  const architecture = options.architecture
  if (!source || (architecture !== 'arm64' && architecture !== 'x64')) {
    throw new Error('这个客户端在这台 Mac 上不能一键安装')
  }
  const report = (phase: MacosDesktopAppInstallProgress['phase'], message: string, percent: number | null = null) => {
    options.onProgress?.({ phase, message, percent })
  }
  // 读一次就记住：拼版本信息地址、挑包、核 LSMinimumSystemVersion 用的是同一个答案。
  let systemVersion: Promise<string> | null = null
  const readSystemVersion = () => systemVersion ??= options.runProcess({ executable: '/usr/bin/sw_vers', argv: ['-productVersion'], timeoutMs: probeTimeoutMs })
    .then((result) => result.stdout)
  const bundleName = `${source.applicationName}.app`
  let stage: 'download' | 'verify' | 'place' = 'place'
  let staging: string | null = null
  try {
    const applications = await resolveApplicationsDirectory(options.userHome, options.systemApplicationsDirectory ?? '/Applications')
    const destination = path.posix.join(applications, bundleName)
    // 首页认得出的那份早就让安装提前结束了；走到这里还占着名字的，是认不出来、或者没来得及核对的那份。
    if (await lstatOrNull(destination)) throw await nameTakenError(source, destination, options.runProcess, options.detectionUnfinished)
    await removeInterruptedCopies(destination)
    staging = await createStagingDirectory(options.environment)

    let context: MacosDesktopFeedContext = { architecture, systemVersion: null }
    if (source.feedNeedsSystemVersion) {
      const version = (await readSystemVersion()).trim()
      if (!/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(version)) throw new Error(`读不出这台 Mac 的系统版本：${version.slice(0, 40)}`)
      context = { architecture, systemVersion: version }
    }
    stage = 'download'
    const release = source.selectRelease(await fetchFeed(options.tool, source, context, options.fetch, options.signal), context)
    if (!release) {
      throw new MacosDesktopInstallError(macosDesktopInstallFailedMessage(source.name), '官方版本信息里没有这台 Mac 能用的安装包')
    }
    if (release.minimumSystemVersion && context.systemVersion && isMacosVersionBelow(context.systemVersion, release.minimumSystemVersion)) {
      throw new MacosDesktopInstallError(
        macosDesktopSystemTooOldMessage(source.name, release.minimumSystemVersion),
        `这台 Mac 是 macOS ${context.systemVersion}，官方版本信息写着 ${release.version} 要求 ${release.minimumSystemVersion} 以上`,
      )
    }
    const archive = path.posix.join(staging, source.archiveFormat === 'zip' ? 'package.zip' : 'package.tar.gz')
    const downloading = `正在下载 ${source.name} ${release.version}`
    let reported: number | null = 0
    report('downloading', downloading, reported)
    const downloaded = await downloadWithResume({
      targetPath: archive,
      fileMode: 0o600,
      // 版本信息写了多大就只收这么多：多一个字节都不是它说的那个包。
      maximumBytes: Math.min(source.maximumArchiveBytes, release.bytes ?? Number.POSITIVE_INFINITY),
      oversizeMessage: '安装包比预期大得多，已停止下载',
      request: (headers, signal) => fetchMacosDesktopResource(options.tool, release.url, { headers, signal }, options.fetch),
      acceptResponse: (response) => {
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined)
          throw new Error(`安装包下载返回 HTTP ${response.status}`)
        }
        const declared = Number(response.headers.get('content-length'))
        return Number.isSafeInteger(declared) && declared > 0 ? declared : null
      },
      // 每个数据块都会回调一次；百分比没变就不往界面发，免得一次下载发出几千条进度。
      onProgress: (transferred, total) => {
        const percent = total ? Math.min(99, Math.floor(transferred / total * 100)) : null
        if (percent === reported) return
        reported = percent
        report('downloading', downloading, percent)
      },
      onResume: (transferred, total) => {
        reported = Math.min(99, Math.floor(transferred / total * 100))
        report('downloading', `网络断了一下，正在接着下载 ${source.name} ${release.version}`, reported)
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.wait ? { wait: options.wait } : {}),
    })

    stage = 'verify'
    report('checking', '正在检查下载下来的安装包是不是完整的官方版')
    // 短了说明没下完（服务器没给长度时下载那一步看不出来），照网络问题说。
    if (release.bytes !== undefined && downloaded.size !== release.bytes) {
      throw new MacosDesktopInstallError(macosDesktopDownloadFailedMessage(source.name), `安装包是 ${downloaded.size} 字节，官方版本信息写的是 ${release.bytes}`)
    }
    // 摘要是边下边算的，只算写进文件的那些字节，接着下时也对得上文件本身。
    if (release.sha256 && downloaded.sha256.toString('hex') !== release.sha256) {
      throw new MacosDesktopInstallError(macosDesktopNotOfficialMessage, '安装包的 SHA-256 和官方版本信息里写的不一样')
    }
    options.signal?.throwIfAborted()
    const extractDirectory = path.posix.join(staging, 'extract')
    await fs.promises.mkdir(extractDirectory, { mode: 0o700 })
    // /usr/bin/tar is bsdtar under SIP, and it reads zip archives as well as gzip'd tar.
    // By default it strips a leading "/", refuses entries containing ".." and will not
    // extract through a symlink, so the archive cannot write outside the staging directory
    // before its signature is checked. A failed extraction says nothing about who made the
    // archive (a read error or a full disk looks the same), so it is reported as a failed
    // install, not as an unofficial package: a swapped archive that does unpack still meets
    // the checks below.
    await options.runProcess({
      executable: '/usr/bin/tar',
      argv: [source.archiveFormat === 'zip' ? '-xf' : '-xzf', archive, '-C', extractDirectory],
      timeoutMs: extractTimeoutMs,
    })
    const bundle = await verifyExtractedBundle(source, extractDirectory, bundleName, options.runProcess, readSystemVersion)

    options.signal?.throwIfAborted()
    stage = 'place'
    report('installing', '正在放进「应用程序」')
    await placeBundle(source, bundle, destination, options.runProcess)
    return { version: release.version, path: destination }
  } catch (error) {
    // 取消不是装失败：原样交回去，让调用方说「已取消」而不是「没下载下来」。
    if (options.signal?.aborted) throw error
    if (error instanceof MacosDesktopInstallError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    // 盘满了就照直说：「检查网络」「再点一次」都救不了一块写满的磁盘。
    const message = isDiskFull(error) ? macosDesktopDiskFullMessage(source.name)
      : stage === 'download' ? macosDesktopDownloadFailedMessage(source.name) : macosDesktopInstallFailedMessage(source.name)
    throw new MacosDesktopInstallError(message, detail, error)
  } finally {
    if (staging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
