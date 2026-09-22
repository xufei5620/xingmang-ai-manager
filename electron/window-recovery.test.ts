import { describe, expect, it, vi } from 'vitest'
import type { WindowBounds } from './window-preferences'
import { recoverOffscreenWindow, type DisplayScreen, type RecoverableWindow } from './window-recovery'

const laptop = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }

function fakeScreen(displays = [laptop], primaryId = 1): DisplayScreen {
  return {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => ({ id: primaryId }),
  }
}

function fakeWindow(options: {
  bounds: WindowBounds
  normal?: WindowBounds
  maximized?: boolean
  minimized?: boolean
  fullScreen?: boolean
  destroyed?: boolean
}) {
  const calls: string[] = []
  let bounds = options.bounds
  let maximized = options.maximized ?? false
  const window: RecoverableWindow = {
    isDestroyed: () => options.destroyed ?? false,
    isFullScreen: () => options.fullScreen ?? false,
    isMinimized: () => options.minimized ?? false,
    isMaximized: () => maximized,
    getBounds: () => bounds,
    getNormalBounds: () => options.normal ?? bounds,
    setBounds: vi.fn((next: Partial<WindowBounds>) => {
      calls.push('setBounds')
      bounds = { ...bounds, ...next }
    }),
    unmaximize: vi.fn(() => {
      calls.push('unmaximize')
      maximized = false
    }),
    maximize: vi.fn(() => {
      calls.push('maximize')
      maximized = true
    }),
  }
  return { window, calls, bounds: () => bounds }
}

describe('recoverOffscreenWindow', () => {
  it('moves a window stranded on an unplugged monitor back to the primary display', () => {
    const stranded = fakeWindow({ bounds: { x: 2200, y: 100, width: 1280, height: 820 } })
    expect(recoverOffscreenWindow(stranded.window, fakeScreen())).toEqual({ x: 320, y: 110, width: 1280, height: 820 })
    expect(stranded.bounds()).toEqual({ x: 320, y: 110, width: 1280, height: 820 })
    expect(stranded.calls).toEqual(['setBounds'])
  })

  it('restores, moves and re-maximizes a maximized window so it fills the primary display', () => {
    const stranded = fakeWindow({
      bounds: { x: 1920, y: 0, width: 2560, height: 1400 },
      normal: { x: 2100, y: 100, width: 1200, height: 800 },
      maximized: true,
    })
    expect(recoverOffscreenWindow(stranded.window, fakeScreen())).toEqual({ x: 360, y: 120, width: 1200, height: 800 })
    expect(stranded.calls).toEqual(['unmaximize', 'setBounds', 'maximize'])
  })

  it('leaves visible, full-screen, minimized and destroyed windows alone', () => {
    const offscreen = { x: 2200, y: 100, width: 1280, height: 820 }
    for (const candidate of [
      fakeWindow({ bounds: { x: 100, y: 100, width: 1280, height: 820 } }),
      fakeWindow({ bounds: offscreen, fullScreen: true }),
      fakeWindow({ bounds: offscreen, minimized: true }),
      fakeWindow({ bounds: offscreen, destroyed: true }),
    ]) {
      expect(recoverOffscreenWindow(candidate.window, fakeScreen())).toBeNull()
      expect(candidate.calls).toEqual([])
    }
  })
})
