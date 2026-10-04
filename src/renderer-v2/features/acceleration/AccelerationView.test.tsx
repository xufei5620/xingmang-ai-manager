import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { accelerationConflictNotice, accelerationFailureMessages, accelerationTrialSeconds, type AccelerationLine, type AccelerationState } from '../../../../electron/acceleration-contract'
import { AccelerationView, bundleDamagedNotice, lineOptionTarget } from './AccelerationView'

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
    onSelectLine={() => undefined} onPingLine={() => undefined} onRefreshLines={() => undefined}
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
    expect(markup).toContain('关掉之后再点「开始加速」会重新检测')
    expect(markup).toContain('data-testid="acceleration-conflict-force"')
    expect(markup).toContain('仍然连接')
    // 开始加速仍然可用：冲突是提醒，不是把入口关掉。
    expect(markup).toContain('data-testid="acceleration-session-start"')
  })

  it('does not repeat the same sentence in the generic error strip', () => {
    expect(render(conflicted)).not.toContain('acceleration-error')
  })

  it('leaves an ordinary failure with its own strip and no override button', () => {
    const markup = render(state({ phase: 'error', error: '加速没能打开：这条线路现在连不通。点「换线路」换一条线路试试。' }))
    expect(markup).toContain('acceleration-error')
    expect(markup).not.toContain('data-testid="acceleration-conflict"')
  })

  // 窗口矮的时候工作台下面在第一屏外，提示条放在那里等于没说。
  it('puts every strip between the heading and the workbench', () => {
    const workbench = (markup: string) => markup.indexOf('class="acceleration-workbench"')
    const failed = render(state({ phase: 'error', error: '加速没能打开：加速组件刚要运行就被拦下了。' }))
    expect(failed.indexOf('data-testid="acceleration-error"')).toBeGreaterThan(-1)
    expect(failed.indexOf('data-testid="acceleration-error"')).toBeLessThan(workbench(failed))
    const conflict = render(state({ phase: 'error', error: accelerationConflictNotice, conflicts: ['system-proxy'] }))
    expect(conflict.indexOf('data-testid="acceleration-conflict"')).toBeLessThan(workbench(conflict))
    const damaged = render(state({ phase: 'unavailable', remainingSeconds: null, line: null, unavailableReason: 'bundle-damaged' }))
    expect(damaged.indexOf('data-testid="acceleration-bundle-damaged"')).toBeLessThan(workbench(damaged))
  })

  it('marks a failure with an alert sign rather than a question mark', () => {
    const markup = render(state({ phase: 'error', error: '加速没能打开：加速组件刚要运行就被拦下了。' }))
    const strip = markup.slice(markup.indexOf('data-testid="acceleration-error"'))
    expect(strip).toContain('lucide-circle-alert')
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
    for (const reason of ['helper-temp', 'proxy-owned', 'proxy-locked', 'local-data'] as const) {
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

describe('acceleration line list keys', () => {
  it('moves one row at a time and stops at both ends instead of wrapping', () => {
    expect(lineOptionTarget('ArrowDown', 0, 4)).toBe(1)
    expect(lineOptionTarget('ArrowDown', 3, 4)).toBe(3)
    expect(lineOptionTarget('ArrowUp', 2, 4)).toBe(1)
    expect(lineOptionTarget('ArrowUp', 0, 4)).toBe(0)
  })

  it('jumps to the first and last rows with Home and End', () => {
    expect(lineOptionTarget('Home', 2, 4)).toBe(0)
    expect(lineOptionTarget('End', 0, 4)).toBe(3)
  })

  it('leaves every other key to the row and its buttons', () => {
    for (const key of ['Enter', ' ', 'Tab', 'ArrowLeft', 'a']) expect(lineOptionTarget(key, 1, 4)).toBeNull()
    expect(lineOptionTarget('ArrowDown', 0, 0)).toBeNull()
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
  it('offers 换线路 in the line row before connecting', () => {
    const markup = render(state())
    expect(markup).toMatch(/data-testid="acceleration-line-picker-toggle"[^>]*>.*?换线路/)
    expect(markup).not.toContain('选择加速线路')
    const row = markup.slice(markup.indexOf('class="acceleration-route-info"'), markup.indexOf('class="acceleration-stage-bottom"'))
    expect(row).toContain('data-testid="acceleration-line-picker-toggle"')
  })

  it('takes the switch away once connected', () => {
    expect(render(state({ phase: 'active', connectedAt: '2026-09-22T00:00:00Z', line: rememberedLine }))).not.toContain('acceleration-line-picker-toggle')
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
    expect(markup).toContain('额度已用完')
  })

  it('drops the line switch and the small help button under the globe', () => {
    const markup = render(exhausted())
    expect(markup).not.toContain('acceleration-line-picker-toggle')
    expect(markup).not.toContain('acceleration-status-refresh')
    expect(markup).not.toContain('帮助与客服')
  })
})
