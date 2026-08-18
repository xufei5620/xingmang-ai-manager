import {
  AI_CHAT_ENDPOINTS,
  buildVideoGenerationRequest,
  resolveAiModelCapability,
  type MiniMaxVideoAspectRatio,
  type MiniMaxVideoMode,
  type MiniMaxVideoResolution,
} from './ai-chat-protocol'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'
import type { AiStoredVideoAsset } from './ai-video-asset-store'
import type { AiVideoTaskStore, StoredAiVideoTask } from './ai-video-task-store'
import type { AiOperationProgressObserver, AiOperationProgressUpdate } from './ai-operation-progress'

const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_MAXIMUM_POLL_INTERVAL_MS = 10_000
const DEFAULT_MAXIMUM_WAIT_MS = 30 * 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const MAXIMUM_JSON_BYTES = 2 * 1024 * 1024
const MAXIMUM_VIDEO_BYTES = 512 * 1024 * 1024
const MAXIMUM_MINIMAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAXIMUM_MINIMAX_VIDEO_BYTES = 100 * 1024 * 1024
const MAXIMUM_MINIMAX_AUDIO_BYTES = 50 * 1024 * 1024
const MAXIMUM_MINIMAX_MEDIA_BYTES = 120 * 1024 * 1024
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
  imageAssetIds?: string[]
  videoAssetIds?: string[]
  audioAssetIds?: string[]
  width?: number
  height?: number
  mode?: MiniMaxVideoMode
  resolution?: MiniMaxVideoResolution
  aspectRatio?: MiniMaxVideoAspectRatio
  promptOptimization?: boolean
  expectedUserId?: number
  projectId?: string
  runId?: string
  nodeId?: string
  attemptId?: string
  graphRevision?: string
}

export interface GeneratedAiVideoAsset extends AiStoredVideoAsset {
  taskId: string
}

export interface AiVideoAssetWriter {
  prepareProject?(userId: number, projectId?: string): Promise<void>
  storeMp4(userId: number, bytes: Buffer, metadata: { taskId: string; projectId?: string }): Promise<AiStoredVideoAsset>
  readImageDataUri(userId: number, assetId: string, projectId?: string): Promise<string>
  readOwned?(
    userId: number,
    assetId: string,
    kind: 'image' | 'video' | 'audio',
    projectId?: string,
  ): Promise<{ asset: { mimeType?: string; fileName?: string }; bytes: Buffer }>
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
  apiKey?: string
  provider?: 'grok-video' | 'minimax-h3'
  dispatched: boolean
}

