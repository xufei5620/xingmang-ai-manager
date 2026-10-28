import { isImageTransformNodeKind } from '../image-tools/recipe'
import type { CanvasRunGraph, CanvasRunRecord } from '../host'
import { canvasRunDependencyEdges } from './tile-run-input'

const generatedKinds = new Set(['image', 'image-generate', 'image-edit', 'video', 'video-generate', 'frame-extract', 'text-generate', 'drama-parse'])

function imageOutputSelection(node: CanvasRunGraph['nodes'][number]): number {
  const recipe = node.data.imageTransform
  const count = recipe?.kind === 'grid-split' ? recipe.rows * recipe.columns : 1
  const index = node.data.imageOutputIndex ?? 0
  return Number.isInteger(index) && index >= 0 && index < count ? index : 0
}

function nodeConfiguration(node: CanvasRunGraph['nodes'][number], projectedGalleryResult = false): string {
  const data = node.data
  return JSON.stringify([
    node.kind, node.definitionVersion, Boolean(node.disabled), data.prompt, data.model,
    data.textWebSearch ?? false,
    data.group ?? '', data.quality ?? '', data.size ?? '', data.imageResolution ?? '', data.imageCandidateCount ?? 1,
    data.seconds ?? '', data.videoMode ?? '', data.videoResolution ?? '', data.videoCandidateCount ?? 1,
    data.videoAspectRatio ?? '', data.promptOptimization ?? null, data.generateAudio ?? null, data.videoProtocol ?? 'relay-videos',
    data.frameTimestampSeconds ?? 0,
    data.videoReferenceOrder ?? null,
    data.imageEditMask ?? null,
    data.commerceTask ?? null,
    data.interiorTask ?? null,
    ...(data.exteriorTask !== undefined ? [data.exteriorTask] : []),
    ...(data.storyboardTask !== undefined ? [data.storyboardTask] : []),
    ...(data.routerStrategy !== undefined ? [data.routerStrategy] : []),
    data.imageReferenceOrder ?? null,
    data.imageTransform ?? null,
    node.kind === 'image-collage' ? data.imageCollageInputOrder ?? null : null,
    node.kind === 'image-tile' ? data.tileInput ?? null : null,
    (projectedGalleryResult || generatedKinds.has(node.kind) || isImageTransformNodeKind(node.kind) || node.kind === 'router' && node.data.routerStrategy !== undefined) ? '' : data.adoptedAssetId ?? '',
  ])
}

/**
 * Result adoption is allowed only when the submitted input chain is still
 * present. Runtime results and canvas geometry are deliberately excluded:
 * finishing one node must not invalidate the same run's downstream nodes.
 */
export function matchingCanvasRunNodeIds(submitted: CanvasRunGraph, current: CanvasRunGraph, run?: CanvasRunRecord): Set<string> {
  const previous = new Map(submitted.nodes.map((node) => [node.id, node]))
  const present = new Map(current.nodes.map((node) => [node.id, node]))
  const changed = new Set<string>()
  const incoming = (graph: CanvasRunGraph) => {
    const indexed = new Map<string, string[][]>()
    const orderedCollages = new Set(graph.nodes.filter((node) => node.kind === 'image-tile' || (node.kind === 'image-collage' && node.data.imageCollageInputOrder !== undefined) || node.data.videoReferenceOrder !== undefined || node.data.imageReferenceOrder !== undefined || node.kind === 'router' && node.data.routerStrategy !== undefined).map((node) => node.id))
    for (const edge of canvasRunDependencyEdges(graph, changed)) indexed.set(edge.target, [...(indexed.get(edge.target) ?? []), [edge.source, edge.sourceHandle, edge.targetHandle, ...(orderedCollages.has(edge.target) ? [edge.id] : [])]])
    return indexed
  }
  const previousIncoming = incoming(submitted)
  const currentIncoming = incoming(current)
  const edges = [...canvasRunDependencyEdges(submitted, changed), ...canvasRunDependencyEdges(current, changed)]
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  const runAssets = new Map((run?.nodes ?? []).map((record) => [record.nodeId, new Set(record.attempts.flatMap((attempt) => attempt.candidates.map((candidate) => candidate.asset.assetId)))]))
  const galleryOutputs = new Map((run?.nodes ?? []).filter((record) => record.kind === 'gallery' && (record.state === 'succeeded' || record.state === 'cached')).map((record) => [record.nodeId, record.attempts.at(-1)?.candidates[0]?.asset.assetId]))
  for (const node of current.nodes) {
    const original = previous.get(node.id)
    // A stale gallery submitted without a choice follows this run's first
    // collected output. Its own progress/terminal echo is not a new binding.
    // Any other candidate or an unrelated replacement still invalidates it.
    const projectedGalleryResult = node.kind === 'gallery' && Boolean(previousIncoming.get(node.id)?.length)
      && !original?.data.adoptedAssetId && Boolean(node.data.adoptedAssetId)
      && galleryOutputs.get(node.id) === node.data.adoptedAssetId
    if (!original || nodeConfiguration(original) !== nodeConfiguration(node, projectedGalleryResult)
      || JSON.stringify(previousIncoming.get(node.id) ?? []) !== JSON.stringify(currentIncoming.get(node.id) ?? [])) changed.add(node.id)
    if (original && isImageTransformNodeKind(node.kind) && imageOutputSelection(original) !== imageOutputSelection(node)) {
      for (const edge of edges) if (edge.source === node.id && edge.sourceHandle !== 'out:images') changed.add(edge.target)
    }
    // A new result from this run can feed its own downstream nodes. A manual
    // switch to an unrelated asset during generation cannot silently do so.
    if (original && (generatedKinds.has(node.kind) || isImageTransformNodeKind(node.kind)) && original.data.adoptedAssetId !== node.data.adoptedAssetId
      && (!node.data.adoptedAssetId || !runAssets.get(node.id)?.has(node.data.adoptedAssetId))) {
      for (const edge of edges) if (edge.source === node.id && (!isImageTransformNodeKind(node.kind) || edge.sourceHandle !== 'out:images')) changed.add(edge.target)
    }
  }
  for (const original of submitted.nodes) if (!present.has(original.id)) changed.add(original.id)
  // A changed upstream prompt, asset or connection also invalidates every
  // downstream result, even when that node's own prompt did not change.
  const queue = [...changed]
  for (let index = 0; index < queue.length; index += 1) {
    for (const target of outgoing.get(queue[index]) ?? []) {
      if (changed.has(target)) continue
      changed.add(target)
      queue.push(target)
    }
  }
  return new Set(current.nodes.filter((node) => previous.has(node.id) && !changed.has(node.id)).map((node) => node.id))
}

export function matchingRunRecordNodes(record: CanvasRunRecord, matchingIds: ReadonlySet<string>): CanvasRunRecord {
  return { ...record, nodes: record.nodes.filter((node) => matchingIds.has(node.nodeId)) }
}
