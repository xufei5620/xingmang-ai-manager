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
// new-api-client.ts today. A site can in principle have CLI base URLs
// without any account backend at all (accountBackend: 'manual-key' is the
// W3 placeholder for a sub2api-style site where users paste in their own
// key rather than logging in through this app).
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
  accountBackend: 'new-api' | 'manual-key'
  /** Only present when accountBackend is 'new-api' -- the new-api-client.ts origin for this site. */
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
// solov and sub2api deliberately share the same relay domain (api.solov.cc)
// and the same providerBaseUrls object (by reference, not a copy) -- per the
// boss's reconciliation, they are the same relay with two different account
// models bolted on, not two different relays. catalog.ts remains the single
// source of truth for the fixed per-CLI relay URLs either way (T2's
// rank-table precedent: derive, never duplicate literals).
export const relaySites: readonly [RelaySite, ...RelaySite[]] = [
  {
    id: 'solov',
    // 命名已由老板拍板(2026-08-10):品牌统一「星芒AI」,括号内仅保留账号模式的最小区分
    label: '星芒AI（账号登录）',
    providerBaseUrls,
    // 官网/取 Key 页统一指向账号域 xm.solov.cc(老板拍板 2026-08-10:
    // api.solov.cc 只作 CLI 中转,所有面向用户的网页入口走 xm)。中转连通
    // 性探测不再借用 websiteUrl,改走 relayApiProbeBaseUrl(见下)。
    websiteUrl: 'https://xm.solov.cc',
    keysPageUrl: 'https://xm.solov.cc/keys',
    accountBackend: 'new-api',
    accountBaseUrl: 'https://xm.solov.cc',
  },
  {
    id: 'sub2api',
    label: '星芒AI（Key 直连）',
    providerBaseUrls,
    websiteUrl: 'https://xm.solov.cc',
    keysPageUrl: 'https://xm.solov.cc/keys',
    accountBackend: 'manual-key',
  },
]

// 用户协议/隐私政策页,挂在账号域下。注册/登录弹窗与欢迎页脚的协议文案
// 点击后经 openExternal 打开;main.ts 把这两个地址并入外链白名单(I12,
// href 全等)。改地址时两处会一起变,不会出现"可点但被白名单拦下"。
export const userAgreementUrl = 'https://xm.solov.cc/terms'
export const privacyPolicyUrl = 'https://xm.solov.cc/privacy'

/**
 * The relay's own API origin, for connectivity probes (the models-list fetch
 * in system-service.ts and diagnostics' HEAD check). websiteUrl doubled as
 * this until the marketing pages moved to the account domain (2026-08-10) --
 * probes must keep hitting the relay domain the CLIs actually call, so they
 * derive from providerBaseUrls instead of the user-facing URL. claude's base
 * is the bare relay origin (no /v1 suffix, unlike grok's), which is exactly
 * the shape both probe call sites append their paths to.
 */
export function relayApiProbeBaseUrl(site: RelaySite): string {
  return site.providerBaseUrls.claude
}

export const defaultRelaySiteId: string = relaySites[0].id

/**
 * Resolves a persisted site id to its RelaySite, always falling back to the
 * default site for anything unrecognized -- including null/undefined (no
 * site chosen yet) and a stale id from a settings file written by a future
 * version that removed a site. A settings file must never be able to make
 * the app fail to start, so this never throws.
 */
export function resolveRelaySite(id: string | null | undefined): RelaySite {
  if (typeof id === 'string') {
    const found = relaySites.find((site) => site.id === id)
    if (found) return found
  }
  return relaySites[0]
}

/**
 * External URLs a relay site's own UI buttons open: the marketing site, the
 * keys page, and -- for a new-api backed site -- the wallet/recharge page.
 * main.ts folds this into its `externalUrlAllowlist` (I12, href full
 * equality); kept here as a pure function, rather than inlined in main.ts,
 * so the derivation is unit-testable without importing Electron (main.ts
 * has no test file for exactly that reason -- see CLAUDE.md T-notes).
 *
 * Deduplicated via Set: solov and sub2api share the same relay domain, so
 * their websiteUrl/keysPageUrl are literally identical strings today. The
 * allowlist is a membership set (I12 checks href full equality against it),
 * so a duplicate entry would be harmless there -- dedup here is about
 * keeping this function's own output (and its test's pinned list) minimal
 * and honest about the *distinct* URL set, not a security requirement.
 */
export function relaySiteExternalUrls(sites: readonly RelaySite[]): string[] {
  const urls = sites.flatMap((site) => [
    site.websiteUrl,
    site.keysPageUrl,
    ...(site.accountBackend === 'new-api' && site.accountBaseUrl ? [`${site.accountBaseUrl}/wallet`] : []),
  ])
  return [...new Set(urls)]
}
