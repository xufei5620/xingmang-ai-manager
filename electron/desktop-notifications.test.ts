import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopNotificationController,
  getDesktopNotificationCapability,
  updateDesktopNotification,
  type DesktopNotificationControllerOptions,
  type DesktopNotificationRuntime,
} from './desktop-notifications'
import type { UpdateSnapshot } from './updater'

vi.mock('electron', () => ({ Notification: vi.fn() }))

function update(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return { phase: 'available', currentVersion: '0.1.31', availableVersion: '0.2.0', releaseName: null, releaseNotesText: null, checkedAt: null, progress: null, error: null, development: false, ...overrides }
}

function fixture(overrides: Partial<DesktopNotificationControllerOptions> = {}, runtimeOverrides: Partial<DesktopNotificationRuntime> = {}) {
  const notifications: Array<EventEmitter & { show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
  const options: DesktopNotificationControllerOptions = { readEnabled: () => true, focusMainWindow: vi.fn(), onOpenUpdates: vi.fn(), onError: vi.fn(), ...overrides }
  const runtime: DesktopNotificationRuntime = {
    isSupported: vi.fn(() => true),
    create: vi.fn(() => { const notification = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() }); notifications.push(notification); return notification }),
    ...runtimeOverrides,
  }
  return { notifications, options, runtime, controller: createDesktopNotificationController(options, runtime) }
}

describe('desktop notification capability', () => {
  it('reports platform API support without claiming delivery permission', () => {
    expect(getDesktopNotificationCapability({ isSupported: () => true })).toEqual({ supported: true })
    expect(getDesktopNotificationCapability({ isSupported: () => false })).toEqual({ supported: false, reason: 'unsupported' })
    expect(getDesktopNotificationCapability({ isSupported: () => { throw new Error('native unavailable') } })).toEqual({ supported: false, reason: 'unavailable' })
  })
})

describe('desktop update notification content', () => {
  it.each(['checking', 'downloading', 'idle', 'cancelled', 'not-available', 'disabled', 'error'] as const)('does not announce non-actionable %s updates', (phase) => {
    expect(updateDesktopNotification(update({ phase }))).toBeNull()
  })

  it('does not expose release notes or announce failed, missing or current versions', () => {
    expect(updateDesktopNotification(update({ error: { code: 'INSTALL_FAILED', message: 'failure' } }))).toBeNull()
    expect(updateDesktopNotification(update({ availableVersion: null }))).toBeNull()
    expect(updateDesktopNotification(update({ availableVersion: '0.1.31' }))).toBeNull()
    expect(updateDesktopNotification(update({ availableVersion: 'version\nsecret' }))).toBeNull()
    const notification = updateDesktopNotification(update({ releaseNotesText: 'private detail not for toast', releaseName: 'another field' }))!
    expect(notification.title).toBe('星芒AI有可用更新')
    expect(notification.body).toBe('版本 0.2.0 已可下载。')
  })
})

