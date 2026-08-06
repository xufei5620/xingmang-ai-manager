import type { ProviderId } from './types'

export interface ProviderExtensionRequestCoordinator {
  select(provider: ProviderId): void
  begin(provider: ProviderId): number
  isCurrent(provider: ProviderId, requestId: number): boolean
  accepts(provider: ProviderId, requestId: number, snapshotProvider: ProviderId): boolean
  invalidate(): void
}

export function createProviderExtensionRequestCoordinator(
  initialProvider: ProviderId = 'codex',
): ProviderExtensionRequestCoordinator {
  let activeProvider = initialProvider
  let sequence = 0
  return {
    select(provider) {
      activeProvider = provider
      sequence += 1
    },
    begin(provider) {
      if (provider !== activeProvider) return -1
      sequence += 1
      return sequence
    },
    isCurrent(provider, requestId) {
      return requestId > 0 && provider === activeProvider && requestId === sequence
    },
    accepts(provider, requestId, snapshotProvider) {
      return snapshotProvider === provider
        && requestId > 0
        && provider === activeProvider
        && requestId === sequence
    },
    invalidate() {
      sequence += 1
    },
  }
}
