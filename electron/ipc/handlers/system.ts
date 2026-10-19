// 主窗口业务通道的处理器：平台能力、本机环境与工具检测、启动时的 Codex 就绪检查。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { cliCatalog, isProviderId } from '../../catalog'
import { platformCapabilitiesFor } from '../../platform-capabilities'
import { parseSystemScanOptions } from '../parsers/system'
import { scanDetectionFailures } from './detection-failures'
import type { IpcHandlerContext } from './context'

export function registerSystemHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, logDetectionFailures } = ctx
  registerTrustedHandler('platform:get-capabilities', () => options.windowsProcessElevated
    ? Object.freeze({ ...platformCapabilitiesFor(), processElevated: true })
    : platformCapabilitiesFor())
  registerTrustedHandler('system:scan', async (_event, forceRefresh: unknown, input: unknown) => {
    if (forceRefresh !== undefined && typeof forceRefresh !== 'boolean') {
      throw new Error('更新检查参数格式错误')
    }
    const scanOptions = parseSystemScanOptions(input)
    if (scanOptions.recheckRoutes) options.onRouteRecheckRequested?.()
    // 上次的结果只用来先把首页画出来：不进托盘、不记「检测完成」，真结果回来再说。
    const quiet = options.startupQuiet?.active() === true
    const cached = scanOptions.acceptCached && forceRefresh !== true
      ? await service.cachedScan(quiet ? { startScan: false } : undefined)
      : null
    if (cached) return options.transformSystemSnapshot?.(cached) ?? cached
    await options.startupQuiet?.whenOver()
    const scanned = await service.scanSystem(forceRefresh === true)
    const snapshot = options.transformSystemSnapshot?.(scanned) ?? scanned
    options.onSystemSnapshot?.(snapshot)
    options.runtimeLog.log('info', 'system', 'scan.completed', '本机环境与 AI 工具检测完成', {
      runtime: Object.fromEntries(Object.entries(snapshot.runtime).map(([id, status]) => [id, {
        installed: status.installed,
        version: status.version,
      }])),
      clis: Object.fromEntries(Object.entries(snapshot.clis).map(([id, status]) => [id, {
        installed: status.installed,
        version: status.version,
        installDirectory: status.installDirectory,
        latestVersion: status.latestVersion,
        updateState: status.updateState,
        updateError: status.updateError,
      }])),
      codexDesktop: {
        installed: snapshot.desktopApps.codex.installed,
        detectionFailed: snapshot.desktopApps.codex.detectionFailed === true,
        detectionError: snapshot.desktopApps.codex.detectionError ?? null,
        appVersion: snapshot.desktopApps.codex.appVersion,
        version: snapshot.desktopApps.codex.version,
        mirrorVersion: snapshot.desktopApps.codex.mirrorVersion,
        mirrorUpdateAvailable: snapshot.desktopApps.codex.mirrorUpdateAvailable,
        mirrorError: snapshot.desktopApps.codex.mirrorError,
        installDirectory: snapshot.desktopApps.codex.installDirectory,
        latestVersion: snapshot.desktopApps.codex.latestVersion,
        updateState: snapshot.desktopApps.codex.updateState,
        updateError: snapshot.desktopApps.codex.updateError,
      },
    })
    for (const [provider, status] of Object.entries(snapshot.clis)) {
      if (!status.updateError) continue
      const name = isProviderId(provider) ? cliCatalog[provider].name : provider
      options.runtimeLog.log(
        'warn',
        'system',
        'cli.update-check.failed',
        `${name} 更新检测失败：${status.updateError}`,
        { provider, installedVersion: status.version },
      )
    }
    if (snapshot.desktopApps.codex.updateError) {
      options.runtimeLog.log(
        'warn',
        'system',
        'desktop.update-check.failed',
        `Codex 桌面端更新检测失败：${snapshot.desktopApps.codex.updateError}`,
        { installedVersion: snapshot.desktopApps.codex.version },
      )
    }
    logDetectionFailures(scanDetectionFailures(snapshot))
    return snapshot
  })
  registerTrustedHandler('system:refresh-network-location', () => service.refreshNetworkLocation())
  registerTrustedHandler('system:refresh-official-chatgpt', () => (
    service.refreshOfficialChatGptUsage()
  ))
  registerTrustedHandler('startup:codex-readiness', () => (
    service.inspectCodexReadiness(options.previewOnboarding)
  ))
}
