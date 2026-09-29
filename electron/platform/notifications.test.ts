import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  buildActivityNotificationMessage,
  createPlatformNotifications,
  hostNotificationMessage,
  resolveNotificationTarget,
  type PlatformNotificationRuntime,
} from './notifications'

function setup() {
  let enabled = true
  const preferences = { install: true, balance: true, task: true, cliUpdate: true, announcement: true, spend: true, acceleration: true }
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
  const openPage = vi.fn()
  const onError = vi.fn()
  const controller = createPlatformNotifications(
    {
      readEnabled: () => enabled,
      readPreferences: () => preferences,
      focusMainWindow,
      openPage,
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
    openPage,
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
  it('says where the window went under the master switch alone, once per key', () => {
    const h = setup()
    for (const kind of Object.keys(h.preferences) as Array<keyof typeof h.preferences>) h.preferences[kind] = false
    expect(h.controller.notifyHost('hiddenToTray', 'first')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '星芒AI管理工具还在运行',
      body: '窗口缩到了右下角的托盘里，点星芒图标就能打开。看不到图标的话，点任务栏右边的小箭头 ^。',
      silent: true,
    })
    expect(h.controller.notifyHost('hiddenToTray', 'first')).toBe('duplicate')
    expect(h.controller.notifyHost('hiddenToMenuBar', 'first')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith(expect.objectContaining({ body: '窗口已收起，点屏幕顶部菜单栏里的星芒图标就能打开。' }))
    h.enable(false)
    expect(h.controller.notifyHost('hiddenToTray', 'second')).toBe('disabled')
    expect(hostNotificationMessage('hiddenToTray')).toEqual({
      title: '星芒AI管理工具还在运行',
      body: '窗口缩到了右下角的托盘里，点星芒图标就能打开。看不到图标的话，点任务栏右边的小箭头 ^。',
    })
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

describe('announcement reminders', () => {
  it('uses the host wording, never repeats a notice and stays silent once its switch is off', () => {
    const h = setup()
    expect(h.controller.notify('announcement', 'notice-0a1b2c3d')).toBe('requested')
    expect(h.runtime.create).toHaveBeenCalledWith({
      title: '有新公告',
      body: '当前账号有一条新公告，回到星芒就能看到。',
      silent: true,
    })
    expect(h.controller.notify('announcement', 'notice-0a1b2c3d')).toBe('duplicate')
    h.preferences.announcement = false
    expect(h.controller.notify('announcement', 'notice-ffffffff')).toBe('disabled')
    expect(h.runtime.create).toHaveBeenCalledTimes(1)
  })
  it('names the tool and says whether it installed, updated or failed', () => {
    const h = setup()
    h.controller.notify('install', 'install:claude:installed:1', { tool: 'claude', outcome: 'installed' })
    h.controller.notify('install', 'install:codex:updated:2', { tool: 'codex', outcome: 'updated' })
    h.controller.notify('install', 'install:node:installFailed:3', { tool: 'node', outcome: 'installFailed' })
    h.controller.notify('install', 'install:gemini:updateFailed:4', { tool: 'gemini', outcome: 'updateFailed' })
    expect(vi.mocked(h.runtime.create).mock.calls.map(([options]) => options)).toEqual([
      { title: 'Claude Code 装好了', body: '回到星芒就能打开使用。', silent: true },
      { title: 'Codex CLI 已经更新好了', body: '回到星芒就能接着用。', silent: true },
      { title: '运行环境没装上', body: '回到星芒看看原因，照提示点一下就能重试。', silent: true },
      { title: 'Gemini CLI 没更新好', body: '回到星芒看看原因，照提示点一下就能重试。', silent: true },
    ])
  })
  it('falls back to a generic name for ids outside the fixed list', () => {
    const h = setup()
    h.controller.notify('install', 'install:x:1', { tool: 'constructor', outcome: 'installed' })
    h.controller.notify('install', 'install:y:2', { tool: 'unknownTool', outcome: 'installFailed' })
    expect(vi.mocked(h.runtime.create).mock.calls.map(([options]) => options.title)).toEqual(['工具装好了', '工具没装上'])
  })
  it('keeps install results behind the install switch', () => {
    const h = setup()
    h.preferences.install = false
    expect(h.controller.notify('install', 'install:claude:installFailed:1', { tool: 'claude', outcome: 'installFailed' })).toBe('disabled')
    expect(h.runtime.create).not.toHaveBeenCalled()
  })
})

describe('spend spike reminders', () => {
  it('writes the amount and multiple in a fixed format built in the main process', () => {
    expect(buildActivityNotificationMessage('spend', 'spend:7:1', { cents: 1240, multiple: 8 })).toEqual({
      title: '这一小时花得比平时多',
      body: '过去一小时用掉了 $12.40，大约是平时的 8 倍。如果不是你在用，回星芒看看是哪个工具。',
    })
    expect(buildActivityNotificationMessage('spend', 'spend:7:1', { cents: 505, multiple: null }).body)
      .toBe('过去一小时用掉了 $5.05，比平时多很多。如果不是你在用，回星芒看看是哪个工具。')
  })
  it('can be switched off on its own and opens the usage page on click', () => {
    const h = setup()
    h.openPage.mockImplementation(() => undefined)
    h.preferences.spend = false
    expect(h.controller.notify('spend', 'spend:7:1', { cents: 1240, multiple: 8 })).toBe('disabled')
    h.preferences.spend = true
    expect(h.controller.notify('spend', 'spend:7:1', { cents: 1240, multiple: 8 })).toBe('requested')
    expect(h.controller.notify('spend', 'spend:7:1', { cents: 1240, multiple: 8 })).toBe('duplicate')
    h.notifications[0].emit('click')
    expect(h.openPage).toHaveBeenCalledWith('usage')
  })
  it('never names the relay site', () => {
    const { title, body } = buildActivityNotificationMessage('spend', 'spend:7:1', { cents: 1240, multiple: 8 })
    expect(`${title} ${body}`).not.toMatch(/solov|new-api|relay|sub2api|API/i)
  })
})

describe('chat notifications and click destinations', () => {
  it('uses chat-specific copy for chat and image completions instead of the async task sentence', () => {
    expect(buildActivityNotificationMessage('task', 'chat:req-1')).toEqual({
      title: 'AI 回复好了',
      body: '回到星芒的「聊天」查看。',
    })
    expect(buildActivityNotificationMessage('task', 'image:req-1')).toEqual({
      title: '图片生成好了',
      body: '回到星芒的「聊天」查看。',
    })
    expect(buildActivityNotificationMessage('task', 'xm-account:7:12:0').title).toBe('异步任务已完成')
    // 前缀只对 task 这一类生效，别的种类照旧用自己的说法。
    expect(buildActivityNotificationMessage('balance', 'chat:1').title).toBe('余额需要留意')
  })
  it('maps every notification kind to a fixed page decided in the main process', () => {
    expect(resolveNotificationTarget('balance', 'balance:7:1')).toBe('topup')
    expect(resolveNotificationTarget('task', 'chat:req-1')).toBe('chat')
    expect(resolveNotificationTarget('task', 'image:req-1')).toBe('chat')
    expect(resolveNotificationTarget('task', 'xm-account:7:12:0')).toBe('tasks')
    expect(resolveNotificationTarget('install', 'install:claude:installed:1')).toBe('home')
    expect(resolveNotificationTarget('cliUpdate', 'claude@2')).toBe('home')
    expect(resolveNotificationTarget('announcement', 'notice-1')).toBe('announcement')
    expect(resolveNotificationTarget('spend', 'spend:7:1')).toBe('usage')
    expect(resolveNotificationTarget('test', 'test')).toBeNull()
  })
  it('focuses the window before opening the destination page on click', () => {
    const h = setup()
    const order: string[] = []
    h.focusMainWindow.mockImplementation(() => order.push('focus'))
    h.openPage.mockImplementation((target: string) => order.push(target))
    h.controller.notify('task', 'chat:req-1')
    h.controller.notify('balance', 'balance:7:1')
    h.controller.notify('test', 'test')
    h.notifications[0].emit('click')
    h.notifications[1].emit('click')
    h.notifications[2].emit('click')
    expect(order).toEqual(['focus', 'chat', 'focus', 'topup', 'focus'])
  })
  it('still only focuses the window when no page opener is wired', () => {
    const notices: EventEmitter[] = []
    const focusMainWindow = vi.fn()
    const onError = vi.fn()
    const controller = createPlatformNotifications(
      {
        readEnabled: () => true,
        readPreferences: () => ({ install: true, balance: true, task: true, cliUpdate: true, announcement: true, spend: true, acceleration: true }),
        focusMainWindow,
        onError,
      },
      {
        supported: () => true,
        create: () => {
          const notice = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() })
          notices.push(notice)
          return notice
        },
      },
    )
    controller.notify('balance', 'balance:7:1')
    notices[0].emit('click')
    expect(focusMainWindow).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})
