/**
 * 开发期专用：在「没有 Electron preload」的纯浏览器里补一个假的 window.xingmang。
 *
 * 打包后的桌面版永远走真实 preload——本文件只在 import.meta.env.DEV 下被
 * main.tsx 引入，生产构建里会被 Vite 整块摇掉（见 main.tsx 的动态 import 守卫）。
 * 存在的唯一理由：让 UI 能在 v0 / 浏览器预览里渲染出来做视觉走查，
 * 而不是因为 window.xingmang 是 undefined 就整棵树白屏。
 *
 * 约定：
 * - 只在 window.xingmang 缺失时安装，真实 preload 在场时绝不覆盖。
 * - 已显式实现的方法返回结构正确的假数据；其余方法走 Proxy 兜底：
 *   on* 订阅返回一个空的退订函数，其他调用打一条 warn 并 resolve。
 * - 任何写操作都不落盘、不发网络请求。
 */
import type {
  AccountBalance,
  AccountDashboardData,
  AccountKeysPage,
  AccountProfile,
  AccountProfileDetail,
  AccountSessionState,
  AccountSubscriptionSelf,
  AccountTaskPage,
  AccountTopupInfo,
  AccountTopupOrdersPage,
  AccountUsableGroup,
  AccountUsagePage,
  AppConfigSummary,
  AppSettingsV2,
  CliStatus,
  CodexReadinessStatus,
  CodexSetupStatus,
  DesktopAppStatus,
  DiagnosticsReport,
  ExtensionSnapshot,
  McpServer,
  PlatformCapabilities,
  PluginCatalog,
  ProviderConfigSummary,
  ProviderId,
  RepositoryContext,
  SkillItem,
  SystemSnapshot,
  ToolStatus,
  UpdateSnapshot,
  XingmangApi,
} from './types'

const now = () => new Date().toISOString()
const workspace = '/Users/xingmang/projects/demo'

const installedNode: ToolStatus = {
  installed: true,
  version: 'v22.11.0',
  path: '/usr/local/bin/node',
  installDirectory: '/usr/local/bin',
  versionStatus: 'supported',
}

const installedNpm: ToolStatus = {
  installed: true,
  version: '10.9.0',
  path: '/usr/local/bin/npm',
  installDirectory: '/usr/local/bin',
}

const installedPython: ToolStatus = {
  installed: true,
  version: '3.12.6',
  path: '/usr/local/bin/python3',
  installDirectory: '/usr/local/bin',
}

function cliStatus(version: string, latestVersion = version): CliStatus {
  return {
    installed: true,
    version,
    path: `/usr/local/bin/cli`,
    installDirectory: '/usr/local/bin',
    versionStatus: 'supported',
    latestVersion,
    updateAvailable: latestVersion !== version,
    updateCheck: 'checked',
    updateState: latestVersion !== version ? 'available' : 'latest',
    updateCheckedAt: now(),
    updateError: null,
    uninstall: { available: false, reason: '浏览器预览不支持卸载', manualCommand: null },
  } satisfies CliStatus
}

const desktopStatus: DesktopAppStatus = {
  installed: true,
  version: '1.8.2',
  path: '/Applications/Codex.app',
  installDirectory: '/Applications',
  appVersion: '1.8.2',
  mirrorVersion: '1.8.2',
  mirrorUpdateAvailable: false,
  mirrorError: null,
  running: false,
}

function providerConfig(model: string, configured: boolean): ProviderConfigSummary {
  return {
    baseUrl: 'https://api.xingmang.ai/v1',
    actualBaseUrl: configured ? 'https://api.xingmang.ai/v1' : '',
    exists: configured,
    hasApiKey: configured,
    matchesRelay: configured,
    apiKeyPreview: configured ? 'sk-xm••••••••a91f' : null,
    model,
    dataDirectory: `${workspace}/.config`,
    dataDirectoryExists: true,
    files: [],
    updatedAt: configured ? now() : null,
  } as ProviderConfigSummary
}

