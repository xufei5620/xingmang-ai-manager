import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { V2Bridge } from '../../types'
import type { InvoiceOrder } from '../../../../electron/ipc-contract'
import { InvoiceApplyDialog, InvoiceRowControl } from './AccountInvoice'

const order: InvoiceOrder = {
  originRef: 'newapi:top_up:2',
  kind: 'topup',
  accountOrderId: 2,
  availableMinor: '10000',
  heldMinor: '0',
  issuedMinor: '0',
  currency: 'CNY',
  occurredAt: '2026-11-16T08:00:00.000Z',
}

function row(action: Parameters<typeof InvoiceRowControl>[0]['action'], downloading: string | null = null) {
  return renderToStaticMarkup(
    <InvoiceRowControl action={action} orderId={2} downloading={downloading} onApply={vi.fn()} onDownload={vi.fn()} />,
  )
}

describe('InvoiceRowControl', () => {
  it('puts the approved control after each order and nothing when the order cannot be invoiced', () => {
    expect(row({ kind: 'apply', order })).toContain('开发票')
    expect(row({ kind: 'apply', order })).toContain('data-testid="account-order-invoice-2"')
    expect(row({ kind: 'pending' })).toContain('>开票中<')
    expect(row({ kind: 'download', requestId: 'r1' })).toContain('下载发票')
    expect(row(null)).toBe('')
  })

  it('keeps every download button still while one invoice is being fetched', () => {
    expect(row({ kind: 'download', requestId: 'r1' }, 'r2')).toMatch(/<button[^>]*disabled/)
  })
})

describe('InvoiceApplyDialog', () => {
  it('ticks the order it was opened from and holds submission until the minimum is met', () => {
    const api = { getAccountInvoiceProfiles: vi.fn(() => new Promise(() => undefined)) } as unknown as V2Bridge
    const markup = renderToStaticMarkup(
      <InvoiceApplyDialog
        api={api}
        snapshot={{
          minimumRequestMinor: '20000',
          orders: [order, { ...order, originRef: 'newapi:subscription_order:5', kind: 'subscription', accountOrderId: null, availableMinor: '9900' }],
        }}
        initialOriginRef="newapi:top_up:2"
        onClose={vi.fn()}
        onSubmitted={vi.fn()}
      />,
    )
    expect(markup).toContain('开哪几笔')
    expect(markup).toContain('已选 1 笔，合计 ¥100.00')
    expect(markup).toContain('每次至少开 ¥200.00，还差 ¥100.00，可以再勾几笔。')
    expect(markup).toContain('只开人民币普通发票。财务审核后开具，开好以后在「开票记录」里下载。')
    expect(markup.match(/type="checkbox"[^>]*checked/g)).toHaveLength(1)
    expect(markup).toMatch(/<button[^>]*data-testid="account-invoice-apply-submit"[^>]*disabled|<button[^>]*disabled[^>]*data-testid="account-invoice-apply-submit"/)
  })
})
