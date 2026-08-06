import type { AppSettingsV2, UpdateSnapshot } from './types'

export function shouldCheckUpdatesOnStartup(
  settings: Pick<AppSettingsV2, 'checkUpdatesOnStartup'> | null,
): boolean {
  return settings?.checkUpdatesOnStartup !== false
}

export function shouldBlockStartupForUpdate(
  state: Pick<UpdateSnapshot, 'development' | 'phase' | 'error'>,
): boolean {
  if (state.development || state.error) return false
  return state.phase === 'downloading' || state.phase === 'downloaded'
}
