import type { GuideRoute, GuideStep } from './StartGuide'

export interface GuideProgress { route: GuideRoute; step: GuideStep }
export interface GuideProgressStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
const routes: readonly GuideRoute[] = ['claude', 'codex', 'codexDesktop', 'gemini', 'grok', 'chat']
const steps: readonly GuideStep[] = ['choose', 'prepare', 'connect', 'ready']

export function guideProgressKey(scope: string): string { return `xingmang-ui-v2:guide:${encodeURIComponent(scope)}` }
export function getGuideStorage(): GuideProgressStorage | null { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }

export function readGuideProgress(storage: GuideProgressStorage | null, scope: string | undefined, platform: 'win' | 'mac' | 'linux'): GuideProgress | null {
  if (!storage || !scope?.trim()) return null
  try {
    const raw = storage.getItem(guideProgressKey(scope))
    if (!raw || raw.length > 2048) return null
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const entry = value as Record<string, unknown>
    if (entry.version !== 1 || entry.owner !== scope || !routes.includes(entry.route as GuideRoute) || !steps.includes(entry.step as GuideStep) || (platform === 'linux' && entry.route === 'codexDesktop')) return null
    return { route: entry.route as GuideRoute, step: entry.step as GuideStep }
  } catch { return null }
}

export function writeGuideProgress(storage: GuideProgressStorage | null, scope: string | undefined, progress: GuideProgress): boolean {
  if (!scope?.trim()) return true
  if (!storage) return false
  try { storage.setItem(guideProgressKey(scope), JSON.stringify({ version: 1, owner: scope, ...progress })); return true } catch { return false }
}

export function clearGuideProgress(storage: GuideProgressStorage | null, scope: string | undefined): void {
  if (!storage || !scope?.trim()) return
  try { storage.removeItem(guideProgressKey(scope)) } catch { /* A completed guide may be replayed if local storage is unavailable. */ }
}
