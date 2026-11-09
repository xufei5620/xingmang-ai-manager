import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommand, trustedCommandEnvironment } from './command-runner'

export interface DarwinCliFileIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  ctimeNs: bigint
  mtimeNs: bigint
}

export interface StageVerifiedDarwinCliOptions {
  executableName: string
  sourcePath: string
  sourceIdentity: DarwinCliFileIdentity
  verify: (executablePath: string) => Promise<void>
  /**
   * Retained acquisitions stay leased until explicit release and stay on disk after this
   * process exits: Terminal may still be running them. A later start removes them once no
   * process runs them any more (cleanupStaleDarwinCliDirectories).
   */
  retention?: 'ephemeral' | 'retained'
  baseDirectory?: string
}

interface StagedDarwinCliRecord {
  cacheKey: string | null
  directory: string
  executablePath: string
  identity: DarwinCliFileIdentity
  leaseCount: number
}

const MAX_RETAINED_SELECTIONS = 8
const stagedRecords = new Map<string, StagedDarwinCliRecord>()
const retainedSelections = new Map<string, StagedDarwinCliRecord>()
const cleanedRoots = new Set<string>()
let cleanupRegistered = false
let pendingRetainedRecords = 0

function drainStagedDarwinCliRecords(): StagedDarwinCliRecord[] {
  const records = [...stagedRecords.values()]
  stagedRecords.clear()
  retainedSelections.clear()
  cleanedRoots.clear()
  return records
}

/**
 * Runs from process.once('exit') and removes only the one-shot copies.
 *
 * A retained copy is the one handed to Terminal, and the tool keeps running it after this
 * process is gone. Deleting it here pulled the program file out from under a live session:
 * the running process survives, but anything in it that starts its own executable path again
 * no longer finds it. Those directories are left for
 * cleanupStaleDarwinCliDirectories, which a later start runs and which keeps every directory
 * a process still executes from.
 */
export function disposeDarwinCliStagingAtExit(): void {
  for (const record of drainStagedDarwinCliRecords()) {
    if (record.cacheKey) continue
    try {
      fs.rmSync(record.directory, { recursive: true, force: true })
    } catch {
      // Process exit cleanup is best effort; the next start sweeps what is left.
    }
  }
}

/** Deletes every staged copy and resets staging metadata without terminating the process. */
export async function disposeStagedDarwinCliRecords(): Promise<void> {
  const records = drainStagedDarwinCliRecords()
  await Promise.all(records.map((record) => fs.promises.rm(
    record.directory,
    { recursive: true, force: true },
  )))
}

function sameIdentity(stats: fs.BigIntStats, expected: DarwinCliFileIdentity): boolean {
  return stats.dev === expected.dev
    && stats.ino === expected.ino
    && stats.mode === expected.mode
    && stats.size === expected.size
    && stats.ctimeNs === expected.ctimeNs
    && stats.mtimeNs === expected.mtimeNs
}

function requireExpectedExecutable(
  stats: fs.BigIntStats,
  expected: DarwinCliFileIdentity,
): void {
  if (!stats.isFile() || (stats.mode & 0o111n) === 0n || !sameIdentity(stats, expected)) {
    throw new Error('Darwin CLI source changed before private staging completed')
  }
}

