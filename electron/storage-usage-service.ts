import path from 'node:path'
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
  /**
   * 两个站点共用的那个 AI 作品文件夹：历史账号的作品在它下面的 realms/api-account 里。量这一层，
   * 换站点时数字不变（A08）；「打开文件夹」打开的仍是当前站点那一个，不归这里管。
   */
  worksDirectory(): string
  /** 这台电脑上两个站点、各个账号的画布项目自己选的文件夹里放作品的那一层（A08）。 */
  canvasProjectAssetDirectories(): Promise<readonly string[]>
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

/**
 * 「清理旧备份」数的、删的那几份：还在用的工具、校验过了的。已下线的工具不数也不删；校验不过的
 * 在「工具配置备份」里单独一行、各自删（R2-2），这里也不数不删，免得清理时删掉客户没看过的。
 */
function shownBackup(backup: ConfigBackupSummary): boolean {
  return backup.valid && isActiveProviderId(backup.provider)
}

/**
 * 去掉重复的和被别的套住的（A08）：画布项目的文件夹可以选在作品文件夹里面，两个项目、两个站点也可以共用一个文件夹，
 * 同一份文件只算一遍。返回留下的原样字符串，一模一样的留前面那条；Windows 上不分大小写，和 path-identity.ts 一样。
 */
export function outermostDirectories(directories: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const flavor = platform === 'win32' ? path.win32 : path.posix
  const entries = directories.map((directory) => {
    const resolved = flavor.resolve(directory)
    return { directory, key: platform === 'win32' ? resolved.toLowerCase() : resolved }
  })
  const keys = new Set(entries.map((entry) => entry.key))
  const kept = new Set<string>()
  return entries.filter((entry) => {
    if (kept.has(entry.key)) return false
    // 往上一层层找，比两两比较快：项目可以有几百个，层数只有十来层。
    for (let current = entry.key, parent = flavor.dirname(current); parent !== current; current = parent, parent = flavor.dirname(current)) {
      if (keys.has(parent)) return false
    }
    kept.add(entry.key)
    return true
  }).map((entry) => entry.directory)
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
  /**
   * 作品文件夹量不出来就是这一行没算出来；画布项目的文件夹是客户自己选的，可能在拔掉的盘上、或者不让读，
   * 量不出来的当没有，只在日志里记几处没算上（不记路径，I13）。
   */
  async function measureWorks(): Promise<number> {
    const shared = dependencies.worksDirectory()
    let projects: readonly string[] = []
    try {
      projects = await dependencies.canvasProjectAssetDirectories()
    } catch (error) {
      dependencies.log.log('warn', 'storage', 'storage.canvas-projects.unreadable', '画布项目的文件夹没读出来，AI 作品只算了作品文件夹', {
        code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      })
    }
    let total = 0
    let skipped = 0
    for (const directory of outermostDirectories([shared, ...projects])) {
      if (directory === shared) {
        total += await measureDirectoryBytes(directory, { gate })
        continue
      }
      try {
        total += await measureDirectoryBytes(directory, { gate })
      } catch {
        skipped += 1
      }
    }
    if (skipped) dependencies.log.log('warn', 'storage', 'storage.measure.partial', '有几个画布项目的文件夹没算上', { part: 'works', skipped })
    return total
  }
  async function measure(part: StorageUsagePart): Promise<StorageUsagePartReport> {
    if (part === 'works') return { bytes: await measureWorks() }
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
