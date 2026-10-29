import { defaultImageTransformRecipe, maximumImageTransformInputs, type ImageLayer, type ImageLayerRecipe } from '../image-tools/recipe'
import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { buildCanvasRunPreflight, dramaParseMaximumRequestCount } from './run-preflight'
import { defaultInteriorTask } from '../interior/interior-task'
import { defaultCommerceTask } from '../commerce/commerce-task'
import { defaultExteriorTask } from '../exterior/exterior-task'
import { buildStoryboardAnalysisPrompt, defaultStoryboardTask } from '../storyboard/storyboard-task'

function preflight(model: string, imageResolution: '1K' | '2K' | '4K', size = '1280x720') {
  const graph: CanvasRunGraph = { nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'A ceramic cup', model, group: 'provider', size, imageResolution } }], edges: [] }
  return buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [model], videoModels: [], cachedNodeIds: ['image'] })
}


describe('paid node prompt admission', () => {
  const kinds = ['image', 'image-generate', 'image-edit', 'video', 'video-generate', 'text-generate', 'drama-parse'] as const
  function graph(kind: typeof kinds[number], prompt = ''): CanvasRunGraph {
    const image = kind.startsWith('image'), video = kind.startsWith('video')
    const result: CanvasRunGraph = { nodes: [{ id: 'target', kind, definitionVersion: 1, data: { prompt, model: image ? 'gpt-image-1' : video ? 'grok-imagine-video' : 'gpt-4.1', group: 'provider', ...(image ? { imageCandidateCount: 4 } : video ? { videoCandidateCount: 3 } : {}) } }], edges: [] }
    if (kind === 'image-edit') {
      result.nodes.push({ id: 'source', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } })
      result.edges.push({ id: 'source-edge', source: 'source', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' })
    }
    return result
  }
  // The desktop host asks a drama parse once more when the answer is not a readable table.
  function upperBound(kind: typeof kinds[number]): number {
    return kind.startsWith('image') ? 4 : kind.startsWith('video') ? 3 : kind === 'drama-parse' ? 2 : 1
  }
  function inspect(value: CanvasRunGraph, nodeBlockReasons?: Record<string, string>) {
    return buildCanvasRunPreflight({ graph: value, scope: { kind: 'all' }, cachedNodeIds: ['target'], imageModels: ['gpt-image-1'], videoModels: ['grok-imagine-video'], textModels: ['gpt-4.1'], nodeBlockReasons })
  }
  it.each(kinds)('blocks empty and whitespace-only %s prompts without trusting an old result', (kind) => {
    for (const prompt of ['', ' \n\t　']) {
      const value = graph(kind, prompt), before = structuredClone(value)
      const result = inspect(value)
      expect(result).toMatchObject({ canStart: false, blockedCount: 1, paidRequestCount: 0, imageRequestCount: 0, videoRequestCount: 0, textRequestCount: 0, cacheHitCount: 0 })
      expect(result.items.find((item) => item.nodeId === 'target')).toMatchObject({ action: 'blocked', requestCount: 0, reasonCode: 'invalid-parameters', reason: '生成节点没有提示词，请填写提示词或连接上游文字节点' })
      expect(value).toEqual(before)
    }
  })
  it.each(kinds)('keeps explicit %s prompts and their independent request upper bounds', (kind) => {
    const result = inspect(graph(kind, 'A ceramic cup on a table'))
    const expected = upperBound(kind)
    expect(result).toMatchObject({ canStart: true, paidRequestCount: expected, cacheHitCount: 0 })
    expect(result.items.find((item) => item.nodeId === 'target')).toMatchObject({ action: 'execute', requestCount: expected })
  })
  it.each(kinds)('admits an empty %s prompt with a real incoming text port', (kind) => {
    const value = graph(kind)
    value.nodes.push({ id: 'words', kind: 'prompt', definitionVersion: 1, data: { prompt: 'A ceramic cup on a table', model: '' } })
    value.edges.push({ id: 'words-edge', source: 'words', sourceHandle: 'out:text', target: 'target', targetHandle: 'in:text' })
    expect(inspect(value)).toMatchObject({ canStart: true, paidRequestCount: upperBound(kind) })
  })
  it('counts a drama parse as the two text requests it may be billed for', () => {
    const value = graph('drama-parse', '第一场：雨夜，林青推门进来。')
    value.nodes.push({ id: 'words', kind: 'text-generate', definitionVersion: 1, data: { prompt: '写一句旁白', model: 'gpt-4.1', group: 'provider' } })
    const result = inspect(value)
    expect(dramaParseMaximumRequestCount).toBe(2)
    expect(result.items.find((item) => item.nodeId === 'target')).toMatchObject({ action: 'execute', paid: true, requestCount: 2 })
    expect(result.items.find((item) => item.nodeId === 'words')).toMatchObject({ action: 'execute', paid: true, requestCount: 1 })
    expect(result).toMatchObject({ canStart: true, requestCount: 3, paidRequestCount: 3, textRequestCount: 3 })
    expect(result.warnings).toContain('本次最多提交 3 个付费生成请求；不确定的上游提交不会自动重试')
  })
  it('does not treat an image input or a text edge to a different node as a prompt', () => {
    const value = graph('image-edit')
    value.nodes.push({ id: 'words', kind: 'prompt', definitionVersion: 1, data: { prompt: 'Words elsewhere', model: '' } }, { id: 'other', kind: 'output', definitionVersion: 1, data: { prompt: '', model: '' } })
    value.edges.push({ id: 'elsewhere', source: 'words', sourceHandle: 'out:text', target: 'other', targetHandle: 'in:text' })
    expect(inspect(value).items.find((item) => item.nodeId === 'target')).toMatchObject({ action: 'blocked', reason: '生成节点没有提示词，请填写提示词或连接上游文字节点' })
  })
  it('preserves disabled, upstream-skip and existing block reasons before prompt admission', () => {
    const disabled = graph('image-generate'); disabled.nodes[0].disabled = true
    expect(inspect(disabled).items[0]).toMatchObject({ action: 'skip', reasonCode: 'disabled', requestCount: 0 })
    const skipped = graph('text-generate')
    skipped.nodes.push({ id: 'words', kind: 'prompt', definitionVersion: 1, disabled: true, data: { prompt: '', model: '' } })
    skipped.edges.push({ id: 'words-edge', source: 'words', sourceHandle: 'out:text', target: 'target', targetHandle: 'in:text' })
    expect(inspect(skipped).items[0]).toMatchObject({ action: 'skip', reasonCode: 'upstream-skip', requestCount: 0 })
    expect(inspect(graph('image-generate'), { target: '先确认脚本' }).items[0]).toMatchObject({ action: 'blocked', reasonCode: 'drama-gate', reason: '先确认脚本' })
    const missing = graph('image-generate'); delete missing.nodes[0].data.group
    expect(inspect(missing).items[0]).toMatchObject({ action: 'blocked', reasonCode: 'missing-group', reason: '缺少生图分组' })
    const unavailable = graph('image-generate'); unavailable.nodes[0].data.model = 'missing-model'
    expect(inspect(unavailable).items[0]).toMatchObject({ action: 'blocked', reasonCode: 'unavailable-model' })
  })
  it('retains commerce, interior and exterior derived prompts without supplement text', () => {
    for (const data of [{ commerceTask: defaultCommerceTask('material-a') }, { interiorTask: defaultInteriorTask() }, { exteriorTask: defaultExteriorTask('exterior-render') }]) {
      const value = graph('image-edit'), target = value.nodes[0]
      target.kind = 'image-generate'
      target.data = { ...target.data, ...data, imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'source-edge', outputIndex: 0 }] } }
      expect(inspect(value)).toMatchObject({ canStart: true, paidRequestCount: 4, imageRequestCount: 4 })
    }
  })
  it('retains explicit automatic storyboard analysis and the manual plot validation', () => {
    const value = graph('image-edit'), target = value.nodes[0], task = defaultStoryboardTask()
    target.kind = 'image-generate'
    target.data = { ...target.data, storyboardTask: task, imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'source-edge', outputIndex: 0 }] } }
    value.nodes.push({ id: 'analysis', kind: 'text-generate', definitionVersion: 1, data: { prompt: buildStoryboardAnalysisPrompt(task), model: 'gpt-4.1', group: 'provider', imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'analysis-source', outputIndex: 0 }] } } })
    value.edges.push({ id: 'analysis-source', source: 'source', sourceHandle: 'out:image', target: 'analysis', targetHandle: 'in:images' }, { id: 'analysis-text', source: 'analysis', sourceHandle: 'out:text', target: 'target', targetHandle: 'in:text' })
    expect(inspect(value)).toMatchObject({ canStart: true, paidRequestCount: 5, imageRequestCount: 4, textRequestCount: 1 })
    target.data.storyboardTask = { ...task, automaticPlot: false }
    value.nodes = value.nodes.filter((node) => node.id !== 'analysis')
    value.edges = value.edges.filter((edge) => edge.source !== 'analysis' && edge.target !== 'analysis')
    expect(inspect(value).items[0]).toMatchObject({ action: 'blocked', reasonCode: 'invalid-parameters', reason: '关闭自动剧情后，请填写明确的故事剧情' })
  })
})

