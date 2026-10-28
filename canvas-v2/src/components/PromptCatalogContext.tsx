import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPromptCatalog, type PromptCatalogSnapshot } from '../library/prompt-catalog'
import type { CanvasPromptPreset, PromptPresetInput, PromptPresetUpdateInput, PromptPresetOrderInput } from '../library/prompt-preset-contract'

export interface PromptCatalogValue {
  items: readonly CanvasPromptPreset[]
  loading: boolean
  loaded: boolean
  error: string | null
  enabled: boolean
  load(force?: boolean): Promise<void>
  create?(input: PromptPresetInput): Promise<CanvasPromptPreset>
  update?(input: PromptPresetUpdateInput): Promise<void>
  remove?(id: string, expectedVersion?: number): Promise<void>
  reorder?(input: PromptPresetOrderInput): Promise<void>
  /** The longest name the host keeps; the kernel's own 160 when not given. */
  nameMaxLength?: number
  /** Whether the host keeps a group and a description; kept when not given. */
  metadata?: boolean
}

const emptyCatalog: PromptCatalogValue = { items: [], loading: false, loaded: false, error: null, enabled: true, async load() {} }
const lockedCatalog: PromptCatalogSnapshot = { items: [], loading: false, loaded: false, error: null }
const PromptCatalogContext = createContext<PromptCatalogValue>(emptyCatalog)

export function PromptCatalogProvider({ value, children }: { value: PromptCatalogValue; children: ReactNode }) {
  return <PromptCatalogContext.Provider value={value}>{children}</PromptCatalogContext.Provider>
}

export function usePromptCatalogValue() { return useContext(PromptCatalogContext) }

export function useWorkspacePromptCatalog(read: () => Promise<unknown>, enabled: boolean) {
  const [catalog] = useState(() => createPromptCatalog(read))
  const [snapshot, setSnapshot] = useState(catalog.snapshot)
  useEffect(() => {
    const unsubscribe = catalog.subscribe(setSnapshot)
    if (enabled) { catalog.activate(); void catalog.load() }
    else catalog.clear()
    return () => { unsubscribe(); catalog.clear() }
  }, [catalog, enabled])
  // Hide cached personal values in the very render which locks the owner,
  // before the effect clears the controller and rejects late responses.
  return { catalog, snapshot: enabled ? snapshot : lockedCatalog }
}
