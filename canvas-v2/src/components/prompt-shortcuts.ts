import { sortPromptPresets, type CanvasPromptPreset } from '../library/prompt-preset-contract'
import { builtinPromptPresets } from '../library/prompt-presets'
import { workshopOriginLabel } from '../lib/workshop-transfer-contract'
import { maximumPromptLength } from '../persistence/workflow-schema'

export interface PromptShortcutQuery { start: number; end: number; query: string }
export type PromptShortcutSource = 'all' | 'builtin' | 'mine' | 'acquired'
export interface PromptShortcut { id: string; name: string; prompt: string; description: string; group?: string; tags: readonly string[]; searchText: string; source: 'builtin' | 'mine' | 'acquired'; authorName?: string; originLabel?: string }
export const maximumVisiblePromptShortcuts = 50

export function promptShortcutQueryAt(value: string, start: number, end = start): PromptShortcutQuery | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null
  const match = /(?:^|\s)#([^\s#]*)$/.exec(value.slice(0, start))
  if (!match) return null
  return { start: value.lastIndexOf('#', start - 1), end: start, query: match[1] ?? '' }
}

export function promptShortcutItems(presets: readonly CanvasPromptPreset[]): PromptShortcut[] {
  return [
    ...sortPromptPresets(presets).map((preset): PromptShortcut => ({ id: `mine:${preset.id}`, name: preset.name, prompt: preset.prompt, description: preset.description || preset.prompt.slice(0, 160), group: preset.group ?? '', tags: preset.tags, searchText: `${preset.name} ${preset.group ?? ''} ${preset.description ?? ''} ${preset.tags.join(' ')}${preset.origin ? ` ${preset.origin.authorName}` : preset.transferOrigin?.authorName ? ` ${preset.transferOrigin.authorName}` : ''}`.toLocaleLowerCase('zh-CN'), source: preset.origin || preset.transferOrigin ? 'acquired' : 'mine', originLabel: preset.origin ? `社区 · ${preset.origin.authorName}` : workshopOriginLabel(preset), ...(preset.origin ? { authorName: preset.origin.authorName } : preset.transferOrigin?.authorName ? { authorName: preset.transferOrigin.authorName } : {}) })),
    ...builtinPromptPresets.map((preset): PromptShortcut => ({ id: `builtin:${preset.id}`, name: preset.title, prompt: preset.prompt, description: preset.description, tags: preset.tags, searchText: `${preset.title} ${preset.description} ${preset.tags.join(' ')}`.toLocaleLowerCase('zh-CN'), source: 'builtin' })),
  ]
}

export function filterPromptShortcuts(items: readonly PromptShortcut[], query: string, source: PromptShortcutSource, group: string | null = null): PromptShortcut[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  return items.filter((item) => (source === 'all' || item.source === source)
    && (group === null || (item.source !== 'builtin' && (item.group ?? '') === group))
    && (!normalized || item.searchText.includes(normalized)))
}

export function insertPromptShortcut(value: string, prompt: string, query: PromptShortcutQuery): { ok: true; value: string; caret: number } | { ok: false; message: string } {
  if (!Number.isInteger(query.start) || !Number.isInteger(query.end) || query.start < 0 || query.end < query.start || query.end > value.length
    || value.slice(query.start, query.end) !== `#${query.query}`) return { ok: false, message: '输入位置已变化，请重新输入 # 选择提示词。' }
  if (!prompt.trim() || prompt.includes('\0')) return { ok: false, message: '提示词内容无法使用，请重新读取后核对。' }
  const next = value.slice(0, query.start) + prompt + value.slice(query.end)
  if (next.length > maximumPromptLength) return { ok: false, message: `插入后超过 ${maximumPromptLength} 字，原内容已保留，请先缩短正文。` }
  return { ok: true, value: next, caret: query.start + prompt.length }
}

export function promptShortcutComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229
}

export function promptShortcutMenuHandlesKeys(target: { search?: boolean; role?: string | null }): boolean {
  return target.search === true || target.role === 'option'
}
