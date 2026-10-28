import { describe, expect, it, vi } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow } from '../model'
import { createCanvasBrowserDraft, listCanvasBrowserDrafts, writeCanvasBrowserDraft, type CanvasBrowserDraft, type CanvasDraftStorage } from './browser-draft'

function storage() {
  const values = new Map<string, string>()
  const port: CanvasDraftStorage = { get length() { return values.size }, key: (index) => [...values.keys()][index] ?? null, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) } }
  return { port, values }
}
function draft(extended = true, revision = 'r1', updatedAt = '2026-10-24T12:00:00.000Z', writerId = 'writer'): CanvasBrowserDraft {
  return createCanvasBrowserDraft({ ownerId: 1, projectId: 'project', writerId, revision, cloudVersion: 2, updatedAt, content: serializeWorkflow({ ...createEmptyWorkflow('未保存'), viewport: { x: 200, y: 300, zoom: extended ? .000002 : 1 } }) })
}
function key(value: CanvasBrowserDraft, version: 1 | 2) { return `xingmang:canvas-draft:v${version}:${value.ownerId}:${value.projectId}:${value.writerId}:${value.revision}` }
describe('extended viewport draft isolation from cached old pages', () => {
  it('writes extended records to v2 that a v1 page cannot enumerate or prune', () => {
    const f = storage(), value = draft(); writeCanvasBrowserDraft(f.port, value)
    expect(f.values.has(key(value, 2))).toBe(true)
    for (const name of [...f.values.keys()].filter((name) => name.startsWith('xingmang:canvas-draft:v1:'))) f.port.removeItem(name)
    expect(listCanvasBrowserDrafts(f.port, 1, 'project')[0]).toEqual(value)
  })
  it('copies a verified old extended draft without removing its original or a newer protected revision', () => {
    const f = storage(), old = draft(), newer = draft(true, 'r2', '2026-10-24T13:00:00.000Z')
    writeCanvasBrowserDraft(f.port, newer); f.values.set(key(old, 1), JSON.stringify(old))
    const listed = listCanvasBrowserDrafts(f.port, 1, 'project')
    expect(listed.map((value) => value.revision)).toEqual(['r2', 'r1'])
    expect(f.values.get(key(old, 1))).toBe(JSON.stringify(old)); expect(f.values.get(key(old, 2))).toBe(JSON.stringify(old)); expect(f.values.has(key(newer, 2))).toBe(true)
  })
  it('selects a newer normal-range v1 revision after returning to 100 percent', () => {
    const f = storage(), old = draft(), normal = draft(false, 'r2', '2026-10-24T13:00:00.000Z')
    f.values.set(key(old, 1), JSON.stringify(old)); listCanvasBrowserDrafts(f.port, 1, 'project'); writeCanvasBrowserDraft(f.port, normal)
    expect(listCanvasBrowserDrafts(f.port, 1, 'project')[0]).toEqual(normal)
  })
  it('fails visibly on same-identity conflicts or migration write failure while retaining both original bytes', () => {
    const f = storage(), original = draft(), conflicting = { ...original, content: serializeWorkflow({ ...createEmptyWorkflow('冲突'), viewport: { x: 0, y: 0, zoom: .000002 } }) }
    f.values.set(key(original, 1), JSON.stringify(original)); f.values.set(key(original, 2), JSON.stringify(conflicting))
    expect(() => listCanvasBrowserDrafts(f.port, 1, 'project')).toThrow('冲突')
    expect(f.values.get(key(original, 1))).toBe(JSON.stringify(original)); expect(f.values.get(key(original, 2))).toBe(JSON.stringify(conflicting))
    f.values.delete(key(original, 2)); const setItem = vi.spyOn(f.port, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => listCanvasBrowserDrafts(f.port, 1, 'project')).toThrow('原记录仍保留'); expect(f.values.get(key(original, 1))).toBe(JSON.stringify(original)); expect(setItem).toHaveBeenCalledOnce()
  })
  it('counts writers across both namespaces without reading another owner record', () => {
    const f = storage()
    for (let index = 0; index < 4; index += 1) writeCanvasBrowserDraft(f.port, draft(index % 2 === 0, 'r1', undefined, `writer-${index}`))
    expect(() => writeCanvasBrowserDraft(f.port, draft(true, 'r1', undefined, 'fifth'))).toThrow('4 份')
    const read = vi.spyOn(f.port, 'getItem'); f.values.set('xingmang:canvas-draft:v2:2:other:secret:r1', 'not read')
    listCanvasBrowserDrafts(f.port, 1, 'project'); expect(read).not.toHaveBeenCalledWith('xingmang:canvas-draft:v2:2:other:secret:r1')
  })
  it('accounts actual stored bytes in both namespaces under the same owner quota', () => {
    const f = storage()
    function large(extended: boolean, writerId: string) {
      const value = draft(extended, 'r1', undefined, writerId), workflow = JSON.parse(value.content)
      workflow.nodes = Array.from({ length: 180 }, (_, index) => ({ id: `n${index}`, kind: 'prompt', position: { x: 0, y: 0 }, data: { prompt: 'a'.repeat(10000), model: '', status: 'idle' } }))
      return createCanvasBrowserDraft({ ...value, content: serializeWorkflow(workflow) })
    }
    writeCanvasBrowserDraft(f.port, large(false, 'ordinary')); writeCanvasBrowserDraft(f.port, large(true, 'extended'))
    expect(() => writeCanvasBrowserDraft(f.port, large(true, 'third'))).toThrow('4 MB')
    expect(f.values.size).toBe(2)
  })
})
