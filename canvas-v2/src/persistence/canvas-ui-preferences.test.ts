import { describe, expect, it } from 'vitest'
import {
  defaultCanvasUiPreferences,
  readCanvasUiPreferences,
  writeCanvasUiPreferences,
  type CanvasUiPreferencesStorage,
} from './canvas-ui-preferences'

function storage(): CanvasUiPreferencesStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('canvas UI preferences', () => {
  it('round-trips project-scoped workspace preferences', () => {
    const target = storage()
    const preferences = { ...defaultCanvasUiPreferences, libraryCollapsed: true, focusMode: true, rightPanel: 'runs' as const, minimapOpen: true }
    writeCanvasUiPreferences('11111111-1111-4111-8111-111111111111', preferences, target)
    expect(readCanvasUiPreferences('11111111-1111-4111-8111-111111111111', target)).toEqual(preferences)
    expect(readCanvasUiPreferences('22222222-2222-4222-8222-222222222222', target)).toEqual(defaultCanvasUiPreferences)
  })

  it('sanitizes malformed data and never accepts an untrusted project key', () => {
    const target = storage()
    writeCanvasUiPreferences('../escape', { ...defaultCanvasUiPreferences, focusMode: true }, target)
    expect(readCanvasUiPreferences('../escape', target)).toEqual(defaultCanvasUiPreferences)
    const malformed = {
      getItem: () => JSON.stringify({ version: 99, libraryCollapsed: 'yes', focusMode: 1, rightPanel: 'settings', minimapOpen: true }),
      setItem: () => undefined,
    }
    expect(readCanvasUiPreferences('11111111-1111-4111-8111-111111111111', malformed)).toEqual({
      ...defaultCanvasUiPreferences,
      minimapOpen: true,
    })
  })

  it('ignores storage failures', () => {
    const failing = {
      getItem: () => { throw new Error('quota') },
      setItem: () => { throw new Error('quota') },
    }
    const preferences = { ...defaultCanvasUiPreferences, focusMode: true }
    expect(() => writeCanvasUiPreferences('11111111-1111-4111-8111-111111111111', preferences, failing)).not.toThrow()
    expect(readCanvasUiPreferences('11111111-1111-4111-8111-111111111111', failing)).toEqual(defaultCanvasUiPreferences)
  })
})
