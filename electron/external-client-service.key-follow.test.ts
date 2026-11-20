import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { externalClientNames } from './external-client-contract'
import { ExternalClientOwnershipStore, type ExternalClientKeySource } from './external-client-ownership'
import { configureManagedClis } from './account-cli-provisioner'
import { resolveManagedCliKeyProfiles } from './catalog'
import { fixture, removeTemporaryDirectories, selectedModel } from './external-client-service.test-support'

afterEach(removeTemporaryDirectories)

describe('Claude Desktop follows the key 星芒 replaced in Claude Code (#1113)', () => {
  const oldKey = 'sk-claude-code-before-123456'
  const newKey = 'sk-claude-code-after-123456'
  const subscriptionGroup = 'Claude 包月'
  type Fixture = ReturnType<typeof fixture>
  type AccountService = Parameters<typeof configureManagedClis>[0]

  // 账号后端：Claude Code 那一组签出来是新那把，别的工具各给一把不相干的。历史账号另外买了 Claude 包月。
  function accountService(site: 'solov' | 'solov-api', subscribed = false): AccountService {
    const claudeGroup = subscribed ? subscriptionGroup : resolveManagedCliKeyProfiles(site).claude.group
    return {
      getSessionState: () => ({ authenticated: true, account: { userId: 17 } }),
      getActiveSiteId: () => site,
      provisionCliKey: vi.fn(async (input: { name?: string; group?: string } = {}) => input.group === claudeGroup
        ? { id: 2, name: input.name ?? '', key: newKey }
        : { id: 50, name: input.name ?? '', key: `sk-other-tool-${String(input.group).length}-123456` }),
      ...(site === 'solov-api' ? {
        getSubscriptionSelf: async () => ({
          billingPreference: null, allSubscriptions: [],
          activeSubscriptions: subscribed ? [{ id: 1, planId: 1, status: 'active', source: 'sub2api', groupName: subscriptionGroup,
            amountTotal: null, amountUsed: null, startedAt: '', endsAt: '', nextResetAt: null }] : [],
        }),
        listUsableGroups: async () => [
          ...(['claude', 'codex', 'grok'] as const).map((provider) => ({ name: resolveManagedCliKeyProfiles(site)[provider].group, description: '', ratio: 1,
            platform: provider === 'claude' ? 'anthropic' : provider === 'codex' ? 'openai' : 'grok' })),
          { name: subscriptionGroup, description: '', ratio: 1, platform: 'anthropic' },
        ],
      } : {}),
    } as unknown as AccountService
  }

  // 首页那样：Claude Code 先连上星芒签的那把；Claude Desktop 选「使用 Claude Code 当前的星芒密钥」保存。
  async function connectBoth(f: Fixture, source: ExternalClientKeySource | undefined = 'configured', desktopKey = oldKey) {
    const site = f.keyStore!.getSiteId()
    await f.keyStore!.save(17, [{ id: 1, provider: 'claude', group: resolveManagedCliKeyProfiles(site).claude.group, name: 'xingmang-desktop-claude', key: oldKey }])
    await f.service.saveConfig({ provider: 'claude', apiKey: oldKey, model: selectedModel, mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: desktopKey, model: selectedModel }, undefined, source)
    return { file: saved.path, before: fs.readFileSync(saved.path, 'utf8') }
  }

  // 在个人中心撤销 Claude Code 在用的那把：主进程先把它从缓存里拿掉，再点名给 Claude Code 换一把新的。
  async function revokeClaudeCodeKey(f: Fixture) {
    await f.keyStore!.remove(17, 1)
    return configureManagedClis(accountService('solov'), f.service, ['claude'], {}, false, f.keyStore!, 'merge', 'explicit')
  }

  function keyLogs(f: Fixture) {
    return f.runtimeLog.log.mock.calls.filter(([, , event]) => event.startsWith('external-client.key.'))
  }

  // 换 Key 不等它：写完客户端那份还要改写归属、记日志，日志是最后一步，等到它才算换完（Windows 上写文件慢，
  // 只等文件变了会在归属改写完之前就往下查）。
  async function followed(f: Fixture) {
    await vi.waitFor(() => expect(keyLogs(f).map(([, , event]) => event)).toContain('external-client.key.followed'), { timeout: 10_000 })
  }

  function desktopKeyOf(file: string): unknown {
    return JSON.parse(fs.readFileSync(file, 'utf8')).inferenceGatewayApiKey
  }

  it('follows Claude Code after the customer revokes its key, changing nothing but the key', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectBoth(f)

    expect(await revokeClaudeCodeKey(f)).toEqual({ configured: ['claude'], failed: [] })
    await followed(f)
    expect(desktopKeyOf(file)).toBe(newKey)
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replace(`"${oldKey}"`, `"${newKey}"`))
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.followed', expect.any(String), { tool: 'claudeDesktop', route: 'primary' }]])
    // 首页照旧认它是当前账号那份，换下来的旧那把不再算。
    const desktop = (await f.service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop')
    expect(desktop).toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
    expect(desktop?.routePending).toBeUndefined()
    const ownership = new ExternalClientOwnershipStore(path.join(f.managerDataDirectory, 'external-client-ownership'))
    expect(ownership.inspect('claudeDesktop', JSON.stringify(['solov', 17]), 'https://xm.solov.cc', newKey)).toEqual({ source: 'configured' })
    expect(ownership.matches('claudeDesktop', JSON.stringify(['solov', 17]), 'https://xm.solov.cc', oldKey)).toBe(false)
    expect(JSON.stringify(f.runtimeLog.log.mock.calls)).not.toMatch(/sk-claude-code|solov\.cc/)
  })

  it('follows Claude Code when its key stopped working and 星芒 signed a new one', async () => {
    const f = fixture({ managedKeys: true })
    const { file } = await connectBoth(f)
    f.relayFetch.mockImplementation(async (url, init) => new Headers(init?.headers).get('authorization')?.includes(oldKey)
      ? Response.json({ error: { message: 'Invalid token' } }, { status: 401 })
      : String(url).endsWith('/v1/messages') ? Response.json({ id: 'msg', type: 'message', role: 'assistant', model: selectedModel, content: [], stop_reason: 'max_tokens' })
        : Response.json({ data: [{ id: selectedModel }] }))

    const outcome = await configureManagedClis(accountService('solov'), f.service, ['claude'], {}, false, f.keyStore!, 'merge', 'automatic')
    expect(outcome).toEqual({ configured: ['claude'], failed: [] })
    await followed(f)
    expect(desktopKeyOf(file)).toBe(newKey)
  })

  it('moves Claude Desktop into the subscription with Claude Code on the history account', async () => {
    const f = fixture({ site: 'solov-api', managedKeys: true })
    const { file, before } = await connectBoth(f)

    const outcome = await configureManagedClis(accountService('solov-api', true), f.service, ['claude'], {}, false, f.keyStore!, 'merge', 'automatic')
    expect(outcome).toEqual({ configured: ['claude'], failed: [] })
    await followed(f)
    expect(desktopKeyOf(file)).toBe(newKey)
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replace(`"${oldKey}"`, `"${newKey}"`))
  })

  it.each(['solov', 'solov-api'] as const)('waits for a running Claude Desktop to quit on %s, then follows by itself', async (site) => {
    const f = fixture({ site, managedKeys: true })
    const { file, before } = await connectBoth(f)
    const claude = f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!
    claude.running = true

    if (site === 'solov') await revokeClaudeCodeKey(f)
    else await configureManagedClis(accountService(site, true), f.service, ['claude'], {}, false, f.keyStore!, 'merge', 'automatic')
    await vi.waitFor(() => expect(f.routeTimers.map((timer) => timer.delayMs)).toEqual([5 * 60 * 1000]), { timeout: 10_000 })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.deferred', expect.any(String), expect.objectContaining({ tool: 'claudeDesktop' })]])
    // 首页那一行说它退出后会换上新密钥，不说线路那句。
    const pending = (await f.service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop')
    expect(pending).toMatchObject({ running: true, keyPending: true })
    expect(pending?.routePending).toBeUndefined()

    claude.running = false
    f.routeTimers.splice(0)[0].callback()
    await vi.waitFor(() => expect(f.routeFollowed).toHaveBeenCalled(), { timeout: 10_000 })
    expect(desktopKeyOf(file)).toBe(newKey)
    expect(f.routeTimers).toEqual([])
    expect((await f.service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop')?.keyPending).toBeUndefined()
  })

  it('follows on the next start when 星芒 was closed before Claude Desktop', async () => {
    const f = fixture({ managedKeys: true })
    const { file } = await connectBoth(f)
    const claude = f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!
    claude.running = true
    await revokeClaudeCodeKey(f)
    await vi.waitFor(() => expect(f.routeTimers).toHaveLength(1), { timeout: 10_000 })

    claude.running = false
    await f.restart().scanExternalClients()
    expect(desktopKeyOf(file)).toBe(newKey)
  })

  it('follows a connection saved before the key source was recorded', async () => {
    const f = fixture({ managedKeys: true })
    const { file } = await connectBoth(f, undefined)
    await revokeClaudeCodeKey(f)
    await followed(f)
    expect(desktopKeyOf(file)).toBe(newKey)
  })

  it('leaves a key the customer typed into Claude Desktop alone, even when it is the one Claude Code had', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectBoth(f, 'manual')
    await revokeClaudeCodeKey(f)
    await f.service.scanExternalClients(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([])
    expect(f.routeTimers).toEqual([])
  })

  it('leaves Claude Desktop alone when it uses another key than the one Claude Code replaced', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectBoth(f, 'account', 'sk-another-account-key-123456')
    await revokeClaudeCodeKey(f)
    await f.service.scanExternalClients(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([])
  })

  it('does not move Claude Desktop ahead of Claude Code', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectBoth(f)
    // 缓存里已经换成新那把，Claude Code 的配置却还是旧的（写配置那一步没成）。
    await f.keyStore!.save(17, [{ id: 2, provider: 'claude', group: resolveManagedCliKeyProfiles('solov').claude.group, name: 'xingmang-desktop-claude', key: newKey }])
    await f.service.scanExternalClients(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([])
  })

  it('keeps the old key when the new one does not offer the model Claude Desktop uses', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectBoth(f)
    f.relayFetch.mockImplementation(async (_url, init) => Response.json({ data: new Headers(init?.headers).get('authorization')?.includes(newKey)
      ? [{ id: 'claude-opus-4-8' }] : [{ id: selectedModel }] }))
    await revokeClaudeCodeKey(f)
    await vi.waitFor(() => expect(keyLogs(f)).toEqual([['warn', 'config', 'external-client.key.failed', expect.any(String),
      expect.objectContaining({ tool: 'claudeDesktop' })]]), { timeout: 10_000 })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('takes the menu models the new key does not offer out of Claude Desktop, so its startup check does not land on one', async () => {
    const f = fixture({ managedKeys: true })
    const haiku = 'claude-haiku-4-5'
    // 原来那把能用 Haiku（保存时试通了，进了菜单，Claude Desktop 开机检查挑的就是它）；新那把只有默认那个。
    f.relayFetch.mockImplementation(async (url, init) => String(url).endsWith('/v1/messages')
      ? Response.json({ id: 'msg', type: 'message', role: 'assistant', model: selectedModel, content: [], stop_reason: 'max_tokens' })
      : Response.json({ data: new Headers(init?.headers).get('authorization')?.includes(newKey) ? [{ id: selectedModel }] : [{ id: selectedModel }, { id: haiku }] }))
    const { file } = await connectBoth(f)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).inferenceModels).toEqual([{ name: selectedModel }, { name: haiku }])

    await revokeClaudeCodeKey(f)
    await followed(f)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ inferenceGatewayApiKey: newKey, inferenceModels: [{ name: selectedModel }] })
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.followed', expect.any(String),
      { tool: 'claudeDesktop', route: 'primary', unsupportedModels: [haiku] }]])
    expect((await f.service.scanExternalClients(true)).find((client) => client.tool === 'claudeDesktop'))
      .toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
  })
})

