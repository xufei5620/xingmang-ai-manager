import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { EmptyStatus } from '../src/app-shared'
import { rememberStartChoice } from '../src/onboarding-choice'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import { ipcEventChannels } from '../electron/ipc-contract'
import type { AccountProfile, AccountSessionState, AppSettingsV2, AppConfigSummary, ExternalDeepLink, ProviderConfigSummary, UpdateSnapshot, XingmangApi } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

const search = new URLSearchParams(location.search)
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const snapshot = EmptyStatus()
if (search.get('desktop') === 'true') snapshot.desktopApps.codex = { ...snapshot.desktopApps.codex, installed: true, version: '1.0', running: false }
const emptyConfig = { exists: false, hasApiKey: false, matchesRelay: false, model: '', baseUrl: 'https://xm.solov.cc', actualBaseUrl: '', dataDirectory: 'C:\\fixture', dataDirectoryExists: true, files: [], updatedAt: null, apiKeyPreview: null } satisfies ProviderConfigSummary
const config: AppConfigSummary = { workspace: 'C:\\fixture', providers: { codex: { ...emptyConfig }, claude: { ...emptyConfig }, gemini: { ...emptyConfig }, grok: { ...emptyConfig } } }
if (search.get('desktop') === 'true') config.providers.codex = { ...emptyConfig, exists: true, hasApiKey: true, matchesRelay: true, model: 'fixture-model' }
let settings: AppSettingsV2 = { version: 2, workspace: 'C:\\fixture', theme: 'dark', checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false }
function profile(id = 1): AccountProfile { return { userId: id, username: id === 1 ? 'account-a' : 'account-b', group: 'default', role: 1, quota: 2_000_000, usedQuota: 0 } }
let current: AccountSessionState = search.get('logged') === 'true' ? { authenticated: true, account: profile() } : { authenticated: false, account: null }
const update: UpdateSnapshot = { phase: 'disabled', currentVersion: '0.1.31', availableVersion: null, releaseName: null, releaseNotesText: null, checkedAt: null, progress: null, error: null, development: true }
const balance = { quota: 2_000_000, usedQuota: 0, quotaPerUnit: 500_000, quotaDisplayType: 'USD', usdExchangeRate: 7.3, displayAmount: 4 }
const saved = [1, 2].map((userId) => ({ id: String(userId).repeat(64), userId, username: profile(userId).username, origin: 'https://xm.solov.cc', updatedAt: '2026-09-07T00:00:00Z' }))
declare global { interface Window { appHarness: { calls: string[]; unexpected: string[]; errors: string[]; failSetting: string | null; failSwitch: boolean; closeReports: unknown[]; deepLink: ExternalDeepLink | null; emit(name: string, payload: unknown): void } } }
window.appHarness = {
  calls: [], unexpected: [], errors: [], failSetting: null, failSwitch: false, closeReports: [],
  deepLink: search.get('invite') ? { kind: 'invite', code: search.get('invite')! } : null,
  emit(name, payload) { listeners.get(name)?.forEach((listener) => listener(payload)) },
}
if (search.get('completed') === 'true') rememberStartChoice(localStorage, 'solov', 1, 'chat')

