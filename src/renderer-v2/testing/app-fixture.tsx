import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import QRCode from 'qrcode'
import { ipcEventChannels, type AppSettingsV2, type AppConfigSummary, type AccountSessionState, type ExternalClientStatus, type ExternalToolId, type MultiProviderSessionPage, type ProviderId, type SystemSnapshot, type XingmangApi } from '../../../electron/ipc-contract'
import RendererV2App from '../App'
import { createPreviewAccelerationApi } from './acceleration-fixture'
import { accelerationTrialSeconds } from '../../../electron/acceleration-contract'
import { getSourceMarkerStorage, writeManualSourceMarker } from '../features/tools/source-marker'
import { resolveManagedCliKeyProfiles } from '../../../electron/catalog'
import '../styles/tokens.css'
import '../styles/components.css'
import '../styles/shell.css'
import '../app.css'

const query = new URLSearchParams(location.search)
const accelerationDemo = createPreviewAccelerationApi({ remainingSeconds: query.has('accelerationExhausted') ? 0 : query.has('accelerationShort') ? 3 : accelerationTrialSeconds, storage: window.localStorage })
const noticesRead = new Set<string>(query.has('noticesRead') ? ['12', '8'] : [])
const localNoticesRead = new Map<string, string[]>()
declare global { interface Window { fixtureNoticeStore?: (scope: string, ids: string[]) => Promise<string[]>; fixtureSupportQrCode: (url: string) => Promise<string> } }
window.fixtureSupportQrCode = (url) => QRCode.toDataURL(url, { width: 192, margin: 1, errorCorrectionLevel: 'M' })
const pendingNoticeMarks = new Map<string, () => void>()
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
const collectionFixture = `<div class="xm-newapi-collection-fixture1234" data-newapi-collection="v1">
  <header class="collection-header"><h1>星芒 AI 公告合集</h1><p>3 条公告</p></header>
  ${['图片模型上线', '旧模型下架通知', '发票中心上线'].map((title, index) => `<details class="collection-entry" id="collection-${index}" ${index === 0 ? 'open' : ''}>
    <summary class="collection-summary"><span class="collection-meta"><span>最新</span><time>2026-09-09</time></span><span class="collection-entry-title">${title}</span></summary>
    <div class="collection-body">${nativeFixtureNotice.replaceAll('亮色公告', `${title}亮色详情`).replaceAll('暗色公告', `${title}暗色详情`)}</div>
  </details>`).join('')}
</div>`
let noticeOverride: { id: string; text: string } | null = null
// The Chinese runtime patch defaults to an answered 'enabled' here: an
// ordinary launch must not be interrupted by the one-time question, which
// `chineseAsk` exercises on its own.
let settings: AppSettingsV2 = { version: 2, workspace: 'C:\\Fixture', theme: query.get('theme') === 'dark' ? 'dark' : 'light', runDiagnosticsOnStartup: query.has('diagnostics'), checkUpdatesOnStartup: query.has('startupUpdate'),
  ...(query.has('chineseAsk') ? {} : { codexDesktopChineseRuntimePatch: 'enabled' as const }) }
const account = { userId: 17, username: 'fixture-user', group: 'default', role: 1, quota: 6_200_000, usedQuota: 0 }
let session: AccountSessionState = { authenticated: query.get('guest') !== '1', account: query.get('guest') === '1' ? null : account }
const sub2ApiMetadata = { siteId: 'solov-api' as const, realmId: 'api-account' as const, capabilities: { supportsRegistration: false, supportsPasswordReset: false, supportsKeyManagement: true, supportsUsage: false, supportsBilling: false, supportsSubscriptions: false, supportsProfileUpdate: true, supportsSessionManagement: false, supportsAutoKeyProvision: true, supportsAccountSession: true } }
if (query.has('sub2api')) session = { ...session, ...sub2ApiMetadata }
// Settings deliberately retain the historical site: active session owns routing.
settings.relaySiteId = 'solov'
const status = { installed: true, version: '1.2.3', path: 'C:\\Fixture\\bin', installDirectory: 'C:\\Fixture', latestVersion: '1.2.3', updateAvailable: false,
  uninstall: { available: true, reason: null, manualCommand: null, delegated: false } }
