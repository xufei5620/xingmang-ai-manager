import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SystemService } from './system-service'
import type { UpdaterService } from './updater'
import type { AppSettings } from './app-settings'
import type { NativeConfigSaveResult } from './config-files'
import type { NewApiClientService } from './new-api-client'
import { ipcInvokeChannels } from './ipc-contract'
import { providerSessionProviders } from './provider-sessions'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  browserWindowFromWebContents: vi.fn(() => undefined),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.handle(channel, handler)
      electronMocks.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => electronMocks.removeHandler(channel),
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showSaveDialog: electronMocks.showSaveDialog,
    showMessageBox: electronMocks.showMessageBox,
  },
  BrowserWindow: {
    fromWebContents: electronMocks.browserWindowFromWebContents,
  },
  shell: { openExternal: electronMocks.openExternal, openPath: electronMocks.openPath },
  clipboard: { writeText: electronMocks.writeText },
}))

import { registerIpcHandlers } from './ipc'

function serviceStub(): SystemService {
  return {
    readStoredConfig: vi.fn((): AppSettings => ({
      version: 2,
      workspace: 'C:\\workspace',
      theme: 'dark',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
    })),
    writeStoredConfig: vi.fn(async () => undefined),
    inspectCodexReadiness: vi.fn(() => ({ hasApiKey: true, matchesRelay: true })),
    getConfig: vi.fn(() => ({ workspace: 'C:\\workspace', providers: {} })) as never,
    revealApiKey: vi.fn(() => 'sk-known-secret-value'),
    saveConfig: vi.fn(async (): Promise<NativeConfigSaveResult> => ({ backups: [], files: [] })),
    scanSystem: vi.fn() as never,
    inspectCodexSetupStatus: vi.fn() as never,
    installNodeRuntime: vi.fn() as never,
    installCli: vi.fn() as never,
    uninstallCli: vi.fn() as never,
    inspectCliUpdate: vi.fn() as never,
    installCodexDesktop: vi.fn() as never,
    uninstallCodexDesktop: vi.fn() as never,
    inspectCodexDesktopUpdate: vi.fn() as never,
    launchProvider: vi.fn() as never,
    inspectCodexDesktop: vi.fn() as never,
    launchCodexDesktop: vi.fn() as never,
    fetchAvailableModels: vi.fn() as never,
  }
}

// Always injected by register() below (default parameter), so no test ever
// falls through to registerIpcHandlers' own default of a real
// createNewApiClient() talking to production xm.solov.cc -- the account:*
// handlers would otherwise be the one corner of this suite able to reach the
// network. See CLAUDE.md's automated-tests-never-touch-production rule.
function accountServiceStub(): NewApiClientService {
  return {
    getStatus: vi.fn() as never,
    sendEmailVerification: vi.fn(async () => undefined),
    sendPasswordResetEmail: vi.fn(async () => undefined),
    resetPassword: vi.fn(async () => ({ newPassword: 'stub-generated-password' })),
    register: vi.fn(async () => undefined),
    login: vi.fn() as never,
    logout: vi.fn(),
    isAuthenticated: vi.fn(() => false),
    getSessionState: vi.fn(() => ({ authenticated: false, account: null })),
    getBalance: vi.fn() as never,
    provisionCliKey: vi.fn() as never,
    findExistingCliKey: vi.fn() as never,
    refreshAccessToken: vi.fn() as never,
    getPersistableSession: vi.fn(() => null),
    restoreSession: vi.fn(async () => false),
  }
}

function trustedEvent(url = 'http://localhost:5173/') {
  return {
    senderFrame: { url },
    sender: {
      getURL: () => url,
      isDestroyed: () => false,
      send: vi.fn(),
    },
  }
}

function updaterStub(): UpdaterService {
  const state = {
    phase: 'disabled' as const,
    currentVersion: '1.0.0',
    availableVersion: null,
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: true,
  }
  return {
    getState: vi.fn(() => state),
    startup: vi.fn(async () => state),
    check: vi.fn(async () => state),
    download: vi.fn(async () => state),
    install: vi.fn(() => ({ accepted: true as const })),
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
  }
}

function register(
  service = serviceStub(),
  runtimeLogDirectory = 'C:\\app-data\\logs',
  transformSystemSnapshot?: (snapshot: never) => never,
  accountService = accountServiceStub(),
) {
  const extensionService = {
    getRepositoryContext: vi.fn(() => ({ repositoryRoot: 'C:\\workspace' })),
    setRepositoryContext: vi.fn((repositoryRoot: string) => ({ repositoryRoot })),
    listMcpServers: vi.fn(),
    addMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    loginMcpServer: vi.fn(),
    logoutMcpServer: vi.fn(),
    listSkills: vi.fn(),
    importSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    uninstallSkill: vi.fn(),
    listPlugins: vi.fn(),
    addPlugin: vi.fn(),
    removePlugin: vi.fn(),
    setPluginEnabled: vi.fn(),
    addMarketplace: vi.fn(),
    upgradeMarketplace: vi.fn(),
    removeMarketplace: vi.fn(),
  }
  const providerExtensionService = {
    setRepositoryRoot: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn(),
    mutate: vi.fn(),
  }
  const sessionsService = {
    list: vi.fn(),
    detail: vi.fn(),
    exportMarkdown: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
  }
  const providerSessionsService = {
    list: vi.fn(),
    detail: vi.fn(),
    exportMarkdown: vi.fn(),
  }
  const runtimeLog = {
    directory: runtimeLogDirectory,
    log: vi.fn(),
    exception: vi.fn(),
    snapshot: vi.fn(async () => ({
      generatedAt: '2026-07-24T00:00:00.000Z',
      directory: 'C:\\app-data\\logs',
      filePath: 'C:\\app-data\\logs\\runtime.jsonl',
      sizeBytes: 0,
      total: 0,
      truncated: false,
      counts: { debug: 0, info: 0, warn: 0, error: 0 },
      sources: [],
      entries: [],
    })),
    feedbackReport: vi.fn(async () => 'sanitized report\n'),
    clear: vi.fn(async () => undefined),
  }
  const dispose = registerIpcHandlers({
    systemService: service,
    accountService,
    sessionsService: sessionsService as never,
    providerSessionsService: providerSessionsService as never,
    backupStore: {
      list: vi.fn(),
      create: vi.fn(),
      inspect: vi.fn(),
      restore: vi.fn(),
    } as never,
    diagnosticsService: {
      run: vi.fn(),
      exportLatest: vi.fn(),
    },
    runtimeLog: runtimeLog as never,
    extensionService: extensionService as never,
    providerExtensionService: providerExtensionService as never,
    urlPolicy: {
      rendererRoot: 'C:\\app\\dist',
      devServerUrl: 'http://localhost:5173',
    },
    previewOnboarding: false,
    externalUrlAllowlist: [
      'https://api.solov.cc',
      'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS',
    ],
    externalShell: {
      openExternal: electronMocks.openExternal,
      openPath: async (targetPath) => {
        const failure = await electronMocks.openPath(targetPath)
        if (failure) throw new Error(failure)
      },
    },
    updaterService: updaterStub(),
    broadcastUpdate: vi.fn(),
    setWindowMode: vi.fn(),
    setWindowTheme: vi.fn(),
    openCanvasWindow: vi.fn(async () => undefined),
    ...({ transformSystemSnapshot } as object),
  })
  return {
    dispose,
    service,
    accountService,
    extensionService,
    providerExtensionService,
    runtimeLog,
    sessionsService,
    providerSessionsService,
  }
}

beforeEach(() => {
  electronMocks.handlers.clear()
  electronMocks.handle.mockClear()
  electronMocks.removeHandler.mockClear()
  electronMocks.showOpenDialog.mockReset()
  electronMocks.showMessageBox.mockReset()
  electronMocks.showMessageBox.mockResolvedValue({ response: 0 })
  electronMocks.openExternal.mockReset()
  electronMocks.openExternal.mockResolvedValue(undefined)
  electronMocks.openPath.mockReset()
  electronMocks.openPath.mockResolvedValue('')
  electronMocks.writeText.mockReset()
})

