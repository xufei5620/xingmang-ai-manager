import { describe, expect, it } from 'vitest'
import { parseTextWebSearch, parseTextWebSearchReceipt, textWebSearchModelSupported, validateTextWebSearchConfiguration } from './text-web-search'
import { availableTextModels } from '../library/media-groups'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { buildPortableWorkshopWorkflowFromPrivate, sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'

function workflow(textWebSearch?: boolean): WorkflowFile {
  return {
    ...createEmptyWorkflow('Web search roundtrip'),
    nodes: [{
      id: 'search', kind: 'text-generate', definitionVersion: 1, position: { x: 100, y: 200 },
      data: { prompt: 'Find current sources', model: 'gpt-4.1', group: 'private-provider', outputText: 'Previous completed answer', status: 'succeeded', ...(textWebSearch !== undefined ? { textWebSearch } : {}) },
    }],
  }
}

describe('explicit text web search capability', () => {
  it('allows only exact supported models and preserves unknown ordinary text models', () => {
    for (const model of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol']) expect(textWebSearchModelSupported(model)).toBe(true)
    for (const model of ['gpt-4.1-fake', 'unknown', 'gpt-4o-mini', 'gpt-5-search-api']) expect(textWebSearchModelSupported(model)).toBe(false)
    expect(availableTextModels(['custom', 'gpt-4.1', 'gpt-5-search-api', 'gpt-4o-search-preview'])).toEqual(['custom', 'gpt-4.1'])
    expect(() => validateTextWebSearchConfiguration('text-generate', 'custom', false)).not.toThrow()
  })
  it('strictly parses both on and off while refusing unsupported kinds and coercion', () => {
    expect(parseTextWebSearch(undefined, 'prompt')).toBeUndefined()
    for (const value of [true, false]) expect(parseTextWebSearch(value, 'text-generate')).toBe(value)
    for (const value of [null, 'true', 1, {}]) expect(() => parseTextWebSearch(value, 'text-generate')).toThrow()
    for (const kind of ['prompt', 'text', 'drama-parse', 'image']) expect(() => parseTextWebSearch(false, kind)).toThrow()
  })
  it('keeps bounded immutable search metadata distinct from a boolean configuration', () => {
    const valid = { version: 1, protocol: 'openai-responses', searchCalls: 1, completedAt: '2026-10-15T12:00:00.000Z' }
    expect(parseTextWebSearchReceipt(valid)).toEqual(valid)
    for (const input of [true, {}, { ...valid, searchCalls: 2 }, { ...valid, completedAt: 'now' }, { ...valid, request: 'secret' }]) expect(() => parseTextWebSearchReceipt(input)).toThrow()
  })
})

describe('web search editor and portable document roundtrip', () => {
  it.each([true, false])('preserves explicit %s through the real App hydration and run graph', (enabled) => {
    const original = workflow(enabled)
    const node = toCanvasNode(original.nodes[0])
    const hydrated = editorNodeToCanvasNode(canvasNodeDocumentRecord(node))
    expect(hydrated.data.textWebSearch).toBe(enabled)
    expect(hydrated.data.outputText).toBe('Previous completed answer')
    const restored = parseWorkflowFile(serializeWorkflow({ ...original, nodes: [toWorkflowNode(hydrated)] }))!
    expect(restored.nodes[0].data.textWebSearch).toBe(enabled)
    expect(restored.nodes[0].data.settings ?? {}).not.toHaveProperty('textWebSearch')
    const configured = workflowNodeData('text-generate', { textWebSearch: enabled, prompt: 'Question', temperature: 0.5 })
    expect(configured.textWebSearch).toBe(enabled)
    expect(configured.settings).toEqual({ temperature: 0.5 })
    const graph = toCanvasRunGraph([hydrated], [], { image: '', video: '', text: 'provider' })
    expect(graph.nodes[0].data.textWebSearch).toBe(enabled)
    expect(graph.nodes[0].data.prompt).toBe('Find current sources')
    expect(graph.nodes[0].data).not.toHaveProperty('settings')
  })

  it('keeps omitted legacy mode omitted across editor restoration and execution', () => {
    const original = workflow()
    const hydrated = editorNodeToCanvasNode(canvasNodeDocumentRecord(toCanvasNode(original.nodes[0])))
    expect(hydrated.data).not.toHaveProperty('textWebSearch')
    expect(workflowNodeData('text-generate', { prompt: 'Question' })).not.toHaveProperty('textWebSearch')
    const restored = parseWorkflowFile(serializeWorkflow({ ...original, nodes: [toWorkflowNode(hydrated)] }))!
    expect(restored.nodes[0].data).not.toHaveProperty('textWebSearch')
    expect(toCanvasRunGraph([hydrated], [], { image: '', video: '', text: 'provider' }).nodes[0].data).not.toHaveProperty('textWebSearch')
  })

  it.each([true, false])('undoes and redoes a mode change from %s while retaining the last completed answer', (enabled) => {
    const node = toCanvasNode(workflow(enabled).nodes[0])
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: [canvasNodeDocumentRecord(node)] })
    const changed = { ...node, data: { ...node.data, textWebSearch: !enabled, dirty: true } }
    const applied = applyCanvasCommand(history, { type: 'replace-nodes', nodes: [canvasNodeDocumentRecord(changed)] })
    const undone = undoCanvasHistory(applied)
    const redone = redoCanvasHistory(undone)
    for (const [state, expected] of [[applied, !enabled], [undone, enabled], [redone, !enabled]] as const) {
      const restored = editorNodeToCanvasNode(state.present.nodes[0])
      expect(restored.data.textWebSearch).toBe(expected)
      expect(restored.data.outputText).toBe('Previous completed answer')
      expect(restored.data.settings ?? {}).not.toHaveProperty('textWebSearch')
      expect(toCanvasRunGraph([restored], [], { image: '', video: '', text: 'provider' }).nodes[0].data.textWebSearch).toBe(expected)
    }
    expect(editorNodeToCanvasNode(redone.present.nodes[0]).data.dirty).toBe(true)
  })

  it.each([true, false])('retains explicit %s in workshop insertion and transfer without stale output or provider identity', (enabled) => {
    for (const kind of ['node', 'group'] as const) {
      const owned = workflow(enabled)
      expect(() => sanitizeWorkshopWorkflow(owned, kind, '联网文案')).toThrow('使用画布默认来源')
      const clean = buildPortableWorkshopWorkflowFromPrivate(owned, kind, '联网文案')
      const inserted = instantiateWorkshopGraph(clean, () => 'inserted')
      expect(inserted.nodes[0].data.textWebSearch).toBe(enabled)
      expect(inserted.nodes[0].data.settings ?? {}).not.toHaveProperty('textWebSearch')
      expect(inserted.nodes[0].data).not.toHaveProperty('outputText')
      expect(inserted.nodes[0].data).not.toHaveProperty('group')
      const transfer = buildWorkshopTransferFile({ kind, name: '联网文案', description: '', category: 'general', tags: [], nodeCount: 1, edgeCount: 0, nodeKinds: ['text-generate'], workflow: clean }, { kind: 'personal' })
      const restored = parseWorkshopTransferFile(serializeWorkshopTransferFile(transfer)).snapshot.workflow!
      expect(restored.nodes[0].data.textWebSearch).toBe(enabled)
      expect(restored.nodes[0].data.settings ?? {}).not.toHaveProperty('textWebSearch')
      expect(restored.nodes[0].data).not.toHaveProperty('outputText')
      expect(restored.nodes[0].data).not.toHaveProperty('group')
      expect(toCanvasRunGraph(restored.nodes.map(toCanvasNode), [], { image: '', video: '', text: 'provider' }).nodes[0].data.textWebSearch).toBe(enabled)
      expect(owned.nodes[0].data.group).toBe('private-provider')
    }
  })
})

