import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderId } from './catalog'
import {
  applyProviderModelReplace,
  codexModelCatalogPath,
  inspectProviderConfig,
  planProviderModelReplace,
  providerConfigPaths,
  saveProviderConfig,
  type ProviderModelPlan,
} from './config-files'
import { relayProviderBaseUrls } from './relay-sites'

const primary = relayProviderBaseUrls('solov', 'primary')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function roots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-model-replace-'))
  temporaryDirectories.push(root)
  return { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function rewrite(plan: ProviderModelPlan): Extract<ProviderModelPlan, { status: 'rewrite' }> {
  if (plan.status !== 'rewrite') throw new Error(`expected a rewrite, got ${plan.status}`)
  return plan
}

const swaps = {
  claude: { from: 'claude-opus-5', to: 'claude-opus-4-8' },
  codex: { from: 'gpt-5.5', to: 'gpt-6-astra' },
  grok: { from: 'grok-4.6', to: 'grok-4.7' },
} satisfies Partial<Record<ProviderId, { from: string; to: string }>>

describe('replacing a retired model in a tool config', () => {
  it.each(['claude', 'codex', 'grok'] as const)(
    'changes only the model of a %s config the app wrote and keeps the rest byte for byte', (provider) => {
      const r = roots()
      const { from, to } = swaps[provider]
      saveProviderConfig(provider, 'sk-model-fixture', from, 'reset', r, {}, primary, undefined, [from])
      const before = inspectProviderConfig(provider, r, primary)
      const plan = rewrite(planProviderModelReplace(provider, from, to, r))
      expect(plan.content).not.toBe(plan.original)
      expect(plan.content.split(to).join(from)).toBe(plan.original)
      applyProviderModelReplace(provider, plan, r)
      const after = inspectProviderConfig(provider, r, primary)
      expect(after.model).toBe(to)
      expect(after.apiKey).toBe(before.apiKey)
      expect(after.actualBaseUrl).toBe(before.actualBaseUrl)
    },
  )

  it('keeps a review model and comments the customer wrote into Codex', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const content = [
      '# 我自己的注释',
      'model_provider = "XingmangAI"',
      'model = "gpt-5.5"   # 星芒写的',
      'review_model = "gpt-5.6-sol"',
      'model_reasoning_effort = "medium"',
      '',
      '[model_providers.XingmangAI]',
      'name = "OpenAI"',
      `base_url = "${primary.codex}"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'supports_websockets = true',
      '',
    ].join('\n')
    write(config, content)
    const plan = rewrite(planProviderModelReplace('codex', 'gpt-5.5', 'gpt-6-astra', r))
    expect(plan.content).toBe(content.replace('model = "gpt-5.5"', 'model = "gpt-6-astra"'))
    expect(plan.catalog).toBeUndefined()
  })

  it('moves the Codex review model and WebSocket switch along only when they followed the old model', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const content = `model_provider = "XingmangAI"\nmodel = "gpt-5.5"\nreview_model = "gpt-5.5"\n\n[model_providers.XingmangAI]\nbase_url = "${primary.codex}"\nrequires_openai_auth = true\nsupports_websockets = true\n`
    write(config, content)
    expect(rewrite(planProviderModelReplace('codex', 'gpt-5.5', 'deepseek-v4-flash', r)).content).toBe(content
      .replace('model = "gpt-5.5"\nreview_model = "gpt-5.5"', 'model = "deepseek-v4-flash"\nreview_model = "deepseek-v4-flash"')
      .replace('supports_websockets = true', 'supports_websockets = false'))
    // 同是 GPT 型号就不动开关；没写开关的不替客户补。
    expect(rewrite(planProviderModelReplace('codex', 'gpt-5.5', 'gpt-6-astra', r)).content).toBe(content.split('"gpt-5.5"').join('"gpt-6-astra"'))
    const unset = content.replace('supports_websockets = true\n', '')
    write(config, unset)
    expect(rewrite(planProviderModelReplace('codex', 'gpt-5.5', 'deepseek-v4-flash', r)).content).toBe(unset.split('"gpt-5.5"').join('"deepseek-v4-flash"'))
  })

  it('keeps where Grok sends images and the comments in its config', () => {
    const r = roots()
    const [config] = providerConfigPaths('grok', r)
    const content = [
      '# 出图走我自己的地址',
      '[models]',
      'default = "grok"',
      '',
      '[model.grok]',
      'api_key = "sk-model-fixture"',
      'model = "grok-4.6"',
      `base_url = "${primary.grok}"`,
      '',
      '[endpoints]',
      'xai_api_base_url = "https://images.example.com/v1"',
      '',
    ].join('\n')
    write(config, content)
    expect(rewrite(planProviderModelReplace('grok', 'grok-4.6', 'grok-4.7', r)).content).toBe(content.replace('model = "grok-4.6"', 'model = "grok-4.7"'))
  })

  it('keeps the formatting and every other Claude Code setting, and the Default row only when it followed the old model', () => {
    const r = roots()
    const [settings] = providerConfigPaths('claude', r)
    const value = {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-model-fixture', ANTHROPIC_BASE_URL: primary.claude, ANTHROPIC_DEFAULT_MODEL: 'claude-opus-5' },
      permissions: { defaultMode: 'default', deny: [] },
      model: 'claude-opus-5',
    }
    const content = `${JSON.stringify(value, null, 4)}\n`
    write(settings, content)
    expect(rewrite(planProviderModelReplace('claude', 'claude-opus-5', 'claude-opus-4-8', r)).content).toBe(content.split('"claude-opus-5"').join('"claude-opus-4-8"'))

    const ownDefault = `${JSON.stringify({ ...value, env: { ...value.env, ANTHROPIC_DEFAULT_MODEL: 'claude-sonnet-5' } }, null, 4)}\n`
    write(settings, ownDefault)
    expect(rewrite(planProviderModelReplace('claude', 'claude-opus-5', 'claude-opus-4-8', r)).content).toBe(ownDefault.replace('"model": "claude-opus-5"', '"model": "claude-opus-4-8"'))
  })

  it('changes nothing when the model is no longer the one to replace, the file is missing or the model cannot be found', () => {
    const r = roots()
    expect(planProviderModelReplace('grok', 'grok-4.6', 'grok-4.7', r)).toEqual({ status: 'missing' })
    const [config] = providerConfigPaths('grok', r)
    write(config, '[models]\ndefault = "grok"\n\n[model.grok]\nmodel = "grok-4.8"\n')
    expect(planProviderModelReplace('grok', 'grok-4.6', 'grok-4.7', r)).toEqual({ status: 'changed' })
    write(config, '[model.grok]\nmodel = "grok-4.6"\n')
    expect(planProviderModelReplace('grok', 'grok-4.6', 'grok-4.7', r)).toEqual({ status: 'unlocated' })
  })

  it('rewrites the Codex model catalog alongside when the config already points at it', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const catalogPath = codexModelCatalogPath(r)
    const pointed = `model_provider = "XingmangAI"\nmodel = "gpt-5.5"\nmodel_catalog_json = "xingmang-models.json"\n\n[model_providers.XingmangAI]\nbase_url = "${primary.codex}"\n`
    write(config, pointed)
    write(catalogPath, '{"models":[]}\n')
    const plan = rewrite(planProviderModelReplace('codex', 'gpt-5.5', 'gpt-6-astra', r, '{"models":["new"]}\n'))
    expect(plan.catalog).toEqual({ path: catalogPath, content: '{"models":["new"]}\n' })
    applyProviderModelReplace('codex', plan, r)
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe('{"models":["new"]}\n')
    expect(fs.readFileSync(config, 'utf8')).toBe(pointed.replace('"gpt-5.5"', '"gpt-6-astra"'))

    // 名单没变不重写；配置没指着本软件的名单、或说该收回那一行，这次都不碰名单。
    expect(rewrite(planProviderModelReplace('codex', 'gpt-6-astra', 'gpt-7', r, '{"models":["new"]}\n')).catalog).toBeUndefined()
    expect(rewrite(planProviderModelReplace('codex', 'gpt-6-astra', 'gpt-7', r, null)).catalog).toBeUndefined()
    write(config, pointed.replace('model_catalog_json = "xingmang-models.json"\n', ''))
    expect(rewrite(planProviderModelReplace('codex', 'gpt-5.5', 'gpt-6-astra', r, '{"models":["other"]}\n')).catalog).toBeUndefined()
  })

  it('refuses when the config changed after planning and puts the catalog back', () => {
    const r = roots()
    const [config] = providerConfigPaths('codex', r)
    const catalogPath = codexModelCatalogPath(r)
    write(config, `model_provider = "XingmangAI"\nmodel = "gpt-5.5"\nmodel_catalog_json = "xingmang-models.json"\n\n[model_providers.XingmangAI]\nbase_url = "${primary.codex}"\n`)
    write(catalogPath, '{"models":[]}\n')
    const plan = rewrite(planProviderModelReplace('codex', 'gpt-5.5', 'gpt-6-astra', r, '{"models":["new"]}\n'))
    const edited = `${fs.readFileSync(config, 'utf8')}# 客户刚改的\n`
    fs.writeFileSync(config, edited)
    expect(() => applyProviderModelReplace('codex', plan, r)).toThrow('工具配置在换型号时被别的程序改了')
    expect(fs.readFileSync(config, 'utf8')).toBe(edited)
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe('{"models":[]}\n')
  })
})
