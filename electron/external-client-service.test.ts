import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAppSettings } from './app-settings'
import { externalToolIds } from './external-client-contract'
import { fixture, hostPlatform, removeTemporaryDirectories, selectedKey, selectedModel, targetFiles } from './external-client-service.test-support'

// 上次检测结果在 scanExternalClients 返回之后才落盘（它不等）。用例要等的是那一次原子写本身写完，不靠
// vi.waitFor 默认 1 秒的轮询：Windows 跑道慢一阵时，一次原子写就能过 1 秒（#2006）。写照真的写，写完告诉用例一声。
const atomicWrites = vi.hoisted(() => {
  const waiting: { file: string; containing: string; resolve: () => void; reject: (error: unknown) => void }[] = []
  function take(file: string, content: string) {
    const matched = waiting.filter((entry) => entry.file === file && content.includes(entry.containing))
    for (const entry of matched) waiting.splice(waiting.indexOf(entry), 1)
    return matched
  }
  return {
    /** 下一次往 file（绝对路径）里写进带 containing 的内容、写完时兑现；那次写失败就带着它的错误失败。 */
    next(file: string, containing: string) {
      return new Promise<void>((resolve, reject) => { waiting.push({ file, containing, resolve, reject }) })
    },
    written(file: string, content: string) {
      for (const entry of take(file, content)) entry.resolve()
    },
    failed(file: string, content: string, error: unknown) {
      for (const entry of take(file, content)) entry.reject(error)
    },
  }
})
vi.mock('./safe-local-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('./safe-local-data')>()
  return {
    ...original,
    async writeAtomicSafeUtf8File(...args: Parameters<typeof original.writeAtomicSafeUtf8File>) {
      try {
        await original.writeAtomicSafeUtf8File(...args)
      } catch (error) {
        atomicWrites.failed(args[0], args[1], error)
        throw error
      }
      atomicWrites.written(args[0], args[1])
    },
  }
})

