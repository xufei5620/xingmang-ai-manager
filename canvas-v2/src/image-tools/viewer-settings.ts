import type { CompareMode, CompareViewState } from './compare-view-state'

export const maximumCompareInputSlots = 200
export type CompareInputSelection = string | null
export interface ImageCompareSettings {
  mode: CompareMode
  position?: number
  a?: CompareInputSelection
  b?: CompareInputSelection
  c?: CompareInputSelection
  sideBySideCount?: 2 | 3
  opacity?: number
  overlayVisible?: boolean
  grid?: CompareInputSelection[]
  /** Ordered edge/occurrence identities from the last committed view. */
  inputSlots?: string[]
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片对比设置无效')
  return value as Record<string, unknown>
}

function selection(value: unknown): CompareInputSelection {
  if (value === null || value === 'missing') return value
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})$/.test(value) || Number(value) >= maximumCompareInputSlots) throw new Error('图片对比选择必须是有效输入序号')
  return value
}

function slotParts(value: unknown): [string, number] {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('图片对比输入标识无效')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('图片对比输入标识无效') }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || !parsed[0] || parsed[0].length > 256
    || /[\u0000-\u001f\u007f]/.test(parsed[0]) || !Number.isInteger(parsed[1]) || parsed[1] < 0 || parsed[1] >= maximumCompareInputSlots
    || JSON.stringify(parsed) !== value) throw new Error('图片对比输入标识无效')
  return [parsed[0], parsed[1]]
}

function slots(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maximumCompareInputSlots) throw new Error('图片对比最多支持 200 个输入位置')
  const result = value.map((entry) => JSON.stringify(slotParts(entry)))
  if (new Set(result).size !== result.length) throw new Error('图片对比输入位置重复')
  return result
}

/** Keep a legacy { mode } unchanged; defaults belong to the viewer, not storage. */
export function parseImageCompareSettings(value: unknown): ImageCompareSettings {
  if (value === undefined) return { mode: 'slider' }
  const input = object(value)
  if (Object.keys(input).some((key) => !['mode', 'position', 'a', 'b', 'c', 'sideBySideCount', 'opacity', 'overlayVisible', 'grid', 'inputSlots'].includes(key))) throw new Error('图片对比设置包含不支持的字段')
  const mode = input.mode ?? 'slider'
  if (typeof mode !== 'string' || !['slider', 'side-by-side', 'grid', 'opacity', 'toggle'].includes(mode)) throw new Error('图片对比模式无效')
  const result: ImageCompareSettings = { mode: mode as CompareMode }
  if (input.position !== undefined) {
    if (typeof input.position !== 'number' || !Number.isFinite(input.position) || input.position < 0 || input.position > 100) throw new Error('图片对比滑杆位置必须在 0–100 之间')
    result.position = input.position
  }
  if (input.a !== undefined) result.a = selection(input.a)
  if (input.b !== undefined) result.b = selection(input.b)
  if (input.c !== undefined) result.c = selection(input.c)
  if (input.sideBySideCount !== undefined) {
    if (input.sideBySideCount !== 2 && input.sideBySideCount !== 3) throw new Error('并排对比仅支持两张或三张图片')
    result.sideBySideCount = input.sideBySideCount
  }
  if (input.opacity !== undefined) {
    if (typeof input.opacity !== 'number' || !Number.isFinite(input.opacity) || input.opacity < 0 || input.opacity > 100) throw new Error('图片对比透明度必须在 0–100 之间')
    result.opacity = input.opacity
  }
  if (input.overlayVisible !== undefined) {
    if (typeof input.overlayVisible !== 'boolean') throw new Error('图片对比叠加显示设置无效')
    result.overlayVisible = input.overlayVisible
  }
  if (input.grid !== undefined) {
    if (!Array.isArray(input.grid) || input.grid.length !== 4) throw new Error('四图对比需要四个明确的输入位置')
    result.grid = input.grid.map(selection)
  }
  if (input.inputSlots !== undefined) result.inputSlots = slots(input.inputSlots)
  return result
}

/** Include waiting slots too: readiness must never renumber later inputs. */
export function buildCompareInputSlots(references: readonly { edgeId: string }[]): string[] {
  if (references.length > maximumCompareInputSlots) throw new Error('图片对比最多支持 200 个输入位置')
  const occurrences = new Map<string, number>()
  return slots(references.map((reference) => {
    const occurrence = occurrences.get(reference.edgeId) ?? 0
    occurrences.set(reference.edgeId, occurrence + 1)
    return JSON.stringify([reference.edgeId, occurrence])
  }))
}

interface CompareInputReference {
  edgeId: string
  outputIndex?: number
  batch?: boolean
  batchSize?: number
  status: string
}

