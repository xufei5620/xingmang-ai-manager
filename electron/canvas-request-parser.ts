import type { CanvasAssetQuery, CanvasImageEditInput, CanvasImageGenerateInput, CanvasRenameAssetInput, CanvasStartRunInput, CanvasUpdateAssetMetadataInput } from './canvas-contract'
import type { AiVideoGenerationInput } from './ai-video-service'
import type { CanvasPromptPresetInput, CanvasPromptPresetUpdate } from './canvas-prompt-preset-store'
import type { CanvasRunGraph, CanvasRunNodeKind, CanvasRunScope } from './canvas-run-contract'

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
const videoTaskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function requiredCanvasString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1F\x7F]/.test(value)) {
    throw new Error(`${label}格式错误`)
  }
  return value
}

export function requiredCanvasText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)
  ) {
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
  const imageResolution = value.imageResolution
  if (imageResolution !== undefined && imageResolution !== '1K' && imageResolution !== '2K' && imageResolution !== '4K') {
    throw new Error('画布生图清晰度格式错误')
  }
  const allowed = new Set(['requestId', 'group', 'model', 'prompt', 'size', 'quality', 'imageResolution'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('画布生图请求包含未知字段')
  return {
    requestId, group, model, prompt,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    ...(imageResolution ? { imageResolution } : {}),
  }
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

export function parseCanvasVideoGenerateInput(value: unknown): AiVideoGenerationInput {
  if (!isRecord(value)) throw new Error('画布视频请求格式错误')
  assertOnlyFields(value, [
    'requestId', 'group', 'model', 'prompt', 'seconds', 'imageAssetId', 'imageAssetIds', 'videoAssetIds', 'audioAssetIds',
    'width', 'height', 'mode', 'resolution', 'aspectRatio', 'promptOptimization',
  ], '画布视频请求')
  const imageAssetId = value.imageAssetId === undefined
    ? undefined
    : requiredCanvasString(value.imageAssetId, '画布视频参考图片资产标识', 64)
  if (imageAssetId && !assetIdPattern.test(imageAssetId)) throw new Error('画布视频参考图片资产标识格式错误')
  const assetIds = (entry: unknown, label: string, maximum: number): string[] | undefined => {
    if (entry === undefined) return undefined
    if (!Array.isArray(entry) || entry.length > maximum) throw new Error(`${label}数量格式错误`)
    const parsed = entry.map((assetId) => requiredCanvasString(assetId, `${label}资产标识`, 64))
    if (parsed.some((assetId) => !assetIdPattern.test(assetId))) throw new Error(`${label}资产标识格式错误`)
    if (new Set(parsed).size !== parsed.length) throw new Error(`${label}不能重复`)
    return parsed
  }
  const imageAssetIds = assetIds(value.imageAssetIds, '画布视频参考图片', 9)
  const videoAssetIds = assetIds(value.videoAssetIds, '画布视频参考视频', 3)
  const audioAssetIds = assetIds(value.audioAssetIds, '画布视频参考音频', 3)
  if (imageAssetId && imageAssetIds?.includes(imageAssetId)) throw new Error('画布视频参考图片不能重复')
  const seconds = requiredCanvasString(value.seconds, '画布视频时长', 2)
  if (!/^(?:[1-9]|1[0-5])$/.test(seconds)) throw new Error('画布视频时长必须是 1-15 秒的整数')
  const hasWidth = value.width !== undefined
  const hasHeight = value.height !== undefined
  const allowedDimensions = new Set(['1280x720', '720x1280', '1024x1024', '1024x768', '768x1024'])
  if (hasWidth !== hasHeight || (hasWidth && (
    !Number.isSafeInteger(value.width)
    || !Number.isSafeInteger(value.height)
    || !allowedDimensions.has(`${value.width}x${value.height}`)
  ))) throw new Error('画布视频比例不受支持')
  const mode = value.mode
  if (mode !== undefined && !['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'].includes(String(mode))) {
    throw new Error('画布 MiniMax 生成模式不受支持')
  }
  const resolution = value.resolution
  if (resolution !== undefined && resolution !== '480p' && resolution !== '720p') throw new Error('画布 MiniMax 分辨率不受支持')
  const aspectRatio = value.aspectRatio
  if (aspectRatio !== undefined && !['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'].includes(String(aspectRatio))) {
    throw new Error('画布 MiniMax 视频比例不受支持')
  }
  if (value.promptOptimization !== undefined && typeof value.promptOptimization !== 'boolean') {
    throw new Error('画布 MiniMax 提示词优化开关格式错误')
  }
  return {
    requestId: requiredCanvasString(value.requestId, '画布视频请求标识', 160),
    group: requiredCanvasString(value.group, '画布视频分组', 128),
    model: requiredCanvasString(value.model, '画布视频模型', 128),
    prompt: requiredCanvasString(value.prompt, '画布视频提示词', 40_000),
    seconds,
    ...(imageAssetId ? { imageAssetId } : {}),
    ...(imageAssetIds ? { imageAssetIds } : {}),
    ...(videoAssetIds ? { videoAssetIds } : {}),
    ...(audioAssetIds ? { audioAssetIds } : {}),
    ...(hasWidth ? { width: value.width as number, height: value.height as number } : {}),
    ...(mode ? { mode: mode as AiVideoGenerationInput['mode'] } : {}),
    ...(resolution ? { resolution: resolution as AiVideoGenerationInput['resolution'] } : {}),
    ...(aspectRatio ? { aspectRatio: aspectRatio as AiVideoGenerationInput['aspectRatio'] } : {}),
    ...(typeof value.promptOptimization === 'boolean' ? { promptOptimization: value.promptOptimization } : {}),
  }
}

export function parseCanvasVideoTaskId(value: unknown): string {
  const taskId = requiredCanvasString(value, '画布视频任务标识', 256)
  if (!videoTaskIdPattern.test(taskId)) throw new Error('画布视频任务标识格式错误')
  return taskId
}

const canvasNodeKinds = new Set<CanvasRunNodeKind>([
  'text', 'image', 'video', 'prompt', 'image-input', 'video-input', 'audio-input', 'image-generate', 'image-edit',
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
  assertOnlyFields(value, ['offset', 'limit', 'mediaType', 'search', 'view', 'tag', 'source', 'sort', 'prompt', 'runId', 'nodeId'], '画布资产查询')
  const offset = value.offset ?? 0
  const limit = value.limit ?? 24
  const mediaType = value.mediaType ?? 'all'
  const search = value.search ?? ''
  const view = value.view
  const tag = value.tag ?? ''
  const source = value.source
  const sort = value.sort
  const prompt = value.prompt ?? ''
  const runId = value.runId
  const nodeId = value.nodeId
  // The ceiling matches the library index rather than the old 500, which turned
  // deep paging into an error once a library grew past twenty pages.
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 20_000) throw new Error('画布资产分页位置无效')
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('画布资产分页数量无效')
  if (mediaType !== 'all' && mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'audio') throw new Error('画布资产媒体类型无效')
  if (typeof search !== 'string' || search.length > 128 || /[\x00-\x1F\x7F]/.test(search)) throw new Error('画布资产搜索内容无效')
  if (view !== undefined && view !== 'all' && view !== 'favorites' && view !== 'recent' && view !== 'trash') throw new Error('画布资产快速视图无效')
  if (typeof tag !== 'string' || tag.length > 32 || /[\x00-\x1F\x7F]/.test(tag)) throw new Error('画布资产标签筛选无效')
  if (source !== undefined && source !== 'all' && source !== 'generated' && source !== 'imported' && source !== 'legacy') throw new Error('画布资产来源筛选无效')
  if (sort !== undefined && sort !== 'created-desc' && sort !== 'created-asc' && sort !== 'used-desc' && sort !== 'name-asc') throw new Error('画布资产排序无效')
  if (typeof prompt !== 'string' || prompt.length > 2_000 || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(prompt)) throw new Error('画布资产提示词筛选无效')
  if (runId !== undefined) requiredCanvasString(runId, '画布运行标识', 256)
  if (nodeId !== undefined) requiredCanvasString(nodeId, '画布节点标识', 256)
  return {
    offset: offset as number,
    limit: limit as number,
    mediaType,
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(view ? { view } : {}),
    ...(tag.trim() ? { tag: tag.trim() } : {}),
    ...(source ? { source } : {}),
    ...(sort ? { sort } : {}),
    ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    ...(runId ? { runId: runId as string } : {}),
    ...(nodeId ? { nodeId: nodeId as string } : {}),
  }
}

export function parseCanvasAssetId(value: unknown): string {
  const assetId = requiredCanvasString(value, '画布资产标识', 64)
  if (!assetIdPattern.test(assetId)) throw new Error('画布资产标识格式错误')
  return assetId
}

export function parseCanvasRenameAssetInput(value: unknown): CanvasRenameAssetInput {
  if (!isRecord(value)) throw new Error('画布资产重命名请求格式错误')
  assertOnlyFields(value, ['assetId', 'displayName'], '画布资产重命名请求')
  const assetId = parseCanvasAssetId(value.assetId)
  if (typeof value.displayName !== 'string') throw new Error('画布资产显示名称格式错误')
  const displayName = value.displayName.trim()
  if (!displayName || displayName.length > 120 || /[\x00-\x1F\x7F<>:"/\\|?*]/.test(displayName)) {
    throw new Error('画布资产显示名称格式错误')
  }
  return { assetId, displayName }
}

export function parseCanvasUpdateAssetMetadataInput(value: unknown): CanvasUpdateAssetMetadataInput {
  if (!isRecord(value)) throw new Error('画布资产整理信息格式错误')
  assertOnlyFields(value, ['assetId', 'favorite', 'tags'], '画布资产整理信息')
  const assetId = parseCanvasAssetId(value.assetId)
  const favorite = value.favorite
  if (favorite !== undefined && typeof favorite !== 'boolean') throw new Error('画布资产收藏状态格式错误')
  let tags: string[] | undefined
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 12) throw new Error('画布资产标签格式错误')
    tags = value.tags.map((entry) => {
      if (typeof entry !== 'string') throw new Error('画布资产标签格式错误')
      const tag = entry.trim()
      if (!tag || tag.length > 32 || /[\x00-\x1F\x7F]/.test(tag)) throw new Error('画布资产标签格式错误')
      return tag
    })
    if (new Set(tags.map((tag) => tag.toLocaleLowerCase('zh-CN'))).size !== tags.length) {
      throw new Error('画布资产标签不能重复')
    }
  }
  if (favorite === undefined && tags === undefined) throw new Error('画布资产整理信息不能为空')
  return { assetId, ...(favorite !== undefined ? { favorite } : {}), ...(tags !== undefined ? { tags } : {}) }
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
  if (value.kind === 'to-node' || value.kind === 'from-node') {
    assertOnlyFields(value, ['kind', 'nodeId'], '画布运行范围')
    return { kind: value.kind, nodeId: requiredCanvasString(value.nodeId, '运行节点标识', 256) }
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
    assertOnlyFields(entry.data, [
      'prompt', 'model', 'group', 'quality', 'size', 'imageResolution', 'seconds', 'adoptedAssetId',
      'videoMode', 'videoResolution', 'videoAspectRatio', 'promptOptimization',
    ], '画布运行节点数据')
    const kind = requiredCanvasString(entry.kind, '画布节点类型', 64) as CanvasRunNodeKind
    if (!canvasNodeKinds.has(kind)) throw new Error('画布节点类型不受支持')
    if (!Number.isSafeInteger(entry.definitionVersion) || (entry.definitionVersion as number) < 1 || (entry.definitionVersion as number) > 10_000) throw new Error('画布节点版本格式错误')
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') throw new Error('画布节点禁用状态格式错误')
    const prompt = canvasString(entry.data.prompt, '画布节点提示词', 100_000)
    const model = canvasString(entry.data.model, '画布节点模型', 512)
    const group = optionalCanvasString(entry.data.group, '画布分组', 128)
    const quality = optionalCanvasString(entry.data.quality, '画布画质', 64)
    const size = optionalCanvasString(entry.data.size, '画布尺寸', 64)
    const imageResolution = optionalCanvasString(entry.data.imageResolution, '画布生图清晰度', 2)
    if (imageResolution && imageResolution !== '1K' && imageResolution !== '2K' && imageResolution !== '4K') {
      throw new Error('画布生图清晰度不受支持')
    }
    const seconds = entry.data.seconds === undefined || entry.data.seconds === ''
      ? undefined
      : canvasString(entry.data.seconds, '画布视频时长', 8)
    if (seconds && !/^(?:[1-9]|1[0-5])$/.test(seconds)) throw new Error('画布视频时长必须是 1-15 秒的整数')
    const adoptedAssetId = optionalCanvasString(entry.data.adoptedAssetId, '画布资产标识', 64)
    if (adoptedAssetId && !assetIdPattern.test(adoptedAssetId)) throw new Error('画布资产标识格式错误')
    const videoMode = optionalCanvasString(entry.data.videoMode, '画布 MiniMax 生成模式', 16)
    if (videoMode && !['auto', 't2va', 'i2va', 'fl2va', 'l2va', 'ref2va'].includes(videoMode)) throw new Error('画布 MiniMax 生成模式不受支持')
    const videoResolution = optionalCanvasString(entry.data.videoResolution, '画布 MiniMax 分辨率', 8)
    if (videoResolution && videoResolution !== '480p' && videoResolution !== '720p') throw new Error('画布 MiniMax 分辨率不受支持')
    const videoAspectRatio = optionalCanvasString(entry.data.videoAspectRatio, '画布 MiniMax 视频比例', 8)
    if (videoAspectRatio && !['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'].includes(videoAspectRatio)) throw new Error('画布 MiniMax 视频比例不受支持')
    const promptOptimization = entry.data.promptOptimization
    if (promptOptimization !== undefined && typeof promptOptimization !== 'boolean') throw new Error('画布 MiniMax 提示词优化开关格式错误')
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
        ...(imageResolution ? { imageResolution: imageResolution as CanvasRunGraph['nodes'][number]['data']['imageResolution'] } : {}),
        ...(seconds ? { seconds } : {}),
        ...(adoptedAssetId ? { adoptedAssetId } : {}),
        ...(videoMode ? { videoMode: videoMode as CanvasRunGraph['nodes'][number]['data']['videoMode'] } : {}),
        ...(videoResolution ? { videoResolution: videoResolution as CanvasRunGraph['nodes'][number]['data']['videoResolution'] } : {}),
        ...(videoAspectRatio ? { videoAspectRatio: videoAspectRatio as CanvasRunGraph['nodes'][number]['data']['videoAspectRatio'] } : {}),
        ...(typeof promptOptimization === 'boolean' ? { promptOptimization } : {}),
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
