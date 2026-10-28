import { CanvasAgentError, canvasAgentDigestValue, canvasAgentId, canvasAgentKeys, canvasAgentRecord, canvasAgentText, canvasAgentVersion } from './canvas-agent-contract'
import { workshopPromptText } from './workshop-sanitizer'
import { parseCanvasAgentSkillRemotePreview, parseCanvasAgentSkillSource, type CanvasAgentSkillRemotePreview, type CanvasAgentSkillRemoteSource, type CanvasAgentSkillSource } from './canvas-agent-skill-import-contract'

export const canvasAgentSkillLimits = { titleCharacters: 100, descriptionCharacters: 1000, categoryCharacters: 60, resourceCount: 31, pathCharacters: 200, pathDepth: 5, fileBytes: 64 * 1024, draftBytes: 256 * 1024, selectedCount: 4, selectedCharacters: 16_000, queryCharacters: 100, maximumSkills: 500 } as const
export interface CanvasAgentSkillResource { path: string; content: string }
export interface CanvasAgentSkillDraft { title: string; description: string; category: string; skillMarkdown: string; resources: CanvasAgentSkillResource[] }
export interface CanvasAgentSkillSummary {
  id: string; version: number; title: string; description: string; category: string; contentDigest: string
  resourceCount: number; characterCount: number; enabled: boolean; favorite: boolean; createdAt: string; updatedAt: string; archivedAt?: string
  source?: CanvasAgentSkillSource
}
export interface CanvasAgentSkill extends CanvasAgentSkillSummary { skillMarkdown: string; resources: CanvasAgentSkillResource[] }
export interface CanvasAgentSkillReference { skillId: string; version: number; contentDigest: string; resourcePaths: string[] }
export interface CanvasAgentSkillSnapshot extends CanvasAgentSkillReference, CanvasAgentSkillDraft { characterCount: number; snapshotDigest: string }
export type CanvasAgentSkillReferenceSnapshot = CanvasAgentSkillSnapshot
export interface CanvasAgentSkillMethodMap {
  listSkills: { input: { query?: string; category?: string; archived?: boolean; favorites?: boolean; offset?: number; limit?: number }; result: { items: CanvasAgentSkillSummary[]; total: number; offset: number; limit: number; query: string; category: string; archived: boolean; favorites: boolean } }
  readSkill: { input: { skillId: string }; result: CanvasAgentSkill }
  createSkill: { input: { operationId: string; draft: CanvasAgentSkillDraft; importProof?: string; sourceClaim?: CanvasAgentSkillSource }; result: CanvasAgentSkill }
  updateSkill: { input: { skillId: string; operationId: string; expectedVersion: number; draft?: CanvasAgentSkillDraft; enabled?: boolean; favorite?: boolean; archived?: boolean }; result: CanvasAgentSkill }
  inspectSkillOperation: { input: { operationId: string }; result: { state: 'missing' } | { state: 'found'; skill: CanvasAgentSkill } }
  previewSkillReference: { input: CanvasAgentSkillReference; result: CanvasAgentSkillSnapshot }
  previewRemoteSkill: { input: { source: CanvasAgentSkillRemoteSource }; result: CanvasAgentSkillRemotePreview }
}
export type CanvasAgentSkillMethod = keyof CanvasAgentSkillMethodMap
export const canvasAgentSkillMethods: readonly CanvasAgentSkillMethod[] = ['listSkills', 'readSkill', 'createSkill', 'updateSkill', 'inspectSkillOperation', 'previewSkillReference', 'previewRemoteSkill']
export function isCanvasAgentSkillMethod(method: string): method is CanvasAgentSkillMethod { return canvasAgentSkillMethods.includes(method as CanvasAgentSkillMethod) }
export function parseCanvasAgentSkillResourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > canvasAgentSkillLimits.pathCharacters || value !== value.normalize('NFC') || /[\\:\x00-\x20\x7f?#%]/.test(value)) throw new CanvasAgentError('Skill 资源路径必须是规范相对文本路径')
  const parts = value.split('/')
  if (parts.length > canvasAgentSkillLimits.pathDepth || parts.some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith(' ')) || !/\.(?:md|txt|json|csv|yaml|yml)$/i.test(value) || value.toLowerCase() === 'skill.md') throw new CanvasAgentError('Skill 资源仅支持相对路径的 md/txt/json/csv/yaml/yml 文本，不能覆盖 SKILL.md')
  return value
}
function rawText(value: unknown, label: string, empty = true): string {
  if (typeof value !== 'string' || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) || new TextEncoder().encode(value).length > canvasAgentSkillLimits.fileBytes) throw new CanvasAgentError(`${label}必须为有效 UTF-8 文本，每文件不超过 64 KiB`)
  if (workshopPromptText(value, label, 1_000_000, true) !== value) throw new CanvasAgentError(`${label}包含疑似密钥或凭据，请移除后保存；不会自动删改正文`)
  return value
}
export function parseCanvasAgentSkillDraft(value: unknown): CanvasAgentSkillDraft {
  const item = canvasAgentRecord(value, 'Skill 资源包'); canvasAgentKeys(item, ['title', 'description', 'category', 'skillMarkdown', 'resources'])
  if (!Array.isArray(item.resources) || item.resources.length > canvasAgentSkillLimits.resourceCount) throw new CanvasAgentError('Skill 最多附加 31 个文本资源')
  const resources = item.resources.map((entry) => { const file = canvasAgentRecord(entry, 'Skill 资源'); canvasAgentKeys(file, ['path', 'content']); return { path: parseCanvasAgentSkillResourcePath(file.path), content: rawText(file.content, '资源正文') } })
  if (new Set(resources.map((file) => file.path.toLowerCase())).size !== resources.length) throw new CanvasAgentError('Skill 资源路径重复或大小写冲突')
  const draft = { title: canvasAgentText(item.title, 'Skill 名称', canvasAgentSkillLimits.titleCharacters), description: canvasAgentText(item.description, 'Skill 描述', canvasAgentSkillLimits.descriptionCharacters, true), category: canvasAgentText(item.category, 'Skill 分类', canvasAgentSkillLimits.categoryCharacters, true), skillMarkdown: rawText(item.skillMarkdown, 'SKILL.md', false), resources }
  for (const text of [draft.title, draft.description, draft.category]) if (workshopPromptText(text, 'Skill 元信息', 1_000_000, true) !== text) throw new CanvasAgentError('Skill 元信息包含疑似凭据，请移除后保存')
  if (new TextEncoder().encode(JSON.stringify(draft)).length > canvasAgentSkillLimits.draftBytes) throw new CanvasAgentError('Skill 资源包超过 256 KiB，不能截断导入', 413)
  return draft
}
export function parseCanvasAgentSkillReferences(value: unknown): CanvasAgentSkillReference[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > canvasAgentSkillLimits.selectedCount) throw new CanvasAgentError('每次最多选择 4 个 Skill')
  const result = value.map((entry) => { const item = canvasAgentRecord(entry, 'Skill 引用'); canvasAgentKeys(item, ['skillId', 'version', 'contentDigest', 'resourcePaths'])
    if (!Array.isArray(item.resourcePaths) || item.resourcePaths.length > canvasAgentSkillLimits.resourceCount) throw new CanvasAgentError('Skill 资源选择格式不正确')
    const resourcePaths = item.resourcePaths.map(parseCanvasAgentSkillResourcePath)
    if (new Set(resourcePaths.map((path) => path.toLowerCase())).size !== resourcePaths.length) throw new CanvasAgentError('不能重复选择 Skill 资源')
    return { skillId: canvasAgentId(item.skillId), version: canvasAgentVersion(item.version), contentDigest: canvasAgentDigestValue(item.contentDigest), resourcePaths }
  })
  if (new Set(result.map((entry) => entry.skillId)).size !== result.length) throw new CanvasAgentError('不能重复选择同一 Skill')
  return result.length ? result : undefined
}
export function parseCanvasAgentSkillSnapshot(value: unknown): CanvasAgentSkillSnapshot {
  const item = canvasAgentRecord(value, 'Skill 快照'); canvasAgentKeys(item, ['skillId', 'version', 'contentDigest', 'resourcePaths', 'title', 'description', 'category', 'skillMarkdown', 'resources', 'characterCount', 'snapshotDigest'])
  const reference = parseCanvasAgentSkillReferences([{ skillId: item.skillId, version: item.version, contentDigest: item.contentDigest, resourcePaths: item.resourcePaths }])![0]
  const draft = parseCanvasAgentSkillDraft({ title: item.title, description: item.description, category: item.category, skillMarkdown: item.skillMarkdown, resources: item.resources })
  const characterCount = draft.skillMarkdown.length + draft.resources.reduce((sum, file) => sum + file.content.length, 0)
  if (characterCount > canvasAgentSkillLimits.selectedCharacters) throw new CanvasAgentError(`所选 Skill 正文及资源共 ${characterCount} 字符，超过 16000 字符；请减少资源选择或缩短正文，不会截断内容`, 413)
  if (characterCount !== item.characterCount || JSON.stringify(reference.resourcePaths) !== JSON.stringify(draft.resources.map((file) => file.path))) throw new CanvasAgentError('Skill 快照资源或字数不一致，不能执行原规划', 409)
  return { ...reference, ...draft, characterCount, snapshotDigest: canvasAgentDigestValue(item.snapshotDigest) }
}
export function parseCanvasAgentSkillSnapshots(value: unknown): CanvasAgentSkillSnapshot[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.length > canvasAgentSkillLimits.selectedCount) throw new CanvasAgentError('Skill 快照数量不正确')
  const result = value.map(parseCanvasAgentSkillSnapshot)
  if (new Set(result.map((item) => item.skillId)).size !== result.length) throw new CanvasAgentError('Skill 快照重复')
  const count = result.reduce((sum, item) => sum + item.characterCount, 0)
  if (count > canvasAgentSkillLimits.selectedCharacters) throw new CanvasAgentError(`已选 Skill 正文及资源共 ${count} 字符，超过 16000 字符；请减少选择，不会截断正文`, 413)
  return result
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new CanvasAgentError('Skill 状态回执无效', 502); return value }
function time(value: unknown): string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new CanvasAgentError('Skill 时间回执无效', 502); return value }
function integer(value: unknown, maximum: number): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new CanvasAgentError('Skill 数量回执无效', 502); return Number(value) }
const summaryKeys = ['id', 'version', 'title', 'description', 'category', 'contentDigest', 'resourceCount', 'characterCount', 'enabled', 'favorite', 'createdAt', 'updatedAt', 'archivedAt', 'source']
export function parseCanvasAgentSkillSummary(value: unknown): CanvasAgentSkillSummary {
  const item = canvasAgentRecord(value); canvasAgentKeys(item, summaryKeys)
  return { id: canvasAgentId(item.id), version: canvasAgentVersion(item.version), title: canvasAgentText(item.title, 'Skill 名称', 100), description: canvasAgentText(item.description, 'Skill 描述', 1000, true), category: canvasAgentText(item.category, 'Skill 分类', 60, true), contentDigest: canvasAgentDigestValue(item.contentDigest), resourceCount: integer(item.resourceCount, 31), characterCount: integer(item.characterCount, canvasAgentSkillLimits.draftBytes), enabled: bool(item.enabled), favorite: bool(item.favorite), createdAt: time(item.createdAt), updatedAt: time(item.updatedAt), ...(item.archivedAt === undefined ? {} : { archivedAt: time(item.archivedAt) }), ...(item.source === undefined ? {} : { source: parseCanvasAgentSkillSource(item.source) }) }
}
export function parseCanvasAgentSkill(value: unknown): CanvasAgentSkill {
  const item = canvasAgentRecord(value); canvasAgentKeys(item, [...summaryKeys, 'skillMarkdown', 'resources'])
  const { skillMarkdown, resources, ...metadata } = item
  const summary = parseCanvasAgentSkillSummary(metadata), draft = parseCanvasAgentSkillDraft({ title: item.title, description: item.description, category: item.category, skillMarkdown, resources })
  if (summary.resourceCount !== draft.resources.length || summary.characterCount !== draft.skillMarkdown.length + draft.resources.reduce((sum, file) => sum + file.content.length, 0)) throw new CanvasAgentError('Skill 资源回执不完整', 502)
  return { ...summary, skillMarkdown: draft.skillMarkdown, resources: draft.resources }
}
export function parseCanvasAgentSkillResponse<M extends CanvasAgentSkillMethod>(method: M, value: unknown): CanvasAgentSkillMethodMap[M]['result'] {
  let result: unknown
  if (method === 'previewRemoteSkill') result = parseCanvasAgentSkillRemotePreview(value)
  else if (method === 'previewSkillReference') result = parseCanvasAgentSkillSnapshot(value)
  else if (method === 'inspectSkillOperation') { const item = canvasAgentRecord(value); canvasAgentKeys(item, item.state === 'missing' ? ['state'] : ['state', 'skill']); if (item.state !== 'missing' && item.state !== 'found') throw new CanvasAgentError('Skill 原操作回执无效'); result = item.state === 'missing' ? { state: 'missing' } : { state: 'found', skill: parseCanvasAgentSkill(item.skill) } }
  else if (method === 'listSkills') {
    const item = canvasAgentRecord(value); canvasAgentKeys(item, ['items', 'total', 'offset', 'limit', 'query', 'category', 'archived', 'favorites'])
    const total = integer(item.total, canvasAgentSkillLimits.maximumSkills), offset = integer(item.offset, 100_000), limit = integer(item.limit, 50)
    if (!limit || !Array.isArray(item.items) || item.items.length !== Math.min(limit, Math.max(0, total - offset))) throw new CanvasAgentError('Skill 分页回执不完整', 502)
    const items = item.items.map(parseCanvasAgentSkillSummary)
    if (new Set(items.map((entry) => entry.id)).size !== items.length) throw new CanvasAgentError('Skill 分页内容重复', 502)
    result = { items, total, offset, limit, query: canvasAgentText(item.query, 'Skill 搜索', 100, true), category: canvasAgentText(item.category, 'Skill 分类', 60, true), archived: bool(item.archived), favorites: bool(item.favorites) }
  } else result = parseCanvasAgentSkill(value)
  return result as CanvasAgentSkillMethodMap[M]['result']
}
