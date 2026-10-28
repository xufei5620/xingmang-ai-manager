import type { CanvasProjectPreview } from '../host'
import { parseProjectProvenance, type ProjectProvenance } from './project-provenance'

export interface ProjectImportProgress {
  completed: number
  total: number
  bytesUploaded: number
}

export type ProjectImportPreview = CanvasProjectPreview & {
  embeddedAssetBytes?: number
  packageFileBytes?: number
  missingAssets?: Array<{ assetId: string; nodeIds: string[]; nodeTitles?: string[]; kinds?: Array<'image' | 'video' | 'audio'> }>
}

export interface ProjectImportPresentation {
  nodeCount: number
  edgeCount: number
  availableCount: number
  embeddedCount: number
  missingCount: number
  embeddedSize: string
  fileSize: string
  missingAssets: NonNullable<ProjectImportPreview['missingAssets']>
  warnings: string[]
  additionalWarnings: number
  provenance: ProjectProvenance[]
  mediaCounts: ProjectMediaCounts | null
  embeddedAssets: NonNullable<CanvasProjectPreview['embeddedAssets']>
}

function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

export interface ProjectMediaCounts { image: number; video: number; audio: number }

export function projectMediaCounts(value: unknown, total: number): ProjectMediaCounts | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('素材类型统计无法确认，请重新预检')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some((key) => !['image', 'video', 'audio'].includes(key)) || ![fields.image, fields.video, fields.audio].every(count)
    || Number(fields.image) + Number(fields.video) + Number(fields.audio) !== total) throw new Error('素材类型统计与文件数量不一致，请重新预检')
  return { image: Number(fields.image), video: Number(fields.video), audio: Number(fields.audio) }
}

export function projectAssetNodeLabel(asset: { nodeIds: string[]; nodeTitles?: string[] }): string {
  const names = asset.nodeTitles?.filter((title) => title.trim())
  if (names?.length) return `关联节点：${names.join('、')}${names.length < asset.nodeIds.length ? `（共 ${asset.nodeIds.length} 个节点）` : ''}`
  return `关联节点编号：${asset.nodeIds.join('、')}`
}

export function validProjectNodeTitles(value: unknown, maximum: number): boolean {
  return value === undefined || Array.isArray(value) && value.length <= maximum && value.every((title) => typeof title === 'string' && title.trim().length > 0 && title.length <= 256 && !title.includes('\0'))
}

export type ProjectPackageFile = NonNullable<CanvasProjectPreview['embeddedAssets']>[number]

function validProjectPackageFile(value: unknown): value is ProjectPackageFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const asset = value as Record<string, unknown>
  return typeof asset.assetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(asset.assetId)
    && typeof asset.mediaType === 'string' && ['image', 'video', 'audio'].includes(asset.mediaType)
    && count(asset.byteSize) && asset.byteSize > 0 && Array.isArray(asset.nodeIds) && asset.nodeIds.length > 0
    && asset.nodeIds.every((id) => typeof id === 'string' && id.length > 0)
    && validProjectNodeTitles(asset.nodeTitles, asset.nodeIds.length)
    && (asset.fileName === undefined || typeof asset.fileName === 'string' && asset.fileName.trim().length > 0 && asset.fileName.length <= 160 && !/[\u0000-\u001f\u007f]/.test(asset.fileName))
}

export function projectPackageFiles(value: unknown, total: number, bytes: number | undefined, mediaCounts: ProjectMediaCounts | null): ProjectPackageFile[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length !== total || value.length > 64 || !value.every(validProjectPackageFile)
    || new Set(value.map((asset) => asset.assetId)).size !== total
    || mediaCounts && (['image', 'video', 'audio'] as const).some((type) => value.filter((asset) => asset.mediaType === type).length !== mediaCounts[type])
    || bytes !== undefined && value.reduce((sum, asset) => sum + asset.byteSize, 0) !== bytes) throw new Error('包内素材清单与预检统计不一致，请重新预检；尚未迁入素材或请求下载。')
  return value
}

export function projectImportBytes(value?: number): string {
  if (!count(value)) return '大小待核对'
  if (value === 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

export function buildProjectImportPresentation(preview: ProjectImportPreview): ProjectImportPresentation {
  const missingCount = preview.missingAssetCount ?? preview.missingAssets?.length ?? 0
  const embeddedCount = preview.embeddedAssetCount ?? 0
  if (![preview.nodeCount, preview.edgeCount, preview.assetCount, missingCount, embeddedCount].every(count)
    || !Array.isArray(preview.warnings) || !preview.warnings.every((warning) => typeof warning === 'string')
    || preview.embeddedAssetBytes !== undefined && !count(preview.embeddedAssetBytes)
    || preview.packageFileBytes !== undefined && !count(preview.packageFileBytes)
    || preview.missingAssets !== undefined && (!Array.isArray(preview.missingAssets) || preview.missingAssets.length !== missingCount
      || !preview.missingAssets.every((item) => /^[A-Za-z0-9_-]{43}$/.test(item.assetId) && Array.isArray(item.nodeIds) && item.nodeIds.every((id) => typeof id === 'string' && id.length > 0) && validProjectNodeTitles(item.nodeTitles, item.nodeIds.length)))) throw new Error('项目预检资料不完整，请重新选择文件；尚未迁入素材或创建工程。')
  const mediaCounts = projectMediaCounts(preview.embeddedMediaCounts, embeddedCount)
  const embeddedAssets = projectPackageFiles(preview.embeddedAssets, embeddedCount, preview.embeddedAssetBytes, mediaCounts)
  return {
    nodeCount: preview.nodeCount, edgeCount: preview.edgeCount, availableCount: preview.assetCount, embeddedCount, missingCount,
    embeddedSize: projectImportBytes(preview.embeddedAssetBytes ?? (embeddedCount === 0 ? 0 : undefined)), fileSize: projectImportBytes(preview.packageFileBytes),
    missingAssets: preview.missingAssets?.slice(0, 100) ?? [], warnings: preview.warnings.slice(0, 20), additionalWarnings: Math.max(0, preview.warnings.length - 20),
    provenance: parseProjectProvenance(preview.provenance),
    mediaCounts, embeddedAssets,
  }
}

export function projectImportProgressLabel(progress?: ProjectImportProgress): string | null {
  if (!progress || ![progress.completed, progress.total, progress.bytesUploaded].every(count) || progress.completed > progress.total) return null
  return `已核对 ${progress.completed} / ${progress.total} 项素材 · 已上传 ${projectImportBytes(progress.bytesUploaded)}`
}

export function projectImportAccountChanged(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ACCOUNT_CHANGED'
}

export function projectImportFailureMessage(error: unknown): string {
  if (projectImportAccountChanged(error)) return '账户已经变化，此次导入已停止。请重新进入工作区核对素材和工程；不会向新账户继续上传。'
  return error instanceof Error && error.message ? error.message : '导入结果尚未确认，请继续核对同一次导入；不会自动重复创建工程。'
}

/** Tokens also distinguish closing and reopening an import in the same project. */
export function createProjectImportGuard() {
  let revision = 0
  let active = true
  let busy: number | null = null
  return {
    activate() { active = true },
    invalidate() { revision += 1 },
    dispose() { active = false; revision += 1; busy = null },
    begin() { if (!active || busy !== null) return null; revision += 1; busy = revision; return revision },
    current(token: number) { return active && token === revision },
    finish(token: number) { if (busy === token) busy = null },
    busy() { return busy !== null },
  }
}
