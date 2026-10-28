import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorGrade, type ImageLayerColorGrade } from './layer-color-grade'
import { createLayerColorGradeRasterizer, layerColorCurveValue, rasterizeLayerColorGrade, rasterizeLayerColorGradeSteps } from './layer-color-grade-raster'
import { createColorLutSampler, parseColorLutCube, type ColorLutTable } from './layer-color-lut'
import { createLayerColorLutPreset } from './layer-color-lut-presets'
import type { ColorLutSelection } from './layer-color-lut-selection'
import { defaultImageLayerColorDetail } from './layer-color-detail'
import { rasterizeLayerColorDetail } from './layer-color-detail-raster'
import { defaultImageLayerColorPresence } from './layer-color-presence'
import { rasterizeLayerColorPresence } from './layer-color-presence-raster'
import { defaultImageLayerColorCalibration, imageLayerColorCalibrationAmounts } from './layer-color-calibration'
import { createLayerColorCalibrationTransform } from './layer-color-calibration-raster'

function render(data: number[], patch: Partial<ImageLayerColorGrade> = {}, width = data.length / 4) {
  return [...rasterizeLayerColorGrade({ data: new Uint8ClampedArray(data), width, height: data.length / 4 / width, grade: { ...defaultImageLayerColorGrade(), ...patch } })]
}

function lutSelection(table: ColorLutTable, strength = 100, enabled = true): ColorLutSelection { return { version: 1, enabled, strength, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: table.name, domainMin: [...table.domainMin], domainMax: [...table.domainMax] } } }
function invertTable() { return parseColorLutCube('TITLE "Owned invert"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0') }

