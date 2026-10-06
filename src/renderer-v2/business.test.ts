import { describe, expect, it, vi } from 'vitest'
import { createSettingsQueue, diagnosticHasFix, diagnosticSection, diagnosticTarget } from './pages-maintenance'
import {
  accountHeadLead,
  accountTabNeeds,
  buildAccountInviteLink,
  buildSubscriptionPaymentInput,
  passwordFormDirty,
  paymentTerminalBody,
  paymentTerminalPresentation,
  buildTopupBonus,
  resetTopupQuoteForMethod,
  subscriptionStateFor,
  subscriptionToolsNotice,
  validateTopupAmount,
  subscriptionPaymentMethods,
} from './pages-account'
import {
  extensionInScope,
  extensionItemsForView,
  extensionScopeLabel,
  filterExtensionMarkets,
  parseCommandArguments,
  parseEnvironmentVariables,
  readCodexExtensionMetadata,
} from './pages-management'
import { accountTimeRange, hiddenFilterCount } from './AccountFilters'
import {
  beginBusinessOperation,
  errorMessage,
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
    expect(paymentTerminalPresentation('success')).toMatchObject({ tone: 'ok', title: '充值成功' })
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

  it('says a paid subscription is open instead of calling it a top-up', () => {
    expect(paymentTerminalPresentation('success', false, 'subscription')).toMatchObject({ tone: 'ok', title: '订阅已开通' })
    expect(paymentTerminalPresentation('failed', false, 'subscription')).toMatchObject({ title: '支付没有完成' })
    expect(paymentTerminalBody({ status: 'success', tradeNo: 'XM-2' }, 'subscription')).toBe('订单 XM-2 已付款，订阅已开通，正在刷新订阅。')
  })

  it('tells the customer whether their tools now draw on the subscription', () => {
    expect(subscriptionToolsNotice({ followsPreference: true }).body).toContain('扣费偏好')
    expect(subscriptionToolsNotice({ followsPreference: false, switched: ['Claude Code', 'Codex'] })).toMatchObject({
      tone: 'ok', title: '工具已改用订阅额度', body: expect.stringContaining('Claude Code、Codex'),
    })
    expect(subscriptionToolsNotice({ followsPreference: false, switched: [] }).title).toBe('工具不用重新设置')
    expect(subscriptionToolsNotice({ followsPreference: false, error: '网络连接失败。' })).toMatchObject({
      tone: 'warn', body: expect.stringContaining('重新写入 Key'), action: 'health',
    })
    expect(subscriptionToolsNotice({ followsPreference: true }).action).toBeUndefined()
  })

  it('names every subscription state in Chinese and never shows the raw server value', () => {
    expect(subscriptionStateFor('active')).toEqual({ label: '生效中', tone: 'ok' })
    expect(subscriptionStateFor('exhausted')).toEqual({ label: '额度已用完', tone: 'warn' })
    expect(subscriptionStateFor('expired')).toEqual({ label: '已到期', tone: 'neutral' })
    // 星芒账号后台作废的、历史账号删掉的和暂停的。
    expect(subscriptionStateFor('cancelled')).toEqual({ label: '已撤销', tone: 'neutral' })
    expect(subscriptionStateFor('revoked')).toEqual({ label: '已撤销', tone: 'neutral' })
    expect(subscriptionStateFor('suspended')).toEqual({ label: '已停用', tone: 'neutral' })
    for (const status of ['paused', '', 'ACTIVE', 'constructor', 'toString', '__proto__']) {
      expect(subscriptionStateFor(status)).toEqual({ label: '待确认', tone: 'neutral' })
    }
  })

  it('lets each account page wait only for the reads it actually shows', () => {
    expect(accountTabNeeds('overview')).toEqual({ profile: true, balance: true })
    expect(accountTabNeeds('invite')).toEqual({ profile: true, balance: true })
    for (const tab of ['recharge', 'orders', 'devices'] as const) {
      expect(accountTabNeeds(tab)).toEqual({ profile: false, balance: false })
    }
    for (const tab of ['dashboard', 'usage', 'tasks', 'keys'] as const) {
      expect(accountTabNeeds(tab)).toEqual({ profile: false, balance: true })
    }
  })

  it('names the current account in the page head and says plainly when its profile was not read', () => {
    expect(accountHeadLead({ username: 'alice', email: 'a@example.test' })).toBe('当前账号：alice（a@example.test）')
    expect(accountHeadLead({ username: 'alice', email: '' })).toBe('当前账号：alice')
    expect(accountHeadLead(null)).toBe('当前账号的资料暂时没有读到')
  })

  it('counts only the folded filters that a query actually applied', () => {
    const fields = [
      { key: 'start', label: '开始时间' },
      { key: 'modelName', label: '模型名称' },
      { key: 'group', label: '分组' },
      { key: 'tokenName', label: '令牌名称' },
    ]
    expect(hiddenFilterCount(fields, ['start', 'modelName'], {})).toBe(0)
    expect(hiddenFilterCount(fields, ['start', 'modelName'], { start: '2026-10-01T00:00', modelName: 'gpt' })).toBe(0)
    expect(hiddenFilterCount(fields, ['start', 'modelName'], { group: 'vip', tokenName: '', modelName: 'gpt' })).toBe(1)
  })

  it('tells the user what happens after the payment window closes and where to check', () => {
    expect(paymentTerminalPresentation('closed', true).body).toContain('星芒还在确认到账')
    expect(paymentTerminalPresentation('closed').body).toContain('查看我的订单')
    expect(paymentTerminalPresentation('unconfirmed')).toMatchObject({ tone: 'warn', title: '还没查到这笔订单到账' })
    expect(paymentTerminalPresentation('unconfirmed').body).toContain('联系客服')
    expect(paymentTerminalPresentation('failed').body).toContain('查看我的订单')
    expect(paymentTerminalBody({ status: 'success', tradeNo: 'XM-1' })).toBe('订单 XM-1 已到账，余额已更新。')
    expect(paymentTerminalBody({ status: 'closed', tradeNo: 'XM-1', confirming: true })).not.toContain('XM-1')
    expect(paymentTerminalBody({ status: 'unconfirmed', tradeNo: 'XM-1' })).toContain('订单号 XM-1')
    expect(paymentTerminalBody({ status: 'closed', tradeNo: null })).not.toContain('订单号')
  })

  it('validates recharge amounts against the integer IPC contract and channel minimum', () => {
    expect(validateTopupAmount(10, 5)).toBe(10)
    expect(() => validateTopupAmount(10.5, 5)).toThrow('整数')
    expect(() => validateTopupAmount(4, 5)).toThrow('不能低于')
    expect(() => validateTopupAmount(10, Number.NaN)).toThrow('最低充值金额无效')
  })

  it('turns a backend topup discount into a bonus measured against what the customer pays', () => {
    const discounts = { 110: 100 / 110, 650: 500 / 650, 1600: 0.625, 4000: 0.5, 20: 1 }
    expect(buildTopupBonus(110, discounts)).toEqual({ bonus: 10, percent: 10 })
    expect(buildTopupBonus(650, discounts)).toEqual({ bonus: 150, percent: 30 })
    expect(buildTopupBonus(1600, discounts)).toEqual({ bonus: 600, percent: 60 })
    expect(buildTopupBonus(4000, discounts)).toEqual({ bonus: 2000, percent: 100 })
  })

  it('shows no bonus for full-price, missing, or malformed discounts', () => {
    expect(buildTopupBonus(20, { 20: 1 })).toBeNull()
    expect(buildTopupBonus(20, { 20: 1.2 })).toBeNull()
    expect(buildTopupBonus(20, { 20: 0 })).toBeNull()
    expect(buildTopupBonus(30, { 20: 0.8 })).toBeNull()
    expect(buildTopupBonus(20, undefined)).toBeNull()
    expect(buildTopupBonus(Number.NaN, { 20: 0.8 })).toBeNull()
    expect(buildTopupBonus(20, {})).toBeNull()
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

  it('names the detail scope in Chinese instead of the CLI scope keyword', () => {
    expect(extensionScopeLabel('user')).toBe('我的（全局）')
    expect(extensionScopeLabel('project')).toBe('当前项目')
    expect(extensionScopeLabel('workspace')).toBe('当前工作区')
    expect(extensionScopeLabel('builtin')).toBe('系统内置')
    // Claude 的 local 只在这个项目里用；Gemini 扩展自带的技能装在用户目录里。
    expect(extensionScopeLabel('local')).toBe('当前项目')
    expect(extensionScopeLabel('extension')).toBe('我的（全局）')
    expect(extensionScopeLabel(null)).toBe('未提供')
    expect(extensionScopeLabel(undefined)).toBe('未提供')
  })

  it('files each item under the same scope filter its details name', () => {
    // 详情写「当前项目」的，选「当前项目」就列出来；写「我的（全局）」的同理。
    expect(extensionInScope('local', 'project')).toBe(true)
    expect(extensionInScope('extension', 'user')).toBe(true)
    expect(extensionInScope('project', 'project')).toBe(true)
    expect(extensionInScope('user', 'user')).toBe(true)
    expect(extensionInScope('workspace', 'workspace')).toBe(true)
    expect(extensionInScope('builtin', 'builtin')).toBe(true)
    expect(extensionInScope('local', 'user')).toBe(false)
    expect(extensionInScope('extension', 'project')).toBe(false)
    expect(extensionInScope('user', 'project')).toBe(false)
    // 没带 scope 的只在「全部范围」里。
    expect(extensionInScope(null, 'user')).toBe(false)
    expect(extensionInScope(undefined, 'project')).toBe(false)
    for (const scope of ['user', 'project', 'local', 'workspace', 'builtin', 'extension', null] as const)
      expect(extensionInScope(scope, 'all')).toBe(true)
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
    // 设置页没有能处理它的东西；能清的那种在行里直接给按钮。
    expect(diagnosticTarget('PROXY_ENVIRONMENT')).toBeNull()
    expect(diagnosticTarget('RUNTIME_NODE')).toBe('maintenance')
    expect(diagnosticTarget('RUNTIME_PYTHON')).toBe('maintenance')
    expect(diagnosticTarget('CLI_CLAUDE')).toBe('maintenance')
    expect(diagnosticTarget('CODEX_DESKTOP')).toBe('maintenance')
    // Git 的安装指引在首页「运行环境」里，「安装卸载」页没有它。
    expect(diagnosticTarget('RUNTIME_GIT')).toBe('home')
    // 文件夹被搬过没有软件里能一键修的地方，下一步是导出报告。
    expect(diagnosticTarget('FOLDER_RELOCATED')).toBe('feedback')
    // 加速文件坏了：「重新检查」和「联系客服」都在加速页上。
    expect(diagnosticTarget('ACCELERATION_BUNDLE')).toBe('acceleration')
  })
  it('offers no fix button where no page in the app can fix it', () => {
    for (const code of [
      'WORKSPACE_CONFIG_OVERRIDE',
      'PROVIDER_ENVIRONMENT_OVERRIDE',
      // 以前跳「设置 → 网络」或首页，那里都没有能处理它们的东西，点了只会绕一圈。
      // 网络那一项只有换线路救得回来时才翻到线路那一行（下一条），不带原因时照旧不给。
      'XINGMANG_NETWORK',
      'CLASH_VERGE_TUN',
      'CODEX_DOTENV',
      'CLAUDE_BYPASS_PERMISSIONS',
      'DISK_SPACE',
      'ADMINISTRATOR',
      'OPERATING_SYSTEM',
      'SYSTEM_POWERSHELL',
      'APP_RUNTIME',
      'AI_OUTPUT',
      'SOMETHING_NEW',
    ]) {
      expect(diagnosticTarget(code)).toBeNull()
      expect(diagnosticHasFix(code)).toBe(false)
    }
  })
  // 第四十三批 B：#872 以后「设置 → 网络」最上面就是「星芒账号线路」，被当地网络切断的
  // 那几种连不上，「去处理」翻到那一行，选「备用直连」再重开就换过去了。直连适配第二步起
  // 历史账号也能选直连，它那一行也给。
  it('sends a cut-off line of the signed-in account to its route setting', () => {
    for (const reason of ['dns', 'refused', 'timeout']) {
      const details = { endpoint: 'https://xm.solov.cc/api/status', reason, siteId: 'solov' }
      expect(diagnosticTarget('XINGMANG_NETWORK', details, 'solov')).toBe('settings')
      expect(diagnosticHasFix('XINGMANG_NETWORK', details, 'solov')).toBe(true)
      expect(diagnosticSection('XINGMANG_NETWORK', details, 'solov')).toBe('relay-route-solov')
      const historical = { endpoint: 'https://api.solov.cc/api/v1/settings/public', reason, siteId: 'solov-api' }
      expect(diagnosticTarget('XINGMANG_NETWORK', historical, 'solov-api')).toBe('settings')
      expect(diagnosticHasFix('XINGMANG_NETWORK', historical, 'solov-api')).toBe(true)
      expect(diagnosticSection('XINGMANG_NETWORK', historical, 'solov-api')).toBe('relay-route-solov-api')
    }
  })
  it('keeps the network row without a fix where switching lines cannot help', () => {
    const cases: Array<[string, Record<string, string | number> | undefined, string | null]> = [
      // 没网、代理、证书、上网认证、服务维护：换线路救不了。
      ...['offline', 'proxy', 'tls', 'certDate', 'intercepted', 'serviceUnavailable'].map((reason): [string, Record<string, string>, string] => [reason, { reason, siteId: 'solov' }, 'solov']),
      // 网络通了、服务回了错误码：不带原因。
      ['http status', { status: 503, siteId: 'solov' }, 'solov'],
      // 访客。
      ['guest', { reason: 'refused', siteId: 'solov' }, null],
      // 开机恢复历史账号时查的是默认那个站；换过账号以后看的旧结果也一样，查的不是登着的这个。
      ['another site', { reason: 'refused', siteId: 'solov' }, 'solov-api'],
      // 旧版主进程给的结果不带站点。
      ['no site', { reason: 'refused' }, 'solov'],
      ['no details', undefined, 'solov'],
    ]
    for (const [label, details, accountSiteId] of cases) {
      expect(diagnosticTarget('XINGMANG_NETWORK', details, accountSiteId), label).toBeNull()
      expect(diagnosticHasFix('XINGMANG_NETWORK', details, accountSiteId), label).toBe(false)
      expect(diagnosticSection('XINGMANG_NETWORK', details, accountSiteId), label).toBeUndefined()
    }
    // 代理软件那一项在设置里仍然没有能处理它的东西。
    expect(diagnosticTarget('CLASH_VERGE_TUN', { reason: 'refused', siteId: 'solov' }, 'solov')).toBeNull()
    expect(diagnosticSection('CLASH_VERGE_TUN', { reason: 'refused', siteId: 'solov' }, 'solov')).toBeUndefined()
  })
  it('sends only the outdated Node.js certificate verdict to the install page', () => {
    expect(diagnosticTarget('CERTIFICATE_TRUST', { verdict: 'outdatedNode' })).toBe('maintenance')
    expect(diagnosticHasFix('CERTIFICATE_TRUST', { verdict: 'outdatedNode' })).toBe(true)
    for (const verdict of ['untrusted', 'elevated', 'direct', 'systemTrusted', 'unknown']) {
      expect(diagnosticHasFix('CERTIFICATE_TRUST', { verdict })).toBe(false)
    }
    expect(diagnosticHasFix('CERTIFICATE_TRUST')).toBe(false)
  })
  it('tells the account page why the server refused instead of asking for a retry', () => {
    expect(errorMessage(new Error('Original password is incorrect'))).toBe(
      '原密码错误，请重新输入',
    )
    expect(
      errorMessage(
        new Error(
          "Error invoking remote method 'account:change-password': Error: This account has no password set.",
        ),
      ),
    ).toBe('当前账号未设置密码，请先通过“找回密码”设置密码')
    expect(errorMessage(new Error('User has been banned'))).toBe(
      '该账号已被封禁，请联系客服',
    )
    expect(errorMessage(new Error('Database error'))).toBe(
      '服务暂时不可用，请稍后重试',
    )
    expect(errorMessage(new Error('原密码错误'))).toBe('原密码错误，请重新输入')
  })
  it('keeps its own fallbacks for everything the account table does not name', () => {
    expect(errorMessage(new Error('配置没有写入，已保留原文件'))).toBe(
      '配置没有写入，已保留原文件',
    )
    expect(errorMessage(new Error('request failed with 401 unauthorized'))).toContain(
      '登录已过期',
    )
    expect(errorMessage(new Error('ETIMEDOUT timeout'))).toContain('请检查网络后重试')
    expect(errorMessage(new Error('unexpected upstream failure xyz-123'))).toBe(
      '操作没有成功，请重试；还不行，到「反馈」页把报告发给客服。',
    )
    expect(errorMessage('plain string')).toBe('操作没有成功，请重试；还不行，到「反馈」页把报告发给客服。')
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
  it('treats any typed password as unsaved work so closing asks before dropping it', () => {
    const empty = {
      busy: '',
      originalPassword: '',
      password: '',
      confirmPassword: '',
    }
    expect(passwordFormDirty(empty)).toBe(false)
    expect(passwordFormDirty({ ...empty, originalPassword: 'current' })).toBe(
      true,
    )
    expect(passwordFormDirty({ ...empty, password: 'next' })).toBe(true)
    expect(passwordFormDirty({ ...empty, confirmPassword: 'next' })).toBe(true)
    expect(passwordFormDirty({ ...empty, busy: 'password' })).toBe(true)
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
