/**
 * 撤销一把工具正在用、又设了额度上限或到期时间的 Key 之后，换上的新 Key 要照抄那些
 * 限制。撤销和换新通常是同一次点击里接连发生的，但换新可能失败、软件可能随后被关掉；
 * 限制只放在内存里的话，下次打开签出来的就是一把不限额的 Key，上限等于白设。所以
 * 撤销前先把限制落盘，换新成功再删。
 *
 * 两条取舍：
 * - **只记限制，不记密钥**：这里只有剩余额度、是否不限额、到期时间三样，和托管 Key
 *   缓存（managed-cli-key-store.ts，safeStorage 加密）分开放，这个文件被人看到也
 *   拿不到任何可以花钱的东西。
 * - **读坏了就抛错，不当没记过**：和加速线路偏好相反。那边丢了最多少记一次偏好，
 *   这边当成「没记过」就会签一把不限额的 Key，正是要防的事。调用方拿到这个错误要
 *   停下来告诉用户，再用 reset() 清掉坏文件，免得以后每次都卡在这里。
 *
 * 不含任何 Electron 依赖，路径由宿主注入，好让这套判断能脱离主进程单测。
 */
import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

const storeLabel = '密钥换新记录'
const MAX_BYTES = 64 * 1024
/** 一台机器上换过的账号 × 四个工具，远用不到这么多；超出时丢最早写入的。 */
const MAX_ENTRIES = 256

export interface PendingKeyLimit {
  remainQuota: number
  unlimitedQuota: boolean
  /** ISO 8601；null = 永不过期。 */
  expiredAt: string | null
}

export interface ManagedKeyReplacementStore {
  /** 没有文件、没有这一条都返回 null；文件读坏了抛 ManagedKeyReplacementUnreadableError。 */
  get(slot: string): Promise<PendingKeyLimit | null>
  set(slot: string, limit: PendingKeyLimit): Promise<void>
  remove(slot: string): Promise<void>
  /** 删掉读坏的文件：已经停下来告诉过用户了，下一次照常签。 */
  reset(): Promise<void>
}

export class ManagedKeyReplacementUnreadableError extends Error {
  constructor() {
    super('密钥换新记录读取失败')
    this.name = 'ManagedKeyReplacementUnreadableError'
  }
}

/** 撤销时记录读坏了：「稍后再试」没用，得先让用户亲手重新写入一次 Key 把坏记录清掉。 */
export const managedKeyReplacementUnreadableRevokeMessage = '之前记下的密钥额度设置读不出来，这次先没撤销。到「账号」页「密钥」里确认一下各工具的额度，点一次「重新写入 Key」，再回来撤销。'

interface StoredReplacements {
  version: 1
  entries: Record<string, PendingKeyLimit>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseLimit(value: unknown): PendingKeyLimit | null {
  if (!isRecord(value)) return null
  if (typeof value.unlimitedQuota !== 'boolean') return null
  if (typeof value.remainQuota !== 'number' || !Number.isFinite(value.remainQuota)) return null
  if (value.expiredAt !== null && (typeof value.expiredAt !== 'string' || !Number.isFinite(Date.parse(value.expiredAt)))) return null
  return { remainQuota: value.remainQuota, unlimitedQuota: value.unlimitedQuota, expiredAt: value.expiredAt }
}

function emptyReplacements(): StoredReplacements {
  return { version: 1, entries: Object.create(null) as Record<string, PendingKeyLimit> }
}

// Any entry that does not parse makes the whole file unreadable: dropping it
// would read as "this tool had no limit", which is exactly the wrong answer.
function parseStored(content: string): StoredReplacements {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) throw new ManagedKeyReplacementUnreadableError()
  const stored = emptyReplacements()
  for (const [slot, entry] of Object.entries(value.entries)) {
    const limit = parseLimit(entry)
    if (!limit) throw new ManagedKeyReplacementUnreadableError()
    stored.entries[slot] = limit
  }
  return stored
}

export function createManagedKeyReplacementStore(options: { filePath: string }): ManagedKeyReplacementStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('密钥换新记录必须使用绝对路径。')
  let cache: StoredReplacements | null = null
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  async function load(): Promise<StoredReplacements> {
    if (cache) return cache
    let content: string | null
    try {
      content = await readSafeUtf8File(options.filePath, storeLabel, MAX_BYTES)
    } catch {
      throw new ManagedKeyReplacementUnreadableError()
    }
    try {
      cache = content === null ? emptyReplacements() : parseStored(content)
    } catch {
      throw new ManagedKeyReplacementUnreadableError()
    }
    return cache
  }

  async function write(next: StoredReplacements): Promise<void> {
    try {
      ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
      await writeAtomicSafeUtf8File(options.filePath, `${JSON.stringify(next)}\n`, storeLabel)
    } catch (error) {
      // 内存里的那份要回到磁盘上的事实，否则下一次读会拿到没写成功的值。
      cache = null
      throw error
    }
    cache = next
  }

  return {
    get: (slot) => enqueue(async () => (await load()).entries[slot] ?? null),
    set: (slot, limit) => enqueue(async () => {
      // 读坏了也不许从空记录起写：坏文件里可能记着另一个工具还没换新的限制，覆盖掉
      // 它，那个工具下次就会签出不限额的 Key（#475 复核 F03）。照样抛错，由调用方停下
      // 说清楚；只有用户看过密钥页后亲手「重新写入 Key」才 reset()。
      const stored = await load()
      const entries = Object.create(null) as Record<string, PendingKeyLimit>
      for (const [key, entry] of Object.entries(stored.entries)) {
        if (key !== slot) entries[key] = entry
      }
      entries[slot] = { remainQuota: limit.remainQuota, unlimitedQuota: limit.unlimitedQuota, expiredAt: limit.expiredAt }
      const kept = Object.entries(entries)
      await write({ version: 1, entries: Object.fromEntries(kept.slice(Math.max(0, kept.length - MAX_ENTRIES))) })
    }),
    remove: (slot) => enqueue(async () => {
      const stored = await load()
      if (!(slot in stored.entries)) return
      const entries = Object.create(null) as Record<string, PendingKeyLimit>
      for (const [key, entry] of Object.entries(stored.entries)) {
        if (key !== slot) entries[key] = entry
      }
      await write({ version: 1, entries })
    }),
    reset: () => enqueue(() => write(emptyReplacements())),
  }
}

/** 没有落盘位置时（测试、预览）用的内存版，语义与文件版一致，只是关掉软件就没了。 */
export function createMemoryManagedKeyReplacementStore(): ManagedKeyReplacementStore {
  const entries = new Map<string, PendingKeyLimit>()
  return {
    get: async (slot) => entries.get(slot) ?? null,
    set: async (slot, limit) => { entries.set(slot, { ...limit }) },
    remove: async (slot) => { entries.delete(slot) },
    reset: async () => { entries.clear() },
  }
}
