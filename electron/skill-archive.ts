// 技能「从压缩包导入」（总单 Q4 C4）：客户在系统的选文件窗口里选一个 .zip，主进程把它解到星芒自己的
// 数据文件夹里，找到 SKILL.md 那一层，再交给跟「从文件夹导入」同一条路（resolveSkillImportSource 和
// 各家的导入）。那条路的检查（不许链接、单链接普通文件、个数和大小上限）解开以后照旧全做一遍，这里
// 先把压缩包本身能带进来的坑挡在解开之前：跳出文件夹的路径、链接、炸弹式的大小和个数、加密和怪格式。
//
// Only the zip features real skill archives use are read: stored and deflate
// entries, no encryption, no zip64, one disk. Anything else is refused rather
// than guessed at, because a misread size or offset is exactly how an archive
// smuggles bytes past the limits below.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { readBoundedFile } from './bounded-file'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'

export const MAX_SKILL_ARCHIVE_BYTES = 50 * 1024 * 1024
/** 解开后一共多大、多少个文件，跟「从文件夹导入」的上限一样（codex-extensions.ts 的 MAX_SKILL_*）。 */
export const MAX_SKILL_ARCHIVE_UNPACKED_BYTES = 50 * 1024 * 1024
export const MAX_SKILL_ARCHIVE_FILES = 2_000
const MAX_SKILL_ARCHIVE_ENTRIES = 10_000
const MAX_SKILL_ARCHIVE_DEPTH = 32
const MAX_SEGMENT_BYTES = 255

export const SKILL_ARCHIVE_UNREADABLE = '这个压缩包打不开：可能坏了、设了密码，或者不是 zip 格式。'
export const SKILL_ARCHIVE_TOO_LARGE = '这个压缩包太大了，最多 50 MB、2000 个文件。'
export const SKILL_ARCHIVE_UNSAFE = '这个压缩包里有不安全的内容（跳出文件夹的路径或链接文件），没有导入。'
export const SKILL_ARCHIVE_NO_SKILL = '这个压缩包里没找到技能（要有一个 SKILL.md 文件）。'
export const SKILL_ARCHIVE_MANY_SKILLS = '这个压缩包里有好几个技能，一次只能导入一个。'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const END_OF_CENTRAL_DIRECTORY_SIZE = 22
const MAX_ARCHIVE_COMMENT_BYTES = 0xffff
const FLAG_ENCRYPTED = 0x0001
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_UTF8_NAME = 0x0800
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
const UNIX_HOST = 3
const UNIX_TYPE_MASK = 0o170000
const UNIX_REGULAR_FILE = 0o100000
const UNIX_DIRECTORY = 0o040000
const DOS_DIRECTORY_ATTRIBUTE = 0x10
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export interface SkillArchiveEntry {
  /** 解开后的相对路径，用 / 分隔，已经查过不会跳出文件夹。 */
  path: string
  directory: boolean
  method: number
  crc32: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

export interface SkillArchivePlan {
  /** 技能落地用的文件夹名：SKILL.md 所在那一层的名字，在压缩包最外层时用压缩包的文件名。 */
  folderName: string
  /** SKILL.md 那一层下面的东西，path 已经去掉了那一层前缀。 */
  entries: SkillArchiveEntry[]
}

export interface SkillArchiveExtraction {
  archiveName: string
  /** 解开的技能文件夹（绝对路径），交给「从文件夹导入」那条路。 */
  directory: string
}

class SkillArchiveError extends Error {}

function unreadable(): never {
  throw new SkillArchiveError(SKILL_ARCHIVE_UNREADABLE)
}

function unsafe(): never {
  throw new SkillArchiveError(SKILL_ARCHIVE_UNSAFE)
}

function tooLarge(): never {
  throw new SkillArchiveError(SKILL_ARCHIVE_TOO_LARGE)
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ARCHIVE_COMMENT_BYTES)
  for (let offset = archive.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue
    // A signature that happens to sit inside the archive comment would not
    // account for the rest of the file exactly.
    if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + archive.readUInt16LE(offset + 20) === archive.length) return offset
  }
  return unreadable()
}

