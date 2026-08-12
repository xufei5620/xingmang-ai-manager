export const AI_CHAT_HISTORY_VERSION = 1
export const AI_CHAT_MAX_STORED_MESSAGES = 100
export const AI_CHAT_MAX_STORED_BYTES = 1024 * 1024
export const AI_CHAT_MAX_MESSAGE_CHARS = 40_000
export const AI_CHAT_MAX_TOTAL_CHARS = 120_000

const STORAGE_PREFIX = 'xingmang-ai-chat:v1:'
const TRUNCATED_SUFFIX = '\n\n[...]'
const MAX_IMAGES_PER_MESSAGE = 8
const MAX_ID_LENGTH = 160
const MAX_GROUP_LENGTH = 160
const MAX_MODEL_LENGTH = 256
const MAX_MIME_TYPE_LENGTH = 100

export type AiChatRole = 'system' | 'user' | 'assistant'
export type AiChatMessageStatus = 'pending' | 'streaming' | 'complete' | 'canceled' | 'error'
export type AiChatRequestKind = 'chat' | 'image'

export interface AiChatImage {
  /** Opaque identifier owned by the main process. It is safe to persist. */
  assetId: string
  /** Runtime-only application URL. Persistence deliberately drops it. */
  previewUrl?: string
  mimeType?: string
  width?: number
  height?: number
  revisedPrompt?: string
}

export interface AiChatMessage {
  id: string
  role: AiChatRole
  content: string
  reasoning?: string
  images?: AiChatImage[]
  status: AiChatMessageStatus
  error?: string
  createdAt: number
  updatedAt?: number
  requestId?: string
  generation?: number
}

export interface AiChatGroupPreparation {
  phase: 'idle' | 'pending' | 'success' | 'failure'
  generation: number
  requestId: string | null
  targetGroup: string | null
  error: string | null
}

export interface AiChatRequestState {
  phase: 'idle' | 'running'
  generation: number
  requestId: string | null
  assistantMessageId: string | null
  kind: AiChatRequestKind | null
}

export interface AiChatState {
  userId: string
  group: string
  model: string
  availableModels: string[]
  messages: AiChatMessage[]
  groupPreparation: AiChatGroupPreparation
  request: AiChatRequestState
}

export interface AiChatOperationToken {
  generation: number
  requestId: string
}

export interface AiChatStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface AiChatHistorySnapshot {
  group: string
  model: string
  messages: AiChatMessage[]
}

interface PersistedAiChatImage {
  assetId: string
  mimeType?: string
  width?: number
  height?: number
  revisedPrompt?: string
}

interface PersistedAiChatMessage {
  id: string
  role: AiChatRole
  content: string
  reasoning?: string
  images?: PersistedAiChatImage[]
  status: AiChatMessageStatus
  error?: string
  createdAt: number
  updatedAt?: number
}

interface PersistedAiChatEnvelope {
  version: number
  userId: string
  data: {
    group: string
    model: string
    messages: PersistedAiChatMessage[]
  }
}

function normalizedUserId(userId: string | number): string {
  const normalized = String(userId).trim()
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\0\r\n]/.test(normalized)) {
    throw new TypeError('AI聊天用户标识格式错误')
  }
  return normalized
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\0\r\n]/.test(normalized)) {
    throw new TypeError(`${label}格式错误`)
  }
  return normalized
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  if (maximum <= 0) return ''
  if (maximum <= TRUNCATED_SUFFIX.length) return value.slice(0, maximum)
  return `${value.slice(0, maximum - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`
}

/** Removes values that must never be written to renderer persistence. */
export function redactAiChatPersistentText(value: string): string {
  return value
    .replace(/data:[^\s,;]+(?:;[^\s,]+)*;base64,[a-z0-9+/=_-]+/gi, '[图片数据未保存]')
    .replace(/blob:[^\s)\]}>"']+/gi, '[本地临时链接未保存]')
    .replace(/https?:\/\/[^\s)\]}>"']+/gi, '[远程链接未保存]')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, 'Bearer [密钥未保存]')
    .replace(/\bsk-[a-z0-9._-]{8,}\b/gi, '[密钥未保存]')
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function optionalDimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 32_768
    ? value
    : undefined
}

function safeAssetId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > MAX_ID_LENGTH
    || /[\0\r\n]/.test(normalized)
    || /^(?:data|blob|https?):/i.test(normalized)
    || /\bsk-/i.test(normalized)
  ) return null
  return normalized
}

