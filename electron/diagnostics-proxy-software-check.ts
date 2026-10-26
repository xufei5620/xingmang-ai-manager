// 一键检测里「别的代理软件」这一项：系统设置里开着的代理（客户自己的翻墙软件、加速器、公司代理）有没有挡住星芒。
// 原来「电脑里的代理设置」那一项顺带说一句系统代理，只看端口开没开，说不出经它到底连不连得上星芒；星芒自己连不上时
// 会改走直连（proxy-bypass.ts），可 Codex（命令行和桌面端）、Claude 桌面端照旧跟着系统代理走，客户只看到工具连不上
// （客户问题归类第 3 类）。这里真的经系统代理连一次星芒，再直接连一次，两边一比就知道是不是它挡的路。
//
// 只读：不改系统代理，不替客户退出代理软件，按钮只是打开系统自己的代理设置页。结论和报告里只写本机端口或「别的机器」，
// 不写代理地址：报告会被导出发给客服，地址里可能带着代理的用户名和密码。
import type { CheckDefinition, CheckOutcome } from './diagnostics'
import type { DiagnosticsContext } from './diagnostics-context'
import { readBoundedResponseText } from './bounded-response'
import { isLoopbackDownloadProxy, parseChromiumProxyResult } from './download-proxy'
import { classifyNetworkFailure, parsesAsJsonObject } from './network-failure'
import { probeLoopbackProxy, type LoopbackProbe } from './stale-proxy-environment'
import { relayStatusProbeUrl } from './diagnostics-network-checks'

// 问 Chromium 这个地址走哪条路：读的是系统设置，平时几毫秒；读不出来就当没开代理（和以前一样）。
const proxyResolveTimeoutMs = 2_000
// 经代理、直接连各连一次星芒的状态接口，两次同时发：整项只有 DEFAULT_CHECK_TIMEOUT_MS。
const relayProbeTimeoutMs = 4_000
// 状态接口只回几 KB 的 JSON；代理回的错误页再大也用不着读完。
const relayProbeMaxBytes = 64 * 1024

/** 连一次星芒的状态接口：回了 JSON 才算连上；proxy-down = 连不上代理本身（network-failure.ts 的 proxy）。 */
export type RelayReachability = 'ok' | 'proxy-down' | 'failed'

export async function probeRelayStatus(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<RelayReachability> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(relayProbeTimeoutMs)]),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return 'failed'
    }
    return parsesAsJsonObject(await readBoundedResponseText(response, relayProbeMaxBytes, '星芒 AI 状态接口')) ? 'ok' : 'failed'
  } catch (error) {
    return classifyNetworkFailure(error) === 'proxy' ? 'proxy-down' : 'failed'
  }
}

/**
 * 查到了什么。port 是本机代理的端口，代理在别的机器上时是 null。forwarding = 经它连得上星芒；blocking = 经它连不上、
 * 直接连连得上，就是它挡的路；unreachable = 两边都连不上，不怪它（「星芒 AI 网络」那一项会说）；dead = 系统设置里
 * 还指着它，可它没在运行（本机端口没开，或者连不上代理本身）。
 */
export type ProxySoftwareFinding =
  | { kind: 'none' }
  | { kind: 'acceleration' }
  | { kind: 'forwarding' | 'blocking' | 'unreachable' | 'dead'; port: number | null }

export interface ProxySoftwareProbes {
  /** 星芒自己的加速开着时，系统代理就是加速设的。 */
  accelerationActive(): Promise<boolean>
  /** Chromium 的 resolveProxy 原样结果，只跟随系统代理的那个会话（不受星芒自己改直连影响）。 */
  resolveProxy(url: string): Promise<string>
  probeLoopback: LoopbackProbe
  throughProxy(url: string, signal: AbortSignal): Promise<RelayReachability>
  direct(url: string, signal: AbortSignal): Promise<RelayReachability>
}

