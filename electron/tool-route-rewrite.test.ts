import * as TOML from '@iarna/toml'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { readEnvLineValue, readJsonString, readTomlBoolean, readTomlString, rewriteEnvValue, rewriteJsonStrings, rewriteTomlStrings, rewriteTomlValues } from './tool-route-rewrite'

const fromUrl = 'https://xm.solov.cc/v1'
const toUrl = 'https://xm-direct.solov.cc/v1'

describe('tool-route-rewrite', () => {
  it('changes only the addressed TOML string and keeps comments, order and blank lines', () => {
    const content = [
      '# 我自己加的注释 https://xm.solov.cc/v1',
      'model_provider = "XingmangAI"',
      'model = "gpt-5.5"',
      '',
      '[model_providers.XingmangAI]',
      'name = "XingmangAI"',
      `base_url = "${fromUrl}"   # 星芒`,
      'wire_api = "responses"',
      '',
    ].join('\n')
    const next = rewriteTomlStrings(content, [{ path: ['model_providers', 'XingmangAI', 'base_url'], value: toUrl }])
    expect(next).toBe(content.replace(`base_url = "${fromUrl}"`, `base_url = "${toUrl}"`))
  })

  it('flips only the addressed TOML switch and refuses to change a value into another type', () => {
    const content = [
      '# supports_websockets = true',
      'model = "gpt-5.5"',
      '',
      '[model_providers.XingmangAI]',
      'requires_openai_auth = true',
      'supports_websockets = true',
      '',
      '[features]',
      'goals = true',
      '',
    ].join('\n')
    const path = ['model_providers', 'XingmangAI', 'supports_websockets']
    expect(readTomlBoolean(content, path)).toBe(true)
    const next = rewriteTomlValues(content, [{ path: ['model'], value: 'deepseek-v4-flash' }, { path, value: false }])
    expect(next).toBe(content.replace('model = "gpt-5.5"', 'model = "deepseek-v4-flash"').replace('supports_websockets = true\n\n', 'supports_websockets = false\n\n'))
    expect(rewriteTomlValues(content, [{ path, value: 'false' }])).toBeNull()
    expect(rewriteTomlValues(content, [{ path: ['model'], value: true }])).toBeNull()
    expect(readTomlBoolean(content, ['model'])).toBeNull()
  })

  it('finds a value under a quoted or dotted table name', () => {
    const content = `model_provider = "my relay"\nmodel_providers."my relay".base_url = '${fromUrl}'\n`
    const next = rewriteTomlStrings(content, [{ path: ['model_providers', 'my relay', 'base_url'], value: toUrl }])
    expect(next).toBe(`model_provider = "my relay"\nmodel_providers."my relay".base_url = '${toUrl}'\n`)
  })

  it('tells two keys holding the same address apart', () => {
    const content = [
      '[models]', 'default = "mine"', '',
      '[model.mine]', `base_url = "${fromUrl}"`, '',
      '[endpoints]', `xai_api_base_url = "${fromUrl}"`, '',
    ].join('\n')
    const only = rewriteTomlStrings(content, [{ path: ['model', 'mine', 'base_url'], value: toUrl }])
    expect(readTomlString(only ?? '', ['model', 'mine', 'base_url'])).toBe(toUrl)
    expect(readTomlString(only ?? '', ['endpoints', 'xai_api_base_url'])).toBe(fromUrl)
    const both = rewriteTomlStrings(content, [
      { path: ['model', 'mine', 'base_url'], value: toUrl },
      { path: ['endpoints', 'xai_api_base_url'], value: toUrl },
    ])
    expect(both).toBe(content.split(fromUrl).join(toUrl))
  })

  it('refuses when the value cannot be located or the file does not parse', () => {
    expect(rewriteTomlStrings('a = 1\n', [{ path: ['model_providers', 'x', 'base_url'], value: toUrl }])).toBeNull()
    expect(rewriteTomlStrings('base_url = """\nhttps://xm.solov.cc/v1"""\n', [{ path: ['base_url'], value: toUrl }])).toBeNull()
    expect(rewriteTomlStrings('[broken\n', [{ path: ['a'], value: toUrl }])).toBeNull()
    expect(rewriteTomlStrings('a = 1\n', [{ path: ['a'], value: toUrl }])).toBeNull()
  })

  it('keeps a byte order mark and leaves an already-current value untouched', () => {
    const content = `﻿[t]\nbase_url = "${fromUrl}"\r\n`
    expect(rewriteTomlStrings(content, [{ path: ['t', 'base_url'], value: toUrl }])).toBe(`﻿[t]\nbase_url = "${toUrl}"\r\n`)
    expect(rewriteTomlStrings(content, [{ path: ['t', 'base_url'], value: fromUrl }])).toBe(content)
  })

  it('rewrites a JSON value without reformatting the file', () => {
    const content = '{\n    "env": {"ANTHROPIC_BASE_URL": "https://xm.solov.cc", "OTHER": "https://xm.solov.cc"},\n  "model": "x"\n}\n'
    const next = rewriteJsonStrings(content, [{ path: ['env', 'ANTHROPIC_BASE_URL'], value: 'https://xm-direct.solov.cc' }])
    expect(next).toBe('{\n    "env": {"ANTHROPIC_BASE_URL": "https://xm-direct.solov.cc", "OTHER": "https://xm.solov.cc"},\n  "model": "x"\n}\n')
    expect(readJsonString(next ?? '', ['env', 'OTHER'])).toBe('https://xm.solov.cc')
    expect(rewriteJsonStrings('{ // comment\n}', [{ path: ['env', 'ANTHROPIC_BASE_URL'], value: toUrl }])).toBeNull()
  })

  it('rewrites the first matching .env line and keeps its quoting and line endings', () => {
    const content = '# keep\r\n  GOOGLE_GEMINI_BASE_URL = "https://xm.solov.cc"  \r\nGEMINI_API_KEY=sk-test\r\nGOOGLE_GEMINI_BASE_URL=https://other.example\r\n'
    // `名字 =` 带空格的那行 readEnvValue 也不认，认的是后面那行。
    expect(readEnvLineValue(rewriteEnvValue(content, 'GOOGLE_GEMINI_BASE_URL', 'https://xm-direct.solov.cc') ?? '', 'GOOGLE_GEMINI_BASE_URL')).toBe('https://xm-direct.solov.cc')
    expect(readEnvLineValue(content, 'GOOGLE_GEMINI_BASE_URL')).toBe('https://other.example')
    const spaced = '# keep\r\n  GOOGLE_GEMINI_BASE_URL="https://xm.solov.cc"  \r\nGEMINI_API_KEY=sk-test\r\nGOOGLE_GEMINI_BASE_URL=https://other.example\r\n'
    const next = rewriteEnvValue(spaced, 'GOOGLE_GEMINI_BASE_URL', 'https://xm-direct.solov.cc')
    expect(next).toBe('# keep\r\n  GOOGLE_GEMINI_BASE_URL="https://xm-direct.solov.cc"  \r\nGEMINI_API_KEY=sk-test\r\nGOOGLE_GEMINI_BASE_URL=https://other.example\r\n')
    expect(readEnvLineValue(next ?? '', 'GOOGLE_GEMINI_BASE_URL')).toBe('https://xm-direct.solov.cc')
    expect(rewriteEnvValue("A='x'\n", 'A', 'y')).toBe("A='y'\n")
    expect(rewriteEnvValue('B=x\n', 'A', 'y')).toBeNull()
    expect(rewriteEnvValue('A=x\n', 'A', 'y"z')).toBeNull()
  })

  it('reads the first exact .env line, strips one matching pair of quotes and returns null when it is missing', () => {
    expect(readEnvLineValue('A_OLD=old\nA =spaced\n  A= "quoted" \nA=second\n', 'A')).toBe('quoted')
    expect(readEnvLineValue("A='single'\r\nB=b\r\n", 'A')).toBe('single')
    expect(readEnvLineValue('A="mixed\'\n', 'A')).toBe('"mixed\'')
    expect(readEnvLineValue('A="\n', 'A')).toBe('')
    expect(readEnvLineValue('A=x=y\n', 'A')).toBe('x=y')
    expect(readEnvLineValue('A=\n', 'A')).toBe('')
    expect(readEnvLineValue('B=b\n', 'A')).toBeNull()
    expect(readEnvLineValue('', 'A')).toBeNull()
  })
})

