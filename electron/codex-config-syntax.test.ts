import * as TOML from '@iarna/toml'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isCodexConfigBroken, salvageCodexConfigText } from './codex-config-syntax'

const relayConfig = [
  'model_provider = "XingmangAI"',
  'model = "gpt-6-sol"',
  'approval_policy = "on-request"',
  'notify = ["C:\\\\Program Files\\\\nodejs\\\\node.exe", "C:\\\\Users\\\\张三\\\\hook.cjs"]',
  '',
  '[model_providers.XingmangAI]',
  'name = "XingmangAI"',
  'base_url = "https://xm.solov.cc/v1"',
  'wire_api = "responses"',
  '',
  '[projects."C:\\\\Users\\\\张三\\\\项目"]',
  'trust_level = "trusted"',
  '',
].join('\n')

function broken(text: string): boolean {
  return isCodexConfigBroken(Buffer.from(text, 'utf8'))
}

// What the bundled parser says when a bracket is missing.
const unclosedHeader = 'Unexpected character, expected whitespace, . or ]'
const missingCommaOrBracket = 'Invalid character, expected whitespace, comma (,) or close bracket (])'
const unterminatedInline = 'Unterminated inline array'

describe('isCodexConfigBroken', () => {
  it('accepts the config the app writes, with or without a byte order mark', () => {
    expect(broken(relayConfig)).toBe(false)
    expect(broken(`\uFEFF${relayConfig}`)).toBe(false)
    expect(broken(relayConfig.replace(/\n/g, '\r\n'))).toBe(false)
    expect(broken('')).toBe(false)
    expect(broken('# 只有注释\n')).toBe(false)
  })

  // Codex 0.159.0-alpha.12.1 (the Codex Desktop 26.930 build) reads each of
  // these; the bundled TOML 0.5 parser rejects them all. They must not be
  // reported as broken, or the home page would offer to reset a working file.
  it('does not report TOML 1.1 syntax that Codex reads but the bundled parser does not', () => {
    for (const line of [
      'xm = [1, "a"]',
      'xm = {\n  a = 1, # 注释\n  b = 2,\n}',
      'xm = "\\e[0m \\x41"',
      'xm = 07:32',
      'xm = 1979-05-27T07:32Z',
      'xm = """a"""""',
      "xm = '''a'''''",
    ]) {
      expect(broken(`${line}\n${relayConfig}`), line).toBe(false)
    }
  })

  // Codex 0.169.0 reads each of these too. The bundled parser rejects them with the
  // same two messages it gives for a missing ] or }, so those messages alone prove nothing.
  it('does not report TOML 1.1 syntax that trips the missing-bracket messages', () => {
    for (const [line, message] of [
      ['xm = ["""a"""""]', missingCommaOrBracket],
      ["xm = { s = '''a''''' }", missingCommaOrBracket],
      ['xm = { a = 1\n}', unterminatedInline],
      ['xm = [{\n  a = 1\n}]', unterminatedInline],
      ['xm = {\n  a = "}", # } ]\n  b = \'{[\',\n  c = """\n}""",\n  d = [\'\'\'x]\'\'\', "\\"]"],\n}', unterminatedInline],
    ]) {
      expect(() => TOML.parse(`${line}\n${relayConfig}`), line).toThrow(message)
      expect(broken(`${line}\n${relayConfig}`), line).toBe(false)
    }
  })

  it('reports a file Codex cannot decode as UTF-8', () => {
    // 「张三」 saved by Notepad as GBK (ANSI on a Chinese Windows).
    const gbk = Buffer.concat([Buffer.from('[projects."C:\\\\Users\\\\'), Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]), Buffer.from('"]\ntrust_level = "trusted"\n')])
    expect(isCodexConfigBroken(gbk)).toBe(true)
  })

  it('reports control characters that TOML forbids even in comments', () => {
    // A power cut right after a save can leave the whole file as zero bytes.
    expect(isCodexConfigBroken(Buffer.alloc(300))).toBe(true)
    expect(broken(`# a\u0001b\n${relayConfig}`)).toBe(true)
    expect(broken(`# a\u007fb\n${relayConfig}`)).toBe(true)
    expect(broken('xm = 1\rmodel = "a"\n')).toBe(true)
  })

  it('reports duplicate keys and tables written by other tools', () => {
    expect(broken(`model = "dup"\n${relayConfig}`)).toBe(true)
    expect(broken(`${relayConfig}[model_providers.XingmangAI]\nname = "again"\n`)).toBe(true)
    expect(broken('xm = { a = 1 }\nxm.b = 2\n')).toBe(true)
    expect(broken('xm = [1]\n[[xm]]\n')).toBe(true)
  })

  it('reports a file that stops half way through', () => {
    expect(broken('model = "gpt-6-sol"\nmodel_reasoning_effort = "xhi')).toBe(true)
    expect(broken('model = "gpt-6-sol"\nmodel_reasoning_eff')).toBe(true)
    expect(broken('model = "gpt-6-sol"\nmodel_reasoning_effort =')).toBe(true)
    expect(broken('model = "gpt-6-sol"\n[model_providers.Xingm')).toBe(true)
    expect(broken('developer_instructions = """abc\n')).toBe(true)
  })

  // Codex 0.169.0 refuses every file below. Each case names the bundled parser's message it
  // stands for, so a parser upgrade that rewords one fails here instead of silently missing it.
  it('reports a table header, array or inline table that never closes', () => {
    for (const [text, message, codexSays] of [
      [`[model_providers.Other\nname = "a"\n${relayConfig}`, unclosedHeader, 'unclosed table, expected `]`'],
      [`${relayConfig}[[hooks]\nx = 1\n`, unclosedHeader, 'unclosed array table, expected `]`'],
      [`notify = ["codex", "hook"\n${relayConfig}`, missingCommaOrBracket, 'missing comma between array elements'],
      [`xm = { a = 1 ]\n${relayConfig}`, missingCommaOrBracket, 'invalid inline table element'],
      [`xm = { a = 1\n${relayConfig}`, unterminatedInline, 'missing comma between key-value pairs'],
      [`${relayConfig}notify = ["codex",\n`, unterminatedInline, 'unclosed array, expected `]`'],
      [`${relayConfig}xm = { a = 1`, unterminatedInline, 'unclosed inline table, expected `}`'],
    ]) {
      expect(() => TOML.parse(text), codexSays).toThrow(message)
      expect(broken(text), codexSays).toBe(true)
    }
  })

  it('reports an unclosed bracket even when a closer hides in a later string or comment', () => {
    expect(broken(`xm = { a = 1\ny = "}"\n${relayConfig}`)).toBe(true)
    expect(broken(`xm = { a = 1\n# }\n${relayConfig}`)).toBe(true)
    expect(broken(`xm = { a = 1\ny = '''\n}\n'''\n${relayConfig}`)).toBe(true)
    expect(broken(`notify = ["codex"\n[t]\nk = 1\n`)).toBe(true)
  })

  // Random inputs (fast-check). The promise: a TOML 1.1 inline table spread over lines is never
  // reported broken, whatever brackets, quotes or # its strings and comments hold; drop its } and it is.
  it('tells a multi-line inline table from an unclosed one, with random inputs', () => {
    const tricky = fc.string({ unit: fc.constantFrom('[', ']', '{', '}', '"', "'", '#', '\\', ',', '=', ' ', 'a', '中'), maxLength: 12 })
    const value = fc.oneof(
      tricky.map((text) => JSON.stringify(text)),
      tricky.filter((text) => !text.includes("'")).map((text) => `'${text}'`),
      tricky.filter((text) => !text.includes("'''") && !text.endsWith("'")).map((text) => `'''${text}'''`),
    )
    const entries = fc.array(fc.record({ value, comment: fc.option(tricky.map((text) => `# ${text}`), { nil: undefined }) }), { minLength: 1, maxLength: 4 })
    fc.assert(fc.property(entries, (list) => {
      const body = list.map((entry, index) => `  k${index} = ${entry.value},${entry.comment ? ` ${entry.comment}` : ''}`).join('\n')
      expect(broken(`xm = {\n${body}\n}\n${relayConfig}`)).toBe(false)
      expect(broken(`xm = {\n${body}\n${relayConfig}`)).toBe(true)
    }), { numRuns: 300 })
  })

  it('reports hand edits Codex refuses', () => {
    expect(broken('xm = "C:\\Users\\a"\n')).toBe(true)
    expect(broken('xm = "D:\\projects"\n')).toBe(true)
    expect(broken('model = “gpt-6-sol”\n')).toBe(true)
    expect(broken('model ＝ "gpt-6-sol"\n')).toBe(true)
    expect(broken('<<<<<<< HEAD\nmodel = "a"\n=======\nmodel = "b"\n>>>>>>> other\n')).toBe(true)
    expect(broken('{"model": "gpt-6-sol"}\n')).toBe(true)
  })
})

