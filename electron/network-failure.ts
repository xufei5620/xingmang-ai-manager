/**
 * 受限网络（校园网、公司网、公共 Wi-Fi）下的失败长得各不相同：域名被劫持解析
 * 不出来、只放行 80/443、透明代理换掉证书、必须先在浏览器过一次门户认证。可是
 * 到了代码里它们都只是「请求没成功」，于是界面只能给一句兜底的「请稍后重试」，
 * 用户既不知道该换网络还是改密码，客服也拿不到任何线索。
 *
 * 这个模块只做一件事：把底层错误归到一个原因上，并给出一句用户看得懂的中文。
 * 主进程用它抛错和写日志，渲染层用 matchNetworkFailureMessage 认出这句话后原样
 * 上屏——文案因此只有一份，不会两棵树各写一句然后慢慢跑偏。
 *
 * 与 catalog.ts 同理：这个模块进渲染包，所以永远不许依赖 node 或 electron
 * （I6，门禁见 scripts/verify-renderer-boundary.test.cjs 的 valueImportable）。
 */
export type NetworkFailureReason = 'offline' | 'dns' | 'tls' | 'proxy' | 'refused' | 'timeout' | 'intercepted'

/**
 * 文案约定：主语是「当前网络」或「账号服务」，不出现站点名、域名和内部代号
 * （双站点对用户无感）；每条都要说清楚「这是网络的问题」和「下一步做什么」，
 * 否则用户只会反复重输密码。
 */
export const networkFailureMessages: Readonly<Record<NetworkFailureReason, string>> = {
  offline: '设备当前没有连上网络，请先连接网络再试。',
  dns: '当前网络解析不出账号服务的地址，校园网、公司网常见。换一个网络（例如手机热点）通常就能用。',
  tls: '当前网络替换了这次连接的安全证书，为保护账号信息已经中止本次请求。请换一个网络再试，不要在这个网络上继续输入密码。',
  proxy: '系统里设置的代理连不上，请检查代理或加速设置后再试。',
  refused: '与账号服务的连接被当前网络切断了，校园网、公司网常见。换一个网络（例如手机热点）再试一次。',
  timeout: '连接账号服务超时，请检查网络后再试。',
  intercepted: '当前网络把这次请求拦到了别的页面，多半是校园网或公共 Wi-Fi 要求先在浏览器完成上网认证。认证之后再试，或者改用手机热点。',
}

/**
 * 同一批原因，换成「更新」这件事的说法。更新器连的是静态更新目录，不是账号服务，
 * 也不涉及输密码，照搬上面那张表会让用户以为是账号出了问题；反过来把两件事合成
 * 一句「网络不通」，又说不清该换网络还是该等发布者。所以按主语分两张表，分类逻辑
 * 仍然只有一份。
 */
export const updateNetworkFailureMessages: Readonly<Record<NetworkFailureReason, string>> = {
  offline: '设备当前没有连上网络，请先连接网络再试。',
  dns: '当前网络解析不出更新服务器的地址，校园网、公司网常见。换一个网络（例如手机热点）通常就能用。',
  tls: '当前网络替换了这次连接的安全证书，为保证安装包来源可信已经中止本次更新。请换一个网络再试。',
  proxy: '系统里设置的代理连不上，请检查代理或加速设置后再试。',
  refused: '与更新服务器的连接被当前网络切断了，校园网、公司网常见。换一个网络（例如手机热点）再试一次。',
  timeout: '连接更新服务器超时，请检查网络后再试。',
  intercepted: '当前网络把这次请求拦到了别的页面，多半是校园网或公共 Wi-Fi 要求先在浏览器完成上网认证。认证之后再试，或者改用手机热点。',
}

/**
 * Chromium (net.fetch) reports `net::ERR_*`; Node and undici report errno
 * strings. Both spellings appear here because the account layer is fed
 * net.fetch in production and a plain fetch in tests.
 *
 * Order matters: a TLS interception failure spells out both ERR_SSL and, on
 * some paths, a connection reset, and the certificate answer is the one the
 * user must act on.
 */
