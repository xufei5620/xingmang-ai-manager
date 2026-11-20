import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { InvoiceOrder, InvoiceOrdersSnapshot, InvoiceRequest } from '../../../../electron/ipc-contract'
import {
  buildInvoiceProfileData,
  canWithdrawInvoice,
  defaultInvoiceProfileChoice,
  emptyInvoiceProfileDraft,
  invoiceableOrders,
  invoiceFootnote,
  invoiceMoreFieldsLabel,
  invoiceNumberSuffix,
  invoiceOrderLabel,
  invoiceProfileDraftComplete,
  invoiceProfileLabel,
  invoiceRequestState,
  invoiceReviewNote,
  invoiceRowAction,
  invoiceSelectionText,
  invoiceShortfallText,
  invoiceSubmitFailed,
  invoiceSubmittedText,
  invoiceWithdrawFailed,
  newInvoiceProfile,
  rememberIdempotencyKey,
  sumMinor,
  yuanText,
} from './invoice'

function order(overrides: Partial<InvoiceOrder> = {}): InvoiceOrder {
  return {
    originRef: 'newapi:top_up:2',
    kind: 'topup',
    accountOrderId: 2,
    availableMinor: '30000',
    heldMinor: '0',
    issuedMinor: '0',
    currency: 'CNY',
    occurredAt: '2026-11-16T08:00:00.000Z',
    ...overrides,
  }
}

function request(overrides: Partial<InvoiceRequest> = {}): InvoiceRequest {
  return {
    requestId: '22222222-2222-4222-8222-222222222222',
    status: 'issued',
    revision: 1,
    amountMinor: '30000',
    currency: 'CNY',
    title: '杭州某某科技有限公司',
    createdAt: '2026-11-06T06:20:00.000Z',
    reason: '',
    invoiceNumber: null,
    lines: [{ originRef: 'newapi:top_up:2', amountMinor: '30000', excluded: false }],
    ...overrides,
  }
}

function snapshot(orders: InvoiceOrder[], minimumRequestMinor = '20000'): InvoiceOrdersSnapshot {
  return { orders, minimumRequestMinor }
}

describe('invoice amounts', () => {
  it('writes minor units as yuan with two decimals without going through floating point', () => {
    expect(yuanText('30000')).toBe('¥300.00')
    expect(yuanText('9905')).toBe('¥99.05')
    expect(yuanText('7')).toBe('¥0.07')
    expect(yuanText('0')).toBe('¥0.00')
    expect(yuanText('9223372036854775807')).toBe('¥92233720368547758.07')
    expect(yuanText('not-a-number')).toBe('¥0.00')
    expect(sumMinor(['30000', '9900', '1'])).toBe('39901')
    expect(sumMinor([])).toBe('0')
  })

  it('round-trips any amount the invoice system can send with random inputs', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 9223372036854775807n }), (value) => {
      const text = yuanText(value.toString())
      const [whole, cents] = text.slice(1).split('.')
      expect(BigInt(whole) * 100n + BigInt(cents)).toBe(value)
      expect(cents).toHaveLength(2)
    }))
  })

  it('says how much more to tick only while the selection is below the minimum', () => {
    expect(invoiceSelectionText(1, '30000')).toBe('已选 1 笔，合计 ¥300.00')
    expect(invoiceShortfallText('10000', '20000')).toBe('每次至少开 ¥200.00，还差 ¥100.00，可以再勾几笔。')
    expect(invoiceShortfallText('20000', '20000')).toBeNull()
    expect(invoiceShortfallText('30000', '20000')).toBeNull()
    // The invoice system may set no minimum at all.
    expect(invoiceShortfallText('100', '0')).toBeNull()
  })
})

