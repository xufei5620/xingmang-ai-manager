import { describe, expect, it, vi } from 'vitest'
import { createPanoramaViewInteraction, initialPanoramaView, normalizePanoramaView, panoramaKeyView, parsePanoramaView, panoramaRenderSize } from './panorama-view-state'

function fixture() {
  const onChange = vi.fn(), onCommit = vi.fn()
  const controller = createPanoramaViewInteraction({ onChange, onCommit })
  controller.sync(initialPanoramaView, 'asset-a', true)
  return { controller, onChange, onCommit }
}

describe('panorama view configuration', () => {
  it('defaults older missing settings and strictly accepts only bounded camera fields', () => {
    expect(parsePanoramaView(undefined)).toEqual(initialPanoramaView)
    expect(parsePanoramaView({ fov: 50 })).toEqual({ yaw: 0, pitch: 0, fov: 50 })
    expect(parsePanoramaView({ yaw: 359.9, pitch: -85, fov: 110 })).toEqual({ yaw: 359.9, pitch: -85, fov: 110 })
  })
  it.each([null, [], '75', { yaw: 360 }, { pitch: 86 }, { fov: 29 }, { fov: Infinity }, { yaw: NaN }, { fov: '75' }, { src: 'https://example.com/' }, { assetId: 'private' }])('rejects malformed, unbounded or identity-bearing settings: %j', (input) => {
    expect(() => parsePanoramaView(input)).toThrow(/全景视角/)
  })
  it('normalizes seam crossings and clamps poles, zoom, and non-finite interaction values', () => {
    expect(normalizePanoramaView({ yaw: -5, pitch: 200, fov: 0 })).toEqual({ yaw: 355, pitch: 85, fov: 30 })
    expect(normalizePanoramaView({ yaw: 725, pitch: -200, fov: 200 })).toEqual({ yaw: 5, pitch: -85, fov: 110 })
    expect(normalizePanoramaView({ yaw: NaN, pitch: Infinity, fov: NaN })).toEqual(initialPanoramaView)
    expect(panoramaKeyView(initialPanoramaView, 'Tab')).toBeNull()
    expect(panoramaKeyView({ yaw: 90, pitch: 12, fov: 40 }, 'Home')).toEqual(initialPanoramaView)
  })
})

describe('panorama view transactions', () => {
  it('commits one drag regardless of movement and controlled prop echoes', () => {
    const f = fixture()
    expect(f.controller.startPointer(1, 100, 100)).toBe(true)
    for (const x of [120, 140, 160]) {
      f.controller.movePointer(1, x, 120)
      f.controller.sync(f.controller.read(), 'asset-a', true)
    }
    expect(f.onChange).toHaveBeenCalledTimes(3)
    expect(f.onCommit).not.toHaveBeenCalled()
    f.controller.finishPointer(1)
    f.controller.cancel(1)
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ yaw: 345, pitch: 5, fov: 75 })
  })
  it('ignores other pointers and restores a cancelled drag without committing', () => {
    const f = fixture()
    f.controller.startPointer(1, 0, 0)
    expect(f.controller.startPointer(2, 100, 100)).toBe(false)
    f.controller.movePointer(2, 300, 300)
    f.controller.cancel(2)
    f.controller.finishPointer(2)
    expect(f.onChange).not.toHaveBeenCalled()
    f.controller.movePointer(1, 100, -100)
    f.controller.cancel(1)
    expect(f.controller.read()).toEqual(initialPanoramaView)
    expect(f.onChange).toHaveBeenLastCalledWith(initialPanoramaView)
    expect(f.onCommit).not.toHaveBeenCalled()
  })
  it.each(['source', 'external-view', 'disabled'])('discards pending work after %s changes without writing old values', (cause) => {
    const f = fixture()
    f.controller.startPointer(1, 0, 0)
    f.controller.movePointer(1, 100, 0)
    const next = { yaw: 80, pitch: 20, fov: 100 }
    f.controller.sync(next, cause === 'source' ? 'asset-b' : 'asset-a', cause !== 'disabled')
    f.controller.movePointer(1, 200, 200)
    f.controller.finishPointer(1)
    f.controller.cancel()
    expect(f.controller.read()).toEqual(next)
    expect(f.onChange).toHaveBeenCalledTimes(1)
    expect(f.onCommit).not.toHaveBeenCalled()
  })
  it('groups repeated keyboard changes and wheel movement into separate commits', () => {
    const f = fixture()
    for (let index = 0; index < 10; index++) f.controller.key('ArrowRight')
    expect(f.onCommit).not.toHaveBeenCalled()
    f.controller.finishKeyboard()
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ yaw: 50, pitch: 0, fov: 75 })
    f.controller.wheel(-100)
    f.controller.wheel(-100)
    f.controller.finishWheel()
    expect(f.onCommit).toHaveBeenLastCalledWith({ yaw: 50, pitch: 0, fov: 67 })
    expect(f.onCommit).toHaveBeenCalledTimes(2)
  })
  it('does not commit clicks or clamped no-op adjustments and supports cancellation', () => {
    const f = fixture()
    f.controller.startPointer(1, 0, 0)
    f.controller.finishPointer(1)
    f.controller.commit(initialPanoramaView)
    expect(f.onCommit).not.toHaveBeenCalled()
    f.controller.key('ArrowUp')
    f.controller.cancel()
    expect(f.controller.read()).toEqual(initialPanoramaView)
    f.controller.commit({ ...initialPanoramaView, fov: 30 })
    f.controller.wheel(-100)
    f.controller.finishWheel()
    expect(f.onCommit).toHaveBeenCalledTimes(1)
  })
})


describe('bounded panorama resolution', () => {
  it('preserves viewport aspect when either high-DPI edge reaches its limit', () => {
    expect(panoramaRenderSize(1130, 403.2, 2)).toEqual({ width: 2048, height: 731 })
    expect(panoramaRenderSize(500, 1000, 2)).toEqual({ width: 512, height: 1024 })
    expect(panoramaRenderSize(320, 180, 2)).toEqual({ width: 640, height: 360 })
  })
})
