import { describe, expect, it, vi } from 'vitest'
import { addRunCollectionReferences, parseRunCollectionReferences, readRunCollection, resolveRunCollectionReference, runCollectionItems, runCollectionScopeKey, verifyRunCollection, writeRunCollection } from './run-result-collection'
import { collectionAsset, collectionReference, collectionRun, collectionStorage } from './run-result-collection.test-fixture'
const scope = { accountId: 1, projectId: 'project' }
function reader() { return { onReadRun: vi.fn(async (id: string) => collectionRun(id, [1, 2, 3])), onReadAsset: vi.fn(async (id: string) => { const index = Number(id.replace(/a/g, '')); return collectionAsset(index, index % 3 === 0 ? 'audio' : index % 3 === 2 ? 'video' : 'image') }) } }
describe('ordered cross-run collection identities', () => {
  it('migrates legacy choices into an independent revisioned key that already-open legacy tabs cannot overwrite', () => {
    const storage = collectionStorage(), legacyKey = `xingmang.canvas.run-collection.v1.${scope.accountId}.${scope.projectId}`
    storage.setItem(legacyKey, JSON.stringify({ version: 1, references: [collectionReference(1, 'first')] }))
    expect(readRunCollection(scope, storage).references).toEqual([collectionReference(1, 'first')])
    writeRunCollection(scope, [collectionReference(1, 'first'), collectionReference(2)], storage)
    storage.setItem(legacyKey, JSON.stringify({ version: 1, references: [collectionReference(3)] }))
    expect(readRunCollection(scope, storage).references).toEqual([collectionReference(1, 'first'), collectionReference(2)])
    expect(JSON.parse(storage.getItem(runCollectionScopeKey(scope))!)).toMatchObject({ version: 2, revision: 1 })
    storage.setItem(runCollectionScopeKey(scope), '{broken-current')
    expect(readRunCollection(scope, storage)).toMatchObject({ references: [], corrupt: true })
    expect(storage.getItem(legacyKey)).toContain('candidate-3')
  })
  it('rejects a stale revision before writing instead of overwriting another page deletion or order', () => {
    const storage = collectionStorage()
    writeRunCollection(scope, [collectionReference(1), collectionReference(2)], storage)
    const original = readRunCollection(scope, storage)
    writeRunCollection(scope, [collectionReference(2)], storage)
    const latest = storage.getItem(runCollectionScopeKey(scope))
    expect(() => writeRunCollection(scope, [collectionReference(1), collectionReference(2), collectionReference(3)], storage, original.versionToken)).toThrow('其他页面')
    expect(storage.getItem(runCollectionScopeKey(scope))).toBe(latest)
  })
  it('deduplicates assets across runs while retaining the first exact original source and user order', () => {
    const first = collectionReference(1, 'first'), duplicate = collectionReference(1, 'later')
    expect(addRunCollectionReferences([first], [collectionReference(2, 'second'), duplicate])).toEqual([first, collectionReference(2, 'second')])
  })
  it('rejects the entire oversized addition without truncating or changing the existing basket', () => {
    const original = Array.from({ length: 49 }, (_, index) => collectionReference(index + 1))
    expect(() => addRunCollectionReferences(original, [collectionReference(50), collectionReference(51)])).toThrow('整批未加入')
    expect(original).toHaveLength(49); expect(addRunCollectionReferences(original, [collectionReference(49), collectionReference(50)])).toHaveLength(50)
  })
  it('stores only stable references and isolates the owner and project on reload', () => {
    const storage = collectionStorage(), refs = [collectionReference(2, 'older'), collectionReference(1)]
    writeRunCollection(scope, refs, storage)
    expect(readRunCollection(scope, storage).references).toEqual(refs)
    expect(readRunCollection({ ...scope, accountId: 2 }, storage).references).toEqual([])
    expect(readRunCollection({ ...scope, projectId: 'other' }, storage).references).toEqual([])
    expect([...storage.values.values()].join('')).not.toMatch(/localUrl|mimeType|base64|prompt|model|apiKey/)
  })
  it.each(['url', 'duplicate', 'unknown-version', 'oversized', 'malformed'] as const)('reports %s corruption without silently replacing the saved draft', (reason) => {
    const storage = collectionStorage(), key = runCollectionScopeKey(scope)
    const content = reason === 'malformed' ? '{broken' : reason === 'oversized' ? 'x'.repeat(65537) : JSON.stringify({ version: reason === 'unknown-version' ? 2 : 1, references: reason === 'duplicate' ? [collectionReference(), collectionReference()] : [{ ...collectionReference(), ...(reason === 'url' ? { localUrl: 'https://evil.invalid' } : {}) }] })
    storage.setItem(key, content); expect(readRunCollection(scope, storage)).toMatchObject({ references: [], corrupt: true, error: expect.any(String) }); expect(storage.getItem(key)).toBe(content)
  })
  it('reports blocked and lying browser storage instead of claiming persistence', () => {
    expect(readRunCollection(scope, { getItem() { throw Error('blocked') }, setItem() {} }).error).toContain('blocked')
    expect(() => writeRunCollection(scope, [collectionReference()], { getItem: () => null, setItem() {} })).toThrow('未能确认')
    expect(() => parseRunCollectionReferences([{ ...collectionReference(), assetId: '../private' }])).toThrow()
  })
  it('keeps every attempt candidate and validates the complete original tuple', () => {
    const run = collectionRun(); const node = run.nodes[0]; node.attempts.push({ ...node.attempts[0], attemptId: 'retry', candidates: [{ ...node.attempts[0].candidates[0], attemptId: 'retry', candidateId: 'retry-candidate' }] })
    expect(runCollectionItems(run, 'project')).toHaveLength(3)
    expect(resolveRunCollectionReference(run, collectionReference(), 'project').reference).toEqual(collectionReference())
    for (const changed of [{ ...collectionReference(), runId: 'other' }, { ...collectionReference(), candidateId: 'other' }, { ...collectionReference(), attemptId: 'retry' }]) expect(() => resolveRunCollectionReference(run, changed, 'project')).toThrow()
    expect(() => runCollectionItems(run, 'other-project')).toThrow('不属于')
  })
})
describe('fresh run and owner media verification', () => {
  it('rechecks the original run once per batch and verifies image video and audio identities in frozen order', async () => {
    const access = reader(), refs = [collectionReference(3), collectionReference(1), collectionReference(2)]
    const checked = await verifyRunCollection(refs, 'project', access, new AbortController().signal)
    expect(checked.map((entry) => entry.asset?.mediaType)).toEqual(['audio', 'image', 'video']); expect(checked.every((entry) => !entry.error)).toBe(true)
    expect(access.onReadRun).toHaveBeenCalledOnce(); expect(access.onReadAsset).toHaveBeenCalledTimes(3); expect(refs[0]).toEqual(collectionReference(3))
  })
  it.each(['deleted', 'wrong-asset', 'wrong-kind', 'unowned-url', 'missing-run', 'changed-attempt', 'wrong-project'] as const)('keeps an explicit failure for %s without treating the rest as a submitted partial batch', async (reason) => {
    const access = reader()
    if (reason === 'missing-run') access.onReadRun.mockRejectedValueOnce(Error('原运行不可读'))
    if (reason === 'wrong-project') access.onReadRun.mockResolvedValueOnce(collectionRun('run-a', [1], 'other'))
    if (reason === 'changed-attempt') { const run = collectionRun(); run.nodes[0].attempts[0].attemptId = 'changed'; access.onReadRun.mockResolvedValueOnce(run) }
    if (['deleted', 'wrong-asset', 'wrong-kind', 'unowned-url'].includes(reason)) access.onReadAsset.mockResolvedValueOnce({ ...collectionAsset(1, reason === 'wrong-kind' ? 'video' : 'image'), ...(reason === 'deleted' ? { deletedAt: 'today' } : {}), ...(reason === 'wrong-asset' ? { assetId: collectionReference(9).assetId } : {}), ...(reason === 'unowned-url' ? { localUrl: 'https://example.invalid/private' } : {}) })
    const result = await verifyRunCollection([collectionReference()], 'project', access, new AbortController().signal)
    expect(result[0].reference).toEqual(collectionReference()); expect(result[0].error).toBeTruthy(); expect(result[0].asset).toBeUndefined()
  })
  it('honors cancellation after an ignored-abort read and never starts an asset lookup', async () => {
    const controller = new AbortController(), access = reader()
    access.onReadRun.mockImplementationOnce(async () => { controller.abort(); return collectionRun() })
    await expect(verifyRunCollection([collectionReference()], 'project', access, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(access.onReadAsset).not.toHaveBeenCalled()
  })
})
