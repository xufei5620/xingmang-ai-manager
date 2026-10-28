import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph, CanvasRunRecord } from './host'
import { builtinNodeRegistry } from './domain/builtin-node-definitions'
import { createMockExecutors } from './engine/engine'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowNode } from './model'
import { buildCanvasRunPreflight } from './runtime/run-preflight'
import { latestGeneratedOutputText, projectRunRecordToNodes } from './runtime/run-projection'

function textNode(kind: WorkflowNode['kind'] = 'text-generate'): WorkflowNode {
  return { id: 'text', kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'original instructions', model: kind === 'text-generate' ? 'gpt-4o-mini' : '', status: 'idle' } }
}

function textRun(outputText = 'generated result'): CanvasRunRecord {
  const at = '2026-10-10T12:00:00.000Z'
  return { version: 1, projectId: 'project', runId: 'run', userId: 1, ownerId: 1, graphRevision: 'revision', scope: { kind: 'all' }, status: 'succeeded', createdAt: at, startedAt: at, events: [], nodes: [{ nodeId: 'text', kind: 'text-generate', state: 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: 'fingerprint', state: 'succeeded', startedAt: at, completedAt: at, durationMs: 10, cached: false, candidates: [], outputText }] }] }
}

describe('independent text generation', () => {
  it('declares text and visual inputs without changing prompt semantics', () => {
    const definition = builtinNodeRegistry.require('text-generate')
    expect(definition.executorKind).toBe('text')
    expect(definition.ports.map((port) => [port.id, port.cardinality])).toEqual([['in:text', 'many'], ['in:images', 'many'], ['out:text', 'many']])
    expect(builtinNodeRegistry.require('prompt').executorKind).toBe('prompt')
  })

  it('persists generated output separately from the reusable input prompt', () => {
    const workflow = createEmptyWorkflow('text')
    const node = textNode()
    node.data.outputText = 'generated result'
    workflow.nodes = [node]
    const restored = parseWorkflowFile(serializeWorkflow(workflow))
    expect(restored?.nodes[0].data).toMatchObject({ prompt: 'original instructions', outputText: 'generated result', status: 'succeeded' })
  })

  it('limits generated output to 32000 characters and does not persist it on prompt nodes', () => {
    const workflow = createEmptyWorkflow('text')
    const node = textNode()
    node.data.outputText = 'x'.repeat(32_001)
    const prompt = textNode('prompt')
    prompt.id = 'prompt'
    prompt.data.outputText = 'accidental output'
    workflow.nodes = [node, prompt]
    const restored = parseWorkflowFile(serializeWorkflow(workflow))
    expect(restored?.nodes[0].data.outputText?.length).toBe(32_000)
    expect(restored?.nodes[1].data.outputText).toBeUndefined()
  })

  it('projects text output without replacing input and ignores a later failed attempt', () => {
    const run = textRun('result')
    run.nodes[0].attempts.push({ ...run.nodes[0].attempts[0], attemptId: 'failed-attempt', state: 'failed', outputText: undefined })
    expect(latestGeneratedOutputText(run.nodes[0])).toBe('result')
    expect(projectRunRecordToNodes([textNode()], run)[0].data).toMatchObject({ prompt: 'original instructions', outputText: 'result' })
  })

  it('does not overwrite text results when the submitted input no longer matches', () => {
    const node = textNode()
    node.data.prompt = 'edited instructions'
    node.data.outputText = 'previous output'
    const result = projectRunRecordToNodes([node], textRun(), [], new Set())
    expect(result[0].data).toMatchObject({ prompt: 'edited instructions', outputText: 'previous output', dirty: true })
  })

  it('preserves local passthrough executors for text and prompt', async () => {
    const executors = createMockExecutors(0)
    const signal = new AbortController().signal
    expect(await executors.text(textNode('text'), {}, signal)).toEqual({ output: { text: 'original instructions' } })
    expect(await executors.prompt(textNode('prompt'), {}, signal)).toEqual({ output: { text: 'original instructions' } })
    await expect(executors['text-generate'](textNode(), {}, signal)).rejects.toThrow('尚未接入')
  })

  it('charges only explicit generation nodes in preflight and validates text model configuration', () => {
    const graph: CanvasRunGraph = { nodes: ['text', 'prompt', 'text-generate'].map((kind, index) => ({ id: String(index), kind, definitionVersion: 1, data: { prompt: 'input', model: kind === 'text-generate' ? 'gpt-4o-mini' : '', ...(kind === 'text-generate' ? { group: 'source' } : {}) } })), edges: [] }
    const result = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [], videoModels: [], textModels: ['gpt-4o-mini'], textGroup: 'source' })
    expect(result).toMatchObject({ paidRequestCount: 1, textRequestCount: 1, blockedCount: 0, canStart: true })
    const unavailable = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [], videoModels: [], textModels: [], textGroup: 'source' })
    expect(unavailable).toMatchObject({ blockedCount: 1, canStart: false })
  })

  it('discloses the paid upper bound even when a generated node has an existing result', () => {
    const graph: CanvasRunGraph = { nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'edited prompt', model: 'gpt-image-1', group: 'source', adoptedAssetId: 'old-asset' } }], edges: [] }
    const result = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, cachedNodeIds: ['image'], imageGroup: 'source', imageModels: ['gpt-image-1'], videoModels: [] })
    expect(result).toMatchObject({ paidRequestCount: 1, imageRequestCount: 1, cacheHitCount: 0 })
    expect(result.items[0]).toMatchObject({ action: 'execute', reason: '将核对服务端缓存；未命中时提交付费生成请求' })
  })
})
