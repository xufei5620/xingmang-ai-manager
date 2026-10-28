import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as recovery from './project-history-recovery'

const ownerId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const original: recovery.ProjectHistoryRecoveryRecord = { version: 1, ownerId, projectId, input: { operationId, revisionId: 'a'.repeat(32), expectedVersion: 8 }, createdAt: '2026-10-23T00:00:00Z' }
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let effectSource = '', reloadSource = ''
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('async function refreshProjectHistoryRecovery')) effectSource = node.arguments[0].getText(source)
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'reloadCloudProject' && node.initializer && ts.isCallExpression(node.initializer)) reloadSource = node.initializer.arguments[0].getText(source)
  ts.forEachChild(node, visit)
}
visit(source)
function actual<T>(code: string, environment: Record<string, unknown>): T {
  if (!code) throw new Error('Missing actual App recovery code')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${code});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
async function settled() { await new Promise<void>((resolve) => setImmediate(resolve)) }

function fixture() {
  const values = new Map<string, string>(), listeners = new Map<string, (event: { key: string | null }) => void>()
  const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }) }
  recovery.writeProjectHistoryRecovery(storage, original)
  const bridge = { inspectProjectRestore: vi.fn(async (): Promise<{ state: string }> => ({ state: 'missing' })), restoreProjectRevision: vi.fn() }
  const e = {
    ...recovery, storageMode: 'cloud', creationOwnerId: ownerId, activeProject: { id: projectId, version: 8 }, draftActionsEnabled: true,
    projectEpochRef: { current: 1 }, draftActionsEnabledRef: { current: true }, historyRecoveryOwnerRef: { current: ownerId }, activeProjectIdRef: { current: projectId },
    historyBusyRef: { current: false }, historyPendingRef: { current: null as { projectId: string; epoch: number; input: typeof original.input; record?: recovery.ProjectHistoryRecoveryRecord } | null }, historyMissingRef: { current: null }, historyRecoveryErrorRef: { current: null }, saveConflictRef: { current: false }, autosaveTimerRef: { current: null },
    setHistoryPendingState: vi.fn(), setHistoryError: vi.fn(), setSaveConflict: vi.fn(), setAutoSaveState: vi.fn(), openStoredProject: vi.fn(), hostBridge: () => bridge,
    window: { localStorage: storage, clearTimeout: vi.fn(), addEventListener: vi.fn((name: string, work: (event: { key: string | null }) => void) => { listeners.set(name, work) }), removeEventListener: vi.fn((name: string, work: (event: { key: string | null }) => void) => { if (listeners.get(name) === work) listeners.delete(name) }) },
  }
  return { e, storage, bridge, listeners, values, mount: () => actual<() => (() => void) | undefined>(effectSource, e)() }
}

describe('actual App project history journal hydration', () => {
  it.each(['missing', 'restored', 'changed'])('reads the original %s result on refresh without writing or installing a workflow', async (state) => {
    const f = fixture(); f.bridge.inspectProjectRestore.mockResolvedValueOnce({ state })
    const before = [...f.values.values()]; f.mount(); await settled()
    expect(f.bridge.inspectProjectRestore).toHaveBeenCalledWith(projectId, original.input)
    expect(f.bridge.restoreProjectRevision).not.toHaveBeenCalled(); expect(f.e.openStoredProject).not.toHaveBeenCalled()
    expect(f.e.historyPendingRef.current?.record).toEqual(original); expect(f.e.saveConflictRef.current).toBe(true)
    expect(f.e.setHistoryPendingState).toHaveBeenLastCalledWith(state === 'restored' ? 'completed' : state)
    expect([...f.values.values()]).toEqual(before); expect(f.storage.removeItem).not.toHaveBeenCalled()
  })
  it.each(['cleanup', 'owner', 'project', 'epoch', 'permission'])('ignores a late original result after %s changes', async (boundary) => {
    const f = fixture(), gate = deferred<{ state: string }>(); f.bridge.inspectProjectRestore.mockImplementationOnce(() => gate.promise)
    const close = f.mount(); const calls = f.e.setHistoryPendingState.mock.calls.length
    if (boundary === 'cleanup') close?.()
    if (boundary === 'owner') f.e.historyRecoveryOwnerRef.current = projectId
    if (boundary === 'project') f.e.activeProjectIdRef.current = ownerId
    if (boundary === 'epoch') f.e.projectEpochRef.current++
    if (boundary === 'permission') f.e.draftActionsEnabledRef.current = false
    gate.resolve({ state: 'restored' }); await settled()
    expect(f.e.setHistoryPendingState).toHaveBeenCalledTimes(calls); expect(f.e.openStoredProject).not.toHaveBeenCalled()
    expect(f.storage.removeItem).not.toHaveBeenCalled()
  })
  it('survives StrictMode replay and ignores the first setup result', async () => {
    const f = fixture(), old = deferred<{ state: string }>(); f.bridge.inspectProjectRestore.mockImplementationOnce(() => old.promise)
    f.mount()?.(); const close = f.mount(); await settled()
    expect(f.e.setHistoryPendingState).toHaveBeenLastCalledWith('missing')
    old.resolve({ state: 'restored' }); await settled()
    expect(f.e.setHistoryPendingState).toHaveBeenLastCalledWith('missing')
    close?.(); expect(f.listeners.size).toBe(0)
  })
  it('preserves malformed journal bytes, pauses autosave and does not inspect or replace them', async () => {
    const f = fixture(), key = recovery.projectHistoryRecoveryKey(ownerId, projectId); f.values.set(key, '{broken')
    f.mount(); await settled()
    expect(f.bridge.inspectProjectRestore).not.toHaveBeenCalled(); expect(f.e.saveConflictRef.current).toBe(true)
    expect(f.e.historyRecoveryErrorRef.current).toEqual(expect.stringContaining('记录'))
    expect(f.values.get(key)).toBe('{broken'); expect(f.storage.removeItem).not.toHaveBeenCalled()
  })
  it('takes a new identity from a matching storage event and fences an older read', async () => {
    const f = fixture(), old = deferred<{ state: string }>(); f.bridge.inspectProjectRestore.mockImplementationOnce(() => old.promise)
    f.mount()
    const replacement = { ...original, input: { ...original.input, operationId: ownerId } }
    f.values.set(recovery.projectHistoryRecoveryKey(ownerId, projectId), JSON.stringify(replacement))
    f.listeners.get('storage')!({ key: recovery.projectHistoryRecoveryKey(ownerId, projectId) }); await settled()
    expect(f.e.historyPendingRef.current?.input.operationId).toBe(ownerId)
    old.resolve({ state: 'restored' }); await settled()
    expect(f.e.setHistoryPendingState).toHaveBeenLastCalledWith('missing')
    expect(f.bridge.restoreProjectRevision).not.toHaveBeenCalled()
  })
  it('ignores other account or project storage events', async () => {
    const f = fixture(); f.mount(); await settled()
    f.listeners.get('storage')!({ key: recovery.projectHistoryRecoveryKey(projectId, ownerId) }); await settled()
    expect(f.bridge.inspectProjectRestore).toHaveBeenCalledTimes(1)
  })
})

