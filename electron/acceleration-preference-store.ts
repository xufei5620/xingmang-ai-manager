/**
 * 用户在加速页上选过的线路与模式，按账号 scope 落盘。
 *
 * 为什么要落盘：线路选择原来只活在渲染层内存里，软件一关就没了，托盘的「连接
 * 加速」与打开 Codex 桌面端时的自动连接因此只能一律用「智能分配 + 标准模式」
 * ——用户挑过的线路等于白挑。这个文件是那两条已有功能唯一缺的那一半。
 *
 * 两条取舍：
 * - **记的是用户亲手选的那一条，不是上次实际连上的那一条**。选了「智能分配」时
 *   后端会自己挑一条具体线路出来，那是后端的选择，不该被记成用户的偏好；所以
 *   `lineId: null` 是一个有效记录（「用户选过智能分配」），与「从没选过」只差在
 *   有没有这条记录，对连接来说两者等价。
 * - **读坏了就当没选过，绝不抛错**。这份数据丢了最多是少记一次偏好，而免费时长
 *   账本（acceleration-development-backend.ts）丢了是真金白银，所以那边校验失败
 *   要抛错，这边一律降级。
 *
 * 不含任何 Electron 依赖，路径由宿主注入，好让这一整套判断能脱离主进程单测。
 */
import path from 'node:path'
import { isAccelerationLineId, type AccelerationMode, type AccelerationPreference, type AccelerationPreferenceApi, type AccelerationPreferenceUpdate } from './acceleration-contract'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

const storeLabel = '加速线路偏好'
const writeFailure = '加速线路偏好保存失败，请检查本地数据目录后重试。'
const MAX_BYTES = 256 * 1024
/**
 * 一台机器上换过的账号不该无限堆着。超出时丢最早写入的那些：JSON 对象保留字符串
 * 键的插入顺序，每次保存都把当前账号挪到末尾，于是「最早写入」就是最前面那几条，
 * 不必再另存时间戳（也就不依赖时钟，测试里可复现）。
 */
const MAX_ACCOUNTS = 64

export const defaultAccelerationPreference: AccelerationPreference = { lineId: null, mode: 'system-proxy' }

export interface AccelerationPreferenceStore extends AccelerationPreferenceApi {
  /** 读不到、读坏了、没这个账号，都返回默认值。 */
  getAccelerationPreference(scope: string): Promise<AccelerationPreference>
  /** 按字段合并：线路与模式分别由两处界面写入，谁都不许覆盖对方那一半。 */
  saveAccelerationPreference(scope: string, update: AccelerationPreferenceUpdate): Promise<AccelerationPreference>
}

interface StoredPreferences {
  version: 1
  accounts: Record<string, AccelerationPreference>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseMode(value: unknown): AccelerationMode | null {
  return value === 'system-proxy' || value === 'tun' ? value : null
}

function parseEntry(value: unknown): AccelerationPreference | null {
  if (!isRecord(value)) return null
  const mode = parseMode(value.mode)
  if (!mode) return null
  if (value.lineId === null || value.lineId === undefined) return { lineId: null, mode }
  return isAccelerationLineId(value.lineId) ? { lineId: value.lineId, mode } : { lineId: null, mode }
}

function parseStored(content: string): StoredPreferences {
  const value: unknown = JSON.parse(content)
  const empty: StoredPreferences = { version: 1, accounts: Object.create(null) as Record<string, AccelerationPreference> }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.accounts)) return empty
  const accounts = Object.create(null) as Record<string, AccelerationPreference>
  for (const [scope, entry] of Object.entries(value.accounts).slice(-MAX_ACCOUNTS)) {
    const preference = parseEntry(entry)
    if (preference) accounts[scope] = preference
  }
  return { version: 1, accounts }
}

function mergePreference(base: AccelerationPreference, update: AccelerationPreferenceUpdate): AccelerationPreference {
  const lineId = update.lineId === undefined ? base.lineId : update.lineId
  return {
    lineId: lineId !== null && isAccelerationLineId(lineId) ? lineId : null,
    mode: parseMode(update.mode) ?? base.mode,
  }
}

/**
 * 记住的选择落到一次真正的连接上。托盘与自动连接都是静默发起的：模式只在当前
 * 状态明确说支持时才跟着记录走，状态没报 supportedModes 就只用标准模式——加速
 * 至今只接管系统代理，替用户悄悄开 TUN 会改动他的系统网络设置。
 */
export function accelerationStartRequest(
  preference: AccelerationPreference,
  supportedModes: readonly AccelerationMode[] | undefined,
): { mode: AccelerationMode; lineId?: string } {
  const mode = preference.mode === 'system-proxy' || supportedModes?.includes(preference.mode)
    ? preference.mode
    : 'system-proxy'
  return preference.lineId === null ? { mode } : { mode, lineId: preference.lineId }
}

export function createAccelerationPreferenceStore(options: { filePath: string }): AccelerationPreferenceStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('加速线路偏好必须使用绝对路径。')
  let cache: StoredPreferences | null = null
  // 写入串行化：两处界面（线路、模式）可能同时写，后一次必须读到前一次的结果。
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  async function load(): Promise<StoredPreferences> {
    if (cache) return cache
    try {
      const content = await readSafeUtf8File(options.filePath, storeLabel, MAX_BYTES)
      cache = content === null ? { version: 1, accounts: Object.create(null) as Record<string, AccelerationPreference> } : parseStored(content)
    } catch {
      cache = { version: 1, accounts: Object.create(null) as Record<string, AccelerationPreference> }
    }
    return cache
  }

  return {
    async getAccelerationPreference(scope) {
      const stored = await enqueue(load)
      return stored.accounts[scope] ?? defaultAccelerationPreference
    },
    saveAccelerationPreference(scope, update) {
      return enqueue(async () => {
        const stored = await load()
        const preference = mergePreference(stored.accounts[scope] ?? defaultAccelerationPreference, update)
        const accounts = Object.create(null) as Record<string, AccelerationPreference>
        // 当前账号重新插到末尾，于是超额时被丢掉的一定是最久没动过的那几条。
        for (const [key, entry] of Object.entries(stored.accounts)) {
          if (key !== scope) accounts[key] = entry
        }
        accounts[scope] = preference
        const entries = Object.entries(accounts)
        const next: StoredPreferences = {
          version: 1,
          accounts: Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_ACCOUNTS))),
        }
        try {
          ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
          await writeAtomicSafeUtf8File(options.filePath, `${JSON.stringify(next)}\n`, storeLabel)
        } catch {
          // 内存里的那份也要回到磁盘上的事实，否则下一次读会拿到没写成功的值。
          cache = null
          throw new Error(writeFailure)
        }
        cache = next
        return preference
      })
    },
  }
}
