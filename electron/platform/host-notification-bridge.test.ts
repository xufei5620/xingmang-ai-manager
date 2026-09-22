import { describe, expect, it, vi } from 'vitest'
import { createHostNotificationBridge } from './host-notification-bridge'

describe('host notification bridge', () => {
  it('reports unsupported until the notification service exists', () => {
    const bridge = createHostNotificationBridge()
    expect(
      bridge.notify({ event: 'accelerationExhausted', eventKey: 'xm-account:1:t0' }),
    ).toBe('unsupported')
  })

  // 日志那个桥会把主窗口出现之前的条目缓冲起来补发，这里刻意不这么做：一条晚
  // 到的「加速还剩 5 分钟」比不发更糟，用户看到它时时长早就用完了。
  it('never replays a reminder that was raised before anyone could show it', () => {
    const bridge = createHostNotificationBridge()
    bridge.notify({ event: 'accelerationExpiring', eventKey: 'xm-account:1:t0' })
    const sink = vi.fn(() => 'requested' as const)
    bridge.attach(sink)
    expect(sink).not.toHaveBeenCalled()
  })

  it('hands the request, event key and click action straight to the attached service', () => {
    const bridge = createHostNotificationBridge()
    const sink = vi.fn(() => 'requested' as const)
    const onClick = () => undefined
    bridge.attach(sink)
    expect(
      bridge.notify({ event: 'accelerationExpiring', eventKey: 'xm-account:1:t0', onClick }),
    ).toBe('requested')
    expect(sink).toHaveBeenCalledWith({
      event: 'accelerationExpiring',
      eventKey: 'xm-account:1:t0',
      onClick,
    })
  })

  it('keeps the newest service when an older one disposes after a window rebuild', () => {
    const bridge = createHostNotificationBridge()
    const previous = vi.fn(() => 'requested' as const)
    const next = vi.fn(() => 'requested' as const)
    bridge.attach(previous)
    bridge.attach(next)
    bridge.detach(previous)
    bridge.notify({ event: 'accelerationExhausted', eventKey: 'xm-account:1:t0' })
    expect(previous).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    bridge.detach(next)
    expect(
      bridge.notify({ event: 'accelerationExhausted', eventKey: 'xm-account:1:t1' }),
    ).toBe('unsupported')
  })
})
