/**
 * 公告里放的官网图片（决定单 D89 a）。主窗口页面的安全设置（app-protocol.ts、index.html 的 img-src）只放行
 * 本地和 data:，公告里写成 `https://xm.solov.cc/…` 的图在页面里一直是破图标。这里由主进程把图下下来，换成
 * data: 地址交给页面，页面的安全设置一点不动。
 *
 * 只下当前账号那个站官网自己的图（relay-sites.ts 的 websiteUrl，同源、https、不带账号密码）：页面送来的地址
 * 一律当敌意输入（I5），站点也由主进程按当前登录定，不信页面说的。I10 那四件都在：下载有时限、正文有上限、
 * 跳转一律拒绝、地址先校验。下回来的东西按开头几个字节认，只收 PNG、JPEG、GIF、WebP 四种，SVG 不收（里面
 * 能带外链和脚本，页面那边也不收）；宽高也有上限，免得一张小文件解出一张特大的图把内存吃光。
 *
 * 不带登录凭据（credentials: 'omit'，也没有 Authorization），图片是公开的；同一张图半小时内只下一次，
 * 同时最多下三张。
 */
import { readBoundedResponseBytes } from './bounded-response'
import { requireRelaySite, type RelayRouteSiteId } from './relay-sites'

/**
 * 一张图最大 1 MB。换成 data: 地址后约 1.4 MB 字符，在页面那边 safeAnnouncementImage 收 data: 图的
 * 200 万字符上限以内；二维码、活动图远用不到这么大。
 */
export const announcementImageMaxBytes = 1024 * 1024
const announcementImageTimeoutMs = 15_000
const maximumUrlLength = 2_048
// 竖长的活动海报可以很高，边长放到 8192；总像素和公告原生正文里内嵌图片的上限一样。
const maximumSide = 8_192
const maximumPixels = 16_000_000
const maximumConcurrentDownloads = 3
// 页面被人控制了也只能叫主进程排这么多张，多了直接拒。
const maximumQueuedDownloads = 32
const cacheMaxBytes = 8 * 1024 * 1024
const cacheTtlMs = 30 * 60 * 1000

export type AnnouncementImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface AnnouncementImageInspection {
  mimeType: AnnouncementImageMimeType
  width: number
  height: number
}

/**
 * 页面送来的公告图片地址：必须是当前账号那个站官网自己的 https 地址，不带账号密码。去掉 # 后面那段（不影响
 * 下哪张图，也免得同一张图因为它缓存两份）。不合格的抛错，不下。
 */
export function resolveAnnouncementImageUrl(siteId: RelayRouteSiteId, value: unknown): URL {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumUrlLength) throw new Error('公告图片地址无效')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('公告图片地址无效')
  }
  const official = new URL(requireRelaySite(siteId).websiteUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== official.origin) {
    throw new Error('公告图片不在当前账号的官网上，不下载')
  }
  url.hash = ''
  return url
}

function dimensionsWithinLimit(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= maximumSide && height <= maximumSide && width * height <= maximumPixels
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function gifDimensions(bytes: Buffer): { width: number; height: number } | null {
  const header = bytes.toString('ascii', 0, 6)
  if (bytes.length < 10 || (header !== 'GIF87a' && header !== 'GIF89a')) return null
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    offset += 2
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    const startOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    if (startOfFrame && length >= 7) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    offset += length
  }
  return null
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    }
  }
  return null
}

/**
 * 按开头几个字节认图片，不看服务回的 Content-Type（它说了不算）。认不出、读不出宽高、宽高超限的都给 null。
 */
export function inspectAnnouncementImage(bytes: Buffer): AnnouncementImageInspection | null {
  const candidates: Array<[AnnouncementImageMimeType, (value: Buffer) => { width: number; height: number } | null]> = [
    ['image/png', pngDimensions],
    ['image/jpeg', jpegDimensions],
    ['image/gif', gifDimensions],
    ['image/webp', webpDimensions],
  ]
  for (const [mimeType, read] of candidates) {
    const dimensions = read(bytes)
    if (!dimensions) continue
    return dimensionsWithinLimit(dimensions.width, dimensions.height) ? { mimeType, ...dimensions } : null
  }
  return null
}

function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin
  } catch {
    return false
  }
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

