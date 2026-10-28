import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { assertLayerEditorScope, layerEditorScopeToken, type LayerEditorScope } from './layer-editor-scope'
import { buildLayerPsdGraph, type LayerPsdApplyInput } from './layer-psd-apply'
import type { ImageLayerRecipe } from './recipe'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'

function scope(): LayerEditorScope { return { ownerId: 7, accountId: 'account-one', projectId: 'project-one', projectEpoch: 1, enabled: true } }
function source(file: string): ts.SourceFile { return ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }
function actual<T>(expression: string, environment: Record<string, unknown>): T {
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function appApply(environment: Record<string, unknown>): (id: string, input: LayerPsdApplyInput, token: string) => void {
  const file = source('../App.tsx'); let expression = ''
  function visit(node: ts.Node) { if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'onLayerPsdApply') expression = node.initializer.getText(file); ts.forEachChild(node, visit) }
  visit(file)
  if (!expression) throw new Error('Missing actual App PSD callback')
  return actual(expression, environment)
}
function nodeApply(environment: Record<string, unknown>): { apply(input: LayerPsdApplyInput): void; key: string } {
  const file = source('../nodes/WorkflowNodes.tsx'); let expression = '', key = ''
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'ImageToolControls') {
      for (const property of node.attributes.properties) if (ts.isJsxAttribute(property) && property.initializer && ts.isJsxExpression(property.initializer) && property.initializer.expression) {
        if (property.name.getText(file) === 'onApplyWithImports') expression = property.initializer.expression.getText(file)
        if (property.name.getText(file) === 'key') key = property.initializer.expression.getText(file)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!expression || !key) throw new Error('Missing scoped image editor wiring')
  return { apply: actual(expression, environment), key: actual(key, environment) }
}
function fixture() {
  const initialRecipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 320, outputHeight: 240, background: 'transparent', explicitLayers: true, layers: [] }
  const nodes: CanvasNode[] = [{ id: 'same-node', type: 'image-layer', definitionVersion: 1, position: { x: 1000, y: 200 }, data: { model: '', prompt: '', status: 'idle', settings: { imageTransform: initialRecipe } } }]
  const assetId = 'a'.repeat(43)
  const input: LayerPsdApplyInput = { initialRecipe, baseSourceAssetIds: [], importedAssets: [{ assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, fileName: 'layer.png', createdAt: '2026-10-14T00:00:00Z', width: 320, height: 240 }], recipe: { ...initialRecipe, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, visible: true, blend: 'source-over' }] } }
  const originalScope = scope(), execute = vi.fn(), build = vi.fn(buildLayerPsdGraph)
  const layerEditorOwnerRef = { current: { ownerId: originalScope.ownerId, accountId: originalScope.accountId } }, projectEpochRef = { current: originalScope.projectEpoch }, activeProjectIdRef = { current: originalScope.projectId }, draftActionsEnabledRef = { current: true }
  let id = 0
  const environment = { assertLayerEditorScope, layerEditorOwnerRef, projectEpochRef, activeProjectIdRef, draftActionsEnabledRef, projectTransitionRef: { current: false }, running: false, startingRunsRef: { current: 0 }, getGraphSnapshot: () => ({ nodes, edges: [] }), buildLayerPsdGraph: build, nextNodeId: () => `new-${++id}`, execute, canvasNodeDocumentRecord, graphRef: { current: { nodes, edges: [] } }, setDirtyNodeIds: vi.fn(), dirtyCanvasNodeIds: () => ['same-node'], refreshAssets: vi.fn(), assetQuery: {}, setBanner: vi.fn() }
  const apply = appApply(environment)
  const editor = nodeApply({ id: 'same-node', editorScope: layerEditorScopeToken(originalScope), handlers: { onLayerPsdApply: apply } })
  return { ...environment, originalScope, input, editor }
}

describe('PSD draft session at the actual node and App boundary', () => {
  it('uses a stable image editor key for ordinary rerenders and a new key for every session boundary', () => {
    const before = scope(), token = layerEditorScopeToken(before)
    expect(layerEditorScopeToken({ ...before })).toBe(token)
    for (const change of [{ ownerId: 8 }, { accountId: 'account-two' }, { projectId: 'project-two' }, { projectEpoch: 2 }, { enabled: false }]) {
      const next = { ...before, ...change }
      expect(layerEditorScopeToken(next)).not.toBe(token)
      expect(() => assertLayerEditorScope(token, next)).toThrow('旧图层草稿未应用')
    }
  })

  it('passes the retained editor scope through the real node callback and commits exactly once', () => {
    const f = fixture()
    expect(f.editor.key).toBe(layerEditorScopeToken(f.originalScope))
    f.editor.apply(f.input)
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls[0][0]).toMatchObject({ type: 'replace-graph', nodes: expect.any(Array), edges: expect.any(Array) })
    expect(f.execute.mock.calls[0][0].nodes).toHaveLength(3)
    expect(f.execute.mock.calls[0][0].edges).toHaveLength(1)
  })

  it.each(['same-project-reopen', 'project-switch', 'owner-switch', 'account-switch', 'account-locked'] as const)('rejects an uploaded retained draft after %s even before a new render', (boundary) => {
    const f = fixture()
    // The node ID, initial recipe and input order intentionally remain equal.
    if (boundary === 'same-project-reopen') f.projectEpochRef.current++
    if (boundary === 'project-switch') f.activeProjectIdRef.current = 'project-two'
    if (boundary === 'owner-switch') f.layerEditorOwnerRef.current.ownerId = 8
    if (boundary === 'account-switch') f.layerEditorOwnerRef.current.accountId = 'account-two'
    if (boundary === 'account-locked') f.draftActionsEnabledRef.current = false
    expect(() => f.editor.apply(f.input)).toThrow('旧图层草稿未应用')
    expect(f.buildLayerPsdGraph).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.refreshAssets).not.toHaveBeenCalled()
  })
})
