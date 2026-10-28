// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/edges/workflow-edge-model.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import { describe, expect, it } from 'vitest'
import {
  canvasEdgeClassName,
  canvasEdgeCurvature,
  canvasEdgeIsFlowing,
  canvasEdgeTone,
  canvasEdgeToneVariable,
  canvasEdgeTouchesSelection,
} from './workflow-edge-model'

describe('canvasEdgeTone', () => {
  it('reads the media kind from the producing end', () => {
    expect(canvasEdgeTone('out:image')).toBe('image')
    expect(canvasEdgeTone('out:video')).toBe('video')
    expect(canvasEdgeTone('out:audio')).toBe('audio')
    expect(canvasEdgeTone('out:text')).toBe('text')
  })

  it('falls back rather than guessing when the handle is missing or foreign', () => {
    expect(canvasEdgeTone(null)).toBe('unknown')
    expect(canvasEdgeTone(undefined)).toBe('unknown')
    expect(canvasEdgeTone('')).toBe('unknown')
    expect(canvasEdgeTone('out:hologram')).toBe('unknown')
  })

  it('maps every known tone onto a port token and unknown onto the default stroke', () => {
    expect(canvasEdgeToneVariable('image')).toBe('var(--port-image)')
    expect(canvasEdgeToneVariable('audio')).toBe('var(--port-audio)')
    expect(canvasEdgeToneVariable('unknown')).toBe('var(--xy-edge-stroke-default)')
  })
})

describe('canvas edge path', () => {
  // 原标题 'uses one muted bezier stroke for every wire'。内核按数据类型给连线上色（canvasEdgeToneVariable，
  // 上面的用例），不再有统一的 canvasEdgeStroke，这里只留曲线弧度。
  it('curves every wire as a bezier', () => {
    expect(canvasEdgeCurvature).toBeGreaterThan(0.2)
    expect(canvasEdgeCurvature).toBeLessThan(0.6)
  })
})

// canvasEdgeMidpoint 的两个用例退役：连线工具条改用 React Flow 给的标签位置（WorkflowEdge 的 labelX/labelY），
// 内核没有这个函数了。

describe('canvas edge flow', () => {
  it('lights an edge when either end is selected', () => {
    const edge = { source: 'a', target: 'b' }
    expect(canvasEdgeTouchesSelection(edge, new Set())).toBe(false)
    expect(canvasEdgeTouchesSelection(edge, new Set(['c']))).toBe(false)
    expect(canvasEdgeTouchesSelection(edge, new Set(['a']))).toBe(true)
    expect(canvasEdgeTouchesSelection(edge, new Set(['b', 'c']))).toBe(true)
  })

  it('combines drop-target and flowing class names without leftovers', () => {
    expect(canvasEdgeClassName({})).toBeUndefined()
    expect(canvasEdgeClassName({ dropTarget: true })).toBe('is-drop-target')
    expect(canvasEdgeClassName({ flowing: true })).toBe('is-flowing')
    expect(canvasEdgeClassName({ dropTarget: true, flowing: true })).toBe('is-drop-target is-flowing')
  })

  it('reads the flowing flag only from a boolean data field', () => {
    expect(canvasEdgeIsFlowing(undefined)).toBe(false)
    expect(canvasEdgeIsFlowing({ flowing: true })).toBe(true)
    expect(canvasEdgeIsFlowing({ flowing: 'yes' })).toBe(false)
  })
})
