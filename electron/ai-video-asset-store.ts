import fs from 'node:fs'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { assertNoReparseComponents, ensureSafeDataDirectory, removeSafeDataFile, writeAtomicSafeBinaryFile } from './safe-local-data'
import { sameLocalPathIdentity } from './path-identity'
import { resolveRelocatedPath } from './relocated-folders'
import { scopedLocalAssetId } from './content-addressed-asset'
import { inspectIsoBmffMediaMetadata } from './media-container-metadata'
import { indexOwnedAssetFiles, type AiAssetIndexEntry } from './ai-asset-index'
import { OwnedAssetLocator } from './ai-asset-locator'
import { missingAiAssetMessages } from './ai-asset-missing'
import type { ByteRange } from './byte-range'

const FILE_LABEL = 'AI 视频资产'
const MISSING_ASSET_MESSAGE = missingAiAssetMessages.video
// 另存出去的是用户自己的文件，不是本程序的私有数据：权限位照原来 writeFile 在常见 umask
// 下的结果给 0o644，不用原子写默认的 0o600。
const SAVED_COPY_FILE_MODE = 0o644
const DEFAULT_MAXIMUM_VIDEO_BYTES = 512 * 1024 * 1024
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export interface AiStoredVideoAsset {
  assetId: string
  localUrl: string
  mimeType: 'video/mp4'
  fileName: string
  taskId?: string
  width?: number
  height?: number
  durationSeconds?: number
}

export interface AiVideoOwnedAssetRead {
  asset: AiStoredVideoAsset
  bytes: Buffer
}

export interface AiVideoOwnedRangeRead {
  asset: { mimeType: 'video/mp4' }
  /** Size of the whole verified file. */
  totalBytes: number
  /** Only the bytes the caller selected; empty when it selected none. */
  bytes: Buffer
}

export interface AiStoredVideoAssetListItem extends AiStoredVideoAsset {
  createdAt: string
  mediaType: 'video'
  thumbnailUrl: string
}

export interface AiVideoAssetStoreOptions {
  outputRoot: string
  now?: () => Date
  randomBytes?: (size: number) => Buffer
  maximumVideoBytes?: number
  nativeOperations?: {
    selectSavePath(suggestedFileName: string): Promise<string | null>
    revealInFolder(filePath: string): void | Promise<void>
    showContextMenu(items: ReadonlyArray<{ id: string; label: string; run(): Promise<void> }>): void | Promise<void>
  }
}

function assertUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('AI 视频账号标识格式错误')
}

function assertAssetId(value: string): void {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) throw new Error('AI 视频资产标识无效')
}

function dateDirectoryName(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('AI 视频保存日期无效')
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
    .join('-')
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function inspectMp4Video(bytes: Buffer, declaredMime?: string | null): { mimeType: 'video/mp4'; extension: 'mp4' } {
  if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('视频内容无效，仅支持 MP4')
  const mime = declaredMime?.split(';', 1)[0].trim().toLowerCase()
  if (mime && mime !== 'video/mp4' && mime !== 'application/octet-stream') {
    throw new Error('视频响应 MIME 与实际内容不一致')
  }
  return { mimeType: 'video/mp4', extension: 'mp4' }
}

export function inspectMp4VideoMetadata(bytes: Buffer): Pick<AiStoredVideoAsset, 'width' | 'height' | 'durationSeconds'> {
  const container = inspectIsoBmffMediaMetadata(bytes)
  const durationSeconds = container.durationSeconds ?? container.video?.durationSeconds
  return {
    ...(container.video?.width ? { width: container.video.width } : {}),
    ...(container.video?.height ? { height: container.video.height } : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
  }
}

/**
 * Opens an owned video and runs `read` on the handle only after the handle and
 * the path are proven to be the same single-link regular file, inside the size
 * bound; the read is rejected if the file changed while it ran. Whole-file and
 * ranged reads share this, so a ranged read never skips a check.
 */
async function withVerifiedVideo<T>(requestedPath: string, maximumBytes: number, read: (handle: fs.promises.FileHandle, size: number) => Promise<T>): Promise<T> {
  // 「文档」被搬到别的盘时按实际位置核对，否则 realpath 与原路径永远对不上（relocated-folders.ts）。
  const filePath = resolveRelocatedPath(requestedPath)
  assertNoReparseComponents(filePath, FILE_LABEL)
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximumBytes)) {
      throw new Error('AI 视频资产文件无效或超过安全上限')
    }
    const current = await fs.promises.lstat(filePath, { bigint: true })
    const canonical = await fs.promises.realpath(filePath)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
      || current.dev !== before.dev || current.ino !== before.ino || !sameLocalPathIdentity(canonical, filePath)) {
      throw new Error('AI 视频资产文件在读取前发生变化')
    }
    const result = await read(handle, Number(before.size))
    const after = await handle.stat({ bigint: true })
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error('AI 视频资产文件在读取过程中发生变化')
    }
    return result
  } finally {
    await handle.close()
  }
}

