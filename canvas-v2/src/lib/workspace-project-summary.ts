// 工作区工程摘要的形状和它的回执校验，画布内核建工程、导入恢复都要用；工程列表的查询和站点地址留在 project-library、project-library-model（#3）。
import type { CanvasStoredProjectSummary } from '../host'

export type WorkspaceProjectSummary = CanvasStoredProjectSummary & { version: number }

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string' }

export function isWorkspaceProjectSummary(value: unknown): value is WorkspaceProjectSummary {
  return object(value) && typeof value.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 256 && count(value.version) && value.version > 0
    && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' && typeof value.lastOpenedAt === 'string'
    && (value.nodeCount === null || count(value.nodeCount)) && (value.assetCount === null || count(value.assetCount))
    && (value.summaryStatus === undefined || ['ready', 'unavailable'].includes(String(value.summaryStatus)))
    && (value.metadataVersion === undefined || count(value.metadataVersion))
    && (value.categoryId === undefined || typeof value.categoryId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.categoryId))
    && (value.cover === undefined || object(value.cover) && typeof value.cover.assetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.cover.assetId)
      && typeof value.cover.positionX === 'number' && value.cover.positionX >= 0 && value.cover.positionX <= 1
      && typeof value.cover.positionY === 'number' && value.cover.positionY >= 0 && value.cover.positionY <= 1
      && typeof value.cover.zoom === 'number' && value.cover.zoom >= 1 && value.cover.zoom <= 5)
    && typeof value.workspaceConfigured === 'boolean' && ['ready', 'missing', 'legacy'].includes(String(value.workspaceStatus))
    && optionalText(value.archivedAt) && (value.previewAsset === undefined || (object(value.previewAsset)
      && ['image', 'video', 'audio'].includes(String(value.previewAsset.kind)) && typeof value.previewAsset.assetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.previewAsset.assetId) && typeof value.previewAsset.localUrl === 'string'))
}

export function isProjectCreationResponse(value: unknown): value is { project: WorkspaceProjectSummary; content: string } {
  return object(value) && isWorkspaceProjectSummary(value.project) && typeof value.content === 'string'
}
