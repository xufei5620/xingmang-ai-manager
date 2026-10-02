import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readBoundedResponseText } from './bounded-response'
import { CommandRunnerError, type CommandResult } from './command-runner'
import { downloadWithResume } from './download-retry'
import type { ExternalToolId } from './external-tool-config'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import {
  macosDesktopDownloadFailedMessage,
  macosDesktopInstallFailedMessage,
  macosDesktopNameTakenMessage,
  macosDesktopNotOfficialMessage,
  macosDesktopSystemTooOldMessage,
} from './macos-desktop-install-failure'
import { managedProductRoot } from './managed-cli-paths'
import { ensureTrustedDirectory } from './trusted-temp'

/**
 * Mac 上一键装桌面端（yoyo 2026-10-02「macos不是可以下载离线包吗」）。以前 Mac 上这几行
 * 只有「安装指南」，下载、拖进「应用程序」都要客户自己来。
 *
 * 只收录核对过官方 Mac 包的客户端：下载地址、签名团队都实际下载核对过才进下面那张表。
 * 核对不了的（WorkBuddy 找不到能核对的 Mac 下载地址）继续走安装指南。
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
 * signature is the identity that stays the same from one release to the next.
 *
 * The quarantine flag is deliberately not set. The Gatekeeper decision it would trigger
 * on first launch is the one step 3 has already made, and keeping it would put the
 * "downloaded from the Internet" prompt in front of an app the toolbox just verified.
 */

export type MacosDesktopArchitecture = 'arm64' | 'x64'

export interface MacosDesktopRelease {
  version: string
  url: string
}

interface MacosDesktopAppSource {
  /** 进度和失败提示里的名字，和首页那一行一致。 */
  name: string
  /** 「应用程序」里那个应用的名字（不带 .app），客户在访达里看到的就是它。 */
  applicationName: string
  bundleIdentifier: string
  /** Apple Developer team that signs the official build. */
  teamIdentifier: string
  feedUrl: string
  /** Hard ceiling on the package body; only there to stop a runaway download. */
  maximumArchiveBytes: number
  /** Picks this Mac's package from the parsed feed; null when the feed offers none. */
  selectRelease(feed: unknown, architecture: MacosDesktopArchitecture): MacosDesktopRelease | null
  /** Every URL the feed and the package may pass through, redirects included. */
  allowsUrl(url: URL): boolean
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
  tool: ExternalToolId
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
export class MacosDesktopInstallFailure extends Error {
  readonly detail: string

