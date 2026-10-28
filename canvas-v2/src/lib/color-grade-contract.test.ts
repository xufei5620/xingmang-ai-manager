import { describe, expect, it } from 'vitest'
import { assertColorGradeClientVersion, graphHasColorGrade, projectHasColorGrade } from './color-grade-contract'

describe('color grade client capability', () => {
  it.each([null, {}, { version: 1 }, false, 'invalid'])('protects explicit layer settings including malformed %j', (colorGrade) => {
    const imageTransform = { kind: 'layer', layers: [{ colorGrade }] }
    expect(projectHasColorGrade(JSON.stringify({ nodes: [{ kind: 'image-layer', data: { settings: { imageTransform } } }] }))).toBe(true)
    expect(graphHasColorGrade({ nodes: [{ kind: 'image-layer', data: { imageTransform } }] })).toBe(true)
  })
  it('does not mistake a prompt, unrelated settings or legacy adjustments for color processing', () => {
    expect(graphHasColorGrade({ nodes: [{ data: { prompt: 'colorGrade', settings: { colorGrade: true, imageTransform: { kind: 'layer', layers: [{ adjustments: { brightness: 2 } }] } } } }] })).toBe(false)
    expect(graphHasColorGrade({ nodes: [] })).toBe(false)
  })
  it('requires the exact capability for new semantics and preserves legacy use', () => {
    for (const version of [undefined, null, false, true, '1', 0, 2]) expect(() => assertColorGradeClientVersion(version, true)).toThrow('刷新')
    expect(() => assertColorGradeClientVersion(1, true)).not.toThrow()
    expect(() => assertColorGradeClientVersion(undefined, false)).not.toThrow()
  })
})
