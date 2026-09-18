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
  if (value === 'usage') return accountSupports(session, 'supportsUsage')
  if (value === 'dashboard') return accountSupports(session, 'supportsDashboard')
  if (value === 'tasks') return accountSupports(session, 'supportsTasks')
  if (['orders', 'invite', 'recharge'].includes(value)) return accountSupports(session, 'supportsBilling')
  if (value === 'devices') return accountSupports(session, 'supportsSessionManagement')
  return value === 'overview'
}

// 金额与后端额度单位的换算对主进程和渲染层是同一件事,只在主进程定义一次。
export { accountKeyQuota } from '../../electron/account-key-quota'
