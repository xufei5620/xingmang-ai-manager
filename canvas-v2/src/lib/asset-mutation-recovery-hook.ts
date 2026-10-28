'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetMutationInput } from './asset-mutation-contract'
import { AssetMutationNotSubmittedError, createAssetMutationRecovery, type AssetMutationRecoveryOptions, type AssetMutationRecoveryPort, type AssetMutationRecoveryState } from './asset-mutation-recovery'

export interface AssetMutationRecoveryHookOptions extends Omit<AssetMutationRecoveryOptions, 'ownerId' | 'active'> { ownerId: string | null; active: boolean }
function emptyState(active: boolean): AssetMutationRecoveryState { return { entries: [], result: null, ready: false, loading: active, busy: false, error: '', writeAvailable: false, writeError: '', retryAvailable: false } }

export function useAssetMutationRecovery(options: AssetMutationRecoveryHookOptions) {
  const latest = useRef(options)
  latest.current = options
  const current = useRef<AssetMutationRecoveryPort | null>(null), ownerId = options.ownerId?.toLowerCase() ?? null
  const scope = useRef({ ownerId, active: options.active, storage: options.storage, lock: options.lock, timeoutMs: options.timeoutMs, revision: 0 })
  if (scope.current.ownerId !== ownerId || scope.current.active !== options.active || scope.current.storage !== options.storage || scope.current.lock !== options.lock || scope.current.timeoutMs !== options.timeoutMs) scope.current = { ownerId, active: options.active, storage: options.storage, lock: options.lock, timeoutMs: options.timeoutMs, revision: scope.current.revision + 1 }
  const revision = scope.current.revision
  const [view, setView] = useState<{ ownerId: string | null; revision: number; port: AssetMutationRecoveryPort | null; state: AssetMutationRecoveryState }>(() => ({ ownerId, revision, port: null, state: emptyState(options.active) }))
  useEffect(() => {
    if (!ownerId || !options.active) { current.current = null; setView({ ownerId, revision, port: null, state: emptyState(false) }); return }
    let port: AssetMutationRecoveryPort
    try {
      port = createAssetMutationRecovery({
        ownerId, active: () => latest.current.active && latest.current.ownerId?.toLowerCase() === ownerId && scope.current.revision === revision,
        apply: (input, signal) => latest.current.apply(input, signal),
        inspect: (input, signal) => latest.current.inspect(input, signal),
        now: () => latest.current.now?.() ?? new Date().toISOString(),
        storage: options.storage, lock: options.lock, timeoutMs: options.timeoutMs,
      })
    } catch (error) {
      current.current = null
      setView({ ownerId, revision, port: null, state: { ...emptyState(false), error: error instanceof Error ? error.message : '素材原操作记录暂不可用，请重新进入工作区。' } })
      return
    }
    current.current = port
    function active() { return current.current === port && latest.current.active && latest.current.ownerId?.toLowerCase() === ownerId && scope.current.revision === revision }
    function update(state: AssetMutationRecoveryState) { if (active()) setView({ ownerId, revision, port, state }) }
    const unsubscribe = port.subscribe(update)
    update(port.snapshot())
    async function reload() {
      try {
        const entries = await port.load()
        if (!active() || port.snapshot().busy) return
        const entry = entries.find((item) => item.phase === 'pending') ?? entries.find((item) => item.input.operationId === port.snapshot().selectedOperationId) ?? entries.at(-1)
        if (entry) await port.inspect(entry.input)
      } catch { /* The controller publishes the retained identity and error. */ }
    }
    function changed(event: StorageEvent) { if (event.key === port.key || event.key === null) void reload() }
    void reload()
    if (typeof window !== 'undefined') window.addEventListener('storage', changed)
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('storage', changed)
      unsubscribe(); port.dispose()
      if (current.current === port) current.current = null
    }
  }, [revision])
  function requirePort() {
    const port = current.current
    if (!port || !latest.current.active || latest.current.ownerId?.toLowerCase() !== ownerId || scope.current.revision !== revision) throw new AssetMutationNotSubmittedError('素材恢复所属账号或权限已变化，请重新进入；本次尚未提交。')
    return port
  }
  const reload = useCallback(async () => await requirePort().load(), [revision])
  const submit = useCallback(async (input: AssetMutationInput, signal?: AbortSignal) => await requirePort().submit(input, signal), [revision])
  const inspect = useCallback(async (input: AssetMutationInput, signal?: AbortSignal) => await requirePort().inspect(input, signal), [revision])
  const retry = useCallback(async (input: AssetMutationInput, signal?: AbortSignal) => await requirePort().retry(input, signal), [revision])
  const select = useCallback((operationId: string) => requirePort().select(operationId), [revision])
  const stopWaiting = useCallback(() => requirePort().stopWaiting(), [revision])
  const state = options.active && view.revision === revision && ownerId === view.ownerId && current.current === view.port ? view.state : emptyState(options.active)
  return { ...state, reload, submit, inspect, retry, select, stopWaiting }
}
export type AssetMutationRecoveryHook = ReturnType<typeof useAssetMutationRecovery>
