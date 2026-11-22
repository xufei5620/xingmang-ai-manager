// 技能导入只复制当初核过的那一份（审查总表 O17）：先把客户选的技能文件夹整棵树走一遍，记下每个文件夹、
// 每个文件是哪一个（盘号和文件号）、多大；复制时不再重新列来源文件夹，只照这份清单一项一项拿，每拿一项都
// 对一下还是不是清单上那一个，对不上就整次停下。复制先落在受管目录里一个临时文件夹，全部核完才改名成技能
// 文件夹；中途停下只删那个临时文件夹，来源文件夹从头到尾只读。Codex、Claude Code、Grok 三家的导入和
// 「从压缩包导入」解开的那一份都走这里（codex-extensions.ts 的 resolveSkillImportSource / stageSkillImport）。
//
// Identity is compared on bigint stats: Windows file indexes are 64-bit and lose
// precision as Numbers, which would let two different files look the same.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DirectoryEntryLimitError, readDirectoryEntriesSync } from './bounded-directory'

export const SKILL_IMPORT_CHANGED_MESSAGE = '导入过程中文件夹内容发生变化，为确保安全已停止导入，未导入任何内容，原文件夹未做改动。请确认文件夹内容不再变化后重新导入。'

/** 导入途中来源换了样：这一次整个作废，什么都不留。 */
export class SkillImportChangedError extends Error {
  constructor() {
    super(SKILL_IMPORT_CHANGED_MESSAGE)
    this.name = 'SkillImportChangedError'
  }
}

export interface SkillTreeLimits {
  files: number
  bytes: number
  /** 整棵树一共能列出多少项。 */
  entries: number
  depth: number
}

export interface SkillSnapshotEntry {
  /** 相对技能文件夹的各级名字；技能文件夹自己是空的。 */
  segments: readonly string[]
  kind: 'directory' | 'file'
  dev: bigint
  ino: bigint
  /** 文件的字节数；文件夹记 0。 */
  size: bigint
}

export interface SkillTreeSnapshot {
  root: string
  /** 技能文件夹自己排第一，每个文件夹都排在它里面的东西前面。 */
  entries: readonly SkillSnapshotEntry[]
}

/** 只给测试用：在某个文件打开前的那一刻换掉东西。 */
export interface SkillSnapshotCopyHooks {
  beforeOpen?: (relativePath: string) => void
}

export interface SkillImportStaging {
  directory: string
  dev: bigint
  ino: bigint
}

const definitionFileName = 'SKILL.md'
const changedCodes = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'])

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

// A path that no longer resolves to what was listed (gone, turned into a link,
// a file where a folder was) is the same event as a changed identity.
function changedOr(error: unknown): unknown {
  return changedCodes.has(errorCode(error) ?? '') ? new SkillImportChangedError() : error
}

function lstatBig(filePath: string): fs.BigIntStats {
  try {
    return fs.lstatSync(filePath, { bigint: true })
  } catch (error) {
    throw changedOr(error)
  }
}

function sameObject(left: Pick<fs.BigIntStats, 'dev' | 'ino'>, right: Pick<fs.BigIntStats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

// Windows and macOS file systems ignore case, so `skill.md` was accepted there
// before; keep that rather than refuse folders that used to import.
function isDefinitionName(name: string): boolean {
  if (name === definitionFileName) return true
  return (process.platform === 'win32' || process.platform === 'darwin')
    && name.toLowerCase() === definitionFileName.toLowerCase()
}

/**
 * 把技能文件夹整棵树走一遍并记下来，规矩跟以前的检查一样：不收链接，文件只收单链接普通文件，个数、
 * 大小、层数、列出的项数都有上限，根部要有 SKILL.md。每个文件夹列之前、列之后各看一次，列的途中换了的也算变了。
 */
export function snapshotSkillTree(sourceDirectory: string, limits: SkillTreeLimits): SkillTreeSnapshot {
  const root = path.resolve(sourceDirectory)
  const entries: SkillSnapshotEntry[] = []
  let files = 0
  let bytes = 0
  let listed = 0
  const pending: Array<{ segments: string[]; depth: number }> = [{ segments: [], depth: 0 }]
  while (pending.length) {
    const { segments, depth } = pending.pop()!
    const current = path.join(root, ...segments)
    const stats = lstatBig(current)
    if (stats.isSymbolicLink()) throw new Error('Skill 导入不允许包含符号链接')
    if (stats.isFile()) {
      // A hard link looks like an ordinary file but can carry content from
      // outside the chosen directory into the managed skills tree (I8).
      if (stats.nlink !== 1n) throw new Error('Skill 导入不允许包含硬链接文件')
      files += 1
      bytes += Number(stats.size)
      if (files > limits.files || bytes > limits.bytes) throw new Error('Skill 导入内容超过安全限制')
      entries.push({ segments, kind: 'file', dev: stats.dev, ino: stats.ino, size: stats.size })
      continue
    }
    if (!stats.isDirectory()) throw new Error('Skill 导入只允许普通文件和目录')
    if (depth >= limits.depth) throw new Error('Skill 导入目录层级超过安全限制')
    const remaining = limits.entries - listed
    if (remaining < 1) throw new DirectoryEntryLimitError('Skill 导入目录', limits.entries)
    let children: fs.Dirent[]
    try {
      children = readDirectoryEntriesSync(current, remaining, 'Skill 导入目录')
    } catch (error) {
      throw changedOr(error)
    }
    const after = lstatBig(current)
    if (!after.isDirectory() || after.isSymbolicLink() || !sameObject(stats, after)) throw new SkillImportChangedError()
    listed += children.length
    entries.push({ segments, kind: 'directory', dev: stats.dev, ino: stats.ino, size: 0n })
    for (const child of children) pending.push({ segments: [...segments, child.name], depth: depth + 1 })
  }
  const definition = entries.find((entry) => entry.segments.length === 1 && isDefinitionName(entry.segments[0]))
  if (!definition || definition.kind !== 'file') throw new Error('Skill 目录根部缺少 SKILL.md')
  return { root, entries }
}

function assertSameDirectory(directoryPath: string, entry: SkillSnapshotEntry): void {
  const stats = lstatBig(directoryPath)
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameObject(stats, entry)) throw new SkillImportChangedError()
}

