import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mergeRemovedCliHooks,
  parseRemovedCliHooks,
  planRemovedCliHooksRestore,
  readRemovedCliHooks,
  rememberRemovedCliHooks,
  removedCliHooksContent,
  removedCliHooksRecordPath,
  replaceRemovedCliHooks,
  sameRemovedCliHooksConfigPath,
  type RemovedCliHooks,
} from './removed-cli-hooks'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-removed-hooks-'))
  temporaryDirectories.push(directory)
  return directory
}

const claudeSettings = path.resolve('/home/me/.claude/settings.json')
const codexConfig = path.resolve('/home/me/.codex/config.toml')
const claude: RemovedCliHooks = { provider: 'claude', parts: ['hooks', 'statusLine'], configPath: claudeSettings }
const codex: RemovedCliHooks = { provider: 'codex', parts: ['hooks'], configPath: codexConfig }

describe('parseRemovedCliHooks', () => {
  it('reads back what the uninstaller wrote', () => {
    expect(parseRemovedCliHooks(removedCliHooksContent([claude, codex]))).toEqual([claude, codex])
  })

  it('treats an unreadable or unknown record as none, so nothing is put back', () => {
    expect(parseRemovedCliHooks('not json')).toEqual([])
    expect(parseRemovedCliHooks('[]')).toEqual([])
    expect(parseRemovedCliHooks(JSON.stringify({ version: 2, entries: [claude] }))).toEqual([])
    expect(parseRemovedCliHooks(JSON.stringify({ version: 1, entries: 'claude' }))).toEqual([])
  })

  it('drops entries for retired or unknown tools, unknown parts and paths that are not absolute', () => {
    const entries = [
      { provider: 'gemini', parts: ['hooks'], configPath: path.resolve('/home/me/.gemini/settings.json') },
      { provider: 'cursor', parts: ['hooks'], configPath: claudeSettings },
      { provider: 'claude', parts: ['mcp'], configPath: claudeSettings },
      { provider: 'codex', parts: ['hooks'], configPath: '.codex/config.toml' },
      { provider: 'codex', parts: ['hooks'], configPath: `${codexConfig}\0` },
      { provider: 'grok', parts: ['hooks', 'mcp', 'hooks'], configPath: path.resolve('/home/me/.grok/config.toml') },
    ]
    expect(parseRemovedCliHooks(JSON.stringify({ version: 1, entries }))).toEqual([
      { provider: 'grok', parts: ['hooks'], configPath: path.resolve('/home/me/.grok/config.toml') },
    ])
  })

  it('keeps one entry per tool', () => {
    const entries = [{ ...claude, parts: ['hooks'] }, { ...claude, parts: ['statusLine'] }]
    expect(parseRemovedCliHooks(JSON.stringify({ version: 1, entries }))).toEqual([claude])
  })
})

describe('mergeRemovedCliHooks', () => {
  it('adds what a later uninstall took back to an earlier record of the same file', () => {
    expect(mergeRemovedCliHooks([{ ...claude, parts: ['statusLine'] }], [{ ...claude, parts: ['hooks'] }, codex])).toEqual([claude, codex])
  })

  it('lets a later uninstall of a different file replace the earlier one', () => {
    const moved = { ...codex, configPath: path.resolve('/home/me/other-codex/config.toml') }
    expect(mergeRemovedCliHooks([codex], [moved])).toEqual([moved])
  })

  it('does not change the entries it was given', () => {
    const existing = [{ ...claude, parts: ['statusLine' as const] }]
    mergeRemovedCliHooks(existing, [claude])
    expect(existing[0].parts).toEqual(['statusLine'])
  })
})

describe('sameRemovedCliHooksConfigPath', () => {
  it('ignores letter case only on Windows', () => {
    expect(sameRemovedCliHooksConfigPath(claudeSettings, claudeSettings, 'linux')).toBe(true)
    expect(sameRemovedCliHooksConfigPath(claudeSettings, claudeSettings.toUpperCase(), 'linux')).toBe(false)
    expect(sameRemovedCliHooksConfigPath(claudeSettings, claudeSettings.toUpperCase(), 'win32')).toBe(true)
    expect(sameRemovedCliHooksConfigPath(claudeSettings, codexConfig, 'win32')).toBe(false)
  })
})

