// 一键检测里「查网址的服务（DNS）」这一项：用电脑自己的 DNS 查一遍当前账号两条线路的地址，再拿国内两家公共 DNS
// 查的结果对一下，看电脑的 DNS 有没有把星芒的地址查错、查不到。首页那句「把 DNS 改成 223.5.5.5 和 119.29.29.29」
// 只在两条线路都连不上时才出（tool-route-controller.ts 的 hijack），检查页里一直查不出来；10-25 客户 Mac 只用
// 114.114.114.114，它时好时坏地把两条线路都指到一台发自签证书的机器上，客户点「检查」看到的全是绿的。
//
// 只读、不改任何系统设置：改 DNS 要管理员，星芒只给步骤和「打开网络设置」。解析出来的 IP 不写进结论、报告和日志
// （xm 三线路需求 5.1.9），只记每条线路的结论和各类地址的个数。
import dns from 'node:dns'
import type { CheckDefinition, CheckOutcome, DiagnosticsRelayRoute } from './diagnostics'
import { relayLineNames, type DiagnosticsContext } from './diagnostics-context'
import { classifyNetworkFailure } from './network-failure'
import { relaySiteEndpointChoices, type RelayEndpointId } from './relay-sites'
import { classifyResolvedAddress, parseIpAddress, resolvedAddressCategories, type LegitimateAddresses } from './route-failure-classifier'
import type { RouteStatus } from './route-status-file'
import { toolRouteLegitimateAddresses } from './tool-route-controller'

/** 拿来对照的两家：首页那句提示叫客户改成的也是这两个（route-label.ts 的 hijack）。 */
export const publicDnsServers: readonly string[] = Object.freeze(['223.5.5.5', '119.29.29.29'])

// 电脑的 DNS 和公共 DNS 同时查，各自最多等这么久：整项只有 DEFAULT_CHECK_TIMEOUT_MS，平时几十毫秒就回来了。
const dnsLookupTimeoutMs = 3_000
// 公共 DNS 每台服务器只问一次：两台各等这么久，加起来也落在上面那个时限里。
const publicDnsQueryTimeoutMs = 1_400

/**
 * 一条线路的结论。ok = 查到的是这条线路自己的地址，或者和公共 DNS 查到的对得上；proxy = 查到的是 fake-ip、
 * 私网这类地址，查地址这一步被本机代理软件接管了，不替它判断；wrong = 查到的既不是这条线路的地址，也和公共
 * DNS 对不上；missing = 电脑的 DNS 查不到、公共 DNS 查得到；unknown = 两边对不出结论（公共 DNS 也没回、
 * 两边都不像这条线路的地址）。
 */
export type DnsLineVerdict = 'ok' | 'proxy' | 'wrong' | 'missing' | 'unknown'

export interface DnsLineAnswers {
  /** 电脑自己的 DNS 查到的地址；null = 没查到（查不到、超时）。 */
  system: readonly string[] | null
  /** 公共 DNS 查到的地址；null = 没查到。 */
  public: readonly string[] | null
  /** 这条线路这会儿哪些地址算它自己的（route-failure-classifier.ts）；null = 不知道。 */
  legitimate: LegitimateAddresses
}

function sameAddress(left: string, right: string): boolean {
  const a = parseIpAddress(left)
  const b = parseIpAddress(right)
  return a !== null && b !== null && a.family === b.family && a.value === b.value
}

export function dnsLineVerdict(answers: DnsLineAnswers): DnsLineVerdict {
  const { legitimate } = answers
  const system = answers.system ?? []
  const reference = answers.public ?? []
  if (!system.length) return reference.length ? 'missing' : 'unknown'
  const kinds = system.map((address) => classifyResolvedAddress(address, legitimate))
  if (kinds.includes('proxy')) return 'proxy'
  if (kinds.every((kind) => kind === 'normal')) return 'ok'
  if (!reference.length) return 'unknown'
  if (system.some((address) => reference.some((entry) => sameAddress(address, entry)))) return 'ok'
  // 公共 DNS 给的也不是这条线路的地址：两边都说不准（多半是手里的合法地址旧了），不下结论。
  if (legitimate && !reference.some((entry) => classifyResolvedAddress(entry, legitimate) === 'normal')) return 'unknown'
  // 线路2 读不到状态文件时没有合法地址可比；服务端出事时会把线路2 切到 CF，电脑这边缓存着新地址、公共 DNS
  // 还给旧的也说得通，所以全落在 CF 的地址段里就算对。
  if (!legitimate && system.every((address) => classifyResolvedAddress(address, { cloudflare: true }) === 'normal')) return 'ok'
  return 'wrong'
}

/**
 * 一条线路这会儿哪些地址算它自己的：线路1 是 CF 入口，看 CF 公布的地址段；星芒账号的线路2 看服务端的线路状态
 * 文件（和工具线路判劫持同一套，tool-route-controller.ts）；历史账号的线路2 没有状态文件，只能和公共 DNS 对。
 */
