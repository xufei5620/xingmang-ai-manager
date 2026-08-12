import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewApiClientService } from './new-api-client'
import type { SystemService } from './system-service'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  browserWindowFromWebContents: vi.fn(() => undefined),
  registerFileProtocol: vi.fn(),
  notificationShow: vi.fn(),
  notificationSupported: vi.fn(() => true),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: electronMocks.browserWindowFromWebContents }),
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
    showOpenDialog: electronMocks.showOpenDialog,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler)
    },
    on: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.onHandlers.set(channel, handler)
    },
    removeHandler: electronMocks.removeHandler,
    removeAllListeners: electronMocks.removeAllListeners,
  },
  Notification: class {
    static isSupported() {
      return electronMocks.notificationSupported()
    }
    constructor(public options: unknown) {}
    show() {
      electronMocks.notificationShow(this.options)
    }
  },
  protocol: { registerFileProtocol: electronMocks.registerFileProtocol },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}))

import { resolveCanvasAuthToken } from './canvas-auth'
import { resolveRelaySite } from './relay-sites'
import {
  buildCanvasTokenDependencies,
  canvasBaseUrlForSite,
  canvasCliKeyNamePrefix,
  canvasHostAuthTokenChannel,
  canvasHostDownloadAssetChannel,
  canvasHostNotifyChannel,
  canvasHostOpenExternalChannel,
  canvasHostPickFileChannel,
  canvasHostSaveFileChannel,
  createCanvasWindowController,
  pickCanvasKeyGroup,
  type CanvasWindowControllerOptions,
} from './canvas-window'

const trustedCanvasUrl = 'xingmang-canvas://app/index.html'
const allowlist = ['https://docs.canvas.best', 'https://github.com/basketikun/infinite-canvas']

function trustedEvent(url = trustedCanvasUrl) {
  return {
    senderFrame: { url },
    sender: { getURL: () => url, isDestroyed: () => false, send: vi.fn() },
  }
}

function syncEvent(url = trustedCanvasUrl) {
  return {
    senderFrame: { url },
    sender: { getURL: () => url, isDestroyed: () => false, send: vi.fn() },
    returnValue: undefined as unknown,
  }
}

function controllerOptions(
  overrides: Partial<CanvasWindowControllerOptions> = {},
): CanvasWindowControllerOptions {
  return {
    canvasDistRoot: 'C:\\app\\dist-canvas',
    externalUrlAllowlist: allowlist,
    systemService: { revealApiKey: vi.fn(() => '') } as unknown as SystemService,
    accountService: {
      getSessionState: vi.fn(() => ({ authenticated: false, account: null })),
      provisionCliKey: vi.fn(),
    } as unknown as NewApiClientService,
    previewOnboarding: false,
    runtimeLog: { log: vi.fn(), exception: vi.fn() } as never,
    externalShell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) },
    ...overrides,
  }
}

beforeEach(() => {
  electronMocks.handlers.clear()
  electronMocks.onHandlers.clear()
  electronMocks.removeHandler.mockClear()
  electronMocks.removeAllListeners.mockClear()
  electronMocks.showSaveDialog.mockClear()
  electronMocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
  electronMocks.showOpenDialog.mockClear()
  electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  electronMocks.registerFileProtocol.mockClear()
  electronMocks.notificationShow.mockClear()
  electronMocks.notificationSupported.mockReset()
  electronMocks.notificationSupported.mockReturnValue(true)
})