interface MiniMaxMediaPart {
  field: 'images' | 'videos' | 'audios'
  bytes: Buffer
  mimeType: string
  fileName: string
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

function videoRequestFailure(
  status: number,
  detail: string,
  retryAfter?: string | null,
  provider?: ActiveVideoRequest['provider'],
): Error {
  if (provider === 'minimax-h3' && /invalid\s+url\s*\(\s*post\b.*(?:video_generation|\[本地路径\])/i.test(detail)) {
    return new Error('MiniMax 视频渠道协议配置错误：当前渠道仍在使用旧 Hailuo 接口，请管理员改为 Sora/OpenAI Video 透传后重试；本次未创建任务')
  }
  if (status === 401) return new Error('视频 API Key 已失效，请重新创建或更换密钥')
  if (status === 403 && /insufficient|quota|额度不足/i.test(detail)) return new Error('账号余额或 API Key 额度不足，请充值后重试')
  if (status === 403) return new Error('当前账号暂无该视频模型权限，请切换其他模型')
  if (status === 413) return new Error('视频参考素材超过接口大小限制，请压缩或减少素材后重试')
  if (status === 422) return new Error(detail ? `视频参数或参考素材不合法：${detail}` : '视频参数或参考素材不合法，请检查生成模式和素材数量')
  if (status === 429) {
    const wait = retryAfter && /^\d{1,6}$/.test(retryAfter) ? `，请等待 ${retryAfter} 秒` : ''
    return new Error(`视频并发已满或资源正在冷却${wait}后重试`)
  }
  if (status >= 500) return new Error('视频服务暂时不可用，请稍后重试')
  return new Error(detail || `视频请求失败，服务返回 ${status}`)
}

function miniMaxProgress(payload: Record<string, unknown>): AiOperationProgressUpdate | null {
  const detail = payload.progress_detail && typeof payload.progress_detail === 'object' && !Array.isArray(payload.progress_detail)
    ? payload.progress_detail as Record<string, unknown>
    : undefined
  const value = typeof payload.progress === 'number' && Number.isFinite(payload.progress)
    ? Math.max(0, Math.min(100, payload.progress))
    : undefined
  const mode = detail?.mode === 'determinate' || detail?.mode === 'indeterminate' ? detail.mode : undefined
  const health = detail?.health === 'delayed' ? 'delayed' as const : detail?.health === 'normal' ? 'normal' as const : undefined
  if (value === undefined && mode === undefined && health === undefined) return null
  return {
    ...(value === undefined ? {} : { value }),
    ...(mode === undefined ? {} : { mode }),
    ...(health === undefined ? {} : { health }),
  }
}

function mediaFileName(kind: 'image' | 'video' | 'audio', index: number, mimeType: string): string {
  const extensionByMime: Readonly<Record<string, string>> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  }
  const extension = extensionByMime[mimeType]
  if (!extension) throw new Error(`MiniMax 不支持该${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}格式`)
  return `${kind}-${index + 1}.${extension}`
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

function upstreamMessage(value: unknown, depth = 0): unknown {
  if (depth > 4) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return upstreamMessage(record.error ?? record.message, depth + 1)
  }
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 4_096 || !trimmed.startsWith('{')) return value
  try {
    return upstreamMessage(JSON.parse(trimmed), depth + 1)
  } catch {
    return value
  }
}

