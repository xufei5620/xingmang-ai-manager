import { imageModelPreset, videoModelPreset } from '../models'

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
