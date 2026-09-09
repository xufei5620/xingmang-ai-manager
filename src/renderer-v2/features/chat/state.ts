import type { AiChatAsset, AiChatErrorCode, AiChatGroupSummary, AiChatMessageInput, AiChatParametersInput, AiChatStreamEvent } from '../../../../electron/ipc-contract'
import { chatLimits } from './api'

export type ChatMode = 'text' | 'image'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'canceled' | 'error'
export interface ChatSettings {
  mode: ChatMode
  group: string
  model: string
  systemPrompt: string
  parameters: AiChatParametersInput
  size: string
  quality: 'low' | 'medium' | 'high' | 'auto'
  imageResolution: '1K' | '2K' | '4K'
}
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: MessageStatus
  createdAt: number
  requestId?: string
  error?: string
  mayStillComplete?: boolean
  assets?: AiChatAsset[]
  settings?: ChatSettings
}
export interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; draft: string; settings: ChatSettings; messages: ChatMessage[] }
export interface ChatWorkspace { version: 2; owner: string; activeId: string | null; conversations: Conversation[]; draftConversation: Conversation }
export interface TurnPlan { conversation: Conversation; requestId: string; assistantId: string; settings: ChatSettings; prompt: string; messages: AiChatMessageInput[] }

// Keep the first chat surface aligned with the account-side Codex defaults.
// The server may return models in a different order, so the renderer must not
// silently pick whichever entry happened to arrive first.
// 与账号登录后自动创建的 Codex Key 分组保持一致。这里使用协议约定的
// 稳定名称，避免 catalog 中 CLI 配置的历史别名改变聊天初始分组。
export const DEFAULT_CHAT_GROUP = 'Codex_pro'
export const DEFAULT_CHAT_MODEL = 'gpt-5.6-sol'
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'

export function createId(): string { return crypto.randomUUID() }
export function defaultChatSettings(): ChatSettings { return { mode: 'text', group: '', model: '', systemPrompt: '', parameters: {}, size: '1024x1024', quality: 'low', imageResolution: '1K' } }
export function createConversation(settings = defaultChatSettings(), id = createId()): Conversation { const now = Date.now(); return { id, title: '新对话', createdAt: now, updatedAt: now, draft: '', settings: { ...settings, parameters: { ...settings.parameters } }, messages: [] } }
export function createWorkspace(owner: string): ChatWorkspace { return { version: 2, owner, activeId: null, conversations: [], draftConversation: createConversation() } }
export function resolveChatGroup(groups: readonly Pick<AiChatGroupSummary, 'name'>[], remembered = ''): string {
  if (remembered && groups.some((group) => group.name === remembered)) return remembered
  return groups.find((group) => group.name === DEFAULT_CHAT_GROUP)?.name ?? groups[0]?.name ?? ''
}
export function resolveChatModel(models: readonly string[], remembered = '', preferred = DEFAULT_CHAT_MODEL): string {
  if (remembered && models.includes(remembered)) return remembered
  return models.includes(preferred) ? preferred : models[0] ?? ''
}
export function activeConversation(state: ChatWorkspace): Conversation { return state.conversations.find((item) => item.id === state.activeId) ?? state.draftConversation }
export function changeConversation(state: ChatWorkspace, id: string, change: (conversation: Conversation) => Conversation): ChatWorkspace {
  if (state.draftConversation.id === id) return { ...state, draftConversation: change(state.draftConversation) }
  return { ...state, conversations: state.conversations.map((item) => item.id === id ? change(item) : item) }
}
export function saveConversation(state: ChatWorkspace, conversation: Conversation): ChatWorkspace {
  if (state.draftConversation.id === conversation.id) return { ...state, activeId: conversation.id, conversations: [conversation, ...state.conversations], draftConversation: createConversation(conversation.settings) }
  if (!state.conversations.some((item) => item.id === conversation.id)) return { ...state, activeId: conversation.id, conversations: [conversation, ...state.conversations] }
  return changeConversation(state, conversation.id, () => conversation)
}
export function isGenerating(conversation: Conversation): boolean { return conversation.messages.some((message) => message.status === 'pending' || message.status === 'streaming') }

