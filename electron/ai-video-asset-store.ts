import fs from 'node:fs'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'
import { sameLocalPathIdentity } from './path-identity'
import { scopedLocalAssetId } from './content-addressed-asset'
import { inspectIsoBmffMediaMetadata } from './media-container-metadata'
import { indexOwnedAssetFiles, type AiAssetIndexEntry } from './ai-asset-index'

const FILE_LABEL = 'AI 视频资产'
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

async function readBoundedVideo(filePath: string, maximumBytes: number): Promise<Buffer> {
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
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error('AI 视频资产文件在读取过程中发生变化')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export class AiVideoAssetStore {
  private readonly outputRoot: string
  private readonly now: () => Date
  private readonly randomBytes: (size: number) => Buffer
  private readonly maximumVideoBytes: number
  private readonly nativeOperations: AiVideoAssetStoreOptions['nativeOperations']

  constructor(options: AiVideoAssetStoreOptions) {
    this.outputRoot = path.resolve(options.outputRoot)
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
      throw new Error('无法写入 output 目录，请检查安装目录写入权限')
    }
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
      if (error instanceof Error && error.message === 'AI 视频资产不存在或无权访问') return null
      throw error
    }
  }

  async readOwned(userId: number, assetId: string): Promise<AiVideoOwnedAssetRead> {
    assertUserId(userId)
    assertAssetId(assetId)
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let entries: fs.Dirent[]
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
      entries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch {
      throw new Error('AI 视频资产不存在或无权访问')
    }
    if (entries.length > 4_096) throw new Error('AI 视频资产目录条目过多')
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DATE_DIRECTORY_PATTERN.test(entry.name)) continue
      const fileName = `xingmang-${assetId}.mp4`
      const filePath = path.join(accountRoot, entry.name, fileName)
      try {
        const bytes = await readBoundedVideo(filePath, this.maximumVideoBytes)
        inspectMp4Video(bytes)
        return {
          asset: {
            assetId,
            localUrl: `xingmang-asset://video/${assetId}`,
            mimeType: 'video/mp4',
            fileName,
            ...inspectMp4VideoMetadata(bytes),
          },
          bytes,
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw new Error('AI 视频资产不存在或无权访问')
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
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let entries: fs.Dirent[]
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
      entries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch {
      throw new Error('AI 视频资产不存在或无权访问')
    }
    if (entries.length > 4_096) throw new Error('AI 视频资产目录条目过多')
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DATE_DIRECTORY_PATTERN.test(entry.name)) continue
      const filePath = path.join(accountRoot, entry.name, `xingmang-${assetId}.mp4`)
      let stats: fs.Stats
      try {
        assertNoReparseComponents(path.dirname(filePath), FILE_LABEL)
        stats = await fs.promises.lstat(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new Error('AI 视频资产必须是单链接普通文件')
      }
      if (!sameLocalPathIdentity(await fs.promises.realpath(filePath), filePath)) {
        throw new Error('AI 视频资产不能经过符号链接或目录联接')
      }
      return filePath
    }
    throw new Error('AI 视频资产不存在或无权访问')
  }

  async listOwnedIndex(userId: number): Promise<AiAssetIndexEntry[]> {
    assertUserId(userId)
    return indexOwnedAssetFiles({
      accountRoot: path.join(this.outputRoot, `user-${userId}`),
      mediaType: 'video',
      filePattern: /^xingmang-([A-Za-z0-9_-]{43})\.(mp4)$/,
      label: FILE_LABEL,
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

  async saveAs(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<boolean> {
    if (!this.nativeOperations) throw new Error('当前环境不支持视频另存为')
    const owned = await this.readOwned(userId, assetId)
    const target = await this.nativeOperations.selectSavePath(owned.asset.fileName)
    if (!target) return false
    await authorize?.()
    if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('视频另存地址无效')
    await fs.promises.writeFile(target, owned.bytes).catch(() => { throw new Error('视频另存失败，请检查目标目录写入权限') })
    return true
  }

  async revealInFolder(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (!this.nativeOperations) throw new Error('当前环境不支持在文件夹中定位')
    const owned = await this.readOwned(userId, assetId)
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    const dateEntries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    const entry = dateEntries.find((candidate) => candidate.isDirectory()
      && DATE_DIRECTORY_PATTERN.test(candidate.name)
      && fs.existsSync(path.join(accountRoot, candidate.name, owned.asset.fileName)))
    if (!entry) throw new Error('AI 视频资产不存在或无权访问')
    const filePath = path.join(accountRoot, entry.name, owned.asset.fileName)
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
