import fs from 'node:fs'
import path from 'node:path'
import { parseTransferredAiAssetMetadataItems, type AiAssetMetadataItem } from './ai-asset-metadata-store'
import type { CanvasTransferFolder } from './canvas-project-asset-manager'
import { claimCanvasDefaultProjectFolder, releaseCanvasDefaultProjectFolderTree } from './canvas-default-project-folder'
import { parseCanvasProjectWorkflow } from './canvas-project-package'
import type { CanvasProjectTransferAdmission, CanvasProjectTransferInput, CanvasProjectTransferRecord } from './canvas-project-store'
import {
  MAX_TRANSFERRED_WORKS,
  WorkSourceRejected,
  copyWork,
  importAccountWorks,
  listAccountWorks,
  openVerifiedWork,
  parseWorksManifestEntry,
  type ExportFolderWriter,
  type LocatedAccountWork,
  type ParsedWorksManifest,
  type WorksManifestEntry,
} from './data-transfer-works'
import type { DiskSpaceReading } from './disk-space'
import { isRecord } from './input-guards'
import { resolveRelocatedPath } from './relocated-folders'
import { assertNoReparseComponents } from './safe-local-data'

// 「迁移到新电脑」里的画布项目本身：节点、连线和项目文件夹里的素材（第三轮复查第 6 条；yoyo 11-22 回的「画布也搬」
// 指的是这个）。只在「导出全部」时带，跟作品放进同一个导出文件夹：
//
//   画布项目/xingmang-canvas-projects.json   清单：每个项目的编号、时间、归档没有，和它文件夹里有哪些文件
//   画布项目/<项目编号>/workflow.json         节点和连线，跟项目自己存的那份一样
//   画布项目/<项目编号>/<日期>/xingmang-…     项目文件夹里的素材，照作品库的布局（参考图、遮罩、截帧也在这里）
//
// 项目生成的作品已经随「作品」导出了（data-transfer-works.ts 的 viaWorks），这里不再抄一份，清单里只记编号
// （fromWorks），导入时从「作品」放回新项目的文件夹。项目在旧电脑上放在哪是客户自己的位置，导出里一个字都不写；
// 到了新电脑，跟新建项目一样放进「文档 › 星芒画布」下面新建的文件夹。编号、时间、归档照原样，同一份导出再导一次
// 不会多出一个项目。没有自己文件夹的老项目（素材在作品库里）照样没有文件夹，素材随「作品」进作品库。
//
// 导出文件夹是客户选的、可能被别人动过（I5、I8）：清单逐项按白名单认，路径只认固定的样子，文件只读单链接的普通
// 文件、大小要对得上，节点和连线照项目自己保存时的规矩再查一遍。

export const CANVAS_PROJECTS_FOLDER_NAME = '画布项目'
export const CANVAS_PROJECTS_MANIFEST_FILE = 'xingmang-canvas-projects.json'
const MANIFEST_FORMAT = 'xingmang-canvas-projects'
const MANIFEST_VERSION = 1
const WORKFLOW_FILE_NAME = 'workflow.json'
// 清单里是文件列表和素材的名字、标签、提示词；一个项目文件夹的元数据分片一共不过 32 MB。
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
// 跟项目自己存的那份上限一样（canvas-project-store.ts 读项目时的 20 MB）。
const MAX_WORKFLOW_BYTES = 20 * 1024 * 1024
/** 一个账号连同归档的最多 500 个项目（canvas-project-store.ts 的 maximumStoredProjects）。 */
export const MAX_TRANSFERRED_CANVAS_PROJECTS = 500
const EXPORTED_FILE_MODE = 0o644
const LABEL = '画布项目'
const PROJECT_ID_PATTERN = /^[a-f0-9-]{36}$/
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

// ---- 跟项目库、素材库接的那一面 ----

export interface CanvasProjectsTransferStore {
  listTransferable(userId: number): Promise<CanvasProjectTransferRecord[]>
  admitTransferred(userId: number, projectId: string, archived: boolean): Promise<CanvasProjectTransferAdmission>
  restoreTransferred(userId: number, input: CanvasProjectTransferInput, workspaceInput?: string): Promise<Exclude<CanvasProjectTransferAdmission, 'ok'> | 'added'>
}

