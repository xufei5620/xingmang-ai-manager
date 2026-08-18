import { imageModelPresets } from '../models'
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
  paidRequests: number
}

export interface CanvasTemplateCompatibility {
  available: boolean
  reasons: string[]
}

export function estimateCanvasTemplate(template: CanvasTemplate): CanvasTemplateEstimate {
  const imageRequests = template.workflow.nodes.filter((node) => ['image-generate', 'image-edit'].includes(node.type)).length
  const videoRequests = template.workflow.nodes.filter((node) => node.type === 'video-generate').length
  return { imageRequests, videoRequests, paidRequests: imageRequests + videoRequests }
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
): CanvasTemplateCompatibility {
  const reasons: string[] = []
  for (const requirement of template.requirements) {
    if (requirement.media === 'video') {
      if (requirement.operation === 'generate' && videoModels.length === 0) reasons.push('当前视频分组没有可用模型')
      continue
    }
    const presets = imageModels.map((id) => imageModelPresets.find((preset) => preset.id === id)).filter(Boolean)
    const compatible = presets.some((preset) => {
      if (!preset) return false
      if (requirement.operation === 'edit' && !preset.supportsEdits) return false
      if (requirement.options?.includes('size') && !preset.supportsSize) return false
      if (requirement.options?.includes('quality') && !preset.supportsQuality) return false
      return true
    })
    if (!compatible) reasons.push(requirement.operation === 'edit' ? '当前生图分组没有可编辑图片的模型' : '当前生图分组没有满足模板参数的模型')
  }
  return { available: reasons.length === 0, reasons }
}

export function groupCanvasTemplatesByIndustry(templates: readonly CanvasTemplate[]): ReadonlyMap<CanvasTemplateIndustry, CanvasTemplate[]> {
  return new Map(canvasTemplateIndustries.map(({ id }) => [id, templates.filter((template) => template.industry === id)]))
}