const externalStatuses: ExternalClientStatus[] = (['workbuddy', 'claudeDesktop', 'opencode'] as ExternalToolId[]).map((tool) => ({
  tool, installed: query.has('clientModels') || query.has('externalInstalled'), version: '1.2.3', path: `C:\\Fixture\\${tool}.exe`, installDirectory: 'C:\\Fixture', running: false,
  installSupported: query.get('externalUnsupported') !== tool, launchSupported: true, detectionError: query.get('externalDetectionError') === tool ? '客户端路径读取失败' : null,
  installHint: query.get('externalUnsupported') === tool ? '当前平台请从官方页面手动安装' : null,
  configured: query.get('externalReady') === tool, model: query.get('externalReady') === tool ? 'fixture-model' : null,
  configurationSource: query.get('externalOther') === tool ? 'other' : query.get('externalReady') === tool ? 'xingmang' : 'missing',
  ...(tool === 'claudeDesktop' ? { configurationReady: query.get('externalReady') === tool || query.get('externalLocalReady') === tool } : {}),
  configurationError: query.get('externalConfigError') === tool ? '当前配置读取失败，可在客户端中检查' : null,
}))
const externalOwnerSite = session.siteId ?? 'solov'
const configValue = { exists: true, hasApiKey: true, matchesRelay: true, configurationOwnership: 'account' as const, baseUrl: 'https://xm.solov.cc/v1', actualBaseUrl: 'https://xm.solov.cc/v1', model: 'fixture-model', apiKeyPreview: 'sk-***', dataDirectory: 'C:\\Fixture', dataDirectoryExists: true, files: [], updatedAt: null }
const config: AppConfigSummary = { workspace: settings.workspace, providers: { claude: { ...configValue }, codex: { ...configValue }, gemini: { ...configValue }, grok: { ...configValue } } }
if (query.has('cliMissingModels')) for (const provider of Object.values(config.providers)) provider.model = ''
const detectedModelsByProvider: Record<ProviderId, string[]> = {
  claude: ['claude-opus-4-8', 'claude-opus-5', 'fixture-model'],
  codex: ['codex-auto-review', 'gpt-6-astra', 'fixture-model'],
  gemini: ['gemini-3.7-flash', 'gemini-3.8-flash-high', 'fixture-model'],
  grok: ['grok-4', 'grok-4.6', 'fixture-model'],
}
const detectedModels = query.has('cliDefaultModels') ? Object.values(detectedModelsByProvider).flat() : ['fixture-model', 'fixture-other']
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
  config.providers.claude = { ...configValue, configurationOwnership: 'manual' }
  writeManualSourceMarker(getSourceMarkerStorage(), configValue.baseUrl, 'claude', true)
}
if (query.has('unownedClaude')) config.providers.claude = { ...configValue, configurationOwnership: 'unknown' }
if (query.has('lostManualMarker')) writeManualSourceMarker(getSourceMarkerStorage(), configValue.baseUrl, 'claude', false)
const readOnlyConfigOwner = { siteId: session.siteId ?? 'solov', userId: account.userId }
if (query.has('readOnlyAccountMatch')) {
  for (const provider of Object.keys(config.providers) as ProviderId[]) {
    config.providers[provider].configurationOwnership = 'unknown'
    if (provider === 'gemini') config.providers[provider].authType = 'gemini-api-key'
    if (query.get('matchedMissingModel') === provider) config.providers[provider].model = ''
    if (query.get('matchedManualMarker') === provider) writeManualSourceMarker(getSourceMarkerStorage(), config.providers[provider].baseUrl, provider, true)
  }
}
const system: SystemSnapshot = { checkedAt: '2026-09-07T01:00:00Z',
  network: { region: 'unknown', publicIp: null, countryCode: null, checkedAt: '2026-09-07T01:00:00Z', error: null },
  runtime: { node: { ...status, version: 'v24.0.0' }, npm: { ...status, version: '11.0.0' }, python: { ...status, version: '3.12.0' } },
  clis: { claude: { ...status }, codex: { ...status }, gemini: { ...status, installed: query.has('allInstalled') }, grok: { ...status, installed: query.has('allInstalled') } },
  desktopApps: { codex: { ...status, appVersion: '1.2.3', mirrorVersion: null, mirrorUpdateAvailable: false, mirrorError: null, running: query.has('running') } },
}
// 版本串解析不出来的 Node（自编译 / 魔改）：tooOld 仍是 false，只有
// versionStatus 说得出「认不出来」。
if (query.has('nodeVersionUnknown')) {
  system.runtime.node = { ...system.runtime.node, version: 'custom build', tooOld: false, versionStatus: 'unknown' }
}
if (query.has('desktopOnly')) {
  system.runtime.node = { ...system.runtime.node, installed: false, version: null, path: null }
  system.runtime.npm = { ...system.runtime.npm, installed: false, version: null, path: null }
  for (const provider of Object.keys(system.clis) as ProviderId[]) system.clis[provider] = { ...system.clis[provider], installed: false, version: null, path: null }
}
if (query.has('detectionFailed')) {
  system.clis.claude = { ...system.clis.claude, detectionFailed: true, detectionError: '本地探针暂时不可用' }
}
if (query.has('desktopDetectionFailed')) {
  system.desktopApps.codex = { ...system.desktopApps.codex, installed: false, version: null, path: null, appVersion: null,
    detectionFailed: true, detectionError: '已找到 Codex 应用，但签名验证未完成，请重新检测' }
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
declare global { interface Window { v2Test: { calls: Array<{ method: string; args: unknown[] }>; unexpected: string[]; errors: string[]; fail: string; emit(name: string, payload: unknown): void; releaseBootstrap(): void; releaseLaunch(): void; holdNextExternalScan(): void; releaseExternalScan(): void; holdNextConfigRead(): void; releaseConfigRead(): void; setExternalStatus(tool: ExternalToolId, patch: Partial<ExternalClientStatus>): void; releaseBalance(error?: string): void; holdNextBalance(): void; setBalance(amount: number): void; releaseKeyMetadata(provider: ProviderId): void; releaseNoticeMark(id: string): void; setNotice(value: { id: string; text: string }): void; holdNextConfigSave(): void; releaseConfigSave(error?: string): void } } }
const listeners = new Map<string, Set<(payload: unknown) => void>>()
let releaseBootstrap: () => void = () => undefined
let releaseLaunch: () => void = () => undefined
let holdExternalScan = false
let releaseExternalScan: () => void = () => undefined
let holdConfigRead = false
let releaseConfigRead: () => void = () => undefined
let releaseBalance: (error?: string) => void = () => undefined
let balanceReads = 0
let nextBalanceHeld = false
let balanceOverride: number | null = null
let nextConfigSaveHeld = false
let releaseConfigSave: (error?: string) => void = () => undefined
const configSaveMethods = new Set(['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'])
window.v2Test = { calls: [], unexpected: [], errors: [], fail: '', emit(name, payload) { if (name === 'onAccountSessionChanged') session = payload as AccountSessionState; listeners.get(name)?.forEach((listener) => listener(payload)) }, releaseBootstrap() { releaseBootstrap() }, releaseLaunch() { releaseLaunch() }, holdNextExternalScan() { holdExternalScan = true }, releaseExternalScan() { releaseExternalScan() }, holdNextConfigRead() { holdConfigRead = true }, releaseConfigRead() { releaseConfigRead() }, setExternalStatus(tool, patch) { Object.assign(externalStatuses.find((entry) => entry.tool === tool)!, patch) }, releaseBalance(error) { releaseBalance(error) }, holdNextBalance() { nextBalanceHeld = true }, setBalance(amount) { balanceOverride = amount }, releaseKeyMetadata(provider) { pendingKeyMetadata.get(provider)?.(); pendingKeyMetadata.delete(provider) }, releaseNoticeMark(id) { pendingNoticeMarks.get(id)?.(); pendingNoticeMarks.delete(id) }, setNotice(value) { noticeOverride = value }, holdNextConfigSave() { nextConfigSaveHeld = true }, releaseConfigSave(error) { releaseConfigSave(error) } }
window.addEventListener('error', (event) => window.v2Test.errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => window.v2Test.errors.push(String(event.reason)))
const capabilities = { platform: query.get('os') === 'mac' ? 'macos' : 'windows', architecture: 'x64', isMac: query.get('os') === 'mac', nodeRuntimeInstall: 'managed', pythonRuntimeInstall: 'managed', cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' }, codexDesktop: { install: 'managed', launch: true, uninstall: true, windowsStore: true } } as const
const balance = { quota: 6_200_000, usedQuota: 0, quotaPerUnit: 500_000, quotaDisplayType: 'USD', usdExchangeRate: 7.3, displayAmount: 12.4 }
function sessionCapability(provider: ProviderId): MultiProviderSessionPage['capabilities'][ProviderId] {
  return { provider, available: true, readable: true, readonly: true, source: 'jsonl', reason: '', operations: { list: true, detail: true, exportMarkdown: true, archive: false, restore: false } }
}
const methods = {
  listAccelerationLines: async () => query.has('accelerationPreview') ? accelerationDemo.listAccelerationLines?.('xm-account:17') ?? [] : [],
  pingAccelerationLine: async (_scope: string, lineId: string) => {
    const line = await accelerationDemo.pingAccelerationLine?.('xm-account:17', lineId)
    if (!line) throw new Error('加速线路不存在。')
    return line
  },
  refreshNetworkLocation: async (): Promise<SystemSnapshot['network']> => {
    if (!query.has('accelerationPreview')) return structuredClone(system.network)
    const scope = `${session.siteId === 'solov-api' ? 'api' : 'xm'}-account:${session.account?.userId ?? 17}`
    const connection = await accelerationDemo.getAccelerationState(scope)
    // Documentation-only IPs; this fixture must never query the user's network.
    return connection.phase === 'active'
      ? { region: 'outside-mainland-china', countryCode: 'SG', publicIp: '203.0.113.24', checkedAt: new Date().toISOString(), error: null }
      : { region: 'mainland-china', countryCode: 'CN', publicIp: '198.51.100.18', checkedAt: new Date().toISOString(), error: null }
  },
  getAccelerationState: async (scope: string) => query.has('accelerationPreview')
    ? accelerationDemo.getAccelerationState(scope)
    : { scope, phase: 'unavailable' as const, mode: 'system-proxy' as const, totalSeconds: accelerationTrialSeconds, remainingSeconds: null, sessionSeconds: 0, measuredAt: new Date().toISOString(), connectedAt: null, line: null, error: null },
  startAcceleration: accelerationDemo.startAcceleration,
  stopAcceleration: accelerationDemo.stopAcceleration,
  redeemAccelerationCode: async (scope: string, code: string) => {
    if (query.has('accelerationBonusPending')) await new Promise<void>((resolve) => { releaseLaunch = resolve })
    return accelerationDemo.redeemAccelerationCode!(scope, code)
  },
  getSettings: async () => ({ ...settings }),
  saveSettings: async (patch) => { settings = { ...settings, theme: patch.theme ?? settings.theme, reducedMotion: patch.reducedMotion ?? settings.reducedMotion, codexDesktopChineseRuntimePatch: patch.codexDesktopChineseRuntimePatch ?? settings.codexDesktopChineseRuntimePatch }; return settings },
  getPlatformCapabilities: async () => capabilities,
  getAccountSession: async () => session,
  getAccountBalance: async () => {
    const value = session.siteId === 'solov-api' ? { ...balance, quota: 12.4, quotaPerUnit: 1 } : { ...balance }
    if (session.account?.userId === 18) { value.displayAmount = 24.8; value.quota = 24.8 * value.quotaPerUnit }
    if (balanceOverride !== null) { value.displayAmount = balanceOverride; value.quota = balanceOverride * value.quotaPerUnit }
    if (nextBalanceHeld || (query.has('balancePending') && ++balanceReads === 1)) await new Promise<void>((resolve, reject) => {
      nextBalanceHeld = false
      releaseBalance = (error) => error ? reject(new Error(error)) : resolve()
    })
    return value
  },
  getAccountUsage: async () => ({ page: 1, pageSize: 1, total: 0, records: [], stats: { quota: 1_000_000, rpm: 0, tpm: 0 } }),
  getWindowCapabilities: async () => ({ tray: true, notifications: true }),
  getUpdateState: async () => ({ phase: query.has('startupUpdate') ? 'idle' : 'disabled', currentVersion: '0.1.31', availableVersion: null, releaseName: null, releaseNotesText: null, checkedAt: null, progress: null, error: null, development: true }),
  runStartupUpdate: async () => { throw new Error('本地更新源暂时不可用') },
  runDiagnostics: async () => ({ version: 1, generatedAt: new Date().toISOString(), durationMs: 1, counts: { pass: 1, warn: 0, fail: 0, error: 0 }, items: [] }),
  checkProviderConnection: async (provider) => (query.has('connectionFailure')
    ? { provider, siteId: 'solov', ok: false, layer: 'group' as const, summary: '当前账号分组下没有可用渠道（HTTP 503）', nextStep: '到「账号」页确认套餐仍在有效期内，再点一次「写入 Key」', endpoint: 'https://fixture.invalid/v1/messages', model: 'claude-opus-5', detail: '当前分组下无可用渠道', status: 503, durationMs: 12, checkedAt: new Date().toISOString() }
    : { provider, siteId: 'solov', ok: true, layer: 'network' as const, summary: '连接正常，claude-opus-5 可以直接使用', nextStep: '无需处理', endpoint: 'https://fixture.invalid/v1/messages', model: 'claude-opus-5', detail: null, status: 200, durationMs: 12, checkedAt: new Date().toISOString() }),
  scanSystem: async () => {
    if (query.has('desktopEvent')) window.v2Test.emit('onCodexDesktopStatus', { status: { ...system.desktopApps.codex, appVersion: '9.9.9' } })
    return structuredClone(system)
  },
  getConfig: async () => {
    const result = structuredClone(config)
    if (query.has('readOnlyAccountMatch')) {
      const matched = session.authenticated && session.account?.userId === readOnlyConfigOwner.userId && (session.siteId ?? 'solov') === readOnlyConfigOwner.siteId
      for (const provider of Object.values(result.providers)) provider.configurationAccountMatched = matched && !query.has('matchedUnavailable')
    }
    if (holdConfigRead) { holdConfigRead = false; await new Promise<void>((resolve) => { releaseConfigRead = resolve }) }
    return result
  },
  scanExternalClients: async () => {
    const result = structuredClone(externalStatuses)
    if (query.has('externalAccountOwned') && (!session.authenticated || session.account?.userId !== account.userId || (session.siteId ?? 'solov') !== externalOwnerSite)) {
      const owned = result.find((entry) => entry.tool === query.get('externalAccountOwned'))
      if (owned?.configured) Object.assign(owned, { configured: false, configurationSource: 'other' })
    }
    if (holdExternalScan) { holdExternalScan = false; await new Promise<void>((resolve) => { releaseExternalScan = resolve }) }
    return result
  },
  installExternalClient: async (tool) => {
    window.v2Test.emit('onExternalClientInstallProgress', { tool, phase: 'downloading', message: '正在下载安装包', percent: 36 })
    if (query.has('externalInstallPending')) await new Promise<void>((resolve) => { releaseLaunch = resolve })
    if (query.has('externalInstallFailure')) throw new Error('客户端安装失败，请重试')
    const current = externalStatuses.find((entry) => entry.tool === tool)!
    Object.assign(current, { installed: true, version: '2.0.0' })
    window.v2Test.emit('onExternalClientInstallProgress', { tool, phase: 'completed', message: '安装完成', percent: 100 })
    return structuredClone(current)
  },
  launchExternalClient: async (tool) => {
    if (query.has('externalLaunchPending')) await new Promise<void>((resolve) => { releaseLaunch = resolve })
    externalStatuses.find((entry) => entry.tool === tool)!.running = true
  },
  chooseWorkspace: async () => {
    if (query.has('workspaceCancel')) return null
    const workspace = 'C:\\Selected Project'
    settings = { ...settings, workspace }
    config.workspace = workspace
    return workspace
  },
  takeExternalDeepLink: async () => {
    if (query.has('deepLinkFail')) throw new Error('回跳参数已过期')
    return null
  },
  getAccountNotice: async () => {
    if (noticeOverride) return noticeOverride
    if (query.has('noticeCollection')) return { id: 'newapi-collection-fixture', text: collectionFixture }
    if (query.has('noticeOversized')) throw new Error("Error invoking remote method 'account:get-notice': Error: 公告读取响应超过 512 KB 安全上限")
    if (query.has('noticeNative')) return { id: 'native-notice', text: nativeFixtureNotice }
    if (query.has('noticeMarkdown')) return { id: 'markdown-notice', text: '# 服务公告\n\n- 第一项\n- 第二项\n\n**重点提醒**：请查看 [官方说明](https://xm.solov.cc/help)。' }
    if (session.siteId === 'solov-api') return query.has('noticeEmpty') ? null : {
      id: 'sub2api-notices', text: '服务通知\n\n套餐更新', entries: [
        { id: '12', title: query.has('noticeLongTitle') ? '服务通知：模型与套餐更新说明 / Service announcement: updated models and subscriptions, pricing details and account usage policies' : '服务通知', text: '**系统升级完成**，请重新读取分组。', read: noticesRead.has('12') },
        { id: '8', title: '套餐更新', text: '<p>套餐详情已更新</p><script>window.nativeXss=true</script>', read: noticesRead.has('8') },
      ],
    }
    return { id: 'local-notice', text: '本地测试公告' }
  },
  markAccountNoticeRead: async (_snapshotId: string, entryId: string) => {
    if (query.has('noticeMarkPending')) await new Promise<void>((resolve) => pendingNoticeMarks.set(entryId, resolve))
    noticesRead.add(entryId)
  },
  syncLocalNoticeReads: async (scope: string, ids: string[]) => {
    if (window.fixtureNoticeStore) return window.fixtureNoticeStore(scope, ids)
    const next = [...new Set([...(localNoticesRead.get(scope) ?? []), ...ids])].slice(-200)
    localNoticesRead.set(scope, next)
    return next
  },
  getAccountStatus: async () => ({ systemName: 'Fixture', version: '1', setupComplete: true, quotaPerUnit: 500000, quotaDisplayType: 'USD', usdExchangeRate: 7.3, registerEnabled: true, passwordRegisterEnabled: true, emailVerificationEnabled: true, turnstileCheckEnabled: false }),
  getRememberedAccountLogin: async () => null,
  setRememberedAccountLogin: async () => {},
  loginAccount: async (input) => { const resolvedSite = input.siteId ?? (query.has('sub2api') ? 'solov-api' : 'solov'); session = { authenticated: true, account, ...(resolvedSite === 'solov-api' ? sub2ApiMetadata : { siteId: 'solov' as const }) }; return { ...session, account, accessExpiresAt: null } },
  registerAccount: async () => {},
  logoutAccount: async () => { session = { ...session, authenticated: false, account: null } },
  listProviderSessions: async () => ({ items: [], page: 1, pageSize: 3, total: 0, pages: 1, stats: { total: 0, byProvider: { claude: 0, codex: 0, gemini: 0, grok: 0 } }, capabilities: { claude: sessionCapability('claude'), codex: sessionCapability('codex'), gemini: sessionCapability('gemini'), grok: sessionCapability('grok') } }),
  launchCli: async () => query.has('launchPending') ? new Promise<void>((resolve) => { releaseLaunch = resolve }) : undefined,
  launchCodexDesktop: async () => ({ restarted: false, status: system.desktopApps.codex, ...(query.has('localeLaunchWarning') ? { chineseLocale: { status: 'failed' as const, message: 'Codex 已打开，但未确认中文界面生效，请在配置中再次启用。' } } : {}) }),
  inspectCodexDesktopLocale: async () => ({ installed: true, version: 'fixture', running: true, configPath: 'C:\\Fixture\\config.toml', configuredLocale: 'zh-CN', effectiveLocale: 'zh-CN', chineseResources: { available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot: 'C:\\Fixture' }, needsRestart: true, error: null }),
  setCodexDesktopLocale: async (locale) => {
    settings = { ...settings, codexDesktopChineseRuntimePatch: locale === 'zh-CN' ? 'enabled' : 'disabled' }
    const failed = query.has('localeRetry') && window.v2Test.calls.filter((call) => call.method === 'setCodexDesktopLocale').length === 1
    return { installed: true, version: 'fixture', running: true, configPath: 'C:\\Fixture\\config.toml', configuredLocale: locale, effectiveLocale: locale, chineseResources: { available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot: 'C:\\Fixture' }, needsRestart: failed, error: null, restarted: true, runtimeVerified: !failed,
      ...(failed ? { warning: '中文设置已保存，但本次未确认中文界面生效。请再次启用中文界面以重试。' } : {}) }
  },
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
    config.providers[input.provider] = { ...config.providers[input.provider], configurationOwnership: 'account', model: input.model, apiKeyPreview: input.keyId === 201 ? 'sk-se••••9012' : 'sk-ot••••1234' }
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
  listConfiguredModels: async (provider: ProviderId) => query.has('clientModels') ? ['gpt-fixture', 'deepseek-fixture', 'claude-fixture'] : query.has('cliDefaultModels') ? detectedModelsByProvider[provider] : [config.providers[provider].model || 'fixture-model'],
  configureExternalTool: async (tool, input) => {
    if (query.has('clientSaveFailure')) throw new Error('配置保存失败，原配置已保留')
    Object.assign(externalStatuses.find((entry) => entry.tool === tool)!, { configured: true, ...(tool === 'claudeDesktop' ? { configurationReady: true } : {}), model: input.model, configurationSource: 'xingmang', configurationError: null })
    return { tool, model: input.model, path: tool === 'claudeDesktop' ? 'C:\\Fixture\\Claude-3p\\configLibrary\\fixture.json' : `C:\\Fixture\\${tool}\\config.json`,
      files: [], backups: ['C:\\Fixture\\config.bak'], outcome: 'configured' as const,
      message: '配置已保存，请重新打开客户端。', restartRequired: true, connectionVerified: false as const }
  },
  listModels: async () => detectedModels,
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
      config.providers[provider] = { ...config.providers[provider], configurationOwnership: 'account', exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: config.providers[provider].baseUrl, model: input.preferredModels[provider] || 'fixture-model', ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}), ...(provider === 'codex' ? { codexAuthMode: 'apikey' as const } : {}) }
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
      configurationOwnership: input.apiKey ? 'manual' : current.configurationOwnership,
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
    if (query.has('savedAccount') && !query.has('readOnlyAccountMatch')) for (const provider of Object.values(config.providers)) { provider.exists = false; provider.hasApiKey = false; provider.matchesRelay = false; provider.actualBaseUrl = ''; provider.model = '' }
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
    if (nextConfigSaveHeld && configSaveMethods.has(name)) await new Promise<void>((resolve, reject) => {
      nextConfigSaveHeld = false
      releaseConfigSave = (error) => error ? reject(new Error(error)) : resolve()
    })
    return Reflect.apply(operation, target, args)
  }
} }) as unknown as XingmangApi
window.xingmang = api
createRoot(document.getElementById('root')!).render(<StrictMode><RendererV2App api={api} accelerationPreview={query.has('accelerationPreview')} /></StrictMode>)
