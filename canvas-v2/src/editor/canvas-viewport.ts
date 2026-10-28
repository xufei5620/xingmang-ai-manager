import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/react'
import { maximumCanvasViewportZoom, minimumCanvasViewportZoom } from '../persistence/canvas-viewport-limits'

export interface CanvasViewportSurface { width: number; height: number }

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Largest unobscured rectangle. Edge overlays may wrap or resize, so their
 * measured bounds, rather than a fixed toolbar height, reserve the workspace.
 */
export function canvasSafeViewport(surface: CanvasViewportSurface, overlays: readonly Rect[]): Rect | null {
  if (![surface.width, surface.height].every((value) => Number.isFinite(value) && value >= 2)) return null
  const inset = Math.min(12, surface.width / 8, surface.height / 8)
  const frame = { x: inset, y: inset, width: surface.width - inset * 2, height: surface.height - inset * 2 }
  const obstacles = overlays.filter((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0 && intersects(frame, rect)).map((rect) => ({ x: Math.max(frame.x, rect.x - 8), y: Math.max(frame.y, rect.y - 8), width: Math.min(frame.x + frame.width, rect.x + rect.width + 8) - Math.max(frame.x, rect.x - 8), height: Math.min(frame.y + frame.height, rect.y + rect.height + 8) - Math.max(frame.y, rect.y - 8) }))
  const xs = [...new Set([frame.x, frame.x + frame.width, ...obstacles.flatMap((rect) => [rect.x, rect.x + rect.width])])].sort((a, b) => a - b)
  let best: Rect | null = null
  for (let left = 0; left < xs.length - 1; left += 1) {
    for (let right = left + 1; right < xs.length; right += 1) {
      const blocked = obstacles.filter((rect) => rect.x < xs[right] && rect.x + rect.width > xs[left]).sort((a, b) => a.y - b.y)
      let top = frame.y
      for (const rect of [...blocked, { x: 0, y: frame.y + frame.height, width: 0, height: 0 }]) {
        const candidate = { x: xs[left], y: top, width: xs[right] - xs[left], height: rect.y - top }
        if (candidate.width >= 1 && candidate.height >= 1 && (!best || candidate.width * candidate.height > best.width * best.height)) best = candidate
        top = Math.max(top, rect.y + rect.height)
      }
    }
  }
  return best
}

export function fitCanvasViewport(bounds: Rect, safe: Rect, maximumZoom = 1): Viewport | null {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, safe.x, safe.y, safe.width, safe.height, maximumZoom].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || safe.width <= 0 || safe.height <= 0 || maximumZoom <= 0) return null
  const maximum = Math.min(maximumCanvasViewportZoom, Math.max(minimumCanvasViewportZoom, maximumZoom))
  const viewport = getViewportForBounds(bounds, safe.width, safe.height, minimumCanvasViewportZoom, maximum, 0.08)
  const result = { ...viewport, x: viewport.x + safe.x, y: viewport.y + safe.y }
  return [result.x, result.y, result.zoom].every(Number.isFinite) && result.zoom > 0 ? result : null
}

export function measureCanvasSafeViewport(pane: HTMLElement): Rect | null {
  const bounds = pane.getBoundingClientRect()
  const overlays = [...pane.querySelectorAll<HTMLElement>('.canvas-selection-toolbar, .canvas-navigation-tools, .canvas-statusbar, .react-flow__controls, .react-flow__minimap')]
  // Side panels normally consume flex width; include their intersection too
  // when responsive styles place them over the pane instead.
  overlays.push(...(pane.parentElement?.querySelectorAll<HTMLElement>('.canvas-inspector, .canvas-agent-panel') ?? []))
  return canvasSafeViewport(bounds, overlays.filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0).map((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height }
  }))
}

export function canvasViewportZoomLabel(zoom: number): string {
  return `${new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 3 }).format(zoom * 100)}%`
}
