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
export const MAXIMUM_FINISHED_VIDEO_TASKS = 100
export const AI_VIDEO_TASK_VERSION = 2
const MAXIMUM_PROMPT_LENGTH = 2_000
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const secretOrEndpoint = /\b(?:apiKey|accessToken|refreshToken)\b|https?:\/\//i

export interface StoredAiVideoTask {
  version: typeof AI_VIDEO_TASK_VERSION
  userId: number
  taskId: string
  group: string
  model: string
  requestId: string
  createdAt: string
  projectId?: string
  runId?: string
  nodeId?: string
  attemptId?: string
  graphRevision?: string
  /**
   * What the person asked for. Carried here because a video outlives the
   * session that requested it: the record is what a resumed task has to write
   * onto the finished asset, and the prompt is the one thing about a clip that
   * is still recognisable weeks later.
   */
  prompt?: string
}

/**
 * Which clip a finished task became, kept after the task itself is gone. The
 * window that asked for a clip is not always there when it lands: the app was
 * closed and the next launch fetched it, or the page reloaded mid-wait. The
 * video studio keeps the request id of every shot still generating and asks
 * for it here when it reopens, so a clip the account already paid for goes
 * back onto its shot instead of reading "not generated" and being paid for a
 * second time.
 */
export interface FinishedAiVideoTask {
  requestId: string
  taskId: string
  assetId: string
  width?: number
  height?: number
  durationSeconds?: number
  finishedAt: string
}

export type FinishedAiVideoAsset = Pick<FinishedAiVideoTask, 'assetId' | 'width' | 'height' | 'durationSeconds'>

interface AiVideoTaskState {
  version: typeof AI_VIDEO_TASK_VERSION
  userId: number
  tasks: StoredAiVideoTask[]
  finished: FinishedAiVideoTask[]
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

function safeCorrelationFields(task: Partial<StoredAiVideoTask>): boolean {
  const fields = [task.runId, task.nodeId, task.attemptId, task.graphRevision]
  const hasCorrelation = fields.some((value) => value !== undefined)
  if (!hasCorrelation) return true
  if (!fields.every((value) => safeString(value, 256))) return false
  return /^[a-f0-9]{64}$/.test(task.graphRevision as string)
}

export function normalizeAiVideoTaskPrompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('AI 视频提示词格式错误')
  // Newlines and tabs are ordinary in a prompt; the rest would corrupt the
  // stored JSON view and never came from a person typing.
  const prompt = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim().slice(0, MAXIMUM_PROMPT_LENGTH)
  if (!prompt) throw new Error('AI 视频提示词格式错误')
  return prompt
}

function safePrompt(value: unknown): boolean {
  if (value === undefined) return true
  try {
    return normalizeAiVideoTaskPrompt(value) === value
  } catch {
    return false
  }
}

function safeTaskFields(value: unknown, userId: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Partial<StoredAiVideoTask>
  return task.userId === userId
    && typeof task.taskId === 'string'
    && TASK_ID_PATTERN.test(task.taskId)
    && safeString(task.group, 128)
    && safeString(task.model, 128)
    && safeString(task.requestId, 160)
    && typeof task.createdAt === 'string'
    && !Number.isNaN(Date.parse(task.createdAt))
    && (task.projectId === undefined || (typeof task.projectId === 'string' && /^[a-f0-9-]{36}$/.test(task.projectId)))
    && safeCorrelationFields(task)
}

function safeTask(value: unknown, userId: number): value is StoredAiVideoTask {
  return safeTaskFields(value, userId)
    && (value as Partial<StoredAiVideoTask>).version === AI_VIDEO_TASK_VERSION
    && safePrompt((value as Partial<StoredAiVideoTask>).prompt)
}

/**
 * Version 1 records predate the prompt and are read as they stand, with the
 * prompt simply absent: a task submitted before the upgrade still has to be
 * resumable, and its asset just lands without a prompt the way it would have
 * anyway.
 */
function migrateTask(value: unknown, userId: number): StoredAiVideoTask | null {
  if (!safeTaskFields(value, userId)) return null
  if ((value as { version?: unknown }).version === 1) {
    const { prompt: _legacyPrompt, ...rest } = value as StoredAiVideoTask
    return { ...rest, version: AI_VIDEO_TASK_VERSION }
  }
  return safeTask(value, userId) ? value : null
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readFinished(value: unknown): FinishedAiVideoTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Partial<FinishedAiVideoTask>
  if (!safeString(entry.requestId, 160) || typeof entry.taskId !== 'string' || !TASK_ID_PATTERN.test(entry.taskId)
    || typeof entry.assetId !== 'string' || !ASSET_ID_PATTERN.test(entry.assetId)
    || typeof entry.finishedAt !== 'string' || Number.isNaN(Date.parse(entry.finishedAt))) return null
  const width = positive(entry.width), height = positive(entry.height), durationSeconds = positive(entry.durationSeconds)
  return {
    requestId: entry.requestId, taskId: entry.taskId, assetId: entry.assetId,
    ...(width ? { width } : {}), ...(height ? { height } : {}), ...(durationSeconds ? { durationSeconds } : {}),
    finishedAt: entry.finishedAt,
  }
}

