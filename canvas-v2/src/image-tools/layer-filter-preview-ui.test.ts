import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createLayerPreviewScheduler } from './layer-preview-task'
import { layerRasterPreviewSize } from './layer-paint-state'
import { buildLayerFilterPresentationFrame } from './layer-filter-presentation'
import { buildLayerFilterOperation, buildLayerFilterPreview } from './layer-filter-editor-state'
import { defaultWholeLayerFilter } from './layer-whole-filter'
import { createLayerEditorState } from './layer-editor-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { LayerFilterPreview } from './LayerFilterPreview'

const source = ts.createSourceFile('LayerFilterPreview.tsx', readFileSync(new URL('./LayerFilterPreview.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing actual preview function: ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration.replace(/^export /, '')})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(environment)) as T
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
function same(left?: readonly unknown[], right?: readonly unknown[]) { return !!left && !!right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])) }

/** Executes the actual component hooks in node, including dependency cleanup.
 * Canvas painting remains injected; no browser layout or pixel oracle is claimed. */
function frameHarness(environment: Record<string, unknown>) {
  const slots: Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: void | (() => void) }> = []
  let index = 0, effects: Array<() => void> = []
  const hooks = {
    useRef<T>(value: T) { const slot = slots[index++] ?? (slots[index - 1] = { value: { current: value } }); return slot.value as { current: T } },
    useState<T>(initial: T) { const slot = slots[index++] ?? (slots[index - 1] = { value: initial }); return [slot.value as T, (next: T | ((old: T) => T)) => { slot.value = typeof next === 'function' ? (next as (old: T) => T)(slot.value as T) : next }] as const },
    useMemo<T>(create: () => T, deps: readonly unknown[]) { const at = index++, slot = slots[at]; if (!slot || !same(slot.deps, deps)) slots[at] = { deps, value: create() }; return slots[at].value as T },
    useEffect(run: () => void | (() => void), deps: readonly unknown[]) { const at = index++, slot = slots[at]; if (!slot || !same(slot.deps, deps)) { slots[at] = { deps, cleanup: slot?.cleanup }; effects.push(() => { slots[at].cleanup?.(); slots[at].cleanup = run() }) } },
  }
  type Output = ReactElement<{ children: [ReactElement<{ ref: { current: unknown }; style: { visibility: string } }>, unknown] }>
  const component = actual<(props: Record<string, unknown>) => Output>('FilterPreviewFrame', { ...environment, ...hooks, React: { createElement }, layerRasterPreviewSize })
  function render(props: Record<string, unknown>, target: unknown) { index = 0; effects = []; const result = component(props); result.props.children[0].props.ref.current = target; return result }
  function flush() { const queued = effects; effects = []; for (const run of queued) run() }
  function close() { for (const slot of slots) slot.cleanup?.() }
  return { render, flush, close }
}
function recipeFixture() {
  const recipe = createLayerEditorState(defaultImageTransformRecipe('layer') as ImageLayerRecipe, 1).present.recipe
  recipe.outputWidth = 320; recipe.outputHeight = 240
  recipe.layers[0] = { ...recipe.layers[0], width: 2, height: 2, x: -.25, y: -.2, rotation: 30, opacity: .4, blend: 'multiply', content: { kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 } }
  recipe.documentFrame = { version: 1, width: 640, height: 480, offsetX: 80, offsetY: 60 }
  return recipe
}
function fixture() {
  const recipe = recipeFixture(), frame = buildLayerFilterPresentationFrame(recipe, 0), pending = deferred(), scheduler = createLayerPreviewScheduler(), tasks: Array<ReturnType<typeof scheduler.schedule>> = []
  const target = { width: 640, height: 480 }, temporary = { width: 640, height: 480 }, context = { marker: 'temporary context' }
  const environment = {
    layerPreviewScheduler: { schedule: ((input) => { const task = scheduler.schedule(input); tasks.push(task); return task }) as typeof scheduler.schedule },
    createPreviewCanvas: vi.fn(() => temporary), disposePreviewCanvas: vi.fn(), previewContext: vi.fn(() => context), publishPreviewCanvas: vi.fn(), paintBrowserImageLayerFullPreview: vi.fn(() => pending.promise),
  }
  const onStatus = vi.fn(), props = { recipe, frame, layerIndex: 0, source: undefined, sourceError: '', visible: true, revision: 0, onStatus }
  const harness = frameHarness(environment)
  function render(next: Record<string, unknown> = props, flush = true) { const result = harness.render(next, target); if (flush) harness.flush(); return result }
  return { ...environment, ...harness, recipe, frame, props, onStatus, tasks, target, temporary, context, pending, render }
}

