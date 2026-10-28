import { describe, expect, it } from 'vitest'
import { assertLiquifyClientVersion, graphHasLiquify, projectHasLiquify } from './liquify-contract'

describe('liquify client capability', () => {
  it.each([undefined, null, 1, 2, false, '1'])('protects explicit ordered operations even with malformed version %j', (version) => {
    const imageTransform = { kind: 'layer', layers: [{ edits: { operations: [{ mode: 'liquify', version }] } }] }
    expect(projectHasLiquify(JSON.stringify({ nodes: [{ data: { settings: { imageTransform } } }] }))).toBe(true)
    expect(graphHasLiquify({ nodes: [{ data: { imageTransform } }] })).toBe(true)
  })
  it('does not confuse prompts, unrelated fields or legacy brush modes with liquify', () => {
    expect(graphHasLiquify({ nodes: [{ data: { prompt: 'liquify', settings: { liquify: true, imageTransform: { layers: [{ liquify: true, edits: { operations: [{ mode: 'blur' }] } }] } } } }] })).toBe(false)
    expect(graphHasLiquify({ nodes: [] })).toBe(false)
  })
  it('requires an exact declared capability without blocking legacy documents', () => {
    for (const version of [undefined, null, false, true, '1', 0, 2]) expect(() => assertLiquifyClientVersion(version, true)).toThrow('刷新')
    expect(() => assertLiquifyClientVersion(1, true)).not.toThrow()
    expect(() => assertLiquifyClientVersion(undefined, false)).not.toThrow()
  })
})
