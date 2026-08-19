import path from 'node:path'
import fs from 'node:fs'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'
import { sameLocalPathIdentity } from './path-identity'
import { scopedLocalAssetId } from './content-addressed-asset'
import { inspectIsoBmffMediaMetadata, inspectWaveDurationSeconds } from './media-container-metadata'
import { indexOwnedAssetFiles, type AiAssetIndexEntry } from './ai-asset-index'

const FILE_LABEL = 'AI 音频资产'
const DEFAULT_MAXIMUM_AUDIO_BYTES = 128 * 1024 * 1024
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type AiAudioMimeType = 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/mp4'

export interface AiStoredAudioAsset {
  assetId: string
  localUrl: string
  mimeType: AiAudioMimeType
  fileName: string
  durationSeconds?: number
}

export interface AiStoredAudioAssetListItem extends AiStoredAudioAsset {
  createdAt: string
  mediaType: 'audio'
  thumbnailUrl: string
}

export interface AiAudioOwnedAssetRead {
  asset: AiStoredAudioAsset
  bytes: Buffer
}

export interface AiAudioAssetStoreOptions {
  outputRoot: string
  now?: () => Date
  randomBytes?: (size: number) => Buffer
  maximumAudioBytes?: number
  nativeOperations?: {
    selectSavePath(suggestedFileName: string): Promise<string | null>
    revealInFolder(filePath: string): void | Promise<void>
    showContextMenu(items: ReadonlyArray<{ id: string; label: string; run(): Promise<void> }>): void | Promise<void>
  }
}

function assertUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('AI 音频账号标识格式错误')
}

function assertAssetId(value: string): void {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) throw new Error('AI 音频资产标识无效')
}

function dateDirectoryName(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('AI 音频保存日期无效')
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
    .join('-')
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function inspectAudio(bytes: Buffer, declaredMime?: string | null): { mimeType: AiAudioMimeType; extension: 'mp3' | 'wav' | 'ogg' | 'm4a' } {
  const mime = declaredMime?.split(';', 1)[0].trim().toLowerCase()
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    if (mime && mime !== 'audio/wav' && mime !== 'audio/x-wav' && mime !== 'application/octet-stream') throw new Error('音频 MIME 与实际内容不一致')
    return { mimeType: 'audio/wav', extension: 'wav' }
  }
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') {
    if (mime && mime !== 'audio/ogg' && mime !== 'application/ogg' && mime !== 'application/octet-stream') throw new Error('音频 MIME 与实际内容不一致')
    return { mimeType: 'audio/ogg', extension: 'ogg' }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    if (mime && !['audio/mp4', 'audio/x-m4a', 'video/mp4', 'application/octet-stream'].includes(mime)) throw new Error('音频 MIME 与实际内容不一致')
    return { mimeType: 'audio/mp4', extension: 'm4a' }
  }
  const isId3 = bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3'
  const isMp3Frame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
  if (isId3 || isMp3Frame) {
    if (mime && !['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(mime)) throw new Error('音频 MIME 与实际内容不一致')
    return { mimeType: 'audio/mpeg', extension: 'mp3' }
  }
  throw new Error('音频内容无效，仅支持 MP3、WAV、OGG、M4A')
}

export function inspectAudioMetadata(
  bytes: Buffer,
  mimeTypeInput?: AiAudioMimeType,
): Pick<AiStoredAudioAsset, 'durationSeconds'> {
  const mimeType = mimeTypeInput ?? inspectAudio(bytes).mimeType
  const container = mimeType === 'audio/mp4' ? inspectIsoBmffMediaMetadata(bytes) : undefined
  const durationSeconds = mimeType === 'audio/wav'
    ? inspectWaveDurationSeconds(bytes)
    : container?.audioDurationSeconds ?? container?.durationSeconds
  return durationSeconds ? { durationSeconds } : {}
}

async function readBoundedAudio(filePath: string, maximumBytes: number): Promise<Buffer> {
  assertNoReparseComponents(filePath, FILE_LABEL)
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximumBytes)) throw new Error('AI 音频资产文件无效或超过安全上限')
    const current = await fs.promises.lstat(filePath, { bigint: true })
    const canonical = await fs.promises.realpath(filePath)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino || !sameLocalPathIdentity(canonical, filePath)) {
      throw new Error('AI 音频资产文件在读取前发生变化')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('AI 音频资产文件在读取过程中发生变化')
    return bytes
  } finally {
    await handle.close()
  }
}

export class AiAudioAssetStore {
  private readonly outputRoot: string
  private readonly now: () => Date
  private readonly randomBytes: (size: number) => Buffer
  private readonly maximumAudioBytes: number
  private readonly nativeOperations: AiAudioAssetStoreOptions['nativeOperations']

