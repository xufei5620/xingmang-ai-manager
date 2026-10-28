import { describe, expect, it } from 'vitest'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import type { CanvasCommand } from '../store/canvas-command'
import type { EditorNodeRecord } from '../domain/node-definition'

function node(id: string, prompt: string): EditorNodeRecord {
  return { id, type: id === 'target' ? 'image-generate' : 'text-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt, result: { assetId: 'saved-output' } } }
}
function command(prompt: string, merge = true): CanvasCommand {
  return { type: 'replace-graph', nodes: [node('original-analysis', 'shared original'), node('private-analysis', `new analysis ${prompt}`), node('target', prompt)], edges: [{ id: 'new-link', source: 'private-analysis', target: 'target', sourceHandle: 'out:text', targetHandle: 'in:text' }], ...(merge ? { mergeKey: 'storyboard-prompt:target' } : {}) }
}
function original() {
  return { ...createCanvasDocument(), nodes: [node('original-analysis', 'shared original'), node('target', 'original plot')], edges: [{ id: 'old-link', source: 'original-analysis', target: 'target', sourceHandle: 'out:text', targetHandle: 'in:text' }] }
}

describe('atomic storyboard plot and analysis history', () => {
  it('coalesces continuous typing and restores the private clone, links and saved result together', () => {
    const before = original()
    let history = createCanvasHistory(before)
    history = applyCanvasCommand(history, command('清'), 50, 1000)
    history = applyCanvasCommand(history, command('清晨'), 50, 1600)
    expect(history.past).toHaveLength(1)
    expect(history.present.nodes.find((entry) => entry.id === 'target')?.data.result).toEqual({ assetId: 'saved-output' })
    const after = history.present
    history = undoCanvasHistory(history)
    expect(history.present).toEqual(before)
    history = redoCanvasHistory(history)
    expect(history.present).toEqual(after)
    expect(history.present.nodes.find((entry) => entry.id === 'private-analysis')?.data.prompt).toBe('new analysis 清晨')
  })
  it('keeps an explicit preset insertion separate from the typing before and after it', () => {
    let history = createCanvasHistory(original())
    history = applyCanvasCommand(history, command('typing'), 50, 1000)
    history = applyCanvasCommand(history, command('expanded official preset', false), 50, 1100)
    history = applyCanvasCommand(history, command('expanded official preset edited'), 50, 1200)
    expect(history.past).toHaveLength(3)
    history = undoCanvasHistory(history)
    expect(history.present.nodes.find((entry) => entry.id === 'target')?.data.prompt).toBe('expanded official preset')
  })
  it('starts a new sentence edit after a pause and never merges across an undo', () => {
    let history = applyCanvasCommand(createCanvasHistory(original()), command('first'), 50, 1000)
    history = applyCanvasCommand(history, command('second'), 50, 4000)
    expect(history.past).toHaveLength(2)
    history = undoCanvasHistory(history)
    history = applyCanvasCommand(history, command('new branch'), 50, 4100)
    expect(history.past).toHaveLength(2)
    expect(history.future).toHaveLength(0)
  })
})
