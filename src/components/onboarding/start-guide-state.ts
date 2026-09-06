import { officialAccountLabel, officialCodexSignedIn, providerConfigReadiness } from '../../account-source'
import { isDetectionFailed } from '../../app-shared'
import { nodeRuntimeSupported } from '../../onboarding-runtime'
import { managementProviderIds } from '../../provider-registry'
import type { AppConfigSummary, PlatformCapabilities, ProviderId, SystemSnapshot } from '../../types'

export type GuideRoute = 'codexDesktop' | ProviderId | 'chat'
export type GuideStep = 'choose' | 'prepare' | 'connect' | 'ready'
export type GuideConnection = 'chat' | 'unread' | 'missing' | 'relay' | 'official' | 'official-login-required' | 'unknown'

export interface GuideReadiness {
  supported: boolean
  runtimeRequired: boolean
  runtimeReady: boolean
  runtimeFailed: boolean
  toolInstalled: boolean
  toolDetectionFailed: boolean
  prepared: boolean
  connection: GuideConnection
  connected: boolean
}

export function availableGuideRoutes(platform: PlatformCapabilities): GuideRoute[] {
  const routes: GuideRoute[] = [...managementProviderIds]
  if (platform.codexDesktop.launch) routes.splice(1, 0, 'codexDesktop')
  return [...routes, 'chat']
}

export function guideProvider(route: Exclude<GuideRoute, 'chat'>): ProviderId {
  return route === 'codexDesktop' ? 'codex' : route
}

export function guideReadiness(route: GuideRoute, platform: PlatformCapabilities, snapshot: SystemSnapshot, config: AppConfigSummary | null): GuideReadiness {
  if (route === 'chat') return { supported: true, runtimeRequired: false, runtimeReady: true, runtimeFailed: false, toolInstalled: true, toolDetectionFailed: false, prepared: true, connection: 'chat', connected: true }

  const desktop = route === 'codexDesktop'
  const provider = guideProvider(route)
  const status = desktop ? snapshot.desktopApps.codex : snapshot.clis[route]
  const supported = !desktop || platform.codexDesktop.launch
  const runtimeRequired = !desktop
  const runtimeFailed = runtimeRequired && (isDetectionFailed(snapshot.runtime.node) || isDetectionFailed(snapshot.runtime.npm))
  const runtimeReady = !runtimeRequired || (!runtimeFailed && nodeRuntimeSupported(snapshot.runtime) && snapshot.runtime.npm.installed)
  // A known desktop installation can still be used when only version probing failed.
  const toolDetectionFailed = isDetectionFailed(status) && !(desktop && status.installed)
  const prepared = supported && runtimeReady && status.installed && !toolDetectionFailed
  const summary = config?.providers[provider]
  const readiness = providerConfigReadiness(summary)
  const connection: GuideConnection = !config ? 'unread'
    : readiness === 'missing' ? 'missing'
      : readiness === 'relay' ? 'relay'
        : readiness === 'unknown' ? 'unknown'
          : !officialAccountLabel(provider) ? 'missing'
            : provider === 'codex' && !officialCodexSignedIn(summary) ? 'official-login-required'
              : 'official'
  return { supported, runtimeRequired, runtimeReady, runtimeFailed, toolInstalled: status.installed, toolDetectionFailed, prepared, connection, connected: connection === 'relay' || connection === 'official' }
}

export function guideNextStep(step: GuideStep, route: GuideRoute | null, readiness: GuideReadiness | null): GuideStep {
  if (!route || !readiness || !readiness.supported) return step
  if (step === 'choose') return route === 'chat' ? 'ready' : 'prepare'
  if (step === 'prepare' && readiness.prepared) return 'connect'
  if (step === 'connect' && readiness.prepared && readiness.connected) return 'ready'
  return step
}
