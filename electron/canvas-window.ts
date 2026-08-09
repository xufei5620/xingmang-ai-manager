import fs from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  protocol,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents,
} from 'electron'
import { providerIds } from './catalog'
import {
  canvasPackagedBaseUrl,
  canvasProtocolScheme,
  isAllowedAppNavigationUrl,
  isTrustedIpcSenderUrl,
  resolveCanvasProtocolFile,
  type ApplicationUrlPolicy,
} from './canvas-protocol'
import {
  buildCanvasAiConfigInjection,
  type CanvasAuthToken,
} from './canvas-ai-config'
import { resolveCanvasAuthToken, type CanvasAuthTokenDependencies } from './canvas-auth'
import { isAllowedExternalUrl } from './security'
import { readBoundedUtf8File } from './bounded-file'
import { writeAtomicSafeUtf8File } from './safe-local-data'
import { buildCliKeyName } from './new-api-client'
import { relaySites } from './relay-sites'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'
import type { RuntimeLogStore } from './runtime-log'
import { createExternalShellLauncher, type ExternalShellLauncher } from './system-shell'

// Derived from the site registry's solov entry (T2 precedent, W3) rather
// than importing new-api-client.ts's own defaultBaseUrl re-export: this
// window's only declared dependency on the account backend is the
// backend-agnostic RelayBackendClient interface (see
// CanvasWindowControllerOptions.accountService below, "this window never
// needs to know which relay backend minted its canvas key") -- reaching into
// new-api-client.ts just for this one literal would quietly reintroduce a
// concrete-backend import into a module that otherwise never needs one.
// solov is guaranteed to declare accountBaseUrl -- it is the one
// relay-sites.ts entry with accountBackend: 'new-api' -- but the field is
// typed optional on RelaySite (a manual-key site like sub2api has none), so
// the `?? ` fallback below exists purely to stay type-safe; it is
// unreachable in practice.
const newApiDefaultBaseUrl = relaySites.find((site) => site.id === 'solov')?.accountBaseUrl
  ?? 'https://xm.solov.cc'

// Narrow, hand-maintained channel names for the canvas window's own host
// bridge -- deliberately NOT part of ipc-contract.ts's XingmangInvokeContract
// (that contract is exclusively for the main app's window.xingmang bridge,
// consumed from src/). canvas-preload.ts cannot import these as values (I7:
// sandboxed preload scripts cannot require local runtime modules) so it
// duplicates the literals; keep both copies in sync by hand if these ever
// change.
export const canvasHostAuthTokenChannel = 'canvas-host:auth-token'
export const canvasHostSaveFileChannel = 'canvas-host:save-file'
export const canvasHostPickFileChannel = 'canvas-host:pick-file'
export const canvasHostNotifyChannel = 'canvas-host:notify'
export const canvasHostOpenExternalChannel = 'canvas-host:open-external'

const maximumSavedFileBytes = 20 * 1024 * 1024
const maximumPickedFileBytes = 20 * 1024 * 1024
const maximumTitleLength = 200
const maximumBodyLength = 2_000

export interface CanvasWindowControllerOptions {
  /** Absolute path to the packaged infinite-canvas dist/ directory. */
  canvasDistRoot: string
  externalUrlAllowlist: readonly string[]
  systemService: SystemService
  // Typed as the backend-agnostic RelayBackendClient (relay-backend.ts), not
  // new-api-client.ts's concrete type -- this window never needs to know
  // which relay backend minted its canvas key.
  accountService: RelayBackendClient
  previewOnboarding: boolean
  runtimeLog: RuntimeLogStore
  externalShell?: ExternalShellLauncher
}

export interface CanvasWindowController {
  /** Opens the canvas window, or focuses it if already open. Idempotent under rapid repeat calls (in-flight creation is reused, never doubled). */
  open(): Promise<void>
  /** Closes the canvas window if one is open; a no-op otherwise. */
  closeIfOpen(): void
  /** Removes every IPC handler this controller registered. */
  dispose(): void
}

function senderUrlOf(event: IpcMainEvent | IpcMainInvokeEvent): string {
  return event.senderFrame?.url ?? event.sender.getURL()
}

