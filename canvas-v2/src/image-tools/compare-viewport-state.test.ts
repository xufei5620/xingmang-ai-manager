import { describe, expect, it, vi } from 'vitest'
import { constrainCompareViewport, createCompareViewportInteraction } from './compare-viewport-state'

const bounds = { width: 400, height: 300 }
function interaction(scope = 'source-a') { const change = vi.fn(), controller = createCompareViewportInteraction(change); controller.sync(scope, true); return { controller, change } }

describe('session-only image comparison viewport', () => {
  it('keeps parallel cells independent and uses center zoom without moving an existing pan', () => {
    const a = interaction(), b = interaction(), c = interaction()
    a.controller.scale(2.4, bounds)
    expect(a.controller.start(1, 100, 100, bounds)).toBe(true)
    a.controller.move(1, 185, 145); a.controller.finish(1)
    expect(a.controller.read()).toEqual({ scale: 2.4, x: 85, y: 45 })
    a.controller.scale(3.6, bounds)
    expect(a.controller.read()).toEqual({ scale: 3.6, x: 85, y: 45 })
    for (const other of [b, c]) { expect(other.controller.read()).toEqual({ scale: 1, x: 0, y: 0 }); expect(other.change).not.toHaveBeenCalled() }
  })

  it('clamps against the actual image clipping box and never pans a fit image', () => {
    const f = interaction(), narrow = { width: 120, height: 300 }
    expect(f.controller.start(1, 0, 0, narrow)).toBe(false)
    f.controller.scale(2, narrow); f.controller.start(1, 0, 0, narrow); f.controller.move(1, 1000, -1000)
    expect(f.controller.read()).toEqual({ scale: 2, x: 60, y: -150 })
    f.controller.finish(1); f.controller.scale(1, narrow)
    expect(f.controller.read()).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('preserves only the owning pointer and restores the previous pan on cancellation', () => {
    const f = interaction(); f.controller.scale(2, bounds)
    f.controller.start(1, 100, 100, bounds)
    expect(f.controller.start(2, 100, 100, bounds)).toBe(false)
    f.controller.move(2, 200, 200); f.controller.cancel(2); f.controller.finish(2)
    expect(f.controller.pending()).toBe(1)
    f.controller.move(1, 150, 130)
    expect(f.controller.read()).toEqual({ scale: 2, x: 50, y: 30 })
    expect(f.controller.zoom(-100, bounds)).toBe(false)
    f.controller.cancel(1); f.controller.move(1, 250, 250)
    expect(f.controller.read()).toEqual({ scale: 2, x: 0, y: 0 })
    expect(f.controller.pending()).toBeNull()
  })

  it('invalidates late pointer events when source or mode changes without invoking workflow callbacks', () => {
    const f = interaction(); f.controller.scale(3, bounds); f.controller.start(1, 0, 0, bounds); f.controller.move(1, 40, 30)
    f.change.mockClear(); f.controller.sync('mode-or-source-changed', true)
    f.controller.move(1, 200, 100); f.controller.finish(1); f.controller.cancel(1)
    expect(f.controller.read()).toEqual({ scale: 1, x: 0, y: 0 })
    expect(f.change).not.toHaveBeenCalled()
    f.controller.scale(2, bounds); f.controller.sync('mode-or-source-changed', true)
    expect(f.controller.read().scale).toBe(2)
    expect(interaction().controller.read()).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('supports keyboard zoom, pan, fit and explicit reset within limits', () => {
    const f = interaction()
    expect(f.controller.key('ArrowLeft', bounds)).toBe(false)
    expect(f.controller.key('+', bounds)).toBe(true)
    expect(f.controller.key('ArrowLeft', bounds)).toBe(true)
    expect(f.controller.read()).toEqual({ scale: 1.25, x: 24, y: 0 })
    f.controller.key('Home', bounds)
    expect(f.controller.read()).toEqual({ scale: 1, x: 0, y: 0 })
    f.controller.scale(500, bounds); expect(f.controller.read().scale).toBe(8)
    f.controller.reset(); expect(f.controller.read().scale).toBe(1)
    expect(f.controller.key('Delete', bounds)).toBe(false)
  })

  it('blocks disabled interactions and rejects nonfinite geometry', () => {
    const f = interaction(); f.controller.sync('source-a', false)
    expect(f.controller.zoom(-100, bounds)).toBe(false)
    expect(f.controller.key('+', bounds)).toBe(false)
    expect(f.controller.start(1, 0, 0, bounds)).toBe(false)
    f.controller.reset(); expect(f.change).not.toHaveBeenCalled()
    f.controller.sync('source-a', true)
    expect(f.controller.scale(NaN, bounds)).toBe(false)
    f.controller.scale(2, bounds)
    expect(f.controller.start(1, Infinity, 0, bounds)).toBe(false)
    expect(constrainCompareViewport({ scale: NaN, x: Infinity, y: NaN }, { width: Infinity, height: -1 })).toEqual({ scale: 1, x: 0, y: 0 })
  })
})
