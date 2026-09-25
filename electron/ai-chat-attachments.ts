import { AI_CHAT_LIMITS } from './ai-chat-protocol'
import { inspectAiImage, type AiOwnedAssetRead, type AiStoredAsset } from './ai-asset-store'

// 聊天里附带的图片只从两处来：系统的选文件框和剪贴板，都在主进程里拿，渲染层给不出
// 任何路径或字节（I15 同一思路：渲染层只拿到存好之后的引用）。
export const CHAT_ATTACHMENT_LIMITS = {
  // 原图读进内存前的上限。手机照片、4K 截图都在这之内。
  sourceBytes: 20 * 1024 * 1024,
  // 存下来、发出去的每一张都不超过这个数。
  storedBytes: 2 * 1024 * 1024,
  // 长边超过这个数就缩小。各家看图模型收到更大的图也会自己缩，发大了只是更慢更贵。
  maxEdge: 2048,
} as const

export interface ChatImageCodecImage {
  width: number
  height: number
  png(): Buffer
  jpeg(quality: number): Buffer
}

/** Electron's nativeImage in production; a fake in tests. Returns null for bytes it cannot decode. */
export interface ChatImageCodec {
  decode(bytes: Buffer, maxEdge: number): ChatImageCodecImage | null
}

export interface ChatAttachmentStore {
  readLocalFile(filePath: string, maximumBytes: number): Promise<Buffer>
  storeLocalBytes(userId: number, bytes: Buffer): Promise<AiStoredAsset>
  readOwned(userId: number, assetId: string): Promise<AiOwnedAssetRead>
}

export interface ChatAttachmentServiceOptions {
  store: ChatAttachmentStore
  codec: ChatImageCodec
  /** Opens the native picker and returns absolute paths, or an empty list when canceled. */
  pickFiles(): Promise<string[]>
  /** The clipboard's image as PNG bytes, or null when it holds no image. */
  readClipboardImage(): Buffer | null
}

export interface ChatAttachmentService {
  pick(userId: number, remaining: number): Promise<AiStoredAsset[]>
  paste(userId: number): Promise<AiStoredAsset | null>
  readDataUri(userId: number, assetId: string): Promise<string>
}

const tooLargeMessage = `图片太大了，压缩后还是超过 ${CHAT_ATTACHMENT_LIMITS.storedBytes / 1024 / 1024} MB，请截小一点再试`

/**
 * Keeps an image that is already small enough byte-for-byte, and otherwise
 * shrinks it: PNG first so screenshots of text stay sharp, then JPEG at
 * falling quality. Throws a message the user can act on when nothing fits.
 */
export function prepareChatImage(bytes: Buffer, codec: ChatImageCodec): Buffer {
  const { storedBytes, maxEdge } = CHAT_ATTACHMENT_LIMITS
  if (bytes.length > CHAT_ATTACHMENT_LIMITS.sourceBytes) {
    throw new Error(`图片太大了，一张不能超过 ${CHAT_ATTACHMENT_LIMITS.sourceBytes / 1024 / 1024} MB`)
  }
  let inspection: ReturnType<typeof inspectAiImage>
  try {
    inspection = inspectAiImage(bytes)
  } catch {
    throw new Error('这个文件不是能用的图片，只支持 PNG、JPG 和 WebP')
  }
  const longest = Math.max(inspection.width ?? 0, inspection.height ?? 0)
  if (bytes.length <= storedBytes && longest > 0 && longest <= maxEdge) return bytes
  const image = codec.decode(bytes, maxEdge)
  if (!image) {
    // WebP 在部分系统上解不开，只能原样用；原样又太大就只能请用户换一张。
    throw new Error(inspection.mimeType === 'image/webp'
      ? '这张图片太大了，请换成 PNG 或 JPG 格式，或者截小一点再试'
      : '这张图片打不开，请换一张再试')
  }
  const png = image.png()
  if (png.length > 0 && png.length <= storedBytes) return png
  for (const quality of [85, 70, 55]) {
    const jpeg = image.jpeg(quality)
    if (jpeg.length > 0 && jpeg.length <= storedBytes) return jpeg
  }
  throw new Error(tooLargeMessage)
}

export function createChatAttachmentService(options: ChatAttachmentServiceOptions): ChatAttachmentService {
  async function pick(userId: number, remaining: number): Promise<AiStoredAsset[]> {
    if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > AI_CHAT_LIMITS.imagesPerMessage) {
      throw new Error(`一条消息最多带 ${AI_CHAT_LIMITS.imagesPerMessage} 张图片`)
    }
    const paths = await options.pickFiles()
    if (!paths.length) return []
    if (paths.length > remaining) throw new Error(`这条消息还能加 ${remaining} 张图片，这次选了 ${paths.length} 张，请少选几张`)
    // Everything is read and checked before anything is stored, so one bad
    // file leaves no half-added batch behind.
    const prepared: Buffer[] = []
    for (const filePath of paths) {
      let bytes: Buffer
      try {
        bytes = await options.store.readLocalFile(filePath, CHAT_ATTACHMENT_LIMITS.sourceBytes)
      } catch {
        throw new Error(`有一张图片读不出来，或者超过 ${CHAT_ATTACHMENT_LIMITS.sourceBytes / 1024 / 1024} MB，请换一张再试`)
      }
      prepared.push(prepareChatImage(bytes, options.codec))
    }
    const assets: AiStoredAsset[] = []
    for (const bytes of prepared) assets.push(await options.store.storeLocalBytes(userId, bytes))
    return assets
  }

  async function paste(userId: number): Promise<AiStoredAsset | null> {
    const bytes = options.readClipboardImage()
    if (!bytes || bytes.length === 0) return null
    return options.store.storeLocalBytes(userId, prepareChatImage(bytes, options.codec))
  }

  async function readDataUri(userId: number, assetId: string): Promise<string> {
    const owned = await options.store.readOwned(userId, assetId)
    // Ids come from the renderer. Anything in the store larger than what an
    // attachment can be (a 4K generated picture) is not sent as one.
    if (owned.bytes.length > CHAT_ATTACHMENT_LIMITS.storedBytes) throw new Error('image is larger than a chat attachment')
    return `data:${owned.asset.mimeType};base64,${owned.bytes.toString('base64')}`
  }

  return { pick, paste, readDataUri }
}
