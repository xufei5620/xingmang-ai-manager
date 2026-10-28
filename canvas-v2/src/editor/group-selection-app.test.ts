import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { buildResourceTree, resourceGroupSelectionIds } from '../components/resource-tree-model'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { buildCanvasClipboardPayload, canvasClipboardMime, canvasClipboardWorkflow, parseCanvasClipboard, pasteCanvasClipboard, serializeCanvasClipboard } from './clipboard'
import { buildCanvasClipboardTransfer, canvasClipboardEventAllowed, parseCanvasClipboardTransfer, runCanvasClipboardPaste, writeCanvasClipboardEvent } from './clipboard-transport'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { createEmptyWorkflow, serializeWorkflow } from '../model'
import { maximumProjectContentBytes, maximumProjectEdges, maximumProjectNodes, utf8ByteLength } from '../lib/canvas-limits'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { groupCanvasNodes, validateParentGraph } from './grouping'
import { layoutCanvasSelection, type CanvasSelectionLayout } from './selection-layout'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function expression<T>(name: string, environment: Record<string, unknown>, property = false): T {
  let found = ''
  function visit(node: ts.Node) {
    if (!property && ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) found = node.initializer.arguments[0].getText(source)
    if (property && ts.isJsxAttribute(node) && node.name.getText(source) === name && node.initializer && ts.isJsxExpression(node.initializer)) found = node.initializer.expression?.getText(source) ?? ''
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error(`Missing actual App expression ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function clipboardEffect(environment: Record<string, unknown>): () => void {
  let found = ''
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes("window.addEventListener('copy', onCopy)")) found = node.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error('Missing actual App clipboard effect')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => void
}
function clipboardLifecycle(environment: Record<string, unknown>): () => void {
  let found = ''
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes("window.addEventListener('pagehide', invalidateClipboard)")) found = node.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error('Missing actual App clipboard lifecycle')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => void
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function fixture() {
  const nodes: CanvasNode[] = [
    { id: 'g', type: 'group', definitionVersion: 1, position: { x: 100, y: 200 }, width: 950, height: 750, selected: true, data: { prompt: '', model: '', status: 'idle' } },
    ...['a', 'b'].map((id, index): CanvasNode => ({ id, type: id === 'a' ? 'prompt' : 'text-generate', definitionVersion: 1, parentId: 'g', position: { x: 32 + index * 400, y: 96 }, width: 280, height: 180, data: { prompt: id, model: '', status: 'idle' } })),
    { id: 'root', type: 'prompt', definitionVersion: 1, position: { x: 1400, y: 100 }, data: { prompt: 'root', model: '', status: 'idle' } },
  ]
  const edges = [{ id: 'e', source: 'a', target: 'b', sourceHandle: 'out:text', targetHandle: 'in:text' }]
  const clipboardRef = { current: { revision: 0, controller: null as AbortController | null } }, setBanner = vi.fn(), execute = vi.fn(), setNodes = vi.fn()
  let sequence = 0
  let text = ''
  const host = { inspectClipboardWorkflow: vi.fn<() => Promise<void>>(async () => undefined) }, owner = '62026000-0000-4000-8000-000000000001'
  const layerEditorOwnerRef = { current: { ownerId: 1, accountId: owner } }, activeProjectIdRef = { current: '11111111-1111-4111-8111-111111111111' }, projectEpochRef = { current: 1 }, projectCanEditRef = { current: true }, closeBusyRef = { current: false }
  const writeText = vi.fn(async (value: string) => { text = value }), readText = vi.fn(async () => text)
  const environment: Record<string, unknown> = { nodes, edges, clipboardRef, buildCanvasClipboardPayload, canvasClipboardMime, canvasClipboardWorkflow, parseCanvasClipboard, serializeCanvasClipboard, buildCanvasClipboardTransfer, runCanvasClipboardPaste, writeCanvasClipboardEvent, pasteCanvasClipboard, canvasNodeDocumentRecord, toWorkflowEdge: (edge: unknown) => edge, toWorkflowNode: (node: CanvasNode) => ({ ...node, kind: node.type }), setBanner, execute, setNodes, nextNodeId: () => `new-${++sequence}`, toCanvasNode: (node: { kind: string }) => ({ ...node, type: node.kind }), getGraphSnapshot: () => ({ nodes, edges }), createEmptyWorkflow, serializeWorkflow, maximumProjectContentBytes, maximumProjectEdges, maximumProjectNodes, utf8ByteLength, activeProject: { name: '当前画布' }, mediaGroupsRef: { current: {} }, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, layerEditorScopeToken, projectCanEditRef, draftActionsEnabledRef: { current: true }, agentMountedRef: { current: true }, projectTransitionRef: { current: false }, draftRecoveryPendingRef: { current: false }, window: { xingmangCanvasHost: host }, hostBridge: () => host, navigator: { clipboard: { writeText, readText } } }
  environment.closeBusyRef = closeBusyRef
  environment.currentClipboardScope = expression('currentClipboardScope', environment)
  environment.buildSelectionClipboard = expression('buildSelectionClipboard', environment)
  environment.applyClipboardPayload = expression('applyClipboardPayload', environment)
  return { ...environment, nodes, edges, clipboardRef, setBanner, execute, setNodes, environment, host, owner, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, projectCanEditRef, closeBusyRef, writeText, readText, text: () => text, copy: expression<(ids: readonly string[], event?: ClipboardEvent) => Promise<boolean>>('copyNodes', environment), paste: expression<(content?: string) => Promise<void>>('pasteSelection', environment), duplicate: expression<(ids: readonly string[]) => void>('duplicateNodes', environment) }
}

describe('actual App group copy and selection eligibility', () => {
  it('copies group contents to the actual clipboard adapter with persisted dimensions and submits one add transaction', async () => {
    const f = fixture()
    expect(await f.copy(['g'])).toBe(true)
    const copied = parseCanvasClipboardTransfer(f.text(), f.owner)
    expect(copied.nodes).toHaveLength(3)
    expect(copied.nodes[0]).toMatchObject({ width: 950, height: 750 })
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('系统剪贴板'))
    await f.paste()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0][0]).toMatchObject({ type: 'add-nodes', nodes: expect.any(Array), edges: expect.any(Array) })
    expect(f.execute.mock.calls[0][0].nodes).toHaveLength(3)
    expect(f.execute.mock.calls[0][0].edges).toHaveLength(1)
    expect(f.setNodes).toHaveBeenCalledTimes(1)
  })

  it('writes native clipboard data synchronously without requiring async clipboard permissions', async () => {
    const f = fixture(), data = new Map<string, string>(), preventDefault = vi.fn()
    const event = { clipboardData: { setData: (kind: string, value: string) => data.set(kind, value) }, preventDefault } as unknown as ClipboardEvent
    const result = f.copy(['g'], event)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(parseCanvasClipboardTransfer(data.get('text/plain')!, f.owner).nodes).toHaveLength(3)
    expect(await result).toBe(true); expect(f.writeText).not.toHaveBeenCalled()
  })

  it('keeps duplicate usable when OS permission is denied and does not claim an in-memory cross-project copy', async () => {
    const f = fixture()
    f.writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    expect(await f.copy(['g'])).toBe(false)
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('浏览器拒绝'))
    expect(f.execute).not.toHaveBeenCalled()
    f.duplicate(['g'])
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.execute.mock.calls[0][0].nodes).toHaveLength(3)
    expect(f.readText).not.toHaveBeenCalled()
  })

  it('pastes the serialized group from a completely new App closure rather than a memory ref', async () => {
    const original = fixture(); await original.copy(['g'])
    const refreshed = fixture(); refreshed.activeProjectIdRef.current = '22222222-2222-4222-8222-222222222222'
    await refreshed.paste(original.text())
    const command = refreshed.execute.mock.calls[0][0]
    expect(command.type).toBe('add-nodes'); expect(command.nodes).toHaveLength(3); expect(command.edges).toHaveLength(1)
    expect(command.nodes.find((node: { type: string }) => node.type === 'group')).toMatchObject({ position: { x: 132, y: 232 }, width: 950, height: 750 })
    expect(original.execute).not.toHaveBeenCalled()
  })

  it('does not insert after a late OS clipboard read from a reopened destination', async () => {
    const f = fixture(); await f.copy(['g']); const gate = deferred<string>()
    f.readText.mockImplementationOnce(() => gate.promise)
    const job = f.paste(); f.projectEpochRef.current += 2; gate.resolve(f.text()); await job
    expect(f.execute).not.toHaveBeenCalled(); expect(f.setNodes).not.toHaveBeenCalled()
  })

  it.each(['pagehide', 'unmount'])('invalidates and aborts an actual pending clipboard read on %s', async (kind) => {
    const f = fixture(), gate = deferred<string>(), events = new Map<string, () => void>()
    await f.copy(['g'])
    const cleanup = clipboardLifecycle({ clipboardRef: f.clipboardRef, window: { addEventListener: (name: string, handler: () => void) => events.set(name, handler), removeEventListener: (name: string) => events.delete(name) } })
    f.readText.mockImplementationOnce(() => gate.promise)
    const job = f.paste(), controller = f.clipboardRef.current.controller
    if (kind === 'pagehide') events.get('pagehide')!()
    else cleanup()
    expect(controller?.signal.aborted).toBe(true)
    gate.resolve(f.text()); await job
    expect(f.execute).not.toHaveBeenCalled(); expect(f.setNodes).not.toHaveBeenCalled()
    if (kind === 'pagehide') cleanup()
    expect(events.size).toBe(0)
  })

  it.each(['account', 'project', 'permission', 'close', 'newer-paste'])('keeps a late private eligibility check from applying after %s changed', async (kind) => {
    const f = fixture(), gate = deferred<void>()
    const payload = { version: 1 as const, nodes: [{ id: 'image', type: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` } } }], edges: [] }
    const text = buildCanvasClipboardTransfer(payload, { ownerId: f.owner, projectId: null })
    f.host.inspectClipboardWorkflow.mockImplementationOnce(() => gate.promise)
    const job = f.paste(text); await Promise.resolve(); await Promise.resolve()
    expect(f.host.inspectClipboardWorkflow).toHaveBeenCalledOnce()
    if (kind === 'account') f.layerEditorOwnerRef.current.accountId = '62026000-0000-4000-8000-000000000002'
    if (kind === 'project') f.projectEpochRef.current += 2
    if (kind === 'permission') f.projectCanEditRef.current = false
    if (kind === 'close') f.closeBusyRef.current = true
    if (kind === 'newer-paste') await f.paste(buildCanvasClipboardTransfer({ version: 1, nodes: [{ id: 'fresh', type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'newer', model: '' } }], edges: [] }, { ownerId: f.owner, projectId: null }))
    gate.resolve(); await job
    expect(f.execute).toHaveBeenCalledTimes(kind === 'newer-paste' ? 1 : 0)
    if (kind === 'newer-paste') expect(f.execute.mock.calls[0][0].nodes[0].data.prompt).toBe('newer')
  })

  it('blocks missing originals before any add or selection update', async () => {
    const f = fixture()
    f.host.inspectClipboardWorkflow.mockRejectedValueOnce(new Error('原图缺失，尚未粘贴'))
    const payload = { version: 1 as const, nodes: [{ id: 'image', type: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', candidateAssetIds: ['a'.repeat(43)] } }], edges: [] }
    await f.paste(buildCanvasClipboardTransfer(payload, { ownerId: f.owner, projectId: null }))
    expect(f.execute).not.toHaveBeenCalled(); expect(f.setNodes).not.toHaveBeenCalled()
    expect(f.setBanner).toHaveBeenLastCalledWith('原图缺失，尚未粘贴')
  })

  it('refuses a paste that exceeds the real project node capacity without adding an undo command', async () => {
    const f = fixture()
    f.nodes.push(...Array.from({ length: maximumProjectNodes - f.nodes.length }, (_, index): CanvasNode => ({ id: `existing-${index}`, type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' } })))
    const text = buildCanvasClipboardTransfer({ version: 1, nodes: [{ id: 'new', type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '' } }], edges: [] }, { ownerId: f.owner, projectId: null })
    await f.paste(text)
    expect(f.execute).not.toHaveBeenCalled(); expect(f.setNodes).not.toHaveBeenCalled()
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('超过单个云端工程容量'))
  })

  it('preserves palette, text and modal native clipboard ownership in the actual App listeners and cleans them up', async () => {
    const f = fixture(), listeners = new Map<string, (event: ClipboardEvent) => void>(), nativeCopy = vi.fn(), nativePaste = vi.fn()
    const cleanup = clipboardEffect({ ...f.environment, copySelection: nativeCopy, pasteSelection: nativePaste, canvasClipboardEventAllowed, runPreflight: null, closeBusyRef: { current: false }, draftActionBusy: false, canvasModalOpen: () => false, window: { addEventListener: (kind: string, handler: (event: ClipboardEvent) => void) => listeners.set(kind, handler), removeEventListener: (kind: string) => listeners.delete(kind), getSelection: () => ({ isCollapsed: true }) } })
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'BUTTON', closest: (selector: string) => selector.includes('[role="dialog"]') ? {} : null }, { tagName: 'SPAN', isContentEditable: true }]) {
      const preventDefault = vi.fn(), event = { target, preventDefault, clipboardData: { getData: () => 'text' } } as unknown as ClipboardEvent
      listeners.get('copy')!(event); listeners.get('paste')!(event)
      expect(preventDefault).not.toHaveBeenCalled()
    }
    expect(nativeCopy).not.toHaveBeenCalled(); expect(nativePaste).not.toHaveBeenCalled()
    const preventDefault = vi.fn(), canvasEvent = { target: { tagName: 'DIV', closest: () => null }, preventDefault, clipboardData: { getData: () => 'actual-data' } } as unknown as ClipboardEvent
    listeners.get('copy')!(canvasEvent); listeners.get('paste')!(canvasEvent)
    expect(nativeCopy).toHaveBeenCalledOnce(); expect(nativePaste).toHaveBeenCalledWith('actual-data'); expect(preventDefault).toHaveBeenCalledOnce()
    cleanup(); expect(listeners.size).toBe(0)
  })

  it('enables grouping only for effective same-parent roots', () => {
    const { nodes } = fixture()
    for (const [selectedNodeIds, expected] of [[['a', 'b'], true], [['a', 'root'], false], [['g', 'a'], false], [['g', 'a', 'root'], true]] as const) expect(expression<boolean>('canGroup', { nodes, selectedNodeIds, resourceGroupSelectionIds }, true)).toBe(expected)
  })

  it.each([false, true])('commits ancestor expansion once or rejects locked grouping atomically (locked=%s)', (locked) => {
    const f = fixture()
    f.nodes[0].draggable = !locked
    const before = structuredClone(f.nodes)
    const run = expression<(ids: readonly string[]) => void>('groupNodes', { ...f, resourceGroupSelectionIds, groupCanvasNodes, validateParentGraph, buildResourceTree, builtinNodeRegistry, reactFlow: { getNode: () => undefined }, workflowNodeData: (_type: string, data: Record<string, unknown>) => ({ prompt: '', model: '', status: 'idle', settings: data }) })
    run(['a', 'b'])
    expect(f.nodes).toEqual(before)
    if (locked) {
      expect(f.execute).not.toHaveBeenCalled()
      expect(f.setNodes).not.toHaveBeenCalled()
      expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('锁定分组'))
    } else {
      expect(f.execute).toHaveBeenCalledTimes(1)
      const command = f.execute.mock.calls[0][0]
      expect(command.type).toBe('replace-nodes')
      expect(command.nodes[0]).toMatchObject({ id: 'g', position: { x: 68, y: 104 }, width: 982, height: 846 })
      expect(command.nodes[1]).toMatchObject({ type: 'group', parentId: 'g', position: { x: 32, y: 96 } })
    }
  })

  it('explains a locked ancestor no-op while retaining the opposite alignment against its fixed anchor', () => {
    const f = fixture()
    f.nodes[0].draggable = false
    f.nodes.push({ id: 'inner', type: 'group', definitionVersion: 1, parentId: 'g', position: { x: 32, y: 96 }, width: 400, height: 400, data: { prompt: '', model: '', status: 'idle' } })
    f.nodes[1].parentId = 'inner'
    for (const node of f.nodes) node.selected = ['a', 'root'].includes(node.id)
    const before = structuredClone(f.nodes)
    const run = expression<(operation: CanvasSelectionLayout) => void>('layoutSelection', { ...f, layoutCanvasSelection, builtinNodeRegistry, reactFlow: { getNode: () => undefined } })
    run({ kind: 'align', mode: 'right' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('锁定保护'))
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('本次未改变位置'))
    expect(f.nodes).toEqual(before)
    run({ kind: 'align', mode: 'left' })
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0][0].type).toBe('replace-nodes')
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('已对齐选中节点'))
  })

  it.each(['align', 'distribute'] as const)('explains too few independent roots for %s without creating undo history', (kind) => {
    const f = fixture()
    f.nodes[1].selected = true
    const run = expression<(operation: CanvasSelectionLayout) => void>('layoutSelection', { ...f, layoutCanvasSelection, builtinNodeRegistry, reactFlow: { getNode: () => undefined } })
    run(kind === 'align' ? { kind, mode: 'left' } : { kind, axis: 'horizontal' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining(`请至少选择 ${kind === 'align' ? 2 : 3} 个独立节点`))
    expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('按一个整体计算'))
  })

  it('distinguishes an already aligned selection from a locked no-op', () => {
    const f = fixture()
    for (const node of f.nodes) node.selected = ['g', 'root'].includes(node.id)
    f.nodes[3].position.x = f.nodes[0].position.x
    const run = expression<(operation: CanvasSelectionLayout) => void>('layoutSelection', { ...f, layoutCanvasSelection, builtinNodeRegistry, reactFlow: { getNode: () => undefined } })
    run({ kind: 'align', mode: 'left' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.setBanner).toHaveBeenLastCalledWith('选中节点已经满足此方向的对齐，本次未改变位置')
  })
})
