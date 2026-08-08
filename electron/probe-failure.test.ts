import { describe, expect, it } from 'vitest'
import { describeProbeFailure } from './probe-failure'

describe('describeProbeFailure', () => {
  it('extracts the message from an Error', () => {
    expect(describeProbeFailure(new Error('注册表读取失败'))).toBe('注册表读取失败')
  })

  it('stringifies a non-Error rejection reason', () => {
    expect(describeProbeFailure('boom')).toBe('boom')
    expect(describeProbeFailure(42)).toBe('42')
  })
})
