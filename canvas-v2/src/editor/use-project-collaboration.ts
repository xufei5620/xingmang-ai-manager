import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ProjectCollaborationClient } from '../lib/project-collaboration-client-port'
import type { ProjectCollaborationSnapshot } from '../lib/project-collaboration-contract'
import { hasProjectCollaborationJournal } from '../persistence/project-collaboration-journal'
import { createCanvasProjectCollaboration, type CanvasCollaborationState, type CanvasProjectCollaboration } from './project-collaboration-controller'
import type { CollaborationPanelAction } from '../slots'

interface CollaborationHookOptions {
  ownerId?: string
  projectId?: string
  scopeKey: string
  shared: boolean
  enabled: boolean
  client?: ProjectCollaborationClient
  controllerRef: MutableRefObject<CanvasProjectCollaboration | null>
  active(): boolean
  getContent(): string
  selectedNodeIds(): string[]
  onSnapshot(snapshot: ProjectCollaborationSnapshot, content: string, graphChanged: boolean): void
  onState(state: CanvasCollaborationState): void
}

export function useProjectCollaboration(options: CollaborationHookOptions) {
  const latest = useRef(options); latest.current = options
  const [value, setValue] = useState<{ key: string; state: CanvasCollaborationState } | null>(null)
  useEffect(() => {
    const { ownerId, projectId, scopeKey, controllerRef } = options
    if (!ownerId || !projectId || !options.enabled) return
    let instance: CanvasProjectCollaboration | null = null
    let alive = true
    function current() { return alive && latest.current.scopeKey === scopeKey && latest.current.enabled && latest.current.active() }
    try {
      const hasJournal = hasProjectCollaborationJournal(window.localStorage, ownerId, projectId)
      if (!options.shared && !hasJournal) return
      if (!options.client) throw new Error('当前宿主不支持实时协作，原编辑与协作记录保留；不会改用普通整图保存。')
      instance = createCanvasProjectCollaboration({
        ownerId, projectId, clientId: crypto.randomUUID(), client: options.client, storage: window.localStorage, active: current,
        getContent: () => latest.current.getContent(), selectedNodeIds: () => latest.current.selectedNodeIds(), createOperationId: () => crypto.randomUUID(),
        onSnapshot: (snapshot, content, changed) => { if (current()) latest.current.onSnapshot(snapshot, content, changed) },
        changed: (state) => { if (current()) { latest.current.onState(state); setValue({ key: scopeKey, state }) } },
      })
      controllerRef.current = instance
      latest.current.onState(instance.state()); setValue({ key: scopeKey, state: instance.state() })
      void instance.initialize()
    } catch (error) {
      if (current()) {
        const state: CanvasCollaborationState = { phase: 'error', snapshot: null, pending: null, pendingCount: 0, joined: false, message: error instanceof Error ? error.message : '协作记录暂不可核对，请保留本地编辑。' }
        latest.current.onState(state); setValue({ key: scopeKey, state })
      }
    }
    const timer = window.setInterval(() => {
      if (!current() || !instance) return
      // Both methods catch protocol errors and publish a stopped state. This
      // final catch also keeps lifecycle callback exceptions out of the timer.
      void instance.tick().catch(() => undefined)
      void instance.heartbeat().catch(() => undefined)
    }, 2_000)
    return () => {
      alive = false
      window.clearInterval(timer)
      instance?.dispose()
      if (controllerRef.current === instance) controllerRef.current = null
    }
  }, [options.scopeKey, options.enabled, options.shared, options.client])

  const state = value?.key === options.scopeKey ? value.state : null
  async function action(kind: CollaborationPanelAction, operationId?: string): Promise<void> {
    const target = options.controllerRef.current
    if (!target || !options.active()) throw new Error('当前协作连接不可用，请保留原编辑并重新核对。')
    if (kind === 'join') await target.join()
    else if (kind === 'resync') await target.join(true)
    else if (kind === 'inspect') await target.inspectOriginal()
    else if (kind === 'retry') await target.retryOriginal(operationId)
    else if (kind === 'abandon') await target.abandonRejected()
    else if (kind === 'use-server') await target.useServerVersion()
    else if (kind === 'leave') await target.leave()
    else await target.endEpoch()
  }
  return { state, action }
}
