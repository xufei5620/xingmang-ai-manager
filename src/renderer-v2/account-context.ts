import type { AccountSessionState } from '../../electron/ipc-contract'
import type { RelayBackendCapabilities } from '../../electron/relay-backend'

export type AccountSiteId = 'solov' | 'solov-api'
type AccountContext = Pick<AccountSessionState, 'account'> & { siteId?: AccountSiteId; realmId?: string; capabilities?: RelayBackendCapabilities }

/** Old sessions without site metadata belong to the historical NewAPI realm. */
export function accountSiteId(session: Pick<AccountContext, 'siteId' | 'realmId'>): AccountSiteId {
  return session.siteId === 'solov-api' || session.realmId === 'api-account' ? 'solov-api' : 'solov'
}
export function accountOrigin(session: Pick<AccountContext, 'siteId' | 'realmId'>): string {
  return accountSiteId(session) === 'solov-api' ? 'https://api.solov.cc' : 'https://xm.solov.cc'
}
export function accountScope(session: AccountContext): string {
  return `${accountSiteId(session) === 'solov-api' ? 'api-account' : 'xm-account'}:${session.account?.userId ?? 'guest'}`
}
export function accountSupports(session: Pick<AccountContext, 'siteId' | 'realmId' | 'capabilities'>, feature: keyof RelayBackendCapabilities): boolean {
  return session.capabilities?.[feature] ?? accountSiteId(session) === 'solov'
}
export function visibleAccountTab(value: string, session: Pick<AccountContext, 'siteId' | 'realmId' | 'capabilities'>): boolean {
  if (value === 'keys') return accountSupports(session, 'supportsKeyManagement')
  if (['usage', 'dashboard', 'tasks'].includes(value)) return accountSupports(session, 'supportsUsage')
  if (['orders', 'invite', 'recharge'].includes(value)) return accountSupports(session, 'supportsBilling')
  if (value === 'devices') return accountSupports(session, 'supportsSessionManagement')
  return value === 'overview'
}

export function accountKeyQuota(amount: number, quotaPerUnit: number, siteId: AccountSiteId, unlimited: boolean): number {
  if (unlimited) return 0
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error('请填写大于 0 的有效额度。')
  const quota = siteId === 'solov-api' ? amount : Math.round(amount * quotaPerUnit)
  if (!Number.isFinite(quota) || quota <= 0 || quota > Number.MAX_SAFE_INTEGER) throw new Error('额度超出可用范围。')
  return quota
}
