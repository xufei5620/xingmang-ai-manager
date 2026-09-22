import { createRoot } from 'react-dom/client'
import { BusinessPage } from '../src/renderer-v2/pages-business'
import { Shell } from '../src/renderer-v2/features/shell/Shell'
import { BalanceTierProvider } from '../src/renderer-v2/ui'
import type { V2Bridge, V2Page } from '../src/renderer-v2/types'
import type {
  PlatformSystemState,
  XingmangPlatformApi,
} from '../electron/platform/contract'
import type { AccountPaymentWindowTerminalEvent } from '../electron/ipc-contract'
import { usageDetailFixture } from '../src/renderer-v2/testing/usage-fixture'

declare global {
  interface Window {
    emitPaymentWindowTerminal: (event: AccountPaymentWindowTerminalEvent) => void
    // 支付回调只发一次：订阅次数是 R-B6 的直接观测点，重订一次就是一次丢单窗口。
    paymentTerminalSubscriptions: () => { added: number; live: number }
    rerenderFixture: () => void
    keyGroupsHarness: {
      requests: number
      setGroups(names: string[]): void
      deferNext(): void
      failNext(message?: string): void
      release(): void
    }
  }
}

const query = new URLSearchParams(location.search)
const page = (query.get('page') as V2Page) ?? 'account'
const requestedSkin = query.get('skin')
const initialSkin = requestedSkin === 'dawn' || requestedSkin === 'obsidian' || requestedSkin === 'mist' || requestedSkin === 'aurora'
  ? requestedSkin
  : 'mist'
const fail = query.get('fail')
const empty = query.has('empty')
const calls: Array<{ name: string; args: unknown }> = []
const record = (name: string, args?: unknown) => {
  calls.push({ name, args })
  document.documentElement.dataset.calls = JSON.stringify(calls)
}
// Chromium rejects clipboard writes unless the context was granted the
// permission, so record them instead: the copy actions are what the tests
// assert on, not the host clipboard.
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      record('copy-clipboard', text)
    },
  },
})
let keyGroups = [{ name: 'default', description: '默认分组', ratio: 1 }]
let nextKeyGroupsRequest: 'ready' | 'deferred' | 'failed' = 'ready'
// 主进程按原因抛不同的错误（NewApiAuthenticationError 的中文、限流的英文原文……），
// 夹具让用例自己指定原文，才能验证 R-G5 之后这些原因不再被抹成同一句。
let nextKeyGroupsFailure = '分组读取暂时失败，请重试'
let releaseKeyGroups: (() => void) | null = null
window.keyGroupsHarness = {
  requests: 0,
  setGroups(names) { keyGroups = names.map((name) => ({ name, description: name, ratio: 1 })) },
  deferNext() { nextKeyGroupsRequest = 'deferred' },
  failNext(message) {
    nextKeyGroupsRequest = 'failed'
    nextKeyGroupsFailure = message ?? '分组读取暂时失败，请重试'
  },
  release() { releaseKeyGroups?.(); releaseKeyGroups = null },
}
const paymentWindowTerminalListeners = new Set<(event: AccountPaymentWindowTerminalEvent) => void>()
let paymentWindowTerminalSubscriptions = 0
window.paymentTerminalSubscriptions = () => ({
  added: paymentWindowTerminalSubscriptions,
  live: paymentWindowTerminalListeners.size,
})
window.emitPaymentWindowTerminal = (event) => {
  if (event.status === 'success' && event.tradeNo === 'XM-VISUAL-TOPUP') {
    balance.quota = 1400
    balance.displayAmount = 14
  }
  paymentWindowTerminalListeners.forEach((listener) => listener(event))
}
document.documentElement.dataset.theme = query.get('theme') ?? 'light'
document.documentElement.dataset.skin =
  query.get('skin') ?? (query.get('theme') === 'dark' ? 'obsidian' : 'dawn')
