import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { operationDefaultsForTemplateNode } from '../domain/workflow-node-config'
import { preferredModelForNodeType } from '../library/media-groups'
import { parsePromptReferences } from '../library/prompt-references'
import { parseTextWebSearch } from '../runtime/text-web-search'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { maximumOutputTextLength } from '../persistence/workflow-schema'
import type { NodeKind, WorkflowNode, WorkflowNodeData } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { createdNodeFocusZoom, createdNodeNeedsFocus } from './node-focus'
import { findAvailableCanvasPosition, type CanvasPlacementNode } from './node-placement'
import { canvasNodeKindAvailable } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { canvasRunInputForHost, withoutHostDisabledDefaults } from '../runtime/host-run-compatibility'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export\s+/, '')
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isArrowFunction(node.initializer)) expression = node.initializer.getText(source)
    if (name === 'quickAddNode' && ts.isJsxAttribute(node) && node.name.getText(source) === 'onAddNode' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isArrowFunction(node.initializer.expression)) expression = node.initializer.expression.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function fixture(initial: CanvasNode[] = []) {
  const toCanvasNode = actual<(node: WorkflowNode) => CanvasNode>('toCanvasNode', { canvasNodeDisplayGeometry })
  function projectNode(record: EditorNodeRecord): CanvasNode { return toCanvasNode({ ...record, kind: record.type as NodeKind, data: { prompt: '', model: '', status: 'idle', ...record.data } }) }
  let captured: CanvasDocumentController | undefined
  function Capture() { captured = useCanvasDocument(projectNode); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing document controller')
  const target = captured
  target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: initial.map(canvasNodeDocumentRecord) } })
  target.setNodes(initial)
  let sequence = 0
  const nextNodeId = () => `quick-${++sequence}`, mediaGroups = {}, imageModels: string[] = [], videoModels: string[] = []
  const workflowNodeData = actual<(type: string, config?: Record<string, unknown>) => WorkflowNodeData>('workflowNodeData', { builtinNodeRegistry, parsePromptReferences, parseImageCandidateCount, parseVideoCandidateCount, parseTextWebSearch, maximumOutputTextLength })
  const imageOperationDefaults = actual<(type: string, imageModels: string[], videoModels: string[], preferred: Record<string, unknown>) => Record<string, unknown>>('imageOperationDefaults', { operationDefaultsForTemplateNode })
  const createNode = actual<(type: string, position?: { x: number; y: number }, config?: Record<string, unknown>) => CanvasNode | null>('createNode', { canvasCapabilities: () => fullCanvasCapabilityProfile, canvasNodeKindAvailable, canvasRunInputForHost, withoutHostDisabledDefaults, builtinNodeRegistry, preferredModelForNodeType, mediaGroups, imageModels, videoModels, nextNodeId, workflowNodeData, imageOperationDefaults, toCanvasNode })
  const setCenter = vi.fn(), setBanner = vi.fn(), focus = vi.fn(), projectCanEditRef = { current: true }
  const reactFlow = { screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }), setCenter, getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }
  vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) }) })
  const environment = { nodes: initial, getGraphSnapshot: target.getGraphSnapshot, setNodes: target.setNodes, execute: vi.fn(target.execute), builtinNodeRegistry, findAvailableCanvasPosition, createNode, canvasNodeDocumentRecord, projectCanEditRef, setBanner, reactFlow, createdNodeFocusRef: { current: { start: focus } }, createdNodeNeedsFocus, createdNodeFocusZoom }
  const add = actual<(type: string, position?: { x: number; y: number }, config?: Record<string, unknown>) => void>('addNode', environment)
  function quick(quickInsert: unknown) {
    const insertNodeOnEdge = vi.fn(), addConnectedNode = vi.fn(), addNode = vi.fn(add)
    return { insertNodeOnEdge, addConnectedNode, addNode, run: actual<(type: string) => void>('quickAddNode', { quickInsert, insertNodeOnEdge, addConnectedNode, addNode }) }
  }
  return { target, add, quick, ...environment }
}
function node(id: string, type: NodeKind, position = { x: 100, y: 100 }, extras: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type, definitionVersion: 1, position, width: 280, height: 280, data: { prompt: '', model: '', status: 'idle' }, ...extras }
}
function separated(position: { x: number; y: number }, dimensions: { width: number; height: number }, obstacle: CanvasPlacementNode, gap = 28): boolean {
  return position.x + dimensions.width + gap <= obstacle.position.x || obstacle.position.x + (obstacle.width ?? 280) + gap <= position.x
    || position.y + dimensions.height + gap <= obstacle.position.y || obstacle.position.y + (obstacle.height ?? 220) + gap <= position.y
}
afterEach(() => vi.unstubAllGlobals())

