import type { AiChatAsset } from '../../../../electron/ipc-contract'
import { createConversation, createId, createWorkspace, defaultChatSettings, type ChatMessage, type ChatSettings, type ChatWorkspace, type Conversation } from './state'

export interface ChatStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
const MAX_BYTES = 4 * 1024 * 1024
const MAX_CONVERSATIONS = 50
const ASSET_ID = /^[A-Za-z0-9_-]{43}$/
export class ChatStorageError extends Error {}
const limitMessage = '聊天记录超过本地存储上限（4 MB 或 50 个对话），原始记录已保留，未进行截断'

export function historyKey(scope: string): string { return `xingmang-ui-v2:chat:${encodeURIComponent(scope)}` }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ChatStorageError('聊天记录包含无法完整读取的文本，原始记录已保留')
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160) throw new ChatStorageError('聊天记录标识无效，原始记录已保留')
  return value
}
function timestamp(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function readSettings(value: unknown): ChatSettings {
  const settings = object(value)
  if (!settings) {
    if (value !== undefined && value !== null) throw new ChatStorageError('聊天参数格式无效，原始记录已保留')
    return defaultChatSettings()
  }
  const result = { ...defaultChatSettings(), mode: settings.mode === 'image' ? 'image' as const : 'text' as const, group: text(settings.group), model: text(settings.model), systemPrompt: text(settings.systemPrompt) }
  const parameters = object(settings.parameters)
  for (const key of ['temperature', 'topP', 'maxTokens', 'frequencyPenalty', 'presencePenalty', 'seed'] as const) if (parameters && typeof parameters[key] === 'number' && Number.isFinite(parameters[key])) result.parameters[key] = parameters[key]
  if (typeof settings.size === 'string' && /^(auto|\d{3,4}x\d{3,4})$/.test(settings.size)) result.size = settings.size
  if (settings.quality === 'low' || settings.quality === 'medium' || settings.quality === 'high' || settings.quality === 'auto') result.quality = settings.quality
  if (settings.imageResolution === '1K' || settings.imageResolution === '2K' || settings.imageResolution === '4K') result.imageResolution = settings.imageResolution
  return result
}
function readAsset(value: unknown): AiChatAsset {
  const asset = object(value)
  if (!asset || typeof asset.assetId !== 'string' || !ASSET_ID.test(asset.assetId)) throw new ChatStorageError('聊天图片记录无效，原始记录已保留')
  const mimeType = asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/webp' ? asset.mimeType : 'image/png'
  return { assetId: asset.assetId, localUrl: `xingmang-asset://image/${asset.assetId}`, mimeType, fileName: text(asset.fileName) || '星芒图片.png', ...(timestamp(asset.width) ? { width: timestamp(asset.width) } : {}), ...(timestamp(asset.height) ? { height: timestamp(asset.height) } : {}), ...(asset.revisedPrompt ? { revisedPrompt: text(asset.revisedPrompt) } : {}) }
}
function readMessage(value: unknown): ChatMessage {
  const message = object(value)
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) throw new ChatStorageError('聊天消息格式无效，原始记录已保留')
  const images = Array.isArray(message.assets) ? message.assets : Array.isArray(message.images) ? message.images : []
  if ((message.assets !== undefined && !Array.isArray(message.assets)) || (message.images !== undefined && !Array.isArray(message.images))) throw new ChatStorageError('聊天图片列表无效，原始记录已保留')
  const assets = images.map(readAsset)
  const status = message.status === 'complete' || message.status === 'error' || message.status === 'canceled' ? message.status : 'canceled'
  return { id: id(message.id), role: message.role, content: text(message.content), reasoning: text(message.reasoning), status, createdAt: timestamp(message.createdAt), ...(assets.length ? { assets } : {}), ...(message.settings ? { settings: readSettings(message.settings) } : {}), ...(status === 'error' ? { error: text(message.error) || '上次请求未完成，可以重新生成' } : {}), ...(message.mayStillComplete === true ? { mayStillComplete: true } : {}) }
}
function assertUniqueIds(items: { id: string }[]): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new ChatStorageError('聊天记录包含重复标识，原始记录已保留')
}
function readConversation(value: unknown): Conversation {
  const conversation = object(value)
  if (!conversation || !Array.isArray(conversation.messages)) throw new ChatStorageError('聊天对话格式无效，原始记录已保留')
  const messages = conversation.messages.map(readMessage)
  assertUniqueIds(messages)
  return { id: id(conversation.id), title: text(conversation.title) || '新对话', createdAt: timestamp(conversation.createdAt), updatedAt: timestamp(conversation.updatedAt), draft: text(conversation.draft), settings: readSettings(conversation.settings), messages }
}
function parseWorkspace(raw: string, scope: string): ChatWorkspace {
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new ChatStorageError(limitMessage)
  const parsed = object(JSON.parse(raw))
  if (!parsed || parsed.version !== 2 || parsed.owner !== scope || !Array.isArray(parsed.conversations)) throw new Error('invalid owner or version')
  if (parsed.conversations.length > MAX_CONVERSATIONS) throw new ChatStorageError(limitMessage)
  const conversations = parsed.conversations.map(readConversation)
  const draftConversation = parsed.draftConversation === undefined ? createConversation() : readConversation(parsed.draftConversation)
  assertUniqueIds([...conversations, draftConversation])
  const activeId = typeof parsed.activeId === 'string' && conversations.some((item) => item.id === parsed.activeId) ? parsed.activeId : null
  return { version: 2, owner: scope, conversations, activeId, draftConversation }
}

