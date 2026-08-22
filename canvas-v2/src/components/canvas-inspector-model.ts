import type { Edge } from '@xyflow/react'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodePortDefinition } from '../domain/node-definition'
import type { AssetRef, WorkflowNodeData } from '../model'
import {
  defaultImageQuality,
  defaultImageResolution,
  defaultVideoSeconds,
  imageModelPreset,
  imageQualityOptions,
  imageSizeLabel,
  videoModelPreset,
  videoSizeOptions,
} from '../models'
import type { CanvasNode } from '../nodes/WorkflowNodes'

export interface CanvasInspectorPort extends NodePortDefinition {
  connectionCount: number
}

export interface CanvasInspectorNode {
  id: string
  kind: string
  title: string
  description: string
  status: WorkflowNodeData['status']
  prompt: string
  model: string
  quality?: string
  size?: string
  imageResolution?: '1K' | '2K' | '4K'
  seconds?: string
  group?: string
  settings: Record<string, unknown>
  previewAsset?: AssetRef
  candidateCount: number
  attemptCount: number
  latestAttemptDurationMs?: number
  costQuota?: number
  errorMessage?: string
  dirty: boolean
  disabled: boolean
  locked: boolean
  executable: boolean
  ports: CanvasInspectorPort[]
}

export interface CanvasInspectorParameterRow {
  label: string
  value: string
}

const imageParameterKinds = new Set(['image', 'image-generate', 'image-edit'])
const videoParameterKinds = new Set(['video', 'video-generate'])
const promptParameterKinds = new Set(['text', 'prompt', 'image', 'image-generate', 'image-edit', 'video', 'video-generate'])

