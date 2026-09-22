import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore, defaultAppSettings } from './app-settings'
import { createSystemService, type SystemServiceOptions } from './system-service'
import type { ExternalClientRuntimeStatus } from './external-client-contract'

const temporaryDirectories: string[] = []
const selectedKey = 'sk-selected-external-client-key'
const selectedModel = 'claude-sonnet-4-6'
const hostPlatform = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

function fixture(options: { site?: 'solov' | 'solov-api'; platform?: NodeJS.Platform; nativeClaudePaths?: boolean } = {}) {
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
  const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: selectedModel }, { id: 'gpt-5.4' }] }))
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
    launch: vi.fn(async () => undefined),
  }
  const serviceOptions: SystemServiceOptions = {
    providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
    managerDataDirectory, relayFetch, getRelaySiteId: () => site, platform: options.platform ?? hostPlatform,
    getExternalClientAccountId: () => userId === null ? null : JSON.stringify([site, userId]),
    claudeDesktopEnv: options.nativeClaudePaths ? {} : { CLAUDE_USER_DATA_DIR: claudeProfileDirectory },
    assertClaudeDesktopUnmanaged,
    inspectClaudeDesktopStoreVirtualization,
    externalClientRuntime: runtime,
  }
  return {
    directory, userHome, managerDataDirectory, claudeProfileDirectory, store, relayFetch, assertClaudeDesktopUnmanaged, inspectClaudeDesktopStoreVirtualization, runtime, runtimeStatuses,
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
    expect(f.relayFetch).toHaveBeenCalledExactlyOnceWith('https://xm.solov.cc/v1/models', expect.any(Object))
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
