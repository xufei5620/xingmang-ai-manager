import { imageEditMaskModelSupported, parseImageEditMask, rasterizeImageEditMask, type ImageEditMask } from './image-edit-mask'
import type { AssetRef, WorkflowNodeData } from '../model'

export function parseNodeImageEditMask(kind: string, value: unknown): ImageEditMask | undefined {
  if (value === undefined) return undefined
  if (kind !== 'image-edit') throw new Error('蒙版局部修改配置只能保存在局部修改图像节点中')
  return parseImageEditMask(value)
}

interface MaskSourceNode { id: string; type?: string | null; data: Pick<WorkflowNodeData, 'result' | 'candidateAssetIds' | 'settings'> }
interface MaskSourceEdge { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }
export interface ImageMaskSource { sourceNodeId: string; asset: AssetRef & { assetId: string; localUrl: string } }

export function resolveImageMaskSource(nodes: readonly MaskSourceNode[], edges: readonly MaskSourceEdge[], nodeId: string, from: 'input' | 'output'): ImageMaskSource {
  const target = nodes.find((node) => node.id === nodeId)
  if (!target) throw new Error('原节点已删除，请重新选择图片')
  let source = target
  if (from === 'input') {
    if (target.type !== 'image-edit') throw new Error('请从图片工具栏创建局部修改节点')
    const incoming = edges.filter((edge) => edge.target === nodeId && ['in:image', 'in:images'].includes(edge.targetHandle ?? ''))
    if (incoming.length !== 1 || incoming[0].sourceHandle !== 'out:image') throw new Error('蒙版局部修改只支持一张基图，请连接唯一图片；不支持整组输入')
    const found = nodes.find((node) => node.id === incoming[0].source)
    if (!found) throw new Error('原图节点已丢失，请重新连接图片')
    source = found
  }
  if (source.type === 'gallery' && (source.data.candidateAssetIds?.length ?? 0) > 1) throw new Error('画廊含多张图片，请先将所需图片独立放到画布再做局部修改')
  const asset = source.data.result
  if (asset?.kind !== 'image' || !asset.assetId || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || !asset.localUrl) throw new Error('请先连接或选择一张已保存的图片')
  return { sourceNodeId: source.id, asset: { ...asset, assetId: asset.assetId, localUrl: asset.localUrl } }
}

/** Display checks do not rasterize on every keystroke; execution preflight also
 * checks the actual binary mask, including an eraser that removed every pixel. */
export function imageMaskConfigurationError(value: unknown, kind: string, model: string, sources: readonly { assetId?: string; width?: number; height?: number; batch?: boolean }[], checkPixels = false): string | null {
  if (value === undefined) return null
  try {
    const mask = parseNodeImageEditMask(kind, value)!
    if (!imageEditMaskModelSupported(model)) throw new Error('当前模型尚未接通蒙版局部修改，请选择支持的 GPT Image 模型')
    if (!mask.sourceAssetId) throw new Error('请打开蒙版编辑器，核对并绑定当前原图后再运行')
    if (sources.length !== 1 || sources[0].batch || sources[0].assetId !== mask.sourceAssetId) throw new Error('原图已变化或不是唯一单图，请重新核对蒙版')
    if (sources[0].width !== undefined && sources[0].width !== mask.width || sources[0].height !== undefined && sources[0].height !== mask.height) throw new Error('原图尺寸已变化，请重新核对蒙版')
    if (!mask.strokes.some((stroke) => stroke.tool === 'brush') || checkPixels && !rasterizeImageEditMask(mask).editedPixels) throw new Error('请先涂抹希望修改的区域，空蒙版不能生成')
    return null
  } catch (cause) { return cause instanceof Error ? cause.message : '蒙版配置不正确，请重新核对' }
}
