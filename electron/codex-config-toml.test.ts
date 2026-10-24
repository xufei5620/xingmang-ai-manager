import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendTomlText,
  editTomlArrayTableText,
  editTomlTableText,
  mutateCodexConfigToml,
  removeTomlTableText,
  renderTomlEdit,
  setTomlKeyText,
  type CodexTomlMutation,
} from './codex-config-toml'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-toml-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function backupNames(directory: string): string[] {
  return fs.readdirSync(directory).filter((name) => name.startsWith('config.toml.bak.')).sort()
}

function enableSkill(skillPath: string, enabled: boolean): Pick<CodexTomlMutation, 'mutate' | 'editText'> {
  return {
    mutate: (config) => {
      config.skills ??= {}
      const skills = record(config.skills)
      skills.config ??= []
      const entries = skills.config as Array<Record<string, unknown>>
      const existing = entries.find((entry) => entry.path === skillPath)
      if (existing?.enabled === enabled) return false
      if (existing) existing.enabled = enabled
      else entries.push({ path: skillPath, enabled })
      return true
    },
    editText: (source, before, after) => editTomlArrayTableText(source, ['skills', 'config'], before, after),
  }
}

describe('setTomlKeyText', () => {
  it('replaces only the value and keeps the trailing comment and line endings', () => {
    const source = '# 说明\r\n[plugins."sample@curated"] # 试用\r\n  enabled = false # 先关着\r\nnote = "x"\r\n'
    expect(setTomlKeyText(source, { keyPath: ['plugins', 'sample@curated'] }, 'enabled', true))
      .toBe('# 说明\r\n[plugins."sample@curated"] # 试用\r\n  enabled = true # 先关着\r\nnote = "x"\r\n')
  })

  it('adds a missing key after the last setting of its table, before the comments of the next one', () => {
    const source = '[a]\nx = 1\n\n# 下面是 b\n[b]\ny = 2\n'
    expect(setTomlKeyText(source, { keyPath: ['a'] }, 'enabled', false))
      .toBe('[a]\nx = 1\nenabled = false\n\n# 下面是 b\n[b]\ny = 2\n')
  })

  it('finds the nth array table entry and leaves the others alone', () => {
    const source = '[[skills.config]]\npath = "one"\nenabled = true\n\n[[skills.config]]\npath = "two"\nenabled = true\n'
    expect(setTomlKeyText(source, { keyPath: ['skills', 'config'], index: 1 }, 'enabled', false))
      .toBe('[[skills.config]]\npath = "one"\nenabled = true\n\n[[skills.config]]\npath = "two"\nenabled = false\n')
  })

  it('declines a value spread over several lines and a table it cannot find', () => {
    expect(setTomlKeyText('[a]\nx = """\none\n"""\n', { keyPath: ['a'] }, 'x', 'two')).toBeNull()
    expect(setTomlKeyText('a = { x = 1 }\n', { keyPath: ['a'] }, 'x', 2)).toBeNull()
  })

  it('escapes written strings the way the parser reads them back', () => {
    const value = 'C:\\Users\\客户\\"引号"\u007f'
    const edited = setTomlKeyText('[a]\npath = "old"\n', { keyPath: ['a'] }, 'path', value)
    expect(TOML.parse(edited ?? '')).toEqual({ a: { path: value } })
  })
})

describe('appendTomlText', () => {
  it('leaves one blank line before the appended table and keeps CRLF', () => {
    expect(appendTomlText('model = "m"\r\n', { plugins: { 'a@b': { enabled: true } } }))
      .toBe('model = "m"\r\n\r\n[plugins."a@b"]\r\nenabled = true\r\n')
    expect(appendTomlText('model = "m"', { a: { x: 1 } })).toBe('model = "m"\n\n[a]\nx = 1\n')
    expect(appendTomlText('', { a: { x: 1 } })).toBe('[a]\nx = 1\n')
  })
})

