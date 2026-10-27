import path from 'node:path'
import os from 'node:os'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
  webContents,
  type WebContents,
} from 'electron'
import { AnnouncementReadStore } from './announcement-read-store'
import type { AccelerationExpiryNotice } from './acceleration-expiry-notice'
import type { AccelerationInterruptionNotice } from './acceleration-interruption-notice'
import { createAccelerationPower } from './acceleration-power'
import { createAccelerationService } from './acceleration-service'
import type { AccelerationBundleCheck } from './acceleration-contract'
import { createAccelerationPreferenceStore } from './acceleration-preference-store'
import { readAccelerationDevelopmentConfig, type AccelerationDevelopmentHost } from './acceleration-development-host'
import { readBundledAccelerationConfig } from './acceleration-bundled-config'
import { createAiChatHistoryStore } from './ai-chat-history-store'
import { createManagedKeyReplacementStore } from './managed-key-replacement-store'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import { AppSettingsStore, readAppSettings, type AppTheme } from './app-settings'
import { calculateUiZoom, resolveWindowPlacement } from './window-preferences'
import { attachEditContextMenu } from './context-menu'
import { recoverOffscreenWindow } from './window-recovery'
import { createWindowLifecycle } from './window-lifecycle'
import { createAccelerationHost, createAccelerationRouting, createAccelerationServices } from './bootstrap/acceleration'
import { createAccountClientFactory, createAccountStorage } from './bootstrap/accounts'
import { createRealmBusinesses } from './bootstrap/ai-services'
import { createDiagnostics } from './bootstrap/diagnostics'
import { createQuitCleanup } from './bootstrap/lifecycle'
import { createNetworkRoutes, startToolRouteFollowing } from './bootstrap/network-routes'
import { createUpdateFeed } from './bootstrap/updates'
import { installLeftoverStartupDelayMs, sweepInstallLeftovers } from './install-leftovers'
import { createLoginQuietPeriod, hasLoginLaunchArgument, loginQuietPeriodMs, resolveLoginLaunch, shouldRevealInitialWindow, windowsAppUserModelId } from './login-launch'
import { resolveInstallableUpdateOnQuit, resolveInterruptibleInstallTask, waitForUpdateInstallFailure, type InterruptibleInstallTask } from './quit-blocking-tasks'
import { createUpdateInstallPrompter } from './update-install-prompt'
import { LAUNCH_INSTALL_NOTICE_MS, QUIT_INSTALL_NOTICE_MS, buildAutoInstallNotice, canInstallUnattended, createPendingUpdateStore, decideLaunchInstall, decideQuitInstall, isBackgroundInstallFailed, isRelaunchAfterBackgroundInstall, memoizeUnattendedInstall, quitInstallPrompt, resolveDownloadedVersionToRecord, resolveLaunchInstallMode, resolveRecordToWriteAtLaunch, shouldStillInstallAtLaunch, undoQuitInstallAttempt, type LaunchInstallMode, type QuitInstallAttempt } from './auto-update-install'
import { createWindowResponsivenessGuard } from './window-responsiveness'
import { createRendererCrashRecovery, type RendererCrashRecovery } from './renderer-crash-recovery'
import { createRendererRelease, type RendererRelease, type RendererReleaseLogEvent } from './renderer-release'
import { createReleasedRendererWatch, noticeFingerprint } from './released-renderer-watch'
import { createBalanceAlerts, createSpendSpikeRecordStore, readSpendBaseline } from './balance-alerts'
import { createEmptyBalanceRecordStore } from './empty-balance-alert'
import { attachRendererDelivery, detachRendererDelivery } from './platform/renderer-delivery-bridge'
import { resolveUsableSubscription } from './subscription-summary'
import { createApplicationTray, resolveTrayUpdateEntry, trayKeepAwakeLabel, traySubscriptionLabel, type ApplicationTrayController } from './application-tray'
import type { TrayAccelerationCoordinator } from './tray-acceleration'
import { createExternalDeepLinkInbox } from './external-deep-links'
import { createDesktopNotificationController } from './desktop-notifications'
import { inspectDeviceHardware, isLowEndDevice } from './device-profile'
import { buildUnexpectedExitRelaunchArgs, describeUnexpectedExitError, recordUnexpectedExit, takeUnexpectedExitNotice, unexpectedExitRecordPath } from './unexpected-exit'
import { clearDisplayCrashRecord, inspectDisplayLaunch, isDisplayCrash, pruneStaleDisplayCrashRecord, recordDisplayCrash, type DisplayLaunch } from './display-compat'
import { ConfigBackupStore } from './backups'
import { crashReportDsn, crashReportSelfTestEnvironmentKey, shouldReportCrashes } from './crash-report'
import { createCrashReporter } from './crash-reporter'
import { classifyNetworkFailure } from './network-failure'
import { PlatformSettingsStore } from './platform/settings-store'
import {
  resolveUsageOs,
  resolveUsageUpdateState,
  shouldSendUsageStats,
  usageAccountKind,
  usageEventForOperation,
  usageEventForUpdate,
  usageRouteChoice,
  usageToolInventory,
  type UsageStatsEvent,
  type UsageUpdateView,
} from './usage-stats'
import { createMainStallMonitor, createUsageStatsReporter } from './usage-stats-reporter'
import { activeProviderIds, cliCatalog, isProviderId } from './catalog'
import { externalClientOfficialDownloadUrls } from './external-client-contract'
import { gitWindowsDownloadUrl } from './git-runtime'
import { canvasProtocolScheme, canvasSecurityResponseHeaders } from './canvas-protocol'
import { createCanvasWindowController } from './canvas-window'
import { resolveCodexHomeContext } from './codex-home'
import { runCodexContextLimitsMigration } from './codex-config-migration'
import { runClaudeDesktopModelRepair } from './claude-desktop-model-repair'
import { findExecutable, isTrustedHighIntegrityExecutable, trustedCommandEnvironment } from './command-runner'
import { CodexExtensionService, isCodexCliInstalled } from './codex-extensions'
import { CodexSessionsService } from './codex-sessions'
import type { NewApiCodexStartupTicket } from './new-api-client'
import { buildAccountIdentity, createAccountIdentityTracker } from './account-identity-tracker'
import { createRealmAccountService } from './realm-account-service'
import { isRegularFile, resolveLinuxPasswordStore } from './linux-password-store'
import { resolveLinuxImeSwitches } from './linux-ime'
import { probeLinuxTrayHost } from './linux-tray-host'
import { describeLinuxDesktopSession, readLinuxSystemName } from './linux-os-release'
import { createRealmServiceDispatch } from './realm-service-dispatch'
import { createAccountWorkGate } from './account-work-gate'
import { createAccountStartupGate } from './account-startup-gate'
import { createAccountRestoreRetry } from './account-restore-retry'
import { ProviderExtensionService } from './provider-extensions'
import { ProviderSessionsService } from './provider-sessions'
import { guardProcessOutputStreams } from './process-stream-errors'
import { configureRelocatedFolderAccess } from './relocated-folders'
import { RuntimeLogStore } from './runtime-log'
import { hostNotifier } from './platform/host-notification-bridge'
import { hiddenWindowNotification, hostNotificationMessage } from './platform/notifications'
import { attachPrivacyChangeListener } from './platform/privacy-change-bridge'
import { attachProxyBypassState } from './platform/proxy-bypass-bridge'
import { attachTrayAvailability } from './platform/tray-availability-bridge'
import { networkSettingsTarget } from './proxy-bypass'
import { attachPlatformAuditLog } from './platform/runtime-log-bridge'
import { migrateLegacyWindowsLoginItem } from './platform/system-service'
import { recordStartupFailure, redactHomeDirectory } from './startup-log'
import { syncXingmangImageMcpConfigs } from './config-files'
import { rootedMainServiceOptions } from './main-service-options'
import {
  buildMacosInstallLocationNotice, buildMacosMoveFailureNotice, inspectMacosInstallLocation,
  moveMacosAppToApplications, type MacosInstallLocationChoice, type MacosInstallLocationNotice,
} from './macos-install-location'
import { privacyPolicyUrl, relaySiteExternalUrls, relaySites, sub2ApiSupportServiceUrl, supportServiceUrl, userAgreementUrl } from './relay-sites'
import { createManualRedirectFetch } from './manual-redirect-fetch'
import { createPaymentWindowController } from './payment-window'
import { createPaymentOrderStatusReader } from './payment-status-reader'
import { registerIpcHandlers, type AppWindowMode, type IpcRegistrationOptions } from './ipc'
import { removeMacLoginItem, removeMacManagedTools, resolveMacAppBundlePath, runMacUninstall } from './macos-uninstall'
import { clearLoginAndChatRecords, clearUpdaterCache, removeCliHooksFromConfigs, resolveUpdaterCacheDirectory } from './uninstall-cleanup'
import {
  installXingmangAiSkillFiles,
  resolveXingmangAiBundledSkillRoot,
  XINGMANG_IMAGE_MCP_NO_NODE_WARNING,
} from './xingmang-ai-skill'
import { buildXingmangImageMcpInvocation } from './xingmang-ai-mcp'
import { resolveClaudeStatusLineScriptPath } from './claude-status-line'
import { cliHookEventsDirectory, resolveCliHookScriptPath } from './cli-hooks'
import { resolveBundledCodexModelCatalogPath } from './codex-model-catalog'
import { createCliHookEventMonitor } from './cli-hook-events'
import { createCliKeepAwake } from './cli-keep-awake'
import { createInstallKeepAwake } from './install-keep-awake'
import { resolveProjectInstructionsTemplatePath } from './project-instructions'
import { ipcEventChannels, type AccountBalance, type AccountSubscriptionSelf, type AppUninstallRequest, type IpcEventPayload, type RendererNavigationTarget, type SettingsSaveIssue, type UnexpectedExitNotice, type XingmangEventContract } from './ipc-contract'
import {
  shouldUseManualUninstallVisualFixture,
  withManualUninstallVisualFixture,
} from './manual-uninstall-visual-fixture'
import {
  isAllowedAppNavigationUrl,
  resolvePackagedApplicationFile,
  type ApplicationUrlPolicy,
} from './security'
import {
  parseChromiumProxyResult,
  subprocessDownloadProxyEnvironment,
} from './download-proxy'
import {
  createSystemService,
  type SystemService,
  type SystemSnapshot,
} from './system-service'
import type { UpdateSnapshot } from './updater'
import { buildUpdateStateLogDetail, createUpdateStateLogFilter } from './update-state-log'
import { createLastRunVersionStore, hasPriorRunRecord, readBundledReleaseNotes, resolveInstalledRelease } from './installed-release'
import { appReleaseDownloadUrl } from './app-download-page'
import { createReleaseGuardStore } from './release-guard-store'
import { resolveCliModelHints } from './cli-model-hints-store'
import type { AccountGroupHints } from './managed-cli-groups'
import type { CliModelHints } from './cli-model-defaults'
import { inspectWindowsElevationCapability, resolveWindowsCliExecutionModeDetailed, type WindowsElevationCapability } from './windows-elevation'
import { ensureDirectoryOnWindowsUserPath, removeDirectoryFromWindowsUserPath } from './windows-cli-shell-access'
import { ensureMacosShellProfile } from './macos-shell-profile'
import { syncLinuxTerminalCommands, type LinuxTerminalCommandsReason } from './linux-shell-profile'
import {
  applyWindowTheme,
  buildMacApplicationMenuTemplate,
  platformWindowOptions,
  rendererCrashRecoveryDetail,
  resolveWindowPalette,
  titleBarOverlayHeight,
  windowIconFileName,
} from './window-presentation'
import { buildStartupFailureDialog, classifyStorageFailure, dataDriveLetter } from './startup-failure'
import { installMainWindowFrameNavigationGuard } from './platform/frame-navigation'
import { codexDesktopStoreUrl } from './codex-desktop-install-failure'
import { createCodexRemote } from './bootstrap/codex-remote'
import { createCodexRemoteKeepAwake } from './codex-remote-keep-awake'

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
  // 首页 WorkBuddy 一行，以及缺少系统 winget 时 Claude Desktop、OpenCode 两行的「去官网下载」（逐条全等）。
  ...Object.values(externalClientOfficialDownloadUrls),
  'https://chatgpt.com/download/',
  // Codex 桌面端装不上时错误框里的「去微软商店装」（第十九批 5）。
  codexDesktopStoreUrl,
  // 「必须更新」那层提示里自动更新走不通时的「打开下载页」。
  appReleaseDownloadUrl,
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
const rendererCrashRecoveries = new WeakMap<WebContents, RendererCrashRecovery>()
const rendererReleases = new WeakMap<WebContents, RendererRelease>()

const updateCheckIntervalMs = 3 * 60 * 60 * 1_000
// 启动时看一眼本机配置就够了：内存和核数不会在运行中变化。
const lowEndDevice = isLowEndDevice(inspectDeviceHardware())
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

function applicationUrlPolicy(): ApplicationUrlPolicy {
  return {
    rendererRoot: path.join(__dirname, '..', 'dist'),
    // A packaged binary must never accept an environment-provided renderer.
    // That value is intentionally limited to the local development process.
    devServerUrl: app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL,
    packagedBaseUrl: packagedApplicationBaseUrl,
  }
}

