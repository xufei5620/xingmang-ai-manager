import type {
  CanvasCommercePreserve,
  CanvasCommerceStyle,
  CanvasCommerceTask,
  CanvasCommerceView,
  CanvasExteriorDistant,
  CanvasExteriorEnvironment,
  CanvasExteriorTask,
  CanvasExteriorTime,
  CanvasExteriorWeather,
  CanvasImageReferenceOrder,
  CanvasInteriorExterior,
  CanvasInteriorFilter,
  CanvasInteriorTask,
  CanvasInteriorTime,
  CanvasInteriorWeather,
  CanvasRunGraph,
  CanvasRunGraphNode,
  CanvasStoryboardTask,
} from './canvas-run-contract'
import { buildImageGenerationRequest, resolveAiModelCapability } from './ai-chat-protocol'
import { assertCanvasTextImageInput } from './canvas-text-image-input'
import { isRecord } from './input-guards'

// 画布完善第 8 条（场景入口）第二步：电商、室内、室外、故事板四种创作任务。规矩跟网页服务端同一套
// （xingmang-canvas lib/canvas-runs.ts 用的是内核 commerce/commerce-task.ts、interior/interior-task.ts、
// exterior/exterior-task.ts、storyboard/storyboard-task.ts 和 commerce/image-task-configuration.ts），
// 这里逐字照搬，canvas-scene-tasks.test.ts 跟内核那份对拍。画布只能在固定的选项里挑，提示词由主进程
// 用这里的固定句子拼，用户自己写的只当「补充要求」接在后面。

const sceneImageKinds = new Set(['image', 'image-generate', 'image-edit'])

// ---- 电商（commerce/commerce-task.ts）----

export type CanvasCommerceTaskKind = CanvasCommerceTask['kind']

const commercePreserveOptions: readonly { value: CanvasCommercePreserve; label: string }[] = [
  { value: 'shape', label: '商品形状' }, { value: 'color', label: '商品颜色' }, { value: 'logo', label: '标识与文字' }, { value: 'composition', label: '原有构图' },
]
const commerceViews: readonly { value: CanvasCommerceView; label: string }[] = [
  { value: 'front', label: '正面' }, { value: 'back', label: '背面' }, { value: 'left', label: '左侧' },
  { value: 'right', label: '右侧' }, { value: 'three-quarter', label: '四分之三视角' }, { value: 'top', label: '俯视' },
]
const commerceStylePresets: readonly { value: CanvasCommerceStyle; label: string; instruction: string }[] = [
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
const commerceTaskLabels: Readonly<Record<CanvasCommerceTaskKind, string>> = {
  'material-a': '材质优化 A', 'material-b': '材质优化 B', 'style-preset': '风格转绘', 'style-reference': '参考风格迁移', 'product-view': '商品多角度',
}

function commerceTaskKind(value: unknown): value is CanvasCommerceTaskKind {
  return typeof value === 'string' && Object.hasOwn(commerceTaskLabels, value)
}

function commercePreserve(value: unknown): value is CanvasCommercePreserve {
  return commercePreserveOptions.some((option) => option.value === value)
}

/** The kernel's parseCommerceTask, word for word. */
export function parseCanvasCommerceTask(value: unknown): CanvasCommerceTask {
  if (!isRecord(value)) throw new Error('创作任务配置格式不正确')
  if (value.version !== 1 || !commerceTaskKind(value.kind)) throw new Error('创作任务版本或类型不受支持')
  const kind = value.kind
  const extra = kind === 'material-a' ? ['strength'] : kind === 'material-b' ? ['strength', 'upscale'] : kind === 'style-preset' ? ['preset'] : kind === 'product-view' ? ['view'] : []
  const allowed = ['version', 'kind', 'preserve', ...extra]
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('创作任务含未知或缺少必要的配置')
  const raw = value.preserve
  if (!Array.isArray(raw) || raw.length > 4 || raw.some((entry) => !commercePreserve(entry)) || new Set(raw).size !== raw.length) throw new Error('保持项必须为不重复的商品形状、颜色、标识或构图')
  const preserve = raw.filter(commercePreserve)
  if (kind === 'material-a' || kind === 'material-b') {
    const strength = value.strength
    if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('优化强度必须在 0 到 1 之间')
    if (kind === 'material-a') return { version: 1, kind, preserve, strength }
    const upscale = value.upscale
    if (typeof upscale !== 'number' || !Number.isFinite(upscale) || upscale < 1 || upscale > 2) throw new Error('请求尺寸倍率必须在 1 到 2 之间')
    return { version: 1, kind, preserve, strength, upscale }
  }
  if (kind === 'style-preset') {
    const preset = commerceStylePresets.find((entry) => entry.value === value.preset)
    if (!preset) throw new Error('请选择支持的原创风格预设')
    return { version: 1, kind, preserve, preset: preset.value }
  }
  if (kind === 'product-view') {
    const view = commerceViews.find((entry) => entry.value === value.view)
    if (!view) throw new Error('请选择支持的商品视角')
    return { version: 1, kind, preserve, view: view.value }
  }
  return { version: 1, kind, preserve }
}

export function parseCanvasNodeCommerceTask(kind: string, value: unknown): CanvasCommerceTask {
  if (!sceneImageKinds.has(kind)) throw new Error('此节点不支持商品与参考图创作任务')
  return parseCanvasCommerceTask(value)
}

/** The kernel's buildCommerceTaskPrompt: the controls describe intent in prose. */
export function buildCanvasCommerceTaskPrompt(value: CanvasCommerceTask, supplement: string): string {
  const task = parseCanvasCommerceTask(value)
  const lines = [`【${commerceTaskLabels[task.kind]}】`, '第 1 张参考图是原始商品或主体图片。']
  if (task.kind === 'material-a' || task.kind === 'material-b') lines.push(`优化表面材质、细节与光影。改变幅度意图为 ${Math.round(task.strength * 100)}%；这是文字指令，不是模型原生重绘参数。`)
  if (task.kind === 'style-preset') lines.push(commerceStylePresets.find((preset) => preset.value === task.preset)?.instruction ?? '')
  if (task.kind === 'style-reference') lines.push('第 2 张参考图仅提供视觉风格、材质和光影方向；将其风格应用到第 1 张主体图，不要替换主体身份。')
  if (task.kind === 'product-view') lines.push(`将同一商品表现为${commerceViews.find((view) => view.value === task.view)?.label ?? ''}，保持商品身份与结构，不把参考图直接拼成多格。`)
  if (task.preserve.length) lines.push(`优先保持：${task.preserve.map((key) => commercePreserveOptions.find((option) => option.value === key)?.label ?? '').join('、')}。`)
  if (supplement.trim()) lines.push('补充要求：', supplement)
  return lines.join('\n')
}

export interface CanvasCommerceImageSize { width: number; height: number; size: string }

/** The kernel's resolveCommerceTargetSize: material B asks for the source's own pixels times the upscale. */
export function resolveCanvasCommerceTargetSize(value: CanvasCommerceTask, source: { width?: number; height?: number } | undefined): CanvasCommerceImageSize | undefined {
  const task = parseCanvasCommerceTask(value)
  if (task.kind !== 'material-b') return undefined
  const sourceWidth = source?.width
  const sourceHeight = source?.height
  if (sourceWidth === undefined || sourceHeight === undefined || !Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)
    || sourceWidth < 1 || sourceHeight < 1 || sourceWidth > 16384 || sourceHeight > 16384) throw new Error('材质优化 B 需要核对原图的实际像素尺寸')
  const width = Math.round(sourceWidth * task.upscale)
  const height = Math.round(sourceHeight * task.upscale)
  return { width, height, size: `${width}x${height}` }
}

