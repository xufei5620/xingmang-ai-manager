export interface CollageInputIdentity { edgeId: string; outputIndex: number }
export interface ImageCollageInputOrder { version: 1; slots: CollageInputIdentity[] }

export const maximumCollageOrderedInputs = 20

export function collageInputIdentityKey(slot: CollageInputIdentity): string {
  return JSON.stringify([slot.edgeId, slot.outputIndex])
}

export function parseImageCollageInputOrder(value: unknown): ImageCollageInputOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('拼图输入顺序格式不正确')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || !Array.isArray(raw.slots) || raw.slots.length > maximumCollageOrderedInputs) throw new Error('拼图输入顺序最多保存 20 张图片')
  const seen = new Set<string>()
  const slots = raw.slots.map((value): CollageInputIdentity => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('拼图输入位置格式不正确')
    const slot = value as Record<string, unknown>
    if (typeof slot.edgeId !== 'string' || !slot.edgeId || slot.edgeId.length > 256 || /[\u0000-\u001f\u007f]/.test(slot.edgeId)
      || typeof slot.outputIndex !== 'number' || !Number.isInteger(slot.outputIndex) || slot.outputIndex < 0 || slot.outputIndex >= maximumCollageOrderedInputs) throw new Error('拼图输入的连线或批次位置无效')
    const parsed = { edgeId: slot.edgeId, outputIndex: slot.outputIndex }
    const key = collageInputIdentityKey(parsed)
    if (seen.has(key)) throw new Error('拼图输入顺序不能包含重复位置')
    seen.add(key)
    return parsed
  })
  return { version: 1, slots }
}

/** Only order the complete current pool. Unseen outputs append; assets are never deduplicated. */
export function orderCollageInputs<T extends CollageInputIdentity>(inputs: readonly T[], order: ImageCollageInputOrder | undefined): T[] {
  if (!order) return [...inputs]
  const rank = new Map(order.slots.map((slot, index) => [collageInputIdentityKey(slot), index]))
  return inputs.map((input, index) => ({ input, index, rank: rank.get(collageInputIdentityKey(input)) ?? order.slots.length + index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ input }) => input)
}

export function moveCollageInput<T>(inputs: readonly T[], from: number, to: number): T[] {
  const next = [...inputs]
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= next.length || to >= next.length || from === to) return next
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

export function collageInputOrderFromSlots(slots: readonly CollageInputIdentity[]): ImageCollageInputOrder {
  return parseImageCollageInputOrder({ version: 1, slots })
}

export function remapCollageInputOrderSettings(value: unknown, edgeIds: ReadonlyMap<string, string>): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const settings = value as Record<string, unknown>
  if (settings.imageCollageInputOrder === undefined) return settings
  const order = parseImageCollageInputOrder(settings.imageCollageInputOrder)
  const { imageCollageInputOrder: ignored, ...rest } = settings
  const slots = order.slots.flatMap((slot) => {
    const edgeId = edgeIds.get(slot.edgeId)
    return edgeId ? [{ edgeId, outputIndex: slot.outputIndex }] : []
  })
  return slots.length ? { ...rest, imageCollageInputOrder: { version: 1, slots } satisfies ImageCollageInputOrder } : Object.keys(rest).length ? rest : undefined
}

export interface CollageInputReference { edgeId: string; kind: string; label: string; status: string }
export interface CollageInputSlot<T> extends CollageInputIdentity { reference: T; pending: boolean }

/** A batch without results has only one reference. Keep its saved occurrences as placeholders. */
export function resolveCollageInputSlots<T extends CollageInputReference>(references: readonly T[], order: ImageCollageInputOrder | undefined): CollageInputSlot<T>[] {
  const counts = new Map<string, number>()
  const slots = references.filter((reference) => reference.kind === 'image').map((reference) => {
    const outputIndex = counts.get(reference.edgeId) ?? 0
    counts.set(reference.edgeId, outputIndex + 1)
    return { edgeId: reference.edgeId, outputIndex, reference, pending: reference.status !== 'ready' }
  })
  const keys = new Set(slots.map(collageInputIdentityKey))
  for (const saved of order?.slots ?? []) {
    if (keys.has(collageInputIdentityKey(saved))) continue
    const waiting = slots.find((slot) => slot.edgeId === saved.edgeId && slot.pending)
    if (waiting) slots.push({ ...saved, reference: waiting.reference, pending: true })
  }
  return orderCollageInputs(slots, order)
}
