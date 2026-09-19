import {
  providerIds,
  type AppConfigSummary,
  type CodexDesktopLaunchMode,
  type ExternalToolId,
  type ProviderConfigSummary,
  type ProviderId,
  type XingmangApi,
} from '../../../../electron/ipc-contract'
import { providerFor, type ToolboxSnapshot, type ToolId } from './model'
import { readAllAccountKeys } from './key-selection'
import { errorMessage } from '../../business-common'
import { usageCalendarDate, usageDateRange } from '../../../../electron/usage-date-range'

/** 工具页一次读取里互相独立的三块。 */
export type ToolboxPartition = 'system' | 'config' | 'platform'

export interface ToolboxPartitionFailure {
  partition: ToolboxPartition
  message: string
}

export interface ToolboxReadResult {
  /**
   * system 或 platform 读失败时为 null。这两块是工具列表本身，
   * 缺了没有东西可渲染；config 只决定每一行的连接状态，
   * 所以它失败时降级而不连坐整页。
   */
  snapshot: ToolboxSnapshot | null
  failures: ToolboxPartitionFailure[]
}

/**
 * 配置读不出来时的占位表。每个工具都落到「未配置」，让工具列表、
 * 安装和卸载照常可用；真正的原因由分区错误单独告诉用户，不靠这张表去表达。
 */
function placeholderConfig(): AppConfigSummary {
  const providers = {} as Record<ProviderId, ProviderConfigSummary>
  for (const provider of providerIds) {
    providers[provider] = {
      baseUrl: '', actualBaseUrl: '', exists: false, hasApiKey: false, matchesRelay: false,
      apiKeyPreview: null, model: '', dataDirectory: '', dataDirectoryExists: false,
      files: [], updatedAt: null,
    }
  }
  return { workspace: '', providers }
}

export function createToolsApi(bridge: XingmangApi) {
  return {
    /**
     * 三块分开结算（对照 legacy 的 runCoordinatedScan）。一份损坏的
     * CLI 配置文件曾经能让整个工具页空白，用户连重新配置的入口都找不到。
     */
    async read(force = false): Promise<ToolboxReadResult> {
      const [system, config, platform] = await Promise.allSettled([
        bridge.scanSystem(force), bridge.getConfig(), bridge.getPlatformCapabilities(),
      ])
      const failures: ToolboxPartitionFailure[] = []
      if (system.status === 'rejected') failures.push({ partition: 'system', message: errorMessage(system.reason, '工具检测没有完成，请重试。') })
      if (config.status === 'rejected') failures.push({ partition: 'config', message: errorMessage(config.reason, '工具配置没有读到，请重试。') })
      if (platform.status === 'rejected') failures.push({ partition: 'platform', message: errorMessage(platform.reason, '当前系统支持的操作没有读到，请重试。') })
      if (system.status !== 'fulfilled' || platform.status !== 'fulfilled') return { snapshot: null, failures }
      return {
        snapshot: {
          system: system.value,
          config: config.status === 'fulfilled' ? config.value : placeholderConfig(),
          platform: platform.value,
        },
        failures,
      }
    },
    readExternal: () => bridge.scanExternalClients(),
    installExternal: (id: ExternalToolId) => bridge.installExternalClient(id),
    launchExternal: (id: ExternalToolId) => bridge.launchExternalClient(id),
    // version 省略时由主进程按已验证版本名单与设置决定装哪个版本(N1);
    // 只有「回到推荐版本」会点名版本。
    install: (id: ToolId, version?: string) => id === 'codexDesktop' ? bridge.installCodexDesktop() : bridge.installCli(id, version),
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
      providers: [providerFor(tool)], preferredModels: model ? { [providerFor(tool)]: model } : {}, mode, intent: 'explicit',
    }),
    official: (tool: ToolId, mode: 'merge' | 'reset' = 'merge') => bridge.switchToOfficialAccount(providerFor(tool), mode),
    getLocale: () => bridge.inspectCodexDesktopLocale(),
    setLocale: () => bridge.setCodexDesktopLocale('zh-CN'),
    getPermissions: () => bridge.inspectCodexWorkspacePermissions(),
    trustWorkspace: () => bridge.trustCodexWorkspace(),
    officialUsage: () => bridge.refreshOfficialChatGptUsage(),
    async balanceUsage() {
      const now = new Date()
      const session = await bridge.getAccountSession()
      const calendar = session.siteId === 'solov-api' || session.realmId === 'api-account'
      const dates = usageDateRange({}, now)
      const monthDate = `${usageCalendarDate(now, dates.timezone).slice(0, 7)}-01`
      const endTimestamp = Math.floor(now.getTime() / 1000)
      const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000)
      const [month, week] = await Promise.all([
        bridge.getAccountUsage(calendar ? { ...dates, startDate: monthDate, page: 1, pageSize: 1 }
          : { type: 2, page: 1, pageSize: 1, startTimestamp: monthStart, endTimestamp }),
        bridge.getAccountUsage(calendar ? { ...dates, page: 1, pageSize: 1 }
          : { type: 2, page: 1, pageSize: 1, startTimestamp: endTimestamp - 7 * 86400, endTimestamp }),
      ])
      return { monthQuota: month.stats.quota, weekQuota: week.stats.quota }
    },
  }
}

export type ToolsApi = ReturnType<typeof createToolsApi>