function readDocumentsDirectory(): string | null {
  try {
    return app.getPath('documents')
  } catch {
    // 拿不到「文档」时由 resolveAiOutputRoot（经 chooseAiOutputRoot）退到用户主目录。
    return null
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

function setWindowMode(contents: WebContents, _mode: AppWindowMode): void {
  const target = windowForContents(contents)
  const workArea = screen.getDisplayMatching(target.getBounds()).workAreaSize
  target.setMinimumSize(Math.min(960, workArea.width), Math.min(560, workArea.height))
  windowPreferenceAppliers.get(contents)?.()
}

function setWindowTheme(contents: WebContents, theme: AppTheme): void {
  const target = windowForContents(contents)
  const palette = resolveWindowPalette(theme)
  applyWindowTheme(target, palette, process.platform)
  windowPreferenceAppliers.get(contents)?.()
}

function recoverWindowPlacement(window: BrowserWindow, runtimeLog: RuntimeLogStore): void {
  try {
    const moved = recoverOffscreenWindow(window, screen)
    if (moved) runtimeLog.log('info', 'window', 'window.recovered-offscreen', '窗口不在任何一块屏幕上，已挪回主屏', { bounds: moved })
  } catch (error) {
    runtimeLog.exception('window', 'window.recover.failed', error)
  }
}

function createWindow(
  systemService: SystemService,
  urlPolicy: ApplicationUrlPolicy,
  runtimeLog: RuntimeLogStore,
  revealOnReady: () => boolean,
): BrowserWindow {
  const stored = systemService.readStoredConfig()
  const placement = resolveWindowPlacement(stored.windowState, screen.getAllDisplays(), screen.getPrimaryDisplay().id)
  const palette = resolveWindowPalette(stored.theme)
  const windowIcon = path.join(app.getAppPath(), 'assets', 'brand', 'v3', windowIconFileName(process.platform))
  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: placement.minimumSize.width,
    minHeight: placement.minimumSize.height,
    show: false,
    backgroundColor: palette.background,
    ...platformWindowOptions(process.platform, palette, windowIcon),
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

  // Electron 默认没有右键菜单，客户手动复制、粘贴只能靠这个。
  attachEditContextMenu(window.webContents, {
    popup: (template) => { Menu.buildFromTemplate(template).popup({ window }) },
    writeText: (text) => { clipboard.writeText(text) },
  })

  window.once('ready-to-show', () => {
    if (!revealOnReady()) {
      // 对隐藏的窗口调 maximize() 会把它直接显示出来，所以最大化留到第一次
      // 从托盘唤出时再做。
      if (placement.maximized) window.once('show', () => { window.maximize() })
      runtimeLog.log('info', 'window', 'launch.login-hidden', '开机自动启动，窗口留在托盘')
      return
    }
    if (placement.maximized) window.maximize()
    window.show()
  })
  // 上面的 placement 只在创建时算一次，之后显示器还会变。托盘、第二个实例、
  // 通知、任务栏还原，所有把窗口带出来的入口最后都走到 show 或 restore，挂在这里
  // 一条都漏不掉。等这一轮事件走完再看，那时窗口的状态和位置才是最终的。
  const recoverOnReveal = () => { setImmediate(() => recoverWindowPlacement(window, runtimeLog)) }
  window.on('show', recoverOnReveal)
  window.on('restore', recoverOnReveal)
  const applyPreferences = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const current = systemService.readStoredConfig()
    const zoom = calculateUiZoom(window.getContentBounds().width, current.uiScale)
    if (Math.abs(window.webContents.getZoomFactor() - zoom) > 0.0001) window.webContents.setZoomFactor(zoom)
    if (process.platform !== 'darwin') window.setTitleBarOverlay({ height: titleBarOverlayHeight(zoom) })
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
  const crashRecovery = createRendererCrashRecovery({
    reload: () => window.webContents.reload(),
    prompt: async () => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: '界面出了问题', message: '星芒AI管理工具的界面接连出错，自动重新加载也没能恢复。',
        detail: rendererCrashRecoveryDetail(process.platform),
        buttons: ['重新加载', '先不管'], defaultId: 0, cancelId: 1,
      })
      return result.response === 0 ? 'reload' : 'dismiss'
    },
    log: (event) => {
      if (event === 'reload.auto') { runtimeLog.log('warn', 'renderer', 'process.gone.reload', '界面进程退出后自动重新加载'); return }
      if (event === 'prompt.shown') { runtimeLog.log('warn', 'renderer', 'process.gone.prompted', '界面接连退出，已提示用户'); return }
      if (event === 'prompt.reload') { runtimeLog.log('info', 'renderer', 'process.gone.user-reload', '用户选择重新加载界面'); return }
      if (event === 'reload.reopen') { runtimeLog.log('info', 'renderer', 'process.gone.reopen-reload', '重新打开窗口时重新加载界面'); return }
      if (event === 'prompt.dismiss') runtimeLog.log('info', 'renderer', 'process.gone.dismissed', '用户暂不重新加载界面')
    },
    onError: (cause) => { runtimeLog.exception('renderer', 'process.gone.recover-failed', cause) },
  })
  rendererCrashRecoveries.set(window.webContents, crashRecovery)
  window.once('closed', () => { crashRecovery.dispose() })
  window.webContents.on('render-process-gone', (_event, details) => {
    // 缩在托盘里久了这里自己关掉的（renderer-release.ts），不是崩溃：不报、不自动重载。
    if (rendererReleases.get(window.webContents)?.consumeExpectedExit()) {
      runtimeLog.log('info', 'renderer', 'process.released', '窗口缩在托盘里，界面进程已关掉省内存', { reason: details.reason })
      return
    }
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
    if (!window.isDestroyed()) crashRecovery.handleGone(details.reason)
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
  // 同一次没响应 Electron 会连着报好几回，匿名使用统计只算一次，恢复以后再算下一次。
  let unresponsiveCounted = false
  window.on('unresponsive', () => {
    runtimeLog.log('warn', 'renderer', 'window.unresponsive', '应用窗口暂时无响应')
    if (!unresponsiveCounted) {
      unresponsiveCounted = true
      noteUsageEvent?.({ kind: 'hang', hang: 'unresponsive' })
    }
    responsiveness.handleUnresponsive()
  })
  window.on('responsive', () => {
    unresponsiveCounted = false
    responsiveness.handleResponsive()
  })
  window.once('closed', () => { responsiveness.dispose() })

  void window.loadURL(resolveMainWindowUrl(stored.theme)).catch((error) => {
    runtimeLog.exception('renderer', 'page.load.failed', error)
  })
  return window
}

// 关掉主窗口的界面进程（renderer-release.ts）。和别的页面共用同一个进程时不关，会把它们一起带走；
// 画布、付款窗口平时各有各的进程，这只是防万一。
function releaseRendererProcess(contents: WebContents): boolean {
  if (contents.isDestroyed() || contents.isCrashed()) return false
  const pid = contents.getOSProcessId()
  if (!(pid > 0)) return false
  const shared = webContents.getAllWebContents().some((other) => other !== contents && !other.isDestroyed() && other.getOSProcessId() === pid)
  if (shared) return false
  contents.forcefullyCrashRenderer()
  return true
}

const rendererReleaseLogMessages: Record<RendererReleaseLogEvent, string> = {
  'release.done': '窗口缩在托盘里有一阵了，关掉界面省内存',
  'release.deferred': '窗口缩在托盘里，还有事没做完，先不关界面',
  'release.skipped': '界面进程和别的页面共用，这次不关',
  'restore.started': '重新加载关掉的界面',
  'restore.ready': '关掉的界面重新加载好了',
}

// 主窗口界面的地址：开发时连 Vite，打包后走 xingmang://。缩到托盘关掉界面以后重新加载也用它，
// 主题按那一刻的设置，免得先闪一下旧主题。
function resolveMainWindowUrl(theme: AppTheme): string {
  const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'
  const previewDashboard = !app.isPackaged && process.env.XINGMANG_DASHBOARD_PREVIEW === '1'
  const devServerUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined
  const url = devServerUrl ? new URL(devServerUrl) : new URL('index.html', packagedApplicationBaseUrl)
  url.searchParams.set('theme', theme)
  if (previewOnboarding) url.searchParams.set('onboardingPreview', '1')
  if (previewDashboard) url.searchParams.set('dashboardPreview', '1')
  return url.toString()
}

function focusExistingWindow(): boolean {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  reloadIfRendererGone(window)
  return true
}

// 崩溃询问框里选了「先不管」，界面进程就一直没回来；只把窗口叫到前面，用户看到的
// 还是那块空白（#1061 第 12 项）。
function reloadIfRendererGone(window: BrowserWindow): void {
  if (window.webContents.isDestroyed()) return
  // 缩在托盘里被关掉的界面由 renderer-release.ts 重新加载，不当崩溃再载一次。
  if (rendererReleases.get(window.webContents)?.restore('show')) return
  rendererCrashRecoveries.get(window.webContents)?.handleReopen(window.webContents.isCrashed())
}

// cancelId 指向的按钮也在 choices 里，所以按 Esc 和点那颗按钮走同一条路。
function askMacosInstallLocation(notice: MacosInstallLocationNotice): MacosInstallLocationChoice {
  const answer = dialog.showMessageBoxSync({
    type: 'warning',
    title: notice.title,
    message: notice.message,
    detail: notice.detail,
    buttons: [...notice.buttons],
    defaultId: notice.defaultId,
    cancelId: notice.cancelId,
  })
  return notice.choices[answer] ?? 'quit'
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

/**
 * The fatal-startup dialog. `showErrorBox` offered one button that quit, and
 * its text was the raw error (English, with the Windows user name in the
 * path). This one speaks plain Chinese, keeps the raw text behind "copy", and
 * loops so copying or opening the log folder does not dismiss it.
 */
async function presentStartupFailure(error: unknown, logPath: string | null): Promise<void> {
  const content = buildStartupFailureDialog(error, {
    platform: process.platform,
    homeDirectory: os.homedir(),
    dataDirectory: appValue(() => app.getPath('userData'), null),
    appVersion: appValue(() => app.getVersion(), null),
  })
  const copyLabel = '复制错误信息'
  const logLabel = '打开日志文件夹'
  const buttons = logPath ? [copyLabel, logLabel, '退出'] : [copyLabel, '退出']
  try {
    // Bounded so a dialog that keeps returning a non-exit answer cannot keep
    // the process alive forever.
    for (let round = 0; round < 10; round += 1) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: content.title,
        message: content.message,
        detail: content.detail,
        buttons,
        defaultId: buttons.length - 1,
        cancelId: buttons.length - 1,
        noLink: true,
      })
      const choice = buttons[response]
      if (choice === copyLabel) clipboard.writeText(content.copyText)
      else if (choice === logLabel && logPath) await shell.openPath(path.dirname(logPath))
      else return
    }
  } catch {
    // Last resort: the message box itself failed. Still no raw error text.
    dialog.showErrorBox(content.title, content.message)
  }
}

// Set once the runtime log exists. A send failure before that (offline at
// launch) is simply dropped: the reporter must never become a second source
// of startup errors.
let reportCrashSendFailure: ((error: unknown) => void) | null = null
// 匿名使用统计（usage-stats.ts）建得比主窗口晚一点；在那之前、和退出以后，窗口没响应就不数。
let noteUsageEvent: ((event: UsageStatsEvent) => void) | null = null

/**
 * 一个 Chromium 会话的 fetch。net.fetch 碰到 redirect: 'manual' 不交回跳转，直接报「Redirect was
 * cancelled」，账号、AI、探测请求靠拿到跳转本身认出门户认证、拒绝被带去别的主机，全都看不见它（#1064）。
 * 主进程交出去的会话 fetch 一律包这一层，跳转照 Node 的 fetch 那样交回去（manual-redirect-fetch.ts）。
 */
function chromiumSessionFetch(target: Electron.Session): typeof fetch {
  return createManualRedirectFetch(
    (input, init) => target.fetch(input instanceof URL ? input.href : input, init),
    (options) => net.request({ ...options, session: target }),
  )
}

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
  fetchImpl: (url, init) => (app.isReady() ? chromiumSessionFetch(session.defaultSession)(url, init) : fetch(url, init)),
  onSendFailure: (error) => { reportCrashSendFailure?.(error) },
})

/**
 * 显卡加速必须在 ready 之前决定：过了 ready 再调 disableHardwareAcceleration 不生效。
 * 读设置、读崩溃记录都不许挡启动，读不到就照常用显卡加速打开。
 */
function resolveDisplayLaunch(): DisplayLaunch | null {
  try {
    const dataDirectory = app.getPath('userData')
    const now = Date.now()
    const launch = inspectDisplayLaunch({
      dataDirectory,
      hardwareAcceleration: appValue(() => readAppSettings(path.join(dataDirectory, 'settings.json')).hardwareAcceleration, undefined),
      now,
    })
    try { pruneStaleDisplayCrashRecord(launch, now) } catch { /* 删不掉旧记录只是文件多几行，下次再删。 */ }
    return launch
  } catch {
    return null
  }
}

const displayLaunch = resolveDisplayLaunch()
if (displayLaunch && displayLaunch.mode !== 'accelerated') app.disableHardwareAcceleration()
// Linux：Chromium 不认识的桌面上，就算装了系统自带的密码保管它也不去用，登录就记不住
// （linux-password-store.ts）。和显卡加速一样必须在 ready 之前定，判断不了就不动。
const linuxPasswordStore = process.platform === 'linux'
  ? appValue(() => resolveLinuxPasswordStore({
      env: process.env,
      explicit: app.commandLine.hasSwitch('password-store'),
      isFile: isRegularFile,
    }), null)
  : null
if (linuxPasswordStore) app.commandLine.appendSwitch('password-store', linuxPasswordStore)
// Wayland 下中文输入法要 Chromium 自己开文字输入协议，ready 之后再开就晚了（linux-ime.ts）。
const linuxImeSwitches = process.platform === 'linux'
  ? appValue(() => resolveLinuxImeSwitches({ env: process.env, hasSwitch: (name) => app.commandLine.hasSwitch(name) }), [])
  : []
