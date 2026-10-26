// 一键检测里「网络与代理」那几项（#1070 第 9 步，从 diagnostics.ts 的 runDiagnostics 原样搬来）：星芒 AI 网络（向当前站点
// 的公开状态接口发一次请求，「自动」先走的那条没查通就改查备用那条，顺带比一次系统时间）、安全证书（用跑工具的那个
// Node.js 握手两次）、代理软件的全局接管模式（Clash Verge Rev）、电脑里的代理设置（另外设的代理；系统设置里的代理归
// diagnostics-proxy-software-check.ts 的「别的代理软件」）。前两项挨着排在工具那几项后面，后两项排在磁盘与文件夹
// 那几项后面，所以分成 buildNetworkChecks、buildProxyChecks 两段。
//
// 各类检查共用的那份在 diagnostics-context.ts；这里只 import diagnostics.ts 的类型，免得两个文件互相 require。
import fs from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'
import {
  buildNodeTlsProbeScript,
  certificateTrustNetworkFailedSummary,
  certificateTrustSummaries,
  certificateTrustVerdict,
  nodeTlsProbeEnvironment,
  nodeTlsProbeTimeoutMs,
  parseNodeTlsProbeOutput,
  type CertificateTrustVerdict,
  type NodeTlsProbeResult,
} from './certificate-trust-probe'
import { commandEnvironment, runCommand } from './command-runner'
import type {
  CheckDefinition,
  CheckOutcome,
  DiagnosticItem,
  DiagnosticsRelayRoute,
  DiagnosticState,
  NodeTlsProbeInput,
  ProxyVariableSummary,
} from './diagnostics'
import { errorChainText, relayLineNames, type DiagnosticsContext } from './diagnostics-context'
import { pathForDisplay } from './diagnostics-redaction'
import { isRecord } from './input-guards'
import { classifyNetworkFailure, isJsonContentType, networkFailureCode, networkFailureMessages, type NetworkFailureReason } from './network-failure'
import { relayLineFailureAnswer, relayLineFailureReason, reportedRelayLineFailure } from './relay-line-fetch'
import { firstLaunchTrigger, relayRouteFailureThreshold, relayRouteRecoveryMs, requestFailuresTrigger, type RelayRouteChange } from './relay-route-controller'
import {
  relayApiProbeBaseUrl, relayEndpointForUrl, relaySiteEndpointChoices, requireRelaySite,
  type RelayEndpointId, type RelayRouteLines, type RelaySite,
} from './relay-sites'
import {
  inspectProxyVariables,
  probeLoopbackProxy,
  readWindowsProxyScopes,
  type LoopbackProbe,
  type ProxyVariableFinding,
  type ProxyVariableScopes,
} from './stale-proxy-environment'

// 「自动」走先走的那条时那一次最多等这么久，剩下的留给备用那条：整项只有 DEFAULT_CHECK_TIMEOUT_MS。
const PREFERRED_NETWORK_PROBE_TIMEOUT_MS = 4_000

/**
 * 差多少才值得说。证书校验本身有容差，本机时钟与服务器差几十秒也是常态，
 * 阈值定低了就是每次检查都亮一条没人能处理的黄灯。
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_CLASH_CONFIG_BYTES = 2 * 1024 * 1024
/** 两个站的状态接口都只回几 KB 的 JSON；门户页再大也用不着读完才认出来。 */
const MAX_NETWORK_PROBE_BYTES = 256 * 1024
const MAX_YAML_ALIAS_COUNT = 20
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY'] as const

