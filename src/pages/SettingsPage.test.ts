import { describe, expect, it } from 'vitest'
import {
  reconcileSettingsDraft,
  settingsEqual,
  type SettingsDraftState,
  type SettingsV2,
} from './SettingsPage'

const base: SettingsV2 = {
  version: 2,
  workspace: 'C:\\workspace',
  theme: 'dark',
  checkUpdatesOnStartup: true,
  runDiagnosticsOnStartup: false,
}

describe('settings draft coordination', () => {
  it('treats a newly allocated equivalent value as persisted-identical', () => {
    expect(settingsEqual(base, { ...base })).toBe(true)
  })

  it('detects only persisted setting changes', () => {
    expect(settingsEqual(base, { ...base, runDiagnosticsOnStartup: true })).toBe(false)
    expect(settingsEqual(base, { ...base, theme: 'light' })).toBe(false)
  })

  it('detects a relaySiteId change too (W3b)', () => {
    expect(settingsEqual(base, { ...base, relaySiteId: 'sub2api' })).toBe(false)
    expect(settingsEqual({ ...base, relaySiteId: 'solov' }, { ...base, relaySiteId: 'sub2api' })).toBe(false)
    expect(settingsEqual({ ...base, relaySiteId: 'sub2api' }, { ...base, relaySiteId: 'sub2api' })).toBe(true)
  })

  it('preserves an unsaved draft across equivalent parent values', () => {
    const state: SettingsDraftState = {
      saved: base,
      draft: { ...base, runDiagnosticsOnStartup: true },
    }

    const reconciled = reconcileSettingsDraft(state, { ...base })

    expect(reconciled).toBe(state)
    expect(reconciled.draft.runDiagnosticsOnStartup).toBe(true)
  })

  it('resets the draft when persisted values change and nothing is drafted', () => {
    const state: SettingsDraftState = { saved: base, draft: base }
    const persisted = { ...base, workspace: 'D:\\projects' }

    const reconciled = reconcileSettingsDraft(state, persisted)

    expect(reconciled).toEqual({ saved: persisted, draft: persisted })
  })

  it('carries unsaved draft fields when other persisted values change', () => {
    const state: SettingsDraftState = {
      saved: base,
      draft: { ...base, runDiagnosticsOnStartup: true },
    }
    const persisted = { ...base, workspace: 'D:\\projects' }

    const reconciled = reconcileSettingsDraft(state, persisted)

    expect(reconciled).toEqual({
      saved: persisted,
      draft: { ...persisted, runDiagnosticsOnStartup: true },
    })
  })

  it('keeps a drafted checkUpdatesOnStartup while adopting an external theme change', () => {
    const state: SettingsDraftState = {
      saved: base,
      draft: { ...base, checkUpdatesOnStartup: false },
    }
    const persisted: SettingsV2 = { ...base, theme: 'light' }

    const reconciled = reconcileSettingsDraft(state, persisted)

    expect(reconciled.saved).toEqual(persisted)
    expect(reconciled.draft.theme).toBe('light')
    expect(reconciled.draft.checkUpdatesOnStartup).toBe(false)
  })

  it('carries an unsaved relaySiteId draft across an unrelated persisted change (W3b)', () => {
    const state: SettingsDraftState = {
      saved: base,
      draft: { ...base, relaySiteId: 'sub2api' },
    }
    const persisted = { ...base, workspace: 'D:\\projects' }

    const reconciled = reconcileSettingsDraft(state, persisted)

    expect(reconciled.draft.relaySiteId).toBe('sub2api')
    expect(reconciled.saved).toEqual(persisted)
  })

  it('adopts a persisted relaySiteId change when nothing is drafted for it', () => {
    const state: SettingsDraftState = { saved: base, draft: base }
    const persisted: SettingsV2 = { ...base, relaySiteId: 'sub2api' }

    const reconciled = reconcileSettingsDraft(state, persisted)

    expect(reconciled).toEqual({ saved: persisted, draft: persisted })
  })
})
