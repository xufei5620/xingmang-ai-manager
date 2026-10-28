import { describe, expect, it } from 'vitest'
import { assertColorGradeCalibrationClientVersion, assertColorGradeCalibrationPlacement, graphHasColorGradeCalibration, projectHasColorGradeCalibration } from './color-calibration-contract'

function data(calibration: unknown, nested: boolean) { const imageTransform = { kind: 'layer', layers: [{ colorGrade: { version: 1, calibration } }] }; return nested ? { settings: { imageTransform } } : { imageTransform } }
describe('color calibration capability and canonical placement', () => {
  it.each([undefined, null, false, 0, {}, { version: 2 }, { version: 1, enabled: false, shadowTint: 0, redHue: -12, redSaturation: 7, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0 }])('detects explicit calibration %j independently of validity or neutrality', (calibration) => {
    for (const nested of [true, false]) {
      const graph = { nodes: [{ kind: 'image-layer', data: data(calibration, nested) }] }
      expect(graphHasColorGradeCalibration(graph)).toBe(true)
      expect(projectHasColorGradeCalibration(JSON.stringify(graph))).toBe(calibration !== undefined)
      for (const capability of [undefined, null, false, 0, true, '1', 2]) expect(() => assertColorGradeCalibrationClientVersion(capability, true)).toThrow('刷新')
      expect(() => assertColorGradeCalibrationClientVersion(1, true)).not.toThrow()
    }
  })
  it('does not confuse prose, presence, detail, LUT or whole-filter parameters with calibration', () => {
    const graph = { nodes: [{ data: { prompt: 'calibration colorGradeCalibrationVersion', settings: { imageTransform: { kind: 'layer', layers: [{ colorGrade: { version: 1, detail: null, lut: null, presence: null } }], edits: { filter: { calibration: 12, detail: 50 } } } } } }] }
    expect(graphHasColorGradeCalibration(graph)).toBe(false)
    expect(() => assertColorGradeCalibrationClientVersion(undefined, false)).not.toThrow()
    expect(() => projectHasColorGradeCalibration('{')).toThrow()
  })
  it.each([null, { version: 2 }, { version: 1, enabled: false, shadowTint: 0, redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0 }])('rejects every raw wrong location before projection: %j', (calibration) => {
    expect(() => assertColorGradeCalibrationPlacement('image-layer', data(calibration, true), 'workflow')).not.toThrow()
    expect(() => assertColorGradeCalibrationPlacement('image-layer', data(calibration, false), 'run')).not.toThrow()
    expect(() => assertColorGradeCalibrationPlacement('image-layer', data(calibration, false), 'workflow')).toThrow('正确配置位置')
    expect(() => assertColorGradeCalibrationPlacement('image-layer', data(calibration, true), 'run')).toThrow('正确配置位置')
    expect(() => assertColorGradeCalibrationPlacement('note', data(calibration, true), 'workflow')).toThrow()
    expect(() => assertColorGradeCalibrationPlacement('note', data(calibration, false), 'run')).toThrow()
    expect(() => assertColorGradeCalibrationPlacement('image-layer', { ...data(calibration, true), ...data(calibration, false) }, 'workflow')).toThrow()
    expect(() => assertColorGradeCalibrationPlacement('image-layer', { ...data(calibration, true), ...data(calibration, false) }, 'run')).toThrow()
  })
})
