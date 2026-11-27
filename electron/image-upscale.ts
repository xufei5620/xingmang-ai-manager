import zlib from 'node:zlib'

// 「本机变清晰」（全面方案第 26 件）：在客户自己的电脑上把一张图放大 2 倍或 4 倍、补出细节，另存一张，原图不动。
// 这个文件只有纯计算：尺寸上限、分块、像素换算、拼图、存成 PNG。跑模型的那一步由调用方交进来（后台线程里是
// onnxruntime，测试里是假的），所以这里不碰 Electron、不碰线程，测试直接调用。

/** 菜单里能选的倍数。模型本身固定放大 4 倍，放大 2 倍是先放大 4 倍再每 2×2 取平均缩回一半。 */
export const imageUpscaleScales = [2, 4] as const
export type ImageUpscaleScale = (typeof imageUpscaleScales)[number]
export const imageUpscaleModelScale = 4

/**
 * 上限按「普通电脑等得起、存得下」定：
 * - 送进模型的原图不超过约 236 万像素（1536×1536、2048×1152 正好卡在线上）。耗时跟原图像素数成正比，
 *   1024×1024 在 4 核电脑上约半分钟到一分钟（WASM，本机实测推算），再大就要好几分钟。
 * - 放大后的图不超过约 1678 万像素（4096×4096）、最长边不超过 8192：再大存成 PNG 会逼近作品库单张 64 MB 的上限。
 */
export const imageUpscaleMaxInputPixels = 2048 * 1152
export const imageUpscaleMaxOutputPixels = 4096 * 4096
export const imageUpscaleMaxOutputEdge = 8192

/** 一块送进模型的边长（不含四周多带的那一圈），和多带的那一圈有多宽。 */
export const imageUpscaleTileSize = 256
// Each of the 34 convolutions widens the receptive field by one pixel, so a
// pixel near a tile edge sees up to 34 pixels past it. Measured on the bundled
// model against whole-image inference of a 520×300 photo (out of 255): a pad
// of 10, Real-ESRGAN's own default, leaves edges up to 34 levels off; 16 still
// up to 8; 24 at most 1.1, with 3 pixels in the whole picture off by more than
// one level. The far end of the receptive field contributes too little to show.
export const imageUpscaleTilePad = 24

export type ImageUpscaleRefusal = 'input-too-large' | 'output-too-large' | 'empty'

export interface ImageUpscalePlan {
  width: number
  height: number
  scale: ImageUpscaleScale
  outputWidth: number
  outputHeight: number
}

export function isImageUpscaleScale(value: unknown): value is ImageUpscaleScale {
  return value === 2 || value === 4
}

/** 这张图放大这么多倍行不行；不行的说清是哪一种，界面按它挑一句话。 */
export function inspectImageUpscalePlan(width: number, height: number, scale: ImageUpscaleScale): { plan: ImageUpscalePlan } | { refusal: ImageUpscaleRefusal } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return { refusal: 'empty' }
  if (width * height > imageUpscaleMaxInputPixels) return { refusal: 'input-too-large' }
  const outputWidth = width * scale
  const outputHeight = height * scale
  if (outputWidth * outputHeight > imageUpscaleMaxOutputPixels || Math.max(outputWidth, outputHeight) > imageUpscaleMaxOutputEdge) {
    return { refusal: 'output-too-large' }
  }
  return { plan: { width, height, scale, outputWidth, outputHeight } }
}

export interface ImageUpscaleTile {
  /** 这一块在原图里管哪一片（结果只取这一片）。 */
  x: number
  y: number
  width: number
  height: number
  /** 连同四周多带的那一圈，实际送进模型的那一片。 */
  padX: number
  padY: number
  padWidth: number
  padHeight: number
}

export function buildImageUpscaleTiles(width: number, height: number, tileSize = imageUpscaleTileSize, pad = imageUpscaleTilePad): ImageUpscaleTile[] {
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || !Number.isSafeInteger(pad) || pad < 0) throw new Error('图片分块参数无效')
  const tiles: ImageUpscaleTile[] = []
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const tileWidth = Math.min(tileSize, width - x)
      const tileHeight = Math.min(tileSize, height - y)
      const padX = Math.max(0, x - pad)
      const padY = Math.max(0, y - pad)
      const padRight = Math.min(width, x + tileWidth + pad)
      const padBottom = Math.min(height, y + tileHeight + pad)
      tiles.push({ x, y, width: tileWidth, height: tileHeight, padX, padY, padWidth: padRight - padX, padHeight: padBottom - padY })
    }
  }
  return tiles
}

