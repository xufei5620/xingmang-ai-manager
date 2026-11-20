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

/** Before versioned strategies a router saved its choice as settings.strategy,
 * and no run ever received it, so 「保留全部输入」 still handed one picture on
 * (D06). That 'all' was the user's explicit choice: it now runs as the
 * versioned all. Every other old value keeps the historical behavior, which
 * is no strategy at all. */
export function isLegacyRouterAllSetting(kind: string, settings: Readonly<Record<string, unknown>> | undefined): boolean {
  return kind === 'router' && Boolean(settings) && !Object.hasOwn(settings!, 'routerStrategy') && settings!.strategy === 'all'
}

/** The strategy a saved node runs with, or undefined for the historical router. */
export function resolveNodeRouterStrategy(kind: string, settings: Readonly<Record<string, unknown>> | undefined): CanvasRouterStrategy | undefined {
  if (settings && Object.hasOwn(settings, 'routerStrategy')) {
    if (kind !== 'router') throw new Error('路由策略只能保存在路由节点中，当前没有丢弃配置后继续')
    return parseCanvasRouterStrategy(settings.routerStrategy)
  }
  return isLegacyRouterAllSetting(kind, settings) ? { version: 1, strategy: 'all' } : undefined
}

/** The run node's routerStrategy field for a saved node; absent for the historical router. */
export function routerStrategyRunField(kind: string, settings: Readonly<Record<string, unknown>> | undefined): { routerStrategy?: CanvasRouterStrategy } {
  const routerStrategy = resolveNodeRouterStrategy(kind, settings)
  return routerStrategy ? { routerStrategy } : {}
}

/** Whether the saved node carries a strategy, versioned or the old explicit all. */
export function nodeHasRouterStrategySetting(kind: string, settings: Readonly<Record<string, unknown>> | undefined): boolean {
  return Boolean(settings && Object.hasOwn(settings, 'routerStrategy')) || isLegacyRouterAllSetting(kind, settings)
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