export interface CanvasProjectsTransferAssets {
  transferFolder(userId: number, projectId: string): Promise<CanvasTransferFolder | null>
  transferTarget(workspaceDirectory: string): CanvasTransferFolder
  forgetProject(userId: number, projectId: string): void
}

export interface CanvasProjectsMigrationOptions {
  projects: CanvasProjectsTransferStore
  assets: CanvasProjectsTransferAssets
  /** 新建画布项目默认放的「文档 › 星芒画布」。 */
  projectsDirectory: () => string
  readDiskSpace?: (target: string) => Promise<DiskSpaceReading | null>
}

// ---- 导出 ----

interface PlannedCanvasProject {
  record: CanvasProjectTransferRecord
  workflow: string
  /** 项目自己文件夹里的东西；没有自己文件夹的老项目没有这一项。 */
  folder?: {
    /** 要抄进导出文件夹的那几件。 */
    files: LocatedAccountWork[]
    /** 已经随「作品」导出的那几件，只记编号。 */
    fromWorks: string[]
    metadata: AiAssetMetadataItem[]
  }
}

export interface CanvasProjectsExportPlan {
  projects: PlannedCanvasProject[]
  /** 文件夹现在找不到（U 盘拔了、被挪走了）、导不出去的项目几个。 */
  unreachable: number
  /** 要写进导出文件夹的一共多大：节点和连线，加上要抄的文件。 */
  bytes: number
}

// ---- 导入 ----

export interface ParsedCanvasProject {
  id: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  archivedAt?: string
  /** 旧电脑上就没有自己的文件夹：素材在作品库里，随「作品」导入。 */
  legacy: boolean
  /** 在「画布项目/<项目编号>」里的文件。 */
  files: WorksManifestEntry[]
  /** 在「作品」里的文件，只记编号。 */
  fromWorks: string[]
  metadata: AiAssetMetadataItem[]
}

export interface ParsedCanvasProjectsManifest {
  projects: ParsedCanvasProject[]
}

export interface CanvasProjectsImportSource {
  /** 导出文件夹里的「画布项目」。 */
  folder: string
  manifest: ParsedCanvasProjectsManifest
}

export interface PreparedCanvasProjectsImport {
  source: CanvasProjectsImportSource
  /** 这次要导的项目：本机已有的、放不下的已经去掉了。 */
  projects: ParsedCanvasProject[]
  existing: number
  full: number
  /** 这些项目要放进新文件夹的一共多大。 */
  bytes: number
  /** 这些项目要从「作品」拿走的作品编号。 */
  takes: Set<string>
}

/** added：导进来了；existing：本机已有这个项目；full：本机项目数到了上限；failed：读不出来或没放成。 */
export interface CanvasProjectsImportCounts {
  added: number
  existing: number
  full: number
  failed: number
}

export interface CanvasProjectsImportOutcome {
  counts: CanvasProjectsImportCounts
  /** 从「作品」放进了新项目文件夹的作品编号：作品库里不再另放一份，算作导进来的作品。 */
  placed: Set<string>
  /** 项目里读不了、没放进去的文件几件。 */
  failedFiles: number
  metadataFailed: boolean
}

export interface CanvasProjectsMigration {
  plan(userId: number, viaWorks: ReadonlyMap<string, ReadonlySet<string>>): Promise<CanvasProjectsExportPlan>
  write(plan: CanvasProjectsExportPlan, target: ExportFolderWriter): Promise<{ canvasProjects: number; bytes: number }>
  prepareImport(userId: number, source: CanvasProjectsImportSource, works: ParsedWorksManifest): Promise<PreparedCanvasProjectsImport>
  runImport(userId: number, prepared: PreparedCanvasProjectsImport, works: { folder: string; manifest: ParsedWorksManifest }): Promise<CanvasProjectsImportOutcome>
}

/**
 * The manifest of the canvas projects folder. Every project names its own
 * folder by its id, so no entry can point anywhere else; files follow the
 * works layout and size ceilings (parseWorksManifestEntry); the works it takes
 * from the works folder are bare ids; metadata records pass the store's own
 * field checks. Anything off rejects the manifest, as for the works.
 */
