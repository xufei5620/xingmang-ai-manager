import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { videoRequestParameters } from '../lib/video-request-protocol'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { operationDefaultsForTemplateNode } from '../domain/workflow-node-config'
import { builtinCanvasTemplates } from './builtin-templates'
import { instantiateTemplate } from './instantiate-template'
import { canvasTemplateCompatibility, estimateCanvasTemplate } from './template-catalog'
import type { CanvasTemplate, TemplateInstance } from './template-types'
import { normalizeTemplateVideoConfiguration, templateVideoAspectRatio } from './template-video-options'
import { validateCanvasTemplate } from './validate-template'
import { validateTemplateConfiguratorState } from '../components/template-configurator-model'
import { TemplateCatalog } from '../components/TemplateCatalog'
import { emptyCanvasAssetPage } from '../host'

const imageAssetId = 'A'.repeat(43)
const availableNodeTypes = new Set(builtinNodeRegistry.list().map((definition) => definition.type))

function templateById(id: string): CanvasTemplate {
  const template = builtinCanvasTemplates.find((entry) => entry.id === id)
  if (!template) throw new Error('Template fixture is missing')
  return template
}

function instantiate(template: CanvasTemplate): TemplateInstance {
  const fields = Object.fromEntries(template.variables.map((variable) => [variable.id, variable.type === 'asset' ? imageAssetId : String(variable.defaultValue ?? '测试内容')]))
  const validation = validateTemplateConfiguratorState(template, fields, new Set([imageAssetId]))
  if (!validation.valid) throw new Error('Template fixture fields are invalid')
  let sequence = 0
  return instantiateTemplate(template, { values: validation.values, availableNodeTypes, createId: () => `fixture-${++sequence}` })
}

function videoWire(config: Record<string, unknown>, model: string) {
  const normalized = operationDefaultsForTemplateNode('video-generate', [], [model], config).config
  if (typeof normalized.model !== 'string' || typeof normalized.seconds !== 'string' || typeof normalized.size !== 'string') throw new Error('Invalid video fixture parameters')
  const ratio = normalized.videoAspectRatio
  if (ratio !== '16:9' && ratio !== '9:16' && ratio !== '1:1') throw new Error('Invalid video fixture aspect ratio')
  return videoRequestParameters({ model: normalized.model, prompt: '测试运镜', seconds: normalized.seconds, size: normalized.size, videoAspectRatio: ratio, imageCount: 1 })
}

