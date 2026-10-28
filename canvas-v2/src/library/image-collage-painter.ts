import type { ImageCollageWatermark } from '../image-tools/recipe'
import type { ImageTransformDraw, ImageTransformRect, ImageTransformSize } from '../image-tools/geometry'

/** Keep the same full-cell clipping and inside border in preview and PNG. */
export function traceCollageRoundedRect(context: CanvasRenderingContext2D, rect: ImageTransformRect, radius: number): void {
  const { x, y, width, height } = rect
  const r = Math.min(Math.max(0, radius), width / 2, height / 2), k = 0.5522847498307936
  context.beginPath()
  if (!r) { context.rect(x, y, width, height); return }
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.bezierCurveTo(x + width - r + k * r, y, x + width, y + r - k * r, x + width, y + r)
  context.lineTo(x + width, y + height - r)
  context.bezierCurveTo(x + width, y + height - r + k * r, x + width - r + k * r, y + height, x + width - r, y + height)
  context.lineTo(x + r, y + height)
  context.bezierCurveTo(x + r - k * r, y + height, x, y + height - r + k * r, x, y + height - r)
  context.lineTo(x, y + r)
  context.bezierCurveTo(x, y + r - k * r, x + r - k * r, y, x + r, y)
  context.closePath()
}

function paintCellShadow(context: CanvasRenderingContext2D, rect: ImageTransformRect, radius: number, output: ImageTransformSize): void {
  const sx = context.canvas.width / output.width, sy = context.canvas.height / output.height
  const left = Math.max(0, Math.floor(rect.x - 24)), top = Math.max(0, Math.floor(rect.y - 24))
  const right = Math.min(output.width, Math.ceil(rect.x + rect.width + 24)), bottom = Math.min(output.height, Math.ceil(rect.y + rect.height + 26))
  if (right <= left || bottom <= top) return
  const surface = document.createElement('canvas')
  surface.width = Math.max(1, Math.ceil((right - left) * sx)); surface.height = Math.max(1, Math.ceil((bottom - top) * sy))
  try {
    const shadow = surface.getContext('2d', { alpha: true })
    if (!shadow) throw new Error('浏览器无法创建拼图阴影画布')
    shadow.scale(surface.width / (right - left), surface.height / (bottom - top))
    shadow.translate(-left, -top)
    // Canvas shadows are in device pixels and are not transformed by the CTM.
    shadow.shadowOffsetX = 0; shadow.shadowOffsetY = 2 * sy; shadow.shadowBlur = 8 * Math.max(sx, sy); shadow.shadowColor = '#00000080'
    shadow.fillStyle = '#000000'; traceCollageRoundedRect(shadow, rect, radius); shadow.fill()
    shadow.shadowColor = 'transparent'; shadow.shadowBlur = 0; shadow.shadowOffsetY = 0
    shadow.globalCompositeOperation = 'destination-out'; traceCollageRoundedRect(shadow, rect, radius); shadow.fill()
    context.drawImage(surface, left, top, right - left, bottom - top)
  } finally { surface.width = 0; surface.height = 0 }
}

export function paintImageCollageCell(context: CanvasRenderingContext2D, image: CanvasImageSource, command: ImageTransformDraw, output: ImageTransformSize): void {
  const style = command.collageCell, source = command.source, destination = command.destination
  context.save()
  try {
    if (style?.shadow) paintCellShadow(context, style.rect, style.cornerRadius, output)
    if (style) { traceCollageRoundedRect(context, style.rect, style.cornerRadius); context.clip() }
    context.drawImage(image, source.x, source.y, source.width, source.height, destination.x, destination.y, destination.width, destination.height)
  } finally { context.restore() }
  if (style && style.borderWidth > 0 && style.borderColor !== 'transparent') {
    const width = Math.min(style.borderWidth, style.rect.width, style.rect.height), inset = width / 2
    context.save()
    try {
      // A thick miter stroke must not square off a smaller outer corner radius.
      traceCollageRoundedRect(context, style.rect, style.cornerRadius); context.clip()
      if (width * 2 >= Math.min(style.rect.width, style.rect.height)) {
        // No inner opening survives. A degenerate stroke path can paint nothing.
        context.fillStyle = style.borderColor
        traceCollageRoundedRect(context, style.rect, style.cornerRadius); context.fill()
      } else {
        context.strokeStyle = style.borderColor; context.lineWidth = width
        traceCollageRoundedRect(context, { x: style.rect.x + inset, y: style.rect.y + inset, width: style.rect.width - width, height: style.rect.height - width }, Math.max(0, style.cornerRadius - inset))
        context.stroke()
      }
    } finally { context.restore() }
  }
}

export interface CollageWatermarkPlan { angle: number; positions: Array<{ x: number; y: number }> }

/** Bound work independently of short/long user text and output aspect ratio. */
export function buildCollageWatermarkPlan(size: ImageTransformSize, watermark: ImageCollageWatermark, measuredWidth: number): CollageWatermarkPlan {
  if (![size.width, size.height, measuredWidth, watermark.fontSize].every(Number.isFinite) || size.width <= 0 || size.height <= 0 || measuredWidth < 0) throw new Error('拼图水印尺寸无效')
  const diagonal = Math.hypot(size.width, size.height)
  let spacingX = Math.max(160, measuredWidth + watermark.fontSize * 4), spacingY = Math.max(100, watermark.fontSize * 5)
  function counts() { return { x: Math.ceil(diagonal / spacingX) + 2, y: Math.ceil(diagonal / spacingY) + 2 } }
  let count = counts()
  while (count.x * count.y > 512) { spacingX *= 1.25; spacingY *= 1.25; count = counts() }
  const positions = Array.from({ length: count.x * count.y }, (_, index) => ({ x: (index % count.x - (count.x - 1) / 2) * spacingX, y: (Math.floor(index / count.x) - (count.y - 1) / 2) * spacingY }))
  return { angle: -Math.PI / 6, positions }
}

export function paintImageCollageWatermark(context: CanvasRenderingContext2D, size: ImageTransformSize, watermark: ImageCollageWatermark): void {
  if (!watermark.text || watermark.opacity <= 0 || watermark.color === 'transparent') return
  context.save()
  try {
    context.font = `400 ${watermark.fontSize}px sans-serif`
    const plan = buildCollageWatermarkPlan(size, watermark, context.measureText(watermark.text).width)
    context.fillStyle = watermark.color; context.globalAlpha = watermark.opacity; context.textAlign = 'center'; context.textBaseline = 'middle'
    context.translate(size.width / 2, size.height / 2); context.rotate(plan.angle)
    for (const point of plan.positions) context.fillText(watermark.text, point.x, point.y)
  } finally { context.restore() }
}