import { buildCanvasRunPreflight } from './run-preflight'
import { matchingCanvasRunNodeIds } from './run-input-matching'
import type { CanvasRunGraph } from '../host'

describe('web search preflight and late-result matching', () => {
  function graph(): CanvasRunGraph { return { nodes: [{ id: 'search', kind: 'text-generate', definitionVersion: 1, data: { prompt: 'search', model: 'gpt-4.1', group: 'provider', textWebSearch: true } }, { id: 'next', kind: 'text-generate', definitionVersion: 1, data: { prompt: 'reuse', model: 'custom', group: 'provider' } }], edges: [{ id: 'edge', source: 'search', sourceHandle: 'out:text', target: 'next', targetHandle: 'in:text' }] } }
  it('discloses tool calls independently from model requests and never infers paid cache hits from an old result', () => {
    const result = buildCanvasRunPreflight({ graph: graph(), scope: { kind: 'all' }, imageModels: [], videoModels: [], textModels: ['gpt-4.1', 'custom'], cachedNodeIds: ['search'] })
    expect(result).toMatchObject({ canStart: true, textRequestCount: 2, webSearchRequestCount: 1, paidRequestCount: 2, cacheHitCount: 0 })
    expect(result.items[0]).toMatchObject({ webSearch: true, requestCount: 1 })
    expect(result.warnings.join('')).toContain('搜索费用')
  })
  it('rejects unknown search protocols and fences a changed search mode plus all descendants', () => {
    const old = graph(), changed = structuredClone(old); changed.nodes[0].data.textWebSearch = false
    expect([...matchingCanvasRunNodeIds(old, changed)]).toEqual([])
    delete changed.nodes[0].data.textWebSearch
    expect([...matchingCanvasRunNodeIds(old, changed)]).toEqual([])
    changed.nodes[0].data = { ...old.nodes[0].data, model: 'custom' }
    expect(buildCanvasRunPreflight({ graph: changed, scope: { kind: 'all' }, imageModels: [], videoModels: [], textModels: ['custom'] }).canStart).toBe(false)
  })
  it('discloses regeneration of a to-node search target while allowing upstream cache checks', () => {
    const value = graph()
    value.nodes[1].data = { ...value.nodes[1].data, model: 'gpt-4.1', textWebSearch: true }
    const result = buildCanvasRunPreflight({ graph: value, scope: { kind: 'to-node', nodeId: 'next' }, imageModels: [], videoModels: [], textModels: ['gpt-4.1'] })
    expect(result.canStart).toBe(true)
    expect(result.items.find((item) => item.nodeId === 'next')?.reason).toContain('将重新生成，不复用此节点结果')
    expect(result.items.find((item) => item.nodeId === 'search')?.reason).toContain('将核对服务端缓存')
    expect(result.warnings.join(' ')).toContain('选中目标将重新搜索，不复用此节点的旧结果；上游节点仍核对缓存')
    const selection = buildCanvasRunPreflight({ graph: value, scope: { kind: 'selection', nodeIds: ['next'] }, imageModels: [], videoModels: [], textModels: ['gpt-4.1'] })
    expect(selection.items.every((item) => !item.reason?.includes('将重新生成'))).toBe(true)
    expect(selection.warnings.join(' ')).not.toContain('目标将重新搜索')
    expect(selection.warnings.join(' ')).toContain('将核对服务端缓存，命中时复用原搜索结果与时间')
  })
  it('does not promise a paid rerun for local, disabled or blocked to-node targets', () => {
    const local: CanvasRunGraph = { nodes: [{ id: 'local', kind: 'prompt', definitionVersion: 1, data: { prompt: 'Body', model: '' } }], edges: [] }
    const localPlan = buildCanvasRunPreflight({ graph: local, scope: { kind: 'to-node', nodeId: 'local' }, imageModels: [], videoModels: [], textModels: [] })
    expect(localPlan.items[0]).toMatchObject({ paid: false, action: 'execute' })
    expect(localPlan.items[0].reason).toBeUndefined()
    for (const disabled of [true, false]) {
      const value = graph(); value.nodes = [value.nodes[0]]; value.edges = []
      if (disabled) value.nodes[0].disabled = true
      else value.nodes[0].data.group = ''
      const result = buildCanvasRunPreflight({ graph: value, scope: { kind: 'to-node', nodeId: 'search' }, imageModels: [], videoModels: [], textModels: ['gpt-4.1'] })
      expect(result.items[0].action).toBe(disabled ? 'skip' : 'blocked')
      expect(result.items[0].reason).not.toContain('将重新生成')
      expect(result.warnings.join(' ')).not.toContain('目标将重新搜索')
    }
  })
})
