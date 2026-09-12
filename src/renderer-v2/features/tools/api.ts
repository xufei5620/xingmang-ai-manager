import type { CodexDesktopLaunchMode, XingmangApi } from '../../../../electron/ipc-contract'
import { providerFor, type ToolboxSnapshot, type ToolId } from './model'
import { readAllAccountKeys } from './key-selection'

export function createToolsApi(bridge: XingmangApi) {
  return {
    async read(force = false): Promise<ToolboxSnapshot> {
      const [system, config, platform] = await Promise.all([bridge.scanSystem(force), bridge.getConfig(), bridge.getPlatformCapabilities()])
      return { system, config, platform }
    },
    install: (id: ToolId) => id === 'codexDesktop' ? bridge.installCodexDesktop() : bridge.installCli(id),
    uninstall: (id: ToolId) => id === 'codexDesktop' ? bridge.uninstallCodexDesktop() : bridge.uninstallCli(id),
    checkUpdate: (id: ToolId) => id === 'codexDesktop' ? bridge.checkCodexDesktopUpdate() : bridge.checkCliUpdate(id),
    launch: (id: ToolId, workspace: string, mode: CodexDesktopLaunchMode = 'open') => id === 'codexDesktop'
      ? bridge.launchCodexDesktop(mode) : bridge.launchCli(id, workspace),
    prepareRuntime: (runtime: 'node' | 'python') => runtime === 'node' ? bridge.installNodeRuntime() : bridge.installPythonRuntime(),
    chooseWorkspace: () => bridge.chooseWorkspace(),
    recent: () => bridge.listProviderSessions({ page: 1, pageSize: 3 }),
    readConfig: () => bridge.getConfig(),
    readKeys: () => readAllAccountKeys((query) => bridge.getAccountKeys(query)),
    readKeyOptions: (tool: ToolId) => bridge.getAccountKeyOptions(providerFor(tool)),
    keyModels: (id: number) => bridge.listAccountKeyModels(id),
    configuredModels: (tool: ToolId) => bridge.listConfiguredModels(providerFor(tool)),
    manualModels: (key: string) => bridge.listModels(key),
    reveal: (tool: ToolId) => bridge.revealApiKey(providerFor(tool)),
    saveManual: (input: Parameters<XingmangApi['saveConfig']>[0]) => bridge.saveConfig(input),
    saveAccountKey: (input: Parameters<XingmangApi['saveConfigWithAccountKey']>[0]) => bridge.saveConfigWithAccountKey(input),
    configureManaged: (tool: ToolId, model?: string, mode: 'merge' | 'reset' = 'merge') => bridge.configureManagedCliKeys({
      providers: [providerFor(tool)], preferredModels: model ? { [providerFor(tool)]: model } : {}, mode,
    }),
    official: (tool: ToolId, mode: 'merge' | 'reset' = 'merge') => bridge.switchToOfficialAccount(providerFor(tool), mode),
    getLocale: () => bridge.inspectCodexDesktopLocale(),
    setLocale: () => bridge.setCodexDesktopLocale('zh-CN'),
    getPermissions: () => bridge.inspectCodexWorkspacePermissions(),
    trustWorkspace: () => bridge.trustCodexWorkspace(),
    officialUsage: () => bridge.refreshOfficialChatGptUsage(),
    async balanceUsage() {
      const now = new Date()
      const endTimestamp = Math.floor(now.getTime() / 1000)
      const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000)
      const [month, week] = await Promise.all([
        bridge.getAccountUsage({ type: 2, page: 1, pageSize: 1, startTimestamp: monthStart, endTimestamp }),
        bridge.getAccountUsage({ type: 2, page: 1, pageSize: 1, startTimestamp: endTimestamp - 7 * 86400, endTimestamp }),
      ])
      return { monthQuota: month.stats.quota, weekQuota: week.stats.quota }
    },
  }
}

export type ToolsApi = ReturnType<typeof createToolsApi>
