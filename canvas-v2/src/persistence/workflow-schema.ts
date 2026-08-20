import type { AssetRef, WorkflowEdge, WorkflowFile, WorkflowNode } from '../model'

export const workflowSchemaVersion = 2 as const
export const maximumWorkflowBytes = 20 * 1024 * 1024
export const maximumWorkflowNodes = 5_000
export const maximumWorkflowEdges = 20_000
export const maximumWorkflowNameLength = 256
export const maximumNodeIdLength = 256
export const maximumNodeKindLength = 128
export const maximumPromptLength = 100_000
export const maximumModelLength = 512
export const maximumGroupNameLength = 128
export const maximumOptionLength = 128
export const maximumTaskIdLength = 512
export const maximumCoordinateMagnitude = 10_000_000
export const maximumGenerationDurationMs = 86_400_000

export interface PersistedAssetRefV2 {
  kind: 'image' | 'video' | 'audio'
  assetId?: string
  localUrl?: string
  mimeType?: string
  width?: number
  height?: number
  durationSeconds?: number
  taskId?: string
}

export interface PersistedWorkflowNodeV2 {
  id: string
  kind: string
  definitionVersion: number
  disabled?: boolean
  parentId?: string
  width?: number
  height?: number
  locked?: boolean
  position: { x: number; y: number }
  data: {
    prompt: string
    model: string
    group?: string
    quality?: string
    size?: string
    imageResolution?: '1K' | '2K' | '4K'
    seconds?: string
    result?: PersistedAssetRefV2
    settings?: Record<string, unknown>
    candidateAssetIds?: string[]
    /** 旧文件可能还带着；新保存不再写入，加载时也不恢复到节点上。 */
    latestAttemptDurationMs?: number
  }
}

export interface PersistedWorkflowV2 {
  schemaVersion: typeof workflowSchemaVersion
  name: string
  viewport?: { x: number; y: number; zoom: number }
  mediaGroups?: {
    image?: string
    video?: string
  }
  nodes: PersistedWorkflowNodeV2[]
  edges: WorkflowEdge[]
}

export interface WorkflowParseResult {
  workflow: WorkflowFile
  warnings: string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function safeString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.includes('\0')) return null
  return value
}

export function optionalSafeString(value: unknown, maximumLength: number): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximumLength || value.includes('\0')) return null
  return value || undefined
}

export function finiteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximumCoordinateMagnitude
}

export function stableAssetId(value: unknown): string | null {
  // AiAssetStore owns 32 random bytes encoded as base64url: exactly 43 chars.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}

export function localAssetUrl(kind: AssetRef['kind'], assetId: string): string {
  return `xingmang-asset://${kind}/${assetId}`
}

export function persistedDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximumGenerationDurationMs) return undefined
  return Math.round(value)
}

export function toPersistedWorkflowV2(workflow: WorkflowFile): PersistedWorkflowV2 {
  const nodes: PersistedWorkflowNodeV2[] = workflow.nodes.map((node: WorkflowNode) => {
    const result = persistedAsset(node.data.result)
    const settings = persistedSettings(node.data.settings)
    const group = optionalSafeString(node.data.group, maximumGroupNameLength)
    const candidateAssetIds = node.data.candidateAssetIds?.filter((assetId) => stableAssetId(assetId)).slice(0, 16)
    return {
      id: node.id,
      kind: node.unknownKind ?? node.kind,
      definitionVersion: node.definitionVersion ?? 1,
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(Number.isFinite(node.width) && (node.width as number) > 0 ? { width: node.width } : {}),
      ...(Number.isFinite(node.height) && (node.height as number) > 0 ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      position: { x: node.position.x, y: node.position.y },
      data: {
        prompt: node.data.prompt,
        model: node.data.model,
        ...(group ? { group } : {}),
        ...(node.data.quality ? { quality: node.data.quality } : {}),
        ...(node.data.size ? { size: node.data.size } : {}),
        ...(node.data.imageResolution ? { imageResolution: node.data.imageResolution } : {}),
        ...(node.data.seconds ? { seconds: node.data.seconds } : {}),
        ...(result ? { result } : {}),
        ...(settings ? { settings } : {}),
        ...(candidateAssetIds?.length ? { candidateAssetIds } : {}),
      },
    }
  })
  const mediaGroups = persistedMediaGroups(workflow.mediaGroups)
  return {
    schemaVersion: workflowSchemaVersion,
    name: workflow.name,
    ...(workflow.viewport ? { viewport: { ...workflow.viewport } } : {}),
    ...(mediaGroups ? { mediaGroups } : {}),
    nodes,
    edges: workflow.edges.map((edge) => ({ ...edge })),
  }
}

function persistedMediaGroups(mediaGroups: WorkflowFile['mediaGroups']): WorkflowFile['mediaGroups'] | undefined {
  if (!mediaGroups) return undefined
  const image = optionalSafeString(mediaGroups.image, maximumGroupNameLength)
  const video = optionalSafeString(mediaGroups.video, maximumGroupNameLength)
  if (image === null || video === null || (!image && !video)) return undefined
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
  }
}

const forbiddenSettingKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const unsafeSettingString = /^(?:[a-zA-Z]:[\\/]|\\\\|\/|[a-z][a-z0-9+.-]*:|data:)/i

function persistedSettingValue(value: unknown, depth: number): unknown {
  if (depth > 8) return undefined
  if (typeof value === 'string') return value.length <= 10_000 && !unsafeSettingString.test(value) ? value : undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => persistedSettingValue(entry, depth + 1)).filter((entry) => entry !== undefined)
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).slice(0, 256).flatMap(([key, child]) => {
    if (!key || key.length > 128 || forbiddenSettingKey.test(key)) return []
    const safe = persistedSettingValue(child, depth + 1)
    return safe === undefined ? [] : [[key, safe] as const]
  })
  return Object.fromEntries(entries)
}

export function persistedSettings(value: unknown): Record<string, unknown> | undefined {
  const safe = persistedSettingValue(value, 0)
  return isRecord(safe) && Object.keys(safe).length > 0 ? safe : undefined
}

function persistedAsset(asset: AssetRef | undefined): PersistedAssetRefV2 | undefined {
  if (!asset) return undefined
  const assetId = stableAssetId(asset.assetId)
  const taskId = optionalSafeString(asset.taskId, maximumTaskIdLength)
  if (taskId === null) return undefined
  if (!assetId && !taskId) return undefined
  return {
    kind: asset.kind,
    ...(assetId ? { assetId, localUrl: localAssetUrl(asset.kind, assetId) } : {}),
    ...(assetId && typeof asset.mimeType === 'string' && asset.mimeType.length <= 128 ? { mimeType: asset.mimeType } : {}),
    ...(assetId && Number.isInteger(asset.width) && (asset.width as number) > 0 ? { width: asset.width } : {}),
    ...(assetId && Number.isInteger(asset.height) && (asset.height as number) > 0 ? { height: asset.height } : {}),
    ...(assetId && typeof asset.durationSeconds === 'number' && Number.isFinite(asset.durationSeconds) && asset.durationSeconds > 0 && asset.durationSeconds <= 86_400
      ? { durationSeconds: asset.durationSeconds }
      : {}),
    ...(taskId ? { taskId } : {}),
  }
}