function retainUntilExit(record: StagedDarwinCliRecord): void {
  stagedRecords.set(record.executablePath, record)
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once('exit', disposeDarwinCliStagingAtExit)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const lsofExecutable = '/usr/sbin/lsof'
const lsofTimeoutMs = 10_000
const lsofMaximumOutputBytes = 1024 * 1024

/**
 * `-F n` prints one `n<path>` line per open file that matched, and a running executable
 * counts as open (its `txt` mapping). Matching is by device and inode, so a tool that renamed
 * its own process title is still found, which a `ps` argument match would miss.
 */
export function buildOpenDarwinFilesProbeArgv(files: readonly string[]): string[] {
  return ['-w', '-F', 'n', '--', ...files]
}

export function parseOpenDarwinFilesProbeOutput(output: string): string[] {
  const names: string[] = []
  for (const line of output.split('\n')) {
    if (line.startsWith('n') && line.length > 1) names.push(line.slice(1))
  }
  return names
}

/**
 * Answers which of these files some process has open, or null when lsof could not tell.
 * lsof exits 1 both when a named file is simply not open and when it failed, so exit 1 is
 * only trusted with nothing on stderr; `-w` keeps warnings about other users' processes off it.
 */
export async function listOpenDarwinFiles(files: readonly string[]): Promise<string[] | null> {
  if (!files.length) return []
  try {
    const result = await runCommand({
      executable: lsofExecutable,
      argv: buildOpenDarwinFilesProbeArgv(files),
    }, {
      env: trustedCommandEnvironment(process.env, undefined, 'darwin'),
      timeoutMs: lsofTimeoutMs,
      maxOutputBytes: lsofMaximumOutputBytes,
      acceptedExitCodes: [0, 1],
    })
    if (result.exitCode !== 0 && result.stderr.trim()) return null
    return parseOpenDarwinFilesProbeOutput(result.stdout)
  } catch {
    return null
  }
}

interface StaleDarwinCliDirectory {
  name: string
  directory: string
  files: string[]
}

function namesDirectory(openPath: string, directoryName: string): boolean {
  return openPath.split(path.sep).includes(directoryName)
}

/**
 * Removes directories a previous process staged, but only those nothing runs any more.
 *
 * The creator being dead is not enough: its retained copies were handed to Terminal and may
 * still be running there (disposeDarwinCliStagingAtExit leaves them for this reason). Open
 * files are matched back by the directory's own name, which carries the creator pid and a
 * random suffix, because lsof may report the /private/var spelling of a /var/folders path.
 * When the probe cannot tell, every directory that holds a file stays for a later start.
 */
export async function cleanupStaleDarwinCliDirectories(
  baseDirectory = os.tmpdir(),
  isAlive: (pid: number) => boolean = processIsAlive,
  listOpenFiles: (files: readonly string[]) => Promise<readonly string[] | null> = listOpenDarwinFiles,
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(baseDirectory, { withFileTypes: true })
  } catch {
    return
  }
  const currentUid = process.getuid?.()
  const candidates = (await Promise.all(entries.map(async (entry): Promise<StaleDarwinCliDirectory | null> => {
    const match = /^xingmang-darwin-cli-(\d+)-/.exec(entry.name)
    if (!match || !entry.isDirectory()) return null
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) return null
    const directory = path.join(baseDirectory, entry.name)
    try {
      const stats = await fs.promises.lstat(directory)
      if (!stats.isDirectory() || stats.isSymbolicLink()) return null
      if (currentUid !== undefined && stats.uid !== currentUid) return null
      const files = (await fs.promises.readdir(directory, { withFileTypes: true }))
        .filter((child) => child.isFile())
        .map((child) => path.join(directory, child.name))
      return { name: entry.name, directory, files }
    } catch {
      // A concurrently removed or inaccessible stale directory is harmless.
      return null
    }
  }))).filter((candidate): candidate is StaleDarwinCliDirectory => candidate !== null)
  if (!candidates.length) return
  const files = candidates.flatMap((candidate) => candidate.files)
  const open = files.length ? await listOpenFiles(files) : []
  await Promise.all(candidates.map(async (candidate) => {
    if (candidate.files.length) {
      if (open === null) return
      if (open.some((openPath) => namesDirectory(openPath, candidate.name))) return
    }
    try {
      await fs.promises.rm(candidate.directory, { recursive: true, force: true })
    } catch {
      // A concurrently removed stale directory is harmless.
    }
  }))
}

async function cleanupStaleOnce(baseDirectory: string): Promise<void> {
  const key = path.resolve(baseDirectory)
  if (cleanedRoots.has(key)) return
  cleanedRoots.add(key)
  await cleanupStaleDarwinCliDirectories(key)
}

function cacheKey(options: StageVerifiedDarwinCliOptions): string {
  const identity = options.sourceIdentity
  return [
    path.resolve(options.baseDirectory ?? os.tmpdir()),
    options.executableName,
    options.sourcePath,
    identity.dev,
    identity.ino,
    identity.mode,
    identity.size,
    identity.ctimeNs,
    identity.mtimeNs,
  ].join(':')
}

async function validStagedRecord(record: StagedDarwinCliRecord): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(record.executablePath, { bigint: true })
    const directory = await fs.promises.lstat(record.directory)
    return stats.isFile()
      && !stats.isSymbolicLink()
      && sameIdentity(stats, record.identity)
      && directory.isDirectory()
      && !directory.isSymbolicLink()
      && (directory.mode & 0o777) === 0o700
  } catch {
    return false
  }
}

function activeRetainedRecordCount(): number {
  let count = 0
  for (const record of stagedRecords.values()) {
    if (record.cacheKey) count += 1
  }
  return count
}

function reserveRetainedRecord(): void {
  if (activeRetainedRecordCount() + pendingRetainedRecords >= MAX_RETAINED_SELECTIONS) {
    throw new Error(
      `Darwin CLI retained staging limit (${MAX_RETAINED_SELECTIONS}) reached; 请重启应用后重试`,
    )
  }
  pendingRetainedRecords += 1
}

async function forgetStagedRecord(record: StagedDarwinCliRecord): Promise<void> {
  stagedRecords.delete(record.executablePath)
  if (record.cacheKey && retainedSelections.get(record.cacheKey) === record) {
    retainedSelections.delete(record.cacheKey)
  }
  await fs.promises.rm(record.directory, { recursive: true, force: true }).catch(() => undefined)
}

export async function releaseStagedDarwinCli(executablePath: string): Promise<void> {
  const record = stagedRecords.get(executablePath)
  if (!record) return
  record.leaseCount -= 1
  if (record.leaseCount > 0) return
  await forgetStagedRecord(record)
}

