import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { accelerationConflictNotice, accelerationFailureMessages, accelerationTrialSeconds, type AccelerationLine, type AccelerationState } from '../../../../electron/acceleration-contract'
import { AccelerationView, bundleDamagedNotice, formatAccelerationDuration, lineButtonText } from './AccelerationView'

function state(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope: 'xm-account:1', phase: 'idle', mode: 'system-proxy', totalSeconds: accelerationTrialSeconds,
    remainingSeconds: accelerationTrialSeconds, sessionSeconds: 0, measuredAt: '2026-09-20T00:00:00Z',
    connectedAt: null, line: null, error: null, ...overrides,
  }
}

function render(current: AccelerationState | null, extra: { error?: string; onViewLog?(): void; rememberedLine?: boolean; lines?: AccelerationLine[]; selectedLineId?: string; bundleCheck?: 'checking' | 'damaged' | 'repaired' | null } = {}) {
  return renderToStaticMarkup(<AccelerationView
    state={current} busy={false} signedIn error={extra.error ?? null}
    onStart={() => undefined} onStartAnyway={() => undefined}
    onStop={() => undefined} onRefresh={() => undefined} onLogin={() => undefined} onHelp={() => undefined}
    onViewLog={extra.onViewLog} lines={extra.lines ?? []} selectedLineId={extra.selectedLineId ?? null}
    rememberedLine={extra.rememberedLine} linesBusy={false} linesError={null}
    onSelectLine={() => undefined} onRefreshLines={() => undefined}
    bundleCheck={extra.bundleCheck} onRecheckBundle={() => undefined} onContactSupport={() => undefined} onRelaunch={() => undefined}
  />)
}

// 第二十一批 6：加速只走系统代理，那颗从没开放过的模式开关连同「标准模式」字样一起拿掉，
// 连上以后也不能再冒出来（状态里仍可能带 mode 字段）。
describe('acceleration mode switch', () => {
  it('shows no mode switch before or after connecting', () => {
    for (const current of [state(), state({ phase: 'active' })]) {
      const markup = render(current)
      expect(markup).not.toContain('acceleration-mode-toggle')
      expect(markup).not.toMatch(/TUN|标准模式|增强模式|暂未开放/)
    }
  })
})

const rememberedLine: AccelerationLine = { id: 'hk-02', name: '香港线路', region: 'HK', latencyMs: 31 }

describe('acceleration remembered line', () => {
  it('says the selected line is the one from last time', () => {
    const markup = render(state(), { rememberedLine: true, lines: [rememberedLine], selectedLineId: rememberedLine.id })
    expect(markup).toContain('data-testid="acceleration-line-remembered"')
    expect(markup).toContain('已选中你上次用的线路')
    expect(markup).toContain('香港线路')
  })

  it('stays silent when the user picked the line in this session', () => {
    const markup = render(state(), { lines: [rememberedLine], selectedLineId: rememberedLine.id })
    expect(markup).not.toContain('acceleration-line-remembered')
  })

  // 连上之后线路由状态说了算，这句提示没有位置也没有意义。
  it('stays silent once the session is connected', () => {
    const markup = render(state({ phase: 'active', connectedAt: '2026-09-22T00:00:00Z', line: rememberedLine }),
      { rememberedLine: true, lines: [rememberedLine], selectedLineId: rememberedLine.id })
    expect(markup).not.toContain('acceleration-line-remembered')
  })
})

