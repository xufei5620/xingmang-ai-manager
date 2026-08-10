import path from 'node:path'
import os from 'node:os'
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  dialog,
  Menu,
  protocol,
  safeStorage,
  screen,
  session,
  type WebContents,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { AccountSessionStore, restoreAccountSessionOnStartup } from './account-session-store'
import { AppSettingsStore, type AppTheme } from './app-settings'
import { ConfigBackupStore } from './backups'
import { providerIds } from './catalog'
import { canvasProtocolScheme } from './canvas-protocol'
import { createCanvasWindowController } from './canvas-window'
import { resolveCodexHomeContext } from './codex-home'
import { runWithTrustedWindowsProcessEnvironment } from './command-runner'
import { CodexExtensionService } from './codex-extensions'
import { CodexSessionsService } from './codex-sessions'
import { createNewApiClient } from './new-api-client'
import type { RelayBackendClient } from './relay-backend'
import { ProviderExtensionService } from './provider-extensions'
import { ProviderSessionsService } from './provider-sessions'
import { RuntimeLogStore } from './runtime-log'
import { recordStartupFailure } from './startup-log'
import { inspectProviderConfig } from './config-files'
import { rootedMainServiceOptions } from './main-service-options'
import { relaySiteExternalUrls, relaySites, resolveRelaySite } from './relay-sites'
import {
  createDiagnosticsExport,
  runDiagnostics,
  type DiagnosticsReport,
} from './diagnostics'
import { registerIpcHandlers, type AppWindowMode } from './ipc'
import { ipcEventChannels } from './ipc-contract'
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

const applicationPackage = require('../package.json') as {
  xingmangLocalBuild?: unknown
}

const nonSiteExternalUrlAllowlist = [
  'https://nodejs.org/',
  'https://www.python.org/downloads/',
  'https://s4621e8xzb.feishu.cn/wiki/XLDLwdXDli3fj9kyMvsc5Qldnie?from=from_copylink',
  'https://chatgpt.com/download/',
  'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS',
] as const

