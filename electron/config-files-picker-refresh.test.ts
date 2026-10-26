import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildClaudeRelayModelPicker } from './claude-model-picker'
import {
  applyProviderPickerRefresh,
  codexModelCatalogPath,
  planProviderPickerRefresh,
  providerConfigPaths,
  type ProviderPickerPlan,
} from './config-files'
import { relayProviderBaseUrls } from './relay-sites'

const primary = relayProviderBaseUrls('solov', 'primary')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function roots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-picker-refresh-'))
  temporaryDirectories.push(root)
  return { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function rewrite(plan: ProviderPickerPlan): Extract<ProviderPickerPlan, { status: 'rewrite' }> {
  if (plan.status !== 'rewrite') throw new Error(`expected a rewrite, got ${plan.status}`)
  return plan
}

// 客户自己定的审查型号、打开的检查更新、写的注释：刷新菜单一个都不能动。
const codexConfig = [
  '# 我自己的注释',
  'model_provider = "XingmangAI"',
  'model = "gpt-6.1-sol"',
  'review_model = "gpt-5.5"',
  'check_for_update_on_startup = true',
  'model_catalog_json = "xingmang-models.json"',
  '',
  '[model_providers.XingmangAI]',
  'name = "OpenAI"',
  `base_url = "${primary.codex}"`,
  'wire_api = "responses"',
  'requires_openai_auth = true',
  '',
].join('\n')

describe('refreshing the Codex model menu', () => {
  it('rewrites only the catalog file and leaves the config byte for byte', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const catalogPath = codexModelCatalogPath(r)
    write(config, codexConfig)
    write(catalogPath, '{"models":["old"]}\n')

    const plan = rewrite(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{"models":["new"]}\n'))
    expect(plan.content).toBe(plan.original)
    expect(plan.catalog).toEqual({ path: catalogPath, content: '{"models":["new"]}\n' })
    const result = applyProviderPickerRefresh('codex', plan, r)

    expect(result.files).toEqual([catalogPath])
    expect(fs.readFileSync(config, 'utf8')).toBe(codexConfig)
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe('{"models":["new"]}\n')
    // 配置没动就不该多一份配置的备份。
    expect(fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith('config.toml.'))).toEqual([])
  })

  it('adds the catalog line after the last top-level key when the config does not point at a catalog yet', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const unpointed = codexConfig.replace('model_catalog_json = "xingmang-models.json"\n', '')
    write(config, unpointed)

    const plan = rewrite(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{"models":["new"]}\n'))
    expect(plan.content).toBe(codexConfig)
    applyProviderPickerRefresh('codex', plan, r)
    expect(fs.readFileSync(config, 'utf8')).toBe(codexConfig)
    expect(fs.readFileSync(codexModelCatalogPath(r), 'utf8')).toBe('{"models":["new"]}\n')
  })

  it('keeps Windows line endings, and falls back to the top of the file when a multi-line string looks like a table', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    write(config, 'model = "gpt-6.1-sol"\r\n')
    expect(rewrite(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{}\n')).content)
      .toBe('model = "gpt-6.1-sol"\r\nmodel_catalog_json = "xingmang-models.json"\r\n')

    // 多行字符串里刚好有一行像表头：插在它前面会插进字符串里，读回来对不上，退到文件开头。
    const tricky = 'model = "gpt-6.1-sol"\ninstructions = """\n[not a table]\n"""\n'
    write(config, tricky)
    const content = rewrite(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{}\n')).content
    expect(content).toBe(`model_catalog_json = "xingmang-models.json"\n${tricky}`)
  })

  it('takes back only its own catalog line when the catalog should go, and leaves the file', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const catalogPath = codexModelCatalogPath(r)
    write(config, codexConfig)
    write(catalogPath, '{"models":["old"]}\n')

    const plan = rewrite(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, null))
    expect(plan.content).toBe(codexConfig.replace('model_catalog_json = "xingmang-models.json"\n', ''))
    expect(plan.catalog).toBeUndefined()
    applyProviderPickerRefresh('codex', plan, r)
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe('{"models":["old"]}\n')
  })

  it('changes nothing for a catalog the customer pointed elsewhere, a model that changed, or nothing new to write', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    expect(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{}\n')).toEqual({ status: 'missing' })
    write(config, codexConfig.replace('"xingmang-models.json"', '"my-models.json"'))
    expect(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{}\n')).toEqual({ status: 'current' })
    expect(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, null)).toEqual({ status: 'current' })

    write(config, codexConfig)
    expect(planProviderPickerRefresh('codex', 'gpt-6-astra', [], r, '{}\n')).toEqual({ status: 'changed' })
    expect(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, undefined)).toEqual({ status: 'current' })
    write(codexModelCatalogPath(r), '{}\n')
    expect(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{}\n')).toEqual({ status: 'current' })
    write(config, 'model = "gpt-6.1-sol"\n[broken\n')
    expect(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{}\n')).toEqual({ status: 'unlocated' })
  })

  it('refuses when the config changed after planning and puts the catalog back', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const catalogPath = codexModelCatalogPath(r)
    write(config, codexConfig)
    write(catalogPath, '{"models":["old"]}\n')
    const plan = rewrite(planProviderPickerRefresh('codex', 'gpt-6.1-sol', [], r, '{"models":["new"]}\n'))
    const edited = `${codexConfig}# 客户刚改的\n`
    fs.writeFileSync(config, edited)

    expect(() => applyProviderPickerRefresh('codex', plan, r)).toThrow('工具配置在刷新型号菜单时被别的程序改了')
    expect(fs.readFileSync(config, 'utf8')).toBe(edited)
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe('{"models":["old"]}\n')
  })
})