const settings: AppSettingsV2 = {
  version: 2,
  workspace,
  theme: 'dark',
  // 关掉启动自检/自动更新：预览里没有主进程，跑这两条只会卡在启动页。
  checkUpdatesOnStartup: false,
  runDiagnosticsOnStartup: false,
  sidebarMoreExpanded: true,
  // 让启动门控认为 codex 已由官方渠道配置好，直接进主界面而不是引导页。
  officialProviders: ['codex'],
}

const accountProfile: AccountProfile = {
  userId: 1024,
  username: 'preview_user',
  group: 'default',
  role: 1,
  quota: 4_800_000,
  usedQuota: 1_260_000,
}

const profileDetail = {
  userId: accountProfile.userId,
  username: accountProfile.username,
  displayName: '预览账号',
  email: 'preview@xingmang.ai',
  group: 'default',
  quota: 4_800_000,
  usedQuota: 1_260_000,
  requestCount: 3_182,
  affCode: 'XM-PREVIEW',
  affCount: 6,
  affQuota: 120_000,
} as AccountProfileDetail

const snapshot: SystemSnapshot = {
  checkedAt: now(),
  network: {
    publicIp: '203.0.113.24',
    countryCode: 'CN',
    region: 'mainland-china',
    checkedAt: now(),
    error: null,
  },
  runtime: { node: installedNode, npm: installedNpm, python: installedPython },
  clis: {
    claude: cliStatus('1.4.7'),
    codex: cliStatus('0.9.3', '0.9.5'),
    gemini: cliStatus('0.6.1'),
    grok: cliStatus('0.3.0'),
  },
  desktopApps: { codex: desktopStatus },
}

const config: AppConfigSummary = {
  workspace,
  providers: {
    claude: providerConfig('claude-sonnet-4-6', true),
    codex: providerConfig('gpt-5.2-codex', true),
    // 已安装的 CLI 必须全部读回「已配置」，否则启动门控
    // （managedCliConfigsReadyForDashboard）会把预览拦在引导页。
    gemini: providerConfig('gemini-3-pro', true),
    grok: providerConfig('grok-4', true),
  },
}

const setupStatus: CodexSetupStatus = {
  checkedAt: now(),
  runtime: { node: installedNode, npm: installedNpm },
  cli: snapshot.clis.codex,
  desktop: desktopStatus,
}

const readiness: CodexReadinessStatus = { hasApiKey: true, matchesRelay: true }

const updateSnapshot: UpdateSnapshot = {
  phase: 'idle',
  currentVersion: '2.4.0-preview',
  availableVersion: null,
  releaseName: null,
  releaseNotesText: null,
  checkedAt: now(),
  progress: null,
  error: null,
  development: true,
}

const mcpServers: McpServer[] = [
  {
    name: 'filesystem',
    enabled: true,
    disabledReason: null,
    transportType: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', workspace],
    cwd: workspace,
    url: null,
    envNames: [],
    inheritedEnvNames: ['PATH'],
    httpHeaderNames: [],
    inheritedHttpHeaderNames: [],
    bearerTokenEnvVar: null,
    startupTimeoutSec: 30,
    toolTimeoutSec: 120,
    authStatus: 'not-required',
    origin: 'user',
    editable: true,
  },
  {
    name: 'context7',
    enabled: false,
    disabledReason: '已在配置中禁用',
    transportType: 'http',
    command: null,
    args: [],
    cwd: null,
    url: 'https://mcp.context7.com/mcp',
    envNames: [],
    inheritedEnvNames: [],
    httpHeaderNames: ['Authorization'],
    inheritedHttpHeaderNames: [],
    bearerTokenEnvVar: 'CONTEXT7_TOKEN',
    startupTimeoutSec: null,
    toolTimeoutSec: null,
    authStatus: 'logged-out',
    origin: 'user',
    editable: true,
  },
]

const skills: SkillItem[] = [
  {
    id: 'code-review',
    name: '代码评审',
    description: '按仓库规范逐文件检查改动，输出可执行的修改建议。',
    path: `${workspace}/.codex/skills/code-review`,
    scope: 'repo',
    source: 'codex',
    enabled: true,
    managed: false,
  },
  {
    id: 'release-notes',
    name: '发布说明',
    description: '从提交记录生成中文发布说明草稿。',
    path: `${workspace}/.codex/skills/release-notes`,
    scope: 'user',
    source: 'agents',
    enabled: false,
    managed: true,
  },
]