// 没打 UTF-8 标记的名字：Windows 自带的「发送到压缩文件夹」在中文系统上按 GBK 写，别的工具多半其实是
// UTF-8。先试 UTF-8，再试 GB18030，都不对就按单字节读出来（字会乱，但下面照样查得出跳出文件夹）。
function decodeEntryName(bytes: Buffer, utf8: boolean): string {
  if (utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return unreadable()
    }
  }
  if (bytes.every((byte) => byte < 0x80)) return bytes.toString('latin1')
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch {
      // Try the next encoding; a decoder this runtime lacks also lands here.
    }
  }
  return bytes.toString('latin1')
}

/**
 * The relative path an entry may be written to, or null for packaging debris
 * (macOS `__MACOSX/`, `.DS_Store`) that is skipped. Every segment must be a
 * name all three desktop platforms accept as-is; a name Windows would silently
 * rewrite (trailing dot or space) could otherwise land on a sibling's path.
 */
function resolveEntryPath(rawName: string): string | null {
  const name = rawName.normalize('NFC')
  if (CONTROL_CHARACTERS.test(name)) unsafe()
  const slashed = name.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) unsafe()
  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  if (segments[0].toLowerCase() === '__macosx' || segments[segments.length - 1] === '.DS_Store') return null
  if (segments.length > MAX_SKILL_ARCHIVE_DEPTH) unsafe()
  for (const segment of segments) {
    if (
      segment === '..'
      || WINDOWS_RESERVED_CHARACTERS.test(segment)
      || /[. ]$/.test(segment)
      || WINDOWS_DEVICE_NAME.test(segment)
      || Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES
    ) {
      unsafe()
    }
  }
  return segments.join('/')
}

function entryIsDirectory(rawName: string, hostSystem: number, externalAttributes: number): boolean {
  if (/[\\/]$/.test(rawName)) return true
  if (hostSystem === UNIX_HOST) return ((externalAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_DIRECTORY
  return (externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0
}

// Unix-made archives record the file type in the high half of the external
// attributes. Symlinks are the classic way out of the extraction root, and a
// fifo or device node has no business in a skill either.
function assertPlainEntryType(hostSystem: number, externalAttributes: number, directory: boolean): void {
  if (hostSystem !== UNIX_HOST) return
  const type = (externalAttributes >>> 16) & UNIX_TYPE_MASK
  if (type === 0) return
  if (type !== (directory ? UNIX_DIRECTORY : UNIX_REGULAR_FILE)) unsafe()
}

/**
 * 读压缩包的目录，查完每一条再交出来：不认识的格式、加密的报打不开，路径跳出文件夹、链接、
 * 同名（不分大小写）的报不安全，个数和解开后的大小超了报太大。只读目录、不解压。
 */
export function readSkillArchiveEntries(archive: Buffer): SkillArchiveEntry[] {
  if (archive.length < END_OF_CENTRAL_DIRECTORY_SIZE) unreadable()
  const end = findEndOfCentralDirectory(archive)
  const diskNumber = archive.readUInt16LE(end + 4)
  const directoryDisk = archive.readUInt16LE(end + 6)
  const entriesOnDisk = archive.readUInt16LE(end + 8)
  const totalEntries = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) unreadable()
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) unreadable()
  if (directoryOffset + directorySize > end) unreadable()
  if (totalEntries > MAX_SKILL_ARCHIVE_ENTRIES) tooLarge()

  const entries: SkillArchiveEntry[] = []
  const claimed = new Map<string, boolean>()
  let files = 0
  let unpackedBytes = 0
  let cursor = directoryOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > directoryOffset + directorySize) unreadable()
    if (archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) unreadable()
    const hostSystem = archive.readUInt8(cursor + 5)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc32 = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const startDisk = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localHeaderOffset = archive.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > directoryOffset + directorySize) unreadable()
    const rawName = decodeEntryName(archive.subarray(cursor + 46, cursor + 46 + nameLength), (flags & FLAG_UTF8_NAME) !== 0)
    cursor = next

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) unreadable()
    if (startDisk !== 0) unreadable()
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) unreadable()
    const directory = entryIsDirectory(rawName, hostSystem, externalAttributes)
    assertPlainEntryType(hostSystem, externalAttributes, directory)
    const entryPath = resolveEntryPath(rawName)
    if (entryPath === null) continue
    if (!directory) {
      if (method !== METHOD_STORED && method !== METHOD_DEFLATE) unreadable()
      if (method === METHOD_STORED && compressedSize !== size) unreadable()
      files += 1
      unpackedBytes += size
      if (files > MAX_SKILL_ARCHIVE_FILES || unpackedBytes > MAX_SKILL_ARCHIVE_UNPACKED_BYTES) tooLarge()
    }

    // Windows and macOS file systems fold case, so `SKILL.md` and `skill.md`
    // would be one file on disk; a file sharing a path with a directory (or
    // with a directory's ancestor) would make one write land inside the other.
    const key = entryPath.toLowerCase()
    const previous = claimed.get(key)
    if (previous !== undefined && (previous === false || !directory)) unsafe()
    claimed.set(key, directory)
    const segments = key.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join('/')
      if (claimed.get(ancestor) === false) unsafe()
      if (!claimed.has(ancestor)) claimed.set(ancestor, true)
    }
    entries.push({ path: entryPath, directory, method, crc32, compressedSize, size, localHeaderOffset })
  }
  return entries
}