describe('invoice orders', () => {
  it('lists only CNY orders with something left to invoice, newest first', () => {
    const list = invoiceableOrders(snapshot([
      order({ originRef: 'newapi:top_up:1', occurredAt: '2026-11-01T00:00:00.000Z' }),
      order({ originRef: 'newapi:top_up:3', occurredAt: '2026-11-18T00:00:00.000Z' }),
      order({ originRef: 'newapi:top_up:4', availableMinor: '0', heldMinor: '30000' }),
      order({ originRef: 'newapi:top_up:5', currency: 'USD' }),
      order({ originRef: 'newapi:subscription_order:9', kind: 'subscription', accountOrderId: null, occurredAt: '2026-11-10T00:00:00.000Z' }),
    ]))
    expect(list.map((entry) => entry.originRef)).toEqual(['newapi:top_up:3', 'newapi:subscription_order:9', 'newapi:top_up:1'])
    expect(invoiceableOrders(null)).toEqual([])
  })

  it('labels each order with its day and whether it was a top-up or a subscription', () => {
    const now = new Date(2026, 10, 20)
    expect(invoiceOrderLabel(order({ occurredAt: new Date(2026, 10, 16, 9).toISOString() }), now)).toBe('11月16日　充值')
    expect(invoiceOrderLabel(order({ kind: 'subscription', occurredAt: new Date(2026, 10, 5, 9).toISOString() }), now)).toBe('11月5日　订阅')
    // Admin adjustments and manual records also put money on the balance.
    expect(invoiceOrderLabel(order({ kind: 'other', occurredAt: new Date(2025, 0, 2, 9).toISOString() }), now)).toBe('2025年1月2日　充值')
  })
})

describe('invoiceRowAction', () => {
  it('offers an invoice while the order still has something to invoice', () => {
    const entry = order()
    expect(invoiceRowAction(2, snapshot([entry]), [])).toEqual({ kind: 'apply', order: entry })
  })

  it('says the order is being invoiced while a request holds it', () => {
    expect(invoiceRowAction(2, snapshot([order({ availableMinor: '0', heldMinor: '30000' })]), [])).toEqual({ kind: 'pending' })
  })

  it('offers the download only for an issued request that still covers this order', () => {
    const issued = snapshot([order({ availableMinor: '0', issuedMinor: '30000' })])
    expect(invoiceRowAction(2, issued, [request()])).toEqual({ kind: 'download', requestId: request().requestId })
    expect(invoiceRowAction(2, issued, [request({ status: 'voided' })])).toBeNull()
    expect(invoiceRowAction(2, issued, [request({ lines: [{ originRef: 'newapi:top_up:2', amountMinor: '30000', excluded: true }] })])).toBeNull()
    // Older than the first page of records: nothing to download from the row.
    expect(invoiceRowAction(2, issued, [])).toBeNull()
  })

  it('maps only top-up rows, never a subscription order that happens to share the number', () => {
    // A 星芒 「开通订阅」 row in 我的订单 carries a top-up number; the invoice system's subscription
    // orders are numbered separately, so the same digits are a different order.
    const subscription = order({ originRef: 'newapi:subscription_order:2', kind: 'subscription', accountOrderId: null })
    expect(invoiceRowAction(2, snapshot([subscription]), [])).toBeNull()
    expect(invoiceRowAction(2, snapshot([order({ kind: 'other', accountOrderId: null })]), [])).toBeNull()
    expect(invoiceRowAction(3, snapshot([order()]), [])).toBeNull()
    expect(invoiceRowAction(2, null, [])).toBeNull()
  })

  it('shows nothing for a foreign-currency order or one with nothing left', () => {
    expect(invoiceRowAction(2, snapshot([order({ currency: 'USD' })]), [])).toBeNull()
    expect(invoiceRowAction(2, snapshot([order({ availableMinor: '0' })]), [])).toBeNull()
  })
})

