import fs from 'node:fs'
import path from 'node:path'
import { sameLocalPathIdentity } from './path-identity'

/**
 * 卸载后没删掉、交给客户手动清理的那几个文件（已知48「帮我清理」）。
 *
 * The renderer never names a path. The uninstall that produced the manual
 * command records exactly the files that command names, each pinned to the
 * identity it had at that moment, and a later cleanup only unlinks an entry
 * that still matches its pin: the same parent directory object (plain, not
 * reached through a link, same owner), the same file object, and for a link
 * the same link text. Anything that no longer matches is left where it is.
 *
 * On macOS this deliberately goes one step past uninstallVerifiedNativeCliFiles,
 * which never unlinks a quarantined symlink by pathname (Node has no
 * inode-bound unlink there). yoyo asked for that in writing on 2026-10-06
 * (「Mac 也帮我清理」). What makes the check-then-unlink window acceptable is
 * the directory gate the caller passes in on macOS: nothing is deleted from a
 * directory chain that any principal other than root or the current user can
 * modify, so only that same user could swap an entry in between, and they can
 * delete the file themselves anyway (AGENTS.md T5: not a same-uid defence).
 * Windows and Linux repeat exactly the delete their own uninstall already
 * performs on these files, so nothing is relaxed there.
 */

export interface UninstallLeftoverDirectoryIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  uid: bigint
}

export interface UninstallLeftoverFileIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  uid: bigint
  gid: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  birthtimeNs: bigint
}

export interface PinnedUninstallLeftover {
  kind: 'pinned'
  path: string
  directory: string
  directoryIdentity: UninstallLeftoverDirectoryIdentity
  identity: UninstallLeftoverFileIdentity
  /** null for a regular file; the exact link text for a symbolic link. */
  linkTarget: string | null
}

/**
 * Named by the manual command but never deleted here: a directory, a
 * hard-linked file, another owner's file, any link on Windows, or a file whose
 * parent went through a link. It still counts while it exists, so the dialog
 * never says 「清理好了」 over a file the command still lists.
 */
export interface UnverifiableUninstallLeftover {
  kind: 'unverifiable'
  path: string
}

export type UninstallLeftover = PinnedUninstallLeftover | UnverifiableUninstallLeftover

export interface UninstallLeftoverOptions {
  platform: NodeJS.Platform
  /** POSIX uid every pinned file and its parent directory must belong to; undefined on Windows. */
  ownerUid: number | undefined
  /**
   * macOS: whether a principal other than root or the current user can modify
   * this directory or any ancestor (isDarwinForeignWritablePath). Nothing there
   * is ever deleted. Omitted elsewhere, where the uninstall's own verified
   * delete is repeated unchanged.
   */
  isForeignWritableDirectory?: (directory: string) => boolean
}

export interface RemoveUninstallLeftoversOptions extends UninstallLeftoverOptions {
  /**
   * Command links of the tool, looked at again right before deleting. Grok's
   * npm postinstall keeps an existing ~/.grok/bin/grok-<version> and only
   * points the link back at it, so after a reinstall a recorded leftover can
   * be the live program again. Whatever these resolve to now is never deleted.
   */
  liveCommandLinks?: readonly string[]
}

export type UninstallLeftoverKeptReason =
  | 'unverifiable'
  | 'directory-changed'
  | 'file-changed'
  | 'delete-failed'

export interface UninstallLeftoverKept {
  leftover: UninstallLeftover
  reason: UninstallLeftoverKeptReason
  code?: string
}

export interface UninstallLeftoverCleanup {
  removed: number
  /** Pinned files a reinstalled tool runs again; left alone and no longer counted. */
  reused: number
  /** Still there; the next attempt only looks at these. */
  kept: UninstallLeftoverKept[]
}

type LeftoverOutcome =
  | 'removed'
  | 'gone'
  | 'reused'
  | Omit<UninstallLeftoverKept, 'leftover'>

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function fileIdentity(stats: fs.BigIntStats): UninstallLeftoverFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    birthtimeNs: stats.birthtimeNs,
  }
}