/** The kernel's assertCommerceOutputSize: a picture of another size is not a material-B result. */
export function assertCanvasCommerceOutputSize(task: CanvasCommerceTask | undefined, source: { width?: number; height?: number } | undefined, output: { width?: number; height?: number }): void {
  if (!task) return
  const target = resolveCanvasCommerceTargetSize(task, source)
  if (target && (output.width !== target.width || output.height !== target.height)) throw new Error(`模型已返回图片，但实际尺寸不是请求的 ${target.size}；本次不能标记为倍率处理成功，请核对原尝试，不要直接重复生成`)
}

// ---- 室内（interior/interior-task.ts）----

type InteriorToggle = 'addDecor' | 'addPeople' | 'enclosedSpace' | 'interiorLighting'

const interiorTaskToggleOptions: readonly { key: InteriorToggle; instruction: string }[] = [
  { key: 'addDecor', instruction: '加入与空间尺度、用途协调的少量室内摆件。' },
  { key: 'addPeople', instruction: '加入尺度和透视合理的自然人物，不遮挡空间主体。' },
  { key: 'enclosedSpace', instruction: '以封闭室内空间呈现，保留建筑围合关系，不主动拆除墙面或顶棚。' },
  { key: 'interiorLighting', instruction: '加入合理的室内人工照明，保持灯光方向、阴影和空间关系协调。' },
]
const interiorWeatherOptions: readonly { value: CanvasInteriorWeather; instruction: string }[] = [
  { value: 'none', instruction: '' }, { value: 'overcast', instruction: '室外为阴天，使用柔和漫射自然光。' },
  { value: 'sunny', instruction: '室外为晴天，自然光与所选时段协调。' }, { value: 'rainy', instruction: '室外为雨天，窗外环境与室内反射体现湿润天气。' },
]
const interiorTimeOptions: readonly { value: CanvasInteriorTime; instruction: string }[] = [
  { value: 'none', instruction: '' }, { value: 'dawn', instruction: '以清晨的环境亮度与光色呈现。' },
  { value: 'noon-sun', instruction: '以正午直射日光呈现，光线仅从合理的开口进入。' },
  { value: 'noon-overcast', instruction: '以正午亮度呈现，避免明显的直射阳光光斑。' },
  { value: 'evening', instruction: '以傍晚的环境亮度与暖色天光呈现。' }, { value: 'night', instruction: '以深夜的窗外亮度和室内外光照关系呈现。' },
]
const interiorExteriorOptions: readonly { value: CanvasInteriorExterior; instruction: string }[] = [
  { value: 'none', instruction: '' }, { value: 'sea', instruction: '可见的窗外景观采用海景。' },
  { value: 'river', instruction: '可见的窗外景观采用江河景观。' }, { value: 'mountain', instruction: '可见的窗外景观采用山景。' },
  { value: 'garden', instruction: '可见的窗外景观采用庭院。' }, { value: 'city', instruction: '可见的窗外景观采用城市景观。' },
  { value: 'town', instruction: '可见的窗外景观采用小镇。' }, { value: 'snow-mountain', instruction: '可见的窗外景观采用雪山。' },
  { value: 'street', instruction: '可见的窗外景观采用街景。' },
]
const interiorFilterOptions: readonly { value: CanvasInteriorFilter; instruction: string }[] = [
  { value: 'none', instruction: '' }, { value: 'airy-japanese', instruction: '视觉方向为日式清新明亮，克制配色与柔和质感。' },
  { value: 'cool-nordic', instruction: '视觉方向为北欧清冷蓝调，干净明暗与低饱和冷色。' },
  { value: 'soft-cream', instruction: '视觉方向为柔和奶油色调，温润浅色与柔和明暗。' },
  { value: 'teal-orange', instruction: '视觉方向为克制的青橙电影色调，保持室内材质可辨。' },
  { value: 'dramatic', instruction: '视觉方向为高对比戏剧光，保留阴影中的空间细节。' },
  { value: 'film', instruction: '视觉方向为复古胶片质感与自然色层。' },
]

