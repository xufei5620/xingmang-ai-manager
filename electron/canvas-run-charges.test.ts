import { describe, expect, it, vi } from 'vitest'
import {
  canvasRunChargeFirstCheckMs,
  canvasRunChargeLastCheckMs,
  createCanvasRelayBillingRecorder,
  createCanvasRunChargeChecker,
  settleCanvasRunCharges,
  type CanvasRunUsagePage,
} from './canvas-run-charges'
import type { CanvasRunAttempt, CanvasRunChargeEvent, CanvasRunNodeKind, CanvasRunRecord } from './canvas-run-contract'

const startedAt = Date.parse('2026-11-10T05:00:00.000Z')

function attempt(attemptId: string, overrides: Partial<CanvasRunAttempt> = {}): CanvasRunAttempt {
  return {
    attemptId,
    fingerprint: 'f'.repeat(64),
    state: 'succeeded',
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + 5_000).toISOString(),
    durationMs: 5_000,
    cached: false,
    candidates: [],
    model: 'gpt-image-2',
    group: '图片模型',
    ...overrides,
  }
}

function run(runId: string, nodes: { nodeId: string; kind?: CanvasRunNodeKind; attempts: CanvasRunAttempt[] }[], userId = 7): CanvasRunRecord {
  return {
    version: 1,
    userId,
    ownerId: 3,
    runId,
    graphRevision: 'rev',
    scope: { kind: 'all' },
    status: 'succeeded',
    createdAt: new Date(startedAt).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + 6_000).toISOString(),
    nodes: nodes.map((node) => ({ nodeId: node.nodeId, kind: node.kind ?? 'image', state: 'succeeded', attempts: node.attempts })),
    events: [{ version: 1, type: 'run-terminal', runId, graphRevision: 'rev', sequence: 9, at: new Date(startedAt + 6_000).toISOString(), status: 'succeeded', outcome: { succeeded: [], failed: [], skipped: [], cancelled: [], cached: [] } }],
  }
}

const checkedAt = '2026-11-10T05:00:12.000Z'

describe('canvas relay billing recorder', () => {
  it('records nothing until a request leaves, and nothing for one that never left', () => {
    const recorder = createCanvasRelayBillingRecorder()
    expect(recorder.snapshot()).toBeUndefined()
    recorder.observer.onRelayDispatch?.(true)
    recorder.observer.onRelayDispatch?.(false)
    expect(recorder.snapshot()).toBeUndefined()
  })

  it('keeps each answered request id and remembers requests that got no answer or no id', () => {
    const recorder = createCanvasRelayBillingRecorder()
    recorder.observer.onRelayDispatch?.(true)
    recorder.observer.onRelayAnswer?.('req-1')
    recorder.observer.onRelayDispatch?.(true)
    recorder.observer.onRelayAnswer?.('req-2')
    expect(recorder.snapshot()).toEqual({ requestIds: ['req-1', 'req-2'] })
    recorder.observer.onRelayDispatch?.(true)
    expect(recorder.snapshot()).toEqual({ requestIds: ['req-1', 'req-2'], unanswered: true })
    recorder.observer.onRelayAnswer?.(null)
    expect(recorder.snapshot()).toEqual({ requestIds: ['req-1', 'req-2'], unidentified: true })
  })

  it('caps the ids one attempt keeps and says some are missing', () => {
    const recorder = createCanvasRelayBillingRecorder()
    for (let index = 0; index < 10; index += 1) {
      recorder.observer.onRelayDispatch?.(true)
      recorder.observer.onRelayAnswer?.(`req-${index}`)
    }
    expect(recorder.snapshot()).toMatchObject({ unidentified: true })
    expect(recorder.snapshot()?.requestIds).toHaveLength(8)
  })
})

