import fs from 'node:fs'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { mapWithConcurrency } from './async-map'
import { DEFAULT_MAXIMUM_IMAGE_BYTES } from './ai-asset-store'
import { DEFAULT_MAXIMUM_AUDIO_BYTES } from './ai-audio-asset-store'
import { DEFAULT_MAXIMUM_VIDEO_BYTES } from './ai-video-asset-store'
import { MAXIMUM_INDEXED_ASSETS } from './ai-asset-index'
import { parseTransferredAiAssetMetadataItems, type AiAssetMetadataItem } from './ai-asset-metadata-store'
import { readDiskSpace as defaultReadDiskSpace, type DiskSpaceReading } from './disk-space'
import { formatFreeSpace } from './disk-space-copy'
import { isRecord } from './input-guards'
import { sameLocalPathIdentity } from './path-identity'
import { resolveRelocatedPath } from './relocated-folders'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'
import type { CanvasProjectsExportPlan, CanvasProjectsImportCounts, CanvasProjectsImportSource, CanvasProjectsMigration } from './data-transfer-canvas'

// 「迁移到新电脑」里的作品（「搬作品改」，yoyo 2026-11-22）：当前账号作品库里的图片、视频片段和成片、配乐。
// 作品可能有几个 GB，放不进那一份 JSON：选了带作品时，在客户选的位置新建一个文件夹，聊天记录那份文件放在
// 里面，作品照作品库的样子（<日期>/xingmang-<编号>.<扩展名>）放进旁边的「作品」文件夹，一件一个文件。
// 这样客户只要复制一个文件夹；单个文件最大 512 MB，FAT32 的 U 盘也装得下。
//
// 布局和作品库一样，编号也不变：视频分镜里存的是作品编号（xingmang-asset://<类型>/<编号> 按编号在作品库里找），
// 放回新电脑同样的位置，分镜里的片段、镜头图、配乐就都接上了，作品库里也照样列出来（同 ai-output-location.ts
// 搬老作品那一套）。对话里的图片、视频也一样：带作品导出时原样带着，导过来就照常显示（renderer-v2 chat/storage.ts 的
// exportableConversations）；不带作品时才换成一句说明。
//
// 文件一个一个复制，一次 1 MB，不整个读进内存；导出、导入之前先看空间够不够。
//
// 画布项目里生成的作品也一起带（「画布也搬」，yoyo 2026-11-22）：作品库页（#2091）同时列出各画布项目文件夹里生成的
// 图片和视频，导出时照作品库页列的那些一件不差地带上（canvas-project-asset-manager.ts 的 listLibraryFolders），
// 询问框里的件数、大小就跟作品库页对得上。项目文件夹在旧电脑上是客户自己选的位置，新电脑上没有这个项目，所以这些
// 作品跟别的作品放在一起，照同样的布局进新电脑当前账号的 AI 作品文件夹，作品库里照常列出、名字标签提示词都在，
// 对话、分镜里按编号也找得到。画布项目本身（节点和连线）也跟着搬时，它们跟着项目放回新项目的文件夹
// （data-transfer-canvas.ts）。

export const WORKS_FOLDER_NAME = '作品'
export const WORKS_MANIFEST_FILE = 'xingmang-works.json'
export const WORKS_DATA_FILE_NAME = '星芒聊天记录与设置.json'
const WORKS_MANIFEST_FORMAT = 'xingmang-works'
const WORKS_MANIFEST_VERSION = 1
// 清单里是文件列表（每件几十字节）和作品库的名字、标签、提示词。元数据分片一共不过 32 MB。
export const MAX_WORKS_MANIFEST_BYTES = 64 * 1024 * 1024
/** 三类作品各自最多建 MAXIMUM_INDEXED_ASSETS 条索引，作品库再多也列不出来。 */
export const MAX_TRANSFERRED_WORKS = MAXIMUM_INDEXED_ASSETS * 3
// ai-asset-index.ts 一个日期文件夹超过 4096 个条目就整个读不出来（深查 G-1）：导入时并到本机已有的那一天上，
// 留出余量，宁可那几件不导，也不让整个作品库打不开。
const MAX_DATE_DIRECTORY_ENTRIES = 4_000
const MAX_ACCOUNT_DIRECTORY_ENTRIES = 4_096
// 导出时清单和聊天记录那份文件之外再留一点；导入后至少还剩这么多，免得把客户的盘写满。
const EXPORT_SPARE_BYTES = 32 * 1024 * 1024
const IMPORT_SPARE_BYTES = 256 * 1024 * 1024
const LIST_CONCURRENCY = 8
// 一次读写 1 MB：几个 GB 的作品也只占这么一块内存。
const COPY_CHUNK_BYTES = 1024 * 1024
const LABEL = 'AI 作品'
const EXPORTED_FILE_MODE = 0o644

