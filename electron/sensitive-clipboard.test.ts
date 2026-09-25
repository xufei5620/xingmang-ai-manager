import { describe, expect, it, vi } from 'vitest'
import { createSensitiveClipboard, SENSITIVE_CLIPBOARD_CLEAR_MS, type SensitiveClipboardTimers } from './sensitive-clipboard'

function fakeClipboard(initial = '') {
  let text = initial
  return {
    readText: vi.fn(() => text),
    writeText: vi.fn((next: string) => { text = next }),
    clear: vi.fn(() => { text = '' }),
    current: () => text,
    userCopies: (next: string) => { text = next },
  }
}

function fakeTimers() {
  const scheduled = new Map<number, { callback: () => void; delayMs: number }>()
  let nextId = 1
  const timers: SensitiveClipboardTimers = {
    set: (callback, delayMs) => { const id = nextId++; scheduled.set(id, { callback, delayMs }); return id },
    clear: (handle) => { scheduled.delete(handle as number) },
  }
  return {
    timers,
    scheduled,
    fireAll: () => {
      const entries = [...scheduled.entries()]
      scheduled.clear()
      for (const [, entry] of entries) entry.callback()
    },
  }
}

describe('sensitive-clipboard', () => {
  it('clears the secret after sixty seconds by default', () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    sensitive.write('sk-secret')

    expect(clipboard.current()).toBe('sk-secret')
    expect([...clock.scheduled.values()].map((entry) => entry.delayMs)).toEqual([SENSITIVE_CLIPBOARD_CLEAR_MS])
    expect(SENSITIVE_CLIPBOARD_CLEAR_MS).toBe(60_000)
    clock.fireAll()
    expect(clipboard.clear).toHaveBeenCalledTimes(1)
    expect(clipboard.current()).toBe('')
  })

  it('leaves whatever the user copied afterwards untouched', () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    sensitive.write('sk-secret')
    clipboard.userCopies('some notes')
    clock.fireAll()

    expect(clipboard.clear).not.toHaveBeenCalled()
    expect(clipboard.current()).toBe('some notes')
  })

  it('restarts the countdown for a newer secret and never wipes it on the older timer', () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    sensitive.write('sk-first')
    sensitive.write('sk-second')

    expect(clock.scheduled.size).toBe(1)
    clock.fireAll()
    expect(clipboard.current()).toBe('')
    expect(clipboard.clear).toHaveBeenCalledTimes(1)
  })

  it('wipes a pending secret on dispose so quitting does not leave it behind', () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    sensitive.write('sk-secret')
    sensitive.dispose()

    expect(clock.scheduled.size).toBe(0)
    expect(clipboard.current()).toBe('')
  })

  it('does not touch the clipboard on dispose when nothing is pending or the user copied something else', () => {
    const clipboard = fakeClipboard('user text')
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    sensitive.dispose()
    expect(clipboard.readText).not.toHaveBeenCalled()

    sensitive.write('sk-secret')
    clipboard.userCopies('later text')
    sensitive.dispose()
    expect(clipboard.clear).not.toHaveBeenCalled()
    expect(clipboard.current()).toBe('later text')
  })

  it('swallows a clipboard that cannot be read when the timer fires', () => {
    const clipboard = fakeClipboard()
    clipboard.readText.mockImplementation(() => { throw new Error('clipboard busy') })
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    sensitive.write('sk-secret')

    expect(() => clock.fireAll()).not.toThrow()
    expect(clipboard.clear).not.toHaveBeenCalled()
  })

  it('schedules nothing for an empty write', () => {
    const clipboard = fakeClipboard('old')
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    sensitive.write('')

    expect(clipboard.current()).toBe('')
    expect(clock.scheduled.size).toBe(0)
  })

  it('clears on the built-in timer exactly when sixty seconds have passed', () => {
    vi.useFakeTimers()
    try {
      const clipboard = fakeClipboard()
      const sensitive = createSensitiveClipboard({ clipboard })
      sensitive.write('sk-secret')
      vi.advanceTimersByTime(SENSITIVE_CLIPBOARD_CLEAR_MS - 1)
      expect(clipboard.current()).toBe('sk-secret')
      vi.advanceTimersByTime(1)
      expect(clipboard.current()).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})
