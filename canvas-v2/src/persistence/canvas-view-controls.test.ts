import { describe, expect, it } from 'vitest'
import { defaultCanvasUiPreferences, readCanvasUiPreferences, writeCanvasUiPreferences } from './canvas-ui-preferences'

describe('canvas view controls', () => {
  const projectId = '10000000-0000-4000-8000-000000000001'
  it('restores old preferences with visible connections and snapping enabled', () => {
    const preferences = readCanvasUiPreferences(projectId, { getItem: () => JSON.stringify({ version: 1, minimapOpen: true }), setItem() {} })
    expect(preferences.snapEnabled).toBe(true)
    expect(preferences.connectionsHidden).toBe(false)
    expect(preferences.minimapOpen).toBe(true)
    expect(preferences.composerFollowNode).toBe(false)
    expect(preferences.composerCollapsed).toBe(false)
  })

  it('stores only display preferences per project without serializing graph state', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    writeCanvasUiPreferences(projectId, { ...defaultCanvasUiPreferences, snapEnabled: false, connectionsHidden: true, composerFollowNode: true, composerCollapsed: true }, storage)
    expect(readCanvasUiPreferences(projectId, storage)).toMatchObject({ snapEnabled: false, connectionsHidden: true, composerFollowNode: true, composerCollapsed: true })
    expect(readCanvasUiPreferences('20000000-0000-4000-8000-000000000002', storage)).toMatchObject({ snapEnabled: true, connectionsHidden: false })
    expect([...values.values()][0]).not.toMatch(/nodes|edges|prompt|model/)
  })

  it('does not block editing when preference storage is unavailable', () => {
    const storage = { getItem(): string { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    expect(readCanvasUiPreferences(projectId, storage)).toEqual(defaultCanvasUiPreferences)
    expect(() => writeCanvasUiPreferences(projectId, { ...defaultCanvasUiPreferences, snapEnabled: false }, storage)).not.toThrow()
  })
})