describe('registerIpcHandlers', () => {
  it('registers and disposes the existing IPC contract', () => {
    const { dispose } = register()
    const expectedChannels = Object.values(ipcInvokeChannels)
    expect([...electronMocks.handlers.keys()]).toEqual(expectedChannels)

    dispose()

    expect(electronMocks.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(expectedChannels)
  })

  it('persists a selected workspace and updates the repository context', async () => {
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\project'],
    })
    const { service, extensionService, providerExtensionService } = register()

    await expect(electronMocks.handlers.get('workspace:choose')!(trustedEvent())).resolves.toBe('D:\\project')
    expect(service.writeStoredConfig).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'D:\\project' }))
    expect(extensionService.setRepositoryContext).toHaveBeenCalledWith('D:\\project')
    expect(providerExtensionService.setRepositoryRoot).toHaveBeenCalledWith('D:\\project')
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openDirectory', 'createDirectory'],
    }))
    expect(electronMocks.handlers.get('repository:get-context')!(trustedEvent())).toEqual({
      repositoryRoot: 'C:\\workspace',
    })
  })

  it('rejects calls from a sender outside the application URL policy', () => {
    const { service } = register()
    const handler = electronMocks.handlers.get('system:scan')!

    expect(() => handler(trustedEvent('https://attacker.example/'))).toThrow(
      '已拒绝来自非应用页面的操作请求',
    )
    expect(service.scanSystem).not.toHaveBeenCalled()
  })

  it('exposes main-process platform capabilities only to trusted senders', async () => {
    register()
    const handler = electronMocks.handlers.get('platform:get-capabilities')!

    expect(handler(trustedEvent())).toMatchObject({
      architecture: process.arch,
      isMac: process.platform === 'darwin',
    })
    expect(() => handler(trustedEvent('https://attacker.example/'))).toThrow(
      '已拒绝来自非应用页面的操作请求',
    )
  })

  it('forwards an explicit forced update scan and rejects invalid flags', async () => {
    const service = serviceStub()
    vi.mocked(service.scanSystem).mockResolvedValueOnce({
      checkedAt: '2026-07-24T00:00:00.000Z',
      runtime: {},
      clis: {},
      desktopApps: {
        codex: {
          installed: false,
          version: null,
          appVersion: null,
          mirrorVersion: null,
          mirrorUpdateAvailable: null,
          mirrorError: null,
          path: null,
          running: false,
        },
      },
    } as never)
    register(service)
    const handler = electronMocks.handlers.get('system:scan')!

    await expect(handler(trustedEvent(), true)).resolves.toMatchObject({
      checkedAt: '2026-07-24T00:00:00.000Z',
    })
    expect(service.scanSystem).toHaveBeenCalledWith(true)
    await expect(handler(trustedEvent(), 'yes')).rejects.toThrow('更新检查参数格式错误')
  })

  it('projects a system scan result only through the main-process registration option', async () => {
    const service = serviceStub()
    const source = {
      checkedAt: '2026-07-24T00:00:00.000Z',
      runtime: {},
      clis: {},
      desktopApps: { codex: {} },
    }
    const projected = { ...source, checkedAt: '2026-08-04T00:00:00.000Z' }
    vi.mocked(service.scanSystem).mockResolvedValueOnce(source as never)
    const transform = vi.fn(() => projected as never)
    register(service, 'C:\\app-data\\logs', transform)

    const handler = electronMocks.handlers.get('system:scan')!
    await expect(handler(trustedEvent(), false)).resolves.toBe(projected)
    expect(transform).toHaveBeenCalledWith(source)
  })

  it('reads only Codex readiness during startup', async () => {
    const { service } = register()
    const handler = electronMocks.handlers.get(ipcInvokeChannels.getCodexReadiness)!

    expect(handler(trustedEvent())).toEqual({ hasApiKey: true, matchesRelay: true })
    expect(service.inspectCodexReadiness).toHaveBeenCalledWith(false)
    expect(service.scanSystem).not.toHaveBeenCalled()
    expect(service.getConfig).not.toHaveBeenCalled()
  })

  it('opens an allowed external URL directly in the default browser', async () => {
    register()
    const handler = electronMocks.handlers.get(ipcInvokeChannels.openExternal)!

    await expect(handler(trustedEvent(), 'https://api.solov.cc')).resolves.toBe(true)
    expect(electronMocks.openExternal).toHaveBeenCalledOnce()
    expect(electronMocks.showMessageBox).not.toHaveBeenCalled()
  })

  it('opens the exact Codex product in the local Microsoft Store', async () => {
    register()
    const handler = electronMocks.handlers.get(ipcInvokeChannels.openExternal)!
    const storeUri = 'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS'

    await expect(handler(trustedEvent(), storeUri)).resolves.toBe(true)
    expect(electronMocks.openExternal).toHaveBeenCalledWith(storeUri)
    await expect(handler(
      trustedEvent(),
      'ms-windows-store://pdp/?ProductId=OTHER',
    )).rejects.toThrow('不允许打开该链接')
  })

  it('opens the validated runtime log directory through the external shell proxy', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ipc-shell-'))
    try {
      register(serviceStub(), directory)
      const handler = electronMocks.handlers.get(ipcInvokeChannels.openRuntimeLogDirectory)!

      await expect(handler(trustedEvent())).resolves.toBe(true)
      expect(electronMocks.openPath).toHaveBeenCalledWith(directory)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('validates config payloads before passing them to the service', async () => {
    const { service, runtimeLog } = register()
    const handler = electronMocks.handlers.get('config:save')!

    await expect(handler(trustedEvent(), {
      provider: 'codex',
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      mode: 'merge',
    })).resolves.toEqual({ backups: [], files: [] })
    expect(service.saveConfig).toHaveBeenCalledWith({
      provider: 'codex',
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      mode: 'merge',
    }, false)
    expect(runtimeLog.log).toHaveBeenCalledWith(
      'info',
      'ipc',
      'config:save',
      'Codex CLI 配置已保存',
      expect.objectContaining({ provider: 'codex', model: 'gpt-5.6-sol', mode: 'merge' }),
    )
    expect(JSON.stringify(runtimeLog.log.mock.calls)).not.toContain('sk-test')

    expect(() => handler(trustedEvent(), { provider: 'unknown' })).toThrow('未知的 CLI 类型')
  })

  it('returns only an API key preview through config:get', () => {
    const service = serviceStub()
    vi.mocked(service.getConfig).mockReturnValue({
      workspace: 'C:\\workspace',
      providers: {
        codex: {
          baseUrl: 'https://api.solov.cc',
          actualBaseUrl: 'https://api.solov.cc',
          exists: true,
          hasApiKey: true,
          matchesRelay: true,
          apiKeyPreview: 'sk-te••••••••wxyz',
          model: 'gpt-5.6-sol',
          dataDirectory: 'C:\\Users\\tester\\.codex',
          dataDirectoryExists: true,
          files: [],
          updatedAt: null,
        },
      },
    } as never)
    register(service)

    const result = electronMocks.handlers.get('config:get')!(trustedEvent())
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('apiKeyPreview')
    expect(serialized).not.toContain('sk-known-secret-value')
    expect(serialized).not.toMatch(/"apiKey"\s*:/)
  })

  it('reveals the API key only through the dedicated trusted channel', () => {
    const service = serviceStub()
    register(service)

    const handler = electronMocks.handlers.get('config:reveal-api-key')!
    expect(handler(trustedEvent(), 'codex')).toBe('sk-known-secret-value')
    expect(service.revealApiKey).toHaveBeenCalledWith('codex', false)
    expect(() => handler(trustedEvent(), 'unknown')).toThrow('未知的 CLI 类型')
  })

  it('suppresses successful Codex Desktop polling but records a concrete failure', async () => {
    const service = serviceStub()
    vi.mocked(service.inspectCodexDesktop).mockResolvedValueOnce({
      installed: true,
      version: '26.715.8383.0',
      appVersion: '26.715.8000',
      mirrorVersion: '26.721.3996.0',
      mirrorUpdateAvailable: true,
      mirrorError: null,
      path: 'OpenAI.Codex_abc!App',
      installDirectory: null,
      running: true,
    })
    const { runtimeLog } = register(service)
    const handler = electronMocks.handlers.get('desktop:codex-status')!

    await expect(handler(trustedEvent())).resolves.toMatchObject({ running: true })
    expect(runtimeLog.log).not.toHaveBeenCalledWith(
      expect.anything(),
      'ipc',
      'desktop:codex-status',
      expect.anything(),
      expect.anything(),
    )

    vi.mocked(service.inspectCodexDesktop).mockRejectedValueOnce(new Error('无法读取 Codex 进程'))
    await expect(handler(trustedEvent())).rejects.toThrow('无法读取 Codex 进程')
    expect(runtimeLog.log).toHaveBeenCalledWith(
      'error',
      'ipc',
      'desktop:codex-status',
      'Codex 桌面端运行状态检测失败：无法读取 Codex 进程',
      expect.objectContaining({ error: expect.any(Error) }),
    )
  })

  it('passes the requesting renderer to Codex Desktop installation', async () => {
    const service = serviceStub()
    vi.mocked(service.installCodexDesktop).mockResolvedValueOnce({
      action: 'updated',
      previousVersion: '26.715.8383.0',
      installedVersion: '26.724.1000.0',
    } as never)
    register(service)
    const event = trustedEvent()

    await expect(electronMocks.handlers.get('desktop:install-codex')!(event)).resolves.toMatchObject({
      action: 'updated',
      previousVersion: '26.715.8383.0',
      installedVersion: '26.724.1000.0',
    })
    expect(service.installCodexDesktop).toHaveBeenCalledWith(event.sender)
  })

  it('surfaces degraded extension reads as warnings', async () => {
    const { providerExtensionService, runtimeLog } = register()
    providerExtensionService.list.mockResolvedValueOnce({
      provider: 'claude',
      checkedAt: '2026-07-24T00:00:00.000Z',
      capabilities: {
        mcp: { list: true, reason: null },
        skill: { list: true, reason: null },
        plugin: { list: false, reason: 'Plugins 列表读取失败' },
      },
      items: [],
      warnings: ['Claude Code Plugins 列表读取失败'],
    })

    await expect(electronMocks.handlers.get('extensions:list')!(trustedEvent(), 'claude')).resolves.toMatchObject({
      provider: 'claude',
    })
    expect(runtimeLog.log).toHaveBeenCalledWith(
      'warn',
      'extensions',
      'list.degraded',
      expect.stringContaining('Claude Code Plugins 列表读取失败'),
      expect.objectContaining({ provider: 'claude' }),
    )
  })

  it('records failed maintenance calls without logging their arguments', async () => {
    const service = serviceStub()
    vi.mocked(service.installCli).mockRejectedValueOnce(new Error('Failed to start command: npm'))
    const { runtimeLog } = register(service)
    const handler = electronMocks.handlers.get('cli:install')!

    await expect(handler(trustedEvent(), 'gemini')).rejects.toThrow('Failed to start command: npm')
    expect(runtimeLog.exception).toHaveBeenCalledWith(
      'maintenance',
      'cli.install.failed',
      expect.any(Error),
      { provider: 'gemini' },
    )
    expect(JSON.stringify(runtimeLog.log.mock.calls)).not.toContain('apiKey')
  })

  it('checks and uninstalls only the requested CLI', async () => {
    const service = serviceStub()
    vi.mocked(service.inspectCliUpdate).mockResolvedValueOnce({
      installed: true,
      version: 'grok 0.2.111',
      path: 'C:\\Users\\tester\\.grok\\bin\\grok.exe',
      installDirectory: 'C:\\Users\\tester\\.grok\\bin',
      latestVersion: null,
      updateAvailable: false,
      updateCheck: 'failed',
      updateState: 'unknown',
      updateError: '连接 xAI 更新服务超时，请检查代理或网络后重试',
      uninstall: { available: true, reason: null, manualCommand: null },
    })
    vi.mocked(service.uninstallCli).mockResolvedValueOnce({
      outcome: 'uninstalled',
      previousVersion: 'grok 0.2.111',
    })
    register(service)

    await expect(electronMocks.handlers.get('cli:check-update')!(trustedEvent(), 'grok')).resolves.toMatchObject({
      installed: true,
      updateCheck: 'failed',
    })
    expect(service.inspectCliUpdate).toHaveBeenCalledWith('grok', true)
    expect(service.scanSystem).not.toHaveBeenCalled()

    await expect(electronMocks.handlers.get('cli:uninstall')!(trustedEvent(), 'grok')).resolves.toEqual({
      outcome: 'uninstalled',
      previousVersion: 'grok 0.2.111',
    })
    expect(service.uninstallCli).toHaveBeenCalledWith('grok')
    await expect(electronMocks.handlers.get('cli:uninstall')!(trustedEvent(), 'unknown')).rejects.toThrow('未知的 CLI 类型')
  })

  it('exposes sanitized runtime logs and copies the feedback report', async () => {
    const { runtimeLog } = register()

    await expect(electronMocks.handlers.get('runtime-logs:list')!(trustedEvent(), 500)).resolves.toMatchObject({
      total: 0,
      entries: [],
    })
    await expect(electronMocks.handlers.get('runtime-logs:copy-feedback')!(trustedEvent())).resolves.toEqual({ entries: 0 })
    expect(runtimeLog.feedbackReport).toHaveBeenCalledOnce()
    expect(electronMocks.writeText).toHaveBeenCalledWith('sanitized report\n')
  })

  it('delegates canvas:open to the injected openCanvasWindow callback, and rejects untrusted senders the same as every other channel', async () => {
    const openCanvasWindow = vi.fn(async () => undefined)
    const dispose = registerIpcHandlers({
      systemService: serviceStub(),
      accountService: accountServiceStub(),
      sessionsService: { list: vi.fn(), detail: vi.fn(), exportMarkdown: vi.fn(), archive: vi.fn(), restore: vi.fn() } as never,
      providerSessionsService: { list: vi.fn(), detail: vi.fn(), exportMarkdown: vi.fn() } as never,
      backupStore: { list: vi.fn(), create: vi.fn(), inspect: vi.fn(), restore: vi.fn() } as never,
      diagnosticsService: { run: vi.fn(), exportLatest: vi.fn() },
      runtimeLog: { log: vi.fn(), exception: vi.fn(), snapshot: vi.fn(), feedbackReport: vi.fn(), clear: vi.fn(), directory: 'C:\\app-data\\logs' } as never,
      extensionService: {} as never,
      providerExtensionService: {} as never,
      urlPolicy: { rendererRoot: 'C:\\app\\dist', devServerUrl: 'http://localhost:5173' },
      previewOnboarding: false,
      externalUrlAllowlist: [],
      updaterService: updaterStub(),
      broadcastUpdate: vi.fn(),
      setWindowMode: vi.fn(),
      setWindowTheme: vi.fn(),
      openCanvasWindow,
    })
    try {
      const handler = electronMocks.handlers.get('canvas:open')!

      await expect(handler(trustedEvent())).resolves.toBeUndefined()
      expect(openCanvasWindow).toHaveBeenCalledTimes(1)
      expect(() => handler(trustedEvent('https://attacker.example/'))).toThrow('已拒绝来自非应用页面的操作请求')
    } finally {
      dispose()
    }
  })

  it('awaits accountSessionReady before reading session state, so a slow startup restore is never missed by the first query', async () => {
    let resolveReady: () => void = () => {}
    const accountSessionReady = new Promise<void>((resolve) => { resolveReady = resolve })
    const accountService = accountServiceStub()
    const restoredAccount = {
      userId: 7,
      username: 'restored-user',
      group: null,
      role: null,
      quota: null,
      usedQuota: null,
    }
    // Starts out reporting signed-out, as the shared client does before
    // main.ts's startup restoreAccountSessionOnStartup() has mutated its
    // in-memory session. Only flips to signed-in once resolveReady() below
    // fires, standing in for that restore having finished -- if the handler
    // ever regressed to reading getSessionState() *before* awaiting
    // accountSessionReady, it would observe the stale signed-out value
    // captured at call time instead and this assertion would fail.
    vi.mocked(accountService.getSessionState).mockReturnValue({ authenticated: false, account: null })
    const dispose = registerIpcHandlers({
      systemService: serviceStub(),
      accountService,
      accountSessionReady,
      sessionsService: { list: vi.fn(), detail: vi.fn(), exportMarkdown: vi.fn(), archive: vi.fn(), restore: vi.fn() } as never,
      providerSessionsService: { list: vi.fn(), detail: vi.fn(), exportMarkdown: vi.fn() } as never,
      backupStore: { list: vi.fn(), create: vi.fn(), inspect: vi.fn(), restore: vi.fn() } as never,
      diagnosticsService: { run: vi.fn(), exportLatest: vi.fn() },
      runtimeLog: { log: vi.fn(), exception: vi.fn(), snapshot: vi.fn(), feedbackReport: vi.fn(), clear: vi.fn(), directory: 'C:\\app-data\\logs' } as never,
      extensionService: {} as never,
      providerExtensionService: {} as never,
      urlPolicy: { rendererRoot: 'C:\\app\\dist', devServerUrl: 'http://localhost:5173' },
      previewOnboarding: false,
      externalUrlAllowlist: [],
      updaterService: updaterStub(),
      broadcastUpdate: vi.fn(),
      setWindowMode: vi.fn(),
      setWindowTheme: vi.fn(),
      openCanvasWindow: vi.fn(async () => undefined),
    })
    try {
      const handler = electronMocks.handlers.get('account:get-session')!
      const pending = handler(trustedEvent())

      vi.mocked(accountService.getSessionState).mockReturnValue({ authenticated: true, account: restoredAccount })
      resolveReady()

      await expect(pending).resolves.toEqual({ authenticated: true, account: restoredAccount })
    } finally {
      dispose()
    }
  })

  it('never blocks on a stray accountSessionReady rejection', async () => {
    const accountService = accountServiceStub()
    vi.mocked(accountService.getSessionState).mockReturnValue({ authenticated: false, account: null })
    const dispose = registerIpcHandlers({
      systemService: serviceStub(),
      accountService,
      accountSessionReady: Promise.reject(new Error('restore blew up')),
      sessionsService: { list: vi.fn(), detail: vi.fn(), exportMarkdown: vi.fn(), archive: vi.fn(), restore: vi.fn() } as never,
      providerSessionsService: { list: vi.fn(), detail: vi.fn(), exportMarkdown: vi.fn() } as never,
      backupStore: { list: vi.fn(), create: vi.fn(), inspect: vi.fn(), restore: vi.fn() } as never,
      diagnosticsService: { run: vi.fn(), exportLatest: vi.fn() },
      runtimeLog: { log: vi.fn(), exception: vi.fn(), snapshot: vi.fn(), feedbackReport: vi.fn(), clear: vi.fn(), directory: 'C:\\app-data\\logs' } as never,
      extensionService: {} as never,
      providerExtensionService: {} as never,
      urlPolicy: { rendererRoot: 'C:\\app\\dist', devServerUrl: 'http://localhost:5173' },
      previewOnboarding: false,
      externalUrlAllowlist: [],
      updaterService: updaterStub(),
      broadcastUpdate: vi.fn(),
      setWindowMode: vi.fn(),
      setWindowTheme: vi.fn(),
      openCanvasWindow: vi.fn(async () => undefined),
    })
    try {
      const handler = electronMocks.handlers.get('account:get-session')!
      await expect(handler(trustedEvent())).resolves.toEqual({ authenticated: false, account: null })
    } finally {
      dispose()
    }
  })
})

