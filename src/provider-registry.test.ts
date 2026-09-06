import { describe, expect, it } from 'vitest'
import { dashboardProviderIds, managementProviderIds } from './provider-registry'
import { providerIds } from './types'

function expectExhaustiveCoverage(order: readonly string[]) {
  // A dropped provider (e.g. forgotten in provider-registry.ts's rank tables
  // after a 5th CLI is added to catalog.ts) shrinks `order` below
  // providerIds.length instead of failing silently — this is the test-time
  // half of the T2 guard described in CLAUDE.md, independent of typecheck.
  expect(order).toHaveLength(providerIds.length)
  expect(new Set(order).size).toBe(providerIds.length)
  expect([...order].sort()).toEqual([...providerIds].sort())
}

describe('provider-registry order arrays', () => {
  it('dashboardProviderIds covers every provider exactly once', () => {
    expectExhaustiveCoverage(dashboardProviderIds)
  })

  it('managementProviderIds covers every provider exactly once', () => {
    expectExhaustiveCoverage(managementProviderIds)
  })

  it('keeps the existing overview-page display order unchanged', () => {
    expect(dashboardProviderIds).toEqual(['claude', 'codex', 'gemini', 'grok'])
  })

  it('keeps the existing management-page display order unchanged', () => {
    expect(managementProviderIds).toEqual(['codex', 'claude', 'gemini', 'grok'])
  })
})
