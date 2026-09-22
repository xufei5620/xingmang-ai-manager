import {
  providerIds,
  type AppConfigSummary,
  type CliLaunchMode,
  type CodexDesktopLaunchMode,
  type ExternalToolId,
  type InstallCancelResult,
  type ProviderConfigSummary,
  type ProviderId,
  type XingmangApi,
} from '../../../../electron/ipc-contract'
import { providerFor, type ToolboxSnapshot, type ToolId } from './model'
import { readAllAccountKeys } from './key-selection'
import { errorMessage } from '../../business-common'
import { createTtlCache } from './ttl-cache'
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
 * 把重读到的配置并回快照，system / platform 两块原样保留——它们是首屏那遍扫描
 * 刚探完的，不该因为写了一次 Key 就作废。没有快照时保持 null（还没有东西可并）。
 */
export function withToolboxConfig(snapshot: ToolboxSnapshot | null, config: AppConfigSummary): ToolboxSnapshot | null {
  return snapshot ? { ...snapshot, config } : null
}

/** 只重读配置这一块时的结果：读成功给配置，读失败给一条分区错误。 */
export interface ToolboxConfigReadResult {
  config: AppConfigSummary | null
  failure: ToolboxPartitionFailure | null
}

/**
 * 换上新的 config 分区错误：同一时刻 config 只可能有一条，所以先把旧的那条摘掉，
 * 再按需要补上。读成功时传 null，等于把上一次的失败清掉。
 */
