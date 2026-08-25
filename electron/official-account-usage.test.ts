import { describe, expect, it } from 'vitest'
import {
  fetchOfficialChatGptUsage,
  officialUsageAccessToken,
  parseOfficialChatGptUsage,
  remainingPercentFromUsed,
  windowLabelFromSeconds,
} from './official-account-usage'

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

const usageFixture = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 2,
      limit_window_seconds: 18_000,
      reset_at: 1_777_091_218,
    },
    secondary_window: {
      used_percent: 2,
      limit_window_seconds: 604_800,
      reset_at: 1_778_605_571,
    },
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_at: 1_778_103_354 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_at: 1_778_605_191 },
      },
    },
  ],
  rate_limit_reset_credits: { available_count: 0 },
}

describe('official ChatGPT usage from wham/usage', () => {
  it('maps remaining percent from used_percent', () => {
    expect(remainingPercentFromUsed(2)).toBe(98)
    expect(remainingPercentFromUsed(0)).toBe(100)
    expect(remainingPercentFromUsed(100)).toBe(0)
    expect(remainingPercentFromUsed('2')).toBe(98)
    expect(remainingPercentFromUsed(null)).toBeNull()
  })

  it('labels only from exact limit_window_seconds, never from reset remaining time', () => {
    expect(windowLabelFromSeconds(18_000)).toBe('5 小时限额')
    expect(windowLabelFromSeconds(604_800)).toBe('周限额')
    expect(windowLabelFromSeconds(13 * 3600)).toBe('13 小时限额')
    expect(windowLabelFromSeconds(null)).toBe('限额')
    expect(windowLabelFromSeconds(18_000, 'GPT-5.3-Codex-Spark')).toBe('GPT-5.3-Codex-Spark 5 小时限额')
    expect(windowLabelFromSeconds(604_800, 'GPT-5.3-Codex-Spark')).toBe('GPT-5.3-Codex-Spark 周限额')
  })

  it('parses primary, weekly, and Spark additional windows without leaking raw tokens', () => {
    const parsed = parseOfficialChatGptUsage(usageFixture, {
      planLabel: 'Pro 5x',
      renewsAt: '2026-09-22T11:32:00.000Z',
    })
    expect(parsed?.planLabel).toBe('Pro 5x')
    expect(parsed?.renewsAt).toBe('2026-09-22T11:32:00.000Z')
    expect(parsed?.resetCredits).toBe(0)
    expect(parsed?.windows.map((window) => window.label)).toEqual([
      '5 小时限额',
      '周限额',
      'GPT-5.3-Codex-Spark 5 小时限额',
      'GPT-5.3-Codex-Spark 周限额',
    ])
    expect(parsed?.windows[1]?.remainingPercent).toBe(98)
    expect(parsed?.windows[2]?.remainingPercent).toBe(100)
  })

  it('keeps a weekly primary labeled weekly even when reset remaining is 13 hours', () => {
    const parsed = parseOfficialChatGptUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 604_800,
          reset_after_seconds: 13 * 3600,
          reset_at: 1_777_091_218,
        },
        secondary_window: null,
      },
    })
    expect(parsed?.windows.map((window) => [window.label, window.remainingPercent])).toEqual([
      ['周限额', 0],
    ])
  })

  it('does not guess 5h/weekly when limit_window_seconds is missing', () => {
    const parsed = parseOfficialChatGptUsage({
      rate_limit: {
        primary_window: { used_percent: 40, reset_at: 1_777_091_218 },
        secondary_window: { used_percent: 10, reset_at: 1_778_605_571 },
      },
    })
    expect(parsed?.windows.map((window) => [window.label, window.remainingPercent])).toEqual([
      ['限额', 60],
      ['限额', 90],
    ])
  })

  it('sends the same usage GET that Quotio 刷新额度 uses and never follows a redirect', async () => {
    const access = jwtWithPayload({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const parsed = await fetchOfficialChatGptUsage({
      access_token: access,
      account_id: 'acct_example_id',
    }, {
      fallback: { planLabel: 'Pro 5x', renewsAt: '2026-09-22T11:32:00.000Z' },
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        expect(init?.redirect).toBe('manual')
        return new Response(JSON.stringify(usageFixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
          url: 'https://chatgpt.com/backend-api/wham/usage',
        } as ResponseInit)
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(calls[0]?.init?.method).toBe('GET')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${access}`)
    expect(headers.get('ChatGPT-Account-Id')).toBe('acct_example_id')
    expect(parsed?.windows).toHaveLength(4)
    expect(JSON.stringify(parsed)).not.toContain(access)
  })

  it('rejects a redirected usage response instead of following it with the bearer token', async () => {
    const access = jwtWithPayload({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const parsed = await fetchOfficialChatGptUsage({ access_token: access }, {
      fallback: { planLabel: 'Pro 5x' },
      fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }),
    })
    expect(parsed?.windows).toEqual([])
    expect(parsed?.planLabel).toBe('Pro 5x')
  })

  it('does not send an expired access token', () => {
    expect(officialUsageAccessToken({
      access_token: jwtWithPayload({ exp: Math.floor(Date.now() / 1000) + 10 }),
    })).toBeNull()
  })
})
