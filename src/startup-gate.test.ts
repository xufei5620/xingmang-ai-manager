import { describe, expect, it, vi } from 'vitest'
import { createStartupGate } from './startup-gate'

describe('startup gate', () => {
  it('does not resolve ready() until settle() is called', async () => {
    const gate = createStartupGate()
    const onReady = vi.fn()
    void gate.ready().then(onReady)

    // Flush the microtask queue without letting the still-pending promise resolve.
    await Promise.resolve()
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()

    gate.settle()
    await gate.ready()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('resolves every waiter -- queued before or after settle() -- off the same promise', async () => {
    const gate = createStartupGate()
    const before = gate.ready()
    gate.settle()
    const after = gate.ready()

    await expect(before).resolves.toBeUndefined()
    await expect(after).resolves.toBeUndefined()
  })

  it('treats settle() as idempotent', async () => {
    const gate = createStartupGate()
    gate.settle()
    expect(() => gate.settle()).not.toThrow()
    await expect(gate.ready()).resolves.toBeUndefined()
  })

  it('defers a wrapped async call until settle(), matching the refreshMcp/refreshPlugins usage pattern', async () => {
    const gate = createStartupGate()
    const calls: string[] = []
    const loadWhenReady = async () => {
      await gate.ready()
      calls.push('fetched')
    }

    const pending = loadWhenReady()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])

    gate.settle()
    await pending
    expect(calls).toEqual(['fetched'])
  })
})
