import { describe, expect, it } from 'vitest'
import { decodeGeneratedImage, generatedImageInfo, generatedText, GenerationProtocolError, imageRequestParameters, imageResults, textRequestParameters } from './generation-protocol'
import { buildImageRequestParameters } from '../runtime/image-request-parameters'
import fixtures from './fixtures/generated-image-headers.json'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII='

function updateChunkCrc(bytes: Uint8Array, offset: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = offset + 8 + view.getUint32(offset)
  if (offset < 8 || end + 4 > bytes.length) throw new Error('Invalid fixture chunk bounds')
  let crc = 0xffffffff
  for (let index = offset + 4; index < end; index++) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  view.setUint32(end, (crc ^ 0xffffffff) >>> 0)
}

function pngChunkOffset(bytes: Uint8Array, type: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 8; offset + 12 <= bytes.length; offset += view.getUint32(offset) + 12) {
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === type) return offset
  }
  throw new Error(`Missing fixture chunk ${type}`)
}

function jpegContainerOfSize(byteLength: number): Uint8Array {
  const original = decodeGeneratedImage(fixtures.baseline)
  const bytes = new Uint8Array(byteLength)
  const view = new DataView(bytes.buffer)
  bytes.set(original.subarray(0, 2))
  let offset = 2
  let remaining = byteLength - original.length
  if (remaining < 4) throw new Error('Invalid JPEG fixture padding')
  // APP15 segments carry opaque application metadata; the original compressed
  // image and end marker remain intact. This tests container/header validation,
  // without claiming that generatedImageInfo decodes pixel data.
  while (remaining) {
    let segmentBytes = Math.min(65_537, remaining)
    const tail = remaining - segmentBytes
    if (tail > 0 && tail < 4) segmentBytes -= 4 - tail
    bytes.set([255, 239], offset)
    view.setUint16(offset + 2, segmentBytes - 2)
    offset += segmentBytes
    remaining -= segmentBytes
  }
  bytes.set(original.subarray(2), offset)
  return bytes
}

