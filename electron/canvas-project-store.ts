import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureSafeDataDirectory, writeAtomicSafeUtf8File } from './safe-local-data'
import { readBoundedUtf8File } from './bounded-file'
import { parseCanvasProjectWorkflow } from './canvas-project-package'
import { sameLocalPathIdentity } from './path-identity'

const maximumProjects = 100
const projectIdPattern = /^[a-f0-9-]{36}$/

export interface CanvasStoredProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  nodeCount: number
  workspaceName?: string
  workspaceConfigured: boolean
}

interface StoredCanvasProject {
  id: string
  createdAt: string
  updatedAt: string
  workspaceDirectory?: string
  workflow: Record<string, unknown>
}

function safeUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('画布项目账号标识无效')
}

function safeProjectId(projectId: string): void {
  if (!projectIdPattern.test(projectId)) throw new Error('画布项目标识无效')
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

export class CanvasProjectStore {
  private readonly rootDirectory: string

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
      ...(workspaceDirectory ? { workspaceDirectory } : {}),
      workflow: parsed.workflow,
    }
  }

  private summary(project: StoredCanvasProject): CanvasStoredProjectSummary {
    return {
      id: project.id,
      name: String(project.workflow.name),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      nodeCount: (project.workflow.nodes as unknown[]).length,
      ...(project.workspaceDirectory ? { workspaceName: workspaceName(project.workspaceDirectory) } : {}),
      workspaceConfigured: Boolean(project.workspaceDirectory),
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
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async create(userId: number, nameInput: string, workspaceInput: string): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    const name = nameInput.trim()
    if (!name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('项目名称无效')
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
    await this.write(userId, id, now, now, workflow, workspaceDirectory)
    return { project: this.summary({ id, createdAt: now, updatedAt: now, workspaceDirectory, workflow }), content: JSON.stringify(workflow) }
  }

  async open(userId: number, projectId: string): Promise<{ project: CanvasStoredProjectSummary; content: string }> {
    const stored = await this.readProject(userId, projectId)
    return { project: this.summary(stored), content: JSON.stringify(stored.workflow) }
  }

  async save(userId: number, projectId: string, content: string): Promise<CanvasStoredProjectSummary> {
    const current = await this.open(userId, projectId)
    const parsed = parseCanvasProjectWorkflow(content)
    const updatedAt = new Date().toISOString()
    const workspaceDirectory = await this.getWorkspaceDirectory(userId, projectId)
    await this.write(userId, projectId, current.project.createdAt, updatedAt, parsed.workflow, workspaceDirectory ?? undefined)
    return this.summary({ id: projectId, createdAt: current.project.createdAt, updatedAt, ...(workspaceDirectory ? { workspaceDirectory } : {}), workflow: parsed.workflow })
  }

  async getWorkspaceDirectory(userId: number, projectId: string): Promise<string | null> {
    const directory = (await this.readProject(userId, projectId)).workspaceDirectory
    return directory ?? null
  }

  async getUsableWorkspaceDirectory(userId: number, projectId: string): Promise<string | null> {
    const directory = await this.getWorkspaceDirectory(userId, projectId)
    return directory ? normalizedWorkspaceDirectory(directory, true) : null
  }

  private async write(userId: number, id: string, createdAt: string, updatedAt: string, workflow: Record<string, unknown>, workspaceDirectory?: string): Promise<void> {
    const root = this.accountRoot(userId)
    ensureSafeDataDirectory(this.rootDirectory, '画布项目')
    ensureSafeDataDirectory(root, '画布项目')
    await writeAtomicSafeUtf8File(this.projectPath(userId, id), JSON.stringify({
      version: 2,
      id,
      createdAt,
      updatedAt,
      ...(workspaceDirectory ? { workspaceDirectory } : {}),
      workflow,
    }), '画布项目')
  }
}
