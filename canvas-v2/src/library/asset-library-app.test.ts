import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { emptyCanvasAssetPage, type CanvasAssetPage, type CanvasAssetQuery, type CanvasAssetSummary, type CanvasListedAssetSummary } from '../host'
import { runCanvasAssetMutationBatch, type CanvasAssetMutationResult } from '../components/asset-mutation-batch'
import type { AssetMutationInput, AssetMutationResult } from '../lib/asset-mutation-contract'
import { assertAssetCategoryPageFilter } from '../lib/asset-category-contract'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualCallback<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback: ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  let scope = 'owner-a:project-a:1', page = emptyCanvasAssetPage(), catalog: CanvasAssetSummary[] = [], loading = false
  const reads = new Map<string, ReturnType<typeof deferred<CanvasAssetPage>>>()
  const listAssets = vi.fn((query: CanvasAssetQuery) => { const gate = deferred<CanvasAssetPage>(); reads.set(query.search ?? '', gate); return gate.promise })
  const setBanner = vi.fn(), assetsRequestRevisionRef = { current: 0 }, assetQueryRef = { current: {} as CanvasAssetQuery }, agentMountedRef = { current: true }
  const environment = { assetQuery: {}, assetQueryRef, assetsRequestRevisionRef, agentMountedRef, assertAssetCategoryPageFilter, currentAssetLibraryScope: () => scope, hostBridge: () => ({ listAssets }),
    setAssetPage: (value: CanvasAssetPage) => { page = value }, setAssetCatalog: (update: (value: CanvasAssetSummary[]) => CanvasAssetSummary[]) => { catalog = update(catalog) }, setAssetsLoading: (value: boolean) => { loading = value }, setBanner, setNodes: vi.fn(), applyCatalogClipDurationToNodes: (nodes: unknown) => nodes }
  const refresh = actualCallback<(query?: CanvasAssetQuery) => Promise<unknown>>('refreshAssets', environment)
  return { refresh, reads, listAssets, setBanner, assetQueryRef, agentMountedRef, scope(value: string) { scope = value }, page: () => page, catalog: () => catalog, loading: () => loading }
}

describe('actual App asset library request ordering', () => {
  it('keeps the newest filter page when an earlier query resolves last', async () => {
    const f = fixture(), a = f.refresh({ search: 'old' }), b = f.refresh({ search: 'new' })
    f.reads.get('new')!.resolve({ ...emptyCanvasAssetPage(), total: 2 }); await b
    f.reads.get('old')!.resolve({ ...emptyCanvasAssetPage(), total: 9 }); await a
    expect(f.page().total).toBe(2)
  })
  it('does not clear a newer query loading indicator or publish an old error', async () => {
    const f = fixture(), a = f.refresh({ search: 'old' }), b = f.refresh({ search: 'new' })
    f.reads.get('old')!.reject(new Error('old query failure')); await a
    expect(f.loading()).toBe(true); expect(f.setBanner).not.toHaveBeenCalled()
    f.reads.get('new')!.resolve(emptyCanvasAssetPage()); await b; expect(f.loading()).toBe(false)
  })
  it('rejects a response after owner or project epoch changes and after unmount', async () => {
    for (const change of ['scope', 'unmount']) {
      const f = fixture(), request = f.refresh({ search: 'old' })
      if (change === 'scope') f.scope('owner-b:project-b:2'); else f.agentMountedRef.current = false
      f.reads.get('old')!.resolve({ ...emptyCanvasAssetPage(), total: 5 }); await request
      expect(f.page().total).toBe(0); expect(f.catalog()).toEqual([]); expect(f.setBanner).not.toHaveBeenCalled()
    }
  })
  it('uses the current query for a late mutation refresh rather than the old render closure', async () => {
    const f = fixture(); f.assetQueryRef.current = { search: 'current', view: 'favorites' }
    const request = f.refresh(); expect(f.listAssets).toHaveBeenCalledWith({ search: 'current', view: 'favorites' })
    f.reads.get('current')!.resolve(emptyCanvasAssetPage()); await request
  })
  it('does not display an unconfirmed server category filter as its selected category', async () => {
    const f = fixture(), request = f.refresh({ categoryId: null })
    f.reads.get('')!.resolve({ ...emptyCanvasAssetPage(), total: 5 }); await request
    expect(f.page().total).toBe(0); expect(f.setBanner).toHaveBeenCalledWith(expect.stringContaining('未确认分类筛选'))
  })
})

