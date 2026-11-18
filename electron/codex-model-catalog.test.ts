import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCodexRelayModelCatalog,
  borrowCodexModelEntry,
  buildCodexRelayModelCatalog,
  bundledCodexModelCatalogSource,
  codexCliAcceptsModelCatalog,
  codexDesktopAcceptsModelCatalog,
  codexModelCatalogContent,
  codexModelCatalogEntryProblem,
  codexModelDisplayName,
  codexModelCatalogFileName,
  codexModelCatalogListsModel,
  codexModelCatalogRequiredCliVersion,
  codexRelayModelCatalogOutdated,
  combineCodexModelCatalogVerdicts,
  fitCodexModelCatalogToCli,
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
    expect(codexModelCatalogRequiredCliVersion(catalog)).toBe('0.166.0')
  })

  it('lists GPT-6.2 Sol and GPT-6.2 Astra, which the relay offers and Codex 0.169.0 does not ship', () => {
    // xm 站 11-18 上了这两个型号，Codex 自己是 rust-v0.169.1 才把它们放进名单；随包名单停在
    // rust-v0.169.0 时菜单里选不到，硬选上走通用资料。官方标的最低客户端版本是 0.166.0，
    // 不高过推荐的 0.169.0。
    const catalog = readBundledCodexModelCatalog(bundledPath)
    for (const slug of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      expect(catalog.models.find((model) => model.slug === slug)).toMatchObject({
        visibility: 'list',
        supported_in_api: true,
        minimal_client_version: '0.166.0',
      })
    }
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

  describe('models the bundled catalog does not know yet', () => {
    const catalog = {
      models: [
        entry('gpt-6.2-sol', { priority: 1, minimal_client_version: '0.166.0', availability_nux: { message: 'Try GPT-6.2 Sol' }, upgrade: { model: 'gpt-6.2-sol' } }),
        entry('gpt-6.1-terra', { priority: 3 }),
        entry('gpt-daybreak-blue-latest', { visibility: 'hide' }),
        entry('codex-auto-review', { visibility: 'hide' }),
      ],
    }

    it('borrows the newest sibling entry, renamed, and lists it right before that sibling', () => {
      const built = buildCodexRelayModelCatalog(catalog, ['gpt-6.2-sol', 'gpt-6.3-sol', 'gpt-6.2-terra'])
      expect(built?.models.map((model) => model.slug)).toEqual(['gpt-6.3-sol', 'gpt-6.2-sol', 'gpt-6.2-terra'])
      expect(built?.borrowed).toEqual([{ slug: 'gpt-6.3-sol', from: 'gpt-6.2-sol' }, { slug: 'gpt-6.2-terra', from: 'gpt-6.1-terra' }])
      const borrowed = built!.models[0]
      expect(borrowed).toEqual({
        ...catalog.models[0],
        slug: 'gpt-6.3-sol',
        display_name: 'GPT-6.3-Sol',
        availability_nux: null,
        upgrade: null,
      })
      expect(codexModelCatalogEntryProblem(borrowed)).toBeNull()
      // 官方那一项原样不动。
      expect(built!.models[1]).toBe(catalog.models[0])
    })

    it('writes a catalog even when the account only offers the new model, not the sibling it borrows from', () => {
      const built = buildCodexRelayModelCatalog(catalog, ['gpt-6.3-sol', 'claude-opus-5'])
      expect(built?.models.map((model) => model.slug)).toEqual(['gpt-6.3-sol'])
      expect(codexModelCatalogListsModel(built!, 'gpt-6.3-sol')).toBe(true)
      // 借来的那项照抄最低客户端版本，命令行够不上时照样只少写它。
      expect(fitCodexModelCatalogToCli(built!, { installed: true, version: '0.160.0' })).toBeNull()
    })

    it('borrows nothing for older models, dated snapshots, media models, unknown families or odd names', () => {
      for (const model of ['gpt-4.1', 'gpt-6.2-sol-2026-11-17', 'gpt-image-3', 'gpt-6.3-sol-fast', 'gpt-7-nova', 'gpt-6.3 sol', 'gpt-daybreak-blue-v2', 'claude-opus-6']) {
        expect(buildCodexRelayModelCatalog(catalog, ['gpt-6.2-sol', model])?.borrowed).toEqual([])
      }
      expect(buildCodexRelayModelCatalog(catalog, ['codex-auto-review', 'codex-auto-review-2'])).toBeNull()
    })

    it('borrows at most six at a time, so a long list of made-up names cannot swell the file', () => {
      const flood = Array.from({ length: 20 }, (_, index) => `gpt-${7 + index}-sol`)
      const built = buildCodexRelayModelCatalog(catalog, flood)
      expect(built?.borrowed).toHaveLength(6)
      expect(built?.models).toHaveLength(6)
    })

    it('spells display names the way the official catalog does', () => {
      expect(codexModelDisplayName('gpt-6.3-sol')).toBe('GPT-6.3-Sol')
      expect(codexModelDisplayName('gpt-7-astra')).toBe('GPT-7-Astra')
      expect(borrowCodexModelEntry(entry('gpt-6.2-sol'), 'gpt-6.3-sol')).toMatchObject({ slug: 'gpt-6.3-sol', display_name: 'GPT-6.3-Sol' })
    })

    it('borrows from the real bundled catalog: GPT-6.2 Sol for a GPT-6.3 Sol, GPT-6.1 Terra for a GPT-6.2 Terra', () => {
      const bundled = readBundledCodexModelCatalog(bundledPath)
      const built = buildCodexRelayModelCatalog(bundled, ['gpt-6.3-sol', 'gpt-6.2-terra', 'gpt-6.2-sol'])
      expect(built?.borrowed).toEqual([{ slug: 'gpt-6.3-sol', from: 'gpt-6.2-sol' }, { slug: 'gpt-6.2-terra', from: 'gpt-6.1-terra' }])
      expect(built?.models.map((model) => model.slug)).toEqual(['gpt-6.3-sol', 'gpt-6.2-sol', 'gpt-6.2-terra'])
      expect(parseCodexModelCatalog(codexModelCatalogContent(built!)).rejected).toEqual([])
    })
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

  it('leaves out only the models the installed Codex CLI is too old for', () => {
    const catalog = {
      models: [
        entry('gpt-6.2-sol', { minimal_client_version: '0.166.0' }),
        entry('gpt-6.1-sol', { minimal_client_version: '0.153.0' }),
        entry('codex-auto-review', { visibility: 'hide', minimal_client_version: '0.98.0' }),
        entry('gpt-no-version'),
      ],
    }
    const slugs = (cli: { installed: boolean; version: string | null } | null) => fitCodexModelCatalogToCli(catalog, cli)?.models.map((model) => model.slug)
    expect(slugs({ installed: true, version: 'codex-cli 0.160.0' })).toEqual(['gpt-6.1-sol', 'codex-auto-review', 'gpt-no-version'])
    expect(slugs({ installed: true, version: '0.166.0-alpha.3' })).toEqual(['gpt-6.1-sol', 'codex-auto-review', 'gpt-no-version'])
    expect(slugs({ installed: true, version: '0.166.0' })).toEqual(['gpt-6.2-sol', 'gpt-6.1-sol', 'codex-auto-review', 'gpt-no-version'])
    expect(slugs({ installed: true, version: '0.169.0' })).toEqual(['gpt-6.2-sol', 'gpt-6.1-sol', 'codex-auto-review', 'gpt-no-version'])
    // 筛完的名单整份够得上，后面那道版本关照常放行。
    expect(codexCliAcceptsModelCatalog({ installed: true, version: '0.160.0' }, fitCodexModelCatalogToCli(catalog, { installed: true, version: '0.160.0' })!)).toBe('accepted')
  })

  it('keeps the catalog as it is when there is no Codex CLI or its version cannot be read', () => {
    const catalog = { models: [entry('gpt-6.2-sol', { minimal_client_version: '0.166.0' })] }
    expect(fitCodexModelCatalogToCli(catalog, { installed: false, version: null })).toBe(catalog)
    expect(fitCodexModelCatalogToCli(catalog, { installed: true, version: null })).toBe(catalog)
    expect(fitCodexModelCatalogToCli(catalog, { installed: true, version: 'codex-cli' })).toBe(catalog)
    expect(fitCodexModelCatalogToCli(catalog, null)).toBe(catalog)
  })

  it('writes no catalog when the installed Codex CLI is too old for every model the menu would show', () => {
    const catalog = {
      models: [entry('gpt-6.2-sol', { minimal_client_version: '0.166.0' }), entry('codex-auto-review', { visibility: 'hide', minimal_client_version: '0.98.0' })],
    }
    expect(fitCodexModelCatalogToCli(catalog, { installed: true, version: '0.165.2' })).toBeNull()
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

  it.each([
    [{ installed: false, version: null }, 'accepted'],
    [{ installed: true, version: '26.930.2377.0' }, 'accepted'],
    [{ installed: true, version: '26.930.11008' }, 'accepted'],
    [{ installed: true, version: '26.917.8451.0' }, 'accepted'],
    [{ installed: true, version: '27.105.100.0' }, 'accepted'],
    [{ installed: true, version: '26.909.1234.0' }, 'too-old'],
    [{ installed: true, version: '26.727.51351' }, 'too-old'],
    [{ installed: true, version: '25.1201.3.0' }, 'too-old'],
    [{ installed: true, version: null }, 'unknown'],
    [{ installed: true, version: 'beta' }, 'unknown'],
    [{ installed: null, version: null }, 'unknown'],
  ] as const)('judges Codex desktop app %j as %s by its release', (desktop, verdict) => {
    expect(codexDesktopAcceptsModelCatalog(desktop)).toBe(verdict)
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
