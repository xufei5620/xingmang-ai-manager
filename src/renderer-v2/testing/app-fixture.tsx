import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ipcEventChannels, type AppSettingsV2, type AppConfigSummary, type AccountSessionState, type MultiProviderSessionPage, type ProviderId, type SystemSnapshot, type XingmangApi } from '../../../electron/ipc-contract'
import RendererV2App from '../App'
import { getSourceMarkerStorage, writeManualSourceMarker } from '../features/tools/source-marker'
import { resolveManagedCliKeyProfiles } from '../../../electron/catalog'
import '../styles/tokens.css'
import '../styles/components.css'
import '../styles/shell.css'
import '../app.css'

const query = new URLSearchParams(location.search)
const nativeFixtureScope = 'xm-native-12345678fixture'
const nativeFixturePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const nativeFixtureLogo = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 176 69"><path fill="currentColor" d="M0 0h176v69H0z"/></svg>')}`
const nativeFixtureNotice = `<div class="${nativeFixtureScope}" data-xm-native="fixture-v1">
  <style data-xm-base>@import url("https://attacker.invalid/import.css");.${nativeFixtureScope}{--xm-native-art-0:url("${nativeFixturePng}");color:#123}.${nativeFixtureScope} .title{font-weight:700;background-image:url("https://attacker.invalid/pixel.png");border-image-source:\\75\\72\\6c(\\68\\74\\74\\70\\73\\3a//attacker.invalid/escaped.png);color:rgb(12,34,56)}.${nativeFixtureScope} .art{background-image:var(--xm-native-art-0)}.outside-escape{--escaped:1}</style>
  <style data-xm-switch>.${nativeFixtureScope}>[data-xm-state]{display:block}</style>
  <div data-xm-state="zh-light" lang="zh-CN"><h1 class="title" onmouseover="window.nativeXss=true">亮色公告</h1><img class="logo" src="${nativeFixtureLogo}" alt="Xingmang AI" width="176" height="69"><div class="art" style="background-image:var(--xm-native-art-0)"></div><a class="safe-link" href="https://xm.solov.cc/help">官方说明</a><a class="unsafe-link" href="javascript:alert(1)" data-xm-external-href="https://attacker.invalid/forged">危险链接</a><img class="qr" src="${nativeFixturePng}" alt="二维码" width="144" height="144"><img class="remote" src="https://attacker.invalid/image.png" onerror="window.nativeXss=true"><form><input value="secret"></form><script>window.nativeXss=true</script></div>
  <div data-xm-state="zh-dark" lang="zh-CN" hidden><h1 class="title">暗色公告</h1><img class="logo" src="${nativeFixtureLogo}" alt="Xingmang AI" width="176" height="69"><a class="safe-link" href="https://xm.solov.cc/help">官方说明</a></div>
  <div data-xm-state="en-light" lang="en" hidden><h1>English light</h1></div>
  <div data-xm-state="en-dark" lang="en" hidden><h1>English dark</h1></div>
</div>`
let settings: AppSettingsV2 = { version: 2, workspace: 'C:\\Fixture', theme: query.get('theme') === 'dark' ? 'dark' : 'light', runDiagnosticsOnStartup: query.has('diagnostics'), checkUpdatesOnStartup: query.has('startupUpdate') }
const account = { userId: 17, username: 'fixture-user', group: 'default', role: 1, quota: 6_200_000, usedQuota: 0 }
let session: AccountSessionState = { authenticated: query.get('guest') !== '1', account: query.get('guest') === '1' ? null : account }
const sub2ApiMetadata = { siteId: 'solov-api' as const, realmId: 'api-account' as const, capabilities: { supportsRegistration: false, supportsPasswordReset: false, supportsKeyManagement: true, supportsUsage: false, supportsBilling: false, supportsSubscriptions: false, supportsProfileUpdate: true, supportsSessionManagement: false, supportsAutoKeyProvision: true, supportsAccountSession: true } }
if (query.has('sub2api')) session = { ...session, ...sub2ApiMetadata }
// Settings deliberately retain the historical site: active session owns routing.
settings.relaySiteId = 'solov'
const status = { installed: true, version: '1.2.3', path: 'C:\\Fixture\\bin', installDirectory: 'C:\\Fixture', latestVersion: '1.2.3', updateAvailable: false,
  uninstall: { available: true, reason: null, manualCommand: null, delegated: false } }
