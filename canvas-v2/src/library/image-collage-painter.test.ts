import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCollageWatermarkPlan, paintImageCollageCell, paintImageCollageWatermark } from './image-collage-painter'
import type { ImageTransformDraw } from '../image-tools/geometry'

function contextFixture(width = 800, height = 600) {
  const calls: Array<[string, ...unknown[]]> = []
  const context = {
    canvas: { width, height }, font: '', globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '', globalCompositeOperation: 'source-over', shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    save() { calls.push(['save']) }, restore() { calls.push(['restore']) }, beginPath() { calls.push(['beginPath']) }, closePath() { calls.push(['closePath']) }, clip() { calls.push(['clip']) },
    rect(...args: number[]) { calls.push(['rect', ...args]) }, moveTo(...args: number[]) { calls.push(['moveTo', ...args]) }, lineTo(...args: number[]) { calls.push(['lineTo', ...args]) }, bezierCurveTo(...args: number[]) { calls.push(['bezierCurveTo', ...args]) },
    translate(...args: number[]) { calls.push(['translate', ...args]) }, scale(...args: number[]) { calls.push(['scale', ...args]) }, rotate(...args: number[]) { calls.push(['rotate', ...args]) },
    measureText(text: string) { return { width: text.length * 16 } }, fillText(...args: unknown[]) { calls.push(['fillText', ...args, context.globalAlpha, context.fillStyle]) },
    fill() { calls.push(['fill', context.globalCompositeOperation, context.shadowBlur, context.shadowOffsetY]); calls.push(['fillColor', context.fillStyle]) }, stroke() { calls.push(['stroke', context.lineWidth, context.strokeStyle]) }, drawImage(...args: unknown[]) { calls.push(['drawImage', ...args]) },
  }
  return { context: context as unknown as CanvasRenderingContext2D, calls, raw: context }
}
function draw(): ImageTransformDraw {
  return { sourceIndex: 0, source: { x: 0, y: 0, width: 200, height: 100 }, destination: { x: 20, y: 95, width: 200, height: 100 }, rotation: 0, flipX: false, flipY: false, opacity: 1, blend: 'source-over', collageCell: { rect: { x: 20, y: 20, width: 200, height: 250 }, cornerRadius: 24, borderWidth: 8, borderColor: '#abcdef80', shadow: false } }
}
afterEach(() => vi.unstubAllGlobals())

describe('collage shared canvas decoration', () => {
  it('clips the full contain cell before drawing, then draws an entirely inside border', () => {
    const { context, calls } = contextFixture(), image = {} as CanvasImageSource
    paintImageCollageCell(context, image, draw(), { width: 800, height: 600 })
    expect(calls.indexOf(calls.find((call) => call[0] === 'clip')!)).toBeLessThan(calls.findIndex((call) => call[0] === 'drawImage'))
    expect(calls).toContainEqual(['moveTo', 44, 20])
    expect(calls).toContainEqual(['moveTo', 44, 24])
    expect(calls).toContainEqual(['drawImage', image, 0, 0, 200, 100, 20, 95, 200, 100])
    expect(calls).toContainEqual(['stroke', 8, '#abcdef80'])
  })
  it('clips a thick border to the outer radius even when its inset path has square corners', () => {
    const { context, calls } = contextFixture(), command = draw()
    command.collageCell!.cornerRadius = 2
    command.collageCell!.borderWidth = 8
    paintImageCollageCell(context, {} as CanvasImageSource, command, { width: 800, height: 600 })
    expect(calls.filter((call) => call[0] === 'clip')).toHaveLength(2)
    expect(calls.filter((call) => call[0] === 'moveTo' && call[1] === 22 && call[2] === 20)).toHaveLength(2)
    expect(calls).toContainEqual(['rect', 24, 24, 192, 242])
    expect(calls.map((call) => call[0] === 'clip').lastIndexOf(true)).toBeLessThan(calls.findIndex((call) => call[0] === 'stroke'))
  })
  it.each([[1, 1, 64], [20, 20, 64], [100, 20, 10]])('fills the outer rounded cell for a border with no interior opening (%s x %s, %s px)', (width, height, borderWidth) => {
    const { context, calls } = contextFixture(), command = draw()
    command.collageCell = { rect: { x: 20, y: 20, width, height }, cornerRadius: 24, borderWidth, borderColor: '#abcdef80', shadow: false }
    paintImageCollageCell(context, {} as CanvasImageSource, command, { width: 800, height: 600 })
    expect(calls).toContainEqual(['fillColor', '#abcdef80'])
    expect(calls.some((call) => call[0] === 'stroke')).toBe(false)
    const filledPaths = calls.filter((call) => ['moveTo', 'lineTo', 'bezierCurveTo', 'rect'].includes(call[0]))
    expect(filledPaths.every((call) => call.slice(1).every((value) => typeof value === 'number' && Number.isFinite(value)))).toBe(true)
  })
  it('does not add a colored backing to transparent or contained images', () => {
    const { context, calls } = contextFixture(), command = draw()
    command.collageCell!.borderColor = 'transparent'
    paintImageCollageCell(context, {} as CanvasImageSource, command, { width: 800, height: 600 })
    expect(calls.some((call) => call[0] === 'fill' || call[0] === 'stroke')).toBe(false)
  })
  it('uses one bounded shadow scratch, removes the opaque core, and always releases it', () => {
    const { context } = contextFixture(400, 300), scratch = contextFixture()
    const surface = { width: 0, height: 0, getContext: () => scratch.context }
    vi.stubGlobal('document', { createElement: vi.fn(() => surface) })
    const command = draw(); command.collageCell!.shadow = true
    paintImageCollageCell(context, {} as CanvasImageSource, command, { width: 800, height: 600 })
    expect(scratch.calls).toContainEqual(['fill', 'source-over', 4, 1])
    expect(scratch.calls).toContainEqual(['fill', 'destination-out', 0, 0])
    expect(surface.width).toBe(0); expect(surface.height).toBe(0)
    surface.getContext = () => { throw new Error('paint failed') }
    expect(() => paintImageCollageCell(context, {} as CanvasImageSource, command, { width: 800, height: 600 })).toThrow('paint failed')
    expect(surface.width).toBe(0); expect(surface.height).toBe(0)
  })
  it.each([0, 1, 500, 32_000])('caps watermark calls for measured width %s without trimming text', (width) => {
    const watermark = { text: '品牌'.repeat(80), color: '#12345680', opacity: 0.35, fontSize: 10 }
    const plan = buildCollageWatermarkPlan({ width: 4096, height: 4096 }, watermark, width)
    expect(plan.positions.length).toBeLessThanOrEqual(512)
    expect(plan.positions.length).toBeGreaterThan(0)
    expect(plan.positions.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
    const { context, calls } = contextFixture()
    paintImageCollageWatermark(context, { width: 800, height: 600 }, watermark)
    expect(calls).toContainEqual(['translate', 400, 300])
    expect(calls).toContainEqual(['rotate', -Math.PI / 6])
    const text = calls.filter((call) => call[0] === 'fillText')
    expect(text.every((call) => call[1] === watermark.text && call.at(-2) === 0.35 && call.at(-1) === '#12345680')).toBe(true)
  })
  it('does no work for a transparent, empty or zero-opacity watermark', () => {
    const { context, calls } = contextFixture()
    for (const extra of [{ text: '' }, { opacity: 0 }, { color: 'transparent' }]) paintImageCollageWatermark(context, { width: 800, height: 600 }, { text: 'X', color: '#123456', opacity: 1, fontSize: 20, ...extra })
    expect(calls).toEqual([])
  })
})