function pickOption<T extends string | number>(options: readonly { value: T }[], value: unknown): T | undefined {
  return options.find((option) => option.value === value)?.value
}

/** The kernel's parseInteriorTask, word for word. */
export function parseCanvasInteriorTask(value: unknown): CanvasInteriorTask {
  if (!isRecord(value)) throw new Error('室内创作配置格式不正确')
  const keys = ['version', 'kind', ...interiorTaskToggleOptions.map((option) => option.key), 'weather', 'time', 'exterior', 'filter']
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('室内创作包含未知或缺少必要配置，请重新读取')
  if (value.version !== 1 || value.kind !== 'interior-render') throw new Error('室内创作版本或类型不受支持')
  const { addDecor, addPeople, enclosedSpace, interiorLighting } = value
  if (typeof addDecor !== 'boolean' || typeof addPeople !== 'boolean' || typeof enclosedSpace !== 'boolean' || typeof interiorLighting !== 'boolean') throw new Error('室内创作开关必须为明确的开启或关闭状态')
  const weather = pickOption(interiorWeatherOptions, value.weather)
  const time = pickOption(interiorTimeOptions, value.time)
  const exterior = pickOption(interiorExteriorOptions, value.exterior)
  const filter = pickOption(interiorFilterOptions, value.filter)
  if (weather === undefined || time === undefined || exterior === undefined || filter === undefined) throw new Error('室内创作的天气、时间、外景或滤镜方向不受支持')
  return { version: 1, kind: 'interior-render', addDecor, addPeople, enclosedSpace, interiorLighting, weather, time, exterior, filter }
}

export function parseCanvasNodeInteriorTask(kind: string, value: unknown): CanvasInteriorTask {
  if (!sceneImageKinds.has(kind)) throw new Error('此节点不支持室内渲染任务')
  return parseCanvasInteriorTask(value)
}

/** The kernel's buildInteriorTaskPrompt: options that are off add nothing and never ask to remove what is there. */
export function buildCanvasInteriorTaskPrompt(value: CanvasInteriorTask, supplement: string): string {
  const task = parseCanvasInteriorTask(value)
  const lines = ['【室内渲染】', '第 1 张参考图是唯一室内原图。保留原图的空间结构、门窗位置、透视和主要构图，完成室内视觉渲染。']
  for (const option of interiorTaskToggleOptions) if (task[option.key]) lines.push(option.instruction)
  for (const instruction of [
    interiorWeatherOptions.find((option) => option.value === task.weather)?.instruction,
    interiorTimeOptions.find((option) => option.value === task.time)?.instruction,
    interiorExteriorOptions.find((option) => option.value === task.exterior)?.instruction,
    interiorFilterOptions.find((option) => option.value === task.filter)?.instruction,
  ]) if (instruction) lines.push(instruction)
  lines.push('以上选项通过文字指令表达，不是模型原生灯光、天气或本地像素滤镜参数。关闭或未指定的选项不要求删除原有场景内容。')
  if (supplement.trim()) lines.push('补充要求：', supplement)
  return lines.join('\n')
}

function assertInteriorTaskConfiguration(task: CanvasInteriorTask | undefined, order: CanvasImageReferenceOrder | undefined, commerceTask?: unknown): void {
  if (task === undefined) return
  parseCanvasInteriorTask(task)
  if (commerceTask !== undefined) throw new Error('室内创作与商品创作不能同时配置在同一节点')
  if (!order || order.slots.length !== 1 || order.slots[0].role !== 'source') throw new Error('室内渲染需要明确绑定唯一原图，请打开室内配置核对')
}

// ---- 室外（exterior/exterior-task.ts）----

export type CanvasExteriorTaskKind = CanvasExteriorTask['kind']
type ExteriorToggle = 'addPeople' | 'motionBlur' | 'interiorLighting'