describe('actual App retained irreversible purge batch callbacks', () => {
  function mutationFixture() {
    let scope = 'owner-a:project-a:1'
    const assetQueryRef = { current: {} as CanvasAssetQuery }, assetQueryGenerationRef = { current: 0 }, assetMutationPendingRef = { current: null as { scope: string; token: object } | null }, agentMountedRef = { current: true }
    const purgeAsset = vi.fn(async (assetId: string) => { if (assetId.endsWith('2')) throw new Error('仍被共享项目引用'); return { assetId, deletedAt: 'now' } })
    const restoreAsset = vi.fn(async (assetId: string) => ({ assetId })), refreshAssets = vi.fn(async () => true)
    const mutate = actualCallback<(action: 'delete' | 'restore' | 'purge', ids: readonly string[], content?: string) => Promise<CanvasAssetMutationResult>>('mutateCanvasAssets', { assetQueryRef, assetQueryGenerationRef, assetMutationPendingRef, agentMountedRef, currentAssetLibraryScope: () => scope, hostBridge: () => ({ restoreAsset, purgeAsset }), refreshAssets, runCanvasAssetMutationBatch, directAssetMutations: false })
    const changeQuery = actualCallback<(query: CanvasAssetQuery) => void>('changeAssetQuery', { assetQueryRef, assetQueryGenerationRef, assetMutationPendingRef, setAssetQuery: vi.fn(), refreshAssets })
    return { mutate, changeQuery, assetQueryRef, restoreAsset, purgeAsset, refreshAssets, assetMutationPendingRef, scope(value: string) { scope = value } }
  }
  const id = (index: number) => String(index).padStart(43, '0')
  it('returns partial outcomes and refreshes after successes and failures instead of throwing away confirmed writes', async () => {
    const f = mutationFixture(), remove = actualCallback<(ids: string[]) => Promise<CanvasAssetMutationResult>>('purgeCanvasAssets', { mutateCanvasAssets: f.mutate })
    const result = await remove([id(1), id(2), id(3)])
    expect(result.outcomes.map((item) => item.state)).toEqual(['succeeded', 'unconfirmed', 'succeeded'])
    expect(f.purgeAsset.mock.calls.map(([assetId]) => assetId)).toEqual([id(1), id(2), id(3)]); expect(f.refreshAssets).toHaveBeenCalledOnce(); expect(f.assetMutationPendingRef.current).toBeNull()
  })
  it('keeps accepted results but stops unsent mutations and old-list refresh when the account or project changes', async () => {
    const f = mutationFixture(), gate = deferred<{ assetId: string; deletedAt: string }>()
    f.purgeAsset.mockImplementationOnce(() => gate.promise)
    const request = f.mutate('purge', [id(1), id(3)]); f.scope('owner-b:project-b:2'); gate.resolve({ assetId: id(1), deletedAt: 'now' })
    expect((await request).outcomes.map((item) => item.state)).toEqual(['succeeded', 'not-started']); expect(f.purgeAsset).toHaveBeenCalledOnce(); expect(f.refreshAssets).not.toHaveBeenCalled()
  })
  it('does not submit remaining items after a forced query change and rejects overlapping jobs', async () => {
    const f = mutationFixture(), gate = deferred<{ assetId: string; deletedAt: string }>()
    f.purgeAsset.mockImplementationOnce(() => gate.promise)
    const request = f.mutate('purge', [id(1), id(3)])
    await expect(f.mutate('purge', [id(4)])).rejects.toThrow('正在进行')
    f.assetQueryRef.current = { view: 'trash' }; gate.resolve({ assetId: id(1), deletedAt: 'now' }); expect((await request).outcomes[1].state).toBe('not-started'); expect(f.restoreAsset).not.toHaveBeenCalled(); expect(f.refreshAssets).not.toHaveBeenCalled()
  })
  it('keeps irreversible outcomes when list refresh fails and permits a later explicit purge', async () => {
    const f = mutationFixture(); f.refreshAssets.mockResolvedValueOnce(false)
    const result = await f.mutate('purge', [id(1), id(2)])
    expect(result.refreshError).toContain('列表读取未完成'); expect(result.outcomes.map((item) => item.state)).toEqual(['succeeded', 'unconfirmed'])
    const restore = actualCallback<(ids: string[]) => Promise<CanvasAssetMutationResult>>('purgeCanvasAssets', { mutateCanvasAssets: f.mutate })
    expect((await restore([id(1)])).outcomes[0].state).toBe('succeeded'); expect(f.purgeAsset).toHaveBeenCalledTimes(3)
  })
  it('never revives an old batch when an actual query callback changes A to B and back to A', async () => {
    const f = mutationFixture(), gate = deferred<{ assetId: string; deletedAt: string }>()
    f.changeQuery({ view: 'all' }); f.refreshAssets.mockClear(); f.purgeAsset.mockImplementationOnce(() => gate.promise)
    const request = f.mutate('purge', [id(1), id(3)])
    f.changeQuery({ view: 'trash' }); f.changeQuery({ view: 'all' }); f.refreshAssets.mockClear()
    gate.resolve({ assetId: id(1), deletedAt: 'now' })
    expect((await request).outcomes.map((item) => item.state)).toEqual(['succeeded', 'not-started']); expect(f.purgeAsset).toHaveBeenCalledTimes(1); expect(f.refreshAssets).not.toHaveBeenCalled()
  })
  it('keeps category filters distinct and stops old writes after all to uncategorized and back to all', async () => {
    const f = mutationFixture(), gate = deferred<{ assetId: string; deletedAt: string }>()
    f.changeQuery({ view: 'all' }); f.purgeAsset.mockImplementationOnce(() => gate.promise)
    const request = f.mutate('purge', [id(1), id(3)])
    f.changeQuery({ categoryId: '11111111-1111-4111-8111-111111111111' }); expect(f.assetQueryRef.current.categoryId).toBe('11111111-1111-4111-8111-111111111111')
    f.changeQuery({ categoryId: null }); expect(f.assetQueryRef.current.categoryId).toBeNull()
    f.changeQuery({ view: 'all' }); expect(f.assetQueryRef.current.categoryId).toBeUndefined()
    gate.resolve({ assetId: id(1), deletedAt: 'now' })
    expect((await request).outcomes.map((item) => item.state)).toEqual(['succeeded', 'not-started']); expect(f.purgeAsset).toHaveBeenCalledTimes(1)
  })
})