function archiveStem(archiveName: string): string {
  const stem = archiveName.replace(/\.zip$/i, '').normalize('NFC')
  try {
    return resolveEntryPath(stem) === stem ? stem : 'skill'
  } catch {
    return 'skill'
  }
}

/**
 * 在压缩包里找技能：最浅的那个 SKILL.md 所在的一层（更深的算这个技能自己带的例子）。最浅的一层有
 * 不止一个时不替客户挑。只交出那一层下面的东西，压缩包里别处的说明文件不带过去。
 */
export function buildSkillArchivePlan(entries: readonly SkillArchiveEntry[], archiveName: string): SkillArchivePlan {
  const definitions = entries.filter((entry) => !entry.directory && path.posix.basename(entry.path) === 'SKILL.md')
  if (definitions.length === 0) throw new SkillArchiveError(SKILL_ARCHIVE_NO_SKILL)
  const depth = Math.min(...definitions.map((entry) => entry.path.split('/').length))
  const shallowest = definitions.filter((entry) => entry.path.split('/').length === depth)
  if (shallowest.length > 1) throw new SkillArchiveError(SKILL_ARCHIVE_MANY_SKILLS)
  const root = path.posix.dirname(shallowest[0].path)
  if (root === '.') return { folderName: archiveStem(archiveName), entries: [...entries] }
  const prefix = `${root}/`
  return {
    folderName: path.posix.basename(root),
    entries: entries
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) })),
  }
}

/** 解一条：长度和 CRC 都要跟目录里写的对得上，deflate 最多解出目录里写的那么多字节。 */
export function readSkillArchiveEntryData(archive: Buffer, entry: SkillArchiveEntry, dataLimit: number): Buffer {
  const header = entry.localHeaderOffset
  if (header + 30 > dataLimit || archive.readUInt32LE(header) !== LOCAL_FILE_HEADER) unreadable()
  const start = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28)
  const stop = start + entry.compressedSize
  if (stop > dataLimit) unreadable()
  const packed = archive.subarray(start, stop)
  let data: Buffer
  if (entry.method === METHOD_STORED) {
    data = packed
  } else {
    try {
      data = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) })
    } catch {
      return unreadable()
    }
  }
  if (data.length !== entry.size || zlib.crc32(data) !== entry.crc32) unreadable()
  return data
}

// 解压和清理在同一个临时文件夹上排队，一次只做一件：客户在解压的那一下关掉导入框，清理要等这次解完再删，
// 不然清理先看了一眼空文件夹就走，刚解开的那份就一直留到下次开机。
const archiveFolderQueues = new Map<string, Promise<void>>()

