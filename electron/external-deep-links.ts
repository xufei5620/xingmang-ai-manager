export type ExternalDeepLink =
  | { kind: 'pay'; order: string | null }
  | { kind: 'invite'; code: string }
  | { kind: 'invalid'; message: string }

const invalidLink: ExternalDeepLink = { kind: 'invalid', message: '链接无效或暂不支持，请从工具箱内打开对应页面。' }

export function parseExternalDeepLink(raw: string): ExternalDeepLink {
  if (raw.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(raw)) return invalidLink
  try {
    const url = new URL(raw)
    if (url.protocol !== 'xingmang:' || url.username || url.password || url.port || url.hash) return invalidLink
    const parameters = [...url.searchParams.keys()]
    if (url.hostname === 'pay' && ['', '/', '/success'].includes(url.pathname)) {
      const order = url.searchParams.get('order')
      if (parameters.some((key) => key !== 'order') || parameters.length > 1
        || (order !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(order))) return invalidLink
      return { kind: 'pay', order }
    }
    if (url.hostname === 'invite' && ['', '/'].includes(url.pathname)) {
      const code = url.searchParams.get('code')
      if (parameters.length !== 1 || parameters[0] !== 'code' || !code || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) return invalidLink
      return { kind: 'invite', code }
    }
  } catch { /* External input is never a navigation URL. */ }
  return invalidLink
}

// Keep the latest OS intent until the renderer subscribes; never load an external URL.
export function createExternalDeepLinkInbox(now: () => number = Date.now) {
  let pending: { link: ExternalDeepLink; expires: number } | null = null
  let previous: { raw: string; at: number } | null = null
  return {
    accept(raw: string): boolean {
      if (!/^xingmang:/i.test(raw)) return false
      const time = now()
      if (previous?.raw === raw && time - previous.at < 2000) return false
      previous = { raw: raw.slice(0, 2049), at: time }
      pending = { link: parseExternalDeepLink(raw), expires: time + 10 * 60_000 }
      return true
    },
    take(): ExternalDeepLink | null {
      const next = pending
      pending = null
      return next && next.expires > now() ? next.link : null
    },
  }
}
