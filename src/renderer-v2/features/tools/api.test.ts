import { describe, expect, it, vi } from 'vitest'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { createToolsApi } from './api'

describe('home balance usage queries', () => {
  it.each(['solov', 'solov-api'] as const)('keeps the %s date contract when loading month/week usage', async (siteId) => {
    const getAccountUsage = vi.fn(async () => ({ stats: { quota: 3 } }))
    const bridge = { getAccountSession: async () => ({ siteId }), getAccountUsage } as unknown as XingmangApi
    expect(await createToolsApi(bridge).balanceUsage()).toEqual({ monthQuota: 3, weekQuota: 3 })
    expect(getAccountUsage).toHaveBeenCalledTimes(2)
    for (const call of getAccountUsage.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      const query = call[0]
      if (siteId === 'solov-api') {
        expect(query.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(query.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(query.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
        expect(query).not.toHaveProperty('type')
        expect(query).not.toHaveProperty('startTimestamp')
      } else {
        expect(query.type).toBe(2)
        expect(query.startTimestamp).toEqual(expect.any(Number))
        expect(query.endTimestamp).toEqual(expect.any(Number))
        expect(query).not.toHaveProperty('startDate')
      }
    }
  })
})

describe('CLI install version passthrough', () => {
  it('lets the main process decide the version unless the caller names one', async () => {
    const installCli = vi.fn(async () => undefined)
    const installCodexDesktop = vi.fn(async () => undefined)
    const api = createToolsApi({ installCli, installCodexDesktop } as unknown as XingmangApi)

    await api.install('claude')
    expect(installCli).toHaveBeenCalledWith('claude', undefined)

    await api.install('claude', '2.1.277')
    expect(installCli).toHaveBeenLastCalledWith('claude', '2.1.277')

    await api.install('codexDesktop', '2.1.277')
    expect(installCodexDesktop).toHaveBeenCalledWith()
  })
})
