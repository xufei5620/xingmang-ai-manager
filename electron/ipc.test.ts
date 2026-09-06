import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SystemService } from './system-service'
import type { UpdaterService } from './updater'
import { mergeAppSettings, type AppSettings, type AppSettingsUpdate } from './app-settings'
import type { NativeConfigSaveResult } from './config-files'
import type { NewApiClientService } from './new-api-client'
import { ipcInvokeChannels } from './ipc-contract'
import { providerSessionProviders } from './provider-sessions'
import { resolveRelaySite, supportServiceUrl } from './relay-sites'
import { savedAccountId } from './saved-accounts'
import { createWindowCloseQuery } from './window-close-query'
import { managedCliKeyProfiles, providerIds } from './catalog'
import { resolveXingmangAiBundledSkillRoot } from './xingmang-ai-skill'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  browserWindowFromWebContents: vi.fn<(...args: unknown[]) => unknown>(() => undefined),
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

const stubStoredConfig: AppSettings = {
  version: 2,
  workspace: 'C:\\workspace',
  theme: 'dark',
  checkUpdatesOnStartup: true,
  runDiagnosticsOnStartup: false,
}

function serviceStub(): SystemService {
  return {
    readStoredConfig: vi.fn((): AppSettings => ({ ...stubStoredConfig })),
    // Mirrors the real store's merge so the settings:save tests below assert
    // the actual round-trip contract (absent field = keep the stored value),
    // not a hand-rolled approximation of it.
    updateStoredConfig: vi.fn(async (update: AppSettingsUpdate) => mergeAppSettings(stubStoredConfig, update)),
    inspectCodexReadiness: vi.fn(() => ({ hasApiKey: true, matchesRelay: true })),
    getConfig: vi.fn(() => ({ workspace: 'C:\\workspace', providers: {} })) as never,
    revealApiKey: vi.fn(() => 'sk-known-secret-value'),
    saveConfig: vi.fn(async (): Promise<NativeConfigSaveResult> => ({ backups: [], files: [] })),
    switchToOfficialAccount: vi.fn((): NativeConfigSaveResult => ({ backups: [], files: [] })),
    scanSystem: vi.fn() as never,
    refreshOfficialChatGptUsage: vi.fn() as never,
    inspectCodexSetupStatus: vi.fn() as never,
    installNodeRuntime: vi.fn() as never,
    restartWindows: vi.fn() as never,
    installPythonRuntime: vi.fn() as never,
    installCli: vi.fn() as never,
    uninstallCli: vi.fn() as never,
    inspectCliUpdate: vi.fn() as never,
    installCodexDesktop: vi.fn() as never,
    uninstallCodexDesktop: vi.fn() as never,
    inspectCodexDesktopUpdate: vi.fn() as never,
    launchProvider: vi.fn() as never,
    inspectCodexDesktop: vi.fn() as never,
    inspectCodexDesktopLocale: vi.fn() as never,
    inspectCodexWorkspacePermissions: vi.fn() as never,
    trustCodexWorkspace: vi.fn() as never,
    setCodexDesktopLocale: vi.fn() as never,
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
    // new-api (the only backend today) reports every RelayBackendCapabilities
    // flag as true -- see relay-backend.ts / new-api-client.ts's
    // newApiCapabilities -- so the stub matches that shape rather than
    // inventing its own.
    capabilities: {
      supportsRegistration: true,
      supportsPasswordReset: true,
      supportsKeyManagement: true,
      supportsUsage: true,
      supportsBilling: true,
      supportsSubscriptions: true,
      supportsProfileUpdate: true,
      supportsSessionManagement: true,
      supportsAutoKeyProvision: true,
      supportsAccountSession: true,
    },
    getStatus: vi.fn() as never,
    getLegalDocument: vi.fn() as never,
    sendEmailVerification: vi.fn(async () => undefined),
    sendPasswordResetEmail: vi.fn(async () => undefined),
    resetPassword: vi.fn(async () => ({ newPassword: 'stub-generated-password' })),
    register: vi.fn(async () => undefined),
    login: vi.fn() as never,
    logout: vi.fn(),
    isAuthenticated: vi.fn(() => false),
    getSessionState: vi.fn(() => ({ authenticated: false, account: null })),
    getBalance: vi.fn() as never,
    getTopupInfo: vi.fn() as never,
    quoteTopupAmount: vi.fn() as never,
    createTopupPayment: vi.fn() as never,
    listTopupOrders: vi.fn() as never,
    redeemTopupCode: vi.fn() as never,
    transferAffiliateQuota: vi.fn() as never,
    listSubscriptionPlans: vi.fn() as never,
    getSubscriptionSelf: vi.fn() as never,
    updateSubscriptionPreference: vi.fn() as never,
    createSubscriptionPayment: vi.fn() as never,
    purchaseSubscriptionWithBalance: vi.fn() as never,
    getProfile: vi.fn() as never,
    updateDisplayName: vi.fn() as never,
    getUsage: vi.fn() as never,
    getDashboard: vi.fn() as never,
    getTasks: vi.fn() as never,
    listKeys: vi.fn() as never,
    listUsableGroups: vi.fn() as never,
    revokeKey: vi.fn() as never,
    revealKey: vi.fn() as never,
    createKey: vi.fn(async () => undefined),
    updateKey: vi.fn(async () => undefined),
    changePassword: vi.fn() as never,
    listLoginSessions: vi.fn() as never,
    revokeLoginSession: vi.fn() as never,
    revokeOtherLoginSessions: vi.fn() as never,
    provisionCliKey: vi.fn() as never,
    findExistingCliKey: vi.fn() as never,
    refreshAccessToken: vi.fn() as never,
    getPersistableSession: vi.fn(() => null),
    getSessionRevision: vi.fn(() => 0),
    restoreSession: vi.fn(async () => false),
    switchSession: vi.fn(async () => false),
  }
}

function trustedEvent(url = 'http://localhost:5173/', senderId = 101) {
  return {
    senderFrame: { url },
    sender: {
      id: senderId,
      getURL: () => url,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
    },
  }
}

type ChatIpcOverrides = Partial<Pick<Parameters<typeof registerIpcHandlers>[0],
  'chatKeyStore' | 'chatCredentials' | 'chatService' | 'imageService' | 'aiAssets' | 'xingmangAiSkill' | 'savedAccounts' | 'getWindowCapabilities' | 'replyWindowClose' | 'takeExternalDeepLink'>>

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

function paymentWindowStub() {
  return {
    open: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    destroy: vi.fn(),
  }
}

function register(
  service = serviceStub(),
  runtimeLogDirectory = 'C:\\app-data\\logs',
  transformSystemSnapshot?: (snapshot: never) => never,
  accountService = accountServiceStub(),
  accountCredentials?: {
    read: () => Promise<{ version: 1; identifier: string; password: string } | null>
    save: (identifier: string, password: string) => Promise<void>
    clear: () => Promise<void>
  },
  managedCliKeys?: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']>,
  chatOverrides: ChatIpcOverrides = {},
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
    captureFeedbackReport: vi.fn(async () => ({ text: 'sanitized report\n', entries: 0 })),
    clear: vi.fn(async () => undefined),
  }
  const paymentWindow = paymentWindowStub()
  const dispose = registerIpcHandlers({
    systemService: service,
    accountService,
    paymentWindow,
    accountCredentials,
    managedCliKeys,
    ...chatOverrides,
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
      'https://xm.solov.cc',
      supportServiceUrl,
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
    paymentWindow,
    sessionsService,
    providerSessionsService,
  }
}

beforeEach(() => {
  electronMocks.handlers.clear()
  electronMocks.handle.mockClear()
  electronMocks.removeHandler.mockClear()
  electronMocks.showOpenDialog.mockReset()
  electronMocks.showSaveDialog.mockReset()
  electronMocks.showMessageBox.mockReset()
  electronMocks.showMessageBox.mockResolvedValue({ response: 0 })
  electronMocks.openExternal.mockReset()
  electronMocks.openExternal.mockResolvedValue(undefined)
  electronMocks.openPath.mockReset()
  electronMocks.openPath.mockResolvedValue('')
  electronMocks.writeText.mockReset()
  electronMocks.browserWindowFromWebContents.mockReset()
  electronMocks.browserWindowFromWebContents.mockReturnValue(undefined)
})

