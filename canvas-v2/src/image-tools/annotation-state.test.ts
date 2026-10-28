import { describe, expect, it } from 'vitest'
import { annotationBounds, annotationBrushPasses, annotationColor, annotationFixtureRecipe, annotationPoint, annotationShapePath, buildAnnotationRecipe, commitAnnotation, createAnnotationHistory, createAnnotationMark, createAnnotationText, defaultAnnotationStyle as style, eraseAnnotations, hitAnnotation, moveAnnotation, redoAnnotation, replaceAnnotationObject, undoAnnotation, type AnnotationDocument } from './annotation-state'
import { parseImageTransformRecipe } from './recipe'

function document(): AnnotationDocument { return { width: 640, height: 480, objects: [] } }
function line() { return createAnnotationMark('a', 'brush', [{ x: 10, y: 20 }, { x: 100, y: 80 }], style)! }

describe('annotation object geometry and export', () => {
  it('maps CSS-scaled pointer coordinates to bounded original pixels', () => {
    const rect = { left: 20, top: 30, width: 200, height: 100 }
    expect(annotationPoint({ x: 120, y: 80 }, rect, { width: 4096, height: 2048 })).toEqual({ x: 2048, y: 1024 })
    expect(annotationPoint({ x: -10, y: 200 }, rect, document())).toEqual({ x: 0, y: 480 })
    expect(annotationPoint({ x: 1, y: 2 }, { ...rect, width: 0 }, document())).toBeNull()
    expect(annotationPoint({ x: Infinity, y: 2 }, rect, document())).toBeNull()
  })
  it('validates colors and outputs only existing normalized recipe fields', () => {
    expect(annotationColor('#AaBbCc')).toBe('#aabbcc'); expect(annotationColor('red')).toBeNull(); expect(annotationColor('#fff')).toBeNull()
    const recipe = annotationFixtureRecipe()
    expect(parseImageTransformRecipe(recipe)).toEqual(recipe)
    expect(recipe.layers[0]).toEqual({ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, name: '原图', locked: true })
    expect(recipe.layers.slice(1).every((layer) => layer.sourceIndex === 0 && layer.content)).toBe(true)
    expect(recipe.outputWidth).toBe(640); expect(recipe.explicitLayers).toBe(true)
  })
  it('creates curved ellipse and rounded speech label including a left-hand pointer inside the image', () => {
    const d = document(), ellipse = createAnnotationMark('e', 'ellipse', [{ x: 40, y: 30 }, { x: 240, y: 130 }], style)!
    const path = annotationShapePath(ellipse, d)!
    expect(path.points).toHaveLength(4); expect(path.handles).toHaveLength(4)
    const label = createAnnotationText('l', 'label', { x: 620, y: 470 }, '细节', style, d)
    const bounds = annotationBounds(label), labelPath = annotationShapePath(label, d)!
    expect(labelPath.points).toHaveLength(11); expect(labelPath.handles).toHaveLength(11)
    expect(labelPath.points[6][1]).toBeGreaterThan(labelPath.points[5][1])
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(d.height)
    expect(() => buildAnnotationRecipe({ ...d, objects: [ellipse, label] })).not.toThrow()
  })
  it('exports clipped arrows along all image edges without duplicate fixed-point vertices', () => {
    const d = document()
    for (const points of [
      [{ x: 0, y: 0 }, { x: 300, y: 0 }], [{ x: 300, y: 0 }, { x: 0, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: 300 }], [{ x: 0, y: 300 }, { x: 0, y: 0 }],
      [{ x: 340, y: 480 }, { x: 640, y: 480 }], [{ x: 640, y: 480 }, { x: 340, y: 480 }],
      [{ x: 640, y: 180 }, { x: 640, y: 480 }], [{ x: 640, y: 480 }, { x: 640, y: 180 }],
    ]) {
      const arrow = createAnnotationMark('arrow', 'arrow', points, style)!
      const recipe = buildAnnotationRecipe({ ...d, objects: [arrow] })
      expect(recipe.layers).toHaveLength(2)
      const path = annotationShapePath(arrow, d)!
      expect(path.points.length).toBeGreaterThanOrEqual(3)
      expect(path.points.every((point, index) => point[0] !== path.points[(index + 1) % path.points.length][0] || point[1] !== path.points[(index + 1) % path.points.length][1])).toBe(true)
    }
  })

  it('wraps text using measured glyph widths without silently dropping lines', () => {
    const d = { ...document(), width: 100 }, measure = (value: string) => Array.from(value).length * 20
    const text = createAnnotationText('t', 'text', { x: 90, y: 470 }, '一二三四五六\nHello', { ...style, fontSize: 20 }, d, measure)
    expect('lines' in text && text.lines).toEqual(['一二三四五', '六', 'Hello'])
    expect('x' in text && text.x).toBe(0)
    expect(() => createAnnotationText('t', 'text', { x: 0, y: 0 }, 'a\n'.repeat(100), style, d)).toThrow('高度')
    expect(() => createAnnotationText('t', 'text', { x: 0, y: 0 }, '', style, d)).toThrow('文字')
    expect(() => createAnnotationText('t', 'text', { x: 0, y: 0 }, 'a'.repeat(1001), style, d)).toThrow('1000')
  })
  it('updates a label in place, moves its entire group and keeps original objects immutable', () => {
    const d = document(), label = createAnnotationText('l', 'label', { x: 30, y: 40 }, 'Before', style, d)
    const initial = replaceAnnotationObject(d, label), updated = createAnnotationText('l', 'label', { x: 30, y: 40 }, 'After', { ...style, color: '#ff0000' }, d)
    const next = replaceAnnotationObject(initial, updated)
    expect(next.objects).toHaveLength(1); expect('text' in initial.objects[0] && initial.objects[0].text).toBe('Before')
    const moved = moveAnnotation(next.objects[0], { x: 1000, y: 1000 }, d), box = annotationBounds(moved)
    expect(box.x + box.width).toBeCloseTo(d.width); expect(box.y + box.height).toBeCloseTo(d.height)
    expect(hitAnnotation({ ...d, objects: [moved] }, { x: box.x + 4, y: box.y + 4 })?.id).toBe('l')
    expect(buildAnnotationRecipe({ ...d, objects: [moved] }).layers).toHaveLength(3)
  })
  it('keeps shape and arrow geometry inside image coordinates after dragging', () => {
    const d = document()
    for (const kind of ['rectangle', 'ellipse', 'arrow'] as const) {
      const object = createAnnotationMark(kind, kind, [{ x: 100, y: 100 }, { x: 200, y: 180 }], style)!
      const moved = moveAnnotation(object, { x: 50, y: 40 }, d)
      expect('start' in moved && moved.start).toEqual({ x: 150, y: 140 })
      expect('end' in moved && moved.end).toEqual({ x: 250, y: 220 })
      const recipe = buildAnnotationRecipe({ ...d, objects: [moved] })
      expect(recipe.layers).toHaveLength(2)
      expect(recipe.layers[1].content?.kind).toBe('path')
    }
  })

  it('erases annotations only and carries local erasures when their object moves', () => {
    const d = { ...document(), objects: [line()] }, erase = { points: [{ x: 50, y: 45 }], size: 20 }
    const erased = eraseAnnotations(d, erase), moved = moveAnnotation(erased.objects[0], { x: 20, y: 30 }, d)
    expect(d.objects[0].erasures).toEqual([]); expect(moved.erasures[0].points).toEqual([{ x: 70, y: 75 }])
    expect(hitAnnotation(erased, erase.points[0])).toBeNull()
    const recipe = buildAnnotationRecipe(erased)
    expect(recipe.layers[0].edits).toBeUndefined(); expect(recipe.layers[1].edits?.operations.map((op) => op.mode)).toEqual(['paint', 'erase'])
    const overpaint = replaceAnnotationObject(erased, { ...line(), id: 'later' })
    expect(buildAnnotationRecipe(overpaint).layers).toHaveLength(3)
    expect(overpaint.objects[1].erasures).toEqual([])
  })
  it('records pointer operations as discrete undo steps and clears redo after a new change', () => {
    let h = createAnnotationHistory(640, 480)
    h = commitAnnotation(h, replaceAnnotationObject(h.present, line()))
    const edited = commitAnnotation(h, eraseAnnotations(h.present, { points: [{ x: 50, y: 45 }], size: 20 }))
    expect(undoAnnotation(edited).present).toEqual(h.present)
    expect(redoAnnotation(undoAnnotation(edited)).present).toEqual(edited.present)
    expect(undoAnnotation(h).present.objects).toEqual([])
    expect(commitAnnotation(undoAnnotation(edited), { ...h.present, objects: [] }).future).toEqual([])
    expect(commitAnnotation(h, h.present)).toBe(h)
  })
  it('merges consecutive unmasked brush marks while retaining selection identity and export order', () => {
    const d = { ...document(), objects: Array.from({ length: 30 }, (_, index) => ({ ...line(), id: `b${index}` })) }
    expect(buildAnnotationRecipe(d).layers).toHaveLength(2); expect(d.objects).toHaveLength(30)
    expect(buildAnnotationRecipe(d).layers[1].edits?.operations).toHaveLength(30)
  })
  it('implements brush presets with bounded existing paint operations', () => {
    expect(annotationBrushPasses({ ...style, brush: 'marker' })[0].opacity).toBe(.35)
    expect(annotationBrushPasses({ ...style, brush: 'soft' })[0].hardness).toBe(.15)
    const neon = annotationBrushPasses({ ...style, brush: 'neon', size: 256 })
    expect(neon.map((pass) => pass.color)).toEqual([style.color, '#ffffff']); expect(neon[0].size).toBe(512)
    for (const brush of ['round', 'marker', 'soft', 'neon', 'light'] as const) expect(() => buildAnnotationRecipe({ ...document(), objects: [{ ...line(), style: { ...style, brush } }] })).not.toThrow()
  })
  it('rejects oversized sources and over-capacity edits without mutating previous history', () => {
    expect(() => createAnnotationHistory(4097, 100)).toThrow('4096')
    const h = createAnnotationHistory(640, 480), mark = { ...line(), points: Array.from({ length: 4097 }, () => ({ x: 40, y: 30 })) }
    expect(() => commitAnnotation(h, { ...h.present, objects: [mark] })).toThrow('4096'); expect(h.present.objects).toEqual([])
  })
})
