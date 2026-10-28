import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import { assertLayerEditorScope, layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { defaultImageTransformRecipe, imageTransformRecipeForNode } from '../image-tools/recipe'
import { parseTileInput, resolveTileInputSlots } from '../image-tools/tile-input'
import { tileEditorInputScope } from '../image-tools/tile-preview-state'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') callbacks.set(node.name.text, node.initializer.arguments[0].getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const callback = callbacks.get(name)
  if (!callback) throw new Error(`Missing App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function fixture() {
  let captured: CanvasDocumentController | undefined
  function project(record: EditorNodeRecord): CanvasNode { return { ...record, type: record.type as CanvasNode['type'], ...(record.locked ? { draggable: false } : {}), data: { prompt: '', model: '', status: 'idle', ...record.data } } }
  function Capture() { captured = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture)); if (!captured) throw new Error('No document controller')
  const controller = captured, original = (key: string) => ({ kind: 'image' as const, assetId: key.repeat(43), localUrl: `xingmang-asset://image/${key.repeat(43)}` })
  const a = builtinNodeRegistry.create('image-input', 'a', { x: 0, y: 0 }), b = builtinNodeRegistry.create('image-input', 'b', { x: 0, y: 300 }), tile = builtinNodeRegistry.create('image-tile', 'tile', { x: 500, y: 0 }), downstream = builtinNodeRegistry.create('image-crop', 'downstream', { x: 1000, y: 0 })
  a.data.result = original('a'); b.data.result = original('b'); tile.data.result = original('t'); downstream.data.result = original('d')
  controller.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [a, b, tile, downstream], edges: [{ id: 'edge-a', source: 'a', sourceHandle: 'out:image', target: 'tile', targetHandle: 'in:image' }, { id: 'edge-b', source: 'b', sourceHandle: 'out:image', target: 'tile', targetHandle: 'in:image' }, { id: 'tile-output', source: 'tile', sourceHandle: 'out:image', target: 'downstream', targetHandle: 'in:image' }] } })
  const getGraphSnapshot = controller.getGraphSnapshot, graphRef = { current: getGraphSnapshot() }, execute = vi.fn(controller.execute)
  const layerEditorOwnerRef = { current: { ownerId: 7, accountId: 'account-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }
  const agentMountedRef = { current: true }, draftActionsEnabledRef = { current: true }, projectCanEditRef = { current: true }, projectTransitionRef = { current: false }, activeRunsRef = { current: new Set<string>() }, startingRunsRef = { current: 0 }, pendingRunProjectionIdsRef = { current: new Set<string>() }
  const host = { saveAsset: vi.fn().mockResolvedValue({ saved: true }), startRun: vi.fn(), generateImage: vi.fn() }, setBanner = vi.fn()
  const environment: Record<string, unknown> = { assertLayerEditorScope, layerEditorScopeToken, buildCanvasUpstreamReferences, tileEditorInputScope, parseTileInput, resolveTileInputSlots, imageTransformRecipeForNode, markNodeAndDescendantsDirty, canvasNodeDocumentRecord, getGraphSnapshot, graphRef, execute, nodes: getGraphSnapshot().nodes, assetCatalog: [], setDirtyNodeIds: vi.fn(), setBanner, hostBridge: () => host, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, agentMountedRef, draftActionsEnabledRef, projectCanEditRef, projectTransitionRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef }
  for (const name of ['markDirtyFrom', 'inspectTileEditor']) environment[name] = (...args: unknown[]) => actual<(...values: unknown[]) => unknown>(name, environment)(...args)
  function call<T>(name: string, ...args: unknown[]) { return actual<(...values: unknown[]) => T>(name, environment)(...args) }
  function node() { return getGraphSnapshot().nodes.find((entry) => entry.id === 'tile')! }
  function inputScope() { const current = getGraphSnapshot(); return tileEditorInputScope(buildCanvasUpstreamReferences(current.nodes, current.edges, []).get('tile') ?? [], node().data.settings?.tileInput) }
  function editorScope() { return layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current }) }
  function change(patch: Record<string, unknown>, scope = editorScope(), inputs = inputScope()) { call('changeTileSettings', 'tile', patch, scope, inputs) }
  function patch(id: string, changes: Partial<CanvasNode>) { controller.setNodes((nodes) => nodes.map((entry) => entry.id === id ? { ...entry, ...changes } : entry)); graphRef.current = getGraphSnapshot() }
  function download(edgeId: string, scope = editorScope(), inputs = inputScope()) { return call<Promise<void>>('downloadTileSource', 'tile', { edgeId }, scope, inputs) }
  return { controller, current: getGraphSnapshot, graphRef, execute, environment, node, inputScope, editorScope, change, patch, download, host, setBanner, original, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, agentMountedRef, draftActionsEnabledRef, projectCanEditRef, projectTransitionRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef }
}

