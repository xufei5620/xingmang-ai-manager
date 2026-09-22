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
export function resolveRelaySite(id: string | null | undefined): RelaySite {
  if (typeof id === 'string') {
    const canonical = retiredRelaySiteIds.get(id) ?? id
    const found = relaySites.find((site) => site.id === canonical)
    if (found) return found
  }
  return relaySites[0]
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
export function requireRelaySite(id: unknown): RelaySite {
  const site = typeof id === 'string'
    ? relaySites.find((candidate) => candidate.id === id)
    : undefined
  if (!site) throw new Error('未知中转站点')
  return site
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