// 2026-11-18 客户：PowerShell 5.1 按 GBK 读、UTF-8 写回，中文用户名成了乱码，紧跟着的那个反斜杠被乱码的最后
// 一个字吃掉，只剩一个，「\A」「\.」就成了认不出的转义。这里用虚构的「张小明」：它成了「寮犲皬鏄嶾」，
// 反斜杠被「嶾」吃掉（GBK 8E 5C）。
const mangledName = '\u5BEE\u72B2\u76AC\u93C4\u5DBE'

describe('salvageCodexConfigText', () => {
  function salvage(text: string) {
    const result = salvageCodexConfigText(text)
    return result === null ? null : { text: result, parsed: TOML.parse(result) }
  }

  it('drops only the lines a GBK round trip broke and keeps every other setting where it was', () => {
    const text = [
      'model_provider = "XingmangAI"',
      'model = "gpt-6.2-astra"',
      'model_reasoning_effort = "high"',
      `notify = ["C:\\\\Users\\\\${mangledName}\\AppData\\\\Roaming\\\\hook\\\\node.exe", "codex"]`,
      '',
      '[model_providers.XingmangAI]',
      'name = "XingmangAI"',
      'base_url = "https://xm.solov.cc/v1"',
      '',
      '[plugins."browser@openai-bundled"]',
      `source = "\\\\\\\\?\\\\C:\\\\Users\\\\${mangledName}\\.cache\\\\plugins\\\\browser"`,
      'enabled = true',
      '',
      '[mcp_servers.node_repl]',
      'command = "node"',
      '',
      '[mcp_servers.node_repl.env]',
      `CODEX_HOME = "C:\\\\Users\\\\${mangledName}\\.codex"`,
      'NODE_REPL_MAX_OUTPUT = "4000"',
      '',
      `[projects."C:\\\\Users\\\\${mangledName}\\Documents"]`,
      'trust_level = "trusted"',
      '',
      '[projects."D:\\\\work"]',
      'trust_level = "trusted"',
      '',
    ].join('\r\n')
    expect(isCodexConfigBroken(Buffer.from(text, 'utf8'))).toBe(true)

    const result = salvage(text)
    expect(result?.parsed).toEqual({
      model_provider: 'XingmangAI',
      model: 'gpt-6.2-astra',
      model_reasoning_effort: 'high',
      model_providers: { XingmangAI: { name: 'XingmangAI', base_url: 'https://xm.solov.cc/v1' } },
      plugins: { 'browser@openai-bundled': { enabled: true } },
      mcp_servers: { node_repl: { command: 'node', env: { NODE_REPL_MAX_OUTPUT: '4000' } } },
      // The broken header goes with its own keys: trust_level must not land in the table above it.
      projects: { 'D:\\work': { trust_level: 'trusted' } },
    })
    expect(isCodexConfigBroken(Buffer.from(result!.text, 'utf8'))).toBe(false)
  })

  it('drops a table header that lost its ] together with the keys under it', () => {
    const text = ['model = "a"', '', '[mcp_servers.docs', 'command = "npx"', '', '[projects."D:\\\\work"]', 'trust_level = "trusted"', ''].join('\n')
    expect(isCodexConfigBroken(Buffer.from(text, 'utf8'))).toBe(true)
    expect(salvage(text)?.parsed).toEqual({ model: 'a', projects: { 'D:\\work': { trust_level: 'trusted' } } })
  })

  it('also drops lines with characters TOML forbids, including stray comments', () => {
    expect(salvage('# a\u0001b\nmodel = "a"\n')?.parsed).toEqual({ model: 'a' })
    expect(salvage('model = "a\u0007"\napproval_policy = "never"\n')?.parsed).toEqual({ approval_policy: 'never' })
  })

  it('gives up whenever removing a line could change what the rest means', () => {
    // A broken element of an array that spans lines: dropping it alone would leave half an array.
    expect(salvage('model = "a"\nnotify = [\n  "C:\\Users\\x",\n  "codex",\n]\n')).toBeNull()
    // An array or inline table that never closes: the parser points at the next line, not the broken one.
    expect(salvage('notify = ["codex"\nmodel = "a"\n')).toBeNull()
    expect(salvage('xm = { a = 1\nmodel = "a"\n')).toBeNull()
    // Duplicates: which one the customer meant is a guess.
    expect(salvage('model = "a"\nmodel = "b"\n')).toBeNull()
    expect(salvage('[a]\nx = 1\n[a]\ny = 2\n')).toBeNull()
    // Multi-line strings can hide anything that looks like a line of its own.
    expect(salvage('developer_instructions = """\nx = "\\A"\n"""\nmodel = "C:\\A"\n')).toBeNull()
    // A line that is not a key, a table, a comment or blank.
    expect(salvage('model = "a"\n<<<<<<< HEAD\napproval_policy = "never"\n')).toBeNull()
    expect(salvage('model ＝ "a"\napproval_policy = "never"\n')).toBeNull()
    // Not UTF-8 is not this function's business, and a file Codex reads needs no salvage.
    expect(salvage('model = "a"\n')).toBeNull()
    expect(salvage('')).toBeNull()
  })

  it('gives up when nothing readable would be left or too much is broken', () => {
    expect(salvage('model = "C:\\Users\\a"\n')).toBeNull()
    expect(salvage('\u0000'.repeat(300))).toBeNull()
    const manyBroken = Array.from({ length: 21 }, (_, index) => `k${index} = "C:\\A"`).join('\n')
    expect(salvage(`model = "a"\n${manyBroken}\n`)).toBeNull()
    expect(salvage(`model = "a"\n${manyBroken.split('\n').slice(1).join('\n')}\n`)?.parsed).toEqual({ model: 'a' })
  })

  // Random inputs (fast-check). The promise: whatever lines are broken, salvage only ever removes the broken
  // key lines, never moves or changes a key that was readable.
  it('removes exactly the broken keys and keeps the rest in their tables, with random inputs', () => {
    const bareKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/)
    const plainValue = fc.stringMatching(/^[A-Za-z0-9 ._:/-]{0,12}$/)
    const table = fc.uniqueArray(fc.record({ key: bareKey, value: plainValue, broken: fc.boolean() }), { selector: (entry) => entry.key, minLength: 1, maxLength: 4 })
    const config = fc.record({
      top: table,
      tables: fc.uniqueArray(fc.record({ name: bareKey, entries: table }), { selector: (entry) => entry.name, maxLength: 3 }),
    })
    fc.assert(fc.property(config, ({ top, tables }) => {
      const names = new Set(top.map((entry) => entry.key))
      const usable = tables.filter((entry) => !names.has(entry.name))
      const line = (entry: { key: string; value: string; broken: boolean }) => `${entry.key} = "${entry.broken ? `C:\\Users\\${mangledName}\\A` : ''}${entry.value}"`
      const text = [...top.map(line), ...usable.flatMap((entry) => ['', `[${entry.name}]`, ...entry.entries.map(line)])].join('\n')
      const kept = (entries: Array<{ key: string; value: string; broken: boolean }>) => Object.fromEntries(entries.filter((entry) => !entry.broken).map((entry) => [entry.key, entry.value]))
      const expected: Record<string, unknown> = { ...kept(top), ...Object.fromEntries(usable.map((entry) => [entry.name, kept(entry.entries)])) }
      const anyBroken = [...top, ...usable.flatMap((entry) => entry.entries)].some((entry) => entry.broken)
      const result = salvage(text)
      if (!anyBroken || Object.keys(expected).length === 0) expect(result).toBeNull()
      else expect(result?.parsed).toEqual(expected)
    }), { numRuns: 300 })
  })
})
