import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCliModelHintsStore, parseStoredCliModelHints, resolveCliModelHints } from './cli-model-hints-store'
import { createServiceStatusMonitor, emptyServiceStatus, type ServiceStatus } from './service-status'

const directories: string[] = []

function temporaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-model-hints-'))
  directories.push(directory)
  return path.join(directory, 'cli-model-hints.json')
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

// 键和字段的先后照状态文件解析出来的那样（service-status.ts 的 readCliModels）。
const table = {
  claude: { retired: ['claude-opus-5'] },
  codex: { default: 'gpt-7', previous: ['gpt-6-astra'], retired: ['gpt-5.5'] },
}

describe('cli model hints store', () => {
  it('reads nothing on a machine that never remembered a status file', () => {
    expect(createCliModelHintsStore({ filePath: temporaryFile() }).read()).toBeNull()
  })

  it('reads the remembered model table back from a fresh store', async () => {
    const filePath = temporaryFile()
    await createCliModelHintsStore({ filePath }).write(table)
    expect(createCliModelHintsStore({ filePath }).read()).toEqual(table)
  })

  it('remembers that the status file stopped carrying a model table', async () => {
    const filePath = temporaryFile()
    const store = createCliModelHintsStore({ filePath })
    await store.write(table)
    await store.write(null)
    expect(fs.existsSync(filePath)).toBe(true)
    expect(createCliModelHintsStore({ filePath }).read()).toBeNull()
  })

  it('keeps the later of two writes issued back to back', async () => {
    const filePath = temporaryFile()
    const store = createCliModelHintsStore({ filePath })
    await Promise.all([
      store.write(table),
      store.write({ grok: { default: 'grok-5' } }),
    ])
    expect(createCliModelHintsStore({ filePath }).read()).toEqual({ grok: { default: 'grok-5' } })
  })

  it('leaves the disk alone when the table has not changed since it was read or written', async () => {
    const filePath = temporaryFile()
    await createCliModelHintsStore({ filePath }).write(table)
    const store = createCliModelHintsStore({ filePath })
    expect(store.read()).toEqual(table)
    fs.rmSync(filePath)
    await store.write(structuredClone(table))
    expect(fs.existsSync(filePath)).toBe(false)
    await store.write({ claude: { retired: ['claude-opus-5', 'claude-opus-5-5'] } })
    await store.write({ claude: { retired: ['claude-opus-5', 'claude-opus-5-5'] } })
    expect(createCliModelHintsStore({ filePath }).read()).toEqual({ claude: { retired: ['claude-opus-5', 'claude-opus-5-5'] } })
  })

  it('writes the same table again after a write that did not land', async () => {
    const parent = path.dirname(temporaryFile())
    const filePath = path.join(parent, 'blocked', 'cli-model-hints.json')
    fs.writeFileSync(path.dirname(filePath), 'not a directory')
    const store = createCliModelHintsStore({ filePath })
    await expect(store.write(table)).rejects.toThrow()
    fs.rmSync(path.dirname(filePath))
    await store.write(table)
    expect(createCliModelHintsStore({ filePath }).read()).toEqual(table)
  })

  it('rewrites a damaged record on the next successful read', async () => {
    const filePath = temporaryFile()
    fs.writeFileSync(filePath, 'not json')
    const store = createCliModelHintsStore({ filePath })
    expect(store.read()).toBeNull()
    await store.write(null)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"version":1,"cliModels":null}\n')
  })

  it('treats a damaged or foreign record as never remembered', () => {
    expect(parseStoredCliModelHints('not json')).toBeNull()
    expect(parseStoredCliModelHints('[]')).toBeNull()
    expect(parseStoredCliModelHints(JSON.stringify({ cliModels: table }))).toBeNull()
    expect(parseStoredCliModelHints(JSON.stringify({ version: 2, cliModels: table }))).toBeNull()
  })

  it('revalidates every entry the way the status file is read', () => {
    expect(parseStoredCliModelHints(JSON.stringify({
      version: 1,
      cliModels: {
        codex: { default: 'gpt 7', previous: ['gpt-6-astra', '"x"', 3], retired: 'gpt-5.5' },
        gemini: { default: 'gemini-9' },
        grok: { default: '../grok' },
        claude: { retired: ['claude-opus-5', 'claude-opus-5'] },
      },
    }))).toEqual({ claude: { retired: ['claude-opus-5'] }, codex: { previous: ['gpt-6-astra'] } })
  })

  it('reads an oversized record as never remembered', () => {
    const filePath = temporaryFile()
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, cliModels: table, padding: 'x'.repeat(64 * 1024) }))
    expect(createCliModelHintsStore({ filePath }).read()).toBeNull()
  })

  it('refuses a relative path', () => {
    expect(() => createCliModelHintsStore({ filePath: 'cli-model-hints.json' })).toThrow('绝对路径')
  })
})

describe('cli model hints at launch', () => {
  it('uses the remembered table until the status file has been read once this launch', async () => {
    const reads: Array<ServiceStatus | null> = [null, { ...emptyServiceStatus, cliModels: { grok: { default: 'grok-5' } } }, null, emptyServiceStatus]
    const monitor = createServiceStatusMonitor({ read: async () => reads.shift() ?? null, onChange: () => undefined })
    await monitor.refresh()
    expect(resolveCliModelHints(monitor.lastKnown(), table)).toEqual(table)
    await monitor.refresh()
    expect(resolveCliModelHints(monitor.lastKnown(), table)).toEqual({ grok: { default: 'grok-5' } })
    await monitor.refresh()
    expect(resolveCliModelHints(monitor.lastKnown(), table)).toEqual({ grok: { default: 'grok-5' } })
    await monitor.refresh()
    expect(resolveCliModelHints(monitor.lastKnown(), table)).toBeNull()
    monitor.dispose()
  })

  it('falls back to the bundled table on a machine that never read a status file', () => {
    expect(resolveCliModelHints(null, null)).toBeNull()
  })
})