const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const WORK_FILE_PATTERN = /^xingmang-([A-Za-z0-9_-]{43})\.(png|jpg|webp|mp4|mp3|wav|ogg|m4a)$/
const WORK_RELATIVE_PATH_PATTERN = /^(\d{4}-\d{2}-\d{2})\/(xingmang-([A-Za-z0-9_-]{43})\.(png|jpg|webp|mp4|mp3|wav|ogg|m4a))$/

export type WorkMediaType = 'image' | 'video' | 'audio'

const mediaTypeOfExtension: Readonly<Record<string, WorkMediaType>> = {
  png: 'image', jpg: 'image', webp: 'image', mp4: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
}
// 跟三家作品库自己的上限一样：比它大的作品库本来就不收、读不出来。
const maximumBytesOf: Readonly<Record<WorkMediaType, number>> = {
  image: DEFAULT_MAXIMUM_IMAGE_BYTES,
  video: DEFAULT_MAXIMUM_VIDEO_BYTES,
  audio: DEFAULT_MAXIMUM_AUDIO_BYTES,
}

/** 作品库里的一件作品：编号、类型、大小，和它在作品库（也是导出的「作品」文件夹）里的位置。 */
export interface AccountWork {
  assetId: string
  mediaType: WorkMediaType
  /** `<日期>/<文件名>`，用 / 分隔。 */
  relativePath: string
  bytes: number
}

/** 带着本机路径的那一份，只在主进程里用。 */
export interface LocatedAccountWork extends AccountWork {
  filePath: string
}

export interface AccountWorksSummary {
  images: number
  videos: number
  audios: number
  /** 要导出的一共多大：作品，带画布项目时连同项目里的文件。 */
  bytes: number
  /** 跟着导出的画布项目几个（data-transfer-canvas.ts）；没有就不写。 */
  canvasProjects?: number
  /** 文件夹现在找不到、导不出去的画布项目几个，只在导出前报数时有。 */
  canvasProjectsUnreachable?: number
}

