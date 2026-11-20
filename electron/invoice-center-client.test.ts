import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import {
  buildInvoiceSaveName,
  classifyInvoiceOriginRef,
  createInvoiceCenterClient,
  invoiceCenterNoReason,
  parseAttachmentName,
  parseInvoiceOrdersSnapshot,
  parseInvoiceRequestsPage,
  resolveInvoiceCenterOrigin,
  resolveInvoiceDocumentType,
  type InvoiceCenterAccount,
  type InvoiceCenterClientOptions,
} from './invoice-center-client'
import type { InvoiceAccountCredential } from './relay-backend'
import { requireRelaySite } from './relay-sites'

const xm: InvoiceCenterAccount = { siteId: 'solov', userId: 42 }
const history: InvoiceCenterAccount = { siteId: 'solov-api', userId: 7 }
const startedAt = Date.parse('2026-11-20T10:00:00Z')
const desktopToken = 'd'.repeat(43)
const requestId = '22222222-2222-4222-8222-222222222222'

interface Recorded {
  url: string
  init: RequestInit
  headers: Record<string, string>
  body: unknown
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

function session(account: InvoiceCenterAccount, token = desktopToken, expiresAt = startedAt + 12 * 60 * 60 * 1000): Response {
  return json({
    token,
    expires_at: new Date(expiresAt).toISOString(),
    platform: account.siteId === 'solov' ? 'newapi' : 'sub2api',
    user: { platform_user_id: String(account.userId), display_name: '张三' },
  })
}

function order(originRef: string, available = '30000'): Record<string, unknown> {
  return {
    origin_ref: originRef, cash_minor: available, approved_admin_minor: '0', excluded_admin_minor: '0', refund_minor: '0',
    held_minor: '0', issued_minor: '0', available_minor: available, currency: 'CNY', occurred_at: '2026-11-18T08:00:00Z',
    fund_natures: ['CASH_TOPUP'], status: 'available', refund_attention: false,
  }
}

function wireRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: requestId, customer_ref: 'source:x:user:42', source_instance_id: '33333333-3333-4333-8333-333333333333', external_user_id: '42',
    profile_snapshot: { profile_kind: 'business', title: '某某科技有限公司', tax_id: '91330100MA2XXXXXXX', email: 'f@example.com' },
    invoice_type: 'normal', amount_minor: '30000', currency: 'CNY', status: 'pending_review', revision: 1, reason: '',
    lines: [{ origin_ref: 'newapi:top_up:1041', amount_minor: '30000', credit_minor: '0' }], credit_noted_minor: '0',
    created_at: '2026-11-20T09:00:00Z', updated_at: '2026-11-20T09:00:00Z', ...overrides,
  }
}

function setup(options: {
  account?: () => InvoiceCenterAccount | null
  responses?: Array<Response | ((call: Recorded) => Response | Promise<Response>)>
  lend?: InvoiceCenterClientOptions['lendCredential']
  credential?: InvoiceAccountCredential
} = {}) {
  let now = startedAt
  const calls: Recorded[] = []
  const queue = [...(options.responses ?? [])]
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = { ...(init.headers as Record<string, string>) }
    const call = { url: String(input), init, headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const next = queue.shift()
    if (!next) throw new TypeError(`unexpected request in tests: ${call.init.method} ${call.url}`)
    return typeof next === 'function' ? next(call) : next
  })
  const credential = options.credential ?? { accessToken: 'account-access-token', userId: '42' }
  async function lendOnce<T>(exchange: (value: InvoiceAccountCredential) => Promise<T | null>): Promise<T | null> {
    return exchange(credential)
  }
  const lend = options.lend ?? lendOnce
  // vi.fn drops the generic signature, so the spy records calls and the client gets the typed wrapper.
  const lendCredential = vi.fn((exchange: (value: InvoiceAccountCredential) => Promise<unknown>) => lend(exchange))
  const log = vi.fn()
  let account = options.account ?? (() => xm)
  const client = createInvoiceCenterClient({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    currentAccount: () => account(),
    lendCredential: <T>(exchange: (value: InvoiceAccountCredential) => Promise<T | null>) => lendCredential(exchange) as Promise<T | null>,
    now: () => now,
    log,
  })
  return {
    client,
    calls,
    fetchImpl,
    lendCredential,
    log,
    queue,
    advance: (ms: number) => { now += ms },
    switchAccount: (next: () => InvoiceCenterAccount | null) => { account = next },
  }
}

