import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { Viewport } from '@xyflow/react'
import { createViewportRestoration } from './viewport-restoration'
import { fitCanvasViewport } from './canvas-viewport'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source))
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('reactFlow.viewportInitialized')) callbacks.set('liveReadyEffect', node.arguments[0].getText(source))
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'ReactFlow') {
    for (const attr of node.attributes.properties) if (ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) callbacks.set(`ReactFlow.${attr.name.getText(source)}`, attr.initializer.expression.getText(source))
  }
  ts.forEachChild(node, visit)
}
visit(source)
function actual(name: string, environment: Record<string, unknown>): (...args: unknown[]) => unknown {
  const expression = callbacks.get(name)
  if (!expression) throw new Error(`Missing production callback ${name}`)
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as (...args: unknown[]) => unknown
}

describe('actual App viewport restore hooks', () => {
  it.each(['fitCanvas', 'toggleCanvasOverview', 'fitSelection'])('keeps fitted node actions clear of fixed overlays through %s', (name) => {
    const setViewport = vi.fn(), cancel = vi.fn(), frames: Array<() => void> = []
    const bounds = { x: 80, y: 100, width: 900, height: 1200 }, width = 1000, height = 672
    const targets = [{ id: 'tile', selected: true }]
    const flow = { setViewport, getNodes: () => targets, getNodesBounds: () => bounds, getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }
    const environment: Record<string, unknown> = { cancelInsertionViewportNavigation: vi.fn(), createdNodeFocusRef: { current: { cancel } }, viewportRestorationRef: { current: { cancel } }, projectEpochRef: { current: 1 }, activeProjectIdRef: { current: 'a' }, projectTransitionRef: { current: false }, currentReactFlowRef: { current: flow }, fitCanvasViewport, measureCanvasSafeViewport: () => ({ x: 0, y: 64, width, height: height - 128 }), document: { querySelector: () => ({}) }, nodes: targets, overviewViewportRef: { current: null }, reactFlow: flow, window: { requestAnimationFrame: (frame: () => void) => frames.push(frame) } }
    environment.fitCanvasNodes = actual('fitCanvasNodes', environment)
    actual(name, environment)(); frames.forEach((frame) => frame())
    expect(setViewport).toHaveBeenCalledOnce()
    // The desktop pane excludes the normal-flow header. Numeric 0.14 only
    // leaves 41px at this height, below the navigation's 46px footprint.
    const fitted = setViewport.mock.calls[0][0] as Viewport
    expect(bounds.y * fitted.zoom + fitted.y).toBeGreaterThanOrEqual(64)
    expect((bounds.y + bounds.height) * fitted.zoom + fitted.y).toBeLessThanOrEqual(height - 64)
    expect(fitted.zoom).toBeGreaterThan(0)
  })

  it('initializes React Flow with the saved document viewport rather than an identity transform', () => {
    expect(callbacks.get('ReactFlow.defaultViewport')).toBe('viewport')
    expect(callbacks.get('ReactFlow.onInit')).toBe('onCanvasViewportInit')
  })

  it('queues document restoration without assuming an animation frame means pane readiness', () => {
    const request = vi.fn(), cancel = vi.fn()
    const overviewViewportRef = { current: { x: 0, y: 0, zoom: 1 } as unknown }
    const restore = actual('restoreCanvasViewport', { cancelInsertionViewportFocus: vi.fn(), createdNodeFocusRef: { current: { cancel } }, overviewViewportRef, viewportRestorationRef: { current: { request } } })
    const viewport = { x: 361.9, y: -329.2, zoom: 0.2 }
    restore(viewport)
    expect(request).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(overviewViewportRef.current).toBeNull()
  })

  it('recovers from the one-shot init callback becoming stale during a project reload', async () => {
    const frames: (() => void)[] = [], applied = vi.fn()
    const scope = { projectId: 'a', projectEpoch: 1 }
    const restore = createViewportRestoration({ schedule: (run) => frames.push(run), cancelFrame: () => undefined, scope: () => scope, active: () => true, apply: async (viewport) => viewport, applied })
    const environment = { projectEpochRef: { current: 1 }, viewportInitProjectEpoch: 1, activeProjectIdRef: { current: 'a' }, activeProject: { id: 'a' }, draftActionsEnabledRef: { current: true }, draftActionsEnabled: true, window: { xingmangCanvasHost: {} }, viewportRestorationRef: { current: restore }, reactFlow: { viewportInitialized: true } }
    const oldInit = actual('onCanvasViewportInit', environment)
    scope.projectEpoch = 2; environment.projectEpochRef.current = 2
    restore.request({ x: 10, y: 20, zoom: 0.3 })
    oldInit()
    expect(frames).toHaveLength(0)
    actual('liveReadyEffect', environment)()
    expect(frames).toHaveLength(1)
    frames.shift()!(); await Promise.resolve()
    expect(applied).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20, zoom: 0.3 })
  })

  it('cancels pending restore for user pan and zoom but not its own programmatic move', () => {
    const cancel = vi.fn(), focusCancel = vi.fn()
    const moveStart = actual('ReactFlow.onMoveStart', { cancelInsertionViewportNavigation: vi.fn(), viewportRestorationRef: { current: { cancel } }, createdNodeFocusRef: { current: { cancel: focusCancel } } })
    moveStart(null)
    expect(cancel).not.toHaveBeenCalled()
    moveStart({ type: 'wheel' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(focusCancel).toHaveBeenCalledTimes(1)
  })
})
