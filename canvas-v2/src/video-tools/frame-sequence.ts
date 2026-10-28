import { maximumProjectEdges, maximumProjectNodes } from '../lib/canvas-limits'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { findAvailableCanvasPosition, type CanvasPlacementNode } from '../editor/node-placement'
import { collageInputOrderFromSlots } from '../image-tools/collage-input-order'
import { maximumImageTransformTotalPixels, parseImageTransformRecipe } from '../image-tools/recipe'
import type { AssetRef } from '../model'
import { maximumCoordinateMagnitude, maximumNodeIdLength, stableAssetId } from '../persistence/workflow-schema'
import type { CanvasCommand } from '../store/canvas-command'
import { frameEditorMetadata, frameEditorTimecode, type FrameEditorMetadata } from './frame-editor-state'

export const minimumFrameSequenceCount = 2
export const maximumFrameSequenceCount = 16

// frame-extract uses the uncapped .wf-preview aspect ratio, not its registry's
// 190px placeholder height. Reserve the square metadata-loading preview too.
// The 512px chrome budget covers header, frame controls, output placement,
// candidate strip/actions, runtime details and a rerun's progress notice.
const frameSequenceChromeHeight = 512
// The collage card includes the 180px image stage and 108px compact input list
// from collage-input-sorter.css, plus headings, notices, settings, candidates
// and both output/run actions. Its 340px registry size is only a placeholder.
const frameSequenceCollageHeight = 1024

export interface FrameSequenceNode {
  id: string
  type?: string | null
  position: { x: number; y: number }
  parentId?: string
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
  locked?: boolean
  draggable?: boolean
  disabled?: boolean
  data: { result?: unknown; status?: unknown; dirty?: unknown; __canvasLocked?: unknown; __canvasDisabled?: unknown }
}
export interface FrameSequenceEdge { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }
export interface FrameSequenceSnapshot { sourceNodeId: string; sourceKind: string; sourceAssetId: string; sourceHandle: 'out:video' }

function validDuration(duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400) throw new Error('请先读取有效的视频时长，最长支持 24 小时')
}

function validCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < minimumFrameSequenceCount || count > maximumFrameSequenceCount) throw new Error('每组分镜请选择 2–16 个时间点')
}

function validTimestamp(value: number, duration: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= duration) throw new Error('每个分镜时间点必须大于等于 0 且小于视频时长')
}

/** Preserve intentional chronology; never silently sort or drop requested frames. */
export function validateFrameSequenceTimestamps(values: readonly number[], duration: number): number[] {
  validDuration(duration)
  validCount(values.length)
  const result: number[] = []
  for (const value of values) {
    validTimestamp(value, duration)
    if (result.length && value <= result[result.length - 1]) throw new Error('分镜时间点请按从早到晚排列，且不能重复')
    result.push(Object.is(value, -0) ? 0 : value)
  }
  return result
}

export function parseFrameSequenceTimestamps(text: string, duration: number): number[] {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('分镜时间点文本过长，请保留 2–16 个秒数')
  const parts = text.trim().split(/[\s,，;；]+/)
  if (parts.some((part) => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(part))) throw new Error('请填写以逗号或换行分隔的秒数，例如 0, 1.25, 2.5')
  return validateFrameSequenceTimestamps(parts.map(Number), duration)
}

/** Millisecond sampling is a time selection, not a claim about video frame rate. */
export function evenlySpacedFrameSequence(count: number, start: number, end: number, duration: number): number[] {
  validDuration(duration)
  validCount(count)
  validTimestamp(start, duration)
  validTimestamp(end, duration)
  if (end <= start) throw new Error('结束时间必须晚于开始时间')
  const values = Array.from({ length: count }, (_, index) => Math.round((start + (end - start) * index / (count - 1)) * 1000) / 1000)
  try { return validateFrameSequenceTimestamps(values, duration) }
  catch { throw new Error('此时间范围不足以按毫秒区分所有画面，或结束时间过于接近视频末尾；请扩大范围、减少数量或手动填写时间点') }
}

