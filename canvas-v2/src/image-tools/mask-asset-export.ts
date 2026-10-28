import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { findAvailableCanvasPosition, type CanvasPlacementNode } from '../editor/node-placement'
import type { CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import type { WorkflowNodeData } from '../model'
import type { CanvasCommand } from '../store/canvas-command'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { downstreamNodeIds } from '../runtime/run-projection'
import { replaceAnnotatedImage } from './annotation-workflow'
import { parseImageEditMask, rasterizeImageEditMask, type ImageEditMask } from './image-edit-mask'
import { resolveImageMaskSource, type ImageMaskSource } from './image-mask-workflow'

export interface ImageMaskAssetPng { blob: Blob; width: number; height: number }
export type MaskAssetSaveMode = 'new' | 'linked' | 'replace'
export interface MaskAssetSourceSession { nodeId: string; from: 'input' | 'output'; source: ImageMaskSource }
export interface MaskAssetSourceNode extends CanvasPlacementNode {
  id: string
  locked?: boolean
  disabled?: boolean
  draggable?: boolean
  data: WorkflowNodeData
}
export interface MaskAssetSourceEdge { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }

export const maximumMaskAssetPngBytes = 4 * 1024 * 1024

function nodeMap<T extends MaskAssetSourceNode>(nodes: readonly T[]): Map<string, T> {
  const result = new Map<string, T>()
  for (const node of nodes) {
    if (result.has(node.id)) throw new Error('节点标识重复，请重新打开工程后保存蒙版')
    result.set(node.id, node)
  }
  return result
}

function editableChain<T extends MaskAssetSourceNode>(byId: ReadonlyMap<string, T>, id: string): T {
  const target = byId.get(id)
  if (!target) throw new Error('蒙版原节点已删除，请重新打开蒙版编辑器')
  const seen = new Set<string>()
  let current: T | undefined = target
  while (current) {
    if (seen.has(current.id)) throw new Error('蒙版所属分组存在循环，请先修复分组')
    seen.add(current.id)
    if (current.locked || current.draggable === false || current.data.settings?.locked === true) throw new Error('蒙版原节点或所属分组已锁定，请先解锁')
    if (current.disabled || current.data.settings?.disabled === true) throw new Error('蒙版原节点或所属分组已停用，请先启用')
    if (current.data.status === 'running' || current.data.status === 'queued') throw new Error('蒙版原节点或所属分组正在运行，请等待完成')
    if (!current.parentId) break
    const parent: T | undefined = byId.get(current.parentId)
    if (!parent || parent.type !== 'group') throw new Error('蒙版所属分组已丢失或类型已变化，请重新打开工程')
    current = parent
  }
  return target
}

function assertDimension(value: number | undefined, expected?: number): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 1 || value > 4096 || expected !== undefined && value !== expected) throw new Error('蒙版与当前原图或保存图片的像素尺寸不一致')
}

function assertSourceIdentity(source: ImageMaskSource): void {
  const asset = source.asset
  if (asset.kind !== 'image' || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || asset.localUrl !== `xingmang-asset://image/${asset.assetId}`) throw new Error('蒙版原图身份无法确认，请重新选择已保存图片')
  assertDimension(asset.width)
  assertDimension(asset.height)
}