const exteriorTaskLabels: Readonly<Record<CanvasExteriorTaskKind, string>> = { 'exterior-render': '室外一键渲染', 'exterior-redraw': '室外重绘', 'landscape-redesign': '景观改造', 'facade-renovation': '建筑立面改造', 'exterior-style-transfer': '室外风格迁移', 'storefront-redesign': '门头改造' }
const exteriorTaskToggleOptions: readonly { key: ExteriorToggle; instruction: string }[] = [
  { key: 'addPeople', instruction: '加入尺度、视角与场景用途合理的自然人物，不遮挡建筑主体。' },
  { key: 'motionBlur', instruction: '为移动的人物或车辆添加适度动态模糊，保持建筑与固定景物清晰。' },
  { key: 'interiorLighting', instruction: '在原有合理窗洞中呈现协调的室内灯光，不改变建筑开口。' },
]
const exteriorLightTemperatureOptions: readonly { value: 3000 | 4000 | 6000; instruction: string }[] = ([3000, 4000, 6000] as const).map((value) => ({ value, instruction: `人工灯光色温方向为约 ${value}K，与环境明暗协调。` }))
const exteriorWeatherOptions: readonly { value: CanvasExteriorWeather; instruction: string }[] = [
  { value: 'none', instruction: '' }, { value: 'overcast', instruction: '环境为阴天，以柔和漫射天光呈现。' }, { value: 'rainy', instruction: '环境为雨天，地面和材质适度体现湿润与反射。' }, { value: 'snowy', instruction: '环境为雪天，积雪与建筑和景观的空间关系合理。' }, { value: 'sunny', instruction: '环境为晴天，自然光照与所选时段协调。' },
]
const exteriorTimeOptions: readonly { value: CanvasExteriorTime; instruction: string }[] = [
  { value: 'none', instruction: '' }, { value: 'dawn', instruction: '以清晨的天光亮度与色彩呈现。' }, { value: 'noon', instruction: '以正午的天光亮度与光照呈现。' }, { value: 'evening', instruction: '以傍晚的天光亮度和暖色层次呈现。' }, { value: 'night', instruction: '以深夜的环境亮度与建筑照明关系呈现。' },
]
const exteriorEnvironmentOptions: readonly { value: CanvasExteriorEnvironment; instruction: string }[] = [
  { value: 'none', instruction: '' }, ...([
    ['jiangnan', '江南水乡'], ['urban', '都市城区'], ['coast', '滨海环境'], ['mountain-city', '山城环境'], ['historic-city', '历史古城'], ['european-street', '欧洲街区'], ['river-bank', '江河沿岸'], ['desert-oasis', '沙漠绿洲'], ['tropical', '热带环境'], ['mountain-retreat', '山间隐居'], ['market-street', '市井街区'], ['japanese-street', '日式街道'],
  ] as const).map(([value, label]) => ({ value, instruction: `周边环境方向为${label}，与原建筑比例、地形和相机视角协调。` })),
]
const exteriorDistantOptions: readonly { value: CanvasExteriorDistant; instruction: string }[] = [
  { value: 'none', instruction: '' }, ...([['sea', '海景'], ['river', '江景'], ['mountain', '山景'], ['forest', '森林'], ['city', '城市'], ['snow-mountain', '雪山']] as const).map(([value, label]) => ({ value, instruction: `远景方向为${label}，保持合理的景深、尺度与地平线。` })),
]
const exteriorKeys: Readonly<Record<CanvasExteriorTaskKind, readonly string[]>> = {
  'exterior-render': ['version', 'kind', 'addPeople', 'motionBlur', 'interiorLighting', 'lightTemperature', 'weather', 'time', 'environment', 'distant'],
  'exterior-redraw': ['version', 'kind', 'useToneReference'],
  'landscape-redesign': ['version', 'kind', 'automaticPrompt'],
  'facade-renovation': ['version', 'kind', 'automaticPrompt'],
  'exterior-style-transfer': ['version', 'kind', 'automaticPrompt'],
  'storefront-redesign': ['version', 'kind', 'automaticPrompt'],
}

function exteriorTaskKind(value: unknown): value is CanvasExteriorTaskKind {
  return typeof value === 'string' && Object.hasOwn(exteriorTaskLabels, value)
}

/** The kernel's parseExteriorTask, word for word. */
export function parseCanvasExteriorTask(value: unknown): CanvasExteriorTask {
  if (!isRecord(value)) throw new Error('室外创作配置格式不正确')
  if (value.version !== 1 || !exteriorTaskKind(value.kind)) throw new Error('室外创作版本或类型不受支持')
  const kind = value.kind
  const keys = exteriorKeys[kind]
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('室外创作含未知或缺少必要配置')
  if (kind === 'exterior-render') {
    const { addPeople, motionBlur, interiorLighting } = value
    const lightTemperature = pickOption(exteriorLightTemperatureOptions, value.lightTemperature)
    const weather = pickOption(exteriorWeatherOptions, value.weather)
    const time = pickOption(exteriorTimeOptions, value.time)
    const environment = pickOption(exteriorEnvironmentOptions, value.environment)
    const distant = pickOption(exteriorDistantOptions, value.distant)
    if (typeof addPeople !== 'boolean' || typeof motionBlur !== 'boolean' || typeof interiorLighting !== 'boolean' || lightTemperature === undefined
      || weather === undefined || time === undefined || environment === undefined || distant === undefined) throw new Error('室外渲染开关、色温或环境参数不受支持')
    return { version: 1, kind, addPeople, motionBlur, interiorLighting, lightTemperature, weather, time, environment, distant }
  }
  if (kind === 'exterior-redraw') {
    if (typeof value.useToneReference !== 'boolean') throw new Error('色调参考开关必须为明确的开启或关闭')
    return { version: 1, kind, useToneReference: value.useToneReference }
  }
  if (typeof value.automaticPrompt !== 'boolean') throw new Error('自动提示开关必须为明确的开启或关闭')
  return { version: 1, kind, automaticPrompt: value.automaticPrompt }
}

export function parseCanvasNodeExteriorTask(kind: string, value: unknown): CanvasExteriorTask {
  if (!sceneImageKinds.has(kind)) throw new Error('此节点不支持室外创作任务')
  return parseCanvasExteriorTask(value)
}

export function canvasExteriorTaskRoles(value: CanvasExteriorTask): readonly ('source' | 'reference')[] {
  const task = parseCanvasExteriorTask(value)
  return task.kind === 'exterior-render' || task.kind === 'exterior-redraw' && !task.useToneReference ? ['source'] : ['source', 'reference']
}

