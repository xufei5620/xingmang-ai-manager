import { describe, expect, it } from 'vitest'
import { activeConversation, applyStreamEvent, chatErrorMessage, createConversation, createWorkspace, DEFAULT_CHAT_GROUP, DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, defaultChatSettings, planTurn, resolveChatGroup, resolveChatModel, saveConversation, shouldSendOnEnter, type ChatMessage } from './state'
import { createParameterDraft, parseParameters } from './parameters'
import { historyKey, importLegacyHistory, readWorkspace, writeWorkspace } from './storage'
import { inspectModel, validateImageRequest } from './api'

function readyConversation() { const conversation = createConversation(undefined, 'conversation-1'); conversation.settings.group = 'group-a'; conversation.settings.model = 'gpt-test'; return conversation }
function turn(conversation = readyConversation()) { return planTurn(conversation, { prompt: 'first question', requestId: 'request-1', assistantId: 'assistant-1', userMessageId: 'user-1' }) }
function memoryStorage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }

describe('v2 chat request transitions', () => {
  it('starts a fresh workspace in text mode and chooses the screenshot defaults when available', () => {
    expect(defaultChatSettings()).toMatchObject({ mode: 'text', group: '', model: '' })
    expect(DEFAULT_CHAT_GROUP).toBe('GPT-中转/订阅')
    expect(DEFAULT_CHAT_MODEL).toBe('gpt-5.6-sol')
    expect(resolveChatGroup([{ name: 'default' }, { name: DEFAULT_CHAT_GROUP }])).toBe(DEFAULT_CHAT_GROUP)
    expect(resolveChatModel(['gpt-5.6-terra', DEFAULT_CHAT_MODEL])).toBe(DEFAULT_CHAT_MODEL)
    expect(resolveChatModel(['gpt-5.6-terra', DEFAULT_CHAT_MODEL], 'gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(resolveChatModel(['gpt-image-1', DEFAULT_IMAGE_MODEL], '', DEFAULT_IMAGE_MODEL)).toBe(DEFAULT_IMAGE_MODEL)
  })

  it('prefers the managed GPT group for a new conversation and preserves a valid remembered group', () => {
    const groups = [{ name: 'default' }, { name: 'GPT-中转/订阅' }, { name: '图片模型-中转/订阅' }]
    expect(resolveChatGroup(groups)).toBe('GPT-中转/订阅')
    expect(resolveChatGroup(groups, '图片模型-中转/订阅')).toBe('图片模型-中转/订阅')
    expect(resolveChatGroup(groups, '已下线分组')).toBe('GPT-中转/订阅')
    expect(resolveChatGroup([{ name: 'default' }])).toBe('default')
    expect(resolveChatGroup([])).toBe('')
  })
  it('does not append a second user message when retrying and keeps the original model snapshot', () => {
    const first = turn()
    const completed = { ...first.conversation, messages: first.conversation.messages.map((message) => ({ ...message, status: 'error' as const })) }
    completed.settings = { ...completed.settings, model: 'different-model', group: 'group-b' }
    const retry = planTurn(completed, { prompt: '', requestId: 'request-2', assistantId: 'unused', userMessageId: 'unused', retryId: 'assistant-1' })
    expect(retry.conversation.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(retry.conversation.messages.at(-1)?.requestId).toBe('request-2')
    expect(retry.settings).toMatchObject({ model: 'gpt-test', group: 'group-a' })
    expect(retry.messages).toEqual([{ role: 'user', content: 'first question' }])
  })
  it('keeps partial content and reasoning while ignoring late output after termination', () => {
    const plan = turn(); let state = saveConversation(createWorkspace('owner:7'), plan.conversation)
    state = applyStreamEvent(state, { type: 'reasoning', requestId: 'request-1', content: 'thinking' })
    state = applyStreamEvent(state, { type: 'content', requestId: 'request-1', content: 'partial' })
    state = applyStreamEvent(state, { type: 'canceled', requestId: 'request-1', mayStillComplete: true })
    state = applyStreamEvent(state, { type: 'content', requestId: 'request-1', content: ' late' })
    expect(activeConversation(state).messages.at(-1)).toMatchObject({ content: 'partial', reasoning: 'thinking', status: 'canceled', mayStillComplete: true })
    expect(activeConversation(applyStreamEvent(state, { type: 'complete', requestId: 'another-request' })).messages).toEqual(activeConversation(state).messages)
  })
  it('keeps safe stream failure reasons distinct instead of labeling every disconnect as local network trouble', () => {
    expect(chatErrorMessage('连接 AI 服务超时，请检查网络后重试', 'connection-timeout')).toBe('AI 服务响应较慢，本次等待已超时，请重试')
    expect(chatErrorMessage('AI 服务连接提前关闭，请重试', 'stream-closed')).toBe('AI 服务提前结束了本次响应，请重试')
    expect(chatErrorMessage('当前模型不可用', 'model-unavailable')).toBe('当前模型不在所选分组的可用列表中，请刷新后重新选择')
    expect(chatErrorMessage('无法连接 AI 服务，请检查网络后重试', 'network-error')).toBe('无法连接 AI 服务，请检查网络后重试')
  })
  it('edits one user turn and removes dependent later replies before resubmitting', () => {
    const first = turn(); const original = first.conversation
    original.messages[1] = { ...original.messages[1], status: 'complete', content: 'first answer' }
    original.messages.push({ id: 'later', role: 'user', content: 'later question', reasoning: '', status: 'complete', createdAt: 0 })
    const edited = planTurn(original, { prompt: 'changed question', requestId: 'request-2', assistantId: 'assistant-2', userMessageId: 'unused', editId: 'user-1' })
    expect(edited.conversation.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-2'])
    expect(edited.messages).toEqual([{ role: 'user', content: 'changed question' }])
  })
  it('rejects sending while a turn is already active without modifying the existing draft', () => {
    const first = turn(); first.conversation.draft = 'keep this draft'
    expect(() => turn(first.conversation)).toThrow('仍在生成')
    expect(first.conversation.draft).toBe('keep this draft')
  })
  it('protects composition and shifted Enter while allowing a plain Enter', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false }, true)).toBe(false)
  })
  it('validates optional numeric parameters and does not coerce blank values to zero', () => {
    expect(parseParameters(createParameterDraft({})).parameters).toEqual({})
    const invalid = { ...createParameterDraft({}), temperature: '2.1', maxTokens: '1.5', seed: 'Infinity' }
    expect(Object.keys(parseParameters(invalid).errors)).toEqual(['temperature', 'maxTokens', 'seed'])
    expect(parseParameters({ ...createParameterDraft({}), topP: '0', seed: '-1' }).parameters).toEqual({ topP: 0, seed: -1 })
  })
  it('uses the authoritative model protocol for media capabilities and validation', () => {
    expect(inspectModel('gpt-image-1.5')).toMatchObject({ available: false, hidden: true })
    expect(inspectModel('gpt-image-2')).toMatchObject({ kind: 'image', resolutions: ['1K', '2K', '4K'] })
    expect(() => validateImageRequest({ model: 'gpt-image-2', prompt: 'a scene', size: '1011x1000' })).toThrow()
  })
})

