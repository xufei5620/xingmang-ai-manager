import { createHash, randomUUID } from 'node:crypto'
import { inspectAiImage, type AiStoredAsset } from './ai-asset-store'

export const canvasProjectPackageVersion = 1 as const
export const maximumCanvasProjectBytes = 96 * 1024 * 1024
export const maximumCanvasProjectAssets = 64
const maximumWorkflowBytes = 20 * 1024 * 1024
const maximumAssetBytes = 64 * 1024 * 1024
const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
const forbiddenKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const unsafeLocation = /^(?:[a-zA-Z]:[\\/]|\\\\|\/|https?:|data:|file:)/i

export interface CanvasProjectAssetSource {
  asset: AiStoredAsset
  bytes: Buffer
}

export interface CanvasProjectPackageAsset {
  assetId: string
  mimeType: AiStoredAsset['mimeType']
  bytesBase64: string
  sha256: string
}

export interface ParsedCanvasProjectPackage {
  workflow: Record<string, unknown>
  assets: Array<{ assetId: string; mimeType: AiStoredAsset['mimeType']; bytes: Buffer }>
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function utf8Size(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function safeString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximum
    && !value.includes('\0')
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedKeys.has(key) || forbiddenKey.test(key))) {
    throw new Error(`${label}包含未知或敏感字段`)
  }
}

function validateSettings(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (typeof value === 'string') return value.length <= 10_000 && !unsafeLocation.test(value)
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean' || value === null) return true
  if (Array.isArray(value)) return value.length <= 256 && value.every((entry) => validateSettings(entry, depth + 1))
  if (!isRecord(value) || Object.keys(value).length > 256) return false
  return Object.entries(value).every(([key, child]) => (
    key.length > 0 && key.length <= 128 && !forbiddenKey.test(key) && validateSettings(child, depth + 1)
  ))
}

function readAssetReference(value: unknown, assetIds: Set<string>): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error('画布项目资产引用格式错误')
  // Must stay in step with PersistedAssetRefV2 in
  // canvas-v2/src/persistence/workflow-schema.ts. `durationSeconds` was added
  // to the serializer so video chips can keep clip length; rejecting it here
  // failed every autosave whose node had already measured a video.
  assertAllowedKeys(value, ['kind', 'assetId', 'localUrl', 'mimeType', 'width', 'height', 'durationSeconds', 'taskId'], '画布项目资产引用')
  if (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio') throw new Error('画布项目资产类型错误')
  if (value.assetId !== undefined) {
    if (typeof value.assetId !== 'string' || !assetIdPattern.test(value.assetId)) throw new Error('画布项目资产标识错误')
    const expectedUrl = `xingmang-asset://${value.kind}/${value.assetId}`
    if (value.localUrl !== undefined && value.localUrl !== expectedUrl) throw new Error('画布项目本地资产地址错误')
    // 当前项目包只内嵌图片；视频和音频保留账号隔离的本地资产引用。
    if (value.kind === 'image') assetIds.add(value.assetId)
  } else if (value.localUrl !== undefined) {
    throw new Error('画布项目本地资产地址缺少标识')
  }
  if (value.taskId !== undefined && !safeString(value.taskId, 512)) throw new Error('画布项目任务标识错误')
  if (value.mimeType !== undefined && !safeString(value.mimeType, 128)) throw new Error('画布项目资产类型错误')
  for (const dimension of [value.width, value.height]) {
    if (dimension !== undefined && (!Number.isSafeInteger(dimension) || (dimension as number) <= 0)) throw new Error('画布项目资产尺寸错误')
  }
  if (value.durationSeconds !== undefined) {
    if (typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > 86_400) {
      throw new Error('画布项目资产时长错误')
    }
  }
}