function sanitizeRuntimeImage(image: AiChatImage): AiChatImage | null {
  const assetId = safeAssetId(image.assetId)
  if (!assetId) return null
  return {
    assetId,
    ...(typeof image.previewUrl === 'string' && image.previewUrl.length <= 2_048
      ? { previewUrl: image.previewUrl }
      : {}),
    ...(typeof image.mimeType === 'string' && image.mimeType.length <= MAX_MIME_TYPE_LENGTH
      ? { mimeType: image.mimeType }
      : {}),
    ...(optionalDimension(image.width) ? { width: optionalDimension(image.width) } : {}),
    ...(optionalDimension(image.height) ? { height: optionalDimension(image.height) } : {}),
    ...(typeof image.revisedPrompt === 'string' ? { revisedPrompt: image.revisedPrompt } : {}),
  }
}

function invalidateRequest(state: AiChatState): AiChatState {
  const messages = state.messages.map((message) => (
    message.id === state.request.assistantMessageId
      && (message.status === 'pending' || message.status === 'streaming')
      ? { ...message, status: 'canceled' as const, requestId: undefined, generation: undefined }
      : message
  ))
  return {
    ...state,
    messages,
    request: {
      phase: 'idle',
      generation: state.request.generation + 1,
      requestId: null,
      assistantMessageId: null,
      kind: null,
    },
  }
}

export function createAiChatState(
  userId: string | number,
  history: Partial<AiChatHistorySnapshot> = {},
): AiChatState {
  return {
    userId: normalizedUserId(userId),
    group: typeof history.group === 'string' ? history.group : '',
    model: typeof history.model === 'string' ? history.model : '',
    availableModels: [],
    messages: Array.isArray(history.messages) ? history.messages : [],
    groupPreparation: {
      phase: 'idle',
      generation: 0,
      requestId: null,
      targetGroup: null,
      error: null,
    },
    request: {
      phase: 'idle',
      generation: 0,
      requestId: null,
      assistantMessageId: null,
      kind: null,
    },
  }
}

export function beginAiChatGroupPreparation(
  state: AiChatState,
  input: { group: string; requestId: string },
): AiChatState {
  const targetGroup = requiredId(input.group, '分组')
  const requestId = requiredId(input.requestId, '请求标识')
  return {
    ...state,
    groupPreparation: {
      phase: 'pending',
      generation: state.groupPreparation.generation + 1,
      requestId,
      targetGroup,
      error: null,
    },
  }
}

export function aiChatGroupPreparationToken(state: AiChatState): AiChatOperationToken | null {
  return state.groupPreparation.phase === 'pending' && state.groupPreparation.requestId
    ? { generation: state.groupPreparation.generation, requestId: state.groupPreparation.requestId }
    : null
}

export function isCurrentAiChatGroupPreparation(
  state: AiChatState,
  token: AiChatOperationToken,
): boolean {
  return state.groupPreparation.phase === 'pending'
    && state.groupPreparation.generation === token.generation
    && state.groupPreparation.requestId === token.requestId
}

function normalizedModels(models: readonly string[]): string[] {
  return [...new Set(models
    .filter((model): model is string => typeof model === 'string')
    .map((model) => model.trim())
    .filter((model) => model && model.length <= MAX_MODEL_LENGTH && !/[\0\r\n]/.test(model)))]
}

export function completeAiChatGroupPreparation(
  state: AiChatState,
  token: AiChatOperationToken,
  input: { group: string; models: readonly string[]; preferredModel?: string },
): AiChatState {
  if (!isCurrentAiChatGroupPreparation(state, token)) return state
  const group = requiredId(input.group, '分组')
  if (group !== state.groupPreparation.targetGroup) return state
  const models = normalizedModels(input.models)
  const preferred = input.preferredModel?.trim() ?? ''
  const model = models.includes(preferred)
    ? preferred
    : (models.includes(state.model) ? state.model : (models[0] ?? ''))
  return {
    ...state,
    group,
    model,
    availableModels: models,
    groupPreparation: {
      ...state.groupPreparation,
      phase: 'success',
      targetGroup: null,
      error: null,
    },
  }
}

export function failAiChatGroupPreparation(
  state: AiChatState,
  token: AiChatOperationToken,
  error: string,
): AiChatState {
  if (!isCurrentAiChatGroupPreparation(state, token)) return state
  return {
    ...state,
    groupPreparation: {
      ...state.groupPreparation,
      phase: 'failure',
      targetGroup: null,
      error: error.trim() || '分组准备失败',
    },
  }
}

