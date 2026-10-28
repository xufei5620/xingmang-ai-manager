import { parseImageTransformRecipe, imageLayerPointScale, type ImageLayer, type ImageLayerRecipe, type ImageLayerPathContent, type ImageLayerStroke } from './recipe'

export type AnnotationTool = 'select' | 'brush' | 'eraser' | 'line' | 'rectangle' | 'ellipse' | 'arrow' | 'text' | 'label'
export type AnnotationBrush = 'round' | 'marker' | 'soft' | 'neon' | 'light'
export interface AnnotationPoint { x: number; y: number }
export interface AnnotationStyle { color: string; size: number; opacity: number; brush: AnnotationBrush; fontSize: number; background: string; backgroundOpacity: number; radius: number }
export interface AnnotationErase { points: AnnotationPoint[]; size: number }
interface AnnotationBase { id: string; style: AnnotationStyle; erasures: AnnotationErase[] }
export type AnnotationObject = AnnotationBase & (
  { kind: 'brush' | 'line'; points: AnnotationPoint[] } |
  { kind: 'rectangle' | 'ellipse' | 'arrow'; start: AnnotationPoint; end: AnnotationPoint } |
  { kind: 'text' | 'label'; x: number; y: number; text: string; lines: string[]; width: number; height: number; padding: number }
)
export interface AnnotationDocument { width: number; height: number; objects: AnnotationObject[] }
export interface AnnotationHistory { present: AnnotationDocument; past: AnnotationDocument[]; future: AnnotationDocument[] }
export interface AnnotationBounds { x: number; y: number; width: number; height: number }
export type AnnotationMeasure = (text: string, fontSize: number) => number
export const defaultAnnotationStyle: AnnotationStyle = { color: '#ffcf55', size: 8, opacity: 1, brush: 'round', fontSize: 28, background: '#171b25', backgroundOpacity: .9, radius: 8 }

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
export function annotationColor(value: string): string | null { return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null }
export function annotationPoint(client: AnnotationPoint, rect: { left: number; top: number; width: number; height: number }, document: { width: number; height: number }): AnnotationPoint | null {
  if (![client.x, client.y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null
  return { x: clamp((client.x - rect.left) * document.width / rect.width, 0, document.width), y: clamp((client.y - rect.top) * document.height / rect.height, 0, document.height) }
}
export function createAnnotationHistory(width: number, height: number): AnnotationHistory {
  const present = { width, height, objects: [] }
  buildAnnotationRecipe(present)
  return { present, past: [], future: [] }
}
export function commitAnnotation(history: AnnotationHistory, document: AnnotationDocument): AnnotationHistory {
  buildAnnotationRecipe(document)
  if (JSON.stringify(history.present) === JSON.stringify(document)) return history
  return { present: document, past: [...history.past, history.present].slice(-60), future: [] }
}
export function undoAnnotation(history: AnnotationHistory): AnnotationHistory {
  const present = history.past.at(-1)
  return present ? { present, past: history.past.slice(0, -1), future: [history.present, ...history.future] } : history
}
export function redoAnnotation(history: AnnotationHistory): AnnotationHistory {
  const present = history.future[0]
  return present ? { present, past: [...history.past, history.present], future: history.future.slice(1) } : history
}
export function annotationBounds(object: AnnotationObject): AnnotationBounds {
  if ('x' in object) return { x: object.x, y: object.y, width: object.width, height: object.height + (object.kind === 'label' ? Math.min(12, object.style.fontSize * .35) : 0) }
  const points = 'points' in object ? object.points : [object.start, object.end]
  const padding = object.kind === 'arrow' ? Math.max(12, object.style.size * 3) : object.style.size / 2
  const x = Math.min(...points.map((point) => point.x)) - padding, y = Math.min(...points.map((point) => point.y)) - padding
  return { x, y, width: Math.max(...points.map((point) => point.x)) - x + padding, height: Math.max(...points.map((point) => point.y)) - y + padding }
}
function segmentDistance(point: AnnotationPoint, start: AnnotationPoint, end: AnnotationPoint): number {
  const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy
  const t = length ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1) : 0
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy)
}
export function hitAnnotation(document: AnnotationDocument, point: AnnotationPoint, tolerance = 5): AnnotationObject | null {
  for (const object of [...document.objects].reverse()) {
    if (object.erasures.some((erase) => erase.points.some((end, index) => segmentDistance(point, erase.points[Math.max(0, index - 1)], end) <= erase.size / 2))) continue
    if ('points' in object) {
      if (object.points.some((end, index) => segmentDistance(point, object.points[Math.max(0, index - 1)], end) <= object.style.size / 2 + tolerance)) return object
    } else {
      const bounds = annotationBounds(object)
      if (point.x >= bounds.x - tolerance && point.y >= bounds.y - tolerance && point.x <= bounds.x + bounds.width + tolerance && point.y <= bounds.y + bounds.height + tolerance) return object
    }
  }
  return null
}
export function moveAnnotation(object: AnnotationObject, delta: AnnotationPoint, document: { width: number; height: number }): AnnotationObject {
  const box = annotationBounds(object)
  const dx = clamp(delta.x, -Math.max(0, box.x), Math.max(0, document.width - box.x - box.width)), dy = clamp(delta.y, -Math.max(0, box.y), Math.max(0, document.height - box.y - box.height))
  function shift(point: AnnotationPoint) { return { x: point.x + dx, y: point.y + dy } }
  const erasures = object.erasures.map((erase) => ({ ...erase, points: erase.points.map(shift) }))
  if ('x' in object) return { ...object, x: object.x + dx, y: object.y + dy, erasures }
  if ('points' in object) return { ...object, points: object.points.map(shift), erasures }
  return { ...object, start: shift(object.start), end: shift(object.end), erasures }
}
export function eraseAnnotations(document: AnnotationDocument, erase: AnnotationErase): AnnotationDocument {
  if (!erase.points.length) return document
  // Store erasures with the objects they affect: new marks remain drawable over an erased region.
  const ex = Math.min(...erase.points.map((point) => point.x)) - erase.size / 2, ey = Math.min(...erase.points.map((point) => point.y)) - erase.size / 2
  const right = Math.max(...erase.points.map((point) => point.x)) + erase.size / 2, bottom = Math.max(...erase.points.map((point) => point.y)) + erase.size / 2
  return { ...document, objects: document.objects.map((object) => {
    const box = annotationBounds(object)
    return box.x <= right && box.y <= bottom && box.x + box.width >= ex && box.y + box.height >= ey ? { ...object, erasures: [...object.erasures, erase] } : object
  }) }
}
export function createAnnotationMark(id: string, tool: Exclude<AnnotationTool, 'select' | 'eraser' | 'text' | 'label'>, points: AnnotationPoint[], style: AnnotationStyle): AnnotationObject | null {
  if (!points.length) return null
  if (tool === 'brush' || tool === 'line') return { id, kind: tool, points: tool === 'line' ? [points[0], points.at(-1)!] : points, style: { ...style }, erasures: [] }
  const start = points[0], end = points.at(-1)!
  if (tool === 'arrow' ? Math.hypot(end.x - start.x, end.y - start.y) < 2 : Math.abs(end.x - start.x) < 1 || Math.abs(end.y - start.y) < 1) return null
  return { id, kind: tool, start, end, style: { ...style }, erasures: [] }
}
export function measureAnnotationText(text: string, fontSize: number): number { return Array.from(text).reduce((width, char) => width + (/^[\x00-\x7f]$/.test(char) ? .64 : 1) * fontSize, 0) }
export function createAnnotationText(id: string, kind: 'label' | 'text', point: AnnotationPoint, text: string, style: AnnotationStyle, document: { width: number; height: number }, measure: AnnotationMeasure = measureAnnotationText): AnnotationObject {
  if (!text.trim()) throw new Error('请输入标注文字')
  if (text.length > 1000) throw new Error('每条标注最多输入 1000 个字符')
  const padding = kind === 'label' ? Math.max(4, style.fontSize * .45) : 0
  const maxWidth = document.width - padding * 2
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (measure(char, style.fontSize) > maxWidth) throw new Error('字号过大，请减小字号')
      if (line && measure(line + char, style.fontSize) > maxWidth) { lines.push(line); line = '' }
      line += char
    }
    lines.push(line)
  }
  const width = Math.min(document.width, Math.max(1, ...lines.map((line) => Math.ceil(measure(line, style.fontSize)))) + padding * 2)
  const height = style.fontSize * (1 + (lines.length - 1) * 1.2) + padding * 2 + style.fontSize * .25
  const tail = kind === 'label' ? Math.min(12, style.fontSize * .35) : 0
  if (height + tail > document.height) throw new Error('文字超出图片高度，请减少文字或减小字号')
  return { id, kind, x: clamp(point.x, 0, document.width - width), y: clamp(point.y, 0, document.height - height - tail), width, height, padding, text, lines, style: { ...style }, erasures: [] }
}
function imageLayer(): ImageLayer { return { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true } }
function normalized(point: AnnotationPoint, document: AnnotationDocument, origin = { x: 0, y: 0 }): [number, number] { return [Math.round((point.x - origin.x) / document.width * imageLayerPointScale), Math.round((point.y - origin.y) / document.height * imageLayerPointScale)] }
function eraseOperations(object: AnnotationObject, document: AnnotationDocument, origin = { x: 0, y: 0 }): ImageLayerStroke[] {
  return object.erasures.map((erase) => ({ mode: 'erase', points: erase.points.map((point) => normalized(point, document, origin)), size: erase.size, hardness: 1, opacity: 1, color: '#000000', space: { width: document.width, height: document.height } }))
}
export function annotationBrushPasses(style: AnnotationStyle): Array<{ size: number; hardness: number; color: string; opacity: number }> {
  const basic = { size: style.size, hardness: 1, color: style.color, opacity: style.opacity }
  if (style.brush === 'marker') return [{ ...basic, opacity: style.opacity * .35 }]
  if (style.brush === 'soft') return [{ ...basic, hardness: .15 }]
  if (style.brush === 'neon' || style.brush === 'light') return [{ ...basic, size: Math.min(512, style.size * 2), hardness: .15, opacity: style.opacity * .6 }, { ...basic, size: Math.max(1, style.size * .4), color: style.brush === 'neon' ? '#ffffff' : style.color }]
  return [basic]
}
export function annotationShapePath(object: AnnotationObject, document: AnnotationDocument): ImageLayerPathContent | null {
  let raw: AnnotationPoint[], handles: Array<{ in?: AnnotationPoint; out?: AnnotationPoint }> | undefined
  let fill = 'transparent', stroke = object.style.color, strokeWidth = Math.min(64, object.style.size)
  if ('start' in object && object.kind === 'arrow') {
    const { start: a, end: b } = object, length = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / length, uy = (b.y - a.y) / length
    const half = Math.min(object.style.size / 2, length / 10), head = Math.min(Math.max(12, object.style.size * 3), length * .6), neck = { x: b.x - ux * head, y: b.y - uy * head }
    function offset(point: AnnotationPoint, amount: number) { return { x: clamp(point.x - uy * amount, 0, document.width), y: clamp(point.y + ux * amount, 0, document.height) } }
    raw = [offset(a, half), offset(neck, half), offset(neck, head / 2), b, offset(neck, -head / 2), offset(neck, -half), offset(a, -half)]
    fill = object.style.color; stroke = 'transparent'; strokeWidth = 0
  } else {
    const bounds = 'x' in object ? { x: object.x, y: object.y, width: object.width, height: object.height } : 'start' in object ? { x: Math.min(object.start.x, object.end.x), y: Math.min(object.start.y, object.end.y), width: Math.abs(object.start.x - object.end.x), height: Math.abs(object.start.y - object.end.y) } : null
    if (!bounds) return null
    const { x, y, width: w, height: h } = bounds
    if (object.kind === 'ellipse') {
      const k = .552284749831, rx = w / 2, ry = h / 2
      raw = [{ x: x + rx, y }, { x: x + w, y: y + ry }, { x: x + rx, y: y + h }, { x, y: y + ry }]
      handles = [{ in: { x: x + rx - rx * k, y }, out: { x: x + rx + rx * k, y } }, { in: { x: x + w, y: y + ry - ry * k }, out: { x: x + w, y: y + ry + ry * k } }, { in: { x: x + rx + rx * k, y: y + h }, out: { x: x + rx - rx * k, y: y + h } }, { in: { x, y: y + ry + ry * k }, out: { x, y: y + ry - ry * k } }]
    } else {
      const r = object.kind === 'label' ? Math.min(object.style.radius, w / 4, h / 2) : 0
      if (!r) raw = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
      else {
        const k = .552284749831 * r
        raw = [{ x: x + r, y }, { x: x + w - r, y }, { x: x + w, y: y + r }, { x: x + w, y: y + h - r }, { x: x + w - r, y: y + h }, { x: x + r, y: y + h }, { x, y: y + h - r }, { x, y: y + r }]
        handles = [{ in: { x: x + r - k, y } }, { out: { x: x + w - r + k, y } }, { in: { x: x + w, y: y + r - k } }, { out: { x: x + w, y: y + h - r + k } }, { in: { x: x + w - r + k, y: y + h } }, { out: { x: x + r - k, y: y + h } }, { in: { x, y: y + h - r + k } }, { out: { x, y: y + r - k } }]
      }
      if (object.kind === 'label') {
        // A small left-hand pointer is part of the same filled outline.
        const tail = Math.min(12, object.style.fontSize * .35, w * .15), left = Math.max(r, w * .2)
        const insertion = r ? 5 : 3
        raw.splice(insertion, 0, { x: x + left + tail, y: y + h }, { x: x + left, y: y + h + tail }, { x: x + left, y: y + h })
        if (handles) handles.splice(insertion, 0, {}, {}, {})
        fill = object.style.background; stroke = 'transparent'; strokeWidth = 0
      }
    }
  }
  let points = raw.map((point) => normalized(point, document))
  if (object.kind === 'arrow') {
    // Clipping an arrowhead against an image edge can collapse adjacent vertices.
    // Normalize first so fixed-point rounding cannot reintroduce duplicates.
    points = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1])
    if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop()
  }
  return { kind: 'path', points, ...(handles ? { handles: handles.map((handle) => ({ ...(handle.in ? { in: normalized(handle.in, document) } : {}), ...(handle.out ? { out: normalized(handle.out, document) } : {}) })) } : {}), fill, stroke, strokeWidth, space: { width: document.width, height: document.height } }
}
export function annotationSvgPath(path: ImageLayerPathContent, document: { width: number; height: number }): string {
  function xy(point: [number, number]) { return `${point[0] / imageLayerPointScale * document.width} ${point[1] / imageLayerPointScale * document.height}` }
  return `M ${xy(path.points[0])} ${path.points.map((point, index) => { const next = (index + 1) % path.points.length, out = path.handles?.[index]?.out, incoming = path.handles?.[next]?.in; return out || incoming ? `C ${xy(out ?? point)} ${xy(incoming ?? path.points[next])} ${xy(path.points[next])}` : `L ${xy(path.points[next])}` }).join(' ')} Z`
}
export function buildAnnotationRecipe(document: AnnotationDocument): ImageLayerRecipe {
  const layers: ImageLayer[] = [{ ...imageLayer(), name: '原图', locked: true }]
  for (const object of document.objects) {
    if ('points' in object) {
      const passes = object.kind === 'line' ? annotationBrushPasses({ ...object.style, brush: 'round' }) : annotationBrushPasses(object.style)
      const operations: ImageLayerStroke[] = passes.map((pass) => ({ mode: 'paint', points: object.points.map((point) => normalized(point, document)), ...pass, space: { width: document.width, height: document.height } }))
      const previous = layers.at(-1)!
      if (!object.erasures.length && previous.content?.kind === 'paint' && previous.edits?.operations.every((operation) => operation.mode === 'paint')) previous.edits.operations.push(...operations)
      else layers.push({ ...imageLayer(), name: '笔迹', content: { kind: 'paint' }, edits: { version: 1, operations: [...operations, ...eraseOperations(object, document)] } })
    } else {
      if (object.kind !== 'text') {
        const path = annotationShapePath(object, document)
        if (path) layers.push({ ...imageLayer(), name: object.kind === 'label' ? '标签背景' : '形状', opacity: object.style.opacity * (object.kind === 'label' ? object.style.backgroundOpacity : 1), content: path, ...(object.erasures.length ? { edits: { version: 1, operations: eraseOperations(object, document) } } : {}) })
      }
      if ('x' in object) {
        const origin = { x: object.x + object.padding, y: object.y + object.padding }
        layers.push({ ...imageLayer(), x: origin.x / document.width, y: origin.y / document.height, opacity: object.style.opacity, name: '标注文字', content: { kind: 'text', text: object.lines.join('\n'), color: object.style.color, fontSize: object.style.fontSize, fontFamily: 'sans-serif', fontWeight: 700, align: 'left' }, ...(object.erasures.length ? { edits: { version: 1, operations: eraseOperations(object, document, origin) } } : {}) })
      }
    }
  }
  const parsed = parseImageTransformRecipe({ kind: 'layer', outputWidth: document.width, outputHeight: document.height, background: 'transparent', explicitLayers: true, layers })
  if (parsed.kind !== 'layer') throw new Error('标注配方无效')
  return parsed
}
export function replaceAnnotationObject(document: AnnotationDocument, object: AnnotationObject): AnnotationDocument {
  const index = document.objects.findIndex((current) => current.id === object.id)
  if (index < 0) return { ...document, objects: [...document.objects, object] }
  return { ...document, objects: document.objects.map((current, position) => position === index ? object : current) }
}
export function annotationFixtureRecipe(): ImageLayerRecipe {
  const document: AnnotationDocument = { width: 640, height: 480, objects: [] }
  document.objects.push(createAnnotationMark('brush', 'brush', [{ x: 20, y: 40 }, { x: 70, y: 80 }, { x: 120, y: 40 }], defaultAnnotationStyle)!)
  document.objects.push(createAnnotationMark('arrow', 'arrow', [{ x: 50, y: 240 }, { x: 250, y: 120 }], { ...defaultAnnotationStyle, color: '#ff6677', size: 6 })!)
  document.objects.push(createAnnotationMark('frame', 'rectangle', [{ x: 300, y: 180 }, { x: 550, y: 360 }], { ...defaultAnnotationStyle, size: 4 })!)
  document.objects.push(createAnnotationText('label', 'label', { x: 220, y: 40 }, '产品细节\n哑光质感', defaultAnnotationStyle, document))
  document.objects.push(createAnnotationText('text', 'text', { x: 80, y: 380 }, 'Design / 星芒', { ...defaultAnnotationStyle, color: '#ffffff' }, document))
  return buildAnnotationRecipe(document)
}
