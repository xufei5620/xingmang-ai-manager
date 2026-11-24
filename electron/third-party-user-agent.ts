// 星芒发出去的每个请求，User-Agent 都是 Electron 默认那一串，中间带着「xingmang-ai-manager/版本号」
// （package.json 的 name，没有 productName），跟公开的 GitHub 仓库同名。Codex 镜像、查 IP 归属的几家、
// npm 镜像、各家官网下载站、付款页……这些第三方的访问记录里看一眼、上 GitHub 一搜，就找到我们的仓库
// （2026-11-24 安全清单 安-1）。
//
// 这里改成：默认那一串去掉这一段（剩下的就是任何一个没起名字的 Electron 程序都会带的那串），只有发给
// 自家站点的请求补回原样。自家站点要原样的：服务端「登录设备」靠它认出星芒（login-device-label.ts），
// update-feed-stats 靠它数各版本有多少电脑，服务端按 UA 和来源 IP 数装机量。调用方自己设过的 UA
// （electron-updater 的「electron-builder」）一律不动；CI 里那个「 ci」记号（ci-user-agent.ts）两边都留着。
//
// 默认改成不带名字、自家站点再补回去，而不是反过来：哪个会话哪天没挂上，最多是自家站点少数一次，
// 不会把名字漏给外人；页面里的脚本读 navigator.userAgent 也读不到它（付款页是第三方的网页）。
//
// 挂在每个会话的 webRequest.onBeforeSendHeaders 上。2026-11-24 在 Electron 45.4.1 上实测：主进程的
// net.fetch、session.fetch、net.request，窗口里的页面和图片，跳转后的每一跳，都在这里看得见、改得动；
// app 的 session-created 对默认会话、每个 partition（electron-updater 自己建的、付款窗口每次随机的）都会发。
// Electron 的同一个会话只认最后挂上的那个 onBeforeSendHeaders，别处再挂会把这里顶掉
// （third-party-user-agent.test.ts 钉着只许这里挂）。

/** 星芒自己的线上服务都在这两个域名下（同 scripts/ci-block-production-hosts.cjs）：账号站、线路、开票是 solov.cc，更新目录是 shenfengwl.fun。 */
export const ownServiceDomains = Object.freeze(['solov.cc', 'shenfengwl.fun'])
/** 不在上面两个域名下、但也是我们自己的：放官方离线包的腾讯云存储桶（desktop-package-bucket.ts，测试核对两边一致）。 */
export const ownServiceHosts = Object.freeze(['xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com'])
// 只有这几种请求带 UA；xingmang://、xingmang-canvas:// 这些本地协议不用经过这里。
const webRequestUrlPatterns = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']
const webRequestProtocols = new Set(['http:', 'https:', 'ws:', 'wss:'])
// 程序名要是正好叫这几个，Electron 那一段跟标准的几段同名，拿掉就把标准的也拿掉了。Electron 起名叫
// Electron 时本来就不加那一段。
const standardUserAgentProducts = new Set(['mozilla', 'applewebkit', 'chrome', 'electron', 'safari'])

export interface UserAgentPolicy {
  /** 自家站点收到的那一串：Electron 默认的，带着程序名和版本。 */
  readonly branded: string
  /** 其余所有网站收到的那一串：去掉程序名那一段。 */
  readonly generic: string
}

/** 这个主机是不是星芒自己的线上服务。按标签比，`evil-solov.cc`、`solov.cc.example.com` 都不算。 */
export function isOwnServiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host.length === 0) return false
  if (ownServiceHosts.includes(host)) return true
  return ownServiceDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/**
 * Electron 往默认 UA 里加的那一段是「程序名去掉空格/版本号」（electron_browser_client.cc 的
 * GetApplicationUserAgent）。按「程序名/」开头拿掉，版本号对不上也一样拿掉；别的段原样、顺序不变。
 */
export function withoutApplicationProduct(userAgent: string, applicationName: string): string {
  const product = applicationName.replace(/ /g, '')
  if (product.length === 0 || standardUserAgentProducts.has(product.toLowerCase())) return userAgent
  const prefix = `${product}/`
  return userAgent.split(' ').filter((part) => !part.startsWith(prefix)).join(' ')
}

