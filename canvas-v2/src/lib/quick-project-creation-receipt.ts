// 建工程回执的核对，快速创作和画布内核的空白工程共用；快速创作本身（模型、草稿、提交记录）留在 quick-project-creation-model（#3）。
import { isWorkspaceProjectSummary, type WorkspaceProjectSummary } from './workspace-project-summary'

export type QuickProjectCreationReceipt = { state: 'missing' } | { state: 'confirmed'; project: WorkspaceProjectSummary }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

export function copyProject(value: unknown, operationId: string): WorkspaceProjectSummary {
  if (!isWorkspaceProjectSummary(value) || value.id !== operationId) throw new Error('原工程回执编号或资料不一致，请继续核对原操作；当前不会创建其他工程。')
  return {
    id: value.id, name: value.name, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt, lastOpenedAt: value.lastOpenedAt,
    nodeCount: value.nodeCount, assetCount: value.assetCount, workspaceConfigured: value.workspaceConfigured, workspaceStatus: value.workspaceStatus,
    ...(value.summaryStatus ? { summaryStatus: value.summaryStatus } : {}), ...(value.workspaceName ? { workspaceName: value.workspaceName } : {}),
    ...(value.previewAsset ? { previewAsset: { ...value.previewAsset } } : {}), ...(value.archivedAt ? { archivedAt: value.archivedAt } : {}),
  }
}

export function parseQuickProjectCreationReceipt(value: unknown, operationId: string): QuickProjectCreationReceipt {
  if (typeof operationId !== 'string' || !uuidPattern.test(operationId) || !object(value)) throw new Error('原工程核对回执无法确认，请保留原操作；当前不会重新创建。')
  if (value.state === 'missing' && Object.keys(value).length === 1) return { state: 'missing' }
  if (value.state === 'confirmed' && Object.keys(value).length === 2 && 'project' in value) return { state: 'confirmed', project: copyProject(value.project, operationId) }
  throw new Error('原工程核对回执无法确认，请保留原操作；当前不会重新创建。')
}