function requiredCanvasString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label}格式错误`)
  }
  return value
}

// Every token this app mints for the canvas window (as opposed to one an
// installed CLI already has configured) uses this name prefix -- shared
// between the create call and the reuse lookup below so the two can never
// drift apart.
export const canvasCliKeyNamePrefix = 'xingmang-canvas'

export interface CanvasTokenResolutionDependencies {
  systemService: SystemService
  accountService: RelayBackendClient
  previewOnboarding: boolean
  onProvisionError?: (error: unknown) => void
  onReuseLookupError?: (error: unknown) => void
}

/**
 * Builds the CanvasAuthTokenDependencies resolveCanvasAuthToken
 * (canvas-auth.ts) needs for a real run. A top-level, independently
 * testable function (CLAUDE.md 6节 "新逻辑优先写成纯函数再测") rather than
 * inlined into resolveTokenForNewWindow's closure, so the fix below can be
 * exercised with fakes -- no BrowserWindow required.
 *
 * Orphan-token fix: a logged-in user with no CLI configured yet used to hit
 * provisionRelayKey on *every* canvas window open, even though canvas's own
 * localStorage already held the key from the previous open --
 * buildCanvasAiConfigInjection's no-op guard correctly refuses to clobber an
 * already-configured value, but the freshly minted token had already been
 * created server-side before that guard ever runs, so it was provisioned
 * and then never used again: an orphan xingmang-canvas-* token accumulating
 * on the account forever. provisionRelayKey now asks
 * accountService.findExistingCliKey() to reuse a previously-minted token
 * before ever creating a new one. Reusing by server-side name prefix
 * (rather than caching the key locally in this app's own data directory)
 * also keeps xm.solov.cc's own token list as the single source of truth --
 * this app still never persists a second on-disk plaintext copy of its own
 * (docs/RECON-new-api.md section D: "星芒自身不二次落盘明文").
 */
export function buildCanvasTokenDependencies(
  deps: CanvasTokenResolutionDependencies,
): CanvasAuthTokenDependencies {
  return {
    isAccountAuthenticated: () => deps.accountService.getSessionState().authenticated,
    revealConfiguredRelayKey: () => {
      for (const provider of providerIds) {
        const key = deps.systemService.revealApiKey(provider, deps.previewOnboarding)
        if (key) return key
      }
      return ''
    },
    provisionRelayKey: async () => {
      try {
        const existing = await deps.accountService.findExistingCliKey(`${canvasCliKeyNamePrefix}-`)
        if (existing) return existing.key
      } catch (error) {
        deps.onReuseLookupError?.(error)
      }
      const created = await deps.accountService.provisionCliKey({ name: buildCliKeyName(canvasCliKeyNamePrefix) })
      return created.key
    },
    onProvisionError: deps.onProvisionError,
  }
}

/**
 * Builds and wires an isolated BrowserWindow for the bundled infinite-canvas
 * app, plus the narrow host bridge it talks to. See the task report for the
 * full isolation checklist; in short: separate BrowserWindow, separate
 * sandboxed preload, separate xingmang-canvas:// protocol restricted to
 * canvasDistRoot, separate IPC channel namespace validated against the
 * canvas window's own origin (never the main app's) -- the canvas page can
 * never reach window.xingmang or any ipcMain channel the main app owns.
 */
export function createCanvasWindowController(
  options: CanvasWindowControllerOptions,
): CanvasWindowController {
  const policy: ApplicationUrlPolicy = {
    rendererRoot: options.canvasDistRoot,
    packagedBaseUrl: canvasPackagedBaseUrl,
  }
  const externalShell = options.externalShell ?? createExternalShellLauncher()
  const tokenByWebContents = new WeakMap<WebContents, CanvasAuthToken | null>()
  const handleChannels: string[] = []
  let canvasWindow: BrowserWindow | null = null
  let pendingOpen: Promise<void> | null = null

  protocol.registerFileProtocol(canvasProtocolScheme, (request, callback) => {
    const target = resolveCanvasProtocolFile(request.url, policy)
    if (!target) {
      callback({ error: -6 })
      return
    }
    callback({ path: target })
  })

  function assertTrustedCanvasSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
    if (!isTrustedIpcSenderUrl(senderUrlOf(event), policy)) {
      throw new Error('已拒绝来自非画布页面的操作请求')
    }
  }

  function registerCanvasHandler(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void {
    handleChannels.push(channel)
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedCanvasSender(event)
      return handler(event, ...args)
    })
  }

  registerCanvasHandler(canvasHostSaveFileChannel, async (event, suggestedNameInput, contentInput) => {
    const suggestedName = requiredCanvasString(suggestedNameInput, '保存文件名', 256)
    const content = requiredCanvasString(contentInput, '保存内容', maximumSavedFileBytes)
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: SaveDialogOptions = {
      title: '画布：保存文件',
      defaultPath: suggestedName,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    }
    const result = parentWindow
      ? await dialog.showSaveDialog(parentWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, content, '画布导出文件')
    return { savedPath: result.filePath }
  })

  registerCanvasHandler(canvasHostPickFileChannel, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '画布：选择文件',
      properties: ['openFile'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    const content = await readBoundedUtf8File(filePath, maximumPickedFileBytes, '画布导入文件')
    return { name: path.basename(filePath), content }
  })

  registerCanvasHandler(canvasHostNotifyChannel, (_event, titleInput, bodyInput) => {
    const title = requiredCanvasString(titleInput, '通知标题', maximumTitleLength)
    const body = bodyInput === undefined ? '' : requiredCanvasString(bodyInput, '通知内容', maximumBodyLength)
    if (!Notification.isSupported()) return false
    new Notification({ title, body }).show()
    return true
  })

  registerCanvasHandler(canvasHostOpenExternalChannel, async (_event, urlInput) => {
    if (typeof urlInput !== 'string' || !isAllowedExternalUrl(urlInput, options.externalUrlAllowlist)) {
      throw new Error('不允许打开该链接')
    }
    await externalShell.openExternal(urlInput)
    return true
  })

  // Synchronous by necessity: the canvas preload must finish seeding
  // localStorage before infinite-canvas's own module script runs (see the
  // task report), and that ordering can only be guaranteed with a blocking
  // call resolved from data already computed before this window started
  // loading -- an async invoke() here would race the page's own boot.
  ipcMain.on(canvasHostAuthTokenChannel, (event, existingRawInput: unknown) => {
    if (!isTrustedIpcSenderUrl(senderUrlOf(event), policy)) {
      event.returnValue = { token: null, storageValue: null }
      return
    }
    const token = tokenByWebContents.get(event.sender) ?? null
    const existingRaw = typeof existingRawInput === 'string' ? existingRawInput : null
    event.returnValue = { token, storageValue: buildCanvasAiConfigInjection(existingRaw, token) }
  })

  async function resolveTokenForNewWindow(): Promise<CanvasAuthToken | null> {
    // baseUrl mirrors XM_SOLOV_BASE_URL, already baked into the canvas
    // build's own defaultConfig (阶段 B) -- this only ever needs to supply
    // the apiKey half in practice, but is explicit for defensiveness.
    return resolveCanvasAuthToken(newApiDefaultBaseUrl, buildCanvasTokenDependencies({
      systemService: options.systemService,
      accountService: options.accountService,
      previewOnboarding: options.previewOnboarding,
      onProvisionError: (error) => {
        options.runtimeLog.exception('canvas', 'auth-token.provision.failed', error)
      },
      onReuseLookupError: (error) => {
        options.runtimeLog.exception('canvas', 'auth-token.reuse-lookup.failed', error)
      },
    }))
  }

  function assertCanvasDistPresent(): void {
    const indexPath = path.join(options.canvasDistRoot, 'index.html')
    if (!fs.existsSync(indexPath)) {
      throw new Error('画布资源未找到，请重新安装应用')
    }
  }

  async function createWindow(): Promise<void> {
    assertCanvasDistPresent()
    const token = await resolveTokenForNewWindow()

    const window = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 960,
      minHeight: 620,
      show: false,
      title: '无限画布 - 星芒AI管理工具',
      webPreferences: {
        preload: path.join(__dirname, 'canvas-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged,
        // No webview escape hatch, and no drag-drop navigation out of the
        // sandboxed origin -- matches the main window's hardening exactly.
        webviewTag: false,
        navigateOnDragDrop: false,
      },
    })
    tokenByWebContents.set(window.webContents, token)
    canvasWindow = window

    window.once('ready-to-show', () => {
      window.center()
      window.show()
    })
    window.on('closed', () => {
      if (canvasWindow === window) canvasWindow = null
    })
    // Deny every popup by default; the only ones ever legitimate are the
    // handful of known external links infinite-canvas itself opens via
    // window.open(url, "_blank") (docs button, About-modal GitHub credit).
    // Those still never get a real popup window -- shell.openExternal hands
    // them to the OS browser instead, and the popup request itself is
    // always denied.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url, options.externalUrlAllowlist)) {
        void externalShell.openExternal(url)
      }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (isAllowedAppNavigationUrl(targetUrl, policy)) return
      event.preventDefault()
      if (isAllowedExternalUrl(targetUrl, options.externalUrlAllowlist)) {
        void externalShell.openExternal(targetUrl)
      }
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      options.runtimeLog.log('error', 'canvas', 'process.gone', '画布渲染进程异常退出', {
        reason: details.reason,
        exitCode: details.exitCode,
      })
    })

    // Load the bare protocol root (pathname '/'), not '/index.html'. The canvas
    // SPA uses createBrowserRouter and only registers '/', so a '/index.html'
    // path 404s in its router; the protocol handler's catch-all still serves
    // index.html for '/', letting the app boot on its home route.
    await window.loadURL(canvasPackagedBaseUrl)
  }

  return {
    async open() {
      if (canvasWindow && !canvasWindow.isDestroyed()) {
        if (canvasWindow.isMinimized()) canvasWindow.restore()
        canvasWindow.show()
        canvasWindow.focus()
        return
      }
      if (!pendingOpen) {
        pendingOpen = createWindow().finally(() => {
          pendingOpen = null
        })
      }
      await pendingOpen
    },
    closeIfOpen() {
      if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.close()
    },
    dispose() {
      if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.close()
      canvasWindow = null
      for (const channel of handleChannels) ipcMain.removeHandler(channel)
      ipcMain.removeAllListeners(canvasHostAuthTokenChannel)
    },
  }
}
