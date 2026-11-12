import type { AiRelayBillingObserver } from './ai-operation-progress'
import type {
  CanvasRunAttempt,
  CanvasRunAttemptCharge,
  CanvasRunCharge,
  CanvasRunChargeEvent,
  CanvasRunNodeKind,
  CanvasRunRecord,
  CanvasRunRelayBilling,
} from './canvas-run-contract'
import { canvasRunContractVersion } from './canvas-run-contract'

// 跑完写实扣（画布完善第 2b 条第 3 步）。主进程收到付费请求的回应时记下站点回的请求号，运行结束
// 几秒后到这个账号自己的用量记录里按请求号对出扣了多少，写进运行记录。对不上的写「待核对」，
// 绝不拿预计冒充实扣。只看星芒账号：历史账号的用量记录不按请求号记。

/** First look at the usage records after a run ends: the relay writes them once the answer is out. */
export const canvasRunChargeFirstCheckMs = 6_000
/** Second and last look, for requests not in the records yet the first time. */
export const canvasRunChargeLastCheckMs = 40_000
/** Runs ending this close to a check share it. */
const checkJoinWindowMs = 3_000
const maximumRequestIdsPerAttempt = 8
const maximumQueuedRuns = 64
const maximumModelsPerCheck = 8
const maximumPagesPerModel = 3
const maximumReadsPerCheck = 12
const usagePageSize = 100
/** Slack around the run's own time span when asking for its usage records. */
const usageWindowSlackSeconds = 60
/** new-api Log.Type for a charge. Refunds (6) carry their own random request ids, so they never match. */
const consumeLogType = 2

export interface CanvasRelayBillingRecorder {
  observer: AiRelayBillingObserver
  /** What went out so far; undefined when no request has left. */
  snapshot(): CanvasRunRelayBilling | undefined
}

/**
 * Collects one attempt's request ids. A request that left and never got an
 * answer is remembered as unanswered: it may have been charged, and there is
 * no id to look it up by.
 */
export function createCanvasRelayBillingRecorder(): CanvasRelayBillingRecorder {
  const requestIds: string[] = []
  let inFlight = false
  let unidentified = false
  return {
    observer: {
      onRelayDispatch(sent) {
        inFlight = sent
      },
      onRelayAnswer(relayRequestId) {
        inFlight = false
        if (!relayRequestId || (!requestIds.includes(relayRequestId) && requestIds.length >= maximumRequestIdsPerAttempt)) {
          unidentified = true
          return
        }
        if (!requestIds.includes(relayRequestId)) requestIds.push(relayRequestId)
      },
    },
    snapshot() {
      if (requestIds.length === 0 && !inFlight && !unidentified) return undefined
      return {
        requestIds: [...requestIds],
        ...(inFlight ? { unanswered: true as const } : {}),
        ...(unidentified ? { unidentified: true as const } : {}),
      }
    },
  }
}

function isVideoKind(kind: CanvasRunNodeKind): boolean {
  return kind === 'video' || kind === 'video-generate'
}

interface PaidAttempt {
  nodeId: string
  kind: CanvasRunNodeKind
  attempt: CanvasRunAttempt & { relayBilling: CanvasRunRelayBilling }
}

function paidAttempts(record: CanvasRunRecord): PaidAttempt[] {
  return record.nodes.flatMap((node) => node.attempts
    .filter((attempt): attempt is PaidAttempt['attempt'] => !attempt.cached && attempt.relayBilling !== undefined)
    .map((attempt) => ({ nodeId: node.nodeId, kind: node.kind, attempt })))
}

/** Every request id a finished run is waiting on, by the model it was sent for. */
export function canvasRunChargeRequestIds(record: CanvasRunRecord): Map<string, string[]> {
  const byModel = new Map<string, string[]>()
  for (const { attempt } of paidAttempts(record)) {
    if (attempt.relayBilling.requestIds.length === 0) continue
    const model = attempt.model ?? ''
    byModel.set(model, [...(byModel.get(model) ?? []), ...attempt.relayBilling.requestIds])
  }
  return byModel
}

