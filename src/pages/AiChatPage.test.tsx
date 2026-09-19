import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AiChatPage,
  DEFAULT_AI_CHAT_GROUP,
  DEFAULT_AI_CHAT_MODEL,
  buildAiChatRequestMessages,
  cancelPendingAiChatRequests,
  formatAiChatElapsed,
  imageSizeOptions,
  resolveAiChatDefaultGroup,
  resolveAiChatDisplayMode,
  type AiChatPageApi,
} from './AiChatPage'
import { resolveAiModelCapability } from '../../electron/ai-chat-protocol'
import {
  aiChatRequestToken,
  appendAiChatText,
  beginAiChatRequest,
  createAiChatState,
  loadAiChatHistory,
  saveAiChatHistory,
  type AiChatMessage,
  type AiChatOperationToken,
  type AiChatStorage,
} from '../ai-chat-state'

function memoryStorage(): AiChatStorage {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) },
    removeItem: (key) => { entries.delete(key) },
  }
}

function pending(...requestIds: string[]): Map<string, AiChatOperationToken> {
  return new Map(requestIds.map((requestId, index) => [requestId, { generation: index + 1, requestId }]))
}

function api(): AiChatPageApi {
  return {
    listAiChatGroups: vi.fn(async () => []),
    prepareAiChatGroup: vi.fn(async (group) => ({ group, models: [], keyCreated: false })),
    startAiChat: vi.fn(async (input) => ({ requestId: input.requestId, accepted: true as const })),
    generateAiImage: vi.fn(async () => []),
    cancelAiChat: vi.fn(async () => ({ canceled: true, mayStillComplete: false })),
    copyAiChatAsset: vi.fn(async () => undefined),
    saveAiChatAsset: vi.fn(async () => ({ saved: true })),
    showAiChatAssetMenu: vi.fn(async () => undefined),
    onAiChatStream: vi.fn(() => () => undefined),
  }
}

function message(overrides: Partial<AiChatMessage>): AiChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'answer',
    status: 'complete',
    createdAt: 1,
    ...overrides,
  }
}

describe('AI聊天页面纯逻辑', () => {
  it('prefers the Codex relay group and model when entering chat', () => {
    expect(DEFAULT_AI_CHAT_GROUP).toBe('GPT-中转/订阅')
    expect(DEFAULT_AI_CHAT_MODEL).toBe('gpt-5.6-sol')
    expect(resolveAiChatDefaultGroup([
      { name: 'Claude-MAX订阅' },
      { name: 'GPT-中转/订阅' },
      { name: '生图分组' },
    ], '生图分组')).toBe('GPT-中转/订阅')
    expect(resolveAiChatDefaultGroup([
      { name: 'Claude-MAX订阅' },
      { name: '生图分组' },
    ], '生图分组')).toBe('生图分组')
    expect(resolveAiChatDefaultGroup([{ name: 'Claude-MAX订阅' }])).toBe('Claude-MAX订阅')
    expect(resolveAiChatDefaultGroup([])).toBe('')
  })

  it('detects chat and image modes without sending image models to chat completions', () => {
    expect(resolveAiChatDisplayMode('gpt-5.6-sol')).toBe('chat')
    expect(resolveAiChatDisplayMode('gpt-image-2')).toBe('image')
    expect(resolveAiChatDisplayMode('jimeng_high_aes_general_v21_L')).toBe('image')
    expect(resolveAiChatDisplayMode('grok-imagine-video')).toBe('chat')
  })

  it('omits pending and failed assistant placeholders from outbound history', () => {
    const result = buildAiChatRequestMessages([
      message({ id: 'u', role: 'user', content: '问题' }),
      message({ id: 'a', role: 'assistant', content: '答案' }),
      message({ id: 'pending', content: '', status: 'pending' }),
      message({ id: 'failed', content: '内部错误', status: 'error' }),
    ])
    expect(result).toEqual([{ role: 'user', content: '问题' }, { role: 'assistant', content: '答案' }])
  })

  it('formats elapsed image time and derives sizes from each model policy', () => {
    expect(formatAiChatElapsed(8.9)).toBe('8 秒')
    expect(formatAiChatElapsed(125)).toBe('2:05')
    const gpt1 = resolveAiModelCapability('gpt-image-1')
    const jimeng = resolveAiModelCapability('jimeng_high_aes_general_v21_L')
    expect(gpt1.kind === 'image' && imageSizeOptions(gpt1)).toContain('1024x1536')
    expect(jimeng.kind === 'image' && imageSizeOptions(jimeng)).toEqual(['1024x1024'])
  })
})

describe('离开聊天页时的在途请求', () => {
  it('cancels every in-flight request and empties the pending map', () => {
    const chat = api()
    const inFlight = pending('request-1', 'request-2')

    cancelPendingAiChatRequests(chat, inFlight)

    expect(chat.cancelAiChat).toHaveBeenCalledTimes(2)
    expect(chat.cancelAiChat).toHaveBeenNthCalledWith(1, 'request-1')
    expect(chat.cancelAiChat).toHaveBeenNthCalledWith(2, 'request-2')
    expect(inFlight.size).toBe(0)
  })

  it('still clears the map when the main process refuses to cancel', async () => {
    const chat = { cancelAiChat: vi.fn(async () => { throw new Error('通道已关闭') }) }
    const inFlight = pending('request-1')

    expect(() => cancelPendingAiChatRequests(chat, inFlight)).not.toThrow()
    await Promise.resolve()

    expect(chat.cancelAiChat).toHaveBeenCalledWith('request-1')
    expect(inFlight.size).toBe(0)
  })

  it('does nothing when no request is running', () => {
    const chat = api()

    cancelPendingAiChatRequests(chat, pending())

    expect(chat.cancelAiChat).not.toHaveBeenCalled()
  })

  it('keeps the tokens already streamed in when the page is left mid-answer', () => {
    const storage = memoryStorage()
    const started = beginAiChatRequest(createAiChatState(7), {
      requestId: 'request-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      content: '写一首诗',
      kind: 'chat',
    })
    const streaming = appendAiChatText(started, aiChatRequestToken(started)!, '半句已经生成')
    saveAiChatHistory(storage, streaming)

    const restored = loadAiChatHistory(storage, 7)

    expect(restored.messages.at(-1)).toMatchObject({ content: '半句已经生成', status: 'complete' })
  })
})

describe('AI聊天页面结构', () => {
  it('renders the operational workspace first, with group/model controls and a disabled composer', () => {
    const markup = renderToStaticMarkup(<AiChatPage api={api()} userId={7} notify={vi.fn()} />)
    expect(markup).toContain('聊天')
    expect(markup).toContain('分组')
    expect(markup).toContain('模型')
    expect(markup).toContain('开始一段新对话')
    expect(markup).toContain('aria-label="聊天消息"')
    expect(markup).toContain('disabled=""')
  })

  it('does not render a landing-page hero or expose a key input', () => {
    const markup = renderToStaticMarkup(<AiChatPage api={api()} userId="user-7" notify={vi.fn()} />)
    expect(markup).not.toContain('API Key</label>')
    expect(markup).not.toContain('hero')
    expect(markup).not.toContain('type="password"')
  })
})