function validateWorkflowNode(value: unknown, assetIds: Set<string>, nodeIds: Set<string>): void {
  if (!isRecord(value)) throw new Error('画布项目节点格式错误')
  assertAllowedKeys(value, ['id', 'kind', 'definitionVersion', 'disabled', 'parentId', 'width', 'height', 'locked', 'position', 'data'], '画布项目节点')
  if (!safeString(value.id, 256) || nodeIds.has(value.id)) throw new Error('画布项目节点标识错误')
  nodeIds.add(value.id)
  if (!safeString(value.kind, 128) || !Number.isSafeInteger(value.definitionVersion) || (value.definitionVersion as number) < 1) throw new Error('画布项目节点定义错误')
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') throw new Error('画布项目节点禁用状态错误')
  if (value.locked !== undefined && typeof value.locked !== 'boolean') throw new Error('画布项目节点锁定状态错误')
  if (value.parentId !== undefined && !safeString(value.parentId, 256)) throw new Error('画布项目父节点标识错误')
  for (const dimension of [value.width, value.height]) {
    if (dimension !== undefined && (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension <= 0 || dimension > 100_000)) {
      throw new Error('画布项目节点尺寸错误')
    }
  }
  if (!isRecord(value.position) || Object.keys(value.position).some((key) => key !== 'x' && key !== 'y')) throw new Error('画布项目节点位置错误')
  if (![value.position.x, value.position.y].every((entry) => typeof entry === 'number' && Number.isFinite(entry) && Math.abs(entry) <= 10_000_000)) throw new Error('画布项目节点位置错误')
  if (!isRecord(value.data)) throw new Error('画布项目节点数据错误')
  // Must stay in step with PersistedWorkflowNodeV2['data'] in
  // canvas-v2/src/persistence/workflow-schema.ts. `group` and `imageResolution`
  // were added to the serializer without being added here, so every project
  // whose node carried either field failed to save. `latestAttemptDurationMs`
  // is accepted on old files only; the renderer no longer writes or restores it.
  assertAllowedKeys(value.data, ['prompt', 'model', 'group', 'quality', 'size', 'imageResolution', 'seconds', 'result', 'settings', 'candidateAssetIds', 'latestAttemptDurationMs'], '画布项目节点数据')
  if (!safeString(value.data.prompt, 100_000, true) || !safeString(value.data.model, 512, true)) throw new Error('画布项目节点文本错误')
  for (const entry of [value.data.group, value.data.quality, value.data.size, value.data.seconds]) {
    if (entry !== undefined && !safeString(entry, 128)) throw new Error('画布项目节点选项错误')
  }
  if (value.data.imageResolution !== undefined && !['1K', '2K', '4K'].includes(value.data.imageResolution as string)) {
    throw new Error('画布项目节点清晰度错误')
  }
  if (value.data.latestAttemptDurationMs !== undefined) {
    if (
      typeof value.data.latestAttemptDurationMs !== 'number'
      || !Number.isFinite(value.data.latestAttemptDurationMs)
      || value.data.latestAttemptDurationMs <= 0
      || value.data.latestAttemptDurationMs > 86_400_000
    ) {
      throw new Error('画布项目节点耗时错误')
    }
  }
  readAssetReference(value.data.result, assetIds)
  if (value.data.settings !== undefined && !validateSettings(value.data.settings)) throw new Error('画布项目节点设置不安全')
  if (value.data.candidateAssetIds !== undefined) {
    if (!Array.isArray(value.data.candidateAssetIds) || value.data.candidateAssetIds.length > 16) throw new Error('画布项目候选资产错误')
    for (const assetId of value.data.candidateAssetIds) {
      if (typeof assetId !== 'string' || !assetIdPattern.test(assetId)) throw new Error('画布项目候选资产错误')
      if (isRecord(value.data.result) && value.data.result.kind === 'image') assetIds.add(assetId)
    }
  }
}