describe('bounded layer color grade raster', () => {
  it('keeps absent neutral and disabled calibration byte-identical across the legacy light color curves LUT and spatial pipeline', () => {
    const width = 13, height = 21, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at * 17 % 256, at * 7 % 256, at * 29 % 256, at % 7 ? at % 255 + 1 : 0]).flat())
    const calibration = defaultImageLayerColorCalibration(), detail = defaultImageLayerColorDetail(), presence = defaultImageLayerColorPresence(), table = invertTable()
    detail.sharpening.amount = 70; detail.luminance.amount = 80; detail.color.amount = 90
    presence.texture = 60; presence.clarity = 40; presence.dehaze = -30
    const old = defaultImageLayerColorGrade(); old.curves.red = [{ x: 0, y: .1 }, { x: 1, y: .8 }]; old.hsl.orange.hue = 30; old.colorGrading.shadows.saturation = 30
    for (const grade of [defaultImageLayerColorGrade(), { ...old, exposure: -.5, temperature: 6200, tint: 25, grain: 35, vignette: -40, lut: lutSelection(table) }, { ...old, detail, presence }]) {
      const expected = rasterizeLayerColorGrade({ data, width, height, grade, lutTable: table })
      for (const dormant of [calibration, { ...calibration, enabled: false, shadowTint: -100, redHue: 100, redSaturation: -100, greenHue: -100, greenSaturation: 100, blueHue: 100, blueSaturation: -100 }]) expect(rasterizeLayerColorGrade({ data, width, height, grade: { ...grade, calibration: dormant }, lutTable: table })).toEqual(expected)
    }
  })

  it.each(imageLayerColorCalibrationAmounts)('implements positive and negative native %s without changing alpha or transparent hidden colors', (key) => {
    const data = [123, 45, 67, 0, 115, 72, 41, 96, 64, 121, 87, 255, 43, 75, 132, 255, 75, 65, 72, 255]
    const positive = render(data, { calibration: { ...defaultImageLayerColorCalibration(), [key]: 60 } }), negative = render(data, { calibration: { ...defaultImageLayerColorCalibration(), [key]: -60 } })
    for (const actual of [positive, negative]) {
      expect(actual.slice(0, 4)).toEqual(data.slice(0, 4)); expect(actual.filter((_, at) => at % 4 === 3)).toEqual([0, 96, 255, 255, 255]); expect(actual).not.toEqual(data)
    }
    expect(positive).not.toEqual(negative)
  })

  it('preserves all byte grays under primary calibration and visibly tints only dark grays when explicitly requested', () => {
    const calibration = { ...defaultImageLayerColorCalibration(), redHue: 100, redSaturation: -100, greenHue: -100, greenSaturation: 100, blueHue: 100, blueSaturation: 100 }, input = Array.from({ length: 256 }, (_, byte) => [byte, byte, byte, 255]).flat()
    expect(render(input, { calibration })).toEqual(input)
    const result = render([0, 0, 0, 255, 40, 40, 40, 255, 235, 235, 235, 255, 255, 255, 255, 255], { calibration: { ...calibration, shadowTint: 80 } })
    expect(result.slice(0, 4)).toEqual([0, 0, 0, 255]); expect(result[4]).toBeGreaterThan(result[5]); expect(result[6]).toBeGreaterThan(result[5]); expect(result.slice(8)).toEqual([235, 235, 235, 255, 255, 255, 255, 255])
  })

  it('applies calibration immediately after IEC decoding and before exposure white balance and curves with a separately composed oracle', () => {
    const calibration = { ...defaultImageLayerColorCalibration(), redHue: 60, greenSaturation: -40, blueHue: 30, shadowTint: 20 }, transform = createLayerColorCalibrationTransform(calibration)
    const grade = { ...defaultImageLayerColorGrade(), calibration, exposure: .5, temperature: 6100, tint: 25 }; grade.curves.red = [{ x: 0, y: .05 }, { x: 1, y: .85 }]
    const input = [115, 72, 41, 96, 64, 121, 87, 255, 43, 75, 132, 255], expected: number[] = []
    function decode(byte: number) { const encoded = byte / 255; return encoded > .04045 ? ((encoded + .055) / 1.055) ** 2.4 : encoded / 12.92 }
    function encode(value: number) { const bounded = Math.min(1, Math.max(0, value)); return bounded > .0031308 ? 1.055 * bounded ** (1 / 2.4) - .055 : bounded * 12.92 }
    const warmth = Math.log(6100 / 5500) * .4, tint = 25 / 150 * .2, gains = [Math.exp(warmth + tint / 2), Math.exp(-tint), Math.exp(-warmth + tint / 2)]
    for (let at = 0; at < input.length; at += 4) {
      const calibrated = transform(decode(input[at]), decode(input[at + 1]), decode(input[at + 2]))
      for (let channel = 0; channel < 3; channel++) { const value = encode(calibrated[channel] * 2 ** .5 * gains[channel]); expected.push(Math.round((channel === 0 ? .05 + .8 * value : value) * 255)) }
      expected.push(input[at + 3])
    }
    expect(render(input, grade)).toEqual(expected)
    const exposedFirst = rasterizeLayerColorGrade({ data: new Uint8ClampedArray(render(input, { exposure: .5, temperature: 6100, tint: 25 })), width: 3, height: 1, grade: { ...defaultImageLayerColorGrade(), calibration } })
    expect([...exposedFirst]).not.toEqual(render(input, { ...grade, curves: defaultImageLayerColorGrade().curves }))
  })

  it('shares the calibrated point stage with LUT presence and detail before the old final effects', () => {
    const width = 17, height = 21, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at * 7 % 180 + 20, at * 3 % 170 + 20, at * 11 % 190 + 20, at % 13 ? 137 : 0]).flat())
    const calibration = { ...defaultImageLayerColorCalibration(), redHue: 70, blueSaturation: -45, shadowTint: 20 }, table = parseColorLutCube('TITLE "Calibration constant order"\nLUT_1D_SIZE 2\n0.4 0.5 0.6\n0.4 0.5 0.6'), detail = defaultImageLayerColorDetail(), presence = { ...defaultImageLayerColorPresence(), texture: 60, clarity: 40, dehaze: 30 }
    detail.sharpening.amount = 80; detail.luminance.amount = 70; detail.color.amount = 60
    const legacy = { ...defaultImageLayerColorGrade(), lut: lutSelection(table), presence, detail, grain: 30, vignette: -45 }
    expect(rasterizeLayerColorGrade({ data, width, height, grade: { ...legacy, calibration }, lutTable: table })).toEqual(rasterizeLayerColorGrade({ data, width, height, grade: legacy, lutTable: table }))
    const point = rasterizeLayerColorGrade({ data, width, height, grade: { ...defaultImageLayerColorGrade(), calibration } })
    const spatial = rasterizeLayerColorGrade({ data: point, width, height, grade: { ...defaultImageLayerColorGrade(), presence, detail } })
    const actual = rasterizeLayerColorGrade({ data, width, height, grade: { ...defaultImageLayerColorGrade(), calibration, presence, detail } })
    // The unified pipeline retains floating point precision between point and
    // spatial stages; a deliberately quantized intermediate is within 2 bytes.
    for (let at = 0; at < actual.length; at++) expect(Math.abs(actual[at] - spatial[at])).toBeLessThanOrEqual(at % 4 === 3 ? 0 : 2)
    expect(actual).not.toEqual(rasterizeLayerColorGrade({ data, width, height, grade: { ...defaultImageLayerColorGrade(), presence, detail } }))
  })

  it('keeps calibrated strips deterministic and interrupts before further tiles without mutating original bytes', () => {
    const width = 7, height = 35, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at % 256, at * 7 % 256, 160, at % 255 + 1]).flat()), before = data.slice()
    const grade = { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), greenHue: 60, redSaturation: 40, shadowTint: -30 }, grain: 35, vignette: -45 }
    const full = rasterizeLayerColorGrade({ data, width, height, grade }), prepared = createLayerColorGradeRasterizer(grade), parts = new Uint8ClampedArray(data.length)
    grade.calibration.greenHue = -100
    for (let top = 0; top < height; top += 3) {
      const rows = Math.min(3, height - top)
      for (const tile of prepared.steps({ data: data.slice(top * width * 4, (top + rows) * width * 4), width, height: rows, originY: top, spaceWidth: width, spaceHeight: height })) parts.set(tile.data, (top + tile.top) * width * 4)
    }
    expect(parts).toEqual(full); expect(data).toEqual(before)
    const controller = new AbortController(), steps = prepared.steps({ data, width, height, signal: controller.signal })
    expect(steps.next().value).toMatchObject({ top: 0, height: 16 }); controller.abort(); expect(() => steps.next()).toThrow(/取消/)
    expect(() => rasterizeLayerColorGrade({ data, width, height, grade, deadline: 0 })).toThrow(/超时/)
    expect(() => rasterizeLayerColorGrade({ data, width, height, grade, signal: controller.signal })).toThrow(/取消/)
  })

  it('keeps absent neutral and disabled presence byte-identical with old curves LUT detail grain and vignette', () => {
    const data = new Uint8ClampedArray(Array.from({ length: 13 * 21 }, (_, at) => [at * 17 % 256, at * 7 % 256, at * 29 % 256, at % 4 ? 137 : 0]).flat()), detail = defaultImageLayerColorDetail(), table = invertTable()
    detail.sharpening.amount = 70; detail.luminance.amount = 80; detail.color.amount = 90
    for (const extra of [{}, { detail }]) {
      const grade = { ...defaultImageLayerColorGrade(), exposure: -.5, temperature: 6200, grain: 35, vignette: -40, lut: lutSelection(table), ...extra }
      const old = rasterizeLayerColorGrade({ data, width: 13, height: 21, grade, lutTable: table })
      for (const presence of [defaultImageLayerColorPresence(), { ...defaultImageLayerColorPresence(), enabled: false, texture: 100, clarity: -100, dehaze: 100 }]) expect(rasterizeLayerColorGrade({ data, width: 13, height: 21, grade: { ...grade, presence }, lutTable: table })).toEqual(old)
    }
  })
  it('runs presence on point graded native pixels even without detail and rejects subsampled neighborhoods', () => {
    const width = 23, height = 37, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at * 7 % 180 + 20, at * 3 % 170 + 20, at * 11 % 190 + 20, at % 13 ? 255 : 0]).flat())
    const presence = { ...defaultImageLayerColorPresence(), texture: 60, clarity: 40, dehaze: 30 }, table = invertTable()
    const inverted = data.map((value, at) => at % 4 === 3 || !data[Math.floor(at / 4) * 4 + 3] ? value : 255 - value)
    const grade = { ...defaultImageLayerColorGrade(), presence, lut: lutSelection(table) }, actual = rasterizeLayerColorGrade({ data, width, height, grade, lutTable: table })
    expect(actual).toEqual(rasterizeLayerColorPresence({ data: inverted, width, height, presence }))
    expect(actual).not.toEqual(data)
    expect(() => rasterizeLayerColorGrade({ data, width, height, grade, lutTable: table, stepX: 2 })).toThrow(/原生/)
    const controller = new AbortController(), steps = rasterizeLayerColorGradeSteps({ data, width, height, grade, lutTable: table, signal: controller.signal })
    expect(steps.next().value).toMatchObject({ top: 0, height: 4 }); controller.abort(); expect(() => steps.next()).toThrow(/取消/)
  })
  it('composes LUT then atmospheric presence then detail then native vignette with a constant-field physical oracle', () => {
    const width = 17, height = 21, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at * 7 % 250, at * 3 % 250, at * 13 % 250, at % 11 ? 255 : 0]).flat())
    const table = parseColorLutCube('TITLE "Physical order"\nLUT_1D_SIZE 2\n0.4 0.5 0.6\n0.4 0.5 0.6'), detail = defaultImageLayerColorDetail()
    detail.luminance.amount = 80; detail.color.amount = 90; detail.sharpening.amount = 110
    const presence = { ...defaultImageLayerColorPresence(), texture: 70, clarity: 60, dehaze: 50 }
    const grade = { ...defaultImageLayerColorGrade(), lut: lutSelection(table), presence, detail, vignette: -60 }
    const actual = rasterizeLayerColorGrade({ data, width, height, grade, lutTable: table }), transmission = 1 - .5 * (.08 + .72 * .4)
    function smooth(value: number) { const bounded = Math.min(1, Math.max(0, value)); return bounded * bounded * (3 - 2 * bounded) }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      if (!data[at + 3]) { expect(actual.slice(at, at + 4)).toEqual(data.slice(at, at + 4)); continue }
      const distance = Math.hypot((x + .5 - width / 2) / (width / 2), (y + .5 - height / 2) / (height / 2)) / Math.SQRT2, vignette = -.6 * smooth((distance - .25) / .75)
      for (let c = 0; c < 3; c++) {
        const atmospheric = 1 + ([.4, .5, .6][c] - 1) / transmission
        expect(Math.abs(actual[at + c] - Math.round(atmospheric * (1 + vignette) * 255))).toBeLessThanOrEqual(1)
      }
    }
  })
  it('keeps absent, disabled and zero-amount detail byte-identical under old grades and active LUTs', () => {
    const data = new Uint8ClampedArray(Array.from({ length: 77 }, (_, at) => [at * 17 % 256, at * 7 % 256, 90, at % 4 ? 123 : 0]).flat()), detail = defaultImageLayerColorDetail(), table = invertTable(), grade = { ...defaultImageLayerColorGrade(), exposure: .5, temperature: 6300, grain: 20, vignette: -30, lut: lutSelection(table) }
    const expected = rasterizeLayerColorGrade({ data, width: 7, height: 11, grade, lutTable: table })
    detail.sharpening.radius = 3; detail.color.detail = 100
    for (const dormant of [detail, { ...detail, enabled: false, color: { ...detail.color, amount: 100 } }]) expect(rasterizeLayerColorGrade({ data, width: 7, height: 11, grade: { ...grade, detail: dormant }, lutTable: table })).toEqual(expected)
  })
  it('runs native spatial detail after the LUT and before spatial grain and vignette', () => {
    const width = 9, height = 21, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at * 11 % 180 + 20, at * 3 % 140 + 30, at * 7 % 120 + 60, at % 13 ? 255 : 0]).flat()), detail = defaultImageLayerColorDetail(), table = invertTable()
    detail.color.amount = 80; detail.luminance.amount = 70; detail.sharpening.amount = 50
    const inverted = data.map((value, at) => at % 4 === 3 || !data[Math.floor(at / 4) * 4 + 3] ? value : 255 - value)
    const actual = rasterizeLayerColorGrade({ data, width, height, grade: { ...defaultImageLayerColorGrade(), lut: lutSelection(table), detail }, lutTable: table })
    expect(actual).toEqual(rasterizeLayerColorDetail({ data: inverted, width, height, detail }))
    const constant = parseColorLutCube('TITLE "Owned detail red"\nLUT_1D_SIZE 2\n1 0 0\n1 0 0'), solid = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => data[at * 4 + 3] ? [255, 0, 0, data[at * 4 + 3]] : [...data.slice(at * 4, at * 4 + 4)]).flat()), effects = { grain: 65, vignette: -70 }
    const expected = rasterizeLayerColorGrade({ data: solid, width, height, grade: { ...defaultImageLayerColorGrade(), ...effects } })
    expect(rasterizeLayerColorGrade({ data, width, height, grade: { ...defaultImageLayerColorGrade(), ...effects, detail, lut: lutSelection(constant) }, lutTable: constant })).toEqual(expected)
  })
  it('rejects subsampled spatial detail and cancels between bounded detail tiles', () => {
    const detail = defaultImageLayerColorDetail(); detail.luminance.amount = 80
    const input = { data: new Uint8ClampedArray(23 * 37 * 4).fill(130), width: 23, height: 37, grade: { ...defaultImageLayerColorGrade(), detail } }
    expect(() => rasterizeLayerColorGrade({ ...input, stepX: 2, stepY: 2 })).toThrow(/原生/)
    const controller = new AbortController(), steps = rasterizeLayerColorGradeSteps({ ...input, signal: controller.signal })
    expect(steps.next().value).toMatchObject({ top: 0, height: 4 }); controller.abort()
    expect(() => steps.next()).toThrow(/取消/)
  })
  it('preserves every byte at neutral including hidden transparent RGB and fractional alpha', () => {
    const input = Array.from({ length: 256 }, (_, x) => [x, 255 - x, x * 13 % 256, x]).flat()
    expect(render(input)).toEqual(input)
  })
  it.each([-4, -1, .5, 1, 4])('matches an independent IEC sRGB exposure oracle at %s stops', (exposure) => {
    // IEC 61966-2-1 transfer constants, independently expressed without kernel helpers.
    function oracle(byte: number) {
      const encoded = byte / 255
      const linear = encoded > .04045 ? Math.pow((encoded + .055) / 1.055, 2.4) : encoded / 12.92
      const exposed = Math.min(1, Math.max(0, linear * Math.pow(2, exposure)))
      const srgb = exposed > .0031308 ? 1.055 * Math.pow(exposed, 1 / 2.4) - .055 : exposed * 12.92
      return Math.round(srgb * 255)
    }
    const input = Array.from({ length: 256 }, (_, value) => [value, 255 - value, value, 255]).flat(), output = render(input, { exposure })
    expect(output).toEqual(input.map((value, index) => index % 4 === 3 ? value : oracle(value)))
  })
  it('applies master and channel curves in order with an independent constant and piecewise oracle', () => {
    const grade = defaultImageLayerColorGrade()
    grade.curves.rgb = [{ x: 0, y: .2 }, { x: .5, y: .8 }, { x: 1, y: .4 }]
    grade.curves.red = [{ x: 0, y: 1 }, { x: 1, y: 0 }]
    const input = [0, 64, 128, 37, 255, 255, 255, 255]
    function master(byte: number) { const x = byte / 255; return x <= .5 ? .2 + 1.2 * x : 1.2 - .8 * x }
    expect(render(input, grade)).toEqual(input.map((value, index) => index % 4 === 3 ? value : Math.round((index % 4 === 0 ? 1 - master(value) : master(value)) * 255)))
    expect(layerColorCurveValue(grade.curves.rgb, .5)).toBe(.8)
  })
  it('preserves alpha and transparent RGB under a combined nonneutral grade', () => {
    const grade = defaultImageLayerColorGrade()
    Object.assign(grade, { exposure: 1, temperature: 6500, tint: 15, grain: 40, vignette: -50, blackWhite: true })
    const result = render([123, 45, 67, 0, 120, 80, 30, 127, 40, 70, 160, 255], grade)
    expect(result.slice(0, 4)).toEqual([123, 45, 67, 0])
    expect([result[3], result[7], result[11]]).toEqual([0, 127, 255])
    expect(result[4]).toBe(result[5]); expect(result[5]).toBe(result[6])
  })
  it('changes only the requested HSL hue family and keeps the red wrap continuous', () => {
    const grade = defaultImageLayerColorGrade(); grade.hsl.red = { hue: 100, saturation: -100, luminance: 0 }
    expect(render([255, 0, 0, 255, 0, 255, 255, 255], grade)).toEqual([128, 128, 128, 255, 0, 255, 255, 255])
    const wrap = render([255, 0, 1, 255, 255, 1, 0, 255], grade)
    expect(Math.abs(wrap[0] - wrap[4])).toBeLessThanOrEqual(1)
  })
  it('makes temperature warmer and positive tint more magenta while preserving black and white bounds', () => {
    const warm = render([128, 128, 128, 255], { temperature: 6500 })
    expect(warm[0]).toBeGreaterThan(warm[2])
    const tint = render([128, 128, 128, 255], { tint: 150 })
    expect(tint[0]).toBeGreaterThan(tint[1]); expect(tint[2]).toBeGreaterThan(tint[1])
  })
  it.each(['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation', 'vignette', 'grain'] as const)('implements %s as real pixel changes', (key) => {
    const input = Array.from({ length: 16 }, (_, index) => [10 + index * 15, 20 + index * 15, 25 + index * 15, 255]).flat()
    expect(render(input, { [key]: 80 }, 4)).not.toEqual(input)
  })
  it('implements independent split toning luminance and tint', () => {
    const grade = defaultImageLayerColorGrade(); grade.colorGrading.shadows = { hue: 240, saturation: 80, luminance: 10 }
    const result = render([30, 30, 30, 255, 240, 240, 240, 255], grade)
    expect(result[2]).toBeGreaterThan(result[0]); expect(result[3]).toBe(255)
  })
  it('reproduces seeded grain and vignette across independently processed row tiles', () => {
    const width = 7, height = 35, data = new Uint8ClampedArray(Array.from({ length: width * height }, () => [100, 130, 160, 111]).flat())
    const grade = { ...defaultImageLayerColorGrade(), grain: 100, vignette: -70 }
    const full = rasterizeLayerColorGrade({ data, width, height, grade }), parts = new Uint8ClampedArray(data.length)
    for (let top = 0; top < height; top += 3) {
      const rows = Math.min(3, height - top)
      parts.set(rasterizeLayerColorGrade({ data: data.slice(top * width * 4, (top + rows) * width * 4), width, height: rows, originY: top, spaceWidth: width, spaceHeight: height, grade }), top * width * 4)
    }
    expect(parts).toEqual(full)
    expect(rasterizeLayerColorGrade({ data, width, height, grade })).toEqual(full)
    expect(data[0]).toBe(100)
  })
  it('keeps vignette and grain attached to layer coordinates after output translation', () => {
    const data = new Uint8ClampedArray(Array.from({ length: 64 }, () => [100, 130, 160, 255]).flat()), grade = { ...defaultImageLayerColorGrade(), grain: 60, vignette: -80 }
    const native = rasterizeLayerColorGrade({ data, width: 8, height: 8, grade })
    const translated = rasterizeLayerColorGrade({ data, width: 8, height: 8, grade, originX: 50, originY: 35, spaceWidth: 8, spaceHeight: 8, pixelToLayer: { a: 1, b: 0, c: 0, d: 1, e: -50, f: -35 } })
    expect(translated).toEqual(native)
    expect(() => rasterizeLayerColorGrade({ data, width: 8, height: 8, grade, pixelToLayer: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } })).toThrow('空间变换')
  })
  it('rejects unsafe capacity and interrupts between bounded tiles without mutating input', () => {
    const data = new Uint8ClampedArray(4 * 20 * 20).fill(90), before = data.slice(), controller = new AbortController()
    const steps = rasterizeLayerColorGradeSteps({ data, width: 20, height: 20, grade: { ...defaultImageLayerColorGrade(), exposure: 1 }, signal: controller.signal })
    expect(steps.next().value).toMatchObject({ top: 0, height: 16 })
    controller.abort(); expect(() => steps.next()).toThrow('取消')
    expect(data).toEqual(before)
    expect(() => rasterizeLayerColorGrade({ data, width: 10000, height: 20, grade: defaultImageLayerColorGrade() })).toThrow('安全容量')
    expect(() => rasterizeLayerColorGrade({ data, width: 20, height: 20, grade: defaultImageLayerColorGrade(), deadline: 0 })).toThrow('超时')
  })

  it.each([0, 50, 100])('applies a real inverse LUT at %i percent and preserves every alpha and transparent hidden RGB byte', (strength) => {
    const table = invertTable(), input = [0, 64, 255, 255, 180, 21, 99, 127, 123, 45, 67, 0]
    const actual = rasterizeLayerColorGrade({ data: new Uint8ClampedArray(input), width: 3, height: 1, grade: { ...defaultImageLayerColorGrade(), lut: lutSelection(table, strength) }, lutTable: table })
    expect([...actual]).toEqual(input.map((value, at) => at % 4 === 3 || at >= 8 ? value : Math.round(value * (1 - strength / 100) + (255 - value) * strength / 100)))
  })

  it('preserves every original RGBA byte under an active identity LUT', () => {
    const table = parseColorLutCube('TITLE "Owned identity"\nLUT_1D_SIZE 2\n0 0 0\n1 1 1')
    const input = new Uint8ClampedArray(Array.from({ length: 256 }, (_, value) => [value, 255 - value, value * 37 % 256, value]).flat())
    expect(rasterizeLayerColorGrade({ data: input, width: 256, height: 1, grade: { ...defaultImageLayerColorGrade(), lut: lutSelection(table) }, lutTable: table })).toEqual(input)
  })

  it('honors asymmetric resource domains with an independent integer pixel oracle', () => {
    const table = parseColorLutCube('TITLE "Owned domains"\nDOMAIN_MIN -1 0 -2\nDOMAIN_MAX 3 2 2\nLUT_1D_SIZE 2\n0 0 0\n1 1 1')
    expect([...rasterizeLayerColorGrade({ data: new Uint8ClampedArray([64, 128, 192, 127]), width: 1, height: 1, grade: { ...defaultImageLayerColorGrade(), lut: lutSelection(table) }, lutTable: table })]).toEqual([80, 64, 176, 127])
  })

  it('keeps disabled and zero-strength custom selections byte-exact without requesting or validating a table', () => {
    const table = invertTable(), data = new Uint8ClampedArray([50, 130, 210, 111, 200, 100, 20, 0]), base = { ...defaultImageLayerColorGrade(), exposure: .5, temperature: 6300, grain: 20, vignette: -30 }
    const original = rasterizeLayerColorGrade({ data, width: 2, height: 1, grade: base })
    for (const lut of [lutSelection(table, 0), lutSelection(table, 100, false)]) expect(rasterizeLayerColorGrade({ data, width: 2, height: 1, grade: { ...base, lut } })).toEqual(original)
  })

  it('prepares builtin LUTs without a custom resource and treats a LUT-only grade as nonneutral', () => {
    const presetId = 'xm-lut-cool-tone-v1', grade = { ...defaultImageLayerColorGrade(), lut: { version: 1 as const, enabled: true, strength: 100, source: { kind: 'builtin' as const, presetId } } }, input = [100, 130, 160, 255]
    const expected = createColorLutSampler(createLayerColorLutPreset(presetId), { enabled: true, strength: 100 }).sample(100 / 255, 130 / 255, 160 / 255)
    expect(render(input, grade)).toEqual([...expected.map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255)), 255])
    expect(render(input, grade)).not.toEqual(input)
  })

  it('fails before producing pixels when an active custom table is missing, mismatched or malformed', () => {
    const table = invertTable(), grade = { ...defaultImageLayerColorGrade(), lut: lutSelection(table) }, input = { data: new Uint8ClampedArray([10, 20, 30, 255]), width: 1, height: 1, grade }
    expect(() => rasterizeLayerColorGrade(input)).toThrow(/资源尚未准备/)
    for (const lutTable of [{ ...table, name: 'Other' }, { ...table, domainMin: [-1, 0, 0] as [number, number, number] }, { ...table, domainMax: [2, 1, 1] as [number, number, number] }, { ...table, data: new Float32Array(3) }]) expect(() => rasterizeLayerColorGrade({ ...input, lutTable })).toThrow(/LUT/)
    expect([...input.data]).toEqual([10, 20, 30, 255])
  })

  it('runs LUT after black-and-white and before the existing spatial vignette and grain stages', () => {
    const table = parseColorLutCube('TITLE "Owned constant red"\nLUT_1D_SIZE 2\n1 0 0\n1 0 0'), input = Array.from({ length: 9 }, () => [30, 180, 240, 255]).flat(), red = Array.from({ length: 9 }, () => [255, 0, 0, 255]).flat(), effects = { grain: 45, vignette: -90 }
    const actual = rasterizeLayerColorGrade({ data: new Uint8ClampedArray(input), width: 3, height: 3, grade: { ...defaultImageLayerColorGrade(), blackWhite: true, ...effects, lut: lutSelection(table) }, lutTable: table })
    expect([...actual]).toEqual(render(red, effects, 3))
    expect([...rasterizeLayerColorGrade({ data: new Uint8ClampedArray(input), width: 3, height: 3, grade: { ...defaultImageLayerColorGrade(), blackWhite: true, lut: lutSelection(table) }, lutTable: table })]).toEqual(red)
  })

  it('freezes the LUT only once per replay and matches strips, native coordinates and cancellation', () => {
    const table = invertTable(), width = 7, height = 35, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at % 256, at * 7 % 256, 160, at % 255 + 1]).flat()), before = data.slice(), grade = { ...defaultImageLayerColorGrade(), grain: 35, vignette: -45, lut: lutSelection(table) }
    const full = rasterizeLayerColorGrade({ data, width, height, grade, lutTable: table }), prepared = createLayerColorGradeRasterizer(grade, { lutTable: table }), parts = new Uint8ClampedArray(data.length)
    table.data.fill(0)
    for (let top = 0; top < height; top += 3) {
      const rows = Math.min(3, height - top)
      for (const tile of prepared.steps({ data: data.slice(top * width * 4, (top + rows) * width * 4), width, height: rows, originY: top, spaceWidth: width, spaceHeight: height })) parts.set(tile.data, (top + tile.top) * width * 4)
    }
    expect(parts).toEqual(full); expect(data).toEqual(before)
    const controller = new AbortController(), steps = prepared.steps({ data, width, height, signal: controller.signal })
    expect(steps.next().value).toMatchObject({ top: 0, height: 16 })
    controller.abort(); expect(() => steps.next()).toThrow(/取消/)
    expect(() => rasterizeLayerColorGrade({ data, width, height, grade, lutTable: invertTable(), signal: controller.signal })).toThrow(/取消/)
    expect(() => rasterizeLayerColorGrade({ data, width, height, grade, lutTable: invertTable(), deadline: 0 })).toThrow(/超时/)
  })
})
