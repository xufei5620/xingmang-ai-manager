import { imageCollageInputCountError, imageCollageUsesAutoSize, imageTransformProcessorRevision, imageTransformRecipeNeedsSources, maximumImageTransformInputs, parseImageTransformRecipe, type ImageTransformRecipe } from '../image-tools/recipe'
import { assertLayerGroupsClientVersion, imageTransformHasLayerGroups } from './layer-groups-contract'

export { imageTransformProcessorRevision }
export const maximumImageTransformBytes = 20 * 1024 * 1024
export const maximumImageTransformFormBytes = maximumImageTransformBytes + 64 * 1024
export const maximumImageTransformBatchBytes = 64 * 1024 * 1024
export const maximumImageTransformBatchPixels = 33_554_432
export const maximumImageTransformJsonBytes = 256 * 1024

export interface CanvasImagePreparation {
  layerGroupsVersion?: 1
  operationId: string
  runId: string
  projectId: string
  nodeId: string
  attemptId: string
  sourceAssetIds: string[]
  recipe: ImageTransformRecipe
  processorRevision: string
}

export interface ImageTransformOutputManifest {
  index: number
  pngDigest: string
  byteSize: number
  width: number
  height: number
}

export interface ImageTransformProvenance {
  version: 1
  origin: 'browser-image-transform'
  operationId: string
  runId: string
  projectId: string
  nodeId: string
  attemptId: string
  sourceAssetIds: string[]
  processorRevision: string
  recipeDigest: string
  requestDigest: string
  outputIndex: number
  outputCount: number
}

export class ImageTransformDerivationError extends Error {
  constructor(message: string, public status = 400, public code = 'IMAGE_TRANSFORM_INVALID') { super(message) }
}

export function imageTransformObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImageTransformDerivationError('图像处理请求格式不正确')
  return value as Record<string, unknown>
}

export function imageTransformIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ImageTransformDerivationError('图像处理操作编号无效，请使用原操作重试')
  return value
}

export function parseImagePreparation(value: unknown): CanvasImagePreparation {
  const input = imageTransformObject(value)
  if (Object.keys(input).some((key) => !['operationId', 'runId', 'projectId', 'nodeId', 'attemptId', 'sourceAssetIds', 'recipe', 'processorRevision', 'layerGroupsVersion'].includes(key))) throw new ImageTransformDerivationError('图像处理请求包含不支持的字段')
  const requiresGroups = imageTransformHasLayerGroups(input.recipe)
  try { assertLayerGroupsClientVersion(input.layerGroupsVersion, requiresGroups) } catch (error) { throw new ImageTransformDerivationError(error instanceof Error ? error.message : '持久图层编组版本不支持', 409) }
  if (typeof input.projectId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.projectId)) throw new ImageTransformDerivationError('图像处理工程编号无效')
  if (!Array.isArray(input.sourceAssetIds) || input.sourceAssetIds.length > maximumImageTransformInputs || !input.sourceAssetIds.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id))) throw new ImageTransformDerivationError('图像处理最多支持 20 个本账户图片素材')
  if (input.processorRevision !== imageTransformProcessorRevision) throw new ImageTransformDerivationError('图像处理版本已变化，请保留原任务并重新进入画布', 409, 'IMAGE_TRANSFORM_REVISION')
  const operationId = imageTransformIdentifier(input.operationId)
  const attemptId = imageTransformIdentifier(input.attemptId)
  if (operationId !== attemptId) throw new ImageTransformDerivationError('图像处理必须使用原节点尝试编号')
  let recipe: ImageTransformRecipe
  try { recipe = parseImageTransformRecipe(input.recipe) } catch { throw new ImageTransformDerivationError('图像处理参数无效，请检查节点设置') }
  if (!input.sourceAssetIds.length && imageTransformRecipeNeedsSources(recipe)) throw new ImageTransformDerivationError('当前图像工具需要图片来源，仅纯文字和形状图层可不选图片')
  if (['crop', 'grid-split', 'tile'].includes(recipe.kind) && input.sourceAssetIds.length !== 1) throw new ImageTransformDerivationError('当前图像工具需要恰好一个图片来源')
  if (recipe.kind === 'collage') {
    const error = imageCollageInputCountError(recipe, input.sourceAssetIds.length)
    if (error) throw new ImageTransformDerivationError(error)
  }
  const sourceCount = input.sourceAssetIds.length
  if (recipe.kind === 'layer' && recipe.layers.some((layer) => !layer.content && layer.sourceIndex >= sourceCount)) throw new ImageTransformDerivationError('图层引用的输入图片已变化，请重新检查图层顺序')
  return { ...(requiresGroups ? { layerGroupsVersion: 1 as const } : {}), operationId, runId: imageTransformIdentifier(input.runId), projectId: input.projectId, nodeId: imageTransformIdentifier(input.nodeId), attemptId, sourceAssetIds: [...input.sourceAssetIds], recipe, processorRevision: imageTransformProcessorRevision }
}

export function parseImageTransformManifest(value: unknown): ImageTransformOutputManifest[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new ImageTransformDerivationError('图像处理结果必须为 1–16 张 PNG')
  let totalBytes = 0
  let totalPixels = 0
  const manifest = value.map((entry, index) => {
    const item = imageTransformObject(entry)
    if (Object.keys(item).some((key) => !['index', 'pngDigest', 'byteSize', 'width', 'height'].includes(key)) || item.index !== index
      || typeof item.pngDigest !== 'string' || !/^[0-9a-f]{64}$/.test(item.pngDigest)
      || typeof item.byteSize !== 'number' || !Number.isSafeInteger(item.byteSize) || item.byteSize < 1 || item.byteSize > maximumImageTransformBytes
      || typeof item.width !== 'number' || !Number.isSafeInteger(item.width) || item.width < 1 || item.width > 4096
      || typeof item.height !== 'number' || !Number.isSafeInteger(item.height) || item.height < 1 || item.height > 4096 || item.width * item.height > 16_777_216) throw new ImageTransformDerivationError('图片顺序、文件摘要或尺寸不符合图像处理要求')
    totalBytes += item.byteSize
    totalPixels += item.width * item.height
    return { index, pngDigest: item.pngDigest, byteSize: item.byteSize, width: item.width, height: item.height }
  })
  if (totalBytes > maximumImageTransformBatchBytes || totalPixels > maximumImageTransformBatchPixels) throw new ImageTransformDerivationError('本次处理的全部图片超过容量或像素预算，请减小输出尺寸', 413)
  return manifest
}

export function parseImageTransformManifestForPreparation(value: unknown, input: CanvasImagePreparation): ImageTransformOutputManifest[] {
  const manifest = parseImageTransformManifest(value)
  const recipe = input.recipe
  if (manifest.length !== (recipe.kind === 'grid-split' ? recipe.rows * recipe.columns : 1)) throw new ImageTransformDerivationError('图像处理输出数量与节点设置不匹配')
  // Like split outputs, automatic strips depend on EXIF-normalised browser
  // dimensions. This permits a bounded manifest, not a claim that its pixels
  // are correct. Fixed recipes still require an exact declared size.
  if (recipe.kind !== 'grid-split' && !imageCollageUsesAutoSize(recipe) && manifest.some((item) => item.width !== recipe.outputWidth || item.height !== recipe.outputHeight)) throw new ImageTransformDerivationError('图像处理输出尺寸与节点设置不匹配')
  return manifest
}

export async function imageTransformDigest(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