document.documentElement.dataset.os = query.get('os') ?? 'win'
document.body.style.margin = '0'
document.body.style.background = 'var(--bg)'
document.body.style.fontFamily = 'var(--font)'
document.body.style.color = 'var(--text)'
document.body.style.fontSize = '14px'
const time = '2026-09-07T01:00:00Z'
const profile = {
  userId: 7,
  username: '本地测试',
  displayName: '本地测试',
  email: 'test@example.invalid',
  group: 'default',
  quota: 1000,
  usedQuota: 100,
  requestCount: 12,
  affCode: 'TEST',
  affCount: 2,
  affQuota: 100,
  affHistoryQuota: 150,
}
const balance = {
  quota: 1000,
  usedQuota: 100,
  quotaPerUnit: 100,
  quotaDisplayType: 'USD',
  usdExchangeRate: 1,
  displayAmount: 10,
}
let settings: Awaited<ReturnType<V2Bridge['getSettings']>> = {
  version: 2,
  workspace: 'C:/test-project',
  theme: query.get('theme') === 'dark' ? 'dark' : 'light',
  uiSkin: initialSkin,
  reducedMotion: query.has('evidence'),
  checkUpdatesOnStartup: true,
  runDiagnosticsOnStartup: false,
}
const capabilities = {
  available: true,
  readable: true,
  readonly: false,
  source: 'sqlite-jsonl' as const,
  reason: '',
  operations: {
    list: true,
    detail: true,
    exportMarkdown: true,
    archive: true,
    restore: true,
  },
}
const session = {
  id: 'codex:session-1',
  nativeId: 'session-1',
  provider: 'codex' as const,
  title: '测试会话',
  cwd: 'C:/test-project',
  model: 'test-model',
  archived: false,
  readonly: false,
  createdAt: 1788742800,
  updatedAt: 1788742800,
  messageCount: 2,
  sourcePath: 'C:/test-session',
  detailAvailable: true,
}
// 同一个工具、同一个目录的第二条(更旧的)记录:「接着聊」是按目录接最近一条,
// 所以只有最近那条该有按钮。默认不出现,免得改动现有用例看到的行数。
const olderSameFolderSession = {
  ...session,
  id: 'codex:session-0',
  nativeId: 'session-0',
  title: '同一目录里更早的会话',
  createdAt: 1788739200,
  updatedAt: 1788739200,
}
const backup = {
  id: 'backup-1',
  provider: 'codex' as const,
  reason: 'manual' as const,
  createdAt: time,
  fileCount: 1,
  existingFileCount: 1,
  totalSize: 128,
  valid: true,
  error: null,
}
const key = {
  id: 1,
  name: 'Test key',
  maskedKey: 'sk-****abcd',
  group: 'default',
  status: 1,
  remainQuota: 1000,
  unlimitedQuota: false,
  usedQuota: 10,
  createdAt: time,
  expiredAt: null,
  accessedAt: time,
}
// 「按工具分账」按托管 Key 的固定名称认工具，夹具照搬真实命名：一把有上限、
// 一把不限额，另外两个工具还没签发过，这样四种格子在一张表里都能看到。
const managedKeys = query.has('managedKeys')
  ? [
      { ...key, id: 11, name: 'xingmang-desktop-claude', group: 'Claude-MAX订阅', unlimitedQuota: false, remainQuota: 1200, usedQuota: 600 },
      { ...key, id: 12, name: 'xingmang-desktop-codex', group: 'GPT-中转/订阅', unlimitedQuota: true, remainQuota: 0, usedQuota: 200 },
    ]
  : null
