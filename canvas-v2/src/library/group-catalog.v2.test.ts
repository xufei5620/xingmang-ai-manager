import { describe, expect, it, vi } from 'vitest'
import { createCanvasGroupCatalog, groupDropdownKeyOpens, missingCanvasMediaGroups, missingCanvasRunGroups, type GroupCatalogSnapshot } from './group-catalog'
import type { CanvasRunGraph } from '../host'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('canvas group catalog refresh', () => {
  it('coalesces pointer, focus and panel-open requests and deduplicates immediate completed reads', async () => {
    let now = 1000
    const gate = deferred<{ name: string }[]>()
    const load = vi.fn(() => gate.promise)
    const changed = vi.fn()
    const catalog = createCanvasGroupCatalog({ load, changed, now: () => now })
    const pointer = catalog.refresh()
    const focus = catalog.refresh()
    const panel = catalog.refresh()
    expect(pointer).toBe(focus)
    expect(pointer).toBe(panel)
    gate.resolve([{ name: 'fresh' }])
    await pointer
    await catalog.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    now += 301
    await catalog.refresh()
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('replaces rows and ratios from the server without selecting a group or preparing a key', async () => {
    const snapshots: GroupCatalogSnapshot<{ name: string; ratio: number }>[] = []
    const load = vi.fn().mockResolvedValueOnce([{ name: 'old', ratio: 1 }]).mockResolvedValueOnce([{ name: 'new', ratio: 0.5 }])
    const catalog = createCanvasGroupCatalog<{ name: string; ratio: number }>({ load, changed: (snapshot) => snapshots.push(snapshot) })
    await catalog.refresh()
    await catalog.refresh(true)
    expect(snapshots.at(-1)).toEqual({ groups: [{ name: 'new', ratio: 0.5 }], refreshing: false, error: null })
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('retains old rows on a failed refresh and permits immediate explicit retry', async () => {
    const changed = vi.fn()
    const load = vi.fn().mockResolvedValueOnce([{ name: 'old' }]).mockRejectedValueOnce(new Error('暂时不可用')).mockResolvedValueOnce([{ name: 'new' }])
    const catalog = createCanvasGroupCatalog<{ name: string }>({ load, changed, now: () => 1000 })
    await catalog.refresh()
    await expect(catalog.refresh(true)).rejects.toThrow('暂时不可用')
    expect(changed).toHaveBeenLastCalledWith({ groups: [{ name: 'old' }], refreshing: false, error: '暂时不可用' })
    await catalog.refresh(true)
    expect(changed).toHaveBeenLastCalledWith({ groups: [{ name: 'new' }], refreshing: false, error: null })
  })
  it('treats a successful empty group list as loaded and coalesces its repeated focus events', async () => {
    const load = vi.fn(async () => [])
    const catalog = createCanvasGroupCatalog({ load, changed: vi.fn(), now: () => 1000 })
    await expect(catalog.refresh()).resolves.toEqual([])
    await catalog.refresh()
    expect(load).toHaveBeenCalledTimes(1)
  })
  for (const fail of [false, true]) it(`discards a prior account's late ${fail ? 'error' : 'rows'} after disposal`, async () => {
    const gate = deferred<{ name: string }[]>()
    const changed = vi.fn()
    const catalog = createCanvasGroupCatalog({ load: () => gate.promise, changed })
    const pending = catalog.refresh()
    catalog.dispose()
    if (fail) gate.reject(new Error('old account detail'))
    else gate.resolve([{ name: 'old-private-group' }])
    await expect(pending).rejects.toThrow('画布账号已变化')
    expect(changed).toHaveBeenCalledTimes(1)
    await expect(catalog.refresh()).rejects.toThrow('画布账号已变化')
  })
})

describe('canvas unavailable group guard', () => {
  it('keeps saved selections and models untouched while reporting missing selected groups', () => {
    const selected = { image: 'removed', imageModel: 'image-choice', text: 'Gemini', textModel: 'text-choice', video: '' }
    const before = { ...selected }
    expect(missingCanvasMediaGroups(selected, [{ name: 'Gemini' }])).toEqual(['removed'])
    expect(selected).toEqual(before)
    expect(missingCanvasMediaGroups(selected, [{ name: 'removed' }, { name: 'Gemini' }])).toEqual([])
  })
  it('blocks all removed capability groups once and keeps intentionally empty video allowed', () => {
    expect(missingCanvasMediaGroups({ image: 'missing', video: 'missing', text: 'other' }, [])).toEqual(['missing', 'other'])
    expect(missingCanvasMediaGroups({ image: 'GPT-image2', text: 'Gemini', video: '' }, [{ name: 'GPT-image2' }, { name: 'Gemini' }])).toEqual([])
  })
  it('recognizes native select opening keyboard gestures without hijacking typing', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4']) expect(groupDropdownKeyOpens(key)).toBe(true)
    for (const key of ['Escape', 'Tab', 'a', 'Home', 'End']) expect(groupDropdownKeyOpens(key)).toBe(false)
  })
  it('blocks only removed groups used by the chosen run scope and includes upstream dependencies', () => {
    const graph: CanvasRunGraph = { nodes: [
      { id: 'text', kind: 'text-generate', definitionVersion: 1, data: { prompt: 'draft', model: 'text', group: 'Gemini' } },
      { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'image', group: 'gone-image' } },
      { id: 'video', kind: 'video-generate', definitionVersion: 1, data: { prompt: '', model: 'video', group: 'gone-video' } },
    ], edges: [{ id: 'edge', source: 'text', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }] }
    expect(missingCanvasRunGroups(graph, { kind: 'to-node', nodeId: 'text' }, [{ name: 'Gemini' }])).toEqual([])
    expect(missingCanvasRunGroups(graph, { kind: 'to-node', nodeId: 'image' }, [{ name: 'Gemini' }])).toEqual(['gone-image'])
    expect(missingCanvasRunGroups(graph, { kind: 'to-node', nodeId: 'image' }, [])).toEqual(['Gemini', 'gone-image'])
  })
})
