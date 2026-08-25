import { describe, expect, it } from 'vitest'
import {
  accountKeyStatusLabel,
  accountUsageTypeLabel,
  buildAccountInviteLink,
  formatAccountUsageDate,
  formatKeyQuotaUsd,
  formatUsageCostUsd,
  parseInviteAffCode,
  validateInviteCode,
} from './account-center'

describe('buildAccountInviteLink', () => {
  it('builds a dl.solov.cc sign-up link carrying the affCode as the aff query parameter', () => {
    expect(buildAccountInviteLink('ABC123')).toBe('https://dl.solov.cc/sign-up?aff=ABC123')
  })

  it('percent-encodes an affCode containing URL-unsafe characters', () => {
    expect(buildAccountInviteLink('a b&c')).toBe('https://dl.solov.cc/sign-up?aff=a%20b%26c')
  })
})

describe('parseInviteAffCode', () => {
  it('returns an empty string for a blank value', () => {
    expect(parseInviteAffCode('')).toBe('')
    expect(parseInviteAffCode('   ')).toBe('')
  })

  it('keeps a bare aff code', () => {
    expect(parseInviteAffCode('  6B4j  ')).toBe('6B4j')
  })

  it('extracts aff from the official sign-up and register invite URLs', () => {
    expect(parseInviteAffCode('https://dl.solov.cc/sign-up?aff=6B4j')).toBe('6B4j')
    expect(parseInviteAffCode('https://xm.solov.cc/sign-up?aff=6B4j')).toBe('6B4j')
    expect(parseInviteAffCode('https://xm.solov.cc/register?aff=ABC123')).toBe('ABC123')
  })

  it('extracts aff from a query-only paste', () => {
    expect(parseInviteAffCode('aff=6B4j')).toBe('6B4j')
  })
})

describe('validateInviteCode', () => {
  it('treats a blank invite as optional', () => {
    expect(validateInviteCode('')).toBeNull()
    expect(validateInviteCode('   ')).toBeNull()
  })

  it('accepts a bare code or a complete invite URL', () => {
    expect(validateInviteCode('6B4j')).toBeNull()
    expect(validateInviteCode('https://dl.solov.cc/sign-up?aff=6B4j')).toBeNull()
    expect(validateInviteCode('https://xm.solov.cc/sign-up?aff=6B4j')).toBeNull()
  })

  it('rejects a link that does not carry an aff parameter', () => {
    expect(validateInviteCode('https://xm.solov.cc/sign-up')).toBe('请粘贴完整邀请链接，或只填邀请码')
  })

  it('rejects an over-long code', () => {
    expect(validateInviteCode('a'.repeat(33))).toBe('邀请码不能超过 32 位')
  })
})

describe('accountUsageTypeLabel', () => {
  it('maps every known model.Log Type constant to its Chinese label', () => {
    expect(accountUsageTypeLabel(0)).toBe('未知')
    expect(accountUsageTypeLabel(1)).toBe('充值')
    expect(accountUsageTypeLabel(2)).toBe('消费')
    expect(accountUsageTypeLabel(3)).toBe('管理')
    expect(accountUsageTypeLabel(4)).toBe('系统')
    expect(accountUsageTypeLabel(5)).toBe('错误')
    expect(accountUsageTypeLabel(6)).toBe('退款')
    expect(accountUsageTypeLabel(7)).toBe('登录')
  })

  it('falls back to a labeled-unknown string for a type outside the known range', () => {
    expect(accountUsageTypeLabel(99)).toBe('未知类型(99)')
  })
})

describe('formatAccountUsageDate', () => {
  it('formats a valid ISO timestamp in zh-CN date/time style', () => {
    const formatted = formatAccountUsageDate('2026-08-10T03:04:00.000Z')
    expect(formatted).toMatch(/2026/)
    expect(formatted).not.toBe('时间未知')
  })

  it('falls back to a placeholder for an empty or unparseable value', () => {
    expect(formatAccountUsageDate('')).toBe('时间未知')
    expect(formatAccountUsageDate('not-a-date')).toBe('时间未知')
  })
})

describe('formatUsageCostUsd', () => {
  it('uses 2 decimals once the amount reaches a full cent', () => {
    expect(formatUsageCostUsd(25_000, 500_000)).toBe('$0.05')
    expect(formatUsageCostUsd(5_000, 500_000)).toBe('$0.01') // exactly at the $0.01 boundary
  })

  it('keeps the same 2-decimal rounding as formatBalanceUsd for larger amounts', () => {
    expect(formatUsageCostUsd(2_500_000, 500_000)).toBe('$5.00')
    expect(formatUsageCostUsd(1_234_567, 500_000)).toBe('$2.47')
  })

  it('switches to trimmed higher precision for a sub-cent amount instead of collapsing to $0.00', () => {
    expect(formatUsageCostUsd(1_150, 500_000)).toBe('$0.0023')
    expect(formatUsageCostUsd(500, 500_000)).toBe('$0.001')
    expect(formatUsageCostUsd(1, 500_000)).toBe('$0.000002')
  })

  it('shows $0.00 for a genuinely zero-cost record', () => {
    expect(formatUsageCostUsd(0, 500_000)).toBe('$0.00')
  })

  it('falls back to the placeholder instead of a misleading $0.00 when quotaPerUnit is unusable', () => {
    expect(formatUsageCostUsd(1_000, 0)).toBe('—')
    expect(formatUsageCostUsd(1_000, Number.NaN)).toBe('—')
    expect(formatUsageCostUsd(1_000, -500_000)).toBe('—')
    expect(formatUsageCostUsd(1_000, undefined)).toBe('—')
  })
})

describe('accountKeyStatusLabel', () => {
  it('maps every known model.Token Status constant to its Chinese label', () => {
    expect(accountKeyStatusLabel(1)).toBe('启用中')
    expect(accountKeyStatusLabel(2)).toBe('已禁用')
    expect(accountKeyStatusLabel(3)).toBe('已过期')
    expect(accountKeyStatusLabel(4)).toBe('额度已用尽')
  })

  it('falls back to a labeled-unknown string for a status outside the known range', () => {
    expect(accountKeyStatusLabel(0)).toBe('未知状态(0)')
    expect(accountKeyStatusLabel(99)).toBe('未知状态(99)')
  })
})

describe('formatKeyQuotaUsd', () => {
  it('formats using the same 2-decimal convention as formatBalanceUsd', () => {
    expect(formatKeyQuotaUsd(2_500_000, 500_000)).toBe('$5.00')
    expect(formatKeyQuotaUsd(0, 500_000)).toBe('$0.00')
  })

  it('falls back to the placeholder instead of a misleading $0.00 when quotaPerUnit is unusable', () => {
    expect(formatKeyQuotaUsd(1_000, 0)).toBe('—')
    expect(formatKeyQuotaUsd(1_000, Number.NaN)).toBe('—')
    expect(formatKeyQuotaUsd(1_000, -500_000)).toBe('—')
    expect(formatKeyQuotaUsd(1_000, undefined)).toBe('—')
  })
})
