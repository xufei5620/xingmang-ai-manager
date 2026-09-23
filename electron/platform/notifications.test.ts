import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createPlatformNotifications,
  type PlatformNotificationRuntime,
} from './notifications'

function setup() {
  let enabled = true
  const preferences = { install: true, balance: true, task: true, cliUpdate: true, acceleration: true }
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

describe('acceleration reminders sent by the main process', () => {
  it('says how long is left and, on the second one, that acceleration already stopped', () => {
    const h = setup()
    expect(h.controller.notifyHost('accelerationExpiring', 'xm-account:1:t0')).toBe('requested')
    expect(h.runtime.create).toHaveBeenCalledWith({
      title: '加速还剩 5 分钟',
      body: '当前账号的免费加速时长快用完了，用完会自动断开。',
      silent: true,
    })
    // 同一次连接只提醒一次，每种各一条。
    expect(h.controller.notifyHost('accelerationExpiring', 'xm-account:1:t0')).toBe('duplicate')
    expect(h.controller.notifyHost('accelerationExhausted', 'xm-account:1:t0')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '加速已断开',
      body: '当前账号的免费加速时长已用完，加速已自动断开。',
      silent: true,
    })
    // 下一次连接换一个编号，两条都能再发。
    expect(h.controller.notifyHost('accelerationExpiring', 'xm-account:1:t1')).toBe('requested')
  })
  it('tells the user whether the network came back after an unexpected disconnect', () => {
    const h = setup()
    expect(h.controller.notifyHost('accelerationInterrupted', 'xm-account:1:t0')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '加速意外断开了',
      body: '网络已恢复正常，可以回到加速页重新连接。',
      silent: true,
    })
    expect(h.controller.notifyHost('accelerationInterruptedUnrestored', 'xm-account:1:t1')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '加速意外断开了',
      body: '网络可能暂时连不上，点这里回到加速页，星芒会再试着恢复。',
      silent: true,
    })
    h.preferences.acceleration = false
    expect(h.controller.notifyHost('accelerationInterrupted', 'xm-account:1:t2')).toBe('disabled')
  })
  it('says an automatic connection is on, is billed and where to turn it off', () => {
    const h = setup()
    expect(h.controller.notifyHost('accelerationAutoStarted', 'xm-account:1:t0')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '已为 Codex 桌面端连上加速',
      body: '打开桌面端时自动连上的，会计入免费加速时长，不用时可以在托盘或加速页断开。',
      silent: true,
    })
    expect(h.controller.notifyHost('accelerationAutoStarted', 'xm-account:1:t0')).toBe('duplicate')
  })
  it('keeps the copy free of the relay site name, top-up pitch and technical words', () => {
    const h = setup()
    h.controller.notifyHost('accelerationExpiring', 'xm-account:1:t0')
    h.controller.notifyHost('accelerationExhausted', 'xm-account:1:t0')
    h.controller.notifyHost('accelerationInterrupted', 'xm-account:1:t0')
    h.controller.notifyHost('accelerationInterruptedUnrestored', 'xm-account:1:t0')
    h.controller.notifyHost('accelerationAutoStarted', 'xm-account:1:t0')
    expect(h.runtime.create).toHaveBeenCalledTimes(5)
    for (const call of (h.runtime.create as ReturnType<typeof vi.fn>).mock.calls) {
      expect(`${call[0].title} ${call[0].body}`).not.toMatch(/solov|sub2api|new-api|充值|购买|续费|内核|进程|代理|mihomo/i)
    }
  })
  it('follows the acceleration switch and the master setting like every other category', () => {
    const h = setup()
    h.preferences.acceleration = false
    expect(h.controller.notifyHost('accelerationExhausted', 'xm-account:1:t0')).toBe('disabled')
    h.preferences.acceleration = true
    h.enable(false)
    expect(h.controller.notifyHost('accelerationExhausted', 'xm-account:1:t0')).toBe('disabled')
    h.enable(true)
    expect(h.controller.notifyHost('accelerationExhausted', 'xm-account:1:t0')).toBe('requested')
    expect(h.runtime.create).toHaveBeenCalledOnce()
  })
  it('takes the reader to the acceleration page after raising the window', () => {
    const h = setup()
    const order: string[] = []
    h.focusMainWindow.mockImplementation(() => order.push('focus'))
    h.controller.notifyHost('accelerationExhausted', 'xm-account:1:t0', () => order.push('navigate'))
    h.notifications[0].emit('click')
    expect(order).toEqual(['focus', 'navigate'])
  })
})

describe('CLI update reminders', () => {
  it('announces one pending set at a time and stays silent once its switch is off', () => {
    const h = setup()
    expect(h.controller.notify('cliUpdate', 'cli-update:claude.2.0.0')).toBe(
      'requested',
    )
    expect(h.runtime.create).toHaveBeenCalledWith({
      title: '命令行工具有新版本',
      body: '你装的工具出了新版本，回到星芒的「你的工具」就能逐个更新。',
      silent: true,
    })
    expect(h.controller.notify('cliUpdate', 'cli-update:claude.2.0.0')).toBe(
      'duplicate',
    )
    expect(h.controller.notify('cliUpdate', 'cli-update:claude.2.1.0')).toBe(
      'requested',
    )
    h.preferences.cliUpdate = false
    expect(h.controller.notify('cliUpdate', 'cli-update:codex.1.5.0')).toBe(
      'disabled',
    )
    expect(h.runtime.create).toHaveBeenCalledTimes(2)
  })
})
