import { describe, expect, it, vi } from 'vitest'
import { providerIds, type XingmangApi } from '../../../../electron/ipc-contract'
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

describe('toolbox read partial failures', () => {
  const system = { checkedAt: '2026-09-18T00:00:00.000Z', clis: {}, desktopApps: {}, runtime: {} }
  const platform = { platform: 'windows', codexDesktop: { launch: false } }
  const config = { workspace: 'C:\\work', providers: {} }
  function bridge(overrides: Partial<Record<'scanSystem' | 'getConfig' | 'getPlatformCapabilities', () => Promise<unknown>>>) {
    return {
      scanSystem: async () => system,
      getConfig: async () => config,
      getPlatformCapabilities: async () => platform,
      ...overrides,
    } as unknown as XingmangApi
  }

  it('reports no failures and the real config when every partition resolves', async () => {
    const result = await createToolsApi(bridge({})).read()
    expect(result.failures).toEqual([])
    expect(result.snapshot).toEqual({ system, config, platform })
  })

  it('keeps the tool list when only the CLI configuration fails to read', async () => {
    const result = await createToolsApi(bridge({
      getConfig: async () => { throw new Error('~/.codex/config.toml 解析失败') },
    })).read()

    expect(result.failures).toEqual([{ partition: 'config', message: '~/.codex/config.toml 解析失败' }])
    expect(result.snapshot?.system).toBe(system)
    expect(result.snapshot?.platform).toBe(platform)
    // 占位表覆盖每个 provider，presentTools 才不会在下标访问上炸掉。
    for (const provider of providerIds) {
      expect(result.snapshot?.config.providers[provider]).toMatchObject({ exists: false, hasApiKey: false, model: '' })
    }
  })

  it('gives up the snapshot only when the scan itself fails, and still names the reason', async () => {
    const result = await createToolsApi(bridge({
      scanSystem: async () => { throw new Error('系统检测被拒绝') },
    })).read(true)

    expect(result.snapshot).toBeNull()
    expect(result.failures).toEqual([{ partition: 'system', message: '系统检测被拒绝' }])
  })

  it('collects every rejected partition instead of stopping at the first one', async () => {
    const result = await createToolsApi(bridge({
      scanSystem: async () => { throw new Error('扫描失败') },
      getConfig: async () => { throw new Error('配置失败') },
      getPlatformCapabilities: async () => { throw new Error('平台失败') },
    })).read()

    expect(result.snapshot).toBeNull()
    expect(result.failures.map((failure) => failure.partition)).toEqual(['system', 'config', 'platform'])
  })

  it('redacts the local path out of the reason it puts on screen', async () => {
    const result = await createToolsApi(bridge({
      getConfig: async () => { throw new Error('C:\\Users\\张三\\.codex\\config.toml 解析失败') },
    })).read()

    expect(result.failures[0]?.message).toBe('本地配置文件 解析失败')
    expect(result.failures[0]?.message).not.toContain('张三')
  })

  it('falls back to a readable Chinese reason when a partition rejects without a message', async () => {
    const result = await createToolsApi(bridge({
      getConfig: async () => { throw 'boom' },
    })).read()

    expect(result.failures).toEqual([{ partition: 'config', message: '工具配置没有读到，请重试。' }])
  })
})
