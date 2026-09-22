import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { accelerationConflictNotice, accelerationFailureMessages, accelerationTrialSeconds, type AccelerationLine, type AccelerationState } from '../../../../electron/acceleration-contract'
import { AccelerationView, lineOptionTarget } from './AccelerationView'

function state(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope: 'xm-account:1', phase: 'idle', mode: 'system-proxy', totalSeconds: accelerationTrialSeconds,
    remainingSeconds: accelerationTrialSeconds, sessionSeconds: 0, measuredAt: '2026-09-20T00:00:00Z',
    connectedAt: null, line: null, error: null, ...overrides,
  }
}

function render(current: AccelerationState | null, extra: { error?: string; onViewLog?(): void; rememberedLine?: boolean; lines?: AccelerationLine[]; selectedLineId?: string } = {}) {
  return renderToStaticMarkup(<AccelerationView
    state={current} mode="system-proxy" busy={false} signedIn error={extra.error ?? null}
    onModeChange={() => undefined} onStart={() => undefined} onStartAnyway={() => undefined}
    onStop={() => undefined} onRefresh={() => undefined} onLogin={() => undefined} onHelp={() => undefined}
    onViewLog={extra.onViewLog} lines={extra.lines ?? []} selectedLineId={extra.selectedLineId ?? null}
    rememberedLine={extra.rememberedLine} linesBusy={false} linesError={null}
    onSelectLine={() => undefined} onPingLine={() => undefined} onRefreshLines={() => undefined}
  />)
}

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
    const markup = render(state({ phase: 'error', error: '加速连接失败，请检查线路和网络连接后重试。' }))
    expect(markup).toContain('acceleration-error')
    expect(markup).not.toContain('data-testid="acceleration-conflict"')
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
      // 这几句里都没有「代理」二字，所以不会被红条那两条替换规则改写。
      const message = accelerationFailureMessages[reason]
      expect([reason, render(null, { error: message }).includes(message)]).toEqual([reason, true])
    }
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
