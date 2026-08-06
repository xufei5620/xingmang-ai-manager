import { describe, expect, it } from 'vitest'
import { createScanRequestTracker } from './scan-coordinator'

describe('scan request coordination', () => {
  it('keeps a late response from becoming the current result', () => {
    const tracker = createScanRequestTracker()
    const first = tracker.begin()
    const second = tracker.begin()

    expect(tracker.isCurrent(second)).toBe(true)
    expect(tracker.isCurrent(first)).toBe(false)
    expect(tracker.finish(second)).toBe(1)
    expect(tracker.finish(first)).toBe(0)
    expect(tracker.isInvalidated()).toBe(false)
  })

  it('invalidates deferred responses after unmount', () => {
    const tracker = createScanRequestTracker()
    const request = tracker.begin()
    tracker.invalidate()

    expect(tracker.isCurrent(request)).toBe(false)
    expect(tracker.activeCount()).toBe(0)
    expect(tracker.isInvalidated()).toBe(true)
  })
})
