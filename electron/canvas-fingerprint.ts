import { createHash } from 'node:crypto'
import { resolveAiModelCapability, type AiModelCapability } from './ai-chat-protocol'
import type {
  CanvasRunAsset,
  CanvasRunGraph,
  CanvasRunGraphNode,
} from './canvas-run-contract'

interface CanvasFingerprintInput {
  projectId?: string
  node: CanvasRunGraphNode
  upstream: Array<{
    sourceNodeId: string
    sourceHandle: string
    targetHandle: string
    fingerprint: string
    text?: string
    asset?: CanvasRunAsset
  }>
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  )
}

export function canonicalCanvasJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function stableAsset(asset: CanvasRunAsset | undefined): object | undefined {
  if (!asset) return undefined
  return {
    kind: asset.kind,
    assetId: asset.assetId,
    ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalCanvasJson(value), 'utf8').digest('hex')
}

function adoptedAssetIdForFingerprint(node: CanvasRunGraphNode): string | undefined {
  // Input nodes read this id as their payload. Generate nodes write the last
  // result back into the same field, and that output must not change the next
  // cache key — otherwise a finished image is treated as a brand-new request
  // the moment a downstream node runs.
  if (node.kind === 'image-input' || node.kind === 'video-input' || node.kind === 'audio-input') {
    return node.data.adoptedAssetId
  }
  return undefined
}

function capabilityForFingerprint(model: string): AiModelCapability | undefined {
  try {
    return resolveAiModelCapability(model)
  } catch {
    return undefined
  }
}

// These parameters joined the fingerprint after caches already existed. Each
// one is left out while it equals what the executor would send anyway, so a
// node still sitting on the default keeps its old cache key (no silent re-run
// and re-charge on upgrade) while any real change produces a new key.
function generationParametersForFingerprint(node: CanvasRunGraphNode): object {
  const capability = capabilityForFingerprint(node.data.model)
  const imageResolution = node.data.imageResolution
  const effectiveImageResolution = imageResolution
    && !(capability?.kind === 'image' && imageResolution === capability.defaultResolution)
    ? imageResolution
    : undefined
  if (capability?.kind !== 'video' || capability.provider !== 'minimax-h3') {
    return { imageResolution: effectiveImageResolution }
  }
  const { videoMode, videoResolution, videoAspectRatio, promptOptimization } = node.data
  return {
    imageResolution: effectiveImageResolution,
    videoMode: videoMode && videoMode !== 'auto' ? videoMode : undefined,
    videoResolution: videoResolution && videoResolution !== '720p' ? videoResolution : undefined,
    videoAspectRatio: videoAspectRatio && videoAspectRatio !== '16:9' ? videoAspectRatio : undefined,
    promptOptimization: promptOptimization === true ? true : undefined,
  }
}

export function computeCanvasNodeFingerprint(input: CanvasFingerprintInput): string {
  return sha256({
    version: 1,
    projectId: input.projectId,
    node: {
      id: input.node.id,
      kind: input.node.kind,
      definitionVersion: input.node.definitionVersion,
      prompt: input.node.data.prompt,
      model: input.node.data.model,
      group: input.node.data.group,
      quality: input.node.data.quality,
      size: input.node.data.size,
      seconds: input.node.data.seconds,
      adoptedAssetId: adoptedAssetIdForFingerprint(input.node),
      ...generationParametersForFingerprint(input.node),
    },
    upstream: input.upstream
      .map((entry) => ({
        sourceNodeId: entry.sourceNodeId,
        sourceHandle: entry.sourceHandle,
        targetHandle: entry.targetHandle,
        fingerprint: entry.fingerprint,
        text: entry.text,
        asset: stableAsset(entry.asset),
      })),
  })
}

export function computeCanvasGraphRevision(graph: CanvasRunGraph): string {
  return sha256({
    version: 1,
    nodes: graph.nodes
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        definitionVersion: node.definitionVersion,
        disabled: node.disabled === true,
        prompt: node.data.prompt,
        model: node.data.model,
        group: node.data.group,
        quality: node.data.quality,
        size: node.data.size,
        imageResolution: node.data.imageResolution,
        seconds: node.data.seconds,
        adoptedAssetId: node.data.adoptedAssetId,
        videoMode: node.data.videoMode,
        videoResolution: node.data.videoResolution,
        videoAspectRatio: node.data.videoAspectRatio,
        promptOptimization: node.data.promptOptimization,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: graph.edges
      .map((edge) => ({ ...edge }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
}
