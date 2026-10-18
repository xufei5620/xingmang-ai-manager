import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface RecordedEffect {
  effect: () => void | (() => void)
  deps: readonly unknown[] | undefined
}

const recordedEffects = vi.hoisted(() => [] as RecordedEffect[])

// react-dom/server never runs effects. Record them instead, so the test can
// mount and unmount the component by hand and see what the hook cleans up.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useEffect(effect: RecordedEffect['effect'], deps?: readonly unknown[]) {
      recordedEffects.push({ effect, deps })
    },
  }
})

const { createLatestRequest, useLatestRequest } = await import('./latest-request')
type LatestRequest = ReturnType<typeof createLatestRequest>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('renderer-v2 latest request', () => {
  beforeEach(() => {
    recordedEffects.length = 0
  })

  it('drops a slow response that lands after a newer request', async () => {
    const latest = createLatestRequest()
    const shown: string[] = []
    async function load(value: string, arrival: Promise<void>) {
      const current = latest.begin()
      await arrival
      if (current()) shown.push(value)
    }
    const slow = deferred()
    const fast = deferred()
    const first = load('old account', slow.promise)
    const second = load('new account', fast.promise)
    fast.resolve()
    await second
    slow.resolve()
    await first
    expect(shown).toEqual(['new account'])
  })

  it('keeps the latest request current however often it is checked', () => {
    const latest = createLatestRequest()
    const current = latest.begin()
    expect(current()).toBe(true)
    expect(current()).toBe(true)
  })

  it('invalidates every outstanding request without starting a new one', () => {
    const latest = createLatestRequest()
    const earlier = latest.begin()
    const later = latest.begin()
    latest.invalidate()
    expect(earlier()).toBe(false)
    expect(later()).toBe(false)
    // A stale request must stay stale once a new one starts, or it could still land late.
    const next = latest.begin()
    expect(next()).toBe(true)
    expect(earlier()).toBe(false)
    expect(later()).toBe(false)
  })

  it('lets several captures share one moment until something newer happens', () => {
    const account = createLatestRequest()
    const launch = account.capture()
    const install = account.capture()
    // Capturing again must not invalidate the earlier capture: both belong to the same account.
    expect(launch()).toBe(true)
    expect(install()).toBe(true)
    account.invalidate()
    expect(launch()).toBe(false)
    expect(install()).toBe(false)
    const reload = account.begin()
    const afterReload = account.capture()
    expect(reload()).toBe(true)
    expect(afterReload()).toBe(true)
    account.begin()
    expect(reload()).toBe(false)
    expect(afterReload()).toBe(false)
  })

  it('keeps separate trackers independent', () => {
    const groups = createLatestRequest()
    const models = createLatestRequest()
    const groupsRequest = groups.begin()
    const modelsRequest = models.begin()
    models.begin()
    expect(groupsRequest()).toBe(true)
    expect(modelsRequest()).toBe(false)
  })

  it('makes a component request stale once the component unmounts', () => {
    let tracker: LatestRequest | null = null
    let current: (() => boolean) | null = null
    function Probe() {
      tracker = useLatestRequest()
      current = tracker.begin()
      return <span data-testid="probe">ok</span>
    }
    expect(renderToStaticMarkup(<Probe />)).toContain('data-testid="probe"')
    if (!tracker || !current) throw new Error('the probe did not render')
    const check: () => boolean = current
    // The effect depends only on the tracker, which useState keeps for the
    // component's lifetime, so a rerender does not invalidate on its own.
    expect(recordedEffects).toHaveLength(1)
    expect(recordedEffects[0].deps).toEqual([tracker])
    const cleanup = recordedEffects[0].effect()
    expect(check()).toBe(true)
    if (typeof cleanup !== 'function') throw new Error('the hook did not return a cleanup')
    cleanup()
    expect(check()).toBe(false)
  })
})