  constructor(message: string, detail: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'MacosDesktopInstallFailure'
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
function selectOpenCodeRelease(feed: unknown, architecture: MacosDesktopArchitecture): MacosDesktopRelease | null {
  if (!isRecord(feed) || !isRecord(feed.platforms) || typeof feed.version !== 'string') return null
  const version = feed.version
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) return null
  const entry = feed.platforms[architecture === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64']
  const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-desktop-mac-${architecture}.app.tar.gz`
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

const sources: Partial<Record<ExternalToolId, MacosDesktopAppSource>> = {
  // Checked 2026-10-02 by downloading v1.18.34 for both architectures: the feed below
  // and the package names it lists, the redirect to release-assets.githubusercontent.com,
  // bundle ai.opencode.desktop with LSMinimumSystemVersion 12.0, and the Developer ID
  // "Anomaly Innovations, Inc. (5NZ4Q7NXJ4)" on the main executable.
  opencode: {
    name: 'OpenCode',
    applicationName: 'OpenCode',
    bundleIdentifier: 'ai.opencode.desktop',
    teamIdentifier: '5NZ4Q7NXJ4',
    feedUrl: 'https://github.com/anomalyco/opencode/releases/latest/download/latest.json',
    // v1.18.34 is 152 MB.
    maximumArchiveBytes: 640 * 1024 * 1024,
    selectRelease: selectOpenCodeRelease,
    allowsUrl: allowsOpenCodeUrl,
  },
}

/** 这台 Mac 上能不能一键装这个客户端：有核对过的官方包，并且是这两种芯片之一。 */
export function macosDesktopAppInstallable(tool: ExternalToolId, architecture: string): boolean {
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
  tool: ExternalToolId,
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

async function fetchFeed(tool: ExternalToolId, source: MacosDesktopAppSource, fetchImplementation: typeof globalThis.fetch): Promise<unknown> {
  const response = await fetchMacosDesktopResource(tool, source.feedUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(feedTimeoutMs),
  }, fetchImplementation)
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`版本信息返回 HTTP ${response.status}`)
  }
  const text = await readBoundedResponseText(response, maximumFeedBytes, '版本信息')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MacosDesktopInstallFailure(macosDesktopInstallFailedMessage(source.name), '官方版本信息不是有效的 JSON')
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

async function verifyExtractedBundle(
  source: MacosDesktopAppSource,
  extractDirectory: string,
  bundleName: string,
  runProcess: InstallMacosDesktopAppOptions['runProcess'],
): Promise<string> {
  const entries = await fs.promises.readdir(extractDirectory)
  if (entries.length !== 1 || entries[0] !== bundleName) {
    throw new MacosDesktopInstallFailure(macosDesktopNotOfficialMessage, `压缩包内容不是单独一个 ${bundleName}：${entries.slice(0, 5).join('、')}`)
  }
  const bundle = path.posix.join(extractDirectory, bundleName)
  const stats = await fs.promises.lstat(bundle)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new MacosDesktopInstallFailure(macosDesktopNotOfficialMessage, `压缩包里的 ${bundleName} 不是普通目录`)
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
    throw new MacosDesktopInstallFailure(macosDesktopNotOfficialMessage, 'Info.plist 读不出来')
  }
  if (!isRecord(plist) || plist.CFBundleIdentifier !== source.bundleIdentifier) {
    throw new MacosDesktopInstallFailure(macosDesktopNotOfficialMessage, `bundle identifier 不是 ${source.bundleIdentifier}`)
  }
  if (typeof plist.LSMinimumSystemVersion === 'string') {
    const system = await runProcess({ executable: '/usr/bin/sw_vers', argv: ['-productVersion'], timeoutMs: probeTimeoutMs })
    if (isMacosVersionBelow(system.stdout, plist.LSMinimumSystemVersion)) {
      throw new MacosDesktopInstallFailure(
        macosDesktopSystemTooOldMessage(source.name, plist.LSMinimumSystemVersion),
        `这台 Mac 是 macOS ${system.stdout.trim()}，应用要求 ${plist.LSMinimumSystemVersion} 以上`,
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
    if (rejectedByCheck(error)) throw new MacosDesktopInstallFailure(macosDesktopNotOfficialMessage, `签名不是 ${source.teamIdentifier} 团队的 Developer ID`, error)
    throw error
  }
  try {
    await runProcess({ executable: '/usr/sbin/spctl', argv: ['--assess', '--type', 'execute', bundle], timeoutMs: gatekeeperTimeoutMs })
  } catch (error) {
    if (rejectedByCheck(error)) throw new MacosDesktopInstallFailure(macosDesktopNotOfficialMessage, 'Gatekeeper 没有放行（没有公证或签名已被吊销）', error)
    throw error
  }
  return bundle
}

async function placeBundle(
  source: MacosDesktopAppSource,
  bundle: string,
  destination: string,
  runProcess: InstallMacosDesktopAppOptions['runProcess'],
): Promise<void> {
  const nameTaken = () => new MacosDesktopInstallFailure(macosDesktopNameTakenMessage(source.applicationName), `${destination} 在下载期间出现了`)
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
  const temporary = path.posix.join(path.posix.dirname(destination), `.${path.posix.basename(destination)}.xingmang-${randomBytes(6).toString('hex')}`)
  try {
    await runProcess({ executable: '/usr/bin/ditto', argv: [bundle, temporary], timeoutMs: copyTimeoutMs })
    if (await lstatOrNull(destination)) throw nameTaken()
    await fs.promises.rename(temporary, destination)
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
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
  const bundleName = `${source.applicationName}.app`
  let stage: 'download' | 'verify' | 'place' = 'place'
  let staging: string | null = null
  try {
    const applications = await resolveApplicationsDirectory(options.userHome, options.systemApplicationsDirectory ?? '/Applications')
    const destination = path.posix.join(applications, bundleName)
    // 首页认得出的那份早就让安装提前结束了；走到这里还占着名字的，是认不出来的那份。
    if (await lstatOrNull(destination)) {
      throw new MacosDesktopInstallFailure(macosDesktopNameTakenMessage(source.applicationName), `${destination} 已存在，但不是能核对的官方原版`)
    }
    staging = await createStagingDirectory(options.environment)

    stage = 'download'
    const release = source.selectRelease(await fetchFeed(options.tool, source, options.fetch), architecture)
    if (!release) {
      throw new MacosDesktopInstallFailure(macosDesktopInstallFailedMessage(source.name), '官方版本信息里没有这台 Mac 能用的安装包')
    }
    const archive = path.posix.join(staging, 'package.tar.gz')
    const downloading = `正在下载 ${source.name} ${release.version}`
    let reported: number | null = 0
    report('downloading', downloading, reported)
    await downloadWithResume({
      targetPath: archive,
      fileMode: 0o600,
      maximumBytes: source.maximumArchiveBytes,
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
      ...(options.wait ? { wait: options.wait } : {}),
    })

    stage = 'verify'
    report('checking', '正在检查下载下来的安装包是不是完整的官方版')
    const extractDirectory = path.posix.join(staging, 'extract')
    await fs.promises.mkdir(extractDirectory, { mode: 0o700 })
    try {
      // /usr/bin/tar is bsdtar under SIP. By default it strips a leading "/", refuses
      // entries containing ".." and will not extract through a symlink, so the archive
      // cannot write outside the staging directory before its signature is checked.
      await options.runProcess({ executable: '/usr/bin/tar', argv: ['-xzf', archive, '-C', extractDirectory], timeoutMs: extractTimeoutMs })
    } catch (error) {
      if (rejectedByCheck(error)) throw new MacosDesktopInstallFailure(macosDesktopNotOfficialMessage, '安装包解不开', error)
      throw error
    }
    const bundle = await verifyExtractedBundle(source, extractDirectory, bundleName, options.runProcess)

    stage = 'place'
    report('installing', '正在放进「应用程序」')
    await placeBundle(source, bundle, destination, options.runProcess)
    return { version: release.version, path: destination }
  } catch (error) {
    if (error instanceof MacosDesktopInstallFailure) throw error
    const detail = error instanceof Error ? error.message : String(error)
    const message = stage === 'download' ? macosDesktopDownloadFailedMessage(source.name) : macosDesktopInstallFailedMessage(source.name)
    throw new MacosDesktopInstallFailure(message, detail, error)
  } finally {
    if (staging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
