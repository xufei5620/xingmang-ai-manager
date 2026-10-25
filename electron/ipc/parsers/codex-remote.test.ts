import { describe, expect, it } from 'vitest'
import { parseFeishuCredentialRequest, parseRemoteChannel, parseRemoteEnabled } from './codex-remote'

describe('codex-remote parsers', () => {
  it('accepts only known channels and real booleans', () => {
    expect(parseRemoteChannel('feishu')).toBe('feishu')
    expect(() => parseRemoteChannel('telegram')).toThrow('遥控渠道')
    expect(() => parseRemoteChannel('../feishu')).toThrow()
    expect(parseRemoteEnabled(false)).toBe(false)
    expect(() => parseRemoteEnabled('true')).toThrow('遥控开关')
  })

  it('keeps only the two credential fields and caps their length', () => {
    expect(parseFeishuCredentialRequest({ appId: 'cli_x', appSecret: 's', extra: 1 })).toEqual({ appId: 'cli_x', appSecret: 's' })
    expect(() => parseFeishuCredentialRequest({ appId: 'cli_x' })).toThrow('飞书凭据')
    expect(() => parseFeishuCredentialRequest({ appId: 'a'.repeat(257), appSecret: 's' })).toThrow()
    expect(() => parseFeishuCredentialRequest({ appId: 'cli\0', appSecret: 's' })).toThrow()
    expect(() => parseFeishuCredentialRequest(null)).toThrow()
  })
})
