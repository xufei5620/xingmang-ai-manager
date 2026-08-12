import { describe, expect, it } from 'vitest'
import {
  parseCanvasAssetQuery,
  parseCanvasImageEditInput,
  parseCanvasImageGenerateInput,
  parseCanvasPromptPresetId,
  parseCanvasPromptPresetInput,
  parseCanvasPromptPresetUpdate,
  parseCanvasStartRunInput,
  requiredCanvasString,
} from './canvas-request-parser'

describe('canvas request parser', () => {
  it('accepts bounded asset paging, filtering and search', () => {
    expect(parseCanvasAssetQuery({ offset: 24, limit: 24, mediaType: 'image', search: ' 产品图 ' })).toEqual({
      offset: 24, limit: 24, mediaType: 'image', search: '产品图',
    })
    expect(parseCanvasAssetQuery(undefined)).toEqual({})
  })

  it('rejects hostile or unbounded asset queries', () => {
    expect(() => parseCanvasAssetQuery({ offset: -1 })).toThrow('分页位置')
    expect(() => parseCanvasAssetQuery({ limit: 101 })).toThrow('分页数量')
    expect(() => parseCanvasAssetQuery({ mediaType: 'video' })).toThrow('媒体类型')
    expect(() => parseCanvasAssetQuery({ search: 'bad\0query' })).toThrow('搜索内容')
    expect(() => parseCanvasAssetQuery({ apiKey: 'secret' })).toThrow('未知字段')
  })

  it('accepts a bounded image request', () => {
    expect(parseCanvasImageGenerateInput({
      requestId: 'run-1',
      group: '生图分组',
      model: 'gpt-image-2',
      prompt: '生成一张产品图',
      size: '1024x1024',
      quality: 'high',
    })).toEqual({
      requestId: 'run-1',
      group: '生图分组',
      model: 'gpt-image-2',
      prompt: '生成一张产品图',
      size: '1024x1024',
      quality: 'high',
    })
  })

  it('rejects unknown fields and hostile strings', () => {
    expect(() => parseCanvasImageGenerateInput({
      requestId: 'run-1', group: 'g', model: 'm', prompt: 'p', apiKey: 'secret',
    })).toThrow('未知字段')
    expect(() => requiredCanvasString('bad\0value', '值', 20)).toThrow('值格式错误')
  })

  it('rejects unsupported quality values', () => {
    expect(() => parseCanvasImageGenerateInput({
      requestId: 'run-1', group: 'g', model: 'm', prompt: 'p', quality: 'ultra',
    })).toThrow('画质格式错误')
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

  it('rejects empty and oversized run scopes', () => {
    const graph = { nodes: [{ id: 'a', kind: 'prompt', definitionVersion: 1, data: { prompt: '', model: '' } }], edges: [] }
    expect(() => parseCanvasStartRunInput({ graph, scope: { kind: 'dirty', nodeIds: [] } })).toThrow('节点范围')
    expect(() => parseCanvasStartRunInput({ graph, scope: { kind: 'unknown' } })).toThrow('运行范围')
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
