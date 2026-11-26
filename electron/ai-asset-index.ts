import fs from 'node:fs'
import path from 'node:path'
import { mapWithConcurrency } from './async-map'
import { assertNoReparseComponents } from './safe-local-data'

const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAXIMUM_DIRECTORY_ENTRIES = 4_096
// The lstat for each file's creation time is the only per-file cost and the
// calls are independent. Awaited one by one, a library of a few thousand items
// took seconds on Windows, where a scanner can hold each call for a
// millisecond, and the create page asks again every time the window regains
// focus. A window keeps the order, the newest-copy rule and the ceiling exactly
// as the serial walk had them while wasting at most one window at the ceiling.
const LSTAT_CONCURRENCY = 8
const LSTAT_WINDOW = 64

// The library index is capped at 20,000 assets. Enumerating this many
// directory entries costs one lstat each and reads no file contents, so the
// ceiling is bounded by syscalls, not memory. The metadata store's shards hold
// more records than this even with the longest prompts, so an indexed asset
// never lacks room for its name, tags and prompt.
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
  /**
   * Tells the owning store where each indexed file lives, so the page it is
   * about to hydrate needs no second search. The path never leaves the store.
   */
  onFile?: (assetId: string, filePath: string) => void
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
    const candidates = files.sort((left, right) => right.name.localeCompare(left.name)).flatMap((file) => {
      const match = file.name.match(options.filePattern)
      return match && file.isFile() && !file.isSymbolicLink() ? [{ fileName: file.name, filePath: path.join(directory, file.name), assetId: match[1], extension: match[2] }] : []
    })
    for (let start = 0; start < candidates.length && entries.length < maximum; start += LSTAT_WINDOW) {
      const window = candidates.slice(start, start + LSTAT_WINDOW)
      const created = await mapWithConcurrency(window, LSTAT_CONCURRENCY, async (candidate) => {
        if (seen.has(candidate.assetId)) return null
        try {
          return (await fs.promises.lstat(candidate.filePath)).birthtime.toISOString()
        } catch {
          // A file removed between readdir and lstat is simply not in the library.
          return null
        }
      })
      for (const [position, candidate] of window.entries()) {
        if (entries.length >= maximum) break
        const createdAt = created[position]
        // The same identifier can appear under two date directories after a
        // restore. The newest directory wins because dates sort descending.
        if (createdAt === null || seen.has(candidate.assetId)) continue
        seen.add(candidate.assetId)
        options.onFile?.(candidate.assetId, candidate.filePath)
        entries.push({ assetId: candidate.assetId, fileName: candidate.fileName, extension: candidate.extension, createdAt, mediaType: options.mediaType })
      }
    }
  }
  return entries
}