export function parseCanvasProjectWorkflow(content: string): { workflow: Record<string, unknown>; assetIds: string[] } {
  if (typeof content !== 'string' || content.length === 0 || utf8Size(content) > maximumWorkflowBytes) throw new Error('画布项目工作流超出安全上限')
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error('画布项目工作流不是有效 JSON')
  }
  if (!isRecord(raw)) throw new Error('画布项目工作流格式错误')
  assertAllowedKeys(raw, ['schemaVersion', 'name', 'viewport', 'mediaGroups', 'nodes', 'edges'], '画布项目工作流')
  if (raw.schemaVersion !== 2 || !safeString(raw.name, 256) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error('画布项目工作流格式错误')
  if (raw.nodes.length > 5_000 || raw.edges.length > 20_000) throw new Error('画布项目图规模超出安全上限')
  if (raw.viewport !== undefined) {
    if (!isRecord(raw.viewport) || Object.keys(raw.viewport).some((key) => key !== 'x' && key !== 'y' && key !== 'zoom')) {
      throw new Error('画布项目视口格式错误')
    }
    const { x, y, zoom } = raw.viewport
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 10_000_000
      || typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > 10_000_000
      || typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0.01 || zoom > 8) {
      throw new Error('画布项目视口格式错误')
    }
  }
  if (raw.mediaGroups !== undefined) {
    if (!isRecord(raw.mediaGroups)) throw new Error('画布项目生成分组格式错误')
    assertAllowedKeys(raw.mediaGroups, ['image', 'video', 'text', 'imageModel', 'videoModel', 'textModel'], '画布项目生成分组')
    for (const group of [raw.mediaGroups.image, raw.mediaGroups.video, raw.mediaGroups.text]) {
      if (group !== undefined && !safeString(group, 128)) throw new Error('画布项目生成分组格式错误')
    }
    for (const model of [raw.mediaGroups.imageModel, raw.mediaGroups.videoModel, raw.mediaGroups.textModel]) {
      if (model !== undefined && !safeString(model, 512)) throw new Error('画布项目默认模型格式错误')
    }
  }
  const assetIds = new Set<string>()
  const nodeIds = new Set<string>()
  raw.nodes.forEach((node) => validateWorkflowNode(node, assetIds, nodeIds))
  const edgeIds = new Set<string>()
  for (const edge of raw.edges) {
    if (!isRecord(edge)) throw new Error('画布项目连线格式错误')
    assertAllowedKeys(edge, ['id', 'source', 'sourceHandle', 'target', 'targetHandle'], '画布项目连线')
    if (!safeString(edge.id, 256) || edgeIds.has(edge.id)) throw new Error('画布项目连线标识错误')
    edgeIds.add(edge.id)
    if (![edge.source, edge.sourceHandle, edge.target, edge.targetHandle].every((entry) => safeString(entry, 256))) throw new Error('画布项目连线字段错误')
    if (!nodeIds.has(edge.source as string) || !nodeIds.has(edge.target as string)) throw new Error('画布项目连线引用不存在的节点')
  }
  return { workflow: raw, assetIds: [...assetIds] }
}

export function buildCanvasProjectPackage(workflowContent: string, sources: readonly CanvasProjectAssetSource[], createdAt = new Date().toISOString()): string {
  const parsed = parseCanvasProjectWorkflow(workflowContent)
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('画布项目时间格式错误')
  if (sources.length > maximumCanvasProjectAssets) throw new Error('画布项目资产数量超出安全上限')
  const sourceById = new Map(sources.map((source) => [source.asset.assetId, source]))
  const assets: CanvasProjectPackageAsset[] = []
  for (const assetId of parsed.assetIds) {
    const source = sourceById.get(assetId)
    if (!source) continue
    if (source.bytes.length > maximumAssetBytes) throw new Error('画布项目单个资产超出安全上限')
    const inspection = inspectAiImage(source.bytes, source.asset.mimeType)
    assets.push({
      assetId,
      mimeType: inspection.mimeType,
      bytesBase64: source.bytes.toString('base64'),
      sha256: createHash('sha256').update(source.bytes).digest('hex'),
    })
  }
  const content = JSON.stringify({
    format: 'xingmang-canvas-project', packageVersion: canvasProjectPackageVersion,
    createdAt, workflow: parsed.workflow, assets,
    provenance: [{ name: '星芒原创画布模板', license: 'Proprietary' }],
  })
  if (utf8Size(content) > maximumCanvasProjectBytes) throw new Error('画布项目超出 96 MB 安全上限')
  return content
}

