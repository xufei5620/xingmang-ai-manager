import { describe, expect, it, vi } from 'vitest'
import { assertLayerPsdBudget, writeLayerPsd, type LayerPsdInput, type LayerPsdMetadata } from './layer-psd-writer'

function pixels(values: number[], width = 3, height = 1) { return { width, height, data: new Uint8ClampedArray(values) } }
function fixture() {
  const layers: LayerPsdMetadata[] = [
    { name: '底层 ☕', visible: true, opacity: 1, blend: 'source-over' },
    { name: '上层 🖊', visible: false, opacity: 0.5, blend: 'multiply' },
  ]
  const frames = [pixels([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]), pixels([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120])]
  const readLayer = vi.fn(async (index: number) => frames[index]), readComposite = vi.fn(async () => frames[0])
  return { input: { width: 3, height: 1, layers, readLayer, readComposite }, frames, readLayer, readComposite }
}

/** A minimal test reader follows declared lengths, rather than encoder offsets. */
function inspect(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = new TextDecoder('ascii')
  let cursor = 26
  for (let index = 0; index < 2; index++) { const length = view.getUint32(cursor); cursor += 4 + length }
  const sectionEnd = cursor + 4 + view.getUint32(cursor); cursor += 4
  const infoEnd = cursor + 4 + view.getUint32(cursor); cursor += 4
  const count = view.getInt16(cursor); cursor += 2
  const layers: Array<{ name: string; opacity: number; flags: number; blend: string; channels: Array<{ id: number; length: number; bytes?: number[] }> }> = []
  for (let index = 0; index < Math.abs(count); index++) {
    expect([view.getInt32(cursor), view.getInt32(cursor + 4), view.getInt32(cursor + 8), view.getInt32(cursor + 12)]).toEqual([0, 0, 1, 3]); cursor += 16
    const channelCount = view.getUint16(cursor); cursor += 2
    const channels = Array.from({ length: channelCount }, () => { const id = view.getInt16(cursor), length = view.getUint32(cursor + 2); cursor += 6; return { id, length } })
    expect(text.decode(bytes.subarray(cursor, cursor + 4))).toBe('8BIM'); cursor += 4
    const blend = text.decode(bytes.subarray(cursor, cursor + 4)); cursor += 4
    const opacity = bytes[cursor], flags = bytes[cursor + 2]; cursor += 4
    const extraEnd = cursor + 4 + view.getUint32(cursor); cursor += 4
    for (let section = 0; section < 2; section++) { const length = view.getUint32(cursor); cursor += 4 + length }
    cursor += Math.ceil((bytes[cursor] + 1) / 4) * 4
    expect(text.decode(bytes.subarray(cursor, cursor + 8))).toBe('8BIMluni')
    const unicodeLength = view.getUint32(cursor + 12); cursor += 16
    let name = ''
    for (let character = 0; character < unicodeLength; character++) { name += String.fromCharCode(view.getUint16(cursor)); cursor += 2 }
    cursor = extraEnd
    layers.push({ name, blend, opacity, flags, channels })
  }
  for (const layer of layers) for (const channel of layer.channels) {
    expect(view.getUint16(cursor)).toBe(0)
    channel.bytes = Array.from(bytes.subarray(cursor + 2, cursor + channel.length)); cursor += channel.length
  }
  expect(cursor).toBe(infoEnd)
  cursor = sectionEnd
  expect(view.getUint16(cursor)).toBe(0); cursor += 2
  return { count, layers, composite: Array.from(bytes.subarray(cursor)) }
}

