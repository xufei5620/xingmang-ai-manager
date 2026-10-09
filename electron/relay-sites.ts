// Zero Node dependency, same as catalog.ts -- this file is imported into the
// renderer bundle via ipc-contract.ts's value re-export (I6). Pulling in any
// node:* module here would make Vite try to bundle it for the browser and
// fail the build (or worse, leak main-process code into the renderer).
//
// A "relay site" is a CLI-facing AI-API-proxy endpoint: it owns the base
// URLs the four CLIs are pointed at, plus the marketing/keys pages a user is
// sent to from the app. This is a distinct axis from RelayBackendClient
// (relay-backend.ts), which is the *account* backend (login/balance/key
// management) a site delegates to -- accountBackend/accountBaseUrl below
// name which one, but the actual account API calls still go through
// new-api-client.ts today.
import { providerBaseUrls, type ProviderId } from './catalog'

export type RelayEndpointId = 'primary' | 'direct'

/**
 * 设置里存的线路偏好：「自动」由星芒自己在直连和默认线路之间挑，另外两个写死一条。
 * 没存过的算「自动」；#872 起存下的 primary / direct 原样当「只用默认线路」「只用直连」。
 */
export type RelayRoutePreference = 'auto' | RelayEndpointId

/** 能选线路的两个站，同时是设置里 relayEndpointIds 的键。 */
export type RelayRouteSiteId = 'solov' | 'solov-api'

export const relayRouteSiteIds: readonly RelayRouteSiteId[] = Object.freeze(['solov', 'solov-api'] as const)

export interface RelayRoutePreferences {
  solov?: RelayRoutePreference
  'solov-api'?: RelayRoutePreference
}

/** 一个站这会儿走的线路。 */
export interface RelayRouteLine {
  line: RelayEndpointId
  /**
   * 是不是定下来的：写死的偏好、上次存下的结论、这次探出来的都算，星芒账号没有结论时开机直接定在
   * 直连也算（relay-route-controller.ts）。历史账号「自动」第一次开机还没探出结论时先走默认线路，
   * 这时为 false，工具配置不跟着它迁。
   */
  settled: boolean
}

export type RelayRouteLines = Readonly<Record<RelayRouteSiteId, Readonly<RelayRouteLine>>>

export interface RelayEndpoint {
  id: RelayEndpointId
  label: string
  origin: string
  /** Retained native configuration identities; never automatic account failover targets. */
  aliases?: readonly string[]
}

export interface RelayEndpointRoutingSnapshot {
  /** 开机时生效的偏好，这次运行里不变：设置里改了要重启才生效。 */
  readonly preferences: Readonly<Required<RelayRoutePreferences>>
  /** 每个站这会儿走的线路。「自动」会在运行中改线路，所以每次现读。 */
  lines(): RelayRouteLines
  resolve(siteId: string | null | undefined): RelaySite
  require(siteId: unknown): RelaySite
  /**
   * 工具配置可以迁到的那条线路：写死的偏好，或者「自动」已经定下的那条。「自动」还没定下来时
   * 是 undefined，认得出的旧地址照旧原样留着。
   */
  selection(siteId: unknown): RelayEndpointId | undefined
}

export interface RelaySite {
  /** Stable identifier persisted in AppSettings.relaySiteId. Never reused for a different site. */
  id: string
  /** Chinese display name shown in any future site picker. */
  label: string
  /** Per-CLI relay base URL, written into each provider's native config file. */
  providerBaseUrls: Record<ProviderId, string>
  /** Marketing/home page opened from "官方网站"-style buttons. */
  websiteUrl: string
  /** Page a user is sent to in order to obtain/manage an API key. */
  keysPageUrl: string
  /** Which account backend (if any) this site's login/balance/key-management UI talks to. */
  accountBackend: 'new-api' | 'sub2api'
  /** Account API origin for this site. */
  accountBaseUrl?: string
}

