import fs from 'node:fs'
import path from 'node:path'
import { assertNoReparseComponents, ensureSafeDataDirectory, writeAtomicSafeBinaryFile } from './safe-local-data'
import { readBoundedFile } from './bounded-file'
import {
  assetThumbnailFileName,
  assetThumbnailVersion,
  type AssetThumbnailMimeType,
} from './asset-thumbnail'

const FILE_LABEL = 'AI 素材缩略图'
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * A contained 320 pixel derived image is a few tens of kilobytes. Anything past
 * one megabyte is not a thumbnail, so refuse to read or write it rather than
 * letting a corrupted cache entry back into memory.
 */
export const MAXIMUM_THUMBNAIL_BYTES = 1024 * 1024

export interface StoredAssetThumbnail {
  bytes: Buffer
  mimeType: AssetThumbnailMimeType
}

/**
 * On-disk cache of derived thumbnails, laid out as
 * `<root>/user-<id>/<version>/<assetId>.<ext>`.
 *
 * The version segment matches the one in the request URL, so bumping the
 * pipeline version orphans the previous generation in one step instead of
 * needing a migration. Asset identifiers are content addressed, which is what
 * makes the served responses safe to mark immutable.
 */
export class AssetThumbnailStore {
  private readonly cacheRoot: string

  constructor(options: { cacheRoot: string }) {
    this.cacheRoot = path.resolve(options.cacheRoot)
  }

  private directory(userId: number): string {
    return path.join(this.cacheRoot, `user-${userId}`, assetThumbnailVersion)
  }

  private candidatePaths(userId: number, assetId: string): Array<{ filePath: string; mimeType: AssetThumbnailMimeType }> {
    const directory = this.directory(userId)
    return (['image/png', 'image/jpeg'] as const).map((mimeType) => ({
      filePath: path.join(directory, assetThumbnailFileName(assetId, mimeType)),
      mimeType,
    }))
  }

  async read(userId: number, assetId: string): Promise<StoredAssetThumbnail | null> {
    assertCacheKey(userId, assetId)
    for (const candidate of this.candidatePaths(userId, assetId)) {
      try {
        return { bytes: await readBoundedFile(candidate.filePath, MAXIMUM_THUMBNAIL_BYTES, FILE_LABEL), mimeType: candidate.mimeType }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        // A damaged or tampered cache entry must not fail the request: the
        // caller can always regenerate from the original asset.
        return null
      }
    }
    return null
  }

  async write(userId: number, assetId: string, thumbnail: StoredAssetThumbnail): Promise<void> {
    assertCacheKey(userId, assetId)
    if (thumbnail.bytes.byteLength === 0) throw new Error(`${FILE_LABEL}内容为空`)
    if (thumbnail.bytes.byteLength > MAXIMUM_THUMBNAIL_BYTES) throw new Error(`${FILE_LABEL}超过安全上限`)
    const directory = this.directory(userId)
    ensureSafeDataDirectory(directory, FILE_LABEL)
    await writeAtomicSafeBinaryFile(path.join(directory, assetThumbnailFileName(assetId, thumbnail.mimeType)), thumbnail.bytes, FILE_LABEL)
  }

  /** Used when an account signs out so one user's derived images never outlive their session. */
  async clear(userId: number): Promise<void> {
    if (!Number.isInteger(userId) || userId <= 0) throw new Error(`${FILE_LABEL}账号标识格式错误`)
    const accountRoot = path.join(this.cacheRoot, `user-${userId}`)
    try {
      assertNoReparseComponents(accountRoot, FILE_LABEL)
    } catch {
      return
    }
    await fs.promises.rm(accountRoot, { recursive: true, force: true })
  }
}

function assertCacheKey(userId: number, assetId: string): void {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error(`${FILE_LABEL}账号标识格式错误`)
  if (!ASSET_ID_PATTERN.test(assetId)) throw new Error(`${FILE_LABEL}资产标识无效`)
}