export function summarizeAccountWorks(works: readonly AccountWork[]): AccountWorksSummary {
  const summary: AccountWorksSummary = { images: 0, videos: 0, audios: 0, bytes: 0 }
  for (const work of works) {
    if (work.mediaType === 'image') summary.images += 1
    else if (work.mediaType === 'video') summary.videos += 1
    else summary.audios += 1
    summary.bytes += work.bytes
  }
  return summary
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Lists one account's stored works without reading a byte of media: one
 * readdir per folder and one lstat per file, a few at a time so a large library
 * never floods the main process. Only single-link regular files that the asset
 * stores themselves would serve are listed (same names, same size ceilings);
 * anything else in the folder is not a work and is left out. The same asset id
 * can sit under two dates; the newest one is the one the stores find first, so
 * that is the one listed.
 */
export async function listAccountWorks(
  outputRoot: string,
  userId: number,
  options: { excluded?: ReadonlySet<string>; included?: ReadonlySet<string> } = {},
): Promise<LocatedAccountWork[]> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('AI 作品账号标识无效')
  const accountRoot = resolveRelocatedPath(path.join(outputRoot, `user-${userId}`))
  let dates: fs.Dirent[]
  try {
    assertNoReparseComponents(accountRoot, LABEL)
    dates = await fs.promises.readdir(accountRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  if (dates.length > MAX_ACCOUNT_DIRECTORY_ENTRIES) throw new Error(`${LABEL}目录条目过多`)
  const candidates: Array<{ date: string; name: string; assetId: string; mediaType: WorkMediaType }> = []
  for (const date of dates.filter((entry) => entry.isDirectory() && DATE_DIRECTORY_PATTERN.test(entry.name)).map((entry) => entry.name).sort().reverse()) {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(path.join(accountRoot, date), { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    for (const entry of entries) {
      const match = entry.isFile() ? WORK_FILE_PATTERN.exec(entry.name) : null
      if (!match || options.excluded?.has(match[1]) || (options.included && !options.included.has(match[1]))) continue
      candidates.push({ date, name: entry.name, assetId: match[1], mediaType: mediaTypeOfExtension[match[2]] })
    }
  }
  const located = await mapWithConcurrency(candidates, LIST_CONCURRENCY, async (candidate): Promise<LocatedAccountWork | null> => {
    const filePath = path.join(accountRoot, candidate.date, candidate.name)
    try {
      const stats = await fs.promises.lstat(filePath)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > maximumBytesOf[candidate.mediaType]) return null
      return { assetId: candidate.assetId, mediaType: candidate.mediaType, relativePath: `${candidate.date}/${candidate.name}`, bytes: stats.size, filePath }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  })
  const seen = new Set<string>()
  const works: LocatedAccountWork[] = []
  for (const work of located) {
    if (!work || seen.has(work.assetId)) continue
    seen.add(work.assetId)
    works.push(work)
    if (works.length >= MAX_TRANSFERRED_WORKS) break
  }
  return works
}

// ---- 导出 ----

/** 「搬作品改」批的字。 */
export function worksExportNoSpaceMessage(worksBytes: number, availableBytes: number): string {
  return `所选位置剩余空间不足：作品约 ${formatFreeSpace(worksBytes)}，该位置仅剩 ${formatFreeSpace(availableBytes)}。请选择其他位置，或选择「仅导出聊天记录和设置」。`
}
export const worksExportIncompleteMessage = '作品导出未完成，本次已写入的文件已清除。请确认所选位置可以写入（例如 U 盘未拔出、空间充足）后再次导出。'

export function buildWorksManifest(works: readonly AccountWork[], metadata: readonly AiAssetMetadataItem[]): string {
  const exported = new Set(works.map((work) => work.assetId))
  const described = new Set<string>()
  const content = JSON.stringify({
    format: WORKS_MANIFEST_FORMAT,
    version: WORKS_MANIFEST_VERSION,
    files: works.map((work) => ({ path: work.relativePath, bytes: work.bytes })),
    // 回收站里的不导出，名字、标签、收藏、提示词只带导出了的那几件。一件只带一条：导入时同一编号有两条，整个清单都不认。
    metadata: metadata.filter((item) => {
      if (!exported.has(item.assetId) || item.deletedAt || described.has(item.assetId)) return false
      described.add(item.assetId)
      return true
    }),
  })
  if (Buffer.byteLength(content, 'utf8') > MAX_WORKS_MANIFEST_BYTES) throw new Error(`${LABEL}清单超过 64 MB，无法导出`)
  return content
}

/** 文件夹名字被占了就接着往后编号：「…-2026-11-22 (2)」，不碰已有的那个。 */
async function createExportFolder(parent: string, name: string): Promise<string> {
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const folder = path.join(parent, attempt === 1 ? name : `${name} (${attempt})`)
    try {
      await fs.promises.mkdir(folder)
      return folder
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('所选位置已有过多同名文件夹，请选择其他位置')
}

/** 这一件读不了或读的时候变了：不导这一件，别的照常。画布项目那边（data-transfer-canvas.ts）照同一套抄文件。 */
export class WorkSourceRejected extends Error {}

/**
 * Opens a work for copying and proves the handle is the plain file that was
 * listed: a single-link regular file within the ceiling (and of the size the
 * manifest promised, when there is one), reached through no link. The copy then
 * reads from this handle only, so a file swapped for a link after the check
 * cannot redirect what is read.
 */
export async function openVerifiedWork(filePath: string, maximumBytes: number, expectedBytes?: number): Promise<{ handle: fs.promises.FileHandle; before: fs.BigIntStats }> {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(filePath, 'r')
  } catch (error) {
    throw new WorkSourceRejected('cannot open', { cause: error })
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximumBytes)
      || (expectedBytes !== undefined && before.size !== BigInt(expectedBytes))) {
      throw new WorkSourceRejected('not a plain file of the expected size')
    }
    const current = await fs.promises.lstat(filePath, { bigint: true })
    const canonical = await fs.promises.realpath(filePath)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino
      || !sameLocalPathIdentity(canonical, filePath)) {
      throw new WorkSourceRejected('changed before reading')
    }
    return { handle, before }
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (error instanceof WorkSourceRejected) throw error
    throw new WorkSourceRejected('cannot inspect', { cause: error })
  }
}

/**
 * Copies an opened work into a new file a chunk at a time, reading only through
 * the checked handle. The written size and the source's unchanged state are
 * checked after. A plain read and write loop rather than streams: a stream made
 * on a FileHandle keeps a reference that makes close() wait until the stream
 * itself closes, which would tie the handle's lifetime to the stream's.
 */
export async function copyWork(source: { handle: fs.promises.FileHandle; before: fs.BigIntStats }, destination: string, mode: number, sync: boolean): Promise<void> {
  const output = await fs.promises.open(destination, 'wx', mode)
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
    let position = 0
    for (;;) {
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      // Grew while being read: stop instead of copying whatever keeps arriving.
      if (BigInt(position) > source.before.size) throw new WorkSourceRejected('changed while reading')
      for (let written = 0; written < bytesRead;) {
        written += (await output.write(buffer, written, bytesRead - written)).bytesWritten
      }
    }
    if (sync) await output.sync()
    const written = await output.stat({ bigint: true })
    if (written.size !== source.before.size) throw new WorkSourceRejected('written size does not match')
  } finally {
    await output.close().catch(() => undefined)
  }
  const after = await source.handle.stat({ bigint: true })
  if (after.size !== source.before.size || after.mtimeNs !== source.before.mtimeNs) throw new WorkSourceRejected('changed while reading')
}

/**
 * 作品之外，跟着写进同一个导出文件夹的东西（画布项目，data-transfer-canvas.ts）。写进去的文件和新建的文件夹
 * 都记在这里，导出没做完时跟作品一起删掉。
 */
