import { describe, expect, it } from 'vitest'
import { operationDefaultsForTemplateNode } from '../domain/workflow-node-config'
import { buildImageRequestParameters } from '../runtime/image-request-parameters'
import { builtinCanvasTemplates } from './builtin-templates'
import { instantiateTemplate } from './instantiate-template'
import { canvasTemplateCompatibility } from './template-catalog'
import type { CanvasTemplate } from './template-types'

function architectureTemplate(): CanvasTemplate {
  const template = builtinCanvasTemplates.find((entry) => entry.id === 'xingmang-arch-mass-render')
  if (!template) throw new Error('Architecture fixture is missing')
  return structuredClone(template)
}

describe('template concrete image parameter compatibility', () => {
  it('reports the original 4:3 architecture dimensions as incompatible with GPT Image 1 before creation', () => {
    const template = architectureTemplate(), before = structuredClone(template)
    const result = canvasTemplateCompatibility(template, ['gpt-image-1'], [])
    expect(result.available).toBe(false)
    expect(result.reasons.join('；')).toContain('1536x1152')
    expect(result.reasons.join('；')).toContain('4:3')
    expect(result.reasons.join('；')).toContain('GPT Image 1')
    expect(result.reasons.join('；')).toContain('骨架')
    expect(template).toEqual(before)
  })

  it.each(['gpt-image-2', 'custom-paint-model', 'provider/house-style'])('accepts a model %s whose actual wire parameters retain the template dimensions', (model) => {
    const template = architectureTemplate()
    expect(canvasTemplateCompatibility(template, [model], [])).toEqual({ available: true, reasons: [] })
    for (const node of template.workflow.nodes.filter((entry) => entry.type === 'image-edit')) {
      const chosen = operationDefaultsForTemplateNode(node.type, [model], [], node.config)
      expect(chosen.available).toBe(true)
      expect(chosen.config).toMatchObject({ model, size: '1536x1152', quality: 'low' })
      expect(buildImageRequestParameters({ model, prompt: '模板实参', size: String(chosen.config.size), quality: String(chosen.config.quality) })).toMatchObject({ model, size: '1536x1152' })
    }
  })

  it('accepts a user-chosen GPT Image 1 size without mutating the original catalog', () => {
    const original = architectureTemplate(), configured = structuredClone(original)
    for (const node of configured.workflow.nodes) if (node.type === 'image-edit') node.config.size = '1536x1024'
    expect(canvasTemplateCompatibility(configured, ['gpt-image-1'], [])).toEqual({ available: true, reasons: [] })
    expect(original.workflow.nodes.find((node) => node.type === 'image-edit')?.config.size).toBe('1536x1152')
  })

  it('keeps an incompatible explicit model instead of silently choosing another available model', () => {
    const template = architectureTemplate()
    for (const node of template.workflow.nodes) if (node.type === 'image-edit') node.config.model = 'gpt-image-1'
    expect(canvasTemplateCompatibility(template, ['gpt-image-1', 'gpt-image-2'], []).available).toBe(false)
    const config = { model: 'gpt-image-1', size: '1536x1152', quality: 'low', imageResolution: '1K' }
    const result = operationDefaultsForTemplateNode('image-edit', ['gpt-image-1', 'gpt-image-2'], [], config)
    expect(result.available).toBe(false)
    expect(result.config).toMatchObject(config)
  })

  it('chooses a compatible model only when no model was explicitly chosen', () => {
    const config = { size: '1536x1152', quality: 'low' }
    const result = operationDefaultsForTemplateNode('image-edit', ['gpt-image-1', 'gpt-image-2'], [], config)
    expect(result).toMatchObject({ available: true, config: { model: 'gpt-image-2', size: '1536x1152', quality: 'low' } })
  })

  it('preserves the requested dimensions in an unavailable draft when only GPT Image 1 is available', () => {
    const template = architectureTemplate()
    let next = 0
    const instance = instantiateTemplate(template, { availableNodeTypes: new Set(template.requiredNodeTypes), createId: () => `draft-${++next}`, draft: true })
    expect(instance.autoRun).toBe(false)
    for (const node of instance.nodes.filter((entry) => entry.type === 'image-edit')) {
      const result = operationDefaultsForTemplateNode(node.type, ['gpt-image-1'], [], node.config)
      expect(result.available).toBe(false)
      expect(result.config).toMatchObject({ model: '', size: '1536x1152', quality: 'low' })
      expect(result.reason).toContain('1536x1152')
    }
  })

  it('rejects an unavailable 4K size without changing it to a smaller resolution', () => {
    const template = architectureTemplate()
    for (const node of template.workflow.nodes) if (node.type === 'image-edit') Object.assign(node.config, { size: '1024x1024', imageResolution: '4K' })
    const before = structuredClone(template)
    expect(canvasTemplateCompatibility(template, ['gpt-image-2'], []).available).toBe(false)
    const result = operationDefaultsForTemplateNode('image-edit', ['gpt-image-2'], [], { model: 'gpt-image-2', size: '1024x1024', imageResolution: '4K' })
    expect(result.available).toBe(false)
    expect(result.config).toMatchObject({ model: 'gpt-image-2', size: '1024x1024', imageResolution: '4K' })
    expect(template).toEqual(before)
  })

  it('checks every image branch and rejects known non-image catalog members', () => {
    const template = architectureTemplate()
    const images = template.workflow.nodes.filter((node) => node.type === 'image-edit')
    images[0].config.size = '1024x1024'
    expect(canvasTemplateCompatibility(template, ['gpt-image-1'], []).available).toBe(false)
    expect(canvasTemplateCompatibility(template, ['gpt-4.1-mini'], []).available).toBe(false)
  })
})
