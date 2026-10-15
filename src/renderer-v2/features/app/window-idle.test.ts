import { describe, expect, it } from 'vitest'
import { attachWindowIdleMarker, isWindowIdle } from './window-idle'

function fakeWindow() {
  const events = new EventTarget()
  const state = { hidden: false, focused: true }
  const dataset: DOMStringMap = {}
  const target = {
    get hidden() { return state.hidden },
    hasFocus: () => state.focused,
    documentElement: { dataset },
    addEventListener: (type: 'visibilitychange', listener: () => void) => events.addEventListener(type, listener),
    removeEventListener: (type: 'visibilitychange', listener: () => void) => events.removeEventListener(type, listener),
  }
  const view = {
    addEventListener: (type: 'focus' | 'blur', listener: () => void) => events.addEventListener(type, listener),
    removeEventListener: (type: 'focus' | 'blur', listener: () => void) => events.removeEventListener(type, listener),
  }
  return { events, state, dataset, target, view }
}

describe('window idle marker', () => {
  it('counts a hidden or unfocused window as idle', () => {
    expect(isWindowIdle(false, true)).toBe(false)
    expect(isWindowIdle(false, false)).toBe(true)
    expect(isWindowIdle(true, true)).toBe(true)
  })

  it('marks the root on attach and follows focus and visibility until detached', () => {
    const { events, state, dataset, target, view } = fakeWindow()
    const detach = attachWindowIdleMarker(target, view)
    expect(dataset.windowIdle).toBe('false')
    state.focused = false; events.dispatchEvent(new Event('blur'))
    expect(dataset.windowIdle).toBe('true')
    state.focused = true; events.dispatchEvent(new Event('focus'))
    expect(dataset.windowIdle).toBe('false')
    state.hidden = true; events.dispatchEvent(new Event('visibilitychange'))
    expect(dataset.windowIdle).toBe('true')
    detach()
    state.hidden = false; events.dispatchEvent(new Event('visibilitychange'))
    expect(dataset.windowIdle).toBe('true')
  })
})
