import { describe, expect, it } from 'vitest'
import { builtinCanvasTemplates } from './builtin-templates'
import { instantiateTemplate, placeTemplateInstance } from './instantiate-template'

const nodeTypes = new Set([
  'prompt', 'image-input', 'video-input', 'image-generate', 'image-edit',
  'video-generate', 'frame-extract', 'router', 'gallery', 'output',
])

function idFactory() {
  let id = 0
  return () => `instance-${++id}`
}

describe('built-in canvas templates', () => {
  it('provides three Xingmang-original templates without example media', () => {
    expect(builtinCanvasTemplates.map((template) => template.name)).toEqual([
      '快速文生图', '参考图改图', '产品图生成短视频',
    ])
    for (const template of builtinCanvasTemplates) {
      expect(template.provenance.kind).toBe('xingmang-original')
      expect(template.thumbnail.kind).toBe('color')
      expect(JSON.stringify(template)).not.toMatch(/https?:|data:|api[_-]?key|token|password/i)
    }
  })

  it('does not claim unsupported count semantics in built-in templates', () => {
    for (const template of builtinCanvasTemplates) {
      expect(JSON.stringify(template)).not.toMatch(/\"count\"\s*:/)
    }
  })

  it('remaps every node and edge ID and never auto-runs', () => {
    const instance = instantiateTemplate(builtinCanvasTemplates[0], {
      values: { prompt: '白色背景中的产品静物' },
      availableNodeTypes: nodeTypes,
      createId: idFactory(),
    })
    expect(instance.autoRun).toBe(false)
    expect(new Set([...instance.nodes.map((node) => node.id), ...instance.edges.map((edge) => edge.id)]).size)
      .toBe(instance.nodes.length + instance.edges.length)
    expect(instance.nodes.find((node) => node.type === 'prompt')?.config.prompt).toBe('白色背景中的产品静物')
    expect(instance.edges.every((edge) => edge.source.startsWith('instance-') && edge.target.startsWith('instance-'))).toBe(true)
  })

  it('does not mutate the template when an instance is edited', () => {
    const template = builtinCanvasTemplates[0]
    const instance = instantiateTemplate(template, {
      values: { prompt: '测试提示词' },
      availableNodeTypes: nodeTypes,
      createId: idFactory(),
    })
    instance.nodes[0].config.prompt = '已修改'
    expect(template.workflow.nodes[0].config.prompt).toBe('')
  })

  it('places a reusable template below existing work without mutating either input', () => {
    const instance = instantiateTemplate(builtinCanvasTemplates[0], {
      values: { prompt: '测试' }, availableNodeTypes: nodeTypes, createId: idFactory(),
    })
    const original = structuredClone(instance)
    const placed = placeTemplateInstance(instance, [{ position: { x: 120, y: 240 }, height: 260 }])
    expect(Math.min(...placed.nodes.map((node) => node.position.y))).toBe(580)
    expect(Math.min(...placed.nodes.map((node) => node.position.x))).toBe(120)
    expect(instance).toEqual(original)
    expect(placeTemplateInstance(instance, [])).toEqual(instance)
  })

  it('rejects missing variables and unavailable node types before mutation', () => {
    expect(() => instantiateTemplate(builtinCanvasTemplates[1], {
      values: { prompt: '只给提示词' },
      availableNodeTypes: nodeTypes,
      createId: idFactory(),
    })).toThrow(/参考图/)
    expect(() => instantiateTemplate(builtinCanvasTemplates[0], {
      values: { prompt: '测试' },
      availableNodeTypes: new Set(['prompt']),
      createId: idFactory(),
    })).toThrow(/缺少模板所需节点/)
  })

  it('allows required inputs to stay empty when opening a draft in the editor', () => {
    expect(() => instantiateTemplate(builtinCanvasTemplates[1], {
      availableNodeTypes: nodeTypes,
      createId: idFactory(),
      draft: true,
    })).not.toThrow()
  })

  it('binds only stable local asset ids to asset template variables', () => {
    const assetId = 'a'.repeat(43)
    const instance = instantiateTemplate(builtinCanvasTemplates[1], {
      values: { reference: assetId, prompt: '保持主体' },
      availableNodeTypes: nodeTypes,
      createId: idFactory(),
    })
    expect(instance.nodes.find((node) => node.type === 'image-input')?.config.assetId).toBe(assetId)
    expect(() => instantiateTemplate(builtinCanvasTemplates[1], {
      values: { reference: '../private.png', prompt: '保持主体' },
      availableNodeTypes: nodeTypes,
      createId: idFactory(),
    })).toThrow('素材标识无效')
  })

  it('rejects credentials even when hidden in nested config', () => {
    const poisoned = structuredClone(builtinCanvasTemplates[0])
    poisoned.workflow.nodes[0].config = { nested: { accessToken: 'secret' } }
    expect(() => instantiateTemplate(poisoned, {
      values: { prompt: '测试' },
      availableNodeTypes: nodeTypes,
      createId: idFactory(),
    })).toThrow(/禁止包含凭据/)
  })
})
