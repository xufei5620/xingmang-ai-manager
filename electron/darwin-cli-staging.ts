import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  /** Retained acquisitions remain leased until explicit release or process exit. */
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

function disposeStagedDarwinCliRecordsAtExit(): void {
  for (const record of drainStagedDarwinCliRecords()) {
    try {
      fs.rmSync(record.directory, { recursive: true, force: true })
    } catch {
      // Process exit cleanup is best effort; the OS also reclaims its temp tree.
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
  process.once('exit', disposeStagedDarwinCliRecordsAtExit)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export async function cleanupStaleDarwinCliDirectories(
  baseDirectory = os.tmpdir(),
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(baseDirectory, { withFileTypes: true })
  } catch {
    return
  }
  const currentUid = process.getuid?.()
  await Promise.all(entries.map(async (entry) => {
    const match = /^xingmang-darwin-cli-(\d+)-/.exec(entry.name)
    if (!match || !entry.isDirectory()) return
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) return
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

export async function releaseStagedDarwinCli(executablePath: string): Promise<void> {
  const record = stagedRecords.get(executablePath)
  if (!record) return
  record.leaseCount -= 1
  if (record.leaseCount > 0) return
  stagedRecords.delete(executablePath)
  if (record.cacheKey && retainedSelections.get(record.cacheKey) === record) {
    retainedSelections.delete(record.cacheKey)
  }
  await fs.promises.rm(record.directory, { recursive: true, force: true }).catch(() => undefined)
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
 * Retained copies use process-lifetime ownership because Terminal execution may lag after open.
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
  await cleanupStaleOnce(baseDirectory)
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
      if (retainedSelections.get(retainedKey) === cached) {
        retainedSelections.delete(retainedKey)
      }
      await releaseStagedDarwinCli(cached.executablePath)
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