export interface CanvasRunChargeSettlement {
  charge: CanvasRunCharge
  attempts: { nodeId: string; attemptId: string; charge: CanvasRunAttemptCharge }[]
}

/**
 * Matches every paid attempt of a finished run against the usage records.
 *
 * `found` maps a request id to the quota charged under it; null means the
 * records could not be read, which leaves every paid attempt 待核对. A request
 * id missing from them answers 'pending' until `final`; then a failed or
 * stopped attempt was not charged (the relay answered and wrote no charge) and
 * a succeeded one is 待核对. Video is an estimate even when matched: the relay
 * settles a task once it finishes and may refund or charge the difference
 * under a new request id, and a failed video's charge may still be refunded.
 * Null when nothing in the run left as a paid request.
 */
export function settleCanvasRunCharges(
  record: CanvasRunRecord,
  found: ReadonlyMap<string, number> | null,
  quotaPerUnit: number,
  options: { final: boolean; checkedAt: string },
): CanvasRunChargeSettlement | 'pending' | null {
  const paid = paidAttempts(record)
  if (paid.length === 0) return null
  const attempts: CanvasRunChargeSettlement['attempts'] = []
  for (const { nodeId, kind, attempt } of paid) {
    const billing = attempt.relayBilling
    if (!found) {
      attempts.push({ nodeId, attemptId: attempt.attemptId, charge: { state: 'unmatched', usd: 0 } })
      continue
    }
    let quota = 0
    let missing = 0
    for (const requestId of billing.requestIds) {
      const charged = found.get(requestId)
      if (charged === undefined) missing += 1
      else quota += charged
    }
    if (missing > 0 && !options.final) return 'pending'
    const succeeded = attempt.state === 'succeeded'
    const video = isVideoKind(kind)
    const unmatched = Boolean(billing.unanswered || billing.unidentified)
      || (missing > 0 && succeeded)
      || (video && !succeeded && quota > 0)
    attempts.push({
      nodeId,
      attemptId: attempt.attemptId,
      charge: {
        state: unmatched ? 'unmatched' : 'settled',
        usd: quota / quotaPerUnit,
        ...(video && quota > 0 ? { approximate: true as const } : {}),
      },
    })
  }
  const unmatchedAttempts = attempts.filter((entry) => entry.charge.state === 'unmatched').length
  return {
    charge: {
      state: unmatchedAttempts > 0 ? 'unmatched' : 'settled',
      usd: attempts.reduce((total, entry) => total + entry.charge.usd, 0),
      unmatchedAttempts,
      ...(attempts.some((entry) => entry.charge.approximate) ? { approximate: true as const } : {}),
      checkedAt: options.checkedAt,
    },
    attempts,
  }
}

/** Writes a settlement into the record it was computed from; false when the record no longer fits it. */
export function applyCanvasRunCharges(record: CanvasRunRecord, settlement: CanvasRunChargeSettlement): boolean {
  const attemptsById = new Map(record.nodes.flatMap((node) => node.attempts.map((attempt) => [`${node.nodeId}\u0000${attempt.attemptId}`, attempt] as const)))
  const targets = settlement.attempts.map((entry) => attemptsById.get(`${entry.nodeId}\u0000${entry.attemptId}`))
  if (targets.some((attempt) => !attempt)) return false
  settlement.attempts.forEach((entry, index) => { targets[index]!.charge = { ...entry.charge } })
  record.charge = { ...settlement.charge }
  return true
}

export interface CanvasRunUsagePage {
  records: { requestId: string; quota: number; type: number }[]
  total: number
}