async function resolveWithin(resolve: (url: string) => Promise<string>, url: string): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), proxyResolveTimeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([resolve(url).catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function inspectProxySoftware(url: string, probes: ProxySoftwareProbes, signal: AbortSignal): Promise<ProxySoftwareFinding> {
  if (await probes.accelerationActive().catch(() => false)) return { kind: 'acceleration' }
  // DIRECT、认不出的写法都按没开代理算，和以前「电脑里的代理设置」那半句一样。
  const endpoint = parseChromiumProxyResult(await resolveWithin(probes.resolveProxy, url))
  if (!endpoint) return { kind: 'none' }
  const local = isLoopbackDownloadProxy(endpoint)
  const port = local ? endpoint.port : null
  if (local) {
    const host = endpoint.host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    if (!(await probes.probeLoopback({ host, port: endpoint.port }).catch(() => false))) return { kind: 'dead', port }
  }
  const [throughProxy, direct] = await Promise.all([probes.throughProxy(url, signal), probes.direct(url, signal)])
  if (throughProxy === 'ok') return { kind: 'forwarding', port }
  if (throughProxy === 'proxy-down') return { kind: 'dead', port }
  return { kind: direct === 'ok' ? 'blocking' : 'unreachable', port }
}

export const proxySoftwareSummaries = {
  none: '系统设置里没有开代理，星芒和工具直接联网',
  acceleration: '系统设置里的代理是星芒自己的加速设的，不是别的软件',
  timeout: '电脑这会儿比较忙，这一项没来得及查完，稍后点「重新检查」再看一次。',
} as const

const affectedTools = 'Codex（命令行和桌面端）、Claude 桌面端'

/** 「打开系统代理设置」只有 Windows、Mac 有（proxy-bypass.ts 的 networkSettingsTarget），同首页断网横条那一颗。 */
function proxySettingsButton(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

export function proxySoftwareOutcome(finding: ProxySoftwareFinding, platform: NodeJS.Platform): CheckOutcome {
  if (finding.kind === 'none') return { state: 'pass', summary: proxySoftwareSummaries.none, details: { systemProxy: 'none' } }
  if (finding.kind === 'acceleration') return { state: 'pass', summary: proxySoftwareSummaries.acceleration, details: { systemProxy: 'acceleration' } }
  const { kind, port } = finding
  const where = port === null ? '开着代理（用的是别的机器上的代理）' : `开着别的代理软件（本机 ${port} 端口）`
  const details: Record<string, string | number> = { systemProxy: kind, ...(port === null ? { proxyHost: 'remote' } : { proxyPort: port }) }
  const button = proxySettingsButton(platform)
  const fix: Record<string, string> = button ? { fix: 'open-proxy-settings' } : {}
  if (kind === 'forwarding') return { state: 'pass', summary: `${where}，星芒经它能连上`, details }
  if (kind === 'unreachable') {
    return { state: 'pass', summary: `${where}。这会儿经它和直接连都连不上星芒，先看上面「星芒 AI 网络」那一行。`, details }
  }
  if (kind === 'blocking') {
    return {
      state: 'warn',
      summary: `${where}，可是经它连不上星芒。星芒自己会自动改成直接连，不用管；${affectedTools}跟着它走，会连不上。`
        + '用这几个工具时，在代理软件里把星芒设成直连，或者先退出代理软件。',
      details: { ...details, ...fix },
    }
  }
  const lead = port === null
    ? '系统设置里还开着代理（用的是别的机器上的代理），可是它连不上。'
    : `系统设置里还开着代理（本机 ${port} 端口），可是那个代理软件没在运行。`
  return {
    state: 'warn',
    summary: `${lead}星芒自己会自动改成直接连；${affectedTools}还会去连它，会连不上。`
      + `打开那个代理软件，或者${button ? '点「打开系统代理设置」' : '在系统设置里'}把代理关掉。`,
    details: { ...details, ...fix },
  }
}

export function buildProxySoftwareChecks(context: DiagnosticsContext): CheckDefinition[] {
  const { dependencies, toolSite, platform } = context
  const { resolveSystemProxy, fetchThroughSystemProxy, fetchDirect } = dependencies
  // 宿主没接这几样（测试、旧的调用方）就不出这一项：缺省没有能只经系统代理、只直接连的会话。
  if (!resolveSystemProxy || !fetchThroughSystemProxy || !fetchDirect) return []
  return [{
    code: 'SYSTEM_PROXY_SOFTWARE',
    title: '别的代理软件',
    // 只做说明、不决定软件行为，超时不亮红灯（同「安全证书」）。
    timeoutOutcome: { state: 'pass', summary: proxySoftwareSummaries.timeout, details: { timedOut: true } },
    run: async (signal) => {
      // 查的是工具配置里那条线路：Codex、Claude 桌面端连的就是它。
      const finding = await inspectProxySoftware(relayStatusProbeUrl(toolSite), {
        accelerationActive: () => dependencies.inspectAccelerationActive?.() ?? Promise.resolve(false),
        resolveProxy: resolveSystemProxy,
        probeLoopback: dependencies.probeLoopbackProxy ?? probeLoopbackProxy,
        throughProxy: (url, probeSignal) => probeRelayStatus(fetchThroughSystemProxy, url, probeSignal),
        direct: (url, probeSignal) => probeRelayStatus(fetchDirect, url, probeSignal),
      }, signal)
      return proxySoftwareOutcome(finding, platform)
    },
  }]
}
