import { buildImageRequestParameters, imageRequestModelControls, type ImageRequestParametersInput } from '../runtime/image-request-parameters'

export type CommercePreserve = 'shape' | 'color' | 'logo' | 'composition'
export type CommerceView = 'front' | 'back' | 'left' | 'right' | 'three-quarter' | 'top'
export type CommerceStyle = 'studio' | 'cinematic' | 'watercolor' | 'ink' | 'oil' | 'pencil' | 'flat' | 'clay' | 'paper' | 'retro' | 'pixel'
interface CommerceTaskBase { version: 1; preserve: CommercePreserve[] }
export type CommerceTask = CommerceTaskBase & (
  { kind: 'material-a'; strength: number }
  | { kind: 'material-b'; strength: number; upscale: number }
  | { kind: 'style-preset'; preset: CommerceStyle }
  | { kind: 'style-reference' }
  | { kind: 'product-view'; view: CommerceView }
)
export type CommerceTaskKind = CommerceTask['kind']

export const commercePreserveOptions: readonly { value: CommercePreserve; label: string }[] = [
  { value: 'shape', label: '商品形状' }, { value: 'color', label: '商品颜色' }, { value: 'logo', label: '标识与文字' }, { value: 'composition', label: '原有构图' },
]
export const commerceViews: readonly { value: CommerceView; label: string }[] = [
  { value: 'front', label: '正面' }, { value: 'back', label: '背面' }, { value: 'left', label: '左侧' },
  { value: 'right', label: '右侧' }, { value: 'three-quarter', label: '四分之三视角' }, { value: 'top', label: '俯视' },
]
export const commerceStylePresets: readonly { value: CommerceStyle; label: string; instruction: string }[] = [
  { value: 'studio', label: '清透棚拍', instruction: '清透影棚摄影，柔和轮廓光与干净背景，材质细节清晰' },
  { value: 'cinematic', label: '电影光影', instruction: '电影感明暗层次，克制色调与有方向的光线' },
  { value: 'watercolor', label: '轻盈水彩', instruction: '轻盈水彩笔触，透明叠色与自然纸张肌理' },
  { value: 'ink', label: '水墨写意', instruction: '水墨写意，墨色浓淡变化与适量留白' },
  { value: 'oil', label: '油画质感', instruction: '油画笔触，丰富色层与柔和的边缘过渡' },
  { value: 'pencil', label: '铅笔素描', instruction: '铅笔素描，清楚的结构线与细致排线明暗' },
  { value: 'flat', label: '平面插画', instruction: '平面插画，概括轮廓与协调的纯色色块' },
  { value: 'clay', label: '黏土微缩', instruction: '手作黏土微缩模型，柔软材质与精巧的体积感' },
  { value: 'paper', label: '剪纸叠层', instruction: '剪纸叠层造型，明确的纸张边缘与层叠阴影' },
  { value: 'retro', label: '复古印刷', instruction: '复古印刷视觉，有限配色与细微套印和纸张纹理' },
  { value: 'pixel', label: '像素图景', instruction: '像素艺术，明确的像素块与精简色阶' },
]
export const commerceTaskLabels: Readonly<Record<CommerceTaskKind, string>> = {
  'material-a': '材质优化 A', 'material-b': '材质优化 B', 'style-preset': '风格转绘', 'style-reference': '参考风格迁移', 'product-view': '商品多角度',
}
const imageKinds = new Set(['image', 'image-generate', 'image-edit'])

export function defaultCommerceTask(kind: CommerceTaskKind): CommerceTask {
  const preserve: CommercePreserve[] = kind === 'product-view' ? ['shape', 'color', 'logo'] : ['shape', 'color', 'logo', 'composition']
  if (kind === 'material-a') return { version: 1, kind, preserve, strength: 0.35 }
  if (kind === 'material-b') return { version: 1, kind, preserve, strength: 0.35, upscale: 1 }
  if (kind === 'style-preset') return { version: 1, kind, preserve, preset: 'studio' }
  if (kind === 'product-view') return { version: 1, kind, preserve, view: 'front' }
  if (kind === 'style-reference') return { version: 1, kind, preserve }
  throw new Error('创作任务类型不受支持')
}