afterEach(removeTemporaryDirectories)

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

  it('stops only OpenCode on a relative XDG_CONFIG_HOME and tells the customer how to fix it', async () => {
    // 决定单 D62 第 4 条的原字。WorkBuddy 的配置在主目录下的 .workbuddy 里，不看这个设置，照常能连。
    const message = '本机的 XDG_CONFIG_HOME 设置不是完整路径，无法确定 OpenCode 的配置位置。请将其改为以 / 开头的完整路径，或删除该设置后重试。'
    const f = fixture()
    vi.spyOn(os, 'homedir').mockReturnValue(f.userHome)
    vi.stubEnv('XDG_CONFIG_HOME', 'relative-config')
    try {
      const statuses = await f.service.scanExternalClients()
      expect(statuses.find((status) => status.tool === 'opencode')).toMatchObject({ configured: false, configurationSource: 'unknown', configurationError: message })
      expect(statuses.find((status) => status.tool === 'workbuddy')).toMatchObject({ configurationSource: 'missing', configurationError: null })
      await expect(f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow(message)
      await f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel })
      expect((await f.service.scanExternalClients()).find((status) => status.tool === 'workbuddy')).toMatchObject({ configured: true, configurationSource: 'xingmang' })
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('tells the customer what to do next after connecting OpenCode or Claude Desktop, without a contradicting not-verified line', async () => {
    // 决定单 D62 第 1、2 条的原字：Claude Desktop 那句下面紧跟着「连接自检」，不再说「尚未验证」。
    const f = fixture()
    const opencode = await f.service.configureExternalTool('opencode', { apiKey: selectedKey, model: selectedModel })
    expect(opencode.message).toBe('已连接完成。请关闭 OpenCode 后重新打开即可使用；如您在某个项目中单独为 OpenCode 配置过模型，该项目以您自己的配置为准。')
    const desktop = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    expect(desktop.message).toBe('已写入 Claude Desktop。请完全退出 Claude Desktop，再从此处点击「打开」即可生效。')
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

  it.each(externalToolIds)('writes the automatic %s connection only while it is still never configured, and closed unless it is WorkBuddy', async (tool) => {
    const f = fixture()
    for (const status of f.runtimeStatuses) status.installed = true
    const runtimeStatus = f.runtimeStatuses.find((status) => status.tool === tool)!
    const automatic = () => f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel }, undefined, 'configured', { automatic: true })
    expect((await f.service.scanExternalClients()).find((status) => status.tool === tool)).toMatchObject({ configurationSource: 'missing', pristine: true })
    runtimeStatus.running = true
    if (tool === 'workbuddy') {
      // WorkBuddy 盯着 models.json，开着也写（2026-11-18 拆安装包核实）。
      await expect(automatic()).resolves.toMatchObject({ tool, model: selectedModel, outcome: 'configured' })
    } else {
      // 开着：等它退出再说，这次一个字不写（D7）。
      await expect(automatic()).rejects.toThrow('本次未自动连接')
      expect(targetFiles(f.userHome)).toEqual([])
      runtimeStatus.running = false
      await expect(automatic()).resolves.toMatchObject({ tool, model: selectedModel, outcome: 'configured' })
    }
    const written = targetFiles(f.userHome)
    expect(written.length).toBeGreaterThan(0)
    const before = new Map(written.map((file) => [file, fs.readFileSync(file, 'utf8')]))
    // 已经有配置了：自动那一次不再写，哪怕又排到了一次。
    await expect(automatic()).rejects.toThrow('本次未自动连接')
    for (const [file, content] of before) expect(fs.readFileSync(file, 'utf8'), file).toBe(content)
    // 客户自己在配置窗口里点的保存照旧能写。
    await expect(f.service.configureExternalTool(tool, { apiKey: selectedKey, model: selectedModel })).resolves.toMatchObject({ tool, outcome: 'configured' })
  })

  // yoyo 2026-11-18「改」：WorkBuddy 认出来就自动连，但每个账号只替它写一次；客户删了星芒那条，不再给他加回去。
  it('keeps WorkBuddy out of automatic connection once this account has written it, even after the customer removes the entry', async () => {
    const f = fixture()
    f.runtimeStatuses[0].installed = true
    const automatic = () => f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel }, undefined, 'configured', { automatic: true })
    const read = async () => (await f.service.scanExternalClients()).find((status) => status.tool === 'workbuddy')
    await expect(automatic()).resolves.toMatchObject({ outcome: 'configured' })
    const [file] = targetFiles(f.userHome).filter((entry) => entry.endsWith('models.json'))
    fs.writeFileSync(file, '[]\n', 'utf8')
    expect(await read()).toMatchObject({ configured: false, configurationSource: 'missing' })
    expect(await read()).not.toHaveProperty('pristine')
    await expect(automatic()).rejects.toThrow('本次未自动连接')
    expect(fs.readFileSync(file, 'utf8')).toBe('[]\n')
    // 换一个账号登录：这个账号还没替它写过。
    f.setUser(18)
    expect(await read()).toMatchObject({ pristine: true })
    // 没登录时不算从没配置过：自动连要的是当前账号。
    f.setUser(null)
    expect(await read()).not.toHaveProperty('pristine')
  })

  it('looks at WorkBuddy alone when asked, without a full inventory or touching the saved snapshot', async () => {
    const f = fixture()
    f.runtimeStatuses[0].installed = true
    const status = await f.service.scanExternalClient('workbuddy')
    expect(status).toMatchObject({ tool: 'workbuddy', installed: true, configurationSource: 'missing', pristine: true })
    expect(f.runtime.scanOne).toHaveBeenCalledExactlyOnceWith('workbuddy')
    expect(f.runtime.scan).not.toHaveBeenCalled()
    expect(f.service.getLastExternalClients()).toBeNull()
  })

  it('shows the next start the last whole detection until that start has scanned, never as running and without the key', async () => {
    const f = fixture({ snapshotCache: true })
    const cacheFile = path.join(f.managerDataDirectory, 'external-client-snapshot.json')
    await expect(f.service.cachedExternalClients()).resolves.toEqual([])
    await f.service.configureExternalTool('workbuddy', { apiKey: selectedKey, model: selectedModel })
    f.runtimeStatuses[1].running = true
    f.runtimeStatuses[1].version = '2.2600.0.0'
    const firstSaved = atomicWrites.next(path.resolve(cacheFile), '2.2600.0.0')
    const scanned = await f.service.scanExternalClients()
    expect(scanned[1]).toMatchObject({ tool: 'claudeDesktop', running: true })
    await firstSaved
    expect(fs.readFileSync(cacheFile, 'utf8')).toContain('2.2600.0.0')
    expect(fs.readFileSync(cacheFile, 'utf8')).not.toContain(selectedKey)
    // This launch already has its own answer.
    await expect(f.service.cachedExternalClients()).resolves.toEqual([])

    const restarted = f.restart()
    vi.mocked(f.runtime.scan).mockClear()
    f.relayFetch.mockClear()
    const cached = await restarted.cachedExternalClients()
    // 「从没配置过」只给这一刻现看的自动连用（D7），不落盘。
    expect(scanned.some((status) => status.pristine)).toBe(true)
    expect(cached).toEqual(scanned.map(({ pristine: _pristine, ...status }) => ({ ...status, running: false, cachedAt: expect.any(String) })))
    expect(cached[0]).toMatchObject({ tool: 'workbuddy', configured: true, configurationSource: 'xingmang', model: selectedModel })
    // Reading it probes nothing and asks the relay nothing.
    expect(f.runtime.scan).not.toHaveBeenCalled()
    expect(f.relayFetch).not.toHaveBeenCalled()
    // The feedback report still says it has not detected anything this launch.
    expect(restarted.getLastExternalClients()).toBeNull()

    f.runtimeStatuses[1].version = '2.2700.0.0'
    const freshSaved = atomicWrites.next(path.resolve(cacheFile), '2.2700.0.0')
    const fresh = await restarted.scanExternalClients()
    expect(fresh.every((status) => status.cachedAt === undefined)).toBe(true)
    await expect(restarted.cachedExternalClients()).resolves.toEqual([])
    // scanExternalClients 不等落盘就返回；等这次改名到位再收尾，免得删目录时撞上临时文件。
    await freshSaved
    expect(fs.readFileSync(cacheFile, 'utf8')).toContain('2.2700.0.0')
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

  it('switches Claude Desktop to the official login and back without asking for the key again', async () => {
    const f = fixture()
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const desktopPath = path.join(f.claudeProfileDirectory, 'claude_desktop_config.json')
    const profile = fs.readFileSync(saved.path, 'utf8')
    f.relayFetch.mockClear()

    const official = await f.service.switchExternalClientSource('claudeDesktop', 'official')
    expect(official).toMatchObject({ tool: 'claudeDesktop', target: 'official', outcome: 'switched' })
    expect(official.outcome === 'switched' && official.message).toContain('请使用您自己的 Claude 账号登录')
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual({ deploymentMode: '1p' })
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(profile)
    const status = (await f.service.scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop')
    expect(status).toMatchObject({ configured: false, officialAccount: true })
    // 官方登录走客户自己的订阅：检查页照实说，不拿留着的那把星芒密钥去发请求。
    expect(await f.service.checkExternalClientConnection('claudeDesktop')).toMatchObject({ ok: false, layer: 'unconfigured', endpoint: null })

    // 换了账号，那份不是这个账号的：一个字不写，界面去打开连接窗口。
    f.setUser(18)
    await expect(f.service.switchExternalClientSource('claudeDesktop', 'account')).resolves.toEqual({ tool: 'claudeDesktop', target: 'account', outcome: 'reconnect' })
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual({ deploymentMode: '1p' })

    f.setUser(17)
    const back = await f.service.switchExternalClientSource('claudeDesktop', 'account')
    expect(back).toMatchObject({ tool: 'claudeDesktop', target: 'account', outcome: 'switched' })
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual({ deploymentMode: '3p' })
    expect((await f.service.scanExternalClients()).find((entry) => entry.tool === 'claudeDesktop')).toMatchObject({ configured: true, configurationSource: 'xingmang' })
    expect(JSON.stringify([official, back])).not.toContain(selectedKey)
    expect(f.relayFetch).not.toHaveBeenCalled()
  })

  it.each(['workbuddy', 'opencode'] as const)('does not offer %s an official login to switch to', async (tool) => {
    const f = fixture()
    await expect(f.service.switchExternalClientSource(tool, 'official')).rejects.toThrow('未知的外部客户端类型')
    expect(f.runtime.scan).not.toHaveBeenCalled()
  })

  it('stops a Claude Desktop switch when the account changes after the management check', async () => {
    const f = fixture()
    await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const desktopPath = path.join(f.claudeProfileDirectory, 'claude_desktop_config.json')
    let revision = 1
    f.assertClaudeDesktopUnmanaged.mockImplementationOnce(async () => { revision++ })
    await expect(f.service.switchExternalClientSource('claudeDesktop', 'official', () => { if (revision !== 1) throw new Error('账号已切换') })).rejects.toThrow('账号已切换')
    expect(JSON.parse(fs.readFileSync(desktopPath, 'utf8'))).toEqual({ deploymentMode: '3p' })
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

  // 中转对某个型号回「无可用渠道」：它不进 Claude Desktop 的型号菜单，其余照它开机检查那条请求试通了的才进。
  function messagesFetch(f: ReturnType<typeof fixture>, failing: readonly string[], onProbe?: (model: string) => void) {
    f.relayFetch.mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/v1/messages')) {
        return Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: selectedModel }, { id: 'gpt-5.4' }, { id: 'claude-fable-5' }, { id: 'claude-haiku-4-5' }] })
      }
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      onProbe?.(model)
      return failing.includes(model)
        ? Response.json({ error: { message: `当前分组 default 下对于模型 ${model} 无可用渠道` } }, { status: 503 })
        : Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' })
    })
  }

  it('offers Claude Desktop the picked model first plus the other Claude models that answer its launch check', async () => {
    const f = fixture()
    const probed: string[] = []
    messagesFetch(f, ['claude-fable-5'], (model) => probed.push(model))
    const result = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8')).inferenceModels).toEqual([
      { name: selectedModel }, { name: 'claude-opus-5-5' }, { name: 'claude-haiku-4-5' },
    ])
    expect(result).toMatchObject({ model: selectedModel, connectionVerified: true })
    expect(result.connection).toMatchObject({ ok: true, model: selectedModel })
    // 先试三个候选，保存后的复测问默认型号，再照 Claude Desktop 的挑法问它开机检查会挑的 Haiku。
    expect(probed.slice(0, 3).sort()).toEqual(['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-5-5'])
    expect(probed.slice(3)).toEqual([selectedModel, 'claude-haiku-4-5'])
    for (const [url, init] of f.relayFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/messages'))) {
      expect(url).toBe('https://xm.solov.cc/v1/messages')
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 1, messages: [{ role: 'user', content: '.' }] })
    }
    expect(f.runtimeLog.log).toHaveBeenCalledWith('info', 'config', 'external-client.claude-desktop.models', expect.any(String), {
      models: 3, rejected: ['claude-fable-5'],
    })
    expect(JSON.stringify(f.runtimeLog.log.mock.calls)).not.toContain(selectedKey)
  })

  it('keeps only the picked model for Claude Desktop when none of the others answer', async () => {
    const f = fixture()
    messagesFetch(f, ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5'])
    const result = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8')).inferenceModels).toEqual([selectedModel])
    expect(result).toMatchObject({ model: selectedModel, connectionVerified: true })
  })

  it('writes nothing into Claude Desktop when the account changes while the other models are being tried', async () => {
    const f = fixture()
    messagesFetch(f, [], () => f.setUser(18))
    await expect(f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })).rejects.toThrow('账号已变化')
    expect(targetFiles(f.directory)).toEqual([])
  })

  // yoyo 2026-11-12「1 2 3 做」第 1 条：开机替客户把账号新上的型号补进 Claude Desktop 的菜单，只加不减，默认那个不动。
  // 每次开机是一个新的服务（restart），型号清单不带上一次的缓存。
  function claudeDesktopMenu(f: ReturnType<typeof fixture>, configPath: string): unknown {
    return (JSON.parse(fs.readFileSync(configPath, 'utf8')) as { inferenceModels?: unknown }).inferenceModels
  }
  function messagesProbed(f: ReturnType<typeof fixture>): string[] {
    return f.relayFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/messages'))
      .map(([, init]) => (JSON.parse(String(init?.body)) as { model: string }).model)
  }

  it('adds the Claude models the account lists to the menu at startup, after the default and only the ones that answer', async () => {
    const f = fixture()
    messagesFetch(f, ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5'])
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    expect(claudeDesktopMenu(f, saved.path)).toEqual([selectedModel])

    messagesFetch(f, ['claude-fable-5'])
    f.relayFetch.mockClear()
    await f.restart().topUpClaudeDesktopModels?.()
    expect(claudeDesktopMenu(f, saved.path)).toEqual([{ name: selectedModel }, { name: 'claude-opus-5-5' }, { name: 'claude-haiku-4-5' }])
    expect(messagesProbed(f).sort()).toEqual(['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-5-5'])
    for (const [url, init] of f.relayFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/messages'))) {
      expect(url).toBe('https://xm.solov.cc/v1/messages')
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 1, messages: [{ role: 'user', content: '.' }] })
    }
    expect(f.runtimeLog.log).toHaveBeenCalledWith('info', 'config', 'external-client.claude-desktop.models.topped-up', expect.any(String), {
      added: ['claude-opus-5-5', 'claude-haiku-4-5'], rejected: ['claude-fable-5'], overflow: [],
    })
    expect((await f.service.scanExternalClients()).find((status) => status.tool === 'claudeDesktop')).toMatchObject({
      configured: true, configurationSource: 'xingmang', model: selectedModel,
    })

    // 下次开机账号上了 Opus 6：只试它和上次没通的那个，已经在菜单里、试过的都不再试。
    f.relayFetch.mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/v1/messages')) {
        return Response.json({ data: [{ id: 'claude-opus-6' }, { id: 'claude-opus-5-5' }, { id: selectedModel }, { id: 'claude-fable-5' }, { id: 'claude-haiku-4-5' }] })
      }
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      return model === 'claude-fable-5'
        ? Response.json({ error: { message: `当前分组 default 下对于模型 ${model} 无可用渠道` } }, { status: 503 })
        : Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' })
    })
    f.relayFetch.mockClear()
    await f.restart().topUpClaudeDesktopModels?.()
    expect(messagesProbed(f).sort()).toEqual(['claude-fable-5', 'claude-opus-6'])
    expect(claudeDesktopMenu(f, saved.path)).toEqual([
      { name: selectedModel }, { name: 'claude-opus-6' }, { name: 'claude-opus-5-5' }, { name: 'claude-haiku-4-5' },
    ])
    expect(JSON.stringify(f.runtimeLog.log.mock.calls)).not.toContain(selectedKey)
    for (const file of targetFiles(f.managerDataDirectory)) expect(fs.readFileSync(file, 'utf8')).not.toContain(selectedKey)
  })

  it('leaves the menu alone and tries nothing while Claude Desktop is open', async () => {
    const f = fixture()
    messagesFetch(f, ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5'])
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const before = fs.readFileSync(saved.path, 'utf8')
    f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!.running = true
    messagesFetch(f, [])
    f.relayFetch.mockClear()
    await f.restart().topUpClaudeDesktopModels?.()
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(before)
    expect(f.runtimeLog.log).toHaveBeenCalledWith('info', 'config', 'external-client.claude-desktop.models.top-up-skipped', expect.any(String), { reason: 'running' })
  })

  it('writes nothing when Claude Desktop is opened while the models are being tried, and tries again next start', async () => {
    const f = fixture()
    messagesFetch(f, ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5'])
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const before = fs.readFileSync(saved.path, 'utf8')
    const desktop = f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!
    messagesFetch(f, [], () => { desktop.running = true })
    await f.restart().topUpClaudeDesktopModels?.()
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(before)
    expect(f.runtimeLog.log).toHaveBeenCalledWith('warn', 'config', 'external-client.claude-desktop.models.top-up-failed', expect.any(String), {
      reason: 'Claude Desktop 已经打开了，这次不补型号',
    })

    desktop.running = false
    messagesFetch(f, [])
    await f.restart().topUpClaudeDesktopModels?.()
    expect(claudeDesktopMenu(f, saved.path)).toEqual([{ name: selectedModel }, { name: 'claude-opus-5-5' }, { name: 'claude-fable-5' }, { name: 'claude-haiku-4-5' }])
  })

  it('writes nothing when the account changes while the models are being tried', async () => {
    const f = fixture()
    messagesFetch(f, ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5'])
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const before = fs.readFileSync(saved.path, 'utf8')
    messagesFetch(f, [], () => f.setUser(18))
    await f.restart().topUpClaudeDesktopModels?.()
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(before)
    expect(f.runtimeLog.log).toHaveBeenCalledWith('warn', 'config', 'external-client.claude-desktop.models.top-up-failed', expect.any(String), {
      reason: '账号已变化，这次不补型号',
    })
  })

  // 总单 #67（11-18 A03）：试型号那一阵换了账号或退出登录，剩下的不再拿上一个账号的密钥接着试，这次也不记；
  // 切回原来那个账号，下次开机照常补。
  it.each([['switches to another account', 18], ['signs out', null]] as const)(
    'stops trying models with the previous account key once the customer %s, and catches up after switching back',
    async (_case, next) => {
      const f = fixture()
      messagesFetch(f, ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5'])
      const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
      const before = fs.readFileSync(saved.path, 'utf8')
      // 账号上了 6 个新型号，比同时试的个数（3）多：换账号以后才轮到的那几个不该再发出去。
      const listed = ['claude-opus-5-5', 'claude-fable-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-haiku-4-6']
      let switched = false
      f.relayFetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/v1/messages')) return Response.json({ data: [selectedModel, ...listed].map((id) => ({ id })) })
        if (!switched) {
          switched = true
          f.setUser(next)
        }
        const model = (JSON.parse(String(init?.body)) as { model: string }).model
        return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' })
      })
      f.relayFetch.mockClear()
      await f.restart().topUpClaudeDesktopModels?.()

      expect(messagesProbed(f).length).toBeLessThanOrEqual(3)
      expect(fs.readFileSync(saved.path, 'utf8')).toBe(before)
      expect(targetFiles(f.managerDataDirectory).filter((file) => file.includes('claude-desktop-models'))).toEqual([])
      expect(f.runtimeLog.log).toHaveBeenCalledWith('warn', 'config', 'external-client.claude-desktop.models.top-up-failed', expect.any(String), {
        reason: '账号已变化，这次不补型号',
      })

      f.setUser(17)
      switched = true
      f.relayFetch.mockClear()
      await f.restart().topUpClaudeDesktopModels?.()
      expect(messagesProbed(f).sort()).toEqual([...listed].sort())
      expect((claudeDesktopMenu(f, saved.path) as { name: string }[]).map((entry) => entry.name)).toEqual(expect.arrayContaining([selectedModel, ...listed]))
    },
  )

  it('does not touch a Claude Desktop profile that is not the current account, nor run without one', async () => {
    const f = fixture()
    messagesFetch(f, ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5'])
    const saved = await f.service.configureExternalTool('claudeDesktop', { apiKey: selectedKey, model: selectedModel })
    const before = fs.readFileSync(saved.path, 'utf8')
    messagesFetch(f, [])
    f.relayFetch.mockClear()
    f.setUser(18)
    await f.restart().topUpClaudeDesktopModels?.()
    f.setUser(null)
    await f.restart().topUpClaudeDesktopModels?.()
    expect(f.relayFetch).not.toHaveBeenCalled()
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(before)
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