// Non-empty tuple type: resolveRelaySite's "never throws" contract and
// defaultRelaySiteId's module-load-time [0] access both lean on this array
// having at least one element, and this module is bundled into BOTH the main
// process and the renderer -- an empty array here would be a white screen at
// import time. The tuple makes that a compile error instead of a test-only
// guarantee. readonly also keeps the renderer-bundle copy from being
// mutated by accident (display-only there; every security decision reads the
// main-process copy).
//
// Until D-10 this array also carried a 'sub2api' entry that was a
// field-for-field duplicate of 'solov' (same domain, same providerBaseUrls
// object, same label) -- an alias kept so older settings files still
// resolved. A duplicate entry is not what keeps those files working, the id
// mapping below is, so the entry is gone and only the mapping remains.
// Since 2026-08-10 the xm relay domain is xm.solov.cc (the new-api instance
// itself), unifying CLI traffic with the account backend. catalog.ts remains
// the single source of truth for the fixed per-CLI relay URLs either way
// (T2's rank-table precedent: derive, never duplicate literals).
export const relaySites: readonly [RelaySite, ...RelaySite[]] = [
  {
    id: 'solov',
    // 命名已由老板拍板(2026-08-10):品牌统一「星芒AI」,括号内仅保留账号模式的最小区分
    label: '星芒AI（账号登录）',
    providerBaseUrls,
    // 官网/取 Key 页指向账号域 xm.solov.cc(老板拍板 2026-08-10;同日
    // 中转也统一切到 xm,见 catalog.ts)。中转连通性探测不借用
    // websiteUrl,走 relayApiProbeBaseUrl(见下)——今天两者恰好同域,
    // 但探测必须永远跟着 CLI 实际调用的域走,不跟营销页走。
    websiteUrl: 'https://xm.solov.cc',
    keysPageUrl: 'https://xm.solov.cc/keys',
    accountBackend: 'new-api',
    accountBaseUrl: 'https://xm.solov.cc',
  },
  {
    id: 'solov-api',
    label: '星芒AI（历史账号）',
    providerBaseUrls: {
      claude: 'https://api.solov.cc',
      codex: 'https://api.solov.cc/v1',
      grok: 'https://api.solov.cc/v1',
      gemini: 'https://api.solov.cc',
    },
    websiteUrl: 'https://api.solov.cc',
    keysPageUrl: 'https://api.solov.cc/keys',
    accountBackend: 'sub2api',
    accountBaseUrl: 'https://api.solov.cc',
  },
]

// Canonical browser fallbacks for the two legal documents. The primary UI
// renders their public /api/* Markdown payloads inside the app; these URLs
// remain allowlisted for the explicit "在浏览器打开" fallback only.
//
// D-11: 这两份文档对所有账号恒定指向 xm，而下面的 resolveSupportServiceUrl
// 却按 realm 分客服 —— 这个不对称是有意的，不是漏配。协议与隐私政策是同一
// 家运营方的同一份文本，两个账号体系共用；客服企微则是两拨人在值守，必须分
// 开。api 账号侧的后端本身就把 getLegalDocument 标成 unsupported
// (sub2api-relay-backend.ts)，realm-account-service.ts 因此把它恒定路由到
// xm 的公共客户端，renderer 的 getLegal 也固定传 'solov'。要改成按账号取各
// 自的协议，得先在服务端各自发布一份 —— 那超出客户端范围，别在这里凭 realm
// 拼出一个 api 域的法律文档地址。
export const userAgreementUrl = 'https://xm.solov.cc/user-agreement'
export const privacyPolicyUrl = 'https://xm.solov.cc/privacy-policy'
export const supportServiceUrl = 'https://work.weixin.qq.com/kfid/kfc3ac7eece5344c034'
export const sub2ApiSupportServiceUrl = 'https://work.weixin.qq.com/kfid/kfcffe6f62fdaa0ccf4'

export function resolveSupportServiceUrl(session?: { authenticated: boolean; siteId?: string; realmId?: string } | null): string {
  return session?.authenticated && (session.siteId === 'solov-api' || session.realmId === 'api-account')
    ? sub2ApiSupportServiceUrl
    : supportServiceUrl
}

/**
 * The relay's own API origin, for connectivity probes (the models-list fetch
 * in system-service.ts and diagnostics' status-endpoint check). websiteUrl doubled as
 * this until the marketing pages moved to the account domain (2026-08-10) --
 * probes must keep hitting the relay domain the CLIs actually call, so they
 * derive from providerBaseUrls instead of the user-facing URL. claude's base
 * is the bare relay origin (no /v1 suffix, unlike Codex and Grok), which is
 * exactly the shape both probe call sites append their paths to.
 */
export function relayApiProbeBaseUrl(site: RelaySite): string {
  return site.providerBaseUrls.claude
}