describe('canvas run charge settlement', () => {
  const quotaPerUnit = 500_000

  it('settles nothing when no paid request left', () => {
    const record = run('r', [{ nodeId: 'a', attempts: [attempt('cached', { cached: true, relayBilling: { requestIds: ['x'] } }), attempt('local')] }])
    expect(settleCanvasRunCharges(record, new Map(), quotaPerUnit, { final: true, checkedAt })).toBeNull()
  })

  it('turns matched charges into dollars', () => {
    const record = run('r', [
      { nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] },
      { nodeId: 'b', kind: 'drama-parse', attempts: [attempt('b1', { model: 'gpt-5.6-sol', relayBilling: { requestIds: ['req-2', 'req-3'] } })] },
    ])
    const settlement = settleCanvasRunCharges(record, new Map([['req-1', 30_000], ['req-2', 1_000], ['req-3', 500]]), quotaPerUnit, { final: false, checkedAt })
    expect(settlement).toEqual({
      charge: { state: 'settled', usd: 0.063, unmatchedAttempts: 0, checkedAt },
      attempts: [
        { nodeId: 'a', attemptId: 'a1', charge: { state: 'settled', usd: 0.06 } },
        { nodeId: 'b', attemptId: 'b1', charge: { state: 'settled', usd: 0.003 } },
      ],
    })
  })

  it('waits for a request not in the records yet, then calls a succeeded one 待核对 and a failed one free', () => {
    const record = run('r', [
      { nodeId: 'a', attempts: [attempt('ok', { relayBilling: { requestIds: ['req-1'] } })] },
      { nodeId: 'b', attempts: [attempt('refused', { state: 'failed', relayBilling: { requestIds: ['req-2'] } })] },
    ])
    expect(settleCanvasRunCharges(record, new Map(), quotaPerUnit, { final: false, checkedAt })).toBe('pending')
    expect(settleCanvasRunCharges(record, new Map(), quotaPerUnit, { final: true, checkedAt })).toEqual({
      charge: { state: 'unmatched', usd: 0, unmatchedAttempts: 1, checkedAt },
      attempts: [
        { nodeId: 'a', attemptId: 'ok', charge: { state: 'unmatched', usd: 0 } },
        { nodeId: 'b', attemptId: 'refused', charge: { state: 'settled', usd: 0 } },
      ],
    })
  })

  it('never settles a request that got no answer or no id, and keeps what did match', () => {
    const record = run('r', [{ nodeId: 'a', attempts: [
      attempt('stopped', { state: 'cancelled', relayBilling: { requestIds: [], unanswered: true } }),
      attempt('half', { relayBilling: { requestIds: ['req-1'], unidentified: true } }),
    ] }])
    const settlement = settleCanvasRunCharges(record, new Map([['req-1', 30_000]]), quotaPerUnit, { final: false, checkedAt })
    expect(settlement).toMatchObject({
      charge: { state: 'unmatched', usd: 0.06, unmatchedAttempts: 2 },
      attempts: [{ charge: { state: 'unmatched', usd: 0 } }, { charge: { state: 'unmatched', usd: 0.06 } }],
    })
  })

  it('marks video an estimate, and a failed video that was charged 待核对 because a refund may follow', () => {
    const record = run('r', [
      { nodeId: 'v', kind: 'video', attempts: [attempt('ok', { model: 'grok-imagine-video', relayBilling: { requestIds: ['req-1'] } })] },
      { nodeId: 'w', kind: 'video-generate', attempts: [attempt('bad', { state: 'failed', model: 'grok-imagine-video', relayBilling: { requestIds: ['req-2'] } })] },
    ])
    const settlement = settleCanvasRunCharges(record, new Map([['req-1', 400_000], ['req-2', 400_000]]), quotaPerUnit, { final: false, checkedAt })
    expect(settlement).toMatchObject({
      charge: { state: 'unmatched', usd: 1.6, unmatchedAttempts: 1, approximate: true },
      attempts: [
        { charge: { state: 'settled', usd: 0.8, approximate: true } },
        { charge: { state: 'unmatched', usd: 0.8, approximate: true } },
      ],
    })
  })

  it('leaves every paid attempt 待核对 when the records could not be read', () => {
    const record = run('r', [{ nodeId: 'a', attempts: [attempt('a1', { state: 'failed', relayBilling: { requestIds: ['req-1'] } })] }])
    expect(settleCanvasRunCharges(record, null, quotaPerUnit, { final: true, checkedAt })).toMatchObject({
      charge: { state: 'unmatched', usd: 0, unmatchedAttempts: 1 },
    })
  })
})