describe('visual text generation preflight', () => {
  function visualGraph(model: string, count: number): CanvasRunGraph {
    return { nodes: [{ id: 'text', kind: 'text-generate', definitionVersion: 1, data: { model, prompt: '看图', group: 'text-provider' } }, ...Array.from({ length: count }, (_, index) => ({ id: `image-${index}`, kind: 'image-input', definitionVersion: 1, data: { model: '', prompt: '', adoptedAssetId: `${index}`.repeat(43) } }))], edges: Array.from({ length: count }, (_, index) => ({ id: `edge-${index}`, source: `image-${index}`, sourceHandle: 'out:image', target: 'text', targetHandle: 'in:images' })) }
  }
  it('allows four known-model images but blocks unknown models and five images with zero paid requests', () => {
    for (const [model, count, allowed] of [['gpt-4.1', 4, true], ['custom', 0, true], ['custom', 1, false], ['gpt-4.1', 5, false]] as const) {
      const result = buildCanvasRunPreflight({ graph: visualGraph(model, count), scope: { kind: 'all' }, imageModels: [], videoModels: [], textModels: [model] })
      expect(result.canStart).toBe(allowed)
      expect(result.paidRequestCount).toBe(allowed ? 1 : 0)
    }
  })
  it('counts expanded grid images before showing a paid confirmation', () => {
    const input = visualGraph('gpt-4.1', 1)
    const grid = { kind: 'grid-split' as const, rows: 3, columns: 3, gap: 0, padding: 0 }
    input.nodes.push({ id: 'grid', kind: 'image-grid-split', definitionVersion: 1, data: { model: '', prompt: '', imageTransform: grid } })
    input.edges[0].target = 'grid'; input.edges[0].targetHandle = 'in:image'
    input.edges.push({ id: 'batch', source: 'grid', sourceHandle: 'out:images', target: 'text', targetHandle: 'in:images' })
    const result = buildCanvasRunPreflight({ graph: input, scope: { kind: 'all' }, imageModels: [], videoModels: [], textModels: ['gpt-4.1'] })
    expect(result).toMatchObject({ canStart: false, paidRequestCount: 0 })
    expect(result.items.find((item) => item.nodeId === 'text')?.reason).toContain('4 张')
  })
})