function mutationReceipt(input: AssetMutationInput): AssetMutationResult {
  const ids = input.action === 'rename' ? [input.assetId] : input.assetIds
  return { version: 1, action: input.action, operationId: input.operationId, requestDigest: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00.000Z', outcomes: ids.map((assetId) => ({ assetId, displayName: '素材', state: assetId.endsWith('2') ? 'rejected' : 'succeeded', changed: !assetId.endsWith('2'), undoable: !assetId.endsWith('2'), message: assetId.endsWith('2') ? '原操作拒绝' : '原操作确认' })) }
}
function recoveryFixture() {
  let scope = 'owner-a:project-a:1'
  const assetQueryRef = { current: {} as CanvasAssetQuery }, assetQueryGenerationRef = { current: 0 }, assetMutationPendingRef = { current: null as { scope: string; token: object; controller?: AbortController } | null }, agentMountedRef = { current: true }, draftActionsEnabledRef = { current: true }
  const legacy = vi.fn(async () => { throw new Error('Legacy write must not run') }), manageAssetMutations = vi.fn(), inspectAssetMutationOperation = vi.fn(), bridge = { manageAssetMutations, inspectAssetMutationOperation, renameAsset: legacy, updateAssetMetadata: legacy, deleteAsset: legacy, restoreAsset: legacy, purgeAsset: legacy }
  const submit = vi.fn(async (input: AssetMutationInput, _signal?: AbortSignal) => mutationReceipt(input)), refreshAssets = vi.fn(async () => true), setBanner = vi.fn()
  const environment = { assetQueryRef, assetQueryGenerationRef, assetMutationPendingRef, agentMountedRef, draftActionsEnabledRef, currentAssetLibraryScope: () => scope, hostBridge: () => bridge, assetMutationRecovery: { submit }, refreshAssets, setBanner, directAssetMutations: false }
  const apply = actualCallback<(input: AssetMutationInput, signal?: AbortSignal) => Promise<AssetMutationResult>>('submitCanvasAssetMutation', environment)
  const batch = actualCallback<(action: 'delete' | 'restore' | 'purge', ids: readonly string[], content?: string) => Promise<CanvasAssetMutationResult>>('mutateCanvasAssets', { ...environment, submitCanvasAssetMutation: apply, runCanvasAssetMutationBatch })
  const rename = actualCallback<(assetId: string, displayName: string) => Promise<void>>('renameCanvasAsset', { submitCanvasAssetMutation: apply })
  const metadata = actualCallback<(assetId: string, input: { favorite?: boolean; tags?: string[] }) => Promise<void>>('updateCanvasAssetMetadata', { submitCanvasAssetMutation: apply })
  const favorite = actualCallback<(assetIds: readonly string[], favorite: boolean) => Promise<AssetMutationResult>>('favoriteCanvasAssets', { submitCanvasAssetMutation: apply })
  const changeQuery = actualCallback<(query: CanvasAssetQuery) => void>('changeAssetQuery', { assetQueryRef, assetQueryGenerationRef, assetMutationPendingRef, setAssetQuery: vi.fn(), refreshAssets })
  return { apply, batch, rename, metadata, favorite, changeQuery, submit, legacy, refreshAssets, setBanner, assetMutationPendingRef, agentMountedRef, draftActionsEnabledRef, bridge, scope(value: string) { scope = value } }
}

describe('actual App recoverable asset operation callbacks', () => {
  const id = (index: number) => String(index).padStart(43, '0')
  it('routes the full delete and restore selection through one owner journal operation and preserves explicit rejection', async () => {
    const f = recoveryFixture()
    const removed = await f.batch('delete', [id(3), id(2), id(1)])
    expect(f.submit).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), action: 'delete', assetIds: [id(3), id(2), id(1)] }, expect.any(AbortSignal))
    expect(removed.outcomes.map((item) => item.state)).toEqual(['succeeded', 'rejected', 'succeeded']); expect(f.legacy).not.toHaveBeenCalled(); expect(f.refreshAssets).toHaveBeenCalledOnce()
    await f.batch('restore', [id(1)]); expect(f.submit.mock.calls[1][0]).toMatchObject({ action: 'restore', assetIds: [id(1)] }); expect(f.assetMutationPendingRef.current).toBeNull()
  })
  it('routes original rename tags and favorite entry points without invoking legacy management', async () => {
    const f = recoveryFixture()
    await f.rename(id(1), '新名称'); await f.metadata(id(1), { tags: ['产品'] }); await f.metadata(id(1), { favorite: true }); await f.metadata(id(1), { favorite: false })
    expect(f.submit.mock.calls.map(([input]) => input.action)).toEqual(['rename', 'tags', 'favorite', 'unfavorite']); expect(f.legacy).not.toHaveBeenCalled()
    expect(f.submit.mock.calls[0][0]).toMatchObject({ assetId: id(1), displayName: '新名称' }); expect(f.submit.mock.calls[1][0]).toMatchObject({ assetIds: [id(1)], tags: ['产品'] })
  })
  it('freezes selected favorite identities and never starts a second operation on repeated clicks', async () => {
    const f = recoveryFixture(), gate = deferred<AssetMutationResult>(), ids = [id(3), id(1)]; f.submit.mockImplementationOnce(() => gate.promise)
    const running = f.favorite(ids, true); ids.push(id(2))
    await expect(f.favorite([id(1)], false)).rejects.toThrow('正在进行'); expect(f.submit).toHaveBeenCalledOnce(); expect(f.submit.mock.calls[0][0]).toMatchObject({ assetIds: [id(3), id(1)] })
    gate.resolve(mutationReceipt(f.submit.mock.calls[0][0])); await running
  })
  it('aborts waiting and suppresses late refresh across query ABA without creating another operation', async () => {
    const f = recoveryFixture(), gate = deferred<AssetMutationResult>(); f.submit.mockImplementationOnce(() => gate.promise)
    const running = f.favorite([id(1)], true); const signal = f.submit.mock.calls[0][1]!
    f.changeQuery({ view: 'trash' }); f.changeQuery({ view: 'all' }); f.refreshAssets.mockClear()
    expect(signal.aborted).toBe(true); gate.resolve(mutationReceipt(f.submit.mock.calls[0][0]))
    await expect(running).rejects.toThrow('原操作记录仍保留'); expect(f.refreshAssets).not.toHaveBeenCalled(); expect(f.setBanner).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledOnce()
  })
  it('keeps late owner project permission and unmount results out of the current UI', async () => {
    for (const change of ['scope', 'permission', 'unmount'] as const) {
      const f = recoveryFixture(), gate = deferred<AssetMutationResult>(); f.submit.mockImplementationOnce(() => gate.promise)
      const running = f.favorite([id(1)], true)
      if (change === 'scope') f.scope('owner-b:project-b:2'); else if (change === 'permission') f.draftActionsEnabledRef.current = false; else f.agentMountedRef.current = false
      gate.resolve(mutationReceipt(f.submit.mock.calls[0][0])); await expect(running).rejects.toThrow('原操作记录仍保留')
      expect(f.refreshAssets).not.toHaveBeenCalled(); expect(f.setBanner).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled()
    }
  })
  it('rejects unsupported native hosts and inactive permission before any journal or legacy write', async () => {
    for (const change of ['host', 'permission', 'unmount'] as const) {
      const f = recoveryFixture()
      if (change === 'host') Object.assign(f.bridge, { manageAssetMutations: undefined }); else if (change === 'permission') f.draftActionsEnabledRef.current = false; else f.agentMountedRef.current = false
      await expect(f.favorite([id(1)], true)).rejects.toThrow('没有提交'); expect(f.submit).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled()
    }
  })
  it('does not fallback or retry after an unknown journal result and permits read-only recovery elsewhere', async () => {
    const f = recoveryFixture(); f.submit.mockRejectedValueOnce(new Error('原操作回执未知'))
    await expect(f.favorite([id(1)], true)).rejects.toThrow('原操作回执未知'); expect(f.submit).toHaveBeenCalledOnce(); expect(f.legacy).not.toHaveBeenCalled(); expect(f.refreshAssets).not.toHaveBeenCalled(); expect(f.assetMutationPendingRef.current).toBeNull()
  })
  it('keeps a confirmed original receipt when refreshing the view fails without issuing another mutation', async () => {
    const f = recoveryFixture(); f.refreshAssets.mockResolvedValueOnce(false)
    const result = await f.favorite([id(1)], true)
    expect(result.outcomes[0].state).toBe('succeeded'); expect(f.submit).toHaveBeenCalledOnce(); expect(f.legacy).not.toHaveBeenCalled()
  })
})