export function beginAiChatRequest(
  state: AiChatState,
  input: {
    requestId: string
    userMessageId: string
    assistantMessageId: string
    content: string
    kind?: AiChatRequestKind
    createdAt?: number
  },
): AiChatState {
  const requestId = requiredId(input.requestId, '请求标识')
  const userMessageId = requiredId(input.userMessageId, '用户消息标识')
  const assistantMessageId = requiredId(input.assistantMessageId, '助手消息标识')
  const generation = state.request.generation + 1
  const createdAt = finiteTimestamp(input.createdAt, Date.now())
  const base = invalidateRequest(state)
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        id: userMessageId,
        role: 'user',
        content: input.content,
        status: 'complete',
        createdAt,
      },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        status: 'pending',
        createdAt,
        requestId,
        generation,
      },
    ],
    request: {
      phase: 'running',
      generation,
      requestId,
      assistantMessageId,
      kind: input.kind ?? 'chat',
    },
  }
}

export function aiChatRequestToken(state: AiChatState): AiChatOperationToken | null {
  return state.request.phase === 'running' && state.request.requestId
    ? { generation: state.request.generation, requestId: state.request.requestId }
    : null
}

export function isCurrentAiChatRequest(state: AiChatState, token: AiChatOperationToken): boolean {
  return state.request.phase === 'running'
    && state.request.generation === token.generation
    && state.request.requestId === token.requestId
}

function updateCurrentAssistant(
  state: AiChatState,
  token: AiChatOperationToken,
  update: (message: AiChatMessage) => AiChatMessage,
): AiChatState {
  if (!isCurrentAiChatRequest(state, token) || !state.request.assistantMessageId) return state
  const assistantMessageId = state.request.assistantMessageId
  return {
    ...state,
    messages: state.messages.map((message) => (
      message.id === assistantMessageId ? update(message) : message
    )),
  }
}

export function appendAiChatText(
  state: AiChatState,
  token: AiChatOperationToken,
  text: string,
): AiChatState {
  if (!text) return state
  return updateCurrentAssistant(state, token, (message) => ({
    ...message,
    content: `${message.content}${text}`,
    status: 'streaming',
  }))
}

export function appendAiChatReasoning(
  state: AiChatState,
  token: AiChatOperationToken,
  reasoning: string,
): AiChatState {
  if (!reasoning) return state
  return updateCurrentAssistant(state, token, (message) => ({
    ...message,
    reasoning: `${message.reasoning ?? ''}${reasoning}`,
    status: 'streaming',
  }))
}

export function appendAiChatImage(
  state: AiChatState,
  token: AiChatOperationToken,
  image: AiChatImage,
): AiChatState {
  const safeImage = sanitizeRuntimeImage(image)
  if (!safeImage) return state
  return updateCurrentAssistant(state, token, (message) => ({
    ...message,
    images: [...(message.images ?? []), safeImage].slice(0, MAX_IMAGES_PER_MESSAGE),
    status: 'streaming',
  }))
}

function finishAiChatRequest(
  state: AiChatState,
  token: AiChatOperationToken,
  status: Extract<AiChatMessageStatus, 'complete' | 'canceled' | 'error'>,
  error?: string,
  completedAt?: number,
): AiChatState {
  const updated = updateCurrentAssistant(state, token, (message) => ({
    ...message,
    status,
    ...(error ? { error } : { error: undefined }),
    updatedAt: finiteTimestamp(completedAt, Date.now()),
    requestId: undefined,
    generation: undefined,
  }))
  if (updated === state) return state
  return {
    ...updated,
    request: {
      phase: 'idle',
      generation: state.request.generation,
      requestId: null,
      assistantMessageId: null,
      kind: null,
    },
  }
}

export function completeAiChatRequest(
  state: AiChatState,
  token: AiChatOperationToken,
  completedAt?: number,
): AiChatState {
  return finishAiChatRequest(state, token, 'complete', undefined, completedAt)
}

export function cancelAiChatRequest(
  state: AiChatState,
  token: AiChatOperationToken,
  completedAt?: number,
): AiChatState {
  return finishAiChatRequest(state, token, 'canceled', undefined, completedAt)
}