function runInArchiveFolderOrder<T>(baseDirectory: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(baseDirectory)
  const result = (archiveFolderQueues.get(key) ?? Promise.resolve()).then(work)
  const settled = result.then(() => undefined, () => undefined)
  archiveFolderQueues.set(key, settled)
  void settled.then(() => {
    if (archiveFolderQueues.get(key) === settled) archiveFolderQueues.delete(key)
  })
  return result
}

function centralDirectoryOffset(archive: Buffer): number {
  return archive.readUInt32LE(findEndOfCentralDirectory(archive) + 16)
}

// 只删星芒自己起名的那几个（randomUUID 的样子），文件夹里别的东西不碰。删不掉的留着，下次开机再删。
async function removeEarlierExtractions(baseDirectory: string): Promise<void> {
  let children: string[]
  try {
    children = await fs.promises.readdir(baseDirectory)
  } catch {
    return
  }
  for (const child of children) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(child)) continue
    await fs.promises.rm(path.join(baseDirectory, child), { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 导入框用完了（导入成功关掉、取消、换了页面），或者开机时：把解开的临时文件夹全删掉。各家导入都是复制一份
 * 进自己的技能文件夹，删了不影响已经导入的技能。还没有这个文件夹就什么都不做，不替它建一个。
 */
export async function discardSkillArchiveExtractions(baseDirectory: string): Promise<void> {
  return runInArchiveFolderOrder(baseDirectory, async () => {
    try {
      await fs.promises.lstat(baseDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    ensureSafeDataDirectory(baseDirectory, '技能压缩包临时文件夹')
    await removeEarlierExtractions(baseDirectory)
  })
}

/**
 * 读客户选的压缩包（最多 50 MB，单链接普通文件），查完、解到 baseDirectory 下新起的一个文件夹里，
 * 交出技能那一层的位置。解到一半出错就把这次的整个文件夹删掉；之前解开的那份先删掉，客户换了压缩包，
 * 旧的不会再被导入。这一份等导入框用完，由 discardSkillArchiveExtractions 删。
 */
export async function extractSkillArchive(archivePath: string, baseDirectory: string): Promise<SkillArchiveExtraction> {
  return runInArchiveFolderOrder(baseDirectory, () => unpackSkillArchive(archivePath, baseDirectory))
}

async function unpackSkillArchive(archivePath: string, baseDirectory: string): Promise<SkillArchiveExtraction> {
  const label = '技能压缩包'
  const archiveName = path.basename(archivePath)
  let archiveStats: fs.Stats
  try {
    archiveStats = await fs.promises.lstat(archivePath)
  } catch {
    return unreadable()
  }
  if (archiveStats.isFile() && archiveStats.size > MAX_SKILL_ARCHIVE_BYTES) tooLarge()
  const archive = await readBoundedFile(archivePath, MAX_SKILL_ARCHIVE_BYTES, label)
  const entries = readSkillArchiveEntries(archive)
  const plan = buildSkillArchivePlan(entries, archiveName)
  const dataLimit = centralDirectoryOffset(archive)

  ensureSafeDataDirectory(baseDirectory, '技能压缩包临时文件夹')
  await removeEarlierExtractions(baseDirectory)
  const workDirectory = path.join(baseDirectory, randomUUID())
  await fs.promises.mkdir(workDirectory, { mode: 0o700 })
  const skillDirectory = path.join(workDirectory, plan.folderName)
  try {
    await fs.promises.mkdir(skillDirectory)
    for (const entry of plan.entries) {
      const target = path.join(skillDirectory, ...entry.path.split('/'))
      if (entry.directory) {
        await fs.promises.mkdir(target, { recursive: true })
        continue
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      assertNoReparseComponents(path.dirname(target), '技能压缩包临时文件夹')
      await fs.promises.writeFile(target, readSkillArchiveEntryData(archive, entry, dataLimit), { flag: 'wx' })
    }
  } catch (error) {
    await fs.promises.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return { archiveName, directory: skillDirectory }
}
