import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseFeishuCredentialRequest, parseRemoteChannel, parseRemoteConversationChoice, parseRemoteEnabled, parseRemoteIdleClose, parseRemoteModel, parseRemotePermission, parseRemoteWorkspaceChoice } from './codex-remote'

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

  it('takes the phone model only as a model-like name, or null to follow the computer', () => {
    expect(parseRemoteModel('gpt-6.2')).toBe('gpt-6.2')
    expect(parseRemoteModel('gpt-6.1-mini')).toBe('gpt-6.1-mini')
    expect(parseRemoteModel(null)).toBeNull()
    for (const value of ['', 'gpt 6', '-c', '--model=x', 'gpt-6\n', '../gpt', 'x'.repeat(129), undefined, 6, ['gpt-6.2'], { model: 'gpt-6.2' }]) {
      expect(() => parseRemoteModel(value)).toThrow('手机端模型参数无效')
    }
  })

  it('never hands Codex a model with spaces, control characters or a leading dash, with random inputs', () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (value) => {
      let parsed: string | null
      try { parsed = parseRemoteModel(value) } catch { return }
      expect(parsed).toBe(value)
      expect(value.length).toBeGreaterThan(0)
      expect(value.length).toBeLessThanOrEqual(128)
      expect(value).not.toMatch(/[\s\0-\x1f\x7f]/)
      expect(value.startsWith('-')).toBe(false)
    }))
  })

  // 权限两档（yoyo 2026-11-22 同意的范围就到「默认」）：完全访问、Codex 自己的档位名一律不收。
  it('takes only the two permission levels and never full access', () => {
    expect(parseRemotePermission('default')).toBe('default')
    expect(parseRemotePermission('readOnly')).toBe('readOnly')
    for (const value of ['fullAccess', 'danger-full-access', 'workspace-write', 'read-only', 'never', 'on-request', '', null, undefined, 1, ['default'], { permission: 'default' }]) {
      expect(() => parseRemotePermission(value)).toThrow('手机遥控权限参数无效')
    }
  })

  it('never lets through anything but the two permission levels, with random inputs', () => {
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 40 }), fc.anything()), (value) => {
      let parsed: string
      try { parsed = parseRemotePermission(value) } catch { return }
      expect(['default', 'readOnly']).toContain(parsed)
    }))
  })

  // YF-19：只是一串字，主进程再拿去跟电脑上加过的单子比，不当路径用。
  it('takes a folder choice only as a short string', () => {
    expect(parseRemoteWorkspaceChoice('~/projects/demo')).toBe('~/projects/demo')
    for (const value of ['', 'a'.repeat(4097), 'x\0y', 42, null, undefined, ['~/a']]) {
      expect(() => parseRemoteWorkspaceChoice(value)).toThrow('文件夹参数无效')
    }
  })

  it('keeps only the two credential fields and caps their length', () => {
    expect(parseFeishuCredentialRequest({ appId: 'cli_x', appSecret: 's', extra: 1 })).toEqual({ appId: 'cli_x', appSecret: 's' })
    expect(() => parseFeishuCredentialRequest({ appId: 'cli_x' })).toThrow('飞书凭据')
    expect(() => parseFeishuCredentialRequest({ appId: 'a'.repeat(257), appSecret: 's' })).toThrow()
    expect(() => parseFeishuCredentialRequest({ appId: 'cli\0', appSecret: 's' })).toThrow()
    expect(() => parseFeishuCredentialRequest(null)).toThrow()
  })

  it('takes the phone conversation only as a Codex conversation id, or null for a new one', () => {
    expect(parseRemoteConversationChoice('01a20102-19e8-7b23-968d-694964b4899f')).toBe('01a20102-19e8-7b23-968d-694964b4899f')
    expect(parseRemoteConversationChoice(null)).toBeNull()
    for (const value of ['', 'th-1', '../01a20102-19e8-7b23-968d-694964b4899f', '/Users/a/projects/demo', '01a20102-19e8-7b23-968d-694964b4899f\n', undefined, 1, { id: 'x' }]) {
      expect(() => parseRemoteConversationChoice(value)).toThrow('手机端对话参数无效')
    }
  })

  it('never passes on anything but a conversation id or null, with random inputs', () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      let parsed: string | null | undefined
      try {
        parsed = parseRemoteConversationChoice(value)
      } catch {
        return true
      }
      return parsed === null || (typeof parsed === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed))
    }))
  })
})
