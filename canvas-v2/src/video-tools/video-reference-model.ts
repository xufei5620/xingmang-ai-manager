import { videoRequestParameters, type VideoRequestMode, type VideoProtocol, type VideoRequestProvider } from '../lib/video-request-protocol'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { orderVideoReferences, parseVideoReferenceOrder, videoReferenceIdentityKey, videoReferenceOrderFromSlots, type VideoReferenceIdentity, type VideoReferenceOrder } from './video-reference-order'

export interface VideoReferenceItem extends VideoReferenceIdentity {
  key: string
  reference?: UpstreamMediaReference
  kind: 'image' | 'audio' | 'video' | 'unknown'
  label: string
  role: string
  missing: boolean
  pending: boolean
  dynamic: boolean
}

export interface VideoReferencePresentation {
  items: VideoReferenceItem[]
  mode?: Exclude<VideoRequestMode, 'auto'>
  modeLabel: string
  firstLast: boolean
  emptyRoles: string[]
  issues: string[]
  /** Certain errors only. Pending upstream outputs may still be executed first. */
  blockingIssues: string[]
  reorderDisabledReason?: string
  canSwap: boolean
  dynamic: boolean
}

export interface VideoReferencePresentationInput {
  model: string
  videoProtocol?: VideoProtocol
  videoMode?: string
  references: readonly UpstreamMediaReference[]
  order?: VideoReferenceOrder
}

const modeLabels: Record<VideoRequestMode, string> = { auto: '自动', t2va: '文生视频', i2va: '首帧生成', fl2va: '首尾帧生成', l2va: '尾帧生成', ref2va: '多模态参考' }

function isVideoMode(value: string): value is VideoRequestMode {
  return Object.hasOwn(modeLabels, value)
}

