import type { XingmangApi } from '../../../../electron/ipc-contract'
import type { RelayNoticeReadMode } from '../../../../electron/relay-backend'

export function createAppApi(bridge: XingmangApi) {
  return {
    bridge,
    async bootstrap() {
      const [settings, platform, session, update, capabilities] = await Promise.all([
        bridge.getSettings(), bridge.getPlatformCapabilities(), bridge.getAccountSession(),
        bridge.getUpdateState(), bridge.getWindowCapabilities(),
      ])
      return { settings, platform, session, update, capabilities }
    },
    session: () => bridge.getAccountSession(),
    balance: () => bridge.getAccountBalance(),
    logout: () => bridge.logoutAccount(),
    readSettings: () => bridge.getSettings(),
    savePreferences: (patch: Parameters<XingmangApi['saveSettings']>[0]) => bridge.saveSettings(patch),
    startupUpdate: () => bridge.runStartupUpdate(),
    relaunch: () => bridge.relaunchApp(),
    openCanvas: () => bridge.openCanvasWindow(),
    // 画布首页的只读素材库（只列图片），主窗口「看全部作品」用。
    openCanvasAssets: () => bridge.openCanvasAssetLibrary(),
    openExternal: (url: string) => bridge.openExternal(url),
    announcement: (mode?: RelayNoticeReadMode) => mode === undefined ? bridge.getAccountNotice() : bridge.getAccountNotice(mode),
    markAnnouncementRead: (id: string, entryId: string) => bridge.markAccountNoticeRead(id, entryId),
    syncLocalNoticeReads: (scope: string, ids: string[]) => bridge.syncLocalNoticeReads(scope, ids),
  }
}
