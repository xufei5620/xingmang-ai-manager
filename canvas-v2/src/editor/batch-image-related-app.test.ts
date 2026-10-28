import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { parseImageCollageInputOrder } from '../image-tools/collage-input-order'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, undoCanvasHistory, redoCanvasHistory } from '../store/history'
import type { CanvasCommand } from '../store/canvas-command'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { analyzeBatchImageRelatedSources, batchImageRelatedConfig, batchImageRelatedCenter, buildBatchImageRelatedCommand, type BatchImageRelatedSource, type BatchImageRelatedTarget } from './batch-image-related'
import { findAvailableCanvasPosition } from './node-placement'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let found = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) found = node.initializer.arguments[0].getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source).replace(/^export /, '')
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
interface Session { sources: BatchImageRelatedSource[]; scope: string; preferredCenter?: { x: number; y: number } }
function fixture() {
  const nodes: CanvasNode[] = [
    { ...builtinNodeRegistry.create('group', 'group', { x: 100, y: 100 }), type: 'group', draggable: false, width: 800, height: 900, data: { prompt: '', status: 'idle', model: '' } },
    { ...builtinNodeRegistry.create('image-input', 'a', { x: 32, y: 96 }), type: 'image-input', parentId: 'group', draggable: false, data: { prompt: '', status: 'idle', model: '', result: { kind: 'image', assetId: 'same-asset', localUrl: 'xingmang-asset://image/same-asset', width: 640, height: 480 } } },
    { ...builtinNodeRegistry.create('image-input', 'b', { x: 1100, y: 20 }), type: 'image-input', data: { prompt: '', status: 'idle', model: '', result: { kind: 'image', assetId: 'same-asset', localUrl: 'xingmang-asset://image/same-asset', width: 640, height: 480 } } },
  ]
  let current = nodes, history = createCanvasHistory({ ...createCanvasDocument(), nodes: nodes.map(canvasNodeDocumentRecord) }), sequence = 0
  const batchImageRelatedRef: { current: Session | null } = { current: null }, projectEpochRef = { current: 3 }, activeProjectIdRef = { current: 'project' }, layerEditorOwnerRef = { current: { ownerId: 1, accountId: 'account' } }, draftActionsEnabledRef = { current: true }
  const scope = () => layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
  const toCanvas = (node: EditorNodeRecord): CanvasNode => ({ ...node, draggable: !node.locked, type: node.type as CanvasNode['type'], data: { prompt: '', status: 'idle', model: '', ...node.data } })
  const getGraphSnapshot = () => ({ nodes: current, edges: history.present.edges })
  const execute = vi.fn((command: CanvasCommand) => { history = applyCanvasCommand(history, command); current = history.present.nodes.map(toCanvas) })
  const setNodes = vi.fn((update: (nodes: CanvasNode[]) => CanvasNode[]) => { current = update(current) })
  const environment = {
    batchImageRelated: null as Session | null, batchImageRelatedRef, projectEpochRef, activeProjectIdRef, layerEditorOwnerRef, draftActionsEnabledRef, layerEditorScope: scope(), layerEditorScopeToken,
    mediaPreparationMountedRef: { current: true }, projectTransitionRef: { current: false }, graphRef: { current: getGraphSnapshot() },
    getGraphSnapshot, canvasNodeDocumentRecord, analyzeBatchImageRelatedSources, batchImageRelatedConfig, batchImageRelatedCenter, buildBatchImageRelatedCommand, builtinNodeRegistry, findAvailableCanvasPosition,
    setBanner: vi.fn(), setBatchImageRelated: vi.fn((value: Session | null) => { environment.batchImageRelated = value }), setBatchImageRelatedError: vi.fn(), setQuickInsert: vi.fn(), setContextMenu: vi.fn(),
    createNode: (type: string, position: { x: number; y: number }, config: Record<string, unknown>) => toCanvas({ ...builtinNodeRegistry.create(type, `new-${++sequence}`, position), data: { prompt: '', model: '', status: 'idle', settings: config } }),
    nextNodeId: () => `edge-${++sequence}`, toWorkflowEdge: (edge: EditorEdgeRecord) => edge, execute, setNodes, reactFlow: { fitView: vi.fn() },
  }
  const frames: Array<() => void> = []
  vi.stubGlobal('window', { requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length } })
  return { environment, original: structuredClone(nodes), current: () => current, history: () => history, frames, open: actual<(ids: string[], scope?: string) => void>('openBatchImageRelated', environment), confirm: () => actual<(type: BatchImageRelatedTarget) => void>('confirmBatchImageRelated', environment), replace: (nodes: CanvasNode[]) => { current = nodes } }
}
afterEach(() => vi.unstubAllGlobals())

