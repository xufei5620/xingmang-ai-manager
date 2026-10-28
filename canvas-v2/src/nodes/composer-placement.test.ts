import { describe, expect, it } from 'vitest'
import { composerPlacement, type ComposerPlacementInput } from './composer-placement'

function input(): ComposerPlacementInput { return { viewport: { width: 1200, height: 900 }, node: { x: 300, y: 100, width: 280, height: 180 }, panelHeight: 300, follow: true } }

describe('generation composer placement', () => {
  it('follows node movement in CSS pixels without scaling the input', () => {
    const initial = input(), first = composerPlacement(initial)
    const next = composerPlacement({ ...initial, node: { ...initial.node, x: 475, y: 33 } })
    expect(first.mode).toBe('follow'); expect(next.mode).toBe('follow')
    expect(next.left - first.left).toBe(175); expect(next.top - first.top).toBe(-67)
    expect(next.width).toBe(540)
  })
  it('returns to the bottom dock independently of node geometry', () => {
    const initial = input(), fixed = composerPlacement({ ...initial, follow: false })
    expect(fixed).toMatchObject({ mode: 'fixed', left: 330, top: 536 })
    expect(composerPlacement({ ...initial, follow: false, node: { x: -1000, y: 900, width: 1, height: 1 } })).toEqual(fixed)
  })
  it('clamps horizontal edges and places above a low node without covering navigation', () => {
    const initial = input()
    expect(composerPlacement({ ...initial, node: { ...initial.node, x: -100 } }).left).toBe(12)
    const right = composerPlacement({ ...initial, node: { ...initial.node, x: 1050, y: 650 } })
    expect(right).toMatchObject({ mode: 'follow', left: 648, top: 338 })
    expect(right.top + initial.panelHeight).toBeLessThan(836)
  })
  it.each([{ width: 390, height: 700 }, { width: 1000, height: 420 }])('falls back on small viewports %j with a scrollable height budget', (viewport) => {
    const value = composerPlacement({ ...input(), viewport, panelHeight: 900 })
    expect(value.mode).toBe('fixed')
    expect(value.left).toBeGreaterThanOrEqual(12)
    expect(value.left + value.width).toBeLessThanOrEqual(viewport.width - 12)
    expect(value.top + value.maxHeight).toBeLessThanOrEqual(viewport.height - 64)
  })
  it('docks when no attached space exists or the node is outside the viewport', () => {
    expect(composerPlacement({ ...input(), node: { x: 0, y: 100, width: 800, height: 700 } }).mode).toBe('fixed')
    expect(composerPlacement({ ...input(), node: { x: 1400, y: 50, width: 100, height: 100 } }).mode).toBe('fixed')
  })
  it.each([{ width: 1200, height: 660, inset: 64 }, { width: 390, height: 780, inset: 100 }])('keeps tall video controls clear of the selection toolbar at $width pixels', ({ width, height, inset }) => {
    for (const follow of [true, false]) {
      const placement = composerPlacement({ ...input(), viewport: { width, height }, panelHeight: 900, follow })
      expect(placement.top).toBeGreaterThanOrEqual(inset)
      expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(height - 64)
    }
  })
})
