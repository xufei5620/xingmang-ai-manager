import type { ProjectExportPreview, ProjectExportProgress } from './project-export-contract'
import { projectImportBytes, projectMediaCounts, projectPackageFiles, validProjectNodeTitles, type ProjectMediaCounts, type ProjectPackageFile } from './project-import-model'

export interface ProjectExportPresentation {
  nodeCount: number
  edgeCount: number
  imageCount: number
  imageSize: string
  assetCount: number
  assetSize: string
  mediaCounts: ProjectMediaCounts | null
  embeddedAssets: ProjectPackageFile[]
  estimatedSize: string
  externalCount: number
  externalReferences: ProjectExportPreview['externalReferences']
  warnings: string[]
  additionalWarnings: number
  blockingReasons: string[]
  canExport: boolean
  needsExternalConsent: boolean
}

function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

export function buildProjectExportPresentation(preview: ProjectExportPreview): ProjectExportPresentation {
  if (![preview.nodeCount, preview.edgeCount, preview.imageCount, preview.imageBytes, preview.externalReferenceCount, preview.estimatedPackageBytes].every(count)
    || !Array.isArray(preview.warnings) || !preview.warnings.every((warning) => typeof warning === 'string')
    || !Array.isArray(preview.blockingReasons) || !preview.blockingReasons.every((reason) => typeof reason === 'string' && reason.length > 0)
    || typeof preview.canEmbedImages !== 'boolean'
    || preview.assetCount !== undefined && !count(preview.assetCount)
    || preview.assetBytes !== undefined && !count(preview.assetBytes)
    || preview.canEmbedAssets !== undefined && typeof preview.canEmbedAssets !== 'boolean'
    || !Array.isArray(preview.externalReferences) || preview.externalReferences.length !== preview.externalReferenceCount
    || !preview.externalReferences.every((asset) => /^[A-Za-z0-9_-]{43}$/.test(asset.assetId) && ['ready', 'trash', 'missing', 'unsupported'].includes(asset.status)
      && ['image', 'video', 'audio', 'unknown'].includes(asset.mediaType) && Array.isArray(asset.nodeIds) && asset.nodeIds.every((id) => typeof id === 'string' && id.length > 0)
      && validProjectNodeTitles(asset.nodeTitles, asset.nodeIds.length)
      && (asset.fileName === undefined || typeof asset.fileName === 'string' && asset.fileName.trim().length > 0 && asset.fileName.length <= 256 && !/[\u0000-\u001f\u007f]/.test(asset.fileName)))
    || new Set(preview.externalReferences.map((asset) => asset.assetId)).size !== preview.externalReferenceCount) throw new Error('项目导出预检资料不完整，请关闭后重新预检；尚未请求下载。')
  const assetCount = preview.assetCount ?? preview.imageCount
  const assetBytes = preview.assetBytes ?? preview.imageBytes
  const mediaCounts = projectMediaCounts(preview.mediaCounts, assetCount) ?? (preview.assetCount === undefined ? { image: preview.imageCount, video: 0, audio: 0 } : null)
  if (assetCount < preview.imageCount || assetBytes < preview.imageBytes || mediaCounts && mediaCounts.image !== preview.imageCount) throw new Error('项目导出预检资料不完整，素材统计不一致；请重新预检。')
  return {
    nodeCount: preview.nodeCount, edgeCount: preview.edgeCount, imageCount: preview.imageCount,
    imageSize: projectImportBytes(preview.imageBytes), estimatedSize: projectImportBytes(preview.estimatedPackageBytes),
    assetCount, assetSize: projectImportBytes(assetBytes), mediaCounts,
    embeddedAssets: projectPackageFiles(preview.embeddedAssets, assetCount, assetBytes, mediaCounts),
    externalCount: preview.externalReferenceCount, externalReferences: preview.externalReferences.slice(0, 100),
    warnings: preview.warnings.slice(0, 20), additionalWarnings: Math.max(0, preview.warnings.length - 20),
    blockingReasons: preview.blockingReasons, canExport: (preview.canEmbedAssets ?? preview.canEmbedImages) && preview.blockingReasons.length === 0,
    needsExternalConsent: preview.externalReferenceCount > 0,
  }
}

export function projectExportProgressLabel(progress?: ProjectExportProgress): string | null {
  if (!progress || ![progress.completed, progress.total, progress.bytesRead, progress.totalBytes].every(count)
    || progress.completed > progress.total || progress.bytesRead > progress.totalBytes) return null
  return `已读取 ${progress.completed} / ${progress.total} 项素材 · ${projectImportBytes(progress.bytesRead)} / ${projectImportBytes(progress.totalBytes)}`
}

export function projectExportReferenceLabel(status: string, mediaType: string): string {
  const type = mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : mediaType === 'audio' ? '音频' : '素材'
  if (status === 'trash') return `${type}在回收站中`
  if (status === 'missing') return `${type}不可读取`
  if (status === 'unsupported') return `${type}暂不支持携入`
  return `${type}文件未携带`
}

export function projectExportAccountChanged(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ACCOUNT_CHANGED'
}

export function projectExportFailureMessage(error: unknown): string {
  if (projectExportAccountChanged(error)) return '账户已经变化，项目包导出已停止。请重新进入工作区；不会继续读取原账户素材或触发下载。'
  return error instanceof Error && error.message ? error.message : '导出结果尚未确认，请保留当前画布并手动核对；没有自动重复下载。'
}
