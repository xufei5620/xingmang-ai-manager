import { remapImageReferenceOrderSettings } from '../commerce/image-reference-order'
import { remapVideoReferenceOrderSettings } from '../video-tools/video-reference-order'
import { remapCollageInputOrderSettings } from '../image-tools/collage-input-order'
import { remapTileInputSettings } from '../image-tools/tile-input'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { markCopiedInputsChanged } from './copied-inputs'
import { remapImageCompareNodeSettings } from '../image-tools/viewer-settings'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { collectAssetReferenceIds } from '../lib/asset-reference-values'
import { finiteCoordinate, stableAssetId } from '../persistence/workflow-schema'
import type { WorkflowFile } from '../model'
import { canvasAssetContentUrlMatches } from '../asset-display-url'

export const canvasClipboardMime = 'application/x-xingmang-canvas+json'
const canvasClipboardVersion = 1
export const maximumClipboardBytes = 5 * 1024 * 1024
const maximumClipboardNodes = 1_000
const maximumClipboardEdges = 4_000

export interface CanvasClipboardPayload {
  version: typeof canvasClipboardVersion
  nodes: EditorNodeRecord[]
  edges: EditorEdgeRecord[]
}

export interface PasteCanvasClipboardOptions {
  offset: { x: number; y: number }
  createNodeId(oldId: string): string
  createEdgeId(oldId: string): string
}

export function canvasClipboardWorkflow(payload: CanvasClipboardPayload): WorkflowFile {
  const parsed = sanitizeWorkflowV2({ schemaVersion: 2, name: '复制的选区', nodes: payload.nodes.map(({ type, ...node }) => ({ ...node, kind: type })), edges: payload.edges })
  if (!parsed || parsed.warnings.length) throw new Error('选区配置无法核对，尚未粘贴')
  return parsed.workflow
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validNode(value: unknown): value is EditorNodeRecord {
  return isRecord(value)
    && Object.keys(value).every((key) => ['id', 'type', 'definitionVersion', 'position', 'data', 'parentId', 'width', 'height', 'locked', 'disabled', 'unknownKind', 'selected'].includes(key))
    && typeof value.id === 'string'
    && typeof value.type === 'string'
    && value.type !== 'unknown' && Boolean(builtinNodeRegistry.resolve(value.type))
    && value.unknownKind === undefined
    && Number.isInteger(value.definitionVersion)
    && Number(value.definitionVersion) >= 1 && Number(value.definitionVersion) <= (builtinNodeRegistry.resolve(value.type)?.version ?? 0)
    && isRecord(value.position)
    && Object.keys(value.position).every((key) => key === 'x' || key === 'y')
    && finiteCoordinate(value.position.x)
    && finiteCoordinate(value.position.y)
    && ['locked', 'disabled', 'selected'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
    && isRecord(value.data)
}

function validEdge(value: unknown): value is EditorEdgeRecord {
  return isRecord(value)
    && Object.keys(value).every((key) => ['id', 'source', 'sourceHandle', 'target', 'targetHandle', 'selected'].includes(key))
    && ['id', 'source', 'sourceHandle', 'target', 'targetHandle'].every((key) => typeof value[key] === 'string')
}

const privateField = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password|credential)|^(?:key|token)$/i
const attemptField = /(?:taskIds?|requestIds?|runIds?|attemptIds?)$/i
const reusableDataKeys = new Set(['prompt', 'promptReferences', 'outputText', 'textWebSearch', 'dirty', 'model', 'group', 'quality', 'size', 'imageResolution', 'imageCandidateCount', 'videoCandidateCount', 'seconds', 'result', 'settings', 'candidateAssetIds'])

/** Clipboard configuration never revives the originating provider job. */
function copyConfiguration(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error('选区配置层级超过安全上限，请拆分后复制')
  if (Array.isArray(value)) return value.map((entry) => copyConfiguration(entry, depth + 1))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateField.test(key) && !attemptField.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key))
    .map(([key, entry]) => [key, copyConfiguration(entry, depth + 1)]))
}

