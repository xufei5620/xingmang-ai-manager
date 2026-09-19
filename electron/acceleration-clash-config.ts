import { isIP } from 'node:net'
import { parseDocument, stringify } from 'yaml'

export const MAX_ACCELERATION_CLASH_BYTES = 2 * 1024 * 1024
const MAX_NODE_COUNT = 512

interface Hysteria2Connection {
  type: 'hysteria2'
  server: string
  port: number
  password: string
  sni?: string
  up?: number | string
  down?: number | string
  'skip-cert-verify': boolean
}

// Shared release nodes are versioned in bundled-acceleration by product policy.
// Runtime credentials stay in the main process, never diagnostics or IPC results.
export interface AccelerationClashNode {
  id: string
  label: string
  region: string
  protocol: 'hysteria2'
  connection: Hysteria2Connection
}

export interface AccelerationClashProfile {
  nodes: AccelerationClashNode[]
  sourceNodeCount: number
  unsupportedNodeCount: number
  metadataNodeCount: number
  duplicateNodeCount: number
  insecureTlsNodeCount: number
}

export interface IsolatedMihomoOptions {
  /** Zero disables the proxy listener for controller-only diagnostics. */
  mixedPort: number
  nodeId?: string
  controllerPort?: number
  controllerSecret?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`加速节点的${field}无效`)
  }
  return value
}

function requireHost(value: unknown, field: string): string {
  const host = requireText(value, 253, field)
  if (isIP(host)) return host
  if (!host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error(`加速节点的${field}无效`)
  }
  return host
}

function requirePort(value: unknown, local = false): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (local ? 1024 : 1) || value > 65535) {
    throw new Error(local ? '加速内核本地端口无效' : '加速节点的端口无效')
  }
  return value
}

function requireBandwidth(value: unknown): number | string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000) return value
  if (typeof value === 'string' && value.length <= 24 && /^\d+(?:\.\d+)?\s*(?:[kmg]bps)?$/i.test(value) && Number.parseFloat(value) > 0) return value
  throw new Error('加速节点的带宽参数无效')
}

function isMetadataNodeName(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 120 && /剩余(?:流量|额度)|(?:套餐|订阅)?(?:到期|过期)(?:时间|日期)?|流量(?:剩余|重置|用尽)|距离.*重置|重置.*(?:剩余|时间|天|小时)|(?:remaining|reset)\s*traffic|(?:traffic|subscription)\s*(?:remaining|expire|expiry)|expire(?:s|d)?\s*(?:at|on|date)/i.test(value)
}

function projectLineLabel(name: string, ordinal: number): { label: string; region: string } {
  const regions: [RegExp, string, string][] = [
    [/香港|Hong\s*Kong|\bHK\b|🇭🇰/i, 'HK', '香港'],
    [/台湾|台灣|Taiwan|\bTW\b|🇹🇼/i, 'TW', '台湾'],
    [/日本|Japan|\bJP\b|🇯🇵/i, 'JP', '日本'],
    [/新加坡|Singapore|\bSG\b|🇸🇬/i, 'SG', '新加坡'],
    [/美国|美國|United\s*States|\bUSA?\b|🇺🇸/i, 'US', '美国'],
    [/韩国|韓國|South\s*Korea|\bKR\b|🇰🇷/i, 'KR', '韩国'],
    [/英国|英國|United\s*Kingdom|\bUK\b|🇬🇧/i, 'GB', '英国'],
    [/德国|德國|Germany|\bDE\b|🇩🇪/i, 'DE', '德国'],
    [/加拿大|Canada|\bCA\b|🇨🇦/i, 'CA', '加拿大'],
    [/澳大利亚|澳洲|Australia|\bAU\b|🇦🇺/i, 'AU', '澳大利亚'],
    [/荷兰|荷蘭|Netherlands|\bNL\b|🇳🇱/i, 'NL', '荷兰'],
    [/法国|法國|France|\bFR\b|🇫🇷/i, 'FR', '法国'],
    [/印度|India|\bIN\b|🇮🇳/i, 'IN', '印度'],
    [/马来西亚|馬來西亞|Malaysia|\bMY\b|🇲🇾/i, 'MY', '马来西亚'],
    [/泰国|泰國|Thailand|\bTH\b|🇹🇭/i, 'TH', '泰国'],
  ]
  const region = regions.find(([pattern]) => pattern.test(name))
  return { region: region?.[1] ?? 'GLOBAL', label: `${region?.[2] ?? '全球'}线路 ${ordinal}` }
}

function projectHysteria2Connection(value: unknown): Hysteria2Connection {
  if (!isRecord(value) || value.type !== 'hysteria2') throw new Error('暂不支持此加速节点协议')
  if (value['skip-cert-verify'] !== undefined && typeof value['skip-cert-verify'] !== 'boolean') {
    throw new Error('加速节点的证书校验参数无效')
  }
  const connection: Hysteria2Connection = {
    type: 'hysteria2',
    server: requireHost(value.server, '服务器地址'),
    port: requirePort(value.port),
    password: requireText(value.password, 4096, '连接凭据'),
    'skip-cert-verify': value['skip-cert-verify'] === true,
  }
  if (value.sni !== undefined) connection.sni = requireHost(value.sni, 'TLS 主机名')
  if (value.up !== undefined) connection.up = requireBandwidth(value.up)
  if (value.down !== undefined) connection.down = requireBandwidth(value.down)
  return connection
}

