import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LayerTree, layerTreeSelectionBounds } from './LayerTree'
import { LayerMergeConfirmation } from './LayerMergeConfirmation'
import type { EditorLayerTreeRow } from './layer-editor-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function fixture() {
  const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
  recipe.layers = [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, name: 'Title', content: { kind: 'paint' } }]
  const rows: EditorLayerTreeRow[] = [
    { id: 'group-a', kind: 'group', parentId: null, depth: 0, leafIds: ['leaf-a'], group: { id: 'group-a', name: 'Poster', children: ['leaf-a'], visible: false, locked: true }, visible: false, locked: true, ownVisible: false, ownLocked: true },
    { id: 'leaf-a', kind: 'layer', parentId: 'group-a', depth: 1, leafIds: ['leaf-a'], layerIndex: 0, visible: false, locked: true, ownVisible: true, ownLocked: false },
  ]
  return { recipe, rows, images: [], selectedIds: ['leaf-a'], selectedId: null, selectedGroupId: 'group-a', collapsed: new Set<string>(), name: (index: number) => recipe.layers[index].name || '', onSelect: vi.fn(), onCollapse: vi.fn(), onVisibility: vi.fn(), onLock: vi.fn() }
}

describe('layer group tree presentation', () => {
  it('renders real nested group membership and a separate group primary selection', () => {
    const html = renderToStaticMarkup(createElement(LayerTree, fixture()))
    expect(html).toContain('aria-label="图层与编组"')
    expect(html).toContain('aria-label="选择编组 Poster"')
    expect(html).toContain('aria-label="折叠编组 Poster"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-label="Poster 中的图层"')
    expect(html).toContain('aria-label="选择图层 Title"')
    expect(html).toContain('1 层')
    expect(html).toContain('随组隐藏')
    expect(html).toContain('组锁定')
    expect(html.match(/is-primary/g)).toHaveLength(1)
  })

  it('collapses only the visible list without dropping editable child identity or state', () => {
    const props = fixture(), before = JSON.stringify(props.recipe)
    props.collapsed.add('group-a')
    const html = renderToStaticMarkup(createElement(LayerTree, props))
    expect(html).toContain('aria-label="展开编组 Poster"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/<ul[^>]*aria-label="Poster 中的图层"[^>]*hidden=""/)
    expect(html).toContain('选择图层 Title')
    expect(JSON.stringify(props.recipe)).toBe(before)
  })

  it('keeps child own flags distinct and refuses an inherited-lock bypass', () => {
    const html = renderToStaticMarkup(createElement(LayerTree, fixture()))
    expect(html).toContain('aria-label="隐藏图层 Title"')
    expect(html).toContain('aria-label="组已锁定图层 Title"')
    expect(html).toMatch(/<button[^>]*aria-label="组已锁定图层 Title"[^>]*disabled=""/)
    expect(html).toContain('aria-label="解锁编组 Poster"')
    expect(html).toContain('穿透编组：保留子图层的混合方式')
  })

  it('also explains the parent lock when the child keeps an independent own lock', () => {
    const props = fixture()
    props.rows[1].ownLocked = true
    props.recipe.layers[0].locked = true
    const html = renderToStaticMarkup(createElement(LayerTree, props))
    expect(html).toContain('组锁定')
    expect(html).toMatch(/<button[^>]*aria-label="组已锁定图层 Title"[^>]*disabled=""/)
    expect(html).not.toContain('aria-label="解锁图层 Title"')
  })

  it('discloses group removal only for a merge that actually removes the folder', () => {
    const props = { names: ['Photo', 'Title'], busy: false, onConfirm: vi.fn(), onCancel: vi.fn() }
    const wholeGroup = renderToStaticMarkup(createElement(LayerMergeConfirmation, { ...props, groupNames: ['Poster'] }))
    expect(wholeGroup).toContain('将移除编组：Poster')
    expect(wholeGroup).toContain('组结构与可编辑成员可一次撤销恢复')
    expect(renderToStaticMarkup(createElement(LayerMergeConfirmation, props))).not.toContain('将移除编组')
  })

  it('places the group boundary around rotated and off-canvas members', () => {
    const props = fixture()
    props.recipe.outputWidth = 100; props.recipe.outputHeight = 100
    props.recipe.layers[0] = { ...props.recipe.layers[0], x: -.2, y: .1, width: .4, height: .2, rotation: 90 }
    const bounds = layerTreeSelectionBounds(props.recipe, [0])!
    expect(bounds.x).toBeCloseTo(-10)
    expect(bounds.y).toBeCloseTo(0)
    expect(bounds.width).toBeCloseTo(20)
    expect(bounds.height).toBeCloseTo(40)
    expect(layerTreeSelectionBounds(props.recipe, [])).toBeNull()
  })
})
