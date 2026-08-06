import { describe, expect, it } from 'vitest'
import { createProviderExtensionRequestCoordinator } from './provider-extension-coordinator'

describe('provider extension request coordinator', () => {
  it('rejects a provider response that arrives after the user switches tabs', () => {
    const coordinator = createProviderExtensionRequestCoordinator('codex')
    const codexRequest = coordinator.begin('codex')

    coordinator.select('claude')
    const claudeRequest = coordinator.begin('claude')

    expect(coordinator.accepts('codex', codexRequest, 'codex')).toBe(false)
    expect(coordinator.accepts('claude', claudeRequest, 'claude')).toBe(true)
  })

  it('lets only the newest load or mutation commit for the active provider', () => {
    const coordinator = createProviderExtensionRequestCoordinator('gemini')
    const loadRequest = coordinator.begin('gemini')
    const mutationRequest = coordinator.begin('gemini')

    expect(coordinator.isCurrent('gemini', loadRequest)).toBe(false)
    expect(coordinator.accepts('gemini', mutationRequest, 'gemini')).toBe(true)
    expect(coordinator.accepts('gemini', mutationRequest, 'grok')).toBe(false)
  })

  it('refuses requests for an inactive provider and invalidates on unmount', () => {
    const coordinator = createProviderExtensionRequestCoordinator('codex')
    expect(coordinator.begin('grok')).toBe(-1)
    const request = coordinator.begin('codex')
    coordinator.invalidate()
    expect(coordinator.isCurrent('codex', request)).toBe(false)
  })
})
