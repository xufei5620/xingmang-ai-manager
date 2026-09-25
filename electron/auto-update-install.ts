/**
 * 「自动更新」开着时，已经下载好的新版本什么时候装。
 *
 * 规矩是不在用户正用着的时候把软件关掉重开，所以只有两个时机：
 * - **用户自己退出时**：直接装，不再弹「顺手装上吗」那一问（main.ts 的 confirmQuit）。
 * - **下次打开软件时**：上一次运行就已经下好了，这次启动刚打开、用户还没开始用，装上。
 *   常驻托盘、从不真正退出的人只能靠这一条拿到新版本。
 *
 * 第二条最怕的是死循环：安装器每次都起不来，软件就会每次一打开就关掉。所以每个版本
 * 在启动时只试一次，先记下「试过了」再去装；没装成的版本退回到「退出时装」和更新页
 * 的按钮。判断「上一次运行就下好了」要靠落盘的记录：electron-updater 启动时命中本地
 * 缓存和现场下载，对外发出的事件是一样的。
 *
 * 记录读坏了一律当作没有记录：最多少装一次，绝不会多装。
 */
import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import { resolveInstallableUpdateOnQuit } from './quit-blocking-tasks'
import type { UpdateSnapshot } from './updater'

const storeLabel = '自动更新记录'
const MAX_STORE_BYTES = 4 * 1024
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/

/**
 * 启动后多久之内下好的才算「打开时装」。本地缓存命中加上 SHA-512 复核通常几秒就完；
 * 超过这个时间才下好，说明是这次现场下载的，用户多半已经在用了，留到退出时再装。
 */
export const LAUNCH_INSTALL_WINDOW_MS = 2 * 60 * 1_000

export interface PendingUpdateRecord {
  /** 上一次（或更早）运行时已经下载并校验好的版本。 */
  downloadedVersion: string | null
  /** 已经在启动时试着装过的版本；同一个版本不再在启动时试第二次。 */
  attemptedVersion: string | null
}

export const emptyPendingUpdateRecord: PendingUpdateRecord = { downloadedVersion: null, attemptedVersion: null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseVersion(value: unknown): string | null {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : null
}

export function parsePendingUpdateRecord(content: string): PendingUpdateRecord {
  try {
    const value: unknown = JSON.parse(content)
    if (!isRecord(value) || value.version !== 1) return { ...emptyPendingUpdateRecord }
    return {
      downloadedVersion: parseVersion(value.downloadedVersion),
      attemptedVersion: parseVersion(value.attemptedVersion),
    }
  } catch {
    return { ...emptyPendingUpdateRecord }
  }
}

/** 这次快照是一个刚下好、需要记下来的版本时返回它，否则返回 null。 */
export function resolveDownloadedVersionToRecord(snapshot: UpdateSnapshot, record: PendingUpdateRecord): string | null {
  const installable = resolveInstallableUpdateOnQuit(snapshot)
  const version = parseVersion(installable?.version)
  return version && version !== record.downloadedVersion ? version : null
}

export interface LaunchInstallInput {
  autoUpdate: boolean
  snapshot: UpdateSnapshot
  /** 本次启动时读到的记录，不是运行中改写过的那份。 */
  recordAtLaunch: PendingUpdateRecord
  elapsedSinceLaunchMs: number
  /** 有安装任务在跑（装 CLI、装 Node 之类）时不打断。 */
  busy: boolean
}

/** 返回要在启动时装上的版本；不该装时返回 null。 */
export function decideLaunchInstall(input: LaunchInstallInput): string | null {
  if (!input.autoUpdate || input.busy) return null
  if (!(input.elapsedSinceLaunchMs >= 0 && input.elapsedSinceLaunchMs <= LAUNCH_INSTALL_WINDOW_MS)) return null
  const version = parseVersion(resolveInstallableUpdateOnQuit(input.snapshot)?.version)
  if (!version) return null
  if (input.recordAtLaunch.downloadedVersion !== version) return null
  if (input.recordAtLaunch.attemptedVersion === version) return null
  return version
}

export interface PendingUpdateStore {
  read(): PendingUpdateRecord
  write(record: PendingUpdateRecord): Promise<void>
}

export function createPendingUpdateStore(options: { filePath: string }): PendingUpdateStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('自动更新记录必须使用绝对路径。')
  return {
    read() {
      try {
        const content = readSafeUtf8FileSync(options.filePath, storeLabel, MAX_STORE_BYTES)
        return content === null ? { ...emptyPendingUpdateRecord } : parsePendingUpdateRecord(content)
      } catch {
        return { ...emptyPendingUpdateRecord }
      }
    },
    async write(record) {
      ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
      const value = {
        version: 1,
        downloadedVersion: parseVersion(record.downloadedVersion),
        attemptedVersion: parseVersion(record.attemptedVersion),
      }
      await writeAtomicSafeUtf8File(options.filePath, `${JSON.stringify(value)}\n`, storeLabel)
    },
  }
}