describe('acceleration conflict notice', () => {
  const conflicted = state({
    phase: 'error', error: accelerationConflictNotice, conflicts: ['system-proxy', 'virtual-adapter'],
  })

  it('offers 仍然连接 beside the warning instead of only refusing', () => {
    const markup = render(conflicted)
    expect(markup).toContain('data-testid="acceleration-conflict"')
    expect(markup).toContain(accelerationConflictNotice)
    expect(markup).toContain('系统代理已被其他程序设置；检测到 VPN 虚拟网卡')
    // 重新检测靠主按钮走一次完整的连接请求，这里不放一个只会重读缓存状态的按钮。
    expect(markup).toContain('关掉之后再点「开启加速」会重新检测')
    expect(markup).toContain('data-testid="acceleration-conflict-force"')
    expect(markup).toContain('仍然连接')
    // 开启加速仍然可用：冲突是提醒，不是把入口关掉。
    expect(markup).toContain('data-testid="acceleration-session-start"')
  })

  it('does not repeat the same sentence in the generic error strip', () => {
    expect(render(conflicted)).not.toContain('acceleration-error')
  })

  it('leaves an ordinary failure with its own strip and no override button', () => {
    const markup = render(state({ phase: 'error', error: '加速没能打开：这条线路现在连不通。在「线路」那里换一条线路试试。' }))
    expect(markup).toContain('acceleration-error')
    expect(markup).not.toContain('data-testid="acceleration-conflict"')
  })

  // 并进设置以后整张卡不高，提示条挂在卡里开关那一排下面，跟着这张卡走。
  it('keeps every strip inside the card under the switch row', () => {
    const switchRow = (markup: string) => markup.indexOf('data-testid="acceleration-session-start"')
    const failed = render(state({ phase: 'error', error: '加速没能打开：加速组件刚要运行就被拦下了。' }))
    expect(failed.indexOf('data-testid="acceleration-error"')).toBeGreaterThan(switchRow(failed))
    const conflict = render(state({ phase: 'error', error: accelerationConflictNotice, conflicts: ['system-proxy'] }))
    expect(conflict.indexOf('data-testid="acceleration-conflict"')).toBeGreaterThan(switchRow(conflict))
    for (const markup of [failed, conflict]) expect(markup.lastIndexOf('</section>')).toBe(markup.length - '</section>'.length)
  })

  it('marks a failure with an alert sign rather than a question mark', () => {
    const markup = render(state({ phase: 'error', error: '加速没能打开：加速组件刚要运行就被拦下了。' }))
    const strip = markup.slice(markup.indexOf('data-testid="acceleration-error"'))
    // 用设置里通用的红色提示条（v4 批09），图标是它的叉号。
    expect(strip.slice(0, strip.indexOf('<div>'))).toContain('lucide-circle-x')
    expect(strip.slice(0, strip.indexOf('</div>'))).not.toContain('lucide-circle-help')
  })

  it('shows nothing extra on a machine with no conflict', () => {
    const markup = render(state())
    expect(markup).not.toContain('acceleration-conflict')
    expect(markup).not.toContain('acceleration-error')
  })
})

describe('acceleration error strip', () => {
  // 读状态失败时状态是 null，主按钮因此停在「正在读取状态…」并且点不动——这条
  // 红条是用户唯一的出口，所以它必须同时说出原因并给到日志（2026-09-22 客户机）。
  const unavailable = accelerationFailureMessages['helper-temp']

  it('offers the log beside 重新检查 when the page can navigate there', () => {
    const markup = render(null, { error: unavailable, onViewLog: () => undefined })
    expect(markup).toContain('data-testid="acceleration-error-log"')
    expect(markup).toContain('查看日志')
    expect(markup).toContain('重新检查')
    expect(markup).toContain('正在读取状态')
  })

  it('leaves the strip as it was when no navigation is wired in', () => {
    const markup = render(null, { error: unavailable })
    expect(markup).toContain('acceleration-error')
    expect(markup).not.toContain('data-testid="acceleration-error-log"')
  })

  it('names the cause rather than one sentence for every failure', () => {
    for (const reason of ['helper-temp', 'proxy-owned', 'proxy-locked', 'proxy-declined', 'local-data'] as const) {
      const message = accelerationFailureMessages[reason]
      expect([reason, render(null, { error: message }).includes(message)]).toEqual([reason, true])
    }
  })
})

