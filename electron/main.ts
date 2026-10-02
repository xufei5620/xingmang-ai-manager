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
  powerMonitor,
  powerSaveBlocker,
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
import { createAccelerationExpiryNotice, type AccelerationExpiryNotice } from './acceleration-expiry-notice'
import { createAccelerationInterruptionNotice, type AccelerationInterruptionNotice } from './acceleration-interruption-notice'
import { createAccelerationPower } from './acceleration-power'
import { createAccelerationService } from './acceleration-service'
import { accelerationConflictDescriptions, accelerationFailureMessages, type AccelerationBundleCheck, type AccelerationMode, type AccelerationState } from './acceleration-contract'
import { accelerationStartRequest, createAccelerationPreferenceStore, defaultAccelerationPreference } from './acceleration-preference-store'
import { accelerationStartFailureDescriptions, createAccelerationDevelopmentHost, readAccelerationDevelopmentConfig, type AccelerationDevelopmentHost } from './acceleration-development-host'
import { readBundledAccelerationConfig } from './acceleration-bundled-config'
import { AiAssetStore } from './ai-asset-store'
import { createAiChatHistoryStore } from './ai-chat-history-store'
import { chooseAiOutputRoot, migrateLegacyAiOutput, resolveLegacyAiOutputRoot } from './ai-output-location'
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
import { createManagedKeyReplacementStore } from './managed-key-replacement-store'
import { ChatKeyStore } from './chat-key-store'
import { ManagedCliKeyStore } from './managed-cli-key-store'
import { AccountSessionStore } from './account-session-store'
import { SavedAccountsStore } from './saved-accounts'
import { AppSettingsStore, readAppSettings, type AppTheme } from './app-settings'
import { calculateUiZoom, resolveWindowPlacement } from './window-preferences'
import { attachEditContextMenu } from './context-menu'
import { recoverOffscreenWindow } from './window-recovery'
import { createWindowLifecycle } from './window-lifecycle'
import { installLeftoverStartupDelayMs, sweepInstallLeftovers } from './install-leftovers'
import { createLoginQuietPeriod, hasLoginLaunchArgument, loginQuietPeriodMs, resolveLoginLaunch, shouldRevealInitialWindow, windowsAppUserModelId } from './login-launch'
import { resolveInstallableUpdateOnQuit, resolveInterruptibleInstallTask } from './quit-blocking-tasks'
import { LAUNCH_INSTALL_NOTICE_MS, QUIT_INSTALL_NOTICE_MS, buildAutoInstallNotice, createPendingUpdateStore, decideLaunchInstall, decideQuitInstall, previousAutoInstallFailureMessage, resolveDownloadedVersionToRecord, resolvePreviousAutoInstallFailure } from './auto-update-install'
import { createWindowResponsivenessGuard } from './window-responsiveness'
import { createRendererCrashRecovery } from './renderer-crash-recovery'
import { createApplicationTray, resolveTrayUpdateEntry, traySubscriptionLabel, type ApplicationTrayController } from './application-tray'
import { createTrayAccelerationCoordinator, type TrayAccelerationCoordinator } from './tray-acceleration'
import { createExternalDeepLinkInbox } from './external-deep-links'
import { createDesktopNotificationController } from './desktop-notifications'
import { inspectDeviceHardware, isLowEndDevice } from './device-profile'
import { buildUnexpectedExitRelaunchArgs, describeUnexpectedExitError, recordUnexpectedExit, takeUnexpectedExitNotice, unexpectedExitRecordPath } from './unexpected-exit'
import { clearDisplayCrashRecord, inspectDisplayLaunch, isDisplayCrash, pruneStaleDisplayCrashRecord, recordDisplayCrash, type DisplayLaunch } from './display-compat'
import { ConfigBackupStore } from './backups'
import { crashReportDsn, crashReportSelfTestEnvironmentKey, shouldReportCrashes } from './crash-report'
import { createCrashReporter } from './crash-reporter'
import { providerIds, type ProviderId } from './catalog'
import { externalClientOfficialDownloadUrls } from './external-client-contract'
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
import { createChatAttachmentService, type ChatImageCodec } from './ai-chat-attachments'
import { resolveCodexHomeContext } from './codex-home'
import { runCodexContextLimitsMigration } from './codex-config-migration'
import { runClaudeDesktopModelRepair } from './claude-desktop-model-repair'
import { findExecutable, runWithTrustedWindowsProcessEnvironment } from './command-runner'
import { CodexExtensionService } from './codex-extensions'
import { CodexSessionsService } from './codex-sessions'
import { createNewApiClient, type NewApiRetryOffProxyFailure } from './new-api-client'
import { buildAccountIdentity, createAccountIdentityTracker } from './account-identity-tracker'
import { createRealmAccountService, type RealmAccountClientHandle, type RealmAccountSiteId } from './realm-account-service'
import { createFileRealmAccountVault } from './realm-account-vault-file'
import { createSessionRealmAccountVault } from './realm-account-vault'
import { createVaultRecoveryNotifier } from './vault-recovery-notice'
import { inspectSafeStorageBackend, resolveCredentialPersistence } from './safe-storage-backend'
import { isRegularFile, resolveLinuxPasswordStore } from './linux-password-store'
import { parseRealmSavedAccount, type RealmSavedAccount } from './realm-account'
import { createSub2ApiRelayBackend } from './sub2api-relay-backend'
import { requireSiteRuntimeDefinition } from './site-runtime'
import { createActiveIdentityReader } from './active-identity'
import { resolveRealmDataRoots } from './realm-data-roots'
import { createRealmServiceDispatch } from './realm-service-dispatch'
import { createAccountWorkGate } from './account-work-gate'
import { createAccountStartupGate } from './account-startup-gate'
import { createAccountRestoreRetry } from './account-restore-retry'
import { createAccountUsageTracker } from './account-usage-tracker'
import type { RelayBackendClient } from './relay-backend'
import { ProviderExtensionService } from './provider-extensions'
import { ProviderSessionsService } from './provider-sessions'
import { guardProcessOutputStreams } from './process-stream-errors'
import { configureRelocatedFolderAccess } from './relocated-folders'
import { RuntimeLogStore } from './runtime-log'
import { hostNotifier } from './platform/host-notification-bridge'
import { hostNotificationMessage } from './platform/notifications'
import { attachProxyBypassState } from './platform/proxy-bypass-bridge'
import { createProxyBypass, networkSettingsTarget, probeDirectConnection } from './proxy-bypass'
import { attachPlatformAuditLog } from './platform/runtime-log-bridge'
import { migrateLegacyWindowsLoginItem } from './platform/system-service'
import { recordStartupFailure, redactHomeDirectory } from './startup-log'
import { inspectProviderConfig, syncXingmangImageMcpConfigs } from './config-files'
import { buildFeedbackEnvironmentLines, buildFeedbackRuntimeLines, pickFeedbackRuntimeSnapshot } from './feedback-environment'
import { managedCliRoot } from './managed-cli-paths'
import { buildFeedbackSelfCheckLines, type FeedbackConnectionRecord } from './feedback-self-check'
import { rootedMainServiceOptions } from './main-service-options'
import {
  buildMacosInstallLocationNotice, buildMacosMoveFailureNotice, inspectMacosInstallLocation,
  moveMacosAppToApplications, type MacosInstallLocationChoice, type MacosInstallLocationNotice,
} from './macos-install-location'
import { privacyPolicyUrl, relaySiteExternalUrls, relaySites, resolveRelaySite, sub2ApiSupportServiceUrl, supportServiceUrl, userAgreementUrl } from './relay-sites'
import { createPaymentWindowController } from './payment-window'
import { createPaymentOrderStatusReader } from './payment-status-reader'
import {
  clearableEnvironmentOverrides,
  createDiagnosticsExport,
  redactDiagnosticText,
  diagnosticsScanReuseMs,
  relayStatusProbeUrl,
  runDiagnostics,
  type DiagnosticsReport,
  type DiagnosticsRunOptions,
} from './diagnostics'
import { buildConnectionProbe, runConnectionCheck } from './connection-check'
import { clearUserProviderOverrides, setAsideCodexDotenv, type DiagnosticFixKind } from './diagnostic-fixes'
import { createCodexResponsesProbeService } from './codex-responses-probe'
import type { ExternalToolId } from './external-tool-config'
import { registerIpcHandlers, type AppWindowMode, type IpcRegistrationOptions } from './ipc'
import { removeMacLoginItem, removeMacManagedTools, runMacUninstall } from './macos-uninstall'
import { clearLoginAndChatRecords, removeCliHooksFromConfigs } from './uninstall-cleanup'
import {
  installXingmangAiSkillFiles,
  resolveXingmangAiBundledSkillRoot,
  XINGMANG_IMAGE_MCP_NO_NODE_WARNING,
} from './xingmang-ai-skill'
import { buildXingmangImageMcpInvocation } from './xingmang-ai-mcp'
import { resolveClaudeStatusLineScriptPath } from './claude-status-line'
import { cliHookEventsDirectory, resolveCliHookScriptPath } from './cli-hooks'
import { createCliHookEventMonitor } from './cli-hook-events'
import { createCliKeepAwake } from './cli-keep-awake'
import { createInstallKeepAwake } from './install-keep-awake'
import { resolveProjectInstructionsTemplatePath } from './project-instructions'
import { ipcEventChannels, type AccountBalance, type AccountSubscriptionSelf, type AppUninstallRequest, type SettingsSaveIssue, type UnexpectedExitNotice } from './ipc-contract'
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
import { createCodexDesktopAccelerationCoordinator } from './codex-desktop-acceleration'
import { probeCodexDesktopRunning } from './codex-desktop-service'
import {
  createSystemService,
  type SystemService,
  type SystemSnapshot,
} from './system-service'
import { verifyUpdatePackageDigest } from './update-package-digest'
import { installStrictUpdateCodeSignatureVerifier } from './update-signature'
import { createUpdaterService } from './updater'
import { readDiskSpace, tightestDiskSpace, updateDownloadProbeTargets } from './disk-space'
import { createLastRunVersionStore, hasPriorRunRecord, readBundledReleaseNotes, resolveInstalledRelease } from './installed-release'
import { appReleaseDownloadUrl } from './app-download-page'
import { createServiceStatusMonitor, locateServiceStatusUrl, readServiceStatus } from './service-status'
import { resolveWindowsCliExecutionModeDetailed } from './windows-elevation'
import { ensureDirectoryOnWindowsUserPath } from './windows-cli-shell-access'
import { ensureMacosShellProfile } from './macos-shell-profile'
import {
  applyWindowTheme,
  buildMacApplicationMenuTemplate,
  platformWindowOptions,
} from './window-presentation'
import { buildStartupFailureDialog, classifyStorageFailure, dataDriveLetter } from './startup-failure'
import { installMainWindowFrameNavigationGuard } from './platform/frame-navigation'
import { codexDesktopStoreUrl } from './codex-desktop-install-failure'
import { inspectUserWideCertificateTrust, trustCertificatesForUserTerminals } from './user-certificate-trust'

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
  // 缺少系统 winget 时首页 Claude Desktop、OpenCode 两行的「去官网下载」（逐条全等）。
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