function errorDetail(payload: Record<string, unknown>): string {
  return safeUpstreamMessage(upstreamMessage(payload))
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

  async function readMiniMaxMedia(
    userId: number,
    projectId: string | undefined,
    references: {
      images: readonly string[]
      videos: readonly string[]
      audios: readonly string[]
    },
  ): Promise<MiniMaxMediaPart[]> {
    if (!options.assets.readOwned) throw new Error('当前版本缺少 MiniMax 本地素材读取能力')
    const descriptors = [
      ...references.images.map((assetId) => ({ assetId, kind: 'image' as const, field: 'images' as const, maximum: MAXIMUM_MINIMAX_IMAGE_BYTES })),
      ...references.videos.map((assetId) => ({ assetId, kind: 'video' as const, field: 'videos' as const, maximum: MAXIMUM_MINIMAX_VIDEO_BYTES })),
      ...references.audios.map((assetId) => ({ assetId, kind: 'audio' as const, field: 'audios' as const, maximum: MAXIMUM_MINIMAX_AUDIO_BYTES })),
    ]
    const allIds = descriptors.map((entry) => entry.assetId)
    if (allIds.some((assetId) => !ASSET_ID_PATTERN.test(assetId))) throw new Error('MiniMax 参考素材资产标识格式错误')
    if (new Set(allIds).size !== allIds.length) throw new Error('MiniMax 参考素材不能重复')
    let totalBytes = 0
    const counts = { image: 0, video: 0, audio: 0 }
    const parts: MiniMaxMediaPart[] = []
    for (const descriptor of descriptors) {
      const owned = await options.assets.readOwned(userId, descriptor.assetId, descriptor.kind, projectId)
      if (!Buffer.isBuffer(owned.bytes) || owned.bytes.byteLength === 0) throw new Error('MiniMax 参考素材为空')
      if (owned.bytes.byteLength > descriptor.maximum) {
        const label = descriptor.kind === 'image' ? '图片' : descriptor.kind === 'video' ? '视频' : '音频'
        throw new Error(`MiniMax 单个参考${label}超过接口大小限制`)
      }
      totalBytes += owned.bytes.byteLength
      if (totalBytes > MAXIMUM_MINIMAX_MEDIA_BYTES) throw new Error('MiniMax 参考素材合计超过 120 MiB 限制')
      const mimeType = typeof owned.asset.mimeType === 'string' ? owned.asset.mimeType.toLowerCase() : ''
      const index = counts[descriptor.kind]++
      parts.push({
        field: descriptor.field,
        bytes: owned.bytes,
        mimeType,
        fileName: mediaFileName(descriptor.kind, index, mimeType),
      })
    }
    return parts
  }

  function miniMaxMultipart(
    body: ReturnType<typeof buildVideoGenerationRequest>,
    parts: readonly MiniMaxMediaPart[],
  ): FormData {
    if (!('mode' in body)) throw new Error('MiniMax 请求参数格式错误')
    const form = new FormData()
    form.set('model', body.model)
    form.set('mode', body.mode)
    form.set('resolution', body.resolution)
    form.set('prompt', body.prompt)
    form.set('seconds', body.seconds)
    form.set('aspect_ratio', body.aspect_ratio)
    form.set('prompt_optimization', String(body.prompt_optimization))
    for (const part of parts) {
      form.append(part.field, new Blob([part.bytes], { type: part.mimeType }), part.fileName)
    }
    return form
  }

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
    if (!response.ok) throw videoRequestFailure(response.status, errorDetail(payload), response.headers.get('retry-after'))
    return payload
  }

  async function pollTask(
    task: StoredAiVideoTask,
    apiKey: string,
    signal: AbortSignal,
    progress?: AiOperationProgressObserver,
  ): Promise<void> {
    const startedAt = Date.now()
    let interval = pollIntervalMs
    for (;;) {
      if (Date.now() - startedAt > maximumWaitMs) throw new Error('已停止等待视频生成；服务端任务已保留，可在下次启动时继续查询')
      const payload = await authorizedJson(`${AI_CHAT_ENDPOINTS.videos}/${encodeURIComponent(task.taskId)}`, apiKey, signal)
      if (requiredTaskId(payload.id) !== task.taskId) throw new Error('视频任务状态与请求不匹配')
      const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : ''
      const update = miniMaxProgress(payload)
      if (update) await progress?.onProgress?.(update)
      if (status === 'completed') return
      if (status === 'failed' || status === 'cancelled') {
        const message = safeUpstreamMessage(
          payload.error && typeof payload.error === 'object' ? (payload.error as Record<string, unknown>).message : undefined,
        ) || (status === 'cancelled' ? '视频任务已取消' : '视频生成失败')
        await options.tasks.remove(task.userId, task.taskId).catch(() => undefined)
        throw new Error(message)
      }
      if (!['queued', 'in_progress', 'processing', 'submitted'].includes(status)) throw new Error('视频接口返回了未知任务状态')
      await delayVideoPoll(interval, signal)
      interval = Math.min(maximumPollIntervalMs, interval * 2)
    }
  }

  async function downloadTask(
    task: StoredAiVideoTask,
    apiKey: string,
    signal: AbortSignal,
    progress?: AiOperationProgressObserver,
  ): Promise<GeneratedAiVideoAsset> {
    await progress?.onStage('downloading')
    const response = await fetchWithTimeout(
      new URL(`${AI_CHAT_ENDPOINTS.videos}/${encodeURIComponent(task.taskId)}/content`, baseUrl),
      { method: 'GET', headers: { Accept: 'video/mp4', Authorization: `Bearer ${apiKey}` } },
      signal,
    )
    if (!response.ok) {
      const payload = await responseJson(response).catch(() => ({}))
      throw videoRequestFailure(response.status, errorDetail(payload), response.headers.get('retry-after'))
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    if (contentType && contentType !== 'video/mp4' && contentType !== 'application/octet-stream') {
      throw new Error('视频下载响应类型不受支持')
    }
    const bytes = await readBoundedBytes(response, MAXIMUM_VIDEO_BYTES, '视频文件')
    await progress?.onStage('saving')
    const asset = await options.assets.storeMp4(
      task.userId,
      bytes,
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

  async function generate(
    senderId: number,
    input: AiVideoGenerationInput,
    progress?: AiOperationProgressObserver,
  ): Promise<GeneratedAiVideoAsset> {
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
      const capability = resolveAiModelCapability(input.model)
      if (capability.kind !== 'video') throw new Error('当前模型不是可用的视频模型')
      operation.apiKey = credential.apiKey
      operation.provider = capability.provider
      await options.assets.prepareProject?.(credential.userId, input.projectId)
      const imageAssetIds = [
        ...(input.imageAssetId ? [input.imageAssetId] : []),
        ...(input.imageAssetIds ?? []),
      ]
      const videoAssetIds = input.videoAssetIds ?? []
      const audioAssetIds = input.audioAssetIds ?? []
      let image: string | undefined
      if (capability.provider === 'grok-video' && imageAssetIds[0] !== undefined) {
        if (!ASSET_ID_PATTERN.test(imageAssetIds[0])) throw new Error('视频参考图片资产标识格式错误')
        image = input.projectId
          ? await options.assets.readImageDataUri(credential.userId, imageAssetIds[0], input.projectId)
          : await options.assets.readImageDataUri(credential.userId, imageAssetIds[0])
      }
      const body = buildVideoGenerationRequest({
        model: input.model, prompt: input.prompt, seconds: input.seconds,
        ...(image ? { image } : {}),
        ...(input.width !== undefined ? { width: input.width, height: input.height } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.promptOptimization !== undefined ? { promptOptimization: input.promptOptimization } : {}),
        imageCount: imageAssetIds.length,
        videoCount: videoAssetIds.length,
        audioCount: audioAssetIds.length,
      })
      const mediaParts = capability.provider === 'minimax-h3'
        ? await readMiniMaxMedia(credential.userId, input.projectId, {
          images: imageAssetIds,
          videos: videoAssetIds,
          audios: audioAssetIds,
        })
        : []
      const requestBody: BodyInit = mediaParts.length > 0 ? miniMaxMultipart(body, mediaParts) : JSON.stringify(body)
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason
      reservationId = await options.tasks.reserve(credential.userId)
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason
      operation.dispatched = true
      let response: Response
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.apiKey}`,
          ...(typeof requestBody === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(capability.provider === 'minimax-h3' ? { 'Idempotency-Key': requestId } : {}),
        }
        response = await fetchWithTimeout(new URL(AI_CHAT_ENDPOINTS.videos, baseUrl), {
          method: 'POST',
          headers,
          body: requestBody,
        }, operation.controller.signal)
      } catch (error) {
        if (operation.controller.signal.aborted) throw error
        throw ambiguousVideoSubmission()
      }
      let payload: Record<string, unknown>
      try {
        payload = await responseJson(response)
      } catch {
        if (!response.ok && response.status < 500) {
          throw videoRequestFailure(response.status, '', response.headers.get('retry-after'))
        }
        throw ambiguousVideoSubmission()
      }
      if (!response.ok) {
        if (response.status >= 500) throw ambiguousVideoSubmission()
        throw videoRequestFailure(response.status, errorDetail(payload), response.headers.get('retry-after'), capability.provider)
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
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.graphRevision ? { graphRevision: input.graphRevision } : {}),
      }
      try {
        await options.tasks.commitReservation(reservationId, task)
        reservationId = undefined
        operation.taskId = task.taskId
      } catch {
        throw new Error(`视频任务已创建但本地恢复记录保存失败（任务 ${task.taskId}），请勿重复提交`)
      }
      await progress?.onStage('processing')
      await pollTask(task, credential.apiKey, operation.controller.signal, progress)
      return await downloadTask(task, credential.apiKey, operation.controller.signal, progress)
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

  async function cancelRemoteTask(operation: ActiveVideoRequest): Promise<void> {
    if (operation.provider !== 'minimax-h3' || !operation.taskId || !operation.apiKey) return
    const controller = new AbortController()
    await authorizedJson(
      `${AI_CHAT_ENDPOINTS.videos}/${encodeURIComponent(operation.taskId)}/cancel`,
      operation.apiKey,
      controller.signal,
      { method: 'POST' },
    )
  }

  function cancel(senderId: number, requestIdInput: string): AiVideoCancelResult {
    const requestId = requiredIdentifier(requestIdInput, '视频请求标识', 160)
    const operation = active.get(requestKey(senderId, requestId))
    if (!operation || operation.controller.signal.aborted) return { canceled: false, mayStillComplete: false }
    void cancelRemoteTask(operation).catch(() => undefined)
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
