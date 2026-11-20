// 付过钱的图存不进作品库时先暂存在这里，腾出空间后再补存进去（深查 S-1 第 4 条）。
//
// 以前存不进去就只剩一句「图片已生成但本地保存失败」，已经扣过费的那张图跟着丢了。现在字节先写进
// 软件自己的数据文件夹（和作品库通常不在同一个文件夹，「文档」被拦、画布项目文件夹被拔掉时这里多半
// 还写得进）；这里也写不进（同一块盘满了），就先留在内存里。之后三个时候补存：重新登录或重开软件、
// 软件开着时隔一阵自己再试一次。补存走作品库自己的「本机导入」那条路，同一张图按内容只存一份，
// 补存到一半退出也不会存出两张。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { inspectAiImage, type AiStoredAsset } from './ai-asset-store'
import { ensureSafeDataDirectory, removeSafeDataFile, writeAtomicSafeBinaryFile } from './safe-local-data'
import { classifyStorageFailure } from './startup-failure'

const FILE_LABEL = '暂存的 AI 图片'
const STASHED_FILE_PATTERN = /^[a-f0-9]{64}\.(png|jpg|webp)$/
const USER_DIRECTORY_PATTERN = /^user-([1-9]\d{0,15})$/
// 一张图最大 64 MB（AiAssetStore 的上限）。暂存只是兜底，盘上、内存里各自有个总量上限，
// 超了就不再收：宁可这一张照旧丢掉，也不能把本来就快满的盘或者内存再撑爆。
const DEFAULT_MAXIMUM_DISK_BYTES = 512 * 1024 * 1024
const DEFAULT_MAXIMUM_MEMORY_BYTES = 128 * 1024 * 1024
// 软件开着时自己再试的间隔：越往后越疏，到 30 分钟封顶，都存好了就停。
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]

export type AiUnsavedImagePlace = 'disk' | 'memory'

export type AiUnsavedImageEvent =
  | { kind: 'kept'; userId: number; place: AiUnsavedImagePlace; bytes: number; diskError?: unknown }
  | { kind: 'dropped'; userId: number; bytes: number; diskError?: unknown }
  | { kind: 'restored'; userId: number; place: AiUnsavedImagePlace; assetId: string }
  | { kind: 'restore-failed'; userId: number; place: AiUnsavedImagePlace; error: unknown }

/** 补存去的地方：账号的作品库。两条都按内容定编号，同一张图补存两次也只有一份。 */
export interface AiUnsavedImageTarget {
  storeLocalFile(userId: number, filePath: string): Promise<AiStoredAsset>
  storeLocalBytes(userId: number, bytes: Buffer): Promise<AiStoredAsset>
}

export interface AiUnsavedImageStashOptions {
  /** 软件自己的数据文件夹里的一个子文件夹，按账号再分一层 user-<id>。 */
  root: string
  target: AiUnsavedImageTarget
  log?: (event: AiUnsavedImageEvent) => void
  maximumDiskBytes?: number
  maximumMemoryBytes?: number
  retryDelaysMs?: readonly number[]
  /** 过 delayMs 再跑一次补存；测试里换成假的，由测试决定什么时候跑。 */
  scheduleRetry?: (run: () => Promise<void>, delayMs: number) => void
}

interface MemoryEntry {
  key: string
  bytes: Buffer
}

export interface AiUnsavedImageLogEntry {
  level: 'info' | 'warn'
  event: string
  message: string
  detail: Record<string, unknown>
}

/** 运行日志里那一行：客服看得出图暂存在哪、补存好了没有、为什么没补存上。没有路径，没有图本身。 */
export function unsavedImageLogEntry(event: AiUnsavedImageEvent): AiUnsavedImageLogEntry {
  switch (event.kind) {
    case 'kept':
      return {
        level: 'warn',
        event: 'asset.unsaved.kept',
        message: event.place === 'disk'
          ? '付过费的图存不进作品库，已先暂存，腾出空间后自动补存'
          : '付过费的图存不进作品库，暂存文件夹也写不进，先留在内存里，软件开着时会再补存',
        detail: { userId: event.userId, place: event.place, bytes: event.bytes, ...(event.diskError ? { diskError: event.diskError } : {}) },
      }
    case 'dropped':
      return {
        level: 'warn',
        event: 'asset.unsaved.dropped',
        message: '付过费的图存不进作品库，暂存也放不下了，这张没能留住',
        detail: { userId: event.userId, bytes: event.bytes, ...(event.diskError ? { diskError: event.diskError } : {}) },
      }
    case 'restored':
      return {
        level: 'info',
        event: 'asset.unsaved.restored',
        message: '暂存的图已补存进作品库',
        detail: { userId: event.userId, place: event.place, assetId: event.assetId },
      }
    case 'restore-failed':
      return {
        level: 'warn',
        event: 'asset.unsaved.restore-failed',
        message: '暂存的图这次还没能补存进作品库，稍后再试',
        detail: { userId: event.userId, place: event.place, error: event.error },
      }
  }
}