export interface CanvasRunChargeCheckerOptions {
  /**
   * The signed-in 星芒 account now; null when nobody is or the account's usage
   * records do not carry request ids. The key changes whenever the account does.
   */
  current(): { userId: number; key: string } | null
  /** One page (newest first) of the account's charge records for one model between two Unix-second bounds. */
  readUsage(query: { startTimestamp: number; endTimestamp: number; modelName: string; page: number; pageSize: number }): Promise<CanvasRunUsagePage>
  /** Quota per dollar for this account's site; null when it cannot be told. */
  readQuotaPerUnit(): Promise<number | null>
  getRun(userId: number, runId: string): Promise<CanvasRunRecord | null>
  saveRun(userId: number, record: CanvasRunRecord): Promise<void>
  publish(event: CanvasRunChargeEvent, userId: number, ownerId: number): void | Promise<void>
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
  firstCheckMs?: number
  lastCheckMs?: number
}

interface QueuedRun {
  userId: number
  ownerId: number
  runId: string
  dueAt: number
  final: boolean
}

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  const timer = setTimeout(callback, delayMs)
  // A pending check must never keep the app from quitting.
  timer.unref?.()
  return timer
}

function defaultClearTimer(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>)
}

/**
 * Checks finished runs' charges in batches: runs that end close together share
 * one look at the usage records, a run gets at most two looks, and one look
 * reads at most a dozen pages. The canvas has no say in any of it: nothing
 * here is reachable from the canvas window.
 */
