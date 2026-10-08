// 「代理连不上时改直连」住在 main.ts（它要碰 defaultSession、读加速状态），设置页
// 那一行「网络连接」却由这里的平台服务给出。两边同进程、互不 import，照
// host-notification-bridge.ts 的做法留一个转接口；没接上就当没绕过。
let reader: (() => boolean) | null = null
let siteReader: (() => boolean) | null = null

export function attachProxyBypassState(read: () => boolean, readSiteDirect?: () => boolean): void {
  reader = read
  siteReader = readSiteDirect ?? null
}

export function proxyBypassActive(): boolean {
  return reader?.() ?? false
}

/** 代理开着、只是不转发星芒时，账号和 AI 对话是不是已经改走直连（整个改了直连时不算）。 */
export function proxySiteDirectActive(): boolean {
  return siteReader?.() ?? false
}
