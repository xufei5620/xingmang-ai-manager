import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore, defaultAppSettings } from './app-settings'
import { createSystemService, type SystemServiceOptions } from './system-service'
import { externalClientNames, externalToolIds, type ExternalClientRuntimeStatus } from './external-client-contract'
import { ExternalClientOwnershipStore } from './external-client-ownership'
import type { ExternalToolId } from './external-tool-config'

const temporaryDirectories: string[] = []
const selectedKey = 'sk-selected-external-client-key'
const selectedModel = 'claude-sonnet-4-6'
const hostPlatform = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

function fixture(options: { site?: 'solov' | 'solov-api'; platform?: NodeJS.Platform; nativeClaudePaths?: boolean; snapshotCache?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-client-service-'))
  temporaryDirectories.push(directory)
  const userHome = path.join(directory, 'user')
  const managerDataDirectory = path.join(directory, 'manager')
  const claudeProfileDirectory = path.join(userHome, 'claude-profile')
  let site: string = options.site ?? 'solov'
  let userId: number | null = 17
  const assertClaudeDesktopUnmanaged = vi.fn(async () => undefined)
  const inspectClaudeDesktopStoreVirtualization = vi.fn<NonNullable<SystemServiceOptions['inspectClaudeDesktopStoreVirtualization']>>(async () => ({
    localProfileVirtualized: true, roamingProfileVirtualized: true, roamingDeveloperVirtualized: true,
  }))
  // Claude Desktop 的自检照它网关的启动检查发 /v1/messages（connection-check.ts 的
  // gatewayMessagesShape），其余请求都是查模型清单。
  const relayFetch = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/v1/messages')
    ? Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: selectedModel,
      content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' })
    : Response.json({ data: [{ id: selectedModel }, { id: 'gpt-5.4' }] }))
  const store = new AppSettingsStore(path.join(directory, 'settings.json'), userHome)
  const runtimeStatuses: ExternalClientRuntimeStatus[] = (['workbuddy', 'claudeDesktop', 'opencode'] as const).map((tool) => ({
    tool, installed: tool === 'claudeDesktop', version: tool === 'claudeDesktop' ? '2.2553.1.0' : null,
    path: tool === 'claudeDesktop' ? path.join(directory, 'Claude', 'Claude.exe') : null,
    installDirectory: tool === 'claudeDesktop' ? path.join(directory, 'Claude') : null, running: false,
    installSupported: true, launchSupported: tool === 'claudeDesktop', detectionError: null, installHint: null,
  }))
  const runtime: NonNullable<SystemServiceOptions['externalClientRuntime']> = {
    scan: vi.fn(async () => structuredClone(runtimeStatuses)),
    install: vi.fn(async (tool, onProgress) => {
      onProgress?.({ tool, phase: 'installing', message: '正在安装', percent: null })
      return { ...runtimeStatuses.find((status) => status.tool === tool)!, installed: true, launchSupported: true, version: '1.2.3' }
    }),
    cancelInstall: vi.fn(() => ({ cancelled: false, reason: '这个工具当前没有正在进行的安装。' })),
    launch: vi.fn(async () => undefined),
    stillRunning: vi.fn(async (tool: ExternalToolId) => runtimeStatuses.find((status) => status.tool === tool)?.running ?? null),
  }
  // 外部客户端换线路的定时复查（C11）只记下来，由用例自己拨。
  const routeTimers: { callback: () => void; delayMs: number }[] = []
  const routeClock = { now: 1_000_000_000_000 }
  const routeFollowed = vi.fn()
  const runtimeLog = { log: vi.fn<NonNullable<SystemServiceOptions['runtimeLog']>['log']>() }
  const serviceOptions: SystemServiceOptions = {
    providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
    managerDataDirectory, relayFetch, getRelaySiteId: () => site, platform: options.platform ?? hostPlatform,
    getExternalClientAccountId: () => userId === null ? null : JSON.stringify([site, userId]),
    claudeDesktopEnv: options.nativeClaudePaths ? {} : { CLAUDE_USER_DATA_DIR: claudeProfileDirectory },
    assertClaudeDesktopUnmanaged,
    inspectClaudeDesktopStoreVirtualization,
    externalClientRuntime: runtime,
    runtimeLog,
    scheduleToolRoute: (callback, delayMs) => {
      const timer = { callback, delayMs }
      routeTimers.push(timer)
      return () => { if (routeTimers.includes(timer)) routeTimers.splice(routeTimers.indexOf(timer), 1) }
    },
    toolRouteNow: () => routeClock.now,
    onToolRouteFollowed: routeFollowed,
    ...(options.snapshotCache ? { externalClientSnapshotCacheFile: path.join(managerDataDirectory, 'external-client-snapshot.json') } : {}),
  }
  return {
    directory, userHome, managerDataDirectory, claudeProfileDirectory, store, relayFetch, assertClaudeDesktopUnmanaged, inspectClaudeDesktopStoreVirtualization, runtime, runtimeStatuses, runtimeLog,
    routeTimers, routeClock, routeFollowed,
    service: createSystemService(store, serviceOptions),
    restart: () => createSystemService(store, serviceOptions),
    setSite(next: string) { site = next },
    setUser(next: number | null) { userId = next },
  }
}

function targetFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const entry = path.join(directory, item.name)
    return item.isDirectory() ? targetFiles(entry) : [entry]
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('external client system-service integration', () => {
  it.each(['workbuddy', 'opencode', 'claudeDesktop'] as const)('binds %s ownership to the current account across switching, logout and restart', async (tool) => {
    const f = fixture()
    const result = await f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel })
    const snapshots = new Map(targetFiles(f.directory).map(file => [file, fs.readFileSync(file, 'utf8')]))
    const read = async () => {
      const status = (await f.service.scanExternalClients()).find(status => status.tool === tool)
      if (tool === 'claudeDesktop') expect(status?.configurationReady).toBe(true)
      return status
    }
    expect(await read()).toMatchObject({ configured: true, configurationSource: 'xingmang' })
    f.setUser(18)
    expect(await read()).toMatchObject({ configured: false, configurationSource: 'other', model: selectedModel })
    f.setUser(null)
    expect(await read()).toMatchObject({ configured: false, configurationSource: 'other' })
    f.setUser(17)
    expect(await read()).toMatchObject({ configured: true, configurationSource: 'xingmang' })
    f.setSite('solov-api')
    expect(await read()).toMatchObject({ configured: false, configurationSource: 'other' })
    f.setSite('solov')
    const restarted = await f.restart().scanExternalClients()
    expect(restarted.find(status => status.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang' })
    expect(JSON.stringify(restarted)).not.toContain(selectedKey)
    expect(JSON.stringify(result)).not.toContain(selectedKey)
    expect(targetFiles(f.directory)).toEqual([...snapshots.keys()])
    for (const [file, content] of snapshots) expect(fs.readFileSync(file, 'utf8')).toBe(content)
    // The model check during the write, then the post-save self-check reading
    // the key back off disk -- and only where the client is actually installed
    // (the fixture installs Claude Desktop alone), because the check stops at
    // 「还没有检测到」 before it would send anything. Every status read after
    // that is local.
    expect(f.relayFetch).toHaveBeenCalledTimes(tool === 'claudeDesktop' ? 2 : 1)
  })

  it.each(['workbuddy', 'opencode', 'claudeDesktop'] as const)('does not claim unowned or externally replaced %s credentials for the current account', async (tool) => {
    const f = fixture()
    f.setUser(null)
    const result = await f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel })
    f.setUser(17)
    const read = async () => (await f.service.scanExternalClients()).find(status => status.tool === tool)
    expect(await read()).toMatchObject({ configured: false, configurationSource: 'other' })
    await f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel })
    expect(await read()).toMatchObject({ configured: true })
    const config = JSON.parse(fs.readFileSync(result.path, 'utf8'))
    if (tool === 'claudeDesktop') config.inferenceGatewayApiKey = 'sk-replaced-key'
    else if (tool === 'workbuddy') config[0].apiKey = 'sk-replaced-key'
    else config.provider.xingmang.options.apiKey = 'sk-replaced-key'
    fs.writeFileSync(result.path, JSON.stringify(config), 'utf8')
    expect(await read()).toMatchObject({ configured: false, configurationSource: 'other' })
  })

  it('checks all WorkBuddy models for a current-account key without adopting an earlier account model', async () => {
    const f = fixture()
    await f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel })
    f.setUser(18)
    await f.service.configureExternalTool('workbuddy', { apiKey: 'sk-second-account', model: 'gpt-5.4' })
    const read = async () => (await f.service.scanExternalClients()).find(status => status.tool === 'workbuddy')
    expect(await read()).toMatchObject({ configured: true, model: 'gpt-5.4' })
    f.setUser(17)
    expect(await read()).toMatchObject({ configured: true, model: selectedModel })
    f.setUser(19)
    expect(await read()).toMatchObject({ configured: false, configurationSource: 'other' })
  })

  it('does not associate a saved configuration after switching users during model validation', async () => {
    const f = fixture()
    f.relayFetch.mockImplementationOnce(async () => {
      f.setUser(18)
      return Response.json({ data: [{ id: selectedModel }] })
    })
    await expect(f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('账号已变化')
    expect(targetFiles(f.directory)).toEqual([])
  })

  it('does not return current-account readiness if the account changes while inspecting Claude local configuration', async () => {
    const f = fixture()
    await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    f.assertClaudeDesktopUnmanaged.mockImplementationOnce(async () => {
      f.setUser(18)
    })
    expect((await f.service.scanExternalClients()).find(status => status.tool === 'claudeDesktop')).toMatchObject({ configured: false, configurationSource: 'other' })
  })

  it('combines runtime detection with real local configuration and the active site without disclosing credentials', async () => {
    const f = fixture()
    await f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: selectedModel })
    const statuses = await f.service.scanExternalClients()
    // Twice: the post-save self-check has no cached runtime snapshot to reuse
    // here (nothing scanned before the save), so it takes one of its own.
    expect(f.runtime.scan).toHaveBeenCalledTimes(2)
    expect(statuses.find((status) => status.tool === 'opencode')).toMatchObject({ installed: false, configured: true, model: selectedModel, configurationSource: 'xingmang' })
    expect(statuses.find((status) => status.tool === 'workbuddy')).toMatchObject({ configured: false, configurationSource: 'missing' })
    expect(JSON.stringify(statuses)).not.toContain(selectedKey)
    f.setSite('solov-api')
    expect((await f.service.scanExternalClients()).find((status) => status.tool === 'opencode')).toMatchObject({ configured: false, configurationSource: 'other' })
    // Status reads never call the remote model endpoint.
    expect(f.relayFetch).toHaveBeenCalledOnce()
  })

  it('self-checks an installed client with the key read back off its own config file', async () => {
    const f = fixture()
    await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    f.relayFetch.mockClear()
    const result = await f.service.checkExternalClientConnection('claudeDesktop')

    expect(result).toMatchObject({ tool: 'claudeDesktop', siteId: 'solov', installed: true, ok: true, model: selectedModel })
    expect(f.relayFetch).toHaveBeenCalledExactlyOnceWith('https://xm.solov.cc/v1/messages', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ authorization: `Bearer ${selectedKey}` }),
    }))
    // 报告与界面都会拿到这份结论，里面不许出现那把密钥（I3）。
    expect(JSON.stringify(result)).not.toContain(selectedKey)
  })

  it('does not send a key the current account did not write, and says so', async () => {
    const f = fixture()
    await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    f.setUser(18)
    f.relayFetch.mockClear()
    const result = await f.service.checkExternalClientConnection('claudeDesktop')

    expect(result).toMatchObject({ ok: false, layer: 'config', installed: true, endpoint: null })
    expect(f.relayFetch).not.toHaveBeenCalled()
  })

  it('calls a client nobody installed 未配置 instead of a failure, and sends nothing', async () => {
    const f = fixture()
    await f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: selectedModel })
    f.relayFetch.mockClear()
    const result = await f.service.checkExternalClientConnection('opencode')

    expect(result).toMatchObject({ tool: 'opencode', installed: false, ok: false, layer: 'unconfigured' })
    expect(f.relayFetch).not.toHaveBeenCalled()
  })

  it('reuses a runtime snapshot the caller already has instead of scanning again', async () => {
    const f = fixture()
    const known = (await f.service.scanExternalClients()).find((status) => status.tool === 'claudeDesktop')!
    vi.mocked(f.runtime.scan).mockClear()
    await f.service.checkExternalClientConnection('claudeDesktop', known)

    expect(f.runtime.scan).not.toHaveBeenCalled()
  })

  it('feeds the feedback report from the last detection rather than probing again', async () => {
    const f = fixture()
    expect(f.service.getLastExternalClients()).toBeNull()
    await f.service.scanExternalClients()
    vi.mocked(f.runtime.scan).mockClear()

    expect(f.service.getLastExternalClients()).toMatchObject([
      { tool: 'workbuddy', installed: false },
      { tool: 'claudeDesktop', installed: true },
      { tool: 'opencode', installed: false },
    ])
    expect(f.runtime.scan).not.toHaveBeenCalled()
    expect(JSON.stringify(f.service.getLastExternalClients())).not.toContain(selectedKey)
  })

  it('shows the next start the last whole detection until that start has scanned, never as running and without the key', async () => {
    const f = fixture({ snapshotCache: true })
    const cacheFile = path.join(f.managerDataDirectory, 'external-client-snapshot.json')
    await expect(f.service.cachedExternalClients()).resolves.toEqual([])
    await f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel })
    f.runtimeStatuses[1].running = true
    f.runtimeStatuses[1].version = '2.2600.0.0'
    const scanned = await f.service.scanExternalClients()
    expect(scanned[1]).toMatchObject({ tool: 'claudeDesktop', running: true })
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).toContain('2.2600.0.0'))
    expect(fs.readFileSync(cacheFile, 'utf8')).not.toContain(selectedKey)
    // This launch already has its own answer.
    await expect(f.service.cachedExternalClients()).resolves.toEqual([])

    const restarted = f.restart()
    vi.mocked(f.runtime.scan).mockClear()
    f.relayFetch.mockClear()
    const cached = await restarted.cachedExternalClients()
    expect(cached).toEqual(scanned.map((status) => ({ ...status, running: false, cachedAt: expect.any(String) })))
    expect(cached[0]).toMatchObject({ tool: 'workbuddy', configured: true, configurationSource: 'xingmang', model: selectedModel })
    // Reading it probes nothing and asks the relay nothing.
    expect(f.runtime.scan).not.toHaveBeenCalled()
    expect(f.relayFetch).not.toHaveBeenCalled()
    // The feedback report still says it has not detected anything this launch.
    expect(restarted.getLastExternalClients()).toBeNull()

    f.runtimeStatuses[1].version = '2.2700.0.0'
    const fresh = await restarted.scanExternalClients()
    expect(fresh.every((status) => status.cachedAt === undefined)).toBe(true)
    await expect(restarted.cachedExternalClients()).resolves.toEqual([])
    // scanExternalClients 不等落盘就返回；等这次改名到位再收尾，免得删目录时撞上临时文件。
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).toContain('2.2700.0.0'))
    expect(f.runtimeLog.log.mock.calls.map((call) => call[2])).not.toContain('external-client-cache-write-failed')
    expect(f.runtimeLog.log.mock.calls.map((call) => call[2])).not.toContain('external-client-cache-read-failed')
  })

  it('keeps no last detection when it is given no file for it', async () => {
    const f = fixture()
    await f.service.scanExternalClients()
    await expect(f.restart().cachedExternalClients()).resolves.toEqual([])
    expect(fs.existsSync(path.join(f.managerDataDirectory, 'external-client-snapshot.json'))).toBe(false)
  })

  it('keeps a failed management check separate from an installed runtime', async () => {
    const f = fixture()
    f.assertClaudeDesktopUnmanaged.mockRejectedValueOnce(new Error(`private policy value ${selectedKey}`))
    const statuses = await f.service.scanExternalClients()
    expect(statuses[1]).toMatchObject({ installed: true, launchSupported: true, detectionError: null, configured: false, configurationSource: 'unknown' })
    expect(statuses[1].configurationError).toBeTruthy()
    expect(JSON.stringify(statuses)).not.toContain(selectedKey)
    expect(f.relayFetch).not.toHaveBeenCalled()
  })

  it('forwards install progress to its caller and reads configuration only after the native install completes', async () => {
    const f = fixture()
    const target = { isDestroyed: () => false, send: vi.fn() }
    const result = await f.service.installExternalClient('workbuddy', target)
    expect(f.runtime.install).toHaveBeenCalledWith('workbuddy', expect.any(Function))
    expect(target.send).toHaveBeenCalledWith('external-clients:install-progress', { tool: 'workbuddy', phase: 'installing', message: '正在安装', percent: null })
    expect(result).toMatchObject({ installed: true, version: '1.2.3', configured: false, configurationSource: 'missing' })
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(f.assertClaudeDesktopUnmanaged).not.toHaveBeenCalled()
    expect(targetFiles(f.directory)).toEqual([])
  })

  it.each(['destroyed', 'send-failed'] as const)('finishes installation when the initiating renderer is %s', async (state) => {
    const f = fixture()
    const target = { isDestroyed: () => state === 'destroyed', send: vi.fn(() => { throw new Error('renderer closed') }) }
    await expect(f.service.installExternalClient('opencode', target)).resolves.toMatchObject({ installed: true })
    if (state === 'destroyed') expect(target.send).not.toHaveBeenCalled()
    else expect(target.send).toHaveBeenCalledOnce()
  })

  it('propagates native installation failure without claiming completion', async () => {
    const f = fixture()
    vi.mocked(f.runtime.install).mockRejectedValueOnce(new Error('安装后未检测到客户端'))
    await expect(f.service.installExternalClient('opencode', { isDestroyed: () => false, send: vi.fn() })).rejects.toThrow('安装后未检测到')
    expect(f.assertClaudeDesktopUnmanaged).not.toHaveBeenCalled()
    expect(f.relayFetch).not.toHaveBeenCalled()
  })

  it.each(['workbuddy', 'claudeDesktop', 'opencode'] as const)('launches %s through its runtime without changing credentials', async (tool) => {
    const f = fixture()
    await f.service.launchExternalClient(tool)
    expect(f.runtime.launch).toHaveBeenCalledExactlyOnceWith(tool)
    expect(f.runtime.install).not.toHaveBeenCalled()
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(targetFiles(f.directory)).toEqual([])
  })

  it.each([
    ['workbuddy', 'solov', 'https://xm.solov.cc'],
    ['opencode', 'solov', 'https://xm.solov.cc'],
    ['workbuddy', 'solov-api', 'https://api.solov.cc'],
    ['opencode', 'solov-api', 'https://api.solov.cc'],
  ] as const)('writes the selected key/model for %s on %s and ignores caller-supplied endpoints', async (tool, site, origin) => {
    const f = fixture({ site })
    const result = await f.service.configureExternalTool(tool, {
      apiKey: `  ${selectedKey}  `, model: `  ${selectedModel}  `, baseUrl: 'https://attacker.invalid/v1',
    })
    expect(f.relayFetch).toHaveBeenCalledWith(`${origin}/v1/models`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${selectedKey}` }), credentials: 'omit', redirect: 'error',
    }))
    const saved = JSON.parse(fs.readFileSync(result.path, 'utf8'))
    if (tool === 'workbuddy') {
      expect(result.path).toBe(path.join(f.userHome, '.workbuddy', 'models.json'))
      expect(Array.isArray(saved)).toBe(true)
      expect(saved).toContainEqual(expect.objectContaining({ id: selectedModel, vendor: 'Custom', apiKey: selectedKey, url: `${origin}/v1/chat/completions`, supportsToolCall: true, useCustomProtocol: false }))
    } else {
      expect(result.path).toBe(path.join(f.userHome, '.config', 'opencode', 'opencode.json'))
      expect(saved).toMatchObject({ model: `xingmang/${selectedModel}`, provider: { xingmang: {
        npm: '@ai-sdk/openai', options: { apiKey: selectedKey, baseURL: `${origin}/v1` }, models: { [selectedModel]: { name: selectedModel } },
      } } })
    }
    expect(result).toMatchObject({ tool, model: selectedModel, outcome: 'configured', connectionVerified: false })
    expect(JSON.stringify(result)).not.toContain(selectedKey)
    expect(fs.readFileSync(result.path, 'utf8')).not.toContain('attacker.invalid')
    expect(f.assertClaudeDesktopUnmanaged).not.toHaveBeenCalled()
  })

  it('uses the active account site instead of a stale settings preference', async () => {
    const f = fixture({ site: 'solov-api' })
    await f.store.write({ ...defaultAppSettings(f.userHome), relaySiteId: 'solov' })
    const result = await f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: selectedModel })
    expect(f.relayFetch.mock.calls[0][0]).toBe('https://api.solov.cc/v1/models')
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8')).provider.xingmang.options.baseURL).toBe('https://api.solov.cc/v1')
  })

  it('ignores old CodeBuddy settings and configures the real WorkBuddy Desktop array with a recoverable backup', async () => {
    const f = fixture()
    const legacyPath = path.join(f.userHome, '.codebuddy', 'models.json')
    const legacy = JSON.stringify([{ id: 'legacy-only', apiKey: selectedKey, url: 'https://xm.solov.cc/v1/chat/completions' }])
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, legacy, 'utf8')
    expect((await f.service.scanExternalClients()).find((status) => status.tool === 'workbuddy')).toMatchObject({
      configured: false, model: null, configurationSource: 'missing', configurationError: null,
    })
    expect(f.relayFetch).not.toHaveBeenCalled()
    const desktopPath = path.join(f.userHome, '.workbuddy', 'models.json')
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true })
    fs.writeFileSync(desktopPath, '[]\n', 'utf8')
    const result = await f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel })
    expect(result.path).toBe(desktopPath)
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(result.backups[0], 'utf8')).toBe('[]\n')
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual([{
      id: selectedModel, name: selectedModel, vendor: 'Custom', apiKey: selectedKey,
      url: 'https://xm.solov.cc/v1/chat/completions', supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
    }])
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacy)
    expect(fs.readdirSync(path.dirname(legacyPath))).toEqual(['models.json'])
    const statuses = await f.service.scanExternalClients()
    expect(statuses.find((status) => status.tool === 'workbuddy')).toMatchObject({ configured: true, model: selectedModel, configurationSource: 'xingmang', configurationError: null })
    expect(JSON.stringify(statuses)).not.toContain(selectedKey)
    expect(JSON.stringify(result)).not.toContain(selectedKey)
    expect(result.connectionVerified).toBe(false)
    expect(f.relayFetch).toHaveBeenCalledOnce()
  })

  it.each(['array', 'object'] as const)('preserves existing WorkBuddy Desktop model capabilities in a %s config', async (format) => {
    const f = fixture()
    const target = path.join(f.userHome, '.workbuddy', 'models.json')
    const keep = { id: 'keep', vendor: 'Other', apiKey: 'sk-keep-test', url: 'https://other.example/v1/chat/completions' }
    const selected = { id: selectedModel, name: 'My desktop label', vendor: 'Custom vendor', apiKey: 'sk-old-test',
      supportsToolCall: false, supportsImages: true, supportsReasoning: true, useCustomProtocol: true,
      reasoning: { budget: 1800 }, maxOutputTokens: 9000, custom: { preserve: true } }
    const original = JSON.stringify(format === 'array' ? [keep, selected]
      : { models: [keep, selected], availableModels: ['keep'], customRoot: 'preserve' })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, original, 'utf8')
    const result = await f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel })
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(Array.isArray(saved)).toBe(format === 'array')
    expect(format === 'array' ? saved : saved.models).toEqual([keep, {
      ...selected, apiKey: selectedKey, url: 'https://xm.solov.cc/v1/chat/completions',
    }])
    if (format === 'object') {
      expect(saved.availableModels).toEqual(['keep', selectedModel])
      expect(saved.customRoot).toBe('preserve')
    }
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(result.backups[0], 'utf8')).toBe(original)
    expect((await f.service.scanExternalClients()).find((status) => status.tool === 'workbuddy')).toMatchObject({
      configured: true, model: selectedModel, configurationSource: 'xingmang', configurationError: null,
    })
  })

  it('uses Responses by default for OpenCode and honors an explicit Chat Completions selection', async () => {
    const f = fixture()
    const first = await f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: 'gpt-5.4' })
    expect(JSON.parse(fs.readFileSync(first.path, 'utf8')).provider.xingmang.npm).toBe('@ai-sdk/openai')
    const second = await f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: 'gpt-5.4', protocol: 'chat-completions' })
    const saved = JSON.parse(fs.readFileSync(second.path, 'utf8'))
    expect(saved.provider.xingmang.models['gpt-5.4'].provider.npm).toBe('@ai-sdk/openai-compatible')
    expect(second.backups).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(second.backups[0], 'utf8')).provider.xingmang.npm).toBe('@ai-sdk/openai')
  })

  it.each(['workbuddy', 'opencode', 'claudeDesktop'] as const)('rejects an unauthorized %s model without writing configuration', async (tool) => {
    const f = fixture()
    await expect(f.service.configureExternalTool(tool, { apiKey: selectedKey, model: 'not-authorized-model' })).rejects.toThrow('不支持所选模型')
    expect(targetFiles(f.directory)).toEqual([])
    expect(f.assertClaudeDesktopUnmanaged).not.toHaveBeenCalled()
  })

  it('revalidates model permission after a previous model query instead of using the cache', async () => {
    const f = fixture()
    await f.service.fetchAvailableModels(selectedKey)
    f.relayFetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'different-model' }] }))
    await expect(f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('不支持所选模型')
    expect(f.relayFetch).toHaveBeenCalledTimes(2)
    expect(targetFiles(f.directory)).toEqual([])
  })

  it.each(['workbuddy', 'opencode', 'claudeDesktop'] as const)('checks the account revision after network validation for %s', async (tool) => {
    const f = fixture()
    let revision = 1
    const assertOwner = vi.fn(() => { if (revision !== 1) throw new Error('账号已切换') })
    f.relayFetch.mockImplementationOnce(async () => {
      revision++
      return Response.json({ data: [{ id: selectedModel }] })
    })
    await expect(f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel }, assertOwner)).rejects.toThrow('账号已切换')
    expect(assertOwner).toHaveBeenCalledTimes(2)
    expect(targetFiles(f.directory)).toEqual([])
    expect(f.assertClaudeDesktopUnmanaged).not.toHaveBeenCalled()
  })

  it.each(['workbuddy', 'opencode', 'claudeDesktop'] as const)('refuses writing %s when the account site changes during model lookup', async (tool) => {
    const f = fixture()
    f.relayFetch.mockImplementationOnce(async () => {
      f.setSite('solov-api')
      return Response.json({ data: [{ id: selectedModel }] })
    })
    await expect(f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('账号已变化')
    expect(f.relayFetch.mock.calls[0][0]).toBe('https://xm.solov.cc/v1/models')
    expect(targetFiles(f.directory)).toEqual([])
    expect(f.assertClaudeDesktopUnmanaged).not.toHaveBeenCalled()
  })

  it.each(['workbuddy', 'opencode'] as const)('rechecks ownership at %s transaction commit and keeps the original file intact', async (tool) => {
    const f = fixture()
    const target = tool === 'workbuddy' ? path.join(f.userHome, '.workbuddy', 'models.json') : path.join(f.userHome, '.config', 'opencode', 'opencode.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const original = '{"unrelated":"preserve"}\n'
    fs.writeFileSync(target, original, 'utf8')
    const assertOwner = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => undefined)
      .mockImplementation(() => { throw new Error('账号已切换') })
    await expect(f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel }, assertOwner)).rejects.toThrow('账号已切换')
    expect(assertOwner).toHaveBeenCalledTimes(3)
    expect(fs.readFileSync(target, 'utf8')).toBe(original)
    expect(targetFiles(f.directory).some((file) => file.endsWith('.tmp'))).toBe(false)
    for (const file of targetFiles(f.directory)) expect(fs.readFileSync(file, 'utf8')).not.toContain(selectedKey)
  })

  it('writes and activates a Claude local gateway with a fixed site and a secret-free result', async () => {
    const f = fixture({ site: 'solov-api' })
    const desktopPath = path.join(f.claudeProfileDirectory, 'claude_desktop_config.json')
    const original = '{"preferences":{"theme":"dark"}}\n'
    fs.mkdirSync(f.claudeProfileDirectory, { recursive: true })
    fs.writeFileSync(desktopPath, original, 'utf8')
    const result = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel, baseUrl: 'https://attacker.invalid' })
    expect(path.dirname(result.path)).toBe(path.join(f.claudeProfileDirectory, 'configLibrary'))
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8'))).toEqual({
      inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://api.solov.cc', inferenceGatewayApiKey: selectedKey,
      inferenceGatewayAuthScheme: 'bearer', inferenceCredentialKind: 'static', inferenceModels: [selectedModel],
    })
    const id = path.basename(result.path, '.json')
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(result.path), '_meta.json'), 'utf8'))).toEqual({
      appliedId: id, entries: [{ id, name: '星芒 AI' }],
    })
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual({ preferences: { theme: 'dark' }, deploymentMode: '3p' })
    expect(JSON.parse(fs.readFileSync(path.join(f.claudeProfileDirectory, 'developer_settings.json'), 'utf8'))).toEqual({ allowDevTools: true })
    expect(result).toMatchObject({ tool: 'claudeDesktop', model: selectedModel, outcome: 'configured', restartRequired: true, connectionVerified: true })
    expect(result.connection).toMatchObject({ tool: 'claudeDesktop', ok: true, installed: true, model: selectedModel })
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(result.backups[0], 'utf8')).toBe(original)
    expect(JSON.stringify(result)).not.toContain(selectedKey)
    expect(f.relayFetch).toHaveBeenCalledWith('https://api.solov.cc/v1/models', expect.any(Object))
    // 保存后的复测照 Claude Desktop 网关的启动检查，打的是同一站点的 /v1/messages。
    expect(f.relayFetch).toHaveBeenCalledWith('https://api.solov.cc/v1/messages', expect.objectContaining({ method: 'POST' }))
    expect((await f.service.scanExternalClients()).find(status => status.tool === 'claudeDesktop')).toMatchObject({
      installed: true, configured: true, configurationSource: 'xingmang', model: selectedModel,
    })
  })

  it('blocks Claude local configuration when a managed policy is present', async () => {
    const f = fixture()
    f.assertClaudeDesktopUnmanaged.mockRejectedValueOnce(new Error('Claude Desktop 已受管理策略控制'))
    await expect(f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('管理策略')
    expect(f.assertClaudeDesktopUnmanaged).toHaveBeenCalledOnce()
    expect(targetFiles(f.directory)).toEqual([])
  })

  it('rechecks the account after the asynchronous Claude management inspection', async () => {
    const f = fixture()
    let revision = 1
    const assertOwner = () => { if (revision !== 1) throw new Error('账号已切换') }
    f.assertClaudeDesktopUnmanaged.mockImplementationOnce(async () => {
      revision++
    })
    await expect(f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel }, assertOwner)).rejects.toThrow('账号已切换')
    expect(f.assertClaudeDesktopUnmanaged).toHaveBeenCalledOnce()
    expect(targetFiles(f.directory)).toEqual([])
  })

  it('keeps all Claude configuration files intact if ownership changes before the local transaction', async () => {
    const f = fixture()
    await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const snapshots = new Map(targetFiles(f.directory).map(file => [file, fs.readFileSync(file, 'utf8')]))
    f.assertClaudeDesktopUnmanaged.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { f.setUser(18) })
    await expect(f.service.configureExternalTool('claudeDesktop', { apiKey: 'sk-replacement-local-key', model: selectedModel })).rejects.toThrow('账号已切换')
    expect(targetFiles(f.directory)).toEqual([...snapshots.keys()])
    for (const [file, content] of snapshots) expect(fs.readFileSync(file, 'utf8')).toBe(content)
  })

  it('writes only the selected model for Claude Desktop even when the key lists more Claude models', async () => {
    const f = fixture()
    f.relayFetch.mockImplementationOnce(async () => Response.json({
      data: [{ id: 'claude-opus-5-5' }, { id: selectedModel }, { id: 'gpt-5.4' }, { id: 'claude-fable-5' }],
    }))
    const result = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8')).inferenceModels).toEqual([selectedModel])
    expect(result.model).toBe(selectedModel)
  })

  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    it.runIf(hostPlatform === platform)(`activates Claude in its native ${platform} local profile without an import step`, async () => {
      const f = fixture({ platform, nativeClaudePaths: true })
      const profileDirectory = platform === 'win32' ? path.join(f.userHome, 'AppData', 'Local', 'Claude-3p')
        : platform === 'darwin' ? path.join(f.userHome, 'Library', 'Application Support', 'Claude-3p')
          : path.join(f.userHome, '.config', 'Claude-3p')
      const developerDirectory = platform === 'win32' ? path.join(f.userHome, 'AppData', 'Roaming', 'Claude')
        : path.join(path.dirname(profileDirectory), 'Claude')
      const result = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
      expect(result).toMatchObject({ tool: 'claudeDesktop', outcome: 'configured', restartRequired: true, connectionVerified: true })
      expect(path.dirname(result.path)).toBe(path.join(profileDirectory, 'configLibrary'))
      expect(JSON.parse(fs.readFileSync(result.path, 'utf8'))).toMatchObject({
        inferenceGatewayApiKey: selectedKey, inferenceGatewayBaseUrl: 'https://xm.solov.cc', inferenceModels: [selectedModel],
      })
      expect(JSON.parse(fs.readFileSync(path.join(developerDirectory, 'developer_settings.json'), 'utf8'))).toEqual({ allowDevTools: true })
      expect(JSON.stringify(result)).not.toContain(selectedKey)
      expect((await f.service.scanExternalClients()).find(status => status.tool === 'claudeDesktop')).toMatchObject({
        configured: true, configurationSource: 'xingmang', model: selectedModel,
      })
    })
  }

  it.runIf(hostPlatform === 'win32').each([true, false])('writes and detects the active Windows Store Claude profile with virtualization %s', async (localProfileVirtualized) => {
    const f = fixture({ platform: 'win32', nativeClaudePaths: true })
    f.runtimeStatuses[1].path = path.join(f.directory, 'WindowsApps', 'Claude_2.2553.1.0_x64__pzs8sxrjxfjjc', 'app', 'Claude.exe')
    f.inspectClaudeDesktopStoreVirtualization.mockResolvedValue({ localProfileVirtualized, roamingProfileVirtualized: true, roamingDeveloperVirtualized: true })
    const localCache = path.join(f.userHome, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache')
    const profileDirectory = localProfileVirtualized ? path.join(localCache, 'Local', 'Claude-3p') : path.join(f.userHome, 'AppData', 'Local', 'Claude-3p')
    const result = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    expect(path.dirname(result.path)).toBe(path.join(profileDirectory, 'configLibrary'))
    expect(JSON.parse(fs.readFileSync(path.join(localCache, 'Roaming', 'Claude', 'developer_settings.json'), 'utf8'))).toEqual({ allowDevTools: true })
    expect(fs.existsSync(path.join(f.userHome, 'AppData', 'Local', 'Claude-3p'))).toBe(!localProfileVirtualized)
    expect((await f.service.scanExternalClients()).find(status => status.tool === 'claudeDesktop')).toMatchObject({
      installed: true, configured: true, configurationSource: 'xingmang', model: selectedModel,
    })
  })

  it('refuses to save when the Store manifest cannot be inspected', async () => {
    const f = fixture({ nativeClaudePaths: true })
    f.inspectClaudeDesktopStoreVirtualization.mockRejectedValue(new Error('安装包清单无法安全读取'))
    await expect(f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('清单无法安全读取')
    expect(targetFiles(f.directory)).toEqual([])
    expect((await f.service.scanExternalClients()).find(status => status.tool === 'claudeDesktop')).toMatchObject({
      configured: false, configurationSource: 'unknown',
    })
  })

  it('checks account ownership again after the asynchronous manifest inspection', async () => {
    const f = fixture({ nativeClaudePaths: true })
    f.inspectClaudeDesktopStoreVirtualization.mockImplementationOnce(async () => { f.setUser(18); return undefined })
    await expect(f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('账号已变化')
    expect(targetFiles(f.directory)).toEqual([])
  })

  it('refuses to create a Claude profile when the client is not installed', async () => {
    const f = fixture()
    Object.assign(f.runtimeStatuses[1], { installed: false, version: null, path: null, installDirectory: null, launchSupported: false })
    await expect(f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('请先安装 Claude Desktop')
    expect(f.assertClaudeDesktopUnmanaged).not.toHaveBeenCalled()
    expect(targetFiles(f.directory)).toEqual([])
  })

  it('fails the revision check before any model lookup when queued work no longer owns its account', async () => {
    const f = fixture()
    const assertOwner = () => { throw new Error('账号已切换') }
    await expect(f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: selectedModel }, assertOwner)).rejects.toThrow('账号已切换')
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(targetFiles(f.directory)).toEqual([])
  })
})

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

  it('records ownership on the next check when the address was moved but recording it failed', async () => {
    const f = fixture()
    const { files, before } = await configureAll(f)
    const service = await restartOn(f, 'direct')
    const moved = before.get('workbuddy')!.replaceAll(primaryOrigin, directOrigin)
    // WorkBuddy 排第一个换：地址换好了，记归属那一步没写进去。
    const write = vi.spyOn(ExternalClientOwnershipStore.prototype, 'write').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
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
