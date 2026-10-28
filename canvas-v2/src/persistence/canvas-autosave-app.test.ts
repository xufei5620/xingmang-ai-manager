import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toCanvasNode, toWorkflowNode } from '../App'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { canvasAutosaveErrorMessage, canvasAutosaveGraphSignature, canvasAutosaveSignature } from './canvas-autosave'
import { canvasWorkflowSnapshotNeedsSave, inspectCanvasWorkflowSnapshot, type CanvasWorkflowSnapshot } from './workflow-snapshot'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualAutosaveEffect(environment: Record<string, unknown>): () => void | (() => void) {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('signature === lastAutosaveSignatureRef.current')) expression = node.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Missing actual project autosave effect')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => void | (() => void)
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
function fixture() {
  vi.useFakeTimers()
  let state: 'idle' | 'pending' | 'saving' | 'saved' | 'failed' = 'pending'
  const original: WorkflowFile = { ...createEmptyWorkflow('来源撤销验收'), nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '画面', model: 'gpt-image-1', group: 'fixed-source', status: 'idle' } }] }
  const snapshot = inspectCanvasWorkflowSnapshot(original)
  if (snapshot.content === null) throw new Error(snapshot.errorMessage)
  const nodes = original.nodes.map(toCanvasNode), viewport = original.viewport
  const e = {
    collaborationState: null as { phase: string } | null, collaborationRef: { current: null as { needsOperationSave(): boolean } | null },
    projectCanEdit: true, window: { xingmangCanvasHost: {}, setTimeout, clearTimeout }, activeProject: { id: 'project-a', name: original.name },
    closeBusyRef: { current: false }, projectTransitionRef: { current: false }, saveConflictRef: { current: false }, draftRecoveryPendingRef: { current: false }, projectEpochRef: { current: 1 }, projectCanEditRef: { current: true },
    workflowSerialization: snapshot as CanvasWorkflowSnapshot, mediaGroups: original.mediaGroups ?? {}, nodes, edges: original.edges, viewport,
    toWorkflowNode, toWorkflowEdge: (edge: unknown) => edge, canvasAutosaveSignature, canvasAutosaveGraphSignature, canvasAutosaveErrorMessage, canvasWorkflowSnapshotNeedsSave,
    projectHydrationRef: { current: false }, lastAutosaveSignatureRef: { current: JSON.stringify([canvasAutosaveSignature({ ...original, nodes: nodes.map(toWorkflowNode) }), viewport]) },
    lastAutosaveGraphSignatureRef: { current: canvasAutosaveGraphSignature({ ...original, nodes: nodes.map(toWorkflowNode) }) },
    autoSaveRevisionRef: { current: 0 }, autosaveTimerRef: { current: null as ReturnType<typeof setTimeout> | null },
    lastConfirmedContentRef: { current: snapshot.content }, latestBrowserSnapshotRef: { current: { project: { id: 'project-a' }, ...snapshot } as { project: { id: string } } & CanvasWorkflowSnapshot },
    projectSaveChainRef: { current: Promise.resolve() }, queueProjectSave: vi.fn(async () => undefined), setBanner: vi.fn(),
    setAutoSaveState: vi.fn((next: typeof state | ((previous: typeof state) => typeof state)) => { state = typeof next === 'function' ? next(state) : next }),
  }
  function render() { return actualAutosaveEffect(e)() }
  return { e, original, snapshot, render, state: () => state, status: (next: typeof state) => { state = next } }
}
async function settled() { await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('actual App autosave after undoing a source change', () => {
  it('buffers local edits without queuing another save until the original collaboration ACK settles', async () => {
    const f = fixture(), buffered = structuredClone(f.original)
    buffered.nodes[0].data.prompt = 'Buffered local edit'
    f.e.nodes = buffered.nodes.map(toCanvasNode); f.e.workflowSerialization = inspectCanvasWorkflowSnapshot(buffered)
    f.e.latestBrowserSnapshotRef.current = { project: { id: 'project-a' }, ...f.e.workflowSerialization }
    f.e.collaborationState = { phase: 'busy' }; f.e.collaborationRef.current = { needsOperationSave: () => true }
    f.render(); await vi.advanceTimersByTimeAsync(1_000)
    expect(f.e.queueProjectSave).not.toHaveBeenCalled()
    f.e.collaborationState = { phase: 'live' }
    f.render(); await vi.advanceTimersByTimeAsync(800)
    expect(f.e.queueProjectSave).toHaveBeenCalledOnce()
  })
  it('cancels the unsent changed-source save and settles the exact confirmed undo without an extra write', async () => {
    const f = fixture(), changed = structuredClone(f.original)
    delete changed.nodes[0].data.group
    f.e.nodes = changed.nodes.map(toCanvasNode); f.e.workflowSerialization = inspectCanvasWorkflowSnapshot(changed)
    f.e.latestBrowserSnapshotRef.current = { project: { id: 'project-a' }, ...f.e.workflowSerialization }
    const cancel = f.render()
    expect(f.e.autosaveTimerRef.current).not.toBeNull()
    cancel?.()
    f.e.nodes = f.original.nodes.map(toCanvasNode); f.e.workflowSerialization = f.snapshot
    f.e.latestBrowserSnapshotRef.current = { project: { id: 'project-a' }, ...f.snapshot }
    f.render(); await settled(); await vi.advanceTimersByTimeAsync(1_000)
    expect(f.state()).toBe('saved'); expect(f.e.queueProjectSave).not.toHaveBeenCalled()
    expect(f.e.nodes[0].data.group).toBe('fixed-source'); expect(f.e.autosaveTimerRef.current).toBeNull()
  })

  it('waits for the earlier save chain before declaring the original snapshot confirmed', async () => {
    const f = fixture(), gate = deferred(); f.e.projectSaveChainRef.current = gate.promise
    f.render(); await settled(); expect(f.state()).toBe('pending')
    gate.resolve(); await settled()
    expect(f.state()).toBe('saved'); expect(f.e.queueProjectSave).not.toHaveBeenCalled()
  })

  it.each(['changed-confirmation', 'changed-content', 'project', 'epoch', 'permission', 'conflict', 'recovery', 'transition', 'closing', 'cleanup'] as const)('does not settle a stale or unsafe undo after %s', async (change) => {
    const f = fixture(), gate = deferred(); f.e.projectSaveChainRef.current = gate.promise
    const cleanup = f.render()
    if (change === 'changed-confirmation') f.e.lastConfirmedContentRef.current = 'a different write was confirmed'
    if (change === 'changed-content') f.e.latestBrowserSnapshotRef.current.content = 'a newer edit'
    if (change === 'project') f.e.latestBrowserSnapshotRef.current.project.id = 'project-b'
    if (change === 'epoch') f.e.projectEpochRef.current++
    if (change === 'permission') f.e.projectCanEditRef.current = false
    if (change === 'conflict') f.e.saveConflictRef.current = true
    if (change === 'recovery') f.e.draftRecoveryPendingRef.current = true
    if (change === 'transition') f.e.projectTransitionRef.current = true
    if (change === 'closing') f.e.closeBusyRef.current = true
    if (change === 'cleanup') cleanup?.()
    gate.resolve(); await settled()
    expect(f.state()).toBe('pending'); expect(f.e.queueProjectSave).not.toHaveBeenCalled()
  })

  it.each(['failed', 'saving'] as const)('preserves an existing %s status rather than hiding it behind an identical signature', async (status) => {
    const f = fixture(), gate = deferred(); f.e.projectSaveChainRef.current = gate.promise
    f.render(); f.status(status); gate.resolve(); await settled()
    expect(f.state()).toBe(status); expect(f.e.queueProjectSave).not.toHaveBeenCalled()
  })
})