export const defaultRelaySiteId: string = relaySites[0].id

const siteEndpoints = new Map<string, readonly RelayEndpoint[]>([
  ['solov', Object.freeze([
    Object.freeze({ id: 'primary' as const, label: '默认线路', origin: 'https://xm.solov.cc' }),
    // 直连走自己的域名（证书是公共签发的，照常校验），服务器 IP 只在服务端 DNS 里，换 IP 不用发版。
    // 38.147.105.28:8443 是服务端的临时测试入口，域名版发出去以后关掉：只留作别名，认得出、迁得走
    // 按它写过的旧配置，新配置一律写域名，加速规则也不带它。
    Object.freeze({ id: 'direct' as const, label: '备用直连', origin: 'https://xm-direct.solov.cc',
      aliases: Object.freeze(['https://38.147.105.28:8443']) }),
  ])],
  ['solov-api', Object.freeze([
    Object.freeze({ id: 'primary' as const, label: '默认线路', origin: 'https://api.solov.cc' }),
    // 历史账号的直连：服务端给的域名，白名单里放着星芒用到的历史账号接口（sub2api-relay-backend.ts
    // 写死的是默认线路的地址，改走直连靠 relay-line-fetch.ts 换请求地址，那个文件不动）。
    Object.freeze({ id: 'direct' as const, label: '备用直连', origin: 'https://api-direct.solov.cc' }),
  ])],
])

/** URLs never come from settings or IPC: each backend owns an exact endpoint set. */
export function relaySiteEndpointChoices(siteId: unknown): readonly RelayEndpoint[] {
  return typeof siteId === 'string' ? siteEndpoints.get(siteId) ?? [] : []
}

function requireRelayEndpoint(siteId: string, endpointId: unknown): RelayEndpoint {
  const endpoint = relaySiteEndpointChoices(siteId).find((candidate) => candidate.id === (endpointId ?? 'primary'))
  if (!endpoint) throw new Error('所选站点的连接线路无效')
  return endpoint
}

export function relayProviderBaseUrls(siteId: unknown, endpointId: RelayEndpointId = 'primary'): Record<ProviderId, string> {
  const site = requireRelaySiteIdentity(siteId)
  if (endpointId === 'primary') return { ...site.providerBaseUrls }
  const { origin } = requireRelayEndpoint(site.id, endpointId)
  return providerUrlsForOrigin(origin)
}

function providerUrlsForOrigin(origin: string): Record<ProviderId, string> {
  return { claude: origin, codex: `${origin}/v1`, gemini: origin, grok: `${origin}/v1` }
}

function knownEndpointOrigins(endpoint: RelayEndpoint): readonly string[] {
  return [endpoint.origin, ...endpoint.aliases ?? []]
}

/**
 * Every address one provider of a site is known by, aliases included, with the
 * line it belongs to. Recognition only: a configuration found on an alias moves
 * to the line's own origin, nothing is ever written to an alias.
 */
export function relaySiteProviderBaseUrlVariants(siteId: unknown, provider: ProviderId): { endpointId: RelayEndpointId; baseUrl: string }[] {
  return relaySiteEndpointChoices(siteId).flatMap((endpoint) => knownEndpointOrigins(endpoint)
    .map((origin) => ({ endpointId: endpoint.id, baseUrl: providerUrlsForOrigin(origin)[provider] })))
}

function withRelayEndpoint(site: RelaySite, endpointId: unknown): RelaySite {
  const endpoint = requireRelayEndpoint(site.id, endpointId)
  if (endpoint.id === 'primary') return site
  return Object.freeze({ ...site, accountBaseUrl: endpoint.origin,
    providerBaseUrls: Object.freeze(relayProviderBaseUrls(site.id, endpoint.id)) })
}

function normalizedRelayBaseUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

export function relaySiteEndpointIdForBaseUrl(siteId: unknown, provider: ProviderId, value: string): RelayEndpointId | null {
  const normalized = normalizedRelayBaseUrl(value)
  if (!normalized) return null
  for (const endpoint of relaySiteEndpointChoices(siteId)) {
    for (const origin of knownEndpointOrigins(endpoint)) {
      if (normalizedRelayBaseUrl(providerUrlsForOrigin(origin)[provider]) === normalized) return endpoint.id
    }
  }
  return null
}