function canonicalClipboard(raw: unknown): CanvasClipboardPayload | null {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !['version', 'nodes', 'edges'].includes(key)) || raw.version !== canvasClipboardVersion || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  if (!raw.nodes.length || raw.nodes.length > maximumClipboardNodes || raw.edges.length > maximumClipboardEdges || !raw.nodes.every(validNode) || !raw.edges.every(validEdge)) return null
  for (const node of raw.nodes) {
    const result = node.data.result
    if (result !== undefined) {
      if (!isRecord(result) || !['image', 'video', 'audio'].includes(String(result.kind))) return null
      if (result.assetId !== undefined && !stableAssetId(result.assetId)) return null
      if (result.localUrl !== undefined && !canvasAssetContentUrlMatches(result.localUrl, String(result.kind), String(result.assetId), { projectScoped: true })) return null
      const mimes: Record<string, string[]> = { image: ['image/png', 'image/jpeg', 'image/webp'], video: ['video/mp4'], audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'] }
      if (result.mimeType !== undefined && !mimes[String(result.kind)].includes(String(result.mimeType))) return null
      if (result.assetId === undefined && result.taskId === undefined) return null
      if (result.width !== undefined && (!Number.isSafeInteger(result.width) || Number(result.width) < 1) || result.height !== undefined && (!Number.isSafeInteger(result.height) || Number(result.height) < 1)) return null
    }
  }
  const sourceNodes = raw.nodes.map((node) => ({ ...node, data: copyConfiguration(Object.fromEntries(Object.entries(node.data).filter(([key]) => reusableDataKeys.has(key)))) as Record<string, unknown> }))
  // Task-only output is intentionally cleared. Registered original files and
  // candidate references must survive the canonical workflow parser exactly.
  for (const node of sourceNodes) if (isRecord(node.data.result) && !node.data.result.assetId) delete node.data.result
  const parsed = sanitizeWorkflowV2({ schemaVersion: 2, name: '复制的选区', nodes: sourceNodes.map(({ type, ...node }) => ({ ...node, kind: type })), edges: raw.edges })
  if (!parsed || parsed.warnings.length || parsed.workflow.nodes.some((node) => node.unknownKind) || parsed.workflow.edges.length !== raw.edges.length) return null
  const before = collectAssetReferenceIds(sourceNodes).sort(), after = collectAssetReferenceIds(parsed.workflow.nodes).sort()
  if (JSON.stringify(before) !== JSON.stringify(after)) return null
  return { version: canvasClipboardVersion, nodes: parsed.workflow.nodes.map(({ kind, ...node }) => ({ ...node, data: { ...node.data }, type: kind, definitionVersion: node.definitionVersion ?? 1 })), edges: parsed.workflow.edges }
}

export function buildCanvasClipboardPayload(
  nodes: readonly EditorNodeRecord[],
  edges: readonly EditorEdgeRecord[],
  selectedNodeIds: ReadonlySet<string>,
): CanvasClipboardPayload {
  const included = new Set(selectedNodeIds)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  // A group is one selection, but its copy must carry the whole subtree. Keep
  // child coordinates local only when their copied parent travels with them.
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (!node.parentId || included.has(node.id) || !included.has(node.parentId) || byId.get(node.parentId)?.type !== 'group') continue
      included.add(node.id)
      changed = true
    }
  }
  const copiedNodes = nodes
    .filter((node) => included.has(node.id))
    .map((node) => {
      const copy = structuredClone(node)
      delete copy.selected
      if (copy.parentId && !included.has(copy.parentId)) {
        const seen = new Set([copy.id])
        let parentId: string | undefined = copy.parentId
        while (parentId && !seen.has(parentId)) {
          seen.add(parentId)
          const parent = byId.get(parentId)
          if (!parent) break
          copy.position.x += parent.position.x
          copy.position.y += parent.position.y
          parentId = parent.parentId
        }
        delete copy.parentId
      }
      return copy
    })
  const copiedIds = new Set(copiedNodes.map((node) => node.id))
  markCopiedInputsChanged(copiedNodes, edges, copiedIds)
  const copiedEdges = edges
    .filter((edge) => copiedIds.has(edge.source) && copiedIds.has(edge.target))
    .map((edge) => {
      const copy = { ...edge }
      delete copy.selected
      return copy
    })
  for (const node of copiedNodes) node.data.settings = remapImageReferenceOrderSettings(node.data.settings, new Map(copiedEdges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])))
  for (const node of copiedNodes) if (node.type === 'image-tile') node.data.settings = remapTileInputSettings(node.data.settings, new Map(copiedEdges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])), edges.find((edge) => edge.target === node.id && edge.targetHandle === 'in:image')?.id)
  return { version: canvasClipboardVersion, nodes: copiedNodes, edges: copiedEdges }
}