describe('createCanvasWindowController', () => {
  it('registers exactly the six documented canvas-host channels -- the entire bridge surface', () => {
    createCanvasWindowController(controllerOptions())

    // download-asset is the deliberate sixth capability (画布 v2 媒体落盘,
    // I15 poisoning answer in canvas-window.ts) -- growing this list must
    // stay a conscious act, which is the whole point of this assertion.
    expect([...electronMocks.handlers.keys()].sort()).toEqual([
      canvasHostDownloadAssetChannel,
      canvasHostNotifyChannel,
      canvasHostOpenExternalChannel,
      canvasHostPickFileChannel,
      canvasHostSaveFileChannel,
    ].sort())
    expect([...electronMocks.onHandlers.keys()]).toEqual([canvasHostAuthTokenChannel])
  })

  it('registers the xingmang-canvas:// protocol handler exactly once', () => {
    createCanvasWindowController(controllerOptions())

    expect(electronMocks.registerFileProtocol).toHaveBeenCalledTimes(1)
    expect(electronMocks.registerFileProtocol).toHaveBeenCalledWith('xingmang-canvas', expect.any(Function))
  })

  it('rejects an invoke handler call from any sender outside the canvas window origin', async () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    expect(() => handler(trustedEvent('https://attacker.example/'), 'https://docs.canvas.best')).toThrow(
      '已拒绝来自非画布页面的操作请求',
    )
    expect(() => handler(trustedEvent('xingmang://app/index.html'), 'https://docs.canvas.best')).toThrow(
      '已拒绝来自非画布页面的操作请求',
    )
  })

  it('opens an allowlisted external URL via the injected shell launcher, never electron shell directly', async () => {
    const externalShell = { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }
    createCanvasWindowController(controllerOptions({ externalShell }))
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    await expect(handler(trustedEvent(), 'https://docs.canvas.best')).resolves.toBe(true)
    expect(externalShell.openExternal).toHaveBeenCalledWith('https://docs.canvas.best')
  })

  it('rejects a URL that is not an exact allowlist match (I12) -- subdomain and path confusion both fail', async () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    await expect(handler(trustedEvent(), 'https://docs.canvas.best.evil.example')).rejects.toThrow(
      '不允许打开该链接',
    )
    await expect(handler(trustedEvent(), 'https://github.com/basketikun/infinite-canvas/extra-path')).rejects.toThrow(
      '不允许打开该链接',
    )
    await expect(handler(trustedEvent(), 'http://docs.canvas.best')).rejects.toThrow('不允许打开该链接')
    await expect(handler(trustedEvent(), 42)).rejects.toThrow('不允许打开该链接')
  })

  it('validates notify input before ever constructing a Notification', () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    // The handler itself is synchronous (mirrors ipc.ts's own sync
    // validate-then-throw handlers, e.g. window:set-mode) -- real
    // ipcMain.handle wraps a synchronous throw into a rejected invoke()
    // promise for the renderer, but calling the captured handler directly
    // here (bypassing that wrapping, the same way ipc.test.ts does for its
    // own sync handlers) surfaces it as a plain synchronous throw.
    expect(() => handler(trustedEvent(), '', 'body')).toThrow('通知标题格式错误')
    expect(electronMocks.notificationShow).not.toHaveBeenCalled()
  })

  it('shows a native notification with title/body, defaulting an omitted body to empty', () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    expect(handler(trustedEvent(), '生成完成', undefined)).toBe(true)
    expect(electronMocks.notificationShow).toHaveBeenCalledWith({ title: '生成完成', body: '' })
  })

  it('returns false without throwing when Notification is unsupported on this platform', () => {
    electronMocks.notificationSupported.mockReturnValue(false)
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    expect(handler(trustedEvent(), '生成完成', 'body')).toBe(false)
    expect(electronMocks.notificationShow).not.toHaveBeenCalled()
  })

  it('returns null (not an error) when the save/pick dialog is canceled', async () => {
    createCanvasWindowController(controllerOptions())
    const saveHandler = electronMocks.handlers.get(canvasHostSaveFileChannel)!
    const pickHandler = electronMocks.handlers.get(canvasHostPickFileChannel)!

    await expect(saveHandler(trustedEvent(), 'export.json', '{}')).resolves.toBeNull()
    await expect(pickHandler(trustedEvent())).resolves.toBeNull()
  })

  it('rejects oversized or non-string saveFile input before ever opening a dialog', async () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostSaveFileChannel)!

    await expect(handler(trustedEvent(), 'export.json', 12345)).rejects.toThrow('保存内容格式错误')
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
  })

  describe('canvas-host:auth-token (synchronous)', () => {
    it('returns a null token and does not write storage for an untrusted sender', () => {
      createCanvasWindowController(controllerOptions())
      const handler = electronMocks.onHandlers.get(canvasHostAuthTokenChannel)!

      const event = syncEvent('https://attacker.example/')
      handler(event, null)

      expect(event.returnValue).toEqual({ token: null, storageValue: null })
    })

    it('returns a null token for a trusted sender when the account is logged out (zero network calls)', () => {
      const accountService = {
        getSessionState: vi.fn(() => ({ authenticated: false, account: null })),
        provisionCliKey: vi.fn(),
      } as unknown as NewApiClientService
      createCanvasWindowController(controllerOptions({ accountService }))
      const handler = electronMocks.onHandlers.get(canvasHostAuthTokenChannel)!

      // No canvas window has been opened (open() was never called), so no
      // entry exists in the controller's token map for this event.sender --
      // this also exercises the "no entry found" branch, which must degrade
      // to null rather than throw.
      const event = syncEvent()
      handler(event, null)

      expect(event.returnValue).toEqual({ token: null, storageValue: null })
      expect(accountService.provisionCliKey).not.toHaveBeenCalled()
    })
  })

  it('dispose() removes every handle channel and the sync listener', () => {
    const controller = createCanvasWindowController(controllerOptions())

    controller.dispose()

    for (const channel of [
      canvasHostSaveFileChannel,
      canvasHostPickFileChannel,
      canvasHostNotifyChannel,
      canvasHostOpenExternalChannel,
    ]) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
    expect(electronMocks.removeAllListeners).toHaveBeenCalledWith(canvasHostAuthTokenChannel)
  })
})

