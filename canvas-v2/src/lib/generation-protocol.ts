import { textSearchOnlyModel } from '../runtime/text-web-search'
import { buildImageRequestParameters, ImageRequestParameterError, type ImageRequestParametersInput } from '../runtime/image-request-parameters'
import { knownNonImageModel, knownNonTextModel } from '../models'
import { textImageInputLimits, validateTextImageInputConfiguration } from '../runtime/text-image-input'

export const maximumGeneratedImageBytes = 20 * 1024 * 1024
export const maximumGeneratedTextCharacters = 32_000

export class GenerationProtocolError extends Error {}

function nonempty(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new GenerationProtocolError(`${label}不能为空，且不能超过 ${maximum} 个字符`)
  return value.trim()
}

export interface ImageGenerationParameters extends ImageRequestParametersInput {}

export function imageRequestParameters(input: ImageGenerationParameters): Record<string, string | number> {
  try {
    const parameters = buildImageRequestParameters(input)
    // Membership in a mixed provider catalog does not establish image support.
    // Keep unknown relay aliases, but reject known incompatible model families.
    if (typeof parameters.model === 'string' && knownNonImageModel(parameters.model)) throw new GenerationProtocolError('所选模型是已知文字或视频模型，不能用于图像生成；请选择图像模型')
    return parameters
  }
  catch (error) {
    if (error instanceof ImageRequestParameterError) throw new GenerationProtocolError(error.message)
    throw error
  }
}

export function textRequestParameters(input: { model: string; prompt: string; system?: string; imageInputs?: readonly Uint8Array[] }): Record<string, unknown> {
  const model = nonempty(input.model, '模型名称', 200)
  if (textSearchOnlyModel(model)) throw new GenerationProtocolError('此搜索专用模型不支持当前文字生成协议，请选择支持 Responses 联网搜索的模型')
  if (knownNonTextModel(model)) throw new GenerationProtocolError('所选模型是已知图片或视频模型，不能用于文字生成；请选择文字模型')
  const images = textImageDataUrls(model, input.imageInputs)
  const messages: Array<{ role: 'system' | 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }> }> = []
  if (input.system) messages.push({ role: 'system', content: nonempty(input.system, '系统指令', 16_000) })
  const prompt = nonempty(input.prompt, '文字提示词', 32_000)
  messages.push({ role: 'user', content: images.length ? [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url, detail: 'auto' as const } }))] : prompt })
  return { model, messages, stream: false, max_completion_tokens: 8192 }
}

/** Only server-owned bytes become data URLs. Never accept caller URLs or MIME. */
export function textImageDataUrls(model: string, images: readonly Uint8Array[] = []): string[] {
  if (!Array.isArray(images)) throw new GenerationProtocolError('文字视觉图片输入格式不正确')
  try { validateTextImageInputConfiguration(model, images.length) }
  catch (error) { throw new GenerationProtocolError(error instanceof Error ? error.message : '文字视觉图片配置不正确') }
  let totalBytes = 0, totalPixels = 0
  const inspected = images.map((bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new GenerationProtocolError('文字视觉输入只能使用已读取的本账户图片')
    totalBytes += bytes.byteLength
    if (totalBytes > textImageInputLimits.totalBytes) throw new GenerationProtocolError('文字视觉图片总容量不能超过 8 MB')
    const info = generatedImageInfo(bytes, textImageInputLimits.bytesPerImage)
    const pixels = info.width * info.height
    totalPixels += pixels
    if (info.width > textImageInputLimits.dimension || info.height > textImageInputLimits.dimension || pixels > textImageInputLimits.pixelsPerImage || totalPixels > textImageInputLimits.totalPixels) throw new GenerationProtocolError('文字视觉图片像素超过范围：单图最多 1600 万、合计最多 3200 万像素，单边不能超过 8192')
    // Containers were validated above; inspect chunk boundaries, not arbitrary
    // compressed bytes that might coincidentally contain an animation marker.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (info.mimeType === 'image/png') for (let offset = 8; offset < bytes.length; offset += 12 + view.getUint32(offset)) {
      if (fourcc(bytes, offset + 4) === 'acTL') throw new GenerationProtocolError('文字视觉输入暂只支持静态图片，请先提取一帧')
    }
    if (info.mimeType === 'image/webp' && fourcc(bytes, 12) === 'VP8X' && (bytes[20] & 2)) throw new GenerationProtocolError('文字视觉输入暂只支持静态图片，请先提取一帧')
    return { bytes, mimeType: info.mimeType }
  })
  return inspected.map(({ bytes, mimeType }) => {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    return `data:${mimeType};base64,${btoa(binary)}`
  })
}

