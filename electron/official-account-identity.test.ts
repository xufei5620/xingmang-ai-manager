import { describe, expect, it } from 'vitest'
import {
  decodeJwtPayload,
  emailFromCodexAuthTokens,
  emailFromJwtClaims,
  identityFromCodexAuthTokens,
  officialChatGptPlanLabel,
  sanitizeDisplayEmail,
} from './official-account-identity'

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

describe('official ChatGPT identity from Codex JWTs', () => {
  it('reads email from the id_token payload', () => {
    const token = jwtWithPayload({ email: 'ivy@example.com', email_verified: true })
    expect(emailFromJwtClaims(decodeJwtPayload(token))).toBe('ivy@example.com')
  })

  it('falls back to the access_token OpenAI profile claim when id_token has no email', () => {
    const access = jwtWithPayload({
      'https://api.openai.com/profile': { email: 'profile@example.com', name: 'Ivy' },
    })
    expect(emailFromCodexAuthTokens({
      id_token: jwtWithPayload({ sub: 'auth0|user' }),
      access_token: access,
    })).toBe('profile@example.com')
  })

  it('prefers the id_token email over the access_token profile', () => {
    expect(emailFromCodexAuthTokens({
      id_token: jwtWithPayload({ email: 'id@example.com' }),
      access_token: jwtWithPayload({
        'https://api.openai.com/profile': { email: 'access@example.com' },
      }),
    })).toBe('id@example.com')
  })

  it('rejects non-JWT strings and oversized tokens instead of throwing', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('a.b')).toBeNull()
    expect(decodeJwtPayload(`${'a'.repeat(20_000)}.${'b'.repeat(20)}.sig`)).toBeNull()
    expect(emailFromCodexAuthTokens({ id_token: 'access-token-value' })).toBeNull()
  })

  it('rejects values that are not a single display email', () => {
    expect(sanitizeDisplayEmail('not-an-email')).toBeNull()
    expect(sanitizeDisplayEmail('a\nb@example.com')).toBeNull()
    expect(sanitizeDisplayEmail(`${'a'.repeat(250)}@example.com`)).toBeNull()
    expect(sanitizeDisplayEmail(' ivy@example.com ')).toBe('ivy@example.com')
  })

  it('maps prolite to Pro 5x and reads the subscription renews-at claim', () => {
    expect(officialChatGptPlanLabel('prolite')).toBe('Pro 5x')
    const identity = identityFromCodexAuthTokens({
      id_token: jwtWithPayload({
        email: 'ivy@example.com',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'prolite',
          chatgpt_subscription_active_until: '2026-09-22T11:32:00.000Z',
        },
      }),
    })
    expect(identity.planLabel).toBe('Pro 5x')
    expect(identity.renewsAt).toBe('2026-09-22T11:32:00.000Z')
  })
})
