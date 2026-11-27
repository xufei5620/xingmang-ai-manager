import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_ANTIGRAVITY_CHINESE_RELATIVE_PATH,
  buildAntigravityChineseDictionary,
  buildAntigravityChineseInjection,
  bundledAntigravityChineseSource,
  parseAntigravityChineseInjectionResult,
  parseAntigravityChinesePack,
  readBundledAntigravityChinesePack,
} from './antigravity-desktop-chinese'

const bundledPath = path.join(process.cwd(), ...BUNDLED_ANTIGRAVITY_CHINESE_RELATIVE_PATH)
const temporaryDirectories: string[] = []

function temporaryFile(name: string, content: string | Buffer): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-antigravity-zh-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

function packText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    locale: 'zh-CN',
    version: '9.9.9',
    base: { exact: { Settings: '设置', Agent: 'Agent' }, patterns: [{ source: '^(.+?) days$', flags: '', replace: '$1 天', hint: 'days' }] },
    modes: {
      light: { exact: {}, patterns: [] },
      deep: { exact: { Agent: '智能体' }, patterns: [{ source: '^Open (.+?)$', flags: '', replace: '打开 $1', hint: 'Open' }] },
    },
    ...overrides,
  })
}

// The runtime is a fixed function source, so the first `})({"version":` is where the data starts,
// whatever the word list itself contains.
function injectedPayload(expression: string): Record<string, unknown> {
  const boundary = expression.indexOf('})({"version":')
  expect(boundary).toBeGreaterThan(0)
  expect(expression.endsWith(')')).toBe(true)
  return JSON.parse(expression.slice(boundary + 3, -1)) as Record<string, unknown>
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('bundled Antigravity Chinese word list', () => {
  it('matches the pinned upstream file byte for byte', () => {
    const digest = createHash('sha256').update(fs.readFileSync(bundledPath)).digest('hex')
    expect(digest).toBe(bundledAntigravityChineseSource.sha256)
  })

  it('ships the GPL text and a README that name the same source', () => {
    const directory = path.dirname(bundledPath)
    expect(fs.readFileSync(path.join(directory, 'LICENSE'), 'utf8')).toMatch(/^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
    const readme = fs.readFileSync(path.join(directory, 'README.md'), 'utf8')
    for (const value of [bundledAntigravityChineseSource.repository, bundledAntigravityChineseSource.tag, bundledAntigravityChineseSource.commit, bundledAntigravityChineseSource.path, bundledAntigravityChineseSource.sha256]) {
      expect(readme).toContain(value)
    }
  })

  it('reads every entry of the bundled file without dropping any', async () => {
    const pack = await readBundledAntigravityChinesePack(bundledPath)
    expect(pack.version).toBe(bundledAntigravityChineseSource.version)
    expect(pack.rejected).toBe(0)
    expect(Object.keys(pack.base.exact).length).toBeGreaterThan(4000)
    expect(pack.base.patterns.length).toBeGreaterThan(700)
    const deep = buildAntigravityChineseDictionary(pack, 'deep')
    expect(deep.exact['New Conversation']).toBe('新建对话')
    expect(deep.exact.Agent).toBe('智能体')
    expect(buildAntigravityChineseDictionary(pack, 'light').exact.Agent).toBe('Agent')
  })

  it('refuses a copy whose bytes differ from the pinned file', async () => {
    const original = fs.readFileSync(bundledPath, 'utf8')
    const tampered = temporaryFile('zh-CN.json', original.replace('"新建对话"', '"点这里登录"'))
    await expect(readBundledAntigravityChinesePack(tampered)).rejects.toThrow('与发布时不一致')
  })

  it('refuses something that is not a regular file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-antigravity-zh-'))
    temporaryDirectories.push(directory)
    await expect(readBundledAntigravityChinesePack(directory)).rejects.toThrow('大小异常')
  })
})

