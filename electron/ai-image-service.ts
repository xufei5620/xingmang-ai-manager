import { AI_CHAT_ENDPOINTS, buildImageGenerationRequest, type ImageQuality } from './ai-chat-protocol'
import {
  BoundedOperationQueue,
  type BoundedOperationHandle,
} from './bounded-operation-queue'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'

const DEFAULT_TIMEOUT_MS = 320_000
const DEFAULT_MAX_ACTIVE = 2
const DEFAULT_MAX_QUEUED = 64
const MAXIMUM_RESPONSE_BYTES = 96 * 1024 * 1024
const MAXIMUM_ERROR_MESSAGE = 300
const MAXIMUM_EDIT_SOURCE_BYTES = 64 * 1024 * 1024
const MAXIMUM_EDIT_SOURCE_IMAGES = 4
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface GeneratedAiAsset {
  assetId: string
  localUrl: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width?: number
  height?: number
  fileName: string
  revisedPrompt?: string
}

export interface AiImageAssetWriter {
  storeBase64(userId: number, value: string, metadata?: { revisedPrompt?: string }): Promise<GeneratedAiAsset>
  storeRemoteUrl(userId: number, url: string, metadata?: { revisedPrompt?: string }): Promise<GeneratedAiAsset>
  readOwned(userId: number, assetId: string): Promise<{ asset: GeneratedAiAsset; bytes: Buffer }>
}

export interface AiImageGenerationInput {
  requestId: string
  group: string
  model: string
  prompt: string
  size?: string
  quality?: ImageQuality
}

export interface AiImageEditInput extends AiImageGenerationInput {
  sourceAssetIds: string[]
  expectedUserId?: number
}

export interface AiImageCancelResult {
  canceled: boolean
  mayStillComplete: boolean
}

interface ActiveImageRequest {
  senderId: number
  requestId: string
  handle: BoundedOperationHandle<GeneratedAiAsset[]>
  userId?: number
  dispatched: boolean
  cancelReason?: 'user' | 'sender' | 'account' | 'application' | 'timeout' | 'shutdown'
}

function requestKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

function requiredRequestId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160 || /[\x00-\x1F\x7F]/.test(normalized)) {
    throw new Error('生图请求标识格式错误')
  }
  return normalized
}

function requiredSourceAssetIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_EDIT_SOURCE_IMAGES) {
    throw new Error(`图片编辑需要 1-${MAXIMUM_EDIT_SOURCE_IMAGES} 张参考图片`)
  }
  if (value.some((assetId) => typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId))) {
    throw new Error('图片编辑参考资产标识格式错误')
  }
  if (new Set(value).size !== value.length) throw new Error('图片编辑参考资产不能重复')
  return [...value]
}

function safeUpstreamMessage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[远程地址]')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
  return redacted.slice(0, MAXIMUM_ERROR_MESSAGE)
}

function imageRequestFailure(status: number, detail: string): Error {
  const normalized = detail.toLowerCase()
  if (status === 400 && normalized.includes('size')) {
    return new Error('当前模型不支持这个图片尺寸，请更换尺寸后重试')
  }
  if (status === 400 && normalized.includes('quality')) {
    return new Error('当前模型不支持这个画质档位，请更换画质后重试')
  }
  if (status === 401) return new Error('生图 API Key 已失效，请重新创建或更换密钥')
  if (status === 403 && /insufficient|quota|额度不足/.test(normalized)) {
    return new Error('账号余额或 API Key 额度不足，请充值后重试')
  }
  if (status === 403 && /access to model|permission|forbidden|无权限/.test(normalized)) {
    return new Error('当前账号暂无该生图模型权限，请切换其他模型')
  }
  if (status === 429) return new Error('生图服务繁忙或上游限流，请稍后重试')
  if (status >= 500) return new Error('生图服务暂时不可用，请稍后重试')
  return new Error(detail || `生图失败，服务返回 ${status}`)
}

async function readBoundedResponseBytes(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('生图响应超过安全上限')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      received += chunk.value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('生图响应超过安全上限')
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, received)
}

