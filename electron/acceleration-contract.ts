/** Renderer-safe acceleration state; node credentials and tunnel configuration stay in the host. */
export const accelerationTrialSeconds = 20 * 60
export const accelerationBonusSeconds = 10 * 60
/** Hidden command-palette promotion; validated again by the host before crediting. */
export const accelerationBonusCode = 'XM-NEBULA-10M-7Q9K'
export function isAccelerationBonusCode(value: unknown): value is string {
  return typeof value === 'string' && value.trim().toUpperCase() === accelerationBonusCode
}

export type AccelerationPhase = 'unavailable' | 'idle' | 'connecting' | 'active' | 'stopping' | 'exhausted' | 'error'
export type AccelerationMode = 'system-proxy' | 'tun'

export interface AccelerationLine {
  id: string
  name: string
  region: string
  latencyMs: number | null
}

export interface AccelerationState {
  /** Local trials connect real nodes but do not grant a server entitlement. */
  entitlementSource?: 'server' | 'local-device' | 'local-development'
  supportedModes?: AccelerationMode[]
  scope: string
  phase: AccelerationPhase
  mode: AccelerationMode
  totalSeconds: number
  remainingSeconds: number | null
  sessionSeconds: number
  measuredAt: string
  connectedAt: string | null
  line: AccelerationLine | null
  error: string | null
}

export interface AccelerationApi {
  getAccelerationState(scope: string): Promise<AccelerationState>
  startAcceleration(scope: string, mode: AccelerationMode, lineId?: string): Promise<AccelerationState>
  stopAcceleration(scope: string): Promise<AccelerationState>
  /** A fixed promotion, claimed once per account in the device-local ledger. */
  redeemAccelerationCode?(scope: string, code: string): Promise<AccelerationRedemptionResult>
  /** Credential-free list of lines available to the current account. */
  listAccelerationLines?(scope: string): Promise<AccelerationLine[]>
  /** Measure a single line; credentials never leave the host. */
  pingAccelerationLine?(scope: string, lineId: string): Promise<AccelerationLine>
}

export interface AccelerationRedemptionResult {
  status: 'redeemed' | 'already-redeemed' | 'invalid-code'
  addedSeconds: number
  state: AccelerationState
}
