export interface VideoReferenceIdentity { edgeId: string; outputIndex: number }
export interface VideoReferenceOrder { version: 1; slots: VideoReferenceIdentity[] }

export const maximumVideoReferenceSlots = 12

export function videoReferenceIdentityKey(slot: VideoReferenceIdentity): string {
  return JSON.stringify([slot.edgeId, slot.outputIndex])
}

export function parseVideoReferenceOrder(value: unknown): VideoReferenceOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('视频参考顺序格式不正确')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['version', 'slots'].includes(key)) || raw.version !== 1 || !Array.isArray(raw.slots) || raw.slots.length > maximumVideoReferenceSlots) throw new Error('视频参考顺序最多保存 12 个素材位置')
  const seen = new Set<string>()
  const slots = raw.slots.map((value): VideoReferenceIdentity => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('视频参考位置格式不正确')
    const slot = value as Record<string, unknown>
    if (Object.keys(slot).some((key) => !['edgeId', 'outputIndex'].includes(key)) || typeof slot.edgeId !== 'string' || !slot.edgeId || slot.edgeId.length > 256 || /[\u0000-\u001f\u007f]/.test(slot.edgeId)
      || typeof slot.outputIndex !== 'number' || !Number.isInteger(slot.outputIndex) || slot.outputIndex < 0 || slot.outputIndex >= 20) throw new Error('视频参考的连线或批次位置无效')
    const parsed = { edgeId: slot.edgeId, outputIndex: slot.outputIndex }
    const key = videoReferenceIdentityKey(parsed)
    if (seen.has(key)) throw new Error('视频参考顺序不能包含重复位置')
    seen.add(key)
    return parsed
  })
  return { version: 1, slots }
}

export function parseNodeVideoReferenceOrder(kind: string, value: unknown): VideoReferenceOrder | undefined {
  if (value === undefined) return undefined
  if (kind !== 'video' && kind !== 'video-generate') throw new Error('只有视频生成节点支持视频参考顺序')
  return parseVideoReferenceOrder(value)
}

/** Keep distinct reference slots even when they use the same asset. */
export function orderVideoReferences<T extends VideoReferenceIdentity>(inputs: readonly T[], order: VideoReferenceOrder | undefined): T[] {
  if (!order) return [...inputs]
  const rank = new Map(order.slots.map((slot, index) => [videoReferenceIdentityKey(slot), index]))
  return inputs.map((input, index) => ({ input, index, rank: rank.get(videoReferenceIdentityKey(input)) ?? order.slots.length + index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ input }) => input)
}

export function assertVideoReferenceSlots(inputs: readonly VideoReferenceIdentity[], order: VideoReferenceOrder | undefined): void {
  const keys = new Set(inputs.map(videoReferenceIdentityKey))
  if (order?.slots.some((slot) => !keys.has(videoReferenceIdentityKey(slot)))) throw new Error('已保存的视频参考位置缺失，请核对首尾帧并重新确认参考顺序；当前不会提交生成')
}

export function videoReferenceOrderFromSlots(slots: readonly VideoReferenceIdentity[]): VideoReferenceOrder {
  return parseVideoReferenceOrder({ version: 1, slots })
}

export function remapVideoReferenceOrderSettings(value: unknown, edgeIds: ReadonlyMap<string, string>): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const settings = value as Record<string, unknown>
  if (settings.videoReferenceOrder === undefined) return settings
  const order = parseVideoReferenceOrder(settings.videoReferenceOrder)
  return { ...settings, videoReferenceOrder: { version: 1, slots: order.slots.flatMap((slot) => {
    const edgeId = edgeIds.get(slot.edgeId)
    return edgeId ? [{ edgeId, outputIndex: slot.outputIndex }] : []
  }) } satisfies VideoReferenceOrder }
}
