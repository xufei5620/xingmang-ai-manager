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
    openExternal: (url: string) => bridge.openExternal(url),
    announcement: (mode?: RelayNoticeReadMode) => mode === undefined ? bridge.getAccountNotice() : bridge.getAccountNotice(mode),
    // 公告里官网自己的图由主进程下好再交回（决定单 D89 a）。
    announcementImage: (url: string) => bridge.getAccountNoticeImage(url),
    markAnnouncementRead: (id: string, entryId: string) => bridge.markAccountNoticeRead(id, entryId),
    syncLocalNoticeReads: (scope: string, ids: string[]) => bridge.syncLocalNoticeReads(scope, ids),
  }
}