export function parseCanvasProjectsManifest(raw: string): ParsedCanvasProjectsManifest {
  const invalid = new Error(`${LABEL}清单无效`)
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw invalid }
  if (!isRecord(value) || value.format !== MANIFEST_FORMAT || value.version !== MANIFEST_VERSION) throw invalid
  if (!Array.isArray(value.projects) || value.projects.length > MAX_TRANSFERRED_CANVAS_PROJECTS) throw invalid
  const projectIds = new Set<string>()
  const time = (field: unknown): string => {
    if (typeof field !== 'string' || !TIME_PATTERN.test(field) || !Number.isFinite(Date.parse(field))) throw invalid
    return field
  }
  const projects = value.projects.map((entry): ParsedCanvasProject => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !PROJECT_ID_PATTERN.test(entry.id) || projectIds.has(entry.id)) throw invalid
    projectIds.add(entry.id)
    if (entry.legacy !== undefined && entry.legacy !== true) throw invalid
    if (!Array.isArray(entry.files) || entry.files.length > MAX_TRANSFERRED_WORKS) throw invalid
    if (!Array.isArray(entry.fromWorks) || entry.fromWorks.length > MAX_TRANSFERRED_WORKS) throw invalid
    const seen = new Set<string>()
    const files = entry.files.map((file): WorksManifestEntry => {
      const parsed = parseWorksManifestEntry(file)
      if (!parsed || seen.has(parsed.assetId)) throw invalid
      seen.add(parsed.assetId)
      return parsed
    })
    const fromWorks = entry.fromWorks.map((assetId): string => {
      if (typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId) || seen.has(assetId)) throw invalid
      seen.add(assetId)
      return assetId
    })
    const legacy = entry.legacy === true
    if (legacy && (files.length || fromWorks.length)) throw invalid
    let metadata: AiAssetMetadataItem[]
    try {
      metadata = parseTransferredAiAssetMetadataItems(entry.metadata ?? [])
    } catch {
      throw invalid
    }
    return {
      id: entry.id,
      createdAt: time(entry.createdAt),
      updatedAt: time(entry.updatedAt),
      lastOpenedAt: time(entry.lastOpenedAt),
      ...(entry.archivedAt === undefined ? {} : { archivedAt: time(entry.archivedAt) }),
      legacy,
      files,
      fromWorks,
      metadata: metadata.filter((item) => seen.has(item.assetId)),
    }
  })
  return { projects }
}

export type CanvasProjectsFolderInspection =
  | { state: 'ready'; folder: string; manifest: ParsedCanvasProjectsManifest }
  | { state: 'missing' }
  | { state: 'unreadable' }

/**
 * Finds the canvas projects folder beside the chosen file. Its name is fixed,
 * never read from the file, so the file cannot point anywhere else on the
 * computer (same as the works folder).
 */
export async function inspectCanvasProjectsFolder(dataFilePath: string): Promise<CanvasProjectsFolderInspection> {
  const folder = resolveRelocatedPath(path.join(path.dirname(dataFilePath), CANVAS_PROJECTS_FOLDER_NAME))
  try {
    const stats = await fs.promises.lstat(folder)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return { state: 'unreadable' }
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' }
  }
  try {
    assertNoReparseComponents(folder, LABEL)
    const source = await openVerifiedWork(path.join(folder, CANVAS_PROJECTS_MANIFEST_FILE), MAX_MANIFEST_BYTES)
    try {
      const raw = await source.handle.readFile('utf8')
      return { state: 'ready', folder, manifest: parseCanvasProjectsManifest(raw.replace(/^﻿/, '')) }
    } finally {
      await source.handle.close().catch(() => undefined)
    }
  } catch {
    return { state: 'unreadable' }
  }
}

/**
 * A project's nodes and links from the export, read through a checked handle
 * and validated as the store validates a save, before any of its files is
 * copied: a project that would be refused costs nothing.
 */