describe('actual App tile selection callbacks', () => {
  it('persists stable source selection as one undoable change and dirties only its downstream', () => {
    const f = fixture(), before = structuredClone(f.current())
    f.change({ tileInput: { edgeId: 'edge-b' } })
    expect(f.node().data.settings?.tileInput).toEqual({ edgeId: 'edge-b', outputIndex: 0 })
    expect(f.current().nodes.filter((node) => node.data.dirty).map((node) => node.id)).toEqual(['tile', 'downstream'])
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
    f.controller.undo(); expect(f.current()).toEqual(before)
    f.controller.redo(); expect(f.node().data.settings?.tileInput).toEqual({ edgeId: 'edge-b', outputIndex: 0 })
  })
  it('retains the selected source while applying processing parameters and does not create a no-op undo entry', () => {
    const f = fixture(); f.change({ tileInput: { edgeId: 'edge-b' } }); const recipe = { ...defaultImageTransformRecipe('tile'), rows: 2 }
    f.change({ imageTransform: recipe }); expect(f.node().data.settings).toMatchObject({ imageTransform: recipe, tileInput: { edgeId: 'edge-b', outputIndex: 0 } })
    f.change({ imageTransform: recipe }); expect(f.execute).toHaveBeenCalledTimes(2)
    f.controller.undo(); expect(f.node().data.settings?.tileInput).toEqual({ edgeId: 'edge-b', outputIndex: 0 }); expect(f.node().data.settings?.imageTransform).not.toEqual(recipe)
  })
  it.each(['account', 'project', 'epoch', 'unmounted', 'disabled', 'transition', 'read-only', 'run', 'starting', 'projection', 'locked', 'parent-locked', 'node-running', 'node-deleted', 'source-changed', 'edge-removed'] as const)('rejects stale or forbidden edits after %s changes', (condition) => {
    const f = fixture(), scope = f.editorScope(), inputs = f.inputScope()
    if (condition === 'account') f.layerEditorOwnerRef.current.accountId = 'other'
    if (condition === 'project') f.activeProjectIdRef.current = 'other'
    if (condition === 'epoch') f.projectEpochRef.current++
    if (condition === 'unmounted') f.agentMountedRef.current = false
    if (condition === 'disabled') f.draftActionsEnabledRef.current = false
    if (condition === 'transition') f.projectTransitionRef.current = true
    if (condition === 'read-only') f.projectCanEditRef.current = false
    if (condition === 'run') f.activeRunsRef.current.add('run')
    if (condition === 'starting') f.startingRunsRef.current++
    if (condition === 'projection') f.pendingRunProjectionIdsRef.current.add('projection')
    if (condition === 'locked') f.patch('tile', { draggable: false })
    if (condition === 'parent-locked') { f.controller.execute({ type: 'add-nodes', nodes: [{ ...builtinNodeRegistry.create('group', 'group', { x: 0, y: 0 }), locked: true }] }); f.patch('tile', { parentId: 'group' }) }
    if (condition === 'node-running') f.patch('tile', { data: { ...f.node().data, status: 'running' } })
    if (condition === 'node-deleted') f.controller.setNodes((nodes) => nodes.filter((node) => node.id !== 'tile'))
    if (condition === 'source-changed') f.patch('b', { data: { prompt: '', model: '', status: 'idle', result: f.original('c') } })
    if (condition === 'edge-removed') f.controller.setEdges((edges) => edges.filter((edge) => edge.id !== 'edge-b'))
    const before = structuredClone(f.current()); expect(() => f.change({ tileInput: { edgeId: 'edge-b' } }, scope, inputs)).toThrow(); expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects unconnected identities and unsupported patches without falling back to another input', () => {
    const f = fixture()
    for (const patch of [{ tileInput: { edgeId: 'missing' } }, { tileInput: { missing: true } }, { tileInput: { edgeId: 'edge-a', outputIndex: 2 } }, { imageTransform: { kind: 'crop' } }, { extra: true }]) expect(() => f.change(patch)).toThrow()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('downloads the selected owned original in read-only mode without exporting the processed tile result', async () => {
    const f = fixture(); f.change({ tileInput: { edgeId: 'edge-b' } }); f.projectCanEditRef.current = false
    await f.download('edge-b'); expect(f.host.saveAsset).toHaveBeenCalledExactlyOnceWith('b'.repeat(43))
    await expect(f.download('edge-a')).rejects.toThrow(); expect(f.host.saveAsset).toHaveBeenCalledOnce()
    const scope = f.editorScope(), inputs = f.inputScope(); f.projectEpochRef.current++
    await expect(f.download('edge-b', scope, inputs)).rejects.toThrow(); expect(f.host.saveAsset).toHaveBeenCalledOnce()
  })
  it('does not download another source when the default source is still waiting or an explicit source is removed', async () => {
    const f = fixture(); f.patch('a', { data: { prompt: '', model: '', status: 'idle' } })
    await expect(f.download('edge-a')).rejects.toThrow(); await expect(f.download('edge-b')).rejects.toThrow()
    f.change({ tileInput: { edgeId: 'edge-b' } }); f.controller.setEdges((edges) => edges.filter((edge) => edge.id !== 'edge-b'))
    await expect(f.download('edge-b')).rejects.toThrow(); expect(f.host.saveAsset).not.toHaveBeenCalled()
  })
  it('resolves a newly processed output at click time even when the registered callback predates projection', async () => {
    const f = fixture(), save = actual<(nodeId: string) => Promise<void>>('downloadNodeAsset', f.environment)
    f.patch('tile', { data: { ...f.node().data, result: f.original('n') } })
    await save('tile'); expect(f.host.saveAsset).toHaveBeenCalledExactlyOnceWith('n'.repeat(43)); expect(f.setBanner.mock.calls).toEqual([['正在保存产物…'], ['产物已保存']])
    f.host.saveAsset.mockRejectedValueOnce(new Error('原素材暂不可读')); await save('tile'); expect(f.setBanner).toHaveBeenLastCalledWith('原素材暂不可读')
    f.patch('tile', { data: { ...f.node().data, result: undefined } }); await save('tile'); expect(f.host.saveAsset).toHaveBeenCalledTimes(2); expect(f.setBanner).toHaveBeenLastCalledWith('当前节点还没有可下载的产物，请等待处理完成')
  })
  it('does not publish a delayed download result into another project session', async () => {
    const f = fixture(); let resolve: (value: { saved: boolean }) => void = () => {}
    f.host.saveAsset.mockReturnValueOnce(new Promise<{ saved: boolean }>((done) => { resolve = done }))
    const save = actual<(nodeId: string) => Promise<void>>('downloadNodeAsset', f.environment), pending = save('tile')
    f.projectEpochRef.current++; resolve({ saved: true }); await pending
    expect(f.setBanner.mock.calls).toEqual([['正在保存产物…']])
    f.projectTransitionRef.current = true; await save('tile'); expect(f.host.saveAsset).toHaveBeenCalledOnce()
  })
})