describe('desktop notification lifecycle', () => {
  it('does not create system notifications before the preference is enabled', () => {
    const { controller, runtime } = fixture({ readEnabled: () => false })
    expect(controller.handleUpdate(update())).toBe('ignored')
    expect(runtime.create).not.toHaveBeenCalled()
  })

  it('reuses the last observed update when notifications are enabled later', () => {
    let enabled = false
    const { controller, notifications } = fixture({ readEnabled: () => enabled })
    controller.handleUpdate(update())
    enabled = true
    expect(controller.refresh()).toBe('requested')
    expect(notifications[0].show).toHaveBeenCalledOnce()
  })

  it('deduplicates repeated update events and preserves notification intent across intermediate progress', () => {
    const { controller, runtime } = fixture()
    expect(controller.handleUpdate(update())).toBe('requested')
    expect(controller.handleUpdate(update())).toBe('duplicate')
    expect(controller.handleUpdate(update({ phase: 'downloading', progress: { percent: 20, transferred: 20, total: 100, bytesPerSecond: 5 } }))).toBe('ignored')
    expect(controller.handleUpdate(update())).toBe('duplicate')
    expect(runtime.create).toHaveBeenCalledOnce()
  })

  it('replaces an available notice with downloaded and rejects a stale available event', () => {
    const { controller, notifications, runtime } = fixture()
    controller.handleUpdate(update())
    expect(controller.handleUpdate(update({ phase: 'downloaded' }))).toBe('requested')
    expect(notifications[0].close).toHaveBeenCalledOnce()
    expect(vi.mocked(runtime.create).mock.calls[1][0].title).toBe('星芒AI更新已下载')
    expect(controller.handleUpdate(update())).toBe('duplicate')
    expect(controller.handleUpdate(update({ phase: 'downloaded' }))).toBe('duplicate')
    expect(runtime.create).toHaveBeenCalledTimes(2)
  })

  it('allows a new version and records only a bounded number of active native notices', () => {
    const { controller, notifications } = fixture()
    for (let index = 0; index < 6; index++) expect(controller.handleUpdate(update({ availableVersion: `0.2.${index}` }))).toBe('requested')
    expect(notifications[0].close).toHaveBeenCalledOnce()
    expect(notifications[1].close).toHaveBeenCalledOnce()
    expect(notifications[5].close).not.toHaveBeenCalled()
  })

  it('focuses the main window before navigating to updates when clicked', async () => {
    const actions: string[] = []
    const { controller, notifications } = fixture({ focusMainWindow: async () => { actions.push('focus') }, onOpenUpdates: () => { actions.push('updates') } })
    controller.handleUpdate(update())
    notifications[0].emit('click')
    await vi.waitFor(() => expect(actions).toEqual(['focus', 'updates']))
  })

  it('reports a native unsupported platform without changing update or application notification state', () => {
    const { controller, runtime } = fixture({}, { isSupported: () => false })
    const state = update()
    expect(controller.handleUpdate(state)).toBe('unsupported')
    expect(runtime.create).not.toHaveBeenCalled()
    expect(state).toEqual(update())
  })

  it('does not consume a deduplication key when native creation fails', () => {
    const failure = new Error('native failed')
    const { controller, runtime, options } = fixture()
    vi.mocked(runtime.create).mockImplementationOnce(() => { throw failure })
    expect(controller.handleUpdate(update())).toBe('failed')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(controller.handleUpdate(update())).toBe('requested')
  })

  it('allows retry after an asynchronous display failure without replaying an older available notice', () => {
    const { controller, notifications, options } = fixture()
    controller.handleUpdate(update())
    controller.handleUpdate(update({ phase: 'downloaded' }))
    notifications[1].emit('failed', {}, 'Notifications disabled by system')
    expect(options.onError).toHaveBeenCalledOnce()
    expect(controller.handleUpdate(update())).toBe('duplicate')
    expect(controller.handleUpdate(update({ phase: 'downloaded' }))).toBe('requested')
  })

  it('turning off notifications closes native objects without replaying them when re-enabled', () => {
    let enabled = true
    const { controller, notifications, runtime } = fixture({ readEnabled: () => enabled })
    controller.handleUpdate(update())
    enabled = false
    expect(controller.refresh()).toBe('ignored')
    expect(notifications[0].close).toHaveBeenCalledOnce()
    expect(notifications[0].eventNames()).toEqual([])
    enabled = true
    expect(controller.refresh()).toBe('duplicate')
    expect(runtime.create).toHaveBeenCalledOnce()
  })

  it('disposes native listeners and cancels an already queued click callback', async () => {
    const { controller, notifications, options } = fixture()
    controller.handleUpdate(update())
    notifications[0].emit('click')
    controller.dispose()
    controller.dispose()
    await Promise.resolve()
    expect(options.focusMainWindow).not.toHaveBeenCalled()
    expect(notifications[0].close).toHaveBeenCalledOnce()
    expect(notifications[0].eventNames()).toEqual([])
    expect(controller.handleUpdate(update({ availableVersion: '0.3.0' }))).toBe('ignored')
  })
})

describe('auto-update wording', () => {
  it('tells the user the update installs itself when auto-update is on', () => {
    const available = updateDesktopNotification(update(), true)!
    expect(available.body).toBe('新版 0.2.0 正在后台下载，下好后关掉软件时自动装上。')
    const downloaded = updateDesktopNotification(update({ phase: 'downloaded' }), true)!
    expect(downloaded.body).toContain('自动装上')
    expect(downloaded.body).not.toContain('重启安装')
  })

  it('keeps the old wording when auto-update is off or cannot be read', () => {
    expect(updateDesktopNotification(update({ phase: 'downloaded' }))!.body).toBe('版本 0.2.0 已下载，可在更新页面重启安装。')
    const { controller, runtime } = fixture({ readAutoUpdate: () => { throw new Error('settings unreadable') } })
    controller.handleUpdate(update())
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({ body: '版本 0.2.0 已可下载。' }))
  })

  it('reads the auto-update switch through the controller', () => {
    const { controller, runtime } = fixture({ readAutoUpdate: () => true })
    controller.handleUpdate(update({ phase: 'downloaded' }))
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('自动装上') }))
  })
})

describe('install announcement', () => {
  it('shows the pre-install notice even when update notifications are turned off', () => {
    const { controller, notifications } = fixture({ readEnabled: () => false })
    expect(controller.announce({ title: '正在安装星芒AI新版本', body: '正在装新版 0.2.12' })).toBe('requested')
    expect(notifications[0].show).toHaveBeenCalledOnce()
  })

  it('stays quiet where the system has no notifications, and after dispose', () => {
    const unsupported = fixture({}, { isSupported: () => false })
    expect(unsupported.controller.announce({ title: 't', body: 'b' })).toBe('unsupported')
    const disposed = fixture()
    disposed.controller.dispose()
    expect(disposed.controller.announce({ title: 't', body: 'b' })).toBe('ignored')
  })

  it('reports a notification that fails to show instead of throwing', () => {
    const { controller, options } = fixture({}, { create: () => { throw new Error('native failed') } })
    expect(controller.announce({ title: 't', body: 'b' })).toBe('failed')
    expect(options.onError).toHaveBeenCalled()
  })
})
