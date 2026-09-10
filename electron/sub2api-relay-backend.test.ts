import { describe, expect, it, vi } from 'vitest'
import { createSub2ApiRelayBackend } from './sub2api-relay-backend'
import { parseRealmSavedAccount, RealmAccountError, type RealmSavedAccount } from './realm-account'
import { sub2ApiManagedCliKeyProfiles } from './catalog'

const now = Date.parse('2026-09-09T00:00:00Z')
const user = (id = 7) => ({ id, username: `user-${id}`, email: 'same@example.test', balance: 100.25, status: 'active', role: 'user' })
const groups = Object.values(sub2ApiManagedCliKeyProfiles).map((profile, index) => ({
  id: index + 1, name: profile.group, platform: 'openai', status: 'active', rate_multiplier: 1.5,
}))
const codexGroup = groups.find((group) => group.name === 'Codex_pro')!
const auth = (id = 7, rotated = false) => ({ access_token: `${rotated ? 'rotated' : 'access'}-${id}`,
  refresh_token: `${rotated ? 'rotated-refresh' : 'refresh'}-${id}`, expires_in: 3600, token_type: 'Bearer', user: user(id) })
const loginInput = { username: 'same@example.test', password: 'test-password' }
const keyRecord = (id: number, extra: Record<string, unknown> = {}) => ({ id, user_id: 7,
  name: `key-${id}`, group_id: codexGroup.id, status: 'active', key: `sk-secret-${id}`, quota: 0, quota_used: 0,
  created_at: '2026-09-01T00:00:00Z', expires_at: null, last_used_at: null, ...extra })
