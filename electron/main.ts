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
import { AnnouncementReadStore } from './announcement-read-store'
import { createAccelerationService } from './acceleration-service'
import { accelerationConflictDescriptions } from './acceleration-contract'
import { accelerationStartFailureDescriptions, createAccelerationDevelopmentHost, readAccelerationDevelopmentConfig, type AccelerationDevelopmentHost } from './acceleration-development-host'
import { readBundledAccelerationConfig } from './acceleration-bundled-config'
import { AiAssetStore, resolveAiOutputRoot } from './ai-asset-store'
import { AI_CHAT_STREAM_LIMITS, createAiChatService } from './ai-chat-service'
import { createAiImageService } from './ai-image-service'
import { AiVideoAssetStore } from './ai-video-asset-store'
import { AiAudioAssetStore } from './ai-audio-asset-store'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'
import { AiVideoTaskStore } from './ai-video-task-store'
import { createAiVideoService } from './ai-video-service'
import { createAiMediaAssetService } from './ai-media-asset-service'
import { assetThumbnailMaxEdge, assetThumbnailSize } from './asset-thumbnail'
import { AssetThumbnailStore } from './asset-thumbnail-store'
import { createAssetThumbnailService, type AssetThumbnailRenderer } from './asset-thumbnail-service'
import { createChatCredentialCoordinator } from './chat-credential-coordinator'
import { ChatKeyStore } from './chat-key-store'
import { ManagedCliKeyStore } from './managed-cli-key-store'
import { AccountSessionStore } from './account-session-store'
import { SavedAccountsStore } from './saved-accounts'
import { AppSettingsStore, readAppSettings, type AppTheme } from './app-settings'
import { calculateUiZoom, resolveWindowPlacement } from './window-preferences'
import { createWindowLifecycle } from './window-lifecycle'
import { createWindowResponsivenessGuard } from './window-responsiveness'
import { createApplicationTray, type ApplicationTrayController } from './application-tray'
import { createExternalDeepLinkInbox } from './external-deep-links'
import { createDesktopNotificationController } from './desktop-notifications'
import { ConfigBackupStore } from './backups'
import { crashReportDsn, crashReportSelfTestEnvironmentKey, shouldReportCrashes } from './crash-report'
import { createCrashReporter } from './crash-reporter'
import { providerIds, type ProviderId } from './catalog'
import { gitWindowsDownloadUrl } from './git-runtime'
import { canvasProtocolScheme, canvasSecurityResponseHeaders } from './canvas-protocol'
import { createCanvasWindowController } from './canvas-window'
import { CanvasRunStore } from './canvas-run-store'
import { createCanvasNodeExecutors } from './canvas-node-executors'
import { createCanvasRunService } from './canvas-run-service'
import { CanvasPromptPresetStore } from './canvas-prompt-preset-store'
import { CanvasProjectStore } from './canvas-project-store'
import { CanvasProjectAssetManager, createCanvasProjectAssetContext } from './canvas-project-asset-manager'
import { createAiAssetProtocolHandler } from './ai-asset-protocol'
import { resolveCodexHomeContext } from './codex-home'
import { runCodexContextLimitsMigration } from './codex-config-migration'
import { runWithTrustedWindowsProcessEnvironment } from './command-runner'
import { CodexExtensionService } from './codex-extensions'
import { CodexSessionsService } from './codex-sessions'
import { createNewApiClient } from './new-api-client'
import { createRealmAccountService, type RealmAccountClientHandle, type RealmAccountSiteId } from './realm-account-service'
import { createFileRealmAccountVault } from './realm-account-vault-file'
import { createVaultRecoveryNotifier } from './vault-recovery-notice'
import { inspectSafeStorageBackend } from './safe-storage-backend'
import { parseRealmSavedAccount, type RealmSavedAccount } from './realm-account'
import { createSub2ApiRelayBackend } from './sub2api-relay-backend'
import { requireSiteRuntimeDefinition } from './site-runtime'
import { createActiveIdentityReader } from './active-identity'
import { resolveRealmDataRoots } from './realm-data-roots'
import { createRealmServiceDispatch } from './realm-service-dispatch'
import { createAccountWorkGate } from './account-work-gate'
import { createAccountUsageTracker } from './account-usage-tracker'
import type { RelayBackendClient } from './relay-backend'
import { ProviderExtensionService } from './provider-extensions'
import { ProviderSessionsService } from './provider-sessions'
import { guardProcessOutputStreams } from './process-stream-errors'
import { RuntimeLogStore } from './runtime-log'
import { attachPlatformAuditLog } from './platform/runtime-log-bridge'
import { recordStartupFailure } from './startup-log'
import { inspectProviderConfig } from './config-files'
import { buildFeedbackEnvironmentLines } from './feedback-environment'
import { rootedMainServiceOptions } from './main-service-options'
import { buildMacosInstallLocationNotice, inspectMacosInstallLocation } from './macos-install-location'
import { privacyPolicyUrl, relaySiteExternalUrls, relaySites, resolveRelaySite, sub2ApiSupportServiceUrl, supportServiceUrl, userAgreementUrl } from './relay-sites'
import { createPaymentWindowController } from './payment-window'
import { createPaymentOrderStatusReader } from './payment-status-reader'
import {
  createDiagnosticsExport,
  runDiagnostics,
  type DiagnosticsReport,
} from './diagnostics'
import { runConnectionCheck } from './connection-check'
import { registerIpcHandlers, type AppWindowMode } from './ipc'
import {
  installXingmangAiSkillFiles,
  resolveXingmangAiBundledSkillRoot,
} from './xingmang-ai-skill'
import { resolveProjectInstructionsTemplatePath } from './project-instructions'
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
  parseChromiumProxyResult,
  subprocessDownloadProxyEnvironment,
  type DownloadProxyEndpoint,
} from './download-proxy'
import { createDownloadAccelerationCoordinator } from './download-acceleration'
import {
  createSystemService,
  type SystemService,
  type SystemSnapshot,
} from './system-service'
import { verifyUpdatePackageDigest } from './update-package-digest'
import { installStrictUpdateCodeSignatureVerifier } from './update-signature'
import { createUpdaterService } from './updater'
import { resolveWindowsCliExecutionMode } from './windows-elevation'
import {
  applyWindowTheme,
  buildMacApplicationMenuTemplate,
  platformWindowOptions,
  startupFailureMessage,
} from './window-presentation'
import { installMainWindowFrameNavigationGuard } from './platform/frame-navigation'

