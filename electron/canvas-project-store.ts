import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mapWithConcurrency } from './async-map'
import { ensureSafeDataDirectory, writeAtomicSafeUtf8File } from './safe-local-data'
import { copyBoundedFileExclusive, readBoundedUtf8File } from './bounded-file'
import { parseCanvasProjectWorkflow } from './canvas-project-package'
import { sameLocalPathIdentity } from './path-identity'
import { resolveRelocatedPath } from './relocated-folders'

// 归档的项目不占这 100 个（画布完善第 14 条）：不用的项目归档以后就能再建新的。连同归档的总数另有上限，
// 项目列表、找素材被哪些项目用着都要把它们读一遍，不能无限多。
const maximumActiveProjects = 100
const maximumStoredProjects = 500
const maximumCopiedEntries = 100_000
const maximumCopiedBytes = 100 * 1024 * 1024 * 1024
const maximumReferenceValues = 250_000
const projectIdPattern = /^[a-f0-9-]{36}$/
const accountDirectoryPattern = /^user-[1-9]\d*$/
const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

export type CanvasProjectWorkspaceStatus = 'ready' | 'missing' | 'legacy'

export interface CanvasProjectPreviewAsset {
  kind: 'image' | 'video' | 'audio'
  assetId: string
  localUrl: string
}

export interface CanvasStoredProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  nodeCount: number
  assetCount: number
  workspaceName?: string
  workspaceConfigured: boolean
  workspaceStatus: CanvasProjectWorkspaceStatus
  previewAsset?: CanvasProjectPreviewAsset
  archivedAt?: string
}

interface StoredCanvasProject {
  id: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  archivedAt?: string
  workspaceDirectory?: string
  workflow: Record<string, unknown>
}

export interface CanvasProjectAssetReference {
  projectId: string
  projectName: string
  nodeIds: string[]
  archived: boolean
}

/**
 * One project as 「迁移到新电脑」 takes it (data-transfer-canvas.ts): its record and workflow, never the
 * folder it sits in on this computer, which is the customer's own place and means nothing on another one.
 */
export interface CanvasProjectTransferRecord {
  id: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  archivedAt?: string
  workflow: Record<string, unknown>
  /** ready: its own folder, reachable now. missing: its own folder, not reachable. legacy: no folder, its media sit in the account library. */
  workspaceStatus: CanvasProjectWorkspaceStatus
}

/** What the migration hands back to register on the new computer: the workflow as text, checked like save(). */
export interface CanvasProjectTransferInput {
  id: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  archivedAt?: string
  workflow: string
}

/** existing: this account already has a project with this id. full: no room for one more, archived or not as it was. */
export type CanvasProjectTransferAdmission = 'ok' | 'existing' | 'full'

function safeUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('画布项目账号标识无效')
}

function safeProjectId(projectId: string): void {
  if (!projectIdPattern.test(projectId)) throw new Error('画布项目标识无效')
}

function normalizedProjectName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('项目名称无效')
  return name
}

/**
 * A project name as the main window shows it (融合第 1 步、第 5 步): one line of text, no control characters,
 * capped. The canvas page wrote the name; saving already refuses control characters and long names
 * (normalizedProjectName), this is the second look before it leaves the canvas side.
 */
export function displayCanvasProjectName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128).trim() || '未命名项目'
}

/**
 * What the main window's library needs to know about one unarchived project (融合第 5 步): where its media
 * live and which assets its nodes hold. Main process only, never sent to the canvas page.
 */
export interface CanvasProjectLibrarySource {
  id: string
  name: string
  /** ready: its own folder, reachable. missing: its own folder, not reachable now. legacy: no folder, its media sit in the account library. */
  workspaceStatus: CanvasProjectWorkspaceStatus
  /** The assets its nodes currently hold as results. */
  assetIds: string[]
}

function hasRoomForProject(existing: readonly CanvasStoredProjectSummary[], archived: boolean): boolean {
  if (existing.length >= maximumStoredProjects) return false
  return archived || existing.filter((project) => !project.archivedAt).length < maximumActiveProjects
}

