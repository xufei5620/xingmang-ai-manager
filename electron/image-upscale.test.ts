import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildImageUpscaleTiles,
  buildTileInput,
  encodePng,
  imageHasTransparency,
  imageUpscaleMaxInputPixels,
  imageUpscaleTilePad,
  imageUpscaleTileSize,
  inspectImageUpscalePlan,
  isImageUpscaleScale,
  rgbaFromPremultipliedBgra,
  upscaleImagePixels,
  type DecodedImage,
  type ImageUpscaleInference,
  type UpscaledImage,
} from './image-upscale'
import { isOrtModuleLike, type OrtModuleLike } from './image-upscale-worker'
import { resolveImageUpscaleModelPath, resolveImageUpscaleOrtDirectory } from './image-upscale-service'

const projectRoot = path.resolve(__dirname, '..')

/** Decodes the 8-bit RGB / RGBA PNGs encodePng writes, independently of it. */
function decodePng(png: Buffer): UpscaledImage {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let offset = 8
  let width = 0
  let height = 0
  let channels: 3 | 4 = 3
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    expect(png.readUInt32BE(offset + 8 + length)).toBe(zlib.crc32(png.subarray(offset + 4, offset + 8 + length)))
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      expect(body[8]).toBe(8)
      channels = body[9] === 6 ? 4 : 3
    }
    if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    for (let index = 0; index < stride; index += 1) {
      const value = raw[row * (stride + 1) + 1 + index]
      const left = index >= channels ? pixels[row * stride + index - channels] : 0
      const up = row > 0 ? pixels[(row - 1) * stride + index] : 0
      const upLeft = row > 0 && index >= channels ? pixels[(row - 1) * stride + index - channels] : 0
      const estimate = left + up - upLeft
      const paeth = Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
        ? left
        : Math.abs(estimate - up) <= Math.abs(estimate - upLeft) ? up : upLeft
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]
      pixels[row * stride + index] = (value + predicted) & 0xff
    }
  }
  return { width, height, channels, pixels }
}

function syntheticImage(width: number, height: number, alpha?: (x: number, y: number) => number): DecodedImage {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      rgba[index] = (x * 7 + y * 3) & 0xff
      rgba[index + 1] = ((x * 13) ^ (y * 5)) & 0xff
      rgba[index + 2] = Math.round(127 + 120 * Math.sin(x / 9) * Math.cos(y / 7))
      rgba[index + 3] = alpha ? alpha(x, y) : 255
    }
  }
  return { width, height, rgba }
}

/** Stands in for the model: nearest-neighbour 4x of the tile it is given. */
const nearestNeighbour: ImageUpscaleInference = async (input, width, height) => {
  const plane = width * height
  const outWidth = width * 4
  const outHeight = height * 4
  const output = new Float32Array(outWidth * outHeight * 3)
  for (let channel = 0; channel < 3; channel += 1) {
    for (let y = 0; y < outHeight; y += 1) {
      for (let x = 0; x < outWidth; x += 1) {
        output[channel * outWidth * outHeight + y * outWidth + x] = input[channel * plane + Math.floor(y / 4) * width + Math.floor(x / 4)]
      }
    }
  }
  return output
}