describe('WorkBuddy and OpenCode follow the key 星芒 replaced in the tool they borrow it from (#1113)', () => {
  const oldKey = 'sk-codex-before-123456'
  const newKey = 'sk-codex-after-123456'
  const claudeOldKey = 'sk-claude-code-before-123456'
  const claudeNewKey = 'sk-claude-code-after-123456'
  const model = 'gpt-5.4'
  type Fixture = ReturnType<typeof fixture>
  type AccountService = Parameters<typeof configureManagedClis>[0]

  // 账号后端：Codex、Claude Code 那一组各签出新的那一把。
  function accountService(): AccountService {
    const profiles = resolveManagedCliKeyProfiles('solov')
    return {
      getSessionState: () => ({ authenticated: true, account: { userId: 17 } }),
      getActiveSiteId: () => 'solov',
      provisionCliKey: vi.fn(async (input: { name?: string; group?: string } = {}) => input.group === profiles.codex.group
        ? { id: 3, name: input.name ?? '', key: newKey } : { id: 4, name: input.name ?? '', key: claudeNewKey }),
    } as unknown as AccountService
  }

  function install(f: Fixture, tool: 'workbuddy' | 'opencode') {
    const status = f.runtimeStatuses.find((entry) => entry.tool === tool)!
    Object.assign(status, { installed: true, version: '1.0.0', path: path.join(f.directory, tool, `${tool}.exe`), installDirectory: path.join(f.directory, tool) })
    return status
  }

  // Codex（和 Claude Code）先连上星芒签的那把；客户端选「使用 Codex 当前的星芒密钥」保存。
  async function connect(f: Fixture, tool: 'workbuddy' | 'opencode', options: { source?: ExternalClientKeySource; borrow?: 'codex' | 'claude' } = {}) {
    install(f, tool)
    const profiles = resolveManagedCliKeyProfiles('solov')
    await f.keyStore!.save(17, [
      { id: 1, provider: 'codex', group: profiles.codex.group, name: 'xingmang-desktop-codex', key: oldKey },
      { id: 2, provider: 'claude', group: profiles.claude.group, name: 'xingmang-desktop-claude', key: claudeOldKey },
    ])
    await f.service.saveConfig({ provider: 'codex', apiKey: oldKey, model, mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    await f.service.saveConfig({ provider: 'claude', apiKey: claudeOldKey, model: selectedModel, mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    const borrowed = options.borrow === 'claude' ? claudeOldKey : oldKey
    const saved = await f.service.configureExternalTool(tool, { apiKey: borrowed, model }, undefined, options.source ?? 'configured')
    return { file: saved.path, before: fs.readFileSync(saved.path, 'utf8'), borrowed }
  }

  // 在个人中心撤销那个工具在用的那把：先从缓存里拿掉，再点名给它换一把新的。
  async function revoke(f: Fixture, provider: 'codex' | 'claude' = 'codex') {
    await f.keyStore!.remove(17, provider === 'codex' ? 1 : 2)
    return configureManagedClis(accountService(), f.service, [provider], {}, false, f.keyStore!, 'merge', 'explicit')
  }

  function keyLogs(f: Fixture) {
    return f.runtimeLog.log.mock.calls.filter(([, , event]) => event.startsWith('external-client.key.'))
  }

  // 换 Key 不等它：写完客户端那份还要改写归属、记日志，日志是最后一步，等到它才算换完（Windows 上写文件慢，
  // 只等文件变了会在归属改写完之前就往下查）。
  async function followed(f: Fixture) {
    await vi.waitFor(() => expect(keyLogs(f).map(([, , event]) => event)).toContain('external-client.key.followed'), { timeout: 10_000 })
  }

  it.each(['workbuddy', 'opencode'] as const)('follows Codex into %s after the customer revokes its key, changing nothing but the key', async (tool) => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connect(f, tool)

    expect(await revoke(f)).toEqual({ configured: ['codex'], failed: [] })
    await followed(f)
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replaceAll(`"${oldKey}"`, `"${newKey}"`))
    expect(before).toContain(oldKey)
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.followed', `已把 ${externalClientNames[tool]} 换成 Codex CLI 现在用的密钥`, { tool, route: 'primary' }]])
    expect((await f.service.scanExternalClients()).find((client) => client.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang', model })
    expect(JSON.stringify(f.runtimeLog.log.mock.calls)).not.toMatch(/sk-codex|solov\.cc/)
  })

  it('follows Claude Code when OpenCode borrowed its key instead of Codex\'s', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connect(f, 'opencode', { borrow: 'claude' })

    await revoke(f, 'claude')
    await followed(f)
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replaceAll(`"${claudeOldKey}"`, `"${claudeNewKey}"`))
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.followed', '已把 OpenCode 换成 Claude Code 现在用的密钥', expect.objectContaining({ tool: 'opencode' })]])
  })

  it.each(['workbuddy', 'opencode'] as const)('waits for a running %s to quit and says so on its row, then follows by itself', async (tool) => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connect(f, tool)
    const status = f.runtimeStatuses.find((entry) => entry.tool === tool)!
    status.running = true

    await revoke(f)
    await vi.waitFor(() => expect(f.routeTimers.map((timer) => timer.delayMs)).toEqual([5 * 60 * 1000]), { timeout: 10_000 })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect((await f.service.scanExternalClients()).find((client) => client.tool === tool)).toMatchObject({ running: true, keyPending: true })

    status.running = false
    f.routeTimers.splice(0)[0].callback()
    await vi.waitFor(() => expect(f.routeFollowed).toHaveBeenCalled(), { timeout: 10_000 })
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replaceAll(`"${oldKey}"`, `"${newKey}"`))
    expect(f.routeTimers).toEqual([])
  })

  it.each(['workbuddy', 'opencode'] as const)('leaves a key the customer typed into %s alone', async (tool) => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connect(f, tool, { source: 'manual' })
    await revoke(f)
    await f.service.scanExternalClients(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([])
  })
  it('moves only the WorkBuddy entries whose model the new key offers and leaves the rest on the old key', async () => {
    const f = fixture({ managedKeys: true })
    const { file } = await connect(f, 'workbuddy')
    // 同一把 Codex 的密钥又存了一个 Claude 型号；新那把只认 GPT 那个。
    await f.service.configureExternalTool('workbuddy', { apiKey: oldKey, model: selectedModel }, undefined, 'configured')
    f.relayFetch.mockImplementation(async (_url, init) => Response.json({ data: new Headers(init?.headers).get('authorization')?.includes(newKey)
      ? [{ id: model }] : [{ id: model }, { id: selectedModel }] }))
    const entries = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; apiKey: string }[]).map((entry) => [entry.id, entry.apiKey])
    expect(entries()).toEqual([[model, oldKey], [selectedModel, oldKey]])

    await revoke(f)
    await followed(f)
    expect(entries()).toEqual([[model, newKey], [selectedModel, oldKey]])
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.followed', '已把 WorkBuddy 换成 Codex CLI 现在用的密钥',
      { tool: 'workbuddy', route: 'primary', unsupportedModels: [selectedModel] }]])
    // 换过一次就不再回头：留在旧密钥上的那条不再算星芒当前账号的，之后的检测不会一遍遍再试。
    expect((await f.service.scanExternalClients(true)).find((client) => client.tool === 'workbuddy')).toMatchObject({ configured: true, model })
    expect(keyLogs(f)).toHaveLength(1)
  })
})

