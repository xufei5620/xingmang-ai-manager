import fs from 'node:fs'
import path from 'node:path'
import { mapWithConcurrency } from './async-map'
import { assertNoReparseComponents } from './safe-local-data'
import { resolveRelocatedPath } from './relocated-folders'

/**
 * 「设置 › 备份迁移」最下面那张「星芒占用的空间」卡（决定单 D100）：六行，按页面上的顺序。
 * 作品、聊天记录、日志只列大小；能清的只有删了能重新生成、重新下载的三样（StorageCleanTarget）。
 */
export type StorageUsagePart = 'works' | 'thumbnails' | 'chat-history' | 'logs' | 'backups' | 'downloads'

/** 缩略图（看作品库时重新生成）、最近 10 份以外的旧备份、装工具时下载的文件（下次装重新下载）。 */
export type StorageCleanTarget = 'thumbnails' | 'backups' | 'downloads'

export interface StorageUsagePartReport {
  /** 约多少字节；没算出来（读不了那个文件夹）时为 null，那一行写「没算出来」。 */
  bytes: number | null
  /** 只有 backups：卡片上面「工具配置备份」里看得到的那几份一共几份。 */
  backupCount?: number
  /** 只有 downloads：这一刻有没有工具在装或更新。在装时那一行的「清理」灰着，装完再清。 */
  installing?: boolean
}

export interface StorageCleanResult {
  /** 删掉的大致字节数。 */
  freedBytes: number
  /** 认得、但这次没删掉的（被占用、没权限）。大于 0 时提示条说「有些文件正被占用」。 */
  kept: number
}

const storageUsageParts: readonly StorageUsagePart[] = ['works', 'thumbnails', 'chat-history', 'logs', 'backups', 'downloads']
const storageCleanTargets: readonly StorageCleanTarget[] = ['thumbnails', 'backups', 'downloads']

export function isStorageUsagePart(value: unknown): value is StorageUsagePart {
  return typeof value === 'string' && (storageUsageParts as readonly string[]).includes(value)
}

export function isStorageCleanTarget(value: unknown): value is StorageCleanTarget {
  return typeof value === 'string' && (storageCleanTargets as readonly string[]).includes(value)
}

/**
 * At most `limit` tasks in flight across every caller holding the same gate.
 *
 * The six rows are measured by six separate requests so the quick ones show
 * up while the works folder (tens of thousands of files) is still being
 * walked. Each walk already limits itself with mapWithConcurrency, but six of
 * them side by side would put six times that many fs requests in flight, and a
 * burst like that freezes the window just as an unlimited Promise.all does
 * (async-map.ts). One gate shared by all of them keeps the total bounded.
 */
export interface ConcurrencyGate {
  run<T>(task: () => Promise<T>): Promise<T>
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限无效')
  let active = 0
  const waiting: Array<() => void> = []
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
      active += 1
      try {
        return await task()
      } finally {
        active -= 1
        waiting.shift()?.()
      }
    },
  }
}

/** 同一个文件夹里同时问几个文件的大小；再大也被共用的 gate 卡住。 */
const MEASURE_CONCURRENCY = 16
/**
 * 作品文件夹可能有几万个文件。数到这么多就不往下数了：卡片上写的本来就是「约」，
 * 算的时间不能比客户等得起的还长。
 */
const MAXIMUM_MEASURED_ENTRIES = 500_000

export interface MeasureDirectoryOptions {
  gate?: ConcurrencyGate
  maximumEntries?: number
}

/**
 * Adds up the sizes of the regular files under `directory`.
 *
 * Read only, so the folder itself may be reached through a link (a profile
 * moved to another disk), but nothing below it is followed: a link inside is
 * neither entered nor counted, which keeps a loop or a link to a whole drive
 * from inflating the figure. A folder that does not exist uses nothing. A
 * folder that cannot be read at all throws, so the row says it could not be
 * worked out instead of showing a misleading zero; a sub-folder that cannot be
 * read is skipped and the rest still counts.
 */
