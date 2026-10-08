const knownChannelNames: Record<string, string> = {
  alipay: '支付宝',
  wxpay: '微信支付',
  wechat: '微信支付',
  wechatpay: '微信支付',
  qqpay: 'QQ 钱包',
  stripe: 'Stripe',
}

// 有的后台没填渠道显示名，接口回来的就是渠道代码（比如「alipay」）。客户看不懂英文代码，
// 认得的换成中文名；后台自己填了名字的照用。
export function paymentMethodLabel(method: { name: string; type: string }): string {
  const name = method.name.trim()
  const code = (name || method.type).trim().toLowerCase().replace(/[\s_-]/g, '')
  if (!name || name.toLowerCase() === method.type.trim().toLowerCase()) return knownChannelNames[code] ?? (name || method.type)
  return knownChannelNames[code] ?? name
}
