import fs from 'node:fs'
import { readBoundedResponseText } from './bounded-response'
import { downloadWithResume, DownloadStalledError, type ResumableDownloadOptions } from './download-retry'

/**
 * 星芒自己的腾讯云存储桶里放着 Codex、Claude 桌面端的官方离线包：scripts/sync-chatgpt-official-cos.cjs、
 * sync-claude-official-cos.cjs 定时从官方下载、在 GitHub 的 Windows / Mac 机器上核过签名才传上去，
 * 清单里写着每个包的大小和 SHA-256。装桌面端时先从这里下：国内快，也用不着加速（yoyo 2026-10-10
 * 「需要从存储桶下载，因为后期我打算去掉游戏加速这个功能」）。桶里没有、读不到、对不上，都悄悄换回
 * 原来那几路，客户看不出来。
 *
 * Trust: the bucket origin below is a constant. Nothing in settings, the environment or a
 * response can point this module at another host. The index names an object key; the key
 * must have exactly the shape the sync script writes for that platform, and the file URL
 * must be exactly origin + key. Redirects are refused outright, because the bucket serves
 * its objects directly (I10). The index's size and SHA-256 bind the download, and every
 * caller still runs the same package identity and signature checks it runs on the vendor's
 * own package. A wrong or tampered bucket can therefore cost one download before the old
 * route takes over, but it cannot get a package installed.
 */

export const desktopPackageBucketOrigin = 'https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com'
const desktopPackageBucketHost = new URL(desktopPackageBucketOrigin).hostname
const codexIndexKey = 'chatgpt/latest.json'
const claudeIndexKey = 'xingmang/offline/claude/latest.json'
const maximumIndexBytes = 256 * 1024
const indexTimeoutMs = 10_000
// 同 codex-desktop-service.ts 的安装包上下限：再小不是安装包，再大管理员安装那一步也会拒收。
const minimumPackageBytes = 10 * 1024 * 1024
const maximumWindowsPackageBytes = 1_500 * 1024 * 1024
const maximumMacPackageBytes = 2 * 1024 * 1024 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])
// 桶那一路照目前的平均速度还要这么久以上才下得完，就不等了，换原来那几路（同 Codex 桌面端
// 官网那一路的 10 分钟）。在国外的客户连上海的桶可能很慢，原来那几路对他们反而快。
export const desktopBucketDownloadLimitMs = 10 * 60_000
// 刚开始那半分钟速度还没稳（建连接、TCP 慢启动），不据此放弃。
const slowDownloadGraceMs = 30_000

export type DesktopBucketPackageId =
  | 'codex-windows-x64'
  | 'codex-windows-arm64'
  | 'codex-macos-arm64'
  | 'codex-macos-x64'
  | 'claude-windows-x64'
  | 'claude-windows-arm64'
  | 'claude-macos-universal'

export interface DesktopBucketPackage {
  id: DesktopBucketPackageId
  version: string
  url: string
  bytes: number
  /** Lower-case hex. */
  sha256: string
  /** The Content-Type the sync uploaded the object with. */
  contentType: string
}

export interface DesktopBucketOptions {
  /** 存储桶那一路没走通（读不到清单、文件对不上、太慢……）时的原话，只进运行日志，不上屏。 */
  onFallback?(detail: string): void
}

/**
 * 存储桶那一路读清单、下载、核对时出的错：调用方据此悄悄换回原来那几路。客户点的取消不包成它，
 * 交给系统去装那一步出的错也不包成它（包是好的，换一路重下一遍也一样装不上）。
 */
export class DesktopBucketUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'DesktopBucketUnavailableError'
  }
}

interface CodexWindowsSpec {
  index: 'codex'
  platformId: 'windows-x64' | 'windows-arm64'
  architecture: 'x64' | 'arm64'
}

interface CodexMacSpec {
  index: 'codex'
  platformId: 'macos-arm64' | 'macos-x64'
  architecture: 'arm64' | 'x64'
}

interface ClaudeSpec {
  index: 'claude'
  platformId: 'windows-x64' | 'windows-arm64' | 'macos-pkg-universal'
  platform: 'windows' | 'macos'
  architecture: 'x64' | 'arm64' | 'universal'
  format: 'msix' | 'pkg'
  fileName: string
  contentType: string
  verification: string
  versionPattern: RegExp
  maximumBytes: number
}

const windowsPackageVersionPattern = /^\d{1,5}(?:\.\d{1,5}){3}$/

