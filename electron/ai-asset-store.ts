import fs from 'node:fs'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { lookup as nodeLookup } from 'node:dns/promises'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import {
  assertNoReparseComponents,
  ensureSafeDataDirectory,
  removeSafeDataFile,
} from './safe-local-data'
import { sameLocalPathIdentity } from './path-identity'

const DEFAULT_MAXIMUM_IMAGE_BYTES = 64 * 1024 * 1024
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000
const MAXIMUM_REMOTE_URL_LENGTH = 4_096
const MAXIMUM_REDIRECTS = 3
const MAXIMUM_REVISED_PROMPT_LENGTH = 40_000
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const FILE_LABEL = 'AI 图片资产'

const blockedIpv4Addresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedIpv4Addresses.addSubnet(address, prefix, 'ipv4')
const blockedIpv6Addresses = new BlockList()
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blockedIpv6Addresses.addSubnet(address, prefix, 'ipv6')

export interface AiStoredAsset {
  assetId: string
  localUrl: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width?: number
  height?: number
  fileName: string
  revisedPrompt?: string
}

export interface AiAssetMetadata {
  revisedPrompt?: string
}

export interface AiOwnedAssetRead {
  asset: AiStoredAsset
  bytes: Buffer
}

export interface AiAssetListQuery {
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image'
  search?: string
}

export interface AiAssetListPage {
  items: Array<AiStoredAsset & { createdAt: string; mediaType: 'image'; thumbnailUrl: string }>
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export interface AiAssetContextMenuItem {
  id: 'copy' | 'save-as' | 'reveal-in-folder'
  label: string
  run(): Promise<void>
}

export interface AiAssetNativeOperations {
  copyImage(bytes: Buffer, mimeType: AiStoredAsset['mimeType']): void | Promise<void>
  selectSavePath(suggestedFileName: string): Promise<string | null>
  revealInFolder(filePath: string): void | Promise<void>
  showContextMenu(items: readonly AiAssetContextMenuItem[]): void | Promise<void>
}

export type AiAssetDnsLookup = (hostname: string) => Promise<readonly string[]>
export type AiAssetFetch = (
  input: string,
  init: RequestInit,
  resolvedAddresses: readonly string[],
) => Promise<Response>

export interface ResolveAiOutputRootOptions {
  isPackaged: boolean
  projectRoot?: string
  execPath?: string
}

export interface AiAssetStoreOptions {
  outputRoot: string
  fetchImpl?: AiAssetFetch
  dnsLookup?: AiAssetDnsLookup
  nativeOperations?: Partial<AiAssetNativeOperations>
  now?: () => Date
  randomBytes?: (size: number) => Buffer
  maximumImageBytes?: number
  downloadTimeoutMs?: number
}

interface OwnedAssetRecord {
  userId: number
  filePath: string
  asset: AiStoredAsset
}

interface ImageInspection {
  mimeType: AiStoredAsset['mimeType']
  extension: 'png' | 'jpg' | 'webp'
  width?: number
  height?: number
}

export function resolveAiOutputRoot(options: ResolveAiOutputRootOptions): string {
  const base = options.isPackaged
    ? path.dirname(path.resolve(options.execPath ?? process.execPath))
    : path.resolve(options.projectRoot ?? process.cwd())
  return path.join(base, 'output')
}

function assertUserId(userId: number): void {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('AI 图片账号标识格式错误')
}

function assertAssetId(assetId: string): void {
  if (!ASSET_ID_PATTERN.test(assetId)) throw new Error('AI 图片资产标识无效')
}

function normalizeRevisedPrompt(meta: AiAssetMetadata | undefined): string | undefined {
  const value = meta?.revisedPrompt
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > MAXIMUM_REVISED_PROMPT_LENGTH || value.includes('\0')) {
    throw new Error('AI 图片修订提示词格式错误')
  }
  return value
}

function dateDirectoryName(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('AI 图片保存日期无效')
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function publicAsset(assetId: string, inspection: ImageInspection, revisedPrompt?: string): AiStoredAsset {
  const fileName = `xingmang-${assetId}.${inspection.extension}`
  return {
    assetId,
    localUrl: `xingmang-asset://image/${assetId}`,
    mimeType: inspection.mimeType,
    ...(inspection.width ? { width: inspection.width } : {}),
    ...(inspection.height ? { height: inspection.height } : {}),
    fileName,
    ...(revisedPrompt ? { revisedPrompt } : {}),
  }
}

function pngInspection(bytes: Buffer): ImageInspection | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return { mimeType: 'image/png', extension: 'png', ...(width && height ? { width, height } : {}) }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    offset += 2
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3)
      const width = bytes.readUInt16BE(offset + 5)
      return width && height ? { width, height } : null
    }
    offset += length
  }
  return null
}

