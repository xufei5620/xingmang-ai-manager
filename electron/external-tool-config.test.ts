import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'jsonc-parser'
import {
  createExternalToolConfig,
  externalToolConfigPath,
  mergeExternalToolConfig,
  saveExternalToolConfig,
  inspectExternalToolConnection,
  type ExternalToolConfigOptions,
  type ExternalToolId,
} from './external-tool-config'

const roots = { userHome: 'C:/Users/test', appData: 'C:/Users/test/AppData/Roaming', configHome: 'C:/Users/test/.config' }
const temporaryHomes: string[] = []
const platform = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-external-'))
  temporaryHomes.push(home)
  return home
}

function existingConfig(tool: ExternalToolId, content: string, filename?: string) {
  const home = temporaryHome()
  const defaultPath = externalToolConfigPath(tool, platform, { userHome: home })
  const target = filename ? path.join(path.dirname(defaultPath), filename) : defaultPath
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return { home, target }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('external tool configuration', () => {
  it('reports a saved WorkBuddy model without returning its credentials and respects model visibility', async () => {
    const home = temporaryHome()
    await saveExternalToolConfig('workbuddy', platform, { userHome: home }, { model: 'claude-test', apiKey: 'sk-private-test' })
    const inspect = () => inspectExternalToolConnection('workbuddy', platform, { userHome: home }, 'https://xm.solov.cc/v1')
    expect(inspect()).toEqual({ configured: true, model: 'claude-test', configurationSource: 'xingmang', configurationError: null })
    expect(JSON.stringify(inspect())).not.toContain('sk-private-test')
    const file = externalToolConfigPath('workbuddy', platform, { userHome: home })
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(Array.isArray(config)).toBe(true)
    fs.writeFileSync(file, JSON.stringify({ models: config, availableModels: ['different'] }), 'utf8')
    expect(inspect()).toMatchObject({ configured: false, configurationSource: 'other' })
  })

  it('inspects the effective OpenCode JSONC default and distinguishes another account site', async () => {
    const { home, target } = existingConfig('opencode', '{\n// preserved\n"model":"other/model"\n}', 'opencode.jsonc')
    await saveExternalToolConfig('opencode', platform, { userHome: home }, { model: 'deepseek-test', apiKey: 'sk-private-test', protocol: 'responses' })
    const inspect = (base = 'https://xm.solov.cc/v1') => inspectExternalToolConnection('opencode', platform, { userHome: home }, base)
    expect(inspect()).toEqual({ configured: true, model: 'deepseek-test', configurationSource: 'xingmang', configurationError: null })
    expect(inspect('https://api.solov.cc/v1')).toMatchObject({ configured: false, configurationSource: 'other' })
    const config = parse(fs.readFileSync(target, 'utf8'))
    fs.writeFileSync(target, JSON.stringify({ ...config, model: 'other/model' }), 'utf8')
    expect(inspect()).toMatchObject({ configured: false, model: null, configurationSource: 'other' })
  })

  it.each([false, true])('updates selected OpenCode connection overrides across account changes (inherited: %s)', async (inherited) => {
    const original = { provider: { xingmang: {
      options: { baseURL: 'https://old.example/v1', apiKey: 'sk-old-provider', timeout: 4321 },
      models: {
        selected: { options: { baseURL: 'https://old-model.example/v1', apiKey: 'sk-old-model', temperature: 0.2 } },
        other: { options: { baseURL: 'https://other.example/v1', apiKey: 'sk-other-model' } },
      },
    } } }
    const { home, target } = existingConfig('opencode', inherited ? '{}' : JSON.stringify(original), 'opencode.jsonc')
    const lowerPath = path.join(path.dirname(target), 'opencode.json')
    if (inherited) fs.writeFileSync(lowerPath, JSON.stringify(original), 'utf8')
    await saveExternalToolConfig('opencode', platform, { userHome: home }, { model: 'selected', apiKey: 'sk-new-account', baseUrl: 'https://relay.example/v1' })
    expect(inspectExternalToolConnection('opencode', platform, { userHome: home }, 'https://relay.example/v1', (key) => key === 'sk-new-account'))
      .toMatchObject({ configured: true, model: 'selected', configurationSource: 'xingmang' })
    const saved = parse(fs.readFileSync(target, 'utf8'))
    expect(saved.provider.xingmang.models.selected.options).toMatchObject({ baseURL: 'https://relay.example/v1', apiKey: 'sk-new-account' })
    if (inherited) expect(fs.readFileSync(lowerPath, 'utf8')).toBe(JSON.stringify(original))
    else {
      expect(saved.provider.xingmang.models.selected.options.temperature).toBe(0.2)
      expect(saved.provider.xingmang.models.other).toEqual(original.provider.xingmang.models.other)
      expect(saved.provider.xingmang.options.timeout).toBe(4321)
    }
  })

  it('preserves an existing OpenCode model key when saving without a replacement', () => {
    const original = { provider: { xingmang: { models: { selected: { options: { baseURL: 'https://old.example/v1', apiKey: 'sk-existing-model' } } } } } }
    const saved = JSON.parse(mergeExternalToolConfig('opencode', JSON.stringify(original), { model: 'selected', baseUrl: 'https://relay.example/v1' }))
    expect(saved.provider.xingmang.models.selected.options).toEqual({ baseURL: 'https://relay.example/v1', apiKey: 'sk-existing-model' })
  })

  it.each(['disabled_providers', 'enabled_providers'])('does not report OpenCode ready when %s excludes it', async (field) => {
    const home = temporaryHome()
    const result = await saveExternalToolConfig('opencode', platform, { userHome: home }, { model: 'test', apiKey: 'sk-private-test' })
    const config = JSON.parse(fs.readFileSync(result.path, 'utf8'))
    fs.writeFileSync(result.path, JSON.stringify({ ...config, [field]: field === 'disabled_providers' ? ['xingmang'] : [] }), 'utf8')
    expect(inspectExternalToolConnection('opencode', platform, { userHome: home }, 'https://xm.solov.cc/v1')).toMatchObject({ configured: false })
  })

  it.each(['opencode', 'workbuddy'] as const)('distinguishes absent and malformed %s configs without mutating files', (tool) => {
    const home = temporaryHome()
    const inspect = () => inspectExternalToolConnection(tool, platform, { userHome: home }, 'https://xm.solov.cc/v1')
    expect(inspect()).toMatchObject({ configured: false, configurationSource: 'missing' })
    expect(fs.readdirSync(home)).toEqual([])
    const file = externalToolConfigPath(tool, platform, { userHome: home })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"secret":"sk-dont-echo", malformed}', 'utf8')
    expect(inspect()).toMatchObject({ configured: false, configurationSource: 'unknown', configurationError: expect.any(String) })
    expect(JSON.stringify(inspect())).not.toContain('sk-dont-echo')
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)])
  })

  it('resolves the actual global paths on Windows, macOS, and Linux', () => {
    expect(externalToolConfigPath('opencode', 'win32', roots)).toBe('C:\\Users\\test\\.config\\opencode\\opencode.json')
    expect(externalToolConfigPath('workbuddy', 'win32', roots)).toBe('C:\\Users\\test\\.workbuddy\\models.json')
    expect(externalToolConfigPath('workbuddy', 'darwin', { userHome: '/Users/test' })).toBe('/Users/test/.workbuddy/models.json')
    expect(externalToolConfigPath('opencode', 'darwin', { userHome: '/Users/test' })).toBe('/Users/test/.config/opencode/opencode.json')
    expect(externalToolConfigPath('opencode', 'linux', { userHome: '/home/test', configHome: '/tmp/xdg' })).toBe('/tmp/xdg/opencode/opencode.json')
    expect(externalToolConfigPath('workbuddy', 'linux', { userHome: '/home/test', configHome: '/tmp/xdg' })).toBe('/home/test/.workbuddy/models.json')
  })

  it('routes Claude Desktop away from CLI config files', async () => {
    const home = temporaryHome()
    await expect(saveExternalToolConfig('claudeDesktop', platform, { userHome: home })).rejects.toThrow('第三方推理网关')
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('generates Tencent WorkBuddy models with a full Chat Completions endpoint', () => {
    const result = createExternalToolConfig('workbuddy', 'linux', { userHome: '/home/test' }, { apiKey: 'sk-test', model: 'deepseek-v3.2' })
    expect(JSON.parse(result.content)).toEqual([{ id: 'deepseek-v3.2', name: 'deepseek-v3.2', vendor: 'Custom', apiKey: 'sk-test', url: 'https://xm.solov.cc/v1/chat/completions', supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false }])
    expect(result.supportsRelay).toBe(true)
  })

  it('updates one WorkBuddy model without dropping user model capabilities or access lists', () => {
    const existing = { custom: true, models: [
      { id: 'keep', vendor: 'Other' },
      { id: 'deepseek-v3.2', name: 'My model', apiKey: 'old', supportsToolCall: false, useCustomProtocol: true, maxInputTokens: 9000 },
    ], availableModels: ['keep'] }
    const result = JSON.parse(mergeExternalToolConfig('workbuddy', JSON.stringify(existing), { model: 'deepseek-v3.2', apiKey: 'new', baseUrl: 'https://relay.example/v1/chat/completions/' }))
    expect(result.models).toEqual([existing.models[0], { ...existing.models[1], vendor: 'Custom', apiKey: 'new', url: 'https://relay.example/v1/chat/completions', supportsImages: false, supportsReasoning: false }])
    expect(result.availableModels).toEqual(['keep', 'deepseek-v3.2'])
    expect(result.custom).toBe(true)
  })

  it.each([undefined, []])('retains unrestricted WorkBuddy availableModels=%s', (availableModels) => {
    const result = JSON.parse(mergeExternalToolConfig('workbuddy', JSON.stringify({ models: [], availableModels }), { model: 'qwen3-max' }))
    expect(result.availableModels).toEqual(availableModels)
    expect(result.models[0].id).toBe('qwen3-max')
    expect(result.models[0]).toMatchObject({ vendor: 'Custom', supportsToolCall: true, useCustomProtocol: false })
    expect(result.models[0]).toMatchObject({ supportsImages: false, supportsReasoning: false })
  })

  it('saves, backs up and detects the empty array written by WorkBuddy Desktop', async () => {
    const { home, target } = existingConfig('workbuddy', '[]\n')
    expect(target).toBe(path.join(home, '.workbuddy', 'models.json'))
    const inspect = () => inspectExternalToolConnection('workbuddy', platform, { userHome: home }, 'https://xm.solov.cc/v1')
    expect(inspect()).toMatchObject({ configured: false, model: null, configurationError: null })
    const result = await saveExternalToolConfig('workbuddy', platform, { userHome: home }, { model: 'desktop-model', apiKey: 'sk-desktop-test' })
    expect(result.path).toBe(target)
    expect(result.files).toEqual([target])
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(result.backups[0], 'utf8')).toBe('[]\n')
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual([{
      id: 'desktop-model', name: 'desktop-model', vendor: 'Custom', apiKey: 'sk-desktop-test',
      url: 'https://xm.solov.cc/v1/chat/completions', supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
    }])
    expect(inspect()).toEqual({ configured: true, model: 'desktop-model', configurationSource: 'xingmang', configurationError: null })
    expect(JSON.stringify(inspect())).not.toContain('sk-desktop-test')
    expect(fs.readdirSync(path.dirname(target)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('merges a Desktop model array by ID and preserves existing capability, protocol and unknown fields', () => {
    const existing = [
      { id: 'other', vendor: 'Other', apiKey: 'other-key', custom: { untouched: true } },
      { id: 'selected', name: 'My desktop model', vendor: 'Existing vendor', apiKey: 'old-key', url: 'https://old.example/v1/chat/completions',
        supportsToolCall: false, supportsImages: true, supportsReasoning: true, useCustomProtocol: true,
        reasoning: { mode: 'custom', budget: 1200 }, maxInputTokens: 9000, extension: { retain: 'value' } },
    ]
    const result = JSON.parse(mergeExternalToolConfig('workbuddy', JSON.stringify(existing), { model: 'selected', apiKey: 'new-key' }))
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([existing[0], { ...existing[1], apiKey: 'new-key', url: 'https://xm.solov.cc/v1/chat/completions' }])
    const appended = JSON.parse(mergeExternalToolConfig('workbuddy', JSON.stringify(result), { model: 'next', apiKey: 'next-key' }))
    expect(appended.slice(0, 2)).toEqual(result)
    expect(appended[2]).toMatchObject({ id: 'next', vendor: 'Custom', supportsToolCall: true, useCustomProtocol: false })
  })

  it('does not detect or migrate a model from the unrelated .codebuddy global path', async () => {
    const home = temporaryHome()
    const legacyPath = path.join(home, '.codebuddy', 'models.json')
    const original = JSON.stringify({ models: [{ id: 'legacy-only', apiKey: 'sk-legacy-test', url: 'https://xm.solov.cc/v1/chat/completions' }] })
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, original, 'utf8')
    const readFile = vi.spyOn(fs, 'readFileSync')
    expect(inspectExternalToolConnection('workbuddy', platform, { userHome: home }, 'https://xm.solov.cc/v1')).toEqual({ configured: false, model: null, configurationSource: 'missing', configurationError: null })
    const saved = await saveExternalToolConfig('workbuddy', platform, { userHome: home }, { model: 'desktop-only', apiKey: 'sk-desktop-test' })
    expect(saved.path).toBe(path.join(home, '.workbuddy', 'models.json'))
    expect(saved.backups).toEqual([])
    expect(readFile.mock.calls.some(([file]) => String(file) === legacyPath)).toBe(false)
    readFile.mockRestore()
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(original)
    expect(fs.readdirSync(path.dirname(legacyPath))).toEqual(['models.json'])
    expect(JSON.parse(fs.readFileSync(saved.path, 'utf8'))).toHaveLength(1)
    expect(fs.readFileSync(saved.path, 'utf8')).not.toMatch(/legacy-only|sk-legacy-test/)
  })

  it.each([
    ['chat-completions', '@ai-sdk/openai-compatible'],
    ['responses', '@ai-sdk/openai'],
  ] as const)('generates OpenCode SDK for %s and activates the selected model', (protocol, npm) => {
    const parsed = JSON.parse(createExternalToolConfig('opencode', 'linux', { userHome: '/home/test' }, { apiKey: 'sk-test', model: 'qwen3-max', protocol }).content)
    expect(parsed.provider.xingmang.npm).toBe(npm)
    expect(parsed.provider.xingmang.options).toEqual({ baseURL: 'https://xm.solov.cc/v1', apiKey: 'sk-test' })
    expect(parsed.provider.xingmang.models['qwen3-max']).toEqual({ name: 'qwen3-max' })
    expect(parsed.model).toBe('xingmang/qwen3-max')
  })

  it('preserves OpenCode comments and unrelated fields, including selected model tuning', () => {
    const original = '{\n  // keep this user comment\n  "permission": { "bash": "ask" },\n  "provider": {\n    "other": { "name": "Other" },\n    "xingmang": { "options": { "timeout": 1234, "apiKey": "existing" }, "models": { "old": { "name": "old" }, "grok-4": { "name": "Custom label", "limit": { "context": 9000, "output": 2000 } } } }\n  },\n}\n'
    const content = mergeExternalToolConfig('opencode', original, { model: 'grok-4' })
    const merged = parse(content)
    expect(content).toContain('// keep this user comment')
    expect(content).toContain('"permission": { "bash": "ask" }')
    expect(merged.provider.other.name).toBe('Other')
    expect(merged.provider.xingmang.options).toMatchObject({ timeout: 1234, apiKey: 'existing' })
    expect(merged.provider.xingmang.models.old).toEqual({ name: 'old' })
    expect(merged.provider.xingmang.models['grok-4']).toMatchObject({ name: 'Custom label', limit: { context: 9000, output: 2000 } })
    expect(merged.model).toBe('xingmang/grok-4')
  })

  it('switches only the selected model protocol while preserving the old provider SDK', () => {
    const original = { provider: { xingmang: { npm: '@ai-sdk/openai', models: { old: { name: 'Old Responses model' }, next: { provider: { npm: '@ai-sdk/openai', api: 'https://custom.example/v1' }, options: { temperature: 0.1 } } } } } }
    const merged = JSON.parse(mergeExternalToolConfig('opencode', JSON.stringify(original), { model: 'next', protocol: 'chat-completions' }))
    expect(merged.provider.xingmang.npm).toBe('@ai-sdk/openai')
    expect(merged.provider.xingmang.models.old).toEqual(original.provider.xingmang.models.old)
    expect(merged.provider.xingmang.models.next.provider).toEqual({ npm: '@ai-sdk/openai-compatible', api: 'https://custom.example/v1' })
    expect(merged.provider.xingmang.models.next.options).toEqual({ temperature: 0.1 })
  })

  it('makes the selected OpenCode provider and model available without removing other list entries', () => {
    const original = { enabled_providers: ['other'], disabled_providers: ['xingmang', 'blocked'], provider: { xingmang: { whitelist: ['old'], blacklist: ['new', 'blocked'] } } }
    const merged = JSON.parse(mergeExternalToolConfig('opencode', JSON.stringify(original), { model: 'new' }))
    expect(merged.enabled_providers).toEqual(['other', 'xingmang'])
    expect(merged.disabled_providers).toEqual(['blocked'])
    expect(merged.provider.xingmang.whitelist).toEqual(['old', 'new'])
    expect(merged.provider.xingmang.blacklist).toEqual(['blocked'])
  })

  it('keeps SDK inference unchanged for existing models that have no provider npm', () => {
    const merged = JSON.parse(mergeExternalToolConfig('opencode', '{"provider":{"xingmang":{"models":{"old":{"name":"Old"}}}}}', { model: 'next', protocol: 'responses' }))
    expect(merged.provider.xingmang).not.toHaveProperty('npm')
    expect(merged.provider.xingmang.models.old).toEqual({ name: 'Old' })
    expect(merged.provider.xingmang.models.next.provider.npm).toBe('@ai-sdk/openai')
  })

  it.each(['workbuddy', 'opencode'] as const)('writes %s with a readable backup of the original file', async (tool) => {
    const original = '{"custom":true}\n'
    const { home, target } = existingConfig(tool, original)
    const result = await saveExternalToolConfig(tool, platform, { userHome: home }, { model: 'qwen3-max', apiKey: 'sk-test' })
    expect(result.files).toEqual([target])
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(result.backups[0], 'utf8')).toBe(original)
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).custom).toBe(true)
    expect(fs.readdirSync(path.dirname(target)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('uses OpenCode JSONC precedence and retains inherited SDK, options, and provider lists', async () => {
    const original = '{\n  // authoritative global overrides\n  "provider": { "xingmang": { "options": { "timeout": 5000 } } },\n}\n'
    const { home, target } = existingConfig('opencode', original, 'opencode.jsonc')
    const lowerPath = path.join(path.dirname(target), 'opencode.json')
    const lower = JSON.stringify({ enabled_providers: ['other'], provider: { xingmang: { npm: '@ai-sdk/openai', models: { old: { name: 'Old' } } } } })
    fs.writeFileSync(lowerPath, lower, 'utf8')
    const saved = await saveExternalToolConfig('opencode', platform, { userHome: home }, { model: 'next', apiKey: 'sk-test', protocol: 'chat-completions' })
    expect(saved.path).toBe(target)
    expect(fs.readFileSync(lowerPath, 'utf8')).toBe(lower)
    const content = fs.readFileSync(target, 'utf8')
    const parsed = parse(content)
    expect(content).toContain('// authoritative global overrides')
    expect(parsed.provider.xingmang.options).toMatchObject({ timeout: 5000, apiKey: 'sk-test' })
    expect(parsed.provider.xingmang.models.next.provider.npm).toBe('@ai-sdk/openai-compatible')
    expect(parsed.enabled_providers).toEqual(['other', 'xingmang'])
    expect(parsed.model).toBe('xingmang/next')
    expect(fs.readFileSync(saved.backups[0], 'utf8')).toBe(original)
  })

  it('updates a legacy OpenCode config.json when it is the only existing global file', async () => {
    const { home, target } = existingConfig('opencode', '{"permission":{"bash":"ask"}}', 'config.json')
    const saved = await saveExternalToolConfig('opencode', platform, { userHome: home }, { model: 'next' })
    expect(saved.path).toBe(target)
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).permission.bash).toBe('ask')
    expect(fs.existsSync(path.join(path.dirname(target), 'opencode.json'))).toBe(false)
  })

  const invalidConfigurations: Array<[ExternalToolId, string]> = [
    ...['{broken', '', 'null', '[]', '"text"', '{"model":"a","model":"b"}'].map((value): [ExternalToolId, string] => ['opencode', value]),
    ...['{"provider":[]}', '{"provider":{"xingmang":null}}', '{"provider":{"xingmang":{"options":"bad"}}}', '{"provider":{"xingmang":{"models":[]}}}', '{"provider":{"xingmang":{"models":{"old":false}}}}', '{"enabled_providers":false}'].map((value): [ExternalToolId, string] => ['opencode', value]),
    ...['{"models":{}}', '{"models":[null]}', '{"models":[{"name":"no id"}]}', '{"models":[{"id":"dup"},{"id":"dup"}]}', '{"availableModels":"bad"}', '{/* comments are not JSON */"models":[]}', '[null]', '[{"name":"no id"}]', '[{"id":"dup"},{"id":"dup"}]'].map((value): [ExternalToolId, string] => ['workbuddy', value]),
  ]
  it.each(invalidConfigurations)('rejects malformed %s configuration without changing files: %s', async (tool, existing) => {
    const { home, target } = existingConfig(tool, existing)
    await expect(saveExternalToolConfig(tool, platform, { userHome: home })).rejects.toThrow('未执行修改')
    expect(fs.readFileSync(target, 'utf8')).toBe(existing)
    expect(fs.readdirSync(path.dirname(target))).toEqual([path.basename(target)])
  })

  it.each([
    { baseUrl: 'file:///tmp/config' }, { baseUrl: 'https://user:secret@example.com/v1' },
    { baseUrl: 'https://example.com/v1?api_key=secret' }, { model: 'bad\nmodel' },
    { apiKey: 'bad\nkey' }, { model: '' }, { protocol: 'unknown' },
  ])('rejects invalid options before creating directories: %j', async (options) => {
    const home = temporaryHome()
    await expect(saveExternalToolConfig('opencode', platform, { userHome: home }, options as ExternalToolConfigOptions)).rejects.toThrow('未执行修改')
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('rejects Responses protocol for WorkBuddy before creating directories', async () => {
    const home = temporaryHome()
    await expect(saveExternalToolConfig('workbuddy', platform, { userHome: home }, { protocol: 'responses' })).rejects.toThrow('仅支持 Chat Completions')
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('does not overwrite malformed lower-priority OpenCode configuration', async () => {
    const { home, target } = existingConfig('opencode', '{}', 'opencode.jsonc')
    fs.writeFileSync(path.join(path.dirname(target), 'opencode.json'), '{broken', 'utf8')
    await expect(saveExternalToolConfig('opencode', platform, { userHome: home })).rejects.toThrow('未执行修改')
    expect(fs.readFileSync(target, 'utf8')).toBe('{}')
    expect(fs.readdirSync(path.dirname(target))).toHaveLength(2)
  })

  it('refuses a hard-linked target without modifying either link', async () => {
    const { home, target } = existingConfig('workbuddy', '{}')
    const second = path.join(home, 'linked.json')
    fs.linkSync(target, second)
    await expect(saveExternalToolConfig('workbuddy', platform, { userHome: home })).rejects.toThrow('单链接普通文件')
    expect(fs.readFileSync(second, 'utf8')).toBe('{}')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['models.json'])
  })

  it('refuses a directory junction before writing outside the intended config root', async () => {
    const home = temporaryHome()
    const outside = temporaryHome()
    fs.symlinkSync(outside, path.join(home, '.workbuddy'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(saveExternalToolConfig('workbuddy', platform, { userHome: home })).rejects.toThrow(/符号链接|目录联接/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('retains the original target and removes temporary files if atomic replacement fails', async () => {
    const { home, target } = existingConfig('opencode', '{"custom":true}')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated rename failure') })
    await expect(saveExternalToolConfig('opencode', platform, { userHome: home })).rejects.toThrow('simulated rename failure')
    expect(fs.readFileSync(target, 'utf8')).toBe('{"custom":true}')
    const files = fs.readdirSync(path.dirname(target))
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(files.filter((name) => name.includes('.bak'))).toHaveLength(1)
  })

  it('does not clobber concurrent changes between reading and committing the configuration', async () => {
    const { home, target } = existingConfig('workbuddy', '{}')
    await expect(saveExternalToolConfig('workbuddy', platform, { userHome: home }, {}, {
      beforeReplace() { fs.writeFileSync(target, '{"concurrent":true}', 'utf8') },
    })).rejects.toThrow('在保存前已变化')
    expect(fs.readFileSync(target, 'utf8')).toBe('{"concurrent":true}')
    expect(fs.readdirSync(path.dirname(target)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})
