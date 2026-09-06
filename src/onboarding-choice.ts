import type { ProviderId } from './types'

export type StartRoute = ProviderId | 'codexDesktop' | 'chat'
const routes = new Set<StartRoute>(['codexDesktop', 'codex', 'claude', 'gemini', 'grok', 'chat'])

function preferenceKey(siteId: string, userId: number): string {
  return `xingmang-start-choice-v1:${encodeURIComponent(siteId)}:${userId}`
}

export function readStartChoice(
  storage: Pick<Storage, 'getItem'>,
  siteId: string,
  userId: number,
): StartRoute | null {
  if (!Number.isSafeInteger(userId) || userId < 1) return null
  try {
    const value = storage.getItem(preferenceKey(siteId, userId))
    return value && routes.has(value as StartRoute) ? value as StartRoute : null
  } catch { return null }
}

export function rememberStartChoice(
  storage: Pick<Storage, 'setItem'>,
  siteId: string,
  userId: number,
  route: StartRoute,
): boolean {
  if (!Number.isSafeInteger(userId) || userId < 1 || !routes.has(route)) return false
  try {
    storage.setItem(preferenceKey(siteId, userId), route)
    return true
  } catch { return false }
}
