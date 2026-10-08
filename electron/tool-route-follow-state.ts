import path from 'node:path'
import { providerIds, type ProviderId } from './catalog'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

/**
 * 换线路定点改写（xm 三线路 C9、C10）要跨重启记住的几件事，每个工具一份。只记指纹和时间，
 * 不记地址和 Key。读坏了、版本不认识都当没有：最坏是多留一份原件备份、多弹一次重开提示。
 */
export interface ToolRouteFollowRecord {
  /** 上一次定点改写之前那份配置的指纹（tool-config-ownership.ts 的 toolConfigIdentity）。又变回它 = 被外部改回。 */
  revertIdentity?: string
  /** 被外部改回的时间（毫秒），只留 24 小时内的。 */
  reverts?: number[]
  /** 24 小时内被改回两次：不再自动改它，首页标「由其他工具管理」。客户自己保存一次就清掉。 */
  managedElsewhere?: boolean
  /** 第一次定点改写之前已经整套备份过（「备份」页里那份就是迁移前原件）。 */
  originalKept?: boolean
  /** 上一次为它弹重开提示的时间（毫秒）。 */
  hintAt?: number
}

export interface ToolRouteFollowState {
  version: 1
  providers: Partial<Record<ProviderId, ToolRouteFollowRecord>>
}

const maximumStateBytes = 16 * 1024
export const toolRouteRevertWindowMs = 24 * 60 * 60 * 1000
/** 24 小时内被改回几次就不再自动改。 */
export const toolRouteRevertLimit = 2
export const toolRouteHintIntervalMs = 24 * 60 * 60 * 1000
/** 暂时性失败（文件被占用、IO 错误、写后回读不一致）每 5 分钟重试一次，最多 12 次。 */
export const toolRouteRetryDelayMs = 5 * 60 * 1000
export const toolRouteRetryLimit = 12

export function emptyToolRouteFollowState(): ToolRouteFollowState {
  return { version: 1, providers: {} }
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseRecord(value: unknown): ToolRouteFollowRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const parsed: ToolRouteFollowRecord = {}
  if (typeof record.revertIdentity === 'string' && /^[0-9a-f]{64}$/.test(record.revertIdentity)) parsed.revertIdentity = record.revertIdentity
  if (Array.isArray(record.reverts)) {
    const reverts = record.reverts.filter(finiteTimestamp).slice(-toolRouteRevertLimit)
    if (reverts.length) parsed.reverts = reverts
  }
  if (record.managedElsewhere === true) parsed.managedElsewhere = true
  if (record.originalKept === true) parsed.originalKept = true
  if (finiteTimestamp(record.hintAt)) parsed.hintAt = record.hintAt
  return parsed
}

export function parseToolRouteFollowState(raw: unknown): ToolRouteFollowState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyToolRouteFollowState()
  const value = raw as Record<string, unknown>
  if (value.version !== 1 || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
    return emptyToolRouteFollowState()
  }
  const providers: ToolRouteFollowState['providers'] = {}
  for (const provider of providerIds) {
    const record = parseRecord((value.providers as Record<string, unknown>)[provider])
    if (record) providers[provider] = record
  }
  return { version: 1, providers }
}

/**
 * 记一次被外部改回，返回新的记录。24 小时内第二次就标成「由其他工具管理」：多半是 cc-switch
 * 这类配置管理器在替客户维护这份配置，星芒再改只会和它来回拉锯。
 */
export function recordToolRouteRevert(record: ToolRouteFollowRecord, now: number): ToolRouteFollowRecord {
  const reverts = [...(record.reverts ?? []).filter((at) => now - at < toolRouteRevertWindowMs && at <= now), now]
    .slice(-toolRouteRevertLimit)
  return {
    ...record,
    reverts,
    ...(reverts.length >= toolRouteRevertLimit ? { managedElsewhere: true } : {}),
  }
}

/** 这个工具的重开提示 24 小时内弹过没有。 */
export function toolRouteHintDue(record: ToolRouteFollowRecord | undefined, now: number): boolean {
  const at = record?.hintAt
  return at === undefined || at > now || now - at >= toolRouteHintIntervalMs
}

/** 第几次重试之后还要不要再排一次；attempts 是已经失败的次数。 */
export function toolRouteRetryAllowed(attempts: number): boolean {
  return attempts < toolRouteRetryLimit
}

export interface ToolRouteFollowStore {
  read(): ToolRouteFollowState
  write(state: ToolRouteFollowState): Promise<void>
}

export function createToolRouteFollowStore(directory: string): ToolRouteFollowStore {
  const file = path.join(directory, 'tool-route-follow.json')
  return {
    read() {
      try {
        const raw = readSafeUtf8FileSync(file, '工具线路跟随记录', maximumStateBytes)
        return raw === null ? emptyToolRouteFollowState() : parseToolRouteFollowState(JSON.parse(raw))
      } catch {
        return emptyToolRouteFollowState()
      }
    },
    async write(state) {
      ensureSafeDataDirectory(directory, '工具线路跟随记录目录')
      await writeAtomicSafeUtf8File(file, `${JSON.stringify(parseToolRouteFollowState(state))}\n`, '工具线路跟随记录')
    },
  }
}
