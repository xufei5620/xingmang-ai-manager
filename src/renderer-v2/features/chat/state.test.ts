import { describe, expect, it } from 'vitest'
import type { AiChatAsset } from '../../../../electron/ipc-contract'
import { networkFailureMessages } from '../../../../electron/network-failure'
import { relayQuotaFailureMessages } from '../../../../electron/relay-quota-failure'
import { activeConversation, addDraftImages, applyStreamEvent, attachmentErrorMessage, buildChatCatalog, chatErrorAction, chatErrorMessage, chatModelVendor, chatModelVendors, continueInNewConversation, conversationContextShare, conversationDay, conversationReplyTooLongMessage, conversationTooLongMessage, createConversation, createWorkspace, DEFAULT_CHAT_GROUP, DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODELS, defaultChatSettings, filterConversations, groupConversationsByDay, isConversationTooLongMessage, noImageModelMessage, pendingChatGroups, pickChatGroup, planTurn, recommendedChatGroup, removeDraftImage, resolveChatModel, resolveDefaultChatModel, saveConversation, settleChatModel, shouldSendOnEnter, shouldShowLengthNotice, type ChatMessage, type ChatSettings, type ChatWorkspace } from './state'
import { createParameterDraft, parseParameters } from './parameters'
import { historyKey, importLegacyHistory, parseHistorySnapshot, planHistoryWrite, readWorkspace } from './storage'
import { chatLimits, inspectModel, validateImageRequest } from './api'

function readyConversation() { const conversation = createConversation(undefined, 'conversation-1'); conversation.settings.group = 'group-a'; conversation.settings.model = 'gpt-test'; return conversation }
function turn(conversation = readyConversation()) { return planTurn(conversation, { prompt: 'first question', requestId: 'request-1', assistantId: 'assistant-1', userMessageId: 'user-1' }) }
function memoryStorage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
// Earlier versions kept the workspace in localStorage; these tests seed that migration source directly.
function seed(storage: ReturnType<typeof memoryStorage>, state: ChatWorkspace) { storage.setItem(historyKey(state.owner), JSON.stringify(state)) }

