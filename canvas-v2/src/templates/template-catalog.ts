import { templateImageModelCompatibility } from './template-catalog-image-options'
import type { CanvasTemplate, CanvasTemplateIndustry } from './template-types'

export const canvasTemplateIndustries: readonly { id: CanvasTemplateIndustry; label: string }[] = [
  { id: 'story', label: '漫剧与叙事' },
  { id: 'commerce', label: '电商视觉' },
  { id: 'architecture', label: '建筑家装' },
  { id: 'social-media', label: '自媒体' },
  { id: 'education', label: '教育绘本' },
  { id: 'game', label: '游戏美术' },
  { id: 'marketing-film', label: '广告影视' },
]

export interface CanvasTemplateEstimate {
  imageRequests: number
  videoRequests: number
  textRequests: number
  paidRequests: number
}

export interface CanvasTemplateCompatibility {
  available: boolean
  reasons: string[]
}

export function estimateCanvasTemplate(template: CanvasTemplate): CanvasTemplateEstimate {
  const imageRequests = template.workflow.nodes.filter((node) => ['image-generate', 'image-edit'].includes(node.type)).length
  const videoRequests = template.workflow.nodes.filter((node) => node.type === 'video-generate').length
  const textRequests = template.workflow.nodes.filter((node) => ['text-generate', 'drama-parse'].includes(node.type)).length
  return { imageRequests, videoRequests, textRequests, paidRequests: imageRequests + videoRequests + textRequests }
}

export function searchCanvasTemplates(templates: readonly CanvasTemplate[], query: string): CanvasTemplate[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return [...templates]
  const labels = new Map(canvasTemplateIndustries.map((entry) => [entry.id, entry.label]))
  return templates.filter((template) => [
    template.name, template.description, template.deliverable, labels.get(template.industry) ?? '', ...template.tags,
  ].join(' ').toLocaleLowerCase('zh-CN').includes(normalized))
}

export function canvasTemplateCompatibility(
  template: CanvasTemplate,
  imageModels: readonly string[],
  videoModels: readonly string[],
  textModels: readonly string[] = [],
): CanvasTemplateCompatibility {
  const reasons: string[] = []
  for (const requirement of template.requirements) {
    if (requirement.media === 'text') {
      if (requirement.operation === 'generate' && textModels.length === 0) reasons.push('当前文字来源没有可用模型')
      continue
    }
    if (requirement.media === 'video') {
      if (requirement.operation === 'generate' && videoModels.length === 0) reasons.push('当前视频分组没有可用模型')
      continue
    }
    const imageNodes = template.workflow.nodes.filter((node) => requirement.operation === 'edit' ? node.type === 'image-edit' : ['image', 'image-generate'].includes(node.type))
    const configurations: readonly Readonly<Record<string, unknown>>[] = imageNodes.length > 0 ? imageNodes.map((node) => node.config) : [{}]
    for (const config of configurations) {
      const explicitModel = typeof config.model === 'string' ? config.model.trim() : ''
      const candidates = explicitModel ? imageModels.filter((model) => model === explicitModel) : imageModels
      const inspected = candidates.map((model) => templateImageModelCompatibility(model, requirement.operation, config, requirement.options))
      if (inspected.some((entry) => entry.available)) continue
      const explanation = inspected.length > 0
        ? [...new Set(inspected.flatMap((entry) => entry.reasons))].join('；')
        : explicitModel ? `模板指定的模型「${explicitModel}」不属于当前生图分组` : '当前生图分组没有可用图像模型'
      reasons.push(`${explanation}。请显式选择兼容模型或在画布中调整图片比例/清晰度，也可先保存待配置骨架；不会自动更改模板参数`)
    }
  }
  return { available: reasons.length === 0, reasons: [...new Set(reasons)] }
}

export function groupCanvasTemplatesByIndustry(templates: readonly CanvasTemplate[]): ReadonlyMap<CanvasTemplateIndustry, CanvasTemplate[]> {
  return new Map(canvasTemplateIndustries.map(({ id }) => [id, templates.filter((template) => template.industry === id)]))
}
