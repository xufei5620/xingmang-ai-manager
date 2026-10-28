import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LayerTree, layerTreeDropPosition } from './LayerTree'
import { createLayerEditorState, editorLayerTreeRows } from './layer-editor-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function fixture() {
  const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
  const state = createLayerEditorState(recipe, 2)
  return { recipe: state.present.recipe, rows: editorLayerTreeRows(state.present), images: [], selectedIds: state.present.selectedIds ?? [], selectedId: state.present.selectedId, collapsed: new Set<string>(), name: (index: number) => `Layer ${index + 1}`, onSelect: vi.fn(), onCollapse: vi.fn(), onVisibility: vi.fn(), onLock: vi.fn(), onMoveStart: vi.fn(() => state.present), onInspectMove: vi.fn(() => ''), onMove: vi.fn(() => ({ ok: true, message: 'Moved' })) }
}

describe('layer tree placement controls', () => {
  it('maps the visual upper edge to after in bottom-to-top paint order', () => {
    expect(layerTreeDropPosition('layer', 22, { top: 20, height: 40 })).toBe('after')
    expect(layerTreeDropPosition('layer', 58, { top: 20, height: 40 })).toBe('before')
  })

  it('offers an explicit inside zone only for folders', () => {
    expect(layerTreeDropPosition('group', 40, { top: 20, height: 40 })).toBe('inside')
    expect(layerTreeDropPosition('layer', 40, { top: 20, height: 40 })).not.toBe('inside')
    expect(layerTreeDropPosition('group', 21, { top: 20, height: 40 })).toBe('after')
    expect(layerTreeDropPosition('group', 59, { top: 20, height: 40 })).toBe('before')
  })

  it('exposes keyboard placement and named pointer handles without HTML file dragging', () => {
    const html = renderToStaticMarkup(createElement(LayerTree, fixture()))
    expect(html).toContain('移动到…')
    expect(html).toContain('拖动移动图层 Layer 1')
    expect(html).toContain('data-layer-tree-row=')
    expect(html).not.toContain('draggable="true"')
  })

  it('disables a locked row drag handle while preserving selection and own flags', () => {
    const props = fixture()
    props.rows[0].locked = true
    const html = renderToStaticMarkup(createElement(LayerTree, props))
    expect(html).toMatch(/<button[^>]*aria-label="拖动移动图层 Layer 2"[^>]*disabled=""/)
    expect(html).toContain('aria-label="选择图层 Layer 2"')
  })
})
