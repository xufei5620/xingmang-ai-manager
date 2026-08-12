import type { CanvasAssetQuery, CanvasImageEditInput, CanvasImageGenerateInput, CanvasStartRunInput } from './canvas-contract'
import type { CanvasPromptPresetInput, CanvasPromptPresetUpdate } from './canvas-prompt-preset-store'
import type { CanvasRunGraph, CanvasRunNodeKind, CanvasRunScope } from './canvas-run-contract'

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function requiredCanvasString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1F\x7F]/.test(value)) {
    throw new Error(`${label}格式错误`)
  }
  return value
}

export function parseCanvasImageGenerateInput(value: unknown): CanvasImageGenerateInput {
  if (!isRecord(value)) throw new Error('画布生图请求格式错误')
  const requestId = requiredCanvasString(value.requestId, '画布生图请求标识', 160)
  const group = requiredCanvasString(value.group, '画布生图分组', 128)
  const model = requiredCanvasString(value.model, '画布生图模型', 200)
  const prompt = requiredCanvasString(value.prompt, '画布生图提示词', 40_000)
  const size = value.size === undefined ? undefined : requiredCanvasString(value.size, '画布生图尺寸', 64)
  const quality = value.quality
  if (quality !== undefined && quality !== 'low' && quality !== 'medium' && quality !== 'high' && quality !== 'auto') {
    throw new Error('画布生图画质格式错误')
  }
  const allowed = new Set(['requestId', 'group', 'model', 'prompt', 'size', 'quality'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('画布生图请求包含未知字段')
  return { requestId, group, model, prompt, ...(size ? { size } : {}), ...(quality ? { quality } : {}) }
}

export function parseCanvasImageEditInput(value: unknown): CanvasImageEditInput {
  if (!isRecord(value)) throw new Error('画布图片编辑请求格式错误')
  if (!Array.isArray(value.sourceAssetIds) || value.sourceAssetIds.length === 0 || value.sourceAssetIds.length > 4) {
    throw new Error('画布图片编辑参考图数量格式错误')
  }
  const sourceAssetIds = value.sourceAssetIds.map((entry) => requiredCanvasString(entry, '画布参考图片资产标识', 64))
  if (sourceAssetIds.some((assetId) => !assetIdPattern.test(assetId))) throw new Error('画布参考图片资产标识格式错误')
  if (new Set(sourceAssetIds).size !== sourceAssetIds.length) throw new Error('画布参考图片资产不能重复')
  const generateInput = parseCanvasImageGenerateInput(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'sourceAssetIds'),
  ))
  return { ...generateInput, sourceAssetIds }
}

const canvasNodeKinds = new Set<CanvasRunNodeKind>([
  'text', 'image', 'video', 'prompt', 'image-input', 'video-input', 'image-generate', 'image-edit',
  'video-generate', 'frame-extract', 'router', 'gallery', 'output', 'group', 'note',
])

function optionalCanvasString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined || value === '' ? undefined : requiredCanvasString(value, label, maximum)
}

function canvasString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1F\x7F]/.test(value)) {
    throw new Error(`${label}格式错误`)
  }
  return value
}

function assertOnlyFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed)
  if (Object.keys(value).some((key) => !fields.has(key))) throw new Error(`${label}包含未知字段`)
}

export function parseCanvasAssetQuery(value: unknown): CanvasAssetQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('画布资产查询格式错误')
  assertOnlyFields(value, ['offset', 'limit', 'mediaType', 'search'], '画布资产查询')
  const offset = value.offset ?? 0
  const limit = value.limit ?? 24
  const mediaType = value.mediaType ?? 'all'
  const search = value.search ?? ''
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 500) throw new Error('画布资产分页位置无效')
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('画布资产分页数量无效')
  if (mediaType !== 'all' && mediaType !== 'image') throw new Error('画布资产媒体类型无效')
  if (typeof search !== 'string' || search.length > 128 || /[\x00-\x1F\x7F]/.test(search)) throw new Error('画布资产搜索内容无效')
  return {
    offset: offset as number,
    limit: limit as number,
    mediaType,
    ...(search.trim() ? { search: search.trim() } : {}),
  }
}

function promptPresetText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
    throw new Error(`${label}格式错误`)
  }
  return value.trim()
}

function promptPresetTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 16) throw new Error('画布提示词标签格式错误')
  const tags = value.map((tag) => promptPresetText(tag, '画布提示词标签', 32))
  if (new Set(tags).size !== tags.length) throw new Error('画布提示词标签不能重复')
  return tags
}

export function parseCanvasPromptPresetInput(value: unknown): CanvasPromptPresetInput {
  if (!isRecord(value)) throw new Error('画布提示词预设请求格式错误')
  assertOnlyFields(value, ['name', 'prompt', 'tags'], '画布提示词预设请求')
  const tags = promptPresetTags(value.tags)
  return {
    name: promptPresetText(value.name, '画布提示词名称', 100),
    prompt: promptPresetText(value.prompt, '画布提示词内容', 40_000),
    ...(tags ? { tags } : {}),
  }
}

