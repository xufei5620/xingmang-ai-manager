import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  imageEditMaskModelSupported,
  parseImageEditMask,
  rasterizeImageEditMask,
} from '../canvas-v2/src/image-tools/image-edit-mask'
import {
  assertCanvasImageEditMaskInput,
  buildCanvasImageMaskPng,
  canvasImageEditMaskModelSupported,
  maximumCanvasImageMaskPngBytes,
  parseCanvasImageEditMask,
  rasterizeCanvasImageEditMask,
} from './canvas-image-mask'
import type { CanvasImageEditMask, CanvasImageEditMaskStroke } from './canvas-run-contract'

const sourceAssetId = 'a'.repeat(43)

function mask(width: number, height: number, strokes: CanvasImageEditMaskStroke[]): CanvasImageEditMask {
  return { version: 1, sourceAssetId, width, height, strokes }
}

// Deterministic, so a failing case can be replayed from its index.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function randomMask(seed: number): CanvasImageEditMask {
  const random = seededRandom(seed)
  const width = 1 + Math.floor(random() * 700)
  const height = 1 + Math.floor(random() * 700)
  const strokes = Array.from({ length: 1 + Math.floor(random() * 12) }, (): CanvasImageEditMaskStroke => ({
    tool: random() < 0.75 ? 'brush' : 'erase',
    size: Math.max(0.001, random() * (random() < 0.3 ? 0.02 : 0.3)),
    points: Array.from({ length: 1 + Math.floor(random() * 20) }, () => ({ x: random(), y: random() })),
  }))
  return mask(width, height, strokes)
}

interface DecodedPng { width: number; height: number; bitDepth: number; colourType: number; rows: Buffer[] }

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function decodePng(png: Buffer): DecodedPng {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let offset = 8
  let header: Buffer | null = null
  const data: Buffer[] = []
  const types: string[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    expect(png.readUInt32BE(offset + 8 + length), type).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)))
    types.push(type)
    if (type === 'IHDR') header = body
    if (type === 'IDAT') data.push(body)
    offset += length + 12
  }
  expect(types[0]).toBe('IHDR')
  expect(types.at(-1)).toBe('IEND')
  if (!header) throw new Error('missing IHDR')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const raw = inflateSync(Buffer.concat(data))
  const rowBytes = 1 + width * 4
  expect(raw.length).toBe(rowBytes * height)
  const rows = Array.from({ length: height }, (_, y) => raw.subarray(y * rowBytes, (y + 1) * rowBytes))
  return { width, height, bitDepth: header[8], colourType: header[9], rows }
}

