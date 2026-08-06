import { describe, expect, it } from 'vitest'
import { createLatestRequestTracker } from './latest-request'

describe('latest request tracker', () => {
  it('keeps request ordering independent per resource key', () => {
    const tracker = createLatestRequestTracker<string>()
    const firstCodex = tracker.begin('codex')
    const claude = tracker.begin('claude')
    const secondCodex = tracker.begin('codex')

    expect(tracker.isCurrent('codex', firstCodex)).toBe(false)
    expect(tracker.isCurrent('codex', secondCodex)).toBe(true)
    expect(tracker.isCurrent('claude', claude)).toBe(true)
  })

  it('invalidates one request or all active requests', () => {
    const tracker = createLatestRequestTracker<string>()
    const codex = tracker.begin('codex')
    const claude = tracker.begin('claude')
    tracker.invalidate('codex')
    expect(tracker.isCurrent('codex', codex)).toBe(false)
    expect(tracker.isCurrent('claude', claude)).toBe(true)

    tracker.invalidateAll()
    expect(tracker.isCurrent('claude', claude)).toBe(false)
  })
})
