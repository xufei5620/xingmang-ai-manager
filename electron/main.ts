import path from 'node:path'
import os from 'node:os'
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type WebContents,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { AccountCredentialStore } from './account-credential-store'
import { AiAssetStore, resolveAiOutputRoot } from './ai-asset-store'
import { createAiChatService } from './ai-chat-service'
import { createAiImageService } from './ai-image-service'
import { AiVideoAssetStore } from './ai-video-asset-store'
import { AiAudioAssetStore } from './ai-audio-asset-store'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'
import { AiVideoTaskStore } from './ai-video-task-store'
import { createAiVideoService } from './ai-video-service'
import { createAiMediaAssetService } from './ai-media-asset-service'
import { assetThumbnailMaxEdge, assetThumbnailSize, assetThumbnailVersion, parseAssetThumbnailPath } from './asset-thumbnail'
import { AssetThumbnailStore } from './asset-thumbnail-store'
import { createAssetThumbnailService, type AssetThumbnailRenderer, type AssetThumbnailService } from './asset-thumbnail-service'
import { createChatCredentialCoordinator } from './chat-credential-coordinator'
import { ChatKeyStore } from './chat-key-store'
import { ManagedCliKeyStore } from './managed-cli-key-store'
import { AccountSessionStore, restoreAccountSessionOnStartup } from './account-session-store'
import { SavedAccountsStore, savedAccountId } from './saved-accounts'
import { AppSettingsStore, type AppTheme } from './app-settings'
import { calculateUiZoom, resolveWindowPlacement } from './window-preferences'
import { createWindowLifecycle } from './window-lifecycle'
import { createApplicationTray, type ApplicationTrayController } from './application-tray'
import { createWindowCloseQuery } from './window-close-query'
import { createExternalDeepLinkInbox } from './external-deep-links'
import { createDesktopNotificationController } from './desktop-notifications'
import { ConfigBackupStore } from './backups'
import { providerIds } from './catalog'
import { canvasProtocolScheme, canvasSecurityResponseHeaders } from './canvas-protocol'
import { createCanvasWindowController } from './canvas-window'
import { createCanvasAccountLifecycle } from './canvas-account-lifecycle'
import { CanvasRunStore } from './canvas-run-store'
import { createCanvasNodeExecutors } from './canvas-node-executors'
import { createCanvasRunService } from './canvas-run-service'
import { CanvasPromptPresetStore } from './canvas-prompt-preset-store'
import { CanvasProjectStore } from './canvas-project-store'
import { CanvasProjectAssetManager, createCanvasProjectAssetContext } from './canvas-project-asset-manager'
import { parseSingleByteRange } from './byte-range'
import { resolveCodexHomeContext } from './codex-home'
import { runWithTrustedWindowsProcessEnvironment } from './command-runner'
import { CodexExtensionService } from './codex-extensions'
import { CodexSessionsService } from './codex-sessions'
import { createNewApiClient } from './new-api-client'
import type { RelayBackendClient } from './relay-backend'
import { ProviderExtensionService } from './provider-extensions'
import { ProviderSessionsService } from './provider-sessions'
import { guardProcessOutputStreams } from './process-stream-errors'
import { RuntimeLogStore } from './runtime-log'
import { recordStartupFailure } from './startup-log'
import { inspectProviderConfig } from './config-files'
import { rootedMainServiceOptions } from './main-service-options'
import { privacyPolicyUrl, relaySiteExternalUrls, relaySites, resolveRelaySite, supportServiceUrl, userAgreementUrl } from './relay-sites'
import { createPaymentWindowController } from './payment-window'
import {
  createDiagnosticsExport,
  runDiagnostics,
  type DiagnosticsReport,
} from './diagnostics'
import { registerIpcHandlers, type AppWindowMode } from './ipc'
import {
  installXingmangAiSkillFiles,
  resolveXingmangAiBundledSkillRoot,
} from './xingmang-ai-skill'
import { ipcEventChannels, type AccountBalance } from './ipc-contract'
import {
  shouldUseManualUninstallVisualFixture,
  withManualUninstallVisualFixture,
} from './manual-uninstall-visual-fixture'
import {
  hasDisallowedPackagedDebugSwitch,
  isAllowedAppNavigationUrl,
  resolvePackagedApplicationFile,
  type ApplicationUrlPolicy,
} from './security'
import {
  createSystemService,
  type SystemService,
  type SystemSnapshot,
} from './system-service'
import { installStrictUpdateCodeSignatureVerifier } from './update-signature'
import { createUpdaterService } from './updater'
import { resolveWindowsCliExecutionMode } from './windows-elevation'
import {
  applyWindowTheme,
  buildMacApplicationMenuTemplate,
  platformWindowOptions,
  startupFailureMessage,
} from './window-presentation'

guardProcessOutputStreams()

const applicationPackage = require('../package.json') as {
  xingmangLocalBuild?: unknown
}

const nonSiteExternalUrlAllowlist = [
  'https://nodejs.org/',
  'https://www.python.org/downloads/',
  'https://chatgpt.com/download/',
  'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS',
] as const

// Every relay site's own destinations (marketing and keys pages) is derived
// from relay-sites.ts. Recharge stays in the desktop account center.
const externalUrlAllowlist = [
  ...nonSiteExternalUrlAllowlist,
  ...relaySiteExternalUrls(relaySites),
  // 注册/登录弹窗与欢迎页脚的用户协议/隐私政策链接(I12 全等匹配)。
  userAgreementUrl,
  privacyPolicyUrl,
  supportServiceUrl,
] as const

// The infinite-canvas build's own two runtime-visible external destinations
// (docs button, About-modal "查看开源项目" GitHub credit -- see the task
// report for how these were confirmed against the actual built bundle).
// Kept separate from externalUrlAllowlist above: the canvas window's
// setWindowOpenHandler/will-navigate checks only ever consult this list, so
// the canvas page can never reach a main-app destination (or vice versa)
// just because the two lists happened to be merged.
const canvasExternalUrlAllowlist = [
  'https://docs.canvas.best',
  'https://github.com/basketikun/infinite-canvas',
] as const

const windowPreferenceAppliers = new WeakMap<WebContents, () => void>()
const windowPreferenceFlushers = new WeakMap<WebContents, () => Promise<void>>()

const updateCheckIntervalMs = 3 * 60 * 60 * 1_000
const packagedApplicationBaseUrl = 'xingmang://app/'

protocol.registerSchemesAsPrivileged([{
  scheme: 'xingmang',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    codeCache: true,
    stream: true,
  },
}, {
  // Same privileges as xingmang:// above, granted to a second, independent
  // scheme so the isolated canvas window's resources never share a
  // rendererRoot (or a traversal bug) with the main app's. See
  // canvas-protocol.ts / canvas-window.ts for the request handler.
  scheme: canvasProtocolScheme,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    codeCache: true,
    stream: true,
  },
}, {
  scheme: 'xingmang-asset',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}])

