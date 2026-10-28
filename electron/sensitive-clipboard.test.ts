import { describe, expect, it, vi } from 'vitest'
import {
  createSensitiveClipboard,
  SENSITIVE_CLIPBOARD_CLEAR_MS,
  SENSITIVE_CLIPBOARD_MAX_RETRIES,
  SENSITIVE_CLIPBOARD_RETRY_MS,
  type SensitiveClipboardTimers,
} from './sensitive-clipboard'

// Electron 44+ clipboard: reads and writes return promises, clear() is
// synchronous. A write takes effect when it is issued; only its promise settles
// later.
function fakeClipboard(initial = '') {
  let text = initial
  return {
    readText: vi.fn(async () => text),
    writeText: vi.fn(async (next: string) => { text = next }),
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

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('sensitive-clipboard', () => {
  it('clears the secret after sixty seconds by default', async () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')

    expect(clipboard.current()).toBe('sk-secret')
    expect([...clock.scheduled.values()].map((entry) => entry.delayMs)).toEqual([SENSITIVE_CLIPBOARD_CLEAR_MS])
    expect(SENSITIVE_CLIPBOARD_CLEAR_MS).toBe(60_000)
    clock.fireAll()
    await settle()
    expect(clipboard.clear).toHaveBeenCalledTimes(1)
    expect(clipboard.current()).toBe('')
  })

  it('leaves whatever the user copied afterwards untouched', async () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')
    clipboard.userCopies('some notes')
    clock.fireAll()
    await settle()

    expect(clipboard.clear).not.toHaveBeenCalled()
    expect(clipboard.current()).toBe('some notes')
  })

  it('restarts the countdown for a newer secret and never wipes it on the older timer', async () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-first')
    await sensitive.write('sk-second')

    expect(clock.scheduled.size).toBe(1)
    clock.fireAll()
    await settle()
    expect(clipboard.current()).toBe('')
    expect(clipboard.clear).toHaveBeenCalledTimes(1)
  })

  it('keeps only the newest of two copies that land out of order', async () => {
    const clipboard = fakeClipboard()
    const releases: Array<() => void> = []
    clipboard.writeText.mockImplementation((next: string) => {
      clipboard.userCopies(next)
      return new Promise<void>((resolve) => { releases.push(resolve) })
    })
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    const first = sensitive.write('sk-first')
    const second = sensitive.write('sk-second')
    releases[1]!()
    await second
    releases[0]!()
    await first

    expect(clock.scheduled.size).toBe(1)
    clock.fireAll()
    await settle()
    expect(clipboard.current()).toBe('')
  })

  it('wipes a pending secret on flush so quitting does not leave it behind', async () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')
    await sensitive.flush()

    expect(clock.scheduled.size).toBe(0)
    expect(clipboard.current()).toBe('')
    await sensitive.flush()
    expect(clipboard.clear).toHaveBeenCalledTimes(1)
  })

  it('wipes a secret whose write is still landing when the flush arrives', async () => {
    const clipboard = fakeClipboard()
    let release: () => void = () => {}
    clipboard.writeText.mockImplementation((next: string) => {
      clipboard.userCopies(next)
      return new Promise<void>((resolve) => { release = resolve })
    })
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    const writing = sensitive.write('sk-secret')
    await sensitive.flush()
    expect(clipboard.current()).toBe('')
    release()
    await writing

    expect(clock.scheduled.size).toBe(0)
  })

  it('cancels the countdown on dispose and still tries the wipe', async () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')
    sensitive.dispose()
    await settle()

    expect(clock.scheduled.size).toBe(0)
    expect(clipboard.current()).toBe('')
  })

  it('does not touch the clipboard on flush when nothing is pending or the user copied something else', async () => {
    const clipboard = fakeClipboard('user text')
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.flush()
    expect(clipboard.readText).not.toHaveBeenCalled()

    await sensitive.write('sk-secret')
    clipboard.userCopies('later text')
    await sensitive.flush()
    expect(clipboard.clear).not.toHaveBeenCalled()
    expect(clipboard.current()).toBe('later text')
  })

  it('swallows a clipboard that cannot be read when the timer fires or on flush', async () => {
    const clipboard = fakeClipboard()
    clipboard.readText.mockRejectedValue(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await sensitive.write('sk-secret')
      expect(() => clock.fireAll()).not.toThrow()
      await settle()
      await sensitive.write('sk-secret')
      await expect(sensitive.flush()).resolves.toBeUndefined()
      await settle()
    } finally {
      process.off('unhandledRejection', unhandled)
    }

    expect(clipboard.clear).not.toHaveBeenCalled()
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('reports a failed write to the caller and schedules nothing for it', async () => {
    const clipboard = fakeClipboard('old')
    clipboard.writeText.mockRejectedValue(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await expect(sensitive.write('sk-secret')).rejects.toThrow('clipboard busy')
    await sensitive.flush()

    expect(clock.scheduled.size).toBe(0)
    expect(clipboard.readText).not.toHaveBeenCalled()
    expect(clipboard.current()).toBe('old')
  })

  it('keeps the earlier secret on its own countdown when a later copy fails', async () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-first')
    const [firstTimer] = [...clock.scheduled.keys()]
    clipboard.writeText.mockRejectedValueOnce(new Error('clipboard busy'))
    await expect(sensitive.write('sk-second')).rejects.toThrow('clipboard busy')
    clipboard.writeText.mockRejectedValueOnce(new Error('clipboard busy'))
    await expect(sensitive.write('')).rejects.toThrow('clipboard busy')

    expect([...clock.scheduled.keys()]).toEqual([firstTimer])
    expect(clipboard.current()).toBe('sk-first')
    clock.fireAll()
    await settle()
    expect(clipboard.current()).toBe('')
  })

  it('still wipes an earlier secret that lands after a later copy failed', async () => {
    const clipboard = fakeClipboard()
    let releaseFirst: () => void = () => {}
    clipboard.writeText.mockImplementationOnce((next: string) => {
      clipboard.userCopies(next)
      return new Promise<void>((resolve) => { releaseFirst = resolve })
    })
    clipboard.writeText.mockRejectedValueOnce(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    const first = sensitive.write('sk-first')
    await expect(sensitive.write('sk-second')).rejects.toThrow('clipboard busy')
    releaseFirst()
    await first

    expect(clock.scheduled.size).toBe(1)
    clock.fireAll()
    await settle()
    expect(clipboard.current()).toBe('')
  })

  it('wipes an earlier secret on flush while a later copy is still landing and then fails', async () => {
    const clipboard = fakeClipboard()
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-first')
    let failSecond: (error: Error) => void = () => {}
    clipboard.writeText.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failSecond = reject }))
    const second = sensitive.write('sk-second')
    await sensitive.flush()
    failSecond(new Error('clipboard busy'))
    await expect(second).rejects.toThrow('clipboard busy')

    expect(clipboard.current()).toBe('')
    expect(clock.scheduled.size).toBe(0)
  })

  it('tries again a few seconds later when the clipboard cannot be read on time', async () => {
    const clipboard = fakeClipboard()
    clipboard.readText.mockRejectedValueOnce(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')
    clock.fireAll()
    await settle()

    expect(clipboard.current()).toBe('sk-secret')
    expect([...clock.scheduled.values()].map((entry) => entry.delayMs)).toEqual([SENSITIVE_CLIPBOARD_RETRY_MS])
    clock.fireAll()
    await settle()
    expect(clipboard.current()).toBe('')
    expect(clock.scheduled.size).toBe(0)
  })

  it('gives up after the last retry when the clipboard stays unreadable', async () => {
    const clipboard = fakeClipboard()
    clipboard.readText.mockRejectedValue(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')
    for (let attempt = 0; attempt <= SENSITIVE_CLIPBOARD_MAX_RETRIES; attempt += 1) {
      clock.fireAll()
      await settle()
    }

    expect(clipboard.readText).toHaveBeenCalledTimes(SENSITIVE_CLIPBOARD_MAX_RETRIES + 1)
    expect(clock.scheduled.size).toBe(0)
    await sensitive.flush()
    expect(clipboard.readText).toHaveBeenCalledTimes(SENSITIVE_CLIPBOARD_MAX_RETRIES + 1)
  })

  it('leaves a later user copy alone on the retry', async () => {
    const clipboard = fakeClipboard()
    clipboard.readText.mockRejectedValueOnce(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')
    clock.fireAll()
    await settle()
    clipboard.userCopies('some notes')
    clock.fireAll()
    await settle()

    expect(clipboard.clear).not.toHaveBeenCalled()
    expect(clipboard.current()).toBe('some notes')
    expect(clock.scheduled.size).toBe(0)
  })

  it('wipes on flush while a retry is waiting and cancels that retry', async () => {
    const clipboard = fakeClipboard()
    clipboard.readText.mockRejectedValueOnce(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-secret')
    clock.fireAll()
    await settle()
    await sensitive.flush()

    expect(clipboard.current()).toBe('')
    expect(clock.scheduled.size).toBe(0)
  })

  it('drops the retry once a newer secret has landed over the old one', async () => {
    const clipboard = fakeClipboard()
    clipboard.readText.mockRejectedValueOnce(new Error('clipboard busy'))
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('sk-first')
    clock.fireAll()
    await settle()
    await sensitive.write('sk-second')

    expect([...clock.scheduled.values()].map((entry) => entry.delayMs)).toEqual([SENSITIVE_CLIPBOARD_CLEAR_MS])
    clock.fireAll()
    await settle()
    expect(clipboard.current()).toBe('')
  })

  it('schedules nothing for an empty write', async () => {
    const clipboard = fakeClipboard('old')
    const clock = fakeTimers()
    const sensitive = createSensitiveClipboard({ clipboard, timers: clock.timers })

    await sensitive.write('')

    expect(clipboard.current()).toBe('')
    expect(clock.scheduled.size).toBe(0)
  })

  it('clears on the built-in timer exactly when sixty seconds have passed', async () => {
    vi.useFakeTimers()
    try {
      const clipboard = fakeClipboard()
      const sensitive = createSensitiveClipboard({ clipboard })
      await sensitive.write('sk-secret')
      await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_CLEAR_MS - 1)
      expect(clipboard.current()).toBe('sk-secret')
      await vi.advanceTimersByTimeAsync(1)
      expect(clipboard.current()).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries on the built-in timer a few seconds after an unreadable clipboard', async () => {
    vi.useFakeTimers()
    try {
      const clipboard = fakeClipboard()
      clipboard.readText.mockRejectedValueOnce(new Error('clipboard busy'))
      const sensitive = createSensitiveClipboard({ clipboard })
      await sensitive.write('sk-secret')
      await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_CLEAR_MS + SENSITIVE_CLIPBOARD_RETRY_MS - 1)
      expect(clipboard.current()).toBe('sk-secret')
      await vi.advanceTimersByTimeAsync(1)
      expect(clipboard.current()).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})
