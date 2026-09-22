import { describe, expect, it } from 'vitest'
import { networkFailureMessages } from '../../../../electron/network-failure'
import {
  bootstrapBlockedByNetwork,
  idleOnlineResync,
  isNetworkFailureText,
  networkBlockedFailures,
  noteBootstrapOutcome,
  planOnlineResync,
} from './online-resync'

const offline = networkFailureMessages.offline
const dns = networkFailureMessages.dns
const scope = 'https://example.invalid#7'

describe('isNetworkFailureText', () => {
  it('recognises the Chinese sentence the main process already wrote', () => {
    expect(isNetworkFailureText(`CLI Key 初始化失败：${offline}`)).toBe(true)
  })

  it('recognises raw chromium and node spellings', () => {
    expect(isNetworkFailureText('request failed: ERR_NAME_NOT_RESOLVED')).toBe(true)
    expect(isNetworkFailureText('connect ECONNREFUSED 127.0.0.1:443')).toBe(true)
  })

  it('does not claim an authentication failure is a network problem', () => {
    expect(isNetworkFailureText('当前账号的密钥已失效（401）')).toBe(false)
    expect(isNetworkFailureText('')).toBe(false)
    expect(isNetworkFailureText(undefined)).toBe(false)
  })
})

describe('networkBlockedFailures', () => {
  it('is true only when every failure signal is a network one', () => {
    expect(networkBlockedFailures([offline, dns])).toBe(true)
    expect(networkBlockedFailures([offline, '当前分组未返回可用模型'])).toBe(false)
  })

  it('is false without any failure signal', () => {
    expect(networkBlockedFailures([])).toBe(false)
    expect(networkBlockedFailures(['   '])).toBe(false)
  })
})

describe('bootstrapBlockedByNetwork', () => {
  it('classifies a thrown bootstrap by its message', () => {
    expect(bootstrapBlockedByNetwork({ error: `账号 Key 初始化没有完成：${dns}` })).toBe(true)
    expect(bootstrapBlockedByNetwork({ error: '星芒账号已变化，已停止本次 Key 配置' })).toBe(false)
  })

  it('reads the verdict off a returned result', () => {
    expect(bootstrapBlockedByNetwork({ result: { networkBlocked: true } })).toBe(true)
    expect(bootstrapBlockedByNetwork({ result: { networkBlocked: false } })).toBe(false)
    expect(bootstrapBlockedByNetwork(undefined)).toBe(false)
  })

  it('prefers the thrown message over a result when both are present', () => {
    expect(bootstrapBlockedByNetwork({ error: 'CLI 配置失败', result: { networkBlocked: true } })).toBe(false)
  })
})

describe('online resync state', () => {
  it('arms a resync after a network-blocked bootstrap and runs it once when the network returns', () => {
    const armed = noteBootstrapOutcome(idleOnlineResync(), scope, { result: { networkBlocked: true } })
    expect(armed).toEqual({ scope, running: false })
    const plan = planOnlineResync(armed, scope)
    expect(plan.scope).toBe(scope)
    expect(plan.state.running).toBe(true)
  })

  it('does not arm a resync after an authentication failure', () => {
    const state = noteBootstrapOutcome(idleOnlineResync(), scope, {
      result: { networkBlocked: false },
    })
    expect(state).toEqual(idleOnlineResync())
    expect(planOnlineResync(state, scope).scope).toBeNull()
  })

  it('does not queue a second resync while one is still running', () => {
    const armed = noteBootstrapOutcome(idleOnlineResync(), scope, { error: offline })
    const first = planOnlineResync(armed, scope)
    const second = planOnlineResync(first.state, scope)
    expect(first.scope).toBe(scope)
    expect(second.scope).toBeNull()
    expect(second.state).toEqual(first.state)
  })

  it('clears the pending resync once the retry succeeds', () => {
    const armed = noteBootstrapOutcome(idleOnlineResync(), scope, { error: offline })
    const running = planOnlineResync(armed, scope).state
    const settled = noteBootstrapOutcome(running, scope, { result: { networkBlocked: false } })
    expect(settled).toEqual(idleOnlineResync())
    expect(planOnlineResync(settled, scope).scope).toBeNull()
  })

  it('re-arms when the retry is still blocked by the network, so the next reconnect tries again', () => {
    const armed = noteBootstrapOutcome(idleOnlineResync(), scope, { error: offline })
    const running = planOnlineResync(armed, scope).state
    const again = noteBootstrapOutcome(running, scope, { result: { networkBlocked: true } })
    expect(again).toEqual({ scope, running: false })
    expect(planOnlineResync(again, scope).scope).toBe(scope)
  })

  it('never resyncs an account other than the one that failed', () => {
    const armed = noteBootstrapOutcome(idleOnlineResync(), scope, { error: offline })
    expect(planOnlineResync(armed, 'https://example.invalid#8').scope).toBeNull()
    expect(noteBootstrapOutcome(armed, 'https://example.invalid#8', { result: { networkBlocked: false } })).toEqual(armed)
  })
})