/**
 * 配置里这个地址到底是哪条线路：只认每条线路自己的地址，逐字比（xm 三线路 C12）。落在退役别名上的
 * 不算那条线路（它实际不走那条线路的中转），和本站以外的地址一样是 other。
 */
export function relaySiteExactEndpointIdForBaseUrl(siteId: unknown, provider: ProviderId, value: string): RelayEndpointId | 'other' {
  for (const endpoint of relaySiteEndpointChoices(siteId)) {
    if (relayProviderBaseUrlEquals(value, providerUrlsForOrigin(endpoint.origin)[provider])) return endpoint.id
  }
  return 'other'
}

/** Preserve a recognized native route until the user explicitly selects a line. */
export function relaySiteForProviderBaseUrl(siteId: unknown, provider: ProviderId, value: string): RelaySite | null {
  const normalized = normalizedRelayBaseUrl(value)
  if (!normalized) return null
  for (const endpoint of relaySiteEndpointChoices(siteId)) {
    for (const origin of knownEndpointOrigins(endpoint)) {
      if (normalizedRelayBaseUrl(providerUrlsForOrigin(origin)[provider]) !== normalized) continue
      const site = requireRelaySiteIdentity(siteId)
      return Object.freeze({ ...site, accountBaseUrl: origin, providerBaseUrls: Object.freeze(providerUrlsForOrigin(origin)) })
    }
  }
  return null
}

/** A selected backend may recognize its own aliases, never another site's origin. */
export function relayProviderBaseUrlMatches(provider: ProviderId, actual: string, expected: string): boolean {
  const normalized = normalizedRelayBaseUrl(actual)
  if (!normalized) return false
  if (normalized === normalizedRelayBaseUrl(expected)) return true
  for (const site of relaySites) {
    if (relaySiteEndpointIdForBaseUrl(site.id, provider, expected) !== null) {
      return relaySiteEndpointIdForBaseUrl(site.id, provider, actual) !== null
    }
  }
  return false
}

/** The configuration names exactly this address: the line's own origin, never one of its aliases. */
export function relayProviderBaseUrlEquals(actual: string, expected: string): boolean {
  const normalized = normalizedRelayBaseUrl(actual)
  return normalized !== null && normalized === normalizedRelayBaseUrl(expected)
}

/** A preference names 'auto' or a line of that site; no setting can borrow another site's line or name a site without lines. */
export function relayRoutePreferenceAllowed(siteId: unknown, value: unknown): value is RelayRoutePreference {
  const endpoints = relaySiteEndpointChoices(siteId)
  return endpoints.length > 0 && (value === 'auto' || endpoints.some((endpoint) => endpoint.id === value))
}

/**
 * The site and line a request URL is addressed to, by exact origin. Only each line's own origin
 * counts: an alias is a retired entry kept for recognizing old configurations, never a target.
 */
export function relayEndpointForUrl(value: string): { siteId: RelayRouteSiteId; endpointId: RelayEndpointId } | null {
  let origin: string
  try { origin = new URL(value).origin } catch { return null }
  for (const siteId of relayRouteSiteIds) {
    const endpoint = relaySiteEndpointChoices(siteId).find((candidate) => candidate.origin === origin)
    if (endpoint) return { siteId, endpointId: endpoint.id }
  }
  return null
}

/** The origin a site's line is reached at; null when the site has no such line. */
export function relayEndpointOrigin(siteId: unknown, endpointId: RelayEndpointId): string | null {
  return relaySiteEndpointChoices(siteId).find((endpoint) => endpoint.id === endpointId)?.origin ?? null
}

/**
 * Every address a site has been reached at: each line's own origin and its retired aliases.
 * Recognition only, like knownEndpointOrigins: lets a record kept per address be found again.
 */
export function relaySiteKnownOrigins(siteId: unknown): readonly string[] {
  return relaySiteEndpointChoices(siteId).flatMap(knownEndpointOrigins)
}

function requireRelayRoutePreference(siteId: RelayRouteSiteId, value: unknown): RelayRoutePreference {
  if (value === undefined) return 'auto'
  if (!relayRoutePreferenceAllowed(siteId, value)) throw new Error('所选站点的连接线路无效')
  return value
}

/** Every site gets a preference: one not stored is 'auto'; a stored one must be that site's own choice. */
export function resolveRelayRoutePreferences(value: RelayRoutePreferences = {}): Readonly<Required<RelayRoutePreferences>> {
  return Object.freeze({
    solov: requireRelayRoutePreference('solov', value.solov),
    'solov-api': requireRelayRoutePreference('solov-api', value['solov-api']),
  })
}

