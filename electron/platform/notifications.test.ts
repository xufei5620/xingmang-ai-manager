import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createPlatformNotifications,
  type PlatformNotificationRuntime,
} from './notifications'

function setup() {
  let enabled = true
  const preferences = { install: true, balance: true, task: true }
  const notifications: Array<
    EventEmitter & {
      show: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }
  > = []
  const runtime: PlatformNotificationRuntime = {
    supported: vi.fn(() => true),
    create: vi.fn(() => {
      const notice = Object.assign(new EventEmitter(), {
        show: vi.fn(),
        close: vi.fn(),
      })
      notifications.push(notice)
      return notice
    }),
  }
  const focusMainWindow = vi.fn()
  const onError = vi.fn()
  const controller = createPlatformNotifications(
    {
      readEnabled: () => enabled,
      readPreferences: () => preferences,
      focusMainWindow,
      onError,
    },
    runtime,
  )
  return {
    controller,
    preferences,
    notifications,
    runtime,
    focusMainWindow,
    onError,
    enable: (value: boolean) => {
      enabled = value
    },
  }
}
describe('bounded native activity notifications', () => {
  it('respects the existing master setting and category preference before constructing native notifications', () => {
    const h = setup()
    h.enable(false)
    expect(h.controller.notify('test', 'test')).toBe('disabled')
    h.enable(true)
    h.preferences.task = false
    expect(h.controller.notify('task', 'user:task-1')).toBe('disabled')
    expect(h.runtime.create).not.toHaveBeenCalled()
  })
  it('only shows fixed copy and deduplicates events, while test notification may repeat', () => {
    const h = setup()
    expect(h.controller.notify('task', 'user:task-1')).toBe('requested')
    expect(h.controller.notify('task', 'user:task-1')).toBe('duplicate')
    expect(h.runtime.create).toHaveBeenCalledWith({
      title: '异步任务已完成',
      body: '任务结果已经更新，可以回到星芒工具箱查看。',
      silent: true,
    })
    h.notifications[0].emit('click')
    expect(h.focusMainWindow).toHaveBeenCalledOnce()
    expect(h.controller.notify('test', 'test')).toBe('requested')
    expect(h.controller.notify('test', 'test')).toBe('requested')
    h.controller.dispose()
    expect(
      h.notifications.every((notice) => notice.close.mock.calls.length === 1),
    ).toBe(true)
  })
  it('allows retry after an asynchronous native failure', () => {
    const h = setup()
    h.controller.notify('install', '1')
    h.notifications[0].emit('failed', {}, 'OS error')
    expect(h.onError).toHaveBeenCalledOnce()
    expect(h.controller.notify('install', '1')).toBe('requested')
  })
})
