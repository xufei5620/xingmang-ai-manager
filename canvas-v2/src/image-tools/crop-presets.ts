import type { CanvasWorkshopCreateInput, CanvasWorkshopItem, CanvasWorkshopItemSummary } from '../host'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { parseImageTransformRecipe, type ImageCropRecipe } from './recipe'
import { defaultImageCropEditorPreferences, parseImageCropEditorPreferences, type ImageCropEditorPreferences } from './crop-editor-preferences'
import { fitCropRatio } from './crop-editor-state'
import type { ImageTransformSize } from './geometry'

export interface CropPresetConfiguration { recipe: ImageCropRecipe; preferences: ImageCropEditorPreferences }

export function isCropPresetSummary(item: CanvasWorkshopItemSummary): boolean {
  return Boolean(item) && item.kind === 'node' && !item.deletedAt && item.nodeCount === 1 && item.edgeCount === 0 && Array.isArray(item.nodeKinds) && item.nodeKinds.length === 1 && item.nodeKinds[0] === 'image-crop'
}

export function cropPresetConfiguration(recipe: unknown, preferences?: unknown): CropPresetConfiguration {
  const parsed = parseImageTransformRecipe(recipe)
  if (parsed.kind !== 'crop') throw new Error('请选择单个裁剪节点保存的预设')
  return { recipe: parsed, preferences: preferences === undefined ? defaultImageCropEditorPreferences(parsed) : parseImageCropEditorPreferences(preferences) }
}

export function adaptCropPresetToSource(value: CropPresetConfiguration, source?: ImageTransformSize): CropPresetConfiguration {
  if (!source || !Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) throw new Error('请先连接图片并等待原图尺寸读取完成，再载入裁剪预设')
  const configuration = cropPresetConfiguration(value.recipe, value.preferences)
  const { recipe, preferences } = configuration
  if (preferences.ratioMode === '自由') return configuration
  const parts = preferences.ratioMode.split(':').map(Number)
  const ratio = preferences.ratioMode === '原图' ? source.width / source.height
    : preferences.ratioMode === '自定义' ? preferences.customWidth / preferences.customHeight : parts[0] / parts[1]
  // Ratio modes describe the source crop before rotation, just as the editor's
  // ratio control does. Keep the preset's explicit output dimensions and flips.
  return { recipe: fitCropRatio(recipe, source, ratio), preferences }
}

export function readCropPreset(item: CanvasWorkshopItem): CropPresetConfiguration {
  if (!isCropPresetSummary(item) || item.workflow?.schemaVersion !== 2 || !Array.isArray(item.workflow.nodes) || item.workflow.nodes.length !== 1 || !Array.isArray(item.workflow.edges) || item.workflow.edges.length !== 0) throw new Error('此条目不是可用的单节点裁剪预设，请重新选择')
  const node = item.workflow.nodes[0]
  if (node.kind !== 'image-crop' || node.parentId || node.disabled || !node.data?.settings?.imageTransform) throw new Error('此裁剪预设缺少有效参数，当前配置未改变')
  return cropPresetConfiguration(node.data.settings.imageTransform, node.data.settings.imageCropEditor)
}

export function assertCropPresetReceipt(item: CanvasWorkshopItem, input: CanvasWorkshopCreateInput): void {
  const actual = readCropPreset(item)
  const settings = input.workflow.nodes[0]?.data.settings
  const expected = cropPresetConfiguration(settings?.imageTransform, settings?.imageCropEditor)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('保存回执与本次裁剪配置不一致，请核对原保存记录')
}

export function buildCropPresetWorkflow(name: string, recipe: unknown, preferences: unknown): WorkflowFile {
  if (!name.trim() || name.trim().length > 160) throw new Error('请填写 1–160 个字符的预设名称')
  const configuration = cropPresetConfiguration(recipe, preferences)
  // Construct only reusable configuration. Do not copy the current node, whose
  // data can include source assets, provider identity and previous results.
  return { ...createEmptyWorkflow(name.trim()), nodes: [{ id: 'crop-preset', kind: 'image-crop', definitionVersion: 1, position: { x: 0, y: 0 }, data: {
    prompt: '', model: '', status: 'idle', settings: { imageTransform: configuration.recipe, imageCropEditor: configuration.preferences },
  } }] }
}