export function dnsLineLegitimateAddresses(siteId: string, line: RelayEndpointId, status: RouteStatus | null): LegitimateAddresses {
  if (line === 'primary') return { cloudflare: true }
  return siteId === 'solov' ? toolRouteLegitimateAddresses(line, status) : null
}

const dnsSettingsAdvice = '把电脑的 DNS 改成 223.5.5.5 和 119.29.29.29'

export const dnsCheckSummaries = {
  ok: '电脑的 DNS 查星芒的地址是对的',
  proxy: '查网址这一步交给了代理软件，这一项不用管',
  unknown: '这次没查出 DNS 对不对，稍后点「重新检查」再看一次',
  wrong: `你这台电脑用的 DNS 把星芒的地址查错了，AI 工具会连不上。${dnsSettingsAdvice}，或者换个网络（比如手机热点）再试。`,
  missing: `你这台电脑用的 DNS 查不到星芒的地址，AI 工具会连不上。${dnsSettingsAdvice}，或者换个网络（比如手机热点）再试。`,
} as const

/** 改 DNS 的入口每个系统都不一样；Windows、Mac 配着「打开网络设置」那颗按钮说。 */
export function dnsSettingsGuidance(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return '改法：点「打开网络设置」，点正在用的 WLAN 或以太网，找到「DNS 服务器分配」（Windows 10 在「IP 设置」里），点「编辑」，选「手动」，打开 IPv4，首选 DNS 填 223.5.5.5，备用 DNS 填 119.29.29.29，保存。'
  }
  if (platform === 'darwin') {
    return '改法：点「打开网络设置」，点正在用的 Wi-Fi 或以太网，再点「详细信息」里的「DNS」，用左下角的「+」加上 223.5.5.5 和 119.29.29.29，点「好」。'
  }
  return '改法：打开系统设置里的「网络」，在正在用的连接里把 DNS 改成 223.5.5.5 和 119.29.29.29。'
}

/** 「打开网络设置」只有 Windows、Mac 有（proxy-bypass.ts 的 networkSettingsTarget）。 */
function dnsSettingsFix(platform: NodeJS.Platform): Record<string, string> {
  return platform === 'win32' || platform === 'darwin' ? { fix: 'open-dns-settings' } : {}
}

function isBad(verdict: DnsLineVerdict | undefined): boolean {
  return verdict === 'wrong' || verdict === 'missing'
}

function otherLine(line: RelayEndpointId): RelayEndpointId {
  return line === 'primary' ? 'direct' : 'primary'
}

/**
 * 两条线路的结论合成一句。两条都查错（或一条查错、另一条没查出来）说改 DNS；只错一条、另一条是对的，选「自动」
 * 或者固定用的正是对的那条都不影响使用，只有固定用的正是查错的那条才要客户动手：「去处理」翻到设置里的线路那一行
 * （reroute），或者改 DNS。route 缺省按「自动」算。
 */
export function dnsCheckOutcome(input: {
  siteId: string
  verdicts: Partial<Record<RelayEndpointId, DnsLineVerdict>>
  route?: Pick<DiagnosticsRelayRoute, 'automatic' | 'line'>
  platform: NodeJS.Platform
}): CheckOutcome {
  const { siteId, verdicts, route, platform } = input
  const lines = (['primary', 'direct'] as const).filter((line) => verdicts[line] !== undefined)
  const details: Record<string, string> = { siteId }
  for (const line of lines) details[line === 'primary' ? 'line1' : 'line2'] = verdicts[line] ?? 'unknown'
  const bad = lines.filter((line) => isBad(verdicts[line]))
  const good = lines.filter((line) => verdicts[line] === 'ok')
  if (bad.length && !good.length) {
    const lead = bad.some((line) => verdicts[line] === 'wrong') ? dnsCheckSummaries.wrong : dnsCheckSummaries.missing
    return { state: 'fail', summary: `${lead}${dnsSettingsGuidance(platform)}`, details: { ...details, ...dnsSettingsFix(platform) } }
  }
  if (bad.length) {
    const badLine = bad[0]
    const goodLine = good.includes(otherLine(badLine)) ? otherLine(badLine) : good[0]
    const badName = relayLineNames[badLine]
    const goodName = relayLineNames[goodLine]
    const phrase = verdicts[badLine] === 'wrong' ? `把星芒${badName}的地址查错了` : `查不到星芒${badName}的地址`
    const lead = `你这台电脑用的 DNS ${phrase}，${goodName}是对的`
    if (!route || route.automatic) {
      return { state: 'pass', summary: `${lead}，星芒会自动用${goodName}，不影响使用。想彻底解决，${dnsSettingsAdvice}。`, details }
    }
    if (route.line !== badLine) {
      return { state: 'pass', summary: `${lead}。你选的是「只用${goodName}」，不影响使用。`, details }
    }
    return {
      state: 'warn',
      summary: `${lead}。你选的是「只用${badName}」，AI 工具会连不上：点「去处理」改成「自动」，或者${dnsSettingsAdvice}。${dnsSettingsGuidance(platform)}`,
      details: { ...details, ...dnsSettingsFix(platform), reroute: 'auto' },
    }
  }
  if (lines.some((line) => verdicts[line] === 'proxy')) return { state: 'pass', summary: dnsCheckSummaries.proxy, details }
  if (good.length) return { state: 'pass', summary: dnsCheckSummaries.ok, details }
  return { state: 'pass', summary: dnsCheckSummaries.unknown, details }
}

