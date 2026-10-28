import { describe, expect, it } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toWorkflowNode } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowNode } from '../model'
import { dirtyCanvasNodeIds, markNodeAndDescendantsDirty, projectRunRecordToNodes } from '../runtime/run-projection'
import { canvasNodeDocumentRecord, canvasNodeRuntimePatch } from '../store/use-canvas-document'
import { sanitizeWorkflowV2 } from './workflow-sanitizer'
import { toPersistedWorkflowV2 } from './workflow-schema'
import type { CanvasRunRecord } from '../host'

function nodes(): WorkflowNode[] {
  const assetId = 'a'.repeat(43)
  return [
    { id: 'prompt', kind: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'input A', model: '', status: 'idle' } },
    { id: 'image', kind: 'image-generate', definitionVersion: 1, position: { x: 200, y: 0 }, data: { prompt: '', model: 'gpt-image-1', status: 'succeeded', result: { kind: 'image', assetId } } },
    { id: 'gallery', kind: 'gallery', definitionVersion: 1, position: { x: 400, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId } } },
  ]
}

function restoreEditor(workflowNodes: WorkflowNode[]) {
  const workflow = createEmptyWorkflow('roundtrip')
  workflow.nodes = workflowNodes.map((node) => toWorkflowNode(toCanvasNode(node)))
  const restored = parseWorkflowFile(serializeWorkflow(workflow))
  if (!restored) throw new Error('test workflow failed to restore')
  return restored.nodes.map((node) => editorNodeToCanvasNode({ id: node.id, type: node.kind, definitionVersion: node.definitionVersion ?? 1, position: node.position, data: { ...node.data } }))
}

describe('editor persistence roundtrip', () => {
  it('lets content nodes report their real height while retaining media and group geometry', () => {
    const prompt = toCanvasNode({ ...nodes()[0], height: 176, width: 288 })
    expect(prompt.height).toBeUndefined()
    expect(prompt.style).toEqual({ width: 288 })
    const media = toCanvasNode(nodes()[1])
    expect(media.height).toBeGreaterThan(0)
    expect(media.style?.height).toBe(media.height)
    const group = toCanvasNode({ ...nodes()[0], kind: 'group', width: 600, height: 450 })
    expect(group.style).toEqual({ width: 600, height: 450 })
  })

  it('restores all pending nodes after editing an upstream prompt and reopening', () => {
    const edges = [
      { id: 'e1', source: 'prompt', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' },
      { id: 'e2', source: 'image', sourceHandle: 'out:image', target: 'gallery', targetHandle: 'in:image' },
    ]
    const changed = markNodeAndDescendantsDirty(nodes(), edges, 'prompt', { prompt: 'input B' })
    const restored = restoreEditor(changed)
    expect([...dirtyCanvasNodeIds(restored)]).toEqual(['prompt', 'image', 'gallery'])
    expect(restored[0].data.prompt).toBe('input B')
    expect(restored[1].data.result?.assetId).toBe('a'.repeat(43))
  })

  it('keeps dirty in document commands without overriding it with previous runtime state', () => {
    const previous = toCanvasNode(nodes()[1])
    previous.data.dirty = false
    const changed = { ...previous, data: { ...previous.data, dirty: true } }
    const document = canvasNodeDocumentRecord(changed)
    expect(document.data.dirty).toBe(true)
    expect(canvasNodeRuntimePatch(previous, document)).not.toHaveProperty('dirty')
    expect(editorNodeToCanvasNode(document).data.dirty).toBe(true)
  })

  it('retains generated text and its original prompt when restoring the actual editor', () => {
    const node: WorkflowNode = { id: 'text', kind: 'text-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'original prompt', model: 'gpt-4o-mini', outputText: 'saved generated result', status: 'succeeded', dirty: true } }
    const restored = restoreEditor([node])[0]
    expect(restored.data).toMatchObject({ prompt: 'original prompt', outputText: 'saved generated result', status: 'succeeded', dirty: true })
  })

  it('does not resurrect pending flags after a matching successful run', () => {
    const node = nodes()[0]
    node.data.dirty = true
    const at = '2026-10-10T12:00:00.000Z'
    const run: CanvasRunRecord = { version: 1, runId: 'run', userId: 1, ownerId: 1, graphRevision: 'revision', scope: { kind: 'all' }, status: 'succeeded', createdAt: at, startedAt: at, nodes: [{ nodeId: 'prompt', kind: 'prompt', state: 'succeeded', attempts: [] }], events: [] }
    const completed = projectRunRecordToNodes([node], run, [], new Set(['prompt']))
    expect([...dirtyCanvasNodeIds(restoreEditor(completed))]).toEqual([])
  })

  it('accepts old files without dirty flags and rejects malformed pending state', () => {
    expect([...dirtyCanvasNodeIds(restoreEditor(nodes()))]).toEqual([])
    const workflow = createEmptyWorkflow('roundtrip')
    workflow.nodes = nodes()
    const persisted = toPersistedWorkflowV2(workflow)
    const malformed = { ...persisted, nodes: persisted.nodes.map((node) => ({ ...node, data: { ...node.data, dirty: 'true' } })) }
    expect(sanitizeWorkflowV2(malformed)).toBeNull()
  })
})