describe('parseAntigravityChinesePack', () => {
  it('rejects text that is not this kind of word list', () => {
    expect(() => parseAntigravityChinesePack('not json')).toThrow('无法读取')
    expect(() => parseAntigravityChinesePack(packText({ locale: 'ja-JP' }))).toThrow('格式不对')
    expect(() => parseAntigravityChinesePack(packText({ schemaVersion: 2 }))).toThrow('格式不对')
    expect(() => parseAntigravityChinesePack(packText({ modes: null }))).toThrow('格式不对')
    expect(() => parseAntigravityChinesePack(packText({ base: { exact: {} }, modes: { light: {}, deep: {} } }))).toThrow('条数异常')
  })

  it('drops entries that are too long, unanchored, catastrophic or uncompilable and counts them', () => {
    const pack = parseAntigravityChinesePack(packText({
      base: {
        exact: { Settings: '设置', '': '空', Blank: '   ', Long: 'x'.repeat(1501), [`${'k'.repeat(1001)}`]: '长' },
        patterns: [
          { source: '^(.+?) days$', flags: '', replace: '$1 天', hint: 'days' },
          { source: '(.+?) days$', flags: '', replace: '$1 天' },
          { source: '^(.+?) days', flags: '', replace: '$1 天' },
          { source: '^(a+)+$', flags: '', replace: '坏' },
          { source: '^(.+?$', flags: '', replace: '坏' },
          { source: '^x$', flags: 'g', replace: '坏' },
          { source: '^x$', flags: '', replace: '' },
          { source: `^${'a'.repeat(360)}$`, flags: '', replace: '长' },
          'not an object',
        ],
      },
    }))
    expect(pack.base.exact).toEqual({ Settings: '设置' })
    expect(pack.base.patterns).toEqual([{ source: '^(.+?) days$', flags: '', replace: '$1 天', hint: 'days' }])
    expect(pack.rejected).toBe(4 + 8)
  })

  it('keeps no hint on case-insensitive patterns, where the original case may differ from the hint', () => {
    const pack = parseAntigravityChinesePack(packText({
      base: { exact: { Settings: '设置' }, patterns: [{ source: '^open (.+?)$', flags: 'i', replace: '打开 $1', hint: 'open' }] },
    }))
    expect(pack.base.patterns).toEqual([{ source: '^open (.+?)$', flags: 'i', replace: '打开 $1' }])
  })
})

describe('buildAntigravityChineseDictionary', () => {
  it('lets the chosen depth override shared entries and try its patterns first', () => {
    const pack = parseAntigravityChinesePack(packText())
    const deep = buildAntigravityChineseDictionary(pack)
    expect(deep.depth).toBe('deep')
    expect(deep.exact).toEqual({ Settings: '设置', Agent: '智能体' })
    expect(deep.patterns.map((pattern) => pattern.source)).toEqual(['^Open (.+?)$', '^(.+?) days$'])
    const light = buildAntigravityChineseDictionary(pack, 'light')
    expect(light.exact.Agent).toBe('Agent')
    expect(light.patterns.map((pattern) => pattern.source)).toEqual(['^(.+?) days$'])
  })
})

describe('buildAntigravityChineseInjection', () => {
  it('embeds the word list as a data literal after the runtime', () => {
    const pack = parseAntigravityChinesePack(packText())
    const expression = buildAntigravityChineseInjection(buildAntigravityChineseDictionary(pack))
    expect(expression.startsWith('((dictionary) => {')).toBe(true)
    const payload = injectedPayload(expression)
    expect(payload.exact).toEqual({ Settings: '设置', Agent: '智能体' })
    expect(payload.depth).toBe('deep')
    expect(String(payload.protectedAreaSelector)).toContain('[data-testid="planner-response-text"]')
    expect(String(payload.protectedAreaSelector)).toContain('[class*="material-symbols-"]')
    expect(String(payload.protectedTextSelector)).toContain('code')
  })
})

describe('parseAntigravityChineseInjectionResult', () => {
  it('accepts only what the runtime reports', () => {
    expect(parseAntigravityChineseInjectionResult('{"runtimeVersion":1,"version":"1.0.3","depth":"deep","translated":12}'))
      .toEqual({ runtimeVersion: 1, version: '1.0.3', depth: 'deep', translated: 12 })
    for (const value of [undefined, 12, 'nope', '[]', '{"runtimeVersion":2,"version":"1","depth":"deep","translated":1}', '{"runtimeVersion":1,"version":"1","depth":"mid","translated":1}', '{"runtimeVersion":1,"version":"1","depth":"deep","translated":-1}']) {
      expect(parseAntigravityChineseInjectionResult(value)).toBeNull()
    }
  })
})

describe('Antigravity Chinese word list with random inputs', () => {
  it('never lets a word-list string escape the data literal', () => {
    fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ minLength: 1, maxLength: 40 }), { maxKeys: 8 }), (exact) => {
      const cleaned = Object.fromEntries(Object.entries(exact).filter(([key, value]) => key.trim() && value.trim() && key.trim() !== '__proto__'))
      fc.pre(Object.keys(cleaned).length > 0)
      const pack = parseAntigravityChinesePack(packText({ base: { exact: cleaned, patterns: [] }, modes: { light: {}, deep: {} } }))
      const expression = buildAntigravityChineseInjection(buildAntigravityChineseDictionary(pack))
      const payload = injectedPayload(expression)
      expect(payload.exact).toEqual(pack.base.exact)
    }))
  })

  it('only keeps patterns that are anchored at both ends and free of nested repetition', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), fc.constantFrom('', 'i', 'g', 'm'), (source, flags) => {
      const pack = parseAntigravityChinesePack(packText({ base: { exact: { Settings: '设置' }, patterns: [{ source, flags, replace: '中' }] }, modes: { light: {}, deep: {} } }))
      for (const pattern of pack.base.patterns) {
        expect(pattern.source.startsWith('^') && pattern.source.endsWith('$')).toBe(true)
        expect(/\([^)]*[+*][^)]*\)[+*{]/.test(pattern.source)).toBe(false)
        expect(['', 'i']).toContain(pattern.flags)
      }
    }))
  })
})