export function canvasExteriorTaskUsesAnalysis(value: CanvasExteriorTask): boolean {
  const task = parseCanvasExteriorTask(value)
  return 'automaticPrompt' in task && task.automaticPrompt
}

/** The kernel's buildExteriorTaskPrompt. */
export function buildCanvasExteriorTaskPrompt(value: CanvasExteriorTask, supplement: string): string {
  const task = parseCanvasExteriorTask(value)
  const lines = [`【${exteriorTaskLabels[task.kind]}】`, '第 1 张参考图是唯一原始建筑或场地主体。以原图为主体，优先保持建筑身份、结构、体量、相机位置、透视和主要构图。']
  if (task.kind === 'exterior-render') {
    for (const option of exteriorTaskToggleOptions) if (task[option.key]) lines.push(option.instruction)
    if (task.interiorLighting) lines.push(exteriorLightTemperatureOptions.find(({ value }) => value === task.lightTemperature)?.instruction ?? '')
    for (const instruction of [
      exteriorWeatherOptions.find(({ value }) => value === task.weather)?.instruction,
      exteriorTimeOptions.find(({ value }) => value === task.time)?.instruction,
      exteriorEnvironmentOptions.find(({ value }) => value === task.environment)?.instruction,
      exteriorDistantOptions.find(({ value }) => value === task.distant)?.instruction,
    ]) if (instruction) lines.push(instruction)
    lines.push('以上环境与色温通过文字指令表达，不是模型原生物理参数。关闭或未指定的选项不要求删除原有内容。')
  } else if (task.kind === 'exterior-redraw') {
    lines.push('改善室外建筑与场地的材质、细节、光影和整体表现，不把重绘解释为尺寸放大或原生降噪参数。')
    if (task.useToneReference) lines.push('第 2 张参考图仅提供色调与光影方向，不替换第 1 张图的建筑与场地。')
  } else {
    const directions = { 'landscape-redesign': '以第 2 张图为景观材质、植被与空间氛围参考，改造第 1 张场地的景观。', 'facade-renovation': '以第 2 张图为立面语言与材料参考，改造第 1 张建筑立面，保留主体结构与必要开口。', 'exterior-style-transfer': '将第 2 张图的视觉风格、材质和光影应用于第 1 张图，保留原建筑身份与透视。', 'storefront-redesign': '以第 2 张图为门头设计与材质参考，改造第 1 张店铺门头，保留店铺开口、尺度和结构。' }
    lines.push(directions[task.kind], '第 2 张图只提供明确的风格或设计参考，不替换第 1 张图的主体。')
  }
  if (supplement.trim()) lines.push('补充要求：', supplement)
  return lines.join('\n')
}

/** The kernel's buildExteriorAnalysisPrompt: the exact prompt the analysis text node must carry. */
export function buildCanvasExteriorAnalysisPrompt(value: CanvasExteriorTask): string {
  const task = parseCanvasExteriorTask(value)
  if (!canvasExteriorTaskUsesAnalysis(task)) throw new Error('此室外任务没有启用自动提示')
  return `分析两张已明确排序的参考图，为「${exteriorTaskLabels[task.kind]}」编写具体、可执行的中文图像编辑要求。第1张是必须保留建筑身份、结构与视角的原始主体；第2张只提供该任务的设计、材质、色调或风格参考。比较可见差异，避免编造不可见结构，不复制参考图的建筑身份。只返回创作要求，不发起图像生成。`
}

function assertExteriorTaskConfiguration(task: CanvasExteriorTask | undefined, order: CanvasImageReferenceOrder | undefined, commerceTask?: unknown, interiorTask?: unknown): void {
  if (task === undefined) return
  const value = parseCanvasExteriorTask(task)
  if (commerceTask !== undefined || interiorTask !== undefined) throw new Error('室外、室内与商品创作不能同时配置在同一节点')
  const roles = canvasExteriorTaskRoles(value)
  if (!order || order.slots.length !== roles.length || order.slots.some((slot, index) => slot.role !== roles[index])) throw new Error('室外任务需要明确绑定对应的原图和参考图角色')
}

// ---- 故事板（storyboard/storyboard-task.ts）----

const storyboardStyleOptions: readonly { value: CanvasStoryboardTask['style']; label: string; instruction: string }[] = [
  { value: 'white-model', label: '白膜', instruction: '以简洁白膜造型、清晰空间与光影表达镜头。' },
  { value: 'hand-drawn', label: '手绘', instruction: '以手绘线稿和明确的动作、构图表达镜头。' },
  { value: 'cinematic', label: '分镜', instruction: '以电影分镜的景别、视角和镜头调度表达叙事。' },
  { value: 'stick-figure', label: '火柴人', instruction: '以火柴人和简洁场景线条表达角色动作与镜头。' },
]
const storyboardPanelOptions: readonly { value: CanvasStoryboardTask['panels'] }[] = [{ value: 4 }, { value: 9 }, { value: 16 }, { value: 25 }]

/** The kernel's parseStoryboardTask, word for word. */
export function parseCanvasStoryboardTask(value: unknown): CanvasStoryboardTask {
  if (!isRecord(value)) throw new Error('故事板配置格式不正确')
  const keys = ['version', 'kind', 'automaticPlot', 'style', 'panels']
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('故事板含未知或缺少必要配置')
  if (value.version !== 1 || value.kind !== 'storyboard') throw new Error('故事板版本或类型不受支持')
  const style = pickOption(storyboardStyleOptions, value.style)
  const panels = pickOption(storyboardPanelOptions, value.panels)
  if (typeof value.automaticPlot !== 'boolean' || style === undefined || panels === undefined) throw new Error('故事板剧情开关、画风或宫格数不受支持')
  return { version: 1, kind: 'storyboard', automaticPlot: value.automaticPlot, style, panels }
}

