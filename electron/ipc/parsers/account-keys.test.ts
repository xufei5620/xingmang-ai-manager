import { describe, expect, it } from 'vitest'
import {
  parseAccountKeyCliConfigurationInput,
  parseAccountKeyCreateInput,
  parseAccountRevokeKeyId,
  parseManagedCliConfigurationInput,
} from './account-keys'

describe('parseAccountRevokeKeyId', () => {
  it('accepts a positive safe integer', () => {
    expect(parseAccountRevokeKeyId(42)).toBe(42)
  })

  it('rejects anything that could change the request path', () => {
    for (const id of ['42', '../42', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, null]) {
      expect(() => parseAccountRevokeKeyId(id)).toThrow('密钥 ID 格式错误')
    }
  })
})

describe('parseAccountKeyCliConfigurationInput', () => {
  it('accepts an active tool, a key id and a save mode', () => {
    expect(parseAccountKeyCliConfigurationInput({ provider: 'claude', keyId: 7, model: ' claude-opus ', mode: 'reset' }))
      .toEqual({ provider: 'claude', keyId: 7, model: 'claude-opus', mode: 'reset' })
  })

  it('rejects a retired tool, a string key id and an unknown mode', () => {
    expect(() => parseAccountKeyCliConfigurationInput({ provider: 'gemini', keyId: 7, model: 'm', mode: 'merge' })).toThrow('未知的 CLI 类型')
    expect(() => parseAccountKeyCliConfigurationInput({ provider: 'codex', keyId: '7', model: 'm', mode: 'merge' })).toThrow('密钥 ID 格式错误')
    expect(() => parseAccountKeyCliConfigurationInput({ provider: 'codex', keyId: 7, model: 'm', mode: 'replace' })).toThrow('未知的配置写入模式')
    expect(() => parseAccountKeyCliConfigurationInput(null)).toThrow('账号密钥配置信息格式错误')
  })
})

describe('parseAccountKeyCreateInput', () => {
  const valid = { name: 'yoyo-default', group: 'default', remainQuota: 0, unlimitedQuota: true, expiredTime: -1 }

  it('accepts the never-expires marker and rejects other non-positive expiry times', () => {
    expect(parseAccountKeyCreateInput(valid)).toEqual(valid)
    for (const expiredTime of [0, -2, 1.5, '1700000000']) {
      expect(() => parseAccountKeyCreateInput({ ...valid, expiredTime })).toThrow('过期时间格式错误')
    }
  })

  it('applies the xm site name limit unless the key is for the legacy account site', () => {
    const name = 'n'.repeat(51)
    expect(() => parseAccountKeyCreateInput({ ...valid, name })).toThrow('密钥名称格式错误')
    expect(parseAccountKeyCreateInput({ ...valid, name }, true).name).toBe(name)
  })

  it('allows a fractional quota only for the legacy account site, and never a zero limit there', () => {
    expect(() => parseAccountKeyCreateInput({ ...valid, unlimitedQuota: false, remainQuota: 1.5 })).toThrow('额度格式错误')
    expect(parseAccountKeyCreateInput({ ...valid, unlimitedQuota: false, remainQuota: 1.5 }, true).remainQuota).toBe(1.5)
    expect(() => parseAccountKeyCreateInput({ ...valid, unlimitedQuota: false, remainQuota: 0 }, true)).toThrow('额度格式错误')
  })
})

describe('parseManagedCliConfigurationInput', () => {
  it('skips a retired tool left in renderer state and keeps the rest', () => {
    expect(parseManagedCliConfigurationInput({ providers: ['codex'], preferredModels: { gemini: 'gemini-pro', codex: 'gpt-6-astra' } }))
      .toEqual({ providers: ['codex'], preferredModels: { codex: 'gpt-6-astra' } })
  })

  it('rejects keeping a key for a tool outside this configuration, and keeping keys on an explicit rewrite', () => {
    expect(() => parseManagedCliConfigurationInput({ providers: ['codex'], keepKeys: ['claude'] }))
      .toThrow('沿用现有密钥的工具不在这次的配置目标里')
    expect(() => parseManagedCliConfigurationInput({ providers: ['codex'], intent: 'explicit', keepKeys: ['codex'] }))
      .toThrow('CLI 配置意图无效')
  })

  it('rejects duplicate targets and an explicit rewrite of several tools at once', () => {
    expect(() => parseManagedCliConfigurationInput({ providers: ['codex', 'codex'] })).toThrow('CLI 配置目标不能重复')
    expect(() => parseManagedCliConfigurationInput({ providers: ['codex', 'claude'], intent: 'explicit' }))
      .toThrow('请逐个确认需要替换的工具配置')
  })
})
