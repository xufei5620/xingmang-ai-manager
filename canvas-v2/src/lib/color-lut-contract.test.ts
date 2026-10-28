import { describe, expect, it } from 'vitest'
import { assertColorLutClientVersion, graphHasColorLut, projectHasColorLut } from './color-lut-contract'
import { collectAssetReferenceIds } from './asset-reference-values'

function graph(lut: unknown, location: 'data' | 'settings' = 'settings') {
  const imageTransform = { kind: 'layer', layers: [{ colorGrade: { version: 1, lut } }] }
  return { schemaVersion: 2, nodes: [{ id: 'n1', kind: 'image-layer', data: location === 'settings' ? { settings: { imageTransform } } : { imageTransform } }], edges: [] }
}

describe('color LUT client compatibility', () => {
  it.each([undefined, null, false, 0, '', {}, { version: 2 }, { version: 1, enabled: false, strength: 0 }])('detects every explicit LUT field before sanitization: %j', (lut) => {
    expect(graphHasColorLut(graph(lut))).toBe(true)
    expect(graphHasColorLut(graph(lut, 'data'))).toBe(true)
  })

  it('inspects both recipe locations even when the other location is present and empty', () => {
    const doc = graph({ version: 1 })
    Object.assign(doc.nodes[0].data, { imageTransform: { layers: [] } })
    expect(graphHasColorLut(doc)).toBe(true)
  })

  it.each([null, undefined, [], false, '', {}, { nodes: {} }, { nodes: [null, [], 1] }, { nodes: [{ data: { settings: { imageTransform: { layers: [{ colorGrade: { version: 1, exposure: 1 } }] } } } }] }, { nodes: [{ data: { prompt: 'lut', settings: { lut: {} } } }] }])('does not invent LUT requirements for ordinary or unrelated data: %j', (value) => {
    expect(graphHasColorLut(value)).toBe(false)
  })

  it('requires the exact current capability rather than a truthy version', () => {
    expect(() => assertColorLutClientVersion(1, true)).not.toThrow()
    for (const version of [undefined, null, true, '1', 0, 2, NaN, Infinity]) expect(() => assertColorLutClientVersion(version, true)).toThrow('未提交生成或覆盖工程')
    expect(() => assertColorLutClientVersion(undefined, false)).not.toThrow()
  })

  it('keeps malformed stored JSON unavailable instead of treating it as a safe old project', () => {
    expect(() => projectHasColorLut('{')).toThrow()
    expect(projectHasColorLut(JSON.stringify(graph(null)))).toBe(true)
    expect(projectHasColorLut(JSON.stringify(graph(undefined)))).toBe(false)
  })

  it('uses the established asset reference closure for current projects and history', () => {
    const id = 'a'.repeat(43), digest = 'f'.repeat(64)
    const doc = graph({ version: 1, enabled: true, strength: 50, source: { kind: 'asset', lutAssetId: id, digest, name: '原创调色表', domainMin: [0, 0, 0], domainMax: [1, 1, 1] } })
    expect(collectAssetReferenceIds(doc)).toEqual([id])
    expect(collectAssetReferenceIds({ prompt: `lutAssetId ${id}`, digest })).toEqual([])
  })
})
