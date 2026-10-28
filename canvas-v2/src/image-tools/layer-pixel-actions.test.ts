import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { canvasRasterSelectionCount, combineCanvasSelections, isCurrentLayerPixelRequest, rasterizeCanvasSelection, type LayerPixelRequest } from './layer-canvas-selection'
import { createLayerEditorState, defaultEditorImageLayer, finishLayerEditorTransaction, redoLayerEditor, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { appendEditorLayerFill, layerPaintTargetError, type LayerCanvasSelection, type LayerCanvasTool, type LayerColorSampleRequest } from './layer-paint-state'
import { selectLayerRasterColors } from './layer-raster-selection'
import type { ImageLayerRecipe } from './recipe'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  environment = { cropSessionRef: { current: null }, ...environment }
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!declaration) throw new Error(`Missing actual handler ${name}`)
  const code = ts.transpileModule(`return (${declaration});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
interface PixelResult { selection?: LayerCanvasSelection; preview?: LayerCanvasSelection; rangeColor?: string; state?: LayerEditorState; color?: string; status: string }
type PixelJob = (label: string, work: (request: LayerPixelRequest) => Promise<PixelResult>) => Promise<void>
function fixture(tool: LayerCanvasTool = 'select-wand', settings: Record<string, unknown> = {}) {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 3, outputHeight: 1, background: 'transparent', layers: [{ ...defaultEditorImageLayer(0), content: { kind: 'paint' } }] }
  const stateRef = { current: createLayerEditorState(recipe, 0) }, sourcesKeyRef = { current: 'sources-v1' }
  const selectionRef: { current: LayerCanvasSelection | null } = { current: null }, toolRef = { current: tool }
  const sampling: { current: LayerColorSampleRequest | null } = { current: null }
  const setState = vi.fn(), setPicking = vi.fn(), setError = vi.fn(), setStatus = vi.fn(), setRangePreview = vi.fn(), setRangeColor = vi.fn(), setSampledColor = vi.fn()
  const setSelection = vi.fn((value: LayerCanvasSelection) => { selectionRef.current = value })
  const pixels = { width: 3, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255]) }
  const sampler = { current: { samplePixels: vi.fn(async () => pixels) } }
  const environment = { stateRef, sourcesKeyRef, selectionRef, toolRef, sampling, setState, setPicking, setError, setStatus, setRangePreview, setRangeColor, setSampledColor, setSelection, sampler, rangePreviewKey: { current: null }, rangeColor: '#ff0000', tolerance: 0, sampleSource: 'composite', combination: 'replace', allSameColor: false, paintSettings: { color: '#00ff00', opacity: 0.5 }, isCurrentLayerPixelRequest, canvasRasterSelectionCount, combineCanvasSelections, rasterizeCanvasSelection, selectLayerRasterColors, layerPaintTargetError, appendEditorLayerFill, finishLayerEditorTransaction, ...settings }
  const cancelSampling = actual<() => void>('cancelSampling', { ...environment, cancelQuickGesture: vi.fn() })
  const runPixelJob = actual<PixelJob>('runPixelJob', { ...environment, cancelSampling })
  return { ...environment, environment: { ...environment, cancelSampling, runPixelJob }, runPixelJob, cancelSampling }
}

describe('actual layer pixel request handlers', () => {
  it.each(['recipe', 'layer', 'source', 'selection', 'tool', 'cancel', 'unmount'] as const)('does not commit a late pixel result after %s changes', async (change) => {
    const f = fixture(), pending = deferred<PixelResult>()
    const before = f.stateRef.current
    const running = f.runPixelJob('计算中', () => pending.promise)
    if (change === 'recipe') f.stateRef.current = { ...before, present: { ...before.present, recipe: structuredClone(before.present.recipe) } }
    if (change === 'layer') f.stateRef.current = { ...before, present: { ...before.present, selectedId: null } }
    if (change === 'source') f.sourcesKeyRef.current = 'sources-v2'
    if (change === 'selection') f.selectionRef.current = { kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: [] } }
    if (change === 'tool') f.toolRef.current = 'bucket'
    if (change === 'cancel') f.cancelSampling()
    if (change === 'unmount') { f.sampling.current?.controller.abort(); f.sampling.current = null }
    pending.resolve({ state: before, selection: { kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: [0, 3] } }, preview: { kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: [0, 3] } }, color: '#ff0000ff', status: '完成' })
    await running
    expect(f.setState).not.toHaveBeenCalled()
    expect(f.setSelection).not.toHaveBeenCalled()
    expect(f.setRangePreview).not.toHaveBeenCalled()
    expect(f.setSampledColor).not.toHaveBeenCalled()
    expect(f.setStatus).not.toHaveBeenCalledWith('完成')
  })

  it('allows the newest request only and reports budget failures without changing edits', async () => {
    const f = fixture(), old = deferred<PixelResult>(), latest = deferred<PixelResult>()
    const first = f.runPixelJob('旧请求', () => old.promise), second = f.runPixelJob('新请求', () => latest.promise)
    const selection: LayerCanvasSelection = { kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: [1, 1] } }
    old.resolve({ selection, status: '旧完成' }); await first
    expect(f.setSelection).not.toHaveBeenCalled()
    latest.resolve({ selection, status: '新完成' }); await second
    expect(f.setSelection).toHaveBeenCalledExactlyOnceWith(selection, true)
    await f.runPixelJob('计算中', async () => { throw new Error('选区复杂度超过容量限制') })
    expect(f.setError).toHaveBeenLastCalledWith('选区复杂度超过容量限制')
    expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.selectionRef.current).toBe(selection)
  })

  it('distinguishes connected wand sampling from all-same-color sampling', async () => {
    for (const allSameColor of [false, true]) {
      const f = fixture('select-wand', { allSameColor })
      const select = actual<(point: { x: number; y: number }, mode: string) => Promise<void>>('selectPixels', f.environment)
      await select({ x: 0.2, y: 0.2 }, 'replace')
      expect(f.selectionRef.current).toEqual({ kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: allSameColor ? [0, 1, 2, 1] : [0, 1] } })
      expect(f.sampler.current.samplePixels).toHaveBeenCalledWith({ source: 'composite', layerIndex: 0 }, expect.any(AbortSignal))
      expect(f.stateRef.current.past).toHaveLength(0)
    }
  })

  it('commits a connected bucket region as one reversible operation and respects the active domain', async () => {
    const f = fixture('bucket'), before = f.stateRef.current
    const select = actual<(point: { x: number; y: number }, mode: string) => Promise<void>>('selectPixels', f.environment)
    await select({ x: 0, y: 0 }, 'replace')
    const after = f.stateRef.current
    expect(after.past).toHaveLength(1)
    expect(after.present.recipe.layers[0].edits?.operations).toEqual([expect.objectContaining({ mode: 'fill', color: '#00ff00', opacity: 0.5, selection: expect.objectContaining({ kind: 'raster', raster: { width: 3, height: 1, runs: [0, 1] } }) })])
    expect(undoLayerEditor(after).present.recipe).toEqual(before.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(after)).present.recipe).toEqual(after.present.recipe)
    f.selectionRef.current = { kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: [2, 1] } }
    await select({ x: 0, y: 0 }, 'replace')
    expect(f.stateRef.current).toBe(after)
    expect(f.setError).toHaveBeenLastCalledWith('点击处不在可填充选区中，图层未修改')
  })

  it('previews a manual color independently from the seed and applies only an explicitly accepted current preview', async () => {
    const f = fixture('select-color-range', { rangeColor: '#0000ff' })
    const old: LayerCanvasSelection = { kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: [0, 1] } }
    f.selectionRef.current = old
    const preview = actual<(point?: { x: number; y: number }) => Promise<void>>('previewColorRange', f.environment)
    await preview()
    const next: LayerCanvasSelection = { kind: 'raster', inverted: false, raster: { width: 3, height: 1, runs: [1, 1] } }
    expect(f.setRangePreview).toHaveBeenLastCalledWith(next)
    expect(f.selectionRef.current).toBe(old)
    expect(f.setState).not.toHaveBeenCalled()
    const changeSelection = vi.fn(), chooseTool = vi.fn()
    for (const [rangePreviewCurrent, picking] of [[false, false], [true, true], [true, false]]) {
      const apply = actual<() => void>('applyColorRange', { rangePreviewCurrent, picking, rangePreview: next, changeSelection, chooseTool, setStatus: f.setStatus })
      apply()
    }
    expect(changeSelection).toHaveBeenCalledExactlyOnceWith(next)
    expect(chooseTool).toHaveBeenCalledExactlyOnceWith('move')
    await preview({ x: 2, y: 0 })
    expect(f.setRangeColor).toHaveBeenLastCalledWith('#ff0000ff')
    expect(f.selectionRef.current).toBe(old)
  })

  it('keeps W G and Shift G shortcuts out of inputs and cancels color range without replacing the old selection', () => {
    class FakeElement { constructor(readonly input = false) {} closest(selector: string) { return this.input && selector.includes('input') ? this : null } }
    const chooseTool = vi.fn(), setStatus = vi.fn(), changeSelection = vi.fn()
    function keyboard(tool: LayerCanvasTool) { return actual<(event: unknown) => void>('keyboard', { Element: FakeElement, exportRequest: { current: null }, toolMenu: null, selectionAdjust: false, sampling: { current: null }, gesture: { current: null }, paintGesture: { current: null }, selectionGesture: { current: null }, tool, chooseTool, setStatus, changeSelection }) }
    for (const [key, shiftKey, expected] of [['w', false, 'select-wand'], ['g', false, 'bucket'], ['g', true, 'fill']] as const) {
      const event = { key, shiftKey, metaKey: false, ctrlKey: false, target: new FakeElement(), preventDefault: vi.fn(), stopPropagation: vi.fn() }
      keyboard('move')(event)
      expect(chooseTool).toHaveBeenLastCalledWith(expected)
      chooseTool.mockClear()
      keyboard('move')({ ...event, target: new FakeElement(true) })
      expect(chooseTool).not.toHaveBeenCalled()
    }
    keyboard('select-color-range')({ key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() })
    expect(chooseTool).toHaveBeenLastCalledWith('move')
    expect(changeSelection).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenLastCalledWith('已取消色彩范围，原选区保留')
  })
})