describe('template actual request configuration', () => {
  it('validates every builtin graph and binds owned reference variables without changing the catalog', () => {
    expect(builtinCanvasTemplates).toHaveLength(24)
    const original = JSON.stringify(builtinCanvasTemplates)
    for (const template of builtinCanvasTemplates) {
      expect(() => validateCanvasTemplate(template)).not.toThrow()
      const instance = instantiate(template)
      expect(instance.autoRun).toBe(false)
      expect(instance.nodes).toHaveLength(template.workflow.nodes.length)
      expect(instance.edges).toHaveLength(template.workflow.edges.length)
      const nodeIds = new Set(instance.nodes.map((node) => node.id))
      for (const edge of instance.edges) { expect(nodeIds.has(edge.source)).toBe(true); expect(nodeIds.has(edge.target)).toBe(true) }
      for (const node of instance.nodes.filter((entry) => entry.type === 'image-input')) expect(node.config.assetId).toBe(imageAssetId)
    }
    expect(JSON.stringify(builtinCanvasTemplates)).toBe(original)
  })

  it.each([
    ['720x1280', '9:16', 720, 1280],
    ['1024x1024', '1:1', 1024, 1024],
    ['1280x720', '16:9', 1280, 720],
  ] as const)('preserves %s layout in MiniMax wire ratios and Grok wire dimensions', (size, ratio, width, height) => {
    const config = normalizeTemplateVideoConfiguration({ seconds: '5', size })
    expect(config.videoAspectRatio).toBe(ratio)
    const miniMax = videoWire(config, 'minimax-h3-base')
    expect(miniMax.body).toMatchObject({ model: 'minimax-h3-base', mode: 'i2va', aspect_ratio: ratio, resolution: '720p' })
    expect(miniMax.body).not.toHaveProperty('width')
    const grok = videoWire(config, 'grok-imagine-video')
    expect(grok.body).toMatchObject({ model: 'grok-imagine-video', width, height })
    expect(grok.body).not.toHaveProperty('aspect_ratio')
  })

  it('gives all four portrait video templates real 9:16 parameters with MiniMax', () => {
    const ids = ['xingmang-drama-shot-video', 'xingmang-drama-episode-6', 'xingmang-media-broll-3', 'xingmang-ad-ab-pair']
    for (const id of ids) {
      const instance = instantiate(templateById(id))
      const videos = instance.nodes.filter((node) => node.type === 'video-generate')
      expect(videos.length).toBeGreaterThan(0)
      for (const video of videos) {
        expect(video.config.size).toBe('720x1280')
        expect(videoWire(video.config, 'minimax-h3-base').body.aspect_ratio).toBe('9:16')
      }
    }
  })

  it('keeps the horizontal video templates and implicit default horizontal', () => {
    for (const id of ['xingmang-product-video', 'xingmang-film-animatic']) {
      const instance = instantiate(templateById(id))
      for (const video of instance.nodes.filter((node) => node.type === 'video-generate')) {
        const config: Record<string, unknown> = { size: '1280x720', ...video.config }
        expect(config.videoAspectRatio).toBe('16:9')
        expect(videoWire(config, 'minimax-h3-base').body.aspect_ratio).toBe('16:9')
        expect(videoWire(config, 'grok-imagine-video').body).toMatchObject({ width: 1280, height: 720 })
      }
    }
  })

  it('derives the ratio after template variables are applied and preserves a valid explicit ratio', () => {
    const template = structuredClone(templateById('xingmang-film-animatic'))
    template.variables = [...template.variables, { id: 'size', label: '尺寸', type: 'select', required: true, options: ['1024x1024'], target: { nodeId: 'video', path: 'size' } }]
    let sequence = 0
    const instance = instantiateTemplate(template, { values: { asset: imageAssetId, prompt: '测试运镜', size: '1024x1024' }, availableNodeTypes, createId: () => `square-${++sequence}` })
    expect(instance.nodes.find((node) => node.type === 'video-generate')?.config.videoAspectRatio).toBe('1:1')
    expect(normalizeTemplateVideoConfiguration({ size: '1280x720', videoAspectRatio: '1:1' })).toMatchObject({ size: '1280x720', videoAspectRatio: '1:1' })
  })

  it('rejects invalid dimensions or unsupported ratios instead of silently requesting landscape', () => {
    for (const size of ['', '720x0', '-720x1280', '9000x9000', '1200x1000', '720x1280-extra']) expect(() => templateVideoAspectRatio(size)).toThrow('模板视频')
    expect(() => normalizeTemplateVideoConfiguration({ size: '720x1280', videoAspectRatio: 'invalid' })).toThrow('模板视频比例')
  })

  it('counts script parsing as a real paid text request and requires a configured text model', () => {
    const template = templateById('xingmang-drama-script-parse')
    expect(template.requirements).toEqual([{ media: 'text', operation: 'generate' }])
    expect(estimateCanvasTemplate(template)).toEqual({ imageRequests: 0, videoRequests: 0, textRequests: 1, paidRequests: 1 })
    expect(canvasTemplateCompatibility(template, [], [])).toEqual({ available: false, reasons: ['当前文字来源没有可用模型'] })
    expect(canvasTemplateCompatibility(template, ['gpt-image-2'], ['grok-imagine-video'], []).available).toBe(false)
    expect(canvasTemplateCompatibility(template, [], [], ['owned-text-model'])).toEqual({ available: true, reasons: [] })
    expect(() => instantiate(template)).not.toThrow()
  })

  it('shows the script template text charge and only clears the unavailable warning with a text model', () => {
    const template = templateById('xingmang-drama-script-parse')
    const props = { open: true, templates: [template], assets: emptyCanvasAssetPage(), imageModels: [], videoModels: [], onClose() {}, async onPickAsset() { return null }, onInsert() {} }
    const unavailable = renderToStaticMarkup(createElement(TemplateCatalog, props))
    expect(unavailable).toContain('1 文字')
    expect(unavailable).toContain('当前模型未就绪')
    const ready = renderToStaticMarkup(createElement(TemplateCatalog, { ...props, textModels: ['owned-text-model'] }))
    expect(ready).toContain('1 文字')
    expect(ready).not.toContain('当前模型未就绪')
  })

  it('adds text generation to mixed estimates while retaining existing image and video counts', () => {
    const template = structuredClone(templateById('xingmang-quick-image'))
    template.workflow.nodes = [...template.workflow.nodes, { id: 'text', type: 'text-generate', definitionVersion: 1, position: { x: 1400, y: 0 }, config: {} }]
    expect(estimateCanvasTemplate(template)).toEqual({ imageRequests: 1, videoRequests: 0, textRequests: 1, paidRequests: 2 })
    expect(estimateCanvasTemplate(templateById('xingmang-drama-episode-6'))).toEqual({ imageRequests: 24, videoRequests: 6, textRequests: 0, paidRequests: 30 })
    expect(canvasTemplateCompatibility(templateById('xingmang-quick-image'), ['gpt-image-2'], []).available).toBe(true)
  })
})
