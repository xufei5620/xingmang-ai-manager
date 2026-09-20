import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { accelerationConflictNotice, accelerationTrialSeconds, type AccelerationState } from '../../../../electron/acceleration-contract'
import { AccelerationView } from './AccelerationView'

function state(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope: 'xm-account:1', phase: 'idle', mode: 'system-proxy', totalSeconds: accelerationTrialSeconds,
    remainingSeconds: accelerationTrialSeconds, sessionSeconds: 0, measuredAt: '2026-09-20T00:00:00Z',
    connectedAt: null, line: null, error: null, ...overrides,
  }
}

function render(current: AccelerationState | null) {
  return renderToStaticMarkup(<AccelerationView
    state={current} mode="system-proxy" busy={false} signedIn error={null}
    onModeChange={() => undefined} onStart={() => undefined} onStartAnyway={() => undefined}
    onStop={() => undefined} onRefresh={() => undefined} onLogin={() => undefined} onHelp={() => undefined}
    lines={[]} selectedLineId={null} linesBusy={false} linesError={null}
    onSelectLine={() => undefined} onPingLine={() => undefined} onRefreshLines={() => undefined}
  />)
}

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
