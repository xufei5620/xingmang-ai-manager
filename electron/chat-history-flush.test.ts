import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatHistoryFlushTimeoutMs, createChatHistoryFlush, type ChatHistoryFlushOptions } from './chat-history-flush'

// 回复出字时退出，最后这一两秒还在界面里没交出来（0.2.24 深查聊天页 C1）：退出前先问界面要一次。

function fixture(overrides: Partial<ChatHistoryFlushOptions> = {}) {
  let next = 0
  const sent: string[] = []
  const options = {
    canAsk: vi.fn(() => true),
    send: vi.fn((requestId: string) => { sent.push(requestId) }),
    createId: () => `request-${++next}`,
    onError: vi.fn(),
    ...overrides,
  }
  return { options, sent, flush: createChatHistoryFlush(options) }
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => { done = true })
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('chat history flush before quitting', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('asks the window once and finishes as soon as it answers with the same request', async () => {
    const { options, sent, flush } = fixture()
    const result = flush.request()
    expect(sent).toEqual(['request-1'])
    expect(await settled(result)).toBe(false)
    flush.acknowledge('request-1')
    expect(await settled(result)).toBe(true)
    expect(options.onError).not.toHaveBeenCalled()
  })

  it('ignores answers to another request', async () => {
    const { flush } = fixture()
    const result = flush.request()
    flush.acknowledge('request-0')
    flush.acknowledge('')
    expect(await settled(result)).toBe(false)
    flush.acknowledge('request-1')
    expect(await settled(result)).toBe(true)
  })

  it('gives up after the time limit so a window that never answers cannot hold the quit', async () => {
    const { flush } = fixture()
    const result = flush.request()
    await vi.advanceTimersByTimeAsync(chatHistoryFlushTimeoutMs - 1)
    expect(await settled(result)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(result)).toBe(true)
    // A late answer to the expired request changes nothing.
    flush.acknowledge('request-1')
  })

  it('stays inside the two seconds the quit gives all cleanup', () => {
    expect(chatHistoryFlushTimeoutMs).toBeLessThan(2_000)
  })

  it('does not ask a window that cannot answer', async () => {
    const { options, flush } = fixture({ canAsk: vi.fn(() => false) })
    expect(await settled(flush.request())).toBe(true)
    expect(options.send).not.toHaveBeenCalled()
  })

  it('shares one request between callers while it is waiting, and asks again next time', async () => {
    const { sent, flush } = fixture()
    const first = flush.request()
    const second = flush.request()
    expect(second).toBe(first)
    expect(sent).toEqual(['request-1'])
    flush.acknowledge('request-1')
    await first
    void flush.request()
    expect(sent).toEqual(['request-1', 'request-2'])
  })

  it('still lets the quit go on when sending or checking the window fails', async () => {
    const sendFailure = new Error('界面已经没了')
    const sending = fixture({ send: vi.fn(() => { throw sendFailure }) })
    expect(await settled(sending.flush.request())).toBe(true)
    expect(sending.options.onError).toHaveBeenCalledWith(sendFailure)

    const checkFailure = new Error('窗口已销毁')
    const checking = fixture({ canAsk: vi.fn(() => { throw checkFailure }) })
    expect(await settled(checking.flush.request())).toBe(true)
    expect(checking.options.send).not.toHaveBeenCalled()
    expect(checking.options.onError).toHaveBeenCalledWith(checkFailure)
  })
})
