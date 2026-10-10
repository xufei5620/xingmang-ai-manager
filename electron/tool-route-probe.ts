/**
 * 工具线路控制器用的探测（xm 三线路 5.1.1「判定」）：一条线路要在所有在用的路径上都通才算通。无代理
 * 路径一直测（Claude Code、Gemini、Grok 默认就这么连）；系统代理对星芒生效时加测系统代理（Codex、
 * Claude Desktop 走它）；进程、当前账号、整台电脑设了 HTTPS_PROXY / ALL_PROXY 时每个都加测。
 *
 * 没有一条线路能在所有路径上都通时以无代理路径为准。所以一条线路只是代理路径没通时，还要看另一条
 * 能不能全通才定：另一条全通，这条算没通（工具换过去就都能用）；另一条也不全通，这条按无代理路径算通。
 */
import { relayEndpointOrigin, type RelayEndpointId } from './relay-sites'
import { toolPathPassesEverywhere, toolPathPassingLines, type ToolPathResult, type ToolPathResults } from './tool-path-probe'
import type { ToolRouteProbeResult } from './tool-route-controller'

export interface ToolRouteProbeDependencies {
  /** 无代理路径（tool-path-probe.ts 的 probeToolPathDirect）。 */
  direct(origin: string): Promise<ToolPathResult>
  /** 系统代理对这个 origin 生效没有（PAC、绕过列表都算在内）；读不出来按没生效。 */
  systemProxyActive?(origin: string): Promise<boolean>
  /** 经系统代理探（tool-path-probe.ts 的 probeToolPathThroughFetch）。 */
  throughSystemProxy?(origin: string): Promise<ToolPathResult>
  /** 要测的环境变量代理（tool-path-probe.ts 的 environmentProxyCandidates），由调用方决定多久重读一次。 */
  environmentProxies?(): Promise<readonly string[]>
  /** 经一个环境变量代理探。 */
  throughProxy?(proxy: string, origin: string): Promise<ToolPathResult>
}

const toolRouteProbeLines: readonly RelayEndpointId[] = ['direct', 'primary']

function unreachable(): ToolPathResult {
  return { ok: false, kind: 'dns', addresses: [], attempts: [] }
}

/** 几个结果里先挑算连败的那个失败，再挑「慢」，都通就给第一个。 */
function worstOf(results: readonly ToolPathResult[]): ToolPathResult | undefined {
  return results.find((result) => !result.ok && result.kind !== 'slow') ?? results.find((result) => !result.ok) ?? results[0]
}

export function createToolRouteProbe(dependencies: ToolRouteProbeDependencies): (line: RelayEndpointId) => Promise<ToolRouteProbeResult> {
  async function systemPath(origin: string): Promise<ToolPathResult | undefined> {
    const { systemProxyActive, throughSystemProxy } = dependencies
    if (!systemProxyActive || !throughSystemProxy) return undefined
    let active = false
    try { active = await systemProxyActive(origin) } catch { active = false }
    return active ? throughSystemProxy(origin) : undefined
  }

  async function environmentPath(origin: string): Promise<ToolPathResult | undefined> {
    const { environmentProxies, throughProxy } = dependencies
    if (!environmentProxies || !throughProxy) return undefined
    let proxies: readonly string[] = []
    try { proxies = await environmentProxies() } catch { proxies = [] }
    if (!proxies.length) return undefined
    return worstOf(await Promise.all(proxies.map((proxy) => throughProxy(proxy, origin))))
  }

  async function pathsOf(line: RelayEndpointId): Promise<ToolPathResults> {
    const origin = relayEndpointOrigin('solov', line)
    if (!origin) return { direct: unreachable() }
    const [direct, systemProxy, environmentProxy] = await Promise.all([
      dependencies.direct(origin), systemPath(origin), environmentPath(origin),
    ])
    return { direct, ...(systemProxy ? { systemProxy } : {}), ...(environmentProxy ? { environmentProxy } : {}) }
  }

  function outcome(ok: boolean, results: ToolPathResults): ToolRouteProbeResult {
    const { direct } = results
    if (ok) return { ok: true, addresses: direct.addresses }
    const failed = direct.ok ? worstOf([results.systemProxy, results.environmentProxy].filter((entry): entry is ToolPathResult => entry !== undefined)) : direct
    return { ok: false, ...(failed?.kind ? { kind: failed.kind } : {}), addresses: direct.addresses }
  }

  return async (line) => {
    const results = await pathsOf(line)
    if (toolPathPassesEverywhere(results) || !results.direct.ok) return outcome(results.direct.ok, results)
    // 无代理路径通、某条代理路径没通：看另一条线路能不能全通。
    const others = toolRouteProbeLines.filter((entry) => entry !== line)
    const all: Partial<Record<RelayEndpointId, ToolPathResults>> = { [line]: results }
    for (const [index, value] of (await Promise.all(others.map(pathsOf))).entries()) all[others[index]] = value
    return outcome(toolPathPassingLines(all).includes(line), results)
  }
}
