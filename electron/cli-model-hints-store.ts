/**
 * 服务状态文件里的型号表（cliModels）落盘的那一份（#1154 第 6 条）。
 *
 * 为什么要落盘：型号表只认最近一次读成功的状态文件，可那份只活在内存里。下架型号的替换只在开机那轮做，
 * 网差的电脑开机第一下没读到状态文件，这一轮就整轮按程序自带的表走，远端加的下架名单要等哪次开机第一下
 * 正好读成功才生效。记在本地以后，开机那次没读到也按上次读成功的那份算，读到新的再换。
 *
 * 读成功、里面却没写型号表的那次也记下来（记成没有）：发布者撤掉型号表以后，读不到状态文件的电脑不能
 * 还一直按撤掉前那份走。从来没读成功过的电脑照旧用程序自带的。
 *
 * The file lives in user-writable app data, so whatever is read back is
 * revalidated with the status file's own parser. The table only chooses among
 * models the account's own model list offers, and the retired list only
 * replaces a model the account no longer lists, so a tampered file cannot put
 * a model into a tool config that the account could not already use.
 */
import path from 'node:path'
import type { CliModelHints } from './cli-model-defaults'
import { isRecord } from './input-guards'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import { parseCliModelHints, type ServiceStatus } from './service-status'

const storeLabel = '型号表记录'
// 状态文件整份最多 16 KB，型号表只是其中一段，原样再记一遍也到不了这个数；上限只防这个位置被换成别的大文件。
const maxStoreBytes = 32 * 1024

export interface CliModelHintsStore {
  /** 开机时读一次。没有、读坏了、记的是「没写型号表」都返回 null，照程序自带的那份算。 */
  read(): CliModelHints | null
  /** 状态文件读成功一次就交过来（没写型号表就是 null）；跟上次读到、写下的一样就不动盘。 */
  write(hints: CliModelHints | null): Promise<void>
}

function serialize(hints: CliModelHints | null): string {
  return `${JSON.stringify({ version: 1, cliModels: hints })}\n`
}

export function parseStoredCliModelHints(content: string): CliModelHints | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== 1) return null
  return parseCliModelHints(value.cliModels)
}

/**
 * 这次打开以后读成功过，就用最近读成功的那份（里面没写型号表就是 null，照程序自带的算）；一次也没读成功过，
 * 才用开机时记下的那份。
 */
export function resolveCliModelHints(lastKnown: ServiceStatus | null, remembered: CliModelHints | null): CliModelHints | null {
  return lastKnown ? lastKnown.cliModels ?? null : remembered
}

export function createCliModelHintsStore(options: { filePath: string }): CliModelHintsStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('型号表记录必须使用绝对路径。')
  // 写入串行化：前后两次读成功挨得很近时，落盘的必须是后读到的那份。
  let queue: Promise<void> = Promise.resolve()
  // 盘上现在是什么。状态文件每 15 分钟读一次，型号表难得变一回，一样的就不再写。
  let stored: string | null = null
  return {
    read() {
      try {
        const content = readSafeUtf8FileSync(options.filePath, storeLabel, maxStoreBytes)
        if (content === null) return null
        const hints = parseStoredCliModelHints(content)
        if (content === serialize(hints)) stored = content
        return hints
      } catch {
        return null
      }
    },
    write(hints) {
      const content = serialize(hints)
      if (content === stored) return queue
      stored = content
      const result = queue.then(async () => {
        ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
        await writeAtomicSafeUtf8File(options.filePath, content, storeLabel)
      })
      // 没写成就忘掉，下次读成功时再写一遍。
      result.catch(() => {
        if (stored === content) stored = null
      })
      queue = result.catch(() => undefined)
      return result
    },
  }
}
