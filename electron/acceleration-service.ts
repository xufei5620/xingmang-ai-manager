import type { AccelerationApi, AccelerationBundleCheck, AccelerationConflictKind, AccelerationLine, AccelerationMode, AccelerationPhase, AccelerationPreference, AccelerationPreferenceApi, AccelerationPreferenceUpdate, AccelerationRedemptionResult, AccelerationState, AccelerationUnavailableReason } from './acceleration-contract'
import { accelerationBonusSeconds, accelerationConflictKinds, accelerationFailure, accelerationFailureMessages, accelerationFailureReason, accelerationTrialSeconds, isAccelerationConflictKind, isAccelerationLineId } from './acceleration-contract'

export interface AccelerationService extends AccelerationApi, AccelerationPreferenceApi {
  redeemAccelerationCode(scope: string, code: string): Promise<AccelerationRedemptionResult>
  listAccelerationLines(scope: string): Promise<AccelerationLine[]>
  pingAccelerationLine(scope: string, lineId: string): Promise<AccelerationLine>
  /**
   * 用户在加速页或托盘上点的「停止」。连着的若是软件替他在后台连的那一次（他在
   * 加速页上看不见它），原样留着：那一次什么时候断归 codex-desktop-acceleration.ts 管。
   * 与 stopAcceleration 在同一条队列里先读后停，中间插不进别的连接。
   */
  stopUserAcceleration(scope: string): Promise<AccelerationState>
  /**
   * 只断软件替他连的那一次（认 connectedAt）。到点要断时他可能刚点了「开始加速」，
   * 连着的已经是他计时的那一次，那就原样留着。同样在队列里先读后停。
   */
  stopAutomaticAcceleration(scope: string, connectedAt: string): Promise<AccelerationState>
  /**
   * 软件替用户发起的连接（打开 Codex 桌面端时）。与 startAcceleration 走同一条
   * 路，只多记一笔「这次是谁连的」，此后这次会话的每一份状态都带上
   * `autoStartedBy`。刻意不进 AccelerationApi：渲染层没有通道能冒充这个来源。
   */
  startAutomaticAcceleration(scope: string, origin: NonNullable<AccelerationState['autoStartedBy']>, mode: AccelerationMode, lineId?: string): Promise<AccelerationState>
  /** Host lifecycle barrier; also drains sessions whose account has already expired. */
  stopAll(): Promise<void>
  /**
   * 有没有可能还连着的加速会话（连上了、正在连或上次没停干净）。Windows 关机时
   * 据此决定要不要推迟关机、先把系统代理还原；只读内存，不碰后台进程。
   */
  hasPossibleSession(): boolean
  onAccountChanged(): Promise<void>
  dispose(): Promise<void>
}

interface AccelerationServiceOptions {
  getAccountScope: () => string | null
  /**
   * `startAutomaticAcceleration` 是软件替用户连的那种：不扣免费时长。没有它的后端
   * （测试替身）退回普通连接，也就是旧行为。
   */
  backend?: AccelerationApi & {
    startAutomaticAcceleration?(scope: string, mode: AccelerationMode, lineId?: string): Promise<AccelerationState>
  }
  /**
   * 每产出一个状态就通知一次。托盘那一行（tray-acceleration.ts）靠它跟上加速页
   * 上的连接与断开，不必另起一套轮询；回调抛错不许影响本次请求的结果。
   */
  onState?: (state: AccelerationState) => void
  /**
   * 落盘的线路与模式偏好。刻意不走下面那条串行队列：它与连接无关，而队列里
   * 排着的可能是一次十几秒的连接，界面上点一下线路不该等它。
   */
  preferences?: AccelerationPreferenceApi
  /**
   * 启动时自带的加速文件就没读通（见 main.ts）。给了就把原因带进「开不了」的状态里，
   * 并提供「重新检查」；不给就是旧口径的「线路准备中」。
   */
  bundleDamaged?: { recheck(): Promise<AccelerationBundleCheck> }
}

