import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import type { Viewport } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'
import { parseWorkflowFile, serializeWorkflow } from '../model'
import { fitCanvasViewport, measureCanvasSafeViewport } from './canvas-viewport'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual(name: string, environment: Record<string, unknown>): () => void {
  let expression = ''
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') expression = node.initializer.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!expression) throw new Error(`Missing actual ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => void
}
describe('whole graph navigation across legal large ranges', () => {
  it.each(['fitCanvas', 'toggleCanvasOverview', 'fitSelection'])('contains all 124 large-graph bounds through the actual %s handler', (name) => {
    const bounds = { x: -1000, y: -600, width: 11680, height: 1680 }, width = 850, height = 672
    let fitted: Viewport | undefined
    const targets = [{ id: 'tile', selected: true }]
    const flow = { getNodes: () => targets, getNodesBounds: () => bounds, setViewport: vi.fn((viewport: Viewport) => { fitted = viewport }), getViewport: () => ({ x: 10, y: 20, zoom: .8 }) }
    const overlay = (left: number, top: number, w: number, h: number) => ({ closest: () => null, getClientRects: () => [{}], getBoundingClientRect: () => ({ left, top, width: w, height: h }) })
    const pane = { getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }), querySelectorAll: () => [overlay(0, 0, width, 56), overlay(0, height - 56, width, 56)], parentElement: null }
    const cancelInsertionViewportNavigation = vi.fn()
    const environment: Record<string, unknown> = { cancelInsertionViewportNavigation, createdNodeFocusRef: { current: { cancel: vi.fn() } }, viewportRestorationRef: { current: { cancel: vi.fn() } }, projectEpochRef: { current: 1 }, activeProjectIdRef: { current: 'a' }, projectTransitionRef: { current: false }, currentReactFlowRef: { current: flow }, fitCanvasViewport, measureCanvasSafeViewport, document: { querySelector: () => pane }, nodes: targets, overviewViewportRef: { current: null }, reactFlow: flow, window: { requestAnimationFrame: (run: () => void) => run() } }
    environment.fitCanvasNodes = actual('fitCanvasNodes', environment)
    actual(name, environment)()
    expect(cancelInsertionViewportNavigation).toHaveBeenCalled()
    expect(fitted).toBeDefined()
    expect(bounds.x * fitted!.zoom + fitted!.x).toBeGreaterThanOrEqual(0)
    expect((bounds.x + bounds.width) * fitted!.zoom + fitted!.x).toBeLessThanOrEqual(width)
    expect(bounds.y * fitted!.zoom + fitted!.y).toBeGreaterThanOrEqual(64)
    expect((bounds.y + bounds.height) * fitted!.zoom + fitted!.y).toBeLessThanOrEqual(height - 64)
  })
  it('preserves a valid fitted overview below one percent through saved document parsing', () => {
    const viewport = { x: 400, y: 300, zoom: .000002 }
    const parsed = parseWorkflowFile(serializeWorkflow({ schemaVersion: 2, name: '远景', nodes: [], edges: [], viewport }))
    expect(parsed?.viewport).toEqual(viewport)
  })
  it('does not apply a queued fit after the active project has changed', () => {
    const frames: Array<() => void> = [], setViewport = vi.fn()
    const projectEpochRef = { current: 1 }, activeProjectIdRef = { current: 'a' }
    const cancelInsertionViewportNavigation = vi.fn()
    const flow = { getNodes: () => [{ id: 'a' }], getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), setViewport }
    const fit = actual('fitCanvasNodes', { cancelInsertionViewportNavigation, createdNodeFocusRef: { current: { cancel: vi.fn() } }, viewportRestorationRef: { current: { cancel: vi.fn() } }, projectEpochRef, activeProjectIdRef, projectTransitionRef: { current: false }, currentReactFlowRef: { current: flow }, document: { querySelector: () => ({}) }, measureCanvasSafeViewport: () => ({ x: 0, y: 0, width: 800, height: 600 }), fitCanvasViewport, window: { requestAnimationFrame: (run: () => void) => frames.push(run) } })
    fit(); projectEpochRef.current = 2; activeProjectIdRef.current = 'b'; frames.forEach((run) => run()); expect(setViewport).not.toHaveBeenCalled()
    expect(cancelInsertionViewportNavigation).toHaveBeenCalledOnce()
  })
  it('returns from overview to the exact previous viewport without changing node selection', () => {
    const original = { x: -1234.567, y: 890.123, zoom: .000002 }, setViewport = vi.fn(), setDocumentViewport = vi.fn(), fitCanvasNodes = vi.fn()
    const overviewViewportRef = { current: null as Viewport | null }, nodes = [{ id: 'a', selected: true }]
    const cancelInsertionViewportNavigation = vi.fn()
    const toggle = actual('toggleCanvasOverview', { cancelInsertionViewportNavigation, createdNodeFocusRef: { current: { cancel: vi.fn() } }, viewportRestorationRef: { current: { cancel: vi.fn() } }, overviewViewportRef, nodes, reactFlow: { getViewport: () => original, setViewport }, setDocumentViewport, fitCanvasNodes })
    toggle(); expect(fitCanvasNodes).toHaveBeenCalledOnce(); expect(overviewViewportRef.current).toBe(original)
    toggle(); expect(setViewport).toHaveBeenCalledExactlyOnceWith(original, { duration: 180 }); expect(setDocumentViewport).toHaveBeenCalledExactlyOnceWith(original); expect(nodes).toEqual([{ id: 'a', selected: true }])
    expect(cancelInsertionViewportNavigation).toHaveBeenCalledTimes(2)
  })
})
