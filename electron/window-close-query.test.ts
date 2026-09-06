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

  it('validates only boolean display state and strips unrelated data', () => {
    expect(parseWindowCloseReport({ blockingTask: false, unsavedChanges: true, token: 'never-return' })).toEqual({ blockingTask: false, unsavedChanges: true })
    expect(() => parseWindowCloseReport({ blockingTask: 'false', unsavedChanges: false })).toThrow('格式错误')
  })
})