const SERVICE_UNAVAILABLE = '加速线路暂未开通，请稍后再试。'
const INVALID_RESPONSE = '加速服务返回的数据无效，请稍后重试。'
const BACKEND_FAILURE = accelerationFailureMessages.unknown
const ACCOUNT_CHANGED = '账号已变更，请重新打开游戏加速。'
const BACKGROUND_BUSY = 'Codex 桌面端正在后台用加速，暂不能检测线路。'
const phases: readonly AccelerationPhase[] = ['unavailable', 'idle', 'connecting', 'active', 'stopping', 'exhausted', 'error']

function assertScope(scope: unknown): asserts scope is string {
  if (typeof scope !== 'string' || !/^(?:xm-account|api-account):[1-9]\d{0,15}$/.test(scope)
    || !Number.isSafeInteger(Number(scope.split(':')[1]))) {
    throw new Error('加速账号参数无效。')
  }
}

function assertMode(mode: unknown): asserts mode is AccelerationMode {
  if (mode !== 'system-proxy' && mode !== 'tun') throw new Error('加速模式无效。')
}

function assertIgnoreConflicts(value: unknown): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('加速冲突确认参数无效。')
}

function assertLineId(lineId: unknown): asserts lineId is string {
  if (!isAccelerationLineId(lineId)) throw new Error('加速线路参数无效。')
}

/** 渲染层来的偏好同样是敌意输入：只放行认识的字段与取值（I5）。 */
function parsePreferenceUpdate(value: unknown): AccelerationPreferenceUpdate {
  if (!isRecord(value)) throw new Error('加速线路偏好参数无效。')
  if (value.lineId !== undefined && value.lineId !== null) assertLineId(value.lineId)
  if (value.mode !== undefined) assertMode(value.mode)
  return {
    ...(value.lineId !== undefined ? { lineId: value.lineId as string | null } : {}),
    ...(value.mode !== undefined ? { mode: value.mode as AccelerationMode } : {}),
  }
}

/**
 * 这一层原来把每一种后端失败都收成 BACKEND_FAILURE 那一句话，界面和日志里都
 * 只剩它。2026-09-22 一台客户机因此花了整半天：辅助进程根本建不出临时目录，
 * 而日志里能看到的只有「加速服务暂不可用，请稍后重试。」，最后靠反编译压缩
 * 产物数字节才找到是哪一行。现在归类由下层给出（封闭集合，不是错误原文），
 * 这里只负责挑出对应的那句中文；认不出的仍旧是原来那句话。
 */
function backendFailure(error: unknown): Error {
  return accelerationFailure(accelerationFailureReason(error) ?? 'unknown')
}

const REDEMPTION_FAILURE = '加速时长这次没有加上，请稍后再输一次口令；还不行就联系客服。'

/**
 * 口令不对、已经领过是正常结果（见 projectRedemption），走到这里的都是本机没办成：
 * 时长记录写不进去、加速组件没起来之类。原来一律「兑换失败，请稍后重试」，客户以为
 * 是网络，反复重试也不会好。归类由下层给出，这里只挑句子，错误原文照旧不上屏（I13）。
 */
