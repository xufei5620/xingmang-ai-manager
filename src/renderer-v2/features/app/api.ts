import type { XingmangApi } from '../../../../electron/ipc-contract'

export function createAppApi(bridge: XingmangApi) {
  return {
    bridge,
    async bootstrap() {
      const [settings, platform, session, update, capabilities, config] = await Promise.all([
        bridge.getSettings(), bridge.getPlatformCapabilities(), bridge.getAccountSession(),
        bridge.getUpdateState(), bridge.getWindowCapabilities(),
        bridge.getConfig(),
      ])
      return { settings, platform, session, update, capabilities, config }
    },
    session: () => bridge.getAccountSession(),
    balance: () => bridge.getAccountBalance(),
    logout: () => bridge.logoutAccount(),
    savePreferences: (patch: Parameters<XingmangApi['saveSettings']>[0]) => bridge.saveSettings(patch),
    startupUpdate: () => bridge.runStartupUpdate(),
    openCanvas: () => bridge.openCanvasWindow(),
    openExternal: (url: string) => bridge.openExternal(url),
    announcement: () => bridge.getAccountNotice(),
  }
}
