import { describe, expect, it } from 'vitest'
import {
  assertCanvasUploadedImage, CanvasByteUploadAdmission, canvasByteUploadLimits, maximumCanvasUploadedImageBytes, parseCanvasUploadedImageBytes,
} from './canvas-byte-upload'

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header[24] = 8
  header[25] = 6
  return Buffer.concat([header, Buffer.alloc(16)])
}

describe('canvas byte upload', () => {
  it('takes exactly one non-empty Uint8Array within the size limit and copies it', () => {
    const view = new Uint8Array(png(64, 32))
    const parsed = parseCanvasUploadedImageBytes(view)
    expect(Buffer.isBuffer(parsed)).toBe(true)
    expect(parsed.equals(Buffer.from(view))).toBe(true)
    view[0] = 0
    expect(parsed[0]).toBe(0x89)
    for (const wrong of ['C:\\Users\\a\\mask.png', '/tmp/mask.png', { bytes: view }, [1, 2, 3], view.buffer, null, undefined]) {
      expect(() => parseCanvasUploadedImageBytes(wrong), String(wrong)).toThrow('画布图片内容格式错误')
    }
    expect(() => parseCanvasUploadedImageBytes(new Uint8Array(0))).toThrow('画布图片内容为空')
    expect(() => parseCanvasUploadedImageBytes(new Uint8Array(maximumCanvasUploadedImageBytes + 1))).toThrow('画布图片超过 20 MB')
  })

  it('accepts only PNG, JPEG or WebP read from the header, with both sides at most 8192', () => {
    expect(assertCanvasUploadedImage(png(4096, 4096))).toEqual({ mimeType: 'image/png', width: 4096, height: 4096 })
    expect(assertCanvasUploadedImage(png(8192, 1))).toMatchObject({ width: 8192, height: 1 })
    expect(() => assertCanvasUploadedImage(png(8193, 10))).toThrow('画布图片边长超过 8192')
    expect(() => assertCanvasUploadedImage(png(10, 8193))).toThrow('画布图片边长超过 8192')
    expect(() => assertCanvasUploadedImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow('仅支持 PNG、JPEG 或 WebP')
    expect(() => assertCanvasUploadedImage(Buffer.from('GIF89a0000000000'))).toThrow('仅支持 PNG、JPEG 或 WebP')
  })

  it('limits each window to a few saves at a time and a rolling count and byte budget', async () => {
    let now = 1_000
    const guard = new CanvasByteUploadAdmission({ maxActive: 1, maxUploadsPerWindow: 3, maxBytesPerWindow: 100, windowMs: 1_000, now: () => now })
    let release = () => {}
    const pending = guard.run(7, 10, () => new Promise<string>((resolve) => { release = () => resolve('first') }))
    await expect(guard.run(7, 10, async () => 'second')).rejects.toThrow('上一张图片还在保存')
    await expect(guard.run(8, 10, async () => 'other window')).resolves.toBe('other window')
    release()
    await expect(pending).resolves.toBe('first')
    await expect(guard.run(7, 91, async () => 'over bytes')).rejects.toThrow('保存图片太频繁')
    await expect(guard.run(7, 10, async () => { throw new Error('store failed') })).rejects.toThrow('store failed')
    await expect(guard.run(7, 10, async () => 'third')).resolves.toBe('third')
    await expect(guard.run(7, 10, async () => 'fourth')).rejects.toThrow('保存图片太频繁')
    now += 1_000
    await expect(guard.run(7, 90, async () => 'next minute')).resolves.toBe('next minute')
    guard.releaseOwner(7)
    await expect(guard.run(7, 100, async () => 'closed and reopened')).resolves.toBe('closed and reopened')
  })

  it('defaults to two at a time, 20 saves and 100 MB a minute per window', async () => {
    expect(canvasByteUploadLimits).toEqual({ maxActive: 2, maxUploadsPerWindow: 20, maxBytesPerWindow: 100 * 1024 * 1024, windowMs: 60_000 })
    const guard = new CanvasByteUploadAdmission({ now: () => 5 })
    for (let index = 0; index < 20; index += 1) await guard.run(7, 1, async () => index)
    await expect(guard.run(7, 1, async () => 'twenty-first')).rejects.toThrow('保存图片太频繁')
    expect(() => new CanvasByteUploadAdmission({ maxBytesPerWindow: 0 })).toThrow('配置无效')
    await expect(guard.run(0, 1, async () => 'no window')).rejects.toThrow('画布窗口标识格式错误')
    await expect(guard.run(9, 0, async () => 'nothing')).rejects.toThrow('画布图片内容为空')
  })
})