function jpegInspection(bytes: Buffer): ImageInspection | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null
  const dimensions = jpegDimensions(bytes)
  return { mimeType: 'image/jpeg', extension: 'jpg', ...(dimensions ?? {}) }
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    }
  }
  return null
}

function webpInspection(bytes: Buffer): ImageInspection | null {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null
  const dimensions = webpDimensions(bytes)
  return { mimeType: 'image/webp', extension: 'webp', ...(dimensions ?? {}) }
}

function normalizeDeclaredMime(value: string | null | undefined): string | null {
  const mime = value?.split(';', 1)[0].trim().toLowerCase()
  return mime || null
}

export function inspectAiImage(bytes: Buffer, declaredMime?: string | null): ImageInspection {
  const inspection = pngInspection(bytes) ?? jpegInspection(bytes) ?? webpInspection(bytes)
  if (!inspection) throw new Error('图片内容无效，仅支持 PNG、JPEG 或 WebP')
  const normalizedMime = normalizeDeclaredMime(declaredMime)
  if (
    normalizedMime
    && normalizedMime !== 'application/octet-stream'
    && normalizedMime !== inspection.mimeType
    && !(normalizedMime === 'image/jpg' && inspection.mimeType === 'image/jpeg')
  ) {
    throw new Error('图片响应 MIME 与实际内容不一致')
  }
  return inspection
}

function decodedBase64Size(value: string): number {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('图片 base64 数据格式错误')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function parseBase64Image(value: string, maximumBytes: number): { bytes: Buffer; declaredMime: string | null } {
  let payload = value
  let declaredMime: string | null = null
  if (value.startsWith('data:')) {
    const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/)
    if (!match) throw new Error('图片 data URL 格式错误')
    declaredMime = normalizeDeclaredMime(match[1])
    if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(declaredMime ?? '')) {
      throw new Error('图片 data URL 类型不受支持')
    }
    payload = match[2]
  }
  if (decodedBase64Size(payload) > maximumBytes) throw new Error('单张图片超过 64 MB 安全上限')
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0 || bytes.length > maximumBytes) throw new Error('单张图片超过 64 MB 安全上限')
  return { bytes, declaredMime }
}

function normalizeIpAddress(address: string): { address: string; family: 'ipv4' | 'ipv6' } | null {
  const withoutZone = address.split('%', 1)[0]
  const version = isIP(withoutZone)
  if (version === 4) return { address: withoutZone, family: 'ipv4' }
  if (version === 6) return { address: withoutZone, family: 'ipv6' }
  return null
}

export function isPublicAiAssetAddress(address: string): boolean {
  const parsed = normalizeIpAddress(address)
  if (!parsed) return false
  return parsed.family === 'ipv4'
    ? !blockedIpv4Addresses.check(parsed.address, 'ipv4')
    : !blockedIpv6Addresses.check(parsed.address, 'ipv6')
}

export function validateAiAssetRemoteUrl(value: string): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_REMOTE_URL_LENGTH) {
    throw new Error('图片远程地址格式错误')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('图片远程地址格式错误')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hostname === ''
    || parsed.hash !== ''
    || parsed.hostname.toLowerCase() === 'localhost'
    || parsed.hostname.toLowerCase().endsWith('.localhost')
  ) {
    throw new Error('图片远程地址必须是公开且不含凭据的 HTTPS 地址')
  }
  return parsed
}

