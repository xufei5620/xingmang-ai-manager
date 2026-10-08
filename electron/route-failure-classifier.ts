import net from 'node:net'

/**
 * 工具线路探测没走通时，给它打个标签（xm 三线路 C6，需求 5.1.2）。通不通只看端到端结果，这里不判
 * 通不通：IP 只用来说清「为什么没通」。否则 CF 线路解析出来的是 CF 的 IP、会被永远判失败；用 Clash /
 * Surge 的 fake-ip 或 TUN 的客户会被当成劫持。
 *
 * - normal：解析到这条线路的合法地址上（洛杉矶、香港看状态文件给的地址；CF 线路，或者状态文件说这条
 *   已经被切到 CF 的，看 Cloudflare 公布的地址段）。
 * - proxy：解析到 fake-ip / 私网 / 回环这类地址，是本机代理软件接管了解析，不算劫持、不提示。
 * - unknown：不认识的地址，或者状态文件读不到、手里没有合法地址可比。调用方先不走缓存重读一次
 *   状态文件再下结论；读不到就一直是 unknown，不判劫持（需求 7.4）。
 * - hijack：地址不在合法集合里，握手又因为证书或 TLS 没过，也不是代理接管。
 */
export type RouteFailureLabel = 'normal' | 'proxy' | 'unknown' | 'hijack'

interface ParsedAddress {
  family: 4 | 6
  value: bigint
}

interface AddressRange {
  family: 4 | 6
  base: bigint
  prefix: number
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    result = (result << 8n) | BigInt(octet)
  }
  return result
}

function parseIpv6(value: string): bigint | null {
  let text = value.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  // 末尾嵌着 IPv4 的写法（::ffff:1.2.3.4）先换成两段十六进制。
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) {
    const v4 = parseIpv4(dotted[2])
    if (v4 === null) return null
    text = `${dotted[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  let result = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    result = (result << 16n) | BigInt(parseInt(group, 16))
  }
  return result
}

/** 一个 IP 字面量；不是 IP（域名、带端口、带方括号）返回 null。 */
export function parseIpAddress(value: string): ParsedAddress | null {
  const family = net.isIP(value)
  if (family === 4) {
    const parsed = parseIpv4(value)
    return parsed === null ? null : { family: 4, value: parsed }
  }
  if (family === 6) {
    const parsed = parseIpv6(value)
    if (parsed === null) return null
    // IPv4 映射地址（::ffff:a.b.c.d）按它里面那个 IPv4 算：系统解析偶尔这样回。
    if (parsed >> 32n === 0xffffn) return { family: 4, value: parsed & 0xffffffffn }
    return { family: 6, value: parsed }
  }
  return null
}

function parseRange(cidr: string): AddressRange {
  const [address, prefixText] = cidr.split('/')
  const parsed = parseIpAddress(address)
  const prefix = Number(prefixText)
  if (!parsed || !Number.isInteger(prefix) || prefix < 0 || prefix > (parsed.family === 4 ? 32 : 128)) {
    throw new Error(`地址段写错了：${cidr}`)
  }
  return { family: parsed.family, base: parsed.value, prefix }
}

function inRange(address: ParsedAddress, range: AddressRange): boolean {
  if (address.family !== range.family) return false
  const width = BigInt(address.family === 4 ? 32 : 128)
  const shift = width - BigInt(range.prefix)
  return address.value >> shift === range.base >> shift
}

// https://www.cloudflare.com/ips/ 公布的地址段（2026-10 抄）。CF 线路本来就解析到这里。
export const cloudflareAddressRanges: readonly string[] = Object.freeze([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
])

// 本机代理软件接管解析时会落在这些段：RFC 2544 基准测试段（Clash / Surge fake-ip 的默认段）、
// RFC 1918 私网、RFC 6598 共享地址、回环；IPv6 的 ULA、链路本地、回环。
export const proxyTakeoverAddressRanges: readonly string[] = Object.freeze([
  '198.18.0.0/15', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8',
  'fc00::/7', 'fe80::/10', '::1/128',
])

const cloudflareRanges = cloudflareAddressRanges.map(parseRange)
const proxyTakeoverRanges = proxyTakeoverAddressRanges.map(parseRange)

/**
 * 一条线路这会儿哪些地址算它自己的。cloudflare = CF 线路，或者状态文件说这条被切到了 CF（proxied）；
 * ips = 状态文件给的合法地址。null = 不知道（状态文件读不到，又不是 CF 线路）。
 */
export type LegitimateAddresses = { cloudflare: true } | { cloudflare: false; ips: readonly string[] } | null

/** 解析出来的一个地址算哪一类；proxy 优先于「不认识」，但排在合法地址后面。 */
export function classifyResolvedAddress(address: string, legitimate: LegitimateAddresses): 'normal' | 'proxy' | 'unknown' {
  const parsed = parseIpAddress(address)
  if (!parsed) return 'unknown'
  if (legitimate?.cloudflare && cloudflareRanges.some((range) => inRange(parsed, range))) return 'normal'
  if (legitimate && !legitimate.cloudflare && legitimate.ips.some((entry) => {
    const known = parseIpAddress(entry)
    return known !== null && known.family === parsed.family && known.value === parsed.value
  })) return 'normal'
  if (proxyTakeoverRanges.some((range) => inRange(parsed, range))) return 'proxy'
  return 'unknown'
}

/**
 * 一次没走通的探测打什么标签。addresses 是探测时系统解析出来的全部地址；tlsRejected = 握手因为
 * 证书或 TLS 被重置没过（DNS 失败、连不上、超时都不算）。
 */
export function classifyRouteFailure(input: {
  addresses: readonly string[]
  legitimate: LegitimateAddresses
  tlsRejected: boolean
}): RouteFailureLabel {
  const kinds = input.addresses.map((address) => classifyResolvedAddress(address, input.legitimate))
  if (!kinds.length) return 'unknown'
  if (kinds.includes('proxy')) return 'proxy'
  if (kinds.every((kind) => kind === 'normal')) return 'normal'
  // 手里没有合法地址可比时一律不认识，不判劫持（需求 7.4）。
  if (input.legitimate === null) return 'unknown'
  return input.tlsRejected ? 'hijack' : 'unknown'
}

/** 日志里只记解析结果的类别，不记 IP（需求 5.1.9）。 */
export function resolvedAddressCategories(addresses: readonly string[], legitimate: LegitimateAddresses): Record<'normal' | 'proxy' | 'unknown', number> {
  const counts = { normal: 0, proxy: 0, unknown: 0 }
  for (const address of addresses) counts[classifyResolvedAddress(address, legitimate)] += 1
  return counts
}