describe('full filter preview actual component cache and lifecycle', () => {
  it('uses the untouched document and transform domain and publishes only a complete upright frame', async () => {
    const f = fixture(), before = structuredClone(f.recipe)
    expect(f.render().props.children[0].props.style.visibility).toBe('hidden'); await Promise.resolve()
    expect(f.paintBrowserImageLayerFullPreview).toHaveBeenCalledExactlyOnceWith(f.context, { recipe: f.recipe, layerIndex: 0, source: undefined, signal: expect.any(AbortSignal) })
    expect(f.publishPreviewCanvas).not.toHaveBeenCalled(); expect(f.onStatus).toHaveBeenLastCalledWith({ busy: true, error: '' })
    f.pending.resolve(); await f.tasks[0].done
    expect(f.render().props.children[0].props.style.visibility).toBe('visible')
    expect(f.publishPreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.target, f.temporary); expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.temporary)
    expect(f.onStatus).toHaveBeenLastCalledWith({ busy: false, error: '' }); expect(f.recipe).toEqual(before); f.close()
  })
  it('keeps completed before and after caches through repeated visibility switches without repainting', async () => {
    const before = fixture(), after = fixture()
    before.render({ ...before.props, visible: false }); after.render(); before.pending.resolve(); after.pending.resolve(); await Promise.all([before.tasks[0].done, after.tasks[0].done])
    before.render({ ...before.props, visible: true }); after.render({ ...after.props, visible: false })
    const resumedStatus = vi.fn(); after.render({ ...after.props, onStatus: resumedStatus }); before.render({ ...before.props, visible: false })
    expect(resumedStatus).toHaveBeenCalledExactlyOnceWith({ busy: false, error: '' })
    expect(before.paintBrowserImageLayerFullPreview).toHaveBeenCalledOnce(); expect(after.paintBrowserImageLayerFullPreview).toHaveBeenCalledOnce()
    before.close(); after.close()
  })
  it('invalidates cached success on recipe changes and retry without reusing prior pixels', async () => {
    const f = fixture(); f.render(); f.pending.resolve(); await f.tasks[0].done; f.render()
    const pending = deferred(); f.paintBrowserImageLayerFullPreview.mockImplementation(() => pending.promise)
    const nextRecipe = { ...f.recipe, layers: [{ ...f.recipe.layers[0], name: 'changed recipe' }] }, props = { ...f.props, recipe: nextRecipe }
    expect(f.render(props).props.children[0].props.style.visibility).toBe('hidden'); expect(f.onStatus).toHaveBeenLastCalledWith({ busy: true, error: '' })
    pending.resolve(); await f.tasks[1].done; f.render(props)
    expect(f.render({ ...props, revision: 1 }).props.children[0].props.style.visibility).toBe('hidden'); expect(f.tasks).toHaveLength(3); f.close(); await f.tasks[2].done
  })
  it.each(['unmount', 'render-before-cleanup'] as const)('discards an unfinished frame after %s', async (reason) => {
    const f = fixture(); f.render(); await Promise.resolve()
    if (reason === 'unmount') f.close()
    else f.render({ ...f.props, recipe: { ...f.recipe } }, false)
    f.pending.resolve(); await f.tasks[0].done
    expect(f.publishPreviewCanvas).not.toHaveBeenCalled(); expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.temporary); expect(f.onStatus).not.toHaveBeenCalledWith({ busy: false, error: '' }); f.close()
  })
  it('reports source and renderer failures without issuing a successful apply receipt', async () => {
    const f = fixture(); f.render({ ...f.props, sourceError: '素材已不可用' }); expect(f.tasks).toHaveLength(0); expect(f.onStatus).toHaveBeenLastCalledWith({ busy: false, error: '素材已不可用' })
    f.paintBrowserImageLayerFullPreview.mockRejectedValueOnce(new Error('原图读取超时')); f.render(); await f.tasks[0].done; f.render()
    expect(f.onStatus).toHaveBeenLastCalledWith({ busy: false, error: '原图读取超时' }); expect(f.publishPreviewCanvas).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalledWith({ busy: false, error: '' }); f.close()
  })
  it('waits for the current source image before scheduling and passes decoded dimensions once available', async () => {
    const f = fixture(), recipe = { ...f.recipe, layers: [{ ...f.recipe.layers[0], content: undefined }] }, props = { ...f.props, recipe }
    f.render(props); expect(f.tasks).toHaveLength(0)
    const source = { image: { naturalWidth: 640, naturalHeight: 480 }, width: 640, height: 480 }
    f.render({ ...props, source }); await Promise.resolve()
    expect(f.paintBrowserImageLayerFullPreview).toHaveBeenCalledWith(f.context, expect.objectContaining({ recipe, source })); f.close(); f.pending.resolve(); await f.tasks[0].done
  })
})

