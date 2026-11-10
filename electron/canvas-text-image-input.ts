import { inspectAiImage } from './ai-asset-store'
import type { AiOwnedAssetRead } from './ai-asset-store'

// 画布完善第 6 条：文字生成节点可以连图片，让模型看图写描述。规矩跟内核
// runtime/text-image-input.ts 同一套（canvas-text-image-input.test.ts 对拍）：
// 只认内核确认过能看图的型号，最多 4 张，一张 4 MB、合计 8 MB，像素和边长也有
// 上限。画布那边已经按这套拦过，主进程在发请求之前再核一遍，因为画布说了不算。

// Exact model IDs the kernel verified against the official model modality
// pages. The chat page accepts a wider set (supportsChatImageInput); the
// canvas offers images only on these, so the desktop refuses the rest rather
// than run a node the canvas would have greyed out.
const supportedModels = new Set(['gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol'])

export const canvasTextImageInputLimits = Object.freeze({
  images: 4,
  bytesPerImage: 4 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pixelsPerImage: 16_777_216,
  totalPixels: 33_554_432,
  dimension: 8192,
})

export function canvasTextImageInputModelSupported(model: string): boolean {
  return supportedModels.has(model)
}

/** The kernel's validateTextImageInputConfiguration, word for word. */
export function assertCanvasTextImageInput(model: string, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > canvasTextImageInputLimits.images) throw new Error('文字视觉输入最多支持 4 张图片，请减少图片或改用单图输出')
  if (count && !canvasTextImageInputModelSupported(model)) throw new Error('当前模型尚未确认支持图片理解，请选择已支持的视觉文字模型或移除图片；不会忽略图片后继续生成')
}

export type CanvasTextImageReader = (userId: number, assetId: string, projectId?: string) => Promise<AiOwnedAssetRead>

/**
 * Reads the node's images from the account's own canvas store and turns them
 * into the data URIs a chat request carries. Every limit is checked on the
 * bytes actually read, before the request goes out, so an oversized picture
 * costs nothing. The kernel keeps each slot, so the same picture in two slots
 * is sent twice and counts twice towards the totals; it is read once.
 */
export async function readCanvasTextImages(
  read: CanvasTextImageReader,
  userId: number,
  assetIds: readonly string[],
  projectId?: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  if (assetIds.length > canvasTextImageInputLimits.images) throw new Error('文字视觉输入最多支持 4 张图片，请减少图片或改用单图输出')
  const images = new Map<string, { uri: string; bytes: number; pixels: number }>()
  let totalBytes = 0
  let totalPixels = 0
  for (const assetId of assetIds) {
    if (signal?.aborted) throw signal.reason
    let image = images.get(assetId)
    if (!image) {
      let owned: AiOwnedAssetRead
      try {
        owned = await read(userId, assetId, projectId)
      } catch {
        throw new Error('连接的视觉图片没有可读取结果，当前没有提交文字生成')
      }
      if (owned.bytes.byteLength > canvasTextImageInputLimits.bytesPerImage) throw new Error('视觉图片单张不能超过 4 MB，当前没有提交文字生成；请换小一点的图再试')
      const inspected = inspectAiImage(owned.bytes)
      const width = inspected.width ?? 0
      const height = inspected.height ?? 0
      if (!width || !height || width > canvasTextImageInputLimits.dimension || height > canvasTextImageInputLimits.dimension || width * height > canvasTextImageInputLimits.pixelsPerImage) {
        throw new Error('视觉图片尺寸超过范围，当前没有提交文字生成；请换小一点的图再试')
      }
      image = { uri: `data:${inspected.mimeType};base64,${owned.bytes.toString('base64')}`, bytes: owned.bytes.byteLength, pixels: width * height }
      images.set(assetId, image)
    }
    totalBytes += image.bytes
    totalPixels += image.pixels
    if (totalBytes > canvasTextImageInputLimits.totalBytes) throw new Error('文字视觉图片总容量不能超过 8 MB，当前没有提交生成请求')
    if (totalPixels > canvasTextImageInputLimits.totalPixels) throw new Error('视觉图片尺寸超过范围，当前没有提交文字生成；请换小一点的图再试')
  }
  return new Map([...images].map(([assetId, image]) => [assetId, image.uri]))
}
