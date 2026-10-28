import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorDetail } from './layer-color-detail'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'
import { defaultImageLayerColorGrade, parseImageLayerColorGrade } from './layer-color-grade'
import { addColorCurvePoint, buildColorGradeHistogram, maximumColorGradePresetBytes, moveColorCurvePoint, parseColorGradePreset, previewColorGrade, removeColorCurvePoint, resetColorGradeSection, sampleColorGradePixels, serializeColorGradePreset } from './layer-color-grade-editor-state'

describe('color grade workbench state and local presets', () => {
  it('resets and hides only calibration without changing dormant values, presence, detail or other sections', () => {
    const grade = { ...defaultImageLayerColorGrade(), exposure: 1, calibration: { ...defaultImageLayerColorCalibration(), enabled: false, shadowTint: 25, redHue: 40 }, presence: { version: 1 as const, enabled: true, texture: 60, clarity: 40, dehaze: 30 }, detail: defaultImageLayerColorDetail() }, original = structuredClone(grade)
    const reset = resetColorGradeSection(grade, 'calibration')
    const { calibration: _removed, ...other } = grade
    expect(reset.calibration).toBeUndefined(); expect(reset).toEqual(other)
    expect(previewColorGrade(grade, ['calibration'], false)).toEqual(reset)
    expect(resetColorGradeSection(grade, 'effects').calibration).toEqual(grade.calibration)
    expect(resetColorGradeSection(grade, 'detail').calibration).toEqual(grade.calibration)
    expect(previewColorGrade(grade, [], true)).toEqual(defaultImageLayerColorGrade()); expect(grade).toEqual(original)
  })
  it.each([undefined, null, false, 0, {}, defaultImageLayerColorCalibration()])('refuses any calibration presence in a version one preset: %j', (calibration) => {
    const settings = { ...defaultImageLayerColorGrade(), calibration }
    expect(() => serializeColorGradePreset('旧格式', settings)).toThrow('版本 1 预设不能携带校准')
    if (calibration !== undefined) expect(() => parseColorGradePreset(JSON.stringify({ format: 'xingmang-layer-color-grade', version: 1, name: '旧格式', settings }))).toThrow('版本 1 预设不能携带校准')
  })
  it('temporarily hides and resets all effect parameters without changing the original presence or other sections', () => {
    const grade = { ...defaultImageLayerColorGrade(), exposure: 1, grain: 12, vignette: -25, presence: { version: 1 as const, enabled: false, texture: 60, clarity: -40, dehaze: 30 } }, before = structuredClone(grade)
    const hidden = previewColorGrade(grade, ['effects'], false)
    expect(hidden.presence).toBeUndefined(); expect(hidden).toMatchObject({ exposure: 1, grain: 0, vignette: 0 })
    expect(resetColorGradeSection(grade, 'light').presence).toEqual(grade.presence)
    expect(grade).toEqual(before); expect(previewColorGrade(grade, [], true)).toEqual(defaultImageLayerColorGrade())
  })
  it.each([null, false, 0, {}, { version: 1, enabled: false, texture: 0, clarity: 0, dehaze: 0 }])('refuses any presence in the legacy version one preset instead of stripping it: %j', (presence) => {
    const settings = { ...defaultImageLayerColorGrade(), presence }
    expect(() => serializeColorGradePreset('旧格式', settings)).toThrow('版本 1 预设不能携带质感与去雾')
    expect(() => parseColorGradePreset(JSON.stringify({ format: 'xingmang-layer-color-grade', version: 1, name: '旧格式', settings }))).toThrow('版本 1 预设不能携带质感与去雾')
  })
  it('resets only the chosen section and bypasses sections without changing the stored draft', () => {
    const grade = { ...defaultImageLayerColorGrade(), exposure: 1, temperature: 7600, grain: 12 }
    const reset = resetColorGradeSection(grade, 'light'); expect(reset.exposure).toBe(0); expect(reset.temperature).toBe(7600); expect(reset.grain).toBe(12)
    expect(previewColorGrade(grade, ['color', 'effects'], false)).toMatchObject({ exposure: 1, temperature: 5500, grain: 0 })
    expect(previewColorGrade(grade, [], true)).toEqual(defaultImageLayerColorGrade()); expect(grade).toMatchObject({ temperature: 7600, grain: 12 })
  })
  it('resets and temporarily hides only LUT while preserving the editable draft and other grading sections', () => {
    const grade = { ...defaultImageLayerColorGrade(), exposure: 1, lut: { version: 1 as const, enabled: false, strength: 0, source: { kind: 'builtin' as const, presetId: 'xm-lut-movie-tone-v1' } } }, before = structuredClone(grade)
    expect(resetColorGradeSection(grade, 'lut')).toEqual({ ...defaultImageLayerColorGrade(), exposure: 1 })
    expect(previewColorGrade(grade, ['lut'], false).lut).toBeUndefined()
    expect(previewColorGrade(grade, ['light'], false).lut).toEqual(grade.lut)
    expect(grade).toEqual(before)
  })
  it('resets and temporarily hides detail without mutating dormant values or other sections', () => {
    const grade = { ...defaultImageLayerColorGrade(), exposure: .5, detail: { ...defaultImageLayerColorDetail(), enabled: false } }
    grade.detail.sharpening.detail = 73
    const before = structuredClone(grade)
    expect(resetColorGradeSection(grade, 'detail')).toEqual({ ...defaultImageLayerColorGrade(), exposure: .5 })
    expect(previewColorGrade(grade, ['detail'], false).detail).toBeUndefined()
    expect(previewColorGrade(grade, ['light'], false).detail).toEqual(grade.detail)
    expect(previewColorGrade(grade, [], true).detail).toBeUndefined(); expect(grade).toEqual(before)
  })
  it.each([undefined, null, false, 0, {}, defaultImageLayerColorDetail()])('rejects any detail presence in the legacy version-one preset: %j', (detail) => {
    const settings = { ...defaultImageLayerColorGrade(), detail }
    expect(() => serializeColorGradePreset('旧格式', settings)).toThrow('版本 1 预设不能携带细节与降噪')
    if (detail !== undefined) expect(() => parseColorGradePreset(JSON.stringify({ format: 'xingmang-layer-color-grade', version: 1, name: '旧格式', settings }))).toThrow('版本 1 预设不能携带细节与降噪')
  })
  it('adds sorted points, preserves endpoint positions, and keeps close imported points strictly ordered', () => {
    const original = [{ x: 0, y: 0 }, { x: 1, y: 1 }], middle = addColorCurvePoint(original, { x: .5, y: .3 })
    expect(middle.index).toBe(1); expect(original).toHaveLength(2)
    expect(moveColorCurvePoint(middle.points, 0, { x: .4, y: 2 })[0]).toEqual({ x: 0, y: 1 })
    const moved = moveColorCurvePoint(middle.points, 1, { x: 2, y: -.5 }); expect(moved[1]).toEqual({ x: .9999, y: 0 })
    const tight = [{ x: 0, y: 0 }, { x: .5, y: .3 }, { x: .50001, y: .4 }, { x: .50002, y: .5 }, { x: 1, y: 1 }]
    const grade = defaultImageLayerColorGrade(); grade.curves.rgb = moveColorCurvePoint(tight, 2, { x: .9, y: .7 })
    expect(() => parseImageLayerColorGrade(grade)).not.toThrow()
    expect(removeColorCurvePoint(middle.points, 0)).toEqual(middle.points); expect(removeColorCurvePoint(middle.points, 1)).toEqual(original)
    expect(addColorCurvePoint(middle.points, { x: .5, y: .9 }).points).toEqual(middle.points)
    expect(() => addColorCurvePoint(Array.from({ length: 16 }, (_, index) => ({ x: index / 15, y: index / 15 })), { x: .55, y: .6 })).toThrow('16')
  })
  it('round-trips only the supported named configuration and rejects foreign, oversized and malformed presets', () => {
    const grade = { ...defaultImageLayerColorGrade(), exposure: 1.35, tint: -110 }
    const serialized = serializeColorGradePreset('  产品柔光  ', grade)
    expect(parseColorGradePreset(serialized)).toEqual({ name: '产品柔光', settings: grade })
    const preset = JSON.parse(serialized)
    for (const value of [{ ...preset, assetId: 'a' }, { ...preset, version: 2 }, { ...preset, settings: { ...grade, endpoint: 'https://example.com' } }, { ...preset, settings: { ...grade, exposure: 5 } }, { ...preset, name: '\u0000name' }]) expect(() => parseColorGradePreset(JSON.stringify(value))).toThrow()
    expect(() => parseColorGradePreset('not-json')).toThrow('JSON'); expect(() => parseColorGradePreset(' '.repeat(maximumColorGradePresetBytes + 1))).toThrow('64 KiB')
    expect(() => serializeColorGradePreset('', grade)).toThrow()
  })
  it.each([undefined, null, false, {}, { version: 1, enabled: false, strength: 0, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } }])('refuses any LUT presence in legacy pure version-one serialization: %j', (lut) => {
    expect(() => serializeColorGradePreset('不可移植裸引用', { ...defaultImageLayerColorGrade(), lut })).toThrow('版本 1 预设不能携带 LUT')
    if (lut !== undefined) expect(() => parseColorGradePreset(JSON.stringify({ format: 'xingmang-layer-color-grade', version: 1, name: '旧裸引用', settings: { ...defaultImageLayerColorGrade(), lut } }))).toThrow('版本 1 预设不能携带 LUT')
  })
  it('bounds cached histogram samples while preserving the sampled original coordinates', () => {
    const width = 1024, height = 512, data = new Uint8ClampedArray(width * height * 4)
    for (let index = 0; index < width * height; index++) { data[index * 4] = index % 256; data[index * 4 + 3] = 255 }
    const sample = sampleColorGradePixels({ data, width, height })
    expect(sample).toMatchObject({ width: 256, height: 128, spaceWidth: width, spaceHeight: height, stepX: 4, stepY: 4 })
    expect(sample.data.length).toBe(256 * 128 * 4); expect(sample.data[4]).toBe(data[16]); expect(sample.data).not.toBe(data)
    expect(() => sampleColorGradePixels({ data, width: 5000, height: 512 })).toThrow()
  })
  it('computes real alpha-weighted channel distributions and excludes fully transparent pixels', () => {
    const histogram = buildColorGradeHistogram(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]))
    expect(histogram.pixels).toBe(2); expect(histogram.red[63]).toBe(1); expect(histogram.green[63]).toBeCloseTo(128 / 255); expect(histogram.blue[63]).toBe(0)
    expect(histogram.luminance.reduce((a, b) => a + b)).toBeCloseTo(1 + 128 / 255)
  })
})
