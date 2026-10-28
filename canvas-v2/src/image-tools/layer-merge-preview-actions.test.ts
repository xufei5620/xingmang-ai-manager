import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { buildEditorLayerMergeCandidate, buildEditorLayerMergePlan } from './layer-editor-merge'
import { createLayerEditorState, defaultEditorImageLayer, selectEditorLayer } from './layer-editor-state'
import type { ImageLayerRecipe } from './recipe'
import type { LayerPreviewSampler, LayerToolImage } from './layerpreview'
import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import type { renderBrowserEditorLayerMerge } from '../library/browser-layer-merge'
import type { reviewBrowserEditorLayerMerge } from '../library/browser-layer-merge-review'
import { materializeImageLayerGroups } from './layer-group-model'

const source = ts.createSourceFile('layerpreview.tsx', readFileSync(new URL('./layerpreview.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualSampler(environment: Record<string, unknown>): LayerPreviewSampler {
  let callback = ''
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'useImperativeHandle') callback = node.arguments[1].getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!callback) throw new Error('Missing actual sampler callback')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${callback})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as LayerPreviewSampler
}
function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 100, outputHeight: 80, explicitLayers: true, background: 'transparent', layers: [{ ...defaultEditorImageLayer(0) }, { ...defaultEditorImageLayer(0), opacity: .5 }, defaultEditorImageLayer(1)] }
  const state = selectEditorLayer(selectEditorLayer(createLayerEditorState(recipe, 2), 'layer-1'), 'layer-2', { range: true }), plan = buildEditorLayerMergePlan(state.present)
  const image: LayerToolImage = { key: 'own', label: 'Own image', asset: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }, dimensions: { width: 100, height: 80 }, dimensionsReady: true, onLoad() {} }
  const sourceKey = (value: LayerToolImage) => JSON.stringify([value.key, value.asset.assetId, value.asset.localUrl])
  const backdrop: LayerToolImage = { ...image, key: 'backdrop', asset: { ...image.asset, assetId: 'b'.repeat(43), localUrl: `xingmang-asset://image/${'b'.repeat(43)}` } }
  const decoded = { naturalWidth: 100, naturalHeight: 80 }, backdropDecoded = { naturalWidth: 200, naturalHeight: 160 }, sources = { current: new Map([[sourceKey(image), decoded], [sourceKey(backdrop), backdropDecoded]]) }, failed = new Set<string>(), images = [image, backdrop]
  const lut: { busy: boolean; error: string; tables: Map<string, never> } = { busy: false, error: '', tables: new Map<string, never>() }
  const render = vi.fn<typeof renderBrowserEditorLayerMerge>(async () => ({ blob: new Blob(), width: 100, height: 80 }))
  const review = vi.fn<typeof reviewBrowserEditorLayerMerge>(async () => { throw new Error('Reached owned renderer') }), mergeReviewContext = {}, mergeContextRef: { current: object | null } = { current: mergeReviewContext }
  const sampler = actualSampler({ recipe: state.present.recipe, layers: state.present.recipe.layers, lut, images, sources, sourceKey, failed, resolveCanvasAssetDisplayUrl, renderBrowserEditorLayerMerge: render, reviewBrowserEditorLayerMerge: review, materializeImageLayerGroups, mergeReviewContext, mergeContextRef })
  return { state, plan, sampler, render, review, decoded, backdropDecoded, image, backdrop, images, sources, sourceKey, failed, lut, mergeReviewContext, mergeContextRef }
}

