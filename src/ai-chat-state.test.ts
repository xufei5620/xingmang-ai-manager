import { describe, expect, it } from 'vitest'
import {
  AI_CHAT_MAX_MESSAGE_CHARS,
  AI_CHAT_MAX_STORED_BYTES,
  AI_CHAT_MAX_STORED_MESSAGES,
  AI_CHAT_MAX_TOTAL_CHARS,
  addAiChatSystemMessage,
  aiChatGroupPreparationToken,
  aiChatRequestToken,
  aiChatStorageKey,
  appendAiChatImage,
  appendAiChatReasoning,
  appendAiChatText,
  beginAiChatGroupPreparation,
  beginAiChatRequest,
  cancelAiChatRequest,
  clearAiChatHistory,
  clearAiChatMessages,
  completeAiChatGroupPreparation,
  completeAiChatRequest,
  createAiChatState,
  deleteAiChatMessage,
  editAiChatMessage,
  errorAiChatRequest,
  failAiChatGroupPreparation,
  loadAiChatHistory,
  regenerateAiChatMessage,
  retryAiChatMessage,
  saveAiChatHistory,
  type AiChatMessage,
  type AiChatStorage,
} from './ai-chat-state'

class MemoryStorage implements AiChatStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

function prepare(state = createAiChatState(7), group = 'codex-pro', requestId = 'prepare-1') {
  const pending = beginAiChatGroupPreparation(state, { group, requestId })
  const token = aiChatGroupPreparationToken(pending)!
  return { pending, token }
}

function start(state = createAiChatState(7), requestId = 'chat-1') {
  const running = beginAiChatRequest(state, {
    requestId,
    userMessageId: `user-${requestId}`,
    assistantMessageId: `assistant-${requestId}`,
    content: '你好',
    createdAt: 100,
  })
  const token = aiChatRequestToken(running)!
  return { running, token }
}

describe('AI聊天分组准备状态', () => {
  it('pending 期间和失败后都保留旧分组、模型和模型列表', () => {
    const current = {
      ...createAiChatState(7),
      group: 'Gemini',
      model: 'gemini-3.5-pro',
      availableModels: ['gemini-3.5-pro'],
    }
    const { pending, token } = prepare(current, '生图分组')
    expect(pending).toMatchObject({
      group: 'Gemini',
      model: 'gemini-3.5-pro',
      groupPreparation: { phase: 'pending', targetGroup: '生图分组' },
    })

    const failed = failAiChatGroupPreparation(pending, token, '自动创建密钥失败')
    expect(failed).toMatchObject({
      group: 'Gemini',
      model: 'gemini-3.5-pro',
      availableModels: ['gemini-3.5-pro'],
      groupPreparation: { phase: 'failure', error: '自动创建密钥失败' },
    })
  })

  it('only accepts the latest generation and requestId', () => {
    const first = prepare(createAiChatState(7), 'codex-pro', 'same-id')
    const secondPending = beginAiChatGroupPreparation(first.pending, { group: '生图分组', requestId: 'same-id' })
    const secondToken = aiChatGroupPreparationToken(secondPending)!

    const stale = completeAiChatGroupPreparation(secondPending, first.token, {
      group: 'codex-pro', models: ['gpt-5.6-sol'],
    })
    expect(stale).toBe(secondPending)

    const completed = completeAiChatGroupPreparation(stale, secondToken, {
      group: '生图分组',
      models: ['gpt-image-2', 'gpt-image-2', '', 'bad\nmodel'],
      preferredModel: 'gpt-image-2',
    })
    expect(completed).toMatchObject({
      group: '生图分组',
      model: 'gpt-image-2',
      availableModels: ['gpt-image-2'],
      groupPreparation: { phase: 'success' },
    })
  })
})

