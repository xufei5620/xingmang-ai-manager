import { collectWorkflowColorLutSources } from './workflow-color-lut-resources'
import { parseColorLutResourceDescriptor, type ColorLutResourceDescriptor } from './color-lut-resource-contract'
import { projectMediaReferenceKinds } from './project-media-reference-kinds'
import { parseProjectImport, workflowAssetReferences } from './workflow-import'
import { buildProjectPackageExportPreflight } from './project-package-export'
import { parseProjectProvenance } from './project-provenance'
import { isProjectMediaFileName, projectMediaTypeForMime } from './project-media-validation'

export interface ProjectExportProvenance { name: string; license: string; notice?: string }
export type ProjectExportMediaType = 'image' | 'video' | 'audio' | 'unknown'
export type ProjectExportAssetStatus = 'ready' | 'trash' | 'missing' | 'unsupported'
export interface ProjectExportAsset {
  assetId: string
  mimeType: string | null
  mediaType: ProjectExportMediaType
  fileName: string | null
  width?: number
  height?: number
  byteSize?: number
  durationSeconds?: number
  status: ProjectExportAssetStatus
  nodeIds: string[]
}
export interface ProjectExportColorLutAsset { assetId: string; nodeIds: string[]; status: ProjectExportAssetStatus; descriptor?: ColorLutResourceDescriptor }
export interface ProjectExportMediaCounts { image: number; video: number; audio: number }
export interface ProjectExportPackagePreflight {
  assetCount?: number
  assetBytes?: number
  mediaCounts?: ProjectExportMediaCounts
  canEmbedAssets?: boolean
  canEmbedImages: boolean
  readyImageCount: number
  embeddedImageBytes: number
  estimatedPackageBytes: number
  blockingReasons: string[]
}
export interface ProjectExportManifest {
  schemaVersion: 1
  projectId: string
  createdAt: string
  content: string
  name: string
  nodeCount: number
  edgeCount: number
  provenance: ProjectExportProvenance[]
  assets: ProjectExportAsset[]
  colorLuts?: ProjectExportColorLutAsset[]
  warnings: string[]
  packagePreflight: ProjectExportPackagePreflight
}
export interface ProjectExportPreview {
  assetCount?: number
  assetBytes?: number
  mediaCounts?: ProjectExportMediaCounts
  canEmbedAssets?: boolean
  embeddedAssets?: Array<{ assetId: string; mediaType: 'image' | 'video' | 'audio'; fileName?: string; nodeIds: string[]; nodeTitles?: string[]; byteSize: number }>
  previewId: string
  fileName: string
  name: string
  nodeCount: number
  edgeCount: number
  imageCount: number
  imageBytes: number
  externalReferenceCount: number
  externalReferences: Array<{ assetId: string; status: ProjectExportAssetStatus; mediaType: ProjectExportMediaType; nodeIds: string[]; fileName?: string; nodeTitles?: string[] }>
  estimatedPackageBytes: number
  warnings: string[]
  canEmbedImages: boolean
  blockingReasons: string[]
}
export interface ProjectExportProgress { completed: number; total: number; bytesRead: number; totalBytes: number }
export interface ProjectExportResult { fileName: string; byteSize: number; embeddedAssetCount: number; externalReferenceCount: number; warnings: string[] }