describe('generation protocol boundaries', () => {
  it.each(['gpt-4.1-mini', 'relay/GPT-4O-MINI', 'grok-imagine-video', 'proxy/MINIMAX-H3-FAST'])('rejects a known non-image model %s before building a provider image request', (model) => {
    expect(() => imageRequestParameters({ model, prompt: '保留原图', size: '1536x1024', imageResolution: '1K' })).toThrow('不能用于图像生成')
    expect(() => imageRequestParameters({ model, prompt: '保留原图', size: '1536x1024', imageResolution: '1K' })).toThrow(GenerationProtocolError)
  })

  it.each(['custom-paint-model', 'provider/house-style'])('preserves the exact unknown image relay %s in the wire body', (model) => {
    expect(imageRequestParameters({ model, prompt: '保留原图', size: '1536x1024', imageResolution: '1K' })).toEqual({ model, prompt: '保留原图', size: '1536x1024', n: 1 })
  })

  it('builds one explicit image request without provider credentials', () => {
    expect(imageRequestParameters({ model: 'custom-image', prompt: '  一段说明 ', size: '1024x1024', quality: 'low' })).toEqual({ model: 'custom-image', prompt: '一段说明', n: 1, size: '1024x1024', quality: 'low' })
    expect(() => imageRequestParameters({ model: 'x', prompt: 'p', size: '99999x99999' })).toThrow('尺寸')
    expect(() => imageRequestParameters({ model: 'x', prompt: 'p', quality: 'unsupported' })).toThrow('质量')
  })
  it('uses the same effective dimensions for shared preflight and JSON or multipart wire bodies', () => {
    const input = { model: 'gpt-image-2', prompt: '保留主体', size: '1280x720', quality: 'low', imageResolution: '4K' as const }
    const body = imageRequestParameters(input)
    expect(body).toEqual(buildImageRequestParameters(input))
    expect(JSON.parse(JSON.stringify(body))).toMatchObject({ size: '3840x2160', n: 1 })
    const form = new FormData()
    for (const [key, value] of Object.entries(body)) form.append(key, String(value))
    expect(Object.fromEntries(form)).toEqual({ model: 'gpt-image-2', prompt: '保留主体', size: '3840x2160', quality: 'low', n: '1' })
    expect(form.has('imageResolution')).toBe(false)
  })
  it('preserves controlled protocol errors for unsupported resolutions before any model call', () => {
    expect(() => imageRequestParameters({ model: 'custom-image', prompt: 'p', imageResolution: '2K' })).toThrow(GenerationProtocolError)
    expect(() => imageRequestParameters({ model: 'gpt-image-1', prompt: 'p', imageResolution: '4K' })).toThrow('尚未接入')
    expect(imageRequestParameters({ model: 'gpt-image-1', prompt: 'p', size: 'auto', imageResolution: '1K' })).toEqual({ model: 'gpt-image-1', prompt: 'p', size: 'auto', n: 1 })
  })
  it('uses an explicit bounded non-streaming chat completion', () => {
    expect(textRequestParameters({ model: 'custom-text', prompt: 'user', system: 'system' })).toEqual({ model: 'custom-text', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }], stream: false, max_completion_tokens: 8192 })
  })
  it('reads actual text and refuses missing or oversized results', () => {
    expect(generatedText({ choices: [{ message: { content: 'a' } }] })).toBe('a')
    expect(generatedText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'image', text: 'ignored' }, { type: 'text', text: 'b' }] } }] })).toBe('a\nb')
    expect(() => generatedText({ choices: [{ message: { content: '' } }] })).toThrow('为空')
    expect(() => generatedText({ choices: [{ message: { content: 'a'.repeat(32_001) } }] })).toThrow('超过容量')
  })
  it('refuses known image and video models in chat requests while retaining unknown text aliases', () => {
    for (const model of ['gpt-image-1', 'relay/GPT-IMAGE-2', 'gpt-image-1.5', 'grok-imagine-video', 'proxy/minimax-h3-base', 'gemini-3.1-flash-image', 'grok-imagine-image-2.0']) {
      expect(() => textRequestParameters({ model, prompt: '正文' })).toThrow('不能用于文字生成')
    }
    for (const model of ['gpt-4o-mini', 'custom-text', 'provider/custom-chat', 'image-reasoning-chat']) {
      expect(textRequestParameters({ model, prompt: '正文' }).model).toBe(model)
    }
  })
  it('prefers inline image data and never manufactures a result URL', () => {
    expect(imageResults({ data: [{ b64_json: png, url: 'https://example.com/image.png' }] })).toEqual([{ base64: png }])
    expect(() => imageResults({ data: [{}] })).toThrow('缺少')
    expect(() => imageResults({ data: Array.from({ length: 5 }, () => ({ b64_json: png })) })).toThrow('兼容性')
  })
  it('validates bytes independently of a declared response MIME', () => {
    expect(generatedImageInfo(decodeGeneratedImage(png))).toEqual({ mimeType: 'image/png', extension: 'png', width: 1, height: 1 })
    expect(() => decodeGeneratedImage('<svg>')).toThrow('无效')
    expect(() => generatedImageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toThrow('不是支持')
    expect(() => generatedImageInfo(Uint8Array.of(137, 80, 78, 71))).toThrow('不是支持')
  })
  it('reads actual dimensions from baseline and progressive JPEG files', () => {
    for (const value of [fixtures.baseline, fixtures.progressive]) expect(generatedImageInfo(decodeGeneratedImage(value))).toEqual({ mimeType: 'image/jpeg', extension: 'jpg', width: 7, height: 5 })
  })
  it('reads lossy, lossless, extended and animated WebP dimensions', () => {
    for (const value of [fixtures.lossy, fixtures.lossless, fixtures.extended, fixtures.animated]) expect(generatedImageInfo(decodeGeneratedImage(value))).toEqual({ mimeType: 'image/webp', extension: 'webp', width: 7, height: 5 })
  })
  it('keeps palette and bounded animated PNG files supported', () => {
    for (const value of [fixtures.palette, fixtures.apng]) expect(generatedImageInfo(decodeGeneratedImage(value))).toEqual({ mimeType: 'image/png', extension: 'png', width: 7, height: 5 })
  })
  it('honors a typed array offset instead of inspecting unrelated backing bytes', () => {
    const bytes = decodeGeneratedImage(fixtures.lossless)
    const padded = new Uint8Array(bytes.length + 17)
    padded.set(bytes, 9)
    expect(generatedImageInfo(padded.subarray(9, 9 + bytes.length))).toMatchObject({ width: 7, height: 5 })
  })
  it('keeps the default image capacity at 20 MiB', () => {
    expect(generatedImageInfo(jpegContainerOfSize(20 * 1024 * 1024))).toEqual({ mimeType: 'image/jpeg', extension: 'jpg', width: 7, height: 5 })
    expect(() => generatedImageInfo(jpegContainerOfSize(21 * 1024 * 1024))).toThrow('超过允许容量')
  })
  it('reads complete 21 to 32 MiB image containers only with an explicit larger capacity', () => {
    for (const size of [21, 32]) {
      const bytes = jpegContainerOfSize(size * 1024 * 1024)
      expect(bytes.byteLength).toBe(size * 1024 * 1024)
      expect(generatedImageInfo(bytes, 32 * 1024 * 1024)).toEqual({ mimeType: 'image/jpeg', extension: 'jpg', width: 7, height: 5 })
    }
  })
  it('rejects 33 MiB and refuses a truncated view used to bypass the capacity', () => {
    const bytes = jpegContainerOfSize(33 * 1024 * 1024)
    expect(() => generatedImageInfo(bytes, 32 * 1024 * 1024)).toThrow('超过允许容量')
    expect(() => generatedImageInfo(bytes.subarray(0, 32 * 1024 * 1024), 32 * 1024 * 1024)).toThrow('结构')
  })
  it('rejects invalid capacity overrides instead of disabling byte limits', () => {
    const bytes = decodeGeneratedImage(png)
    for (const maximumBytes of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => generatedImageInfo(bytes, maximumBytes)).toThrow('容量限制无效')
  })
  it('rejects magic-only, truncated and trailing-data containers', () => {
    for (const value of [png, fixtures.baseline, fixtures.progressive, fixtures.lossy, fixtures.lossless, fixtures.animated]) {
      const bytes = decodeGeneratedImage(value)
      expect(() => generatedImageInfo(bytes.slice(0, bytes.length - 2))).toThrow('结构')
      const trailing = new Uint8Array(bytes.length + 1)
      trailing.set(bytes)
      expect(() => generatedImageInfo(trailing)).toThrow('结构')
    }
    expect(() => generatedImageInfo(Uint8Array.of(255, 216, 255, 224, 0, 6, 0, 0, 0, 0, 255, 217))).toThrow('结构')
    expect(() => generatedImageInfo(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80))).toThrow('结构')
  })
  it('rejects damaged PNG headers and IDAT data without an end chunk', () => {
    const bytes = decodeGeneratedImage(png)
    const damaged = bytes.slice()
    damaged[16] ^= 1
    expect(() => generatedImageInfo(damaged)).toThrow()
    expect(() => generatedImageInfo(bytes.slice(0, 33))).toThrow('结构')
    const chunkLength = bytes.slice()
    new DataView(chunkLength.buffer).setUint32(33, 0xffffffff)
    expect(() => generatedImageInfo(chunkLength)).toThrow('结构')
  })
  it('rejects corrupted PNG image data with a mismatched chunk checksum', () => {
    const bytes = decodeGeneratedImage(png)
    bytes[45] ^= 1
    expect(() => generatedImageInfo(bytes)).toThrow('结构')
  })
  it('rejects oversized JPEG dimensions before examining compressed pixels', () => {
    const bytes = decodeGeneratedImage(fixtures.baseline)
    const marker = bytes.findIndex((value, index) => value === 255 && bytes[index + 1] === 192)
    expect(marker).toBeGreaterThan(0)
    const view = new DataView(bytes.buffer)
    view.setUint16(marker + 5, 8192)
    view.setUint16(marker + 7, 8192)
    expect(() => generatedImageInfo(bytes)).toThrow('尺寸')
  })
  it('rejects mismatched WebP canvas and bitstream dimensions', () => {
    const bytes = decodeGeneratedImage(fixtures.extended)
    expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe('VP8X')
    bytes[24] = 9
    expect(() => generatedImageInfo(bytes)).toThrow('结构')
  })
  it('rejects WebP chunk overrun and reserved lossless format versions', () => {
    const bytes = decodeGeneratedImage(fixtures.lossless)
    const length = bytes.slice()
    new DataView(length.buffer).setUint32(16, 0xffffffff, true)
    expect(() => generatedImageInfo(length)).toThrow('结构')
    bytes[24] |= 32
    expect(() => generatedImageInfo(bytes)).toThrow('结构')
  })
  it('bounds advertised animation work before reading all frames', () => {
    const bytes = decodeGeneratedImage(fixtures.apng)
    const offset = pngChunkOffset(bytes, 'acTL')
    new DataView(bytes.buffer).setUint32(offset + 8, 257)
    updateChunkCrc(bytes, offset)
    expect(() => generatedImageInfo(bytes)).toThrow('动画')
  })
  it('checks actual APNG frames against the declaration and canvas bounds', () => {
    for (const [type, field, value] of [['acTL', 0, 1], ['fcTL', 4, 16_385], ['fcTL', 12, 7], ['fdAT', 0, 10]] as const) {
      const bytes = decodeGeneratedImage(fixtures.apng)
      const offset = pngChunkOffset(bytes, type)
      new DataView(bytes.buffer).setUint32(offset + 8 + field, value)
      updateChunkCrc(bytes, offset)
      expect(() => generatedImageInfo(bytes)).toThrow()
    }
  })
})