export interface DecodedImage {
  width: number
  height: number
  /** 每像素 4 字节、不预乘的 R G B A。 */
  rgba: Uint8Array
}

/**
 * Electron 的 nativeImage.toBitmap() 交出来的是 Skia 的原生格式：B G R A，颜色已经乘过透明度。换成不预乘的
 * R G B A；完全透明的像素颜色无从还原，记成黑色。
 */
export function rgbaFromPremultipliedBgra(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = width * height
  if (bitmap.length !== pixels * 4) throw new Error('图片像素数据长度与尺寸不符')
  const rgba = new Uint8Array(pixels * 4)
  for (let index = 0; index < pixels * 4; index += 4) {
    const alpha = bitmap[index + 3]
    const blue = bitmap[index]
    const green = bitmap[index + 1]
    const red = bitmap[index + 2]
    if (alpha === 255) {
      rgba[index] = red
      rgba[index + 1] = green
      rgba[index + 2] = blue
    } else if (alpha > 0) {
      rgba[index] = Math.min(255, Math.round((red * 255) / alpha))
      rgba[index + 1] = Math.min(255, Math.round((green * 255) / alpha))
      rgba[index + 2] = Math.min(255, Math.round((blue * 255) / alpha))
    }
    rgba[index + 3] = alpha
  }
  return rgba
}

export function imageHasTransparency(rgba: Uint8Array): boolean {
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index] !== 255) return true
  return false
}

/** 把原图的一片换成模型要的输入：1×3×高×宽，按 R、G、B 三层排，取值 0～1。 */
export function buildTileInput(image: DecodedImage, tile: ImageUpscaleTile): Float32Array {
  const plane = tile.padWidth * tile.padHeight
  const input = new Float32Array(plane * 3)
  for (let row = 0; row < tile.padHeight; row += 1) {
    const source = ((tile.padY + row) * image.width + tile.padX) * 4
    const target = row * tile.padWidth
    for (let column = 0; column < tile.padWidth; column += 1) {
      const pixel = source + column * 4
      input[target + column] = image.rgba[pixel] / 255
      input[plane + target + column] = image.rgba[pixel + 1] / 255
      input[2 * plane + target + column] = image.rgba[pixel + 2] / 255
    }
  }
  return input
}

function toByte(value: number): number {
  if (!(value > 0)) return 0
  if (value >= 1) return 255
  return Math.round(value * 255)
}

/** 模型跑一片：交进去 1×3×高×宽，交回 1×3×(高×4)×(宽×4)，都是 0～1 的浮点。 */
export type ImageUpscaleInference = (input: Float32Array, width: number, height: number) => Promise<Float32Array>

export interface UpscaledImage {
  width: number
  height: number
  /** 3 = R G B；4 = R G B A（原图有透明的地方才带）。 */
  channels: 3 | 4
  pixels: Uint8Array
}

/**
 * 透明度不送进模型（模型只认颜色），按双线性单独放大：抠好的商品图边缘照样平滑，
 * 颜色那一半由模型补细节。
 */
function upscaleAlpha(image: DecodedImage, outputWidth: number, outputHeight: number, target: Uint8Array): void {
  const ratioX = image.width / outputWidth
  const ratioY = image.height / outputHeight
  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * ratioY - 0.5))
    const top = Math.floor(sourceY)
    const bottom = Math.min(image.height - 1, top + 1)
    const weightY = sourceY - top
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * ratioX - 0.5))
      const left = Math.floor(sourceX)
      const right = Math.min(image.width - 1, left + 1)
      const weightX = sourceX - left
      const topLeft = image.rgba[(top * image.width + left) * 4 + 3]
      const topRight = image.rgba[(top * image.width + right) * 4 + 3]
      const bottomLeft = image.rgba[(bottom * image.width + left) * 4 + 3]
      const bottomRight = image.rgba[(bottom * image.width + right) * 4 + 3]
      const upper = topLeft + (topRight - topLeft) * weightX
      const lower = bottomLeft + (bottomRight - bottomLeft) * weightX
      target[(y * outputWidth + x) * 4 + 3] = Math.round(upper + (lower - upper) * weightY)
    }
  }
}

/**
 * 整张图分块跑完、拼好。每块只取中间管的那一片，四周多带的那一圈只给边上的像素当参考，块和块之间看不出接缝。
 * 放大 2 倍时每块的 4 倍结果当场每 2×2 取平均写进去，任何时候都不在内存里放整张 4 倍的图。
 */
