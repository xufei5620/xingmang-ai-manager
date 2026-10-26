import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachPrivacyChangeListener, notifyPrivacyChanged } from './privacy-change-bridge'

let detach: (() => void) | null = null

afterEach(() => {
  detach?.()
  detach = null
})

describe('privacy change bridge', () => {
  it('does nothing while the main process side has not attached', () => {
    expect(() => notifyPrivacyChanged('anonymousUsage', false)).not.toThrow()
  })

  it('hands each saved switch straight to the attached listener', () => {
    const listener = vi.fn()
    detach = attachPrivacyChangeListener(listener)
    notifyPrivacyChanged('anonymousUsage', false)
    notifyPrivacyChanged('anonymousUsage', true)
    expect(listener.mock.calls).toEqual([['anonymousUsage', false], ['anonymousUsage', true]])
  })

  it('lets a listener detach only itself', () => {
    const first = vi.fn()
    const second = vi.fn()
    const detachFirst = attachPrivacyChangeListener(first)
    detach = attachPrivacyChangeListener(second)
    detachFirst()
    notifyPrivacyChanged('anonymousUsage', false)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('anonymousUsage', false)

    detach()
    detach = null
    notifyPrivacyChanged('anonymousUsage', false)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
