import { parseCanvasRouterStrategy, type CanvasRouterStrategy } from '../runtime/router-strategy'

interface RouterBinding { nodeId: string; routerStrategy: CanvasRouterStrategy }
interface RouterRunGraph { nodes: readonly { id: string; kind: string; data: { routerStrategy?: unknown } }[]; edges: readonly { id: string; source: string; sourceHandle: string; target: string; targetHandle: string }[] }

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function marked(value: unknown): boolean { return record(value) && Object.hasOwn(value, 'routerStrategy') }
function workflowNodes(value: unknown): Record<string, unknown>[] { return record(value) && Array.isArray(value.nodes) ? value.nodes.filter(record) : [] }

/** Detect presence before any generic serializer can erase an unknown value. */
export function graphHasRouterStrategy(value: unknown): boolean {
  return marked(value) || record(value) && marked(value.settings) || workflowNodes(value).some((node) => marked(node) || marked(node.settings) || marked(node.data) || record(node.data) && marked(node.data.settings))
}
export function projectHasRouterStrategy(content: string): boolean { return graphHasRouterStrategy(JSON.parse(content)) }
export function assertRouterStrategyClientVersion(version: unknown, required: boolean): void {
  if (version !== undefined && version !== 1 || required && version !== 1) throw new Error('当前页面版本不支持已保存的路由策略，请刷新后重试；未覆盖工程或启动运行')
}

/** The editable workflow and the immutable run graph have distinct placements. */
function collectWorkflowRouters(value: unknown): RouterBinding[] {
  if (marked(value) || record(value) && marked(value.settings)) throw new Error('路由策略保存位置不正确，不能丢弃后继续')
  const result: RouterBinding[] = []
  const ids = new Set<string>()
  for (const node of workflowNodes(value)) {
    if (marked(node) || marked(node.settings) || marked(node.data)) throw new Error('路由策略保存位置不正确，请使用节点设置中的路由策略')
    if (!record(node.data) || !record(node.data.settings)) continue
    const settings = node.data.settings
    const kind = node.kind ?? node.type
    if (kind === 'router' && Object.hasOwn(settings, 'strategy') && settings.strategy !== 'first-available' && settings.strategy !== 'all') throw new Error('旧版路由策略选项无法核对，请明确重新选择；不会改用其他策略')
    if (!Object.hasOwn(settings, 'routerStrategy')) continue
    if (kind !== 'router') throw new Error('路由策略只能保存在路由节点中')
    const config = parseCanvasRouterStrategy(settings.routerStrategy)
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) throw new Error('路由节点编号无法核对；未丢弃策略')
    ids.add(node.id); result.push({ nodeId: node.id, routerStrategy: config })
  }
  return result
}
export function assertRouterStrategyWorkflowConfiguration(value: unknown): void { collectWorkflowRouters(value) }
export function assertRouterStrategyWorkflowValue(value: unknown, version: unknown): void {
  assertRouterStrategyClientVersion(version, graphHasRouterStrategy(value))
  collectWorkflowRouters(value)
}
export function assertRouterStrategyWorkflow(content: string, version: unknown): void { assertRouterStrategyWorkflowValue(JSON.parse(content), version) }
function inputOrder(value: unknown, nodeId: string): Array<{ id: string; source: string; sourceHandle: string; target: string; targetHandle: string }> {
  if (!record(value) || !Array.isArray(value.edges)) throw new Error('路由输入连线顺序无法核对，请保存并重新预检')
  return value.edges.filter((edge) => record(edge) && edge.target === nodeId).map((edge) => {
    if (!record(edge) || !['id', 'source', 'sourceHandle', 'target', 'targetHandle'].every((key) => typeof edge[key] === 'string' && Boolean(edge[key]))) throw new Error('路由输入连线顺序无法核对，请保存并重新预检')
    return { id: edge.id as string, source: edge.source as string, sourceHandle: edge.sourceHandle as string, target: edge.target as string, targetHandle: edge.targetHandle as string }
  })
}

/** Start always calls this. Resume calls it only for an original versioned run;
 * a historical immutable run must never inherit later project semantics. */
export function assertRouterStrategyRun(content: string, graph: RouterRunGraph, selectedNodeIds: readonly string[]): void {
  const raw: unknown = JSON.parse(content)
  const saved = new Map(collectWorkflowRouters(raw).map((entry) => [entry.nodeId, entry.routerStrategy]))
  const selected = new Set(selectedNodeIds)
  for (const node of graph.nodes) {
    if (!selected.has(node.id)) continue
    const stored = saved.get(node.id)
    const supplied = Object.hasOwn(node.data, 'routerStrategy') ? parseCanvasRouterStrategy(node.data.routerStrategy) : undefined
    if (!stored && !supplied) continue
    if (node.kind !== 'router' || !stored || !supplied || JSON.stringify(stored) !== JSON.stringify(supplied)) throw new Error('运行路由策略与已保存工程不一致，请先保存并重新预检；不会改用旧策略')
    if (JSON.stringify(inputOrder(raw, node.id)) !== JSON.stringify(inputOrder(graph, node.id))) throw new Error('运行路由的输入顺序与已保存工程不一致，请保存并重新预检；未重新排列输入')
    saved.delete(node.id)
  }
  if ([...saved.keys()].some((nodeId) => selected.has(nodeId))) throw new Error('运行中缺少已保存的路由策略节点，请重新预检')
}
export function routerStrategyRunSignature(content: string, selectedNodeIds: readonly string[]): string {
  const raw: unknown = JSON.parse(content)
  const selected = new Set(selectedNodeIds)
  return JSON.stringify(collectWorkflowRouters(raw).filter((entry) => selected.has(entry.nodeId)).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0).map((entry) => ({ ...entry, incoming: inputOrder(raw, entry.nodeId) })))
}