export interface ExportFolderWriter {
  folderPath: string
  /** 「作品」文件夹里实际导出了的作品编号。 */
  exported: ReadonlySet<string>
  directory(directoryPath: string): void
  file(filePath: string): void
}

export interface WorksExportAlongside {
  /** 估空间时另加的字节数。 */
  bytes: number
  /** 作品和清单写完以后、聊天记录那份文件之前写；回实际导出了几个画布项目、写了多大。 */
  write(target: ExportFolderWriter): Promise<{ canvasProjects: number; bytes: number }>
}

export interface WorksExportOptions {
  /** 客户在系统窗口里选的位置。 */
  parentDirectory: string
  /** 新建的文件夹叫什么（被占了接着编号）。 */
  folderName: string
  works: readonly LocatedAccountWork[]
  metadata: readonly AiAssetMetadataItem[]
  /** 聊天记录与设置那份文件的内容（按实际导出了的那几件记数），最后才写：写出来了才算导出完。 */
  dataContent: (exported: AccountWorksSummary) => string
  /** 画布项目（data-transfer-canvas.ts）。 */
  alongside?: WorksExportAlongside
  readDiskSpace?: (target: string) => Promise<DiskSpaceReading | null>
}

export interface WorksExportResult {
  folderPath: string
  dataFilePath: string
  /** 实际导出了几件：列出来以后又被删掉的不算。 */
  works: number
  /** 读不了、没导出的几件（被别的程序占着、导出途中被改过），只记日志。 */
  skipped: number
  /** 带了画布项目时，实际导出了几个。 */
  canvasProjects?: number
}

/**
 * Writes the export folder: every work, then the manifest, then the chat and
 * settings file last, so a folder without that file was never finished and
 * cannot be imported half-done. A work that vanished or cannot be read from
 * this computer is left out; anything that goes wrong writing to the chosen
 * place stops the export, and every file this run wrote is removed again.
 * Nothing that was there before is ever touched: the folder is new, and only
 * files this run created are removed.
 */
export async function writeWorksExport(options: WorksExportOptions): Promise<WorksExportResult> {
  const parent = resolveRelocatedPath(options.parentDirectory)
  const worksBytes = options.works.reduce((total, work) => total + work.bytes, 0) + (options.alongside?.bytes ?? 0)
  const reading = await (options.readDiskSpace ?? defaultReadDiskSpace)(parent)
  const needed = worksBytes + Buffer.byteLength(options.dataContent(summarizeAccountWorks(options.works)), 'utf8') + EXPORT_SPARE_BYTES
  if (reading && reading.availableBytes < needed) throw new Error(worksExportNoSpaceMessage(worksBytes, reading.availableBytes))
  assertNoReparseComponents(parent, '导出位置')
  const folderPath = await createExportFolder(parent, options.folderName)
  const createdDirectories = [folderPath]
  const writtenFiles: string[] = []
  const exported: LocatedAccountWork[] = []
  let skipped = 0
  try {
    const worksFolder = path.join(folderPath, WORKS_FOLDER_NAME)
    await fs.promises.mkdir(worksFolder)
    createdDirectories.push(worksFolder)
    const dates = new Set<string>()
    for (const work of options.works) {
      const [date, name] = work.relativePath.split('/')
      let source: Awaited<ReturnType<typeof openVerifiedWork>>
      try {
        source = await openVerifiedWork(work.filePath, maximumBytesOf[work.mediaType])
      } catch {
        skipped += 1
        continue
      }
      try {
        if (!dates.has(date)) {
          await fs.promises.mkdir(path.join(worksFolder, date))
          createdDirectories.push(path.join(worksFolder, date))
          dates.add(date)
        }
        const destination = path.join(worksFolder, date, name)
        writtenFiles.push(destination)
        try {
          await copyWork(source, destination, EXPORTED_FILE_MODE, false)
        } catch (error) {
          if (!(error instanceof WorkSourceRejected)) throw error
          await fs.promises.rm(destination, { force: true })
          writtenFiles.pop()
          skipped += 1
          continue
        }
        exported.push({ ...work, bytes: Number(source.before.size) })
      } finally {
        await source.handle.close().catch(() => undefined)
      }
    }
    const manifestPath = path.join(worksFolder, WORKS_MANIFEST_FILE)
    writtenFiles.push(manifestPath)
    await fs.promises.writeFile(manifestPath, buildWorksManifest(exported, options.metadata), { flag: 'wx', mode: EXPORTED_FILE_MODE })
    const alongside = options.alongside
      ? await options.alongside.write({
        folderPath,
        exported: new Set(exported.map((work) => work.assetId)),
        directory: (directory) => { createdDirectories.push(directory) },
        file: (file) => { writtenFiles.push(file) },
      })
      : undefined
    const summary = summarizeAccountWorks(exported)
    const written: AccountWorksSummary = alongside
      ? { ...summary, bytes: summary.bytes + alongside.bytes, canvasProjects: alongside.canvasProjects }
      : summary
    const dataFilePath = path.join(folderPath, WORKS_DATA_FILE_NAME)
    writtenFiles.push(dataFilePath)
    const data = await fs.promises.open(dataFilePath, 'wx', EXPORTED_FILE_MODE)
    try {
      await data.writeFile(options.dataContent(written), 'utf8')
      await data.sync()
    } finally {
      await data.close()
    }
    return { folderPath, dataFilePath, works: exported.length, skipped, ...(alongside ? { canvasProjects: alongside.canvasProjects } : {}) }
  } catch (error) {
    for (const file of writtenFiles.reverse()) await fs.promises.rm(file, { force: true }).catch(() => undefined)
    // rmdir only removes an empty folder, so anything that did not come from this run stays.
    for (const directory of createdDirectories.reverse()) await fs.promises.rmdir(directory).catch(() => undefined)
    throw new Error(worksExportIncompleteMessage, { cause: error })
  }
}

