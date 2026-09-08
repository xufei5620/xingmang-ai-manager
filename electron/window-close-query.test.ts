import { describe, expect, it, vi } from 'vitest'
import { createWindowCloseQuery, parseWindowCloseReport } from './window-close-query'

describe('window close reports', () => {
  it('deduplicates pending checks and rejects stale replies', async () => {
    const send = vi.fn()
    const query = createWindowCloseQuery(send)
    const first = query.request()
    expect(query.request()).toBe(first)
    expect(query.reply('stale', { blockingTask: false, unsavedChanges: false })).toBe(false)
    expect(query.reply(send.mock.calls[0][0], { blockingTask: true, unsavedChanges: false })).toBe(true)
    await expect(first).resolves.toEqual({ blockingTask: true, unsavedChanges: false })
    expect(query.reply(send.mock.calls[0][0], { blockingTask: false, unsavedChanges: false })).toBe(false)
    query.dispose()
  })

  it('times out without manufacturing a successful close report', async () => {
    vi.useFakeTimers()
    try {
      const query = createWindowCloseQuery(() => {}, 20)
      const result = expect(query.request()).rejects.toThrow('退出检查')
      await vi.advanceTimersByTimeAsync(20)
      await result
      query.dispose()
    } finally { vi.useRealTimers() }
  })

  it('returns an empty report immediately while the renderer is not ready', async () => {
    const send = vi.fn()
    const query = createWindowCloseQuery(send, 15_000, { isRendererReady: () => false })
    await expect(query.request()).resolves.toEqual({ blockingTask: false, unsavedChanges: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps a pending handshake deduplicated when readiness changes', async () => {
    let ready = true
    const send = vi.fn()
    const query = createWindowCloseQuery(send, 15_000, { isRendererReady: () => ready })
    const first = query.request()
    ready = false
    expect(query.request()).toBe(first)
    expect(query.reply(send.mock.calls[0][0], { blockingTask: false, unsavedChanges: false })).toBe(false)
    await expect(first).resolves.toEqual({ blockingTask: false, unsavedChanges: false })
  })

  it('resolves an in-flight query when the renderer becomes unavailable', async () => {
    const send = vi.fn()
    const query = createWindowCloseQuery(send)
    const pending = query.request()
    const requestId = send.mock.calls[0][0]
    expect(query.rendererUnavailable()).toBe(true)
    await expect(pending).resolves.toEqual({ blockingTask: false, unsavedChanges: false })
    expect(query.reply(requestId, { blockingTask: true, unsavedChanges: true })).toBe(false)
    expect(query.rendererUnavailable()).toBe(false)
  })

  it('does not keep a pending query alive when readiness is lost before a second close request', async () => {
    let ready = true
    const send = vi.fn()
    const query = createWindowCloseQuery(send, 15_000, { isRendererReady: () => ready })
    const pending = query.request()
    ready = false
    expect(query.request()).toBe(pending)
    await expect(pending).resolves.toEqual({ blockingTask: false, unsavedChanges: false })
    expect(send).toHaveBeenCalledOnce()
  })

  it('validates only boolean display state and strips unrelated data', () => {
    expect(parseWindowCloseReport({ blockingTask: false, unsavedChanges: true, token: 'never-return' })).toEqual({ blockingTask: false, unsavedChanges: true })
    expect(() => parseWindowCloseReport({ blockingTask: 'false', unsavedChanges: false })).toThrow('格式错误')
  })
})