const pluginCatalog: PluginCatalog = {
  plugins: [
    {
      pluginId: 'xingmang/formatter',
      name: '格式化工具',
      marketplaceName: '星芒市场',
      version: '1.2.0',
      installed: true,
      enabled: true,
      installPolicy: 'manual',
      authPolicy: 'none',
      sourceType: 'git',
      sourcePath: 'https://example.com/xingmang/formatter',
    },
  ],
  marketplaces: [{ name: '星芒市场', root: `${workspace}/.codex/marketplaces/xingmang` }],
}

const emptyUsagePage = {
  page: 1,
  pageSize: 20,
  total: 0,
  records: [],
  stats: { quota: 0, tokens: 0, requests: 0 },
} as unknown as AccountUsagePage

const emptyTaskPage: AccountTaskPage = { page: 1, pageSize: 20, total: 0, tasks: [] }
const emptyKeysPage: AccountKeysPage = { page: 1, pageSize: 20, total: 0, keys: [] }
const emptyOrdersPage: AccountTopupOrdersPage = { page: 1, pageSize: 20, total: 0, orders: [] }

const topupInfo = {
  onlineTopupEnabled: true,
  stripeTopupEnabled: false,
  creemTopupEnabled: false,
  waffoPancakeTopupEnabled: false,
  redemptionEnabled: true,
  paymentComplianceConfirmed: true,
  paymentComplianceTermsVersion: '2026-01',
  paymentMethods: [],
  minTopup: 10,
  amountOptions: [10, 30, 100, 300],
  discounts: {},
  topupLink: null,
} as AccountTopupInfo

const usableGroups: AccountUsableGroup[] = [
  { name: 'default', description: '默认分组', ratio: 1 },
  { name: 'turbo', description: '高速分组', ratio: 1.5 },
]

const diagnosticsReport = {
  generatedAt: now(),
  items: [],
} as unknown as DiagnosticsReport

function extensionSnapshot(provider: ProviderId): ExtensionSnapshot {
  const capability = { list: true, reason: null }
  return {
    provider,
    checkedAt: now(),
    capabilities: { mcp: capability, skill: capability, plugin: capability },
    items: [],
    warnings: [],
  }
}

const sessionProviders = ['codex', 'claude', 'gemini', 'grok'] as const

function sessionCapability(provider: (typeof sessionProviders)[number]) {
  return {
    provider,
    available: true,
    readable: true,
    readonly: false,
    source: 'jsonl' as const,
    reason: '',
    operations: { list: true, detail: true, exportMarkdown: true, archive: true, restore: true },
  }
}

const sessionCapabilities = Object.fromEntries(
  sessionProviders.map((provider) => [provider, sessionCapability(provider)]),
) as Record<(typeof sessionProviders)[number], ReturnType<typeof sessionCapability>>

const emptySessionPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  pages: 0,
  stats: { total: 0, byProvider: { codex: 0, claude: 0, gemini: 0, grok: 0 } },
  capabilities: sessionCapabilities,
}

const providerModels: Record<ProviderId, string[]> = {
  claude: ['claude-sonnet-4-6', 'claude-opus-4-2'],
  codex: ['gpt-5.2-codex', 'gpt-5.2'],
  gemini: ['gemini-3-pro', 'gemini-3-flash'],
  grok: ['grok-4', 'grok-4-mini'],
}

const noop = () => {}
const unsubscribe = () => noop