describe('actual App multi-image creation callbacks', () => {
  it('uses a latest graph snapshot, preserves locked sources, keeps repeated assets, and commits one undoable graph change', () => {
    const f = fixture(), e = f.environment
    f.open(['a', 'b'])
    expect(e.batchImageRelated?.sources.map((node) => node.id)).toEqual(['b', 'a'])
    const before = f.history().present
    const confirm = f.confirm()
    confirm('image-collage')
    expect(e.execute).toHaveBeenCalledTimes(1)
    const command = e.execute.mock.calls[0][0]
    expect(command.type).toBe('add-nodes')
    expect(f.history().present.edges.map((edge) => [edge.source, edge.sourceHandle])).toEqual([['b', 'out:image'], ['a', 'out:image']])
    expect(f.history().present.nodes.slice(0, 3)).toEqual(before.nodes)
    expect(f.history().present.nodes.at(-1)?.parentId).toBeUndefined()
    expect(f.history().present.nodes.at(-1)?.data.settings).toMatchObject({ imageTransform: { rows: 1, columns: 2 } })
    expect(f.current().filter((node) => node.selected)).toHaveLength(1)
    expect(undoCanvasHistory(f.history()).present).toEqual(before)
    expect(redoCanvasHistory(undoCanvasHistory(f.history())).present).toEqual(f.history().present)
    confirm('image-collage')
    expect(e.execute).toHaveBeenCalledTimes(1)
    expect(e.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('尚未运行'))
  })

  it.each(['project', 'epoch', 'owner', 'account', 'locked', 'transition', 'unmounted'] as const)('rejects a retained callback after %s changes, including same-id project reload', (change) => {
    const f = fixture(), e = f.environment
    f.open(['a', 'b'])
    const confirm = f.confirm()
    if (change === 'project') e.activeProjectIdRef.current = 'other'
    if (change === 'epoch') e.projectEpochRef.current++
    if (change === 'owner') e.layerEditorOwnerRef.current.ownerId = 2
    if (change === 'account') e.layerEditorOwnerRef.current.accountId = 'other'
    if (change === 'locked') e.draftActionsEnabledRef.current = false
    if (change === 'transition') e.projectTransitionRef.current = true
    if (change === 'unmounted') e.mediaPreparationMountedRef.current = false
    confirm('image-layer')
    expect(e.execute).not.toHaveBeenCalled()
    expect(e.setNodes).not.toHaveBeenCalled()
  })

  it('does not open a stale captured menu or silently retarget its source ids to a new selection', () => {
    const f = fixture(), e = f.environment
    e.projectEpochRef.current++
    f.open(['a', 'b'])
    expect(e.setBatchImageRelated).not.toHaveBeenCalled()
    e.projectEpochRef.current--
    f.open(['group', 'a'])
    expect(e.setBatchImageRelated).not.toHaveBeenCalled()
    expect(e.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('分组'))
  })

  it('rechecks deletion and capacity at commit and retains the visible dialog error with zero document writes', () => {
    const f = fixture(), e = f.environment
    f.open(['a', 'b'])
    const confirm = f.confirm()
    f.replace(f.current().filter((node) => node.id !== 'b'))
    confirm('image-collage')
    expect(e.execute).not.toHaveBeenCalled()
    expect(e.setBatchImageRelatedError).toHaveBeenLastCalledWith(expect.stringContaining('已发生变化'))
    expect(e.batchImageRelatedRef.current).not.toBeNull()
  })

  it('includes newly arrived obstacles without moving earlier nodes and drops late viewport work after switching projects', () => {
    const f = fixture(), e = f.environment
    f.open(['a', 'b'])
    const obstacle: CanvasNode = { ...builtinNodeRegistry.create('group', 'later', { x: 1300, y: 0 }), type: 'group', width: 2000, height: 2000, data: { prompt: '', status: 'idle', model: '' } }
    f.replace([...f.current(), obstacle])
    f.confirm()('image-layer')
    const command = e.execute.mock.calls[0][0]
    if (command.type !== 'add-nodes') throw new Error('Expected atomic add')
    const placed = command.nodes[0]
    expect(placed.position.x + placed.width! <= obstacle.position.x || placed.position.x >= obstacle.position.x + obstacle.width! || placed.position.y + placed.height! <= obstacle.position.y || placed.position.y >= obstacle.position.y + obstacle.height!).toBe(true)
    e.projectEpochRef.current++
    f.frames.forEach((frame) => frame())
    expect(e.reactFlow.fitView).not.toHaveBeenCalled()
  })

  it('passes collage ordering through the real run projection only for collage nodes', () => {
    const f = fixture()
    const order = { version: 1, slots: [{ edgeId: 'e2', outputIndex: 0 }, { edgeId: 'e1', outputIndex: 0 }] }
    const nodes: CanvasNode[] = [{ ...f.current()[1], type: 'image-collage', data: { prompt: '', model: '', status: 'idle', settings: { ...batchImageRelatedConfig('image-collage', 2), imageCollageInputOrder: order } } }]
    const run = actual<(nodes: CanvasNode[], edges: EditorEdgeRecord[], groups: object) => { nodes: Array<{ data: Record<string, unknown> }> }>('toCanvasRunGraph', { parseImageCandidateCount, parseVideoCandidateCount, isCanvasGraphNode: () => true, imageTransformRecipeForNode, isImageTransformNodeKind, parseImageCollageInputOrder, toWorkflowEdge: (edge: EditorEdgeRecord) => edge })
    expect(run(nodes, [], { image: '', video: '' }).nodes[0].data.imageCollageInputOrder).toEqual(order)
    nodes[0].type = 'image-input'
    expect(run(nodes, [], { image: '', video: '' }).nodes[0].data).not.toHaveProperty('imageCollageInputOrder')
  })
})
