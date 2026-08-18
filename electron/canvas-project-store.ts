import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureSafeDataDirectory, writeAtomicSafeUtf8File } from './safe-local-data'
import { copyBoundedFileExclusive, readBoundedUtf8File } from './bounded-file'
import { parseCanvasProjectWorkflow } from './canvas-project-package'
import { sameLocalPathIdentity } from './path-identity'

const maximumProjects = 100
const maximumCopiedEntries = 100_000
const maximumCopiedBytes = 100 * 1024 * 1024 * 1024
const maximumReferenceValues = 250_000
const projectIdPattern = /^[a-f0-9-]{36}$/
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

function normalizedWorkspaceDirectory(value: string, requireExisting: boolean): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > 32_768) {
    throw new Error('画布项目工作文件夹无效')
  }
  const directory = path.resolve(value)
  if (requireExisting) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(directory)
    } catch {
      throw new Error('画布项目工作文件夹不存在')
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('画布项目工作文件夹必须是普通目录')
    const realPath = fs.realpathSync(directory)
    if (!sameLocalPathIdentity(realPath, directory)) throw new Error('画布项目工作文件夹不能经过符号链接或目录联接')
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

  async list(userId: number): Promise<CanvasStoredProjectSummary[]> {
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
      .slice(0, maximumProjects)
      .map(async (name) => {
        try {
          return this.summary(await this.readProject(userId, path.basename(name, '.json')))
        } catch { return null }
      }))
    return projects.filter((entry): entry is CanvasStoredProjectSummary => Boolean(entry))
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt) || right.updatedAt.localeCompare(left.updatedAt))
  }

  async create(userId: number, nameInput: string, workspaceInput: string): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    return this.enqueue(userId, async () => {
      const name = normalizedProjectName(nameInput)
      if ((await this.list(userId)).length >= maximumProjects) throw new Error('画布项目已达到数量上限')
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
      if (!source.workspaceDirectory) throw new Error('旧项目没有独立工作文件夹，暂时不能复制')
      const name = normalizedProjectName(nameInput)
      const workflow = structuredClone(source.workflow)
      workflow.name = name
      const sourceWorkspace = normalizedWorkspaceDirectory(source.workspaceDirectory, true)
      const targetWorkspace = normalizedWorkspaceDirectory(workspaceInput, true)
      if (sameLocalPathIdentity(sourceWorkspace, targetWorkspace)) throw new Error('复制项目必须选择新的工作文件夹')
      const existing = await this.list(userId)
      if (existing.length >= maximumProjects) throw new Error('画布项目已达到数量上限')
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

  async setArchived(userId: number, projectId: string, archived: boolean): Promise<CanvasStoredProjectSummary> {
    return this.enqueue(userId, async () => {
      const current = await this.readProject(userId, projectId)
      const { archivedAt: _archivedAt, ...restored } = current
      const now = new Date().toISOString()
      const updated: StoredCanvasProject = archived
        ? { ...restored, updatedAt: now, archivedAt: now }
        : { ...restored, updatedAt: now }
      await this.write(userId, updated)
      return this.summary(updated)
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