function mediaResult(value: unknown): AssetRef | undefined {
  if (!value || typeof value !== 'object' || !('kind' in value) || !['image', 'video', 'audio'].includes(String(value.kind))) return undefined
  if (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio') return undefined
  return { kind: value.kind,
    ...('assetId' in value && typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
    ...('width' in value && typeof value.width === 'number' ? { width: value.width } : {}),
    ...('height' in value && typeof value.height === 'number' ? { height: value.height } : {}),
  }
}

function indexedNodes(nodes: readonly FrameSequenceNode[]): Map<string, FrameSequenceNode> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  if (byId.size !== nodes.length) throw new Error('画布节点编号重复，请重新打开工程')
  return byId
}

function ancestorChain(node: FrameSequenceNode, byId: ReadonlyMap<string, FrameSequenceNode>): FrameSequenceNode[] {
  const result = [node], seen = new Set([node.id])
  let current = node
  while (current.parentId) {
    const parent = byId.get(current.parentId)
    if (!parent || parent.type !== 'group' || seen.has(parent.id) || result.length > 8) throw new Error('画布分组层级无效，请重新打开工程')
    result.push(parent); seen.add(parent.id); current = parent
  }
  return result
}

export function captureFrameSequenceSource(nodes: readonly FrameSequenceNode[], sourceNodeId: string): FrameSequenceSnapshot {
  const byId = indexedNodes(nodes), source = byId.get(sourceNodeId)
  if (!source || !source.type || builtinNodeRegistry.port(source.type, 'out:video', 'output')?.kind !== 'video') throw new Error('请选择具有视频输出的节点后再创建分镜')
  for (const node of ancestorChain(source, byId)) {
    if (node.locked || node.draggable === false || node.disabled || node.data.__canvasLocked || node.data.__canvasDisabled) throw new Error('视频节点或所在分组已锁定或禁用，请先解除后再创建分镜')
  }
  if (source.data.status === 'queued' || source.data.status === 'running' || source.data.status === 'failed' || source.type !== 'video-input' && source.data.dirty) throw new Error('视频来源尚未完成或等待更新，请先完成上游再创建分镜')
  const result = mediaResult(source.data.result)
  if (result?.kind !== 'video' || !stableAssetId(result.assetId)) throw new Error('请先上传视频或完成视频生成，再创建分镜')
  return { sourceNodeId, sourceKind: source.type, sourceAssetId: result.assetId!, sourceHandle: 'out:video' }
}

export function assertFrameSequenceSource(nodes: readonly FrameSequenceNode[], snapshot: FrameSequenceSnapshot): void {
  const current = captureFrameSequenceSource(nodes, snapshot.sourceNodeId)
  if (current.sourceKind !== snapshot.sourceKind || current.sourceAssetId !== snapshot.sourceAssetId || snapshot.sourceHandle !== 'out:video') throw new Error('视频来源已变化，请重新打开分镜编辑器；当前画布已保留')
}

function placementNode(node: FrameSequenceNode): CanvasPlacementNode {
  const result = mediaResult(node.data.result), fallback = builtinNodeRegistry.resolve(node.type ?? '')?.dimensions
  return { id: node.id, type: node.type ?? undefined, parentId: node.parentId, position: node.position, width: node.width ?? fallback?.width, height: node.height ?? fallback?.height, measured: node.measured, ...(result ? { data: { result } } : {}) }
}

/** Compose existing nodes in one command so undo, persistence, receipt recovery,
 * copy and workshop reuse retain their established behavior. No pixels are read.
 */
export function buildFrameSequenceGraph(nodes: readonly FrameSequenceNode[], edges: readonly FrameSequenceEdge[], snapshot: FrameSequenceSnapshot, timestamps: readonly number[], metadata: FrameEditorMetadata, nextId: () => string): Extract<CanvasCommand, { type: 'add-nodes' }> {
  assertFrameSequenceSource(nodes, snapshot)
  const dimensions = frameEditorMetadata(metadata.duration, metadata.width, metadata.height)
  const times = validateFrameSequenceTimestamps(timestamps, dimensions.duration)
  if (dimensions.width * dimensions.height * times.length > maximumImageTransformTotalPixels) throw new Error(`当前视频分辨率的分镜拼图最多支持 ${Math.floor(maximumImageTransformTotalPixels / (dimensions.width * dimensions.height))} 张画面，请减少时间点或先使用较小视频`)
  if (nodes.length + times.length + 1 > maximumProjectNodes || edges.length + times.length * 2 > maximumProjectEdges) throw new Error('创建分镜后将超过工程的 2000 个节点或 4000 条连线，请先拆分工程')
  const byId = indexedNodes(nodes), source = byId.get(snapshot.sourceNodeId)!
  for (const node of nodes) ancestorChain(node, byId)
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (!edge.id || edgeIds.has(edge.id) || !byId.has(edge.source) || !byId.has(edge.target)) throw new Error('画布连线编号或节点引用无效，请重新打开工程')
    edgeIds.add(edge.id)
  }
  const usedIds = new Set([...byId.keys(), ...edgeIds])
  function id(): string {
    const value = nextId()
    if (typeof value !== 'string' || !value.trim() || value.length > maximumNodeIdLength || /[\u0000-\u001f\u007f]/.test(value) || usedIds.has(value)) throw new Error('新增分镜节点或连线编号无效或重复，请重试')
    usedIds.add(value)
    return value
  }
  const sourceWorld = ancestorChain(source, byId).reduce((position, node) => ({ x: position.x + node.position.x, y: position.y + node.position.y }), { x: 0, y: 0 })
  const frame = builtinNodeRegistry.require('frame-extract'), collage = builtinNodeRegistry.require('image-collage')
  const columns = Math.ceil(Math.sqrt(times.length)), rows = Math.ceil(times.length / columns), gap = 56
  const frameHeight = Math.max(frame.dimensions.height, Math.ceil(frame.dimensions.width * Math.max(1, dimensions.height / dimensions.width)) + frameSequenceChromeHeight)
  const collageHeight = Math.max(collage.dimensions.height, frameSequenceCollageHeight)
  const gridWidth = columns * frame.dimensions.width + (columns - 1) * gap
  const block = { width: gridWidth + 120 + collage.dimensions.width, height: Math.max(rows * frameHeight + (rows - 1) * gap, collageHeight) }
  const sourceWidth = source.width ?? builtinNodeRegistry.require(source.type!).dimensions.width
  const position = findAvailableCanvasPosition(nodes.map(placementNode), { x: sourceWorld.x + sourceWidth + 100 + block.width / 2, y: sourceWorld.y + block.height / 2 }, block)
  if ([position.x, position.y, position.x + block.width, position.y + block.height].some((value) => !Number.isFinite(value) || Math.abs(value) > maximumCoordinateMagnitude)) throw new Error('分镜位置超出画布范围，请将视频节点移近中心后重试')
  const collageId = id(), added: EditorNodeRecord[] = [], addedEdges: EditorEdgeRecord[] = [], slots: Array<{ edgeId: string; outputIndex: number }> = []
  for (const [index, timestampSeconds] of times.entries()) {
    const nodeId = id(), sourceEdgeId = id(), outputEdgeId = id()
    added.push({ id: nodeId, type: frame.type, definitionVersion: frame.version, position: { x: position.x + index % columns * (frame.dimensions.width + gap), y: position.y + Math.floor(index / columns) * (frameHeight + gap) }, ...frame.dimensions,
      data: { prompt: '', model: '', status: 'idle', dirty: true, settings: { title: `画面 ${String(index + 1).padStart(2, '0')} · ${frameEditorTimecode(timestampSeconds)}`, timestampSeconds } } })
    addedEdges.push({ id: sourceEdgeId, source: source.id, sourceHandle: 'out:video', target: nodeId, targetHandle: 'in:video' }, { id: outputEdgeId, source: nodeId, sourceHandle: 'out:image', target: collageId, targetHandle: 'in:images' })
    slots.push({ edgeId: outputEdgeId, outputIndex: 0 })
  }
  const scale = Math.min(640 / dimensions.width, 360 / dimensions.height, 1), cellWidth = Math.max(1, Math.round(dimensions.width * scale)), cellHeight = Math.max(1, Math.round(dimensions.height * scale))
  const recipe = parseImageTransformRecipe({ kind: 'collage', layout: 'grid', rows, columns, gap: 12, padding: 16, outputWidth: columns * cellWidth + (columns - 1) * 12 + 32, outputHeight: rows * cellHeight + (rows - 1) * 12 + 32, fit: 'contain', background: '#101217' })
  added.push({ id: collageId, type: collage.type, definitionVersion: collage.version, position: { x: position.x + gridWidth + 120, y: position.y }, ...collage.dimensions,
    data: { prompt: '', model: '', status: 'idle', dirty: true, settings: { title: `${times.length} 帧分镜拼图`, imageTransform: recipe, imageCollageInputOrder: collageInputOrderFromSlots(slots) } } })
  return { type: 'add-nodes', nodes: added, edges: addedEdges }
}
