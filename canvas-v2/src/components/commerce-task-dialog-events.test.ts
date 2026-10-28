import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import { defaultCommerceTask } from '../commerce/commerce-task'
import { buildCommerceTaskSubmission, chooseCommerceTaskAsset, commerceTaskReferences, type CommerceTaskGenerationDraft, type CommerceTaskReferenceDraft } from './commerce-task-ui'
import { isTemplateImageAsset } from './template-asset-picker-model'

function actual<T>(name: string, environment: Record<string, unknown>): T {
  const source = ts.createSourceFile('CommerceTaskDialog.tsx', readFileSync(new URL('./CommerceTaskDialog.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function image(id = 'a'.repeat(43)): CanvasImageAssetSummary { return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, thumbnailUrl: `xingmang-asset://thumb/v2/image/${id}`, mimeType: 'image/png', fileName: '商品.png', createdAt: '2026-10-16T00:00:00.000Z', width: 1024, height: 1024 } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail }); return { promise, resolve, reject } }
function fixture() {
  const task = defaultCommerceTask('material-b'), references = chooseCommerceTaskAsset(commerceTaskReferences(task, []), 'source', image())
  const state = { current: { task, references, views: ['front' as const], prompt: '', autoAnalyze: false, generation: { model: 'gpt-image-2', size: 'auto', imageResolution: '1K', quality: 'low', imageCandidateCount: 1 } as CommerceTaskGenerationDraft, numericErrors: {} as Record<string, string> } }
  const current = { current: { scopeKey: 'owner:project:1', isCurrent: () => true, onApply: vi.fn(async (_value: unknown): Promise<void> => undefined), onClose: vi.fn(), onPickAsset: vi.fn(async (): Promise<CanvasImageAssetSummary | null> => image()), onReadAsset: vi.fn(async (assetId: string, _signal?: AbortSignal): Promise<CanvasImageAssetSummary> => image(assetId)), analysisUnavailableReason: '' } }, props = { mode: 'create' }
  const alive = { current: true }, submitting = { current: false }, completed = { current: false }, importPending = { current: false }, requestEpoch = { current: 0 }, initialScope = { current: 'owner:project:1' }, assetRead = { current: null as AbortController | null }
  const env: Record<string, unknown> = { props, current, state, alive, submitting, completed, importPending, requestEpoch, initialScope, assetRead, defaultCommerceTask, commerceTaskReferences, editable: true, buildCommerceTaskSubmission, chooseCommerceTaskAsset, isTemplateImageAsset, setBusy: vi.fn(), setError: vi.fn(), setImporting: vi.fn(), setResolving: vi.fn(), setPicker: vi.fn(), setReferences: vi.fn(), setTask: vi.fn(), setNumericText: vi.fn(), setNumericErrors: vi.fn() }
  env.active = actual('active', env); env.cancelAssetRead = actual('cancelAssetRead', env); env.chooseAsset = actual('chooseAsset', env); env.updateTask = actual('updateTask', env)
  return { env, props, current, state, alive, submitting, completed, importPending, requestEpoch, initialScope, assetRead, chooseKind: actual<(kind: string) => void>('chooseKind', env), closePicker: actual<() => void>('closePicker', env), apply: actual<() => Promise<void>>('apply', env), upload: actual<(role: 'source' | 'reference') => Promise<void>>('importAsset', env), close: actual<() => void>('close', env), number: actual<(key: 'strength' | 'upscale', value: string) => void>('changeNumber', env), choose: env.chooseAsset as (role: 'source' | 'reference', asset: CanvasImageAssetSummary) => Promise<void> }
}

describe('actual commerce dialog callbacks', () => {
  it('freezes one submitted plan and ignores both in-flight and already-successful double clicks', async () => { const f = fixture(), pending = deferred<void>(); f.current.current.onApply.mockImplementation(async () => pending.promise); const first = f.apply(); await f.apply(); f.close(); expect(f.current.current.onApply).toHaveBeenCalledTimes(1); expect(f.current.current.onClose).not.toHaveBeenCalled(); pending.resolve(); await first; await f.apply(); expect(f.current.current.onApply).toHaveBeenCalledTimes(1); expect(f.current.current.onClose).toHaveBeenCalledOnce() })
  it('preserves invalid number state when another parameter changes before a render', async () => { const f = fixture(); f.number('strength', ''); f.number('upscale', '1.5'); expect(f.state.current.numericErrors.strength).not.toBe(''); expect(f.state.current.task).toMatchObject({ upscale: 1.5 }); await f.apply(); expect(f.current.current.onApply).not.toHaveBeenCalled(); f.number('strength', '.6'); await f.apply(); expect(f.current.current.onApply).toHaveBeenCalledOnce(); expect(f.current.current.onApply.mock.calls[0][0]).toMatchObject({ tasks: [{ strength: .6, upscale: 1.5 }] }) })
  it.each(['account', 'project', 'permission', 'unmounted'] as const)('does not publish late upload after %s changes', async (change) => { const f = fixture(), pending = deferred<CanvasImageAssetSummary | null>(); f.current.current.onPickAsset.mockImplementation(async () => pending.promise); const upload = f.upload('source'); if (change === 'account' || change === 'project') f.current.current.scopeKey = change; if (change === 'permission') f.current.current.isCurrent = () => false; if (change === 'unmounted') f.alive.current = false; pending.resolve(image('b'.repeat(43))); await upload; expect(f.state.current.references[0].asset?.assetId).toBe(image().assetId); expect(f.env.setReferences).not.toHaveBeenCalled(); expect(f.current.current.onApply).not.toHaveBeenCalled() })
  it('cancels the dialog during upload without pretending to cancel an accepted asset import', async () => { const f = fixture(), pending = deferred<CanvasImageAssetSummary | null>(); f.current.current.onPickAsset.mockImplementation(async () => pending.promise); const upload = f.upload('source'); f.close(); expect(f.current.current.onClose).toHaveBeenCalledOnce(); pending.resolve(image('b'.repeat(43))); await upload; expect(f.env.setReferences).not.toHaveBeenCalled(); expect(f.current.current.onApply).not.toHaveBeenCalled() })
  it('imports at most once and immediately uses owned upload metadata independently of the library page', async () => { const f = fixture(), pending = deferred<CanvasImageAssetSummary | null>(); f.current.current.onPickAsset.mockImplementation(async () => pending.promise); const upload = f.upload('source'); await f.upload('source'); expect(f.current.current.onPickAsset).toHaveBeenCalledOnce(); pending.resolve(image('b'.repeat(43))); await upload; expect(f.state.current.references[0]).toMatchObject({ binding: { kind: 'asset', assetId: 'b'.repeat(43) } }); expect(f.current.current.onApply).not.toHaveBeenCalled(); await f.apply(); expect(f.current.current.onApply.mock.calls[0][0]).toMatchObject({ references: [{ role: 'source', binding: { kind: 'asset', assetId: 'b'.repeat(43) } }] }) })
  it('retains the prior source on upload failure or file-picker cancellation and reports a real failure', async () => { const f = fixture(); f.current.current.onPickAsset.mockRejectedValueOnce(new Error('上传失败')); await f.upload('source'); expect(f.env.setError).toHaveBeenLastCalledWith('上传失败'); expect(f.state.current.references[0].asset?.assetId).toBe(image().assetId); f.current.current.onPickAsset.mockResolvedValueOnce(null); await f.upload('source'); expect(f.env.setReferences).not.toHaveBeenCalled(); expect(f.importPending.current).toBe(false) })
  it('keeps a failed save retryable but never closes a different scope on a late successful save', async () => { const f = fixture(); f.current.current.onApply.mockRejectedValueOnce(new Error('目标工程已锁定')); await f.apply(); expect(f.env.setError).toHaveBeenLastCalledWith('目标工程已锁定'); expect(f.completed.current).toBe(false); const pending = deferred<void>(); f.current.current.onApply.mockImplementation(async () => pending.promise); const retry = f.apply(); f.current.current.scopeKey = 'new-project'; pending.resolve(); await retry; expect(f.current.current.onClose).not.toHaveBeenCalled(); expect(f.current.current.onApply).toHaveBeenCalledTimes(2) })
  it('rejects automatic analysis when its visible capability is unavailable', async () => { const f = fixture(); f.state.current.autoAnalyze = true; f.current.current.analysisUnavailableReason = '请先配置支持图片理解的文字模型'; await f.apply(); expect(f.current.current.onApply).not.toHaveBeenCalled(); expect(f.env.setError).toHaveBeenLastCalledWith('请先配置支持图片理解的文字模型') })
  it('does not call graph callbacks when canceling a changed draft', () => { const f = fixture(); f.number('strength', '.8'); f.close(); expect(f.current.current.onClose).toHaveBeenCalledOnce(); expect(f.current.current.onApply).not.toHaveBeenCalled() })
})


describe('selected commerce asset dimension hydration', () => {
  function withoutSize(id = 'b'.repeat(43)): CanvasImageAssetSummary { const { width: _width, height: _height, ...asset } = image(id); return asset }
  it('uses complete selected metadata without reading any asset details', async () => {
    const f = fixture(); await f.choose('source', image('b'.repeat(43)))
    expect(f.current.current.onReadAsset).not.toHaveBeenCalled()
    expect(f.state.current.references[0].asset).toEqual(image('b'.repeat(43)))
  })
  it('reads only the explicitly selected image and blocks duplicate selection, uploads and save until verified', async () => {
    const f = fixture(), pending = deferred<CanvasImageAssetSummary>(); f.current.current.onReadAsset.mockImplementation(async () => pending.promise)
    const selection = f.choose('source', withoutSize())
    expect(f.current.current.onReadAsset).toHaveBeenCalledOnce()
    expect(f.current.current.onReadAsset.mock.calls[0][0]).toBe('b'.repeat(43))
    expect(f.current.current.onReadAsset.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    await expect(f.choose('source', withoutSize())).rejects.toThrow('正在核对图片')
    await f.upload('source'); await f.apply()
    expect(f.current.current.onPickAsset).not.toHaveBeenCalled(); expect(f.current.current.onApply).not.toHaveBeenCalled()
    expect(f.state.current.references[0].asset?.assetId).toBe(image().assetId)
    pending.resolve({ ...image('b'.repeat(43)), width: 192, height: 128 }); await selection
    expect(f.state.current.references[0].asset).toMatchObject({ width: 192, height: 128 })
    expect(f.assetRead.current).toBeNull()
  })
  it('hydrates a newly uploaded old-format summary before binding and retains dimensions across task kinds', async () => {
    const f = fixture(); f.current.current.onPickAsset.mockResolvedValueOnce(withoutSize())
    f.current.current.onReadAsset.mockResolvedValueOnce({ ...image('b'.repeat(43)), width: 192, height: 128 })
    await f.upload('source'); expect(f.current.current.onReadAsset).toHaveBeenCalledOnce()
    f.chooseKind('material-a')
    const setter = f.env.setReferences as ReturnType<typeof vi.fn>
    const update = setter.mock.calls.at(-1)?.[0] as (refs: CommerceTaskReferenceDraft[]) => CommerceTaskReferenceDraft[]
    expect(update(f.state.current.references)[0].asset).toMatchObject({ assetId: 'b'.repeat(43), width: 192, height: 128 })
    expect(f.importPending.current).toBe(false)
  })
  it.each(['account', 'project', 'permission', 'unmounted'] as const)('rejects a late detail response after %s changes without changing the old binding', async (change) => {
    const f = fixture(), pending = deferred<CanvasImageAssetSummary>(); f.current.current.onReadAsset.mockImplementation(async () => pending.promise)
    const selection = f.choose('source', withoutSize()), rejection = expect(selection).rejects.toThrow('图片选择已取消')
    if (change === 'account' || change === 'project') f.current.current.scopeKey = change
    if (change === 'permission') f.current.current.isCurrent = () => false
    if (change === 'unmounted') f.alive.current = false
    pending.resolve(image('b'.repeat(43))); await rejection
    expect(f.env.setReferences).not.toHaveBeenCalled(); expect(f.state.current.references[0].asset?.assetId).toBe(image().assetId)
  })
  it.each(['picker', 'dialog'] as const)('aborts a pending detail read when closing the %s and rejects its late response', async (target) => {
    const f = fixture(), pending = deferred<CanvasImageAssetSummary>(); f.current.current.onReadAsset.mockImplementation(async () => pending.promise)
    const selection = f.choose('source', withoutSize()), rejection = expect(selection).rejects.toThrow('图片选择已取消')
    const signal = f.current.current.onReadAsset.mock.calls[0][1]
    if (target === 'picker') f.closePicker(); else f.close()
    expect(signal?.aborted).toBe(true)
    pending.resolve(image('b'.repeat(43))); await rejection; expect(f.env.setReferences).not.toHaveBeenCalled()
  })
  it('does not let a cancelled request clear or replace a newer selection', async () => {
    const f = fixture(), first = deferred<CanvasImageAssetSummary>(), second = deferred<CanvasImageAssetSummary>()
    f.current.current.onReadAsset.mockImplementationOnce(async () => first.promise).mockImplementationOnce(async () => second.promise)
    const old = f.choose('source', withoutSize()), rejection = expect(old).rejects.toThrow('图片选择已取消'); f.closePicker()
    const next = f.choose('source', withoutSize('c'.repeat(43))), latest = f.assetRead.current
    first.resolve(image('b'.repeat(43))); await rejection; expect(f.assetRead.current).toBe(latest)
    second.resolve(image('c'.repeat(43))); await next; expect(f.state.current.references[0].asset?.assetId).toBe('c'.repeat(43))
  })
  it.each(['network', 'identity', 'dimensions'] as const)('keeps the original selection and presents the %s error instead of binding incomplete details', async (failure) => {
    const f = fixture()
    if (failure === 'network') f.current.current.onReadAsset.mockRejectedValueOnce(new Error('图片详情读取失败'))
    else f.current.current.onReadAsset.mockResolvedValueOnce(failure === 'identity' ? image('c'.repeat(43)) : withoutSize())
    await expect(f.choose('source', withoutSize())).rejects.toThrow()
    expect(f.env.setError).toHaveBeenLastCalledWith(expect.stringMatching(/失败|不一致|未确认/))
    expect(f.state.current.references[0].asset?.assetId).toBe(image().assetId); expect(f.assetRead.current).toBeNull()
  })
})