describe('AI聊天流式与图片状态', () => {
  it('appends text, reasoning and image, then ignores every late event after completion', () => {
    const { running, token } = start()
    const withText = appendAiChatText(running, token, '回答')
    const withReasoning = appendAiChatReasoning(withText, token, '思考')
    const withImage = appendAiChatImage(withReasoning, token, {
      assetId: 'asset-1',
      previewUrl: 'xingmang-asset://asset-1',
      mimeType: 'image/png',
      width: 1024,
      height: 1024,
    })
    const complete = completeAiChatRequest(withImage, token, 200)
    expect(complete.messages[1]).toMatchObject({
      content: '回答',
      reasoning: '思考',
      images: [{ assetId: 'asset-1' }],
      status: 'complete',
      updatedAt: 200,
    })
    expect(appendAiChatText(complete, token, '迟到')).toBe(complete)
    expect(errorAiChatRequest(complete, token, '迟到错误')).toBe(complete)
  })

  it('uses generation as well as requestId when request ids are reused', () => {
    const first = start(createAiChatState(7), 'same-id')
    const second = start(first.running, 'same-id')
    expect(appendAiChatText(second.running, first.token, '旧响应')).toBe(second.running)
    const accepted = appendAiChatText(second.running, second.token, '新响应')
    expect(accepted.messages.at(-1)?.content).toBe('新响应')
  })

  it('supports cancel and error terminal states', () => {
    const canceledStart = start()
    const canceled = cancelAiChatRequest(canceledStart.running, canceledStart.token, 150)
    expect(canceled.messages.at(-1)?.status).toBe('canceled')
    expect(canceled.request.phase).toBe('idle')

    const failedStart = start(canceled, 'chat-2')
    const failed = errorAiChatRequest(failedStart.running, failedStart.token, '余额不足', 250)
    expect(failed.messages.at(-1)).toMatchObject({ status: 'error', error: '余额不足' })
  })

  it('rejects remote URLs and data URLs as asset identifiers', () => {
    const { running, token } = start()
    expect(appendAiChatImage(running, token, { assetId: 'https://evil.example/a.png' })).toBe(running)
    expect(appendAiChatImage(running, token, { assetId: 'data:image/png;base64,AAAA' })).toBe(running)
  })
})

describe('AI聊天消息操作', () => {
  it('editing and deleting invalidate the active request so its late output cannot return', () => {
    const { running, token } = start()
    const edited = editAiChatMessage(running, 'user-chat-1', '修改后的问题', 300)
    expect(edited.messages[0].content).toBe('修改后的问题')
    expect(appendAiChatText(edited, token, '迟到')).toBe(edited)

    const next = start(edited, 'chat-2')
    const deleted = deleteAiChatMessage(next.running, 'user-chat-2')
    expect(deleted.messages.some((message) => message.id === 'user-chat-2')).toBe(false)
    expect(appendAiChatText(deleted, next.token, '迟到')).toBe(deleted)
  })

  it('regenerate and retry reset the selected assistant, truncate later history and create a fresh token', () => {
    const first = start()
    const completed = completeAiChatRequest(appendAiChatText(first.running, first.token, '旧回答'), first.token)
    const later = addAiChatSystemMessage(completed, { id: 'later', content: 'later', createdAt: 300 })
    const regenerated = regenerateAiChatMessage(later, {
      messageId: 'assistant-chat-1', requestId: 'regen-1', createdAt: 400,
    })
    expect(regenerated.messages.map((message) => message.id)).toEqual(['user-chat-1', 'assistant-chat-1'])
    expect(regenerated.messages[1]).toMatchObject({ content: '', status: 'pending', requestId: 'regen-1' })

    const retried = retryAiChatMessage(
      errorAiChatRequest(regenerated, aiChatRequestToken(regenerated)!, '失败'),
      { messageId: 'assistant-chat-1', requestId: 'retry-1' },
    )
    expect(retried.request).toMatchObject({ phase: 'running', requestId: 'retry-1' })
  })

  it('clear removes every message and invalidates active output', () => {
    const { running, token } = start()
    const cleared = clearAiChatMessages(running)
    expect(cleared.messages).toEqual([])
    expect(appendAiChatText(cleared, token, '迟到')).toBe(cleared)
  })
})

