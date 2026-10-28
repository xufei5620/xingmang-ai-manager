import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import { maximumPromptPresetLength, type PromptPresetInput } from '../library/prompt-preset-contract'
import type { AssetRef } from '../model'
import { maximumPromptLength } from '../persistence/workflow-schema'
import type { CanvasCommand } from '../store/canvas-command'
import { validateParentGraph } from './grouping'
import { findAvailableCanvasPosition } from './node-placement'

export type TextOutputSelection = 'input' | 'result'

interface TextOutputData {
  prompt?: unknown
  promptReferences?: unknown
  outputText?: unknown
  dirty?: unknown
  status?: unknown
  errorMessage?: unknown
}

export interface NodeTextOutput {
  selection: TextOutputSelection
  text: string
  label: string
  length: number
  stale: boolean
  running: boolean
  available: boolean
  reason?: string
  canCopy: boolean
  canPlace: boolean
  canSavePreset: boolean
  presetReason?: string
}

function invalidTextReason(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text.trim()) return '当前没有可用的文字内容'
  if (text.includes('\0')) return '文字含有不支持的空字符，请先移除后重试'
  if (text.length > maximumPromptLength) return `文字超过 ${maximumPromptLength.toLocaleString('en-US')} 字符，无法完整放入文字节点`
  return undefined
}

/** Where the host blocks page downloads the text points at copying instead of a download the client lacks. */
function promptPresetTooLongReason(downloadable: boolean): string {
  return `提示词最多 ${maximumPromptPresetLength.toLocaleString('en-US')} 字符，当前内容不会被截断；可${downloadable ? '下载' : '复制'}或放到画布后编辑`
}

/** The prompt is already expanded. Reference metadata must never substitute its body. */
export function inspectNodeTextOutput(kind: string, data: TextOutputData, selection: TextOutputSelection, downloadable = true): NodeTextOutput {
  const raw = selection === 'result' ? data.outputText : data.prompt
  const text = typeof raw === 'string' ? raw : ''
  const running = data.status === 'queued' || data.status === 'running'
  const stale = selection === 'result' && Boolean(text.trim()) && data.dirty === true
  const supported = selection === 'result' ? ['text-generate', 'output'].includes(kind) : ['prompt', 'text', 'text-generate'].includes(kind)
  const reason = !supported ? '此节点没有所选文字内容' : invalidTextReason(raw)
  const available = !reason
  const previous = selection === 'result' && available && (stale || running || data.status === 'failed' || Boolean(data.errorMessage))
  const label = selection === 'input' ? kind === 'text-generate' ? '输入指令' : '正文' : kind === 'output' ? previous ? '上次文字结果' : '文字结果' : previous ? '上次生成结果' : '生成结果'
  const presetReason = reason ?? (running ? '正在生成，请结束本次运行后再保存提示词' : text.length > maximumPromptPresetLength ? promptPresetTooLongReason(downloadable) : undefined)
  return { selection, text, label, length: text.length, stale, running, available, ...(reason ? { reason } : {}),
    canCopy: available, canPlace: available && !running, canSavePreset: !presetReason, ...(presetReason ? { presetReason } : {}) }
}

function assertSnapshot(snapshot: NodeTextOutput, mutation: boolean): void {
  const reason = invalidTextReason(snapshot.text)
  if (!snapshot.available || reason) throw new Error(reason ?? snapshot.reason ?? '文字内容已变化，请重新打开')
  if (mutation && snapshot.running) throw new Error('正在生成，请结束本次运行后再放置或保存文字')
}

function placementMedia(node: EditorNodeRecord): { result: AssetRef } | undefined {
  const value = node.data.result
  if (!value || typeof value !== 'object' || !('kind' in value) || (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio')) return undefined
  return { result: { kind: value.kind,
    ...('assetId' in value && typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
    ...('width' in value && typeof value.width === 'number' ? { width: value.width } : {}),
    ...('height' in value && typeof value.height === 'number' ? { height: value.height } : {}),
  } }
}

/** A plain editable snapshot is independent of the source and has no generated run identity. */
export function buildOutputTextNode(nodes: readonly EditorNodeRecord[], sourceId: string, selection: TextOutputSelection, newId: string): Extract<CanvasCommand, { type: 'add-nodes' }> {
  const source = nodes.find((node) => node.id === sourceId)
  if (!source) throw new Error('原文字节点已变化，本次没有添加文字')
  const snapshot = inspectNodeTextOutput(source.type, source.data, selection)
  assertSnapshot(snapshot, true)
  if (!validateParentGraph(nodes) || new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error('画布分组层级无效，请重新打开工程')
  if (typeof newId !== 'string' || !newId.trim() || newId.length > 160 || newId.includes('\0') || nodes.some((node) => node.id === newId)) throw new Error('文字输出标识无效，请重新放置')
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let position = { ...source.position }, parent = source.parentId ? byId.get(source.parentId) : undefined
  while (parent) { position = { x: position.x + parent.position.x, y: position.y + parent.position.y }; parent = parent.parentId ? byId.get(parent.parentId) : undefined }
  const sourceDefinition = builtinNodeRegistry.require(source.type)
  const definition = builtinNodeRegistry.require('prompt')
  const dimensions = { ...definition.dimensions }
  const title = source.data.settings && typeof source.data.settings === 'object' && typeof Reflect.get(source.data.settings, 'title') === 'string'
    ? String(Reflect.get(source.data.settings, 'title')).trim() || sourceDefinition.title : sourceDefinition.title
  const center = { x: position.x + (source.width ?? sourceDefinition.dimensions.width) + 60 + dimensions.width / 2, y: position.y + (source.height ?? sourceDefinition.dimensions.height) / 2 }
  const obstacles = nodes.map((node) => {
    const fallback = builtinNodeRegistry.resolve(node.type)?.dimensions
    return { ...node, data: placementMedia(node), width: node.width ?? fallback?.width, height: node.height ?? fallback?.height }
  })
  return { type: 'add-nodes', nodes: [{ id: newId, type: 'prompt', definitionVersion: definition.version,
    position: findAvailableCanvasPosition(obstacles, center, dimensions), ...dimensions,
    data: { prompt: snapshot.text, model: '', status: 'idle', dirty: false, settings: { title: `${title} ${selection === 'result' ? '结果副本' : '正文副本'}`.slice(0, 160) } },
  }] }
}

export function textOutputPresetInput(snapshot: NodeTextOutput, title?: string, downloadable = true): PromptPresetInput {
  assertSnapshot(snapshot, true)
  if (snapshot.text.length > maximumPromptPresetLength) throw new Error(promptPresetTooLongReason(downloadable))
  const name = title === undefined ? snapshot.text.split(/\r?\n/).find((line) => line.trim())!.trim().slice(0, 60) : title.trim()
  if (!name || name.length > 160 || name.includes('\0')) throw new Error('提示词名称需为 1–160 个字符')
  return { name, prompt: snapshot.text, tags: [] }
}

export function textOutputDownload(snapshot: NodeTextOutput, title = '星芒文字'): { fileName: string; text: string; mimeType: 'text/plain;charset=utf-8' } {
  assertSnapshot(snapshot, false)
  const name = title.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '').trim().slice(0, 100) || '星芒文字'
  return { fileName: `${name}-${snapshot.label}.txt`, text: snapshot.text, mimeType: 'text/plain;charset=utf-8' }
}
