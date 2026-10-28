import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'
import { canvasWorkflowSnapshotNeedsSave } from '../persistence/workflow-snapshot'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual(name: string, environment: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  let callback = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') callback = node.initializer.arguments[0].getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) callback = node.getText(source)
    if (name === 'collaboration.onState' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'onState') callback = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error('Missing actual App handler')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}
function actualExpression(name: string, environment: Record<string, unknown>): unknown {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) expression = node.initializer.getText(source)
    if (name === 'collaboration.enabled' && ts.isCallExpression(node) && node.expression.getText(source) === 'useProjectCollaboration' && ts.isObjectLiteralExpression(node.arguments[0])) {
      const enabled = node.arguments[0].properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'enabled')
      if (enabled && ts.isPropertyAssignment(enabled)) expression = enabled.initializer.getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Missing actual App expression')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}
function fixture(live = true) {
  const workflow = createEmptyWorkflow('Shared')
  workflow.nodes = [{ id: 'a', kind: 'prompt', position: { x: 0, y: 0 }, data: { prompt: 'Original', model: '', status: 'idle' } }]
  const submitted = serializeWorkflow(workflow)
  const remote = structuredClone(workflow); remote.nodes[0].data.prompt = 'Teammate acknowledged prompt'
  const acknowledged = serializeWorkflow(remote)
  const project = { id: 'project-a', name: 'Shared', version: 3 }, saved = { ...project, version: 5 }
  const saveProject = vi.fn(async () => saved), setActiveProject = vi.fn()
  const flush = vi.fn(async () => ({ project: saved, content: acknowledged }))
  const collaborationRef = { current: live ? { needsOperationSave: () => true, flush } : null }
  const lastConfirmedContentRef = { current: submitted }
  const env = {
    projectEpochRef: { current: 2 }, collaborationRef, collaborationRequired: live,
    browserDraftRef: { current: null }, restoredDraftRef: { current: null }, projectSaveChainRef: { current: Promise.resolve() },
    projectCanEditRef: { current: true }, saveConflictRef: { current: false }, draftRecoveryPendingRef: { current: false }, draftActionsEnabledRef: { current: true },
    activeProjectIdRef: { current: project.id }, latestBrowserSnapshotRef: { current: { project: saved, content: acknowledged, errorMessage: null } },
    lastConfirmedContentRef, draftBaseVersionRef: { current: 3 }, browserUnsavedRef: { current: false }, autoSaveRevisionRef: { current: 1 },
    currentReactFlowRef: { current: { getViewport: () => ({ x: 50, y: 70, zoom: .6 }) } },
    hostBridge: () => ({ saveProject }), setActiveProject, setProjects: vi.fn(), setAutoSaveState: vi.fn(), setSaveConflict: vi.fn(), setDraftStorageError: vi.fn(),
    persistBrowserDraft: vi.fn(), parseWorkflowFile, serializeWorkflow, canvasWorkflowSnapshotNeedsSave,
    projectTransitionRef: { current: true },
  }
  return { env, project, submitted, acknowledged, saved, flush, saveProject, setActiveProject, lastConfirmedContentRef }
}

