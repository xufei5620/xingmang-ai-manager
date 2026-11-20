import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { externalClientNames, externalToolIds, type ExternalClientRuntimeStatus } from './external-client-contract'
import { ExternalClientOwnershipStore } from './external-client-ownership'
import type { ExternalToolId } from './external-tool-config'
import { fixture, removeTemporaryDirectories, selectedKey, selectedModel } from './external-client-service.test-support'

afterEach(removeTemporaryDirectories)

describe('external clients follow the connection route the user selected (batch 43 A)', () => {
  const primaryOrigin = 'https://xm.solov.cc'
  const directOrigin = 'https://xm-direct.solov.cc'
  const retiredDirectOrigin = 'https://38.147.105.28:8443'

  // 首页「配置」那样，在当前生效的线路上给三家各存一次；三家都装着、都没开。
  async function configureAll(f: ReturnType<typeof fixture>) {
    for (const status of f.runtimeStatuses) status.installed = true
    const files = new Map<ExternalToolId, string>()
    for (const tool of externalToolIds) {
      const result = await f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel, ...(tool === 'opencode' ? { protocol: 'chat-completions' as const } : {}) })
      files.set(tool, result.path)
    }
    return { files, before: new Map([...files].map(([tool, file]) => [tool, fs.readFileSync(file, 'utf8')])) }
  }

  // 设置里选一条线路、点「现在重开」：选择存进设置，下一个进程才按它走。
  async function restartOn(f: ReturnType<typeof fixture>, endpoint: 'primary' | 'direct') {
    await f.store.update({ version: 2, relayEndpointIds: { solov: endpoint } })
    return f.restart()
  }

  function backupsOf(file: string): string[] {
    return fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.bak.`))
      .map((name) => fs.readFileSync(path.join(path.dirname(file), name), 'utf8'))
  }

  function routeLogs(f: ReturnType<typeof fixture>) {
    return f.runtimeLog.log.mock.calls.filter(([, , event]) => event.startsWith('external-client.route.'))
  }

  // 客户在客户端里自己换了一把 Key。
  function replaceKeyByHand(tool: ExternalToolId, file: string) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (tool === 'claudeDesktop') config.inferenceGatewayApiKey = 'sk-hand-edited'
    else if (tool === 'workbuddy') config[0].apiKey = 'sk-hand-edited'
    else config.provider.xingmang.options.apiKey = 'sk-hand-edited'
    fs.writeFileSync(file, JSON.stringify(config), 'utf8')
  }

  it('moves each client the current account configured to the selected route after a restart, keeping key, model and protocol', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    f.relayFetch.mockClear()
    const clients = await (await restartOn(f, 'direct')).scanExternalClients()

    for (const tool of externalToolIds) {
      const client = clients.find((entry) => entry.tool === tool)
      expect(client).toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
      expect(client?.routePending).toBeUndefined()
      // 只换了地址：Key、模型、OpenCode 的 npm 包（也就是协议）都原样，改前那份留了备份。
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool)!.replaceAll(primaryOrigin, directOrigin))
      expect(backupsOf(files.get(tool)!)).toContain(before.get(tool))
      expect(routeLogs(f)).toContainEqual(['info', 'config', 'external-client.route.followed', expect.any(String),
        { tool, from: 'primary', to: 'direct' }])
    }
    // 每家只在新线路上查一次模型清单，换完不再另发自检；结果与日志里没有 Key，日志里也不记地址。
    expect(f.relayFetch.mock.calls.map(([url]) => String(url))).toEqual(externalToolIds.map(() => `${directOrigin}/v1/models`))
    expect(JSON.stringify(clients)).not.toContain(selectedKey)
    expect(JSON.stringify(routeLogs(f))).not.toMatch(/sk-selected|solov\.cc|38\.147/)
  })

  it('moves clients saved on the retired direct IP entry to the direct domain', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    // 装过直连还是 IP 那一版、选了备用直连的客户：三家存在 IP 测试入口上，归属也记在那个地址上。
    const ownership = new ExternalClientOwnershipStore(path.join(f.managerDataDirectory, 'external-client-ownership'))
    for (const tool of externalToolIds) {
      fs.writeFileSync(files.get(tool)!, before.get(tool)!.replaceAll(primaryOrigin, retiredDirectOrigin), 'utf8')
      await ownership.write(tool, JSON.stringify(['solov', 17]), tool === 'claudeDesktop' ? retiredDirectOrigin : `${retiredDirectOrigin}/v1`, selectedKey)
    }
    f.relayFetch.mockClear()
    const clients = await (await restartOn(f, 'direct')).scanExternalClients()

    for (const tool of externalToolIds) {
      expect(clients.find((entry) => entry.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang' })
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool)!.replaceAll(primaryOrigin, directOrigin))
      expect(routeLogs(f)).toContainEqual(['info', 'config', 'external-client.route.followed', expect.any(String),
        { tool, from: 'direct', to: 'direct' }])
    }
    expect(f.relayFetch.mock.calls.map(([url]) => String(url))).toEqual(externalToolIds.map(() => `${directOrigin}/v1/models`))
  })

  it('moves them back when the user selects the default route again', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    await (await restartOn(f, 'direct')).scanExternalClients()
    const clients = await (await restartOn(f, 'primary')).scanExternalClients()

    for (const tool of externalToolIds) {
      expect(clients.find((entry) => entry.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang' })
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool))
    }
  })

  it('leaves a running client alone, marks the route as pending, and moves it once the client has quit', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    const claude = f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!
    claude.running = true
    const pending = (await service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop')

    expect(pending).toMatchObject({ running: true, routePending: true, configured: false, configurationSource: 'other' })
    expect(fs.readFileSync(files.get('claudeDesktop')!, 'utf8')).toBe(before.get('claudeDesktop'))
    expect(routeLogs(f)).toContainEqual(['info', 'config', 'external-client.route.deferred', expect.any(String), { tool: 'claudeDesktop', from: 'primary', to: 'direct' }])

    claude.running = false
    const moved = (await service.scanExternalClients(true)).find((client) => client.tool === 'claudeDesktop')
    expect(moved).toMatchObject({ running: false, configured: true, configurationSource: 'xingmang' })
    expect(moved?.routePending).toBeUndefined()
    expect(fs.readFileSync(files.get('claudeDesktop')!, 'utf8')).toBe(before.get('claudeDesktop')!.replaceAll(primaryOrigin, directOrigin))
  })

  // 星芒退出时撤掉等客户端退出的那个定时（#1070 第 3 步搬家后由 disposeToolRoutes 调外部客户端那边撤）。
  it('drops the pending client check-back when the app shuts down', async () => {
    const f = fixture()
    await configureAll(f)
    const service = await restartOn(f, 'direct')
    f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!.running = true
    expect((await service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop'))
      .toMatchObject({ routePending: true, routeRecheck: true })
    expect(f.routeTimers).toHaveLength(1)

    expect(service.disposeToolRoutes).toBeTypeOf('function')
    service.disposeToolRoutes?.()
    expect(f.routeTimers).toEqual([])
  })

  // xm 三线路 C11：客户不用回来点「重新检测」，关掉客户端以后星芒自己换。
  it('checks a pending client every five minutes and moves it by itself once it has quit', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    const claude = f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!
    claude.running = true
    expect((await service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop'))
      .toMatchObject({ routePending: true, routeRecheck: true })
    expect(f.routeTimers.map((timer) => timer.delayMs)).toEqual([5 * 60 * 1000])

    // 还开着：只看了一眼进程，没有整轮检测，接着等。
    const scans = vi.mocked(f.runtime.scan).mock.calls.length
    f.routeTimers.splice(0)[0].callback()
    await vi.waitFor(() => expect(f.routeTimers).toHaveLength(1), { timeout: 10_000 })
    expect(f.runtime.stillRunning).toHaveBeenCalledWith('claudeDesktop', claude.path)
    expect(vi.mocked(f.runtime.scan).mock.calls.length).toBe(scans)

    // 这一轮要整轮检测再原子改写配置，Windows 跑道上常超过 waitFor 默认的 1 秒。
    claude.running = false
    f.routeTimers.splice(0)[0].callback()
    await vi.waitFor(() => expect(f.routeFollowed).toHaveBeenCalled(), { timeout: 10_000 })
    expect(fs.readFileSync(files.get('claudeDesktop')!, 'utf8')).toBe(before.get('claudeDesktop')!.replaceAll(primaryOrigin, directOrigin))
    expect(f.routeTimers).toEqual([])
  })

  it('looks again when the window comes back, at most once every two minutes', async () => {
    const f = fixture()
    await configureAll(f)
    const service = await restartOn(f, 'direct')
    f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!.running = true
    await service.scanExternalClients()
    service.recheckPendingExternalRoutes?.()
    expect(f.runtime.stillRunning).not.toHaveBeenCalled()
    f.routeClock.now += 2 * 60 * 1000
    service.recheckPendingExternalRoutes?.()
    await vi.waitFor(() => expect(f.runtime.stillRunning).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  })

  it('keeps asking for a manual recheck on the legacy account site', async () => {
    const f = fixture({ site: 'solov-api' })
    await configureAll(f)
    await f.store.update({ version: 2, relayEndpointIds: { 'solov-api': 'direct' } })
    const service = f.restart()
    f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!.running = true
    const client = (await service.scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop')
    expect(client?.routePending).toBe(true)
    expect(client?.routeRecheck).toBeUndefined()
    expect(f.routeTimers).toEqual([])
  })

  it('does not write a client that was opened while the model list was being fetched', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    // 盘点照真的那样缓存，不强制就给上一份；客户是在拉模型清单那几秒里打开 WorkBuddy 的，
    // 只有拉完清单、动文件之前那次强制盘点看得到。
    let cached: ExternalClientRuntimeStatus[] | null = null
    vi.mocked(f.runtime.scan).mockImplementation(async (options) => {
      if (options?.force || options?.fresh || !cached) cached = structuredClone(f.runtimeStatuses)
      return structuredClone(cached)
    })
    const answer = f.relayFetch.getMockImplementation()!
    f.relayFetch.mockImplementation(async (...request) => {
      f.runtimeStatuses.find((status) => status.tool === 'workbuddy')!.running = true
      return answer(...request)
    })
    const client = (await service.scanExternalClients()).find((entry) => entry.tool === 'workbuddy')

    expect(client).toMatchObject({ running: true, routePending: true, configurationSource: 'other' })
    expect(fs.readFileSync(files.get('workbuddy')!, 'utf8')).toBe(before.get('workbuddy'))
    expect(routeLogs(f)).toContainEqual(['info', 'config', 'external-client.route.deferred', expect.any(String), { tool: 'workbuddy', from: 'primary', to: 'direct' }])
  })

  // 总单 #34（11-18 N9、全面检查 D-5）：拉清单那几秒里才打开的，跟一开始就开着的一样，关掉以后星芒自己换（C11），
  // 不再要客户回来点「重新检测」。
  it('checks back on a client opened while the model list was being fetched and moves it by itself once it has quit', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    let cached: ExternalClientRuntimeStatus[] | null = null
    vi.mocked(f.runtime.scan).mockImplementation(async (options) => {
      if (options?.force || options?.fresh || !cached) cached = structuredClone(f.runtimeStatuses)
      return structuredClone(cached)
    })
    // 真的盘点认出装着的都带程序位置，回头看它关没关（stillRunning）认的就是这个。
    const workbuddy = f.runtimeStatuses.find((status) => status.tool === 'workbuddy')!
    workbuddy.path = path.join(f.directory, 'WorkBuddy', 'WorkBuddy.exe')
    const answer = f.relayFetch.getMockImplementation()!
    let opened = false
    f.relayFetch.mockImplementation(async (...request) => {
      if (!opened) workbuddy.running = opened = true
      return answer(...request)
    })
    const client = (await service.scanExternalClients()).find((entry) => entry.tool === 'workbuddy')

    expect(client).toMatchObject({ running: true, routePending: true, routeRecheck: true })
    expect(f.routeTimers.map((timer) => timer.delayMs)).toEqual([5 * 60 * 1000])

    workbuddy.running = false
    f.routeTimers.splice(0)[0].callback()
    await vi.waitFor(() => expect(f.routeFollowed).toHaveBeenCalled(), { timeout: 10_000 })
    expect(f.runtime.stillRunning).toHaveBeenCalledWith('workbuddy', workbuddy.path)
    expect(fs.readFileSync(files.get('workbuddy')!, 'utf8')).toBe(before.get('workbuddy')!.replaceAll(primaryOrigin, directOrigin))
    expect(f.routeTimers).toEqual([])
  })

  it.each<[string, Partial<ExternalClientRuntimeStatus>]>([
    ['cannot tell whether it is installed', { detectionError: '部分软件安装记录无法读取，暂时不能确认客户端是否未安装，请重试检测' }],
    ['no longer finds it installed', { installed: false }],
  ])('writes nothing when the check right before writing %s', async (_case, recheck) => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    // 检测时三家都好好的；动文件之前那次盘点认不准了，就当这次没看清，不写。
    vi.mocked(f.runtime.scan).mockImplementation(async (options) => structuredClone(f.runtimeStatuses)
      .map((status) => options?.fresh ? { ...status, ...recheck } : status))
    const clients = await service.scanExternalClients()

    for (const tool of externalToolIds) {
      const client = clients.find((entry) => entry.tool === tool)
      expect(client).toMatchObject({ configurationSource: 'other', ...recheck })
      expect(client?.routePending).toBeUndefined()
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool))
      expect(routeLogs(f)).toContainEqual(['warn', 'config', 'external-client.route.failed', `${externalClientNames[tool]} 的连接线路这次没换成，下次检测再试`,
        { tool, from: 'primary', to: 'direct', reason: `${externalClientNames[tool]} 这次没认出来开没开，已保留原配置` }])
    }
  })

  it('writes nothing when the customer changes a client while the model list is being fetched', async () => {
    const f = fixture()
    const { files } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    // 三家按检测结果的顺序一家一家换，每家查一次模型清单：第几次查，就是第几家在那几秒里被客户改了。
    const edited = new Map<ExternalToolId, string>()
    const answer = f.relayFetch.getMockImplementation()!
    f.relayFetch.mockImplementation(async (...request) => {
      const tool = externalToolIds[edited.size]
      replaceKeyByHand(tool, files.get(tool)!)
      edited.set(tool, fs.readFileSync(files.get(tool)!, 'utf8'))
      return answer(...request)
    })
    const clients = await service.scanExternalClients()

    for (const tool of externalToolIds) {
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(edited.get(tool))
      expect(clients.find((entry) => entry.tool === tool)).toMatchObject({ configured: false, configurationSource: 'other' })
      expect(routeLogs(f)).toContainEqual(['warn', 'config', 'external-client.route.failed', expect.any(String),
        expect.objectContaining({ tool, from: 'primary', to: 'direct' })])
    }
    expect(routeLogs(f).map(([, , event]) => event)).not.toContain('external-client.route.followed')
  })

  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    ['another account signs in', (f) => f.setUser(18)],
    ['the user switches to the history account', (f) => f.setSite('solov-api')],
  ])('writes nothing when %s while the model list is being fetched', async (_case, change) => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    const answer = f.relayFetch.getMockImplementation()!
    f.relayFetch.mockClear().mockImplementation(async (...request) => {
      change(f)
      return answer(...request)
    })
    await service.scanExternalClients()

    for (const tool of externalToolIds) expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool))
    // 第一家查完清单就发现换了账号，不写；后面两家已经不是新账号的，连清单也不查。
    expect(f.relayFetch).toHaveBeenCalledTimes(1)
    expect(routeLogs(f)).toEqual([['warn', 'config', 'external-client.route.failed', expect.any(String),
      { tool: externalToolIds[0], from: 'primary', to: 'direct', reason: '账号已变化，这次不换线路' }]])
  })

  it('keeps what the customer changed inside the clients and moves only the addresses', async () => {
    const f = fixture()
    const { files } = await configureAll(f)
    // WorkBuddy 里星芒替这个账号存过两个型号，客户自己又加了一条别家的；Claude Desktop 里客户
    // 加了型号、换了认证方式；OpenCode 里客户加了一行注释。
    await f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: 'gpt-5.4' })
    const workbuddy = files.get('workbuddy')!
    fs.writeFileSync(workbuddy, `${JSON.stringify([...JSON.parse(fs.readFileSync(workbuddy, 'utf8')),
      { id: 'deepseek-chat', url: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-customer-own' }], null, 2)}\n`, 'utf8')
    const claude = files.get('claudeDesktop')!
    fs.writeFileSync(claude, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(claude, 'utf8')),
      inferenceModels: [selectedModel, 'claude-opus-4-1'], inferenceGatewayAuthScheme: 'x-api-key' }, null, 2)}\n`, 'utf8')
    const opencode = files.get('opencode')!
    fs.writeFileSync(opencode, `// 客户自己的注释\n${fs.readFileSync(opencode, 'utf8')}`, 'utf8')
    const before = new Map([...files].map(([tool, file]) => [tool, fs.readFileSync(file, 'utf8')]))
    const clients = await (await restartOn(f, 'direct')).scanExternalClients()

    for (const tool of externalToolIds) {
      expect(clients.find((entry) => entry.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool)!.replaceAll(primaryOrigin, directOrigin))
    }
    expect(JSON.parse(fs.readFileSync(workbuddy, 'utf8')).map((entry: { url: string }) => entry.url)).toEqual([
      `${directOrigin}/v1/chat/completions`, `${directOrigin}/v1/chat/completions`, 'https://api.deepseek.com/chat/completions',
    ])
  })

  it('moves Claude Desktop when it was left to fetch the model list by itself', async () => {
    const f = fixture()
    const { files } = await configureAll(f)
    // 客户在 Claude Desktop 里把型号清单清空了，由它自己到网关上取：新线路认这把 Key 就换。
    const claude = files.get('claudeDesktop')!
    const gateway = JSON.parse(fs.readFileSync(claude, 'utf8'))
    delete gateway.inferenceModels
    fs.writeFileSync(claude, `${JSON.stringify(gateway, null, 2)}\n`, 'utf8')
    const before = fs.readFileSync(claude, 'utf8')
    const client = (await (await restartOn(f, 'direct')).scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop')

    expect(client).toMatchObject({ configured: true, configurationSource: 'xingmang', model: null })
    expect(fs.readFileSync(claude, 'utf8')).toBe(before.replaceAll(primaryOrigin, directOrigin))
    expect(routeLogs(f)).toContainEqual(['info', 'config', 'external-client.route.followed', expect.any(String), { tool: 'claudeDesktop', from: 'primary', to: 'direct' }])
  })

  it('leaves Claude Desktop alone when the customer applied a copy of the profile', async () => {
    const f = fixture()
    const { files } = await configureAll(f)
    // 客户在 Claude Desktop 里把星芒那份复制了一份并切过去用：地址、Key 都一样，但那份不是星芒的。
    const profile = files.get('claudeDesktop')!
    const copyId = '00000000-0000-4000-8000-000000000001'
    const copy = path.join(path.dirname(profile), `${copyId}.json`)
    fs.copyFileSync(profile, copy)
    const metadataPath = path.join(path.dirname(profile), '_meta.json')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, appliedId: copyId, entries: [...metadata.entries, { id: copyId, name: '星芒 AI 副本' }] }), 'utf8')
    const before = [profile, copy, metadataPath].map((file) => fs.readFileSync(file, 'utf8'))
    const clients = await (await restartOn(f, 'direct')).scanExternalClients()

    expect(clients.find((entry) => entry.tool === 'claudeDesktop')).toMatchObject({ configured: false, configurationSource: 'other' })
    expect([profile, copy, metadataPath].map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before)
    expect(routeLogs(f).filter(([, , , , detail]) => (detail as { tool?: string } | undefined)?.tool === 'claudeDesktop')).toEqual([])
  })

  it.each([
    ['the user never selected a route', async (f: ReturnType<typeof fixture>) => f.restart()],
    ['another account is signed in', async (f: ReturnType<typeof fixture>) => {
      f.setUser(18)
      return restartOn(f, 'direct')
    }],
    ['the user replaced the key by hand', async (f: ReturnType<typeof fixture>, files: Map<ExternalToolId, string>) => {
      for (const [tool, file] of files) replaceKeyByHand(tool, file)
      return restartOn(f, 'direct')
    }],
  ])('leaves the clients alone when %s', async (_case, prepare) => {
    const f = fixture()
    const { files } = await configureAll(f)
    const service = await prepare(f, files)
    const snapshot = new Map([...files].map(([tool, file]) => [tool, fs.readFileSync(file, 'utf8')]))
    f.relayFetch.mockClear()
    const clients = await service.scanExternalClients()

    for (const [tool, file] of files) expect(fs.readFileSync(file, 'utf8')).toBe(snapshot.get(tool))
    expect(clients.some((client) => client.routePending)).toBe(false)
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(routeLogs(f)).toEqual([])
  })

  it('leaves the history account alone, which has only one route', async () => {
    const f = fixture({ site: 'solov-api' })
    const { files, before } = await configureAll(f)
    await f.store.update({ version: 2, relayEndpointIds: { solov: 'direct', 'solov-api': 'primary' } })
    f.relayFetch.mockClear()
    const clients = await f.restart().scanExternalClients()

    for (const tool of externalToolIds) {
      expect(clients.find((entry) => entry.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang' })
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool))
    }
    expect(f.relayFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['the new route cannot be reached', async () => { throw new TypeError('fetch failed') }],
    ['the model is no longer offered', async () => Response.json({ data: [{ id: 'gpt-5.4' }] })],
  ])('keeps the old route and tries again on the next check when %s', async (_case, unavailable: () => Promise<Response>) => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    const answer = f.relayFetch.getMockImplementation()!
    let broken = true
    f.relayFetch.mockImplementation(async (...request) => broken ? unavailable() : answer(...request))
    const failed = await service.scanExternalClients()

    for (const tool of externalToolIds) {
      expect(failed.find((entry) => entry.tool === tool)).toMatchObject({ configured: false, configurationSource: 'other' })
      expect(fs.readFileSync(files.get(tool)!, 'utf8')).toBe(before.get(tool))
      expect(routeLogs(f)).toContainEqual(['warn', 'config', 'external-client.route.failed', expect.any(String),
        expect.objectContaining({ tool, from: 'primary', to: 'direct' })])
    }
    broken = false
    const moved = await service.scanExternalClients()
    for (const tool of externalToolIds) {
      expect(moved.find((entry) => entry.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
    }
  })

  it('does not move a client back and forth when its old configuration comes back, and logs that once', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    await service.scanExternalClients()
    // 推测的情形：客户端退出时把它记着的旧配置写了回去。
    fs.writeFileSync(files.get('workbuddy')!, before.get('workbuddy')!, 'utf8')
    f.relayFetch.mockClear()
    for (let check = 0; check < 2; check++) {
      expect((await service.scanExternalClients()).find((client) => client.tool === 'workbuddy')).toMatchObject({ configured: false, configurationSource: 'other' })
    }

    expect(fs.readFileSync(files.get('workbuddy')!, 'utf8')).toBe(before.get('workbuddy'))
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(routeLogs(f).filter(([, , event]) => event === 'external-client.route.reverted')).toEqual([
      ['warn', 'config', 'external-client.route.reverted', expect.any(String), { tool: 'workbuddy', from: 'primary', to: 'direct' }],
    ])
  })

  // #1112（yoyo 10-20 放宽「两条线路都认」）：官方登录期间换线路那边不碰 Claude Desktop，切回当前账号时顺手换过来。
  async function officialThenRestartOnDirect(f: ReturnType<typeof fixture>) {
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const before = fs.readFileSync(saved.path, 'utf8')
    await f.service.switchExternalClientSource('claudeDesktop', 'official')
    const service = await restartOn(f, 'direct')
    expect((await service.scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop')).toMatchObject({ configured: false, officialAccount: true })
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(before)
    f.relayFetch.mockClear()
    return { service, profile: saved.path, before, desktopPath: path.join(f.claudeProfileDirectory, 'claude_desktop_config.json') }
  }

  it('switches Claude Desktop back from the official login onto the route selected meanwhile', async () => {
    const f = fixture()
    const { service, profile, before, desktopPath } = await officialThenRestartOnDirect(f)

    const back = await service.switchExternalClientSource('claudeDesktop', 'account')
    expect(back).toMatchObject({ tool: 'claudeDesktop', target: 'account', outcome: 'switched' })
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual({ deploymentMode: '3p' })
    // 只换了地址：Key、型号原样，改前那份留了备份；切换不联网，结果和日志里没有 Key、没有地址。
    expect(fs.readFileSync(profile, 'utf8')).toBe(before.replaceAll(primaryOrigin, directOrigin))
    expect(backupsOf(profile)).toContain(before)
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(f.runtimeLog.log).toHaveBeenCalledWith('info', 'config', 'external-client.source-switched', 'Claude Desktop 已改用当前账号',
      { target: 'account', outcome: 'switched', running: false, from: 'primary' })
    expect(JSON.stringify([back, f.runtimeLog.log.mock.calls])).not.toMatch(/sk-selected|solov\.cc/)

    // 归属跟着记到了当前线路：首页认它是当前账号，重开以后也认，换线路那边不再动它。
    expect((await service.scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop'))
      .toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
    expect((await (await restartOn(f, 'direct')).scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop'))
      .toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(routeLogs(f)).toEqual([])
  })

  it('asks to connect Claude Desktop again when the profile left on the old route is not the current account\'s', async () => {
    const f = fixture()
    const { service, profile, before, desktopPath } = await officialThenRestartOnDirect(f)
    f.setUser(18)

    await expect(service.switchExternalClientSource('claudeDesktop', 'account')).resolves.toEqual({ tool: 'claudeDesktop', target: 'account', outcome: 'reconnect' })
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual({ deploymentMode: '1p' })
    expect(fs.readFileSync(profile, 'utf8')).toBe(before)
  })

  it('records ownership on the next check when switching back moved the address but recording it failed', async () => {
    const f = fixture()
    const { service, profile, before } = await officialThenRestartOnDirect(f)
    const write = vi.spyOn(ExternalClientOwnershipStore.prototype, 'rewrite').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
    try {
      await expect(service.switchExternalClientSource('claudeDesktop', 'account')).resolves.toMatchObject({ outcome: 'switched' })
      expect(fs.readFileSync(profile, 'utf8')).toBe(before.replaceAll(primaryOrigin, directOrigin))
      expect(routeLogs(f)).toContainEqual(['warn', 'config', 'external-client.route.failed', 'Claude Desktop 已换到当前连接线路，归属没记上，下次检测补记',
        expect.objectContaining({ tool: 'claudeDesktop' })])

      const client = (await service.scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop')
      expect(client).toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
      expect(fs.readFileSync(profile, 'utf8')).toBe(before.replaceAll(primaryOrigin, directOrigin))
      expect(f.relayFetch).not.toHaveBeenCalled()
      expect(routeLogs(f)).toContainEqual(['info', 'config', 'external-client.route.recorded', expect.any(String), { tool: 'claudeDesktop', from: 'primary', to: 'direct' }])
    } finally {
      write.mockRestore()
    }
  })

  it('records ownership on the next check when the address was moved but recording it failed', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    const moved = before.get('workbuddy')!.replaceAll(primaryOrigin, directOrigin)
    // WorkBuddy 排第一个换：地址换好了，记归属那一步没写进去（换线路记归属照旧记着原来的来源，走 rewrite）。
    const write = vi.spyOn(ExternalClientOwnershipStore.prototype, 'rewrite').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
    try {
      const first = (await service.scanExternalClients()).find((client) => client.tool === 'workbuddy')
      expect(first).toMatchObject({ configured: false, configurationSource: 'other' })
      expect(fs.readFileSync(files.get('workbuddy')!, 'utf8')).toBe(moved)
      expect(routeLogs(f)).toContainEqual(['warn', 'config', 'external-client.route.failed', 'WorkBuddy 已换到当前连接线路，归属没记上，下次检测补记',
        expect.objectContaining({ tool: 'workbuddy', from: 'primary', to: 'direct' })])

      // 下次检测：地址已经在当前线路上，只补记归属，不再查清单、不再写客户端配置。
      f.relayFetch.mockClear()
      const second = (await service.scanExternalClients()).find((client) => client.tool === 'workbuddy')
      expect(second).toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
      expect(fs.readFileSync(files.get('workbuddy')!, 'utf8')).toBe(moved)
      expect(backupsOf(files.get('workbuddy')!)).toHaveLength(1)
      expect(f.relayFetch).not.toHaveBeenCalled()
      expect(routeLogs(f)).toContainEqual(['info', 'config', 'external-client.route.recorded', expect.any(String), { tool: 'workbuddy', from: 'primary', to: 'direct' }])
    } finally {
      write.mockRestore()
    }
  })
})