function responseEntries(payload: unknown): Array<{
  url?: string
  b64Json?: string
  revisedPrompt?: string
}> {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error('生图接口返回数据不完整')
  }
  const results = (payload as { data: unknown[] }).data.slice(0, 8).flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const entry = value as Record<string, unknown>
    const url = typeof entry.url === 'string' && entry.url.length <= 8_192 ? entry.url : undefined
    const b64Json = typeof entry.b64_json === 'string' && entry.b64_json.length <= 128 * 1024 * 1024
      ? entry.b64_json
      : undefined
    if (!url && !b64Json) return []
    const revisedPrompt = typeof entry.revised_prompt === 'string'
      ? entry.revised_prompt.slice(0, 40_000)
      : undefined
    return [{ url, b64Json, revisedPrompt }]
  })
  if (results.length === 0) throw new Error('生图接口没有返回图片')
  return results
}

export function createAiImageService(options: {
  baseUrl: string
  credentials: Pick<ChatCredentialCoordinator, 'resolveCredential'>
  assets: AiImageAssetWriter
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxActive?: number
  maxQueued?: number
}) {
  const baseUrl = new URL(options.baseUrl)
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
    throw new Error('生图服务地址必须使用 HTTPS')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const active = new Map<string, ActiveImageRequest>()
  const queue = new BoundedOperationQueue({
    maxActive: options.maxActive ?? DEFAULT_MAX_ACTIVE,
    maxQueued: options.maxQueued ?? DEFAULT_MAX_QUEUED,
  })

  async function runImageOperation(
    senderId: number,
    input: AiImageGenerationInput,
    request: (
      credential: Awaited<ReturnType<ChatCredentialCoordinator['resolveCredential']>>,
      signal: AbortSignal,
      markDispatched: () => void,
    ) => Promise<Response>,
  ): Promise<GeneratedAiAsset[]> {
    if (!Number.isSafeInteger(senderId) || senderId <= 0) throw new Error('生图窗口标识格式错误')
    const requestId = requiredRequestId(input.requestId)
    const key = requestKey(senderId, requestId)
    if (active.has(key)) throw new Error('该生图请求正在处理中')
    const operation = { senderId, requestId, dispatched: false } as ActiveImageRequest
    const handle = queue.enqueue(async (signal) => {
      const timeout = setTimeout(() => {
        operation.cancelReason = 'timeout'
        operation.handle.cancel(new Error('生图请求超时'))
      }, timeoutMs)
      try {
        const credential = await options.credentials.resolveCredential(input.group)
        operation.userId = credential.userId
        if (signal.aborted) throw signal.reason
        const response = await request(credential, signal, () => { operation.dispatched = true })
        const bytes = await readBoundedResponseBytes(response, MAXIMUM_RESPONSE_BYTES)
        let payload: unknown
        try {
          payload = JSON.parse(bytes.toString('utf8')) as unknown
        } catch {
          throw new Error('生图接口返回的不是有效 JSON')
        }
        if (!response.ok) {
          const error = payload && typeof payload === 'object'
            ? (payload as { error?: { message?: unknown }; message?: unknown })
            : {}
          const detail = safeUpstreamMessage(error.error?.message ?? error.message)
          throw imageRequestFailure(response.status, detail)
        }
        const entries = responseEntries(payload)
        const results: GeneratedAiAsset[] = []
        for (const entry of entries) {
          if (signal.aborted) throw signal.reason
          const metadata = entry.revisedPrompt ? { revisedPrompt: entry.revisedPrompt } : undefined
          results.push(entry.b64Json
            ? await options.assets.storeBase64(credential.userId, entry.b64Json, metadata)
            : await options.assets.storeRemoteUrl(credential.userId, entry.url!, metadata))
        }
        return results
      } finally {
        clearTimeout(timeout)
      }
    })
    operation.handle = handle
    active.set(key, operation)
    try {
      return await handle.promise
    } catch (error) {
      if (operation.cancelReason) {
        if (operation.cancelReason === 'timeout') throw new Error('生图请求超时')
        if (operation.dispatched) {
          throw new Error('已停止等待；服务端可能仍在生成图片，请勿立即重复提交')
        }
        throw new Error('已取消生图请求')
      }
      if (error instanceof Error && error.message === '操作队列已关闭') {
        throw new Error('已停止等待；服务端可能仍在生成图片，请勿立即重复提交')
      }
      throw error
    } finally {
      if (active.get(key) === operation) active.delete(key)
    }
  }

  async function generate(senderId: number, input: AiImageGenerationInput): Promise<GeneratedAiAsset[]> {
    const body = buildImageGenerationRequest(input)
    return runImageOperation(senderId, input, (credential, signal, markDispatched) => {
      markDispatched()
      return fetchImpl(new URL(AI_CHAT_ENDPOINTS.imageGenerations, baseUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      })
    })
  }

  async function edit(senderId: number, input: AiImageEditInput): Promise<GeneratedAiAsset[]> {
    const fields = buildImageGenerationRequest(input)
    const sourceAssetIds = requiredSourceAssetIds(input.sourceAssetIds)
    return runImageOperation(senderId, input, async (credential, signal, markDispatched) => {
      if (input.expectedUserId !== undefined && credential.userId !== input.expectedUserId) {
        throw new Error('登录账号已变化，请重新运行图片编辑')
      }
      const form = new FormData()
      let sourceBytes = 0
      for (const assetId of sourceAssetIds) {
        const source = await options.assets.readOwned(credential.userId, assetId)
        sourceBytes += source.bytes.byteLength
        if (sourceBytes > MAXIMUM_EDIT_SOURCE_BYTES) throw new Error('图片编辑参考图总大小超过 64 MB 安全上限')
        if (signal.aborted) throw signal.reason
        form.append('image', new File(
          [Uint8Array.from(source.bytes)],
          source.asset.fileName,
          { type: source.asset.mimeType },
        ))
      }
      form.set('model', fields.model)
      form.set('prompt', fields.prompt)
      form.set('n', String(fields.n))
      if (fields.size) form.set('size', fields.size)
      if (fields.quality) form.set('quality', fields.quality)
      markDispatched()
      return fetchImpl(new URL(AI_CHAT_ENDPOINTS.imageEdits, baseUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.apiKey}`,
        },
        body: form,
        redirect: 'error',
        signal,
      })
    })
  }

  function cancelOperation(
    operation: ActiveImageRequest,
    reason: NonNullable<ActiveImageRequest['cancelReason']>,
    message: string,
  ): AiImageCancelResult {
    if (operation.handle.state() === 'settled') return { canceled: false, mayStillComplete: false }
    operation.cancelReason = reason
    const result = operation.handle.cancel(new Error(message))
    if (!result.canceled) operation.cancelReason = undefined
    return { canceled: result.canceled, mayStillComplete: result.canceled && operation.dispatched }
  }

  function cancel(senderId: number, requestIdInput: string): AiImageCancelResult {
    const requestId = requiredRequestId(requestIdInput)
    const operation = active.get(requestKey(senderId, requestId))
    if (!operation) return { canceled: false, mayStillComplete: false }
    return cancelOperation(operation, 'user', '用户停止生图')
  }

  function cancelSender(senderId: number): number {
    let canceled = 0
    for (const operation of active.values()) {
      if (operation.senderId !== senderId) continue
      if (cancelOperation(operation, 'sender', '窗口已关闭').canceled) canceled += 1
    }
    return canceled
  }

  function cancelUser(userId: number): number {
    let canceled = 0
    for (const operation of active.values()) {
      if (operation.userId !== userId) continue
      if (cancelOperation(operation, 'account', '账号已切换').canceled) canceled += 1
    }
    return canceled
  }

  function cancelAll(): number {
    let canceled = 0
    for (const operation of active.values()) {
      if (cancelOperation(operation, 'application', '应用正在退出').canceled) canceled += 1
    }
    return canceled
  }

  function shutdown(): number {
    for (const operation of active.values()) operation.cancelReason = 'shutdown'
    return queue.shutdown(new Error('操作队列已关闭'))
  }

  return { generate, edit, cancel, cancelSender, cancelUser, cancelAll, shutdown }
}

export type AiImageService = ReturnType<typeof createAiImageService>
