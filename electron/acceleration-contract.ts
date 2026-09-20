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

/**
 * Acceleration only takes over the OS proxy setting, so anything else holding
 * that setting -- another proxy client, a PAC script, a VPN with its own
 * virtual adapter -- decides where traffic actually goes once both are on. A
 * closed set rather than free text: the host reports what it found and the
 * renderer owns the wording, so a detection detail can never reach the screen
 * or the log as arbitrary text (I13).
 */
export const accelerationConflictKinds = ['system-proxy', 'proxy-auto-config', 'virtual-adapter'] as const
export type AccelerationConflictKind = (typeof accelerationConflictKinds)[number]

export const accelerationConflictDescriptions: Record<AccelerationConflictKind, string> = {
  'system-proxy': '系统代理已被其他程序设置',
  'proxy-auto-config': '系统正在使用自动代理脚本',
  'virtual-adapter': '检测到 VPN 虚拟网卡',
}

/** One sentence for every combination: the user's next step is the same. */
export const accelerationConflictNotice = '检测到其他代理或 VPN 正在运行，可能与加速互相干扰，建议先关闭后再连接。'

export function isAccelerationConflictKind(value: unknown): value is AccelerationConflictKind {
  return accelerationConflictKinds.some((kind) => kind === value)
}

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
  /** Present only when a start was refused for a conflict the user can override. */
  conflicts?: AccelerationConflictKind[]
}

export interface AccelerationApi {
  getAccelerationState(scope: string): Promise<AccelerationState>
  /** `ignoreConflicts` is the user answering the conflict warning with 仍然连接. */
  startAcceleration(scope: string, mode: AccelerationMode, lineId?: string, ignoreConflicts?: boolean): Promise<AccelerationState>
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
