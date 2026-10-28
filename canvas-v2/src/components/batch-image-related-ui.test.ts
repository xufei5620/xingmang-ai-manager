import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { analyzeBatchImageRelatedSources } from '../editor/batch-image-related'
import { BatchImageRelatedDialog } from './BatchImageRelatedDialog'
import { CanvasContextMenu } from './CanvasContextMenu'
import { QuickInsert } from './QuickInsert'
import { selectionToolbarActions } from './selection-toolbar-model'

describe('multi-image entry and confirmation presentation', () => {
  it('shows every ordered source and explicitly distinguishes the single output from a batch', () => {
    const nodes = [builtinNodeRegistry.create('image-grid-split', 'split', { x: 0, y: 400 }), builtinNodeRegistry.create('image-input', 'first', { x: 0, y: 0 })]
    const sources = analyzeBatchImageRelatedSources(nodes, ['split', 'first']).sources
    const html = renderToStaticMarkup(createElement(BatchImageRelatedDialog, { sources, onConfirm: vi.fn(), onClose: vi.fn() }))
    expect(html).toContain('aria-label="图片输入顺序"')
    expect(html.indexOf('单张图片输出')).toBeLessThan(html.indexOf('当前切片（不含全部切片）'))
    expect(html).toContain('不会自动运行')
    expect(html).toContain('一次撤销')
    expect(html).toContain('aria-modal="true"')
  })
  it('keeps all twenty source rows visible and explains the two unavailable targets', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => builtinNodeRegistry.create('image-input', String(index), { x: index, y: 0 }))
    const html = renderToStaticMarkup(createElement(BatchImageRelatedDialog, { sources: analyzeBatchImageRelatedSources(nodes, nodes.map((node) => node.id)).sources, onConfirm: vi.fn(), onClose: vi.fn() }))
    expect(html.match(/<li>/g)).toHaveLength(20)
    expect(html).toContain('网格拼图最多 16 张')
    expect(html).toContain('2–4 张图片')
    expect(html.match(/<input[^>]+value="image-layer"[^>]*>/)?.[0]).toContain('checked=""')
    expect(html.match(/ disabled=""/g)).toHaveLength(2)
  })
  it('exposes the same mixed-selection reason in context, toolbar and quick insertion', () => {
    const reason = '选区包含分组，请直接选择分组内的图片节点'
    const menu = renderToStaticMarkup(createElement(CanvasContextMenu, { state: { nodeId: 'g', nodeIds: ['g', 'image'], x: 0, y: 0, target: 'selection', selectionCount: 2, executable: false, running: false, hasGroup: true, allLocked: false, allDisabled: false, canDisable: true, batchImages: { disabledReason: reason } }, onAction: vi.fn(), onClose: vi.fn() }))
    expect(menu).toContain('aria-disabled="true"')
    expect(menu).toContain(reason)
    const action = selectionToolbarActions({ count: 2, canGroup: true, canUngroup: true, allLocked: false, canToggleDisabled: true, allDisabled: false, canSaveWorkshop: true, hasBatchImages: true, batchImagesDisabledReason: reason }, 'more').find((entry) => entry.id === 'batch-images')
    expect(action?.disabledReason).toBe(reason)
    const quick = renderToStaticMarkup(createElement(QuickInsert, { open: true, anchor: { x: 0, y: 0 }, hasNodes: true, hasSelection: true, canvasNodes: [], onBatchImages: vi.fn(), batchImagesDisabledReason: reason, onAddNode: vi.fn(), onLoadTemplate: vi.fn(), onCommand: vi.fn(), onLocateNode: vi.fn(), onClose: vi.fn() }))
    expect(quick).toContain('aria-disabled="true"')
    expect(quick).toContain(reason)
  })
})