describe('v2 chat request transitions', () => {
  it('starts a fresh workspace in text mode and chooses the screenshot defaults when available', () => {
    expect(defaultChatSettings()).toMatchObject({ mode: 'text', group: '', model: '' })
    expect(DEFAULT_CHAT_GROUP).toBe('GPT')
    expect(DEFAULT_CHAT_MODEL).toBe('gpt-5.6-sol')
    expect(recommendedChatGroup([{ name: 'default' }, { name: DEFAULT_CHAT_GROUP }])).toBe(DEFAULT_CHAT_GROUP)
    expect(resolveChatModel(['gpt-5.6-terra', DEFAULT_CHAT_MODEL])).toBe(DEFAULT_CHAT_MODEL)
    expect(resolveChatModel(['gpt-5.6-terra', DEFAULT_CHAT_MODEL], 'gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(resolveChatModel(['gpt-image-1', 'gpt-image-2'], '', DEFAULT_IMAGE_MODELS)).toBe('gpt-image-2')
  })

  it('defaults image mode to GPT Image 2.5 flare when the group lists it, like the Xingmang image skill', () => {
    expect(resolveChatModel(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'], '', DEFAULT_IMAGE_MODELS)).toBe('gpt-image-2.5-flare')
    expect(resolveChatModel(['gpt-image-2.5-sunburst', 'gpt-image-2'], '', DEFAULT_IMAGE_MODELS)).toBe('gpt-image-2')
    expect(resolveChatModel(['gpt-image-2.5-sunburst', 'gpt-image-1'], '', DEFAULT_IMAGE_MODELS)).toBe('gpt-image-2.5-sunburst')
    expect(resolveChatModel(['gpt-image-2', 'gpt-image-2.5-flare'], 'gpt-image-2', DEFAULT_IMAGE_MODELS)).toBe('gpt-image-2')
    expect(resolveChatModel([], '', DEFAULT_IMAGE_MODELS)).toBe('')
  })

  it('falls back to the newest model in the text default family instead of the alphabetically first one', () => {
    const listed = ['gpt-5.4', 'gpt-5.6-terra', DEFAULT_CHAT_MODEL, 'gpt-6-astra', 'gpt-6.1-sol']
    expect(resolveDefaultChatModel('text', listed)).toBe(DEFAULT_CHAT_MODEL)
    const retired = listed.filter((model) => model !== DEFAULT_CHAT_MODEL)
    expect(resolveDefaultChatModel('text', retired)).toBe('gpt-6.1-sol')
    expect(resolveDefaultChatModel('text', retired, 'gpt-5.4')).toBe('gpt-5.4')
    expect(resolveDefaultChatModel('text', ['gpt-5.4', 'gpt-6-astra'])).toBe('gpt-5.4')
    expect(resolveDefaultChatModel('text', [])).toBe('')
  })

  it('keeps the image defaults and the main-process image order', () => {
    expect(resolveDefaultChatModel('image', ['gpt-image-2', 'gpt-image-2.5-flare'])).toBe('gpt-image-2.5-flare')
    expect(resolveDefaultChatModel('image', ['gpt-image-2.5-sunburst', 'gpt-image-1'])).toBe('gpt-image-2.5-sunburst')
    expect(resolveDefaultChatModel('image', ['gpt-image-2', 'gpt-image-2.5-flare'], 'gpt-image-2')).toBe('gpt-image-2')
  })

  it('selects Sub2API Codex_pro independently of NewAPI groups', () => {
    const groups = [{ name: 'GPT' }, { name: 'Codex_pro' }]
    expect(pickChatGroup(['GPT', 'Codex_pro'], { current: '', mode: 'text', groups, site: 'solov-api' })).toBe('Codex_pro')
    expect(pickChatGroup(['GPT', 'Codex_pro'], { current: '', mode: 'text', groups, site: 'solov' })).toBe('GPT')
  })

  it('bills a model several groups offer to the conversation group, then the recommended one, then the cheapest, then the first', () => {
    const groups = [{ name: 'default', ratio: 1 }, { name: 'GPT', ratio: 1 }, { name: '图片模型', ratio: 1 }, { name: 'cheap', ratio: '0.5' }]
    expect(pickChatGroup(['default', 'GPT', '图片模型'], { current: '', mode: 'text', groups })).toBe('GPT')
    expect(pickChatGroup(['default', 'GPT', '图片模型'], { current: '图片模型', mode: 'text', groups })).toBe('图片模型')
    expect(pickChatGroup(['default', 'GPT', '图片模型'], { current: '已下线分组', mode: 'text', groups })).toBe('GPT')
    expect(pickChatGroup(['default', 'GPT', '图片模型'], { current: '', mode: 'image', groups })).toBe('图片模型')
    expect(pickChatGroup(['default', 'cheap'], { current: '', mode: 'text', groups })).toBe('cheap')
    expect(pickChatGroup(['default', 'odd'], { current: '', mode: 'text', groups: [{ name: 'default', ratio: 1 }, { name: 'odd', ratio: 'n/a' }] })).toBe('default')
    expect(pickChatGroup(['default'], { current: '', mode: 'text', groups })).toBe('default')
    expect(pickChatGroup([], { current: 'GPT', mode: 'text', groups })).toBe('')
  })

  it('follows the group the main process recommends once the managed GPT group is renamed', () => {
    const renamed = [{ name: 'default' }, { name: 'GPT 主力', recommended: true as const }, { name: 'GPT-官方API直连' }, { name: 'GPT' }]
    const candidates = renamed.map((group) => group.name)
    expect(recommendedChatGroup(renamed)).toBe('GPT 主力')
    expect(pickChatGroup(candidates, { current: '', mode: 'text', groups: renamed })).toBe('GPT 主力')
    expect(pickChatGroup(candidates, { current: 'GPT-官方API直连', mode: 'text', groups: renamed })).toBe('GPT-官方API直连')
    expect(recommendedChatGroup([{ name: 'default' }])).toBe('')
  })

  it('files models under their vendor in a fixed order and puts the rest under 其他', () => {
    expect(chatModelVendors[0]).toBe('OpenAI')
    expect(chatModelVendors.at(-1)).toBe('其他')
    expect(['gpt-5.6-sol', 'o3-mini', 'gpt-image-2', 'codex-mini'].map(chatModelVendor)).toEqual(['OpenAI', 'OpenAI', 'OpenAI', 'OpenAI'])
    expect(['claude-sonnet-4-5', 'gemini-3.1-flash-image', 'grok-imagine-image', 'deepseek-v3', 'qwen3-max', 'glm-4.6', 'kimi-k2', 'MiniMax-M2', 'jimeng-4.0']
      .map(chatModelVendor)).toEqual(['Claude', 'Gemini', 'Grok', 'DeepSeek', '通义千问', '智谱 GLM', 'Kimi', 'MiniMax', '即梦'])
    expect(chatModelVendor('other-model')).toBe('其他')
  })

  it('merges the models of every group into one list per mode, once each, in the backend order', () => {
    const groups = [{ name: 'group-a' }, { name: 'group-b' }, { name: 'group-c' }, { name: 'group-d' }]
    const preparations = {
      'group-a': { phase: 'ready' as const, models: ['gpt-test', 'gpt-image-2', 'claude-test'] },
      'group-b': { phase: 'ready' as const, models: ['claude-test', 'other-model', 'grok-imagine-image'] },
      'group-c': { phase: 'error' as const, models: [] },
      // 正在重新读的分组先照旧列着上一回的模型。
      'group-d': { phase: 'loading' as const, models: ['deepseek-v3'] },
      'gone-group': { phase: 'ready' as const, models: ['kimi-k2'] },
    }
    expect(buildChatCatalog(groups, preparations, 'text')).toEqual([
      { model: 'gpt-test', groups: ['group-a'] },
      { model: 'claude-test', groups: ['group-a', 'group-b'] },
      { model: 'other-model', groups: ['group-b'] },
      { model: 'deepseek-v3', groups: ['group-d'] },
    ])
    expect(buildChatCatalog(groups, preparations, 'image')).toEqual([
      { model: 'gpt-image-2', groups: ['group-a'] },
      { model: 'grok-imagine-image', groups: ['group-b'] },
    ])
    expect([...pendingChatGroups(groups, preparations)]).toEqual(['group-d'])
    expect([...pendingChatGroups([...groups, { name: 'queued' }], preparations)]).toEqual(['group-d', 'queued'])
  })

  it('settles a remembered model on a group that offers it and only falls back to a default once every group is read', () => {
    const groups = [{ name: 'group-a' }, { name: 'GPT' }, { name: 'group-b' }]
    const settings = (patch: Partial<ChatSettings>): ChatSettings => ({ ...defaultChatSettings(), ...patch })
    const catalog = [{ model: 'gpt-test', groups: ['group-a'] }, { model: DEFAULT_CHAT_MODEL, groups: ['GPT'] }, { model: 'other-model', groups: ['group-b', 'GPT'] }]
    const settled = { pending: new Set<string>(), groups }
    // A model still offered keeps it and moves the billing group only when its own group no longer has it.
    expect(settleChatModel(settings({ group: 'group-b', model: 'other-model' }), catalog, settled)).toEqual({ group: 'group-b', model: 'other-model' })
    expect(settleChatModel(settings({ group: 'retired', model: 'other-model' }), catalog, settled)).toEqual({ group: 'GPT', model: 'other-model' })
    // While its own group is still being read, nothing moves.
    expect(settleChatModel(settings({ group: 'group-b', model: 'other-model' }), [catalog[0]], { pending: new Set(['group-b']), groups })).toEqual({ group: 'group-b', model: 'other-model' })
    // A new conversation takes the default as soon as it is listed, without waiting for the rest.
    expect(settleChatModel(settings({}), catalog, { pending: new Set(['group-b']), groups })).toEqual({ group: 'GPT', model: DEFAULT_CHAT_MODEL })
    expect(settleChatModel(settings({}), [catalog[0]], { pending: new Set(['GPT']), groups })).toEqual({ group: '', model: '' })
    // A model nobody offers any more is replaced once everything is read, unless a background refresh asked to keep it.
    expect(settleChatModel(settings({ group: 'group-a', model: 'gpt-5.5' }), catalog, settled)).toEqual({ group: 'GPT', model: DEFAULT_CHAT_MODEL })
    expect(settleChatModel(settings({ group: 'group-a', model: 'gpt-5.5' }), catalog, { ...settled, keepMissing: true })).toEqual({ group: 'group-a', model: 'gpt-5.5' })
    expect(settleChatModel(settings({ group: 'group-a', model: 'gpt-5.5' }), catalog, { pending: new Set(['group-b']), groups })).toEqual({ group: 'group-a', model: 'gpt-5.5' })
    expect(settleChatModel(settings({ group: 'group-a', model: 'gpt-5.5' }), [], settled)).toEqual({ group: 'group-a', model: 'gpt-5.5' })
    // Image mode prefers the image group and the image defaults.
    const images = [{ model: 'gpt-image-2', groups: ['GPT', '图片模型'] }, { model: 'grok-imagine-image', groups: ['group-b'] }]
    expect(settleChatModel(settings({ mode: 'image' }), images, { pending: new Set(), groups: [...groups, { name: '图片模型' }] })).toEqual({ group: '图片模型', model: 'gpt-image-2' })
  })

  it('tells the user to start a new conversation once one reply is longer than a single message may be', () => {
    const first = turn()
    const long = 'a'.repeat(chatLimits.messageLength + 1)
    const completed = { ...first.conversation, messages: first.conversation.messages.map((message) => message.role === 'assistant' ? { ...message, status: 'complete' as const, content: long } : message) }
    const next = () => planTurn(completed, { prompt: 'next question', requestId: 'request-2', assistantId: 'assistant-2', userMessageId: 'user-2' })
    expect(next).toThrow(conversationReplyTooLongMessage)
    let thrown: unknown
    try { next() } catch (error) { thrown = error }
    expect(chatErrorMessage(thrown)).toBe(conversationReplyTooLongMessage)
    expect(isConversationTooLongMessage(chatErrorMessage(thrown))).toBe(true)
  })
  it('stops a conversation past the context limit with a message that offers to move on', () => {
    const conversation = readyConversation()
    conversation.messages = Array.from({ length: chatLimits.messageCount }, (_, index): ChatMessage => ({ id: `m-${index}`, role: index % 2 ? 'assistant' : 'user', content: `line ${index}`, reasoning: '', status: 'complete', createdAt: index }))
    let thrown: unknown
    try { planTurn(conversation, { prompt: 'one more', requestId: 'r', assistantId: 'a', userMessageId: 'u' }) } catch (error) { thrown = error }
    expect(chatErrorMessage(thrown)).toBe(conversationTooLongMessage)
    expect(isConversationTooLongMessage(conversationTooLongMessage)).toBe(true)
    expect(isConversationTooLongMessage('请求太频繁，请稍候再试')).toBe(false)
  })
  it('warns once a text conversation carries seven tenths of either limit and stays quiet after it is dismissed', () => {
    const conversation = readyConversation()
    const lines = (count: number) => Array.from({ length: count }, (_, index): ChatMessage => ({ id: `m-${index}`, role: index % 2 ? 'assistant' : 'user', content: 'x', reasoning: '', status: 'complete', createdAt: index }))
    expect(shouldShowLengthNotice({ ...conversation, messages: lines(69) })).toBe(false)
    expect(shouldShowLengthNotice({ ...conversation, messages: lines(70) })).toBe(true)
    const heavy = [{ ...lines(1)[0], content: 'x'.repeat(chatLimits.totalMessageLength * 0.7) }]
    expect(conversationContextShare({ ...conversation, messages: heavy })).toBeCloseTo(0.7)
    expect(shouldShowLengthNotice({ ...conversation, messages: heavy })).toBe(true)
    // Failed replies and generated images are never sent back, so they must not count towards the warning.
    const failed = lines(80).map((message) => message.role === 'assistant' ? { ...message, status: 'error' as const } : message)
    expect(shouldShowLengthNotice({ ...conversation, messages: failed })).toBe(false)
    expect(shouldShowLengthNotice({ ...conversation, messages: lines(70), lengthNoticeDismissed: true })).toBe(false)
    expect(shouldShowLengthNotice({ ...conversation, settings: { ...conversation.settings, mode: 'image' }, messages: lines(70) })).toBe(false)
  })
  it('opens a new conversation with the same settings and moves the unsent text without sending it', () => {
    const state = createWorkspace('owner')
    const source = { ...readyConversation(), draft: 'unsent question', messages: [{ id: 'm', role: 'user' as const, content: 'old', reasoning: '', status: 'complete' as const, createdAt: 1 }] }
    source.settings.parameters = { temperature: 0.3 }
    state.conversations = [source]
    state.activeId = source.id
    const moved = continueInNewConversation(state, source.id, source.draft, true)
    const next = activeConversation(moved)
    expect(next.id).not.toBe(source.id)
    expect(next).toMatchObject({ draft: 'unsent question', messages: [], settings: { group: 'group-a', model: 'gpt-test', parameters: { temperature: 0.3 } } })
    expect(next.settings.parameters).not.toBe(source.settings.parameters)
    expect(moved.conversations.find((item) => item.id === source.id)).toMatchObject({ draft: '', messages: source.messages })
    // Text carried out of the edit dialog leaves the source draft alone.
    const edited = continueInNewConversation(state, source.id, 'edited text', false)
    expect(activeConversation(edited).draft).toBe('edited text')
    expect(edited.conversations.find((item) => item.id === source.id)?.draft).toBe('unsent question')
    expect(continueInNewConversation(state, 'missing', 'x', true)).toBe(state)
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
    expect(chatErrorMessage('当前模型不可用', 'model-unavailable')).toBe('当前模型暂时用不了，请刷新模型后重新选择')
    expect(chatErrorMessage('无法连接 AI 服务，请检查网络后重试', 'network-error')).toBe('无法连接 AI 服务，请检查网络后重试')
  })
  it('shows an image refusal the main process already worded instead of asking for a retry', () => {
    const blocked = '这次的描述或参考图没通过安全审核，没有生成图片。改一改描述或换一张图再试。'
    expect(chatErrorMessage(new Error(`Error invoking remote method 'ai:image-generate': Error: ${blocked}`))).toBe(blocked)
    const tooLarge = '参考图太大了，服务端收不下。换一张小一点的图，或者压缩一下再试。'
    expect(chatErrorMessage(new Error(tooLarge))).toBe(tooLarge)
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
  it('tells a signed-out customer to sign in instead of calling their login expired', () => {
    expect(chatErrorMessage(new Error("Error invoking remote method 'chat:list-groups': Error: 请先登录星芒账号"))).toBe('请先登录星芒账号')
    expect(chatErrorMessage(new Error("Error invoking remote method 'chat:prepare-group': RealmAccountError: 请先登录账号"))).toBe('请先登录账号')
    expect(chatErrorMessage('请先登录星芒账号')).toBe('请先登录星芒账号')
    // 真的失效了照旧归到「请重新登录」。
    expect(chatErrorMessage(new Error("Error invoking remote method 'chat:prepare-group': Error: 登录已过期"))).toBe('当前登录或密钥已失效，请重新登录后准备分组')
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
  it('says what to type when a whole number is expected, and gives the range only when the number is whole', () => {
    const { errors } = parseParameters({ ...createParameterDraft({}), maxTokens: '1.5', seed: 'abc' })
    expect(errors).toEqual({ maxTokens: '最大输出 Token 要填整数，比如 4096', seed: '随机种子要填整数' })
    expect(parseParameters({ ...createParameterDraft({}), maxTokens: '0', seed: '3000000000' }).errors).toEqual({ maxTokens: '请输入 1 至 131072 之间的整数', seed: '请输入 -2147483648 至 2147483647 之间的整数' })
    expect(parseParameters({ ...createParameterDraft({}), temperature: '2.1' }).errors).toEqual({ temperature: '请输入 0 至 2 之间的数值' })
  })
  it('sorts conversations into today, yesterday and earlier by the local calendar day, keeping their order', () => {
    const now = new Date(2026, 9, 15, 0, 30).getTime()
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime()
    expect([conversationDay(at(15, 0), now), conversationDay(at(14, 23), now), conversationDay(at(14, 0), now), conversationDay(at(13, 23), now)]).toEqual(['今天', '昨天', '昨天', '更早'])
    const conversation = (id: string, updatedAt: number) => ({ ...createConversation(undefined, id), updatedAt })
    const grouped = groupConversationsByDay([conversation('a', at(15, 0)), conversation('b', at(1, 9)), conversation('c', at(15, 0)), conversation('d', at(14, 9))], now)
    expect(grouped.map((group) => [group.day, group.conversations.map((item) => item.id)])).toEqual([['今天', ['a', 'c']], ['昨天', ['d']], ['更早', ['b']]])
    expect(groupConversationsByDay([conversation('e', at(2, 9))], now).map((group) => group.day)).toEqual(['更早'])
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
    seed(storage, old)
    const source = storage.getItem(historyKey(`${alias}:7`))
    expect(readWorkspace(storage, 'api-account:7').exists).toBe(false)
    expect(readWorkspace(storage, 'xm-account:8').exists).toBe(false)
    const migrated = readWorkspace(storage, 'xm-account:7')
    expect(migrated.warning).toBeUndefined()
    expect(migrated.state.owner).toBe('xm-account:7')
    expect(migrated.state.conversations[0].draft).toBe('previous draft')
    expect(storage.getItem(historyKey(`${alias}:7`))).toBe(source)
    expect(storage.getItem(historyKey('xm-account:7'))).toBeNull()
    seed(storage, createWorkspace('xm-account:7'))
    expect(readWorkspace(storage, 'xm-account:7').state.conversations).toHaveLength(0)
  })
  it('does not relabel a mismatched old owner and reads readable migration sources without writing them', () => {
    const storage = memoryStorage()
    storage.setItem(historyKey('solov:7'), JSON.stringify(createWorkspace('solov:8')))
    expect(readWorkspace(storage, 'xm-account:7').warning).toBeTruthy()
    expect(storage.getItem(historyKey('xm-account:7'))).toBeNull()
    seed(storage, saveConversation(createWorkspace('solov:7'), readyConversation()))
    const readOnly = { getItem: storage.getItem, setItem: () => { throw new Error('migration must not write localStorage') } }
    const migrated = readWorkspace(readOnly, 'xm-account:7')
    expect(migrated.warning).toBeUndefined()
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
    const first = turn(); const assetId = 'a'.repeat(43)
    first.conversation.messages[1] = { ...first.conversation.messages[1], assets: [{ assetId, localUrl: 'https://private.example.test/a', mimeType: 'image/png', fileName: 'a.png' }] }
    const state = saveConversation(createWorkspace('owner:7'), first.conversation)
    const { write } = planHistoryWrite(state, null)!
    const serialized = [write.index, ...write.put.map((file) => file.content)].join('\n')
    expect(serialized).not.toContain('https://private')
    expect(serialized).not.toContain('request-1')
    const loaded = activeConversation(parseHistorySnapshot({ index: write.index, conversations: write.put }, 'owner:7').state).messages.at(-1)!
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

describe('v2 chat attached images', () => {
  const image = (letter: string): AiChatAsset => ({ assetId: letter.repeat(43), localUrl: `xingmang-asset://image/${letter.repeat(43)}`, mimeType: 'image/png', fileName: 'shot.png' })
  function visionConversation() { const conversation = readyConversation(); conversation.settings.model = 'claude-test'; return conversation }

  it('sends draft images with the new message, allows an empty prompt and clears the draft', () => {
    const conversation = { ...visionConversation(), draftImages: [image('A')] }
    const plan = planTurn(conversation, { prompt: '', images: conversation.draftImages, requestId: 'r', assistantId: 'a', userMessageId: 'u' })
    expect(plan.messages).toEqual([{ role: 'user', content: '', images: ['A'.repeat(43)] }])
    expect(plan.conversation.messages[0].assets).toEqual([image('A')])
    expect(plan.conversation.draftImages).toBeUndefined()
    expect(plan.conversation.title).toBe('图片提问')
  })

  it('refuses images for a model that cannot read them and for image generation', () => {
    const plain = readyConversation()
    expect(() => planTurn(plain, { prompt: 'x', images: [image('A')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow(noImageModelMessage)
    const drawing = visionConversation(); drawing.settings.mode = 'image'
    expect(() => planTurn(drawing, { prompt: 'x', images: [image('A')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow('生成图片时还不能带图片')
    expect(chatErrorMessage(new Error(noImageModelMessage))).toBe(noImageModelMessage)
    expect(chatErrorMessage(new Error('this model cannot read images'))).toBe(noImageModelMessage)
  })

  it('keeps the newest images within the per-request limit and describes the rest', () => {
    const conversation = visionConversation()
    const user = (id: string, letters: string[]): ChatMessage => ({ id, role: 'user', content: id, reasoning: '', status: 'complete', createdAt: 1, assets: letters.map(image) })
    const reply = (id: string): ChatMessage => ({ id, role: 'assistant', content: 'ok', reasoning: '', status: 'complete', createdAt: 1 })
    conversation.messages = [user('old', ['A', 'B']), reply('r1'), user('mid', ['C', 'D', 'E', 'F']), reply('r2')]
    const plan = planTurn(conversation, { prompt: 'new', images: ['G', 'H', 'I', 'J'].map(image), requestId: 'r', assistantId: 'a', userMessageId: 'u' })
    expect(plan.messages[0]).toEqual({ role: 'user', content: 'old\n（这里附过 2 张图片，这次没有再发给 AI）' })
    expect(plan.messages[2]).toMatchObject({ images: ['C', 'D', 'E', 'F'].map((letter) => letter.repeat(43)) })
    expect(plan.messages[4]).toMatchObject({ images: ['G', 'H', 'I', 'J'].map((letter) => letter.repeat(43)) })
    expect(plan.messages.flatMap((message) => message.images ?? [])).toHaveLength(chatLimits.imagesPerRequest)
  })

  it('describes earlier images to a model that cannot read them and still lets text through', () => {
    const conversation = readyConversation()
    conversation.messages = [{ id: 'old', role: 'user', content: '', reasoning: '', status: 'complete', createdAt: 1, assets: [image('A')] }]
    const plan = planTurn(conversation, { prompt: 'follow up', requestId: 'r', assistantId: 'a', userMessageId: 'u' })
    expect(plan.messages[0]).toEqual({ role: 'user', content: '（这里附过 1 张图片，这次没有再发给 AI）' })
  })

  it('retries and edits keep the images of the message they resend', () => {
    const conversation = visionConversation()
    conversation.messages = [
      { id: 'u1', role: 'user', content: '', reasoning: '', status: 'complete', createdAt: 1, assets: [image('A')] },
      { id: 'a1', role: 'assistant', content: 'ok', reasoning: '', status: 'complete', createdAt: 1 },
    ]
    expect(planTurn(conversation, { prompt: '', retryId: 'a1', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).messages).toEqual([{ role: 'user', content: '', images: ['A'.repeat(43)] }])
    expect(planTurn(conversation, { prompt: '看这张', editId: 'u1', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).messages).toEqual([{ role: 'user', content: '看这张', images: ['A'.repeat(43)] }])
  })

  it('adds draft images without repeats up to the per-message limit and removes them', () => {
    let conversation = addDraftImages(visionConversation(), [image('A'), image('B')])
    conversation = addDraftImages(conversation, [image('B'), image('C'), image('D'), image('E')])
    expect(conversation.draftImages?.map((item) => item.assetId[0])).toEqual(['A', 'B', 'C', 'D'])
    for (const letter of ['A', 'B', 'C', 'D']) conversation = removeDraftImage(conversation, letter.repeat(43))
    expect('draftImages' in conversation).toBe(false)
  })

  it('shows the main-process reason for a failed pick without the IPC prefix', () => {
    expect(attachmentErrorMessage(new Error("Error invoking remote method 'chat:pick-images': Error: 图片太大了，请截小一点再试"))).toBe('图片太大了，请截小一点再试')
    expect(attachmentErrorMessage(new Error('boom'))).toBe('图片没有加上，请再试一次')
  })

  // 已知21：英文的写入失败里汉字只出现在路径上（Windows 的中文用户名、Mac 上的中文文件夹），
  // 以前从第一个汉字截起，把半截路径端上了屏。
  it('falls back to the plain line when an English failure has Chinese only inside a path', () => {
    const fallback = '图片没有加上，请再试一次'
    expect(attachmentErrorMessage(new Error("Error invoking remote method 'chat:pick-images': Error: EPERM: operation not permitted, open 'C:\\Users\\张三\\AppData\\Roaming\\xingmang-ai-manager\\ai-assets\\user-7\\.a.png.tmp'"))).toBe(fallback)
    expect(attachmentErrorMessage(new Error("Error invoking remote method 'chat:paste-image': Error: ENOSPC: no space left on device, write 'C:\\Users\\张 三\\AppData\\Roaming\\xingmang-ai-manager\\ai-assets\\a.png'"))).toBe(fallback)
    expect(attachmentErrorMessage(new Error("EACCES: permission denied, mkdir '/Users/张三/Pictures/星芒 AI 作品/user-7'"))).toBe(fallback)
  })

  it('keeps a Chinese reason whole instead of cutting it at the first Chinese character', () => {
    expect(attachmentErrorMessage(new Error("Error invoking remote method 'chat:pick-images': Error: AI 图片资产不能经过符号链接或目录联接"))).toBe('AI 图片资产不能经过符号链接或目录联接')
    expect(attachmentErrorMessage(new Error("Error invoking remote method 'chat:paste-image': Error: 请先登录星芒账号"))).toBe('请先登录，再加图片')
  })
})