describe('canvas run charge checker', () => {
  function fixture(options: { records?: CanvasRunRecord[]; logs?: { requestId: string; quota: number; model: string; type?: number }[]; readUsage?: () => Promise<CanvasRunUsagePage>; quotaPerUnit?: number | null } = {}) {
    const state = {
      clock: startedAt + 6_000,
      account: { userId: 7, key: 'r1:7' } as { userId: number; key: string } | null,
      timers: [] as { callback: () => void; at: number }[],
      records: new Map((options.records ?? []).map((record) => [record.runId, structuredClone(record)])),
      logs: options.logs ?? [],
    }
    const readUsage = vi.fn(options.readUsage ?? (async (query: { modelName: string; page: number; pageSize: number }) => {
      const matched = state.logs.filter((entry) => entry.model === query.modelName)
      return {
        records: matched.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((entry) => ({ requestId: entry.requestId, quota: entry.quota, type: entry.type ?? 2 })),
        total: matched.length,
      }
    }))
    const saveRun = vi.fn(async (_userId: number, record: CanvasRunRecord) => { state.records.set(record.runId, structuredClone(record)) })
    const published: { event: CanvasRunChargeEvent; userId: number; ownerId: number }[] = []
    const checker = createCanvasRunChargeChecker({
      current: () => state.account,
      readUsage,
      readQuotaPerUnit: async () => options.quotaPerUnit === undefined ? 500_000 : options.quotaPerUnit,
      getRun: async (_userId, runId) => structuredClone(state.records.get(runId) ?? null),
      saveRun,
      publish: (event, userId, ownerId) => { published.push({ event, userId, ownerId }) },
      now: () => state.clock,
      setTimer: (callback, delayMs) => {
        const timer = { callback, at: state.clock + delayMs }
        state.timers.push(timer)
        return timer
      },
      clearTimer: (timer) => { state.timers = state.timers.filter((entry) => entry !== timer) },
    })
    async function advance(ms: number): Promise<void> {
      state.clock += ms
      for (;;) {
        const due = state.timers.filter((timer) => timer.at <= state.clock)
        if (due.length === 0) break
        state.timers = state.timers.filter((timer) => !due.includes(timer))
        for (const timer of due) timer.callback()
        await checker.whenIdle()
      }
    }
    return { state, checker, readUsage, saveRun, published, advance }
  }

  it('waits a few seconds, checks runs that end together in one batch and writes the charge into each record', async () => {
    const first = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    const second = run('r2', [{ nodeId: 'b', attempts: [attempt('b1', { relayBilling: { requestIds: ['req-2'] } })] }])
    const { state, checker, readUsage, published, advance } = fixture({
      records: [first, second],
      logs: [{ requestId: 'req-2', quota: 30_000, model: 'gpt-image-2' }, { requestId: 'req-1', quota: 30_000, model: 'gpt-image-2' }, { requestId: 'other', quota: 9, model: 'gpt-image-2' }],
    })
    checker.schedule(first, 3)
    await advance(1_000)
    checker.schedule(second, 3)
    await advance(canvasRunChargeFirstCheckMs - 1_001)
    expect(readUsage).not.toHaveBeenCalled()
    await advance(1)
    expect(readUsage).toHaveBeenCalledTimes(1)
    expect(readUsage.mock.calls[0][0]).toMatchObject({ modelName: 'gpt-image-2', page: 1, pageSize: 100 })
    expect(state.records.get('r1')).toMatchObject({ charge: { state: 'settled', usd: 0.06, unmatchedAttempts: 0 }, nodes: [{ attempts: [{ charge: { state: 'settled', usd: 0.06 } }] }] })
    expect(state.records.get('r2')?.charge).toMatchObject({ state: 'settled', usd: 0.06 })
    expect(published.map((entry) => [entry.event.type, entry.event.runId, entry.event.sequence, entry.ownerId])).toEqual([['run-charge', 'r2', 10, 3], ['run-charge', 'r1', 10, 3]])
    expect(published[0].event.attempts).toEqual([{ nodeId: 'b', attemptId: 'b1', charge: { state: 'settled', usd: 0.06 } }])
  })

  it('looks once more for a request not in the records yet and then gives its final answer', async () => {
    const record = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    const { state, checker, readUsage, published, advance } = fixture({ records: [record] })
    checker.schedule(record, 3)
    await advance(canvasRunChargeFirstCheckMs)
    expect(readUsage).toHaveBeenCalledTimes(1)
    expect(published).toEqual([])
    state.logs.push({ requestId: 'req-1', quota: 30_000, model: 'gpt-image-2' })
    await advance(canvasRunChargeLastCheckMs - canvasRunChargeFirstCheckMs)
    expect(readUsage).toHaveBeenCalledTimes(2)
    expect(state.records.get('r1')?.charge).toMatchObject({ state: 'settled', usd: 0.06 })
    await advance(10 * 60_000)
    expect(readUsage).toHaveBeenCalledTimes(2)
  })

  it('says 待核对 rather than a guess when the records stay unreadable', async () => {
    const record = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    const { state, checker, readUsage, advance } = fixture({ records: [record], readUsage: async () => { throw new Error('网络不通') } })
    checker.schedule(record, 3)
    await advance(canvasRunChargeFirstCheckMs)
    expect(state.records.get('r1')?.charge).toBeUndefined()
    await advance(canvasRunChargeLastCheckMs)
    expect(readUsage).toHaveBeenCalledTimes(2)
    expect(state.records.get('r1')?.charge).toMatchObject({ state: 'unmatched', usd: 0, unmatchedAttempts: 1 })
  })

  it('treats an unknown dollar rate like unreadable records', async () => {
    const record = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    const { state, checker, readUsage, advance } = fixture({ records: [record], quotaPerUnit: null, logs: [{ requestId: 'req-1', quota: 30_000, model: 'gpt-image-2' }] })
    checker.schedule(record, 3)
    await advance(canvasRunChargeLastCheckMs)
    expect(readUsage).not.toHaveBeenCalled()
    expect(state.records.get('r1')?.charge).toMatchObject({ state: 'unmatched', usd: 0 })
  })

  it('reads nothing for a run with no paid request, or for another account', async () => {
    const free = run('free', [{ nodeId: 'a', kind: 'text', attempts: [attempt('a1')] }])
    const theirs = run('theirs', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }], 8)
    const { checker, readUsage, saveRun, advance } = fixture({ records: [free, theirs] })
    checker.schedule(free, 3)
    checker.schedule(theirs, 3)
    await advance(canvasRunChargeLastCheckMs)
    expect(readUsage).not.toHaveBeenCalled()
    expect(saveRun).not.toHaveBeenCalled()
  })

  it('drops what it read when the account changed while it was reading', async () => {
    const record = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    let reading!: () => void
    const { state, checker, saveRun, advance } = fixture({
      records: [record],
      readUsage: () => new Promise((resolve) => { reading = () => resolve({ records: [{ requestId: 'req-1', quota: 30_000, type: 2 }], total: 1 }) }),
    })
    checker.schedule(record, 3)
    const checking = advance(canvasRunChargeFirstCheckMs)
    await vi.waitFor(() => expect(reading).toBeTypeOf('function'))
    state.account = { userId: 7, key: 'r2:7' }
    reading()
    await checking
    expect(saveRun).not.toHaveBeenCalled()
  })

  it('stops paging once every request is found and never reads more than three pages of one model', async () => {
    const record = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1', 'lost'] } })] }])
    const logs = [{ requestId: 'req-1', quota: 30_000, model: 'gpt-image-2' }, ...Array.from({ length: 500 }, (_, index) => ({ requestId: `cli-${index}`, quota: 1, model: 'gpt-image-2' }))]
    const { checker, readUsage, advance } = fixture({ records: [record], logs })
    checker.schedule(record, 3)
    await advance(canvasRunChargeFirstCheckMs)
    expect(readUsage).toHaveBeenCalledTimes(3)
    expect(readUsage.mock.calls.map((call) => call[0].page)).toEqual([1, 2, 3])

    const found = run('r2', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    const second = fixture({ records: [found], logs })
    second.checker.schedule(found, 3)
    await second.advance(canvasRunChargeFirstCheckMs)
    expect(second.readUsage).toHaveBeenCalledTimes(1)
  })

  it('ignores refunds and other record types under a matching id', async () => {
    const record = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    const { state, checker, advance } = fixture({ records: [record], logs: [{ requestId: 'req-1', quota: 30_000, model: 'gpt-image-2', type: 6 }] })
    checker.schedule(record, 3)
    await advance(canvasRunChargeLastCheckMs)
    expect(state.records.get('r1')?.charge).toMatchObject({ state: 'unmatched' })
  })

  it('drops the checks waiting when cleared and still checks runs that end afterwards', async () => {
    const first = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    const second = run('r2', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-2'] } })] }])
    const { state, checker, readUsage, published, advance } = fixture({
      records: [first, second],
      logs: [{ requestId: 'req-1', quota: 30_000, model: 'gpt-image-2' }, { requestId: 'req-2', quota: 30_000, model: 'gpt-image-2' }],
    })
    checker.schedule(first, 3)
    checker.clear()
    await advance(canvasRunChargeLastCheckMs)
    expect(readUsage).not.toHaveBeenCalled()
    // The run service clears the checker on every account change, the first
    // sign-in included, and keeps running the canvas afterwards.
    checker.schedule(second, 3)
    await advance(canvasRunChargeFirstCheckMs)
    expect(readUsage).toHaveBeenCalledOnce()
    expect(state.records.get('r1')?.charge).toBeUndefined()
    expect(state.records.get('r2')?.charge).toMatchObject({ state: 'settled', usd: 0.06 })
    expect(published.map((entry) => entry.event.runId)).toEqual(['r2'])
  })

  it('writes nothing from a check that was under way when cleared', async () => {
    const record = run('r1', [{ nodeId: 'a', attempts: [attempt('a1', { relayBilling: { requestIds: ['req-1'] } })] }])
    let reading!: () => void
    const { checker, saveRun, published, advance } = fixture({
      records: [record],
      readUsage: () => new Promise((resolve) => { reading = () => resolve({ records: [{ requestId: 'req-1', quota: 30_000, type: 2 }], total: 1 }) }),
    })
    checker.schedule(record, 3)
    const checking = advance(canvasRunChargeFirstCheckMs)
    await vi.waitFor(() => expect(reading).toBeTypeOf('function'))
    checker.clear()
    reading()
    await checking
    expect(saveRun).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })
})
