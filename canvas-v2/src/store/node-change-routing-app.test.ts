import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyNodeChanges, type NodeChange } from '@xyflow/react'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createCanvasDocument } from './canvas-state'
import { useCanvasDocument, type CanvasDocumentController } from './use-canvas-document'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function actualNodeChanges(environment: Record<string, unknown>): (changes: NodeChange<CanvasNode>[]) => void {
  let callback = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'onCanvasNodesChange' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error('Missing actual App node-change callback')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}

function fixture(snapEnabled = true) {
  let document: CanvasDocumentController | undefined
  function projectNode(record: EditorNodeRecord): CanvasNode {
    return { ...record, type: record.type as CanvasNode['type'], style: { width: record.width, height: record.height }, data: { prompt: '', model: '', status: 'idle', ...record.data } }
  }
  function Capture() { document = useCanvasDocument(projectNode); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!document) throw new Error('Missing document controller')
  const target = document
  target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [{ id: 'layer', type: 'image-layer', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '' } }] } })
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames.delete(handle) })
  const onNodesChange = vi.fn(target.onNodesChange), setSnapGuides = vi.fn(), getNodes = vi.fn(() => target.getGraphSnapshot().nodes)
  const snapDragPositionChanges = vi.fn((changes: NodeChange<CanvasNode>[]) => ({ changes, guides: [{ axis: 'x', position: 50, start: 0, end: 100 }] }))
  const environment = { altDragSessionRef: { current: null }, setNodes: target.setNodes, applyNodeChanges, uiPreferences: { snapEnabled }, setSnapGuides, onNodesChange, reactFlow: { getNodes }, snapBoxOfCanvasNode: (node: CanvasNode) => ({ id: node.id }), snapDragPositionChanges }
  return { target, ...environment, run: actualNodeChanges(environment), frames, tick() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)) } }
}

afterEach(() => vi.unstubAllGlobals())

describe('actual App node measurement routing', () => {
  it.each([true, false])('defers observer dimensions without reading snap boxes or publishing guides (snap=%s)', (snapEnabled) => {
    const f = fixture(snapEnabled), before = f.target.getGraphSnapshot().nodes
    const changes: NodeChange<CanvasNode>[] = [{ id: 'layer', type: 'dimensions', dimensions: { width: 320, height: 500 } }]
    f.run(changes)
    expect(f.onNodesChange).toHaveBeenCalledExactlyOnceWith(changes)
    expect(f.setSnapGuides).not.toHaveBeenCalled()
    expect(f.reactFlow.getNodes).not.toHaveBeenCalled()
    expect(f.snapDragPositionChanges).not.toHaveBeenCalled()
    expect(f.target.getGraphSnapshot().nodes).toBe(before)
    f.tick()
    expect(f.target.getGraphSnapshot().nodes[0].measured).toEqual({ width: 320, height: 500 })
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes[0].measured).toEqual({ width: 320, height: 500 })
  })

  it('keeps interactive resize synchronous and discards the older observer frame', () => {
    const f = fixture()
    f.run([{ id: 'layer', type: 'dimensions', dimensions: { width: 320, height: 500 } }])
    f.run([{ id: 'layer', type: 'dimensions', dimensions: { width: 600, height: 700 }, resizing: true }])
    expect(f.frames.size).toBe(0)
    expect(f.target.getGraphSnapshot().nodes[0]).toMatchObject({ width: 600, height: 700 })
    expect(f.setSnapGuides).not.toHaveBeenCalled()
    expect(f.reactFlow.getNodes).not.toHaveBeenCalled()
    f.run([{ id: 'layer', type: 'dimensions', dimensions: { width: 650, height: 750 }, resizing: false }])
    expect(f.target.getGraphSnapshot().nodes[0]).toMatchObject({ width: 650, height: 750 })
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes[0].width).toBeUndefined()
  })

  it('retains the drag-snapping route for mixed drag and measurement changes', () => {
    const f = fixture()
    const changes: NodeChange<CanvasNode>[] = [
      { id: 'layer', type: 'position', position: { x: 40, y: 60 }, dragging: true },
      { id: 'layer', type: 'dimensions', dimensions: { width: 320, height: 500 } },
    ]
    f.run(changes)
    expect(f.snapDragPositionChanges).toHaveBeenCalledTimes(1)
    expect(f.setSnapGuides).toHaveBeenCalledExactlyOnceWith([{ axis: 'x', position: 50, start: 0, end: 100 }])
    expect(f.onNodesChange).toHaveBeenCalledExactlyOnceWith(changes)
    expect(f.target.getGraphSnapshot().nodes[0].position).toEqual({ x: 40, y: 60 })
    expect(f.target.getGraphSnapshot().nodes[0].measured).toBeUndefined()
    f.tick()
    expect(f.target.getGraphSnapshot().nodes[0].measured).toEqual({ width: 320, height: 500 })
  })
})
