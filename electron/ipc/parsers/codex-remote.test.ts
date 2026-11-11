import { describe, expect, it } from 'vitest'
import { parseFeishuCredentialRequest, parseRemoteChannel, parseRemoteEnabled, parseRemoteIdleClose } from './codex-remote'

describe('codex-remote parsers', () => {
  it('accepts only known channels and real booleans', () => {
    expect(parseRemoteChannel('feishu')).toBe('feishu')
    expect(() => parseRemoteChannel('telegram')).toThrow('遥控渠道')
    expect(() => parseRemoteChannel('../feishu')).toThrow()
    expect(parseRemoteEnabled(false)).toBe(false)
    expect(() => parseRemoteEnabled('true')).toThrow('遥控开关')
  })

  it('accepts only the offered idle-close hours or null for never', () => {
    expect(parseRemoteIdleClose(4)).toBe(4)
    expect(parseRemoteIdleClose(12)).toBe(12)
    expect(parseRemoteIdleClose(null)).toBeNull()
    for (const value of [0, 1, 24, '4', undefined, Number.NaN, 4.5]) {
      expect(() => parseRemoteIdleClose(value)).toThrow('遥控自动关时长')
    }
  })

  it('keeps only the two credential fields and caps their length', () => {
    expect(parseFeishuCredentialRequest({ appId: 'cli_x', appSecret: 's', extra: 1 })).toEqual({ appId: 'cli_x', appSecret: 's' })
    expect(() => parseFeishuCredentialRequest({ appId: 'cli_x' })).toThrow('飞书凭据')
    expect(() => parseFeishuCredentialRequest({ appId: 'a'.repeat(257), appSecret: 's' })).toThrow()
    expect(() => parseFeishuCredentialRequest({ appId: 'cli\0', appSecret: 's' })).toThrow()
    expect(() => parseFeishuCredentialRequest(null)).toThrow()
  })
})