export function parseCommerceTask(value: unknown): CommerceTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('创作任务配置格式不正确')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || typeof raw.kind !== 'string' || !Object.hasOwn(commerceTaskLabels, raw.kind)) throw new Error('创作任务版本或类型不受支持')
  const kind = raw.kind as CommerceTaskKind
  const extra = kind === 'material-a' ? ['strength'] : kind === 'material-b' ? ['strength', 'upscale'] : kind === 'style-preset' ? ['preset'] : kind === 'product-view' ? ['view'] : []
  const allowed = ['version', 'kind', 'preserve', ...extra]
  if (Object.keys(raw).length !== allowed.length || Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error('创作任务含未知或缺少必要的配置')
  if (!Array.isArray(raw.preserve) || raw.preserve.length > 4 || raw.preserve.some((entry) => !commercePreserveOptions.some((option) => option.value === entry)) || new Set(raw.preserve).size !== raw.preserve.length) throw new Error('保持项必须为不重复的商品形状、颜色、标识或构图')
  const preserve = raw.preserve as CommercePreserve[]
  if (kind === 'material-a' || kind === 'material-b') {
    if (typeof raw.strength !== 'number' || !Number.isFinite(raw.strength) || raw.strength < 0 || raw.strength > 1) throw new Error('优化强度必须在 0 到 1 之间')
    if (kind === 'material-a') return { version: 1, kind, preserve: [...preserve], strength: raw.strength }
    if (typeof raw.upscale !== 'number' || !Number.isFinite(raw.upscale) || raw.upscale < 1 || raw.upscale > 2) throw new Error('请求尺寸倍率必须在 1 到 2 之间')
    return { version: 1, kind, preserve: [...preserve], strength: raw.strength, upscale: raw.upscale }
  }
  if (kind === 'style-preset') {
    if (!commerceStylePresets.some((entry) => entry.value === raw.preset)) throw new Error('请选择支持的原创风格预设')
    return { version: 1, kind, preserve: [...preserve], preset: raw.preset as CommerceStyle }
  }
  if (kind === 'product-view') {
    if (!commerceViews.some((entry) => entry.value === raw.view)) throw new Error('请选择支持的商品视角')
    return { version: 1, kind, preserve: [...preserve], view: raw.view as CommerceView }
  }
  return { version: 1, kind, preserve: [...preserve] }
}

export function parseNodeCommerceTask(kind: string, value: unknown): CommerceTask {
  if (!imageKinds.has(kind)) throw new Error('此节点不支持商品与参考图创作任务')
  return parseCommerceTask(value)
}

/** The controls describe intent in prose; no unimplemented denoise/model field is emitted. */
export function buildCommerceTaskPrompt(value: CommerceTask, supplement: string): string {
  const task = parseCommerceTask(value)
  const lines = [`【${commerceTaskLabels[task.kind]}】`, '第 1 张参考图是原始商品或主体图片。']
  if (task.kind === 'material-a' || task.kind === 'material-b') lines.push(`优化表面材质、细节与光影。改变幅度意图为 ${Math.round(task.strength * 100)}%；这是文字指令，不是模型原生重绘参数。`)
  if (task.kind === 'style-preset') lines.push(commerceStylePresets.find((preset) => preset.value === task.preset)!.instruction)
  if (task.kind === 'style-reference') lines.push('第 2 张参考图仅提供视觉风格、材质和光影方向；将其风格应用到第 1 张主体图，不要替换主体身份。')
  if (task.kind === 'product-view') lines.push(`将同一商品表现为${commerceViews.find((view) => view.value === task.view)!.label}，保持商品身份与结构，不把参考图直接拼成多格。`)
  if (task.preserve.length) lines.push(`优先保持：${task.preserve.map((key) => commercePreserveOptions.find((option) => option.value === key)!.label).join('、')}。`)
  if (supplement.trim()) lines.push('补充要求：', supplement)
  return lines.join('\n')
}

export interface CommerceImageSize { width: number; height: number; size: string }
export function resolveCommerceTargetSize(value: CommerceTask, source: { width?: number; height?: number } | undefined): CommerceImageSize | undefined {
  const task = parseCommerceTask(value)
  if (task.kind !== 'material-b') return undefined
  if (!source || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width! < 1 || source.height! < 1 || source.width! > 16384 || source.height! > 16384) throw new Error('材质优化 B 需要核对原图的实际像素尺寸')
  const width = Math.round(source.width! * task.upscale), height = Math.round(source.height! * task.upscale)
  return { width, height, size: `${width}x${height}` }
}

export function resolveCommerceImageRequest(value: CommerceTask, input: ImageRequestParametersInput, source?: { width?: number; height?: number }): ImageRequestParametersInput {
  const task = parseCommerceTask(value)
  const next = { ...input, prompt: buildCommerceTaskPrompt(task, input.prompt) }
  const target = resolveCommerceTargetSize(task, source)
  if (target) {
    if (input.size !== 'auto' || input.imageResolution !== undefined && input.imageResolution !== '1K') throw new Error('材质优化 B 的尺寸由原图和倍率唯一决定，请保留自动尺寸与 1K 清晰度')
    const controls = imageRequestModelControls(input.model)
    const unavailable = `当前模型无法精确输出派生尺寸 ${target.size}；请更换原图、请求倍率或模型`
    if (!controls.supportsSize || controls.fixedSizes && !controls.fixedSizes.includes(target.size)) throw new Error(unavailable)
    next.size = target.size
    try {
      const body = buildImageRequestParameters(next)
      if (body.size !== target.size) throw new Error('模型返回的请求尺寸与倍率目标不一致')
    } catch (error) { throw new Error(`${unavailable}。${error instanceof Error ? error.message : '请核对模型的尺寸限制'}`) }
  }
  return next
}

export function assertCommerceOutputSize(task: CommerceTask | undefined, source: { width?: number; height?: number } | undefined, output: { width?: number; height?: number }): void {
  if (!task) return
  const target = resolveCommerceTargetSize(task, source)
  if (target && (output.width !== target.width || output.height !== target.height)) throw new Error(`模型已返回图片，但实际尺寸不是请求的 ${target.size}；本次不能标记为倍率处理成功，请核对原尝试，不要直接重复生成`)
}