const configValue = { exists: true, hasApiKey: true, matchesRelay: true, baseUrl: 'https://xm.solov.cc/v1', actualBaseUrl: 'https://xm.solov.cc/v1', model: 'fixture-model', apiKeyPreview: 'sk-***', dataDirectory: 'C:\\Fixture', dataDirectoryExists: true, files: [], updatedAt: null }
const config: AppConfigSummary = { workspace: settings.workspace, providers: { claude: { ...configValue }, codex: { ...configValue }, gemini: { ...configValue }, grok: { ...configValue } } }
if (query.has('keyOptions')) {
  config.providers.codex.apiKeyPreview = 'sk-co••••1234'
  config.providers.claude.apiKeyPreview = 'sk-cl••••5678'
}
const selectedKeyIds = new Map<ProviderId, number>()
const keyMetadataReads = new Map<ProviderId, number>()
const pendingKeyMetadata = new Map<ProviderId, () => void>()
if ((query.get('guest') === '1' && !query.has('existing')) || query.has('missingConfig')) for (const provider of Object.values(config.providers)) { provider.exists = false; provider.hasApiKey = false; provider.matchesRelay = false; provider.actualBaseUrl = ''; provider.model = '' }
if (query.has('official')) { config.providers.codex.hasApiKey = false; config.providers.codex.codexAuthMode = 'chatgpt' }
if (query.has('unknown')) { config.providers.codex.matchesRelay = false; config.providers.codex.actualBaseUrl = 'https://other.example.test/v1' }
if (query.has('unknownClaude')) { config.providers.claude.exists = true; config.providers.claude.hasApiKey = true; config.providers.claude.matchesRelay = false; config.providers.claude.actualBaseUrl = 'https://other.example.test' }
if (query.has('manualClaude')) {
  config.providers.claude = { ...configValue }
  writeManualSourceMarker(getSourceMarkerStorage(), configValue.baseUrl, 'claude', true)
}
const system: SystemSnapshot = { checkedAt: '2026-09-07T01:00:00Z',
  network: { region: 'unknown', publicIp: null, countryCode: null, checkedAt: '2026-09-07T01:00:00Z', error: null },
  runtime: { node: { ...status, version: 'v24.0.0' }, npm: { ...status, version: '11.0.0' }, python: { ...status, version: '3.12.0' } },
  clis: { claude: { ...status }, codex: { ...status }, gemini: { ...status, installed: query.has('allInstalled') }, grok: { ...status, installed: query.has('allInstalled') } },
  desktopApps: { codex: { ...status, appVersion: '1.2.3', mirrorVersion: null, mirrorUpdateAvailable: false, mirrorError: null, running: query.has('running') } },
}
if (query.has('detectionFailed')) {
  system.clis.claude = { ...system.clis.claude, detectionFailed: true, detectionError: '本地探针暂时不可用' }
}
if (query.has('uninstallUnavailable')) {
  system.clis.claude = {
    ...system.clis.claude,
    uninstall: {
      available: false,
      reason: '当前安装来源不支持安全自动卸载',
      manualCommand: null,
      delegated: false,
    },
  }
}
declare global { interface Window { v2Test: { calls: Array<{ method: string; args: unknown[] }>; unexpected: string[]; errors: string[]; fail: string; emit(name: string, payload: unknown): void; releaseBootstrap(): void; releaseLaunch(): void; releaseKeyMetadata(provider: ProviderId): void } } }
const listeners = new Map<string, Set<(payload: unknown) => void>>()
let releaseBootstrap: () => void = () => undefined
let releaseLaunch: () => void = () => undefined
window.v2Test = { calls: [], unexpected: [], errors: [], fail: '', emit(name, payload) { if (name === 'onAccountSessionChanged') session = payload as AccountSessionState; listeners.get(name)?.forEach((listener) => listener(payload)) }, releaseBootstrap() { releaseBootstrap() }, releaseLaunch() { releaseLaunch() }, releaseKeyMetadata(provider) { pendingKeyMetadata.get(provider)?.(); pendingKeyMetadata.delete(provider) } }
window.addEventListener('error', (event) => window.v2Test.errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => window.v2Test.errors.push(String(event.reason)))
const capabilities = { platform: query.get('os') === 'mac' ? 'macos' : 'windows', architecture: 'x64', isMac: query.get('os') === 'mac', nodeRuntimeInstall: 'managed', pythonRuntimeInstall: 'managed', cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' }, codexDesktop: { install: 'managed', launch: true, uninstall: true, windowsStore: true } } as const
const balance = { quota: 6_200_000, usedQuota: 0, quotaPerUnit: 500_000, quotaDisplayType: 'USD', usdExchangeRate: 7.3, displayAmount: 12.4 }
function sessionCapability(provider: ProviderId): MultiProviderSessionPage['capabilities'][ProviderId] {
  return { provider, available: true, readable: true, readonly: true, source: 'jsonl', reason: '', operations: { list: true, detail: true, exportMarkdown: true, archive: false, restore: false } }
}
const methods = {
  getSettings: async () => ({ ...settings }),
  saveSettings: async (patch) => { settings = { ...settings, theme: patch.theme ?? settings.theme, reducedMotion: patch.reducedMotion ?? settings.reducedMotion }; return settings },
  getPlatformCapabilities: async () => capabilities,
  getAccountSession: async () => session,
  getAccountBalance: async () => session.siteId === 'solov-api' ? { ...balance, quota: 12.4, quotaPerUnit: 1 } : balance,
  getAccountUsage: async () => ({ page: 1, pageSize: 1, total: 0, records: [], stats: { quota: 1_000_000, rpm: 0, tpm: 0 } }),
  getWindowCapabilities: async () => ({ tray: true, notifications: true }),
  getUpdateState: async () => ({ phase: query.has('startupUpdate') ? 'idle' : 'disabled', currentVersion: '0.1.31', availableVersion: null, releaseName: null, releaseNotesText: null, checkedAt: null, progress: null, error: null, development: true }),
  runStartupUpdate: async () => { throw new Error('本地更新源暂时不可用') },
  runDiagnostics: async () => ({ version: 1, generatedAt: new Date().toISOString(), durationMs: 1, counts: { pass: 1, warn: 0, fail: 0, error: 0 }, items: [] }),
  scanSystem: async () => {
    if (query.has('desktopEvent')) window.v2Test.emit('onCodexDesktopStatus', { status: { ...system.desktopApps.codex, appVersion: '9.9.9' } })
    return structuredClone(system)
  },
  getConfig: async () => structuredClone(config),
  chooseWorkspace: async () => {
    if (query.has('workspaceCancel')) return null
    const workspace = 'C:\\Selected Project'
    settings = { ...settings, workspace }
    config.workspace = workspace
    return workspace
  },
  takeExternalDeepLink: async () => null,
  getAccountNotice: async () => {
    if (query.has('noticeOversized')) throw new Error("Error invoking remote method 'account:get-notice': Error: 公告读取响应超过 512 KB 安全上限")
    if (query.has('noticeNative')) return { id: 'native-notice', text: nativeFixtureNotice }
    if (query.has('noticeMarkdown')) return { id: 'markdown-notice', text: '# 服务公告\n\n- 第一项\n- 第二项\n\n**重点提醒**：请查看 [官方说明](https://xm.solov.cc/help)。' }
    return { id: 'local-notice', text: '本地测试公告' }
  },
  getAccountStatus: async () => ({ systemName: 'Fixture', version: '1', setupComplete: true, quotaPerUnit: 500000, quotaDisplayType: 'USD', usdExchangeRate: 7.3, registerEnabled: true, passwordRegisterEnabled: true, emailVerificationEnabled: true, turnstileCheckEnabled: false }),
  getRememberedAccountLogin: async () => null,
  setRememberedAccountLogin: async () => {},
  loginAccount: async (input) => { const resolvedSite = input.siteId ?? (query.has('sub2api') ? 'solov-api' : 'solov'); session = { authenticated: true, account, ...(resolvedSite === 'solov-api' ? sub2ApiMetadata : { siteId: 'solov' as const }) }; return { ...session, account, accessExpiresAt: null } },
  registerAccount: async () => {},
  logoutAccount: async () => { session = { authenticated: false, account: null } },
  listProviderSessions: async () => ({ items: [], page: 1, pageSize: 3, total: 0, pages: 1, stats: { total: 0, byProvider: { claude: 0, codex: 0, gemini: 0, grok: 0 } }, capabilities: { claude: sessionCapability('claude'), codex: sessionCapability('codex'), gemini: sessionCapability('gemini'), grok: sessionCapability('grok') } }),
  launchCli: async () => query.has('launchPending') ? new Promise<void>((resolve) => { releaseLaunch = resolve }) : undefined,
  launchCodexDesktop: async () => ({ restarted: false, status: system.desktopApps.codex }),
  getCodexDesktopStatus: async () => structuredClone(system.desktopApps.codex),
  installCli: async (provider) => { system.clis[provider] = { ...system.clis[provider], installed: true, version: '2.0.0' } },
  installCodexDesktop: async () => ({ action: 'unchanged', previousVersion: '1.2.3', installedVersion: '1.2.3' }),
  getAccountKeys: async () => ({ keys: query.has('keyOptions') ? [
    { id: 201, name: 'coding-key', group: 'Codex_pro', maskedKey: 'sk-se••••9012', status: 1, remainQuota: 10, usedQuota: 0, unlimitedQuota: true, createdAt: '', accessedAt: null, expiredAt: null },
    { id: 202, name: 'custom-key', group: 'Custom group', maskedKey: 'sk-ot••••1234', status: 1, remainQuota: 10, usedQuota: 0, unlimitedQuota: true, createdAt: '', accessedAt: null, expiredAt: null },
  ] : [], total: query.has('keyOptions') ? 2 : 0, page: 1, pageSize: 100 }),
  getAccountKeyOptions: async (provider: ProviderId) => {
    const reads = (keyMetadataReads.get(provider) ?? 0) + 1
    keyMetadataReads.set(provider, reads)
    if (query.get('keyMetadataFail') === provider) throw new Error('当前密钥信息暂时没有读到')
    if (query.get('keyMetadataPending') === provider && reads === 1) await new Promise<void>((resolve) => pendingKeyMetadata.set(provider, resolve))
    const automatic = resolveManagedCliKeyProfiles(session.siteId)[provider]
    const keyId = selectedKeyIds.get(provider)
    const stored = config.providers[provider]
    return { current: { preview: stored.hasApiKey ? stored.apiKeyPreview : null, keyId: keyId ?? null,
      name: keyId === 201 ? 'coding-key' : keyId === 202 ? 'custom-key' : null,
      group: keyId === 201 ? 'Codex_pro' : keyId === 202 ? 'Custom group' : null },
      automatic: { name: automatic.keyName, group: automatic.group } }
  },
  listAccountKeyModels: async (id: number) => id === 201 ? ['gpt-5.6-sol'] : ['fixture-model', 'fixture-other'],
  saveConfigWithAccountKey: async (input) => {
    selectedKeyIds.set(input.provider, input.keyId)
    config.providers[input.provider] = { ...config.providers[input.provider], model: input.model, apiKeyPreview: input.keyId === 201 ? 'sk-se••••9012' : 'sk-ot••••1234' }
    return { backups: [], files: [] }
  },
  switchToOfficialAccount: async (provider: ProviderId) => {
    config.providers[provider] = { ...config.providers[provider], hasApiKey: false,
      ...(provider === 'codex' ? { codexAuthMode: 'chatgpt' as const } : {}) }
    return { backups: [], files: [] }
  },
  getAccountUsableGroups: async () => [{ name: session.siteId === 'solov-api' ? 'Codex_pro' : 'GPT-中转/订阅', description: 'Codex', ratio: 1 }],
  createAccountKey: async () => undefined,
  changeAccountPassword: async () => {
    session = { ...session, authenticated: false, account: null }
    window.v2Test.emit('onAccountSessionChanged', session)
    return { changed: true as const }
  },
  listConfiguredModels: async (provider: ProviderId) => [config.providers[provider].model || 'fixture-model'],
  listModels: async () => ['fixture-model', 'fixture-other'],
  syncManagedCliKeys: async () => {
    const result = { ready: (['claude', 'codex', 'grok', 'gemini'] as ProviderId[]).map((provider) => ({ provider, group: `${provider}-group`, name: `${provider}-key` })), failed: [] }
    if (!query.has('bootstrapPending')) return result
    return new Promise<typeof result>((resolve) => { releaseBootstrap = () => resolve(result) })
  },
  configureManagedCliKeys: async (input) => {
    const configured: ProviderId[] = []
    const failed: Array<{ provider: ProviderId; message: string }> = []
    for (const provider of input.providers) {
      if (query.has('bootstrapPartial') && provider === 'claude' && window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length === 1) {
        failed.push({ provider, message: 'Claude 分组暂时不可用' })
        continue
      }
      config.providers[provider] = { ...config.providers[provider], exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: config.providers[provider].baseUrl, model: input.preferredModels[provider] || 'fixture-model', ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}), ...(provider === 'codex' ? { codexAuthMode: 'apikey' as const } : {}) }
      if (query.has('autoFallback') && provider === 'codex') {
        config.providers[provider].model = 'gpt-5.6-sol'
        config.providers[provider].apiKeyPreview = 'sk-se••••9012'
        selectedKeyIds.set(provider, 201)
      }
      configured.push(provider)
    }
    return { configured, failed }
  },
  saveConfig: async (input) => {
    const current = config.providers[input.provider]
    config.providers[input.provider] = {
      ...current,
      exists: true,
      hasApiKey: true,
      matchesRelay: true,
      actualBaseUrl: current.baseUrl,
      model: input.model,
      ...(input.provider === 'gemini' ? { authType: 'gemini-api-key' } : {}),
      ...(input.provider === 'codex' ? { codexAuthMode: 'apikey' as const } : {}),
    }
    return { backups: [], files: [] }
  },
  refreshOfficialChatGptUsage: async () => ({ planLabel: 'Plus', renewsAt: null, resetCredits: null, windows: [{ id: 'weekly', label: '周限额', remainingPercent: 72, resetAt: null }], checkedAt: new Date().toISOString() }),
  listAiChatGroups: async () => [{ name: 'fixture-group', description: '本地测试分组', ratio: 1 }],
  prepareAiChatGroup: async (group: string) => ({ group, models: ['gpt-test'], keyCreated: false }),
  startAiChat: async (input) => ({ requestId: input.requestId, accepted: true }),
  cancelAiChat: async () => ({ canceled: true, mayStillComplete: false }),
  getLegalDocument: async (kind) => ({ kind, markdown: '# 本地协议\n\n测试内容。', fetchedAt: '2026-09-07T00:00:00Z' }),
  getAccountProfile: async () => ({ ...account, displayName: account.username, email: 'fixture@example.com', requestCount: 0, affCode: 'test', affCount: 0, affQuota: 0, affHistoryQuota: 0 }),
  getAccountLoginSessions: async () => [],
  listSavedAccounts: async () => query.has('crossSite') ? [{ id: 'saved-aa0017', origin: 'https://api.solov.cc', userId: 17, username: 'fixture-user', updatedAt: '2026-09-07T00:00:00Z' }] : query.has('savedAccount') ? [{ id: 'saved-18', origin: 'https://xm.solov.cc', userId: 18, username: 'saved-user', updatedAt: '2026-09-07T00:00:00Z' }] : [],
  switchSavedAccount: async () => {
    const nextAccount = query.has('crossSite') ? account : { ...account, userId: 18, username: 'saved-user' }
    session = { authenticated: true, account: nextAccount, ...(query.has('crossSite') ? sub2ApiMetadata : {}) }
    if (query.has('savedAccount')) for (const provider of Object.values(config.providers)) { provider.exists = false; provider.hasApiKey = false; provider.matchesRelay = false; provider.actualBaseUrl = ''; provider.model = '' }
    return session
  },
  replyWindowClose: async () => true,
  openExternal: async () => true,
} satisfies Partial<XingmangApi>
const eventNames = new Set(Object.keys(ipcEventChannels))
const api = new Proxy(methods, { get(target, name) {
  if (typeof name !== 'string') return undefined
  if (eventNames.has(name)) return (callback: (payload: unknown) => void) => { const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group); return () => group.delete(callback) }
  return async (...args: unknown[]) => {
    window.v2Test.calls.push({ method: name, args: name === 'loginAccount' ? [] : args })
    if (window.v2Test.fail === name) throw new Error('本地测试操作失败')
    const operation = Reflect.get(target, name)
    if (typeof operation !== 'function') { window.v2Test.unexpected.push(name); throw new Error(`Missing mock: ${name}`) }
    return Reflect.apply(operation, target, args)
  }
} }) as unknown as XingmangApi
window.xingmang = api
createRoot(document.getElementById('root')!).render(<StrictMode><RendererV2App api={api} /></StrictMode>)
