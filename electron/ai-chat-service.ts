import {
  AI_CHAT_ENDPOINTS,
  buildChatCompletionsRequest,
  type AiChatMessage,
  type AiChatParameters,
  type ChatCompletionsRequestBody,
} from './ai-chat-protocol'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'

export const AI_CHAT_STREAM_LIMITS = {
  requestIdLength: 160,
  connectionTimeoutMs: 15_000,
  idleTimeoutMs: 45_000,
  totalTimeoutMs: 300_000,
  batchIntervalMs: 50,
  eventBytes: 256 * 1024,
  fragmentBytes: 64 * 1024,
  outputBytes: 2 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  errorBytes: 16 * 1024,
  concurrentRequests: 32,
  concurrentRequestsPerSender: 4,
} as const

export type AiChatStreamLimits = {
  [Key in keyof typeof AI_CHAT_STREAM_LIMITS]: number
}

export type AiChatStreamErrorCode =
  | 'credential-error'
  | 'connection-timeout'
  | 'idle-timeout'
  | 'total-timeout'
  | 'network-error'
  | 'upstream-http-error'
  | 'invalid-stream-response'
  | 'stream-closed'
  | 'response-limit-exceeded'
  | 'event-limit-exceeded'
  | 'fragment-limit-exceeded'
  | 'output-limit-exceeded'

export type AiChatStreamEvent =
  | {
      type: 'delta'
      requestId: string
      sequence: number
      content?: string
      reasoning?: string
    }
  | {
      type: 'complete'
      requestId: string
      sequence: number
      durationMs: number
      receivedBytes: number
      outputBytes: number
    }
  | {
      type: 'error'
      requestId: string
      sequence: number
      code: AiChatStreamErrorCode
      message: string
    }
  | {
      type: 'canceled'
      requestId: string
      sequence: number
    }

export type AiChatStreamLogEntry = {
  requestId: string
  status: 'complete' | 'error' | 'canceled' | 'sender-gone'
  durationMs: number
  receivedBytes: number
  outputBytes: number
}

export type StartAiChatStreamInput = {
  senderId: number
  requestId: string
  group: string
  model: string
  messages: readonly AiChatMessage[]
  parameters?: AiChatParameters
}

export type StartAiChatStreamResult = {
  accepted: true
  requestId: string
}

export interface AiChatServiceClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface AiChatService {
  start(input: StartAiChatStreamInput): StartAiChatStreamResult
  cancel(senderId: number, requestId: string): boolean
  cancelSender(senderId: number): number
  cancelUser(userId: number): number
  cancelAll(): number
  activeCount(): number
  whenIdle(): Promise<void>
  dispose(): void
}

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>

export type AiChatServiceOptions = {
  credentialCoordinator: Pick<ChatCredentialCoordinator, 'resolveCredential'>
  emit(senderId: number, event: AiChatStreamEvent): void
  fetchImpl?: FetchImplementation
  baseUrl?: string
  clock?: AiChatServiceClock
  log?: (entry: AiChatStreamLogEntry) => void
  limits?: Partial<AiChatStreamLimits>
}

type ResolvedLimits = AiChatStreamLimits

type TerminalStatus = AiChatStreamLogEntry['status']

type ActiveRequest = {
  key: string
  senderId: number
  requestId: string
  userId: number | null
  body: ChatCompletionsRequestBody
  group: string
  controller: AbortController
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  startedAt: number
  receivedBytes: number
  outputBytes: number
  sequence: number
  pendingContent: string
  pendingReasoning: string
  completed: boolean
  connectionTimer: unknown | null
  idleTimer: unknown | null
  totalTimer: unknown | null
  batchTimer: unknown | null
}

class StreamFailure extends Error {
  readonly code: AiChatStreamErrorCode