/** Keep saved holes in their original positions; an old tail must never become a first frame implicitly. */
export function inspectVideoReferences(input: VideoReferencePresentationInput): VideoReferencePresentation {
  const issues: string[] = []
  const blockingIssues: string[] = []
  function block(message: string) { issues.push(message); blockingIssues.push(message) }
  let order: VideoReferenceOrder | undefined
  let invalidOrder = false
  try { order = input.order === undefined ? undefined : parseVideoReferenceOrder(input.order) }
  catch (error) { invalidOrder = true; block(error instanceof Error ? error.message : '视频素材顺序无效，请重新核对') }
  const legacyIndices = new Map<string, number>()
  const keys = new Set<string>()
  let duplicate = false
  const slots: VideoReferenceItem[] = input.references.map((reference) => {
    const fallbackIndex = legacyIndices.get(reference.edgeId) ?? 0
    legacyIndices.set(reference.edgeId, fallbackIndex + 1)
    const identity = { edgeId: reference.edgeId, outputIndex: reference.outputIndex ?? fallbackIndex }
    const key = videoReferenceIdentityKey(identity)
    if (keys.has(key)) duplicate = true
    keys.add(key)
    return { ...identity, key, reference, kind: reference.kind, label: reference.label, role: '', missing: false, pending: reference.status !== 'ready', dynamic: reference.batch === true && reference.batchSize === undefined }
  })
  for (const saved of order?.slots ?? []) {
    const key = videoReferenceIdentityKey(saved)
    if (keys.has(key)) continue
    const sibling = input.references.find((reference) => reference.edgeId === saved.edgeId)
    slots.push({ ...saved, key, kind: sibling?.kind ?? 'unknown', label: sibling ? `${sibling.label} · 第 ${saved.outputIndex + 1} 项` : '原输入连接已缺失', role: '', missing: true, pending: true, dynamic: sibling?.batch === true && sibling.batchSize === undefined })
    keys.add(key)
  }
  const items = orderVideoReferences(slots, order)
  const dynamic = items.some((item) => item.dynamic)
  const missing = items.some((item) => item.missing)
  const confirmedMissing = items.some((item) => item.missing && !item.dynamic)
  const imageCount = items.filter((item) => item.kind === 'image').length
  const audioCount = items.filter((item) => item.kind === 'audio').length
  const videoCount = items.filter((item) => item.kind === 'video').length
  let provider: VideoRequestProvider | undefined
  try { provider = videoRequestParameters({ model: input.model, videoProtocol: input.videoProtocol, prompt: '素材配置检查' }).provider }
  catch (error) { block(error instanceof Error ? error.message : '此视频模型暂不支持素材配置') }
  const rawMode = input.videoMode ?? 'auto'
  const validMode = isVideoMode(rawMode)
  if ((provider === 'minimax-h3' || provider === 'seedance') && !validMode) block('已保存的视频模式不受支持，请重新选择；原配置已保留')
  let mode: Exclude<VideoRequestMode, 'auto'> | undefined
  if (provider === 'grok-video' && !dynamic && !missing) mode = input.videoProtocol === 'xai-native' && validMode && rawMode !== 'auto' ? rawMode : imageCount > 0 ? 'i2va' : 't2va'
  else if ((provider === 'minimax-h3' || provider === 'seedance') && validMode) {
    if (rawMode !== 'auto') mode = rawMode
    else if (!dynamic && !missing) mode = audioCount > 0 || (videoCount > 0 && provider === 'seedance') || imageCount > 2 ? 'ref2va' : imageCount === 2 ? 'fl2va' : imageCount === 1 ? 'i2va' : 't2va'
  }
  if (provider && (validMode || provider === 'grok-video')) {
    // An unknown batch may satisfy a required minimum after its upstream runs.
    // Use that optimistic minimum only; known incompatible media and excess
    // positions must remain blocking even before the batch finishes.
    const requiredImages = rawMode === 'fl2va' ? 2 : rawMode === 'i2va' || rawMode === 'l2va' ? 1 : 0
    const validationImageCount = dynamic || missing ? Math.max(imageCount, requiredImages) : imageCount
    try { videoRequestParameters({ model: input.model, videoProtocol: input.videoProtocol, prompt: '素材配置检查', videoMode: isVideoMode(rawMode) ? rawMode : 'auto', imageCount: validationImageCount, audioCount, videoCount }) }
    catch (error) { block(error instanceof Error ? error.message : '视频参考素材与当前模式不匹配') }
  }
  if (dynamic) issues.push('整组输出数量尚未确定；上游完成后会核对实际素材和模式，当前不能调换顺序')
  if (confirmedMissing) block('已保存的素材位置缺失，已保留原位置；请恢复输入或明确移除失效位置后再运行')
  else if (missing) issues.push('已保存的整组位置等待上游产出，顺序保持不变')
  if (duplicate) block('输入位置重复，请核对连接；同一图片用于首尾帧时应使用两个不同输入位置')
  if (items.length > 12) block('视频参考素材最多保存 12 个位置，请先移除多余输入')
  if (items.some((item) => item.pending && !item.missing) && !dynamic) issues.push('部分素材尚未就绪，请先完成上游节点或重新选择素材')
  let imageIndex = 0, audioIndex = 0, videoIndex = 0
  for (const item of items) {
    if (item.kind === 'image' || item.kind === 'unknown' && mode === 'fl2va') {
      imageIndex += 1
      item.role = mode === 'fl2va' && imageIndex <= 2 ? imageIndex === 1 ? '首帧' : '尾帧'
        : mode === 'i2va' && imageIndex === 1 ? '首帧'
          : mode === 'l2va' && imageIndex === 1 ? '尾帧' : `参考图 ${imageIndex}`
    } else if (item.kind === 'audio') item.role = `参考音频 ${++audioIndex}`
    else if (item.kind === 'video') item.role = `参考视频 ${++videoIndex}${provider === 'seedance' ? '' : ' · 不支持'}`
    else item.role = `已保存位置 ${items.indexOf(item) + 1}`
  }
  const emptyRoles = mode === 'fl2va' ? ['首帧', '尾帧'].slice(Math.min(imageIndex, 2)) : (mode === 'i2va' || mode === 'l2va') && !imageIndex ? [mode === 'i2va' ? '首帧' : '尾帧'] : []
  const reorderDisabledReason = invalidOrder ? '请先修复无效的已保存顺序' : duplicate ? '输入位置重复，暂不能排序' : items.length > 12 ? '请先将输入减少至 12 项以内' : dynamic ? '整组数量尚未确定，暂不能排序' : undefined
  const canSwap = mode === 'fl2va' && imageIndex === 2 && items.length === 2 && !missing && !reorderDisabledReason
  const modeLabel = (provider === 'minimax-h3' || provider === 'seedance') && rawMode === 'auto' ? `自动 · ${mode ? modeLabels[mode] : '待素材就绪后确定'}` : mode ? modeLabels[mode] : provider && !validMode ? `已保存模式：${rawMode}` : provider ? '待素材就绪后确定' : '模型协议待确认'
  return { items, mode, modeLabel, firstLast: mode === 'fl2va', emptyRoles, issues: [...new Set(issues)], blockingIssues: [...new Set(blockingIssues)], reorderDisabledReason, canSwap, dynamic }
}

export function moveVideoReference(model: VideoReferencePresentation, key: string, delta: -1 | 1): VideoReferenceOrder | undefined {
  if (model.reorderDisabledReason) return undefined
  const from = model.items.findIndex((item) => item.key === key), to = from + delta
  if (from < 0 || to < 0 || to >= model.items.length) return undefined
  const items = [...model.items]
  items.splice(to, 0, items.splice(from, 1)[0])
  return videoReferenceOrderFromSlots(items.map(({ edgeId, outputIndex }) => ({ edgeId, outputIndex })))
}

export function swapVideoReferenceFrames(model: VideoReferencePresentation): VideoReferenceOrder | undefined {
  return model.canSwap ? videoReferenceOrderFromSlots([...model.items].reverse().map(({ edgeId, outputIndex }) => ({ edgeId, outputIndex }))) : undefined
}

export function removeMissingVideoReference(model: VideoReferencePresentation, key: string): VideoReferenceOrder | undefined {
  if (!model.items.some((item) => item.key === key && item.missing) || model.reorderDisabledReason && !model.dynamic) return undefined
  const remaining = model.items.filter((item) => item.key !== key)
  if (remaining.length > 12) return undefined
  return videoReferenceOrderFromSlots(remaining.map(({ edgeId, outputIndex }) => ({ edgeId, outputIndex })))
}
