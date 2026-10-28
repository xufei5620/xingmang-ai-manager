// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/templates/templates.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import { describe, expect, it } from 'vitest'
import { builtinCanvasTemplates } from './builtin-templates'
import { instantiateTemplate, placeTemplateInstance } from './instantiate-template'
import { validateCanvasTemplate } from './validate-template'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'

// 桌面 000f9131 的 docs/canvas-third-party.json 里登记的模板，全是星芒原创。#4 按要求不读桌面专有文件，照抄成数据：
// 内核的内置模板和桌面登记的不一致时，同步进桌面前要先补桌面的登记。
const desktopRegisteredTemplateIds = [
  'xingmang-quick-image', 'xingmang-reference-edit', 'xingmang-product-video', 'xingmang-drama-script-parse',
  'xingmang-drama-character-sheet', 'xingmang-drama-shot-frame', 'xingmang-drama-shot-video', 'xingmang-drama-episode-6',
  'xingmang-comic-strip-6', 'xingmang-comic-lineart-color', 'xingmang-picturebook-12', 'xingmang-edu-courseware-4',
  'xingmang-ec-white-bg', 'xingmang-ec-scene-3', 'xingmang-ec-size-trio', 'xingmang-home-rough-6',
  'xingmang-arch-mass-render', 'xingmang-arch-renewal', 'xingmang-media-xhs-cover', 'xingmang-media-broll-3',
  'xingmang-game-icon-set', 'xingmang-game-variant', 'xingmang-ad-ab-pair', 'xingmang-film-animatic',
]

const nodeTypes = new Set(builtinNodeRegistry.list().map((definition) => definition.type))

function idFactory() {
  let id = 0
  return () => `instance-${++id}`
}

describe('built-in canvas templates', () => {
  it('provides 23 Xingmang-original templates without example media', () => {
    expect(builtinCanvasTemplates).toHaveLength(24)
    expect(builtinCanvasTemplates.slice(0, 3).map((template) => template.name)).toEqual([
      '快速文生图', '参考图改图', '产品图生成短视频',
    ])
    for (const template of builtinCanvasTemplates) {
      expect(template.provenance.kind).toBe('xingmang-original')
      expect(template.thumbnail.kind).toBe('color')
      expect(JSON.stringify(template)).not.toMatch(/https?:|data:|api[_-]?key|token|password/i)
      expect(() => validateCanvasTemplate(template)).not.toThrow()
    }
    expect(new Set(builtinCanvasTemplates.map((template) => template.id)).size).toBe(24)
    expect([...desktopRegisteredTemplateIds].sort()).toEqual(builtinCanvasTemplates.map((template) => template.id).sort())
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

  it('rejects unsafe variable paths without polluting global prototypes', () => {
    for (const path of [
      '__proto__.polluted',
      'constructor.value',
      'constructor.prototype',
      'nested.prototype.value',
      'settings.prototype.value',
    ]) {
      const poisoned = structuredClone(builtinCanvasTemplates[0])
      poisoned.variables[0].target.path = path
      expect(() => instantiateTemplate(poisoned, {
        values: { prompt: '测试' }, availableNodeTypes: nodeTypes, createId: idFactory(),
      })).toThrow(/变量路径无效/)
    }
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('validates graph ids, registry ports, versions, cardinality and layout', () => {
    const duplicateEdge = structuredClone(builtinCanvasTemplates[0])
    duplicateEdge.workflow.edges[1].id = duplicateEdge.workflow.edges[0].id
    expect(() => validateCanvasTemplate(duplicateEdge)).toThrow(/连线 ID 重复/)

    const stale = structuredClone(builtinCanvasTemplates[0])
    stale.workflow.nodes[0].definitionVersion = 99
    expect(() => validateCanvasTemplate(stale)).toThrow(/版本已过期/)

    const unknownHandle = structuredClone(builtinCanvasTemplates[0])
    unknownHandle.workflow.edges[0].targetHandle = 'in:image'
    expect(() => validateCanvasTemplate(unknownHandle)).toThrow(/目标端口无效/)

    const overlap = structuredClone(builtinCanvasTemplates[0])
    overlap.workflow.nodes[1].position = { ...overlap.workflow.nodes[0].position }
    expect(() => validateCanvasTemplate(overlap)).toThrow(/节点发生重叠/)

    const duplicateVariable = structuredClone(builtinCanvasTemplates[0])
    duplicateVariable.variables = [...duplicateVariable.variables, structuredClone(duplicateVariable.variables[0])]
    expect(() => validateCanvasTemplate(duplicateVariable)).toThrow(/变量 ID 重复/)
  })
})
