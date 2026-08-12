import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasRunStore } from './canvas-run-store'
import type {
  CanvasRunAsset,
  CanvasRunCacheEntry,
  CanvasRunRecord,
} from './canvas-run-contract'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-runs-'))
  roots.push(root)
  const owned = new Map<string, CanvasRunAsset>()
  let uuid = 0
  const store = new CanvasRunStore({
    rootDirectory: root,
    assets: {
      readOwned: async (_userId, assetId) => {
        const asset = owned.get(assetId)
        if (!asset) throw new Error('missing')
        const { kind: _kind, ...stored } = asset
        return { asset: stored }
      },
    },
    runRetention: 2,
    cacheRetention: 2,
    assetRetention: 2,
    now: () => new Date('2026-08-13T01:00:00.000Z'),
    randomUUID: () => `backup-${++uuid}`,
  })
  return { root, owned, store }
}

function record(runId: string, status: CanvasRunRecord['status'] = 'succeeded'): CanvasRunRecord {
  return {
    version: 1,
    userId: 7,
    ownerId: 9,
    runId,
    graphRevision: 'revision',
    scope: { kind: 'all' },
    status,
    createdAt: '2026-08-13T00:00:00.000Z',
    startedAt: '2026-08-13T00:00:00.000Z',
    ...(status !== 'running' ? { completedAt: '2026-08-13T00:00:01.000Z', durationMs: 1_000 } : {}),
    nodes: [{ nodeId: 'node', kind: 'text', state: status === 'running' ? 'running' : 'succeeded', attempts: [] }],
    events: [],
  }
}

function asset(idCharacter: string): CanvasRunAsset {
  const assetId = idCharacter.repeat(43)
  return { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' }
}

function cacheEntry(fingerprintCharacter: string, storedAsset: CanvasRunAsset): CanvasRunCacheEntry {
  return {
    version: 1,
    fingerprint: fingerprintCharacter.repeat(64),
    nodeKind: 'image',
    candidate: {
      candidateId: `candidate-${fingerprintCharacter}`,
      attemptId: `attempt-${fingerprintCharacter}`,
      createdAt: '2026-08-13T00:00:00.000Z',
      asset: storedAsset,
    },
    createdAt: '2026-08-13T00:00:00.000Z',
    lastUsedAt: '2026-08-13T00:00:00.000Z',
  }
}

describe('CanvasRunStore', () => {
  it('keeps bounded newest-first history and isolates users', async () => {
    const { store } = fixture()
    await store.saveRun(7, record('run-1'))
    await store.saveRun(7, record('run-2'))
    await store.saveRun(7, record('run-3'))
    expect((await store.listRuns(7)).map((run) => run.runId)).toEqual(['run-3', 'run-2'])
    expect(await store.listRuns(8)).toEqual([])
    expect(await store.getRun(8, 'run-3')).toBeNull()
  })

  it('recovers nonterminal runs as interrupted without replaying them', async () => {
    const { store } = fixture()
    await store.saveRun(7, record('running', 'running'))
    const recovered = await store.initializeUser(7)
    expect(recovered[0]).toMatchObject({ status: 'interrupted', completedAt: '2026-08-13T01:00:00.000Z' })
    expect(recovered[0].nodes[0]).toMatchObject({ state: 'interrupted' })
    expect(recovered[0].nodes[0].errorMessage).toContain('未自动重试')
  })

  it('backs up corrupt state and degrades to an empty history', async () => {
    const { root, store } = fixture()
    await store.saveRun(7, record('valid'))
    const filePath = path.join(root, 'user-7', 'canvas-runtime.json')
    fs.writeFileSync(filePath, '{invalid', 'utf8')
    expect(await store.listRuns(7)).toEqual([])
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.corrupt-'))).toBe(true)
  })

  it('accepts cache only while its asset remains owned by the same user', async () => {
    const { owned, store } = fixture()
    const storedAsset = asset('a')
    owned.set(storedAsset.assetId, storedAsset)
    const entry = cacheEntry('b', storedAsset)
    await store.storeCache(7, entry)
    await expect(store.resolveCache(8, entry.fingerprint)).resolves.toBeNull()
    await expect(store.resolveCache(7, entry.fingerprint)).resolves.toMatchObject({ fingerprint: entry.fingerprint })
    owned.delete(storedAsset.assetId)
    await expect(store.resolveCache(7, entry.fingerprint)).resolves.toBeNull()
  })

  it('reconciles missing assets out of both manifest and cache', async () => {
    const { owned, store } = fixture()
    const first = asset('a')
    const second = asset('b')
    owned.set(first.assetId, first)
    owned.set(second.assetId, second)
    await store.storeCache(7, cacheEntry('a', first))
    await store.storeCache(7, cacheEntry('b', second))
    owned.delete(first.assetId)
    expect((await store.reconcileAssets(7)).map((entry) => entry.asset.assetId)).toEqual([second.assetId])
    await expect(store.resolveCache(7, 'a'.repeat(64))).resolves.toBeNull()
    await expect(store.resolveCache(7, 'b'.repeat(64))).resolves.toBeTruthy()
  })

  it('rejects secrets, remote URLs and absolute paths before persistence', async () => {
    const { store } = fixture()
    const secret = record('secret')
    secret.nodes[0].errorMessage = 'Bearer token-value https://example.test C:\\Users\\person\\key.txt'
    await expect(store.saveRun(7, secret)).rejects.toThrow(/密钥|地址|路径/)
  })
})
