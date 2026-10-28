import { describe, expect, it } from 'vitest'
import { assertColorGradePresenceClientVersion, assertColorGradePresencePlacement, graphHasColorGradePresence, projectHasColorGradePresence } from './color-presence-contract'

function data(presence: unknown, nested: boolean) { const imageTransform = { kind: 'layer', layers: [{ colorGrade: { version: 1, presence } }] }; return nested ? { settings: { imageTransform } } : { imageTransform } }
describe('color presence capability and canonical placement', () => {
  it.each([undefined, null, false, 0, {}, { version: 2 }, { version: 1, enabled: false, texture: 0, clarity: -12, dehaze: 7 }])('detects explicit presence %j independently of validity or neutrality', (presence) => {
    for (const nested of [true, false]) {
      const graph = { nodes: [{ kind: 'image-layer', data: data(presence, nested) }] }
      expect(graphHasColorGradePresence(graph)).toBe(true)
      expect(projectHasColorGradePresence(JSON.stringify(graph))).toBe(presence !== undefined)
      for (const capability of [undefined, null, false, 0, true, '1', 2]) expect(() => assertColorGradePresenceClientVersion(capability, true)).toThrow('刷新')
      expect(() => assertColorGradePresenceClientVersion(1, true)).not.toThrow()
    }
  })
  it('does not confuse prose, detail, LUT or whole-filter parameters with presence', () => {
    const graph = { nodes: [{ data: { prompt: 'presence colorGradePresenceVersion', settings: { imageTransform: { kind: 'layer', layers: [{ colorGrade: { version: 1, detail: null, lut: null } }], edits: { filter: { presence: 12, detail: 50 } } } } } }] }
    expect(graphHasColorGradePresence(graph)).toBe(false)
    expect(() => assertColorGradePresenceClientVersion(undefined, false)).not.toThrow()
    expect(() => projectHasColorGradePresence('{')).toThrow()
  })
  it.each([null, { version: 2 }, { version: 1, enabled: false, texture: 0, clarity: 0, dehaze: 0 }])('rejects every raw wrong location before projection: %j', (presence) => {
    expect(() => assertColorGradePresencePlacement('image-layer', data(presence, true), 'workflow')).not.toThrow()
    expect(() => assertColorGradePresencePlacement('image-layer', data(presence, false), 'run')).not.toThrow()
    expect(() => assertColorGradePresencePlacement('image-layer', data(presence, false), 'workflow')).toThrow('正确配置位置')
    expect(() => assertColorGradePresencePlacement('image-layer', data(presence, true), 'run')).toThrow('正确配置位置')
    expect(() => assertColorGradePresencePlacement('note', data(presence, true), 'workflow')).toThrow()
    expect(() => assertColorGradePresencePlacement('note', data(presence, false), 'run')).toThrow()
    expect(() => assertColorGradePresencePlacement('image-layer', { ...data(presence, true), ...data(presence, false) }, 'workflow')).toThrow()
    expect(() => assertColorGradePresencePlacement('image-layer', { ...data(presence, true), ...data(presence, false) }, 'run')).toThrow()
  })
})