export function errorAiChatRequest(
  state: AiChatState,
  token: AiChatOperationToken,
  error: string,
  completedAt?: number,
): AiChatState {
  return finishAiChatRequest(state, token, 'error', error.trim() || '请求失败', completedAt)
}

export function editAiChatMessage(
  state: AiChatState,
  messageId: string,
  content: string,
  updatedAt = Date.now(),
): AiChatState {
  const base = invalidateRequest(state)
  return {
    ...base,
    messages: base.messages.map((message) => message.id === messageId
      ? {
          ...message,
          content,
          status: 'complete',
          error: undefined,
          updatedAt: finiteTimestamp(updatedAt, Date.now()),
          requestId: undefined,
          generation: undefined,
        }
      : message),
  }
}

export function deleteAiChatMessage(state: AiChatState, messageId: string): AiChatState {
  const base = invalidateRequest(state)
  return { ...base, messages: base.messages.filter((message) => message.id !== messageId) }
}

export function regenerateAiChatMessage(
  state: AiChatState,
  input: { messageId: string; requestId: string; createdAt?: number; kind?: AiChatRequestKind },
): AiChatState {
  const index = state.messages.findIndex((message) => message.id === input.messageId && message.role === 'assistant')
  if (index < 0) return state
  const requestId = requiredId(input.requestId, '请求标识')
  const base = invalidateRequest(state)
  const generation = base.request.generation + 1
  const messages = base.messages.slice(0, index + 1)
  messages[index] = {
    id: messages[index].id,
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: finiteTimestamp(input.createdAt, Date.now()),
    requestId,
    generation,
  }
  return {
    ...base,
    messages,
    request: {
      phase: 'running',
      generation,
      requestId,
      assistantMessageId: input.messageId,
      kind: input.kind ?? 'chat',
    },
  }
}

export const retryAiChatMessage = regenerateAiChatMessage

export function clearAiChatMessages(state: AiChatState): AiChatState {
  const base = invalidateRequest(state)
  return { ...base, messages: [] }
}

export function addAiChatSystemMessage(
  state: AiChatState,
  input: { id: string; content: string; createdAt?: number },
): AiChatState {
  const base = invalidateRequest(state)
  return {
    ...base,
    messages: [...base.messages, {
      id: requiredId(input.id, '系统消息标识'),
      role: 'system',
      content: input.content,
      status: 'complete',
      createdAt: finiteTimestamp(input.createdAt, Date.now()),
    }],
  }
}

function safeBoundedString(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0') ? value : ''
}

function readPersistedImage(value: unknown): PersistedAiChatImage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const assetId = safeAssetId(record.assetId)
  if (!assetId) return null
  const mimeType = safeBoundedString(record.mimeType, MAX_MIME_TYPE_LENGTH)
  const revisedPrompt = typeof record.revisedPrompt === 'string' ? record.revisedPrompt : ''
  return {
    assetId,
    ...(mimeType ? { mimeType } : {}),
    ...(optionalDimension(record.width) ? { width: optionalDimension(record.width) } : {}),
    ...(optionalDimension(record.height) ? { height: optionalDimension(record.height) } : {}),
    ...(revisedPrompt ? { revisedPrompt } : {}),
  }
}

function takeSanitizedText(value: unknown, budget: { remaining: number }): string {
  if (typeof value !== 'string' || budget.remaining <= 0) return ''
  const sanitized = redactAiChatPersistentText(value)
  const result = boundedText(sanitized, budget.remaining)
  budget.remaining -= result.length
  return result
}

function sanitizeMessageForPersistence(
  value: unknown,
  characterLimit = AI_CHAT_MAX_MESSAGE_CHARS,
): PersistedAiChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? requiredId(record.id, '消息标识') : null
  if (!id || !['system', 'user', 'assistant'].includes(String(record.role))) return null
  const role = record.role as AiChatRole
  const statusValue = String(record.status)
  const status: AiChatMessageStatus = ['pending', 'streaming', 'complete', 'canceled', 'error'].includes(statusValue)
    ? statusValue as AiChatMessageStatus
    : 'complete'
  const budget = { remaining: Math.max(0, characterLimit) }
  const content = takeSanitizedText(record.content, budget)
  const reasoning = takeSanitizedText(record.reasoning, budget)
  const error = takeSanitizedText(record.error, budget)
  const images: PersistedAiChatImage[] = []
  if (Array.isArray(record.images)) {
    for (const rawImage of record.images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
      const image = readPersistedImage(rawImage)
      if (!image) continue
      if (image.revisedPrompt) {
        image.revisedPrompt = takeSanitizedText(image.revisedPrompt, budget)
        if (!image.revisedPrompt) delete image.revisedPrompt
      }
      images.push(image)
    }
  }
  const normalizedStatus = status === 'pending' || status === 'streaming'
    ? (content || reasoning || images.length ? 'complete' : 'canceled')
    : status
  return {
    id,
    role,
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(images.length ? { images } : {}),
    status: normalizedStatus,
    ...(error ? { error } : {}),
    createdAt: finiteTimestamp(record.createdAt, 0),
    ...(typeof record.updatedAt === 'number' ? { updatedAt: finiteTimestamp(record.updatedAt, 0) } : {}),
  }
}

