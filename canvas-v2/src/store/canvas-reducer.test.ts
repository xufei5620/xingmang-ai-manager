import { describe, expect, it } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from './history'
import { collectDownstreamNodeIds, createCanvasDocument } from './canvas-state'

function node(id: string, x = 0): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x, y: 0 }, data: { prompt: id } }
}

describe('canvas command history', () => {
  it('undoes and redoes structural commands', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    expect(history.present.nodes).toHaveLength(1)
    history = undoCanvasHistory(history)
    expect(history.present.nodes).toHaveLength(0)
    history = redoCanvasHistory(history)
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['a'])
  })

  it('merges continuous drag updates into one undo step', () => {
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [node('a')] })
    history = applyCanvasCommand(history, { type: 'move-nodes', positions: { a: { x: 10, y: 0 } }, mergeKey: 'drag:a' })
    history = applyCanvasCommand(history, { type: 'move-nodes', positions: { a: { x: 20, y: 0 } }, mergeKey: 'drag:a' })
    expect(history.past).toHaveLength(1)
    expect(undoCanvasHistory(history).present.nodes[0].position.x).toBe(0)
  })

  it('invalidates redo after a new branch', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    history = undoCanvasHistory(history)
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('b')] })
    expect(history.future).toHaveLength(0)
    expect(redoCanvasHistory(history)).toBe(history)
  })

  it('keeps viewport changes out of content history and preserves redo', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    history = undoCanvasHistory(history)
    history = applyCanvasCommand(history, { type: 'set-viewport', viewport: { x: 120, y: -40, zoom: 1.5 } })
    expect(history.past).toHaveLength(0)
    expect(history.future).toHaveLength(1)

    history = redoCanvasHistory(history)
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['a'])
    expect(history.present.viewport).toEqual({ x: 120, y: -40, zoom: 1.5 })
  })

  it('increments replacement revision from the active document', () => {
    const current = { ...createCanvasDocument(), revision: 7 }
    const imported = { ...createCanvasDocument('导入文档'), revision: 99, nodes: [node('imported')] }
    const history = applyCanvasCommand(createCanvasHistory(current), {
      type: 'replace-document',
      document: imported,
    })
    expect(history.present.revision).toBe(8)
    expect(history.present.name).toBe('导入文档')
  })

  it('bounds history to fifty entries', () => {
    let history = createCanvasHistory(createCanvasDocument())
    for (let index = 0; index < 60; index += 1) {
      history = applyCanvasCommand(history, { type: 'rename-document', name: `name-${index}` })
    }
    expect(history.past).toHaveLength(50)
  })

  it('builds downstream reachability without repeated graph scans', () => {
    const document = {
      ...createCanvasDocument(),
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { id: 'ab', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' },
        { id: 'bc', source: 'b', sourceHandle: 'out:text', target: 'c', targetHandle: 'in:text' },
      ],
    }
    expect([...collectDownstreamNodeIds(document, ['a'])]).toEqual(['b', 'c'])
  })
})
