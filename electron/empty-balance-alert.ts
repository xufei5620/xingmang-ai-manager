import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

/**
 * 当前账号的钱包到了 $0、又没有能扣的订阅，提醒一次去充值（主路卡点 F2）。
 *
 * Codex 没有出错钩子：notify 只在一轮顺利做完时调用。额度用完时终端里先「重连 5 次」像网断了，
 * 最后才出一行英文 403，星芒这边一声不吭（Claude Code、Grok 有 StopFailure，走的是钩子那条）。
 * 能盖住 Codex 的只有余额本身，所以这条跟着余额走、不分工具：哪个工具停下来都是这一个原因。
 *
 * 同一个账号同一次「用完」只说一次，记在 userData 里，软件重开、钱包一直是 0 也不再说；读到钱包
 * 又有钱或订阅又能扣了就抹掉记录，下次再用完再说。
 */

/**
 * funded：钱包有钱，或有能扣的订阅；empty：两样都没有；unknown：钱包是 0，但这个账号的订阅还没
 * 读到——只靠订阅的客户钱包本来就是 0，订阅读回来之前不下结论。
 */
export type EmptyBalanceState = 'funded' | 'empty' | 'unknown'

export function resolveEmptyBalanceState(dollars: number, subscribed: boolean | null): EmptyBalanceState {
  if (dollars > 0 || subscribed === true) return 'funded'
  return subscribed === null ? 'unknown' : 'empty'
}

export interface EmptyBalanceRecord {
  /** 这一次用完还没提醒过：记下并返回 true；已经提醒过返回 false。 */
  claim(account: string, at: number): Promise<boolean>
  /** 钱包又有钱了：抹掉记录，下次用完再提醒。本来就没有记录时不写盘。 */
  release(account: string): Promise<void>
}

const recordLabel = '余额用完提醒记录'
const recordMaximumBytes = 16 * 1024
// 一台电脑上登过的账号不会多；超出时扔掉最早记的，最坏是那个账号下次读到 0 再提醒一回。
const recordMaximumAccounts = 32

export function pruneEmptyBalanceRecord(record: unknown): Record<string, number> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {}
  const entries = Object.entries(record)
    .filter((entry): entry is [string, number] => entry[0].length <= 160 && typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
    .slice(0, recordMaximumAccounts)
  return Object.fromEntries(entries)
}

/**
 * 第一次要用时才读盘，之后都用内存里那份；写盘排队、原子替换，写不进去只是重开软件后可能再提醒一回。
 * 读到内存以后查和记是同步的一步，同时来两次余额也只有一次拿到 true。
 */
export function createEmptyBalanceRecordStore(directory: string): EmptyBalanceRecord {
  const filePath = path.join(directory, 'balance-empty-notified.json')
  let current: Record<string, number> = {}
  let loading: Promise<void> | null = null
  let writes: Promise<void> = Promise.resolve()
  const ready = () => {
    loading ??= readSafeUtf8File(filePath, recordLabel, recordMaximumBytes).then((content) => {
      if (content === null) return
      try { current = pruneEmptyBalanceRecord(JSON.parse(content)) } catch { /* 坏文件当没有记录 */ }
    }).catch(() => undefined)
    return loading
  }
  const save = (record: Record<string, number>) => {
    current = record
    const content = `${JSON.stringify(record)}\n`
    writes = writes.then(async () => {
      ensureSafeDataDirectory(directory, recordLabel)
      await writeAtomicSafeUtf8File(filePath, content, recordLabel)
    }).catch(() => undefined)
    return writes
  }
  return {
    async claim(account, at) {
      await ready()
      if (Object.hasOwn(current, account)) return false
      await save(pruneEmptyBalanceRecord({ ...current, [account]: at }))
      return true
    },
    async release(account) {
      await ready()
      if (!Object.hasOwn(current, account)) return
      await save(Object.fromEntries(Object.entries(current).filter(([key]) => key !== account)))
    },
  }
}