/**
 * Drops a record whose staged copy no longer matches what was verified.
 *
 * This deliberately ignores the lease count. A retained record's count only ever
 * grows — the terminal launch path never releases, because Terminal may run the
 * copy long after `open` returns — so routing an invalidated record through the
 * normal release would decrement it to a still-positive number and return early,
 * leaving the record occupying one of the retained slots and its directory on disk
 * for the rest of the process. The copy has already failed verification at this
 * point, so nothing may keep using it and there is no count worth honouring.
 */
async function discardStagedRecord(record: StagedDarwinCliRecord): Promise<void> {
  await forgetStagedRecord(record)
}

async function copyOpenedFile(
  source: fs.promises.FileHandle,
  destination: fs.promises.FileHandle,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    let written = 0
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written)
      written += result.bytesWritten
    }
    position += bytesRead
  }
  await destination.sync()
}

/**
 * Copies a verified executable through a bound descriptor and reverifies the private copy.
 * Retained copies outlive this process because Terminal keeps running them after open.
 */
export async function stageVerifiedDarwinCli(
  options: StageVerifiedDarwinCliOptions,
): Promise<string> {
  if (process.platform !== 'darwin') return options.sourcePath
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.executableName)) {
    throw new Error('Darwin CLI staged executable name is invalid')
  }
  const retention = options.retention ?? 'retained'
  const baseDirectory = options.baseDirectory ?? os.tmpdir()
  // Housekeeping only: it never touches this process's directories, so the copy below does
  // not wait for it (and for lsof).
  void cleanupStaleOnce(baseDirectory).catch(() => undefined)
  const retainedKey = retention === 'retained' ? cacheKey(options) : null
  if (retainedKey) {
    const cached = retainedSelections.get(retainedKey)
    if (cached) {
      cached.leaseCount += 1
      if (await validStagedRecord(cached)) {
        if (retainedSelections.get(retainedKey) === cached) {
          retainedSelections.delete(retainedKey)
          retainedSelections.set(retainedKey, cached)
        }
        return cached.executablePath
      }
      // The lease taken above is abandoned rather than released: the copy failed
      // revalidation, so the slot and the directory must go regardless of who else
      // still holds a count on it.
      cached.leaseCount -= 1
      await discardStagedRecord(cached)
    }
  }

  let source: fs.promises.FileHandle | null = null
  let directory: string | null = null
  let destination: fs.promises.FileHandle | null = null
  let retained = false
  let retainedSlotReserved = false
  try {
    if (retainedKey) {
      reserveRetainedRecord()
      retainedSlotReserved = true
    }
    source = await fs.promises.open(
      options.sourcePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    )
    requireExpectedExecutable(await source.stat({ bigint: true }), options.sourceIdentity)
    directory = await fs.promises.mkdtemp(path.join(
      baseDirectory,
      `xingmang-darwin-cli-${process.pid}-`,
    ))
    await fs.promises.chmod(directory, 0o700)
    const executablePath = path.join(await fs.promises.realpath(directory), options.executableName)
    destination = await fs.promises.open(executablePath, 'wx', 0o500)
    await copyOpenedFile(source, destination)
    await destination.close()
    destination = null
    await fs.promises.chmod(executablePath, 0o500)

    requireExpectedExecutable(await source.stat({ bigint: true }), options.sourceIdentity)
    requireExpectedExecutable(
      await fs.promises.lstat(options.sourcePath, { bigint: true }),
      options.sourceIdentity,
    )
    const stagedIdentity = await fs.promises.lstat(executablePath, { bigint: true })
    if (!stagedIdentity.isFile() || stagedIdentity.isSymbolicLink() || (stagedIdentity.mode & 0o111n) === 0n) {
      throw new Error('Darwin CLI private staging did not produce a regular executable')
    }

    await options.verify(executablePath)
    if (!sameIdentity(await fs.promises.lstat(executablePath, { bigint: true }), {
      dev: stagedIdentity.dev,
      ino: stagedIdentity.ino,
      mode: stagedIdentity.mode,
      size: stagedIdentity.size,
      ctimeNs: stagedIdentity.ctimeNs,
      mtimeNs: stagedIdentity.mtimeNs,
    })) {
      throw new Error('Darwin CLI private executable changed during verification')
    }
    const record: StagedDarwinCliRecord = {
      cacheKey: retainedKey,
      directory,
      executablePath,
      identity: {
        dev: stagedIdentity.dev,
        ino: stagedIdentity.ino,
        mode: stagedIdentity.mode,
        size: stagedIdentity.size,
        ctimeNs: stagedIdentity.ctimeNs,
        mtimeNs: stagedIdentity.mtimeNs,
      },
      leaseCount: 1,
    }
    retainUntilExit(record)
    if (retainedSlotReserved) {
      pendingRetainedRecords -= 1
      retainedSlotReserved = false
    }
    if (retainedKey) {
      retainedSelections.set(retainedKey, record)
    }
    retained = true
    return executablePath
  } finally {
    await destination?.close().catch(() => undefined)
    await source?.close().catch(() => undefined)
    if (retainedSlotReserved) pendingRetainedRecords -= 1
    if (directory && !retained) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
