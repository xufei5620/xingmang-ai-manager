import { describe, expect, it } from 'vitest'
import {
  parseCanvasAssetQuery,
  parseCanvasAssetId,
  parseCanvasImageEditInput,
  parseCanvasImageGenerateInput,
  parseCanvasPromptPresetId,
  parseCanvasPromptPresetInput,
  parseCanvasPromptPresetUpdate,
  parseCanvasRenameAssetInput,
  parseCanvasUpdateAssetMetadataInput,
  parseCanvasStartRunInput,
  parseCanvasVideoGenerateInput,
  parseCanvasVideoTaskId,
  requiredCanvasString,
  requiredCanvasText,
} from './canvas-request-parser'

describe('canvas request parser', () => {
  it('accepts bounded multiline document text while rejecting unsafe controls and oversized UTF-8', () => {
    const document = '{\r\n\t"name": "测试"\r\n}'
    expect(requiredCanvasText(document, '画布项目内容', 128)).toBe(document)
    expect(() => requiredCanvasText('line\u0000break', '画布项目内容', 128)).toThrow('画布项目内容格式错误')
    expect(() => requiredCanvasText('line\u000bbreak', '画布项目内容', 128)).toThrow('画布项目内容格式错误')
    expect(() => requiredCanvasText('测试', '画布项目内容', 5)).toThrow('画布项目内容格式错误')
  })

  it('accepts bounded asset paging, filtering and search', () => {
    expect(parseCanvasAssetQuery({ offset: 24, limit: 24, mediaType: 'image', search: ' 产品图 ' })).toEqual({
      offset: 24, limit: 24, mediaType: 'image', search: '产品图',
    })
    expect(parseCanvasAssetQuery(undefined)).toEqual({})
  })

  it('rejects hostile or unbounded asset queries', () => {
    expect(() => parseCanvasAssetQuery({ offset: -1 })).toThrow('分页位置')
    expect(() => parseCanvasAssetQuery({ limit: 101 })).toThrow('分页数量')
    expect(parseCanvasAssetQuery({ mediaType: 'video' })).toMatchObject({ mediaType: 'video' })
    expect(() => parseCanvasAssetQuery({ search: 'bad\0query' })).toThrow('搜索内容')
    expect(() => parseCanvasAssetQuery({ apiKey: 'secret' })).toThrow('未知字段')
  })

  it('parses asset organization filters and bounded metadata mutations', () => {
    const assetId = 'a'.repeat(43)
    expect(parseCanvasAssetQuery({
      view: 'favorites', tag: ' 角色 ', source: 'generated', sort: 'name-asc',
    })).toEqual({
      offset: 0, limit: 24, mediaType: 'all', view: 'favorites', tag: '角色', source: 'generated', sort: 'name-asc',
    })
    expect(parseCanvasUpdateAssetMetadataInput({ assetId, favorite: false, tags: [' 角色 ', '主视觉'] })).toEqual({
      assetId, favorite: false, tags: ['角色', '主视觉'],
    })
    expect(parseCanvasAssetId(assetId)).toBe(assetId)
    // The recycle bin is a view like the others; rejecting it here would make
    // the bin unreachable through the real bridge.
    expect(parseCanvasAssetQuery({ view: 'trash' })).toMatchObject({ view: 'trash' })
    // Deep paging must reach the whole indexed library, not the first twenty pages.
    expect(parseCanvasAssetQuery({ offset: 20_000 })).toMatchObject({ offset: 20_000 })
    expect(() => parseCanvasAssetQuery({ offset: 20_001 })).toThrow('分页位置')
    expect(parseCanvasAssetQuery({ prompt: ' 一只橘猫 ', runId: 'run-1', nodeId: 'node-7' })).toMatchObject({
      prompt: '一只橘猫', runId: 'run-1', nodeId: 'node-7',
    })
    expect(() => parseCanvasAssetQuery({ prompt: 'bad\0prompt' })).toThrow('提示词筛选')
    expect(() => parseCanvasAssetQuery({ prompt: 'x'.repeat(2_001) })).toThrow('提示词筛选')
    expect(() => parseCanvasAssetQuery({ runId: 'bad\0run' })).toThrow('运行标识')
    expect(() => parseCanvasAssetQuery({ nodeId: '' })).toThrow('节点标识')
    expect(() => parseCanvasAssetQuery({ view: 'secret' })).toThrow('快速视图')
    expect(() => parseCanvasAssetQuery({ source: 'remote' })).toThrow('来源筛选')
    expect(() => parseCanvasAssetQuery({ sort: 'random' })).toThrow('排序')
    expect(() => parseCanvasUpdateAssetMetadataInput({ assetId })).toThrow('不能为空')
    expect(() => parseCanvasUpdateAssetMetadataInput({ assetId, tags: ['角色', '角色'] })).toThrow('不能重复')
    expect(() => parseCanvasUpdateAssetMetadataInput({ assetId, favorite: true, apiKey: 'secret' })).toThrow('未知字段')
  })

  it('accepts safe logical asset names and rejects path-like rename payloads', () => {
    const assetId = 'a'.repeat(43)
    expect(parseCanvasRenameAssetInput({ assetId, displayName: ' 产品主视觉 ' })).toEqual({
      assetId,
      displayName: '产品主视觉',
    })
    expect(parseCanvasRenameAssetInput({ assetId, displayName: 'x'.repeat(120) }).displayName).toHaveLength(120)
    for (const displayName of ['', 'x'.repeat(121), 'bad\0name', 'folder/name', 'folder\\name']) {
      expect(() => parseCanvasRenameAssetInput({ assetId, displayName })).toThrow('显示名称格式错误')
    }
    expect(() => parseCanvasRenameAssetInput({ assetId: '../secret', displayName: '名称' })).toThrow('资产标识格式错误')
    expect(() => parseCanvasRenameAssetInput({ assetId, displayName: '名称', apiKey: 'secret' })).toThrow('未知字段')
  })

  it('accepts a bounded image request', () => {
    expect(parseCanvasImageGenerateInput({
      requestId: 'run-1',
      group: '生图分组',
      model: 'gpt-image-2',
      prompt: '生成一张产品图',
      size: '1024x1024',
      quality: 'high',
      imageResolution: '4K',
    })).toEqual({
      requestId: 'run-1',
      group: '生图分组',
      model: 'gpt-image-2',
      prompt: '生成一张产品图',
      size: '1024x1024',
      quality: 'high',
      imageResolution: '4K',
    })
  })

  it('rejects unknown fields and hostile strings', () => {
    expect(() => parseCanvasImageGenerateInput({
      requestId: 'run-1', group: 'g', model: 'm', prompt: 'p', apiKey: 'secret',
    })).toThrow('未知字段')
    expect(() => requiredCanvasString('bad\0value', '值', 20)).toThrow('值格式错误')
  })

  it('accepts multi-line prompts on every paid path but still rejects control characters', () => {
    // The node prompt editor is a multi-line box and presets are stored with
    // line breaks, yet every prompt used to go through the identifier-grade
    // check that treats \n as a control character, so no structured prompt
    // could ever be run.
    const prompt = '生成角色的多视图；上下板块展示。\n上方板块：正面、半侧面、背面。\n\t缩进也是普通内容。'

    expect(parseCanvasImageGenerateInput({
      requestId: 'run-1', group: 'g', model: 'm', prompt,
    }).prompt).toBe(prompt)

    expect(parseCanvasVideoGenerateInput({
      requestId: 'run-1', group: 'g', model: 'm', prompt, seconds: '5',
    }).prompt).toBe(prompt)

    const graph = { nodes: [{ id: 'image', kind: 'image', definitionVersion: 1, data: { prompt, model: 'm' } }], edges: [] }
    expect(parseCanvasStartRunInput({ graph, scope: { kind: 'all' } }).graph.nodes[0].data.prompt).toBe(prompt)

    for (const hostile of ['bad\0value', 'bad\x07value', 'bad\x1Bvalue']) {
      expect(() => parseCanvasImageGenerateInput({
        requestId: 'run-1', group: 'g', model: 'm', prompt: hostile,
      })).toThrow('提示词格式错误')
      expect(() => parseCanvasStartRunInput({
        graph: { nodes: [{ id: 'image', kind: 'image', definitionVersion: 1, data: { prompt: hostile, model: 'm' } }], edges: [] },
        scope: { kind: 'all' },
      })).toThrow('提示词格式错误')
    }

    // Identifiers must keep the stricter rule.
    expect(() => parseCanvasImageGenerateInput({
      requestId: 'run-1', group: 'g', model: 'model\nwith-break', prompt: '正常提示词',
    })).toThrow('模型格式错误')
  })

  it('rejects unsupported quality values', () => {
    expect(() => parseCanvasImageGenerateInput({
      requestId: 'run-1', group: 'g', model: 'm', prompt: 'p', quality: 'ultra',
    })).toThrow('画质格式错误')
  })

  it('rejects unsupported image clarity values at both canvas boundaries', () => {
    expect(() => parseCanvasImageGenerateInput({
      requestId: 'run-1', group: 'g', model: 'm', prompt: 'p', imageResolution: '8K',
    })).toThrow('清晰度格式错误')
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: [{ id: 'image', kind: 'image', definitionVersion: 1, data: { prompt: 'p', model: 'm', imageResolution: '8K' } }], edges: [] },
      scope: { kind: 'all' },
    })).toThrow('清晰度不受支持')
  })

  it('accepts exact bounded video requests and rejects credentials or duration ambiguity', () => {
    expect(parseCanvasVideoGenerateInput({
      requestId: 'video-1', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '15',
      imageAssetId: 'a'.repeat(43), width: 720, height: 1280,
    })).toEqual({
      requestId: 'video-1', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '15',
      imageAssetId: 'a'.repeat(43), width: 720, height: 1280,
    })
    expect(() => parseCanvasVideoGenerateInput({
      requestId: 'video-1', group: 'g', model: 'm', prompt: 'p', seconds: '16',
    })).toThrow('1-15 秒')
    expect(() => parseCanvasVideoGenerateInput({
      requestId: 'video-1', group: 'g', model: 'm', prompt: 'p', seconds: '5', apiKey: 'secret',
    })).toThrow('未知字段')
    expect(() => parseCanvasVideoGenerateInput({
      requestId: 'video-1', group: 'g', model: 'm', prompt: 'p', seconds: '5', width: 1280,
    })).toThrow('比例不受支持')
    const minimax = {
      requestId: 'minimax-1', group: 'video', model: 'minimax-h3-base', prompt: '多参考视频', seconds: '10',
      mode: 'ref2va', resolution: '720p', aspectRatio: '21:9', promptOptimization: true,
      imageAssetIds: ['a'.repeat(43), 'b'.repeat(43)],
      videoAssetIds: ['v'.repeat(43)],
      audioAssetIds: ['m'.repeat(43)],
    }
    expect(parseCanvasVideoGenerateInput(minimax)).toEqual(minimax)
    expect(() => parseCanvasVideoGenerateInput({ ...minimax, imageAssetIds: Array(10).fill('a'.repeat(43)) }))
      .toThrow('数量格式错误')
    expect(() => parseCanvasVideoGenerateInput({ ...minimax, mode: 'unknown' }))
      .toThrow('生成模式不受支持')
  })

  it('accepts only a bounded opaque video task id', () => {
    expect(parseCanvasVideoTaskId('video_task.123:queued')).toBe('video_task.123:queued')
    for (const input of ['', '../video-task', 'video task', 'x'.repeat(257), { taskId: 'video-task' }]) {
      expect(() => parseCanvasVideoTaskId(input)).toThrow('视频任务标识格式错误')
    }
  })

  it('accepts one to four distinct local asset ids for image editing', () => {
    const ids = ['a'.repeat(43), 'b'.repeat(43)]
    expect(parseCanvasImageEditInput({
      requestId: 'edit-1', group: '生图分组', model: 'gpt-image-2', prompt: '改成夜景',
      sourceAssetIds: ids,
    })).toEqual({
      requestId: 'edit-1', group: '生图分组', model: 'gpt-image-2', prompt: '改成夜景',
      sourceAssetIds: ids,
    })
  })

  it('rejects unsafe image-edit asset lists and unknown fields', () => {
    const id = 'a'.repeat(43)
    const base = { requestId: 'edit-1', group: 'g', model: 'm', prompt: 'p' }
    expect(() => parseCanvasImageEditInput({ ...base, sourceAssetIds: [] })).toThrow('参考图数量')
    expect(() => parseCanvasImageEditInput({ ...base, sourceAssetIds: Array(5).fill(id) })).toThrow('参考图数量')
    expect(() => parseCanvasImageEditInput({ ...base, sourceAssetIds: [id, id] })).toThrow('不能重复')
    expect(() => parseCanvasImageEditInput({ ...base, sourceAssetIds: ['../secret'] })).toThrow('资产标识格式错误')
    expect(() => parseCanvasImageEditInput({ ...base, sourceAssetIds: [id], apiKey: 'secret' })).toThrow('未知字段')
  })

  it('parses exact prompt preset create and update payloads', () => {
    expect(parseCanvasPromptPresetInput({ name: ' 商品图 ', prompt: ' 棚拍 ', tags: ['商品'] })).toEqual({ name: '商品图', prompt: '棚拍', tags: ['商品'] })
    expect(parseCanvasPromptPresetUpdate({ id: 'preset-id-0000000000000001', tags: [] })).toEqual({ id: 'preset-id-0000000000000001', tags: [] })
    expect(parseCanvasPromptPresetId('preset-id-0000000000000001')).toBe('preset-id-0000000000000001')
  })

  it('rejects hostile or ambiguous prompt preset payloads', () => {
    expect(() => parseCanvasPromptPresetInput({ name: 'x', prompt: '<img onerror=alert(1)>', apiKey: 'secret' })).toThrow('未知字段')
    expect(() => parseCanvasPromptPresetInput({ name: 'bad\0', prompt: 'p' })).toThrow('名称格式')
    expect(() => parseCanvasPromptPresetInput({ name: 'x', prompt: 'p', tags: ['a', 'a'] })).toThrow('不能重复')
    expect(() => parseCanvasPromptPresetUpdate({ id: 'preset-id-0000000000000001' })).toThrow('更新内容为空')
    expect(() => parseCanvasPromptPresetId('../secret')).toThrow('标识格式')
  })

  it('parses bounded scoped workflow runs without accepting unknown node kinds', () => {
    const input = {
      graph: {
        nodes: [{ id: 'prompt', kind: 'prompt', definitionVersion: 1, data: { prompt: '产品图', model: '' } }],
        edges: [],
      },
      scope: { kind: 'selection', nodeIds: ['prompt'] },
    }
    expect(parseCanvasStartRunInput(input)).toEqual(input)
    expect(() => parseCanvasStartRunInput({
      ...input,
      graph: { nodes: [{ ...input.graph.nodes[0], kind: 'future-executor' }], edges: [] },
    })).toThrow('类型不受支持')
  })

  it('accepts audio input nodes in a workflow run', () => {
    const input = {
      graph: {
        nodes: [{ id: 'audio', kind: 'audio-input', definitionVersion: 1, data: { prompt: '', model: '' } }],
        edges: [],
      },
      scope: { kind: 'all' },
    }
    expect(parseCanvasStartRunInput(input)).toEqual(input)
  })

  it('accepts video seconds only as a bounded integer string', () => {
    const input = {
      graph: { nodes: [{ id: 'video', kind: 'video-generate', definitionVersion: 1, data: {
        prompt: '海浪', model: 'grok-imagine-video', seconds: '15',
      } }], edges: [] }, scope: { kind: 'all' },
    }
    expect(parseCanvasStartRunInput(input)).toEqual(input)
    for (const seconds of ['0', '16', '5.5', '05']) {
      expect(() => parseCanvasStartRunInput({
        ...input, graph: { ...input.graph, nodes: [{ ...input.graph.nodes[0], data: { ...input.graph.nodes[0].data, seconds } }] },
      })).toThrow('1-15 秒')
    }
  })

  it('accepts only bounded MiniMax settings in a workflow run', () => {
    const input = {
      graph: { nodes: [{ id: 'video', kind: 'video-generate', definitionVersion: 1, data: {
        prompt: '多参考', model: 'minimax-h3-base', seconds: '10', videoMode: 'ref2va',
        videoResolution: '720p', videoAspectRatio: '9:16', promptOptimization: true,
      } }], edges: [] }, scope: { kind: 'all' },
    }
    expect(parseCanvasStartRunInput(input)).toEqual(input)
    expect(() => parseCanvasStartRunInput({
      ...input,
      graph: { ...input.graph, nodes: [{ ...input.graph.nodes[0], data: { ...input.graph.nodes[0].data, videoResolution: '1080p' } }] },
    })).toThrow('分辨率不受支持')
  })

  it('rejects empty and oversized run scopes', () => {
    const graph = { nodes: [{ id: 'a', kind: 'prompt', definitionVersion: 1, data: { prompt: '', model: '' } }], edges: [] }
    expect(() => parseCanvasStartRunInput({ graph, scope: { kind: 'dirty', nodeIds: [] } })).toThrow('节点范围')
    expect(() => parseCanvasStartRunInput({ graph, scope: { kind: 'unknown' } })).toThrow('运行范围')
  })

  it('parses a downstream run scope without accepting extra fields', () => {
    const graph = { nodes: [{ id: 'start', kind: 'prompt', definitionVersion: 1, data: { prompt: '', model: '' } }], edges: [] }
    expect(parseCanvasStartRunInput({ graph, scope: { kind: 'from-node', nodeId: 'start' } }))
      .toEqual({ graph, scope: { kind: 'from-node', nodeId: 'start' } })
    expect(() => parseCanvasStartRunInput({ graph, scope: { kind: 'from-node', nodeId: 'start', nodeIds: ['start'] } }))
      .toThrow('运行范围包含未知字段')
  })

  it('rejects unknown fields at every run request boundary', () => {
    const input = {
      graph: {
        nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'p', model: 'm' } }],
        edges: [],
      },
      scope: { kind: 'all' },
    }
    expect(() => parseCanvasStartRunInput({ ...input, apiKey: 'secret' })).toThrow('运行请求包含未知字段')
    expect(() => parseCanvasStartRunInput({ ...input, graph: { ...input.graph, token: 'secret' } }))
      .toThrow('运行图包含未知字段')
    expect(() => parseCanvasStartRunInput({
      ...input,
      graph: { ...input.graph, nodes: [{ ...input.graph.nodes[0], remoteUrl: 'https://evil.test' }] },
    })).toThrow('运行节点包含未知字段')
    expect(() => parseCanvasStartRunInput({
      ...input,
      graph: {
        ...input.graph,
        nodes: [{ ...input.graph.nodes[0], data: { ...input.graph.nodes[0].data, accessToken: 'secret' } }],
      },
    })).toThrow('节点数据包含未知字段')
    expect(() => parseCanvasStartRunInput({ ...input, scope: { kind: 'all', nodeIds: ['image'] } }))
      .toThrow('运行范围包含未知字段')
  })

  it('rejects hostile strings and malformed asset identifiers', () => {
    const node = { id: 'image', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '' } }
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: [{ ...node, id: 'bad\0id' }], edges: [] }, scope: { kind: 'all' },
    })).toThrow('节点标识格式错误')
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: [{ ...node, data: { ...node.data, adoptedAssetId: '../secret' } }], edges: [] },
      scope: { kind: 'all' },
    })).toThrow('资产标识格式错误')
  })

  it('rejects oversized graph and scope arrays before element parsing', () => {
    const node = { id: 'a', kind: 'prompt', definitionVersion: 1, data: { prompt: '', model: '' } }
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: Array.from({ length: 5_001 }, () => node), edges: [] }, scope: { kind: 'all' },
    })).toThrow('安全上限')
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: [], edges: Array.from({ length: 20_001 }, () => ({})) }, scope: { kind: 'all' },
    })).toThrow('安全上限')
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: [node], edges: [] },
      scope: { kind: 'dirty', nodeIds: Array.from({ length: 5_001 }, () => 'a') },
    })).toThrow('节点范围')
  })
})
