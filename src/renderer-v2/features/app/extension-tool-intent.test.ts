import { describe, expect, it, vi } from 'vitest'
import { requestExtensionsView, subscribeExtensionsView, takeExtensionsView } from './extension-tool-intent'

describe('extensions view intent', () => {
  it('hands the requested view to the plugins page once', () => {
    requestExtensionsView('skills')
    expect(takeExtensionsView()).toBe('skills')
    expect(takeExtensionsView()).toBeNull()
  })

  it('tells a page that is already mounted until it unsubscribes', () => {
    const listener = vi.fn()
    const stop = subscribeExtensionsView(listener)
    requestExtensionsView('plugins')
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    requestExtensionsView('skills')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(takeExtensionsView()).toBe('skills')
  })
})
