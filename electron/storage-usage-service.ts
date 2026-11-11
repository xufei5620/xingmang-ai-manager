import { isActiveProviderId } from './catalog'
import type { ConfigBackupPruneResult, ConfigBackupSummary } from './backups'
import type { InstallLeftoverSweepResult } from './install-leftovers'
import type { RuntimeLogStore } from './runtime-log'
import {
  clearThumbnailCache,
  createConcurrencyGate,
  measureDirectoryBytes,
  type StorageCleanResult,
  type StorageCleanTarget,
  type StorageUsagePart,
  type StorageUsagePartReport,
} from './storage-usage'

/** 「清理旧备份」留下最近这么多份（D100）；卡片上的确认框和灰按钮旁那句话写的也是 10。 */
export const RETAINED_BACKUPS_AFTER_CLEANUP = 10

export interface StorageUsageServiceDependencies {
  /** 当前账号的 AI 作品现在存在哪（「打开文件夹」打开的那一个）。 */
  worksDirectory(): string
  /** 两个账号站点各自那份作品缩略图。 */
  thumbnailDirectories(): readonly string[]
  chatHistoryDirectory: string
  logDirectory: string
  backups: {
    list(): ConfigBackupSummary[]
    rootDirectory(): string
    removeAllButNewest(keep: number, include: (backup: ConfigBackupSummary) => boolean): Promise<ConfigBackupPruneResult>
  }
  downloads: {
    measure(): Promise<number>
    clean(): Promise<InstallLeftoverSweepResult>
    /** 这一刻有没有工具在装或更新（quit-blocking-tasks.ts 的那几类）。 */
    installing(): boolean
  }
  log: Pick<RuntimeLogStore, 'log'>
}

export interface StorageUsageService {
  inspect(part: StorageUsagePart): Promise<StorageUsagePartReport>
  clean(target: StorageCleanTarget): Promise<StorageCleanResult>
}

/** 卡片上面「工具配置备份」里看得到的那几份：已下线的工具和校验不过的不在那里，不数也不删。 */
function shownBackup(backup: ConfigBackupSummary): boolean {
  return isActiveProviderId(backup.provider)
}

/**
 * 「设置 › 备份迁移 › 星芒占用的空间」的主进程那一半（决定单 D100）。只在客户打开这一组时由界面问一次，
 * 不在后台常驻算；六行各问各的，快的先出来，所有读盘共用一个限流（storage-usage.ts）。
 *
 * 日志只记哪一行、多少字节、几份没删掉，不记路径和系统原话（I13）：原话里带着用户名。
 */
export function createStorageUsageService(dependencies: StorageUsageServiceDependencies): StorageUsageService {
  const gate = createConcurrencyGate(16)
  async function measureAll(directories: readonly string[]): Promise<number> {
    let total = 0
    for (const directory of directories) total += await measureDirectoryBytes(directory, { gate })
    return total
  }
  async function measure(part: StorageUsagePart): Promise<StorageUsagePartReport> {
    if (part === 'works') return { bytes: await measureAll([dependencies.worksDirectory()]) }
    if (part === 'thumbnails') return { bytes: await measureAll(dependencies.thumbnailDirectories()) }
    if (part === 'chat-history') return { bytes: await measureAll([dependencies.chatHistoryDirectory]) }
    if (part === 'logs') return { bytes: await measureAll([dependencies.logDirectory]) }
    if (part === 'backups') {
      const backupCount = dependencies.backups.list().filter(shownBackup).length
      return { bytes: await measureAll([dependencies.backups.rootDirectory()]), backupCount }
    }
    return { bytes: await dependencies.downloads.measure(), installing: dependencies.downloads.installing() }
  }
  async function inspect(part: StorageUsagePart): Promise<StorageUsagePartReport> {
    try {
      return await measure(part)
    } catch (error) {
      dependencies.log.log('warn', 'storage', 'storage.measure.failed', '有一项占用的空间没算出来', {
        part,
        code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      })
      // 下载那一行没算出来时，「在不在装」照样要说：灰按钮看的是它。
      return part === 'downloads' ? { bytes: null, installing: dependencies.downloads.installing() } : { bytes: null }
    }
  }
  async function cleanTarget(target: StorageCleanTarget): Promise<StorageCleanResult> {
    if (target === 'thumbnails') {
      const result: StorageCleanResult = { freedBytes: 0, kept: 0 }
      for (const directory of dependencies.thumbnailDirectories()) {
        const cleared = await clearThumbnailCache(directory)
        result.freedBytes += cleared.freedBytes
        result.kept += cleared.kept
      }
      return result
    }
    if (target === 'backups') {
      const pruned = await dependencies.backups.removeAllButNewest(RETAINED_BACKUPS_AFTER_CLEANUP, shownBackup)
      return { freedBytes: pruned.freedBytes, kept: pruned.failed }
    }
    const swept = await dependencies.downloads.clean()
    return { freedBytes: swept.freedBytes, kept: swept.failed }
  }
  async function clean(target: StorageCleanTarget): Promise<StorageCleanResult> {
    const result = await cleanTarget(target)
    dependencies.log.log(result.kept ? 'warn' : 'info', 'storage', 'storage.cleaned', '清理了星芒占用的空间', {
      target,
      freedBytes: result.freedBytes,
      kept: result.kept,
    })
    return result
  }
  return { inspect, clean }
}
