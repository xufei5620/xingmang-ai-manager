import { describe, expect, it } from 'vitest'
import { canvasMinimapNodeColor } from './minimap-node-color'

describe('canvas minimap node color', () => {
  it('falls back to a neutral surface for idle and unknown nodes', () => {
    expect(canvasMinimapNodeColor({})).toBe('var(--surface-3)')
    expect(canvasMinimapNodeColor({ data: { status: 'idle' } })).toBe('var(--surface-3)')
  })

  it('maps every run state to its own token', () => {
    expect(canvasMinimapNodeColor({ data: { status: 'queued' } })).toBe('var(--state-queued)')
    expect(canvasMinimapNodeColor({ data: { status: 'running' } })).toBe('var(--state-running)')
    expect(canvasMinimapNodeColor({ data: { status: 'succeeded' } })).toBe('var(--state-succeeded)')
    expect(canvasMinimapNodeColor({ data: { status: 'failed' } })).toBe('var(--state-failed)')
  })

  it('never hides a failure behind a stale success or a dirty marker', () => {
    expect(canvasMinimapNodeColor({ data: { status: 'failed', dirty: true } })).toBe('var(--state-failed)')
    expect(canvasMinimapNodeColor({ data: { status: 'running', dirty: true } })).toBe('var(--state-running)')
  })

  it('prefers the dirty marker over a previous success', () => {
    expect(canvasMinimapNodeColor({ data: { status: 'succeeded', dirty: true } })).toBe('var(--state-dirty)')
    expect(canvasMinimapNodeColor({ data: { status: 'succeeded', dirty: false } })).toBe('var(--state-succeeded)')
  })
})
