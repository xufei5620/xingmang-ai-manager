import {
  AI_CHAT_ENDPOINTS,
  buildVideoGenerationRequest,
} from './ai-chat-protocol'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'
import type { AiStoredVideoAsset } from './ai-video-asset-store'
import type { AiVideoTaskStore, StoredAiVideoTask } from './ai-video-task-store'

const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_MAXIMUM_POLL_INTERVAL_MS = 10_000
const DEFAULT_MAXIMUM_WAIT_MS = 30 * 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const MAXIMUM_JSON_BYTES = 2 * 1024 * 1024
const MAXIMUM_VIDEO_BYTES = 512 * 1024 * 1024
const MAXIMUM_ERROR_MESSAGE = 300
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface AiVideoGenerationInput {
  requestId: string
  group: string
  model: string
  prompt: string
  seconds: string
  imageAssetId?: string
  width?: number
  height?: number
  expectedUserId?: number
  projectId?: string
}

export interface GeneratedAiVideoAsset extends AiStoredVideoAsset {
  taskId: string
}

export interface AiVideoAssetWriter {
  prepareProject?(userId: number, projectId?: string): Promise<void>
  storeMp4(userId: number, bytes: Buffer, metadata: { taskId: string; projectId?: string }): Promise<AiStoredVideoAsset>
  readImageDataUri(userId: number, assetId: string, projectId?: string): Promise<string>
}

export interface AiVideoCancelResult {
  canceled: boolean
  mayStillComplete: boolean
}

interface ActiveVideoRequest {
  senderId: number
  requestId: string
  controller: AbortController
  userId?: number
  taskId?: string
  dispatched: boolean
}

function requestKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

function requiredIdentifier(value: string, label: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum || /[\x00-\x1F\x7F]/.test(normalized)) throw new Error(`${label}格式错误`)
  return normalized
}

function requiredTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) throw new Error('视频接口没有返回有效的任务标识')
  return value
}

function safeUpstreamMessage(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[远程地址]')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
    .slice(0, MAXIMUM_ERROR_MESSAGE)
}

function videoRequestFailure(status: number, detail: string): Error {
  if (status === 401) return new Error('视频 API Key 已失效，请重新创建或更换密钥')
  if (status === 403 && /insufficient|quota|额度不足/i.test(detail)) return new Error('账号余额或 API Key 额度不足，请充值后重试')
  if (status === 403) return new Error('当前账号暂无该视频模型权限，请切换其他模型')
  if (status === 429) return new Error('视频服务繁忙或上游限流，请稍后重试')
  if (status >= 500) return new Error('视频服务暂时不可用，请稍后重试')
  return new Error(detail || `视频请求失败，服务返回 ${status}`)
}

function ambiguousVideoSubmission(): Error {
  return new Error('视频提交结果不明确，服务端可能已创建任务，请勿立即重复提交')
}

async function readBoundedBytes(response: Response, maximumBytes: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${label}超过安全上限`)
  if (!response.body) throw new Error(`${label}没有内容`)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label}超过安全上限`)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  if (received === 0) throw new Error(`${label}为空`)
  return Buffer.concat(chunks, received)
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBytes(response, MAXIMUM_JSON_BYTES, '视频接口响应')
  let payload: unknown
  try {
    payload = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new Error('视频接口返回的不是有效 JSON')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('视频接口返回数据不完整')
  return payload as Record<string, unknown>
}

function errorDetail(payload: Record<string, unknown>): string {
  const nested = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? (payload.error as Record<string, unknown>).message
    : undefined
  return safeUpstreamMessage(nested ?? payload.message)
}

export function delayVideoPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const complete = () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(complete, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve().then(() => {
      if (!signal.aborted) return
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      reject(signal.reason)
    })
  })
}