/** 从 Electron 默认的那一串得出两种 UA。默认那串里没有程序名那一段（没什么可藏的）时返回 null。 */
export function createUserAgentPolicy(fallback: string, applicationName: string): UserAgentPolicy | null {
  if (typeof fallback !== 'string' || fallback.length === 0) return null
  const generic = withoutApplicationProduct(fallback, applicationName)
  if (generic === fallback || generic.length === 0) return null
  return Object.freeze({ branded: fallback, generic })
}

function userAgentHeaderName(headers: Record<string, string>): string | undefined {
  return Object.keys(headers).find((name) => name.toLowerCase() === 'user-agent')
}

function requestHost(url: string): { protocol: string, hostname: string } | null {
  try {
    const parsed = new URL(url)
    return { protocol: parsed.protocol, hostname: parsed.hostname }
  } catch {
    return null
  }
}

/**
 * 一个请求要不要换 UA；要换返回换好的整份请求头，不用换返回 null。
 * 自家站点：带的是去掉名字的那串（或者干脆没带、等网络层补默认的）就换回原样。
 * 别的网站：带的还是原样那串（有人在会话或请求上设回去了）就去掉名字。
 * 别的值都是调用方自己设的，两边都不动。
 */
export function rewriteRequestUserAgent(
  url: string,
  requestHeaders: Record<string, string>,
  policy: UserAgentPolicy,
): Record<string, string> | null {
  const target = requestHost(url)
  if (target && !webRequestProtocols.has(target.protocol)) return null
  const headerName = userAgentHeaderName(requestHeaders)
  const current = headerName === undefined ? undefined : requestHeaders[headerName]
  let next: string
  if (target && isOwnServiceHost(target.hostname)) {
    if (current !== undefined && current !== policy.generic) return null
    next = policy.branded
  } else {
    // 网址认不出来时当外人看：宁可自家站点少数一次，也不把名字带出去。
    if (current !== policy.branded) return null
    next = policy.generic
  }
  const headers = { ...requestHeaders }
  if (headerName !== undefined) delete headers[headerName]
  headers['User-Agent'] = next
  return headers
}

interface BeforeSendHeadersDetails {
  url: string
  requestHeaders: Record<string, string>
}

export interface UserAgentSession {
  webRequest: {
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener: (details: BeforeSendHeadersDetails, callback: (response: { requestHeaders?: Record<string, string> }) => void) => void,
    ): void
  }
}

export interface UserAgentApp {
  userAgentFallback: string
  getName(): string
  on(event: 'session-created', listener: (session: UserAgentSession) => void): unknown
}

/**
 * 在任何会话建出来之前调（main.ts 模块顶层、CI 记号之后）：把默认 UA 换成不带名字的那串，并给之后
 * 建出来的每个会话挂上补回自家站点的那一步。返回挂一个会话的函数，同一个会话挂几次都只挂一次，
 * main.ts 在 ready 后再对默认会话补一次，万一哪版 Electron 不对它发 session-created 也挂得上。
 * 读不到、改不了默认 UA 就什么都不做，一律不挡启动。
 */
export function installThirdPartyUserAgentPolicy(target: UserAgentApp): (session: UserAgentSession) => void {
  let policy: UserAgentPolicy | null = null
  try {
    policy = createUserAgentPolicy(target.userAgentFallback, target.getName())
    if (policy) target.userAgentFallback = policy.generic
  } catch {
    policy = null
  }
  const applied = new WeakSet<UserAgentSession>()
  function apply(session: UserAgentSession): void {
    const active = policy
    if (!active || applied.has(session)) return
    applied.add(session)
    try {
      session.webRequest.onBeforeSendHeaders({ urls: webRequestUrlPatterns }, (details, callback) => {
        // 这一步不回 callback，这个会话的请求就全卡住；算的时候出什么错都照原样放行。
        let requestHeaders: Record<string, string> | null = null
        try {
          requestHeaders = rewriteRequestUserAgent(details.url, details.requestHeaders, active)
        } catch {
          requestHeaders = null
        }
        callback(requestHeaders ? { requestHeaders } : {})
      })
    } catch {
      // 挂不上的会话里，自家站点收到的是不带名字的那串；不往外漏，也不挡这个会话的请求。
    }
  }
  if (policy) target.on('session-created', apply)
  return apply
}