describe('acceleration error wording', () => {
  it('shows the host sentence as written instead of rewriting words inside it', () => {
    // 原来把「代理」机械换成「网络连接」，造出过「加速网络连接连通性验证失败」。
    const markup = render(null, { error: '检测到其他代理或 VPN 正在运行' })
    expect(markup).toContain('检测到其他代理或 VPN 正在运行')
    expect(markup).not.toContain('网络连接或 VPN')
  })

  it('offers customer support beside a failed start', () => {
    const markup = render(state({ phase: 'error', error: '加速没能打开：加速组件刚要运行就被拦下了。' }), { onViewLog: () => undefined })
    expect(markup).toContain('data-testid="acceleration-error-support"')
    expect(markup).toContain('data-testid="acceleration-error-log"')
    expect(markup).toContain('重新检查')
  })

  it('keeps the support button off a strip that is not a failed start', () => {
    const markup = render(null, { error: accelerationFailureMessages['helper-temp'] })
    expect(markup).not.toContain('data-testid="acceleration-error-support"')
  })
})

describe('acceleration bundle damaged', () => {
  const damaged = () => state({ phase: 'unavailable', remainingSeconds: null, line: null, unavailableReason: 'bundle-damaged' })

  it('explains the damaged files instead of waiting for lines', () => {
    const markup = render(damaged())
    expect(markup).toContain('加速文件损坏')
    expect(markup).toContain('多半是杀毒软件把它当成了可疑文件')
    expect(markup).toContain('修好之前不计时')
    expect(markup).toContain('data-testid="acceleration-bundle-recheck"')
    expect(markup).toContain('data-testid="acceleration-bundle-support"')
    expect(markup).not.toContain('线路准备中')
    expect(markup).not.toContain('刷新线路状态')
    // 安装器是否保留聊天记录没实测过，不许承诺。
    expect(markup).not.toContain('聊天记录')
  })

  // 出错条上那颗「重新检查」重读的是加速状态，这颗查的是文件，名字分开。
  it('names the file check after what it checks', () => {
    const markup = render(damaged())
    expect(markup).toMatch(/data-testid="acceleration-bundle-recheck"[^>]*>.*?检查加速文件/)
    expect(markup).toContain('然后点「检查加速文件」')
    expect(markup).toContain('照下面的办法处理后点「检查加速文件」')
    expect(markup).not.toContain('点「重新检查」')
  })

  it('keeps the plain waiting copy when no reason is given', () => {
    const markup = render(state({ phase: 'unavailable', remainingSeconds: null, line: null }))
    expect(markup).toContain('线路准备中')
    expect(markup).not.toContain('acceleration-bundle-damaged')
  })

  it('offers a relaunch once the recheck finds the files restored', () => {
    const markup = render(damaged(), { bundleCheck: 'repaired' })
    expect(markup).toContain('加速文件恢复了，重新打开星芒后就能用。')
    expect(markup).toContain('data-testid="acceleration-bundle-relaunch"')
    expect(markup).not.toContain('data-testid="acceleration-bundle-recheck"')
  })

  it('says the files are still wrong after a failed recheck', () => {
    expect(bundleDamagedNotice('damaged').title).toBe('加速文件还是不对。请先在杀毒软件里恢复，或者重新安装一次星芒。')
    expect(bundleDamagedNotice(null).title).toBe('加速用的文件被删掉或改动了，现在开不了加速。')
  })
})

describe('acceleration line switch', () => {
  it('offers the line button in the line row before connecting', () => {
    const markup = render(state())
    const row = markup.slice(markup.indexOf('class="acceleration-line-row"'))
    expect(row).toMatch(/<span>线路<\/span>/)
    expect(row).toMatch(/data-testid="acceleration-line-picker-toggle"[^>]*>.*?自动选择/)
    expect(markup).not.toMatch(/data-testid="acceleration-line-picker-toggle"[^>]*disabled/)
  })

  // 连着的时候按钮照样摆着，写的是连上的那条，只是点不了：要换线路先停止加速。
  it('locks the line button once connected and names the connected line', () => {
    const markup = render(state({ phase: 'active', connectedAt: '2026-09-22T00:00:00Z', line: rememberedLine }), { lines: [rememberedLine] })
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="acceleration-line-picker-toggle"|data-testid="acceleration-line-picker-toggle"[^>]*disabled=""/)
    expect(markup).toContain('自动选择（香港线路） · 31 ms')
  })

  it('writes the button text the way the line was chosen', () => {
    expect(lineButtonText(null, null, false)).toBe('自动选择')
    // 没连上时不知道「自动」会选哪条，测过延迟的那条也不写。
    expect(lineButtonText(null, rememberedLine, false)).toBe('自动选择')
    expect(lineButtonText(null, rememberedLine, true)).toBe('自动选择（香港线路） · 31 ms')
    expect(lineButtonText('hk-02', rememberedLine, false)).toBe('香港线路 · 31 ms')
    expect(lineButtonText('hk-02', { ...rememberedLine, latencyMs: null }, false)).toBe('香港线路')
    // 记住的那条已经不在名单里：退回自动选择的写法，不写一个空名字。
    expect(lineButtonText('gone', undefined, false)).toBe('自动选择')
  })
})