const packageSpecs: Record<DesktopBucketPackageId, CodexWindowsSpec | CodexMacSpec | ClaudeSpec> = {
  'codex-windows-x64': { index: 'codex', platformId: 'windows-x64', architecture: 'x64' },
  'codex-windows-arm64': { index: 'codex', platformId: 'windows-arm64', architecture: 'arm64' },
  'codex-macos-arm64': { index: 'codex', platformId: 'macos-arm64', architecture: 'arm64' },
  'codex-macos-x64': { index: 'codex', platformId: 'macos-x64', architecture: 'x64' },
  'claude-windows-x64': {
    index: 'claude', platformId: 'windows-x64', platform: 'windows', architecture: 'x64', format: 'msix',
    fileName: 'Claude-x64.msix', contentType: 'application/vnd.ms-appx', verification: 'windows-authenticode-msix-identity',
    versionPattern: windowsPackageVersionPattern, maximumBytes: maximumWindowsPackageBytes,
  },
  'claude-windows-arm64': {
    index: 'claude', platformId: 'windows-arm64', platform: 'windows', architecture: 'arm64', format: 'msix',
    fileName: 'Claude-arm64.msix', contentType: 'application/vnd.ms-appx', verification: 'windows-authenticode-msix-identity',
    versionPattern: windowsPackageVersionPattern, maximumBytes: maximumWindowsPackageBytes,
  },
  // 桶里的 Claude Mac 是兼容两种芯片的通用 PKG（还有一份同版本的 DMG，用 PKG 是因为它不用挂载就能
  // 展开）；版本号的样子同 macos-desktop-app-installer.ts 认官方更新接口时的那条。
  'claude-macos-universal': {
    index: 'claude', platformId: 'macos-pkg-universal', platform: 'macos', architecture: 'universal', format: 'pkg',
    fileName: 'Claude-universal.pkg', contentType: 'application/vnd.apple.installer+xml', verification: 'macos-installer-signature',
    versionPattern: /^\d{1,4}\.\d{1,6}\.\d{1,6}$/, maximumBytes: maximumMacPackageBytes,
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isPackageSize(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimumPackageBytes && value <= maximum
}

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

export function desktopBucketIndexUrl(id: DesktopBucketPackageId): string {
  return objectUrl(packageSpecs[id].index === 'codex' ? codexIndexKey : claudeIndexKey)
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > maximumIndexBytes) return null
  try {
    const value = JSON.parse(text) as unknown
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/**
 * chatgpt/latest.json：platforms 下按平台一条，artifact 是桶里那个文件。Windows 的目录是包版本，
 * 版本还得和清单顶上的 windows.buildVersion 一致；Mac 的目录是 SHA-256，文件名里带版本。
 */
function parseCodexEntry(root: Record<string, unknown>, spec: CodexWindowsSpec | CodexMacSpec, id: DesktopBucketPackageId): DesktopBucketPackage | null {
  if (root.schemaVersion !== 1 || root.product !== 'chatgpt' || !isRecord(root.platforms)) return null
  const entry = root.platforms[spec.platformId]
  if (!isRecord(entry) || !isRecord(entry.artifact)) return null
  const artifact = entry.artifact
  if (entry.architecture !== spec.architecture || !isSha256Hex(artifact.sha256) || typeof artifact.key !== 'string') return null
  let version: string
  let key: string
  let contentType: string
  let verification: string
  let maximumBytes: number
  if (spec.platformId === 'windows-x64' || spec.platformId === 'windows-arm64') {
    const windows = root.windows
    if (
      entry.platform !== 'windows'
      || entry.format !== 'msix'
      || typeof entry.packageVersion !== 'string'
      || !windowsPackageVersionPattern.test(entry.packageVersion)
      || !isRecord(windows)
      || windows.packageIdentity !== 'OpenAI.Codex'
      || windows.buildVersion !== entry.packageVersion
    ) return null
    version = entry.packageVersion
    key = `chatgpt/${spec.platformId}/${version}/ChatGPT-${spec.architecture}.msix`
    contentType = 'application/vnd.ms-appx'
    verification = 'windows-authenticode'
    maximumBytes = maximumWindowsPackageBytes
  } else {
    if (
      entry.platform !== 'macos'
      || entry.format !== 'zip'
      || typeof entry.appVersion !== 'string'
      || !/^\d{1,4}\.\d{1,6}\.\d{1,9}$/.test(entry.appVersion)
    ) return null
    version = entry.appVersion
    key = `chatgpt/${spec.platformId}/sha256-${artifact.sha256}/ChatGPT-darwin-${spec.architecture}-${version}.zip`
    contentType = 'application/zip'
    verification = 'official-https-sha256'
    maximumBytes = maximumMacPackageBytes
  }
  if (
    artifact.key !== key
    || artifact.url !== objectUrl(key)
    || artifact.contentType !== contentType
    || artifact.verification !== verification
    || !isPackageSize(artifact.bytes, maximumBytes)
  ) return null
  return { id, version, url: objectUrl(key), bytes: artifact.bytes, sha256: artifact.sha256, contentType }
}

/** xingmang/offline/claude/latest.json：files 里按平台一条，目录是 SHA-256。 */
function parseClaudeEntry(root: Record<string, unknown>, spec: ClaudeSpec, id: DesktopBucketPackageId): DesktopBucketPackage | null {
  if (root.schemaVersion !== 1 || root.product !== 'claude-desktop' || !Array.isArray(root.files) || root.files.length > 16) return null
  const entries = root.files.filter((file) => isRecord(file) && file.platformId === spec.platformId)
  if (entries.length !== 1 || !isRecord(entries[0])) return null
  const file = entries[0]
  if (!isSha256Hex(file.sha256) || typeof file.version !== 'string' || !spec.versionPattern.test(file.version)) return null
  const key = `xingmang/offline/claude/${spec.platformId}/sha256-${file.sha256}/${spec.fileName}`
  if (
    file.platform !== spec.platform
    || file.architecture !== spec.architecture
    || file.kind !== 'installer'
    || file.format !== spec.format
    || file.fileName !== spec.fileName
    || file.type !== spec.contentType
    || file.verification !== spec.verification
    || file.key !== key
    || file.url !== objectUrl(key)
    || !isPackageSize(file.size, spec.maximumBytes)
  ) return null
  return { id, version: file.version, url: objectUrl(key), bytes: file.size, sha256: file.sha256, contentType: spec.contentType }
}

/** 从桶里的清单原文挑出这个包；格式、地址、大小、摘要有一处不对就是 null。 */
export function parseDesktopBucketIndex(text: string, id: DesktopBucketPackageId): DesktopBucketPackage | null {
  const root = parseJsonRecord(text)
  if (!root) return null
  const spec = packageSpecs[id]
  return spec.index === 'codex' ? parseCodexEntry(root, spec, id) : parseClaudeEntry(root, spec, id)
}

/** 只认桶本身的固定地址：https、这个主机、没有端口和账号、没有查询和片段。 */
export function validateDesktopBucketUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('存储桶地址格式无效')
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== desktopPackageBucketHost
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/(?:chatgpt|xingmang\/offline\/claude)\/[A-Za-z0-9._\-/]+$/.test(url.pathname)
    || url.pathname.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Error('存储桶地址不在允许的范围内')
  }
  return url
}

/** The bucket serves objects directly, so any redirect means something in between is answering. */
export async function fetchDesktopBucketResource(
  url: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
): Promise<Response> {
  const target = validateDesktopBucketUrl(url)
  const response = await fetchImplementation(target.href, { ...init, redirect: 'manual', credentials: 'omit' })
  if (response.url && response.url !== target.href) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('存储桶的下载被转到了别的地址')
  }
  if (redirectStatuses.has(response.status)) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`存储桶返回了跳转（HTTP ${response.status}）`)
  }
  return response
}