describe('full filter preview source identity and presentation', () => {
  it.each(['changed', 'unmounted'] as const)('rejects a decoded source callback after %s identity', (reason) => {
    const environment = { alive: { current: reason !== 'unmounted' }, currentKey: { current: reason === 'changed' ? 'b' : 'a' }, sourceKey: 'a', image: { onLoad: vi.fn() }, setDecoded: vi.fn(), failed: vi.fn() }
    actual<(image: unknown) => void>('loaded', environment)({ naturalWidth: 640, naturalHeight: 480 }); actual<() => void>('failed', environment)()
    expect(environment.setDecoded).not.toHaveBeenCalled(); expect(environment.image.onLoad).not.toHaveBeenCalled()
  })
  it('retains explicit source failure and refuses a zero-size decode', () => {
    const environment = { alive: { current: true }, currentKey: { current: 'a' }, sourceKey: 'a', image: { onLoad: vi.fn() }, setDecoded: vi.fn(), failed: vi.fn() }
    actual<(image: unknown) => void>('loaded', environment)({ naturalWidth: 0, naturalHeight: 480 }); expect(environment.failed).toHaveBeenCalledOnce(); expect(environment.image.onLoad).not.toHaveBeenCalled()
    actual<() => void>('failed', environment)(); expect(environment.setDecoded).toHaveBeenCalledWith({ key: 'a', error: expect.stringContaining('读取失败') })
  })
  it('presents full native geometry and an optional inverse-mapped document outline without modifying recipes', () => {
    const recipe = recipeFixture(), saved = structuredClone(recipe), operation = buildLayerFilterOperation(recipe, 0, defaultWholeLayerFilter('gaussian')), preview = buildLayerFilterPreview(recipe, 0, operation)
    expect(preview.error).toBe(''); expect(preview.frame).toMatchObject({ width: 640, height: 480 }); expect(preview.recipe.documentFrame).toEqual(recipe.documentFrame); expect(preview.recipe.outputWidth).toBe(320); expect(preview.recipe.layers[0]).toMatchObject({ x: -.25, y: -.2, rotation: 30, opacity: .4, blend: 'multiply' }); expect(recipe).toEqual(saved)
    const props = { recipe, afterRecipe: preview.recipe, layerIndex: 0, images: [], frame: preview.frame!, before: false, revision: 0, onRasterStatus: vi.fn() }
    const shown = renderToStaticMarkup(createElement(LayerFilterPreview, { ...props, documentOutline: true })), hidden = renderToStaticMarkup(createElement(LayerFilterPreview, { ...props, documentOutline: false }))
    expect(shown).toContain('viewBox="0 0 640 480"'); expect(shown).toContain(`points="${preview.frame!.documentPolygon.map((point) => point.join(',')).join(' ')}"`); expect(hidden).not.toContain('<polygon'); expect((shown.match(/<canvas/g) ?? [])).toHaveLength(2)
  })
  it('turns unsupported full presentation bounds into an explicit error without a rendering exception', () => {
    const recipe = recipeFixture(); recipe.layers[0].width = 30
    expect(buildLayerFilterPreview(recipe, 0, null)).toMatchObject({ recipe, frame: null, error: expect.stringContaining('4096') })
  })
})
