import type { AccountSessionState } from '../../electron/ipc-contract'
import type { RelayBackendCapabilities } from '../../electron/relay-backend'

export type AccountSiteId = 'solov' | 'solov-api'
type AccountContext = Pick<AccountSessionState, 'account'> & { siteId?: AccountSiteId; realmId?: string; capabilities?: RelayBackendCapabilities }

/** Old sessions without site metadata belong to the historical NewAPI realm. */
export function accountSiteId(session: Pick<AccountContext, 'siteId' | 'realmId'>): AccountSiteId {
  return session.siteId === 'solov-api' || session.realmId === 'api-account' ? 'solov-api' : 'solov'
}
const siteOrigins: Record<AccountSiteId, string> = {
  solov: 'https://xm.solov.cc',
  'solov-api': 'https://api.solov.cc',
}
export function accountOrigin(session: Pick<AccountContext, 'siteId' | 'realmId'>): string {
  return siteOrigins[accountSiteId(session)]
}
/** Saved-account records carry an origin instead of a site id. An unrecognised one maps to
 *  nothing rather than to the historical realm, so callers reject the record instead of
 *  silently treating it as a NewAPI account. */
export function siteIdForOrigin(origin: string): AccountSiteId | null {
  const match = (Object.keys(siteOrigins) as AccountSiteId[]).find((id) => siteOrigins[id] === origin)
  return match ?? null
}
export function accountScope(session: AccountContext): string {
  return scopeFor(accountSiteId(session), session.account?.userId ?? 'guest')
}
function scopeFor(siteId: AccountSiteId, userId: number | 'guest'): string {
  return `${siteId === 'solov-api' ? 'api-account' : 'xm-account'}:${userId}`
}
/**
 * 界面按哪个账号划分作用域。开机时账号恢复超过启动画面的等待上限，会话先是
 * 「未登录、正在恢复某个账号」：按正在恢复的那个账号算，恢复成功后作用域不变，
 * 首页和刚扫出来的工具状态都不用整页重来；恢复没成就照常落回访客。
 */
export function sessionScope(session: Pick<AccountSessionState, 'authenticated' | 'account' | 'restoring'> & AccountContext): string {
  const restoring = session.authenticated ? null : session.restoring?.account
  return restoring ? scopeFor(restoring.siteId, restoring.userId) : accountScope(session)
}
/** 开机账号恢复还没结束（启动画面已经先放行了）。 */
export function sessionRestoring(session: Pick<AccountSessionState, 'authenticated' | 'restoring'>): boolean {
  return !session.authenticated && session.restoring !== undefined
}
/** 开机恢复联不上而搁着：登录还在，主进程稍后自己重试（仍算在 sessionRestoring 里）。 */
export function sessionRestoreRetrying(session: Pick<AccountSessionState, 'authenticated' | 'restoring'>): boolean {
  return !session.authenticated && session.restoring?.retrying === true
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
