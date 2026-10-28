import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowNode, type WorkflowNodeData } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { createCanvasDocument } from './canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from './use-canvas-document'
import { initialPanoramaView } from '../image-tools/panorama-view-state'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const controls = ts.createSourceFile('ImageToolControls.tsx', readFileSync(new URL('../image-tools/ImageToolControls.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function actualPanoramaSourceEffect(environment: Record<string, unknown>): () => void {
  let callback = ''
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(controls) === 'useEffect' && node.arguments[0]?.getText(controls).includes('panoramaSource.current')) callback = node.arguments[0].getText(controls)
    ts.forEachChild(node, visit)
  }
  visit(controls)
  if (!callback) throw new Error('Missing actual panorama source effect')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}

function actualPanoramaFirstSlot(environment: Record<string, unknown>): unknown {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(controls) === 'panoramaSourceImage') expression = node.initializer?.getText(controls) ?? ''
    ts.forEachChild(node, visit)
  }
  visit(controls)
  if (!expression) throw new Error('Missing actual panorama input selection')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}

function actual<T>(name: string, environment: Record<string, unknown>): T {
  let callback = ''
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name && ts.isArrowFunction(node.initializer)) callback = node.initializer.getText(source)
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) callback = node.getText(source).replace(/^export /, '')
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

function fixture(kind: 'image-compare' | 'image-panorama' | 'note' = 'image-compare') {
  let captured: CanvasDocumentController | undefined
  function project(record: EditorNodeRecord): CanvasNode {
    return { ...record, type: record.type as CanvasNode['type'], data: { prompt: '', model: '', status: 'idle', ...record.data } }
  }
  function Capture() { captured = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing document controller')
  const document = captured
  const settings = kind === 'image-compare' ? { imageCompare: { mode: 'slider', position: 50, a: '0', b: '1', grid: ['0', '1', null, null] } } : kind === 'note' ? { text: '旧备注' } : { imagePanorama: { yaw: 40, pitch: 15, fov: 70 } }
  const asset = { kind: 'image' as const, assetId: 'A'.repeat(43), localUrl: `xingmang-asset://image/${'A'.repeat(43)}`, width: 640, height: 480 }
  const records: EditorNodeRecord[] = ['viewer', 'ai', 'later', 'unrelated'].map((id, index) => ({
    id, type: index === 0 ? kind : 'image-generate', definitionVersion: 1, position: { x: index * 360, y: 0 },
    data: { prompt: 'kept prompt', model: index === 0 ? '' : 'existing-model', dirty: false, result: asset, ...(index === 0 ? { settings } : {}) },
  }))
  // A note has no ports, so it is never the first link of the chain.
  document.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: records, edges: [
    ...(kind === 'note' ? [] : [{ id: 'first', source: 'viewer', sourceHandle: 'out:image', target: 'ai', targetHandle: 'in:image' }]),
    { id: 'next', source: 'ai', sourceHandle: 'out:image', target: 'later', targetHandle: 'in:image' },
  ] } })
  document.setNodes((nodes) => nodes.map((node) => ({ ...node, data: { ...node.data, status: 'succeeded', costQuota: 31, latestAttemptDurationMs: 1600, candidateAssetIds: [asset.assetId], selectedCandidateId: 'candidate', candidates: [{ candidateId: 'candidate', attemptId: 'attempt', createdAt: '2026-10-14T00:00:00.000Z', asset }] } })))
  const graphRef = { current: document.getGraphSnapshot() }, execute = vi.fn(document.execute), setDirtyNodeIds = vi.fn()
  const dirty = actual<(id: string, patch: Partial<WorkflowNodeData>, discrete: boolean) => void>('markDirtyFrom', { graphRef, execute, setDirtyNodeIds, markNodeAndDescendantsDirty, canvasNodeDocumentRecord })
  const markDirtyFrom = vi.fn(dirty)
  const onSettingsChange = actual<(id: string, patch: Record<string, unknown>) => void>('onSettingsChange', { getGraphSnapshot: document.getGraphSnapshot, graphRef, execute, canvasNodeDocumentRecord, markDirtyFrom, isDramaAssetNodeType: () => false, builtinNodeRegistry })
  const toWorkflowNode = actual<(node: CanvasNode) => WorkflowNode>('toWorkflowNode', { parseImageCandidateCount, parseVideoCandidateCount, maximumOutputTextLength: 200_000 })
  function saved() {
    const graph = document.getGraphSnapshot()
    const restored = parseWorkflowFile(serializeWorkflow({ ...createEmptyWorkflow('Viewer fixture'), nodes: graph.nodes.map(toWorkflowNode), edges: graph.edges.map((edge) => ({ id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle ?? '', target: edge.target, targetHandle: edge.targetHandle ?? '' })) }))
    if (!restored) throw new Error('Viewer fixture did not survive workflow serialization')
    return restored
  }
  return { document, graphRef, execute, setDirtyNodeIds, markDirtyFrom, onSettingsChange, saved }
}

