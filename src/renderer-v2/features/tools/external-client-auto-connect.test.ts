import { describe, expect, it, vi } from 'vitest'
import type { AccountKey, AppConfigSummary, ExternalClientCheckResult, ExternalClientConfigRequest, ExternalClientConfigResult, ExternalClientStatus, ExternalToolId, ProviderId } from '../../../../electron/ipc-contract'
import {
  autoConnectExternalClient,
  describeExternalAutoConnect,
  externalAutoConnectEligible,
  externalAutoConnectSource,
  type ExternalAutoConnectBridge,
} from './external-client-auto-connect'

const native = (patch: { hasApiKey?: boolean; matchesRelay?: boolean; model?: string } = {}) => ({
  exists: true,
  hasApiKey: false,
  matchesRelay: false,
  baseUrl: 'https://xm.solov.cc',
  actualBaseUrl: '',
  model: '',
  apiKeyPreview: null,
  dataDirectory: '/home/me',
  dataDirectoryExists: true,
  files: [],
  updatedAt: null,
  ...patch,
})
const relay = (model: string) => native({ hasApiKey: true, matchesRelay: true, model })
const providers = (patch: Partial<Record<ProviderId, ReturnType<typeof native>>> = {}): AppConfigSummary['providers'] => ({
  claude: native(), codex: native(), gemini: native(), grok: native(), ...patch,
})
const claudeKey = { id: 22, group: 'Claude-MAX' }
const accountKey = (id: number, group: string): AccountKey => ({ id, name: `key-${id}`, group, maskedKey: 'sk-••••', status: 1, remainQuota: 1, usedQuota: 0, unlimitedQuota: true, createdAt: '', accessedAt: null, expiredAt: null })
const fresh = (tool: ExternalToolId, patch: Partial<ExternalClientStatus> = {}): ExternalClientStatus => ({
  tool, installed: true, version: '1.0.0', path: null, installDirectory: null, running: false, installSupported: true, launchSupported: true,
  detectionError: null, installHint: null, configured: false, model: null, configurationSource: 'missing', configurationError: null, pristine: true, ...patch,
})
const okConnection = (tool: ExternalToolId, model: string): ExternalClientCheckResult => ({ tool, siteId: 'solov', installed: true, ok: true, layer: 'network',
  summary: `当前账号的密钥和模型 ${model} 都可用`, nextStep: '无需处理', evidence: '已核对', endpoint: 'https://fixture.invalid/v1/models', model, detail: null, status: 200, durationMs: 9,
  checkedAt: '2026-11-11T00:00:00.000Z' })
const bridge = (options: { config?: AppConfigSummary['providers']; keys?: AccountKey[] | Error; configured?: string[]; accountModels?: string[]; save?: Error; verified?: boolean } = {}) => {
  const configureExternalTool = vi.fn(async (tool: ExternalToolId, request: ExternalClientConfigRequest): Promise<ExternalClientConfigResult> => {
    if (options.save) throw options.save
    const connection: ExternalClientCheckResult = options.verified === false ? { ...okConnection(tool, request.model), ok: false, layer: 'model' } : okConnection(tool, request.model)
    return { tool, model: request.model, path: 'fixture', files: [], backups: [], outcome: 'configured', message: '', restartRequired: true, connectionVerified: connection.ok, connection }
  })
  const api: ExternalAutoConnectBridge = {
    getConfig: vi.fn(async () => ({ workspace: '/home/me', providers: options.config ?? providers({ claude: relay('claude-opus-5-5'), codex: relay('gpt-6.1-sol') }) })),
    getAccountKeys: vi.fn(async () => {
      if (options.keys instanceof Error) throw options.keys
      const keys = options.keys ?? []
      return { keys, total: keys.length, page: 1, pageSize: 100 }
    }),
    listConfiguredModels: vi.fn(async () => options.configured ?? ['gpt-6.1-sol', 'claude-opus-5-5', 'claude-haiku-5-5']),
    listAccountKeyModels: vi.fn(async () => options.accountModels ?? ['claude-haiku-5-5', 'claude-opus-5-5']),
    configureExternalTool,
  }
  return { api, configureExternalTool }
}