function resolveRouteLine(siteId: RelayRouteSiteId, preference: RelayRoutePreference, reported: RelayRouteLine | undefined): RelayRouteLine {
  if (preference !== 'auto') return { line: preference, settled: true }
  if (reported && relaySiteEndpointChoices(siteId).some((endpoint) => endpoint.id === reported.line)) {
    return { line: reported.line, settled: reported.settled === true }
  }
  // 「自动」还没有结论：照旧走默认线路，也不拿它去迁工具配置。
  return { line: 'primary', settled: false }
}

/**
 * Preferences freeze at process startup; saving one cannot mutate live clients. Under 'auto' the line
 * itself may move during the run, so every read asks `currentLines` (relay-route-controller.ts).
 * Without it, 'auto' stays on the primary line, unsettled: nothing migrates, as before #872.
 */
export function createRelayEndpointRoutingSnapshot(
  value: RelayRoutePreferences = {},
  currentLines?: () => Partial<Record<RelayRouteSiteId, RelayRouteLine>>,
): RelayEndpointRoutingSnapshot {
  const preferences = resolveRelayRoutePreferences(value)
  const sites = new Map(relaySites.flatMap((identity) => relaySiteEndpointChoices(identity.id).map((endpoint) => {
    const selected = withRelayEndpoint(identity, endpoint.id)
    return [`${identity.id}:${endpoint.id}`, Object.freeze({ ...selected, providerBaseUrls: Object.freeze({ ...selected.providerBaseUrls }) })] as const
  })))
  function lines(): RelayRouteLines {
    const reported = currentLines?.() ?? {}
    return Object.freeze({
      solov: Object.freeze(resolveRouteLine('solov', preferences.solov, reported.solov)),
      'solov-api': Object.freeze(resolveRouteLine('solov-api', preferences['solov-api'], reported['solov-api'])),
    })
  }
  function lineOf(siteId: string): RelayRouteLine | undefined {
    return siteId === 'solov' || siteId === 'solov-api' ? lines()[siteId] : undefined
  }
  function siteOn(identity: RelaySite): RelaySite | undefined {
    return sites.get(`${identity.id}:${lineOf(identity.id)?.line ?? 'primary'}`)
  }
  return Object.freeze({
    preferences,
    lines,
    resolve(siteId: string | null | undefined) {
      return siteOn(resolveRelaySite(siteId)) ?? sites.get(`${defaultRelaySiteId}:primary`)!
    },
    require(siteId: unknown) {
      const selected = siteOn(requireRelaySiteIdentity(siteId))
      if (!selected) throw new Error('未知中转站点')
      return selected
    },
    selection(siteId: unknown) {
      const current = lineOf(requireRelaySiteIdentity(siteId).id)
      return current?.settled ? current.line : undefined
    },
  })
}

/**
 * 写进工具配置用的线路快照（xm 三线路 5.1.0）：星芒账号读工具线路（tool-route-controller.ts），它一直是
 * 定下来的；历史账号照旧读应用线路（relay-route-controller.ts），所以它那边一行不变。偏好是同一份。
 */
export function createToolRouteRoutingSnapshot(
  value: RelayRoutePreferences,
  applicationLines: () => Partial<Record<RelayRouteSiteId, RelayRouteLine>>,
  toolLine: () => RelayEndpointId,
): RelayEndpointRoutingSnapshot {
  return createRelayEndpointRoutingSnapshot(value, () => ({ ...applicationLines(), solov: { line: toolLine(), settled: true } }))
}

/**
 * Retired site ids that older settings files may still name, mapped to the
 * site they always denoted. 'sub2api' was a duplicate registry entry for xm
 * (D-10), never a distinct relay: resolving it here keeps such a file
 * loading without paying for a second entry every consumer has to special-
 * case. A Map, not a plain object, so an untrusted id can never reach
 * Object.prototype.
 *
 * Tolerant recovery only. requireRelaySite deliberately does NOT consult
 * this map: an explicit selection that crosses an account boundary must
 * name a live site exactly (see its own doc comment).
 */
const retiredRelaySiteIds = new Map<string, string>([['sub2api', 'solov']])

