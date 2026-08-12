import { AI_CHAT_ENDPOINTS, buildImageGenerationRequest, type ImageQuality } from './ai-chat-protocol'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'

const DEFAULT_TIMEOUT_MS = 320_000
const MAXIMUM_RESPONSE_BYTES = 96 * 1024 * 1024
const MAXIMUM_ERROR_MESSAGE = 300

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
}

export interface AiImageGenerationInput {
  requestId: string
  group: string
  model: string
  prompt: string
  size?: string
  quality?: ImageQuality
}

export interface AiImageCancelResult {
  canceled: boolean
  mayStillComplete: boolean
}

interface ActiveImageRequest {
  senderId: number
  requestId: string
  controller: AbortController
  userId: number
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
}) {
  const baseUrl = new URL(options.baseUrl)
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
    throw new Error('生图服务地址必须使用 HTTPS')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const active = new Map<string, ActiveImageRequest>()

  async function generate(senderId: number, input: AiImageGenerationInput): Promise<GeneratedAiAsset[]> {
    if (!Number.isSafeInteger(senderId) || senderId <= 0) throw new Error('生图窗口标识格式错误')
    const requestId = requiredRequestId(input.requestId)
    const key = requestKey(senderId, requestId)
    if (active.has(key)) throw new Error('该生图请求正在处理中')
    const credential = await options.credentials.resolveCredential(input.group)
    const body = buildImageGenerationRequest(input)
    const controller = new AbortController()
    const operation: ActiveImageRequest = { senderId, requestId, controller, userId: credential.userId }
    active.set(key, operation)
    const timeout = setTimeout(() => controller.abort(new Error('生图请求超时')), timeoutMs)
    try {
      const endpoint = new URL(AI_CHAT_ENDPOINTS.imageGenerations, baseUrl)
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      })
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
        throw new Error(detail || `生图失败，服务返回 ${response.status}`)
      }
      const entries = responseEntries(payload)
      const results: GeneratedAiAsset[] = []
      for (const entry of entries) {
        if (controller.signal.aborted) throw controller.signal.reason
        const metadata = entry.revisedPrompt ? { revisedPrompt: entry.revisedPrompt } : undefined
        results.push(entry.b64Json
          ? await options.assets.storeBase64(credential.userId, entry.b64Json, metadata)
          : await options.assets.storeRemoteUrl(credential.userId, entry.url!, metadata))
      }
      return results
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error && reason.message === '生图请求超时') throw reason
        throw new Error('已停止等待；服务端可能仍在生成图片，请勿立即重复提交')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      if (active.get(key) === operation) active.delete(key)
    }
  }

  function cancel(senderId: number, requestIdInput: string): AiImageCancelResult {
    const requestId = requiredRequestId(requestIdInput)
    const operation = active.get(requestKey(senderId, requestId))
    if (!operation) return { canceled: false, mayStillComplete: false }
    operation.controller.abort(new Error('用户停止生图'))
    return { canceled: true, mayStillComplete: true }
  }

  function cancelSender(senderId: number): void {
    for (const operation of active.values()) {
      if (operation.senderId === senderId) operation.controller.abort(new Error('窗口已关闭'))
    }
  }

  return { generate, cancel, cancelSender }
}

export type AiImageService = ReturnType<typeof createAiImageService>