function redemptionFailure(error: unknown): Error {
  const reason = accelerationFailureReason(error)
  if (reason === 'local-data') return accelerationFailure(reason, '加速时长这次没有加上：本机的时长记录写不进去。请检查磁盘剩余空间后再输一次口令。')
  if (!reason || reason === 'unknown') return new Error(REDEMPTION_FAILURE)
  return accelerationFailure(reason, `加速时长这次没有加上：${accelerationFailureMessages[reason]}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000
}

function isPhase(value: unknown): value is AccelerationPhase {
  return typeof value === 'string' && phases.some((phase) => phase === value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function isDisplayText(value: unknown, maximumLength = 100): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f-\u009f]|:\/\/|\bsk-|\bbearer\s|(?:token|password|secret|key)\s*[:=]/i.test(value)
}

function isRunning(phase: AccelerationPhase): boolean {
  return phase === 'active' || phase === 'connecting' || phase === 'stopping'
}

function projectLine(value: unknown): AccelerationLine {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-z\d_.-]{1,80}$/i.test(value.id)
    || !isDisplayText(value.id) || !isDisplayText(value.name) || !isDisplayText(value.region)
    || (value.latencyMs !== null && (typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs)
      || value.latencyMs < 0 || value.latencyMs > 60_000))) throw new Error(INVALID_RESPONSE)
  return { id: value.id, name: value.name, region: value.region, latencyMs: value.latencyMs as number | null }
}

function projectLines(value: unknown): AccelerationLine[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error(INVALID_RESPONSE)
  const lines = value.map(projectLine)
  if (new Set(lines.map((line) => line.id)).size !== lines.length) throw new Error(INVALID_RESPONSE)
  return lines
}

/** Only allow display data across IPC; transport credentials must stay inside the backend. */
function projectState(value: unknown, scope: string): AccelerationState {
  if (!isRecord(value) || value.scope !== scope || !isPhase(value.phase)
    || (value.mode !== 'system-proxy' && value.mode !== 'tun')
    || !isSeconds(value.totalSeconds) || !isSeconds(value.sessionSeconds)
    || value.sessionSeconds > value.totalSeconds
    || (value.remainingSeconds !== null && (!isSeconds(value.remainingSeconds) || value.remainingSeconds > value.totalSeconds))
    || !isTimestamp(value.measuredAt) || (value.connectedAt !== null && !isTimestamp(value.connectedAt))
    || (value.error !== null && !isDisplayText(value.error, 300))) throw new Error(INVALID_RESPONSE)

  const phase = value.phase
  if (value.entitlementSource !== undefined && value.entitlementSource !== 'server'
    && value.entitlementSource !== 'local-device' && value.entitlementSource !== 'local-development') throw new Error(INVALID_RESPONSE)
  if (value.supportedModes !== undefined && (!Array.isArray(value.supportedModes) || !value.supportedModes.length
    || value.supportedModes.length > 2 || new Set(value.supportedModes).size !== value.supportedModes.length
    || value.supportedModes.some((mode) => mode !== 'system-proxy' && mode !== 'tun'))) throw new Error(INVALID_RESPONSE)
  if (value.autoStartedBy !== undefined && (value.autoStartedBy !== 'codex-desktop' || !isRunning(phase))) throw new Error(INVALID_RESPONSE)
  // 软件替用户连的会话不扣时长，免费时长用完（0）也照样连着。
  if (phase === 'active' && (value.connectedAt === null || value.remainingSeconds === null
    || (value.remainingSeconds === 0 && value.autoStartedBy === undefined))) {
    throw new Error(INVALID_RESPONSE)
  }
  if (phase === 'exhausted' && value.remainingSeconds !== 0) throw new Error(INVALID_RESPONSE)
  if (value.conflicts !== undefined && (!Array.isArray(value.conflicts) || !value.conflicts.length
    || value.conflicts.length > accelerationConflictKinds.length || new Set(value.conflicts).size !== value.conflicts.length
    || !value.conflicts.every(isAccelerationConflictKind))) throw new Error(INVALID_RESPONSE)
  let line: AccelerationState['line'] = null
  if (value.line !== null) {
    if (!isRecord(value.line) || typeof value.line.id !== 'string' || !/^[a-z\d_.-]{1,80}$/i.test(value.line.id)
      || !isDisplayText(value.line.id) || !isDisplayText(value.line.name) || !isDisplayText(value.line.region)
      || (value.line.latencyMs !== null && (typeof value.line.latencyMs !== 'number'
        || !Number.isFinite(value.line.latencyMs) || value.line.latencyMs < 0 || value.line.latencyMs > 60_000))) {
      throw new Error(INVALID_RESPONSE)
    }
    line = { id: value.line.id, name: value.line.name, region: value.line.region, latencyMs: value.line.latencyMs }
  }
  return {
    ...(value.entitlementSource === 'server' || value.entitlementSource === 'local-device' || value.entitlementSource === 'local-development' ? { entitlementSource: value.entitlementSource } : {}),
    ...(Array.isArray(value.supportedModes) ? { supportedModes: [...value.supportedModes] as AccelerationMode[] } : {}),
    ...(Array.isArray(value.conflicts) ? { conflicts: [...value.conflicts] as AccelerationConflictKind[] } : {}),
    ...(value.autoStartedBy === 'codex-desktop' ? { autoStartedBy: value.autoStartedBy } : {}),
    scope, phase, mode: value.mode, totalSeconds: value.totalSeconds, remainingSeconds: value.remainingSeconds,
    sessionSeconds: value.sessionSeconds, measuredAt: value.measuredAt, connectedAt: value.connectedAt, line, error: value.error,
  }
}

/**
 * 用户看得到的那一份状态（加速页、托盘）。yoyo 2026-10-02 定：软件替他在后台连的
 * 加速（打开 Codex 桌面端时）「不在游戏加速那边体现」。所以这一次会话在他眼里就是
 * 没连：未连接、剩余时长照旧（这次本来就不扣），时长用完的照旧显示用完。主进程里
 * 别的观察者（到期、意外断开、桌面端退出就断开、诊断）仍然读真实状态。
 */
export function userAccelerationState(state: AccelerationState): AccelerationState {
  if (!state.autoStartedBy) return state
  return {
    ...(state.entitlementSource ? { entitlementSource: state.entitlementSource } : {}),
    ...(state.supportedModes ? { supportedModes: [...state.supportedModes] } : {}),
    scope: state.scope, phase: state.remainingSeconds === 0 ? 'exhausted' : 'idle', mode: state.mode,
    totalSeconds: state.totalSeconds, remainingSeconds: state.remainingSeconds, sessionSeconds: 0,
    measuredAt: state.measuredAt, connectedAt: null, line: null, error: null,
  }
}

/**
 * 交给渲染层（IPC）和托盘的那一套：读到的、连接与停止返回的状态一律换成
 * userAccelerationState；停止走 stopUserAcceleration，不碰后台那一次。用户自己点
 * 「开始加速」时后台那一次正连着，由后端停掉它重新连一次计时的
 * （acceleration-development-backend.ts 的 startSession）。
 */
export function createUserAccelerationApi(service: AccelerationService): AccelerationApi & AccelerationPreferenceApi {
  const recheck = service.recheckAccelerationBundle
  return {
    getAccelerationState: (scope) => service.getAccelerationState(scope).then(userAccelerationState),
    startAcceleration: (scope, mode, lineId, ignoreConflicts) => service.startAcceleration(scope, mode, lineId, ignoreConflicts)
      .then(userAccelerationState),
    stopAcceleration: (scope) => service.stopUserAcceleration(scope).then(userAccelerationState),
    redeemAccelerationCode: (scope, code) => service.redeemAccelerationCode(scope, code)
      .then((result) => ({ ...result, state: userAccelerationState(result.state) })),
    listAccelerationLines: (scope) => service.listAccelerationLines(scope),
    pingAccelerationLine: (scope, lineId) => service.pingAccelerationLine(scope, lineId),
    getAccelerationPreference: (scope) => service.getAccelerationPreference(scope),
    saveAccelerationPreference: (scope, update) => service.saveAccelerationPreference(scope, update),
    ...(recheck ? { recheckAccelerationBundle: recheck } : {}),
  }
}

function defaultPreference(): AccelerationPreference {
  return { lineId: null, mode: 'system-proxy' }
}

function unavailableState(scope: string, reason?: AccelerationUnavailableReason): AccelerationState {
  return {
    scope, phase: 'unavailable', mode: 'system-proxy', totalSeconds: accelerationTrialSeconds, remainingSeconds: null,
    sessionSeconds: 0, measuredAt: new Date().toISOString(), connectedAt: null, line: null, error: null,
    ...(reason ? { unavailableReason: reason } : {}),
  }
}

function projectRedemption(value: unknown, scope: string): AccelerationRedemptionResult {
  if (!isRecord(value) || typeof value.status !== 'string' || !['redeemed', 'already-redeemed', 'invalid-code'].includes(value.status)
    || value.addedSeconds !== (value.status === 'redeemed' ? accelerationBonusSeconds : 0)) throw new Error(INVALID_RESPONSE)
  const state = projectState(value.state, scope)
  if (value.status === 'redeemed' && (state.remainingSeconds === null || state.totalSeconds < accelerationBonusSeconds)) {
    throw new Error(INVALID_RESPONSE)
  }
  return { status: value.status as AccelerationRedemptionResult['status'], addedSeconds: value.addedSeconds as number, state }
}

export function createAccelerationService(options: AccelerationServiceOptions): AccelerationService {
  const { backend, bundleDamaged } = options
  // Track a start before awaiting it: a failed/late response does not prove the tunnel never started.
  const possibleSessions = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()
  let lastMutation: { key: string; promise: Promise<AccelerationState> } | null = null
  let revision = 0
  let disposed = false
  let disposePromise: Promise<void> | null = null
  // 按账号记住「哪一次连接是软件替他连的」，认 connectedAt：重连就是另一次会话。
  const automaticSessions = new Map<string, { connectedAt: string; origin: NonNullable<AccelerationState['autoStartedBy']> }>()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  function assertCurrent(scope: string, expectedRevision: number): void {
    if (disposed) throw new Error('游戏加速服务已关闭。')
    if (options.getAccountScope() !== scope || expectedRevision !== revision) throw new Error(ACCOUNT_CHANGED)
  }

  function notify(state: AccelerationState): AccelerationState {
    try { options.onState?.(state) }
    catch { /* A listener must not turn a completed request into a failed one. */ }
    return state
  }

  function track(state: AccelerationState): void {
    if (isRunning(state.phase)) possibleSessions.add(state.scope)
    else possibleSessions.delete(state.scope)
  }

  /** 这次会话还在跑、且正是软件替他连上的那一次，才标出来源。 */
  function withOrigin(state: AccelerationState): AccelerationState {
    const automatic = automaticSessions.get(state.scope)
    if (!automatic) return state
    if (!isRunning(state.phase) || state.connectedAt !== automatic.connectedAt) {
      if (state.phase !== 'connecting') automaticSessions.delete(state.scope)
      return state
    }
    return { ...state, autoStartedBy: automatic.origin }
  }

  async function stopSession(scope: string): Promise<void> {
    if (!backend) return
    try {
      const state = projectState(await backend.stopAcceleration(scope), scope)
      if (isRunning(state.phase)) throw new Error(BACKEND_FAILURE)
      possibleSessions.delete(scope)
    } catch {
      // Retain failed stops so a later account change/dispose retries instead of forgetting a live tunnel.
      throw new Error('停止加速未完成，请稍后重试。')
    }
  }

  async function stopOtherAccounts(scope: string | null): Promise<void> {
    for (const previousScope of possibleSessions) {
      if (previousScope !== scope) await stopSession(previousScope)
    }
  }

  /** 后台那一次（软件替他连的）正连着没有。读不到按没有：只用来挑一句更准的提示。 */
  async function automaticSessionRunning(scope: string): Promise<boolean> {
    if (!backend) return false
    try { return Boolean(withOrigin(projectState(await backend.getAccelerationState(scope), scope)).autoStartedBy) }
    catch { return false }
  }

  function request(scope: string, operation: 'get' | 'start' | 'stop' | 'user-stop' | 'automatic-stop', mode?: AccelerationMode, lineId?: string, ignoreConflicts?: boolean,
    origin?: NonNullable<AccelerationState['autoStartedBy']>, connectedAt?: string): Promise<AccelerationState> {
    try {
      assertScope(scope)
      if (operation === 'start') assertMode(mode)
      if (lineId !== undefined) assertLineId(lineId)
      assertIgnoreConflicts(ignoreConflicts)
      assertCurrent(scope, revision)
    } catch (error) { return Promise.reject(error) }
    const expectedRevision = revision
    // A retry that overrides the conflict warning is a different request from
    // the one that raised it, so it must not be served the refusal in flight.
    const key = `${revision}:${scope}:${operation}:${mode ?? ''}:${lineId ?? ''}:${ignoreConflicts === true}:${origin ?? ''}:${connectedAt ?? ''}`
    if (operation !== 'get' && lastMutation?.key === key) return lastMutation.promise
    const promise = enqueue(async () => {
      await stopOtherAccounts(options.getAccountScope())
      assertCurrent(scope, expectedRevision)
      if (!backend) {
        if (operation === 'start') throw new Error(SERVICE_UNAVAILABLE)
        return notify(unavailableState(scope, bundleDamaged ? 'bundle-damaged' : undefined))
      }
      const wasRunning = possibleSessions.has(scope)
      if (operation === 'start') possibleSessions.add(scope)
      let state: AccelerationState
      try {
        let raw: unknown
        if (operation === 'start') {
          assertMode(mode)
          raw = origin && backend.startAutomaticAcceleration
            ? await backend.startAutomaticAcceleration(scope, mode, lineId)
            : await backend.startAcceleration(scope, mode, lineId, ignoreConflicts)
        } else if (operation === 'get') raw = await backend.getAccelerationState(scope)
        else if (operation === 'user-stop' || operation === 'automatic-stop') {
          const current = withOrigin(projectState(await backend.getAccelerationState(scope), scope))
          const automatic = Boolean(current.autoStartedBy)
          const keep = operation === 'user-stop' ? automatic : !automatic || current.connectedAt !== connectedAt
          raw = keep ? current : await backend.stopAcceleration(scope)
        } else raw = await backend.stopAcceleration(scope)
        state = projectState(raw, scope)
        if (operation === 'start' && state.mode !== mode) throw new Error(INVALID_RESPONSE)
        track(state)
        // 已经连着时 start 原样返回那次会话：那条线路归用户，不能因此改记成自动连的。
        if (operation === 'start' && origin && state.phase === 'active' && state.connectedAt
          && !wasRunning) {
          automaticSessions.set(scope, { connectedAt: state.connectedAt, origin })
        }
      } catch (error) {
        if (operation === 'start' || options.getAccountScope() !== scope || expectedRevision !== revision || disposed) {
          if (possibleSessions.has(scope)) await stopSession(scope)
        }
        throw backendFailure(error)
      }
      if (options.getAccountScope() !== scope || expectedRevision !== revision || disposed) {
        if (possibleSessions.has(scope)) await stopSession(scope)
        throw new Error(ACCOUNT_CHANGED)
      }
      return notify(withOrigin(state))
    })
    lastMutation = operation === 'get' ? null : { key, promise }
    void promise.finally(() => {
      if (lastMutation?.promise === promise) lastMutation = null
    }).catch(() => undefined)
    return promise
  }

  return {
    getAccelerationState: (scope) => request(scope, 'get'),
    startAcceleration: (scope, mode, lineId, ignoreConflicts) => request(scope, 'start', mode, lineId, ignoreConflicts),
    startAutomaticAcceleration: (scope, origin, mode, lineId) => request(scope, 'start', mode, lineId, false, origin),
    stopAcceleration: (scope) => request(scope, 'stop'),
    stopUserAcceleration: (scope) => request(scope, 'user-stop'),
    stopAutomaticAcceleration: (scope, connectedAt) => request(scope, 'automatic-stop', undefined, undefined, undefined, undefined, connectedAt),
    redeemAccelerationCode(scope, code) {
      try {
        assertScope(scope)
        if (typeof code !== 'string' || !code.trim() || code.length > 64) throw new Error('加速口令格式无效。')
        assertCurrent(scope, revision)
      } catch (error) { return Promise.reject(error) }
      const expectedRevision = revision
      return enqueue(async () => {
        await stopOtherAccounts(options.getAccountScope())
        assertCurrent(scope, expectedRevision)
        if (!backend?.redeemAccelerationCode) throw new Error(SERVICE_UNAVAILABLE)
        let result: AccelerationRedemptionResult
        try { result = projectRedemption(await backend.redeemAccelerationCode(scope, code), scope) }
        catch (error) {
          assertCurrent(scope, expectedRevision)
          throw redemptionFailure(error)
        }
        assertCurrent(scope, expectedRevision)
        track(result.state)
        const decorated = { ...result, state: withOrigin(result.state) }
        notify(decorated.state)
        return decorated
      })
    },
    listAccelerationLines(scope) {
      try { assertScope(scope); assertCurrent(scope, revision) } catch (error) { return Promise.reject(error) }
      const expectedRevision = revision
      return enqueue(async () => {
        assertCurrent(scope, expectedRevision)
        if (!backend?.listAccelerationLines) return []
        try {
          const lines = projectLines(await backend.listAccelerationLines(scope))
          assertCurrent(scope, expectedRevision)
          return lines
        } catch (error) { throw backendFailure(error) }
      })
    },
    pingAccelerationLine(scope, lineId) {
      try { assertScope(scope); assertLineId(lineId); assertCurrent(scope, revision) } catch (error) { return Promise.reject(error) }
      const expectedRevision = revision
      return enqueue(async () => {
        assertCurrent(scope, expectedRevision)
        if (!backend?.pingAccelerationLine) throw new Error(SERVICE_UNAVAILABLE)
        // 后台那一次占着内核时后端照样拒绝，但那句话到这里只剩「暂不可用」；加速页
        // 上又看不见它连着，所以照实说是谁占着。
        if (await automaticSessionRunning(scope)) throw new Error(BACKGROUND_BUSY)
        try {
          const line = projectLine(await backend.pingAccelerationLine(scope, lineId))
          if (line.id !== lineId) throw new Error(INVALID_RESPONSE)
          assertCurrent(scope, expectedRevision)
          return line
        } catch (error) { throw backendFailure(error) }
      })
    },
    // 线路和模式偏好决定了下次自动连接走哪条线，所以和其它加速操作一样只认当前登录的
    // 账号（#487）：界面传来别的已保存账号，或者退出、切换账号之后才到的旧请求，一律不读不写。
    getAccelerationPreference(scope) {
      try { assertScope(scope); assertCurrent(scope, revision) } catch (error) { return Promise.reject(error) }
      const expectedRevision = revision
      // 没有偏好存储时按「从没选过」回答：加速页照旧从智能分配 + 标准模式开始。
      return (options.preferences?.getAccelerationPreference(scope) ?? Promise.resolve(defaultPreference())).then((preference) => {
        assertCurrent(scope, expectedRevision)
        return preference
      })
    },
    saveAccelerationPreference(scope, update) {
      let parsed: AccelerationPreferenceUpdate
      try { assertScope(scope); assertCurrent(scope, revision); parsed = parsePreferenceUpdate(update) } catch (error) { return Promise.reject(error) }
      if (!options.preferences) return Promise.reject(new Error('加速线路偏好暂不可用，请稍后重试。'))
      return options.preferences.saveAccelerationPreference(scope, parsed)
    },
    ...(bundleDamaged ? { recheckAccelerationBundle: () => bundleDamaged.recheck() } : {}),
    hasPossibleSession() {
      return possibleSessions.size > 0
    },
    stopAll() {
      revision += 1
      lastMutation = null
      return enqueue(() => stopOtherAccounts(null))
    },
    onAccountChanged() {
      revision += 1
      lastMutation = null
      const nextScope = options.getAccountScope()
      return enqueue(() => stopOtherAccounts(nextScope))
    },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      revision += 1
      disposePromise = enqueue(() => stopOtherAccounts(null))
      void disposePromise.catch(() => { disposePromise = null })
      return disposePromise
    },
  }
}