async function defaultDnsLookup(hostname: string): Promise<readonly string[]> {
  const literal = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (isIP(literal)) return [literal]
  return (await nodeLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
}

async function assertPublicRemoteHost(url: URL, dnsLookup: AiAssetDnsLookup): Promise<readonly string[]> {
  const addresses = await dnsLookup(url.hostname)
  if (!addresses.length || addresses.some((address) => !isPublicAiAssetAddress(address))) {
    throw new Error('图片远程地址解析到私网、回环或保留地址')
  }
  return addresses
}

async function defaultPinnedAiAssetFetch(
  input: string,
  init: RequestInit,
  resolvedAddresses: readonly string[],
): Promise<Response> {
  const candidates = resolvedAddresses
    .map(normalizeIpAddress)
    .filter((entry): entry is NonNullable<ReturnType<typeof normalizeIpAddress>> => Boolean(entry))
  if (!candidates.length) throw new Error('图片远程地址没有可用的公网解析结果')
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const requestedFamily = Number(lookupOptions.family || 0)
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? candidates.filter((entry) => entry.family === `ipv${requestedFamily}`)
      : candidates
    const selected = eligible[0]
    if (!selected) {
      callback(Object.assign(new Error('图片远程地址没有匹配的公网解析结果'), { code: 'ENOTFOUND' }), '', 0)
      return
    }
    const family = selected.family === 'ipv4' ? 4 : 6
    if (lookupOptions.all) callback(null, eligible.map((entry) => ({
      address: entry.address,
      family: entry.family === 'ipv4' ? 4 : 6,
    })))
    else callback(null, selected.address, family)
  }

  return new Promise<Response>((resolve, reject) => {
    const request = https.request(input, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      signal: init.signal ?? undefined,
      agent: false,
      lookup,
    }, (response) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry))
        else if (value !== undefined) headers.set(name, String(value))
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage,
        headers,
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('单张图片超过 64 MB 安全上限')
  }
  if (!response.body) throw new Error('图片下载响应没有内容')
  const chunks: Buffer[] = []
  const reader = response.body.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) throw new Error('单张图片超过 64 MB 安全上限')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  if (total === 0) throw new Error('图片下载响应为空')
  return Buffer.concat(chunks, total)
}

