import { describe, expect, it } from 'vitest'
import { defaultImageLayerTypography, imageLayerTextFont, imageLayerTextLines, imageLayerTextWarpPoint, imageLayerTextWarpStyles, parseImageLayerTypography, rasterizeImageLayerTextWarpSteps } from './layer-text-layout'
import { imageTransformProcessorRevision, parseImageTransformRecipe, type ImageLayerTextContent } from './recipe'

function content(): ImageLayerTextContent { return { kind: 'text', text: '  中文 👩🏽‍💻 e\u0301 office\r\n\n尾行  ', color: '#ffffff', fontSize: 20, fontFamily: 'serif', fontWeight: 400, align: 'left' } }
function recipe(text: ImageLayerTextContent) { return { kind: 'layer', outputWidth: 200, outputHeight: 100, background: 'transparent', layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: text }], explicitLayers: true } }
function pixels(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; data[i] = x * 7 % 256; data[i + 1] = y * 11 % 256; data[i + 2] = 198; data[i + 3] = x > 2 && y > 2 ? (x + y) % 3 ? 255 : 128 : 0 }
  return data
}

describe('versioned layer text layout', () => {
  it('keeps old canonical recipes and processor receipts byte identical', () => {
    const original = recipe(content())
    expect(JSON.stringify(parseImageTransformRecipe(original))).toBe(JSON.stringify(original))
    expect(imageTransformProcessorRevision).toBe('browser-image-v1')
    expect(imageLayerTextFont(content())).toBe('400 20px serif')
  })
  it('keeps complete multilingual shaping runs, blank lines and whitespace', () => {
    expect(imageLayerTextLines({ ...content(), typography: { ...defaultImageLayerTypography(), lineHeight: 2, letterSpacing: 3 } }, 100)).toEqual([
      { text: '  中文 👩🏽‍💻 e\u0301 office', baseline: 20 }, { text: '', baseline: 60 }, { text: '尾行  ', baseline: 100 },
    ])
    expect(imageLayerTextLines(content(), 24)).toEqual([{ text: '  中文 👩🏽‍💻 e\u0301 office', baseline: 20 }])
  })
  it('roundtrips all modes and weights without injecting local font identity', () => {
    for (const { id } of imageLayerTextWarpStyles) for (let weight = 100; weight <= 900; weight += 100) {
      const typography = parseImageLayerTypography({ version: 1, lineHeight: .5, letterSpacing: -20, fontWeight: weight, warp: { style: id, bend: -100 } })
      expect(parseImageTransformRecipe(recipe({ ...content(), typography }))).toMatchObject({ layers: [{ content: { typography } }] })
      expect(typography).not.toHaveProperty('fontFamily')
    }
  })
  it('quotes validated explicit local families and rejects CSS or URL inputs', () => {
    const typography = parseImageLayerTypography({ ...defaultImageLayerTypography(), fontFamily: '测试 Noto Sans', fontSource: 'local', fontWeight: 600 })
    expect(imageLayerTextFont({ ...content(), typography })).toBe('600 20px "测试 Noto Sans"')
    for (const fontFamily of ['', ' Foo', 'Foo ', 'url(x)', 'a,b', 'a"b', 'https://x', 'f\n', 'x'.repeat(101)]) expect(() => parseImageLayerTypography({ ...typography, fontFamily })).toThrow()
    expect(() => parseImageLayerTypography({ ...defaultImageLayerTypography(), fontFamily: 'Font' })).toThrow()
    expect(() => parseImageLayerTypography({ ...defaultImageLayerTypography(), fontSource: 'local' })).toThrow()
  })
  it('rejects future versions, malformed options and range overflow without coercion', () => {
    for (const patch of [{ version: 2 }, { version: '1' }, { lineHeight: .49 }, { lineHeight: 3.01 }, { letterSpacing: -21 }, { letterSpacing: 101 }, { letterSpacing: NaN }, { fontWeight: 550 }, { warp: { style: 'unknown', bend: 50 } }, { warp: { style: 'arc', bend: 101 } }, { warp: { style: 'arc', bend: 50, url: 'x' } }, { sourceUrl: 'x' }]) expect(() => parseImageLayerTypography({ ...defaultImageLayerTypography(), ...patch })).toThrow()
    expect(() => parseImageTransformRecipe(recipe({ ...content(), typography: null as unknown as ImageLayerTextContent['typography'] }))).toThrow()
  })
  it('deep clones the optional structure without changing untouched text', () => {
    const typography = { ...defaultImageLayerTypography(), warp: { style: 'arc' as const, bend: 50 } }, original = recipe({ ...content(), typography })
    const parsed = parseImageTransformRecipe(original)
    if (parsed.kind !== 'layer' || parsed.layers[0].content?.kind !== 'text') throw new Error('fixture')
    expect(parsed.layers[0].content.text).toBe(content().text)
    expect(parsed.layers[0].content.typography).not.toBe(typography)
    expect(parsed.layers[0].content.typography?.warp).not.toBe(typography.warp)
  })
})