function abortedBy(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('下载已取消')
}

/**
 * 读桶里的清单，挑出这个包。读不到、太慢、格式不对都抛 DesktopBucketUnavailableError；
 * 客户点了取消就原样抛 signal 的 reason。
 */
export async function readDesktopBucketPackage(
  id: DesktopBucketPackageId,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<DesktopBucketPackage> {
  const timeout = AbortSignal.timeout(indexTimeoutMs)
  try {
    const response = await fetchDesktopBucketResource(desktopBucketIndexUrl(id), {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }, fetchImplementation)
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`存储桶清单返回 HTTP ${response.status}`)
    }
    const release = parseDesktopBucketIndex(await readBoundedResponseText(response, maximumIndexBytes, '存储桶清单'), id)
    if (!release) throw new Error('存储桶清单里没有这台电脑能用的安装包，或清单格式对不上')
    return release
  } catch (error) {
    if (signal?.aborted) throw abortedBy(signal)
    if (timeout.aborted) throw new DesktopBucketUnavailableError('读取存储桶清单超时', error)
    throw new DesktopBucketUnavailableError(error instanceof Error ? error.message : String(error), error)
  }
}

/** 照开始以来的平均速度，还要多久才下得完；还没收到数据时算不出来，返回 null。 */
function remainingMs(elapsedMs: number, transferred: number, total: number): number | null {
  if (transferred <= 0 || elapsedMs < 0) return null
  return Math.max(0, total - transferred) * elapsedMs / transferred
}

/** 下了半分钟以上，照目前的速度还要超过 limitMs 才下得完（或者还一个字节都没收到）。 */
export function isDesktopBucketDownloadTooSlow(elapsedMs: number, transferred: number, total: number, limitMs: number = desktopBucketDownloadLimitMs): boolean {
  if (elapsedMs < slowDownloadGraceMs) return false
  const remaining = remainingMs(elapsedMs, transferred, total)
  return remaining === null || remaining > limitMs
}