function clashCandidates(homeDirectory: string, env: NodeJS.ProcessEnv): string[] {
  const appData = env.APPDATA
  const xdgConfig = env.XDG_CONFIG_HOME
  return [...new Set([
    appData && path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    appData && path.join(appData, 'clash-verge-rev', 'clash-verge.yaml'),
    xdgConfig && path.join(xdgConfig, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    path.join(homeDirectory, '.config', 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    path.join(homeDirectory, '.config', 'clash-verge-rev', 'clash-verge.yaml'),
  ].filter((entry): entry is string => Boolean(entry)).map((entry) => path.resolve(entry)))]
}

export function parseClashTunConfig(source: string): boolean {
  if (Buffer.byteLength(source, 'utf8') > MAX_CLASH_CONFIG_BYTES) {
    throw new Error('Clash 配置文件超过解析限制')
  }
  const document = parseDocument(source, {
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: false,
    strict: true,
    uniqueKeys: true,
    logLevel: 'silent',
  })
  if (document.errors.length || document.warnings.length) {
    throw new Error('Clash YAML 包含不受支持的结构或标签')
  }
  const value = document.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT }) as unknown
  if (!isRecord(value)) throw new Error('Clash YAML 顶层必须是映射')

  if (value.enable_tun_mode === true || value.tun_mode === true) return true
  const tun = value.tun
  return isRecord(tun) && tun.enable === true
}

async function defaultProxyVariables(env: NodeJS.ProcessEnv): Promise<ProxyVariableSummary[]> {
  const result: ProxyVariableSummary[] = []
  const pairs = Object.entries(env)
  for (const name of PROXY_NAMES) {
    const match = pairs.find(([candidate]) => candidate.toUpperCase() === name)
    if (match?.[1]?.trim()) result.push({ name, source: 'process' })
  }
  return result
}

function proxyFindingDetails(findings: readonly ProxyVariableFinding[]): Record<string, string> {
  return Object.fromEntries(findings.map((finding) => [
    finding.name,
    finding.target ? `本机 ${finding.target.port} 端口（${finding.reach === 'open' ? '开着' : '没开'}）` : '别的机器',
  ]))
}

/**
 * 「电脑里的代理设置」（第十六批 5）。看的是本软件自己的环境——从这里打开的工具
 * 拿到的就是它——再读一次当前账号与整台电脑各设了什么，决定能不能一键清掉。
 * details 只写变量名和本机端口，不写原值：原值里可能带着代理的用户名和密码。
 */
export async function windowsProxySettingsOutcome(
  env: NodeJS.ProcessEnv,
  probe: LoopbackProbe,
  readScopes: () => Promise<ProxyVariableScopes | null>,
): Promise<Omit<DiagnosticItem, 'code' | 'title' | 'durationMs'>> {
  const findings = await inspectProxyVariables(env, probe)
  // 系统设置里的代理归「别的代理软件」那一项说（diagnostics-proxy-software-check.ts）：这里只管另外设的那几条，
  // 和 Mac 上同一句，免得系统代理开着时两行说法打架。
  if (!findings.length) return { state: 'pass', summary: '没有另外设过代理' }
  const closed = findings.filter((finding) => finding.reach === 'closed')
  const details = proxyFindingDetails(findings)
  if (closed.length) {
    const port = closed[0].target?.port
    const scopes = await readScopes().catch(() => null)
    const userClosed = scopes ? (await inspectProxyVariables(scopes.user, probe)).some((finding) => finding.reach === 'closed') : false
    const machineClosed = scopes ? (await inspectProxyVariables(scopes.machine, probe)).some((finding) => finding.reach === 'closed') : false
    const lead = `电脑里设了一个代理（本机 ${port} 端口），但它现在没开。`
    if (userClosed) {
      return {
        state: 'warn',
        summary: `${lead}从星芒打开的工具会自动绕开它；你自己开的命令行窗口可能还是连不上。`,
        details: { ...details, fix: 'clear-user-proxy', port: port ?? null },
      }
    }
    return {
      state: 'warn',
      summary: machineClosed
        ? `${lead}这条设置是给整台电脑设的，要管理员才能改。从星芒打开的工具已经会自动绕开它。`
        : `${lead}从星芒打开的工具会自动绕开它。`,
      details,
    }
  }
  const remote = findings.find((finding) => finding.reach === 'remote')
  if (remote) {
    return {
      state: 'warn',
      summary: '电脑里设了代理，工具会通过它联网。如果工具连不上，先确认这个代理能用。',
      details,
    }
  }
  return {
    state: 'pass',
    summary: `电脑里设了代理（本机 ${findings[0].target?.port} 端口），工具会通过它联网。`,
    details,
  }
}