const api = {
  getPlatformCapabilities: async () => platformCapabilitiesFor('win32', 'x64'),
  getWindowCapabilities: async () => ({ tray: true, notifications: false }),
  takeExternalDeepLink: async () => { const link = window.appHarness.deepLink; window.appHarness.deepLink = null; return link },
  getSettings: async () => ({ ...settings }),
  saveSettings: async (patch) => {
    if (window.appHarness.failSetting && window.appHarness.failSetting in patch) throw new Error('Fixture settings write failed')
    settings = { ...settings, ...patch, uiSkin: patch.uiSkin === 'auto' ? undefined : patch.uiSkin ?? settings.uiSkin,
      uiScale: patch.uiScale === 'auto' ? undefined : patch.uiScale ?? settings.uiScale,
      closeBehavior: patch.closeBehavior === 'ask' ? undefined : patch.closeBehavior ?? settings.closeBehavior,
      mirrorPolicy: patch.mirrorPolicy === 'auto' ? undefined : patch.mirrorPolicy ?? settings.mirrorPolicy,
      windowState: patch.windowState === null ? undefined : patch.windowState ?? settings.windowState }
    return { ...settings }
  },
  setWindowTheme: async (theme) => { settings.theme = theme },
  setWindowMode: async () => {},
  getRepositoryContext: async () => ({ repositoryRoot: 'C:\\fixture' }),
  getConfig: async () => structuredClone(config),
  getCodexReadiness: async () => ({ hasApiKey: config.providers.codex.hasApiKey, matchesRelay: config.providers.codex.matchesRelay }),
  getCodexSetupStatus: async () => ({ checkedAt: new Date().toISOString(), runtime: snapshot.runtime, cli: snapshot.clis.codex, desktop: snapshot.desktopApps.codex }),
  scanSystem: async () => structuredClone(snapshot),
  getCodexDesktopStatus: async () => structuredClone(snapshot.desktopApps.codex),
  getUpdateState: async () => update,
  runStartupUpdate: async () => update,
  getAccountSession: async () => structuredClone(current),
  getAccountBalance: async () => ({ ...balance }),
  getAccountTopupOrders: async () => ({ page: 1, pageSize: 10, total: 0, orders: [] }),
  getAccountNotice: async () => ({ id: 'fixture-notice', text: '服务公告测试' }),
  getRememberedAccountLogin: async () => null,
  setRememberedAccountLogin: async () => {},
  syncManagedCliKeys: async () => ({ ready: [], failed: [] }),
  loginAccount: async () => { current = { authenticated: true, account: profile() }; return { account: profile(), accessExpiresAt: null } },
  logoutAccount: async () => { current = { authenticated: false, account: null } },
  listSavedAccounts: async () => [...saved],
  switchSavedAccount: async (id) => {
    if (window.appHarness.failSwitch) throw new Error('目标登录已过期')
    current = { authenticated: true, account: profile(id === saved[0].id ? 1 : 2) }
    return structuredClone(current)
  },
  removeSavedAccount: async () => {},
  configureManagedCliKeys: async () => ({ configured: [], failed: [] }),
  getAccountProfile: async () => ({ ...profile(current.account?.userId), displayName: current.account?.username ?? '', email: 'fixture@example.com', quota: 2_000_000, usedQuota: 0, requestCount: 0, affCode: null, affCount: 0, affQuota: 0, affHistoryQuota: 0 }),
  getAccountLoginSessions: async () => [],
  listAiChatGroups: async () => [],
  listMcpServers: async () => [],
  listSkills: async () => [],
  listPlugins: async () => ({ plugins: [], marketplaces: [] }),
  chooseWorkspace: async () => settings.workspace,
  openExternal: async () => true,
  replyWindowClose: async (requestId, report) => { window.appHarness.closeReports.push({ requestId, ...report }); return true },
  reportRendererError: async (input) => { window.appHarness.errors.push(input.message) },
  launchCli: async () => {},
  launchCodexDesktop: async () => ({ status: { ...snapshot.desktopApps.codex, running: true }, restarted: false }),
} satisfies Partial<XingmangApi>

const eventNames = new Set(Object.keys(ipcEventChannels))
window.xingmang = new Proxy(api, {
  get(target, property) {
    if (typeof property !== 'string') return undefined
    if (eventNames.has(property)) return (listener: (payload: unknown) => void) => {
      const subscribers = listeners.get(property) ?? new Set()
      subscribers.add(listener)
      listeners.set(property, subscribers)
      return () => subscribers.delete(listener)
    }
    const operation = Reflect.get(target, property)
    if (typeof operation === 'function') return (...args: unknown[]) => { window.appHarness.calls.push(property); return Reflect.apply(operation, target, args) }
    return () => { window.appHarness.unexpected.push(property); throw new Error(`Unexpected fixture API: ${property}`) }
  },
}) as unknown as XingmangApi
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
