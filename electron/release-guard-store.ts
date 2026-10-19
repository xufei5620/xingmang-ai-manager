/**
 * 撤回名单和分批放量落盘的那一份（#1055）。
 *
 * 为什么要落盘：更新服务只认最近一次读成功的状态文件，可那份只活在内存里。网差的电脑打开软件后
 * 状态文件一次都没读到、更新清单却读到了，就又回到「什么都没撤回、全部放开」。记在本地以后，
 * 打开软件时先用上次读成功的那份，读到新的再换。
 *
 * 只记撤回名单和放量，不记最低版本：最低版本会把人挡在门外，发布者撤掉以后，读不到状态文件的
 * 电脑不能还一直被拦着。从来没读成功过的电脑仍按不撤回、不限量算。
 *
 * The file lives in user-writable app data, so whatever is read back is
 * revalidated with the status file's own parser. Tampering with it can only
 * hold updates back or, by listing the running version as withdrawn, let the
 * client accept an older release that the update feed itself offers. That
 * release still has to pass the package checks and the rollback floor, so the
 * file never brings in a version the publisher did not ship.
 */
import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import { parseReleaseGuard, type ReleaseGuard } from './service-status'

const storeLabel = '撤回与放量记录'
// 撤回名单最多 100 条，整份一两 KB；上限只防这个位置被换成别的大文件。
const maxStoreBytes = 16 * 1024

export interface ReleaseGuardStore {
  /** 开机时在更新服务之前读一次。没有、读坏了都返回 null，照「从没读到过」算。 */
  read(): ReleaseGuard | null
  write(guard: ReleaseGuard): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseStoredReleaseGuard(content: string): ReleaseGuard | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== 1) return null
  return parseReleaseGuard(value)
}

export function createReleaseGuardStore(options: { filePath: string }): ReleaseGuardStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('撤回与放量记录必须使用绝对路径。')
  // 写入串行化：前后两次读成功挨得很近时，落盘的必须是后读到的那份。
  let queue: Promise<void> = Promise.resolve()
  return {
    read() {
      try {
        const content = readSafeUtf8FileSync(options.filePath, storeLabel, maxStoreBytes)
        return content === null ? null : parseStoredReleaseGuard(content)
      } catch {
        return null
      }
    },
    write(guard) {
      // 记下这份出自哪一版状态文件：以后读到更旧的副本就不拿它盖这份（#1157 第 10 条）。0.2.20 以前的版本
      // 读这个文件时不认 updatedAt，照旧能用。只撤某几种安装包的版本跟状态文件一样照旧写在 badVersions 里，
      // 撤哪几种另记一项（#1155 第 5 条），没有就不写，文件跟以前逐字一样。
      const content = `${JSON.stringify({
        version: 1,
        badVersions: guard.badVersions,
        ...(guard.badVersionPlatforms ? { badVersionPlatforms: guard.badVersionPlatforms } : {}),
        rollout: guard.rollout,
        ...(guard.updatedAt ? { updatedAt: guard.updatedAt } : {}),
      })}\n`
      const result = queue.then(async () => {
        ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
        await writeAtomicSafeUtf8File(options.filePath, content, storeLabel)
      })
      queue = result.catch(() => undefined)
      return result
    },
  }
}
