import { describe, expect, it } from 'vitest'
import { imageLayerGroupEffectiveState, materializeImageLayerGroups, parseImageLayerGroups, reconcileImageLayerGroupLeaves } from './layer-group-model'
import { defaultEditorImageLayer } from './layer-editor-state'
import { parseImageTransformRecipe, type ImageLayerGrouping, type ImageLayerRecipe } from './recipe'

function grouping(): ImageLayerGrouping {
  return { version: 1, layerIds: ['a', 'b', 'c'], groups: [{ id: 'g', name: '组', children: ['a', 'b'], visible: true, locked: false }] }
}
function recipe(groups = grouping()): ImageLayerRecipe {
  return { kind: 'layer', outputWidth: 100, outputHeight: 80, explicitLayers: true, background: 'transparent', layers: groups.layerIds.map((_, index) => ({ ...defaultEditorImageLayer(index), name: `${index}`, blend: index ? 'multiply' : 'source-over' })), layerGroups: groups }
}

describe('persistent pass-through layer group contract', () => {
  it('preserves old canonical recipes and requires explicit leaf identity only when groups exist', () => {
    const { layerGroups: _groups, ...old } = recipe()
    expect(parseImageTransformRecipe(old)).toEqual(old)
    expect(materializeImageLayerGroups(old)).toBe(old)
    expect(parseImageTransformRecipe(recipe())).toEqual(recipe())
    expect(() => parseImageTransformRecipe({ ...recipe(), explicitLayers: false })).toThrow('明确')
  })
  it.each([
    (v: ImageLayerGrouping) => ({ ...v, version: 2 }),
    (v: ImageLayerGrouping) => ({ ...v, extra: true }),
    (v: ImageLayerGrouping) => ({ ...v, layerIds: ['a', 'a', 'c'] }),
    (v: ImageLayerGrouping) => ({ ...v, layerIds: ['a', 'b'] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], id: 'a' }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], id: 'g/../x' }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], name: '' }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], name: 'x\u0000' }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], name: '\uD800' }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], name: '\uDC00' }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], children: [] }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], children: ['missing'] }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], children: ['a', 'a'] }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], children: ['b', 'a'] }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], children: ['a', 'c'] }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [...v.groups, { ...v.groups[0], id: 'other', children: ['b'] }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], children: ['g'] }] }),
    (v: ImageLayerGrouping) => ({ ...v, groups: [{ ...v.groups[0], children: ['other'] }, { ...v.groups[0], id: 'other', children: ['g'] }] }),
  ])('rejects malformed or appearance-reordering hierarchy case %#', (change) => {
    expect(() => parseImageLayerGroups(change(grouping()), 3)).toThrow('编组无效')
  })
  it('permits four nested groups and rejects the fifth without recursion escape', () => {
    const groups = Array.from({ length: 4 }, (_, index) => ({ id: `g${index}`, name: '组', children: [index === 3 ? 'a' : `g${index + 1}`], visible: true, locked: false }))
    expect(parseImageLayerGroups({ version: 1, layerIds: ['a'], groups }, 1).groups).toHaveLength(4)
    expect(() => parseImageLayerGroups({ version: 1, layerIds: ['a'], groups: [...groups, { id: 'outer', name: '外层', children: ['g0'], visible: true, locked: false }] }, 1)).toThrow('4 层')
  })
  it('preserves valid supplementary Unicode names while rejecting incomplete UTF16 pairs', () => {
    const value = grouping(); value.groups[0].name = '产品 🧃'
    expect(parseImageLayerGroups(value, 3).groups[0].name).toBe('产品 🧃')
    for (const name of ['\uD800x', 'x\uDC00', '\uD800\uD800', '\uDC00\uDC00']) expect(() => parseImageLayerGroups({ ...value, groups: [{ ...value.groups[0], name }] }, 3)).toThrow('编组无效')
  })
  it('materializes inherited flags without isolation, reordering or changing leaf geometry and edits', () => {
    const value = recipe(), original = structuredClone(value)
    const flat = materializeImageLayerGroups(value)
    expect(flat).not.toHaveProperty('layerGroups')
    expect(flat.layers).toEqual(value.layers)
    flat.layers.forEach((layer, index) => expect(layer).toBe(value.layers[index]))
    value.layerGroups!.groups[0].visible = false; value.layerGroups!.groups[0].locked = true
    const hidden = materializeImageLayerGroups(value)
    expect(hidden.layers.slice(0, 2).map((layer) => [layer.visible, layer.locked])).toEqual([[false, true], [false, true]])
    expect(hidden.layers[2]).toBe(value.layers[2])
    expect(value.layers).toEqual(original.layers)
    expect(imageLayerGroupEffectiveState(value, 'a')).toEqual({ visible: false, locked: true, ownVisible: true, ownLocked: false, parentId: 'g' })
  })
  it('retains a replacement in an otherwise emptied parent and drops truly empty groups', () => {
    const value = recipe(), layers = [value.layers[0], value.layers[2]]
    const replaced = reconcileImageLayerGroupLeaves({ ...value, layers }, ['merged', 'c'], new Map([['merged', 'g']]))
    expect(replaced.layerGroups!.groups[0].children).toEqual(['merged'])
    const removed = reconcileImageLayerGroupLeaves({ ...value, layers: [value.layers[2]] }, ['c'])
    expect(removed).not.toHaveProperty('layerGroups')
    expect(removed.layers[0]).toBe(value.layers[2])
  })
})