  constructor(options: AiAudioAssetStoreOptions) {
    this.outputRoot = path.resolve(options.outputRoot)
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
    this.maximumAudioBytes = options.maximumAudioBytes ?? DEFAULT_MAXIMUM_AUDIO_BYTES
    this.nativeOperations = options.nativeOperations
    if (!Number.isSafeInteger(this.maximumAudioBytes) || this.maximumAudioBytes < 1 || this.maximumAudioBytes > DEFAULT_MAXIMUM_AUDIO_BYTES) throw new Error('AI 音频大小上限配置无效')
  }

  async storeLocalFile(userId: number, sourcePath: string): Promise<AiStoredAudioAsset> {
    assertUserId(userId)
    if (!path.isAbsolute(sourcePath) || sourcePath.includes('\0')) throw new Error('本地音频路径无效')
    const bytes = await readBoundedAudio(sourcePath, this.maximumAudioBytes)
    const inspection = inspectAudio(bytes)
    return this.storeBytes(userId, bytes, inspection, scopedLocalAssetId(this.outputRoot, userId, bytes))
  }

  private async storeBytes(userId: number, bytes: Buffer, inspection: ReturnType<typeof inspectAudio>, preferredAssetId?: string): Promise<AiStoredAudioAsset> {
    const assetId = preferredAssetId ?? this.randomBytes(32).toString('base64url')
    assertAssetId(assetId)
    if (preferredAssetId) {
      const existing = await this.readMatchingContent(userId, assetId, bytes)
      if (existing) return existing
    }
    const fileName = `xingmang-${assetId}.${inspection.extension}`
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    const directory = path.join(accountRoot, dateDirectoryName(this.now()))
    const filePath = path.join(directory, fileName)
    if (!pathIsWithin(this.outputRoot, filePath) || !pathIsWithin(accountRoot, filePath)) throw new Error('AI 音频输出路径越界')
    const temporaryPath = path.join(directory, `.${fileName}.${this.randomBytes(16).toString('hex')}.tmp`)
    let linked = false
    try {
      ensureSafeDataDirectory(this.outputRoot, FILE_LABEL)
      ensureSafeDataDirectory(accountRoot, FILE_LABEL)
      ensureSafeDataDirectory(directory, FILE_LABEL)
      const handle = await fs.promises.open(temporaryPath, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await fs.promises.link(temporaryPath, filePath)
      linked = true
      await fs.promises.rm(temporaryPath)
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
      if (linked) await fs.promises.rm(filePath, { force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && preferredAssetId) {
        const existing = await this.readMatchingContent(userId, assetId, bytes)
        if (existing) return existing
        throw new Error('AI 音频内容摘要冲突')
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('AI 音频资产标识冲突，请重试')
      throw new Error('无法写入 output 目录，请检查安装目录写入权限')
    }
    return {
      assetId,
      localUrl: `xingmang-asset://audio/${assetId}`,
      mimeType: inspection.mimeType,
      fileName,
      ...inspectAudioMetadata(bytes, inspection.mimeType),
    }
  }

  private async readMatchingContent(userId: number, assetId: string, bytes: Buffer): Promise<AiStoredAudioAsset | null> {
    try {
      const existing = await this.readOwned(userId, assetId)
      if (!existing.bytes.equals(bytes)) throw new Error('AI 音频内容摘要冲突')
      return existing.asset
    } catch (error) {
      if (error instanceof Error && error.message === 'AI 音频资产不存在或无权访问') return null
      throw error
    }
  }

  async readOwned(userId: number, assetId: string): Promise<AiAudioOwnedAssetRead> {
    assertUserId(userId)
    assertAssetId(assetId)
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let entries: fs.Dirent[]
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
      entries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch { throw new Error('AI 音频资产不存在或无权访问') }
    if (entries.length > 4_096) throw new Error('AI 音频资产目录条目过多')
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DATE_DIRECTORY_PATTERN.test(entry.name)) continue
      assertNoReparseComponents(path.join(accountRoot, entry.name), FILE_LABEL)
      for (const extension of ['mp3', 'wav', 'ogg', 'm4a']) {
        const fileName = `xingmang-${assetId}.${extension}`
        const filePath = path.join(accountRoot, entry.name, fileName)
        try {
          const bytes = await readBoundedAudio(filePath, this.maximumAudioBytes)
          const inspection = inspectAudio(bytes)
          return {
            asset: {
              assetId,
              localUrl: `xingmang-asset://audio/${assetId}`,
              mimeType: inspection.mimeType,
              fileName,
              ...inspectAudioMetadata(bytes, inspection.mimeType),
            },
            bytes,
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
    throw new Error('AI 音频资产不存在或无权访问')
  }

  async listOwnedIndex(userId: number): Promise<AiAssetIndexEntry[]> {
    assertUserId(userId)
    return indexOwnedAssetFiles({
      accountRoot: path.join(this.outputRoot, `user-${userId}`),
      mediaType: 'audio',
      filePattern: /^xingmang-([A-Za-z0-9_-]{43})\.(mp3|wav|ogg|m4a)$/,
      label: FILE_LABEL,
    })
  }

  async listOwned(userId: number, maximum = 500): Promise<AiStoredAudioAssetListItem[]> {
    assertUserId(userId)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500) throw new Error('AI 音频列表数量无效')
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let entries: fs.Dirent[]
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
      entries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('无法读取 AI 音频资产目录')
    }
    if (entries.length > 4_096) throw new Error('AI 音频资产目录条目过多')
    const results: AiStoredAudioAssetListItem[] = []
    const seenContent = new Map<string, number>()
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DATE_DIRECTORY_PATTERN.test(entry.name)) continue
      const directory = path.join(accountRoot, entry.name)
      assertNoReparseComponents(directory, FILE_LABEL)
      const files = await fs.promises.readdir(directory, { withFileTypes: true })
      if (files.length > 4_096) throw new Error('AI 音频资产目录条目过多')
      for (const file of files.sort((left, right) => right.name.localeCompare(left.name))) {
        const match = file.name.match(/^xingmang-([A-Za-z0-9_-]{43})\.(mp3|wav|ogg|m4a)$/)
        if (!match || !file.isFile() || file.isSymbolicLink()) continue
        try {
          const filePath = path.join(directory, file.name)
          const bytes = await readBoundedAudio(filePath, this.maximumAudioBytes)
          const inspection = inspectAudio(bytes)
          const mediaMetadata = inspectAudioMetadata(bytes, inspection.mimeType)
          const canonicalAssetId = scopedLocalAssetId(this.outputRoot, userId, bytes)
          const stat = await fs.promises.lstat(filePath)
          const listedAsset = {
            assetId: match[1],
            localUrl: `xingmang-asset://audio/${match[1]}`,
            mimeType: inspection.mimeType,
            fileName: file.name,
            createdAt: stat.birthtime.toISOString(),
            mediaType: 'audio' as const,
            thumbnailUrl: `xingmang-asset://audio/${match[1]}`,
            ...mediaMetadata,
          }
          const existingIndex = seenContent.get(canonicalAssetId)
          if (existingIndex !== undefined) {
            if (listedAsset.assetId === canonicalAssetId) results[existingIndex] = listedAsset
            continue
          }
          seenContent.set(canonicalAssetId, results.length)
          results.push(listedAsset)
          if (results.length >= maximum) return results
        } catch { /* Damaged files stay hidden. */ }
      }
    }
    return results
  }

  async saveAs(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<boolean> {
    if (!this.nativeOperations) throw new Error('当前环境不支持音频另存为')
    const owned = await this.readOwned(userId, assetId)
    const target = await this.nativeOperations.selectSavePath(owned.asset.fileName)
    if (!target) return false
    await authorize?.()
    if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('音频另存地址无效')
    await fs.promises.writeFile(target, owned.bytes).catch(() => { throw new Error('音频另存失败，请检查目标目录写入权限') })
    return true
  }

  async revealInFolder(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (!this.nativeOperations) throw new Error('当前环境不支持在文件夹中定位')
    const owned = await this.readOwned(userId, assetId)
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    const dateEntries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    const entry = dateEntries.find((candidate) => candidate.isDirectory() && DATE_DIRECTORY_PATTERN.test(candidate.name) && fs.existsSync(path.join(accountRoot, candidate.name, owned.asset.fileName)))
    if (!entry) throw new Error('AI 音频资产不存在或无权访问')
    await authorize?.()
    await this.nativeOperations.revealInFolder(path.join(accountRoot, entry.name, owned.asset.fileName))
  }

  async contextMenu(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (!this.nativeOperations) throw new Error('当前环境不支持音频右键菜单')
    await this.readOwned(userId, assetId)
    await this.nativeOperations.showContextMenu([
      { id: 'save-as', label: '音频另存为', run: async () => { await this.saveAs(userId, assetId, authorize) } },
      { id: 'reveal-in-folder', label: '在文件夹中显示', run: () => this.revealInFolder(userId, assetId, authorize) },
    ])
  }
}
