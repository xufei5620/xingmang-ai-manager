import type { CanvasGroupSummary, CanvasPreparedGroup, CanvasRunGraph } from '../host'
import type { VideoProtocol } from '../lib/video-request-protocol'
import { availableModelsForKind, type MediaCapabilityKind } from './media-groups'

export interface CanvasNodeSource {
  state: 'pending' | 'ready' | 'error'
  models: readonly string[]
  purposes?: readonly MediaCapabilityKind[]
  videoProtocol?: VideoProtocol
  error?: string
  label?: string
}
export type CanvasNodeSourceCatalog = Readonly<Record<string, CanvasNodeSource>>
export const emptyCanvasNodeSourceCatalog: CanvasNodeSourceCatalog = Object.freeze({})
export interface CanvasNodeModelAvailability {
  connected: boolean
  imageModels: readonly string[]
  videoModels: readonly string[]
  textModels: readonly string[]
  imageModel?: string | null
  videoModel?: string | null
  textModel?: string | null
  videoProtocol?: VideoProtocol
  sourceCatalog?: CanvasNodeSourceCatalog
  sourceGroups?: readonly CanvasGroupSummary[]
  sourceError?: string
  sourceLabel?: string
}

export function canvasNodeMediaKind(kind: string): MediaCapabilityKind | undefined {
  if (['image', 'image-generate', 'image-edit'].includes(kind)) return 'image'
  if (['video', 'video-generate'].includes(kind)) return 'video'
  if (['text-generate', 'drama-parse'].includes(kind)) return 'text'
  return undefined
}

/** A persisted override is a source identity, never a hint for a fallback. */
export function resolveCanvasNodeModelAvailability(kind: string, data: { group?: string }, defaults: CanvasNodeModelAvailability): CanvasNodeModelAvailability {
  if (data.group === undefined || !canvasNodeMediaKind(kind)) return defaults
  const source = defaults.sourceCatalog && Object.hasOwn(defaults.sourceCatalog, data.group) ? defaults.sourceCatalog[data.group] : undefined
  const purpose = canvasNodeMediaKind(kind)!
  const error = !data.group ? '节点固定来源为空，请重新配置此节点'
    : !source ? '节点固定来源尚未核对或已不存在，请刷新模型来源'
      : source.state !== 'ready' ? source.error || '正在核对节点固定来源，请稍后再运行'
        : source.purposes !== undefined && !source.purposes.includes(purpose) ? '节点固定来源不提供此用途，请重新配置此节点' : undefined
  return {
    connected: defaults.connected,
    sourceCatalog: defaults.sourceCatalog,
    sourceGroups: defaults.sourceGroups,
    imageModels: error ? [] : availableModelsForKind('image', source!.models, source!.purposes),
    videoModels: error ? [] : availableModelsForKind('video', source!.models, source!.purposes),
    textModels: error ? [] : availableModelsForKind('text', source!.models, source!.purposes),
    videoProtocol: source?.videoProtocol,
    sourceLabel: source?.label || data.group,
    ...(error ? { sourceError: error } : {}),
  }
}

export function fixedCanvasNodeSourceNames(nodes: readonly { type?: string; data: { group?: string } }[]): string[] {
  return [...new Set(nodes.filter((node) => canvasNodeMediaKind(node.type ?? '') && node.data.group !== undefined).map((node) => node.data.group!))].sort()
}

export function awaitingCanvasFixedVideoSources(nodes: readonly { id: string; type?: string; kind?: string; data: { group?: string } }[], submitted: CanvasRunGraph, catalog: CanvasNodeSourceCatalog): boolean {
  return nodes.some((node) => canvasNodeMediaKind(node.type ?? node.kind ?? '') === 'video' && node.data.group !== undefined
    && submitted.nodes.some((original) => original.id === node.id && original.data.group === node.data.group)
    && (!Object.hasOwn(catalog, node.data.group) || catalog[node.data.group].state !== 'ready'))
}

export function canvasNodeSourceSignature(names: readonly string[], groups: readonly CanvasGroupSummary[], legacyRevision: number): string {
  return JSON.stringify(names.map((name) => {
    const source = groups.find((group) => group.name === name)
    return [name, source ? source.revision ?? legacyRevision : 'missing', source?.connectionStatus, source?.purposes, source?.videoProtocol]
  }))
}

/** Reads saved source catalogs only; bounded workers never probe model APIs. */
export async function prepareCanvasNodeSources(options: {
  names: readonly string[]
  groups: readonly CanvasGroupSummary[]
  prepare(name: string): Promise<CanvasPreparedGroup>
  isCurrent(): boolean
  onChange(catalog: CanvasNodeSourceCatalog): void
}): Promise<void> {
  const names = [...new Set(options.names)], result: Record<string, CanvasNodeSource> = Object.create(null)
  let cursor = 0, stopped = false
  function current() { if (!stopped && !options.isCurrent()) stopped = true; return !stopped }
  function publish() { if (current()) options.onChange({ ...result }) }
  for (const name of names) {
    const source = options.groups.find((group) => group.name === name)
    result[name] = !source || !name ? { state: 'error', models: [], error: '节点固定来源已不存在，请重新配置此节点' }
      : source.connectionStatus && source.connectionStatus !== 'ready' ? { state: 'error', models: [], error: source.connectionStatus === 'untested' ? '节点固定来源尚未检测，请到账户设置检测模型列表' : '节点固定来源检测未通过，请到账户设置核对' }
        : { state: 'pending', models: [], purposes: source.purposes, videoProtocol: source.videoProtocol }
  }
  publish()
  async function worker() {
    while (cursor < names.length && current()) {
      const name = names[cursor++]
      if (result[name].state !== 'pending') continue
      const source = options.groups.find((group) => group.name === name)!
      try {
        const prepared = await options.prepare(name)
        if (!current()) return
        if (prepared.group !== name || source.revision !== undefined && source.revision !== prepared.revision || !Array.isArray(prepared.models) || !prepared.models.every((model) => typeof model === 'string' && model.length > 0)) throw new Error('节点固定来源在核对期间已变化，请重新核对模型列表')
        if (source.videoProtocol !== undefined && prepared.videoProtocol !== undefined && source.videoProtocol !== prepared.videoProtocol) throw new Error('节点固定来源的视频协议已变化，请重新核对')
        result[name] = { state: 'ready', models: [...new Set(prepared.models)], purposes: prepared.purposes ?? source.purposes, videoProtocol: prepared.videoProtocol ?? source.videoProtocol, label: source.description || name }
      } catch (cause) {
        if (!current()) return
        result[name] = { state: 'error', models: [], error: cause instanceof Error ? cause.message : '节点固定来源读取失败，请重新核对' }
      }
      publish()
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker))
}
