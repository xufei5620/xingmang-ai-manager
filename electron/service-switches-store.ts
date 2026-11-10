/**
 * 服务状态文件里远程关功能、已知问题提示、充值方式开关这三样落盘的那一份（D83，深查 RC-06）。
 *
 * 为什么要落盘：这三样只认最近一次读成功的状态文件，可那份只活在内存里。出事关掉一个功能以后，读不到更新目录的
 * 电脑只要重开一次星芒，那个功能就回来了，藏掉的付款方式、「先这样绕过去」那句话也一样。记在本地以后，重开时
 * 先用上次读成功的那份，读到新的再换。
 *
 * 读成功、里面一样都没写的那次也记下来（记成空的）：发布者撤掉开关以后，读到过撤掉后那份的电脑，再重开时读不到
 * 也不会按撤掉前那份关。代价是撤掉以后一次也没读到过的电脑会一直关着；这份文件只能让客户端少做、多说一句，
 * 这个代价 2026-11-10 yoyo 拍板接受。从来没读成功过的电脑照旧什么都不关。
 *
 * The file lives in user-writable app data, so whatever is read back is
 * revalidated with the status file's own parser. Every one of the three can
 * only make the client do less or say one more sentence: a feature switch only
 * turns a feature off, a payment switch only hides a method the site already
 * offers, and a known-issue line carries no link (the same link filter the
 * status file goes through). A tampered file therefore cannot grant anything.
 */
import path from 'node:path'
import { isRecord } from './input-guards'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import { parseServiceSwitches, type ServiceSwitches } from './service-status'

const storeLabel = '远程开关记录'
// 状态文件整份最多 16 KB，这三样只是其中几段，原样再记一遍也到不了这个数；上限只防这个位置被换成别的大文件。
const maxStoreBytes = 32 * 1024

export interface ServiceSwitchesStore {
  /** 开机时读一次。没有、读坏了都返回 null，照「从没读到过」算。 */
  read(): ServiceSwitches | null
  /** 状态文件读成功一次就交过来（一样都没写就是空的）；跟上次读到、写下的一样就不动盘。 */
  write(switches: ServiceSwitches): Promise<void>
}

function serialize(switches: ServiceSwitches): string {
  return `${JSON.stringify({ version: 1, ...switches })}\n`
}

export function parseStoredServiceSwitches(content: string): ServiceSwitches | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== 1) return null
  return parseServiceSwitches(value)
}

export function createServiceSwitchesStore(options: { filePath: string }): ServiceSwitchesStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('远程开关记录必须使用绝对路径。')
  // 写入串行化：前后两次读成功挨得很近时，落盘的必须是后读到的那份。
  let queue: Promise<void> = Promise.resolve()
  // 盘上现在是什么。状态文件每 15 分钟读一次，开关难得变一回，一样的就不再写。
  let stored: string | null = null
  return {
    read() {
      try {
        const content = readSafeUtf8FileSync(options.filePath, storeLabel, maxStoreBytes)
        if (content === null) return null
        const switches = parseStoredServiceSwitches(content)
        if (switches && content === serialize(switches)) stored = content
        return switches
      } catch {
        return null
      }
    },
    write(switches) {
      const content = serialize(switches)
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
