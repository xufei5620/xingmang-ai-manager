import { describe, expect, it, vi } from 'vitest'
import { providerIds, type XingmangApi } from '../../../../electron/ipc-contract'
import { createToolsApi, recentSessionsTtlMs, withConfigFailure, withToolboxConfig } from './api'

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

describe('CLI install cancellation routing', () => {
  it('forwards a CLI cancel to the main process', async () => {
    const cancelCliInstall = vi.fn(async () => ({ cancelled: true, reason: null }))
    const api = createToolsApi({ cancelCliInstall } as unknown as XingmangApi)

    await expect(api.cancelInstall('claude')).resolves.toEqual({ cancelled: true, reason: null })
    expect(cancelCliInstall).toHaveBeenCalledWith('claude')
  })

  it('passes the main process refusal through untouched', async () => {
    const refusal = { cancelled: false, reason: '正在把新版本写入工具目录，这一步中断会让工具用不了，请等它结束。' }
    const cancelCliInstall = vi.fn(async () => refusal)
    const api = createToolsApi({ cancelCliInstall } as unknown as XingmangApi)

    await expect(api.cancelInstall('codex')).resolves.toEqual(refusal)
  })

  it('sends a Codex Desktop cancel to its own channel, not the CLI one', async () => {
    const cancelCliInstall = vi.fn(async () => ({ cancelled: true, reason: null }))
    const cancelCodexDesktopInstall = vi.fn(async () => ({ cancelled: true, reason: null }))
    const api = createToolsApi({ cancelCliInstall, cancelCodexDesktopInstall } as unknown as XingmangApi)

    await expect(api.cancelInstall('codexDesktop')).resolves.toEqual({ cancelled: true, reason: null })
    expect(cancelCodexDesktopInstall).toHaveBeenCalledWith()
    expect(cancelCliInstall).not.toHaveBeenCalled()
  })

  it('passes the Codex Desktop refusal through once the MSIX install has begun', async () => {
    const refusal = { cancelled: false, reason: '正在安装 Codex 桌面端，这一步中断会留下装了一半的程序，请等它结束。' }
    const cancelCodexDesktopInstall = vi.fn(async () => refusal)
    const api = createToolsApi({ cancelCodexDesktopInstall } as unknown as XingmangApi)

    await expect(api.cancelInstall('codexDesktop')).resolves.toEqual(refusal)
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

describe('config-only refresh after the account Key is written', () => {
  it('reads just the config and never starts another system scan', async () => {
    const scanSystem = vi.fn(async () => { throw new Error('不该再扫一遍') })
    const getConfig = vi.fn(async () => ({ workspace: '/w', providers: {} }))
    const api = createToolsApi({ scanSystem, getConfig, getPlatformCapabilities: vi.fn() } as unknown as XingmangApi)

    await expect(api.readConfigPartition()).resolves.toEqual({ config: { workspace: '/w', providers: {} }, failure: null })
    expect(getConfig).toHaveBeenCalledTimes(1)
    expect(scanSystem).not.toHaveBeenCalled()
  })

  it('turns a failed config read into a config partition failure instead of throwing', async () => {
    const getConfig = vi.fn(async () => { throw new Error('配置文件读不出来') })
    const api = createToolsApi({ getConfig } as unknown as XingmangApi)

    await expect(api.readConfigPartition()).resolves.toEqual({
      config: null,
      failure: { partition: 'config', message: '配置文件读不出来' },
    })
  })

  it('still forces a full scan when the user presses 重新检测', async () => {
    const scanSystem = vi.fn(async () => ({ clis: {} }))
    const api = createToolsApi({
      scanSystem,
      getConfig: vi.fn(async () => ({ workspace: '', providers: {} })),
      getPlatformCapabilities: vi.fn(async () => ({})),
    } as unknown as XingmangApi)

    await api.read(true)
    expect(scanSystem).toHaveBeenCalledWith(true)
    await api.read()
    expect(scanSystem).toHaveBeenLastCalledWith(false)
  })

  it('swaps in the new config and leaves the freshly scanned system block alone', () => {
    const system = { checkedAt: '2026-09-22T07:00:00.000Z' }
    const snapshot = { system, config: { workspace: '/w', providers: { claude: { hasApiKey: false } } }, platform: { id: 'win32' } }
    const written = { workspace: '/w', providers: { claude: { hasApiKey: true } } }

    const next = withToolboxConfig(snapshot as never, written as never)
    expect(next?.config).toEqual(written)
    expect(next?.system).toBe(system)
    expect(next).not.toBe(snapshot)
    expect(withToolboxConfig(null, written as never)).toBeNull()
  })

  it('keeps at most one config failure and drops it once the read succeeds', () => {
    const system = { partition: 'system' as const, message: '工具检测没有完成，请重试。' }
    const first = { partition: 'config' as const, message: '第一次没读到' }
    const second = { partition: 'config' as const, message: '第二次也没读到' }

    expect(withConfigFailure([system, first], second)).toEqual([system, second])
    expect(withConfigFailure([system, first], null)).toEqual([system])
  })
})

describe('CLI launch mode passthrough', () => {
  it('sends resumeLast down to the main process instead of dropping it', async () => {
    const launchCli = vi.fn(async () => undefined)
    const api = createToolsApi({ launchCli } as unknown as XingmangApi)

    await api.launch('claude', 'C:\\work\\my-app', 'resumeLast')
    expect(launchCli).toHaveBeenCalledWith('claude', 'C:\\work\\my-app', 'resumeLast')
  })

  it('keeps the old two-argument call when no CLI mode is named', async () => {
    const launchCli = vi.fn(async () => undefined)
    const api = createToolsApi({ launchCli } as unknown as XingmangApi)

    await api.launch('codex', 'C:\\work\\my-app')
    expect(launchCli).toHaveBeenCalledWith('codex', 'C:\\work\\my-app')

    // 'open' 是 codexDesktop 那一侧的取值，CLI 这边不认，落回开新对话。
    await api.launch('codex', 'C:\\work\\my-app', 'open')
    expect(launchCli).toHaveBeenLastCalledWith('codex', 'C:\\work\\my-app')
  })

  it('keeps the desktop client on its own two launch modes', async () => {
    const launchCodexDesktop = vi.fn(async () => undefined)
    const api = createToolsApi({ launchCodexDesktop } as unknown as XingmangApi)

    await api.launch('codexDesktop', '', 'restart')
    expect(launchCodexDesktop).toHaveBeenCalledWith('restart')

    // CLI 那一侧的取值落到桌面端就是普通的「打开」，不该把 restart 之外的东西传下去。
    await api.launch('codexDesktop', '', 'resumeLast')
    expect(launchCodexDesktop).toHaveBeenLastCalledWith('open')
  })
})

describe('recent sessions cache', () => {
  function recentBridge() {
    const listProviderSessions = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 60 }))
    const bridge = {
      listProviderSessions,
      installCli: vi.fn(async () => undefined),
      installCodexDesktop: vi.fn(async () => undefined),
      uninstallCli: vi.fn(async () => ({ outcome: 'uninstalled' })),
      uninstallCodexDesktop: vi.fn(async () => ({ outcome: 'uninstalled' })),
      launchCli: vi.fn(async () => undefined),
      launchCodexDesktop: vi.fn(async () => undefined),
    } as unknown as XingmangApi
    return { bridge, listProviderSessions }
  }

  it('keeps asking the main process for the same page it always did', async () => {
    const { bridge, listProviderSessions } = recentBridge()
    await createToolsApi(bridge).recent()
    expect(listProviderSessions).toHaveBeenCalledWith({ page: 1, pageSize: 60 })
  })

  it('reuses the previous result instead of rescanning on every home visit', async () => {
    const { bridge, listProviderSessions } = recentBridge()
    const api = createToolsApi(bridge)
    await api.recent()
    await api.recent()
    await api.recent()
    expect(listProviderSessions).toHaveBeenCalledTimes(1)
  })

  it('rescans once the cache has aged past the ttl', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, listProviderSessions } = recentBridge()
      const api = createToolsApi(bridge)
      await api.recent()
      vi.advanceTimersByTime(recentSessionsTtlMs - 1)
      await api.recent()
      expect(listProviderSessions).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await api.recent()
      expect(listProviderSessions).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the cache when the caller says the world changed', async () => {
    const { bridge, listProviderSessions } = recentBridge()
    const api = createToolsApi(bridge)
    await api.recent()
    api.invalidateRecent()
    await api.recent()
    expect(listProviderSessions).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['install', (api: ReturnType<typeof createToolsApi>) => api.install('claude')],
    ['uninstall', (api: ReturnType<typeof createToolsApi>) => api.uninstall('claude')],
    ['launch', (api: ReturnType<typeof createToolsApi>) => api.launch('claude', 'C:\\work', 'resumeLast')],
    ['codex desktop install', (api: ReturnType<typeof createToolsApi>) => api.install('codexDesktop')],
    ['codex desktop launch', (api: ReturnType<typeof createToolsApi>) => api.launch('codexDesktop', '', 'restart')],
  ])('drops the cache after %s', async (_name, act) => {
    const { bridge, listProviderSessions } = recentBridge()
    const api = createToolsApi(bridge)
    await api.recent()
    await act(api)
    await api.recent()
    expect(listProviderSessions).toHaveBeenCalledTimes(2)
  })
})