export function parseCanvasNodeStoryboardTask(kind: string, value: unknown): CanvasStoryboardTask {
  if (!sceneImageKinds.has(kind)) throw new Error('此节点不支持故事板任务')
  return parseCanvasStoryboardTask(value)
}

export function canvasStoryboardTaskRoles(value: CanvasStoryboardTask, count = 1): readonly ('source' | 'reference')[] {
  parseCanvasStoryboardTask(value)
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('故事板需要 1–4 张有序输入图片')
  return Array.from({ length: count }, (_, index) => index === 0 ? 'source' : 'reference')
}

/** The kernel's buildStoryboardTaskPrompt. */
export function buildCanvasStoryboardTaskPrompt(value: CanvasStoryboardTask, supplement: string): string {
  const task = parseCanvasStoryboardTask(value)
  const side = Math.sqrt(task.panels)
  return ['【故事板】', '参考图片按输入编号排序：第 1 张提供主要主体与场景，其余图片按顺序提供角色、场景或叙事参考；保持主体身份与可见特征连贯。', `生成一张完整的 ${side}×${side} 故事板整图，共 ${task.panels} 个分镜面板；从左到右、从上到下连续叙事。宫格数量不是生成图片数量。`, storyboardStyleOptions.find(({ value }) => value === task.style)?.instruction ?? '', '在各面板间保持人物、物品和空间关系一致，镜头变化服务剧情。画风与宫格通过文字要求表达，不是模型原生参数。', ...(supplement.trim() ? ['剧情与补充要求：', supplement] : [])].join('\n')
}

/** The kernel's buildStoryboardAnalysisPrompt: the exact prompt the plot text node must carry. */
export function buildCanvasStoryboardAnalysisPrompt(value: CanvasStoryboardTask, supplement = ''): string {
  const task = parseCanvasStoryboardTask(value)
  if (!task.automaticPlot) throw new Error('此故事板未启用自动剧情')
  return ['分析所有按输入编号排序的参考图片。第 1 张提供主要主体与场景，其余图片按顺序作为角色、场景或叙事参考。依据可见内容编写连贯、具体的中文故事板剧情，保持主体身份，不把无法观察到的细节当成事实。', `为 ${task.panels} 个连续分镜面板安排动作、景别与镜头衔接，画风为${storyboardStyleOptions.find(({ value }) => value === task.style)?.label ?? ''}。只返回剧情与镜头要求，不发起图像生成。`, ...(supplement.trim() ? ['用户剧情与补充要求：', supplement] : [])].join('\n')
}

function assertStoryboardTaskConfiguration(task: CanvasStoryboardTask | undefined, order: CanvasImageReferenceOrder | undefined, commerceTask?: unknown, interiorTask?: unknown, exteriorTask?: unknown): void {
  if (task === undefined) return
  const value = parseCanvasStoryboardTask(task)
  if (commerceTask !== undefined || interiorTask !== undefined || exteriorTask !== undefined) throw new Error('故事板与商品、室内、室外创作不能同时配置在同一节点')
  const roles = canvasStoryboardTaskRoles(value, order?.slots.length ?? 0)
  if (!order || order.slots.some((slot, index) => slot.role !== roles[index])) throw new Error('故事板需要按顺序明确绑定主体图和参考图')
}

// ---- 运行前核对（commerce/image-task-configuration.ts 和两个分析核对）----

/** The kernel's assertCommerceTaskConfiguration: one task at most, with the picture roles it needs. */
export function assertCanvasSceneTaskConfiguration(data: Pick<CanvasRunGraphNode['data'], 'commerceTask' | 'interiorTask' | 'exteriorTask' | 'storyboardTask' | 'imageReferenceOrder' | 'size' | 'imageResolution'>): void {
  const task = data.commerceTask
  const order = data.imageReferenceOrder
  assertInteriorTaskConfiguration(data.interiorTask, order, task)
  assertExteriorTaskConfiguration(data.exteriorTask, order, task, data.interiorTask)
  assertStoryboardTaskConfiguration(data.storyboardTask, order, task, data.interiorTask, data.exteriorTask)
  if (!task) return
  if (!order) throw new Error('创作任务需要明确原图和参考图角色，请打开创作配置重新绑定')
  const expected = task.kind === 'style-reference' ? 2 : 1
  if (order.slots.length !== expected) throw new Error(task.kind === 'style-reference' ? '参考风格迁移需要唯一原图和一张参考图' : '此创作任务只接受唯一原图')
  if (task.kind === 'material-b' && (data.size !== 'auto' || data.imageResolution !== undefined && data.imageResolution !== '1K')) throw new Error('材质优化 B 的尺寸由原图和倍率唯一决定，请保留自动尺寸与 1K 清晰度')
}

type RunNode = CanvasRunGraphNode
type RunEdges = CanvasRunGraph['edges']

// Both analysis checks name each slot by [role, source node, port, position]:
// the text node and the picture node must look at the same pictures in the
// same order, or the written prompt describes other pictures.
function analysisIdentities(target: RunNode, edges: RunEdges, slotsValid: (slots: CanvasImageReferenceOrder['slots']) => boolean, unbound: string, lost: string): string {
  const slots = target.data.imageReferenceOrder?.slots
  if (!slots || !slotsValid(slots)) throw new Error(unbound)
  return JSON.stringify(slots.map((slot) => {
    const edge = 'edgeId' in slot ? edges.find((candidate) => candidate.id === slot.edgeId && candidate.target === target.id && candidate.targetHandle === 'in:images') : undefined
    if (!edge || (edge.sourceHandle !== 'out:image' && edge.sourceHandle !== 'out:images') || !('outputIndex' in slot)) throw new Error(lost)
    return [slot.role, edge.source, edge.sourceHandle, slot.outputIndex]
  }))
}

