import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createLayerEditorState, finishLayerEditorTransaction, patchEditorLayer, patchEditorRecipe, selectEditorLayer, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { defaultImageTransformRecipe, parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { updateEditorCanvasSelection } from './layer-selection-history'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualApply(environment: Record<string, unknown>): () => void {
  environment = { closeLayerMerge: vi.fn(), ...environment }
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'apply') declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error('Missing actual LayerEditor.apply')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}
function fixture(initial = defaultImageTransformRecipe('layer') as ImageLayerRecipe) {
  const stateRef = { current: createLayerEditorState(initial, 1) }, sourcesKeyRef = { current: 'source-a' }
  const importedAssetsRef = { current: [] as unknown[] }, onApply = vi.fn(), onApplyWithImports = vi.fn(), onClose = vi.fn(), setError = vi.fn()
  const environment = { cropSessionRef: { current: null }, stateRef, sourcesKeyRef, importedAssetsRef, onApply, onApplyWithImports, onClose, setError, initialApplySnapshot: { current: { recipe: stateRef.current.present.recipe, sourcesKey: sourcesKeyRef.current } }, initialImportRecipe: { current: initial }, initialImportSourceIds: { current: ['source-a'] }, images: [{ asset: { localUrl: 'xingmang-asset://image/source-a' } }], penDraft: { current: null }, gradientGesture: { current: null }, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), parseImageTransformRecipe, finishLayerEditorTransaction }
  return { ...environment, apply: actualApply(environment) }
}

describe('actual layer apply no-op boundary', () => {
  it('closes an implicit materialized recipe without applying or dirtying the graph', () => {
    const f = fixture(); expect(f.initialImportRecipe.current.layers).toHaveLength(0); expect(f.stateRef.current.present.recipe.layers).toHaveLength(1)
    const before = f.stateRef.current; f.apply()
    expect(f.onClose).toHaveBeenCalledOnce(); expect(f.onApply).not.toHaveBeenCalled(); expect(f.onApplyWithImports).not.toHaveBeenCalled(); expect(f.setError).not.toHaveBeenCalled(); expect(f.stateRef.current).toBe(before)
  })
  it('ignores selected layer and session-only canvas selection history', () => {
    const f = fixture()
    f.stateRef.current = selectEditorLayer(f.stateRef.current, null)
    f.stateRef.current = updateEditorCanvasSelection(f.stateRef.current, { kind: 'rectangle', x: .1, y: .1, width: .5, height: .5, inverted: false }, true)
    expect(f.stateRef.current.past).toHaveLength(1); f.apply()
    expect(f.onApply).not.toHaveBeenCalled(); expect(f.onClose).toHaveBeenCalledOnce()
  })
  it('treats an edit then undo back to the initial content as unchanged', () => {
    const f = fixture(), initial = f.stateRef.current
    f.stateRef.current = undoLayerEditor(patchEditorLayer(initial, initial.present.ids[0], { opacity: .5 }))
    expect(f.stateRef.current.future).toHaveLength(1); f.apply(); expect(f.onApply).not.toHaveBeenCalled(); expect(f.onClose).toHaveBeenCalledOnce()
  })
  it.each(['opacity', 'output', 'background'])('still applies a real %s change', (change) => {
    const f = fixture()
    f.stateRef.current = change === 'opacity' ? patchEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[0], { opacity: .5 }) : patchEditorRecipe(f.stateRef.current, change === 'output' ? { outputWidth: 320 } : { background: '#ff0000' })
    f.apply(); expect(f.onApply).toHaveBeenCalledExactlyOnceWith(parseImageTransformRecipe(f.stateRef.current.present.recipe)); expect(f.onClose).toHaveBeenCalledOnce()
  })
  it('does not suppress application when the source identity changed', () => {
    const f = fixture(); f.sourcesKeyRef.current = 'source-b'; f.apply()
    expect(f.onApply).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledOnce()
  })
  it('keeps the imported asset application and its source guards even with equal content', () => {
    const f = fixture(); f.importedAssetsRef.current = [{ assetId: 'imported' }]; f.apply()
    expect(f.onApplyWithImports).toHaveBeenCalledExactlyOnceWith({ recipe: parseImageTransformRecipe(f.stateRef.current.present.recipe), initialRecipe: f.initialImportRecipe.current, baseSourceAssetIds: ['source-a'], importedAssets: [{ assetId: 'imported' }] }); expect(f.onApply).not.toHaveBeenCalled(); expect(f.onClose).toHaveBeenCalledOnce()
  })
  it('keeps real edit validation and does not close after apply fails', () => {
    const f = fixture(); f.stateRef.current = patchEditorRecipe(f.stateRef.current, { outputWidth: 320 }); f.onApply.mockImplementation(() => { throw new Error('图层权限已变化') }); f.apply()
    expect(f.onClose).not.toHaveBeenCalled(); expect(f.setError).toHaveBeenCalledWith('图层权限已变化')
  })
  it('does not confuse invalid content with a harmless no-op', () => {
    const f = fixture(); f.stateRef.current = { ...f.stateRef.current, present: { ...f.stateRef.current.present, recipe: { ...f.stateRef.current.present.recipe, outputWidth: 0 } } } as LayerEditorState; f.apply()
    expect(f.onApply).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled(); expect(f.setError).toHaveBeenCalledOnce()
  })
})