describe('the record in the data directory', () => {
  it('is written by the uninstaller, merged with an earlier one, and read back on the next launch', async () => {
    const dataDirectory = temporaryDirectory()
    await expect(readRemovedCliHooks(dataDirectory)).resolves.toEqual([])
    await rememberRemovedCliHooks(dataDirectory, [{ ...claude, parts: ['hooks'] }])
    await rememberRemovedCliHooks(dataDirectory, [{ ...claude, parts: ['statusLine'] }, codex])
    await expect(readRemovedCliHooks(dataDirectory)).resolves.toEqual([claude, codex])
  })

  it('writes nothing when nothing was taken back', async () => {
    const dataDirectory = temporaryDirectory()
    await rememberRemovedCliHooks(dataDirectory, [])
    expect(fs.existsSync(removedCliHooksRecordPath(dataDirectory))).toBe(false)
  })

  it('does not create a data directory that is not there', async () => {
    const dataDirectory = path.join(temporaryDirectory(), 'never-opened')
    await expect(rememberRemovedCliHooks(dataDirectory, [codex])).rejects.toThrow()
    expect(fs.existsSync(dataDirectory)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('refuses a record that was swapped for a link', async () => {
    const dataDirectory = temporaryDirectory()
    const elsewhere = path.join(temporaryDirectory(), 'elsewhere.json')
    fs.writeFileSync(elsewhere, removedCliHooksContent([codex]), 'utf8')
    fs.symlinkSync(elsewhere, removedCliHooksRecordPath(dataDirectory))
    await expect(readRemovedCliHooks(dataDirectory)).rejects.toThrow()
    await expect(rememberRemovedCliHooks(dataDirectory, [claude])).rejects.toThrow()
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe(removedCliHooksContent([codex]))
  })

  it('keeps what is still owed and goes away once everything is back', async () => {
    const dataDirectory = temporaryDirectory()
    await rememberRemovedCliHooks(dataDirectory, [claude, codex])
    await replaceRemovedCliHooks(dataDirectory, [codex])
    await expect(readRemovedCliHooks(dataDirectory)).resolves.toEqual([codex])
    await replaceRemovedCliHooks(dataDirectory, [])
    expect(fs.existsSync(removedCliHooksRecordPath(dataDirectory))).toBe(false)
    await expect(replaceRemovedCliHooks(dataDirectory, [])).resolves.toBeUndefined()
  })
})

describe('planRemovedCliHooksRestore', () => {
  const base = {
    entry: claude,
    currentConfigPath: claudeSettings,
    present: [] as const,
    hooksWritable: true,
    statusLineWritable: true,
    platform: 'linux' as const,
  }

  it('puts back everything that was taken and is still missing', () => {
    expect(planRemovedCliHooksRestore(base)).toEqual({ restore: ['hooks', 'statusLine'], keep: null })
  })

  it('skips what is already there again, for example after the customer saved the config', () => {
    expect(planRemovedCliHooksRestore({ ...base, present: ['hooks'] })).toEqual({ restore: ['statusLine'], keep: null })
    expect(planRemovedCliHooksRestore({ ...base, present: ['hooks', 'statusLine'] })).toEqual({ restore: [], keep: null })
  })

  it('leaves what cannot be written on this machine yet for the next launch', () => {
    expect(planRemovedCliHooksRestore({ ...base, hooksWritable: false })).toEqual({ restore: ['statusLine'], keep: { ...claude, parts: ['hooks'] } })
    expect(planRemovedCliHooksRestore({ ...base, hooksWritable: false, statusLineWritable: false })).toEqual({ restore: [], keep: claude })
  })

  it('forgets an entry whose file is not the one this launch would write', () => {
    expect(planRemovedCliHooksRestore({ ...base, currentConfigPath: path.resolve('/home/me/elsewhere/settings.json') })).toEqual({ restore: [], keep: null })
  })
})
