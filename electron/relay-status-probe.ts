// 探线路通不通用的那个地址。开机时的线路探测和账号就要用它，检查页那一套点开才加载，所以从
// diagnostics-network-checks.ts 单拿出来，只靠站点表，开机不必把整套检查拉进来。
import {
  relayApiProbeBaseUrl, relayEndpointForUrl, relaySiteEndpointChoices, requireRelaySite,
  type RelayRouteLines, type RelaySite,
} from './relay-sites'

/**
 * 网络那一项探测的地址：当前站点上一个不用登录、本来就回 JSON 的公开接口。
 *
 * 站点根路径不能用来判断「被拦截」：两个站的根路径都是网页前端，正常时也回
 * text/html，#302 就是因此对所有人误报。换成本来就回 JSON 的接口后，「拿到的
 * 是网页而不是 JSON」才真正说明中间有东西替服务器答了话。两个接口都已按上游
 * 源码核实：new-api 的 `GET /api/status`（docs/RECON-new-api.md 的「状态」行，
 * 公开）与 sub2api 的 `GET /api/v1/settings/public`（登录页自己读的公开设置）。
 * 都在 /api 下，是账号客户端本来就要走的路径，不会被只放行 /api 与 /v1 的反代
 * 挡在外面。两者都只认 GET：gin 不会把 HEAD 路由到 GET 处理器，HEAD 拿不到这份
 * JSON。
 *
 * 地址跟着 CLI 实际调用的域走（relayApiProbeBaseUrl），今天两个站的中转域与
 * 账号域恰好同域，所以接口按 accountBackend 选。
 */
export function relayStatusProbeUrl(site: RelaySite): string {
  const origin = new URL(relayApiProbeBaseUrl(site))
  if (origin.protocol !== 'https:') throw new Error('星芒 AI 地址不是 https，已拒绝检查')
  switch (site.accountBackend) {
    case 'new-api':
      return new URL('/api/status', origin).href
    case 'sub2api':
      return new URL('/api/v1/settings/public', origin).href
  }
}

/**
 * 一个地址所在站点每条线路的探测地址，这会儿用的那条排第一；不是星芒的地址给空的。代理分流
 * （proxy-bypass.ts）靠它把同一个站的几个入口当成一个站点：「自动」中途换了入口，分去直连会话
 * 的请求照样分过去，再看时探的也是这会儿用的入口。
 */
export function relaySiteStatusProbeUrls(url: string, lines: RelayRouteLines): string[] {
  const endpoint = relayEndpointForUrl(url)
  if (!endpoint) return []
  const current = lines[endpoint.siteId].line
  const others = relaySiteEndpointChoices(endpoint.siteId).map((choice) => choice.id).filter((line) => line !== current)
  return [current, ...others].map((line) => relayStatusProbeUrl(requireRelaySite(endpoint.siteId, line)))
}
