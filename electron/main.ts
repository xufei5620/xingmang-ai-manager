import path from 'node:path'
import os from 'node:os'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  protocol,
  screen,
  session,
  type WebContents,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { AppSettingsStore, type AppTheme } from './app-settings'
import { ConfigBackupStore } from './backups'
import { providerIds } from './catalog'
import { runWithTrustedWindowsProcessEnvironment } from './command-runner'
import { CodexExtensionService } from './codex-extensions'
import { CodexSessionsService } from './codex-sessions'
import { ProviderExtensionService } from './provider-extensions'
import { ProviderSessionsService } from './provider-sessions'
import { RuntimeLogStore } from './runtime-log'
import { inspectProviderConfig } from './config-files'
import {
  createDiagnosticsExport,
  runDiagnostics,
  type DiagnosticsReport,
} from './diagnostics'
import { registerIpcHandlers, type AppWindowMode } from './ipc'
import {
  hasDisallowedPackagedDebugSwitch,
  isAllowedAppNavigationUrl,
  resolvePackagedApplicationFile,
  type ApplicationUrlPolicy,
} from './security'
import { createSystemService, type SystemService } from './system-service'
import { installStrictUpdateCodeSignatureVerifier } from './update-signature'
import { createUpdaterService } from './updater'
import { resolveWindowsCliExecutionMode } from './windows-elevation'

const externalUrlAllowlist = [
  'https://nodejs.org/',
  'https://www.python.org/downloads/',
  'https://api.solov.cc',
  'https://api.solov.cc/keys',
  'https://s4621e8xzb.feishu.cn/wiki/XLDLwdXDli3fj9kyMvsc5Qldnie?from=from_copylink',
  'https://chatgpt.com/download/',
  'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS',
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
  target.setBackgroundColor(palette.background)
  target.setTitleBarOverlay({
    color: palette.titleBar,
    symbolColor: palette.symbol,
    height: 38,
  })
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
  const window = new BrowserWindow({
    width: Math.min(requested.width, workArea.width),
    height: Math.min(requested.height, workArea.height),
    minWidth: minimum.width,
    minHeight: minimum.height,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: palette.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: palette.titleBar,
      symbolColor: palette.symbol,
      height: 38,
    },
    icon: path.join(app.getAppPath(), 'assets', 'windows-icon.png'),
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
    void window.loadURL(url.toString()).catch((error) => {
      runtimeLog.exception('renderer', 'page.load.failed', error)
    })
  } else {
    const applicationUrl = new URL('index.html', packagedApplicationBaseUrl)
    applicationUrl.searchParams.set('theme', stored.theme)
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
    Menu.setApplicationMenu(null)
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
    const runtimeLog = new RuntimeLogStore({
      directory: path.join(managerDataDirectory, 'logs'),
      appName: '星芒AI管理工具',
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
    })
    runtimeLog.log('info', 'main', 'app.started', '应用主进程已启动', {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    })
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
    const systemService = createSystemService(settingsStore, { windowsExecutionMode: windowsCliExecutionMode })
    const storedSettings = systemService.readStoredConfig()
    const developmentCodexHome = !app.isPackaged
      ? process.env.XINGMANG_CODEX_HOME_OVERRIDE?.trim() || undefined
      : undefined
    const sessionsService = new CodexSessionsService({
      codexHome: developmentCodexHome,
      managerDataDirectory: path.join(managerDataDirectory, 'sessions'),
      onRecoveryWarning: (warning) => {
        runtimeLog.log('warn', 'sessions', warning.code, warning.message, warning.detail)
      },
    })
    const providerSessionsService = new ProviderSessionsService({
      codexService: sessionsService,
    })
    const backupStore = new ConfigBackupStore({
      userDataDirectory: managerDataDirectory,
      homeDirectory: os.homedir(),
    })
    const extensionService = new CodexExtensionService({
      repositoryRoot: storedSettings.workspace,
      trashDirectory: path.join(managerDataDirectory, 'trash', 'skills'),
      windowsExecutionMode: windowsCliExecutionMode,
    })
    const providerExtensionService = new ProviderExtensionService({
      repositoryRoot: storedSettings.workspace,
      windowsExecutionMode: windowsCliExecutionMode,
    })
    let latestDiagnostics: DiagnosticsReport | null = null
    const diagnosticsService = {
      run: async () => {
        latestDiagnostics = await runDiagnostics({
          app: {
            name: '星芒AI管理工具',
            version: app.getVersion(),
            packaged: app.isPackaged,
          },
          inspectCodexDesktop: async () => systemService.inspectCodexDesktop(),
        })
        return latestDiagnostics
      },
      exportLatest: () => {
        if (!latestDiagnostics) throw new Error('请先运行一次健康诊断')
        return createDiagnosticsExport(latestDiagnostics, {
          homeDirectory: os.homedir(),
          sensitiveValues: providerIds
            .map((provider) => inspectProviderConfig(provider).apiKey)
            .filter(Boolean),
        })
      },
    }
    if (process.platform === 'win32') {
      installStrictUpdateCodeSignatureVerifier(autoUpdater as typeof autoUpdater & {
        verifyUpdateCodeSignature: (publisherNames: string[], filePath: string) => Promise<string | null>
      })
    }
    const updaterService = createUpdaterService(autoUpdater, {
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      enableDevelopmentUpdates: process.env.XINGMANG_UPDATE_DEV === '1',
      installEnvironmentGuard: process.platform === 'win32'
        ? (launch) => runWithTrustedWindowsProcessEnvironment(launch)
        : undefined,
    })
    let periodicUpdateTimer: NodeJS.Timeout | null = null
    const urlPolicy = applicationUrlPolicy()
    registerApplicationProtocol(urlPolicy)
    const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'

    await systemService.writeStoredConfig(systemService.readStoredConfig())
    const unregisterIpcHandlers = registerIpcHandlers({
      systemService,
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
    })
    app.once('will-quit', () => {
      runtimeLog.log('info', 'main', 'app.stopping', '应用主进程即将退出')
      process.off('uncaughtExceptionMonitor', onUncaughtException)
      process.off('unhandledRejection', onUnhandledRejection)
      if (periodicUpdateTimer) clearInterval(periodicUpdateTimer)
      unregisterIpcHandlers()
      updaterService.dispose()
    })
    const mainWindow = createWindow(systemService, urlPolicy, runtimeLog)
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
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : '主程序初始化失败，Windows 未返回错误详情'
    console.error('Application startup failed:', error)
    dialog.showErrorBox('星芒AI管理工具启动失败', message)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
