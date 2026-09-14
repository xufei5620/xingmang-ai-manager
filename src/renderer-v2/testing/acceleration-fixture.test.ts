import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accelerationTrialSeconds } from '../../../electron/acceleration-contract'
import { createPreviewAccelerationApi } from './acceleration-fixture'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
    removeItem(key) { values.delete(key) },
    clear() { values.clear() },
    key(index) { return [...values.keys()][index] ?? null },
  }
}

describe('acceleration preview allowance', () => {
  const scope = 'xm-account:1'
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T00:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('starts with a twenty-minute cumulative trial and does not reset it on a later day', async () => {
    const storage = memoryStorage()
    const api = createPreviewAccelerationApi({ storage })
    expect(accelerationTrialSeconds).toBe(1200)
    expect(await api.getAccelerationState(scope)).toMatchObject({ totalSeconds: 1200, remainingSeconds: 1200, phase: 'idle' })
    await api.startAcceleration(scope, 'system-proxy')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await api.stopAcceleration(scope)).toMatchObject({ remainingSeconds: 1110, sessionSeconds: 90, phase: 'idle' })
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'))
    const restarted = createPreviewAccelerationApi({ storage })
    expect(await restarted.getAccelerationState(scope)).toMatchObject({ remainingSeconds: 1110, phase: 'idle' })
    await restarted.startAcceleration(scope, 'tun')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await restarted.stopAcceleration(scope)).toMatchObject({ remainingSeconds: 1100, sessionSeconds: 10 })
  })

  it('migrates thirty-five old remaining minutes as twenty-five used minutes and grants no new time', async () => {
    const storage = memoryStorage()
    storage.setItem(`xingmang-acceleration-preview:${scope}`, String(35 * 60 * 1000))
    const api = createPreviewAccelerationApi({ storage })
    expect(await api.getAccelerationState(scope)).toMatchObject({ totalSeconds: 1200, remainingSeconds: 0, phase: 'exhausted' })
    expect(JSON.parse(storage.getItem(`xingmang-acceleration-preview:v2:${scope}`) ?? '')).toEqual({ version: 2, usedMilliseconds: 25 * 60 * 1000 })
    expect(await api.startAcceleration(scope, 'system-proxy')).toMatchObject({ phase: 'exhausted', remainingSeconds: 0 })
    expect(storage.getItem(`xingmang-acceleration-preview:${scope}`)).toBe(String(35 * 60 * 1000))
  })

  it('preserves five used legacy minutes across migration and prefers the new record on subsequent loads', async () => {
    const storage = memoryStorage()
    storage.setItem(`xingmang-acceleration-preview:${scope}`, String(55 * 60 * 1000))
    const api = createPreviewAccelerationApi({ storage })
    expect(await api.getAccelerationState(scope)).toMatchObject({ remainingSeconds: 900 })
    await api.startAcceleration(scope, 'system-proxy')
    await vi.advanceTimersByTimeAsync(60_000)
    await api.stopAcceleration(scope)
    storage.setItem(`xingmang-acceleration-preview:${scope}`, String(60 * 60 * 1000))
    expect(await createPreviewAccelerationApi({ storage }).getAccelerationState(scope)).toMatchObject({ remainingSeconds: 840 })
  })

  it('keeps preview fixtures and account records isolated without topping up a lower allowance', async () => {
    const storage = memoryStorage()
    storage.setItem(`xingmang-acceleration-preview:${scope}`, String(60 * 60 * 1000))
    const short = createPreviewAccelerationApi({ storage, remainingSeconds: 3 })
    expect(await short.getAccelerationState(scope)).toMatchObject({ remainingSeconds: 3 })
    const fresh = createPreviewAccelerationApi({ storage })
    expect(await fresh.getAccelerationState(scope)).toMatchObject({ remainingSeconds: 3 })
    expect(await fresh.getAccelerationState('api-account:2')).toMatchObject({ remainingSeconds: 1200 })
  })

  it('does not turn a malformed existing preview record into a new trial', async () => {
    const storage = memoryStorage()
    storage.setItem(`xingmang-acceleration-preview:v2:${scope}`, '{broken-json')
    expect(await createPreviewAccelerationApi({ storage }).getAccelerationState(scope)).toMatchObject({ remainingSeconds: 0, phase: 'exhausted' })
  })
})