export const maximumProjectExportManifestBytes = 8 * 1024 * 1024
export const projectExportAssetIdPattern = /^[A-Za-z0-9_-]{43}$/
export const projectExportProjectIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, maximum: number, empty = false): value is string { return typeof value === 'string' && (empty || value.length > 0) && value.length <= maximum && !value.includes('\0') }
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('导出清单包含无法核对的字段，请重新预检') }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function messages(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 64 && value.every((entry) => text(entry, 8000, true)) }
export function isProjectExportImageMimeType(value: unknown): value is 'image/png' | 'image/jpeg' | 'image/webp' { return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' }

export function parseProjectExportProvenance(value: unknown): ProjectExportProvenance[] {
  if (!Array.isArray(value)) throw new Error('导出来源清单无效')
  return parseProjectProvenance(value)
}

/** A manifest describes exactly the captured graph; it cannot introduce files. */
export function parseProjectExportManifest(value: unknown, expected: { projectId: string; content: string }): ProjectExportManifest {
  if (!object(value)) throw new Error('导出预检结果无法读取，请重试')
  keys(value, ['schemaVersion', 'projectId', 'createdAt', 'content', 'name', 'nodeCount', 'edgeCount', 'provenance', 'assets', 'colorLuts', 'warnings', 'packagePreflight'])
  const parsed = parseProjectImport(expected.content)
  const references = workflowAssetReferences(parsed.workflow)
  const kinds = projectMediaReferenceKinds(parsed.workflow)
  const lutSources = collectWorkflowColorLutSources(parsed.workflow)
  const lutIds = new Set(lutSources.map((source) => source.lutAssetId))
  if (!projectExportProjectIdPattern.test(expected.projectId) || value.schemaVersion !== 1 || value.projectId !== expected.projectId
    || value.content !== parsed.content || value.name !== parsed.workflow.name || value.nodeCount !== parsed.workflow.nodes.length || value.edgeCount !== parsed.workflow.edges.length
    || typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || !Array.isArray(value.assets) || value.assets.length !== references.size - lutIds.size || !messages(value.warnings)) throw new Error('导出预检与原工程快照不一致，请重新预检')
  const seen = new Set<string>()
  const assets: ProjectExportAsset[] = value.assets.map((entry) => {
    if (!object(entry)) throw new Error('导出素材清单无效')
    keys(entry, ['assetId', 'mimeType', 'mediaType', 'fileName', 'width', 'height', 'durationSeconds', 'byteSize', 'status', 'nodeIds'])
    const nodes = typeof entry.assetId === 'string' ? references.get(entry.assetId) : undefined
    if (typeof entry.assetId !== 'string' || !projectExportAssetIdPattern.test(entry.assetId) || seen.has(entry.assetId) || !nodes || lutIds.has(entry.assetId)
      || typeof entry.mediaType !== 'string' || !['image', 'video', 'audio', 'unknown'].includes(entry.mediaType) || typeof entry.status !== 'string' || !['ready', 'trash', 'missing', 'unsupported'].includes(entry.status)
      || !(entry.mimeType === null || text(entry.mimeType, 128)) || !(entry.fileName === null || text(entry.fileName, 256))
      || (entry.width !== undefined && !positive(entry.width)) || (entry.height !== undefined && !positive(entry.height))
      || (entry.durationSeconds !== undefined && (typeof entry.durationSeconds !== 'number' || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds <= 0))
      || (entry.byteSize !== undefined && !positive(entry.byteSize)) || !Array.isArray(entry.nodeIds) || entry.nodeIds.length !== nodes.size
      || new Set(entry.nodeIds).size !== nodes.size || !entry.nodeIds.every((id) => typeof id === 'string' && nodes.has(id))) throw new Error('导出素材清单与原引用不一致，请重新预检')
    if (entry.mediaType === 'unknown' && (entry.mimeType !== null || entry.fileName !== null || entry.byteSize !== undefined || entry.width !== undefined || entry.height !== undefined || entry.durationSeconds !== undefined)) throw new Error('未知素材的导出信息无法确认')
    if (entry.status === 'ready' && (projectMediaTypeForMime(entry.mimeType) !== entry.mediaType || !positive(entry.byteSize)
      || (typeof entry.width === 'number' && entry.width > 16384) || (typeof entry.height === 'number' && entry.height > 16384)
      || (typeof entry.width === 'number' && typeof entry.height === 'number' && entry.width * entry.height > 32_000_000) || entry.fileName === null || !isProjectMediaFileName(entry.fileName) || entry.mediaType === 'audio' && (entry.width !== undefined || entry.height !== undefined))) throw new Error('可携带素材的类型、大小或尺寸无法确认')
    if (entry.status === 'ready' && [...kinds.get(entry.assetId) ?? []].some((kind) => kind !== entry.mediaType)) throw new Error('同一素材编号的媒介类型不一致，请修正素材引用后再导出')
    seen.add(entry.assetId)
    return { assetId: entry.assetId, mimeType: entry.mimeType, mediaType: entry.mediaType as ProjectExportMediaType, fileName: entry.fileName,
      ...(typeof entry.width === 'number' ? { width: entry.width } : {}), ...(typeof entry.height === 'number' ? { height: entry.height } : {}), ...(typeof entry.byteSize === 'number' ? { byteSize: entry.byteSize } : {}),
      ...(typeof entry.durationSeconds === 'number' ? { durationSeconds: entry.durationSeconds } : {}),
      status: entry.status as ProjectExportAssetStatus, nodeIds: [...nodes] }
  })
  if (value.colorLuts !== undefined && !Array.isArray(value.colorLuts) || lutSources.length && !Array.isArray(value.colorLuts)) throw new Error('导出清单缺少自定义调色资源')
  const colorLuts: ProjectExportColorLutAsset[] = []
  const lutSeen = new Set<string>()
  for (const raw of value.colorLuts ?? []) {
    if (!object(raw)) throw new Error('调色资源导出清单无效')
    keys(raw, ['assetId', 'nodeIds', 'status', 'descriptor'])
    const source = lutSources.find((source) => source.lutAssetId === raw.assetId), nodes = typeof raw.assetId === 'string' ? references.get(raw.assetId) : undefined
    if (!source || !nodes || lutSeen.has(source.lutAssetId) || !['ready', 'trash', 'missing', 'unsupported'].includes(String(raw.status)) || !Array.isArray(raw.nodeIds) || raw.nodeIds.length !== nodes.size || new Set(raw.nodeIds).size !== nodes.size || !raw.nodeIds.every((id) => typeof id === 'string' && nodes.has(id)) || kinds.has(source.lutAssetId)) throw new Error('调色资源导出清单与工程引用不一致')
    const descriptor = raw.descriptor === undefined ? undefined : parseColorLutResourceDescriptor(raw.descriptor)
    if (raw.status === 'ready' && !descriptor || descriptor && (descriptor.assetId !== source.lutAssetId || descriptor.digest !== source.digest || descriptor.name !== source.name || JSON.stringify(descriptor.domainMin) !== JSON.stringify(source.domainMin) || JSON.stringify(descriptor.domainMax) !== JSON.stringify(source.domainMax))) throw new Error('调色资源身份与工程设置不一致')
    colorLuts.push({ assetId: source.lutAssetId, nodeIds: [...nodes], status: raw.status as ProjectExportAssetStatus, ...(descriptor ? { descriptor } : {}) }); lutSeen.add(source.lutAssetId)
  }
  if (lutSeen.size !== lutIds.size) throw new Error('导出清单缺少自定义调色资源')
  const provenance = parseProjectExportProvenance(value.provenance)
  const preflight = buildProjectPackageExportPreflight({ content: parsed.content, createdAt: value.createdAt, provenance, assets, colorLuts })
  if (!object(value.packagePreflight)) throw new Error('导出容量预检无法确认')
  keys(value.packagePreflight, ['canEmbedImages', 'readyImageCount', 'embeddedImageBytes', 'estimatedPackageBytes', 'blockingReasons', 'assetCount', 'assetBytes', 'mediaCounts', 'canEmbedAssets'])
  const provided = value.packagePreflight
  for (const key of ['assetCount', 'assetBytes', 'mediaCounts', 'canEmbedAssets'] as const) if (provided[key] !== undefined && JSON.stringify(provided[key]) !== JSON.stringify(preflight[key])) throw new Error('导出媒体容量预检与素材清单不一致')
  if (provided.canEmbedImages !== preflight.canEmbedImages || provided.readyImageCount !== preflight.readyImageCount || provided.embeddedImageBytes !== preflight.embeddedImageBytes
    || provided.estimatedPackageBytes !== preflight.estimatedPackageBytes || !messages(provided.blockingReasons)
    || JSON.stringify(provided.blockingReasons) !== JSON.stringify(preflight.blockingReasons)) throw new Error('导出容量预检与素材清单不一致，请重新预检')
  return { schemaVersion: 1, projectId: expected.projectId, createdAt: value.createdAt, content: parsed.content, name: parsed.workflow.name,
    nodeCount: parsed.workflow.nodes.length, edgeCount: parsed.workflow.edges.length, assets, ...(colorLuts.length ? { colorLuts } : {}), provenance, warnings: [...value.warnings], packagePreflight: preflight }
}