export function serializeCanvasClipboard(payload: CanvasClipboardPayload): string {
  if (payload.nodes.length > maximumClipboardNodes || payload.edges.length > maximumClipboardEdges) throw new Error('一次最多复制 1000 个节点与 4000 条内部连线，请拆分选区后复制')
  const canonical = canonicalClipboard(payload)
  if (!canonical) throw new Error('选区含不支持或损坏的节点、连线或素材引用，尚未复制；请检查原选区')
  const content = JSON.stringify(canonical)
  if (new TextEncoder().encode(content).byteLength > maximumClipboardBytes) throw new Error('选区超过 5 MB，请拆分后复制')
  return content
}

export function parseCanvasClipboard(content: string): CanvasClipboardPayload | null {
  if (typeof content !== 'string' || content.length > maximumClipboardBytes || new TextEncoder().encode(content).byteLength > maximumClipboardBytes) return null
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  try { return canonicalClipboard(raw) } catch { return null }
}

export function pasteCanvasClipboard(
  payload: CanvasClipboardPayload,
  options: PasteCanvasClipboardOptions,
): { nodes: EditorNodeRecord[]; edges: EditorEdgeRecord[] } {
  if (!finiteCoordinate(options.offset.x) || !finiteCoordinate(options.offset.y)) throw new Error('粘贴位置无效，选区尚未插入')
  const nodeIds = new Map(payload.nodes.map((node) => [node.id, options.createNodeId(node.id)]))
  if (new Set(nodeIds.values()).size !== nodeIds.size) throw new Error('粘贴节点标识冲突')
  const nodes = payload.nodes.map((node) => {
    const parentIsCopied = Boolean(node.parentId && nodeIds.has(node.parentId))
    return {
      ...structuredClone(node),
      id: nodeIds.get(node.id) as string,
      position: parentIsCopied
        ? { ...node.position }
        : { x: node.position.x + options.offset.x, y: node.position.y + options.offset.y },
      ...(parentIsCopied ? { parentId: nodeIds.get(node.parentId as string) } : { parentId: undefined }),
      selected: true,
    }
  })
  const edges = payload.edges.map((edge) => ({
    ...edge,
    id: options.createEdgeId(edge.id),
    source: nodeIds.get(edge.source) as string,
    target: nodeIds.get(edge.target) as string,
    selected: true,
  }))
  if (nodes.some((node) => !finiteCoordinate(node.position.x) || !finiteCoordinate(node.position.y))) throw new Error('粘贴位置超过画布坐标上限，请先移动原选区')
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) throw new Error('粘贴连线标识冲突')
  const edgeIds = new Map(payload.edges.map((edge, index) => [edge.id, edges[index].id]))
  for (const node of nodes) node.data.settings = remapImageReferenceOrderSettings(node.data.settings, edgeIds)
  for (const node of nodes) if (node.type === 'image-compare' && node.data.settings !== undefined) {
    node.data.settings = remapImageCompareNodeSettings(node.data.settings, edgeIds)
  }
  for (const node of nodes) if (node.type === 'image-collage') node.data.settings = remapCollageInputOrderSettings(node.data.settings, edgeIds)
  for (const [index, node] of nodes.entries()) if (node.type === 'image-tile') node.data.settings = remapTileInputSettings(node.data.settings, new Map(payload.edges.filter((edge) => edge.target === payload.nodes[index].id).map((edge) => [edge.id, edgeIds.get(edge.id)!])))
  for (const node of nodes) if ((node.type === 'video' || node.type === 'video-generate')) node.data.settings = remapVideoReferenceOrderSettings(node.data.settings, edgeIds)
  return { nodes, edges }
}