function admission(existing: readonly CanvasStoredProjectSummary[], projectId: string, archived: boolean): CanvasProjectTransferAdmission {
  if (existing.some((project) => project.id === projectId)) return 'existing'
  return hasRoomForProject(existing, archived) ? 'ok' : 'full'
}

const transferTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function transferTime(value: string): string {
  if (!transferTimePattern.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('画布项目时间格式错误')
  return value
}

function assertRoomForNewProject(existing: readonly CanvasStoredProjectSummary[]): void {
  if (existing.length >= maximumStoredProjects) throw new Error(`画布项目（含已归档）最多 ${maximumStoredProjects} 个，请先在「已归档」中删除部分项目`)
  if (existing.filter((project) => !project.archivedAt).length >= maximumActiveProjects) {
    throw new Error(`画布项目最多 ${maximumActiveProjects} 个（不含已归档），请先归档部分不再使用的项目`)
  }
}

function normalizedWorkspaceDirectory(value: string, requireExisting: boolean): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > 32_768) {
    throw new Error('画布项目工作文件夹无效')
  }
  const directory = path.resolve(value)
  if (requireExisting) {
    // 选在搬过家的「文档」「桌面」里（或就选它本身）时按实际位置核对，别的链接照旧拒绝（relocated-folders.ts）。
    const checkedDirectory = resolveRelocatedPath(directory)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(checkedDirectory)
    } catch {
      throw new Error('画布项目工作文件夹不存在')
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('画布项目工作文件夹必须是普通目录')
    const realPath = fs.realpathSync(checkedDirectory)
    if (!sameLocalPathIdentity(realPath, checkedDirectory)) throw new Error('画布项目工作文件夹不能经过符号链接或目录联接')
  }
  return directory
}

function workspaceName(directory: string | undefined): string | undefined {
  return directory ? path.basename(directory) || path.parse(directory).root : undefined
}

function workspaceStatus(directory: string | undefined): CanvasProjectWorkspaceStatus {
  if (!directory) return 'legacy'
  try {
    normalizedWorkspaceDirectory(directory, true)
    return 'ready'
  } catch {
    return 'missing'
  }
}

function workflowAssetProjection(workflow: Record<string, unknown>): {
  assetIds: Set<string>
  previewAsset?: CanvasProjectPreviewAsset
} {
  const assetIds = new Set<string>()
  let previewAsset: CanvasProjectPreviewAsset | undefined
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue
    const data = (node as { data?: unknown }).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const result = (data as { result?: unknown }).result
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue
    const asset = result as { kind?: unknown; assetId?: unknown }
    if (!['image', 'video', 'audio'].includes(String(asset.kind)) || typeof asset.assetId !== 'string' || !assetIdPattern.test(asset.assetId)) continue
    assetIds.add(asset.assetId)
    previewAsset ??= {
      kind: asset.kind as CanvasProjectPreviewAsset['kind'],
      assetId: asset.assetId,
      localUrl: `xingmang-asset://${asset.kind}/${asset.assetId}`,
    }
  }
  return { assetIds, ...(previewAsset ? { previewAsset } : {}) }
}

function containsExactAssetId(value: unknown, assetId: string, budget: { remaining: number }): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    budget.remaining -= 1
    if (budget.remaining < 0) throw new Error('画布项目资产引用数据超过扫描上限')
    const current = pending.pop()
    if (typeof current === 'string') {
      if (current === assetId) return true
      continue
    }
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    pending.push(...Object.values(current as Record<string, unknown>))
  }
  return false
}

