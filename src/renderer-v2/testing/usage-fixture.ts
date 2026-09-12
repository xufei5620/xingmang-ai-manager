import type { AccountUsageRecord } from '../../../electron/ipc-contract'

export function usageDetailFixture(kind: string): AccountUsageRecord {
  const emptyPrices = { input: null, output: null, cacheRead: null, cacheCreation: null, cacheCreation5m: null, cacheCreation1h: null, imageInput: null, imageOutput: null, audioInput: null, audioOutput: null }
  const record: AccountUsageRecord = {
    id: 12, createdAt: '2026-09-12T04:31:29Z', type: 2, modelName: 'gpt-6-astra',
    promptTokens: 368531, completionTokens: 311, quota: 77.26, isStream: true,
    tokenName: 'xingmang-desktop-codex', group: 'GPT-中转/订阅', useTimeSeconds: 16,
    content: '', requestId: 'fixture-request-20260912', upstreamRequestId: '',
    details: { cacheTokens: 368000, cacheCreationTokens: 0, cacheCreationTokens5m: 0, cacheCreationTokens1h: 0,
      firstResponseTimeMs: 4778, reasoningEffort: 'xhigh', modelRatio: null, completionRatio: null,
      modelPrice: null, groupRatio: 1, userGroupRatio: -1, cacheRatio: null, cacheCreationRatio: null,
      cacheCreationRatio5m: null, cacheCreationRatio1h: null, billingMode: 'tiered_expr', matchedTier: 'long', upstreamModelName: '', streamStatus: null,
      unitPrices: { ...emptyPrices, input: 25, output: 75, cacheRead: 2, cacheCreation: 25, cacheCreation1h: 25 },
      pricingTiers: [
        { label: 'short', conditions: [{ variable: 'length', operator: '<', value: 272000 }], prices: { ...emptyPrices, input: 10, output: 50, cacheRead: 1, cacheCreation: 12.5, cacheCreation1h: 12.5 } },
        { label: 'long', conditions: [], prices: { ...emptyPrices, input: 25, output: 75, cacheRead: 2, cacheCreation: 25, cacheCreation1h: 25 } },
      ],
    },
  }
  if (kind === 'unknown-tier') { record.details.matchedTier = 'future'; delete record.details.unitPrices }
  if (kind === 'missing') {
    delete record.details.unitPrices; delete record.details.pricingTiers
    record.details.firstResponseTimeMs = null; record.details.matchedTier = ''; record.details.groupRatio = null
  }
  if (kind === 'legacy') {
    delete record.details.pricingTiers
    record.details.billingMode = ''; record.details.matchedTier = ''; record.details.modelRatio = 1.5; record.details.completionRatio = 5
    record.details.unitPrices = { ...emptyPrices, input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75, cacheCreation5m: 3.75, cacheCreation1h: 6 }
    record.details.userGroupRatio = 0.5; record.details.cacheCreationTokens = 1500; record.details.cacheCreationTokens5m = 1000; record.details.cacheCreationTokens1h = 500
  }
  if (kind === 'sub2' || kind === 'sub2-missing') {
    delete record.details.unitPrices; delete record.details.pricingTiers
    record.tokenName = 'sub2-codex-key'; record.group = 'Codex_pro'; record.details.billingMode = 'token'; record.details.matchedTier = ''
    record.details.billingType = 'subscription'; record.details.serviceTier = 'priority'; record.details.longContextBillingApplied = true
    record.details.groupRatio = 0.5
    record.details.costs = { input: 0.013275, output: 0.023325, cacheRead: 0.736, cacheCreation: 0, total: 0.7726, actual: 0.3863 }
    if (kind === 'sub2-missing') record.details.costs = { input: null, output: null, cacheRead: null, cacheCreation: null, total: null, actual: null }
  }
  if (kind === 'stream-error') {
    record.type = 5; record.content = 'fixture <script>window.usageXss=true</script>'
    record.details.streamStatus = { status: 'error', endReason: 'upstream_error', errorCount: 1, endError: '连接中断', errors: ['请稍后重试'] }
  }
  return record
}
