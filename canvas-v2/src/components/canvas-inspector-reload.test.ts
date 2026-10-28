import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { toCanvasNode } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowNode } from '../model'
import { CanvasInspector } from './CanvasInspector'
import { projectCanvasInspectorNodes } from './canvas-inspector-model'

const ids = ['a'.repeat(43), 'b'.repeat(43)]

function reopened(kind: 'image-generate' | 'gallery') {
  const node: WorkflowNode = { id: 'saved', kind, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', dirty: true, candidateAssetIds: ids, result: { kind: 'image', assetId: ids[0] } } }
  const workflow = parseWorkflowFile(serializeWorkflow({ ...createEmptyWorkflow(), nodes: [node] }))!
  return { ...toCanvasNode(workflow.nodes[0]), selected: true }
}

describe('reopened candidate inspector', () => {
  it.each(['image-generate', 'gallery'] as const)('counts the saved %s batch without claiming a recovered run attempt', (kind) => {
    const node = reopened(kind), before = JSON.stringify(node)
    expect(node.data.candidates).toBeUndefined()
    const result = projectCanvasInspectorNodes([node], [])[0]
    expect(result.candidateCount).toBe(2)
    expect(result.attemptCount).toBeUndefined()
    expect(result.dirty).toBe(true)
    expect(result.previewAsset?.assetId).toBe(ids[0])
    expect(JSON.stringify(node)).toBe(before)
  })

  it('uses the saved current batch instead of a partially hydrated or historical candidate array', () => {
    const node = reopened('gallery')
    node.data.candidates = [{ candidateId: 'known-first', attemptId: 'old', createdAt: '', asset: { kind: 'image', assetId: ids[0] } }]
    expect(projectCanvasInspectorNodes([node], [])[0].candidateCount).toBe(2)
  })

  it('honors an explicit empty saved batch and ignores malformed or duplicate IDs', () => {
    const node = reopened('gallery')
    node.data.candidateAssetIds = [ids[0], ids[0], '../../other', ids[1]]
    expect(projectCanvasInspectorNodes([node], [])[0].candidateCount).toBe(2)
    node.data.candidateAssetIds = []
    node.data.candidates = [{ candidateId: 'historical', attemptId: 'old', createdAt: '', asset: { kind: 'image', assetId: ids[0] } }]
    expect(projectCanvasInspectorNodes([node], [])[0].candidateCount).toBe(0)
  })

  it('renders unavailable attempt history as a dash while preserving a recorded zero', () => {
    const node = reopened('gallery')
    function html() {
      return renderToStaticMarkup(createElement(CanvasInspector, { tab: 'node', nodes: projectCanvasInspectorNodes([node], []), imageModels: [], videoModels: [], onTabChange: vi.fn(), onClose: vi.fn(), onLocate: vi.fn(), onRun: vi.fn(), onToggleLocked: vi.fn(), onToggleDisabled: vi.fn(), onPreview: vi.fn() }))
    }
    expect(html()).toContain('<dt>尝试</dt><dd>—</dd>')
    expect(html()).toContain('<dt>候选</dt><dd>2</dd>')
    node.data.attemptCount = 0
    expect(html()).toContain('<dt>尝试</dt><dd>0</dd>')
    node.data.attemptCount = 2
    expect(html()).toContain('<dt>尝试</dt><dd>2</dd>')
  })
})
