import { describe, expect, it } from 'vitest'
import {
  parseCanvasAssetQuery,
  parseCanvasAssetId,
  parseCanvasCreateProjectContent,
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
  parseImageGenerateInput,
  canvasNotificationText,
  canvasSaveFileName,
  requiredCanvasString,
  requiredCanvasText,
} from './canvas-request-parser'
import { canvasRunKernelOnlyNodeLabels } from './canvas-run-contract'

const kernelRefusal = '桌面版暂不支持，本次没有提交任何付费请求'

function kernelNode(kind: string, extra: Record<string, unknown>) {
  return structuredClone({
    graph: { nodes: [{ id: 'node', kind, definitionVersion: 1, data: { prompt: 'p', model: 'm', ...extra } }], edges: [] },
    scope: { kind: 'all' },
  })
}

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

  it('holds canvas image requests to the stricter chat-page bounds', () => {
    const base = { requestId: 'run-1', group: 'g', prompt: 'p' }
    expect(parseCanvasImageGenerateInput({ ...base, model: 'm'.repeat(128), size: 's'.repeat(32) }))
      .toEqual({ ...base, model: 'm'.repeat(128), size: 's'.repeat(32) })
    expect(() => parseCanvasImageGenerateInput({ ...base, model: 'm'.repeat(129) })).toThrow('画布生图模型格式错误')
    expect(() => parseCanvasImageGenerateInput({ ...base, model: 'm', size: 's'.repeat(33) })).toThrow('画布生图尺寸格式错误')
  })

  it('applies one image standard to the chat page and the canvas, each with its own wording', () => {
    const chat = { prefix: '生图', unknownFields: '生图请求格式错误' }
    const base = { requestId: 'run-1', group: 'g', model: 'm', prompt: 'p' }
    const hostile: Array<[Record<string, unknown>, string]> = [
      [{ ...base, apiKey: 'secret' }, '请求'],
      [{ ...base, requestId: 'run\t1' }, '请求标识格式错误'],
      [{ ...base, group: 'g'.repeat(129) }, '分组格式错误'],
      [{ ...base, model: 'm\x7F' }, '模型格式错误'],
      [{ ...base, prompt: 'bad\x0Cvalue' }, '提示词格式错误'],
      [{ ...base, size: '1024x1024\n' }, '尺寸格式错误'],
      [{ ...base, quality: ['high'] }, '画质格式错误'],
      [{ ...base, imageResolution: { toString: () => '4K' } }, '清晰度格式错误'],
    ]
    for (const [input, suffix] of hostile) {
      expect(() => parseImageGenerateInput(input, chat)).toThrow(suffix)
      expect(() => parseCanvasImageGenerateInput(input)).toThrow(suffix)
    }
    expect(() => parseImageGenerateInput({ ...base, apiKey: 'secret' }, chat)).toThrow(/^生图请求格式错误$/)
    expect(() => parseImageGenerateInput([], chat)).toThrow(/^生图请求格式错误$/)
    expect(() => parseImageGenerateInput({ ...base, model: '' }, chat)).toThrow(/^生图模型格式错误$/)

    const accepted = { ...base, prompt: '多行\n\t提示词', size: '1024x1024', quality: 'auto', imageResolution: '2K' }
    expect(parseImageGenerateInput(accepted, chat)).toEqual(accepted)
    expect(parseCanvasImageGenerateInput(accepted)).toEqual(accepted)
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

  it('caps the total prompt text one run may hand the main process', () => {
    // 210 prompts at the 100 000-character per-node limit, each 3 UTF-8 bytes
    // per character, is about 63 MB: every node passes on its own, but the
    // request as a whole must not.
    const largePrompt = '画'.repeat(100_000)
    const node = (index: number) => ({ id: `n-${index}`, kind: 'prompt', definitionVersion: 1, data: { prompt: largePrompt, model: '' } })
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: Array.from({ length: 210 }, (_, index) => node(index)), edges: [] }, scope: { kind: 'all' },
    })).toThrow('工作流规模超过安全上限')
    // A workflow the canvas can still save (20 MB) keeps running as before.
    const accepted = parseCanvasStartRunInput({
      graph: { nodes: Array.from({ length: 60 }, (_, index) => node(index)), edges: [] }, scope: { kind: 'all' },
    })
    expect(accepted.graph.nodes).toHaveLength(60)
  })

  it('parses a kernel run graph after an IPC clone keeps its undefined keys', () => {
    // Structured clone, unlike a JSON round trip, keeps a key whose value is
    // undefined, and the kernel's toCanvasRunGraph writes every optional key
    // that way. A parser that treated "present" as "set" would refuse them all.
    const unset = {
      quality: undefined, size: undefined, imageResolution: undefined, imageCandidateCount: undefined,
      videoCandidateCount: undefined, seconds: undefined, adoptedAssetId: undefined, videoMode: undefined,
      videoResolution: undefined, videoAspectRatio: undefined, promptOptimization: undefined,
    }
    const input = structuredClone({
      graph: {
        nodes: [
          { id: 'prompt', kind: 'prompt', definitionVersion: 1, data: { prompt: '一只猫', model: '', ...unset } },
          { id: 'image', kind: 'image-generate', definitionVersion: 1, data: {
            prompt: '', model: 'gpt-image-2', group: '图片模型', imageCandidateCount: 1, textWebSearch: false,
          } },
          { id: 'video', kind: 'video-generate', definitionVersion: 1, data: {
            prompt: '', model: 'grok-imagine-video', seconds: '5', videoCandidateCount: 1,
            videoProtocol: 'relay-videos', videoReferenceOrder: { version: 1, slots: [] },
          } },
        ],
        edges: [],
      },
      scope: { kind: 'all' },
      agentExecution: undefined,
    })
    expect(Object.keys(input.graph.nodes[0].data)).toContain('imageCandidateCount')
    expect(Object.keys(input)).toContain('agentExecution')

    const parsed = parseCanvasStartRunInput(input)
    expect(parsed.graph.nodes.some((node) => 'desktopUnsupported' in node)).toBe(false)
    // Only what an executor already reads is handed on.
    expect(parsed.graph.nodes.map((node) => node.data)).toEqual([
      { prompt: '一只猫', model: '' },
      { prompt: '', model: 'gpt-image-2', group: '图片模型' },
      { prompt: '', model: 'grok-imagine-video', seconds: '5' },
    ])
    expect(parsed).toEqual({ graph: { nodes: parsed.graph.nodes, edges: [] }, scope: { kind: 'all' } })
  })

  it('marks each kernel setting the desktop cannot honour instead of dropping it', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['image-generate', { imageCandidateCount: 2 }, '一次出多张图'],
      ['video-generate', { videoCandidateCount: 4 }, '一次出多个视频'],
      ['image-generate', { textWebSearch: true }, '联网搜索'],
      // false asks for a silent video; the desktop sends neither, so only
      // undefined leaves the request as it is.
      ['video-generate', { generateAudio: true }, '生成音频设置'],
      ['video-generate', { generateAudio: false }, '生成音频设置'],
      ['router', { routerStrategy: { version: 1, strategy: 'first-available' } }, '路由策略'],
      ['router', { routerStrategy: { version: 1, strategy: 'all' } }, '路由策略'],
      ['video-generate', { videoProtocol: 'xai-native' }, '这个视频接口'],
      ['video-generate', { videoProtocol: 'ark-seedance' }, '这个视频接口'],
      ['video-generate', { videoReferenceOrder: { version: 1, slots: [{ kind: 'image', sourceNodeId: 'a' }] } }, '视频参考顺序'],
      ['image-edit', { imageReferenceOrder: { version: 1, slots: [] } }, '参考图角色'],
      ['image-generate', { imageOutputIndex: 0 }, '图片处理'],
      ['frame-extract', { frameTimestampSeconds: 1.5 }, '视频抽帧'],
      ['image-edit', { imageEditMask: { version: 1, strokes: [] } }, '蒙版局部修改'],
      ['image-generate', { commerceTask: { version: 1 } }, '电商创作'],
      ['image-generate', { interiorTask: { version: 1 } }, '室内创作'],
      ['image-generate', { exteriorTask: { version: 1 } }, '室外创作'],
      ['image-generate', { storyboardTask: { version: 1 } }, '故事板'],
      ['image-generate', { imageTransform: { kind: 'crop' } }, '图片处理'],
      ['image-generate', { imageCollageInputOrder: ['a', 'b'] }, '图片处理'],
      ['image-generate', { tileInput: { columns: 2 } }, '图片处理'],
    ]
    for (const [kind, extra, reason] of cases) {
      const node = parseCanvasStartRunInput(kernelNode(kind, extra)).graph.nodes[0]
      expect(node.desktopUnsupported, JSON.stringify(extra)).toBe(`「${reason}」${kernelRefusal}`)
      expect(node.data).toEqual({ prompt: 'p', model: 'm' })
    }
    // Several reasons are each named once, in a fixed order.
    expect(parseCanvasStartRunInput(kernelNode('image-generate', {
      tileInput: { columns: 2 }, imageTransform: { kind: 'crop' }, imageCandidateCount: 3,
    })).graph.nodes[0].desktopUnsupported).toBe(`「一次出多张图、图片处理」${kernelRefusal}`)
  })

  it('marks every kernel-only node kind by its name and still refuses unknown kinds', () => {
    for (const [kind, label] of Object.entries(canvasRunKernelOnlyNodeLabels)) {
      const node = parseCanvasStartRunInput(kernelNode(kind, {})).graph.nodes[0]
      expect(node.kind).toBe(kind)
      expect(node.desktopUnsupported).toBe(`「${label}」节点${kernelRefusal}`)
    }
    expect(parseCanvasStartRunInput(kernelNode('text-generate', { textWebSearch: true })).graph.nodes[0].desktopUnsupported)
      .toBe(`「文字生成」节点${kernelRefusal}`)
    for (const kind of ['image-upscale', 'constructor', '__proto__', 'toString']) {
      expect(() => parseCanvasStartRunInput(kernelNode(kind, {}))).toThrow('类型不受支持')
    }
  })

  it('rejects malformed kernel settings rather than marking them', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let level = 0; level < 10; level += 1) {
      const next: Record<string, unknown> = {}
      cursor.child = next
      cursor = next
    }
    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ imageCandidateCount: 5 }, '画布图片生成数量格式错误'],
      [{ imageCandidateCount: '2' }, '画布图片生成数量格式错误'],
      [{ imageCandidateCount: 1.5 }, '画布图片生成数量格式错误'],
      [{ videoCandidateCount: 0 }, '画布视频生成数量格式错误'],
      [{ textWebSearch: 'yes' }, '画布联网搜索开关格式错误'],
      [{ generateAudio: 1 }, '画布生成音频设置格式错误'],
      [{ routerStrategy: { version: 1, strategy: 'random' } }, '画布路由策略格式错误'],
      [{ routerStrategy: { version: 2, strategy: 'all' } }, '画布路由策略格式错误'],
      [{ routerStrategy: { version: 1, strategy: 'all', apiKey: 'secret' } }, '画布路由策略包含未知字段'],
      [{ videoProtocol: 'https://evil.test/v1/videos' }, '画布视频接口格式错误'],
      [{ videoReferenceOrder: { version: 2, slots: [] } }, '画布视频参考顺序格式错误'],
      [{ videoReferenceOrder: { version: 1, slots: Array.from({ length: 13 }, () => ({})) } }, '画布视频参考顺序格式错误'],
      [{ videoReferenceOrder: { version: 1, slots: [], url: 'https://evil.test' } }, '画布视频参考顺序包含未知字段'],
      [{ imageReferenceOrder: { version: 1, slots: Array.from({ length: 5 }, () => ({})) } }, '画布参考图角色格式错误'],
      [{ imageReferenceOrder: { version: 1, slots: ['image'] } }, '画布参考图角色格式错误'],
      [{ imageOutputIndex: -1 }, '画布图片输出序号格式错误'],
      [{ frameTimestampSeconds: Number.NaN }, '画布抽帧时间格式错误'],
      [{ frameTimestampSeconds: 86_401 }, '画布抽帧时间格式错误'],
      [{ imageEditMask: 'mask' }, '画布蒙版格式错误'],
      [{ imageEditMask: { strokes: [{ accessToken: 'secret' }] } }, '画布蒙版格式错误'],
      [{ commerceTask: { prompt: 'bad\0value' } }, '画布电商创作配置格式错误'],
      [{ commerceTask: { prompt: 'x'.repeat(10_001) } }, '画布电商创作配置格式错误'],
      [{ storyboardTask: deep }, '画布故事板配置格式错误'],
      [{ tileInput: { values: Array.from({ length: 4_097 }, () => 0) } }, '画布平铺输入格式错误'],
      [{ imageTransform: { scale: Number.POSITIVE_INFINITY } }, '画布图片处理配置格式错误'],
    ]
    for (const [extra, message] of malformed) {
      expect(() => parseCanvasStartRunInput(kernelNode('image-generate', extra)), JSON.stringify(extra)).toThrow(message)
    }
  })

  it('bounds the kernel settings one run may carry as a whole', () => {
    // Each node is within every per-value limit; together they are not.
    const chunk = Array.from({ length: 256 }, () => 'x'.repeat(10_000))
    const node = (index: number) => ({
      id: `n-${index}`, kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'm', commerceTask: { chunk } },
    })
    expect(parseCanvasStartRunInput({ graph: { nodes: [node(0)], edges: [] }, scope: { kind: 'all' } }).graph.nodes[0].desktopUnsupported)
      .toBe(`「电商创作」${kernelRefusal}`)
    expect(() => parseCanvasStartRunInput({
      graph: { nodes: Array.from({ length: 9 }, (_, index) => node(index)), edges: [] }, scope: { kind: 'all' },
    })).toThrow('工作流规模超过安全上限')
  })

  it('refuses a run the kernel agent panel starts and accepts the key left unset', () => {
    const input = {
      graph: { nodes: [{ id: 'prompt', kind: 'prompt', definitionVersion: 1, data: { prompt: '一只猫', model: '' } }], edges: [] },
      scope: { kind: 'all' },
    }
    for (const agentExecution of [{ conversationId: 'c-1' }, null, false, 'run']) {
      expect(() => parseCanvasStartRunInput({ ...input, agentExecution })).toThrow('桌面版不支持由 Agent 发起运行')
    }
    expect(parseCanvasStartRunInput(structuredClone({ ...input, agentExecution: undefined }))).toEqual(input)
  })

  it('accepts prompt preset names up to the kernel limit of 160 characters', () => {
    const id = 'preset-id-0000000000000001'
    expect(parseCanvasPromptPresetInput({ name: '名'.repeat(160), prompt: 'p' }).name).toHaveLength(160)
    expect(parseCanvasPromptPresetUpdate({ id, name: '名'.repeat(160) }).name).toHaveLength(160)
    expect(() => parseCanvasPromptPresetInput({ name: '名'.repeat(161), prompt: 'p' })).toThrow('画布提示词名称格式错误')
    expect(() => parseCanvasPromptPresetUpdate({ id, name: '名'.repeat(161) })).toThrow('画布提示词名称格式错误')
  })

  it('parses the content and source a saved copy adds to createProject', () => {
    const sourceProjectId = '0f4b2c1e-8a7d-4c3b-9e21-5d6f7a8b9c0d'
    expect(parseCanvasCreateProjectContent(undefined, undefined)).toBeUndefined()
    expect(parseCanvasCreateProjectContent('{"schemaVersion":2}', undefined)).toEqual({ workflowContent: '{"schemaVersion":2}' })
    expect(parseCanvasCreateProjectContent('{}', {})).toEqual({ workflowContent: '{}' })
    expect(parseCanvasCreateProjectContent('{}', { sourceProjectId: undefined })).toEqual({ workflowContent: '{}' })
    expect(parseCanvasCreateProjectContent('{}', { sourceProjectId })).toEqual({ workflowContent: '{}', sourceProjectId })

    expect(() => parseCanvasCreateProjectContent(undefined, { sourceProjectId })).toThrow('画布项目内容格式错误')
    expect(() => parseCanvasCreateProjectContent('', undefined)).toThrow('画布项目内容格式错误')
    expect(() => parseCanvasCreateProjectContent(42, undefined)).toThrow('画布项目内容格式错误')
    expect(() => parseCanvasCreateProjectContent('{}\u0000', undefined)).toThrow('画布项目内容格式错误')
    expect(() => parseCanvasCreateProjectContent('x'.repeat(20 * 1024 * 1024 + 1), undefined)).toThrow('画布项目内容格式错误')
    expect(() => parseCanvasCreateProjectContent('{}', 'options')).toThrow('画布项目复制选项格式错误')
    expect(() => parseCanvasCreateProjectContent('{}', { sourceProjectId, workspacePath: 'C:\\Users' })).toThrow('画布项目复制选项包含未知字段')
    for (const id of ['../other-project', 'user-1/project', sourceProjectId.toUpperCase(), `${sourceProjectId}0`]) {
      expect(() => parseCanvasCreateProjectContent('{}', { sourceProjectId: id })).toThrow('画布项目标识格式错误')
    }
  })

  it('removes spelled-out links from canvas notification text', () => {
    expect(canvasNotificationText('生成完成')).toBe('生成完成')
    expect(canvasNotificationText('打开 https://evil.example/a?b=c 查看')).toBe('打开  查看')
    expect(canvasNotificationText('HTTP://EVIL.EXAMPLE 和 www.evil.example')).toBe('和')
    expect(canvasNotificationText('ftp://evil.example')).toBe('')
  })

  it('keeps an ordinary proposed save name untouched', () => {
    expect(canvasSaveFileName('xingmang-project.xingcanvas', '保存文件名', 'fallback.txt'))
      .toBe('xingmang-project.xingcanvas')
    expect(canvasSaveFileName('我的 项目 v2.xingcanvas', '保存文件名', 'fallback.txt'))
      .toBe('我的 项目 v2.xingcanvas')
  })

  it('strips the directory a poisoned canvas proposes for the save dialog', () => {
    // The Windows per-user startup folder: anything dropped there runs at the
    // next sign-in, so the dialog must never open pointing at it.
    expect(canvasSaveFileName(
      'C:\\Users\\yoyo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\update.cmd',
      '保存文件名',
      'fallback.txt',
    )).toBe('update.cmd')
    // The macOS equivalent: a LaunchAgent plist runs at the next login.
    expect(canvasSaveFileName(
      '/Users/yoyo/Library/LaunchAgents/com.xingmang.update.plist',
      '保存文件名',
      'fallback.txt',
    )).toBe('com.xingmang.update.plist')
    // Both separators are rejected whatever the host platform is, so a
    // Windows-shaped proposal cannot survive whole on macOS and vice versa.
    expect(canvasSaveFileName('..\\..\\Startup\\run.bat', '保存文件名', 'fallback.txt')).toBe('run.bat')
    expect(canvasSaveFileName('../../LaunchAgents/run.plist', '保存文件名', 'fallback.txt')).toBe('run.plist')
  })

  it('falls back when nothing safe is left of the proposed save name', () => {
    expect(canvasSaveFileName('..', '保存文件名', 'fallback.txt')).toBe('fallback.txt')
    expect(canvasSaveFileName('C:\\Users\\yoyo\\Startup\\', '保存文件名', 'fallback.txt')).toBe('fallback.txt')
    expect(canvasSaveFileName('.hidden', '保存文件名', 'fallback.txt')).toBe('hidden')
    // Windows device names are not file names; writing to one goes to the device.
    expect(canvasSaveFileName('NUL', '保存文件名', 'fallback.txt')).toBe('fallback.txt')
    expect(canvasSaveFileName('com1.txt', '保存文件名', 'fallback.txt')).toBe('fallback.txt')
  })

  it('repairs characters a file name cannot carry and still rejects non-strings', () => {
    // A drive-relative name and an NTFS alternate data stream both hide a
    // location behind what looks like a plain name.
    expect(canvasSaveFileName('C:evil.cmd', '保存文件名', 'fallback.txt')).toBe('C_evil.cmd')
    expect(canvasSaveFileName('notes.txt:hidden', '保存文件名', 'fallback.txt')).toBe('notes.txt_hidden')
    expect(canvasSaveFileName('a<b>c|d?e*f.txt', '保存文件名', 'fallback.txt')).toBe('a_b_c_d_e_f.txt')
    expect(() => canvasSaveFileName(undefined, '保存文件名', 'fallback.txt')).toThrow('保存文件名格式错误')
    expect(() => canvasSaveFileName('name\u0000.txt', '保存文件名', 'fallback.txt')).toThrow('保存文件名格式错误')
    expect(() => canvasSaveFileName('n'.repeat(257), '保存文件名', 'fallback.txt')).toThrow('保存文件名格式错误')
  })
})