describe('actual preview merge sampler', () => {
  it('passes only selected already-decoded owned sources and prepared LUT tables into the bounded renderer', async () => {
    const f = fixture(), controller = new AbortController()
    await f.sampler.mergeLayers(f.plan, controller.signal)
    expect(f.render).toHaveBeenCalledOnce()
    const [plan, input] = f.render.mock.calls[0]
    expect(plan).toBe(f.plan)
    expect(input.signal).toBe(controller.signal)
    expect(input.lutTables).toBe(f.lut.tables)
    expect([...input.sources.entries()]).toEqual([[0, { image: f.decoded, width: 100, height: 80 }]])
    expect(f.sources.current.size).toBe(2)
  })
  it.each(['recipe', 'lut-loading', 'lut-error', 'missing-image', 'failed-image', 'unsafe-url', 'not-decoded'] as const)('refuses %s before rasterization or upload', async (failure) => {
    const f = fixture()
    if (failure === 'recipe') f.plan.recipe = structuredClone(f.plan.recipe)
    if (failure === 'lut-loading') f.lut.busy = true
    if (failure === 'lut-error') f.lut.error = '本人调色表暂不可用'
    if (failure === 'missing-image') f.images.length = 0
    if (failure === 'failed-image') f.failed.add(f.sourceKey(f.image))
    if (failure === 'unsafe-url') f.image.asset.localUrl = 'https://untrusted.invalid/secret.png'
    if (failure === 'not-decoded') f.sources.current.clear()
    await expect(f.sampler.mergeLayers(f.plan, new AbortController().signal)).rejects.toThrow()
    expect(f.render).not.toHaveBeenCalled()
    expect(f.state.past).toHaveLength(0)
  })
  it('captures all visible decoded sources, including an unselected backdrop, for native full-document comparison', async () => {
    const f = fixture(), controller = new AbortController()
    expect(f.sampler.mergeReviewContext).toBe(f.mergeReviewContext)
    await expect(f.sampler.reviewLayerMerge(f.plan, 2, 'layer-4', controller.signal)).rejects.toThrow('Reached owned renderer')
    expect(f.review).toHaveBeenCalledOnce()
    const [plan, input] = f.review.mock.calls[0]
    expect(plan).toBe(f.plan)
    expect(input).toMatchObject({ sourceIndex: 2, replacementId: 'layer-4', signal: controller.signal, lutTables: f.lut.tables })
    expect([...input.sources]).toEqual([[0, { image: f.decoded, width: 100, height: 80 }], [1, { image: f.backdropDecoded, width: 200, height: 160 }]])
    expect(f.state.past).toHaveLength(0)
  })
  it.each(['recipe', 'lut-loading', 'lut-error', 'missing-backdrop', 'unsafe-backdrop', 'failed-backdrop', 'backdrop-decoding'] as const)('refuses full-document comparison with %s before rasterization', async (failure) => {
    const f = fixture()
    if (failure === 'recipe') f.plan.recipe = structuredClone(f.plan.recipe)
    if (failure === 'lut-loading') f.lut.busy = true
    if (failure === 'lut-error') f.lut.error = '本人调色表暂不可用'
    if (failure === 'missing-backdrop') f.images.pop()
    if (failure === 'unsafe-backdrop') f.backdrop.asset.localUrl = 'https://untrusted.invalid/secret.png'
    if (failure === 'failed-backdrop') f.failed.add(f.sourceKey(f.backdrop))
    if (failure === 'backdrop-decoding') f.sources.current.delete(f.sourceKey(f.backdrop))
    await expect(f.sampler.reviewLayerMerge(f.plan, 2, 'layer-4', new AbortController().signal)).rejects.toThrow()
    expect(f.review).not.toHaveBeenCalled()
  })
  it.each(['context-changed', 'unmounted', 'cancelled'] as const)('discards an otherwise successful native review after %s', async (failure) => {
    const f = fixture(), controller = new AbortController()
    let resolve!: (value: Awaited<ReturnType<typeof reviewBrowserEditorLayerMerge>>) => void
    f.review.mockImplementation(() => new Promise((done) => { resolve = done }))
    const pending = f.sampler.reviewLayerMerge(f.plan, 2, 'layer-4', controller.signal)
    expect(f.review).toHaveBeenCalledOnce()
    if (failure === 'context-changed') f.mergeContextRef.current = {}
    if (failure === 'unmounted') f.mergeContextRef.current = null
    if (failure === 'cancelled') controller.abort()
    const blob = new Blob(['owned fixture'], { type: 'image/png' })
    resolve({ output: { blob, width: 100, height: 80 }, before: blob, after: blob, difference: blob, candidate: buildEditorLayerMergeCandidate(f.plan, { sourceIndex: 2, replacementId: 'layer-4' }), comparison: { width: 100, height: 80, totalPixels: 8000, changedPixels: 0, maxChannelDelta: 0, meanChannelDelta: 0, rawChangedPixels: 0, rawMaxChannelDelta: 0 } })
    await expect(pending).rejects.toThrow('已变化')
    expect(f.state.past).toHaveLength(0)
  })
  it('retains a visible zero-opacity bitmap source still required by the selected raster recipe', async () => {
    const f = fixture(); f.state.present.recipe.layers[0].opacity = 0
    const plan = buildEditorLayerMergePlan(f.state.present)
    await expect(f.sampler.reviewLayerMerge(plan, 2, 'layer-4', new AbortController().signal)).rejects.toThrow('Reached owned renderer')
    expect(f.review.mock.calls[0][1].sources.get(0)?.image).toBe(f.decoded)
  })
})
