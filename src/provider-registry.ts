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

// 概览页（Dashboard）卡片顺序：Claude / Codex / Gemini / Grok。
export const dashboardProviderIds: readonly ProviderId[] = buildProviderOrder({
  claude: 0,
  codex: 1,
  gemini: 2,
  grok: 3,
})

// 管理类页面共用顺序：安装维护 / 配置备份 / MCP / Skills / ProviderTabs（含由它派生的会话页）。
// 与概览页的唯一差异是 Codex 和 Claude 互换位置——两套顺序都是既有 UI 事实，收口到这一处时
// 没有改动任何一处已渲染的顺序。这两套顺序只服务于已冻结的 legacy 回滚界面；renderer-v2 自
// v3.1.1 起统一成单一顺序，以 src/renderer-v2/registry/tools.ts 的 tools 数组为准。
export const managementProviderIds: readonly ProviderId[] = buildProviderOrder({
  codex: 0,
  claude: 1,
  gemini: 2,
  grok: 3,
})
