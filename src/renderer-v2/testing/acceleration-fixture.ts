import { accelerationBonusSeconds, accelerationTrialSeconds, isAccelerationBonusCode, type AccelerationApi, type AccelerationLine, type AccelerationMode, type AccelerationPreference, type AccelerationPreferenceApi, type AccelerationState } from '../../../electron/acceleration-contract'

const legacyTrialMilliseconds = 60 * 60 * 1000

function readUsedMilliseconds(storage: Storage | undefined, scope: string, initialUsed: number): number {
  let saved: string | null | undefined
  let legacy: string | null | undefined
  try {
    saved = storage?.getItem(`xingmang-acceleration-preview:v2:${scope}`)
    if (saved == null) legacy = storage?.getItem(`xingmang-acceleration-preview:${scope}`)
  } catch { return initialUsed /* Preview remains usable when browser persistence is disabled. */ }
  try {
    if (saved != null) {
      const value: unknown = JSON.parse(saved)
      if (typeof value === 'object' && value !== null && 'version' in value && value.version === 2 && 'usedMilliseconds' in value
        && typeof value.usedMilliseconds === 'number' && Number.isFinite(value.usedMilliseconds) && value.usedMilliseconds >= 0) {
        return Math.max(initialUsed, value.usedMilliseconds)
      }
      return Math.max(initialUsed, accelerationTrialSeconds * 1000)
    }
    if (legacy != null) {
      const remaining = Number(legacy)
      if (Number.isFinite(remaining) && remaining >= 0 && remaining <= legacyTrialMilliseconds) {
        return Math.max(initialUsed, legacyTrialMilliseconds - remaining)
      }
      return Math.max(initialUsed, accelerationTrialSeconds * 1000)
    }
  } catch { return Math.max(initialUsed, accelerationTrialSeconds * 1000) }
  return initialUsed
}

/** Isolated interactive demo. It never opens a socket or changes the system network. */
export function createPreviewAccelerationApi({ remainingSeconds = accelerationTrialSeconds, storage }: { remainingSeconds?: number; storage?: Storage } = {}): AccelerationApi & AccelerationPreferenceApi {
  const lines: AccelerationLine[] = [{ id: 'preview-jp', name: '日本线路 1', region: 'JP', latencyMs: 188 }, { id: 'preview-sg', name: '新加坡线路 2', region: 'SG', latencyMs: 242 }, { id: 'preview-us', name: '美国线路 3', region: 'US', latencyMs: 356 }]
  const records = new Map<string, { remaining: number; used: number; bonus: number; startedAt: number | null; session: number; mode: AccelerationMode; lineId: string }>()
  // 线路与模式的偏好只活在这一次预览里，刻意不进 localStorage：免费时长要跨刷新
  // 才演得出来，而一条被记住的线路会让下一个用例从别人选过的状态开始。
  const preferences = new Map<string, AccelerationPreference>()
  function record(scope: string) {
    let current = records.get(scope)
    if (!current) {
      const initialRemaining = (Number.isFinite(remainingSeconds) ? Math.max(0, Math.min(accelerationTrialSeconds, remainingSeconds)) : 0) * 1000
      const used = readUsedMilliseconds(storage, scope, accelerationTrialSeconds * 1000 - initialRemaining)
      let bonus = 0
      try { if (storage?.getItem(`xingmang-acceleration-preview:bonus:${scope}`) === 'claimed') bonus = accelerationBonusSeconds } catch { /* Preview only. */ }
      const remaining = Math.max(0, (accelerationTrialSeconds + bonus) * 1000 - used)
      current = { remaining, used, bonus, startedAt: null, session: 0, mode: 'system-proxy', lineId: lines[0].id }
      records.set(scope, current)
    }
    return current
  }
  function state(scope: string): AccelerationState {
    const current = record(scope)
    const elapsed = current.startedAt === null ? 0 : Math.max(0, Date.now() - current.startedAt)
    const remaining = Math.max(0, current.remaining - elapsed)
    const session = current.session + Math.min(elapsed, current.remaining)
    const used = current.used + Math.min(elapsed, current.remaining)
    if (remaining === 0 && current.startedAt !== null) {
      current.remaining = 0; current.used = used; current.startedAt = null; current.session = session
    }
    try { storage?.setItem(`xingmang-acceleration-preview:v2:${scope}`, JSON.stringify({ version: 2, usedMilliseconds: used })) } catch { /* Preview only. */ }
    return { scope, phase: remaining === 0 ? 'exhausted' : current.startedAt === null ? 'idle' : 'active',
      mode: current.mode, totalSeconds: accelerationTrialSeconds + current.bonus, remainingSeconds: remaining / 1000, sessionSeconds: session / 1000,
      connectedAt: current.startedAt === null ? null : new Date(current.startedAt).toISOString(), measuredAt: new Date().toISOString(),
      line: current.startedAt === null ? null : lines.find(line => line.id === current.lineId) ?? lines[0], error: null }
  }
  return {
    async getAccelerationState(scope) { return state(scope) },
    async redeemAccelerationCode(scope, code) {
      const latest = state(scope)
      if (!isAccelerationBonusCode(code)) return { status: 'invalid-code', addedSeconds: 0, state: latest }
      const current = record(scope)
      if (current.bonus) return { status: 'already-redeemed', addedSeconds: 0, state: latest }
      current.bonus = accelerationBonusSeconds
      current.remaining += accelerationBonusSeconds * 1000
      try { storage?.setItem(`xingmang-acceleration-preview:bonus:${scope}`, 'claimed') } catch { /* Preview only. */ }
      return { status: 'redeemed', addedSeconds: accelerationBonusSeconds, state: state(scope) }
    },
    async startAcceleration(scope, mode, lineId) {
      const current = record(scope)
      if (state(scope).remainingSeconds === 0) return state(scope)
      if (current.startedAt === null) {
        current.startedAt = Date.now(); current.session = 0; current.mode = mode; current.lineId = lines.find(line => line.id === lineId)?.id ?? lines[0].id
      }
      return state(scope)
    },
    async listAccelerationLines() { return lines.map(line => ({ ...line })) },
    async getAccelerationPreference(scope) { return preferences.get(scope) ?? { lineId: null, mode: 'system-proxy' } },
    async saveAccelerationPreference(scope, update) {
      const base = preferences.get(scope) ?? { lineId: null, mode: 'system-proxy' as const }
      const next = { lineId: update.lineId === undefined ? base.lineId : update.lineId, mode: update.mode ?? base.mode }
      preferences.set(scope, next)
      return next
    },
    async pingAccelerationLine(_scope, lineId) {
      const line = lines.find(item => item.id === lineId)
      if (!line) throw new Error('加速线路不存在。')
      return { ...line }
    },
    async stopAcceleration(scope) {
      const latest = state(scope)
      const current = record(scope)
      current.used += current.remaining - (latest.remainingSeconds ?? 0) * 1000
      current.remaining = (latest.remainingSeconds ?? 0) * 1000
      current.session = latest.sessionSeconds * 1000
      current.startedAt = null
      return state(scope)
    },
  }
}