async function readBoundedVideo(requestedPath: string, maximumBytes: number): Promise<Buffer> {
  return withVerifiedVideo(requestedPath, maximumBytes, (handle) => handle.readFile())
}

/** Reads exactly `length` bytes at `position`; a short read means the file changed under us. */
async function readExactly(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) throw new Error('AI 视频资产文件在读取过程中发生变化')
    filled += bytesRead
  }
  return buffer
}

/**
 * The ranged counterpart of readBoundedVideo: the same checks, the same MP4
 * signature check on the file's first bytes, then only the selected range.
 */
async function readBoundedVideoRange(requestedPath: string, maximumBytes: number, select: (totalBytes: number) => ByteRange | null): Promise<{ totalBytes: number, bytes: Buffer }> {
  return withVerifiedVideo(requestedPath, maximumBytes, async (handle, totalBytes) => {
    inspectMp4Video(await readExactly(handle, 0, Math.min(16, totalBytes)))
    const range = select(totalBytes)
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= totalBytes)) {
      throw new Error('AI 视频资产读取范围无效')
    }
    return { totalBytes, bytes: range ? await readExactly(handle, range.start, range.end - range.start + 1) : Buffer.alloc(0) }
  })
}

export class AiVideoAssetStore {
  private readonly outputRoot: string
  private readonly now: () => Date
  private readonly randomBytes: (size: number) => Buffer
  private readonly maximumVideoBytes: number
  private readonly nativeOperations: AiVideoAssetStoreOptions['nativeOperations']
  private readonly locator: OwnedAssetLocator

  constructor(options: AiVideoAssetStoreOptions) {
    this.outputRoot = path.resolve(options.outputRoot)
    this.locator = new OwnedAssetLocator({ outputRoot: this.outputRoot, extensions: ['mp4'], label: FILE_LABEL })
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
    this.maximumVideoBytes = options.maximumVideoBytes ?? DEFAULT_MAXIMUM_VIDEO_BYTES
    this.nativeOperations = options.nativeOperations
    if (!Number.isSafeInteger(this.maximumVideoBytes) || this.maximumVideoBytes < 1
      || this.maximumVideoBytes > DEFAULT_MAXIMUM_VIDEO_BYTES) throw new Error('AI 视频大小上限配置无效')
  }