describe('refreshing the Claude Code /model menu', () => {
  const models = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5']
  const settings = {
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-picker-fixture', ANTHROPIC_BASE_URL: primary.claude, ANTHROPIC_DEFAULT_MODEL: 'claude-sonnet-5' },
    // 客户放开了星芒拦掉的工具。
    permissions: { defaultMode: 'default', deny: [] },
    model: 'claude-opus-5',
    modelPicker: buildClaudeRelayModelPicker(['claude-opus-5', 'claude-sonnet-5'], 'claude-opus-5'),
    fallbackModel: ['claude-sonnet-5'],
  }

  it('replaces only the menu, keeps a Default the customer pointed elsewhere, and keeps the layout', () => {
    const r = roots()
    const [file] = providerConfigPaths('claude', r)
    const content = `${JSON.stringify(settings, null, 4)}\n`
    write(file, content)

    const plan = rewrite(planProviderPickerRefresh('claude', 'claude-opus-5', models, r))
    applyProviderPickerRefresh('claude', plan, r)

    const after = fs.readFileSync(file, 'utf8')
    expect(JSON.parse(after)).toEqual({ ...settings, modelPicker: buildClaudeRelayModelPicker(models, 'claude-opus-5') })
    const untilPicker = content.indexOf('"modelPicker"')
    expect(after.slice(0, untilPicker)).toBe(content.slice(0, untilPicker))
    expect(after).toContain('\n        "options": [')
  })

  it('fills in Default only where it was never written, keeping a byte order mark', () => {
    const r = roots()
    const [file] = providerConfigPaths('claude', r)
    const { ANTHROPIC_DEFAULT_MODEL: _written, ...env } = settings.env
    const content = `\uFEFF${JSON.stringify({ ...settings, env, modelPicker: buildClaudeRelayModelPicker(models, 'claude-opus-5') }, null, 2)}\n`
    write(file, content)

    const plan = rewrite(planProviderPickerRefresh('claude', 'claude-opus-5', models, r))
    expect(plan.content.startsWith('\uFEFF')).toBe(true)
    expect(JSON.parse(plan.content.slice(1))).toEqual({ ...settings, env: { ...env, ANTHROPIC_DEFAULT_MODEL: 'claude-opus-5' }, modelPicker: buildClaudeRelayModelPicker(models, 'claude-opus-5') })
  })

  it('changes nothing for a menu the customer wrote, a model that changed, or a file it cannot read the same way Claude Code does', () => {
    const r = roots()
    const [file] = providerConfigPaths('claude', r)
    const own = { options: [{ model: 'claude-opus-5', label: '主力', description: '我自己的' }] }
    write(file, JSON.stringify({ ...settings, modelPicker: own }))
    expect(planProviderPickerRefresh('claude', 'claude-opus-5', models, r)).toEqual({ status: 'current' })

    write(file, JSON.stringify(settings))
    expect(planProviderPickerRefresh('claude', 'claude-sonnet-5', models, r)).toEqual({ status: 'changed' })
    // 同一个键写了两遍：Claude Code 认后一个，改了前一个读回来对不上。
    write(file, `{"model": "claude-opus-5", "modelPicker": {}, "env": {"ANTHROPIC_DEFAULT_MODEL": "claude-opus-5"}, "modelPicker": ${JSON.stringify(settings.modelPicker)}}`)
    expect(planProviderPickerRefresh('claude', 'claude-opus-5', models, r)).toEqual({ status: 'unlocated' })
    write(file, '{"model": "claude-opus-5", // 注释\n}')
    expect(planProviderPickerRefresh('claude', 'claude-opus-5', models, r)).toEqual({ status: 'unlocated' })
  })

  it('fills in fallback models where they were never written and leaves ones the customer wrote', () => {
    const r = roots()
    const [file] = providerConfigPaths('claude', r)
    const { fallbackModel: _written, ...before } = settings
    const content = `${JSON.stringify({ ...before, modelPicker: buildClaudeRelayModelPicker(models, 'claude-opus-5') }, null, 2)}\n`
    write(file, content)

    const plan = rewrite(planProviderPickerRefresh('claude', 'claude-opus-5', models, r))
    expect(JSON.parse(plan.content)).toEqual({ ...before, modelPicker: buildClaudeRelayModelPicker(models, 'claude-opus-5'), fallbackModel: ['claude-sonnet-5'] })
    // 原来的每一行原样，新的一项接在最后。
    expect(plan.content.startsWith(content.slice(0, content.lastIndexOf('\n}')))).toBe(true)

    write(file, JSON.stringify({ ...before, modelPicker: buildClaudeRelayModelPicker(models, 'claude-opus-5'), fallbackModel: ['claude-haiku-5'] }))
    expect(planProviderPickerRefresh('claude', 'claude-opus-5', models, r)).toEqual({ status: 'current' })
  })

  it('does not write a menu for Grok', () => {
    const r = roots()
    write(providerConfigPaths('grok', r)[0], '[models]\ndefault = "grok"\n')
    expect(planProviderPickerRefresh('grok', 'grok-4.7', ['grok-4.7'], r)).toEqual({ status: 'unlocated' })
  })
})