function mergeAliases(candidates: ChatWorkspace[], scope: string): ChatWorkspace {
  const state: ChatWorkspace = { ...candidates[0], owner: scope, conversations: [] }
  const used = new Set([state.draftConversation.id])
  const originals = new Set<string>()
  const append = (conversation: Conversation) => {
    const serialized = JSON.stringify(conversation)
    if (originals.has(serialized)) return
    originals.add(serialized)
    let conversationId = conversation.id
    while (used.has(conversationId)) conversationId = createId()
    used.add(conversationId)
    state.conversations.push({ ...conversation, id: conversationId })
  }
  for (const candidate of candidates) {
    candidate.conversations.forEach(append)
    if (candidate !== candidates[0] && (candidate.draftConversation.draft || candidate.draftConversation.messages.length || candidate.draftConversation.settings.systemPrompt)
      && JSON.stringify(candidate.draftConversation) !== JSON.stringify(state.draftConversation)) append(candidate.draftConversation)
  }
  return state
}
export function readWorkspace(storage: ChatStorage, scope: string): { state: ChatWorkspace; warning?: string; exists: boolean } {
  const empty = () => ({ state: createWorkspace(scope), exists: false })
  try {
    const raw = storage.getItem(historyKey(scope))
    if (raw !== null) return { state: parseWorkspace(raw, scope), exists: true }
    // The old site names both referred to xm. Migrate only into its canonical
    // realm, only when the destination is absent, and validate each source's
    // original owner before assigning the new one. Source records stay intact.
    const xm = /^xm-account:([1-9][0-9]*)$/.exec(scope)
    if (xm && Number.isSafeInteger(Number(xm[1]))) {
      const candidates: ChatWorkspace[] = []
      for (const alias of ['solov', 'sub2api']) {
        const oldScope = `${alias}:${xm[1]}`
        const previous = storage.getItem(historyKey(oldScope))
        if (previous !== null) candidates.push(parseWorkspace(previous, oldScope))
      }
      const modifiedAt = (workspace: ChatWorkspace) => Math.max(workspace.draftConversation.updatedAt, ...workspace.conversations.map((item) => item.updatedAt))
      // Both aliases could have been used over time. Keep the most recent
      // selection, while merging unique conversations and conflicting versions.
      candidates.sort((left, right) => modifiedAt(right) - modifiedAt(left))
      if (candidates[0]) {
        const state = mergeAliases(candidates, scope)
        try { writeWorkspace(storage, state) }
        catch (error) { return { state, exists: true, warning: `之前的聊天记录已载入，但本机迁移未保存，原始数据已保留${error instanceof ChatStorageError ? `；${error.message}` : ''}` } }
        return { state, exists: true }
      }
      // Scope is already the authenticated account boundary, also used above
      // for alias ownership. Resolve v1 synchronously before any autosave can
      // establish an empty v2 destination and permanently hide the old history.
      const legacy = importLegacyHistory(storage, scope, Number(xm[1]))
      if (legacy) {
        try { writeWorkspace(storage, legacy) }
        catch (error) { return { state: legacy, exists: true, warning: `之前的聊天记录已载入，但本机迁移未保存，原始数据已保留${error instanceof ChatStorageError ? `；${error.message}` : ''}` } }
        return { state: legacy, exists: true }
      }
    }
    return empty()
  } catch (error) { return { ...empty(), exists: true, warning: error instanceof ChatStorageError ? error.message : '本地聊天记录暂时无法读取，原始数据已保留' } }
}
// localStorage sits unencrypted in the user profile, and chat text is the one
// surface where a pasted key, an Authorization header or a whole base64 image
// arrives verbatim. Redacting on the way out keeps those out of the record that
// survives the window they were typed in, without touching the copy on screen.
// 只剥凭据与运行时专用负载：普通链接和正文照原样存，本地记录仍然是无损的。
// 刻意不照搬旧渲染层的两条规则：整条抹掉 http(s) 链接，以及把任意超长字母数字块
// 当成编码数据。前者在 v2 没有收益（素材只存 assetId，运行时 URL 早已剥离），
// 后者会把普通长文本也吞掉，与这里「只对真实内容无损」的既有约定冲突。
export function redactPersistentChatText(value: string): string {
  return value
    .replace(/data:[^\s,;]+(?:;[^\s,;]+)*;base64,[A-Za-z0-9+/=_-]+/gi, '[图片数据未保存]')
    .replace(/blob:[^\s)\]}>"']+/gi, '[本地临时链接未保存]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[密钥未保存]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gi, '[密钥未保存]')
    .replace(/([?&](?:api[_-]?key|token)=)[^&\s]+/gi, '$1[密钥未保存]')
    .replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[密钥未保存]')
}
function persistedSettings(settings: ChatSettings): ChatSettings {
  return { ...settings, systemPrompt: redactPersistentChatText(settings.systemPrompt) }
}
function persistedMessage(message: ChatMessage) {
  return {
    ...message,
    requestId: undefined,
    content: redactPersistentChatText(message.content),
    reasoning: redactPersistentChatText(message.reasoning),
    ...(message.error === undefined ? {} : { error: redactPersistentChatText(message.error) }),
    ...(message.settings ? { settings: persistedSettings(message.settings) } : {}),
    assets: message.assets?.map(({ localUrl: _runtimeUrl, ...asset }) => (
      { ...asset, ...(asset.revisedPrompt === undefined ? {} : { revisedPrompt: redactPersistentChatText(asset.revisedPrompt) }) }
    )),
  }
}
function persistedConversation(conversation: Conversation) {
  return { ...conversation, title: redactPersistentChatText(conversation.title), draft: redactPersistentChatText(conversation.draft), settings: persistedSettings(conversation.settings), messages: conversation.messages.map((message) => persistedMessage(message)) }
}
export function writeWorkspace(storage: ChatStorage, state: ChatWorkspace): void {
  const serialized = JSON.stringify({ ...state, conversations: state.conversations.map(persistedConversation), draftConversation: persistedConversation(state.draftConversation) })
  if (state.conversations.length > MAX_CONVERSATIONS || new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw new ChatStorageError(limitMessage)
  storage.setItem(historyKey(state.owner), serialized)
}

export function importLegacyHistory(storage: ChatStorage, scope: string, userId: number): ChatWorkspace | null {
  // The v1 key had no site component. It can therefore only be imported for
  // the original xm account realm (including its historical sub2api alias).
  // A same-number account on api.solov must start with an empty workspace;
  // importing by userId alone would cross the realm boundary.
  const legacyOwner = /^(xm-account|solov|sub2api):([1-9][0-9]*)$/.exec(scope)
  if (!legacyOwner || Number(legacyOwner[2]) !== userId) return null
  const raw = storage.getItem(`xingmang-ai-chat:v1:${encodeURIComponent(String(userId))}`)
  if (raw === null) return null
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new ChatStorageError(limitMessage)
  try {
    const envelope = object(JSON.parse(raw)); const data = object(envelope?.data)
    if (envelope?.version !== 1 || envelope.userId !== String(userId) || !data || !Array.isArray(data.messages)) throw new ChatStorageError('旧版聊天记录格式或归属无效，原始记录已保留')
    const settings = { ...defaultChatSettings(), group: text(data.group), model: text(data.model) }
    const system = data.messages.map(object).filter((item) => item?.role === 'system').map((item) => text(item?.content)).join('\n\n')
    settings.systemPrompt = system
    const messages = data.messages.filter((item) => object(item)?.role !== 'system').map(readMessage)
    assertUniqueIds(messages)
    if (!messages.length && !settings.systemPrompt) return null
    const conversation = { ...createConversation(settings), title: '之前的聊天', messages }
    return { ...createWorkspace(scope), conversations: [conversation], activeId: conversation.id }
  } catch (error) { throw error instanceof ChatStorageError ? error : new ChatStorageError('之前的聊天记录暂时无法读取，原始数据已保留') }
}