// ---- 导入 ----

export interface WorksManifestEntry extends AccountWork {
  date: string
  fileName: string
}

export interface ParsedWorksManifest {
  files: WorksManifestEntry[]
  metadata: AiAssetMetadataItem[]
}

/**
 * One file of a manifest: exactly `<date>/xingmang-<id>.<extension>` and a
 * size within that kind's ceiling, or null. Shared with the canvas projects'
 * manifest (data-transfer-canvas.ts), whose files are laid out the same way.
 */
export function parseWorksManifestEntry(entry: unknown): WorksManifestEntry | null {
  if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.bytes !== 'number') return null
  const match = WORK_RELATIVE_PATH_PATTERN.exec(entry.path)
  if (!match) return null
  const [, date, fileName, assetId, extension] = match
  const mediaType = mediaTypeOfExtension[extension]
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > maximumBytesOf[mediaType]) return null
  return { assetId, mediaType, relativePath: entry.path, bytes: entry.bytes, date, fileName }
}

/**
 * The manifest comes from a folder the user picked, so it is hostile input
 * (I5): every path must be exactly `<date>/xingmang-<id>.<extension>` (no
 * separators, no `..`, nothing the stores would not name themselves), every
 * size within that kind's ceiling, no asset twice, and every metadata record
 * must pass the store's own field checks. Anything off rejects the manifest.
 */
export function parseWorksManifest(raw: string): ParsedWorksManifest {
  const invalid = new Error(`${LABEL}清单无效`)
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw invalid }
  if (!isRecord(value) || value.format !== WORKS_MANIFEST_FORMAT || value.version !== WORKS_MANIFEST_VERSION) throw invalid
  if (!Array.isArray(value.files) || value.files.length > MAX_TRANSFERRED_WORKS) throw invalid
  const seen = new Set<string>()
  const files = value.files.map((entry): WorksManifestEntry => {
    const parsed = parseWorksManifestEntry(entry)
    if (!parsed || seen.has(parsed.assetId)) throw invalid
    seen.add(parsed.assetId)
    return parsed
  })
  let metadata: AiAssetMetadataItem[]
  try {
    metadata = parseTransferredAiAssetMetadataItems(value.metadata ?? [])
  } catch {
    throw invalid
  }
  return { files, metadata: metadata.filter((item) => seen.has(item.assetId)) }
}

export type WorksFolderInspection =
  | { state: 'ready'; folder: string; manifest: ParsedWorksManifest }
  | { state: 'missing' }
  | { state: 'unreadable' }

/**
 * Finds the works folder beside the chosen file. Its name is fixed, never read
 * from the file, so the file cannot point anywhere else on the computer.
 */
export async function inspectWorksFolder(dataFilePath: string): Promise<WorksFolderInspection> {
  const folder = resolveRelocatedPath(path.join(path.dirname(dataFilePath), WORKS_FOLDER_NAME))
  try {
    const stats = await fs.promises.lstat(folder)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return { state: 'unreadable' }
  } catch (error) {
    return isMissing(error) ? { state: 'missing' } : { state: 'unreadable' }
  }
  try {
    assertNoReparseComponents(folder, LABEL)
    const source = await openVerifiedWork(path.join(folder, WORKS_MANIFEST_FILE), MAX_WORKS_MANIFEST_BYTES)
    try {
      const raw = await source.handle.readFile('utf8')
      return { state: 'ready', folder, manifest: parseWorksManifest(raw.replace(/^﻿/, '')) }
    } finally {
      await source.handle.close().catch(() => undefined)
    }
  } catch {
    return { state: 'unreadable' }
  }
}

function headerMatches(extension: string, head: Buffer): boolean {
  const ascii = (start: number, end: number) => head.length >= end ? head.toString('ascii', start, end) : ''
  switch (extension) {
    case 'png': return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case 'jpg': return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    case 'webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    case 'wav': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
    case 'ogg': return ascii(0, 4) === 'OggS'
    case 'mp4':
    case 'm4a': return ascii(4, 8) === 'ftyp'
    case 'mp3': return ascii(0, 3) === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
    default: return false
  }
}

