import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCodexRelayModelCatalog,
  buildCodexRelayModelCatalog,
  bundledCodexModelCatalogSource,
  codexCliAcceptsModelCatalog,
  codexModelCatalogContent,
  codexModelCatalogEntryProblem,
  codexModelCatalogFileName,
  codexModelCatalogRequiredCliVersion,
  codexRelayModelCatalogOutdated,
  isManagedCodexModelCatalogSetting,
  parseCodexModelCatalog,
  readBundledCodexModelCatalog,
  removeCodexRelayModelCatalog,
  resolveBundledCodexModelCatalogPath,
} from './codex-model-catalog'

const repositoryRoot = path.resolve(__dirname, '..')
const bundledPath = resolveBundledCodexModelCatalogPath(repositoryRoot)
const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-catalog-'))
  temporaryDirectories.push(directory)
  return directory
}

// 一个 Codex 读得进去的最小型号；测试按需覆盖字段。
function entry(slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    model_messages: { instructions_template: 'You are Codex.' },
    supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    experimental_supported_tools: [],
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('bundled Codex model catalog', () => {
  it('is the upstream file byte for byte, as pinned by its source record', () => {
    const digest = createHash('sha256').update(fs.readFileSync(bundledPath)).digest('hex')
    expect(digest).toBe(bundledCodexModelCatalogSource.sha256)
    expect(bundledCodexModelCatalogSource).toMatchObject({ repository: 'openai/codex', path: 'codex-rs/models-manager/models.json' })
  })

  it('loads every model without dropping any, including GPT-6.1 Sol in the menu', () => {
    const catalog = readBundledCodexModelCatalog(bundledPath)
    expect(catalog.rejected).toEqual([])
    const sol = catalog.models.find((model) => model.slug === 'gpt-6.1-sol')
    expect(sol).toMatchObject({ visibility: 'list', supported_in_api: true })
    expect(codexModelCatalogRequiredCliVersion(catalog)).toBe('0.155.0')
  })

  it('ships the upstream license and notice next to the catalog', () => {
    const directory = path.dirname(bundledPath)
    expect(fs.readFileSync(path.join(directory, 'LICENSE'), 'utf8')).toContain('Apache License')
    expect(fs.readFileSync(path.join(directory, 'NOTICE'), 'utf8')).toContain('OpenAI')
  })

  it('refuses a bundled copy that differs from the pinned one', () => {
    const directory = temporaryDirectory()
    const changed = path.join(directory, 'models.json')
    fs.writeFileSync(changed, fs.readFileSync(bundledPath, 'utf8').replace('"gpt-6.1-sol"', '"gpt-6.1-sol-x"'), 'utf8')
    expect(() => readBundledCodexModelCatalog(changed)).toThrow('与发布时不一致')
    const oversized = path.join(directory, 'big.json')
    fs.writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20))
    expect(() => readBundledCodexModelCatalog(oversized)).toThrow('大小异常')
  })
})

describe('Codex model catalog parsing', () => {
  it('drops entries Codex would refuse and keeps the first of a repeated slug', () => {
    const parsed = parseCodexModelCatalog(JSON.stringify({
      models: [
        entry('gpt-ok'),
        entry('gpt-bad-shell', { shell_type: 'bash' }),
        entry('gpt-no-prompt', { model_messages: null }),
        entry('gpt-ok', { display_name: 'second' }),
        'not an object',
      ],
    }))
    expect(parsed.models.map((model) => model.display_name)).toEqual(['gpt-ok'])
    expect(parsed.rejected).toEqual([
      { slug: 'gpt-bad-shell', reason: 'shell_type 无效' },
      { slug: 'gpt-no-prompt', reason: '缺少提示词' },
      { slug: 'gpt-ok', reason: '重复的 slug' },
      { slug: null, reason: '不是对象' },
    ])
  })

  it.each([
    ['an unknown visibility', { visibility: 'secret' }, 'visibility 无效'],
    ['a priority outside i32', { priority: 2 ** 31 }, 'priority 无效'],
    ['a truncation mode Codex does not know', { truncation_policy: { mode: 'chars', limit: 1 } }, 'truncation_policy 无效'],
    ['an unknown input modality', { input_modalities: ['text', 'video'] }, 'input_modalities 无效'],
    ['a reasoning level without a description', { supported_reasoning_levels: [{ effort: 'high' }] }, 'supported_reasoning_levels 无效'],
    ['a slug with a control character', { slug: 'gpt\n6' }, 'slug 无效'],
    ['a malformed minimal client version', { minimal_client_version: 'latest' }, 'minimal_client_version 无效'],
  ])('rejects an entry with %s', (_label, overrides, reason) => {
    expect(codexModelCatalogEntryProblem(entry('gpt-x', overrides))).toBe(reason)
  })

  it('accepts the older base_instructions spelling and leaves optional fields unset', () => {
    expect(codexModelCatalogEntryProblem(entry('gpt-x', { model_messages: undefined, base_instructions: 'You are Codex.' }))).toBeNull()
    expect(codexModelCatalogEntryProblem(entry('gpt-x', { default_verbosity: null, apply_patch_tool_type: 'freeform' }))).toBeNull()
  })

  it('refuses a catalog Codex could not start with at all', () => {
    expect(() => parseCodexModelCatalog('{')).toThrow('不是有效 JSON')
    expect(() => parseCodexModelCatalog('{"items":[]}')).toThrow('缺少型号列表')
    expect(() => parseCodexModelCatalog(JSON.stringify({ models: [entry('gpt-x', { shell_type: 'bash' })] }))).toThrow('没有可用的型号')
  })
})

