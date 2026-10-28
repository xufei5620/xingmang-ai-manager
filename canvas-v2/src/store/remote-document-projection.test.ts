import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { NodeKind } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createCanvasDocument, type CanvasDocumentState } from './canvas-state'
import { useCanvasDocument, type CanvasDocumentController } from './use-canvas-document'

function node(id: string, prompt = id): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt, model: '' } }
}

function document(): CanvasDocumentState {
  return { ...createCanvasDocument('Shared project'), nodes: [node('moving'), node('stationary')], edges: [{ id: 'wire', source: 'moving', sourceHandle: 'out:text', target: 'stationary', targetHandle: 'in:text' }] }
}

function canvasNode(record: EditorNodeRecord): CanvasNode {
  return { id: record.id, type: record.type as NodeKind, definitionVersion: record.definitionVersion, position: record.position, data: { prompt: '', model: '', status: 'idle', ...record.data } }
}

function stages(actions: readonly ((target: CanvasDocumentController) => void)[], onMutation?: () => void, canEdit = true): CanvasDocumentController {
  let captured: CanvasDocumentController | undefined
  function Capture() {
    const target = useCanvasDocument(canvasNode, { canEdit: () => canEdit, onMutation })
    const [step, setStep] = useState(0)
    captured = target
    if (step < actions.length) { actions[step](target); setStep(step + 1) }
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing projection controller')
  return captured
}

afterEach(() => vi.unstubAllGlobals())

describe('explicit remote document projection', () => {
  it('keeps local navigation, selection, measurements and unchanged references while receiving a teammate prompt', () => {
    const remote = document()
    remote.viewport = { x: 900, y: -800, zoom: 2 }
    remote.nodes[0] = node('moving', 'Teammate prompt')
    let before: ReturnType<CanvasDocumentController['getGraphSnapshot']> | undefined
    const target = stages([
      (value) => value.execute({ type: 'replace-document', document: document(), resetHistory: true }),
      (value) => {
        value.setViewport({ x: 45, y: -25, zoom: 0.6 })
        value.setNodes((nodes) => nodes.map((item) => item.id === 'moving' ? { ...item, selected: true, measured: { width: 320, height: 180 } } : item))
        value.setEdges((edges) => edges.map((edge) => ({ ...edge, selected: true })))
        before = value.getGraphSnapshot()
      },
      (value) => value.applyRemoteDocument(remote),
    ])
    const graph = target.getGraphSnapshot()
    expect(graph.nodes[0]).toMatchObject({ selected: true, measured: { width: 320, height: 180 }, data: { prompt: 'Teammate prompt' } })
    expect(graph.nodes[1]).toBe(before!.nodes[1])
    expect(graph.edges).toBe(before!.edges)
    expect(graph.edges[0].selected).toBe(true)
    expect(target.viewport).toEqual({ x: 45, y: -25, zoom: 0.6 })
    expect(remote.viewport).toEqual({ x: 900, y: -800, zoom: 2 })
  })

  it('clears whole-snapshot undo and redo so neither can restore a teammate-old graph', () => {
    const remote = document(); remote.nodes[0] = node('moving', 'Remote saved prompt')
    const target = stages([
      (value) => value.execute({ type: 'replace-document', document: document(), resetHistory: true }),
      (value) => { value.execute({ type: 'update-node-data', nodeId: 'moving', patch: { prompt: 'Local edit' } }); value.undo() },
      (value) => { expect(value.canRedo).toBe(true); value.applyRemoteDocument(remote) },
    ])
    expect(target.canUndo).toBe(false)
    expect(target.canRedo).toBe(false)
    expect(target.undo()).toBeNull()
    expect(target.redo()).toBeNull()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('Remote saved prompt')
  })

  it('invalidates insertion focus and old graph authorization before publishing without saving or running', () => {
    const saveProject = vi.fn(), startRun = vi.fn(), runAgent = vi.fn()
    vi.stubGlobal('window', { xingmangCanvasHost: { saveProject, startRun, runAgent } })
    let target: CanvasDocumentController | undefined
    const seen: string[] = [], changed = vi.fn(() => { const first = target?.getGraphSnapshot().nodes[0]; if (first) seen.push(first.data.prompt) })
    let token: ReturnType<CanvasDocumentController['execute']> = null
    const remote = document(); remote.nodes[0] = node('moving', 'New shared prompt')
    const result = stages([
      (value) => { target = value; value.execute({ type: 'replace-document', document: document(), resetHistory: true }) },
      (value) => { target = value; token = value.execute({ type: 'add-nodes', nodes: [node('inserted')], edges: [] }, { insertionViewport: value.viewport }); changed.mockClear(); seen.length = 0 },
      (value) => { target = value; value.applyRemoteDocument(remote) },
    ], changed)
    expect(token).not.toBeNull()
    expect(result.isInsertionViewportCurrent(token!)).toBe(false)
    expect(changed).toHaveBeenCalledOnce()
    expect(seen).toEqual(['moving'])
    expect(result.getGraphSnapshot().nodes[0].data.prompt).toBe('New shared prompt')
    expect(saveProject).not.toHaveBeenCalled(); expect(startRun).not.toHaveBeenCalled(); expect(runAgent).not.toHaveBeenCalled()
  })

  it('projects for a read-only viewer while retaining edit guards and exact incoming edge order', () => {
    const remote = document()
    remote.nodes.push(node('last'))
    remote.edges.push({ id: 'second', source: 'moving', sourceHandle: 'out:text', target: 'last', targetHandle: 'in:text' })
    remote.edges.reverse()
    const target = stages([(value) => value.applyRemoteDocument(remote)], undefined, false)
    expect(target.getGraphSnapshot().edges.map((edge) => edge.id)).toEqual(['second', 'wire'])
    target.execute({ type: 'update-node-data', nodeId: 'moving', patch: { prompt: 'Viewer write' } })
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('moving')
    expect(target.canUndo).toBe(false)
  })

  it('retains pending measurements for surviving nodes and discards them for removed identities', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let sequence = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames.delete(handle) })
    const remote = document(); remote.nodes = [node('stationary')]; remote.edges = []
    const target = stages([
      (value) => value.execute({ type: 'replace-document', document: document(), resetHistory: true }),
      (value) => value.onNodesChange([
        { id: 'moving', type: 'dimensions', dimensions: { width: 600, height: 400 } },
        { id: 'stationary', type: 'dimensions', dimensions: { width: 320, height: 180 } },
      ]),
      (value) => value.applyRemoteDocument(remote),
      (value) => {
        value.execute({ type: 'add-nodes', nodes: [node('moving')], edges: [] })
        const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0))
      },
    ])
    expect(target.getGraphSnapshot().nodes.find((item) => item.id === 'stationary')?.measured).toEqual({ width: 320, height: 180 })
    expect(target.getGraphSnapshot().nodes.find((item) => item.id === 'moving')?.measured).toBeUndefined()
  })
})
