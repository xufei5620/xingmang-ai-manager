import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { CanvasRunGraph } from '../host'
import { maximumImageTransformInputs, parseImageTransformRecipe } from '../image-tools/recipe'
import { canvasImageInputCardinality } from './image-input-cardinality'
import { selectTileInputEdge } from '../image-tools/tile-input'

type RunNode = CanvasRunGraph['nodes'][number]
type RunEdge = CanvasRunGraph['edges'][number]

/** Resolve identity before traversal. Unselected sources are a pool, not run
 * dependencies; their provider requests must never be submitted implicitly. */
export function resolveCanvasTileInput(node: RunNode, edges: readonly RunEdge[]) {
  return selectTileInputEdge(node.data.tileInput, edges.filter((edge) => edge.target === node.id))
}

export function canvasRunDependencyEdges(graph: CanvasRunGraph, invalidTileIds?: Set<string>): CanvasRunGraph['edges'] {
  const selected = new Map<string, string | undefined>()
  for (const node of graph.nodes) {
    if (node.kind !== 'image-tile') continue
    try { selected.set(node.id, resolveCanvasTileInput(node, graph.edges)?.edge.id) }
    catch (error) {
      if (!invalidTileIds) throw error
      invalidTileIds.add(node.id)
      selected.set(node.id, undefined)
    }
  }
  return graph.edges.filter((edge) => !selected.has(edge.target) || selected.get(edge.target) === edge.id)
}

/** Known grid counts are structural evidence; old previews or candidate arrays
 * do not establish the contents of a future batch. Runtime checks again. */
export function assertCanvasTileInput(node: RunNode, edges: readonly RunEdge[], nodes: ReadonlyMap<string, RunNode>) {
  const incoming = edges.filter((edge) => edge.target === node.id)
  if (incoming.length > maximumImageTransformInputs) throw new Error(`平铺最多连接 ${maximumImageTransformInputs} 个图片来源`)
  const selection = resolveCanvasTileInput(node, edges)
  if (!selection) throw new Error('请连接并选择一张平铺图片')
  const source = nodes.get(selection.edge.source)
  const port = source && builtinNodeRegistry.resolve(source.kind)?.ports.find((entry) => entry.id === selection.edge.sourceHandle && entry.direction === 'output')
  if (!source || port?.kind !== 'image' || selection.edge.targetHandle !== 'in:image') throw new Error('平铺所选来源不是有效图片连接，请重新选择')
  if (source.kind === 'router' && Object.hasOwn(source.data, 'routerStrategy')) {
    const count = canvasImageInputCardinality([selection.edge], nodes, edges)
    if (!count.exact) throw new Error('平铺所选路由图片数量尚无法确认，请先核对来源')
    if (selection.outputIndex >= count.minimum) throw new Error('平铺所选路由图片已不在当前输出中，请重新选择')
  } else if (selection.edge.sourceHandle === 'out:images') {
    if (source.kind !== 'image-grid-split') throw new Error('平铺所选批次数量尚无法确认，请改用明确的图片输出')
    const recipe = parseImageTransformRecipe(source.data.imageTransform)
    if (recipe.kind !== 'grid-split' || selection.outputIndex >= recipe.rows * recipe.columns) throw new Error('平铺所选切片已不在当前批次中，请重新选择')
  } else if (selection.outputIndex !== 0) throw new Error('平铺单图来源没有该图片序号，请重新选择')
  return selection
}