function scheduleWithTimer(run: () => Promise<void>, delayMs: number): void {
  const timer = setTimeout(() => { void run() }, delayMs)
  // 只是兜底的补存，不该拖住软件退出。
  timer.unref?.()
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('暂存图片的账号标识格式错误')
}

/** 按内容起名：同一张图暂存两次只占一份，补存时也认得出是同一张。 */
export function stashedImageFileName(bytes: Buffer): string {
  const { extension } = inspectAiImage(bytes)
  return `${createHash('sha256').update(bytes).digest('hex')}.${extension}`
}

async function listStashedFiles(directory: string): Promise<Array<{ name: string; size: number }>> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: Array<{ name: string; size: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !STASHED_FILE_PATTERN.test(entry.name)) continue
    const stats = await fs.promises.lstat(path.join(directory, entry.name)).catch(() => null)
    if (stats?.isFile()) files.push({ name: entry.name, size: stats.size })
  }
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

/** 盘满了接着试下一张也是白试；别的原因（某一张坏了）只跳过这一张。 */
function stopsTheRound(error: unknown): boolean {
  return classifyStorageFailure(error) === 'disk-full'
}

export class AiUnsavedImageStash {
  private readonly root: string
  private readonly target: AiUnsavedImageTarget
  private readonly log: (event: AiUnsavedImageEvent) => void
  private readonly maximumDiskBytes: number
  private readonly maximumMemoryBytes: number
  private readonly retryDelaysMs: readonly number[]
  private readonly schedule: (run: () => Promise<void>, delayMs: number) => void
  private readonly memory = new Map<number, MemoryEntry[]>()
  private queue: Promise<unknown> = Promise.resolve()
  private retryPending = false
  private retryAttempt = 0