describe('actual App ordinary quick creation placement', () => {
  it('avoids an uploaded image instead of covering its output port at the toolbar position', () => {
    const input = node('source', 'image-input', { x: 600, y: 304 }, { width: 280, height: 210, measured: { width: 280, height: 210 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: 'a'.repeat(43), width: 640, height: 480 } } })
    const f = fixture([input]), quick = f.quick({ flowPosition: { ...input.position } })
    quick.run('image-layer')
    const added = f.target.getGraphSnapshot().nodes.find((entry) => entry.id !== input.id)!
    expect(added.type).toBe('image-layer')
    expect(separated(added.position, builtinNodeRegistry.require('image-layer').dimensions, input)).toBe(true)
    expect(f.target.getGraphSnapshot().nodes[0].position).toEqual(input.position)
    expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'add-nodes' }))
    expect(f.target.getGraphSnapshot().edges).toEqual([])
  })
  it('keeps an unobstructed explicit mouse position unchanged rather than re-centering it', () => {
    const f = fixture([node('far', 'prompt', { x: -2000, y: -2000 })]), position = { x: 123.5, y: -42.25 }
    f.add('image-layer', position)
    expect(f.target.getGraphSnapshot().nodes.at(-1)?.position).toEqual(position)
  })
  it('uses the live graph for repeated quick additions before a React rerender and undoes each addition once', () => {
    const f = fixture(), quick = f.quick({ flowPosition: { x: 600, y: 304 } })
    for (const kind of ['prompt', 'image-input', 'image-layer', 'text-generate']) quick.run(kind)
    const nodes = f.target.getGraphSnapshot().nodes, before = structuredClone(nodes)
    for (let i = 0; i < nodes.length; i++) {
      const size = builtinNodeRegistry.require(nodes[i].type!).dimensions
      for (const other of nodes.slice(i + 1)) expect(separated(nodes[i].position, size, { ...other, ...builtinNodeRegistry.require(other.type!).dimensions })).toBe(true)
    }
    expect(f.execute).toHaveBeenCalledTimes(4)
    f.target.undo(); expect(f.target.getGraphSnapshot().nodes.map((entry) => entry.id)).toEqual(before.slice(0, 3).map((entry) => entry.id))
    f.target.redo(); expect(f.target.getGraphSnapshot().nodes.map((entry) => entry.position)).toEqual(before.map((entry) => entry.position))
  })
  it('uses live measured content height rather than the stale rendered node dimensions', () => {
    const input = node('long-prompt', 'prompt', { x: 500, y: 200 }, { width: 288, height: undefined })
    const f = fixture([input])
    f.target.setNodes((entries) => entries.map((entry) => ({ ...entry, measured: { width: 600, height: 800 } })))
    f.add('image-layer', { x: 820, y: 500 })
    const added = f.target.getGraphSnapshot().nodes.at(-1)!
    expect(separated(added.position, builtinNodeRegistry.require('image-layer').dimensions, { position: input.position, width: 600, height: 800 })).toBe(true)
  })
  it('uses changed native media geometry before the old measurement catches up', () => {
    const input = node('uploaded', 'image-input', { x: 100, y: 100 }, { measured: { width: 280, height: 280 } })
    const f = fixture([input])
    f.target.setNodes((entries) => entries.map((entry) => ({ ...entry, width: 480, height: 120, data: { ...entry.data, result: { kind: 'image', assetId: 'a'.repeat(43), width: 4000, height: 1000 } } })))
    f.add('image-layer', { x: 420, y: 100 })
    const added = f.target.getGraphSnapshot().nodes.at(-1)!
    expect(separated(added.position, builtinNodeRegistry.require('image-layer').dimensions, { position: input.position, width: 480, height: 280 })).toBe(true)
  })
  it('avoids nested world-space children and locked group frames without moving them', () => {
    const initial = [
      node('outer', 'group', { x: 1000, y: -1000 }, { width: 100, height: 100, draggable: false }),
      node('inner', 'group', { x: 600, y: 700 }, { width: 100, height: 100, parentId: 'outer', draggable: false }),
      node('child', 'image-input', { x: 400, y: 500 }, { width: 800, height: 600, parentId: 'inner' }),
    ]
    const f = fixture(initial), before = structuredClone(initial.map((entry) => ({ id: entry.id, position: entry.position, parentId: entry.parentId })))
    f.add('image-layer', { x: 2200, y: 300 })
    const added = f.target.getGraphSnapshot().nodes.at(-1)!
    expect(separated(added.position, builtinNodeRegistry.require('image-layer').dimensions, { position: { x: 2000, y: 200 }, width: 800, height: 600 })).toBe(true)
    expect(f.target.getGraphSnapshot().nodes.slice(0, 3).map((entry) => ({ id: entry.id, position: entry.position, parentId: entry.parentId }))).toEqual(before)
    const group = fixture([node('frame', 'group', { x: -500, y: -500 }, { width: 2000, height: 2000, draggable: false })])
    group.add('prompt', { x: 0, y: 0 })
    expect(separated(group.target.getGraphSnapshot().nodes.at(-1)!.position, builtinNodeRegistry.require('prompt').dimensions, { position: { x: -500, y: -500 }, width: 2000, height: 2000 })).toBe(true)
  })
  it('uses the latest graph for ordinary no-position additions as well as explicit quick positions', () => {
    const f = fixture()
    f.add('image-layer'); f.add('image-layer')
    const [first, second] = f.target.getGraphSnapshot().nodes
    expect(separated(first.position, builtinNodeRegistry.require('image-layer').dimensions, { ...second, ...builtinNodeRegistry.require('image-layer').dimensions })).toBe(true)
  })
  it('keeps read-only and unknown-node creation blocked', () => {
    const f = fixture()
    f.projectCanEditRef.current = false; f.add('image-layer', { x: 0, y: 0 })
    f.projectCanEditRef.current = true; f.add('missing-node', { x: 0, y: 0 })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.target.getGraphSnapshot().nodes).toEqual([])
    expect(f.setBanner).toHaveBeenCalledWith(expect.stringContaining('只读'))
  })
  it('preserves dedicated port-connection and edge-insertion dispatch with their exact requested positions', () => {
    const f = fixture(), position = { x: 600, y: 304 }, connection = { nodeId: 'source', handleId: 'out:image', handleType: 'source' }
    const port = f.quick({ flowPosition: position, connection, compatibleHandles: { 'image-layer': 'in:images' } })
    port.run('image-layer')
    expect(port.addConnectedNode).toHaveBeenCalledExactlyOnceWith('image-layer', position, connection, 'in:images')
    expect(port.addNode).not.toHaveBeenCalled(); expect(port.insertNodeOnEdge).not.toHaveBeenCalled()
    const edge = f.quick({ flowPosition: position, edgeId: 'edge-a', compatibleHandles: { 'image-layer': 'in:images|out:image' } })
    edge.run('image-layer')
    expect(edge.insertNodeOnEdge).toHaveBeenCalledExactlyOnceWith('image-layer', position, 'edge-a', 'in:images|out:image')
    expect(edge.addNode).not.toHaveBeenCalled(); expect(edge.addConnectedNode).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })
})