async function readWorkflow(folder: string, projectId: string): Promise<{ content: string; name: string }> {
  const directory = path.join(folder, projectId)
  assertNoReparseComponents(directory, LABEL)
  const source = await openVerifiedWork(path.join(directory, WORKFLOW_FILE_NAME), MAX_WORKFLOW_BYTES)
  let content: string
  try {
    content = (await source.handle.readFile('utf8')).replace(/^﻿/, '')
  } finally {
    await source.handle.close().catch(() => undefined)
  }
  const parsed = parseCanvasProjectWorkflow(content)
  return { content, name: String(parsed.workflow.name) }
}

// 新版本存的时间都是 toISOString() 的样子；很早的项目文件里可能是别的写法，导出时换成同一种，
// 免得一个项目的旧时间让整份清单在新电脑上读不进来。认不出来的记成导出这一刻。
function exportedTime(value: string, now: string): string {
  if (TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value))) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : now
}

// Files this import put into a project's new folder, removed when the project
// could not be registered after all. Only the exact files it linked in; the
// empty folders are released afterwards, nothing else in there is touched.
async function removePlacedFiles(files: readonly string[]): Promise<void> {
  for (const file of files) await fs.promises.rm(file, { force: true }).catch(() => undefined)
}

const noMetadataYet = { importMissing: async () => 0 }

