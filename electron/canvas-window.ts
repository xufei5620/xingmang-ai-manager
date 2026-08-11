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
import { resolveRelaySite, type RelaySite } from './relay-sites'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'
import type { RuntimeLogStore } from './runtime-log'
import { createExternalShellLauncher, type ExternalShellLauncher } from './system-shell'

/**
 * Which origin the canvas AI channel should call for the active relay site.
 * The canvas channel is OpenAI-compatible (CANVAS-INTEGRATION-PLAN 阶段 B),
 * and the key must be handed out with the origin it was issued for:
 *
 * - new-api site: keys are minted on the account origin (xm.solov.cc), which
 *   serves the OpenAI-compatible API on the same origin -- unchanged from the
 *   pre-multi-site behaviour.
 * - manual-key site: there is no account origin; the pasted key belongs to
 *   the relay itself, so canvas gets the relay origin the CLIs already use.
 *   URL#origin strips any per-CLI path suffix a future entry might carry.
 *
 * Derived from the site registry (T2 precedent, W3) rather than importing
 * new-api-client.ts's own defaultBaseUrl re-export: this window's only
 * declared dependency on the account backend is the backend-agnostic
 * RelayBackendClient interface.
 */
export function canvasBaseUrlForSite(site: RelaySite): string {
  if (site.accountBackend === 'new-api' && site.accountBaseUrl) return site.accountBaseUrl
  return new URL(site.providerBaseUrls.codex).origin
}

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
export const canvasHostDownloadAssetChannel = 'canvas-host:download-asset'

const maximumSavedFileBytes = 20 * 1024 * 1024
const maximumPickedFileBytes = 20 * 1024 * 1024
// 画布 v2 的媒体产物落盘(canvas-host:download-asset):视频动辄几十 MB,
// 走不了 20MB 纯文本桥,由主进程拉 URL 流式写盘。上限对齐"单条生成视频"
// 的现实量级并留余量。
const maximumDownloadedAssetBytes = 512 * 1024 * 1024
const downloadAssetTimeoutMs = 10 * 60 * 1000
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
  /** The active relay site; decides whether an account backend exists to gate on and mint from. */
  relaySite: RelaySite
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
    hasAccountBackend: () => deps.relaySite.accountBackend === 'new-api',
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

  // I15 投毒问答(新增能力必答):被投毒的画布能让宿主拉任意 https URL 并
  // 写入用户亲自在原生保存对话框里选择的路径——与用户在浏览器里点击任意
  // 下载链接同权:无路径控制、无静默写入、内容不被执行。I10 四件:超时 +
  // 字节上限(流式计数,Content-Length 撒谎也拦得住)+ https-only 且拒
  // 内嵌凭据 + 跟随重定向仍走 fetch 自身的 https 栈。失败清理半成品文件。
  registerCanvasHandler(canvasHostDownloadAssetChannel, async (event, urlInput, suggestedNameInput) => {
    const url = requiredCanvasString(urlInput, '产物地址', 4_096)
    const suggestedName = requiredCanvasString(suggestedNameInput, '保存文件名', 256)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('产物地址不是有效的 URL')
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      throw new Error('产物地址必须是不含凭据的 https 链接')
    }
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: SaveDialogOptions = {
      title: '画布：保存生成产物',
      defaultPath: suggestedName,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    }
    const result = parentWindow
      ? await dialog.showSaveDialog(parentWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    const targetPath = result.filePath

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), downloadAssetTimeoutMs)
    try {
      const response = await fetch(parsed.href, { signal: controller.signal })
      if (!response.ok || !response.body) {
        throw new Error(`产物下载失败，服务返回 ${response.status}`)
      }
      const reader = response.body.getReader()
      let written = 0
      const stream = fs.createWriteStream(targetPath)
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          written += value.byteLength
          if (written > maximumDownloadedAssetBytes) {
            throw new Error('产物超出大小上限，已中止下载')
          }
          await new Promise<void>((resolve, reject) => {
            stream.write(Buffer.from(value), (error) => (error ? reject(error) : resolve()))
          })
        }
        await new Promise<void>((resolve, reject) => {
          stream.end((error: NodeJS.ErrnoException | null | undefined) => (error ? reject(error) : resolve()))
        })
      } catch (error) {
        stream.destroy()
        await fs.promises.unlink(targetPath).catch(() => undefined)
        throw error
      }
      return { savedPath: targetPath, bytes: written }
    } finally {
      clearTimeout(timer)
    }
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
    // Resolved per window open (same pattern as system-service.ts's own
    // consumers) so a site switch in settings takes effect on the next
    // canvas open without restarting. For the new-api site the baseUrl
    // mirrors XM_SOLOV_BASE_URL already baked into the canvas build's own
    // defaultConfig (阶段 B); for a manual-key site it is the relay origin
    // the pasted key belongs to.
    const activeSite = resolveRelaySite(options.systemService.readStoredConfig().relaySiteId)
    return resolveCanvasAuthToken(canvasBaseUrlForSite(activeSite), buildCanvasTokenDependencies({
      systemService: options.systemService,
      accountService: options.accountService,
      relaySite: activeSite,
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
