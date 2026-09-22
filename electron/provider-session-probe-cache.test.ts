import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ProviderSessionProbeCacheWarning,
  ProviderSessionProbeEntry,
  ProviderSessionProbeState,
} from './provider-session-probe-cache'
import {
  PROBE_CACHE_VERSION,
  ProviderSessionProbeCache,
  parseProbeCacheDocument,
  parseProbeState,
  serializeProbeCache,
} from './provider-session-probe-cache'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-probe-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

function probeState(overrides: Partial<ProviderSessionProbeState> = {}): ProviderSessionProbeState {
  return {
    nativeId: 'native-1',
    title: '会话标题',
    cwd: 'C:/work/app',
    model: 'claude-sonnet',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    messageCount: 12,
    firstUserText: '第一句提问',
    ...overrides,
  }
}

function entry(
  fingerprint: string,
  overrides: Partial<ProviderSessionProbeState> = {},
  scope = 'claude',
): ProviderSessionProbeEntry {
  return { scope, fingerprint, state: probeState(overrides) }
}

function storedDocument(filePath: string): { version: unknown; entries: unknown[] } {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version: unknown; entries: unknown[] }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true })
  }
})

describe('parseProbeState', () => {
  it('accepts a complete state and keeps null timestamps', () => {
    expect(parseProbeState({ ...probeState(), createdAt: null, messageCount: null })).toMatchObject({
      createdAt: null,
      messageCount: null,
      title: '会话标题',
    })
  })

  it('rejects a state whose fields carry the wrong type', () => {
    expect(parseProbeState({ ...probeState(), title: 42 })).toBeNull()
    expect(parseProbeState({ ...probeState(), createdAt: '2026-09-22' })).toBeNull()
    expect(parseProbeState({ ...probeState(), messageCount: Number.NaN })).toBeNull()
    expect(parseProbeState(null)).toBeNull()
    expect(parseProbeState([probeState()])).toBeNull()
  })

  it('truncates a hand-edited title instead of handing it to the list', () => {
    const parsed = parseProbeState({ ...probeState(), title: 'x'.repeat(9000) })
    expect(parsed?.title.length).toBe(2048)
  })
})

describe('parseProbeCacheDocument', () => {
  it('rebuilds the map in the stored order', () => {
    const content = serializeProbeCache(new Map([
      ['/a.jsonl', entry('1:1:1')],
      ['/b.jsonl', entry('2:2:2')],
    ]))
    expect([...(parseProbeCacheDocument(content, 10) as Map<string, ProviderSessionProbeEntry>).keys()])
      .toEqual(['/a.jsonl', '/b.jsonl'])
  })

  it('discards the whole document when the version does not match', () => {
    const content = JSON.stringify({
      version: PROBE_CACHE_VERSION + 1,
      entries: [{ key: '/a.jsonl', scope: 'claude', fingerprint: '1:1:1', state: probeState() }],
    })
    expect(parseProbeCacheDocument(content, 10)).toBeNull()
  })

  it('discards the whole document when it is not usable JSON', () => {
    expect(parseProbeCacheDocument('{damaged', 10)).toBeNull()
    expect(parseProbeCacheDocument('[]', 10)).toBeNull()
    expect(parseProbeCacheDocument(JSON.stringify({ version: PROBE_CACHE_VERSION }), 10)).toBeNull()
  })

  it('drops only the malformed entries so one bad line costs one re-probe', () => {
    const content = JSON.stringify({
      version: PROBE_CACHE_VERSION,
      entries: [
        { key: '/a.jsonl', scope: 'claude', fingerprint: '1:1:1', state: probeState() },
        { key: '', scope: 'claude', fingerprint: '2:2:2', state: probeState() },
        { key: '/c.jsonl', scope: 'claude', fingerprint: '', state: probeState() },
        { key: '/d.jsonl', scope: 'claude', fingerprint: '4:4:4', state: { title: '缺字段' } },
        { key: '/e.jsonl', scope: 'claude', fingerprint: 'x'.repeat(300), state: probeState() },
        { key: '/g.jsonl', fingerprint: '7:7:7', state: probeState() },
        { key: '/f.jsonl', scope: 'claude', fingerprint: '6:6:6', state: probeState({ title: '保留' }) },
      ],
    })
    const parsed = parseProbeCacheDocument(content, 10) as Map<string, ProviderSessionProbeEntry>
    expect([...parsed.keys()]).toEqual(['/a.jsonl', '/f.jsonl'])
  })

  it('keeps the newest entries when the stored file exceeds the entry cap', () => {
    const entries = new Map<string, ProviderSessionProbeEntry>()
    for (let index = 0; index < 5; index += 1) entries.set(`/file-${index}.jsonl`, entry(`${index}:${index}:${index}`))
    const parsed = parseProbeCacheDocument(serializeProbeCache(entries), 2) as Map<string, ProviderSessionProbeEntry>
    expect([...parsed.keys()]).toEqual(['/file-3.jsonl', '/file-4.jsonl'])
  })
})

