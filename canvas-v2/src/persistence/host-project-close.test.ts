import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { closeProjectForHost } from './host-project-close'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

// The real returnToProjectCenter callback out of App.tsx, run against stand-ins for the component state it closes over.
function actualReturnToProjectCenter(environment: Record<string, unknown>): () => Promise<void> {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'returnToProjectCenter' && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0]?.getText(source) ?? ''
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Missing returnToProjectCenter in App.tsx')
  const body = ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), body)(...Object.values(environment)) as () => Promise<void>
}

function fixture(options: { save?: () => Promise<void>; closeProject?: (projectId: string) => Promise<boolean> } = {}) {
  const calls: string[] = []
  const closeProject = vi.fn(options.closeProject ?? (async (projectId: string) => { calls.push(`close:${projectId}`); return true }))
  const host: { closeProject?: typeof closeProject } = { closeProject }
  const e = {
    activeProject: { id: 'project-a', name: '旧项目' },
    projectTransitionRef: { current: false }, projectCanEditRef: { current: true },
    pendingRunProjectionIdsRef: { current: new Set<string>() }, running: false, startingRunsRef: { current: 0 }, resumingTaskIds: new Set<string>(),
    autoSaveRevisionRef: { current: 0 }, autosaveTimerRef: { current: null },
    setBanner: vi.fn(), setProjectTransition: vi.fn(), setAutoSaveState: vi.fn(),
    queueProjectSave: vi.fn(async () => { calls.push('save'); await options.save?.() }),
    serializeWorkflow: () => '{}', workflowSnapshot: () => ({}),
    closeProjectForHost, hostBridge: () => host,
    runsRequestRevisionRef: { current: 0 }, runInputGraphsRef: { current: new Map() }, activeRunsRef: { current: new Map() },
    runPreparationsRef: { current: { stopAll: vi.fn() } }, runWaitingBannerRef: { current: null }, setRunning: vi.fn(),
    projectEpochRef: { current: 1 }, activeProjectIdRef: { current: 'project-a' as string | null },
    setActiveProject: vi.fn((project: unknown) => { calls.push(`active:${project === null ? 'none' : 'project'}`) }),
    projectPaginationEnabled: false, refreshProjects: vi.fn(), browserUnsavedRef: { current: false }, setDirtyNodeIds: vi.fn(),
    projectHydrationRef: { current: true }, applyProjectUiPreferences: vi.fn(), defaultCanvasUiPreferences: {},
    canvasAutosaveErrorMessage: (error: unknown) => error instanceof Error ? error.message : '保存失败',
    window: { clearTimeout, dispatchEvent: vi.fn() }, CustomEvent: class { constructor(public type: string) {} },
  }
  return { e, calls, host, closeProject, run: () => actualReturnToProjectCenter(e)() }
}

describe('closeProjectForHost', () => {
  it('tells the host which project the page left', async () => {
    const closeProject = vi.fn(async () => true)
    await closeProjectForHost({ closeProject }, 'project-a')
    expect(closeProject).toHaveBeenCalledWith('project-a')
  })

  it('does nothing for a host without the method', async () => {
    await expect(closeProjectForHost({}, 'project-a')).resolves.toBeUndefined()
  })

  it('swallows a host refusal so going back to the project center still finishes', async () => {
    await expect(closeProjectForHost({ closeProject: vi.fn(async () => { throw new Error('请先登录星芒账号') }) }, 'project-a')).resolves.toBeUndefined()
  })
})

describe('actual App return to the project center', () => {
  it('tells the host after the last save and before the project center shows', async () => {
    const f = fixture()
    await f.run()
    expect(f.calls).toEqual(['save', 'close:project-a', 'active:none'])
    expect(f.e.activeProjectIdRef.current).toBeNull()
  })

  it('keeps the project open and the host untouched when the last save fails', async () => {
    const f = fixture({ save: async () => { throw new Error('磁盘已满') } })
    await f.run()
    expect(f.closeProject).not.toHaveBeenCalled()
    expect(f.e.setActiveProject).not.toHaveBeenCalled()
    expect(f.e.activeProjectIdRef.current).toBe('project-a')
    expect(f.e.setBanner).toHaveBeenCalledWith('磁盘已满')
  })

  it('still reaches the project center when the host refuses to forget the project', async () => {
    const f = fixture({ closeProject: async () => { throw new Error('请先登录星芒账号') } })
    await f.run()
    expect(f.e.setActiveProject).toHaveBeenCalledWith(null)
    expect(f.e.activeProjectIdRef.current).toBeNull()
    expect(f.e.setBanner).not.toHaveBeenCalled()
  })

  it('goes back as before on a host without the method', async () => {
    const f = fixture()
    delete f.host.closeProject
    await f.run()
    expect(f.calls).toEqual(['save', 'active:none'])
  })
})