// Random inputs (fast-check). The promise these functions make is "only the
// value asked for changes, every other byte stays as the customer left it, and
// when that cannot be guaranteed nothing is written". The library writes the
// configs (comments that quote the value, other keys holding the same value,
// quoted, dotted and inline table names), picks the value to change and what
// to change it to. A failing run prints its seed and the smallest config that
// breaks a rule; that is a real way a customer's file would be damaged.
describe('tool-route-rewrite with random inputs', () => {
  type Scalar = string | boolean | number

  interface Entry {
    key: string
    value: Scalar
    literal: boolean
    comment: string | null
  }

  interface Table {
    path: string[]
    style: 'header' | 'dotted' | 'inline'
    quoted: boolean
    entries: Entry[]
  }

  interface Leaf {
    path: string[]
    value: string | boolean
    written: string
  }

  interface RenderedToml {
    content: string
    leaves: Leaf[]
  }

  const bareKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/)
  const tableSegment = fc.oneof(bareKey, fc.stringMatching(/^[a-z][a-z ]{1,6}[a-z]$/))
  // Plain text has nothing a TOML basic string must escape, so it is written
  // exactly as JSON.stringify writes it.
  const plainText = fc.string({ unit: 'grapheme', maxLength: 24 }).filter((value) => !/["\\\u0000-\u001f\u007f]/.test(value))
  const stringValue = fc.oneof(
    { arbitrary: fc.constantFrom('https://xm.solov.cc/v1', 'https://xm-direct.solov.cc/v1', 'gpt-5.5', 'true', ''), weight: 2 },
    { arbitrary: fc.webUrl(), weight: 2 },
    { arbitrary: plainText, weight: 2 },
    { arbitrary: fc.string({ unit: 'grapheme', maxLength: 16 }), weight: 1 },
  )
  const scalar = fc.oneof({ arbitrary: stringValue, weight: 4 }, { arbitrary: fc.boolean(), weight: 1 }, { arbitrary: fc.integer({ min: 0, max: 999 }), weight: 1 })
  const commentText = fc.string({ unit: fc.constantFrom(...'abc xyz 019 =#"\'[]{}.'.split(''), '注', '释'), maxLength: 16 })
  const entries = fc.uniqueArray(
    fc.record({ key: bareKey, value: scalar, literal: fc.boolean(), comment: fc.option(commentText) }),
    { selector: (entry) => entry.key, maxLength: 4 },
  )
  const table = fc.record({
    path: fc.array(tableSegment, { minLength: 1, maxLength: 2 }),
    style: fc.constantFrom<Table['style']>('header', 'dotted', 'inline'),
    quoted: fc.boolean(),
    entries,
  })
  const tomlDocument = fc.record({
    top: entries,
    tables: fc.array(table, { maxLength: 4 }),
    // Comment lines that quote a value of the file, by [which value, which line].
    decoys: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 3 }),
    newline: fc.constantFrom('\n', '\r\n'),
    bom: fc.boolean(),
  }).map((document) => {
    // TOML defines each top-level name once: drop tables whose first segment a
    // top-level key or an earlier table already took.
    const taken = new Set(document.top.map((entry) => entry.key))
    const tables = document.tables.filter((candidate) => {
      if (taken.has(candidate.path[0])) return false
      taken.add(candidate.path[0])
      return true
    })
    return { ...document, tables }
  })

  function escapeBasic(character: string): string {
    if (character === '"') return '\\"'
    if (character === '\\') return '\\\\'
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
    return character
  }

  function writeTomlScalar(value: Scalar, literal: boolean): string {
    if (typeof value !== 'string') return String(value)
    if (literal && !/['\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return `'${value}'`
    return `"${[...value].map(escapeBasic).join('')}"`
  }

  function writeSegment(segment: string, quoted: boolean): string {
    return quoted || !/^[A-Za-z0-9_-]+$/.test(segment) ? JSON.stringify(segment) : segment
  }

  function renderToml(document: { top: Entry[]; tables: Table[]; decoys: [number, number][]; newline: string; bom: boolean }): RenderedToml {
    const head: string[] = []
    const tail: string[] = []
    const leaves: Leaf[] = []

    function line(prefix: string, entry: Entry, path: string[]): string {
      const written = writeTomlScalar(entry.value, entry.literal)
      if (typeof entry.value !== 'number') leaves.push({ path, value: entry.value, written })
      return `${prefix}${entry.key} = ${written}${entry.comment === null ? '' : ` # ${entry.comment}`}`
    }

    for (const entry of document.top) head.push(line('', entry, [entry.key]))
    for (const candidate of document.tables) {
      const name = candidate.path.map((segment) => writeSegment(segment, candidate.quoted)).join('.')
      if (candidate.style === 'dotted') {
        for (const entry of candidate.entries) head.push(line(`${name}.`, entry, [...candidate.path, entry.key]))
      } else if (candidate.style === 'inline') {
        const inner = candidate.entries.map((entry) => line('', { ...entry, comment: null }, [...candidate.path, entry.key]))
        head.push(`${name} = { ${inner.join(', ')} }`)
      } else {
        tail.push(`[${name}]`)
        for (const entry of candidate.entries) tail.push(line('', entry, [...candidate.path, entry.key]))
      }
    }
    const lines = [...head, ...tail]
    const quotable = leaves.filter((leaf) => typeof leaf.value === 'string')
    for (const [which, where] of document.decoys) {
      if (quotable.length === 0) break
      lines.splice(where % (lines.length + 1), 0, `# 原来是 ${quotable[which % quotable.length].written}`)
    }
    return { content: `${document.bom ? '\ufeff' : ''}${lines.join(document.newline)}${document.newline}`, leaves }
  }

  function parseToml(content: string): unknown {
    return TOML.parse(content.replace(/^\ufeff/, ''))
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function withValues(parsed: unknown, edits: readonly { path: readonly string[]; value: string | boolean }[]): unknown {
    for (const edit of edits) {
      let current = parsed
      for (const key of edit.path.slice(0, -1)) current = isRecord(current) ? current[key] : undefined
      if (isRecord(current)) current[edit.path[edit.path.length - 1]] = edit.value
    }
    return parsed
  }

  // The ways a value can be written, paired with the same way of writing the
  // new value; the rewrite may swap exactly one of them and nothing else.
  function spellings(previous: string | boolean, next: string | boolean): [string, string][] {
    if (typeof previous === 'boolean' || typeof next === 'boolean') return [[String(previous), String(next)]]
    return [[JSON.stringify(previous), JSON.stringify(next)], [`'${previous}'`, `'${next}'`]]
  }

  function isOneSwap(before: string, after: string, previous: string | boolean, next: string | boolean): boolean {
    for (const [find, replace] of spellings(previous, next)) {
      for (let index = before.indexOf(find); index !== -1; index = before.indexOf(find, index + 1)) {
        if (after === before.slice(0, index) + replace + before.slice(index + find.length)) return true
      }
    }
    return false
  }

  // When the value as written is one of the spellings the rewrite looks for,
  // and the new value can be written the same way, the rewrite has to succeed.
  function canRewrite(leaf: Leaf, next: string | boolean): boolean {
    if (typeof leaf.value === 'boolean' || typeof next === 'boolean') return true
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    if (leaf.written === JSON.stringify(leaf.value)) return !/\u007f/.test(next) && !loneSurrogate.test(next)
    return leaf.written === `'${leaf.value}'` && !/['\u0000-\u0008\u000a-\u001f\u007f]/.test(next) && !loneSurrogate.test(next)
  }

  const nextString = fc.oneof(
    fc.constantFrom('https://xm.solov.cc/v1', 'https://xm-direct.solov.cc/v1', 'deepseek-v4-flash', ''),
    fc.webUrl(),
    plainText,
    fc.string({ unit: 'grapheme', maxLength: 16 }),
    fc.string({ unit: 'binary', maxLength: 16 }),
  )
  const tomlCase = fc.tuple(tomlDocument.map(renderToml), fc.nat(), nextString, fc.boolean())
    .filter(([rendered]) => rendered.leaves.length > 0)
    .map(([rendered, pick, text, flip]) => {
      const leaf = rendered.leaves[pick % rendered.leaves.length]
      const next: string | boolean = typeof leaf.value === 'boolean' ? (flip ? !leaf.value : leaf.value) : text
      return { content: rendered.content, leaf, next }
    })

  it('TOML: changes only the value asked for, by swapping one spelling of it, or changes nothing', () => {
    fc.assert(fc.property(tomlCase, ({ content, leaf, next }) => {
      const edits = [{ path: leaf.path, value: next }]
      const result = rewriteTomlValues(content, edits)
      if (canRewrite(leaf, next)) expect(result).not.toBeNull()
      if (result === null) return
      expect(parseToml(result)).toEqual(withValues(parseToml(content), edits))
      if (next === leaf.value) expect(result).toBe(content)
      else expect(isOneSwap(content, result, leaf.value, next)).toBe(true)
      // Running it again changes nothing, and changing it back restores the file byte for byte.
      expect(rewriteTomlValues(result, edits)).toBe(result)
      expect(rewriteTomlValues(result, [{ path: leaf.path, value: leaf.value }])).toBe(content)
    }), { numRuns: 300 })
  })

  it('TOML: two edits in one call land on their own keys', () => {
    const twoEdits = fc.tuple(tomlDocument.map(renderToml), fc.nat(), fc.nat(), nextString, nextString)
      .filter(([rendered]) => rendered.leaves.length > 1)
    fc.assert(fc.property(twoEdits, ([rendered, first, second, textA, textB]) => {
      const a = rendered.leaves[first % rendered.leaves.length]
      const b = rendered.leaves[(first + 1 + (second % (rendered.leaves.length - 1))) % rendered.leaves.length]
      const edits = [a, b].map((leaf, index) => ({ leaf, path: leaf.path, value: typeof leaf.value === 'boolean' ? !leaf.value : index === 0 ? textA : textB }))
      const result = rewriteTomlValues(rendered.content, edits)
      if (edits.every((edit) => canRewrite(edit.leaf, edit.value))) expect(result).not.toBeNull()
      if (result !== null) expect(parseToml(result)).toEqual(withValues(parseToml(rendered.content), edits))
    }), { numRuns: 200 })
  })

  it('TOML: never throws on text that is not a config, and whatever it returns holds the value asked for', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 60 }), fc.array(bareKey, { minLength: 1, maxLength: 3 }), nextString, (content, path, value) => {
      const result = rewriteTomlStrings(content, [{ path, value }])
      if (result !== null) expect(readTomlString(result, path)).toBe(value)
    }), { numRuns: 300 })
  })

  const jsonKey = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,7}$/)
  const jsonTree = fc.letrec<{ node: unknown; object: Record<string, unknown> }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small' },
      fc.oneof(fc.string({ unit: 'binary', maxLength: 12 }), stringValue, fc.boolean(), fc.integer(), fc.constant(null)),
      tie('object'),
      fc.array(tie('node'), { maxLength: 3 }),
    ),
    object: fc.dictionary(jsonKey, tie('node'), { maxKeys: 4 }),
  })).object

  function stringLeaves(value: unknown, path: string[] = []): { path: string[]; value: string }[] {
    if (typeof value === 'string') return path.length > 0 ? [{ path, value }] : []
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    return Object.entries(value).flatMap(([key, child]) => stringLeaves(child, [...path, key]))
  }

  it('JSON: changes only the value asked for, always finds it in a file JSON.stringify wrote, and changes it back', () => {
    const jsonCase = fc.tuple(jsonTree, fc.constantFrom<undefined | number | string>(undefined, 2, 4, '\t'), fc.nat(), nextString)
      .map(([tree, indent, pick, next]) => ({ tree, content: `${JSON.stringify(tree, null, indent)}\n`, leaves: stringLeaves(tree), pick, next }))
      .filter((candidate) => candidate.leaves.length > 0)
    fc.assert(fc.property(jsonCase, ({ content, leaves, pick, next }) => {
      const leaf = leaves[pick % leaves.length]
      const edits = [{ path: leaf.path, value: next }]
      const result = rewriteJsonStrings(content, edits)
      expect(result).not.toBeNull()
      if (result === null) return
      expect(JSON.parse(result)).toEqual(withValues(JSON.parse(content), edits))
      if (next === leaf.value) expect(result).toBe(content)
      else expect(isOneSwap(content, result, leaf.value, next)).toBe(true)
      expect(rewriteJsonStrings(result, edits)).toBe(result)
      expect(rewriteJsonStrings(result, [{ path: leaf.path, value: leaf.value }])).toBe(content)
    }), { numRuns: 300 })
  })

  // An assignment with no name of its own assigns the name under test.
  type EnvLine = { kind: 'assign'; name: string | undefined; indent: string; raw: string } | { kind: 'other'; text: string }

  const envName = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,9}$/)
  const envText = fc.string({ unit: fc.constantFrom(...'abc:/.-_=# 019'.split(''), '\t', '\u3000', '"', "'", '值'), maxLength: 16 })
  const envLine: fc.Arbitrary<EnvLine> = fc.oneof(
    fc.record({ kind: fc.constant<'assign'>('assign'), name: fc.option(envName, { nil: undefined }), indent: fc.constantFrom('', '  ', '\t', '\ufeff'), raw: envText }),
    fc.record({ kind: fc.constant<'other'>('other'), text: fc.oneof(envText.map((text) => `# ${text}`), fc.constant(''), envText) }),
  )

  function renderEnv(name: string, lines: EnvLine[], separators: string[], suffix: string): string {
    const texts = lines.map((entry) => (entry.kind === 'assign' ? `${entry.indent}${entry.name ?? name}=${entry.raw}` : entry.text))
    return texts.map((text, index) => `${text}${index < texts.length - 1 ? separators[index % separators.length] : suffix}`).join('')
  }

  it('.env: rewrites the line readEnvLineValue reads, reads back the value written, and leaves every other line alone', () => {
    const envValue = fc.oneof(fc.webUrl(), plainText, fc.string({ unit: 'grapheme', maxLength: 12 }))
    fc.assert(fc.property(
      envName,
      fc.array(envLine, { maxLength: 6 }),
      fc.array(fc.constantFrom('\n', '\r\n'), { minLength: 1, maxLength: 3 }),
      fc.constantFrom('', '\n', '\r\n'),
      envValue,
      (name, lines, separators, suffix, value) => {
        const content = renderEnv(name, lines, separators, suffix)
        const result = rewriteEnvValue(content, name, value)
        const hasLine = content.split(/\r?\n/).some((entry) => entry.trimStart().startsWith(`${name}=`))
        expect(result !== null).toBe(hasLine && !/[\r\n"']/.test(value))
        if (result === null) return
        const before = content.split(/(\r?\n)/)
        const after = result.split(/(\r?\n)/)
        expect(after).toHaveLength(before.length)
        const changed = before.findIndex((entry, index) => index % 2 === 0 && entry.trimStart().startsWith(`${name}=`))
        after.forEach((entry, index) => {
          if (index !== changed) expect(entry).toBe(before[index])
        })
        // The changed line keeps its indent, its trailing blanks and its quotes.
        const original = before[changed]
        const indent = original.slice(0, original.length - original.trimStart().length)
        const body = original.slice(indent.length + name.length + 1).trim()
        const quote = body.length >= 2 && (body[0] === '"' || body[0] === "'") && body.endsWith(body[0]) ? body[0] : ''
        expect(after[changed].startsWith(`${indent}${name}=`)).toBe(true)
        expect(after[changed].endsWith(original.slice(original.trimEnd().length))).toBe(true)
        expect(after[changed]).toContain(`${quote}${value}${quote}`)
        if (value === value.trim()) expect(readEnvLineValue(result, name)).toBe(value)
        if (value !== '' && value === value.trim()) expect(rewriteEnvValue(result, name, value)).toBe(result)
      },
    ), { numRuns: 300 })
  })
})