function openSnapshotFile(filePath: string, entry: SkillSnapshotEntry): number {
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (changedCodes.has(errorCode(error) ?? '')) throw new SkillImportChangedError()
    // Windows reports a folder opened as a file as a permission error. Only a
    // path that still names the listed file keeps the original error.
    let current: fs.BigIntStats
    try {
      current = fs.lstatSync(filePath, { bigint: true })
    } catch {
      throw new SkillImportChangedError()
    }
    if (!current.isFile() || !sameObject(current, entry)) throw new SkillImportChangedError()
    throw error
  }
}

/**
 * 照快照一项一项复制进 stagingDirectory（它自己要已经建好、是空的）。不再列来源文件夹：快照之后多出来的
 * 东西不会被带进来。文件夹建里面的东西之前先核还是不是快照里那个；文件经同一个句柄核对、读取，句柄上看到的
 * 必须正是快照里那个文件、一样大，对不上当场停下。全部写完再把快照里的文件夹核一遍。
 * 写一律用独占新建，什么都不跟着走。
 */
export function copySkillSnapshot(
  snapshot: SkillTreeSnapshot,
  stagingDirectory: string,
  limits: Pick<SkillTreeLimits, 'bytes'>,
  hooks: SkillSnapshotCopyHooks = {},
): void {
  let bytes = 0
  for (const entry of snapshot.entries) {
    const sourcePath = path.join(snapshot.root, ...entry.segments)
    const targetPath = path.join(stagingDirectory, ...entry.segments)
    if (entry.kind === 'directory') {
      assertSameDirectory(sourcePath, entry)
      if (entry.segments.length) fs.mkdirSync(targetPath)
      continue
    }
    hooks.beforeOpen?.(entry.segments.join('/'))
    const descriptor = openSnapshotFile(sourcePath, entry)
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true })
      if (!opened.isFile()) throw new SkillImportChangedError()
      if (opened.nlink !== 1n) throw new Error('Skill 导入不允许包含硬链接文件')
      if (!sameObject(opened, entry) || opened.size !== entry.size) throw new SkillImportChangedError()
      const size = Number(entry.size)
      bytes += size
      if (bytes > limits.bytes) throw new Error('Skill 导入内容超过安全限制')
      const content = Buffer.alloc(size)
      let offset = 0
      while (offset < content.length) {
        const read = fs.readSync(descriptor, content, offset, content.length - offset, offset)
        if (read === 0) throw new SkillImportChangedError()
        offset += read
      }
      fs.writeFileSync(targetPath, content, { flag: 'wx' })
    } finally {
      fs.closeSync(descriptor)
    }
  }
  for (const entry of snapshot.entries) {
    if (entry.kind === 'directory') assertSameDirectory(path.join(snapshot.root, ...entry.segments), entry)
  }
}

/**
 * 在受管目录里新建一个只给这一次用的临时文件夹（名字带随机串，已存在就建不成），建好再看一眼它确实是个
 * 文件夹，记下它是哪一个，删的时候先对上。跟技能文件夹在同一处，最后一步改名不跨盘。
 */
export function createSkillImportStaging(root: string): SkillImportStaging {
  fs.mkdirSync(root, { recursive: true })
  const directory = path.join(root, `.xingmang-import-${randomUUID()}`)
  fs.mkdirSync(directory)
  const stats = fs.lstatSync(directory, { bigint: true })
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Skill 导入临时文件夹创建失败')
  return { directory, dev: stats.dev, ino: stats.ino }
}

/** 临时文件夹还是当初建的那一个才删；已经没了、或被换成别的东西就不碰。 */
export function discardSkillImportStaging(staging: SkillImportStaging): void {
  let stats: fs.BigIntStats
  try {
    stats = fs.lstatSync(staging.directory, { bigint: true })
  } catch {
    return
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameObject(stats, staging)) return
  fs.rmSync(staging.directory, { recursive: true, force: true })
}

/** 临时文件夹改名前再对一次：被换掉的不搬。 */
export function assertSkillImportStaging(staging: SkillImportStaging): void {
  const stats = lstatBig(staging.directory)
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameObject(stats, staging)) throw new SkillImportChangedError()
}
