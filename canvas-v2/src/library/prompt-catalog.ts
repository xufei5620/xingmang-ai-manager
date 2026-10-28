import { applyPromptPresetOrder, parseCanvasPromptPreset, parseCanvasPromptPresets, parsePromptPresetOrder, sortPromptPresets, type CanvasPromptPreset } from './prompt-preset-contract'

export interface PromptCatalogSnapshot {
  items: readonly CanvasPromptPreset[]
  loading: boolean
  loaded: boolean
  error: string | null
}

/** One mounted workspace owns one catalog; neither module caches nor storage
 * retain personal prompts across account lifetimes. */
export function createPromptCatalog(read: () => Promise<unknown>, now: () => number = Date.now) {
  let snapshot: PromptCatalogSnapshot = { items: [], loading: false, loaded: false, error: null }
  let active = false
  let lifetime = 0
  let revision = 0
  let readAt = 0
  let pending: Promise<void> | null = null
  const listeners = new Set<(snapshot: PromptCatalogSnapshot) => void>()
  function publish(next: PromptCatalogSnapshot) { snapshot = next; for (const listener of listeners) listener(snapshot) }
  function invalidate() { revision++; pending = null }
  const catalog = {
    snapshot() { return snapshot },
    active() { return active },
    scope() { return lifetime },
    current(scope: number) { return active && scope === lifetime },
    subscribe(listener: (snapshot: PromptCatalogSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    activate() { if (!active) lifetime++; active = true },
    clear() { active = false; lifetime++; invalidate(); readAt = 0; publish({ items: [], loading: false, loaded: false, error: null }) },
    load(force = false): Promise<void> {
      if (!active) return Promise.resolve()
      if (pending && !force) return pending
      if (!force && snapshot.loaded && now() - readAt < 30_000) return Promise.resolve()
      const ticket = ++revision
      publish({ ...snapshot, loading: true, error: null })
      const request = Promise.resolve().then(() => active && ticket === revision ? read() : undefined).then((value) => {
        if (!active || ticket !== revision) return
        const items = sortPromptPresets(parseCanvasPromptPresets(value))
        readAt = now()
        publish({ items, loading: false, loaded: true, error: null })
      }).catch((error: unknown) => {
        if (active && ticket === revision) publish({ ...snapshot, loading: false, error: error instanceof Error ? error.message : '提示词暂时无法读取，请重试。' })
      }).finally(() => { if (ticket === revision) pending = null })
      pending = request
      return request
    },
    upsert(value: unknown) {
      if (!active) return
      const preset = parseCanvasPromptPreset(value)
      invalidate()
      // Invalidate an earlier read before publishing a confirmed mutation.
      // The following read starts after its receipt, so it cannot erase it.
      publish({ items: sortPromptPresets([preset, ...snapshot.items.filter((item) => item.id !== preset.id)]), loading: false, loaded: false, error: null })
      void catalog.load()
    },
    remove(id: string) {
      if (!active) return
      invalidate()
      publish({ items: snapshot.items.filter((item) => item.id !== id), loading: false, loaded: false, error: null })
      void catalog.load()
    },
    reordered(value: unknown) {
      if (!active) return
      const items = applyPromptPresetOrder(snapshot.items, parsePromptPresetOrder(value))
      invalidate()
      publish({ items, loading: false, loaded: false, error: null })
      void catalog.load()
    },
  }
  return catalog
}
