// Exact model IDs verified against official model modality pages on 2026-10-15.
// This confirms the model protocol, not an arbitrary relay's implementation.
const supportedModels = new Set(['gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol'])

export const textImageInputProtocolRevision = 1
export const textImageInputLimits = Object.freeze({
  images: 4,
  bytesPerImage: 4 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pixelsPerImage: 16_777_216,
  totalPixels: 33_554_432,
  dimension: 8192,
})

export function textImageInputModelSupported(model: string): boolean {
  return supportedModels.has(model)
}

export function validateTextImageInputConfiguration(model: string, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > textImageInputLimits.images) throw new Error('文字视觉输入最多支持 4 张图片，请减少图片或改用单图输出')
  if (count && !textImageInputModelSupported(model)) throw new Error('当前模型尚未确认支持图片理解，请选择已支持的视觉文字模型或移除图片；不会忽略图片后继续生成')
}