describe('invoice center origins', () => {
  it('derives each site invoice center from relay-sites and nothing else', () => {
    expect(resolveInvoiceCenterOrigin('solov')).toBe('https://invoice-xm.solov.cc')
    expect(resolveInvoiceCenterOrigin('solov-api')).toBe('https://invoice-api.solov.cc')
    expect(resolveInvoiceCenterOrigin('custom')).toBeNull()
    expect(requireRelaySite('solov').invoiceOrigin).toBe(resolveInvoiceCenterOrigin('solov'))
  })
})

describe('invoice order numbers', () => {
  it('matches the account order list only for the three stable formats of the signed-in site', () => {
    expect(classifyInvoiceOriginRef('newapi:top_up:1041', 'solov')).toEqual({ kind: 'topup', accountOrderId: 1041 })
    expect(classifyInvoiceOriginRef('newapi:subscription_order:12', 'solov')).toEqual({ kind: 'subscription', accountOrderId: null })
    expect(classifyInvoiceOriginRef('sub2api:payment_order:77', 'solov-api')).toEqual({ kind: 'topup', accountOrderId: 77 })
    // Another site's numbers never match a row here, and neither do the kinds without an order row.
    expect(classifyInvoiceOriginRef('sub2api:payment_order:77', 'solov')).toEqual({ kind: 'other', accountOrderId: null })
    expect(classifyInvoiceOriginRef('newapi:top_up:1041', 'solov-api')).toEqual({ kind: 'other', accountOrderId: null })
    for (const ref of ['newapi:admin_adjust:5', 'sub2api:admin_balance:5', 'manual:44444444-4444-4444-8444-444444444444', 'newapi:top_up:007', 'newapi:top_up:', 'newapi:future_kind:3']) {
      expect(classifyInvoiceOriginRef(ref, 'solov').accountOrderId).toBeNull()
      expect(classifyInvoiceOriginRef(ref, 'solov-api').accountOrderId).toBeNull()
    }
  })
})