describe('Codex relay model catalog', () => {
  const official = { models: [entry('gpt-6-astra'), entry('gpt-6.1-sol'), entry('codex-auto-review', { visibility: 'hide' }), entry('gpt-5.5')] }

  it('keeps only the models the account can use, in the official order and unchanged', () => {
    const catalog = buildCodexRelayModelCatalog(official, ['gpt-5.5', ' gpt-6.1-sol ', 'claude-opus-5', 'codex-auto-review'])
    expect(catalog?.models.map((model) => model.slug)).toEqual(['gpt-6.1-sol', 'codex-auto-review', 'gpt-5.5'])
    expect(catalog?.models[0]).toBe(official.models[1])
  })

  it('writes no catalog when nothing the account offers would show in the menu', () => {
    expect(buildCodexRelayModelCatalog(official, ['claude-opus-5'])).toBeNull()
    expect(buildCodexRelayModelCatalog(official, [])).toBeNull()
    expect(buildCodexRelayModelCatalog(official, ['codex-auto-review'])).toBeNull()
  })

  it('needs the newest minimal client version among the written models, and never less than 0.147.0', () => {
    expect(codexModelCatalogRequiredCliVersion({ models: [entry('a', { minimal_client_version: '0.124.0' })] })).toBe('0.147.0')
    expect(codexModelCatalogRequiredCliVersion({
      models: [entry('a', { minimal_client_version: '0.153.0' }), entry('b', { minimal_client_version: '0.155.0' }), entry('c')],
    })).toBe('0.155.0')
  })

  it.each([
    [{ installed: false, version: null }, 'accepted'],
    [{ installed: true, version: '0.156.1' }, 'accepted'],
    [{ installed: true, version: 'codex-cli 0.160.0' }, 'accepted'],
    [{ installed: true, version: 'codex-cli 0.154.2' }, 'too-old'],
    [{ installed: true, version: '0.146.1' }, 'too-old'],
    [{ installed: true, version: null }, 'unknown'],
    [{ installed: true, version: 'codex-cli' }, 'unknown'],
  ] as const)('judges Codex CLI %j as %s for a catalog that needs 0.155.0', (cli, verdict) => {
    const catalog = { models: [entry('gpt-6-sol', { minimal_client_version: '0.155.0' })] }
    expect(codexCliAcceptsModelCatalog(cli, catalog)).toBe(verdict)
  })

  it('writes the same bytes for the same catalog, ending in a newline Codex can parse back', () => {
    const catalog = { models: [official.models[1]] }
    const content = codexModelCatalogContent(catalog)
    expect(content).toBe(codexModelCatalogContent({ models: [{ ...official.models[1] }] }))
    expect(content.endsWith('}\n')).toBe(true)
    expect(parseCodexModelCatalog(content).models).toEqual(catalog.models)
  })
})

describe('Codex model catalog setting', () => {
  it('points config.toml at its own file and takes back only that line', () => {
    const parsed: Record<string, unknown> = { model: 'gpt-6.1-sol' }
    expect(applyCodexRelayModelCatalog(parsed, true)).toBe(true)
    expect(parsed.model_catalog_json).toBe(codexModelCatalogFileName)
    expect(isManagedCodexModelCatalogSetting(parsed.model_catalog_json)).toBe(true)
    expect(applyCodexRelayModelCatalog(parsed, false)).toBe(false)
    expect(parsed).toEqual({ model: 'gpt-6.1-sol' })

    parsed.model_catalog_json = codexModelCatalogFileName
    removeCodexRelayModelCatalog(parsed)
    expect('model_catalog_json' in parsed).toBe(false)
  })

  it('never touches a catalog the user pointed Codex at', () => {
    const parsed: Record<string, unknown> = { model_catalog_json: '/Users/me/my-models.json' }
    expect(applyCodexRelayModelCatalog(parsed, true)).toBe(false)
    expect(applyCodexRelayModelCatalog(parsed, false)).toBe(false)
    removeCodexRelayModelCatalog(parsed)
    expect(parsed.model_catalog_json).toBe('/Users/me/my-models.json')
    expect(codexRelayModelCatalogOutdated(parsed, '{"models":[]}\n', null)).toBe(false)
    expect(codexRelayModelCatalogOutdated(parsed, null, null)).toBe(false)
  })

  it.each([
    ['nothing written yet', undefined, 'new', null, true],
    ['the same file already in place', codexModelCatalogFileName, 'new', 'new', false],
    ['the file went missing', codexModelCatalogFileName, 'new', null, true],
    ['the account now offers other models', codexModelCatalogFileName, 'new', 'old', true],
    ['our line left over after the account lost every model', codexModelCatalogFileName, null, 'old', true],
    ['no line and none wanted', undefined, null, null, false],
  ] as const)('calls the catalog outdated correctly when %s', (_label, setting, expected, file, outdated) => {
    const parsed: Record<string, unknown> = setting === undefined ? {} : { model_catalog_json: setting }
    expect(codexRelayModelCatalogOutdated(parsed, expected, file)).toBe(outdated)
  })
})