describe('buildCanvasTokenDependencies (orphan-token fix)', () => {
  // canvas-window.ts previously called accountService.provisionCliKey()
  // straight from resolveTokenForNewWindow's inline revealConfiguredRelayKey
  // fallback, unconditionally, whenever no installed CLI had a key
  // configured. Since canvas's own localStorage already holds the key from
  // the *first* open by the time a second one happens,
  // buildCanvasAiConfigInjection's own no-op guard (canvas-ai-config.ts)
  // correctly refuses to overwrite it -- but the freshly minted token was
  // already created server-side before that guard ever runs, so it is
  // provisioned once and never used again: an orphan xingmang-canvas-*
  // token, one more each time the window is opened and closed. These tests
  // exercise buildCanvasTokenDependencies() directly (no BrowserWindow
  // needed) composed with the already-tested resolveCanvasAuthToken
  // (canvas-auth.test.ts), the same way resolveTokenForNewWindow composes
  // them for a real run.
  const canvasBaseUrl = 'https://xm.solov.cc'

  function loggedInAccountService(
    overrides: Partial<Pick<NewApiClientService, 'findExistingCliKey' | 'provisionCliKey' | 'listUsableGroups'>> = {},
  ): NewApiClientService {
    return {
      getSessionState: vi.fn(() => ({ authenticated: true, account: null })),
      findExistingCliKey: vi.fn(async () => null),
      provisionCliKey: vi.fn(async () => ({ id: 1, name: 'xingmang-canvas-default', key: 'sk-default' })),
      // Default: no preferred group available, so tests below exercise the
      // legacy (group-less) path unless they override this.
      listUsableGroups: vi.fn(async () => []),
      ...overrides,
    } as unknown as NewApiClientService
  }

  function noCliConfiguredSystemService(): SystemService {
    return { revealApiKey: vi.fn(() => '') } as unknown as SystemService
  }

  it('revealConfiguredRelayKey surfaces the first configured CLI key -- consumed only on manual-key sites', () => {
    const accountService = loggedInAccountService()
    const systemService = {
      revealApiKey: vi.fn((provider: string) => (provider === 'codex' ? 'sk-cli-configured' : '')),
    } as unknown as SystemService

    const deps = buildCanvasTokenDependencies({ systemService, accountService, relaySite: resolveRelaySite('solov'), previewOnboarding: false })

    expect(deps.revealConfiguredRelayKey()).toBe('sk-cli-configured')
  })

  it('reuses an existing xingmang-canvas-* token instead of provisioning a new one -- the orphan-token regression', async () => {
    const findExistingCliKey = vi.fn(async (namePrefix: string) => {
      expect(namePrefix).toBe(`${canvasCliKeyNamePrefix}-`)
      return { id: 5, name: 'xingmang-canvas-previous', key: 'sk-reused' }
    })
    const provisionCliKey = vi.fn(async () => ({ id: 99, name: 'xingmang-canvas-should-not-be-created', key: 'sk-should-not-be-used' }))
    const accountService = loggedInAccountService({ findExistingCliKey, provisionCliKey })

    const deps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: resolveRelaySite('solov'),
      previewOnboarding: false,
    })
    const token = await resolveCanvasAuthToken(canvasBaseUrl, deps)

    expect(token).toEqual({ baseUrl: canvasBaseUrl, apiKey: 'sk-reused' })
    expect(findExistingCliKey).toHaveBeenCalledTimes(1)
    expect(provisionCliKey).not.toHaveBeenCalled()
  })

  it('falls back to provisioning a fresh key -- named with the canvas prefix -- when nothing existing is found', async () => {
    const provisionCliKey = vi.fn(async (input?: { name?: string }) => {
      expect(input?.name).toMatch(/^xingmang-canvas-/)
      return { id: 1, name: input!.name!, key: 'sk-newly-minted' }
    })
    const accountService = loggedInAccountService({ provisionCliKey })

    const deps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: resolveRelaySite('solov'),
      previewOnboarding: false,
    })
    const token = await resolveCanvasAuthToken(canvasBaseUrl, deps)

    expect(token).toEqual({ baseUrl: canvasBaseUrl, apiKey: 'sk-newly-minted' })
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
  })

  it('falls back to provisioning when the reuse lookup itself fails, reporting via onReuseLookupError, without breaking the flow', async () => {
    const lookupFailure = new Error('列表查询超时')
    const onReuseLookupError = vi.fn()
    const provisionCliKey = vi.fn(async () => ({ id: 1, name: 'xingmang-canvas-fallback', key: 'sk-fallback' }))
    const accountService = loggedInAccountService({
      findExistingCliKey: vi.fn(async () => { throw lookupFailure }),
      provisionCliKey,
    })

    const deps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: resolveRelaySite('solov'),
      previewOnboarding: false,
      onReuseLookupError,
    })
    const token = await resolveCanvasAuthToken(canvasBaseUrl, deps)

    expect(token).toEqual({ baseUrl: canvasBaseUrl, apiKey: 'sk-fallback' })
    expect(onReuseLookupError).toHaveBeenCalledWith(lookupFailure)
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
  })

  it('end-to-end: a second resolution reuses the first one\'s provisioned key, never provisioning twice -- the exact open/close/reopen scenario that used to orphan a token every time', async () => {
    // Mirrors xm.solov.cc's own token list gaining the freshly created entry
    // after provisionCliKey succeeds, so findExistingCliKey's second call
    // finds what the first call created -- exactly like a real second
    // GET /api/token/ would after the first canvas window's provision call.
    let serverSideTokens: { id: number; name: string; key: string }[] = []
    const provisionCliKey = vi.fn(async (input?: { name?: string }) => {
      const created = { id: serverSideTokens.length + 1, name: input!.name!, key: `sk-${input!.name}` }
      serverSideTokens = [...serverSideTokens, created]
      return created
    })
    const findExistingCliKey = vi.fn(async (namePrefix: string) => (
      serverSideTokens.find((entry) => entry.name.startsWith(namePrefix)) ?? null
    ))
    const accountService = loggedInAccountService({ findExistingCliKey, provisionCliKey })
    const deps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: resolveRelaySite('solov'),
      previewOnboarding: false,
    })

    const firstOpen = await resolveCanvasAuthToken(canvasBaseUrl, deps)
    const secondOpen = await resolveCanvasAuthToken(canvasBaseUrl, deps)

    expect(firstOpen).toEqual(secondOpen)
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
    expect(findExistingCliKey).toHaveBeenCalledTimes(2)
  })

  it('skips the canvas relay entirely when not logged in, touching neither reuse lookup nor provisioning', async () => {
    const findExistingCliKey = vi.fn()
    const provisionCliKey = vi.fn()
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: false, account: null })),
      findExistingCliKey,
      provisionCliKey,
    } as unknown as NewApiClientService

    const deps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: resolveRelaySite('solov'),
      previewOnboarding: false,
    })
    await expect(resolveCanvasAuthToken(canvasBaseUrl, deps)).resolves.toBeNull()
    expect(findExistingCliKey).not.toHaveBeenCalled()
    expect(provisionCliKey).not.toHaveBeenCalled()
  })

  it('mints the canvas key inside the preferred image-capable group when the account can use one -- the 2026-08-12 on-device 503 fix', async () => {
    const provisionCliKey = vi.fn(async (input?: { name?: string; group?: string }) => {
      expect(input?.name).toMatch(/^xingmang-canvas-/)
      expect(input?.group).toBe('生图分组')
      return { id: 7, name: input!.name!, key: 'sk-grouped' }
    })
    const findExistingCliKey = vi.fn()
    const accountService = loggedInAccountService({
      provisionCliKey,
      findExistingCliKey,
      listUsableGroups: vi.fn(async () => [
        { name: 'default', description: '', ratio: 1 },
        { name: '生图分组', description: '', ratio: 1 },
      ]),
    })

    const deps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: resolveRelaySite('solov'),
      previewOnboarding: false,
    })
    const token = await resolveCanvasAuthToken(canvasBaseUrl, deps)

    expect(token).toEqual({ baseUrl: canvasBaseUrl, apiKey: 'sk-grouped' })
    // The name-prefix reuse must NOT run on the grouped path: it is exactly
    // what would resurrect the historical group-less token behind the 503
    // (provisionCliKey's own group-scoped reuse handles dedup instead).
    expect(findExistingCliKey).not.toHaveBeenCalled()
  })

  it('degrades to the group-less legacy path when the group lookup itself fails, reporting via onReuseLookupError', async () => {
    const onReuseLookupError = vi.fn()
    const groupFailure = new Error('分组查询超时')
    const provisionCliKey = vi.fn(async (input?: { name?: string; group?: string }) => {
      expect(input?.group).toBeUndefined()
      return { id: 1, name: input!.name!, key: 'sk-ungrouped' }
    })
    const accountService = loggedInAccountService({
      provisionCliKey,
      listUsableGroups: vi.fn(async () => { throw groupFailure }),
    })

    const deps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: resolveRelaySite('solov'),
      previewOnboarding: false,
      onReuseLookupError,
    })
    const token = await resolveCanvasAuthToken(canvasBaseUrl, deps)

    expect(token).toEqual({ baseUrl: canvasBaseUrl, apiKey: 'sk-ungrouped' })
    expect(onReuseLookupError).toHaveBeenCalledWith(groupFailure)
  })

  it('on a manual-key site, hands canvas the pasted CLI key without any account call, and null when nothing is pasted', async () => {
    const sub2apiSite = resolveRelaySite('sub2api')
    const relayBaseUrl = canvasBaseUrlForSite(sub2apiSite)
    // Every account-service method throws: a manual-key site must never
    // consult the session or mint keys (the pasted key is relay-scoped and
    // pairs with the same relay origin the CLIs already call).
    const accountService = {
      getSessionState: vi.fn(() => { throw new Error('must not consult the session') }),
      findExistingCliKey: vi.fn(async () => { throw new Error('must not look up tokens') }),
      provisionCliKey: vi.fn(async () => { throw new Error('must not mint tokens') }),
    } as unknown as NewApiClientService

    const pastedDeps = buildCanvasTokenDependencies({
      systemService: {
        revealApiKey: vi.fn((provider: string) => (provider === 'claude' ? 'sk-pasted-relay' : '')),
      } as unknown as SystemService,
      accountService,
      relaySite: sub2apiSite,
      previewOnboarding: false,
    })
    await expect(resolveCanvasAuthToken(relayBaseUrl, pastedDeps)).resolves.toEqual({
      baseUrl: relayBaseUrl,
      apiKey: 'sk-pasted-relay',
    })

    const emptyDeps = buildCanvasTokenDependencies({
      systemService: noCliConfiguredSystemService(),
      accountService,
      relaySite: sub2apiSite,
      previewOnboarding: false,
    })
    await expect(resolveCanvasAuthToken(relayBaseUrl, emptyDeps)).resolves.toBeNull()
  })

  it('pairs each site with the origin its keys are issued for', () => {
    // new-api site: keys are minted on the account origin. manual-key site:
    // the pasted key belongs to the relay itself.
    expect(canvasBaseUrlForSite(resolveRelaySite('solov'))).toBe('https://xm.solov.cc')
    expect(canvasBaseUrlForSite(resolveRelaySite('sub2api'))).toBe('https://xm.solov.cc')
  })
})

describe('pickCanvasKeyGroup', () => {
  it('prefers the verified image group over openai and auto regardless of listing order', () => {
    expect(pickCanvasKeyGroup(['auto', 'openai', '生图分组', 'default'])).toBe('生图分组')
  })

  it('falls back through openai to auto, and to null when nothing preferred is usable', () => {
    expect(pickCanvasKeyGroup(['default', 'openai'])).toBe('openai')
    expect(pickCanvasKeyGroup(['default', 'auto'])).toBe('auto')
    // CLI-only groups (the #81 provisioner's four) never satisfy the canvas:
    // none of them contains an image channel.
    expect(pickCanvasKeyGroup(['default', 'Claude-MAX(不限制客户端)-5m', 'codex-pro'])).toBeNull()
    expect(pickCanvasKeyGroup([])).toBeNull()
  })
})