export function generatedText(response: unknown): string {
  if (!response || typeof response !== 'object' || !('choices' in response) || !Array.isArray(response.choices)) throw new GenerationProtocolError('模型没有返回可读取的文字结果，请检查服务的接口兼容性')
  const choice = response.choices[0]
  const value = choice?.message?.content
  const content = typeof value === 'string' ? value : Array.isArray(value) ? value.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : null
  if (typeof content !== 'string' || !content.trim()) throw new GenerationProtocolError('模型返回的文字为空，请查看任务记录后再决定是否重新运行')
  if (content.length > maximumGeneratedTextCharacters) throw new GenerationProtocolError('模型文字结果超过容量，已停止读取；请核对上游用量后再调整任务')
  return content
}

export function imageResults(response: unknown): Array<{ base64?: string; url?: string; revisedPrompt?: string }> {
  if (!response || typeof response !== 'object' || !('data' in response) || !Array.isArray(response.data) || !response.data.length || response.data.length > 4) throw new GenerationProtocolError('模型没有返回可读取的图片结果，请检查服务的图像接口兼容性')
  return response.data.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new GenerationProtocolError('模型返回的图片格式不正确')
    const base64 = typeof entry.b64_json === 'string' && entry.b64_json ? entry.b64_json : undefined
    const url = typeof entry.url === 'string' && entry.url ? entry.url : undefined
    if (!base64 && !url) throw new GenerationProtocolError('模型返回的图片缺少文件内容')
    return { ...(base64 ? { base64 } : { url }), ...(typeof entry.revised_prompt === 'string' ? { revisedPrompt: entry.revised_prompt.slice(0, 32_000) } : {}) }
  })
}

export function decodeGeneratedImage(value: string): Uint8Array {
  if (value.length > Math.ceil(maximumGeneratedImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new GenerationProtocolError('模型图片内容无效或超过 20 MB')
  let decoded: string
  try { decoded = atob(value) } catch { throw new GenerationProtocolError('模型返回的图片编码无法读取') }
  if (!decoded.length || decoded.length > maximumGeneratedImageBytes) throw new GenerationProtocolError('模型图片内容无效或超过 20 MB')
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

interface ImageDimensions { width: number; height: number }

function imageDimensions(width: number, height: number): ImageDimensions {
  if (!width || !height || width > 16_384 || height > 16_384 || width * height > 32_000_000) throw new GenerationProtocolError('模型返回的图片尺寸超过范围')
  return { width, height }
}

function invalidImage(format: string): never {
  throw new GenerationProtocolError(`模型返回的 ${format} 图片结构不完整或无效，请检查服务返回文件`)
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function createPngCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
    table[index] = value >>> 0
  }
  return table
}

const pngCrcTable = createPngCrcTable()

function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index++) crc = (crc >>> 8) ^ pngCrcTable[(crc ^ bytes[index]) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

function animationBudget(dimensions: ImageDimensions, frames: number): void {
  if (!frames || frames > 256 || dimensions.width * dimensions.height * frames > 64_000_000) throw new GenerationProtocolError('模型返回的动画图片超过容量，请使用静态图片或减少帧数')
}

function pngDimensions(bytes: Uint8Array, view: DataView): ImageDimensions {
  if (bytes.length < 33 || view.getUint32(8) !== 13 || fourcc(bytes, 12) !== 'IHDR') invalidImage('PNG')
  const dimensions = imageDimensions(view.getUint32(16), view.getUint32(20))
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] || bytes[27] || bytes[28] > 1) invalidImage('PNG')
  // Container CRCs detect damaged bytes; this does not decode compressed pixels.
  if (pngCrc(bytes, 12, 29) !== view.getUint32(29)) invalidImage('PNG')
  let offset = 33
  let imageData = 0
  let dataSeen = false
  let dataEnded = false
  let palette = false
  let animationSeen = false
  let declaredFrames = 0
  let frames = 0
  let sequence = 0
  let frameUsesIdat = false
  let frameData = 0
  let chunks = 0
  while (offset < bytes.length) {
    if (++chunks > 10_000 || offset + 12 > bytes.length) invalidImage('PNG')
    const length = view.getUint32(offset)
    const type = fourcc(bytes, offset + 4)
    const end = offset + 12 + length
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type) || type === 'IHDR') invalidImage('PNG')
    if (pngCrc(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) invalidImage('PNG')
    if (type === 'IEND') {
      if (length || end !== bytes.length || !imageData || (bytes[25] === 3 && !palette) || view.getUint32(offset + 8) !== 0xae426082) invalidImage('PNG')
      if (animationSeen && (frames !== declaredFrames || !frameData)) invalidImage('PNG')
      return dimensions
    }
    if (type === 'IDAT') {
      if (dataEnded) invalidImage('PNG')
      dataSeen = true
      imageData += length
      if (frameUsesIdat) frameData += length
    } else {
      if (dataSeen) dataEnded = true
      if (type === 'PLTE') {
        if (palette || dataSeen || !length || length > 768 || length % 3 || bytes[25] === 0 || bytes[25] === 4) invalidImage('PNG')
        palette = true
      } else if (type === 'acTL') {
        if (length !== 8 || dataSeen || animationSeen) invalidImage('PNG')
        declaredFrames = view.getUint32(offset + 8)
        animationBudget(dimensions, declaredFrames)
        animationSeen = true
      } else if (type === 'fcTL') {
        if (!animationSeen || length !== 26 || view.getUint32(offset + 8) !== sequence++ || (frames && !frameData) || (!dataSeen && frames)) invalidImage('PNG')
        const frame = imageDimensions(view.getUint32(offset + 12), view.getUint32(offset + 16))
        const x = view.getUint32(offset + 20)
        const y = view.getUint32(offset + 24)
        if (x + frame.width > dimensions.width || y + frame.height > dimensions.height || bytes[offset + 32] > 2 || bytes[offset + 33] > 1) invalidImage('PNG')
        if (!dataSeen && (x || y || frame.width !== dimensions.width || frame.height !== dimensions.height)) invalidImage('PNG')
        animationBudget(dimensions, ++frames)
        if (frames > declaredFrames) invalidImage('PNG')
        frameUsesIdat = !dataSeen
        frameData = 0
      } else if (type === 'fdAT') {
        if (!animationSeen || !dataSeen || !frames || frameUsesIdat || length < 4 || view.getUint32(offset + 8) !== sequence++) invalidImage('PNG')
        frameData += length - 4
      } else if (type[0] === type[0].toUpperCase()) invalidImage('PNG')
    }
    offset = end
  }
  return invalidImage('PNG')
}

function jpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions {
  let offset = 2
  let width = 0
  let height = 0
  let frameSeen = false
  let scanSeen = false
  let entropySeen = false
  let components: number[] = []
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) invalidImage('JPEG')
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === 217) {
      if (offset !== bytes.length || !scanSeen || !entropySeen) invalidImage('JPEG')
      return imageDimensions(width, height)
    }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) invalidImage('JPEG')
    if (marker === 1) continue
    if (offset + 2 > bytes.length) invalidImage('JPEG')
    const length = view.getUint16(offset)
    const end = offset + length
    if (length < 2 || end > bytes.length) invalidImage('JPEG')
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (frameSeen || length < 8 || length !== 8 + 3 * bytes[offset + 7]) invalidImage('JPEG')
      const precision = bytes[offset + 2]
      const lossless = [195, 199, 203, 207].includes(marker)
      if (!bytes[offset + 7] || (marker === 192 ? precision !== 8 : lossless ? precision < 2 || precision > 16 : precision !== 8 && precision !== 12)) invalidImage('JPEG')
      height = view.getUint16(offset + 3)
      width = view.getUint16(offset + 5)
      imageDimensions(width, height || 1)
      components = []
      for (let index = offset + 8; index < end; index += 3) {
        const component = bytes[index]
        const horizontal = bytes[index + 1] >>> 4
        const vertical = bytes[index + 1] & 15
        if (components.includes(component) || !horizontal || horizontal > 4 || !vertical || vertical > 4) invalidImage('JPEG')
        components.push(component)
      }
      frameSeen = true
    } else if (marker === 220) {
      if (!frameSeen || height || length !== 4) invalidImage('JPEG')
      height = view.getUint16(offset + 2)
      imageDimensions(width, height)
    } else if (marker === 218) {
      if (!frameSeen || length < 8 || length !== 6 + 2 * bytes[offset + 2] || bytes[offset + 2] > 4) invalidImage('JPEG')
      const selected = new Set<number>()
      for (let index = offset + 3; index < end - 3; index += 2) {
        if (!components.includes(bytes[index]) || selected.has(bytes[index])) invalidImage('JPEG')
        selected.add(bytes[index])
      }
      scanSeen = true
      offset = end
      // Skip entropy bytes and stuffed/restart markers without allocating or decoding pixels.
      while (offset < bytes.length) {
        const next = bytes.indexOf(255, offset)
        if (next < 0) invalidImage('JPEG')
        if (next > offset) entropySeen = true
        let codeOffset = next + 1
        while (bytes[codeOffset] === 255) codeOffset++
        const code = bytes[codeOffset]
        if (code === 0 || (code >= 208 && code <= 215)) {
          if (code === 0) entropySeen = true
          offset = codeOffset + 1
        } else {
          offset = next
          break
        }
      }
      continue
    }
    offset = end
  }
  return invalidImage('JPEG')
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function webpFrameDimensions(bytes: Uint8Array, view: DataView, type: string, start: number, length: number): ImageDimensions {
  if (type === 'VP8L') {
    if (length < 6 || bytes[start] !== 47 || (bytes[start + 4] >>> 5)) invalidImage('WebP')
    const bits = view.getUint32(start + 1, true)
    return imageDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (length < 11 || bytes[start] & 1 || bytes[start + 3] !== 157 || bytes[start + 4] !== 1 || bytes[start + 5] !== 42) invalidImage('WebP')
  const partitionBytes = (bytes[start] | bytes[start + 1] << 8 | bytes[start + 2] << 16) >>> 5
  if (!partitionBytes || partitionBytes + 10 > length) invalidImage('WebP')
  return imageDimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff)
}

function webpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions {
  if (view.getUint32(4, true) + 8 !== bytes.length) invalidImage('WebP')
  let offset = 12
  let dimensions: ImageDimensions | undefined
  let staticFrame: ImageDimensions | undefined
  let animated = false
  let animationHeader = false
  let frames = 0
  let chunks = 0
  while (offset < bytes.length) {
    if (++chunks > 10_000 || offset + 8 > bytes.length) invalidImage('WebP')
    const type = fourcc(bytes, offset)
    const length = view.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + length
    const paddedEnd = end + (length & 1)
    if (paddedEnd > bytes.length || (length & 1 && bytes[end] !== 0)) invalidImage('WebP')
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || dimensions) invalidImage('WebP')
      dimensions = imageDimensions(uint24(bytes, start + 4) + 1, uint24(bytes, start + 7) + 1)
      animated = Boolean(bytes[start] & 2)
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (animated || staticFrame) invalidImage('WebP')
      staticFrame = webpFrameDimensions(bytes, view, type, start, length)
    } else if (type === 'ANIM' && animated) {
      if (animationHeader || frames || length !== 6) invalidImage('WebP')
      animationHeader = true
    } else if (type === 'ANMF') {
      if (!animated || !dimensions || !animationHeader || length < 24) invalidImage('WebP')
      const frame = imageDimensions(uint24(bytes, start + 6) + 1, uint24(bytes, start + 9) + 1)
      if (uint24(bytes, start) * 2 + frame.width > dimensions.width || uint24(bytes, start + 3) * 2 + frame.height > dimensions.height) invalidImage('WebP')
      let suboffset = start + 16
      let content: ImageDimensions | undefined
      while (suboffset < end) {
        if (++chunks > 10_000 || suboffset + 8 > end) invalidImage('WebP')
        const subtype = fourcc(bytes, suboffset)
        const sublength = view.getUint32(suboffset + 4, true)
        const subend = suboffset + 8 + sublength
        if (subend + (sublength & 1) > end || (sublength & 1 && bytes[subend] !== 0)) invalidImage('WebP')
        if (subtype === 'VP8 ' || subtype === 'VP8L') {
          if (content) invalidImage('WebP')
          content = webpFrameDimensions(bytes, view, subtype, suboffset + 8, sublength)
        }
        suboffset = subend + (sublength & 1)
      }
      if (!content || content.width !== frame.width || content.height !== frame.height) invalidImage('WebP')
      animationBudget(dimensions, ++frames)
    }
    offset = paddedEnd
  }
  if (animated) {
    if (!dimensions || !frames) invalidImage('WebP')
    return dimensions
  }
  if (!staticFrame || (dimensions && (dimensions.width !== staticFrame.width || dimensions.height !== staticFrame.height))) invalidImage('WebP')
  return dimensions ?? staticFrame
}

export function generatedImageInfo(bytes: Uint8Array, maximumBytes = maximumGeneratedImageBytes): { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; extension: 'png' | 'jpg' | 'webp'; width: number; height: number } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new GenerationProtocolError('图片容量限制无效')
  // Inspect the entire supplied view. Cropping an oversized file to its header
  // would bypass the byte limit and hide truncated container data.
  if (!bytes.byteLength || bytes.byteLength > maximumBytes) throw new GenerationProtocolError('模型图片内容无效或超过允许容量')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return { mimeType: 'image/png', extension: 'png', ...pngDimensions(bytes, view) }
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) return { mimeType: 'image/jpeg', extension: 'jpg', ...jpegDimensions(bytes, view) }
  if (bytes.length >= 12 && fourcc(bytes, 0) === 'RIFF' && fourcc(bytes, 8) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp', ...webpDimensions(bytes, view) }
  throw new GenerationProtocolError('模型结果不是支持的 PNG、JPEG 或 WebP 图片，请检查服务返回格式')
}
