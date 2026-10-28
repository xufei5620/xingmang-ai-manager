import { describe, expect, it } from 'vitest'
import type { Rect } from '@xyflow/react'
import { canvasSafeViewport, canvasViewportZoomLabel, fitCanvasViewport } from './canvas-viewport'
import { maximumCanvasViewportTranslation, maximumCanvasViewportZoom, minimumCanvasViewportZoom } from '../persistence/canvas-viewport-limits'
import { maximumCoordinateMagnitude, maximumWorkflowNodes } from '../persistence/workflow-schema'
import { parseWorkflowFile, parseWorkflowFileDetailed, serializeWorkflow } from '../model'

function contained(bounds: Rect, safe: Rect) {
  const viewport = fitCanvasViewport(bounds, safe)!
  expect(viewport).not.toBeNull()
  expect([viewport.x, viewport.y, viewport.zoom, 1 / viewport.zoom].every(Number.isFinite)).toBe(true)
  expect(bounds.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(safe.x - 1e-7)
  expect(bounds.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(safe.y - 1e-7)
  expect((bounds.x + bounds.width) * viewport.zoom + viewport.x).toBeLessThanOrEqual(safe.x + safe.width + 1e-7)
  expect((bounds.y + bounds.height) * viewport.zoom + viewport.y).toBeLessThanOrEqual(safe.y + safe.height + 1e-7)
  return viewport
}
describe('measured safe canvas fit and numerical viewport bounds', () => {
  it.each([{ width: 1280, height: 672 }, { width: 540, height: 500 }, { width: 280, height: 220 }])('avoids measured toolbar wrapping, navigation and minimap at $width×$height', (surface) => {
    const overlays = [{ x: 30, y: 12, width: surface.width - 60, height: surface.width < 600 ? 86 : 42 }, { x: surface.width - 210, y: surface.height - 46, width: 198, height: 34 }, { x: surface.width - 180, y: surface.height - 174, width: 168, height: 120 }]
    const safe = canvasSafeViewport(surface, overlays)!
    expect(safe.width * safe.height).toBeGreaterThan(0)
    for (const rect of overlays) expect(safe.x >= rect.x + rect.width || safe.x + safe.width <= rect.x || safe.y >= rect.y + rect.height || safe.y + safe.height <= rect.y).toBe(true)
    contained({ x: -1000, y: -500, width: 11680, height: 1680 }, safe)
  })
  it('fits a worst-case legal nested world span without a readability clamp or CSS underflow', () => {
    const span = (maximumWorkflowNodes * 2 + 1) * maximumCoordinateMagnitude
    const viewport = contained({ x: -span / 2, y: -span / 2, width: span, height: span }, { x: 12, y: 64, width: 256, height: 120 })
    expect(viewport.zoom).toBeGreaterThanOrEqual(minimumCanvasViewportZoom)
    expect(viewport.zoom).toBeLessThan(.000001)
    expect(viewport.zoom * span).toBeGreaterThan(100)
    expect(viewport.zoom * 280).toBeGreaterThan(Number.MIN_VALUE)
    expect(canvasViewportZoomLabel(viewport.zoom)).not.toBe('0%')
    const restored = parseWorkflowFile(serializeWorkflow({ schemaVersion: 2, name: '极大范围', nodes: [], edges: [], viewport }))
    expect(restored?.viewport).toEqual(viewport)
  })
  it.each([minimumCanvasViewportZoom, .000002, .01, 1, maximumCanvasViewportZoom])('round-trips the shared valid zoom %s', (zoom) => {
    const viewport = { x: 400, y: 300, zoom }
    expect(parseWorkflowFile(serializeWorkflow({ schemaVersion: 2, name: '比例', nodes: [], edges: [], viewport }))?.viewport).toEqual(viewport)
  })
  it.each([0, -.5, NaN, Infinity, -Infinity, minimumCanvasViewportZoom / 2, maximumCanvasViewportZoom + .1])('rejects invalid zoom %s without discarding the graph', (zoom) => {
    const result = parseWorkflowFileDetailed(JSON.stringify({ schemaVersion: 2, name: '保留内容', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom } }))
    expect(result?.workflow.name).toBe('保留内容'); expect(result?.workflow.viewport).toBeUndefined(); expect(result?.warnings).toContain('已忽略无效的画布视口')
  })
  it.each([-1, 1])('preserves full-zoom translations of legal distant nodes in direction %s', (direction) => {
    const center = direction * maximumCoordinateMagnitude
    const viewport = { x: 400 - center * maximumCanvasViewportZoom, y: 300 + center * maximumCanvasViewportZoom, zoom: maximumCanvasViewportZoom }
    expect(Math.abs(viewport.x)).toBeGreaterThan(maximumCoordinateMagnitude)
    expect(parseWorkflowFile(serializeWorkflow({ schemaVersion: 2, name: '远处原尺寸', nodes: [], edges: [], viewport }))?.viewport).toEqual(viewport)
  })
  it.each([NaN, Infinity, -Infinity, maximumCanvasViewportTranslation + 1, -maximumCanvasViewportTranslation - 1])('rejects invalid viewport translation %s', (value) => {
    for (const axis of ['x', 'y']) {
      const parsed = parseWorkflowFileDetailed(JSON.stringify({ schemaVersion: 2, name: '保护位置', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1, [axis]: value } }))
      expect(parsed?.workflow.viewport).toBeUndefined(); expect(parsed?.warnings).toContain('已忽略无效的画布视口')
    }
  })
  it('retains the original node coordinate limit while expanding only the viewport', () => {
    const parsed = parseWorkflowFileDetailed(JSON.stringify({ schemaVersion: 2, name: '不放宽节点', nodes: [{ id: 'bad', kind: 'prompt', position: { x: maximumCoordinateMagnitude + 1, y: 0 }, data: { prompt: '', model: '', status: 'idle' } }], edges: [] }))
    expect(parsed).toBeNull()
  })
  it.each([NaN, Infinity, 0, -1])('does not produce an invalid fit for an unusable surface %s', (width) => {
    expect(canvasSafeViewport({ width, height: 600 }, [])).toBeNull()
  })
})
