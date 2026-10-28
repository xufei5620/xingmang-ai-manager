import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { assetCategoryRequestDigest, type AssetCategoryDirectory, type AssetCategoryInput, type AssetCategoryOperationInspection, type AssetCategoryResult } from '../lib/asset-category-contract'
import { createAssetCategoryRecovery, type AssetCategoryRecoveryLock } from '../lib/asset-category-recovery'
import type { AssetCategoryRecoveryHookOptions } from '../lib/asset-category-recovery-hook'
import type { CanvasAssetQuery } from '../host'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualCallback<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!expression) throw new Error(`Missing actual callback: ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
const categoryId = '11111111-1111-4111-8111-111111111111'
function directory(version = 1): AssetCategoryDirectory { return { version: 1, items: [{ id: categoryId, name: '产品', version, createdAt: '', updatedAt: '', counts: { active: 1, trash: 0 } }], uncategorized: { active: 2, trash: 0 } } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { resolve, promise } }

describe('actual CanvasWorkspace asset category callbacks', () => {
  it('captures a confirmed upload destination version and does not guess while the directory is stale', () => {
    const assetQueryRef = { current: {} as CanvasAssetQuery }, assetCategoryStateRef = { current: { scope: 'owner-a', directory: directory(7), loading: false, error: '' } }
    const target = actualCallback<() => unknown>('currentAssetCategoryUploadTarget', { assetQueryRef, assetCategoryStateRef, currentAssetCategoryOwnerScope: () => 'owner-a' })
    expect(target()).toBeUndefined(); assetQueryRef.current.categoryId = null; expect(target()).toEqual({ categoryId: null })
    assetQueryRef.current.categoryId = categoryId; expect(target()).toEqual({ categoryId, expectedCategoryVersion: 7 })
    assetCategoryStateRef.current.loading = true; expect(target).toThrow('刷新并确认'); assetCategoryStateRef.current.loading = false
    assetCategoryStateRef.current.scope = 'owner-b'; expect(target).toThrow('刷新并确认')
  })
  it('keeps the latest directory and its loading state when old reads resolve after it', async () => {
    let scope = 'owner-a', state = { scope, directory: null as AssetCategoryDirectory | null, loading: false, error: '' }
    const first = deferred<AssetCategoryDirectory>(), second = deferred<AssetCategoryDirectory>(), listAssetCategories = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const changeAssetQuery = vi.fn(), environment = { hostBridge: () => ({ listAssetCategories }), currentAssetCategoryOwnerScope: () => scope, assetCategoryReadRef: { current: { revision: 0, controller: null as AbortController | null } }, agentMountedRef: { current: true }, assetQueryRef: { current: {} }, changeAssetQuery, setAssetCategoryState: (next: typeof state | ((previous: typeof state) => typeof state)) => { state = typeof next === 'function' ? next(state) : next } }
    const read = actualCallback<() => Promise<AssetCategoryDirectory>>('readAssetCategories', environment)
    const a = read(); const rejected = expect(a).rejects.toThrow('会话已变化'); const b = read(); second.resolve(directory(2)); await b; first.resolve(directory(1)); await rejected
    expect(state.directory?.items[0].version).toBe(2); expect(state.loading).toBe(false); expect(changeAssetQuery).not.toHaveBeenCalled()
    const pending = deferred<AssetCategoryDirectory>(); listAssetCategories.mockImplementationOnce(() => pending.promise); const c = read(); const stale = expect(c).rejects.toThrow('会话已变化'); scope = 'owner-b'; pending.resolve(directory(3)); await stale; expect(state.directory?.items[0].version).toBe(2)
  })
  it('resets a removed selected category to uncategorized only after an authoritative directory read', async () => {
    const changeAssetQuery = vi.fn(), assetQueryRef = { current: { categoryId, search: '产品', offset: 24 } }
    const read = actualCallback<() => Promise<AssetCategoryDirectory>>('readAssetCategories', { hostBridge: () => ({ listAssetCategories: async () => ({ version: 1, items: [], uncategorized: { active: 2, trash: 0 } }) }), currentAssetCategoryOwnerScope: () => 'owner-a', assetCategoryReadRef: { current: { revision: 0, controller: null } }, agentMountedRef: { current: true }, assetQueryRef, changeAssetQuery, setAssetCategoryState: vi.fn() })
    await read(); expect(changeAssetQuery).toHaveBeenCalledExactlyOnceWith({ categoryId: null, search: '产品', offset: 0 })
  })
  it('journals the exact original at workspace level and restores it after the tray and page unmount without replaying', async () => {
    const ownerId = '33333333-3333-4333-8333-333333333333', values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const lock: AssetCategoryRecoveryLock = { async run<T>(_name: string, _signal: AbortSignal, work: () => Promise<T>): Promise<T> { return await work() } }
    const input: AssetCategoryInput = { action: 'move', operationId: '22222222-2222-4222-8222-222222222222', assets: [{ assetId: 'a'.repeat(43), expectedOrganizationVersion: 4 }], categoryId: null }
    const result: AssetCategoryResult = { action: 'move', operationId: input.operationId, requestDigest: await assetCategoryRequestDigest(input), assignments: [{ assetId: input.assets[0].assetId, organizationVersion: 5, categoryId: null }] }
    const submitAssetCategoryOperation = vi.fn(async (_input: AssetCategoryInput, _signal?: AbortSignal): Promise<AssetCategoryResult> => {
      expect([...values.values()].map((raw) => JSON.parse(raw).input)).toEqual([input])
      throw new Error('响应丢失')
    })
    const inspectAssetCategoryOperation = vi.fn(async (original: AssetCategoryInput, _signal?: AbortSignal): Promise<AssetCategoryOperationInspection> => ({ status: 'applied', operationId: original.operationId, requestDigest: result.requestDigest, result }))
    const options = actualCallback<AssetCategoryRecoveryHookOptions>('assetCategoryRecovery', { creationOwnerId: ownerId, assetCategorySupported: true, draftActionsEnabled: true, submitAssetCategoryOperation, inspectAssetCategoryOperation })
    expect(options.ownerId).toBe(ownerId); expect(options.active).toBe(true)
    function openPage() { return createAssetCategoryRecovery({ ...options, ownerId, active: () => options.active, storage: () => storage, lock }) }
    const page = openPage()
    await expect(page.submit(input)).rejects.toThrow('响应丢失')
    expect(page.snapshot().pending).toEqual(input)
    page.dispose()
    const reopened = openPage()
    await reopened.load()
    expect(reopened.snapshot().pending).toEqual(input)
    expect(submitAssetCategoryOperation).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal))
    expect(inspectAssetCategoryOperation).not.toHaveBeenCalled()
    await reopened.inspect(input)
    expect(inspectAssetCategoryOperation).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal))
    expect(submitAssetCategoryOperation).toHaveBeenCalledOnce(); expect(reopened.snapshot().pending).toBeUndefined(); expect(values.size).toBe(0)
    reopened.dispose()
  })
  it('binds recovery to the public account and disables submissions when support or editing is unavailable', () => {
    for (const [assetCategorySupported, draftActionsEnabled] of [[false, true], [true, false], [false, false]]) {
      const options = actualCallback<AssetCategoryRecoveryHookOptions>('assetCategoryRecovery', { creationOwnerId: null, assetCategorySupported, draftActionsEnabled, submitAssetCategoryOperation: vi.fn(), inspectAssetCategoryOperation: vi.fn() })
      expect(options.ownerId).toBeNull(); expect(options.active).toBe(false)
    }
  })
  it('does not accept late management success after the account scope has changed', async () => {
    let scope = 'owner-a'; const gate = deferred<unknown>()
    const submit = actualCallback<(input: AssetCategoryInput) => Promise<unknown>>('submitAssetCategoryOperation', { currentAssetCategoryOwnerScope: () => scope, hostBridge: () => ({ manageAssetCategories: () => gate.promise }), draftActionsEnabledRef: { current: true }, agentMountedRef: { current: true } })
    const input: AssetCategoryInput = { action: 'create-category', operationId: '22222222-2222-4222-8222-222222222222', name: '产品' }, request = submit(input)
    scope = 'owner-b'; gate.resolve({}); await expect(request).rejects.toThrow('核对原分类操作')
  })
})