// The kernel also refuses an analysis node with web search on; the desktop
// parser never keeps that setting (the node is refused by name instead).
function analysisNode(node: RunNode, edges: RunEdges, nodes: ReadonlyMap<string, RunNode>, expectedPrompt: string, message: string): RunNode {
  const text = edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:text')
  const analysis = text.length === 1 ? nodes.get(text[0].source) : undefined
  if (!analysis || text[0].sourceHandle !== 'out:text' || analysis.kind !== 'text-generate' || analysis.disabled || analysis.data.prompt !== expectedPrompt) throw new Error(message)
  return analysis
}

/** The kernel's assertExteriorAnalysisConfiguration: automatic prompting must come from a visible text node over the same two pictures. */
export function assertCanvasExteriorAnalysisConfiguration(node: RunNode, edges: RunEdges, nodes: ReadonlyMap<string, RunNode>): void {
  const task = node.data.exteriorTask
  if (!task || !canvasExteriorTaskUsesAnalysis(task)) return
  const analysis = analysisNode(node, edges, nodes, buildCanvasExteriorAnalysisPrompt(task), '自动提示需要唯一、可用的显式图片分析节点，请重新配置室外任务')
  assertCanvasTextImageInput(analysis.data.model, 2)
  const allowed = new Set(analysis.data.imageReferenceOrder?.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []) ?? [])
  if (edges.some((edge) => edge.target === analysis.id && (edge.targetHandle !== 'in:images' || !allowed.has(edge.id)))) throw new Error('自动提示分析存在未分配的图片或额外文字输入，请重新配置')
  function identities(target: RunNode): string {
    return analysisIdentities(target, edges, (slots) => slots.length === 2 && slots.every((slot, index) => slot.role === (index === 0 ? 'source' : 'reference')), '自动提示图片角色尚未绑定，请重新配置', '自动提示原图或参考图已失联')
  }
  if (identities(node) !== identities(analysis)) throw new Error('自动提示仍绑定另一组图片，请重新配置；不会使用旧图分析')
}

/** The kernel's assertStoryboardAnalysisConfiguration: the plot node must see the exact ordered pictures. */
export function assertCanvasStoryboardAnalysisConfiguration(node: RunNode, edges: RunEdges, nodes: ReadonlyMap<string, RunNode>): void {
  const task = node.data.storyboardTask
  if (!task || !task.automaticPlot) return
  const analysis = analysisNode(node, edges, nodes, buildCanvasStoryboardAnalysisPrompt(task, node.data.prompt), '自动剧情需要唯一、可用且与当前剧情一致的显式图片分析节点，请重新配置故事板')
  const count = node.data.imageReferenceOrder?.slots.length ?? 0
  assertCanvasTextImageInput(analysis.data.model, count)
  const allowed = new Set(analysis.data.imageReferenceOrder?.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []) ?? [])
  if (edges.some((edge) => edge.target === analysis.id && (edge.targetHandle !== 'in:images' || !allowed.has(edge.id)))) throw new Error('自动剧情分析存在未分配的图片或额外文字输入，请重新配置')
  function identities(target: RunNode, storyboard: CanvasStoryboardTask): string {
    // Worked out before the slots are looked at, as in the kernel: no pictures at all is「1–4 张」first.
    const roles = canvasStoryboardTaskRoles(storyboard, count)
    return analysisIdentities(target, edges, (slots) => slots.length === count && slots.every((slot, index) => slot.role === roles[index]),
      '自动剧情图片顺序尚未绑定，请重新配置', '自动剧情输入图片已失联')
  }
  if (identities(node, task) !== identities(analysis, task)) throw new Error('自动剧情仍绑定另一组图片或顺序，请重新配置；不会使用旧图分析')
}

/**
 * The task half of the kernel's assertImageReferenceRunConfiguration, run
 * before a single paid request; assertCanvasImageReferenceRunConfiguration is
 * the order half and runs after it, as in the kernel.
 */
export function assertCanvasSceneRunConfiguration(node: RunNode, edges: RunEdges, nodes: ReadonlyMap<string, RunNode>): void {
  assertCanvasSceneTaskConfiguration(node.data)
  assertCanvasExteriorAnalysisConfiguration(node, edges, nodes)
  assertCanvasStoryboardAnalysisConfiguration(node, edges, nodes)
}

/** Whether the node carries any scene task: its prompt is then written here, and a missing typed prompt is fine. */
export function canvasNodeHasSceneTask(node: RunNode): boolean {
  return node.data.commerceTask !== undefined || node.data.interiorTask !== undefined || node.data.exteriorTask !== undefined || node.data.storyboardTask !== undefined
}

/**
 * The prompt the web host sends for a picture node: a task writes it around
 * the user's words; a bare picture order names each picture's role first.
 * Exterior and storyboard nodes without automatic writing need the user's
 * own words, as on the web host.
 */