let activeUserId = 7
let taskReads = 0
let detailReads = 0
const nativeConfig = {
  exists: true,
  hasApiKey: true,
  matchesRelay: true,
  configurationOwnership: 'account' as const,
  baseUrl: 'https://xm.solov.cc',
  actualBaseUrl: 'https://xm.solov.cc',
  model: 'fixture-model',
  apiKeyPreview: 'sk-***',
  dataDirectory: 'C:/test-config',
  dataDirectoryExists: true,
  files: [],
  updatedAt: null,
}
const configs: Awaited<ReturnType<V2Bridge['getConfig']>> = {
  workspace: 'C:/test-project',
  providers: {
    claude: { ...nativeConfig },
    codex: { ...nativeConfig, codexAuthMode: 'chatgpt' },
    gemini: { ...nativeConfig },
    grok: { ...nativeConfig },
  },
}
const cliStatus = {
  installed: true,
  version: '1',
  path: 'C:/test-tool',
  installDirectory: 'C:/test-tools',
  latestVersion: '1',
  updateAvailable: false,
  uninstall: { available: true, reason: null, manualCommand: null },
}
const systemSnapshot: Awaited<ReturnType<V2Bridge['scanSystem']>> = {
  checkedAt: time,
  network: {
    publicIp: null,
    countryCode: null,
    region: 'unknown',
    checkedAt: time,
    error: null,
  },
  runtime: {
    node: { ...cliStatus },
    npm: { ...cliStatus },
    python: { ...cliStatus },
    git: { ...cliStatus },
  },
  clis: {
    claude: { ...cliStatus },
    codex: { ...cliStatus },
    gemini: { ...cliStatus },
    grok: { ...cliStatus, installed: false },
  },
  desktopApps: {
    codex: {
      ...cliStatus,
      appVersion: '1',
      mirrorVersion: null,
      mirrorUpdateAvailable: false,
      mirrorError: null,
      running: false,
    },
  },
}
const apiMethods = {
  onInstallProgress: () => () => undefined,
  onCodexDesktopInstallProgress: () => () => undefined,
  getAccountSession: async () => ({
    authenticated: true,
    ...(query.has('sub2apiReliability') ? { siteId: 'solov-api' as const, realmId: 'api-account' as const, capabilities: {
      supportsRegistration: false, supportsPasswordReset: false, supportsKeyManagement: true, supportsUsage: true,
      supportsBilling: true, supportsSubscriptions: true, supportsProfileUpdate: true, supportsSessionManagement: false,
      supportsAutoKeyProvision: true, supportsAccountSession: true, supportsSubscriptionPreference: false,
      supportsSubscriptionPayment: false, supportsSubscriptionBalancePurchase: false, supportsDashboard: true,
      supportsDashboardTrends: false, supportsTasks: false,
    } } : {}),
    account: {
      userId: activeUserId,
      username: profile.username,
      group: 'default',
      role: 1,
      quota: 1000,
      usedQuota: 100,
    },
  }),
  getAccountProfile: async () => { record('get-profile'); return { ...profile, userId: activeUserId } },
  getAccountBalance: async () => { record('get-balance'); return { ...balance, ...(query.has('sub2apiReliability') ? { quotaPerUnit: 1 } : {}) } },
  listSavedAccounts: async () => [
    {
      id: 'saved-test',
      origin: 'https://xm.solov.cc',
      userId: 7,
      username: '本地测试',
      updatedAt: time,
    },
    ...(query.has('sync')
      ? [
          {
            id: 'saved-target',
            origin: 'https://xm.solov.cc',
            userId: 8,
            username: '目标账号',
            updatedAt: time,
          },
        ]
      : []),
  ],
  getConfig: async () => configs,
  scanSystem: async (force?: boolean) => {
    record('scan-sync', force)
    return systemSnapshot
  },
  switchSavedAccount: async (id: string) => {
    record('switch-account', id)
    if (fail === 'switch') throw new Error('目标账号登录已过期')
    activeUserId = 8
    for (const config of Object.values(configs.providers)) {
      if (config.configurationOwnership === 'account') config.configurationOwnership = 'unknown'
    }
    if (query.has('revalidate')) configs.providers.gemini.matchesRelay = false
    return {
      authenticated: true,
      account: {
        userId: 8,
        username: '目标账号',
        group: 'default',
        role: 1,
        quota: 1000,
        usedQuota: 0,
      },
    }
  },
  configureManagedCliKeys: async (
    input: Parameters<V2Bridge['configureManagedCliKeys']>[0],
  ) => {
    record('sync-config', input)
    if (input.intent !== 'explicit' || input.providers.length !== 1) throw new Error('显式同步必须逐个工具确认')
    const configured = input.providers.filter((id) => !query.has('partial') || id !== 'gemini')
    for (const provider of configured) configs.providers[provider].configurationOwnership = 'account'
    return {
      configured,
      failed:
        query.has('partial') && input.providers.includes('gemini')
          ? [
              {
                provider: 'gemini' as const,
                message: 'Gemini 配置文件正在使用',
              },
            ]
          : [],
    }
  },
  getAccountKeys: async () => ({
    page: 1,
    pageSize: 20,
    total: empty ? 0 : managedKeys ? managedKeys.length : 1,
    keys: empty ? [] : managedKeys ?? [key],
  }),
  getAccountUsableGroups: async () => {
    window.keyGroupsHarness.requests++
    const groups = keyGroups.map((group) => ({ ...group }))
    const state = nextKeyGroupsRequest
    nextKeyGroupsRequest = 'ready'
    if (state === 'failed') throw new Error(nextKeyGroupsFailure)
    if (state === 'deferred') await new Promise<void>((resolve) => { releaseKeyGroups = resolve })
    return groups
  },
  getAccountDashboard: async () => {
    if (fail === 'dashboard') throw new Error('用量服务暂时不可用')
    return {
    startTimestamp: 1,
    endTimestamp: 2,
    buckets: [],
    models: [],
    quota: 500,
    count: 11,
    tokens: 2000,
    discardedCount: 0,
    ...(query.has('sub2apiReliability') ? { coverage: 'all-time-summary' as const } : {}),
  } },
  getAccountTasks: async () => {
    const completed = ++taskReads > 1
    return {
      page: 1,
      pageSize: 20,
      total: query.has('taskTransition') ? 1 : 0,
      tasks: query.has('taskTransition')
        ? [
            {
              id: 44,
              taskId: 'fixture-task',
              platform: 'video',
              group: 'default',
              quota: 10,
              action: 'video',
              status: completed ? 'SUCCESS' : 'IN_PROGRESS',
              failReason: '',
              resultUrl: completed
                ? 'https://cdn.upstream.example.test/fixture-task.mp4'
                : '',
              submitAt: time,
              startAt: time,
              finishAt: completed ? time : '',
              progress: completed ? '100%' : '50%',
              originModelName: 'test-video',
              upstreamModelName: 'test-video',
            },
          ]
        : [],
    }
  },
  getAccountUsage: async (input: Parameters<V2Bridge['getAccountUsage']>[0]) => {
    record('query-usage', input)
    if (fail === 'usage') throw new Error('调用记录服务暂时不可用')
    return {
    page: 1,
    pageSize: 20,
    total: query.has('usageDetail') ? 1 : 0,
    records: query.has('usageDetail') ? [usageDetailFixture(query.get('usageDetail') || 'tiered')] : [],
    stats: { quota: 0, rpm: 0, tpm: 0 },
  } },
  getAccountTopupOrders: async (
    input: Parameters<V2Bridge['getAccountTopupOrders']>[0],
  ) => {
    record('query-orders', input)
    return {
      page: 1,
      pageSize: 20,
      total: 1,
      orders: [
        {
          id: 2,
          amount: 10,
          money: 10,
          tradeNo: 'TEST-ORDER',
          paymentMethod: 'stripe',
          paymentProvider: 'stripe',
          createdAt: time,
          completedAt: time,
          status: 'success' as const,
        },
      ],
    }
  },
  getAccountTopupInfo: async () => ({
    onlineTopupEnabled: true,
    stripeTopupEnabled: true,
    creemTopupEnabled: false,
    waffoPancakeTopupEnabled: false,
    redemptionEnabled: true,
    paymentComplianceConfirmed: true,
    paymentComplianceTermsVersion: '1',
    paymentMethods: query.has('multiPayment')
      ? [
          {
            name: 'Stripe',
            type: 'stripe',
            provider: 'stripe' as const,
            color: null,
            icon: null,
            minTopup: 1,
          },
          {
            name: '支付宝',
            type: 'alipay',
            provider: 'epay' as const,
            color: null,
            icon: null,
            minTopup: 20,
          },
        ]
      : [
          {
            name: 'Stripe',
            type: 'stripe',
            provider: 'stripe' as const,
            color: null,
            icon: null,
            minTopup: 1,
          },
        ],
    minTopup: 1,
    amountOptions: [10, 20],
    discounts: {},
    topupLink: null,
  }),
  quoteAccountTopupAmount: async (
    input: Parameters<V2Bridge['quoteAccountTopupAmount']>[0],
  ) => ({ amount: input.amount, payableAmount: input.amount }),
  createAccountTopupPayment: async (
    input: Parameters<V2Bridge['createAccountTopupPayment']>[0],
  ) => {
    record('create-topup-payment', input)
    if (query.has('fastPayment')) window.emitPaymentWindowTerminal({ status: 'success', tradeNo: 'XM-VISUAL-TOPUP' })
    return { opened: true as const, tradeNo: 'XM-VISUAL-TOPUP' }
  },
  closeAccountPaymentWindow: async () => undefined,
  redeemAccountTopupCode: async (code: string) => {
    record('redeem-code', code)
    const type = query.get('redemptionType')
    if (type === 'subscription' || type === 'concurrency') return { type, quotaAdded: 0 }
    return { quotaAdded: 5 }
  },
  getAccountSubscriptionPlans: async () => query.has('subscriptionExternal') ? [{
    id: 1,
    title: '外部订阅',
    subtitle: '测试外部支付状态',
    priceAmount: 29,
    currency: 'CNY',
    durationUnit: 'month' as const,
    durationValue: 1,
    customSeconds: 0,
    allowBalancePay: false,
    allowWalletOverflow: false,
    maxPurchasePerUser: 1,
    totalAmount: 1000,
    upgradeGroup: 'default',
    downgradeGroup: 'default',
    quotaResetPeriod: 'monthly' as const,
    quotaResetCustomSeconds: 0,
    stripePriceId: 'stripe-price',
    creemProductId: null,
    waffoPancakeProductId: null,
  }] : [],
  createAccountSubscriptionPayment: async (
    input: Parameters<V2Bridge['createAccountSubscriptionPayment']>[0],
  ) => {
    record('create-subscription-payment', input)
    return {
      opened: true as const,
      tradeNo: 'XM-VISUAL-SUBSCRIPTION',
      expiresAt: '2026-09-07T13:30:00+08:00',
    }
  },
  purchaseAccountSubscriptionWithBalance: async (planId: number) => {
    record('purchase-subscription-balance', planId)
    return { purchased: true as const }
  },
  getAccountSubscriptionSelf: async () => {
    record('get-subscriptions')
    if (fail === 'subscriptions') throw new Error('订阅服务暂时不可用')
    if (query.has('sub2apiReliability')) return {
      billingPreference: null, activeSubscriptions: [], allSubscriptions: [{
        id: 4, planId: 1, groupName: '周期订阅', status: 'active', source: 'sub2api', amountTotal: null, amountUsed: null,
        startedAt: time, endsAt: '2026-10-01T00:00:00Z', nextResetAt: null, quotaPeriods: [
          { period: 'daily' as const, limit: 5, used: 1, limitState: 'limited' as const, windowStartedAt: null },
          { period: 'weekly' as const, limit: 20, used: 4, limitState: 'limited' as const, windowStartedAt: null },
          { period: 'monthly' as const, limit: null, used: 12, limitState: 'unknown' as const, windowStartedAt: null },
        ],
      }],
    }
    return {
    billingPreference: 'subscription_first' as const,
    activeSubscriptions: [],
    allSubscriptions: [],
  } },
  getAccountLoginSessions: async () => [
    {
      sid: 'device-1',
      current: true,
      loginMethod: 'password',
      ip: '127.0.0.1',
      userAgent: 'Test browser',
      createdAt: time,
      lastActiveAt: time,
      expiresAt: time,
    },
  ],
  listAccountKeyModels: async () => ['test-model'],
  copyAccountKey: async (id: number) => record('copy-key', id),
  createAccountKey: async (
    input: Parameters<V2Bridge['createAccountKey']>[0],
  ) => record('create-key', input),
  saveConfigWithAccountKey: async (
    input: Parameters<V2Bridge['saveConfigWithAccountKey']>[0],
  ) => {
    record('configure-key', input)
    throw new Error('配置写入失败，原配置已保留')
  },
  listProviderSessions: async () => ({
    items: empty ? [] : query.has('sameFolder') ? [session, olderSameFolderSession] : [session],
    total: empty ? 0 : query.has('sameFolder') ? 2 : 1,
    page: 1,
    pageSize: 20,
    pages: 1,
    stats: {
      total: 1,
      byProvider: { codex: 1, claude: 0, gemini: 0, grok: 0 },
    },
    capabilities: {
      codex: { ...capabilities, provider: 'codex' as const },
      claude: { ...capabilities, provider: 'claude' as const },
      gemini: { ...capabilities, provider: 'gemini' as const },
      grok: { ...capabilities, provider: 'grok' as const },
    },
  }),
  getProviderSessionDetail: async () => {
    detailReads += 1
    if (query.has('detailFailure') && detailReads === 1)
      throw new Error('会话详情暂时不可读')
    return {
      session,
      messages: [{ role: 'user', text: '这是一条测试消息', timestamp: time }],
      messageStats: {
        total: 1,
        user: 1,
        assistant: 0,
        system: 0,
        other: 0,
        invalidLines: 0,
      },
      messagesTruncated: false,
      sourceTruncated: false,
    }
  },
  archiveSession: async (id: string) => {
    record('archive', id)
    throw new Error('测试归档失败')
  },
  exportProviderSession: async (id: string) => {
    record('export-session', id)
    return null
  },
  launchCli: async (
    provider: Parameters<V2Bridge['launchCli']>[0],
    workspace: string,
    mode?: Parameters<V2Bridge['launchCli']>[2],
  ) => {
    record('launch-cli', { provider, workspace, mode })
  },
  listProviderExtensions: async (
    provider: Parameters<V2Bridge['listProviderExtensions']>[0],
  ) => ({
    provider,
    checkedAt: time,
    capabilities: {
      mcp: { list: true, reason: null },
      skill: { list: true, reason: null },
      plugin: { list: true, reason: null },
    },
    warnings: [],
    items: empty
      ? []
      : [
          {
            provider,
            kind: (page === 'skills'
              ? 'skill'
              : page === 'plugins'
                ? 'plugin'
                : 'mcp') as 'mcp' | 'skill' | 'plugin',
            id: 'test-extension',
            name: '测试扩展',
            description: '本机测试连接',
            installed: true,
            enabled: true,
            scope: 'user' as const,
            currentVersion: '1.0.0',
            latestVersion: '1.0.1',
            source: {
              kind: 'npm' as const,
              locator: 'test-package',
              reference: null,
            },
            update: {
              state: 'update-available' as const,
              reason: '发现新版本',
              checkedAt: time,
            },
            operations: {
              install: true,
              uninstall: true,
              enable: true,
              disable: true,
              update: true,
            },
          },
        ],
  }),
  mutateProviderExtension: async (
    input: Parameters<V2Bridge['mutateProviderExtension']>[0],
  ) => {
    record('extension', input)
    throw new Error('扩展操作失败，已有配置保留')
  },
  listBackups: async () => (empty ? [] : [backup]),
  inspectBackup: async () => ({
    ...backup,
    files: [
      {
        targetRelativePath: 'config.toml',
        backupRelativePath: 'config.toml',
        existed: true,
        size: 128,
        sha256: 'test',
      },
    ],
  }),
  restoreBackup: async (id: string) => {
    record('restore-backup', id)
    return {
      restoredBackupId: id,
      preRestoreBackupId: 'before-restore',
      restoredFiles: ['config.toml'],
      removedFiles: [],
    }
  },
  getSettings: async () => settings,
  getWindowCapabilities: async () => ({ tray: true, notifications: true }),
  saveSettings: async (patch: Parameters<V2Bridge['saveSettings']>[0]) => {
    record('settings', patch)
    if (fail === 'settings') throw new Error('设置写入失败')
    settings = {
      ...settings,
      ...(patch.theme ? { theme: patch.theme } : {}),
      ...(patch.uiSkin && patch.uiSkin !== 'auto'
        ? { uiSkin: patch.uiSkin }
        : {}),
      ...(patch.desktopNotifications !== undefined
        ? { desktopNotifications: patch.desktopNotifications }
        : {}),
      ...(patch.reducedMotion !== undefined
        ? { reducedMotion: patch.reducedMotion }
        : {}),
      // 只有显式关闭才留在记录里，和 app-settings.ts 的落盘语义一致。
      ...(patch.crashReporting === false
        ? { crashReporting: false as const }
        : {}),
    }
    if (patch.crashReporting === true) delete settings.crashReporting
    return settings
  },
  getRuntimeLogs: async () => ({
    generatedAt: time,
    directory: 'C:/test-logs',
    filePath: 'C:/test-logs/log',
    sizeBytes: 64,
    total: 1,
    truncated: false,
    counts: { debug: 0, info: 1, warn: 0, error: 0 },
    sources: ['fixture'],
    entries: empty
      ? []
      : [
          {
            id: 'log-1',
            timestamp: time,
            level: 'info' as const,
            source: 'fixture',
            event: 'test',
            message: '测试日志',
            detail: null,
          },
        ],
  }),
  getFeedbackReport: async () => ({
    id: 'report-snapshot-7',
    text: '固定的脱敏报告内容',
    entries: 1,
  }),
  copyFeedbackReport: async (id?: string) => {
    record('copy-report', id)
    return { entries: 1 }
  },
  exportFeedbackReport: async (id?: string) => {
    record('export-report', id)
    return { outputPath: 'C:\test-report.txt' }
  },
  getUpdateState: async () => ({
    phase: 'available' as const,
    currentVersion: '0.1.31',
    availableVersion: '0.1.32',
    releaseName: '测试版本',
    releaseNotesText: '测试更新内容',
    checkedAt: time,
    progress: null,
    error: null,
    development: true,
  }),
  downloadUpdate: async () => {
    record('download-update')
    throw new Error('测试下载失败')
  },
  onUpdateState: () => () => undefined,
  onAccountPaymentWindowTerminal: (listener: (event: AccountPaymentWindowTerminalEvent) => void) => {
    paymentWindowTerminalSubscriptions++
    paymentWindowTerminalListeners.add(listener)
    return () => { paymentWindowTerminalListeners.delete(listener) }
  },
  runDiagnostics: async () => ({
    version: 1 as const,
    generatedAt: time,
    durationMs: 30,
    counts: { pass: 1, warn: 1, fail: 0, error: 0 },
    items: empty
      ? []
      : [
          {
            code: 'RUNTIME_NODE',
            title: 'Node.js 运行环境',
            state: 'pass' as const,
            summary: '已找到可用版本',
            durationMs: 10,
          },
          {
            code: 'XINGMANG_NETWORK',
            title: '星芒连接',
            state: 'warn' as const,
            summary: '连接需要检查',
            durationMs: 20,
          },
        ],
  }),
} satisfies Partial<V2Bridge>
const api = new Proxy(apiMethods, {
  get(target, key: keyof V2Bridge) {
    const method = Reflect.get(target, key)
    if (fail === 'load' && !String(key).startsWith('on'))
      return async () => {
        throw new Error('本机测试读取失败，已有数据保留')
      }
    if (method) return method
    return async (...args: unknown[]) => {
      record(key, args)
      throw new Error(`未提供测试方法 ${key}`)
    }
  },
}) as unknown as V2Bridge
if (query.has('system')) {
  let systemState: PlatformSystemState = {
    preferences: { version: 1, themePreference: settings.theme, highContrast: false },
    appearance: {
      theme: settings.theme,
      highContrast: false,
      systemHighContrast: false,
    },
    startup: {
      supported: true,
      requested: false,
      enabled: false,
      approvalRequired: false,
      note: '不会随电脑登录自动启动。',
    },
  }
  const listeners = new Set<(value: PlatformSystemState) => void>()
  const changed = () => {
    for (const listener of listeners) listener(systemState)
    return systemState
  }
  const guard = () => {
    if (fail === 'platform') throw new Error('平台设置写入失败')
  }
  const platform: XingmangPlatformApi = {
    getState: async () => systemState,
    setThemePreference: async (themePreference) => {
      guard()
      record('platform-theme', themePreference)
      systemState = {
        ...systemState,
        preferences: { ...systemState.preferences, themePreference },
        appearance: {
          ...systemState.appearance,
          theme: themePreference === 'system' ? 'dark' : themePreference,
        },
      }
      return changed()
    },
    setHighContrast: async (highContrast) => {
      guard()
      record('platform-contrast', highContrast)
      systemState = {
        ...systemState,
        preferences: { ...systemState.preferences, highContrast },
        appearance: { ...systemState.appearance, highContrast },
      }
      return changed()
    },
    setStartup: async (enabled) => {
      guard()
      record('platform-startup', enabled)
      systemState = {
        ...systemState,
        startup: { ...systemState.startup, requested: enabled, enabled },
      }
      return changed()
    },
    getProxyStatus: async () => {
      record('platform-proxy')
      return {
        readOnly: true,
        scope: 'electron-session',
        targetOrigin: 'https://fixture.invalid',
        route: 'direct',
        summary: '应用窗口当前直接连接',
        note: '仅测试应用窗口路由，账号与工具流量保持原有链路。',
      }
    },
    setNotificationPreference: async (kind, enabled) => {
      guard()
      record('platform-notification', { kind, enabled })
      systemState = {
        ...systemState,
        preferences: {
          ...systemState.preferences,
          notifications: {
            install: true,
            balance: true,
            task: true,
            cliUpdate: true,
            ...systemState.preferences.notifications,
            [kind]: enabled,
          },
        },
      }
      return changed()
    },
    setPrivacyPreference: async (kind, enabled) => {
      guard()
      record('platform-privacy', { kind, enabled })
      const privacy = { anonymousUsage: false, ...systemState.preferences.privacy }
      privacy[kind] = enabled
      systemState = {
        ...systemState,
        preferences: { ...systemState.preferences, privacy },
      }
      return changed()
    },
    testNotification: async () => {
      record('test-notification')
      return settings.desktopNotifications ? 'requested' : 'disabled'
    },
    notifyActivity: async (kind, eventKey) => {
      record('activity-notification', { kind, eventKey })
      return 'requested'
    },
    onStateChanged: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  window.xingmangPlatform = platform
}
const root = createRoot(document.getElementById('root')!)
const renderFixture = (paymentReturn?: {
  sequence: number
  order: string | null
}) =>
  root.render(
    <Shell
      activePage={page}
      platform={query.get('os') === 'mac' ? 'mac' : 'win'}
      account={{
        signedIn: true,
        displayName: profile.username,
        balance: '$10.00',
      }}
      version="0.1.31"
      environment="Node.js 已安装"
      adapter={{ navigate: (next) => record('navigate', next) }}
    >
      <BalanceTierProvider value="warn">
        <BusinessPage
          api={api}
          page={page}
          accountTab={
            paymentReturn
              ? 'orders'
              : ((query.get('accountTab') as Parameters<
                  typeof BusinessPage
                >[0]['accountTab']) ?? undefined)
          }
          paymentReturn={paymentReturn}
          navigate={(next) => record('navigate', next)}
          openLogin={() => record('login')}
        />
      </BalanceTierProvider>
    </Shell>,
  )
let paymentSequence = 0
window.addEventListener('test-payment-return', () =>
  renderFixture({ sequence: ++paymentSequence, order: 'TEST-ORDER' }),
)
// 真实环境里余额 store 每 30 秒 publish 一次，整棵树跟着重渲染；夹具用一次
// root.render 复现同一件事，不动任何页面状态。
window.rerenderFixture = () => renderFixture()
renderFixture()
