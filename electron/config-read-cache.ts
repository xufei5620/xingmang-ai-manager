// 首页、开机补密钥、线路跟随开机那两秒里接连要五遍工具配置（0.2.24 深查 R3），每一遍都把四家的配置文件、
// 来源记录、线路跟随记录从头查一遍：几百次磁盘查询，全在主进程上同步做，Windows 上每次还要过一遍杀毒。
// 这里把读出来的那份留几秒，下面三样都没变才接着用，有一样变了就重读：
//   - 星芒自己没写过：写工具配置（executeFilePlans、Codex 定点改写）、写来源记录、写线路跟随记录都记一笔
//     （noteToolConfigWrite）；
//   - 读过的每一份文件身份、大小、修改时间都没变：客户自己改、工具自己写、登录官方账号这些星芒之外的改动；
//   - 调用方给的钥匙（账号、站点线路这些）一样。
// 过了几秒一律重读：上面两样都管不到的（比如 Windows 上 Grok 认哪个命令行跟着系统路径变）最多晚这么一会儿。
import fs from 'node:fs'

let toolConfigRevision = 0

/** 星芒要写（或刚写完）工具配置、来源记录、线路跟随记录：之前读下的一律不再接着用。 */
export function noteToolConfigWrite(): void {
  toolConfigRevision += 1
}

export function currentToolConfigRevision(): number {
  return toolConfigRevision
}

/** 异步写：写之前、写完各记一笔。写到一半有人来读，读下的那份在写完后照样作废。 */
export async function trackToolConfigWrite<T>(write: () => Promise<T>): Promise<T> {
  noteToolConfigWrite()
  try {
    return await write()
  } finally {
    noteToolConfigWrite()
  }
}

/** 一份文件此刻的样子：换了文件（原子替换）、改了内容、改了大小或权限，这一串就不一样。 */
export function statStamp(info: fs.Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.nlink].join(':')
}

/** 不在 = 'missing'；查不了（没权限之类）= null，看不出来动没动，这一次读下的就不留。 */
export function configPathStamp(filePath: string): string | null {
  try {
    return statStamp(fs.lstatSync(filePath))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null
  }
}

export const configReadCacheMaxAgeMs = 3000

export interface RecordedConfigRead<T> {
  value: T
  /** 读每一份文件之前它的样子（读之前查，读的当口被人改了，下回一比就对不上）。 */
  stamps: ReadonlyMap<string, string | null>
}

export interface ConfigReadCacheOptions {
  maxAgeMs?: number
  now?: () => number
  revision?: () => number
  stamp?: (filePath: string) => string | null
}

interface ConfigReadCacheEntry<T> {
  key: string
  at: number
  revision: number
  stamps: Array<[string, string]>
  value: T
}

function knownStamps(stamps: Iterable<readonly [string, string | null]>): Array<[string, string]> | null {
  const known: Array<[string, string]> = []
  for (const [filePath, stamp] of stamps) {
    if (stamp === null) return null
    known.push([filePath, stamp])
  }
  return known
}

/**
 * 只留最近一次。read 的 watched 是除了读过的文件以外还要盯着的路径（各家的配置文件夹：多了、少了一份文件，
 * 文件夹本身的修改时间就变），读之前先查。load 必须是只读的同步代码，读过哪几份由它交回（withRecordedConfigReads）。
 */
export function createConfigReadCache<T>(options: ConfigReadCacheOptions = {}) {
  const maxAgeMs = options.maxAgeMs ?? configReadCacheMaxAgeMs
  const now = options.now ?? (() => performance.now())
  const revision = options.revision ?? currentToolConfigRevision
  const stamp = options.stamp ?? configPathStamp
  let entry: ConfigReadCacheEntry<T> | null = null

  function reusable(cached: ConfigReadCacheEntry<T>, key: string, at: number, current: number): boolean {
    // 时钟往回走也重读，不能让上一次的一直用下去。
    if (cached.key !== key || cached.revision !== current || at < cached.at || at - cached.at >= maxAgeMs) return false
    return cached.stamps.every(([filePath, expected]) => stamp(filePath) === expected)
  }

  return {
    read(key: string, watched: readonly string[], load: () => RecordedConfigRead<T>): T {
      if (maxAgeMs <= 0) return load().value
      const at = now()
      const current = revision()
      if (entry && reusable(entry, key, at, current)) return entry.value
      entry = null
      const before = watched.map((filePath) => [filePath, stamp(filePath)] as const)
      const { value, stamps } = load()
      const known = knownStamps([...before, ...stamps])
      if (known) entry = { key, at, revision: current, stamps: known, value }
      return value
    },
    forget(): void {
      entry = null
    },
  }
}
