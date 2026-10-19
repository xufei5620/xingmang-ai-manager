// 主窗口业务通道的处理器：窗口模式与主题、托盘能力、重开与卸载星芒、外链、网络设置、画布窗口。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { ExternalUrlBlockedError } from '../../external-url-blocked'
import { providerIds } from '../../catalog'
import { isAllowedExternalUrl } from '../../security'
import { isNetworkSettingsKind } from '../../proxy-bypass'
import { parseAppUninstallRequest } from '../parsers/system'
import type { IpcHandlerContext } from './context'

export function registerWindowHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, externalShell, readBackupAccountContext } = ctx
  registerTrustedHandler('window:set-mode', (event, mode: unknown) => {
    if (mode !== 'onboarding' && mode !== 'dashboard') throw new Error('未知的窗口模式')
    options.setWindowMode(event.sender, mode)
  })
  registerTrustedHandler('window:set-theme', async (event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark') throw new Error('未知的主题')
    await service.updateStoredConfig({ version: 2, theme })
    options.setWindowTheme(event.sender, theme)
  })
  registerTrustedHandler('window:get-capabilities', () => options.getWindowCapabilities?.() ?? { tray: false, notifications: false })
  registerTrustedHandler('window:relaunch', () => options.relaunchApp?.() ?? false)
  registerTrustedHandler('window:uninstall-app', async (_event, raw: unknown) => {
    const request = parseAppUninstallRequest(raw)
    if (!options.uninstallApp) throw new Error('这台电脑上请用系统自带的方式卸载星芒')
    options.runtimeLog.log('info', 'maintenance', 'app.uninstall.started', '开始卸载星芒', { ...request })
    const result = await options.uninstallApp(request, async () => {
      const context = await readBackupAccountContext()
      for (const provider of providerIds) {
        // 没配过的工具没有东西可备份，一家失败不耽误下一家。
        try { options.backupStore.create(provider, 'pre-save', undefined, context) } catch { /* 见上 */ }
      }
    })
    options.runtimeLog.log(result.trashed ? 'info' : 'warn', 'maintenance', 'app.uninstall.finished', result.trashed ? '星芒已移到废纸篓，正在退出' : '星芒没能移到废纸篓', {
      trashed: result.trashed,
      leftovers: result.leftovers.join(','),
    })
    return result
  })
  registerTrustedHandler('navigation:take-deep-link', (event) => options.takeExternalDeepLink?.(event.sender) ?? null)
  registerTrustedHandler('external:open', async (_event, url: unknown) => {
    if (
      typeof url !== 'string'
      || !isAllowedExternalUrl(url, options.externalUrlAllowlist)
    ) {
      throw new ExternalUrlBlockedError()
    }
    await externalShell.openExternal(url)
    return true
  })
  registerTrustedHandler('network:bypass-broken-proxy', () => options.bypassBrokenProxy?.() ?? 'unavailable')
  registerTrustedHandler('network:open-settings', async (_event, kind: unknown) => {
    if (!isNetworkSettingsKind(kind)) throw new Error('未知的网络设置页')
    return await options.openNetworkSettings?.(kind) ?? false
  })
  registerTrustedHandler('canvas:open', () => options.openCanvasWindow())
}