/** 显式实现的方法：这些是启动路径和主要页面真正读的数据。 */
const handlers: Partial<Record<keyof XingmangApi, unknown>> = {
  getPlatformCapabilities: async (): Promise<PlatformCapabilities> => ({
    platform: 'macos',
    architecture: 'arm64',
    isMac: true,
    nodeRuntimeInstall: 'external',
    pythonRuntimeInstall: 'external',
    cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' },
    codexDesktop: { install: 'external', launch: true, uninstall: false, windowsStore: false },
  }),
  getSettings: async () => settings,
  saveSettings: async (update: Partial<AppSettingsV2>) => Object.assign(settings, update),
  getRepositoryContext: async (): Promise<RepositoryContext> => ({ repositoryRoot: workspace }),
  scanSystem: async () => snapshot,
  getConfig: async () => config,
  getCodexSetupStatus: async () => setupStatus,
  getCodexReadiness: async () => readiness,
  getCodexDesktopStatus: async () => desktopStatus,
  getUpdateState: async () => updateSnapshot,
  checkForUpdates: async () => updateSnapshot,
  runStartupUpdate: async () => updateSnapshot,
  runDiagnostics: async () => diagnosticsReport,
  listModels: async (provider: ProviderId) => providerModels[provider] ?? [],
  listConfiguredModels: async (provider: ProviderId) => providerModels[provider] ?? [],
  listAccountKeyModels: async () => providerModels.codex,
  listMcpServers: async () => mcpServers,
  listSkills: async () => skills,
  listPlugins: async () => pluginCatalog,
  listProviderExtensions: async (provider: ProviderId) => extensionSnapshot(provider),
  listProviderSessions: async () => emptySessionPage,
  listSessions: async () => emptySessionPage,
  openCanvasWindow: async () => undefined,
  listAiChatGroups: async () => usableGroups,
  prepareAiChat: async () => ({ group: 'default', models: providerModels.codex, keyCreated: false }),
  listBackups: async () => [],
  getRememberedAccountLogin: async () => null,
  getAccountSession: async (): Promise<AccountSessionState> => ({
    authenticated: true,
    account: accountProfile,
  }),
  getAccountProfile: async () => profileDetail,
  getAccountBalance: async (): Promise<AccountBalance> => ({
    quota: 4_800_000,
    usedQuota: 1_260_000,
    quotaPerUnit: 500_000,
    quotaDisplayType: 'USD',
    usdExchangeRate: 7.2,
    displayAmount: 9.6,
  }),
  getAccountUsableGroups: async () => usableGroups,
  getAccountUsage: async () => emptyUsagePage,
  getAccountTasks: async () => emptyTaskPage,
  getAccountKeys: async () => emptyKeysPage,
  getAccountTopupInfo: async () => topupInfo,
  getAccountTopupOrders: async () => emptyOrdersPage,
  getAccountDashboard: async (): Promise<AccountDashboardData> => ({
    startTimestamp: Math.floor(Date.now() / 1000) - 7 * 86_400,
    endTimestamp: Math.floor(Date.now() / 1000),
    records: [],
  }),
  getAccountSubscriptionPlans: async () => [],
  getAccountSubscriptionSelf: async (): Promise<AccountSubscriptionSelf> => ({
    billingPreference: 'balance-first',
    activeSubscriptions: [],
    allSubscriptions: [],
  } as unknown as AccountSubscriptionSelf),
  getAccountLoginSessions: async () => [],
  syncManagedCliKeys: async () => ({ ready: [], failed: [] }),
  configureManagedCliKeys: async () => ({ configured: [], failed: [] }),
  setWindowTheme: async () => undefined,
  setWindowMode: async () => undefined,
  reportRendererError: async () => undefined,
  openExternal: async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
}

function isSubscription(name: string): boolean {
  return name.startsWith('on') && name.length > 2 && name[2] === name[2].toUpperCase()
}

export function installDevBrowserBridge(): void {
  if (typeof window === 'undefined') return
  // 真实 preload 在场时绝不覆盖：桌面版行为必须保持原样。
  if ((window as Partial<Window>).xingmang) return

  const bridge = new Proxy({} as Record<string, unknown>, {
    get(_target, property: string) {
      const handler = handlers[property as keyof XingmangApi]
      if (handler) return handler
      if (isSubscription(property)) return unsubscribe
      return async (...args: unknown[]) => {
        console.warn(`[v0] 浏览器预览未实现 window.xingmang.${property}()`, args)
        return undefined
      }
    },
    has: () => true,
  })

  window.xingmang = bridge as unknown as XingmangApi
  console.warn('[v0] 已启用浏览器预览桩 window.xingmang（仅开发环境，桌面版不受影响）')
}
