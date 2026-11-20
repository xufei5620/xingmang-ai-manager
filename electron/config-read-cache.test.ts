import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configPathStamp,
  createConfigReadCache,
  currentToolConfigRevision,
  noteToolConfigWrite,
  type RecordedConfigRead,
  trackToolConfigWrite,
} from './config-read-cache'
import { inspectProviderConfig, withRecordedConfigReads } from './config-files'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-read-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

function fixture(initial: Record<string, string | null> = {}) {
  const stamps = new Map<string, string | null>(Object.entries(initial))
  let time = 1000
  let revision = 0
  const cache = createConfigReadCache<number>({
    maxAgeMs: 3000,
    now: () => time,
    revision: () => revision,
    stamp: (filePath) => stamps.has(filePath) ? stamps.get(filePath) ?? null : 'missing',
  })
  let loads = 0
  function load(recorded: Record<string, string | null> = {}): () => RecordedConfigRead<number> {
    return () => {
      loads += 1
      return { value: loads, stamps: new Map(Object.entries(recorded)) }
    }
  }
  return {
    cache,
    load,
    loads: () => loads,
    advance: (ms: number) => { time += ms },
    bump: () => { revision += 1 },
    stamp: (filePath: string, value: string | null) => { stamps.set(filePath, value) },
  }
}

describe('createConfigReadCache', () => {
  it('reuses the last read while the key, revision and every stamp are unchanged', () => {
    const f = fixture({ '/home/.codex': 'dir-1', '/home/.codex/config.toml': 'file-1' })
    expect(f.cache.read('k', ['/home/.codex'], f.load({ '/home/.codex/config.toml': 'file-1' }))).toBe(1)
    f.advance(2999)
    expect(f.cache.read('k', ['/home/.codex'], f.load({ '/home/.codex/config.toml': 'file-1' }))).toBe(1)
    expect(f.loads()).toBe(1)
  })

  it('reads again once the window is over or the clock went backwards', () => {
    const f = fixture()
    f.cache.read('k', [], f.load())
    f.advance(3000)
    expect(f.cache.read('k', [], f.load())).toBe(2)
    f.advance(-10)
    expect(f.cache.read('k', [], f.load())).toBe(3)
  })

  it('reads again for another key', () => {
    const f = fixture()
    f.cache.read('owner-a', [], f.load())
    expect(f.cache.read('owner-b', [], f.load())).toBe(2)
    expect(f.cache.read('owner-a', [], f.load())).toBe(3)
  })

  it('reads again after Xingmang wrote a tool config', () => {
    const f = fixture()
    f.cache.read('k', [], f.load())
    f.bump()
    expect(f.cache.read('k', [], f.load())).toBe(2)
  })

  it('reads again when a watched path or a file read last time changed', () => {
    const f = fixture({ '/home/.grok': 'dir-1', '/home/.grok/auth.json': 'auth-1' })
    f.cache.read('k', ['/home/.grok'], f.load({ '/home/.grok/auth.json': 'auth-1' }))
    f.stamp('/home/.grok', 'dir-2')
    expect(f.cache.read('k', ['/home/.grok'], f.load({ '/home/.grok/auth.json': 'auth-1' }))).toBe(2)
    f.stamp('/home/.grok/auth.json', 'auth-2')
    expect(f.cache.read('k', ['/home/.grok'], f.load({ '/home/.grok/auth.json': 'auth-2' }))).toBe(3)
    expect(f.cache.read('k', ['/home/.grok'], f.load({ '/home/.grok/auth.json': 'auth-2' }))).toBe(3)
  })

  it('keeps nothing when a stamp cannot be taken', () => {
    const f = fixture({ '/home/.claude': null })
    f.cache.read('k', ['/home/.claude'], f.load())
    expect(f.cache.read('k', ['/home/.claude'], f.load())).toBe(2)
    f.stamp('/home/.claude', 'dir-1')
    f.cache.read('k', ['/home/.claude'], f.load({ '/home/.claude/settings.json': null }))
    expect(f.cache.read('k', ['/home/.claude'], f.load())).toBe(4)
  })

  it('always reads when the window is zero, without taking stamps', () => {
    const stamp = vi.fn(() => 'same')
    const cache = createConfigReadCache<number>({ maxAgeMs: 0, stamp })
    let loads = 0
    const load = () => ({ value: ++loads, stamps: new Map<string, string | null>() })
    cache.read('k', ['/home/.codex'], load)
    expect(cache.read('k', ['/home/.codex'], load)).toBe(2)
    expect(stamp).not.toHaveBeenCalled()
  })

  it('forgets the last read on demand', () => {
    const f = fixture()
    f.cache.read('k', [], f.load())
    f.cache.forget()
    expect(f.cache.read('k', [], f.load())).toBe(2)
  })

  it('never serves contents older than the last change it can see, with random inputs', () => {
    // Model: one config file whose contents version goes up on every change. Xingmang's own writes bump
    // the revision; outside changes only show in the file's stamp. Either way the next read must see it.
    fc.assert(fc.property(fc.array(fc.oneof(
      fc.constant({ kind: 'read' as const }),
      fc.constant({ kind: 'internal-write' as const }),
      fc.constant({ kind: 'external-write' as const }),
      fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 5000 }) }),
    ), { maxLength: 40 }), (steps) => {
      let contents = 0
      let stampSeed = 0
      let time = 0
      let revision = 0
      const filePath = '/home/.codex/config.toml'
      const cache = createConfigReadCache<number>({
        maxAgeMs: 3000,
        now: () => time,
        revision: () => revision,
        stamp: () => `stamp-${stampSeed}`,
      })
      const load = (): RecordedConfigRead<number> => ({ value: contents, stamps: new Map([[filePath, `stamp-${stampSeed}`]]) })
      for (const step of steps) {
        if (step.kind === 'read') expect(cache.read('k', [], load)).toBe(contents)
        if (step.kind === 'internal-write') { revision += 1; contents += 1 }
        if (step.kind === 'external-write') { stampSeed += 1; contents += 1 }
        if (step.kind === 'advance') time += step.ms
      }
    }))
  })
})

