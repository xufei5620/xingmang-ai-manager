import { describe, expect, it } from 'vitest'
import { clearGuideProgress, guideProgressKey, readGuideProgress, writeGuideProgress } from './guide-progress'

function memoryStorage() {
  const entries = new Map<string, string>()
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
}

describe('v2 guide resume ownership', () => {
  it('does not create a default selection while reading a fresh scope', () => {
    const storage = memoryStorage()
    expect(readGuideProgress(storage, 'site:7', 'win')).toBeNull()
    expect(storage.entries.size).toBe(0)
    expect(writeGuideProgress(storage, undefined, { route: 'chat', step: 'choose' })).toBe(true)
    expect(storage.entries.size).toBe(0)
  })
  it('stores a user selection and step under its exact account scope', () => {
    const storage = memoryStorage()
    expect(writeGuideProgress(storage, 'site:7', { route: 'gemini', step: 'prepare' })).toBe(true)
    expect(readGuideProgress(storage, 'site:7', 'win')).toEqual({ route: 'gemini', step: 'prepare' })
    expect(readGuideProgress(storage, 'site:8', 'win')).toBeNull()
    storage.setItem(guideProgressKey('site:8'), storage.getItem(guideProgressKey('site:7'))!)
    expect(readGuideProgress(storage, 'site:8', 'win')).toBeNull()
    clearGuideProgress(storage, 'site:7')
    expect(readGuideProgress(storage, 'site:7', 'win')).toBeNull()
    expect(storage.getItem(guideProgressKey('site:8'))).not.toBeNull()
  })
  it('ignores malformed and platform-incompatible progress without modifying it', () => {
    const storage = memoryStorage()
    writeGuideProgress(storage, 'site:7', { route: 'codexDesktop', step: 'ready' })
    expect(readGuideProgress(storage, 'site:7', 'linux')).toBeNull()
    const raw = '{invalid json'
    storage.setItem(guideProgressKey('site:7'), raw)
    expect(readGuideProgress(storage, 'site:7', 'win')).toBeNull()
    expect(storage.getItem(guideProgressKey('site:7'))).toBe(raw)
  })
  it('keeps a guide usable when local storage is unavailable', () => {
    expect(readGuideProgress(null, 'site:7', 'win')).toBeNull()
    expect(writeGuideProgress(null, 'site:7', { route: 'chat', step: 'prepare' })).toBe(false)
    expect(() => clearGuideProgress(null, 'site:7')).not.toThrow()
  })
})