describe('acceleration card copy', () => {
  it('says what the card is for and how much free time is left', () => {
    const markup = render(state({ remainingSeconds: 754 }))
    expect(markup).toContain('网络加速</h2>')
    expect(markup).toContain('为游戏走一条更快的线路，当前账号的 AI 工具照常直连，剩余免费时长 <span data-testid="acceleration-quota-remaining">12 分 34 秒</span>')
    expect(markup).toMatch(/data-testid="acceleration-session-start"[^>]*>.*?开启加速/)
    expect(markup).toContain('data-testid="acceleration-help-open"')
    // 地球动画、三格详情去掉了，计时规则在「使用帮助」里。
    expect(markup).not.toMatch(/acceleration-globe|累计使用|免费额度规则/)
  })

  it('turns into 网络加速已开启 with the session length while connected', () => {
    const markup = render(state({ phase: 'active', connectedAt: '2026-09-22T00:00:00Z', line: rememberedLine, sessionSeconds: 65, remainingSeconds: 600 }))
    expect(markup).toContain('class="acceleration-card is-active"')
    expect(markup).toContain('网络加速已开启</h2>')
    expect(markup).toContain('已连接 <span data-testid="acceleration-session-duration">1 分 5 秒</span>，剩余免费时长 <span data-testid="acceleration-quota-remaining">10 分钟</span>')
    expect(markup).toMatch(/data-testid="acceleration-session-stop"[^>]*>.*?停止加速/)
  })

  it('keeps the timing rule when the remaining time is unknown', () => {
    const markup = render(state({ remainingSeconds: null }))
    expect(markup).toContain('连接成功才计时，随时停止，剩余下次继续')
    expect(markup).not.toContain('acceleration-quota-remaining')
  })

  it('writes durations the way people say them', () => {
    expect(formatAccelerationDuration(0)).toBe('0 秒')
    expect(formatAccelerationDuration(40)).toBe('40 秒')
    expect(formatAccelerationDuration(60)).toBe('1 分钟')
    expect(formatAccelerationDuration(725)).toBe('12 分 5 秒')
    expect(formatAccelerationDuration(3600)).toBe('1 小时')
    expect(formatAccelerationDuration(9600)).toBe('2 小时 40 分')
    // 剩余时长往上取整：还剩半秒不写成 0 秒。
    expect(formatAccelerationDuration(0.4, true)).toBe('1 秒')
    expect(formatAccelerationDuration(-3)).toBe('0 秒')
  })
})

describe('acceleration trial used up', () => {
  const exhausted = () => state({ phase: 'exhausted', remainingSeconds: 0 })

  it('turns the main button into contacting support', () => {
    const markup = render(exhausted())
    expect(markup).toMatch(/data-testid="acceleration-contact-support"[^>]*>.*?联系客服/)
    expect(markup).not.toContain('data-testid="acceleration-session-start"')
    expect(markup).not.toContain('免费体验已用完')
    expect(markup).toContain('免费体验已经用完，后续服务请联系客服')
    expect(markup).toContain('体验已结束')
  })

  it('drops the line switch and the status refresh', () => {
    const markup = render(exhausted())
    expect(markup).not.toContain('acceleration-line-picker-toggle')
    expect(markup).not.toContain('acceleration-status-refresh')
    expect(markup).not.toContain('帮助与客服')
  })
})
