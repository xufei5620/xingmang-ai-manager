import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { isDefiniteProjectHistoryRejection, runProjectHistoryRestore } from './project-history-restore'
import * as recovery from './project-history-recovery'

const ownerId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const revisionId = 'a'.repeat(32)

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

describe('project history save and restore ordering', () => {
  it('captures after older saves and confirms only after the current save and restore complete', async () => {
    const previous = deferred<void>(), saved = deferred<void>(), restored = deferred<string>()
    const events: string[] = []; let latest = 'old'
    const promise = runProjectHistoryRestore({ pendingSaves: previous.promise, current: () => true,
      capture: () => latest, save: async (snapshot) => { events.push(`save:${snapshot}`); await saved.promise },
      restore: async () => { events.push('restore'); return restored.promise }, confirm: async (result) => { events.push(`confirm:${result}`) },
    })
    latest = 'latest'; previous.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(['save:latest'])
    saved.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(['save:latest', 'restore'])
    restored.resolve('new version'); await promise
    expect(events).toEqual(['save:latest', 'restore', 'confirm:new version'])
  })
  it.each(['pending', 'save', 'restore'])('rejects a stale scope after %s without installing a graph', async (boundary) => {
    let current = true
    const confirm = vi.fn()
    await expect(runProjectHistoryRestore({ pendingSaves: Promise.resolve().then(() => { if (boundary === 'pending') current = false }), current: () => current,
      capture: () => 'graph', save: async () => { if (boundary === 'save') current = false }, restore: async () => { if (boundary === 'restore') current = false; return 'receipt' }, confirm,
    })).rejects.toThrow('已切换')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('never submits a restore after a content save failure and does not classify unknown failures as rejected', async () => {
    const restore = vi.fn()
    await expect(runProjectHistoryRestore({ pendingSaves: Promise.resolve(), current: () => true, capture: () => 'graph', save: async () => { throw new Error('save failed') }, restore, confirm: vi.fn() })).rejects.toThrow('save failed')
    expect(restore).not.toHaveBeenCalled()
    expect(isDefiniteProjectHistoryRejection(new Error('timeout'))).toBe(false)
    expect(isDefiniteProjectHistoryRejection({ status: 502 })).toBe(false)
    expect(isDefiniteProjectHistoryRejection({ status: 409 })).toBe(true)
  })
})

const appSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let restoreSource = ''
let openSource = ''
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'restoreProjectHistory') restoreSource = node.getText(appSource)
  if (ts.isVariableDeclaration(node) && node.name.getText(appSource) === 'openStoredProject' && node.initializer && ts.isCallExpression(node.initializer)) openSource = node.initializer.arguments[0].getText(appSource)
  ts.forEachChild(node, collect)
}
collect(appSource)

