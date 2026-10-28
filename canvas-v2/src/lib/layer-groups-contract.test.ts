import { describe, expect, it } from 'vitest'
import { assertLayerGroupsClientVersion, assertLayerGroupsPlacement, graphHasLayerGroups, projectHasLayerGroups } from './layer-groups-contract'

function graph(groups: unknown) { return { nodes: [{ kind: 'image-layer', data: { settings: { imageTransform: { kind: 'layer', layerGroups: groups } } } }] } }
describe('persistent layer group presence and projection fences', () => {
  it.each([null, false, [], {}, { version: 1, layerIds: [], groups: [] }, { version: 2 }])('requires capability for explicit metadata before recipe validation: %j', (groups) => {
    expect(graphHasLayerGroups(graph(groups))).toBe(true)
    expect(projectHasLayerGroups(JSON.stringify(graph(groups)))).toBe(true)
    for (const version of [undefined, null, false, true, 0, 2, '1']) expect(() => assertLayerGroupsClientVersion(version, true)).toThrow('持久图层编组')
    expect(() => assertLayerGroupsClientVersion(1, true)).not.toThrow()
  })
  it('retains all legacy group-free graphs without requiring a new version', () => {
    for (const value of [undefined, null, {}, { nodes: [] }, { nodes: [{ data: { prompt: 'layerGroups is prose', settings: { imageTransform: { kind: 'layer', layers: [] } } } }] }]) expect(graphHasLayerGroups(value)).toBe(false)
    expect(() => assertLayerGroupsClientVersion(undefined, false)).not.toThrow()
  })
  it('accepts only the canonical workflow and immutable run placements', () => {
    const nested = graph({ version: 1 }).nodes[0].data, flat = { imageTransform: { layerGroups: { version: 1 } } }
    expect(() => assertLayerGroupsPlacement('image-layer', nested, 'workflow')).not.toThrow()
    expect(() => assertLayerGroupsPlacement('image-layer', flat, 'run')).not.toThrow()
    for (const data of [flat, { layerGroups: null }, { settings: { layerGroups: {} } }, { settings: { nested: { imageTransform: { layerGroups: {} } } } }, { ...nested, ...flat }]) expect(() => assertLayerGroupsPlacement('image-layer', data, 'workflow')).toThrow('正确配方位置')
    expect(() => assertLayerGroupsPlacement('image-input', nested, 'workflow')).toThrow()
    expect(() => assertLayerGroupsPlacement('image-layer', nested, 'run')).toThrow()
  })
  it('detects malformed misplaced data and bounds cyclic or excessively deep input before stripping it', () => {
    const data: Record<string, unknown> = {}; data.self = data; data.layerGroups = null
    expect(graphHasLayerGroups({ nodes: [{ data }] })).toBe(true)
    let deep: unknown = { arbitrary: true }
    for (let index = 0; index < 50; index++) deep = { nested: deep }
    expect(graphHasLayerGroups({ nodes: [{ data: deep }] })).toBe(true)
    expect(() => assertLayerGroupsPlacement('image-layer', deep, 'workflow')).toThrow()
  })
})