export interface DesktopBucketDownloadProgress {
  transferred: number
  total: number
  /** 0–100，按整数取。 */
  percent: number
  /** 网络断了一下、正要接着下时为 true。 */
  resuming?: boolean
}

export interface DesktopBucketDownloadOptions {
  fetch: typeof fetch
  /** 客户点了取消。 */
  signal?: AbortSignal
  /** 百分比变了才回调，免得一次下载发出几千条进度。 */
  onProgress?(progress: DesktopBucketDownloadProgress): void
  /** 测试接缝：断线后等多久、多久没数据算停住、判「太慢」用的时钟和门槛。 */
  resumeOptions?: Pick<ResumableDownloadOptions, 'wait' | 'idleTimeoutMs'>
  now?: () => number
  limitMs?: number
}

export interface DesktopBucketDownloadResult {
  size: number
  sha256Base64: string
}

function mediaType(value: string | null): string {
  return (value ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * 把清单里的那个包下到 destination：大小、类型、SHA-256 一处对不上、太慢、断得接不上，都删掉
 * 半个文件、抛 DesktopBucketUnavailableError。客户点了取消就原样抛 signal 的 reason。
 */
export async function downloadDesktopBucketPackage(
  release: DesktopBucketPackage,
  destination: string,
  options: DesktopBucketDownloadOptions,
): Promise<DesktopBucketDownloadResult> {
  const now = options.now ?? Date.now
  const limitMs = options.limitMs ?? desktopBucketDownloadLimitMs
  const slow = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, slow.signal]) : slow.signal
  const startedAt = now()
  let lastPercent = -1
  function percentOf(transferred: number): number {
    return Math.min(100, Math.floor(transferred / release.bytes * 100))
  }
  try {
    const download = await downloadWithResume({
      targetPath: destination,
      fileMode: 0o600,
      // 清单写了多大就只收这么多：多一个字节都不是它说的那个包。
      maximumBytes: release.bytes,
      oversizeMessage: '存储桶返回的数据比清单里写的大',
      signal,
      responseTimeoutMs: 20_000,
      idleTimeoutMs: 45_000,
      ...options.resumeOptions,
      request: (headers, requestSignal) => fetchDesktopBucketResource(release.url, {
        headers: { Accept: `${release.contentType}, application/octet-stream`, ...headers },
        signal: requestSignal,
      }, options.fetch),
      acceptResponse: (response) => {
        if (response.status !== 200) throw new Error(`存储桶返回 HTTP ${response.status}`)
        const type = mediaType(response.headers.get('content-type'))
        if (type !== release.contentType && type !== 'application/octet-stream') {
          throw new Error(`存储桶返回的文件类型不对（Content-Type: ${type || '缺失'}）`)
        }
        const declared = Number(response.headers.get('content-length'))
        if (declared !== release.bytes) {
          throw new Error(`存储桶返回的大小和清单不一致：应为 ${release.bytes} 字节，实际 ${response.headers.get('content-length') ?? '没写'}`)
        }
        if (!response.body) throw new Error('存储桶没有返回安装包内容')
        return declared
      },
      onProgress: (transferred) => {
        if (!slow.signal.aborted && isDesktopBucketDownloadTooSlow(now() - startedAt, transferred, release.bytes, limitMs)) {
          slow.abort(new DesktopBucketUnavailableError('从存储桶下载太慢'))
          return
        }
        const percent = percentOf(transferred)
        if (percent === lastPercent) return
        lastPercent = percent
        options.onProgress?.({ transferred, total: release.bytes, percent })
      },
      onResume: (transferred) => {
        options.onProgress?.({ transferred, total: release.bytes, percent: percentOf(transferred), resuming: true })
      },
    })
    if (download.size !== release.bytes) throw new Error(`存储桶的安装包没下完：应为 ${release.bytes} 字节，实际 ${download.size} 字节`)
    if (download.sha256.toString('hex') !== release.sha256) throw new Error('存储桶的安装包 SHA-256 和清单不一致')
    return { size: download.size, sha256Base64: download.sha256.toString('base64') }
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined)
    if (options.signal?.aborted) throw abortedBy(options.signal)
    if (slow.signal.aborted) throw slow.signal.reason
    if (error instanceof DownloadStalledError || (error instanceof Error && error.name === 'AbortError')) {
      throw new DesktopBucketUnavailableError('从存储桶下载时连接或下载超时', error)
    }
    throw new DesktopBucketUnavailableError(error instanceof Error ? error.message : String(error), error)
  }
}

/** 记日志时那一行原话：开头带上是哪个包，免得客服分不清是 Codex 还是 Claude。 */
export function describeDesktopBucketFallback(id: DesktopBucketPackageId, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${id}：${detail || '存储桶这一路没走通'}`
}