describe('editTomlTableText and editTomlArrayTableText', () => {
  it('declines removed keys, and array entries that were both dropped and changed, so the caller rewrites', () => {
    const before = { a: { x: 1, y: 2 }, list: [{ k: 1 }, { k: 2 }] }
    expect(editTomlTableText('[a]\nx = 1\ny = 2\n', ['a'], before, { a: { x: 1 } })).toBeNull()
    const source = '[[list]]\nk = 1\n\n[[list]]\nk = 2\n'
    expect(editTomlArrayTableText(source, ['list'], before, { list: [{ k: 3 }] })).toBeNull()
    expect(editTomlArrayTableText('', ['list'], before, { list: [{ k: 1 }] })).toBeNull()
  })

  it('drops only the removed array entries and keeps the comments that introduce the next table', () => {
    const source = '# 说明\n[[list]]\nk = 1\n\n[[list]] # 第二条\nk = 2\n# 第二条的说明\nnote = "x"\n\n# 下面是 b\n[b]\ny = 2\n\n[[list]]\nk = 3\n'
    const before = TOML.parse(source)
    const after = TOML.parse(source)
    ;(record(after).list as unknown[]).splice(1, 1)
    const edited = editTomlArrayTableText(source, ['list'], before, after)

    expect(edited).toBe('# 说明\n[[list]]\nk = 1\n\n# 下面是 b\n[b]\ny = 2\n\n[[list]]\nk = 3\n')
    expect(TOML.parse(edited ?? '')).toEqual(after)
  })

  it('takes the blank lines before the last entry with it, keeps CRLF, and empties the array cleanly', () => {
    const source = 'model = "m"\r\n\r\n[[list]]\r\nk = 1\r\n\r\n[[list]]\r\nk = 2\r\n'
    const before = TOML.parse(source)
    expect(editTomlArrayTableText(source, ['list'], before, { model: 'm', list: [{ k: 1 }] }))
      .toBe('model = "m"\r\n\r\n[[list]]\r\nk = 1\r\n')
    expect(editTomlArrayTableText(source, ['list'], before, { model: 'm' })).toBe('model = "m"\r\n')
  })
})

describe('removeTomlTableText', () => {
  it('drops the table with its own subtables and leaves the neighbours and their comments alone', () => {
    const source = 'model = "m"\n\n[mcp_servers.docs]\ncommand = "npx"\n\n  [mcp_servers.docs.env]\n  TOKEN = "t"\n\n# 下面是 files\n[mcp_servers.files]\nurl = "https://example.com/mcp"\n\n[mcp_servers.docs-extra]\ncommand = "x"\n'
    const edited = removeTomlTableText(source, ['mcp_servers', 'docs'])

    expect(edited).toBe('model = "m"\n\n# 下面是 files\n[mcp_servers.files]\nurl = "https://example.com/mcp"\n\n[mcp_servers.docs-extra]\ncommand = "x"\n')
    const after = TOML.parse(source)
    delete (record(after).mcp_servers as Record<string, unknown>).docs
    expect(TOML.parse(edited ?? '')).toEqual(after)
  })

  it('takes the blank lines before a table that ends the file, keeps CRLF, and declines tables it cannot find', () => {
    const source = 'model = "m"\r\n\r\n[mcp_servers.docs]\r\ncommand = "npx"\r\n\r\n[mcp_servers.docs.env]\r\nTOKEN = "t"\r\n'
    expect(removeTomlTableText(source, ['mcp_servers', 'docs'])).toBe('model = "m"\r\n')
    expect(removeTomlTableText('[mcp_servers]\ndocs = { command = "npx" }\n', ['mcp_servers', 'docs'])).toBeNull()
  })
})

describe('renderTomlEdit', () => {
  it('rewrites from the parsed object when the line edit does not read back the same', () => {
    const expected = { a: { x: 2 } }
    expect(renderTomlEdit('[a]\r\nx = 1\r\n', expected, '[a]\r\nx = 3\r\n')).toEqual({ content: '[a]\r\nx = 2\r\n', rewritten: true })
    expect(renderTomlEdit('[a]\nx = 1\n', expected, '[a]\nx = 2 # kept\n')).toEqual({ content: '[a]\nx = 2 # kept\n', rewritten: false })
  })
})

