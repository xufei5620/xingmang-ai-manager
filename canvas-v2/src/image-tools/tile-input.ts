/** A tile chooses one connection occurrence, never an asset's current array rank. */
export interface TileInputIdentity { edgeId: string; outputIndex?: number }
export type TileInputSelection = TileInputIdentity | { missing: true }
export type ParsedTileInputSelection = { edgeId: string; outputIndex: number } | { missing: true }

export const maximumTileInputOutputs = 20

export function parseTileInput(value: unknown): ParsedTileInputSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('平铺贴图选择格式不正确')
  const raw = value as Record<string, unknown>
  if (raw.missing === true && Object.keys(raw).length === 1) return { missing: true }
  if (Object.keys(raw).some((key) => key !== 'edgeId' && key !== 'outputIndex')
    || typeof raw.edgeId !== 'string' || !raw.edgeId || raw.edgeId.length > 256 || /[\u0000-\u001f\u007f]/.test(raw.edgeId)
    || (raw.outputIndex !== undefined && (typeof raw.outputIndex !== 'number' || !Number.isInteger(raw.outputIndex) || raw.outputIndex < 0 || raw.outputIndex >= maximumTileInputOutputs))) throw new Error('平铺贴图的连线或批次位置无效')
  return { edgeId: raw.edgeId, outputIndex: raw.outputIndex === undefined ? 0 : raw.outputIndex as number }
}

export function parseNodeTileInput(nodeKind: string, value: unknown): ParsedTileInputSelection | undefined {
  if (value === undefined) return undefined
  if (nodeKind !== 'image-tile') throw new Error('只有平铺图片节点可以选择贴图输入')
  return parseTileInput(value)
}

/** Preserve a missing explicit choice instead of falling back to another input. */
export function selectTileInputEdge<T extends { id: string }>(selection: TileInputSelection | undefined, incomingEdges: readonly T[]): { edge: T; outputIndex: number } | null {
  if (selection === undefined) return incomingEdges.length ? { edge: incomingEdges[0], outputIndex: 0 } : null
  const parsed = parseTileInput(selection)
  if ('missing' in parsed) throw new Error('已选平铺贴图已移除，请重新选择贴图')
  const edge = incomingEdges.find((candidate) => candidate.id === parsed.edgeId)
  if (!edge) throw new Error('已选平铺贴图的连线已移除，请重新选择贴图')
  return { edge, outputIndex: parsed.outputIndex }
}

export interface TileInputReference {
  edgeId: string
  outputIndex?: number
  kind: string
  status: string
  batch?: boolean
}

export interface TileInputSlot<T> {
  /** Absent only for an asset-free portable tombstone. */
  edgeId?: string
  outputIndex: number
  reference?: T
  pending: boolean
  missing: boolean
}

export interface ResolvedTileInput<T> {
  slots: TileInputSlot<T>[]
  selectedIndex: number
  selected: TileInputSlot<T> | null
  explicit: boolean
}

export function tileInputIdentityKey(identity: TileInputIdentity): string {
  return JSON.stringify([identity.edgeId, identity.outputIndex ?? 0])
}

/** Keep waiting occurrences in the pool before resolving a stable selection. */
export function resolveTileInputSlots<T extends TileInputReference>(references: readonly T[], selection?: TileInputSelection): ResolvedTileInput<T> {
  const counts = new Map<string, number>(), seen = new Set<string>()
  const slots: TileInputSlot<T>[] = []
  for (const reference of references) {
    if (reference.kind !== 'image') continue
    const outputIndex = reference.outputIndex ?? counts.get(reference.edgeId) ?? 0
    counts.set(reference.edgeId, Math.max(counts.get(reference.edgeId) ?? 0, outputIndex + 1))
    const key = tileInputIdentityKey({ edgeId: reference.edgeId, outputIndex })
    if (seen.has(key)) continue
    seen.add(key)
    slots.push({ edgeId: reference.edgeId, outputIndex, reference, pending: reference.status !== 'ready', missing: false })
  }
  if (selection === undefined) return { slots, selectedIndex: slots.length ? 0 : -1, selected: slots[0] ?? null, explicit: false }
  const parsed = parseTileInput(selection)
  let selectedIndex = 'missing' in parsed ? -1 : slots.findIndex((slot) => slot.edgeId === parsed.edgeId && slot.outputIndex === parsed.outputIndex)
  if (selectedIndex < 0) {
    const waiting = 'missing' in parsed ? undefined : slots.find((slot) => slot.edgeId === parsed.edgeId && slot.reference?.batch && slot.pending)
    const placeholder: TileInputSlot<T> = {
      ...('missing' in parsed ? {} : { edgeId: parsed.edgeId }),
      outputIndex: 'missing' in parsed ? 0 : parsed.outputIndex,
      ...(waiting?.reference ? { reference: waiting.reference } : {}),
      pending: Boolean(waiting),
      missing: !waiting,
    }
    let lastSibling = -1
    if (!('missing' in parsed)) for (let index = 0; index < slots.length; index += 1) if (slots[index].edgeId === parsed.edgeId) lastSibling = index
    selectedIndex = lastSibling < 0 ? slots.length : lastSibling + 1
    slots.splice(selectedIndex, 0, placeholder)
  }
  return { slots, selectedIndex, selected: slots[selectedIndex], explicit: true }
}

/** Only retained input edges may carry their identity into reusable content. */
export function remapTileInputSettings(value: unknown, edgeIds: ReadonlyMap<string, string>, defaultEdgeId?: string): Record<string, unknown> | undefined {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) return undefined
  const settings = (value ?? {}) as Record<string, unknown>
  if (settings.tileInput === undefined && !defaultEdgeId) return value === undefined ? undefined : settings
  // Retained default input order already carries legacy single-image semantics.
  if (settings.tileInput === undefined && defaultEdgeId && edgeIds.has(defaultEdgeId)) return value === undefined ? undefined : settings
  const selection = parseTileInput(settings.tileInput === undefined ? { edgeId: defaultEdgeId } : settings.tileInput)
  if ('missing' in selection) return { ...settings, tileInput: selection }
  const edgeId = edgeIds.get(selection.edgeId)
  return { ...settings, tileInput: edgeId ? { edgeId, outputIndex: selection.outputIndex } : { missing: true } }
}