describe('actual App viewer-only settings routing', () => {
  it.each([
    ['image-compare', 'imageCompare', { mode: 'grid', position: 73, a: '1', b: null, grid: ['1', '0', null, null], inputSlots: ['["edge-a",0]', '["edge-b",0]'] }],
    ['image-panorama', 'imagePanorama', { yaw: 178, pitch: -25, fov: 45 }],
  ] as const)('persists %s and undoes one view command while keeping results and downstream execution clean', (kind, key, next) => {
    const f = fixture(kind), before = f.document.getGraphSnapshot()
    const oldSettings = before.nodes[0].data.settings
    f.onSettingsChange('viewer', { [key]: next })
    const after = f.document.getGraphSnapshot()
    expect(after.nodes[0].data.settings?.[key]).toEqual(next)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.markDirtyFrom).not.toHaveBeenCalled()
    expect(f.setDirtyNodeIds).not.toHaveBeenCalled()
    expect(after.nodes.slice(1)).toEqual(before.nodes.slice(1))
    for (let index = 0; index < after.nodes.length; index++) {
      const { settings: _settings, ...data } = after.nodes[index].data
      const { settings: _oldSettings, ...oldData } = before.nodes[index].data
      expect(data).toEqual(oldData)
      expect(after.nodes[index].data.dirty).toBe(false)
    }
    expect(f.graphRef.current).toEqual(after)
    expect(f.saved().nodes[0].data.settings?.[key]).toEqual(next)
    expect(f.saved().nodes[1].data.result?.assetId).toBe(before.nodes[1].data.result?.assetId)
    f.document.undo()
    expect(f.document.getGraphSnapshot().nodes[0].data.settings).toEqual(oldSettings)
    expect(f.document.getGraphSnapshot().nodes.map((node) => node.data)).toEqual(before.nodes.map((node) => node.data))
    f.document.redo()
    expect(f.document.getGraphSnapshot().nodes.map((node) => node.data)).toEqual(after.nodes.map((node) => node.data))
  })

  it('keeps two view gestures as two separate undo transactions', () => {
    const f = fixture()
    f.onSettingsChange('viewer', { imageCompare: { mode: 'slider', position: 60 } })
    f.onSettingsChange('viewer', { imageCompare: { mode: 'slider', position: 80 } })
    f.document.undo()
    expect(f.document.getGraphSnapshot().nodes[0].data.settings?.imageCompare).toEqual({ mode: 'slider', position: 60 })
    f.document.undo()
    expect(f.document.getGraphSnapshot().nodes[0].data.settings?.imageCompare).toMatchObject({ position: 50 })
    expect(f.markDirtyFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['viewer', { imageCompare: { mode: 'grid' }, imageTransform: { kind: 'crop' } }, true],
    ['viewer', { otherOption: 'changed' }, false],
    ['ai', { imageCompare: { mode: 'grid' } }, false],
    ['viewer', { imagePanorama: { yaw: 90, pitch: 0, fov: 75 } }, false],
  ] as const)('keeps non-view and mixed patches on the existing dirty route %#', (nodeId, patch, discrete) => {
    const f = fixture(), before = f.document.getGraphSnapshot()
    f.onSettingsChange(nodeId, patch)
    expect(f.markDirtyFrom).toHaveBeenCalledExactlyOnceWith(nodeId, { settings: { ...before.nodes.find((node) => node.id === nodeId)?.data.settings, ...patch } }, discrete)
    expect(f.setDirtyNodeIds).toHaveBeenCalledOnce()
    const after = f.document.getGraphSnapshot()
    expect(after.nodes.find((node) => node.id === nodeId)?.data.dirty).toBe(true)
    expect(after.nodes.find((node) => node.id === 'later')?.data.dirty).toBe(true)
    expect(after.nodes.find((node) => node.id === 'unrelated')?.data.dirty).toBe(false)
  })

  it('saves a note edit without leaving the note or anything else waiting for a rerun', () => {
    const f = fixture('note'), before = f.document.getGraphSnapshot()
    f.onSettingsChange('viewer', { text: '新备注' })
    const after = f.document.getGraphSnapshot()
    expect(after.nodes[0].data.settings?.text).toBe('新备注')
    expect(f.markDirtyFrom).not.toHaveBeenCalled()
    expect(f.setDirtyNodeIds).not.toHaveBeenCalled()
    expect(after.nodes.map((node) => node.data.dirty)).toEqual([false, false, false, false])
    expect(after.nodes.slice(1)).toEqual(before.nodes.slice(1))
  })

  it('ignores a settings callback whose node was removed', () => {
    const f = fixture()
    f.onSettingsChange('deleted', { imageCompare: { mode: 'grid' } })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.markDirtyFrom).not.toHaveBeenCalled()
  })
})

