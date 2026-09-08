import { describe, expect, it, vi } from 'vitest'
import { createSettingsQueue, diagnosticTarget } from './pages-maintenance'
import {
  buildAccountInviteLink,
  buildSubscriptionPaymentInput,
  paymentTerminalPresentation,
  resetTopupQuoteForMethod,
  validateTopupAmount,
  subscriptionPaymentMethods,
} from './pages-account'
import {
  extensionItemsForView,
  filterExtensionMarkets,
  parseCommandArguments,
  parseEnvironmentVariables,
  readCodexExtensionMetadata,
} from './pages-management'
import { accountTimeRange } from './AccountFilters'
import {
  beginBusinessOperation,
  pendingBusinessOperations,
} from './business-common'
import type { V2Bridge } from './types'

describe('v2 business boundaries', () => {
  it('builds invite links from the active relay site and safely encodes the code', () => {
    expect(buildAccountInviteLink('https://relay.example.test/account', 'A+B 1')).toBe(
      'https://relay.example.test/register?aff=A%2BB+1',
    )
    expect(buildAccountInviteLink('not-a-url', 'code')).toBe('')
    expect(buildAccountInviteLink('https://relay.example.test', '  ')).toBe('')
  })

  it('omits paymentMethod for non-epay subscription checkouts', () => {
    expect(buildSubscriptionPaymentInput(7, { provider: 'epay', type: 'alipay' })).toEqual({
      planId: 7,
      provider: 'epay',
      paymentMethod: 'alipay',
    })
    expect(buildSubscriptionPaymentInput(7, { provider: 'stripe', type: 'stripe' })).toEqual({
      planId: 7,
      provider: 'stripe',
    })
    expect(buildSubscriptionPaymentInput(7, { provider: 'creem', type: 'creem' })).toEqual({
      planId: 7,
      provider: 'creem',
    })
    expect(buildSubscriptionPaymentInput(7, { provider: 'waffo-pancake', type: 'pancake' })).toEqual({
      planId: 7,
      provider: 'waffo-pancake',
    })
    expect(() => buildSubscriptionPaymentInput(7, { provider: 'waffo', type: 'waffo' })).toThrow(
      '暂不支持订阅',
    )
  })

  it('hides subscription checkout providers disabled by server capabilities', () => {
    type Plan = Parameters<typeof subscriptionPaymentMethods>[0]
    type Method = Parameters<typeof subscriptionPaymentMethods>[1][number]
    const plan = {
      stripePriceId: 'stripe-price',
      creemProductId: 'creem-product',
      waffoPancakeProductId: 'waffo-product',
    } as Plan
    const methods = [
      { provider: 'epay', type: 'alipay' },
      { provider: 'stripe', type: 'stripe' },
      { provider: 'creem', type: 'creem' },
      { provider: 'waffo-pancake', type: 'pancake' },
    ] as Method[]

    expect(subscriptionPaymentMethods(plan, methods, {
      onlineTopupEnabled: false,
      stripeTopupEnabled: true,
      creemTopupEnabled: false,
      waffoPancakeTopupEnabled: false,
    }).map((method) => method.provider)).toEqual(['stripe'])
  })

  it('turns payment window terminal events into an actionable non-pending state', () => {
    expect(paymentTerminalPresentation('closed')).toMatchObject({
      tone: 'neutral',
      title: '支付窗口已关闭',
    })
    expect(paymentTerminalPresentation('expired')).toMatchObject({
      tone: 'warn',
      title: '支付已超时',
    })
    expect(paymentTerminalPresentation('failed')).toMatchObject({
      tone: 'bad',
      title: '支付没有完成',
    })
  })

  it('validates recharge amounts against the integer IPC contract and channel minimum', () => {
    expect(validateTopupAmount(10, 5)).toBe(10)
    expect(() => validateTopupAmount(10.5, 5)).toThrow('整数')
    expect(() => validateTopupAmount(4, 5)).toThrow('不能低于')
    expect(() => validateTopupAmount(10, Number.NaN)).toThrow('最低充值金额无效')
  })

  it('invalidates a quote and raises the amount when the payment channel changes', () => {
    expect(resetTopupQuoteForMethod('10', { minTopup: 5 }, 1)).toEqual({
      amount: '10',
      quoteInvalidated: true,
    })
    expect(resetTopupQuoteForMethod('2', { minTopup: 5 }, 1)).toEqual({
      amount: '5',
      quoteInvalidated: true,
    })
  })

  it('keeps available plugin catalog entries out of the installed view', () => {
    type Item = Parameters<typeof extensionItemsForView>[0][number]
    const item = (id: string, kind: Item['kind'], installed: boolean) =>
      ({ id, kind, installed } as Item)

    const items = [
      item('installed', 'plugin', true),
      item('available', 'plugin', false),
      item('mcp', 'mcp', true),
    ]

    expect(
      extensionItemsForView(items, 'plugin', 'installed').map((entry) => entry.id),
    ).toEqual(['installed'])
    expect(
      extensionItemsForView(items, 'plugin', 'market').map((entry) => entry.id),
    ).toEqual(['installed', 'available'])
    expect(extensionItemsForView(items, 'mcp', 'installed').map((entry) => entry.id))
      .toEqual(['mcp'])
  })

  it('filters plugin markets by both display name and root path', () => {
    const markets = [
      { name: 'Official', root: 'C:\\markets\\official' },
      { name: 'Team Tools', root: 'D:\\shared\\plugins' },
    ]
    expect(filterExtensionMarkets(markets, 'official').map((entry) => entry.name))
      .toEqual(['Official'])
    expect(filterExtensionMarkets(markets, 'shared').map((entry) => entry.name))
      .toEqual(['Team Tools'])
    expect(filterExtensionMarkets(markets, 'missing')).toEqual([])
  })

  it('keeps the provider snapshot usable when a legacy Codex detail read fails', async () => {
    const metadata = await readCodexExtensionMetadata({
      listMcpServers: vi.fn().mockRejectedValue(new Error('legacy MCP unavailable')),
      listSkills: vi.fn().mockResolvedValue([
        { id: 'skill', name: 'Skill', description: '', path: 'C:\\skill', scope: 'user', source: 'agents', enabled: true, managed: true },
      ]),
      listPlugins: vi.fn().mockResolvedValue({ plugins: [], marketplaces: [] }),
    })

    expect(metadata.mcp).toEqual([])
    expect(metadata.skills).toHaveLength(1)
    expect(metadata.plugins.marketplaces).toEqual([])
  })

  it('serializes settings writes, continues after failure, and only publishes persisted values', async () => {
    const events: string[] = []
    const base: Awaited<ReturnType<V2Bridge['getSettings']>> = {
      version: 2,
      workspace: '',
      theme: 'light',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
    }
    let release: () => void = () => undefined
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const save = vi
      .fn<V2Bridge['saveSettings']>()
      .mockImplementationOnce(async () => {
        events.push('first')
        await first
        throw new Error('disk failed')
      })
      .mockImplementationOnce(async () => {
        events.push('second')
        return { ...base, reducedMotion: true }
      })
    const published = vi.fn()
    const writer = createSettingsQueue(save, published)
    const one = writer({ version: 2, theme: 'dark' })
    const two = writer({ version: 2, reducedMotion: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['first'])
    release()
    await expect(one).rejects.toThrow('disk failed')
    await expect(two).resolves.toMatchObject({
      theme: 'light',
      reducedMotion: true,
    })
    expect(events).toEqual(['first', 'second'])
    expect(published).toHaveBeenCalledTimes(1)
  })
  it('parses argument arrays without splitting paths or accepting non-string values', () => {
    expect(
      parseCommandArguments('["-y", "C:\\\\Program Files\\\\tool"]'),
    ).toEqual(['-y', 'C:\\Program Files\\tool'])
    expect(() => parseCommandArguments('[true]')).toThrow('字符串数组')
    expect(() => parseCommandArguments('"-y"')).toThrow('字符串数组')
  })
  it('routes actionable diagnostic categories to their owning page', () => {
    expect(diagnosticTarget('PROVIDER_CODEX')).toBe('home')
    expect(diagnosticTarget('XINGMANG_NETWORK')).toBe('settings')
    expect(diagnosticTarget('RUNTIME_NODE')).toBe('maintenance')
  })
  it('keeps async activities visible until completion and rejects invalid query ranges', () => {
    const before = pendingBusinessOperations().length
    const finish = beginBusinessOperation('恢复配置')
    expect(pendingBusinessOperations()).toHaveLength(before + 1)
    finish()
    finish()
    expect(pendingBusinessOperations()).toHaveLength(before)
    expect(() => accountTimeRange('2026-09-08', '2026-09-07')).toThrow(
      '开始时间',
    )
    expect(() => accountTimeRange('invalid', '')).toThrow('有效')
    expect(accountTimeRange('', '')).toEqual({
      startTimestamp: undefined,
      endTimestamp: undefined,
    })
  })
  it('allows only structured environment variables', () => {
    expect(
      parseEnvironmentVariables('{"TEST_TOKEN":"value with spaces"}'),
    ).toEqual({ TEST_TOKEN: 'value with spaces' })
    expect(() => parseEnvironmentVariables('{"BAD-NAME":"value"}')).toThrow(
      '环境变量',
    )
    expect(() => parseEnvironmentVariables('{"NAME":12}')).toThrow('环境变量')
  })
})