export function parseCanvasPromptPresetUpdate(value: unknown): CanvasPromptPresetUpdate {
  if (!isRecord(value)) throw new Error('画布提示词预设更新格式错误')
  assertOnlyFields(value, ['id', 'name', 'prompt', 'tags'], '画布提示词预设更新')
  const id = requiredCanvasString(value.id, '画布提示词预设标识', 80)
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) throw new Error('画布提示词预设标识格式错误')
  const name = value.name === undefined ? undefined : promptPresetText(value.name, '画布提示词名称', 100)
  const prompt = value.prompt === undefined ? undefined : promptPresetText(value.prompt, '画布提示词内容', 40_000)
  const tags = promptPresetTags(value.tags)
  if (name === undefined && prompt === undefined && tags === undefined) throw new Error('画布提示词预设更新内容为空')
  return { id, ...(name ? { name } : {}), ...(prompt ? { prompt } : {}), ...(tags ? { tags } : {}) }
}

export function parseCanvasPromptPresetId(value: unknown): string {
  const id = requiredCanvasString(value, '画布提示词预设标识', 80)
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) throw new Error('画布提示词预设标识格式错误')
  return id
}

function parseRunScope(value: unknown): CanvasRunScope {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('画布运行范围格式错误')
  if (value.kind === 'all') {
    assertOnlyFields(value, ['kind'], '画布运行范围')
    return { kind: 'all' }
  }
  if (value.kind === 'to-node') {
    assertOnlyFields(value, ['kind', 'nodeId'], '画布运行范围')
    return { kind: 'to-node', nodeId: requiredCanvasString(value.nodeId, '运行节点标识', 256) }
  }
  if (value.kind === 'selection' || value.kind === 'dirty') {
    assertOnlyFields(value, ['kind', 'nodeIds'], '画布运行范围')
    if (!Array.isArray(value.nodeIds) || value.nodeIds.length === 0 || value.nodeIds.length > 5_000) throw new Error('画布运行节点范围格式错误')
    const nodeIds = value.nodeIds.map((id) => requiredCanvasString(id, '运行节点标识', 256))
    return { kind: value.kind, nodeIds }
  }
  throw new Error('画布运行范围格式错误')
}

export function parseCanvasStartRunInput(value: unknown): CanvasStartRunInput {
  if (!isRecord(value)) throw new Error('画布运行请求格式错误')
  assertOnlyFields(value, ['graph', 'scope'], '画布运行请求')
  if (!isRecord(value.graph) || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges)) {
    throw new Error('画布运行图格式错误')
  }
  assertOnlyFields(value.graph, ['nodes', 'edges'], '画布运行图')
  if (value.graph.nodes.length > 5_000 || value.graph.edges.length > 20_000) throw new Error('工作流规模超过安全上限')
  const nodes: CanvasRunGraph['nodes'] = value.graph.nodes.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.data)) throw new Error('画布运行节点格式错误')
    assertOnlyFields(entry, ['id', 'kind', 'definitionVersion', 'disabled', 'data'], '画布运行节点')
    assertOnlyFields(entry.data, ['prompt', 'model', 'group', 'quality', 'size', 'adoptedAssetId'], '画布运行节点数据')
    const kind = requiredCanvasString(entry.kind, '画布节点类型', 64) as CanvasRunNodeKind
    if (!canvasNodeKinds.has(kind)) throw new Error('画布节点类型不受支持')
    if (!Number.isSafeInteger(entry.definitionVersion) || (entry.definitionVersion as number) < 1 || (entry.definitionVersion as number) > 10_000) throw new Error('画布节点版本格式错误')
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') throw new Error('画布节点禁用状态格式错误')
    const prompt = canvasString(entry.data.prompt, '画布节点提示词', 100_000)
    const model = canvasString(entry.data.model, '画布节点模型', 512)
    const group = optionalCanvasString(entry.data.group, '画布分组', 128)
    const quality = optionalCanvasString(entry.data.quality, '画布画质', 64)
    const size = optionalCanvasString(entry.data.size, '画布尺寸', 64)
    const adoptedAssetId = optionalCanvasString(entry.data.adoptedAssetId, '画布资产标识', 64)
    if (adoptedAssetId && !assetIdPattern.test(adoptedAssetId)) throw new Error('画布资产标识格式错误')
    return {
      id: requiredCanvasString(entry.id, '画布节点标识', 256),
      kind,
      definitionVersion: entry.definitionVersion as number,
      ...(entry.disabled === true ? { disabled: true } : {}),
      data: {
        prompt,
        model,
        ...(group ? { group } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(adoptedAssetId ? { adoptedAssetId } : {}),
      },
    }
  })
  const edges: CanvasRunGraph['edges'] = value.graph.edges.map((entry) => {
    if (!isRecord(entry)) throw new Error('画布运行连线格式错误')
    assertOnlyFields(entry, ['id', 'source', 'sourceHandle', 'target', 'targetHandle'], '画布运行连线')
    return {
      id: requiredCanvasString(entry.id, '画布连线标识', 256),
      source: requiredCanvasString(entry.source, '画布连线源节点', 256),
      sourceHandle: requiredCanvasString(entry.sourceHandle, '画布连线源端口', 128),
      target: requiredCanvasString(entry.target, '画布连线目标节点', 256),
      targetHandle: requiredCanvasString(entry.targetHandle, '画布连线目标端口', 128),
    }
  })
  return { graph: { nodes, edges }, scope: parseRunScope(value.scope) }
}
