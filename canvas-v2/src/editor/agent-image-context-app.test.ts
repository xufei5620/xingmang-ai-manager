import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { canvasAgentNodeImageUnavailableReason, resolveCanvasAgentImageReferences, resolveCanvasAgentNodeImageAssetId } from '../lib/canvas-agent-image-context'
import { canvasAgentGraphSnapshot } from '../lib/canvas-agent-patch'
import { agentPlanFocusViewport } from '../components/canvas-agent-context'
import type { CanvasAgentImageReference } from '../lib/canvas-agent-contract'
import type { WorkflowFile, WorkflowNode } from '../model'
import { isTemplateImageAsset } from '../components/template-asset-picker-model'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source); if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') expression = node.initializer.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
const assetA = 'a'.repeat(43), assetB = 'b'.repeat(43)
function image(id = 'image-a', assetId = assetA): WorkflowNode { return { id, kind: 'image-generate', position: { x: 0, y: 0 }, data: { model: '', prompt: '', status: 'succeeded', result: { kind: 'image', assetId }, candidateAssetIds: [assetA, assetB] } } }
function fixture() {
  const graph: WorkflowFile = { schemaVersion: 2, name: 'Agent 图片工程', nodes: [image()], edges: [] }
  const active = { value: true }, scope = { key: 'owner-project-1', projectId: 'project-a', active: () => active.value }
  const environment = { agentScope: scope, captureAgentWorkflow: () => structuredClone(graph), canvasAgentGraphSnapshot, canvasAgentNodeImageUnavailableReason, resolveCanvasAgentImageReferences, resolveCanvasAgentNodeImageAssetId,
    readAgentImageAsset: vi.fn().mockResolvedValue({ assetId: assetA }), saveAgentWorkflow: vi.fn().mockResolvedValue(2), withAgentProjectTransaction: (callback: () => Promise<unknown>) => callback(), selectedNodeIds: ['image-a'], agentContextSequence: { current: 0 }, setAgentContextRequest: vi.fn(), setBanner: vi.fn(), setAgentOpen: vi.fn(), setFocusMode: vi.fn(), setMediaConfigOpen: vi.fn(), setMoreActionsOpen: vi.fn(),
  }
  return { graph, active, environment, prepare: actual<(refs?: readonly CanvasAgentImageReference[]) => Promise<{ projectId: string; expectedProjectVersion: number }>>('prepareAgentTurn', environment), send: actual<() => void>('sendSelectionToAgent', environment) }
}
describe('actual App Agent image preparation', () => {
  it('saves the exact adopted picture and does not automatically include alternate candidates', async () => {
    const f = fixture(), refs = [{ nodeId: 'image-a', assetId: assetA }]
    await expect(f.prepare(refs)).resolves.toEqual({ projectId: 'project-a', expectedProjectVersion: 2 })
    expect(f.environment.saveAgentWorkflow).toHaveBeenCalledExactlyOnceWith(f.graph)
    f.send()
    expect(f.environment.setAgentContextRequest).toHaveBeenCalledExactlyOnceWith({ id: 1, scopeKey: 'owner-project-1', nodeIds: ['image-a'], imageReferences: refs })
    expect(f.graph.nodes).toHaveLength(1)
  })
  it.each(['changed', 'dirty', 'running', 'deleted', 'video'] as const)('rejects %s image snapshots before saving', async (kind) => {
    const f = fixture(), refs = [{ nodeId: 'image-a', assetId: assetA }]
    if (kind === 'changed') f.graph.nodes[0].data.result!.assetId = assetB
    if (kind === 'dirty') f.graph.nodes[0].data.dirty = true
    if (kind === 'running') f.graph.nodes[0].data.status = 'running'
    if (kind === 'deleted') f.graph.nodes = []
    if (kind === 'video') f.graph.nodes[0].data.result!.kind = 'video'
    await expect(f.prepare(refs)).rejects.toThrow(); expect(f.environment.saveAgentWorkflow).not.toHaveBeenCalled()
  })
  it('checks library attachments before saving without inserting temporary canvas nodes', async () => {
    const f = fixture(), refs: CanvasAgentImageReference[] = [{ source: 'library', slotId: '11111111-1111-4111-8111-111111111111', assetId: assetB }, { nodeId: 'image-a', assetId: assetA }]
    await f.prepare(refs)
    expect(f.environment.readAgentImageAsset).toHaveBeenCalledExactlyOnceWith(assetB)
    expect(f.environment.readAgentImageAsset.mock.invocationCallOrder[0]).toBeLessThan(f.environment.saveAgentWorkflow.mock.invocationCallOrder[0])
    expect(f.graph.nodes).toHaveLength(1); expect(refs[0]).toHaveProperty('source', 'library')
    f.environment.saveAgentWorkflow.mockClear(); f.environment.readAgentImageAsset.mockRejectedValueOnce(new Error('本人图片已回收'))
    await expect(f.prepare(refs)).rejects.toThrow('已回收'); expect(f.environment.saveAgentWorkflow).not.toHaveBeenCalled()
  })
  it('detects graph changes while save is pending and leaves the original reference unchanged', async () => {
    const f = fixture(), refs = [{ nodeId: 'image-a', assetId: assetA }]
    f.environment.saveAgentWorkflow.mockImplementation(async () => { f.graph.nodes[0].data.result!.assetId = assetB; return 3 })
    await expect(f.prepare(refs)).rejects.toThrow('保存期间发生变化')
    expect(refs[0].assetId).toBe(assetA)
  })
  it('keeps text-only preparation compatible and does not mutate read-only locked media', async () => {
    const f = fixture(); f.graph.nodes[0].locked = true
    await expect(f.prepare()).resolves.toMatchObject({ projectId: 'project-a' })
    await expect(f.prepare([{ nodeId: 'image-a', assetId: assetA }])).resolves.toMatchObject({ projectId: 'project-a' })
    expect(f.graph.nodes[0].locked).toBe(true)
  })
  it('never partially adds an oversized selection or acts in an obsolete scope', () => {
    const f = fixture()
    f.graph.nodes = Array.from({ length: 5 }, (_, i) => image(`n${i}`)); f.environment.selectedNodeIds.splice(0, 1, ...f.graph.nodes.map((node) => node.id))
    f.send(); expect(f.environment.setAgentContextRequest).not.toHaveBeenCalled(); expect(f.environment.setBanner).toHaveBeenCalledWith(expect.stringContaining('4 张'))
    f.active.value = false; f.graph.nodes = [image()]; f.send(); expect(f.environment.setAgentOpen).not.toHaveBeenCalled()
  })
  it.each(['dirty', 'queued', 'running'] as const)('explicitly blocks %s result images instead of silently adding text-only context from the toolbar', (kind) => {
    const f = fixture()
    if (kind === 'dirty') f.graph.nodes[0].data.dirty = true
    else f.graph.nodes[0].data.status = kind
    f.send()
    expect(f.environment.setAgentContextRequest).not.toHaveBeenCalled(); expect(f.environment.setAgentOpen).not.toHaveBeenCalled()
    expect(f.environment.setBanner).toHaveBeenCalledWith(expect.stringContaining('加入选中节点文字'))
  })
})

