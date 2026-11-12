// 主窗口业务通道的处理器：读写星芒自己的设置。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import os from 'node:os'
import type { AppSettingsUpdate } from '../../app-settings'
import { isRecord } from '../../input-guards'
import { shouldRememberWorkspace } from '../../workspace-guard'
import { parseSettingsUpdate } from '../parsers/settings'
import type { IpcHandlerContext } from './context'

// 设置页「更换」先走 workspace:choose，选到系统文件夹或存密钥的文件夹、点了「仍然打开」，那边按规矩
// 不记住，可紧接着设置页又把同一个目录送到这里来存。跟选择器认同一条规矩：这种目录不存，留着原来那个。
function withoutUnrememberedWorkspace(update: AppSettingsUpdate, platform: NodeJS.Platform, home: string): AppSettingsUpdate {
  if (update.workspace === undefined || shouldRememberWorkspace(update.workspace, { platform, home })) return update
  const kept = { ...update }
  delete kept.workspace
  return kept
}

export function registerSettingsHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service } = ctx
  registerTrustedHandler('settings:get', () => service.readStoredConfig())
  registerTrustedHandler('settings:save', async (event, settings: unknown) => {
    if (isRecord(settings) && settings.activeRelayEndpointIds !== undefined) {
      const active = service.readStoredConfig().activeRelayEndpointIds
      const echo = settings.activeRelayEndpointIds
      // The frozen legacy renderer sends the full settings object back. An
      // unchanged read-only echo is harmless; a renderer cannot choose the
      // active route or make a pending preference look already effective.
      if (!active || !isRecord(echo) || Object.keys(echo).length !== Object.keys(active).length
        || Object.entries(echo).some(([siteId, endpointId]) => !Object.prototype.hasOwnProperty.call(active, siteId)
          || active[siteId as keyof typeof active] !== endpointId)) {
        throw new Error('当前连接线路只读，请保存线路选择后重开软件')
      }
    }
    const update = withoutUnrememberedWorkspace(parseSettingsUpdate(settings, process.platform), process.platform, os.homedir())
    const next = await service.updateStoredConfig(update)
    // Side effects read the MERGED record, not the raw update: a narrow
    // update (e.g. the sidebar toggle) carries no workspace/theme of its own.
    options.extensionService.setRepositoryContext(next.workspace)
    options.providerExtensionService.setRepositoryRoot(next.workspace)
    options.setWindowTheme(event.sender, next.theme)
    options.onSettingsChanged?.(update)
    return next
  })
}