// Every relay site's own destinations (CLI-key marketing/keys pages, and --
// for a new-api backed site -- the account-center (W4a) "去充值" button),
// derived via relay-sites.ts's relaySiteExternalUrls rather than hand-typed
// here so this can never drift from the site registry. href must equal
// these exactly (I12).
//
// The wallet URL's shape (bare `/wallet`, not `/console/wallet`) was
// confirmed by reading QuantumNous/new-api's own web frontend route file
// directly -- web/src/routes/_authenticated/wallet/index.tsx's
// `createFileRoute('/_authenticated/wallet/')` -- at both the `main` branch
// and the exact v1.0.0-rc.22/v1.0.0-rc.24 tags (byte-identical across all
// three, the latter two bracketing xm.solov.cc's own pinned version).
// `_authenticated` is a pathless TanStack Router layout segment, so the real
// URL is bare `/wallet`. No trailing slash, no query string.
const externalUrlAllowlist = [
  ...nonSiteExternalUrlAllowlist,
  ...relaySiteExternalUrls(relaySites),
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

const appWindowSizes: Record<AppWindowMode, { width: number; height: number }> = {
  onboarding: { width: 720, height: 520 },
  dashboard: { width: 1340, height: 845 },
}

const appWindowMinimumSizes: Record<AppWindowMode, { width: number; height: number }> = {
  onboarding: { width: 680, height: 500 },
  dashboard: { width: 980, height: 680 },
}

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

function windowForContents(contents: WebContents): BrowserWindow {
  const target = BrowserWindow.fromWebContents(contents)
  if (!target) throw new Error('未找到应用窗口')
  return target
}

function setWindowMode(contents: WebContents, mode: AppWindowMode): void {
  const target = windowForContents(contents)
  const workArea = screen.getDisplayMatching(target.getBounds()).workAreaSize
  const requested = appWindowSizes[mode]
  const minimum = appWindowMinimumSizes[mode]
  target.setMinimumSize(minimum.width, minimum.height)
  target.setSize(
    Math.min(requested.width, workArea.width),
    Math.min(requested.height, workArea.height),
    true,
  )
  target.center()
}

function setWindowTheme(contents: WebContents, theme: AppTheme): void {
  const target = windowForContents(contents)
  const palette = windowThemePalette(theme)
  applyWindowTheme(target, palette, process.platform)
}

function createWindow(
  systemService: SystemService,
  urlPolicy: ApplicationUrlPolicy,
  runtimeLog: RuntimeLogStore,
): BrowserWindow {
  const stored = systemService.readStoredConfig()
  const codexConfig = systemService.inspectCodexReadiness(false)
  const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'
  const initialMode: AppWindowMode = previewOnboarding
    || !codexConfig.hasApiKey
    || !codexConfig.matchesRelay
    ? 'onboarding'
    : 'dashboard'
  const requested = appWindowSizes[initialMode]
  const minimum = appWindowMinimumSizes[initialMode]
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const palette = windowThemePalette(stored.theme)
  const windowsIcon = path.join(app.getAppPath(), 'assets', 'windows-icon.png')
  const window = new BrowserWindow({
    width: Math.min(requested.width, workArea.width),
    height: Math.min(requested.height, workArea.height),
    minWidth: minimum.width,
    minHeight: minimum.height,
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
    window.center()
    window.show()
  })
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
    void window.loadURL(url.toString()).catch((error) => {
      runtimeLog.exception('renderer', 'page.load.failed', error)
    })
  } else {
    const applicationUrl = new URL('index.html', packagedApplicationBaseUrl)
    applicationUrl.searchParams.set('theme', stored.theme)
    if (previewOnboarding) applicationUrl.searchParams.set('onboardingPreview', '1')
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
  if (!singleInstanceDisabledForDevelopment) {
    app.on('second-instance', () => {
      if (!focusExistingWindow()) focusWhenWindowIsReady = true
    })
  }

  void app.whenReady().then(async () => {
    if (process.platform === 'win32') {
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
    })
    runtimeLog.log('info', 'updater', 'runtime.selected', '主程序更新运行模式已确定', {
      enabled: updaterService.getState().phase !== 'disabled',
      localBuild,
    })
    let periodicUpdateTimer: NodeJS.Timeout | null = null
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
    const accountService: RelayBackendClient = createNewApiClient({
      onSessionChange: (persistable) => {
        if (persistable) {
          void accountSessionStore.save(persistable).catch((error) => {
            runtimeLog.log('warn', 'account', 'session.persist.failed', '登录状态持久化失败', {
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        } else {
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
    const canvasController = createCanvasWindowController({
      canvasDistRoot: canvasDistRoot(),
      externalUrlAllowlist: canvasExternalUrlAllowlist,
      systemService,
      accountService,
      previewOnboarding,
      runtimeLog,
    })

    // Empty update = read the effective record (file, .bak, or defaults) and
    // persist it durably -- same normalize-on-startup write as before the
    // field-wise-merge change, routed through the same serialized queue.
    await systemService.updateStoredConfig({ version: 2 })
    const unregisterIpcHandlers = registerIpcHandlers({
      systemService,
      accountService,
      accountSessionReady,
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
      },
      setWindowMode,
      setWindowTheme,
      openCanvasWindow: () => canvasController.open(),
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
      unregisterIpcHandlers()
      canvasController.dispose()
      updaterService.dispose()
    })
    const mainWindow = createWindow(systemService, urlPolicy, runtimeLog)
    // The canvas window is a secondary, opt-in surface -- it must not
    // outlive the main window (which would otherwise leave the app running
    // in the background with no way back to the dashboard on Windows/Linux,
    // since window-all-closed only quits when every window is gone).
    mainWindow.on('closed', () => canvasController.closeIfOpen())
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
      if (BrowserWindow.getAllWindows().length === 0) createWindow(systemService, urlPolicy, runtimeLog)
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
