import { describe, expect, it } from 'vitest'
import { canvasEdgeInsertPoint } from './workflow-edge-model'

describe('edge quick insertion position', () => {
  const button = { left: 460, top: 280, width: 92, height: 32 }

  it('anchors keyboard activation to the visible button instead of the canvas origin', () => {
    expect(canvasEdgeInsertPoint({ detail: 0, clientX: 0, clientY: 0 }, button)).toEqual({ x: 506, y: 296 })
  })

  it('preserves the pointer location when a wire action is clicked', () => {
    expect(canvasEdgeInsertPoint({ detail: 1, clientX: 479, clientY: 290 }, button)).toEqual({ x: 479, y: 290 })
  })
})
