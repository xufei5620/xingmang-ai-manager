/** Session-only view geometry. Zoom is CSS pixels per output pixel; x/y locate
 * the output's top-left corner inside the viewport. No recipe/history fields. */
export interface LayerEditorViewport { zoom: number; x: number; y: number }
export interface LayerEditorViewportSize { width: number; height: number }
export interface LayerEditorViewportPoint { x: number; y: number }
export interface LayerEditorViewportBounds extends LayerEditorViewportSize { left: number; top: number }
export const layerEditorViewportLimits = { minZoom: .02, maxZoom: 8, fitPadding: 24, visibleMargin: 48, wheelLinePixels: 16, wheelPixels: 120 } as const

function validSize(value: LayerEditorViewportSize): boolean {
  return [value.width, value.height].every((number) => Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER)
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
function finite(value: number, fallback: number): number { return Number.isFinite(value) ? value : fallback }
function point(value: LayerEditorViewportPoint, fallback: LayerEditorViewportPoint): LayerEditorViewportPoint { return { x: finite(value.x, fallback.x), y: finite(value.y, fallback.y) } }

export function fitLayerEditorViewport(container: LayerEditorViewportSize, output: LayerEditorViewportSize, padding: number = layerEditorViewportLimits.fitPadding): LayerEditorViewport {
  if (!validSize(container) || !validSize(output)) return { zoom: 1, x: 0, y: 0 }
  const inset = Math.max(0, finite(padding, layerEditorViewportLimits.fitPadding))
  // A fit may be below the normal interactive minimum on a narrow viewport.
  // Never enlarge that fit to .02 and crop a 4096px image simply to meet a UI limit.
  const zoom = Math.min(layerEditorViewportLimits.maxZoom, Math.max(Math.min(1, container.width), container.width - inset * 2) / output.width, Math.max(Math.min(1, container.height), container.height - inset * 2) / output.height)
  return { zoom, x: (container.width - output.width * zoom) / 2, y: (container.height - output.height * zoom) / 2 }
}

function safeView(view: LayerEditorViewport, container: LayerEditorViewportSize, output: LayerEditorViewportSize): LayerEditorViewport {
  const fit = fitLayerEditorViewport(container, output)
  const zoom = Number.isFinite(view.zoom) && view.zoom > 0 ? Math.min(layerEditorViewportLimits.maxZoom, view.zoom) : fit.zoom
  return { zoom, x: finite(view.x, fit.x), y: finite(view.y, fit.y) }
}

/** Keep at least a small intersection on both axes. An image axis no larger
 * than the margin stays wholly visible; otherwise that margin stays reachable.
 * Bounding never raises an existing valid fit zoom during a resize. */
export function boundLayerEditorViewport(view: LayerEditorViewport, container: LayerEditorViewportSize, output: LayerEditorViewportSize, margin: number = layerEditorViewportLimits.visibleMargin): LayerEditorViewport {
  if (!validSize(container) || !validSize(output)) return fitLayerEditorViewport(container, output)
  const current = safeView(view, container, output), width = output.width * current.zoom, height = output.height * current.zoom
  const visible = Math.max(1, finite(margin, layerEditorViewportLimits.visibleMargin)), visibleX = Math.min(visible, width, container.width), visibleY = Math.min(visible, height, container.height)
  return { zoom: current.zoom, x: clamp(current.x, visibleX - width, container.width - visibleX), y: clamp(current.y, visibleY - height, container.height - visibleY) }
}

/** Anchor is viewport-local CSS pixels. The same output coordinate stays under
 * it, except where keeping the image reachable requires a final boundary clamp. */
export function zoomLayerEditorViewport(view: LayerEditorViewport, nextZoom: number, anchor: LayerEditorViewportPoint, container: LayerEditorViewportSize, output: LayerEditorViewportSize): LayerEditorViewport {
  if (!validSize(container) || !validSize(output)) return fitLayerEditorViewport(container, output)
  const current = safeView(view, container, output), focus = point(anchor, { x: container.width / 2, y: container.height / 2 })
  const minimum = Math.min(layerEditorViewportLimits.minZoom, fitLayerEditorViewport(container, output).zoom, current.zoom)
  const zoom = clamp(finite(nextZoom, current.zoom), minimum, layerEditorViewportLimits.maxZoom), factor = zoom / current.zoom
  return boundLayerEditorViewport({ zoom, x: focus.x - (focus.x - current.x) * factor, y: focus.y - (focus.y - current.y) * factor }, container, output)
}

export function panLayerEditorViewport(view: LayerEditorViewport, delta: LayerEditorViewportPoint, container: LayerEditorViewportSize, output: LayerEditorViewportSize): LayerEditorViewport {
  const current = safeView(view, container, output), change = point(delta, { x: 0, y: 0 })
  return boundLayerEditorViewport({ ...current, x: current.x + change.x, y: current.y + change.y }, container, output)
}

/** Resize preserves the output point under the old viewport centre and its real
 * pixel scale. The owner explicitly calls fit instead while in fit mode. */
export function resizeLayerEditorViewport(view: LayerEditorViewport, previous: LayerEditorViewportSize, next: LayerEditorViewportSize, output: LayerEditorViewportSize): LayerEditorViewport {
  if (!validSize(previous) || !validSize(next) || !validSize(output)) return fitLayerEditorViewport(next, output)
  const current = safeView(view, previous, output)
  return boundLayerEditorViewport({ zoom: current.zoom, x: current.x + (next.width - previous.width) / 2, y: current.y + (next.height - previous.height) / 2 }, next, output)
}

/** Mapping is deliberately unbounded so captured drags can finish outside the
 * image. Individual edit tools decide whether to clip or reject those points. */
export function clientToLayerEditorOutput(client: LayerEditorViewportPoint, bounds: LayerEditorViewportBounds, view: LayerEditorViewport): LayerEditorViewportPoint | null {
  if (!validSize(bounds) || ![client.x, client.y, bounds.left, bounds.top, view.x, view.y, view.zoom].every(Number.isFinite) || view.zoom <= 0) return null
  const x = (client.x - bounds.left - view.x) / view.zoom, y = (client.y - bounds.top - view.y) / view.zoom
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

export function normalizeLayerEditorWheel(event: { deltaY: number; deltaMode?: number }, containerHeight: number): number {
  if (!Number.isFinite(event.deltaY) || event.deltaMode !== undefined && ![0, 1, 2].includes(event.deltaMode)) return 0
  const unit = event.deltaMode === 1 ? layerEditorViewportLimits.wheelLinePixels : event.deltaMode === 2 ? Math.max(1, finite(containerHeight, 1)) : 1
  return clamp(event.deltaY * unit, -layerEditorViewportLimits.wheelPixels, layerEditorViewportLimits.wheelPixels)
}

export interface LayerEditorPointerInput {
  button: number
  pointerType?: string
  isPrimary?: boolean
  handTool?: boolean
  spaceKey?: boolean
  editingTarget?: boolean
  blocked?: boolean
}

export function classifyLayerEditorPointer(input: LayerEditorPointerInput): 'pan' | 'edit' | 'ignore' {
  if (input.blocked || input.editingTarget || input.isPrimary === false || ![0, 1].includes(input.button)) return 'ignore'
  if (input.button === 1 || input.handTool || input.spaceKey) return 'pan'
  return 'edit'
}