describe('image upscale engine', () => {
  it('accepts only 2x and 4x', () => {
    expect([2, 4].map(isImageUpscaleScale)).toEqual([true, true])
    expect([1, 3, 8, '2', null, 2.5].map(isImageUpscaleScale)).toEqual([false, false, false, false, false, false])
  })

  it('plans within the input and output limits and says which one a refusal hit', () => {
    expect(inspectImageUpscalePlan(1024, 1024, 4)).toEqual({ plan: { width: 1024, height: 1024, scale: 4, outputWidth: 4096, outputHeight: 4096 } })
    expect(inspectImageUpscalePlan(2048, 1152, 2)).toEqual({ plan: { width: 2048, height: 1152, scale: 2, outputWidth: 4096, outputHeight: 2304 } })
    // Fits the input limit but 4x would be 8192×4608 pixels.
    expect(inspectImageUpscalePlan(2048, 1152, 4)).toEqual({ refusal: 'output-too-large' })
    // A long strip: few pixels, but a 4x edge past 8192.
    expect(inspectImageUpscalePlan(2100, 100, 4)).toEqual({ refusal: 'output-too-large' })
    expect(inspectImageUpscalePlan(2100, 100, 2)).toHaveProperty('plan')
    expect(inspectImageUpscalePlan(2049, 1152, 2)).toEqual({ refusal: 'input-too-large' })
    expect(inspectImageUpscalePlan(0, 10, 2)).toEqual({ refusal: 'empty' })
    expect(inspectImageUpscalePlan(10.5, 10, 2)).toEqual({ refusal: 'empty' })
  })

  it('tiles cover every pixel exactly once and carry the padding inside the picture', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 700 }), fc.integer({ min: 1, max: 700 }), (width, height) => {
      const covered = new Uint8Array(width * height)
      for (const tile of buildImageUpscaleTiles(width, height)) {
        expect(tile.width).toBeLessThanOrEqual(imageUpscaleTileSize)
        expect(tile.padX).toBe(Math.max(0, tile.x - imageUpscaleTilePad))
        expect(tile.padX + tile.padWidth).toBe(Math.min(width, tile.x + tile.width + imageUpscaleTilePad))
        expect(tile.padY + tile.padHeight).toBeLessThanOrEqual(height)
        for (let y = tile.y; y < tile.y + tile.height; y += 1) {
          for (let x = tile.x; x < tile.x + tile.width; x += 1) covered[y * width + x] += 1
        }
      }
      expect(covered.every((count) => count === 1)).toBe(true)
    }), { numRuns: 60 })
    expect(() => buildImageUpscaleTiles(10, 10, 0)).toThrow('图片分块参数无效')
  })

  it('turns premultiplied BGRA from nativeImage into straight RGBA', () => {
    const bitmap = new Uint8Array([
      30, 20, 10, 255, // opaque: only the channel order changes
      15, 10, 5, 128, // half transparent: colours divided back by alpha
      9, 9, 9, 0, // fully transparent: colour is unknowable
    ])
    expect([...rgbaFromPremultipliedBgra(bitmap, 3, 1)]).toEqual([10, 20, 30, 255, 10, 20, 30, 128, 0, 0, 0, 0])
    expect(() => rgbaFromPremultipliedBgra(bitmap, 2, 1)).toThrow('图片像素数据长度与尺寸不符')
    expect(imageHasTransparency(new Uint8Array([1, 2, 3, 255]))).toBe(false)
    expect(imageHasTransparency(new Uint8Array([1, 2, 3, 255, 1, 2, 3, 254]))).toBe(true)
  })

  it('feeds a tile to the model as planar RGB between 0 and 1', () => {
    const image = syntheticImage(5, 4)
    const [tile] = buildImageUpscaleTiles(5, 4, 2, 1).filter((candidate) => candidate.x === 2 && candidate.y === 2)
    const input = buildTileInput(image, tile)
    expect(input.length).toBe(tile.padWidth * tile.padHeight * 3)
    const plane = tile.padWidth * tile.padHeight
    const at = (x: number, y: number) => (y * image.width + x) * 4
    expect(input[0]).toBeCloseTo(image.rgba[at(tile.padX, tile.padY)] / 255)
    expect(input[plane + 1]).toBeCloseTo(image.rgba[at(tile.padX + 1, tile.padY) + 1] / 255)
    expect(input[2 * plane + tile.padWidth]).toBeCloseTo(image.rgba[at(tile.padX, tile.padY + 1) + 2] / 255)
  })

  it('assembles 4x and 2x from tiles, reporting progress after each one', async () => {
    const image = syntheticImage(300, 270)
    const progress: string[] = []
    const four = await upscaleImagePixels(image, 4, nearestNeighbour, (done, total) => progress.push(`${done}/${total}`))
    expect(progress).toEqual(['1/4', '2/4', '3/4', '4/4'])
    expect([four.width, four.height, four.channels]).toEqual([1200, 1080, 3])
    const two = await upscaleImagePixels(image, 2, nearestNeighbour)
    expect([two.width, two.height]).toEqual([600, 540])
    // With a nearest-neighbour model every output pixel is its source pixel,
    // so any seam or offset between tiles shows up as a mismatch.
    for (const [result, scale] of [[four, 4], [two, 2]] as const) {
      for (let y = 0; y < result.height; y += 1) {
        for (let x = 0; x < result.width; x += 1) {
          const source = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4
          const target = (y * result.width + x) * 3
          if (result.pixels[target] !== image.rgba[source] || result.pixels[target + 2] !== image.rgba[source + 2]) {
            throw new Error(`pixel ${x},${y} at ${scale}x does not come from its source`)
          }
        }
      }
    }
  })

  it('keeps transparency, scaled separately from the colour the model sees', async () => {
    const image = syntheticImage(40, 30, (x) => (x < 20 ? 0 : 255))
    const result = await upscaleImagePixels(image, 2, nearestNeighbour)
    expect(result.channels).toBe(4)
    expect(result.pixels[3]).toBe(0)
    expect(result.pixels[(10 * 80 + 79) * 4 + 3]).toBe(255)
    // Between the halves the edge is interpolated, not stair-stepped.
    const edge = [...Array(6).keys()].map((offset) => result.pixels[(10 * 80 + 37 + offset) * 4 + 3])
    expect(edge.some((value) => value > 0 && value < 255)).toBe(true)
  })

  it('refuses what the plan refuses and a model that answers with the wrong size', async () => {
    await expect(upscaleImagePixels({ width: 4096, height: 1024, rgba: new Uint8Array(4096 * 1024 * 4) }, 2, nearestNeighbour)).rejects.toThrow('图片尺寸超出放大范围')
    expect(imageUpscaleMaxInputPixels).toBe(2048 * 1152)
    await expect(upscaleImagePixels(syntheticImage(8, 8), 4, async () => new Float32Array(10))).rejects.toThrow('模型输出尺寸与输入不符')
    await expect(upscaleImagePixels({ width: 8, height: 8, rgba: new Uint8Array(7) }, 4, nearestNeighbour)).rejects.toThrow('图片像素数据长度与尺寸不符')
  })

  it('writes PNGs that decode back to the same pixels, with or without alpha', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 24 }),
      fc.integer({ min: 1, max: 24 }),
      fc.constantFrom<3 | 4>(3, 4),
      fc.integer(),
      (width, height, channels, seed) => {
        const pixels = new Uint8Array(width * height * channels)
        let state = seed >>> 0
        for (let index = 0; index < pixels.length; index += 1) {
          state = (Math.imul(state, 1103515245) + 12345) >>> 0
          // Mix flat runs and noise so every filter gets picked somewhere.
          pixels[index] = index % 11 < 5 ? 200 : state >>> 24
        }
        const decoded = decodePng(encodePng({ width, height, channels, pixels }))
        expect([decoded.width, decoded.height, decoded.channels]).toEqual([width, height, channels])
        expect(Buffer.from(decoded.pixels).equals(Buffer.from(pixels))).toBe(true)
      },
    ), { numRuns: 80 })
    expect(() => encodePng({ width: 2, height: 2, channels: 3, pixels: new Uint8Array(5) })).toThrow('图片像素数据长度与尺寸不符')
  })
})

