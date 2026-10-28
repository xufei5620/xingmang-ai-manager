import type { CanvasRunGraph } from '../host'
import { imageCollageInputCountError, imageTransformRecipeNeedsSources, maximumImageTransformInputs, parseImageTransformRecipe, type ImageTransformRecipe } from '../image-tools/recipe'
import { resolveImageCollageTemplate } from '../image-tools/collage-templates'
import { parseCanvasRouterStrategy } from './router-strategy'

export interface CanvasImageInputCardinality {
  connections: number
  /** Conditional on connected sources producing usable images, not asset availability. */
  minimum: number
  exact: boolean
  hasBatch: boolean
}

type ImageSource = Pick<CanvasRunGraph['edges'][number], 'source' | 'sourceHandle'>
interface ImageEstimate { identities: string[]; exact: boolean; hasBatch: boolean; uncertainIdentity?: boolean; knownIdentities?: string[]; routed?: true }

/** The structural identities describe current input assets or future output
 * slots, never a previous router preview. Iterative traversal keeps deeply
 * nested authored graphs off the JavaScript call stack; bounded work rejects
 * pathological expansions rather than manufacturing an exact count. */
function imageSourceEstimates(sources: readonly ImageSource[], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>, edges?: readonly CanvasRunGraph['edges'][number][], media: 'image' | 'video' | 'audio' = 'image'): ImageEstimate[] {
  const incoming = new Map<string, ImageSource[]>()
  for (const edge of edges ?? []) if ([`in:${media}`, `in:${media}s`].includes(edge.targetHandle) && [`out:${media}`, ...(media === 'image' ? ['out:images'] : [])].includes(edge.sourceHandle)) {
    const values = incoming.get(edge.target)
    if (values) values.push(edge)
    else incoming.set(edge.target, [edge])
  }
  const memo = new Map<string, ImageEstimate>(), active = new Set<string>()
  let work = 0
  const key = (edge: ImageSource) => JSON.stringify([edge.source, edge.sourceHandle])
  function leaf(edge: ImageSource): ImageEstimate {
    const node = nodes.get(edge.source), batch = edge.sourceHandle === 'out:images'
    if (media === 'image' && node?.kind === 'image-grid-split') {
      try {
        const recipe = parseImageTransformRecipe(node.data.imageTransform)
        if (recipe.kind === 'grid-split') {
          const count = recipe.rows * recipe.columns, selected = node.data.imageOutputIndex ?? 0
          const indexes = batch ? Array.from({ length: count }, (_, index) => index) : [Number.isInteger(selected) && selected >= 0 && selected < count ? selected : 0]
          return { identities: indexes.map(index => JSON.stringify(['grid', edge.source, index])), exact: true, hasBatch: batch }
        }
      } catch { /* The source owns invalid recipe diagnostics; an unknown batch stays uncertain. */ }
    }
    const identity = !batch && node?.kind === `${media}-input` && node.data.adoptedAssetId ? ['asset', node.data.adoptedAssetId] : ['source', edge.source]
    return { identities: [JSON.stringify(identity)], exact: !batch, hasBatch: batch, ...((batch || !node || ['router', 'gallery', 'output'].includes(node.kind)) ? { uncertainIdentity: true } : {}) }
  }
  for (const source of sources) {
    const stack: Array<{ edge: ImageSource; dependencies?: ImageSource[]; first?: boolean; next?: number }> = [{ edge: source }]
    while (stack.length) {
      if (++work > 200_000) throw new Error('图片路由输入结构超过预检容量，请拆分工作流后重试')
      const frame = stack[stack.length - 1], identity = key(frame.edge)
      if (memo.has(identity)) { stack.pop(); continue }
      const node = nodes.get(frame.edge.source)
      if (frame.dependencies === undefined) {
        if (!node || !Object.hasOwn(node.data, 'routerStrategy')) { memo.set(identity, leaf(frame.edge)); stack.pop(); continue }
        if (node.kind !== 'router') throw new Error('路由策略只能保存在路由节点中，不能猜测图片数量')
        const config = parseCanvasRouterStrategy(node.data.routerStrategy)
        if (frame.edge.sourceHandle !== `out:${media}`) throw new Error('路由节点的图片输出端口无法核对')
        if (active.has(identity)) throw new Error('图片路由输入包含循环连接，请先断开循环')
        active.add(identity); frame.dependencies = incoming.get(node.id) ?? []; frame.next = 0; frame.first = config.strategy === 'first-available'
      }
      while (frame.next! < frame.dependencies.length && memo.has(key(frame.dependencies[frame.next!]))) frame.next!++
      const pending = frame.dependencies[frame.next!]
      if (pending) {
        if (active.has(key(pending))) throw new Error('图片路由输入包含循环连接，请先断开循环')
        stack.push({ edge: pending }); continue
      }
      const values = frame.dependencies.map(edge => memo.get(key(edge))!)
      const identities = new Set<string>()
      for (const value of values) for (const item of value.identities) { if (++work > 200_000) throw new Error('图片路由输入结构超过预检容量，请拆分工作流后重试'); identities.add(item) }
      // A partial Agent boundary may omit its incoming graph. It cannot prove
      // either emptiness or exact one for a versioned aggregate output.
      const known = values.length > 0, uncertain = values.some(value => value.uncertainIdentity), exact = known && !uncertain && values.every(value => value.exact)
      const confirmed = new Set(values.flatMap(value => value.knownIdentities ?? (value.uncertainIdentity ? [] : value.identities)))
      const ordered = known ? [...identities] : [JSON.stringify(['router-unknown', node!.id])]
      const aggregate = uncertain ? confirmed.size ? [...confirmed] : [JSON.stringify(['router-unknown', node!.id])] : ordered
      memo.set(identity, frame.first ? { routed: true, identities: ordered.slice(0, 1), exact: true, hasBatch: false, ...(!known || values[0]?.uncertainIdentity ? { uncertainIdentity: true } : {}) } : { routed: true, identities: aggregate, exact, hasBatch: !exact || aggregate.length > 1, ...(!exact ? { uncertainIdentity: true, knownIdentities: [...confirmed] } : {}) })
      active.delete(identity); stack.pop()
    }
  }
  return sources.map(edge => memo.get(key(edge))!)
}

