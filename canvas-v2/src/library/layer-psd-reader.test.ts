import { describe, expect, it, vi } from 'vitest'
import { openLayerPsd, readLayerPsd } from './layer-psd-reader'
import { writeLayerPsd } from './layer-psd-writer'
import { buildPsdReaderFixture, fixtureU32 } from './layer-psd-reader.test-fixture'

const fast = { yieldControl: async () => undefined }

describe('bounded layered PSD reader', () => {
  it('keeps bottom-to-top order, cropped bounds, hidden RGB, alpha and independent opacity', async () => {
    const rgba = [249, 115, 22, 1, 31, 71, 111, 0]
    const document = await readLayerPsd(buildPsdReaderFixture({ width: 4, height: 3, layers: [{ name: '底层 ☕', width: 2, height: 1, left: -1, top: 2, pixels: rgba }, { name: '隐藏顶层', width: 1, height: 1, left: 3, opacity: 128, flags: 10, blend: 'mul ', pixels: [11, 33, 55, 77] }] }), fast)
    expect(document).toMatchObject({ width: 4, height: 3, warnings: [] })
    expect(document.layers[0]).toMatchObject({ name: '底层 ☕', left: -1, top: 2, width: 2, height: 1, opacity: 1, visible: true, blend: 'source-over' })
    expect(Array.from(document.layers[0].data)).toEqual(rgba)
    expect(document.layers[1]).toMatchObject({ name: '隐藏顶层', opacity: 128 / 255, visible: false, blend: 'multiply' })
    expect(Array.from(document.layers[1].data)).toEqual([11, 33, 55, 77])
  })

  it('decodes literal, repeated and no-op PackBits rows with exact row boundaries', async () => {
    const doc = await readLayerPsd(buildPsdReaderFixture({ width: 5, height: 2, compositeCompression: 1, layers: [{ compression: 1, packedRows: [[128, 1, 10, 20, 254, 30], [252, 7]] }] }), fast)
    expect(Array.from(doc.layers[0].data)).toEqual([10, 20, 30, 30, 30, 7, 7, 7, 7, 7].flatMap((value) => [value, value, value, value]))
  })

  it('provides opaque alpha for three-channel layers and accepts benign group-resource metadata', async () => {
    const doc = await readLayerPsd(buildPsdReaderFixture({ channels: 3, resources: [{ id: 1026, data: [0, 0] }, { id: 1072, data: [1] }], layers: [{ channelIds: [0, 1, 2], tags: [{ key: 'lyid', data: fixtureU32(42) }, { key: 'lclr', data: Array(8).fill(0) }, { key: 'iOpa', data: [255, 0, 0, 0] }] }] }), fast)
    expect([doc.layers[0].data[3], doc.layers[0].data[7]]).toEqual([255, 255])
  })

  it.each(['scrn', 'over'])('supports the %s blend mode without baking it into pixels', async (blend) => {
    const doc = await readLayerPsd(buildPsdReaderFixture({ layers: [{ blend }] }), fast)
    expect(doc.layers[0].blend).toBe(blend === 'scrn' ? 'screen' : 'overlay')
  })

  it('roundtrips native writer metadata and straight RGBA instead of its white-matted preview', async () => {
    const frame = { width: 2, height: 1, data: new Uint8ClampedArray([249, 115, 22, 1, 31, 71, 111, 0]) }
    const bytes = await writeLayerPsd({ width: 2, height: 1, layers: [{ name: '渐变与曲线', visible: false, opacity: 0.5, blend: 'overlay' }], readLayer: async () => frame, readComposite: async () => frame }, fast)
    const document = await readLayerPsd(bytes, fast)
    expect(document.layers[0].data).toEqual(frame.data)
    expect(document.layers[0]).toMatchObject({ name: '渐变与曲线', opacity: 128 / 255, visible: false, blend: 'overlay' })
  })

  it('accepts twenty layers and explains the independent background at twenty-one', async () => {
    expect((await readLayerPsd(buildPsdReaderFixture({ layers: Array.from({ length: 20 }, () => ({})) }), fast)).layers).toHaveLength(20)
    await expect(readLayerPsd(buildPsdReaderFixture({ layers: Array.from({ length: 21 }, () => ({})) }), fast)).rejects.toThrow('独立背景')
  })

  it.each([
    [{ version: 2 }, 'PSB'], [{ depth: 16 }, 'RGB 8'], [{ depth: 32 }, 'RGB 8'], [{ mode: 4 }, 'RGB 8'], [{ channels: 5 }, '专色'],
    [{ width: 4097 }, '4096'], [{ height: 0 }, '4096'], [{ layers: [] }, '独立图层'],
    [{ layers: [{ width: 0 }] }, '边界'], [{ layers: [{ left: 16385 }] }, '边界'],
    [{ layers: [{ width: 4096, height: 4096 }, { width: 4096, height: 4096 }] }, '总像素'],
    [{ layers: [{ channelIds: [0, 1, 2, -2] }] }, '通道'], [{ layers: [{ channelIds: [0, 1, 1] }] }, '通道'],
    [{ layers: [{ compression: 2 }] }, 'ZIP'], [{ layers: [{ compression: 3 }] }, 'ZIP'], [{ compositeCompression: 2 }, 'ZIP'],
    [{ layers: [{ clipping: 1 }] }, '剪贴'], [{ layers: [{ blend: 'diss' }] }, '混合模式'],
    [{ layers: [{ mask: [0, 0, 0, 0] }] }, '蒙版'], [{ globalMask: [0, 0, 0, 0] }, '蒙版'],
    [{ layers: [{ ranges: [0, 1, 255, 255, 0, 0, 255, 255] }] }, '混合范围'],
    [{ layers: [{ name: '长'.repeat(81) }] }, '名称'], [{ layers: [{ name: '坏\u0000名称' }] }, '名称'],
    [{ resources: [{ id: 1039, data: [1, 2] }] }, 'ICC'],
  ])('rejects unsupported or unsafe documents before returning pixels: %j', async (input, message) => {
    await expect(readLayerPsd(buildPsdReaderFixture(structuredClone(input)), fast)).rejects.toThrow(message)
  })

  it.each(['lrFX', 'lfx2', 'TySh', 'vmsk', 'SoLd', 'curv', 'zzzz'])('rejects %s appearance metadata rather than ignoring it', async (key) => {
    await expect(readLayerPsd(buildPsdReaderFixture({ layers: [{ tags: [{ key, data: [] }] }] }), fast)).rejects.toThrow('不支持的图层属性')
  })

  it('rejects an empty lsct block as an invalid folder record rather than unknown metadata', async () => {
    await expect(readLayerPsd(buildPsdReaderFixture({ layers: [{ tags: [{ key: 'lsct', data: [] }] }] }), fast)).rejects.toThrow('编组分隔记录长度无效')
  })

  it.each([[255, 7], [0, 4], [3, 1, 2, 3, 4], [1, 4], [128]])('rejects malformed PackBits row %j', async (...values) => {
    const row = values.flat()
    await expect(readLayerPsd(buildPsdReaderFixture({ width: 3, layers: [{ compression: 1, packedRows: [row] }] }), fast)).rejects.toThrow('PSD')
  })

  it('rejects truncation, trailing bytes and overflowing section lengths', async () => {
    const valid = buildPsdReaderFixture()
    await expect(readLayerPsd(valid.slice(0, -1), fast)).rejects.toThrow('PSD')
    await expect(readLayerPsd(new Uint8Array([...valid, 0]), fast)).rejects.toThrow('PSD')
    const corrupt = valid.slice(); new DataView(corrupt.buffer).setUint32(26, 0xffffffff)
    await expect(readLayerPsd(corrupt, fast)).rejects.toThrow('PSD')
  })

  it('checks cancellation and deadlines before work and while validating large encoded data', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(readLayerPsd(buildPsdReaderFixture(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readLayerPsd(buildPsdReaderFixture(), { deadline: 0 })).rejects.toThrow('超时')
    const input = { width: 512, height: 128, layers: [{ name: '大图', visible: true, opacity: 1, blend: 'source-over' as const }], readLayer: async () => ({ width: 512, height: 128, data: new Uint8ClampedArray(512 * 128 * 4) }), readComposite: async () => ({ width: 512, height: 128, data: new Uint8ClampedArray(512 * 128 * 4) }) }
    const bytes = await writeLayerPsd(input, fast), late = new AbortController(), yieldControl = vi.fn(async () => { late.abort() })
    await expect(readLayerPsd(bytes, { signal: late.signal, yieldControl })).rejects.toMatchObject({ name: 'AbortError' })
    expect(yieldControl).toHaveBeenCalledOnce()
  })

  it('bounds sequential decoder indices and keeps returned metadata separate from its internal records', async () => {
    const reader = await openLayerPsd(buildPsdReaderFixture(), fast)
    reader.layers[0].width = 9999
    expect((await reader.readLayer(0)).width).toBe(2)
    await expect(reader.readLayer(-1)).rejects.toThrow('读取顺序')
    await expect(reader.readLayer(1)).rejects.toThrow('读取顺序')
  })

  it('bounds and yields during metadata scanning before any layer decode', async () => {
    const controller = new AbortController(), resources = Array.from({ length: 128 }, () => ({ id: 1005, data: [] })), yieldControl = vi.fn(async () => { controller.abort() })
    await expect(readLayerPsd(buildPsdReaderFixture({ resources }), { signal: controller.signal, yieldControl })).rejects.toMatchObject({ name: 'AbortError' })
    expect(yieldControl).toHaveBeenCalledOnce()
    await expect(readLayerPsd(buildPsdReaderFixture({ resources: Array.from({ length: 4097 }, () => ({ id: 1005, data: [] })) }), fast)).rejects.toThrow('资源数量过多')
    await expect(readLayerPsd(buildPsdReaderFixture({ layers: [{ ranges: Array.from({ length: 6 }, () => [0, 0, 255, 255, 0, 0, 255, 255]).flat() }] }), fast)).rejects.toThrow('混合范围')
  })
})