describe('registerIpcHandlers', () => {
  it('registers and disposes the existing IPC contract', () => {
    const { dispose } = register()
    const expectedChannels = Object.values(ipcInvokeChannels)
    expect([...electronMocks.handlers.keys()]).toEqual(expectedChannels)

    dispose()

    expect(electronMocks.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(expectedChannels)
  })

  describe('saved-account switch isolation', () => {
    const origin = new URL(resolveRelaySite(undefined).accountBaseUrl!).origin
    const accountA = { authenticated: true, account: { userId: 1, username: 'account-a', group: null, role: 1, quota: 100, usedQuota: 0 } }
    const accountB = { authenticated: true, account: { userId: 2, username: 'account-b', group: null, role: 1, quota: 200, usedQuota: 0 } }
    const id = savedAccountId(origin, 2)
    const setup = () => {
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue(accountA)
      const savedAccounts = { list: vi.fn(async () => []), getSession: vi.fn(async () => ({ userId: 2, cookies: ['refresh_token=saved-private-cookie'] })), remove: vi.fn(async () => undefined) }
      const chatService = { cancelUser: vi.fn(() => 1), cancelAll: vi.fn(() => 2), dispose: vi.fn() }
      const imageService = { cancelUser: vi.fn(() => 1), cancelAll: vi.fn(() => 2) }
      const registered = register(serviceStub(), 'C:\\app-data\\logs', undefined, accountService, undefined, undefined, { savedAccounts, chatService, imageService } as never)
      return { ...registered, savedAccounts, chatService, imageService, handler: electronMocks.handlers.get('account:switch-saved')! }
    }

    it.each(['invalid-session', 'network-failure', 'encrypted-index-failure'] as const)('does not cancel A or close its payment window when switching fails: %s', async (failure) => {
      const h = setup()
      if (failure === 'network-failure') vi.mocked(h.accountService.switchSession).mockRejectedValueOnce(new Error('请求超时'))
      if (failure === 'encrypted-index-failure') h.savedAccounts.getSession.mockRejectedValueOnce(new Error('系统加密服务不可用'))
      await expect(h.handler(trustedEvent(), id)).rejects.toThrow()
      expect(h.accountService.getSessionState()).toEqual(accountA)
      expect(h.chatService.cancelUser).not.toHaveBeenCalled()
      expect(h.chatService.cancelAll).not.toHaveBeenCalled()
      expect(h.imageService.cancelUser).not.toHaveBeenCalled()
      expect(h.imageService.cancelAll).not.toHaveBeenCalled()
      expect(h.paymentWindow.destroy).not.toHaveBeenCalled()
      expect(h.accountService.logout).not.toHaveBeenCalled()
    })

    it('deduplicates a pending target and cancels only A after B has been verified', async () => {
      const h = setup()
      let accept!: (value: boolean) => void
      vi.mocked(h.accountService.switchSession).mockImplementationOnce(() => new Promise<boolean>((resolve) => { accept = resolve }))
      const first = h.handler(trustedEvent(), id)
      const duplicate = h.handler(trustedEvent(), id)
      await vi.waitFor(() => expect(h.accountService.switchSession).toHaveBeenCalledOnce())
      expect(h.chatService.cancelUser).not.toHaveBeenCalled()
      expect(h.paymentWindow.destroy).not.toHaveBeenCalled()
      expect(() => h.handler(trustedEvent(), savedAccountId(origin, 3))).toThrow('正在切换账号')
      vi.mocked(h.accountService.getSessionState).mockReturnValue(accountB)
      accept(true)
      await expect(first).resolves.toEqual(accountB)
      await expect(duplicate).resolves.toEqual(accountB)
      expect(h.savedAccounts.getSession).toHaveBeenCalledWith(id, origin)
      expect(h.chatService.cancelUser).toHaveBeenCalledExactlyOnceWith(1)
      expect(h.imageService.cancelUser).toHaveBeenCalledExactlyOnceWith(1)
      expect(h.chatService.cancelAll).not.toHaveBeenCalled()
      expect(h.imageService.cancelAll).not.toHaveBeenCalled()
      expect(h.paymentWindow.destroy).toHaveBeenCalledOnce()
      expect(h.accountService.logout).not.toHaveBeenCalled()
      expect(JSON.stringify(await duplicate)).not.toContain('saved-private-cookie')
    })

    it('switching to the current account is a no-op and cannot cancel its tasks', async () => {
      const h = setup()
      await expect(h.handler(trustedEvent(), savedAccountId(origin, 1))).resolves.toEqual(accountA)
      expect(h.savedAccounts.getSession).not.toHaveBeenCalled()
      expect(h.accountService.switchSession).not.toHaveBeenCalled()
      expect(h.chatService.cancelUser).not.toHaveBeenCalled()
      expect(h.chatService.cancelAll).not.toHaveBeenCalled()
      expect(h.imageService.cancelUser).not.toHaveBeenCalled()
      expect(h.paymentWindow.destroy).not.toHaveBeenCalled()
    })

    it.each(['logout', 'different-account', 'same-account-reauthentication', 'pending-login'] as const)('does not proceed after the session changes during saved credential read: %s', async (transition) => {
      const h = setup()
      let resolveCandidate!: (session: { userId: number; cookies: string[] }) => void
      h.savedAccounts.getSession.mockImplementationOnce(() => new Promise((resolve) => { resolveCandidate = resolve }))
      const rejected = expect(h.handler(trustedEvent(), id)).rejects.toThrow('账号已切换')
      await vi.waitFor(() => expect(h.savedAccounts.getSession).toHaveBeenCalledOnce())
      vi.mocked(h.accountService.getSessionRevision).mockReturnValue(1)
      if (transition === 'logout') vi.mocked(h.accountService.getSessionState).mockReturnValue({ authenticated: false, account: null })
      if (transition === 'different-account') vi.mocked(h.accountService.getSessionState).mockReturnValue(accountB)
      // Reauthentication may expose the same user ID, and pending login may
      // leave the same public profile. Only the internal revision distinguishes them.
      resolveCandidate({ userId: 2, cookies: ['refresh_token=private-candidate'] })
      await rejected
      expect(h.accountService.switchSession).not.toHaveBeenCalled()
      expect(h.chatService.cancelUser).not.toHaveBeenCalled()
      expect(h.imageService.cancelUser).not.toHaveBeenCalled()
      expect(h.paymentWindow.destroy).not.toHaveBeenCalled()
    })

    it('rejects an invalid ID or untrusted sender before touching a saved credential', () => {
      const h = setup()
      expect(() => h.handler(trustedEvent(), '../account-session.dat')).toThrow('账号标识无效')
      expect(() => h.handler(trustedEvent('https://attacker.example/'), id)).toThrow('非应用页面')
      expect(h.savedAccounts.getSession).not.toHaveBeenCalled()
      expect(h.accountService.switchSession).not.toHaveBeenCalled()
      expect(h.chatService.cancelUser).not.toHaveBeenCalled()
    })

    it('never exposes credential fields while listing or permits removing the active identity', async () => {
      const h = setup()
      h.savedAccounts.list.mockResolvedValueOnce([
        { id: savedAccountId(origin, 1), origin, userId: 1, username: 'A', updatedAt: '2026-09-07T00:00:00.000Z', cookies: ['must-not-leak'] },
        { id: 'different-site', origin: 'https://other.example.com', userId: 1, username: 'Other', updatedAt: '2026-09-07T00:00:00.000Z' },
      ] as never)
      const listed = await electronMocks.handlers.get('account:list-saved')!(trustedEvent())
      expect(listed).toEqual([{ id: savedAccountId(origin, 1), origin, userId: 1, username: 'A', updatedAt: '2026-09-07T00:00:00.000Z' }])
      expect(JSON.stringify(listed)).not.toContain('must-not-leak')
      await expect(electronMocks.handlers.get('account:remove-saved')!(trustedEvent(), savedAccountId(origin, 1))).rejects.toThrow('当前账号')
      expect(h.savedAccounts.remove).not.toHaveBeenCalled()
    })
  })

  describe('window close nonce and sender forwarding', () => {
    it('preserves WebContents ownership, validates display state and rejects stale nonces', async () => {
      const owner = trustedEvent()
      const send = vi.fn()
      const query = createWindowCloseQuery(send)
      const replyWindowClose: NonNullable<Parameters<typeof registerIpcHandlers>[0]['replyWindowClose']> = vi.fn((sender, requestId, report) => sender === (owner.sender as unknown) ? query.reply(requestId, report) : false)
      register(serviceStub(), 'C:\\app-data\\logs', undefined, accountServiceStub(), undefined, undefined, { replyWindowClose })
      const handler = electronMocks.handlers.get('window:close-report')!
      const pending = query.request()
      void pending.catch(() => undefined)
      const nonce = send.mock.calls[0][0]
      try {
        expect(handler(trustedEvent(), nonce, { blockingTask: false, unsavedChanges: false })).toBe(false)
        expect(handler(owner, 'stale-nonce', { blockingTask: false, unsavedChanges: false })).toBe(false)
        expect(() => handler(owner, nonce, { blockingTask: 'false', unsavedChanges: false })).toThrow('格式错误')
        expect(() => handler(trustedEvent('https://attacker.example/'), nonce, { blockingTask: false, unsavedChanges: false })).toThrow('非应用页面')
        expect(handler(owner, nonce, { blockingTask: true, unsavedChanges: false, token: 'discard-me' })).toBe(true)
        await expect(pending).resolves.toEqual({ blockingTask: true, unsavedChanges: false })
        expect(replyWindowClose).toHaveBeenLastCalledWith(owner.sender, nonce, { blockingTask: true, unsavedChanges: false })
        expect(handler(owner, nonce, { blockingTask: false, unsavedChanges: false })).toBe(false)
        const next = query.request()
        void next.catch(() => undefined)
        expect(send.mock.calls[1][0]).not.toBe(nonce)
        expect(handler(owner, nonce, { blockingTask: false, unsavedChanges: false })).toBe(false)
        expect(handler(owner, send.mock.calls[1][0], { blockingTask: false, unsavedChanges: true })).toBe(true)
        await expect(next).resolves.toEqual({ blockingTask: false, unsavedChanges: true })
      } finally { query.dispose() }
    })

    it('returns null for unavailable deep links and delegates the exact sender when supported', () => {
      register()
      expect(electronMocks.handlers.get('navigation:take-deep-link')!(trustedEvent())).toBeNull()
      const takeExternalDeepLink = vi.fn(() => ({ kind: 'invite' as const, code: 'fixture-code' }))
      register(serviceStub(), 'C:\\app-data\\logs', undefined, accountServiceStub(), undefined, undefined, { takeExternalDeepLink })
      const owner = trustedEvent()
      const handler = electronMocks.handlers.get('navigation:take-deep-link')!
      expect(handler(owner)).toEqual({ kind: 'invite', code: 'fixture-code' })
      expect(takeExternalDeepLink).toHaveBeenCalledExactlyOnceWith(owner.sender)
      expect(() => handler(trustedEvent('https://attacker.example/'))).toThrow('非应用页面')
      expect(takeExternalDeepLink).toHaveBeenCalledOnce()
    })
  })

  describe('feedback preview snapshot contracts', () => {
    it('copies and exports exactly the previewed text and count despite later log changes', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-feedback-ipc-'))
      try {
        const { runtimeLog } = register()
        runtimeLog.captureFeedbackReport.mockResolvedValueOnce({ text: 'preview snapshot A\n', entries: 7 })
        const owner = trustedEvent()
        const preview = await electronMocks.handlers.get('runtime-logs:preview-feedback')!(owner) as { id: string; text: string; entries: number }
        runtimeLog.feedbackReport.mockResolvedValue('newer unpreviewed snapshot B\n')
        await expect(electronMocks.handlers.get('runtime-logs:copy-feedback')!(owner, preview.id)).resolves.toEqual({ entries: 7 })
        expect(electronMocks.writeText).toHaveBeenCalledExactlyOnceWith(preview.text)
        const outputPath = path.join(directory, 'report.txt')
        electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outputPath })
        await expect(electronMocks.handlers.get('runtime-logs:export-feedback')!(owner, preview.id)).resolves.toEqual({ outputPath })
        expect(fs.readFileSync(outputPath, 'utf8')).toBe(preview.text)
        expect(runtimeLog.feedbackReport).not.toHaveBeenCalled()
        expect(runtimeLog.snapshot).not.toHaveBeenCalled()
        expect(runtimeLog.captureFeedbackReport).toHaveBeenCalledOnce()
      } finally { fs.rmSync(directory, { recursive: true, force: true }) }
    })

    it('isolates previews by sender and rejects an expired or superseded report before any output', async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000)
      try {
        register()
        const owner = trustedEvent()
        const getPreview = electronMocks.handlers.get('runtime-logs:preview-feedback')!
        const copy = electronMocks.handlers.get('runtime-logs:copy-feedback')!
        const first = await getPreview(owner) as { id: string }
        await expect(copy(trustedEvent(undefined, 102), first.id)).rejects.toThrow('已过期')
        const current = await getPreview(owner) as { id: string }
        await expect(copy(owner, first.id)).rejects.toThrow('已过期')
        clock.mockReturnValue(100_000 + 30 * 60 * 1_000 + 1)
        await expect(copy(owner, current.id)).rejects.toThrow('已过期')
        await expect(electronMocks.handlers.get('runtime-logs:export-feedback')!(owner, current.id)).rejects.toThrow('已过期')
        expect(electronMocks.writeText).not.toHaveBeenCalled()
        expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
      } finally { clock.mockRestore() }
    })

    it('retains the chosen snapshot across the save dialog while a new preview is generated', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-feedback-ipc-'))
      try {
        const { runtimeLog } = register()
        runtimeLog.captureFeedbackReport.mockResolvedValueOnce({ text: 'chosen preview A\n', entries: 1 }).mockResolvedValueOnce({ text: 'later preview B\n', entries: 2 })
        const owner = trustedEvent()
        const first = await electronMocks.handlers.get('runtime-logs:preview-feedback')!(owner) as { id: string }
        let choosePath!: (value: unknown) => void
        electronMocks.showSaveDialog.mockImplementationOnce(() => new Promise((resolve) => { choosePath = resolve }))
        const exporting = electronMocks.handlers.get('runtime-logs:export-feedback')!(owner, first.id)
        await electronMocks.handlers.get('runtime-logs:preview-feedback')!(owner)
        const outputPath = path.join(directory, 'report.txt')
        choosePath({ canceled: false, filePath: outputPath })
        await expect(exporting).resolves.toEqual({ outputPath })
        expect(fs.readFileSync(outputPath, 'utf8')).toBe('chosen preview A\n')
      } finally { fs.rmSync(directory, { recursive: true, force: true }) }
    })

    it('allows clipboard retry and save cancellation without changing the preview', async () => {
      const { runtimeLog } = register()
      const owner = trustedEvent()
      const preview = await electronMocks.handlers.get('runtime-logs:preview-feedback')!(owner) as { id: string; text: string }
      electronMocks.writeText.mockImplementationOnce(() => { throw new Error('Clipboard unavailable') })
      await expect(electronMocks.handlers.get('runtime-logs:copy-feedback')!(owner, preview.id)).rejects.toThrow('Clipboard unavailable')
      await expect(electronMocks.handlers.get('runtime-logs:copy-feedback')!(owner, preview.id)).resolves.toEqual({ entries: 0 })
      electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
      await expect(electronMocks.handlers.get('runtime-logs:export-feedback')!(owner, preview.id)).resolves.toBeNull()
      expect(electronMocks.writeText).toHaveBeenLastCalledWith(preview.text)
      expect(runtimeLog.captureFeedbackReport).toHaveBeenCalledOnce()
    })
  })

  it('binds chat requests and cancellation to the trusted sender without exposing credentials', async () => {
    const accountService = accountServiceStub()
    vi.mocked(accountService.getSessionState).mockReturnValue({
      authenticated: true,
      account: { userId: 7 },
    } as never)
    const chatCredentials = {
      listGroups: vi.fn(async () => [{ name: 'codex-pro', description: 'Codex', ratio: 1 }]),
      prepareGroup: vi.fn(async () => ({
        group: 'codex-pro', models: ['gpt-5.6-sol'], keyCreated: false,
      })),
      resolveCredential: vi.fn(),
    }
    const chatService = {
      start: vi.fn(() => ({ requestId: 'request-1', accepted: true as const })),
      cancel: vi.fn(() => false),
      cancelSender: vi.fn(() => 0),
      cancelUser: vi.fn(() => 0),
      cancelAll: vi.fn(() => 0),
      activeCount: vi.fn(() => 0),
      whenIdle: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const imageService = {
      generate: vi.fn(async () => []),
      cancel: vi.fn(() => ({ canceled: true, mayStillComplete: true })),
      cancelSender: vi.fn(() => 0),
      cancelUser: vi.fn(() => 0),
      cancelAll: vi.fn(() => 0),
    }
    const { dispose } = register(
      serviceStub(),
      'C:\\app-data\\logs',
      undefined,
      accountService,
      undefined,
      undefined,
      { chatCredentials, chatService, imageService } as never,
    )
    const start = electronMocks.handlers.get('chat:start')!
    const input = {
      requestId: 'request-1',
      group: 'codex-pro',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
    }

    expect(() => start(trustedEvent('https://attacker.example/', 9), input))
      .toThrow('已拒绝来自非应用页面的操作请求')
    expect(chatService.start).not.toHaveBeenCalled()

    const ownerEvent = trustedEvent(undefined, 17)
    expect(start(ownerEvent, input)).toEqual({ requestId: 'request-1', accepted: true })
    expect(chatService.start).toHaveBeenCalledWith(expect.objectContaining({ senderId: 17, ...input }))
    expect(JSON.stringify(await start(trustedEvent(undefined, 18), input))).not.toMatch(/apiKey|Authorization|Bearer|sk-secret/i)

    const generateImage = electronMocks.handlers.get('chat:generate-image')!
    await expect(generateImage(trustedEvent(undefined, 17), {
      requestId: 'image-1', group: '生图分组', model: 'gpt-image-2', prompt: '海浪', imageResolution: '4K',
    })).resolves.toEqual([])
    expect(imageService.generate).toHaveBeenCalledWith(17, {
      requestId: 'image-1', group: '生图分组', model: 'gpt-image-2', prompt: '海浪', imageResolution: '4K', expectedUserId: 7,
    })
    expect(() => generateImage(trustedEvent(undefined, 17), {
      requestId: 'image-bad', group: '生图分组', model: 'gpt-image-2', prompt: '海浪', imageResolution: '8K',
    })).toThrow('生图清晰度格式错误')

    const cancel = electronMocks.handlers.get('chat:cancel')!
    expect(cancel(trustedEvent(undefined, 22), 'request-1')).toEqual({
      canceled: true,
      mayStillComplete: true,
    })
    expect(chatService.cancel).toHaveBeenCalledWith(22, 'request-1')
    expect(imageService.cancel).toHaveBeenCalledWith(22, 'request-1')

    const destroyed = vi.mocked(ownerEvent.sender.once).mock.calls.find(([event]) => event === 'destroyed')?.[1]
    expect(destroyed).toBeTypeOf('function')
    ;(destroyed as () => void)()
    expect(chatService.cancelSender).toHaveBeenCalledWith(17)
    expect(imageService.cancelSender).toHaveBeenCalledWith(17)

    dispose()
  })

  it('cancels both text and image requests before logging out', async () => {
    const accountService = accountServiceStub()
    vi.mocked(accountService.logout).mockResolvedValue(undefined)
    const chatService = { cancelAll: vi.fn(() => 2), dispose: vi.fn() }
    const imageService = { cancelAll: vi.fn(() => 1) }
    const { paymentWindow } = register(
      serviceStub(),
      'C:\\app-data\\logs',
      undefined,
      accountService,
      undefined,
      undefined,
      { chatService, imageService } as never,
    )

    await expect(electronMocks.handlers.get('account:logout')!(trustedEvent())).resolves.toBeUndefined()
    expect(chatService.cancelAll).toHaveBeenCalledOnce()
    expect(imageService.cancelAll).toHaveBeenCalledOnce()
    expect(paymentWindow.destroy).toHaveBeenCalledOnce()
    expect(accountService.logout).toHaveBeenCalledOnce()
  })

  it('installs the bundled 星芒AI skill on key sync without returning the image key', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ai-skill-ipc-'))
    const accountService = accountServiceStub()
    vi.mocked(accountService.getSessionState).mockReturnValue({
      authenticated: true,
      account: { userId: 9 },
    } as never)
    vi.mocked(accountService.listUsableGroups).mockResolvedValue([
      { name: '图片模型-中转/订阅', description: '', ratio: 1 },
    ])
    vi.mocked(accountService.provisionCliKey).mockImplementation(async (input) => ({
      id: 7,
      name: input?.name ?? 'key',
      key: 'sk-ipc-must-not-return-this-secret-key',
    }))
    const cached = providerIds.map((provider, index) => ({
      id: index + 1,
      provider,
      group: managedCliKeyProfiles[provider].group,
      name: managedCliKeyProfiles[provider].keyName,
      key: `sk-cached-${provider}-not-for-ipc`,
    }))
    register(
      serviceStub(),
      'C:\\app-data\\logs',
      undefined,
      accountService,
      undefined,
      {
        read: vi.fn(async () => cached),
        save: vi.fn(),
        remove: vi.fn(),
        captureRevision: vi.fn(() => 1),
      },
      {
        xingmangAiSkill: {
          bundledRoot: resolveXingmangAiBundledSkillRoot(path.resolve(__dirname, '..')),
          userHome,
        },
      },
    )

    try {
      const summary = await electronMocks.handlers.get('account:sync-managed-cli-keys')!(trustedEvent())
      expect(JSON.stringify(summary)).not.toContain('sk-ipc-must-not-return-this-secret-key')
      const configPath = path.join(userHome, '.agents', 'skills', '星芒AI', 'config.json')
      expect(fs.readFileSync(configPath, 'utf8')).toContain('sk-ipc-must-not-return-this-secret-key')
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true })
    }
  })

  it('persists a selected workspace and updates the repository context', async () => {
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\project'],
    })
    const { service, extensionService, providerExtensionService } = register()

    await expect(electronMocks.handlers.get('workspace:choose')!(trustedEvent())).resolves.toBe('D:\\project')
    expect(service.updateStoredConfig).toHaveBeenCalledWith({ version: 2, workspace: 'D:\\project' })
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

  it('routes Python 3.12 installation through the trusted service and runtime log', async () => {
    const service = serviceStub()
    vi.mocked(service.installPythonRuntime).mockResolvedValue({
      installed: true,
      action: 'installed',
      method: 'winget',
      source: 'winget',
      version: 'Python 3.12',
      architecture: 'x64',
      pathRefreshRequired: true,
    })
    const { runtimeLog } = register(service)
    const event = trustedEvent()

    await expect(electronMocks.handlers.get('runtime:install-python')!(event)).resolves.toMatchObject({
      action: 'installed',
      version: 'Python 3.12',
    })
    expect(service.installPythonRuntime).toHaveBeenCalledWith(event.sender)
    expect(runtimeLog.log).toHaveBeenCalledWith(
      'info', 'maintenance', 'runtime.python.install.completed', 'Python 3.12 自动安装完成',
      expect.objectContaining({ method: 'winget', source: 'winget', version: 'Python 3.12' }),
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

  it('refreshes official ChatGPT usage without a full system scan', async () => {
    const service = serviceStub()
    vi.mocked(service.refreshOfficialChatGptUsage).mockResolvedValueOnce({
      planLabel: 'Pro 5x',
      renewsAt: '2026-09-22T11:32:00.000Z',
      resetCredits: 1,
      windows: [],
      checkedAt: '2026-08-24T00:00:00.000Z',
    })
    register(service)

    await expect(
      electronMocks.handlers.get('system:refresh-official-chatgpt')!(trustedEvent()),
    ).resolves.toMatchObject({ planLabel: 'Pro 5x', resetCredits: 1 })
    expect(service.refreshOfficialChatGptUsage).toHaveBeenCalledOnce()
    expect(service.scanSystem).not.toHaveBeenCalled()
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

    await expect(handler(trustedEvent(), 'https://xm.solov.cc')).resolves.toBe(true)
    expect(electronMocks.openExternal).toHaveBeenCalledOnce()
    expect(electronMocks.showMessageBox).not.toHaveBeenCalled()
  })

  it('opens only the exact enterprise WeChat support URL', async () => {
    register()
    const handler = electronMocks.handlers.get(ipcInvokeChannels.openExternal)!

    await expect(handler(trustedEvent(), supportServiceUrl)).resolves.toBe(true)
    expect(electronMocks.openExternal).toHaveBeenCalledWith(supportServiceUrl)

    electronMocks.openExternal.mockClear()
    for (const hostileUrl of [
      supportServiceUrl + '?redirect=1',
      supportServiceUrl + '/extra',
      // Derived from the constant so a support-account change cannot quietly
      // turn these into assertions about a URL nobody uses any more.
      supportServiceUrl.replace('work.weixin.qq.com', 'work.weixin.qq.com.evil.example'),
      supportServiceUrl.replace('https://', 'http://'),
    ]) {
      await expect(handler(trustedEvent(), hostileUrl)).rejects.toThrow('不允许打开该链接')
    }
    expect(electronMocks.openExternal).not.toHaveBeenCalled()
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
          baseUrl: 'https://xm.solov.cc/v1',
          actualBaseUrl: 'https://xm.solov.cc/v1',
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

  it('lists models for an existing CLI config without returning its API key to the renderer', async () => {
    const service = serviceStub()
    vi.mocked(service.fetchAvailableModels).mockResolvedValue(['gpt-5.6-sol', 'gpt-5.6-terra'])
    const { runtimeLog } = register(service)
    const handler = electronMocks.handlers.get('models:list-configured')!

    await expect(handler(trustedEvent(), 'codex')).resolves.toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])
    expect(service.revealApiKey).toHaveBeenCalledWith('codex', false)
    expect(service.fetchAvailableModels).toHaveBeenCalledWith('sk-known-secret-value')
    expect(JSON.stringify(runtimeLog.log.mock.calls)).not.toContain('sk-known-secret-value')
    expect(() => handler(trustedEvent(), 'unknown')).toThrow('未知的 CLI 类型')
  })

  it('does not query models when an existing CLI config has no saved API key', () => {
    const service = serviceStub()
    vi.mocked(service.revealApiKey).mockReturnValue('')
    register(service)
    const handler = electronMocks.handlers.get('models:list-configured')!

    expect(() => handler(trustedEvent(), 'gemini')).toThrow('未读取到已保存的 API Key')
    expect(service.fetchAvailableModels).not.toHaveBeenCalled()
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
      paymentWindow: paymentWindowStub(),
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

  it('round-trips the remembered login through the injected credential store, strips the version field, and validates the set payload', async () => {
    const stored = { version: 1 as const, identifier: 'boss@qq.com', password: 'hunter2!' }
    const accountCredentials = {
      read: vi.fn(async () => stored),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    }
    const { dispose } = register(undefined, undefined, undefined, undefined, accountCredentials)
    try {
      const get = electronMocks.handlers.get('account:get-remembered-login')!
      // The persisted record's version field must not cross IPC (I3-style
      // exact-DTO discipline on a channel that already carries a secret).
      await expect(get(trustedEvent())).resolves.toEqual({ identifier: 'boss@qq.com', password: 'hunter2!' })

      const set = electronMocks.handlers.get('account:set-remembered-login')!
      await expect(set(trustedEvent(), { identifier: ' boss@qq.com ', password: 'hunter2!' })).resolves.toBeUndefined()
      expect(accountCredentials.save).toHaveBeenCalledWith('boss@qq.com', 'hunter2!')
      await expect(set(trustedEvent(), null)).resolves.toBeUndefined()
      expect(accountCredentials.clear).toHaveBeenCalledTimes(1)
      await expect(set(trustedEvent(), { identifier: '', password: 'x' })).rejects.toThrow()
      await expect(set(trustedEvent(), { identifier: 'a', password: '' })).rejects.toThrow('密码格式错误')
    } finally {
      dispose()
    }
  })

  it('degrades the remembered login to null and drops writes when no credential store is injected', async () => {
    const { dispose } = register()
    try {
      await expect(electronMocks.handlers.get('account:get-remembered-login')!(trustedEvent())).resolves.toBeNull()
      await expect(
        electronMocks.handlers.get('account:set-remembered-login')!(trustedEvent(), { identifier: 'a', password: 'b' }),
      ).resolves.toBeUndefined()
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
      paymentWindow: paymentWindowStub(),
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
      paymentWindow: paymentWindowStub(),
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

  describe('parseSettingsUpdate (settings:save)', () => {
    it('persists appearance updates without replacing unrelated settings', async () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('settings:save')!
      const patch = { version: 2, uiSkin: 'mist', reducedMotion: true, uiScale: '90', closeBehavior: 'tray' }
      await expect(handler(trustedEvent(), patch)).resolves.toMatchObject({
        workspace: 'C:\\workspace', uiSkin: 'mist', reducedMotion: true, uiScale: '90', closeBehavior: 'tray',
      })
      expect(service.updateStoredConfig).toHaveBeenCalledWith(patch)
    })

    it.each([
      { uiSkin: ['mist'] }, { uiSkin: 'unknown' }, { uiScale: 90 }, { uiScale: '500' },
      { closeBehavior: 'hide-anywhere' }, { reducedMotion: 'true' },
      { windowState: { bounds: { x: 0, y: 0, width: -1, height: 600 }, maximized: false } },
    ])('rejects malformed appearance and window updates before persistence: %j', async (fields) => {
      const { service } = register()
      const handler = electronMocks.handlers.get('settings:save')!
      await expect(handler(trustedEvent(), { version: 2, ...fields })).rejects.toThrow()
      expect(service.updateStoredConfig).not.toHaveBeenCalled()
    })

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
      expect(service.updateStoredConfig).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'D:\\workspace' }))
    })

    it('accepts a narrow single-field update and merges it over the stored record (①栏11)', async () => {
      // Regression for the stale-whole-record race: the sidebar "更多" toggle
      // now sends ONLY its own field, so an in-flight full save can no longer
      // be reverted by it (and vice versa) regardless of landing order.
      const { service } = register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        sidebarMoreExpanded: true,
      })).resolves.toEqual({
        version: 2,
        workspace: 'C:\\workspace',
        theme: 'dark',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        sidebarMoreExpanded: true,
      })
      expect(service.updateStoredConfig).toHaveBeenCalledWith({ version: 2, sidebarMoreExpanded: true })
    })

    it('keeps the stored relaySiteId when an update does not mention it', async () => {
      const service = serviceStub()
      vi.mocked(service.updateStoredConfig).mockImplementation(async (update) =>
        mergeAppSettings({ ...stubStoredConfig, relaySiteId: 'sub2api' }, update))
      register(service)
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        theme: 'light',
      })).resolves.toEqual(expect.objectContaining({ relaySiteId: 'sub2api', theme: 'light' }))
      expect(service.updateStoredConfig).toHaveBeenCalledWith({ version: 2, theme: 'light' })
    })

    it('forwards mirrorPolicy auto as the explicit clear marker (absent must mean keep)', async () => {
      const service = serviceStub()
      vi.mocked(service.updateStoredConfig).mockImplementation(async (update) =>
        mergeAppSettings({ ...stubStoredConfig, mirrorPolicy: 'official-first' }, update))
      register(service)
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        mirrorPolicy: 'auto',
      })).resolves.not.toHaveProperty('mirrorPolicy')
      expect(service.updateStoredConfig).toHaveBeenCalledWith({ version: 2, mirrorPolicy: 'auto' })
    })

    it('round-trips a known relaySiteId through settings:save (persisted and echoed back)', async () => {
      // Regression: parseSettings used to rebuild the object without
      // relaySiteId, so the renderer's own save silently reset the site
      // choice to the default -- the app-settings round-trip tests never
      // caught it because they bypass this IPC hop entirely.
      const { service } = register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        relaySiteId: 'solov',
      })).resolves.toEqual(expect.objectContaining({ relaySiteId: 'solov' }))
      expect(service.updateStoredConfig).toHaveBeenCalledWith(expect.objectContaining({ relaySiteId: 'solov' }))
    })

    it('round-trips the sub2api relaySiteId through settings:save too, not just the default solov site', async () => {
      // W3b: relay-sites.ts grew a second entry (731db23); this pins that
      // parseSettingsUpdate/updateStoredConfig accept it end to end through the
      // same real IPC handler as the 'solov' regression test above, not just
      // the one entry that happened to also be the registry's default id.
      const { service } = register()
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        relaySiteId: 'sub2api',
      })).resolves.toEqual(expect.objectContaining({ relaySiteId: 'sub2api' }))
      expect(service.updateStoredConfig).toHaveBeenCalledWith(expect.objectContaining({ relaySiteId: 'sub2api' }))
    })

    it('drops an unknown relaySiteId instead of failing the whole save', async () => {
      const { service } = register()
      const handler = electronMocks.handlers.get('settings:save')!

      const saved = await handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        relaySiteId: 'not-a-real-site',
      }) as Record<string, unknown>
      expect(saved.relaySiteId).toBeUndefined()
      expect(service.updateStoredConfig).toHaveBeenCalledWith(expect.not.objectContaining({ relaySiteId: expect.anything() }))
    })

    it('round-trips a pinned mirrorPolicy and degrades unknown values to keep-the-stored-policy (2.4)', async () => {
      // The stub merges against a base that already pins 'official-first' so
      // this test documents the real keep-persisted degrade contract: an
      // unknown policy string is dropped from the update (never forwarded)
      // and the stored pin therefore survives in the echoed record -- it is
      // NOT reset to auto the way the old whole-record parser did.
      const service = serviceStub()
      vi.mocked(service.updateStoredConfig).mockImplementation(async (update) =>
        mergeAppSettings({ ...stubStoredConfig, mirrorPolicy: 'official-first' }, update))
      register(service)
      const handler = electronMocks.handlers.get('settings:save')!

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        mirrorPolicy: 'official-first',
      })).resolves.toEqual(expect.objectContaining({ mirrorPolicy: 'official-first' }))
      expect(service.updateStoredConfig).toHaveBeenCalledWith(expect.objectContaining({ mirrorPolicy: 'official-first' }))

      await expect(handler(trustedEvent(), {
        version: 2,
        workspace: 'D:\\workspace',
        theme: 'light',
        checkUpdatesOnStartup: true,
        runDiagnosticsOnStartup: false,
        mirrorPolicy: 'fastest-first',
      })).resolves.toEqual(expect.objectContaining({ mirrorPolicy: 'official-first' }))
      expect(service.updateStoredConfig).toHaveBeenLastCalledWith(expect.not.objectContaining({ mirrorPolicy: expect.anything() }))
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

  describe('Codex Desktop locale handlers', () => {
    it('reads locale status through the main service', async () => {
      const { service } = register()
      const expected = {
        installed: true,
        version: '26.810.7004.0',
        running: false,
        configPath: 'C:\\Users\\tester\\.codex\\config.toml',
        configuredLocale: 'zh-CN',
        effectiveLocale: 'zh-CN',
        chineseResources: {
          available: true,
          frontendChunk: true,
          menuLocale: true,
          pakLocale: true,
          resourceRoot: 'C:\\Program Files\\WindowsApps\\Codex',
        },
        needsRestart: false,
        error: null,
      }
      vi.mocked(service.inspectCodexDesktopLocale).mockResolvedValueOnce(expected)

      await expect(electronMocks.handlers.get('desktop:codex-locale-status')!(trustedEvent()))
        .resolves.toEqual(expected)
      expect(service.inspectCodexDesktopLocale).toHaveBeenCalledOnce()
    })

    it('validates locale values before passing them to the main service', () => {
      const { service } = register()
      const event = trustedEvent()
      expect(() => electronMocks.handlers.get('desktop:set-codex-locale')!(event, 'zh-CN')).not.toThrow()
      expect(service.setCodexDesktopLocale).toHaveBeenCalledWith('zh-CN', event.sender)
      for (const value of ['ZH-CN', 'en-US', null, 1, undefined]) {
        expect(() => electronMocks.handlers.get('desktop:set-codex-locale')!(event, value)).toThrow('语言选项')
      }
    })
  })

  describe('Codex Desktop workspace permission handlers', () => {
    it('returns permission diagnostics without exposing config contents', async () => {
      const { service } = register()
      const expected = {
        configPath: 'C:\\Users\\tester\\.codex\\config.toml',
        workspace: 'C:\\workspace',
        configExists: true,
        trustLevel: 'untrusted',
        approvalPolicy: 'unless-trusted',
        permissionProfile: null,
        sandboxMode: 'workspace-write',
        control: 'restricted',
        error: null,
      } as const
      vi.mocked(service.inspectCodexWorkspacePermissions).mockReturnValueOnce(expected)

      expect(electronMocks.handlers.get('desktop:codex-permissions-status')!(trustedEvent()))
        .toEqual(expected)
      expect(service.inspectCodexWorkspacePermissions).toHaveBeenCalledOnce()
    })

    it('passes the renderer sender to the explicit trust operation', async () => {
      const { service } = register()
      vi.mocked(service.trustCodexWorkspace).mockResolvedValueOnce({
        backups: [],
        files: [],
        changed: true,
        restarted: false,
        status: {
          configPath: 'C:\\Users\\tester\\.codex\\config.toml',
          workspace: 'C:\\workspace',
          configExists: true,
          trustLevel: 'trusted',
          approvalPolicy: 'on-request',
          permissionProfile: null,
          sandboxMode: 'workspace-write',
          control: 'available',
          error: null,
        },
      })
      const event = trustedEvent()
      await expect(electronMocks.handlers.get('desktop:trust-workspace')!(event)).resolves.toMatchObject({
        changed: true,
        status: { trustLevel: 'trusted' },
      })
      expect(service.trustCodexWorkspace).toHaveBeenCalledWith(event.sender)
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

  describe('account:get-profile', () => {
    it('takes no arguments and returns the account service result as-is', async () => {
      const { accountService } = register()
      const profile = {
        userId: 42,
        username: 'tester',
        displayName: null,
        email: 'tester@example.com',
        group: 'default',
        quota: 1_000_000,
        usedQuota: 250_000,
        requestCount: 12,
        affCode: 'ABC123',
        affCount: 3,
        affQuota: 25_000,
        affHistoryQuota: 75_000,
      }
      vi.mocked(accountService.getProfile).mockResolvedValue(profile)
      const handler = electronMocks.handlers.get('account:get-profile')!

      await expect(handler(trustedEvent())).resolves.toEqual(profile)
      expect(accountService.getProfile).toHaveBeenCalledWith()
    })
  })

  describe('parseAccountUsageQuery (account:get-usage)', () => {
    it('parses a valid page/pageSize query and forwards it to the account service', async () => {
      const { accountService } = register()
      const page = { page: 2, pageSize: 20, total: 45, records: [], stats: { quota: 0, rpm: 0, tpm: 0 } }
      vi.mocked(accountService.getUsage).mockResolvedValue(page)
      const handler = electronMocks.handlers.get('account:get-usage')!

      await expect(handler(trustedEvent(), { page: 2, pageSize: 20 })).resolves.toEqual(page)
      expect(accountService.getUsage).toHaveBeenCalledWith({ page: 2, pageSize: 20 })
    })

    it('validates and forwards the complete usage filter set', async () => {
      const { accountService } = register()
      const page = { page: 1, pageSize: 50, total: 0, records: [], stats: { quota: 0, rpm: 0, tpm: 0 } }
      vi.mocked(accountService.getUsage).mockResolvedValue(page)
      const handler = electronMocks.handlers.get('account:get-usage')!
      const query = {
        page: 1, pageSize: 50, type: 2, startTimestamp: 1_700_000_000, endTimestamp: 1_700_086_400,
        modelName: ' gpt-5 ', tokenName: ' codex ', group: ' codex-pro ',
        requestId: ' req-1 ', upstreamRequestId: ' up-1 ',
      }

      await handler(trustedEvent(), query)

      expect(accountService.getUsage).toHaveBeenCalledWith({
        ...query, modelName: 'gpt-5', tokenName: 'codex', group: 'codex-pro', requestId: 'req-1', upstreamRequestId: 'up-1',
      })
    })

    it('defaults to an empty query object when no input is given', async () => {
      const { accountService } = register()
      vi.mocked(accountService.getUsage).mockResolvedValue({ page: 1, pageSize: 10, total: 0, records: [], stats: { quota: 0, rpm: 0, tpm: 0 } })
      const handler = electronMocks.handlers.get('account:get-usage')!

      await handler(trustedEvent(), undefined)

      expect(accountService.getUsage).toHaveBeenCalledWith({})
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('account:get-usage')!

      expect(() => handler(trustedEvent(), 'nope')).toThrow('用量查询参数格式错误')
      expect(() => handler(trustedEvent(), null)).toThrow('用量查询参数格式错误')
    })

    it('rejects a non-integer or out-of-range page', () => {
      register()
      const handler = electronMocks.handlers.get('account:get-usage')!

      expect(() => handler(trustedEvent(), { page: 0 })).toThrow('页码格式错误')
      expect(() => handler(trustedEvent(), { page: 1.5 })).toThrow('页码格式错误')
      expect(() => handler(trustedEvent(), { page: 'x' })).toThrow('页码格式错误')
    })

    it('rejects a page size outside 1..100 -- new-api clamps to 100 server-side (common/page_info.go)', () => {
      register()
      const handler = electronMocks.handlers.get('account:get-usage')!

      expect(() => handler(trustedEvent(), { pageSize: 101 })).toThrow('分页大小格式错误')
      expect(() => handler(trustedEvent(), { pageSize: 0 })).toThrow('分页大小格式错误')
    })

    it('rejects unknown fields, invalid types, reversed time ranges and unbounded text', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:get-usage')!

      expect(() => handler(trustedEvent(), { surprise: true })).toThrow('未知字段')
      expect(() => handler(trustedEvent(), { type: 8 })).toThrow('日志类型格式错误')
      expect(() => handler(trustedEvent(), { startTimestamp: 20, endTimestamp: 10 })).toThrow('开始时间不能晚于结束时间')
      expect(() => handler(trustedEvent(), { modelName: 'x'.repeat(129) })).toThrow('模型名称不能超过 128 个字符')
      expect(accountService.getUsage).not.toHaveBeenCalled()
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:get-usage')!

      expect(() => handler(trustedEvent(), { pageSize: 999 })).toThrow()
      expect(accountService.getUsage).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountDashboardQuery (account:get-dashboard)', () => {
    it('forwards a valid time range', async () => {
      const { accountService } = register()
      const data = {
        startTimestamp: 1_700_000_000,
        endTimestamp: 1_700_086_400,
        buckets: [],
        models: [],
        quota: 0,
        count: 0,
        tokens: 0,
        discardedCount: 0,
      }
      vi.mocked(accountService.getDashboard).mockResolvedValue(data)
      const handler = electronMocks.handlers.get('account:get-dashboard')!
      await expect(handler(trustedEvent(), {
        startTimestamp: data.startTimestamp, endTimestamp: data.endTimestamp,
      })).resolves.toEqual(data)
      expect(accountService.getDashboard).toHaveBeenCalledWith({
        startTimestamp: data.startTimestamp, endTimestamp: data.endTimestamp,
      })
    })

    it('rejects malformed, reversed, oversized and unknown ranges', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:get-dashboard')!
      expect(() => handler(trustedEvent(), undefined)).toThrow('格式错误')
      expect(() => handler(trustedEvent(), { startTimestamp: 20, endTimestamp: 10 })).toThrow('开始时间不能晚于结束时间')
      expect(() => handler(trustedEvent(), { startTimestamp: 1, endTimestamp: 2_592_002 })).toThrow('不能超过 30 天')
      expect(() => handler(trustedEvent(), { startTimestamp: 1, endTimestamp: 2, userId: 9 })).toThrow('未知字段')
      expect(accountService.getDashboard).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountTaskQuery (account:get-tasks)', () => {
    it('trims and forwards the complete task filter set', async () => {
      const { accountService } = register()
      const page = { page: 2, pageSize: 20, total: 1, tasks: [] }
      vi.mocked(accountService.getTasks).mockResolvedValue(page)
      const handler = electronMocks.handlers.get('account:get-tasks')!

      await expect(handler(trustedEvent(), {
        page: 2, pageSize: 20, platform: ' openai ', taskId: ' task_1 ',
        status: 'IN_PROGRESS', action: ' video ',
        startTimestamp: 1_700_000_000, endTimestamp: 1_700_086_400,
      })).resolves.toEqual(page)
      expect(accountService.getTasks).toHaveBeenCalledWith({
        page: 2, pageSize: 20, platform: 'openai', taskId: 'task_1',
        status: 'IN_PROGRESS', action: 'video',
        startTimestamp: 1_700_000_000, endTimestamp: 1_700_086_400,
      })
    })

    it('rejects unknown fields, invalid statuses and reversed time ranges before calling the service', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:get-tasks')!
      expect(() => handler(trustedEvent(), { channelId: 9 })).toThrow('未知字段')
      expect(() => handler(trustedEvent(), { status: 'done' })).toThrow('任务状态格式错误')
      expect(() => handler(trustedEvent(), { startTimestamp: 20, endTimestamp: 10 })).toThrow('开始时间不能晚于结束时间')
      expect(() => handler(trustedEvent(), { taskId: 'x'.repeat(257) })).toThrow('任务 ID不能超过 256 个字符')
      expect(accountService.getTasks).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountKeysQuery (account:list-keys)', () => {
    it('parses a valid page/pageSize query and forwards it to the account service', async () => {
      const { accountService } = register()
      const page = { page: 2, pageSize: 20, total: 45, keys: [] }
      vi.mocked(accountService.listKeys).mockResolvedValue(page)
      const handler = electronMocks.handlers.get('account:list-keys')!

      await expect(handler(trustedEvent(), { page: 2, pageSize: 20 })).resolves.toEqual(page)
      expect(accountService.listKeys).toHaveBeenCalledWith({ page: 2, pageSize: 20 })
    })

    it('defaults to an empty query object when no input is given', async () => {
      const { accountService } = register()
      vi.mocked(accountService.listKeys).mockResolvedValue({ page: 1, pageSize: 10, total: 0, keys: [] })
      const handler = electronMocks.handlers.get('account:list-keys')!

      await handler(trustedEvent(), undefined)

      expect(accountService.listKeys).toHaveBeenCalledWith({})
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('account:list-keys')!

      expect(() => handler(trustedEvent(), 'nope')).toThrow('Key 查询参数格式错误')
      expect(() => handler(trustedEvent(), null)).toThrow('Key 查询参数格式错误')
    })

    it('rejects a non-integer or out-of-range page', () => {
      register()
      const handler = electronMocks.handlers.get('account:list-keys')!

      expect(() => handler(trustedEvent(), { page: 0 })).toThrow('页码格式错误')
      expect(() => handler(trustedEvent(), { page: 1.5 })).toThrow('页码格式错误')
    })

    it('rejects a page size outside 1..100 -- new-api clamps to 100 server-side (common/page_info.go)', () => {
      register()
      const handler = electronMocks.handlers.get('account:list-keys')!

      expect(() => handler(trustedEvent(), { pageSize: 101 })).toThrow('分页大小格式错误')
      expect(() => handler(trustedEvent(), { pageSize: 0 })).toThrow('分页大小格式错误')
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:list-keys')!

      expect(() => handler(trustedEvent(), { pageSize: 999 })).toThrow()
      expect(accountService.listKeys).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountRevokeKeyId (account:revoke-key)', () => {
    it('parses a valid id and forwards it to the account service', async () => {
      const { accountService } = register()
      vi.mocked(accountService.revokeKey).mockResolvedValue(undefined)
      const handler = electronMocks.handlers.get('account:revoke-key')!

      await expect(handler(trustedEvent(), 42)).resolves.toBeUndefined()
      expect(accountService.revokeKey).toHaveBeenCalledWith(42)
    })

    it('invalidates only the initiating account cache when the session switches during revoke', async () => {
      const accountService = accountServiceStub()
      const accountA = {
        userId: 101,
        username: 'account-a',
        group: 'default',
        role: 1,
        quota: 1_000,
        usedQuota: 0,
      }
      const accountB = { ...accountA, userId: 202, username: 'account-b' }
      let currentAccount = accountA
      vi.mocked(accountService.getSessionState).mockImplementation(() => ({
        authenticated: true,
        account: currentAccount,
      }))
      let finishRevoke: () => void = () => {}
      vi.mocked(accountService.revokeKey).mockReturnValue(new Promise<void>((resolve) => {
        finishRevoke = resolve
      }))
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const chatKeyStore = { removeByKeyId: vi.fn(async () => undefined) }
      register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        managedCliKeys,
        { chatKeyStore },
      )
      const handler = electronMocks.handlers.get('account:revoke-key')!

      const pending = handler(trustedEvent(), 42)
      expect(accountService.revokeKey).toHaveBeenCalledWith(42)
      currentAccount = accountB
      finishRevoke()
      await expect(pending).resolves.toBeUndefined()

      expect(managedCliKeys.remove).toHaveBeenCalledOnce()
      expect(managedCliKeys.remove).toHaveBeenCalledWith(101, 42)
      expect(managedCliKeys.remove).not.toHaveBeenCalledWith(202, 42)
      expect(chatKeyStore.removeByKeyId).toHaveBeenCalledOnce()
      expect(chatKeyStore.removeByKeyId).toHaveBeenCalledWith(101, 42)
      expect(chatKeyStore.removeByKeyId).not.toHaveBeenCalledWith(202, 42)
      expect(accountService.getSessionState).toHaveBeenCalledOnce()
    })

    it('keeps a successful remote revoke successful when one local cache cannot be cleared', async () => {
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      vi.mocked(accountService.revokeKey).mockResolvedValue(undefined)
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => { throw new Error('托管缓存损坏') }),
      }
      const chatKeyStore = { removeByKeyId: vi.fn(async () => undefined) }
      const { runtimeLog } = register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        managedCliKeys,
        { chatKeyStore },
      )

      await expect(electronMocks.handlers.get('account:revoke-key')!(trustedEvent(), 42))
        .resolves.toBeUndefined()
      expect(chatKeyStore.removeByKeyId).toHaveBeenCalledWith(42, 42)
      expect(runtimeLog.exception).toHaveBeenCalledWith(
        'account',
        'key-cache-invalidation-failed',
        expect.any(Error),
        { userId: 42, keyId: 42, cache: 'managed-cli' },
      )
    })

    it('rejects a non-number, non-integer, zero, or negative id -- id lands directly in a URL path segment (I5)', async () => {
      register()
      const handler = electronMocks.handlers.get('account:revoke-key')!

      await expect(handler(trustedEvent(), 'nope')).rejects.toThrow('Key ID 格式错误')
      await expect(handler(trustedEvent(), 1.5)).rejects.toThrow('Key ID 格式错误')
      await expect(handler(trustedEvent(), 0)).rejects.toThrow('Key ID 格式错误')
      await expect(handler(trustedEvent(), -1)).rejects.toThrow('Key ID 格式错误')
      await expect(handler(trustedEvent(), null)).rejects.toThrow('Key ID 格式错误')
      await expect(handler(trustedEvent(), undefined)).rejects.toThrow('Key ID 格式错误')
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', async () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:revoke-key')!

      await expect(handler(trustedEvent(), -5)).rejects.toThrow()
      expect(accountService.revokeKey).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountKeyUpdateInput (account:update-key)', () => {
    it('invalidates only the initiating account cache when the session switches during update', async () => {
      const accountService = accountServiceStub()
      const accountA = {
        userId: 101,
        username: 'account-a',
        group: 'default',
        role: 1,
        quota: 1_000,
        usedQuota: 0,
      }
      const accountB = { ...accountA, userId: 202, username: 'account-b' }
      let currentAccount = accountA
      vi.mocked(accountService.getSessionState).mockImplementation(() => ({
        authenticated: true,
        account: currentAccount,
      }))
      let finishUpdate: () => void = () => {}
      vi.mocked(accountService.updateKey).mockReturnValue(new Promise<void>((resolve) => {
        finishUpdate = resolve
      }))
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const chatKeyStore = { removeByKeyId: vi.fn(async () => undefined) }
      register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        managedCliKeys,
        { chatKeyStore },
      )
      const handler = electronMocks.handlers.get('account:update-key')!
      const input = {
        id: 42,
        name: 'managed-codex-key',
        group: 'codex-pro',
        remainQuota: 1_000,
        unlimitedQuota: false,
        expiredTime: -1,
      }

      const pending = handler(trustedEvent(), input)
      expect(accountService.updateKey).toHaveBeenCalledWith(input)
      currentAccount = accountB
      finishUpdate()
      await expect(pending).resolves.toBeUndefined()

      expect(managedCliKeys.remove).toHaveBeenCalledOnce()
      expect(managedCliKeys.remove).toHaveBeenCalledWith(101, 42)
      expect(managedCliKeys.remove).not.toHaveBeenCalledWith(202, 42)
      expect(chatKeyStore.removeByKeyId).toHaveBeenCalledOnce()
      expect(chatKeyStore.removeByKeyId).toHaveBeenCalledWith(101, 42)
      expect(chatKeyStore.removeByKeyId).not.toHaveBeenCalledWith(202, 42)
      expect(accountService.getSessionState).toHaveBeenCalledOnce()
    })

    it('keeps a successful remote update successful when one local cache cannot be cleared', async () => {
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      vi.mocked(accountService.updateKey).mockResolvedValue(undefined)
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const chatKeyStore = {
        removeByKeyId: vi.fn(async () => { throw new Error('AI聊天缓存损坏') }),
      }
      const { runtimeLog } = register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        managedCliKeys,
        { chatKeyStore },
      )
      const input = {
        id: 42,
        name: 'managed-codex-key',
        group: 'codex-pro',
        remainQuota: 1_000,
        unlimitedQuota: false,
        expiredTime: -1,
      }

      await expect(electronMocks.handlers.get('account:update-key')!(trustedEvent(), input))
        .resolves.toBeUndefined()
      expect(managedCliKeys.remove).toHaveBeenCalledWith(42, 42)
      expect(runtimeLog.exception).toHaveBeenCalledWith(
        'account',
        'key-cache-invalidation-failed',
        expect.any(Error),
        { userId: 42, keyId: 42, cache: 'ai-chat' },
      )
    })
  })

  describe('account billing, subscription, profile, and login-session IPC', () => {
    it('forwards read operations and normalized order pagination without reshaping DTOs', async () => {
      const accountService = accountServiceStub()
      const topupInfo = {
        onlineTopupEnabled: true,
        stripeTopupEnabled: false,
        creemTopupEnabled: false,
        waffoPancakeTopupEnabled: false,
        redemptionEnabled: true,
        paymentComplianceConfirmed: true,
        paymentComplianceTermsVersion: '2026-08',
        paymentMethods: [{
          name: '支付宝',
          type: 'alipay',
          provider: 'epay' as const,
          color: '#1677ff',
          icon: null,
          minTopup: 10,
        }],
        minTopup: 10,
        amountOptions: [10, 20],
        discounts: { 20: 0.9 },
        topupLink: null,
      }
      const orders = { page: 2, pageSize: 25, total: 0, orders: [] }
      const plans = [{
        id: 3,
        title: '月度套餐',
        subtitle: '',
        priceAmount: 19.9,
        currency: 'CNY',
        durationUnit: 'month' as const,
        durationValue: 1,
        customSeconds: 0,
        allowBalancePay: true,
        allowWalletOverflow: false,
        maxPurchasePerUser: 0,
        totalAmount: 1_000_000,
        upgradeGroup: '',
        downgradeGroup: '',
        quotaResetPeriod: 'monthly' as const,
        quotaResetCustomSeconds: 0,
        stripePriceId: null,
        creemProductId: null,
        waffoPancakeProductId: null,
      }]
      const subscriptionSelf = {
        billingPreference: 'subscription_first' as const, activeSubscriptions: [], allSubscriptions: [],
      }
      const sessions = [{
        sid: '123e4567-e89b-42d3-a456-426614174000',
        current: true,
        loginMethod: 'password',
        ip: '127.0.0.1',
        userAgent: 'Desktop',
        createdAt: '2026-08-01T00:00:00.000Z',
        lastActiveAt: '2026-08-01T00:01:00.000Z',
        expiresAt: '2026-09-01T00:00:00.000Z',
      }]
      vi.mocked(accountService.getTopupInfo).mockResolvedValue(topupInfo)
      vi.mocked(accountService.listTopupOrders).mockResolvedValue(orders)
      vi.mocked(accountService.listSubscriptionPlans).mockResolvedValue(plans)
      vi.mocked(accountService.getSubscriptionSelf).mockResolvedValue(subscriptionSelf)
      vi.mocked(accountService.listLoginSessions).mockResolvedValue(sessions)
      register(serviceStub(), 'C:\\app-data\\logs', undefined, accountService)

      await expect(electronMocks.handlers.get('account:get-topup-info')!(trustedEvent()))
        .resolves.toEqual(topupInfo)
      await expect(electronMocks.handlers.get('account:list-topup-orders')!(trustedEvent(), {
        page: 2, pageSize: 25, keyword: ' trade-7 ',
      })).resolves.toEqual(orders)
      await expect(electronMocks.handlers.get('account:list-subscription-plans')!(trustedEvent()))
        .resolves.toEqual(plans)
      await expect(electronMocks.handlers.get('account:get-subscription-self')!(trustedEvent()))
        .resolves.toEqual(subscriptionSelf)
      await expect(electronMocks.handlers.get('account:list-login-sessions')!(trustedEvent()))
        .resolves.toEqual(sessions)

      expect(accountService.listTopupOrders).toHaveBeenCalledWith({
        page: 2, pageSize: 25, keyword: 'trade-7',
      })
      expect(accountService.listSubscriptionPlans).toHaveBeenCalledWith()
      expect(accountService.getSubscriptionSelf).toHaveBeenCalledWith()
      expect(accountService.listLoginSessions).toHaveBeenCalledWith()
    })

    it('forwards validated mutation DTOs and returns only service-level results', async () => {
      const accountService = accountServiceStub()
      const paymentForm = {
        action: 'https://pay.example.com/submit',
        allowedOrigin: 'https://pay.example.com',
        method: 'POST' as const,
        fields: [{ name: 'sign', value: 'signed' }],
        tradeNo: 'trade-9',
      }
      vi.mocked(accountService.quoteTopupAmount).mockResolvedValue({ amount: 10, payableAmount: 8.8 })
      vi.mocked(accountService.createTopupPayment).mockResolvedValue(paymentForm)
      vi.mocked(accountService.redeemTopupCode).mockResolvedValue({ quotaAdded: 500_000 })
      vi.mocked(accountService.transferAffiliateQuota).mockResolvedValue(undefined)
      vi.mocked(accountService.updateSubscriptionPreference).mockResolvedValue('wallet_first')
      vi.mocked(accountService.createSubscriptionPayment).mockResolvedValue({
        kind: 'url',
        url: 'https://checkout.example.com/session#token=opaque',
        tradeNo: 'subscription-trade-1',
        expiresAt: '2026-08-15T12:30:00.000Z',
      })
      vi.mocked(accountService.purchaseSubscriptionWithBalance).mockResolvedValue({ purchased: true })
      vi.mocked(accountService.updateDisplayName).mockResolvedValue({ updated: true })
      vi.mocked(accountService.revokeOtherLoginSessions).mockResolvedValue({ revokedCount: 3 })
      const parentWindow = { id: 'main-window' }
      electronMocks.browserWindowFromWebContents.mockReturnValue(parentWindow)
      const { paymentWindow } = register(serviceStub(), 'C:\\app-data\\logs', undefined, accountService)

      await expect(electronMocks.handlers.get('account:quote-topup')!(trustedEvent(), { amount: 10 }))
        .resolves.toEqual({ amount: 10, payableAmount: 8.8 })
      await expect(electronMocks.handlers.get('account:create-topup-payment')!(trustedEvent(), {
        amount: 20, paymentMethod: ' alipay ',
      })).resolves.toEqual({ opened: true, tradeNo: 'trade-9' })
      expect(electronMocks.handlers.get('account:close-payment-window')!(trustedEvent()))
        .toBeUndefined()
      await expect(electronMocks.handlers.get('account:redeem-topup-code')!(trustedEvent(), ' CODE-123 '))
        .resolves.toEqual({ quotaAdded: 500_000 })
      await expect(electronMocks.handlers.get('account:transfer-affiliate-quota')!(trustedEvent(), {
        quota: 100_000,
      })).resolves.toBeUndefined()
      await expect(electronMocks.handlers.get('account:update-subscription-preference')!(
        trustedEvent(),
        'wallet_first',
      )).resolves.toBe('wallet_first')
      await expect(electronMocks.handlers.get('account:create-subscription-payment')!(trustedEvent(), {
        planId: 3, provider: 'stripe',
      })).resolves.toEqual({
        opened: true,
        tradeNo: 'subscription-trade-1',
        expiresAt: '2026-08-15T12:30:00.000Z',
      })
      await expect(electronMocks.handlers.get('account:purchase-subscription-balance')!(trustedEvent(), 3))
        .resolves.toEqual({ purchased: true })
      await expect(electronMocks.handlers.get('account:update-display-name')!(trustedEvent(), {
        displayName: ' 新昵称 ',
      })).resolves.toEqual({ updated: true })
      await expect(electronMocks.handlers.get('account:revoke-other-login-sessions')!(trustedEvent()))
        .resolves.toEqual({ revokedCount: 3 })

      expect(accountService.quoteTopupAmount).toHaveBeenCalledWith({ amount: 10 })
      expect(accountService.createTopupPayment).toHaveBeenCalledWith({ amount: 20, paymentMethod: 'alipay' })
      expect(paymentWindow.open).toHaveBeenCalledWith(paymentForm, parentWindow)
      expect(paymentWindow.destroy).toHaveBeenCalledOnce()
      expect(accountService.redeemTopupCode).toHaveBeenCalledWith('CODE-123')
      expect(accountService.transferAffiliateQuota).toHaveBeenCalledWith({ quota: 100_000 })
      expect(accountService.updateSubscriptionPreference).toHaveBeenCalledWith('wallet_first')
      expect(accountService.createSubscriptionPayment).toHaveBeenCalledWith({ planId: 3, provider: 'stripe' })
      expect(paymentWindow.openUrl).toHaveBeenCalledWith(
        'https://checkout.example.com/session#token=opaque',
        parentWindow,
        'subscription-trade-1',
      )
      expect(accountService.purchaseSubscriptionWithBalance).toHaveBeenCalledWith(3)
      expect(accountService.updateDisplayName).toHaveBeenCalledWith({ displayName: '新昵称' })
      expect(accountService.revokeOtherLoginSessions).toHaveBeenCalledWith()
    })

    it('validates the backend payment form before opening the window or returning its trade number', async () => {
      const accountService = accountServiceStub()
      const { paymentWindow } = register(serviceStub(), 'C:\\app-data\\logs', undefined, accountService)
      vi.mocked(accountService.createTopupPayment).mockResolvedValue({
        action: 'https://attacker.example/submit',
        allowedOrigin: 'https://attacker.example/not-an-origin',
        method: 'POST',
        fields: [{ name: 'sign', value: 'signed' }],
        tradeNo: 'attacker-trade',
      })

      await expect(electronMocks.handlers.get('account:create-topup-payment')!(trustedEvent(), {
        amount: 10,
        paymentMethod: 'alipay',
      })).rejects.toThrow('支付来源与支付地址不匹配')
      expect(paymentWindow.open).not.toHaveBeenCalled()
    })

    it('rejects malformed subscription payment inputs before dispatch', async () => {
      const accountService = accountServiceStub()
      const { paymentWindow } = register(serviceStub(), 'C:\app-data\logs', undefined, accountService)

      expect(() => electronMocks.handlers.get('account:update-subscription-preference')!(
        trustedEvent(),
        'subscription',
      )).toThrow('扣费顺序')
      expect(() => electronMocks.handlers.get('account:create-subscription-payment')!(trustedEvent(), {
        planId: 3, provider: 'epay',
      })).toThrow('支付方式不能为空')
      expect(() => electronMocks.handlers.get('account:create-subscription-payment')!(trustedEvent(), {
        planId: 3, provider: 'stripe', paymentMethod: 'alipay',
      })).toThrow('不接受支付方式参数')
      expect(() => electronMocks.handlers.get('account:create-subscription-payment')!(trustedEvent(), {
        planId: 3, provider: 'stripe', unexpected: true,
      })).toThrow('未知字段')

      expect(accountService.updateSubscriptionPreference).not.toHaveBeenCalled()
      expect(accountService.createSubscriptionPayment).not.toHaveBeenCalled()
      expect(paymentWindow.open).not.toHaveBeenCalled()
      expect(paymentWindow.openUrl).not.toHaveBeenCalled()
    })

    it('rejects hostile billing and profile inputs before they reach the service', () => {
      const { accountService } = register()
      const quote = electronMocks.handlers.get('account:quote-topup')!
      const payment = electronMocks.handlers.get('account:create-topup-payment')!
      const orders = electronMocks.handlers.get('account:list-topup-orders')!
      const redeem = electronMocks.handlers.get('account:redeem-topup-code')!
      const transfer = electronMocks.handlers.get('account:transfer-affiliate-quota')!
      const purchase = electronMocks.handlers.get('account:purchase-subscription-balance')!
      const updateDisplayName = electronMocks.handlers.get('account:update-display-name')!

      for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10']) {
        expect(() => quote(trustedEvent(), { amount })).toThrow('充值数量格式错误')
      }
      for (const paymentMethod of ['', ' '.repeat(3), 'x'.repeat(65), 42]) {
        expect(() => payment(trustedEvent(), { amount: 10, paymentMethod })).toThrow('支付方式格式错误')
      }
      expect(() => payment(trustedEvent(), {
        amount: 10,
        paymentMethod: 'alipay',
        fields: [{ name: 'sign', value: 'renderer-controlled' }],
      })).toThrow('充值支付信息包含未知字段')
      for (const query of [
        null,
        { page: 0 },
        { page: 1.5 },
        { page: 1_000_001 },
        { pageSize: 0 },
        { pageSize: 101 },
        { keyword: 'x'.repeat(129) },
      ]) {
        expect(() => orders(trustedEvent(), query)).toThrow()
      }
      for (const code of ['', ' '.repeat(3), 'x'.repeat(257), 42]) {
        expect(() => redeem(trustedEvent(), code)).toThrow('兑换码格式错误')
      }
      for (const quota of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
        expect(() => transfer(trustedEvent(), { quota })).toThrow('邀请额度格式错误')
      }
      for (const planId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
        expect(() => purchase(trustedEvent(), planId)).toThrow('订阅方案 ID格式错误')
      }
      for (const displayName of [42, 'x'.repeat(21)]) {
        expect(() => updateDisplayName(trustedEvent(), { displayName })).toThrow('显示名称格式错误')
      }

      expect(accountService.quoteTopupAmount).not.toHaveBeenCalled()
      expect(accountService.createTopupPayment).not.toHaveBeenCalled()
      expect(accountService.listTopupOrders).not.toHaveBeenCalled()
      expect(accountService.redeemTopupCode).not.toHaveBeenCalled()
      expect(accountService.transferAffiliateQuota).not.toHaveBeenCalled()
      expect(accountService.purchaseSubscriptionWithBalance).not.toHaveBeenCalled()
      expect(accountService.updateDisplayName).not.toHaveBeenCalled()
    })

    it('rejects an untrusted payment sender before creating a server payment form', () => {
      const { accountService, paymentWindow } = register()
      const payment = electronMocks.handlers.get('account:create-topup-payment')!

      expect(() => payment(trustedEvent('https://attacker.example/'), {
        amount: 10,
        paymentMethod: 'alipay',
      })).toThrow('已拒绝来自非应用页面的操作请求')
      expect(accountService.createTopupPayment).not.toHaveBeenCalled()
      expect(paymentWindow.open).not.toHaveBeenCalled()
    })

    it('validates session IDs and cancels active AI work after revoking the current session', async () => {
      const sid = '123e4567-e89b-42d3-a456-426614174000'
      const accountService = accountServiceStub()
      vi.mocked(accountService.revokeLoginSession).mockResolvedValue({ revokedSid: sid, current: true })
      const chatService = { cancelAll: vi.fn(() => 2), dispose: vi.fn() }
      const imageService = { cancelAll: vi.fn(() => 1) }
      const { paymentWindow } = register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        undefined,
        { chatService, imageService } as never,
      )
      const handler = electronMocks.handlers.get('account:revoke-login-session')!

      await expect(handler(trustedEvent(), sid)).resolves.toEqual({ revokedSid: sid, current: true })
      expect(accountService.revokeLoginSession).toHaveBeenCalledWith(sid)
      expect(chatService.cancelAll).toHaveBeenCalledOnce()
      expect(imageService.cancelAll).toHaveBeenCalledOnce()
      expect(paymentWindow.destroy).toHaveBeenCalledOnce()

      for (const value of ['', '../current', 'not-a-uuid', 'x'.repeat(65), 42]) {
        await expect(handler(trustedEvent(), value)).rejects.toThrow()
      }
      expect(accountService.revokeLoginSession).toHaveBeenCalledTimes(1)
    })

    it('does not cancel active AI work when revoking a non-current session', async () => {
      const sid = '123e4567-e89b-42d3-a456-426614174000'
      const accountService = accountServiceStub()
      vi.mocked(accountService.revokeLoginSession).mockResolvedValue({ revokedSid: sid, current: false })
      const chatService = { cancelAll: vi.fn(() => 0), dispose: vi.fn() }
      const imageService = { cancelAll: vi.fn(() => 0) }
      const { paymentWindow } = register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        undefined,
        { chatService, imageService } as never,
      )

      await expect(electronMocks.handlers.get('account:revoke-login-session')!(trustedEvent(), sid))
        .resolves.toEqual({ revokedSid: sid, current: false })
      expect(chatService.cancelAll).not.toHaveBeenCalled()
      expect(imageService.cancelAll).not.toHaveBeenCalled()
      expect(paymentWindow.destroy).not.toHaveBeenCalled()
    })
  })

  describe('parseAccountChangePasswordInput (account:change-password)', () => {
    it('parses a valid change-password payload and forwards it to the account service', async () => {
      const { accountService } = register()
      vi.mocked(accountService.changePassword).mockResolvedValue({ changed: true })
      const handler = electronMocks.handlers.get('account:change-password')!

      await expect(handler(trustedEvent(), {
        originalPassword: 'current-password-1',
        newPassword: 'new-password-2',
      })).resolves.toEqual({ changed: true })

      expect(accountService.changePassword).toHaveBeenCalledWith({
        originalPassword: 'current-password-1',
        newPassword: 'new-password-2',
      })
    })

    it('rejects a non-record payload', () => {
      register()
      const handler = electronMocks.handlers.get('account:change-password')!

      expect(() => handler(trustedEvent(), 'nope')).toThrow('修改密码信息格式错误')
      expect(() => handler(trustedEvent(), null)).toThrow('修改密码信息格式错误')
    })

    it('rejects a missing or empty original password', () => {
      register()
      const handler = electronMocks.handlers.get('account:change-password')!

      expect(() => handler(trustedEvent(), { newPassword: 'new-password-2' })).toThrow('原密码格式错误')
      expect(() => handler(trustedEvent(), { originalPassword: '', newPassword: 'new-password-2' }))
        .toThrow('原密码格式错误')
    })

    it('rejects a new password shorter than 8 or longer than 20 characters', () => {
      register()
      const handler = electronMocks.handlers.get('account:change-password')!

      expect(() => handler(trustedEvent(), { originalPassword: 'old-password-1', newPassword: 'short1' }))
        .toThrow('新密码长度需为 8 到 20 位')
      expect(() => handler(trustedEvent(), { originalPassword: 'old-password-1', newPassword: 'a'.repeat(21) }))
        .toThrow('新密码长度需为 8 到 20 位')
    })

    it('does not trim either password field -- both must be forwarded exactly as typed', async () => {
      const { accountService } = register()
      vi.mocked(accountService.changePassword).mockResolvedValue({ changed: true })
      const handler = electronMocks.handlers.get('account:change-password')!

      await handler(trustedEvent(), { originalPassword: ' old-password-1 ', newPassword: ' new-password-2 ' })

      expect(accountService.changePassword).toHaveBeenCalledWith({
        originalPassword: ' old-password-1 ',
        newPassword: ' new-password-2 ',
      })
    })

    it('never reaches the account service -- and never the real production client -- when validation fails', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:change-password')!

      expect(() => handler(trustedEvent(), { originalPassword: 'old-password-1', newPassword: 'short' })).toThrow()
      expect(accountService.changePassword).not.toHaveBeenCalled()
    })
  })

  describe('parseLegalDocumentKind (account:get-legal-document)', () => {
    it('forwards both supported document kinds and returns the service DTO', async () => {
      const { accountService } = register()
      vi.mocked(accountService.getLegalDocument).mockImplementation(async (kind) => ({
        kind,
        markdown: `# ${kind}`,
        fetchedAt: '2026-08-11T00:00:00.000Z',
      }))
      const handler = electronMocks.handlers.get('account:get-legal-document')!

      await expect(handler(trustedEvent(), 'user-agreement')).resolves.toMatchObject({
        kind: 'user-agreement',
      })
      await expect(handler(trustedEvent(), 'privacy-policy')).resolves.toMatchObject({
        kind: 'privacy-policy',
      })
      expect(vi.mocked(accountService.getLegalDocument).mock.calls).toEqual([
        ['user-agreement'],
        ['privacy-policy'],
      ])
    })

    it('rejects every unsupported value before reaching the account service', () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:get-legal-document')!

      for (const value of [undefined, null, '', 'terms', 42, {}]) {
        expect(() => handler(trustedEvent(), value)).toThrow('法律文档类型格式错误')
      }
      expect(accountService.getLegalDocument).not.toHaveBeenCalled()
    })
  })

  describe('account:list-groups', () => {
    it('returns the usable group metadata without reshaping it in IPC', async () => {
      const { accountService } = register()
      const groups = [
        { name: 'default', description: '默认分组', ratio: 1 },
        { name: 'codex-pro', description: 'Codex Pro', ratio: '1.5' },
      ]
      vi.mocked(accountService.listUsableGroups).mockResolvedValue(groups)
      const handler = electronMocks.handlers.get('account:list-groups')!

      await expect(handler(trustedEvent())).resolves.toEqual(groups)
      expect(accountService.listUsableGroups).toHaveBeenCalledWith()
    })
  })

  describe('account:copy-key', () => {
    it('uses the encrypted managed-key cache for both copy and reveal without contacting the server', async () => {
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      const plaintextKey = 'sk-managed-cache-secret'
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => [{
          id: 77,
          provider: 'codex' as const,
          group: 'codex-pro',
          name: 'xingmang-desktop-codex',
          key: plaintextKey,
        }]),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const { runtimeLog } = register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        managedCliKeys,
      )

      await expect(electronMocks.handlers.get('account:copy-key')!(trustedEvent(), 77)).resolves.toBeUndefined()
      await expect(electronMocks.handlers.get('account:reveal-key')!(trustedEvent(), 77)).resolves.toBe(plaintextKey)

      expect(managedCliKeys.read).toHaveBeenCalledTimes(2)
      expect(managedCliKeys.read).toHaveBeenNthCalledWith(1, 42)
      expect(managedCliKeys.read).toHaveBeenNthCalledWith(2, 42)
      expect(accountService.revealKey).not.toHaveBeenCalled()
      expect(electronMocks.writeText).toHaveBeenCalledWith(plaintextKey)
      expect(JSON.stringify(runtimeLog.log.mock.calls)).not.toContain(plaintextKey)
    })

    it('writes the revealed secret directly to the system clipboard and returns nothing to the renderer', async () => {
      const { accountService, runtimeLog } = register()
      const plaintextKey = 'sk-ipc-copy-secret'
      vi.mocked(accountService.revealKey).mockResolvedValue(plaintextKey)
      const handler = electronMocks.handlers.get('account:copy-key')!

      const result = await handler(trustedEvent(), 42)

      expect(result).toBeUndefined()
      expect(accountService.revealKey).toHaveBeenCalledWith(42)
      expect(electronMocks.writeText).toHaveBeenCalledWith(plaintextKey)
      expect(JSON.stringify(runtimeLog.log.mock.calls)).not.toContain(plaintextKey)
    })

    it('falls back to the server for an ordinary key that is absent from the managed cache', async () => {
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      const plaintextKey = 'sk-server-fallback-secret'
      vi.mocked(accountService.revealKey).mockResolvedValue(plaintextKey)
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      register(serviceStub(), 'C:\\app-data\\logs', undefined, accountService, undefined, managedCliKeys)

      await expect(electronMocks.handlers.get('account:reveal-key')!(trustedEvent(), 88)).resolves.toBe(plaintextKey)

      expect(managedCliKeys.read).toHaveBeenCalledWith(42)
      expect(accountService.revealKey).toHaveBeenCalledWith(88)
      expect(electronMocks.writeText).not.toHaveBeenCalled()
    })

    it('discards a server fallback secret when the account switches before reveal completes', async () => {
      const accountService = accountServiceStub()
      const accountA = {
        userId: 101,
        username: 'account-a',
        group: 'default',
        role: 1,
        quota: 1_000,
        usedQuota: 0,
      }
      const accountB = { ...accountA, userId: 202, username: 'account-b' }
      let currentAccount = accountA
      vi.mocked(accountService.getSessionState).mockImplementation(() => ({
        authenticated: true,
        account: currentAccount,
      }))
      const plaintextKey = 'sk-must-be-discarded'
      let finishReveal: () => void = () => {}
      vi.mocked(accountService.revealKey).mockReturnValue(new Promise<string>((resolve) => {
        finishReveal = () => resolve(plaintextKey)
      }))
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const { runtimeLog } = register(
        serviceStub(),
        'C:\\app-data\\logs',
        undefined,
        accountService,
        undefined,
        managedCliKeys,
      )
      const handler = electronMocks.handlers.get('account:reveal-key')!

      const pending = handler(trustedEvent(), 88)
      await vi.waitFor(() => expect(accountService.revealKey).toHaveBeenCalledWith(88))
      currentAccount = accountB
      finishReveal()

      await expect(pending).rejects.toThrow('账号会话已变更')
      expect(electronMocks.writeText).not.toHaveBeenCalled()
      expect(JSON.stringify([
        runtimeLog.log.mock.calls,
        runtimeLog.exception.mock.calls,
      ])).not.toContain(plaintextKey)
    })

    it('propagates encrypted-cache failures and never silently falls back to the server', async () => {
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => { throw new Error('本地托管 API Key 配置已损坏或无法解密') }),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      register(serviceStub(), 'C:\\app-data\\logs', undefined, accountService, undefined, managedCliKeys)

      await expect(electronMocks.handlers.get('account:reveal-key')!(trustedEvent(), 77))
        .rejects.toThrow('本地托管 API Key 配置已损坏或无法解密')
      await expect(electronMocks.handlers.get('account:copy-key')!(trustedEvent(), 77))
        .rejects.toThrow('本地托管 API Key 配置已损坏或无法解密')

      expect(accountService.revealKey).not.toHaveBeenCalled()
      expect(electronMocks.writeText).not.toHaveBeenCalled()
    })

    it('rejects an invalid id before revealing or copying a secret', async () => {
      const { accountService } = register()
      const handler = electronMocks.handlers.get('account:copy-key')!

      for (const value of ['42', 0, -1, 1.5, null, undefined]) {
        await expect(handler(trustedEvent(), value)).rejects.toThrow('Key ID 格式错误')
      }
      expect(accountService.revealKey).not.toHaveBeenCalled()
      expect(electronMocks.writeText).not.toHaveBeenCalled()
    })

    it('rejects an invalid reveal id before reading cache or contacting the server', async () => {
      const accountService = accountServiceStub()
      const managedCliKeys: NonNullable<Parameters<typeof registerIpcHandlers>[0]['managedCliKeys']> = {
        read: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      register(serviceStub(), 'C:\\app-data\\logs', undefined, accountService, undefined, managedCliKeys)
      const handler = electronMocks.handlers.get('account:reveal-key')!

      await expect(handler(trustedEvent(), '77')).rejects.toThrow('Key ID 格式错误')
      expect(managedCliKeys.read).not.toHaveBeenCalled()
      expect(accountService.revealKey).not.toHaveBeenCalled()
    })

    it('lists models for a selected account key without returning its secret', async () => {
      const service = serviceStub()
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      const plaintextKey = 'sk-selected-account-key'
      vi.mocked(accountService.revealKey).mockResolvedValue(plaintextKey)
      vi.mocked(service.fetchAvailableModels).mockResolvedValue(['gpt-5.6-sol', 'gpt-5.6-terra'])
      const { runtimeLog } = register(service, 'C:\\app-data\\logs', undefined, accountService)
      const handler = electronMocks.handlers.get('account:list-key-models')!

      await expect(handler(trustedEvent(), 88)).resolves.toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])
      expect(accountService.revealKey).toHaveBeenCalledWith(88)
      expect(service.fetchAvailableModels).toHaveBeenCalledWith(plaintextKey)
      expect(JSON.stringify(runtimeLog.log.mock.calls)).not.toContain(plaintextKey)
    })

    it('validates and saves a selected account key entirely in the main process', async () => {
      const service = serviceStub()
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      const plaintextKey = 'sk-selected-account-key'
      vi.mocked(accountService.revealKey).mockResolvedValue(plaintextKey)
      vi.mocked(service.fetchAvailableModels).mockResolvedValue(['gpt-5.6-sol'])
      const { runtimeLog } = register(service, 'C:\\app-data\\logs', undefined, accountService)
      const handler = electronMocks.handlers.get('account:configure-cli-with-key')!

      await expect(handler(trustedEvent(), {
        provider: 'codex',
        keyId: 88,
        model: 'gpt-5.6-sol',
        mode: 'merge',
      })).resolves.toEqual({ backups: [], files: [] })
      expect(service.saveConfig).toHaveBeenCalledWith({
        provider: 'codex',
        apiKey: plaintextKey,
        model: 'gpt-5.6-sol',
        mode: 'merge',
      }, false, expect.any(Function))
      expect(JSON.stringify(runtimeLog.log.mock.calls)).not.toContain(plaintextKey)
    })

    it('rejects stale or malformed account-key CLI configuration before writing', async () => {
      const service = serviceStub()
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      vi.mocked(accountService.revealKey).mockResolvedValue('sk-selected-account-key')
      vi.mocked(service.fetchAvailableModels).mockResolvedValue(['gpt-5.6-terra'])
      register(service, 'C:\\app-data\\logs', undefined, accountService)
      const handler = electronMocks.handlers.get('account:configure-cli-with-key')!

      await expect(handler(trustedEvent(), {
        provider: 'codex', keyId: 88, model: 'gpt-5.6-sol', mode: 'merge',
      })).rejects.toThrow('所选 Key 当前不支持该模型')
      for (const input of [
        { provider: 'unknown', keyId: 88, model: 'm', mode: 'merge' },
        { provider: 'codex', keyId: '88', model: 'm', mode: 'merge' },
        { provider: 'codex', keyId: 88, model: '', mode: 'merge' },
        { provider: 'codex', keyId: 88, model: 'm', mode: 'replace' },
      ]) {
        await expect(handler(trustedEvent(), input)).rejects.toThrow()
      }
      expect(service.saveConfig).not.toHaveBeenCalled()
    })
  })

  describe('parseManagedCliConfigurationInput (account:configure-managed-clis)', () => {
    it('accepts a unique provider list and trims a valid preferred model', async () => {
      const service = serviceStub()
      const accountService = accountServiceStub()
      vi.mocked(accountService.getSessionState).mockReturnValue({
        authenticated: true,
        account: {
          userId: 42,
          username: 'tester',
          group: 'default',
          role: 1,
          quota: 1_000,
          usedQuota: 0,
        },
      })
      vi.mocked(accountService.provisionCliKey).mockImplementation(async (input) => ({
        id: 1,
        name: input?.name ?? 'managed-key',
        key: `sk-internal-${input?.group ?? 'default'}`,
      }))
      vi.mocked(service.fetchAvailableModels).mockResolvedValue(['gpt-5.6-sol'])
      register(service, 'C:\\app-data\\logs', undefined, accountService)
      const handler = electronMocks.handlers.get('account:configure-managed-clis')!

      const result = await handler(trustedEvent(), {
        providers: ['codex'],
        preferredModels: { codex: '  gpt-5.6-sol  ', gemini: undefined },
      })

      expect(result).toEqual({ configured: ['codex'], failed: [] })
      expect(service.saveConfig).toHaveBeenCalledWith({
        provider: 'codex',
        apiKey: 'sk-internal-GPT-中转/订阅',
        model: 'gpt-5.6-sol',
        mode: 'merge',
      }, false, expect.any(Function))
      expect(JSON.stringify(result)).not.toContain('sk-internal-')
    })

    it('rejects duplicate providers before provisioning or writing config', () => {
      const service = serviceStub()
      const accountService = accountServiceStub()
      register(service, 'C:\\app-data\\logs', undefined, accountService)
      const handler = electronMocks.handlers.get('account:configure-managed-clis')!

      expect(() => handler(trustedEvent(), {
        providers: ['codex', 'codex'],
        preferredModels: {},
      })).toThrow('CLI 配置目标不能重复')
      expect(accountService.provisionCliKey).not.toHaveBeenCalled()
      expect(service.fetchAvailableModels).not.toHaveBeenCalled()
      expect(service.saveConfig).not.toHaveBeenCalled()
    })

    it('rejects malformed, unknown, blank, non-string, or oversized preferred models', () => {
      const service = serviceStub()
      const accountService = accountServiceStub()
      register(service, 'C:\\app-data\\logs', undefined, accountService)
      const handler = electronMocks.handlers.get('account:configure-managed-clis')!

      expect(() => handler(trustedEvent(), { providers: ['codex'], preferredModels: [] }))
        .toThrow('CLI 首选模型格式错误')
      expect(() => handler(trustedEvent(), { providers: ['codex'], preferredModels: { unknown: 'model' } }))
        .toThrow('CLI 首选模型包含未知类型')
      for (const model of ['', '   ', 42, 'x'.repeat(513)]) {
        expect(() => handler(trustedEvent(), { providers: ['codex'], preferredModels: { codex: model } }))
          .toThrow('CLI 首选模型格式错误')
      }
      expect(accountService.provisionCliKey).not.toHaveBeenCalled()
      expect(service.fetchAvailableModels).not.toHaveBeenCalled()
      expect(service.saveConfig).not.toHaveBeenCalled()
    })
  })
})
