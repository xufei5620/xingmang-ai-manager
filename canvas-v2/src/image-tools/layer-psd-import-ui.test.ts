import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { LayerPsdImportPreview } from './LayerPsdImportDialog'
import type { BrowserLayerPsdDocument } from '../library/browser-layer-psd-import'
import { appendEditorImportedLayers, type LayerPsdApplyInput } from './layer-psd-apply'
import { createLayerEditorState, finishLayerEditorTransaction, undoLayerEditor, redoLayerEditor } from './layer-editor-state'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function actual<T>(file: string, name: string, environment: Record<string, unknown>): T {
  environment = { closeLayerMerge: vi.fn(), ...environment }
  environment = { cropSessionRef: { current: null }, ...environment }
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!expression) throw new Error(`Missing actual ${name}`)
  const code = ts.transpileModule(`${expression}; return ${name}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T
}
function document(): BrowserLayerPsdDocument { return { width: 320, height: 240, warnings: [], layers: [0, 1].map((index) => ({ name: index ? '顶层 <品牌>' : '底层', left: 10 + index * 20, top: 30, width: 80, height: 60, visible: !index, opacity: 0.5, blend: 'multiply', blob: new Blob(['png'], { type: 'image/png' }) })) } }
function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 320, outputHeight: 240, background: 'transparent', explicitLayers: true, layers: [] }
  const doc = document(), assets = doc.layers.map((layer, index) => ({ assetId: String(index).repeat(43), localUrl: `xingmang-asset://image/${String(index).repeat(43)}`, width: layer.width, height: layer.height }))
  const importLayerPsd = vi.fn(async () => assets)
  const stateRef = { current: createLayerEditorState(recipe, 0) }, importedAssetsRef = { current: [] as typeof assets }
  const environment = { hostBridge: () => ({ importLayerPsd }), onApplyWithImports: vi.fn(), finishLayerEditorTransaction, stateRef, sourcesKeyRef: { current: 'stable-sources' }, appendEditorImportedLayers, images: [], importAlive: { current: true }, importedAssetsRef, setImportedAssets: vi.fn(), setState: vi.fn(), setError: vi.fn(), setStatus: vi.fn() }
  return { ...environment, recipe, doc, assets, importLayerPsd, import: actual<(document: BrowserLayerPsdDocument, options: { signal: AbortSignal }) => Promise<void>>('./LayerEditor.tsx', 'importPsd', environment) }
}

describe('PSD import preview and actual editor integration', () => {
  it('previews positioned opacity-adjusted bitmap layers and retains hidden layer metadata in the list', () => {
    const html = renderToStaticMarkup(createElement(LayerPsdImportPreview, { document: document(), urls: ['blob:bottom', 'blob:top'] }))
    expect(html).toContain('aria-label="已解析 PSD 的图层合成预览"')
    expect(html).toContain('--layer-psd-ratio:1.3333333333333333')
    expect(html).toContain('left:3.125%')
    expect(html).toContain('opacity:0.5;mix-blend-mode:multiply')
    expect(html.indexOf('顶层 &lt;品牌&gt;')).toBeLessThan(html.indexOf('<strong>底层'))
    expect(html).toContain('隐藏')
    expect(html.match(/src="blob:top"/g)).toHaveLength(1)
    expect(html.match(/src="blob:bottom"/g)).toHaveLength(2)
  })

  it('appends only after owned assets arrive and supports one local undo and redo', async () => {
    const f = fixture(), before = f.stateRef.current.present
    await f.import(f.doc, { signal: new AbortController().signal })
    expect(f.importLayerPsd).toHaveBeenCalledExactlyOnceWith(f.doc, expect.any(AbortSignal))
    expect(f.setState).toHaveBeenCalledTimes(1)
    expect(f.stateRef.current.present.recipe.layers).toHaveLength(2)
    expect(f.stateRef.current.present.recipe.layers[0]).toMatchObject({ x: 10 / 320, y: 30 / 240, width: 80 / 320, height: 60 / 240, opacity: 0.5, blend: 'multiply' })
    expect(f.stateRef.current.present.recipe.outputWidth).toBe(320)
    const undone = undoLayerEditor(f.stateRef.current)
    expect(undone.present).toEqual(before)
    expect(redoLayerEditor(undone).present).toEqual(f.stateRef.current.present)
    expect(f.importedAssetsRef.current).toEqual(f.assets)
    expect(f.onApplyWithImports).not.toHaveBeenCalled()
  })

  it.each(['abort', 'closed', 'source-change', 'edited'] as const)('does not install a late import after %s', async (change) => {
    const f = fixture(), controller = new AbortController()
    let resolve!: (value: typeof f.assets) => void
    f.importLayerPsd.mockImplementationOnce(() => new Promise((finish) => { resolve = finish }))
    const running = f.import(f.doc, { signal: controller.signal })
    if (change === 'abort') controller.abort()
    if (change === 'closed') f.importAlive.current = false
    if (change === 'source-change') f.sourcesKeyRef.current = 'new-source'
    if (change === 'edited') f.stateRef.current = createLayerEditorState({ ...f.recipe, background: '#ffffff' }, 0)
    resolve(f.assets)
    await expect(running).rejects.toThrow()
    expect(f.setState).not.toHaveBeenCalled()
    expect(f.setImportedAssets).not.toHaveBeenCalled()
    expect(f.importedAssetsRef.current).toEqual([])
  })

  it('rejects impossible append geometry before submitting any upload', async () => {
    const f = fixture(); f.doc.layers[0].left = 320 * 3
    await expect(f.import(f.doc, { signal: new AbortController().signal })).rejects.toThrow('超出当前画布')
    expect(f.importLayerPsd).not.toHaveBeenCalled()
  })

  it('applies imported assets through the guarded graph callback and keeps the editor open on conflict', async () => {
    const f = fixture(); await f.import(f.doc, { signal: new AbortController().signal })
    const onClose = vi.fn(), onApply = vi.fn(), onApplyWithImports = vi.fn<(input: LayerPsdApplyInput) => void>().mockImplementation(() => { throw new Error('上游图片已变化') })
    const { import: invokeImport, ...fixtureEnvironment } = f
    const setError = vi.fn(), environment = { ...fixtureEnvironment, onClose, onApply, onApplyWithImports, setError, initialImportRecipe: { current: f.recipe }, initialImportSourceIds: { current: [] }, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), parseImageTransformRecipe, penDraft: { current: null }, gradientGesture: { current: null }, images: f.assets.map((asset) => ({ asset })) }
    actual<() => void>('./LayerEditor.tsx', 'apply', environment)()
    expect(onApplyWithImports).toHaveBeenCalledExactlyOnceWith({ recipe: f.stateRef.current.present.recipe, initialRecipe: f.recipe, baseSourceAssetIds: [], importedAssets: f.assets })
    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(setError).toHaveBeenLastCalledWith('上游图片已变化')
  })

  it('consumes Escape inside the import dialog before the underlying editor can close', () => {
    const close = vi.fn(), event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    actual<(input: typeof event) => void>('./LayerPsdImportDialog.tsx', 'keyboard', { close })(event)
    expect(close).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
