import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canvasEdgeInsertPoint, canvasRenderedEdges } from './workflow-edge-model'

describe('edge quick insertion position', () => {
  const button = { left: 460, top: 280, width: 92, height: 32 }

  it('anchors keyboard activation to the visible button instead of the canvas origin', () => {
    expect(canvasEdgeInsertPoint({ detail: 0, clientX: 0, clientY: 0 }, button)).toEqual({ x: 506, y: 296 })
  })

  it('preserves the pointer location when a wire action is clicked', () => {
    expect(canvasEdgeInsertPoint({ detail: 1, clientX: 479, clientY: 290 }, button)).toEqual({ x: 479, y: 290 })
  })
})

// #1368 第 5 条：拖一个节点，画布每帧都重画一次；连线数组每帧换新，React Flow 就把几百条连线全部重放一遍。
describe('edges handed to React Flow', () => {
  interface TestEdge { id: string; source: string; target: string; className?: string; hidden?: boolean; data?: Record<string, unknown> }
  const edges: TestEdge[] = [
    { id: 'a-b', source: 'a', target: 'b' },
    { id: 'b-c', source: 'b', target: 'c', data: { tone: 'image' } },
    { id: 'c-d', source: 'c', target: 'd' },
  ]

  it('hands back the very same array when nothing is selected, dropped on or hidden', () => {
    expect(canvasRenderedEdges(edges, { selectedNodeIds: new Set(), hidden: false })).toBe(edges)
    expect(canvasRenderedEdges(edges, { selectedNodeIds: new Set(['x']), dropTargetId: 'none', hidden: false })).toBe(edges)
  })

  it('keeps an edge that already carries what it should, and copies only the ones that change', () => {
    const selected = canvasRenderedEdges(edges, { selectedNodeIds: new Set(['b']), hidden: false })
    expect(selected).not.toBe(edges)
    expect(selected[0]).toEqual({ id: 'a-b', source: 'a', target: 'b', hidden: false, className: 'is-flowing', data: { flowing: true } })
    expect(selected[1]).toEqual({ id: 'b-c', source: 'b', target: 'c', hidden: false, className: 'is-flowing', data: { tone: 'image', flowing: true } })
    expect(selected[2]).toBe(edges[2])
    // Handing the result back, as the next frame does, changes nothing.
    expect(canvasRenderedEdges(selected, { selectedNodeIds: new Set(['b']), hidden: false })).toBe(selected)
  })

  it('marks the drop target and hides every edge when connections are hidden', () => {
    const dropped = canvasRenderedEdges(edges, { selectedNodeIds: new Set(), dropTargetId: 'c-d', hidden: false })
    expect(dropped[2].className).toBe('is-drop-target')
    expect(dropped.slice(0, 2)).toEqual(edges.slice(0, 2))
    const hidden = canvasRenderedEdges(edges, { selectedNodeIds: new Set(), hidden: true })
    expect(hidden.every((edge) => edge.hidden === true)).toBe(true)
    // Showing them again returns edges React Flow reads as visible.
    expect(canvasRenderedEdges(hidden, { selectedNodeIds: new Set(), hidden: false }).every((edge) => !edge.hidden)).toBe(true)
  })

  it('is what the editor gives React Flow, keyed so a drag frame does not rebuild it', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('const renderedEdges = useMemo(() => canvasRenderedEdges(edges, {')
    expect(app).toContain('}), [edgeDropTargetId, edges, selectedNodeKey, uiPreferences.connectionsHidden])')
    expect(app).toContain('edges={renderedEdges}')
  })
})

// 同一条：运行按钮旁边那次预检只为看「有没有还在读的生成来源」，没有在读的就不必每帧把整张图走一遍。
describe('the idle run preflight', () => {
  it('runs only while a generation source is still being read', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('if (serverBacked && !activeRunOption.disabled && runPendingMediaKinds.length > 0) {')
    expect(app).toContain('activeRunHasPendingMedia = pendingCanvasMediaRunKinds(preflight, runPendingMediaKinds, mediaGroupsRef.current).length > 0')
  })
})