describe('invoice center responses', () => {
  it('keeps amounts as integer strings and refuses anything that is not', () => {
    const snapshot = parseInvoiceOrdersSnapshot({ orders: [order('newapi:top_up:1041', '9223372036854775807')], minimum_request_minor: '20000' }, 'solov')
    expect(snapshot).toEqual({
      minimumRequestMinor: '20000',
      orders: [{ originRef: 'newapi:top_up:1041', kind: 'topup', accountOrderId: 1041, availableMinor: '9223372036854775807', heldMinor: '0', issuedMinor: '0', currency: 'CNY', occurredAt: '2026-11-18T08:00:00Z' }],
    })
    expect(parseInvoiceOrdersSnapshot({ orders: null, minimum_request_minor: '20000' }, 'solov').orders).toEqual([])
    for (const bad of [30000, '300.00', '9223372036854775808', '01']) {
      expect(() => parseInvoiceOrdersSnapshot({ orders: [order('newapi:top_up:1', bad as string)], minimum_request_minor: '20000' }, 'solov')).toThrow(invoiceCenterNoReason)
    }
    expect(() => parseInvoiceOrdersSnapshot({ orders: [], minimum_request_minor: '0' }, 'solov')).toThrow(invoiceCenterNoReason)
  })

  it('hands the renderer only what the invoice records show, without customer or source identifiers', () => {
    const page = parseInvoiceRequestsPage({ requests: [wireRequest({ status: 'issued', invoice_number: '24332000000012345678' })], next_cursor: '' })
    expect(page).toEqual({
      nextCursor: null,
      requests: [{
        requestId, status: 'issued', revision: 1, amountMinor: '30000', currency: 'CNY', title: '某某科技有限公司', createdAt: '2026-11-20T09:00:00Z',
        reason: '', invoiceNumber: '24332000000012345678', lines: [{ originRef: 'newapi:top_up:1041', amountMinor: '30000', excluded: false }],
      }],
    })
    expect(JSON.stringify(page)).not.toContain('source:x:user:42')
    expect(() => parseInvoiceRequestsPage({ requests: [wireRequest({ request_id: '../../x' })], next_cursor: '' })).toThrow(invoiceCenterNoReason)
  })

  it('recognises invoice files by their first bytes and washes the suggested name', () => {
    expect(resolveInvoiceDocumentType(Buffer.from('%PDF-1.7'))).toBe('pdf')
    expect(resolveInvoiceDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png')
    expect(resolveInvoiceDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(resolveInvoiceDocumentType(Buffer.from('<html>'))).toBeNull()
    expect(buildInvoiceSaveName('..\\..\\invoice-1.exe', 'pdf')).toBe('invoice-1.pdf')
    expect(buildInvoiceSaveName('', 'jpeg')).toBe('invoice.jpg')
    expect(parseAttachmentName('attachment; filename="invoice-22222222.pdf"')).toBe('invoice-22222222.pdf')
    expect(parseAttachmentName(null)).toBe('')
  })
})

describe('createInvoiceCenterClient', () => {
  it('exchanges the account login once, then calls the desktop routes with the desktop token only', async () => {
    const { client, calls, lendCredential } = setup({ responses: [
      session(xm),
      json({ orders: [order('newapi:top_up:1041')], minimum_request_minor: '20000' }),
      json({ profiles: [] }),
    ] })

    await expect(client.listOrders()).resolves.toMatchObject({ minimumRequestMinor: '20000', orders: [{ accountOrderId: 1041 }] })
    await expect(client.listProfiles()).resolves.toEqual([])

    expect(lendCredential).toHaveBeenCalledOnce()
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://invoice-xm.solov.cc/invoice-api/v1/desktop/session',
      'GET https://invoice-xm.solov.cc/invoice-api/v1/desktop/invoices/customer/orders',
      'GET https://invoice-xm.solov.cc/invoice-api/v1/desktop/invoices/customer/profiles',
    ])
    expect(calls[0]!.body).toEqual({ access_token: 'account-access-token', user_id: '42' })
    for (const call of calls) {
      // A Cookie or an Origin is what makes the invoice center treat a request as a browser.
      expect(Object.keys(call.headers).map((name) => name.toLowerCase())).not.toContain('cookie')
      expect(Object.keys(call.headers).map((name) => name.toLowerCase())).not.toContain('origin')
      expect(call.init.credentials).toBe('omit')
      expect(call.init.redirect).toBe('manual')
    }
    expect(calls[0]!.headers.Authorization).toBeUndefined()
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${desktopToken}`)
    expect(calls[2]!.headers.Authorization).toBe(`Bearer ${desktopToken}`)
  })

  it('leaves the user id out for a history account, whose service reads it from the token', async () => {
    const { client, calls } = setup({
      account: () => history,
      credential: { accessToken: 'history-access-token' },
      responses: [session(history), json({ profiles: [] })],
    })

    await client.listProfiles()

    expect(calls[0]!.url).toBe('https://invoice-api.solov.cc/invoice-api/v1/desktop/session')
    expect(calls[0]!.body).toEqual({ access_token: 'history-access-token' })
  })

  it('tells the account it lent a token the invoice center could not verify, so the account can renew it once', async () => {
    const answers: Array<string | null> = []
    const { client } = setup({
      responses: [failure(401, 'DESKTOP_CREDENTIAL_REJECTED', '登录信息已失效，请重新登录'), session(xm), json({ profiles: [] })],
      lend: async (exchange) => {
        const first = await exchange({ accessToken: 'expired', userId: '42' })
        answers.push(first === null ? null : 'token')
        const second = await exchange({ accessToken: 'renewed', userId: '42' })
        answers.push(second === null ? null : 'token')
        return second
      },
    })

    await client.listProfiles()
    expect(answers).toEqual([null, 'token'])
  })

  it('reports the invoice center own words when it still refuses the renewed login', async () => {
    const { client } = setup({ responses: [failure(401, 'DESKTOP_CREDENTIAL_REJECTED', '登录信息已失效，请重新登录')] })

    await expect(client.listOrders()).rejects.toMatchObject({ message: '登录信息已失效，请重新登录', code: 'DESKTOP_CREDENTIAL_REJECTED' })
  })

  it('refuses a desktop token issued for anyone but the signed-in account', async () => {
    const { client } = setup({ responses: [session({ siteId: 'solov', userId: 43 })] })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('exchanges again once and retries once when the desktop token went stale', async () => {
    const { client, calls, lendCredential } = setup({ responses: [
      session(xm, 'a'.repeat(43)),
      failure(401, 'DESKTOP_SESSION_INVALID', '登录状态已失效，请重新登录'),
      session(xm, 'b'.repeat(43)),
      json({ profiles: [] }),
    ] })

    await expect(client.listProfiles()).resolves.toEqual([])

    expect(lendCredential).toHaveBeenCalledTimes(2)
    expect(calls[3]!.headers.Authorization).toBe(`Bearer ${'b'.repeat(43)}`)
  })

  it('gives up after the second stale-token answer instead of looping', async () => {
    const { client, calls } = setup({ responses: [
      session(xm),
      failure(401, 'DESKTOP_SESSION_INVALID', '登录状态已失效，请重新登录'),
      session(xm),
      failure(401, 'DESKTOP_SESSION_INVALID', '登录状态已失效，请重新登录'),
    ] })

    await expect(client.listProfiles()).rejects.toMatchObject({ code: 'DESKTOP_SESSION_INVALID', message: '登录状态已失效，请重新登录' })
    expect(calls).toHaveLength(4)
  })

  it('does not exchange again when the invoice center only cannot check the login right now', async () => {
    const { client, lendCredential } = setup({ responses: [session(xm), failure(503, 'SESSION_CHECK_UNAVAILABLE', '登录状态暂时无法确认，请稍后重试')] })

    await expect(client.listProfiles()).rejects.toMatchObject({ code: 'SESSION_CHECK_UNAVAILABLE', message: '登录状态暂时无法确认，请稍后重试' })
    expect(lendCredential).toHaveBeenCalledOnce()
  })

  it('renews a token that has been idle long enough for the invoice center to drop it', async () => {
    const { client, calls, lendCredential, advance } = setup({ responses: [
      session(xm),
      json({ profiles: [] }),
      json({ ok: true }),
      session(xm, 'c'.repeat(43)),
      json({ profiles: [] }),
    ] })

    await client.listProfiles()
    advance(26 * 60 * 1000)
    await client.listProfiles()

    expect(lendCredential).toHaveBeenCalledTimes(2)
    expect(calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(1)
  })

  it('drops and revokes the previous account desktop token when someone else signs in', async () => {
    const { client, calls, switchAccount } = setup({ responses: [
      session(xm, 'a'.repeat(43)),
      json({ profiles: [] }),
      json({ ok: true }),
      session(history, 'b'.repeat(43)),
      json({ profiles: [] }),
    ] })

    await client.listProfiles()
    switchAccount(() => history)
    client.setAccount(history)
    await client.listProfiles()

    const revoke = calls.find((call) => call.init.method === 'DELETE')!
    expect(revoke.url).toBe('https://invoice-xm.solov.cc/invoice-api/v1/desktop/session')
    expect(revoke.headers.Authorization).toBe(`Bearer ${'a'.repeat(43)}`)
    expect(calls.at(-1)!.url).toBe('https://invoice-api.solov.cc/invoice-api/v1/desktop/invoices/customer/profiles')
    expect(calls.at(-1)!.headers.Authorization).toBe(`Bearer ${'b'.repeat(43)}`)
  })

  it('throws away a desktop token that arrives after the customer signed out', async () => {
    let release: () => void = () => undefined
    const { client, calls } = setup({ responses: [
      () => new Promise<Response>((resolve) => { release = () => resolve(session(xm)) }),
      json({ ok: true }),
    ] })

    const pending = client.listProfiles()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    client.setAccount(null)
    release()

    await expect(pending).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    await vi.waitFor(() => expect(calls.at(-1)!.init.method).toBe('DELETE'))
  })

  it('refuses to work for nobody', async () => {
    const { client, fetchImpl } = setup({ account: () => null })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'SIGNED_OUT' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('submits with the currency the main process fixes and the idempotency key the renderer chose', async () => {
    const { client, calls } = setup({ responses: [session(xm), json({ run_id: 'desktop-1', value: { request: wireRequest(), replayed: false, refresh_attempted: false, refresh_succeeded: false } })] })
    const key = '55555555-5555-4555-8555-555555555555'

    await expect(client.submitRequest({ idempotencyKey: key, profileId: '11111111-1111-4111-8111-111111111111', originRefs: ['newapi:top_up:1041'], amountsMinor: ['30000'] }))
      .resolves.toMatchObject({ requestId, status: 'pending_review', revision: 1 })

    expect(calls[1]!.body).toEqual({ action_id: 'invoices.request.submit', params: {
      profile_id: '11111111-1111-4111-8111-111111111111', currency: 'CNY', origin_refs: ['newapi:top_up:1041'], amounts_minor: ['30000'], idempotency_key: key,
    } })
  })

  it('passes along the invoice center reason for a refused action, and only a short single line', async () => {
    const { client } = setup({ responses: [
      session(xm),
      failure(400, 'INVALID_PARAMS', '申请金额必须等于订单可开票金额'),
      failure(400, 'INVALID_PARAMS', `第一行\n第二行`),
    ] })
    const input = { idempotencyKey: '55555555-5555-4555-8555-555555555555', requestId, expectedRevision: 1 }

    await expect(client.withdrawRequest(input)).rejects.toMatchObject({ message: '申请金额必须等于订单可开票金额', status: 400 })
    await expect(client.withdrawRequest(input)).rejects.toMatchObject({ message: invoiceCenterNoReason, status: 400 })
  })

  it('treats the web container rate limit page as a refusal without a reason', async () => {
    const { client } = setup({ responses: [session(xm), new Response('<html>429 Too Many Requests</html>', { status: 429, headers: { 'Content-Type': 'text/html' } })] })

    await expect(client.listOrders()).rejects.toMatchObject({ message: invoiceCenterNoReason, code: 'HTTP_429', status: 429 })
  })

  it('refuses a redirect instead of following it with the token', async () => {
    const { client } = setup({ responses: [session(xm), new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })] })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'REDIRECTED' })
  })

  it('stops reading an answer larger than any real order list', async () => {
    const huge = new Response('x', { status: 200, headers: { 'Content-Length': String(64 * 1024 * 1024) } })
    const { client } = setup({ responses: [session(xm), huge] })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })

  it('downloads only a real invoice file for a well-formed request id', async () => {
    const { client, calls, fetchImpl } = setup({ responses: [
      session(xm),
      new Response(Buffer.from('%PDF-1.7 test'), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="invoice-2222.pdf"' } }),
      new Response('<html>not an invoice</html>', { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    ] })

    await expect(client.downloadDocument(requestId)).resolves.toMatchObject({ type: 'pdf', suggestedName: 'invoice-2222.pdf' })
    expect(calls[1]!.url).toBe(`https://invoice-xm.solov.cc/invoice-api/v1/desktop/invoices/customer/requests/${requestId}/document`)
    await expect(client.downloadDocument(requestId)).rejects.toMatchObject({ code: 'NOT_A_DOCUMENT' })
    await expect(client.downloadDocument('../../session')).rejects.toMatchObject({ code: 'INVALID_REQUEST_ID' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  // The account access token rides only in the one exchange request body: never
  // in a header, a URL, an error the renderer sees, or a log line.
  it('keeps the account access token out of every error and log line, with random inputs', async () => {
    await fc.assert(fc.asyncProperty(
      fc.stringMatching(/^[A-Za-z0-9._-]{8,64}$/),
      fc.constantFrom(
        () => failure(401, 'DESKTOP_CREDENTIAL_REJECTED', '登录信息已失效，请重新登录'),
        () => failure(503, 'DESKTOP_UPSTREAM_UNAVAILABLE', '暂时无法确认账号，请稍后重试'),
        () => failure(429, 'DESKTOP_SESSION_RATE_LIMITED', '操作太频繁，请稍后再试'),
        () => new Response('upstream said no', { status: 502 }),
        () => json({ token: 'short' }),
      ),
      async (accessToken, answer) => {
        const { client, calls, log } = setup({ credential: { accessToken, userId: '42' }, responses: [answer()] })
        const error = await client.listOrders().then(() => null, (caught: unknown) => caught as Error)
        expect(error).not.toBeNull()
        expect(`${error!.message} ${String(error!.stack)} ${JSON.stringify(error)}`).not.toContain(accessToken)
        expect(JSON.stringify(log.mock.calls)).not.toContain(accessToken)
        expect(calls[0]!.url).not.toContain(accessToken)
        expect(JSON.stringify(calls[0]!.headers)).not.toContain(accessToken)
      },
    ), { numRuns: 60 })
  })
})
