import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { hasProjectCollaborationJournal } from '../persistence/project-collaboration-journal'

function effect(environment: Record<string, unknown>): () => void | (() => void) {
  const source = ts.createSourceFile('use-project-collaboration.ts', readFileSync(new URL('./use-project-collaboration.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let code = ''
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') code = node.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!code) throw new Error('Missing actual collaboration effect')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${code})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}
function fixture(shared = true) {
  const storage = { length: 0, key: () => null, getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }
  const target = { state: () => ({ phase: 'loading' }), initialize: vi.fn(async () => {}), tick: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}), dispose: vi.fn() }
  const createCanvasProjectCollaboration = vi.fn((_dependencies: { onSnapshot(...args: unknown[]): void; changed(...args: unknown[]): void }) => target)
  const options = { ownerId: 'owner', projectId: 'project', scopeKey: 'original-scope', shared, enabled: true, client: {}, controllerRef: { current: null as typeof target | null }, active: () => true, getContent: () => 'content', selectedNodeIds: () => [], onSnapshot: vi.fn(), onState: vi.fn() }
  const latest = { current: options }, callbacks: (() => void)[] = [], clearInterval = vi.fn(), setValue = vi.fn()
  const run = effect({ options, latest, setValue, hasProjectCollaborationJournal, createCanvasProjectCollaboration, crypto: { randomUUID: () => 'client-id' },
    window: { localStorage: storage, setInterval: (callback: () => void) => { callbacks.push(callback); return callbacks.length }, clearInterval } })
  return { options, latest, target, createCanvasProjectCollaboration, callbacks, clearInterval, setValue, run }
}
describe('actual collaboration workspace lifecycle', () => {
  it('does not create a controller, timer or loading state for an ordinary personal project', () => {
    const f = fixture(false)
    expect(f.run()).toBeUndefined()
    expect(f.createCanvasProjectCollaboration).not.toHaveBeenCalled()
    expect(f.callbacks).toEqual([])
    expect(f.setValue).not.toHaveBeenCalled()
    expect(f.options.onState).not.toHaveBeenCalled()
  })
  it('stops timers and discards late callbacks when the project scope changes or the workspace closes', async () => {
    const f = fixture(), cleanup = f.run()
    expect(f.target.initialize).toHaveBeenCalledOnce()
    f.callbacks[0](); await Promise.resolve()
    expect(f.target.tick).toHaveBeenCalledOnce(); expect(f.target.heartbeat).toHaveBeenCalledOnce()
    f.latest.current = { ...f.options, scopeKey: 'new-project-scope' }
    f.callbacks[0](); await Promise.resolve()
    expect(f.target.tick).toHaveBeenCalledOnce()
    const arguments_ = f.createCanvasProjectCollaboration.mock.calls[0][0]
    f.options.onSnapshot.mockClear(); f.setValue.mockClear()
    arguments_.onSnapshot({}, 'obsolete content', true); arguments_.changed({ phase: 'live' })
    expect(f.options.onSnapshot).not.toHaveBeenCalled(); expect(f.setValue).not.toHaveBeenCalled()
    cleanup?.()
    expect(f.target.dispose).toHaveBeenCalledOnce()
    expect(f.clearInterval).toHaveBeenCalledOnce()
    expect(f.options.controllerRef.current).toBeNull()
  })
})
