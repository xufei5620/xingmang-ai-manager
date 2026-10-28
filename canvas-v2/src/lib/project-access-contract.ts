export const projectAccessLimits = { requestBytes: 8192, responseBytes: 262144, queryCharacters: 100, pageSize: 24, maximumPageSize: 50 } as const
export type ProjectTeamPermission = 'view' | 'edit'
export interface ProjectAccessSnapshot {
  projectId: string; projectVersion: number; mode: 'owner' | ProjectTeamPermission; accessVersion: number
  canEdit: boolean; canRun: boolean; canExport: boolean; canManageShare: boolean; canRestore: boolean
  teamId?: string; teamName?: string; historyFromVersion?: number
}
export interface ProjectSharingGrant { teamId: string; teamName: string; permission: ProjectTeamPermission; version: number; sharedFromProjectVersion: number; revokedAt?: string }
export interface ProjectSharingDetails { access: ProjectAccessSnapshot; grant?: ProjectSharingGrant }
export type ProjectSharingAction = { operationId: string; projectId: string; expectedProjectVersion: number; expectedAccessVersion: number } & ({ action: 'grant'; teamId: string; permission: ProjectTeamPermission } | { action: 'revoke' })
export interface ProjectSharingReceipt { operationId: string; action: ProjectSharingAction['action']; projectId: string; projectVersion: number; accessVersion: number }
export type ProjectSharingOperation = { state: 'missing' } | { state: 'found'; receipt: ProjectSharingReceipt }
export interface TeamProjectSummary { id: string; name: string; version: number; nodeCount: number; edgeCount: number; createdAt: string; updatedAt: string; lastOpenedAt: string; access: ProjectAccessSnapshot }
export interface TeamProjectPage { items: TeamProjectSummary[]; total: number; offset: number; limit: number; query: string; teamId?: string }
export class ProjectAccessError extends Error {
  constructor(message: string, readonly status = 400, readonly code = status === 403 ? 'PROJECT_ACCESS_DENIED' : status === 409 ? 'PROJECT_ACCESS_CONFLICT' : 'PROJECT_ACCESS_INVALID') { super(message); this.name = 'ProjectAccessError' }
}
function record(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProjectAccessError('项目权限数据格式不正确'); return v as Record<string, unknown> }
function keys(v: Record<string, unknown>, allowed: readonly string[]) { if (Object.keys(v).some((k) => !allowed.includes(k))) throw new ProjectAccessError('项目权限数据包含不支持的字段') }
export function parseProjectAccessId(v: unknown): string { if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v)) throw new ProjectAccessError('项目编号不正确'); return v }
function uuid(v: unknown): string { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)) throw new ProjectAccessError('团队或操作编号不正确'); return v }
function integer(v: unknown, min = 1): number { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) >= Number.MAX_SAFE_INTEGER) throw new ProjectAccessError('项目权限版本或数量不正确'); return Number(v) }
function text(v: unknown, max = 256): string { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new ProjectAccessError('项目权限文字格式不正确'); return v }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') throw new ProjectAccessError('项目权限状态不正确'); return v }
function permission(v: unknown): ProjectTeamPermission { if (v !== 'view' && v !== 'edit') throw new ProjectAccessError('项目权限只能选择查看或编辑'); return v }
export function parseProjectSharingAction(raw: unknown): ProjectSharingAction {
  const v = record(raw); if (v.action !== 'grant' && v.action !== 'revoke') throw new ProjectAccessError('不支持此项目共享操作')
  keys(v, ['action', 'operationId', 'projectId', 'expectedProjectVersion', 'expectedAccessVersion', ...(v.action === 'grant' ? ['teamId', 'permission'] : [])])
  const base = { operationId: uuid(v.operationId), projectId: parseProjectAccessId(v.projectId), expectedProjectVersion: integer(v.expectedProjectVersion), expectedAccessVersion: integer(v.expectedAccessVersion, 0) }
  return v.action === 'grant' ? { ...base, action: 'grant', teamId: uuid(v.teamId), permission: permission(v.permission) } : { ...base, action: 'revoke' }
}
export function parseProjectAccessSnapshot(raw: unknown): ProjectAccessSnapshot {
  const v = record(raw); keys(v, ['projectId', 'projectVersion', 'mode', 'accessVersion', 'canEdit', 'canRun', 'canExport', 'canManageShare', 'canRestore', 'teamId', 'teamName', 'historyFromVersion'])
  if (v.mode !== 'owner' && v.mode !== 'view' && v.mode !== 'edit') throw new ProjectAccessError('项目访问模式不正确')
  const result: ProjectAccessSnapshot = { projectId: parseProjectAccessId(v.projectId), projectVersion: integer(v.projectVersion), mode: v.mode, accessVersion: integer(v.accessVersion, 0), canEdit: bool(v.canEdit), canRun: bool(v.canRun), canExport: bool(v.canExport), canManageShare: bool(v.canManageShare), canRestore: bool(v.canRestore), ...(v.teamId === undefined ? {} : { teamId: uuid(v.teamId), teamName: text(v.teamName, 80) }), ...(v.historyFromVersion === undefined ? {} : { historyFromVersion: integer(v.historyFromVersion) }) }
  if ((v.teamId === undefined) !== (v.teamName === undefined) || !result.canExport || result.canEdit !== (result.mode !== 'view') || result.canRun !== (result.mode === 'owner') || result.canManageShare !== (result.mode === 'owner') || result.canRestore !== (result.mode === 'owner') || (result.mode !== 'owner' && (!result.teamId || !result.historyFromVersion || result.accessVersion < 1))) throw new ProjectAccessError('项目权限回执不一致')
  return result
}
export function parseProjectSharingDetails(raw: unknown): ProjectSharingDetails {
  const v = record(raw); keys(v, ['access', 'grant']); const access = parseProjectAccessSnapshot(v.access)
  if (v.grant === undefined) return { access }
  const g = record(v.grant); keys(g, ['teamId', 'teamName', 'permission', 'version', 'sharedFromProjectVersion', 'revokedAt'])
  const grant: ProjectSharingGrant = { teamId: uuid(g.teamId), teamName: text(g.teamName, 80), permission: permission(g.permission), version: integer(g.version), sharedFromProjectVersion: integer(g.sharedFromProjectVersion), ...(g.revokedAt === undefined ? {} : { revokedAt: text(g.revokedAt, 40) }) }
  if (grant.version !== access.accessVersion) throw new ProjectAccessError('项目共享回执版本不一致')
  return { access, grant }
}
export function parseProjectSharingReceipt(raw: unknown): ProjectSharingReceipt {
  const v = record(raw); keys(v, ['operationId', 'action', 'projectId', 'projectVersion', 'accessVersion']); if (v.action !== 'grant' && v.action !== 'revoke') throw new ProjectAccessError('项目共享操作回执不正确')
  return { operationId: uuid(v.operationId), action: v.action, projectId: parseProjectAccessId(v.projectId), projectVersion: integer(v.projectVersion), accessVersion: integer(v.accessVersion) }
}
export function parseProjectSharingOperation(raw: unknown): ProjectSharingOperation { const v = record(raw); if (v.state === 'missing') { keys(v, ['state']); return { state: 'missing' } } if (v.state === 'found') { keys(v, ['state', 'receipt']); return { state: 'found', receipt: parseProjectSharingReceipt(v.receipt) } } throw new ProjectAccessError('项目共享原操作回执不正确') }
export function parseTeamProjectPage(raw: unknown): TeamProjectPage {
  const v = record(raw); keys(v, ['items', 'total', 'offset', 'limit', 'query', 'teamId'])
  if (!Array.isArray(v.items) || v.items.length > projectAccessLimits.maximumPageSize || typeof v.query !== 'string' || v.query.length > projectAccessLimits.queryCharacters) throw new ProjectAccessError('团队项目列表不正确')
  const items = v.items.map((raw): TeamProjectSummary => { const p = record(raw); keys(p, ['id', 'name', 'version', 'nodeCount', 'edgeCount', 'createdAt', 'updatedAt', 'lastOpenedAt', 'access']); const access = parseProjectAccessSnapshot(p.access); const id = parseProjectAccessId(p.id), version = integer(p.version); if (access.projectId !== id || access.projectVersion !== version) throw new ProjectAccessError('团队项目列表版本不一致'); return { id, name: text(p.name), version, nodeCount: integer(p.nodeCount, 0), edgeCount: integer(p.edgeCount, 0), createdAt: text(p.createdAt, 40), updatedAt: text(p.updatedAt, 40), lastOpenedAt: text(p.lastOpenedAt, 40), access } })
  const result = { items, total: integer(v.total, 0), offset: integer(v.offset, 0), limit: integer(v.limit), query: v.query, ...(v.teamId === undefined ? {} : { teamId: uuid(v.teamId) }) }
  if (result.limit > projectAccessLimits.maximumPageSize || items.length > result.limit || new Set(items.map((p) => p.id)).size !== items.length) throw new ProjectAccessError('团队项目分页不正确')
  return result
}
