import type { ImageReferenceOrder } from '../commerce/image-reference-order'
import type { ImageRequestParametersInput } from '../runtime/image-request-parameters'
import type { CanvasRunGraph } from '../host'
import { validateTextImageInputConfiguration } from '../runtime/text-image-input'

export type ExteriorWeather = 'none' | 'overcast' | 'rainy' | 'snowy' | 'sunny'
export type ExteriorTime = 'none' | 'dawn' | 'noon' | 'evening' | 'night'
export type ExteriorEnvironment = 'none' | 'jiangnan' | 'urban' | 'coast' | 'mountain-city' | 'historic-city' | 'european-street' | 'river-bank' | 'desert-oasis' | 'tropical' | 'mountain-retreat' | 'market-street' | 'japanese-street'
export type ExteriorDistant = 'none' | 'sea' | 'river' | 'mountain' | 'forest' | 'city' | 'snow-mountain'
export type ExteriorTask = { version: 1 } & (
  { kind: 'exterior-render'; addPeople: boolean; motionBlur: boolean; interiorLighting: boolean; lightTemperature: 3000 | 4000 | 6000; weather: ExteriorWeather; time: ExteriorTime; environment: ExteriorEnvironment; distant: ExteriorDistant }
  | { kind: 'exterior-redraw'; useToneReference: boolean }
  | { kind: 'landscape-redesign' | 'facade-renovation' | 'exterior-style-transfer' | 'storefront-redesign'; automaticPrompt: boolean }
)
export type ExteriorTaskKind = ExteriorTask['kind']
export const exteriorTaskLabels: Readonly<Record<ExteriorTaskKind, string>> = { 'exterior-render': '室外一键渲染', 'exterior-redraw': '室外重绘', 'landscape-redesign': '景观改造', 'facade-renovation': '建筑立面改造', 'exterior-style-transfer': '室外风格迁移', 'storefront-redesign': '门头改造' }
export const exteriorTaskKinds = Object.keys(exteriorTaskLabels) as ExteriorTaskKind[]
export const exteriorTaskToggleOptions: readonly { key: 'addPeople' | 'motionBlur' | 'interiorLighting'; label: string; instruction: string }[] = [
  { key: 'addPeople', label: '增加人物', instruction: '加入尺度、视角与场景用途合理的自然人物，不遮挡建筑主体。' },
  { key: 'motionBlur', label: '动态模糊', instruction: '为移动的人物或车辆添加适度动态模糊，保持建筑与固定景物清晰。' },
  { key: 'interiorLighting', label: '室内灯光', instruction: '在原有合理窗洞中呈现协调的室内灯光，不改变建筑开口。' },
]
export const exteriorLightTemperatureOptions = [3000, 4000, 6000].map((value) => ({ value: value as 3000 | 4000 | 6000, label: `${value}K`, instruction: `人工灯光色温方向为约 ${value}K，与环境明暗协调。` }))
export const exteriorWeatherOptions: readonly { value: ExteriorWeather; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, { value: 'overcast', label: '阴天', instruction: '环境为阴天，以柔和漫射天光呈现。' }, { value: 'rainy', label: '雨天', instruction: '环境为雨天，地面和材质适度体现湿润与反射。' }, { value: 'snowy', label: '雪天', instruction: '环境为雪天，积雪与建筑和景观的空间关系合理。' }, { value: 'sunny', label: '晴天', instruction: '环境为晴天，自然光照与所选时段协调。' },
]
export const exteriorTimeOptions: readonly { value: ExteriorTime; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, { value: 'dawn', label: '清晨', instruction: '以清晨的天光亮度与色彩呈现。' }, { value: 'noon', label: '正午', instruction: '以正午的天光亮度与光照呈现。' }, { value: 'evening', label: '傍晚', instruction: '以傍晚的天光亮度和暖色层次呈现。' }, { value: 'night', label: '深夜', instruction: '以深夜的环境亮度与建筑照明关系呈现。' },
]
export const exteriorEnvironmentOptions: readonly { value: ExteriorEnvironment; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, ...([
    ['jiangnan', '江南水乡'], ['urban', '都市城区'], ['coast', '滨海环境'], ['mountain-city', '山城环境'], ['historic-city', '历史古城'], ['european-street', '欧洲街区'], ['river-bank', '江河沿岸'], ['desert-oasis', '沙漠绿洲'], ['tropical', '热带环境'], ['mountain-retreat', '山间隐居'], ['market-street', '市井街区'], ['japanese-street', '日式街道'],
  ] as const).map(([value, label]) => ({ value, label, instruction: `周边环境方向为${label}，与原建筑比例、地形和相机视角协调。` })),
]
export const exteriorDistantOptions: readonly { value: ExteriorDistant; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, ...([['sea', '海景'], ['river', '江景'], ['mountain', '山景'], ['forest', '森林'], ['city', '城市'], ['snow-mountain', '雪山']] as const).map(([value, label]) => ({ value, label, instruction: `远景方向为${label}，保持合理的景深、尺度与地平线。` })),
]
export function defaultExteriorTask(kind: ExteriorTaskKind): ExteriorTask {
  if (kind === 'exterior-render') return { version: 1, kind, addPeople: true, motionBlur: true, interiorLighting: true, lightTemperature: 3000, weather: 'overcast', time: 'dawn', environment: 'none', distant: 'none' }
  if (kind === 'exterior-redraw') return { version: 1, kind, useToneReference: false }
  if (!Object.hasOwn(exteriorTaskLabels, kind)) throw new Error('室外任务类型不受支持')
  return { version: 1, kind, automaticPrompt: true }
}
export function parseExteriorTask(value: unknown): ExteriorTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('室外创作配置格式不正确')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || typeof raw.kind !== 'string' || !Object.hasOwn(exteriorTaskLabels, raw.kind)) throw new Error('室外创作版本或类型不受支持')
  const initial = defaultExteriorTask(raw.kind as ExteriorTaskKind), keys = Object.keys(initial)
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((key) => !keys.includes(key))) throw new Error('室外创作含未知或缺少必要配置')
  if (initial.kind === 'exterior-render') {
    if (exteriorTaskToggleOptions.some(({ key }) => typeof raw[key] !== 'boolean') || !exteriorLightTemperatureOptions.some(({ value }) => value === raw.lightTemperature)
      || !exteriorWeatherOptions.some(({ value }) => value === raw.weather) || !exteriorTimeOptions.some(({ value }) => value === raw.time) || !exteriorEnvironmentOptions.some(({ value }) => value === raw.environment) || !exteriorDistantOptions.some(({ value }) => value === raw.distant)) throw new Error('室外渲染开关、色温或环境参数不受支持')
  } else if (initial.kind === 'exterior-redraw') { if (typeof raw.useToneReference !== 'boolean') throw new Error('色调参考开关必须为明确的开启或关闭') }
  else if (typeof raw.automaticPrompt !== 'boolean') throw new Error('自动提示开关必须为明确的开启或关闭')
  return structuredClone(raw) as ExteriorTask
}
export function parseNodeExteriorTask(kind: string, value: unknown): ExteriorTask { if (!['image', 'image-generate', 'image-edit'].includes(kind)) throw new Error('此节点不支持室外创作任务'); return parseExteriorTask(value) }
export function exteriorTaskRoles(value: ExteriorTask): readonly ('source' | 'reference')[] { const task = parseExteriorTask(value); return task.kind === 'exterior-render' || task.kind === 'exterior-redraw' && !task.useToneReference ? ['source'] : ['source', 'reference'] }
export function exteriorTaskUsesAnalysis(value: ExteriorTask): boolean { const task = parseExteriorTask(value); return 'automaticPrompt' in task && task.automaticPrompt }
export function buildExteriorTaskPrompt(value: ExteriorTask, supplement: string): string {
  const task = parseExteriorTask(value)
  const lines = [`【${exteriorTaskLabels[task.kind]}】`, '第 1 张参考图是唯一原始建筑或场地主体。以原图为主体，优先保持建筑身份、结构、体量、相机位置、透视和主要构图。']
  if (task.kind === 'exterior-render') {
    for (const option of exteriorTaskToggleOptions) if (task[option.key]) lines.push(option.instruction)
    if (task.interiorLighting) lines.push(exteriorLightTemperatureOptions.find(({ value }) => value === task.lightTemperature)!.instruction)
    for (const [key, options] of [['weather', exteriorWeatherOptions], ['time', exteriorTimeOptions], ['environment', exteriorEnvironmentOptions], ['distant', exteriorDistantOptions]] as const) { const instruction = options.find(({ value }) => value === task[key])?.instruction; if (instruction) lines.push(instruction) }
    lines.push('以上环境与色温通过文字指令表达，不是模型原生物理参数。关闭或未指定的选项不要求删除原有内容。')
  } else if (task.kind === 'exterior-redraw') { lines.push('改善室外建筑与场地的材质、细节、光影和整体表现，不把重绘解释为尺寸放大或原生降噪参数。'); if (task.useToneReference) lines.push('第 2 张参考图仅提供色调与光影方向，不替换第 1 张图的建筑与场地。') }
  else {
    const directions = { 'landscape-redesign': '以第 2 张图为景观材质、植被与空间氛围参考，改造第 1 张场地的景观。', 'facade-renovation': '以第 2 张图为立面语言与材料参考，改造第 1 张建筑立面，保留主体结构与必要开口。', 'exterior-style-transfer': '将第 2 张图的视觉风格、材质和光影应用于第 1 张图，保留原建筑身份与透视。', 'storefront-redesign': '以第 2 张图为门头设计与材质参考，改造第 1 张店铺门头，保留店铺开口、尺度和结构。' }
    lines.push(directions[task.kind], '第 2 张图只提供明确的风格或设计参考，不替换第 1 张图的主体。')
  }
  if (supplement.trim()) lines.push('补充要求：', supplement)
  return lines.join('\n')
}
export function buildExteriorAnalysisPrompt(value: ExteriorTask): string {
  const task = parseExteriorTask(value)
  if (!exteriorTaskUsesAnalysis(task)) throw new Error('此室外任务没有启用自动提示')
  return `分析两张已明确排序的参考图，为「${exteriorTaskLabels[task.kind]}」编写具体、可执行的中文图像编辑要求。第1张是必须保留建筑身份、结构与视角的原始主体；第2张只提供该任务的设计、材质、色调或风格参考。比较可见差异，避免编造不可见结构，不复制参考图的建筑身份。只返回创作要求，不发起图像生成。`
}
export function resolveExteriorImageRequest(task: ExteriorTask, input: ImageRequestParametersInput): ImageRequestParametersInput { if ('automaticPrompt' in task && !task.automaticPrompt && !input.prompt.trim()) throw new Error('关闭自动提示后，请填写明确的室外创作要求'); return { ...input, prompt: buildExteriorTaskPrompt(task, input.prompt) } }
export function assertExteriorTaskConfiguration(task: ExteriorTask | undefined, order: ImageReferenceOrder | undefined, commerceTask?: unknown, interiorTask?: unknown): void {
  if (task === undefined) return
  const value = parseExteriorTask(task)
  if (commerceTask !== undefined || interiorTask !== undefined) throw new Error('室外、室内与商品创作不能同时配置在同一节点')
  const roles = exteriorTaskRoles(value)
  if (!order || order.slots.length !== roles.length || order.slots.some((slot, index) => slot.role !== roles[index])) throw new Error('室外任务需要明确绑定对应的原图和参考图角色')
}
/** Automatic prompting must remain an explicit, source-matched visual text node. */
export function assertExteriorAnalysisConfiguration(node: CanvasRunGraph['nodes'][number], edges: readonly CanvasRunGraph['edges'][number][], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>): void {
  if (!node.data.exteriorTask || !exteriorTaskUsesAnalysis(node.data.exteriorTask)) return
  const text = edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:text')
  const analysis = text.length === 1 ? nodes.get(text[0].source) : undefined
  if (!analysis || text[0].sourceHandle !== 'out:text' || analysis.kind !== 'text-generate' || analysis.disabled || analysis.data.textWebSearch || analysis.data.prompt !== buildExteriorAnalysisPrompt(node.data.exteriorTask)) throw new Error('自动提示需要唯一、可用的显式图片分析节点，请重新配置室外任务')
  validateTextImageInputConfiguration(analysis.data.model, 2)
  const allowed = new Set(analysis.data.imageReferenceOrder?.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []) ?? [])
  if (edges.some((edge) => edge.target === analysis.id && (edge.targetHandle !== 'in:images' || !allowed.has(edge.id)))) throw new Error('自动提示分析存在未分配的图片或额外文字输入，请重新配置')
  function identities(target: CanvasRunGraph['nodes'][number]): string {
    const slots = target.data.imageReferenceOrder?.slots
    if (!slots || slots.length !== 2 || slots.some((slot, index) => slot.role !== (index === 0 ? 'source' : 'reference'))) throw new Error('自动提示图片角色尚未绑定，请重新配置')
    return JSON.stringify(slots.map((slot) => { const edge = 'edgeId' in slot ? edges.find((edge) => edge.id === slot.edgeId && edge.target === target.id && edge.targetHandle === 'in:images') : undefined; if (!edge || !['out:image', 'out:images'].includes(edge.sourceHandle) || !('outputIndex' in slot)) throw new Error('自动提示原图或参考图已失联'); return [slot.role, edge.source, edge.sourceHandle, slot.outputIndex] }))
  }
  if (identities(node) !== identities(analysis)) throw new Error('自动提示仍绑定另一组图片，请重新配置；不会使用旧图分析')
}
