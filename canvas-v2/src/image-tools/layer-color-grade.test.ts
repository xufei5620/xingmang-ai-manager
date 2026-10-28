import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorGrade, isNeutralImageLayerColorGrade, parseImageLayerColorGrade } from './layer-color-grade'
import { defaultImageTransformRecipe, parseImageTransformRecipe } from './recipe'
import type { ColorLutSelection } from './layer-color-lut-selection'
import { defaultImageLayerColorDetail } from './layer-color-detail'
import { defaultImageLayerColorPresence } from './layer-color-presence'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'

describe('versioned layer color grade', () => {
  it('retains explicit neutral and disabled calibration while leaving all legacy canonical grades unchanged', () => {
    const legacy = defaultImageLayerColorGrade(), neutral = defaultImageLayerColorCalibration()
    expect(Object.hasOwn(legacy, 'calibration')).toBe(false)
    expect(parseImageLayerColorGrade({ version: 1 })).toEqual(legacy)
    for (const calibration of [neutral, { ...neutral, enabled: false, redHue: 70, greenSaturation: -40, shadowTint: 90 }]) {
      const grade = parseImageLayerColorGrade({ version: 1, calibration })
      expect(grade.calibration).toEqual(calibration); expect(isNeutralImageLayerColorGrade(grade)).toBe(true)
      const recipe = { ...defaultImageTransformRecipe('layer'), kind: 'layer', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, colorGrade: grade }] }
      const parsed = parseImageTransformRecipe(JSON.parse(JSON.stringify(recipe)))
      expect(parsed.kind === 'layer' && parsed.layers[0].colorGrade?.calibration).toEqual(calibration)
    }
    const active = parseImageLayerColorGrade({ version: 1, calibration: { ...neutral, blueHue: -30 } })
    expect(isNeutralImageLayerColorGrade(active)).toBe(false)
    neutral.redHue = 5
    expect(active.calibration?.redHue).toBe(0)
    for (const calibration of [undefined, null, false, { ...neutral, version: 2 }, { ...neutral, processVersion: '15.4' }, { ...neutral, shadowTint: Infinity }]) expect(() => parseImageLayerColorGrade({ version: 1, calibration })).toThrow()
  })
  it('keeps legacy grades unchanged and retains explicit neutral or disabled presence through recipe round trips', () => {
    const old = defaultImageLayerColorGrade(), presence = defaultImageLayerColorPresence()
    expect(Object.hasOwn(old, 'presence')).toBe(false)
    expect(parseImageLayerColorGrade({ version: 1 })).toEqual(old)
    for (const value of [presence, { ...presence, enabled: false, texture: 70, clarity: -45, dehaze: 90 }]) {
      const grade = parseImageLayerColorGrade({ version: 1, presence: value })
      expect(grade.presence).toEqual(value); expect(isNeutralImageLayerColorGrade(grade)).toBe(true)
      const recipe = { ...defaultImageTransformRecipe('layer'), kind: 'layer', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, colorGrade: grade }] }
      const parsed = parseImageTransformRecipe(JSON.parse(JSON.stringify(recipe)))
      expect(parsed.kind === 'layer' && parsed.layers[0].colorGrade?.presence).toEqual(value)
    }
    const active = parseImageLayerColorGrade({ version: 1, presence: { ...presence, clarity: -10 } })
    expect(isNeutralImageLayerColorGrade(active)).toBe(false)
    presence.texture = 15
    expect(active.presence?.texture).toBe(0)
    for (const value of [null, false, undefined, { ...presence, version: 2 }, { ...presence, extra: 0 }]) expect(() => parseImageLayerColorGrade({ version: 1, presence: value })).toThrow()
  })
  it('retains explicit dormant detail controls while keeping old default bytes unchanged', () => {
    const old = defaultImageLayerColorGrade()
    expect(Object.hasOwn(old, 'detail')).toBe(false)
    const detail = defaultImageLayerColorDetail(); detail.sharpening.radius = 3
    const parsed = parseImageLayerColorGrade({ version: 1, detail })
    expect(parsed.detail).toEqual(detail)
    expect(isNeutralImageLayerColorGrade(parsed)).toBe(true)
    detail.color.amount = 70
    expect(parsed.detail?.color.amount).toBe(0)
    expect(isNeutralImageLayerColorGrade(parseImageLayerColorGrade({ version: 1, detail }))).toBe(false)
    detail.enabled = false
    expect(isNeutralImageLayerColorGrade(parseImageLayerColorGrade({ version: 1, detail }))).toBe(true)
    for (const value of [null, false, { ...detail, version: 2 }]) expect(() => parseImageLayerColorGrade({ version: 1, detail: value })).toThrow()
  })
  it('normalizes a versioned neutral preset without sharing curves or channels', () => {
    const first = parseImageLayerColorGrade({ version: 1 }), second = defaultImageLayerColorGrade()
    expect(first).toEqual(second)
    expect(isNeutralImageLayerColorGrade(first)).toBe(true)
    first.curves.rgb[0].y = .2; first.hsl.red.hue = 10
    expect(second.curves.rgb[0].y).toBe(0)
    expect(second.hsl.red.hue).toBe(0)
  })
  it.each([null, [], {}, { version: 2 }, { version: 1, lut: 'file:///private' }, { version: 1, exposure: 4.01 }, { version: 1, temperature: 10001 }, { version: 1, tint: -151 }, { version: 1, contrast: true }, { version: 1, grain: -1 }, { version: 1, blackWhite: 1 }, { version: 1, hsl: { cyan: {} } }, { version: 1, hsl: { red: { hue: 101 } } }, { version: 1, colorGrading: { shadows: { hue: 361 } } }])('rejects invalid or unknown configuration %j', (value) => {
    expect(() => parseImageLayerColorGrade(value)).toThrow()
  })
  it.each([
    [{ x: 0, y: 0 }], Array.from({ length: 17 }, (_, x) => ({ x: x / 16, y: x / 16 })),
    [{ x: .1, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: .9, y: 1 }],
    [{ x: 0, y: 0 }, { x: .5, y: .4 }, { x: .5, y: .6 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: Infinity }], [{ x: 0, y: 0, id: 'ui-only' }, { x: 1, y: 1 }],
  ].map((rgb) => ({ rgb })))('rejects ambiguous or oversized curves $rgb', ({ rgb }) => {
    expect(() => parseImageLayerColorGrade({ version: 1, curves: { rgb } })).toThrow()
  })
  it('allows endpoint output edits and nonmonotonic output without reordering input points', () => {
    expect(parseImageLayerColorGrade({ version: 1, curves: { rgb: [{ x: 0, y: 1 }, { x: .5, y: .2 }, { x: 1, y: 0 }] } }).curves.rgb).toEqual([{ x: 0, y: 1 }, { x: .5, y: .2 }, { x: 1, y: 0 }])
  })
  it('keeps legacy recipes canonical and adds grade only when explicitly supplied', () => {
    const legacy = { ...defaultImageTransformRecipe('layer'), kind: 'layer', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' } }] }
    expect(parseImageTransformRecipe(legacy)).toEqual(legacy)
    const graded = { ...legacy, layers: [{ ...legacy.layers[0], colorGrade: { version: 1, exposure: 1 } }] }
    const parsed = parseImageTransformRecipe(graded)
    expect(parsed.kind === 'layer' && parsed.layers[0].colorGrade).toEqual({ ...defaultImageLayerColorGrade(), exposure: 1 })
    expect(() => parseImageTransformRecipe({ ...graded, layers: [{ ...graded.layers[0], colorGrade: { version: 9 } }] })).toThrow('版本')
  })

  it('retains a strict LUT selection without adding fields to legacy canonical grades', () => {
    const legacy = defaultImageLayerColorGrade()
    expect(Object.hasOwn(legacy, 'lut')).toBe(false)
    expect(parseImageLayerColorGrade({ version: 1 })).toEqual(legacy)
    const selection: ColorLutSelection = { version: 1, enabled: true, strength: 50, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: 'Owned 🎨 LUT', domainMin: [-1, 0, 0], domainMax: [1, 2, 1] } }
    const parsed = parseImageLayerColorGrade({ version: 1, lut: selection })
    expect(parsed.lut).toEqual(selection)
    expect(isNeutralImageLayerColorGrade(parsed)).toBe(false)
    selection.source.kind === 'asset' && (selection.source.domainMin[0] = -2)
    expect(parsed.lut?.source.kind === 'asset' && parsed.lut.source.domainMin).toEqual([-1, 0, 0])
    const recipe = { ...defaultImageTransformRecipe('layer'), kind: 'layer', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, colorGrade: parsed }] }
    const roundTrip = parseImageTransformRecipe(JSON.parse(JSON.stringify(recipe)))
    expect(roundTrip.kind === 'layer' && roundTrip.layers[0].colorGrade).toEqual(parsed)
  })

  it.each([{ enabled: false, strength: 100 }, { enabled: true, strength: 0 }])('keeps inactive selections editable while identifying exact pixel neutrality: %j', (controls) => {
    const lut = { version: 1, ...controls, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } }, parsed = parseImageLayerColorGrade({ version: 1, lut })
    expect(parsed.lut).toEqual(lut)
    expect(isNeutralImageLayerColorGrade(parsed)).toBe(true)
  })

  it.each([null, false, { version: 2 }, { version: 1, enabled: true, strength: 101, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } }, { version: 1, enabled: true, strength: 100, source: { kind: 'builtin', presetId: 'unknown' } }, { version: 1, enabled: true, strength: 100, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' }, data: [] }])('rejects unsupported LUT configuration through the grade parser %j', (lut) => {
    expect(() => parseImageLayerColorGrade({ version: 1, lut })).toThrow(/LUT/)
  })
})
