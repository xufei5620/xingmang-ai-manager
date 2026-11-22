import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  buildActivityNotificationMessage,
  buildTerminalNotificationMessage,
  createPlatformNotifications,
  hiddenWindowNotification,
  hostNotificationMessage,
  resolveNotificationTarget,
  resolveTerminalNotificationTarget,
  type PlatformNotificationRuntime,
  type TerminalFailureReason,
} from './notifications'

function setup() {
  let enabled = true
  const preferences = { install: true, balance: true, task: true, cliUpdate: true, announcement: true, spend: true, acceleration: true, cliTrouble: true, cliTurn: true }
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
      title: '生成任务已完成',
      body: '任务结果已更新，请返回星芒查看。',
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
      body: '当前账号的免费加速时长即将用完，用完后将自动断开。',
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
      title: '加速意外断开',
      body: '网络已恢复，请前往「设置 › 网络加速」重新连接。',
      silent: true,
    })
    expect(h.controller.notifyHost('accelerationInterruptedUnrestored', 'xm-account:1:t1')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '加速意外断开',
      body: '网络可能暂时无法连接，请点击此处打开网络加速，星芒将尝试恢复。',
      silent: true,
    })
    h.preferences.acceleration = false
    expect(h.controller.notifyHost('accelerationInterrupted', 'xm-account:1:t2')).toBe('disabled')
  })
  it('says where the window went under the master switch alone, once per key', () => {
    const h = setup()
    for (const kind of Object.keys(h.preferences) as Array<keyof typeof h.preferences>) h.preferences[kind] = false
    expect(h.controller.notifyHost('hiddenToTray', 'first')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '星芒AI管理工具仍在运行',
      body: '窗口已缩到右下角的托盘，点击星芒图标即可打开。如未看到图标，请点击任务栏右侧的小箭头 ^。',
      silent: true,
    })
    expect(h.controller.notifyHost('hiddenToTray', 'first')).toBe('duplicate')
    expect(h.controller.notifyHost('hiddenToMenuBar', 'first')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith(expect.objectContaining({ body: '窗口已收起，点击屏幕顶部菜单栏或程序坞中的星芒图标即可打开。' }))
    h.enable(false)
    expect(h.controller.notifyHost('hiddenToTray', 'second')).toBe('disabled')
    expect(hostNotificationMessage('hiddenToTray')).toEqual({
      title: '星芒AI管理工具仍在运行',
      body: '窗口已缩到右下角的托盘，点击星芒图标即可打开。如未看到图标，请点击任务栏右侧的小箭头 ^。',
    })
  })

  it('says where the window went in each system\'s own words', () => {
    expect(hiddenWindowNotification('win32')).toBe('hiddenToTray')
    expect(hiddenWindowNotification('darwin')).toBe('hiddenToMenuBar')
    expect(hiddenWindowNotification('linux')).toBe('hiddenToPanel')
    expect(hostNotificationMessage('hiddenToPanel')).toEqual({
      title: '星芒AI管理工具仍在运行',
      body: '窗口已收起，点击屏幕顶部或任务栏右侧的星芒图标即可打开。',
    })
    // Linux 上没有 Windows 那个小箭头，也不一定在右下角。
    expect(hostNotificationMessage('hiddenToPanel').body).not.toMatch(/右下角|\^/)
  })

  it('says a payment settled after its window closed, once per order, without the order number', () => {
    const h = setup()
    for (const kind of Object.keys(h.preferences) as Array<keyof typeof h.preferences>) h.preferences[kind] = false
    expect(h.controller.notifyHost('paymentSettled', 'XM-20260925-1')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '付款已到账',
      body: '该订单已到账，余额和订阅已更新。',
      silent: true,
    })
    expect(JSON.stringify((h.runtime.create as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('XM-20260925-1')
    expect(h.controller.notifyHost('paymentSettled', 'XM-20260925-1')).toBe('duplicate')
    h.enable(false)
    expect(h.controller.notifyHost('paymentSettled', 'XM-20260925-2')).toBe('disabled')
  })

  it('keeps the copy free of the relay site name, top-up pitch and technical words', () => {
    const h = setup()
    h.controller.notifyHost('accelerationExpiring', 'xm-account:1:t0')
    h.controller.notifyHost('accelerationExhausted', 'xm-account:1:t0')
    h.controller.notifyHost('accelerationInterrupted', 'xm-account:1:t0')
    h.controller.notifyHost('accelerationInterruptedUnrestored', 'xm-account:1:t0')
    expect(h.runtime.create).toHaveBeenCalledTimes(4)
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

describe('Codex conversation too large reminders', () => {
  it('says what happened to the conversation in fixed words, once per notice, under the terminal trouble switch', () => {
    const h = setup()
    const expected = {
      codexPayloadSwitched: ['Codex 对话已切换至线路2', '该对话已超过线路1 的 100MB 上限，已为您切换至线路2。请完全退出 Codex 后重新打开，即可继续对话。'],
      codexPayloadTooLarge: ['Codex 对话体积过大，无法发送', '该对话已超过 100MB，无法通过线路1 发送。请新建对话继续，点击此处查看原因。'],
      codexPayloadLineTwoTooLarge: ['Codex 对话体积过大，无法发送', '请新建对话继续，点击此处查看原因。'],
      codexPayloadNearing: ['Codex 中有对话即将达到线路1 的上限', '超过 100MB 后将无法通过线路1 发送，建议完成当前任务后新建对话。'],
    } as const
    for (const [event, [title, body]] of Object.entries(expected) as Array<[keyof typeof expected, readonly [string, string]]>) {
      expect(h.controller.notifyHost(event, '1800000000000')).toBe('requested')
      expect(h.runtime.create).toHaveBeenLastCalledWith({ title, body, silent: true })
      expect(h.controller.notifyHost(event, '1800000000000')).toBe('duplicate')
      expect(`${title}${body}`).not.toMatch(/413|payload|rollout|compact|\/|solov|Cloudflare|CF|WebSocket|256/i)
    }
    h.preferences.cliTrouble = false
    expect(h.controller.notifyHost('codexPayloadSwitched', '1800000000001')).toBe('disabled')
  })

  it('brings the window up on click, where the card says what to do', () => {
    const h = setup()
    h.controller.notifyHost('codexPayloadTooLarge', '1800000000000')
    h.notifications[0].emit('click')
    expect(h.focusMainWindow).toHaveBeenCalledOnce()
  })
})

describe('CLI update reminders', () => {
  it('announces one pending set at a time and stays silent once its switch is off', () => {
    const h = setup()
    expect(h.controller.notify('cliUpdate', 'cli-update:claude.2.0.0')).toBe(
      'requested',
    )
    expect(h.runtime.create).toHaveBeenCalledWith({
      title: '工具有新版本',
      body: '您安装的工具有新版本，请返回星芒首页逐个更新。',
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

  // 第三十二批 B：Windows 客户日志里真发过这一条（只装了 Codex 桌面端，四家命令行工具一个没装），
  // 编号就是下面这个。标题说「命令行工具」像是发错了人。
  it('does not call a desktop app update a command-line tool update', () => {
    const message = buildActivityNotificationMessage('cliUpdate', 'cli-update:codexDesktop.26.928.3736.0')
    expect(message).toEqual({
      title: '工具有新版本',
      body: '您安装的工具有新版本，请返回星芒首页逐个更新。',
    })
    expect(`${message.title} ${message.body}`).not.toContain('命令行')
  })
})

describe('announcement reminders', () => {
  it('uses the host wording, never repeats a notice and stays silent once its switch is off', () => {
    const h = setup()
    expect(h.controller.notify('announcement', 'notice-0a1b2c3d')).toBe('requested')
    expect(h.runtime.create).toHaveBeenCalledWith({
      title: '有新公告',
      body: '当前账号有一条新公告，请返回星芒查看。',
      silent: true,
    })
    expect(h.controller.notify('announcement', 'notice-0a1b2c3d')).toBe('duplicate')
    h.preferences.announcement = false
    expect(h.controller.notify('announcement', 'notice-ffffffff')).toBe('disabled')
    expect(h.runtime.create).toHaveBeenCalledTimes(1)
  })
  it('words an empty wallet on its own under the balance switch and opens top-up on click', () => {
    const h = setup()
    expect(h.controller.notify('balance', 'balance-empty:7:1')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '当前账号余额为 $0',
      body: 'AI 工具当前无法使用，部分工具会持续重连，看似网络已断开。请点击此处充值，付款后立即生效，返回工具重新发送即可。',
      silent: true,
    })
    h.notifications[0].emit('click')
    expect(h.openPage).toHaveBeenCalledWith('topup')
    expect(h.controller.notify('balance', 'balance-empty:7:1')).toBe('duplicate')
    // The ordinary low-balance key keeps its own wording.
    expect(h.controller.notify('balance', 'balance:7:2')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({ title: '余额不足提醒', body: '星芒余额不足 $5，请前往个人中心查看并充值。', silent: true })
    h.preferences.balance = false
    expect(h.controller.notify('balance', 'balance-empty:7:3')).toBe('disabled')
  })
  it('keeps the empty-wallet wording free of tool, site and technical names', () => {
    const { title, body } = buildActivityNotificationMessage('balance', 'balance-empty:7:1')
    expect(`${title}${body}`).not.toMatch(/solov|Sub2API|API|403|Codex|Claude|npm|PATH|Key/)
    // The prefix only matters for the balance kind.
    expect(buildActivityNotificationMessage('task', 'balance-empty:7:1').title).toBe('生成任务已完成')
  })
  it('words recharge promos on their own, once per promo and once per day, under the announcement switch', () => {
    const h = setup()
    expect(h.controller.notify('announcement', 'promo:notice-0a1b2c3d')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '有新的充值活动',
      body: '当前账号有一项充值活动，请返回星芒首页，点击「前往充值」参与。',
      silent: true,
    })
    expect(h.controller.notify('announcement', 'promo:notice-0a1b2c3d')).toBe('duplicate')
    expect(h.controller.notify('announcement', 'promo-daily:notice-0a1b2c3d:20260930')).toBe('requested')
    expect(h.runtime.create).toHaveBeenLastCalledWith({
      title: '充值活动进行中',
      body: '当前账号的充值活动尚未结束，请返回星芒首页查看。',
      silent: true,
    })
    h.preferences.announcement = false
    expect(h.controller.notify('announcement', 'promo-daily:notice-0a1b2c3d:20261001')).toBe('disabled')
  })
  it('names the tool and says whether it installed, updated or failed', () => {
    const h = setup()
    h.controller.notify('install', 'install:claude:installed:1', { tool: 'claude', outcome: 'installed' })
    h.controller.notify('install', 'install:codex:updated:2', { tool: 'codex', outcome: 'updated' })
    h.controller.notify('install', 'install:node:installFailed:3', { tool: 'node', outcome: 'installFailed' })
    h.controller.notify('install', 'install:gemini:updateFailed:4', { tool: 'gemini', outcome: 'updateFailed' })
    expect(vi.mocked(h.runtime.create).mock.calls.map(([options]) => options)).toEqual([
      { title: 'Claude Code 已安装', body: '请返回星芒打开使用。', silent: true },
      { title: 'Codex CLI 已更新', body: '请返回星芒继续使用。', silent: true },
      { title: '运行环境安装失败', body: '请返回星芒查看原因，并按提示重试。', silent: true },
      { title: 'Gemini CLI 更新失败', body: '请返回星芒查看原因，并按提示重试。', silent: true },
    ])
  })
  it('falls back to a generic name for ids outside the fixed list', () => {
    const h = setup()
    h.controller.notify('install', 'install:x:1', { tool: 'constructor', outcome: 'installed' })
    h.controller.notify('install', 'install:y:2', { tool: 'unknownTool', outcome: 'installFailed' })
    expect(vi.mocked(h.runtime.create).mock.calls.map(([options]) => options.title)).toEqual(['工具已安装', '工具安装失败'])
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
      title: '近一小时消费高于平时',
      body: '过去一小时消费 $12.40，约为平时的 8 倍。如非本人使用，请返回星芒查看具体工具。',
    })
    expect(buildActivityNotificationMessage('spend', 'spend:7:1', { cents: 505, multiple: null }).body)
      .toBe('过去一小时消费 $5.05，远高于平时。如非本人使用，请返回星芒查看具体工具。')
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
      title: 'AI 回复已完成',
      body: '请返回星芒的「创作」页查看。',
    })
    expect(buildActivityNotificationMessage('task', 'image:req-1')).toEqual({
      title: '图片已生成',
      body: '请返回星芒的「创作」页查看。',
    })
    expect(buildActivityNotificationMessage('task', 'xm-account:7:12:0').title).toBe('生成任务已完成')
    // 前缀只对 task 这一类生效，别的种类照旧用自己的说法。
    expect(buildActivityNotificationMessage('balance', 'chat:1').title).toBe('余额不足提醒')
  })
  it('maps every notification kind to a fixed page decided in the main process', () => {
    expect(resolveNotificationTarget('balance', 'balance:7:1')).toBe('topup')
    expect(resolveNotificationTarget('task', 'chat:req-1')).toBe('chat')
    expect(resolveNotificationTarget('task', 'image:req-1')).toBe('chat')
    expect(resolveNotificationTarget('task', 'xm-account:7:12:0')).toBe('tasks')
    expect(resolveNotificationTarget('install', 'install:claude:installed:1')).toBe('home')
    expect(resolveNotificationTarget('cliUpdate', 'claude@2')).toBe('home')
    expect(resolveNotificationTarget('announcement', 'notice-1')).toBe('announcement')
    expect(resolveNotificationTarget('announcement', 'promo:notice-1')).toBe('home')
    expect(resolveNotificationTarget('announcement', 'promo-daily:notice-1:20260930')).toBe('home')
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
        readPreferences: () => ({ install: true, balance: true, task: true, cliUpdate: true, announcement: true, spend: true, acceleration: true, cliTrouble: true, cliTurn: true }),
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

describe('terminal tool reminders', () => {
  const reasons: TerminalFailureReason[] = ['billing', 'auth', 'busy', 'model', 'service', 'unknown']

  it('names the tool and gives a fixed reason without the word balance or site names', () => {
    for (const reason of reasons) {
      const message = buildTerminalNotificationMessage({ tool: 'claude', event: 'failed', reason })
      expect(message.title).toBe('Claude Code 未能回复')
      expect(message.body).not.toMatch(/余额|solov|Sub2API|API|npm|PATH/)
    }
    expect(buildTerminalNotificationMessage({ tool: 'claude', event: 'failed', reason: 'billing' }).body).toContain('当前账号额度不足')
    expect(buildTerminalNotificationMessage({ tool: 'gemini', event: 'waiting' }).title).toBe('Gemini CLI 等待您确认')
    expect(buildTerminalNotificationMessage({ tool: 'claude', event: 'finished' }).title).toBe('Claude Code 已完成')
    expect(buildTerminalNotificationMessage({ tool: 'codex', event: 'finished' }).title).toBe('Codex 已完成')
    expect(buildTerminalNotificationMessage({ tool: 'grok', event: 'failed', reason: 'auth' }).title).toBe('Grok 未能回复')
    expect(buildTerminalNotificationMessage({ tool: 'grok', event: 'waiting' }).title).toBe('Grok 等待您确认')
    expect(buildTerminalNotificationMessage({ tool: 'grok', event: 'finished' }).title).toBe('Grok 已完成')
  })

  it('sends billing trouble to top-up, other trouble to the check page and turn reminders nowhere', () => {
    expect(resolveTerminalNotificationTarget({ tool: 'claude', event: 'failed', reason: 'billing' })).toBe('topup')
    for (const reason of reasons.filter((value) => value !== 'billing')) {
      expect(resolveTerminalNotificationTarget({ tool: 'claude', event: 'failed', reason })).toBe('health')
    }
    expect(resolveTerminalNotificationTarget({ tool: 'claude', event: 'waiting' })).toBeNull()
    expect(resolveTerminalNotificationTarget({ tool: 'gemini', event: 'finished' })).toBeNull()
  })

  it('follows its own two switches and opens the fixed page on click', () => {
    const { controller, preferences, notifications, openPage } = setup()
    expect(controller.notifyTerminal({ tool: 'claude', event: 'failed', reason: 'billing' }, 'a')).toBe('requested')
    notifications[0].emit('click')
    expect(openPage).toHaveBeenCalledWith('topup')
    expect(controller.notifyTerminal({ tool: 'claude', event: 'failed', reason: 'billing' }, 'a')).toBe('duplicate')
    preferences.cliTrouble = false
    expect(controller.notifyTerminal({ tool: 'claude', event: 'failed', reason: 'auth' }, 'b')).toBe('disabled')
    expect(controller.notifyTerminal({ tool: 'claude', event: 'waiting' }, 'c')).toBe('requested')
    notifications[1].emit('click')
    expect(openPage).toHaveBeenCalledTimes(1)
    preferences.cliTurn = false
    expect(controller.notifyTerminal({ tool: 'claude', event: 'finished' }, 'd')).toBe('disabled')
  })
})
