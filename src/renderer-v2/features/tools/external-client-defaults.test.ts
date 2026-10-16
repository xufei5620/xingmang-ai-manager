import { describe, expect, it } from 'vitest'
import type { AppConfigSummary, ProviderId } from '../../../../electron/ipc-contract'
import { clientKeySources } from '../../registry/clients'
import { configuredKeySources, configuredSourceModel, detectedClientModel, initialClientSource, modelFitsClient } from './external-client-defaults'

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
const both = () => providers({ claude: relay('claude-opus-5-5'), codex: relay('gpt-6.1-sol') })
const gptKey = { id: 11, group: 'GPT' }
const claudeKey = { id: 22, group: 'Claude-MAX' }

describe('external client defaults', () => {
  it('only treats Claude models as fitting Claude Desktop', () => {
    expect(modelFitsClient('claudeDesktop', 'claude-opus-5-5')).toBe(true)
    expect(modelFitsClient('claudeDesktop', 'gpt-6.1-sol')).toBe(false)
    expect(modelFitsClient('workbuddy', 'gpt-6.1-sol')).toBe(true)
    expect(modelFitsClient('opencode', 'deepseek-fixture')).toBe(true)
  })

  it('lists the client\'s own tool key first and keeps the rest in registry order', () => {
    const all = providers({ claude: relay('claude-opus-5-5'), codex: relay('gpt-6.1-sol'), grok: relay('grok-4.6') })
    expect(configuredKeySources(clientKeySources, 'claude', all).map((item) => item.id)).toEqual(['claude', 'codex', 'grok'])
    expect(configuredKeySources(clientKeySources, 'codex', all).map((item) => item.id)).toEqual(['codex', 'claude', 'grok'])
    expect(configuredKeySources(clientKeySources, 'claude', providers({ codex: relay('gpt-6.1-sol') })).map((item) => item.id)).toEqual(['codex'])
    expect(configuredKeySources(clientKeySources, 'claude', null)).toEqual([])
  })

  it('never lists a tool whose key belongs to another account', () => {
    const foreign = providers({ claude: native({ hasApiKey: true, matchesRelay: false, model: 'claude-opus-5-5' }), codex: relay('gpt-6.1-sol') })
    expect(configuredKeySources(clientKeySources, 'claude', foreign).map((item) => item.id)).toEqual(['codex'])
  })

  it('defaults Claude Desktop to the Claude Code key and its Claude model', () => {
    const source = initialClientSource('claudeDesktop', 'claude', clientKeySources, both(), [gptKey, claudeKey])
    expect(source).toBe('configured:claude')
    expect(configuredSourceModel('claudeDesktop', source, both())).toBe('claude-opus-5-5')
  })

  it('prefers a Claude group account key over the Codex key when Claude Code has no current-account key', () => {
    const codexOnly = providers({ codex: relay('gpt-6.1-sol') })
    expect(initialClientSource('claudeDesktop', 'claude', clientKeySources, codexOnly, [gptKey, claudeKey])).toBe('account:22')
    expect(initialClientSource('claudeDesktop', 'claude', clientKeySources, null, [gptKey, claudeKey])).toBe('account:22')
  })

  it('falls back to another tool key without carrying a model Claude Desktop cannot use', () => {
    const codexOnly = providers({ codex: relay('gpt-6.1-sol') })
    const source = initialClientSource('claudeDesktop', 'claude', clientKeySources, codexOnly, [gptKey])
    expect(source).toBe('configured:codex')
    expect(configuredSourceModel('claudeDesktop', source, codexOnly)).toBe('')
    expect(initialClientSource('claudeDesktop', 'claude', clientKeySources, providers(), [gptKey])).toBe('account:11')
    expect(initialClientSource('claudeDesktop', 'claude', clientKeySources, providers(), [])).toBe('manual')
  })

  it('keeps the WorkBuddy and OpenCode defaults on the Codex key and model', () => {
    for (const tool of ['workbuddy', 'opencode'] as const) {
      const source = initialClientSource(tool, 'codex', clientKeySources, both(), [claudeKey])
      expect(source).toBe('configured:codex')
      expect(configuredSourceModel(tool, source, both())).toBe('gpt-6.1-sol')
      const claudeOnly = providers({ claude: relay('claude-opus-5-5') })
      expect(initialClientSource(tool, 'codex', clientKeySources, claudeOnly, [gptKey])).toBe('configured:claude')
      expect(initialClientSource(tool, 'codex', clientKeySources, providers(), [claudeKey, gptKey])).toBe('account:22')
    }
  })

  it('seeds a switched configured source with that tool model only when it fits', () => {
    expect(configuredSourceModel('claudeDesktop', 'configured:claude', both())).toBe('claude-opus-5-5')
    expect(configuredSourceModel('claudeDesktop', 'configured:codex', both())).toBe('')
    expect(configuredSourceModel('opencode', 'configured:claude', both())).toBe('claude-opus-5-5')
    expect(configuredSourceModel('claudeDesktop', 'account:22', both())).toBe('')
    expect(configuredSourceModel('claudeDesktop', 'manual', both())).toBe('')
    expect(configuredSourceModel('claudeDesktop', 'configured:claude', null)).toBe('')
  })

  it('keeps a detected model only when the key lists it and it fits the client', () => {
    const claudeList = ['claude-haiku-5-5', 'claude-opus-5-5']
    expect(detectedClientModel('claudeDesktop', 'claude-opus-5-5', claudeList)).toBe('claude-opus-5-5')
    expect(detectedClientModel('claudeDesktop', '', claudeList)).toBe('claude-haiku-5-5')
    expect(detectedClientModel('claudeDesktop', 'claude-sonnet-5-5', claudeList)).toBe('claude-haiku-5-5')
    // 0.2.19 测试包：Codex 的密钥列出 gpt-6.1-sol，也不替 Claude Desktop 拿主意，让他自己挑。
    expect(detectedClientModel('claudeDesktop', 'gpt-6.1-sol', ['gpt-6.1-sol', 'gpt-6-astra'])).toBeNull()
    expect(detectedClientModel('claudeDesktop', 'gpt-6.1-sol', ['gpt-6.1-sol', 'claude-opus-5-5'])).toBe('claude-opus-5-5')
    expect(detectedClientModel('workbuddy', 'gpt-6.1-sol', ['gpt-6.1-sol'])).toBe('gpt-6.1-sol')
    expect(detectedClientModel('workbuddy', '', ['gpt-6.1-sol'])).toBeNull()
    expect(detectedClientModel('opencode', 'gone', ['deepseek-fixture'])).toBeNull()
  })
})