/** Transform consumers preserve repeated input positions. A router normalizes
 * its own upstream pool first, so its typed all output can contribute many
 * slots even though its port is named out:image. */
export function canvasImageInputCardinality(sources: readonly ImageSource[], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>, edges?: readonly CanvasRunGraph['edges'][number][]): CanvasImageInputCardinality {
  const values = imageSourceEstimates(sources, nodes, edges)
  return { connections: sources.length, minimum: values.reduce((sum, value) => sum + value.identities.length, 0), exact: values.every(value => value.exact), hasBatch: values.some(value => value.hasBatch) }
}

/** Media-typed ordered output slots for video reference preflight. This is
 * derived graph metadata only; it resolves no saved asset bytes or ownership. */
export function canvasMediaInputSlots(media: 'image' | 'video' | 'audio', source: ImageSource, nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>, edges: readonly CanvasRunGraph['edges'][number][]): ImageEstimate {
  return imageSourceEstimates([source], nodes, edges, media)[0]
}

/** Generation merges identical known asset IDs and structural grid slots;
 * current/previous candidates never prove a future producer batch size. */
export function canvasGenerationImageInputCardinality(sources: readonly ImageSource[], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>, edges?: readonly CanvasRunGraph['edges'][number][]): CanvasImageInputCardinality {
  const values = imageSourceEstimates(sources, nodes, edges)
  const uncertain = values.some(value => value.routed && value.uncertainIdentity), known = new Set(values.flatMap(value => value.routed && value.uncertainIdentity ? value.knownIdentities ?? [] : value.identities))
  return { connections: sources.length, minimum: uncertain ? Math.max(known.size, values.length ? 1 : 0) : new Set(values.flatMap(value => value.identities)).size, exact: !uncertain && values.every(value => value.exact), hasBatch: values.some(value => value.hasBatch) }
}

export function canvasGenerationImageInputError(kind: string, count: CanvasImageInputCardinality): string | null {
  if (kind === 'image-edit' && count.connections === 0) return '图片编辑节点需要至少一条有效参考图片连接，请先连接本账户图片或上游生图节点'
  return count.minimum > 4 ? `参考图片${count.hasBatch ? '整组展开后' : '去重后'}${count.exact ? '有' : '至少有'} ${count.minimum} 张，最多支持 4 张；请减少来源或改用单图输出` : null
}

export function canvasCollageCapacityError(rows: number, columns: number, sourceCount: number): string | null {
  return sourceCount > rows * columns ? `${sourceCount} 张输入需至少 ${sourceCount} 格，当前 ${rows}×${columns}=${rows * columns} 格，请调整拼图行列` : null
}

/** Shared structural preparation rules. Unknown batches only establish a lower
 * bound; actual bytes, dimensions and cardinality remain execution checks.
 */
export function canvasImageTransformInputErrors(recipe: ImageTransformRecipe, count: CanvasImageInputCardinality): string[] {
  const minimumSources = imageTransformRecipeNeedsSources(recipe) ? 1 : 0
  const requiredLayerSources = recipe.kind === 'layer' ? recipe.layers.reduce((minimum, layer) => layer.content ? minimum : Math.max(minimum, layer.sourceIndex + 1), 0) : 0
  if (count.connections <= maximumImageTransformInputs && requiredLayerSources > 0 && (count.connections < minimumSources || count.exact && count.minimum < requiredLayerSources)) return [`图层引用需要至少 ${requiredLayerSources} 张图片，并按原图层引用顺序对应；文字、形状等内容图层不占图片来源`]
  if (count.connections < minimumSources || count.connections > maximumImageTransformInputs) return [`图片处理需要连接 ${minimumSources}–${maximumImageTransformInputs} 个图片来源`]
  const errors: string[] = []
  if (recipe.kind !== 'tile' && count.minimum > maximumImageTransformInputs) errors.push(`整组输出展开后${count.exact ? '有 ' : '至少 '}${count.minimum} 张输入图片，超过 ${maximumImageTransformInputs} 张上限，请减少来源`)
  if ((recipe.kind === 'crop' || recipe.kind === 'grid-split') && (count.connections !== 1 || count.hasBatch)) errors.push('裁剪和网格切图需要连接一张选中的图片，请使用单图输出端口')
  // Tile connections form a selectable pool. Its chosen edge and output slot
  // are checked by assertCanvasTileInput; the processor still receives one image.
  if (recipe.kind === 'collage') {
    const message = imageCollageInputCountError(recipe, count.minimum, count.exact)
    if (message) errors.push(`${count.exact || resolveImageCollageTemplate(recipe.layout) ? '' : '至少 '}${message}`)
  }
  return errors
}
