import { describe, expect, it } from 'vitest'
import { layerColorLutPresets } from './layer-color-lut-presets'
import { buildColorLutSelection, colorLutSelectionIsActive, colorLutSourceKey, parseColorLutSelection, parseColorLutSource, type AssetColorLutSource } from './layer-color-lut-selection'

function asset(): AssetColorLutSource {
  return { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: '原创 LUT', domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

function selected() {
  return { version: 1, enabled: true, strength: 100, source: asset() }
}

describe('persistent color LUT selections', () => {
  it('stores twenty distinct full-resolution LUT references within the existing project limit', () => {
    const layers = Array.from({ length: 20 }, (_, index) => ({ colorGrade: { lut: buildColorLutSelection({ ...asset(), lutAssetId: String(index).padStart(43, 'a') }) } }))
    const text = JSON.stringify({ layers })
    expect(new TextEncoder().encode(text).length).toBeLessThan(12_000)
    expect(text).not.toContain('Float32')
    expect(new Set(layers.map((layer) => layer.colorGrade.lut.source.kind === 'asset' ? layer.colorGrade.lut.source.lutAssetId : '')).size).toBe(20)
  })

  it('retains disabled and zero-strength sources when building and parsing a selection', () => {
    const disabled = parseColorLutSelection({ ...selected(), enabled: false, strength: 0 })
    expect(disabled.source).toEqual(asset())
    expect(colorLutSelectionIsActive(disabled)).toBe(false)
    expect(buildColorLutSelection(asset(), disabled)).toMatchObject({ enabled: true, strength: 0 })
    expect(colorLutSelectionIsActive({ ...disabled, enabled: true })).toBe(false)
    expect(colorLutSelectionIsActive(undefined)).toBe(false)
    expect(colorLutSelectionIsActive({ ...disabled, enabled: true, strength: .1 })).toBe(true)
  })

  it('uses immutable resource identity independently of strength and display names', () => {
    const first = asset(), renamed = { ...asset(), name: '另一个显示名称' }
    expect(colorLutSourceKey(first)).toBe(colorLutSourceKey(renamed))
    expect(colorLutSourceKey({ ...first, digest: 'c'.repeat(64) })).not.toBe(colorLutSourceKey(first))
    expect(colorLutSourceKey({ ...first, lutAssetId: 'd'.repeat(43) })).not.toBe(colorLutSourceKey(first))
  })

  it('accepts only the eighteen known immutable builtin versions without inline table data', () => {
    expect(layerColorLutPresets).toHaveLength(18)
    for (const preset of layerColorLutPresets) expect(parseColorLutSource({ kind: 'builtin', presetId: preset.id })).toEqual({ kind: 'builtin', presetId: preset.id })
    expect(() => parseColorLutSource({ kind: 'builtin', presetId: 'future-preset-v2' })).toThrow('版本')
    expect(() => parseColorLutSource({ kind: 'builtin', presetId: layerColorLutPresets[0].id, data: 'table' })).toThrow('字段')
    expect(() => parseColorLutSource({ kind: 'builtin', presetId: layerColorLutPresets[0].id, lutAssetId: asset().lutAssetId })).toThrow('字段')
  })

  it('copies parsed domains so later caller mutations cannot change a validated source', () => {
    const original = asset(), parsed = parseColorLutSource(original)
    original.domainMin[0] = -12
    expect(parsed.kind === 'asset' && parsed.domainMin).toEqual([0, 0, 0])
  })

  it.each([null, undefined, [], true, 1, 'lut', { ...selected(), version: 2 }, { ...selected(), version: '1' }, { ...selected(), enabled: 1 }, { ...selected(), source: null }, { ...selected(), secret: 'not-allowed' }])('rejects invalid selection envelopes: %j', (value) => {
    expect(() => parseColorLutSelection(value)).toThrow()
  })

  it.each([NaN, Infinity, -Infinity, -1, 100.01, '50', null, undefined])('rejects invalid strengths: %j', (strength) => {
    expect(() => parseColorLutSelection({ ...selected(), strength })).toThrow('强度')
  })

  it.each(['', ' a ', 'x'.repeat(161), 'bad\u0000name', 'bad\u007fname', 'bad\ud800name'])('rejects invalid custom names: %j', (name) => {
    expect(() => parseColorLutSource({ ...asset(), name })).toThrow('名称')
  })

  it.each([
    { lutAssetId: '../private' }, { lutAssetId: 'https://example.test/file' }, { lutAssetId: 'a'.repeat(44) },
    { digest: 'B'.repeat(64) }, { digest: 'a'.repeat(63) }, { kind: 'remote', url: 'https://example.test/private.cube' },
    { domainMin: [0, 0] }, { domainMax: [1, 1, 1, 1] }, { domainMin: [NaN, 0, 0] },
    { domainMin: [-16.1, 0, 0] }, { domainMax: [17, 1, 1] }, { domainMin: [1, 0, 0] },
    { domainMax: [1, 0, 1] }, { domainMin: ['0', 0, 0] }, { presetId: 'unexpected' },
  ])('rejects malformed asset identities and domains before lookup: %j', (patch) => {
    expect(() => parseColorLutSource({ ...asset(), ...patch })).toThrow()
  })
})
