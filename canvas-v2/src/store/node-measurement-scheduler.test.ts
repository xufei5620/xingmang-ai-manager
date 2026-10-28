import type { Node, NodeDimensionChange } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'
import { applyNodeMeasurements, createNodeMeasurementScheduler } from './node-measurement-scheduler'

function measurement(id: string, width: number, height = 200): NodeDimensionChange { return { id, type: 'dimensions', dimensions: { width, height } } }
function fixture() {
  const frames = new Map<number, () => void>()
  let sequence = 0
  const apply = vi.fn()
  const scheduler = createNodeMeasurementScheduler({ requestFrame(callback) { frames.set(++sequence, callback); return sequence }, cancelFrame(handle) { frames.delete(handle) }, apply })
  return { scheduler, frames, apply, tick() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()) } }
}

describe('node measurement scheduling', () => {
  it('defers observer changes and coalesces each node to its latest dimensions in one frame', () => {
    const target = fixture()
    target.scheduler.enqueue([measurement('crop', 300), measurement('grid', 320)])
    target.scheduler.enqueue([measurement('grid', 360, 500)])
    expect(target.apply).not.toHaveBeenCalled()
    expect(target.frames.size).toBe(1)
    target.tick()
    expect(target.apply).toHaveBeenCalledExactlyOnceWith([measurement('crop', 300), measurement('grid', 360, 500)])
  })

  it('does not queue interactive resize frames or their finishing frame', () => {
    const target = fixture()
    target.scheduler.enqueue([{ ...measurement('crop', 300), resizing: true }, { ...measurement('crop', 360), resizing: false }])
    expect(target.frames.size).toBe(0)
  })

  it('discards stale measurements when a node is deleted or explicitly resized', () => {
    const target = fixture()
    target.scheduler.enqueue([measurement('deleted', 300), measurement('resized', 320), measurement('kept', 400)])
    target.scheduler.discard(['deleted', 'resized'])
    target.tick()
    expect(target.apply).toHaveBeenCalledExactlyOnceWith([measurement('kept', 400)])
  })

  it('cancels a pending frame on project reset or unmount and can accept new project measurements', () => {
    const target = fixture()
    target.scheduler.enqueue([measurement('same-id', 300)])
    target.scheduler.clear()
    target.tick()
    expect(target.apply).not.toHaveBeenCalled()
    target.scheduler.enqueue([measurement('same-id', 700)])
    target.tick()
    expect(target.apply).toHaveBeenCalledExactlyOnceWith([measurement('same-id', 700)])
  })

  it('schedules changes emitted during apply in another frame instead of synchronously recursing', () => {
    const target = fixture()
    target.apply.mockImplementationOnce(() => target.scheduler.enqueue([measurement('grid', 500)]))
    target.scheduler.enqueue([measurement('grid', 300)])
    target.tick()
    expect(target.apply).toHaveBeenCalledTimes(1)
    expect(target.frames.size).toBe(1)
    target.tick()
    expect(target.apply).toHaveBeenCalledTimes(2)
  })

  it('does not mutate the caller change object while it is queued', () => {
    const target = fixture(), input = measurement('crop', 300)
    target.scheduler.enqueue([input])
    input.dimensions!.width = 999
    target.tick()
    expect(target.apply).toHaveBeenCalledExactlyOnceWith([measurement('crop', 300)])
  })
})

describe('applying measured node dimensions', () => {
  const nodes: Node[] = [{ id: 'crop', position: { x: 0, y: 0 }, measured: { width: 300, height: 200 }, data: {} }]

  it('retains the graph reference for unchanged, removed, or invalid measurements', () => {
    expect(applyNodeMeasurements(nodes, [measurement('crop', 300), measurement('removed', 500), measurement('crop', NaN)])).toBe(nodes)
  })

  it('changes only the measured node while preserving its document dimensions', () => {
    const next = applyNodeMeasurements(nodes, [measurement('crop', 350, 500)])
    expect(next[0]).toMatchObject({ measured: { width: 350, height: 500 } })
    expect(next[0].width).toBeUndefined()
    expect(nodes[0].measured).toEqual({ width: 300, height: 200 })
  })

  it('honours parent expansion attributes even when the measured dimensions are equal', () => {
    const next = applyNodeMeasurements(nodes, [{ ...measurement('crop', 300), setAttributes: true }])
    expect(next[0]).toMatchObject({ width: 300, height: 200 })
  })
})
