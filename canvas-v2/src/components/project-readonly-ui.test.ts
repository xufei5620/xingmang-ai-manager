import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ResourceTree } from './ResourceTree'
import { SelectionToolbar, type SelectionToolbarProps } from './SelectionToolbar'
import { selectionToolbarActions } from './selection-toolbar-model'
import { CanvasInspector } from './CanvasInspector'

describe('project viewer controls', () => {
  it('preserves resource selection and package export while disabling grouping and locking', () => {
    const html = renderToStaticMarkup(createElement(ResourceTree, { readOnly: true, nodes: [{ id: 'one', type: 'prompt', selected: true, data: { settings: { title: '提示词' } } }], onSelect: vi.fn(), onRename: vi.fn(), onGroup: vi.fn(), onLock: vi.fn(), onExport: vi.fn(), canExport: true }))
    expect(html).toContain('只读浏览 · 可定位、预览和导出')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="锁定所选节点位置"/)
    expect(html).toMatch(/<button[^>]*title="打包选中节点[^>]*>[^]*?打包<\/button>/)
    expect(html).toContain('aria-label="多选资源"')
    expect(html).not.toContain('改名、编组和锁定支持撤销')
  })
  it('offers only viewing and copy in the viewer selection menu even if retained edit callbacks exist', () => {
    const props: SelectionToolbarProps = { readOnly: true, count: 2, canGroup: true, canUngroup: true, allLocked: false, canToggleDisabled: true, allDisabled: false, onAlign: vi.fn(), onDistribute: vi.fn(), onCopy: vi.fn(), onDuplicate: vi.fn(), onGroup: vi.fn(), onUngroup: vi.fn(), onToggleLocked: vi.fn(), onToggleDisabled: vi.fn(), onFocus: vi.fn(), onInspect: vi.fn(), onDelete: vi.fn() }
    const state = { ...props, canSaveWorkshop: true, canSendAgent: true, hasBatchImages: true, hasRunActions: true }
    expect(selectionToolbarActions(state, 'more').map((item) => item.id)).toEqual(['inspect', 'focus', 'copy'])
    expect(selectionToolbarActions(state, 'layout')).toEqual([]); expect(selectionToolbarActions(state, 'run')).toEqual([])
    expect(renderToStaticMarkup(createElement(SelectionToolbar, props))).toMatch(/aria-label="选区布局" disabled=""/)
  })
  it('uses a locating label instead of promising parameter edits to viewers', () => {
    const html = renderToStaticMarkup(createElement(CanvasInspector, { readOnly: true, canRun: false, tab: 'node', nodes: [{ id: 'one', kind: 'prompt', title: '提示词', description: '', status: 'idle', prompt: '正文', model: '', settings: {}, candidateCount: 0, attemptCount: 0, dirty: false, disabled: false, locked: false, executable: false, ports: [] }], imageModels: [], videoModels: [], onTabChange: vi.fn(), onClose: vi.fn(), onLocate: vi.fn(), onRun: vi.fn(), onToggleLocked: vi.fn(), onToggleDisabled: vi.fn(), onPreview: vi.fn() }))
    expect(html).not.toContain('在节点上编辑')
    expect(html).toContain('定位节点')
  })
})