// The 15 hand-written parse/validation helpers in ipc.ts (requiredString,
// optionalString, stringArray, and 12 parse* functions) are module-private
// and never exported, so they are exercised the same way real IPC callers
// reach them: through the registered handlers, asserting on the Chinese
// error text (I5 - all IPC input is hostile and must be validated) and on
// what gets forwarded to the mocked service layer.
describe('hand-written parse validators in ipc.ts (issue #15)', () => {
  describe('requiredString (e.g. backups:inspect id, mcp:remove name)', () => {
    it('trims and forwards a valid string', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('mcp:remove')!

      expect(() => handler(trustedEvent(), '  my-server  ')).not.toThrow()
      expect(extensionService.removeMcpServer).toHaveBeenCalledWith('my-server')
    })

    it('rejects non-string values', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:remove')!

      for (const bad of [42, true, null, undefined, {}, []]) {
        expect(() => handler(trustedEvent(), bad)).toThrow('MCP 名称格式错误')
      }
    })

    it('rejects an empty or whitespace-only string', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:remove')!

      expect(() => handler(trustedEvent(), '')).toThrow('MCP 名称格式错误')
      expect(() => handler(trustedEvent(), '   ')).toThrow('MCP 名称格式错误')
    })

    it('rejects a string containing a null byte', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:remove')!

      expect(() => handler(trustedEvent(), 'server\0name')).toThrow('MCP 名称格式错误')
    })

    it('enforces the caller-specified maximum length at the exact boundary', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:remove')!

      expect(() => handler(trustedEvent(), 'a'.repeat(128))).not.toThrow()
      expect(() => handler(trustedEvent(), 'a'.repeat(129))).toThrow('MCP 名称格式错误')
    })

    it('embeds the field-specific label so different fields report different text', () => {
      register()

      expect(() => electronMocks.handlers.get('backups:inspect')!(trustedEvent(), '')).toThrow('备份 ID格式错误')
      expect(() => electronMocks.handlers.get('mcp:remove')!(trustedEvent(), '')).toThrow('MCP 名称格式错误')
    })
  })

  describe('optionalString (marketplaces:upgrade name)', () => {
    it('treats undefined as absent', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('marketplaces:upgrade')!

      expect(() => handler(trustedEvent(), undefined)).not.toThrow()
      expect(extensionService.upgradeMarketplace).toHaveBeenCalledWith(undefined)
    })

    it('treats an empty string as absent, but rejects a whitespace-only string', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('marketplaces:upgrade')!

      expect(() => handler(trustedEvent(), '')).not.toThrow()
      expect(extensionService.upgradeMarketplace).toHaveBeenCalledWith(undefined)
      expect(() => handler(trustedEvent(), '   ')).toThrow('市场名称格式错误')
    })

    it('trims and forwards a valid string', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('marketplaces:upgrade')!

      expect(() => handler(trustedEvent(), '  official  ')).not.toThrow()
      expect(extensionService.upgradeMarketplace).toHaveBeenCalledWith('official')
    })

    it('rejects a non-string, non-undefined value', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:upgrade')!

      expect(() => handler(trustedEvent(), 42)).toThrow('市场名称格式错误')
      expect(() => handler(trustedEvent(), null)).toThrow('市场名称格式错误')
    })

    it('rejects a value exceeding the configured maximum length', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:upgrade')!

      expect(() => handler(trustedEvent(), 'a'.repeat(257))).toThrow('市场名称格式错误')
    })
  })

  describe('stringArray (mcp:add args, marketplaces:add sparse)', () => {
    it('defaults to an empty array when the field is omitted', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), { type: 'stdio', name: 'srv', command: 'node' })).not.toThrow()
      expect(extensionService.addMcpServer).toHaveBeenCalledWith(expect.objectContaining({ args: [] }))
    })

    it('rejects a non-array value, including null', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      for (const bad of ['not-an-array', 42, {}, null]) {
        expect(() => handler(trustedEvent(), {
          type: 'stdio', name: 'srv', command: 'node', args: bad,
        })).toThrow('MCP 参数格式错误')
      }
    })

    it('rejects an array exceeding the maximum item count at the exact boundary', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!
      const atLimit = Array.from({ length: 128 }, (_, i) => `arg${i}`)
      const overLimit = Array.from({ length: 129 }, (_, i) => `arg${i}`)

      expect(() => handler(trustedEvent(), { type: 'stdio', name: 'srv', command: 'node', args: atLimit })).not.toThrow()
      expect(() => handler(trustedEvent(), { type: 'stdio', name: 'srv', command: 'node', args: overLimit })).toThrow('MCP 参数格式错误')
    })

    it('rejects an array containing a non-string entry', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', args: ['ok', 42],
      })).toThrow('MCP 参数格式错误')
    })

    it('accepts a valid array of strings unchanged', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', args: ['--flag', 'value'],
      })).not.toThrow()
      expect(extensionService.addMcpServer).toHaveBeenCalledWith(expect.objectContaining({ args: ['--flag', 'value'] }))
    })
  })

  describe('parseSettings (settings:save)', () => {
    it('accepts a fully valid settings payload and trims the workspace', async () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: '  D:\\workspace  ',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
      })).resolves.toEqual({
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
      })
      expect(service.writeStoredConfig).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'D:\\workspace' }))
    })

    it('rejects a non-record payload', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), null)).rejects.toThrow('设置格式错误')
      await expect(handler(trustedEvent(), 'settings')).rejects.toThrow('设置格式错误')
      await expect(handler(trustedEvent(), [])).rejects.toThrow('设置格式错误')
    })

    it('rejects a version other than 2', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 1,
        workspace: 'D:\\workspace',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
      })).rejects.toThrow('设置格式错误')
    })

    it('rejects an invalid theme', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'blue',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
      })).rejects.toThrow('主题格式错误')
    })

    it('rejects non-boolean checkUpdatesOnStartup/runDiagnosticsOnStartup flags', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!
      const base = { version: 2, workspace: 'D:\\workspace', theme: 'dark' as const }

      await expect(handler(trustedEvent(), {
        ...base, checkUpdatesOnStartup: 'yes', runDiagnosticsOnStartup: false,
      })).rejects.toThrow('设置格式错误')
      await expect(handler(trustedEvent(), {
        ...base, checkUpdatesOnStartup: true, runDiagnosticsOnStartup: 1,
      })).rejects.toThrow('设置格式错误')
    })

    it('rejects an invalid workspace', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!
      const base = { version: 2, theme: 'dark' as const, checkUpdatesOnStartup: true, runDiagnosticsOnStartup: false }

      await expect(handler(trustedEvent(), { ...base, workspace: '' })).rejects.toThrow('工作目录格式错误')
      await expect(handler(trustedEvent(), { ...base, workspace: 'x'.repeat(32_768) })).rejects.toThrow('工作目录格式错误')
      await expect(handler(trustedEvent(), { ...base, workspace: 42 })).rejects.toThrow('工作目录格式错误')
    })

    it('ignores unknown extra fields without forwarding them', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'dark',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        unexpectedField: 'should be ignored',
      })).resolves.not.toHaveProperty('unexpectedField')
    })

    it('omits sidebarMoreExpanded when absent, preserving pre-#67 behavior', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'dark',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
      })).resolves.not.toHaveProperty('sidebarMoreExpanded')
    })

    it('accepts and forwards an explicit sidebarMoreExpanded flag', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'dark',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        sidebarMoreExpanded: true,
      })).resolves.toMatchObject({ sidebarMoreExpanded: true })
    })

    it('drops an explicit sidebarMoreExpanded: false back to the omitted default', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'dark',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        sidebarMoreExpanded: false,
      })).resolves.not.toHaveProperty('sidebarMoreExpanded')
    })

    it('rejects a non-boolean sidebarMoreExpanded', async () => {
      register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'dark',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        sidebarMoreExpanded: 'yes',
      })).rejects.toThrow('侧边栏展开状态格式错误')
    })
  })

  describe('parseMcpInput (mcp:add)', () => {
    it('accepts a valid stdio definition, trimming the name and env key', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'stdio',
        name: '  My Server  ',
        command: 'node',
        args: ['server.js', '--flag'],
        env: { '  FOO  ': 'bar value' },
      })).not.toThrow()
      expect(extensionService.addMcpServer).toHaveBeenCalledWith({
        type: 'stdio',
        name: 'My Server',
        command: 'node',
        args: ['server.js', '--flag'],
        env: { FOO: 'bar value' },
      })
    })

    it('accepts a valid http definition with optional fields omitted', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), { type: 'http', name: 'Remote', url: 'https://example.com/mcp' })).not.toThrow()
      expect(extensionService.addMcpServer).toHaveBeenCalledWith({
        type: 'http',
        name: 'Remote',
        url: 'https://example.com/mcp',
        bearerTokenEnvVar: undefined,
        oauthClientId: undefined,
        oauthResource: undefined,
      })
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), 'not-an-object')).toThrow('MCP 配置格式错误')
      expect(() => handler(trustedEvent(), null)).toThrow('MCP 配置格式错误')
    })

    it('rejects a missing or invalid name before the type is even checked', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), { type: 'http', url: 'https://example.com' })).toThrow('MCP 名称格式错误')
      expect(() => handler(trustedEvent(), { type: 'http', name: '', url: 'https://example.com' })).toThrow('MCP 名称格式错误')
    })

    it('rejects an unrecognized type', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), { type: 'websocket', name: 'srv' })).toThrow('MCP 类型错误')
      expect(() => handler(trustedEvent(), { name: 'srv' })).toThrow('MCP 类型错误')
    })

    it('rejects a stdio env value that is not a record', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', env: 'not-an-object',
      })).toThrow('MCP 环境变量格式错误')
      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', env: null,
      })).toThrow('MCP 环境变量格式错误')
    })

    it('rejects a stdio env entry that is not a string or exceeds the length limit', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', env: { FOO: 42 },
      })).toThrow('MCP 环境变量格式错误')
      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', env: { FOO: 'x'.repeat(4_097) },
      })).toThrow('MCP 环境变量格式错误')
    })

    it('accepts a stdio env with exactly 128 entries at the boundary', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('mcp:add')!
      const env = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`VAR_${i}`, 'value']))

      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', env,
      })).not.toThrow()
      expect(extensionService.addMcpServer).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({ VAR_0: 'value', VAR_127: 'value' }),
      }))
    })

    it('rejects a stdio env with more than 128 entries', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!
      const env = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`VAR_${i}`, 'value']))

      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', env,
      })).toThrow('MCP 环境变量数量过多')
    })

    it('rejects a stdio env key that is invalid', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'stdio', name: 'srv', command: 'node', env: { '': 'value' },
      })).toThrow('环境变量名格式错误')
    })

    it('rejects a missing or invalid stdio command', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), { type: 'stdio', name: 'srv' })).toThrow('MCP 命令格式错误')
      expect(() => handler(trustedEvent(), { type: 'stdio', name: 'srv', command: '   ' })).toThrow('MCP 命令格式错误')
    })

    it('rejects a missing or invalid http url', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), { type: 'http', name: 'srv' })).toThrow('MCP 地址格式错误')
    })

    it('rejects an oversized bearerTokenEnvVar', () => {
      register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'http',
        name: 'srv',
        url: 'https://example.com',
        bearerTokenEnvVar: 'x'.repeat(129),
      })).toThrow('Bearer Token 环境变量名格式错误')
    })

    it('treats an empty optional oauthClientId as absent rather than rejecting it', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('mcp:add')!

      expect(() => handler(trustedEvent(), {
        type: 'http',
        name: 'srv',
        url: 'https://example.com',
        oauthClientId: '',
      })).not.toThrow()
      expect(extensionService.addMcpServer).toHaveBeenCalledWith(expect.objectContaining({ oauthClientId: undefined }))
    })
  })

  describe('parseMarketplaceInput (marketplaces:add)', () => {
    it('accepts a valid marketplace payload', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('marketplaces:add')!

      expect(() => handler(trustedEvent(), {
        source: 'github:acme/repo',
        ref: 'main',
        sparse: ['plugins/a', 'plugins/b'],
      })).not.toThrow()
      expect(extensionService.addMarketplace).toHaveBeenCalledWith({
        source: 'github:acme/repo',
        ref: 'main',
        sparse: ['plugins/a', 'plugins/b'],
      })
    })

    it('defaults ref and sparse when omitted', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('marketplaces:add')!

      expect(() => handler(trustedEvent(), { source: 'github:acme/repo' })).not.toThrow()
      expect(extensionService.addMarketplace).toHaveBeenCalledWith({
        source: 'github:acme/repo',
        ref: undefined,
        sparse: [],
      })
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:add')!

      expect(() => handler(trustedEvent(), 'source-only')).toThrow('市场配置格式错误')
      expect(() => handler(trustedEvent(), ['github:acme/repo'])).toThrow('市场配置格式错误')
    })

    it('rejects a missing or invalid source', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:add')!

      expect(() => handler(trustedEvent(), {})).toThrow('市场来源格式错误')
      expect(() => handler(trustedEvent(), { source: 123 })).toThrow('市场来源格式错误')
    })

    it('rejects an oversized ref', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:add')!

      expect(() => handler(trustedEvent(), { source: 'github:acme/repo', ref: 'x'.repeat(257) })).toThrow('Git Ref格式错误')
    })

    it('rejects a sparse value that is not an array', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:add')!

      expect(() => handler(trustedEvent(), { source: 'github:acme/repo', sparse: 'plugins/a' })).toThrow('Sparse 路径格式错误')
    })

    it('rejects a sparse array exceeding the item limit', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:add')!
      const overLimit = Array.from({ length: 129 }, (_, i) => `path/${i}`)

      expect(() => handler(trustedEvent(), { source: 'github:acme/repo', sparse: overLimit })).toThrow('Sparse 路径格式错误')
    })

    it('rejects a sparse array containing a non-string entry', () => {
      register()
      const handler = electronMocks.handlers.get('marketplaces:add')!

      expect(() => handler(trustedEvent(), { source: 'github:acme/repo', sparse: ['ok', null] })).toThrow('Sparse 路径格式错误')
    })
  })

  describe('parseSkillInput (skills:import)', () => {
    it('accepts a valid sourcePath without a scope', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('skills:import')!

      expect(() => handler(trustedEvent(), { sourcePath: 'C:\\skills\\my-skill' })).not.toThrow()
      expect(extensionService.importSkill).toHaveBeenCalledWith({ sourcePath: 'C:\\skills\\my-skill', scope: undefined })
    })

    it('accepts valid scope values', () => {
      const { extensionService } = register()
      const handler = electronMocks.handlers.get('skills:import')!

      expect(() => handler(trustedEvent(), { sourcePath: 'C:\\skills\\a', scope: 'user' })).not.toThrow()
      expect(() => handler(trustedEvent(), { sourcePath: 'C:\\skills\\b', scope: 'repo' })).not.toThrow()
      expect(extensionService.importSkill).toHaveBeenNthCalledWith(1, { sourcePath: 'C:\\skills\\a', scope: 'user' })
      expect(extensionService.importSkill).toHaveBeenNthCalledWith(2, { sourcePath: 'C:\\skills\\b', scope: 'repo' })
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('skills:import')!

      expect(() => handler(trustedEvent(), 'C:\\skills\\a')).toThrow('Skill 导入格式错误')
    })

    it('rejects an invalid scope value', () => {
      register()
      const handler = electronMocks.handlers.get('skills:import')!

      expect(() => handler(trustedEvent(), { sourcePath: 'C:\\skills\\a', scope: 'global' })).toThrow('Skill 范围格式错误')
    })

    it('rejects a missing or invalid sourcePath', () => {
      register()
      const handler = electronMocks.handlers.get('skills:import')!

      expect(() => handler(trustedEvent(), {})).toThrow('Skill 路径格式错误')
      expect(() => handler(trustedEvent(), { sourcePath: '' })).toThrow('Skill 路径格式错误')
    })

    it('rejects an oversized sourcePath', () => {
      register()
      const handler = electronMocks.handlers.get('skills:import')!

      expect(() => handler(trustedEvent(), { sourcePath: 'C:\\'.padEnd(32_768, 'a') })).toThrow('Skill 路径格式错误')
    })
  })

  describe('parseProviderExtensionMutation (extensions:mutate)', () => {
    it('accepts a minimal valid mutation without an mcp payload', () => {
      const { providerExtensionService } = register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), { provider: 'claude', kind: 'skill', action: 'enable' })).not.toThrow()
      expect(providerExtensionService.mutate).toHaveBeenCalledWith({
        provider: 'claude',
        kind: 'skill',
        action: 'enable',
        id: undefined,
        source: undefined,
        scope: undefined,
        mcp: undefined,
      })
    })

    it('accepts optional id, source and scope', () => {
      const { providerExtensionService } = register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'codex',
        kind: 'plugin',
        action: 'update',
        id: 'plugin-id',
        source: 'marketplace/plugin',
        scope: 'project',
      })).not.toThrow()
      expect(providerExtensionService.mutate).toHaveBeenCalledWith(expect.objectContaining({
        id: 'plugin-id',
        source: 'marketplace/plugin',
        scope: 'project',
      }))
    })

    it('rejects a non-record payload or an unknown provider', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), 'claude')).toThrow('扩展操作格式错误')
      expect(() => handler(trustedEvent(), { provider: 'unknown-cli', kind: 'mcp', action: 'install' })).toThrow('扩展操作格式错误')
    })

    it('rejects an invalid kind', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), { provider: 'claude', kind: 'theme', action: 'install' })).toThrow('扩展类型错误')
    })

    it('rejects an invalid action', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), { provider: 'claude', kind: 'mcp', action: 'delete' })).toThrow('扩展操作类型错误')
    })

    it('rejects an invalid scope', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', scope: 'global',
      })).toThrow('扩展范围错误')
    })

    it('accepts a valid http mcp sub-payload', () => {
      const { providerExtensionService } = register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'codex',
        kind: 'mcp',
        action: 'install',
        mcp: { type: 'http', url: 'https://example.com/mcp' },
      })).not.toThrow()
      expect(providerExtensionService.mutate).toHaveBeenCalledWith(expect.objectContaining({
        mcp: { type: 'http', url: 'https://example.com/mcp' },
      }))
    })

    it('accepts a valid stdio mcp sub-payload', () => {
      const { providerExtensionService } = register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'codex',
        kind: 'mcp',
        action: 'install',
        mcp: { type: 'stdio', command: 'python', args: ['-m', 'server'], env: { KEY: 'value' } },
      })).not.toThrow()
      expect(providerExtensionService.mutate).toHaveBeenCalledWith(expect.objectContaining({
        mcp: { type: 'stdio', command: 'python', args: ['-m', 'server'], env: { KEY: 'value' } },
      }))
    })

    it('rejects a non-record mcp sub-payload', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', mcp: 'stdio',
      })).toThrow('MCP 安装配置格式错误')
    })

    it('rejects an unknown mcp type', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', mcp: { type: 'websocket' },
      })).toThrow('MCP 安装配置类型错误')
    })

    it('rejects an invalid mcp.url for the http sub-type', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', mcp: { type: 'http' },
      })).toThrow('MCP 地址格式错误')
    })

    it('rejects an invalid mcp.command for the stdio sub-type', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', mcp: { type: 'stdio' },
      })).toThrow('MCP 命令格式错误')
    })

    it('rejects an oversized id', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', id: 'x'.repeat(513),
      })).toThrow('扩展 ID格式错误')
    })

    it('forwards normalized primitive strings even when kind/action/scope arrive boxed', () => {
      const { providerExtensionService } = register()
      const handler = electronMocks.handlers.get('extensions:mutate')!

      expect(() => handler(trustedEvent(), {
        provider: 'claude',
        kind: new String('mcp'),
        action: new String('install'),
        scope: new String('user'),
      })).not.toThrow()

      const forwarded = providerExtensionService.mutate.mock.calls[0][0]
      expect(forwarded.kind).toBe('mcp')
      expect(forwarded.action).toBe('install')
      expect(forwarded.scope).toBe('user')
    })

    it('accepts an mcp env sub-payload with exactly 128 entries at the boundary', () => {
      const { providerExtensionService } = register()
      const handler = electronMocks.handlers.get('extensions:mutate')!
      const env = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`VAR_${i}`, 'value']))

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', mcp: { type: 'stdio', command: 'python', env },
      })).not.toThrow()
      expect(providerExtensionService.mutate).toHaveBeenCalledWith(expect.objectContaining({
        mcp: expect.objectContaining({
          env: expect.objectContaining({ VAR_0: 'value', VAR_127: 'value' }),
        }),
      }))
    })

    it('rejects an mcp env sub-payload with more than 128 entries', () => {
      register()
      const handler = electronMocks.handlers.get('extensions:mutate')!
      const env = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`VAR_${i}`, 'value']))

      expect(() => handler(trustedEvent(), {
        provider: 'claude', kind: 'mcp', action: 'install', mcp: { type: 'stdio', command: 'python', env },
      })).toThrow('MCP 环境变量数量过多')
    })
  })

  describe('parseConfigSavePayload (config:save) additional edge cases', () => {
    it('rejects a null, array, or non-object payload', () => {
      register()
      const handler = electronMocks.handlers.get('config:save')!

      expect(() => handler(trustedEvent(), null)).toThrow('配置请求格式错误')
      expect(() => handler(trustedEvent(), [])).toThrow('配置请求格式错误')
      expect(() => handler(trustedEvent(), 'codex')).toThrow('配置请求格式错误')
    })

    it('enforces the apiKey length limit at the exact boundary', async () => {
      register()
      const handler = electronMocks.handlers.get('config:save')!
      const base = { provider: 'codex', model: 'gpt-5.6-sol', mode: 'merge' as const }

      await expect(handler(trustedEvent(), { ...base, apiKey: 'k'.repeat(4_096) })).resolves.toBeDefined()
      expect(() => handler(trustedEvent(), { ...base, apiKey: 'k'.repeat(4_097) })).toThrow('API Key 格式错误')
    })

    it('rejects an oversized model', () => {
      register()
      const handler = electronMocks.handlers.get('config:save')!

      expect(() => handler(trustedEvent(), {
        provider: 'codex', apiKey: 'sk-test', model: 'm'.repeat(257), mode: 'merge',
      })).toThrow('模型格式错误')
    })

    it('rejects an invalid save mode', () => {
      register()
      const handler = electronMocks.handlers.get('config:save')!

      expect(() => handler(trustedEvent(), {
        provider: 'codex', apiKey: 'sk-test', model: 'gpt-5.6-sol', mode: 'overwrite',
      })).toThrow('配置保存方式错误')
    })

    it('ignores unknown extra fields without forwarding them', async () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('config:save')!

      await expect(handler(trustedEvent(), {
        provider: 'codex',
        apiKey: 'sk-test',
        model: 'gpt-5.6-sol',
        mode: 'merge',
        extraField: 'ignored',
      })).resolves.toEqual({ backups: [], files: [] })
      expect(service.saveConfig).toHaveBeenCalledWith({
        provider: 'codex',
        apiKey: 'sk-test',
        model: 'gpt-5.6-sol',
        mode: 'merge',
      }, false)
    })
  })

  describe('parseWorkspace (cli:launch second argument)', () => {
    it('uses the trimmed workspace when a valid string is provided', () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('cli:launch')!

      expect(() => handler(trustedEvent(), 'claude', '  D:\\projects\\demo  ')).not.toThrow()
      expect(service.launchProvider).toHaveBeenCalledWith('claude', 'D:\\projects\\demo')
    })

    it('falls back to the stored workspace when omitted', () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('cli:launch')!

      expect(() => handler(trustedEvent(), 'claude', undefined)).not.toThrow()
      expect(service.launchProvider).toHaveBeenCalledWith('claude', 'C:\\workspace')
    })

    it('falls back to the stored workspace for a blank or whitespace-only value', () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('cli:launch')!

      expect(() => handler(trustedEvent(), 'claude', '   ')).not.toThrow()
      expect(service.launchProvider).toHaveBeenCalledWith('claude', 'C:\\workspace')
    })

    it('falls back to the stored workspace for a non-string value instead of throwing', () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('cli:launch')!

      expect(() => handler(trustedEvent(), 'claude', 12345)).not.toThrow()
      expect(service.launchProvider).toHaveBeenCalledWith('claude', 'C:\\workspace')
    })

    it('rejects a workspace string exceeding the maximum length', () => {
      register()
      const handler = electronMocks.handlers.get('cli:launch')!

      expect(() => handler(trustedEvent(), 'claude', 'x'.repeat(32_768))).toThrow('工作目录格式错误')
    })
  })

  describe('parseDesktopLaunchMode (desktop:launch-codex)', () => {
    it('accepts "open" and "restart"', () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('desktop:launch-codex')!
      const event = trustedEvent()

      expect(() => handler(event, 'open')).not.toThrow()
      expect(() => handler(event, 'restart')).not.toThrow()
      expect(service.launchCodexDesktop).toHaveBeenNthCalledWith(1, 'open', event.sender)
      expect(service.launchCodexDesktop).toHaveBeenNthCalledWith(2, 'restart', event.sender)
    })

    it('rejects any other value', () => {
      register()
      const handler = electronMocks.handlers.get('desktop:launch-codex')!

      for (const bad of ['Open', 'close', 1, null, undefined, {}]) {
        expect(() => handler(trustedEvent(), bad)).toThrow('Codex 桌面端启动方式错误')
      }
    })
  })

  describe('parseSessionId (sessions:detail/export/archive/restore)', () => {
    const validId = 'a1b2c3d4-e5f6-47a8-89ab-cdef01234567'

    it('accepts a well-formed 36-character UUID', () => {
      const { sessionsService } = register()
      const handler = electronMocks.handlers.get('sessions:detail')!

      expect(() => handler(trustedEvent(), validId)).not.toThrow()
      expect(sessionsService.detail).toHaveBeenCalledWith(validId)
    })

    it('accepts uppercase hex characters', () => {
      const { sessionsService } = register()
      const handler = electronMocks.handlers.get('sessions:archive')!
      const upper = validId.toUpperCase()

      expect(() => handler(trustedEvent(), upper)).not.toThrow()
      expect(sessionsService.archive).toHaveBeenCalledWith(upper)
    })

    it('rejects non-string values', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:detail')!

      for (const bad of [42, null, undefined, {}, []]) {
        expect(() => handler(trustedEvent(), bad)).toThrow('会话 ID 格式错误')
      }
    })

    it('rejects values with the wrong length', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:detail')!

      expect(() => handler(trustedEvent(), validId.slice(0, 35))).toThrow('会话 ID 格式错误')
      expect(() => handler(trustedEvent(), `${validId}0`)).toThrow('会话 ID 格式错误')
    })

    it('rejects relative path traversal payloads', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:detail')!

      expect(() => handler(trustedEvent(), '../../../../../../etc/passwd')).toThrow('会话 ID 格式错误')
      expect(() => handler(trustedEvent(), '..%2f..%2f..%2fetc%2fpasswd')).toThrow('会话 ID 格式错误')
    })

    it('rejects backslash-based traversal payloads', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:detail')!

      expect(() => handler(trustedEvent(), '..\\..\\..\\windows\\system32')).toThrow('会话 ID 格式错误')
    })

    it('rejects absolute path payloads', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:detail')!

      expect(() => handler(trustedEvent(), '/etc/passwd')).toThrow('会话 ID 格式错误')
      expect(() => handler(trustedEvent(), 'C:\\Windows\\System32\\config')).toThrow('会话 ID 格式错误')
    })

    it('rejects a payload containing a null byte', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:detail')!

      expect(() => handler(trustedEvent(), `${'a'.repeat(35)}\0`)).toThrow('会话 ID 格式错误')
    })

    it('does not enforce UUID hyphen positions, but still excludes traversal characters', () => {
      // Documents the actual (looser than RFC 4122) contract: any 36 characters
      // drawn from [0-9a-f-] pass, because this regex's job is blocking path
      // traversal characters, not validating UUID shape (see CLAUDE.md I5).
      const { sessionsService } = register()
      const handler = electronMocks.handlers.get('sessions:restore')!
      const allHyphens = '-'.repeat(36)

      expect(() => handler(trustedEvent(), allHyphens)).not.toThrow()
      expect(sessionsService.restore).toHaveBeenCalledWith(allHyphens)
    })

    it('applies the same rejection to sessions:export, sessions:archive and sessions:restore', async () => {
      register()
      const badId = 'not-a-valid-session-id'

      await expect(electronMocks.handlers.get('sessions:export')!(trustedEvent(), badId)).rejects.toThrow('会话 ID 格式错误')
      expect(() => electronMocks.handlers.get('sessions:archive')!(trustedEvent(), badId)).toThrow('会话 ID 格式错误')
      expect(() => electronMocks.handlers.get('sessions:restore')!(trustedEvent(), badId)).toThrow('会话 ID 格式错误')
    })
  })

  describe('parseSessionListQuery (sessions:list)', () => {
    it('defaults to an empty query when the argument is undefined', () => {
      const { sessionsService } = register()
      const handler = electronMocks.handlers.get('sessions:list')!

      expect(() => handler(trustedEvent(), undefined)).not.toThrow()
      expect(sessionsService.list).toHaveBeenCalledWith({})
    })

    it('rejects a null, array, or non-object query', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:list')!

      expect(() => handler(trustedEvent(), null)).toThrow('会话查询格式错误')
      expect(() => handler(trustedEvent(), [])).toThrow('会话查询格式错误')
      expect(() => handler(trustedEvent(), 'active')).toThrow('会话查询格式错误')
    })

    it('rejects an invalid archive filter', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:list')!

      expect(() => handler(trustedEvent(), { archive: 'deleted' })).toThrow('会话归档筛选格式错误')
    })

    it('accepts every valid archive filter value', () => {
      const { sessionsService } = register()
      const handler = electronMocks.handlers.get('sessions:list')!

      for (const archive of ['all', 'active', 'archived'] as const) {
        expect(() => handler(trustedEvent(), { archive })).not.toThrow()
        expect(sessionsService.list).toHaveBeenCalledWith(expect.objectContaining({ archive }))
      }
    })

    it('rejects a search string exceeding the maximum length', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:list')!

      expect(() => handler(trustedEvent(), { search: 'x'.repeat(257) })).toThrow('会话搜索内容过长')
    })

    it('rejects a non-string search value with a distinct type error', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:list')!

      for (const bad of [42, true, null, {}, []]) {
        expect(() => handler(trustedEvent(), { search: bad })).toThrow('会话搜索内容格式错误')
      }
    })

    it('rejects a non-integer or sub-1 page number', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:list')!

      for (const bad of [0, -1, 1.5, '2', Number.NaN]) {
        expect(() => handler(trustedEvent(), { page: bad })).toThrow('页码格式错误')
      }
    })

    it('rejects a non-integer or sub-1 pageSize', () => {
      register()
      const handler = electronMocks.handlers.get('sessions:list')!

      expect(() => handler(trustedEvent(), { pageSize: 0 })).toThrow('分页大小格式错误')
      expect(() => handler(trustedEvent(), { pageSize: '20' })).toThrow('分页大小格式错误')
    })

    it('accepts valid search, page and pageSize values together', () => {
      const { sessionsService } = register()
      const handler = electronMocks.handlers.get('sessions:list')!

      expect(() => handler(trustedEvent(), {
        search: 'refactor', archive: 'active', page: 2, pageSize: 20,
      })).not.toThrow()
      expect(sessionsService.list).toHaveBeenCalledWith({
        search: 'refactor', archive: 'active', page: 2, pageSize: 20,
      })
    })
  })

  describe('parseProviderSessionListQuery (provider-sessions:list)', () => {
    it('defaults to an empty query when the argument is undefined', () => {
      const { providerSessionsService } = register()
      const handler = electronMocks.handlers.get('provider-sessions:list')!

      expect(() => handler(trustedEvent(), undefined)).not.toThrow()
      expect(providerSessionsService.list).toHaveBeenCalledWith({})
    })

    it('rejects a null, array, or non-object query', () => {
      register()
      const handler = electronMocks.handlers.get('provider-sessions:list')!

      expect(() => handler(trustedEvent(), null)).toThrow('会话查询格式错误')
      expect(() => handler(trustedEvent(), [])).toThrow('会话查询格式错误')
    })

    it('rejects an unknown provider', () => {
      register()
      const handler = electronMocks.handlers.get('provider-sessions:list')!

      expect(() => handler(trustedEvent(), { provider: 'chatgpt' })).toThrow('会话工具类型错误')
    })

    it('accepts "all" and every known provider id', () => {
      const { providerSessionsService } = register()
      const handler = electronMocks.handlers.get('provider-sessions:list')!

      for (const provider of ['all', ...providerSessionProviders] as const) {
        expect(() => handler(trustedEvent(), { provider })).not.toThrow()
        expect(providerSessionsService.list).toHaveBeenCalledWith(expect.objectContaining({ provider }))
      }
    })

    it('rejects a search string exceeding the maximum length', () => {
      register()
      const handler = electronMocks.handlers.get('provider-sessions:list')!

      expect(() => handler(trustedEvent(), { search: 'y'.repeat(257) })).toThrow('会话搜索内容过长')
    })

    it('rejects a non-string search value with a distinct type error', () => {
      register()
      const handler = electronMocks.handlers.get('provider-sessions:list')!

      for (const bad of [42, true, null, {}, []]) {
        expect(() => handler(trustedEvent(), { search: bad })).toThrow('会话搜索内容格式错误')
      }
    })

    it('rejects invalid page/pageSize values', () => {
      register()
      const handler = electronMocks.handlers.get('provider-sessions:list')!

      expect(() => handler(trustedEvent(), { page: -1 })).toThrow('页码格式错误')
      expect(() => handler(trustedEvent(), { pageSize: 0.5 })).toThrow('分页大小格式错误')
    })
  })

  describe('parseRendererError (runtime-logs:renderer-error)', () => {
    it('accepts a message-only payload', () => {
      const { runtimeLog } = register()
      const handler = electronMocks.handlers.get('runtime-logs:renderer-error')!

      expect(() => handler(trustedEvent(), { message: 'Boom' })).not.toThrow()
      expect(runtimeLog.log).toHaveBeenCalledWith('error', 'renderer', 'renderer.error', 'Boom', {
        context: null,
        stack: null,
      })
    })

    it('accepts an optional stack and context alongside the message', () => {
      const { runtimeLog } = register()
      const handler = electronMocks.handlers.get('runtime-logs:renderer-error')!

      expect(() => handler(trustedEvent(), {
        message: 'Boom',
        stack: 'at foo()',
        context: 'renderer-crash',
      })).not.toThrow()
      expect(runtimeLog.log).toHaveBeenCalledWith('error', 'renderer', 'renderer.error', 'Boom', {
        context: 'renderer-crash',
        stack: 'at foo()',
      })
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('runtime-logs:renderer-error')!

      expect(() => handler(trustedEvent(), 'Boom')).toThrow('渲染进程错误格式无效')
      expect(() => handler(trustedEvent(), null)).toThrow('渲染进程错误格式无效')
    })

    it('rejects a missing or invalid message', () => {
      register()
      const handler = electronMocks.handlers.get('runtime-logs:renderer-error')!

      expect(() => handler(trustedEvent(), {})).toThrow('错误消息格式错误')
      expect(() => handler(trustedEvent(), { message: '' })).toThrow('错误消息格式错误')
      expect(() => handler(trustedEvent(), { message: 42 })).toThrow('错误消息格式错误')
    })

    it('rejects an oversized stack', () => {
      register()
      const handler = electronMocks.handlers.get('runtime-logs:renderer-error')!

      expect(() => handler(trustedEvent(), { message: 'Boom', stack: 'x'.repeat(16_385) })).toThrow('错误堆栈格式错误')
    })

    it('rejects an oversized context', () => {
      register()
      const handler = electronMocks.handlers.get('runtime-logs:renderer-error')!

      expect(() => handler(trustedEvent(), { message: 'Boom', context: 'x'.repeat(257) })).toThrow('错误上下文格式错误')
    })
  })

  describe('parseAccountRegisterInput (account:register)', () => {
    it('parses a valid registration payload and forwards it to the account service', async () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:register')!

      await expect(handler(trustedEvent(), {
        username: '  new-user  ',
        email: '  new-user@example.com  ',
        password: 'correct horse battery staple',
        verificationCode: '123456',
      })).resolves.toBeUndefined()

      expect(accountService.register).toHaveBeenCalledWith({
        email: 'new-user@example.com',
        password: 'correct horse battery staple',
        verificationCode: '123456',
        username: 'new-user',
        affCode: undefined,
      })
    })

    it('forwards an explicit affiliate code instead of defaulting it', async () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:register')!

      await handler(trustedEvent(), {
        username: 'custom-handle',
        email: 'new-user@example.com',
        password: 'correct horse battery staple',
        verificationCode: '123456',
        affCode: 'promo-1',
      })

      expect(accountService.register).toHaveBeenCalledWith({
        email: 'new-user@example.com',
        password: 'correct horse battery staple',
        verificationCode: '123456',
        username: 'custom-handle',
        affCode: 'promo-1',
      })
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('account:register')!

      expect(() => handler(trustedEvent(), 'nope')).toThrow('注册信息格式错误')
      expect(() => handler(trustedEvent(), null)).toThrow('注册信息格式错误')
    })

    it('rejects a missing or blank email', () => {
      register()
      const handler = electronMocks.handlers.get('account:register')!

      expect(() => handler(trustedEvent(), { username: 'user', password: 'x'.repeat(10), verificationCode: '1' })).toThrow('邮箱地址格式错误')
      expect(() => handler(trustedEvent(), { username: 'user', email: '  ', password: 'x'.repeat(10), verificationCode: '1' })).toThrow('邮箱地址格式错误')
    })

    it('rejects a missing or blank username -- no longer silently defaulted to the email', () => {
      register()
      const handler = electronMocks.handlers.get('account:register')!

      expect(() => handler(trustedEvent(), { email: 'a@b.com', password: 'x'.repeat(10), verificationCode: '1' })).toThrow('用户名格式错误')
      expect(() => handler(trustedEvent(), { username: '  ', email: 'a@b.com', password: 'x'.repeat(10), verificationCode: '1' })).toThrow('用户名格式错误')
    })

    it('rejects a missing, empty, or oversized password without trimming it', () => {
      register()
      const handler = electronMocks.handlers.get('account:register')!

      expect(() => handler(trustedEvent(), { username: 'user', email: 'a@b.com', verificationCode: '1' })).toThrow('密码格式错误')
      expect(() => handler(trustedEvent(), { username: 'user', email: 'a@b.com', password: '', verificationCode: '1' })).toThrow('密码格式错误')
      expect(() => handler(trustedEvent(), { username: 'user', email: 'a@b.com', password: 'x'.repeat(257), verificationCode: '1' })).toThrow('密码格式错误')
    })

    it('rejects a missing or blank verification code', () => {
      register()
      const handler = electronMocks.handlers.get('account:register')!

      expect(() => handler(trustedEvent(), { username: 'user', email: 'a@b.com', password: 'x'.repeat(10) })).toThrow('邮箱验证码格式错误')
      expect(() => handler(trustedEvent(), { username: 'user', email: 'a@b.com', password: 'x'.repeat(10), verificationCode: '  ' })).toThrow('邮箱验证码格式错误')
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:register')!

      expect(() => handler(trustedEvent(), { email: 'a@b.com' })).toThrow()
      expect(accountService.register).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountEmailInput (account:send-verification-code)', () => {
    it('trims a valid email and forwards it to the account service', async () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:send-verification-code')!

      await expect(handler(trustedEvent(), '  new-user@example.com  ')).resolves.toBeUndefined()

      expect(accountService.sendEmailVerification).toHaveBeenCalledWith('new-user@example.com')
    })

    it('rejects a missing, blank, or non-string email', () => {
      register()
      const handler = electronMocks.handlers.get('account:send-verification-code')!

      expect(() => handler(trustedEvent(), undefined)).toThrow('邮箱地址格式错误')
      expect(() => handler(trustedEvent(), '   ')).toThrow('邮箱地址格式错误')
      expect(() => handler(trustedEvent(), 42)).toThrow('邮箱地址格式错误')
    })

    it('rejects a non-empty value that is not a well-formed email address', () => {
      register()
      const handler = electronMocks.handlers.get('account:send-verification-code')!

      expect(() => handler(trustedEvent(), 'not-an-email')).toThrow('请输入正确的邮箱地址')
      expect(() => handler(trustedEvent(), 'missing-domain@')).toThrow('请输入正确的邮箱地址')
      expect(() => handler(trustedEvent(), '@missing-local.com')).toThrow('请输入正确的邮箱地址')
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:send-verification-code')!

      expect(() => handler(trustedEvent(), 'not-an-email')).toThrow()
      expect(accountService.sendEmailVerification).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountEmailInput (account:send-reset-code)', () => {
    it('trims a valid email and forwards it to the account service', async () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:send-reset-code')!

      await expect(handler(trustedEvent(), '  new-user@example.com  ')).resolves.toBeUndefined()

      expect(accountService.sendPasswordResetEmail).toHaveBeenCalledWith('new-user@example.com')
    })

    it('rejects a missing, blank, or non-string email', () => {
      register()
      const handler = electronMocks.handlers.get('account:send-reset-code')!

      expect(() => handler(trustedEvent(), undefined)).toThrow('邮箱地址格式错误')
      expect(() => handler(trustedEvent(), '   ')).toThrow('邮箱地址格式错误')
      expect(() => handler(trustedEvent(), 42)).toThrow('邮箱地址格式错误')
    })

    it('rejects a non-empty value that is not a well-formed email address', () => {
      register()
      const handler = electronMocks.handlers.get('account:send-reset-code')!

      expect(() => handler(trustedEvent(), 'not-an-email')).toThrow('请输入正确的邮箱地址')
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:send-reset-code')!

      expect(() => handler(trustedEvent(), 'not-an-email')).toThrow()
      expect(accountService.sendPasswordResetEmail).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountPasswordResetInput (account:reset-password)', () => {
    it('parses a valid reset payload and forwards it to the account service', async () => {
      const { accountService } = register()
      vi.mocked(accountService.resetPassword).mockResolvedValue({ newPassword: 'freshly-generated-1' })
      const handler = electronMocks.handlers.get('account:reset-password')!

      await expect(handler(trustedEvent(), {
        email: '  new-user@example.com  ',
        token: '  abc123token  ',
      })).resolves.toEqual({ newPassword: 'freshly-generated-1' })

      expect(accountService.resetPassword).toHaveBeenCalledWith({
        email: 'new-user@example.com',
        token: 'abc123token',
      })
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('account:reset-password')!

      expect(() => handler(trustedEvent(), 'nope')).toThrow('重置密码信息格式错误')
      expect(() => handler(trustedEvent(), null)).toThrow('重置密码信息格式错误')
    })

    it('rejects a missing or malformed email using the same rule as account:send-reset-code', () => {
      register()
      const handler = electronMocks.handlers.get('account:reset-password')!

      expect(() => handler(trustedEvent(), { token: 'abc123' })).toThrow('邮箱地址格式错误')
      expect(() => handler(trustedEvent(), { email: 'not-an-email', token: 'abc123' })).toThrow('请输入正确的邮箱地址')
    })

    it('rejects a missing or blank token', () => {
      register()
      const handler = electronMocks.handlers.get('account:reset-password')!

      expect(() => handler(trustedEvent(), { email: 'a@b.com' })).toThrow('重置码格式错误')
      expect(() => handler(trustedEvent(), { email: 'a@b.com', token: '   ' })).toThrow('重置码格式错误')
    })

    it('rejects an oversized token', () => {
      register()
      const handler = electronMocks.handlers.get('account:reset-password')!

      expect(() => handler(trustedEvent(), { email: 'a@b.com', token: 'x'.repeat(257) })).toThrow('重置码格式错误')
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:reset-password')!

      expect(() => handler(trustedEvent(), { email: 'not-an-email', token: 'abc' })).toThrow()
      expect(accountService.resetPassword).not.toHaveBeenCalled()
    })
  })
})