describe('actual Agent plan focus lifecycle', () => {
  function focusFixture(narrow = false) {
    const active = { value: true }, frames: (() => void)[] = [], setViewport = vi.fn()
    const surface = narrow ? { left: 48, right: 390, width: 342, height: 700 } : { left: 48, right: 1280, width: 1232, height: 650 }
    const panel = { current: narrow ? { left: 48, right: 390 } : { left: 900, right: 1280 } as { left: number; right: number } | null }
    const environment = { cancelInsertionViewportNavigation: vi.fn(), agentScope: { active: () => active.value }, createdNodeFocusRef: { current: { cancel: vi.fn() } }, viewportRestorationRef: { current: { cancel: vi.fn() } }, getGraphSnapshot: () => ({ nodes: [{ id: 'new-prompt' }, { id: 'new-output' }, { id: 'unrelated' }] }),
      document: { querySelector: (selector: string) => selector === '.canvas-flow' ? { getBoundingClientRect: () => surface } : panel.current ? { getBoundingClientRect: () => panel.current } : null },
      reactFlow: { getNodesBounds: vi.fn().mockReturnValue({ x: 1000, y: 200, width: 700, height: 400 }), setViewport }, agentPlanFocusViewport,
      window: { requestAnimationFrame: (callback: () => void) => { frames.push(callback) } }, setAgentOpen: vi.fn(() => { panel.current = null }), setAssetTrayOpen: vi.fn(), setRunInspectorOpen: vi.fn(), setNodeInspectorOpen: vi.fn(),
    }
    function flush() { for (let count = 0; frames.length && count < 10; count++) frames.shift()!() }
    return { environment, active, frames, flush, focus: actual<(ids: string[]) => void>('focusAgentPlan', environment), setViewport }
  }
  it('focuses only plan nodes in the visible area after React Flow has measured them', () => {
    const f = focusFixture(); f.focus(['new-prompt', 'new-output']); expect(f.setViewport).not.toHaveBeenCalled(); f.flush()
    expect(f.environment.reactFlow.getNodesBounds).toHaveBeenCalledWith([{ id: 'new-prompt' }, { id: 'new-output' }])
    expect(f.setViewport).toHaveBeenCalledOnce(); expect(f.environment.setAgentOpen).not.toHaveBeenCalled()
  })
  it('closes covering panels on narrow screens before fitting the plan', () => {
    const f = focusFixture(true); f.focus(['new-prompt']); f.flush()
    expect(f.environment.setAgentOpen).toHaveBeenCalledWith(false); expect(f.setViewport).toHaveBeenCalledOnce()
    expect(f.environment.setAgentOpen.mock.invocationCallOrder[0]).toBeLessThan(f.setViewport.mock.invocationCallOrder[0])
  })
  it('does not move a new project after the original plan focus was scheduled', () => {
    const f = focusFixture(); f.focus(['new-prompt']); f.active.value = false; f.flush(); expect(f.setViewport).not.toHaveBeenCalled()
  })
})