function reloadFixture() {
  const f = fixture(); f.e.historyPendingRef.current = { projectId, epoch: 1, input: original.input, record: original }
  f.bridge.inspectProjectRestore.mockResolvedValue({ state: 'changed' })
  const order: string[] = [], pending = f.e.historyPendingRef
  const e = { ...f.e, draftActionBusy: false, creationOwnerId: ownerId, renameScopeRef: { current: 0 }, draftOwnerId: 10,
    setDraftActionBusy: vi.fn(), setBanner: vi.fn(), workflowSnapshot: () => 'private workflow', serializeWorkflow: (value: string) => value,
    persistBrowserDraft: vi.fn((): { revision: string } | null => { order.push('draft'); return { revision: 'retained' } }), assertCanvasBrowserDraftStored: vi.fn(() => { order.push('verify-draft') }), buildCanvasBrowserDraftWriterRotation: () => ({ writerId: 'next-writer', revisionSequence: 0 }),
    draftWriterIdRef: { current: 'old-writer' }, draftRevisionSequenceRef: { current: 5 }, browserDraftRef: { current: {} }, crypto: { randomUUID: () => operationId },
    withProjectHistoryRecoveryLock: (_owner: string, _project: string, current: () => boolean, work: () => Promise<unknown>) => recovery.withProjectHistoryRecoveryLock(_owner, _project, current, work, { run: async (_key, callback) => await callback() }),
    openStoredProject: vi.fn(async (_id: string, options: { resolvedRecovery?: recovery.ProjectHistoryRecoveryRecord }) => { order.push('open'); if (options.resolvedRecovery) recovery.clearProjectHistoryRecovery(f.storage, options.resolvedRecovery); pending.current = null; return true }),
  }
  f.bridge.inspectProjectRestore.mockImplementation(async () => { order.push('GET'); return { state: 'changed' } })
  return { ...f, e, order, reload: (resolve = true) => actual<(resolve: boolean) => Promise<void>>(reloadSource, e)(resolve) }
}

describe('actual App explicit changed-receipt cloud reading', () => {
  it('protects and verifies the latest local draft before GET, clears only after known result and rotates its writer', async () => {
    const f = reloadFixture(); await f.reload()
    expect(f.order).toEqual(['draft', 'verify-draft', 'GET', 'open'])
    expect(f.e.openStoredProject).toHaveBeenCalledWith(projectId, { skipDraftRecovery: true, resolvedRecovery: original })
    expect(f.e.draftWriterIdRef.current).toBe('next-writer'); expect(recovery.readProjectHistoryRecovery(f.storage, ownerId, projectId)).toBeNull()
    expect(f.bridge.restoreProjectRevision).not.toHaveBeenCalled()
  })
  it('keeps a missing operation and local draft without POST or changing the current graph', async () => {
    const f = reloadFixture(); f.bridge.inspectProjectRestore.mockResolvedValueOnce({ state: 'missing' }); await f.reload()
    expect(f.e.openStoredProject).not.toHaveBeenCalled(); expect(f.bridge.restoreProjectRevision).not.toHaveBeenCalled()
    expect(recovery.readProjectHistoryRecovery(f.storage, ownerId, projectId)).toEqual(original)
    expect(f.e.setHistoryPendingState).toHaveBeenCalledWith('missing')
  })
  it('does not read or clear the original result when its local draft cannot be retained', async () => {
    const f = reloadFixture(); f.e.persistBrowserDraft.mockReturnValueOnce(null); await f.reload()
    expect(f.bridge.inspectProjectRestore).not.toHaveBeenCalled(); expect(f.e.openStoredProject).not.toHaveBeenCalled()
    expect(recovery.readProjectHistoryRecovery(f.storage, ownerId, projectId)).toEqual(original)
  })
  it('does not install after the owning account changes while its inspection is waiting', async () => {
    const f = reloadFixture(), gate = deferred<{ state: string }>(); f.bridge.inspectProjectRestore.mockImplementationOnce(() => gate.promise)
    const work = f.reload(); await settled(); f.e.historyRecoveryOwnerRef.current = projectId; gate.resolve({ state: 'changed' }); await work
    expect(f.e.openStoredProject).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled()
    expect(f.e.setBanner).not.toHaveBeenCalled()
  })
})