export function assertMaskAssetSource<T extends MaskAssetSourceNode>(nodes: readonly T[], edges: readonly MaskAssetSourceEdge[], session: MaskAssetSourceSession, mask?: ImageEditMask): { target: T; source: ImageMaskSource } {
  const byId = nodeMap(nodes)
  const target = editableChain(byId, session.nodeId)
  const source = resolveImageMaskSource(nodes, edges, session.nodeId, session.from)
  editableChain(byId, source.sourceNodeId)
  assertSourceIdentity(source)
  assertSourceIdentity(session.source)
  if (session.from === 'input' && source.sourceNodeId === target.id) throw new Error('蒙版原图不能连接自身，请先修复连线')
  if (source.sourceNodeId !== session.source.sourceNodeId || source.asset.assetId !== session.source.asset.assetId || source.asset.localUrl !== session.source.asset.localUrl
    || source.asset.mimeType !== session.source.asset.mimeType) throw new Error('蒙版原图或当前候选已变化，请重新打开核对')
  assertDimension(source.asset.width, session.source.asset.width)
  assertDimension(source.asset.height, session.source.asset.height)
  if (mask) {
    const parsed = parseImageEditMask(mask)
    if (parsed.sourceAssetId !== source.asset.assetId) throw new Error('蒙版尚未绑定当前原图，请先确认适配')
    for (const asset of [source.asset, session.source.asset]) {
      assertDimension(asset.width, parsed.width)
      assertDimension(asset.height, parsed.height)
    }
  }
  return { target, source }
}

function pngDimensions(png: Pick<ImageMaskAssetPng, 'width' | 'height'>): void {
  assertDimension(png.width)
  assertDimension(png.height)
  if (png.width === undefined || png.height === undefined) throw new Error('蒙版 PNG 缺少已确认的像素尺寸')
}

export function parseMaskAssetUpload(upload: CanvasAssetSummary, png: Pick<ImageMaskAssetPng, 'width' | 'height'>): CanvasImageAssetSummary {
  pngDimensions(png)
  if (upload.mediaType !== 'image' || upload.mimeType !== 'image/png' || !/^[A-Za-z0-9_-]{43}$/.test(upload.assetId)
    || upload.localUrl !== `xingmang-asset://image/${upload.assetId}` || upload.deletedAt !== undefined) throw new Error('蒙版素材上传回执无法确认，请到素材库核对；当前画布没有改变')
  assertDimension(upload.width, png.width)
  assertDimension(upload.height, png.height)
  return { ...upload, width: png.width, height: png.height }
}

function confirmedMaskAsset(asset: CanvasImageAssetSummary): CanvasImageAssetSummary {
  if (asset.width === undefined || asset.height === undefined) throw new Error('蒙版图片尚未完整保存，请先核对素材库')
  return parseMaskAssetUpload(asset, { width: asset.width, height: asset.height })
}

export function buildMaskAssetNode(nodes: readonly MaskAssetSourceNode[], session: MaskAssetSourceSession, asset: CanvasImageAssetSummary, id: string): Extract<CanvasCommand, { type: 'add-nodes' }> {
  const byId = nodeMap(nodes)
  editableChain(byId, session.nodeId)
  const source = editableChain(byId, session.source.sourceNodeId)
  assertSourceIdentity(session.source)
  if (session.from === 'output' && source.id !== session.nodeId || source.data.result?.kind !== 'image' || source.data.result.assetId !== session.source.asset.assetId || source.data.result.localUrl !== session.source.asset.localUrl) throw new Error('蒙版原图已变化，当前没有添加图片节点')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || byId.has(id)) throw new Error('新蒙版节点标识无效或已存在')
  if (asset.mediaType !== 'image' || asset.mimeType !== 'image/png' || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId)
    || asset.localUrl !== `xingmang-asset://image/${asset.assetId}` || asset.deletedAt !== undefined || asset.width === undefined || asset.height === undefined) throw new Error('蒙版图片尚未完整保存，请先核对素材库')
  pngDimensions({ width: asset.width, height: asset.height })
  for (const original of [source.data.result, session.source.asset]) {
    assertDimension(original.width, asset.width)
    assertDimension(original.height, asset.height)
  }
  const dimensions = mediaAssetNodeDimensions(asset)
  let x = source.position.x, y = source.position.y, ancestor = source
  while (ancestor.parentId) { ancestor = byId.get(ancestor.parentId)!; x += ancestor.position.x; y += ancestor.position.y }
  const sourceWidth = source.measured?.width ?? source.width ?? mediaAssetNodeDimensions(session.source.asset).width
  const position = findAvailableCanvasPosition(nodes, { x: x + sourceWidth + 48 + dimensions.width / 2, y: y + dimensions.height / 2 }, dimensions)
  const title = typeof source.data.settings?.title === 'string' && source.data.settings.title.trim() ? source.data.settings.title.trim().slice(0, 120) : builtinNodeRegistry.resolve(source.type ?? '')?.title ?? '图片'
  return { type: 'add-nodes', nodes: [{
    id, type: 'image-input', definitionVersion: builtinNodeRegistry.require('image-input').version, position, ...dimensions,
    data: { prompt: '', model: '', status: 'succeeded', settings: { title: `${title} · 蒙版` }, result: { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: 'image/png', width: asset.width, height: asset.height } },
  }] }
}

