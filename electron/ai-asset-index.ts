import fs from 'node:fs'
import path from 'node:path'
import { assertNoReparseComponents } from './safe-local-data'

const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAXIMUM_DIRECTORY_ENTRIES = 4_096

// The library index is deliberately capped well above the metadata store's
// 5,000 logical records so that a user never sees a silently truncated search
// result set. Enumerating this many directory entries costs one lstat each and
// reads no file contents, so the ceiling is bounded by syscalls, not memory.
export const MAXIMUM_INDEXED_ASSETS = 20_000

export type AiAssetMediaType = 'image' | 'video' | 'audio'

export interface AiAssetIndexEntry {
  assetId: string
  fileName: string
  extension: string
  createdAt: string
  mediaType: AiAssetMediaType
}

export interface AiAssetIndexOptions {
  accountRoot: string
  mediaType: AiAssetMediaType
  /** Must capture the asset identifier in group 1 and the extension in group 2. */
  filePattern: RegExp
  label: string
  maximum?: number
}

/**
 * Enumerates every stored asset file for one account without reading a single
 * byte of media. Listing used to inspect full file contents to derive width,
 * height and a content hash, which forced a hard 500 item ceiling; searching
 * and sorting then ran on that truncated slice and reported it as the total.
 * The index trades those derived fields for a complete, honest result set, and
 * the caller hydrates only the page it is about to display.
 *
 * Entries carry no absolute path: callers resolve files through the owning
 * store, which keeps ownership and reparse checks in one place.
 */
export async function indexOwnedAssetFiles(options: AiAssetIndexOptions): Promise<AiAssetIndexEntry[]> {
  const maximum = options.maximum ?? MAXIMUM_INDEXED_ASSETS
  let dateEntries: fs.Dirent[]
  try {
    assertNoReparseComponents(options.accountRoot, options.label)
    dateEntries = await fs.promises.readdir(options.accountRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`无法读取${options.label}目录`)
  }
  if (dateEntries.length > MAXIMUM_DIRECTORY_ENTRIES) throw new Error(`${options.label}目录条目过多`)
  const entries: AiAssetIndexEntry[] = []
  const seen = new Set<string>()
  for (const dateEntry of dateEntries.sort((left, right) => right.name.localeCompare(left.name))) {
    if (entries.length >= maximum) break
    if (!DATE_DIRECTORY_PATTERN.test(dateEntry.name)) continue
    if (dateEntry.isSymbolicLink()) throw new Error(`${options.label}目录不能经过符号链接或目录联接`)
    if (!dateEntry.isDirectory()) continue
    const directory = path.join(options.accountRoot, dateEntry.name)
    assertNoReparseComponents(directory, options.label)
    const files = await fs.promises.readdir(directory, { withFileTypes: true })
    if (files.length > MAXIMUM_DIRECTORY_ENTRIES) throw new Error(`${options.label}目录条目过多`)
    for (const file of files.sort((left, right) => right.name.localeCompare(left.name))) {
      if (entries.length >= maximum) break
      const match = file.name.match(options.filePattern)
      if (!match || !file.isFile() || file.isSymbolicLink()) continue
      const assetId = match[1]
      // The same identifier can appear under two date directories after a
      // restore. The newest directory wins because dates sort descending.
      if (seen.has(assetId)) continue
      let createdAt: string
      try {
        createdAt = (await fs.promises.lstat(path.join(directory, file.name))).birthtime.toISOString()
      } catch {
        // A file removed between readdir and lstat is simply not in the library.
        continue
      }
      seen.add(assetId)
      entries.push({ assetId, fileName: file.name, extension: match[2], createdAt, mediaType: options.mediaType })
    }
  }
  return entries
}