const failurePatterns: readonly { reason: NetworkFailureReason; test: RegExp }[] = [
  { reason: 'timeout', test: /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|ESOCKETTIMEDOUT/i },
  // npm / OpenSSL 说的是同一件事，但用的是另一套词：走 npm 的那条路（装 CLI、查
  // 最新版）只会吐出 `self signed certificate in certificate chain` 这类英文散句，
  // 只认 errno 风格的写法会让同一个公司网关在账号那侧认得出、在安装那侧认不出。
  { reason: 'tls', test: /ERR_CERT|ERR_SSL|ERR_BAD_SSL|ERR_TLS|CERT_HAS_EXPIRED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_UNTRUSTED|HOSTNAME_MISMATCH|ERR_QUIC_HANDSHAKE_FAILED|self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate|certificate has expired/i },
  { reason: 'proxy', test: /ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED|ERR_UNEXPECTED_PROXY_AUTH/i },
  { reason: 'dns', test: /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS|ENOTFOUND|EAI_AGAIN/i },
  // A captive portal answers with a redirect to its own login page. Callers
  // that ask for `redirect: 'error'` never see the 3xx itself -- undici turns
  // it into `TypeError: fetch failed` whose cause reads `unexpected redirect`,
  // and Chromium spells the same refusal `ERR_UNSAFE_REDIRECT`. Without this
  // row that is the one restricted-network failure with no answer at all.
  { reason: 'intercepted', test: /unexpected redirect|ERR_UNSAFE_REDIRECT|ERR_TOO_MANY_REDIRECTS|redirect count exceeded/i },
  { reason: 'offline', test: /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ENETDOWN|ENETUNREACH|EHOSTUNREACH/i },
  { reason: 'refused', test: /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ERR_SOCKET_NOT_CONNECTED|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|socket hang up/i },
]

const reasons = Object.keys(networkFailureMessages) as NetworkFailureReason[]
// 一层壳最多取这么多字符，避免把一个超长的上游响应体当成错误文本来跑正则。
const maxTextLength = 2_000
const maxCauseDepth = 5

function appendText(parts: string[], value: unknown): void {
  if (typeof value !== 'string' || !value) return
  parts.push(value.length > maxTextLength ? value.slice(0, maxTextLength) : value)
}

/** `fetch` 把真实原因放在 cause 里，所以只看最外层的 message 什么都读不到。 */
function collectFailureText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < maxCauseDepth && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'string') { appendText(parts, current); break }
    if (typeof current !== 'object') break
    const record = current as { name?: unknown; message?: unknown; code?: unknown; errno?: unknown; cause?: unknown }
    appendText(parts, record.name)
    appendText(parts, record.message)
    appendText(parts, record.code)
    appendText(parts, typeof record.errno === 'number' ? String(record.errno) : record.errno)
    current = record.cause
  }
  return parts.join(' ')
}

/**
 * 认出这个模块自己写过的那句中文。主进程抛出的错误跨过 IPC 之后只剩一句
 * message，日志侧要从这句话倒推回原因，靠的就是它。
 */
export function networkFailureReasonForMessage(text: unknown): NetworkFailureReason | null {
  if (typeof text !== 'string' || !text) return null
  return reasons.find((reason) => text.includes(networkFailureMessages[reason])) ?? null
}

/**
 * 认不出来就返回 null——把一个说不清的失败硬说成「网络问题」，会让用户在一个
 * 其实和网络无关的故障上反复换 Wi-Fi。
 */
export function classifyNetworkFailure(error: unknown): NetworkFailureReason | null {
  const text = collectFailureText(error)
  if (!text) return null
  return networkFailureReasonForMessage(text) ?? failurePatterns.find((pattern) => pattern.test.test(text))?.reason ?? null
}

/** 渲染层用：认出主进程那句话就原样上屏，认不出来交还给调用方兜底。 */
export function matchNetworkFailureMessage(text: unknown): string | null {
  const reason = networkFailureReasonForMessage(typeof text === 'string' ? text : text instanceof Error ? text.message : '')
  return reason ? networkFailureMessages[reason] : null
}
