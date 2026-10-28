// 工程按宿主的工程存储写（#4）：v2 时代的桌面工程节点数据只认 11 个键、设置里的数组最多 256 项，
// 多一个键就整单拒绝，自动保存失败、窗口关不掉。网页和第 1 版桌面认内核格式，原样写。
import type { CanvasCapabilityProfile } from '../host-capabilities'
import { isRecord, type PersistedWorkflowNodeV2, type PersistedWorkflowV2 } from './workflow-schema'

export type CanvasProjectStore = CanvasCapabilityProfile['project']

// The same two patterns desktop 000f913 applies to every settings key and string.
const forbiddenSettingKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const unsafeSettingLocation = /^(?:[a-zA-Z]:[\\/]|\\\\|\/|https?:|data:|file:)/i
const maximumSettingString = 10_000
const maximumSettingEntries = 256
const maximumSettingDepth = 8

function fitsV2Setting(value: unknown, arrayMaximum: number, depth: number): boolean {
  if (depth > maximumSettingDepth) return false
  if (typeof value === 'string') return value.length <= maximumSettingString && !unsafeSettingLocation.test(value)
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean' || value === null) return true
  if (Array.isArray(value)) return value.length <= arrayMaximum && value.every((entry) => fitsV2Setting(entry, arrayMaximum, depth + 1))
  if (!isRecord(value) || Object.keys(value).length > maximumSettingEntries) return false
  return Object.entries(value).every(([key, child]) => fitsV2SettingKey(key) && fitsV2Setting(child, arrayMaximum, depth + 1))
}

function fitsV2SettingKey(key: string): boolean {
  return key.length > 0 && key.length <= 128 && !forbiddenSettingKey.test(key)
}

/**
 * Settings a v2 store keeps. A top-level setting it would refuse belongs to a
 * feature that host has switched off (masks, image tools, reference order and
 * the like), so it is left out rather than failing every autosave. A note's
 * prose is the user's own words and is never dropped: such a save stops.
 */
function v2Settings(kind: string, settings: Record<string, unknown>, arrayMaximum: number): Record<string, unknown> | undefined {
  const kept = Object.entries(settings).filter(([key, value]) => {
    if (fitsV2SettingKey(key) && fitsV2Setting(value, arrayMaximum, 1)) return true
    if (kind === 'note' && key === 'text') throw new Error('便签正文超过当前客户端的上限（1 万字），或以网址、路径开头，保存未完成')
    return false
  }).slice(0, maximumSettingEntries)
  return kept.length ? Object.fromEntries(kept) : undefined
}

function characterLimit(maximum: number): string {
  return maximum % 10_000 === 0 ? `${maximum / 10_000} 万字` : `${maximum.toLocaleString('zh-CN')} 字`
}

/**
 * Why the host's project store cannot keep this note text, or undefined when
 * it can. The editor checks every keystroke against it, so typing never turns
 * a note into one the host refuses, and an autosave never fails on it.
 */
export function hostNoteTextProblem(text: string, store: CanvasProjectStore): string | undefined {
  if (text.length > store.noteText.maximumLength) return `当前客户端的便签最多 ${characterLimit(store.noteText.maximumLength)}`
  if (store.noteText.plainTextOnly && unsafeSettingLocation.test(text)) return '当前客户端的便签不能以网址或文件路径开头'
  return undefined
}

/**
 * Whether an edit may replace a note's text. An edit that would make a
 * storable note unstorable is refused; a note that already cannot be stored
 * (pasted or opened that way) takes every edit, so the user can fix it.
 */
export function hostNoteTextEditAccepted(current: string, next: string, store: CanvasProjectStore): boolean {
  return hostNoteTextProblem(next, store) === undefined || hostNoteTextProblem(current, store) !== undefined
}

// Desktop 000f913 keeps exactly these node data keys. It also accepts
// latestAttemptDurationMs from old files, which the kernel never writes.
function v2NodeData(node: PersistedWorkflowNodeV2, store: CanvasProjectStore): PersistedWorkflowNodeV2['data'] {
  const { prompt, model, group, quality, size, imageResolution, seconds, result, settings, candidateAssetIds } = node.data
  const keptSettings = settings ? v2Settings(node.kind, settings, store.settingsArrayMaximum) : undefined
  return {
    prompt,
    model,
    ...(group !== undefined ? { group } : {}),
    ...(quality !== undefined ? { quality } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(imageResolution !== undefined ? { imageResolution } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(keptSettings ? { settings: keptSettings } : {}),
    ...(candidateAssetIds !== undefined ? { candidateAssetIds } : {}),
  }
}

/**
 * The saved form of a workflow for the host's project store. A kernel-format
 * store gets it as it is; a v2 store gets only what it keeps, and the rest,
 * such as the "needs a rerun" mark, stays in the editor.
 */
export function workflowForHostProject(workflow: PersistedWorkflowV2, store: CanvasProjectStore): PersistedWorkflowV2 {
  if (store.nodeDataFields === 'kernel') return workflow
  return { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, data: v2NodeData(node, store) })) }
}