describe('image request parameter preflight', () => {
  it.each(['gpt-4.1-mini', 'relay/GPT-4O-MINI', 'grok-imagine-video', 'proxy/MINIMAX-H3-FAST'])('blocks an explicitly saved non-image model %s even when a mixed catalog contains it', (model) => {
    for (const kind of ['image', 'image-generate', 'image-edit']) {
      const graph: CanvasRunGraph = { nodes: [
        { id: 'source', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } },
        { id: 'image', kind, definitionVersion: 1, data: { prompt: '', model, group: 'provider', size: '1536x1024', imageResolution: '1K', interiorTask: defaultInteriorTask(), imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'source-edge', outputIndex: 0 }] } } },
      ], edges: [{ id: 'source-edge', source: 'source', sourceHandle: 'out:image', target: 'image', targetHandle: 'in:images' }] }
      const before = structuredClone(graph)
      const result = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1', model], videoModels: [], textModels: [model] })
      expect(result).toMatchObject({ canStart: false, blockedCount: 1, paidRequestCount: 0, imageRequestCount: 0 })
      expect(result.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'blocked', model, reasonCode: 'unavailable-model', reason: expect.stringContaining('不能用于图像生成') })
      expect(graph).toEqual(before)
    }
  })

  it.each(['custom-paint-model', 'provider/house-style'])('retains available unknown image relay %s without selecting another model', (model) => {
    const result = preflight(model, '1K', '1536x1024')
    expect(result).toMatchObject({ canStart: true, paidRequestCount: 1, imageRequestCount: 1 })
    expect(result.items[0]).toMatchObject({ action: 'execute', model })
  })

  it.each(['2K', '4K'] as const)('accepts supported GPT Image 2 %s sizes with a paid upper bound', (resolution) => {
    expect(preflight('gpt-image-2', resolution)).toMatchObject({ canStart: true, blockedCount: 0, paidRequestCount: 1 })
  })

  it.each(['gpt-image-1', 'custom-image-alias'])('blocks unsupported high-resolution %s before confirmation', (model) => {
    const result = preflight(model, '4K')
    expect(result).toMatchObject({ canStart: false, blockedCount: 1, paidRequestCount: 0 })
    expect(result.items[0]).toMatchObject({ action: 'blocked', reasonCode: 'invalid-parameters' })
    expect(result.items[0].reason).toContain('不会静默')
  })

  it('blocks invalid pixel sizes but retains legacy 1K compatibility', () => {
    expect(preflight('gpt-image-2', '4K', 'auto').canStart).toBe(false)
    expect(preflight('gpt-image-1', '1K', 'auto').canStart).toBe(true)
  })

  it('blocks unsupported 4K ratios before presenting a paid request', () => {
    const result = preflight('gpt-image-2', '4K', '1024x1024')
    expect(result).toMatchObject({ canStart: false, blockedCount: 1, paidRequestCount: 0 })
    expect(result.items[0].reason).toContain('4K 尺寸超过')
    expect(preflight('gpt-image-2', '2K', '1024x1024').canStart).toBe(true)
  })

  it('blocks a retained wide ratio after switching to GPT Image 1', () => {
    const result = preflight('gpt-image-1', '1K', '1280x720')
    expect(result).toMatchObject({ canStart: false, blockedCount: 1, paidRequestCount: 0 })
    expect(result.items[0].reason).toContain('GPT Image 1 仅支持')
  })
})


