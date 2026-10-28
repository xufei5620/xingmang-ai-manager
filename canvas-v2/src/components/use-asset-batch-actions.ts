import { useEffect, useRef, useState, type SetStateAction } from 'react'
import { emptyAssetSelection, retainedAssetSelection, type AssetSelection } from './asset-selection'
import { createAssetBatchActionController, emptyAssetBatchActionState, type AssetBatchActionState } from './asset-batch-selection'

export function useScopedAssetSelection(scope: string, visibleIds: readonly string[]) {
  const current = useRef({ scope, generation: 0, visibleIds })
  if (current.current.scope !== scope) { current.current.scope = scope; current.current.generation++ }
  current.current.visibleIds = visibleIds
  const generation = current.current.generation
  const [stored, setStored] = useState({ generation, value: emptyAssetSelection })
  const selection = stored.generation === generation ? retainedAssetSelection(stored.value, visibleIds) : emptyAssetSelection
  // Commit removals as well as hiding them, so a removed/reappearing asset is never reselected silently.
  useEffect(() => {
    setStored((previous) => {
      if (previous.generation !== generation) return { generation, value: emptyAssetSelection }
      const value = retainedAssetSelection(previous.value, visibleIds)
      return value === previous.value ? previous : { generation, value }
    })
  }, [generation, visibleIds])
  function setSelection(action: SetStateAction<AssetSelection>) {
    if (current.current.generation !== generation) return
    setStored((previous) => {
      const value = previous.generation === generation ? retainedAssetSelection(previous.value, current.current.visibleIds) : emptyAssetSelection
      return { generation, value: typeof action === 'function' ? action(value) : action }
    })
  }
  return { selection, setSelection }
}

export function useAssetBatchActions(scope: string) {
  const current = useRef({ scope, generation: 0 })
  if (current.current.scope !== scope) { current.current.scope = scope; current.current.generation++ }
  const generation = current.current.generation
  const [stored, setStored] = useState({ generation, value: emptyAssetBatchActionState })
  const controller = useRef(createAssetBatchActionController())
  controller.current.scope(`${generation}:${scope}`)
  useEffect(() => { const value = controller.current; value.activate(); return () => value.dispose() }, [])
  const state = stored.generation === generation ? stored.value : emptyAssetBatchActionState
  function reportError(error: string) {
    if (current.current.generation !== generation) return
    setStored({ generation, value: { ...state, error, notice: '' } })
  }
  async function run(kind: 'add' | 'download', ids: readonly string[], action?: (ids: readonly string[]) => Promise<void>) {
    if (!action || current.current.generation !== generation) return
    await controller.current.run(kind, ids, action, (value: AssetBatchActionState) => setStored({ generation, value }))
  }
  return { ...state, run, reportError }
}
