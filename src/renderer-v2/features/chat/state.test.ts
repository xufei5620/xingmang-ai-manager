import { describe, expect, it } from 'vitest'
import { networkFailureMessages } from '../../../../electron/network-failure'
import { relayQuotaFailureMessages } from '../../../../electron/relay-quota-failure'
import { activeConversation, applyStreamEvent, chatErrorAction, chatErrorMessage, createConversation, createWorkspace, DEFAULT_CHAT_GROUP, DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, defaultChatSettings, filterConversations, planTurn, resolveChatGroup, resolveChatModel, saveConversation, shouldSendOnEnter, type ChatMessage, type ChatWorkspace } from './state'
import { createParameterDraft, parseParameters } from './parameters'
import { historyKey, importLegacyHistory, readWorkspace, writeWorkspace } from './storage'
import { chatLimits, inspectModel, validateImageRequest } from './api'

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

  it('selects Sub2API Codex_pro independently of NewAPI groups', () => {
    const groups = [{ name: 'GPT-中转/订阅' }, { name: 'Codex_pro' }]
    expect(resolveChatGroup(groups, '', 'solov-api')).toBe('Codex_pro')
    expect(resolveChatGroup(groups, '', 'solov')).toBe('GPT-中转/订阅')
  })

  it('prefers the managed GPT group for a new conversation and preserves a valid remembered group', () => {
    const groups = [{ name: 'default' }, { name: 'GPT-中转/订阅' }, { name: '图片模型-中转/订阅' }]
    expect(resolveChatGroup(groups)).toBe('GPT-中转/订阅')
    expect(resolveChatGroup(groups, '图片模型-中转/订阅')).toBe('图片模型-中转/订阅')
    expect(resolveChatGroup(groups, '已下线分组')).toBe('GPT-中转/订阅')
    expect(resolveChatGroup([{ name: 'default' }])).toBe('default')
    expect(resolveChatGroup([])).toBe('')
  })
  it('tells the user to start a new conversation once one reply is longer than a single message may be', () => {
    const first = turn()
    const long = 'a'.repeat(chatLimits.messageLength + 1)
    const completed = { ...first.conversation, messages: first.conversation.messages.map((message) => message.role === 'assistant' ? { ...message, status: 'complete' as const, content: long } : message) }
    const next = () => planTurn(completed, { prompt: 'next question', requestId: 'request-2', assistantId: 'assistant-2', userMessageId: 'user-2' })
    expect(next).toThrow('这段对话里有一条回复太长，请新建对话后继续')
    let thrown: unknown
    try { next() } catch (error) { thrown = error }
    expect(chatErrorMessage(thrown)).toBe('这段对话里有一条回复太长，请新建对话后继续')
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
    expect(chatErrorMessage(new Error("Error invoking remote method 'ai:image-generate': Error: 保存位置写不进去，这次没有扣费。请联系客服帮你处理。")))
      .toBe('保存位置写不进去，这次没有扣费。请联系客服帮你处理。')
    expect(chatErrorMessage('连接 AI 服务超时，请检查网络后重试', 'connection-timeout')).toBe('AI 服务响应较慢，本次等待已超时，请重试')
    expect(chatErrorMessage('AI 服务连接提前关闭，请重试', 'stream-closed')).toBe('AI 服务提前结束了本次响应，请重试')
    expect(chatErrorMessage('当前模型不可用', 'model-unavailable')).toBe('当前模型不在所选分组的可用列表中，请刷新后重新选择')
    expect(chatErrorMessage('无法连接 AI 服务，请检查网络后重试', 'network-error')).toBe('无法连接 AI 服务，请检查网络后重试')
  })
  it('keeps the partial reply and shows the main-process cut-off note when a stream times out', () => {
    const plan = turn(); let state = saveConversation(createWorkspace('owner:7'), plan.conversation)
    state = applyStreamEvent(state, { type: 'reasoning', requestId: 'request-1', content: '先想一下' })
    state = applyStreamEvent(state, { type: 'content', requestId: 'request-1', content: '前半段' })
    const note = '回复太久没有新内容，已经停下；上面是已经收到的部分，这部分可能已经计费'
    state = applyStreamEvent(state, { type: 'error', requestId: 'request-1', code: 'idle-timeout', message: note })
    expect(activeConversation(state).messages.at(-1)).toMatchObject({ content: '前半段', reasoning: '先想一下', status: 'error', error: note })
    expect(chatErrorMessage('', 'idle-timeout')).toBe('AI 服务太久没有返回内容，已经停下，请重试')
    expect(chatErrorMessage('', 'total-timeout')).toBe('本次对话超过最长处理时间，已经停下，请重试')
  })
  it('keeps the do-not-resubmit warning when a paid image request times out or cannot be saved', () => {
    const timeout = '生图请求超时；服务端可能仍在生成图片，请勿立即重复提交'
    expect(chatErrorMessage(new Error(`Error invoking remote method 'ai:image-generate': Error: ${timeout}`))).toBe(timeout)
    const downloaded = '图片已生成但下载失败，这次可能已经扣费，请勿立即重复提交；先检查网络，稍后再重新生成'
    expect(chatErrorMessage(new Error(downloaded))).toBe(downloaded)
    const video = '视频任务已创建但本地恢复记录保存失败（任务 video_1），请勿重复提交'
    expect(chatErrorMessage(video)).toBe(video)
    expect(chatErrorMessage('生图请求超时')).toBe('请求未完成，请检查网络后重试')
  })
  it('keeps the network reason when preparing the group fails offline', () => {
    expect(chatErrorMessage(networkFailureMessages.offline, 'network-error')).toBe(networkFailureMessages.offline)
    expect(chatErrorMessage('无法连接 AI 服务，请检查网络后重试', 'network-error')).toBe('无法连接 AI 服务，请检查网络后重试')
  })
  it('never turns a service outage back into an expired login or a broken key', () => {
    const outage = networkFailureMessages.serviceUnavailable
    expect(chatErrorMessage(outage, 'service-unavailable')).toBe(outage)
    // 准备分组时没有错误码，原话里带着 HTTP 码；以前 /登录|密钥/ 那条会先撞上。
    expect(chatErrorMessage(new Error(`${outage}（HTTP 503：登录服务维护中）`))).toBe(outage)
  })

  it('keeps the main process quota sentences and offers the matching account page', () => {
    const wrapped = `Error invoking remote method 'ai-image:generate': Error: ${relayQuotaFailureMessages.keyLimit}`
    expect(chatErrorMessage(new Error(wrapped))).toBe(relayQuotaFailureMessages.keyLimit)
    expect(chatErrorMessage(relayQuotaFailureMessages.balance, 'upstream-http-error')).toBe(relayQuotaFailureMessages.balance)
    expect(chatErrorAction(relayQuotaFailureMessages.balance)).toBe('recharge')
    expect(chatErrorAction(relayQuotaFailureMessages.keyLimit)).toBe('keys')
    expect(chatErrorAction(relayQuotaFailureMessages.keyInvalid)).toBeNull()
    expect(chatErrorAction(undefined)).toBeNull()
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
  for (const alias of ['solov', 'sub2api']) it(`migrates the ${alias} alias only into the same xm realm and preserves its source`, () => {
    const storage = memoryStorage()
    const old = saveConversation(createWorkspace(`${alias}:7`), readyConversation())
    old.conversations[0].draft = 'previous draft'
    writeWorkspace(storage, old)
    const source = storage.getItem(historyKey(`${alias}:7`))
    expect(readWorkspace(storage, 'api-account:7').exists).toBe(false)
    expect(readWorkspace(storage, 'xm-account:8').exists).toBe(false)
    const migrated = readWorkspace(storage, 'xm-account:7')
    expect(migrated.warning).toBeUndefined()
    expect(migrated.state.owner).toBe('xm-account:7')
    expect(migrated.state.conversations[0].draft).toBe('previous draft')
    expect(storage.getItem(historyKey(`${alias}:7`))).toBe(source)
    expect(JSON.parse(storage.getItem(historyKey('xm-account:7'))!).owner).toBe('xm-account:7')
    writeWorkspace(storage, createWorkspace('xm-account:7'))
    expect(readWorkspace(storage, 'xm-account:7').state.conversations).toHaveLength(0)
  })
  it('does not relabel a mismatched old owner or hide readable history after a migration write failure', () => {
    const storage = memoryStorage()
    storage.setItem(historyKey('solov:7'), JSON.stringify(createWorkspace('solov:8')))
    expect(readWorkspace(storage, 'xm-account:7').warning).toBeTruthy()
    expect(storage.getItem(historyKey('xm-account:7'))).toBeNull()
    writeWorkspace(storage, saveConversation(createWorkspace('solov:7'), readyConversation()))
    const blocked = { getItem: storage.getItem, setItem: () => { throw new Error('storage full') } }
    const migrated = readWorkspace(blocked, 'xm-account:7')
    expect(migrated.warning).toContain('迁移未保存')
    expect(migrated.state.conversations).toHaveLength(1)
    expect(storage.getItem(historyKey('xm-account:7'))).toBeNull()
  })
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

function watchedConversation(id: string, title: string, body: string) {
  let reads = 0
  const message: ChatMessage = { id: `${id}-message`, role: 'user', content: '', reasoning: '', status: 'complete', createdAt: 0 }
  Object.defineProperty(message, 'content', { get: () => { reads += 1; return body }, enumerable: true })
  return { conversation: { ...createConversation(defaultChatSettings(), id), title, messages: [message] }, reads: () => reads }
}

describe('v2 chat conversation search', () => {
  it('matches titles and message bodies regardless of case and surrounding spaces', () => {
    const deployment = watchedConversation('conversation-a', '部署脚本', '这里讨论了发布流程')
    const billing = watchedConversation('conversation-b', '账号问题', '关于 Billing 明细的讨论')
    const conversations = [deployment.conversation, billing.conversation]
    expect(filterConversations(conversations, '部署')).toEqual([deployment.conversation])
    expect(filterConversations(conversations, ' billing ')).toEqual([billing.conversation])
    expect(filterConversations(conversations, '没有这个词')).toEqual([])
  })

  it('reads no conversation body while the search box is empty', () => {
    const first = watchedConversation('conversation-a', '部署脚本', '这里讨论了发布流程')
    const second = watchedConversation('conversation-b', '账号问题', '关于账单的讨论')
    const conversations = [first.conversation, second.conversation]
    expect(filterConversations(conversations, '')).toEqual(conversations)
    expect(filterConversations(conversations, '   ')).toEqual(conversations)
    expect(first.reads() + second.reads()).toBe(0)
  })

  it('rescans only the conversation a stream chunk changed', () => {
    const idle = watchedConversation('conversation-idle', '历史对话', '一段很长的历史正文')
    const live = { ...createConversation(defaultChatSettings(), 'conversation-live'), title: '正在生成', messages: [{ id: 'assistant-1', role: 'assistant' as const, content: '', reasoning: '', status: 'streaming' as const, createdAt: 0, requestId: 'request-1' }] }
    let state: ChatWorkspace = { ...createWorkspace('xm-account:1'), conversations: [idle.conversation, live] }
    for (let chunk = 0; chunk < 20; chunk += 1) {
      state = applyStreamEvent(state, { requestId: 'request-1', type: 'content', content: '词' })
      expect(filterConversations(state.conversations, '历史')).toEqual([idle.conversation])
    }
    expect(idle.reads()).toBe(1)
  })
})
