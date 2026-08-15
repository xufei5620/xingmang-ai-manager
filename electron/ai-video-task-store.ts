import fs from 'node:fs'
import path from 'node:path'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const FILE_LABEL = 'AI 视频任务记录'
const MAXIMUM_FILE_BYTES = 2 * 1024 * 1024
export const MAXIMUM_VIDEO_TASKS = 200
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export interface StoredAiVideoTask {
  version: 1
  userId: number
  taskId: string
  group: string
  model: string
  requestId: string
  createdAt: string
  projectId?: string
}

interface AiVideoTaskState {
  version: 1
  userId: number
  tasks: StoredAiVideoTask[]
}

export interface AiVideoTaskStoreOptions {
  rootDirectory: string
  now?: () => Date
  randomUUID?: () => string
}

function assertUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('AI 视频账号标识格式错误')
}

function assertTaskId(value: string): void {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) throw new Error('AI 视频任务标识格式错误')
}

function safeString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1F\x7F]/.test(value)
}

function safeTask(value: unknown, userId: number): value is StoredAiVideoTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Partial<StoredAiVideoTask>
  return task.version === 1
    && task.userId === userId
    && typeof task.taskId === 'string'
    && TASK_ID_PATTERN.test(task.taskId)
    && safeString(task.group, 128)
    && safeString(task.model, 128)
    && safeString(task.requestId, 160)
    && typeof task.createdAt === 'string'
    && !Number.isNaN(Date.parse(task.createdAt))
    && (task.projectId === undefined || (typeof task.projectId === 'string' && /^[a-f0-9-]{36}$/.test(task.projectId)))
}

function parseState(content: string, userId: number): AiVideoTaskState {
  if (/\b(?:apiKey|accessToken|refreshToken)\b|https?:\/\//i.test(content)) {
    throw new Error('AI 视频任务记录包含凭据或远程地址')
  }
  const value = JSON.parse(content) as Partial<AiVideoTaskState>
  if (value.version !== 1 || value.userId !== userId || !Array.isArray(value.tasks)
    || value.tasks.length > MAXIMUM_VIDEO_TASKS || !value.tasks.every((task) => safeTask(task, userId))) {
    throw new Error('AI 视频任务记录格式错误')
  }
  return value as AiVideoTaskState
}

export class AiVideoTaskStore {
  private readonly rootDirectory: string
  private readonly now: () => Date
  private readonly randomUUID: () => string
  private readonly queues = new Map<number, Promise<void>>()
  private readonly reservations = new Map<number, Set<string>>()
  private reservationSequence = 0

