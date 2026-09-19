import { errorMessage } from '../../business-common'

/**
 * 客服二维码是本地生成的，失败没有别的途径能让用户知道。原本 `.catch(() =>
 * undefined)` 把拒绝吞掉，帮助弹窗就只剩标题和文字、少了那张图，用户以为界面坏了
 * 而不是「换个方式联系客服」（R-B7）。
 */
export function supportQrFallbackText(state: { url: string; data: string | null } | undefined, url: string): string | null {
  if (!state || state.url !== url) return null
  return state.data === null ? '二维码这次没有生成出来，请点下面的「在浏览器打开」联系客服。' : null
}

/**
 * 支付回跳读不到时，用户刚在浏览器里付完款跳回来，界面什么都不发生。至少要说清
 * 订单不会因此丢，以及去哪里核对（R-B7）。
 */
export function deepLinkReadErrorText(cause: unknown): string {
  const reason = errorMessage(cause, '外部跳转没有读取到')
  const lead = /[。！？.!?]$/.test(reason) ? reason : `${reason}。`
  return `${lead}如果刚完成支付，款项不会因此丢失，请到「账号」的「订单」页核对订单状态。`
}