/**
 * Resolves a persisted site id to its RelaySite, always falling back to the
 * default site for anything unrecognized -- including null/undefined (no
 * site chosen yet) and a stale id from a settings file written by a future
 * version that removed a site. A settings file must never be able to make
 * the app fail to start, so this never throws.
 */
export function resolveRelaySite(id: string | null | undefined, endpointId: RelayEndpointId = 'primary'): RelaySite {
  if (typeof id === 'string') {
    const canonical = retiredRelaySiteIds.get(id) ?? id
    const found = relaySites.find((site) => site.id === canonical)
    if (found) return withRelayEndpoint(found, endpointId)
  }
  return withRelayEndpoint(relaySites[0], endpointId)
}

/**
 * Resolves an explicit site selection without a default-site fallback.
 * Use this for future account-routing boundaries, not settings recovery:
 * a missing, malformed or unavailable site must never send credentials to
 * a different account backend. IDs are exact, case-sensitive identifiers;
 * URLs, labels and whitespace-padded values are not accepted as aliases.
 *
 * Registry membership is not authorization. IPC callers must still
 * validate the sender and bind the site to a main-process-owned active
 * identity before accessing credentials or starting account work.
 */
function requireRelaySiteIdentity(id: unknown): RelaySite {
  const site = typeof id === 'string'
    ? relaySites.find((candidate) => candidate.id === id)
    : undefined
  if (!site) throw new Error('未知中转站点')
  return site
}

export function requireRelaySite(id: unknown, endpointId: RelayEndpointId = 'primary'): RelaySite {
  return withRelayEndpoint(requireRelaySiteIdentity(id), endpointId)
}

/**
 * External URLs a relay site's own UI buttons open: the marketing site and
 * the keys page. Recharge is handled inside the desktop account center.
 * main.ts folds this into its `externalUrlAllowlist` (I12, href full
 * equality); kept here as a pure function, rather than inlined in main.ts,
 * so the derivation is unit-testable without importing Electron (main.ts
 * has no test file for exactly that reason -- see AGENTS.md T-notes).
 *
 * Deduplicated via Set: the registry has held two entries sharing one relay
 * domain before (the sub2api alias, removed in D-10), and may again if a
 * future site reuses an existing marketing page. The allowlist is a
 * membership set (I12 checks href full equality against it), so a duplicate
 * entry would be harmless there -- dedup here is about keeping this
 * function's own output (and its test's pinned list) minimal and honest
 * about the *distinct* URL set, not a security requirement.
 */
export function relaySiteExternalUrls(sites: readonly RelaySite[]): string[] {
  const urls = sites.flatMap((site) => [
    site.websiteUrl,
    site.keysPageUrl,
  ])
  return [...new Set(urls)]
}

/**
 * Hosts the account's own services live on: login, balance, key issuing and
 * the relay every CLI calls. The acceleration core routes these DIRECT
 * (acceleration-clash-config.ts), so switching a line on never detours our
 * own traffic. Every registered site is included, not just the signed-in
 * one: switching accounts while accelerated does not restart the core.
 * Lowercased and deduplicated; non-https URLs are skipped.
 */
export function relayDirectHosts(sites: readonly RelaySite[] = relaySites): string[] {
  return relayDirectAddresses(sites).filter((host) => !isLiteralIpHost(host))
}

/** Fixed IP endpoints need IP-CIDR rules; DNS-only rule inputs remain strict. */
export function relayDirectIps(sites: readonly RelaySite[] = relaySites): string[] {
  return relayDirectAddresses(sites).filter(isLiteralIpHost).map((host) => host.replace(/^\[|\]$/g, ''))
}

function isLiteralIpHost(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[')
}

function relayDirectAddresses(sites: readonly RelaySite[]): string[] {
  const hosts = new Set<string>()
  for (const site of sites) {
    for (const url of [...Object.values(site.providerBaseUrls), site.accountBaseUrl, site.websiteUrl, site.keysPageUrl]) {
      if (!url) continue
      const parsed = new URL(url)
      if (parsed.protocol === 'https:') hosts.add(parsed.hostname.toLowerCase())
    }
    // 只带各条线路自己的地址：别名只用来认旧配置，旧的 IP 测试入口要关掉，不该还出现在加速规则里。
    for (const endpoint of relaySiteEndpointChoices(site.id)) hosts.add(new URL(endpoint.origin).hostname.toLowerCase())
  }
  return [...hosts]
}