  constructor(options: AiVideoTaskStoreOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory)
    this.now = options.now ?? (() => new Date())
    this.randomUUID = options.randomUUID ?? nodeRandomUUID
  }

  async list(userId: number): Promise<StoredAiVideoTask[]> {
    return this.enqueue(userId, async () => structuredClone((await this.read(userId)).tasks))
  }

  async reserve(userId: number): Promise<string> {
    return this.enqueue(userId, async () => {
      const state = await this.read(userId)
      const reservations = this.reservations.get(userId) ?? new Set<string>()
      if (state.tasks.length + reservations.size >= MAXIMUM_VIDEO_TASKS) {
        throw new Error(`AI 视频待恢复任务已达 ${MAXIMUM_VIDEO_TASKS} 条上限，请先等待或清理已有任务`)
      }
      this.reservationSequence += 1
      const reservationId = `${this.randomUUID()}-${this.reservationSequence.toString(36)}`
      reservations.add(reservationId)
      this.reservations.set(userId, reservations)
      return reservationId
    })
  }

  async commitReservation(reservationId: string, task: StoredAiVideoTask): Promise<void> {
    assertUserId(task.userId)
    assertTaskId(task.taskId)
    if (!safeString(reservationId, 256) || !safeTask(task, task.userId)) {
      throw new Error('AI 视频任务预留或记录格式错误')
    }
    return this.enqueue(task.userId, async () => {
      const reservations = this.reservations.get(task.userId)
      if (!reservations?.has(reservationId)) throw new Error('AI 视频任务预留已失效')
      const state = await this.read(task.userId)
      const existing = state.tasks.some((entry) => entry.taskId === task.taskId)
      const otherReservations = reservations.size - 1
      if (!existing && state.tasks.length + otherReservations >= MAXIMUM_VIDEO_TASKS) {
        throw new Error('AI 视频待恢复任务已达 200 条上限，未覆盖已有任务记录')
      }
      state.tasks = [structuredClone(task), ...state.tasks.filter((entry) => entry.taskId !== task.taskId)]
      await this.write(task.userId, state)
      reservations.delete(reservationId)
      if (reservations.size === 0) this.reservations.delete(task.userId)
    })
  }

  async releaseReservation(userId: number, reservationId: string): Promise<void> {
    if (!safeString(reservationId, 256)) throw new Error('AI 视频任务预留格式错误')
    return this.enqueue(userId, async () => {
      const reservations = this.reservations.get(userId)
      if (!reservations) return
      reservations.delete(reservationId)
      if (reservations.size === 0) this.reservations.delete(userId)
    })
  }

  async upsert(task: StoredAiVideoTask): Promise<void> {
    assertUserId(task.userId)
    assertTaskId(task.taskId)
    if (!safeTask(task, task.userId)) throw new Error('AI 视频任务记录格式错误')
    return this.enqueue(task.userId, async () => {
      const state = await this.read(task.userId)
      const existing = state.tasks.some((entry) => entry.taskId === task.taskId)
      const reservationCount = this.reservations.get(task.userId)?.size ?? 0
      if (!existing && state.tasks.length + reservationCount >= MAXIMUM_VIDEO_TASKS) {
        throw new Error('AI 视频待恢复任务已达 200 条上限，未覆盖已有任务记录')
      }
      state.tasks = [structuredClone(task), ...state.tasks.filter((entry) => entry.taskId !== task.taskId)]
      await this.write(task.userId, state)
    })
  }

  async remove(userId: number, taskId: string): Promise<void> {
    assertTaskId(taskId)
    return this.enqueue(userId, async () => {
      const state = await this.read(userId)
      state.tasks = state.tasks.filter((entry) => entry.taskId !== taskId)
      await this.write(userId, state)
    })
  }

  private userDirectory(userId: number): string {
    assertUserId(userId)
    return path.join(this.rootDirectory, `user-${userId}`)
  }

  private filePath(userId: number): string {
    return path.join(this.userDirectory(userId), 'video-tasks.json')
  }

  private async read(userId: number): Promise<AiVideoTaskState> {
    const filePath = this.filePath(userId)
    try {
      const content = await readSafeUtf8File(filePath, FILE_LABEL, MAXIMUM_FILE_BYTES)
      return content === null ? { version: 1, userId, tasks: [] } : parseState(content, userId)
    } catch {
      try {
        const backup = `${filePath}.corrupt-${this.now().getTime()}-${this.randomUUID()}.bak`
        await fs.promises.rename(filePath, backup)
      } catch {
        // Unsafe or missing state is left untouched and ignored.
      }
      return { version: 1, userId, tasks: [] }
    }
  }

  private async write(userId: number, state: AiVideoTaskState): Promise<void> {
    const directory = this.userDirectory(userId)
    ensureSafeDataDirectory(this.rootDirectory, FILE_LABEL)
    ensureSafeDataDirectory(directory, FILE_LABEL)
    const content = `${JSON.stringify(state, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > MAXIMUM_FILE_BYTES) throw new Error('AI 视频任务记录超过安全上限')
    await writeAtomicSafeUtf8File(this.filePath(userId), content, FILE_LABEL)
  }

  private enqueue<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    assertUserId(userId)
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