function parseDocumentValue(source: string): unknown {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_ACCELERATION_CLASH_BYTES) {
    throw new Error('Clash 配置超过 2 MB 解析限制')
  }
  // Parser diagnostics include offending source lines, which may contain node
  // passwords or subscription URLs. Only return fixed, credential-free errors.
  try {
    const document = parseDocument(source, {
      schema: 'core',
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      strict: true,
      uniqueKeys: true,
      logLevel: 'silent',
    })
    if (document.errors.length || document.warnings.length) throw new Error('invalid yaml')
    return document.toJS({ maxAliasCount: 0 }) as unknown
  } catch {
    throw new Error('Clash 配置格式无效，或包含不支持的标签、别名')
  }
}

/** Parse inline nodes only; source providers, groups, rules and runtime settings are not imported. */
export function parseClashAccelerationProfile(source: string): AccelerationClashProfile {
  const value = parseDocumentValue(source)
  if (!isRecord(value) || !Array.isArray(value.proxies) || !value.proxies.length) {
    throw new Error('Clash 配置需要包含内联节点，暂不支持远程订阅提供器')
  }
  if (value.proxies.length > MAX_NODE_COUNT) throw new Error('Clash 配置节点数量超过 512 条限制')
  const profile: AccelerationClashProfile = {
    nodes: [],
    sourceNodeCount: value.proxies.length,
    unsupportedNodeCount: 0,
    metadataNodeCount: 0,
    duplicateNodeCount: 0,
    insecureTlsNodeCount: 0,
  }
  const seenConnections = new Set<string>()
  for (const [index, node] of value.proxies.entries()) {
    if (!isRecord(node)) throw new Error('Clash 节点格式无效')
    if (isMetadataNodeName(node.name)) {
      profile.metadataNodeCount += 1
      continue
    }
    // These options change transport or chain another proxy. Do not silently
    // remove them and then claim that the resulting connection is equivalent.
    if (node.type !== 'hysteria2' || ['obfs', 'obfs-password', 'ports', 'hop-interval', 'dialer-proxy'].some((key) => node[key] !== undefined)) {
      profile.unsupportedNodeCount += 1
      continue
    }
    const connection = projectHysteria2Connection(node)
    const connectionIdentity = JSON.stringify(connection)
    if (seenConnections.has(connectionIdentity)) {
      profile.duplicateNodeCount += 1
      continue
    }
    seenConnections.add(connectionIdentity)
    const name = requireText(node.name, 120, '线路名称')
    profile.nodes.push({
      id: `line-${index + 1}`,
      ...projectLineLabel(name, profile.nodes.length + 1),
      protocol: 'hysteria2',
      connection,
    })
    if (connection['skip-cert-verify']) profile.insecureTlsNodeCount += 1
  }
  if (!profile.nodes.length) throw new Error('Clash 配置没有可用节点，目前支持 Hysteria2 基础连接')
  return profile
}

/** Contains credentials: write only to private runtime storage and remove it after stopping the core. */
export function buildIsolatedMihomoConfig(profile: AccelerationClashProfile, options: IsolatedMihomoOptions): string {
  const mixedPort = options.mixedPort === 0 ? 0 : requirePort(options.mixedPort, true)
  if (mixedPort === 0 && options.controllerPort === undefined) throw new Error('关闭代理监听时必须设置加速内核控制端口')
  const selected = options.nodeId === undefined ? profile.nodes : profile.nodes.filter((node) => node.id === options.nodeId)
  if (!selected.length) throw new Error('所选加速线路不存在')
  if (selected.length > MAX_NODE_COUNT || new Set(selected.map((node) => node.id)).size !== selected.length) {
    throw new Error('加速线路列表无效')
  }
  // Re-project even typed input so callers cannot accidentally merge arbitrary
  // configuration back into the core boundary. Names are controlled internal IDs.
  const proxies = selected.map((node) => {
    if (!/^line-[1-9]\d{0,2}$/.test(node.id)) throw new Error('加速线路标识无效')
    return { name: node.id, ...projectHysteria2Connection(node.connection) }
  })
  const config: Record<string, unknown> = {
    'mixed-port': mixedPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    ipv6: false,
    mode: 'rule',
    'log-level': 'silent',
    'find-process-mode': 'off',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    tun: { enable: false },
    dns: { enable: false },
    sniffer: { enable: false },
    proxies,
    'proxy-groups': [{ name: 'XINGMANG', type: 'select', proxies: proxies.map((proxy) => proxy.name) }],
    rules: ['MATCH,XINGMANG'],
  }
  if (options.controllerPort !== undefined) {
    const controllerPort = requirePort(options.controllerPort, true)
    if (controllerPort === mixedPort) throw new Error('加速内核的代理端口与控制端口不能相同')
    if (typeof options.controllerSecret !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(options.controllerSecret)) {
      throw new Error('加速内核控制凭据无效')
    }
    config['external-controller'] = `127.0.0.1:${controllerPort}`
    config.secret = options.controllerSecret
  } else if (options.controllerSecret !== undefined) {
    throw new Error('加速内核控制端口未设置')
  }
  return stringify(config, { lineWidth: 0 })
}