describe('actual App collaboration durability boundary', () => {
  it('invalidates stale collaboration display and disables its hook immediately when current access is denied', () => {
    const env = { creationOwnerId: 'owner', activeProject: { id: 'project' }, projectEpochRef: { current: 4 }, projectAccessState: { denied: false, access: { accessVersion: 1 } }, draftActionsEnabled: true, storageMode: 'cloud' }
    const before = actualExpression('collaborationScopeKey', env)
    expect(actualExpression('collaboration.enabled', env)).toBe(true)
    env.projectAccessState.denied = true
    const after = actualExpression('collaborationScopeKey', env)
    expect(after).not.toBe(before)
    expect(actualExpression('collaboration.enabled', env)).toBe(false)
    expect(actualExpression('collaborationState', { collaborationUi: { key: before, state: { phase: 'live', joined: true } }, collaborationScopeKey: after })).toBeNull()
  })
  it.each(['canUndo', 'canRedo'])('keeps %s disabled after revocation even when live and personal history both have tips', name => {
    const env = { projectCanEdit: false, collaborationRef: { current: { needsOperationSave: () => true } }, collaborationState: { phase: 'live', snapshot: { history: { undo: {}, redo: {} } } }, documentCanUndo: true, documentCanRedo: true }
    expect(actualExpression(name, env)).toBe(false)
    env.collaborationRef.current.needsOperationSave = () => false
    expect(actualExpression(name, env)).toBe(false)
  })
  it.each(['undo', 'redo'])('blocks the actual %s callback after revocation before actor history or local navigation', async action => {
    const history = vi.fn(async () => {}), ordinary = vi.fn(), cancelInsertionViewportFocus = vi.fn()
    await actual(action, { projectCanEditRef: { current: false }, collaborationRef: { current: { needsOperationSave: () => true, history } }, cancelInsertionViewportFocus, undoDocument: ordinary, redoDocument: ordinary, setBanner: vi.fn() })()
    expect(history).not.toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled(); expect(cancelInsertionViewportFocus).not.toHaveBeenCalled()
  })
  it('flushes during an authorized project transition and keeps the actual acknowledged teammate graph', async () => {
    const f = fixture(), queue = actual('queueProjectSave', f.env)
    expect(await queue(f.project, f.submitted, 1)).toEqual(f.saved)
    expect(f.flush).toHaveBeenCalledWith(f.submitted)
    expect(f.saveProject).not.toHaveBeenCalled()
    expect(parseWorkflowFile(f.lastConfirmedContentRef.current)?.nodes[0].data.prompt).toBe('Teammate acknowledged prompt')
    expect(parseWorkflowFile(f.lastConfirmedContentRef.current)?.viewport).toEqual({ x: 50, y: 70, zoom: .6 })
    expect(f.setActiveProject).toHaveBeenCalledWith(f.saved)
  })

  it('never falls back to whole save when the live flush is unknown or unsupported', async () => {
    const f = fixture(); f.flush.mockRejectedValueOnce(new Error('Unknown original reply'))
    await expect(actual('queueProjectSave', f.env)(f.project, f.submitted, 1)).rejects.toThrow('Unknown original reply')
    expect(f.saveProject).not.toHaveBeenCalled()
    const missing = fixture(); missing.env.collaborationRef.current = null
    await expect(actual('queueProjectSave', missing.env)(missing.project, missing.submitted, 1)).rejects.toThrow('不会改用普通整图保存')
    expect(missing.saveProject).not.toHaveBeenCalled()
  })

  it('drops a late confirmed reply after the owning collaboration scope is replaced', async () => {
    const f = fixture()
    f.flush.mockImplementationOnce(async () => { f.env.collaborationRef.current = null; return { project: f.saved, content: f.acknowledged } })
    await expect(actual('queueProjectSave', f.env)(f.project, f.submitted, 1)).rejects.toThrow('当前账号或工程已切换')
    expect(f.setActiveProject).not.toHaveBeenCalled()
    expect(f.saveProject).not.toHaveBeenCalled()
  })

  it('retains the existing whole-save path for ordinary personal projects', async () => {
    const f = fixture(false)
    await actual('queueProjectSave', f.env)(f.project, f.submitted, 1)
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.saveProject).toHaveBeenCalledWith(f.project.id, f.submitted, undefined)
  })

  it.each(['undo', 'redo'])('routes %s to actor operations instead of whole-snapshot history', async (action) => {
    const history = vi.fn(async () => {}), ordinary = vi.fn(), cancelInsertionViewportFocus = vi.fn()
    await actual(action, { projectCanEditRef: { current: true }, collaborationRef: { current: { needsOperationSave: () => true, history } }, cancelInsertionViewportFocus, undoDocument: ordinary, redoDocument: ordinary, setBanner: vi.fn() })()
    expect(history).toHaveBeenCalledWith(action)
    expect(ordinary).not.toHaveBeenCalled()
  })

  it('refuses historical whole-document restoration while a live epoch is active', async () => {
    const setHistoryError = vi.fn()
    await actual('restoreProjectHistory', { collaborationRef: { current: { needsOperationSave: () => true } }, setHistoryError })()
    expect(setHistoryError).toHaveBeenCalledWith(expect.stringContaining('不能整图恢复历史'))
  })

  it('permits local edit buffering without granting runtime permission during the same busy phase', async () => {
    const projectCanEditRef = { current: false }, projectCanRunRef = { current: true }
    const access = { denied: false, access: { canEdit: true, canRun: true } }
    const callback = actual('collaboration.onState', { setCollaborationUi: vi.fn(), collaborationScopeKey: 'owner-project-epoch', hostBridge: () => ({ getProjectAccess: () => access }),
      draftActionsEnabledRef: { current: true }, collaborationRef: { current: { canEdit: () => true } }, projectCanEditRef, projectCanRunRef })
    await callback({ phase: 'busy', buffering: true })
    expect(projectCanEditRef.current).toBe(true)
    expect(projectCanRunRef.current).toBe(false)
    await callback({ phase: 'live' })
    expect(projectCanRunRef.current).toBe(true)
    access.access.canRun = false
    await callback({ phase: 'live' })
    expect(projectCanRunRef.current).toBe(false)
    access.denied = true
    await callback({ phase: 'busy', buffering: true })
    expect(projectCanEditRef.current).toBe(false)
  })

  it('keeps all ordinary whole-save calls behind the single protocol-switching queue', () => {
    const calls: ts.CallExpression[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'saveProject') calls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(calls).toHaveLength(1)
    let parent: ts.Node | undefined = calls[0]
    while (parent && !(ts.isVariableDeclaration(parent) && parent.name.getText(source) === 'queueProjectSave')) parent = parent.parent
    expect(parent).toBeDefined()
  })
})
