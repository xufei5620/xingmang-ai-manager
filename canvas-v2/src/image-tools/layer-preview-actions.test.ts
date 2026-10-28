import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createLayerPreviewScheduler } from './layer-preview-task'
import type { ImageLayerRecipe } from './recipe'
import type { paintBrowserImageLayerDocumentPreview } from '../library/browser-image-transform'
import { getPreparedColorLutTable } from './layer-color-lut-runtime'

const source = ts.createSourceFile('layerpreview.tsx', readFileSync(new URL('./layerpreview.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function effect(component: string, position: number, environment: Record<string, unknown>): () => void | (() => void) {
  const callbacks: string[] = []
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === component) {
      function nested(child: ts.Node) { if (ts.isCallExpression(child) && child.expression.getText(source) === 'useEffect' && child.arguments[0]?.getText(source).includes('layerPreviewScheduler.schedule')) callbacks.push(child.arguments[0].getText(source)); ts.forEachChild(child, nested) }
      nested(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callbacks[position]) throw new Error('Actual preview effect is missing')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${callbacks[position]})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => void | (() => void)
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
function fixture(documentFrame?: ImageLayerRecipe['documentFrame']) {
  const pending = deferred(), frame = { width: 320, height: 240 }, prior = { width: 320, height: 240 }, target = { width: 320, height: 240 }
  const layer = { content: { kind: 'text' }, mask: undefined }, baseScope = {}, displayScope = {}, scope = {}
  const scheduler = createLayerPreviewScheduler(), tasks: Array<ReturnType<typeof scheduler.schedule>> = []
  const environment = {
    layer, source: undefined, lutTables: undefined, getPreparedColorLutTable, width: 320, height: 240, outputWidth: 320, outputHeight: 240, documentFrame, size: { width: 320, height: 240 }, transient: { mode: 'draw' },
    baseScope, displayScope, scope, latestBase: { current: baseScope }, latestDisplay: { current: displayScope }, latest: { current: scope },
    font: { ready: true }, completed: { current: { canvas: prior, layer, source: undefined, width: 320, height: 240 } as null | { canvas: typeof prior; layer: typeof layer; source: undefined; width: number; height: number } }, canvas: { current: target },
    onStatus: vi.fn(), setUpdating: vi.fn(), setError: vi.fn(), setRevision: vi.fn(), createPreviewCanvas: vi.fn(() => frame), disposePreviewCanvas: vi.fn(), clearPreviewCanvas: vi.fn(), publishPreviewCanvas: vi.fn(),
    previewContext: vi.fn(() => ({ setTransform: vi.fn(), drawImage: vi.fn() })), paintImageLayerLocalAsync: vi.fn(() => pending.promise), paintImageLayerWorldPreviewAsync: vi.fn(() => pending.promise), applyImageLayerFeatherMask: vi.fn(),
    paintBrowserImageLayerDocumentPreview: vi.fn<typeof paintBrowserImageLayerDocumentPreview>(() => pending.promise),
    layerPreviewScheduler: { schedule: ((input) => { const task = scheduler.schedule(input); tasks.push(task); return task }) as typeof scheduler.schedule },
  }
  return { ...environment, environment, pending, frame, prior, target, tasks }
}

describe('actual asynchronous preview effect boundaries', () => {
  it('retains the prior complete layer while drawing and replaces the cache only after completion', async () => {
    const f = fixture(), cleanup = effect('RasterLayerContent', 0, f.environment)()
    await Promise.resolve()
    expect(f.completed.current?.canvas).toBe(f.prior)
    expect(f.disposePreviewCanvas).not.toHaveBeenCalled()
    f.pending.resolve(); await f.tasks[0].done
    expect(f.completed.current?.canvas).toBe(f.frame)
    expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.prior)
    expect(f.setRevision).toHaveBeenCalledOnce()
    cleanup?.()
  })

  it('rejects a prior base result after a render changes scope before passive cleanup', async () => {
    const f = fixture(); effect('RasterLayerContent', 0, f.environment)(); await Promise.resolve()
    f.latestBase.current = {}; f.pending.resolve(); await f.tasks[0].done
    expect(f.completed.current?.canvas).toBe(f.prior)
    expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.frame)
    expect(f.setRevision).not.toHaveBeenCalled()
  })

  it('clears a missing-font preview immediately without starting a replacement raster', () => {
    const f = fixture(); f.font.ready = false
    effect('RasterLayerContent', 0, f.environment)()
    expect(f.completed.current).toBeNull()
    expect(f.clearPreviewCanvas).toHaveBeenCalledWith(f.target)
    expect(f.disposePreviewCanvas).toHaveBeenCalledWith(f.prior)
    expect(f.tasks).toHaveLength(0)
  })

  it.each([['RasterLayerContent', 1], ['WorldRasterLayerContent', 0]] as const)('publishes one complete %s frame and never clears the old frame while pending', async (component, position) => {
    const f = fixture(), cleanup = effect(component, position, f.environment)()
    await Promise.resolve()
    expect(f.publishPreviewCanvas).not.toHaveBeenCalled()
    expect(f.clearPreviewCanvas).not.toHaveBeenCalled()
    expect(f.paintBrowserImageLayerDocumentPreview).not.toHaveBeenCalled()
    if (component === 'WorldRasterLayerContent') expect(f.paintImageLayerWorldPreviewAsync).toHaveBeenCalledOnce()
    f.pending.resolve(); await f.tasks[0].done
    expect(f.publishPreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.target, f.frame)
    expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.frame)
    cleanup?.()
  })

  it.each([['RasterLayerContent', 1], ['WorldRasterLayerContent', 0]] as const)('never publishes an unfinished %s frame after unmount or selection change', async (component, position) => {
    const f = fixture(), cleanup = effect(component, position, f.environment)()
    await Promise.resolve(); cleanup?.(); f.pending.resolve(); await f.tasks[0].done
    expect(f.publishPreviewCanvas).not.toHaveBeenCalled()
    expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.frame)
    expect(f.setError).not.toHaveBeenCalledWith(expect.stringContaining('失败'))
    expect(f.onStatus).not.toHaveBeenCalledWith({ busy: false, error: '' })
  })
  it('reports raster success only after painting and reports kernel failures without a success receipt', async () => {
    const f = fixture(); effect('WorldRasterLayerContent', 0, f.environment)(); expect(f.onStatus).toHaveBeenCalledExactlyOnceWith({ busy: true, error: '' })
    f.pending.resolve(); await f.tasks[0].done; expect(f.onStatus).toHaveBeenLastCalledWith({ busy: false, error: '' })
    const failed = fixture(); failed.paintImageLayerWorldPreviewAsync.mockRejectedValueOnce(new Error('液化笔迹覆盖面积超过安全预算'))
    effect('WorldRasterLayerContent', 0, failed.environment)(); await failed.tasks[0].done
    expect(failed.onStatus).toHaveBeenLastCalledWith({ busy: false, error: '液化笔迹覆盖面积超过安全预算' }); expect(failed.onStatus).not.toHaveBeenCalledWith({ busy: false, error: '' }); expect(failed.publishPreviewCanvas).not.toHaveBeenCalled()
  })

  it('uses document replay for a cropped layer and publishes ready only after the complete frame', async () => {
    const documentFrame = { version: 1 as const, width: 640, height: 480, offsetX: 80, offsetY: 60 }
    const f = fixture(documentFrame), sourceImage = { naturalWidth: 640, naturalHeight: 480 }
    const priorStroke = { mode: 'erase' }, layer = { ...f.layer, sourceIndex: 3, visible: false, opacity: 0.4, blend: 'multiply', edits: { version: 1, operations: [priorStroke] } }
    const cleanup = effect('WorldRasterLayerContent', 0, { ...f.environment, layer, source: sourceImage })()
    await Promise.resolve()
    expect(f.paintImageLayerWorldPreviewAsync).not.toHaveBeenCalled()
    expect(f.paintBrowserImageLayerDocumentPreview).toHaveBeenCalledExactlyOnceWith(expect.any(Object), {
      recipe: { kind: 'layer', outputWidth: 320, outputHeight: 240, documentFrame, explicitLayers: true, background: 'transparent', layers: [{ ...layer, sourceIndex: 0, visible: true, opacity: 1, blend: 'source-over', edits: { version: 1, operations: [priorStroke, f.transient] } }] },
      sources: [{ image: sourceImage, width: 640, height: 480 }], signal: expect.any(AbortSignal),
    })
    expect(f.publishPreviewCanvas).not.toHaveBeenCalled()
    expect(f.clearPreviewCanvas).not.toHaveBeenCalled()
    expect(f.onStatus).toHaveBeenCalledExactlyOnceWith({ busy: true, error: '' })
    f.pending.resolve(); await f.tasks[0].done
    expect(f.publishPreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.target, f.frame)
    expect(f.onStatus).toHaveBeenLastCalledWith({ busy: false, error: '' })
    expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.frame)
    cleanup?.()
  })

  it.each(['cleanup', 'scope-change'] as const)('does not publish a late cropped frame after %s', async (reason) => {
    const f = fixture({ version: 1, width: 640, height: 480, offsetX: 80, offsetY: 60 })
    const cleanup = effect('WorldRasterLayerContent', 0, f.environment)()
    await Promise.resolve()
    expect(f.paintBrowserImageLayerDocumentPreview).toHaveBeenCalledOnce()
    expect(f.paintImageLayerWorldPreviewAsync).not.toHaveBeenCalled()
    if (reason === 'cleanup') {
      cleanup?.()
      expect(f.paintBrowserImageLayerDocumentPreview.mock.calls[0][1].signal?.aborted).toBe(true)
    } else f.latest.current = {}
    f.pending.resolve(); await f.tasks[0].done
    expect(f.publishPreviewCanvas).not.toHaveBeenCalled()
    expect(f.clearPreviewCanvas).not.toHaveBeenCalled()
    expect(f.onStatus).toHaveBeenCalledExactlyOnceWith({ busy: true, error: '' })
    expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.frame)
    cleanup?.()
  })

  it('reports cropped replay failures without publishing or issuing a ready receipt', async () => {
    const f = fixture({ version: 1, width: 640, height: 480, offsetX: 80, offsetY: 60 })
    f.paintBrowserImageLayerDocumentPreview.mockRejectedValueOnce(new Error('裁剪图层预览等待超时，请减少图层或笔迹后重试'))
    effect('WorldRasterLayerContent', 0, f.environment)(); await f.tasks[0].done
    expect(f.paintImageLayerWorldPreviewAsync).not.toHaveBeenCalled()
    expect(f.publishPreviewCanvas).not.toHaveBeenCalled()
    expect(f.clearPreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.target)
    expect(f.onStatus).toHaveBeenLastCalledWith({ busy: false, error: '裁剪图层预览等待超时，请减少图层或笔迹后重试' })
    expect(f.onStatus).not.toHaveBeenCalledWith({ busy: false, error: '' })
    expect(f.disposePreviewCanvas).toHaveBeenCalledExactlyOnceWith(f.frame)
  })
})
