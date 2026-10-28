import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { NodeKind } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { applyCanvasPromptDraft } from '../editor/prompt-draft'
import { officialPromptSnapshot } from '../library/prompt-references'
import { dirtyCanvasNodeIds } from '../runtime/run-projection'
import { createCanvasDocument, type CanvasMediaGroups } from './canvas-state'
import { useCanvasDocument, type CanvasDocumentController } from './use-canvas-document'

function node(id: string): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: id, model: '', dirty: false } }
}

function canvasNode(record: EditorNodeRecord): CanvasNode {
  return {
    id: record.id, type: record.type as NodeKind, definitionVersion: record.definitionVersion,
    position: record.position, width: record.width, height: record.height,
    style: { width: record.width, height: record.height },
    data: { prompt: '', model: '', status: 'idle', ...record.data },
  }
}

function controller(onMutation?: () => void): CanvasDocumentController {
  let captured: CanvasDocumentController | undefined
  function Capture() {
    captured = useCanvasDocument(canvasNode, { canEdit: () => true, onMutation })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing document controller')
  captured.execute({ type: 'replace-document', resetHistory: true, document: {
    ...createCanvasDocument(), nodes: [node('moving'), node('stationary')],
    edges: [{ id: 'wire', source: 'moving', sourceHandle: 'out:text', target: 'stationary', targetHandle: 'in:text' }],
  } })
  return captured
}

function animationFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames.delete(handle) })
  return { frames, tick() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) } }
}

afterEach(() => vi.unstubAllGlobals())

describe('synchronous document mutation notifications', () => {
  it('invalidates automatic dispatch on edits and undo/redo before the edited graph is published', () => {
    const observed: string[] = []
    let target: CanvasDocumentController | undefined
    const changed = vi.fn(() => { if (target) observed.push(target.getGraphSnapshot().nodes[0].data.prompt) })
    target = controller(changed); changed.mockClear()
    target.execute({ type: 'update-node-data', nodeId: 'moving', patch: { prompt: 'updated' } })
    target.undo(); target.redo()
    expect(changed).toHaveBeenCalledTimes(3)
    expect(observed).toEqual(['moving', 'updated', 'moving'])
  })
  it('ignores selection, measurements, runtime projection and viewport navigation', () => {
    const clock = animationFrames(), changed = vi.fn(), target = controller(changed)
    changed.mockClear()
    target.onNodesChange([{ id: 'moving', type: 'select', selected: true }])
    target.onNodesChange([{ id: 'moving', type: 'dimensions', dimensions: { width: 300, height: 240 } }]); clock.tick()
    target.setNodes((nodes) => nodes.map((item) => ({ ...item, data: { ...item.data, status: 'running' } })))
    target.setViewport({ x: 40, y: 60, zoom: 0.5 })
    target.execute({ type: 'set-viewport', viewport: { x: 0, y: 0, zoom: 1 } })
    expect(changed).not.toHaveBeenCalled()
    target.onNodesChange([{ id: 'moving', type: 'position', position: { x: 50, y: 80 }, dragging: true }])
    expect(changed).toHaveBeenCalledOnce()
  })
})

describe('controlled node measurement timing', () => {
  it('publishes ResizeObserver dimensions only in the next frame without adding an undo step', () => {
    const clock = animationFrames(), target = controller(), before = target.getGraphSnapshot().nodes
    target.onNodesChange([{ id: 'moving', type: 'dimensions', dimensions: { width: 300, height: 200 } }])
    target.onNodesChange([{ id: 'moving', type: 'dimensions', dimensions: { width: 320, height: 240 } }])
    expect(target.getGraphSnapshot().nodes).toBe(before)
    clock.tick()
    expect(target.getGraphSnapshot().nodes[0].measured).toEqual({ width: 320, height: 240 })
    expect(target.getGraphSnapshot().nodes[1]).toBe(before[1])
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].measured).toEqual({ width: 320, height: 240 })
  })

  it('keeps gesture resizing synchronous and prevents an old observer frame from overriding it', () => {
    const clock = animationFrames(), target = controller()
    target.onNodesChange([{ id: 'moving', type: 'dimensions', dimensions: { width: 300, height: 200 } }])
    target.onNodesChange([{ id: 'moving', type: 'dimensions', dimensions: { width: 500, height: 350 }, resizing: true }])
    expect(target.getGraphSnapshot().nodes[0]).toMatchObject({ width: 500, height: 350 })
    expect(clock.frames.size).toBe(0)
    target.onNodesChange([{ id: 'moving', type: 'dimensions', dimensions: { width: 600, height: 400 }, resizing: false }])
    expect(target.getGraphSnapshot().nodes[0]).toMatchObject({ width: 600, height: 400 })
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].width).toBeUndefined()
  })

  it('drops pending dimensions across project replacement even when node IDs are reused', () => {
    const clock = animationFrames(), target = controller()
    target.onNodesChange([{ id: 'moving', type: 'dimensions', dimensions: { width: 300, height: 200 } }])
    target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [node('moving')], edges: [] } })
    clock.tick()
    expect(target.getGraphSnapshot().nodes[0].measured).toBeUndefined()
    expect(clock.frames.size).toBe(0)
  })
})