describe('invoice records', () => {
  it('names every status the invoice system documents and never shows an unknown one in English', () => {
    expect(['pending_review', 'approved', 'needs_changes', 'rejected', 'withdrawn', 'issued', 'voided', 'credit_noted'].map((status) => invoiceRequestState(status).label))
      .toEqual(['待审核', '待开具', '待修改', '已驳回', '已撤回', '已开具', '已作废', '已红冲'])
    expect(invoiceRequestState('archived')).toEqual({ label: '待确认', tone: 'neutral' })
    expect(invoiceRequestState('toString').label).toBe('待确认')
  })

  it('allows withdrawing only what has not been issued yet', () => {
    expect(canWithdrawInvoice({ status: 'pending_review' })).toBe(true)
    expect(canWithdrawInvoice({ status: 'approved' })).toBe(true)
    for (const status of ['needs_changes', 'rejected', 'withdrawn', 'issued', 'voided', 'credit_noted', 'unknown']) {
      expect(canWithdrawInvoice({ status })).toBe(false)
    }
  })

  it('shows the finance note only on a returned or rejected request', () => {
    expect(invoiceReviewNote({ status: 'rejected', reason: ' 抬头写错了 ' })).toBe('财务说明：抬头写错了')
    expect(invoiceReviewNote({ status: 'needs_changes', reason: '税号少一位' })).toBe('财务说明：税号少一位')
    expect(invoiceReviewNote({ status: 'rejected', reason: '' })).toBeNull()
    expect(invoiceReviewNote({ status: 'issued', reason: '备注' })).toBeNull()
    expect(invoiceNumberSuffix({ invoiceNumber: '24332000000012345678' })).toBe('，发票号码 24332000000012345678')
    expect(invoiceNumberSuffix({ invoiceNumber: null })).toBe('')
  })
})

describe('invoice profiles', () => {
  it('picks the first saved title and falls back to a new one', () => {
    const profile = { profileId: '11111111-1111-4111-8111-111111111111', data: { kind: 'business' as const, title: '杭州某某科技有限公司', taxId: 'X', email: 'a@example.com' } }
    expect(defaultInvoiceProfileChoice([profile])).toBe(profile.profileId)
    expect(defaultInvoiceProfileChoice([])).toBe(newInvoiceProfile)
    expect(invoiceProfileLabel(profile)).toBe('杭州某某科技有限公司（单位）')
    expect(invoiceProfileLabel({ ...profile, data: { ...profile.data, kind: 'personal' } })).toBe('杭州某某科技有限公司（个人）')
  })

  it('needs a title and an email, and a tax number for a business', () => {
    const business = { ...emptyInvoiceProfileDraft, kind: 'business' as const, title: '某某公司', email: 'f@example.com' }
    expect(invoiceProfileDraftComplete(business)).toBe(false)
    expect(invoiceProfileDraftComplete({ ...business, taxId: '91330100MA2XXXXXXX' })).toBe(true)
    expect(invoiceProfileDraftComplete({ ...business, kind: 'personal' })).toBe(true)
    expect(invoiceProfileDraftComplete({ ...business, kind: 'personal', title: '   ' })).toBe(false)
  })

  it('sends trimmed fields and leaves the optional ones out when empty', () => {
    expect(buildInvoiceProfileData({ ...emptyInvoiceProfileDraft, title: ' 某某公司 ', taxId: ' 913301 ', email: ' f@example.com ', phone: ' 0571-1 ', address: '  ' }))
      .toEqual({ kind: 'business', title: '某某公司', taxId: '913301', email: 'f@example.com', phone: '0571-1' })
  })
})

describe('rememberIdempotencyKey', () => {
  it('reuses the key for the same content and makes a new one once the content changes', () => {
    let next = 0
    const create = () => `key-${++next}`
    const first = rememberIdempotencyKey(null, 'a', create)
    expect(rememberIdempotencyKey(first, 'a', create)).toBe(first)
    expect(rememberIdempotencyKey(first, 'b', create)).toEqual({ signature: 'b', key: 'key-2' })
  })
})

describe('invoice wording', () => {
  it('keeps the approved lines word for word', () => {
    expect(invoiceSubmittedText).toBe('已提交开票申请，财务审核后开具。')
    expect(invoiceSubmitFailed).toBe('没提交成功，请稍后再试；还不行请找客服。')
    expect(invoiceWithdrawFailed).toBe('没撤回成功，请稍后再试；还不行请找客服。')
    expect(invoiceFootnote).toBe('只开人民币普通发票。财务审核后开具，开好以后在「开票记录」里下载。')
    expect(invoiceMoreFieldsLabel).toBe('更多（选填）：地址、电话、开户银行、银行账号')
  })
})