describe('serializeProbeCache', () => {
  it('drops the oldest entries when the byte budget is exhausted', () => {
    const entries = new Map<string, ProviderSessionProbeEntry>()
    for (let index = 0; index < 20; index += 1) entries.set(`/file-${index}.jsonl`, entry(`${index}:${index}:${index}`))
    const encoded = serializeProbeCache(entries, 700)
    const parsed = parseProbeCacheDocument(encoded, 100) as Map<string, ProviderSessionProbeEntry>
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(700 + 64)
    expect(parsed.size).toBeGreaterThan(0)
    expect(parsed.size).toBeLessThan(20)
    expect([...parsed.keys()].at(-1)).toBe('/file-19.jsonl')
  })
})

describe('ProviderSessionProbeCache', () => {
  it('stays memory-only and writes nothing when no file is configured', async () => {
    const directory = temporaryDirectory()
    const cache = new ProviderSessionProbeCache()
    await cache.ready()
    cache.set('/a.jsonl', entry('1:1:1'))
    await cache.persist()
    expect(fs.readdirSync(directory)).toEqual([])
    expect(cache.get('/a.jsonl')?.fingerprint).toBe('1:1:1')
  })

  it('hands a second instance the entries the first one persisted', async () => {
    const filePath = path.join(temporaryDirectory(), 'sessions', 'probe-cache.json')
    const first = new ProviderSessionProbeCache({ filePath })
    await first.ready()
    first.set('/a.jsonl', entry('1:1:1', { title: '落盘过的标题' }))
    await first.persist()

    const second = new ProviderSessionProbeCache({ filePath })
    await second.ready()
    expect(second.get('/a.jsonl')?.state.title).toBe('落盘过的标题')
    expect(second.size).toBe(1)
  })

  it('evicts the least recently used entry and keeps the touched one', async () => {
    const filePath = path.join(temporaryDirectory(), 'probe-cache.json')
    const cache = new ProviderSessionProbeCache({ filePath, maxEntries: 2 })
    await cache.ready()
    cache.set('/a.jsonl', entry('1:1:1'))
    cache.set('/b.jsonl', entry('2:2:2'))
    cache.get('/a.jsonl')
    cache.set('/c.jsonl', entry('3:3:3'))
    expect(cache.keys()).toEqual(['/a.jsonl', '/c.jsonl'])
    await cache.persist()
    expect(storedDocument(filePath).entries).toHaveLength(2)
  })

  it('prunes only the entries of the swept scope that were not seen again', async () => {
    const cache = new ProviderSessionProbeCache()
    await cache.ready()
    cache.set('/claude-kept.jsonl', entry('1:1:1'))
    cache.set('/claude-gone.jsonl', entry('2:2:2'))
    cache.set('/gemini-untouched.json', entry('3:3:3', {}, 'gemini'))

    cache.pruneScope('claude', new Set(['/claude-kept.jsonl']))

    expect(cache.keys()).toEqual(['/claude-kept.jsonl', '/gemini-untouched.json'])
  })

  it('forgets a deleted entry and leaves it out of the next write', async () => {
    const filePath = path.join(temporaryDirectory(), 'probe-cache.json')
    const cache = new ProviderSessionProbeCache({ filePath })
    await cache.ready()
    cache.set('/a.jsonl', entry('1:1:1'))
    cache.set('/b.jsonl', entry('2:2:2'))
    await cache.persist()
    cache.delete('/a.jsonl')
    await cache.persist()

    const reloaded = new ProviderSessionProbeCache({ filePath })
    await reloaded.ready()
    expect(reloaded.keys()).toEqual(['/b.jsonl'])
  })

  it('rebuilds silently when the stored file was written by another version', async () => {
    const directory = temporaryDirectory()
    const filePath = path.join(directory, 'probe-cache.json')
    fs.writeFileSync(filePath, JSON.stringify({
      version: PROBE_CACHE_VERSION + 1,
      entries: [{ key: '/a.jsonl', scope: 'claude', fingerprint: '1:1:1', state: probeState() }],
    }), 'utf8')
    const warnings: ProviderSessionProbeCacheWarning[] = []
    const cache = new ProviderSessionProbeCache({ filePath, onWarning: (warning) => warnings.push(warning) })
    await cache.ready()

    expect(cache.size).toBe(0)
    expect(warnings.map((warning) => warning.code)).toEqual(['probe-cache-discarded'])
    await cache.persist()
    expect(storedDocument(filePath)).toMatchObject({ version: PROBE_CACHE_VERSION, entries: [] })
  })

  it('rebuilds silently when the stored file is damaged', async () => {
    const filePath = path.join(temporaryDirectory(), 'probe-cache.json')
    fs.writeFileSync(filePath, '{"version":1,"entries":[', 'utf8')
    const warnings: ProviderSessionProbeCacheWarning[] = []
    const cache = new ProviderSessionProbeCache({ filePath, onWarning: (warning) => warnings.push(warning) })
    await cache.ready()
    cache.set('/a.jsonl', entry('1:1:1'))
    await cache.persist()

    expect(warnings.map((warning) => warning.code)).toEqual(['probe-cache-discarded'])
    const reloaded = new ProviderSessionProbeCache({ filePath })
    await reloaded.ready()
    expect(reloaded.keys()).toEqual(['/a.jsonl'])
  })

  it('reports a read failure without losing the in-memory cache', async () => {
    const directory = temporaryDirectory()
    const blocked = path.join(directory, 'blocked')
    fs.writeFileSync(blocked, 'not a directory', 'utf8')
    const warnings: ProviderSessionProbeCacheWarning[] = []
    const cache = new ProviderSessionProbeCache({
      filePath: path.join(blocked, 'probe-cache.json'),
      onWarning: (warning) => warnings.push(warning),
    })
    await cache.ready()
    cache.set('/a.jsonl', entry('1:1:1'))

    expect(warnings.map((warning) => warning.code)).toEqual(['probe-cache-read-failed'])
    expect(cache.get('/a.jsonl')?.fingerprint).toBe('1:1:1')
  })

  it('reports a write failure instead of throwing at the caller', async () => {
    const directory = temporaryDirectory()
    const blocked = path.join(directory, 'blocked')
    fs.writeFileSync(blocked, 'not a directory', 'utf8')
    const warnings: ProviderSessionProbeCacheWarning[] = []
    const cache = new ProviderSessionProbeCache({
      filePath: path.join(blocked, 'probe-cache.json'),
      onWarning: (warning) => warnings.push(warning),
    })
    await cache.ready()
    cache.set('/a.jsonl', entry('1:1:1'))
    await expect(cache.persist()).resolves.toBeUndefined()

    expect(warnings.map((warning) => warning.code)).toEqual(['probe-cache-read-failed', 'probe-cache-write-failed'])
  })

  it('writes nothing more once the cache is clean again', async () => {
    const filePath = path.join(temporaryDirectory(), 'probe-cache.json')
    const cache = new ProviderSessionProbeCache({ filePath })
    await cache.ready()
    cache.set('/a.jsonl', entry('1:1:1'))
    await cache.persist()
    const firstWrite = fs.statSync(filePath).mtimeMs

    cache.get('/a.jsonl')
    await cache.persist()
    expect(fs.statSync(filePath).mtimeMs).toBe(firstWrite)
  })
})
