import { describe, expect, it, vi } from 'vitest'
import { buildCanvasPriceSnapshot, canvasPriceSnapshotCacheMs, canvasPriceSnapshotRetryMs, createCanvasPriceSnapshotReader } from './canvas-price-snapshot'
import type { NewApiModelPricing } from './new-api-client'

const at = Date.parse('2026-11-10T03:00:00.000Z')

function pricing(overrides: Partial<NewApiModelPricing> = {}): NewApiModelPricing {
  return {
    models: [
      { model: 'gpt-image-2', quotaType: 1, modelPrice: 0.06, expressionPriced: false },
      { model: 'grok-imagine-video', quotaType: 1, modelPrice: 0.8, expressionPriced: false },
      { model: 'claude-sonnet-4-5', quotaType: 0, modelPrice: 0, expressionPriced: false },
      { model: 'gemini-3-pro-image-preview', quotaType: 1, modelPrice: 0.12, expressionPriced: true },
      { model: 'bad\u0007name', quotaType: 1, modelPrice: 0.01, expressionPriced: false },
      { model: 'x'.repeat(129), quotaType: 1, modelPrice: 0.01, expressionPriced: false },
      { model: 'gpt-image-1', quotaType: 1, modelPrice: 5_000, expressionPriced: false },
    ],
    groupRatios: { default: 1, vip: 0.8, broken: 5_000 },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('canvas price snapshot', () => {
  it('keeps per-call prices the canvas can request and marks video an estimate', () => {
    const snapshot = buildCanvasPriceSnapshot(pricing(), at)
    expect(snapshot).toEqual({
      models: {
        'gpt-image-2': { usd: 0.06 },
        'grok-imagine-video': { usd: 0.8, approximate: true },
      },
      groupRatios: { default: 1, vip: 0.8 },
      readAt: '2026-11-10T03:00:00.000Z',
    })
  })

  it('leaves out token-priced, expression-priced, unknown and absurd entries rather than guessing', () => {
    const snapshot = buildCanvasPriceSnapshot(pricing(), at)
    expect(snapshot.models).not.toHaveProperty('claude-sonnet-4-5')
    expect(snapshot.models).not.toHaveProperty('gemini-3-pro-image-preview')
    expect(Object.keys(snapshot.models)).toEqual(['gpt-image-2', 'grok-imagine-video'])
    expect(snapshot.models).not.toHaveProperty('gpt-image-1')
    expect(snapshot.groupRatios).not.toHaveProperty('broken')
  })
})

describe('canvas price snapshot reader', () => {
  function fixture(options: { siteId?: 'solov' | 'solov-api'; signedIn?: boolean; readPricing?: () => Promise<NewApiModelPricing | null> } = {}) {
    const state = {
      clock: at,
      account: options.signedIn === false ? null : { key: 'solov:7', siteId: options.siteId ?? 'solov' as const },
    }
    const readPricing = vi.fn(options.readPricing ?? (async () => pricing()))
    const read = createCanvasPriceSnapshotReader({ current: () => state.account, readPricing, now: () => state.clock })
    return { state, readPricing, read }
  }

  it('answers null without reading when nobody is signed in or the account has no price list', async () => {
    const signedOut = fixture({ signedIn: false })
    await expect(signedOut.read()).resolves.toBeNull()
    expect(signedOut.readPricing).not.toHaveBeenCalled()

    const historical = fixture({ siteId: 'solov-api' })
    await expect(historical.read()).resolves.toBeNull()
    expect(historical.readPricing).not.toHaveBeenCalled()
  })

  it('reads once and serves the same answer until the cache runs out', async () => {
    const { state, readPricing, read } = fixture()
    const first = await read()
    expect(first?.models['gpt-image-2']).toEqual({ usd: 0.06 })
    state.clock += canvasPriceSnapshotCacheMs - 1
    await expect(read()).resolves.toBe(first)
    expect(readPricing).toHaveBeenCalledTimes(1)
    state.clock += 1
    await read()
    expect(readPricing).toHaveBeenCalledTimes(2)
  })

  it('shares one read between callers that ask at the same time', async () => {
    const pending = deferred<NewApiModelPricing>()
    const { readPricing, read } = fixture({ readPricing: () => pending.promise })
    const first = read()
    const second = read()
    pending.resolve(pricing())
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(readPricing).toHaveBeenCalledTimes(1)
  })

  it('waits out the retry window after a failure however often the canvas asks', async () => {
    let fail = true
    const { state, readPricing, read } = fixture({
      readPricing: async () => {
        if (fail) throw new Error('网络不通')
        return pricing()
      },
    })
    await expect(read()).resolves.toBeNull()
    for (let index = 0; index < 5; index += 1) await expect(read()).resolves.toBeNull()
    expect(readPricing).toHaveBeenCalledTimes(1)
    fail = false
    state.clock += canvasPriceSnapshotRetryMs
    await expect(read()).resolves.toMatchObject({ groupRatios: { default: 1, vip: 0.8 } })
    expect(readPricing).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good answer when a later read fails', async () => {
    let fail = false
    const { state, read } = fixture({
      readPricing: async () => {
        if (fail) throw new Error('网络不通')
        return pricing()
      },
    })
    const first = await read()
    fail = true
    state.clock += canvasPriceSnapshotCacheMs
    await expect(read()).resolves.toBe(first)
  })

  it('answers null when the backend has no price list', async () => {
    const { read } = fixture({ readPricing: async () => null })
    await expect(read()).resolves.toBeNull()
  })

  it('drops an answer read for an account that is gone and reads afresh for the new one', async () => {
    const pending = deferred<NewApiModelPricing>()
    let calls = 0
    const { state, read, readPricing } = fixture({
      readPricing: () => {
        calls += 1
        return calls === 1 ? pending.promise : Promise.resolve(pricing({ groupRatios: { default: 2 } }))
      },
    })
    const stale = read()
    state.account = { key: 'solov:8', siteId: 'solov' }
    const fresh = read()
    pending.resolve(pricing())
    await expect(stale).resolves.toBeNull()
    await expect(fresh).resolves.toMatchObject({ groupRatios: { default: 2 } })
    expect(readPricing).toHaveBeenCalledTimes(2)
    // The stale answer never landed in the cache.
    await expect(read()).resolves.toMatchObject({ groupRatios: { default: 2 } })
    expect(readPricing).toHaveBeenCalledTimes(2)
  })
})
