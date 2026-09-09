import { accountRealms, requireAccountRealm, RealmAccountError, type AccountRealmId } from './realm-account'

export const realmFeatures = ['registration', 'sessionRestore', 'balance', 'keyRead', 'keyWrite', 'usage',
  'billing', 'subscriptions', 'sessionManagement', 'autoKey', 'chat', 'image', 'video', 'canvas', 'cli',
  'notice', 'legal', 'support', 'invitation'] as const
export type RealmFeature = typeof realmFeatures[number]
export interface RealmCapability {
  readonly available: boolean
  readonly reason: 'available' | 'site-disabled' | 'registration-xm-only' | 'unverified' | 'sign-in-required'
}
export interface RealmCapabilitySnapshot {
  readonly realmId: AccountRealmId
  readonly siteId: string
  readonly features: Readonly<Record<RealmFeature, RealmCapability>>
}

/** Features are enabled only by main-process deployment verification, never by a backend's advertisement alone. */
export function buildRealmCapabilities(input: {
  realmId: AccountRealmId
  enabled: boolean
  authenticated: boolean
  verified: readonly RealmFeature[]
}): RealmCapabilitySnapshot {
  const realmId = requireAccountRealm(input.realmId)
  const verified = new Set(input.verified)
  if ([...verified].some((feature) => !realmFeatures.includes(feature))) throw new RealmAccountError('INVALID')
  const anonymous = new Set<RealmFeature>(['registration', 'sessionRestore', 'notice', 'legal', 'support'])
  const features = Object.fromEntries(realmFeatures.map((feature) => {
    const reason: RealmCapability['reason'] = !input.enabled ? 'site-disabled'
      : feature === 'registration' && realmId !== 'xm-account' ? 'registration-xm-only'
      : !verified.has(feature) ? 'unverified'
      : !input.authenticated && !anonymous.has(feature) ? 'sign-in-required' : 'available'
    return [feature, Object.freeze({ available: reason === 'available', reason })]
  })) as Record<RealmFeature, RealmCapability>
  return Object.freeze({ realmId, siteId: accountRealms[realmId].siteId, features: Object.freeze(features) })
}

export function assertRealmCapability(snapshot: RealmCapabilitySnapshot, feature: RealmFeature): void {
  if (!realmFeatures.includes(feature) || snapshot.features[feature]?.available !== true) throw new RealmAccountError('UNSUPPORTED')
}

/** Credential-free UI projection. It does not authorize IPC operations. */
export function realmAccountView(snapshot: RealmCapabilitySnapshot): {
  registrationSiteId: 'solov'
  canRegisterHere: boolean
  sections: readonly string[]
} {
  const sectionFeatures = { balance: 'balance', keys: 'keyRead', usage: 'usage', billing: 'billing',
    subscriptions: 'subscriptions', sessions: 'sessionManagement', support: 'support', legal: 'legal', invitation: 'invitation' } as const
  return Object.freeze({ registrationSiteId: 'solov',
    canRegisterHere: snapshot.realmId === 'xm-account' && snapshot.features.registration.available,
    sections: Object.freeze(Object.entries(sectionFeatures).filter(([, feature]) => snapshot.features[feature].available).map(([section]) => section)) })
}
