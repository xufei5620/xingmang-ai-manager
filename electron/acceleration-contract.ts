/** Renderer-safe acceleration state; node credentials and tunnel configuration stay in the host. */
export const accelerationTrialSeconds = 20 * 60
export const accelerationBonusSeconds = 10 * 60
/**
 * 剩这么多时长时提醒一次。总共只有 20 分钟，提太早没意义；提示语里的「5 分钟」
 * 与这个数字是同一处来源，改这里那句话跟着变。
 */
export const accelerationExpiryWarningSeconds = 5 * 60
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

/**
 * Why an acceleration request never produced a state. Until this existed every
 * one of these collapsed into the same sentence on screen *and* in the log, so
 * a machine where acceleration could never work looked exactly like one that
 * needed a retry: a leftover helper still holding the OS proxy, a machine whose
 * policy forbids the helper from taking the proxy lock, and a corrupt local
 * allowance all read as「加速服务暂不可用，请稍后重试」.
 *
 * A closed set rather than the underlying error text, for the same reason the
 * start-failure stages are one (see `AccelerationStartFailureStage`): the
 * worker is the only process allowed to see errors that can carry a private
 * path or proxy detail, and the renderer owns the wording (I13).
 */
export const accelerationFailureReasons = [
  'helper-temp',
  'helper-launch',
  'helper-timeout',
  'helper-data',
  'proxy-owned',
  'proxy-locked',
  'proxy-restore',
  'local-data',
  'unknown',
] as const
export type AccelerationFailureReason = (typeof accelerationFailureReasons)[number]

export function isAccelerationFailureReason(value: unknown): value is AccelerationFailureReason {
  return accelerationFailureReasons.some((reason) => reason === value)
}

/** 每句都要说清「是什么」和「下一步做什么」，因为界面上只有这一行。 */
export const accelerationFailureMessages: Record<AccelerationFailureReason, string> = {
  // 2026-09-22 真实客户机：辅助进程的独立工作目录建不出来，读状态永远失败，而界面
  // 与日志都只说「加速服务暂不可用」——具体是临时文件夹不在、不可写还是被工具搬走了，
  // 当时一个字都查不到。这条提示存在的意义就是把那句话换成用户能动手的一步。
  'helper-temp': '系统临时文件夹不可用，加速组件无法启动。请检查该文件夹是否存在、能否写入，以及是否被工具搬到了别的位置。',
  'helper-launch': '加速组件没能启动，请完全退出软件（含托盘图标）后重新打开；若仍不行，请在安全软件里放行本软件。',
  'helper-timeout': '加速组件响应超时，请稍后重试；若反复如此，请完全退出软件后重新打开。',
  'helper-data': '本机加速数据目录不可用，请检查磁盘剩余空间与该目录的访问权限后重试。',
  'proxy-owned': '上次加速还没有完全退出，仍占用着本机网络设置。请完全退出软件（含托盘图标）后重新打开。',
  'proxy-locked': '本机系统策略限制，加速无法修改网络设置。请联系电脑管理员放行本软件后重试。',
  'proxy-restore': '上次加速的网络设置还没有还原完成，请稍后重试；若仍不行，请完全退出软件后重新打开。',
  'local-data': '本机免费时长记录读写失败，请检查磁盘剩余空间与本地数据目录后重试。',
  // 认不出的原因保留原来那句话：它现在只覆盖真正没归类的失败。
  unknown: '加速服务暂不可用，请稍后重试。',
}

export interface AccelerationFailure extends Error {
  accelerationReason: AccelerationFailureReason
}

export function accelerationFailure(reason: AccelerationFailureReason): AccelerationFailure {
  return withAccelerationReason(new Error(accelerationFailureMessages[reason]), reason)
}

/** Tags an error the host already worded for its own callers, so the service
 *  above it can pick the user-facing sentence without re-reading that text. */
export function withAccelerationReason<T extends Error>(error: T, reason: AccelerationFailureReason): T & AccelerationFailure {
  // Non-enumerable so the reason never rides along into a serialized error; the
  // log records it as its own field, written by whoever classified the failure.
  Object.defineProperty(error, 'accelerationReason', { value: reason, enumerable: false, configurable: true })
  return error as T & AccelerationFailure
}

/** Only a reason this build authored survives; anything else is not ours. */
export function accelerationFailureReason(error: unknown): AccelerationFailureReason | null {
  if (!(error instanceof Error)) return null
  const reason = (error as Partial<AccelerationFailure>).accelerationReason
  return isAccelerationFailureReason(reason) ? reason : null
}

/**
 * 线路 id 的取值范围与 acceleration-service.ts 的 assertLineId 同一条：后端给的
 * id 会原样进入落盘的偏好文件，所以偏好这一侧必须用同一把尺子量一次（I5）。
 */
export function isAccelerationLineId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z\d_.-]{1,80}$/i.test(value)
}

/**
 * 用户在加速页上亲手选过的线路与模式。`lineId: null` 是「选了智能分配」，与
 * 「从没选过」对连接来说等价，落盘由 acceleration-preference-store.ts 负责。
 */
export interface AccelerationPreference {
  lineId: string | null
  mode: AccelerationMode
}

/** 按字段更新：线路与模式分别由两处界面写入，缺省字段保留已存的那一半。 */
export interface AccelerationPreferenceUpdate {
  lineId?: string | null
  mode?: AccelerationMode
}

export interface AccelerationPreferenceApi {
  getAccelerationPreference(scope: string): Promise<AccelerationPreference>
  saveAccelerationPreference(scope: string, update: AccelerationPreferenceUpdate): Promise<AccelerationPreference>
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