export function findCanvasWorkflowAssetReferenceNodeIds(workflow: Record<string, unknown>, assetId: string): string[] {
  if (!assetIdPattern.test(assetId)) throw new Error('画布资产标识格式错误')
  const budget = { remaining: maximumReferenceValues }
  return (Array.isArray(workflow.nodes) ? workflow.nodes : []).flatMap((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return []
    const record = node as { id?: unknown; data?: unknown }
    if (typeof record.id !== 'string' || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return []
    return containsExactAssetId(record.data, assetId, budget) ? [record.id] : []
  }).slice(0, 5_000)
}

async function copyProjectAssets(sourceWorkspace: string, targetWorkspace: string): Promise<void> {
  const targetEntries = await fs.promises.readdir(targetWorkspace)
  if (targetEntries.length > 0) throw new Error('复制项目的目标工作文件夹必须为空')
  const sourceRoot = path.join(sourceWorkspace, 'assets')
  const targetRoot = path.join(targetWorkspace, 'assets')
  let sourceStat: fs.Stats
  try {
    sourceStat = await fs.promises.lstat(sourceRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ensureSafeDataDirectory(targetRoot, '画布项目素材')
      return
    }
    throw new Error('无法读取原项目素材目录')
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('原项目素材目录不安全')
  ensureSafeDataDirectory(targetRoot, '画布项目素材')
  const queue = [{ source: sourceRoot, target: targetRoot }]
  let entryCount = 0
  let byteCount = 0
  try {
    while (queue.length > 0) {
      const current = queue.shift() as { source: string; target: string }
      const currentStat = await fs.promises.lstat(current.source)
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error('原项目素材目录不安全')
      const entries = await fs.promises.readdir(current.source, { withFileTypes: true })
      for (const entry of entries) {
        entryCount += 1
        if (entryCount > maximumCopiedEntries) throw new Error('原项目素材条目过多，无法安全复制')
        if (entry.isSymbolicLink()) throw new Error('原项目素材包含符号链接，无法安全复制')
        const source = path.join(current.source, entry.name)
        const target = path.join(current.target, entry.name)
        if (entry.isDirectory()) {
          await fs.promises.mkdir(target, { mode: 0o700 })
          queue.push({ source, target })
          continue
        }
        if (!entry.isFile()) throw new Error('原项目素材包含不支持的文件类型')
        const remainingBytes = maximumCopiedBytes - byteCount
        if (remainingBytes <= 0) throw new Error('原项目素材总大小超过复制上限')
        byteCount += await copyBoundedFileExclusive(source, target, remainingBytes, '原项目素材文件')
      }
    }
  } catch (error) {
    await fs.promises.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * The folder inside each project's work folder where its media go, for every
 * project of every account under one realm's canvas-projects directory: the
 * settings page counts it as AI works (A08). Both realms' media sit below it
 * (canvas-project-asset-manager.ts puts api-account's in assets/realms/api-account),
 * and the rest of the work folder may be the user's own files, so only this
 * folder is counted.
 *
 * Read-only, and without the existence checks list() makes: a folder that is
 * gone or on an unplugged drive is still returned and measures as nothing. A
 * project file that cannot be read is left out, as list() leaves it out.
 */
export async function listCanvasProjectAssetDirectories(rootDirectory: string): Promise<string[]> {
  const root = path.resolve(rootDirectory)
  let accounts: string[]
  try {
    accounts = (await fs.promises.readdir(root)).filter((name) => accountDirectoryPattern.test(name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const directories: string[] = []
  for (const account of accounts) {
    let names: string[]
    try {
      names = await fs.promises.readdir(path.join(root, account))
    } catch {
      continue
    }
    const files = names
      .filter((name) => name.endsWith('.json') && projectIdPattern.test(path.basename(name, '.json')))
      .slice(0, maximumStoredProjects)
    const found = await mapWithConcurrency(files, 4, async (name) => {
      try {
        const raw = JSON.parse(await readBoundedUtf8File(path.join(root, account, name), 20 * 1024 * 1024, '画布项目')) as { workspaceDirectory?: unknown } | null
        if (typeof raw?.workspaceDirectory !== 'string') return null
        return path.join(normalizedWorkspaceDirectory(raw.workspaceDirectory, false), 'assets')
      } catch {
        return null
      }
    })
    for (const directory of found) if (directory) directories.push(directory)
  }
  return directories
}

export class CanvasProjectStore {
  private readonly rootDirectory: string
  private readonly queues = new Map<number, Promise<void>>()

  constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory)
  }

  private accountRoot(userId: number): string {
    safeUserId(userId)
    return path.join(this.rootDirectory, 'user-' + userId)
  }

  private projectPath(userId: number, projectId: string): string {
    safeProjectId(projectId)
    return path.join(this.accountRoot(userId), projectId + '.json')
  }

  private async readProject(userId: number, projectId: string): Promise<StoredCanvasProject> {
    const raw = JSON.parse(await readBoundedUtf8File(this.projectPath(userId, projectId), 20 * 1024 * 1024, '画布项目')) as Record<string, unknown>
    const parsed = parseCanvasProjectWorkflow(JSON.stringify(raw.workflow))
    const storedId = String(raw.id)
    if (storedId !== projectId) throw new Error('画布项目标识不匹配')
    const workspaceDirectory = raw.workspaceDirectory === undefined
      ? undefined
      : normalizedWorkspaceDirectory(String(raw.workspaceDirectory), false)
    return {
      id: storedId,
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt),
      lastOpenedAt: typeof raw.lastOpenedAt === 'string' ? raw.lastOpenedAt : String(raw.updatedAt),
      ...(typeof raw.archivedAt === 'string' ? { archivedAt: raw.archivedAt } : {}),
      ...(workspaceDirectory ? { workspaceDirectory } : {}),
      workflow: parsed.workflow,
    }
  }

  private summary(project: StoredCanvasProject): CanvasStoredProjectSummary {
    const assets = workflowAssetProjection(project.workflow)
    return {
      id: project.id,
      name: String(project.workflow.name),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
      nodeCount: (project.workflow.nodes as unknown[]).length,
      assetCount: assets.assetIds.size,
      ...(project.workspaceDirectory ? { workspaceName: workspaceName(project.workspaceDirectory) } : {}),
      workspaceConfigured: Boolean(project.workspaceDirectory),
      workspaceStatus: workspaceStatus(project.workspaceDirectory),
      ...(assets.previewAsset ? { previewAsset: assets.previewAsset } : {}),
      ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
    }
  }

  /** Every readable project of the account, each turned into what the caller lists; an unreadable one is skipped. */
  private async readEach<T>(userId: number, project: (stored: StoredCanvasProject) => T): Promise<T[]> {
    const root = this.accountRoot(userId)
    let names: string[]
    try {
      names = await fs.promises.readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('无法读取画布项目列表')
    }
    const projects = await Promise.all(names
      .filter((name) => name.endsWith('.json') && projectIdPattern.test(path.basename(name, '.json')))
      .slice(0, maximumStoredProjects)
      .map(async (name) => {
        try {
          return { listed: project(await this.readProject(userId, path.basename(name, '.json'))) }
        } catch { return null }
      }))
    return projects.flatMap((entry) => entry ? [entry.listed] : [])
  }

  async list(userId: number): Promise<CanvasStoredProjectSummary[]> {
    return (await this.readEach(userId, (stored) => this.summary(stored)))
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt) || right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * The unarchived projects as the main window's library reads them (融合第 5 步), most recently opened
   * first. Archived projects are left out, as on the project centre's first page and in the main window's list.
   */
  async listLibrarySources(userId: number): Promise<CanvasProjectLibrarySource[]> {
    return (await this.readEach(userId, (stored) => ({
      archived: Boolean(stored.archivedAt),
      lastOpenedAt: stored.lastOpenedAt,
      updatedAt: stored.updatedAt,
      source: {
        id: stored.id,
        name: displayCanvasProjectName(String(stored.workflow.name)),
        workspaceStatus: workspaceStatus(stored.workspaceDirectory),
        assetIds: [...workflowAssetProjection(stored.workflow).assetIds],
      },
    })))
      .filter((entry) => !entry.archived)
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt) || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, maximumActiveProjects)
      .map((entry) => entry.source)
  }

  /**
   * Every readable project of the account, archived ones too, for 「迁移到新电脑」. An unreadable one is
   * left out, as list() leaves it out.
   */
  async listTransferable(userId: number): Promise<CanvasProjectTransferRecord[]> {
    return this.readEach(userId, (stored) => ({
      id: stored.id,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lastOpenedAt: stored.lastOpenedAt,
      ...(stored.archivedAt ? { archivedAt: stored.archivedAt } : {}),
      workflow: stored.workflow,
      workspaceStatus: workspaceStatus(stored.workspaceDirectory),
    }))
  }

  /**
   * Whether a migrated project could be registered now. Asked before its files are copied, so a project that
   * is already here or has no room is never copied at all; restoreTransferred() asks again.
   */
  async admitTransferred(userId: number, projectId: string, archived: boolean): Promise<CanvasProjectTransferAdmission> {
    safeProjectId(projectId)
    if (await this.projectFileExists(userId, projectId)) return 'existing'
    return admission(await this.list(userId), projectId, archived)
  }

  /**
   * Registers a project 「迁移到新电脑」 brought, keeping its id, times and archived state, so importing the
   * same export twice adds nothing. The workflow goes through the same validator as save(). A project that
   * had a folder of its own gets the new, empty folder the import claimed and filled, checked like create();
   * one that had none stays without, its media in the account library as before. A project file already
   * under this id, readable or not, is never replaced.
   */
  async restoreTransferred(
    userId: number,
    input: CanvasProjectTransferInput,
    workspaceInput?: string,
  ): Promise<Exclude<CanvasProjectTransferAdmission, 'ok'> | 'added'> {
    return this.enqueue(userId, async () => {
      safeProjectId(input.id)
      const parsed = parseCanvasProjectWorkflow(input.workflow)
      const workflow = { ...parsed.workflow, name: displayCanvasProjectName(String(parsed.workflow.name)) }
      const createdAt = transferTime(input.createdAt)
      const updatedAt = transferTime(input.updatedAt)
      const lastOpenedAt = transferTime(input.lastOpenedAt)
      const archivedAt = input.archivedAt === undefined ? undefined : transferTime(input.archivedAt)
      if (await this.projectFileExists(userId, input.id)) return 'existing'
      const existing = await this.list(userId)
      const admitted = admission(existing, input.id, archivedAt !== undefined)
      if (admitted !== 'ok') return admitted
      let workspaceDirectory: string | undefined
      if (workspaceInput !== undefined) {
        workspaceDirectory = normalizedWorkspaceDirectory(workspaceInput, true)
        for (const project of existing) {
          const bound = await this.getWorkspaceDirectory(userId, project.id)
          if (bound && sameLocalPathIdentity(bound, workspaceDirectory)) {
            throw new Error(`该工作文件夹已绑定项目「${project.name}」，请为新项目选择单独的文件夹`)
          }
        }
        ensureSafeDataDirectory(path.join(workspaceDirectory, 'assets'), '画布项目素材')
      }
      await this.write(userId, {
        id: input.id,
        createdAt,
        updatedAt,
        lastOpenedAt,
        ...(archivedAt ? { archivedAt } : {}),
        ...(workspaceDirectory ? { workspaceDirectory } : {}),
        workflow,
      })
      return 'added'
    })
  }

  private async projectFileExists(userId: number, projectId: string): Promise<boolean> {
    try {
      await fs.promises.lstat(this.projectPath(userId, projectId))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async create(userId: number, nameInput: string, workspaceInput: string): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    return this.enqueue(userId, async () => {
      const name = normalizedProjectName(nameInput)
      assertRoomForNewProject(await this.list(userId))
      const workspaceDirectory = normalizedWorkspaceDirectory(workspaceInput, true)
      const existing = await this.list(userId)
      for (const project of existing) {
        const bound = await this.getWorkspaceDirectory(userId, project.id)
        if (bound && sameLocalPathIdentity(bound, workspaceDirectory)) {
          throw new Error(`该工作文件夹已绑定项目「${project.name}」，请为新项目选择单独的文件夹`)
        }
      }
      ensureSafeDataDirectory(path.join(workspaceDirectory, 'assets'), '画布项目素材')
      const now = new Date().toISOString()
      const id = randomUUID()
      const workflow = { schemaVersion: 2, name, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
      const stored = { id, createdAt: now, updatedAt: now, lastOpenedAt: now, workspaceDirectory, workflow }
      await this.write(userId, stored)
      return { project: this.summary(stored), content: JSON.stringify(workflow) }
    })
  }

  /**
   * The canvas kernel's "save as a new project": the caller's current workflow
   * plus, when it names one, the assets of the project it came from. The
   * content goes through the same validator as save() and the folder and the
   * source through the same checks as duplicate(), so this can do nothing
   * that saving and duplicating could not already do. The source is looked up
   * under this account's own directory, so another account's id is not found.
   */
  async createWithContent(
    userId: number,
    nameInput: string,
    workspaceInput: string,
    content: string,
    sourceProjectId?: string,
  ): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    return this.enqueue(userId, async () => {
      const name = normalizedProjectName(nameInput)
      const parsed = parseCanvasProjectWorkflow(content)
      const workflow = { ...parsed.workflow, name }
      const source = sourceProjectId === undefined ? undefined : await this.readProject(userId, sourceProjectId)
      if (source?.archivedAt) throw new Error('请先恢复已归档项目再复制')
      if (source && !source.workspaceDirectory) throw new Error('旧版项目没有独立的工作文件夹，暂不支持复制')
      // Without a source there is nowhere to copy the files from, and a new
      // project whose images all show as missing is worse than a clear refusal.
      if (!source && (parsed.assetIds.length > 0 || workflowAssetProjection(workflow).assetIds.size > 0)) {
        throw new Error('新项目的内容引用了素材，请从原项目另存副本')
      }
      const targetWorkspace = normalizedWorkspaceDirectory(workspaceInput, true)
      const sourceWorkspace = source?.workspaceDirectory ? normalizedWorkspaceDirectory(source.workspaceDirectory, true) : undefined
      if (sourceWorkspace && sameLocalPathIdentity(sourceWorkspace, targetWorkspace)) throw new Error('复制项目必须选择新的工作文件夹')
      const existing = await this.list(userId)
      assertRoomForNewProject(existing)
      for (const project of existing) {
        const bound = await this.getWorkspaceDirectory(userId, project.id)
        if (bound && sameLocalPathIdentity(bound, targetWorkspace)) {
          throw new Error(`该工作文件夹已绑定项目「${project.name}」，请为新项目选择单独的文件夹`)
        }
      }
      if (sourceWorkspace) await copyProjectAssets(sourceWorkspace, targetWorkspace)
      else ensureSafeDataDirectory(path.join(targetWorkspace, 'assets'), '画布项目素材')
      const now = new Date().toISOString()
      const id = randomUUID()
      const created = { id, createdAt: now, updatedAt: now, lastOpenedAt: now, workspaceDirectory: targetWorkspace, workflow }
      try {
        await this.write(userId, created)
      } catch (error) {
        if (sourceWorkspace) await fs.promises.rm(path.join(targetWorkspace, 'assets'), { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return { project: this.summary(created), content: JSON.stringify(workflow) }
    })
  }

  /**
   * A project package imported as a new project. The caller has already put
   * the package's assets into this folder's own asset stores, so unlike
   * createWithContent() the content may use assets; the folder goes through
   * the same checks as create() and is registered last, after the files are in.
   */
  async createImported(userId: number, nameInput: string, workspaceInput: string, content: string): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    return this.enqueue(userId, async () => {
      const name = normalizedProjectName(nameInput)
      const parsed = parseCanvasProjectWorkflow(content)
      const workflow = { ...parsed.workflow, name }
      const workspaceDirectory = normalizedWorkspaceDirectory(workspaceInput, true)
      const existing = await this.list(userId)
      assertRoomForNewProject(existing)
      for (const project of existing) {
        const bound = await this.getWorkspaceDirectory(userId, project.id)
        if (bound && sameLocalPathIdentity(bound, workspaceDirectory)) {
          throw new Error(`该工作文件夹已绑定项目「${project.name}」，请为新项目选择单独的文件夹`)
        }
      }
      ensureSafeDataDirectory(path.join(workspaceDirectory, 'assets'), '画布项目素材')
      const now = new Date().toISOString()
      const stored = { id: randomUUID(), createdAt: now, updatedAt: now, lastOpenedAt: now, workspaceDirectory, workflow }
      await this.write(userId, stored)
      return { project: this.summary(stored), content: JSON.stringify(workflow) }
    })
  }

  async open(userId: number, projectId: string): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    return this.enqueue(userId, async () => {
      const stored = await this.readProject(userId, projectId)
      if (stored.archivedAt) throw new Error('画布项目已归档，请先恢复后再打开')
      if (stored.workspaceDirectory) normalizedWorkspaceDirectory(stored.workspaceDirectory, true)
      const opened = { ...stored, lastOpenedAt: new Date().toISOString() }
      await this.write(userId, opened)
      return { project: this.summary(opened), content: JSON.stringify(opened.workflow) }
    })
  }

  async save(userId: number, projectId: string, content: string): Promise<CanvasStoredProjectSummary> {
    return this.enqueue(userId, async () => {
      const current = await this.readProject(userId, projectId)
      if (current.archivedAt) throw new Error('画布项目已归档，无法保存')
      const parsed = parseCanvasProjectWorkflow(content)
      const updatedAt = new Date().toISOString()
      if (current.workspaceDirectory) normalizedWorkspaceDirectory(current.workspaceDirectory, true)
      const saved = { ...current, updatedAt, workflow: parsed.workflow }
      await this.write(userId, saved)
      return this.summary(saved)
    })
  }

  async rename(userId: number, projectId: string, nameInput: string): Promise<CanvasStoredProjectSummary> {
    return this.enqueue(userId, async () => {
      const current = await this.readProject(userId, projectId)
      const updatedAt = new Date().toISOString()
      const renamed = {
        ...current,
        updatedAt,
        workflow: { ...current.workflow, name: normalizedProjectName(nameInput) },
      }
      await this.write(userId, renamed)
      return this.summary(renamed)
    })
  }

  async duplicate(userId: number, projectId: string, nameInput: string, workspaceInput: string): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    return this.enqueue(userId, async () => {
      const source = await this.readProject(userId, projectId)
      if (source.archivedAt) throw new Error('请先恢复已归档项目再复制')
      if (!source.workspaceDirectory) throw new Error('旧版项目没有独立的工作文件夹，暂不支持复制')
      const name = normalizedProjectName(nameInput)
      const workflow = structuredClone(source.workflow)
      workflow.name = name
      const sourceWorkspace = normalizedWorkspaceDirectory(source.workspaceDirectory, true)
      const targetWorkspace = normalizedWorkspaceDirectory(workspaceInput, true)
      if (sameLocalPathIdentity(sourceWorkspace, targetWorkspace)) throw new Error('复制项目必须选择新的工作文件夹')
      const existing = await this.list(userId)
      assertRoomForNewProject(existing)
      for (const project of existing) {
        const bound = await this.getWorkspaceDirectory(userId, project.id)
        if (bound && sameLocalPathIdentity(bound, targetWorkspace)) throw new Error(`该工作文件夹已绑定项目「${project.name}」`)
      }
      await copyProjectAssets(sourceWorkspace, targetWorkspace)
      const now = new Date().toISOString()
      const id = randomUUID()
      const duplicate = { id, createdAt: now, updatedAt: now, lastOpenedAt: now, workspaceDirectory: targetWorkspace, workflow }
      try {
        await this.write(userId, duplicate)
      } catch (error) {
        await fs.promises.rm(path.join(targetWorkspace, 'assets'), { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return { project: this.summary(duplicate), content: JSON.stringify(workflow) }
    })
  }

  /**
   * Binds a project whose folder went missing to the folder the user says it
   * is in now. Only a missing folder can be replaced, so this never moves a
   * working project away from its assets. The new folder goes through the
   * same checks as create(), and a project that uses assets needs a folder
   * that has an assets folder: picking the parent by mistake is refused
   * instead of leaving every image missing.
   */
  async relinkWorkspace(userId: number, projectId: string, workspaceInput: string): Promise<CanvasStoredProjectSummary> {
    return this.enqueue(userId, async () => {
      const current = await this.readProject(userId, projectId)
      if (current.archivedAt) throw new Error('请先恢复已归档项目')
      if (!current.workspaceDirectory) throw new Error('旧版项目没有独立的工作文件夹')
      if (workspaceStatus(current.workspaceDirectory) !== 'missing') throw new Error('项目的工作文件夹仍然存在，无需重新选择')
      const workspaceDirectory = normalizedWorkspaceDirectory(workspaceInput, true)
      for (const project of await this.list(userId)) {
        if (project.id === projectId) continue
        const bound = await this.getWorkspaceDirectory(userId, project.id)
        if (bound && sameLocalPathIdentity(bound, workspaceDirectory)) {
          throw new Error(`该工作文件夹已绑定项目「${project.name}」，请选择此项目自身的文件夹`)
        }
      }
      if (workflowAssetProjection(current.workflow).assetIds.size > 0 && !fs.existsSync(path.join(workspaceDirectory, 'assets'))) {
        throw new Error('所选文件夹中没有此项目的素材，请选择原项目文件夹（其中包含 assets 文件夹）')
      }
      ensureSafeDataDirectory(path.join(workspaceDirectory, 'assets'), '画布项目素材')
      const relinked = { ...current, updatedAt: new Date().toISOString(), workspaceDirectory }
      await this.write(userId, relinked)
      return this.summary(relinked)
    })
  }

  async setArchived(userId: number, projectId: string, archived: boolean): Promise<CanvasStoredProjectSummary> {
    return this.enqueue(userId, async () => {
      const current = await this.readProject(userId, projectId)
      if (!archived && current.archivedAt) {
        const active = (await this.list(userId)).filter((project) => !project.archivedAt).length
        if (active >= maximumActiveProjects) throw new Error(`画布项目最多 ${maximumActiveProjects} 个（已归档的不算），请先归档一个再恢复`)
      }
      const { archivedAt: _archivedAt, ...restored } = current
      const now = new Date().toISOString()
      const updated: StoredCanvasProject = archived
        ? { ...restored, updatedAt: now, archivedAt: now }
        : { ...restored, updatedAt: now }
      await this.write(userId, updated)
      return this.summary(updated)
    })
  }

  /**
   * Takes an archived project off the list for good. Only the record goes:
   * the work folder may be one the user picked with their own files in it,
   * so whether anything happens to it is the caller's decision. Archived
   * first, so one call can never remove a project the user is working in.
   */
  async remove(userId: number, projectId: string): Promise<{ project: CanvasStoredProjectSummary; workspaceDirectory?: string }> {
    return this.enqueue(userId, async () => {
      const stored = await this.readProject(userId, projectId)
      if (!stored.archivedAt) throw new Error('请先归档此项目，再进行删除')
      ensureSafeDataDirectory(this.accountRoot(userId), '画布项目')
      await fs.promises.unlink(this.projectPath(userId, projectId))
      return { project: this.summary(stored), ...(stored.workspaceDirectory ? { workspaceDirectory: stored.workspaceDirectory } : {}) }
    })
  }

  async findAssetReferences(userId: number, assetId: string): Promise<CanvasProjectAssetReference[]> {
    safeUserId(userId)
    if (!assetIdPattern.test(assetId)) throw new Error('画布资产标识格式错误')
    const references: CanvasProjectAssetReference[] = []
    for (const project of await this.list(userId)) {
      const stored = await this.readProject(userId, project.id)
      const nodeIds = findCanvasWorkflowAssetReferenceNodeIds(stored.workflow, assetId)
      if (nodeIds.length > 0) references.push({
        projectId: stored.id,
        projectName: String(stored.workflow.name),
        nodeIds,
        archived: Boolean(stored.archivedAt),
      })
    }
    return references
  }

  async getWorkspaceDirectory(userId: number, projectId: string): Promise<string | null> {
    const directory = (await this.readProject(userId, projectId)).workspaceDirectory
    return directory ?? null
  }

  async getUsableWorkspaceDirectory(userId: number, projectId: string): Promise<string | null> {
    const directory = await this.getWorkspaceDirectory(userId, projectId)
    return directory ? normalizedWorkspaceDirectory(directory, true) : null
  }

  private async write(userId: number, project: StoredCanvasProject): Promise<void> {
    const root = this.accountRoot(userId)
    ensureSafeDataDirectory(this.rootDirectory, '画布项目')
    ensureSafeDataDirectory(root, '画布项目')
    await writeAtomicSafeUtf8File(this.projectPath(userId, project.id), JSON.stringify({
      version: 3,
      id: project.id,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
      ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
      ...(project.workspaceDirectory ? { workspaceDirectory: project.workspaceDirectory } : {}),
      workflow: project.workflow,
    }), '画布项目')
  }

  private enqueue<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    safeUserId(userId)
    const previous = this.queues.get(userId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(userId, tail)
    void tail.then(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId)
    })
    return result
  }
}
