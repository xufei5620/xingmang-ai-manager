import { describe, expect, it } from 'vitest'
import { parseWeixinLoginId, parseWeixinLoginPollInput } from './codex-remote-weixin'

const loginId = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('parseWeixinLoginId', () => {
  it('accepts only a uuid', () => {
    expect(parseWeixinLoginId(loginId)).toBe(loginId)
    for (const value of ['', '../x', `${loginId}/..`, 42, null]) {
      expect(() => parseWeixinLoginId(value)).toThrow('扫码编号格式错误')
    }
  })
})

describe('parseWeixinLoginPollInput', () => {
  it('passes the verify code through only as a short string', () => {
    expect(parseWeixinLoginPollInput({ loginId })).toEqual({ loginId })
    expect(parseWeixinLoginPollInput({ loginId, verifyCode: '1234', extra: 'ignored' })).toEqual({ loginId, verifyCode: '1234' })
    expect(() => parseWeixinLoginPollInput({ loginId, verifyCode: 1234 })).toThrow('手机上的数字格式错误')
    expect(() => parseWeixinLoginPollInput({ loginId, verifyCode: '1'.repeat(33) })).toThrow('手机上的数字格式错误')
    expect(() => parseWeixinLoginPollInput('nope')).toThrow('扫码查询格式错误')
  })
})
