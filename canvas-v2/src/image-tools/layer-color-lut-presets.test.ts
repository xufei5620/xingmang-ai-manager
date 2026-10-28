import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ColorLutTable } from './layer-color-lut'
import { createLayerColorLutPreset, layerColorLutPresets } from './layer-color-lut-presets'

function at(table: ColorLutTable, red: number, green: number, blue: number): number[] {
  const offset = (red + 33 * green + 1089 * blue) * 3
  return Array.from(table.data.subarray(offset, offset + 3))
}
function expectColor(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(3)
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 6))
}
function preset(slug: string): ColorLutTable { return createLayerColorLutPreset(`xm-lut-${slug}-v1`) }

afterEach(() => vi.restoreAllMocks())

describe('original built-in layer color LUT presets', () => {
  it('exposes eighteen frozen versioned metadata entries without allocated tables', () => {
    expect(layerColorLutPresets.map((entry) => entry.name)).toEqual(['电影色调', '复古胶片', '柔和胶片', '对比胶片', '奶油色调', '清冷色调', '日式清新', '柔和森系', '通透质感', '增强对比', '亮度对比度', '泾渭分明', '曝光加强', '曝光压制', '高饱和', '鲜艳色彩', '柔和色彩', '低饱和'])
    expect(layerColorLutPresets.map((entry) => entry.id)).toEqual(['movie-tone', 'retro-film', 'soft-film', 'contrast-film', 'cream-tone', 'cool-tone', 'japanese-fresh', 'soft-forest', 'clear-texture', 'enhanced-contrast', 'brightness-contrast', 'distinct-tones', 'exposure-up', 'exposure-down', 'high-saturation', 'vivid-colors', 'soft-colors', 'low-saturation'].map((slug) => `xm-lut-${slug}-v1`))
    expect(Object.isFrozen(layerColorLutPresets)).toBe(true)
    for (const entry of layerColorLutPresets) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.keys(entry).sort()).toEqual(['description', 'id', 'name', 'version'])
      expect(entry.version).toBe(1)
      expect(entry.description.length).toBeGreaterThan(10)
    }
  })

  it('generates one bounded 33 cubed Float32 table per request and all eighteen effects differ', () => {
    const hashes = new Set<string>()
    for (const entry of layerColorLutPresets) {
      const table = createLayerColorLutPreset(entry.id)
      expect(table).toMatchObject({ version: 1, size: 33, name: entry.name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] })
      expect(table.data).toBeInstanceOf(Float32Array)
      expect(table.data.length).toBe(107811)
      expect(table.data.byteLength).toBe(431244)
      let firstInvalid = -1, minimum = Infinity, maximum = -Infinity
      for (let index = 0; index < table.data.length; index++) {
        const value = table.data[index]
        if (!Number.isFinite(value) || value < 0 || value > 1) { firstInvalid = index; break }
        minimum = Math.min(minimum, value); maximum = Math.max(maximum, value)
      }
      expect({ id: entry.id, firstInvalid }).toEqual({ id: entry.id, firstInvalid: -1 })
      expect(maximum - minimum).toBeGreaterThan(.7)
      hashes.add(createHash('sha256').update(new Uint8Array(table.data.buffer, table.data.byteOffset, table.data.byteLength)).digest('hex'))
    }
    expect(hashes.size).toBe(18)
  })

  it.each([
    ['movie-tone', [0, 0, 0], [1, 1, 1]],
    ['retro-film', [.06, .045, .07], [.96, .935, .86]],
    ['soft-film', [.052, .04, .04], [.96, .96, .948]],
    ['contrast-film', [0, 0, 0], [1, 1, 1]],
    ['cream-tone', [.0612, .0606, .0564], [.9996, .9898, .9212]],
    ['cool-tone', [0, 0, .0045], [.9292, 1, 1]],
    ['japanese-fresh', [.075, .095, .085], [.965, .985, .975]],
    ['soft-forest', [.025, .045, .025], [.965, .965, .945]],
    ['clear-texture', [0, 0, 0], [1, 1, 1]],
    ['enhanced-contrast', [0, 0, 0], [1, 1, 1]],
    ['brightness-contrast', [0, 0, 0], [1, 1, 1]],
    ['distinct-tones', [0, 0, 0], [1, 1, 1]],
    ['exposure-up', [0, 0, 0], [1, 1, 1]],
    ['exposure-down', [0, 0, 0], [1, 1, 1]],
    ['high-saturation', [0, 0, 0], [1, 1, 1]],
    ['vivid-colors', [0, 0, 0], [1, 1, 1]],
    ['soft-colors', [.025, .025, .025], [.965, .965, .965]],
    ['low-saturation', [0, 0, 0], [1, 1, 1]],
  ] as const)('keeps the version-one black and white anchors for %s', (slug, black, white) => {
    const table = preset(slug)
    expectColor(at(table, 0, 0, 0), [...black])
    expectColor(at(table, 32, 32, 32), [...white])
  })

  it('stores red fastest and keeps all three axes independent', () => {
    const table = preset('exposure-down')
    // (1/32)^1.2 is exactly 1/64; these entries distinguish all axis strides.
    expect(at(table, 1, 0, 0)).toEqual([.015625, 0, 0])
    expect(at(table, 0, 1, 0)).toEqual([0, .015625, 0])
    expect(at(table, 0, 0, 1)).toEqual([0, 0, .015625])
    expect(at(table, 32, 0, 0)).toEqual([1, 0, 0])
    expect(at(table, 0, 32, 0)).toEqual([0, 1, 0])
    expect(at(table, 0, 0, 32)).toEqual([0, 0, 1])
  })

  it.each([
    ['enhanced-contrast', [.1875, .5, .8125]],
    ['brightness-contrast', [.27, .54, .81]],
    ['high-saturation', [.153295, .515795, .878295]],
    ['low-saturation', [.389685, .477185, .564685]],
    ['exposure-up', [.2919343665, .5647247184, .8105354292]],
    ['exposure-down', [.1894645708, .4352752816, .7080656335]],
  ] as const)('matches an independently calculated colored sample for %s', (slug, expected) => {
    expectColor(at(preset(slug), 8, 16, 24), [...expected])
  })

  it.each(['high-saturation', 'low-saturation', 'enhanced-contrast'])('preserves neutral middle gray in %s', (slug) => {
    expect(at(preset(slug), 16, 16, 16)).toEqual([.5, .5, .5])
  })

  it('is deterministic and returns fresh independently mutable data and domains', () => {
    const first = preset('movie-tone'), second = preset('movie-tone')
    expect(first.data).toEqual(second.data)
    expect(first.data.buffer).not.toBe(second.data.buffer)
    expect(first.domainMin).not.toBe(second.domainMin)
    expect(first.domainMax).not.toBe(second.domainMax)
    first.data.fill(.123); first.domainMin[0] = -1; first.domainMax[0] = 2
    const third = preset('movie-tone')
    expect(third.data).toEqual(second.data)
    expect(third.domainMin).toEqual([0, 0, 0])
    expect(third.domainMax).toEqual([1, 1, 1])
  })

  it.each(['', 'xm-lut-movie-tone-v2', 'movie-tone', '__proto__', 'https://example.com/look.cube'])('rejects an unknown or future preset without fallback: %s', (id) => {
    expect(() => createLayerColorLutPreset(id)).toThrow('预设不存在或版本不受支持')
  })

  it.each([NaN, Infinity, -Infinity, -1])('rejects an invalid deadline: %s', (deadline) => {
    expect(() => createLayerColorLutPreset(layerColorLutPresets[0].id, { deadline })).toThrow('时间限制无效')
  })

  it('rejects an already cancelled request before creating a result', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => createLayerColorLutPreset(layerColorLutPresets[0].id, { signal: controller.signal })).toThrow(expect.objectContaining({ name: 'AbortError', message: '已取消内置 LUT 创建，原调整保留' }))
  })

  it('stops on a deadline during generation instead of returning a partial table', () => {
    let checks = 0
    vi.spyOn(Date, 'now').mockImplementation(() => ++checks < 4 ? 1000 : 2000)
    expect(() => createLayerColorLutPreset(layerColorLutPresets[0].id, { deadline: 1500 })).toThrow('创建超时')
    expect(checks).toBe(4)
  })

  it('checks cancellation again between bounded rows during generation', () => {
    const controller = new AbortController()
    let checks = 0
    vi.spyOn(Date, 'now').mockImplementation(() => { if (++checks === 3) controller.abort(); return 1000 })
    expect(() => createLayerColorLutPreset(layerColorLutPresets[0].id, { signal: controller.signal, deadline: 1500 })).toThrow(expect.objectContaining({ name: 'AbortError' }))
    expect(checks).toBe(3)
  })

  it('rejects an expired deadline and accepts a future finite deadline', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    expect(() => createLayerColorLutPreset(layerColorLutPresets[0].id, { deadline: 1000 })).toThrow('创建超时')
    expect(createLayerColorLutPreset(layerColorLutPresets[0].id, { deadline: 1001 }).data.length).toBe(107811)
  })
})
