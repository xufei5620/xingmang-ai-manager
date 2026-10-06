import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 打开 CLI 的一次性启动脚本：macOS（macos-platform.ts）与 Linux（linux-terminal.ts）共用的
// 文件部分。脚本里有当前账号的 Gemini Key 这类值，只能写进本进程 mkdtemp 出来的私有目录，
// 用完按身份核对后再删，绝不误删别人放到同一路径上的东西。

interface PathIdentity {
  device: bigint
  inode: bigint
  owner: bigint
}

/**
 * A directory has to be recognized by identity alone: removing the launcher bumps
 * its own mtime and size, so comparing those would make the cleanup abandon the
 * directory it just emptied.
 *
 * A regular file has no such excuse, and identity alone is not enough for one.
 * `unlink` frees the inode number, and a filesystem is free to hand it straight
 * back to the next file created in its place — ext4 and tmpfs do so immediately,
 * APFS happens not to. Comparing size, link count and both timestamps is what
 * makes "is this still the file I wrote?" independent of that allocation policy,
 * so a replacement dropped at the same path is never mistaken for our own.
 */
interface FileIdentity extends PathIdentity {
  size: bigint
  links: bigint
  modifiedNs: bigint
  changedNs: bigint
}

export interface LauncherIdentity {
  directory: PathIdentity
  launcher: FileIdentity
}

function pathIdentity(stats: fs.BigIntStats): PathIdentity {
  return { device: stats.dev, inode: stats.ino, owner: stats.uid }
}

function fileIdentity(stats: fs.BigIntStats): FileIdentity {
  return {
    ...pathIdentity(stats),
    size: stats.size,
    links: stats.nlink,
    modifiedNs: stats.mtimeNs,
    changedNs: stats.ctimeNs,
  }
}

function samePathIdentity(stats: fs.BigIntStats, expected: PathIdentity): boolean {
  return stats.dev === expected.device
    && stats.ino === expected.inode
    && stats.uid === expected.owner
}

function sameFileIdentity(stats: fs.BigIntStats, expected: FileIdentity): boolean {
  return samePathIdentity(stats, expected)
    && stats.size === expected.size
    && stats.nlink === expected.links
    && stats.mtimeNs === expected.modifiedNs
    && stats.ctimeNs === expected.changedNs
}

async function lstat(filePath: string): Promise<fs.BigIntStats | null> {
  try {
    return await fs.promises.lstat(filePath, { bigint: true })
  } catch {
    return null
  }
}

/** Quotes one POSIX shell argument without evaluating its contents. */
export function quotePosixArgument(value: string): string {
  if (value.includes('\0')) throw new TypeError('POSIX argument must not contain NUL bytes')
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Records what was just written, so a later removal can tell it apart from a replacement. */
export async function captureLauncherIdentity(directory: string, launcherPath: string): Promise<LauncherIdentity> {
  const [directoryStats, launcherStats] = await Promise.all([
    fs.promises.lstat(directory, { bigint: true }),
    fs.promises.lstat(launcherPath, { bigint: true }),
  ])
  if (!directoryStats.isDirectory() || !launcherStats.isFile()) {
    throw new Error('terminal launcher identity is invalid')
  }
  return {
    directory: pathIdentity(directoryStats),
    launcher: fileIdentity(launcherStats),
  }
}

export async function removeLauncherIfUnchanged(
  directory: string,
  launcherPath: string,
  identity: LauncherIdentity,
): Promise<void> {
  const directoryStats = await lstat(directory)
  if (
    !directoryStats?.isDirectory()
    || !samePathIdentity(directoryStats, identity.directory)
  ) return

  const launcherStats = await lstat(launcherPath)
  if (launcherStats) {
    if (!launcherStats.isFile() || !sameFileIdentity(launcherStats, identity.launcher)) return
    await fs.promises.unlink(launcherPath).catch(() => undefined)
  }

  const currentDirectoryStats = await lstat(directory)
  if (
    currentDirectoryStats?.isDirectory()
    && samePathIdentity(currentDirectoryStats, identity.directory)
  ) {
    await fs.promises.rmdir(directory).catch(() => undefined)
  }
}

/**
 * `mode` is the final permission of the launcher. Terminal.app executes the file
 * itself and needs 0700; a Linux terminal is handed `/bin/sh <launcher>`, so there the
 * file only has to be readable and stays non-executable.
 */
export async function writeLauncherAtomically(launcherPath: string, content: string, mode = 0o700): Promise<void> {
  const temporaryPath = `${launcherPath}.${randomUUID()}.tmp`
  const file = await fs.promises.open(temporaryPath, 'wx', 0o600)
  let renamed = false
  try {
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.promises.chmod(temporaryPath, mode)
    await fs.promises.rename(temporaryPath, launcherPath)
    renamed = true
  } finally {
    // A failed write must not leave the partial file behind. The caller only has an
    // empty-directory removal to fall back on, so a surviving .tmp would keep the
    // whole mkdtemp tree alive with no owner and no later pass to collect it.
    if (!renamed) await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

const collectedTerminalRoots = new Set<string>()

export function terminalDirectoryPrefix(processId: number = process.pid): string {
  return `xingmang-terminal-${processId}-`
}

/** One sweep per temp root per process; launching a terminal is not a rare event. */
export async function cleanupStaleTerminalDirectoriesOnce(baseDirectory: string): Promise<void> {
  const key = path.resolve(baseDirectory)
  if (collectedTerminalRoots.has(key)) return
  collectedTerminalRoots.add(key)
  await cleanupStaleTerminalDirectories(baseDirectory)
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Removes launcher directories left by processes that are gone.
 *
 * The launcher is normally unlinked by the script itself or by the scheduled
 * cleanup, but neither runs if the app exits in between, and nothing else ever
 * looked at these directories again. Keying on the creating pid rather than on an
 * age threshold means a directory is only collected once its owner cannot possibly
 * still need it, so a launcher waiting out its five-minute window is never taken.
 */
export async function cleanupStaleTerminalDirectories(
  baseDirectory = os.tmpdir(),
  isAlive: (processId: number) => boolean = processIsAlive,
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(baseDirectory, { withFileTypes: true })
  } catch {
    return
  }
  const currentUid = process.getuid?.()
  await Promise.all(entries.map(async (entry) => {
    const match = /^xingmang-terminal-(\d+)-/.exec(entry.name)
    if (!match || !entry.isDirectory()) return
    const processId = Number(match[1])
    if (!Number.isSafeInteger(processId) || processId <= 0 || isAlive(processId)) return
    const directory = path.join(baseDirectory, entry.name)
    try {
      const stats = await fs.promises.lstat(directory)
      if (!stats.isDirectory() || stats.isSymbolicLink()) return
      if (currentUid !== undefined && stats.uid !== currentUid) return
      await fs.promises.rm(directory, { recursive: true, force: true })
    } catch {
      // A concurrently removed or inaccessible stale directory is harmless.
    }
  }))
}
