import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderId } from './catalog'
import { applyProviderRouteFollow, inspectProviderConfig, planProviderRouteFollow, providerConfigPaths, saveProviderConfig, type ProviderRoutePlan } from './config-files'
import { relayProviderBaseUrls, relaySiteProviderBaseUrlVariants } from './relay-sites'

const primary = relayProviderBaseUrls('solov', 'primary')
const direct = relayProviderBaseUrls('solov', 'direct')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function roots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-route-follow-'))
  temporaryDirectories.push(root)
  return { root, roots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') } }
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function rewritten(plan: ProviderRoutePlan): string {
  if (plan.status !== 'rewrite') throw new Error(`expected a rewrite, got ${plan.status}`)
  return plan.content
}

describe('provider route follow', () => {
  it.each(['claude', 'codex', 'gemini', 'grok'] satisfies ProviderId[])(
    'moves only the address of a %s config the app wrote and keeps the rest byte for byte', (provider) => {
      const { roots: r } = roots()
      saveProviderConfig(provider, 'sk-route-fixture', 'fixture-model', 'reset', r, {}, primary)
      const before = inspectProviderConfig(provider, r, primary)
      const plan = planProviderRouteFollow(provider, 'solov', direct[provider], r)
      if (plan.status !== 'rewrite') throw new Error(plan.status)
      expect(plan.from).toBe(primary[provider])
      expect(plan.content.split(direct[provider]).join(primary[provider])).toBe(plan.original)
      applyProviderRouteFollow(provider, plan, r)
      const after = inspectProviderConfig(provider, r, direct)
      expect(after.actualBaseUrl).toBe(direct[provider])
      expect(after.apiKey).toBe(before.apiKey)
      expect(after.model).toBe(before.model)
      expect(planProviderRouteFollow(provider, 'solov', direct[provider], r)).toEqual({ status: 'on-target' })
    },
  )

  it('finds the codex table by model_provider, whatever it is called', () => {
    const { roots: r } = roots()
    const [config] = providerConfigPaths('codex', r)
    for (const name of ['XingmangAI', 'my relay']) {
      const content = `# 自己的注释\nmodel_provider = "${name}"\nmodel = "m"\n\n[model_providers."${name}"]\nbase_url = "${primary.codex}"\nwire_api = "responses"\n\n[model_providers.other]\nbase_url = "${primary.codex}"\n`
      write(config, content)
      const next = rewritten(planProviderRouteFollow('codex', 'solov', direct.codex, r))
      expect(next).toBe(content.replace(`[model_providers."${name}"]\nbase_url = "${primary.codex}"`, `[model_providers."${name}"]\nbase_url = "${direct.codex}"`))
    }
  })

  it('does not touch a codex config whose provider is a reserved built-in name', () => {
    const { roots: r } = roots()
    const [config] = providerConfigPaths('codex', r)
    write(config, `model_provider = "openai"\n\n[model_providers.openai]\nbase_url = "${primary.codex}"\n`)
    expect(planProviderRouteFollow('codex', 'solov', direct.codex, r)).toEqual({ status: 'unlocated' })
  })

  it('leaves an address that is not one of the site lines alone', () => {
    const { roots: r } = roots()
    const [config] = providerConfigPaths('codex', r)
    write(config, 'model_provider = "XingmangAI"\n\n[model_providers.XingmangAI]\nbase_url = "https://relay.example.com/v1"\n')
    expect(planProviderRouteFollow('codex', 'solov', direct.codex, r)).toEqual({ status: 'not-on-site' })
  })

  it('reports a missing config instead of creating one', () => {
    const { roots: r } = roots()
    expect(planProviderRouteFollow('claude', 'solov', direct.claude, r)).toEqual({ status: 'missing' })
  })

  it('moves a config still on the retired test entry to the line own domain', () => {
    const { roots: r } = roots()
    // 退役的测试入口只从 relay-sites 的认法里取，不在测试里写出地址。
    const alias = relaySiteProviderBaseUrlVariants('solov', 'claude')
      .find((variant) => variant.endpointId === 'direct' && variant.baseUrl !== direct.claude)?.baseUrl
    if (!alias) throw new Error('fixture needs the retired alias')
    const [settings] = providerConfigPaths('claude', r)
    write(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: alias, ANTHROPIC_AUTH_TOKEN: 'sk-route-fixture' } }, null, 2))
    const next = rewritten(planProviderRouteFollow('claude', 'solov', direct.claude, r))
    expect(JSON.parse(next).env.ANTHROPIC_BASE_URL).toBe(direct.claude)
  })

  it('follows the grok default model table and its image address only when that one is on a site line', () => {
    const { roots: r } = roots()
    const [config] = providerConfigPaths('grok', r)
    const onSite = `[models]\ndefault = "mine"\n\n[model.mine]\nbase_url = "${primary.grok}"\n\n[endpoints]\nxai_api_base_url = "${primary.grok}"\n`
    write(config, onSite)
    expect(rewritten(planProviderRouteFollow('grok', 'solov', direct.grok, r))).toBe(onSite.split(primary.grok).join(direct.grok))

    const elsewhere = `[models]\ndefault = "mine"\n\n[model.mine]\nbase_url = "${primary.grok}"\n\n[endpoints]\nxai_api_base_url = "https://images.example.com/v1"\n`
    write(config, elsewhere)
    expect(rewritten(planProviderRouteFollow('grok', 'solov', direct.grok, r))).toBe(elsewhere.replace(primary.grok, direct.grok))

    // 模型那张表已经在新线路上，只剩出图地址还在旧线路：只补它。
    const half = `[models]\ndefault = "mine"\n\n[model.mine]\nbase_url = "${direct.grok}"\n\n[endpoints]\nxai_api_base_url = "${primary.grok}"\n`
    write(config, half)
    expect(rewritten(planProviderRouteFollow('grok', 'solov', direct.grok, r))).toBe(half.split(primary.grok).join(direct.grok))
  })

  it('keeps no backup of its own and refuses when the file changed after planning', () => {
    const { roots: r } = roots()
    saveProviderConfig('claude', 'sk-route-fixture', 'fixture-model', 'reset', r, {}, primary)
    const [settings] = providerConfigPaths('claude', r)
    const directory = path.dirname(settings)
    const backupsBefore = fs.readdirSync(directory).filter((name) => name.endsWith('.bak')).sort()
    const plan = planProviderRouteFollow('claude', 'solov', direct.claude, r)
    if (plan.status !== 'rewrite') throw new Error(plan.status)
    applyProviderRouteFollow('claude', plan, r)
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.bak')).sort()).toEqual(backupsBefore)

    const next = planProviderRouteFollow('claude', 'solov', primary.claude, r)
    if (next.status !== 'rewrite') throw new Error(next.status)
    const edited = `${fs.readFileSync(settings, 'utf8')}\n`
    fs.writeFileSync(settings, edited)
    expect(() => applyProviderRouteFollow('claude', next, r)).toThrow('工具配置在改线路时被别的程序改了')
    expect(fs.readFileSync(settings, 'utf8')).toBe(edited)
  })

  it('refuses to write anywhere but the provider config files', () => {
    const { root, roots: r } = roots()
    expect(() => applyProviderRouteFollow('claude', { status: 'rewrite', from: primary.claude, file: path.join(root, 'elsewhere.json'), original: '', content: '{}' }, r))
      .toThrow('工具配置路径不对')
  })
})