describe('AI聊天本地历史', () => {
  function message(index: number, content: string): AiChatMessage {
    return {
      id: `m-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content,
      status: 'complete',
      createdAt: index,
    }
  }

  it('isolates history by user id and verifies the envelope owner', () => {
    const storage = new MemoryStorage()
    saveAiChatHistory(storage, { ...createAiChatState(7), messages: [message(1, '用户七')] })
    saveAiChatHistory(storage, { ...createAiChatState(8), messages: [message(1, '用户八')] })

    expect(aiChatStorageKey(7)).not.toBe(aiChatStorageKey(8))
    expect(loadAiChatHistory(storage, 7).messages[0].content).toBe('用户七')
    expect(loadAiChatHistory(storage, 8).messages[0].content).toBe('用户八')

    const key = aiChatStorageKey(7)
    const forged = JSON.parse(storage.getItem(key)!)
    forged.userId = '8'
    storage.setItem(key, JSON.stringify(forged))
    expect(loadAiChatHistory(storage, 7)).toEqual({ group: '', model: '', messages: [] })
    expect(storage.getItem(key)).toBeNull()
  })

  it('persists only safe asset metadata and redacts base64, keys and remote URLs from all text', () => {
    const storage = new MemoryStorage()
    const state = {
      ...createAiChatState(7),
      group: '生图分组',
      model: 'gpt-image-2',
      messages: [{
        ...message(1, '查看 https://evil.example/a.png，密钥 sk-1234567890'),
        reasoning: 'data:image/png;base64,AAAA',
        error: 'Authorization: Bearer secret-token-value',
        requestId: 'must-not-persist',
        generation: 99,
        images: [{
          assetId: 'asset-safe',
          previewUrl: 'data:image/png;base64,BBBB',
          mimeType: 'image/png',
          width: 1024,
          height: 1024,
          revisedPrompt: '来自 https://remote.example/',
          remoteUrl: 'https://must-not-exist.example/',
          b64Json: 'CCCC',
        }],
      } as unknown as AiChatMessage],
    }
    saveAiChatHistory(storage, state)
    const raw = storage.getItem(aiChatStorageKey(7))!
    expect(raw).not.toMatch(/evil\.example|remote\.example|must-not-exist|base64|AAAA|BBBB|CCCC|sk-123|secret-token|requestId|generation|previewUrl|remoteUrl|b64Json/)

    const restored = loadAiChatHistory(storage, 7)
    expect(restored).toMatchObject({ group: '生图分组', model: 'gpt-image-2' })
    expect(restored.messages[0].images).toEqual([{
      assetId: 'asset-safe', mimeType: 'image/png', width: 1024, height: 1024,
      revisedPrompt: '来自 [远程链接未保存]',
    }])
  })

  it('enforces 100 messages, 40000 per message, 120000 total and about 1MiB serialized', () => {
    const storage = new MemoryStorage()
    const messages = Array.from({ length: 130 }, (_, index) => message(index, `${index}:` + '界'.repeat(50_000)))
    saveAiChatHistory(storage, { ...createAiChatState(7), messages })
    const raw = storage.getItem(aiChatStorageKey(7))!
    const restored = loadAiChatHistory(storage, 7)
    const total = restored.messages.reduce((sum, item) => (
      sum + item.content.length + (item.reasoning?.length ?? 0) + (item.error?.length ?? 0)
    ), 0)
    expect(restored.messages.length).toBeLessThanOrEqual(AI_CHAT_MAX_STORED_MESSAGES)
    expect(restored.messages.every((item) => item.content.length <= AI_CHAT_MAX_MESSAGE_CHARS)).toBe(true)
    expect(total).toBeLessThanOrEqual(AI_CHAT_MAX_TOTAL_CHARS)
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(AI_CHAT_MAX_STORED_BYTES)
    expect(restored.messages.at(-1)?.id).toBe('m-129')
  })

  it('drops oversized or malformed storage before parsing it again and supports explicit clear', () => {
    const storage = new MemoryStorage()
    const key = aiChatStorageKey(7)
    storage.setItem(key, 'x'.repeat(AI_CHAT_MAX_STORED_BYTES + 1))
    expect(loadAiChatHistory(storage, 7).messages).toEqual([])
    expect(storage.getItem(key)).toBeNull()

    saveAiChatHistory(storage, { ...createAiChatState(7), messages: [message(1, '可清理')] })
    clearAiChatHistory(storage, 7)
    expect(storage.getItem(key)).toBeNull()
  })
})