export function createCanvasProjectsMigration(options: CanvasProjectsMigrationOptions): CanvasProjectsMigration {
  async function planProject(userId: number, record: CanvasProjectTransferRecord, viaWorks: ReadonlySet<string> | undefined): Promise<PlannedCanvasProject | null> {
    const workflow = JSON.stringify(record.workflow)
    if (record.workspaceStatus === 'legacy') return { record, workflow }
    let folder: CanvasTransferFolder | null
    try {
      folder = await options.assets.transferFolder(userId, record.id)
    } catch {
      return null
    }
    // A folder record the asset manager does not know as the project's own: its media are in the account library.
    if (!folder) return { record: { ...record, workspaceStatus: 'legacy' }, workflow }
    let records: Record<string, Omit<AiAssetMetadataItem, 'assetId'>> = {}
    try {
      records = await folder.metadata.getAll(userId)
    } catch {
      // 素材照样带过去，只是没有名字和标签。
    }
    const trashed = new Set(Object.entries(records).filter(([, item]) => item.deletedAt).map(([assetId]) => assetId))
    let listed: LocatedAccountWork[]
    try {
      listed = await listAccountWorks(folder.outputRoot, userId, { excluded: trashed })
    } catch {
      return null
    }
    const files = listed.filter((work) => !viaWorks?.has(work.assetId))
    const fromWorks = listed.filter((work) => viaWorks?.has(work.assetId)).map((work) => work.assetId)
    const metadata = listed.flatMap((work) => {
      const item = records[work.assetId]
      return item ? [{ ...item, assetId: work.assetId }] : []
    })
    return { record, workflow, folder: { files, fromWorks, metadata } }
  }

  async function plan(userId: number, viaWorks: ReadonlyMap<string, ReadonlySet<string>>): Promise<CanvasProjectsExportPlan> {
    const records = (await options.projects.listTransferable(userId)).slice(0, MAX_TRANSFERRED_CANVAS_PROJECTS)
    const projects: PlannedCanvasProject[] = []
    let unreachable = 0
    let bytes = 0
    for (const record of records) {
      const planned = record.workspaceStatus === 'missing' ? null : await planProject(userId, record, viaWorks.get(record.id))
      if (!planned) {
        unreachable += 1
        continue
      }
      projects.push(planned)
      bytes += Buffer.byteLength(planned.workflow, 'utf8') + (planned.folder?.files.reduce((total, work) => total + work.bytes, 0) ?? 0)
    }
    return { projects, unreachable, bytes }
  }

  /**
   * Writes the canvas projects folder into an export folder that is being
   * written: each project's nodes and links, the files of its folder, then the
   * manifest. A file that cannot be read from this computer is left out, as a
   * work is; anything that goes wrong writing to the chosen place throws, and
   * the works export removes everything the target was told about.
   */
  async function write(planned: CanvasProjectsExportPlan, target: ExportFolderWriter): Promise<{ canvasProjects: number; bytes: number }> {
    const root = path.join(target.folderPath, CANVAS_PROJECTS_FOLDER_NAME)
    await fs.promises.mkdir(root)
    target.directory(root)
    const entries: Record<string, unknown>[] = []
    const now = new Date().toISOString()
    let bytes = 0
    for (const project of planned.projects) {
      const { record } = project
      const directory = path.join(root, record.id)
      await fs.promises.mkdir(directory)
      target.directory(directory)
      const workflowPath = path.join(directory, WORKFLOW_FILE_NAME)
      target.file(workflowPath)
      await fs.promises.writeFile(workflowPath, project.workflow, { flag: 'wx', mode: EXPORTED_FILE_MODE })
      bytes += Buffer.byteLength(project.workflow, 'utf8')
      const files: Array<{ path: string; bytes: number; assetId: string }> = []
      const dates = new Set<string>()
      for (const work of project.folder?.files ?? []) {
        const [date, name] = work.relativePath.split('/')
        let source: Awaited<ReturnType<typeof openVerifiedWork>>
        try {
          source = await openVerifiedWork(work.filePath, work.bytes)
        } catch {
          continue
        }
        try {
          if (!dates.has(date)) {
            await fs.promises.mkdir(path.join(directory, date))
            target.directory(path.join(directory, date))
            dates.add(date)
          }
          const destination = path.join(directory, date, name)
          target.file(destination)
          try {
            await copyWork(source, destination, EXPORTED_FILE_MODE, false)
          } catch (error) {
            if (!(error instanceof WorkSourceRejected)) throw error
            await fs.promises.rm(destination, { force: true })
            continue
          }
          files.push({ path: work.relativePath, bytes: Number(source.before.size), assetId: work.assetId })
          bytes += Number(source.before.size)
        } finally {
          await source.handle.close().catch(() => undefined)
        }
      }
      // Only works the works folder really holds: one that could not be read there is not here either.
      const fromWorks = (project.folder?.fromWorks ?? []).filter((assetId) => target.exported.has(assetId))
      const present = new Set([...files.map((file) => file.assetId), ...fromWorks])
      entries.push({
        id: record.id,
        createdAt: exportedTime(record.createdAt, now),
        updatedAt: exportedTime(record.updatedAt, now),
        lastOpenedAt: exportedTime(record.lastOpenedAt, now),
        ...(record.archivedAt ? { archivedAt: exportedTime(record.archivedAt, now) } : {}),
        ...(project.folder ? {} : { legacy: true }),
        files: files.map((file) => ({ path: file.path, bytes: file.bytes })),
        fromWorks,
        metadata: (project.folder?.metadata ?? []).filter((item) => present.has(item.assetId) && !item.deletedAt),
      })
    }
    const manifest = JSON.stringify({ format: MANIFEST_FORMAT, version: MANIFEST_VERSION, projects: entries })
    if (Buffer.byteLength(manifest, 'utf8') > MAX_MANIFEST_BYTES) throw new Error(`${LABEL}清单超过 64 MB，无法导出`)
    const manifestPath = path.join(root, CANVAS_PROJECTS_MANIFEST_FILE)
    target.file(manifestPath)
    await fs.promises.writeFile(manifestPath, manifest, { flag: 'wx', mode: EXPORTED_FILE_MODE })
    return { canvasProjects: entries.length, bytes }
  }

  async function prepareImport(userId: number, source: CanvasProjectsImportSource, works: ParsedWorksManifest): Promise<PreparedCanvasProjectsImport> {
    const worksById = new Map(works.files.map((entry) => [entry.assetId, entry]))
    const projects: ParsedCanvasProject[] = []
    const takes = new Set<string>()
    let existing = 0
    let full = 0
    let bytes = 0
    for (const project of source.manifest.projects) {
      const admitted = await options.projects.admitTransferred(userId, project.id, project.archivedAt !== undefined)
      if (admitted === 'existing') {
        existing += 1
        continue
      }
      // Adding the others will not make room for it.
      if (admitted === 'full') {
        full += 1
        continue
      }
      projects.push(project)
      bytes += project.files.reduce((total, entry) => total + entry.bytes, 0)
      for (const assetId of project.fromWorks) {
        const entry = worksById.get(assetId)
        if (!entry) continue
        takes.add(assetId)
        bytes += entry.bytes
      }
    }
    return { source, projects, existing, full, bytes, takes }
  }

  /**
   * Imports the prepared projects one at a time. A project with a folder gets
   * a new folder under 「文档 › 星芒画布」 (claimed fresh, never an existing
   * one), its files are copied in by the same checked copy the works import
   * uses, and only then is the project registered; when registering fails the
   * files it put there are removed and the empty folders released, so no
   * half-made project is left in the list. Metadata goes in last.
   */
  async function runImport(
    userId: number,
    prepared: PreparedCanvasProjectsImport,
    works: { folder: string; manifest: ParsedWorksManifest },
  ): Promise<CanvasProjectsImportOutcome> {
    const worksById = new Map(works.manifest.files.map((entry) => [entry.assetId, entry]))
    const counts: CanvasProjectsImportCounts = { added: 0, existing: prepared.existing, full: prepared.full, failed: 0 }
    const placed = new Set<string>()
    let failedFiles = 0
    let metadataFailed = false
    function count(outcome: Exclude<CanvasProjectTransferAdmission, 'ok'> | 'added'): void {
      counts[outcome] += 1
    }
    for (const project of prepared.projects) {
      let workflow: { content: string; name: string }
      try {
        const admitted = await options.projects.admitTransferred(userId, project.id, project.archivedAt !== undefined)
        if (admitted !== 'ok') {
          count(admitted)
          continue
        }
        workflow = await readWorkflow(prepared.source.folder, project.id)
      } catch {
        counts.failed += 1
        continue
      }
      const input: CanvasProjectTransferInput = {
        id: project.id,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        lastOpenedAt: project.lastOpenedAt,
        ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
        workflow: workflow.content,
      }
      if (project.legacy) {
        try {
          count(await options.projects.restoreTransferred(userId, input))
        } catch {
          counts.failed += 1
        }
        continue
      }
      let directory: string
      try {
        directory = claimCanvasDefaultProjectFolder(options.projectsDirectory(), workflow.name)
      } catch {
        counts.failed += 1
        continue
      }
      const placedFiles: string[] = []
      const present = new Set<string>()
      const fromWorks = new Set<string>()
      try {
        const target = options.assets.transferTarget(directory)
        const copy = (folder: string, files: WorksManifestEntry[], fromTheWorks: boolean) => importAccountWorks({
          folder,
          manifest: { files, metadata: [] },
          outputRoot: target.outputRoot,
          userId,
          metadata: noMetadataYet,
          readDiskSpace: options.readDiskSpace,
          onAdded: (entry, filePath) => {
            placedFiles.push(filePath)
            present.add(entry.assetId)
            if (fromTheWorks) fromWorks.add(entry.assetId)
          },
        })
        const shared = project.fromWorks.flatMap((assetId) => worksById.get(assetId) ?? [])
        const own = await copy(path.join(prepared.source.folder, project.id), project.files, false)
        const taken = await copy(works.folder, shared, true)
        if (own.status === 'no-space' || taken.status === 'no-space') throw new Error('磁盘空间不足')
        const outcome = await options.projects.restoreTransferred(userId, input, directory)
        if (outcome !== 'added') {
          await removePlacedFiles(placedFiles)
          releaseCanvasDefaultProjectFolderTree(directory)
          count(outcome)
          continue
        }
        failedFiles += own.failed + taken.failed + (project.fromWorks.length - shared.length)
        for (const assetId of fromWorks) placed.add(assetId)
        options.assets.forgetProject(userId, project.id)
        const records = project.metadata.filter((item) => present.has(item.assetId))
        if (records.length) {
          try {
            await target.metadata.importMissing(userId, records)
          } catch {
            // 项目和素材都在，只是素材的名字、标签没带上；照样算导入了，记日志。
            metadataFailed = true
          }
        }
        counts.added += 1
      } catch {
        await removePlacedFiles(placedFiles)
        releaseCanvasDefaultProjectFolderTree(directory)
        counts.failed += 1
      }
    }
    return { counts, placed, failedFiles, metadataFailed }
  }

  return { plan, write, prepareImport, runImport }
}