describe('v2 chat persistence ownership', () => {
  it('rejects a different owner and retains the original storage value', () => {
    const storage = memoryStorage(); const raw = JSON.stringify({ version: 2, owner: 'owner:8', conversations: [] })
    storage.setItem(historyKey('owner:7'), raw)
    expect(readWorkspace(storage, 'owner:7').warning).toBeTruthy()
    expect(storage.getItem(historyKey('owner:7'))).toBe(raw)
  })
  it('persists opaque assets but no runtime URLs or in-flight request ids', () => {
    const storage = memoryStorage(); const first = turn(); const assetId = 'a'.repeat(43)
    first.conversation.messages[1] = { ...first.conversation.messages[1], assets: [{ assetId, localUrl: 'https://private.example.test/a', mimeType: 'image/png', fileName: 'a.png' }] }
    const state = saveConversation(createWorkspace('owner:7'), first.conversation)
    writeWorkspace(storage, state)
    const serialized = storage.getItem(historyKey('owner:7'))!
    expect(serialized).not.toContain('https://private')
    expect(serialized).not.toContain('request-1')
    const loaded = activeConversation(readWorkspace(storage, 'owner:7').state).messages.at(-1)!
    expect(loaded.status).toBe('canceled')
    expect(loaded.assets?.[0].localUrl).toBe(`xingmang-asset://image/${assetId}`)
  })
  it('imports the previous version without changing its source and refuses another account scope', () => {
    const storage = memoryStorage(); const messages: ChatMessage[] = [{ id: 'old-message', role: 'user', content: 'old question', reasoning: '', status: 'complete', createdAt: 0 }]
    const raw = JSON.stringify({ version: 1, userId: '7', data: { group: 'group-a', model: 'gpt-test', messages } })
    storage.setItem('xingmang-ai-chat:v1:7', raw)
    for (const scope of ['xm-account:7', 'solov:7', 'sub2api:7']) {
      expect(importLegacyHistory(storage, scope, 7)?.conversations[0].messages[0].content).toBe('old question')
    }
    expect(importLegacyHistory(storage, 'solov-api:7', 7)).toBeNull()
    expect(importLegacyHistory(storage, 'xm-account:8', 7)).toBeNull()
    expect(storage.getItem('xingmang-ai-chat:v1:7')).toBe(raw)
  })
})