async function fetchRemoteImage(
  sourceUrl: string,
  fetchImpl: AiAssetFetch,
  dnsLookup: AiAssetDnsLookup,
  maximumBytes: number,
  timeoutMs: number,
): Promise<{ bytes: Buffer; declaredMime: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let current = validateAiAssetRemoteUrl(sourceUrl)
  const visited = new Set<string>()
  try {
    for (let redirectCount = 0; redirectCount <= MAXIMUM_REDIRECTS; redirectCount += 1) {
      if (visited.has(current.href)) throw new Error('图片下载发生循环重定向')
      visited.add(current.href)
      const resolvedAddresses = await assertPublicRemoteHost(current, dnsLookup)
      const response = await fetchImpl(current.href, {
        method: 'GET',
        headers: { Accept: 'image/png,image/jpeg,image/webp' },
        redirect: 'manual',
        signal: controller.signal,
      }, resolvedAddresses)
      if (response.url && response.url !== current.href) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('图片下载绕过了受限重定向策略')
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount === MAXIMUM_REDIRECTS) throw new Error('图片下载重定向次数过多')
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) throw new Error('图片下载重定向缺少 Location')
        current = validateAiAssetRemoteUrl(new URL(location, current).href)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`图片下载失败，服务返回 ${response.status}`)
      }
      const contentType = normalizeDeclaredMime(response.headers.get('content-type'))
      if (contentType && !['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/octet-stream'].includes(contentType)) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('图片下载响应类型不受支持')
      }
      return { bytes: await readBoundedResponse(response, maximumBytes), declaredMime: contentType }
    }
    throw new Error('图片下载重定向次数过多')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('图片下载超时')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function readBoundedOwnedFile(filePath: string, maximumBytes: number, directoryAlreadyChecked = false): Promise<Buffer> {
  if (!directoryAlreadyChecked) assertNoReparseComponents(filePath, FILE_LABEL)
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximumBytes)) {
      throw new Error('AI 图片资产文件无效或超过安全上限')
    }
    const current = await fs.promises.lstat(filePath, { bigint: true })
    const canonical = await fs.promises.realpath(filePath)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino
      || !sameLocalPathIdentity(canonical, filePath)) {
      throw new Error('AI 图片资产文件在读取前发生变化')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error('AI 图片资产文件在读取过程中发生变化')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export class AiAssetStore {
  private readonly outputRoot: string
  private readonly fetchImpl: AiAssetFetch
  private readonly dnsLookup: AiAssetDnsLookup
  private readonly nativeOperations: Partial<AiAssetNativeOperations>
  private readonly now: () => Date
  private readonly randomBytes: (size: number) => Buffer
  private readonly maximumImageBytes: number
  private readonly downloadTimeoutMs: number
  private readonly records = new Map<string, OwnedAssetRecord>()

  constructor(options: AiAssetStoreOptions) {
    this.outputRoot = path.resolve(options.outputRoot)
    this.fetchImpl = options.fetchImpl ?? defaultPinnedAiAssetFetch
    this.dnsLookup = options.dnsLookup ?? defaultDnsLookup
    this.nativeOperations = options.nativeOperations ?? {}
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
    this.maximumImageBytes = options.maximumImageBytes ?? DEFAULT_MAXIMUM_IMAGE_BYTES
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
    if (!Number.isInteger(this.maximumImageBytes) || this.maximumImageBytes < 1 || this.maximumImageBytes > DEFAULT_MAXIMUM_IMAGE_BYTES) {
      throw new Error('AI 图片大小上限配置无效')
    }
    if (!Number.isInteger(this.downloadTimeoutMs) || this.downloadTimeoutMs < 1 || this.downloadTimeoutMs > 10 * 60_000) {
      throw new Error('AI 图片下载超时配置无效')
    }
  }

  /**
   * Create the user-visible image directory during application startup.
   * Persistence still performs the same checks immediately before writing so
   * a directory replaced after startup cannot weaken the path safety boundary.
   */
  ensureOutputDirectory(): void {
    try {
      ensureSafeDataDirectory(this.outputRoot, FILE_LABEL)
    } catch {
      throw new Error('无法创建 output 目录，请检查安装目录写入权限')
    }
  }

  async storeBase64(userId: number, value: string, meta?: AiAssetMetadata): Promise<AiStoredAsset> {
    assertUserId(userId)
    if (typeof value !== 'string') throw new Error('图片 base64 数据格式错误')
    const source = parseBase64Image(value, this.maximumImageBytes)
    return this.persist(userId, source.bytes, source.declaredMime, meta)
  }

  async storeRemoteUrl(userId: number, url: string, meta?: AiAssetMetadata): Promise<AiStoredAsset> {
    assertUserId(userId)
    const source = await fetchRemoteImage(
      url,
      this.fetchImpl,
      this.dnsLookup,
      this.maximumImageBytes,
      this.downloadTimeoutMs,
    )
    return this.persist(userId, source.bytes, source.declaredMime, meta)
  }

  async storeLocalFile(userId: number, filePath: string): Promise<AiStoredAsset> {
    assertUserId(userId)
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
      throw new Error('本地图片路径无效')
    }
    const bytes = await readBoundedOwnedFile(filePath, this.maximumImageBytes)
    return this.persist(userId, bytes, null)
  }

  async readOwned(userId: number, assetId: string): Promise<AiOwnedAssetRead> {
    const record = await this.resolveOwned(userId, assetId)
    const bytes = await readBoundedOwnedFile(record.filePath, this.maximumImageBytes)
    const inspection = inspectAiImage(bytes, record.asset.mimeType)
    return {
      asset: {
        ...record.asset,
        mimeType: inspection.mimeType,
        ...(inspection.width ? { width: inspection.width } : {}),
        ...(inspection.height ? { height: inspection.height } : {}),
      },
      bytes,
    }
  }

  async listOwned(userId: number, maximum = 200): Promise<Array<AiStoredAsset & { createdAt: string }>> {
    assertUserId(userId)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500) throw new Error('AI 图片列表数量无效')
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let dateEntries: fs.Dirent[]
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
      dateEntries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('无法读取 AI 图片资产目录')
    }
    if (dateEntries.length > 4_096) throw new Error('AI 图片资产目录条目过多')
    const result: Array<AiStoredAsset & { createdAt: string }> = []
    for (const dateEntry of dateEntries.sort((left, right) => right.name.localeCompare(left.name))) {
      if (result.length >= maximum) break
      if (!DATE_DIRECTORY_PATTERN.test(dateEntry.name)) continue
      if (dateEntry.isSymbolicLink()) throw new Error('AI 图片资产目录不能经过符号链接或目录联接')
      if (!dateEntry.isDirectory()) continue
      const directory = path.join(accountRoot, dateEntry.name)
      assertNoReparseComponents(directory, FILE_LABEL)
      const files = await fs.promises.readdir(directory, { withFileTypes: true })
      if (files.length > 4_096) throw new Error('AI 图片资产目录条目过多')
      const candidates = files.sort((left, right) => right.name.localeCompare(left.name)).flatMap((entry) => {
        const match = entry.name.match(/^xingmang-([A-Za-z0-9_-]{43})\.(png|jpg|webp)$/)
        return match && entry.isFile() && !entry.isSymbolicLink()
          ? [{ entry, assetId: match[1], extension: match[2] }]
          : []
      })
      // Four concurrent reads keep the worst-case memory bounded at 256 MB
      // while avoiding 500 fully-serial filesystem round trips after restart.
      for (let offset = 0; offset < candidates.length && result.length < maximum; offset += 4) {
        const batch = await Promise.all(candidates.slice(offset, offset + 4).map(async (candidate) => {
          try {
            const filePath = path.join(directory, candidate.entry.name)
            const bytes = await readBoundedOwnedFile(filePath, this.maximumImageBytes, true)
            const inspection = inspectAiImage(bytes)
            if (inspection.extension !== candidate.extension) throw new Error('AI 图片扩展名与内容不一致')
            const asset = publicAsset(candidate.assetId, inspection)
            const record: OwnedAssetRecord = { userId, filePath, asset }
            this.records.set(candidate.assetId, record)
            const stat = await fs.promises.lstat(filePath)
            return { ...asset, createdAt: stat.birthtime.toISOString() }
          } catch {
            // A missing or malformed file is omitted instead of producing a broken preview.
            return null
          }
        }))
        result.push(...batch.filter((entry): entry is NonNullable<typeof entry> => entry !== null).slice(0, maximum - result.length))
      }
    }
    return result
  }

  async listOwnedPage(userId: number, query: AiAssetListQuery = {}): Promise<AiAssetListPage> {
    assertUserId(userId)
    const offset = query.offset ?? 0
    const limit = query.limit ?? 24
    const mediaType = query.mediaType ?? 'all'
    const search = query.search?.trim() ?? ''
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 500) throw new Error('AI 图片分页位置无效')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('AI 图片分页数量无效')
    if (mediaType !== 'all' && mediaType !== 'image') throw new Error('AI 图片媒体类型无效')
    if (search.length > 128 || /[\x00-\x1F\x7F]/.test(search)) throw new Error('AI 图片搜索内容无效')

    const normalizedSearch = search.toLocaleLowerCase('zh-CN')
    const candidates = (await this.listOwned(userId, 500))
      .map((asset) => ({ ...asset, mediaType: 'image' as const, thumbnailUrl: asset.localUrl }))
      .filter((asset) => mediaType === 'all' || asset.mediaType === mediaType)
      .filter((asset) => !normalizedSearch || [asset.fileName, asset.assetId, asset.revisedPrompt ?? '']
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.assetId.localeCompare(left.assetId))
    const items = candidates.slice(offset, offset + limit)
    return {
      items,
      offset,
      limit,
      total: candidates.length,
      hasMore: offset + items.length < candidates.length,
    }
  }

  async removeOwned(userId: number, assetId: string): Promise<void> {
    const record = await this.resolveOwned(userId, assetId)
    await readBoundedOwnedFile(record.filePath, this.maximumImageBytes)
    await removeSafeDataFile(record.filePath, FILE_LABEL)
    if (this.records.get(assetId) === record) this.records.delete(assetId)
  }

  async copy(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (!this.nativeOperations.copyImage) throw new Error('当前环境不支持复制图片')
    const owned = await this.readOwned(userId, assetId)
    await authorize?.()
    await this.nativeOperations.copyImage(owned.bytes, owned.asset.mimeType)
  }

  async saveAs(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<boolean> {
    if (!this.nativeOperations.selectSavePath) throw new Error('当前环境不支持图片另存为')
    const owned = await this.readOwned(userId, assetId)
    const target = await this.nativeOperations.selectSavePath(owned.asset.fileName)
    if (!target) return false
    await authorize?.()
    if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('图片另存地址无效')
    try {
      await fs.promises.writeFile(target, owned.bytes)
    } catch {
      throw new Error('图片另存失败，请检查目标目录写入权限')
    }
    return true
  }

  async revealInFolder(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (!this.nativeOperations.revealInFolder) throw new Error('当前环境不支持在文件夹中定位')
    const record = await this.resolveOwned(userId, assetId)
    await readBoundedOwnedFile(record.filePath, this.maximumImageBytes)
    await authorize?.()
    await this.nativeOperations.revealInFolder(record.filePath)
  }

  async contextMenu(
    userId: number,
    assetId: string,
    authorize?: () => void | Promise<void>,
  ): Promise<void> {
    if (!this.nativeOperations.showContextMenu) throw new Error('当前环境不支持图片右键菜单')
    await this.resolveOwned(userId, assetId)
    await this.nativeOperations.showContextMenu([
      { id: 'copy', label: '复制图片', run: () => this.copy(userId, assetId, authorize) },
      {
        id: 'save-as',
        label: '图片另存为',
        run: async () => { await this.saveAs(userId, assetId, authorize) },
      },
      {
        id: 'reveal-in-folder',
        label: '在文件夹中显示',
        run: () => this.revealInFolder(userId, assetId, authorize),
      },
    ])
  }

  private async persist(
    userId: number,
    bytes: Buffer,
    declaredMime: string | null,
    meta?: AiAssetMetadata,
  ): Promise<AiStoredAsset> {
    if (bytes.length > this.maximumImageBytes) throw new Error('单张图片超过 64 MB 安全上限')
    const inspection = inspectAiImage(bytes, declaredMime)
    const revisedPrompt = normalizeRevisedPrompt(meta)
    const assetId = this.randomBytes(32).toString('base64url')
    assertAssetId(assetId)
    const asset = publicAsset(assetId, inspection, revisedPrompt)
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    const directory = path.join(accountRoot, dateDirectoryName(this.now()))
    const filePath = path.join(directory, asset.fileName)
    if (!pathIsWithin(this.outputRoot, filePath) || !pathIsWithin(accountRoot, filePath)) {
      throw new Error('AI 图片输出路径越界')
    }
    const temporaryPath = path.join(directory, `.${asset.fileName}.${this.randomBytes(16).toString('hex')}.tmp`)
    let finalLinked = false
    try {
      ensureSafeDataDirectory(this.outputRoot, FILE_LABEL)
      ensureSafeDataDirectory(accountRoot, FILE_LABEL)
      ensureSafeDataDirectory(directory, FILE_LABEL)
      const handle = await fs.promises.open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A same-directory hard link publishes the fully-synced inode in one
      // exclusive operation: unlike rename on POSIX it cannot overwrite an
      // existing random-id collision.
      await fs.promises.link(temporaryPath, filePath)
      finalLinked = true
      await fs.promises.rm(temporaryPath)
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
      if (finalLinked) await fs.promises.rm(filePath, { force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && fs.existsSync(filePath)) {
        throw new Error('AI 图片资产标识冲突，请重试')
      }
      throw new Error('无法写入 output 目录，请检查安装目录写入权限')
    }
    const record: OwnedAssetRecord = { userId, filePath, asset }
    this.records.set(assetId, record)
    return { ...asset }
  }

  private async resolveOwned(userId: number, assetId: string): Promise<OwnedAssetRecord> {
    assertUserId(userId)
    assertAssetId(assetId)
    const known = this.records.get(assetId)
    if (known) {
      if (known.userId !== userId) throw new Error('无权访问该 AI 图片资产')
      if (!pathIsWithin(path.join(this.outputRoot, `user-${userId}`), known.filePath)) {
        throw new Error('AI 图片资产路径越界')
      }
      return known
    }

    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let dateEntries: fs.Dirent[]
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
      dateEntries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch {
      throw new Error('AI 图片资产不存在或无权访问')
    }
    if (dateEntries.length > 4_096) throw new Error('AI 图片资产目录条目过多')
    for (const dateEntry of dateEntries) {
      if (!dateEntry.isDirectory() || dateEntry.isSymbolicLink() || !DATE_DIRECTORY_PATTERN.test(dateEntry.name)) continue
      for (const extension of ['png', 'jpg', 'webp'] as const) {
        const fileName = `xingmang-${assetId}.${extension}`
        const filePath = path.join(accountRoot, dateEntry.name, fileName)
        try {
          const bytes = await readBoundedOwnedFile(filePath, this.maximumImageBytes)
          const inspection = inspectAiImage(bytes)
          if (inspection.extension !== extension) throw new Error('AI 图片扩展名与内容不一致')
          const asset = publicAsset(assetId, inspection)
          const record: OwnedAssetRecord = { userId, filePath, asset }
          this.records.set(assetId, record)
          return record
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    throw new Error('AI 图片资产不存在或无权访问')
  }
}