/** A connected, unproduced batch still owns its explicitly saved occurrences.
 * They are temporary waiting slots, not fabricated assets or new selections. */
export function resolveCompareInputReferences<T extends CompareInputReference>(references: readonly T[], value: unknown): { identity: string; outputIndex: number; reference: T; placeholder: boolean }[] {
  const settings = parseImageCompareSettings(value), occurrences = new Map<string, number>()
  const current = references.map((reference) => {
    const occurrence = occurrences.get(reference.edgeId) ?? 0
    occurrences.set(reference.edgeId, occurrence + 1)
    const outputIndex = reference.outputIndex ?? occurrence
    return { identity: JSON.stringify([reference.edgeId, outputIndex]), outputIndex, reference, placeholder: false }
  })
  const identities = new Set(current.map((slot) => slot.identity))
  for (const saved of settings.inputSlots ?? []) {
    if (identities.has(saved)) continue
    const [edgeId, outputIndex] = slotParts(saved)
    const reference = references.find((entry) => entry.edgeId === edgeId && entry.batch === true && entry.status !== 'ready' && (entry.batchSize === undefined || outputIndex < entry.batchSize))
    if (reference) { current.push({ identity: saved, outputIndex, reference, placeholder: true }); identities.add(saved) }
  }
  slots(current.map((slot) => slot.identity))
  return current
}

/** Missing is an explicit tombstone. Never retarget it to a new occupant. */
export function resolveImageCompareView(value: unknown, currentInputSlots: readonly string[]): CompareViewState {
  const settings = parseImageCompareSettings(value), current = slots(currentInputSlots)
  function resolve(saved: CompareInputSelection | undefined, fallback: number): CompareInputSelection {
    if (saved === undefined) return current[fallback] === undefined ? null : String(fallback)
    if (saved === null || saved === 'missing') return saved
    const index = Number(saved)
    if (!settings.inputSlots) return current[index] === undefined ? 'missing' : saved
    const identity = settings.inputSlots[index]
    const next = identity === undefined ? -1 : current.indexOf(identity)
    return next < 0 ? 'missing' : String(next)
  }
  return { mode: settings.mode, position: settings.position ?? 50, a: resolve(settings.a, 0), b: resolve(settings.b, 1), c: resolve(settings.c, 2), sideBySideCount: settings.sideBySideCount ?? 2, opacity: settings.opacity ?? 50, overlayVisible: settings.overlayVisible ?? true, grid: Array.from({ length: 4 }, (_, index) => resolve(settings.grid?.[index], index)) }
}

export function persistImageCompareView(view: CompareViewState, currentInputSlots: readonly string[]): ImageCompareSettings {
  return parseImageCompareSettings({ ...view, grid: [...view.grid], inputSlots: [...currentInputSlots] })
}

/** Copying rewrites edge IDs, but keeps occurrence order and unbound tombstones. */
export function remapImageCompareSettings(value: unknown, edgeIds: ReadonlyMap<string, string>): ImageCompareSettings {
  const settings = parseImageCompareSettings(value)
  if (!settings.inputSlots) return settings
  return parseImageCompareSettings({ ...settings, inputSlots: settings.inputSlots.map((slot) => {
    const [edgeId, occurrence] = slotParts(slot)
    return JSON.stringify([edgeIds.get(edgeId) ?? edgeId, occurrence])
  }) })
}

export function remapImageCompareNodeSettings(value: unknown, edgeIds: ReadonlyMap<string, string>): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const input = object(value)
  return input.imageCompare === undefined ? { ...input } : { ...input, imageCompare: remapImageCompareSettings(input.imageCompare, edgeIds) }
}

/** Standalone presets use positions. Group templates retain only remapped local
 * edge identities, including waiting batch occurrences; pixels are never needed. */
export function portableImageCompareSettings(value: unknown, edgeIds?: ReadonlyMap<string, string>): ImageCompareSettings {
  const parsed = parseImageCompareSettings(value)
  if (!edgeIds) { const { inputSlots: _inputSlots, ...settings } = parsed; return settings }
  if (!parsed.inputSlots) return parsed
  const retained = parsed.inputSlots.filter((slot) => edgeIds.has(slotParts(slot)[0]))
  const mapped = retained.map((slot) => { const [edge, index] = slotParts(slot); return JSON.stringify([edgeIds.get(edge)!, index]) })
  if (retained.length === parsed.inputSlots.length) return parseImageCompareSettings({ ...parsed, inputSlots: mapped })
  // Resolve defaults against the saved pool before removing edges. Otherwise an
  // omitted A source could silently become the old B after a partial selection.
  const original = persistImageCompareView(resolveImageCompareView(parsed, parsed.inputSlots), parsed.inputSlots)
  return persistImageCompareView(resolveImageCompareView(original, retained), mapped)
}
