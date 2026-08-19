import { describe, expect, it } from 'vitest'
import { canvasEdgeMidpoint, canvasEdgeTone, canvasEdgeToneVariable } from './workflow-edge-model'

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

describe('canvasEdgeMidpoint', () => {
  it('sits halfway between the two endpoints', () => {
    expect(canvasEdgeMidpoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 })
  })

  it('handles negative and identical coordinates without drifting', () => {
    expect(canvasEdgeMidpoint({ x: -40, y: 20 }, { x: 40, y: -20 })).toEqual({ x: 0, y: 0 })
    expect(canvasEdgeMidpoint({ x: 12, y: 8 }, { x: 12, y: 8 })).toEqual({ x: 12, y: 8 })
  })
})
