import type { NewApiTopupOrderStatus } from './new-api-client'
import type { RelayBackendClient } from './relay-backend'
import { RealmAccountError, realmForExplicitSite } from './realm-account'
import type { RealmAccountSiteId } from './realm-account-service'

export type PaymentOrderStatusReader = () => Promise<NewApiTopupOrderStatus>

export interface PaymentOrderStatusReaderOptions {
  client: RelayBackendClient
  getSiteId(): RealmAccountSiteId
  assertReady(): void
}

/** Bind the order to its authenticated owner before any asynchronous work.
 * Account revisions also reject logging out and back into the same account. */
export function createPaymentOrderStatusReader(
  options: PaymentOrderStatusReaderOptions,
  tradeNo: string,
): PaymentOrderStatusReader | undefined {
  options.assertReady()
  const { client } = options
  const session = client.getSessionState()
  const revision = client.getSessionRevision?.()
  if (!tradeNo || !session.authenticated || !session.account || revision === undefined) return undefined
  const userId = session.account.userId
  const siteId = options.getSiteId()
  const realmId = realmForExplicitSite(siteId)
  let stale = false

  function assertOwner(): void {
    try {
      options.assertReady()
      const current = client.getSessionState()
      if (stale || !current.authenticated || current.account?.userId !== userId
        || options.getSiteId() !== siteId || realmForExplicitSite(options.getSiteId()) !== realmId
        || client.getSessionRevision?.() !== revision) throw new RealmAccountError('STALE')
    } catch {
      stale = true
      throw new RealmAccountError('STALE')
    }
  }

  return async () => {
    assertOwner()
    try {
      let status: NewApiTopupOrderStatus
      if (client.getTopupOrderStatus) {
        status = await client.getTopupOrderStatus(tradeNo)
      } else if (siteId === 'solov') {
        const page = await client.listTopupOrders({ keyword: tradeNo })
        status = page.orders.find((order) => order.tradeNo === tradeNo)?.status ?? 'unknown'
      } else {
        status = 'unknown'
      }
      assertOwner()
      return status
    } catch (error) {
      assertOwner()
      throw error
    }
  }
}