function parseState(content: string, userId: number): AiVideoTaskState {
  const value = JSON.parse(content) as Partial<AiVideoTaskState>
  const version = (value as { version?: unknown }).version
  if ((version !== 1 && version !== AI_VIDEO_TASK_VERSION) || value.userId !== userId
    || !Array.isArray(value.tasks) || value.tasks.length > MAXIMUM_VIDEO_TASKS) {
    throw new Error('AI 视频任务记录格式错误')
  }
  const tasks = value.tasks.map((task) => migrateTask(task, userId))
  if (tasks.some((task) => task === null)) throw new Error('AI 视频任务记录格式错误')
  // The tripwire keeping credentials and endpoints out of this file runs over
  // everything except the prompts. A prompt is text the user wrote and may
  // legitimately quote a URL; it is never fetched, and it is already persisted
  // verbatim beside the asset. Scanning it here would let one such prompt
  // condemn the whole file and lose every task waiting to be resumed.
  const scanned = JSON.stringify({ ...value, finished: undefined, tasks: tasks.map((task) => ({ ...task, prompt: undefined })) })
  if (secretOrEndpoint.test(scanned)) {
    throw new Error('AI 视频任务记录包含凭据或远程地址')
  }
  // A bad entry among the finished ones only means one shot cannot find its
  // clip again. It is dropped on its own and must not condemn the tasks above,
  // which are still waiting on money already spent.
  const finished = (Array.isArray(value.finished) ? value.finished : [])
    .map(readFinished)
    .filter((entry): entry is FinishedAiVideoTask => entry !== null && !secretOrEndpoint.test(JSON.stringify(entry)))
    .slice(0, MAXIMUM_FINISHED_VIDEO_TASKS)
  return { version: AI_VIDEO_TASK_VERSION, userId, tasks: tasks as StoredAiVideoTask[], finished }
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

  /** The clip is saved: drop the task and remember which clip its request became, in one write. */
  async finish(task: Pick<StoredAiVideoTask, 'userId' | 'taskId' | 'requestId'>, asset: FinishedAiVideoAsset): Promise<void> {
    assertTaskId(task.taskId)
    return this.enqueue(task.userId, async () => {
      const state = await this.read(task.userId)
      state.tasks = state.tasks.filter((entry) => entry.taskId !== task.taskId)
      const entry = readFinished({ ...asset, requestId: task.requestId, taskId: task.taskId, finishedAt: this.now().toISOString() })
      if (entry) {
        state.finished = [entry, ...state.finished.filter((existing) => existing.requestId !== entry.requestId)]
          .slice(0, MAXIMUM_FINISHED_VIDEO_TASKS)
      }
      await this.write(task.userId, state)
    })
  }

  async findFinished(userId: number, requestId: string): Promise<FinishedAiVideoTask | null> {
    if (!safeString(requestId, 160)) return null
    return this.enqueue(userId, async () => {
      const entry = (await this.read(userId)).finished.find((candidate) => candidate.requestId === requestId)
      return entry ? structuredClone(entry) : null
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
      return content === null ? { version: AI_VIDEO_TASK_VERSION, userId, tasks: [], finished: [] } : parseState(content, userId)
    } catch {
      try {
        const backup = `${filePath}.corrupt-${this.now().getTime()}-${this.randomUUID()}.bak`
        await fs.promises.rename(filePath, backup)
      } catch {
        // Unsafe or missing state is left untouched and ignored.
      }
      return { version: AI_VIDEO_TASK_VERSION, userId, tasks: [], finished: [] }
    }
  }

  private async write(userId: number, state: AiVideoTaskState): Promise<void> {
    const directory = this.userDirectory(userId)
    ensureSafeDataDirectory(this.rootDirectory, FILE_LABEL)
    ensureSafeDataDirectory(directory, FILE_LABEL)
    // Older builds read only `tasks` and drop the rest when they write, which
    // costs nothing but the shots they never knew to look for.
    const { finished, ...rest } = state
    const content = `${JSON.stringify(finished.length ? state : rest, null, 2)}\n`
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
