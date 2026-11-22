// 主窗口业务通道的处理器：窗口模式与主题、托盘能力、重开与卸载星芒、外链、网络设置、画布窗口。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { ExternalUrlBlockedError } from '../../external-url-blocked'
import { providerIds } from '../../catalog'
import { resolveAllowedExternalUrl } from '../../security'
import { isNetworkSettingsKind } from '../../proxy-bypass'
import { parseAppUninstallRequest, parseRendererActivity } from '../parsers/system'
import type { IpcHandlerContext } from './context'

export function registerWindowHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, externalShell, readBackupAccountContext } = ctx
  registerTrustedHandler('window:set-mode', (event, mode: unknown) => {
    if (mode !== 'onboarding' && mode !== 'dashboard') throw new Error('未知的窗口模式')
    options.setWindowMode(event.sender, mode)
  })
  registerTrustedHandler('window:set-theme', async (event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark') throw new Error('未知的主题')
    // 先换窗口颜色，再记进设置文件。这份记录只管下次开窗头一帧的底色，界面每次开机都按系统外观再发
    // 一遍；C 盘满或杀毒锁住文件写不进去时，不该让这次标题栏和页面停在旧颜色上、再弹一张「系统外观
    // 没有同步」，记一条日志，下次开机照旧再记（0.2.24 性能深查 R4）。
    options.setWindowTheme(event.sender, theme)
    try {
      await service.updateStoredConfig({ version: 2, theme })
    } catch (error) {
      options.runtimeLog.log('warn', 'window', 'window.theme.save-failed', '深浅色已经换上，没能记进设置文件', {
        theme,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  })
  registerTrustedHandler('window:get-capabilities', () => options.getWindowCapabilities?.() ?? { tray: false, notifications: false })
  registerTrustedHandler('window:report-activity', (event, raw: unknown) => {
    const activity = parseRendererActivity(raw)
    options.onRendererActivity?.(event.sender, activity)
  })
  registerTrustedHandler('window:relaunch', () => options.relaunchApp?.() ?? false)
  registerTrustedHandler('window:uninstall-app', async (_event, raw: unknown) => {
    const request = parseAppUninstallRequest(raw)
    if (!options.uninstallApp) throw new Error('请在本机使用系统自带的方式卸载星芒')
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
    const allowedUrl = typeof url === 'string' ? resolveAllowedExternalUrl(url, options.externalUrlAllowlist) : null
    if (allowedUrl === null) throw new ExternalUrlBlockedError()
    await externalShell.openExternal(allowedUrl)
    return true
  })
  registerTrustedHandler('network:bypass-broken-proxy', () => options.bypassBrokenProxy?.() ?? 'unavailable')
  registerTrustedHandler('network:open-settings', async (_event, kind: unknown) => {
    if (!isNetworkSettingsKind(kind)) throw new Error('未知的网络设置页')
    return await options.openNetworkSettings?.(kind) ?? false
  })
  registerTrustedHandler('canvas:open', () => options.openCanvasWindow())
  // 「创作」左边那一列里的画布项目（融合第 1 步）。这两条只在主窗口这一侧，画布窗口够不着（I4），画布那边一个能力都没加：
  // 列出来的只有编号、名字和时间；打开时编号原样交给 canvas-window.ts，由它在当前账号的项目里认过才用（I5）。
  registerTrustedHandler('canvas:list-projects', () => {
    if (!options.listCanvasProjects) throw new Error('画布项目读取失败')
    return options.listCanvasProjects()
  })
  registerTrustedHandler('canvas:open-project', (_event, projectId: unknown) => {
    if (!options.openCanvasProject) throw new Error('画布项目暂时无法打开')
    return options.openCanvasProject(projectId)
  })
}
