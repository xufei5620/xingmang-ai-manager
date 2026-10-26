import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWindowSession, writeWindowSession } from './window-session'

afterEach(() => { vi.unstubAllGlobals() })

function stubSession() {
  const values = new Map<string, string>()
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    },
  })
  return values
}

describe('window session values', () => {
  it('writes, reads and clears a value', () => {
    const values = stubSession()
    writeWindowSession('key', 'dismissed')
    expect(readWindowSession('key')).toBe('dismissed')
    writeWindowSession('key', null)
    expect(values.has('key')).toBe(false)
    expect(readWindowSession('key')).toBeNull()
  })

  it('works as an in-memory value when storage is unavailable', () => {
    vi.stubGlobal('window', { get sessionStorage(): Storage { throw new Error('blocked') } })
    expect(() => writeWindowSession('key', 'x')).not.toThrow()
    expect(readWindowSession('key')).toBeNull()
  })
})
