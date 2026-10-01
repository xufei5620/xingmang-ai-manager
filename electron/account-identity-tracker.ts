import type { RealmAccountSiteId } from './realm-account-service'

/**
 * 「换了一个人」的判据：站点 + 用户 + 账号服务的会话代数。续期换凭据、付款后刷新余额
 * 只改登录态快照，不推进会话代数，所以拼出来的身份不变；换账号、退出、重新登录
 * （哪怕还是同一个人）都会推进代数。
 */
export function buildAccountIdentity(siteId: RealmAccountSiteId, userId: number | null | undefined, sessionRevision: number): string {
  return `${siteId}:${userId ?? 'guest'}:${sessionRevision}`
}

export interface AccountIdentityTracker {
  /** 身份和上一次不同才返回 true，并记下这一次。 */
  advance(identity: string): boolean
}

export function createAccountIdentityTracker(): AccountIdentityTracker {
  let published = ''
  return {
    advance(identity) {
      if (published === identity) return false
      published = identity
      return true
    },
  }
}
