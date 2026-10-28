export type ImageReferenceRole = 'source' | 'reference'
export interface ImageReferenceIdentity { edgeId: string; outputIndex: number }
export type ImageReferenceSlot = { role: ImageReferenceRole } & (ImageReferenceIdentity | { missing: true })
export interface ImageReferenceOrder { version: 1; slots: ImageReferenceSlot[] }
const supportedKinds = new Set(['image', 'image-generate', 'image-edit', 'text-generate'])

export function imageReferenceIdentityKey(value: ImageReferenceIdentity): string { return JSON.stringify([value.edgeId, value.outputIndex]) }
export function parseImageReferenceOrder(value: unknown): ImageReferenceOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参考图片角色配置格式不正确')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || Object.keys(raw).some((key) => !['version', 'slots'].includes(key)) || !Array.isArray(raw.slots) || raw.slots.length < 1 || raw.slots.length > 4) throw new Error('参考图片角色需要 1 到 4 个位置，且版本须为 1')
  const seen = new Set<string>()
  const slots = raw.slots.map((value, index): ImageReferenceSlot => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参考图片位置格式不正确')
    const slot = value as Record<string, unknown>
    if (slot.role !== 'source' && slot.role !== 'reference' || slot.role !== (index === 0 ? 'source' : 'reference')) throw new Error('第一个参考位置必须是原图，其余位置必须是参考图')
    if (slot.missing === true) {
      if (Object.keys(slot).length !== 2 || Object.keys(slot).some((key) => !['role', 'missing'].includes(key))) throw new Error('缺失的参考图片位置不能携带旧连线或资产身份')
      return { role: slot.role, missing: true }
    }
    if (Object.keys(slot).length !== 3 || Object.keys(slot).some((key) => !['role', 'edgeId', 'outputIndex'].includes(key))
      || typeof slot.edgeId !== 'string' || !slot.edgeId || slot.edgeId.length > 256 || /[\u0000-\u001f\u007f]/.test(slot.edgeId)
      || typeof slot.outputIndex !== 'number' || !Number.isInteger(slot.outputIndex) || slot.outputIndex < 0 || slot.outputIndex >= 20) throw new Error('参考图片连线或批次位置无效')
    const parsed: ImageReferenceIdentity & { role: ImageReferenceRole } = { role: slot.role, edgeId: slot.edgeId, outputIndex: slot.outputIndex }
    const key = imageReferenceIdentityKey(parsed)
    if (seen.has(key)) throw new Error('参考图片不能重复使用同一连线位置')
    seen.add(key)
    return parsed
  })
  return { version: 1, slots }
}

export function parseNodeImageReferenceOrder(kind: string, value: unknown): ImageReferenceOrder {
  if (!supportedKinds.has(kind)) throw new Error('此节点不支持参考图片角色配置')
  return parseImageReferenceOrder(value)
}

/** An explicit slot is authoritative. Missing/new edges never silently change the first image. */
export function orderImageReferenceInputs<T extends ImageReferenceIdentity & { assetId?: string }>(inputs: readonly T[], value: ImageReferenceOrder, incomingEdgeIds?: readonly string[]): T[] {
  const order = parseImageReferenceOrder(value)
  const byKey = new Map(inputs.map((input) => [imageReferenceIdentityKey(input), input]))
  const configuredEdges = new Set(order.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
  if (incomingEdgeIds?.some((id) => !configuredEdges.has(id))) throw new Error('有新接入的参考图片尚未分配角色，请打开创作配置核对；不会自动加入模型请求')
  const usedAssets = new Set<string>()
  return order.slots.map((slot) => {
    const input = 'edgeId' in slot ? byKey.get(imageReferenceIdentityKey(slot)) : undefined
    if (!input) throw new Error(`${slot.role === 'source' ? '原图' : '参考图'}位置已失联或尚未就绪，请重新绑定；不会改用其他图片`)
    if (input.assetId) {
      if (usedAssets.has(input.assetId)) throw new Error('原图和参考图必须是不同的实际图片，请检查重复素材')
      usedAssets.add(input.assetId)
    }
    return input
  })
}

export interface ImageReferenceDescriptor { edgeId: string; kind: string; status: string; assetId?: string; outputIndex?: number }
export interface ResolvedImageReferenceSlot<T> { slot: ImageReferenceSlot; reference?: T; pending: boolean; missing: boolean }
export function resolveImageReferenceSlots<T extends ImageReferenceDescriptor>(references: readonly T[], value: ImageReferenceOrder | undefined): ResolvedImageReferenceSlot<T>[] {
  const counts = new Map<string, number>()
  const available = references.filter((reference) => reference.kind === 'image').map((reference) => {
    const outputIndex = reference.outputIndex ?? counts.get(reference.edgeId) ?? 0
    counts.set(reference.edgeId, outputIndex + 1)
    return { edgeId: reference.edgeId, outputIndex, reference }
  })
  const order = value === undefined ? { version: 1 as const, slots: available.slice(0, 4).map((reference, index) => ({ role: index === 0 ? 'source' as const : 'reference' as const, edgeId: reference.edgeId, outputIndex: reference.outputIndex })) } : parseImageReferenceOrder(value)
  return order.slots.map((slot) => {
    const exact = 'edgeId' in slot ? available.find((reference) => reference.edgeId === slot.edgeId && reference.outputIndex === slot.outputIndex) : undefined
    const waiting = !exact && 'edgeId' in slot ? available.find((reference) => reference.edgeId === slot.edgeId && reference.reference.status !== 'ready') : undefined
    const reference = exact?.reference ?? waiting?.reference
    return { slot, reference, pending: reference !== undefined && reference.status !== 'ready', missing: reference === undefined }
  })
}

export function remapImageReferenceOrderSettings(value: unknown, edgeIds: ReadonlyMap<string, string>): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const settings = value as Record<string, unknown>
  if (settings.imageReferenceOrder === undefined) return settings
  const order = parseImageReferenceOrder(settings.imageReferenceOrder)
  return { ...settings, imageReferenceOrder: { version: 1, slots: order.slots.map((slot): ImageReferenceSlot => {
    const edgeId = 'edgeId' in slot ? edgeIds.get(slot.edgeId) : undefined
    return edgeId && 'outputIndex' in slot ? { role: slot.role, edgeId, outputIndex: slot.outputIndex } : { role: slot.role, missing: true }
  }) } satisfies ImageReferenceOrder }
}

export function imageReferenceRolePrompt(value: ImageReferenceOrder, prompt: string): string {
  const order = parseImageReferenceOrder(value)
  return `${order.slots.map((slot, index) => `第 ${index + 1} 张图片：${slot.role === 'source' ? '原始主体图' : '辅助参考图'}。`).join('\n')}\n${prompt}`
}