function persistedMessageCharacters(message: PersistedAiChatMessage): number {
  return message.content.length
    + (message.reasoning?.length ?? 0)
    + (message.error?.length ?? 0)
    + (message.images?.reduce((total, image) => total + (image.revisedPrompt?.length ?? 0), 0) ?? 0)
}

function sanitizeMessagesForPersistence(messages: readonly AiChatMessage[]): PersistedAiChatMessage[] {
  const newest = messages.slice(-AI_CHAT_MAX_STORED_MESSAGES)
  const result: PersistedAiChatMessage[] = []
  let remaining = AI_CHAT_MAX_TOTAL_CHARS
  for (let index = newest.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = sanitizeMessageForPersistence(newest[index], Math.min(remaining, AI_CHAT_MAX_MESSAGE_CHARS))
    if (!message) continue
    const characters = persistedMessageCharacters(message)
    if (characters === 0 && !(message.images?.length)) continue
    remaining -= characters
    result.push(message)
  }
  return result.reverse()
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function aiChatStorageKey(userId: string | number): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(normalizedUserId(userId))}`
}

function serializeWithinLimit(envelope: PersistedAiChatEnvelope): string {
  let serialized = JSON.stringify(envelope)
  while (utf8Bytes(serialized) > AI_CHAT_MAX_STORED_BYTES && envelope.data.messages.length > 0) {
    envelope.data.messages.shift()
    serialized = JSON.stringify(envelope)
  }
  if (utf8Bytes(serialized) > AI_CHAT_MAX_STORED_BYTES) {
    throw new Error('AI聊天历史超过本地存储安全上限')
  }
  return serialized
}

export function saveAiChatHistory(storage: AiChatStorage, state: AiChatState): void {
  const userId = normalizedUserId(state.userId)
  const envelope: PersistedAiChatEnvelope = {
    version: AI_CHAT_HISTORY_VERSION,
    userId,
    data: {
      group: safeBoundedString(state.group, MAX_GROUP_LENGTH),
      model: safeBoundedString(state.model, MAX_MODEL_LENGTH),
      messages: sanitizeMessagesForPersistence(state.messages),
    },
  }
  storage.setItem(aiChatStorageKey(userId), serializeWithinLimit(envelope))
}

function emptyHistory(): AiChatHistorySnapshot {
  return { group: '', model: '', messages: [] }
}

export function loadAiChatHistory(
  storage: AiChatStorage,
  userIdInput: string | number,
): AiChatHistorySnapshot {
  const userId = normalizedUserId(userIdInput)
  const key = aiChatStorageKey(userId)
  const raw = storage.getItem(key)
  if (!raw) return emptyHistory()
  try {
    if (utf8Bytes(raw) > AI_CHAT_MAX_STORED_BYTES) throw new Error('history too large')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid envelope')
    const envelope = parsed as Record<string, unknown>
    if (envelope.version !== AI_CHAT_HISTORY_VERSION || envelope.userId !== userId) {
      throw new Error('wrong history owner or version')
    }
    if (!envelope.data || typeof envelope.data !== 'object') throw new Error('invalid history data')
    const data = envelope.data as Record<string, unknown>
    const sourceMessages = Array.isArray(data.messages) ? data.messages : []
    const messages = sanitizeMessagesForPersistence(sourceMessages as AiChatMessage[])
    return {
      group: safeBoundedString(data.group, MAX_GROUP_LENGTH),
      model: safeBoundedString(data.model, MAX_MODEL_LENGTH),
      messages,
    }
  } catch {
    storage.removeItem(key)
    return emptyHistory()
  }
}

export function clearAiChatHistory(storage: AiChatStorage, userId: string | number): void {
  storage.removeItem(aiChatStorageKey(userId))
}
