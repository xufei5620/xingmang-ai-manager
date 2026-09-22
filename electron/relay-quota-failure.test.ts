import { describe, expect, it } from 'vitest'
import {
  classifyRelayQuotaFailure,
  extractRelayErrorDetail,
  matchRelayQuotaFailureMessage,
  relayQuotaFailureMessages,
} from './relay-quota-failure'

describe('relay quota failure classification', () => {
  it.each([
    [403, '用户额度不足, 剩余额度: ＄0.000000 (request id: 1) insufficient_user_quota new_api_error', 'balance'],
    [403, '预扣费额度失败, 用户剩余额度: ＄0.010000, 需要预扣费额度: ＄0.050000', 'balance'],
    [403, '订阅额度不足或未配置订阅: no active subscription', 'balance'],
    [403, 'Insufficient account balance INSUFFICIENT_BALANCE', 'balance'],
    [402, 'payment required', 'balance'],
    [403, 'token quota is not enough, token remain quota: ＄0.001000, need quota: ＄0.050000', 'keyLimit'],
    [401, '该令牌额度已用尽 TokenStatusExhausted[sk-abc***xyz]', 'keyLimit'],
    [429, 'API key 额度已用完 insufficient_quota insufficient_quota', 'keyLimit'],
    [401, '无效的令牌 (request id: 2) new_api_error', 'keyInvalid'],
    [401, '', 'keyInvalid'],
    [403, 'API key 已过期 API_KEY_EXPIRED', 'keyInvalid'],
  ] as const)('classifies HTTP %s "%s" as %s', (status, detail, expected) => {
    expect(classifyRelayQuotaFailure(status, detail)).toBe(expected)
  })

  it('leaves upstream channel quota, group denial and server errors to other rules', () => {
    // 上游渠道欠费被中转原样转回来时也叫 insufficient_quota，那不是用户的余额。
    expect(classifyRelayQuotaFailure(429, 'You exceeded your current quota insufficient_quota')).toBeNull()
    expect(classifyRelayQuotaFailure(403, '无权访问 vip 分组')).toBeNull()
    expect(classifyRelayQuotaFailure(503, '用户额度不足')).toBeNull()
    expect(classifyRelayQuotaFailure(200, '用户额度不足')).toBeNull()
  })

  it('reads message and code from the OpenAI, Anthropic and Sub2API envelopes', () => {
    expect(extractRelayErrorDetail({ error: { message: '用户额度不足', type: 'new_api_error', code: 'insufficient_user_quota' } }))
      .toBe('用户额度不足 insufficient_user_quota new_api_error')
    expect(extractRelayErrorDetail({ type: 'error', error: { type: 'new_api_error', message: '无效的令牌' } }))
      .toBe('无效的令牌 new_api_error')
    expect(extractRelayErrorDetail({ code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' }))
      .toBe('Insufficient account balance INSUFFICIENT_BALANCE')
    expect(extractRelayErrorDetail({ error: 'bad key' })).toBe('bad key')
    expect(extractRelayErrorDetail(['x'])).toBe('')
    expect(extractRelayErrorDetail(null)).toBe('')
  })

  it('recognises its own sentences even inside an IPC rejection wrapper', () => {
    expect(matchRelayQuotaFailureMessage(relayQuotaFailureMessages.balance)).toBe('balance')
    expect(matchRelayQuotaFailureMessage(`Error invoking remote method 'ai-image:generate': Error: ${relayQuotaFailureMessages.keyLimit}`)).toBe('keyLimit')
    expect(matchRelayQuotaFailureMessage('账号余额或 API Key 额度不足，请充值后重试')).toBeNull()
  })

  it('never names a site and always says what to do next', () => {
    for (const message of Object.values(relayQuotaFailureMessages)) {
      expect(message).not.toMatch(/星芒|solov|Sub2API|new-api/i)
      expect(message).toMatch(/充值|调高|重试/)
    }
  })
})