type Key = ReturnType<typeof keyRecord>
const json = (data: unknown) => Response.json({ code: 0, data })
const unauthorized = () => new Response('', { status: 401 })
const noticeRecord = (id = 7, extra: Record<string, unknown> = {}) => ({
  id, title: `公告 ${id}`, content: `内容 ${id}`, updated_at: '2026-09-09T00:00:00Z', ...extra,
})
function saved(id = 7): RealmSavedAccount {
  return parseRealmSavedAccount({ version: 2, realmId: 'api-account', origin: 'https://api.solov.cc',
    userId: String(id), username: `user-${id}`, credential: { kind: 'sub2api', accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`, expiresAt: now + 3600000 } })
}
interface Request { url: URL; init: RequestInit; token: string; body: Record<string, unknown> }
function fixture(options: { onCredentialRotation?: (saved: RealmSavedAccount) => void | Promise<void> } = {}) {
  const calls: Request[] = []
  const onSessionChange = vi.fn()
  const onCredentialRotation = vi.fn(options.onCredentialRotation)
  const state = { loginId: 7, expired: false, keys: [] as Key[], available: groups.map((group) => ({ ...group })),
    override: undefined as undefined | ((request: Request) => Promise<Response | undefined> | Response | undefined) }
  const backend = createSub2ApiRelayBackend({ now: () => now, onSessionChange, onCredentialRotation,
    fetchImpl: async (input, init) => {
      const request = { url: new URL(input), init,
        token: new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '',
        body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} }
      calls.push(request)
      const overridden = await state.override?.(request)
      if (overridden) return overridden
      const route = request.url.pathname.replace('/api/v1', '')
      if (route === '/settings/public') return json({ site_name: '星芒 API', turnstile_enabled: false })
      if (route === '/auth/login') return json(auth(state.loginId))
      if (route === '/auth/refresh') return json(auth(Number(String(request.body.refresh_token).split('-').at(-1)), true))
      if (!request.token || (state.expired && request.token.startsWith('access-'))) return unauthorized()
      const id = Number(request.token.split('-').at(-1))
      if (route === '/auth/me' || route === '/user/profile') return json(user(id))
      if (route === '/user' && init.method === 'PUT') return json({ ...user(id), username: request.body.username })
      if (route === '/user/password' && init.method === 'PUT') return json({ message: 'Password changed successfully' })
      if (route === '/groups/available') return json(state.available)
      if (route === '/keys' && init.method === 'GET') {
        const page = Number(request.url.searchParams.get('page'))
        const size = Number(request.url.searchParams.get('page_size'))
        return json({ items: state.keys.slice((page - 1) * size, page * size), total: state.keys.length })
      }
      if (route === '/keys' && init.method === 'POST') {
        const key = keyRecord(Math.max(0, ...state.keys.map((entry) => entry.id)) + 1, request.body)
        state.keys.push(key)
        return json(key)
      }
      const keyId = Number(route.match(/^\/keys\/(\d+)$/)?.[1])
      const key = state.keys.find((entry) => entry.id === keyId)
      if (key && init.method === 'GET') return json(key)
      if (key && init.method === 'PUT') {
        Object.assign(key, request.body, request.body.expires_at === '' ? { expires_at: null } : {})
        return json(key)
      }
      if (key && init.method === 'DELETE') { state.keys = state.keys.filter((entry) => entry !== key); return json({ message: 'deleted' }) }
      throw new Error(`Unexpected fixture request: ${init.method} ${route}`)
    },
  })
  return { ...backend, state, calls, onSessionChange, onCredentialRotation }
}

describe('Sub2API announcement sessions', () => {
  it('requires a logged-in user before loading notices', async () => {
    const f = fixture()
    await expect(f.client.getNotice!()).rejects.toMatchObject({ code: 'SIGNED_OUT' })
    expect(f.calls).toHaveLength(0)
  })

  it('acknowledges only the selected unread announcement from the displayed snapshot', async () => {
    const f = fixture()
    let announcements = [noticeRecord(7), noticeRecord(8, { read_at: '2026-09-09T01:00:00Z' }), noticeRecord(9)]
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json(announcements)
      : /\/announcements\/\d+\/read$/.test(url.pathname) ? json({ message: 'ok' }) : undefined
    await f.client.login(loginInput)
    const first = (await f.client.getNotice!())!
    await expect(f.client.markNoticeRead!('7', '7')).rejects.toMatchObject({ code: 'INVALID' })
    await expect(f.client.markNoticeRead!(`sub2api-${'0'.repeat(64)}`, '7')).rejects.toMatchObject({ code: 'STALE' })
    await f.client.markNoticeRead!(first.id, '7')
    await f.client.markNoticeRead!(first.id, '7')
    await f.client.markNoticeRead!(first.id, '8')
    expect(f.calls.filter(({ init, url }) => init.method === 'POST' && url.pathname.includes('/announcements/'))
      .map(({ url, token, init }) => ({ path: url.pathname, token, body: init.body }))).toEqual([
      { path: '/api/v1/announcements/7/read', token: 'access-7', body: undefined },
    ])
    await f.client.markNoticeRead!(first.id, '9')
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/read')).map(({ url }) => url.pathname))
      .toEqual(['/api/v1/announcements/7/read', '/api/v1/announcements/9/read'])
    // The next server response remains authoritative, even after a successful POST.
    expect((await f.client.getNotice!())?.entries?.map(({ read }) => read)).toEqual([false, true, false])
    announcements = announcements.map((item) => ({ ...item, read_at: '2026-09-10T00:00:00Z' }))
    const readNotice = (await f.client.getNotice!())!
    expect(readNotice.id).toBe(first.id)
    expect(readNotice.entries?.every(({ read }) => read)).toBe(true)
    const before = f.calls.length
    await f.client.markNoticeRead!(readNotice.id, '9')
    expect(f.calls).toHaveLength(before)
  })

  it('rejects missing, malformed and unlisted entry IDs without marking any announcement read', async () => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord(7), noticeRecord(8)]) : undefined
    await f.client.login(loginInput)
    const notice = (await f.client.getNotice!())!
    for (const entryId of [undefined, null, {}, 7, '', '0', '-1', '01', '1.5', ' 7 ', '7/read', '9007199254740992', '9']) {
      await expect(f.client.markNoticeRead!(notice.id, entryId as string)).rejects.toMatchObject({ code: 'INVALID' })
    }
    expect(f.calls.some(({ url }) => url.pathname.endsWith('/read'))).toBe(false)
  })

  it('keeps the selected announcement unread after a failed write so it can be retried', async () => {
    const f = fixture()
    let failed = true
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord(7), noticeRecord(8)])
      : url.pathname.endsWith('/read') ? failed ? new Response('', { status: 503 }) : json({ message: 'ok' }) : undefined
    await f.client.login(loginInput)
    const notice = (await f.client.getNotice!())!
    await expect(f.client.markNoticeRead!(notice.id, '7')).rejects.toThrow()
    failed = false
    await expect(f.client.markNoticeRead!(notice.id, '7')).resolves.toBeUndefined()
    await expect(f.client.markNoticeRead!(notice.id, '7')).resolves.toBeUndefined()
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/read')).map(({ url }) => url.pathname))
      .toEqual(['/api/v1/announcements/7/read', '/api/v1/announcements/7/read'])
    expect(f.client.getSessionState().authenticated).toBe(true)
  })

  it('invalidates a displayed snapshot after a newer publication is fetched', async () => {
    const f = fixture()
    let content = '第一版'
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord(7, { content })]) : undefined
    await f.client.login(loginInput)
    const first = (await f.client.getNotice!())!
    content = '第二版'
    expect((await f.client.getNotice!())?.id).not.toBe(first.id)
    await expect(f.client.markNoticeRead!(first.id, '7')).rejects.toMatchObject({ code: 'STALE' })
    expect(f.calls.some(({ url }) => url.pathname.endsWith('/read'))).toBe(false)
  })

  it('clears announcement snapshots across logout and same-user login', async () => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord()]) : undefined
    await f.client.login(loginInput)
    const notice = (await f.client.getNotice!())!
    f.client.logout()
    await f.client.login(loginInput)
    await expect(f.client.markNoticeRead!(notice.id, '7')).rejects.toMatchObject({ code: 'STALE' })
    expect(f.calls.some(({ url }) => url.pathname.endsWith('/read'))).toBe(false)
  })

  it('returns null for an empty list but rejects malformed lists instead of hiding protocol errors', async () => {
    for (const payload of [[], null, {}, [{ id: '7', title: '公告', content: '内容' }]]) {
      const f = fixture()
      f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json(payload) : undefined
      await f.client.login(loginInput)
      if (Array.isArray(payload) && !payload.length) await expect(f.client.getNotice!()).resolves.toBeNull()
      else await expect(f.client.getNotice!()).rejects.toMatchObject({ code: 'PROTOCOL' })
      expect(f.client.getSessionState().authenticated).toBe(true)
      expect(f.onSessionChange).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps the login and concurrent balance request when a notice response is rejected', async () => {
    const f = fixture()
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/auth/me') ? new Promise<Response>((resolve) => { release = resolve; started() })
      : url.pathname.endsWith('/announcements') ? json({ unexpected: 'shape' }) : undefined
    await f.client.login(loginInput)
    const revision = f.client.getSessionRevision!()
    const balance = f.client.getBalance()
    await gate
    await expect(f.client.getNotice!()).rejects.toMatchObject({ code: 'PROTOCOL' })
    release(json(user()))
    await expect(balance).resolves.toMatchObject({ displayAmount: 100.25 })
    expect(f.client.getSessionRevision!()).toBe(revision)
    expect(f.getSavedAccount()?.userId).toBe('7')
  })

  it('does not sign out on a rejected usage response or an oversized announcement', async () => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/usage') ? Response.json({ invalid: true })
      : url.pathname.endsWith('/usage/stats') ? json({ total_actual_cost: 0 })
        : url.pathname.endsWith('/announcements') ? new Response('', { headers: { 'content-type': 'application/json', 'content-length': '4194305' } }) : undefined
    await f.client.login(loginInput)
    await expect(f.client.getUsage()).rejects.toMatchObject({ code: 'PROTOCOL' })
    await expect(f.client.getNotice!()).rejects.toThrow('公告读取响应超过 4096 KB')
    await expect(f.client.getBalance()).resolves.toMatchObject({ displayAmount: 100.25 })
    expect(f.onSessionChange).toHaveBeenCalledTimes(1)
  })

  it('refreshes a 401 list request once and retries with the rotated bearer token', async () => {
    const f = fixture()
    f.state.override = ({ url, token }) => url.pathname.endsWith('/announcements')
      ? token === 'rotated-7' ? json([noticeRecord()]) : unauthorized() : undefined
    await f.client.login(loginInput)
    f.state.expired = true
    await expect(f.client.getNotice!()).resolves.toMatchObject({ entries: [{ id: '7', read: false }] })
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/announcements')).map(({ token }) => token)).toEqual(['access-7', 'rotated-7'])
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/auth/refresh'))).toHaveLength(1)
  })

  it('refreshes credentials after an acknowledgement 401 without replaying the write', async () => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord()])
      : url.pathname.endsWith('/read') ? unauthorized() : undefined
    await f.client.login(loginInput)
    const notice = (await f.client.getNotice!())!
    f.state.expired = true
    await expect(f.client.markNoticeRead!(notice.id, '7')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/read'))).toHaveLength(1)
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(f.getSavedAccount()?.credential).toMatchObject({ accessToken: 'rotated-7' })
  })

  it.each([7, 8])('discards an old notice response after switching to user %s', async (nextUser) => {
    const f = fixture()
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? new Promise<Response>((resolve) => {
      release = resolve; started()
    }) : undefined
    await f.client.login(loginInput)
    const pending = expect(f.client.getNotice!()).rejects.toMatchObject({ code: 'STALE' })
    await gate
    f.client.logout()
    f.state.loginId = nextUser
    await f.client.login(loginInput)
    release(json([noticeRecord()]))
    await pending
    expect(f.client.getSessionState().account?.userId).toBe(nextUser)
  })

  it('discards a pending acknowledgement after an account switch', async () => {
    const f = fixture()
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord(7), noticeRecord(8)])
      : url.pathname.endsWith('/read') ? new Promise<Response>((resolve) => { release = resolve; started() }) : undefined
    await f.client.login(loginInput)
    const notice = (await f.client.getNotice!())!
    const pending = expect(f.client.markNoticeRead!(notice.id, '7')).rejects.toMatchObject({ code: 'STALE' })
    await gate
    f.state.loginId = 8
    await f.client.login(loginInput)
    release(json({ message: 'ok' }))
    await pending
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/read')).map(({ url, token }) => [url.pathname, token]))
      .toEqual([['/api/v1/announcements/7/read', 'access-7']])
    expect(f.client.getSessionState().account?.userId).toBe(8)
  })

  it('does not apply a late acknowledgement to a replacement snapshot', async () => {
    const f = fixture()
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord(7), noticeRecord(8)])
      : url.pathname.endsWith('/read') ? new Promise<Response>((resolve) => { release = resolve; started() }) : undefined
    await f.client.login(loginInput)
    const first = (await f.client.getNotice!())!
    const pending = expect(f.client.markNoticeRead!(first.id, '7')).rejects.toMatchObject({ code: 'STALE' })
    await gate
    const latest = (await f.client.getNotice!())!
    release(json({ message: 'ok' }))
    await pending
    f.state.override = ({ url }) => url.pathname.endsWith('/read') ? json({ message: 'ok' }) : undefined
    await f.client.markNoticeRead!(latest.id, '7')
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/read')).map(({ url }) => url.pathname))
      .toEqual(['/api/v1/announcements/7/read', '/api/v1/announcements/7/read'])
  })

  it('does not replace a newer announcement snapshot with an older concurrent response', async () => {
    const f = fixture()
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? new Promise<Response>((resolve) => {
      release = resolve; started()
    }) : undefined
    await f.client.login(loginInput)
    const old = expect(f.client.getNotice!()).rejects.toMatchObject({ code: 'STALE' })
    await gate
    f.state.override = ({ url }) => url.pathname.endsWith('/announcements') ? json([noticeRecord(9, { read_at: '2026-09-10T00:00:00Z' })]) : undefined
    const latest = (await f.client.getNotice!())!
    release(json([noticeRecord(7)]))
    await old
    await expect(f.client.markNoticeRead!(latest.id, '9')).resolves.toBeUndefined()
  })
})

describe('Sub2API RelayBackend adapter', () => {
  it('maps account-center reads from native endpoints without exposing credentials', async () => {
    const f = fixture()
    f.state.override = ({ url }) => {
      const path = url.pathname
      if (path.endsWith('/usage')) return json({ page: 2, page_size: 10, total: 12, items: [{ id: 9, created_at: '2026-09-08T01:00:00Z', model: 'gpt-5.6-sol', input_tokens: 10, output_tokens: 20, actual_cost: 0.12, stream: true, api_key: { name: 'Codex', key: 'do-not-return' }, group: { name: 'Codex_pro' } }] })
      if (path.endsWith('/usage/stats')) return json({ total_actual_cost: 0.12, rpm: 1, tpm: 30 })
      if (path.endsWith('/payment/checkout-info')) return json({ methods: { alipay: { display_name: '支付宝', single_min: 5 } }, global_min: 5 })
      if (path.endsWith('/payment/orders/my')) return json({ page: 1, page_size: 10, total: 1, items: [{ id: 3, amount: 10, pay_amount: 70, out_trade_no: 'trade-3', payment_type: 'alipay', status: 'COMPLETED', created_at: '2026-09-08T00:00:00Z' }] })
      if (path.endsWith('/payment/plans')) return json([{ id: 4, group_id: 1, name: '月度订阅', description: '套餐', price: 20, validity_days: 30, validity_unit: 'day', group_name: 'Codex_pro' }])
      if (path.endsWith('/subscriptions')) return json([{ id: 5, group_id: 1, status: 'active', starts_at: '2026-09-01T00:00:00Z', expires_at: '2026-10-01T00:00:00Z', monthly_usage_usd: 2.5 }])
      if (path.endsWith('/user/aff')) return json({ aff_code: 'invite7', aff_count: 2, aff_quota: 1.2, aff_history_quota: 3.4 })
      if (path.endsWith('/announcements')) return json([{ id: 12, title: '系统公告', content: '充值后额度会自动到账。' }])
      if (path.endsWith('/redeem')) return json({ type: 'balance', value: 7.5, new_balance: 107.75 })
    }
    await f.client.login(loginInput)
    const usage = await f.client.getUsage({ page: 2, pageSize: 10, modelName: 'gpt-5.6-sol' })
    expect(usage).toMatchObject({ page: 2, total: 12, records: [{ quota: 0.12, modelName: 'gpt-5.6-sol', group: 'Codex_pro' }] })
    expect(await f.client.getTopupInfo()).toMatchObject({ minTopup: 5, paymentMethods: [{ type: 'alipay', name: '支付宝' }] })
    expect(await f.client.listTopupOrders()).toMatchObject({ orders: [{ tradeNo: 'trade-3', money: 70, status: 'success' }] })
    expect(await f.client.listSubscriptionPlans()).toMatchObject([{ title: '月度订阅', durationValue: 30 }])
    expect(await f.client.getSubscriptionSelf()).toMatchObject({ activeSubscriptions: [{ id: 5, amountUsed: 2.5 }] })
    expect(await f.client.getProfile()).toMatchObject({ affCode: 'invite7', affCount: 2, affQuota: 1.2 })
    await expect(f.client.getNotice?.()).resolves.toEqual({ id: expect.stringMatching(/^sub2api-[a-f0-9]{64}$/),
      text: '系统公告\n\n充值后额度会自动到账。', entries: [{ id: '12', title: '系统公告', text: '充值后额度会自动到账。', read: false }] })
    await expect(f.client.redeemTopupCode('CARD-7')).resolves.toEqual({ type: 'balance', quotaAdded: 7.5 })
    expect(JSON.stringify(usage)).not.toContain('do-not-return')
  })
  it.each([
    ['subscription', 0, 0],
    ['concurrency', 5, 0],
    ['balance', -2.5, -2.5],
  ] as const)('accepts committed %s redemptions without replaying the code or exposing native fields', async (type, value, quotaAdded) => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/redeem') ? json({
      id: 42, code: 'PRIVATE-CARD', type, value, status: 'used', used_by: 7,
      validity_days: 30, user: { access_token: 'private-token' },
    }) : undefined
    await f.client.login(loginInput)
    await expect(f.client.redeemTopupCode('PRIVATE-CARD')).resolves.toEqual({ type, quotaAdded })
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/redeem'))).toHaveLength(1)
    expect(f.client.getSessionState().authenticated).toBe(true)
  })
  it.each([
    { type: 'balance', amount: 10 },
    { type: 'subscription', value: '30' },
    { type: 'unknown-balance', value: 10 },
  ])('rejects malformed redemption receipts without retrying or clearing the session: %j', async (receipt) => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/redeem') ? json(receipt) : undefined
    await f.client.login(loginInput)
    await expect(f.client.redeemTopupCode('CARD')).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/redeem'))).toHaveLength(1)
    expect(f.client.getSessionState().authenticated).toBe(true)
  })
  it('creates a Sub2API recharge order and supports QR-only providers', async () => {
    const f = fixture()
    f.state.override = ({ url, init, body }) => {
      if (url.pathname.endsWith('/payment/checkout-info')) return json({ payment_enabled: true, balance_recharge_multiplier: 1.5, recharge_fee_rate: 2, methods: { alipay: { display_name: '支付宝', single_min: 1 } }, global_min: 1 })
      if (url.pathname.endsWith('/payment/orders') && init.method === 'POST') return json({ amount: 15, pay_amount: 10.2, qr_code: 'weixin://wxpay/bizpayurl?pr=test', out_trade_no: 'trade-qr', expires_at: '2026-09-10T01:00:00Z', currency: 'CNY', received_amount: body.amount })
    }
    await f.client.login(loginInput)
    await expect(f.client.quoteTopupAmount({ amount: 10 })).resolves.toEqual({ amount: 10, payableAmount: 10.2 })
    await expect(f.client.createTopupPayment({ amount: 10, paymentMethod: 'alipay' })).resolves.toMatchObject({ kind: 'qrcode', code: 'weixin://wxpay/bizpayurl?pr=test', tradeNo: 'trade-qr', amount: 10.2 })
    expect(f.calls.filter(({ url, init }) => url.pathname.endsWith('/payment/orders') && init.method === 'POST').map(({ body }) => body))
      .toEqual([{ amount: 10, payment_type: 'alipay', order_type: 'balance', is_mobile: false }])
  })
  it.each([
    ['PENDING', 'pending'], ['PAID', 'pending'], ['RECHARGING', 'pending'], ['COMPLETED', 'success'],
    ['FAILED', 'failed'], ['CANCELLED', 'failed'], ['EXPIRED', 'expired'], ['REFUNDED', 'unknown'],
    ['REFUND_REQUESTED', 'unknown'], ['REFUNDING', 'unknown'], ['PARTIALLY_REFUNDED', 'unknown'], ['NEW_STATUS', 'unknown'],
  ])('reconciles %s without declaring fulfillment until COMPLETED', async (status, expected) => {
    const f = fixture()
    const order = { id: 31, user_id: 7, out_trade_no: 'sub2_trade-31', status }
    f.state.override = ({ url }) => url.pathname.endsWith('/payment/orders/verify') ? json(order)
      : url.pathname.endsWith('/payment/orders/my') ? json({ items: [order] }) : undefined
    await f.client.login(loginInput)
    await expect(f.client.getTopupOrderStatus!('sub2_trade-31')).resolves.toBe(expected)
    expect((await f.client.listTopupOrders()).orders[0].status).toBe(expected)
    const verification = f.calls.find(({ url }) => url.pathname.endsWith('/payment/orders/verify'))!
    expect(verification.init.method).toBe('POST')
    expect(verification.body).toEqual({ out_trade_no: 'sub2_trade-31' })
    expect(f.calls.some(({ url }) => url.pathname === '/api/v1/payment/orders')).toBe(false)
  })
  it('retries an authenticated order lookup once after refreshing a 401 response', async () => {
    const f = fixture()
    f.state.override = ({ url, token }) => url.pathname.endsWith('/payment/orders/verify')
      ? token === 'access-7' ? unauthorized() : json({ id: 31, user_id: 7, out_trade_no: 'sub2_trade-31', status: 'COMPLETED' }) : undefined
    await f.client.login(loginInput)
    f.state.expired = true
    await expect(f.client.getTopupOrderStatus!('sub2_trade-31')).resolves.toBe('success')
    expect(f.calls.filter(({ url }) => url.pathname.endsWith('/payment/orders/verify')).map(({ token }) => token))
      .toEqual(['access-7', 'rotated-7'])
    expect(f.client.getSessionState().authenticated).toBe(true)
  })
  it('keeps the session and permits another poll after a transient reconciliation failure', async () => {
    const f = fixture()
    let unavailable = true
    f.state.override = ({ url }) => url.pathname.endsWith('/payment/orders/verify')
      ? unavailable ? new Response('', { status: 503 }) : json({ id: 31, user_id: 7, out_trade_no: 'sub2_trade-31', status: 'COMPLETED' }) : undefined
    await f.client.login(loginInput)
    await expect(f.client.getTopupOrderStatus!('sub2_trade-31')).rejects.toMatchObject({ code: 'NETWORK' })
    expect(f.client.getSessionState().authenticated).toBe(true)
    unavailable = false
    await expect(f.client.getTopupOrderStatus!('sub2_trade-31')).resolves.toBe('success')
  })
  it('does not accept a completed order belonging to another account', async () => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/payment/orders/verify')
      ? json({ id: 31, user_id: 8, out_trade_no: 'sub2_trade-31', status: 'COMPLETED' }) : undefined
    await f.client.login(loginInput)
    await expect(f.client.getTopupOrderStatus!('sub2_trade-31')).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(f.getSavedAccount()).toBeNull()
  })
  it('rejects a mismatched order response without signing the account out', async () => {
    const f = fixture()
    f.state.override = ({ url }) => url.pathname.endsWith('/payment/orders/verify')
      ? json({ id: 32, user_id: 7, out_trade_no: 'sub2_trade-32', status: 'COMPLETED' }) : undefined
    await f.client.login(loginInput)
    await expect(f.client.getTopupOrderStatus!('sub2_trade-31')).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(f.client.getSessionState().authenticated).toBe(true)
  })
  it.each(['COMPLETED', '401'])('discards a late %s verification response after changing accounts', async (result) => {
    const f = fixture()
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/payment/orders/verify')
      ? new Promise<Response>((resolve) => { release = resolve; started() }) : undefined
    await f.client.login(loginInput)
    const pending = expect(f.client.getTopupOrderStatus!('sub2_trade-31')).rejects.toMatchObject({ code: 'STALE' })
    await gate
    f.state.loginId = 8
    await f.client.login(loginInput)
    release(result === '401' ? unauthorized() : json({ id: 31, user_id: 7, out_trade_no: 'sub2_trade-31', status: result }))
    await pending
    expect(f.getSavedAccount()?.userId).toBe('8')
    expect(f.calls.some(({ url }) => url.pathname.endsWith('/auth/refresh'))).toBe(false)
  })
  it('keeps a new recharge write in its captured account and drops the checkout after account change', async () => {
    const f = fixture()
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname === '/api/v1/payment/orders'
      ? new Promise<Response>((resolve) => { release = resolve; started() }) : undefined
    await f.client.login(loginInput)
    const pending = expect(f.client.createTopupPayment({ amount: 10, paymentMethod: 'alipay' })).rejects.toMatchObject({ code: 'STALE' })
    await gate
    f.state.loginId = 8
    await f.client.login(loginInput)
    release(json({ out_trade_no: 'sub2_trade-31', pay_url: 'https://pay.example.test/order' }))
    await pending
    expect(f.getSavedAccount()?.userId).toBe('8')
    expect(f.calls.filter(({ url }) => url.pathname === '/api/v1/payment/orders').map(({ token, body }) => ({ token, body })))
      .toEqual([{ token: 'access-7', body: { amount: 10, payment_type: 'alipay', order_type: 'balance', is_mobile: false } }])
  })
  it('implements public settings and exposes the supported account-center blocks', async () => {
    const f = fixture()
    expect(await f.client.getStatus()).toMatchObject({ systemName: '星芒 API', quotaPerUnit: 1, quotaDisplayType: 'USD',
      registerEnabled: false, passwordRegisterEnabled: false })
    expect(f.client.capabilities).toMatchObject({ supportsRegistration: false, supportsBilling: true,
      supportsUsage: true, supportsSubscriptions: true, supportsSessionManagement: false,
      supportsKeyManagement: true, supportsAccountSession: true, supportsAutoKeyProvision: true })
    await expect(f.client.register({ username: 'user', password: 'test-password', email: 'same@example.test' })).rejects.toThrow('暂不支持')
    await expect(f.client.listLoginSessions()).rejects.toThrow('暂不支持')
    await expect(f.client.restoreSession({ userId: 7, username: 'x', cookies: ['private'] } as never)).rejects.toThrow('暂不支持')
    expect(f.calls).toHaveLength(1)
  })

  it('logs in only to api.solov.cc and keeps bearer credentials out of renderer DTOs', async () => {
    const f = fixture()
    const result = await f.client.login(loginInput)
    expect(result.account).toMatchObject({ userId: 7, username: 'user-7', quota: 100.25 })
    expect(f.client.getActiveSiteId?.()).toBe('solov-api')
    expect(f.calls.map((call) => call.url.origin)).toEqual(['https://api.solov.cc', 'https://api.solov.cc'])
    expect(f.calls[0].body).toEqual({ email: loginInput.username, password: loginInput.password })
    expect(JSON.stringify([result, f.client.getSessionState()])).not.toMatch(/access-7|refresh-7|test-password/)
    expect(f.getSavedAccount()?.credential.kind).toBe('sub2api')
  })

  it('preserves the active account on failed login and increments revision to stop old work', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    const before = f.getSavedAccount()
    const revision = f.client.getSessionRevision!()
    f.state.override = ({ url }) => url.pathname.endsWith('/auth/login') ? unauthorized() : undefined
    await expect(f.client.login(loginInput)).rejects.toThrow('账号或密码错误')
    expect(f.getSavedAccount()).toBe(before)
    expect(f.client.getSessionState().account?.userId).toBe(7)
    expect(f.client.getSessionRevision!()).toBeGreaterThan(revision)
    expect(f.onSessionChange).toHaveBeenCalledTimes(1)
    f.state.override = undefined
    f.state.expired = true
    await expect(f.client.getProfile()).resolves.toMatchObject({ userId: 7 })
    expect(f.getSavedAccount()?.credential).toMatchObject({ refreshToken: 'rotated-refresh-7' })
  })

  it('rejects late login completion after logout without resurrecting credentials', async () => {
    const f = fixture()
    let release!: (response: Response) => void
    f.state.override = ({ url }) => url.pathname.endsWith('/auth/login')
      ? new Promise<Response>((resolve) => { release = resolve }) : undefined
    const pending = f.client.login(loginInput)
    f.client.logout()
    release(json(auth()))
    await expect(pending).rejects.toThrow('上下文已变化')
    expect(f.getSavedAccount()).toBeNull()
    expect(f.calls).toHaveLength(1)
  })

  it('returns native dollar balance and reads/updates the actual profile route', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    expect(await f.client.getBalance()).toEqual({ quota: 100.25, usedQuota: 0, quotaPerUnit: 1,
      quotaDisplayType: 'USD', usdExchangeRate: 1, displayAmount: 100.25 })
    expect(await f.client.getProfile()).toMatchObject({ email: 'same@example.test', displayName: 'user-7', quota: 100.25 })
    expect(await f.client.updateDisplayName({ displayName: 'renamed' })).toEqual({ updated: true })
    expect(f.calls.at(-1)).toMatchObject({ init: { method: 'PUT' }, body: { username: 'renamed' } })
    expect(f.calls.at(-1)?.url.pathname).toBe('/api/v1/user')
    expect(f.getSavedAccount()?.username).toBe('renamed')
  })

  it('restores only the matching realm and validates profile before activation', async () => {
    const f = fixture()
    expect(await f.restore(saved())).toBe(true)
    expect(f.client.getSessionState().authenticated).toBe(true)
    const foreign = parseRealmSavedAccount({ version: 2, realmId: 'xm-account', origin: 'https://xm.solov.cc',
      userId: '7', username: 'xm-user', credential: { kind: 'new-api', cookies: ['xm=secret'] } })
    await expect(f.restore(foreign)).rejects.toThrow('参数无效')
    expect(f.calls.map((call) => call.url.pathname)).toEqual(['/api/v1/auth/me', '/api/v1/user/profile'])
  })

  it('serializes refresh and persists the rotated token when concurrent GET retries fail', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    const revision = f.client.getSessionRevision!()
    f.state.expired = true
    f.state.override = ({ url, token }) => url.pathname.endsWith('/user/profile') && token.startsWith('rotated-')
      ? new Response('', { status: 503 }) : undefined
    const results = await Promise.allSettled([f.client.getProfile(), f.client.getProfile()])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(f.calls.filter((call) => call.url.pathname.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(f.getSavedAccount()?.credential).toMatchObject({ accessToken: 'rotated-7', refreshToken: 'rotated-refresh-7' })
    expect(f.onSessionChange).toHaveBeenLastCalledWith(expect.objectContaining({ credential: expect.objectContaining({ refreshToken: 'rotated-refresh-7' }) }))
    expect(f.client.getSessionRevision!()).toBe(revision)
  })

  it('persists rotation even when /me verification times out after refresh', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.expired = true
    f.state.override = ({ url, token }) => url.pathname.endsWith('/auth/me') && token.startsWith('rotated-')
      ? new Response('', { status: 503 }) : undefined
    await expect(f.client.getProfile()).rejects.toThrow('请求失败')
    expect(f.getSavedAccount()?.credential).toMatchObject({ refreshToken: 'rotated-refresh-7' })
    expect(f.client.getSessionState().authenticated).toBe(true)
  })

  it('awaits encrypted credential persistence before retrying with a rotated token', async () => {
    let release!: () => void
    let publishStarted!: () => void
    const started = new Promise<void>((resolve) => { publishStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = fixture({ onCredentialRotation: async () => { publishStarted(); await gate } })
    await f.client.login(loginInput)
    f.state.expired = true
    const pending = f.client.getProfile()
    await started
    expect(f.calls.some((call) => call.token.startsWith('rotated-'))).toBe(false)
    release()
    await expect(pending).resolves.toMatchObject({ userId: 7 })
  })

  it('saves a restored candidate rotation without changing the current identity if verification fails', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.expired = true
    f.state.override = ({ url, token }) => url.pathname.endsWith('/auth/me') && token === 'rotated-8'
      ? new Response('', { status: 503 }) : undefined
    await expect(f.restore(saved(8))).rejects.toThrow('请求失败')
    expect(f.client.getSessionState().account?.userId).toBe(7)
    expect(f.onCredentialRotation).toHaveBeenCalledWith(expect.objectContaining({ userId: '8',
      credential: expect.objectContaining({ refreshToken: 'rotated-refresh-8' }) }))
    expect(f.onSessionChange).toHaveBeenCalledTimes(1)
  })

  it('clears expired sessions only after refresh is definitively rejected', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.expired = true
    f.state.override = ({ url }) => url.pathname.endsWith('/auth/refresh') ? unauthorized() : undefined
    await expect(f.client.getProfile()).rejects.toThrow('登录已失效')
    expect(f.getSavedAccount()).toBeNull()
    expect(f.onSessionChange).toHaveBeenLastCalledWith(null)
  })

  it('rejects a different refresh user and clears the potentially foreign credential', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.expired = true
    f.state.override = ({ url, token }) => url.pathname.endsWith('/auth/me') && token.startsWith('rotated-') ? json(user(8)) : undefined
    await expect(f.client.getProfile()).rejects.toThrow('响应格式不兼容')
    expect(f.getSavedAccount()).toBeNull()
  })

  it.each(['/auth/me', '/user/profile', '/keys'])('still revokes sessions if %s returns another account identity', async (route) => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.override = ({ url }) => url.pathname === `/api/v1${route}`
      ? json(route === '/keys' ? { items: [keyRecord(1, { user_id: 8 })], total: 1 } : user(8)) : undefined
    const operation = route === '/auth/me' ? f.client.getBalance() : route === '/keys' ? f.client.listKeys() : f.client.getProfile()
    await expect(operation).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(f.getSavedAccount()).toBeNull()
  })

  it('revokes the session if rotated credential data is malformed', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.expired = true
    f.state.override = ({ url }) => url.pathname.endsWith('/auth/refresh') ? json({ ...auth(), access_token: '' }) : undefined
    await expect(f.client.getBalance()).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(f.getSavedAccount()).toBeNull()
  })

  it.each([7, 8])('does not persist an old refresh after a new login for user %s', async (newUserId) => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.expired = true
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/auth/refresh') ? new Promise<Response>((resolve) => {
      release = resolve; started()
    }) : undefined
    const pending = f.client.getProfile()
    const rejected = expect(pending).rejects.toThrow('上下文已变化')
    await gate
    f.state.expired = false
    f.state.loginId = newUserId
    await f.client.login(loginInput)
    release(json(auth(7, true)))
    await rejected
    expect(f.getSavedAccount()?.userId).toBe(String(newUserId))
    expect(f.onSessionChange).toHaveBeenLastCalledWith(expect.objectContaining({ userId: String(newUserId) }))
    expect(f.onCredentialRotation).not.toHaveBeenCalled()
  })

  it('does not persist a late restored-candidate rotation after disposal and same-user login', async () => {
    const f = fixture()
    f.state.expired = true
    let release!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    f.state.override = ({ url }) => url.pathname.endsWith('/auth/refresh') ? new Promise<Response>((resolve) => {
      release = resolve; started()
    }) : undefined
    const pending = expect(f.restore(saved())).rejects.toThrow('上下文已变化')
    await gate
    f.client.logout()
    f.state.expired = false
    await f.client.login(loginInput)
    release(json(auth(7, true)))
    await pending
    expect(f.onCredentialRotation).not.toHaveBeenCalled()
    expect(f.getSavedAccount()?.credential).toMatchObject({ accessToken: 'access-7', refreshToken: 'refresh-7' })
  })

  it('traverses every key page and reuses only an exact active group/name match', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.keys = Array.from({ length: 100 }, (_, index) => keyRecord(index + 1))
    f.state.keys.push(keyRecord(101, { name: sub2ApiManagedCliKeyProfiles.codex.keyName }))
    f.state.keys.unshift(keyRecord(200, { name: sub2ApiManagedCliKeyProfiles.codex.keyName, group_id: groups[0].id }))
    const result = await f.client.provisionCliKey({ ...sub2ApiManagedCliKeyProfiles.codex, name: sub2ApiManagedCliKeyProfiles.codex.keyName })
    expect(result).toMatchObject({ id: 101, key: 'sk-secret-101' })
    expect(f.calls.filter((call) => call.url.pathname === '/api/v1/keys' && call.init.method === 'GET')).toHaveLength(2)
    expect(f.calls.some((call) => call.init.method === 'POST' && call.url.pathname.endsWith('/keys'))).toBe(false)
  })

  it('creates the four requested groups once even with concurrent provisioning', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    const profile = sub2ApiManagedCliKeyProfiles.codex
    const [first, second] = await Promise.all([f.client.provisionCliKey({ name: profile.keyName, group: profile.group }),
      f.client.provisionCliKey({ name: profile.keyName, group: profile.group })])
    expect(first.id).toBe(second.id)
    for (const entry of Object.values(sub2ApiManagedCliKeyProfiles)) {
      await f.client.provisionCliKey({ name: entry.keyName, group: entry.group })
    }
    expect(f.state.keys).toHaveLength(4)
    expect(new Set(f.state.keys.map((key) => key.group_id))).toEqual(new Set(groups.map((group) => group.id)))
    expect(f.state.keys.every((key) => key.quota === 0)).toBe(true)
  })

  it('rejects unavailable or duplicate group names before creating anything', async () => {
    for (const duplicate of [false, true]) {
      const f = fixture()
      await f.client.login(loginInput)
      f.state.available = duplicate ? [codexGroup, { ...codexGroup, id: 50 }] : [{ ...codexGroup, status: 'inactive' }]
      await expect(f.client.provisionCliKey()).rejects.toThrow('分组不存在、不可用或名称重复')
      expect(f.state.keys).toHaveLength(0)
    }
  })

  it('returns masked key metadata and supports USD limits, exact expiry, update and deletion', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    const expires = now / 1000 + 3600
    await f.client.createKey({ name: 'my-key', group: 'Codex_pro', remainQuota: 5.25, unlimitedQuota: false, expiredTime: expires })
    const createRequest = f.calls.find((call) => call.url.pathname.endsWith('/keys') && call.init.method === 'POST')!
    expect(createRequest.body).toEqual({ name: 'my-key', group_id: codexGroup.id, quota: 5.25, expires_in_days: 1 })
    f.state.keys[0].quota_used = 2
    const page = await f.client.listKeys()
    expect(page.keys[0]).toMatchObject({ remainQuota: 3.25, unlimitedQuota: false, usedQuota: 2,
      expiredAt: new Date(expires * 1000).toISOString(), group: 'Codex_pro' })
    expect(JSON.stringify(page)).not.toContain('sk-secret')
    expect(page.keys[0].maskedKey).toBe('••••••••')
    expect(JSON.stringify(page)).not.toContain('keyFingerprint')
    expect(await f.client.revealKey(1)).toBe('sk-secret-1')
    await f.client.updateKey({ id: 1, name: 'renamed', group: 'Codex_pro', remainQuota: 4, unlimitedQuota: false, expiredTime: -1 })
    expect(f.calls.at(-1)?.body).toEqual({ name: 'renamed', group_id: codexGroup.id, quota: 6, expires_at: '' })
    await f.client.revokeKey(1)
    expect(f.state.keys).toHaveLength(0)
  })

  it('shows the observed prefix and last four characters while stripping fingerprints from list DTOs', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.keys = [keyRecord(1, { key: 'sk-full-private-key-xy89' }), keyRecord(2, { key: 'custom-key-secret-ABCD' }),
      keyRecord(3, { key: 'sk-masked********zz99' })]
    const page = await f.client.listKeys()
    expect(page.keys.map((key) => key.maskedKey)).toEqual(['sk-••••••••xy89', '••••••••ABCD', 'sk-••••••••zz99'])
    expect(JSON.stringify(page)).not.toMatch(/full-private|custom-key-secret|keyFingerprint|sk-masked/)
    expect(page.keys.every((key) => !Object.hasOwn(key, 'key'))).toBe(true)
  })

  it('identifies a configured secret across pages using an exact fingerprint without sending the secret', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.keys = Array.from({ length: 100 }, (_, index) => keyRecord(index + 1))
    const configured = 'sk-private-configured-value-1234'
    f.state.keys.push(keyRecord(101, { name: 'configured-key', key: configured }))
    const result = await f.client.identifyKey!(configured)
    expect(result).toEqual({ id: 101, name: 'configured-key', group: 'Codex_pro' })
    const reads = f.calls.filter((call) => call.url.pathname === '/api/v1/keys')
    expect(reads).toHaveLength(2)
    expect(reads.every((call) => call.init.method === 'GET' && call.token === 'access-7')).toBe(true)
    expect(JSON.stringify(f.calls)).not.toContain(configured)
    expect(Object.keys(result!)).toEqual(['id', 'name', 'group'])
  })

  it('does not identify a key from a shared suffix, an upstream mask, duplicate secret or unavailable group', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    const configured = 'sk-private-configured-value-1234'
    f.state.keys = [keyRecord(1, { key: 'sk-different-private-key-1234' }), keyRecord(2, { key: 'sk-********1234' })]
    expect(await f.client.identifyKey!(configured)).toBeNull()
    expect(await f.client.identifyKey!('sk-********1234')).toBeNull()
    f.state.keys = [keyRecord(1, { key: configured }), keyRecord(2, { key: configured })]
    expect(await f.client.identifyKey!(configured)).toBeNull()
    f.state.keys = [keyRecord(1, { key: configured, group_id: 999 })]
    expect(await f.client.identifyKey!(configured)).toBeNull()
  })

  it('never repeats a possibly committed key write after a network failure', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.override = ({ url, init }) => url.pathname.endsWith('/keys') && init.method === 'POST'
      ? new Response('', { status: 503 }) : undefined
    await expect(f.client.provisionCliKey()).rejects.toBeInstanceOf(RealmAccountError)
    expect(f.calls.filter((call) => call.url.pathname.endsWith('/keys') && call.init.method === 'POST')).toHaveLength(1)
    expect(f.client.getSessionState().authenticated).toBe(true)
  })

  it('keeps quarter-dollar limits for create/update and rejects a zero limited quota', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    const input = { name: 'small-limit', group: 'Codex_pro', remainQuota: 0.25, unlimitedQuota: false, expiredTime: -1 }
    await f.client.createKey(input)
    expect(f.state.keys[0].quota).toBe(0.25)
    f.state.keys[0].quota_used = 0.125
    await f.client.updateKey({ ...input, id: 1 })
    expect(f.state.keys[0].quota).toBe(0.375)
    const writes = f.calls.filter((call) => ['POST', 'PUT'].includes(call.init.method ?? '')).length
    await expect(f.client.createKey({ ...input, remainQuota: 0 })).rejects.toThrow('限额必须大于 0')
    await expect(f.client.updateKey({ ...input, id: 1, remainQuota: 0 })).rejects.toThrow('限额必须大于 0')
    expect(f.calls.filter((call) => ['POST', 'PUT'].includes(call.init.method ?? ''))).toHaveLength(writes)
  })

  it('refreshes after an unauthorized write without replaying the mutation', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.keys = [keyRecord(1)]
    f.state.expired = true
    await expect(f.client.revokeKey(1)).rejects.toThrow('登录已失效')
    expect(f.calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(1)
    expect(f.calls.filter((call) => call.url.pathname.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(f.getSavedAccount()?.credential).toMatchObject({ refreshToken: 'rotated-refresh-7' })
    expect(f.state.keys).toHaveLength(1)
  })

  it('finds matching prefix keys across pages and rejects cross-group ambiguity', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    f.state.keys = Array.from({ length: 100 }, (_, index) => keyRecord(index + 1))
    f.state.keys.push(keyRecord(101, { name: 'canvas-image-123' }))
    expect(await f.client.findExistingCliKey('canvas-image-')).toMatchObject({ id: 101 })
    f.state.keys.push(keyRecord(102, { name: 'canvas-image-456', group_id: groups[0].id }))
    await expect(f.client.findExistingCliKey('canvas-image-')).rejects.toThrow('多个分组')
  })

  it('changes password through PUT /user/password and clears invalidated login tokens', async () => {
    const f = fixture()
    await f.client.login(loginInput)
    expect(await f.client.changePassword({ originalPassword: 'old-password', newPassword: 'new-password' })).toEqual({ changed: true })
    expect(f.calls.at(-1)?.url.pathname).toBe('/api/v1/user/password')
    expect(f.calls.at(-1)).toMatchObject({ init: { method: 'PUT' }, body: { old_password: 'old-password', new_password: 'new-password' } })
    expect(f.getSavedAccount()).toBeNull()
    expect(f.onSessionChange).toHaveBeenLastCalledWith(null)
  })
})
