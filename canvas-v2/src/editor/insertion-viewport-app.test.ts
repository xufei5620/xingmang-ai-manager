import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasWorkshopItem } from '../host'
import { createEmptyWorkflow, type WorkflowNode } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { dirtyCanvasNodeIds } from '../runtime/run-projection'
import { createCanvasDocument, type CanvasViewport } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { instantiateWorkshopGraph } from './workshop-graph'
import { fitCanvasViewport } from './canvas-viewport'
import { createCreatedNodeFocusCoordinator } from './node-focus'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source))
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'createCreatedNodeFocusCoordinator') callbacks.set('CreatedNodeFocus.adapter', node.arguments[0].getText(source))
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'ReactFlow') {
    for (const attr of node.attributes.properties) if (ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) callbacks.set(`ReactFlow.${attr.name.getText(source)}`, attr.initializer.expression.getText(source))
  }
  ts.forEachChild(node, visit)
}
visit(source)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const expression = callbacks.get(name)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function renderNode(node: EditorNodeRecord): CanvasNode {
  return { ...node, type: node.type as CanvasNode['type'], data: { prompt: '', model: '', status: 'idle', ...node.data }, width: 240, height: 180 }
}
function fixture() {
  let captured: CanvasDocumentController | undefined
  function Capture() { captured = useCanvasDocument(renderNode); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing document controller')
  const controller = captured, frames: Array<() => void> = []
  const before = { x: 42, y: 18, zoom: .8 }, camera = { current: { ...before } }
  const original: EditorNodeRecord[] = [{ id: 'original', type: 'prompt', definitionVersion: 1, position: { x: 80, y: 80 }, data: { prompt: 'Original', model: '' } }, { id: 'original-output', type: 'output', definitionVersion: 1, position: { x: 420, y: 80 }, data: { prompt: '', model: '' } }]
  const originalEdge = { id: 'original-edge', source: 'original', sourceHandle: 'out:text', target: 'original-output', targetHandle: 'in:text' }
  controller.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: original, edges: [originalEdge], viewport: before } })
  const scope = { current: 1 }, project = { current: 'project-a' }, enabled = { current: true }, transition = { current: false }
  let serial = 0
  const flow = {
    getViewport: () => ({ ...camera.current }),
    getNodes: () => controller.getGraphSnapshot().nodes,
    getNode: (id: string) => controller.getGraphSnapshot().nodes.find((node) => node.id === id),
    getInternalNode: (_id: string) => undefined,
    getNodesBounds: (nodes: CanvasNode[]) => {
      const x = Math.min(...nodes.map((node) => node.position.x)), y = Math.min(...nodes.map((node) => node.position.y))
      return { x, y, width: Math.max(...nodes.map((node) => node.position.x + 240)) - x, height: Math.max(...nodes.map((node) => node.position.y + 180)) - y }
    },
    setViewport: vi.fn(async (value: CanvasViewport) => { camera.current = { ...value }; controller.setViewport(value); return true }),
    fitView: vi.fn(async (options: { nodes: Array<{ id: string }> }) => {
      if (!options.nodes.some((node) => controller.getGraphSnapshot().nodes.some((current) => current.id === node.id))) return false
      camera.current = { x: 200, y: -800, zoom: .7 }; controller.setViewport(camera.current); return true
    }),
  }
  const environment: Record<string, unknown> = {
    collaborationRef: { current: null },
    documentController: controller, undoDocument: controller.undo, redoDocument: controller.redo, execute: controller.execute,
    isInsertionViewportCurrent: controller.isInsertionViewportCurrent, cancelDocumentInsertionViewportNavigation: controller.cancelInsertionViewportNavigation,
    getGraphSnapshot: controller.getGraphSnapshot, graphRef: { current: controller.getGraphSnapshot() }, dirtyCanvasNodeIds,
    projectEpochRef: scope, activeProjectIdRef: project, workshopProjectEpoch: 1, activeProject: { id: 'project-a' }, draftActionsEnabledRef: enabled, projectCanEditRef: { current: true }, projectTransitionRef: transition,
    layerEditorOwnerRef: { current: { ownerId: 1, accountId: 'account-a' } },
    hostBridge: () => ({}), templateCreatedProjectRef: { current: null }, templateProjectSubmissionRef: { current: { settled: vi.fn() } }, mediaGroups: {},
    get nodes() { return controller.getGraphSnapshot().nodes }, nextNodeId: () => `copy-${++serial}`,
    instantiateWorkshopGraph, canvasNodeDocumentRecord, toCanvasNode: (node: WorkflowNode) => renderNode({ ...node, data: { ...node.data }, definitionVersion: node.definitionVersion ?? 1, type: node.kind }),
    setNodes: controller.setNodes, setDocumentViewport: controller.setViewport, setDirtyNodeIds: vi.fn(), openWorkshopSetup: vi.fn(), setWorkshopCatalog: vi.fn(), setBanner: vi.fn(),
    reactFlow: flow, currentReactFlowRef: { current: flow }, createdNodeFocusRef: { current: { cancel: vi.fn() } }, viewportRestorationRef: { current: { cancel: vi.fn(), request: (viewport: CanvasViewport) => { void flow.setViewport(viewport) } } }, overviewViewportRef: { current: null },
    insertionViewportFrameRef: { current: null }, insertionViewportFocusRevisionRef: { current: 0 },
    document: { querySelector: () => ({}) }, fitCanvasViewport, measureCanvasSafeViewport: () => ({ x: 12, y: 12, width: 900, height: 560 }),
    setInspectorTab: vi.fn(), setAssetTrayOpen: vi.fn(), setRunInspectorOpen: vi.fn(), setNodeInspectorOpen: vi.fn(),
    window: { location: { href: 'http://fixture.invalid/canvas?project=project-a' }, requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length }, cancelAnimationFrame: vi.fn() },
  }
  for (const name of ['cancelInsertionViewportFocus', 'cancelInsertionViewportNavigation', 'focusInsertedNodes', 'fitCanvasNodes']) environment[name] = actual(name, environment)
  environment.restoreCanvasViewport = actual('restoreCanvasViewport', environment)
  const workflow = createEmptyWorkflow('Copy')
  workflow.nodes = [{ id: 'brief', kind: 'prompt', position: { x: 0, y: 0 }, data: { prompt: 'Copy', model: '', status: 'idle' } }, { id: 'result', kind: 'output', position: { x: 360, y: 0 }, data: { prompt: '', model: '', status: 'idle' } }]
  workflow.edges = [{ id: 'brief-result', source: 'brief', sourceHandle: 'out:text', target: 'result', targetHandle: 'in:text' }]
  const item: CanvasWorkshopItem = { id: 'workshop', version: 1, kind: 'group', name: 'Copy', description: '', tags: [], category: 'general', nodeCount: 2, edgeCount: 1, nodeKinds: ['prompt', 'output'], createdAt: '', updatedAt: '', workflow }
  function call<T>(name: string, ...args: unknown[]): T { return actual<(...values: unknown[]) => T>(name, environment)(...args) }
  async function flush() { while (frames.length) { frames.shift()!(); await Promise.resolve() } }
  return { controller, frames, camera, before, originalEdge, flow, environment, scope, project, call, flush, item }
}