// ctime is left out on purpose: the uninstall's own rename into quarantine
// already moved it, and nothing about which object this is depends on it.
function sameFileIdentity(stats: fs.BigIntStats, expected: UninstallLeftoverFileIdentity): boolean {
  return stats.dev === expected.dev
    && stats.ino === expected.ino
    && stats.mode === expected.mode
    && stats.uid === expected.uid
    && stats.gid === expected.gid
    && stats.nlink === expected.nlink
    && stats.size === expected.size
    && stats.mtimeNs === expected.mtimeNs
    && stats.birthtimeNs === expected.birthtimeNs
}

function verifiedDirectoryIdentity(
  directory: string,
  options: UninstallLeftoverOptions,
): UninstallLeftoverDirectoryIdentity | null {
  try {
    const stats = fs.lstatSync(directory, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink()) return null
    if (options.ownerUid !== undefined && stats.uid !== BigInt(options.ownerUid)) return null
    // Every ancestor is covered too: a link or junction anywhere above makes realpath differ.
    const realDirectory = fs.realpathSync.native?.(directory) ?? fs.realpathSync(directory)
    if (!sameLocalPathIdentity(realDirectory, directory)) return null
    if (options.isForeignWritableDirectory?.(directory)) return null
    return { dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid }
  } catch {
    return null
  }
}

function directoryUnchanged(leftover: PinnedUninstallLeftover, options: UninstallLeftoverOptions): boolean {
  const current = verifiedDirectoryIdentity(leftover.directory, options)
  return current !== null
    && current.dev === leftover.directoryIdentity.dev
    && current.ino === leftover.directoryIdentity.ino
    && current.mode === leftover.directoryIdentity.mode
    && current.uid === leftover.directoryIdentity.uid
}

function isPinnableFile(stats: fs.BigIntStats, options: UninstallLeftoverOptions): boolean {
  if (stats.nlink !== 1n) return false
  if (options.ownerUid !== undefined && stats.uid !== BigInt(options.ownerUid)) return false
  if (stats.isFile()) return true
  // lstat reports Windows junctions as links too; neither kind is ever removed there.
  return stats.isSymbolicLink() && options.platform !== 'win32'
}

function captureLeftover(filePath: string, options: UninstallLeftoverOptions): UninstallLeftover | null {
  let stats: fs.BigIntStats
  try {
    stats = fs.lstatSync(filePath, { bigint: true })
  } catch (error) {
    return isMissing(error) ? null : { kind: 'unverifiable', path: filePath }
  }
  const directory = path.dirname(filePath)
  const directoryIdentity = verifiedDirectoryIdentity(directory, options)
  if (!directoryIdentity || !isPinnableFile(stats, options)) return { kind: 'unverifiable', path: filePath }
  let linkTarget: string | null = null
  if (stats.isSymbolicLink()) {
    try {
      linkTarget = fs.readlinkSync(filePath)
      const afterRead = fs.lstatSync(filePath, { bigint: true })
      if (!afterRead.isSymbolicLink() || !sameFileIdentity(afterRead, fileIdentity(stats))) {
        return { kind: 'unverifiable', path: filePath }
      }
    } catch {
      return { kind: 'unverifiable', path: filePath }
    }
  }
  return {
    kind: 'pinned',
    path: filePath,
    directory,
    directoryIdentity,
    identity: fileIdentity(stats),
    linkTarget,
  }
}

/**
 * Pins the files an uninstall had to leave behind. Paths come only from the
 * uninstall itself; ones already gone are dropped.
 */
export function captureUninstallLeftovers(
  filePaths: readonly string[],
  options: UninstallLeftoverOptions,
): UninstallLeftover[] {
  const leftovers: UninstallLeftover[] = []
  const seen = new Set<string>()
  for (const filePath of filePaths) {
    if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) continue
    const resolved = path.resolve(filePath)
    const key = options.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    const leftover = captureLeftover(resolved, options)
    if (leftover) leftovers.push(leftover)
  }
  return leftovers
}

async function stillPresent(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (error) {
    return !isMissing(error)
  }
}