function windowThemePalette(theme: AppTheme): {
  background: string
  titleBar: string
  symbol: string
} {
  return theme === 'dark'
    ? { background: '#17191b', titleBar: '#202426', symbol: '#eef1f2' }
    : { background: '#f4f6f9', titleBar: '#ffffff', symbol: '#29333a' }
}

function applicationUrlPolicy(): ApplicationUrlPolicy {
  return {
    rendererRoot: path.join(__dirname, '..', 'dist'),
    // A packaged binary must never accept an environment-provided renderer.
    // That value is intentionally limited to the local development process.
    devServerUrl: app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL,
    packagedBaseUrl: packagedApplicationBaseUrl,
  }
}

// dist-canvas/ is a build artifact (scripts/copy-canvas-assets.mjs copies it
// from the sibling xingmang-canvas repo's own dist/ output at compile time;
// see the task report for why it is not vendored into git) that sits next to
// dist/ and dist-electron/ at the project root, and is packaged the same way
// dist/ already is (electron-builder.config.cjs's `files` list). No dev
// server concept applies here -- the canvas window always loads the
// packaged build, never a live Vite server, in both dev and packaged runs.
function canvasDistRoot(): string {
  return path.join(__dirname, '..', 'dist-canvas')
}

function registerApplicationProtocol(policy: ApplicationUrlPolicy): void {
  protocol.registerFileProtocol('xingmang', (request, callback) => {
    const target = resolvePackagedApplicationFile(request.url, policy)
    if (!target) {
      callback({ error: -6 })
      return
    }
    callback({ path: target })
  })
}

/**
 * Derives thumbnails with Electron's bundled Skia encoder.
 *
 * The plan called for `createImageBitmap` plus `OffscreenCanvas` in a
 * `utilityProcess`. That is not available: a utility process is a Node.js
 * environment with Electron's `net` module, not a Blink one, so it has neither
 * global. The alternative that keeps those APIs would be a hidden
 * `BrowserWindow`, which adds a renderer surface for no benefit. `nativeImage`
 * gives the same Chromium decoders synchronously in the main process with zero
 * new dependencies, which is why generation is serialized behind a queue.
 */
function createNativeThumbnailRenderer(): AssetThumbnailRenderer {
  return {
    async fromImageBytes(bytes, mimeType) {
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) return null
      const { width, height } = image.getSize()
      const contained = assetThumbnailSize(width, height)
      const resized = image.resize({ ...contained, quality: 'better' })
      if (resized.isEmpty()) return null
      return mimeType === 'image/jpeg' ? resized.toJPEG(82) : resized.toPNG()
    },
    async fromMediaFile(filePath) {
      // Backed by the platform shell thumbnail provider, which exists only on
      // Windows and macOS. Both are the platforms this product ships on, and
      // elsewhere the tray falls back to its own placeholder.
      if (process.platform !== 'win32' && process.platform !== 'darwin') return null
      try {
        const image = await nativeImage.createThumbnailFromPath(filePath, {
          width: assetThumbnailMaxEdge,
          height: assetThumbnailMaxEdge,
        })
        return image.isEmpty() ? null : image.toPNG()
      } catch {
        return null
      }
    },
  }
}