function generationText(value: unknown, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || optional && !value.trim()) throw new Error('新蒙版节点的生成参数无法确认，请重新选择模型与来源')
  return value
}

/** A saved bitmap is a document output, never evidence of a model request or
 * cache hit. Only explicit future preflight may execute this generation node. */
export function buildLinkedMaskAssetNode(nodes: readonly MaskAssetSourceNode[], session: MaskAssetSourceSession, asset: CanvasImageAssetSummary, id: string, edgeId: string, generationData: WorkflowNodeData): Extract<CanvasCommand, { type: 'add-nodes' }> {
  const saved = confirmedMaskAsset(asset)
  const snapshot = buildMaskAssetNode(nodes, session, saved, id).nodes[0]
  const source = nodes.find((node) => node.id === session.source.sourceNodeId)!
  if (builtinNodeRegistry.port(source.type ?? '', 'out:image', 'output')?.kind !== 'image') throw new Error('原节点没有单张图片输出端口，当前没有创建关联节点')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(edgeId)) throw new Error('新蒙版连线标识无效')
  const model = generationText(generationData.model, 512)!
  const group = generationText(generationData.group, 128, true)
  const quality = generationText(generationData.quality, 128, true)
  const size = generationText(generationData.size, 128, true)
  const resolution = generationData.imageResolution
  if (resolution !== undefined && !['1K', '2K', '4K'].includes(resolution)) throw new Error('新蒙版节点的分辨率参数无法确认')
  const imageCandidateCount = parseImageCandidateCount(generationData.imageCandidateCount, 'image-generate')
  return { type: 'add-nodes', nodes: [{
    ...snapshot, type: 'image-generate', definitionVersion: builtinNodeRegistry.require('image-generate').version,
    data: {
      prompt: '', model, status: 'succeeded',
      ...(group !== undefined ? { group } : {}), ...(quality !== undefined ? { quality } : {}), ...(size !== undefined ? { size } : {}),
      ...(resolution !== undefined ? { imageResolution: resolution } : {}), ...(imageCandidateCount !== undefined ? { imageCandidateCount } : {}),
      settings: snapshot.data.settings, result: snapshot.data.result,
    },
  }], edges: [{ id: edgeId, source: source.id, sourceHandle: 'out:image', target: id, targetHandle: 'in:images' }] }
}

export function replaceMaskAssetNode<T extends MaskAssetSourceNode>(nodes: readonly T[], edges: readonly MaskAssetSourceEdge[], session: MaskAssetSourceSession, asset: CanvasImageAssetSummary): T[] {
  if (session.from !== 'output') throw new Error('保存至当前节点需要从当前图片重新打开蒙版编辑器')
  const { target, source } = assertMaskAssetSource(nodes, edges, session)
  const saved = confirmedMaskAsset(asset)
  assertDimension(source.asset.width, saved.width)
  assertDimension(source.asset.height, saved.height)
  if (downstreamNodeIds([target.id], edges).includes(target.id)) throw new Error('当前图片存在循环连线，请先修复后保存蒙版')
  if ((target.data.candidateAssetIds?.filter((id) => id === source.asset.assetId).length ?? 0) > 1
    || (target.data.candidates?.filter((candidate) => candidate.asset.assetId === source.asset.assetId).length ?? 0) > 1
    || target.data.candidateAssetIds?.length && !target.data.candidateAssetIds.includes(source.asset.assetId)) throw new Error('当前候选顺序无法唯一确认，请重新选择图片后保存蒙版')
  const replacementId = `document:${target.id}:annotation:${saved.assetId}`
  return replaceAnnotatedImage(nodes, edges, target.id, source.asset.assetId, saved).map((node) => node.id !== target.id ? node : { ...node, data: {
    ...node.data,
    candidates: node.data.candidates?.map((candidate) => candidate.candidateId === replacementId ? { ...candidate, candidateId: `document:${target.id}:mask:${saved.assetId}` } : candidate),
  } })
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let value = n; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; table[n] = value >>> 0 }
  return table
}
const pngCrcTable = crcTable()