export async function upscaleImagePixels(
  image: DecodedImage,
  scale: ImageUpscaleScale,
  infer: ImageUpscaleInference,
  onProgress?: (done: number, total: number) => void,
): Promise<UpscaledImage> {
  const inspected = inspectImageUpscalePlan(image.width, image.height, scale)
  if ('refusal' in inspected) throw new Error('图片尺寸超出放大范围')
  if (image.rgba.length !== image.width * image.height * 4) throw new Error('图片像素数据长度与尺寸不符')
  const { outputWidth, outputHeight } = inspected.plan
  const channels: 3 | 4 = imageHasTransparency(image.rgba) ? 4 : 3
  const pixels = new Uint8Array(outputWidth * outputHeight * channels)
  const tiles = buildImageUpscaleTiles(image.width, image.height)
  const model = imageUpscaleModelScale
  const shrink = model / scale
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index]
    const output = await infer(buildTileInput(image, tile), tile.padWidth, tile.padHeight)
    const outWidth = tile.padWidth * model
    const outHeight = tile.padHeight * model
    if (output.length !== outWidth * outHeight * 3) throw new Error('模型输出尺寸与输入不符')
    const plane = outWidth * outHeight
    const offsetX = (tile.x - tile.padX) * model
    const offsetY = (tile.y - tile.padY) * model
    const regionWidth = (tile.width * model) / shrink
    const regionHeight = (tile.height * model) / shrink
    const targetX = tile.x * scale
    const targetY = tile.y * scale
    for (let row = 0; row < regionHeight; row += 1) {
      for (let column = 0; column < regionWidth; column += 1) {
        const target = ((targetY + row) * outputWidth + targetX + column) * channels
        for (let channel = 0; channel < 3; channel += 1) {
          let sum = 0
          for (let dy = 0; dy < shrink; dy += 1) {
            const sourceRow = (offsetY + row * shrink + dy) * outWidth + offsetX + column * shrink
            for (let dx = 0; dx < shrink; dx += 1) sum += output[channel * plane + sourceRow + dx]
          }
          pixels[target + channel] = toByte(sum / (shrink * shrink))
        }
      }
    }
    onProgress?.(index + 1, tiles.length)
  }
  if (channels === 4) upscaleAlpha(image, outputWidth, outputHeight, pixels)
  return { width: outputWidth, height: outputHeight, channels, pixels }
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

const crcTable = buildCrcTable()

function crc32(chunks: readonly Uint8Array[]): number {
  let crc = 0xffffffff
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) crc = crcTable[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32([head.subarray(4), data]), 0)
  return Buffer.concat([head, data, tail])
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/**
 * Filters one scanline with each of the five PNG filters and keeps the one
 * whose output has the smallest sum of absolute (signed) bytes, the heuristic
 * libpng uses. Photos compress noticeably better than with a single filter.
 * A filter stops early once it can no longer win, so the winner's scratch line
 * is always complete: only a filter that ran to the end can become the best.
 */
function filterRow(pixels: Uint8Array, row: number, stride: number, bytesPerPixel: number, target: Uint8Array, targetOffset: number, scratch: Uint8Array[]): void {
  const start = row * stride
  const previous = row > 0 ? start - stride : -1
  let best = 0
  let bestScore = Infinity
  for (let filter = 0; filter < 5; filter += 1) {
    const line = scratch[filter]
    let score = 0
    let complete = true
    for (let index = 0; index < stride; index += 1) {
      const value = pixels[start + index]
      const left = index >= bytesPerPixel ? pixels[start + index - bytesPerPixel] : 0
      const up = previous >= 0 ? pixels[previous + index] : 0
      const upLeft = previous >= 0 && index >= bytesPerPixel ? pixels[previous + index - bytesPerPixel] : 0
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
      const filtered = (value - predicted) & 0xff
      line[index] = filtered
      score += filtered < 128 ? filtered : 256 - filtered
      if (score >= bestScore) {
        complete = false
        break
      }
    }
    if (complete && score < bestScore) {
      bestScore = score
      best = filter
    }
  }
  target[targetOffset] = best
  target.set(scratch[best], targetOffset + 1)
}

/** 存成 8 位 PNG（RGB 或 RGBA）。压缩用 Node 自带的 zlib，不另带编码库。 */
export function encodePng(image: UpscaledImage): Buffer {
  const { width, height, channels, pixels } = image
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('图片尺寸无效')
  const stride = width * channels
  if (pixels.length !== stride * height) throw new Error('图片像素数据长度与尺寸不符')
  const raw = new Uint8Array((stride + 1) * height)
  const scratch = Array.from({ length: 5 }, () => new Uint8Array(stride))
  for (let row = 0; row < height; row += 1) filterRow(pixels, row, stride, channels, raw, row * (stride + 1), scratch)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}
