import { inspectAiImage } from './ai-asset-store'

// 画布完善第 7 条第一步（#1397）：画布在页面里画好的图片（蒙版编辑器的黑白蒙版）交回主进程存成素材。
// 拖进来的文件走 canvas-host:import-asset-file，由 preload 取磁盘路径；页面自己画的图没有路径，
// 走 canvas-host:import-asset-bytes，只交字节。这条通道不收、也不回任何路径（I15 不许第二个由画布给路径的通道）。

/**
 * One picture. The mask editor itself stops at 4 MB and 4096 per side. The
 * byte limit is the kernel's image-transform limit and the side limit is the
 * one text nodes already accept, so the annotation and image-tool outputs that
 * come later (#1397 steps two and three) fit without widening this channel.
 */
export const maximumCanvasUploadedImageBytes = 20 * 1024 * 1024
export const maximumCanvasUploadedImageEdge = 8192

/**
 * A poisoned canvas can call the byte channel as often as it likes, so each
 * canvas window gets a rolling budget: what it can do with it is fill the
 * current project's library with well-formed junk the user can delete, at
 * most this fast. Failed uploads count too, so retrying a refused one does not
 * buy extra attempts.
 */
export const canvasByteUploadLimits = {
  maxActive: 2,
  maxUploadsPerWindow: 20,
  maxBytesPerWindow: 100 * 1024 * 1024,
  windowMs: 60_000,
} as const

/**
 * The byte channel takes exactly one Uint8Array and nothing else: no name, no
 * type, no path. The copy keeps the stored bytes apart from the IPC buffer.
 */
export function parseCanvasUploadedImageBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) throw new Error('画布图片内容格式错误')
  if (value.byteLength === 0) throw new Error('画布图片内容为空，没有保存')
  if (value.byteLength > maximumCanvasUploadedImageBytes) throw new Error('画布图片超过 20 MB，没有保存')
  return Buffer.from(value)
}

/**
 * Only PNG, JPEG and WebP, recognised from the file header like every other
 * picture the asset store takes; the declared type of the page's File is not
 * consulted. The side limit stops a header that claims a huge canvas.
 */
export function assertCanvasUploadedImage(bytes: Buffer): { mimeType: string; width: number; height: number } {
  const inspection = inspectAiImage(bytes)
  const { width, height } = inspection
  if (!width || !height) throw new Error('画布图片尺寸读不出来，没有保存')
  if (width > maximumCanvasUploadedImageEdge || height > maximumCanvasUploadedImageEdge) throw new Error('画布图片边长超过 8192，没有保存')
  return { mimeType: inspection.mimeType, width, height }
}

export interface CanvasByteUploadAdmissionOptions {
  maxActive?: number
  maxUploadsPerWindow?: number
  maxBytesPerWindow?: number
  windowMs?: number
  now?: () => number
}

/** Per canvas window, like CanvasGenerationAdmission, but it also counts bytes. */
export class CanvasByteUploadAdmission {
  private readonly maxActive: number
  private readonly maxUploadsPerWindow: number
  private readonly maxBytesPerWindow: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly active = new Map<number, number>()
  private readonly uploads = new Map<number, Array<{ at: number; bytes: number }>>()

  constructor(options: CanvasByteUploadAdmissionOptions = {}) {
    this.maxActive = options.maxActive ?? canvasByteUploadLimits.maxActive
    this.maxUploadsPerWindow = options.maxUploadsPerWindow ?? canvasByteUploadLimits.maxUploadsPerWindow
    this.maxBytesPerWindow = options.maxBytesPerWindow ?? canvasByteUploadLimits.maxBytesPerWindow
    this.windowMs = options.windowMs ?? canvasByteUploadLimits.windowMs
    this.now = options.now ?? Date.now
    if (![this.maxActive, this.maxUploadsPerWindow, this.maxBytesPerWindow, this.windowMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('画布图片保存频率限制配置无效')
    }
  }

  async run<T>(ownerId: number, byteLength: number, operation: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('画布窗口标识格式错误')
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new Error('画布图片内容为空，没有保存')
    if ((this.active.get(ownerId) ?? 0) >= this.maxActive) throw new Error('上一张图片还在保存，请等它存好再试')
    const now = this.now()
    const recent = (this.uploads.get(ownerId) ?? []).filter((entry) => now - entry.at < this.windowMs)
    const recentBytes = recent.reduce((total, entry) => total + entry.bytes, 0)
    if (recent.length >= this.maxUploadsPerWindow || recentBytes + byteLength > this.maxBytesPerWindow) {
      this.uploads.set(ownerId, recent)
      throw new Error('保存图片太频繁，请过一分钟再试')
    }
    recent.push({ at: now, bytes: byteLength })
    this.uploads.set(ownerId, recent)
    this.active.set(ownerId, (this.active.get(ownerId) ?? 0) + 1)
    try {
      return await operation()
    } finally {
      const remaining = (this.active.get(ownerId) ?? 1) - 1
      if (remaining > 0) this.active.set(ownerId, remaining)
      else this.active.delete(ownerId)
    }
  }

  releaseOwner(ownerId: number): void {
    this.active.delete(ownerId)
    this.uploads.delete(ownerId)
  }
}