describe('actual workshop insertion camera with graph undo', () => {
  it('reveals the original graph after undo and refocuses a complete independent copy after redo', async () => {
    const f = fixture(), original = structuredClone(f.controller.getGraphSnapshot())
    await f.call<Promise<void>>('insertWorkshopItem', f.item); await f.flush()
    const inserted = structuredClone(f.controller.getGraphSnapshot())
    expect(inserted.nodes).toHaveLength(4); expect(inserted.edges).toHaveLength(2)
    expect(f.camera.current).not.toEqual(f.before)
    f.call('undo'); await f.flush()
    expect(f.controller.getGraphSnapshot().nodes.map(canvasNodeDocumentRecord)).toEqual(original.nodes.map(canvasNodeDocumentRecord))
    expect(f.controller.getGraphSnapshot().edges).toEqual(original.edges)
    expect(f.camera.current).toEqual(f.before)
    f.call('redo'); await f.flush()
    expect(f.controller.getGraphSnapshot().nodes.map((node) => [node.id, node.position])).toEqual(inserted.nodes.map((node) => [node.id, node.position]))
    expect(f.controller.getGraphSnapshot().edges).toEqual(inserted.edges)
    expect(f.camera.current).not.toEqual(f.before)
  })

  it('does not let a queued insertion fit override a later manual camera gesture', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item)
    f.call('ReactFlow.onMoveStart', { type: 'wheel' })
    const manual = { x: 333, y: 444, zoom: .6 }
    await f.flow.setViewport(manual); await f.flush()
    expect(f.camera.current).toEqual(manual)
    f.call('undo'); await f.flush()
    expect(f.camera.current).toEqual(manual)
  })

  it('does not dispatch the queued fit after its insertion was undone', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item)
    f.call('undo'); await f.flush()
    expect(f.flow.fitView).not.toHaveBeenCalled()
    expect(f.controller.getGraphSnapshot().nodes).toHaveLength(2)
  })

  it('does not move a different project from an old insertion animation frame', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item)
    f.scope.current++; f.project.current = 'project-b'; await f.flush()
    expect(f.flow.fitView).not.toHaveBeenCalled()
    expect(f.flow.setViewport).not.toHaveBeenCalled()
  })

  it('ignores an obsolete frame even when undo redo makes the same insertion token current again', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item)
    f.call('undo'); f.call('redo')
    f.flow.setViewport.mockClear(); await f.flush()
    expect(f.flow.setViewport).toHaveBeenCalledOnce()
    expect(f.controller.getGraphSnapshot().nodes).toHaveLength(4)
  })

  it('waits for the inserted nodes to reach the live pane without targeting the original graph', async () => {
    const f = fixture(), original = f.controller.getGraphSnapshot().nodes
    vi.spyOn(f.flow, 'getNodes').mockImplementationOnce(() => original)
    await f.call<Promise<void>>('insertWorkshopItem', f.item); await f.flush()
    expect(f.flow.setViewport).toHaveBeenCalledOnce()
    expect(f.camera.current).not.toEqual(f.before)
  })

  it('keeps a manual view chosen after completed insertion through undo redo', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item); await f.flush()
    f.call('ReactFlow.onMoveStart', { type: 'pointerdown' })
    const manual = { x: 12, y: 34, zoom: .45 }
    await f.flow.setViewport(manual)
    f.call('undo'); f.call('redo'); await f.flush()
    expect(f.camera.current).toEqual(manual)
    expect(f.controller.getGraphSnapshot().nodes).toHaveLength(4)
  })

  it('does not complete auto-focus after editing permission is revoked', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item)
    const access = f.environment.projectCanEditRef as { current: boolean }
    access.current = false
    await f.flush()
    expect(f.flow.setViewport).not.toHaveBeenCalled()
  })

  it('does not target a new account even if project identity and epoch have not rendered yet', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item)
    const owner = f.environment.layerEditorOwnerRef as { current: { ownerId: number; accountId: string } }
    owner.current = { ownerId: 2, accountId: 'account-b' }
    await f.flush()
    expect(f.flow.setViewport).not.toHaveBeenCalled()
  })

  it('preserves an explicit node lookup camera instead of restoring the old insertion view', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item); await f.flush()
    f.call('locateNode', 'original'); await f.flush()
    const located = { ...f.camera.current }
    f.call('undo'); await f.flush()
    expect(f.camera.current).toEqual(located)
    expect(f.controller.getGraphSnapshot().nodes).toHaveLength(2)
  })

  it('treats later created-node focus as new navigation before undo reaches the older insertion', async () => {
    const f = fixture()
    await f.call<Promise<void>>('insertWorkshopItem', f.item); await f.flush()
    f.controller.execute({ type: 'add-nodes', nodes: [{ id: 'later', type: 'prompt', definitionVersion: 1, position: { x: 400, y: 900 }, data: { prompt: '', model: '' } }] })
    const adapter = actual<Parameters<typeof createCreatedNodeFocusCoordinator>[0]>('CreatedNodeFocus.adapter', f.environment)
    const focus = createCreatedNodeFocusCoordinator(adapter), later = { x: -300, y: -500, zoom: .9 }
    focus.start('later', { width: 240, height: 180 }, () => { void f.flow.setViewport(later) })
    await f.flush()
    f.call('undo'); f.call('undo'); await f.flush()
    expect(f.camera.current).toEqual(later)
    expect(f.controller.getGraphSnapshot().nodes).toHaveLength(2)
  })
})