export interface WorksMetadataTarget {
  /** 只补本机还没有记录的那几件；本机已有的名字、标签、收藏一律不动。 */
  importMissing(userId: number, items: readonly AiAssetMetadataItem[]): Promise<number>
}

export interface WorksImportOptions {
  folder: string
  manifest: ParsedWorksManifest
  outputRoot: string
  userId: number
  metadata: WorksMetadataTarget
  /**
   * Works this account already keeps outside its library folder (a canvas project's own folder): counted
   * as already here and not copied, so importing onto the computer that made them adds no second copy.
   */
  heldElsewhere?: ReadonlySet<string>
  /** 每放进去一件调一次（画布项目导入没做完时按它删掉放进新文件夹的那几件）。 */
  onAdded?: (entry: WorksManifestEntry, filePath: string) => void
  readDiskSpace?: (target: string) => Promise<DiskSpaceReading | null>
  randomBytes?: (size: number) => Buffer
}

export type WorksImportResult =
  | { status: 'done'; added: number; existing: number; failed: number; metadataFailed?: boolean }
  /** 空间不够，一件都没导：neededBytes 是要复制的那几件加起来多大。 */
  | { status: 'no-space'; neededBytes: number; availableBytes: number }

/**
 * Copies the works of an export folder into this account's library, at the
 * same place under the same name, so every conversation and storyboard that
 * names them finds them. Nothing here ever replaces a file: a work this
 * account already has (under any date) is counted as existing and left alone,
 * and each copy lands under a temporary name the stores never match and is
 * then hard-linked to its real name, which fails rather than overwrites if a
 * file appeared meanwhile (as the stores themselves write). The source folder
 * is hostile (I8): every file must be a single-link regular file of exactly the
 * size the manifest says, start like the kind of file its name claims, and is
 * read through the handle that was checked. Files are copied one at a time.
 */
export async function importAccountWorks(options: WorksImportOptions): Promise<WorksImportResult> {
  const { manifest, userId } = options
  const accountRoot = resolveRelocatedPath(path.join(options.outputRoot, `user-${userId}`))
  const local = new Set((await listAccountWorks(options.outputRoot, userId)).map((work) => work.assetId))
  const pending = manifest.files.filter((entry) => !local.has(entry.assetId) && !options.heldElsewhere?.has(entry.assetId))
  let existing = manifest.files.length - pending.length
  const neededBytes = pending.reduce((total, entry) => total + entry.bytes, 0)
  if (pending.length) {
    const reading = await (options.readDiskSpace ?? defaultReadDiskSpace)(accountRoot)
    if (reading && reading.availableBytes < neededBytes + IMPORT_SPARE_BYTES) {
      return { status: 'no-space', neededBytes, availableBytes: reading.availableBytes }
    }
  }
  const present = new Set(manifest.files.filter((entry) => local.has(entry.assetId)).map((entry) => entry.assetId))
  let added = 0
  let failed = 0
  if (pending.length) {
    const folder = resolveRelocatedPath(options.folder)
    assertNoReparseComponents(folder, LABEL)
    ensureSafeDataDirectory(options.outputRoot, LABEL)
    ensureSafeDataDirectory(accountRoot, LABEL)
    const room = new Map<string, number>()
    const randomBytes = options.randomBytes ?? nodeRandomBytes
    for (const [index, entry] of pending.entries()) {
      const directory = path.join(accountRoot, entry.date)
      if (!room.has(entry.date)) {
        try {
          ensureSafeDataDirectory(directory, LABEL)
          room.set(entry.date, MAX_DATE_DIRECTORY_ENTRIES - (await fs.promises.readdir(directory)).length)
        } catch {
          room.set(entry.date, 0)
        }
      }
      const left = room.get(entry.date) ?? 0
      if (left <= 0) {
        failed += 1
        continue
      }
      let source: Awaited<ReturnType<typeof openVerifiedWork>>
      try {
        source = await openVerifiedWork(path.join(folder, entry.date, entry.fileName), maximumBytesOf[entry.mediaType], entry.bytes)
      } catch {
        failed += 1
        continue
      }
      const temporary = path.join(directory, `.xingmang-import-${randomBytes(16).toString('hex')}.tmp`)
      try {
        const head = Buffer.alloc(16)
        const { bytesRead } = await source.handle.read(head, 0, head.length, 0)
        if (!headerMatches(path.extname(entry.fileName).slice(1), head.subarray(0, bytesRead))) {
          failed += 1
          continue
        }
        await copyWork(source, temporary, 0o600, true)
        try {
          const placed = path.join(directory, entry.fileName)
          await fs.promises.link(temporary, placed)
          added += 1
          room.set(entry.date, left - 1)
          options.onAdded?.(entry, placed)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          existing += 1
        }
        present.add(entry.assetId)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOSPC') {
          // 估的时候够、写着写着满了（别的程序也在写）：剩下的一件都不再试。
          failed += pending.length - index
          break
        }
        failed += 1
      } finally {
        await source.handle.close().catch(() => undefined)
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined)
      }
    }
  }
  const records = manifest.metadata.filter((item) => present.has(item.assetId))
  if (!records.length) return { status: 'done', added, existing, failed }
  try {
    await options.metadata.importMissing(userId, records)
    return { status: 'done', added, existing, failed }
  } catch {
    // 作品已经在作品库里了，只是没带上名字、标签；照样算导入了，记日志。
    return { status: 'done', added, existing, failed, metadataFailed: true }
  }
}