function optionLabel(options: readonly { value: string; label: string }[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value
}

/**
 * Read-only projection of a node's parameters for the inspector. The node body
 * stays the single place these values are edited; duplicating the controls here
 * gave every parameter two independent editors for one piece of state.
 */
export function canvasInspectorParameterRows(node: Pick<CanvasInspectorNode, 'kind' | 'prompt' | 'model' | 'quality' | 'size' | 'imageResolution' | 'seconds' | 'settings'>): CanvasInspectorParameterRow[] {
  const rows: CanvasInspectorParameterRow[] = []
  if (promptParameterKinds.has(node.kind)) {
    rows.push({ label: '提示词', value: node.prompt.trim() || '未填写' })
  }
  if (imageParameterKinds.has(node.kind)) {
    const preset = imageModelPreset(node.model)
    rows.push({ label: '模型', value: preset.label })
    if (preset.supportsQuality) {
      rows.push({ label: '画质', value: optionLabel(imageQualityOptions, node.quality || defaultImageQuality) })
    }
    rows.push({ label: '清晰度', value: node.imageResolution ?? defaultImageResolution })
    if (preset.supportsSize) {
      rows.push({ label: '尺寸', value: imageSizeLabel(node.size || preset.sizes[0] || '') })
    }
  }
  if (videoParameterKinds.has(node.kind)) {
    const preset = videoModelPreset(node.model)
    rows.push({ label: '模型', value: preset.label })
    rows.push({ label: '比例', value: optionLabel(videoSizeOptions, node.size || preset.defaultSize) })
    rows.push({ label: '时长', value: `${node.seconds ?? String(defaultVideoSeconds)} 秒` })
  }
  if (node.kind === 'frame-extract') {
    const timestamp = typeof node.settings.timestampSeconds === 'number' ? node.settings.timestampSeconds : 0
    rows.push({ label: '时间点', value: `${timestamp} 秒` })
  }
  if (node.kind === 'router') {
    const strategy = node.settings.strategy === 'all' ? '保留全部输入' : '优先首个可用输入'
    rows.push({ label: '路由策略', value: strategy })
  }
  if (node.kind === 'note') {
    rows.push({ label: '便签', value: typeof node.settings.text === 'string' && node.settings.text.trim() ? node.settings.text : '未填写' })
  }
  if (node.kind === 'group') {
    rows.push({ label: '分组名称', value: typeof node.settings.title === 'string' && node.settings.title ? node.settings.title : '新建分组' })
  }
  if (node.kind === 'drama-bible') {
    rows.push({ label: '风格', value: typeof node.settings.stylePrompt === 'string' && node.settings.stylePrompt ? node.settings.stylePrompt : (node.prompt.trim() || '未填写') })
  }
  if (node.kind === 'drama-character' || node.kind === 'drama-scene' || node.kind === 'drama-prop') {
    rows.push({ label: '名称', value: typeof node.settings.name === 'string' && node.settings.name ? node.settings.name : '未命名' })
    rows.push({ label: '封板', value: node.settings.locked === true ? '已封板' : '未封板' })
  }
  if (node.kind === 'drama-shot') {
    rows.push({ label: '镜号', value: typeof node.settings.shotId === 'string' && node.settings.shotId ? node.settings.shotId : '未编号' })
    rows.push({ label: '闸', value: node.settings.gate === 'ready' ? '可出图' : node.settings.gate === 'stale' ? '需重编译' : '未封板' })
  }
  return rows
}

function selectedPreviewAsset(node: CanvasNode): AssetRef | undefined {
  const candidate = node.data.candidates?.find((entry) => entry.candidateId === node.data.selectedCandidateId)
    ?? node.data.candidates?.find((entry) => entry.candidateId === node.data.adoptedCandidateId)
    ?? node.data.candidates?.[0]
  return candidate?.asset ?? node.data.result
}

export function projectCanvasInspectorNodes(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[],
): CanvasInspectorNode[] {
  const selected = nodes.filter((node) => node.selected)
  if (selected.length === 0) return []
  const connectionCounts = new Map<string, number>()
  for (const edge of edges) {
    const sourceKey = `${edge.source}:output:${edge.sourceHandle ?? ''}`
    const targetKey = `${edge.target}:input:${edge.targetHandle ?? ''}`
    connectionCounts.set(sourceKey, (connectionCounts.get(sourceKey) ?? 0) + 1)
    connectionCounts.set(targetKey, (connectionCounts.get(targetKey) ?? 0) + 1)
  }
  return selected.map((node) => {
    const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown') ?? builtinNodeRegistry.require('unknown')
    return {
      id: node.id,
      kind: node.type ?? 'unknown',
      title: definition.title,
      description: definition.description,
      status: node.data.status,
      prompt: node.data.prompt,
      model: node.data.model,
      ...(node.data.quality ? { quality: node.data.quality } : {}),
      ...(node.data.size ? { size: node.data.size } : {}),
      ...(node.data.imageResolution ? { imageResolution: node.data.imageResolution } : {}),
      ...(node.data.seconds ? { seconds: node.data.seconds } : {}),
      ...(typeof node.data.group === 'string' && node.data.group ? { group: node.data.group } : {}),
      settings: { ...(node.data.settings ?? {}) },
      ...(selectedPreviewAsset(node) ? { previewAsset: selectedPreviewAsset(node) } : {}),
      candidateCount: node.data.candidates?.length ?? 0,
      attemptCount: node.data.attemptCount ?? 0,
      ...(node.data.latestAttemptDurationMs !== undefined ? { latestAttemptDurationMs: node.data.latestAttemptDurationMs } : {}),
      ...(node.data.costQuota !== undefined ? { costQuota: node.data.costQuota } : {}),
      ...(node.data.errorMessage ? { errorMessage: node.data.errorMessage } : {}),
      dirty: Boolean(node.data.dirty),
      disabled: Boolean(node.disabled),
      locked: node.draggable === false,
      executable: definition.executable,
      ports: definition.ports.map((port) => ({
        ...port,
        connectionCount: connectionCounts.get(`${node.id}:${port.direction}:${port.id}`) ?? 0,
      })),
    }
  })
}
