import fs from 'node:fs'
import path from 'node:path'
import { assertNoReparseComponents } from './safe-local-data'

const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAXIMUM_ACCOUNT_ENTRIES = 4_096
// Comfortably above one account's indexed library (ai-asset-index.ts caps it
// at 20,000) so a full index never evicts itself, and small enough that a
// session hopping between several large accounts stays at a few megabytes.
const MAXIMUM_REMEMBERED_LOCATIONS = 50_000

interface RememberedLocation {
  userId: number
  filePath: string
}

export interface OwnedAssetLocatorOptions {
  outputRoot: string
  /** Extensions the owning store writes, in the order a lookup tries them. */
  extensions: readonly string[]
  /** The owning store's label, so error messages read exactly as they did before. */
  label: string
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Only a definite "no such file" rules a candidate out. Any other answer is
 * handed to the store's full file checks, which then fail with the same error
 * they always produced for an unreadable or tampered entry.
 */
async function mayBePresent(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * Answers "which date folder holds this asset" for one store.
 *
 * A lookup by identifier used to try every date folder an account had ever
 * written to, times every extension, in whatever order the file system listed
 * the folders, and every try ran the complete reparse walk (a synchronous
 * lstat and realpath for each path component) on a file that almost never
 * existed. A 120-day account paid tens of thousands of synchronous calls on
 * the main process to show one library page or open one conversation.
 *
 * Now a lookup asks a remembered location first, and otherwise checks the
 * account folder once, walks the date folders newest first (recent work is
 * what people open) and rules each candidate in or out with one asynchronous
 * lstat. Locations are remembered from stores, lookups and the library index.
 *
 * Nothing here is a security check and nothing in it was relaxed: the locator
 * only says where a file would be. The owning store still runs its full
 * reparse, single-link and identity checks on the one file it opens (AGENTS.md
 * I8), whether the location was remembered or just found.
 */
export class OwnedAssetLocator {
  private readonly outputRoot: string
  private readonly extensions: readonly string[]
  private readonly label: string
  private readonly locations = new Map<string, RememberedLocation>()

  constructor(options: OwnedAssetLocatorOptions) {
    this.outputRoot = path.resolve(options.outputRoot)
    this.extensions = [...options.extensions]
    this.label = options.label
  }

  remember(userId: number, assetId: string, filePath: string): void {
    // Callers only pass paths they built under this account; refusing anything
    // else keeps a remembered location from ever pointing outside it.
    if (!pathIsWithin(path.join(this.outputRoot, `user-${userId}`), filePath)) return
    if (this.locations.size >= MAXIMUM_REMEMBERED_LOCATIONS && !this.locations.has(assetId)) this.locations.clear()
    this.locations.set(assetId, { userId, filePath })
  }

  forget(assetId: string): void {
    this.locations.delete(assetId)
  }

  /**
   * Path of the newest file stored under this identifier for this account, or
   * null when there is none. Throws only for an account folder with more
   * entries than the stores accept, as the old lookup did.
   */
  async locate(userId: number, assetId: string): Promise<string | null> {
    const known = this.locations.get(assetId)
    if (known && known.userId === userId) {
      if (await mayBePresent(known.filePath)) return known.filePath
      // Deleted or moved outside the app since it was remembered: look again
      // instead of handing out a path that can only fail.
      if (this.locations.get(assetId) === known) this.locations.delete(assetId)
    }
    const found = await this.search(userId, assetId)
    if (found) this.remember(userId, assetId, found)
    return found
  }

  private async search(userId: number, assetId: string): Promise<string | null> {
    const accountRoot = path.join(this.outputRoot, `user-${userId}`)
    let entries: fs.Dirent[]
    try {
      // Once per lookup, not once per candidate file: the account folder is the
      // same for every candidate.
      assertNoReparseComponents(accountRoot, this.label)
      entries = await fs.promises.readdir(accountRoot, { withFileTypes: true })
    } catch {
      return null
    }
    if (entries.length > MAXIMUM_ACCOUNT_ENTRIES) throw new Error(`${this.label}目录条目过多`)
    const dateDirectories = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && DATE_DIRECTORY_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
    for (const dateDirectory of dateDirectories) {
      for (const extension of this.extensions) {
        const filePath = path.join(accountRoot, dateDirectory, `xingmang-${assetId}.${extension}`)
        if (await mayBePresent(filePath)) return filePath
      }
    }
    return null
  }
}