// ---- 当前账号 ----

/** 导入作品的结果，带画布项目时连同它们怎么样了（data-transfer-canvas.ts）。 */
export type AccountWorksImportResult =
  | (Extract<WorksImportResult, { status: 'done' }> & { canvasProjects?: CanvasProjectsImportCounts })
  | (Extract<WorksImportResult, { status: 'no-space' }> & { canvasProjects?: CanvasProjectsImportCounts })

export interface AccountWorksTransfer {
  /** 导出前报的数：回收站里的不算。 */
  summarize(userId: number): Promise<AccountWorksSummary>
  /** dataContent 拿实际导出的那几件的数，写聊天记录与设置那份文件。 */
  exportTo(userId: number, options: Omit<WorksExportOptions, 'works' | 'metadata' | 'alongside'>): Promise<WorksExportResult>
  /** canvas：导出文件夹里的「画布项目」，读出来了才有。 */
  importFrom(userId: number, folder: string, manifest: ParsedWorksManifest, canvas?: CanvasProjectsImportSource): Promise<AccountWorksImportResult>
}

interface WorksMetadataSource {
  getAll(userId: number): Promise<Record<string, Omit<AiAssetMetadataItem, 'assetId'>>>
}

/** 作品库页同时列出的一个画布项目文件夹（canvas-project-asset-manager.ts 的 CanvasLibraryFolder）。 */
export interface WorksTransferFolder {
  /** 哪个项目的文件夹：这个项目也跟着搬时，这几件跟项目走（data-transfer-canvas.ts）。 */
  projectId?: string
  /** 这个文件夹里作品的根：下面同样是 user-<编号>/<日期>/… */
  outputRoot: string
  metadata: WorksMetadataSource
  /** 作品库页从这个文件夹列出的那几件。 */
  assetIds: readonly string[]
}

export interface AccountWorksTransferOptions {
  /** 这个站点的作品根（AI 作品文件夹）：下面是 user-<编号>/<日期>/… */
  outputRoot: string
  metadata: WorksMetadataSource & WorksMetadataTarget
  /** 作品库页同时列出的画布项目文件夹（「画布也搬」）。没接上时只搬 AI 作品文件夹里的。 */
  canvasFolders?: (userId: number) => Promise<readonly WorksTransferFolder[]>
  /** 画布项目本身（第三轮复查第 6 条）。没接上时不带项目。 */
  canvasProjects?: CanvasProjectsMigration
  readDiskSpace?: (target: string) => Promise<DiskSpaceReading | null>
}

