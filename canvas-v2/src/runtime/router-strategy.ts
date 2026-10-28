import type { WorkflowEdge } from '../model'

export interface CanvasRouterStrategy {
  version: 1
  strategy: 'first-available' | 'all'
}

export interface CanvasRouterExecutionBinding {
  nodeId: string
  routerStrategy: CanvasRouterStrategy
  incoming: WorkflowEdge[]
}

/** Absence is a historical execution format, never a new default strategy. */
export function parseCanvasRouterStrategy(value: unknown): CanvasRouterStrategy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('路由策略配置不完整，请重新核对；不会改用其他策略')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['version', 'strategy'].includes(key)) || raw.version !== 1 || raw.strategy !== 'first-available' && raw.strategy !== 'all') throw new Error('路由策略版本或选项不受支持，请刷新后核对；不会改用其他策略')
  return { version: 1, strategy: raw.strategy }
}

export function parseNodeRouterStrategy(kind: string, value: unknown): CanvasRouterStrategy | undefined {
  if (value === undefined) return undefined
  if (kind !== 'router') throw new Error('路由策略只能保存在路由节点中，当前没有丢弃配置后继续')
  return parseCanvasRouterStrategy(value)
}

/** Callers supply saved edge order and each edge's existing output order.
 * This selects completed values only; it neither schedules nor skips upstream
 * generation, and must never be used as a provider retry/failover mechanism. */
export function selectCanvasRouterInputs<Asset extends { kind: string }>(value: CanvasRouterStrategy, texts: readonly string[], assets: readonly Asset[]): { text: string; assets: Asset[] } {
  const config = parseCanvasRouterStrategy(value)
  if (assets.some((asset) => !['image', 'video', 'audio'].includes(asset.kind))) throw new Error('路由输入包含无法核对的媒体类型')
  if (config.strategy === 'all') return { text: texts.join('\n'), assets: [...assets] }
  const kinds = new Set<string>()
  return {
    text: texts.find((text) => text.trim().length > 0) ?? '',
    assets: assets.filter((asset) => { if (kinds.has(asset.kind)) return false; kinds.add(asset.kind); return true }),
  }
}
