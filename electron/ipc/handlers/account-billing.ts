// 主窗口业务通道的处理器：余额、充值、兑换码、邀请额度、订阅购买，付款页交给独立的支付窗口。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { BrowserWindow } from 'electron'
import {
  PaymentCheckoutRejected,
  toCustomerPaymentError,
  validatePaymentForm,
  validatePaymentQrCode,
  validatePaymentUrl,
} from '../../payment-window'
import { requiredString } from '../parsers/common'
import {
  parseAccountAffiliateTransferInput,
  parseAccountBillingPreference,
  parseAccountSubscriptionPaymentInput,
  parseAccountTopupAmountInput,
  parseAccountTopupOrdersQuery,
  parseAccountTopupPaymentInput,
  parsePositiveSafeInteger,
} from '../parsers/account-billing'
import type { IpcHandlerContext } from './context'

export function registerAccountBillingHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, accountService } = ctx
  registerTrustedHandler('account:get-balance', async () => {
    const balance = await accountService.getBalance()
    options.onAccountBalance?.(balance)
    return balance
  })
  registerTrustedHandler('account:get-topup-info', () => accountService.getTopupInfo())
  registerTrustedHandler('account:quote-topup', (_event, input: unknown) => (
    accountService.quoteTopupAmount(parseAccountTopupAmountInput(input))
  ))
  registerTrustedHandler('account:create-topup-payment', (event, input: unknown) => {
    const parsed = parseAccountTopupPaymentInput(input)
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const revision = accountService.getSessionRevision?.()
    return accountService.createTopupPayment(parsed).then(async (checkout) => {
      if (accountService.getSessionRevision?.() !== revision) throw new Error('账号上下文已变化，请重试')
      // Validate the service result before handing it to the window and before
      // exposing the order number. This keeps the IPC result a strict,
      // renderer-safe DTO even if a backend adapter returns malformed data.
      if (checkout && typeof checkout === 'object' && 'kind' in checkout) {
        if (checkout.kind === 'url') {
          const validated = validatePaymentUrl(checkout.url)
          if (typeof checkout.tradeNo !== 'string' && checkout.tradeNo !== null) throw new PaymentCheckoutRejected('支付订单号格式异常')
          if (checkout.tradeNo && checkout.tradeNo.length > 255) throw new PaymentCheckoutRejected('支付订单号格式异常')
          if (checkout.expiresAt !== null && (typeof checkout.expiresAt !== 'string' || checkout.expiresAt.length > 64 || Number.isNaN(Date.parse(checkout.expiresAt)))) throw new PaymentCheckoutRejected('支付到期时间格式异常')
          await options.paymentWindow.openUrl(validated.url, parent, checkout.tradeNo)
          return { opened: true as const, tradeNo: checkout.tradeNo }
        }
        if (checkout.kind === 'qrcode') {
          const validated = validatePaymentQrCode(checkout)
          if (!options.paymentWindow.openQrCode) throw new PaymentCheckoutRejected('当前版本不支持二维码支付')
          await options.paymentWindow.openQrCode(validated, parent)
          return { opened: true as const, tradeNo: validated.tradeNo }
        }
        throw new PaymentCheckoutRejected('支付结果类型不支持')
      }
      const validated = validatePaymentForm(checkout)
      await options.paymentWindow.open(checkout, parent)
      return { opened: true as const, tradeNo: validated.tradeNo }
    }).catch((error: unknown) => { throw toCustomerPaymentError(error) })
  })
  registerTrustedHandler('account:close-payment-window', () => {
    // 和点支付窗口右上角的 × 一样：付过款的订单在后台接着确认到账。
    // destroy() 会把这份确认一起停掉，只留给换账号、退出这类场合。
    options.paymentWindow.close()
  })
  registerTrustedHandler('account:list-topup-orders', (_event, input: unknown) => (
    accountService.listTopupOrders(parseAccountTopupOrdersQuery(input))
  ))
  registerTrustedHandler('account:redeem-topup-code', (_event, code: unknown) => (
    accountService.redeemTopupCode(requiredString(code, '兑换码', 256))
  ))
  registerTrustedHandler('account:transfer-affiliate-quota', (_event, input: unknown) => (
    accountService.transferAffiliateQuota(parseAccountAffiliateTransferInput(input))
  ))
  registerTrustedHandler('account:list-subscription-plans', () => accountService.listSubscriptionPlans())
  registerTrustedHandler('account:get-subscription-self', async () => {
    const subscription = await accountService.getSubscriptionSelf()
    options.onAccountSubscription?.(subscription)
    return subscription
  })
  registerTrustedHandler('account:update-subscription-preference', (_event, preference: unknown) => (
    accountService.updateSubscriptionPreference(parseAccountBillingPreference(preference))
  ))
  registerTrustedHandler('account:create-subscription-payment', (event, input: unknown) => {
    const parsed = parseAccountSubscriptionPaymentInput(input)
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return accountService.createSubscriptionPayment(parsed).then(async (checkout) => {
      if (checkout.kind === 'form') await options.paymentWindow.open(checkout.form, parent)
      else if (checkout.kind === 'qrcode') {
        // 同充值那条：二维码内容先按白名单校验，再交给支付窗口。
        const validated = validatePaymentQrCode(checkout)
        if (!options.paymentWindow.openQrCode) throw new PaymentCheckoutRejected('当前版本不支持二维码支付')
        await options.paymentWindow.openQrCode(validated, parent)
      } else await options.paymentWindow.openUrl(checkout.url, parent, checkout.tradeNo)
      return {
        opened: true as const,
        tradeNo: checkout.tradeNo,
        expiresAt: checkout.expiresAt,
      }
    }).catch((error: unknown) => { throw toCustomerPaymentError(error) })
  })
  registerTrustedHandler('account:purchase-subscription-balance', (_event, planId: unknown) => (
    accountService.purchaseSubscriptionWithBalance(parsePositiveSafeInteger(planId, '订阅方案 ID'))
  ))
}