export function planTurn(conversation: Conversation, input: { prompt: string; requestId: string; assistantId: string; userMessageId: string; retryId?: string; editId?: string }): TurnPlan {
  if (isGenerating(conversation)) throw new Error('当前对话仍在生成，请先停止或等待完成')
  let history = conversation.messages.slice()
  let settings = conversation.settings
  let prompt = input.prompt.trim()
  let assistantId = input.assistantId
  if (input.retryId) {
    const index = history.findIndex((message) => message.id === input.retryId && message.role === 'assistant')
    if (index < 1) throw new Error('找不到要重新生成的回复')
    settings = history[index].settings ?? settings
    assistantId = input.retryId
    history = history.slice(0, index)
    prompt = [...history].reverse().find((message) => message.role === 'user')?.content ?? ''
  } else if (input.editId) {
    const index = history.findIndex((message) => message.id === input.editId && message.role === 'user')
    if (index < 0) throw new Error('找不到要编辑的消息')
    history = [...history.slice(0, index), { ...history[index], content: prompt }]
  } else {
    history.push({ id: input.userMessageId, role: 'user', content: prompt, reasoning: '', status: 'complete', createdAt: Date.now() })
  }
  if (!prompt) throw new Error('请先输入消息内容')
  if (prompt.length > chatLimits.messageLength) throw new Error(`单条消息最多 ${chatLimits.messageLength} 个字符`)
  if (!settings.group || !settings.model) throw new Error('请先选择分组和模型')
  const messages: AiChatMessageInput[] = []
  if (settings.systemPrompt.trim()) messages.push({ role: 'system', content: settings.systemPrompt.trim() })
  for (const message of history) if (message.content.trim() && (message.role === 'user' || (!message.assets?.length && message.status !== 'error'))) messages.push({ role: message.role, content: message.content })
  if (messages.length > chatLimits.messageCount || messages.reduce((total, message) => total + message.content.length, 0) > chatLimits.totalMessageLength) throw new Error('这段对话已达到上下文上限，请新建对话后继续')
  const snapshot = { ...settings, parameters: { ...settings.parameters } }
  const assistant: ChatMessage = { id: assistantId, role: 'assistant', content: '', reasoning: '', status: 'pending', createdAt: Date.now(), requestId: input.requestId, settings: snapshot }
  return { conversation: { ...conversation, title: conversation.messages.length ? conversation.title : prompt.slice(0, 32), updatedAt: Date.now(), draft: input.retryId || input.editId ? conversation.draft : '', messages: [...history, assistant] }, requestId: input.requestId, assistantId, settings: snapshot, prompt, messages }
}

export function chatErrorMessage(error: unknown, code?: AiChatErrorCode): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (code === 'connection-timeout') return 'AI 服务响应较慢，本次等待已超时，请重试'
  if (code === 'idle-timeout') return 'AI 服务长时间没有返回内容，本次等待已停止，请重试'
  if (code === 'total-timeout') return '本次对话超过最长处理时间，已停止等待'
  if (code === 'network-error') return '无法连接 AI 服务，请检查网络后重试'
  if (code === 'stream-closed') return 'AI 服务提前结束了本次响应，请重试'
  if (code === 'model-unavailable') return '当前模型不在所选分组的可用列表中，请刷新后重新选择'
  if (code) return message || '本次请求没有完成，已保留内容，请稍后重试'
  if (/余额|额度不足|insufficient|quota|402/i.test(message)) return '账号余额或密钥额度不足，请充值或更换可用分组后重试'
  if (/401|credential|未登录|登录|密钥|key.*失效/i.test(message)) return '当前登录或密钥已失效，请重新登录后准备分组'
  if (/429|rate.limit|限流|频繁/i.test(message)) return '请求太频繁，请稍候再试'
  if (/model.*unavailable|model.*permission|模型.*权限|模型.*不可用/i.test(message)) return '当前模型不可用，请选择其他模型后重试'
  if (/timeout|timed.?out|超时|network|连接|ECONN/i.test(message)) return '请求未完成，请检查网络后重试'
  if (/size|尺寸/.test(message)) return '当前模型不支持这个图片尺寸，请调整后重试'
  if (/quality|画质/.test(message)) return '当前模型不支持这个画质档位，请调整后重试'
  if (/invalid.parameter|parameter|参数/.test(message)) return '参数超出可用范围，请检查后重试'
  if (/可能仍|结果不明确|重复提交/.test(message)) return '请求提交结果不明确，服务端可能仍在处理，请勿立即重复提交'
  if (/^当前对话|^找不到要|^请先|^单条消息|^这段对话/.test(message)) return message
  return '本次请求没有完成，已保留内容，请稍后重试'
}

export function updateRequest(state: ChatWorkspace, requestId: string, change: (message: ChatMessage) => ChatMessage): ChatWorkspace {
  return { ...state, conversations: state.conversations.map((conversation) => {
    if (!conversation.messages.some((message) => message.requestId === requestId)) return conversation
    return { ...conversation, updatedAt: Date.now(), messages: conversation.messages.map((message) => message.requestId === requestId ? change(message) : message) }
  }) }
}
export function applyStreamEvent(state: ChatWorkspace, event: AiChatStreamEvent): ChatWorkspace {
  return updateRequest(state, event.requestId, (message) => {
    if (message.status !== 'pending' && message.status !== 'streaming') return message
    if (event.type === 'content') return { ...message, status: 'streaming', content: message.content + event.content }
    if (event.type === 'reasoning') return { ...message, status: 'streaming', reasoning: message.reasoning + event.content }
    if (event.type === 'complete') return { ...message, status: 'complete' }
    if (event.type === 'canceled') return { ...message, status: 'canceled', mayStillComplete: event.mayStillComplete }
    return { ...message, status: 'error', error: chatErrorMessage(event.message, event.code) }
  })
}
export function completeImages(state: ChatWorkspace, requestId: string, assets: AiChatAsset[]): ChatWorkspace {
  return updateRequest(state, requestId, (message) => message.status === 'pending' || message.status === 'streaming' ? { ...message, status: 'complete', assets } : message)
}

export function shouldSendOnEnter(input: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }, composing = false): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing && input.keyCode !== 229 && !composing
}