describe('external client automatic connection', () => {
  it('only connects a client the main process just found installed, never configured and closed', () => {
    expect(externalAutoConnectEligible(fresh('workbuddy'))).toBe(true)
    expect(externalAutoConnectEligible(fresh('workbuddy', { pristine: undefined }))).toBe(false)
    expect(externalAutoConnectEligible(fresh('workbuddy', { installed: false }))).toBe(false)
    expect(externalAutoConnectEligible(fresh('workbuddy', { running: true }))).toBe(false)
    expect(externalAutoConnectEligible(fresh('workbuddy', { cachedAt: '2026-11-10T00:00:00.000Z' }))).toBe(false)
    expect(externalAutoConnectEligible(fresh('workbuddy', { detectionError: '客户端路径读取失败' }))).toBe(false)
    expect(externalAutoConnectEligible(fresh('workbuddy', { configurationError: '当前配置读取失败' }))).toBe(false)
    expect(externalAutoConnectEligible(fresh('workbuddy', { configurationSource: 'other' }))).toBe(false)
  })

  it('picks the same key and model the connect dialog would open with', () => {
    const both = providers({ claude: relay('claude-opus-5-5'), codex: relay('gpt-6.1-sol') })
    expect(externalAutoConnectSource('workbuddy', both, [])).toEqual({ credential: { kind: 'configured', provider: 'codex' }, model: 'gpt-6.1-sol' })
    expect(externalAutoConnectSource('opencode', both, [])).toEqual({ credential: { kind: 'configured', provider: 'codex' }, model: 'gpt-6.1-sol' })
    expect(externalAutoConnectSource('claudeDesktop', both, [])).toEqual({ credential: { kind: 'configured', provider: 'claude' }, model: 'claude-opus-5-5' })
    // Claude Code 没连当前账号：Claude Desktop 用账号里挂在 Claude 分组的那把，型号等列完再挑。
    expect(externalAutoConnectSource('claudeDesktop', providers({ codex: relay('gpt-6.1-sol') }), [claudeKey])).toEqual({ credential: { kind: 'account', keyId: 22 }, model: '' })
    // 只剩要客户自己填的密钥：不替他连。
    expect(externalAutoConnectSource('workbuddy', providers(), [])).toBeNull()
  })

  it('leaves OpenCode alone unless it can borrow the Codex key, since only then is its model type certain', () => {
    expect(externalAutoConnectSource('opencode', providers({ claude: relay('claude-opus-5-5') }), [])).toBeNull()
    expect(externalAutoConnectSource('opencode', providers(), [accountKey(31, 'Codex')])).toBeNull()
  })

  it('saves once with the dialog defaults and asks the main process to recheck before writing', async () => {
    const { api, configureExternalTool } = bridge()
    await expect(autoConnectExternalClient(api, fresh('opencode'), () => true)).resolves.toEqual({ kind: 'connected', model: 'gpt-6.1-sol', verified: true })
    expect(configureExternalTool).toHaveBeenCalledWith('opencode', { credential: { kind: 'configured', provider: 'codex' }, model: 'gpt-6.1-sol', automatic: true, protocol: 'responses' })
    const desktop = bridge({ config: providers({ codex: relay('gpt-6.1-sol') }), keys: [accountKey(22, 'Claude-MAX')] })
    // Claude Desktop 不按字母序拿 Haiku，照 Claude Code 那套挑 Opus。
    await expect(autoConnectExternalClient(desktop.api, fresh('claudeDesktop'), () => true)).resolves.toMatchObject({ kind: 'connected', model: 'claude-opus-5-5' })
    expect(desktop.configureExternalTool).toHaveBeenCalledWith('claudeDesktop', { credential: { kind: 'account', keyId: 22 }, model: 'claude-opus-5-5', automatic: true })
  })

  it('does not save when the key has no model it can pick with confidence', async () => {
    const { api, configureExternalTool } = bridge({ configured: ['deepseek-fixture'] })
    await expect(autoConnectExternalClient(api, fresh('workbuddy'), () => true)).resolves.toEqual({ kind: 'skipped', reason: 'no-model' })
    const desktop = bridge({ config: providers({ codex: relay('gpt-6.1-sol') }), configured: ['gpt-6.1-sol'] })
    await expect(autoConnectExternalClient(desktop.api, fresh('claudeDesktop'), () => true)).resolves.toEqual({ kind: 'skipped', reason: 'no-model' })
    expect(configureExternalTool).not.toHaveBeenCalled()
    expect(desktop.configureExternalTool).not.toHaveBeenCalled()
  })

  it('still uses the tool keys when the account key list cannot be read', async () => {
    const { api, configureExternalTool } = bridge({ keys: new Error('网络不通') })
    await expect(autoConnectExternalClient(api, fresh('workbuddy'), () => true)).resolves.toMatchObject({ kind: 'connected' })
    expect(configureExternalTool).toHaveBeenCalledOnce()
  })

  it('stops when the account changes and reports a refused save without throwing', async () => {
    const changed = bridge()
    await expect(autoConnectExternalClient(changed.api, fresh('workbuddy'), () => false)).resolves.toEqual({ kind: 'skipped', reason: 'account-changed' })
    expect(changed.configureExternalTool).not.toHaveBeenCalled()
    const refused = bridge({ save: new Error('WorkBuddy 已经有配置了或者正开着，这次没有自动连接') })
    await expect(autoConnectExternalClient(refused.api, fresh('workbuddy'), () => true)).resolves.toEqual({ kind: 'failed', message: 'WorkBuddy 已经有配置了或者正开着，这次没有自动连接' })
    const unverified = bridge({ verified: false })
    await expect(autoConnectExternalClient(unverified.api, fresh('workbuddy'), () => true)).resolves.toMatchObject({ kind: 'connected', verified: false })
  })

  it('logs who was connected and why not without keys, addresses or models', () => {
    expect(describeExternalAutoConnect('workbuddy', 'install', { kind: 'connected', model: 'gpt-6.1-sol', verified: true })).toEqual({ level: 'info', message: 'WorkBuddy 自动连接（装好后）：已写好' })
    expect(describeExternalAutoConnect('claudeDesktop', 'login', { kind: 'connected', model: 'claude-opus-5-5', verified: false })).toEqual({ level: 'warn', message: 'Claude Desktop 自动连接（登录后）：已写好，连接自检没通过' })
    expect(describeExternalAutoConnect('opencode', 'login', { kind: 'skipped', reason: 'no-key' })).toEqual({ level: 'info', message: 'OpenCode 自动连接（登录后）：没连，挑不出能自动用的密钥' })
    expect(describeExternalAutoConnect('opencode', 'install', { kind: 'failed', message: '当前密钥不支持所选模型，请重新检测。' })).toEqual({ level: 'warn', message: 'OpenCode 自动连接（装好后）：没连成，当前密钥不支持所选模型，请重新检测' })
  })
})
