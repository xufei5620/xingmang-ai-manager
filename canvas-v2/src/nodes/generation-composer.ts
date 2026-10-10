import { imageModelPreset, videoModelPreset, imageSizeLabel, imageQualityOptions, videoSizeOptions } from '../models'

export type ComposerToolbarField =
  | 'model'
  | 'quality'
  | 'imageResolution'
  | 'size'
  | 'seconds'
  | 'videoMode'
  | 'videoResolution'
  | 'videoAspectRatio'
  | 'promptOptimization'

const imageKinds = new Set(['image', 'image-generate', 'image-edit'])
const videoKinds = new Set(['video', 'video-generate'])

/** 点选生成节点后，底下那条生成条要露出哪些可改项。 */
export function composerToolbarFields(kind: string, model: string): ComposerToolbarField[] {
  if (imageKinds.has(kind)) {
    const preset = imageModelPreset(model)
    const fields: ComposerToolbarField[] = ['model']
    if (preset.supportsQuality) fields.push('quality')
    fields.push('imageResolution')
    if (preset.supportsSize) fields.push('size')
    return fields
  }
  if (videoKinds.has(kind)) {
    const preset = videoModelPreset(model)
    if (preset.provider === 'minimax-h3') {
      return ['model', 'videoMode', 'videoResolution', 'videoAspectRatio', 'seconds', 'promptOptimization']
    }
    return ['model', 'size', 'seconds']
  }
  return []
}

export function isComposerKind(kind: string): boolean {
  return imageKinds.has(kind) || videoKinds.has(kind)
}

export function composerPromptPlaceholder(kind: string): string {
  return videoKinds.has(kind)
    ? '描述要生成的视频，可用 @ 引用上游素材'
    : '描述要生成的画面，可用 @ 引用上游素材'
}

export function composerFieldLabel(field: ComposerToolbarField, kind = ''): string {
  if (field === 'model') return '模型'
  if (field === 'quality') return '画质'
  if (field === 'imageResolution') return '清晰度'
  if (field === 'seconds') return '时长'
  if (field === 'videoMode') return '模式'
  if (field === 'videoResolution') return '分辨率'
  if (field === 'videoAspectRatio') return '比例'
  if (field === 'promptOptimization') return '优化'
  return kind.startsWith('video') ? '比例' : '尺寸'
}

/** How many param columns sit under the model row. Three image knobs share one
 *  line; everything else stays a two-column grid so leftovers do not look lost. */
export function composerParamColumns(fields: readonly ComposerToolbarField[]): 2 | 3 {
  const params = fields.filter((field) => field !== 'model' && field !== 'promptOptimization')
  return params.length === 3 ? 3 : 2
}

/** Same join the main-process executors use: upstream text, then the local box. */
export function composeGenerationPrompt(localPrompt: string, upstreamText?: string): string {
  return [upstreamText?.trim(), localPrompt.trim()].filter(Boolean).join('\n')
}

export function composeNodePromptFromGraph(
  nodeId: string,
  nodes: readonly { id: string; data: { prompt?: string } }[],
  edges: readonly { source: string; target: string; sourceHandle?: string | null }[],
): string {
  const local = nodes.find((node) => node.id === nodeId)?.data.prompt ?? ''
  const upstream = edges
    .filter((edge) => edge.target === nodeId && (edge.sourceHandle ?? '').startsWith('out:text'))
    .map((edge) => nodes.find((node) => node.id === edge.source)?.data.prompt?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n')
  // Keep the helper safe for callers that intentionally persist composed
  // prompts. A second pass must not prepend the same upstream text again.
  if (upstream && (local === upstream || local.startsWith(`${upstream}\n`))) return local
  return composeGenerationPrompt(local, upstream || undefined)
}

export function commitGenerationPrompts<T extends { id: string; type?: string; data: { prompt: string } }>(
  nodes: readonly T[],
  edges: readonly { source: string; target: string; sourceHandle?: string | null }[],
): T[] {
  let changed = false
  const next = nodes.map((node) => {
    if (!isComposerKind(node.type ?? '')) return node
    const prompt = composeNodePromptFromGraph(node.id, nodes, edges)
    if (!prompt || prompt === node.data.prompt) return node
    changed = true
    return { ...node, data: { ...node.data, prompt } }
  })
  return changed ? next : nodes as T[]
}

/** The collapsed row must describe the saved configuration, including an
 *  unsupported imported value, rather than silently showing another choice. */
export function composerParameterSummary(kind: string, model: string, data: {
  quality?: string
  imageResolution?: string
  size?: string
  seconds?: string
  settings?: Record<string, unknown>
}): string {
  if (imageKinds.has(kind)) {
    const preset = imageModelPreset(model)
    const resolution = data.imageResolution || '1K'
    const parts = [preset.resolutions.some((value) => value === resolution) ? resolution : `${resolution}（需调整）`]
    if (preset.supportsSize) {
      const size = data.size || preset.sizes[0]
      parts.unshift(preset.sizes.includes(size) ? imageSizeLabel(size).split(' · ')[0] : `${size}（已保存）`)
    }
    if (preset.supportsQuality) {
      const quality = data.quality || 'low'
      parts.push(imageQualityOptions.find((option) => option.value === quality)?.label ?? (quality === 'auto' ? '自动画质' : `${quality}（已保存）`))
    }
    return parts.join(' · ')
  }
  if (videoKinds.has(kind)) {
    const preset = videoModelPreset(model)
    const seconds = data.seconds || String(preset.defaultSeconds)
    if (preset.provider === 'minimax-h3') {
      const ratio = typeof data.settings?.videoAspectRatio === 'string' ? data.settings.videoAspectRatio : '16:9'
      const resolution = typeof data.settings?.videoResolution === 'string' ? data.settings.videoResolution : '720p'
      return [ratio, resolution, `${seconds} 秒`, ...(data.settings?.promptOptimization === true ? ['AI 优化'] : [])].join(' · ')
    }
    const size = data.size || preset.defaultSize
    const ratio = videoSizeOptions.find((option) => option.value === size)?.label.split(' · ')[0] ?? `${size}（需调整）`
    return `${ratio} · ${seconds} 秒`
  }
  return ''
}

/** Reconcile only model-dependent values. Prompt, references and unrelated
 *  settings remain intact, and the same patch is used by the persisted graph. */
export function generationModelChangePatch(kind: string, model: string, data: {
  imageResolution?: '1K' | '2K' | '4K'
  size?: string
  seconds?: string
}): { model: string; imageResolution?: '1K' | '2K' | '4K'; size?: string; seconds?: string } {
  if (imageKinds.has(kind)) {
    const preset = imageModelPreset(model)
    return {
      model,
      ...(!preset.resolutions.includes(data.imageResolution ?? '1K') ? { imageResolution: preset.resolutions[0] } : {}),
      ...(preset.supportsSize && !preset.sizes.includes(data.size ?? '') ? { size: preset.sizes[0] } : {}),
      ...(!preset.supportsSize ? { size: '1024x1024' } : {}),
    }
  }
  if (videoKinds.has(kind)) {
    const preset = videoModelPreset(model)
    const seconds = Number(data.seconds)
    return {
      model,
      ...(!preset.sizes.includes(data.size ?? '') ? { size: preset.defaultSize } : {}),
      ...(!Number.isInteger(seconds) || seconds < preset.minimumSeconds || seconds > preset.maximumSeconds
        ? { seconds: String(preset.defaultSeconds) } : {}),
    }
  }
  return { model }
}