export function createCanvasRunChargeChecker(options: CanvasRunChargeCheckerOptions) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer = options.clearTimer ?? defaultClearTimer
  const firstCheckMs = options.firstCheckMs ?? canvasRunChargeFirstCheckMs
  const lastCheckMs = options.lastCheckMs ?? canvasRunChargeLastCheckMs
  const queue: QueuedRun[] = []
  let timer: { handle: unknown; at: number } | null = null
  let checking: Promise<void> | null = null
  // Bumped by clear(): a check that began before it writes nothing.
  let generation = 0

  function arm(): void {
    if (checking || queue.length === 0) return
    const at = Math.min(...queue.map((entry) => entry.dueAt))
    if (timer && timer.at <= at) return
    if (timer) clearTimer(timer.handle)
    timer = { handle: setTimer(() => { timer = null; void check() }, Math.max(0, at - now())), at }
  }

  function enqueue(entry: QueuedRun): void {
    if (queue.some((queued) => queued.userId === entry.userId && queued.runId === entry.runId)) return
    if (queue.length >= maximumQueuedRuns) return
    queue.push(entry)
  }

  async function readFound(records: CanvasRunRecord[]): Promise<Map<string, number>> {
    const wanted = new Map<string, Set<string>>()
    for (const record of records) {
      for (const [model, ids] of canvasRunChargeRequestIds(record)) {
        const set = wanted.get(model) ?? new Set<string>()
        for (const id of ids) set.add(id)
        wanted.set(model, set)
      }
    }
    const found = new Map<string, number>()
    if (wanted.size === 0) return found
    const startedAt = Math.min(...records.map((record) => Date.parse(record.startedAt)))
    const startTimestamp = Math.floor(startedAt / 1_000) - usageWindowSlackSeconds
    const endTimestamp = Math.ceil(now() / 1_000) + usageWindowSlackSeconds
    let reads = 0
    for (const [model, ids] of [...wanted].slice(0, maximumModelsPerCheck)) {
      if (!model) continue
      for (let page = 1; page <= maximumPagesPerModel && reads < maximumReadsPerCheck; page += 1) {
        reads += 1
        const answer = await options.readUsage({ startTimestamp, endTimestamp, modelName: model, page, pageSize: usagePageSize })
        for (const entry of answer.records) {
          if (entry.type !== consumeLogType || !ids.has(entry.requestId) || !Number.isFinite(entry.quota) || entry.quota < 0) continue
          found.set(entry.requestId, (found.get(entry.requestId) ?? 0) + entry.quota)
        }
        if ([...ids].every((id) => found.has(id)) || page * usagePageSize >= answer.total || answer.records.length < usagePageSize) break
      }
    }
    return found
  }

  async function settle(entry: QueuedRun, record: CanvasRunRecord, found: Map<string, number> | null, quotaPerUnit: number): Promise<void> {
    const settlement = settleCanvasRunCharges(record, found, quotaPerUnit, { final: entry.final, checkedAt: new Date(now()).toISOString() })
    if (settlement === null) return
    if (settlement === 'pending') {
      enqueue({ ...entry, dueAt: entry.dueAt - firstCheckMs + lastCheckMs, final: true })
      return
    }
    if (!applyCanvasRunCharges(record, settlement)) return
    await options.saveRun(entry.userId, record)
    await options.publish({
      version: canvasRunContractVersion,
      type: 'run-charge',
      runId: record.runId,
      graphRevision: record.graphRevision,
      sequence: (record.events.at(-1)?.sequence ?? 0) + 1,
      at: new Date(now()).toISOString(),
      charge: settlement.charge,
      attempts: settlement.attempts,
    }, entry.userId, entry.ownerId)
  }

  async function runCheck(): Promise<void> {
    const startedGeneration = generation
    const account = options.current()
    const dueBy = now() + checkJoinWindowMs
    const due: QueuedRun[] = []
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index]
      // Another account's run: its records are not the signed-in account's to read.
      if (!account || entry.userId !== account.userId) {
        if (entry.dueAt <= dueBy) queue.splice(index, 1)
        continue
      }
      if (entry.dueAt <= dueBy) due.push(...queue.splice(index, 1))
    }
    if (!account || due.length === 0) return
    const loaded: { entry: QueuedRun; record: CanvasRunRecord }[] = []
    for (const entry of due) {
      const record = await options.getRun(entry.userId, entry.runId).catch(() => null)
      if (record && record.status !== 'running' && !record.charge) loaded.push({ entry, record })
    }
    if (loaded.length === 0) return
    let found: Map<string, number> | null
    let quotaPerUnit: number | null = null
    try {
      quotaPerUnit = await options.readQuotaPerUnit()
      if (quotaPerUnit === null || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error('quota per unit unknown')
      found = await readFound(loaded.map((item) => item.record))
    } catch {
      found = null
    }
    // Answers read for an account that is gone by now say nothing about this one's runs.
    if (generation !== startedGeneration || options.current()?.key !== account.key) return
    for (const item of loaded) {
      if (generation !== startedGeneration) return
      if (found === null && !item.entry.final) {
        enqueue({ ...item.entry, dueAt: item.entry.dueAt - firstCheckMs + lastCheckMs, final: true })
        continue
      }
      try {
        await settle(item.entry, item.record, found, quotaPerUnit ?? 1)
      } catch {
        // A run whose charge cannot be saved keeps showing no 实扣 rather than a wrong one.
      }
    }
  }

  async function check(): Promise<void> {
    if (checking) return
    checking = runCheck().catch(() => undefined).finally(() => {
      checking = null
      arm()
    })
    await checking
  }

  return {
    /** Called once a run has its terminal record on disk. */
    schedule(run: Pick<CanvasRunRecord, 'userId' | 'runId'>, ownerId: number): void {
      enqueue({ userId: run.userId, ownerId, runId: run.runId, dueAt: now() + firstCheckMs, final: false })
      arm()
    },
    /** Settles once the check under way, if any, is done. */
    whenIdle: async (): Promise<void> => { await checking },
    /**
     * Drops the checks not made yet and makes the one under way write nothing.
     * Runs that end afterwards are checked as usual: the run service outlives
     * every sign-in (main.ts shuts it down on each account change, the first
     * sign-in included), so this must never stop the checker for good.
     */
    clear(): void {
      generation += 1
      if (timer) clearTimer(timer.handle)
      timer = null
      queue.length = 0
    },
  }
}

export type CanvasRunChargeChecker = ReturnType<typeof createCanvasRunChargeChecker>