export async function measureDirectoryBytes(directory: string, options: MeasureDirectoryOptions = {}): Promise<number> {
  const gate = options.gate ?? createConcurrencyGate(MEASURE_CONCURRENCY)
  const maximumEntries = options.maximumEntries ?? MAXIMUM_MEASURED_ENTRIES
  let rootStats: fs.Stats
  try {
    rootStats = await gate.run(() => fs.promises.stat(directory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!rootStats.isDirectory()) return rootStats.isFile() ? rootStats.size : 0
  let total = 0
  let visited = 0
  const pending = [directory]
  while (pending.length && visited < maximumEntries) {
    const current = pending.pop()
    if (current === undefined) break
    let entries: fs.Dirent[]
    try {
      entries = await gate.run(() => fs.promises.readdir(current, { withFileTypes: true }))
    } catch (error) {
      if (current === directory) throw error
      continue
    }
    const files: string[] = []
    for (const entry of entries) {
      visited += 1
      if (visited > maximumEntries) break
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) files.push(child)
    }
    const sizes = await mapWithConcurrency(files, MEASURE_CONCURRENCY, (file) => gate.run(async () => {
      try {
        const stats = await fs.promises.lstat(file)
        return stats.isFile() ? stats.size : 0
      } catch {
        // Gone or locked since readdir listed it: counts as nothing.
        return 0
      }
    }))
    for (const size of sizes) total += size
  }
  return total
}

const THUMBNAIL_LABEL = 'AI 素材缩略图'
const thumbnailAccountPattern = /^user-[1-9]\d*$/
// asset-thumbnail.ts 的 assetThumbnailVersion（现在是 v2）；以前的版本留下的也认，换版本后它们没人用了。
const thumbnailVersionPattern = /^v\d{1,4}$/
// asset-thumbnail-store.ts 写的名字：43 位作品编号加 .png 或 .jpg。写到一半的临时文件不认、不删。
const thumbnailFilePattern = /^[A-Za-z0-9_-]{43}\.(?:png|jpg)$/
const DELETE_CONCURRENCY = 8

/**
 * Empties the thumbnail cache laid out by asset-thumbnail-store.ts as
 * `<root>/user-<id>/<version>/<assetId>.<ext>`. Every thumbnail is derived
 * from an asset that stays where it is, and the store regenerates any it
 * cannot find the next time the library shows it.
 *
 * Only that layout is touched (AGENTS.md I8): real directories with the
 * account and version names, and in them single-link regular files with the
 * thumbnail name. Links are never followed or removed, every directory is
 * checked for reparse points right before its files go, and anything else
 * stays. The emptied folders are removed only when nothing is left in them.
 */
export async function clearThumbnailCache(cacheRoot: string): Promise<StorageCleanResult> {
  const result: StorageCleanResult = { freedBytes: 0, kept: 0 }
  const root = resolveRelocatedPath(cacheRoot)
  const accounts = await readRealSubdirectories(root, thumbnailAccountPattern, result)
  for (const account of accounts) {
    const versions = await readRealSubdirectories(account, thumbnailVersionPattern, result)
    for (const version of versions) {
      await removeThumbnailFiles(version, result)
      await removeIfEmpty(version)
    }
    await removeIfEmpty(account)
  }
  return result
}

/** 这一层下名字对得上的普通文件夹；文件夹本身读不了算一份没删掉的，不报错。 */
async function readRealSubdirectories(directory: string, pattern: RegExp, result: StorageCleanResult): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    assertNoReparseComponents(directory, THUMBNAIL_LABEL)
    const stats = await fs.promises.lstat(directory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return []
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.kept += 1
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && pattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
}

async function removeThumbnailFiles(directory: string, result: StorageCleanResult): Promise<void> {
  let names: string[]
  try {
    assertNoReparseComponents(directory, THUMBNAIL_LABEL)
    names = (await fs.promises.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && thumbnailFilePattern.test(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.kept += 1
    return
  }
  await mapWithConcurrency(names, DELETE_CONCURRENCY, async (name) => {
    const filePath = path.join(directory, name)
    try {
      const stats = await fs.promises.lstat(filePath)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        result.kept += 1
        return
      }
      await fs.promises.rm(filePath)
      result.freedBytes += stats.size
    } catch (error) {
      // Already gone is what we wanted; locked (antivirus, the library reading
      // it this very moment) stays for the next time.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.kept += 1
    }
  })
}

async function removeIfEmpty(directory: string): Promise<void> {
  // rmdir only succeeds on an empty directory, so a folder that still holds
  // anything this did not recognise stays exactly as it was.
  await fs.promises.rmdir(directory).catch(() => undefined)
}
