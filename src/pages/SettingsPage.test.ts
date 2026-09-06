import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SettingsPage,
  createSettingsFieldSaver,
  reconcileSettingsDraft,
  settingsFieldPatch,
  settingsEqual,
  type SettingsFieldSaverOptions,
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

  it('detects a mirrorPolicy change too (2.4)', () => {
    expect(settingsEqual(base, { ...base, mirrorPolicy: 'mirror-first' })).toBe(false)
    expect(settingsEqual({ ...base, mirrorPolicy: 'mirror-first' }, { ...base, mirrorPolicy: 'official-first' })).toBe(false)
    expect(settingsEqual({ ...base, mirrorPolicy: 'official-first' }, { ...base, mirrorPolicy: 'official-first' })).toBe(true)
  })

  it('carries an unsaved mirrorPolicy draft across a persisted refresh', () => {
    const state: SettingsDraftState = {
      saved: base,
      draft: { ...base, mirrorPolicy: 'official-first' },
    }

    const reconciled = reconcileSettingsDraft(state, { ...base, theme: 'light' })
    expect(reconciled.draft.mirrorPolicy).toBe('official-first')
    expect(reconciled.draft.theme).toBe('light')
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

describe('appearance and window setting drafts', () => {
  it.each([
    { uiSkin: 'mist' as const },
    { reducedMotion: true },
    { uiScale: '110' as const },
    { closeBehavior: 'tray' as const },
    { desktopNotifications: true },
  ])('detects new persisted preference changes: %j', (update) => {
    expect(settingsEqual(base, { ...base, ...update })).toBe(false)
  })

  it('retains a skin and relative-scale draft during an unrelated refresh', () => {
    const current: SettingsDraftState = { saved: base, draft: { ...base, uiSkin: 'aurora', uiScale: '90' } }
    const persisted: SettingsV2 = { ...base, workspace: 'D:\\new' }
    expect(reconcileSettingsDraft(current, persisted)).toEqual({
      saved: persisted, draft: { ...persisted, uiSkin: 'aurora', uiScale: '90' },
    })
  })

  it('keeps the latest pending theme intent when an earlier theme write is returned', () => {
    const current: SettingsDraftState = { saved: { ...base, theme: 'light' }, draft: { ...base, theme: 'dark' } }
    expect(reconcileSettingsDraft(current, { ...base, theme: 'light', uiScale: '110' }, new Set(['theme'])).draft.theme).toBe('dark')
  })

  it('sends explicit reset markers and no unrelated fields', () => {
    expect(settingsFieldPatch('uiSkin', undefined)).toEqual({ version: 2, uiSkin: 'auto' })
    expect(settingsFieldPatch('uiScale', undefined)).toEqual({ version: 2, uiScale: 'auto' })
    expect(settingsFieldPatch('mirrorPolicy', undefined)).toEqual({ version: 2, mirrorPolicy: 'auto' })
    expect(settingsFieldPatch('closeBehavior', undefined)).toEqual({ version: 2, closeBehavior: 'ask' })
    expect(settingsFieldPatch('reducedMotion', false)).toEqual({ version: 2, reducedMotion: false })
    expect(settingsFieldPatch('workspace', 'D:\\new')).toEqual({ version: 2, workspace: 'D:\\new' })
    expect(settingsFieldPatch('desktopNotifications', false)).toEqual({ version: 2, desktopNotifications: false })
  })
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function saverFixture(overrides: Partial<SettingsFieldSaverOptions> = {}) {
  let confirmed = { ...base }
  const onSuccess = vi.fn()
  const onFailure = vi.fn()
  const write = vi.fn(async () => undefined)
  const options: SettingsFieldSaverOptions = {
    usesPatches: () => true,
    readConfirmed: () => confirmed,
    write,
    onCommit: (key, value) => { confirmed = { ...confirmed, [key]: value } },
    onSuccess,
    onFailure,
    ...overrides,
  }
  return { saver: createSettingsFieldSaver(options), options, write, onSuccess, onFailure, confirmed: () => confirmed }
}

describe('per-field saving', () => {
  it('saves unrelated fields while another write is still pending', async () => {
    const first = deferred()
    const fixture = saverFixture({ write: async (patch) => { if ('theme' in patch) await first.promise } })
    const theme = fixture.saver.save('theme', 'light')
    const motion = fixture.saver.save('reducedMotion', true)
    await motion
    expect(fixture.confirmed()).toMatchObject({ theme: 'dark', reducedMotion: true })
    first.resolve()
    await theme
    expect(fixture.confirmed()).toMatchObject({ theme: 'light', reducedMotion: true })
  })

  it('serializes repeated changes to one field so the final intent is written last', async () => {
    const first = deferred()
    const write = vi.fn<SettingsFieldSaverOptions['write']>().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined)
    const fixture = saverFixture({ write })
    const initial = fixture.saver.save('uiSkin', 'mist')
    const latest = fixture.saver.save('uiSkin', 'aurora')
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    first.resolve()
    await Promise.all([initial, latest])
    expect(write.mock.calls.map(([patch]) => patch)).toEqual([{ version: 2, uiSkin: 'mist' }, { version: 2, uiSkin: 'aurora' }])
    expect(fixture.confirmed().uiSkin).toBe('aurora')
    expect(fixture.onSuccess).toHaveBeenCalledExactlyOnceWith('uiSkin')
  })

  it('retains the intermediate confirmed value if the newest intent fails', async () => {
    const write = vi.fn<SettingsFieldSaverOptions['write']>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'))
    const fixture = saverFixture({ write })
    await Promise.all([fixture.saver.save('uiSkin', 'mist'), fixture.saver.save('uiSkin', 'aurora')])
    expect(fixture.confirmed().uiSkin).toBe('mist')
    expect(fixture.onSuccess).not.toHaveBeenCalled()
    expect(fixture.onFailure).toHaveBeenCalledExactlyOnceWith('uiSkin', 'disk full')
  })

  it('does not report an obsolete failure after a newer intent has been accepted', async () => {
    const write = vi.fn<SettingsFieldSaverOptions['write']>().mockRejectedValueOnce(new Error('obsolete failure')).mockResolvedValueOnce(undefined)
    const fixture = saverFixture({ write })
    await Promise.all([fixture.saver.save('uiScale', '90'), fixture.saver.save('uiScale', '110')])
    expect(fixture.confirmed().uiScale).toBe('110')
    expect(fixture.onFailure).not.toHaveBeenCalled()
    expect(fixture.onSuccess).toHaveBeenCalledExactlyOnceWith('uiScale')
  })

  it('merges legacy whole-record writes inside one queue without overwriting unrelated changes', async () => {
    const first = deferred()
    const records: SettingsV2[] = []
    const fixture = saverFixture({
      usesPatches: () => false,
      write: async (_patch, full) => { records.push(full); if (records.length === 1) await first.promise },
    })
    const theme = fixture.saver.save('theme', 'light')
    const motion = fixture.saver.save('reducedMotion', true)
    await Promise.resolve()
    expect(records).toHaveLength(1)
    first.resolve()
    await Promise.all([theme, motion])
    expect(records[1]).toMatchObject({ theme: 'light', reducedMotion: true })
    expect(fixture.confirmed()).toMatchObject({ theme: 'light', reducedMotion: true })
  })

  it('keeps confirmed directory data unchanged when a text save fails', async () => {
    const fixture = saverFixture({ write: async () => { throw new Error('directory unavailable') } })
    await fixture.saver.save('workspace', 'D:\\offline')
    expect(fixture.confirmed().workspace).toBe(base.workspace)
    expect(fixture.onFailure).toHaveBeenCalledExactlyOnceWith('workspace', 'directory unavailable')
  })

  it('finishes accepted queued writes after leaving the page while suppressing its callbacks', async () => {
    const first = deferred()
    const write = vi.fn<SettingsFieldSaverOptions['write']>().mockImplementation(() => first.promise)
    const fixture = saverFixture({ write })
    const initial = fixture.saver.save('theme', 'light')
    const queued = fixture.saver.save('theme', 'dark')
    await Promise.resolve()
    fixture.saver.dispose()
    first.resolve()
    await Promise.all([initial, queued])
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0]).toEqual({ version: 2, theme: 'dark' })
    expect(fixture.onSuccess).not.toHaveBeenCalled()
    expect(fixture.onFailure).not.toHaveBeenCalled()
    expect(fixture.confirmed().theme).toBe('dark')
  })

  it('keeps legacy full-record queued writes consistent after the page is unmounted', async () => {
    const first = deferred()
    const write = vi.fn<SettingsFieldSaverOptions['write']>().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined)
    const fixture = saverFixture({ usesPatches: () => false, write })
    const theme = fixture.saver.save('theme', 'light')
    const motion = fixture.saver.save('reducedMotion', true)
    await Promise.resolve()
    fixture.saver.dispose()
    first.resolve()
    await Promise.all([theme, motion])
    expect(write.mock.calls[1][1]).toMatchObject({ theme: 'light', reducedMotion: true })
    expect(fixture.onSuccess).not.toHaveBeenCalled()
  })
})