describe('canvas image edit mask', () => {
  it('draws exactly the pixels the kernel shades in the editor', () => {
    const fixed: CanvasImageEditMask[] = [
      mask(1, 1, [{ tool: 'brush', size: 1, points: [{ x: 0.5, y: 0.5 }] }]),
      mask(64, 48, [{ tool: 'brush', size: 0.1, points: [{ x: 0.5, y: 0.5 }] }]),
      mask(640, 480, [
        { tool: 'brush', size: 0.2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { tool: 'erase', size: 0.05, points: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }] },
      ]),
      // Horizontal and vertical segments hit the flat-edge branches.
      mask(333, 77, [{ tool: 'brush', size: 0.3, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, { x: 0.9, y: 0.1 }] }]),
      mask(4096, 256, [{ tool: 'brush', size: 0.01, points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }]),
    ]
    const cases = [...fixed, ...Array.from({ length: 60 }, (_, index) => randomMask(index + 1))]
    for (const [index, entry] of cases.entries()) {
      const desktop = rasterizeCanvasImageEditMask(entry)
      const kernel = rasterizeImageEditMask(entry)
      expect(desktop.editedPixels, `case ${index}`).toBe(kernel.editedPixels)
      expect(Buffer.from(desktop.bits).equals(Buffer.from(kernel.bits)), `case ${index}`).toBe(true)
    }
  })

  it('accepts and refuses what the kernel accepts and refuses, with the same words', () => {
    const stroke = { tool: 'brush', size: 0.1, points: [{ x: 0.5, y: 0.5 }] }
    const base = { version: 1, width: 64, height: 48, strokes: [stroke] }
    const inputs: unknown[] = [
      base,
      { ...base, sourceAssetId },
      null, 'mask', [], { ...base, extra: true }, { ...base, version: 2 }, { ...base, width: 1.5 }, { ...base, width: 4097 },
      { ...base, width: 4096, height: 4097 }, { ...base, sourceAssetId: 'short' }, { ...base, strokes: {} },
      { ...base, strokes: Array.from({ length: 129 }, () => stroke) },
      { ...base, strokes: [{ ...stroke, tool: 'fill' }] }, { ...base, strokes: [{ ...stroke, points: [] }] },
      { ...base, strokes: [{ ...stroke, size: 0 }] }, { ...base, strokes: [{ ...stroke, size: Number.NaN }] },
      { ...base, strokes: [{ ...stroke, points: [{ x: -0.1, y: 0 }] }] }, { ...base, strokes: [{ ...stroke, points: [{ x: 0, y: 0, z: 0 }] }] },
      { ...base, strokes: Array.from({ length: 5 }, () => ({ ...stroke, points: Array.from({ length: 1000 }, () => ({ x: 0, y: 0 })) })) },
      { ...base, strokes: Array.from({ length: 4 }, () => ({ ...stroke, points: Array.from({ length: 1024 }, () => ({ x: 0.123456789012345, y: 0.987654321098765 })) })) },
    ]
    for (const [index, input] of inputs.entries()) {
      let kernel: unknown
      let kernelError = ''
      try { kernel = parseImageEditMask(input) } catch (error) { kernelError = (error as Error).message }
      let desktop: unknown
      let desktopError = ''
      try { desktop = parseCanvasImageEditMask(input) } catch (error) { desktopError = (error as Error).message }
      expect(desktopError, `input ${index}`).toBe(kernelError)
      expect(desktop, `input ${index}`).toEqual(kernel)
    }
  })

  it('allows masks on the GPT Image models the kernel offers them for', () => {
    for (const model of ['gpt-image-1', 'gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-flare', 'gpt-image-1.5', 'jimeng_high_aes_general_v21_L', 'gemini-3.1-flash-image', '']) {
      expect(canvasImageEditMaskModelSupported(model), model).toBe(imageEditMaskModelSupported(model))
    }
  })

  it('refuses a mask that no longer fits its one source before anything is sent', () => {
    const entry = mask(64, 48, [{ tool: 'brush', size: 0.1, points: [{ x: 0.5, y: 0.5 }] }])
    const source = { assetId: sourceAssetId, width: 64, height: 48 }
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2', [source])).not.toThrow()
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2', [{ assetId: sourceAssetId }])).not.toThrow()
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2.5-flare', [source])).toThrow('当前模型尚未接通蒙版局部修改')
    expect(() => assertCanvasImageEditMaskInput({ ...entry, sourceAssetId: undefined }, 'gpt-image-2', [source])).toThrow('请打开蒙版编辑器，核对并绑定当前原图后再运行')
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2', [])).toThrow('局部修改需要唯一且与蒙版绑定一致的原图')
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2', [source, source])).toThrow('局部修改需要唯一且与蒙版绑定一致的原图')
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2', [{ ...source, assetId: 'b'.repeat(43) }])).toThrow('局部修改需要唯一且与蒙版绑定一致的原图')
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2', [{ ...source, width: 65 }])).toThrow('原图像素尺寸与蒙版不一致')
    expect(() => assertCanvasImageEditMaskInput(entry, 'gpt-image-2', [{ ...source, height: 47 }])).toThrow('原图像素尺寸与蒙版不一致')
    expect(() => assertCanvasImageEditMaskInput({ ...entry, strokes: [{ ...entry.strokes[0], tool: 'erase' }] }, 'gpt-image-2', [source])).toThrow('空蒙版不能生成')
  })

  it('makes an RGBA PNG at the mask size that is transparent exactly where the user painted', async () => {
    const entry = mask(301, 97, [
      { tool: 'brush', size: 0.4, points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] },
      { tool: 'erase', size: 0.1, points: [{ x: 0.5, y: 0.5 }] },
    ])
    const raster = rasterizeImageEditMask(entry)
    const png = await buildCanvasImageMaskPng(entry)
    const decoded = decodePng(png)
    expect(decoded).toMatchObject({ width: 301, height: 97, bitDepth: 8, colourType: 6 })
    let transparent = 0
    for (let y = 0; y < decoded.height; y += 1) {
      const row = decoded.rows[y]
      expect(row[0]).toBe(0)
      for (let x = 0; x < decoded.width; x += 1) {
        const index = y * decoded.width + x
        const painted = Boolean(raster.bits[index >> 3] & (1 << (index & 7)))
        const pixel = row.subarray(1 + x * 4, 5 + x * 4)
        expect([...pixel], `${x},${y}`).toEqual(painted ? [0, 0, 0, 0] : [0, 0, 0, 255])
        if (painted) transparent += 1
      }
    }
    expect(transparent).toBe(raster.editedPixels)
    expect(transparent).toBeGreaterThan(0)
  })

  it('keeps a 4096 x 4096 mask well under the 4 MB the edits endpoint accepts', async () => {
    const entry = mask(4096, 4096, Array.from({ length: 128 }, (_, index): CanvasImageEditMaskStroke => ({
      tool: index % 5 === 4 ? 'erase' : 'brush',
      size: 0.002 + (index % 7) * 0.01,
      // Short hops scattered over the image: many edges, within the kernel's scan budget.
      points: Array.from({ length: 16 }, (_, point) => ({ x: ((index * 37) % 90 + point * 0.6) / 100, y: ((index * 53) % 90 + (point % 3) * 0.7) / 100 })),
    })))
    const png = await buildCanvasImageMaskPng(entry)
    expect(png.length).toBeLessThan(maximumCanvasImageMaskPngBytes)
    const decoded = decodePng(png)
    expect(decoded).toMatchObject({ width: 4096, height: 4096 })
  })

  it('refuses an empty mask and stops when the run is stopped', async () => {
    await expect(buildCanvasImageMaskPng(mask(64, 48, [{ tool: 'erase', size: 0.5, points: [{ x: 0.5, y: 0.5 }] }]))).rejects.toThrow('空蒙版不能生成')
    const controller = new AbortController()
    controller.abort(new Error('运行已取消'))
    await expect(buildCanvasImageMaskPng(mask(64, 48, [{ tool: 'brush', size: 0.5, points: [{ x: 0.5, y: 0.5 }] }]), controller.signal)).rejects.toThrow('运行已取消')
  })
})