function liveProgramIdentities(links: readonly string[]): Array<Pick<UninstallLeftoverFileIdentity, 'dev' | 'ino'>> {
  const identities: Array<Pick<UninstallLeftoverFileIdentity, 'dev' | 'ino'>> = []
  for (const link of links) {
    try {
      const stats = fs.statSync(link, { bigint: true })
      if (stats.isFile()) identities.push({ dev: stats.dev, ino: stats.ino })
    } catch {
      // No such command, or a dangling link: nothing it could still run.
    }
  }
  return identities
}

async function removePinnedLeftover(
  leftover: PinnedUninstallLeftover,
  options: UninstallLeftoverOptions,
  live: ReadonlyArray<Pick<UninstallLeftoverFileIdentity, 'dev' | 'ino'>>,
): Promise<LeftoverOutcome> {
  if (!directoryUnchanged(leftover, options)) {
    // Gone, replaced or now reached through a link: whatever sits at this
    // path is no longer provably the file the uninstall recorded.
    return await stillPresent(leftover.path) ? { reason: 'directory-changed' } : 'gone'
  }
  let stats: fs.BigIntStats
  try {
    stats = await fs.promises.lstat(leftover.path, { bigint: true })
  } catch (error) {
    return isMissing(error) ? 'gone' : { reason: 'file-changed', code: errorCode(error) }
  }
  // A different object took the name since the uninstall (a reinstall wrote
  // a fresh copy, say): the recorded file is gone and the newcomer is not ours.
  if (stats.dev !== leftover.identity.dev || stats.ino !== leftover.identity.ino) return 'gone'
  if (!sameFileIdentity(stats, leftover.identity)) return { reason: 'file-changed' }
  if (leftover.linkTarget === null) {
    if (live.some((entry) => entry.dev === stats.dev && entry.ino === stats.ino)) return 'reused'
  } else {
    try {
      if (await fs.promises.readlink(leftover.path) !== leftover.linkTarget) return { reason: 'file-changed' }
      const afterRead = await fs.promises.lstat(leftover.path, { bigint: true })
      if (!afterRead.isSymbolicLink() || !sameFileIdentity(afterRead, leftover.identity)) {
        return { reason: 'file-changed' }
      }
    } catch (error) {
      return isMissing(error) ? 'gone' : { reason: 'file-changed', code: errorCode(error) }
    }
  }
  if (!directoryUnchanged(leftover, options)) return { reason: 'directory-changed' }
  try {
    // unlink, never rm: it cannot take a directory, and on a link it removes the link itself.
    await fs.promises.unlink(leftover.path)
    return 'removed'
  } catch (error) {
    // Windows refuses while a program still runs from the file (EPERM / EBUSY).
    return isMissing(error) ? 'gone' : { reason: 'delete-failed', code: errorCode(error) }
  }
}

async function removeLeftover(
  leftover: UninstallLeftover,
  options: UninstallLeftoverOptions,
  live: ReadonlyArray<Pick<UninstallLeftoverFileIdentity, 'dev' | 'ino'>>,
): Promise<LeftoverOutcome> {
  if (leftover.kind === 'unverifiable') {
    return await stillPresent(leftover.path) ? { reason: 'unverifiable' } : 'gone'
  }
  return removePinnedLeftover(leftover, options, live)
}

/** Deletes whichever recorded leftovers still match their pin; one failure never stops the rest. */
export async function removeUninstallLeftovers(
  leftovers: readonly UninstallLeftover[],
  options: RemoveUninstallLeftoversOptions,
): Promise<UninstallLeftoverCleanup> {
  const live = liveProgramIdentities(options.liveCommandLinks ?? [])
  const cleanup: UninstallLeftoverCleanup = { removed: 0, reused: 0, kept: [] }
  for (const leftover of leftovers) {
    const outcome = await removeLeftover(leftover, options, live)
    if (outcome === 'removed') cleanup.removed += 1
    else if (outcome === 'reused') cleanup.reused += 1
    else if (outcome !== 'gone') cleanup.kept.push({ leftover, ...outcome })
  }
  return cleanup
}