export function parseCanvasProjectPackage(content: string): ParsedCanvasProjectPackage {
  if (typeof content !== 'string' || content.length === 0 || utf8Size(content) > maximumCanvasProjectBytes) throw new Error('画布项目超出 96 MB 安全上限')
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error('画布项目文件不是有效 JSON')
  }
  if (!isRecord(raw)) throw new Error('画布项目文件格式错误')
  assertAllowedKeys(raw, ['format', 'packageVersion', 'createdAt', 'workflow', 'assets', 'provenance'], '画布项目文件')
  if (raw.format !== 'xingmang-canvas-project' || raw.packageVersion !== canvasProjectPackageVersion || !safeString(raw.createdAt, 64) || !Number.isFinite(Date.parse(raw.createdAt))) throw new Error('画布项目版本不受支持')
  if (!Array.isArray(raw.assets) || raw.assets.length > maximumCanvasProjectAssets || !Array.isArray(raw.provenance)) throw new Error('画布项目资产清单错误')
  if (raw.provenance.length > 64) throw new Error('画布项目来源清单超出安全上限')
  for (const entry of raw.provenance) {
    if (!isRecord(entry)) throw new Error('画布项目来源信息格式错误')
    assertAllowedKeys(entry, ['name', 'license'], '画布项目来源信息')
    if (!safeString(entry.name, 256) || !safeString(entry.license, 128)) throw new Error('画布项目来源信息格式错误')
  }
  const workflowContent = JSON.stringify(raw.workflow)
  const parsed = parseCanvasProjectWorkflow(workflowContent)
  const referenced = new Set(parsed.assetIds)
  const assets: ParsedCanvasProjectPackage['assets'] = []
  const seen = new Set<string>()
  const warnings: string[] = []
  for (const entry of raw.assets) {
    if (!isRecord(entry)) throw new Error('画布项目资产格式错误')
    assertAllowedKeys(entry, ['assetId', 'mimeType', 'bytesBase64', 'sha256'], '画布项目资产')
    if (typeof entry.assetId !== 'string' || !assetIdPattern.test(entry.assetId) || seen.has(entry.assetId)) throw new Error('画布项目资产标识错误')
    seen.add(entry.assetId)
    if (!referenced.has(entry.assetId)) {
      warnings.push(`已忽略未被工作流引用的资产：${entry.assetId}`)
      continue
    }
    if ((entry.mimeType !== 'image/png' && entry.mimeType !== 'image/jpeg' && entry.mimeType !== 'image/webp') || typeof entry.bytesBase64 !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('画布项目资产元数据错误')
    if (entry.bytesBase64.length === 0 || entry.bytesBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.bytesBase64)) throw new Error('画布项目资产编码错误')
    const bytes = Buffer.from(entry.bytesBase64, 'base64')
    if (bytes.length === 0 || bytes.length > maximumAssetBytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('画布项目资产完整性校验失败')
    inspectAiImage(bytes, entry.mimeType)
    assets.push({ assetId: entry.assetId, mimeType: entry.mimeType, bytes })
  }
  for (const assetId of referenced) {
    if (!seen.has(assetId)) warnings.push(`项目不含资产 ${assetId}，将尝试匹配本地资产`)
  }
  return { workflow: parsed.workflow, assets, warnings }
}

function remapValue(value: unknown, mappings: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapValue(entry, mappings))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'assetId' || key === 'adoptedAssetId') && typeof entry === 'string') {
      result[key] = mappings.get(entry) ?? entry
    } else if (key === 'candidateAssetIds' && Array.isArray(entry)) {
      result[key] = entry.map((assetId) => typeof assetId === 'string' ? mappings.get(assetId) ?? assetId : assetId)
    } else if (key === 'localUrl' && typeof entry === 'string') {
      const match = entry.match(/^xingmang-asset:\/\/(image|video|audio)\/([A-Za-z0-9_-]{43})$/)
      result[key] = match && mappings.has(match[2]) ? `xingmang-asset://${match[1]}/${mappings.get(match[2])}` : entry
    } else {
      result[key] = remapValue(entry, mappings)
    }
  }
  return result
}

export function remapCanvasProjectWorkflow(workflow: Record<string, unknown>, mappings: ReadonlyMap<string, string>): string {
  return JSON.stringify(remapValue(workflow, mappings))
}

export function createCanvasProjectPreviewId(): string {
  return randomUUID()
}