  async storeMp4(userId: number, bytes: Buffer, metadata: { taskId: string }): Promise<AiStoredVideoAsset> {
    assertUserId(userId)
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maximumVideoBytes) throw new Error('视频超过 512 MB 安全上限')
    inspectMp4Video(bytes)
    if (!TASK_ID_PATTERN.test(metadata.taskId)) throw new Error('AI 视频任务标识格式错误')
    return this.storeBytes(userId, bytes, metadata)
  }

  /** 视频剪辑页在本机拼好的成片：没有服务端任务，存法和出的片段一样。 */
  async storeComposed(userId: number, bytes: Buffer): Promise<AiStoredVideoAsset> {
    assertUserId(userId)
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maximumVideoBytes) throw new Error('视频超过 512 MB 安全上限')
    inspectMp4Video(bytes)
    return this.storeBytes(userId, bytes, {})
  }

  async storeLocalFile(userId: number, sourcePath: string): Promise<AiStoredVideoAsset> {
    assertUserId(userId)
    if (!path.isAbsolute(sourcePath) || sourcePath.includes('\0')) throw new Error('本地视频路径无效')
    const bytes = await readBoundedVideo(sourcePath, this.maximumVideoBytes)
    inspectMp4Video(bytes)
    return this.storeBytes(userId, bytes, {}, scopedLocalAssetId(this.outputRoot, userId, bytes))
  }

  private async storeBytes(
    userId: number,
    bytes: Buffer,
    metadata: { taskId?: string },
    preferredAssetId?: string,
  ): Promise<AiStoredVideoAsset> {
    const assetId = preferredAssetId ?? this.randomBytes(32).toString('base64url')
    assertAssetId(assetId)
    if (preferredAssetId) {
      const existing = await this.readMatchingContent(userId, assetId, bytes)
      if (existing) return existing
    }
    const fileName = `xingmang-${assetId}.mp4`
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    const directory = path.join(accountRoot, dateDirectoryName(this.now()))
    const filePath = path.join(directory, fileName)
    if (!pathIsWithin(this.outputRoot, filePath) || !pathIsWithin(accountRoot, filePath)) throw new Error('AI 视频输出路径越界')
    const temporaryPath = path.join(directory, `.${fileName}.${this.randomBytes(16).toString('hex')}.tmp`)
    let linked = false
    try {
      ensureSafeDataDirectory(this.outputRoot, FILE_LABEL)
      ensureSafeDataDirectory(accountRoot, FILE_LABEL)
      ensureSafeDataDirectory(directory, FILE_LABEL)
      const handle = await fs.promises.open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.promises.link(temporaryPath, filePath)
      linked = true
      await fs.promises.rm(temporaryPath)
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
      if (linked) await fs.promises.rm(filePath, { force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && preferredAssetId) {
        const existing = await this.readMatchingContent(userId, assetId, bytes)
        if (existing) return existing
        throw new Error('AI 视频内容摘要冲突')
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('AI 视频资产标识冲突，请重试')
      // 原因挂在 cause 上：出片那边要靠它认出是盘满了（D38），换一句「已经扣费、别重新生成」。
      throw new Error('作品没能存进保存位置，请稍后重试；一直不行请联系客服', { cause: error })
    }
    this.locator.remember(userId, assetId, filePath)
    return {
      assetId,
      localUrl: `xingmang-asset://video/${assetId}`,
      mimeType: 'video/mp4',
      fileName,
      ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
      ...inspectMp4VideoMetadata(bytes),
    }
  }

  private async readMatchingContent(userId: number, assetId: string, bytes: Buffer): Promise<AiStoredVideoAsset | null> {
    try {
      const existing = await this.readOwned(userId, assetId)
      if (!existing.bytes.equals(bytes)) throw new Error('AI 视频内容摘要冲突')
      return existing.asset
    } catch (error) {
      if (error instanceof Error && error.message === MISSING_ASSET_MESSAGE) return null
      throw error
    }
  }

  async readOwned(userId: number, assetId: string): Promise<AiVideoOwnedAssetRead> {
    assertUserId(userId)
    assertAssetId(assetId)
    const filePath = await this.locateOwned(userId, assetId)
    let bytes: Buffer
    try {
      bytes = await readBoundedVideo(filePath, this.maximumVideoBytes)
    } catch (error) {
      throw this.missingIfGone(assetId, error)
    }
    inspectMp4Video(bytes)
    return {
      asset: {
        assetId,
        localUrl: `xingmang-asset://video/${assetId}`,
        mimeType: 'video/mp4',
        fileName: path.basename(filePath),
        ...inspectMp4VideoMetadata(bytes),
      },
      bytes,
    }
  }

  /**
   * Reads just the byte range `select` picks once the verified size is known,
   * for the asset protocol: a player seeking through a long video would
   * otherwise pull the whole file into memory on every seek. Ownership and
   * file checks are the ones readOwned applies; no metadata is parsed.
   */
  async readOwnedRange(userId: number, assetId: string, select: (totalBytes: number) => ByteRange | null): Promise<AiVideoOwnedRangeRead> {
    assertUserId(userId)
    assertAssetId(assetId)
    const filePath = await this.locateOwned(userId, assetId)
    try {
      return { asset: { mimeType: 'video/mp4' }, ...await readBoundedVideoRange(filePath, this.maximumVideoBytes, select) }
    } catch (error) {
      throw this.missingIfGone(assetId, error)
    }
  }

  /**
   * Resolves the absolute path of an owned video after the same ownership and
   * reparse checks `readOwned` performs, for callers that must hand a path to a
   * platform decoder instead of buffering the whole file. The path stays inside
   * the main process: no renderer ever receives one.
   */
  async resolveOwnedFilePath(userId: number, assetId: string): Promise<string> {
    assertUserId(userId)
    assertAssetId(assetId)
    const filePath = await this.locateOwned(userId, assetId)
    let stats: fs.Stats
    try {
      assertNoReparseComponents(path.dirname(filePath), FILE_LABEL)
      stats = await fs.promises.lstat(filePath)
    } catch (error) {
      throw this.missingIfGone(assetId, error)
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error('AI 视频资产必须是单链接普通文件')
    }
    if (!sameLocalPathIdentity(await fs.promises.realpath(filePath), resolveRelocatedPath(filePath))) {
      throw new Error('AI 视频资产不能经过符号链接或目录联接')
    }
    return filePath
  }

  /** Where the file is; every caller still runs the full file checks on it. */
  private async locateOwned(userId: number, assetId: string): Promise<string> {
    const filePath = await this.locator.locate(userId, assetId)
    if (!filePath) throw new Error(MISSING_ASSET_MESSAGE)
    return filePath
  }

  /** A located file that vanished before it was opened is a missing asset, not a raw file-system error. */
  private missingIfGone(assetId: string, error: unknown): unknown {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return error
    this.locator.forget(assetId)
    return new Error(MISSING_ASSET_MESSAGE)
  }

  async removeOwned(userId: number, assetId: string): Promise<void> {
    const filePath = await this.resolveOwnedFilePath(userId, assetId)
    await readBoundedVideo(filePath, this.maximumVideoBytes)
    await removeSafeDataFile(filePath, FILE_LABEL)
    this.locator.forget(assetId)
  }

  async listOwnedIndex(userId: number): Promise<AiAssetIndexEntry[]> {
    assertUserId(userId)
    return indexOwnedAssetFiles({
      accountRoot: path.join(this.outputRoot, `user-${userId}`),
      mediaType: 'video',
      filePattern: /^xingmang-([A-Za-z0-9_-]{43})\.(mp4)$/,
      label: FILE_LABEL,
      onFile: (assetId, filePath) => this.locator.remember(userId, assetId, filePath),
    })
  }

  async listOwned(userId: number, maximum = 500): Promise<AiStoredVideoAssetListItem[]> {
    assertUserId(userId)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500) throw new Error('AI 视频列表数量无效')
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let entries: fs.Dirent[]
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
      entries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('无法读取 AI 视频资产目录')
    }
    if (entries.length > 4_096) throw new Error('AI 视频资产目录条目过多')
    const results: AiStoredVideoAssetListItem[] = []
    const seenContent = new Map<string, number>()
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      if (results.length >= maximum) break
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DATE_DIRECTORY_PATTERN.test(entry.name)) continue
      const directory = path.join(accountRoot, entry.name)
      assertNoReparseComponents(directory, FILE_LABEL)
      const files = await fs.promises.readdir(directory, { withFileTypes: true })
      if (files.length > 4_096) throw new Error('AI 视频资产目录条目过多')
      for (const file of files.sort((left, right) => right.name.localeCompare(left.name))) {
        const match = file.name.match(/^xingmang-([A-Za-z0-9_-]{43})\.mp4$/)
        if (!match || !file.isFile() || file.isSymbolicLink()) continue
        try {
          const filePath = path.join(directory, file.name)
          const bytes = await readBoundedVideo(filePath, this.maximumVideoBytes)
          inspectMp4Video(bytes)
          const mediaMetadata = inspectMp4VideoMetadata(bytes)
          const canonicalAssetId = scopedLocalAssetId(this.outputRoot, userId, bytes)
          const stat = await fs.promises.lstat(filePath)
          const listedAsset: AiStoredVideoAssetListItem = {
            assetId: match[1], localUrl: `xingmang-asset://video/${match[1]}`,
            mimeType: 'video/mp4', fileName: file.name, createdAt: stat.birthtime.toISOString(),
            mediaType: 'video', thumbnailUrl: `xingmang-asset://video/${match[1]}`,
            ...mediaMetadata,
          }
          const existingIndex = seenContent.get(canonicalAssetId)
          if (existingIndex !== undefined) {
            if (listedAsset.assetId === canonicalAssetId) results[existingIndex] = listedAsset
            continue
          }
          seenContent.set(canonicalAssetId, results.length)
          results.push(listedAsset)
          if (results.length >= maximum) break
        } catch {
          // Missing and damaged files are omitted from the list.
        }
      }
    }
    return results
  }

  /** suggestedFileName 只是系统对话框里的默认文件名（调用方先洗干净），存到哪儿由用户在对话框里点。 */
  async saveAs(userId: number, assetId: string, authorize?: () => void | Promise<void>, suggestedFileName?: string): Promise<boolean> {
    if (!this.nativeOperations) throw new Error('当前环境不支持视频另存为')
    const owned = await this.readOwned(userId, assetId)
    const target = await this.nativeOperations.selectSavePath(suggestedFileName ?? owned.asset.fileName)
    if (!target) return false
    await authorize?.()
    if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('视频另存地址无效')
    await writeAtomicSafeBinaryFile(target, owned.bytes, '视频另存文件', { mode: SAVED_COPY_FILE_MODE })
      .catch(() => { throw new Error('视频另存失败，请检查目标目录写入权限') })
    return true
  }

  async revealInFolder(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (!this.nativeOperations) throw new Error('当前环境不支持在文件夹中定位')
    await this.readOwned(userId, assetId)
    // The path handed to the OS gets the same checks as every other one,
    // instead of a second pass over the date folders with a synchronous
    // exists check in each.
    const filePath = await this.resolveOwnedFilePath(userId, assetId)
    await authorize?.()
    await this.nativeOperations.revealInFolder(filePath)
  }

  async contextMenu(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (!this.nativeOperations) throw new Error('当前环境不支持视频右键菜单')
    await this.readOwned(userId, assetId)
    await this.nativeOperations.showContextMenu([
      { id: 'save-as', label: '视频另存为', run: async () => { await this.saveAs(userId, assetId, authorize) } },
      { id: 'reveal-in-folder', label: '在文件夹中显示', run: () => this.revealInFolder(userId, assetId, authorize) },
    ])
  }
}
