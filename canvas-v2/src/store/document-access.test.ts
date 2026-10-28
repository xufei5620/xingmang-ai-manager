import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useCanvasDocument, type CanvasDocumentController } from './use-canvas-document'
import { createCanvasDocument } from './canvas-state'
import { canvasCommandAllowed } from './document-access'
import type { NodeKind } from '../model'

describe('read-only document controller', () => {
  it('blocks edits, raw replacement, undo and graph changes while preserving selection and measurements', () => {
    let editable = true, controller: CanvasDocumentController | undefined
    function Capture() { controller = useCanvasDocument((node) => ({ ...node, type: node.type as NodeKind, data: { prompt: '', model: '', status: 'idle', ...node.data } }), { canEdit: () => editable }); return null }
    renderToStaticMarkup(createElement(Capture))
    const target = controller!
    target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [{ id: 'one', type: 'prompt', definitionVersion: 1, position: { x: 2, y: 3 }, data: { prompt: '原文' } }] } })
    target.execute({ type: 'update-node-data', nodeId: 'one', patch: { prompt: '我的未提交编辑' } })
    editable = false
    target.undo(); target.redo()
    target.execute({ type: 'update-node-data', nodeId: 'one', patch: { prompt: '越权' } })
    target.setNodes((nodes) => nodes.map((node) => ({ ...node, selected: true, position: { x: 9, y: 9 }, data: { ...node.data, prompt: '绕过命令' }, measured: { width: 320, height: 200 } })))
    expect(target.getGraphSnapshot().nodes[0]).toMatchObject({ selected: true, position: { x: 2, y: 3 }, data: { prompt: '我的未提交编辑' }, measured: { width: 320, height: 200 } })
    target.setNodes([]); target.setEdges([{ id: 'bad', source: 'one', target: 'one' }])
    expect(target.getGraphSnapshot().nodes).toHaveLength(1); expect(target.getGraphSnapshot().edges).toEqual([])
    expect(canvasCommandAllowed({ type: 'set-viewport', viewport: { x: 3, y: 4, zoom: 2 } }, false)).toBe(true)
    expect(canvasCommandAllowed({ type: 'replace-document', document: createCanvasDocument() }, false)).toBe(false)
  })
})
