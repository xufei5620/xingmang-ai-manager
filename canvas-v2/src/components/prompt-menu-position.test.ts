import { describe, expect, it } from 'vitest'
import { positionPromptMenu, promptShortcutOwnsFocus, promptShortcutShouldDismiss, type PromptMenuRect, type PromptMenuViewport } from './prompt-menu-position'

const viewport = { left: 0, top: 0, width: 1280, height: 720 }
function rect(left: number, top: number, width: number, height: number): PromptMenuRect { return { left, top, right: left + width, bottom: top + height, width } }
function expectInside(anchor: PromptMenuRect, view: PromptMenuViewport, height: number) {
  const result = positionPromptMenu(anchor, view, height)
  expect(result.left).toBeGreaterThanOrEqual(view.left + 8)
  expect(result.top).toBeGreaterThanOrEqual(view.top + 8)
  expect(result.left + result.width).toBeLessThanOrEqual(view.left + view.width - 8)
  expect(result.top + Math.min(height, result.maxHeight)).toBeLessThanOrEqual(view.top + view.height - 8)
  return result
}

describe('prompt shortcut portal positioning', () => {
  it('keeps the reported 118 percent zoom overflow fully inside a 1280 by 720 viewport', () => {
    const result = expectInside(rect(343.24, 347.62, 377.6, 130), viewport, 513.3)
    expect(result.side).toBe('above')
    expect(result.top).toBe(8)
    expect(result.maxHeight).toBeCloseTo(331.62)
  })

  it('opens below a node near the top and above a node near the bottom', () => {
    expect(expectInside(rect(100, 20, 320, 120), viewport, 430).side).toBe('below')
    expect(expectInside(rect(100, 580, 320, 120), viewport, 430).side).toBe('above')
  })

  it('clamps horizontal placement independently of canvas scale', () => {
    for (const zoom of [0.25, 1, 1.18, 2.5]) {
      const result = expectInside(rect(1100, 100, 320 * zoom, 120 * zoom), viewport, 430)
      expect(result.width).toBeGreaterThanOrEqual(320)
      expect(result.width).toBeLessThanOrEqual(420)
    }
  })

  it('uses a scrollable viewport overlay when neither side can fit its controls', () => {
    const view = { left: 0, top: 0, width: 360, height: 260 }
    const result = expectInside(rect(35, 80, 280, 160), view, 610)
    expect(result).toMatchObject({ side: 'overlay', top: 8, width: 320, maxHeight: 244 })
  })

  it('supports keyboard-reduced visual viewports and offscreen anchors', () => {
    const view = { left: 40, top: 90, width: 350, height: 300 }
    for (const anchor of [rect(-100, -300, 640, 150), rect(350, 800, 60, 50), rect(70, 140, 280, 150)]) expectInside(anchor, view, 700)
  })

  it('keeps an expanded creation form and error feedback reachable without changing its anchor', () => {
    const anchor = rect(343, 348, 378, 130)
    const compact = expectInside(anchor, viewport, 170)
    const form = expectInside(anchor, viewport, 650)
    expect(form.maxHeight).toBe(compact.maxHeight)
    expect(form.left).toBe(compact.left)
    expect(form.top).toBe(8)
  })

  it('retains focus only for a portal owned by the same prompt editor', () => {
    const target = { closest: () => ({ getAttribute: () => ':prompt-1:' }) }
    expect(promptShortcutOwnsFocus(':prompt-1:', target)).toBe(true)
    expect(promptShortcutOwnsFocus(':prompt-2:', target)).toBe(false)
    expect(promptShortcutOwnsFocus(':prompt-1:', { closest: () => null })).toBe(false)
    expect(promptShortcutOwnsFocus(':prompt-1:', null)).toBe(false)
  })

  it('keeps creation state through disabled-control and form-to-results blur events', () => {
    const owner = ':prompt-1:'
    const panel = { closest: () => ({ getAttribute: () => owner }) }
    // Focus moves from submit to the stable panel, then disabled/remounted
    // controls may report no new focus target before the search field mounts.
    for (const target of [panel, null, null, panel]) {
      expect(promptShortcutShouldDismiss(owner, 'blur', target, false)).toBe(false)
    }
    expect(promptShortcutShouldDismiss(owner, 'pointer', panel, false)).toBe(false)
  })

  it('still closes for an outside pointer or keyboard focus while retaining editor focus', () => {
    const outside = { closest: () => null }
    const otherMenu = { closest: () => ({ getAttribute: () => ':prompt-2:' }) }
    expect(promptShortcutShouldDismiss(':prompt-1:', 'pointer', outside, false)).toBe(true)
    expect(promptShortcutShouldDismiss(':prompt-1:', 'pointer', null, false)).toBe(true)
    expect(promptShortcutShouldDismiss(':prompt-1:', 'blur', outside, false)).toBe(true)
    expect(promptShortcutShouldDismiss(':prompt-1:', 'blur', otherMenu, false)).toBe(true)
    expect(promptShortcutShouldDismiss(':prompt-1:', 'blur', outside, true)).toBe(false)
    expect(promptShortcutShouldDismiss(':prompt-1:', 'pointer', outside, true)).toBe(false)
  })
})