describe('bounded layered PSD writer', () => {
  it('writes independent RGBA planes, Unicode names, visibility, blend and opacity in bottom-to-top order', async () => {
    const f = fixture(), bytes = await writeLayerPsd(f.input, { yieldControl: async () => undefined })
    expect(Array.from(bytes.subarray(0, 6))).toEqual([56, 66, 80, 83, 0, 1])
    const value = inspect(bytes)
    expect(value.count).toBe(-2)
    expect(value.layers.map(({ name, opacity, flags, blend }) => ({ name, opacity, flags, blend }))).toEqual([
      { name: '底层 ☕', opacity: 255, flags: 8, blend: 'norm' }, { name: '上层 🖊', opacity: 128, flags: 10, blend: 'mul ' },
    ])
    expect(value.layers[1].channels).toEqual([
      { id: 0, length: 5, bytes: [10, 50, 90] }, { id: 1, length: 5, bytes: [20, 60, 100] },
      { id: 2, length: 5, bytes: [30, 70, 110] }, { id: -1, length: 5, bytes: [40, 80, 120] },
    ])
    expect(value.composite).toEqual([255, 127, 0, 0, 255, 0, 0, 127, 255, 255, 128, 0])
    expect(f.readLayer.mock.calls.map(([index]) => index)).toEqual([0, 1])
    expect(f.readComposite).toHaveBeenCalledOnce()
  })

  it.each(['screen', 'overlay'] as const)('preserves the %s blend metadata without altering channel pixels', async (blend) => {
    const f = fixture(); f.input.layers[1].blend = blend
    const value = inspect(await writeLayerPsd(f.input, { yieldControl: async () => undefined }))
    expect(value.layers[1].blend).toBe(blend === 'screen' ? 'scrn' : 'over')
    expect(value.layers[1].channels[3].bytes).toEqual([40, 80, 120])
  })

  it('keeps visible overlapping layer channels unattenuated for external recomposition', async () => {
    const f = fixture()
    f.input.layers[1] = { name: '前景', visible: true, opacity: 128 / 255, blend: 'source-over' }
    f.frames[0] = pixels([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255])
    f.frames[1] = pixels([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255])
    f.readComposite.mockResolvedValue(pixels([127, 0, 128, 255, 127, 0, 128, 255, 127, 0, 128, 255]))
    const value = inspect(await writeLayerPsd(f.input, { yieldControl: async () => undefined }))
    const [bottom, top] = value.layers
    expect(top.opacity).toBe(128)
    for (let pixel = 0; pixel < 3; pixel++) {
      expect(top.channels[3].bytes![pixel]).toBe(255)
      for (let channel = 0; channel < 3; channel++) {
        const recomposed = Math.round(top.channels[channel].bytes![pixel] * top.opacity / 255 + bottom.channels[channel].bytes![pixel] * (1 - top.opacity / 255))
        expect(recomposed).toBe(value.composite[channel * 3 + pixel])
      }
    }
  })

  it('white-mattes only merged RGB while preserving straight layer planes and transparency', async () => {
    const f = fixture(), rgba = [249, 115, 22, 191, 17, 39, 81, 128, 31, 71, 111, 0]
    f.input.layers = [f.input.layers[0]]
    f.frames[0] = pixels(rgba); f.readComposite.mockResolvedValue(f.frames[0])
    const value = inspect(await writeLayerPsd(f.input, { yieldControl: async () => undefined }))
    expect(value.composite).toEqual([251, 136, 31, 150, 147, 71, 80, 168, 111, 191, 128, 0])
    expect(value.layers[0].channels.map(({ bytes }) => bytes)).toEqual([[249, 17, 31], [115, 39, 71], [22, 81, 111], [191, 128, 0]])
    for (let pixel = 0; pixel < 3; pixel++) {
      const alpha = value.composite[9 + pixel]
      for (let channel = 0; channel < 3; channel++) {
        const stored = value.composite[channel * 3 + pixel]
        const decoded = alpha ? Math.max(0, Math.min(255, Math.floor((stored + alpha - 255) * 255 / alpha))) : stored
        expect(Math.abs(decoded - rgba[pixel * 4 + channel])).toBeLessThanOrEqual(1)
      }
    }
  })

  it('bounds low-alpha matte rounding without changing the editable layer color', async () => {
    const f = fixture(), rgba = [27, 93, 184, 1, 45, 101, 209, 16, 249, 115, 22, 255]
    f.input.layers = [f.input.layers[0]]
    f.frames[0] = pixels(rgba); f.readComposite.mockResolvedValue(f.frames[0])
    const value = inspect(await writeLayerPsd(f.input, { yieldControl: async () => undefined }))
    for (let pixel = 0; pixel < 3; pixel++) for (let channel = 0; channel < 3; channel++) {
      const alpha = rgba[pixel * 4 + 3], original = rgba[pixel * 4 + channel]
      expect(value.layers[0].channels[channel].bytes![pixel]).toBe(original)
      const stored = value.composite[channel * 3 + pixel]
      expect(Math.abs((stored + alpha - 255) - original * alpha / 255)).toBeLessThanOrEqual(0.5)
    }
  })

  it.each([[0, 10, 1], [4097, 10, 1], [10, 10, 0], [10, 10, 22], [4096, 4096, 2], [100, 100.5, 1]])('rejects unsafe dimensions or aggregate frames before calling pixel readers', async (width, height, count) => {
    const f = fixture(), readLayer = vi.fn()
    await expect(writeLayerPsd({ ...f.input, width, height, layers: Array.from({ length: count }, () => f.input.layers[0]), readLayer })).rejects.toThrow('PSD')
    expect(readLayer).not.toHaveBeenCalled()
  })

  it('accepts the exact aggregate pixel boundary without allocating it', () => {
    expect(() => assertLayerPsdBudget(4096, 4096, 1)).not.toThrow()
    expect(() => assertLayerPsdBudget(1024, 1024, 21)).not.toThrow()
  })

  it('rejects malformed frame lengths instead of exporting incomplete image data', async () => {
    const f = fixture(); f.readLayer.mockResolvedValue(pixels([1, 2, 3, 4]))
    await expect(writeLayerPsd(f.input)).rejects.toThrow('像素与画布尺寸')
    expect(f.readComposite).not.toHaveBeenCalled()
  })

  it('checks cancellation between planar chunks and never reads later layers or composite', async () => {
    const f = fixture(), controller = new AbortController(), yieldControl = vi.fn(async () => controller.abort())
    await expect(writeLayerPsd(f.input, { signal: controller.signal, yieldControl })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.readLayer).toHaveBeenCalledOnce()
    expect(f.readComposite).not.toHaveBeenCalled()
  })

  it('rejects expired work and invalid metadata before reading pixels', async () => {
    const f = fixture()
    await expect(writeLayerPsd(f.input, { deadline: 0 })).rejects.toThrow('超时')
    f.input.layers[0].name = 'bad\u0000name'
    await expect(writeLayerPsd(f.input)).rejects.toThrow('名称')
    expect(f.readLayer).not.toHaveBeenCalled()
  })
})