// Screenshots pasted into the chat are shrunk here, in the main process, before
// anything is stored or sent. nativeImage decodes PNG and JPEG on every
// platform; a WebP it cannot read comes back empty and is reported as such.
const nativeChatImageCodec: ChatImageCodec = {
  decode(bytes, maxEdge) {
    let image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    if (longest > maxEdge) {
      const scale = maxEdge / longest
      image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' })
    }
    const resized = image.getSize()
    return { width: resized.width, height: resized.height, png: () => image.toPNG(), jpeg: (quality) => image.toJPEG(quality) }
  },
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
  const crashRecovery = createRendererCrashRecovery({
    reload: () => window.webContents.reload(),
    prompt: async () => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: '界面出了问题', message: '星芒AI管理工具的界面接连出错，自动重新加载也没能恢复。',
        detail: `可以再试一次重新加载。如果还是空白，请从${process.platform === 'darwin' ? '屏幕顶部菜单栏' : '任务栏右下角'}的星芒图标退出软件后重新打开，并在「反馈」页把问题发给我们。正在进行的安装、下载和已保存的设置都不受影响。`,
        buttons: ['重新加载', '先不管'], defaultId: 0, cancelId: 1,
      })
      return result.response === 0 ? 'reload' : 'dismiss'
    },
    log: (event) => {
      if (event === 'reload.auto') { runtimeLog.log('warn', 'renderer', 'process.gone.reload', '界面进程退出后自动重新加载'); return }
      if (event === 'prompt.shown') { runtimeLog.log('warn', 'renderer', 'process.gone.prompted', '界面接连退出，已提示用户'); return }
      if (event === 'prompt.reload') { runtimeLog.log('info', 'renderer', 'process.gone.user-reload', '用户选择重新加载界面'); return }
      runtimeLog.log('info', 'renderer', 'process.gone.dismissed', '用户暂不重新加载界面')
    },
    onError: (cause) => { runtimeLog.exception('renderer', 'process.gone.recover-failed', cause) },
  })
  window.once('closed', () => { crashRecovery.dispose() })
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
    const relayFetch: typeof fetch = (input, init) => net.fetch(
      input instanceof URL ? input.href : input,
      init,
    )
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
    let readBillingAccountScope: () => string = () => 'xm-account:guest'
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
    // 托盘与自动连接共用这一条：把用户在加速页上选过并落了盘的线路与模式，落到
    // 一次真正的连接上。没选过就是「智能分配 + 标准模式」，与落盘之前的行为一致；
    // 读不到偏好也按没选过继续，绝不因此连不上。
    async function accelerationStartArguments(scope: string, state: AccelerationState | null): Promise<[AccelerationMode, string?]> {
      let preference = defaultAccelerationPreference
      try { preference = await accelerationPreferences.getAccelerationPreference(scope) }
      catch (error) { runtimeLog.exception('network', 'acceleration.preference.read.failed', error) }
      const request = accelerationStartRequest(preference, state?.supportedModes)
      return request.lineId === undefined ? [request.mode] : [request.mode, request.lineId]
    }
    // Codex 桌面端是独立进程，只跟着系统代理走，所以这里要的是完整的「连接」
    // （和用户在加速页点的那一下同一条路），不是下载专用线路。加速服务同样
    // 建得比 systemService 晚，空着的时候一律按没加速打开。
    const codexDesktopAcceleration = createCodexDesktopAccelerationCoordinator({
      getAccountScope: () => readAccelerationAccountScope(),
      readState: (scope) => acceleration
        ? acceleration.getAccelerationState(scope)
        : Promise.reject(new Error('加速服务尚未就绪。')),
      connect: async (scope, state) => {
        if (!acceleration) throw new Error('加速服务尚未就绪。')
        return acceleration.startAutomaticAcceleration(scope, 'codex-desktop', ...await accelerationStartArguments(scope, state))
      },
      // 自动连的不扣免费时长，所以桌面端一关就断开，否则就是一条白送的不限时线路。
      isDesktopRunning: () => probeCodexDesktopRunning(),
      disconnect: (scope) => acceleration
        ? acceleration.stopAcceleration(scope)
        : Promise.reject(new Error('加速服务尚未就绪。')),
      log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
    })
    // CLI 产物下载以前走 Node 自带的网络栈，它不读系统代理，所以开着加速也
    // 一样直连。Chromium 的网络栈读，于是下载才真的走线路。
    // 临时线路生效时改走那条专用 session（它的代理只对下载有效，默认
    // session 一行未动，账号与中转流量不受影响）。
    const downloadFetch: typeof fetch = (input, init) => {
      const url = input instanceof URL ? input.href : input
      // 专用 session 的 fetch 只收字符串或 Request；下载链路一律传 URL 字符串。
      if (downloadAcceleration.currentEndpoint() && typeof url === 'string') {
        return acceleratedDownloadSession.fetch(url, init)
      }
      return net.fetch(url, init)
    }
    const systemService = createSystemService(settingsStore, {
      managerDataDirectory,
      systemSnapshotCacheFile: path.join(managerDataDirectory, 'system-snapshot.json'),
      appVersion: app.getVersion(),
      getRelaySiteId: () => readAccountSiteId(),
      getExternalClientAccountId: () => readExternalClientAccountId(),
      windowsExecutionMode: windowsCliExecutionMode,
      runtimeLog,
      sweepInstallLeftovers,
      ...(process.platform === 'win32'
        ? { ensureWindowsUserPath: (directory: string) => ensureDirectoryOnWindowsUserPath(directory) }
        : {}),
      ...(process.platform === 'darwin'
        ? { ensureMacosShellProfile: (reason: 'install' | 'startup') => ensureMacosShellProfile({ reason }) }
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
      ...rootedOptions.system,
      relayFetch,
      networkLocationFetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
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
      acquireDownloadAcceleration: () => downloadAcceleration.acquire(),
      prepareCodexDesktopAcceleration: async () => { await codexDesktopAcceleration.ensureConnected() },
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
      // Codex 的官方插件目录由本软件替它下载（codex-plugin-catalog.ts），与装 CLI
      // 同一条下载通道，也同样临时借加速线路。
      downloadFetch,
      acquireDownloadAcceleration: () => downloadAcceleration.acquire(),
    })
    let latestDiagnostics: DiagnosticsReport | null = null
    // 最近一次连接自检的结论，只留进报告的那几项（没有 Key、没有地址、没有站
    // 点名）。键是四个工具，所以天然有界。
    const latestConnectionChecks = new Map<ProviderId, FeedbackConnectionRecord>()
    function codexProbeContext() {
      const site = resolveRelaySite(systemService.readStoredConfig().relaySiteId)
      const inspection = inspectProviderConfig(
        'codex', rootedOptions.system.providerRoots, site.providerBaseUrls,
      )
      return { site, inspection }
    }
    const codexResponsesProbe = createCodexResponsesProbeService(
      () => {
        const { site, inspection } = codexProbeContext()
        return buildConnectionProbe('codex', site, inspection)
      },
      {
        fetch: relayFetch,
        // The Key stays in main-process memory. Re-reading it after the first
        // response prevents a second paid request after account/source changes.
        currentScope: () => {
          const { site, inspection } = codexProbeContext()
          return JSON.stringify([
            readBillingAccountScope(), site.id, inspection.actualBaseUrl,
            inspection.apiKey, inspection.model, inspection.matchesRelay,
          ])
        },
      },
    )
    // 诊断导出与反馈报告都要把本机真正写着的那几把 Key 当敏感值剔掉。
    const sensitiveKeyValues = () => providerIds
      .map((provider) => inspectProviderConfig(provider, rootedOptions.system.providerRoots).apiKey)
      .filter(Boolean)
    const diagnosticsService = {
      run: async (options: DiagnosticsRunOptions = {}) => {
        // 开机自动检查紧跟着首页扫描：扫描正在跑就等它，一分钟内刚跑完就直接用，
        // 不再把各工具的版本探测、PowerShell、Codex 桌面端检测重跑一遍。没有现成的
        // 就照旧自己探，不为此专门起一轮扫描。
        const recent = options.reuseRecentScan ? systemService.recentScan(diagnosticsScanReuseMs) : null
        const recentScan = recent ? await recent.catch(() => null) : null
        latestDiagnostics = await runDiagnostics({
          recentScan,
          ...rootedOptions.diagnostics,
          app: {
            name: '星芒AI管理工具',
            version: app.getVersion(),
            packaged: app.isPackaged,
          },
          inspectCodexDesktop: async () => systemService.inspectCodexDesktop(),
          // 「磁盘空间」那一项要看软件数据目录所在的盘，而 userData 在哪只有宿主
          // 知道；CLI 落点由诊断自己算。
          userDataDirectory: app.getPath('userData'),
          // 跟着当前账号所在的那一套 output 走（历史账号多一层 realms/api-account）。
          probeAiOutput: () => assetStore.assertWritable(),
          aiOutputPlacement: () => currentBusiness().aiOutputPlacement,
          // 「文档文件夹能不能写」一项（Windows）：新项目与 AI 作品默认都放在它下面。
          documentsDirectory: readDocumentsDirectory(),
          ...await accelerationBundleStatus.then((status) => status ? { accelerationBundle: status } : {}),
          windowsExecution: windowsCliExecution,
          windowsProcessor: await systemService.inspectWindowsProcessor(),
          // 报告只装中文结论（它会被导出发给客服），认出失败靠的那段上游原文
          // 留在 runtime.jsonl 里。
          log: (level, event, message, detail) => runtimeLog.log(level, 'diagnostics', event, message, detail),
          // Read fresh on every run rather than captured once at startup, so
          // a settings change is reflected on the very next diagnostics run.
          relaySite: resolveRelaySite(systemService.readStoredConfig().relaySiteId),
          inspectAccelerationActive: accelerationRunning,
          // 「电脑里的代理设置」顺带看账号请求走不走系统代理：账号请求用的就是
          // defaultSession 的 net.fetch，问它本身最准，也不用另起命令读系统设置。
          resolveAppProxy: (url) => session.defaultSession.resolveProxy(url),
          // 「Claude 命令确认方式」要分清 bypassPermissions 是我们写的还是别人写的。
          // 来源的判定要比对当前登录账号，只有 system-service 那边算得出来。
          readClaudeConfigOwnership: () => systemService.getConfig(false).providers.claude.configurationOwnership ?? null,
          // 「项目文件夹里的设置」看的是用户最近一次选的项目文件夹，每次检查现读。
          workspace: systemService.readStoredConfig().workspace,
          inspectUserWideCertificateTrust: () => inspectUserWideCertificateTrust({ executionMode: windowsCliExecutionMode }),
        })
        return latestDiagnostics
      },
      // 检查页两颗一键处理。要删哪几项在点的那一刻按当前环境和当前站点重算，
      // 不信渲染层给的任何名字或路径（I5）。
      fix: async (kind: DiagnosticFixKind) => {
        if (kind === 'set-aside-codex-dotenv') return setAsideCodexDotenv(codexContext.codexHome)
        const site = resolveRelaySite(systemService.readStoredConfig().relaySiteId)
        return clearUserProviderOverrides({
          names: clearableEnvironmentOverrides(process.env, site.providerBaseUrls, codexContext.userHome),
        })
      },
      // 自检跟着用户当前所在的站点走，探测和对账读同一个 RelaySite ——
      // 与 system-service.ts 的 inspectNativeProviderConfig 同参，否则换过
      // 站点的用户会被告知一份好配置「指错了地方」。站点名只进日志不上屏。
      checkConnection: async (provider: ProviderId) => {
        const site = resolveRelaySite(systemService.readStoredConfig().relaySiteId)
        const result = await runConnectionCheck({
          provider,
          site,
          inspection: inspectProviderConfig(provider, rootedOptions.system.providerRoots, site.providerBaseUrls),
          fetch: relayFetch,
        })
        latestConnectionChecks.set(provider, {
          ok: result.ok,
          layer: result.layer,
          summary: result.summary,
          checkedAt: result.checkedAt,
        })
        return result
      },
      probeCodexResponses: (expectedAccountScope: string) => {
        if (expectedAccountScope !== readBillingAccountScope()) {
          throw new Error('当前账号变了，请重新勾选确认后再检查')
        }
        return codexResponsesProbe.run()
      },
      // 外部客户端的自检由 system-service 出面：Key、地址与归属都只有它算得出
      // 来，主进程这一层只负责把它接到通道上。
      checkExternalConnection: (tool: ExternalToolId) => systemService.checkExternalClientConnection(tool),
      exportLatest: () => {
        if (!latestDiagnostics) throw new Error('请先运行一次健康诊断')
        return createDiagnosticsExport(latestDiagnostics, {
          ...rootedOptions.diagnosticExport,
          sensitiveValues: sensitiveKeyValues(),
        })
      },
      // 只在最近一次检查确实查出公司证书、且这条还没设过时才写：按钮是检查页给的，
      // 主进程这里再对一次，不因为一条来路不明的调用就去改客户的电脑设置。
      trustCertificatesUserWide: async () => {
        const item = latestDiagnostics?.items.find((entry) => entry.code === 'CERTIFICATE_TRUST')
        if (item?.details?.userWide !== 'available') throw new Error('这台电脑现在不需要这项设置，请先点「重新检测」')
        const result = await trustCertificatesForUserTerminals({ executionMode: windowsCliExecutionMode })
        runtimeLog.log('info', 'diagnostics', 'certificate.user-wide.trusted', '当前 Windows 账号的终端已设为信任这台电脑的证书', { result })
        return result
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
    let requestMacUninstall: NonNullable<IpcRegistrationOptions['uninstallApp']> | null = null
    // 自动更新的落盘记录（见 auto-update-install.ts）。要在更新服务之前读好：下载完成
    // 那一刻就要用它认出「上次自动装过却没装上」的版本。
    const pendingUpdateStore = createPendingUpdateStore({ filePath: path.join(managerDataDirectory, 'pending-update.json') })
    const pendingUpdateAtLaunch = pendingUpdateStore.read()
    let pendingUpdateRecord = { ...pendingUpdateAtLaunch }
    let previousAutoInstallFailureReported = false
    const updaterService = createUpdaterService(autoUpdater, {
      installedRelease,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      localBuild,
      unsignedChannel,
      // 未签名通道（Windows）也跟着「自动更新」开关走：yoyo 2026-09-25 在项目聊天亲口
      // 同意「Windows 也自动更新」。撤回名单、分批放量、SHA-512 复核照旧生效。
      unsignedAutoUpdate: true,
      readAutoUpdate: () => systemService.readStoredConfig().autoUpdate !== false,
      // 每次运行只认一次：用户点「重新安装」后又重新下载同一版时，不该再被判成上次失败。
      previousAutoInstallFailure: (version) => {
        if (previousAutoInstallFailureReported) return null
        const failed = resolvePreviousAutoInstallFailure(version, app.getVersion(), pendingUpdateAtLaunch)
        if (!failed) return null
        previousAutoInstallFailureReported = true
        runtimeLog.log('warn', 'updater', 'install.auto.previous-failed', `上次自动安装 ${failed} 没有装上，这次不再自动装`)
        return previousAutoInstallFailureMessage(process.platform)
      },
      verifyPackageDigest: verifyUpdatePackageDigest,
      // 盘快满的电脑上别每 3 小时下一次注定失败的安装包（第二十二批 2）。
      readFreeDiskBytes: async () => {
        const targets = updateDownloadProbeTargets(process.platform, {
          localAppData: process.env.LOCALAPPDATA,
          home: app.getPath('home'),
          temp: app.getPath('temp'),
        })
        const tightest = tightestDiskSpace(await Promise.all(targets.map((target) => readDiskSpace(target))))
        return tightest ? tightest.availableBytes : null
      },
      diskShortfallSkipped: (shortfall, version) => {
        runtimeLog.log('warn', 'updater', 'download.skipped.disk', `磁盘空间不够，先不下载 ${version ?? '新版本'}`, {
          neededBytes: shortfall.neededBytes,
          freeBytes: shortfall.freeBytes,
        })
      },
      // 监视器在更新服务之后才建（它要把结果交回更新服务），这里等真正检查时再取。
      refreshServiceStatus: () => serviceStatusMonitor ? serviceStatusMonitor.refresh() : Promise.resolve(null),
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
      prepareInstallQuit: () => updateQuitHandoff?.prepare(),
      installQuitAborted: () => { updateQuitHandoff?.abort() },
      reportBackgroundError: (error) => runtimeLog.exception('updater', 'download.background.failed', error),
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
    // 更新目录上的服务状态文件：发布者在那里标「正在维护」，没登录的人也能看到。
    // 只在更新开着的包里读（地址来自安装包自己的更新配置）；读不到当没在维护，
    // 请求在后台走，不挡启动。
    const serviceStatusUrl = updaterService.getState().phase === 'disabled'
      ? null
      : locateServiceStatusUrl(
        app.isPackaged
          ? path.join(process.resourcesPath, 'app-update.yml')
          : path.join(app.getAppPath(), 'dev-app-update.yml'),
        { allowLocalHttp: !app.isPackaged },
      )
    const serviceStatusMonitor = serviceStatusUrl
      ? createServiceStatusMonitor({
        read: () => readServiceStatus({
          url: serviceStatusUrl,
          fetch: (url, init) => autoUpdater.netSession.fetch(url, init),
        }),
        onChange: (status) => {
          updaterService.setServiceStatus(status)
          runtimeLog.log('info', 'updater', 'service-status.changed', status?.maintenance ? '服务状态文件：正在维护' : '服务状态文件：没在维护', {
            maintenance: Boolean(status?.maintenance),
          })
        },
      })
      : null
    serviceStatusMonitor?.start()
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
        '本机为未签名更新通道，安装包签名未校验；下载后强制校验安装包 SHA-512，是否自动下载与安装跟随「自动更新」开关',
      )
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
        // 三个外部客户端同样只读上一次检测留下的快照：生成一份报告不该再去跑
        // 一轮 PowerShell 盘点。没检测过时那三行写「未能读取」。
        externalClients: systemService.getLastExternalClients(),
      })
    })
    // 「运行环境」段：系统里的 Node / npm / Python / Git、Codex 桌面端、网络位置
    // 同样只读上一次扫描的快照；其余几行是进程本来就知道的路径与区域设置，
    // 不起任何探测。
    runtimeLog.attachHostDescriber(async () => {
      let managedDirectory: string | null = null
      try {
        managedDirectory = managedCliRoot(process.env, process.platform)
      } catch {
        // ProgramData 解析不出来时这一行不出，报告照常生成。
      }
      return buildFeedbackRuntimeLines({
        snapshot: pickFeedbackRuntimeSnapshot(latestTraySystem),
        platform: process.platform,
        executionMode: process.platform === 'win32' ? windowsCliExecutionMode : null,
        executionProbeFailure: windowsCliExecution.probeFailure?.reason ?? null,
        certificateTrust: latestDiagnostics?.items.find((item) => item.code === 'CERTIFICATE_TRUST')?.summary ?? null,
        appDirectory: path.dirname(app.getPath('exe')),
        dataDirectory: managerDataDirectory,
        managedDirectory,
        locale: app.getLocale(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    })
    // 客服的第二个问题是「到底能不能用」——这答案用户在「检查」页点过一次就有
    // 了，没必要再让他截图发过来。只读上一次的结果，生成报告不重跑自检、不发
    // 网络请求。
    runtimeLog.attachSelfCheckDescriber(async () => buildFeedbackSelfCheckLines({
      report: latestDiagnostics,
      readConnection: (provider) => latestConnectionChecks.get(provider) ?? null,
      now: new Date(),
      // 诊断结论本身不该带 Key，但这份报告是要发到客服群里的，所以跟诊断导出
      // 过同一遍脱敏（I13）。
      redact: (value) => redactDiagnosticText(value, {
        ...rootedOptions.diagnosticExport,
        sensitiveValues: sensitiveKeyValues(),
      }),
    }))
    const desktopNotifications = createDesktopNotificationController({
      readEnabled: () => systemService.readStoredConfig().desktopNotifications !== false,
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
      readAutoUpdate: () => updaterService.autoUpdateEnabled(),
    })
    const unsubscribeDesktopNotifications = updaterService.subscribe((state) => desktopNotifications.handleUpdate(state))
    // 自动更新：上一次运行已经下好的版本，这次一打开就装上（见 auto-update-install.ts）。
    const launchedAt = Date.now()
    let launchInstallTried = false
    const unsubscribeAutoUpdateInstall = updaterService.subscribe((state) => {
      const downloaded = resolveDownloadedVersionToRecord(state, pendingUpdateRecord)
      if (downloaded) {
        pendingUpdateRecord = { ...pendingUpdateRecord, downloadedVersion: downloaded }
        void pendingUpdateStore.write(pendingUpdateRecord).catch((cause: unknown) => {
          runtimeLog.exception('updater', 'pending.record-failed', cause)
        })
      }
      // 退出交接还没接上时（主窗口没建好）不装：那时安装器发起的退出会被当成用户关窗。
      if (launchInstallTried || !updateQuitHandoff) return
      const version = decideLaunchInstall({
        autoUpdate: updaterService.autoUpdateEnabled(),
        snapshot: state,
        recordAtLaunch: pendingUpdateAtLaunch,
        elapsedSinceLaunchMs: Date.now() - launchedAt,
        busy: resolveInterruptibleInstallTask(systemService.inspectInstallationQueue()) !== null,
      })
      if (!version) return
      launchInstallTried = true
      runtimeLog.log('info', 'updater', 'install.on-launch', `上次已下载好 ${version}，启动时自动安装`)
      pendingUpdateRecord = { ...pendingUpdateRecord, attemptedVersion: version }
      // 先把「试过了」写稳再装：安装器起不来时，下次打开不会再试同一个版本。装之前先发
      // 一条系统通知、等几秒：窗口刚出来就自己关掉、再凭空弹出授权窗口，看着像闪退中毒。
      void pendingUpdateStore.write(pendingUpdateRecord).then(async () => {
        const notice = buildAutoInstallNotice(version, 'launch', process.platform)
        desktopNotifications.announce(notice)
        // 系统通知在专注助手、关了通知的电脑上会被静默吞掉，窗口里同时摆一张同样说法的卡。
        updaterService.setLaunchInstallNotice({ version, ...notice, installAt: Date.now() + LAUNCH_INSTALL_NOTICE_MS })
        await new Promise((resolve) => { setTimeout(resolve, LAUNCH_INSTALL_NOTICE_MS).unref() })
        // 等的这几秒里用户可能关了自动更新、开始装工具，或者这个版本被撤回了。
        const still = updaterService.autoUpdateEnabled()
          && resolveInstallableUpdateOnQuit(updaterService.getState())?.version === version
          && resolveInterruptibleInstallTask(systemService.inspectInstallationQueue()) === null
        if (!still) {
          updaterService.setLaunchInstallNotice(null)
          runtimeLog.log('info', 'updater', 'install.on-launch.skipped', `启动时自动安装 ${version} 前情况变了，留到退出时再装`)
          return
        }
        updaterService.install()
      }).catch((cause: unknown) => {
        updaterService.setLaunchInstallNotice(null)
        runtimeLog.exception('updater', 'install.on-launch.failed', cause)
      })
    })
    const urlPolicy = applicationUrlPolicy()
    registerApplicationProtocol(urlPolicy)
    const previewOnboarding = !app.isPackaged && process.env.XINGMANG_ONBOARDING_PREVIEW === '1'

    // Both realms commit accounts through the OS-backed encrypted vault. When
    // encryption is unavailable, Windows and macOS reject login; Linux signs in
    // for this run only (resolveCredentialPersistence). Existing files are never
    // touched either way.
    const safeStorageBackend = inspectSafeStorageBackend(safeStorage)
    const credentialPersistence = resolveCredentialPersistence(process.platform, safeStorageBackend)
    if (linuxPasswordStore) {
      // The detail key avoids "password": the log sanitizer would redact the value.
      runtimeLog.log('info', 'account', 'session.password-store', '桌面环境不在 Chromium 认识的名单里，已改用系统自带的密码保管', {
        selectedStore: linuxPasswordStore,
        backend: safeStorageBackend,
      })
    }
    if (safeStorageBackend !== 'ok') {
      runtimeLog.log(
        'warn',
        'account',
        'session.persist.unavailable',
        credentialPersistence === 'session-only'
          ? '这台电脑没法安全保存登录，本次登录只留在内存里，关掉软件后要重新登录；已有账号文件不动'
          : '系统未提供安全加密存储，请恢复系统凭据服务后登录；已有账号文件将保留',
        { backend: safeStorageBackend, persistence: credentialPersistence },
      )
    }
    const accountSessionStore = new AccountSessionStore(path.join(managerDataDirectory, 'account-session.dat'), safeStorage)
    const savedAccounts = new SavedAccountsStore(path.join(managerDataDirectory, 'saved-accounts.dat'), safeStorage)
    const vault = credentialPersistence === 'session-only' ? createSessionRealmAccountVault() : createFileRealmAccountVault(managerDataDirectory, safeStorage, {
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
    const accountIdentity = createAccountIdentityTracker()
    let acceleration: ReturnType<typeof createAccelerationService> | undefined
    async function accelerationRunning(): Promise<boolean> {
      const scope = readAccelerationAccountScope()
      if (!scope || !acceleration) return false
      const { phase } = await acceleration.getAccelerationState(scope)
      return phase === 'active' || phase === 'connecting' || phase === 'stopping'
    }
    // 系统代理指着一个已经关掉的代理软件时，星芒自己改走直连（更新那条路早就这么做）。
    // 只动 defaultSession，不落盘；装工具时给子进程的代理也按它 resolveProxy，一起跟着直连。
    const proxyBypass = createProxyBypass({
      probeUrl: () => {
        try { return relayStatusProbeUrl(resolveRelaySite(systemService.readStoredConfig().relaySiteId)) }
        catch { return null }
      },
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
      setProxy: (mode) => session.defaultSession.setProxy({ mode }),
      probe: (url) => probeDirectConnection((input, init) => net.fetch(input, init), url),
      accelerationActive: accelerationRunning,
      log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
    })
    // 系统代理活着却不转发时（代理软件换了线路、规则把账号服务挡了），账号请求只会
    // 一直超时。客户端在网络层失败后来问这一句，和登没登录无关；所以兜底必须建在
    // 账号服务之前，开机恢复登录的头一个请求就用得上。
    async function recoverAccountRequestOffProxy(failure: NewApiRetryOffProxyFailure): Promise<boolean> {
      const direct = await proxyBypass.recoverFailedRequest(failure.startedAt)
      if (direct) {
        runtimeLog.log('info', 'network', 'proxy-bypass.account-retry', '账号请求经系统代理没走通，已改直接联网', {
          reason: failure.reason,
          method: failure.method,
        })
      }
      return direct
    }
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
          retryOffProxy: recoverAccountRequestOffProxy,
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
        }, endSavedSession: async (record) => {
          if (record.realmId !== 'xm-account' || record.credential.kind !== 'new-api') return
          await client.endPersistedServerSession({ userId: Number(record.userId), cookies: [...record.credential.cookies] })
        } }
      },
      // The old files can only be read with the OS key; in session-only mode
      // there is nothing to import them into anyway.
      legacy: credentialPersistence === 'durable' ? { list: () => savedAccounts.list(), getSession: (id, origin) => savedAccounts.getSession(id, origin),
        readActive: () => accountSessionStore.read() } : undefined,
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
        const identity = buildAccountIdentity(siteId, state.account?.userId, accounts.client.getSessionRevision!())
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(ipcEventChannels.onAccountSessionChanged, state)
        }
        if (!accountIdentity.advance(identity)) return
        // 只在换了人时才让加速作废在路上的请求：续期换凭据、付款后刷新也会走到这里，
        // 那时推进加速的代数会让正在查的状态报「账号已变更」，查询途中还会把正在跑的加速停掉。
        void acceleration?.onAccountChanged().catch((error) => runtimeLog.exception('network', 'acceleration.account-change.failed', error))
        for (const business of businesses.values()) {
          business.chatService.cancelAll()
          business.imageService.cancelAll()
          business.canvasImageService.cancelAll()
          business.videoService.cancelAll()
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
          if (siteId === 'solov') void current.videoService.resumeUser(userId).catch((error) => runtimeLog.exception('canvas', 'video.resume.failed', error))
        }
      },
    })
    readAccountSiteId = () => accounts.getSiteId()
    const accountService = accounts.client
    readBillingAccountScope = () => {
      const state = accountService.getSessionState()
      const realm = accounts.getSiteId() === 'solov-api' ? 'api-account' : 'xm-account'
      return `${realm}:${state.authenticated && state.account ? state.account.userId : 'guest'}`
    }
    runtimeLog.attachAccountDescriber(() => {
      const state = accountService.getSessionState()
      return { authenticated: state.authenticated && Boolean(state.account), userId: state.account?.userId }
    })
    readExternalClientAccountId = () => {
      const state = accountService.getSessionState()
      return state.authenticated && state.account ? JSON.stringify([accounts.getSiteId(), state.account.userId]) : null
    }
    const accountWork = createAccountWorkGate({ assertReady: accounts.assertReady, revision: () => accountService.getSessionRevision!() })
    // Each realm moves its own subtree once per launch; a second realm object for
    // the same subtree must not start a second walk over files already moving.
    const aiOutputMigrations = new Set<string>()
    function migrateAiOutputOnce(from: string, to: string, mergeMetadata: (userId: number, content: string) => Promise<void>): void {
      if (aiOutputMigrations.has(from)) return
      aiOutputMigrations.add(from)
      void migrateLegacyAiOutput(from, to, { mergeMetadata }).then((result) => {
        if (!result.moved && !result.kept && !result.failed) return
        // Counts only: support needs to know whether anything stayed behind, not
        // where the user's files are (I13).
        runtimeLog.log(result.failed ? 'warn' : 'info', 'ai-chat', 'asset.output.migrated', '老版本的 AI 作品已搬到新的保存位置', { ...result })
      }).catch((error) => runtimeLog.exception('ai-chat', 'asset.output.migrate-failed', error))
    }
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
      const managedCliKeyStore = new ManagedCliKeyStore(roots.managedCliKeysFile, safeStorage, siteId, credentialPersistence)
      const chatKeyStore = new ChatKeyStore(roots.chatKeysFile, safeStorage, credentialPersistence)
      const chatCredentials = createChatCredentialCoordinator({ accountService, modelService: systemService, keyStore: chatKeyStore })
      // 「文档」不让写时改存到主目录下（ai-output-location.ts），检查页照实说。
      const aiOutputPlacement = chooseAiOutputRoot({
        isPackaged: app.isPackaged,
        projectRoot: path.join(__dirname, '..'),
        documentsDirectory: readDocumentsDirectory(),
        location: { platform: process.platform, home: os.homedir(), env: process.env },
        scope: (root) => roots.assetOutputDirectory(root),
      })
      const aiOutputRoot = aiOutputPlacement.root
      if (aiOutputPlacement.movedFromDocuments) {
        runtimeLog.log('warn', 'ai-chat', 'asset.output-directory.moved-from-documents', '「文档」不让写，AI 作品改存到个人文件夹', {
          earlierWorksLeftInDocuments: aiOutputPlacement.earlierWorksLeftInDocuments,
        })
      }
      const assetStore = new AiAssetStore({
        outputRoot: aiOutputRoot,
        // 全局保存位置在「文档」里，写不进多半是整个文档出了状况，用户自己能绕开的是
        // 画布项目：新项目的作品存在用户自己选的文件夹里。
        unwritableGuidance: '可以先在画布里新建一个项目、给它选一个自己的文件夹，在那里生成就能存下来；也可以联系客服。',
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
      // Create the output location at startup and prove it accepts a file, so a
      // location that cannot be written shows up in the log and on the check page
      // (AI_OUTPUT) before anyone pays for a generation. Every paid request probes
      // again, and the write path is still checked by AiAssetStore for each asset.
      void assetStore.assertWritable().catch((error) => {
        runtimeLog.log('warn', 'ai-chat', 'asset.output-directory.unavailable', 'AI 作品保存位置写不进去', {
          // The user-facing message only says "写不进去"; the log keeps the OS
          // reason (EACCES, EROFS, ENOSPC …) that support needs.
          reason: error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error),
        })
      })
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
      // 老版本存在可执行文件旁边的 output 里。画布、聊天记录只按作品编号找文件，
      // 搬的时候布局不变，老作品搬完照样能打开；搬的过程在后台，不拖慢启动。
      // 元数据合并交给正在用的这个 store，和搬家期间的收藏、新作品写入排同一个队。
      const legacyAiOutputRoot = resolveLegacyAiOutputRoot({ isPackaged: app.isPackaged, execPath: process.execPath })
      if (legacyAiOutputRoot) {
        migrateAiOutputOnce(roots.assetOutputDirectory(legacyAiOutputRoot), aiOutputRoot, (userId, content) => assetMetadata.mergeLegacy(userId, content))
      }
      // Permanent deletion hands the file to the OS recycle bin rather than
      // unlinking it. The bytes are the user's artwork; the last recoverable copy
      // should not depend on this program being right.
      const trashItem = (filePath: string) => shell.trashItem(filePath)
      const mediaAssets = createAiMediaAssetService({ images: assetStore, videos: videoAssets, audios: audioAssets, metadata: assetMetadata, trashItem })
      const canvasProjects = new CanvasProjectStore(roots.canvasProjectsDirectory)
      const createProjectAssetContext = (outputRoot: string) => {
        const images = new AiAssetStore({
          outputRoot,
          unwritableGuidance: '这个项目的文件夹可能被移走了，或者放不进新文件。请新建一个项目、换个文件夹再试。',
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
      const chatAttachments = createChatAttachmentService({
        store: assetStore,
        codec: nativeChatImageCodec,
        pickFiles: async () => {
          const result = await dialog.showOpenDialog({
            title: '选择要发给 AI 的图片',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
          })
          return result.canceled ? [] : result.filePaths
        },
        readClipboardImage: () => {
          const image = clipboard.readImage()
          return image.isEmpty() ? null : image.toPNG()
        },
      })
      const assetProtocol = createAiAssetProtocolHandler({
        assets: canvasProjectAssets,
        identities: createActiveIdentityReader(definition, { getSessionState: () => accountService.getSessionState(),
          getSessionRevision: () => accountService.getSessionRevision!() }),
        thumbnails: assetThumbnails,
      })
      const chatService = createAiChatService({
        onRequestStarted: onAiRequestStarted,
        readChatImage: (userId, assetId) => chatAttachments.readDataUri(userId, assetId),
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
          assertWritable: (userId, projectId) => canvasProjectAssets.assertWritable(userId, projectId),
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
          assertWritable: (userId, projectId) => canvasProjectAssets.assertWritable(userId, projectId),
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
        chatService, imageService, canvasImageService, videoService, canvasRuns, assetProtocol, chatAttachments, aiOutputPlacement }
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
      onTerminalState: (event, context) => {
        runtimeLog.log('info', 'payment', context.afterClose ? 'order.follow-up' : 'window.terminal',
          context.afterClose ? '支付窗口关闭后在后台确认到了订单结果' : '支付窗口已进入终态并自动关闭', {
            status: event.status,
            hasTradeNo: Boolean(event.tradeNo),
            ...(event.confirming ? { confirming: true } : {}),
          })
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(ipcEventChannels.onAccountPaymentWindowTerminal, event)
          }
        }
        // 关窗后才到账：人多半已经去干别的了。正看着星芒时界面上那条提示自己会变，不再弹。
        if (context.afterClose && event.status === 'success' && event.tradeNo) {
          const main = managedMainWindow
          const watching = Boolean(main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused())
          if (!watching) {
            try {
              hostNotifier()({
                event: 'paymentSettled',
                eventKey: event.tradeNo,
                onClick: () => {
                  if (managedMainWindow && !managedMainWindow.isDestroyed()) {
                    managedMainWindow.webContents.send(ipcEventChannels.onNavigate, 'topup')
                  }
                },
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
    // 首页那遍扫描不必等窗口和启动画面：和账号恢复一起现在就跑起来，渲染层随后那次读取
    // 直接接上它（scanSystem 同一时刻只跑一轮）。结果由那次读取照常交给托盘与日志。
    // 只在有账号要恢复时预热：没有账号的新用户先落在欢迎页，那里本来不检测工具；而
    // Windows 上一轮检测要起好几段 PowerShell，白跑一轮只是给欢迎页添负担。这几段
    // 权限检查已经先异步探测再读缓存（primeTrustedWindowsMachinePath），不占主线程。
    const launchedAtLogin = resolveLoginLaunch({
      platform: process.platform,
      argv: process.argv,
      wasOpenedAtLogin: () => app.getLoginItemSettings().wasOpenedAtLogin,
    })
    // 开机拉起时这几件后台事都往后挪：窗口第一次显示或满 3 分钟才开始（见 login-launch.ts）。
    // 加速要还原的系统代理不在其中，照原来的顺序先做。
    const startupQuiet = createLoginQuietPeriod({
      active: launchedAtLogin,
      durationMs: loginQuietPeriodMs,
      onEnd: (reason) => runtimeLog.log('info', 'main', 'launch.quiet-ended', reason === 'window-shown' ? '开机安静期结束：窗口已打开' : '开机安静期结束：已到时间', { reason }),
    })
    if (startupQuiet.active()) {
      runtimeLog.log('info', 'main', 'launch.quiet-started', '开机自动启动，检测和更新稍后再做', { durationMs: loginQuietPeriodMs })
      // 托盘在安静期里先用上次落盘的检测结果（能打开哪些工具），真扫描回来再换掉。
      void systemService.cachedScan({ startScan: false }).then((cached) => {
        if (cached && !latestTraySystem) { latestTraySystem = cached; applicationTray?.updateSnapshot() }
      }).catch(() => undefined)
    }
    void startupQuiet.whenOver().then(() => vault.active()).then((saved) => {
      if (saved) void systemService.scanSystem().catch(() => undefined)
    }).catch(() => undefined)
    // 以前装到一半被关掉留下的下载没人认领，低配电脑的 C 盘会被它慢慢吃掉。安静期过后再
    // 等一会儿，让开机那一阵的检测先跑完，再在后台清；不弹提示，只记日志。
    void startupQuiet.whenOver().then(() => new Promise<void>((resolve) => {
      setTimeout(resolve, installLeftoverStartupDelayMs).unref()
    })).then(() => systemService.cleanupInstallLeftovers()).catch(() => undefined)
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
      const state = accounts.client.getSessionState()
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(ipcEventChannels.onAccountSessionChanged, state)
      }
    })
    let developmentAcceleration: ReturnType<typeof createAccelerationDevelopmentHost> | undefined
    // 只看读文件这一步：后面建加速服务失败不是文件坏了，不能叫客户去翻杀毒软件。
    let accelerationBundleDamaged = false
    try {
      const read = await accelerationConfigRead
      if (!read.ok) {
        accelerationBundleDamaged = app.isPackaged
        throw read.error
      }
      const accelerationConfig = read.config
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
        // 启动辅助进程这一步以前把 errno 和原文一起吞掉，只留一句「本机加速进程
        // 启动失败。」。2026-09-22 客户机卡在临时目录上，就是因此只能靠反编译
        // 压缩产物才定位到。原因与底层错误都留在这里（日志会脱敏路径，I13）。
        onHelperFailure: (reason, error) => runtimeLog.exception('network', 'acceleration.helper.failed', error, {
          reason,
          // errno 单列一格：光看 message 分不清「目录建不出来」报的是没空间、
          // 没权限还是路径不存在，而这恰恰是客服要问用户的下一句话。
          ...(typeof (error as NodeJS.ErrnoException | null)?.code === 'string' ? { code: (error as NodeJS.ErrnoException).code } : {}),
          detail: accelerationFailureMessages[reason],
        }),
        // 加速中内核或辅助进程自己没了：网络设置由辅助进程（或宿主重拉的那一个）
        // 先改回去，这里负责读一次状态让各处跟上，并告诉用户网络现在是什么样。
        onRuntimeExited: () => accelerationInterruption?.runtimeExited(),
        onHelperExited: (recovered) => accelerationInterruption?.helperExited(recovered),
        onProxyRecoveryRetry: (attempt, recovered) => runtimeLog.log(recovered ? 'info' : 'warn', 'network', 'acceleration.recover.retry',
          recovered ? '重试后已把网络设置改回去' : '重试仍未能把网络设置改回去', { attempt }),
        // 登录后读一次加速状态就会拉起整份 Electron 辅助进程；从不用加速的人
        // 不该一直背着它。两分钟没人用、又确认没在加速就退，下次用到再拉。
        idleExitMs: 120_000,
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
    function showAccelerationPage() {
      if (managedMainWindow && !managedMainWindow.isDestroyed()) {
        managedMainWindow.webContents.send(ipcEventChannels.onNavigate, 'acceleration')
      }
    }
    // 时长快用完、以及用完自动断开的那一刻各发一条系统通知。放在主进程是因为
    // 窗口缩到托盘之后渲染层的计时与轮询都停着，而那正是用户在打游戏的时候。
    accelerationExpiry = createAccelerationExpiryNotice({
      notify: (stage, eventKey) => hostNotifier()({
        event: stage === 'expiring' ? 'accelerationExpiring' : 'accelerationExhausted',
        eventKey,
        onClick: showAccelerationPage,
      }),
      readState: (scope) => acceleration
        ? acceleration.getAccelerationState(scope)
        : Promise.reject(new Error('加速服务尚未就绪。')),
      log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
    })
    accelerationInterruption = createAccelerationInterruptionNotice({
      notify: (outcome, eventKey) => hostNotifier()({
        event: outcome === 'restored' ? 'accelerationInterrupted' : 'accelerationInterruptedUnrestored',
        eventKey,
        onClick: showAccelerationPage,
      }),
      readState: (scope) => acceleration
        ? acceleration.getAccelerationState(scope)
        : Promise.reject(new Error('加速服务尚未就绪。')),
      getAccountScope: () => readAccelerationAccountScope(),
      log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
    })
    acceleration = createAccelerationService({
      backend: developmentAcceleration,
      preferences: accelerationPreferences,
      ...(accelerationBundleDamaged ? { bundleDamaged: { recheck: async () => {
        const result = await recheckAccelerationBundle()
        runtimeLog.log(result === 'repaired' ? 'info' : 'warn', 'network', 'acceleration.config.recheck',
          result === 'repaired' ? '本机加速资源已恢复，重新打开软件后生效' : '本机加速资源仍未通过校验', { result })
        return result
      } } } : {}),
      getAccountScope: () => readAccelerationAccountScope(),
      onState: (state) => {
        trayAcceleration?.observe(state)
        accelerationExpiry?.observe(state)
        accelerationInterruption?.observe(state)
        codexDesktopAcceleration.observe(state)
      },
    })
    // 托盘上的连接与断开走的就是加速页那条路，线路与模式也用他在加速页上选过并
    // 落了盘的那一套，与打开 Codex 桌面端时自动连接同一口径。
    trayAcceleration = createTrayAccelerationCoordinator({
      getAccountScope: () => readAccelerationAccountScope(),
      readState: (scope) => acceleration
        ? acceleration.getAccelerationState(scope)
        : Promise.reject(new Error('加速服务尚未就绪。')),
      connect: async (scope, state) => {
        if (!acceleration) throw new Error('加速服务尚未就绪。')
        return acceleration.startAcceleration(scope, ...await accelerationStartArguments(scope, state))
      },
      disconnect: (scope) => acceleration
        ? acceleration.stopAcceleration(scope)
        : Promise.reject(new Error('加速服务尚未就绪。')),
      onChanged: () => applicationTray?.updateSnapshot(),
      log: (level, event, message, detail) => runtimeLog.log(level, 'network', event, message, detail),
    })
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
      app.once('will-quit', () => {
        powerMonitor.off('suspend', onSuspend)
        powerMonitor.off('resume', onResume)
      })
    }
    attachProxyBypassState(() => proxyBypass.active())
    const chatHistoryStore = createAiChatHistoryStore({ root: path.join(managerDataDirectory, 'chat-history') })
    const unregisterIpcHandlers = registerIpcHandlers({
      acceleration,
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
      keyReplacements: createManagedKeyReplacementStore({ filePath: path.join(managerDataDirectory, 'managed-key-replacements.json') }),
      chatKeyStore,
      chatCredentials,
      chatService,
      imageService,
      aiAssets: assetStore,
      chatAttachments,
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
      getWindowCapabilities: () => ({
        tray: applicationTray?.available ?? false,
        notifications: desktopNotifications.getCapability().supported,
        lowEndDevice,
        ...(settingsSaveIssue ? { settingsSaveIssue } : {}),
        ...(displayCompatPending ? { displayCompat: 'auto' as const } : {}),
        ...(unexpectedExit ? { unexpectedExit } : {}),
        ...(claudeDesktopRepaired ? { claudeDesktopRepaired: true as const } : {}),
      }),
      relaunchApp: () => requestRelaunch?.() ?? Promise.resolve(false),
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
      startupQuiet,
      onAccountBalance: (balance) => { latestTrayBalance = balance; applicationTray?.updateSnapshot() },
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
          return syncXingmangImageMcpConfigs(rootedOptions.system.providerRoots, invocation, {
            codex: !input.officialCodex,
          }).warnings
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
    app.once('will-quit', () => {
      cliHookEvents.dispose()
      cliKeepAwake.dispose()
      unsubscribeInstallKeepAwakeQueue()
      unsubscribeInstallKeepAwakeUpdate()
      installKeepAwake.dispose()
      accelerationExpiry?.dispose()
      codexDesktopAcceleration.dispose()
      accelerationInterruption?.dispose()
      void acceleration?.dispose().catch((error) => runtimeLog.exception('network', 'acceleration.shutdown.failed', error))
      void developmentAcceleration?.dispose().catch(() => undefined)
      runtimeLog.log('info', 'main', 'app.stopping', '应用主进程即将退出')
      process.off('uncaughtExceptionMonitor', onUncaughtException)
      process.off('unhandledRejection', onUnhandledRejection)
      if (periodicUpdateTimer) clearInterval(periodicUpdateTimer)
      serviceStatusMonitor?.dispose()
      unsubscribeDesktopNotifications()
      unsubscribeAutoUpdateInstall()
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
    const mainWindow = createWindow(systemService, urlPolicy, runtimeLog, () => shouldRevealInitialWindow({
      launchedAtLogin,
      trayAvailable: applicationTray?.available ?? false,
    }))
    managedMainWindow = mainWindow
    mainWindow.once('show', () => { startupQuiet.end('window-shown') })
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
    app.once('will-quit', () => {
      if (displayChangeTimer) clearTimeout(displayChangeTimer)
      screen.removeListener('display-removed', onDisplaysChanged)
      screen.removeListener('display-metrics-changed', onDisplaysChanged)
    })
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
          checkboxLabel: '记住我的选择，以后不再询问（可以在「设置 → 启动与关闭」里改）',
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
        const event = process.platform === 'darwin' ? 'hiddenToMenuBar' : 'hiddenToTray'
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
          // 托盘「退出」时主窗口通常是隐藏的，挂在隐藏窗口上的模态框用户看不见。
          if (!mainWindow.isVisible()) showMainWindow()
          const result = await dialog.showMessageBox(mainWindow, {
            type: 'question', title: '关闭星芒AI管理工具', message: '还在安装，现在退出会中断，确定退出？',
            detail: task.count > 1
              ? `${task.description}，另外还有 ${task.count - 1} 项安装排在后面。现在退出会中断它们，已经下载的部分下次要重新来过。`
              : `${task.description}。现在退出会中断它，已经下载的部分下次要重新来过。`,
            buttons: ['继续安装', '仍然退出'],
            defaultId: 0, cancelId: 0,
          })
          // 刚劝过一次的人不该紧接着再被问一句更新，这次退出就干净地退出。
          return result.response === 1 ? 'quit' : 'cancel'
        }
        let update = resolveInstallableUpdateOnQuit(updaterService.getState())
        if (!update) return 'quit'
        if (updaterService.autoUpdateEnabled()) {
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
        if (version && decideQuitInstall({ autoUpdate: updaterService.autoUpdateEnabled(), version, record: pendingUpdateRecord }) === 'install') {
          runtimeLog.log('info', 'window', 'quit.update-auto-install', `退出时自动安装更新：${version}`)
          // 退出时同一个版本只自动装一次：授权窗被点了「否」时软件已经退了，下次打开要从
          // 这条记录认出「没装上」，不再每次退出都弹授权窗口。写不进去也照装，最多多问一次。
          pendingUpdateRecord = { ...pendingUpdateRecord, quitAttemptedVersion: version }
          await pendingUpdateStore.write(pendingUpdateRecord).catch((cause: unknown) => {
            runtimeLog.exception('updater', 'pending.record-failed', cause)
          })
          desktopNotifications.announce(buildAutoInstallNotice(version, 'quit', process.platform))
          // 给系统一点时间把通知摆出来，再让安装器接手退出。
          await new Promise((resolve) => { setTimeout(resolve, QUIT_INSTALL_NOTICE_MS).unref() })
          return 'install-update'
        }
        runtimeLog.log('info', 'window', 'quit.update-downloaded', `退出前确认安装更新：${update.version ?? '版本未知'}`)
        if (!mainWindow.isVisible()) showMainWindow()
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: '关闭星芒AI管理工具',
          message: update.version ? `新版本 ${update.version} 已经下载好，顺手装上吗？` : '新版本已经下载好，顺手装上吗？',
          detail: '安装很快，装完会自动打开新版本。现在不装也行，更新会一直留着，下次退出时再问你。',
          buttons: ['安装并退出', '先退出，下次再装'],
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
      },
      // 开着加速时系统代理指着本机端口：关机前不还原，下次开机整台电脑上不了网。
      needsShutdownCleanup: () => {
        const hold = acceleration?.hasPossibleSession() === true
        if (hold) runtimeLog.log('info', 'window', 'shutdown.hold', '关机前先断开加速、还原系统代理')
        return hold
      },
      prepareToQuit: async () => {
        accountRestoreRetry.dispose()
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
    app.once('will-quit', () => { appWillQuit = true })
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
    app.once('will-quit', () => { process.off('uncaughtException', onUnexpectedException) })
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
    applicationTray = createApplicationTray({
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
            ...providerIds.filter((id) => latestTraySystem?.clis[id].installed).map((id) => ({ id, label: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex CLI' : id === 'gemini' ? 'Gemini CLI' : 'Grok CLI' })),
          ],
          update: resolveTrayUpdateEntry(updaterService.getState()),
          acceleration: trayAcceleration?.entry() ?? null,
        }
      },
      onOpen: showMainWindow,
      onNavigate: (target) => mainWindow.webContents.send(ipcEventChannels.onNavigate, target),
      onLaunchTool: (id) => { showMainWindow(); mainWindow.webContents.send(ipcEventChannels.onLaunchTool, id) },
      onAccelerationToggle: () => trayAcceleration?.toggle(),
      // 与更新页「确认重启安装」、IPC update:install 同一条路，退出交接与安装闸都在 install() 里。
      onInstallUpdate: () => { updaterService.install() },
      // 主窗口缩到托盘之后渲染层那边的加速轮询是停的，菜单弹出来这一刻是唯一
      // 能把剩余时长读新的时机；读一次，不起定时器。
      onMenuOpen: () => { trayAcceleration?.refresh() },
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
