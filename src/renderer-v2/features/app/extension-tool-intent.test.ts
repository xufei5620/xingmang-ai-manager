import { describe, expect, it, vi } from 'vitest'
import { requestExtensionTool, subscribeExtensionTool, takeExtensionTool } from './extension-tool-intent'

describe('extension tool intent', () => {
  it('hands the requested tool to that page once and leaves other pages alone', () => {
    requestExtensionTool('plugins', 'codex')
    expect(takeExtensionTool('skills')).toBeNull()
    expect(takeExtensionTool('plugins')).toBe('codex')
    expect(takeExtensionTool('plugins')).toBeNull()
  })

  it('tells a page that is already mounted until it unsubscribes', () => {
    const listener = vi.fn()
    const stop = subscribeExtensionTool(listener)
    requestExtensionTool('plugins', 'codex')
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    requestExtensionTool('plugins', 'grok')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(takeExtensionTool('plugins')).toBe('grok')
  })
})