describe('canvas document render stability', () => {
  it('keeps model groups stable across unrelated renders and changes them only for a document update', () => {
    const groups: CanvasMediaGroups[] = []
    function Capture() {
      const document = useCanvasDocument(canvasNode)
      const [step, setStep] = useState(0)
      groups.push(document.mediaGroups)
      if (step === 0) setStep(1)
      if (step === 1) {
        document.execute({ type: 'set-media-groups', mediaGroups: { image: 'source-a' } })
        setStep(2)
      }
      return null
    }
    renderToStaticMarkup(createElement(Capture))
    expect(groups).toHaveLength(3)
    expect(groups[1]).toBe(groups[0])
    expect(groups[2]).not.toBe(groups[1])
    expect(groups[2]).toEqual({ image: 'source-a' })
  })

  it('does not rebuild stationary nodes, model data or wires while moving another node', () => {
    const target = controller()
    const before = target.getGraphSnapshot()
    target.execute({ type: 'move-nodes', positions: { moving: { x: 100, y: 60 } } })
    const after = target.getGraphSnapshot()
    expect(after.nodes[0]).not.toBe(before.nodes[0])
    expect(after.nodes[0].position).toEqual({ x: 100, y: 60 })
    expect(after.nodes[0].data).toBe(before.nodes[0].data)
    expect(after.nodes[1]).toBe(before.nodes[1])
    expect(after.edges).toBe(before.edges)
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(target.getGraphSnapshot().nodes[1]).toBe(before.nodes[1])
    target.redo()
    expect(target.getGraphSnapshot().nodes[0].position).toEqual({ x: 100, y: 60 })
  })

  it('publishes edited data and undo results while keeping unrelated nodes untouched', () => {
    const target = controller()
    const before = target.getGraphSnapshot()
    target.execute({ type: 'update-node-data', nodeId: 'moving', patch: { prompt: 'updated' } })
    const after = target.getGraphSnapshot()
    expect(after.nodes[0].data).not.toBe(before.nodes[0].data)
    expect(after.nodes[0].data.prompt).toBe('updated')
    expect(after.nodes[1]).toBe(before.nodes[1])
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('moving')
    target.redo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('updated')
  })

  it('keeps live selection, measurements and execution data when moving or resizing a node', () => {
    const target = controller()
    target.setNodes((current) => current.map((entry) => entry.id === 'moving'
      ? { ...entry, selected: true, measured: { width: 320, height: 180 }, data: { ...entry.data, status: 'running', runProgress: 0.5 } }
      : entry))
    const before = target.getGraphSnapshot()
    target.execute({ type: 'move-nodes', positions: { moving: { x: 400, y: 300 } } })
    expect(target.getGraphSnapshot().nodes[0]).toMatchObject({ selected: true, measured: { width: 320, height: 180 }, data: { status: 'running', runProgress: 0.5 } })
    expect(target.getGraphSnapshot().nodes[0].data).toBe(before.nodes[0].data)
    target.execute({ type: 'resize-nodes', dimensions: { moving: { width: 640, height: 360 } } })
    expect(target.getGraphSnapshot().nodes[0]).toMatchObject({ width: 640, height: 360, style: { width: 640, height: 360 } })
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].width).toBeUndefined()
    expect(target.getGraphSnapshot().nodes[0].data.status).toBe('running')
  })

  it('does not share node state when a different project reuses its identifiers', () => {
    const target = controller()
    target.setNodes((current) => current.map((entry) => ({ ...entry, selected: true, data: { ...entry.data, status: 'running' } })))
    const before = target.getGraphSnapshot()
    target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument('another'), nodes: [node('moving')], edges: [] } })
    const after = target.getGraphSnapshot()
    expect(after.nodes[0]).not.toBe(before.nodes[0])
    expect(after.nodes[0].selected).toBeUndefined()
    expect(after.nodes[0].data.status).toBe('idle')
    expect(after.edges).toEqual([])
  })
})