export function withConfigFailure(
  failures: readonly ToolboxPartitionFailure[],
  failure: ToolboxPartitionFailure | null,
): ToolboxPartitionFailure[] {
  const rest = failures.filter((entry) => entry.partition !== 'config')
  return failure ? [...rest, failure] : rest
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

/**
 * 最近记录的缓存有效期。首页是切来切去最频繁的一页，离开就卸载、回来又读一遍，
 * 而主进程那一侧要把三家 CLI 的会话目录整个走一遍才能给出这份列表。一分钟内
 * 复用上一次的结果，真正变了的时刻（装卸工具、打开工具、换账号、主动重新检测）
 * 都有对应的作废点，不靠把时间调短来兜底。
 */
export const recentSessionsTtlMs = 60_000

export function createToolsApi(bridge: XingmangApi) {
  const recentSessions = createTtlCache({
    ttlMs: recentSessionsTtlMs,
    load: () => bridge.listProviderSessions({ page: 1, pageSize: 60 }),
  })
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
    /**
     * 只重读配置这一块，不碰 scanSystem。账号 Key 刚写完时界面要更新的只有
     * 配置状态，已装/版本/桌面端几秒前刚探完，没必要再起一轮探测子进程，
     * 也没必要把主进程里的 npm 版本与网络位置缓存清掉重来（开机那十秒最贵的
     * 就是这一遍）。失败不抛：config 分区本来就按降级处理，见 read 的注释。
     */
    async readConfigPartition(): Promise<ToolboxConfigReadResult> {
      try {
        return { config: await bridge.getConfig(), failure: null }
      } catch (cause) {
        return { config: null, failure: { partition: 'config', message: errorMessage(cause, '工具配置没有读到，请重试。') } }
      }
    },
    readExternal: (force = false) => bridge.scanExternalClients(force),
    installExternal: (id: ExternalToolId) => bridge.installExternalClient(id),
    launchExternal: (id: ExternalToolId) => bridge.launchExternalClient(id),
    // version 省略时由主进程按已验证版本名单与设置决定装哪个版本(N1);
    // 只有「回到推荐版本」会点名版本。
    install: async (id: ToolId, version?: string) => {
      const result = await (id === 'codexDesktop' ? bridge.installCodexDesktop() : bridge.installCli(id, version))
      recentSessions.invalidate()
      return result
    },
    cancelInstall: (id: ToolId): Promise<InstallCancelResult> => id === 'codexDesktop'
      ? bridge.cancelCodexDesktopInstall()
      : bridge.cancelCliInstall(id),
    uninstall: async (id: ToolId) => {
      const result = await (id === 'codexDesktop' ? bridge.uninstallCodexDesktop() : bridge.uninstallCli(id))
      recentSessions.invalidate()
      return result
    },
    checkUpdate: (id: ToolId) => id === 'codexDesktop' ? bridge.checkCodexDesktopUpdate() : bridge.checkCliUpdate(id),
    // mode 是两套互不相干的取值:codexDesktop 认 'open' | 'restart',四家 CLI 认
    // 'new' | 'resumeLast'(#292)。各自只取自己认得的那一个,另一套的值落回本侧
    // 默认,也就是旧行为。以前这里的 CLI 分支根本没把 mode 传下去,首页和记录页
    // 都发不出「接着上次对话」。
    launch: async (id: ToolId, workspace: string, mode: CodexDesktopLaunchMode | CliLaunchMode = 'open') => {
      const result = await (id === 'codexDesktop'
        ? bridge.launchCodexDesktop(mode === 'restart' ? 'restart' : 'open')
        : mode === 'resumeLast' ? bridge.launchCli(id, workspace, 'resumeLast') : bridge.launchCli(id, workspace))
      // 打开工具就是在开一条新对话（或接上一条），首页那份「最近」立刻就旧了。
      recentSessions.invalidate()
      return result
    },
    prepareRuntime: (runtime: 'node' | 'python') => runtime === 'node' ? bridge.installNodeRuntime() : bridge.installPythonRuntime(),
    restartWindows: () => bridge.restartWindows(),
    chooseWorkspace: () => bridge.chooseWorkspace(),
    // 首页「最近」卡只显示 3 条,但同一份记录还要推出每个工具最近用过的目录(N7),
    // 一页 3 条不够铺开四个工具。主进程本来就把全部会话读出来再切片,页大一点不多花钱。
    recent: () => recentSessions.read(),
    /** 让首页那份「最近」立刻作废：用户主动重新检测、切换账号时调。 */
    invalidateRecent: () => recentSessions.invalidate(),
    readConfig: () => bridge.getConfig(),
    readKeys: () => readAllAccountKeys((query) => bridge.getAccountKeys(query)),
    readKeyOptions: (tool: ToolId) => bridge.getAccountKeyOptions(providerFor(tool)),
    keyModels: (id: number) => bridge.listAccountKeyModels(id),
    configuredModels: (tool: ToolId) => bridge.listConfiguredModels(providerFor(tool)),
    manualModels: (key: string) => bridge.listModels(key),
    reveal: (tool: ToolId) => bridge.revealApiKey(providerFor(tool)),
    // 只打开工具自己的配置目录，不打开里面任何文件；Codex 桌面端与 Codex CLI
    // 共用一份配置，所以两行打开的是同一个文件夹。
    openConfigDirectory: (tool: ToolId) => bridge.openProviderConfigDirectory(providerFor(tool)),
    // 只传会话 id：工作目录由主进程从记录里取并校验，渲染层不传任意路径。
    openSessionDirectory: (sessionId: string) => bridge.openProviderSessionDirectory(sessionId),
    saveManual: (input: Parameters<XingmangApi['saveConfig']>[0]) => bridge.saveConfig(input),
    saveAccountKey: (input: Parameters<XingmangApi['saveConfigWithAccountKey']>[0]) => bridge.saveConfigWithAccountKey(input),
    configureManaged: (tool: ToolId, model?: string, mode: 'merge' | 'reset' = 'merge') => bridge.configureManagedCliKeys({
      providers: [providerFor(tool)], preferredModels: model ? { [providerFor(tool)]: model } : {}, mode, intent: 'explicit',
    }),
    official: (tool: ToolId, mode: 'merge' | 'reset' = 'merge') => bridge.switchToOfficialAccount(providerFor(tool), mode),
    getLocale: () => bridge.inspectCodexDesktopLocale(),
    setLocale: (locale: 'zh-CN' | 'system' = 'zh-CN') => bridge.setCodexDesktopLocale(locale),
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