  constructor(code: AiChatStreamErrorCode, message: string) {
    super(message)
    this.name = 'StreamFailure'
    this.code = code
  }
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const SAFE_ERROR_MESSAGES: Record<AiChatStreamErrorCode, string> = {
  'credential-error': '无法准备所选分组，请检查登录状态和 API Key',
  'connection-timeout': '连接 AI 服务超时，请检查网络后重试',
  'idle-timeout': 'AI 服务长时间没有返回内容，已停止等待',
  'total-timeout': '本次对话超过最长处理时间，已停止等待',
  'network-error': '无法连接 AI 服务，请检查网络后重试',
  'upstream-http-error': 'AI 服务暂时无法完成请求',
  'invalid-stream-response': 'AI 服务返回了无法识别的数据',
  'stream-closed': 'AI 服务连接提前关闭，请重试',
  'response-limit-exceeded': 'AI 服务返回的数据超过安全上限',
  'event-limit-exceeded': 'AI 服务单个事件超过安全上限',
  'fragment-limit-exceeded': 'AI 服务单次输出超过安全上限',
  'output-limit-exceeded': 'AI 服务累计输出超过安全上限',
}

function defaultClock(): AiChatServiceClock {
  return {
    now: () => Date.now(),
    setTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs)
      timer.unref?.()
      return timer
    },
    clearTimeout(handle) {
      clearTimeout(handle as NodeJS.Timeout)
    },
  }
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label}必须是正整数`)
  return value
}

function resolveLimits(overrides: Partial<AiChatStreamLimits> = {}): ResolvedLimits {
  const resolved = { ...AI_CHAT_STREAM_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(resolved)) requirePositiveSafeInteger(value, name)
  if (resolved.fragmentBytes > resolved.eventBytes) {
    throw new TypeError('fragmentBytes不能大于eventBytes')
  }
  return resolved
}

function validateBaseUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('AI 服务地址格式错误')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new TypeError('AI 服务地址必须是不含凭据的 HTTPS 地址')
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed
}

function requireSenderId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('AI聊天发送方标识格式错误')
  return value
}

function requireRequestId(value: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError('AI聊天请求标识格式错误')
  const normalized = value.trim()
  if (!normalized || normalized.length > maximumLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new TypeError('AI聊天请求标识格式错误')
  }
  return normalized
}

function operationKey(senderId: number, requestId: string): string {
  return `${senderId}\u0000${requestId}`
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function responseOriginIsTrusted(response: Response, expectedOrigin: string): boolean {
  if (!response.url) return true
  try {
    return new URL(response.url).origin === expectedOrigin
  } catch {
    return false
  }
}

async function discardBoundedErrorBody(
  response: Response,
  maximumBytes: number,
): Promise<void> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  if (!response.body) return
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value?.byteLength ?? 0
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function safeHttpFailure(status: number): StreamFailure {
  if (status === 401 || status === 403) {
    return new StreamFailure('upstream-http-error', '当前 API Key 无权使用所选模型或分组')
  }
  if (status === 429) {
    return new StreamFailure('upstream-http-error', '请求过于频繁或账户额度不足，请稍后重试')
  }
  return new StreamFailure('upstream-http-error', SAFE_ERROR_MESSAGES['upstream-http-error'])
}

function findFrameDelimiter(value: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value)
  return match ? { index: match.index, length: match[0].length } : null
}

function eventData(frame: string): string | null {
  const data: string[] = []
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line.startsWith('data:')) continue
    const value = line.slice(5)
    data.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  return data.length > 0 ? data.join('\n') : null
}

class BoundedSseParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private buffer = ''

  constructor(private readonly maximumEventBytes: number) {}

  push(chunk: Uint8Array): string[] {
    let decoded: string
    try {
      decoded = this.decoder.decode(chunk, { stream: true })
    } catch {
      throw new StreamFailure('invalid-stream-response', SAFE_ERROR_MESSAGES['invalid-stream-response'])
    }
    this.buffer += decoded
    return this.drain(false)
  }

  finish(): string[] {
    try {
      this.buffer += this.decoder.decode()
    } catch {
      throw new StreamFailure('invalid-stream-response', SAFE_ERROR_MESSAGES['invalid-stream-response'])
    }
    return this.drain(true)
  }

  private drain(includeTrailingFrame: boolean): string[] {
    const result: string[] = []
    for (;;) {
      const delimiter = findFrameDelimiter(this.buffer)
      if (!delimiter) break
      const frame = this.buffer.slice(0, delimiter.index)
      this.buffer = this.buffer.slice(delimiter.index + delimiter.length)
      this.assertEventBound(frame)
      const data = eventData(frame)
      if (data !== null) result.push(data)
    }
    if (includeTrailingFrame && this.buffer) {
      const frame = this.buffer
      this.buffer = ''
      this.assertEventBound(frame)
      const data = eventData(frame)
      if (data !== null) result.push(data)
    } else if (byteLength(this.buffer) > this.maximumEventBytes) {
      throw new StreamFailure('event-limit-exceeded', SAFE_ERROR_MESSAGES['event-limit-exceeded'])
    }
    return result
  }

  private assertEventBound(frame: string): void {
    if (byteLength(frame) > this.maximumEventBytes) {
      throw new StreamFailure('event-limit-exceeded', SAFE_ERROR_MESSAGES['event-limit-exceeded'])
    }
  }
}

function parsedDelta(data: string): { content: string; reasoning: string } {
  if (byteLength(data) === 0) return { content: '', reasoning: '' }
  let payload: unknown
  try {
    payload = JSON.parse(data) as unknown
  } catch {
    throw new StreamFailure('invalid-stream-response', SAFE_ERROR_MESSAGES['invalid-stream-response'])
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new StreamFailure('invalid-stream-response', SAFE_ERROR_MESSAGES['invalid-stream-response'])
  }
  const record = payload as Record<string, unknown>
  if (record.error !== undefined || record.type === 'error' || record.type === 'upstream_error') {
    throw new StreamFailure('upstream-http-error', SAFE_ERROR_MESSAGES['upstream-http-error'])
  }
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) return { content: '', reasoning: '' }
  const first = choices[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return { content: '', reasoning: '' }
  const delta = (first as Record<string, unknown>).delta
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return { content: '', reasoning: '' }
  const fields = delta as Record<string, unknown>
  return {
    content: typeof fields.content === 'string' ? fields.content : '',
    reasoning: typeof fields.reasoning_content === 'string'
      ? fields.reasoning_content
      : (typeof fields.reasoning === 'string' ? fields.reasoning : ''),
  }
}

export function createAiChatService(options: AiChatServiceOptions): AiChatService {
  const fetchImpl = options.fetchImpl ?? fetch
  const clock = options.clock ?? defaultClock()
  const limits = resolveLimits(options.limits)
  const baseUrl = validateBaseUrl(options.baseUrl ?? 'https://xm.solov.cc')
  const endpoint = new URL(AI_CHAT_ENDPOINTS.chatCompletions.replace(/^\//, ''), baseUrl)
  const active = new Map<string, ActiveRequest>()
  const idleWaiters = new Set<() => void>()
  let disposed = false

  function clearTimer(request: ActiveRequest, name: 'connectionTimer' | 'idleTimer' | 'totalTimer' | 'batchTimer'): void {
    const timer = request[name]
    if (timer !== null) clock.clearTimeout(timer)
    request[name] = null
  }

  function clearAllTimers(request: ActiveRequest): void {
    clearTimer(request, 'connectionTimer')
    clearTimer(request, 'idleTimer')
    clearTimer(request, 'totalTimer')
    clearTimer(request, 'batchTimer')
  }

  function notifyIdle(): void {
    if (active.size !== 0) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  function writeLog(request: ActiveRequest, status: TerminalStatus): void {
    try {
      options.log?.({
        requestId: request.requestId,
        status,
        durationMs: Math.max(0, clock.now() - request.startedAt),
        receivedBytes: request.receivedBytes,
        outputBytes: request.outputBytes,
      })
    } catch { /* diagnostic logging must never affect request cleanup */ }
  }

  function tryEmit(request: ActiveRequest, event: AiChatStreamEvent): boolean {
    try {
      options.emit(request.senderId, event)
      return true
    } catch {
      return false
    }
  }

  function removeRequest(request: ActiveRequest, status: TerminalStatus): void {
    if (request.completed) return
    request.completed = true
    clearAllTimers(request)
    request.pendingContent = ''
    request.pendingReasoning = ''
    if (active.get(request.key) === request) active.delete(request.key)
    writeLog(request, status)
    notifyIdle()
  }

  function terminateForMissingSender(request: ActiveRequest): void {
    removeRequest(request, 'sender-gone')
    request.controller.abort()
    void request.reader?.cancel().catch(() => undefined)
  }

  function flush(request: ActiveRequest): boolean {
    clearTimer(request, 'batchTimer')
    if (request.completed) return false
    const content = request.pendingContent
    const reasoning = request.pendingReasoning
    if (!content && !reasoning) return true
    request.pendingContent = ''
    request.pendingReasoning = ''
    request.sequence += 1
    const emitted = tryEmit(request, {
      type: 'delta',
      requestId: request.requestId,
      sequence: request.sequence,
      ...(content ? { content } : {}),
      ...(reasoning ? { reasoning } : {}),
    })
    if (!emitted) terminateForMissingSender(request)
    return emitted
  }

  function scheduleFlush(request: ActiveRequest): void {
    if (request.completed || request.batchTimer !== null) return
    request.batchTimer = clock.setTimeout(() => {
      request.batchTimer = null
      flush(request)
    }, limits.batchIntervalMs)
  }

  function complete(request: ActiveRequest): void {
    if (request.completed || !flush(request)) return
    request.sequence += 1
    const event: AiChatStreamEvent = {
      type: 'complete',
      requestId: request.requestId,
      sequence: request.sequence,
      durationMs: Math.max(0, clock.now() - request.startedAt),
      receivedBytes: request.receivedBytes,
      outputBytes: request.outputBytes,
    }
    if (!tryEmit(request, event)) {
      terminateForMissingSender(request)
      return
    }
    removeRequest(request, 'complete')
  }

  function fail(request: ActiveRequest, failure: StreamFailure): void {
    if (request.completed) return
    if (!flush(request)) return
    request.sequence += 1
    const emitted = tryEmit(request, {
      type: 'error',
      requestId: request.requestId,
      sequence: request.sequence,
      code: failure.code,
      message: failure.message,
    })
    if (!emitted) {
      terminateForMissingSender(request)
      return
    }
    removeRequest(request, 'error')
    request.controller.abort()
    void request.reader?.cancel().catch(() => undefined)
  }

  function resetIdleTimer(request: ActiveRequest): void {
    clearTimer(request, 'idleTimer')
    if (request.completed) return
    request.idleTimer = clock.setTimeout(() => {
      request.idleTimer = null
      fail(request, new StreamFailure('idle-timeout', SAFE_ERROR_MESSAGES['idle-timeout']))
    }, limits.idleTimeoutMs)
  }

  function appendDelta(request: ActiveRequest, content: string, reasoning: string): void {
    for (const fragment of [content, reasoning]) {
      if (byteLength(fragment) > limits.fragmentBytes) {
        throw new StreamFailure('fragment-limit-exceeded', SAFE_ERROR_MESSAGES['fragment-limit-exceeded'])
      }
    }
    const addedBytes = byteLength(content) + byteLength(reasoning)
    if (request.outputBytes + addedBytes > limits.outputBytes) {
      throw new StreamFailure('output-limit-exceeded', SAFE_ERROR_MESSAGES['output-limit-exceeded'])
    }
    request.outputBytes += addedBytes
    request.pendingContent += content
    request.pendingReasoning += reasoning
    if (content || reasoning) scheduleFlush(request)
  }

  function handleEvent(request: ActiveRequest, data: string): boolean {
    if (request.completed) return true
    if (data.trim() === '[DONE]') {
      complete(request)
      return true
    }
    const delta = parsedDelta(data)
    appendDelta(request, delta.content, delta.reasoning)
    return false
  }

  async function run(request: ActiveRequest): Promise<void> {
    try {
      let credential: Awaited<ReturnType<ChatCredentialCoordinator['resolveCredential']>>
      try {
        credential = await options.credentialCoordinator.resolveCredential(request.group)
      } catch {
        throw new StreamFailure('credential-error', SAFE_ERROR_MESSAGES['credential-error'])
      }
      if (request.completed) return
      request.userId = credential.userId
      request.connectionTimer = clock.setTimeout(() => {
        request.connectionTimer = null
        fail(request, new StreamFailure('connection-timeout', SAFE_ERROR_MESSAGES['connection-timeout']))
      }, limits.connectionTimeoutMs)

      let response: Response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${credential.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request.body),
          redirect: 'manual',
          signal: request.controller.signal,
        })
      } catch {
        if (request.completed) return
        throw new StreamFailure('network-error', SAFE_ERROR_MESSAGES['network-error'])
      }
      clearTimer(request, 'connectionTimer')
      if (request.completed) {
        await response.body?.cancel().catch(() => undefined)
        return
      }
      if (!responseOriginIsTrusted(response, baseUrl.origin) || REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined)
        throw new StreamFailure('network-error', SAFE_ERROR_MESSAGES['network-error'])
      }
      if (!response.ok) {
        await discardBoundedErrorBody(response, limits.errorBytes)
        throw safeHttpFailure(response.status)
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('text/event-stream') || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw new StreamFailure('invalid-stream-response', SAFE_ERROR_MESSAGES['invalid-stream-response'])
      }

      resetIdleTimer(request)
      const parser = new BoundedSseParser(limits.eventBytes)
      const reader = response.body.getReader()
      request.reader = reader
      let receivedDone = false
      try {
        while (!request.completed) {
          const chunk = await reader.read()
          if (request.completed) break
          if (chunk.done) {
            for (const data of parser.finish()) {
              if (handleEvent(request, data)) {
                receivedDone = true
                break
              }
            }
            break
          }
          if (!chunk.value?.byteLength) continue
          request.receivedBytes += chunk.value.byteLength
          if (request.receivedBytes > limits.responseBytes) {
            throw new StreamFailure('response-limit-exceeded', SAFE_ERROR_MESSAGES['response-limit-exceeded'])
          }
          resetIdleTimer(request)
          for (const data of parser.push(chunk.value)) {
            if (handleEvent(request, data)) {
              receivedDone = true
              break
            }
          }
          if (receivedDone || request.completed) break
        }
      } finally {
        request.reader = null
        reader.releaseLock()
      }
      if (receivedDone || request.completed) return
      throw new StreamFailure('stream-closed', SAFE_ERROR_MESSAGES['stream-closed'])
    } catch (error) {
      if (request.completed) return
      const failure = error instanceof StreamFailure
        ? error
        : new StreamFailure('invalid-stream-response', SAFE_ERROR_MESSAGES['invalid-stream-response'])
      fail(request, failure)
    }
  }

  function start(input: StartAiChatStreamInput): StartAiChatStreamResult {
    if (disposed) throw new Error('AI聊天服务已停止')
    const senderId = requireSenderId(input.senderId)
    const requestId = requireRequestId(input.requestId, limits.requestIdLength)
    const key = operationKey(senderId, requestId)
    if (active.has(key)) throw new Error('相同 AI聊天请求正在处理中')
    if (active.size >= limits.concurrentRequests) throw new Error('AI聊天并发请求过多')
    const senderRequests = [...active.values()].filter((request) => request.senderId === senderId).length
    if (senderRequests >= limits.concurrentRequestsPerSender) throw new Error('当前窗口的 AI聊天请求过多')

    const body = buildChatCompletionsRequest({
      model: input.model,
      messages: input.messages,
      stream: true,
      parameters: input.parameters,
    })
    const controller = new AbortController()
    const request: ActiveRequest = {
      key,
      senderId,
      requestId,
      userId: null,
      body,
      group: input.group,
      controller,
      reader: null,
      startedAt: clock.now(),
      receivedBytes: 0,
      outputBytes: 0,
      sequence: 0,
      pendingContent: '',
      pendingReasoning: '',
      completed: false,
      connectionTimer: null,
      idleTimer: null,
      totalTimer: null,
      batchTimer: null,
    }
    active.set(key, request)
    request.totalTimer = clock.setTimeout(() => {
      request.totalTimer = null
      fail(request, new StreamFailure('total-timeout', SAFE_ERROR_MESSAGES['total-timeout']))
    }, limits.totalTimeoutMs)
    void run(request)
    return { accepted: true, requestId }
  }

  function cancelRequest(request: ActiveRequest, emitCanceled = true): boolean {
    if (request.completed) return false
    removeRequest(request, 'canceled')
    request.controller.abort()
    void request.reader?.cancel().catch(() => undefined)
    if (emitCanceled) {
      request.sequence += 1
      tryEmit(request, {
        type: 'canceled',
        requestId: request.requestId,
        sequence: request.sequence,
      })
    }
    return true
  }

  function cancel(senderIdInput: number, requestIdInput: string): boolean {
    const senderId = requireSenderId(senderIdInput)
    const requestId = requireRequestId(requestIdInput, limits.requestIdLength)
    const request = active.get(operationKey(senderId, requestId))
    return request ? cancelRequest(request) : false
  }

  function cancelWhere(predicate: (request: ActiveRequest) => boolean): number {
    let canceled = 0
    for (const request of [...active.values()]) {
      if (predicate(request) && cancelRequest(request)) canceled += 1
    }
    return canceled
  }

  function cancelSender(senderIdInput: number): number {
    const senderId = requireSenderId(senderIdInput)
    return cancelWhere((request) => request.senderId === senderId)
  }

  function cancelUser(userId: number): number {
    requirePositiveSafeInteger(userId, '用户标识')
    return cancelWhere((request) => request.userId === userId)
  }

  function cancelAll(): number {
    return cancelWhere(() => true)
  }

  function whenIdle(): Promise<void> {
    if (active.size === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.add(resolve))
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAll()
  }

  return {
    start,
    cancel,
    cancelSender,
    cancelUser,
    cancelAll,
    activeCount: () => active.size,
    whenIdle,
    dispose,
  }
}