describe('prompt draft undo history', () => {
  it('keeps official snapshots through insertion undo and redo including metadata-only expansion', () => {
    const target = controller()
    const snapshot = officialPromptSnapshot('xingmang-product-studio')!
    const promptReferences = [{ start: 0, end: snapshot.prompt.length, ...snapshot }]
    applyCanvasPromptDraft(target, 'moving', snapshot.prompt, { discrete: true, promptReferences })
    expect(target.getGraphSnapshot().nodes[0].data.promptReferences).toEqual(promptReferences)
    applyCanvasPromptDraft(target, 'moving', snapshot.prompt, { discrete: true, promptReferences: [] })
    expect(target.getGraphSnapshot().nodes[0].data.promptReferences).toEqual([])
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.promptReferences).toEqual(promptReferences)
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('moving')
    target.redo()
    expect(target.getGraphSnapshot().nodes[0].data.promptReferences).toEqual(promptReferences)
    target.redo()
    expect(target.getGraphSnapshot().nodes[0].data.promptReferences).toEqual([])
  })

  it('does not invalidate successful outputs when only official label metadata changes', () => {
    const target = controller()
    const snapshot = officialPromptSnapshot('xingmang-product-studio')!
    target.setNodes((nodes) => nodes.map((node) => node.id === 'moving' ? { ...node, data: { ...node.data, prompt: snapshot.prompt } } : node))
    const promptReferences = [{ start: 0, end: snapshot.prompt.length, ...snapshot }]
    applyCanvasPromptDraft(target, 'moving', snapshot.prompt, { discrete: true, promptReferences })
    expect([...dirtyCanvasNodeIds(target.getGraphSnapshot().nodes)]).toEqual([])
    expect(applyCanvasPromptDraft(target, 'moving', snapshot.prompt, { promptReferences })).toBeNull()
  })

  it('keeps preset insertion separate from the query and following typing', () => {
    const target = controller()
    applyCanvasPromptDraft(target, 'moving', 'Keep prefix #product Keep suffix')
    applyCanvasPromptDraft(target, 'moving', 'Keep prefix Full preset body Keep suffix', { discrete: true })
    applyCanvasPromptDraft(target, 'moving', 'Keep prefix Full preset body Keep suffix edited')
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('Keep prefix Full preset body Keep suffix')
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('Keep prefix #product Keep suffix')
    target.redo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('Keep prefix Full preset body Keep suffix')
  })

  it('merges consecutive typing and keeps the original text before any blur', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-11T12:00:00Z'))
      const target = controller()
      for (const prompt of ['n', 'ne', 'new', 'new prompt']) {
        vi.advanceTimersByTime(100)
        applyCanvasPromptDraft(target, 'moving', prompt)
      }
      expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('new prompt')
      target.undo()
      expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('moving')
      target.redo()
      expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('new prompt')
    } finally { vi.useRealTimers() }
  })

  it('does not publish another graph or save snapshot on blur after a draft has been saved', () => {
    const target = controller()
    applyCanvasPromptDraft(target, 'moving', 'saved new prompt')
    const saved = target.getGraphSnapshot()
    const savedContent = JSON.stringify(saved)
    expect(applyCanvasPromptDraft(target, 'moving', 'saved new prompt')).toBeNull()
    expect(target.getGraphSnapshot().nodes).toBe(saved.nodes)
    expect(target.getGraphSnapshot().edges).toBe(saved.edges)
    expect(JSON.stringify(target.getGraphSnapshot())).toBe(savedContent)
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('moving')
    target.redo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('saved new prompt')
  })

  it('restores downstream pending flags together with an undone prompt', () => {
    const target = controller()
    expect([...dirtyCanvasNodeIds(target.getGraphSnapshot().nodes)]).toEqual([])
    applyCanvasPromptDraft(target, 'moving', 'changed upstream')
    expect([...dirtyCanvasNodeIds(target.getGraphSnapshot().nodes)]).toEqual(['moving', 'stationary'])
    target.undo()
    expect([...dirtyCanvasNodeIds(target.getGraphSnapshot().nodes)]).toEqual([])
    target.redo()
    expect([...dirtyCanvasNodeIds(target.getGraphSnapshot().nodes)]).toEqual(['moving', 'stationary'])
  })

  it('keeps intervening moves as separate undo steps between prompt edits', () => {
    const target = controller()
    applyCanvasPromptDraft(target, 'moving', 'first edit')
    target.execute({ type: 'move-nodes', positions: { stationary: { x: 640, y: 400 } } })
    applyCanvasPromptDraft(target, 'moving', 'second edit')
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('first edit')
    expect(target.getGraphSnapshot().nodes[1].position).toEqual({ x: 640, y: 400 })
    target.undo()
    expect(target.getGraphSnapshot().nodes[1].position).toEqual({ x: 0, y: 0 })
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('moving')
  })

  it('reads the live graph and never resurrects a removed prompt on a late blur', () => {
    const target = controller()
    applyCanvasPromptDraft(target, 'moving', 'edited')
    target.execute({ type: 'delete-elements', nodeIds: ['moving'] })
    const removed = target.getGraphSnapshot()
    expect(applyCanvasPromptDraft(target, 'moving', 'edited')).toBeNull()
    expect(target.getGraphSnapshot().nodes).toBe(removed.nodes)
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('edited')
    target.undo()
    expect(target.getGraphSnapshot().nodes[0].data.prompt).toBe('moving')
  })
})