describe('mutateCodexConfigToml', () => {
  it('changes only the lines it has to, and keeps a backup of what was there', () => {
    const codexHome = temporaryDirectory()
    const configPath = path.join(codexHome, 'config.toml')
    const original = '# 客户自己写的说明\nmodel = "gpt-5.4" # 常用\n\n[[skills.config]]\npath = "/skills/a"\nenabled = true\n'
    fs.writeFileSync(configPath, original, 'utf8')

    const turnedOff = mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/a', false) })
    expect(turnedOff).toMatchObject({ changed: true, rewritten: false })
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original.replace('enabled = true', 'enabled = false'))
    expect(fs.readFileSync(turnedOff.backupPath ?? '', 'utf8')).toBe(original)

    const added = mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/b', false) })
    expect(added).toMatchObject({ changed: true, rewritten: false })
    expect(fs.readFileSync(configPath, 'utf8'))
      .toBe(`${original.replace('enabled = true', 'enabled = false')}\n[[skills.config]]\npath = "/skills/b"\nenabled = false\n`)
  })

  it('falls back to a whole rewrite when a table-like line sits inside a multiline string', () => {
    const codexHome = temporaryDirectory()
    const configPath = path.join(codexHome, 'config.toml')
    const prompt = '[[skills.config]]\npath = "/skills/a"\nenabled = true\n'
    fs.writeFileSync(configPath, `instructions = """\n${prompt}"""\n\n${prompt}`, 'utf8')

    const result = mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/a', false) })

    expect(result).toMatchObject({ changed: true, rewritten: true })
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      instructions: prompt,
      skills: { config: [{ path: '/skills/a', enabled: false }] },
    })
  })

  it('writes nothing and keeps no backup when nothing changes or the file is missing', () => {
    const codexHome = temporaryDirectory()
    const configPath = path.join(codexHome, 'config.toml')
    fs.writeFileSync(configPath, '[[skills.config]]\npath = "/skills/a"\nenabled = false\n', 'utf8')
    const before = fs.statSync(configPath).mtimeMs

    expect(mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/a', false) }))
      .toEqual({ changed: false, rewritten: false, backupPath: null })
    expect(fs.statSync(configPath).mtimeMs).toBe(before)
    expect(backupNames(codexHome)).toEqual([])

    const missing = path.join(codexHome, 'nested', 'config.toml')
    expect(mutateCodexConfigToml(missing, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/a', false) }).changed).toBe(false)
    expect(fs.existsSync(path.dirname(missing))).toBe(false)
    expect(mutateCodexConfigToml(missing, {
      label: 'Codex config.toml', unreadable: '读不懂', createIfMissing: true, ...enableSkill('/skills/a', false),
    })).toMatchObject({ changed: true, backupPath: null })
    expect(TOML.parse(fs.readFileSync(missing, 'utf8'))).toEqual({ skills: { config: [{ path: '/skills/a', enabled: false }] } })
  })

  it('reports an unreadable file in its own words and never quotes the lines around the error', () => {
    const codexHome = temporaryDirectory()
    const configPath = path.join(codexHome, 'config.toml')
    const broken = 'token = "sk-secret-0123456789"\nvalue = “30”\n'
    fs.writeFileSync(configPath, broken, 'utf8')

    expect(() => mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂，没改', ...enableSkill('/skills/a', false) }))
      .toThrow(/^读不懂，没改$/)
    expect(mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: 'skip', ...enableSkill('/skills/a', false) }).changed).toBe(false)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(broken)
  })

  it('keeps only the five newest backups, counted together with the ones a saved configuration left', () => {
    const codexHome = temporaryDirectory()
    const configPath = path.join(codexHome, 'config.toml')
    fs.writeFileSync(configPath, 'model = "m"\n', 'utf8')
    for (const stamp of ['20260101000000001', '20260101000000002', '20260101000000003', '20260101000000004', '20260101000000005']) {
      fs.writeFileSync(`${configPath}.bak.${stamp}`, 'old\n', 'utf8')
    }

    const result = mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/a', false) })

    const backups = backupNames(codexHome)
    expect(backups).toHaveLength(5)
    expect(backups[0]).toBe('config.toml.bak.20260101000000002')
    expect(backups).toContain(path.basename(result.backupPath ?? ''))
  })

  it('refuses a hard-linked config.toml before writing anything', () => {
    const codexHome = temporaryDirectory()
    const configPath = path.join(codexHome, 'config.toml')
    fs.writeFileSync(configPath, 'model = "m"\n', 'utf8')
    fs.linkSync(configPath, path.join(codexHome, 'alias.toml'))

    expect(() => mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/a', false) }))
      .toThrow('单链接普通文件')
    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "m"\n')
    expect(backupNames(codexHome)).toEqual([])
  })

  it('leaves the previous file and no temporary file behind when the replacement keeps failing', () => {
    const codexHome = temporaryDirectory()
    const configPath = path.join(codexHome, 'config.toml')
    fs.writeFileSync(configPath, 'model = "m"\n', 'utf8')
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.resolve(String(to)) === path.resolve(configPath)) {
        throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
      }
      originalRename(from, to)
    })

    expect(() => mutateCodexConfigToml(configPath, { label: 'Codex config.toml', unreadable: '读不懂', ...enableSkill('/skills/a', false) }))
      .toThrow('EIO')
    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "m"\n')
    expect(fs.readdirSync(codexHome).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
