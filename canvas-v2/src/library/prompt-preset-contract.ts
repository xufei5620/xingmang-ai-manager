import { parseWorkshopTransferOrigin, parseWorkshopItemPermissions, type WorkshopTransferOrigin, type WorkshopItemPermissions } from '../lib/workshop-transfer-contract'
import { parseCommunityWorkshopOrigin, type CommunityWorkshopOrigin } from '../lib/community-workshop-contract'

export interface CanvasPromptPreset {
  id: string
  name: string
  prompt: string
  tags: string[]
  createdAt: string
  updatedAt: string
  /** Legacy storage marker; public authorship is represented by origin. */
  provenance: 'user-created'
  origin?: CommunityWorkshopOrigin
  transferOrigin?: WorkshopTransferOrigin
  permissions?: WorkshopItemPermissions
  group?: string
  description?: string
  sortOrder?: number
  version?: number
}

export interface PromptPresetInput { name: string; prompt: string; tags?: string[]; group?: string; description?: string }
export interface PromptPresetUpdateInput extends Partial<PromptPresetInput> { id: string; expectedVersion?: number }
export interface PromptPresetOrderEntry { id: string; version: number; sortOrder: number }
export interface PromptPresetOrderInput { entries: Array<{ id: string; expectedVersion: number }> }

export const maximumPromptPresetLength = 24_000
export const maximumPromptPresets = 500
// The list contains up to 500 complete prompts. JSON escaping can use six
// bytes per UTF-16 code unit; keep the bound identical in both web clients.
export const maximumPromptPresetResponseBytes = 80 * 1024 * 1024

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function validText(value: unknown, max: number): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !value.includes('\0') }

export function parseCanvasPromptPreset(value: unknown): CanvasPromptPreset {
  if (!object(value) || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
    || !validText(value.name, 160) || !validText(value.prompt, maximumPromptPresetLength)
    || !Array.isArray(value.tags) || value.tags.length > 20 || !value.tags.every((tag) => validText(tag, 40)) || (value.provenance !== 'user-created' && value.provenance !== 'community-acquired')
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.group !== undefined && (typeof value.group !== 'string' || value.group.length > 64 || /[\x00-\x1f\x7f]/.test(value.group)))
    || (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1000 || value.description.includes('\0')))
    || (value.sortOrder !== undefined && !Number.isSafeInteger(value.sortOrder))
    || (value.version !== undefined && (!Number.isSafeInteger(value.version) || Number(value.version) < 1))) throw new Error('提示词资料不完整，请重新读取后核对。')
  if (value.provenance === 'community-acquired' && value.origin === undefined) throw new Error('提示词来源无法确认，请重新读取。')
  return { id: value.id, name: value.name, prompt: value.prompt, tags: [...value.tags], createdAt: value.createdAt, updatedAt: value.updatedAt, provenance: 'user-created',
    ...(value.transferOrigin !== undefined ? { transferOrigin: parseWorkshopTransferOrigin(value.transferOrigin) } : {}),
    ...(value.permissions !== undefined ? { permissions: parseWorkshopItemPermissions(value.permissions) } : {}),
    ...(value.origin !== undefined ? { origin: parseCommunityWorkshopOrigin(value.origin) } : {}),
    ...(typeof value.group === 'string' ? { group: value.group } : {}), ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.sortOrder === 'number' ? { sortOrder: value.sortOrder } : {}), ...(typeof value.version === 'number' ? { version: value.version } : {}) }
}

export function parseCanvasPromptPresets(value: unknown): CanvasPromptPreset[] {
  if (!Array.isArray(value) || value.length > maximumPromptPresets) throw new Error('提示词列表无法读取，请重新加载。')
  const presets = value.map(parseCanvasPromptPreset)
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) throw new Error('提示词列表存在重复编号，请重新读取。')
  return presets
}

export function sortPromptPresets(items: readonly CanvasPromptPreset[]): CanvasPromptPreset[] {
  return [...items].sort((a, b) => (a.sortOrder ?? -Date.parse(a.updatedAt)) - (b.sortOrder ?? -Date.parse(b.updatedAt)) || b.id.localeCompare(a.id))
}

export function promptPresetGroups(items: readonly CanvasPromptPreset[]): string[] { return [...new Set(items.map((item) => item.group ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')) }

export function buildPromptPresetMove(items: readonly CanvasPromptPreset[], id: string, direction: 'up' | 'down', group: string | null = null): PromptPresetOrderInput | null {
  const ordered = sortPromptPresets(items)
  const visible = ordered.filter((item) => group === null || (item.group ?? '') === group)
  const index = visible.findIndex((item) => item.id === id)
  const other = visible[index + (direction === 'up' ? -1 : 1)]
  if (index < 0 || !other) return null
  const a = ordered.findIndex((item) => item.id === id), b = ordered.findIndex((item) => item.id === other.id)
  const moved = ordered[a]
  ordered[a] = ordered[b]
  ordered[b] = moved
  return { entries: ordered.map((item) => ({ id: item.id, expectedVersion: item.version ?? 1 })) }
}

export function parsePromptPresetOrder(value: unknown): PromptPresetOrderEntry[] {
  if (!Array.isArray(value) || value.length > maximumPromptPresets) throw new Error('提示词排序回执无法确认，请刷新目录。')
  const entries = value.map((entry) => {
    if (!object(entry) || typeof entry.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.id) || !Number.isSafeInteger(entry.version) || Number(entry.version) < 1 || !Number.isSafeInteger(entry.sortOrder)) throw new Error('提示词排序回执无法确认，请刷新目录。')
    return { id: entry.id, version: Number(entry.version), sortOrder: Number(entry.sortOrder) }
  })
  if (new Set(entries.map((item) => item.id)).size !== entries.length || new Set(entries.map((item) => item.sortOrder)).size !== entries.length) throw new Error('提示词排序回执存在重复条目，请刷新目录。')
  if (entries.some((item) => item.sortOrder < 0 || item.sortOrder >= entries.length)) throw new Error('提示词排序回执不完整，请刷新目录。')
  return entries
}

export function applyPromptPresetOrder(items: readonly CanvasPromptPreset[], entries: readonly PromptPresetOrderEntry[]): CanvasPromptPreset[] {
  const map = new Map(entries.map((entry) => [entry.id, entry]))
  if (items.length !== entries.length || items.some((item) => !map.has(item.id))) throw new Error('提示词目录已变化，请刷新后核对排序。')
  if (items.some((item) => { const entry = map.get(item.id)!; return entry.version < (item.version ?? 1) || (entry.version === (item.version ?? 1) && entry.sortOrder !== item.sortOrder) })) throw new Error('提示词排序回执已过期，请刷新目录核对。')
  return sortPromptPresets(items.map((item) => ({ ...item, ...map.get(item.id) })))
}
