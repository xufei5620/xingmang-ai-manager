'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetCategoryInput, AssetCategoryOperationInspection, AssetCategoryResult } from './asset-category-contract'
import { AssetCategoryRecoveryNotSubmittedError, createAssetCategoryRecovery, type AssetCategoryRecoveryOptions, type AssetCategoryRecoveryPort, type AssetCategoryRecoveryRecord, type AssetCategoryRecoveryState } from './asset-category-recovery'

export interface AssetCategoryRecoveryHookOptions extends Omit<AssetCategoryRecoveryOptions, 'ownerId' | 'active'> {
  ownerId: string | null
  active: boolean
}

export interface AssetCategoryRecoveryHook extends AssetCategoryRecoveryState {
  reload(): Promise<AssetCategoryRecoveryRecord | null>
  submit(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryResult>
  inspect(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryOperationInspection>
  retry(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryResult>
}

function emptyState(active: boolean): AssetCategoryRecoveryState {
  return { record: null, pending: undefined, ready: false, loading: active, error: '', writeAvailable: false, writeError: '' }
}

/** Endpoint closures can change on every parent render. Only owner/access or
 * storage/locking configuration changes the lifecycle of a durable operation. */
export function useAssetCategoryRecovery(options: AssetCategoryRecoveryHookOptions): AssetCategoryRecoveryHook {
  const latest = useRef(options)
  latest.current = options
  const current = useRef<AssetCategoryRecoveryPort | null>(null)
  const [view, setView] = useState<{ ownerId: string | null; revision: number; port: AssetCategoryRecoveryPort | null; state: AssetCategoryRecoveryState }>(() => ({ ownerId: options.ownerId, revision: 0, port: null, state: emptyState(options.active) }))
  const ownerId = options.ownerId?.toLowerCase() ?? null
  const scope = useRef({ ownerId, active: options.active, storage: options.storage, lock: options.lock, timeoutMs: options.timeoutMs, revision: 0 })
  if (scope.current.ownerId !== ownerId || scope.current.active !== options.active || scope.current.storage !== options.storage || scope.current.lock !== options.lock || scope.current.timeoutMs !== options.timeoutMs) scope.current = { ownerId, active: options.active, storage: options.storage, lock: options.lock, timeoutMs: options.timeoutMs, revision: scope.current.revision + 1 }
  const revision = scope.current.revision
  useEffect(() => {
    if (!ownerId || !options.active) { current.current = null; setView({ ownerId, revision, port: null, state: emptyState(false) }); return }
    let port: AssetCategoryRecoveryPort
    try {
      port = createAssetCategoryRecovery({
        ownerId, active: () => latest.current.active && latest.current.ownerId?.toLowerCase() === ownerId && scope.current.revision === revision,
        apply: (input, signal) => latest.current.apply(input, signal),
        inspect: (input, signal) => latest.current.inspect(input, signal),
        storage: options.storage, lock: options.lock, timeoutMs: options.timeoutMs,
        now: () => latest.current.now?.() ?? new Date().toISOString(),
      })
    } catch (cause) {
      current.current = null
      setView({ ownerId, revision, port: null, state: { ...emptyState(false), error: cause instanceof Error ? cause.message : '分类恢复账号尚未确认，请重新进入素材库。' } })
      return
    }
    current.current = port
    function update(state: AssetCategoryRecoveryState) {
      if (current.current === port && latest.current.active && latest.current.ownerId?.toLowerCase() === ownerId && scope.current.revision === revision) setView({ ownerId, revision, port, state })
    }
    update(port.snapshot())
    const unsubscribe = port.subscribe(update)
    function reload() { if (current.current === port) void port.load().catch(() => undefined) }
    function changed(event: StorageEvent) { if (event.key === port.key || event.key === null) reload() }
    reload()
    if (typeof window !== 'undefined') window.addEventListener('storage', changed)
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('storage', changed)
      unsubscribe(); port.dispose()
      if (current.current === port) current.current = null
    }
  }, [revision])
  function requirePort() {
    const port = current.current
    if (!port || !latest.current.active || latest.current.ownerId?.toLowerCase() !== ownerId || scope.current.revision !== revision) throw new AssetCategoryRecoveryNotSubmittedError('分类恢复记录尚未载入或账号已变化，请先重读原记录；本次尚未提交。')
    return port
  }
  const reload = useCallback(async () => await requirePort().load(), [revision])
  const submit = useCallback(async (input: AssetCategoryInput, signal?: AbortSignal) => await requirePort().submit(input, signal), [revision])
  const inspect = useCallback(async (input: AssetCategoryInput, signal?: AbortSignal) => await requirePort().inspect(input, signal), [revision])
  const retry = useCallback(async (input: AssetCategoryInput, signal?: AbortSignal) => await requirePort().retry(input, signal), [revision])
  const state = options.active && view.revision === revision && ownerId === view.ownerId && current.current === view.port ? view.state : emptyState(options.active)
  return { ...state, reload, submit, inspect, retry }
}
