import { describe, expect, it } from 'vitest'
import { assertColorGradeDetailClientVersion, graphHasColorGradeDetail, projectHasColorGradeDetail } from './color-detail-contract'
import { graphHasColorLut } from './color-lut-contract'

describe('color detail capability presence', () => {
  it.each([null, false, 0, {}, { version: 2 }, { version: 1, enabled: false }, { version: 1, enabled: true, amount: 0 }])('detects explicit detail %j in both persisted workflow and canonical run fields', (detail) => {
    for (const nested of [false, true]) {
      const recipe = { layers: [{ colorGrade: { version: 1, detail } }] }, data = nested ? { settings: { imageTransform: recipe } } : { imageTransform: recipe }, graph = { nodes: [{ data }] }
      expect(graphHasColorGradeDetail(graph)).toBe(true)
      expect(projectHasColorGradeDetail(JSON.stringify(graph))).toBe(true)
      expect(graphHasColorLut(graph)).toBe(false)
      for (const version of [undefined, null, false, 0, 2, '1']) expect(() => assertColorGradeDetailClientVersion(version, true)).toThrow('刷新')
      expect(() => assertColorGradeDetailClientVersion(1, true)).not.toThrow()
    }
  })
  it('keeps LUT traversal and legacy no-detail inputs independent without prose matches', () => {
    const graph = { nodes: [{ data: { prompt: 'detail colorGradeDetailVersion', settings: { imageTransform: { layers: [{ colorGrade: { version: 1, lut: null } }] } } } }] }
    expect(graphHasColorLut(graph)).toBe(true); expect(graphHasColorGradeDetail(graph)).toBe(false)
    for (const value of [null, [], {}, { nodes: null }, { nodes: [null, { data: false }] }, graph]) expect(graphHasColorGradeDetail(value)).toBe(false)
    expect(graphHasColorGradeDetail({ nodes: [{ data: { detail: { version: 1 }, settings: { imageTransform: { kind: 'whole-filter', filter: { kind: 'usm', detail: 80 }, layers: [{ colorGrade: { version: 1 } }] } } } }] })).toBe(false)
    expect(() => assertColorGradeDetailClientVersion(undefined, false)).not.toThrow()
    expect(() => projectHasColorGradeDetail('{')).toThrow()
  })
})
