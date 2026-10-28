import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from '../App'
import { CanvasInspector } from '../components/CanvasInspector'
import { projectCanvasInspectorNodes } from '../components/canvas-inspector-model'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'

function workflow(): WorkflowFile {
  return { ...createEmptyWorkflow('Text output roundtrip'), nodes: [{ id: 'output', kind: 'output', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', outputText: '  # 完整正文\n\n☕ 第二行\n', status: 'succeeded', dirty: false } }] }
}

describe('actual output text editor roundtrip', () => {
  it('retains exact text across document hydration, saving and reopening without injecting it into a new run input', () => {
    const original = workflow()
    const hydrated = editorNodeToCanvasNode(canvasNodeDocumentRecord(toCanvasNode(original.nodes[0])))
    expect(hydrated.data).toMatchObject({ outputText: original.nodes[0].data.outputText, status: 'succeeded', prompt: '' })
    const reopened = parseWorkflowFile(serializeWorkflow({ ...original, nodes: [toWorkflowNode(hydrated)] }))!
    expect(reopened.nodes[0].data.outputText).toBe(original.nodes[0].data.outputText)
    const configured = workflowNodeData('output', { outputText: original.nodes[0].data.outputText })
    expect(configured.outputText).toBe(original.nodes[0].data.outputText)
    expect(configured.settings ?? {}).not.toHaveProperty('outputText')
    expect(toCanvasRunGraph([hydrated], [], { image: '', video: '', text: '' }).nodes[0].data).not.toHaveProperty('outputText')
  })

  it('restores retained text with one document undo/redo while portable workshop configuration strips execution results', () => {
    const original = workflow(), record = canvasNodeDocumentRecord(toCanvasNode(original.nodes[0]))
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [record] })
    history = applyCanvasCommand(history, { type: 'update-node-data', nodeId: 'output', patch: { outputText: '新的结果', dirty: true } })
    expect(editorNodeToCanvasNode(history.present.nodes[0]).data.outputText).toBe('新的结果')
    const undone = undoCanvasHistory(history)
    expect(editorNodeToCanvasNode(undone.present.nodes[0]).data.outputText).toBe(original.nodes[0].data.outputText)
    expect(editorNodeToCanvasNode(redoCanvasHistory(undone).present.nodes[0]).data.outputText).toBe('新的结果')
    expect(sanitizeWorkshopWorkflow(original, 'node', 'Output template').nodes[0].data).not.toHaveProperty('outputText')
  })

  it('shows text output in the inspector and retains a simultaneous media-preview entry', () => {
    const node = toCanvasNode(workflow().nodes[0])
    node.selected = true
    node.data.result = { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    const nodes = projectCanvasInspectorNodes([node], [])
    expect(nodes[0].outputText).toBe(node.data.outputText)
    const noop = () => undefined
    const html = renderToStaticMarkup(createElement(CanvasInspector, { tab: 'node', nodes, imageModels: [], videoModels: [], onTabChange: noop, onClose: noop, onLocate: noop, onRun: noop, onToggleLocked: noop, onToggleDisabled: noop, onPreview: noop }))
    expect(html).toContain('展开完整文字结果'); expect(html).toContain('文字结果'); expect(html).toContain('图像结果'); expect(html).not.toContain('尚无结果')
  })
})
