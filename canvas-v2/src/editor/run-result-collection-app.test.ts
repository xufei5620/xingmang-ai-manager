import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source)
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') expression = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

interface Session { scope: { accountId: string; projectId: string }; runtimeScope: string; initialRunId?: string }
function fixture() {
  const bridge = { listRunHistory: vi.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false }), readRunHistory: vi.fn().mockResolvedValue({ runId: 'run-a', projectId: 'project-a', nodes: [] }), getAssetDetail: vi.fn() }
  const owner = { current: { ownerId: 1, accountId: 'canvas-account-a' as string | null } }
  const project = { current: 'project-a' }, epoch = { current: 1 }, enabled = { current: true }, permission = { current: true }, transition = { current: false }
  const current = { current: null as Session | null }, mounted = { current: true }
  const environment = { hostBridge: () => bridge, creationOwnerId: 'canvas-account-a', activeProjectIdRef: project, projectEpochRef: epoch, draftActionsEnabledRef: enabled, projectCanRunRef: permission, projectTransitionRef: transition, layerEditorOwnerRef: owner, layerEditorScopeToken, runResultCollectionSessionRef: current, agentMountedRef: mounted, selectedRunId: 'run-a', setBanner: vi.fn(), setRunResultCollectionSession: vi.fn(), readCanvasAssetDetail: vi.fn().mockResolvedValue({ assetId: 'a'.repeat(43) }), addAssetNodes: vi.fn().mockResolvedValue(undefined), downloadAssetNodes: vi.fn().mockResolvedValue(undefined) }
  const assertCurrent = actual<(session: Session) => void>('assertRunResultCollectionCurrent', environment)
  const wired = { ...environment, assertRunResultCollectionCurrent: assertCurrent }
  const open = actual<() => void>('openRunResultCollection', wired)
  open()
  const session = current.current!
  return { bridge, environment, owner, project, epoch, enabled, permission, transition, current, mounted, session, open, assertCurrent,
    list: actual<(session: Session, query: object, signal: AbortSignal) => Promise<unknown>>('listRunResultCollectionHistory', wired),
    read: actual<(session: Session, runId: string, signal: AbortSignal) => Promise<unknown>>('readRunResultCollectionHistory', wired),
    asset: actual<(session: Session, assetId: string, signal: AbortSignal) => Promise<unknown>>('readRunResultCollectionAsset', wired),
    apply: actual<(session: Session, kind: 'add' | 'download', ids: readonly string[]) => Promise<void>>('applyRunResultCollection', wired),
    close: actual<(session: Session) => void>('closeRunResultCollection', wired),
  }
}

describe('actual App run result collection boundary', () => {
  it('opens a stable account-project collection with an independent current epoch', () => {
    const f = fixture()
    expect(f.session).toEqual({ scope: { accountId: 'canvas-account-a', projectId: 'project-a' }, runtimeScope: layerEditorScopeToken({ ownerId: 1, accountId: 'canvas-account-a', projectId: 'project-a', projectEpoch: 1, enabled: true }), initialRunId: 'run-a' })
    expect(f.bridge.listRunHistory).not.toHaveBeenCalled()
    expect(f.bridge.readRunHistory).not.toHaveBeenCalled()
    expect(f.environment.addAssetNodes).not.toHaveBeenCalled()
  })

  it('browses paged history without refreshing, projecting or executing ordinary runs', async () => {
    const f = fixture(), signal = new AbortController().signal
    await f.list(f.session, { cursor: 'older', limit: 12 }, signal)
    await f.read(f.session, 'run-old-31', signal)
    await f.asset(f.session, 'a'.repeat(43), signal)
    expect(f.bridge.listRunHistory).toHaveBeenCalledExactlyOnceWith({ cursor: 'older', limit: 12 }, signal)
    expect(f.bridge.readRunHistory).toHaveBeenCalledExactlyOnceWith('run-old-31', signal)
    expect(f.environment.readCanvasAssetDetail).toHaveBeenCalledExactlyOnceWith('a'.repeat(43), signal)
    expect(f.environment.addAssetNodes).not.toHaveBeenCalled()
    expect(f.environment.downloadAssetNodes).not.toHaveBeenCalled()
  })

  it.each(['project', 'account', 'epoch', 'permission', 'disabled', 'transition', 'closed', 'reopened', 'unmounted'] as const)('rejects delayed reads after %s changes', async (change) => {
    const f = fixture()
    let finish: (value: unknown) => void = () => undefined
    f.bridge.readRunHistory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.read(f.session, 'run-a', new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('已变化')
    if (change === 'project') f.project.current = 'project-b'
    if (change === 'account') f.owner.current.accountId = 'canvas-account-b'
    if (change === 'epoch') f.epoch.current += 2
    if (change === 'permission') f.permission.current = false
    if (change === 'disabled') f.enabled.current = false
    if (change === 'transition') f.transition.current = true
    if (change === 'closed') f.current.current = null
    if (change === 'reopened') f.current.current = { ...f.session }
    if (change === 'unmounted') f.mounted.current = false
    finish({ runId: 'run-a', projectId: 'project-a', nodes: [] })
    await rejected
    await expect(f.apply(f.session, 'add', ['a'.repeat(43)])).rejects.toThrow('已变化')
    expect(f.environment.addAssetNodes).not.toHaveBeenCalled()
  })

  it('preserves explicit order and freezes ids while handing off one existing batch transaction', async () => {
    const f = fixture(), ids = ['b'.repeat(43), 'a'.repeat(43)]
    let finish: () => void = () => undefined
    f.environment.addAssetNodes.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const pending = f.apply(f.session, 'add', ids)
    ids.reverse()
    expect(f.environment.addAssetNodes).toHaveBeenCalledExactlyOnceWith(['b'.repeat(43), 'a'.repeat(43)])
    finish(); await pending
    await f.apply(f.session, 'download', ids)
    expect(f.environment.downloadAssetNodes).toHaveBeenCalledExactlyOnceWith(['a'.repeat(43), 'b'.repeat(43)])
  })

  it('does not close a newer session from an old dialog callback', () => {
    const f = fixture(), replacement = { ...f.session }
    f.current.current = replacement
    f.environment.setRunResultCollectionSession.mockClear()
    f.close(f.session)
    expect(f.current.current).toBe(replacement)
    expect(f.environment.setRunResultCollectionSession).not.toHaveBeenCalled()
    f.close(replacement)
    expect(f.current.current).toBeNull()
    expect(f.environment.setRunResultCollectionSession).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('explains unsupported hosts and refuses opening after account or permission changes', () => {
    const f = fixture()
    f.bridge.readRunHistory = undefined as unknown as typeof f.bridge.readRunHistory
    f.environment.setRunResultCollectionSession.mockClear()
    f.open()
    expect(f.environment.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('暂不支持'))
    f.owner.current.accountId = 'canvas-account-b'
    f.open()
    expect(f.environment.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('本人'))
    expect(f.environment.setRunResultCollectionSession).not.toHaveBeenCalled()
  })
})