describe('actual App private attachment asset bridge', () => {
  function bridgeFixture() {
    const active = { value: true }, asset = { assetId: assetA, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetA}`, thumbnailUrl: `xingmang-asset://image/${assetA}`, fileName: '本人.png', width: 640, height: 480, createdAt: '2026-10-16T00:00:00Z' }
    const bridge = { listAssets: vi.fn().mockResolvedValue({ items: [asset] }), getAssetDetail: vi.fn().mockResolvedValue(asset), pickAsset: vi.fn().mockResolvedValue(asset) }
    const env = { agentScope: { active: () => active.value }, projectCanRunRef: { current: true }, hostBridge: () => bridge, isTemplateImageAsset, setAssetCatalog: vi.fn() }
    const read = actual<(id: string, signal?: AbortSignal) => Promise<typeof asset>>('readAgentImageAsset', env)
    return { active, asset, bridge, env, read, list: actual<(query: object) => Promise<unknown>>('listAgentImageAssets', env), upload: actual<() => Promise<typeof asset | null>>('importAgentImage', { ...env, readAgentImageAsset: read }) }
  }
  it('restricts lists to private images and retains recent only when explicitly requested', async () => {
    const f = bridgeFixture(); await f.list({ mediaType: 'video', view: 'trash', offset: 24, limit: 24, search: '商品' })
    expect(f.bridge.listAssets).toHaveBeenCalledWith({ mediaType: 'image', view: 'all', offset: 24, limit: 24, search: '商品' })
    await f.list({ view: 'recent' }); expect(f.bridge.listAssets).toHaveBeenLastCalledWith({ mediaType: 'image', view: 'recent' })
    f.bridge.listAssets.mockImplementationOnce(async () => { f.active.value = false; return { items: [] } })
    await expect(f.list({})).rejects.toThrow('旧素材列表已取消')
  })
  it('checks image ownership metadata after upload, updates only the catalog, and treats picker cancellation as no change', async () => {
    const f = bridgeFixture(); await expect(f.upload()).resolves.toEqual(f.asset)
    expect(f.bridge.pickAsset).toHaveBeenCalledExactlyOnceWith({ mediaType: 'image' }); expect(f.bridge.getAssetDetail).toHaveBeenCalledExactlyOnceWith(assetA, undefined)
    expect(f.env.setAssetCatalog).toHaveBeenCalledOnce()
    f.bridge.pickAsset.mockResolvedValueOnce(null); await expect(f.upload()).resolves.toBeNull(); expect(f.env.setAssetCatalog).toHaveBeenCalledOnce()
  })
  it.each(['scope', 'permission', 'abort', 'wrong-identity', 'deleted'] as const)('rejects %s private detail results without publishing a new attachment', async (reason) => {
    const f = bridgeFixture(), controller = new AbortController()
    f.bridge.getAssetDetail.mockImplementationOnce(async () => {
      if (reason === 'scope') f.active.value = false
      if (reason === 'permission') f.env.projectCanRunRef.current = false
      if (reason === 'abort') controller.abort()
      return { ...f.asset, ...(reason === 'wrong-identity' ? { assetId: assetB } : {}), ...(reason === 'deleted' ? { deletedAt: '2026-10-16T01:00:00Z' } : {}) }
    })
    await expect(f.read(assetA, controller.signal)).rejects.toThrow(); expect(f.env.setAssetCatalog).not.toHaveBeenCalled()
  })
})