guardProcessOutputStreams()

const applicationPackage = require('../package.json') as {
  xingmangAccelerationBundle?: unknown
  xingmangLocalBuild?: unknown
  xingmangUnsignedRelease?: unknown
}

const nonSiteExternalUrlAllowlist = [
  'https://nodejs.org/',
  'https://www.python.org/downloads/',
  // 首页运行环境行的「下载 Git」按钮只在 Windows 出现，落点就是这一条（I12 全等匹配）。
  gitWindowsDownloadUrl,
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
  sub2ApiSupportServiceUrl,
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
  installMainWindowFrameNavigationGuard(window.webContents)
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppNavigationUrl(targetUrl, urlPolicy)) event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    runtimeLog.log('error', 'renderer', 'process.gone', '渲染进程异常退出', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
    // A dead renderer leaves no JavaScript behind to report itself, so the
    // main process is the only place this can be observed at all. An orderly
    // teardown reaches here too on some shutdown paths and is not a crash.
    if (details.reason === 'clean-exit') return
    crashReporter.report({
      mechanism: 'render-process-gone',
      source: 'renderer',
      level: 'fatal',
      error: new Error(`渲染进程异常退出：${details.reason}`),
      context: `exitCode=${details.exitCode}`,
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
  const responsiveness = createWindowResponsivenessGuard({
    prompt: async (signal) => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: '界面没有响应', message: '星芒AI管理工具的界面暂时没有响应。',
        detail: '可以再等一会儿，界面通常会自己恢复。重新加载只会重启界面，正在进行的安装、下载和已保存的设置都不受影响，但界面上还没保存的输入会丢失。',
        buttons: ['继续等待', '重新加载'], defaultId: 0, cancelId: 0, signal,
      })
      return result.response === 1 ? 'reload' : 'wait'
    },
    reload: () => window.webContents.reload(),
    log: (event) => {
      if (event === 'prompt.shown') { runtimeLog.log('warn', 'renderer', 'window.unresponsive.prompted', '已提示用户界面无响应'); return }
      if (event === 'prompt.reload') { runtimeLog.log('warn', 'renderer', 'window.unresponsive.reload', '用户选择重新加载界面'); return }
      if (event === 'prompt.wait') { runtimeLog.log('info', 'renderer', 'window.unresponsive.wait', '用户选择继续等待'); return }
      runtimeLog.log('info', 'renderer', 'window.unresponsive.dismissed', '界面已恢复，提示自动关闭')
    },
    onError: (cause) => { runtimeLog.exception('renderer', 'window.unresponsive.failed', cause) },
  })
  window.on('unresponsive', () => {
    runtimeLog.log('warn', 'renderer', 'window.unresponsive', '应用窗口暂时无响应')
    responsiveness.handleUnresponsive()
  })
  window.on('responsive', () => { responsiveness.handleResponsive() })
  window.once('closed', () => { responsiveness.dispose() })

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

// Set once the runtime log exists. A send failure before that (offline at
// launch) is simply dropped: the reporter must never become a second source
// of startup errors.
let reportCrashSendFailure: ((error: unknown) => void) | null = null

/** `app` metadata is a nicety here; never let reading it become the crash. */
function appValue<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * Composed at module scope, not inside whenReady: a crash during startup is
 * exactly the class of bug a user cannot report themselves, so the reporter
 * has to exist before the first line of startup work runs. Everything that
 * can leave the machine is built and redacted by crash-report.ts; this only
 * supplies the runtime facts and answers "is the switch on".
 */