function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff
  for (let index = start; index < end; index++) value = pngCrcTable[(value ^ bytes[index]) & 255] ^ value >>> 8
  return (value ^ 0xffffffff) >>> 0
}

async function pngBytes(blob: Blob, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('蒙版 PNG 核对已取消')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); reject(new Error('蒙版 PNG 核对超时，请保留草稿后重试')) }, 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => blob.arrayBuffer()).then((buffer) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); signal?.throwIfAborted(); resolve(new Uint8Array(buffer)) }).catch((error: unknown) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error) })
  })
}

/** Transport structure only: this does not inflate IDAT or prove that its
 * decoded pixels equal the mask. The encoder and downloaded-pixel oracle must
 * independently establish those properties. */
export async function assertMaskAssetPng(mask: ImageEditMask, png: ImageMaskAssetPng, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const parsed = parseImageEditMask(mask)
  if (!rasterizeImageEditMask(parsed).editedPixels) throw new Error('蒙版没有需要保存的涂抹区域')
  pngDimensions(png)
  if (png.width !== parsed.width || png.height !== parsed.height) throw new Error('蒙版 PNG 尺寸与当前配方不一致')
  if (!(png.blob instanceof Blob) || png.blob.type !== 'image/png' || !png.blob.size || png.blob.size > maximumMaskAssetPngBytes) throw new Error('蒙版 PNG 为空、格式不正确或超过 4 MB')
  const bytes = await pngBytes(png.blob, signal)
  signal?.throwIfAborted()
  if (bytes.length !== png.blob.size || bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new Error('蒙版 PNG 文件头不完整')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8, chunks = 0, hasHeader = false, hasData = false, endedData = false, ended = false
  while (offset < bytes.length) {
    signal?.throwIfAborted()
    if (++chunks > 128 || offset + 12 > bytes.length) throw new Error('蒙版 PNG 数据块过多或不完整')
    const length = view.getUint32(offset), end = offset + 12 + length
    if (end > bytes.length) throw new Error('蒙版 PNG 数据块长度不完整')
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || pngCrc(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) throw new Error('蒙版 PNG 数据块校验失败')
    if (!hasHeader && type !== 'IHDR') throw new Error('蒙版 PNG 缺少首个图像尺寸块')
    if (type === 'IHDR') {
      if (hasHeader || length !== 13 || view.getUint32(offset + 8) !== png.width || view.getUint32(offset + 12) !== png.height
        || bytes[offset + 16] !== 1 || bytes[offset + 17] !== 0 || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw new Error('蒙版 PNG 必须是原尺寸、无透明通道的 1 位灰阶图片')
      hasHeader = true
    } else if (type === 'IDAT') {
      if (!length || endedData) throw new Error('蒙版 PNG 图像数据块无效')
      hasData = true
    } else if (type === 'IEND') {
      if (!hasData || length || end !== bytes.length) throw new Error('蒙版 PNG 结束块不完整')
      ended = true
    } else {
      if (type === 'tRNS' || ['acTL', 'fcTL', 'fdAT'].includes(type) || type[0] === type[0].toUpperCase()) throw new Error('蒙版 PNG 不能包含透明、动画或未知关键数据块')
      if (hasData) endedData = true
    }
    offset = end
  }
  if (!ended) throw new Error('蒙版 PNG 缺少结束块')
}