describe('bounded local text deformation', () => {
  it.each(imageLayerTextWarpStyles)('keeps $id exactly unchanged at zero bend', ({ id }) => {
    const source = pixels(29, 67), output = new Uint8ClampedArray(source.length)
    for (const tile of rasterizeImageLayerTextWarpSteps(source, 29, 67, { style: id, bend: 0 })) output.set(tile.data, tile.top * 29 * 4)
    expect(output).toEqual(source)
    expect(imageLayerTextWarpPoint(id, 0, .32, -.24)).toEqual({ x: .32, y: -.24 })
  })
  it('implements thirteen distinct continuous bounded maps with both bend signs', () => {
    const signatures = new Set<string>()
    for (const { id } of imageLayerTextWarpStyles) {
      const samples: unknown[] = []
      for (const bend of [-100, 50, 100]) for (let xi = -10; xi <= 10; xi++) for (let yi = -10; yi <= 10; yi++) {
        const x = xi / 10, y = yi / 10, point = imageLayerTextWarpPoint(id, bend, x, y), nearby = imageLayerTextWarpPoint(id, bend, x + .000001, y)
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
        expect(Math.max(Math.abs(point.x), Math.abs(point.y))).toBeLessThan(2.6)
        expect(Math.hypot(nearby.x - point.x, nearby.y - point.y)).toBeLessThan(.00002)
        samples.push(point)
      }
      signatures.add(JSON.stringify(samples))
    }
    expect(signatures.size).toBe(13)
  })
  it('uses premultiplied interpolation without a black halo on partial alpha', () => {
    const source = new Uint8ClampedArray(32 * 32 * 4)
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) source.set([240, 125, 40, 255], (y * 32 + x) * 4)
    for (const { id } of imageLayerTextWarpStyles) {
      const data = [...rasterizeImageLayerTextWarpSteps(source, 32, 32, { style: id, bend: 53 })][0].data
      let partial = 0
      for (let index = 0; index < data.length; index += 4) if (data[index + 3]) { expect([...data.slice(index, index + 3)]).toEqual([240, 125, 40]); if (data[index + 3] < 255) partial++ }
      expect(partial).toBeGreaterThan(0)
    }
  })
  it('supports cancellation between bounded tiles and expired deadlines', () => {
    const controller = new AbortController(), steps = rasterizeImageLayerTextWarpSteps(pixels(80, 80), 80, 80, { style: 'twist', bend: 50 }, { signal: controller.signal })
    expect(steps.next().value).toMatchObject({ top: 0, height: 32 })
    controller.abort()
    expect(() => steps.next()).toThrow('取消')
    expect(() => [...rasterizeImageLayerTextWarpSteps(pixels(2, 2), 2, 2, { style: 'arc', bend: 50 }, { deadline: Date.now() - 1 })]).toThrow('超时')
  })
  it('refuses oversized or truncated sources before any pixel allocation', () => {
    for (const [width, height] of [[4097, 1], [4096, 4096], [0, 1], [2.5, 2]]) expect(() => rasterizeImageLayerTextWarpSteps(new Uint8ClampedArray(), width, height, { style: 'arc', bend: 50 }).next()).toThrow('最多支持')
    expect(() => rasterizeImageLayerTextWarpSteps(new Uint8ClampedArray(3), 1, 1, { style: 'arc', bend: 50 }).next()).toThrow('像素格式')
  })
})