export interface AnnouncementImageReaderOptions {
  /**
   * 连星芒站点用的 fetch。main.ts 传按线路走、失败不报给线路那边的那一个（bootstrap/network-routes.ts 的
   * announcementImageFetch）：公告里的图下不下来不该叫线路去查健康。
   */
  fetch: typeof fetch
  now?: () => number
  /** 测试用；缺省 15 秒。 */
  timeoutMs?: number
}

export interface AnnouncementImageReader {
  /** 下好的图（data: 地址）；地址不合格、下不下来、不是图片都抛错，页面照旧显示「[图片：说明]」。 */
  read(siteId: RelayRouteSiteId, value: unknown): Promise<string>
}

interface CachedImage {
  dataUrl: string
  size: number
  expiresAt: number
}

export function createAnnouncementImageReader(options: AnnouncementImageReaderOptions): AnnouncementImageReader {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? announcementImageTimeoutMs
  // Map 的先后就是最近用过的先后：命中时挪到最后，超了从最前面删。
  const cache = new Map<string, CachedImage>()
  let cachedBytes = 0
  const inFlight = new Map<string, Promise<string>>()
  const waiting: Array<() => void> = []
  let active = 0

  function forget(key: string): void {
    const entry = cache.get(key)
    if (!entry) return
    cache.delete(key)
    cachedBytes -= entry.size
  }

  function remember(key: string, dataUrl: string): void {
    forget(key)
    const size = dataUrl.length
    if (size > cacheMaxBytes) return
    cache.set(key, { dataUrl, size, expiresAt: now() + cacheTtlMs })
    cachedBytes += size
    for (const oldest of cache.keys()) {
      if (cachedBytes <= cacheMaxBytes) break
      forget(oldest)
    }
  }

  function cached(key: string): string | null {
    const entry = cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now()) {
      forget(key)
      return null
    }
    cache.delete(key)
    cache.set(key, entry)
    return entry.dataUrl
  }

  async function acquire(): Promise<void> {
    if (active < maximumConcurrentDownloads) {
      active += 1
      return
    }
    if (waiting.length >= maximumQueuedDownloads) throw new Error('公告图片同时要下的太多，稍后再看')
    // 轮到的那一个由 release 直接把名额交过来，active 不变。
    await new Promise<void>((resolve) => waiting.push(resolve))
  }

  function release(): void {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }

  async function download(url: URL): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await options.fetch(url.href, {
        method: 'GET',
        headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' },
        credentials: 'omit',
        // 跳转一律不跟（下面拒掉）：官网的图不跳转，跟了就可能被带去别的主机。
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await discardBody(response)
        throw new Error('公告图片地址被重定向，已拒绝')
      }
      if (response.url && !sameOrigin(response.url, url.origin)) {
        await discardBody(response)
        throw new Error('公告图片被重定向到不受信任的地址，已拒绝')
      }
      if (!response.ok) {
        await discardBody(response)
        throw new Error(`公告图片下载失败，服务返回 HTTP ${response.status}`)
      }
      const bytes = await readBoundedResponseBytes(response, announcementImageMaxBytes, '公告图片', {
        guard: { signal: controller.signal },
        requireNonEmpty: { missingBodyMessage: '公告图片下载失败，服务没有返回内容', emptyMessage: '公告图片下载失败，服务返回了空内容' },
      })
      const image = inspectAnnouncementImage(bytes)
      if (!image) throw new Error('公告图片不是能显示的 PNG、JPEG、GIF 或 WebP，或者尺寸太大')
      return `data:${image.mimeType};base64,${bytes.toString('base64')}`
    } catch (error) {
      if (controller.signal.aborted) throw new Error('公告图片下载超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function read(siteId: RelayRouteSiteId, value: unknown): Promise<string> {
    const url = resolveAnnouncementImageUrl(siteId, value)
    const key = `${siteId}\n${url.href}`
    const hit = cached(key)
    if (hit) return hit
    const pending = inFlight.get(key)
    if (pending) return pending
    const started = (async () => {
      await acquire()
      try {
        const dataUrl = await download(url)
        remember(key, dataUrl)
        return dataUrl
      } finally {
        release()
      }
    })()
    inFlight.set(key, started)
    try {
      return await started
    } finally {
      inFlight.delete(key)
    }
  }

  return { read }
}
