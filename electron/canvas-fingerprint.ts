import { createHash } from 'node:crypto'
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
      adoptedAssetId: input.node.data.adoptedAssetId,
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
        seconds: node.data.seconds,
        adoptedAssetId: node.data.adoptedAssetId,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: graph.edges
      .map((edge) => ({ ...edge }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
}
