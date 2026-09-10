import { describe, expect, it, vi } from 'vitest'
import type { NewApiSessionState, NewApiTopupOrderStatus, NewApiTopupOrdersPage } from './new-api-client'
import type { RelayBackendClient } from './relay-backend'
import { RealmAccountError } from './realm-account'
import type { RealmAccountSiteId } from './realm-account-service'
import { createPaymentOrderStatusReader } from './payment-status-reader'

function harness() {
  const owner = { siteId: 'solov-api' as RealmAccountSiteId, userId: 12, authenticated: true, revision: 3, busy: false }
  const getTopupOrderStatus = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockResolvedValue('pending')
  const listTopupOrders = vi.fn<() => Promise<NewApiTopupOrdersPage>>().mockResolvedValue({ page: 1, pageSize: 20, total: 0, orders: [] })
  const client = {
    getSessionState: () => ({ authenticated: owner.authenticated, account: { userId: owner.userId } } as NewApiSessionState),
    getSessionRevision: () => owner.revision,
    getTopupOrderStatus,
    listTopupOrders,
  } as unknown as RelayBackendClient
  const options = { client, getSiteId: () => owner.siteId, assertReady: () => { if (owner.busy) throw new RealmAccountError('BUSY') } }
  return { owner, client, getTopupOrderStatus, listTopupOrders, options }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('createPaymentOrderStatusReader', () => {
  it('uses the native exact order-status reader before any order-list fallback', async () => {
    const h = harness()
    h.getTopupOrderStatus.mockResolvedValue('success')
    const reader = createPaymentOrderStatusReader(h.options, 'sub2-123')!
    await expect(reader()).resolves.toBe('success')
    expect(h.getTopupOrderStatus).toHaveBeenCalledWith('sub2-123')
    expect(h.listTopupOrders).not.toHaveBeenCalled()
  })

  it('filters fallback search results by the full exact trade number', async () => {
    const h = harness()
    h.owner.siteId = 'solov'
    delete h.client.getTopupOrderStatus
    h.listTopupOrders.mockResolvedValue({ page: 1, pageSize: 20, total: 2, orders: [
      { tradeNo: 'XM-123-extra', status: 'success' },
      { tradeNo: 'XM-123', status: 'pending' },
    ] } as NewApiTopupOrdersPage)
    const reader = createPaymentOrderStatusReader(h.options, 'XM-123')!
    await expect(reader()).resolves.toBe('pending')
    expect(h.listTopupOrders).toHaveBeenCalledWith({ keyword: 'XM-123' })
    h.listTopupOrders.mockResolvedValue({ page: 1, pageSize: 20, total: 1, orders: [
      { tradeNo: 'XM-123-extra', status: 'success' },
    ] } as NewApiTopupOrdersPage)
    await expect(reader()).resolves.toBe('unknown')
  })

  it('does not substitute an unsupported Sub2API reader with legacy order-list statuses', async () => {
    const h = harness()
    delete h.client.getTopupOrderStatus
    const reader = createPaymentOrderStatusReader(h.options, 'sub2-123')!
    await expect(reader()).resolves.toBe('unknown')
    expect(h.listTopupOrders).not.toHaveBeenCalled()
  })

  it.each(['user', 'site', 'revision', 'logout', 'busy'] as const)('rejects %s changes before making a request for the old order', async (change) => {
    const h = harness()
    const reader = createPaymentOrderStatusReader(h.options, 'sub2-123')!
    if (change === 'user') h.owner.userId += 1
    if (change === 'site') h.owner.siteId = 'solov'
    if (change === 'revision') h.owner.revision += 1
    if (change === 'logout') h.owner.authenticated = false
    if (change === 'busy') h.owner.busy = true
    await expect(reader()).rejects.toMatchObject({ code: 'STALE' })
    expect(h.getTopupOrderStatus).not.toHaveBeenCalled()
    expect(h.listTopupOrders).not.toHaveBeenCalled()
  })

  it('rejects a successful result arriving after an account switch', async () => {
    const h = harness()
    const pending = deferred<NewApiTopupOrderStatus>()
    h.getTopupOrderStatus.mockReturnValue(pending.promise)
    const reader = createPaymentOrderStatusReader(h.options, 'sub2-123')!
    const reading = reader()
    h.owner.siteId = 'solov'
    pending.resolve('success')
    await expect(reading).rejects.toMatchObject({ code: 'STALE' })
    h.owner.siteId = 'solov-api'
    await expect(reader()).rejects.toMatchObject({ code: 'STALE' })
    expect(h.getTopupOrderStatus).toHaveBeenCalledOnce()
  })

  it('rejects a late error after logging out and back into the same account', async () => {
    const h = harness()
    const pending = deferred<NewApiTopupOrderStatus>()
    h.getTopupOrderStatus.mockReturnValue(pending.promise)
    const reader = createPaymentOrderStatusReader(h.options, 'sub2-123')!
    const reading = reader()
    h.owner.revision += 2
    pending.reject(new Error('network down'))
    await expect(reading).rejects.toMatchObject({ code: 'STALE' })
  })

  it('allows retrying transient network errors for the same authenticated owner', async () => {
    const h = harness()
    h.getTopupOrderStatus.mockRejectedValueOnce(new Error('network down')).mockResolvedValue('success')
    const reader = createPaymentOrderStatusReader(h.options, 'sub2-123')!
    await expect(reader()).rejects.toThrow('network down')
    await expect(reader()).resolves.toBe('success')
    expect(h.listTopupOrders).not.toHaveBeenCalled()
  })

  it('cannot create a reader without an authenticated and revisioned owner', () => {
    const h = harness()
    h.owner.authenticated = false
    expect(createPaymentOrderStatusReader(h.options, 'sub2-123')).toBeUndefined()
    h.owner.authenticated = true
    delete h.client.getSessionRevision
    expect(createPaymentOrderStatusReader(h.options, 'sub2-123')).toBeUndefined()
  })
})