function withinDnsTimeout<T>(task: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      const error = new Error('查网址超时')
      error.name = 'TimeoutError'
      reject(error)
    }, dnsLookupTimeoutMs)
    timer.unref()
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 电脑自己的 DNS：和 Node 写的工具（Claude Code、npm）连星芒时问的是同一个地方（getaddrinfo，hosts 文件也算在内）。
 * 查不到、超时都抛出来，由调用方当成「没查到」。
 */
export function lookupWithSystemDns(host: string): Promise<string[]> {
  return withinDnsTimeout(dns.promises.lookup(host, { all: true, verbatim: true }).then((entries) => entries.map((entry) => entry.address)))
}

/**
 * 公共 DNS（223.5.5.5、119.29.29.29）：直接发 DNS 查询，不经系统的 DNS 设置和代理。只拿 A、AAAA 两种记录的
 * 地址，两种都没回才算没查到。整个查询有时限、到点就取消（I10 的「超时」；DNS 没有正文、跳转可言）。
 */
export async function lookupWithPublicDns(host: string): Promise<string[]> {
  const resolver = new dns.promises.Resolver({ timeout: publicDnsQueryTimeoutMs, tries: 1 })
  resolver.setServers([...publicDnsServers])
  const [ipv4, ipv6] = await withinDnsTimeout(
    Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]),
    () => resolver.cancel(),
  )
  const addresses = [
    ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
    ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
  ]
  if (!addresses.length) throw ipv4.status === 'rejected' ? ipv4.reason : new Error('公共 DNS 没有给出地址')
  return addresses
}

export function buildDnsChecks(context: DiagnosticsContext): CheckDefinition[] {
  // 查的是工具配置那个站的两条线路、按工具那条线路的设置下结论：AI 工具连的就是它（同「别的代理软件」）。
  const { dependencies, toolSite, toolRoute, platform, log } = context
  const lookupSystem = dependencies.lookupHost
  const lookupPublic = dependencies.lookupHostWithPublicDns
  // 宿主没接这两样（测试、旧的调用方）就不出这一项：缺省去查真的 DNS，测试就会对外发查询（T12）。
  if (!lookupSystem || !lookupPublic) return []
  return [{
    code: 'RELAY_DNS',
    title: '查网址的服务（DNS）',
    timeoutOutcome: { state: 'pass', summary: dnsCheckSummaries.unknown, details: { timedOut: true } },
    run: async (): Promise<CheckOutcome> => {
      const endpoints = relaySiteEndpointChoices(toolSite.id)
      if (!endpoints.length) return { state: 'pass', summary: '', omit: true }
      // 只用上次读到的那份状态文件，不为这一项去读：读一次最多要等 10 秒（route-status-file.ts）。
      let status: RouteStatus | null = null
      try { status = dependencies.routeStatus?.() ?? null } catch { status = null }
      const verdicts: Partial<Record<RelayEndpointId, DnsLineVerdict>> = {}
      const logged: Record<string, unknown> = {}
      await Promise.all(endpoints.map(async (endpoint) => {
        const host = new URL(endpoint.origin).hostname
        const legitimate = dnsLineLegitimateAddresses(toolSite.id, endpoint.id, status)
        let systemFailure: string | null = null
        const [system, reference] = await Promise.all([
          lookupSystem(host).catch((error: unknown) => {
            systemFailure = classifyNetworkFailure(error) ?? 'unknown'
            return null
          }),
          lookupPublic(host).catch(() => null),
        ])
        const verdict = dnsLineVerdict({ system, public: reference, legitimate })
        verdicts[endpoint.id] = verdict
        logged[relayLineNames[endpoint.id]] = {
          verdict,
          system: system ? resolvedAddressCategories(system, legitimate) : systemFailure,
          publicAnswered: Boolean(reference?.length),
        }
      }))
      const outcome = dnsCheckOutcome({ siteId: toolSite.id, verdicts, route: toolRoute, platform })
      log?.(outcome.state === 'pass' ? 'info' : 'warn', 'diagnostics.dns.checked', '查了一遍星芒两条线路的地址', logged)
      return outcome
    },
  }]
}