describe('tool config revision', () => {
  it('counts before and after an asynchronous write, even when it fails', async () => {
    const start = currentToolConfigRevision()
    let during = -1
    await expect(trackToolConfigWrite(async () => {
      during = currentToolConfigRevision()
      throw new Error('写不进去')
    })).rejects.toThrow('写不进去')
    expect(during).toBe(start + 1)
    expect(currentToolConfigRevision()).toBe(start + 2)
    noteToolConfigWrite()
    expect(currentToolConfigRevision()).toBe(start + 3)
  })
})

describe('configPathStamp', () => {
  it('tells a missing path, an in-place edit and a replaced file apart', () => {
    const directory = temporaryDirectory()
    const filePath = path.join(directory, 'config.toml')
    expect(configPathStamp(filePath)).toBe('missing')
    fs.writeFileSync(filePath, 'model = "a"\n')
    const written = configPathStamp(filePath)
    expect(written).not.toBe('missing')
    fs.writeFileSync(filePath, 'model = "a longer name"\n')
    const edited = configPathStamp(filePath)
    expect(edited).not.toBe(written)
    const replacement = path.join(directory, 'config.toml.tmp')
    fs.writeFileSync(replacement, 'model = "a longer name"\n')
    fs.renameSync(replacement, filePath)
    expect(configPathStamp(filePath)).not.toBe(edited)
  })
})

describe('withRecordedConfigReads', () => {
  it('hands back how every file looked before it was read', () => {
    const root = temporaryDirectory()
    const roots = { userHome: root, codexHome: path.join(root, '.codex') }
    fs.mkdirSync(roots.codexHome)
    const configPath = path.join(roots.codexHome, 'config.toml')
    fs.writeFileSync(configPath, 'model = "gpt-5.6-sol"\n')
    const before = configPathStamp(configPath)
    const { value, stamps } = withRecordedConfigReads(() => inspectProviderConfig('codex', roots))
    expect(value.model).toBe('gpt-5.6-sol')
    expect(stamps.get(configPath)).toBe(before)
    expect(stamps.get(path.join(roots.codexHome, 'auth.json'))).toBe('missing')
  })

  it('records nothing outside a read pass', () => {
    const root = temporaryDirectory()
    const roots = { userHome: root, codexHome: path.join(root, '.codex') }
    expect(withRecordedConfigReads(() => 1).stamps.size).toBe(0)
    inspectProviderConfig('codex', roots)
    expect(withRecordedConfigReads(() => 2).stamps.size).toBe(0)
  })
})
