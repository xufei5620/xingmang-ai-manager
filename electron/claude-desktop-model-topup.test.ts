import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeDesktopModelTopUpRecord, runClaudeDesktopModelTopUp, type ClaudeDesktopModelTopUpOptions } from './claude-desktop-model-topup'

const temporaryDirectories: string[] = []
const configId = '6f1c2e8a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const apiKey = 'sk-claude-desktop-top-up'

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(overrides: Partial<ClaudeDesktopModelTopUpOptions> = {}) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-desktop-top-up-'))
  temporaryDirectories.push(dataDirectory)
  const menu = [...(overrides.menu?.models ?? ['claude-opus-5'])]
  const probe = vi.fn(async (_model: string) => true)
  const add = vi.fn(async (models: readonly string[]) => {
    const added = models.filter((model) => !menu.includes(model))
    menu.splice(1, 0, ...added)
    return added
  })
  const options: ClaudeDesktopModelTopUpOptions = {
    dataDirectory,
    menu: { id: configId, models: menu, apiKey },
    offered: ['claude-opus-5', 'claude-sonnet-5', 'gpt-6-astra'],
    probe,
    add,
    ...overrides,
  }
  const recordPath = path.join(dataDirectory, 'external-clients', 'claude-desktop-models', `${configId}.json`)
  return { dataDirectory, menu, probe, add, options, recordPath, run: (next: Partial<ClaudeDesktopModelTopUpOptions> = {}) => runClaudeDesktopModelTopUp({ ...options, menu: { id: configId, models: [...menu], apiKey }, ...next }) }
}

describe('Claude Desktop model menu top-up', () => {
  it('catches an old menu up like a save would the first time, then adds only what the account newly lists', async () => {
    const f = fixture()
    expect(await f.run()).toEqual({ added: ['claude-sonnet-5'], rejected: [], overflow: [] })
    expect(f.menu).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(f.probe.mock.calls.map(([model]) => model)).toEqual(['claude-sonnet-5'])

    // 下次开机没有新上的：一个都不试，也不写菜单。
    f.probe.mockClear()
    f.add.mockClear()
    expect(await f.run()).toEqual({ added: [], rejected: [], overflow: [] })
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.add).not.toHaveBeenCalled()

    // 账号上了 Opus 5.5：只试它。
    expect(await f.run({ offered: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5'] })).toEqual({ added: ['claude-opus-5-5'], rejected: [], overflow: [] })
    expect(f.probe.mock.calls.map(([model]) => model)).toEqual(['claude-opus-5-5'])
    expect(f.menu).toEqual(['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5'])
  })

  it('does not put back a model the customer took out of the menu', async () => {
    const f = fixture()
    await f.run()
    f.menu.splice(1)
    f.probe.mockClear()
    expect(await f.run()).toEqual({ added: [], rejected: [], overflow: [] })
    expect(f.probe).not.toHaveBeenCalled()
  })

  // 0.2.12 的教训：没试通的不进菜单。刚上的型号渠道常常还不稳，不记下来，下次开机再试。
  it('leaves out a model that does not answer and tries it again next time', async () => {
    const f = fixture()
    f.probe.mockImplementation(async (model) => model !== 'claude-sonnet-5')
    expect(await f.run()).toEqual({ added: [], rejected: ['claude-sonnet-5'], overflow: [] })
    expect(f.add).not.toHaveBeenCalled()
    expect(f.menu).toEqual(['claude-opus-5'])

    f.probe.mockImplementation(async () => true)
    expect(await f.run()).toEqual({ added: ['claude-sonnet-5'], rejected: [], overflow: [] })
  })

  it('fills a nearly full menu up to twelve and remembers the rest so it does not try them again', async () => {
    const existing = Array.from({ length: 11 }, (_value, index) => `claude-sonnet-4-${index}`)
    const f = fixture({ menu: { id: configId, models: existing, apiKey } })
    const offered = [...existing, 'claude-opus-5-5', 'claude-opus-5']
    expect(await f.run({ offered })).toEqual({ added: ['claude-opus-5-5'], rejected: [], overflow: ['claude-opus-5'] })
    expect(f.add).toHaveBeenCalledWith(['claude-opus-5-5'])
    expect(f.menu).toHaveLength(12)
    f.probe.mockClear()
    f.menu.splice(11)
    expect(await f.run({ offered })).toEqual({ added: [], rejected: [], overflow: [] })
    expect(f.probe).not.toHaveBeenCalled()
  })

  it('does not record anything when the menu could not be written, so the next start tries again', async () => {
    const f = fixture()
    f.add.mockRejectedValueOnce(new Error('Claude Desktop 已经打开了，这次不补型号'))
    await expect(f.run()).rejects.toThrow('已经打开了')
    expect(fs.existsSync(f.recordPath)).toBe(false)
    expect(await f.run()).toEqual({ added: ['claude-sonnet-5'], rejected: [], overflow: [] })
  })

  it('keeps the record per key and only as a digest', async () => {
    const f = fixture()
    await f.run()
    const record = fs.readFileSync(f.recordPath, 'utf8')
    expect(record).not.toContain(apiKey)
    expect(parseClaudeDesktopModelTopUpRecord(record, apiKey)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    // 换了一把 Key，上一把的记录不算：照保存的挑法重新看一遍。
    expect(parseClaudeDesktopModelTopUpRecord(record, 'sk-another-key')).toBeNull()
    f.menu.splice(1)
    f.probe.mockClear()
    expect(await f.run({ menu: { id: configId, models: ['claude-opus-5'], apiKey: 'sk-another-key' } })).toMatchObject({ added: ['claude-sonnet-5'] })
  })

  it('does not rewrite an unchanged record', async () => {
    const f = fixture()
    await f.run()
    const stamp = fs.statSync(f.recordPath).mtimeMs
    fs.utimesSync(f.recordPath, new Date(stamp - 60_000), new Date(stamp - 60_000))
    const before = fs.statSync(f.recordPath).mtimeMs
    await f.run()
    expect(fs.statSync(f.recordPath).mtimeMs).toBe(before)
  })

  it('treats a damaged or foreign record as missing', async () => {
    expect(parseClaudeDesktopModelTopUpRecord(null, apiKey)).toBeNull()
    expect(parseClaudeDesktopModelTopUpRecord('{', apiKey)).toBeNull()
    expect(parseClaudeDesktopModelTopUpRecord('[]', apiKey)).toBeNull()
    expect(parseClaudeDesktopModelTopUpRecord(JSON.stringify({ version: 2, models: [] }), apiKey)).toBeNull()
    const f = fixture()
    await f.run()
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8')) as Record<string, unknown>
    expect(parseClaudeDesktopModelTopUpRecord(JSON.stringify({ ...record, models: ['claude sonnet "5"'] }), apiKey)).toBeNull()
    expect(parseClaudeDesktopModelTopUpRecord(JSON.stringify({ ...record, models: 'claude-opus-5' }), apiKey)).toBeNull()
  })

  it('refuses a config id that is not a library UUID before touching the disk', async () => {
    const f = fixture()
    await expect(f.run({ menu: { id: '../../escape', models: ['claude-opus-5'], apiKey } })).rejects.toThrow('配置编号无效')
    expect(f.probe).not.toHaveBeenCalled()
    expect(fs.readdirSync(f.dataDirectory)).toEqual([])
  })
})