/** Windows 以外只列环境变量的名字和来源，不探端口（旧行为）。 */
function otherProxySettingsOutcome(
  variables: readonly ProxyVariableSummary[],
): Omit<DiagnosticItem, 'code' | 'title' | 'durationMs'> {
  const unique = [...new Map(variables.map((item) => [`${item.name}:${item.source}`, item])).values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
  return {
    state: unique.length ? 'warn' : 'pass',
    summary: unique.length ? `电脑里另外设了 ${unique.length} 处代理，详情里能看到` : '没有另外设过代理',
    details: Object.fromEntries(unique.map((item, index) => [`variable${index + 1}`, `${item.name} (${item.source})`])),
  }
}

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

type RelayStatusProbe =
  | { kind: 'answered'; endpoint: string; response: Response; body: string }
  | { kind: 'failed'; endpoint: string; reason: NetworkFailureReason; error: unknown }

// 直连那一次换成默认线路有可能查得通：连不上一类的失败（含代理回绝了直连这个地址），或者直连回的
// 不是星芒的回话（网关错误页、拦截页），同 relay-line-fetch.ts 的退回条件；白名单挡下的网页 404 也算，
// 检查页要知道的是这会儿连不连得上。状态接口正常时一定回 JSON，回了 200 却读不出 JSON 的，同下面
// 认拦截的口径。服务回的 JSON 错误是服务那一侧的事，两条线路一样。给出报给线路那边的原因，不然 null。
function relayLineFailure(probe: RelayStatusProbe): string | null {
  if (probe.kind === 'failed') return relayLineFailureReason(probe.error) ? networkFailureCode(probe.error) ?? probe.reason : null
  const { response, body } = probe
  if (response.status === 404 && !isJsonContentType(response.headers.get('content-type'))) return 'http-404'
  if (response.ok && !parsesAsJson(body)) return 'intercepted'
  return relayLineFailureAnswer(response)
}

/**
 * 要不要报给线路那边、叫它马上查一轮健康检查（#941 第 3 节）：同 relay-line-fetch.ts 的口径，加上直连那
 * 几秒里一个字都没回来也算——状态接口只回几百字节，等不到它就是这会儿不通，不是慢。报上去也只是叫线路
 * 那边连着查几次，换不换由它定。
 */
function reportsRelayLineFailure(probe: RelayStatusProbe): boolean {
  if (probe.kind === 'answered') return true
  return reportedRelayLineFailure(probe.error) !== null || probe.reason === 'timeout'
}

/**
 * 「星芒 AI 网络」查通时那句结论。fellBack：选的是「自动」，先走的那条这会儿连不上，用的是备用那条（这次
 * 当场退回的，或者之前就已经退回的）。星芒账号先走线路2（直连）、备用线路1（CF）；历史账号先走线路1、
 * 备用线路2（yoyo 10-14）。线路名见下面的 relayLineNames。
 */
export function relayNetworkPassSummary(route: { siteId: string; line: RelayEndpointId; fellBack: boolean } | null, accelerating: boolean): string {
  if (!route) return accelerating ? '能连上星芒服务（开着加速时也直接连，不绕加速线路）' : '能连上星芒服务'
  const summary = route.siteId === 'solov'
    ? route.line === 'direct'
      ? '能连上星芒服务，用的是线路2'
      : route.fellBack ? '能连上星芒服务。线路2这会儿连不上，已自动改走线路1' : '能连上星芒服务，用的是线路1'
    : route.fellBack
      ? '能连上星芒服务。线路1这会儿连不上，已自动改走线路2'
      : route.line === 'direct' ? '能连上星芒服务，用的是线路2' : '能连上星芒服务，用的是线路1'
  return accelerating ? `${summary}（开着加速也不绕加速线路）` : summary
}

function parsesAsJson(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

/**
 * 一张证书有没有过期，是拿本机时钟去比出来的：系统时间差得多，每一张正常的证书
 * 都会当场变成「已过期」，于是登录、装 CLI、检查更新一起卡在证书校验这一步，而
 * 用户看到的只是「换个网络」。HTTP 的 Date 头里就带着服务器那一侧的时间，顺手比
 * 一次不用新发任何请求。
 *
 * 没有 Date 头、或者这个头不是一个能解析的时间，就返回 null——宁可不说，也不要
 * 拿一个解析不出来的值去吓用户。
 */
export function clockSkewMs(dateHeader: string | null | undefined, now: Date): number | null {
  if (!dateHeader) return null
  const serverTime = Date.parse(dateHeader)
  if (!Number.isFinite(serverTime)) return null
  return now.getTime() - serverTime
}

/** 对时入口每个系统都不一样，说不清具体在哪一页的提示等于没说。 */
export function clockSyncGuidance(platform: NodeJS.Platform): string {
  if (platform === 'win32') return '请在「设置 → 时间和语言 → 日期和时间」里打开「自动设置时间」，并确认时区正确。'
  if (platform === 'darwin') return '请在「系统设置 → 通用 → 日期与时间」里打开「自动设置时间和日期」，并确认时区正确。'
  // Linux 各家桌面的设置页叫法不一，Ubuntu、deepin、统信都有「日期和时间」这一页。
  return '请打开系统设置里的「日期和时间」，把时间设为自动同步（有的系统叫「自动设置日期和时间」），并确认时区正确。'
}

/**
 * 「自动」最近一次换线路，写进「星芒 AI 网络」那一项导出的报告（#941 第 2、7 节）：什么时候、为什么、
 * 换到哪条，不带地址。时间按这台电脑的时区说。按记下的 from、to 说：历史账号 0.2.18 及以前先走线路2（直连），
 * 0.2.19 起先走线路1（yoyo 10-14），两种记录都说得对。两个账号的线路名一样，不用分站。
 */
export function describeRelayRouteChange(change: RelayRouteChange): string {
  const at = new Date(change.at)
  const time = `${at.getMonth() + 1}月${at.getDate()}日 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const from = relayLineNames[change.from]
  const to = relayLineNames[change.to]
  const reason = change.reason === 'recovered'
    ? `${to}连着 ${relayRouteRecoveryMs / 60_000} 分钟都能连上，换回${to}`
    : change.reason === 'line-down'
      ? `查到${from}没连上、${to}能连上，当场改走${to}`
      : change.reason === 'health-failed'
        ? change.trigger === firstLaunchTrigger
          ? `第一次开机查到${from}没连上，改走${to}`
          : change.trigger === requestFailuresTrigger
            ? `${from}上的请求接连断在半路、等不来回话，改走${to}`
            : `${from}连着 ${relayRouteFailureThreshold} 次没连上，改走${to}`
        : `查到${to}能连上，走${to}`
  return `${time}，${reason}`
}

// 连同引起那一轮检查的错误码一起只进导出的报告，客服拿它对服务端的日志。
function relayRouteChangeDetails(route: DiagnosticsRelayRoute | undefined): Record<string, string> {
  const change = route?.lastChange
  if (!route || !change) return {}
  return { lastRouteChange: describeRelayRouteChange(change), ...(change.trigger ? { lastRouteChangeTrigger: change.trigger } : {}) }
}

async function defaultProbeNodeTls(
  input: NodeTlsProbeInput,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<NodeTlsProbeResult> {
  try {
    // 普通权限那条路（provider-launch-service.ts 的 sameUserTerminalEnvironment）同样是
    // commandEnvironment：量的就是装工具、打开工具时真实会用到的那个 Node。
    const result = await runCommand({
      executable: input.nodePath,
      argv: ['-e', buildNodeTlsProbeScript(), input.host, String(input.port)],
    }, {
      env: nodeTlsProbeEnvironment(commandEnvironment(env), input.useSystemRoots),
      timeoutMs: nodeTlsProbeTimeoutMs + 2_000,
      maxOutputBytes: 4 * 1024,
      signal,
    })
    return parseNodeTlsProbeOutput(result.stdout)
  } catch {
    return { outcome: 'other', version: null }
  }
}

/** 探测地址拆成握手用的主机和端口；不是 https 就不探。 */
export function certificateProbeTarget(endpoint: string): { host: string, port: number } | null {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || !url.hostname) return null
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 443 }
  } catch {
    return null
  }
}

export function certificateTrustOutcome(input: {
  verdict: CertificateTrustVerdict
  nodeVersion: string | null
  defaultRoots: NodeTlsProbeResult['outcome'] | null
  systemRoots: NodeTlsProbeResult['outcome'] | null
  elevated: boolean
}): CheckOutcome {
  const state: DiagnosticState = input.verdict === 'outdatedNode' || input.verdict === 'untrusted'
    ? 'fail'
    : input.verdict === 'elevated' ? 'warn' : 'pass'
  return {
    state,
    summary: certificateTrustSummaries[input.verdict],
    details: {
      verdict: input.verdict,
      nodeVersion: input.nodeVersion,
      defaultRoots: input.defaultRoots,
      systemRoots: input.systemRoots,
      elevated: input.elevated,
    },
  }
}

/**
 * 「安全证书」判成 untrusted（收到的证书连这台电脑也不认）时，若同一次检查里「星芒 AI 网络」也失败了，
 * 根子多半在网络那一项（门户、公司网关拦截、断网），不在这里再怪一次证书。
 */
export function reconcileCertificateTrustWithNetwork(items: DiagnosticItem[]): DiagnosticItem[] {
  const networkFailed = items.some((item) => item.code === 'XINGMANG_NETWORK' && item.state === 'fail')
  if (!networkFailed) return items
  return items.map((item) => item.code === 'CERTIFICATE_TRUST' && item.details?.verdict === 'untrusted'
    ? { ...item, summary: certificateTrustNetworkFailedSummary }
    : item)
}

export function buildNetworkChecks(context: DiagnosticsContext): CheckDefinition[] {
  const { dependencies, env, platform, relaySite, sanitize, inspectTool, log, now } = context
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  // 「星芒 AI 网络」那一次请求回完话没有，超时那一刻看它决定结论。
  let relayAnswered = false

  return [
    {
      // 这一项此前把任何失败都交给 runIsolatedCheck 的兜底，于是 DNS 解析不了、
      // 公司网关换掉证书、酒店 Wi-Fi 门户劫持在页面上长得一模一样：一句「检查时
      // 发生错误」，原因还是一行英文，藏在详情抽屉里。归类复用 network-failure.ts
      // （登录页用的是同一份文案），判断只用这里本来就要发的这一次请求。
      code: 'XINGMANG_NETWORK',
      title: '星芒 AI 网络',
      // 一直等不到回话的，以前算成检查自己出错（「检查超时」）。可当地网络切断一条线路时
      // 常常就是这样：请求发出去，没人回。所以按连不上算，结论用登录页同一句超时的话。
      // 回完了话、卡在后面的（问加速开没开要排在正开关加速的后面）不算：网络是通的，照旧
      // 「检查超时」，说成连不上会把人带去换线路。
      timeoutOutcome: () => relayAnswered ? undefined : {
        state: 'fail',
        summary: networkFailureMessages.timeout,
        details: { endpoint: relayStatusProbeUrl(relaySite), reason: 'timeout', siteId: relaySite.id, ...relayRouteChangeDetails(dependencies.relayRoute) },
      },
      run: async (signal): Promise<CheckOutcome> => {
        if (!fetchImpl) throw new Error('当前运行时不支持 fetch')
        const fetchStatus = fetchImpl
        async function probeStatus(site: RelaySite, probeSignal: AbortSignal): Promise<RelayStatusProbe> {
          const endpoint = relayStatusProbeUrl(site)
          try {
            const response = await fetchStatus(endpoint, {
              method: 'GET',
              credentials: 'omit',
              redirect: 'error',
              signal: probeSignal,
              headers: { Accept: 'application/json' },
            })
            // 只有 2xx 才看内容；非 2xx 的错误页不读，免得一张大错误页顶掉下面那句 HTTP 状态。
            let body = ''
            if (response.ok) body = await readBoundedResponseText(response, MAX_NETWORK_PROBE_BYTES, '星芒 AI 状态接口')
            else await response.body?.cancel().catch(() => undefined)
            relayAnswered = true
            return { kind: 'answered', endpoint, response, body }
          } catch (error) {
            // 「自动」给先走那条那一次单独限的时间到了（整项还没到点）：按超时算，下面改查备用那条。
            const reason = error instanceof Error && error.name === 'TimeoutError' && !signal.aborted
              ? 'timeout'
              : classifyNetworkFailure(error)
            // 认不出来就照旧抛给兜底。把一个跟网络无关的故障说成「换个网络再试」，
            // 只会让用户白折腾一轮（同 network-failure.ts 的口径）。
            if (!reason) throw error
            return { kind: 'failed', endpoint, reason, error }
          }
        }
        const route = dependencies.relayRoute
        // 应用线路最近一次换线 + 工具线路那几样：只进导出的报告。
        function routeDetails(): Record<string, string> {
          let toolDetails: Record<string, string> = {}
          try { toolDetails = dependencies.toolRoute?.report?.() ?? {} } catch { toolDetails = {} }
          return { ...relayRouteChangeDetails(route), ...toolDetails }
        }
        // 星芒账号先走直连、备用默认线路；历史账号先走默认线路、备用直连（DiagnosticsRelayRoute）。
        const preferredLine = route?.preferredLine ?? 'direct'
        const preferredFirst = route?.automatic === true && route.line === preferredLine
        let probe = await probeStatus(relaySite, preferredFirst
          ? AbortSignal.any([signal, AbortSignal.timeout(PREFERRED_NETWORK_PROBE_TIMEOUT_MS)])
          : signal)
        let line: RelayEndpointId | null = route?.line ?? null
        let fellBack = false
        const preferredFailure = route && preferredFirst ? relayLineFailure(probe) : null
        if (route?.automatic && !preferredFirst) {
          // 已经退到备用那条：它也没查通就报给线路那边，两条一起查一轮，先走的那条通了当场切回去（#1053）。
          // 这一次不回头查先走的那条，查的是这会儿用的那条，结论照它说。
          const backupFailure = relayLineFailure(probe)
          if (backupFailure && reportsRelayLineFailure(probe)) route.reportLineFailure(backupFailure)
        }
        if (route && preferredFailure) {
          if (reportsRelayLineFailure(probe)) route.reportLineFailure(preferredFailure)
          // 先走那条回的网关错误页不算「网络通了」：备用那条这次要是一直没人回，照样按连接超时说。
          relayAnswered = false
          const retry = await probeStatus(route.backupSite ?? route.primarySite, signal).catch(() => null)
          // 备用那条也没查通就照先走那条的结论说：用的是它，说的就是它那边的事。
          if (retry?.kind === 'answered' && retry.response.ok && parsesAsJson(retry.body)) {
            log?.('info', 'diagnostics.network.fallback', '先走的那条线路这次没查通，备用那条查通了', {
              reason: probe.kind === 'failed' ? probe.reason : preferredFailure,
            })
            probe = retry
            line = preferredLine === 'direct' ? 'primary' : 'direct'
            fellBack = true
          }
        }
        const endpoint = probe.endpoint
        if (probe.kind === 'failed') {
          const { reason, error } = probe
          log?.('warn', 'diagnostics.network.failed', `星芒 AI 网络检查失败（${reason}）`, {
            endpoint,
            reason,
            raw: sanitize(errorChainText(error)),
          })
          // 带上查的是哪个站：检查页据此认出「换一条线路」救不救得回来（第四十三批 B）。
          // 新界面的「查看详情」不摆这个键（diagnostic-details.ts）。
          return { state: 'fail', summary: networkFailureMessages[reason], details: { endpoint, reason, siteId: relaySite.id, ...routeDetails() } }
        }
        const { response, body } = probe
        // 门户认证页的另一种形态：请求明明成功，回来的却是一张 HTML 登录页。
        // 这时没有异常可归类，只能从内容认出来：这个接口正常时一定回 JSON，
        // 拿到别的（网页、空白）就是中间有东西替服务器答了话。
        if (response.ok && !parsesAsJson(body)) {
          const contentType = response.headers.get('content-type') ?? ''
          log?.('warn', 'diagnostics.network.failed', '星芒 AI 网络检查被拦截（intercepted）', {
            endpoint,
            reason: 'intercepted',
            status: response.status,
            contentType,
          })
          return {
            state: 'fail',
            summary: networkFailureMessages.intercepted,
            details: { endpoint, reason: 'intercepted', status: response.status, ...routeDetails() },
          }
        }
        if (!response.ok) {
          log?.('warn', 'diagnostics.network.failed', `星芒 AI 网络检查返回 HTTP ${response.status}`, {
            endpoint,
            status: response.status,
          })
          // 网络本身是通的，所以不该说「换个网络」：这是服务端那一侧的事。
          return {
            state: 'fail',
            summary: `网络能连通，但星芒 AI 返回 HTTP ${response.status}，多半是服务端暂时的问题，请稍后再试。`,
            details: { endpoint, status: response.status, ...routeDetails() },
          }
        }
        // 这一次请求已经拿到了响应头，Date 就在里面：顺手和本机时间比一次，
        // 把「证书日期对不上」的真正源头提前抓出来，不新增任何请求。
        const skewMs = clockSkewMs(response.headers.get('date'), now())
        if (skewMs !== null && Math.abs(skewMs) > MAX_CLOCK_SKEW_MS) {
          const minutes = Math.round(Math.abs(skewMs) / 60_000)
          return {
            state: 'warn',
            summary: `能连上星芒服务，但这台电脑的系统时间与服务器相差约 ${minutes} 分钟，`
              + `可能让登录、安装、更新卡在证书校验这一步。${clockSyncGuidance(platform)}`,
            details: { endpoint, status: response.status, clockSkewMinutes: Math.round(skewMs / 60_000), ...routeDetails() },
          }
        }
        const accelerating = await dependencies.inspectAccelerationActive?.().catch(() => false) ?? false
        return {
          state: 'pass',
          // 状态码留在 details 里给导出报告，结论只说人话。
          summary: relayNetworkPassSummary(route && line ? { siteId: relaySite.id, line, fellBack: fellBack || (route.automatic && route.settled && line !== preferredLine) } : null, accelerating),
          details: {
            endpoint,
            status: response.status,
            ...(accelerating ? { route: 'direct' } : {}),
            ...(line ? { line } : {}),
            ...(fellBack ? { fellBack: true } : {}),
            ...routeDetails(),
          },
        }
      },
    },
    {
      // 公司的上网审计、安全软件的网页扫描会换掉所有网页的证书。星芒自己走 Chromium
      // 不受影响（上面那一项永远是绿的），工具那一侧走 Node.js，要看它认不认。
      // 只做说明、不决定软件行为，所以超时不亮红灯。
      code: 'CERTIFICATE_TRUST',
      title: '安全证书',
      timeoutOutcome: {
        state: 'pass',
        summary: '电脑这会儿比较忙，安全证书这一项没来得及查完，稍后点「重新检测」再看一次。',
        details: { timedOut: true },
      },
      run: async (signal): Promise<CheckOutcome> => {
        const node = await inspectTool('node', signal)
        if (!node.installed || !node.path) return { state: 'pass', summary: '', omit: true }
        // 以管理员身份打开时工具那一侧刻意不带这个开关（trustedCommandEnvironment），
        // 也就不替它起进程去量：结论只有一个。
        if (platform === 'win32' && dependencies.windowsExecution?.mode === 'trusted-only') {
          return certificateTrustOutcome({
            verdict: 'elevated',
            nodeVersion: node.version,
            defaultRoots: null,
            systemRoots: null,
            elevated: true,
          })
        }
        const target = certificateProbeTarget(relayStatusProbeUrl(relaySite))
        if (!target) return { state: 'pass', summary: '', omit: true }
        const probe = dependencies.probeNodeTls ?? ((input, probeSignal) => defaultProbeNodeTls(input, probeSignal, env))
        const [withoutSwitch, withSwitch] = await Promise.all([
          probe({ nodePath: node.path, ...target, useSystemRoots: false }, signal),
          probe({ nodePath: node.path, ...target, useSystemRoots: true }, signal),
        ])
        const nodeVersion = withoutSwitch.version ?? withSwitch.version ?? node.version
        const verdict = certificateTrustVerdict({
          defaultRoots: withoutSwitch.outcome,
          systemRoots: withSwitch.outcome,
          nodeVersion,
        })
        return certificateTrustOutcome({
          verdict,
          nodeVersion,
          defaultRoots: withoutSwitch.outcome,
          systemRoots: withSwitch.outcome,
          elevated: false,
        })
      },
    },
  ]
}

export function buildProxyChecks(context: DiagnosticsContext): CheckDefinition[] {
  const { dependencies, env, userHome, displayRoots, platform } = context
  const paths = dependencies.clashConfigPaths ?? clashCandidates(userHome, env)
  const inspectProxy = dependencies.inspectProxyVariables ?? ((signal) => defaultProxyVariables(env))

  return [
    {
      code: 'CLASH_VERGE_TUN',
      title: '代理软件的全局接管模式',
      run: () => {
        let detectedPath: string | null = null
        for (const candidate of paths) {
          if (!fs.existsSync(candidate)) continue
          detectedPath ??= candidate
          const enabled = parseClashTunConfig(readBoundedUtf8FileSync(
            candidate,
            MAX_CLASH_CONFIG_BYTES,
            'Clash 配置文件',
          ))
          if (enabled) {
            return {
              state: 'warn',
              summary: 'Clash Verge Rev 开着全局接管模式，可能让工具连不上。用不到时先把它关掉',
              details: { enabled: true, path: pathForDisplay(candidate, displayRoots) },
            }
          }
        }
        return {
          state: 'pass',
          summary: detectedPath ? 'Clash Verge Rev 没开全局接管模式' : '没发现 Clash Verge Rev',
          details: { enabled: false, path: pathForDisplay(detectedPath, displayRoots) },
        }
      },
    },
    {
      code: 'PROXY_ENVIRONMENT',
      title: '电脑里的代理设置',
      // 系统设置里的代理（别的代理软件）是下一项（diagnostics-proxy-software-check.ts），这里只看另外设的。
      run: async (signal) => platform === 'win32'
        ? windowsProxySettingsOutcome(
          env,
          dependencies.probeLoopbackProxy ?? probeLoopbackProxy,
          dependencies.readProxyScopes ?? (() => readWindowsProxyScopes()),
        )
        : otherProxySettingsOutcome(await inspectProxy(signal)),
    },
  ]
}
