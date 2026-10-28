import { orderCollageInputs } from './collage-input-order'
import { readFileSync } from 'node:fs'
import { createElement, Fragment, isValidElement, type ReactElement } from 'react'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { defaultImageCropEditorPreferences, parseImageCropEditorPreferences, reconcileUnlockedCropOutputRatio, cropRatioModes } from './crop-editor-preferences'
import { adaptCropPresetToSource, assertCropPresetReceipt, buildCropPresetWorkflow, readCropPreset } from './crop-presets'
import { defaultImageTransformRecipe, parseImageTransformRecipe, type ImageCollageRecipe, type ImageCropRecipe } from './recipe'
import { cropOutputRatio, cropPixelRatio, fitCropRatio, resizeCropOutput, rotateCrop, syncCropOutput } from './crop-editor-state'
import { validateImageToolDraft } from './editor-validation'
import { resolveCollageOutputSize } from './collage-layout'

function functionSource(filename: string, name: string) {
  const source = ts.createSourceFile(filename, readFileSync(new URL(filename, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!found) throw new Error(`Missing ${name}`)
  return found
}
function callback(source: string, environment: Record<string, unknown>) {
  const code = ts.transpileModule(`return (${source});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as (...args: unknown[]) => unknown
}
function elements(root: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(root)) return root.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(root)) return []
  return [root, ...elements(root.props.children)]
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const recipe = defaultImageTransformRecipe('crop') as ImageCropRecipe
const preferences = { ...defaultImageCropEditorPreferences(recipe), ratioMode: '自定义' as const, customWidth: 14, customHeight: 9, cropLocked: true, outputLocked: false, outputRatio: 14 / 9, snapping: false }

describe('actual crop recipe editor transaction', () => {
  function editorFixture(source: { width: number; height: number }, initial = recipe, initialPreferences = defaultImageCropEditorPreferences(initial)) {
    const state: unknown[] = []; let cursor = 0
    function useState(value: unknown) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = typeof value === 'function' ? value() : value
      return [state[slot], (next: unknown) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
    }
    const onApply = vi.fn(), onClose = vi.fn()
    const render = callback(functionSource('./ImageToolControls.tsx', 'RecipeEditor'), {
      React: { createElement, Fragment }, useState, defaultImageCropEditorPreferences, parseImageCropEditorPreferences, reconcileUnlockedCropOutputRatio, parseImageTransformRecipe, defaultImageTransformRecipe, validateImageToolDraft,
      cropOutputRatio, cropPixelRatio, cropRatioModes, fitCropRatio, resizeCropOutput, rotateCrop, syncCropOutput, adaptCropPresetToSource,
      CropPresetPanel: 'CropPresetPanel', RecipePreview: 'RecipePreview', CropResultPreview: 'CropResultPreview', NumberField: 'NumberField', ImageCell: 'ImageCell', RotateCcw: 'RotateCcw', RotateCw: 'RotateCw',
    })
    function view() { cursor = 0; return elements(render({ initial, initialPreferences, images: [{ key: 'source', label: 'Source', dimensions: source, dimensionsReady: true }], onApply, onClose })) }
    function choose(mode: string) { (view().find((element) => element.props['aria-label'] === '裁剪比例')!.props.onChange as (event: unknown) => void)({ target: { value: mode } }) }
    function width(value: number) { (view().find((element) => element.props.label === '输出宽度')!.props.onChange as (value: number) => void)(value) }
    function height(value: number) { (view().find((element) => element.props.label === '输出高度')!.props.onChange as (value: number) => void)(value) }
    function lock(checked: boolean) {
      const label = view().find((element) => element.type === 'label' && Array.isArray(element.props.children) && element.props.children.includes('锁定输出宽高比'))!
      ;(elements(label).find((element) => element.type === 'input')!.props.onChange as (event: unknown) => void)({ target: { checked } })
    }
    function click(label: string) { (view().find((element) => element.type === 'button' && (element.props.children === label || Array.isArray(element.props.children) && element.props.children.includes(label)))!.props.onClick as () => void)() }
    return { view, choose, width, height, lock, click, onApply }
  }

  it.each([
    { source: { width: 960, height: 540 }, mode: '4:5', ratio: 4 / 5, width: 800, height: 1000, rotation: 0 as const },
    { source: { width: 603, height: 401 }, mode: '自定义', ratio: 7 / 5, width: 700, height: 500, rotation: 0 as const },
    { source: { width: 960, height: 540 }, mode: '4:5', ratio: 5 / 4, width: 1000, height: 800, rotation: 90 as const },
  ])('keeps the exact output lock through mode selection, size sync, final apply and reopen: %j', ({ source, mode, ratio, width, height, rotation }) => {
    const f = editorFixture(source, { ...recipe, rotation })
    f.choose(mode)
    f.width(width)
    expect(f.view().find((element) => element.props.label === '输出高度')!.props.value).toBe(height)
    f.click('同步裁剪尺寸')
    f.width(width)
    f.click('应用参数')
    const [applied, saved] = f.onApply.mock.calls[0]
    expect(applied).toMatchObject({ outputWidth: width, outputHeight: height, rotation })
    expect(saved.outputRatio).toBeCloseTo(ratio, 12)
    const reopened = editorFixture(source, applied, parseImageCropEditorPreferences(saved))
    reopened.width(width)
    reopened.click('应用参数')
    expect(reopened.onApply.mock.calls[0][0]).toMatchObject({ outputWidth: width, outputHeight: height })
    expect(reopened.onApply.mock.calls[0][1]).toEqual(saved)
  })

  it('retains the real enclosed pixel ratio for a free crop and rejects unrepresentable original ratios without changing the draft', () => {
    const source = { width: 603, height: 401 }
    const f = editorFixture(source, fitCropRatio(recipe, source, 7 / 5))
    f.click('同步裁剪尺寸')
    f.width(700)
    f.click('应用参数')
    expect(f.onApply.mock.calls[0][0]).toMatchObject({ outputWidth: 700, outputHeight: 499 })
    const extreme = editorFixture({ width: 1, height: 16384 })
    extreme.choose('原图')
    expect(extreme.view().find((element) => element.props['aria-label'] === '裁剪比例')!.props.value).toBe('自由')
    expect(extreme.view().find((element) => element.props.role === 'alert')!.props.children).toContain('输出尺寸支持范围')
    extreme.click('应用参数')
    expect(extreme.onApply.mock.calls[0][0]).toEqual(recipe)
  })

  it('relocks a selected exact ratio after unlocked resolution changes and rotation', () => {
    const f = editorFixture({ width: 603, height: 401 })
    f.lock(false)
    f.choose('自定义')
    const resolution = f.view().find((element) => element.type === 'button' && Array.isArray(element.props.children) && element.props.children[0] === 2 && element.props.children[1] === 'K')!
    ;(resolution.props.onClick as () => void)()
    f.lock(true)
    f.width(700)
    expect(f.view().find((element) => element.props.label === '输出高度')!.props.value).toBe(500)
    f.lock(false)
    f.click('右转')
    f.lock(true)
    f.width(500)
    f.click('应用参数')
    expect(f.onApply.mock.calls[0][0]).toMatchObject({ outputWidth: 500, outputHeight: 700, rotation: 90 })
    expect(f.onApply.mock.calls[0][1].outputRatio).toBe(5 / 7)
  })

  it('captures unlocked manual dimensions instead of restoring the previous selected ratio', () => {
    const f = editorFixture({ width: 603, height: 401 })
    f.choose('自定义')
    f.lock(false)
    f.width(800)
    f.height(1000)
    f.lock(true)
    f.width(400)
    f.click('应用参数')
    expect(f.onApply.mock.calls[0][0]).toMatchObject({ outputWidth: 400, outputHeight: 500 })
    expect(f.onApply.mock.calls[0][1].outputRatio).toBe(.8)
  })

  it('reconciles stale unlocked ratios on opening and preset loading without changing their explicit dimensions', () => {
    const source = { width: 960, height: 540 }, savedRecipe = { ...recipe, outputWidth: 800, outputHeight: 1000 }
    const saved = { ...defaultImageCropEditorPreferences(savedRecipe), outputLocked: false, outputRatio: 821 / 1024 }
    for (const loadPreset of [false, true]) {
      const f = editorFixture(source, loadPreset ? recipe : savedRecipe, loadPreset ? undefined : saved)
      if (loadPreset) (f.view().find((element) => element.type === 'CropPresetPanel')!.props.onApply as (value: unknown) => void)({ recipe: savedRecipe, preferences: saved })
      f.lock(true)
      f.width(800)
      f.click('应用参数')
      expect(f.onApply.mock.calls[0][0]).toMatchObject({ outputWidth: 800, outputHeight: 1000 })
      expect(f.onApply.mock.calls[0][1].outputRatio).toBe(.8)
    }
  })

  it('restores editing preferences and applies a loaded preset once only after final confirmation', () => {
    const state: unknown[] = []; let cursor = 0
    function useState(initial: unknown) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      return [state[slot], (next: unknown) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
    }
    const onApply = vi.fn(), onClose = vi.fn()
    const render = callback(functionSource('./ImageToolControls.tsx', 'RecipeEditor'), {
      React: { createElement, Fragment }, useState, defaultImageCropEditorPreferences, parseImageCropEditorPreferences, reconcileUnlockedCropOutputRatio, parseImageTransformRecipe, defaultImageTransformRecipe, validateImageToolDraft, cropPixelRatio, cropRatioModes, adaptCropPresetToSource,
      CropPresetPanel: 'CropPresetPanel', RecipePreview: 'RecipePreview', CropResultPreview: 'CropResultPreview', NumberField: 'NumberField', ImageCell: 'ImageCell', RotateCcw: 'RotateCcw', RotateCw: 'RotateCw',
    })
    const source = { width: 400, height: 600 }
    function view() { cursor = 0; return elements(render({ initial: recipe, initialPreferences: { ...preferences, outputRatio: 1 }, images: [{ key: 'source', label: 'Source', dimensions: source, dimensionsReady: true }], onApply, onClose })) }
    let tree = view()
    expect(tree.find((element) => element.props['aria-label'] === '裁剪比例')?.props.value).toBe('自定义')
    expect(tree.find((element) => element.props.label === '自定义比例宽')?.props.value).toBe(14)
    const panel = tree.find((element) => element.type === 'CropPresetPanel')!
    expect(panel.props.preferences).toEqual({ ...preferences, outputRatio: 1 })
    expect(panel.props.sourceReady).toBe(true)
    const next = { recipe: { ...recipe, x: .1, width: .6, outputWidth: 1600, outputHeight: 900 }, preferences: { ...preferences, ratioMode: '16:9' as const, outputRatio: 16 / 9, snapping: true } }
    const loadPreset = panel.props.onApply as (value: unknown) => void
    loadPreset(next)
    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    tree = view()
    const apply = tree.find((element) => element.type === 'button' && element.props.children === '应用参数')!
    const applyRecipe = apply.props.onClick as () => void
    applyRecipe()
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(adaptCropPresetToSource(next, source).recipe, next.preferences)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it.each([{ images: [] }, { images: [{ dimensions: { width: 1024, height: 1024 }, dimensionsReady: false }] }])('rejects preset loading without measured source dimensions before changing any draft state', ({ images }) => {
    const setRecipe = vi.fn(), setRatio = vi.fn()
    const load = callback(functionSource('./ImageToolControls.tsx', 'loadPreset'), { images, adaptCropPresetToSource, setRecipe, setRatio })
    expect(() => load({ recipe, preferences })).toThrow('原图尺寸')
    expect(setRecipe).not.toHaveBeenCalled()
    expect(setRatio).not.toHaveBeenCalled()
  })
})

describe('actual collage recipe apply validation', () => {
  function fixture(initial: ImageCollageRecipe, count: number, dimensionsReady = true) {
    const state: unknown[] = []; let cursor = 0
    function useState(value: unknown) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = typeof value === 'function' ? value() : value
      return [state[slot], (next: unknown) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
    }
    const onApply = vi.fn(), onClose = vi.fn()
    const render = callback(functionSource('./ImageToolControls.tsx', 'RecipeEditor'), {
      React: { createElement, Fragment }, useState, validateImageToolDraft, resolveCollageOutputSize, orderCollageInputs, CollageInputSorter: 'CollageInputSorter', ImageGridPreview: 'ImageGridPreview',
      RecipePreview: 'RecipePreview', ImageCell: 'ImageCell', NumberField: 'NumberField',
      CollageLayoutControls: 'CollageLayoutControls', CollageStyleControls: 'CollageStyleControls',
    })
    const images = Array.from({ length: count }, (_, index) => ({ key: String(index), label: 'Source', dimensions: { width: 640, height: 480 }, dimensionsReady }))
    function view() { cursor = 0; return elements(render({ initial, images, collageInputs: images.map((image, outputIndex) => ({ ...image, edgeId: 'source-edge', outputIndex, pending: false })), onApply, onClose })) }
    function apply() { (view().find((element) => element.type === 'button' && element.props.children === '应用参数')!.props.onClick as () => void)() }
    return { view, apply, onApply, onClose }
  }

  it('keeps reordered inputs in the local editor draft until one explicit apply', () => {
    const initial = defaultImageTransformRecipe('collage') as ImageCollageRecipe
    const f = fixture(initial, 3)
    const next = { version: 1, slots: [2, 0, 1].map((outputIndex) => ({ edgeId: 'source-edge', outputIndex })) }
    const sorter = f.view().find((element) => element.type === 'CollageInputSorter')!
    ;(sorter.props.onReorder as (value: unknown) => void)(next)
    expect(f.onApply).not.toHaveBeenCalled()
    expect(f.onClose).not.toHaveBeenCalled()
    const reordered = f.view().find((element) => element.type === 'CollageInputSorter')!
    expect((reordered.props.items as Array<{ outputIndex: number }>).map((item) => item.outputIndex)).toEqual([2, 0, 1])
    f.apply()
    expect(f.onApply).toHaveBeenCalledExactlyOnceWith(initial, undefined, next)
    expect(f.onClose).toHaveBeenCalledOnce()
  })

  it('keeps an invalid fixed layout open without applying, and preserves its draft for correction', () => {
    const initial = { ...defaultImageTransformRecipe('collage') as ImageCollageRecipe, layout: 'horizontal' as const, autoSize: false, outputWidth: 40, outputHeight: 40, gap: 50, padding: 0 }
    const f = fixture(initial, 2)
    f.apply()
    expect(f.onApply).not.toHaveBeenCalled()
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.view().find((element) => element.props.role === 'alert')!.props.children).toContain('图片尺寸不足')
    const width = f.view().find((element) => element.props.label === '输出宽度')!
    expect(width.props.value).toBe(40)
    ;(width.props.onChange as (value: number) => void)(200)
    f.apply()
    expect(f.onApply).toHaveBeenCalledExactlyOnceWith({ ...initial, outputWidth: 200 }, undefined)
    expect(f.onClose).toHaveBeenCalledTimes(1)
  })

  it('blocks known input overflow before dimensions load without applying or closing', () => {
    const initial = { ...defaultImageTransformRecipe('collage') as ImageCollageRecipe, rows: 1, columns: 2 }
    const f = fixture(initial, 3, false)
    f.apply()
    expect(f.onApply).not.toHaveBeenCalled()
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.view().find((element) => element.props.role === 'alert')!.props.children).toContain('3')
  })

  it('allows applying an empty reusable automatic template without requiring source dimensions', () => {
    const initial = { ...defaultImageTransformRecipe('collage') as ImageCollageRecipe, layout: 'horizontal' as const, autoSize: true }
    const f = fixture(initial, 0)
    f.apply()
    expect(f.onApply).toHaveBeenCalledExactlyOnceWith(initial, undefined)
    expect(f.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('actual crop preset save and read handlers', () => {
  function fixture() {
    const request = { current: null }, busy = { current: false }, scope = { current: 0 }, readSequence = { current: 0 }
    const item = { id: 'saved-id', kind: 'node', name: '商品裁剪', description: '', category: 'general', tags: [], version: 1, nodeCount: 1, edgeCount: 0, nodeKinds: ['image-crop'], createdAt: 'today', updatedAt: 'today', workflow: buildCropPresetWorkflow('商品裁剪', recipe, preferences) }
    const bridge = { createWorkshopItem: vi.fn(async (_input: unknown) => item), readWorkshopItem: vi.fn(async (_id: string) => item) }
    const environment = { request, busy, scope, readSequence, name: '商品裁剪', recipe, preferences, hostBridge: () => bridge, crypto: { randomUUID: vi.fn(() => 'operation-id') }, buildCropPresetWorkflow, readCropPreset, assertCropPresetReceipt,
      setError: vi.fn(), setSaving: vi.fn(), setSubmitted: vi.fn(), setName: vi.fn(), setNotice: vi.fn(), setOffset: vi.fn(), setRevision: vi.fn(), setReading: vi.fn(), setSelected: vi.fn(), onBusyChange: vi.fn(),
    }
    return { environment, bridge, item, save: callback(functionSource('./CropPresetPanel.tsx', 'save'), environment), read: callback(functionSource('./CropPresetPanel.tsx', 'read'), environment) }
  }
  it('retries an unknown save with the original operation and captured configuration', async () => {
    const f = fixture()
    f.bridge.createWorkshopItem.mockRejectedValueOnce(new Error('timeout'))
    await f.save()
    const original = f.environment.request.current
    expect(original).not.toBeNull()
    f.environment.recipe = { ...recipe, outputWidth: 2048 }
    const retry = callback(functionSource('./CropPresetPanel.tsx', 'save'), f.environment)
    await retry()
    expect(f.bridge.createWorkshopItem.mock.calls.map((call) => call[0])).toEqual([original, original])
    expect(f.environment.crypto.randomUUID).toHaveBeenCalledTimes(1)
    expect(f.environment.request.current).toBeNull()
    expect(f.environment.setNotice).toHaveBeenCalledWith(expect.stringContaining('已保存'))
  })
  it('ignores duplicate submissions and a save receipt after its editor has closed', async () => {
    const f = fixture(), pending = deferred<typeof f.item>()
    f.bridge.createWorkshopItem.mockImplementationOnce(() => pending.promise)
    const first = f.save()
    await f.save()
    expect(f.bridge.createWorkshopItem).toHaveBeenCalledTimes(1)
    f.environment.scope.current++
    pending.resolve(f.item); await first
    expect(f.environment.setName).not.toHaveBeenCalled()
    expect(f.environment.setNotice).not.toHaveBeenCalledWith(expect.stringContaining('已保存'))
  })
  it('does not apply stale detail responses after another preset is selected', async () => {
    const f = fixture(), old = deferred<typeof f.item>()
    f.bridge.readWorkshopItem.mockImplementationOnce(() => old.promise)
    const first = f.read('old-id')
    await f.read('saved-id')
    old.resolve({ ...f.item, id: 'old-id' }); await first
    expect(f.environment.setSelected).toHaveBeenLastCalledWith(f.item)
    expect(f.environment.setSelected).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'old-id' }))
  })
})