describe('actual App direct asset writes on a desktop without the recoverable pair', () => {
  const id = (index: number) => String(index).padStart(43, '0')
  function asset(index: number): CanvasListedAssetSummary { return { mediaType: 'image', assetId: id(index), mimeType: 'image/png', fileName: 'own.png', localUrl: `xingmang-asset://image/${id(index)}`, thumbnailUrl: `xingmang-asset://image/${id(index)}`, width: 512, height: 512, createdAt: '2026-10-28T00:00:00.000Z', displayName: '原名', favorite: false, tags: [] } }
  function directFixture() {
    let scope = 'owner-a:project-a:1', page: CanvasAssetPage = { ...emptyCanvasAssetPage(), items: [asset(1)] }, catalog: CanvasAssetSummary[] = [asset(1)]
    const assetQueryRef = { current: {} as CanvasAssetQuery }, assetQueryGenerationRef = { current: 0 }, assetMutationPendingRef = { current: null as { scope: string; token: object } | null }, agentMountedRef = { current: true }
    const journal = vi.fn(async () => { throw new Error('Recoverable journal must not run') })
    const bridge = {
      renameAsset: vi.fn(async (input: { assetId: string; displayName: string }) => input),
      updateAssetMetadata: vi.fn(async (input: { assetId: string; favorite?: boolean; tags?: string[] }) => ({ assetId: input.assetId, favorite: input.favorite ?? false, tags: input.tags ?? [] })),
      deleteAsset: vi.fn(async (assetId: string) => { if (assetId.endsWith('2')) throw new Error('素材不存在'); return { assetId, deletedAt: '2026-10-28T00:00:00.000Z' } }),
      restoreAsset: vi.fn(async (assetId: string) => ({ assetId })),
      purgeAsset: vi.fn(async (assetId: string) => ({ assetId })),
    }
    const refreshAssets = vi.fn(async () => true), setBanner = vi.fn()
    const environment = { assetQueryRef, assetQueryGenerationRef, assetMutationPendingRef, agentMountedRef, currentAssetLibraryScope: () => scope, hostBridge: () => bridge, refreshAssets, setBanner,
      setAssetPage: (update: (value: CanvasAssetPage) => CanvasAssetPage) => { page = update(page) }, setAssetCatalog: (update: (value: CanvasAssetSummary[]) => CanvasAssetSummary[]) => { catalog = update(catalog) } }
    const batch = actualCallback<(action: 'delete' | 'restore' | 'purge', ids: readonly string[], content?: string) => Promise<CanvasAssetMutationResult>>('mutateCanvasAssets', { ...environment, submitCanvasAssetMutation: journal, runCanvasAssetMutationBatch, directAssetMutations: true })
    const rename = actualCallback<(assetId: string, displayName: string) => Promise<void>>('renameCanvasAssetDirectly', environment)
    const metadata = actualCallback<(assetId: string, input: { favorite?: boolean; tags?: string[] }) => Promise<void>>('updateCanvasAssetMetadataDirectly', environment)
    return { batch, rename, metadata, bridge, journal, refreshAssets, setBanner, agentMountedRef, page: () => page, catalog: () => catalog, scope(value: string) { scope = value } }
  }
  it('moves to and restores from the recycle bin through the original per-asset methods with partial outcomes', async () => {
    const f = directFixture()
    const removed = await f.batch('delete', [id(1), id(2), id(3)])
    expect(removed.outcomes.map((item) => item.state)).toEqual(['succeeded', 'unconfirmed', 'succeeded'])
    expect(f.bridge.deleteAsset.mock.calls.map(([assetId]) => assetId)).toEqual([id(1), id(2), id(3)]); expect(f.refreshAssets).toHaveBeenCalledOnce()
    expect((await f.batch('restore', [id(1)])).outcomes[0].state).toBe('succeeded'); expect(f.bridge.restoreAsset).toHaveBeenCalledExactlyOnceWith(id(1))
    expect(f.journal).not.toHaveBeenCalled()
  })
  it('renames, tags and favorites through the original methods with the old desktop notices', async () => {
    const f = directFixture()
    await f.rename(id(1), '新名称')
    expect(f.bridge.renameAsset).toHaveBeenCalledWith({ assetId: id(1), displayName: '新名称' }); expect(f.page().items[0].displayName).toBe('新名称'); expect(f.catalog()[0].displayName).toBe('新名称')
    expect(f.setBanner).toHaveBeenLastCalledWith('素材名称已更新')
    await f.metadata(id(1), { tags: ['产品'] }); expect(f.page().items[0].tags).toEqual(['产品']); expect(f.setBanner).toHaveBeenLastCalledWith('素材标签已更新')
    await f.metadata(id(1), { favorite: true }); expect(f.page().items[0].favorite).toBe(true); expect(f.setBanner).toHaveBeenLastCalledWith('已收藏素材')
    await f.metadata(id(1), { favorite: false }); expect(f.setBanner).toHaveBeenLastCalledWith('已取消收藏')
    expect(f.refreshAssets).toHaveBeenCalledTimes(4); expect(f.journal).not.toHaveBeenCalled()
  })
  it('keeps the desktop tag limits in front of the original method', async () => {
    const f = directFixture()
    for (const tags of [Array.from({ length: 13 }, (_, index) => `标签${index}`), ['长'.repeat(33)], ['产品', '产品']]) await expect(f.metadata(id(1), { tags })).rejects.toThrow('最多 12 个不重复标签，每个不超过 32 个字符')
    expect(f.bridge.updateAssetMetadata).not.toHaveBeenCalled()
    await f.metadata(id(1), { tags: Array.from({ length: 12 }, (_, index) => `标签${index}`) }); expect(f.bridge.updateAssetMetadata).toHaveBeenCalledOnce()
  })
  it('does not patch a late reply into a library that moved to another project or unmounted', async () => {
    for (const change of ['scope', 'unmount'] as const) {
      const f = directFixture(), gate = deferred<{ assetId: string; displayName: string }>()
      f.bridge.renameAsset.mockImplementationOnce(() => gate.promise)
      const running = f.rename(id(1), '迟到的名称')
      if (change === 'scope') f.scope('owner-a:project-b:2'); else f.agentMountedRef.current = false
      gate.resolve({ assetId: id(1), displayName: '迟到的名称' }); await running
      expect(f.page().items[0].displayName).toBe('原名'); expect(f.setBanner).not.toHaveBeenCalled(); expect(f.refreshAssets).not.toHaveBeenCalled()
    }
  })
})
