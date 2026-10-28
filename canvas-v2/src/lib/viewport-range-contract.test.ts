import { describe, expect, it } from 'vitest'
import { assertViewportRangeClientVersion, workflowHasExtendedViewport } from './viewport-range-contract'

describe('raw workflow viewport range capability', () => {
  it.each([{ x: 0, y: 0, zoom: .000001 }, { x: 10000001, y: 0, zoom: 1 }, { x: 0, y: -80000000, zoom: 8 }])('detects the raw extended viewport %j before projection', (viewport) => {
    for (const value of [{ viewport }, JSON.stringify({ viewport }), { format: 'xingmang-canvas-project', workflow: { viewport } }]) {
      expect(workflowHasExtendedViewport(value)).toBe(true)
      for (const version of [undefined, null, false, 0, 2, '1', {}]) expect(() => assertViewportRangeClientVersion(version, value)).toThrow('刷新')
      expect(() => assertViewportRangeClientVersion(1, value)).not.toThrow()
    }
  })
  it('retains old ordinary viewport compatibility and ignores image editor zoom carriers', () => {
    for (const value of [{ viewport: { x: 10000000, y: -10000000, zoom: .01 } }, { nodes: [{ data: { settings: { imageTransform: { viewport: { x: 80000000, zoom: .001 } } } } }] }, '{invalid']) {
      expect(workflowHasExtendedViewport(value)).toBe(false); expect(() => assertViewportRangeClientVersion(undefined, value)).not.toThrow()
    }
    expect(() => assertViewportRangeClientVersion('1', {})).toThrow('刷新')
  })
})