describe('settings section structure', () => {
  it('exposes a supported native-notification switch and clearly disables an unavailable capability', () => {
    const render = (supported?: boolean, enabled?: boolean) => renderToStaticMarkup(createElement(SettingsPage, {
      value: { ...base, desktopNotifications: enabled }, onSave: async () => {}, onReplayOnboarding: () => {}, initialSection: 'notifications', desktopNotificationsSupported: supported,
    }))
    expect(render(true)).toContain('aria-label="系统桌面通知"')
    expect(render(true)).toContain('显示由系统通知设置控制')
    expect(render(false)).toMatch(/aria-label="系统桌面通知"[^>]*disabled=""/)
    expect(render(undefined)).toContain('正在读取系统通知支持状态')
    expect(render(false, true)).not.toMatch(/aria-label="系统桌面通知"[^>]*disabled=""/)
  })
  it('provides eight named navigation entries and renders only the selected panel', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { value: base, onSave: async () => {}, onReplayOnboarding: () => {} }))
    expect(html.match(/aria-controls="settings-panel"/g)).toHaveLength(8)
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-label="界面大小"')
    expect(html).not.toContain('aria-label="服务站点"')
    expect(html).not.toContain('id="settings-workspace"')
    expect(html).not.toContain('设置工具栏')
  })
})
