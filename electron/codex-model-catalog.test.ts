import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCodexRelayModelCatalog,
  buildCodexRelayModelCatalog,
  bundledCodexModelCatalogSource,
  codexCliModelCatalogReader,
  codexClientSupportsModel,
  codexDesktopBundledCliVersions,
  codexDesktopModelCatalogReader,
  codexModelCatalogContent,
  codexModelCatalogEntryProblem,
  codexModelCatalogFileName,
  codexModelCatalogForClients,
  codexModelCatalogListsModel,
  codexModelCatalogRequiredCliVersion,
  codexModelsUnsupportedByClients,
  codexRelayModelCatalogOutdated,
  combineCodexModelCatalogVerdicts,
  isManagedCodexModelCatalogSetting,
  parseCodexModelCatalog,
  readBundledCodexModelCatalog,
  removeCodexRelayModelCatalog,
  resolveBundledCodexModelCatalogPath,
} from './codex-model-catalog'
import { cliVerifiedVersions } from './cli-verified-versions'
import { isNewerVersion } from './versions'

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

  it('loads every model without dropping any, including GPT-6.2 Sol and Astra in the menu', () => {
    const catalog = readBundledCodexModelCatalog(bundledPath)
    expect(catalog.rejected).toEqual([])
    for (const slug of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol']) {
      expect(catalog.models.find((model) => model.slug === slug)).toMatchObject({ visibility: 'list', supported_in_api: true })
    }
    expect(codexModelCatalogRequiredCliVersion(catalog)).toBe('0.166.0')
  })

  it('never needs a newer Codex CLI than the recommended one to list every model', () => {
    const catalog = readBundledCodexModelCatalog(bundledPath)
    const recommended = cliVerifiedVersions.codex.recommended?.version ?? null
    expect(recommended).not.toBeNull()
    expect(isNewerVersion(recommended, codexModelCatalogRequiredCliVersion(catalog))).toBe(false)
    expect(codexModelsUnsupportedByClients(catalog, [recommended])).toEqual([])
  })

  it('keeps GPT-6.1 Sol but holds GPT-6.2 back for a Codex CLI older than 0.166.0', () => {
    const catalog = readBundledCodexModelCatalog(bundledPath)
    expect(codexModelsUnsupportedByClients(catalog, ['0.164.0'])).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra'])
    expect(codexModelsUnsupportedByClients(catalog, ['0.166.0'])).toEqual([])
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
    [{ installed: false, version: null }, { verdict: 'accepted', clientVersion: null }],
    [{ installed: true, version: '0.156.1' }, { verdict: 'accepted', clientVersion: '0.156.1' }],
    [{ installed: true, version: 'codex-cli 0.160.0' }, { verdict: 'accepted', clientVersion: '0.160.0' }],
    [{ installed: true, version: 'codex-cli 0.154.2' }, { verdict: 'accepted', clientVersion: '0.154.2' }],
    [{ installed: true, version: '0.147.0' }, { verdict: 'accepted', clientVersion: '0.147.0' }],
    [{ installed: true, version: '0.146.1' }, { verdict: 'too-old', clientVersion: '0.146.1' }],
    [{ installed: true, version: null }, { verdict: 'unknown', clientVersion: null }],
    [{ installed: true, version: 'codex-cli' }, { verdict: 'unknown', clientVersion: null }],
  ] as const)('reads Codex CLI %j as %j', (cli, reader) => {
    expect(codexCliModelCatalogReader(cli)).toEqual(reader)
  })

  it.each([
    [{ installed: false, version: null }, { verdict: 'accepted', clientVersion: null }],
    [{ installed: true, version: '26.917.8451.0' }, { verdict: 'accepted', clientVersion: '0.155.0-alpha.16.3' }],
    [{ installed: true, version: '26.930.2377.0' }, { verdict: 'accepted', clientVersion: '0.159.0-alpha.12.1' }],
    [{ installed: true, version: '26.930.11008' }, { verdict: 'accepted', clientVersion: '0.159.0-alpha.12.1' }],
    [{ installed: true, version: '26.1013.4894.0' }, { verdict: 'accepted', clientVersion: '0.159.0-alpha.12.1' }],
    [{ installed: true, version: '26.1103.3517.0' }, { verdict: 'accepted', clientVersion: '0.167.0-alpha.3.2' }],
    [{ installed: true, version: '26.1106.51428' }, { verdict: 'accepted', clientVersion: '0.167.0-alpha.3.2' }],
    [{ installed: true, version: '26.1111.9265.0' }, { verdict: 'accepted', clientVersion: '0.169.0-alpha.11.1' }],
    [{ installed: true, version: '27.105.100.0' }, { verdict: 'accepted', clientVersion: '0.169.0-alpha.11.1' }],
    [{ installed: true, version: '26.909.1234.0' }, { verdict: 'too-old', clientVersion: null }],
    [{ installed: true, version: '26.727.51351' }, { verdict: 'too-old', clientVersion: null }],
    [{ installed: true, version: '25.1201.3.0' }, { verdict: 'too-old', clientVersion: null }],
    [{ installed: true, version: null }, { verdict: 'unknown', clientVersion: null }],
    [{ installed: true, version: 'beta' }, { verdict: 'unknown', clientVersion: null }],
    [{ installed: null, version: null }, { verdict: 'unknown', clientVersion: null }],
  ] as const)('reads Codex desktop app %j as %j by its release', (desktop, reader) => {
    expect(codexDesktopModelCatalogReader(desktop)).toEqual(reader)
  })

  it('lists desktop releases oldest first, each bundling a newer Codex than the one before', () => {
    const batches = codexDesktopBundledCliVersions.map((row) => row.build.split('.').map(Number))
    for (let index = 1; index < batches.length; index += 1) {
      const [previous, current] = [batches[index - 1], batches[index]]
      expect(current[0] > previous[0] || (current[0] === previous[0] && current[1] > previous[1])).toBe(true)
      expect(isNewerVersion(codexDesktopBundledCliVersions[index - 1].cli, codexDesktopBundledCliVersions[index].cli)).toBe(true)
    }
  })

  it.each([
    ['no minimal version', {}, '0.98.0', true],
    ['a minimal version the client meets', { minimal_client_version: '0.166.0' }, '0.170.0', true],
    ['exactly the minimal version', { minimal_client_version: '0.166.0' }, '0.166.0', true],
    ['a minimal version newer than the client', { minimal_client_version: '0.166.0' }, '0.164.0', false],
    // OpenAI compares the whole version: an alpha of 0.155.0 counts as 0.155.0.
    ['an alpha of the minimal version', { minimal_client_version: '0.155.0' }, '0.155.0-alpha.16.3', true],
    ['an alpha of an older release', { minimal_client_version: '0.166.0' }, '0.165.0-alpha.1.2', false],
    ['no client to satisfy', { minimal_client_version: '9.0.0' }, null, true],
  ] as const)('decides whether a client can use a model with %s', (_label, overrides, clientVersion, supported) => {
    expect(codexClientSupportsModel(entry('gpt-x', overrides), clientVersion)).toBe(supported)
  })

  it('holds back only the models some reader is too old for, and keeps the rest unchanged', () => {
    const catalog = { models: [
      entry('gpt-6.2-sol', { minimal_client_version: '0.166.0' }),
      entry('gpt-6.1-sol', { minimal_client_version: '0.153.0' }),
      entry('codex-auto-review', { visibility: 'hide', minimal_client_version: '0.98.0' }),
    ] }
    expect(codexModelCatalogForClients(catalog, ['0.170.0', '0.169.0-alpha.11.1'])?.models).toEqual(catalog.models)
    const older = codexModelCatalogForClients(catalog, ['0.170.0', '0.159.0-alpha.12.1'])
    expect(older?.models.map((model) => model.slug)).toEqual(['gpt-6.1-sol', 'codex-auto-review'])
    expect(older?.models[0]).toBe(catalog.models[1])
    expect(codexModelsUnsupportedByClients(catalog, [null, '0.164.0'])).toEqual(['gpt-6.2-sol'])
    expect(codexModelCatalogForClients(catalog, [])?.models).toEqual(catalog.models)
  })

  it('writes no catalog when every model the menu would show is too new for some reader', () => {
    const catalog = { models: [
      entry('gpt-6.2-sol', { minimal_client_version: '0.166.0' }),
      entry('codex-auto-review', { visibility: 'hide', minimal_client_version: '0.98.0' }),
    ] }
    expect(codexModelCatalogForClients(catalog, ['0.164.0'])).toBeNull()
  })

  it('refuses the catalog when any reader is too old, and holds still when any reader is unknown', () => {
    expect(combineCodexModelCatalogVerdicts(['accepted', 'accepted'])).toBe('accepted')
    expect(combineCodexModelCatalogVerdicts(['accepted', 'unknown'])).toBe('unknown')
    expect(combineCodexModelCatalogVerdicts(['unknown', 'too-old'])).toBe('too-old')
    expect(combineCodexModelCatalogVerdicts([])).toBe('accepted')
  })

  it('tells whether the configured default model keeps its official entry', () => {
    const catalog = buildCodexRelayModelCatalog(official, ['gpt-5.5', 'gpt-6.1-sol', 'claude-opus-5'])!
    expect(codexModelCatalogListsModel(catalog, ' gpt-6.1-sol ')).toBe(true)
    expect(codexModelCatalogListsModel(catalog, 'claude-opus-5')).toBe(false)
    expect(codexModelCatalogListsModel(catalog, 'gpt-6-astra')).toBe(false)
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
