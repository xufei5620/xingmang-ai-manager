/**
 * 充值方式开关（service-status.ts 的 paymentMethodsOff）：某种付款方式在软件里出了事、还没发版修好时，
 * 先在充值页把它藏掉，客户换另一种付。只藏软件里的，站上和网站都不动。
 *
 * 藏在主进程：充值页、买套餐弹窗拿到的付款方式列表里就没有它，渲染层不用知道有这个开关。页面开着时
 * 开关才打开的，列表里还摆着它，客户点下去时在这里拦住，不让他再走进那条坏掉的路。
 */
export const paymentMethodOffMessage = '这种付款方式暂时停用了，请换一种付款方式。'

function isHidden(type: string, hidden: readonly string[]): boolean {
  return hidden.includes(type.trim().toLowerCase())
}

/** 付款方式列表去掉藏起来的那几种；没有要藏的原样返回。 */
export function withoutHiddenPaymentMethods<T extends { paymentMethods: readonly { type: string }[] }>(info: T, hidden: readonly string[]): T {
  if (hidden.length === 0) return info
  const paymentMethods = info.paymentMethods.filter((method) => !isHidden(method.type, hidden))
  return paymentMethods.length === info.paymentMethods.length ? info : { ...info, paymentMethods }
}

/**
 * 买套餐时用的那种付款方式在站上叫什么：易支付那几种带着 type，Stripe 这类只带渠道名，渠道名和
 * type 只差一个连字符（new-api-client.ts 的 paymentProvider）。
 */
export function subscriptionPaymentType(input: { provider: string; paymentMethod?: string }): string {
  return input.paymentMethod ?? input.provider.replace(/-/g, '_')
}

export function assertPaymentMethodShown(type: string, hidden: readonly string[]): void {
  if (isHidden(type, hidden)) throw new Error(paymentMethodOffMessage)
}
