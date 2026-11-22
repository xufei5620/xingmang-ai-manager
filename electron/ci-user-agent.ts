// 服务端按 User-Agent 和来源 IP 数「多少台电脑在用」。GitHub Actions 里真开的星芒（quality 一天上百次）
// 请求的也是正式的账号站和更新目录，2026-11-21 服务端在一天的日志里数出 275 台这样的「Linux 电脑」。
// CI 作业先把正式环境的域名指回本机（scripts/ci-block-production-hosts.cjs），这里是漏网时的记号：
// CI 里起的星芒，每个请求的 UA 末尾多一个「 ci」，服务端和 update-feed-stats 认这一个后缀剔掉。
//
// 认 CI 的口径跟每天打卡、版本上报、错误报告一样，只看 CI=true（usage-stats.ts、client-version-report.ts、
// crash-report.ts）：GitHub Actions 给每个作业都设它，客户的电脑上没有。只改 UA，不改请求发到哪、发不发。

export const ciUserAgentMarker = ' ci'

export interface UserAgentFallbackTarget {
  userAgentFallback: string
}

/**
 * Electron 的 app.userAgentFallback 是所有会话（主窗口、更新、画布、付款窗口）默认用的那一串，
 * net.fetch、net.request、session.fetch 都带它；要在任何请求之前、ready 之前设好。
 * 已经带着记号就不再加，读不到就照原样，一律不挡启动。返回这次有没有加上。
 */
export function ensureCiUserAgentMarker(target: UserAgentFallbackTarget, env: NodeJS.ProcessEnv): boolean {
  if (env.CI !== 'true') return false
  try {
    const current = target.userAgentFallback
    if (typeof current !== 'string' || current.length === 0 || current.endsWith(ciUserAgentMarker)) return false
    target.userAgentFallback = `${current}${ciUserAgentMarker}`
    return true
  } catch {
    return false
  }
}
