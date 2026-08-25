// Local display of the ChatGPT identity stored in Codex auth.json.
//
// These JWTs are already on disk; we only decode the payload to show an
// email. Signature is not verified: this is not an auth decision, and the
// tokens themselves must never leave the main process (I3).

const MAX_JWT_CHARS = 16_384
const MAX_PAYLOAD_CHARS = 8_192
const MAX_EMAIL_CHARS = 254

function decodeJwtSegment(segment: string): string | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null
  const padded = segment + '='.repeat((4 - segment.length % 4) % 4)
  const bytes = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (bytes.length === 0) return null
  return bytes.toString('utf8')
}

export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length < 16 || token.length > MAX_JWT_CHARS) return null
  if (/[\r\n\0]/.test(token)) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const payload = decodeJwtSegment(parts[1])
  if (!payload || payload.length > MAX_PAYLOAD_CHARS) return null
  try {
    const parsed = JSON.parse(payload) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function sanitizeDisplayEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim()
  if (!email || email.length > MAX_EMAIL_CHARS) return null
  if (/[\r\n\0]/.test(email)) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

export function emailFromJwtClaims(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null
  const direct = sanitizeDisplayEmail(claims.email)
  if (direct) return direct
  const profile = claims['https://api.openai.com/profile']
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    return sanitizeDisplayEmail((profile as Record<string, unknown>).email)
  }
  return null
}

/** Prefer the OIDC id_token; fall back to the access_token profile claim. */
export function emailFromCodexAuthTokens(tokens: unknown): string | null {
  return identityFromCodexAuthTokens(tokens).email
}

export function officialChatGptPlanLabel(planType: string | null): string | null {
  if (!planType) return null
  switch (planType.trim().toLowerCase()) {
    case 'prolite':
      return 'Pro 5x'
    case 'pro':
      return 'Pro'
    case 'plus':
      return 'Plus'
    case 'free':
      return '免费'
    case 'go':
      return 'Go'
    case 'team':
      return 'Team'
    case 'business':
      return 'Business'
    case 'enterprise':
      return 'Enterprise'
    case 'edu':
    case 'education':
      return 'Edu'
    default:
      return planType.trim().slice(0, 32)
  }
}

function openaiAuthClaims(claims: Record<string, unknown> | null): Record<string, unknown> | null {
  const auth = claims?.['https://api.openai.com/auth']
  return auth && typeof auth === 'object' && !Array.isArray(auth)
    ? auth as Record<string, unknown>
    : null
}

function sanitizeIsoDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export interface OfficialChatGptIdentity {
  email: string | null
  planType: string | null
  planLabel: string | null
  renewsAt: string | null
}

export function identityFromCodexAuthTokens(tokens: unknown): OfficialChatGptIdentity {
  const empty: OfficialChatGptIdentity = { email: null, planType: null, planLabel: null, renewsAt: null }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return empty
  const record = tokens as Record<string, unknown>
  const idClaims = decodeJwtPayload(record.id_token)
  const accessClaims = decodeJwtPayload(record.access_token)
  const auth = openaiAuthClaims(idClaims) ?? openaiAuthClaims(accessClaims)
  const planType = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type.trim() : null
  return {
    email: emailFromJwtClaims(idClaims) ?? emailFromJwtClaims(accessClaims),
    planType,
    planLabel: officialChatGptPlanLabel(planType),
    renewsAt: sanitizeIsoDate(auth?.chatgpt_subscription_active_until),
  }
}
