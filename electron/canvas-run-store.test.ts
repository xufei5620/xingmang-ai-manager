import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('evicts the oldest history to stay within the byte budget instead of failing every later save', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-runs-'))
    roots.push(root)
    const store = new CanvasRunStore({
      rootDirectory: root,
      assets: { readOwned: async () => { throw new Error('missing') } },
      maximumBytes: 64 * 1024,
    })
    const longText = '长'.repeat(5_000)
    function longRecord(runId: string, status: CanvasRunRecord['status'] = 'succeeded'): CanvasRunRecord {
      const base = record(runId, status)
      return {
        ...base,
        nodes: [{
          ...base.nodes[0],
          attempts: [{
            attemptId: `attempt-${runId}`,
            fingerprint: 'f'.repeat(64),
            state: 'succeeded',
            startedAt: '2026-08-13T00:00:00.000Z',
            completedAt: '2026-08-13T00:00:01.000Z',
            durationMs: 1_000,
            cached: false,
            candidates: [],
            outputText: longText,
          }],
        }],
      }
    }
    await store.saveRun(7, longRecord('still-running', 'running'))
    for (let index = 1; index <= 12; index += 1) await store.saveRun(7, longRecord(`run-${index}`))
    const runs = (await store.listRuns(7)).map((run) => run.runId)
    expect(runs[0]).toBe('run-12')
    expect(runs).toContain('still-running')
    expect(runs).not.toContain('run-1')
    expect(runs.length).toBeLessThan(13)
    const filePath = path.join(root, 'user-7', 'canvas-runtime.json')
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(64 * 1024)
  })

  it('drops the oldest cache entries once history alone cannot fit the budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-runs-'))
    roots.push(root)
    const store = new CanvasRunStore({
      rootDirectory: root,
      assets: { readOwned: async () => { throw new Error('missing') } },
      maximumBytes: 32 * 1024,
    })
    function textCache(fingerprintCharacter: string): CanvasRunCacheEntry {
      return {
        version: 1,
        fingerprint: fingerprintCharacter.repeat(64),
        nodeKind: 'text',
        outputText: '文'.repeat(3_000),
        createdAt: '2026-08-13T00:00:00.000Z',
        lastUsedAt: '2026-08-13T00:00:00.000Z',
      }
    }
    for (const character of ['a', 'b', 'c', 'd', 'e']) await store.storeCache(7, textCache(character))
    await expect(store.resolveCache(7, 'e'.repeat(64))).resolves.toMatchObject({ outputText: '文'.repeat(3_000) })
    await expect(store.resolveCache(7, 'a'.repeat(64))).resolves.toBeNull()
  })

  it('still refuses a single record larger than the whole budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-runs-'))
    roots.push(root)
    const store = new CanvasRunStore({
      rootDirectory: root,
      assets: { readOwned: async () => { throw new Error('missing') } },
      maximumBytes: 4 * 1024,
    })
    const oversized = record('huge')
    oversized.nodes[0].errorMessage = 'x'.repeat(8 * 1024)
    await expect(store.saveRun(7, oversized)).rejects.toThrow('画布运行记录超过安全上限')
  })

  it('recovers nonterminal runs as interrupted without replaying them', async () => {
    const { store } = fixture()
    await store.saveRun(7, record('running', 'running'))
    const recovered = await store.initializeUser(7)
    expect(recovered[0]).toMatchObject({ status: 'interrupted', completedAt: '2026-08-13T01:00:00.000Z' })
    expect(recovered[0].nodes[0]).toMatchObject({ state: 'interrupted' })
    expect(recovered[0].nodes[0].errorMessage).toContain('未自动重试')
  })

  it('forgets the frames an interrupted run waited on and reads back only well-formed ones', async () => {
    const { root, store } = fixture()
    const preparation = { operationId: 'attempt-1', nodeId: 'node', attemptId: 'attempt-1', sourceAssetId: 'V'.repeat(43), timestampSeconds: 2.5 }
    const waiting = { ...record('waiting', 'running'), framePreparations: [preparation] }
    await store.saveRun(7, waiting)
    expect((await store.listRuns(7))[0].framePreparations).toEqual([preparation])
    const recovered = await store.initializeUser(7)
    expect(recovered[0].status).toBe('interrupted')
    expect(recovered[0]).not.toHaveProperty('framePreparations')

    const filePath = path.join(root, 'user-7', 'canvas-runtime.json')
    const valid = fs.readFileSync(filePath, 'utf8')
    for (const wrong of [
      { ...preparation, sourceAssetId: '../../secret' },
      { ...preparation, timestampSeconds: 86_401 },
      { ...preparation, operationId: 'a\u0001b' },
    ]) {
      const state = JSON.parse(valid) as { runs: Array<Record<string, unknown>> }
      state.runs[0].framePreparations = [wrong]
      fs.writeFileSync(filePath, JSON.stringify(state), 'utf8')
      expect(await store.listRuns(7), JSON.stringify(wrong)).toEqual([])
      fs.writeFileSync(filePath, valid, 'utf8')
    }
  })

  it('backs up corrupt state and degrades to an empty history', async () => {
    const { root, store } = fixture()
    await store.saveRun(7, record('valid'))
    const filePath = path.join(root, 'user-7', 'canvas-runtime.json')
    fs.writeFileSync(filePath, '{invalid', 'utf8')
    expect(await store.listRuns(7)).toEqual([])
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.corrupt-'))).toBe(true)
  })

  it('offers each attempt that handed out an asset, newest first across projects, and returns the accepted one while it is owned', async () => {
    const { owned, store } = fixture()
    const shown = asset('a')
    const other = asset('b')
    owned.set(shown.assetId, { ...shown, width: 512 })
    owned.set(other.assetId, other)
    function attempt(
      fingerprintCharacter: string,
      state: 'succeeded' | 'cached' | 'failed',
      candidateAsset?: CanvasRunAsset,
    ): CanvasRunRecord['nodes'][number]['attempts'][number] {
      return {
        attemptId: `attempt-${fingerprintCharacter}`,
        fingerprint: fingerprintCharacter.repeat(64),
        state,
        startedAt: '2026-08-13T00:00:00.000Z',
        completedAt: '2026-08-13T00:00:01.000Z',
        durationMs: 1_000,
        cached: state === 'cached',
        candidates: candidateAsset
          ? [{ candidateId: 'candidate-shown', attemptId: 'attempt-c', createdAt: '2026-08-13T00:00:00.000Z', asset: candidateAsset }]
          : [],
      }
    }
    function projectRun(runId: string, projectId: string, attempts: CanvasRunRecord['nodes'][number]['attempts']): CanvasRunRecord {
      const base = record(runId)
      return { ...base, projectId, nodes: [{ nodeId: 'image', kind: 'image-generate', state: 'succeeded', attempts }] }
    }
    const original = '11111111-1111-1111-1111-111111111111'
    const copy = '22222222-2222-2222-2222-222222222222'
    await store.saveRun(7, projectRun('original', original, [
      attempt('c', 'succeeded', shown), attempt('d', 'failed'), attempt('e', 'succeeded', other),
    ]))
    await store.saveRun(7, projectRun('copy', copy, [attempt('f', 'cached', shown), attempt('f', 'cached', shown)]))

    const reads = vi.spyOn(owned, 'get')
    const offered: Array<[string, string | undefined]> = []
    const none = await store.resolveAssetOrigin(7, shown.assetId, (origin) => {
      offered.push([origin.fingerprint, origin.projectId])
      return false
    })
    expect(none).toBeNull()
    expect(offered).toEqual([['f'.repeat(64), copy], ['c'.repeat(64), original]])
    expect(reads).not.toHaveBeenCalled()

    const found = await store.resolveAssetOrigin(7, shown.assetId, (origin) => origin.projectId === original)
    expect(found).toMatchObject({
      fingerprint: 'c'.repeat(64),
      projectId: original,
      candidate: { candidateId: 'candidate-shown', asset: { kind: 'image', assetId: shown.assetId, width: 512 } },
    })
    expect(reads).toHaveBeenCalledOnce()
    await expect(store.resolveAssetOrigin(8, shown.assetId, () => true)).resolves.toBeNull()
    await expect(store.resolveAssetOrigin(7, 'z'.repeat(43), () => true)).resolves.toBeNull()
    await expect(store.resolveAssetOrigin(7, '../escape', () => true)).rejects.toThrow('画布资产标识格式错误')

    owned.delete(shown.assetId)
    await expect(store.resolveAssetOrigin(7, shown.assetId, () => true)).resolves.toBeNull()
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

  it('projects generated asset lineage and preserves the original source across cache reuse', async () => {
    const { store } = fixture()
    const generated = asset('g')
    const source = asset('s')
    const generatedRun = record('run-generated')
    generatedRun.projectId = '11111111-1111-4111-8111-111111111111'
    generatedRun.nodes = [{
      nodeId: 'image-node',
      kind: 'image-generate',
      state: 'succeeded',
      attempts: [{
        attemptId: 'attempt-generated',
        fingerprint: 'f'.repeat(64),
        state: 'succeeded',
        startedAt: generatedRun.startedAt,
        completedAt: generatedRun.completedAt!,
        durationMs: 1_000,
        cached: false,
        inputAssetIds: [source.assetId],
        candidates: [{
          candidateId: 'candidate-generated',
          attemptId: 'attempt-generated',
          createdAt: generatedRun.completedAt!,
          asset: generated,
        }],
      }],
    }]
    await store.saveRun(7, generatedRun)

    const cachedRun = structuredClone(generatedRun)
    cachedRun.runId = 'run-cached'
    cachedRun.nodes[0].attempts[0].cached = true
    cachedRun.nodes[0].attempts[0].attemptId = 'attempt-cached'
    cachedRun.nodes[0].attempts[0].candidates[0].attemptId = 'attempt-cached'
    await store.saveRun(7, cachedRun)

    await expect(store.getAssetLineage(7, [generated.assetId])).resolves.toEqual({
      [generated.assetId]: {
        origin: 'generated',
        runId: 'run-generated',
        graphRevision: 'revision',
        nodeId: 'image-node',
        attemptId: 'attempt-generated',
        candidateId: 'candidate-generated',
        projectId: '11111111-1111-4111-8111-111111111111',
        sourceAssetIds: [source.assetId],
      },
    })

    // "Find similar" asks the reverse question, and has to answer it over the
    // whole history rather than one page of the library.
    await expect(store.listAssetIdsByLineage(7, { runId: 'run-generated' })).resolves.toEqual([generated.assetId])
    await expect(store.listAssetIdsByLineage(7, { nodeId: 'image-node' })).resolves.toEqual([generated.assetId])
    await expect(store.listAssetIdsByLineage(7, { runId: 'run-cached' })).resolves.toEqual([])
    await expect(store.listAssetIdsByLineage(7, { runId: 'run-generated', nodeId: 'other-node' })).resolves.toEqual([])
    await expect(store.listAssetIdsByLineage(7, {})).rejects.toThrow('查询条件为空')
    await expect(store.listAssetIdsByLineage(7, { runId: 'bad\u0000id' })).rejects.toThrow('运行标识格式错误')
  })

  it('rejects secrets, remote URLs and absolute paths in structured fields', async () => {
    const { owned, store } = fixture()
    const bearer = record('bearer')
    bearer.graphRevision = 'Bearer token-value'
    await expect(store.saveRun(7, bearer)).rejects.toThrow(/密钥|地址|路径/)

    const remote = record('remote')
    remote.graphRevision = 'https://example.test/revision'
    await expect(store.saveRun(7, remote)).rejects.toThrow(/密钥|地址|路径/)

    const local = record('local')
    local.graphRevision = 'C:\\Users\\person\\key.txt'
    await expect(store.saveRun(7, local)).rejects.toThrow(/密钥|地址|路径/)

    const taggedAsset = asset('t')
    owned.set(taggedAsset.assetId, taggedAsset)
    const tagged = cacheEntry('d', { ...taggedAsset, taskId: 'https://example.test/task/1' })
    await expect(store.storeCache(7, tagged)).rejects.toThrow(/密钥|地址|路径/)
  })

  // E-S6: the assertion above used to run over the whole serialized state, so a
  // text node reading 「参考 https://example.com/ref.png」 made every write throw —
  // and the write happens after the paid generation has already been charged.
  it('persists user text containing URLs and host paths verbatim', async () => {
    const { store } = fixture()
    const texts = [
      '参考 https://example.com/ref.png',
      '参考 https://example.com/素材?size=2K&名称=封面#第一版',
      'http://example.test/plain 也要能存',
      '本地素材在 C:\\Users\\person\\Pictures\\ref.png',
      'file:///home/person/ref.png',
    ]
    const run = record('with-urls')
    run.nodes = [{
      nodeId: 'text-node',
      kind: 'text',
      state: 'succeeded',
      errorMessage: '生成失败：参考 https://example.com/ref.png',
      attempts: texts.map((outputText, index) => ({
        attemptId: `attempt-${index}`,
        fingerprint: 'f'.repeat(64),
        state: 'succeeded' as const,
        startedAt: run.startedAt,
        completedAt: run.completedAt!,
        durationMs: 1_000,
        cached: false,
        candidates: [],
        outputText,
      })),
    }]

    await store.saveRun(7, run)
    const reloaded = await store.getRun(7, 'with-urls')
    expect(reloaded?.nodes[0].attempts.map((attempt) => attempt.outputText)).toEqual(texts)
    expect(reloaded?.nodes[0].errorMessage).toBe('生成失败：参考 https://example.com/ref.png')
  })

  it('keeps the relay request ids and the charge checked after the run', async () => {
    const { store } = fixture()
    const run = record('charged')
    run.nodes = [{
      nodeId: 'image-node',
      kind: 'image',
      state: 'succeeded',
      attempts: [{
        attemptId: 'attempt-1',
        fingerprint: 'f'.repeat(64),
        state: 'succeeded',
        startedAt: run.startedAt,
        completedAt: run.completedAt!,
        durationMs: 1_000,
        cached: false,
        candidates: [],
        relayBilling: { requestIds: ['2026111013000012345678abcdefgh'], unanswered: true },
        charge: { state: 'unmatched', usd: 0.06 },
      }],
    }]
    run.charge = { state: 'unmatched', usd: 0.06, unmatchedAttempts: 1, checkedAt: '2026-08-13T00:00:07.000Z' }

    await store.saveRun(7, run)
    const reloaded = await store.getRun(7, 'charged')
    expect(reloaded?.nodes[0].attempts[0]).toMatchObject({
      relayBilling: { requestIds: ['2026111013000012345678abcdefgh'], unanswered: true },
      charge: { state: 'unmatched', usd: 0.06 },
    })
    expect(reloaded?.charge).toEqual(run.charge)
  })

  it('round-trips cached text containing URLs without treating it as corrupt', async () => {
    const { store } = fixture()
    const outputText = '参考 https://example.com/素材?size=2K&名称=封面'
    await store.storeCache(7, {
      version: 1,
      fingerprint: 'c'.repeat(64),
      nodeKind: 'text',
      outputText,
      createdAt: '2026-08-13T00:00:00.000Z',
      lastUsedAt: '2026-08-13T00:00:00.000Z',
    })
    await expect(store.resolveCache(7, 'c'.repeat(64))).resolves.toMatchObject({ outputText })
  })

  // R-1: a video reports progress every few seconds; reading, scanning and
  // rewriting the whole file (up to 8 MB) for each report stalled the main
  // process and with it the main window.
  describe('progress saves', () => {
    function runtimeFile(root: string): string {
      return path.join(root, 'user-7', 'canvas-runtime.json')
    }

    function runOnDisk(root: string, runId: string): CanvasRunRecord | undefined {
      const state = JSON.parse(fs.readFileSync(runtimeFile(root), 'utf8')) as { runs: CanvasRunRecord[] }
      return state.runs.find((run) => run.runId === runId)
    }

    function fileIdentity(root: string): string {
      const stats = fs.statSync(runtimeFile(root), { bigint: true })
      return `${stats.ino}:${stats.mtimeNs}`
    }

    function progressed(runId: string, progress: number): CanvasRunRecord {
      const run = record(runId, 'running')
      run.nodes[0].latestStage = 'processing'
      run.nodes[0].latestProgress = progress
      run.events = [{
        version: 1, type: 'node-stage', runId, graphRevision: 'revision', sequence: 1,
        at: '2026-08-13T00:00:00.500Z', nodeId: 'node', stage: 'processing', progress,
      }]
      return run
    }

    function openStore(root: string, deferredWriteDelayMs = 60_000) {
      return new CanvasRunStore({
        rootDirectory: root,
        assets: { readOwned: async () => { throw new Error('missing') } },
        deferredWriteDelayMs,
      })
    }

    function tempRoot(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-runs-'))
      roots.push(root)
      return root
    }

    it('shows a deferred progress save to readers at once and writes it within the delay', async () => {
      const root = tempRoot()
      const store = openStore(root, 20)
      await store.saveRun(7, record('video', 'running'))
      await store.saveRun(7, progressed('video', 40), { deferWrite: true })

      await expect(store.getRun(7, 'video')).resolves.toMatchObject({ nodes: [{ latestProgress: 40 }] })
      expect(runOnDisk(root, 'video')?.nodes[0].latestProgress).toBeUndefined()
      await vi.waitFor(() => expect(runOnDisk(root, 'video')?.nodes[0].latestProgress).toBe(40))
    })

    it('carries deferred progress along with the next ordinary save instead of writing it twice', async () => {
      const root = tempRoot()
      const store = openStore(root)
      await store.saveRun(7, record('video', 'running'))
      await store.saveRun(7, progressed('video', 55), { deferWrite: true })
      await store.saveRun(7, record('other'))

      expect(runOnDisk(root, 'video')?.nodes[0].latestProgress).toBe(55)
      expect(runOnDisk(root, 'other')).toBeDefined()
      const written = fileIdentity(root)
      await store.flushDeferredWrites()
      expect(fileIdentity(root)).toBe(written)
    })

    it('reads the file once instead of on every save', async () => {
      const root = tempRoot()
      await openStore(root).saveRun(7, record('earlier'))
      const store = openStore(root)
      const open = vi.spyOn(fs.promises, 'open')
      try {
        for (let progress = 10; progress <= 50; progress += 10) {
          await store.saveRun(7, progressed('video', progress), { deferWrite: true })
        }
        await store.saveRun(7, record('video'))
        const reads = open.mock.calls.filter(([target, flags]) => target === runtimeFile(root) && flags === 'r')
        expect(reads).toHaveLength(1)
      } finally {
        open.mockRestore()
      }
      expect((await openStore(root).listRuns(7)).map((run) => run.runId)).toEqual(['video', 'earlier'])
    })

    it('lets a file changed behind its back win over progress it has not written yet', async () => {
      const root = tempRoot()
      const first = openStore(root)
      const second = openStore(root)
      await first.saveRun(7, record('video', 'running'))
      await first.saveRun(7, progressed('video', 70), { deferWrite: true })
      await second.saveRun(7, record('elsewhere'))

      const runs = await first.listRuns(7)
      expect(runs.map((run) => run.runId)).toEqual(['elsewhere', 'video'])
      expect(runs[1].nodes[0].latestProgress).toBeUndefined()
      const written = fileIdentity(root)
      await first.flushDeferredWrites()
      expect(fileIdentity(root)).toBe(written)
    })

    it('forgets a save that failed instead of keeping it in memory', async () => {
      const root = tempRoot()
      const store = openStore(root)
      await store.saveRun(7, record('kept'))
      const leaked = record('leaked')
      leaked.graphRevision = 'Bearer token-value'
      await expect(store.saveRun(7, leaked)).rejects.toThrow(/密钥|地址|路径/)
      await expect(store.saveRun(7, leaked, { deferWrite: true })).rejects.toThrow(/密钥|地址|路径/)
      expect((await store.listRuns(7)).map((run) => run.runId)).toEqual(['kept'])
    })

    it('lets go of the remembered state after a minute without use', async () => {
      const root = tempRoot()
      await openStore(root).saveRun(7, record('earlier'))
      const store = openStore(root)
      const open = vi.spyOn(fs.promises, 'open')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const reads = () => open.mock.calls.filter(([target, flags]) => target === runtimeFile(root) && flags === 'r').length
        await store.listRuns(7)
        await store.listRuns(7)
        expect(reads()).toBe(1)
        await vi.advanceTimersByTimeAsync(59_000)
        await store.listRuns(7)
        expect(reads()).toBe(1)
        await vi.advanceTimersByTimeAsync(61_000)
        await expect(store.listRuns(7)).resolves.toHaveLength(1)
        expect(reads()).toBe(2)
      } finally {
        vi.useRealTimers()
        open.mockRestore()
      }
    })
  })

  it('reads back a run file whose cache holds a kernel-only node kind', async () => {
    // A later release runs these kinds; rolled back to this one, the file must
    // still load instead of being backed up as corrupt with all its history.
    const { root, store } = fixture()
    await store.saveRun(7, record('kept'))
    await store.storeCache(7, {
      version: 1,
      fingerprint: 'd'.repeat(64),
      nodeKind: 'text-generate',
      outputText: '生成好的文案',
      createdAt: '2026-08-13T00:00:00.000Z',
      lastUsedAt: '2026-08-13T00:00:00.000Z',
    })
    const reopened = new CanvasRunStore({ rootDirectory: root, assets: { readOwned: async () => { throw new Error('missing') } } })
    expect((await reopened.listRuns(7)).map((run) => run.runId)).toEqual(['kept'])
    await expect(reopened.resolveCache(7, 'd'.repeat(64))).resolves.toMatchObject({ nodeKind: 'text-generate', outputText: '生成好的文案' })
    expect(fs.readdirSync(path.join(root, 'user-7')).some((entry) => entry.includes('.corrupt-'))).toBe(false)
  })
})