function restoreCallback(environment: Record<string, unknown>): (detail?: unknown) => Promise<void> {
  const code = ts.transpileModule(`return (${restoreSource});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as (detail?: unknown) => Promise<void>
}

function fixture() {
  const project = { id: projectId, version: 7, name: '画布' }
  const restored = { state: 'restored', project: { ...project, version: 9 }, content: 'restored graph', projectProvenance: [] }
  const result = { canRestore: true, revision: { id: revisionId, projectId: project.id } }
  const events: string[] = []
  const data = new Map<string, string>()
  const localStorage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const environment: Record<string, unknown> = {
    collaborationRef: { current: null },
    ...recovery, storageMode: 'cloud', creationOwnerId: ownerId, historyRecoveryOwnerRef: { current: ownerId }, historyRecoveryErrorRef: { current: null }, historyMissingRef: { current: null },
    withProjectHistoryRecoveryLock: (owner: string, project: string, current: () => boolean, work: () => Promise<unknown>) => recovery.withProjectHistoryRecoveryLock(owner, project, current, work, { run: async (_key, callback) => await callback() }),
    projectCanRestore: true, activeProject: project, historyScope: {}, historyCurrent: true, historyBusyRef: { current: false }, projectTransitionRef: { current: false }, closeBusyRef: { current: false },
    historyPendingRef: { current: null }, projectEpochRef: { current: 1 }, historyDialogEpochRef: { current: 3 }, renameScopeRef: { current: 0 }, draftActionsEnabledRef: { current: true }, activeProjectIdRef: { current: project.id },
    saveConflictRef: { current: false }, draftRecoveryPendingRef: { current: false }, activeRunsRef: { current: new Map() }, running: false, startingRunsRef: { current: 0 }, resumingTaskIdsRef: { current: new Set() }, pendingRunProjectionIdsRef: { current: new Set() }, autosaveTimerRef: { current: null }, autoSaveRevisionRef: { current: 1 }, projectSaveChainRef: { current: Promise.resolve() },
    latestBrowserSnapshotRef: { current: { project, content: 'latest graph' } }, lastConfirmedContentRef: { current: 'older graph' }, draftBaseVersionRef: { current: 7 }, draftOwnerId: 10,
    draftWriterIdRef: { current: 'original-writer' }, draftRevisionSequenceRef: { current: 1 }, browserDraftRef: { current: null },
    setHistoryError: vi.fn(), setHistoryBusy: vi.fn(), setProjectTransition: vi.fn(), setHistoryPendingState: vi.fn(), setBanner: vi.fn(), setAutoSaveState: vi.fn(), setSaveConflict: vi.fn(),
    persistBrowserDraft: vi.fn(() => ({ revision: 'retained' })), assertCanvasBrowserDraftStored: vi.fn(), buildCanvasBrowserDraftWriterRotation: vi.fn(() => ({ writerId: 'new-writer', revisionSequence: 0 })),
    runProjectHistoryRestore, isDefiniteProjectHistoryRejection, canvasWorkflowSnapshotNeedsSave: (snapshot: { content: string }, confirmed: string) => snapshot.content !== confirmed,
    crypto: { randomUUID: () => operationId }, window: { clearTimeout: vi.fn(), localStorage },
  }
  function ref<T>(name: string) { return environment[name] as { current: T } }
  const bridge = {
    restoreProjectRevision: vi.fn(async (): Promise<unknown> => { events.push('restore'); return restored }),
    inspectProjectRestore: vi.fn(async (): Promise<unknown> => restored),
  }
  environment.hostBridge = () => bridge
  environment.queueProjectSave = vi.fn(async (_project: unknown, content: string) => { events.push('save'); ref('lastConfirmedContentRef').current = content; ref('draftBaseVersionRef').current = 8 })
  environment.openStoredProject = vi.fn(async (_id: string, options?: { resolvedRecovery?: recovery.ProjectHistoryRecoveryRecord }) => { if (options?.resolvedRecovery) recovery.clearProjectHistoryRecovery(localStorage, options.resolvedRecovery); events.push('install'); ref<number>('projectEpochRef').current++; ref<number>('historyDialogEpochRef').current++; ref('historyPendingRef').current = null; return true })
  return { environment, bridge, events, result, restored, ref, localStorage, run: () => restoreCallback(environment)(result), retry: () => restoreCallback(environment)(), repeat: () => (restoreCallback(environment) as (detail: undefined, retry: boolean) => Promise<void>)(undefined, true) }
}

describe('actual App project history restore handler', () => {
  it('allows no restore write for a collaborator even when the retained detail was formerly restorable', async () => {
    const f = fixture(); f.environment.projectCanRestore = false; await f.run()
    expect(f.bridge.restoreProjectRevision).not.toHaveBeenCalled(); expect(f.environment.queueProjectSave).not.toHaveBeenCalled()
    expect(f.environment.setHistoryError).toHaveBeenCalledWith(expect.stringContaining('只有项目拥有者'))
  })
  it('keeps an unknown restore reconcilable after a failed reload advanced the request epoch', async () => {
    const pending = { projectId: 'project', epoch: 4, input: { operationId: 'same-operation' } }
    const environment = {
      historyPendingRef: { current: pending }, projectRequestRevisionRef: { current: 1 }, projectEpochRef: { current: 4 }, autoSaveRevisionRef: { current: 1 },
      activeProjectIdRef: { current: 'project' }, draftActionsEnabledRef: { current: true }, setProjectLoading: vi.fn(), setProjectError: vi.fn(),
      hostBridge: () => ({ openProject: async () => { throw new Error('offline') } }),
    }
    const code = ts.transpileModule(`return (${openSource});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const open = new Function(...Object.keys(environment), code)(...Object.values(environment)) as (id: string) => Promise<boolean>
    expect(await open('project')).toBe(false)
    expect(pending.epoch).toBe(5)
    expect(pending.input.operationId).toBe('same-operation')
    expect(environment.setProjectError).toHaveBeenCalledWith('offline')
  })
  it('saves the latest editor graph and uses its confirmed version for CAS before installing', async () => {
    const subject = fixture(); await subject.run()
    expect(subject.events).toEqual(['save', 'restore', 'install'])
    expect(subject.bridge.restoreProjectRevision).toHaveBeenCalledWith(projectId, { operationId, revisionId, expectedVersion: 8 })
    expect(subject.environment.queueProjectSave).toHaveBeenCalledWith(subject.environment.activeProject, 'latest graph', expect.any(Number), { retainRevisionId: revisionId })
    expect(subject.environment.openStoredProject).toHaveBeenCalledWith(projectId, expect.objectContaining({ skipDraftRecovery: true, confirmed: subject.restored, resolvedRecovery: expect.objectContaining({ ownerId, projectId, input: { operationId, revisionId, expectedVersion: 8 } }) }))
    expect(subject.ref('projectTransitionRef').current).toBe(false)
  })
  it('pauses autosave after an unknown receipt and reconciles without another save or restore', async () => {
    const subject = fixture(); subject.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response'))
    await subject.run()
    expect(subject.ref('saveConflictRef').current).toBe(true)
    expect(subject.environment.openStoredProject).not.toHaveBeenCalled()
    const pending = subject.ref<{ input: unknown }>('historyPendingRef').current
    await subject.retry()
    expect(subject.bridge.inspectProjectRestore).toHaveBeenCalledWith(projectId, pending.input)
    expect(subject.bridge.restoreProjectRevision).toHaveBeenCalledTimes(1)
    expect(subject.environment.queueProjectSave).toHaveBeenCalledTimes(1)
    expect(subject.environment.openStoredProject).toHaveBeenCalledTimes(1)
  })
  it('keeps inspection read only and resubmits the same input only after an explicit missing-result retry', async () => {
    const subject = fixture(); subject.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response'))
    await subject.run()
    subject.bridge.inspectProjectRestore.mockImplementationOnce(async () => ({ state: 'missing' }))
    await subject.retry()
    expect(subject.bridge.restoreProjectRevision).toHaveBeenCalledTimes(1)
    expect(subject.environment.setHistoryPendingState).toHaveBeenCalledWith('missing')
    subject.bridge.inspectProjectRestore.mockImplementationOnce(async () => ({ state: 'missing' }))
    await subject.repeat()
    expect(subject.bridge.restoreProjectRevision.mock.calls[1]).toEqual(subject.bridge.restoreProjectRevision.mock.calls[0])
    expect(subject.environment.queueProjectSave).toHaveBeenCalledTimes(1)
  })
  it('protects edits made after closing the unknown-result dialog using a separate draft writer', async () => {
    const subject = fixture(); subject.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response'))
    await subject.run()
    subject.ref<{ content: string }>('latestBrowserSnapshotRef').current.content = 'new local edits'
    await subject.retry()
    expect(subject.environment.persistBrowserDraft).toHaveBeenLastCalledWith(subject.environment.activeProject, 'new local edits')
    expect(subject.environment.assertCanvasBrowserDraftStored).toHaveBeenCalled()
    expect(subject.ref('draftWriterIdRef').current).toBe('new-writer')
    expect(subject.environment.queueProjectSave).toHaveBeenCalledTimes(1)
  })
  it('does not install a restored receipt delivered after an account lock or project switch', async () => {
    const subject = fixture(), response = deferred<typeof subject.restored>()
    subject.bridge.restoreProjectRevision.mockImplementationOnce(() => response.promise)
    const work = subject.run()
    await new Promise<void>((resolve) => setImmediate(resolve))
    subject.ref('draftActionsEnabledRef').current = false
    response.resolve(subject.restored); await work
    expect(subject.environment.openStoredProject).not.toHaveBeenCalled()
    expect(subject.ref('projectTransitionRef').current).toBe(false)
  })
  it('keeps the editor unchanged when the restored project has already changed again', async () => {
    const subject = fixture()
    subject.bridge.restoreProjectRevision.mockImplementationOnce(async () => ({ state: 'changed', currentVersion: 10 }))
    await subject.run()
    expect(subject.environment.openStoredProject).not.toHaveBeenCalled()
    expect(subject.environment.setHistoryPendingState).toHaveBeenCalledWith('changed')
    expect(subject.ref('saveConflictRef').current).toBe(true)
  })
  it('restores a pending identity in a fresh view and inspects without any save or restore POST', async () => {
    const original = fixture(); original.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response'))
    await original.run()
    const saved = recovery.readProjectHistoryRecovery(original.localStorage, ownerId, projectId)!
    const fresh = fixture(); recovery.writeProjectHistoryRecovery(fresh.localStorage, saved)
    fresh.ref('historyPendingRef').current = { projectId, epoch: 1, input: saved.input, record: saved }
    fresh.bridge.inspectProjectRestore.mockImplementationOnce(async () => ({ state: 'missing' }))
    await fresh.retry()
    expect(fresh.bridge.inspectProjectRestore).toHaveBeenCalledWith(projectId, saved.input)
    expect(fresh.bridge.restoreProjectRevision).not.toHaveBeenCalled(); expect(fresh.environment.queueProjectSave).not.toHaveBeenCalled()
    expect(recovery.readProjectHistoryRecovery(fresh.localStorage, ownerId, projectId)).toEqual(saved)
  })
  it('blocks a retry without a fresh explicit missing-result permit', async () => {
    const f = fixture(); f.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response')); await f.run()
    await f.repeat()
    expect(f.bridge.inspectProjectRestore).not.toHaveBeenCalled(); expect(f.bridge.restoreProjectRevision).toHaveBeenCalledTimes(1)
    expect(f.environment.setHistoryError).toHaveBeenCalledWith(expect.stringContaining('先核对'))
  })
  it('rechecks a missing permit and recovers a late original receipt without another POST', async () => {
    const f = fixture(); f.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response')); await f.run()
    f.bridge.inspectProjectRestore.mockImplementationOnce(async () => ({ state: 'missing' })); await f.retry()
    await f.repeat()
    expect(f.bridge.inspectProjectRestore).toHaveBeenCalledTimes(2); expect(f.bridge.restoreProjectRevision).toHaveBeenCalledTimes(1)
    expect(f.environment.openStoredProject).toHaveBeenCalledTimes(1)
  })
  it('never overwrites a pending operation established by another page before this submission', async () => {
    const f = fixture(), other = { version: 1 as const, ownerId, projectId, input: { operationId: ownerId, revisionId, expectedVersion: 7 }, createdAt: '2026-10-23T00:00:00Z' }
    recovery.writeProjectHistoryRecovery(f.localStorage, other)
    await f.run()
    expect(f.bridge.restoreProjectRevision).not.toHaveBeenCalled(); expect(f.environment.queueProjectSave).not.toHaveBeenCalled()
    expect(recovery.readProjectHistoryRecovery(f.localStorage, ownerId, projectId)).toEqual(other)
    expect(f.ref('saveConflictRef').current).toBe(true)
  })
  it('retains malformed storage and never saves or submits over it', async () => {
    const f = fixture(), key = recovery.projectHistoryRecoveryKey(ownerId, projectId)
    f.localStorage.setItem(key, '{broken')
    await f.run()
    expect(f.bridge.restoreProjectRevision).not.toHaveBeenCalled(); expect(f.environment.queueProjectSave).not.toHaveBeenCalled()
    expect(f.localStorage.getItem(key)).toBe('{broken')
    expect(f.ref('saveConflictRef').current).toBe(true)
    expect(f.environment.setAutoSaveState).toHaveBeenCalledWith('failed')
  })
  it('keeps autosave paused if a definite rejection cannot clear its original journal', async () => {
    const f = fixture(); f.bridge.restoreProjectRevision.mockRejectedValueOnce(Object.assign(new Error('missing asset'), { status: 422 }))
    vi.spyOn(f.localStorage, 'removeItem').mockImplementationOnce(() => { throw new Error('storage unavailable') })
    await f.run()
    expect(f.ref('historyPendingRef').current).not.toBeNull()
    expect(recovery.readProjectHistoryRecovery(f.localStorage, ownerId, projectId)).not.toBeNull()
    expect(f.ref('saveConflictRef').current).toBe(true)
    expect(f.environment.setAutoSaveState).toHaveBeenCalledWith('failed')
  })
  it('retains the original identity when an inspection is denied instead of treating it as a rejected write', async () => {
    const f = fixture(); f.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response')); await f.run()
    const before = recovery.readProjectHistoryRecovery(f.localStorage, ownerId, projectId)
    f.bridge.inspectProjectRestore.mockRejectedValueOnce(Object.assign(new Error('permission changed'), { status: 403 }))
    await f.retry()
    expect(recovery.readProjectHistoryRecovery(f.localStorage, ownerId, projectId)).toEqual(before)
    expect(f.ref('historyPendingRef').current).not.toBeNull(); expect(f.bridge.restoreProjectRevision).toHaveBeenCalledTimes(1)
  })
  it('does not install an inspected receipt after its public account changes', async () => {
    const f = fixture(); f.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response')); await f.run()
    const value = deferred<typeof f.restored>(); f.bridge.inspectProjectRestore.mockImplementationOnce(() => value.promise)
    const work = f.retry(); await new Promise<void>((resolve) => setImmediate(resolve))
    f.ref('historyRecoveryOwnerRef').current = projectId; value.resolve(f.restored); await work
    expect(f.environment.openStoredProject).not.toHaveBeenCalled(); expect(f.bridge.restoreProjectRevision).toHaveBeenCalledTimes(1)
    expect(recovery.readProjectHistoryRecovery(f.localStorage, ownerId, projectId)).not.toBeNull()
  })
  it('does not retry after the original journal is replaced while its GET is pending', async () => {
    const f = fixture(); f.bridge.restoreProjectRevision.mockRejectedValueOnce(new Error('lost response')); await f.run()
    f.bridge.inspectProjectRestore.mockImplementationOnce(async () => ({ state: 'missing' })); await f.retry()
    const value = deferred<{ state: 'missing' }>(); f.bridge.inspectProjectRestore.mockImplementationOnce(() => value.promise)
    const work = f.repeat(); await new Promise<void>((resolve) => setImmediate(resolve))
    const previous = recovery.readProjectHistoryRecovery(f.localStorage, ownerId, projectId)!
    f.localStorage.setItem(recovery.projectHistoryRecoveryKey(ownerId, projectId), JSON.stringify({ ...previous, input: { ...previous.input, operationId: ownerId } }))
    value.resolve({ state: 'missing' }); await work
    expect(f.bridge.restoreProjectRevision).toHaveBeenCalledTimes(1)
    expect(f.environment.openStoredProject).not.toHaveBeenCalled()
  })
  it('holds a changed original result for explicit cloud reading and keeps the local editor untouched', async () => {
    const f = fixture(); f.bridge.restoreProjectRevision.mockImplementationOnce(async () => ({ state: 'changed', currentVersion: 10 }))
    await f.run()
    expect(recovery.readProjectHistoryRecovery(f.localStorage, ownerId, projectId)?.input).toEqual({ operationId, revisionId, expectedVersion: 8 })
    expect(f.environment.openStoredProject).not.toHaveBeenCalled(); expect(f.environment.setHistoryPendingState).toHaveBeenCalledWith('changed')
  })

})
