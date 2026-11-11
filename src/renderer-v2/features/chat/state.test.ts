import { describe, expect, it } from 'vitest'
import type { AiChatAsset, AiChatTextFile } from '../../../../electron/ipc-contract'
import { networkFailureMessages } from '../../../../electron/network-failure'
import { relayQuotaFailureMessages } from '../../../../electron/relay-quota-failure'
import { activeConversation, isGeneratingImage, addDraftImages, applyStreamEvent, attachmentErrorMessage, buildChatCatalog, chatErrorAction, chatErrorMessage, chatExampleDraft, chatExamples, chatModelVendor, chatModelVendors, continueInNewConversation, conversationContextShare, conversationDay, conversationReplyTooLongMessage, conversationTooLongMessage, createConversation, createWorkspace, DEFAULT_CHAT_GROUP, DEFAULT_CHAT_MODEL, draftLengthError, DEFAULT_IMAGE_MODELS, defaultChatSettings, filterConversations, groupConversationList, groupConversationsByDay, MAX_CONVERSATION_TITLE_LENGTH, renameConversation, setConversationPinned, isConversationTooLongMessage, noImageModelMessage, pendingChatGroups, pickChatGroup, planTurn, recommendedChatGroup, removeDraftImage, resolveChatModel, resolveDefaultChatModel, saveConversation, settleChatModel, shouldPasteScreenshot, shouldSendOnEnter, shouldShowLengthNotice, type ChatMessage, type ChatSettings, type ChatWorkspace, addDraftFiles, draftFileRoom, fileAttachmentErrorMessage, fileTruncationNotice, imageModeFilesMessage, messageWithFiles, removeDraftFile, shouldShowOfflineReplyNotice, offlineReplyNotice } from './state'
import { createParameterDraft, parseParameters } from './parameters'
import { historyKey, importLegacyHistory, parseHistorySnapshot, planHistoryWrite, readWorkspace } from './storage'
import { canEditImages, chatLimits, inspectModel, noImageEditModelMessage, validateImageRequest } from './api'

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

  it('prefers the image group the main process marks once the image group is renamed', () => {
    const groups = [{ name: 'default', ratio: 1 }, { name: 'GPT', ratio: 1 }, { name: '画图', ratio: 2, image: true }]
    expect(pickChatGroup(['default', 'GPT', '画图'], { current: '', mode: 'image', groups })).toBe('画图')
    expect(pickChatGroup(['default', 'GPT', '画图'], { current: '', mode: 'text', groups })).toBe('GPT')
    // Without the mark a renamed image group is only one more group, billed by ratio.
    expect(pickChatGroup(['default', '画图'], { current: '', mode: 'image', groups: groups.map(({ image: _image, ...group }) => group) })).toBe('default')
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

  it('says how long a draft past the single message limit is and lets one at the limit through, counting what is sent', () => {
    expect(draftLengthError('')).toBe('')
    expect(draftLengthError('a'.repeat(chatLimits.messageLength))).toBe('')
    // Surrounding blank lines are trimmed before sending, so they do not count against the limit.
    expect(draftLengthError(`\n${'a'.repeat(chatLimits.messageLength)}\n  `)).toBe('')
    expect(draftLengthError('a'.repeat(45011))).toBe('最多 40000 字，现在 45011 字，删掉一些再发。')
    expect(draftLengthError(` ${'a'.repeat(chatLimits.messageLength + 1)} `)).toBe('最多 40000 字，现在 40001 字，删掉一些再发。')
    // The sentence and the check behind the send button agree on what is too long.
    const tooLong = 'a'.repeat(chatLimits.messageLength + 1)
    expect(() => planTurn(readyConversation(), { prompt: tooLong, requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow()
    expect(() => planTurn(readyConversation(), { prompt: tooLong.slice(1), requestId: 'r', assistantId: 'a', userMessageId: 'u' })).not.toThrow()
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
  it('shows the network reason the main process gave when an image request never left', () => {
    for (const reason of ['offline', 'dns', 'proxy', 'refused', 'intercepted'] as const) {
      const message = networkFailureMessages[reason]
      expect(chatErrorMessage(new Error(`Error invoking remote method 'ai:image-generate': Error: ${message}`))).toBe(message)
      // The page runs the shown text through here once more when it marks the reply as failed.
      expect(chatErrorMessage(message)).toBe(message)
    }
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
    expect(chatErrorMessage(new Error("Error invoking remote method 'chat:prepare-group': Error: 登录已过期"))).toBe('当前登录或密钥已失效，请重新登录后重试')
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
  it('pastes spreadsheet cells as text and only takes a clipboard with no text as a screenshot', () => {
    function clipboard(text: string, items: Array<{ kind: string; type: string }>) { return { items, getData: (format: string) => format === 'text/plain' ? text : '' } }
    const image = { kind: 'file', type: 'image/png' }
    // Excel and WPS put the cells as text plus a picture of the table on the clipboard.
    expect(shouldPasteScreenshot(clipboard('姓名\t金额\r\n张三\t12\r\n', [{ kind: 'string', type: 'text/plain' }, { kind: 'string', type: 'text/html' }, image]))).toBe(false)
    expect(shouldPasteScreenshot(clipboard('', [image]))).toBe(true)
    expect(shouldPasteScreenshot(clipboard(' \r\n', [{ kind: 'string', type: 'text/plain' }, image])), 'blank text is not worth keeping over the picture').toBe(true)
    expect(shouldPasteScreenshot(clipboard('plain words', [{ kind: 'string', type: 'text/plain' }]))).toBe(false)
    expect(shouldPasteScreenshot(clipboard('', [{ kind: 'file', type: 'application/pdf' }]))).toBe(false)
  })
  it('validates optional numeric parameters and does not coerce blank values to zero', () => {
    expect(parseParameters(createParameterDraft({})).parameters).toEqual({})
    const invalid = { ...createParameterDraft({}), temperature: '2.1', maxTokens: '1.5', seed: 'Infinity' }
    expect(Object.keys(parseParameters(invalid).errors)).toEqual(['temperature', 'maxTokens', 'seed'])
    expect(parseParameters({ ...createParameterDraft({}), topP: '0', seed: '-1' }).parameters).toEqual({ topP: 0, seed: -1 })
  })
  it('says what to type when a whole number is expected, and gives the range only when the number is whole', () => {
    const { errors } = parseParameters({ ...createParameterDraft({}), maxTokens: '1.5', seed: 'abc' })
    expect(errors).toEqual({ maxTokens: '要填整数，比如 4096（不填就是不限）', seed: '随机种子要填整数' })
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
  it('lists pinned conversations first under their own heading and the rest by day', () => {
    const now = new Date(2026, 9, 15, 12).getTime()
    const at = (day: number) => new Date(2026, 9, day, 9).getTime()
    const conversation = (id: string, updatedAt: number, pinned = false) => ({ ...createConversation(undefined, id), updatedAt, ...(pinned ? { pinned: true } : {}) })
    const grouped = groupConversationList([conversation('a', at(15)), conversation('b', at(1), true), conversation('c', at(14)), conversation('d', at(15), true)], now)
    expect(grouped.map((group) => [group.label, group.conversations.map((item) => item.id)])).toEqual([['置顶', ['b', 'd']], ['今天', ['a']], ['昨天', ['c']]])
    expect(groupConversationList([conversation('e', at(15))], now).map((group) => group.label)).toEqual(['今天'])
  })
  it('renames a conversation without moving it to today and keeps the name when its messages are cleared out', () => {
    const conversation = { ...readyConversation(), title: '帮我写一个批量重命名文件的脚本', updatedAt: 5 }
    const renamed = renameConversation(conversation, '  重命名脚本  ')
    expect(renamed).toMatchObject({ title: '重命名脚本', renamed: true, updatedAt: 5 })
    expect(renameConversation(conversation, '   ')).toBe(conversation)
    expect(renameConversation(renamed, '重命名脚本')).toBe(renamed)
    expect(renameConversation(conversation, '长'.repeat(60)).title).toHaveLength(MAX_CONVERSATION_TITLE_LENGTH)
    // 消息删光了再发，自己起的名字不被第一句话盖掉；没改过名的照旧按第一句起名。
    expect(planTurn({ ...renamed, messages: [] }, { prompt: '新的问题', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).conversation.title).toBe('重命名脚本')
    expect(planTurn({ ...conversation, messages: [] }, { prompt: '新的问题', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).conversation.title).toBe('新的问题')
  })
  it('pins and unpins without touching anything else', () => {
    const conversation = readyConversation()
    const pinned = setConversationPinned(conversation, true)
    expect(pinned).toEqual({ ...conversation, pinned: true })
    expect(setConversationPinned(pinned, true)).toBe(pinned)
    expect(setConversationPinned(pinned, false)).toEqual(conversation)
    expect('pinned' in setConversationPinned(pinned, false)).toBe(false)
  })
  it('uses the authoritative model protocol for media capabilities and validation', () => {
    expect(inspectModel('gpt-image-1.5')).toMatchObject({ available: false, hidden: true })
    expect(inspectModel('gpt-image-2')).toMatchObject({ kind: 'image', resolutions: ['1K', '2K', '4K'] })
    expect(() => validateImageRequest({ model: 'gpt-image-2', prompt: 'a scene', size: '1011x1000' })).toThrow()
  })
})

describe('v2 chat image in flight', () => {
  it('counts only an unfinished image reply as drawing, so an account switch asks before throwing it away (D44)', () => {
    const image = readyConversation()
    image.settings = { ...image.settings, mode: 'image', model: 'gpt-image-2' }
    const pending = planTurn(image, { prompt: 'an orange cat', requestId: 'request-image', assistantId: 'assistant-image', userMessageId: 'user-image' }).conversation
    expect(isGeneratingImage(pending)).toBe(true)
    const streamingText = turn().conversation
    expect(isGeneratingImage({ ...streamingText, messages: streamingText.messages.map((message) => message.role === 'assistant' ? { ...message, status: 'streaming' } : message) })).toBe(false)
    for (const status of ['complete', 'canceled', 'error'] as const)
      expect(isGeneratingImage({ ...pending, messages: pending.messages.map((message) => message.role === 'assistant' ? { ...message, status } : message) })).toBe(false)
    expect(isGeneratingImage(createConversation(undefined, 'empty'))).toBe(false)
  })
})

describe('v2 chat reply while offline', () => {
  it('says the network dropped only under a text reply that is still coming in (D43)', () => {
    expect(offlineReplyNotice).toBe('网络断了，这条回复可能接不上，可以先停止。')
    const pending = turn().conversation
    const reply = pending.messages.find((message) => message.role === 'assistant')!
    const question = pending.messages.find((message) => message.role === 'user')!
    expect(reply.status).toBe('pending')
    expect(shouldShowOfflineReplyNotice(reply, true)).toBe(true)
    expect(shouldShowOfflineReplyNotice({ ...reply, status: 'streaming' }, true)).toBe(true)
    expect(shouldShowOfflineReplyNotice({ ...reply, status: 'streaming' }, false)).toBe(false)
    for (const status of ['complete', 'canceled', 'error'] as const) expect(shouldShowOfflineReplyNotice({ ...reply, status }, true)).toBe(false)
    expect(shouldShowOfflineReplyNotice(question, true)).toBe(false)
    // 出图停下也可能照样计费，停之前另有一问，这里不催人去停。
    const image = readyConversation()
    image.settings = { ...image.settings, mode: 'image', model: 'gpt-image-2' }
    const drawing = planTurn(image, { prompt: 'an orange cat', requestId: 'request-image', assistantId: 'assistant-image', userMessageId: 'user-image' }).conversation
    expect(shouldShowOfflineReplyNotice(drawing.messages.find((message) => message.role === 'assistant')!, true)).toBe(false)
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

  it('refuses images for a model that cannot read them', () => {
    const plain = readyConversation()
    expect(() => planTurn(plain, { prompt: 'x', images: [image('A')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow(noImageModelMessage)
    expect(chatErrorMessage(new Error(noImageModelMessage))).toBe(noImageModelMessage)
    expect(chatErrorMessage(new Error('this model cannot read images'))).toBe(noImageModelMessage)
  })

  it('takes images as references when generating with a model that edits, and needs words to say what to change', () => {
    const drawing = readyConversation(); drawing.settings.mode = 'image'; drawing.settings.model = 'gpt-image-2'
    const plan = planTurn(drawing, { prompt: '把背景换成海边', images: [image('A'), image('B')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })
    expect(plan.images).toEqual([image('A'), image('B')])
    expect(plan.conversation.messages[0].assets).toEqual([image('A'), image('B')])
    // A retry edits the same pictures again.
    const retried = planTurn({ ...plan.conversation, messages: plan.conversation.messages.map((message) => ({ ...message, status: 'complete' as const })) }, { prompt: '', retryId: 'a', requestId: 'r2', assistantId: 'a2', userMessageId: 'u2' })
    expect(retried.images).toEqual([image('A'), image('B')])
    expect(retried.prompt).toBe('把背景换成海边')
    expect(planTurn(drawing, { prompt: '一只猫', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).images).toEqual([])
    expect(() => planTurn(drawing, { prompt: '', images: [image('A')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow('请先输入消息内容')
    for (const model of ['gemini-3.1-flash-image', 'jimeng_high_aes_general_v21_L']) {
      const other = { ...drawing, settings: { ...drawing.settings, model } }
      expect(() => planTurn(other, { prompt: 'x', images: [image('A')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow(noImageEditModelMessage)
    }
    expect(canEditImages('grok-imagine-image')).toBe(true)
    expect(canEditImages('gpt-image-1.5')).toBe(false)
    expect(canEditImages('gpt-test')).toBe(false)
    expect(chatErrorMessage(new Error(noImageEditModelMessage))).toBe(noImageEditModelMessage)
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

describe('v2 chat empty-page examples', () => {
  it('offers everyday writing and translation next to the coding examples', () => {
    expect(chatExamples).toEqual(['帮我把这段话改得更通顺', '把下面的内容翻译成英文', '帮我写一条朋友圈文案，卖的是……', '这个 Excel 公式怎么写：我想……', '帮我写一个批量重命名文件的脚本', '这段报错是什么意思'])
    expect(new Set(chatExamples).size).toBe(chatExamples.length)
  })

  it('fills a half-sentence example without its trailing ellipsis so typing just continues', () => {
    expect(chatExampleDraft('帮我写一条朋友圈文案，卖的是……')).toBe('帮我写一条朋友圈文案，卖的是')
    expect(chatExampleDraft('这个 Excel 公式怎么写：我想……')).toBe('这个 Excel 公式怎么写：我想')
    expect(chatExampleDraft('这段报错是什么意思')).toBe('这段报错是什么意思')
    expect(chatExampleDraft('……中间的省略号……不动……')).toBe('……中间的省略号……不动')
  })
})

describe('v2 chat attached text files', () => {
  const file = (name: string, text: string, truncated = false): AiChatTextFile => ({ name, size: text.length, text, truncated })

  it('sends the files ahead of what the customer wrote, marked so the AI tells them apart, and clears them from the draft', () => {
    const conversation = { ...readyConversation(), draftFiles: [file('notes.md', '# 会议记录'), file('big.log', 'start', true)] }
    const plan = planTurn(conversation, { prompt: '帮我总结', files: conversation.draftFiles, requestId: 'r', assistantId: 'a', userMessageId: 'u' })
    expect(plan.messages).toEqual([{ role: 'user', content: '<file name="notes.md">\n# 会议记录\n</file>\n\n<file name="big.log" truncated="true">\nstart\n</file>\n\n帮我总结' }])
    expect(plan.conversation.messages[0]).toMatchObject({ content: '帮我总结', files: conversation.draftFiles })
    expect(plan.conversation.draftFiles).toBeUndefined()
    expect(plan.prompt).toBe('帮我总结')
  })

  it('sends a file without any words and names the conversation after it', () => {
    const conversation = readyConversation()
    const plan = planTurn(conversation, { prompt: '', files: [file('报错日志.txt', 'Error: boom')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })
    expect(plan.messages).toEqual([{ role: 'user', content: '<file name="报错日志.txt">\nError: boom\n</file>' }])
    expect(plan.conversation.title).toBe('报错日志.txt')
  })

  it('keeps the files of earlier messages in what every later turn sends, and in retries and edits', () => {
    const conversation = readyConversation()
    conversation.messages = [
      { id: 'u1', role: 'user', content: '看看', reasoning: '', status: 'complete', createdAt: 1, files: [file('a.csv', 'x,y')] },
      { id: 'a1', role: 'assistant', content: 'ok', reasoning: '', status: 'complete', createdAt: 1 },
    ]
    const withFile = '<file name="a.csv">\nx,y\n</file>\n\n看看'
    expect(planTurn(conversation, { prompt: '接着说', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).messages[0]).toEqual({ role: 'user', content: withFile })
    expect(planTurn(conversation, { prompt: '', retryId: 'a1', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).messages).toEqual([{ role: 'user', content: withFile }])
    expect(planTurn(conversation, { prompt: '改成这样', editId: 'u1', requestId: 'r', assistantId: 'a', userMessageId: 'u' }).messages).toEqual([{ role: 'user', content: '<file name="a.csv">\nx,y\n</file>\n\n改成这样' }])
    expect(conversationContextShare(conversation)).toBeCloseTo(Math.max(2 / chatLimits.messageCount, (withFile.length + 2) / chatLimits.totalMessageLength))
  })

  it('refuses files when generating an image, and says so in words the banner shows as they are', () => {
    const drawing = readyConversation(); drawing.settings.mode = 'image'; drawing.settings.model = 'gpt-image-2'
    expect(() => planTurn(drawing, { prompt: '一只猫', files: [file('a.txt', 'x')], requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow(imageModeFilesMessage)
    expect(chatErrorMessage(new Error(imageModeFilesMessage))).toBe(imageModeFilesMessage)
  })

  it('counts the files toward the single-message limit', () => {
    const files = [file('a.txt', 'x'.repeat(30_000))]
    // The file blocks and the blank line before the typed text come off the 40000 first.
    const room = chatLimits.messageLength - messageWithFiles('', files).length - 2
    expect(messageWithFiles('y'.repeat(room), files)).toHaveLength(chatLimits.messageLength)
    expect(draftLengthError('y'.repeat(room), files)).toBe('')
    expect(() => planTurn(readyConversation(), { prompt: 'y'.repeat(room), files, requestId: 'r', assistantId: 'a', userMessageId: 'u' })).not.toThrow()
    expect(draftLengthError('y'.repeat(room + 1), files)).toBe('最多 40000 字，现在 40001 字，删掉一些再发。')
    expect(() => planTurn(readyConversation(), { prompt: 'y'.repeat(room + 1), files, requestId: 'r', assistantId: 'a', userMessageId: 'u' })).toThrow(`单条消息最多 ${chatLimits.messageLength} 个字符`)
    expect(draftLengthError('y'.repeat(room + 1))).toBe('')
    expect(draftLengthError('', files)).toBe('')
  })

  it('works out how many more files and characters the draft has room for', () => {
    expect(draftFileRoom({ draft: '' })).toEqual({ files: 3, characters: 30_000 })
    expect(draftFileRoom({ draft: '', draftFiles: [file('a.txt', 'x'.repeat(10_000))] })).toEqual({ files: 2, characters: 20_000 })
    // A long draft leaves less room for files, so the whole message still fits.
    const long = draftFileRoom({ draft: 'y'.repeat(30_000) })
    expect(long.files).toBe(3)
    expect(long.characters).toBe(chatLimits.messageLength - 30_002 - 3 * 300)
    expect(draftFileRoom({ draft: '', draftFiles: [file('a', '1'), file('b', '2'), file('c', '3')] })).toEqual({ files: 0, characters: 0 })
    expect(draftFileRoom({ draft: 'y'.repeat(chatLimits.messageLength) }).characters).toBe(0)
  })

  it('adds and removes draft files by position, and moves them along with the draft to a new conversation', () => {
    const first = addDraftFiles(readyConversation(), [file('same.txt', 'one'), file('same.txt', 'two')])
    expect(first.draftFiles?.map((item) => item.text)).toEqual(['one', 'two'])
    expect(removeDraftFile(first, 0).draftFiles?.map((item) => item.text)).toEqual(['two'])
    expect(removeDraftFile(removeDraftFile(first, 0), 0)).not.toHaveProperty('draftFiles')
    expect(addDraftFiles(first, [file('c', '3'), file('d', '4')]).draftFiles).toHaveLength(3)
    const state = createWorkspace('owner')
    state.conversations = [{ ...first, draft: 'carry me' }]
    const moved = continueInNewConversation(state, first.id, 'carry me', true)
    expect(moved.conversations[0].draftFiles).toEqual(first.draftFiles)
    expect(moved.conversations[1]).not.toHaveProperty('draftFiles')
  })

  it('tells the customer which files were read only in part', () => {
    expect(fileTruncationNotice([file('a.txt', 'x')])).toBe('')
    expect(fileTruncationNotice([file('big.log', 'x'.repeat(12_000), true)])).toBe('「big.log」太长，只读了前 12,000 个字。')
  })

  it('shows the main process words for a failed pick and a fallback for English ones', () => {
    expect(fileAttachmentErrorMessage(new Error("Error invoking remote method 'chat:pick-text-files': Error: 这个文件读不出来，可能正被别的软件占着，关掉它再试。"))).toBe('这个文件读不出来，可能正被别的软件占着，关掉它再试。')
    expect(fileAttachmentErrorMessage(new Error('请先登录星芒账号'))).toBe('请先登录，再加文件')
    expect(fileAttachmentErrorMessage(new Error('EPERM: operation not permitted'))).toBe('文件没有加上，请再试一次')
  })

  it('finds a conversation by the name of a file sent in it', () => {
    const conversation = readyConversation()
    conversation.messages = [{ id: 'u1', role: 'user', content: '', reasoning: '', status: 'complete', createdAt: 1, files: [file('季度报表.csv', 'x')] }]
    expect(filterConversations([conversation], '季度报表')).toEqual([conversation])
  })
})