export function createAiVideoService(options: {
  baseUrl: string
  credentials: Pick<ChatCredentialCoordinator, 'resolveCredential'>
  tasks: Pick<AiVideoTaskStore, 'list' | 'reserve' | 'commitReservation' | 'releaseReservation' | 'remove'>
  assets: AiVideoAssetWriter
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  maximumPollIntervalMs?: number
  maximumWaitMs?: number
  requestTimeoutMs?: number
  now?: () => Date
}) {
  const baseUrl = new URL(options.baseUrl)
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) throw new Error('视频服务地址必须使用 HTTPS')
  const fetchImpl = options.fetchImpl ?? fetch
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maximumPollIntervalMs = options.maximumPollIntervalMs ?? DEFAULT_MAXIMUM_POLL_INTERVAL_MS
  const maximumWaitMs = options.maximumWaitMs ?? DEFAULT_MAXIMUM_WAIT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const now = options.now ?? (() => new Date())
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
    || !Number.isSafeInteger(maximumPollIntervalMs) || maximumPollIntervalMs < pollIntervalMs
    || !Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 1
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('视频服务超时配置无效')
  const active = new Map<string, ActiveVideoRequest>()

  async function fetchWithTimeout(url: URL, init: RequestInit, operationSignal: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(operationSignal.reason)
    operationSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('视频接口请求超时')), requestTimeoutMs)
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal })
      if (response.url) {
        const finalUrl = new URL(response.url)
        if (finalUrl.origin !== baseUrl.origin) throw new Error('视频接口响应来源不可信')
      }
      return response
    } finally {
      clearTimeout(timer)
      operationSignal.removeEventListener('abort', onAbort)
    }
  }

  async function authorizedJson(
    pathName: string,
    apiKey: string,
    signal: AbortSignal,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(new URL(pathName, baseUrl), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, signal)
    const payload = await responseJson(response)
    if (!response.ok) throw videoRequestFailure(response.status, errorDetail(payload))
    return payload
  }

  async function pollTask(task: StoredAiVideoTask, apiKey: string, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now()
    let interval = pollIntervalMs
    for (;;) {
      if (Date.now() - startedAt > maximumWaitMs) throw new Error('已停止等待视频生成；服务端任务已保留，可在下次启动时继续查询')
      const payload = await authorizedJson(`${AI_CHAT_ENDPOINTS.videos}/${encodeURIComponent(task.taskId)}`, apiKey, signal)
      if (requiredTaskId(payload.id) !== task.taskId) throw new Error('视频任务状态与请求不匹配')
      const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : ''
      if (status === 'completed') return
      if (status === 'failed') {
        const message = safeUpstreamMessage(
          payload.error && typeof payload.error === 'object' ? (payload.error as Record<string, unknown>).message : undefined,
        ) || '视频生成失败'
        await options.tasks.remove(task.userId, task.taskId).catch(() => undefined)
        throw new Error(message)
      }
      if (!['queued', 'in_progress', 'processing', 'submitted'].includes(status)) throw new Error('视频接口返回了未知任务状态')
      await delayVideoPoll(interval, signal)
      interval = Math.min(maximumPollIntervalMs, interval * 2)
    }
  }

  async function downloadTask(task: StoredAiVideoTask, apiKey: string, signal: AbortSignal): Promise<GeneratedAiVideoAsset> {
    const response = await fetchWithTimeout(
      new URL(`${AI_CHAT_ENDPOINTS.videos}/${encodeURIComponent(task.taskId)}/content`, baseUrl),
      { method: 'GET', headers: { Accept: 'video/mp4', Authorization: `Bearer ${apiKey}` } },
      signal,
    )
    if (!response.ok) {
      const payload = await responseJson(response).catch(() => ({}))
      throw videoRequestFailure(response.status, errorDetail(payload))
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    if (contentType && contentType !== 'video/mp4' && contentType !== 'application/octet-stream') {
      throw new Error('视频下载响应类型不受支持')
    }
    const asset = await options.assets.storeMp4(
      task.userId,
      await readBoundedBytes(response, MAXIMUM_VIDEO_BYTES, '视频文件'),
      { taskId: task.taskId, ...(task.projectId ? { projectId: task.projectId } : {}) },
    )
    await options.tasks.remove(task.userId, task.taskId)
    return { ...asset, taskId: task.taskId }
  }

  async function finishExisting(task: StoredAiVideoTask, signal: AbortSignal): Promise<GeneratedAiVideoAsset> {
    const credential = await options.credentials.resolveCredential(task.group)
    if (credential.userId !== task.userId) throw new Error('登录账号已变化，已停止视频任务查询')
    await options.assets.prepareProject?.(task.userId, task.projectId)
    await pollTask(task, credential.apiKey, signal)
    return downloadTask(task, credential.apiKey, signal)
  }

  async function generate(senderId: number, input: AiVideoGenerationInput): Promise<GeneratedAiVideoAsset> {
    if (!Number.isSafeInteger(senderId) || senderId <= 0) throw new Error('视频窗口标识格式错误')
    const requestId = requiredIdentifier(input.requestId, '视频请求标识', 160)
    const key = requestKey(senderId, requestId)
    if (active.has(key)) throw new Error('该视频请求正在处理中')
    const operation: ActiveVideoRequest = {
      senderId, requestId, controller: new AbortController(), dispatched: false,
    }
    let reservationId: string | undefined
    active.set(key, operation)
    try {
      const credential = await options.credentials.resolveCredential(input.group)
      operation.userId = credential.userId
      if (input.expectedUserId !== undefined && input.expectedUserId !== credential.userId) {
        throw new Error('登录账号已变化，请重新运行视频生成')
      }
      if (!credential.models.includes(input.model)) {
        throw new Error(`当前分组「${input.group}」不提供模型「${input.model}」，请重新选择可用模型`)
      }
      await options.assets.prepareProject?.(credential.userId, input.projectId)
      let image: string | undefined
      if (input.imageAssetId !== undefined) {
        if (!ASSET_ID_PATTERN.test(input.imageAssetId)) throw new Error('视频参考图片资产标识格式错误')
        image = input.projectId
          ? await options.assets.readImageDataUri(credential.userId, input.imageAssetId, input.projectId)
          : await options.assets.readImageDataUri(credential.userId, input.imageAssetId)
      }
      const body = buildVideoGenerationRequest({
        model: input.model, prompt: input.prompt, seconds: input.seconds,
        ...(image ? { image } : {}),
        ...(input.width !== undefined ? { width: input.width, height: input.height } : {}),
      })
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason
      reservationId = await options.tasks.reserve(credential.userId)
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason
      operation.dispatched = true
      let response: Response
      try {
        response = await fetchWithTimeout(new URL(AI_CHAT_ENDPOINTS.videos, baseUrl), {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${credential.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }, operation.controller.signal)
      } catch (error) {
        if (operation.controller.signal.aborted) throw error
        throw ambiguousVideoSubmission()
      }
      let payload: Record<string, unknown>
      try {
        payload = await responseJson(response)
      } catch {
        if (!response.ok && response.status < 500) throw videoRequestFailure(response.status, '')
        throw ambiguousVideoSubmission()
      }
      if (!response.ok) {
        if (response.status >= 500) throw ambiguousVideoSubmission()
        throw videoRequestFailure(response.status, errorDetail(payload))
      }
      let taskId: string
      try {
        taskId = requiredTaskId(payload.id)
      } catch {
        throw ambiguousVideoSubmission()
      }
      const task: StoredAiVideoTask = {
        version: 1,
        userId: credential.userId,
        taskId,
        group: requiredIdentifier(input.group, '视频分组', 128),
        model: body.model,
        requestId,
        createdAt: now().toISOString(),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }
      try {
        await options.tasks.commitReservation(reservationId, task)
        reservationId = undefined
        operation.taskId = task.taskId
      } catch {
        throw new Error(`视频任务已创建但本地恢复记录保存失败（任务 ${task.taskId}），请勿重复提交`)
      }
      await pollTask(task, credential.apiKey, operation.controller.signal)
      return await downloadTask(task, credential.apiKey, operation.controller.signal)
    } catch (error) {
      if (operation.controller.signal.aborted) {
        if (operation.taskId) throw new Error('已停止等待；服务端可能仍在生成视频，下次启动会继续查询')
        if (operation.dispatched) throw new Error('视频提交结果不明确，服务端可能已创建任务，请勿立即重复提交')
        throw new Error('已取消视频请求')
      }
      throw error
    } finally {
      if (reservationId && operation.userId) {
        await options.tasks.releaseReservation(operation.userId, reservationId).catch(() => undefined)
      }
      if (active.get(key) === operation) active.delete(key)
    }
  }

  function cancel(senderId: number, requestIdInput: string): AiVideoCancelResult {
    const requestId = requiredIdentifier(requestIdInput, '视频请求标识', 160)
    const operation = active.get(requestKey(senderId, requestId))
    if (!operation || operation.controller.signal.aborted) return { canceled: false, mayStillComplete: false }
    operation.controller.abort(new Error('用户停止等待视频生成'))
    return { canceled: true, mayStillComplete: operation.dispatched }
  }

  function cancelMatching(predicate: (operation: ActiveVideoRequest) => boolean): number {
    let canceled = 0
    for (const operation of active.values()) {
      if (!predicate(operation) || operation.controller.signal.aborted) continue
      operation.controller.abort(new Error('已停止等待视频生成'))
      canceled += 1
    }
    return canceled
  }

  async function resumeUser(userId: number): Promise<GeneratedAiVideoAsset[]> {
    const tasks = await options.tasks.list(userId)
    const results = await Promise.allSettled(tasks.map(async (task) => {
      const key = requestKey(-userId, task.taskId)
      if (active.has(key)) throw new Error('视频任务正在恢复查询')
      const operation: ActiveVideoRequest = {
        senderId: -userId, requestId: task.taskId, userId, taskId: task.taskId,
        controller: new AbortController(), dispatched: true,
      }
      active.set(key, operation)
      try {
        return await finishExisting(task, operation.controller.signal)
      } finally {
        if (active.get(key) === operation) active.delete(key)
      }
    }))
    return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  }

  async function resumeVideoTask(senderId: number, userId: number, taskIdInput: string, expectedProjectId?: string): Promise<GeneratedAiVideoAsset> {
    if (!Number.isSafeInteger(senderId) || senderId <= 0) throw new Error('视频窗口标识格式错误')
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('AI 视频账号标识格式错误')
    const taskId = requiredIdentifier(taskIdInput, '视频任务标识', 256)
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error('视频任务标识格式错误')
    const task = (await options.tasks.list(userId)).find((entry) => (
      entry.userId === userId && entry.taskId === taskId
    ))
    if (!task) throw new Error('当前账号没有可恢复的该视频任务')
    if (expectedProjectId !== undefined && task.projectId !== expectedProjectId) {
      throw new Error('该视频任务不属于当前画布项目')
    }
    const key = requestKey(-userId, taskId)
    if (active.has(key)) throw new Error('视频任务正在恢复查询')
    const operation: ActiveVideoRequest = {
      senderId,
      requestId: taskId,
      userId,
      taskId,
      controller: new AbortController(),
      dispatched: true,
    }
    active.set(key, operation)
    try {
      return await finishExisting(task, operation.controller.signal)
    } finally {
      if (active.get(key) === operation) active.delete(key)
    }
  }

  return {
    generate,
    cancel,
    cancelSender: (senderId: number) => cancelMatching((operation) => operation.senderId === senderId),
    cancelUser: (userId: number) => cancelMatching((operation) => operation.userId === userId),
    cancelAll: () => cancelMatching(() => true),
    resumeUser,
    resumeVideoTask,
  }
}

export type AiVideoService = ReturnType<typeof createAiVideoService>
