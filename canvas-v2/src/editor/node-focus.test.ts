import { describe, expect, it, vi } from 'vitest'
import { createCreatedNodeFocusCoordinator, createdNodeFocusZoom, createdNodeNeedsFocus, type CreatedNodeFocusCandidate, type CreatedNodeFocusScope } from './node-focus'

describe('created node focus', () => {
  it('reveals explicitly positioned tall nodes without moving an already visible node', () => {
    const viewport = { width: 1232, height: 664 }
    const transform = { x: 0, y: 0, zoom: 1 }
    expect(createdNodeNeedsFocus({ x: 499, y: 252, width: 320, height: 477 }, viewport, transform)).toBe(true)
    expect(createdNodeNeedsFocus({ x: 400, y: 100, width: 320, height: 400 }, viewport, transform)).toBe(false)
  })

  it('uses the current pan and zoom and keeps room for overlaid controls', () => {
    const node = { x: 1000, y: 600, width: 320, height: 400 }
    expect(createdNodeNeedsFocus(node, { width: 1000, height: 600 }, { x: -200, y: -200, zoom: 0.5 })).toBe(false)
    expect(createdNodeNeedsFocus(node, { width: 1000, height: 600 }, { x: -480, y: -200, zoom: 0.5 })).toBe(true)
    expect(createdNodeNeedsFocus(node, undefined, { x: 0, y: 0, zoom: 1 })).toBe(false)
  })

  it('fits a tall editor with room for its actions instead of clipping the run button', () => {
    const zoom = createdNodeFocusZoom({ width: 320, height: 540 }, { width: 1232, height: 664 }, 1)
    expect(zoom * 540).toBeLessThanOrEqual(504)
    expect(zoom).toBeGreaterThan(0.9)
  })

  it('fits narrow canvases without zooming an existing overview back in', () => {
    expect(createdNodeFocusZoom({ width: 320, height: 540 }, { width: 272, height: 580 }, 1)).toBe(0.55)
    expect(createdNodeFocusZoom({ width: 320, height: 540 }, { width: 1200, height: 800 }, 0.4)).toBe(0.4)
    expect(createdNodeFocusZoom({ width: 320, height: 540 }, { width: 1200, height: 800 }, .000002)).toBe(.000002)
  })
})


function focusFixture() {
  let sequence = 0
  let scope: CreatedNodeFocusScope = { projectId: 'project-a', projectEpoch: 1 }
  const frames = new Map<number, () => void>(), nodes = new Map<string, CreatedNodeFocusCandidate>()
  const coordinator = createCreatedNodeFocusCoordinator({
    schedule(callback) { const id = ++sequence; frames.set(id, callback); return id },
    cancel(id) { frames.delete(id) },
    scope: () => scope,
    readNode: (id) => nodes.get(id),
  })
  return {
    coordinator, nodes, frames,
    scope(next: CreatedNodeFocusScope) { scope = next },
    frame() { const next = frames.entries().next().value; if (next) { frames.delete(next[0]); next[1]() } },
  }
}

describe('created node focus coordination', () => {
  const fallback = { width: 320, height: 200 }

  it('uses the latest measured position after deferred rendering', () => {
    const fixture = focusFixture(), ready = vi.fn()
    fixture.nodes.set('new', { position: { x: 100, y: 100 } })
    fixture.coordinator.start('new', fallback, ready)
    fixture.frame()
    expect(ready).not.toHaveBeenCalled()
    fixture.nodes.set('new', { position: { x: 600, y: 700 }, measured: { width: 350, height: 477 } })
    fixture.frame()
    expect(ready).toHaveBeenCalledExactlyOnceWith({ x: 600, y: 700, width: 350, height: 477 })
    expect(fixture.frames.size).toBe(0)
  })

  it('lets a second insertion supersede even an uncancellable callback from the first', () => {
    const fixture = focusFixture(), first = vi.fn(), second = vi.fn()
    fixture.nodes.set('one', { position: { x: 1, y: 1 }, measured: fallback })
    fixture.nodes.set('two', { position: { x: 2, y: 2 }, measured: fallback })
    fixture.coordinator.start('one', fallback, first)
    const stale = [...fixture.frames.values()][0]
    fixture.coordinator.start('two', fallback, second)
    stale(); fixture.frame()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith({ x: 2, y: 2, ...fallback })
  })

  it('does not focus a node deleted after first being observed', () => {
    const fixture = focusFixture(), ready = vi.fn()
    fixture.nodes.set('new', { position: { x: 10, y: 20 } })
    fixture.coordinator.start('new', fallback, ready)
    fixture.frame(); fixture.nodes.delete('new'); fixture.frame()
    expect(ready).not.toHaveBeenCalled()
    expect(fixture.frames.size).toBe(0)
  })

  it('never uses fallback geometry for a node deleted before it was rendered', () => {
    const fixture = focusFixture(), ready = vi.fn()
    fixture.coordinator.start('missing', fallback, ready)
    for (let index = 0; index < 40; index++) fixture.frame()
    expect(ready).not.toHaveBeenCalled()
    expect(fixture.frames.size).toBe(0)
  })

  it.each([{ projectId: 'project-b', projectEpoch: 1 }, { projectId: 'project-a', projectEpoch: 2 }])('invalidates project identity or lifetime changes %j', (scope) => {
    const fixture = focusFixture(), ready = vi.fn()
    fixture.nodes.set('new', { position: { x: 10, y: 20 }, measured: fallback })
    fixture.coordinator.start('new', fallback, ready)
    fixture.scope(scope); fixture.frame()
    expect(ready).not.toHaveBeenCalled()
    expect(fixture.frames.size).toBe(0)
  })

  it('cancels pending callbacks on user navigation, dragging or unmount', () => {
    const fixture = focusFixture(), ready = vi.fn()
    fixture.nodes.set('new', { position: { x: 10, y: 20 }, measured: fallback })
    fixture.coordinator.start('new', fallback, ready)
    const stale = [...fixture.frames.values()][0]
    fixture.coordinator.cancel(); stale(); fixture.frame()
    expect(ready).not.toHaveBeenCalled()
    expect(fixture.frames.size).toBe(0)
  })

  it('uses bounded fallback dimensions only for an existing unmeasured node', () => {
    const fixture = focusFixture(), ready = vi.fn()
    fixture.nodes.set('new', { position: { x: 20, y: 30 }, width: 360 })
    fixture.coordinator.start('new', fallback, ready)
    for (let index = 0; index < 40; index++) fixture.frame()
    expect(ready).toHaveBeenCalledExactlyOnceWith({ x: 20, y: 30, width: 360, height: 200 })
  })
})
