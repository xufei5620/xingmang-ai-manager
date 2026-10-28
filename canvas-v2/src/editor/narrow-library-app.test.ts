import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { canvasNarrowLayoutQuery, readCanvasNarrowLayout, subscribeCanvasNarrowLayout } from './narrow-canvas-layout'

const appText = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function actualInitializer(name: string): string {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) expression = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App value: ${name}`)
  return expression
}

function evaluate<T>(expression: string, environment: Record<string, unknown>): T {
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

function actualCallback<T>(name: string, environment: Record<string, unknown>): T {
  const call = actualInitializer(name)
  const node = ts.createSourceFile('callback.ts', call, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).statements[0]
  if (!node || !ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) throw new Error(`App value is not a hook call: ${name}`)
  return evaluate<T>(node.expression.arguments[0].getText(), environment)
}

function layout(state: { narrow: boolean, agentOpen?: boolean, focusMode?: boolean, inspectorTab?: 'node' | 'assets' | 'runs', nodeInspectorOpen?: boolean, selected?: number, assetTrayOpen?: boolean, runInspectorOpen?: boolean }) {
  const environment = {
    focusMode: state.focusMode ?? false,
    agentOpen: state.agentOpen ?? false,
    inspectorTab: state.inspectorTab ?? 'node',
    nodeInspectorOpen: state.nodeInspectorOpen ?? false,
    selectedInspectorNodes: Array.from({ length: state.selected ?? 0 }, (_, index) => ({ id: `node-${index}` })),
    assetTrayOpen: state.assetTrayOpen ?? false,
    runInspectorOpen: state.runInspectorOpen ?? false,
  }
  const inspectorShown = evaluate<boolean>(actualInitializer('inspectorShown'), environment)
  const libraryRailForced = evaluate<boolean>(actualInitializer('libraryRailForced'), { ...environment, inspectorShown, narrowCanvas: state.narrow })
  return { inspectorShown, libraryRailForced }
}

function libraryFixture(libraryRailForced: boolean, libraryCollapsed = false) {
  let preferences = { libraryCollapsed, composerCollapsed: false }
  const setAgentOpen = vi.fn(), closeInspector = vi.fn()
  const setUiPreferences = vi.fn((update: (current: typeof preferences) => typeof preferences) => { preferences = update(preferences) })
  const change = actualCallback<(collapsed: boolean) => void>('changeLibraryCollapsed', { libraryRailForced, setAgentOpen, closeInspector, setUiPreferences })
  return { change, setAgentOpen, closeInspector, preferences: () => preferences }
}

describe('narrow canvas layout query', () => {
  it('reads and follows the same breakpoint the stylesheet uses', () => {
    const listeners = new Set<() => void>()
    const query = { matches: true, addEventListener: vi.fn((_: string, listener: () => void) => listeners.add(listener)), removeEventListener: vi.fn((_: string, listener: () => void) => listeners.delete(listener)) }
    const matchMedia = vi.fn(() => query)
    expect(readCanvasNarrowLayout(matchMedia)).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith(canvasNarrowLayoutQuery)
    const onChange = vi.fn()
    const unsubscribe = subscribeCanvasNarrowLayout(onChange, matchMedia)
    for (const listener of listeners) listener()
    expect(onChange).toHaveBeenCalledOnce()
    unsubscribe()
    expect(listeners.size).toBe(0)
    const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(styles).toContain(`@media ${canvasNarrowLayoutQuery}`)
  })

  it('reports the wide layout where there is no browser to ask', () => {
    expect(readCanvasNarrowLayout(null)).toBe(false)
    expect(subscribeCanvasNarrowLayout(vi.fn(), null)).toBeTypeOf('function')
  })
})

describe('actual App library rail in the narrow layout', () => {
  it('treats the library as collapsed only while a side panel squeezes it in the narrow layout', () => {
    expect(layout({ narrow: true, nodeInspectorOpen: true, selected: 1 })).toEqual({ inspectorShown: true, libraryRailForced: true })
    expect(layout({ narrow: true, inspectorTab: 'assets', assetTrayOpen: true })).toEqual({ inspectorShown: true, libraryRailForced: true })
    expect(layout({ narrow: true, agentOpen: true, nodeInspectorOpen: true, selected: 1 })).toEqual({ inspectorShown: false, libraryRailForced: true })
    expect(layout({ narrow: false, nodeInspectorOpen: true, selected: 1 }).libraryRailForced).toBe(false)
    // A node inspector with nothing selected is not on screen, so it squeezes nothing.
    expect(layout({ narrow: true, nodeInspectorOpen: true, selected: 0 })).toEqual({ inspectorShown: false, libraryRailForced: false })
    expect(layout({ narrow: true, focusMode: true, inspectorTab: 'runs', runInspectorOpen: true }).libraryRailForced).toBe(false)
    expect(appText).toContain('collapsed={uiPreferences.libraryCollapsed || libraryRailForced}')
    expect(appText).toContain('onCollapsedChange={changeLibraryCollapsed}')
    expect(appText).toContain('{inspectorShown && (\n        <CanvasInspector')
  })

  it('closes the squeezing panel when a rail tab opens the library', () => {
    const f = libraryFixture(true)
    f.change(false)
    expect(f.setAgentOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.closeInspector).toHaveBeenCalledOnce()
    expect(f.preferences().libraryCollapsed).toBe(false)
  })

  it('leaves the panels alone when the library collapses or has room beside them', () => {
    const forced = libraryFixture(true)
    forced.change(true)
    expect(forced.closeInspector).not.toHaveBeenCalled()
    expect(forced.setAgentOpen).not.toHaveBeenCalled()
    expect(forced.preferences().libraryCollapsed).toBe(true)
    const wide = libraryFixture(false, true)
    wide.change(false)
    expect(wide.closeInspector).not.toHaveBeenCalled()
    expect(wide.setAgentOpen).not.toHaveBeenCalled()
    expect(wide.preferences().libraryCollapsed).toBe(false)
  })
})