  constructor(options: AiUnsavedImageStashOptions) {
    this.root = path.resolve(options.root)
    this.target = options.target
    this.log = options.log ?? (() => undefined)
    this.maximumDiskBytes = options.maximumDiskBytes ?? DEFAULT_MAXIMUM_DISK_BYTES
    this.maximumMemoryBytes = options.maximumMemoryBytes ?? DEFAULT_MAXIMUM_MEMORY_BYTES
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.schedule = options.scheduleRetry ?? scheduleWithTimer
    if (this.retryDelaysMs.length === 0 || this.retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 1)) {
      throw new Error('暂存图片的重试间隔配置无效')
    }
  }

  /**
   * Keeps the bytes of a paid image that could not be stored. Never throws: it
   * runs while the store is already failing, and its own failure must not
   * replace the error the person reads. Returns where the bytes ended up, or
   * null when they could not be kept anywhere.
   */
  keep(userId: number, bytes: Buffer): Promise<AiUnsavedImagePlace | null> {
    return this.enqueue(async () => {
      assertUserId(userId)
      const fileName = stashedImageFileName(bytes)
      let diskError: unknown
      try {
        await this.keepOnDisk(userId, fileName, bytes)
        this.log({ kind: 'kept', userId, place: 'disk', bytes: bytes.length })
        this.scheduleRetry()
        return 'disk'
      } catch (error) {
        diskError = error
      }
      if (this.keepInMemory(userId, fileName, bytes)) {
        this.log({ kind: 'kept', userId, place: 'memory', bytes: bytes.length, diskError })
        this.scheduleRetry()
        return 'memory'
      }
      this.log({ kind: 'dropped', userId, bytes: bytes.length, diskError })
      return null
    }).catch(() => null)
  }

  /**
   * 把这个账号暂存着的图补存进作品库。不抛错，返回这次补存好了几张。还有没补存上的（登录时盘还满着、暂存文件夹一时读不了），
   * 软件开着时隔一阵接着试，不用等下次重开。
   */
  flush(userId: number): Promise<number> {
    return this.enqueue(async () => {
      const restored = await this.flushUser(userId)
      const pending = await this.pendingUserIds()
      if (pending.unreadable || pending.users.includes(userId)) this.scheduleRetry()
      return restored
    }).catch(() => 0)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private userDirectory(userId: number): string {
    return path.join(this.root, `user-${userId}`)
  }

  private async keepOnDisk(userId: number, fileName: string, bytes: Buffer): Promise<void> {
    const directory = this.userDirectory(userId)
    ensureSafeDataDirectory(this.root, FILE_LABEL)
    ensureSafeDataDirectory(directory, FILE_LABEL)
    const files = await listStashedFiles(directory)
    if (files.some((file) => file.name === fileName)) return
    const used = files.reduce((total, file) => total + file.size, 0)
    if (used + bytes.length > this.maximumDiskBytes) throw new Error('暂存的 AI 图片已经太多了')
    await writeAtomicSafeBinaryFile(path.join(directory, fileName), bytes, FILE_LABEL)
  }

  private keepInMemory(userId: number, key: string, bytes: Buffer): boolean {
    const entries = this.memory.get(userId) ?? []
    if (entries.some((entry) => entry.key === key)) return true
    let used = 0
    for (const list of this.memory.values()) for (const entry of list) used += entry.bytes.length
    if (used + bytes.length > this.maximumMemoryBytes) return false
    entries.push({ key, bytes })
    this.memory.set(userId, entries)
    return true
  }

  private async flushUser(userId: number): Promise<number> {
    assertUserId(userId)
    let restored = 0
    const entries = this.memory.get(userId) ?? []
    for (const entry of [...entries]) {
      try {
        const asset = await this.target.storeLocalBytes(userId, entry.bytes)
        entries.splice(entries.indexOf(entry), 1)
        restored += 1
        this.log({ kind: 'restored', userId, place: 'memory', assetId: asset.assetId })
      } catch (error) {
        this.log({ kind: 'restore-failed', userId, place: 'memory', error })
        if (stopsTheRound(error)) return restored
        // 一张存不进又不是盘满：留着它，接着试后面的，免得一张坏的把后面的都堵住。
      }
    }
    if (entries.length === 0) this.memory.delete(userId)
    const directory = this.userDirectory(userId)
    let files: Array<{ name: string; size: number }>
    try {
      files = await listStashedFiles(directory)
    } catch (error) {
      this.log({ kind: 'restore-failed', userId, place: 'disk', error })
      return restored
    }
    for (const file of files) {
      const filePath = path.join(directory, file.name)
      try {
        // storeLocalFile reads the file under the store's own checks (no links
        // or reparse points anywhere on the path, a single-link regular file,
        // bounded size, stable while read), so nothing planted in this folder
        // reaches the library unchecked (AGENTS.md I8).
        const asset = await this.target.storeLocalFile(userId, filePath)
        restored += 1
        this.log({ kind: 'restored', userId, place: 'disk', assetId: asset.assetId })
      } catch (error) {
        this.log({ kind: 'restore-failed', userId, place: 'disk', error })
        if (stopsTheRound(error)) return restored
        continue
      }
      // 作品库里已经有了才删：删不掉下次再补存一次，按内容认得出是同一张，不会多出一张。
      await removeSafeDataFile(filePath, FILE_LABEL).catch(() => undefined)
    }
    return restored
  }

  /**
   * 还有图等着补存的账号。暂存文件夹一时读不了（杀毒软件、同步盘正占着，一时没权限）说不清里面有没有，
   * 不能当它空了：读不了的那个账号照样算还有，整个暂存文件夹读不了就记 unreadable，隔一阵接着试
   * （11-18 复核 A05，总单 #62）。只有文件夹不在才是真没有。
   */
  private async pendingUserIds(): Promise<{ users: number[]; unreadable: boolean }> {
    const users = new Set<number>(this.memory.keys())
    let unreadable = false
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(this.root, { withFileTypes: true })
    } catch (error) {
      // 文件夹还没建过（从没暂存过）：只看内存里的。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = true
    }
    for (const entry of entries) {
      const match = entry.isDirectory() ? USER_DIRECTORY_PATTERN.exec(entry.name) : null
      if (!match) continue
      const files = await listStashedFiles(path.join(this.root, entry.name)).catch(() => null)
      if (files === null || files.length > 0) users.add(Number(match[1]))
    }
    return { users: [...users], unreadable }
  }

  private scheduleRetry(): void {
    if (this.retryPending) return
    this.retryPending = true
    const delay = this.retryDelaysMs[Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)]
    this.schedule(async () => {
      this.retryPending = false
      await this.retry()
    }, delay)
  }

  private async retry(): Promise<void> {
    const remaining = await this.enqueue(async () => {
      for (const userId of (await this.pendingUserIds()).users) await this.flushUser(userId)
      const pending = await this.pendingUserIds()
      return pending.users.length + (pending.unreadable ? 1 : 0)
    }).catch(() => 1)
    if (remaining === 0) {
      this.retryAttempt = 0
      return
    }
    this.retryAttempt += 1
    this.scheduleRetry()
  }
}
