import { afterEach, describe, expect, it } from 'vitest'
import { rememberTourPending, rememberTourSeen, tourReplayPending, tourStateKey } from './tour-state'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}
const globalWithStorage = globalThis as { localStorage?: Storage }
afterEach(() => { delete globalWithStorage.localStorage })

describe('renderer-v2 shell tour state', () => {
  it('leaves an account with no record alone', () => {
    globalWithStorage.localStorage = memoryStorage()
    expect(tourReplayPending('xm-account:17')).toBe(false)
  })

  it('keeps replaying until the tour is actually finished or dismissed', () => {
    globalWithStorage.localStorage = memoryStorage()
    // 引导走完把导览记成待看，用户没看完就关掉软件时这条记录还在，
    // 下次回到首页才会接着播。
    expect(rememberTourPending('xm-account:17')).toBe(true)
    expect(tourReplayPending('xm-account:17')).toBe(true)
    expect(tourReplayPending('xm-account:17')).toBe(true)
    expect(rememberTourSeen('xm-account:17')).toBe(true)
    expect(tourReplayPending('xm-account:17')).toBe(false)
  })

  it('replays again after the settings entry asks for it', () => {
    globalWithStorage.localStorage = memoryStorage()
    rememberTourSeen('xm-account:17')
    expect(tourReplayPending('xm-account:17')).toBe(false)
    rememberTourPending('xm-account:17')
    expect(tourReplayPending('xm-account:17')).toBe(true)
  })

  it('keeps one record per account so a second account still gets its own tour', () => {
    globalWithStorage.localStorage = memoryStorage()
    rememberTourSeen('xm-account:17')
    expect(tourReplayPending('xm-account:99')).toBe(false)
    rememberTourPending('xm-account:99')
    expect(tourReplayPending('xm-account:99')).toBe(true)
    expect(tourReplayPending('xm-account:17')).toBe(false)
    expect(tourStateKey('xm-account:99')).not.toBe(tourStateKey('xm-account:17'))
  })

  it('treats unreadable local storage as 「不用播」 instead of throwing', () => {
    expect(rememberTourPending('xm-account:17')).toBe(false)
    expect(tourReplayPending('xm-account:17')).toBe(false)
    const storage = memoryStorage()
    storage.setItem(tourStateKey('xm-account:17'), 'whatever')
    globalWithStorage.localStorage = storage
    expect(tourReplayPending('xm-account:17')).toBe(false)
  })
})
