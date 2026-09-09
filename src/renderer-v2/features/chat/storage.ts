import type { AiChatAsset } from '../../../../electron/ipc-contract'
import { createConversation, createWorkspace, defaultChatSettings, type ChatMessage, type ChatSettings, type ChatWorkspace, type Conversation } from './state'

export interface ChatStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
const MAX_BYTES = 4 * 1024 * 1024
const MAX_CONVERSATIONS = 50
const ASSET_ID = /^[A-Za-z0-9_-]{43}$/

export function historyKey(scope: string): string { return `xingmang-ui-v2:chat:${encodeURIComponent(scope)}` }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function text(value: unknown, limit = 40_000): string { return typeof value === 'string' ? value.slice(0, limit) : '' }
function timestamp(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function readSettings(value: unknown): ChatSettings {
  const settings = object(value)
  if (!settings) return defaultChatSettings()
  const result = { ...defaultChatSettings(), mode: settings.mode === 'image' ? 'image' as const : 'text' as const, group: text(settings.group, 128), model: text(settings.model, 128), systemPrompt: text(settings.systemPrompt) }
  const parameters = object(settings.parameters)
  for (const key of ['temperature', 'topP', 'maxTokens', 'frequencyPenalty', 'presencePenalty', 'seed'] as const) if (parameters && typeof parameters[key] === 'number' && Number.isFinite(parameters[key])) result.parameters[key] = parameters[key]
  if (typeof settings.size === 'string' && /^(auto|\d{3,4}x\d{3,4})$/.test(settings.size)) result.size = settings.size
  if (settings.quality === 'low' || settings.quality === 'medium' || settings.quality === 'high' || settings.quality === 'auto') result.quality = settings.quality
  if (settings.imageResolution === '1K' || settings.imageResolution === '2K' || settings.imageResolution === '4K') result.imageResolution = settings.imageResolution
  return result
}
function readAsset(value: unknown): AiChatAsset | null {
  const asset = object(value)
  if (!asset || typeof asset.assetId !== 'string' || !ASSET_ID.test(asset.assetId)) return null
  const mimeType = asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/webp' ? asset.mimeType : 'image/png'
  return { assetId: asset.assetId, localUrl: `xingmang-asset://image/${asset.assetId}`, mimeType, fileName: text(asset.fileName, 256) || '星芒图片.png', ...(timestamp(asset.width) ? { width: timestamp(asset.width) } : {}), ...(timestamp(asset.height) ? { height: timestamp(asset.height) } : {}), ...(asset.revisedPrompt ? { revisedPrompt: text(asset.revisedPrompt) } : {}) }
}
function readMessage(value: unknown): ChatMessage | null {
  const message = object(value)
  if (!message || (message.role !== 'user' && message.role !== 'assistant') || !text(message.id, 160)) return null
  const images = Array.isArray(message.assets) ? message.assets : Array.isArray(message.images) ? message.images : []
  const assets = images.slice(0, 8).map(readAsset).filter((image): image is AiChatAsset => Boolean(image))
  const status = message.status === 'complete' || message.status === 'error' || message.status === 'canceled' ? message.status : 'canceled'
  return { id: text(message.id, 160), role: message.role, content: text(message.content), reasoning: text(message.reasoning), status, createdAt: timestamp(message.createdAt), ...(assets.length ? { assets } : {}), ...(message.settings ? { settings: readSettings(message.settings) } : {}), ...(status === 'error' ? { error: '上次请求未完成，可以重新生成' } : {}), ...(message.mayStillComplete === true ? { mayStillComplete: true } : {}) }
}
function readConversation(value: unknown): Conversation | null {
  const conversation = object(value)
  if (!conversation || !text(conversation.id, 160) || !Array.isArray(conversation.messages)) return null
  const messages = conversation.messages.slice(-101).map(readMessage).filter((item): item is ChatMessage => Boolean(item))
  return { id: text(conversation.id, 160), title: text(conversation.title, 80) || '新对话', createdAt: timestamp(conversation.createdAt), updatedAt: timestamp(conversation.updatedAt), draft: text(conversation.draft), settings: readSettings(conversation.settings), messages }
}
export function readWorkspace(storage: ChatStorage, scope: string): { state: ChatWorkspace; warning?: string; exists: boolean } {
  const empty = () => ({ state: createWorkspace(scope), exists: false })
  try {
    const raw = storage.getItem(historyKey(scope))
    if (!raw) return empty()
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error('too large')
    const parsed = object(JSON.parse(raw))
    if (!parsed || parsed.version !== 2 || parsed.owner !== scope || !Array.isArray(parsed.conversations)) throw new Error('invalid owner or version')
    const conversations = parsed.conversations.slice(0, MAX_CONVERSATIONS).map(readConversation).filter((item): item is Conversation => Boolean(item))
    const seen = new Set<string>()
    const unique = conversations.filter((conversation) => { if (seen.has(conversation.id)) return false; seen.add(conversation.id); return true })
    const activeId = typeof parsed.activeId === 'string' && unique.some((item) => item.id === parsed.activeId) ? parsed.activeId : null
    return { state: { version: 2, owner: scope, conversations: unique, activeId, draftConversation: readConversation(parsed.draftConversation) ?? createConversation() }, exists: true }
  } catch { return { ...empty(), exists: true, warning: '本地聊天记录暂时无法读取，原始数据已保留' } }
}
export function writeWorkspace(storage: ChatStorage, state: ChatWorkspace): void {
  const persistConversation = (conversation: Conversation) => ({ ...conversation, messages: conversation.messages.map((message) => ({ ...message, requestId: undefined, assets: message.assets?.map(({ localUrl: _runtimeUrl, ...asset }) => asset) })) })
  const serialized = JSON.stringify({ ...state, conversations: state.conversations.map(persistConversation), draftConversation: persistConversation(state.draftConversation) })
  if (state.conversations.length > MAX_CONVERSATIONS || new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw new Error('聊天记录已达到本地存储上限，请先删除不再需要的对话')
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
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_BYTES) return null
  try {
    const envelope = object(JSON.parse(raw)); const data = object(envelope?.data)
    if (envelope?.version !== 1 || envelope.userId !== String(userId) || !data || !Array.isArray(data.messages)) return null
    const settings = { ...defaultChatSettings(), group: text(data.group, 128), model: text(data.model, 128) }
    const system = data.messages.map(object).filter((item) => item?.role === 'system').map((item) => text(item?.content)).join('\n\n')
    settings.systemPrompt = system.slice(0, 40_000)
    const messages = data.messages.slice(-100).map(readMessage).filter((item): item is ChatMessage => Boolean(item))
    if (!messages.length) return null
    const conversation = { ...createConversation(settings), title: '之前的聊天', messages }
    return { ...createWorkspace(scope), conversations: [conversation], activeId: conversation.id }
  } catch { return null }
}
