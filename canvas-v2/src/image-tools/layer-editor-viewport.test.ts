import { describe, expect, it } from 'vitest'
import { boundLayerEditorViewport, classifyLayerEditorPointer, clientToLayerEditorOutput, fitLayerEditorViewport, layerEditorViewportLimits, normalizeLayerEditorWheel, panLayerEditorViewport, resizeLayerEditorViewport, zoomLayerEditorViewport, type LayerEditorViewport, type LayerEditorViewportSize } from './layer-editor-viewport'

const output = { width: 4096, height: 2160 }, container = { width: 900, height: 600 }
function at(view: LayerEditorViewport, point: { x: number; y: number }) { return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom } }
function expectFinite(view: LayerEditorViewport) { expect(Object.values(view).every(Number.isFinite)).toBe(true); expect(view.zoom).toBeGreaterThan(0) }
function intersection(start: number, length: number, edge: number) { return Math.max(0, Math.min(start + length, edge) - Math.max(start, 0)) }

describe('layer editor physical pixel viewport', () => {
  it('fits the entire image with padding and defines 100 percent as one CSS pixel per output pixel', () => {
    const fitted = fitLayerEditorViewport(container, output)
    expect(fitted.zoom).toBe((900 - 48) / 4096)
    expect(fitted.x).toBe(24)
    expect(fitted.y).toBeCloseTo((600 - 2160 * fitted.zoom) / 2)
    const one = zoomLayerEditorViewport(fitted, 1, { x: 450, y: 300 }, container, output)
    expect(one.zoom).toBe(1)
    expect(at(one, { x: one.x + 1, y: one.y + 1 })).toEqual({ x: 1, y: 1 })
    const bounds = { left: 137, top: 91, ...container }
    expect(clientToLayerEditorOutput({ x: 137 + one.x + 123, y: 91 + one.y + 45 }, bounds, one)).toEqual({ x: 123, y: 45 })
  })
  it('allows a sub-two-percent fit on a narrow 4096px canvas without reversing a zoom-out gesture', () => {
    const narrow = { width: 80, height: 90 }, square = { width: 4096, height: 4096 }, fitted = fitLayerEditorViewport(narrow, square)
    expect(fitted.zoom).toBe(32 / 4096)
    expect(fitted.zoom).toBeLessThan(layerEditorViewportLimits.minZoom)
    expect(fitted.x).toBe(24); expect(fitted.y).toBe(29)
    const out = zoomLayerEditorViewport(fitted, fitted.zoom / 2, { x: 40, y: 45 }, narrow, square)
    expect(out).toEqual(fitted)
    const inside = zoomLayerEditorViewport(fitted, .02, { x: 40, y: 45 }, narrow, square)
    expect(inside.zoom).toBe(.02)
    expect(at(inside, { x: 40, y: 45 })).toEqual(at(fitted, { x: 40, y: 45 }))
  })
  it('preserves cursor anchors and clamps the requested scale to the supported range', () => {
    const view = { zoom: .5, x: -300, y: -200 }, anchor = { x: 203, y: 147 }, before = at(view, anchor)
    for (const requested of [.1, 1, 3, 50]) {
      const next = zoomLayerEditorViewport(view, requested, anchor, container, output)
      expect(next.zoom).toBe(Math.min(8, requested))
      expect(at(next, anchor).x).toBeCloseTo(before.x); expect(at(next, anchor).y).toBeCloseTo(before.y)
    }
    const smallest = zoomLayerEditorViewport(view, -1, { x: 450, y: 300 }, container, output)
    expect(smallest.zoom).toBe(.02)
    expect(zoomLayerEditorViewport(view, NaN, anchor, container, output)).toEqual(view)
  })
  it('preserves the output focus and pixel scale when the measured viewport resizes', () => {
    const old = { width: 700, height: 500 }, next = { width: 1000, height: 800 }, view = { zoom: .75, x: -250, y: -100 }
    const resized = resizeLayerEditorViewport(view, old, next, output)
    expect(resized.zoom).toBe(view.zoom)
    expect(at(resized, { x: 500, y: 400 })).toEqual(at(view, { x: 350, y: 250 }))
    // A legitimately small fit remains a small manual view after the panel grows.
    const tiny = fitLayerEditorViewport({ width: 80, height: 90 }, output)
    const larger = resizeLayerEditorViewport(tiny, { width: 80, height: 90 }, container, output)
    expect(larger.zoom).toBe(tiny.zoom)
    expect(at(larger, { x: 450, y: 300 })).toEqual(at(tiny, { x: 40, y: 45 }))
  })
  it('bounds panning with a visible image margin and keeps thumbnails fully reachable', () => {
    const view = { zoom: 1, x: 0, y: 0 }, moved = panLayerEditorViewport(view, { x: 1e9, y: -1e9 }, container, output)
    expect(moved).toEqual({ zoom: 1, x: 852, y: 48 - 2160 })
    expect(intersection(moved.x, output.width, container.width)).toBe(48)
    expect(intersection(moved.y, output.height, container.height)).toBe(48)
    const thumbnail = boundLayerEditorViewport({ zoom: 1, x: -900, y: 900 }, container, { width: 20, height: 10 })
    expect(thumbnail).toEqual({ zoom: 1, x: 0, y: 590 })
    const finite = panLayerEditorViewport(view, { x: NaN, y: Infinity }, container, output)
    expect(finite).toEqual(view)
  })
  it('maps captured pointer positions outside the canvas without silently clipping edit coordinates', () => {
    const view = { zoom: .25, x: 40, y: 10 }, bounds = { left: 200, top: 100, width: 400, height: 300 }
    expect(clientToLayerEditorOutput({ x: 220, y: 105 }, bounds, view)).toEqual({ x: -80, y: -20 })
    expect(clientToLayerEditorOutput({ x: 1240, y: 610 }, bounds, view)).toEqual({ x: 4000, y: 2000 })
  })
  it.each([0, -1, NaN, Infinity])('recovers safely from an unavailable dimension %s', (invalid) => {
    const unavailable: LayerEditorViewportSize = { width: invalid, height: 300 }, bad = { zoom: NaN, x: Infinity, y: -Infinity }
    expect(fitLayerEditorViewport(unavailable, output)).toEqual({ zoom: 1, x: 0, y: 0 })
    expectFinite(boundLayerEditorViewport(bad, container, output))
    expectFinite(zoomLayerEditorViewport(bad, Infinity, { x: NaN, y: NaN }, container, output))
    expectFinite(panLayerEditorViewport(bad, { x: 1, y: 1 }, unavailable, output))
    expect(resizeLayerEditorViewport(bad, unavailable, container, output)).toEqual(fitLayerEditorViewport(container, output))
    expect(clientToLayerEditorOutput({ x: 1, y: 1 }, { left: 0, top: 0, ...unavailable }, { zoom: 1, x: 0, y: 0 })).toBeNull()
  })
  it('keeps fractional narrow containers inside their measured CSS bounds', () => {
    for (const width of [.25, 1, 48, 390, 960]) for (const height of [.5, 1, 48, 844]) {
      const fitted = fitLayerEditorViewport({ width, height }, output)
      expectFinite(fitted)
      expect(fitted.x).toBeGreaterThanOrEqual(-1e-10); expect(fitted.y).toBeGreaterThanOrEqual(-1e-10)
      expect(output.width * fitted.zoom).toBeLessThanOrEqual(width + 1e-10)
      expect(output.height * fitted.zoom).toBeLessThanOrEqual(height + 1e-10)
      expect(panLayerEditorViewport(fitted, { x: 0, y: 0 }, { width, height }, output)).toEqual(fitted)
    }
  })
  it('handles extreme output ratios and rejects non-finite output geometry', () => {
    for (const size of [{ width: 4096, height: 1 }, { width: 1, height: 4096 }, { width: 1, height: 1 }, { width: Number.MAX_SAFE_INTEGER, height: 4096 }]) {
      const fitted = fitLayerEditorViewport(container, size)
      expectFinite(fitted)
      expect(size.width * fitted.zoom).toBeLessThanOrEqual(container.width)
      expect(size.height * fitted.zoom).toBeLessThanOrEqual(container.height)
      expectFinite(panLayerEditorViewport(fitted, { x: 1e10, y: -1e10 }, container, size))
    }
    for (const invalid of [0, -1, NaN, Infinity, Number.MAX_VALUE]) expect(fitLayerEditorViewport(container, { width: invalid, height: 4096 })).toEqual({ zoom: 1, x: 0, y: 0 })
    expect(clientToLayerEditorOutput({ x: 1, y: 1 }, { left: 0, top: 0, ...container }, { zoom: 0, x: 0, y: 0 })).toBeNull()
    expect(clientToLayerEditorOutput({ x: NaN, y: 1 }, { left: 0, top: 0, ...container }, { zoom: 1, x: 0, y: 0 })).toBeNull()
  })
  it('normalizes wheel pixels, lines and pages without device-pixel-ratio assumptions', () => {
    expect(normalizeLayerEditorWheel({ deltaY: 2 }, 600)).toBe(2)
    expect(normalizeLayerEditorWheel({ deltaY: 2, deltaMode: 1 }, 600)).toBe(32)
    expect(normalizeLayerEditorWheel({ deltaY: -.1, deltaMode: 2 }, 600)).toBe(-60)
    expect(normalizeLayerEditorWheel({ deltaY: 1, deltaMode: 2 }, 600)).toBe(120)
    expect(normalizeLayerEditorWheel({ deltaY: -1000 }, 600)).toBe(-120)
    expect(normalizeLayerEditorWheel({ deltaY: 1, deltaMode: 2 }, 0)).toBe(1)
    expect(normalizeLayerEditorWheel({ deltaY: NaN }, 600)).toBe(0)
    expect(normalizeLayerEditorWheel({ deltaY: 1, deltaMode: 99 }, 600)).toBe(0)
  })
  it('classifies explicit hand or Space gestures as navigation without stealing mouse or touch edits', () => {
    expect(classifyLayerEditorPointer({ button: 0 })).toBe('edit')
    expect(classifyLayerEditorPointer({ button: 0, pointerType: 'pen' })).toBe('edit')
    expect(classifyLayerEditorPointer({ button: 0, handTool: true })).toBe('pan')
    expect(classifyLayerEditorPointer({ button: 0, spaceKey: true })).toBe('pan')
    expect(classifyLayerEditorPointer({ button: 1 })).toBe('pan')
    expect(classifyLayerEditorPointer({ button: 0, pointerType: 'touch' })).toBe('edit')
    expect(classifyLayerEditorPointer({ button: 0, pointerType: 'touch', handTool: true })).toBe('pan')
    for (const input of [{ button: 2 }, { button: -1 }, { button: 0, isPrimary: false }, { button: 1, editingTarget: true }, { button: 0, pointerType: 'touch', blocked: true }]) expect(classifyLayerEditorPointer(input)).toBe('ignore')
  })
  it('never mutates the caller view or geometry and round-trips a series of anchored zooms', () => {
    const view = { zoom: .5, x: -300, y: -200 }, original = { ...view }, anchor = { x: 300, y: 200 }
    let current = view
    for (const value of [1, 2, .5, 3, .5]) current = zoomLayerEditorViewport(current, value, anchor, container, output)
    expect(current).toEqual(view); expect(view).toEqual(original)
    expect(panLayerEditorViewport(view, { x: 0, y: 0 }, container, output)).toEqual(view)
  })
})