describe('deterministic image tool preflight', () => {
  function layer(overrides: Partial<ImageLayer> = {}): ImageLayer {
    return { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, ...overrides }
  }
  function layerGraph(layers: ImageLayer[], inputCount: number): CanvasRunGraph {
    const graph = toolGraph()
    const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 512, outputHeight: 512, background: 'transparent', layers }
    graph.nodes[1] = { ...graph.nodes[1], kind: 'image-layer', data: { ...graph.nodes[1].data, imageTransform: recipe } }
    graph.edges = Array.from({ length: inputCount }, (_, index) => ({ ...graph.edges[0], id: `edge-${index}`, targetHandle: 'in:images' }))
    return graph
  }
  function toolGraph(): CanvasRunGraph {
    return { nodes: [
      { id: 'source', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'source-image' } },
      { id: 'tool', kind: 'image-crop', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: defaultImageTransformRecipe('crop') } },
    ], edges: [{ id: 'edge', source: 'source', sourceHandle: 'out:image', target: 'tool', targetHandle: 'in:image' }] }
  }
  it('uses no model or paid request and does not promise an unverified transform cache', () => {
    const result = buildCanvasRunPreflight({ graph: toolGraph(), scope: { kind: 'all' }, cachedNodeIds: ['tool'], imageModels: [], videoModels: [] })
    expect(result).toMatchObject({ canStart: true, paidRequestCount: 0 })
    expect(result.items.find((item) => item.nodeId === 'tool')).toMatchObject({ action: 'execute', paid: false })
  })
  it('blocks absent inputs and implicit cropping of a batch', () => {
    const graph = toolGraph()
    graph.edges[0].sourceHandle = 'out:images'
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [], videoModels: [] }).canStart).toBe(false)
    graph.edges = []
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [], videoModels: [] }).canStart).toBe(false)
  })
  it('accepts twenty ordered bitmap inputs and blocks the twenty-first input', () => {
    const layers = Array.from({ length: maximumImageTransformInputs }, (_, sourceIndex) => layer({ sourceIndex }))
    const input = { scope: { kind: 'all' as const }, imageModels: [], videoModels: [] }
    expect(buildCanvasRunPreflight({ ...input, graph: layerGraph(layers, 20) })).toMatchObject({ canStart: true, paidRequestCount: 0 })
    const result = buildCanvasRunPreflight({ ...input, graph: layerGraph(layers, 21) })
    expect(result).toMatchObject({ canStart: false, paidRequestCount: 0 })
    expect(result.items.find((item) => item.nodeId === 'tool')?.reason).toContain('1–20')
  })
  it('permits a source-free text and shape stack but still validates hidden bitmap references', () => {
    const content: ImageLayer[] = [layer({ sourceIndex: 19, content: { kind: 'text', text: '海报', color: '#ffffff', fontSize: 32, fontFamily: 'sans-serif', fontWeight: 700, align: 'center' } }), layer({ sourceIndex: 19, content: { kind: 'shape', shape: 'ellipse', fill: '#ffffff', stroke: 'transparent', strokeWidth: 0 } })]
    const input = { scope: { kind: 'all' as const }, imageModels: [], videoModels: [] }
    expect(buildCanvasRunPreflight({ ...input, graph: layerGraph(content, 0) })).toMatchObject({ canStart: true, paidRequestCount: 0 })
    expect(buildCanvasRunPreflight({ ...input, graph: layerGraph([], 0) }).canStart).toBe(false)
    const invalid = buildCanvasRunPreflight({ ...input, graph: layerGraph([...content, layer({ sourceIndex: 1, visible: false })], 1) })
    expect(invalid.items.find((item) => item.nodeId === 'tool')).toMatchObject({ action: 'blocked', reason: '图层引用需要至少 2 张图片，并按原图层引用顺序对应；文字、形状等内容图层不占图片来源' })
  })
  it('defers bitmap index validation for batch ports until their ordered assets are available', () => {
    const graph = layerGraph([layer({ sourceIndex: 8 })], 1)
    graph.edges[0].sourceHandle = 'out:images'
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [], videoModels: [] }).canStart).toBe(true)
  })
  it('allows an explicitly empty layer canvas while preserving legacy automatic-source behavior', () => {
    const graph = layerGraph([], 0)
    const recipe = graph.nodes[1].data.imageTransform!
    if (recipe.kind !== 'layer') throw new Error('unexpected fixture recipe')
    graph.nodes[1].data.imageTransform = { ...recipe, explicitLayers: true }
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [], videoModels: [] })).toMatchObject({ canStart: true, paidRequestCount: 0 })
  })
  it('counts all nine grid outputs before accepting a collage layout', () => {
    const graph = toolGraph()
    graph.nodes[1] = { ...graph.nodes[1], kind: 'image-grid-split', data: { prompt: '', model: '', imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } } }
    const collage = defaultImageTransformRecipe('collage')
    if (collage.kind !== 'collage') throw new Error('unexpected fixture recipe')
    graph.nodes.push({ id: 'collage', kind: 'image-collage', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: collage } })
    graph.edges.push({ id: 'all-slices', source: 'tool', sourceHandle: 'out:images', target: 'collage', targetHandle: 'in:images' })
    const input = { graph, scope: { kind: 'all' as const }, imageModels: [], videoModels: [] }
    const blocked = buildCanvasRunPreflight(input)
    expect(blocked).toMatchObject({ canStart: false, paidRequestCount: 0 })
    expect(blocked.items.find((item) => item.nodeId === 'collage')).toMatchObject({ action: 'blocked', reasonCode: 'invalid-parameters', reason: '9 张输入需至少 9 格，当前 2×2=4 格，请调整拼图行列' })
    graph.nodes[2].data.imageTransform = { ...collage, rows: 3, columns: 3 }
    expect(buildCanvasRunPreflight(input)).toMatchObject({ canStart: true, paidRequestCount: 0 })
    graph.nodes[2].data.imageTransform = collage
    graph.edges[1].sourceHandle = 'out:image'
    expect(buildCanvasRunPreflight(input).canStart).toBe(true)
  })

  it('accepts a tile input pool and rejects invalid selected batch ports', () => {
    const graph = toolGraph()
    graph.nodes[1] = { ...graph.nodes[1], kind: 'image-tile', data: { prompt: '', model: '', imageTransform: defaultImageTransformRecipe('tile') } }
    const input = { graph, scope: { kind: 'all' as const }, imageModels: [], videoModels: [] }
    expect(buildCanvasRunPreflight(input).canStart).toBe(true)
    graph.edges.push({ ...graph.edges[0], id: 'duplicate-input' })
    expect(buildCanvasRunPreflight(input).canStart).toBe(true)
    graph.edges.pop(); graph.edges[0].sourceHandle = 'out:images'
    expect(buildCanvasRunPreflight(input).items[1].reason).toContain('有效图片连接')
    graph.nodes[0].disabled = true
    expect(buildCanvasRunPreflight(input).items[1]).toMatchObject({ action: 'skip', reasonCode: 'upstream-skip' })
  })

  it('rejects known expanded input limits but does not use an unknown batch lower bound as an exact bitmap count', () => {
    const graph = layerGraph([layer({ sourceIndex: 8 })], 1)
    const input = { graph, scope: { kind: 'all' as const }, imageModels: [], videoModels: [] }
    graph.nodes[0] = { ...graph.nodes[0], kind: 'image-grid-split', data: { prompt: '', model: '', imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } } }
    graph.edges[0].sourceHandle = 'out:images'
    expect(buildCanvasRunPreflight(input).items[1].action).toBe('execute')
    graph.edges.push({ ...graph.edges[0], id: 'second' }, { ...graph.edges[0], id: 'third' })
    expect(buildCanvasRunPreflight(input).items[1].reason).toContain('27 张输入图片，超过 20 张')
    graph.edges.splice(1)
    graph.nodes[0].data.imageTransform = undefined
    expect(buildCanvasRunPreflight(input).items[1].action).toBe('execute')
    expect(buildCanvasRunPreflight(input).items[0].action).toBe('blocked')
  })
})


describe('native video source preflight', () => {
  it('requires the selected source to accept explicit audio and all requested resolution settings', () => {
    const model = 'grok-imagine-video-1.5'
    const graph: CanvasRunGraph = { nodes: [{ id: 'video', kind: 'video-generate', definitionVersion: 1, data: { prompt: 'A quiet scene', model, group: 'provider', generateAudio: false, videoResolution: '1080p', videoAspectRatio: '5:2', videoCandidateCount: 3 } }], edges: [] }
    const input = { graph, scope: { kind: 'all' as const }, imageModels: [], videoModels: [model] }
    expect(buildCanvasRunPreflight(input)).toMatchObject({ canStart: false, paidRequestCount: 0 })
    expect(buildCanvasRunPreflight({ ...input, videoProtocol: 'xai-native' })).toMatchObject({ canStart: true, videoRequestCount: 3 })
    graph.nodes[0].data.model = 'grok-imagine-video'
    expect(buildCanvasRunPreflight({ ...input, videoModels: ['grok-imagine-video'], videoProtocol: 'xai-native' })).toMatchObject({ canStart: false, paidRequestCount: 0 })
  })
})
