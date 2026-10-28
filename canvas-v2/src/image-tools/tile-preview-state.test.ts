import { describe, expect, it, vi } from 'vitest'
import { createTileViewportInteraction, initialTileViewport, tileEditorInputScope, tilePreviewDimensions } from './tile-preview-state'
import type { UpstreamMediaReference } from '../components/upstream-references'

describe('tile preview viewing state', () => {
  it('pans at fit scale without an image edge clamp and rolls back cancelled gestures', () => {
    const notify = vi.fn(), view = createTileViewportInteraction(notify); view.sync('a', true)
    expect(view.start(1, 0, 0)).toBe(true); view.move(1, 1800, -900)
    expect(view.read()).toEqual({ scale: 1, x: 1800, y: -900 }); view.cancel(1); expect(view.read()).toEqual(initialTileViewport)
    view.start(2, 0, 0); view.move(2, 80, 40); view.finish(2); view.cancel(2); expect(view.read()).toEqual({ scale: 1, x: 80, y: 40 })
    expect(notify).toHaveBeenCalled()
  })
  it('keeps the hovered texture point stationary while zooming and bounds finite scales', () => {
    const view = createTileViewportInteraction(vi.fn()); view.sync('a', true)
    view.zoom(2, { x: 100, y: 80 }); expect(view.read()).toEqual({ scale: 2, x: -100, y: -80 })
    expect((100 - view.read().x) / view.read().scale).toBe(100)
    view.zoom(100); expect(view.read().scale).toBe(8); view.zoom(0); expect(view.read().scale).toBe(.1)
    const before = view.read(); expect(view.wheel(NaN, { x: 0, y: 0 })).toBe(false); expect(view.read()).toEqual(before)
    view.reset(); expect(view.read()).toEqual(initialTileViewport)
  })
  it('resets on source changes and ignores superseded pointer events without document writes', () => {
    const view = createTileViewportInteraction(vi.fn()); view.sync('a', true); view.start(1, 0, 0); view.move(1, 100, 100)
    view.sync('b', true); view.move(1, 200, 200); expect(view.read()).toEqual(initialTileViewport)
    view.key('ArrowRight'); expect(view.read().x).toBe(-32); view.key('+'); expect(view.read().scale).toBe(1.25)
    view.sync('b', false); expect(view.key('ArrowLeft')).toBe(false); expect(view.start(3, 0, 0)).toBe(false)
    view.sync('b', true); view.key('Home'); expect(view.read()).toEqual(initialTileViewport)
  })
  it('preserves the original aspect and invalidates editing only for input identity or state', () => {
    expect(tilePreviewDimensions(480, 640)).toEqual({ width: 240, height: 320 })
    expect(tilePreviewDimensions(0, 0)).toEqual({ width: 256, height: 256 })
    const reference: UpstreamMediaReference = { edgeId: 'one', sourceNodeId: 'source', outputIndex: 0, kind: 'image', relationLabel: '图像输入', label: '图片', mention: '', status: 'waiting' }
    const scope = tileEditorInputScope([reference], undefined)
    expect(tileEditorInputScope([{ ...reference, label: '改名' }], undefined)).toBe(scope)
    expect(tileEditorInputScope([{ ...reference, outputIndex: 1 }], undefined)).not.toBe(scope)
    expect(tileEditorInputScope([{ ...reference, status: 'ready', asset: { kind: 'image', assetId: 'changed' } }], undefined)).not.toBe(scope)
  })
})