export function createAccountWorksTransfer(options: AccountWorksTransferOptions): AccountWorksTransfer {
  // 画布项目列表、项目文件夹读不出来，作品库页上也列不出那几件：照旧只搬 AI 作品文件夹里的，不拦导出导入。
  async function canvasFolders(userId: number): Promise<readonly WorksTransferFolder[]> {
    try {
      return await options.canvasFolders?.(userId) ?? []
    } catch {
      return []
    }
  }
  /**
   * viaWorks：作品里从哪个项目文件夹带上了哪几件（作品库里本来就有的不算）。项目跟着搬时这几件不在项目那边
   * 再抄一份，导入时从「作品」放回新项目的文件夹。
   */
  async function exportable(userId: number): Promise<{
    works: LocatedAccountWork[]
    metadata: AiAssetMetadataItem[]
    viaWorks: Map<string, Set<string>>
  }> {
    const records = Object.entries(await options.metadata.getAll(userId)).map(([assetId, record]) => ({ assetId, ...record }))
    const trashed = new Set(records.filter((record) => record.deletedAt).map((record) => record.assetId))
    const works = await listAccountWorks(options.outputRoot, userId, { excluded: trashed })
    const listed = new Set(works.map((work) => work.assetId))
    // 每件作品只带它自己那个位置的名字和标签：同一编号在别处还有一条旧记录，不能跟着进清单。
    const metadata = records.filter((record) => listed.has(record.assetId))
    const viaWorks = new Map<string, Set<string>>()
    for (const folder of await canvasFolders(userId)) {
      if (works.length >= MAX_TRANSFERRED_WORKS) break
      const wanted = new Set(folder.assetIds.filter((assetId) => !listed.has(assetId)))
      if (!wanted.size) continue
      let found: LocatedAccountWork[]
      try {
        found = await listAccountWorks(folder.outputRoot, userId, { included: wanted })
      } catch {
        // 这个项目文件夹现在读不了（U 盘拔了、被别的程序占着）：这几件不带，别的照常。
        continue
      }
      let folderRecords: Record<string, Omit<AiAssetMetadataItem, 'assetId'>> = {}
      try {
        folderRecords = await folder.metadata.getAll(userId)
      } catch {
        // 作品照样带过去，只是没有名字和标签。
      }
      for (const work of found) {
        if (works.length >= MAX_TRANSFERRED_WORKS) break
        if (listed.has(work.assetId)) continue
        listed.add(work.assetId)
        works.push(work)
        if (folder.projectId) {
          const via = viaWorks.get(folder.projectId)
          if (via) via.add(work.assetId)
          else viaWorks.set(folder.projectId, new Set([work.assetId]))
        }
        const record = folderRecords[work.assetId]
        if (record) metadata.push({ ...record, assetId: work.assetId })
      }
    }
    return { works, metadata, viaWorks }
  }
  // 项目列表读不出来时照旧只搬作品，不拦导出。
  async function canvasPlan(userId: number, viaWorks: ReadonlyMap<string, ReadonlySet<string>>): Promise<CanvasProjectsExportPlan | null> {
    if (!options.canvasProjects) return null
    try {
      return await options.canvasProjects.plan(userId, viaWorks)
    } catch {
      return null
    }
  }
  return {
    async summarize(userId) {
      const { works, viaWorks } = await exportable(userId)
      const summary = summarizeAccountWorks(works)
      const plan = await canvasPlan(userId, viaWorks)
      if (!plan || (!plan.projects.length && !plan.unreachable)) return summary
      return {
        ...summary,
        bytes: summary.bytes + plan.bytes,
        canvasProjects: plan.projects.length,
        ...(plan.unreachable ? { canvasProjectsUnreachable: plan.unreachable } : {}),
      }
    },
    async exportTo(userId, exportOptions) {
      const { works, metadata, viaWorks } = await exportable(userId)
      const plan = await canvasPlan(userId, viaWorks)
      const migration = options.canvasProjects
      const alongside: WorksExportAlongside | undefined = plan && plan.projects.length && migration
        ? { bytes: plan.bytes, write: (target) => migration.write(plan, target) }
        : undefined
      return writeWorksExport({ readDiskSpace: options.readDiskSpace, ...exportOptions, works, metadata, ...(alongside ? { alongside } : {}) })
    },
    async importFrom(userId, folder, manifest, canvas) {
      const heldElsewhere = new Set((await canvasFolders(userId)).flatMap((held) => held.assetIds))
      const migration = options.canvasProjects
      if (!migration || !canvas || !canvas.manifest.projects.length) {
        return importAccountWorks({ folder, manifest, outputRoot: options.outputRoot, userId, metadata: options.metadata, heldElsewhere, readDiskSpace: options.readDiskSpace })
      }
      // 项目先导：项目文件夹里的作品放回新项目的文件夹，作品库里不再另放一份。空间按两样加起来先看一次，
      // 不够就一样都不导，免得项目导了一半、作品一件没进。
      const prepared = await migration.prepareImport(userId, canvas, manifest)
      const local = new Set((await listAccountWorks(options.outputRoot, userId)).map((work) => work.assetId))
      const worksBytes = manifest.files
        .filter((entry) => !local.has(entry.assetId) && !heldElsewhere.has(entry.assetId) && !prepared.takes.has(entry.assetId))
        .reduce((total, entry) => total + entry.bytes, 0)
      const neededBytes = worksBytes + prepared.bytes
      if (neededBytes > 0) {
        const reading = await (options.readDiskSpace ?? defaultReadDiskSpace)(resolveRelocatedPath(path.join(options.outputRoot, `user-${userId}`)))
        if (reading && reading.availableBytes < neededBytes + IMPORT_SPARE_BYTES) {
          return { status: 'no-space', neededBytes, availableBytes: reading.availableBytes }
        }
      }
      const projects = await migration.runImport(userId, prepared, { folder, manifest })
      const rest: ParsedWorksManifest = {
        files: manifest.files.filter((entry) => !projects.placed.has(entry.assetId)),
        metadata: manifest.metadata.filter((item) => !projects.placed.has(item.assetId)),
      }
      const works = await importAccountWorks({ folder, manifest: rest, outputRoot: options.outputRoot, userId, metadata: options.metadata, heldElsewhere, readDiskSpace: options.readDiskSpace })
      const counts = projects.counts
      if (works.status === 'no-space') return { ...works, canvasProjects: counts }
      const metadataFailed = works.metadataFailed || projects.metadataFailed
      return {
        status: 'done',
        added: works.added + projects.placed.size,
        existing: works.existing,
        failed: works.failed + projects.failedFiles,
        ...(metadataFailed ? { metadataFailed: true } : {}),
        canvasProjects: counts,
      }
    },
  }
}
