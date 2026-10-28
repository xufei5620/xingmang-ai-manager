import type { CanvasRunRecord } from '../host'
import { buildCanvasRunPreflight, type CanvasRunPreflight, type CanvasRunPreflightInput, type CanvasRunPreflightItem } from './run-preflight'

export function buildAgentExecutionResumePreflight(input: CanvasRunPreflightInput, record: CanvasRunRecord): CanvasRunPreflight {
  const preflight = buildCanvasRunPreflight(input)
  const terminal = new Map(record.nodes.filter((node) => ['succeeded', 'cached', 'failed', 'skipped', 'cancelled', 'interrupted'].includes(node.state)).map((node) => [node.nodeId, node.state]))
  const items: CanvasRunPreflightItem[] = preflight.items.map((item) => {
    const state = terminal.get(item.nodeId)
    if (!state) return item
    const { reasonCode: _reasonCode, ...original } = item
    return { ...original, action: state === 'succeeded' || state === 'cached' ? 'cached' : 'skip', requestCount: 0, reason: state === 'succeeded' || state === 'cached' ? '原运行已完成此节点，继续时保留原结果' : '原运行中此节点已结束，继续不会重试此节点' }
  })
  const count = (matches: (item: CanvasRunPreflightItem) => boolean) => items.filter(matches).reduce((total, item) => total + item.requestCount, 0)
  const blockedCount = items.filter((item) => item.action === 'blocked').length
  const paidRequestCount = count((item) => item.paid)
  return {
    ...preflight, items,
    requestCount: count(() => true),
    cacheHitCount: items.filter((item) => item.action === 'cached').length,
    skippedCount: items.filter((item) => item.action === 'skip').length,
    blockedCount, paidRequestCount,
    imageRequestCount: count((item) => ['image', 'image-generate', 'image-edit'].includes(item.kind)),
    videoRequestCount: count((item) => ['video', 'video-generate'].includes(item.kind)),
    textRequestCount: count((item) => ['text-generate', 'drama-parse'].includes(item.kind)),
    webSearchRequestCount: count((item) => Boolean(item.webSearch)),
    risk: blockedCount ? 'blocking' : paidRequestCount ? 'warning' : 'info',
    warnings: ['继续已保存的原运行范围；请求数是尚未结束节点的上限，已完成节点不会重新生成。', ...items.filter((item) => item.action === 'blocked').map((item) => `${item.nodeId}：${item.reason}`)],
    canStart: preflight.selectedNodeIds.length > 0 && blockedCount === 0,
  }
}