for (const imeSwitch of linuxImeSwitches) app.commandLine.appendSwitch(imeSwitch.name, imeSwitch.value)
// 这次是自动改的兼容方式、用户还没在提示里选：设置里动过这个开关就算选过了。
let displayCompatPending = displayLaunch?.mode === 'auto-compat'
// Set once the runtime log exists; a GPU crash before that is still recorded
// on disk, it just has no log line.
let logDisplayCrash: ((details: { reason: string; exitCode: number }, recordError: unknown) => void) | null = null
app.on('child-process-gone', (_event, details) => {
  if (!isDisplayCrash(details)) return
  let recordError: unknown = null
  try {
    if (displayLaunch) recordDisplayCrash(displayLaunch.recordPath, Date.now())
  } catch (error) {
    recordError = error
  }
  logDisplayCrash?.(details, recordError)
})
// 「现在重开」：退出流程真的走到 app.quit() 时才拉起新进程；用户在退出确认里点了
// 返回就撤掉，不然下一次随手关窗会莫名其妙又开一个。
let relaunchRequested = false

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
      // 已经开着的时候开机项又拉起一次（比如注销再登录没关进程），那不是用户
      // 要看窗口，别把它顶到最前面。
      if (hasLoginLaunchArgument(argv)) return
      if (!focusExistingWindow()) focusWhenWindowIsReady = true
    })
  }

  void app.whenReady().then(async () => {
    let loginItemMigration: unknown = false
    // Installers register the scheme; development must not take over installed links.
    if (app.isPackaged) app.setAsDefaultProtocolClient('xingmang')
    // Linux 的任务栏不一定有放托盘图标的地方，先在后台问一下，建托盘之前再看结果
    // （linux-tray-host.ts）。Windows、macOS 一直有，不问。
    const linuxTrayHost = process.platform === 'win32' || process.platform === 'darwin'
      ? null
      : probeLinuxTrayHost({
          env: trustedCommandEnvironment(process.env),
          isTrustedExecutable: (executable) => isTrustedHighIntegrityExecutable(executable, process.env),
        })
    // 客服要先分清是哪个发行版（linux-os-release.ts），检查页之外的「复制给客服」也带上。
    const linuxSystemNameRead = linuxTrayHost ? readLinuxSystemName() : null
    let linuxSystemLabel: string | null = null
    // Mac 菜单要在建主窗口之前设上，「设置...」（⌘,）点下去时才去找主窗口；主窗口建好之前点了不做事。
    let navigateFromAppMenu: ((target: RendererNavigationTarget) => void) | null = null
    if (process.platform === 'win32') {
      app.setAppUserModelId(windowsAppUserModelId)
      Menu.setApplicationMenu(null)
      try {
        loginItemMigration = migrateLegacyWindowsLoginItem({
          app, platform: process.platform, packaged: app.isPackaged, executablePath: process.execPath,
        })
      } catch (error) {
        // 迁移不成最多是开机照旧弹一次窗口，不值得挡住启动。
        loginItemMigration = error
      }
    } else if (process.platform === 'darwin') {
      // BrowserWindow.icon does not control the Dock, especially under electron . in development.
      app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'brand', 'v3', 'app-icon.png'))
      const template = buildMacApplicationMenuTemplate('星芒AI管理工具', (target) => navigateFromAppMenu?.(target))
      Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    } else {
      // Linux 窗口和 Windows 一样自己画标题栏；Electron 默认那套英文 File / Edit / View
      // 菜单会在按 Alt 时从窗口顶上冒出来，里面还有「强制重新加载」「开发者工具」。
      Menu.setApplicationMenu(null)
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
    // macOS 上本程序从不提权，一开始就能按普通权限对待「搬过家」的用户文件夹；
    // Windows 要等下面的管理员探测有了结论再定（relocated-folders.ts）。
    if (process.platform !== 'win32') configureRelocatedFolderAccess('same-user')
    const managerDataDirectory = app.getPath('userData')
    // 内置加速内核三十多兆，校验要整读一遍。它以前排在建窗口前面单独等，慢机上
    // 窗口因此晚出来；现在一开始就读，和后面的迁移、命令行探测叠着跑，用到时再等。
    // 失败先接住：没等到它的这段时间里被拒绝，会被当成没人处理的错误。
    const accelerationConfigRead = (app.isPackaged
      ? readBundledAccelerationConfig({ isPackaged: true, platform: process.platform, resourcesPath: process.resourcesPath,
        bundledMetadata: applicationPackage.xingmangAccelerationBundle })
      : readAccelerationDevelopmentConfig({ isPackaged: false, platform: process.platform, dataDirectory: managerDataDirectory })
    ).then((config) => ({ ok: true as const, config }), (error: unknown) => ({ ok: false as const, error }))
    // 正式安装包自带的加速文件读不通：多半被杀毒软件隔离或改动了。开发时没带加速
    // 文件照旧是「线路准备中」，只有安装包里本该有、却读坏了才这样说（第十六批 6）。
    const accelerationBundleStatus = accelerationConfigRead.then((read): 'intact' | 'damaged' | null => (
      !app.isPackaged ? null : !read.ok ? 'damaged' : read.config ? 'intact' : null
    ))
    // 「重新检查」连点几下只读一遍：内核文件有几十 MB。
    let accelerationBundleRecheck: Promise<AccelerationBundleCheck> | null = null
    function recheckAccelerationBundle(): Promise<AccelerationBundleCheck> {
      accelerationBundleRecheck ??= readBundledAccelerationConfig({ isPackaged: true, platform: process.platform,
        resourcesPath: process.resourcesPath, bundledMetadata: applicationPackage.xingmangAccelerationBundle })
        .then((config): AccelerationBundleCheck => config ? 'repaired' : 'damaged', (): AccelerationBundleCheck => 'damaged')
        .finally(() => { accelerationBundleRecheck = null })
      return accelerationBundleRecheck
    }
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
    // 必须排在 RuntimeLogStore 写第一条之前：这次启动一写，运行日志就一定在了。
    const hadPriorRun = hasPriorRunRecord(managerDataDirectory)
    const runtimeLog = new RuntimeLogStore({
      directory: path.join(managerDataDirectory, 'logs'),
      appName: '星芒AI管理工具',
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
    })
    markRuntimeLoggingActive()
    // Hooked the moment the log exists rather than after the startup dialogs:
    // from here on the module-level monitor stops writing the startup log, so
    // anything thrown in between would otherwise reach neither file.
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
    process.on('uncaughtExceptionMonitor', onUncaughtException)
    process.on('unhandledRejection', onUnhandledRejection)
    // 退出清理只挂这一个 will-quit：下面各处按登记先后排进清单（bootstrap/lifecycle.ts），
    // 顺序由 main.test.ts 钉住，新加的一步登记在它该在的位置，别再另挂 will-quit。
    // 运行日志先改成当场写：will-quit 返回后进程就退了，排队的异步追加来不及落盘（#1335 第 3 条）。
    const quitCleanup = createQuitCleanup({
      onStepFailed: (step, error) => runtimeLog.exception('main', 'app.quit-cleanup.failed', error, { step }),
    })
    app.once('will-quit', () => {
      runtimeLog.writeSynchronouslyFromNowOn()
      quitCleanup.run()
    })
    // 上次是不是意外退出的：读完就记成「说过了」，这次启动里一直挂在窗口能力上，界面据此说一句。
    let unexpectedExit: UnexpectedExitNotice | null = null
    try {
      unexpectedExit = takeUnexpectedExitNotice(unexpectedExitRecordPath(managerDataDirectory), Date.now())
    } catch (error) {
      runtimeLog.exception('main', 'app.unexpected-exit.read-failed', error)
    }
    if (unexpectedExit) {
      runtimeLog.log('warn', 'main', 'app.unexpected-exit.previous', unexpectedExit.relaunched ? '上次意外退出后已自动重开' : '上次意外退出，没有自动重开', {
        relaunched: unexpectedExit.relaunched,
        exits: unexpectedExit.exits.length,
      })
    }
    // desktop-entry registers the platform handlers before this store exists,
    // so their audit entries buffer in the bridge until it is handed over.
    attachPlatformAuditLog((level, source, event, message, detail) => {
      runtimeLog.log(level, source, event, message, detail)
    })
    if (loginItemMigration === true) {
      runtimeLog.log('info', 'main', 'login-item.migrated', '旧版开机启动项已改成开机后留在托盘')
    } else if (loginItemMigration !== false) {
      runtimeLog.exception('main', 'login-item.migrate.failed', loginItemMigration)
    }
    runtimeLog.log('info', 'main', 'app.started', '应用主进程已启动', {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    })
    logDisplayCrash = (details, recordError) => {
      runtimeLog.log('error', 'display', 'gpu.gone', '显卡进程异常退出', { reason: details.reason, exitCode: details.exitCode })
      if (recordError) runtimeLog.exception('display', 'gpu.record.failed', recordError)
    }
    if (displayLaunch?.readError !== undefined) runtimeLog.exception('display', 'gpu.record.read-failed', displayLaunch.readError)
    if (displayLaunch?.mode === 'auto-compat') {
      runtimeLog.log('warn', 'display', 'compat.auto', '显卡进程接连崩溃，这次改用兼容方式显示', { crashes: displayLaunch.crashTimes.length })
    } else if (displayLaunch?.mode === 'user-disabled') {
      runtimeLog.log('info', 'display', 'compat.user', '已按设置关闭显卡加速显示')
    }
    if (manualUninstallVisualFixtureEnabled) {
      runtimeLog.log('warn', 'testing', 'manual-uninstall.fixture', '手动卸载视觉测试状态已启用')
    }
    if (codexContext.ignoredCodexHome) {
      // 以前这里直接抛错、整个软件打不开；现在按没设处理，检查页「环境变量覆盖」
      // 会报出来。值是用户自己写的路径，落盘前先把用户目录换掉（I13）。
      runtimeLog.log('warn', 'main', 'codex-home.ignored', '环境变量 CODEX_HOME 不是可用的绝对路径，已按未设置处理', {
        reason: codexContext.ignoredCodexHome.reason,
        value: redactHomeDirectory(codexContext.ignoredCodexHome.value, codexContext.userHome).replaceAll('\0', '\\0'),
        codexHome: redactHomeDirectory(codexContext.codexHome, codexContext.userHome),
      })
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
      const choice = askMacosInstallLocation(notice)
      let proceed = choice === 'continue'
      if (choice === 'move') {
        const outcome = moveMacosAppToApplications((options) => app.moveToApplicationsFolder(options))
        if (outcome.kind === 'moved') {
          // Electron 已经复制好，正在退出并从「应用程序」里重新打开，这一份不能再往下启动。
          runtimeLog.log('info', 'main', 'app.install-location.moved', '已移到「应用程序」，正在重新打开', {
            location: installLocation,
            conflict: outcome.conflict,
          })
          return
        }
        if (outcome.kind === 'failed') {
          runtimeLog.exception('main', 'app.install-location.move-failed', outcome.error)
        } else {
          runtimeLog.log('warn', 'main', 'app.install-location.move-cancelled', '移到「应用程序」时取消了授权', {
            conflict: outcome.conflict,
          })
        }
        proceed = askMacosInstallLocation(buildMacosMoveFailureNotice(installLocation, outcome)) === 'continue'
      }
      if (!proceed) {
        runtimeLog.log('info', 'main', 'app.install-location.quit', '用户选择退出以移动程序位置')
        app.quit()
        return
      }
      runtimeLog.log('warn', 'main', 'app.install-location.continued', '用户选择从当前位置继续运行')
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

    // Overlap the migration's asynchronous marker write with the Windows probe.
    // Both operations still complete before services and the window are created.
    const migrationPromise = runCodexContextLimitsMigration(managerDataDirectory, rootedOptions.system.providerRoots)
    const windowsCliExecutionModePromise = resolveWindowsCliExecutionModeDetailed({
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
    let settingsSaveIssue: SettingsSaveIssue | undefined
    // 加速页上选过的线路与模式单独落一份，不进 settings.json：它是按账号分的
    // 记录，而 settings.json 会整份交给渲染层，没必要把机器上每个账号的记录都
    // 送过去。
    const accelerationPreferences = createAccelerationPreferenceStore({
      filePath: path.join(managerDataDirectory, 'acceleration-preferences.json'),
    })
    const networkRoutes = createNetworkRoutes({
      managerDataDirectory,
      settingsStore,
      runtimeLog,
      chromiumSessionFetch,
      readStoredConfig: () => systemService.readStoredConfig(),
      accelerationRunning,
      mainWindow: () => managedMainWindow,
      readAccountSiteId: () => readAccountSiteId(),
    })
    const {
      relayRouteController, relayRouting, sessionFetch, proxyBypass, routedRelayFetch, observedRelayFetch,
      toolRouteController, toolRouteStatusBoard, toolRouting, notifyRelayRouteChanged, unsubscribeRelayRoute, recheckRoutes,
    } = networkRoutes
    // R6：换线路时工具配置怎么改，跟着服务状态文件（下面 serviceStatusMonitor 读到才改）；缺省定点只改地址。
    let toolRouteRewriteMode: 'targeted' | 'merge' = 'targeted'
    // Resolved before the service is built because it also decides whether an
    // unmanaged npm uninstall can run in-app.
    const windowsCliExecution = await windowsCliExecutionModePromise
    const windowsCliExecutionMode = windowsCliExecution.mode
    // 只有确认是普通权限运行时，才跟着「C 盘搬家」留下的联接去写 Key、设置和日志；
    // 按管理员身份处理（trusted-only）时照旧一律拒绝。
    configureRelocatedFolderAccess(windowsCliExecutionMode)
    runtimeLog.log('info', 'security', 'cli.execution-mode', 'CLI 扩展执行边界已确定', {
      mode: windowsCliExecutionMode,
      elapsedMs: windowsCliExecution.elapsedMs,
      ...(windowsCliExecution.highIntegrity === undefined ? {} : { highIntegrity: windowsCliExecution.highIntegrity }),
      ...(windowsCliExecution.probeFailure ? { probeFailed: windowsCliExecution.probeFailure.reason } : {}),
    })
    if (windowsCliExecution.probeFailure) {
      // 探测失败时：已看出是高权限的仍按管理员处理，什么都没看出来的按普通用户处理
      // （resolveWindowsCliExecutionModeDetailed）。原因以前被 catch 吞掉，客服分不出
      // 是真管理员还是没问出来。
      const treatedAs = windowsCliExecutionMode === 'trusted-only' ? '管理员' : '普通用户'
      runtimeLog.log('warn', 'security', 'cli.execution-mode.probe-failed', `没能确认当前是否以管理员身份运行，已按${treatedAs}处理`, {
        mode: windowsCliExecutionMode,
        reason: windowsCliExecution.probeFailure.reason,
        detail: windowsCliExecution.probeFailure.detail,
        elapsedMs: windowsCliExecution.elapsedMs,
      })
    }
    // 0.2.12 给 Claude Desktop 写进了一串型号，客户那边发消息没有回复；改回只剩选中的那一个，
    // 只做一次（claude-desktop-model-repair.ts）。放在联接策略定下之后，和「保存配置」认同一套
    // 目录规则；只读写几个小文件、不起进程，开窗前做完，界面才赶得上说一句。
    let claudeDesktopRepaired = false
    try {
      const repair = await runClaudeDesktopModelRepair(managerDataDirectory, {
        platform: process.platform,
        userHome: rootedOptions.system.providerRoots.userHome,
        relayBaseUrls: relaySites.map((site) => site.providerBaseUrls.claude),
      })
      claudeDesktopRepaired = repair.repaired > 0
      if (repair.repaired) {
        runtimeLog.log('info', 'config', 'claude-desktop.models.repaired', '已把 Claude Desktop 配置里 0.2.12 写进去的一串型号改回选中的那一个', {
          repaired: repair.repaired,
          backups: repair.backups,
        })
      }
      if (repair.unrecognized.length) {
        runtimeLog.log('info', 'config', 'claude-desktop.models.unrecognized', 'Claude Desktop 配置认不准是不是 0.2.12 写的，没动', {
          reasons: repair.unrecognized,
        })
      }
      if (repair.failures.length) {
        runtimeLog.log('warn', 'config', 'claude-desktop.models.repair-failed', 'Claude Desktop 配置这次没改成，下次打开再试', {
          failures: repair.failures,
        })
      }
    } catch (error) {
      // 修不成也不能挡住软件打开；记录读不出来时一个字不改。
      runtimeLog.exception('config', 'claude-desktop.models.repair-failed', error)
    }
    let readAccountSiteId: () => string = () => 'solov'
    let readExternalClientAccountId: () => string | null = () => null
    let readCurrentManagedCliKeys: () => Promise<readonly StoredManagedCliKey[]> = async () => []
    let readOtherManagedCliKeyAccounts: () => Promise<readonly { owner: string; keys: readonly StoredManagedCliKey[] }[]> = async () => []
    let readBillingAccountScope: () => string = () => 'xm-account:guest'
    // 账号服务也建得比这里晚。下载线路与游戏加速用的是同一个账号口径，所以
    // 指向同一个读取函数，而不是各写一份。
    let readAccelerationAccountScope: () => string | null = () => null
    // 加速宿主要晚得多才建得起来（它依赖账号与随包资源）。在那之前这里是空的，
    // 任何一次下载都按没加速继续。
    let accelerationDownloadRoutes: Pick<AccelerationDevelopmentHost, 'startDownloadRoute' | 'stopDownloadRoute'> | null = null
    // Codex 启动时读中文开关的那一下先试着经星芒服务器代取，走不通才照旧连加速（issue #977，
    // codex-desktop-startup-route.ts）。账号服务建得比这里晚，建好以后才换成真的换票。
    let issueCodexStartupTicket: () => Promise<NewApiCodexStartupTicket> = () => Promise.reject(new Error('账号服务尚未就绪'))
    const accelerationRouting = createAccelerationRouting({
      routes: networkRoutes,
      rootedOptions,
      accelerationPreferences,
      runtimeLog,
      readAccelerationAccountScope: () => readAccelerationAccountScope(),
      downloadRoutes: () => accelerationDownloadRoutes,
      accelerationService: () => acceleration,
      issueCodexStartupTicket: () => issueCodexStartupTicket(),
      readStoredConfig: () => systemService.readStoredConfig(),
    })
    const { downloadAcceleration, codexDesktopAcceleration, claudeDesktopAcceleration, codexDesktopStartupRoute, downloadFetch } = accelerationRouting
    const systemService = createSystemService(settingsStore, {
      managerDataDirectory,
      systemSnapshotCacheFile: path.join(managerDataDirectory, 'system-snapshot.json'),
      externalClientSnapshotCacheFile: path.join(managerDataDirectory, 'external-client-snapshot.json'),
      appVersion: app.getVersion(),
      getRelaySiteId: () => readAccountSiteId(),
      relayEndpointRouting: toolRouting,
      relayToolRouting: {
        applicationLines: () => relayRouting.lines(),
        // 历史账号没有工具线路，也就没有这几样提示。
        status: () => readAccountSiteId() === 'solov' ? toolRouteStatusBoard.status(toolRouteController.snapshot()) : undefined,
      },
      getExternalClientAccountId: () => readExternalClientAccountId(),
      readCurrentManagedCliKeys: () => readCurrentManagedCliKeys(),
      readOtherManagedCliKeyAccounts: () => readOtherManagedCliKeyAccounts(),
      getToolRouteRewriteMode: () => toolRouteRewriteMode,
      // 历史账号的工具配置跟应用线路：因为连不上换了、整份写入跟过去以后，照星芒账号那样提示重开（#1061 第 2 条）。
      relayRouteLastChange: (siteId) => relayRouteController.lastChange(siteId),
      cliModelHints: readCliModelHints,
      // 改完界面重读设置和配置：首页的线路标签、重开提示都在那里面。
      onToolRouteFollowed: () => notifyRelayRouteChanged(),
      windowsExecutionMode: windowsCliExecutionMode,
      runtimeLog,
      sweepInstallLeftovers,
      ...(process.platform === 'win32'
        ? {
            ensureWindowsUserPath: (directory: string) => ensureDirectoryOnWindowsUserPath(directory),
            removeWindowsUserPath: (directory: string) => removeDirectoryFromWindowsUserPath(directory),
          }
        : {}),
      ...(process.platform === 'darwin'
        ? { ensureMacosShellProfile: (reason: 'install' | 'startup') => ensureMacosShellProfile({ reason }) }
        : {}),
      ...(process.platform !== 'win32' && process.platform !== 'darwin'
        ? { syncLinuxTerminalCommands: (reason: LinuxTerminalCommandsReason) => syncLinuxTerminalCommands({ reason }) }
        : {}),
      projectInstructionsTemplatePath: resolveProjectInstructionsTemplatePath(app.getAppPath(), {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
      claudeStatusLineScriptPath: resolveClaudeStatusLineScriptPath(app.getAppPath(), {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }) ?? undefined,
      cliHookScriptPath: resolveCliHookScriptPath(app.getAppPath(), {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }) ?? undefined,
      // 只由主进程自己读，随 app.asar 走即可，不必像上面两个脚本那样拷进 extraResources。
      bundledCodexModelCatalogPath: resolveBundledCodexModelCatalogPath(app.getAppPath()),
      ...rootedOptions.system,
      relayFetch: observedRelayFetch,
      relayRoutedFetch: routedRelayFetch,
      networkLocationFetch: sessionFetch,
      // Re-read the existing session/system proxy selection without changing
      // the OS proxy or imposing a new Chromium proxy mode.
      reloadNetworkProxyConfig: () => session.defaultSession.forceReloadProxyConfig(),
      downloadFetch,
      // 查版本也走 Chromium：主进程自带的 Node fetch 不认公司或安全软件装在这台电脑
      // 上的证书，公司电脑装工具会卡在第一步（system-certificate-trust.ts）。
      registryFetch: downloadFetch,
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
      // 不再给下载临时借加速线路（acquireDownloadAcceleration 不接）：2026-10-21 起内置线路只通 ChatGPT /
      // OpenAI（acceleration-clash-config.ts 的 lineRoutedRules），npm、Node、Python、GitHub 都过不去；
      // 用户自己开着加速时下载照样跟着系统代理，在内核里按规则直连，也不算加速，安装源保持国内优先。
      prepareCodexDesktopStartupRoute: (context) => codexDesktopStartupRoute.prepare(context),
      // Claude Desktop 要从官网下组件，国内直连下不动：从星芒打开时先在后台替他连上加速（#1373）。
      prepareClaudeDesktopLaunch: (context) => claudeDesktopAcceleration.ensureConnected(context),
    })
    const { unsubscribeToolRoutes, onRouteResume, routeOnlineTimer } = startToolRouteFollowing(networkRoutes, {
      systemService,
      readAccountSiteId: () => readAccountSiteId(),
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
    // 只装了 Codex 桌面端时，扩展页的外接工具直接读写 config.toml，不跑 `codex` 命令；怎么算装了和首页一样。
    const codexCliInstalled = () => isCodexCliInstalled(rootedOptions.codexExtensions.env)
    // 移除的技能都挪进同一个回收站：Codex 的，和 Claude Code、Grok CLI 的。
    const skillTrashDirectory = path.join(managerDataDirectory, 'trash', 'skills')
    const extensionService = new CodexExtensionService({
      ...rootedOptions.codexExtensions,
      repositoryRoot: storedSettings.workspace,
      trashDirectory: skillTrashDirectory,
      windowsExecutionMode: windowsCliExecutionMode,
      serializeConfigWrite: systemService.serializeToolConfigWrite,
      cliInstalled: codexCliInstalled,
    })
    const providerExtensionService = new ProviderExtensionService({
      ...rootedOptions.providerExtensions,
      repositoryRoot: storedSettings.workspace,
      windowsExecutionMode: windowsCliExecutionMode,
      codexCliInstalled,
      skillTrashDirectory,
      // Codex 的外接工具启停没有命令，跟加、删同一边改 config.toml（备份、排队、对账）。
      setCodexMcpServerEnabled: (name, enabled) => extensionService.setMcpServerEnabled(name, enabled),
      // 装插件和加官方市场都要出网（市场是一次 git clone），而 CLI 子进程不读
      // 系统代理，所以跟 CLI 安装一样把当前线路以环境变量带下去。
      resolveSubprocessProxyEnvironment: async () => subprocessDownloadProxyEnvironment(
        // PAC 脚本可以按主机给出不同答案，扩展这条链路真正要到的是 GitHub。
        parseChromiumProxyResult(await session.defaultSession.resolveProxy('https://github.com/')),
      ),
      // Codex 的官方插件目录由本软件替它下载（codex-plugin-catalog.ts），与装 CLI
      // 同一条下载通道。先从星芒存储桶下，没走通才去 GitHub；GitHub 不在加速线路的放行名单里，
      // 所以跟装 CLI 一样不借线路（见上面 createSystemService 那条）。
      downloadFetch,
      codexCatalogBucket: {
        onFallback: (detail) => runtimeLog.log('warn', 'install', 'codex-plugin-catalog.bucket-fallback', 'Codex 插件目录存储桶这一路没走通，改从 GitHub 下', { detail }),
      },
    })
    const diagnostics = createDiagnostics({
      routes: networkRoutes,
      systemService,
      rootedOptions,
      codexContext,
      managerDataDirectory,
      windowsCliExecution,
      accelerationBundleStatus,
      accelerationRunning,
      readDocumentsDirectory,
      runtimeLog,
      readBillingAccountScope: () => readBillingAccountScope(),
      currentBusiness: () => currentBusiness(),
      assetStore: () => assetStore,
    })
    const { diagnosticsService } = diagnostics
    const updateFeed = createUpdateFeed({ applicationPackage, routes: networkRoutes, runtimeLog })
    // Builds made with XINGMANG_UNSIGNED_RELEASE=1 carry no publisherName, so
    // electron-updater returns from verifySignature before the strict verifier
    // above is ever reached. The updater re-checks the manifest digest itself;
    // the publisher accepted automatic download/install on this channel as well
    // (yoyo 2026-09-25), so the user's click is no longer the compensating step.
    const unsignedChannel = app.isPackaged && applicationPackage.xingmangUnsignedRelease === true
    const lastRunVersion = createLastRunVersionStore({ filePath: path.join(managerDataDirectory, 'last-run-version.json') })
    const recordedVersion = lastRunVersion.read()
    const installedRelease = resolveInstalledRelease({
      currentVersion: app.getVersion(),
      recordedVersion,
      hadPriorRun,
      notes: readBundledReleaseNotes(app.getAppPath(), app.getVersion()),
    })
    if (installedRelease.justUpdated) {
      runtimeLog.log('info', 'updater', 'version.updated', '本次启动是更新后的第一次', {
        from: installedRelease.previousVersion,
        to: app.getVersion(),
        bundledNotes: installedRelease.notes?.length ?? 0,
      })
    }
    // 写失败最多下次启动再提示一次，不值得挡住启动。
    if (recordedVersion !== app.getVersion()) {
      void lastRunVersion.write(app.getVersion()).catch((error: unknown) => {
        runtimeLog.log('warn', 'updater', 'version.record-failed', '上次运行版本没有记下来', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    // 窗口生命周期在主窗口建好后才有；更新在那之前不会下载完，这里先占个位。
    let updateQuitHandoff: { prepare(): Promise<void> | undefined; abort(): void } | null = null
    // 退出流程（窗口生命周期）在 IPC 注册之后才建好，先占个位。
    let requestRelaunch: (() => Promise<boolean>) | null = null
    // 更新页「确认重启安装」、托盘「重启并安装」前问那一句（主窗口建好后接上）；true = 照常装。
    let confirmUpdateInstall: (() => Promise<boolean>) | null = null
    let requestMacUninstall: NonNullable<IpcRegistrationOptions['uninstallApp']> | null = null
    // 自动更新的落盘记录（见 auto-update-install.ts）。要在更新服务之前读好：下载完成
    // 那一刻就要用它认出「上次自动装过却没装上」的版本。
    const pendingUpdateStore = createPendingUpdateStore({ filePath: path.join(managerDataDirectory, 'pending-update.json') })
    const pendingUpdateAtLaunch = pendingUpdateStore.read()
    // 撤回名单和分批放量记在本地（#1055），同样在更新服务之前读好：开机那次检查时状态文件
    // 还没读到、或者读不到，也按上次读成功的那份算。
    const releaseGuardStore = createReleaseGuardStore({ filePath: path.join(managerDataDirectory, 'release-guard.json') })
    const releaseGuardAtLaunch = releaseGuardStore.read()
    let pendingUpdateRecord = { ...pendingUpdateAtLaunch }
    // 开机自启时在后台装新版本（见下面打开时装），安装器把它重新拉起的这一次照开机自启
    // 那样待在后台。这条记录只认一次，读到就清掉；已经装上的这一版也从记录里清掉，免得
    // 装回旧版后被当成上次没装上（resolveRecordToWriteAtLaunch）。认「上次没装上」、打开时装
    // 照旧看读到的原样：正在运行的这一版不会再被当成新版本下好，清没清对它们一样。
    const relaunchedAfterBackgroundInstall = isRelaunchAfterBackgroundInstall(pendingUpdateAtLaunch, Date.now())
    const recordToWriteAtLaunch = resolveRecordToWriteAtLaunch(pendingUpdateAtLaunch, app.getVersion())
    if (recordToWriteAtLaunch) {
      pendingUpdateRecord = recordToWriteAtLaunch
      void pendingUpdateStore.write(pendingUpdateRecord).catch((cause: unknown) => {
        runtimeLog.exception('updater', 'pending.record-failed', cause)
      })
    }
    // Windows 上这个账号在不在管理员组（第二十四批 2）。不在的话装更新时授权窗口要输一个管理员
    // 账号的密码，自动装只会把软件关掉、再弹一个他填不了的窗口，所以打开时、退出时都不自动装。
    // whoami 几十毫秒就答，启动就问，下好的版本摆出来之前一般早问完了；没问出来（'unknown'）
    // 照旧自动装，不把管理员也拦住。问出来之前是 null：打开时装、退出时装都等它。
    const updateAccountProbe: Promise<WindowsElevationCapability> = process.platform === 'win32'
      ? inspectWindowsElevationCapability({ timeoutMs: 3_000 })
      : Promise.resolve('unknown')
    let updateAccount: WindowsElevationCapability | null = null
    // 退出时自动装写下的「试过了」：Mac 关机抢在安装器装完之前时撤回（见 onPowerOff）。
    let quitInstallAttempt: QuitInstallAttempt | null = null
    const { updaterService, serviceStatusMonitor, accelerationNodes, cliModelsAtLaunch } = updateFeed.createUpdater({
      managerDataDirectory,
      runtimeLog,
      systemService,
      chromiumSessionFetch,
      installedRelease,
      unsignedChannel,
      pendingUpdateAtLaunch,
      releaseGuardStore,
      releaseGuardAtLaunch,
      updateQuitHandoff: () => updateQuitHandoff,
      setToolRouteRewriteMode: (mode) => { toolRouteRewriteMode = mode },
    })
    // 分组对照跟着服务状态文件走：正在读就等这一次读完，不为它另发请求；这次没读到就用上一次读成功的那份。
    async function readAccountGroupHints(): Promise<AccountGroupHints | null> {
      if (!serviceStatusMonitor) return null
      await serviceStatusMonitor.settled()
      return serviceStatusMonitor.lastKnown()?.accountGroups ?? null
    }
    // 同上但不等：这次启动还没读成过就是 undefined，说不准对照改没改（account-cli-provisioner.ts，#1157 第 8 条）。
    function peekAccountGroupHints(): AccountGroupHints | null | undefined {
      if (!serviceStatusMonitor) return null
      const known = serviceStatusMonitor.lastKnown()
      return known ? known.accountGroups ?? null : undefined
    }
    // 型号表跟分组对照一样等这一次读完：默认型号、上一代、下架名单。这次打开以后一次也没读成功过，
    // 就用上次记下的那份；从来没读成功过才用程序自带的（cli-model-defaults.ts）。
    async function readCliModelHints(): Promise<CliModelHints | null> {
      if (!serviceStatusMonitor) return null
      await serviceStatusMonitor.settled()
      return resolveCliModelHints(serviceStatusMonitor.lastKnown(), cliModelsAtLaunch)
    }
    let periodicUpdateTimer: NodeJS.Timeout | null = null
    let applicationTray: ApplicationTrayController | null = null
    let trayAcceleration: TrayAccelerationCoordinator | null = null
    let accelerationExpiry: AccelerationExpiryNotice | null = null
    // 终端里的 Claude Code / Gemini CLI 出错、做完、等人时由钩子留下记录，这里读出来发
    // 系统通知。窗口没开着也照读：人走开的时候恰恰是最需要提醒的时候。
    // 同一份记录也用来在工具干活时挡住自动睡眠，做完、出错、退出就放开。
    const cliKeepAwake = createCliKeepAwake({
      blocker: powerSaveBlocker,
      log: (level, event, message, detail) => runtimeLog.log(level, 'config', event, message, detail),
      // 托盘那行「暂不让电脑自动睡眠」跟着换（已知35）。
      onChange: () => applicationTray?.updateSnapshot(),
    })
    const cliHookEvents = createCliHookEventMonitor({
      directory: cliHookEventsDirectory(managerDataDirectory),
      notify: (terminal, eventKey) => { hostNotifier()({ terminal, eventKey }) },
      onEvent: (event) => cliKeepAwake.observe(event),
      log: (level, event, message, detail) => runtimeLog.log(level, 'config', event, message, detail),
    })
    cliHookEvents.start()
    // 装工具、装 Codex 桌面端、后台下载新版本时同样挡住自动睡眠，装完、失败、取消就放开。
    const installKeepAwake = createInstallKeepAwake({
      blocker: powerSaveBlocker,
      log: (level, event, message, detail) => runtimeLog.log(level, 'main', event, message, detail),
      onChange: () => applicationTray?.updateSnapshot(),
    })
    const unsubscribeInstallKeepAwakeQueue = systemService.onInstallationQueueChange((snapshot) => installKeepAwake.observeQueue(snapshot))
    installKeepAwake.observeQueue(systemService.inspectInstallationQueue())
    const unsubscribeInstallKeepAwakeUpdate = updaterService.subscribe((state) => installKeepAwake.observeUpdate(state))
    installKeepAwake.observeUpdate(updaterService.getState())
    let accelerationInterruption: AccelerationInterruptionNotice | null = null
    let latestTraySystem: SystemSnapshot | null = null
    let latestTrayBalance: AccountBalance | null = null
    let latestTraySubscription: AccountSubscriptionSelf | null = null
    let managedMainWindow: BrowserWindow | null = null
    // 缩到托盘久了关掉界面省内存（renderer-release.ts）；主窗口建好以后接上。
    let mainRendererRelease: RendererRelease | null = null
    // 界面最后一次读到的公告：界面关着时主进程拿它比对有没有新公告（released-renderer-watch.ts）。
    let lastRendererNotice: string | null = null
    // 账号状态、付款结果（带订单号）、更新状态只发给主窗口（#1069）。画布跑第三方前端代码，
    // 支付窗口装的是支付商的网页，两边都不靠这几条：画布换账号听自己的 canvas-host:account-changed，
    // 支付窗口没挂 preload，付完由主进程判断、自己关。挨个窗口发只是把订单号和账号送到它们手边。
    const sendToMainWindow = <Event extends keyof XingmangEventContract>(event: Event, payload: IpcEventPayload<XingmangEventContract[Event]>) => {
      const window = managedMainWindow
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      // 界面关着没人接；重新加载好了它会自己把这些状态读一遍。
      if (mainRendererRelease?.state === 'released') return
      window.webContents.send(ipcEventChannels[event], payload)
    }
    // 跳页、打开工具、外部链接要界面接住才算数：界面关着、正在重新加载时先存着，好了再发。
    const deliverToMainWindow = <Event extends 'onNavigate' | 'onLaunchTool' | 'onExternalDeepLink'>(event: Event, payload: IpcEventPayload<XingmangEventContract[Event]>) => {
      const send = () => sendToMainWindow(event, payload)
      if (mainRendererRelease) mainRendererRelease.deliver(event, send)
      else send()
    }
    diagnostics.attachFeedbackDescribers({ latestTraySystem: () => latestTraySystem })
    const desktopNotifications = createDesktopNotificationController({
      readEnabled: () => systemService.readStoredConfig().desktopNotifications !== false,
      focusMainWindow: () => {
        if (!managedMainWindow || managedMainWindow.isDestroyed()) return
        if (managedMainWindow.isMinimized()) managedMainWindow.restore()
        managedMainWindow.show()
        managedMainWindow.focus()
      },
      onOpenUpdates: () => { deliverToMainWindow('onNavigate', 'updates') },
      onError: (error) => runtimeLog.exception('window', 'notification.failed', error),
      iconPath: path.join(app.getAppPath(), 'assets', 'brand', 'v3', 'app-icon.png'),
      readAutoUpdate: () => updaterService.autoUpdateEnabled(),
    })
    const unsubscribeDesktopNotifications = updaterService.subscribe((state) => desktopNotifications.handleUpdate(state))
    // 开机拉起时检测工具、检查更新、账号 Key 初始化这几件后台事都往后挪：窗口第一次显示或满
    // 3 分钟才开始（见 login-launch.ts）。加速要还原的系统代理不在其中，照原来的顺序先做。
    // 开机自启时在后台装新版、安装器重新拉起的那一次也照开机拉起办：装之前它就待在后台。
    const launchedAtLogin = relaunchedAfterBackgroundInstall || resolveLoginLaunch({
      platform: process.platform,
      argv: process.argv,
      wasOpenedAtLogin: () => app.getLoginItemSettings().wasOpenedAtLogin,
    })
    // 打开时装只认开始查更新之后两分钟内下好的（LAUNCH_INSTALL_WINDOW_MS）：开机拉起的安静期
    // 里不查（update:startup 等它结束），两分钟从安静期结束才开始算。
    let launchInstallClockFrom: number | null = launchedAtLogin ? null : Date.now()
    // 开机拉起、窗口一直没打开过的，打开时装改在后台装（resolveLaunchInstallMode）。
    let mainWindowShown = false
    const startupQuiet = createLoginQuietPeriod({
      active: launchedAtLogin,
      durationMs: loginQuietPeriodMs,
      onEnd: (reason) => {
        launchInstallClockFrom = Date.now()
        runtimeLog.log('info', 'main', 'launch.quiet-ended', reason === 'window-shown' ? '开机安静期结束：窗口已打开' : '开机安静期结束：已到时间', { reason })
      },
    })
    if (relaunchedAfterBackgroundInstall) {
      runtimeLog.log('info', 'updater', 'install.background.relaunched', '后台装新版本后重新打开，照旧待在后台', {
        version: pendingUpdateAtLaunch.backgroundInstall?.version ?? null,
        current: app.getVersion(),
      })
    }
    // 后台装没走到安装器重新拉起那一步（这次不装了、没装成、装的时候用户点开了窗口）：撤回
    // 那条记录，不然之后用户自己退出再打开，会被当成重新拉起的那一次，窗口出不来。
    const dropBackgroundInstall = () => {
      if (!pendingUpdateRecord.backgroundInstall) return
      pendingUpdateRecord = { ...pendingUpdateRecord, backgroundInstall: null }
      void pendingUpdateStore.write(pendingUpdateRecord).catch((cause: unknown) => {
        runtimeLog.exception('updater', 'pending.record-failed', cause)
      })
    }
    // 装的时候弹不弹窗口（Mac 闲时装的前提）：解符号链接、试两处能不能写，跳框器每两秒问一次，
    // 同一种装法一分钟内只算一次（0.2.22 性能体检第 7 条）。
    const installUnattended = memoizeUnattendedInstall((installMethod) => canInstallUnattended({
      platform: process.platform,
      installMethod,
      bundlePath: installLocation ? null : resolveMacAppBundlePath(process.execPath),
    }))
    // 自动更新：上一次运行已经下好的版本，这次一打开就装上（见 auto-update-install.ts）。
    let launchInstallTried = false
    // Windows 上开机自启、窗口没打开过、开机时没装的那一版（'window'）：等第一次打开窗口再装。
    // 电脑闲下来时跳框先问了的，就撤下（withdrawLaunchInstall）。
    let launchInstallAwaitingWindow: string | null = null
    const startLaunchInstall = (version: string, mode: Exclude<LaunchInstallMode, 'skip'>) => {
      const background = mode === 'background'
      const stillInstallable = () => shouldStillInstallAtLaunch({
        version,
        autoUpdate: updaterService.autoUpdateEnabled(),
        snapshot: updaterService.getState(),
        busy: resolveInterruptibleInstallTask(systemService.inspectInstallationQueue()) !== null,
        mode,
        windowShown: mainWindowShown,
        accelerationActive: acceleration?.hasPossibleSession() === true,
      })
      // 等到第一次打开窗口才装的，离开机可能已经过了几个小时，预告之前先看一眼。
      if (mode === 'window' && !stillInstallable()) {
        runtimeLog.log('info', 'updater', 'install.on-launch.skipped', `第一次打开窗口时先不装 ${version}，留到退出时再装`, {
          autoUpdate: updaterService.autoUpdateEnabled(),
          accelerationActive: acceleration?.hasPossibleSession() === true,
        })
        return
      }
      if (mode === 'background') {
        runtimeLog.log('info', 'updater', 'install.on-launch.background', `开机自启、窗口没打开过，在后台装上次下好的 ${version}，装好照旧待在后台`)
      } else if (mode === 'window') {
        runtimeLog.log('info', 'updater', 'install.on-launch.window-shown', `开机自启后第一次打开窗口，先预告再装上次下好的 ${version}`)
      } else {
        runtimeLog.log('info', 'updater', 'install.on-launch', `上次已下载好 ${version}，启动时自动安装`)
      }
      // 后台装的另记一笔：安装器装好重新拉起新版本时，照它认出那一次，照旧待在后台。
      pendingUpdateRecord = {
        ...pendingUpdateRecord,
        attemptedVersion: version,
        ...(background ? { backgroundInstall: { version, startedAt: Date.now() } } : {}),
      }
      // 先把「试过了」写稳再装：安装器起不来时，下次打开不会再试同一个版本。装之前先发
      // 一条系统通知、等几秒：窗口刚出来就自己关掉、再凭空弹出授权窗口，看着像闪退中毒。
      // 后台装的没人在看，不预告也不等。
      void pendingUpdateStore.write(pendingUpdateRecord).then(async () => {
        if (!background) {
          const notice = buildAutoInstallNotice(version, 'launch', process.platform, windowsCliExecution.highIntegrity === true)
          desktopNotifications.announce(notice)
          // 系统通知在专注助手、关了通知的电脑上会被静默吞掉，窗口里同时摆一张同样说法的卡。
          updaterService.setLaunchInstallNotice({ version, ...notice, installAt: Date.now() + LAUNCH_INSTALL_NOTICE_MS })
          await new Promise((resolve) => { setTimeout(resolve, LAUNCH_INSTALL_NOTICE_MS).unref() })
        }
        if (!stillInstallable()) {
          updaterService.setLaunchInstallNotice(null)
          dropBackgroundInstall()
          runtimeLog.log('info', 'updater', 'install.on-launch.skipped', `启动时自动安装 ${version} 前情况变了，留到退出时再装`)
          return
        }
        updaterService.install()
      }).catch((cause: unknown) => {
        updaterService.setLaunchInstallNotice(null)
        dropBackgroundInstall()
        runtimeLog.exception('updater', 'install.on-launch.failed', cause)
      })
    }
    const considerLaunchInstall = (state: UpdateSnapshot) => {
      // 退出交接还没接上时（主窗口没建好）不装：那时安装器发起的退出会被当成用户关窗。
      // 开机拉起的安静期还没过时，两分钟也还没开始算。账号是不是管理员还没问出来时也先不定，
      // 问出来以后再看一遍（见下面 updateAccountProbe）。
      if (launchInstallTried || !updateQuitHandoff || launchInstallClockFrom === null || updateAccount === null) return
      const version = decideLaunchInstall({
        autoUpdate: updaterService.autoUpdateEnabled(),
        snapshot: state,
        recordAtLaunch: pendingUpdateAtLaunch,
        elapsedSinceLaunchMs: Date.now() - launchInstallClockFrom,
        busy: resolveInterruptibleInstallTask(systemService.inspectInstallationQueue()) !== null,
        standardAccount: updateAccount === 'standard',
      })
      if (!version) return
      launchInstallTried = true
      const accelerationActive = acceleration?.hasPossibleSession() === true
      const unattended = installUnattended(state.installMethod)
      const mode = resolveLaunchInstallMode({ platform: process.platform, launchedAtLogin, windowShown: mainWindowShown, accelerationActive, unattended })
      if (mode === 'skip' || mode === 'window') {
        if (mode === 'window') launchInstallAwaitingWindow = version
        runtimeLog.log('info', 'updater', 'install.on-launch.held', mode === 'window'
          ? `开机自启、窗口没打开过，${version} 开机时不装，等第一次打开窗口时先预告再装`
          : `开机自启、窗口没打开过，${version} 开机时不装，留到退出时再装`, { accelerationActive, unattended })
        return
      }
      startLaunchInstall(version, mode)
    }
    // 跳框问过了就不再走打开时装（update-install-prompt.ts，#1410）：等着开窗口的那一版，跳框叫出
    // 窗口时别再预告装一遍；两分钟里还没轮到的，也别在客户回答前后自己装起来。点了「稍后再说」的
    // 照框里说的，退出或下次打开时装。
    const withdrawLaunchInstall = () => {
      const awaiting = launchInstallAwaitingWindow
      launchInstallTried = true
      launchInstallAwaitingWindow = null
      if (awaiting) runtimeLog.log('info', 'updater', 'install.on-launch.withdrawn', `开机时留着等开窗口的 ${awaiting} 交给跳框问了，第一次打开窗口时不再预告装`)
    }
    const unsubscribeAutoUpdateInstall = updaterService.subscribe((state) => {
      const downloaded = resolveDownloadedVersionToRecord(state, pendingUpdateRecord)
      if (downloaded) {
        pendingUpdateRecord = { ...pendingUpdateRecord, downloadedVersion: downloaded }
        void pendingUpdateStore.write(pendingUpdateRecord).catch((cause: unknown) => {
          runtimeLog.exception('updater', 'pending.record-failed', cause)
        })
      }
      if (isBackgroundInstallFailed(pendingUpdateRecord, state)) {
        runtimeLog.log('info', 'updater', 'install.background.failed', '后台安装没装成，留到退出时再装')
        dropBackgroundInstall()
      }
      considerLaunchInstall(state)
    })
    void updateAccountProbe.then((account) => {
      updateAccount = account
      if (account === 'standard') {
        runtimeLog.log('info', 'updater', 'install.standard-account', '这台电脑的账号不是管理员：下好的新版本不自动装，等有管理员账号的人在「设置 › 版本更新」点「重启并安装」')
        // 界面据此改说要管理员密码。
        updaterService.setInstallNeedsAdminPassword(true)
      } else if (account === 'unknown' && process.platform === 'win32') {
        runtimeLog.log('warn', 'updater', 'install.account-unknown', '没问出这台电脑的账号是不是管理员，照旧自动装更新')
      }
      // 下好的版本可能在问出来之前就摆出来了，那一下没定下来，问出来以后再看一遍。
      considerLaunchInstall(updaterService.getState())
    }).catch((cause: unknown) => {
      runtimeLog.exception('updater', 'install.account-check-failed', cause)
    })
    const urlPolicy = applicationUrlPolicy()
    registerApplicationProtocol(urlPolicy)
    const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'

    const { credentialPersistence, accountSessionStore, savedAccounts, vault } = createAccountStorage({
      managerDataDirectory,
      runtimeLog,
      linuxPasswordStore,
      mainWindow: () => managedMainWindow,
    })
    const accountIdentity = createAccountIdentityTracker()
    let acceleration: ReturnType<typeof createAccelerationService> | undefined
    async function accelerationRunning(): Promise<boolean> {
      const scope = readAccelerationAccountScope()
      if (!scope || !acceleration) return false
      // 加速在等上一个星芒交出网络设置时读状态要陪着等最多半分钟：这里只问开没开（绕不绕代理、导出诊断），
      // 不等，按「可能开着」答，同以前当场报错时的结论（0.2.22 回归第 10 条）。
      if (acceleration.awaitingPreviousOwner()) return true
      const { phase } = await acceleration.getAccelerationState(scope)
      return phase === 'active' || phase === 'connecting' || phase === 'stopping'
    }
    const createAccountClient = createAccountClientFactory({ vault, routes: networkRoutes, runtimeLog })
    const accounts = createRealmAccountService({
      vault,
      createClient: createAccountClient,
      // The old files can only be read with the OS key; in session-only mode
      // there is nothing to import them into anyway.
      legacy: credentialPersistence === 'durable' ? { list: () => savedAccounts.list(), getSession: (id, origin) => savedAccounts.getSession(id, origin),
        readActive: () => accountSessionStore.read() } : undefined,
      quiesce: async () => {
        // 排在安装后面还没轮到的「打开」当场出队，不陪前面的安装等到超时（#1085）。
        accountWork.abortQueued()
        await acceleration?.stopAll()
        const previous = businesses.get(accounts.getSiteId())
        previous?.chatService.cancelAll()
        previous?.imageService.cancelAll()
        previous?.canvasImageService.cancelAll()
        previous?.videoService.cancelAll()
        previous?.chatVideoService.cancelAll()
        previous?.canvasRuns.shutdown()
        paymentWindow.destroy()
        // 补设置那次还在本机看工具开没开的，不陪它等 PowerShell 跑完；叫停管到下面这段等完，
        // 晚一步才开始的那次也不等（system-service.ts 的 stopTemplateFillWaits）。
        const resumeTemplateFill = systemService.stopTemplateFillWaits?.()
        try {
          await Promise.all([accountWork.whenIdle(), ...(previous ? [previous.chatService.whenIdle(),
            previous.imageService.whenIdle(), previous.canvasImageService.whenIdle(), previous.videoService.whenIdle(),
            previous.chatVideoService.whenIdle(),
            previous.canvasRuns.whenIdle()] : [])])
        } finally {
          resumeTemplateFill?.()
        }
      },
      onChanged: (siteId, state) => {
        const identity = buildAccountIdentity(siteId, state.account?.userId, accounts.client.getSessionRevision!())
        sendToMainWindow('onAccountSessionChanged', state)
        if (!accountIdentity.advance(identity)) return
        // 只在换了人时才让加速作废在路上的请求：续期换凭据、付款后刷新也会走到这里，
        // 那时推进加速的代数会让正在查的状态报「账号已变更」，查询途中还会把正在跑的加速停掉。
        void acceleration?.onAccountChanged().catch((error) => runtimeLog.exception('network', 'acceleration.account-change.failed', error))
        for (const business of businesses.values()) {
          business.chatService.cancelAll()
          business.imageService.cancelAll()
          business.canvasImageService.cancelAll()
          business.videoService.cancelAll()
          business.chatVideoService.cancelAll()
          business.canvasRuns.shutdown()
        }
        latestTrayBalance = null
        latestTraySubscription = null
        trayAcceleration?.reset()
        accelerationExpiry?.reset()
        accelerationInterruption?.reset()
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
          if (siteId === 'solov') {
            void current.videoService.resumeUser(userId).catch((error) => runtimeLog.exception('canvas', 'video.resume.failed', error))
            // 对话页、视频剪辑页上次关掉时还在出的视频：取回来放进作品库。
            void current.chatVideoService.resumeUser(userId).catch((error) => runtimeLog.exception('ai-chat', 'video.resume.failed', error))
          }
        }
      },
    })
    readAccountSiteId = () => accounts.getSiteId()
    // 只有星芒账号的站有代取服务；历史账号的客户端没有这个方法。票只在主进程里用。
    issueCodexStartupTicket = async () => {
      if (accounts.getSiteId() !== 'solov') throw new Error('当前账号没有 Codex 中文启动通道')
      const issue = accounts.client.issueCodexStartupTicket
      if (!issue) throw new Error('当前账号没有 Codex 中文启动通道')
      return issue()
    }
    const accountService = accounts.client
    // 余额跌破 5 美元、余额到了 $0、花费突然变多这几条提醒由主进程判断（balance-alerts.ts），界面关着时也照样提醒。
    const balanceAlerts = createBalanceAlerts({
      notify: (kind, eventKey, notice) => { hostNotifier()({ activity: kind, eventKey, ...(notice ? { detail: notice } : {}) }) },
      readBaseline: () => readSpendBaseline({
        dateOnly: accounts.getSiteId() === 'solov-api',
        getUsage: (query) => accountService.getUsage(query),
      }),
      ...createSpendSpikeRecordStore(managerDataDirectory),
      emptyRecord: createEmptyBalanceRecordStore(managerDataDirectory),
      // 客户正看着星芒（新手引导、首页都在说余额为零，付款窗口开着也算）时余额用完那条先不弹，等窗口不在前台时读到余额再说。
      holdEmptyNotice: () => BrowserWindow.getFocusedWindow() !== null,
    })
    // 托盘余额和几条余额提醒跟着同一份走：界面读到的（account:get-balance），和界面关着时主进程自己读的。
    const observeAccountBalance = (balance: AccountBalance) => {
      latestTrayBalance = balance
      applicationTray?.updateSnapshot()
      const state = accountService.getSessionState()
      if (!state.authenticated || !state.account) return
      const siteId = accounts.getSiteId()
      const at = Date.now()
      void balanceAlerts.observe({
        scope: `${siteId}:${state.account.userId}`,
        userId: state.account.userId,
        quota: balance.quota,
        quotaPerUnit: balance.quotaPerUnit,
        at,
        supportsUsage: accountService.capabilities.supportsUsage,
        // 订阅跟着余额读回来以后才读（界面那边），换账号时清空：还没读到就是 null，不当作没有。
        subscribed: !accountService.capabilities.supportsSubscriptions ? false
          : latestTraySubscription === null ? null
            : resolveUsableSubscription(latestTraySubscription, { now: at, quotaPerUnit: balance.quotaPerUnit }) !== null,
      }).catch((cause: unknown) => runtimeLog.exception('account', 'balance-alert.failed', cause))
    }
    readBillingAccountScope = () => {
      const state = accountService.getSessionState()
      const realm = accounts.getSiteId() === 'solov-api' ? 'api-account' : 'xm-account'
      return `${realm}:${state.authenticated && state.account ? state.account.userId : 'guest'}`
    }
    runtimeLog.attachAccountDescriber(() => {
      const state = accountService.getSessionState()
      return { authenticated: state.authenticated && Boolean(state.account), userId: state.account?.userId }
    })
    // 外部客户端归属记在谁名下：站点加 userId。换账号以后认上一个账号那份（已知37）也照这个写法拼。
    function externalClientOwner(siteId: string, userId: number): string {
      return JSON.stringify([siteId, userId])
    }
    readExternalClientAccountId = () => {
      const state = accountService.getSessionState()
      return state.authenticated && state.account ? externalClientOwner(accounts.getSiteId(), state.account.userId) : null
    }
    // 匿名使用统计（usage-stats.ts，yoyo 10-26 选的「推荐档」）：每天最多发成一次版本、系统、装了哪些工具、
    // 更新和安装成没成功、卡住几次，不带账号和电脑编号。开关是设置「隐私数据」里的「匿名使用统计」，
    // 存在系统界面设置那份文件里；读不出来按关算，同崩溃上报。
    const platformPreferencesPath = path.join(app.getPath('userData'), 'platform-settings.json')
    const usageStatsEnabled = (): boolean => {
      let preference: boolean | undefined
      try {
        preference = new PlatformSettingsStore(platformPreferencesPath).read().privacy?.anonymousUsage
      } catch {
        return false
      }
      return shouldSendUsageStats({
        packaged: app.isPackaged,
        localBuild: applicationPackage.xingmangLocalBuild === true,
        env: process.env,
        preference,
      })
    }
    const usageStats = createUsageStatsReporter({
      filePath: path.join(managerDataDirectory, 'usage-stats.json'),
      isEnabled: usageStatsEnabled,
      collect: async () => {
        const siteId = accounts.getSiteId()
        const accountState = accountService.getSessionState()
        // 只读首页检测已经拿到的：没有就拿上次落盘的那份，都没有就写「没检测到」，不另起检测。
        const scan = latestTraySystem
          ?? await (systemService.recentScan(24 * 60 * 60 * 1000) ?? systemService.cachedScan({ startScan: false })).catch(() => null)
        const externalClients = systemService.getLastExternalClients() ?? await systemService.cachedExternalClients().catch(() => [])
        return {
          appVersion: app.getVersion(),
          os: resolveUsageOs({
            platform: process.platform,
            release: os.release(),
            systemVersion: process.platform === 'darwin' ? process.getSystemVersion() : null,
          }),
          arch: process.arch,
          account: usageAccountKind(siteId, accountState.authenticated && Boolean(accountState.account)),
          route: usageRouteChoice(relayRouting, siteId),
          autoUpdate: systemService.readStoredConfig().autoUpdate !== false,
          update: resolveUsageUpdateState(pendingUpdateRecord, app.getVersion()),
          tools: usageToolInventory(scan, externalClients),
        }
      },
      fetchImpl: (url, init) => chromiumSessionFetch(session.defaultSession)(url, init),
      onSendFailure: (error) => {
        const reason = classifyNetworkFailure(error)
        runtimeLog.log('info', 'usage-stats', 'send.failed', '匿名使用统计这次没发出去，过一会儿再试', reason ? { networkFailure: reason } : undefined)
      },
      onLocalFailure: (error) => { runtimeLog.exception('usage-stats', 'local.failed', error) },
    })
    noteUsageEvent = (event) => { usageStats.record(event) }
    if (unexpectedExit) usageStats.record({ kind: 'hang', hang: 'unexpectedExit' })
    usageStats.start()
    // 设置里一关就删掉本机攒的计数（方案第 5 节「关掉后立刻停，计数文件一起删掉」），不等最多 6 小时后的那次定时检查。
    const detachPrivacyListener = attachPrivacyChangeListener((kind, enabled) => {
      if (kind === 'anonymousUsage' && !enabled) void usageStats.discard()
    })
    // 只在星芒有窗口在前台时量主进程卡没卡住：后台被系统放慢的不算，也不在后台空转。
    const mainStallMonitor = createMainStallMonitor({ onStall: () => { usageStats.record({ kind: 'hang', hang: 'stall' }) } })
    const resumeStallMonitor = () => { mainStallMonitor.resume() }
    const pauseStallMonitor = () => { mainStallMonitor.pause() }
    app.on('browser-window-focus', resumeStallMonitor)
    app.on('browser-window-blur', pauseStallMonitor)
    // 最先停：后面那些步骤退出时报的错、窗口没响应都不算客户碰到的。
    quitCleanup.add('usage-stats', () => {
      app.off('browser-window-focus', resumeStallMonitor)
      app.off('browser-window-blur', pauseStallMonitor)
      mainStallMonitor.stop()
      detachPrivacyListener()
      usageStats.stop()
      noteUsageEvent = null
    })
    let lastUpdateForUsage: UsageUpdateView | null = null
    const accountWork = createAccountWorkGate({ assertReady: accounts.assertReady, revision: () => accountService.getSessionRevision!() })
    const { businesses, ensureBusiness, subscribeCanvasRuns } = createRealmBusinesses({
      managerDataDirectory,
      projectRoot: path.join(__dirname, '..'),
      accounts,
      mainWindow: () => managedMainWindow,
      credentialPersistence,
      systemService,
      readAccountGroupHints,
      readDocumentsDirectory,
      runtimeLog,
      sessionFetch,
      routedRelayFetch,
    })
    // Construct each realm on first access. The initial realm is still the
    // account service's default until restoreActive completes below.
    ensureBusiness(accounts.getSiteId())
    const currentBusiness = () => ensureBusiness(accounts.getSiteId())
    const accountCredentialStore = createRealmServiceDispatch(() => currentBusiness().accountCredentialStore)
    const managedCliKeyStore = createRealmServiceDispatch(() => currentBusiness().managedCliKeyStore)
    // Claude Desktop 跟着 Claude Code 换 Key 时读（#1113）：只读当前账号、当前站的那份缓存。
    readCurrentManagedCliKeys = async () => {
      const state = accountService.getSessionState()
      return state.authenticated && state.account ? managedCliKeyStore.read(state.account.userId) : []
    }
    // 换了账号以后外部客户端跟着换 Key 时读（已知37）：当前站别的账号的那份缓存。
    readOtherManagedCliKeyAccounts = async () => {
      const state = accountService.getSessionState()
      if (!state.authenticated || !state.account) return []
      const siteId = accounts.getSiteId()
      const others = await managedCliKeyStore.readOtherAccounts(state.account.userId)
      return others.map((entry) => ({ owner: externalClientOwner(siteId, entry.userId), keys: entry.keys }))
    }
    const chatKeyStore = createRealmServiceDispatch(() => currentBusiness().chatKeyStore)
    const chatCredentials = createRealmServiceDispatch(() => currentBusiness().chatCredentials)
    const assetStore = createRealmServiceDispatch(() => currentBusiness().assetStore)
    const chatAttachments = createRealmServiceDispatch(() => currentBusiness().chatAttachments)
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
    const chatVideoService = createRealmServiceDispatch(() => currentBusiness().chatVideoService)
    const canvasRuns = createRealmServiceDispatch(() => currentBusiness().canvasRuns)
    // Run subscriptions outlive a selected realm, so keep them attached to
    // every store, including stores created lazily after the initial render.
    canvasRuns.subscribe = subscribeCanvasRuns
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
      onTerminalState: (event, context) => {
        runtimeLog.log('info', 'payment', context.afterClose ? 'order.follow-up' : 'window.terminal',
          context.afterClose ? '支付窗口关闭后在后台确认到了订单结果' : '支付窗口已进入终态并自动关闭', {
            status: event.status,
            hasTradeNo: Boolean(event.tradeNo),
            ...(event.confirming ? { confirming: true } : {}),
          })
        sendToMainWindow('onAccountPaymentWindowTerminal', event)
        // 关窗后才到账：人多半已经去干别的了。正看着星芒时界面上那条提示自己会变，不再弹。
        if (context.afterClose && event.status === 'success' && event.tradeNo) {
          const main = managedMainWindow
          const watching = Boolean(main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused())
          if (!watching) {
            try {
              hostNotifier()({
                event: 'paymentSettled',
                eventKey: event.tradeNo,
                onClick: () => { deliverToMainWindow('onNavigate', 'topup') },
              })
            } catch (cause) {
              runtimeLog.exception('payment', 'settled.notify-failed', cause)
            }
          }
        }
      },
    })

    // Normalize the effective record (file, .bak, or defaults) through the same
    // serialized queue as every other settings write, but only touch the disk
    // when the file actually differs. A full disk or an antivirus lock used to
    // throw here and end startup before any window existed; now the app opens
    // on the record it could read and the window tells the user once.
    try {
      await settingsStore.normalize()
    } catch (error) {
      settingsSaveIssue = { kind: classifyStorageFailure(error) ?? 'other', drive: dataDriveLetter(managerDataDirectory) }
      runtimeLog.exception('config', 'settings.normalize.failed', error, { kind: settingsSaveIssue.kind })
    }
    const bundledXingmangAiSkillRoot = resolveXingmangAiBundledSkillRoot(app.getAppPath(), {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    void installXingmangAiSkillFiles(bundledXingmangAiSkillRoot, os.homedir(), {
      officialCodex: (systemService.readStoredConfig().officialProviders ?? []).includes('codex'),
      serializeConfigWrite: systemService.serializeToolConfigWrite,
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
    const accountRestore = accounts.restoreActive()
    const accountSessionReady = accountRestore.then(() => undefined).catch((error) => {
      runtimeLog.exception('account', 'session.restore.failed', error)
    })
    if (startupQuiet.active()) {
      runtimeLog.log('info', 'main', 'launch.quiet-started', '开机自动启动，检测和更新稍后再做', { durationMs: loginQuietPeriodMs })
      // 托盘在安静期里先用上次落盘的检测结果（能打开哪些工具），真扫描回来再换掉。
      void systemService.cachedScan({ startScan: false }).then((cached) => {
        if (cached && !latestTraySystem) { latestTraySystem = cached; applicationTray?.updateSnapshot() }
      }).catch(() => undefined)
    }
    // 首页那遍扫描不必等窗口和启动画面：和账号恢复一起现在就跑起来，渲染层随后那次读取
    // 直接接上它（scanSystem 同一时刻只跑一轮）。结果由那次读取照常交给托盘与日志。
    // 只在有账号要恢复时预热：没有账号的新用户先落在欢迎页，那里本来不检测工具；而
    // Windows 上一轮检测要起好几段 PowerShell，白跑一轮只是给欢迎页添负担。这几段
    // 权限检查已经先异步探测再读缓存（primeTrustedWindowsMachinePath），不占主线程。
    void startupQuiet.whenOver().then(() => vault.active()).then((saved) => {
      if (saved) void systemService.scanSystem().catch(() => undefined)
    }).catch(() => undefined)
    // 以前装到一半被关掉留下的下载没人认领，低配电脑的 C 盘会被它慢慢吃掉。安静期过后再
    // 等一会儿，让开机那一阵的检测先跑完，再在后台清；不弹提示，只记日志。
    void startupQuiet.whenOver().then(() => new Promise<void>((resolve) => {
      setTimeout(resolve, installLeftoverStartupDelayMs).unref()
    })).then(() => systemService.cleanupInstallLeftovers()).catch(() => undefined)
    // 本软件写给 Codex 的型号名单读不进时 Codex 整个起不来（星芒关着的时候命令行或桌面端
    // 换成了旧版）：开机在本机看一眼，没登录的也看；登录状态下开机那轮按账号同步共用这一次。
    void startupQuiet.whenOver().then(() => systemService.guardCodexModelCatalogAtStartup?.()).catch(() => undefined)
    // Gemini CLI 下线后，星芒以前写进它配置的做完提醒和画图没人维护了，开机后在后台收回。
    void startupQuiet.whenOver().then(() => systemService.reclaimRetiredToolIntegrations?.()).catch(() => undefined)
    // 启动画面最多为账号恢复等 3 秒，明确断网就不等（yoyo 2026-09-22 拍板）。
    const accountStartupGate = createAccountStartupGate({
      settled: accountSessionReady,
      budgetMs: 3000,
      offline: !net.isOnline(),
      restoringAccount: () => accounts.restoringAccount(),
    })
    // 联不上、服务维护、超时都不算登录失效：登录留在本机，隔一会儿自己再试。
    const accountRestoreRetry = createAccountRestoreRetry({
      restore: () => accounts.restoreActive(),
      stalled: () => accounts.stalledAccount() !== null,
      onFailure: (error, attempt) => runtimeLog.exception('account', 'session.restore.retry-failed', error, { attempt }),
    })
    // 预算先到时界面拿到的是「正在恢复」。恢复成功会照常发一次会话变化；没恢复
    // 成（没有保存的账号、登录已失效）时账号并没有变化，没人会发，界面就会一直停在
    // 「正在恢复」——这里补发一次。联不上而登录留着时账号服务自己发过了。
    void accountRestore.catch(() => false).then((restored) => {
      accountRestoreRetry.schedule()
      if (restored || accounts.stalledAccount() || !accountStartupGate.releasedEarly()) return
      sendToMainWindow('onAccountSessionChanged', accounts.client.getSessionState())
    })
    const { developmentAcceleration, accelerationBundleDamaged } = createAccelerationHost({
      read: await accelerationConfigRead,
      managerDataDirectory,
      runtimeLog,
      accelerationInterruption: () => accelerationInterruption,
    })
    readAccelerationAccountScope = () => {
      const state = accountService.getSessionState()
      if (!state.authenticated || !state.account) return null
      return `${accounts.getSiteId() === 'solov-api' ? 'api-account' : 'xm-account'}:${state.account.userId}`
    }
    accelerationDownloadRoutes = developmentAcceleration ?? null
    const accelerationServices = createAccelerationServices({
      developmentAcceleration,
      accelerationBundleDamaged,
      accelerationPreferences,
      recheckAccelerationBundle,
      routing: accelerationRouting,
      readAccelerationAccountScope: () => readAccelerationAccountScope(),
      runtimeLog,
      mainWindow: () => managedMainWindow,
      applicationTray: () => applicationTray,
    })
    accelerationExpiry = accelerationServices.accelerationExpiry
    accelerationInterruption = accelerationServices.accelerationInterruption
    acceleration = accelerationServices.acceleration
    const { userAcceleration } = accelerationServices
    trayAcceleration = accelerationServices.trayAcceleration
    // 睡着的那段不计免费时长；醒来看加速还在不在，不在了先恢复网络再提醒。
    if (developmentAcceleration) {
      const accelerationHost = developmentAcceleration
      const accelerationPower = createAccelerationPower({
        suspend: () => accelerationHost.suspend(),
        resume: () => accelerationHost.resume(),
        getAccountScope: () => readAccelerationAccountScope(),
        readState: (scope) => acceleration
          ? acceleration.getAccelerationState(scope)
          : Promise.reject(new Error('加速服务尚未就绪。')),
        log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
      })
      const onSuspend = () => accelerationPower.suspended()
      const onResume = () => accelerationPower.resumed()
      powerMonitor.on('suspend', onSuspend)
      powerMonitor.on('resume', onResume)
      quitCleanup.add('acceleration-power', () => {
        powerMonitor.off('suspend', onSuspend)
        powerMonitor.off('resume', onResume)
      })
    }
    attachProxyBypassState(() => proxyBypass.active(), () => proxyBypass.siteDirect())
    const chatHistoryStore = createAiChatHistoryStore({ root: path.join(managerDataDirectory, 'chat-history') })
    // 下载中大约每秒一份更新快照，界面照收；日志只在阶段、版本、错误变了或进度过了
    // 一档 10% 时记，不然一次下载就把反馈报告附的 600 条挤满（第二十六批 B）。
    const shouldLogUpdateState = createUpdateStateLogFilter()
    // 手机遥控开着就不让电脑自己睡着：人走开了电脑一睡，手机上发消息就没人理（YK-1）。
    const codexRemoteKeepAwake = createCodexRemoteKeepAwake({
      blocker: powerSaveBlocker,
      log: (level, event, message, detail) => runtimeLog.log(level, 'codex-remote', event, message, detail),
      onChange: () => applicationTray?.updateSnapshot(),
    })
    // 手机遥控 Codex：每次打开星芒都从关着开始，客户在设置里点了才连飞书、微信。
    const codexRemote = createCodexRemote({
      managerDataDirectory,
      runtimeLog,
      fetch: chromiumSessionFetch(session.defaultSession),
      appVersion: app.getVersion(),
      homeDirectory: rootedOptions.system.providerRoots.userHome,
      codexEnv: rootedOptions.codexExtensions.env,
      providerRoots: rootedOptions.system.providerRoots,
      windowsExecution: windowsCliExecution,
      onStateChanged: (snapshot) => {
        codexRemoteKeepAwake.observe(snapshot)
        sendToMainWindow('onCodexRemoteStateChanged', snapshot)
      },
    })
    const unregisterIpcHandlers = registerIpcHandlers({
      acceleration: userAcceleration,
      codexRemote,
      realmAccounts: accounts,
      accountWork,
      accountCredentialsForSite: (siteId) => ensureBusiness(siteId).accountCredentialStore,
      savedAccounts,
      systemService,
      providerRoots: rootedOptions.system.providerRoots,
      documentsDirectory: () => app.getPath('documents'),
      aiOutputDirectory: () => currentBusiness().aiOutputPlacement.root,
      desktopDirectory: () => app.getPath('desktop'),
      accountService,
      paymentWindow,
      accountSessionReady,
      accountStartupGate,
      announcementReads: new AnnouncementReadStore(path.join(managerDataDirectory, 'announcement-reads')),
      accountCredentials: accountCredentialStore,
      managedCliKeys: managedCliKeyStore,
      accountGroupHints: readAccountGroupHints,
      peekAccountGroupHints,
      cliModelHints: readCliModelHints,
      keyReplacements: createManagedKeyReplacementStore({ filePath: path.join(managerDataDirectory, 'managed-key-replacements.json') }),
      chatKeyStore,
      chatCredentials,
      chatService,
      imageService,
      aiAssets: assetStore,
      chatAttachments,
      videoService: chatVideoService,
      videoAssets,
      chatHistory: chatHistoryStore,
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
        const usageEvent = usageEventForUpdate(lastUpdateForUsage, snapshot)
        lastUpdateForUsage = snapshot
        if (usageEvent) usageStats.record(usageEvent)
        if (shouldLogUpdateState(snapshot)) {
          runtimeLog.log(snapshot.error ? 'error' : 'info', 'updater', 'state.changed', `主程序更新状态：${snapshot.phase}`, buildUpdateStateLogDetail(snapshot))
        }
        sendToMainWindow('onUpdateState', snapshot)
        applicationTray?.updateSnapshot()
      },
      // 自带 Administrator、关了 UAC、右键以管理员身份运行：装东西不弹授权窗口，界面别说会弹（已知19）。
      windowsProcessElevated: windowsCliExecution.highIntegrity === true,
      getWindowCapabilities: () => ({
        tray: applicationTray?.available ?? false,
        notifications: desktopNotifications.getCapability().supported,
        lowEndDevice,
        ...(settingsSaveIssue ? { settingsSaveIssue } : {}),
        ...(displayCompatPending ? { displayCompat: 'auto' as const } : {}),
        ...(unexpectedExit ? { unexpectedExit } : {}),
        ...(claudeDesktopRepaired ? { claudeDesktopRepaired: true as const } : {}),
        ...(linuxSystemLabel ? { systemLabel: linuxSystemLabel } : {}),
        ...(mainRendererRelease?.restoredBoot ? { rendererRestored: true as const } : {}),
      }),
      onRendererActivity: (target, activity) => {
        if (managedMainWindow && !managedMainWindow.isDestroyed() && target === managedMainWindow.webContents) mainRendererRelease?.reportActivity(activity.busy)
      },
      onAccountNotice: (notice) => { lastRendererNotice = noticeFingerprint(notice) },
      relaunchApp: () => requestRelaunch?.() ?? Promise.resolve(false),
      confirmUpdateInstall: () => confirmUpdateInstall?.() ?? Promise.resolve(true),
      ...(process.platform === 'darwin'
        ? {
            uninstallApp: (request: AppUninstallRequest, backupCliConfigs: () => Promise<void>) => (
              requestMacUninstall?.(request, backupCliConfigs) ?? Promise.reject(new Error('星芒还没准备好，稍后再试'))
            ),
          }
        : {}),
      bypassBrokenProxy: () => proxyBypass.tryBypass(),
      // 固定地址、不经渲染层：系统设置页和系统自己检测门户用的那个网址。普通权限
      // 运行时直接交给系统打开（同 ms-windows-store 那一条）；按管理员身份处理时不替
      // 用户开浏览器，免得浏览器跟着拿到管理员权限，界面改为提示他自己打开网页。
      openNetworkSettings: async (kind) => {
        const target = networkSettingsTarget(process.platform, kind)
        if (!target) return false
        if (kind === 'captive-portal' && windowsCliExecutionMode === 'trusted-only') return false
        await shell.openExternal(target)
        return true
      },
      onSettingsChanged: (update) => {
        if (update.hardwareAcceleration !== undefined) {
          // 用户对显示方式做了选择（设置页开关，或兼容提示里的两颗按钮）：之前的崩溃
          // 有了交代，从头再数；这次启动里也不再提示。
          displayCompatPending = false
          if (displayLaunch) {
            void clearDisplayCrashRecord(displayLaunch.recordPath).catch((cause: unknown) => {
              runtimeLog.exception('display', 'gpu.record.clear-failed', cause)
            })
          }
          runtimeLog.log('info', 'display', 'preference.changed', update.hardwareAcceleration ? '显卡加速显示已打开，重开后生效' : '显卡加速显示已关闭，重开后生效')
        }
        desktopNotifications.refresh()
        void updaterService.autoUpdateChanged().catch((cause: unknown) => {
          runtimeLog.exception('updater', 'auto.download.failed', cause)
        })
      },
      observeOperation: (operation) => {
        const usageEvent = usageEventForOperation(operation)
        if (usageEvent) usageStats.record(usageEvent)
      },
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
      onRouteRecheckRequested: () => recheckRoutes('manual'),
      startupQuiet,
      onAccountBalance: observeAccountBalance,
      onAccountSubscription: (subscription) => { latestTraySubscription = subscription; applicationTray?.updateSnapshot() },
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
        syncImageMcp: async (input) => {
          const nodeExecutable = await findExecutable('node', { env: process.env })
          if (!nodeExecutable) return [XINGMANG_IMAGE_MCP_NO_NODE_WARNING]
          const invocation = buildXingmangImageMcpInvocation(nodeExecutable, input.skillDirectory)
          // 改的是 Codex、Grok 的 config.toml 和 Claude 的 settings.json、.claude.json，和保存配置排同一队（#1061 第 1 条）。
          const register = async () => syncXingmangImageMcpConfigs(rootedOptions.system.providerRoots, invocation, {
            codex: !input.officialCodex,
          }).warnings
          return systemService.serializeToolConfigWrite ? systemService.serializeToolConfigWrite(register) : register()
        },
      },
      ...(manualUninstallVisualFixtureEnabled
        ? {
            transformSystemSnapshot: (snapshot: SystemSnapshot) => (
              withManualUninstallVisualFixture(snapshot, codexContext.userHome)
            ),
          }
        : {}),
    })
    quitCleanup.add('cli-hook-events', () => cliHookEvents.dispose())
    quitCleanup.add('keep-awake', () => {
      cliKeepAwake.dispose()
      unsubscribeInstallKeepAwakeQueue()
      unsubscribeInstallKeepAwakeUpdate()
      installKeepAwake.dispose()
      codexRemoteKeepAwake.dispose()
    })
    quitCleanup.add('routes', () => {
      unsubscribeRelayRoute()
      unsubscribeToolRoutes()
      systemService.disposeToolRoutes?.()
      relayRouteController.dispose()
      // 退出时偏稳：工具线路只停计时器，不做回升（需求 5.1.6）。
      toolRouteController.dispose()
      powerMonitor.off('resume', onRouteResume)
      clearInterval(routeOnlineTimer)
    })
    quitCleanup.add('acceleration-notices', () => {
      accelerationExpiry?.dispose()
      codexDesktopAcceleration.dispose()
      claudeDesktopAcceleration.dispose()
      accelerationInterruption?.dispose()
    })
    // 加速服务、独立加速进程各占一步：前一步同步抛错，也要照样放掉加速进程，由它还原系统代理。
    quitCleanup.add('acceleration', () => {
      void acceleration?.dispose().catch((error) => runtimeLog.exception('network', 'acceleration.shutdown.failed', error))
    })
    quitCleanup.add('acceleration-host', () => {
      void developmentAcceleration?.dispose().catch(() => undefined)
    })
    quitCleanup.add('runtime-log-hooks', () => {
      runtimeLog.log('info', 'main', 'app.stopping', '应用主进程即将退出')
      process.off('uncaughtExceptionMonitor', onUncaughtException)
      process.off('unhandledRejection', onUnhandledRejection)
    })
    quitCleanup.add('updates-and-notifications', () => {
      if (periodicUpdateTimer) clearInterval(periodicUpdateTimer)
      serviceStatusMonitor?.dispose()
      accelerationNodes?.dispose()
      unsubscribeDesktopNotifications()
      unsubscribeAutoUpdateInstall()
      desktopNotifications.dispose()
    })
    quitCleanup.add('ipc', () => unregisterIpcHandlers())
    // 等你同意的一律拒绝，停掉渠道连接和 Codex 进程；放在 IPC 之后，界面不会再点到它。
    quitCleanup.add('codex-remote', () => codexRemote.dispose())
    quitCleanup.add('business-services', () => {
      for (const business of businesses.values()) {
        business.chatService.dispose()
        business.imageService.cancelAll()
        business.canvasImageService.cancelAll()
        business.videoService.cancelAll()
        business.chatVideoService.cancelAll()
        business.canvasRuns.shutdown()
      }
    })
    quitCleanup.add('asset-protocol-and-windows', () => {
      protocol.unhandle('xingmang-asset')
      paymentWindow.destroy()
      canvasController.dispose()
    })
    quitCleanup.add('updater', () => updaterService.dispose())
    // 问不出来也当没有：关窗直接退出、开机自启照常弹窗，窗口不会藏到看不见的地方去。
    const trayHostAvailable = linuxTrayHost ? await linuxTrayHost : true
    if (linuxSystemNameRead) {
      linuxSystemLabel = await linuxSystemNameRead
      runtimeLog.log('info', 'main', 'linux.desktop', trayHostAvailable ? 'Linux 桌面环境' : 'Linux 桌面环境：任务栏上没有放托盘图标的地方，关闭窗口会直接退出', {
        system: linuxSystemLabel,
        ...describeLinuxDesktopSession(process.env),
        waylandIme: linuxImeSwitches.length > 0,
        trayHost: trayHostAvailable,
      })
    }
    attachTrayAvailability(() => applicationTray?.available ?? false)
    const mainWindow = createWindow(systemService, urlPolicy, runtimeLog, () => shouldRevealInitialWindow({
      launchedAtLogin,
      trayAvailable: applicationTray?.available ?? false,
    }))
    managedMainWindow = mainWindow
    mainWindow.once('show', () => {
      mainWindowShown = true
      startupQuiet.end('window-shown')
      // Windows 上开机时没装、等着窗口的那一版：用户点开了窗口，人就在电脑前，先预告再装。
      const awaiting = launchInstallAwaitingWindow
      launchInstallAwaitingWindow = null
      if (awaiting) startLaunchInstall(awaiting, 'window')
    })
    // 后台装到一半用户点开了窗口（托盘、系统通知）：装好重新打开时窗口照常出来。开机自启那次的后台装
    // 和 Mac 的闲时装（多半是窗口开过又缩回去以后才装）都算，所以挂在每一次显示上，不只第一次
    // （0.2.22 发版前回归检查第 5 条）。
    mainWindow.on('show', dropBackgroundInstall)
    // Mac 的安装器打开新版本时会把它切到前台（ShipIt 用 NSWorkspaceLaunchDefault）：没有窗口，
    // 菜单栏却换成了星芒的，这时按 Command + Q 退出的是星芒。后台装完重新拉起、窗口留在
    // 菜单栏的这一次，把前台还给刚才在用的程序。
    if (process.platform === 'darwin' && relaunchedAfterBackgroundInstall) {
      mainWindow.once('ready-to-show', () => {
        if (!mainWindowShown && !mainWindow.isVisible()) app.hide()
      })
    }
    // 拔掉外接显示器时正开着的窗口也挪回来；缩在托盘里的等下次显示时再挪。
    // 稍等一下再看：Windows 自己也会挪一部分窗口，别跟系统抢。
    let displayChangeTimer: ReturnType<typeof setTimeout> | undefined
    const onDisplaysChanged = () => {
      if (displayChangeTimer) clearTimeout(displayChangeTimer)
      displayChangeTimer = setTimeout(() => {
        displayChangeTimer = undefined
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && window.isVisible()) recoverWindowPlacement(window, runtimeLog)
        }
      }, 500)
    }
    screen.on('display-removed', onDisplaysChanged)
    screen.on('display-metrics-changed', onDisplaysChanged)
    quitCleanup.add('display-watch', () => {
      if (displayChangeTimer) clearTimeout(displayChangeTimer)
      screen.removeListener('display-removed', onDisplaysChanged)
      screen.removeListener('display-metrics-changed', onDisplaysChanged)
    })
    const showMainWindow = () => {
      if (mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      reloadIfRendererGone(mainWindow)
    }
    // 以前发给在前面的那个窗口：画布、付款窗口在前时发进了它们，没人接；主窗口缩在托盘里时发到了却不出来（#1210）。
    // 跟托盘跳页一样，先把主窗口叫出来，再只发给它。
    navigateFromAppMenu = (target) => { showMainWindow(); deliverToMainWindow('onNavigate', target) }
    // 退出、重启安装更新都会把正在装的工具打断，两处问同一句（已知31）。true = 点了「仍然退出」。
    const confirmInterruptingInstall = async (task: InterruptibleInstallTask): Promise<boolean> => {
      // 托盘「退出」「重启并安装」时主窗口通常是隐藏的，挂在隐藏窗口上的模态框用户看不见。
      if (!mainWindow.isVisible()) showMainWindow()
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: '关闭星芒AI管理工具', message: '还在安装，现在退出会中断，确定退出？',
        detail: task.count > 1
          ? `${task.description}，另外还有 ${task.count - 1} 项安装排在后面。现在退出会中断它们，已经下载的部分下次要重新来过。`
          : `${task.description}。现在退出会中断它，已经下载的部分下次要重新来过。`,
        buttons: ['继续安装', '仍然退出'],
        defaultId: 0, cancelId: 0,
      })
      return result.response === 1
    }
    // 更新页「确认重启安装」、托盘「重启并安装」：重启会打断正在装、排着队的工具，先问退出时那一句。
    // 点「继续安装」这次就不装，新版本留着，以后再点或下次退出时照常装（已知31）。
    confirmUpdateInstall = async () => {
      if (mainWindow.isDestroyed()) return true
      const task = resolveInterruptibleInstallTask(systemService.inspectInstallationQueue())
      if (!task) return true
      runtimeLog.log('info', 'updater', 'install.install-in-progress', `重启安装更新前确认：${task.key}`)
      const proceed = await confirmInterruptingInstall(task)
      if (!proceed) runtimeLog.log('info', 'updater', 'install.postponed', '还有工具在装，这次不装新版本，新版本留着')
      return proceed
    }
    // 新版本在后台下好以后先跳框问要不要现在装，没装的 Mac 等电脑闲着时自己装（update-install-prompt.ts，#1380）。
    const updateInstallPrompter = createUpdateInstallPrompter({
      platform: process.platform,
      getState: () => updaterService.getState(),
      autoUpdate: () => updaterService.autoUpdateEnabled(),
      standardAccount: () => updateAccount === null ? null : updateAccount === 'standard',
      unattended: () => installUnattended(updaterService.getState().installMethod),
      elevated: () => windowsCliExecution.highIntegrity === true,
      idleMs: () => powerMonitor.getSystemIdleTime() * 1_000,
      locked: () => powerMonitor.getSystemIdleState(1) === 'locked',
      // 画布、付款窗口开着（哪怕最小化了）就不在闲时重启：上面可能还有没保存的东西。
      windowVisible: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && (window.isVisible() || window.isMinimized())),
      busy: () => resolveInterruptibleInstallTask(systemService.inspectInstallationQueue()) !== null,
      toolsWorking: () => cliKeepAwake.tools().length > 0,
      accelerationActive: () => acceleration?.hasPossibleSession() === true,
      // 遥控开着就不在闲时重启：重开以后不会自己连回去，人在外面也开不了（YK-2）。
      remoteControlActive: () => codexRemote.hasEnabledChannel(),
      // 对话页、视频剪辑页、画布出的视频，连同登录时接着取回来的：重启会打断，交给服务端的照样扣钱。
      videoWorking: () => [...businesses.values()].some((business) => (
        business.videoService.hasActiveRequests() || business.chatVideoService.hasActiveRequests()
      )),
      // 视频剪辑的拼片在界面里跑，主进程看不到，跟对话出字、开着的对话框一起由界面报忙闲（#1411）。
      rendererBusy: () => mainRendererRelease?.rendererBusy === true,
      // 跳框时会把主窗口叫到最前面，点了「现在安装」付款页跟着关掉；付款窗口开着就先不问（同托盘省内存那条）。
      paymentWindowOpen: () => paymentWindow.isOpen(),
      attempted: (version) => pendingUpdateRecord.attemptedVersion === version || pendingUpdateRecord.quitAttemptedVersion === version,
      ask: async (prompt, signal) => {
        if (mainWindow.isDestroyed()) return 'later'
        // 先撤，再叫出窗口：窗口第一次显示时会把等着开窗口的那一版交给打开时装。
        withdrawLaunchInstall()
        // 挂在隐藏窗口上的框用户看不见：窗口缩着时先叫出来，点了「稍后再说」再照原样缩回去。
        const wasMinimized = mainWindow.isMinimized()
        const wasHidden = !wasMinimized && !mainWindow.isVisible()
        showMainWindow()
        if (process.platform === 'darwin') app.focus({ steal: true })
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: prompt.title, message: prompt.message, detail: prompt.detail,
          buttons: prompt.buttons,
          // 回车、空格、Esc 都落在「稍后再说」上：客户在别处打字时按的回车不能把星芒关掉去装。
          defaultId: 0, cancelId: 0, noLink: true, signal,
        })
        if (result.response === 1 && !signal.aborted) return 'install'
        if (mainWindow.isDestroyed()) return 'later'
        if (wasMinimized) mainWindow.minimize()
        if (wasHidden) {
          mainWindow.hide()
          // 把前台还给刚才在用的程序，同后台装完重新拉起的那一次。画布开着时不这么做：app.hide() 会把它也藏起来。
          const othersVisible = BrowserWindow.getAllWindows().some((window) => window !== mainWindow && !window.isDestroyed() && window.isVisible())
          if (process.platform === 'darwin' && !othersVisible) app.hide()
        }
        return 'later'
      },
      // 与托盘「重启并安装」同一条路：还有工具在装时先问那一句。
      installNow: async () => {
        if (await confirmUpdateInstall?.() ?? true) updaterService.install()
      },
      // 闲时装之前同退出时装一样现读一次撤回名单，最多等几秒由跳框器自己掐。
      refreshServiceStatus: async () => { await serviceStatusMonitor?.refresh() },
      // 照开机自启时的后台装办：先把「试过了」写稳，安装器把新版本拉起来时照旧待在后台（isRelaunchAfterBackgroundInstall）。
      installWhileIdle: async (version) => {
        pendingUpdateRecord = { ...pendingUpdateRecord, attemptedVersion: version, backgroundInstall: { version, startedAt: Date.now() } }
        await pendingUpdateStore.write(pendingUpdateRecord)
        try {
          updaterService.install()
        } catch (cause) {
          dropBackgroundInstall()
          throw cause
        }
      },
      log: (level, event, message, detail) => runtimeLog.log(level, 'updater', event, message, detail),
    })
    const unsubscribeUpdateInstallPrompt = updaterService.subscribe((state) => updateInstallPrompter.observe(state))
    updateInstallPrompter.observe(updaterService.getState())
    // 账号是不是管理员问出来之前不跳框，问出来再看一遍。
    void updateAccountProbe.then(() => updateInstallPrompter.observe(updaterService.getState()), () => undefined)
    quitCleanup.add('update-install-prompt', () => {
      unsubscribeUpdateInstallPrompt()
      updateInstallPrompter.dispose()
    })
    receiveDeepLink = (raw) => {
      if (!deepLinkInbox.accept(raw)) return
      showMainWindow()
      deliverToMainWindow('onExternalDeepLink', undefined)
    }
    let trayHintShown = false
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
          // 默认不勾：不勾就和以前一样每次都问。选「返回」时勾了也不记。
          checkboxLabel: '记住我的选择，以后不再询问（可以在「设置 → 启动关闭」里改）',
          checkboxChecked: false,
        })
        const decision = trayReady ? result.response === 0 ? 'hide' : result.response === 1 ? 'quit' : 'cancel' : result.response === 0 ? 'quit' : 'cancel'
        return { decision, remember: result.checkboxChecked }
      },
      rememberCloseBehavior: async (closeBehavior) => {
        await systemService.updateStoredConfig({ version: 2, closeBehavior })
        runtimeLog.log('info', 'window', 'close.remembered', closeBehavior === 'tray' ? '以后点关闭直接缩到托盘' : '以后点关闭直接退出')
      },
      onHiddenToTray: () => {
        // 第一次缩到托盘时说一次窗口去哪了。系统通知被关掉时，Windows 退到托盘气泡；
        // macOS 的菜单栏图标一直看得见，不补。两样都没出来就不记，下次再试。
        if (trayHintShown || systemService.readStoredConfig().trayHintShown) { trayHintShown = true; return }
        const event = hiddenWindowNotification(process.platform)
        let shown = false
        try { shown = hostNotifier()({ event, eventKey: 'first' }) === 'requested' } catch (cause) { runtimeLog.exception('window', 'tray-hint.notify-failed', cause) }
        if (!shown) {
          const { title, body } = hostNotificationMessage(event)
          shown = applicationTray?.showBalloon(title, body) ?? false
        }
        if (!shown) return
        trayHintShown = true
        runtimeLog.log('info', 'window', 'tray-hint.shown', '已提示窗口缩到了托盘')
        void systemService.updateStoredConfig({ version: 2, trayHintShown: true }).catch((cause: unknown) => {
          runtimeLog.exception('window', 'tray-hint.save-failed', cause)
        })
      },
      confirmQuit: async () => {
        // 没有安装在跑、也没有装好的更新时这里不做任何 IO，也不弹窗：关窗冒烟
        // 测试的预算就那几秒。两件事按轻重排队，一次退出最多只问一句。
        if (mainWindow.isDestroyed()) return 'quit'
        const task = resolveInterruptibleInstallTask(systemService.inspectInstallationQueue())
        if (task) {
          runtimeLog.log('info', 'window', 'quit.install-in-progress', `退出前确认：${task.key}`)
          // 刚劝过一次的人不该紧接着再被问一句更新，这次退出就干净地退出。
          return await confirmInterruptingInstall(task) ? 'quit' : 'cancel'
        }
        let update = resolveInstallableUpdateOnQuit(updaterService.getState())
        if (!update) return 'quit'
        // 账号不是管理员时退出不装也不问（decideQuitInstall），下面的撤回名单也就不用等。账号是不是
        // 管理员一般早问出来了，刚打开就退出时最多再等几秒。
        const standardAccount = updaterService.autoUpdateEnabled() && (updateAccount ?? await updateAccountProbe) === 'standard'
        if (updaterService.autoUpdateEnabled() && !standardAccount) {
          // 自动更新开着、这一版还没在退出时自动试过，就不再问，直接装。装之前再看一眼撤回名单：下载之后才被撤回
          // 的版本会在这里被收回，最多等几秒，读不到就按上次读到的算。
          await Promise.race([
            serviceStatusMonitor?.refresh().catch(() => null),
            new Promise((resolve) => { setTimeout(resolve, 3_000).unref() }),
          ])
          update = resolveInstallableUpdateOnQuit(updaterService.getState())
          if (!update) return 'quit'
        }
        const version = update.version
        const installMethod = updaterService.getState().installMethod
        // 上面等的那几秒里系统可能已经开始关机：不装、不问，也不记「退出时试过了」。
        const decision = decideQuitInstall({ autoUpdate: updaterService.autoUpdateEnabled(), version, record: pendingUpdateRecord, installMethod, systemShuttingDown: lifecycle.isSystemShuttingDown, standardAccount })
        if (decision === 'later') {
          runtimeLog.log('info', 'window', 'quit.update-later', `系统正在关机、重启或注销，这次不装 ${version ?? '新版本'}，下次打开再装`)
          return 'quit'
        }
        if (decision === 'leave') {
          runtimeLog.log('info', 'window', 'quit.update-left', `这台电脑的账号不是管理员，退出时不装 ${version ?? '新版本'}，等有管理员账号的人在「设置 › 版本更新」点「重启并安装」`)
          return 'quit'
        }
        if (version && decision === 'install') {
          runtimeLog.log('info', 'window', 'quit.update-auto-install', `退出时自动安装更新：${version}`)
          desktopNotifications.announce(buildAutoInstallNotice(version, 'quit', process.platform, windowsCliExecution.highIntegrity === true))
          // 给系统一点时间把通知摆出来，再让安装器接手退出。
          await new Promise((resolve) => { setTimeout(resolve, QUIT_INSTALL_NOTICE_MS).unref() })
          if (lifecycle.isSystemShuttingDown) {
            runtimeLog.log('info', 'window', 'quit.update-later', `系统正在关机、重启或注销，这次不装 ${version}，下次打开再装`)
            return 'quit'
          }
          // 退出时同一个版本只自动装一次：授权窗被点了「否」时软件已经退了，下次打开要从
          // 这条记录认出「没装上」，不再每次退出都弹授权窗口。写不进去也照装，最多多问一次。
          // 记在等完通知之后：等的那一下系统开始关机的话，这条记录会让下次打开不再自动装。
          quitInstallAttempt = { version, previous: pendingUpdateRecord.quitAttemptedVersion ?? null }
          pendingUpdateRecord = { ...pendingUpdateRecord, quitAttemptedVersion: version }
          await pendingUpdateStore.write(pendingUpdateRecord).catch((cause: unknown) => {
            runtimeLog.exception('updater', 'pending.record-failed', cause)
          })
          return 'install-update'
        }
        runtimeLog.log('info', 'window', 'quit.update-downloaded', `退出前确认安装更新：${update.version ?? '版本未知'}`)
        if (!mainWindow.isVisible()) showMainWindow()
        const prompt = quitInstallPrompt(update.version, installMethod)
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: '关闭星芒AI管理工具',
          message: prompt.message,
          detail: prompt.detail,
          buttons: prompt.buttons,
          defaultId: 0, cancelId: 1,
        })
        return result.response === 0 ? 'install-update' : 'quit'
      },
      // 更新页那颗「重启并安装」走的是同一条 install()；这里只是把入口挪到了
      // 用户真正会用的那个动作上（关窗 / 托盘退出）。
      installDownloadedUpdate: () => {
        // 安装器装完会自己打开新版本，再拉起一次旧进程会和安装器抢同一个目录。
        relaunchRequested = false
        updaterService.install()
        if (process.platform !== 'darwin') return
        // Mac 的安装器在本进程里取包、校验，准备好了才自己退出重开；马上退出等于
        // 把它一起关掉，什么也装不上。等它给结果，期间窗口都收起来。和更新页那条
        // 一样先放掉画布、支付窗口，不然安装器发起的退出会被它们拦住。
        try { canvasController.dispose() } catch (cause) { runtimeLog.exception('canvas', 'shutdown.failed', cause) }
        try { paymentWindow.destroy() } catch (cause) { runtimeLog.exception('payment', 'shutdown.failed', cause) }
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.on('will-prevent-unload', (event) => event.preventDefault())
        }
        app.hide()
        runtimeLog.log('info', 'updater', 'install.quit-wait', '退出前等 Mac 安装器准备好新版本，最多 20 秒')
        return waitForUpdateInstallFailure(updaterService)
      },
      // 开着加速时系统代理指着本机端口：关机前不还原，下次开机整台电脑上不了网。
      needsShutdownCleanup: () => {
        const hold = acceleration?.hasPossibleSession() === true
        if (hold) runtimeLog.log('info', 'window', 'shutdown.hold', '关机前先断开加速、还原系统代理')
        return hold
      },
      prepareToQuit: async () => {
        accountRestoreRetry.dispose()
        // 这里只等两秒，没收完的由加速辅助进程在退出后接着改回（Mac 上可能还要输一次电脑密码）。2026-10-25 客户
        // 日志里打开 Codex 时自动连的那一次只有「已连接」、没有「已断开」：它是重开星芒时在这里收回的，日志里却一个字都没留。
        if (acceleration?.hasPossibleSession()) runtimeLog.log('info', 'network', 'acceleration.quit.stop', '退出前断开加速、改回网络设置')
        // 聊天记录最后一次保存可能还在写盘，写完再退，别让刚聊的那几句丢在半路。
        await Promise.all([acceleration?.stopAll(), chatHistoryStore.idle()])
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
        if (relaunchRequested) app.relaunch()
        app.quit()
      },
      onError: (cause) => {
        runtimeLog.exception('window', 'close.failed', cause)
      },
    })
    lifecycle.attach(mainWindow, app)
    // 缩到托盘满 10 分钟、手上没事就关掉界面进程省内存，叫出来时重新加载（renderer-release.ts）。
    // 关着的那段时间，托盘余额、余额提醒、新公告由主进程照原来的节奏看着（released-renderer-watch.ts）。
    const releasedWatch = createReleasedRendererWatch({
      signedIn: () => accountService.getSessionState().authenticated,
      readBalance: async () => { observeAccountBalance(await accountService.getBalance()) },
      readNotice: async () => await accountService.getNotice?.('cached') ?? null,
      lastSeenNotice: () => lastRendererNotice,
      wake: (reason) => {
        runtimeLog.log('info', 'window', 'renderer.wake', reason === 'notice' ? '有新公告，界面在后台重新加载，看要不要提醒' : '充值活动还没结束，界面在后台重新加载，看今天要不要提醒')
        mainRendererRelease?.restore('wake')
      },
      onError: (cause) => runtimeLog.exception('window', 'renderer.watch.failed', cause),
    })
    const rendererRelease = createRendererRelease({
      // 最小化的还在任务栏上，随时会被点开，不算。
      hiddenInTray: () => !mainWindow.isDestroyed() && !mainWindow.isVisible() && !mainWindow.isMinimized() && !mainWindow.isFocused(),
      mainBlocker: () => {
        if (lifecycle.isQuitting) return 'quitting'
        const queue = systemService.inspectInstallationQueue()
        if (queue.activeKey !== null || queue.pendingKeys.length > 0) return 'installing'
        if (paymentWindow.isOpen()) return 'payment'
        return null
      },
      release: () => releaseRendererProcess(mainWindow.webContents),
      reload: () => {
        void mainWindow.loadURL(resolveMainWindowUrl(systemService.readStoredConfig().theme)).catch((error) => {
          runtimeLog.exception('renderer', 'page.load.failed', error)
        })
      },
      onReleased: () => { releasedWatch.start() },
      onRestoring: () => { releasedWatch.stop() },
      log: (event, detail) => { runtimeLog.log('info', 'window', `renderer.${event}`, rendererReleaseLogMessages[event], detail) },
      onError: (cause) => runtimeLog.exception('window', 'renderer.release.failed', cause),
    })
    mainRendererRelease = rendererRelease
    rendererReleases.set(mainWindow.webContents, rendererRelease)
    const deliverWhenRendererReady = (key: string, send: () => void) => { rendererRelease.deliver(key, send) }
    attachRendererDelivery(deliverWhenRendererReady)
    mainWindow.on('hide', () => { rendererRelease.noteHidden() })
    // 托盘、第二个实例、系统通知、Dock 把窗口叫出来，最后都会走到其中一个。
    mainWindow.on('show', () => { rendererRelease.noteShown() })
    mainWindow.on('focus', () => { rendererRelease.noteShown() })
    mainWindow.on('restore', () => { rendererRelease.noteShown() })
    // 开机自启一直缩在托盘里的，从没显示过也就没有 hide：界面加载好就开始计时。
    mainWindow.once('ready-to-show', () => {
      if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) rendererRelease.noteHidden()
    })
    mainWindow.once('closed', () => {
      releasedWatch.stop()
      rendererRelease.dispose()
      detachRendererDelivery(deliverWhenRendererReady)
    })
    quitCleanup.add('renderer-release', () => {
      releasedWatch.stop()
      rendererRelease.dispose()
      detachRendererDelivery(deliverWhenRendererReady)
    })
    // Mac 关机 / 重启 / 注销时系统挨个让程序退出，拖着不退会被说成取消了关机：听到这一声，
    // 接下来的退出和 Windows 关机一样不问、不装（下好的更新下次打开再装），开着的确认框和
    // 正在等的安装器都不等了。Electron 只在系统发出关机通知时发它，Command + Q 不发。
    if (process.platform === 'darwin') {
      const onPowerOff = () => {
        runtimeLog.log('info', 'window', 'shutdown.power-off', '系统要关机、重启或注销')
        lifecycle.noteSystemPowerOff()
        // 刚退出、自动装已经记下「试过了」，安装器还没装完（装完它会自己结束进程）：关机会把
        // 它一起结束。撤回这条记录，下次打开照常自动装；没来得及写成，就和以前一样提示上次没装上。
        const undone = undoQuitInstallAttempt(pendingUpdateRecord, quitInstallAttempt)
        quitInstallAttempt = null
        if (!undone) return
        pendingUpdateRecord = undone
        runtimeLog.log('info', 'updater', 'install.quit-interrupted', '关机打断了退出时的安装，下次打开再装')
        void pendingUpdateStore.write(pendingUpdateRecord).catch((cause: unknown) => {
          runtimeLog.exception('updater', 'pending.record-failed', cause)
        })
      }
      powerMonitor.on('shutdown', onPowerOff)
      quitCleanup.add('power-off-watch', () => { powerMonitor.off('shutdown', onPowerOff) })
    }
    requestRelaunch = async () => {
      relaunchRequested = true
      runtimeLog.log('info', 'window', 'relaunch.requested', '用户要求重开软件')
      const result = await lifecycle.requestQuit()
      if (result !== 'quit-requested') relaunchRequested = false
      return result === 'quit-requested'
    }
    // 运行中没人接住的异常：不让 Electron 弹那个英文框、带着坏状态接着跑，而是记一笔、
    // 收拾好加速和聊天记录后退出，10 分钟内头一次就自动重开（见 unexpected-exit.ts）。
    // 注册了自己的 uncaughtException 监听，Electron 自带的那个弹框就不再出现。
    const simulateUnexpectedExit = process.env.XINGMANG_SIMULATE_MAIN_CRASH === '1'
    let unexpectedExitStarted = false
    let appWillQuit = false
    quitCleanup.add('unexpected-exit-flag', () => { appWillQuit = true })
    const onUnexpectedException = (error: Error) => {
      // 用户自己在退出的路上出的错不重开；同一次退出里再出错也只处理第一次。
      if (unexpectedExitStarted || appWillQuit) return
      unexpectedExitStarted = true
      const windowVisible = !mainWindow.isDestroyed() && mainWindow.isVisible()
      let relaunch = false
      try {
        relaunch = recordUnexpectedExit(unexpectedExitRecordPath(managerDataDirectory), {
          now: Date.now(),
          error: describeUnexpectedExitError(error, os.homedir()),
          // 开发态和自动化冒烟里不重开：测试框架看得到退出就够了，再拉起一个进程只会留下没人管的窗口。
          // 设了模拟开关的开发态照样重开，方便不打包也能演一遍。
          allowRelaunch: app.isPackaged || simulateUnexpectedExit,
        }).relaunch
      } catch (cause) {
        runtimeLog.exception('main', 'app.unexpected-exit.record-failed', cause)
      }
      runtimeLog.log('error', 'main', relaunch ? 'app.unexpected-exit.relaunched' : 'app.unexpected-exit.suppressed',
        relaunch ? '主进程意外出错，退出后自动重开' : '主进程意外出错，这次不自动重开（10 分钟内已重开过，或不是打包版）', { windowVisible })
      // 开着加速时系统代理指着本机端口，不断开就退，整台电脑上不了网；错误报告也等它发完。
      // 限时 3 秒：坏掉的状态可能让这些永远等不完。
      // 每一步都包进 then：坏掉的状态下哪一步同步抛错，也不能拦住后面的退出。
      const settle = Promise.allSettled([
        Promise.resolve().then(() => crashReporter.flush()),
        Promise.resolve().then(() => acceleration?.stopAll()),
        Promise.resolve().then(() => chatHistoryStore.idle()),
      ]).then(() => runtimeLog.idle())
      void Promise.race([settle, new Promise((resolve) => { setTimeout(resolve, 3_000).unref() })]).finally(() => {
        try {
          if (relaunch) app.relaunch({ args: buildUnexpectedExitRelaunchArgs(process.argv.slice(1), windowVisible) })
        } finally {
          app.exit(1)
        }
      })
    }
    process.on('uncaughtException', onUnexpectedException)
    quitCleanup.add('unexpected-exit-handler', () => { process.off('uncaughtException', onUnexpectedException) })
    // 真机上演「意外退出」用：打包版也认，设了它启动 30 秒后主进程抛一次没人接的异常。
    // 重开出来的进程带着同一个环境变量，会再退一次，正好演「10 分钟内第二次不再重开」。
    if (simulateUnexpectedExit) {
      runtimeLog.log('warn', 'main', 'app.unexpected-exit.simulate', '已设置模拟意外退出，30 秒后触发')
      setTimeout(() => { throw new Error('模拟的主进程意外退出（XINGMANG_SIMULATE_MAIN_CRASH）') }, 30_000).unref()
    }
    // Mac 上「卸载星芒」：退出前的清理和「重启并安装」同一条（断开加速、还原系统代理、
    // 聊天记录写完盘），在挪程序之前跑；跑完才清登录记录，否则会被写回来。
    requestMacUninstall = (request, backupCliConfigs) => {
      const report = (line: string) => runtimeLog.log('warn', 'maintenance', 'app.uninstall.step-failed', line)
      return runMacUninstall({
        platform: process.platform,
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        executablePath: process.execPath,
        installationBusy: () => {
          const queue = systemService.inspectInstallationQueue()
          return queue.activeKey !== null || queue.pendingKeys.length > 0
        },
        backupCliConfigs,
        removeCliHooks: () => removeCliHooksFromConfigs(rootedOptions.system.providerRoots, report),
        removeLoginItem: () => removeMacLoginItem(app),
        removeManagedTools: () => removeMacManagedTools(undefined, report),
        trashItem: (target) => shell.trashItem(target),
        prepareQuit: async () => { await lifecycle.prepareUpdateQuit() },
        abortQuit: () => { lifecycle.abortUpdateQuit() },
        removeUpdaterCache: () => clearUpdaterCache(resolveUpdaterCacheDirectory(), report),
        clearLoginRecords: async () => {
          // 界面的本地存储由 Chromium 开着，先让它自己清，免得退出时把刚删的写回来。
          await session.defaultSession.clearStorageData({ storages: ['localstorage'] }).catch(() => undefined)
          return clearLoginAndChatRecords(managerDataDirectory, report)
        },
        quit: () => {
          relaunchRequested = false
          const forceExitTimer = setTimeout(() => app.exit(0), 2_000)
          forceExitTimer.unref()
          try { canvasController.dispose() } catch (cause) { runtimeLog.exception('canvas', 'shutdown.failed', cause) }
          try { paymentWindow.destroy() } catch (cause) { runtimeLog.exception('payment', 'shutdown.failed', cause) }
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.on('will-prevent-unload', (event) => event.preventDefault())
          }
          // 先让这次调用的结果回到界面，再退。
          setTimeout(() => app.quit(), 0)
        },
        report,
      }, request)
    }
    // 更新页「重启并安装」和 Mac 下载完自动安装都会让安装器发起退出：先把退出前
    // 的清理跑完（断开加速、还原系统代理，安装器会结束安装目录下的所有进程），
    // 再放行，别被当成用户关窗又问一遍「顺手装上吗」。
    updateQuitHandoff = {
      prepare: () => {
        const preparation = lifecycle.prepareUpdateQuit()
        if (!preparation) return undefined
        runtimeLog.log('info', 'updater', 'install.quit-prepare', '安装更新前先完成退出清理')
        return preparation.then(() => {
          // 与 quit() 一样：画布窗口会拦自己的关闭，不先放掉它，安装器发起的
          // 退出（Mac 上是先关所有窗口）会被它挡住。
          try { canvasController.dispose() } catch (cause) { runtimeLog.exception('canvas', 'shutdown.failed', cause) }
          try { paymentWindow.destroy() } catch (cause) { runtimeLog.exception('payment', 'shutdown.failed', cause) }
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.on('will-prevent-unload', (event) => event.preventDefault())
          }
        })
      },
      abort: () => { lifecycle.abortUpdateQuit() },
    }
    const trayAssets = path.join(app.getAppPath(), 'assets', 'brand', 'v3')
    applicationTray = !trayHostAvailable ? null : createApplicationTray({
      iconPath: path.join(trayAssets, 'tray-16.png'), icon2xPath: path.join(trayAssets, 'tray-32.png'),
      templateIconPath: path.join(trayAssets, 'trayTemplate-16.png'), templateIcon2xPath: path.join(trayAssets, 'trayTemplate-32.png'),
      getSnapshot: () => {
        const state = accountService.getSessionState()
        return {
          accountLabel: state.account?.username ?? null,
          balanceUsd: latestTrayBalance && latestTrayBalance.quotaPerUnit > 0 ? latestTrayBalance.quota / latestTrayBalance.quotaPerUnit : null,
          subscriptionLabel: traySubscriptionLabel(latestTraySubscription, latestTrayBalance?.quotaPerUnit ?? 0, Date.now()),
          installedTools: [
            ...(latestTraySystem?.desktopApps.codex.installed ? [{ id: 'codexDesktop', label: 'Codex 桌面端' }] : []),
            ...activeProviderIds.filter((id) => latestTraySystem?.clis[id].installed).map((id) => ({ id, label: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex CLI' : 'Grok CLI' })),
          ],
          update: resolveTrayUpdateEntry(updaterService.getState()),
          acceleration: trayAcceleration?.entry() ?? null,
          keepAwakeLabel: trayKeepAwakeLabel({
            tools: cliKeepAwake.tools().map((tool) => isProviderId(tool) ? cliCatalog[tool].name : tool),
            remoteControl: codexRemoteKeepAwake.holding(),
            installing: installKeepAwake.reasons().includes('install'),
            downloadingUpdate: installKeepAwake.reasons().includes('update-download'),
          }),
        }
      },
      onOpen: showMainWindow,
      onNavigate: (target) => deliverToMainWindow('onNavigate', target),
      onLaunchTool: (id) => {
        showMainWindow()
        // 托盘菜单里的编号都是自己按名单拼的，这里只是让类型对上。
        if (id === 'codexDesktop' || isProviderId(id)) deliverToMainWindow('onLaunchTool', id)
      },
      onAccelerationToggle: () => trayAcceleration?.toggle(),
      // 与更新页「确认重启安装」、IPC update:install 同一条路：先问有没有工具在装，退出交接与安装闸都在 install() 里。
      onInstallUpdate: async () => { if (await confirmUpdateInstall?.() ?? true) updaterService.install() },
      // 主窗口缩到托盘之后渲染层那边的加速轮询是停的，菜单弹出来这一刻是唯一
      // 能把剩余时长读新的时机；读一次，不起定时器。
      onMenuOpen: () => { trayAcceleration?.refresh() },
      onQuit: () => lifecycle.requestQuit(),
      onError: (cause) => runtimeLog.exception('window', 'tray.failed', cause),
    })
    quitCleanup.add('window-lifecycle-and-tray', () => { lifecycle.dispose(); applicationTray?.dispose() })
    // The canvas window is a secondary, opt-in surface -- it must not
    // outlive the main window (which would otherwise leave the app running
    // in the background with no way back to the dashboard on Windows/Linux,
    // since window-all-closed only quits when every window is gone).
    mainWindow.on('closed', () => {
      paymentWindow.destroy()
      canvasController.dispose()
    })
    // 客户回到星芒窗口：等着外部客户端退出再换线路的，看一眼退了没有（xm 三线路 C11）。
    mainWindow.on('focus', () => systemService.recheckPendingExternalRoutes?.())
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
        void updaterService.scheduledCheck().catch((error) => {
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
    console.error('Application startup failed:', error)
    // console output is unreachable in a packaged build and devtools are
    // disabled there, so this file is the only evidence a support case gets.
    const logPath = recordFatalStartupFailure('whenReady', error)
    void presentStartupFailure(error, logPath).finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
