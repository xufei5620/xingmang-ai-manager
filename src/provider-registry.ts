import type { ProviderId } from './types'
import { providerIds } from './types'

// Builds a display-order array from a rank table instead of a hand-written
// literal array. This buys two independent guards against silently dropping
// a newly added provider (see CLAUDE.md section 5, trap T2):
//   1. `rank` is typed `Record<ProviderId, number>`, so the object literals
//      passed in below are checked for missing/excess keys at the call site.
//      Forgetting a provider is a `npm run typecheck` error, not a silent gap.
//   2. Even if someone skips typecheck, the result is built by intersecting
//      `providerIds` with `rank`'s own keys (`id in rank`) rather than by
//      spreading `providerIds` directly — a provider missing from `rank`
//      is filtered OUT of the result, so its absence shows up as a length
//      mismatch in provider-registry.test.ts's coverage assertion.
function buildProviderOrder(rank: Record<ProviderId, number>): readonly ProviderId[] {
  return providerIds.filter((id) => id in rank).sort((a, b) => rank[a] - rank[b])
}

// 概览页（Dashboard）卡片顺序：Codex 最先展示，其后 Claude / Grok / Gemini。
export const dashboardProviderIds: readonly ProviderId[] = buildProviderOrder({
  codex: 0,
  claude: 1,
  grok: 2,
  gemini: 3,
})

// 管理类页面共用顺序：安装维护 / 配置备份 / MCP / Skills / ProviderTabs（含由它派生的会话页）。
// 与概览页的唯一差异是 Gemini 和 Grok 互换位置——两套顺序都是既有 UI 事实，本次重构只是把
// 分散在各文件里的字面量数组收口到这一处，不改变任何一处已渲染的顺序。
export const managementProviderIds: readonly ProviderId[] = buildProviderOrder({
  codex: 0,
  claude: 1,
  gemini: 2,
  grok: 3,
})