describe('actual image-tool panorama loading lifecycle', () => {
  it('preserves the stored view while its first asset resolves asynchronously', () => {
    const panoramaSource = { current: '' }, onChange = vi.fn(), setPanoramaDraft = vi.fn()
    const environment = { kind: 'image-panorama', panoramaSource, onChange, setPanoramaDraft, initialPanoramaView }
    actualPanoramaSourceEffect({ ...environment, sourceKey: '' })()
    actualPanoramaSourceEffect({ ...environment, sourceKey: 'asset-a' })()
    actualPanoramaSourceEffect({ ...environment, sourceKey: 'asset-a' })()
    expect(panoramaSource.current).toBe('asset-a')
    expect(onChange).not.toHaveBeenCalled()
    expect(setPanoramaDraft).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('cancels drafts for changed source scopes without writing saved angles or creating undo entries', () => {
    const f = fixture('image-panorama'), before = f.document.getGraphSnapshot()
    const panoramaSource = { current: 'asset-a' }, onChange = vi.fn((settings: Record<string, unknown>) => f.onSettingsChange('viewer', settings)), setPanoramaDraft = vi.fn()
    const environment = { kind: 'image-panorama', panoramaSource, onChange, setPanoramaDraft, initialPanoramaView }
    for (const sourceKey of ['', 'asset-a', '', 'asset-b', 'asset-b']) actualPanoramaSourceEffect({ ...environment, sourceKey })()
    expect(onChange).not.toHaveBeenCalled()
    expect(setPanoramaDraft).toHaveBeenCalledTimes(4)
    expect(setPanoramaDraft.mock.calls.every(([value]) => value === null)).toBe(true)
    expect(panoramaSource.current).toBe('asset-b')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.document.getGraphSnapshot()).toEqual(before)
    expect(f.saved().nodes[0].data.settings?.imagePanorama).toEqual({ yaw: 40, pitch: 15, fov: 70 })
  })

  it('keeps a waiting first input empty rather than showing and later resetting from a ready second input', () => {
    const first = { edgeId: 'first' }, second = { edgeId: 'second' }, readySecond = { asset: { assetId: 'second-asset' } }
    const readyByReference = new Map<object, unknown>([[second, readySecond]])
    expect(actualPanoramaFirstSlot({ imageReferences: [first, second], readyByReference })).toBeUndefined()
    const readyFirst = { asset: { assetId: 'first-asset' } }
    readyByReference.set(first, readyFirst)
    expect(actualPanoramaFirstSlot({ imageReferences: [first, second], readyByReference })).toBe(readyFirst)
  })
})
