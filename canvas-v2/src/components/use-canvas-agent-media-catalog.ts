import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasGroupSummary, CanvasPreparedGroup } from '../host'
import { availableModelsForKind } from '../library/media-groups'
import { isCanvasAgentMediaModelForPurpose } from '../lib/canvas-agent-media-models'

export interface AgentMediaCatalogSource {
  purpose: 'text' | 'image' | 'video'
  providerId: string
  providerName: string
  models: readonly string[]
}

interface AgentMediaCatalogResult { items: AgentMediaCatalogSource[]; error: string }
interface AgentMediaCatalogOptions {
  scopeKey: string | null
  enabled: boolean
  groups: readonly CanvasGroupSummary[]
  active(): boolean
  prepare(group: string): Promise<CanvasPreparedGroup>
}

/** The existing host reads the owner's saved catalog, without probing a model. */
export async function readAgentMediaCatalog(groups: readonly CanvasGroupSummary[], prepare: AgentMediaCatalogOptions['prepare'], current: () => boolean): Promise<AgentMediaCatalogResult | null> {
  const eligible = groups.filter((group) => group.purposes === undefined || group.purposes.some((purpose) => purpose === 'text' || purpose === 'image' || purpose === 'video'))
  const unique = [...new Map(eligible.map((group) => [group.name, group])).values()]
  const outcomes = await Promise.allSettled(unique.map(async (group) => {
    if (!current()) throw new Error('账号或工程已变化，请重新读取模型来源')
    if (group.connectionStatus && group.connectionStatus !== 'ready') throw new Error('请先到账户设置检测连接并读取模型列表')
    const prepared = await prepare(group.name)
    if (!current()) throw new Error('账号或工程已变化，请重新读取模型来源')
    if (prepared.group !== group.name || group.revision !== undefined && prepared.revision !== group.revision) throw new Error('来源资料已更新，请刷新模型来源后重读')
    return prepared
  }))
  if (!current()) return null
  const items: AgentMediaCatalogSource[] = [], errors: string[] = []
  unique.forEach((group, index) => {
    const outcome = outcomes[index]
    if (outcome.status === 'rejected') errors.push(`${group.description || group.name}：${outcome.reason instanceof Error ? outcome.reason.message : '模型目录暂未读取成功'}`)
    for (const purpose of ['text', 'image', 'video'] as const) {
      if (group.purposes !== undefined && !group.purposes.includes(purpose)) continue
      const models = outcome.status === 'fulfilled' ? availableModelsForKind(purpose, outcome.value.models, outcome.value.purposes ?? group.purposes).filter((model) => isCanvasAgentMediaModelForPurpose(purpose, model)) : []
      items.push({ purpose, providerId: group.name, providerName: group.description || group.name, models })
    }
  })
  return { items, error: errors.join('；').slice(0, 1500) }
}

export function useCanvasAgentMediaCatalog(options: AgentMediaCatalogOptions) {
  const latest = useRef(options)
  latest.current = options
  const signature = JSON.stringify(options.groups.map((group) => [group.name, group.description, group.revision ?? null, group.connectionStatus ?? null, group.purposes ?? null]))
  const key = JSON.stringify([options.scopeKey, signature])
  const [reloadRevision, setReloadRevision] = useState(0)
  const [state, setState] = useState({ key: '', items: [] as AgentMediaCatalogSource[], loading: false, error: '' })
  const cache = useRef<{ key: string; revision: number; result: AgentMediaCatalogResult } | null>(null)
  const epoch = useRef(0)
  const reload = useCallback(() => { cache.current = null; setReloadRevision((value) => value + 1) }, [])
  useEffect(() => {
    const generation = ++epoch.current, capturedScope = options.scopeKey
    function current() { return epoch.current === generation && latest.current.scopeKey === capturedScope && latest.current.active() }
    if (!options.enabled || !capturedScope || !options.active()) return
    if (cache.current?.key === key && cache.current.revision === reloadRevision) {
      setState({ key, ...cache.current.result, loading: false })
      return
    }
    setState((previous) => ({ key, items: previous.key === key ? previous.items : [], loading: true, error: '' }))
    void readAgentMediaCatalog(options.groups, (group) => latest.current.prepare(group), current).then((result) => {
      if (!result || !current()) return
      cache.current = { key, revision: reloadRevision, result }
      setState({ key, ...result, loading: false })
    }).catch((cause: unknown) => {
      if (current()) setState({ key, items: [], loading: false, error: cause instanceof Error ? cause.message : '媒体模型目录读取失败，请重试' })
    })
    return () => { if (epoch.current === generation) epoch.current++ }
  }, [key, options.enabled, reloadRevision])
  const visible = state.key === key && options.active()
  return { items: visible ? state.items : [], loading: visible ? state.loading : Boolean(options.enabled && options.scopeKey), error: visible ? state.error : '', reload }
}
