import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, workflowNodeData } from '../App'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { layerEditorScopeToken, assertLayerEditorScope } from './layer-editor-scope'
import { parseImageEditMask, imageEditMaskModelSupported, type ImageEditMask } from './image-edit-mask'
import { resolveImageMaskSource } from './image-mask-workflow'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, undoCanvasHistory } from '../store/history'
import type { CanvasCommand } from '../store/canvas-command'
import type { CanvasNode } from '../nodes/WorkflowNodes'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualApply(environment: Record<string, unknown>): (mask: ImageEditMask) => void {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'applyImageMask' && node.initializer) expression = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Missing mask callback')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}
const first = 'a'.repeat(43), second = 'b'.repeat(43)
function fixture(from: 'input' | 'output' = 'output') {
  const input = toCanvasNode({ id: 'source', kind: 'image-generate', definitionVersion: 1, position: { x: 100, y: 100 }, data: { prompt: 'Original', model: 'gpt-image-1', status: 'succeeded', candidateAssetIds: [first, second], result: { kind: 'image', assetId: second, localUrl: `xingmang-asset://image/${second}`, width: 384, height: 256 } } })
  const target = toCanvasNode({ id: 'edit', kind: 'image-edit', definitionVersion: 1, position: { x: 600, y: 100 }, data: { prompt: 'Edit', model: 'gpt-image-1', status: 'idle' } })
  const initial = from === 'input' ? [input, target] : [input]
  const edges = from === 'input' ? [{ id: 'edge', source: 'source', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:images' }] : []
  let history = createCanvasHistory({ ...createCanvasDocument(), nodes: initial.map(canvasNodeDocumentRecord), edges }), current = initial
  const owner = { current: { ownerId: 7, accountId: 'account' } }, project = { current: 'project' }, epoch = { current: 2 }, enabled = { current: true }
  const scope = layerEditorScopeToken({ ...owner.current, projectId: project.current, projectEpoch: epoch.current, enabled: true })
  const session = { nodeId: from === 'input' ? 'edit' : 'source', from, source: resolveImageMaskSource(current, edges, from === 'input' ? 'edit' : 'source', from), scope }
  const ref = { current: session as typeof session | null }, transition = { current: false }
  const execute = vi.fn((command: CanvasCommand) => { history = applyCanvasCommand(history, command); current = history.present.nodes.map(editorNodeToCanvasNode) })
  const getGraphSnapshot = () => ({ nodes: current, edges: history.present.edges })
  const setNodes = (update: (nodes: CanvasNode[]) => CanvasNode[]) => { current = update(current) }
  const createNode = (kind: 'image-edit', position: { x: number; y: number }, config: Record<string, unknown>) => toCanvasNode({ id: 'new-edit', kind, definitionVersion: 1, position, data: workflowNodeData(kind, config) })
  const markDirtyFrom = vi.fn((id: string, patch: Record<string, unknown>) => execute({ type: 'replace-nodes', nodes: current.map((node) => canvasNodeDocumentRecord(node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)) }))
  const fitView = vi.fn()
  vi.stubGlobal('window', { requestAnimationFrame: (callback: () => void) => callback() })
  const apply = actualApply({ imageMaskSession: session, imageMaskSessionRef: ref, assertLayerEditorScope, layerEditorOwnerRef: owner, activeProjectIdRef: project, projectEpochRef: epoch, draftActionsEnabledRef: enabled, projectTransitionRef: transition, running: false, startingRunsRef: { current: false }, getGraphSnapshot, resolveImageMaskSource, parseImageEditMask, markDirtyFrom, setBanner: vi.fn(), reactFlow: { getInternalNode: () => ({ internals: { positionAbsolute: { x: 300, y: 200 } } }), fitView }, builtinNodeRegistry, findAvailableCanvasPosition, imageEditMaskModelSupported, imageModels: ['gpt-image-1'], createNode, execute, canvasNodeDocumentRecord, nextNodeId: () => 'new-edge', graphRef: { current: getGraphSnapshot() }, setNodes, layerEditorScopeToken, setImageMaskSession: vi.fn() })
  return { apply, current: () => current, history: () => history, execute, epoch, enabled, transition, ref, initial, mutate: (transform: (nodes: CanvasNode[]) => CanvasNode[]) => { current = transform(current) }, mask: { version: 1, sourceAssetId: second, width: 384, height: 256, strokes: [{ tool: 'brush', size: .2, points: [{ x: .5, y: .5 }] }] } satisfies ImageEditMask }
}
afterEach(() => vi.unstubAllGlobals())

describe('actual App mask application transaction', () => {
  it('creates exactly one edit node with the selected second asset and a single-image edge, preserving original candidates', () => {
    const f = fixture(); f.apply(f.mask)
    expect(f.current()).toHaveLength(2)
    const output = f.current().find((node) => node.id === 'new-edit')!
    expect(output.type).toBe('image-edit'); expect(output.data.settings?.imageEditMask).toEqual(f.mask)
    expect(f.history().present.edges).toEqual([{ id: 'new-edge', source: 'source', sourceHandle: 'out:image', target: 'new-edit', targetHandle: 'in:images' }])
    expect(f.current()[0].data.result?.assetId).toBe(second); expect(f.current()[0].data.candidateAssetIds).toEqual([first, second])
    expect(undoCanvasHistory(f.history()).present.nodes).toHaveLength(1)
    expect(() => f.apply(f.mask)).toThrow('已结束'); expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('applies an edited mask as one undoable change without creating another node', () => {
    const f = fixture('input'); f.apply(f.mask)
    expect(f.current()).toHaveLength(2); expect(f.current()[1].data.settings?.imageEditMask).toEqual(f.mask)
    expect(Reflect.get(undoCanvasHistory(f.history()).present.nodes[1].data.settings ?? {}, 'imageEditMask')).toBeUndefined()
    expect(f.history().present.edges).toHaveLength(1)
  })
  it.each(['source', 'project', 'disabled', 'transition', 'locked'] as const)('rejects retained dialogs after %s changes without mutating any node', (change) => {
    const f = fixture()
    if (change === 'source') f.mutate((nodes) => nodes.map((node) => ({ ...node, data: { ...node.data, result: { ...node.data.result!, assetId: first } } })))
    if (change === 'project') f.epoch.current++
    if (change === 'disabled') f.enabled.current = false
    if (change === 'transition') f.transition.current = true
    if (change === 'locked') f.mutate((nodes) => nodes.map((node) => ({ ...node, draggable: false })))
    expect(() => f.apply(f.mask)).toThrow(); expect(f.execute).not.toHaveBeenCalled()
  })
})
