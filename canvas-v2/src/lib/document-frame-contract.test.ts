import { describe, expect, it } from 'vitest'
import { assertDocumentFrameClientVersion, graphHasDocumentFrame, projectHasDocumentFrame } from './document-frame-contract'

function graph(recipe: unknown, runtime = false) {
  return { nodes: [{ data: runtime ? { imageTransform: recipe } : { settings: { imageTransform: recipe } } }] }
}
describe('document frame client capability', () => {
  it.each([undefined, null, false, 2, {}, { version: 2 }])('protects every explicit frame including malformed value %j', (documentFrame) => {
    expect(graphHasDocumentFrame(graph({ kind: 'layer', documentFrame }, true))).toBe(true)
    expect(graphHasDocumentFrame(graph({ kind: 'layer', documentFrame }))).toBe(true)
    if (documentFrame !== undefined) expect(projectHasDocumentFrame(JSON.stringify(graph({ kind: 'layer', documentFrame })))).toBe(true)
  })
  it.each([['x', -2.01], ['x', 2.01], ['y', -3], ['y', 3], ['width', 4.01], ['height', 5], ['width', .0005], ['height', .0001]])('protects geometry outside the old %s range: %s', (key, value) => {
    const recipe = { kind: 'layer', layers: [{ x: 0, y: 0, width: 1, height: 1, [key]: value }] }
    expect(graphHasDocumentFrame(graph(recipe))).toBe(true)
    expect(graphHasDocumentFrame(graph(recipe, true))).toBe(true)
  })
  it('keeps legacy boundaries and unrelated prompt text unchanged', () => {
    expect(graphHasDocumentFrame(graph({ kind: 'layer', layers: [{ x: -2, y: 2, width: .001, height: 4 }] }))).toBe(false)
    expect(graphHasDocumentFrame({ nodes: [{ data: { prompt: 'documentFrame', settings: { documentFrame: true } } }] })).toBe(false)
    expect(graphHasDocumentFrame({ nodes: [] })).toBe(false)
  })
  it('requires only the exact capability and leaves ordinary documents available', () => {
    for (const version of [undefined, null, true, false, '1', 0, 2]) expect(() => assertDocumentFrameClientVersion(version, true)).toThrow('刷新')
    expect(() => assertDocumentFrameClientVersion(1, true)).not.toThrow()
    expect(() => assertDocumentFrameClientVersion(undefined, false)).not.toThrow()
  })
})