const crashReporter = createCrashReporter({
  dsn: crashReportDsn,
  clientName: `xingmang-ai-manager/${appValue(() => app.getVersion(), '0.0.0')}`,
  runtime: {
    release: `xingmang-ai-manager@${appValue(() => app.getVersion(), '0.0.0')}`,
    environment: appValue(() => app.isPackaged, false) ? 'production' : 'development',
    homeDirectory: os.homedir(),
    appVersion: appValue(() => app.getVersion(), '0.0.0'),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    osPlatform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
  },
  isEnabled: () => shouldReportCrashes({
    packaged: appValue(() => app.isPackaged, false),
    // Re-read per report so switching the preference off stops the very next
    // send, with no refresh plumbing between the settings handler and here.
    // The fallback is the opt-out, not the default: if the preference cannot
    // be read at all, staying silent is the answer the user cannot object to.
    crashReporting: appValue(
      () => readAppSettings(path.join(app.getPath('userData'), 'settings.json')).crashReporting,
      false,
    ),
    env: process.env,
  }),
  // net.fetch follows the session's proxy settings, which is what a user
  // behind a corporate proxy needs -- but it only exists once the app is
  // ready, and a startup crash happens before that.
  fetchImpl: (url, init) => (app.isReady() ? net.fetch(url, init) : fetch(url, init)),
  onSendFailure: (error) => { reportCrashSendFailure?.(error) },
})

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
  // Reported from the one listener that is registered for the whole process
  // lifetime, so a crash before whenReady is covered by the same call as one
  // after it -- and neither is reported twice.
  crashReporter.report({ mechanism: 'uncaughtException', source: 'main', error, level: 'fatal' })
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
      // BrowserWindow.icon does not control the Dock, especially under electron . in development.
      app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'brand', 'v3', 'app-icon.png'))
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
    // desktop-entry registers the platform handlers before this store exists,
    // so their audit entries buffer in the bridge until it is handed over.
    attachPlatformAuditLog((level, source, event, message, detail) => {
      runtimeLog.log(level, source, event, message, detail)
    })
    runtimeLog.log('info', 'main', 'app.started', '应用主进程已启动', {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    })
    if (manualUninstallVisualFixtureEnabled) {
      runtimeLog.log('warn', 'testing', 'manual-uninstall.fixture', '手动卸载视觉测试状态已启用')
    }
    // 装在「应用程序」之外时加速起不来，但用户只看到「加速连接失败」，会以为
    // 是服务的问题。这一步放在服务与窗口之前：那之后再提示，用户已经开始用了。
    const installLocation = inspectMacosInstallLocation({
      platform: process.platform,
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      executablePath: process.execPath,
    })
    if (installLocation) {
      const notice = buildMacosInstallLocationNotice(installLocation)
      runtimeLog.log('warn', 'main', 'app.install-location.unsupported', notice.message, {
        location: installLocation,
        appPath: app.getAppPath(),
      })
      const answer = dialog.showMessageBoxSync({
        type: 'warning',
        title: notice.title,
        message: notice.message,
        detail: notice.detail,
        buttons: [...notice.buttons],
        defaultId: notice.defaultId,
        cancelId: notice.cancelId,
      })
      if (answer === notice.cancelId) {
        runtimeLog.log('info', 'main', 'app.install-location.quit', '用户选择退出以移动程序位置')
        app.quit()
        return
      }
      runtimeLog.log('warn', 'main', 'app.install-location.continued', '用户选择从当前位置继续运行')
    }
    const onUncaughtException = (error: Error) => {
      runtimeLog.exception('main', 'uncaught.exception', error)
    }
    const onUnhandledRejection = (reason: unknown) => {
      runtimeLog.exception('main', 'unhandled.rejection', reason)
      crashReporter.report({ mechanism: 'unhandledRejection', source: 'main', error: reason })
    }
    reportCrashSendFailure = (error) => {
      runtimeLog.exception('telemetry', 'crash-report.send.failed', error)
    }
    if (process.env[crashReportSelfTestEnvironmentKey] === '1') {
      runtimeLog.log('warn', 'telemetry', 'crash-report.self-test', '崩溃上报自检已触发')
      crashReporter.report({
        mechanism: 'self-test',
        source: 'main',
        error: new Error('崩溃上报自检'),
        context: '由 XINGMANG_CRASH_REPORT_TEST=1 触发',
      })
    }
    process.on('uncaughtExceptionMonitor', onUncaughtException)
    process.on('unhandledRejection', onUnhandledRejection)

    // Overlap the migration's asynchronous marker write with the Windows probe.
    // Both operations still complete before services and the window are created.
    const migrationPromise = runCodexContextLimitsMigration(managerDataDirectory, rootedOptions.system.providerRoots)
    const windowsCliExecutionModePromise = resolveWindowsCliExecutionMode({
      isPackaged: app.isPackaged,
    })
    try {
      const migration = await migrationPromise
      if (!migration.skipped) {
        runtimeLog.log('info', 'config', 'codex.context-limits.migrated', 'Codex 上下文限制一次性检查已完成', {
          changedFiles: migration.files.length,
          backups: migration.backups.length,
        })
      }
    } catch (error) {
      // A damaged or locked config must not prevent the toolbox from opening.
      runtimeLog.exception('config', 'codex.context-limits.migration.failed', error)
    }

    const settingsStore = new AppSettingsStore(path.join(managerDataDirectory, 'settings.json'))
    const relayFetch: typeof fetch = (input, init) => net.fetch(
      input instanceof URL ? input.href : input,
      init,
    )
    // Resolved before the service is built because it also decides whether an
    // unmanaged npm uninstall can run in-app.
    const windowsCliExecutionMode = await windowsCliExecutionModePromise
    runtimeLog.log('info', 'security', 'cli.execution-mode', 'CLI 扩展执行边界已确定', {
      mode: windowsCliExecutionMode,
    })
    let readAccountSiteId: () => string = () => 'solov'
    let readExternalClientAccountId: () => string | null = () => null
    // 下载专用的网络分区：它的代理只在装 CLI / 下 Node 的那几分钟里被设成加速
    // 内核的回环端口，默认 session 一行不动，所以账号、中转与画布流量不受
    // 影响。非 persist: 前缀 = 内存分区，不落盘。
    const acceleratedDownloadSession = session.fromPartition('xingmang-download-acceleration')
    let acceleratedDownloadProxyRules: string | null = null
    async function applyAcceleratedDownloadProxy(endpoint: DownloadProxyEndpoint | null): Promise<void> {
      const rules = endpoint ? `http=${endpoint.host}:${endpoint.port};https=${endpoint.host}:${endpoint.port}` : null
      if (rules === acceleratedDownloadProxyRules) return
      await acceleratedDownloadSession.setProxy(rules
        ? { proxyRules: rules, proxyBypassRules: '<local>' }
        : { mode: 'direct' })
      acceleratedDownloadProxyRules = rules
    }
    // 账号服务也建得比这里晚。下载线路与游戏加速用的是同一个账号口径，所以
    // 指向同一个读取函数，而不是各写一份。
    let readAccelerationAccountScope: () => string | null = () => null
    // 加速宿主要晚得多才建得起来（它依赖账号与随包资源）。在那之前这里是空的，
    // 任何一次下载都按没加速继续。
    let accelerationDownloadRoutes: Pick<AccelerationDevelopmentHost, 'startDownloadRoute' | 'stopDownloadRoute'> | null = null
    const downloadAcceleration = createDownloadAccelerationCoordinator({
      getAccountScope: () => readAccelerationAccountScope(),
      startRoute: (scope) => accelerationDownloadRoutes
        ? accelerationDownloadRoutes.startDownloadRoute(scope)
        : Promise.resolve({ status: 'unavailable' as const }),
      stopRoute: async (scope) => { await accelerationDownloadRoutes?.stopDownloadRoute(scope) },
      onRouteChanged: applyAcceleratedDownloadProxy,
      log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
    })
    const systemService = createSystemService(settingsStore, {
      managerDataDirectory,
      getRelaySiteId: () => readAccountSiteId(),
      getExternalClientAccountId: () => readExternalClientAccountId(),
      windowsExecutionMode: windowsCliExecutionMode,
      runtimeLog,
      projectInstructionsTemplatePath: resolveProjectInstructionsTemplatePath(app.getAppPath(), {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
      ...rootedOptions.system,
      relayFetch,
      networkLocationFetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
      // Re-read the existing session/system proxy selection without changing
      // the OS proxy or imposing a new Chromium proxy mode.
      reloadNetworkProxyConfig: () => session.defaultSession.forceReloadProxyConfig(),
      // CLI 产物下载以前走 Node 自带的网络栈，它不读系统代理，所以开着加速也
      // 一样直连。Chromium 的网络栈读，于是下载才真的走线路。
      // 临时线路生效时改走那条专用 session（它的代理只对下载有效，默认
      // session 一行未动，账号与中转流量不受影响）。
      downloadFetch: (input, init) => {
        const url = input instanceof URL ? input.href : input
        // 专用 session 的 fetch 只收字符串或 Request；下载链路一律传 URL 字符串。
        if (downloadAcceleration.currentEndpoint() && typeof url === 'string') {
          return acceleratedDownloadSession.fetch(url, init)
        }
        return net.fetch(url, init)
      },
      resolveSubprocessProxyEnvironment: async () => {
        // 临时线路本身就是回环端点，直接交给子进程；没有临时线路时仍然沿用
        // 系统代理那条老路（跨提权边界的过滤在 download-proxy.ts 里）。
        const endpoint = downloadAcceleration.currentEndpoint()
        if (endpoint) return subprocessDownloadProxyEnvironment(endpoint)
        return subprocessDownloadProxyEnvironment(
          // A PAC script can answer differently per host, so ask about the one
          // host every CLI install has to reach.
          parseChromiumProxyResult(await session.defaultSession.resolveProxy('https://registry.npmjs.org/')),
        )
      },
      acquireDownloadAcceleration: () => downloadAcceleration.acquire(),
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
      probeCacheFile: path.join(managerDataDirectory, 'sessions', 'probe-cache.json'),
      onProbeCacheWarning: (warning) => {
        runtimeLog.log('warn', 'sessions', warning.code, warning.message, warning.detail)
      },
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
      // 装插件和加官方市场都要出网（市场是一次 git clone），而 CLI 子进程不读
      // 系统代理，所以跟 CLI 安装一样把当前线路以环境变量带下去。
      resolveSubprocessProxyEnvironment: async () => subprocessDownloadProxyEnvironment(
        // PAC 脚本可以按主机给出不同答案，扩展这条链路真正要到的是 GitHub。
        parseChromiumProxyResult(await session.defaultSession.resolveProxy('https://github.com/')),
      ),
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
          // 报告只装中文结论（它会被导出发给客服），认出失败靠的那段上游原文
          // 留在 runtime.jsonl 里。
          log: (level, event, message, detail) => runtimeLog.log(level, 'diagnostics', event, message, detail),
          // Read fresh on every run rather than captured once at startup, so
          // a settings change is reflected on the very next diagnostics run.
          relaySite: resolveRelaySite(systemService.readStoredConfig().relaySiteId),
        })
        return latestDiagnostics
      },
      // 自检跟着用户当前所在的站点走，探测和对账读同一个 RelaySite ——
      // 与 system-service.ts 的 inspectNativeProviderConfig 同参，否则换过
      // 站点的用户会被告知一份好配置「指错了地方」。站点名只进日志不上屏。
      checkConnection: (provider: ProviderId) => {
        const site = resolveRelaySite(systemService.readStoredConfig().relaySiteId)
        return runConnectionCheck({
          provider,
          site,
          inspection: inspectProviderConfig(provider, rootedOptions.system.providerRoots, site.providerBaseUrls),
          fetch: relayFetch,
        })
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
    // Builds made with XINGMANG_UNSIGNED_RELEASE=1 carry no publisherName, so
    // electron-updater returns from verifySignature before the strict verifier
    // above is ever reached. The updater compensates by never downloading or
    // installing without the user and by re-checking the manifest digest itself.
    const unsignedChannel = app.isPackaged && applicationPackage.xingmangUnsignedRelease === true
    const updaterService = createUpdaterService(autoUpdater, {
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      localBuild,
      unsignedChannel,
      verifyPackageDigest: verifyUpdatePackageDigest,
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
      // Bypassing the proxy is a per-request escape hatch, so the updater
      // session goes back to the default resolution as soon as the request is
      // over. 'system' is the mode a freshly created session already has.
      restoreProxy: async () => {
        await autoUpdater.netSession.setProxy({ mode: 'system' })
      },
    })
    runtimeLog.log('info', 'updater', 'runtime.selected', '主程序更新运行模式已确定', {
      enabled: updaterService.getState().phase !== 'disabled',
      localBuild,
      unsignedChannel,
      signatureVerification: unsignedChannel ? 'none' : 'strict',
    })
    if (unsignedChannel) {
      runtimeLog.log(
        'warn',
        'updater',
        'channel.unsigned',
        '本机为未签名更新通道，安装包签名未校验；更新改为下载与安装均需用户确认，并在下载后强制校验安装包 SHA-512',
      )
    }
    let periodicUpdateTimer: NodeJS.Timeout | null = null
    let applicationTray: ApplicationTrayController | null = null
    let latestTraySystem: SystemSnapshot | null = null
    let latestTrayBalance: AccountBalance | null = null
    let managedMainWindow: BrowserWindow | null = null
    // 客服收到反馈报告的第一句总是「你的工具是什么版本、怎么装的、配置指向哪」。
    // 这几行就答这三件事：只读上一次扫描留下的快照（latestTraySystem），不为了
    // 生成一份报告再发一轮探测；配置按用户当前所在的站点对账（同上面的
    // checkConnection），否则换过站的用户会被告知一份好配置「没指向当前账号」。
    runtimeLog.attachEnvironmentDescriber(async () => {
      const site = resolveRelaySite(systemService.readStoredConfig().relaySiteId)
      return buildFeedbackEnvironmentLines({
        clis: latestTraySystem?.clis ?? null,
        readConfig: (provider) => inspectProviderConfig(
          provider,
          rootedOptions.system.providerRoots,
          site.providerBaseUrls,
        ),
      })
    })
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
      iconPath: path.join(app.getAppPath(), 'assets', 'brand', 'v3', 'app-icon.png'),
    })
    const unsubscribeDesktopNotifications = updaterService.subscribe((state) => desktopNotifications.handleUpdate(state))
    const urlPolicy = applicationUrlPolicy()
    registerApplicationProtocol(urlPolicy)
    const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'

    // Both realms commit accounts through the OS-backed encrypted vault.
    // Unavailable encryption rejects login without changing existing files.
    const safeStorageBackend = inspectSafeStorageBackend(safeStorage)
    if (safeStorageBackend !== 'ok') {
      runtimeLog.log(
        'warn',
        'account',
        'session.persist.unavailable',
        safeStorageBackend === 'plaintext'
          ? '当前系统没有可用的密钥环，安全存储只能以明文保存，已停止写入登录凭据；请启用系统凭据服务后重新登录，已有账号文件将保留'
          : '系统未提供安全加密存储，请恢复系统凭据服务后登录；已有账号文件将保留',
        { backend: safeStorageBackend },
      )
    }
    const accountSessionStore = new AccountSessionStore(path.join(managerDataDirectory, 'account-session.dat'), safeStorage)
    const savedAccounts = new SavedAccountsStore(path.join(managerDataDirectory, 'saved-accounts.dat'), safeStorage)
    const vault = createFileRealmAccountVault(managerDataDirectory, safeStorage, {
      // 重建之后用户看到的是「记住的账号没了」，只记日志等于让他自己猜，所以同时
      // 给界面发一条（一次启动只发一条，备份文件名不跟着走）。
      onRecovered: createVaultRecoveryNotifier({
        log: (backupFileName) => runtimeLog.log('warn', 'account', 'vault.recovered',
          '本地登录记录无法解密，已保留原密文备份并重建账号存储', { reason: 'decrypt', backupFileName }),
        emit: () => {
          if (!managedMainWindow || managedMainWindow.isDestroyed()) return
          if (managedMainWindow.webContents.isDestroyed()) return
          managedMainWindow.webContents.send(ipcEventChannels.onAccountVaultRecovered, undefined)
        },
      }),
    })
    let publishedAccountIdentity = ''
    let acceleration: ReturnType<typeof createAccelerationService> | undefined
    const accounts = createRealmAccountService({
      vault,
      createClient: (siteId, onSessionChange): RealmAccountClientHandle => {
        if (siteId === 'solov-api') return createSub2ApiRelayBackend({ fetchImpl: relayFetch, onSessionChange,
          onCredentialRotation: (saved) => vault.updateSession(saved) })
        let client: ReturnType<typeof createNewApiClient>
        function saved(): RealmSavedAccount | null {
          const persisted = client.getPersistableSession()
          const profile = client.getSessionState().account
          return persisted && profile ? parseRealmSavedAccount({ version: 2, realmId: 'xm-account',
            origin: 'https://xm.solov.cc', userId: String(persisted.userId), username: profile.username,
            credential: { kind: 'new-api', cookies: persisted.cookies } }) : null
        }
        client = createNewApiClient({ baseUrl: 'https://xm.solov.cc', fetchImpl: relayFetch,
          onCredentialRotation: async (persisted) => {
            const revision = client.getSessionRevision()
            const owner = { realmId: 'xm-account' as const, userId: String(persisted.userId) }
            const existing = await vault.get(owner)
            if (client.getSessionRevision() !== revision) throw new Error('账号会话已变更')
            if (existing) await vault.updateSession(parseRealmSavedAccount({ ...existing,
              credential: { kind: 'new-api', cookies: persisted.cookies } }))
          },
          onSessionChange: () => onSessionChange(saved()) })
        return { client, getSavedAccount: saved, restore: async (record) => {
          if (record.realmId !== 'xm-account' || record.credential.kind !== 'new-api') throw new Error('账号凭据与当前账号不匹配')
          return client.restoreSession({ userId: Number(record.userId), cookies: [...record.credential.cookies] })
        } }
      },
      legacy: { list: () => savedAccounts.list(), getSession: (id, origin) => savedAccounts.getSession(id, origin),
        readActive: () => accountSessionStore.read() },
      quiesce: async () => {
        await acceleration?.stopAll()
        const previous = businesses.get(accounts.getSiteId())
        previous?.chatService.cancelAll()
        previous?.imageService.cancelAll()
        previous?.canvasImageService.cancelAll()
        previous?.videoService.cancelAll()
        previous?.canvasRuns.shutdown()
        paymentWindow.destroy()
        await Promise.all([accountWork.whenIdle(), ...(previous ? [previous.chatService.whenIdle(),
          previous.imageService.whenIdle(), previous.canvasImageService.whenIdle(), previous.videoService.whenIdle(),
          previous.canvasRuns.whenIdle()] : [])])
      },
      onChanged: (siteId, state) => {
        void acceleration?.onAccountChanged().catch((error) => runtimeLog.exception('network', 'acceleration.account-change.failed', error))
        const identity = `${siteId}:${state.account?.userId ?? 'guest'}:${accounts.client.getSessionRevision!()}`
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(ipcEventChannels.onAccountSessionChanged, state)
        }
        if (publishedAccountIdentity === identity) return
        publishedAccountIdentity = identity
        for (const business of businesses.values()) {
          business.chatService.cancelAll()
          business.imageService.cancelAll()
          business.canvasImageService.cancelAll()
          business.videoService.cancelAll()
          business.canvasRuns.shutdown()
        }
        latestTrayBalance = null
        applicationTray?.updateSnapshot()
        canvasController.setAccountUser(null)
        canvasController.setAccountUser(state.account?.userId ?? null)
        if (state.authenticated && state.account) {
          const current = ensureBusiness(siteId)
          const userId = state.account.userId
          void accountWork.run(async () => {
            await current.canvasRuns.initializeUser(userId)
            await current.canvasRuns.reconcileAssets(userId)
          }).catch((error) => runtimeLog.exception('canvas', 'runtime.initialize.failed', error))
          if (siteId === 'solov') void current.videoService.resumeUser(userId).catch((error) => runtimeLog.exception('canvas', 'video.resume.failed', error))
        }
      },
    })
    readAccountSiteId = () => accounts.getSiteId()
    const accountService = accounts.client
    readExternalClientAccountId = () => {
      const state = accountService.getSessionState()
      return state.authenticated && state.account ? JSON.stringify([accounts.getSiteId(), state.account.userId]) : null
    }
    const accountWork = createAccountWorkGate({ assertReady: accounts.assertReady, revision: () => accountService.getSessionRevision!() })
    function createBusiness(siteId: RealmAccountSiteId) {
      const definition = requireSiteRuntimeDefinition(siteId)
      const roots = resolveRealmDataRoots(managerDataDirectory, definition.realmId)
      const accountService = createRealmServiceDispatch(() => {
        if (accounts.getSiteId() !== siteId) throw new Error('账号上下文已变化，请重试')
        return accounts.client
      })
      const onAiRequestStarted = createAccountUsageTracker({
        identities: createActiveIdentityReader(definition, {
          getSessionState: () => accountService.getSessionState(),
          getSessionRevision: () => accountService.getSessionRevision!(),
        }),
        assertReady: accounts.assertReady,
        emit: (event) => {
          if (!managedMainWindow || managedMainWindow.isDestroyed()) return
          if (managedMainWindow.webContents.isDestroyed()) return
          managedMainWindow.webContents.send(ipcEventChannels.onAccountUsageChanged, event)
        },
      })
      const accountCredentialStore = new AccountCredentialStore(path.join(roots.rootDirectory, 'account-credentials.dat'), safeStorage)
      const managedCliKeyStore = new ManagedCliKeyStore(roots.managedCliKeysFile, safeStorage, siteId)
      const chatKeyStore = new ChatKeyStore(roots.chatKeysFile, safeStorage)
      const chatCredentials = createChatCredentialCoordinator({ accountService, modelService: systemService, keyStore: chatKeyStore })
      const aiOutputRoot = roots.assetOutputDirectory(resolveAiOutputRoot({
        isPackaged: app.isPackaged,
        projectRoot: path.join(__dirname, '..'),
        execPath: process.execPath,
      }))
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
      const canvasProjects = new CanvasProjectStore(roots.canvasProjectsDirectory)
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
        realmId: definition.realmId,
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
        store: new AssetThumbnailStore({ cacheRoot: roots.assetThumbnailsDirectory }),
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
      const assetProtocol = createAiAssetProtocolHandler({
        assets: canvasProjectAssets,
        identities: createActiveIdentityReader(definition, { getSessionState: () => accountService.getSessionState(),
          getSessionRevision: () => accountService.getSessionRevision!() }),
        thumbnails: assetThumbnails,
      })
      const chatService = createAiChatService({
        onRequestStarted: onAiRequestStarted,
        baseUrl: definition.aiBaseUrl,
        credentialCoordinator: chatCredentials,
        fetchImpl: relayFetch,
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
            code: event.code,
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
      runtimeLog.log('info', 'chat', 'network.ready', 'AI聊天网络栈已就绪', {
        transport: 'electron-net',
        responseHeaderTimeoutMs: AI_CHAT_STREAM_LIMITS.connectionTimeoutMs,
      })
      const imageService = createAiImageService({
        onRequestStarted: onAiRequestStarted,
        fetchImpl: relayFetch,
        baseUrl: definition.aiBaseUrl,
        credentials: chatCredentials,
        assets: assetStore,
      })
      const canvasImageService = createAiImageService({
        onRequestStarted: onAiRequestStarted,
        fetchImpl: relayFetch,
        baseUrl: definition.aiBaseUrl,
        credentials: chatCredentials,
        assets: {
          prepareProject: (userId, projectId) => canvasProjectAssets.prepareProject(userId, projectId),
          storeBase64: (userId, value, metadata) => canvasProjectAssets.storeBase64(userId, value, metadata),
          storeRemoteUrl: (userId, url, metadata) => canvasProjectAssets.storeRemoteUrl(userId, url, metadata),
          readOwned: (userId, assetId, projectId) => canvasProjectAssets.readImageOwned(userId, assetId, projectId),
        },
      })
      const videoTasks = new AiVideoTaskStore({
        rootDirectory: roots.canvasVideoTasksDirectory,
      })
      const videoService = createAiVideoService({
        fetchImpl: relayFetch,
        baseUrl: definition.aiBaseUrl,
        credentials: chatCredentials,
        tasks: videoTasks,
        assets: {
          prepareProject: (userId, projectId) => canvasProjectAssets.prepareProject(userId, projectId),
          storeMp4: (userId, bytes, metadata) => canvasProjectAssets.storeMp4(userId, bytes, metadata),
          readImageDataUri: (userId, assetId, projectId) => canvasProjectAssets.readImageDataUri(userId, assetId, projectId),
          readOwned: (userId, assetId, kind, projectId) => canvasProjectAssets.readMediaOwned(userId, assetId, kind, projectId),
        },
      })
      if (siteId === 'solov-api') {
        videoService.generate = async () => { throw new Error('当前账号暂不支持视频生成') }
        videoService.resumeVideoTask = async () => { throw new Error('当前账号暂不支持视频生成') }
      }
      const canvasRunStore = new CanvasRunStore({
        rootDirectory: roots.canvasRuntimeDirectory,
        assets: canvasProjectAssets,
      })
      const canvasPromptPresets = new CanvasPromptPresetStore({
        rootDirectory: path.join(roots.rootDirectory, 'canvas-content'),
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
      return { accountCredentialStore, managedCliKeyStore, chatKeyStore, chatCredentials, assetStore, videoAssets,
        audioAssets, mediaAssets, canvasPromptPresets, canvasProjects, canvasProjectAssets,
        chatService, imageService, canvasImageService, videoService, canvasRuns, assetProtocol }
    }
    const businesses = new Map<RealmAccountSiteId, ReturnType<typeof createBusiness>>()
    type CanvasRunListener = Parameters<ReturnType<typeof createCanvasRunService>['subscribe']>[0]
    type CanvasRunUnsubscribe = ReturnType<ReturnType<typeof createCanvasRunService>['subscribe']>
    const canvasRunSubscriptions = new Set<{
      listener: CanvasRunListener
      removers: Map<RealmAccountSiteId, CanvasRunUnsubscribe>
    }>()
    // Construct each realm on first access. The initial realm is still the
    // account service's default until restoreActive completes below.
    const ensureBusiness = (siteId: RealmAccountSiteId) => {
      const existing = businesses.get(siteId)
      if (existing) return existing
      const created = createBusiness(siteId)
      businesses.set(siteId, created)
      // A renderer subscription can outlive a realm switch. Attach it to a
      // lazily-created realm as soon as that realm becomes available.
      for (const subscription of canvasRunSubscriptions) {
        subscription.removers.set(siteId, created.canvasRuns.subscribe(subscription.listener))
      }
      return created
    }
    ensureBusiness(accounts.getSiteId())
    const currentBusiness = () => ensureBusiness(accounts.getSiteId())
    const accountCredentialStore = createRealmServiceDispatch(() => currentBusiness().accountCredentialStore)
    const managedCliKeyStore = createRealmServiceDispatch(() => currentBusiness().managedCliKeyStore)
    const chatKeyStore = createRealmServiceDispatch(() => currentBusiness().chatKeyStore)
    const chatCredentials = createRealmServiceDispatch(() => currentBusiness().chatCredentials)
    const assetStore = createRealmServiceDispatch(() => currentBusiness().assetStore)
    const videoAssets = createRealmServiceDispatch(() => currentBusiness().videoAssets)
    const audioAssets = createRealmServiceDispatch(() => currentBusiness().audioAssets)
    const mediaAssets = createRealmServiceDispatch(() => currentBusiness().mediaAssets)
    const canvasPromptPresets = createRealmServiceDispatch(() => currentBusiness().canvasPromptPresets)
    const canvasProjects = createRealmServiceDispatch(() => currentBusiness().canvasProjects)
    const canvasProjectAssets = createRealmServiceDispatch(() => currentBusiness().canvasProjectAssets)
    const chatService = createRealmServiceDispatch(() => currentBusiness().chatService)
    const imageService = createRealmServiceDispatch(() => currentBusiness().imageService)
    const canvasImageService = createRealmServiceDispatch(() => currentBusiness().canvasImageService)
    const videoService = createRealmServiceDispatch(() => currentBusiness().videoService)
    const canvasRuns = createRealmServiceDispatch(() => currentBusiness().canvasRuns)
    // Run subscriptions outlive a selected realm, so keep them attached to
    // every store, including stores created lazily after the initial render.
    canvasRuns.subscribe = (listener) => {
      const subscription = { listener, removers: new Map<RealmAccountSiteId, CanvasRunUnsubscribe>() }
      for (const [siteId, business] of businesses) {
        subscription.removers.set(siteId, business.canvasRuns.subscribe(listener))
      }
      canvasRunSubscriptions.add(subscription)
      return () => {
        if (!canvasRunSubscriptions.delete(subscription)) return
        for (const unsubscribe of subscription.removers.values()) unsubscribe()
      }
    }
    protocol.handle('xingmang-asset', async (request) => {
      try { return await accountWork.run(() => currentBusiness().assetProtocol(request)) }
      catch { return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } }) }
    })
    const canvasController = createCanvasWindowController({
      accountWork,
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
    // Session restoration may have completed before the controller was
    // constructed. Seed its ownership record so the first real account
    // transition is delivered to an already-open canvas window exactly once.
    canvasController.setAccountUser(accountService.getSessionState().account?.userId ?? null)
    const paymentWindow = createPaymentWindowController({
      iconPath: path.join(app.getAppPath(), 'assets', 'brand', 'v3', 'app-icon.png'),
      createOrderStatusReader: (tradeNo) => createPaymentOrderStatusReader({
        client: accountService,
        getSiteId: accounts.getSiteId,
        assertReady: accounts.assertReady,
      }, tradeNo),
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
    const accountSessionReady = accounts.restoreActive().then(() => undefined).catch((error) => {
      runtimeLog.exception('account', 'session.restore.failed', error)
    })
    let developmentAcceleration: ReturnType<typeof createAccelerationDevelopmentHost> | undefined
    try {
      const accelerationConfig = app.isPackaged
        ? await readBundledAccelerationConfig({ isPackaged: true, platform: process.platform, resourcesPath: process.resourcesPath,
          bundledMetadata: applicationPackage.xingmangAccelerationBundle })
        : await readAccelerationDevelopmentConfig({ isPackaged: false, platform: process.platform, dataDirectory: managerDataDirectory })
      if (accelerationConfig) developmentAcceleration = createAccelerationDevelopmentHost({
        config: accelerationConfig, dataDirectory: managerDataDirectory, packaged: app.isPackaged,
        onDiagnostic: (stage) => runtimeLog.log('warn', 'network', 'acceleration.stop.failed',
          '加速停止尚未完成，将保留恢复记录并重试', { stage }),
        // A failed connect resolves with an error-carrying state rather than
        // rejecting, so the IPC layer records it as a success. Without this the
        // only trace of a machine that can never connect is a sentence on
        // screen that means the same thing for every possible cause.
        onStartDiagnostic: (stage) => runtimeLog.log('error', 'network', 'acceleration.start.failed',
          `加速连接失败：${accelerationStartFailureDescriptions[stage]}`, { stage }),
        // yoyo 2026-09-20 真机反馈：本地 VPN 与加速互抢系统代理时，下载到底走了哪条线
        // 事后完全看不出来。记录检测到什么，以及用户是否选择了「仍然连接」。
        onConflictDiagnostic: (kind, ignored) => runtimeLog.log('warn', 'network',
          ignored ? 'acceleration.conflict.ignored' : 'acceleration.conflict.detected',
          `${ignored ? '用户选择忽略网络冲突继续连接' : '开始加速前检测到网络冲突'}：${accelerationConflictDescriptions[kind]}`,
          { kind, ignored }),
        ...(app.isPackaged ? { entitlementSource: 'local-device' as const } : {}),
      })
    } catch {
      runtimeLog.log('warn', 'network', 'acceleration.config.invalid', '本机加速资源校验未通过')
    }
    // The worker restores a proxy lease left by a crash as part of its own
    // initialization, and it only starts when a request reaches it. Every other
    // request carries an account scope, so a machine left pointing at a dead
    // acceleration port would never recover: the dead proxy blocks the sign-in
    // that would have produced the first scoped request.
    if (developmentAcceleration) void developmentAcceleration.recover().catch((error) => {
      runtimeLog.exception('network', 'acceleration.recover.failed', error)
    })
    readAccelerationAccountScope = () => {
      const state = accountService.getSessionState()
      if (!state.authenticated || !state.account) return null
      return `${accounts.getSiteId() === 'solov-api' ? 'api-account' : 'xm-account'}:${state.account.userId}`
    }
    accelerationDownloadRoutes = developmentAcceleration ?? null
    acceleration = createAccelerationService({
      backend: developmentAcceleration,
      getAccountScope: () => readAccelerationAccountScope(),
    })
    const unregisterIpcHandlers = registerIpcHandlers({
      acceleration,
      realmAccounts: accounts,
      accountWork,
      accountCredentialsForSite: (siteId) => ensureBusiness(siteId).accountCredentialStore,
      savedAccounts,
      systemService,
      accountService,
      paymentWindow,
      accountSessionReady,
      announcementReads: new AnnouncementReadStore(path.join(managerDataDirectory, 'announcement-reads')),
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
      onRendererError: (error) => {
        crashReporter.report({
          mechanism: 'renderer-error',
          source: 'renderer',
          error: Object.assign(new Error(error.message), { stack: error.stack }),
          context: error.context,
        })
      },
      takeExternalDeepLink: (sender) => managedMainWindow?.webContents === sender ? deepLinkInbox.take() : null,
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
      void acceleration?.dispose().catch((error) => runtimeLog.exception('network', 'acceleration.shutdown.failed', error))
      void developmentAcceleration?.dispose().catch(() => undefined)
      runtimeLog.log('info', 'main', 'app.stopping', '应用主进程即将退出')
      process.off('uncaughtExceptionMonitor', onUncaughtException)
      process.off('unhandledRejection', onUnhandledRejection)
      if (periodicUpdateTimer) clearInterval(periodicUpdateTimer)
      unsubscribeDesktopNotifications()
      desktopNotifications.dispose()
      unregisterIpcHandlers()
      for (const business of businesses.values()) {
        business.chatService.dispose()
        business.imageService.cancelAll()
        business.canvasImageService.cancelAll()
        business.videoService.cancelAll()
        business.canvasRuns.shutdown()
      }
      protocol.unhandle('xingmang-asset')
      paymentWindow.destroy()
      canvasController.dispose()
      updaterService.dispose()
    })
    const mainWindow = createWindow(systemService, urlPolicy, runtimeLog)
    managedMainWindow = mainWindow
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
          detail: trayReady ? '缩到托盘会保留正在执行的任务。强制退出不等待任务完成，未保存的输入不会保留。' : '系统托盘不可用。强制退出不等待任务完成，未保存的输入不会保留。',
          buttons: trayReady ? ['缩到托盘', '强制退出程序', '返回'] : ['强制退出程序', '返回'],
          defaultId: trayReady ? 0 : 1, cancelId: trayReady ? 2 : 1,
        })
        return trayReady ? result.response === 0 ? 'hide' : result.response === 1 ? 'quit' : 'cancel' : result.response === 0 ? 'quit' : 'cancel'
      },
      prepareToQuit: async () => {
        await acceleration?.stopAll()
      },
      flushWindowState: () => windowPreferenceFlushers.get(mainWindow.webContents)?.() ?? Promise.resolve(),
      show: showMainWindow,
      hide: () => mainWindow.hide(),
      quit: () => {
        // app.quit preserves updater and shutdown hooks. A stalled window or
        // hook still cannot trap an explicitly requested force quit.
        const forceExitTimer = setTimeout(() => app.exit(0), 2_000)
        forceExitTimer.unref()
        try { canvasController.dispose() } catch (cause) { runtimeLog.exception('canvas', 'shutdown.failed', cause) }
        try { paymentWindow.destroy() } catch (cause) { runtimeLog.exception('payment', 'shutdown.failed', cause) }
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.on('will-prevent-unload', (event) => event.preventDefault())
        }
        app.quit()
      },
      onError: (cause) => {
        runtimeLog.exception('window', 'close.failed', cause)
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
    app.once('will-quit', () => { lifecycle.dispose(); applicationTray?.dispose() })
    // The canvas window is a secondary, opt-in surface -- it must not
    // outlive the main window (which would otherwise leave the app running
    // in the background with no way back to the dashboard on Windows/Linux,
    // since window-all-closed only quits when every window is gone).
    mainWindow.on('closed', () => {
      paymentWindow.destroy()
      canvasController.dispose()
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