describe('image upscale engine with the bundled model', () => {
  function loadOrt(): OrtModuleLike {
    const loaded: unknown = createRequire(__filename)(resolveImageUpscaleOrtDirectory(projectRoot, false))
    if (!isOrtModuleLike(loaded)) throw new Error('onnxruntime-web did not load')
    return loaded
  }

  it('gives the same picture tiled as the model gives in one piece', async () => {
    const ort = loadOrt()
    ort.env.wasm.numThreads = 1
    const session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(resolveImageUpscaleModelPath(projectRoot))), { executionProviders: ['wasm'] })
    const infer: ImageUpscaleInference = async (input, width, height) => {
      const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) })
      const data = result[session.outputNames[0]].data
      if (!(data instanceof Float32Array)) throw new Error('model output is not float32')
      return data
    }
    try {
      // Wider than one tile, so the seam at x = 256 is inside the picture.
      const image = syntheticImage(300, 24)
      const tiled = await upscaleImagePixels(image, 4, infer)
      const reference = await infer(buildTileInput(image, { x: 0, y: 0, width: 300, height: 24, padX: 0, padY: 0, padWidth: 300, padHeight: 24 }), 300, 24)
      let worst = 0
      for (let y = 0; y < tiled.height; y += 1) {
        for (let x = 0; x < tiled.width; x += 1) {
          for (let channel = 0; channel < 3; channel += 1) {
            const value = reference[channel * tiled.width * tiled.height + y * tiled.width + x]
            const expected = value > 0 ? (value >= 1 ? 255 : Math.round(value * 255)) : 0
            worst = Math.max(worst, Math.abs(tiled.pixels[(y * tiled.width + x) * 3 + channel] - expected))
          }
        }
      }
      expect(worst).toBeLessThanOrEqual(2)
      // The model adds detail rather than copying pixels: a nearest-neighbour
      // copy of the source would differ from it here.
      const nearest = await upscaleImagePixels(image, 4, nearestNeighbour)
      expect(Buffer.from(tiled.pixels).equals(Buffer.from(nearest.pixels))).toBe(false)
    } finally {
      await session.release?.()
    }
  }, 60_000)
})