export function buildCanvasSceneImagePrompt(node: RunNode, typed: string, rolePrompt: (prompt: string) => string): string {
  const { storyboardTask, exteriorTask, interiorTask, commerceTask } = node.data
  if (storyboardTask) {
    const task = parseCanvasStoryboardTask(storyboardTask)
    if (!task.automaticPlot && !typed.trim()) throw new Error('关闭自动剧情后，请填写明确的故事剧情')
    return buildCanvasStoryboardTaskPrompt(task, typed)
  }
  if (exteriorTask) {
    if ('automaticPrompt' in exteriorTask && !exteriorTask.automaticPrompt && !typed.trim()) throw new Error('关闭自动提示后，请填写明确的室外创作要求')
    return buildCanvasExteriorTaskPrompt(exteriorTask, typed)
  }
  if (interiorTask) return buildCanvasInteriorTaskPrompt(interiorTask, typed)
  if (commerceTask) return buildCanvasCommerceTaskPrompt(commerceTask, typed)
  return rolePrompt(typed)
}

// ---- 桌面自己的两道核对 ----

export type CanvasSceneSourceCheck = 'exterior' | 'storyboard'

/**
 * Which pictures must be told apart by their bytes before this node's paid
 * request, as on the web host: an exterior task over two pictures, a
 * storyboard, and the text node that writes the prompt for either. The same
 * picture under two asset ids would otherwise pass every id check.
 */
export function canvasSceneSourceChecks(node: RunNode, edges: RunEdges, nodes: ReadonlyMap<string, RunNode>): CanvasSceneSourceCheck[] {
  const feeds = node.kind === 'text-generate'
    ? edges.filter((edge) => edge.source === node.id && edge.sourceHandle === 'out:text').flatMap((edge) => {
      const target = nodes.get(edge.target)
      return target ? [target] : []
    })
    : []
  const checks: CanvasSceneSourceCheck[] = []
  const exterior = node.data.exteriorTask
  if (feeds.some((target) => target.data.exteriorTask !== undefined && canvasExteriorTaskUsesAnalysis(target.data.exteriorTask))
    || exterior !== undefined && canvasExteriorTaskRoles(exterior).length === 2) checks.push('exterior')
  if (feeds.some((target) => target.data.storyboardTask?.automaticPlot === true) || node.data.storyboardTask !== undefined) checks.push('storyboard')
  return checks
}

const maximumSceneSourceBytes = 24 * 1024 * 1024

/**
 * The web host's validateExteriorSourceImages and validateStoryboardSourceImages:
 * the account's own bytes, compared before anything is paid for. No model,
 * key or network is involved.
 */
export async function assertCanvasSceneSourceImages(
  checks: readonly CanvasSceneSourceCheck[],
  assetIds: readonly string[],
  read: ((assetId: string) => Promise<Buffer>) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (checks.length === 0) return
  if (!read) throw new Error(checks.includes('exterior') ? '室外参考图内容核对服务暂时不可用，当前没有提交生成请求' : '故事板输入图片内容核对服务暂时不可用，当前没有提交生成请求')
  for (const check of checks) {
    if (check === 'exterior' && (assetIds.length !== 2 || new Set(assetIds).size !== 2)) throw new Error('室外双图任务需要两张内容不同的原图和参考图')
    if (check === 'storyboard' && (!assetIds.length || assetIds.length > 4 || new Set(assetIds).size !== assetIds.length)) throw new Error('故事板需要 1–4 张内容不同的有序图片')
  }
  const bytes: Buffer[] = []
  for (const assetId of assetIds) {
    signal?.throwIfAborted()
    bytes.push(await read(assetId))
  }
  signal?.throwIfAborted()
  const total = bytes.reduce((sum, value) => sum + value.byteLength, 0)
  for (const check of checks) {
    if (total > maximumSceneSourceBytes) throw new Error(check === 'exterior' ? '室外参考图片总容量不能超过 24 MB，当前没有提交生成请求' : '故事板输入图片总容量不能超过 24 MB，当前没有提交生成请求')
    for (let index = 0; index < bytes.length; index += 1) {
      for (let previous = 0; previous < index; previous += 1) {
        if (bytes[index].equals(bytes[previous])) throw new Error(check === 'exterior' ? '原图与参考图内容相同，请选择内容不同的两张图片；当前没有提交生成请求' : '故事板输入图片内容相同，请选择内容不同的图片；当前没有提交生成请求')
      }
    }
  }
}

function sizeRule(model: string): string {
  const capability = resolveAiModelCapability(model)
  if (capability.kind !== 'image') return '这个型号不能出图'
  const policy = capability.sizePolicy
  if (policy.kind === 'divisible') return `这个型号的宽和高都要是 ${policy.divisor} 的倍数，并在 ${policy.min} 到 ${policy.max} 之间`
  return policy.values.length === 1 && policy.values[0] === 'auto' ? '这个型号由服务决定尺寸，不能指定' : `这个型号只支持这几种尺寸：${policy.values.join('、')}`
}

/**
 * Material B on the desktop: the kernel worked the size out from the
 * picture and checked it against its own model table; the request goes out
 * only if the desktop's own size rules (ai-chat-protocol.ts) send exactly that
 * size, so a size the relay would round or ignore fails before it is paid for.
 */
export function assertCanvasCommerceTargetSizeSupported(model: string, target: CanvasCommerceImageSize): void {
  const unavailable = `当前模型无法精确输出派生尺寸 ${target.size}；请更换原图、请求倍率或模型`
  let body: ReturnType<typeof buildImageGenerationRequest>
  try {
    body = buildImageGenerationRequest({ model, prompt: '尺寸核对', size: target.size, imageResolution: '1K' })
  } catch {
    throw new Error(`${unavailable}。${sizeRule(model)}`)
  }
  if (!('size' in body) || body.size !== target.size) throw new Error(`${unavailable}。${sizeRule(model)}`)
}