function registerAiAssetProtocol(
  assets: Pick<CanvasProjectAssetManager, 'readOwned'>,
  accountService: Pick<RelayBackendClient, 'getSessionState'>,
  thumbnails: Pick<AssetThumbnailService, 'resolve'>,
): void {
  protocol.handle('xingmang-asset', async (request) => {
    try {
      const url = new URL(request.url)
      if (!['image', 'video', 'audio', 'thumb'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
        return new Response(null, { status: 404 })
      }
      const sessionStateForThumbnail = accountService.getSessionState()
      if (url.hostname === 'thumb') {
        const parsed = parseAssetThumbnailPath(url.pathname)
        if (!parsed || parsed.version !== assetThumbnailVersion) return new Response(null, { status: 404 })
        const owner = sessionStateForThumbnail.authenticated ? sessionStateForThumbnail.account?.userId : undefined
        if (!owner) return new Response(null, { status: 401 })
        const derived = await thumbnails.resolve(owner, parsed.assetId, parsed.mediaKind)
        if (!derived) return new Response(null, { status: 404 })
        return new Response(derived.bytes, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            // Asset identifiers are content addressed and the pipeline version
            // is part of the path, so a response can never go stale in place.
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Length': String(derived.bytes.byteLength),
            'Content-Type': derived.mimeType,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      const assetId = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const sessionState = accountService.getSessionState()
      const userId = sessionState.authenticated ? sessionState.account?.userId : undefined
      if (!userId) return new Response(null, { status: 401 })
      const owned = await assets.readOwned(userId, assetId, url.hostname as 'image' | 'video' | 'audio')
      const range = request.headers.get('range')
      let body = owned.bytes
      let status = 200
      const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': owned.asset.mimeType,
        'X-Content-Type-Options': 'nosniff',
      }
      if (range) {
        const parsedRange = parseSingleByteRange(range, body.byteLength)
        if (!parsedRange) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${body.byteLength}` } })
        }
        const { start, end } = parsedRange
        status = 206
        body = body.subarray(start, end + 1)
        headers['Content-Range'] = `bytes ${start}-${end}/${owned.bytes.byteLength}`
      }
      headers['Content-Length'] = String(body.byteLength)
      return new Response(body, {
        status,
        headers: {
          ...headers,
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

function windowForContents(contents: WebContents): BrowserWindow {
  const target = BrowserWindow.fromWebContents(contents)
  if (!target) throw new Error('未找到应用窗口')
  return target
}

function setWindowMode(contents: WebContents, _mode: AppWindowMode): void {
  const target = windowForContents(contents)
  const workArea = screen.getDisplayMatching(target.getBounds()).workAreaSize
  target.setMinimumSize(Math.min(960, workArea.width), Math.min(560, workArea.height))
  windowPreferenceAppliers.get(contents)?.()
}

function setWindowTheme(contents: WebContents, theme: AppTheme): void {
  const target = windowForContents(contents)
  const palette = windowThemePalette(theme)
  applyWindowTheme(target, palette, process.platform)
  windowPreferenceAppliers.get(contents)?.()
}

function createWindow(
  systemService: SystemService,
  urlPolicy: ApplicationUrlPolicy,
  runtimeLog: RuntimeLogStore,
): BrowserWindow {
  const stored = systemService.readStoredConfig()
  const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'
  const previewDashboard = !app.isPackaged && process.env.XINGMANG_DASHBOARD_PREVIEW === '1'
  const placement = resolveWindowPlacement(stored.windowState, screen.getAllDisplays(), screen.getPrimaryDisplay().id)
  const palette = windowThemePalette(stored.theme)
  const windowsIcon = path.join(app.getAppPath(), 'assets', 'brand', 'v3', 'favicon.ico')
  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: placement.minimumSize.width,
    minHeight: placement.minimumSize.height,
    show: false,
    backgroundColor: palette.background,
    ...platformWindowOptions(process.platform, palette, windowsIcon),
    title: '星芒AI管理工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      // Do not allow renderer navigation to recover arbitrary opener or
      // inherited browsing context state.
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  })

  window.once('ready-to-show', () => {
    if (placement.maximized) window.maximize()
    window.show()
  })
  const applyPreferences = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const current = systemService.readStoredConfig()
    const zoom = calculateUiZoom(window.getContentBounds().width, current.uiScale)
    if (Math.abs(window.webContents.getZoomFactor() - zoom) > 0.0001) window.webContents.setZoomFactor(zoom)
    if (process.platform !== 'darwin') window.setTitleBarOverlay({ height: Math.round(36 * zoom) })
  }
  windowPreferenceAppliers.set(window.webContents, applyPreferences)
  let boundsTimer: ReturnType<typeof setTimeout> | undefined
  const saveWindowState = async () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    const windowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() }
    await systemService.updateStoredConfig({ version: 2, windowState })
  }
  windowPreferenceFlushers.set(window.webContents, async () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    await saveWindowState()
  })
  const scheduleWindowSave = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      void saveWindowState().catch((cause) => runtimeLog.exception('window', 'preferences.save.failed', cause))
    }, 250)
  }
  window.on('resize', () => { applyPreferences(); scheduleWindowSave() })
  window.on('move', scheduleWindowSave)
  window.on('maximize', scheduleWindowSave)
  window.on('unmaximize', scheduleWindowSave)
  window.once('closed', () => { if (boundsTimer) clearTimeout(boundsTimer) })
  window.webContents.on('did-finish-load', applyPreferences)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppNavigationUrl(targetUrl, urlPolicy)) event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    runtimeLog.log('error', 'renderer', 'process.gone', '渲染进程异常退出', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })
  window.webContents.on('did-finish-load', () => {
    runtimeLog.log('info', 'renderer', 'page.loaded', '渲染页面加载完成')
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    runtimeLog.log('error', 'renderer', 'page.load.failed', errorDescription, {
      errorCode,
      url: validatedUrl,
    })
  })
  window.on('unresponsive', () => {
    runtimeLog.log('warn', 'renderer', 'window.unresponsive', '应用窗口暂时无响应')
  })

  const devServerUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    url.searchParams.set('theme', stored.theme)
    if (previewOnboarding) url.searchParams.set('onboardingPreview', '1')
    if (previewDashboard) url.searchParams.set('dashboardPreview', '1')
    void window.loadURL(url.toString()).catch((error) => {
      runtimeLog.exception('renderer', 'page.load.failed', error)
    })
  } else {
    const applicationUrl = new URL('index.html', packagedApplicationBaseUrl)
    applicationUrl.searchParams.set('theme', stored.theme)
    if (previewOnboarding) applicationUrl.searchParams.set('onboardingPreview', '1')
    if (previewDashboard) applicationUrl.searchParams.set('dashboardPreview', '1')
    void window.loadURL(applicationUrl.href).catch((error) => {
      runtimeLog.exception('renderer', 'page.load.failed', error)
    })
  }
  return window
}

function focusExistingWindow(): boolean {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  return true
}

if (app.isPackaged && hasDisallowedPackagedDebugSwitch(process.argv)) {
  process.exit(1)
}

/** Resolved once, up front, so recording a failure never depends on a step that
 *  might itself be the thing that failed. */
function startupLogLocation(): { userDataDirectory: string | null } {
  try {
    return { userDataDirectory: app.getPath('userData') }
  } catch {
    // Fall back to the pure per-platform default inside startup-log.
    return { userDataDirectory: null }
  }
}

function recordFatalStartupFailure(phase: string, error: unknown): string | null {
  let version: string | null = null
  let packaged: boolean | null = null
  try {
    version = app.getVersion()
    packaged = app.isPackaged
  } catch {
    // Version metadata is a nicety; the stack is the part that matters.
  }
  return recordStartupFailure(error, { phase, appVersion: version, packaged }, startupLogLocation())
}

// Flipped once RuntimeLogStore exists; from then on it owns the record and the
// startup log must stay quiet, or ordinary runtime errors would accumulate in a
// file whose whole purpose is "the app could not start".
let runtimeLoggingActive = false

export function markRuntimeLoggingActive(): void {
  runtimeLoggingActive = true
}

// `uncaughtExceptionMonitor` observes without swallowing: registering a plain
// `uncaughtException` listener would suppress the default termination and let
// the app limp on in a broken state. Unhandled rejections are deliberately not
// hooked here for the same reason — adding a listener before whenReady would
// change what Node does with a rejection that currently ends the process. The
// whenReady `.catch` below already covers the entire async startup chain.
process.on('uncaughtExceptionMonitor', (error) => {
  if (runtimeLoggingActive) return
  recordFatalStartupFailure('uncaughtException', error)
})

const singleInstanceDisabledForDevelopment = !app.isPackaged
  && process.env.XINGMANG_DISABLE_SINGLE_INSTANCE === '1'
const hasSingleInstanceLock = singleInstanceDisabledForDevelopment
  || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  let focusWhenWindowIsReady = false
  const deepLinkInbox = createExternalDeepLinkInbox()
  let receiveDeepLink = (raw: string) => { deepLinkInbox.accept(raw) }
  for (const argument of process.argv) receiveDeepLink(argument)
  app.on('open-url', (event, url) => { event.preventDefault(); receiveDeepLink(url) })
  if (!singleInstanceDisabledForDevelopment) {
    app.on('second-instance', (_event, argv) => {
      for (const argument of argv) receiveDeepLink(argument)
      if (!focusExistingWindow()) focusWhenWindowIsReady = true
    })
  }

  void app.whenReady().then(async () => {
    // Installers register the scheme; development must not take over installed links.
    if (app.isPackaged) app.setAsDefaultProtocolClient('xingmang')
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.xingmang.ai.manager')
      Menu.setApplicationMenu(null)
    } else if (process.platform === 'darwin') {
      const template = buildMacApplicationMenuTemplate('星芒AI管理工具', (target) => {
        const window = BrowserWindow.getFocusedWindow()
          ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
        if (window && !window.isDestroyed()) {
          window.webContents.send(ipcEventChannels.onNavigate, target)
        }
      })
      Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    }
    // 白名单式收紧权限：仅放行剪贴板写入，否则复制配置等功能会静默失效
    const allowedPermissions = new Set(['clipboard-sanitized-write'])
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(allowedPermissions.has(permission))
    })
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
      allowedPermissions.has(permission),
    )
    session.defaultSession.setDevicePermissionHandler(() => false)
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${canvasProtocolScheme}://*/*`] },
      (details, callback) => callback({
        responseHeaders: canvasSecurityResponseHeaders(details.responseHeaders),
      }),
    )
    const managerDataDirectory = app.getPath('userData')
    const codexContext = resolveCodexHomeContext({
      isPackaged: app.isPackaged,
      env: process.env,
      userHome: os.homedir(),
    })
    const manualUninstallVisualFixtureEnabled = shouldUseManualUninstallVisualFixture({
      environmentValue: process.env.XINGMANG_E2E_MANUAL_UNINSTALL_FIXTURE,
      isPackaged: app.isPackaged,
    })
    const rootedOptions = rootedMainServiceOptions(codexContext)
    const runtimeLog = new RuntimeLogStore({
      directory: path.join(managerDataDirectory, 'logs'),
      appName: '星芒AI管理工具',
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
    })
    markRuntimeLoggingActive()
    runtimeLog.log('info', 'main', 'app.started', '应用主进程已启动', {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    })
    if (manualUninstallVisualFixtureEnabled) {
      runtimeLog.log('warn', 'testing', 'manual-uninstall.fixture', '手动卸载视觉测试状态已启用')
    }
    const onUncaughtException = (error: Error) => {
      runtimeLog.exception('main', 'uncaught.exception', error)
    }
    const onUnhandledRejection = (reason: unknown) => {
      runtimeLog.exception('main', 'unhandled.rejection', reason)
    }
    process.on('uncaughtExceptionMonitor', onUncaughtException)
    process.on('unhandledRejection', onUnhandledRejection)

    const settingsStore = new AppSettingsStore(path.join(managerDataDirectory, 'settings.json'))
    // Resolved before the service is built because it also decides whether an
    // unmanaged npm uninstall can run in-app.
    const windowsCliExecutionMode = await resolveWindowsCliExecutionMode({
      isPackaged: app.isPackaged,
    })
    runtimeLog.log('info', 'security', 'cli.execution-mode', 'CLI 扩展执行边界已确定', {
      mode: windowsCliExecutionMode,
    })
    const systemService = createSystemService(settingsStore, {
      windowsExecutionMode: windowsCliExecutionMode,
      ...rootedOptions.system,
    })
    const storedSettings = systemService.readStoredConfig()
    const sessionsService = new CodexSessionsService({
      ...rootedOptions.sessions,
      managerDataDirectory: path.join(managerDataDirectory, 'sessions'),
      onRecoveryWarning: (warning) => {
        runtimeLog.log('warn', 'sessions', warning.code, warning.message, warning.detail)
      },
    })
    const providerSessionsService = new ProviderSessionsService({
      codexService: sessionsService,
    })
    const backupStore = new ConfigBackupStore({
      ...rootedOptions.backups,
      userDataDirectory: managerDataDirectory,
    })
    const extensionService = new CodexExtensionService({
      ...rootedOptions.codexExtensions,
      repositoryRoot: storedSettings.workspace,
      trashDirectory: path.join(managerDataDirectory, 'trash', 'skills'),
      windowsExecutionMode: windowsCliExecutionMode,
    })
    const providerExtensionService = new ProviderExtensionService({
      ...rootedOptions.providerExtensions,
      repositoryRoot: storedSettings.workspace,
      windowsExecutionMode: windowsCliExecutionMode,
    })
    let latestDiagnostics: DiagnosticsReport | null = null
    const diagnosticsService = {
      run: async () => {
        latestDiagnostics = await runDiagnostics({
          ...rootedOptions.diagnostics,
          app: {
            name: '星芒AI管理工具',
            version: app.getVersion(),
            packaged: app.isPackaged,
          },
          inspectCodexDesktop: async () => systemService.inspectCodexDesktop(),
          // Read fresh on every run rather than captured once at startup, so
          // a settings change is reflected on the very next diagnostics run.
          relaySite: resolveRelaySite(systemService.readStoredConfig().relaySiteId),
        })
        return latestDiagnostics
      },
      exportLatest: () => {
        if (!latestDiagnostics) throw new Error('请先运行一次健康诊断')
        return createDiagnosticsExport(latestDiagnostics, {
          ...rootedOptions.diagnosticExport,
          sensitiveValues: providerIds
            .map((provider) => inspectProviderConfig(provider, rootedOptions.system.providerRoots).apiKey)
            .filter(Boolean),
        })
      },
    }
    if (process.platform === 'win32') {
      installStrictUpdateCodeSignatureVerifier(autoUpdater as typeof autoUpdater & {
        verifyUpdateCodeSignature: (publisherNames: string[], filePath: string) => Promise<string | null>
      }, {
        warn: (message) => runtimeLog.log('warn', 'updater', 'signature.publisher.cn-only', message),
      })
    }
    const localBuild = app.isPackaged && applicationPackage.xingmangLocalBuild === true
    const updaterService = createUpdaterService(autoUpdater, {
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      localBuild,
      enableDevelopmentUpdates: process.env.XINGMANG_UPDATE_DEV === '1',
      macInstallHandoff: process.platform === 'darwin'
        ? {
            nativeUpdateDownloadedListenerCount: () => (
              nativeAutoUpdater.listenerCount('update-downloaded')
            ),
            retryNativeCheck: () => nativeAutoUpdater.checkForUpdates(),
          }
        : undefined,
      installEnvironmentGuard: process.platform === 'win32'
        ? (launch) => runWithTrustedWindowsProcessEnvironment(launch)
        : undefined,
      retryWithoutProxy: async () => {
        await autoUpdater.netSession.setProxy({ mode: 'direct' })
      },
    })
    runtimeLog.log('info', 'updater', 'runtime.selected', '主程序更新运行模式已确定', {
      enabled: updaterService.getState().phase !== 'disabled',
      localBuild,
    })
    let periodicUpdateTimer: NodeJS.Timeout | null = null
    let applicationTray: ApplicationTrayController | null = null
    let latestTraySystem: SystemSnapshot | null = null
    let latestTrayBalance: AccountBalance | null = null
    let closeQuery: ReturnType<typeof createWindowCloseQuery> | null = null
    let managedMainWindow: BrowserWindow | null = null
    const desktopNotifications = createDesktopNotificationController({
      readEnabled: () => systemService.readStoredConfig().desktopNotifications === true,
      focusMainWindow: () => {
        if (!managedMainWindow || managedMainWindow.isDestroyed()) return
        if (managedMainWindow.isMinimized()) managedMainWindow.restore()
        managedMainWindow.show()
        managedMainWindow.focus()
      },
      onOpenUpdates: () => {
        if (managedMainWindow && !managedMainWindow.isDestroyed()) managedMainWindow.webContents.send(ipcEventChannels.onNavigate, 'updates')
      },
      onError: (error) => runtimeLog.exception('window', 'notification.failed', error),
      iconPath: path.join(app.getAppPath(), 'assets', 'brand', 'v3', 'favicon.ico'),
    })
    const unsubscribeDesktopNotifications = updaterService.subscribe((state) => desktopNotifications.handleUpdate(state))
    const urlPolicy = applicationUrlPolicy()
    registerApplicationProtocol(urlPolicy)
    const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'

    // W2 login persistence (docs/ACCOUNT-PLAN.md): safeStorage wraps the OS
    // credential store (DPAPI on Windows, Keychain on macOS). When it is
    // unavailable, this deliberately does *not* fall back to writing the
    // refresh cookie in plaintext -- persistence is simply skipped for this
    // run, same as "safeStorage 不可用...不明文落盘兜底" requires. Logged once
    // here rather than on every save so a headless/CI-like environment
    // doesn't spam the log on each login.
    if (!safeStorage.isEncryptionAvailable()) {
      runtimeLog.log(
        'warn',
        'account',
        'session.persist.unavailable',
        '系统未提供安全加密存储，登录状态本次不会持久化，下次启动需重新登录',
      )
    }
    const accountSessionStore = new AccountSessionStore(
      path.join(managerDataDirectory, 'account-session.dat'),
      safeStorage,
    )
    const savedAccounts = new SavedAccountsStore(path.join(managerDataDirectory, 'saved-accounts.dat'), safeStorage)
    const savedAccountsOrigin = new URL(resolveRelaySite(storedSettings.relaySiteId).accountBaseUrl!).origin
    let persistedActiveUserId: number | null = null
    const accountCredentialStore = new AccountCredentialStore(
      path.join(managerDataDirectory, 'account-credentials.dat'),
      safeStorage,
    )
    const managedCliKeyStore = new ManagedCliKeyStore(
      path.join(managerDataDirectory, 'managed-cli-keys.dat'),
      safeStorage,
    )
    const chatKeyStore = new ChatKeyStore(
      path.join(managerDataDirectory, 'chat-group-keys.dat'),
      safeStorage,
    )
    // Constructed explicitly (rather than left to registerIpcHandlers' own
    // internal default) so the canvas window controller below can share this
    // exact instance -- it is the one place that knows whether the user is
    // actually logged in, and a second, independent createNewApiClient()
    // would always report "logged out" regardless of what the user did
    // through the main app's own account:* handlers. onSessionChange is the
    // single choke point (see new-api-client.ts) that keeps the encrypted
    // file in sync with login/logout/silent-refresh from *either* consumer of
    // this shared instance -- a disk failure here only ever gets logged, it
    // must never surface as a failure of whatever account action triggered it.
    // Typed as the backend-agnostic RelayBackendClient (relay-backend.ts) --
    // both consumers wired below (registerIpcHandlers, createCanvasWindowController)
    // depend on that interface, not on new-api-client.ts's concrete type.
    const canvasAccountLifecycle = createCanvasAccountLifecycle({
      onInitializationError: (_userId, error) => {
        runtimeLog.exception('canvas', 'runtime.initialize.failed', error)
      },
    })
    const accountService: RelayBackendClient = createNewApiClient({
      onSessionChange: (persistable) => {
        const previousUserId = persistedActiveUserId
        persistedActiveUserId = persistable?.userId ?? null
        canvasAccountLifecycle.update(persistable?.userId ?? null)
        latestTrayBalance = null
        applicationTray?.updateSnapshot()
        if (persistable) {
          const profile = accountService.getSessionState().account
          if (profile) void savedAccounts.upsert({ ...persistable, origin: savedAccountsOrigin, username: profile.username }).catch((cause) => {
            runtimeLog.exception('account', 'saved-account.persist.failed', cause)
          })
          void accountSessionStore.save(persistable).catch((error) => {
            runtimeLog.log('warn', 'account', 'session.persist.failed', '登录状态持久化失败', {
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        } else {
          if (previousUserId !== null) void savedAccounts.remove(savedAccountId(savedAccountsOrigin, previousUserId)).catch((cause) => {
            runtimeLog.exception('account', 'saved-account.remove.failed', cause)
          })
          void accountSessionStore.clear().catch((error) => {
            runtimeLog.log('warn', 'account', 'session.clear.failed', '登录状态清除失败', {
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        }
      },
    })
    // Fire-and-forget: never blocks window creation (see this promise's own
    // consumer, ipc.ts's account:get-session handler, for why that race is
    // still handled correctly without blocking startup on a slow network).
    const accountSessionReady = restoreAccountSessionOnStartup({
      accountService,
      store: accountSessionStore,
      runtimeLog,
    })
    const chatCredentials = createChatCredentialCoordinator({
      accountService,
      modelService: systemService,
      keyStore: chatKeyStore,
    })
    const aiOutputRoot = resolveAiOutputRoot({
      isPackaged: app.isPackaged,
      projectRoot: path.join(__dirname, '..'),
      execPath: process.execPath,
    })
    const assetStore = new AiAssetStore({
      outputRoot: aiOutputRoot,
      trustedProxyFetchImpl: (input, init) => net.fetch(input, init),
      nativeOperations: {
        copyImage: (bytes) => {
          const image = nativeImage.createFromBuffer(bytes)
          if (image.isEmpty()) throw new Error('图片内容无效，无法复制')
          clipboard.writeImage(image)
        },
        selectSavePath: async (suggestedFileName) => {
          const result = await dialog.showSaveDialog({
            title: '图片另存为',
            defaultPath: suggestedFileName,
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'webp'] }],
          })
          return result.canceled ? null : result.filePath ?? null
        },
        revealInFolder: (filePath) => shell.showItemInFolder(filePath),
        showContextMenu: (items) => {
          const menu = Menu.buildFromTemplate(items.map((item) => ({
            id: item.id,
            label: item.label,
            click: () => {
              void item.run().catch((error) => {
                dialog.showErrorBox(
                  '图片操作失败',
                  error instanceof Error ? error.message : '无法完成图片操作',
                )
              })
            },
          })))
          menu.popup()
        },
      },
    })
    // Keep the image output location visible from the moment the app starts.
    // The write path is checked again by AiAssetStore for every asset.
    try {
      assetStore.ensureOutputDirectory()
    } catch (error) {
      runtimeLog.log('warn', 'ai-chat', 'asset.output-directory.unavailable', 'AI 图片 output 目录初始化失败', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    const videoAssets = new AiVideoAssetStore({
      outputRoot: aiOutputRoot,
      nativeOperations: {
        selectSavePath: async (suggestedFileName) => {
          const result = await dialog.showSaveDialog({
            title: '视频另存为', defaultPath: suggestedFileName,
            filters: [{ name: '视频', extensions: ['mp4'] }],
          })
          return result.canceled ? null : result.filePath ?? null
        },
        revealInFolder: (filePath) => shell.showItemInFolder(filePath),
        showContextMenu: (items) => {
          Menu.buildFromTemplate(items.map((item) => ({
            id: item.id, label: item.label,
            click: () => { void item.run().catch((error) => dialog.showErrorBox('视频操作失败', error instanceof Error ? error.message : '无法完成视频操作')) },
          }))).popup()
        },
      },
    })
    const audioAssets = new AiAudioAssetStore({
      outputRoot: aiOutputRoot,
      nativeOperations: {
        selectSavePath: async (suggestedFileName) => {
          const result = await dialog.showSaveDialog({ title: '音频另存为', defaultPath: suggestedFileName, filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] })
          return result.canceled ? null : result.filePath ?? null
        },
        revealInFolder: (filePath) => shell.showItemInFolder(filePath),
        showContextMenu: (items) => {
          Menu.buildFromTemplate(items.map((item) => ({ id: item.id, label: item.label, click: () => { void item.run().catch((error) => dialog.showErrorBox('音频操作失败', error instanceof Error ? error.message : '无法完成音频操作')) } }))).popup()
        },
      },
    })
    const assetMetadata = new AiAssetMetadataStore({ outputRoot: aiOutputRoot })
    // Permanent deletion hands the file to the OS recycle bin rather than
    // unlinking it. The bytes are the user's artwork; the last recoverable copy
    // should not depend on this program being right.
    const trashItem = (filePath: string) => shell.trashItem(filePath)
    const mediaAssets = createAiMediaAssetService({ images: assetStore, videos: videoAssets, audios: audioAssets, metadata: assetMetadata, trashItem })
    const canvasProjects = new CanvasProjectStore(path.join(managerDataDirectory, 'canvas-projects'))
    const createProjectAssetContext = (outputRoot: string) => {
      const images = new AiAssetStore({
        outputRoot,
        trustedProxyFetchImpl: (input, init) => net.fetch(input, init),
        nativeOperations: {
          copyImage: (bytes) => {
            const image = nativeImage.createFromBuffer(bytes)
            if (image.isEmpty()) throw new Error('图片内容无效，无法复制')
            clipboard.writeImage(image)
          },
          selectSavePath: async (suggestedFileName) => {
            const result = await dialog.showSaveDialog({
              title: '图片另存为', defaultPath: suggestedFileName,
              filters: [{ name: '图片', extensions: ['png', 'jpg', 'webp'] }],
            })
            return result.canceled ? null : result.filePath ?? null
          },
          revealInFolder: (filePath) => shell.showItemInFolder(filePath),
          showContextMenu: (items) => {
            Menu.buildFromTemplate(items.map((item) => ({
              id: item.id, label: item.label,
              click: () => { void item.run().catch((error) => dialog.showErrorBox('图片操作失败', error instanceof Error ? error.message : '无法完成图片操作')) },
            }))).popup()
          },
        },
      })
      const videos = new AiVideoAssetStore({
        outputRoot,
        nativeOperations: {
          selectSavePath: async (suggestedFileName) => {
            const result = await dialog.showSaveDialog({ title: '视频另存为', defaultPath: suggestedFileName, filters: [{ name: '视频', extensions: ['mp4'] }] })
            return result.canceled ? null : result.filePath ?? null
          },
          revealInFolder: (filePath) => shell.showItemInFolder(filePath),
          showContextMenu: (items) => {
            Menu.buildFromTemplate(items.map((item) => ({ id: item.id, label: item.label, click: () => { void item.run().catch((error) => dialog.showErrorBox('视频操作失败', error instanceof Error ? error.message : '无法完成视频操作')) } }))).popup()
          },
        },
      })
      const audios = new AiAudioAssetStore({
        outputRoot,
        nativeOperations: {
          selectSavePath: async (suggestedFileName) => {
            const result = await dialog.showSaveDialog({ title: '音频另存为', defaultPath: suggestedFileName, filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] })
            return result.canceled ? null : result.filePath ?? null
          },
          revealInFolder: (filePath) => shell.showItemInFolder(filePath),
          showContextMenu: (items) => {
            Menu.buildFromTemplate(items.map((item) => ({ id: item.id, label: item.label, click: () => { void item.run().catch((error) => dialog.showErrorBox('音频操作失败', error instanceof Error ? error.message : '无法完成音频操作')) } }))).popup()
          },
        },
      })
      return createCanvasProjectAssetContext(images, videos, audios, new AiAssetMetadataStore({ outputRoot }), trashItem)
    }
    const canvasProjectAssets = new CanvasProjectAssetManager({
      projects: canvasProjects,
      global: createCanvasProjectAssetContext(assetStore, videoAssets, audioAssets, assetMetadata, trashItem),
      create: createProjectAssetContext,
      onMetadataError: (error, context) => runtimeLog.log(
        'warn',
        'canvas',
        'asset.source.persist.failed',
        '生成素材已保存，但来源信息保存失败',
        { ...context, reason: error instanceof Error ? error.message : String(error) },
      ),
    })
    const assetThumbnails = createAssetThumbnailService({
      store: new AssetThumbnailStore({ cacheRoot: path.join(managerDataDirectory, 'asset-thumbnails') }),
      renderer: createNativeThumbnailRenderer(),
      sources: {
        // Must resolve through the project asset manager, not the global store.
        // Canvas projects keep their media under the project workspace, so
        // deriving from `output/` alone left every project asset without a
        // thumbnail and the tray showed a placeholder for all of them.
        readImage: async (userId, assetId) => {
          const owned = await canvasProjectAssets.readOwned(userId, assetId, 'image')
          return { bytes: owned.bytes, mimeType: owned.asset.mimeType }
        },
        resolveVideoPath: (userId, assetId) => canvasProjectAssets.resolveOwnedFilePath(userId, assetId, 'video'),
      },
      onFailure: (assetId, reason) => runtimeLog.log(
        'warn',
        'canvas',
        'asset.thumbnail.failed',
        '素材缩略图生成失败，已回退到占位图',
        { assetId, reason },
      ),
    })
    registerAiAssetProtocol(canvasProjectAssets, accountService, assetThumbnails)
    const chatService = createAiChatService({
      credentialCoordinator: chatCredentials,
      emit: (senderId, event) => {
        const sender = BrowserWindow.getAllWindows()
          .map((window) => window.webContents)
          .find((contents) => contents.id === senderId && !contents.isDestroyed())
        if (!sender) throw new Error('AI聊天窗口已关闭')
        if (event.type === 'delta') {
          if (event.content) sender.send(ipcEventChannels.onAiChatStream, {
            requestId: event.requestId,
            type: 'content',
            content: event.content,
          })
          if (event.reasoning) sender.send(ipcEventChannels.onAiChatStream, {
            requestId: event.requestId,
            type: 'reasoning',
            content: event.reasoning,
          })
          return
        }
        if (event.type === 'error') sender.send(ipcEventChannels.onAiChatStream, {
          requestId: event.requestId,
          type: 'error',
          message: event.message,
        })
        else sender.send(ipcEventChannels.onAiChatStream, {
          requestId: event.requestId,
          type: event.type,
        })
      },
      log: (entry) => runtimeLog.log(
        entry.status === 'error' ? 'warn' : 'debug',
        'chat',
        `stream.${entry.status}`,
        `AI聊天流已${entry.status === 'complete' ? '完成' : '结束'}`,
        entry,
      ),
    })
    const imageService = createAiImageService({
      baseUrl: 'https://xm.solov.cc',
      credentials: chatCredentials,
      assets: assetStore,
    })
    const canvasImageService = createAiImageService({
      baseUrl: 'https://xm.solov.cc',
      credentials: chatCredentials,
      assets: {
        prepareProject: (userId, projectId) => canvasProjectAssets.prepareProject(userId, projectId),
        storeBase64: (userId, value, metadata) => canvasProjectAssets.storeBase64(userId, value, metadata),
        storeRemoteUrl: (userId, url, metadata) => canvasProjectAssets.storeRemoteUrl(userId, url, metadata),
        readOwned: (userId, assetId, projectId) => canvasProjectAssets.readImageOwned(userId, assetId, projectId),
      },
    })
    const videoTasks = new AiVideoTaskStore({
      rootDirectory: path.join(managerDataDirectory, 'canvas-video-tasks'),
    })
    const videoService = createAiVideoService({
      baseUrl: 'https://xm.solov.cc',
      credentials: chatCredentials,
      tasks: videoTasks,
      assets: {
        prepareProject: (userId, projectId) => canvasProjectAssets.prepareProject(userId, projectId),
        storeMp4: (userId, bytes, metadata) => canvasProjectAssets.storeMp4(userId, bytes, metadata),
        readImageDataUri: (userId, assetId, projectId) => canvasProjectAssets.readImageDataUri(userId, assetId, projectId),
        readOwned: (userId, assetId, kind, projectId) => canvasProjectAssets.readMediaOwned(userId, assetId, kind, projectId),
      },
    })
    const canvasRunStore = new CanvasRunStore({
      rootDirectory: path.join(managerDataDirectory, 'canvas-runtime'),
      assets: canvasProjectAssets,
    })
    const canvasPromptPresets = new CanvasPromptPresetStore({
      rootDirectory: path.join(managerDataDirectory, 'canvas-content'),
    })
    const canvasRuns = createCanvasRunService({
      store: canvasRunStore,
      executors: createCanvasNodeExecutors({
        imageService: canvasImageService,
        videoService,
        assets: canvasProjectAssets,
        completeText: {
          completeOnce: (input) => chatService.completeOnce({
            group: input.group,
            model: input.model,
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.user },
            ],
            signal: input.signal,
          }),
        },
      }),
    })
    canvasAccountLifecycle.bind({ imageService: canvasImageService, videoService, canvasRuns })
    const canvasController = createCanvasWindowController({
      canvasDistRoot: canvasDistRoot(),
      externalUrlAllowlist: canvasExternalUrlAllowlist,
      systemService,
      accountService,
      previewOnboarding,
      runtimeLog,
      chatCredentials,
      imageService: canvasImageService,
      videoService,
      aiAssets: assetStore,
      videoAssets,
      audioAssets,
      mediaAssets,
      promptPresets: canvasPromptPresets,
      canvasRuns,
      projects: canvasProjects,
      projectAssets: canvasProjectAssets,
    })
    const paymentWindow = createPaymentWindowController({
      onBlockedNavigation: (targetUrl) => {
        let origin = 'invalid-url'
        try {
          origin = new URL(targetUrl).origin
        } catch {
          // Keep malformed URLs out of logs; the policy has already blocked it.
        }
        runtimeLog.log('warn', 'payment', 'navigation.blocked', '已阻止支付窗口跳转到未授权地址', { origin })
      },
      onTerminalState: (event) => {
        runtimeLog.log('info', 'payment', 'window.terminal', '支付窗口已进入终态并自动关闭', {
          status: event.status,
          hasTradeNo: Boolean(event.tradeNo),
        })
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(ipcEventChannels.onAccountPaymentWindowTerminal, event)
          }
        }
      },
    })

    // Empty update = read the effective record (file, .bak, or defaults) and
    // persist it durably -- same normalize-on-startup write as before the
    // field-wise-merge change, routed through the same serialized queue.
    await systemService.updateStoredConfig({ version: 2 })
    const bundledXingmangAiSkillRoot = resolveXingmangAiBundledSkillRoot(app.getAppPath(), {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    void installXingmangAiSkillFiles(bundledXingmangAiSkillRoot, os.homedir(), {
      officialCodex: (systemService.readStoredConfig().officialProviders ?? []).includes('codex'),
    }).then((result) => {
      for (const warning of result.warnings) {
        runtimeLog.log('warn', 'account', 'xingmang-ai-skill.install', warning)
      }
    }).catch((error) => {
      runtimeLog.log(
        'warn',
        'account',
        'xingmang-ai-skill.install',
        error instanceof Error ? error.message : '星芒AI Skill 默认安装失败',
      )
    })
    const unregisterIpcHandlers = registerIpcHandlers({
      savedAccounts,
      systemService,
      accountService,
      paymentWindow,
      accountSessionReady,
      accountCredentials: accountCredentialStore,
      managedCliKeys: managedCliKeyStore,
      chatKeyStore,
      chatCredentials,
      chatService,
      imageService,
      aiAssets: assetStore,
      sessionsService,
      providerSessionsService,
      backupStore,
      diagnosticsService,
      runtimeLog,
      extensionService,
      providerExtensionService,
      urlPolicy,
      previewOnboarding,
      externalUrlAllowlist,
      updaterService,
      broadcastUpdate: (snapshot) => {
        runtimeLog.log(snapshot.error ? 'error' : 'info', 'updater', 'state.changed', `主程序更新状态：${snapshot.phase}`, {
          phase: snapshot.phase,
          currentVersion: snapshot.currentVersion,
          availableVersion: snapshot.availableVersion,
          error: snapshot.error,
        })
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('update:state-changed', snapshot)
        }
        applicationTray?.updateSnapshot()
      },
      getWindowCapabilities: () => ({ tray: applicationTray?.available ?? false, notifications: desktopNotifications.getCapability().supported }),
      onSettingsChanged: () => { desktopNotifications.refresh() },
      takeExternalDeepLink: (sender) => managedMainWindow?.webContents === sender ? deepLinkInbox.take() : null,
      replyWindowClose: (sender, requestId, report) => (
        managedMainWindow?.webContents === sender ? closeQuery?.reply(requestId, report) ?? false : false
      ),
      onSystemSnapshot: (snapshot) => { latestTraySystem = snapshot; applicationTray?.updateSnapshot() },
      onAccountBalance: (balance) => { latestTrayBalance = balance; applicationTray?.updateSnapshot() },
      setWindowMode,
      setWindowTheme: (contents, theme) => {
        setWindowTheme(contents, theme)
        const appearance = systemService.readStoredConfig()
        canvasController.setAppearance({ theme, uiSkin: appearance.uiSkin, reducedMotion: appearance.reducedMotion })
      },
      openCanvasWindow: () => canvasController.open(),
      xingmangAiSkill: {
        bundledRoot: bundledXingmangAiSkillRoot,
        userHome: os.homedir(),
      },
      ...(manualUninstallVisualFixtureEnabled
        ? {
            transformSystemSnapshot: (snapshot: SystemSnapshot) => (
              withManualUninstallVisualFixture(snapshot, codexContext.userHome)
            ),
          }
        : {}),
    })
    app.once('will-quit', () => {
      runtimeLog.log('info', 'main', 'app.stopping', '应用主进程即将退出')
      process.off('uncaughtExceptionMonitor', onUncaughtException)
      process.off('unhandledRejection', onUnhandledRejection)
      if (periodicUpdateTimer) clearInterval(periodicUpdateTimer)
      unsubscribeDesktopNotifications()
      desktopNotifications.dispose()
      unregisterIpcHandlers()
      chatService.dispose()
      imageService.cancelAll()
      canvasImageService.cancelAll()
      videoService.cancelAll()
      canvasRuns.shutdown()
      protocol.unhandle('xingmang-asset')
      paymentWindow.destroy()
      canvasController.dispose()
      updaterService.dispose()
    })
    const mainWindow = createWindow(systemService, urlPolicy, runtimeLog)
    managedMainWindow = mainWindow
    closeQuery = createWindowCloseQuery((requestId) => mainWindow.webContents.send(ipcEventChannels.onWindowCloseRequest, { requestId }))
    const showMainWindow = () => {
      if (mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    receiveDeepLink = (raw) => {
      if (!deepLinkInbox.accept(raw)) return
      showMainWindow()
      mainWindow.webContents.send(ipcEventChannels.onExternalDeepLink, undefined)
    }
    const lifecycle = createWindowLifecycle({
      readPreference: () => systemService.readStoredConfig().closeBehavior ?? 'ask',
      trayAvailable: () => applicationTray?.available ?? false,
      requestCloseDecision: async () => {
        const trayReady = applicationTray?.available ?? false
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: '关闭星芒AI管理工具', message: '关闭窗口后如何处理？',
          detail: trayReady ? '缩到托盘会保留正在执行的任务。' : '系统托盘不可用，返回可继续使用当前窗口。',
          buttons: trayReady ? ['缩到托盘', '退出程序', '返回'] : ['退出程序', '返回'],
          defaultId: trayReady ? 0 : 1, cancelId: trayReady ? 2 : 1,
        })
        return trayReady ? result.response === 0 ? 'hide' : result.response === 1 ? 'quit' : 'cancel' : result.response === 0 ? 'quit' : 'cancel'
      },
      prepareToQuit: async () => {
        const report = await closeQuery!.request()
        if (report.blockingTask) {
          await dialog.showMessageBox(mainWindow, { type: 'info', title: '任务尚未完成', message: '请等待安装或保存任务完成后退出', buttons: ['继续使用'] })
          return false
        }
        if (report.unsavedChanges || chatService.activeCount() > 0) {
          const result = await dialog.showMessageBox(mainWindow, {
            type: 'warning', title: '退出前确认', message: '退出将关闭当前编辑面板并停止等待中的请求',
            detail: '未保存的输入可能丢失。已提交的付费请求可能仍在服务端继续处理。',
            buttons: ['返回', '退出'], defaultId: 0, cancelId: 0,
          })
          if (result.response !== 1) return false
        }
        return canvasController.requestClose()
      },
      flushWindowState: () => windowPreferenceFlushers.get(mainWindow.webContents)?.() ?? Promise.resolve(),
      show: showMainWindow,
      hide: () => mainWindow.hide(),
      quit: () => app.quit(),
      onError: (cause) => {
        runtimeLog.exception('window', 'close.failed', cause)
        void dialog.showMessageBox(mainWindow, { type: 'error', title: '暂时无法退出', message: '退出检查或保存未完成，窗口已保留。请稍后重试。' })
      },
    })
    lifecycle.attach(mainWindow, app)
    const trayAssets = path.join(app.getAppPath(), 'assets', 'brand', 'v3')
    applicationTray = createApplicationTray({
      iconPath: path.join(trayAssets, 'tray-16.png'), icon2xPath: path.join(trayAssets, 'tray-32.png'),
      templateIconPath: path.join(trayAssets, 'trayTemplate-16.png'), templateIcon2xPath: path.join(trayAssets, 'trayTemplate-32.png'),
      getSnapshot: () => {
        const state = accountService.getSessionState()
        return {
          accountLabel: state.account?.username ?? null,
          balanceUsd: latestTrayBalance && latestTrayBalance.quotaPerUnit > 0 ? latestTrayBalance.quota / latestTrayBalance.quotaPerUnit : null,
          installedTools: [
            ...(latestTraySystem?.desktopApps.codex.installed ? [{ id: 'codexDesktop', label: 'Codex 桌面端' }] : []),
            ...providerIds.filter((id) => latestTraySystem?.clis[id].installed).map((id) => ({ id, label: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex CLI' : id === 'gemini' ? 'Gemini CLI' : 'Grok CLI' })),
          ],
          updateAvailable: updaterService.getState().phase === 'available',
          updateVersion: updaterService.getState().availableVersion,
        }
      },
      onOpen: showMainWindow,
      onNavigate: (target) => mainWindow.webContents.send(ipcEventChannels.onNavigate, target),
      onLaunchTool: (id) => { showMainWindow(); mainWindow.webContents.send(ipcEventChannels.onLaunchTool, id) },
      onQuit: () => lifecycle.requestQuit(),
      onError: (cause) => runtimeLog.exception('window', 'tray.failed', cause),
    })
    app.once('will-quit', () => { lifecycle.dispose(); closeQuery?.dispose(); applicationTray?.dispose() })
    // The canvas window is a secondary, opt-in surface -- it must not
    // outlive the main window (which would otherwise leave the app running
    // in the background with no way back to the dashboard on Windows/Linux,
    // since window-all-closed only quits when every window is gone).
    mainWindow.on('closed', () => {
      paymentWindow.destroy()
      canvasController.closeIfOpen()
    })
    if (focusWhenWindowIsReady) {
      mainWindow.once('ready-to-show', () => {
        focusWhenWindowIsReady = false
        focusExistingWindow()
      })
    }
    if (updaterService.getState().phase !== 'disabled') {
      const checkForUpdates = () => {
        // 已下载阶段（含安装失败后的恢复态）不允许定时检查覆盖，否则错误横幅和「重启并安装」入口会消失
        if (updaterService.getState().phase === 'downloaded') return
        void updaterService.check().catch((error) => {
          runtimeLog.exception('updater', 'scheduled.check.failed', error)
        })
      }
      periodicUpdateTimer = setInterval(checkForUpdates, updateCheckIntervalMs)
      periodicUpdateTimer.unref()
    }
    app.on('activate', () => {
      showMainWindow()
    })
  }).catch((error) => {
    const message = startupFailureMessage(error, process.platform)
    console.error('Application startup failed:', error)
    // console output is unreachable in a packaged build and devtools are
    // disabled there, so this file is the only evidence a support case gets.
    const logPath = recordFatalStartupFailure('whenReady', error)
    dialog.showErrorBox(
      '星芒AI管理工具启动失败',
      logPath ? `${message}\n\n诊断日志已保存到：\n${logPath}` : message,
    )
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
