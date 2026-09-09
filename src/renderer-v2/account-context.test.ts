import { describe, expect, it } from 'vitest'
import { accountKeyQuota, accountOrigin, accountScope, accountSiteId, visibleAccountTab } from './account-context'

describe('renderer account ownership', () => {
  it('retains Sub2API fractional dollar limits and never rounds a limited key to unlimited', () => {
    expect(accountKeyQuota(0.25, 1, 'solov-api', false)).toBe(0.25)
    expect(accountKeyQuota(0.25, 500_000, 'solov', false)).toBe(125_000)
    expect(accountKeyQuota(0, 1, 'solov-api', true)).toBe(0)
    expect(() => accountKeyQuota(0, 1, 'solov-api', false)).toThrow('大于 0')
    expect(() => accountKeyQuota(0.0000001, 500_000, 'solov', false)).toThrow('范围')
  })
  it('separates the same user id across platforms and retains legacy sessions in NewAPI', () => {
    const account = { userId: 7 } as Parameters<typeof accountScope>[0]['account']
    expect(accountScope({ account })).toBe('xm-account:7')
    expect(accountScope({ siteId: 'solov-api', account })).toBe('api-account:7')
    expect(accountSiteId({ realmId: 'api-account' })).toBe('solov-api')
    expect(accountOrigin({ siteId: 'solov-api' })).toBe('https://api.solov.cc')
  })
  it('hides unsupported Sub2API panels even before a capability is provided', () => {
    const session = { siteId: 'solov-api' as const }
    expect(visibleAccountTab('overview', session)).toBe(true)
    for (const tab of ['dashboard', 'usage', 'tasks', 'recharge', 'orders', 'invite', 'devices']) expect(visibleAccountTab(tab, session)).toBe(false)
    expect(visibleAccountTab('keys', { ...session, capabilities: { supportsKeyManagement: true } as Parameters<typeof visibleAccountTab>[1]['capabilities'] })).toBe(true)
    expect(visibleAccountTab('devices', {})).toBe(true)
  })
})
